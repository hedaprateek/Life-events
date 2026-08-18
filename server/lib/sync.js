/*
 * sync.js — pulls Instagram posts into the timeline.
 *
 * Instagram has no push notification for your own new posts, so this polls.
 * Every imported post is recorded by media ID, so repeated polls update the
 * existing event rather than creating duplicates — the same identity rule the
 * Excel import uses.
 */
'use strict';

const crypto = require('node:crypto');
const store = require('./store');
const instagram = require('./instagram');

/** "Caption first line" becomes the title; the rest stays as the story. */
function splitCaption(caption) {
  const text = String(caption || '').trim();
  if (!text) return { title: 'Instagram post', description: '' };

  const lines = text.split(/\r?\n/).filter(Boolean);
  const first = lines[0].trim();
  const title = first.length > 80 ? `${first.slice(0, 77)}…` : first;
  return { title: title || 'Instagram post', description: text };
}

function extractTags(caption) {
  const found = String(caption || '').match(/#[\wÀ-ɏ]+/g) || [];
  return [...new Set(found.map((tag) => tag.slice(1).toLowerCase()))].slice(0, 20);
}

const sync = {
  /**
   * Imports recent Instagram posts as events.
   * @returns {{imported: number, updated: number, skipped: number, errors: string[]}}
   */
  async pullFromInstagram({ limit = 25 } = {}) {
    const media = await instagram.fetchRecentMedia(limit);
    const summary = { imported: 0, updated: 0, skipped: 0, errors: [] };

    for (const item of media) {
      try {
        if (item.media_type === 'VIDEO' && !item.thumbnail_url) {
          summary.skipped++;
          continue;
        }

        const existing = store
          .getRecords()
          .events.find((event) => event.instagram && event.instagram.mediaId === item.id);

        // A post this app published itself — already represented locally.
        if (!existing && store.isMediaImported(item.id)) {
          summary.skipped++;
          continue;
        }

        const { title, description } = splitCaption(item.caption);
        const date = (item.timestamp || new Date().toISOString()).slice(0, 10);

        // Grab the images so the timeline works offline like everything else.
        const urls = [];
        if (item.media_type === 'CAROUSEL_ALBUM' && item.children && item.children.data) {
          for (const child of item.children.data) {
            if (child.media_url && child.media_type !== 'VIDEO') urls.push(child.media_url);
          }
        } else if (item.media_type === 'VIDEO') {
          urls.push(item.thumbnail_url);
        } else if (item.media_url) {
          urls.push(item.media_url);
        }

        const photoIds = existing ? [...(existing.photoIds || [])] : [];
        if (!existing) {
          for (const url of urls.slice(0, 10)) {
            try {
              const buffer = await instagram.downloadImage(url);
              photoIds.push(store.putPhoto(buffer));
            } catch (err) {
              summary.errors.push(`${item.id}: ${err.message}`);
            }
          }
        }

        const record = {
          id: existing ? existing.id : `evt-ig-${crypto.randomBytes(6).toString('hex')}`,
          title,
          date,
          category: existing ? existing.category || 'Instagram' : 'Instagram',
          personIds: existing ? existing.personIds || [] : [],
          location: existing ? existing.location || '' : '',
          description,
          tags: extractTags(item.caption),
          mood: existing ? existing.mood || '' : '',
          favorite: existing ? !!existing.favorite : false,
          photoIds,
          createdAt: existing ? existing.createdAt : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          instagram: {
            mediaId: item.id,
            permalink: item.permalink || null,
            status: 'published',
            source: existing && existing.instagram ? existing.instagram.source || 'instagram' : 'instagram',
            syncedAt: new Date().toISOString()
          }
        };

        store.upsertEvent(record);
        store.markMediaImported(item.id);
        if (existing) summary.updated++;
        else summary.imported++;
      } catch (err) {
        summary.errors.push(`${item.id}: ${err.message}`);
      }
    }

    store.saveInstagram({ lastInboundSync: new Date().toISOString() });
    return summary;
  },

  /** Events the user has marked to share that have not gone out yet. */
  pendingQueue() {
    return store
      .getRecords()
      .events.filter((event) => event.instagram && event.instagram.status === 'queued');
  }
};

module.exports = sync;
