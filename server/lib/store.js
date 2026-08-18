/*
 * store.js — durable state on disk.
 *
 * Three things live here:
 *   records.json   people + events (the canonical copy once a server is in play)
 *   instagram.json OAuth tokens and inbound-sync bookkeeping
 *   media/         photo files, served publicly only while a publish is in flight
 *
 * Writes go through a temp file + rename so a crash mid-write cannot leave a
 * truncated JSON file behind.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

const MEDIA_DIR = path.join(config.dataDir, 'media');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

const RECORDS_FILE = path.join(config.dataDir, 'records.json');
const IG_FILE = path.join(config.dataDir, 'instagram.json');

let records = readJson(RECORDS_FILE, { people: [], events: [] });
let instagram = readJson(IG_FILE, {
  connected: false,
  userId: null,
  username: null,
  accessToken: null,
  tokenExpiresAt: null,
  lastInboundSync: null,
  // Instagram media IDs already turned into events, so repeated pulls don't duplicate.
  importedMediaIds: []
});

/** photoId -> epoch ms after which the public /media/ URL stops working. */
const exposures = new Map();

const store = {
  /* ---------------------------------------------------------------- records */

  getRecords() {
    return records;
  },

  saveRecords(next) {
    records = {
      people: Array.isArray(next.people) ? next.people : [],
      events: Array.isArray(next.events) ? next.events : []
    };
    writeJson(RECORDS_FILE, records);
    return records;
  },

  getEvent(id) {
    return records.events.find((event) => event.id === id) || null;
  },

  upsertEvent(event) {
    const index = records.events.findIndex((existing) => existing.id === event.id);
    if (index >= 0) records.events[index] = { ...records.events[index], ...event };
    else records.events.push(event);
    writeJson(RECORDS_FILE, records);
    return store.getEvent(event.id);
  },

  /* ------------------------------------------------------------------ media */

  /** Stores a JPEG buffer and returns its photo id. */
  putPhoto(buffer, photoId) {
    const id = photoId || `img-${crypto.randomBytes(9).toString('hex')}`;
    fs.writeFileSync(path.join(MEDIA_DIR, `${id}.jpg`), buffer);
    return id;
  },

  hasPhoto(id) {
    return /^[\w-]+$/.test(id) && fs.existsSync(path.join(MEDIA_DIR, `${id}.jpg`));
  },

  readPhoto(id) {
    if (!store.hasPhoto(id)) return null;
    return fs.readFileSync(path.join(MEDIA_DIR, `${id}.jpg`));
  },

  deletePhoto(id) {
    if (store.hasPhoto(id)) fs.unlinkSync(path.join(MEDIA_DIR, `${id}.jpg`));
    exposures.delete(id);
  },

  listPhotoIds() {
    return fs
      .readdirSync(MEDIA_DIR)
      .filter((name) => name.endsWith('.jpg'))
      .map((name) => name.replace(/\.jpg$/, ''));
  },

  /**
   * Opens a time-boxed public window on a photo so Meta can fetch it.
   * Photos are private by default — this is the only thing that exposes them.
   */
  exposePhoto(id) {
    exposures.set(id, Date.now() + config.mediaExposureMinutes * 60_000);
    return `${config.publicUrl}/media/${id}.jpg`;
  },

  isPhotoExposed(id) {
    const until = exposures.get(id);
    if (!until) return false;
    if (Date.now() > until) {
      exposures.delete(id);
      return false;
    }
    return true;
  },

  revokePhoto(id) {
    exposures.delete(id);
  },

  /* -------------------------------------------------------------- instagram */

  getInstagram() {
    return instagram;
  },

  saveInstagram(patch) {
    instagram = { ...instagram, ...patch };
    writeJson(IG_FILE, instagram);
    return instagram;
  },

  markMediaImported(mediaId) {
    if (!instagram.importedMediaIds.includes(mediaId)) {
      instagram.importedMediaIds.push(mediaId);
      writeJson(IG_FILE, instagram);
    }
  },

  isMediaImported(mediaId) {
    return instagram.importedMediaIds.includes(mediaId);
  },

  /** Removes tokens on disconnect but keeps records and import history. */
  clearInstagram() {
    return store.saveInstagram({
      connected: false,
      userId: null,
      username: null,
      accessToken: null,
      tokenExpiresAt: null
    });
  }
};

module.exports = store;
