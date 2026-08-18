/*
 * instagram.js — Instagram Graph API client (Instagram API with Instagram Login).
 *
 * Flow, per Meta's content-publishing docs:
 *   1. Send the user to instagram.com/oauth/authorize
 *   2. Exchange the returned code for a short-lived token
 *   3. Exchange that for a 60-day long-lived token, refreshed before expiry
 *   4. To post: create a media container pointing at a PUBLIC https JPEG URL,
 *      then publish the container. Meta fetches the image itself — there is no
 *      binary upload path for photos.
 *
 * Every host is taken from config so the test suite can run this entire file
 * against a local mock of the Graph API.
 */
'use strict';

const config = require('./config');
const store = require('./store');

const ig = config.instagram;

class InstagramError extends Error {
  constructor(message, { status, body, hint } = {}) {
    super(message);
    this.name = 'InstagramError';
    this.status = status;
    this.body = body;
    this.hint = hint;
  }
}

/** Turns Meta's error envelope into something a human can act on. */
function describeError(status, body) {
  const error = (body && body.error) || {};
  const code = error.code;
  const message = error.message || `Instagram returned HTTP ${status}`;

  let hint;
  if (code === 190) hint = 'The access token expired or was revoked. Reconnect Instagram.';
  else if (code === 4 || code === 17 || code === 32) hint = 'Rate limit reached. Instagram allows about 25 API posts per 24 hours.';
  else if (code === 9007 || /media.*download|fetch/i.test(message)) {
    hint = 'Instagram could not download the image. PUBLIC_URL must be a public https address that Meta can reach.';
  } else if (code === 10 || code === 200) {
    hint = 'The app is missing a permission. instagram_business_content_publish requires App Review approval.';
  } else if (code === 100 && /aspect ratio|dimension|size/i.test(message)) {
    hint = 'Instagram rejected the image dimensions. It requires JPEG between 4:5 and 1.91:1 aspect ratio.';
  }

  return new InstagramError(message, { status, body, hint });
}

async function request(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    throw new InstagramError(`Could not reach Instagram: ${err.message}`, {
      hint: 'Check this server has outbound internet access.'
    });
  }

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    body = { raw: text };
  }

  if (!response.ok) throw describeError(response.status, body);
  return body;
}

function graphUrl(pathname, params = {}) {
  const url = new URL(`${ig.graphHost}/${ig.apiVersion}${pathname}`);
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) url.searchParams.set(key, String(val));
  }
  return url.toString();
}

const instagram = {
  InstagramError,

  /* ------------------------------------------------------------------- auth */

  authorizeUrl(state) {
    const url = new URL(`${ig.authHost}/oauth/authorize`);
    url.searchParams.set('client_id', ig.appId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('scope', ig.scopes);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    return url.toString();
  },

  /** Exchanges an OAuth code for a long-lived token and stores it. */
  async completeAuth(code) {
    const form = new URLSearchParams({
      client_id: ig.appId,
      client_secret: ig.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code
    });

    const short = await request(`${ig.tokenHost}/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });

    const shortToken = short.access_token;
    const userId = short.user_id || (short.permissions && short.permissions.user_id);
    if (!shortToken) throw new InstagramError('Instagram did not return an access token.');

    // Short-lived tokens last an hour; trade up for the 60-day one.
    const long = await request(
      `${ig.graphHost}/access_token?${new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: ig.appSecret,
        access_token: shortToken
      })}`
    );

    const accessToken = long.access_token || shortToken;
    const expiresIn = Number(long.expires_in || 3600);

    const profile = await request(
      graphUrl('/me', { fields: 'user_id,username', access_token: accessToken })
    );

    return store.saveInstagram({
      connected: true,
      userId: String(profile.user_id || userId || ''),
      username: profile.username || null,
      accessToken,
      tokenExpiresAt: Date.now() + expiresIn * 1000
    });
  },

  /** Refreshes the long-lived token when it is within a week of expiring. */
  async ensureFreshToken() {
    const state = store.getInstagram();
    if (!state.connected || !state.accessToken) {
      throw new InstagramError('Instagram is not connected.', {
        hint: 'Open the Instagram tab and connect the account.'
      });
    }

    const weekMs = 7 * 24 * 60 * 60 * 1000;
    if (state.tokenExpiresAt && state.tokenExpiresAt - Date.now() > weekMs) {
      return state.accessToken;
    }

    const refreshed = await request(
      `${ig.graphHost}/refresh_access_token?${new URLSearchParams({
        grant_type: 'ig_refresh_token',
        access_token: state.accessToken
      })}`
    );

    const accessToken = refreshed.access_token || state.accessToken;
    store.saveInstagram({
      accessToken,
      tokenExpiresAt: Date.now() + Number(refreshed.expires_in || 5_184_000) * 1000
    });
    return accessToken;
  },

  /* ---------------------------------------------------------------- publish */

  /**
   * Publishes one event. Photos are exposed at a public URL only for the
   * duration of the call, then closed again.
   * @returns {{id: string, permalink: string|null}}
   */
  async publishEvent(event, { caption, photoIds }) {
    const token = await instagram.ensureFreshToken();
    const state = store.getInstagram();
    const usable = (photoIds || []).filter((id) => store.hasPhoto(id));

    if (!usable.length) {
      throw new InstagramError('This event has no photo.', {
        hint: 'Instagram posts require at least one image.'
      });
    }
    if (usable.length > 10) {
      throw new InstagramError('Instagram carousels hold at most 10 images.');
    }

    const exposed = usable.map((id) => ({ id, url: store.exposePhoto(id) }));

    try {
      let containerId;

      if (exposed.length === 1) {
        const created = await request(graphUrl(`/${state.userId}/media`), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            image_url: exposed[0].url,
            caption: caption || '',
            access_token: token
          }).toString()
        });
        containerId = created.id;
      } else {
        // Carousel: one child container per image, then a parent that ties them together.
        const children = [];
        for (const item of exposed) {
          const child = await request(graphUrl(`/${state.userId}/media`), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              image_url: item.url,
              is_carousel_item: 'true',
              access_token: token
            }).toString()
          });
          children.push(child.id);
        }

        const parent = await request(graphUrl(`/${state.userId}/media`), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            media_type: 'CAROUSEL',
            children: children.join(','),
            caption: caption || '',
            access_token: token
          }).toString()
        });
        containerId = parent.id;
      }

      await instagram.waitForContainer(containerId, token);

      const published = await request(graphUrl(`/${state.userId}/media_publish`), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ creation_id: containerId, access_token: token }).toString()
      });

      let permalink = null;
      try {
        const detail = await request(
          graphUrl(`/${published.id}`, { fields: 'permalink', access_token: token })
        );
        permalink = detail.permalink || null;
      } catch (err) {
        // The post succeeded; a missing permalink is not worth failing over.
      }

      store.markMediaImported(published.id); // don't re-import our own post
      return { id: published.id, permalink };
    } finally {
      // Close the public window whether or not publishing worked.
      for (const item of exposed) store.revokePhoto(item.id);
    }
  },

  /**
   * Containers are processed asynchronously; publishing before FINISHED fails.
   */
  async waitForContainer(containerId, token, { attempts = 12, delayMs = 2000 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const status = await request(
        graphUrl(`/${containerId}`, { fields: 'status_code,status', access_token: token })
      );

      if (status.status_code === 'FINISHED') return true;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new InstagramError(`Instagram could not process the image (${status.status_code}).`, {
          body: status,
          hint: status.status || 'Check the image is a public, reachable JPEG.'
        });
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new InstagramError('Instagram is still processing the image after 24 seconds.', {
      hint: 'Try publishing again in a moment.'
    });
  },

  /* ----------------------------------------------------------------- inbound */

  /** Fetches recent posts from the connected account. */
  async fetchRecentMedia(limit = 25) {
    const token = await instagram.ensureFreshToken();
    const result = await request(
      graphUrl('/me/media', {
        fields: 'id,caption,media_type,media_url,permalink,timestamp,thumbnail_url,children{media_url,media_type}',
        limit,
        access_token: token
      })
    );
    return Array.isArray(result.data) ? result.data : [];
  },

  /** Downloads an image Instagram serves back to us, for locally storing. */
  async downloadImage(url) {
    const response = await fetch(url);
    if (!response.ok) throw new InstagramError(`Could not download image (HTTP ${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  }
};

module.exports = instagram;
