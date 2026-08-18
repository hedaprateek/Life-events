/*
 * backend.js — optional server link.
 *
 * The app still works as a plain double-clicked file. When it is served by
 * server/server.js instead, this module notices, and the server becomes the
 * canonical copy of the records so Instagram sync has something to sync with.
 *
 * Everything here fails soft: if the server is missing or unreachable, the app
 * carries on in local-only mode exactly as before.
 */
(function (global) {
  'use strict';

  var state = { available: false, status: null };

  async function api(pathname, options) {
    var response = await fetch(pathname, Object.assign({ headers: {} }, options));
    var text = await response.text();
    var body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error('The server sent a response this app could not read.');
    }
    if (!response.ok) {
      var message = body.error || 'Request failed (HTTP ' + response.status + ').';
      if (body.hint) message += ' ' + body.hint;
      throw new Error(message);
    }
    return body;
  }

  var Backend = {
    isAvailable: function () {
      return state.available;
    },

    getStatus: function () {
      return state.status;
    },

    /** Detects a backend. Never throws — absence is a normal, supported case. */
    init: async function () {
      // file:// has no server to talk to; skip the pointless request.
      if (global.location.protocol === 'file:') return false;
      try {
        var status = await api('/api/status');
        state.available = !!status.backend;
        state.status = status;
      } catch (err) {
        state.available = false;
      }
      return state.available;
    },

    refreshStatus: async function () {
      if (!state.available) return null;
      state.status = await api('/api/status');
      return state.status;
    },

    loadRecords: function () {
      return api('/api/records');
    },

    saveRecords: function (records) {
      return api('/api/records', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ people: records.people, events: records.events })
      });
    },

    /** Pushes photos the server does not have yet, so Instagram can fetch them. */
    uploadPhotos: function (photoIds) {
      var photos = photoIds
        .map(function (id) {
          var dataUrl = global.LifeStorage.getPhoto(id);
          return dataUrl ? { id: id, dataUrl: dataUrl } : null;
        })
        .filter(Boolean);
      if (!photos.length) return Promise.resolve({ saved: [] });

      return api('/api/photos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ photos: photos })
      });
    },

    /** Pulls down any photo this browser is missing (e.g. imported from Instagram). */
    fetchMissingPhotos: async function (photoIds) {
      var missing = photoIds.filter(function (id) {
        return id && !global.LifeStorage.hasPhoto(id);
      });
      if (!missing.length) return 0;

      var result = await api('/api/photos?ids=' + encodeURIComponent(missing.join(',')));
      var ids = Object.keys(result.photos || {});
      for (var i = 0; i < ids.length; i++) {
        await global.LifeStorage.putPhoto(ids[i], result.photos[ids[i]]);
      }
      return ids.length;
    },

    /* ----------------------------------------------------------- instagram */

    connectUrl: function () {
      return api('/api/instagram/connect');
    },

    disconnect: function () {
      return api('/api/instagram/disconnect', { method: 'POST' });
    },

    queue: function () {
      return api('/api/instagram/queue');
    },

    publish: function (eventId, caption) {
      return api('/api/instagram/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: eventId, caption: caption })
      });
    },

    pull: function () {
      return api('/api/instagram/pull', { method: 'POST' });
    }
  };

  global.LifeBackend = Backend;
})(window);
