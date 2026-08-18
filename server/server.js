/*
 * server.js — Life Events backend.
 *
 * Serves the web app, keeps the canonical records, and talks to Instagram.
 * Zero dependencies: node:http plus the global fetch in Node 18+.
 *
 *   node server/server.js
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./lib/config');
const store = require('./lib/store');
const instagram = require('./lib/instagram');
const sync = require('./lib/sync');

const WEB_ROOT = path.join(__dirname, '..');
const MAX_BODY = 25 * 1024 * 1024; // generous enough for a batch of photos

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8'
};

// Short-lived CSRF states for the OAuth round trip.
const authStates = new Map();

/* -------------------------------------------------------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err instanceof instagram.InstagramError ? 502 : 500;
  console.error(`[error] ${err.message}`);
  sendJson(res, err.status && err.status < 600 ? 400 : status, {
    error: err.message,
    hint: err.hint || null
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new Error('Request body was not valid JSON.');
  }
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(WEB_ROOT, relative);

  // Never serve anything outside the app directory, or the server's own data.
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(WEB_ROOT)) || resolved.startsWith(path.resolve(config.dataDir))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (/^server[\\/]/.test(relative)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ routes  */

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  /* -- status ------------------------------------------------------------- */
  if (pathname === '/api/status' && method === 'GET') {
    const ig = store.getInstagram();
    return sendJson(res, 200, {
      backend: true,
      instagram: {
        connected: ig.connected,
        username: ig.username,
        tokenExpiresAt: ig.tokenExpiresAt,
        lastInboundSync: ig.lastInboundSync
      },
      queueSize: sync.pendingQueue().length,
      configProblems: config.problems(),
      pollMinutes: config.inboundPollMinutes
    });
  }

  /* -- records ------------------------------------------------------------ */
  if (pathname === '/api/records' && method === 'GET') {
    return sendJson(res, 200, store.getRecords());
  }

  if (pathname === '/api/records' && method === 'PUT') {
    const body = await readJsonBody(req);
    return sendJson(res, 200, store.saveRecords(body));
  }

  /* -- photos ------------------------------------------------------------- */
  if (pathname === '/api/photos' && method === 'POST') {
    const body = await readJsonBody(req);
    const saved = [];
    for (const photo of body.photos || []) {
      const base64 = String(photo.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
      if (!base64) continue;
      saved.push(store.putPhoto(Buffer.from(base64, 'base64'), photo.id));
    }
    return sendJson(res, 200, { saved });
  }

  if (pathname === '/api/photos' && method === 'GET') {
    // Returns photos as data URLs so the browser can render them offline.
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
    const photos = {};
    for (const id of ids) {
      const buffer = store.readPhoto(id);
      if (buffer) photos[id] = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    }
    return sendJson(res, 200, { photos });
  }

  /* -- instagram auth ----------------------------------------------------- */
  if (pathname === '/api/instagram/connect' && method === 'GET') {
    const problems = config.problems();
    if (problems.length) return sendJson(res, 400, { error: problems.join(' ') });

    const state = crypto.randomBytes(16).toString('hex');
    authStates.set(state, Date.now() + 10 * 60_000);
    return sendJson(res, 200, { url: instagram.authorizeUrl(state) });
  }

  if (pathname === config.instagram.redirectPath && method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const denied = url.searchParams.get('error');

    const finish = (message) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!DOCTYPE html><meta charset="utf-8"><title>Instagram</title>` +
          `<body style="font:16px system-ui;padding:40px;max-width:36em;margin:auto">` +
          `<p>${message}</p><p><a href="/">Back to Life Events</a></p></body>`
      );
    };

    if (denied) return finish(`Instagram declined the connection: ${denied}.`);
    if (!state || !authStates.has(state) || authStates.get(state) < Date.now()) {
      return finish('That sign-in link expired or did not match. Please try connecting again.');
    }
    authStates.delete(state);

    try {
      const saved = await instagram.completeAuth(code);
      return finish(`Connected to <strong>@${saved.username || 'your account'}</strong>. You can close this tab.`);
    } catch (err) {
      return finish(`Could not complete the connection: ${err.message}${err.hint ? ` — ${err.hint}` : ''}`);
    }
  }

  if (pathname === '/api/instagram/disconnect' && method === 'POST') {
    return sendJson(res, 200, store.clearInstagram());
  }

  /* -- publishing --------------------------------------------------------- */
  if (pathname === '/api/instagram/queue' && method === 'GET') {
    return sendJson(res, 200, { queue: sync.pendingQueue() });
  }

  if (pathname === '/api/instagram/publish' && method === 'POST') {
    const body = await readJsonBody(req);
    const event = store.getEvent(body.eventId);
    if (!event) return sendJson(res, 404, { error: 'That event no longer exists.' });

    try {
      const result = await instagram.publishEvent(event, {
        caption: body.caption ?? event.instagram?.caption ?? event.description ?? event.title,
        photoIds: event.photoIds || []
      });

      const updated = store.upsertEvent({
        ...event,
        instagram: {
          ...(event.instagram || {}),
          mediaId: result.id,
          permalink: result.permalink,
          status: 'published',
          source: event.instagram?.source || 'life-events',
          error: null,
          syncedAt: new Date().toISOString()
        }
      });
      return sendJson(res, 200, { event: updated });
    } catch (err) {
      // Record the failure on the event so it shows in the queue.
      store.upsertEvent({
        ...event,
        instagram: {
          ...(event.instagram || {}),
          status: 'failed',
          error: `${err.message}${err.hint ? ` — ${err.hint}` : ''}`
        }
      });
      return sendError(res, err);
    }
  }

  /* -- inbound sync ------------------------------------------------------- */
  if (pathname === '/api/instagram/pull' && method === 'POST') {
    const summary = await sync.pullFromInstagram({ limit: 25 });
    return sendJson(res, 200, summary);
  }

  return sendJson(res, 404, { error: 'Unknown endpoint.' });
}

/* -------------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    // Public media: the only unauthenticated data path, open only while a
    // publish is in flight so photos are not permanently exposed.
    const media = /^\/media\/([\w-]+)\.jpg$/.exec(url.pathname);
    if (media) {
      const id = media[1];
      if (!store.isPhotoExposed(id) || !store.hasPhoto(id)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
        return;
      }
      const buffer = store.readPhoto(id);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buffer.length });
      res.end(buffer);
      return;
    }

    if (url.pathname.startsWith('/api/') || url.pathname === config.instagram.redirectPath) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url.pathname);
  } catch (err) {
    sendError(res, err);
  }
});

/* Periodic inbound polling — Instagram has no push for your own new posts. */
let pollTimer = null;
function startPolling() {
  if (!config.inboundPollMinutes) return;
  pollTimer = setInterval(async () => {
    if (!store.getInstagram().connected) return;
    try {
      const summary = await sync.pullFromInstagram({ limit: 25 });
      if (summary.imported || summary.updated) {
        console.log(`[sync] imported ${summary.imported}, updated ${summary.updated}`);
      }
    } catch (err) {
      console.error(`[sync] ${err.message}`);
    }
  }, config.inboundPollMinutes * 60_000);
  pollTimer.unref?.();
}

if (require.main === module) {
  server.listen(config.port, () => {
    console.log(`Life Events running at http://localhost:${config.port}`);
    const problems = config.problems();
    if (problems.length) {
      console.log('\nInstagram features are disabled until these are set:');
      for (const problem of problems) console.log(`  • ${problem}`);
      console.log('See server/SETUP-INSTAGRAM.md\n');
    } else {
      console.log(`Instagram callback: ${config.redirectUri}`);
    }
    startPolling();
  });
}

module.exports = { server, startPolling };
