// CineLenz — title suggestions for the manual search boxes.
//
// Self-contained add-on: it never calls into content.js. It watches for the
// result card, finds the existing manual-search input, and shows a dropdown of
// matching titles as the user types. Picking one fills the input and presses
// the card's own Search button, so all existing lookup/render logic is reused.
(() => {
  'use strict';

  if (window.__cineLenzSuggestLoaded) return;
  window.__cineLenzSuggestLoaded = true;

  const CARD_CLASS = 'imdb-lens-card';
  const INPUT_ID = 'imdb-lens-manual-input';
  const BTN_ID = 'imdb-lens-manual-btn';

  const MIN_CHARS = 3;      // don't query for 1–2 letters (too broad, wastes quota)
  const DEBOUNCE_MS = 350;  // wait for a typing pause before calling the API
  const MAX_ITEMS = 5;
  const CACHE_MAX = 60;
  const TMDB_THUMB = 'https://image.tmdb.org/t/p/w92';

  // ─── Settings (read straight from storage; no message plumbing) ───
  const SECRET_SETTING_KEYS = ['omdbApiKey', 'tmdbApiKey', 'ocrSpaceApiKey', 'geminiApiKey'];
  function readCineLenzSettings(keys, callback) {
    chrome.storage.local.get(SECRET_SETTING_KEYS, (localSettings) => {
      chrome.storage.sync.get(keys, (syncSettings) => {
        const migrated = {};
        SECRET_SETTING_KEYS.forEach((key) => {
          if (localSettings[key] === undefined && syncSettings[key] !== undefined) migrated[key] = syncSettings[key];
        });
        const finish = () => callback({ ...syncSettings, ...localSettings, ...migrated });
        const legacyKeys = SECRET_SETTING_KEYS.filter((key) => syncSettings[key] !== undefined);
        if (Object.keys(migrated).length) {
          chrome.storage.local.set(migrated, () => chrome.storage.sync.remove(legacyKeys, finish));
        } else if (legacyKeys.length) {
          chrome.storage.sync.remove(legacyKeys, finish);
        } else {
          finish();
        }
      });
    });
  }

  let omdbKey = '';
  let tmdbKey = '';
  let source = 'omdb';

  function loadSettings() {
    try {
      readCineLenzSettings(['omdbApiKey', 'tmdbApiKey', 'dataSource'], (res) => {
        omdbKey = (res && res.omdbApiKey) || '';
        tmdbKey = (res && res.tmdbApiKey) || '';
        source = res && res.dataSource === 'tmdb' ? 'tmdb' : 'omdb';
      });
    } catch { /* extension context invalidated (e.g. reloaded) */ }
  }
  loadSettings();
  try {
    chrome.storage.onChanged.addListener((_changes, area) => {
      if (area === 'sync' || area === 'local') loadSettings();
    });
  } catch { /* see above */ }

  // ─── Providers → [{ title, year, type, poster }] ───────────────────
  const cache = new Map();

  function cacheSet(key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function omdbSuggest(query, signal) {
    if (!omdbKey) return { items: [] };
    const res = await fetch(
      'https://www.omdbapi.com/?s=' + encodeURIComponent(query) + '&apikey=' + encodeURIComponent(omdbKey),
      { signal }
    );
    const data = await res.json();
    if (data.Response !== 'True' || !Array.isArray(data.Search)) {
      const err = data.Error || '';
      if (/invalid api key/i.test(err)) return { items: [], note: 'Check your OMDb API key.' };
      if (/limit/i.test(err)) return { items: [], note: 'OMDb daily limit reached.', transient: true };
      return { items: [] }; // "Movie not found!" / "Too many results." → just no suggestions
    }
    const seen = new Set();
    const items = [];
    for (const m of data.Search) {
      if ((m.Type !== 'movie' && m.Type !== 'series') || seen.has(m.imdbID)) continue;
      seen.add(m.imdbID);
      items.push({
        id: m.imdbID,
        title: m.Title,
        year: m.Year || '',
        type: m.Type === 'series' ? 'Series' : 'Movie',
        poster: m.Poster && m.Poster !== 'N/A' ? m.Poster : ''
      });
      if (items.length >= MAX_ITEMS) break;
    }
    return { items };
  }

  async function tmdbSuggest(query, signal) {
    if (!tmdbKey) return { items: [] };
    const res = await fetch(
      'https://api.themoviedb.org/3/search/multi?query=' + encodeURIComponent(query) + '&api_key=' + encodeURIComponent(tmdbKey),
      { signal }
    );
    const data = await res.json();
    if (data && data.success === false) return { items: [], note: 'Check your TMDB API key.' };
    const results = data && Array.isArray(data.results) ? data.results : [];
    const items = results
      .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
      .slice(0, MAX_ITEMS)
      .map((r) => {
        const isTv = r.media_type === 'tv';
        const date = (isTv ? r.first_air_date : r.release_date) || '';
        return {
          id: r.media_type + '-' + r.id, // same composite format content.js uses
          title: (isTv ? (r.name || r.original_name) : (r.title || r.original_title)) || '',
          year: date.slice(0, 4),
          type: isTv ? 'Series' : 'Movie',
          poster: r.poster_path ? TMDB_THUMB + r.poster_path : ''
        };
      })
      .filter((m) => m.title);
    return { items };
  }

  function fetchSuggestions(query, signal) {
    return source === 'tmdb' ? tmdbSuggest(query, signal) : omdbSuggest(query, signal);
  }

  // ─── Press tracking ────────────────────────────────────────────────
  // Pressing another control in the card (e.g. the Search button) blurs the
  // input. Collapsing the list at that instant shifts the layout, so the button
  // moves out from under the pointer and the click is lost. While a press that
  // started inside a card is in flight, collapses are queued until it finishes.
  let pressInProgress = false;
  const pendingCollapses = new Set();

  function flushPendingCollapses() {
    pressInProgress = false;
    const queued = Array.from(pendingCollapses);
    pendingCollapses.clear();
    queued.forEach((collapse) => collapse());
  }

  document.addEventListener('mousedown', (e) => {
    flushPendingCollapses(); // a stale queue from a press that never released
    pressInProgress = !!(e.target && e.target.closest && e.target.closest('.' + CARD_CLASS));
  }, true);
  // The click event is dispatched right after mouseup; collapse once it has been delivered.
  document.addEventListener('mouseup', () => { setTimeout(flushPendingCollapses, 0); }, true);

  // ─── Per-input controller ──────────────────────────────────────────
  const controllers = new WeakMap(); // input element → controller
  let listCounter = 0;

  function createController(input) {
    const list = document.createElement('div');
    list.className = 'cinelenz-suggest';
    list.id = 'cinelenz-suggest-' + (++listCounter);
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    input.insertAdjacentElement('afterend', list);

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', 'false');

    let timer = null;
    let abort = null;
    let seq = 0;
    let items = [];
    let active = -1;
    let lastQuery = '';

    const isOpen = () => !list.hidden && items.length > 0;

    function hide() {
      // Hide instead of removing nodes: a click on a suggestion is still
      // bubbling to the card's outside-click handler, and a detached target
      // would make that handler think the click landed outside the card.
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }

    function setActive(index) {
      active = index;
      const nodes = list.querySelectorAll('.cinelenz-suggest-item');
      nodes.forEach((node, i) => {
        const on = i === index;
        node.classList.toggle('is-active', on);
        node.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
          input.setAttribute('aria-activedescendant', node.id);
          if (node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
        }
      });
      if (index < 0) input.removeAttribute('aria-activedescendant');
    }

    function buildItem(item, index) {
      const row = document.createElement('div');
      row.className = 'cinelenz-suggest-item';
      row.id = list.id + '-opt-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');

      const thumb = document.createElement('div');
      thumb.className = 'cinelenz-suggest-thumb';
      if (item.poster) {
        const img = document.createElement('img');
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.src = item.poster;
        img.addEventListener('error', () => img.remove());
        thumb.appendChild(img);
      }

      const text = document.createElement('div');
      text.className = 'cinelenz-suggest-text';
      const title = document.createElement('div');
      title.className = 'cinelenz-suggest-title';
      title.textContent = item.title;
      const meta = document.createElement('div');
      meta.className = 'cinelenz-suggest-meta';
      meta.textContent = item.year ? item.year + ' · ' + item.type : item.type;
      text.append(title, meta);

      row.append(thumb, text);
      row.addEventListener('mousemove', () => { if (active !== index) setActive(index); });
      row.addEventListener('click', () => choose(index));
      return row;
    }

    function show(result, query) {
      items = result.items || [];
      lastQuery = query;
      list.textContent = '';
      active = -1;
      if (!items.length && !result.note) { hide(); return; }
      if (items.length) {
        items.forEach((item, i) => list.appendChild(buildItem(item, i)));
      } else {
        const note = document.createElement('div');
        note.className = 'cinelenz-suggest-note';
        note.textContent = result.note;
        list.appendChild(note);
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    // Fallback: fill the box and press the card's own Search button.
    function searchByTitle(item) {
      input.value = item.title;
      const btn = input.closest('.imdb-lens-manual')?.querySelector('#' + BTN_ID);
      if (btn && !btn.disabled) btn.click();
      else input.focus();
    }

    function choose(index) {
      const item = items[index];
      if (!item) return;
      clearTimeout(timer);
      if (abort) abort.abort();
      seq += 1; // drop any response still in flight
      hide();

      // Preferred: open the exact title that was picked, by ID, so two films
      // with the same name (e.g. a 2023 and a 2019 "Poor Things") can't get mixed up.
      const card = input.closest('.' + CARD_CLASS);
      const bridge = window.__cineLenzBridge;
      if (item.id && card && bridge && typeof bridge.openById === 'function') {
        const manual = input.closest('.imdb-lens-manual');
        const status = manual && manual.querySelector('#imdb-lens-manual-status');
        const btn = manual && manual.querySelector('#' + BTN_ID);
        input.value = item.title;
        if (btn) btn.disabled = true;
        if (status) { status.textContent = 'Opening ' + item.title + '...'; status.className = 'imdb-lens-manual-status'; }
        bridge.openById(card, item.id, item.title).then((opened) => {
          if (opened) return; // the card re-rendered with the result
          if (btn) btn.disabled = false;
          if (status) status.textContent = '';
          searchByTitle(item);
        }).catch(() => {
          if (btn) btn.disabled = false;
          if (status) status.textContent = '';
          searchByTitle(item);
        });
        return;
      }
      searchByTitle(item);
    }

    async function run(query) {
      if (!input.isConnected) return;
      if (abort) abort.abort();
      abort = new AbortController();
      const mySeq = ++seq;
      try {
        const result = await fetchSuggestions(query, abort.signal);
        if (mySeq !== seq || !input.isConnected) return;
        if (!result.transient) cacheSet(source + '|' + query.toLowerCase(), result);
        if (input.value.trim() !== query) return; // user kept typing; a newer lookup owns the list
        show(result, query);
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        if (mySeq === seq) hide();
      }
    }

    function schedule() {
      clearTimeout(timer);
      const query = input.value.trim();
      if (query.length < MIN_CHARS) {
        if (abort) abort.abort();
        seq += 1;
        hide();
        return;
      }
      const cached = cache.get(source + '|' + query.toLowerCase());
      if (cached) { show(cached, query); return; }
      timer = setTimeout(() => run(query), DEBOUNCE_MS);
    }

    // Pressing a suggestion must not move focus out of the input: the blur
    // handler below hides the list, and a list that disappears on mousedown
    // never receives the click that follows.
    list.addEventListener('mousedown', (e) => e.preventDefault());

    input.addEventListener('input', schedule);
    input.addEventListener('blur', () => {
      if (pressInProgress) pendingCollapses.add(hide); // wait for the click to land first
      else hide();
    });

    return {
      // Called from the card-level capture listener, so it runs before the
      // input's own handlers (e.g. their Enter-to-search) and can pre-empt them.
      onKeyDown(e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          if (!isOpen()) {
            if (items.length && input.value.trim() === lastQuery) {
              list.hidden = false;
              input.setAttribute('aria-expanded', 'true');
              e.preventDefault();
              e.stopPropagation();
            }
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          const step = e.key === 'ArrowDown' ? 1 : -1;
          const next = active < 0
            ? (step === 1 ? 0 : items.length - 1)
            : (active + step + items.length) % items.length;
          setActive(next);
        } else if (e.key === 'Enter' && isOpen() && active >= 0) {
          e.preventDefault();
          e.stopPropagation();
          choose(active);
        } else if (e.key === 'Escape' && !list.hidden) {
          // Close the list first; a second Esc (list now hidden) closes the card.
          e.preventDefault();
          e.stopPropagation();
          hide();
        }
      }
    };
  }

  // ─── Wiring: find cards and their (re-rendered) manual inputs ──────
  function scan(card) {
    const input = card.querySelector('#' + INPUT_ID);
    if (input && !controllers.has(input)) controllers.set(input, createController(input));
  }

  function wireCard(card) {
    if (card.dataset.cineSuggest === '1') { scan(card); return; }
    card.dataset.cineSuggest = '1';

    // One set of listeners per card, routed to whichever input is current.
    card.addEventListener('keydown', (e) => {
      const ctl = controllers.get(e.target);
      if (ctl) ctl.onKeyDown(e);
    }, true);

    // Keep keystrokes typed in the box from reaching the page's own hotkeys
    // (e.g. single-key shortcuts on video sites). Escape is left alone so it
    // can still reach the existing "close card" handler.
    ['keydown', 'keyup', 'keypress'].forEach((type) => {
      card.addEventListener(type, (e) => {
        if (controllers.has(e.target) && e.key !== 'Escape') e.stopPropagation();
      });
    });

    // The card body is re-rendered (loading → manual box → result), which
    // creates fresh inputs each time.
    new MutationObserver(() => scan(card)).observe(card, { childList: true, subtree: true });
    scan(card);
  }

  function start() {
    if (!document.body) return;
    // Cards are appended directly to <body>, so a shallow observer is enough
    // and stays cheap on busy pages.
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === 1 && node.classList.contains(CARD_CLASS)) wireCard(node);
        });
      }
    }).observe(document.body, { childList: true });
    document.querySelectorAll('.' + CARD_CLASS).forEach(wireCard);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
