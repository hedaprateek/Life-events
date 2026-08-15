/*
 * storage.js — local persistence for people, events and photos.
 *
 * Records (text) live in localStorage; photos live in IndexedDB because they
 * are far too large for localStorage's ~5MB budget. Some browsers refuse
 * IndexedDB on file:// URLs, so there is a localStorage fallback for photos
 * too — smaller, but it keeps the app usable from a double-clicked file.
 *
 * Nothing here talks to a network. The exported .xlsx / .json files are the
 * real, portable copy of the data; this is just the working cache.
 */
(function (global) {
  'use strict';

  var RECORDS_KEY = 'life-events:records:v1';
  var PHOTOS_KEY = 'life-events:photos:v1';
  var DB_NAME = 'life-events';
  var DB_STORE = 'photos';

  var db = null;
  var usingIndexedDb = false;
  var photoCache = Object.create(null); // id -> data URL, kept in memory for sync rendering

  function openIndexedDb() {
    return new Promise(function (resolve) {
      if (!global.indexedDB) return resolve(null);
      var request;
      try {
        request = global.indexedDB.open(DB_NAME, 1);
      } catch (err) {
        return resolve(null);
      }
      request.onupgradeneeded = function () {
        request.result.createObjectStore(DB_STORE);
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onerror = function () {
        resolve(null);
      };
      // Blocked or hung (some file:// contexts never settle) — move on.
      setTimeout(function () {
        resolve(request.readyState === 'done' ? request.result || null : null);
      }, 2500);
    });
  }

  function idbRequest(mode, run) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, mode);
      var request = run(tx.objectStore(DB_STORE));
      tx.onerror = function () {
        reject(tx.error);
      };
      if (request) {
        request.onsuccess = function () {
          resolve(request.result);
        };
      } else {
        tx.oncomplete = function () {
          resolve();
        };
      }
    });
  }

  function readLocalPhotos() {
    try {
      return JSON.parse(global.localStorage.getItem(PHOTOS_KEY) || '{}');
    } catch (err) {
      return {};
    }
  }

  function writeLocalPhotos() {
    global.localStorage.setItem(PHOTOS_KEY, JSON.stringify(photoCache));
  }

  var Storage = {
    /** Opens the database and loads all photos into memory. */
    init: async function () {
      db = await openIndexedDb();
      usingIndexedDb = !!db;

      if (usingIndexedDb) {
        try {
          var keys = await idbRequest('readonly', function (store) {
            return store.getAllKeys();
          });
          var values = await idbRequest('readonly', function (store) {
            return store.getAll();
          });
          keys.forEach(function (key, i) {
            photoCache[key] = values[i];
          });
        } catch (err) {
          usingIndexedDb = false;
        }
      }
      if (!usingIndexedDb) photoCache = readLocalPhotos();
      return { usingIndexedDb: usingIndexedDb, photoCount: Object.keys(photoCache).length };
    },

    isUsingIndexedDb: function () {
      return usingIndexedDb;
    },

    loadRecords: function () {
      try {
        var raw = global.localStorage.getItem(RECORDS_KEY);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        return {
          people: Array.isArray(parsed.people) ? parsed.people : [],
          events: Array.isArray(parsed.events) ? parsed.events : []
        };
      } catch (err) {
        return null;
      }
    },

    saveRecords: function (records) {
      try {
        global.localStorage.setItem(
          RECORDS_KEY,
          JSON.stringify({ people: records.people, events: records.events })
        );
        return true;
      } catch (err) {
        return false;
      }
    },

    getPhoto: function (id) {
      return photoCache[id] || null;
    },

    hasPhoto: function (id) {
      return Object.prototype.hasOwnProperty.call(photoCache, id);
    },

    allPhotoIds: function () {
      return Object.keys(photoCache);
    },

    putPhoto: async function (id, dataUrl) {
      photoCache[id] = dataUrl;
      if (usingIndexedDb) {
        await idbRequest('readwrite', function (store) {
          return store.put(dataUrl, id);
        });
      } else {
        try {
          writeLocalPhotos();
        } catch (err) {
          delete photoCache[id];
          throw new Error(
            'Out of local photo storage. Export a JSON backup, then remove some ' +
              'photos — or open this page from a local web server so larger ' +
              'storage becomes available.'
          );
        }
      }
    },

    deletePhoto: async function (id) {
      delete photoCache[id];
      if (usingIndexedDb) {
        await idbRequest('readwrite', function (store) {
          return store.delete(id);
        });
      } else {
        try {
          writeLocalPhotos();
        } catch (err) {
          /* removing only ever frees space */
        }
      }
    },

    /** Drops photos no longer referenced by any record. */
    prunePhotos: async function (usedIds) {
      var used = new Set(usedIds);
      var orphans = Object.keys(photoCache).filter(function (id) {
        return !used.has(id);
      });
      for (var i = 0; i < orphans.length; i++) {
        await Storage.deletePhoto(orphans[i]);
      }
      return orphans.length;
    },

    clearAll: async function () {
      photoCache = Object.create(null);
      global.localStorage.removeItem(RECORDS_KEY);
      global.localStorage.removeItem(PHOTOS_KEY);
      if (usingIndexedDb) {
        await idbRequest('readwrite', function (store) {
          return store.clear();
        });
      }
    }
  };

  global.LifeStorage = Storage;
})(window);
