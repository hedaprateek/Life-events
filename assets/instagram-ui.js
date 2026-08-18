/*
 * instagram-ui.js — the Instagram tab.
 *
 * Nothing here posts anything on its own. Events you tick for sharing land in
 * a queue; publishing happens only when you press the button on that specific
 * event, so a private note about your kids cannot go public by accident.
 */
(function (global) {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatWhen(iso) {
    if (!iso) return 'never';
    var date = new Date(iso);
    return isNaN(date) ? 'never' : date.toLocaleString();
  }

  var InstagramUI = {
    /** Renders the whole tab from current backend status + local records. */
    render: async function () {
      var panel = $('panel-instagram');
      if (!panel) return;

      if (!global.LifeBackend.isAvailable()) {
        panel.innerHTML =
          '<div class="cards"><div class="card">' +
          '<h2>Instagram sync needs the server</h2>' +
          '<p>You are using Life Events as a plain local file, which cannot talk to ' +
          'Instagram — Meta needs a public address to fetch your photos from, and the ' +
          'app secret must never sit in a page anyone can view the source of.</p>' +
          '<p class="note">Start the bundled server with <code>node server/server.js</code> ' +
          'and open the address it prints. Setup steps are in ' +
          '<code>server/SETUP-INSTAGRAM.md</code>.</p>' +
          '</div></div>';
        return;
      }

      var status;
      try {
        status = await global.LifeBackend.refreshStatus();
      } catch (err) {
        panel.innerHTML = '<div class="cards"><div class="card"><h2>Server unreachable</h2>' +
          '<p>' + escapeHtml(err.message) + '</p></div></div>';
        return;
      }

      var ig = status.instagram || {};
      var problems = status.configProblems || [];

      var connectionCard =
        '<div class="card">' +
          '<h2>Connection</h2>' +
          (problems.length
            ? '<p>Instagram is not configured yet:</p><ul class="problem-list">' +
              problems.map(function (p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') +
              '</ul><p class="note">See <code>server/SETUP-INSTAGRAM.md</code>.</p>'
            : ig.connected
              ? '<p class="connected">Connected as <strong>@' + escapeHtml(ig.username || 'unknown') + '</strong></p>' +
                '<dl class="stats">' +
                  '<dt>Last checked for new posts</dt><dd>' + escapeHtml(formatWhen(ig.lastInboundSync)) + '</dd>' +
                  '<dt>Token renews before</dt><dd>' + escapeHtml(formatWhen(ig.tokenExpiresAt)) + '</dd>' +
                  '<dt>Automatic check</dt><dd>' + (status.pollMinutes ? 'every ' + status.pollMinutes + ' min' : 'off') + '</dd>' +
                '</dl>' +
                '<div class="button-row">' +
                  '<button class="btn" id="ig-pull">Check for new posts now</button>' +
                  '<button class="btn btn-danger" id="ig-disconnect">Disconnect</button>' +
                '</div>'
              : '<p>Connect the Instagram Business or Creator account you want to keep in step with this timeline.</p>' +
                '<div class="button-row"><button class="btn btn-primary" id="ig-connect">Connect Instagram</button></div>') +
        '</div>';

      var events = global.LifeEvents.getState().events;
      var queued = events.filter(function (e) { return e.instagram && e.instagram.status === 'queued'; });
      var failed = events.filter(function (e) { return e.instagram && e.instagram.status === 'failed'; });
      var published = events.filter(function (e) { return e.instagram && e.instagram.status === 'published'; });

      function row(event, actions) {
        var photos = (event.photoIds || []).length;
        return '<li class="queue-row">' +
          '<div><div class="queue-title">' + escapeHtml(event.title || 'Untitled') + '</div>' +
          '<div class="queue-sub">' + escapeHtml(event.date || '') + ' · ' +
            photos + ' photo' + (photos === 1 ? '' : 's') +
            (event.instagram && event.instagram.error
              ? ' · <span class="queue-error">' + escapeHtml(event.instagram.error) + '</span>'
              : '') +
            (event.instagram && event.instagram.permalink
              ? ' · <a href="' + escapeHtml(event.instagram.permalink) + '" target="_blank" rel="noopener">view on Instagram</a>'
              : '') +
          '</div></div>' +
          '<div class="queue-actions">' + actions + '</div>' +
        '</li>';
      }

      var queueCard =
        '<div class="card">' +
          '<h2>Waiting for your approval' + (queued.length ? ' (' + queued.length + ')' : '') + '</h2>' +
          (queued.length
            ? '<ul class="queue">' + queued.map(function (e) {
                return row(e,
                  '<button class="btn btn-primary btn-small" data-publish="' + escapeHtml(e.id) + '"' +
                    (ig.connected ? '' : ' disabled title="Connect Instagram first"') + '>Publish</button>' +
                  '<button class="btn btn-small" data-unqueue="' + escapeHtml(e.id) + '">Remove</button>');
              }).join('') + '</ul>'
            : '<p>Nothing waiting. Tick <em>Share to Instagram</em> on an event to line it up here.</p>') +
          (failed.length
            ? '<h3 class="subhead">Failed</h3><ul class="queue">' + failed.map(function (e) {
                return row(e, '<button class="btn btn-small" data-requeue="' + escapeHtml(e.id) + '">Try again</button>');
              }).join('') + '</ul>'
            : '') +
        '</div>';

      var publishedCard =
        '<div class="card">' +
          '<h2>Synced with Instagram (' + published.length + ')</h2>' +
          (published.length
            ? '<ul class="queue">' + published.slice(0, 12).map(function (e) {
                var origin = e.instagram.source === 'instagram' ? 'came from Instagram' : 'posted from here';
                return row(e, '<span class="chip">' + origin + '</span>');
              }).join('') + '</ul>'
            : '<p>Nothing synced yet.</p>') +
        '</div>';

      panel.innerHTML = '<div class="cards">' + connectionCard + queueCard + publishedCard + '</div>';
      InstagramUI.bind();
    },

    bind: function () {
      var panel = $('panel-instagram');
      if (!panel) return;

      var connect = $('ig-connect');
      if (connect) {
        connect.addEventListener('click', async function () {
          try {
            var result = await global.LifeBackend.connectUrl();
            // Meta's consent screen must be a full page load, not an iframe.
            global.open(result.url, '_blank', 'noopener');
            global.LifeEvents.toast('Finish the connection in the new tab, then come back and refresh.');
          } catch (err) {
            global.LifeEvents.toast(err.message, true);
          }
        });
      }

      var disconnect = $('ig-disconnect');
      if (disconnect) {
        disconnect.addEventListener('click', async function () {
          if (!confirm('Disconnect Instagram? Events already synced keep their links.')) return;
          try {
            await global.LifeBackend.disconnect();
            await InstagramUI.render();
            global.LifeEvents.toast('Instagram disconnected.');
          } catch (err) {
            global.LifeEvents.toast(err.message, true);
          }
        });
      }

      var pull = $('ig-pull');
      if (pull) {
        pull.addEventListener('click', async function () {
          pull.disabled = true;
          pull.textContent = 'Checking…';
          try {
            var summary = await global.LifeBackend.pull();
            await global.LifeEvents.reloadFromBackend();
            global.LifeEvents.toast(
              'Imported ' + summary.imported + ', updated ' + summary.updated +
              (summary.errors.length ? ', ' + summary.errors.length + ' problem(s)' : '') + '.'
            );
          } catch (err) {
            global.LifeEvents.toast(err.message, true);
          } finally {
            await InstagramUI.render();
          }
        });
      }

      panel.addEventListener('click', async function (e) {
        var publishBtn = e.target.closest('[data-publish]');
        var unqueue = e.target.closest('[data-unqueue]');
        var requeue = e.target.closest('[data-requeue]');

        if (publishBtn) {
          var id = publishBtn.getAttribute('data-publish');
          publishBtn.disabled = true;
          publishBtn.textContent = 'Publishing…';
          try {
            // Make sure the server holds the images before Instagram asks for them.
            var event = global.LifeEvents.getEvent(id);
            await global.LifeBackend.uploadPhotos(event.photoIds || []);
            await global.LifeBackend.publish(id, event.instagram && event.instagram.caption);
            await global.LifeEvents.reloadFromBackend();
            global.LifeEvents.toast('Posted to Instagram.');
          } catch (err) {
            global.LifeEvents.toast(err.message, true);
            await global.LifeEvents.reloadFromBackend();
          } finally {
            await InstagramUI.render();
          }
        }

        if (unqueue || requeue) {
          var eventId = (unqueue || requeue).getAttribute(unqueue ? 'data-unqueue' : 'data-requeue');
          global.LifeEvents.setInstagramStatus(eventId, unqueue ? null : 'queued');
          await InstagramUI.render();
        }
      });
    }
  };

  global.LifeInstagramUI = InstagramUI;
})(window);
