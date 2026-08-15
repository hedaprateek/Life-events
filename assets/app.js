/*
 * app.js — Life Events
 *
 * Records are kept in memory, mirrored into local storage on every change, and
 * exported to .xlsx / .json / .csv / print. Import merges by ID so the same
 * workbook can be exported, edited in Excel, and brought back repeatedly.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  var state = {
    people: [],
    events: [],
    filters: { search: '', person: '', category: '', year: '', favorites: false, sort: 'date-desc' }
  };

  // Photos attached in the open editor but not yet committed to a record.
  var draft = { photoIds: [], personPhotoId: null };

  var EVENT_HEADERS = [
    'ID', 'Date', 'Title', 'Category', 'People', 'Place', 'Story',
    'Tags', 'Mood', 'Favourite', 'PhotoIDs', 'Created', 'Updated'
  ];
  var PEOPLE_HEADERS = ['ID', 'Name', 'Relationship', 'Birthday', 'Notes', 'PhotoID'];

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function newId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function splitList(value) {
    return String(value || '')
      .split(',')
      .map(function (part) { return part.trim(); })
      .filter(Boolean);
  }

  function isTruthy(value) {
    return /^(true|yes|y|1|x|★)$/i.test(String(value || '').trim());
  }

  var toastTimer = null;
  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.classList.toggle('is-error', !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, isError ? 6500 : 3200);
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function stamp() {
    var now = new Date();
    return (
      now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0')
    );
  }

  /** Accepts what Excel might hand back: ISO text, a serial number, or d/m/y. */
  function normalizeDate(value) {
    var text = String(value == null ? '' : value).trim();
    if (!text) return '';

    var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
    if (iso) return iso[1] + '-' + iso[2].padStart(2, '0') + '-' + iso[3].padStart(2, '0');

    if (/^\d+(\.\d+)?$/.test(text)) {
      var serial = parseFloat(text);
      if (serial > 0 && serial < 2958466) {
        // Excel's epoch is 1899-12-30 (it counts a non-existent 1900-02-29).
        var date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
        return date.toISOString().slice(0, 10);
      }
    }

    var slashed = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/.exec(text);
    if (slashed) {
      var first = parseInt(slashed[1], 10);
      var second = parseInt(slashed[2], 10);
      // Day-first unless that is impossible (e.g. 03/25/2024).
      var day = first, month = second;
      if (first > 12 && second <= 12) { day = first; month = second; }
      else if (second > 12 && first <= 12) { day = second; month = first; }
      return slashed[3] + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }

    var parsed = new Date(text);
    if (!isNaN(parsed.getTime())) {
      return (
        parsed.getFullYear() + '-' + String(parsed.getMonth() + 1).padStart(2, '0') + '-' +
        String(parsed.getDate()).padStart(2, '0')
      );
    }
    return text;
  }

  function formatDate(iso) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!match) return iso || '';
    return parseInt(match[3], 10) + ' ' + MONTHS[parseInt(match[2], 10) - 1] + ' ' + match[1];
  }

  function personById(id) {
    for (var i = 0; i < state.people.length; i++) {
      if (state.people[i].id === id) return state.people[i];
    }
    return null;
  }

  function personNames(event) {
    return (event.personIds || [])
      .map(function (id) { var p = personById(id); return p ? p.name : null; })
      .filter(Boolean);
  }

  function usedPhotoIds() {
    var ids = [];
    state.events.forEach(function (event) {
      (event.photoIds || []).forEach(function (id) { ids.push(id); });
    });
    state.people.forEach(function (person) {
      if (person.photoId) ids.push(person.photoId);
    });
    return ids;
  }

  function persist() {
    if (!LifeStorage.saveRecords(state)) {
      toast('Could not save to this browser — storage is full. Export a backup now.', true);
    }
  }

  /* ------------------------------------------------------------------ *
   * Photos
   * ------------------------------------------------------------------ */

  var MAX_DIMENSION = 1400;

  /** Reads a File, shrinks it, and returns a JPEG data URL. */
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read ' + file.name)); };
      reader.onload = function () {
        var image = new Image();
        image.onerror = function () { reject(new Error(file.name + ' is not an image this browser can open.')); };
        image.onload = function () {
          var scale = Math.min(1, MAX_DIMENSION / Math.max(image.width, image.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff'; // flatten transparency, JPEG has no alpha
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function addPhotoFiles(files, onAdded) {
    var list = Array.prototype.slice.call(files);
    for (var i = 0; i < list.length; i++) {
      if (!/^image\//.test(list[i].type)) {
        toast(list[i].name + ' is not an image — skipped.', true);
        continue;
      }
      try {
        var dataUrl = await compressImage(list[i]);
        var id = newId('img');
        await LifeStorage.putPhoto(id, dataUrl);
        onAdded(id);
      } catch (err) {
        toast(err.message, true);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Rendering — timeline
   * ------------------------------------------------------------------ */

  function matchesFilters(event) {
    var f = state.filters;
    if (f.person && (event.personIds || []).indexOf(f.person) === -1) return false;
    if (f.category && event.category !== f.category) return false;
    if (f.year && String(event.date || '').slice(0, 4) !== f.year) return false;
    if (f.favorites && !event.favorite) return false;

    if (f.search) {
      var haystack = [
        event.title, event.description, event.location, event.category, event.mood,
        (event.tags || []).join(' '), personNames(event).join(' ')
      ].join(' ').toLowerCase();
      if (haystack.indexOf(f.search.toLowerCase()) === -1) return false;
    }
    return true;
  }

  function sortEvents(events) {
    var sort = state.filters.sort;
    return events.slice().sort(function (a, b) {
      if (sort === 'title-asc') return (a.title || '').localeCompare(b.title || '');
      if (sort === 'added-desc') return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      var compared = String(a.date || '').localeCompare(String(b.date || ''));
      return sort === 'date-asc' ? compared : -compared;
    });
  }

  function eventCardHtml(event) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(event.date || '');
    var dateBlock = match
      ? '<div class="event-day">' + parseInt(match[3], 10) + '</div>' +
        '<div class="event-month">' + MONTHS[parseInt(match[2], 10) - 1] + '</div>' +
        '<div class="event-year">' + match[1] + '</div>'
      : '<div class="event-month">' + escapeHtml(event.date || 'No date') + '</div>';

    var chips = personNames(event)
      .map(function (name) { return '<span class="chip chip-person">' + escapeHtml(name) + '</span>'; });
    if (event.category) chips.push('<span class="chip">' + escapeHtml(event.category) + '</span>');
    if (event.location) chips.push('<span class="chip">📍 ' + escapeHtml(event.location) + '</span>');
    if (event.mood) chips.push('<span class="chip">' + escapeHtml(event.mood) + '</span>');
    (event.tags || []).forEach(function (tag) {
      chips.push('<span class="chip chip-tag">' + escapeHtml(tag) + '</span>');
    });

    var photos = (event.photoIds || [])
      .map(function (id) { return LifeStorage.getPhoto(id); })
      .filter(Boolean)
      .map(function (src) {
        return '<img src="' + src + '" alt="" loading="lazy" data-zoom="1">';
      })
      .join('');

    return (
      '<article class="event-card" data-event-id="' + escapeHtml(event.id) + '">' +
        '<div class="event-date">' + dateBlock + '</div>' +
        '<div>' +
          '<div class="event-title">' + escapeHtml(event.title || 'Untitled') +
            (event.favorite ? '<span class="event-star">★</span>' : '') +
          '</div>' +
          (chips.length ? '<div class="event-meta">' + chips.join('') + '</div>' : '') +
          (event.description ? '<p class="event-body">' + escapeHtml(event.description) + '</p>' : '') +
          (photos ? '<div class="event-photos">' + photos + '</div>' : '') +
        '</div>' +
      '</article>'
    );
  }

  function renderTimeline() {
    var container = $('timeline');
    var visible = sortEvents(state.events.filter(matchesFilters));

    $('result-count').textContent = state.events.length
      ? visible.length + ' of ' + state.events.length + ' event' + (state.events.length === 1 ? '' : 's')
      : '';

    if (!state.events.length) {
      container.innerHTML =
        '<div class="empty"><h3>Nothing here yet</h3>' +
        '<p>Add the people who matter, then start recording the moments.</p></div>';
      return;
    }
    if (!visible.length) {
      container.innerHTML =
        '<div class="empty"><h3>No events match these filters</h3>' +
        '<p>Try clearing the search or choosing a different person.</p></div>';
      return;
    }

    // Group by year, keeping the order the sort produced.
    var groups = [];
    var byYear = Object.create(null);
    visible.forEach(function (event) {
      var year = /^\d{4}/.test(event.date || '') ? event.date.slice(0, 4) : 'Undated';
      if (!byYear[year]) { byYear[year] = []; groups.push(year); }
      byYear[year].push(event);
    });

    container.innerHTML = groups
      .map(function (year) {
        return (
          '<h2 class="year-heading">' + escapeHtml(year) + '</h2>' +
          '<div class="event-list">' + byYear[year].map(eventCardHtml).join('') + '</div>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------------------ *
   * Rendering — people, gallery, filters, stats
   * ------------------------------------------------------------------ */

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (part) { return part.charAt(0).toUpperCase(); }).join('');
  }

  function renderPeople() {
    var grid = $('people-grid');
    if (!state.people.length) {
      grid.innerHTML =
        '<div class="empty"><h3>No people yet</h3>' +
        '<p>Add yourself, your parents, your kids — anyone whose story you want to keep.</p></div>';
      return;
    }

    grid.innerHTML = state.people
      .map(function (person) {
        var count = state.events.filter(function (event) {
          return (event.personIds || []).indexOf(person.id) !== -1;
        }).length;
        var photo = person.photoId ? LifeStorage.getPhoto(person.photoId) : null;
        var avatar = photo
          ? '<img class="avatar" src="' + photo + '" alt="">'
          : '<div class="avatar">' + escapeHtml(initials(person.name)) + '</div>';

        var sub = [person.relationship, person.birthday ? '🎂 ' + formatDate(person.birthday) : '']
          .filter(Boolean).join(' · ');

        return (
          '<article class="person-card" data-person-id="' + escapeHtml(person.id) + '">' +
            avatar +
            '<div>' +
              '<div class="person-name">' + escapeHtml(person.name) + '</div>' +
              (sub ? '<div class="person-sub">' + escapeHtml(sub) + '</div>' : '') +
              '<div class="person-sub">' + count + ' event' + (count === 1 ? '' : 's') + '</div>' +
            '</div>' +
          '</article>'
        );
      })
      .join('');
  }

  function renderGallery() {
    var grid = $('gallery-grid');
    var items = [];

    sortEvents(state.events.slice()).forEach(function (event) {
      (event.photoIds || []).forEach(function (id) {
        var src = LifeStorage.getPhoto(id);
        if (src) items.push({ src: src, caption: (event.title || 'Untitled') + ' · ' + formatDate(event.date) });
      });
    });

    if (!items.length) {
      grid.innerHTML = '<div class="empty"><h3>No photos yet</h3><p>Photos you attach to events show up here.</p></div>';
      return;
    }

    grid.innerHTML = items
      .map(function (item) {
        return (
          '<figure><img src="' + item.src + '" alt="" loading="lazy" data-zoom="1">' +
          '<figcaption>' + escapeHtml(item.caption) + '</figcaption></figure>'
        );
      })
      .join('');
  }

  function renderFilterOptions() {
    function fill(select, values, keepValue) {
      var current = keepValue;
      select.innerHTML =
        '<option value="">' + select.dataset.allLabel + '</option>' +
        values.map(function (item) {
          return '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + '</option>';
        }).join('');
      select.value = values.some(function (i) { return i.value === current; }) ? current : '';
    }

    var personSelect = $('filter-person');
    personSelect.dataset.allLabel = 'Everyone';
    fill(personSelect, state.people.map(function (p) { return { value: p.id, label: p.name }; }),
      state.filters.person);

    var categories = [];
    state.events.forEach(function (event) {
      if (event.category && categories.indexOf(event.category) === -1) categories.push(event.category);
    });
    categories.sort();
    var categorySelect = $('filter-category');
    categorySelect.dataset.allLabel = 'All categories';
    fill(categorySelect, categories.map(function (c) { return { value: c, label: c }; }),
      state.filters.category);

    var years = [];
    state.events.forEach(function (event) {
      var year = String(event.date || '').slice(0, 4);
      if (/^\d{4}$/.test(year) && years.indexOf(year) === -1) years.push(year);
    });
    years.sort().reverse();
    var yearSelect = $('filter-year');
    yearSelect.dataset.allLabel = 'All years';
    fill(yearSelect, years.map(function (y) { return { value: y, label: y }; }), state.filters.year);

    state.filters.person = personSelect.value;
    state.filters.category = categorySelect.value;
    state.filters.year = yearSelect.value;
  }

  function renderStats() {
    var photoCount = LifeStorage.allPhotoIds().length;
    var bytes = 0;
    LifeStorage.allPhotoIds().forEach(function (id) {
      var data = LifeStorage.getPhoto(id);
      if (data) bytes += Math.round(data.length * 0.75); // base64 -> bytes
    });

    $('stats').innerHTML =
      '<dt>People</dt><dd>' + state.people.length + '</dd>' +
      '<dt>Events</dt><dd>' + state.events.length + '</dd>' +
      '<dt>Photos</dt><dd>' + photoCount + '</dd>' +
      '<dt>Photo storage used</dt><dd>' +
        (bytes < 1048576 ? Math.round(bytes / 1024) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB') +
      '</dd>' +
      '<dt>Storage engine</dt><dd>' + (LifeStorage.isUsingIndexedDb() ? 'IndexedDB' : 'localStorage') + '</dd>';
  }

  function renderAll() {
    renderFilterOptions();
    renderTimeline();
    renderPeople();
    renderGallery();
    renderStats();
  }

  /* ------------------------------------------------------------------ *
   * Event editor
   * ------------------------------------------------------------------ */

  function renderPhotoStrip(containerId, ids, onRemove) {
    var container = $(containerId);
    container.innerHTML = ids
      .map(function (id) {
        var src = LifeStorage.getPhoto(id);
        if (!src) return '';
        return (
          '<div class="photo-thumb"><img src="' + src + '" alt="">' +
          '<button type="button" data-remove-photo="' + escapeHtml(id) + '" aria-label="Remove photo">✕</button></div>'
        );
      })
      .join('');

    container.onclick = function (e) {
      var button = e.target.closest('[data-remove-photo]');
      if (button) onRemove(button.getAttribute('data-remove-photo'));
    };
  }

  function renderPeoplePicker(selectedIds) {
    var container = $('event-people');
    if (!state.people.length) {
      container.innerHTML = '<span class="hint">No people added yet.</span>';
      return;
    }
    container.innerHTML = state.people
      .map(function (person) {
        var checked = selectedIds.indexOf(person.id) !== -1 ? ' checked' : '';
        return (
          '<label><input type="checkbox" value="' + escapeHtml(person.id) + '"' + checked + '>' +
          escapeHtml(person.name) + '</label>'
        );
      })
      .join('');
  }

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  function openEventEditor(eventId) {
    var event = eventId
      ? state.events.filter(function (e) { return e.id === eventId; })[0]
      : null;

    $('event-modal-title').textContent = event ? 'Edit event' : 'Add event';
    $('event-id').value = event ? event.id : '';
    $('event-title').value = event ? event.title || '' : '';
    $('event-date').value = event ? event.date || '' : stamp();
    $('event-category').value = event ? event.category || '' : '';
    $('event-location').value = event ? event.location || '' : '';
    $('event-mood').value = event ? event.mood || '' : '';
    $('event-description').value = event ? event.description || '' : '';
    $('event-tags').value = event ? (event.tags || []).join(', ') : '';
    $('event-favorite').checked = event ? !!event.favorite : false;
    $('event-delete').hidden = !event;
    $('event-photos').value = '';

    draft.photoIds = event ? (event.photoIds || []).slice() : [];
    renderPeoplePicker(event ? (event.personIds || []) : []);
    refreshEventPhotoStrip();

    openModal('event-modal');
    $('event-title').focus();
  }

  function refreshEventPhotoStrip() {
    renderPhotoStrip('event-photo-strip', draft.photoIds, function (id) {
      draft.photoIds = draft.photoIds.filter(function (existing) { return existing !== id; });
      refreshEventPhotoStrip();
    });
  }

  function saveEventFromForm(e) {
    e.preventDefault();
    var id = $('event-id').value;
    var now = new Date().toISOString();

    var selectedPeople = Array.prototype.map.call(
      $('event-people').querySelectorAll('input:checked'),
      function (input) { return input.value; }
    );

    var record = {
      id: id || newId('evt'),
      title: $('event-title').value.trim(),
      date: $('event-date').value,
      category: $('event-category').value.trim(),
      personIds: selectedPeople,
      location: $('event-location').value.trim(),
      description: $('event-description').value.trim(),
      tags: splitList($('event-tags').value),
      mood: $('event-mood').value,
      favorite: $('event-favorite').checked,
      photoIds: draft.photoIds.slice(),
      createdAt: now,
      updatedAt: now
    };

    var index = state.events.findIndex(function (existing) { return existing.id === record.id; });
    if (index >= 0) {
      record.createdAt = state.events[index].createdAt || now;
      state.events[index] = record;
    } else {
      state.events.push(record);
    }

    persist();
    renderAll();
    closeModal('event-modal');
    toast(index >= 0 ? 'Event updated.' : 'Event saved.');
  }

  async function deleteCurrentEvent() {
    var id = $('event-id').value;
    if (!id) return;
    var event = state.events.filter(function (e) { return e.id === id; })[0];
    if (!confirm('Delete "' + (event ? event.title : 'this event') + '"? This cannot be undone.')) return;

    state.events = state.events.filter(function (e) { return e.id !== id; });
    await LifeStorage.prunePhotos(usedPhotoIds());
    persist();
    renderAll();
    closeModal('event-modal');
    toast('Event deleted.');
  }

  /* ------------------------------------------------------------------ *
   * Person editor
   * ------------------------------------------------------------------ */

  function refreshPersonPhotoStrip() {
    renderPhotoStrip(
      'person-photo-strip',
      draft.personPhotoId ? [draft.personPhotoId] : [],
      function () { draft.personPhotoId = null; refreshPersonPhotoStrip(); }
    );
  }

  function openPersonEditor(personId) {
    var person = personId ? personById(personId) : null;

    $('person-modal-title').textContent = person ? 'Edit person' : 'Add person';
    $('person-id').value = person ? person.id : '';
    $('person-name').value = person ? person.name || '' : '';
    $('person-relationship').value = person ? person.relationship || '' : '';
    $('person-birthday').value = person ? person.birthday || '' : '';
    $('person-notes').value = person ? person.notes || '' : '';
    $('person-delete').hidden = !person;
    $('person-photo').value = '';

    draft.personPhotoId = person ? person.photoId || null : null;
    refreshPersonPhotoStrip();

    openModal('person-modal');
    $('person-name').focus();
  }

  function savePersonFromForm(e) {
    e.preventDefault();
    var id = $('person-id').value;
    var record = {
      id: id || newId('per'),
      name: $('person-name').value.trim(),
      relationship: $('person-relationship').value.trim(),
      birthday: $('person-birthday').value,
      notes: $('person-notes').value.trim(),
      photoId: draft.personPhotoId
    };

    var index = state.people.findIndex(function (existing) { return existing.id === record.id; });
    if (index >= 0) state.people[index] = record;
    else state.people.push(record);

    persist();
    renderAll();
    closeModal('person-modal');
    toast(index >= 0 ? 'Person updated.' : 'Person added.');
  }

  async function deleteCurrentPerson() {
    var id = $('person-id').value;
    if (!id) return;
    var person = personById(id);
    if (!confirm('Remove ' + (person ? person.name : 'this person') + '? Their events are kept, but unassigned.')) return;

    state.people = state.people.filter(function (p) { return p.id !== id; });
    state.events.forEach(function (event) {
      event.personIds = (event.personIds || []).filter(function (pid) { return pid !== id; });
    });

    await LifeStorage.prunePhotos(usedPhotoIds());
    persist();
    renderAll();
    closeModal('person-modal');
    toast('Person removed.');
  }

  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */

  function eventRows() {
    var rows = [EVENT_HEADERS.slice()];
    sortEvents(state.events.slice()).forEach(function (event) {
      rows.push([
        event.id,
        event.date || '',
        event.title || '',
        event.category || '',
        personNames(event).join(', '),
        event.location || '',
        event.description || '',
        (event.tags || []).join(', '),
        event.mood || '',
        event.favorite ? 'TRUE' : 'FALSE',
        (event.photoIds || []).join(', '),
        event.createdAt || '',
        event.updatedAt || ''
      ]);
    });
    return rows;
  }

  function peopleRows() {
    var rows = [PEOPLE_HEADERS.slice()];
    state.people.forEach(function (person) {
      rows.push([
        person.id,
        person.name || '',
        person.relationship || '',
        person.birthday || '',
        person.notes || '',
        person.photoId || ''
      ]);
    });
    return rows;
  }

  function exportXlsx() {
    if (!state.events.length && !state.people.length) return toast('Nothing to export yet.', true);
    var blob = XlsxLite.build([
      { name: 'Events', rows: eventRows() },
      { name: 'People', rows: peopleRows() },
      { name: 'Read me', rows: [
        ['How this file works'],
        [''],
        ['Edit the Events and People sheets, then import this file back into the Life Events page.'],
        ['Keep the ID column untouched — it is how existing records are matched and updated.'],
        ['Leave ID blank on a new row and a fresh record is created for it.'],
        ['Dates work best as YYYY-MM-DD. Day/month/year is also understood.'],
        ['The People column on an event holds names, separated by commas. Unknown names are added as new people.'],
        ['Favourite accepts TRUE or FALSE.'],
        ['PhotoIDs point at photos held in your browser. Do not edit them by hand.'],
        ['Photos themselves are not in this file — use the JSON backup to move them between devices.'],
        [''],
        ['Exported', new Date().toLocaleString()]
      ] }
    ]);
    download(blob, 'life-events-' + stamp() + '.xlsx');
    toast('Excel workbook exported.');
  }

  function exportJson() {
    var photos = {};
    usedPhotoIds().forEach(function (id) {
      var data = LifeStorage.getPhoto(id);
      if (data) photos[id] = data;
    });

    var payload = {
      format: 'life-events',
      version: 1,
      exportedAt: new Date().toISOString(),
      people: state.people,
      events: state.events,
      photos: photos
    };
    download(new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      'life-events-backup-' + stamp() + '.json');
    toast('Full backup exported, photos included.');
  }

  function toCsv(rows) {
    return rows
      .map(function (row) {
        return row
          .map(function (cell) {
            var text = String(cell == null ? '' : cell);
            return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
          })
          .join(',');
      })
      .join('\r\n');
  }

  function exportCsv() {
    if (!state.events.length) return toast('No events to export yet.', true);
    // The BOM keeps Excel from mangling accented names.
    download(new Blob(['﻿' + toCsv(eventRows())], { type: 'text/csv;charset=utf-8' }),
      'life-events-' + stamp() + '.csv');
    toast('CSV exported.');
  }

  function exportPrintable() {
    if (!state.events.length) return toast('No events to print yet.', true);
    var events = sortEvents(state.events.filter(matchesFilters));
    if (!events.length) return toast('No events match the current filters.', true);

    var body = events
      .map(function (event) {
        var meta = [formatDate(event.date), personNames(event).join(', '), event.category, event.location]
          .filter(Boolean).join(' &nbsp;·&nbsp; ');
        var photos = (event.photoIds || [])
          .map(function (id) { return LifeStorage.getPhoto(id); })
          .filter(Boolean)
          .map(function (src) { return '<img src="' + src + '">'; })
          .join('');

        return (
          '<article>' +
            '<h2>' + escapeHtml(event.title || 'Untitled') + (event.favorite ? ' ★' : '') + '</h2>' +
            '<p class="meta">' + meta + '</p>' +
            (event.description ? '<p class="story">' + escapeHtml(event.description) + '</p>' : '') +
            (photos ? '<div class="photos">' + photos + '</div>' : '') +
            ((event.tags || []).length ? '<p class="tags">' + escapeHtml(event.tags.join(' · ')) + '</p>' : '') +
          '</article>'
        );
      })
      .join('');

    var html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Life Events album</title><style>' +
      'body{font:15px/1.6 Georgia,serif;color:#241f1b;max-width:760px;margin:40px auto;padding:0 24px}' +
      'h1{font-size:28px;margin:0 0 4px}.sub{color:#7a6f65;margin:0 0 32px}' +
      'article{break-inside:avoid;page-break-inside:avoid;border-top:1px solid #e0d8ce;padding:22px 0}' +
      'h2{font-size:19px;margin:0 0 4px}.meta{color:#7a6f65;font-size:13px;margin:0 0 10px}' +
      '.story{white-space:pre-wrap;margin:0 0 12px}' +
      '.photos{display:flex;flex-wrap:wrap;gap:8px}.photos img{max-width:220px;border-radius:6px}' +
      '.tags{font-size:12px;color:#9a8f84;margin:10px 0 0}' +
      '@media print{body{margin:0}}' +
      '</style></head><body>' +
      '<h1>Life Events</h1><p class="sub">' + events.length + ' moments · prepared ' +
      escapeHtml(new Date().toLocaleDateString()) + '</p>' + body +
      '<script>window.onload=function(){setTimeout(function(){window.print();},400);};<\/script>' +
      '</body></html>';

    var win = window.open('', '_blank');
    if (!win) return toast('Your browser blocked the pop-up. Allow pop-ups for this page and retry.', true);
    win.document.write(html);
    win.document.close();
  }

  /* ------------------------------------------------------------------ *
   * Import
   * ------------------------------------------------------------------ */

  function parseCsv(text) {
    var rows = [];
    var row = [];
    var value = '';
    var inQuotes = false;

    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { value += '"'; i++; }
          else inQuotes = false;
        } else value += ch;
        continue;
      }
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(value); value = ''; }
      else if (ch === '\r') { /* handled by \n */ }
      else if (ch === '\n') { row.push(value); rows.push(row); row = []; value = ''; }
      else value += ch;
    }
    if (value !== '' || row.length) { row.push(value); rows.push(row); }
    return rows;
  }

  /** Maps a sheet's rows to objects keyed by lower-cased header name. */
  function rowsToObjects(rows) {
    if (!rows || !rows.length) return [];
    var headerIndex = -1;
    for (var i = 0; i < rows.length && i < 10; i++) {
      var joined = (rows[i] || []).join('|').toLowerCase();
      if (/\bid\b/.test(joined) && /(title|name)/.test(joined)) { headerIndex = i; break; }
    }
    if (headerIndex < 0) return [];

    var headers = rows[headerIndex].map(function (h) { return String(h || '').trim().toLowerCase(); });
    return rows.slice(headerIndex + 1)
      .filter(function (row) {
        return (row || []).some(function (cell) { return String(cell || '').trim() !== ''; });
      })
      .map(function (row) {
        var obj = {};
        headers.forEach(function (header, index) {
          if (header) obj[header] = String(row[index] == null ? '' : row[index]).trim();
        });
        return obj;
      });
  }

  function isEventSheet(objects) {
    return objects.length > 0 && ('title' in objects[0] || 'date' in objects[0]);
  }

  /**
   * Applies imported people and events onto state.
   * Records match by ID; people additionally match by name so a name typed
   * straight into Excel attaches to the right person instead of duplicating.
   */
  function applyImport(importedPeople, importedEvents, mode) {
    if (mode === 'replace') {
      state.people = [];
      state.events = [];
    }

    var added = { people: 0, events: 0 };
    var updated = { people: 0, events: 0 };

    function findPersonByName(name) {
      var lower = name.toLowerCase();
      return state.people.filter(function (p) {
        return String(p.name || '').toLowerCase() === lower;
      })[0] || null;
    }

    importedPeople.forEach(function (incoming) {
      var existing = (incoming.id && personById(incoming.id)) || findPersonByName(incoming.name || '');
      if (existing) {
        Object.keys(incoming).forEach(function (key) {
          if (key !== 'id' && incoming[key] !== '' && incoming[key] != null) existing[key] = incoming[key];
        });
        updated.people++;
      } else {
        state.people.push({
          id: incoming.id || newId('per'),
          name: incoming.name || 'Unnamed',
          relationship: incoming.relationship || '',
          birthday: incoming.birthday || '',
          notes: incoming.notes || '',
          photoId: incoming.photoId || null
        });
        added.people++;
      }
    });

    importedEvents.forEach(function (incoming) {
      // Resolve people by name, creating any that are new.
      var personIds = (incoming.personNames || []).map(function (name) {
        var person = findPersonByName(name);
        if (!person) {
          person = { id: newId('per'), name: name, relationship: '', birthday: '', notes: '', photoId: null };
          state.people.push(person);
          added.people++;
        }
        return person.id;
      });
      if (incoming.personIds) {
        incoming.personIds.forEach(function (id) {
          if (personById(id) && personIds.indexOf(id) === -1) personIds.push(id);
        });
      }

      var record = {
        id: incoming.id || newId('evt'),
        title: incoming.title || 'Untitled',
        date: normalizeDate(incoming.date),
        category: incoming.category || '',
        personIds: personIds,
        location: incoming.location || '',
        description: incoming.description || '',
        tags: incoming.tags || [],
        mood: incoming.mood || '',
        favorite: !!incoming.favorite,
        // Keep only photo IDs this browser actually holds.
        photoIds: (incoming.photoIds || []).filter(function (id) { return LifeStorage.hasPhoto(id); }),
        createdAt: incoming.createdAt || new Date().toISOString(),
        updatedAt: incoming.updatedAt || new Date().toISOString()
      };

      var index = state.events.findIndex(function (existing) { return existing.id === record.id; });
      if (index >= 0) {
        // Photos live only in the browser, so never let a spreadsheet drop them.
        if (!record.photoIds.length) record.photoIds = state.events[index].photoIds || [];
        record.createdAt = state.events[index].createdAt || record.createdAt;
        state.events[index] = record;
        updated.events++;
      } else {
        state.events.push(record);
        added.events++;
      }
    });

    return { added: added, updated: updated };
  }

  function objectsToEvents(objects) {
    return objects.map(function (row) {
      return {
        id: row.id || '',
        title: row.title || '',
        date: row.date || '',
        category: row.category || '',
        personNames: splitList(row.people || row.person || ''),
        location: row.place || row.location || '',
        description: row.story || row.description || row.notes || '',
        tags: splitList(row.tags || ''),
        mood: row.mood || '',
        favorite: isTruthy(row.favourite || row.favorite || ''),
        photoIds: splitList(row.photoids || row['photo ids'] || ''),
        createdAt: row.created || '',
        updatedAt: row.updated || ''
      };
    });
  }

  function objectsToPeople(objects) {
    return objects.map(function (row) {
      return {
        id: row.id || '',
        name: row.name || '',
        relationship: row.relationship || '',
        birthday: normalizeDate(row.birthday || ''),
        notes: row.notes || '',
        photoId: row.photoid || row['photo id'] || ''
      };
    });
  }

  async function importJson(text, mode) {
    var payload = JSON.parse(text);
    if (!payload || (!Array.isArray(payload.events) && !Array.isArray(payload.people))) {
      throw new Error('That JSON file does not look like a Life Events backup.');
    }

    // Restore photos first so events can reference them.
    var photos = payload.photos || {};
    var restored = 0;
    for (var id in photos) {
      if (Object.prototype.hasOwnProperty.call(photos, id) && !LifeStorage.hasPhoto(id)) {
        await LifeStorage.putPhoto(id, photos[id]);
        restored++;
      }
    }

    var people = (payload.people || []).map(function (p) {
      return {
        id: p.id || '', name: p.name || '', relationship: p.relationship || '',
        birthday: p.birthday || '', notes: p.notes || '', photoId: p.photoId || ''
      };
    });
    var events = (payload.events || []).map(function (e) {
      return {
        id: e.id || '', title: e.title || '', date: e.date || '', category: e.category || '',
        personNames: [], personIds: e.personIds || [], location: e.location || '',
        description: e.description || '', tags: e.tags || [], mood: e.mood || '',
        favorite: !!e.favorite, photoIds: e.photoIds || [],
        createdAt: e.createdAt || '', updatedAt: e.updatedAt || ''
      };
    });

    var result = applyImport(people, events, mode);
    result.restoredPhotos = restored;
    return result;
  }

  async function importFile(file, mode) {
    var name = file.name.toLowerCase();

    if (/\.json$/.test(name)) {
      return importJson(await file.text(), mode);
    }

    var peopleObjects = [];
    var eventObjects = [];

    if (/\.csv$/.test(name)) {
      var objects = rowsToObjects(parseCsv(await file.text()));
      if (!objects.length) throw new Error('No recognisable header row found in that CSV.');
      if (isEventSheet(objects)) eventObjects = objects;
      else peopleObjects = objects;
    } else if (/\.xlsx$/.test(name)) {
      var sheets = await XlsxLite.read(await file.arrayBuffer());
      sheets.forEach(function (sheet) {
        var objects = rowsToObjects(sheet.rows);
        if (!objects.length) return;
        if (/people|person/i.test(sheet.name) || (!isEventSheet(objects) && 'name' in objects[0])) {
          peopleObjects = peopleObjects.concat(objects);
        } else if (isEventSheet(objects)) {
          eventObjects = eventObjects.concat(objects);
        }
      });
      if (!peopleObjects.length && !eventObjects.length) {
        throw new Error('No Events or People sheet found in that workbook.');
      }
    } else {
      throw new Error('Unsupported file type. Choose a .xlsx, .json or .csv file.');
    }

    return applyImport(objectsToPeople(peopleObjects), objectsToEvents(eventObjects), mode);
  }

  async function handleImportFile(file) {
    var mode = document.querySelector('input[name="import-mode"]:checked').value;
    if (mode === 'replace' && (state.events.length || state.people.length)) {
      if (!confirm('Replace everything currently on this device with the contents of this file?')) return;
    }

    var status = $('import-status');
    status.textContent = 'Reading ' + file.name + '…';

    try {
      var result = await importFile(file, mode);
      persist();
      renderAll();

      var parts = [
        result.added.events + ' event' + (result.added.events === 1 ? '' : 's') + ' added',
        result.updated.events + ' updated',
        result.added.people + ' new ' + (result.added.people === 1 ? 'person' : 'people')
      ];
      if (result.restoredPhotos) parts.push(result.restoredPhotos + ' photos restored');

      status.textContent = 'Imported ' + file.name + ' — ' + parts.join(', ') + '.';
      toast('Import finished.');
    } catch (err) {
      status.textContent = 'Import failed: ' + err.message;
      toast(err.message, true);
    }
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */

  function bindTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('is-active'); });
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('is-active'); });
        tab.classList.add('is-active');
        $('panel-' + tab.dataset.tab).classList.add('is-active');
      });
    });
  }

  function bindFilters() {
    var search = $('filter-search');
    var debounce = null;
    search.addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        state.filters.search = search.value.trim();
        renderTimeline();
      }, 160);
    });

    [['filter-person', 'person'], ['filter-category', 'category'], ['filter-year', 'year'], ['filter-sort', 'sort']]
      .forEach(function (pair) {
        $(pair[0]).addEventListener('change', function () {
          state.filters[pair[1]] = this.value;
          renderTimeline();
          if (pair[1] !== 'sort') return;
          renderGallery();
        });
      });

    $('filter-favorites').addEventListener('change', function () {
      state.filters.favorites = this.checked;
      renderTimeline();
    });

    $('filter-reset').addEventListener('click', function () {
      state.filters = { search: '', person: '', category: '', year: '', favorites: false, sort: 'date-desc' };
      $('filter-search').value = '';
      $('filter-favorites').checked = false;
      $('filter-sort').value = 'date-desc';
      renderFilterOptions();
      renderTimeline();
    });
  }

  function bindModals() {
    document.querySelectorAll('[data-close]').forEach(function (button) {
      button.addEventListener('click', function () {
        closeModal(button.closest('.modal').id);
      });
    });

    document.querySelectorAll('.modal').forEach(function (modal) {
      modal.addEventListener('mousedown', function (e) {
        if (e.target === modal) closeModal(modal.id);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('lightbox').hidden) { $('lightbox').hidden = true; return; }
      document.querySelectorAll('.modal').forEach(function (modal) { modal.hidden = true; });
    });
  }

  function bindLightbox() {
    document.addEventListener('click', function (e) {
      var img = e.target.closest('img[data-zoom]');
      if (!img) return;
      $('lightbox-img').src = img.src;
      $('lightbox').hidden = false;
    });
    $('lightbox').addEventListener('click', function () { this.hidden = true; });
  }

  function bindRecordClicks() {
    $('timeline').addEventListener('click', function (e) {
      if (e.target.closest('img[data-zoom]')) return; // zooming, not editing
      var card = e.target.closest('[data-event-id]');
      if (card) openEventEditor(card.getAttribute('data-event-id'));
    });

    $('people-grid').addEventListener('click', function (e) {
      var card = e.target.closest('[data-person-id]');
      if (card) openPersonEditor(card.getAttribute('data-person-id'));
    });
  }

  function bindForms() {
    $('new-event-btn').addEventListener('click', function () { openEventEditor(null); });
    $('new-person-btn').addEventListener('click', function () { openPersonEditor(null); });
    $('event-form').addEventListener('submit', saveEventFromForm);
    $('person-form').addEventListener('submit', savePersonFromForm);
    $('event-delete').addEventListener('click', deleteCurrentEvent);
    $('person-delete').addEventListener('click', deleteCurrentPerson);

    $('event-photos').addEventListener('change', async function () {
      var input = this;
      input.disabled = true;
      await addPhotoFiles(input.files, function (id) {
        draft.photoIds.push(id);
        refreshEventPhotoStrip();
      });
      input.disabled = false;
      input.value = '';
    });

    $('person-photo').addEventListener('change', async function () {
      var input = this;
      input.disabled = true;
      await addPhotoFiles(input.files, function (id) {
        draft.personPhotoId = id;
        refreshPersonPhotoStrip();
      });
      input.disabled = false;
      input.value = '';
    });
  }

  function bindDataTab() {
    $('export-xlsx').addEventListener('click', exportXlsx);
    $('export-json').addEventListener('click', exportJson);
    $('export-csv').addEventListener('click', exportCsv);
    $('export-html').addEventListener('click', exportPrintable);

    $('import-file').addEventListener('change', async function () {
      if (this.files && this.files[0]) await handleImportFile(this.files[0]);
      this.value = '';
    });

    $('prune-photos').addEventListener('click', async function () {
      var removed = await LifeStorage.prunePhotos(usedPhotoIds());
      renderStats();
      toast(removed ? 'Removed ' + removed + ' unused photo(s).' : 'No unused photos found.');
    });

    $('clear-all').addEventListener('click', async function () {
      if (!confirm('Erase every person, event and photo stored in this browser?\n\nExport a backup first — this cannot be undone.')) return;
      if (!confirm('Really erase everything?')) return;
      await LifeStorage.clearAll();
      state.people = [];
      state.events = [];
      renderAll();
      toast('Everything erased.');
    });
  }

  /* ------------------------------------------------------------------ *
   * Start
   * ------------------------------------------------------------------ */

  (async function init() {
    await LifeStorage.init();

    var records = LifeStorage.loadRecords();
    if (records) {
      state.people = records.people;
      state.events = records.events;
    }

    bindTabs();
    bindFilters();
    bindModals();
    bindLightbox();
    bindRecordClicks();
    bindForms();
    bindDataTab();
    renderAll();

    if (!LifeStorage.isUsingIndexedDb()) {
      toast('Photo storage is limited in this mode. See the Import & Export tab for details.', true);
    }
  })();
})();
