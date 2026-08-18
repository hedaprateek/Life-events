/*
 * config.js — server configuration.
 *
 * Values come from environment variables, falling back to server/config.json
 * (git-ignored) so you can keep credentials out of your shell history.
 * The Graph API hosts are configurable so the test suite can point the whole
 * client at a local mock instead of Meta.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

let fileConfig = {};
if (fs.existsSync(CONFIG_FILE)) {
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error(`config.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

function value(key, fallback) {
  return process.env[key] ?? fileConfig[key] ?? fallback;
}

const config = {
  port: Number(value('PORT', 3000)),

  /** Public origin Meta will reach this server on, e.g. https://life.example.com */
  publicUrl: String(value('PUBLIC_URL', '')).replace(/\/+$/, ''),

  instagram: {
    appId: value('IG_APP_ID', ''),
    appSecret: value('IG_APP_SECRET', ''),
    // Meta requires the redirect URI to match the app settings byte for byte.
    redirectPath: value('IG_REDIRECT_PATH', '/api/instagram/callback'),
    scopes: value('IG_SCOPES', 'instagram_business_basic,instagram_business_content_publish'),
    apiVersion: value('IG_API_VERSION', 'v23.0'),

    // Overridable so tests can run the whole flow against a local mock.
    authHost: value('IG_AUTH_HOST', 'https://www.instagram.com'),
    tokenHost: value('IG_TOKEN_HOST', 'https://api.instagram.com'),
    graphHost: value('IG_GRAPH_HOST', 'https://graph.instagram.com')
  },

  /**
   * How long a photo stays reachable at its public /media/ URL after a publish
   * is requested. Meta fetches the image while building the container, so a
   * short window is enough — after it lapses the URL 404s again.
   */
  mediaExposureMinutes: Number(value('MEDIA_EXPOSURE_MINUTES', 60)),

  /** Minutes between automatic pulls of new Instagram posts. 0 disables polling. */
  inboundPollMinutes: Number(value('INBOUND_POLL_MINUTES', 15)),

  dataDir: value('DATA_DIR', path.join(ROOT, 'data'))
};

config.redirectUri = config.publicUrl + config.instagram.redirectPath;

/** Problems that make Instagram features unusable, as human-readable strings. */
config.problems = function problems() {
  const list = [];
  if (!config.instagram.appId) list.push('IG_APP_ID is not set.');
  if (!config.instagram.appSecret) list.push('IG_APP_SECRET is not set.');
  if (!config.publicUrl) {
    list.push('PUBLIC_URL is not set — Instagram cannot fetch your photos without it.');
  } else if (!/^https:\/\//.test(config.publicUrl) && !/localhost|127\.0\.0\.1/.test(config.publicUrl)) {
    list.push('PUBLIC_URL must be https:// — Meta refuses to fetch images over plain http.');
  }
  return list;
};

module.exports = config;
