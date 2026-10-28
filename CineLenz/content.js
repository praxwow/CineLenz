(() => {
  'use strict';

  const EXT_VERSION = '1.0.0';
  if (window.__imdbLensVersion && window.__imdbLensVersion !== EXT_VERSION) {
    window.location.reload();
    return;
  }
  window.__imdbLensVersion = EXT_VERSION;

  let isSelecting = false;
  let isScanMode = false;
  let startX = 0, startY = 0;
  let overlay = null;
  let scanOverlay = null;
  let scanBadge = null;
  let apiKey = '';
  let tmdbApiKey = '';
  let dataSource = 'omdb'; // 'omdb' | 'tmdb' — only one provider is active at a time
  let ocrSpaceApiKey = '';
  let darkMode = true;
  let stickyMode = false;
  let textSelectEnabled = true;
  let comboArmed = true;      // ready to fire the next toggle once combo is fully released
  let ocrEngine = 'local'; // 'local' (on-device PP-OCR) | 'gemini'
  let geminiApiKey = '';
  let geminiModel = 'gemini-2.5-flash-lite';

  // ─── Activation combo ──────────────────────────────────
  // Mac keyboards route Ctrl+Alt combos through OS-level input-source
  // switching on some layouts, so Cmd (metaKey) + Option (altKey) is the
  // safer default there; Windows/Linux keep the original Ctrl+Alt+Z.
  // The combo itself is fully user-customizable from the popup (recorded
  // via a real keydown, so it's never limited to this default set).
  const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgentData?.platform || '');

  function defaultCombo() {
    return IS_MAC
      ? { ctrl: false, alt: true, shift: false, meta: true, key: 'z' }
      : { ctrl: true, alt: true, shift: false, meta: false, key: 'z' };
  }

  let activationCombo = defaultCombo();

  function formatComboLabel(combo) {
    const parts = [];
    if (combo.ctrl) parts.push('Ctrl');
    if (combo.meta) parts.push(IS_MAC ? 'Cmd' : 'Win');
    if (combo.alt) parts.push(IS_MAC ? 'Option' : 'Alt');
    if (combo.shift) parts.push('Shift');
    parts.push((combo.key || '').toUpperCase());
    return parts.join('+');
  }

  const CARD_CLASS = 'imdb-lens-card';
  const OVERLAY_CLASS = 'imdb-lens-overlay';
  const SELECT_BTN_CLASS = 'imdb-lens-select-btn';

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

  function loadSettings() {
    readCineLenzSettings(
      ['omdbApiKey', 'tmdbApiKey', 'dataSource', 'ocrSpaceApiKey', 'darkMode', 'stickyMode', 'textSelectEnabled', 'ocrEngine', 'geminiApiKey', 'geminiModel', 'activationCombo'],
      (res) => {
        apiKey = res.omdbApiKey || '';
        tmdbApiKey = res.tmdbApiKey || '';
        dataSource = res.dataSource === 'tmdb' ? 'tmdb' : 'omdb';
        ocrSpaceApiKey = res.ocrSpaceApiKey || '';
        darkMode = res.darkMode !== false;
        stickyMode = !!res.stickyMode;
        textSelectEnabled = res.textSelectEnabled !== false;
        ocrEngine = res.ocrEngine === 'gemini' ? 'gemini' : 'local';
        geminiApiKey = res.geminiApiKey || '';
        geminiModel = res.geminiModel || 'gemini-2.5-flash-lite';
        activationCombo = res.activationCombo && res.activationCombo.key
          ? res.activationCombo
          : defaultCombo();
      }
    );
  }
  loadSettings();

  function activeApiKey() {
    return dataSource === 'tmdb' ? tmdbApiKey : apiKey;
  }

  function providerLabel() {
    return dataSource === 'tmdb' ? 'TMDB' : 'IMDb';
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'settingsUpdated') loadSettings();
    if (msg.action === 'darkModeChanged') darkMode = msg.value;
    if (msg.action === 'stickyModeChanged') {
      stickyMode = msg.value;
      // Switching modes mid-use could leave the crosshair stuck on; reset cleanly.
      comboArmed = true;
      exitScanMode();
    }
    if (msg.action === 'textSelectModeChanged') {
      textSelectEnabled = msg.value;
      if (!textSelectEnabled) removeSelectBtn();
    }
    if (msg.action === 'activationComboChanged') {
      activationCombo = msg.value && msg.value.key ? msg.value : defaultCombo();
      // A combo change mid-use could leave a stale key/scan-mode state
      // (e.g. the old combo's key still marked "held"); reset cleanly.
      comboKeyHeld = false;
      comboArmed = true;
      exitScanMode();
    }
  });

  // For suggest.js. Content scripts of one extension share an isolated world,
  // so this is not reachable from page scripts. Opens the exact title picked
  // from the autocomplete list, by ID.
  window.__cineLenzBridge = {
    async openById(card, id, query) {
      const movie = await fetchMovieById(id);
      if (!movie) return false;
      if (card.isConnected) renderMovieCard(card, movie, query);
      return true;
    }
  };

  // Right-click lookup (sent by background.js). Deliberately ignores
  // textSelectEnabled: that toggle only controls the floating Rate button.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.action !== 'contextMenuLookup') return;
    const text = String(msg.text || '').trim().replace(/\s+/g, ' ');
    // Anchor the card to the selection when it's visible in this frame;
    // otherwise (selection inside a text box or an iframe) use a neutral spot.
    let x = Math.max(12, Math.round((window.innerWidth - 340) / 2));
    let y = 80;
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        x = rect.left;
        y = rect.bottom + 8;
      }
    }
    removeSelectBtn(); // don't leave the floating button up next to the card
    if (text.length < 2) return;
    if (text.length > 100) {
      showErrorCard(x, y, 'That selection is too long to be a title. Select just the movie or show name.');
      return;
    }
    processTextSelection(text, x, y);
  });

  // ─── Key Tracking ──────────────────────────────────────
  // Ctrl/Alt/Shift/Meta state is read directly from the browser's own
  // e.ctrlKey / e.altKey / etc. flags on every event, rather than tracked
  // manually — manual tracking (e.g. a Set of "held" keys) can desync if
  // a keyup is ever missed (lost focus, OS-level key handling, etc.),
  // which is what made sticky mode's arm/disarm unreliable. Only the
  // combo's non-modifier key needs explicit hold-tracking below.
  let comboKeyHeld = false;

  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === activationCombo.key) comboKeyHeld = true;
    checkScanMode(e);
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === activationCombo.key) comboKeyHeld = false;
    checkScanMode(e);
  }, true);

  window.addEventListener('blur', () => {
    comboKeyHeld = false;
    comboArmed = true;
    exitScanMode();
  });

  function checkScanMode(e) {
    const active = isComboActive(e);

    if (!stickyMode) {
      if (active && !isScanMode) enterScanMode();
      if (!active && isScanMode) exitScanMode();
      return;
    }

    // Sticky mode: the combo is a TOGGLE, not a hold. Fire once when all 3
    // keys become pressed together, then wait for a full release before the
    // next press can toggle again — otherwise OS key-repeat while holding
    // would flip it back and forth continuously.
    if (active && comboArmed) {
      comboArmed = false;
      if (isScanMode) exitScanMode();
      else enterScanMode();
    } else if (!active) {
      comboArmed = true;
    }
  }

  // Exact match against every modifier (not just "these are down") so an
  // unrelated combo that happens to share a modifier with the user's
  // chosen shortcut can't accidentally trigger scan mode.
  function isComboActive(e) {
    return comboKeyHeld
      && !!e.ctrlKey === !!activationCombo.ctrl
      && !!e.altKey === !!activationCombo.alt
      && !!e.shiftKey === !!activationCombo.shift
      && !!e.metaKey === !!activationCombo.meta;
  }

  function enterScanMode() {
    isScanMode = true;
    getScanOverlay().style.display = 'block';
    const badge = getScanBadge();
    const comboLabel = formatComboLabel(activationCombo);
    badge.querySelector('.imdb-lens-scan-badge-text').textContent = stickyMode
      ? `Sticky mode locked — drag to select, press ${comboLabel} or Esc to release`
      : 'CineLenz Active — Drag to select poster';
    badge.style.display = 'flex';
  }

  function exitScanMode() {
    isScanMode = false;
    isSelecting = false;
    if (scanOverlay) scanOverlay.style.display = 'none';
    if (scanBadge) scanBadge.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
  }

  function getScanOverlay() {
    if (!scanOverlay) {
      scanOverlay = document.createElement('div');
      scanOverlay.className = 'imdb-lens-scan-overlay';
      scanOverlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        z-index: 2147483645; cursor: crosshair !important; display: none;
      `;
      document.body.appendChild(scanOverlay);
    }
    return scanOverlay;
  }

  function getScanBadge() {
    if (!scanBadge) {
      scanBadge = document.createElement('div');
      scanBadge.className = 'imdb-lens-scan-badge';
      scanBadge.innerHTML = `
        <span style="font-size:16px;">➕</span>
        <span class="imdb-lens-scan-badge-text">CineLenz Active — Drag to select poster</span>
      `;
      scanBadge.style.cssText = `
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 2147483646; background: #f5c518; color: #000;
        padding: 8px 18px; border-radius: 24px;
        font-family: 'Segoe UI', system-ui, sans-serif;
        font-size: 13px; font-weight: 600; display: none;
        align-items: center; gap: 8px;
        box-shadow: 0 4px 20px rgba(245,197,24,0.4);
        pointer-events: none; white-space: nowrap;
      `;
      document.body.appendChild(scanBadge);
    }
    return scanBadge;
  }

  function getOverlay() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = OVERLAY_CLASS;
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  // ─── Mouse Events on Scan Overlay ──────────────────────
  function initScanOverlayEvents() {
    const so = getScanOverlay();

    so.addEventListener('mousedown', (e) => {
      if (!isScanMode) return;
      if (e.target.closest('input, textarea, a, button, .imdb-lens-card')) return;

      isSelecting = true;
      startX = e.clientX;
      startY = e.clientY;

      const ov = getOverlay();
      ov.style.left = startX + 'px';
      ov.style.top = startY + 'px';
      ov.style.width = '0px';
      ov.style.height = '0px';
      ov.style.display = 'block';

      e.preventDefault();
      e.stopPropagation();
    }, true);

    so.addEventListener('mousemove', (e) => {
      if (!isSelecting) return;
      const ov = getOverlay();
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);

      ov.style.left = x + 'px';
      ov.style.top = y + 'px';
      ov.style.width = w + 'px';
      ov.style.height = h + 'px';
    }, true);

    so.addEventListener('mouseup', async (e) => {
      if (!isSelecting) return;
      isSelecting = false;

      const ov = getOverlay();
      ov.style.display = 'none';

      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);

      if (w < 30 || h < 30) return;

      if (!activeApiKey()) {
        showErrorCard(x + w, y, 'No ' + providerLabel() + ' API key. Click the extension icon to add one.');
        return;
      }

      await processSelection(x, y, w, h);
    }, true);
  }

  initScanOverlayEvents();

  // ─── Select Text → Rating Popup ────────────────────────
  // Lets someone highlight a title mentioned anywhere on the page (a
  // comment, a caption, a headline...) and get a small "Rate" button next
  // to the selection instead of having to screenshot/OCR a poster.
  let selectBtn = null;
  let lastSelectionText = '';

  function getSelectBtn() {
    if (!selectBtn) {
      selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = SELECT_BTN_CLASS;
      selectBtn.innerHTML = '🎬 <span>Rate</span>';
      selectBtn.style.display = 'none';
      document.body.appendChild(selectBtn);
      selectBtn.addEventListener('mousedown', (e) => {
        // Prevent this click from collapsing the text selection before we
        // read it inside the click handler below.
        e.preventDefault();
        e.stopPropagation();
      });
      selectBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = lastSelectionText;
        const rect = selectBtn.getBoundingClientRect();
        removeSelectBtn();
        if (text) processTextSelection(text, rect.left, rect.bottom + 8);
      });
    }
    return selectBtn;
  }

  function removeSelectBtn() {
    if (selectBtn) selectBtn.style.display = 'none';
    lastSelectionText = '';
  }

  function showSelectBtnNear(rect, text) {
    lastSelectionText = text;
    const btn = getSelectBtn();
    btn.style.display = 'flex';
    // Measure after becoming visible so offsetWidth/Height are accurate.
    const btnWidth = btn.offsetWidth || 90;
    const btnHeight = btn.offsetHeight || 30;
    let left = rect.left + (rect.width / 2) - (btnWidth / 2);
    let top = rect.top - btnHeight - 8;
    if (top < 4) top = rect.bottom + 8; // flip below the selection if it'd go off-screen above
    left = Math.max(4, Math.min(left, window.innerWidth - btnWidth - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - btnHeight - 4));
    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
  }

  function handleTextSelection() {
    if (!textSelectEnabled || isScanMode || isSelecting) return;
    // Let the browser finish settling the selection first.
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim().replace(/\s+/g, ' ') : '';
      if (!text || text.length < 2 || text.length > 100 || !sel.rangeCount) {
        removeSelectBtn();
        return;
      }
      // Don't offer to "rate" text selected inside our own UI (the card,
      // the manual-search input, or the button itself).
      const anchorNode = sel.anchorNode;
      const anchorEl = anchorNode && anchorNode.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
      if (anchorEl && (anchorEl.closest('.' + CARD_CLASS) || anchorEl.closest('.' + SELECT_BTN_CLASS))) {
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        removeSelectBtn();
        return;
      }
      showSelectBtnNear(rect, text);
    }, 10);
  }

  document.addEventListener('mouseup', handleTextSelection);
  document.addEventListener('selectionchange', () => {
    if (!selectBtn || selectBtn.style.display === 'none') return;
    const sel = window.getSelection();
    if (!sel || !sel.toString().trim()) removeSelectBtn();
  });
  document.addEventListener('mousedown', (e) => {
    if (selectBtn && selectBtn.style.display !== 'none' && !e.target.closest('.' + SELECT_BTN_CLASS)) {
      removeSelectBtn();
    }
  });

  async function processTextSelection(text, x, y) {
    if (!activeApiKey()) {
      showErrorCard(x, y, 'No ' + providerLabel() + ' API key. Click the extension icon to add one.');
      return;
    }
    const card = createCard(x, y);
    showLoading(card, 'Looking up "' + text + '" on ' + providerLabel() + '...');
    // A highlighted title can itself be letter-spaced styling (e.g. a
    // comment written as "A L I E N"), same as poster logos are.
    const collapsed = collapseLetterSpacing(text);
    const query = collapsed !== text ? collapsed : text;
    try {
      let movie = await searchMovieByQuery(query);
      if (!movie && query !== text) movie = await searchMovieByQuery(text);
      if (movie) {
        renderMovieCard(card, movie, query);
      } else {
        showManualInput(card, x, y, query, 'No ' + providerLabel() + ' match for "' + query + '". Try a different title:');
      }
    } catch (err) {
      showManualInput(card, x, y, text, 'Error: ' + (err.message || 'Unknown') + '. Try manually:');
    }
  }

  // ─── Main Processing Pipeline ──────────────────────────
  async function processSelection(x, y, w, h) {
    const card = createCard(x + w + 12, y);
    let currentGuess = '';
    const cancelOpts = { getText: () => currentGuess };
    showLoading(card, 'Taking screenshot...', cancelOpts);

    try {
      // Step 1: Screenshot
      const screenshot = await sendMessage({ action: 'captureTab' });
      if (isCancelled(card)) return;
      if (!screenshot || screenshot.error) {
        showManualInput(card, x + w + 12, y, '', 'Screenshot failed: ' + (screenshot?.error || 'unknown') + '. Try manually:');
        return;
      }

      showLoading(card, 'Cropping selection...', cancelOpts);

      // Step 2: Crop
      const croppedImage = await cropScreenshot(screenshot.dataUrl, x, y, w, h);
      if (isCancelled(card)) return;

      // Gemini path: a vision model reads the poster directly, so it
      // handles stylized/curvy/3D movie-logo typography that trips up
      // classic character-shape OCR. Tried first when
      // configured; falls through to the offline OCR pipeline below
      // if it errors out or can't find a match (e.g. rate limit hit).
      if (ocrEngine === 'gemini' && geminiApiKey) {
        showLoading(card, 'Reading poster with Gemini...', cancelOpts);

        // A tight title crop can be genuinely tiny in raw pixels (e.g. a
        // 140x30 selection) — fine for local OCR, but it starves a vision
        // model's tokenizer of detail on decorative/3D letterforms. Scale
        // small crops up before sending; never shrinks an already-large one.
        const geminiImage = await upscaleForGemini(croppedImage);
        if (isCancelled(card)) return;

        const geminiResult = await sendMessage({
          action: 'geminiOcr',
          imageDataUrl: geminiImage,
          apiKey: geminiApiKey,
          model: geminiModel
        });
        if (isCancelled(card)) return;

        if (!geminiResult.error && (geminiResult.guesses?.length || geminiResult.text)) {
          const rawGuesses = geminiResult.guesses?.length ? geminiResult.guesses : [geminiResult.text];
          currentGuess = cleanText(rawGuesses[0] || '');

          // Try each ranked guess in turn — the top guess on a hard 3D
          // font is often close-but-not-exact, so build one candidate
          // list from all of them and let the fuzzy matcher pick a hit
          // instead of giving up after guess #1 alone.
          let geminiCandidates = [];
          rawGuesses.forEach((g) => {
            geminiCandidates = mergeCandidates(geminiCandidates, extractTitleCandidates(cleanText(g)));
          });

          if (geminiCandidates.length) {
            showLoading(card, 'Matching possible titles against ' + providerLabel() + '...', cancelOpts);
            const geminiMatch = await searchMovieCandidates(geminiCandidates);
            if (isCancelled(card)) return;
            if (geminiMatch) {
              renderMovieCard(card, geminiMatch.movie, geminiMatch.query);
              return;
            }
          }
        } else if (geminiResult.error) {
          console.warn('[CineLenz] Gemini OCR failed, falling back to offline OCR:', geminiResult.error);
        }
        showLoading(card, 'Gemini had no confident match, falling back to offline OCR...', cancelOpts);
      }

      showLoading(card, 'Preparing the poster for offline OCR...', cancelOpts);
      const images = await createOcrImages(croppedImage);
      if (isCancelled(card)) return;

      showLoading(card, 'Loading the OCR engine...', cancelOpts);
      const ready = await sendMessage({ action: 'ensureOcrReady' });
      if (isCancelled(card)) return;
      if (ready && ready.error) throw new Error(ready.error);

      // Step 3: Offline OCR, split into a fast tier and a thorough
      // fallback tier. Most posters have one clean, well-lit title line
      // and get matched from the fast tier alone — so the extension can
      // skip the rest of the (slower) full sweep entirely for the common
      // case, instead of always running every pass before ever checking
      // whether it already has an answer.
      const { fast, thorough } = buildOcrAttempts(images);
      const totalPasses = fast.length + thorough.length;
      const acc = createCandidateAccumulator();
      const setStatus = (message) => {
        if (isCancelled(card)) return;
        currentGuess = acc.getBestText() || currentGuess;
        showLoading(card, message, cancelOpts);
      };

      acc.addReadings(await runOcrPasses(fast, setStatus, 0, totalPasses, card));
      if (isCancelled(card)) return;
      let candidates = acc.getCandidates();
      let detectedText = acc.getBestText();
      currentGuess = detectedText || currentGuess;
      let match = null;

      if (candidates.length) {
        showLoading(card, 'Matching possible titles against ' + providerLabel() + '...', cancelOpts);
        match = await searchMovieCandidates(candidates);
        if (isCancelled(card)) return;
      }

      // Tier 2 only runs if the fast tier didn't land a confident match —
      // covers stacked multi-line titles, inverted contrast, and other
      // harder cases the quick modes above can miss.
      if (!match) {
        acc.addReadings(await runOcrPasses(thorough, setStatus, fast.length, totalPasses, card));
        if (isCancelled(card)) return;
        candidates = acc.getCandidates();
        detectedText = acc.getBestText();
        currentGuess = detectedText || currentGuess;

        if (!candidates.length && !ocrSpaceApiKey) {
          showManualInput(card, x + w + 12, y, '', 'No title text was found. Try selecting just the title area, or enter it manually:');
          return;
        }

        if (candidates.length) {
          showLoading(card, 'Matching possible titles against ' + providerLabel() + '...', cancelOpts);
          match = await searchMovieCandidates(candidates);
          if (isCancelled(card)) return;
        }
      }

      // A user-supplied cloud key adds a genuinely independent OCR engine as
      // a fallback, without sending any image off-device by default.
      if (!match && ocrSpaceApiKey) {
        showLoading(card, 'Trying the optional cloud OCR fallback...', cancelOpts);
        const remote = await sendMessage({ action: 'ocr', imageDataUrl: croppedImage, apiKey: ocrSpaceApiKey });
        if (isCancelled(card)) return;
        if (!remote.error) {
          const remoteText = cleanText(remote.text || '');
          const remoteCandidates = extractTitleCandidates(remoteText);
          if (remoteText) detectedText = remoteText;
          candidates = mergeCandidates(candidates, remoteCandidates);
          match = await searchMovieCandidates(candidates);
          if (isCancelled(card)) return;
        }
      }

      if (!match) {
        showManualInput(card, x + w + 12, y, candidates[0] || detectedText, 'No ' + providerLabel() + ' match was found. Try a different title:');
        return;
      }

      renderMovieCard(card, match.movie, match.query);

    } catch (err) {
      if (isCancelled(card)) return;
      console.error('[CineLenz] Error:', err);
      showManualInput(card, x + w + 12, y, '', 'Error: ' + (err.message || 'Unknown') + '. Try manually:');
    }
  }

  // ─── Helper: Send message to background script ─────────
  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(response || {});
        }
      });
    });
  }

  // PP-OCR finds the text regions itself, so it prefers natural-looking
  // pixels over hard binarisation. Tier 1 ("fast"): the plain upscaled crop
  // and a contrast-stretched copy — enough for most posters. Tier 2
  // ("thorough"): binarised variants (bright-on-dark and dark-on-light),
  // only run if tier 1 doesn't produce a confident match.
  function buildOcrAttempts(images) {
    return {
      fast: [
        { image: images.original },
        { image: images.enhanced }
      ],
      thorough: [
        { image: images.adaptiveLight },  // bright/white strokes on a dark patch
        { image: images.adaptiveDark }    // dark strokes on a lighter patch
      ]
    };
  }

  // Backstop for a stalled engine: resolve with an error instead of waiting forever.
  function withTimeout(promise, ms, message) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: message, timedOut: true }), ms);
      promise.then((value) => { clearTimeout(timer); resolve(value); });
    });
  }

  async function runOcrPasses(attempts, setStatus, passOffset, totalPasses, card) {
    const readings = [];
    let lastError = '';
    for (let index = 0; index < attempts.length; index += 1) {
      if (card && isCancelled(card)) break; // user hit stop — don't keep grinding or re-render over the manual box
      const attempt = attempts[index];
      setStatus(`Reading poster text (pass ${passOffset + index + 1} of ${totalPasses})...`);
      const result = await withTimeout(sendMessage({
        action: 'ocrRecognize',
        imageDataUrl: attempt.image,
        psm: attempt.psm
      }), 30000, 'The OCR engine did not respond in time.');
      if (card && isCancelled(card)) break;
      if (result && result.error) {
        console.warn('[CineLenz] OCR pass failed:', result.error);
        lastError = result.error;
        if (result.timedOut) break; // a stalled engine won't answer the next pass either
        continue; // fall through to remaining passes
      }
      const text = cleanOcrText((result && result.text) || '');
      if (text) readings.push({ text, confidence: Number(result.confidence) || 0 });
    }
    // Every pass failed: say why, rather than pretending nothing was found.
    if (!readings.length && lastError && !(card && isCancelled(card))) throw new Error(lastError);
    return readings;
  }

  // Accumulates scored candidates across tiers so tier 2 (if it runs)
  // builds on tier 1's readings instead of starting over.
  function createCandidateAccumulator() {
    const candidateScores = new Map();
    const allReadings = [];
    return {
      addReadings(readings) {
        allReadings.push(...readings);
        readings.forEach(({ text, confidence }) => {
          // Use the *scored* variant here (not extractTitleCandidates), which
          // still carries each candidate's line-joining bonus. Dropping that
          // bonus (as a plain scoreTitleCandidate() recompute would) let a
          // short, high-confidence single line — e.g. a poster's big stylized
          // first word — regularly outrank the correctly-joined multi-line
          // title once results from several OCR passes were merged.
          extractTitleCandidatesScored(text).forEach(({ candidate, score: baseScore }) => {
            const key = normalizeTitle(candidate);
            const score = baseScore + (confidence * 0.35);
            if (!candidateScores.has(key) || candidateScores.get(key).score < score) {
              candidateScores.set(key, { candidate, score });
            }
          });
        });
      },
      getCandidates() {
        return [...candidateScores.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, 12)
          .map(({ candidate }) => candidate);
      },
      getBestText() {
        const best = [...allReadings].sort((a, b) => b.confidence - a.confidence)[0];
        return best ? best.text : '';
      }
    };
  }

  async function createOcrImages(dataUrl) {
    const image = await loadImage(dataUrl);
    const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
    // Small selections (a tight crop around small poster lettering) need a
    // much bigger upscale than large ones to give the OCR engine enough pixel
    // height per character. The old flat 3x cap left tiny text still tiny
    // after upscaling; this scales harder the smaller the crop is, then
    // clamps the final canvas so huge selections don't balloon in memory.
    const targetLongestSide = 2200;
    let scale = Math.max(1, targetLongestSide / longestSide);
    scale = Math.min(scale, 8);
    let width = Math.round(image.naturalWidth * scale);
    let height = Math.round(image.naturalHeight * scale);
    const maxCanvasSide = 3600;
    if (Math.max(width, height) > maxCanvasSide) {
      const shrink = maxCanvasSide / Math.max(width, height);
      width = Math.round(width * shrink);
      height = Math.round(height * shrink);
    }
    const original = document.createElement('canvas');
    original.width = width;
    original.height = height;
    const originalContext = original.getContext('2d', { willReadFrequently: true });
    originalContext.imageSmoothingEnabled = true;
    originalContext.imageSmoothingQuality = 'high';
    originalContext.drawImage(image, 0, 0, width, height);

    const source = originalContext.getImageData(0, 0, width, height);
    const total = width * height;
    const gray = new Float32Array(total);
    const histogram = new Uint32Array(256);
    for (let pixel = 0, i = 0; pixel < source.data.length; pixel += 4, i += 1) {
      const luminance = (source.data[pixel] * 0.299) + (source.data[pixel + 1] * 0.587) + (source.data[pixel + 2] * 0.114);
      gray[i] = luminance;
      histogram[Math.round(luminance)] += 1;
    }
    const low = histogramPercentile(histogram, 0.02, total);
    const high = histogramPercentile(histogram, 0.98, total);

    // Local-mean (adaptive) threshold via an integral image, so gradient /
    // beveled / embossed "3D" poster lettering — where lighting varies
    // across a single letter — doesn't get lost the way a single global
    // threshold loses it. Two polarities are produced since posters use
    // both dark text on a light patch and light/bright text on a dark
    // background about equally often.
    const integral = buildIntegralImage(gray, width, height);
    const windowRadius = Math.max(10, Math.min(45, Math.round(Math.min(width, height) / 14)));
    const adaptiveOffset = 8;

    const enhanced = document.createElement('canvas');
    const adaptiveDark = document.createElement('canvas');
    const adaptiveLight = document.createElement('canvas');
    enhanced.width = adaptiveDark.width = adaptiveLight.width = width;
    enhanced.height = adaptiveDark.height = adaptiveLight.height = height;
    const enhancedImage = new ImageData(width, height);
    const adaptiveDarkImage = new ImageData(width, height);
    const adaptiveLightImage = new ImageData(width, height);

    for (let y = 0, i = 0, pixel = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1, i += 1, pixel += 4) {
        const luminance = gray[i];
        const contrast = Math.max(0, Math.min(255, Math.round(((luminance - low) * 255) / Math.max(1, high - low))));
        const localMean = boxMean(integral, width, height, x, y, windowRadius);
        const isDarkText = luminance < localMean - adaptiveOffset;   // dark strokes on a lighter patch
        const isLightText = luminance > localMean + adaptiveOffset;  // bright/white strokes on a darker patch
        const darkOut = isDarkText ? 0 : 255;
        const lightOut = isLightText ? 0 : 255; // normalized to dark-text-on-light

        enhancedImage.data[pixel] = enhancedImage.data[pixel + 1] = enhancedImage.data[pixel + 2] = contrast;
        enhancedImage.data[pixel + 3] = 255;
        adaptiveDarkImage.data[pixel] = adaptiveDarkImage.data[pixel + 1] = adaptiveDarkImage.data[pixel + 2] = darkOut;
        adaptiveDarkImage.data[pixel + 3] = 255;
        adaptiveLightImage.data[pixel] = adaptiveLightImage.data[pixel + 1] = adaptiveLightImage.data[pixel + 2] = lightOut;
        adaptiveLightImage.data[pixel + 3] = 255;
      }
    }
    enhanced.getContext('2d').putImageData(enhancedImage, 0, 0);
    adaptiveDark.getContext('2d').putImageData(adaptiveDarkImage, 0, 0);
    adaptiveLight.getContext('2d').putImageData(adaptiveLightImage, 0, 0);
    return {
      original: original.toDataURL('image/png'),
      enhanced: enhanced.toDataURL('image/png'),
      adaptiveDark: adaptiveDark.toDataURL('image/png'),
      adaptiveLight: adaptiveLight.toDataURL('image/png')
    };
  }

  // Summed-area table for O(1) local window-mean lookups.
  function buildIntegralImage(gray, width, height) {
    const integral = new Float64Array((width + 1) * (height + 1));
    const stride = width + 1;
    for (let y = 0; y < height; y += 1) {
      let rowSum = 0;
      for (let x = 0; x < width; x += 1) {
        rowSum += gray[(y * width) + x];
        integral[((y + 1) * stride) + (x + 1)] = integral[(y * stride) + (x + 1)] + rowSum;
      }
    }
    return integral;
  }

  function boxMean(integral, width, height, x, y, radius) {
    const stride = width + 1;
    const x0 = Math.max(0, x - radius);
    const x1 = Math.min(width - 1, x + radius);
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const sum = integral[((y1 + 1) * stride) + (x1 + 1)]
      - integral[(y0 * stride) + (x1 + 1)]
      - integral[((y1 + 1) * stride) + x0]
      + integral[(y0 * stride) + x0];
    return sum / area;
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Failed to prepare the selected image for OCR.'));
      image.src = dataUrl;
    });
  }

  function histogramPercentile(histogram, percentile, total) {
    const target = total * percentile;
    let count = 0;
    for (let value = 0; value < histogram.length; value += 1) {
      count += histogram[value];
      if (count >= target) return value;
    }
    return 255;
  }

  // ─── Crop Screenshot to Selection ──────────────────────
  async function cropScreenshot(dataUrl, x, y, w, h) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        // captureVisibleTab dimensions are not always devicePixelRatio at
        // browser zoom. Derive the mapping from the actual screenshot.
        const scaleX = img.naturalWidth / window.innerWidth;
        const scaleY = img.naturalHeight / window.innerHeight;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scaleX));
        canvas.height = Math.max(1, Math.round(h * scaleY));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(
          img,
          Math.round(x * scaleX), Math.round(y * scaleY),
          Math.round(w * scaleX), Math.round(h * scaleY),
          0, 0, canvas.width, canvas.height
        );
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Failed to load screenshot'));
      img.src = dataUrl;
    });
  }

  // Small, tight poster-title crops can be genuinely tiny in raw pixels
  // (a drag-selection might only be ~150x40px), which starves a vision
  // model's image tokenizer of detail on decorative/curvy/3D letterforms.
  // This scales small crops up to a minimum useful size before sending to
  // Gemini; it never shrinks an already-large crop, so it doesn't add
  // meaningful cost/latency for normal-sized selections.
  async function upscaleForGemini(dataUrl, minSize = 768) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const longest = Math.max(img.naturalWidth, img.naturalHeight);
        const scale = Math.max(1, minSize / longest);
        if (scale === 1) {
          resolve(dataUrl);
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Failed to prepare image for Gemini.'));
      img.src = dataUrl;
    });
  }

  // ─── Clean OCR text ────────────────────────────────────
  function cleanOcrText(text) {
    return text
      .replace(/\r/g, '')
      .replace(/[^\p{L}\p{N}\s&:'!.,?\-]/gu, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function cleanText(text) {
    return cleanOcrText(text).replace(/\s+/g, ' ').trim();
  }

  function normalizeTitle(value) {
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  // Poster logos frequently spread a title into individually-spaced
  // letters for stylistic effect (e.g. "A L I E N", "S E V E N"). OCR reads
  // that faithfully as separate single-character tokens, which then never
  // matches the real title during search. This collapses runs of 2+
  // consecutive single-letter tokens back into one word, while leaving
  // normal multi-letter words (and genuine lone single-letter words, which
  // are too ambiguous to safely merge) untouched.
  function collapseLetterSpacing(line) {
    const tokens = line.split(/\s+/).filter(Boolean);
    const result = [];
    let i = 0;
    while (i < tokens.length) {
      if (tokens[i].length === 1 && /\p{L}/u.test(tokens[i])) {
        const run = [];
        let j = i;
        while (j < tokens.length && tokens[j].length === 1 && /\p{L}/u.test(tokens[j])) {
          run.push(tokens[j]);
          j += 1;
        }
        if (run.length >= 2) {
          result.push(run.join(''));
        } else {
          result.push(...run);
        }
        i = j;
      } else {
        result.push(tokens[i]);
        i += 1;
      }
    }
    return result.join(' ');
  }

  // Returns candidates with their final (base score + line-join bonus)
  // preserved, so callers merging results across multiple OCR passes don't
  // have to re-derive — and lose — the whole-title bonus.
  function extractTitleCandidatesScored(text) {
    const lines = cleanOcrText(text)
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => /\p{L}/u.test(line));
    // Collapsed variants are used for the actual matching attempts (a
    // letter-spaced line only makes sense as its joined word); the raw
    // lines are still tried too, in case a line was never actually
    // letter-spaced and collapsing it would be wrong (e.g. real initials).
    const collapsedLines = lines.map(collapseLetterSpacing);
    const candidates = new Map(); // key -> { candidate, score }
    const addCandidate = (value, bonus = 0) => {
      const candidate = cleanText(value);
      if (candidate.length < 2 || candidate.length > 90 || !/\p{L}/u.test(candidate)) return;
      const key = normalizeTitle(candidate);
      if (!key) return;
      const score = scoreTitleCandidate(candidate) + bonus;
      const existing = candidates.get(key);
      if (!existing || existing.score < score) candidates.set(key, { candidate, score });
    };

    lines.forEach((line, index) => {
      addCandidate(line);
      const collapsed = collapsedLines[index];
      // Favor the collapsed reading when it actually changed something —
      // it's almost always the real title once letters were de-spaced.
      if (collapsed !== line) addCandidate(collapsed, 10);
    });
    for (let start = 0; start < collapsedLines.length; start += 1) {
      for (let size = 2; size <= 4 && start + size <= collapsedLines.length; size += 1) {
        // Reassembling 2-4 poster lines onto a single line, in reading
        // order, with normal spacing — this is usually how a multi-line
        // title actually reads, so it's weighted above lone fragments.
        const coversWholeBlock = size === collapsedLines.length;
        addCandidate(collapsedLines.slice(start, start + size).join(' '), coversWholeBlock ? 16 : 8);
      }
    }
    addCandidate(collapsedLines.join(' '), collapsedLines.length >= 2 ? 16 : 0); // every detected line, joined onto one line
    addCandidate(text, lines.length >= 2 ? 16 : 0);
    return [...candidates.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, 12);
  }

  function extractTitleCandidates(text) {
    return extractTitleCandidatesScored(text).map(({ candidate }) => candidate);
  }

  function scoreTitleCandidate(candidate) {
    const normalized = normalizeTitle(candidate);
    const words = normalized.split(' ').filter(Boolean);
    const letters = (candidate.match(/\p{L}/gu) || []).length;
    const uppercase = (candidate.match(/\p{Lu}/gu) || []).length;
    const marketing = /coming soon|only in theaters|only in cinemas|this summer|this fall|rated r|rated pg|www |instagram|facebook|from the director|experience it|official trailer|watch now/i.test(candidate);
    let score = 18 + Math.min(25, letters) - (Math.abs(candidate.length - 22) * 0.12);
    // Many real titles run 2 lines (subtitle/tagline split), so don't
    // punish moderate word counts — only clearly-too-long OCR noise.
    score += words.length <= 4 ? 10 : words.length <= 8 ? 5 : words.length <= 11 ? -4 : -16;
    if (uppercase / Math.max(1, letters) > 0.62) score += 7;
    if (marketing) score -= 35;
    if (/\d{4}/.test(candidate)) score -= 4;
    return score;
  }

  function mergeCandidates(...candidateLists) {
    const unique = new Map();
    candidateLists.flat().forEach((candidate) => {
      const key = normalizeTitle(candidate);
      if (key && !unique.has(key)) unique.set(key, candidate);
    });
    return [...unique.values()]
      .sort((left, right) => scoreTitleCandidate(right) - scoreTitleCandidate(left))
      .slice(0, 12);
  }

  // ─── Movie Data Providers (OMDb / TMDB) ────────────────
  // Only one provider is active at a time (dataSource). Both are normalized
  // to the same movie shape so the rest of the UI doesn't need to care
  // which one answered.
  function normalizeOmdbMovie(m) {
    return {
      Title: m.Title,
      Poster: m.Poster,
      imdbRating: m.imdbRating,
      ratingSourceLabel: 'IMDb',
      Year: m.Year,
      Runtime: m.Runtime,
      Genre: m.Genre,
      Plot: m.Plot,
      imdbID: m.imdbID,
      Type: m.Type,
      imdbVotes: m.imdbVotes,
      Response: 'True',
      detailUrl: 'https://www.imdb.com/title/' + m.imdbID + '/',
      linkLabel: 'View on IMDb'
    };
  }

  const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w500';

  // Composite ids ("tv-1399" / "movie-603") let a single id value carry
  // which TMDB collection it came from, since movie and TV ids are separate
  // numeric namespaces and can collide.
  function tmdbCompositeId(mediaType, id) {
    return (mediaType === 'tv' ? 'tv' : 'movie') + '-' + id;
  }

  function parseTmdbCompositeId(compositeId) {
    const str = String(compositeId);
    const idx = str.indexOf('-');
    if (idx === -1) return { mediaType: 'movie', id: str };
    const mediaType = str.slice(0, idx);
    return { mediaType: mediaType === 'tv' ? 'tv' : 'movie', id: str.slice(idx + 1) };
  }

  // Normalizes both TMDB movie results and TMDB TV/web-series results into
  // the same shape the rest of the UI expects. Previously only movie shapes
  // existed here, and only /search/movie + /movie/{id} were ever called —
  // meaning a TV series could never be found, matched, or rendered as
  // anything other than "movie" when using the TMDB provider.
  function normalizeTmdbItem(m, mediaType) {
    const isTv = mediaType === 'tv';
    const title = isTv ? (m.name || m.original_name || 'Unknown') : (m.title || m.original_title || 'Unknown');
    const startYear = ((isTv ? m.first_air_date : m.release_date) || '').slice(0, 4);
    const endYear = (isTv ? (m.last_air_date || '').slice(0, 4) : '');
    const year = startYear
      ? (isTv && endYear && endYear !== startYear ? (startYear + '–' + endYear) : startYear)
      : 'N/A';
    const genreNames = Array.isArray(m.genres) ? m.genres.map((g) => g.name) : [];
    const hasImdbId = typeof m.imdb_id === 'string' && m.imdb_id.startsWith('tt');
    let runtime = 'N/A';
    if (isTv) {
      const epRuntimes = Array.isArray(m.episode_run_time) ? m.episode_run_time : [];
      if (epRuntimes.length) runtime = epRuntimes[0] + ' min/ep';
    } else if (m.runtime) {
      runtime = m.runtime + ' min';
    }
    return {
      Title: title,
      Poster: m.poster_path ? (TMDB_IMG_BASE + m.poster_path) : 'N/A',
      imdbRating: typeof m.vote_average === 'number' && m.vote_average > 0 ? m.vote_average.toFixed(1) : 'N/A',
      ratingSourceLabel: 'TMDB',
      Year: year,
      Runtime: runtime,
      Genre: genreNames.length ? genreNames.join(', ') : 'N/A',
      Plot: m.overview || 'No plot available.',
      imdbID: hasImdbId ? m.imdb_id : ('tmdb-' + m.id),
      tmdbId: m.id,
      tmdbMediaType: isTv ? 'tv' : 'movie',
      Type: isTv ? 'series' : 'movie',
      imdbVotes: typeof m.vote_count === 'number' ? m.vote_count.toLocaleString() : 'N/A',
      Response: 'True',
      detailUrl: hasImdbId ? ('https://www.imdb.com/title/' + m.imdb_id + '/') : ('https://www.themoviedb.org/' + (isTv ? 'tv' : 'movie') + '/' + m.id),
      linkLabel: hasImdbId ? 'View on IMDb' : 'View on TMDB'
    };
  }

  function movieProviderId(movie) {
    return dataSource === 'tmdb' ? tmdbCompositeId(movie.tmdbMediaType || 'movie', movie.tmdbId) : movie.imdbID;
  }

  // /search/multi covers movies *and* TV/web series in one call (filtering
  // out the "person" results it also returns), replacing the old
  // /search/movie-only lookup that made series undetectable via TMDB.
  async function tmdbSearchRaw(query) {
    const res = await fetch('https://api.themoviedb.org/3/search/multi?query=' + encodeURIComponent(query) + '&api_key=' + encodeURIComponent(tmdbApiKey));
    const data = await res.json();
    const results = (data && Array.isArray(data.results)) ? data.results : [];
    return results.filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
  }

  function tmdbResultTitle(m) {
    return m.title || m.name || m.original_title || m.original_name || '';
  }

  async function tmdbFetchById(id, mediaType = 'movie') {
    try {
      const res = await fetch('https://api.themoviedb.org/3/' + (mediaType === 'tv' ? 'tv' : 'movie') + '/' + id + '?api_key=' + encodeURIComponent(tmdbApiKey));
      const data = await res.json();
      if (!data || data.success === false || !data.id) return null;
      return normalizeTmdbItem(data, mediaType);
    } catch {
      return null;
    }
  }

  async function fetchMovieById(id) {
    if (dataSource === 'tmdb') {
      const { mediaType, id: tmdbId } = parseTmdbCompositeId(id);
      return tmdbFetchById(tmdbId, mediaType);
    }
    try {
      const res = await fetch('https://www.omdbapi.com/?i=' + id + '&apikey=' + apiKey + '&plot=short');
      const data = await res.json();
      return data.Response === 'True' ? normalizeOmdbMovie(data) : null;
    } catch {
      return null;
    }
  }

  async function searchMovieCandidates(candidates) {
    return dataSource === 'tmdb' ? tmdbSearchCandidates(candidates) : omdbSearchCandidates(candidates);
  }

  async function omdbSearchCandidates(candidates) {
    for (const query of candidates.slice(0, 12)) {
      const direct = await fetch('https://www.omdbapi.com/?t=' + encodeURIComponent(query) + '&apikey=' + apiKey + '&plot=short').then((res) => res.json());
      if (direct.Response === 'True' && titleSimilarity(query, direct.Title) >= 0.58) {
        return { movie: normalizeOmdbMovie(direct), query };
      }

      // OMDb's type-agnostic "t=" lookup can settle on a same-named movie
      // and never surface a series at all; retrying with type=series
      // explicitly catches shows the first lookup missed.
      const directSeries = await fetch('https://www.omdbapi.com/?t=' + encodeURIComponent(query) + '&type=series&apikey=' + apiKey + '&plot=short').then((res) => res.json());
      if (directSeries.Response === 'True' && titleSimilarity(query, directSeries.Title) >= 0.58) {
        return { movie: normalizeOmdbMovie(directSeries), query };
      }

      const search = await fetch('https://www.omdbapi.com/?s=' + encodeURIComponent(query) + '&apikey=' + apiKey).then((res) => res.json());
      const searchSeries = await fetch('https://www.omdbapi.com/?s=' + encodeURIComponent(query) + '&type=series&apikey=' + apiKey).then((res) => res.json());
      const matches = [
        ...((search.Response === 'True' && search.Search) ? search.Search : []),
        ...((searchSeries.Response === 'True' && searchSeries.Search) ? searchSeries.Search : [])
      ];
      if (!matches.length) continue;
      const closest = matches
        .map((movie) => ({ movie, similarity: titleSimilarity(query, movie.Title) }))
        .sort((left, right) => right.similarity - left.similarity)[0];
      if (!closest || closest.similarity < 0.7) continue;
      const movie = await fetch('https://www.omdbapi.com/?i=' + closest.movie.imdbID + '&apikey=' + apiKey + '&plot=short').then((res) => res.json());
      if (movie.Response === 'True') return { movie: normalizeOmdbMovie(movie), query };
    }
    return null;
  }

  async function tmdbSearchCandidates(candidates) {
    for (const query of candidates.slice(0, 12)) {
      const results = await tmdbSearchRaw(query);
      if (!results.length) continue;
      const closest = results
        .map((item) => ({ item, similarity: titleSimilarity(query, tmdbResultTitle(item)) }))
        .sort((left, right) => right.similarity - left.similarity)[0];
      if (!closest || closest.similarity < 0.6) continue;
      const details = await tmdbFetchById(closest.item.id, closest.item.media_type);
      if (details) return { movie: details, query };
    }
    return null;
  }

  function titleSimilarity(query, title) {
    const normQuery = normalizeTitle(query);
    const normTitle = normalizeTitle(title);
    let queryWords = new Set(normQuery.split(' ').filter((word) => word.length > 1));
    let titleWords = new Set(normTitle.split(' ').filter((word) => word.length > 1));
    // Fall back to unfiltered words rather than a hard 0 when everything
    // was a single character (e.g. a residual letter-spaced fragment, or a
    // genuinely one-letter title) — the compact-string check below still
    // catches an exact match either way.
    if (!queryWords.size) queryWords = new Set(normQuery.split(' ').filter(Boolean));
    if (!titleWords.size) titleWords = new Set(normTitle.split(' ').filter(Boolean));
    if (!queryWords.size || !titleWords.size) return 0;
    let shared = 0;
    queryWords.forEach((word) => { if (titleWords.has(word)) shared += 1; });
    const wordScore = shared / Math.max(queryWords.size, titleWords.size);
    const compactQuery = normQuery.replace(/ /g, '');
    const compactTitle = normTitle.replace(/ /g, '');
    if (compactQuery === compactTitle) return 1;
    if (compactQuery.includes(compactTitle) || compactTitle.includes(compactQuery)) return Math.max(0.8, wordScore);
    return wordScore;
  }

  async function searchMovieByQuery(query) {
    return dataSource === 'tmdb' ? tmdbSearchByQuery(query) : omdbSearchByQuery(query);
  }

  async function omdbSearchByQuery(query) {
    let url = 'https://www.omdbapi.com/?t=' + encodeURIComponent(query) + '&apikey=' + apiKey + '&plot=short';
    let res = await fetch(url);
    let data = await res.json();
    if (data.Response === 'True') return normalizeOmdbMovie(data);

    url = 'https://www.omdbapi.com/?t=' + encodeURIComponent(query) + '&type=series&apikey=' + apiKey + '&plot=short';
    res = await fetch(url);
    data = await res.json();
    if (data.Response === 'True') return normalizeOmdbMovie(data);

    url = 'https://www.omdbapi.com/?s=' + encodeURIComponent(query) + '&apikey=' + apiKey;
    res = await fetch(url);
    data = await res.json();
    let matches = (data.Response === 'True' && data.Search) ? data.Search : [];

    url = 'https://www.omdbapi.com/?s=' + encodeURIComponent(query) + '&type=series&apikey=' + apiKey;
    res = await fetch(url);
    data = await res.json();
    if (data.Response === 'True' && data.Search) matches = matches.concat(data.Search);

    if (matches.length > 0) {
      const first = matches[0];
      url = 'https://www.omdbapi.com/?i=' + first.imdbID + '&apikey=' + apiKey + '&plot=short';
      res = await fetch(url);
      const full = await res.json();
      return full.Response === 'True' ? normalizeOmdbMovie(full) : null;
    }
    return null;
  }

  async function tmdbSearchByQuery(query) {
    const results = await tmdbSearchRaw(query);
    if (!results.length) return null;
    return await tmdbFetchById(results[0].id, results[0].media_type);
  }

  async function findAlternateYears(movie) {
    return dataSource === 'tmdb' ? tmdbFindAlternates(movie) : omdbFindAlternates(movie);
  }

  async function omdbFindAlternates(movie) {
    if (!movie.Title) return [];
    try {
      const res = await fetch('https://www.omdbapi.com/?s=' + encodeURIComponent(movie.Title) + '&apikey=' + apiKey);
      const data = await res.json();
      if (data.Response !== 'True' || !Array.isArray(data.Search)) return [];
      const baseKey = normalizeTitle(movie.Title);
      const seen = new Map();
      data.Search.forEach((m) => {
        if (normalizeTitle(m.Title) === baseKey && !seen.has(m.imdbID)) {
          seen.set(m.imdbID, { id: m.imdbID, Title: m.Title, Year: m.Year });
        }
      });
      const list = [...seen.values()];
      if (list.length <= 1) return [];
      list.sort((a, b) => parseYear(a.Year) - parseYear(b.Year));
      return list;
    } catch {
      return [];
    }
  }

  async function tmdbFindAlternates(movie) {
    if (!movie.Title) return [];
    try {
      const mediaType = movie.tmdbMediaType || 'movie';
      const results = await tmdbSearchRaw(movie.Title);
      const baseKey = normalizeTitle(movie.Title);
      const seen = new Map();
      results.forEach((m) => {
        if (m.media_type !== mediaType) return; // remakes/reboots keep the same media type
        const title = tmdbResultTitle(m);
        const compositeId = tmdbCompositeId(m.media_type, m.id);
        if (normalizeTitle(title) === baseKey && !seen.has(compositeId)) {
          const dateStr = m.media_type === 'tv' ? m.first_air_date : m.release_date;
          seen.set(compositeId, { id: compositeId, Title: title, Year: (dateStr || '').slice(0, 4) || 'N/A' });
        }
      });
      const list = [...seen.values()];
      if (list.length <= 1) return [];
      list.sort((a, b) => parseYear(a.Year) - parseYear(b.Year));
      return list;
    } catch {
      return [];
    }
  }

  // ─── Card UI Helpers ───────────────────────────────────
  function createCard(x, y) {
    removeExistingCards();
    const card = document.createElement('div');
    card.className = CARD_CLASS + ' ' + (darkMode ? 'dark' : 'light');
    card.style.left = Math.min(x, window.innerWidth - 360) + 'px';
    card.style.top = Math.min(y, window.innerHeight - 400) + 'px';
    card.innerHTML = `
      <div class="imdb-lens-drag-handle" title="Drag to move">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <circle cx="8" cy="6" r="1.6"></circle><circle cx="16" cy="6" r="1.6"></circle>
          <circle cx="8" cy="12" r="1.6"></circle><circle cx="16" cy="12" r="1.6"></circle>
          <circle cx="8" cy="18" r="1.6"></circle><circle cx="16" cy="18" r="1.6"></circle>
        </svg>
      </div>
      <div class="imdb-lens-body"></div>`;
    document.body.appendChild(card);
    return card;
  }

  function getCardBody(card) {
    return card.querySelector('.imdb-lens-body') || card;
  }

  // ─── Draggable cards ───────────────────────────────────
  // Delegated on document (not per-card) so listeners never pile up as
  // cards get created/removed throughout a session. Only the dedicated
  // grip handle starts a drag, so it never fights with text selection,
  // the manual-search input, or the movie-title link.
  let dragState = null;

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const handle = e.target.closest('.imdb-lens-drag-handle');
    if (!handle) return;
    const card = handle.closest('.' + CARD_CLASS);
    if (!card) return;

    const rect = card.getBoundingClientRect();
    dragState = {
      card,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top,
      width: rect.width,
      height: rect.height
    };
    card.classList.add('imdb-lens-dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const newLeft = clamp(dragState.origLeft + dx, 4, window.innerWidth - dragState.width - 4);
    const newTop = clamp(dragState.origTop + dy, 4, window.innerHeight - dragState.height - 4);
    dragState.card.style.left = newLeft + 'px';
    dragState.card.style.top = newTop + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragState) return;
    dragState.card.classList.remove('imdb-lens-dragging');
    dragState = null;
  });

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function removeExistingCards() {
    document.querySelectorAll('.' + CARD_CLASS).forEach(el => el.remove());
  }

  function showLoading(card, message, cancelOpts) {
    const cancellable = !!cancelOpts;
    getCardBody(card).innerHTML = `
      <div class="imdb-lens-loading">
        ` + (cancellable ? `<button class="imdb-lens-loading-stop" title="Stop and search manually">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </button>` : '') + `
        <div class="imdb-lens-spinner"></div>
        <div>` + escapeHtml(message) + `</div>
      </div>`;

    if (cancellable) {
      const stopBtn = card.querySelector('.imdb-lens-loading-stop');
      stopBtn.addEventListener('click', () => {
        card.dataset.cineLensCancelled = '1';
        const x = parseInt(card.style.left, 10) || 0;
        const y = parseInt(card.style.top, 10) || 0;
        const prefill = (cancelOpts && typeof cancelOpts === 'object' && cancelOpts.getText) ? (cancelOpts.getText() || '') : '';
        showManualInput(card, x, y, prefill, 'Stopped — enter the title manually:');
      });
    }
  }

  function isCancelled(card) {
    return card.dataset.cineLensCancelled === '1';
  }

  function showErrorCard(x, y, message) {
    const card = createCard(x, y);
    getCardBody(card).innerHTML = `
      <button class="imdb-lens-close" title="Close">×</button>
      <div class="imdb-lens-error">` + escapeHtml(message) + `</div>`;
    card.querySelector('.imdb-lens-close').addEventListener('click', () => card.remove());
  }

  function renderMovieCard(card, movie, ocrText) {
    const genres = (movie.Genre || 'N/A').split(',').map(g => g.trim());
    const detailUrl = safeExternalUrl(movie.detailUrl, ['www.imdb.com', 'imdb.com', 'www.themoviedb.org', 'themoviedb.org']) || '#';
    const posterUrl = movie.Poster !== 'N/A' ? (safeExternalUrl(movie.Poster, ['image.tmdb.org', 'm.media-amazon.com']) || '') : '';
    const ratingSourceLabel = movie.ratingSourceLabel || (dataSource === 'tmdb' ? 'TMDB' : 'IMDb');
    const linkLabel = movie.linkLabel || 'View on IMDb';

    getCardBody(card).innerHTML = `
      <button class="imdb-lens-close" title="Close">×</button>
      <div class="imdb-lens-header">
        <img class="imdb-lens-poster" src="` + escapeHtml(posterUrl) + `"
             alt="` + escapeHtml(movie.Title) + `" onerror="this.style.display='none'" />
        <div class="imdb-lens-meta">
          <div class="imdb-lens-title" data-url="` + escapeHtml(detailUrl) + `">
            ` + escapeHtml(movie.Title) + `
            <svg class="imdb-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </div>
          <div class="imdb-lens-rating">
            <span class="star">★</span> ` + (movie.imdbRating !== 'N/A' ? escapeHtml(movie.imdbRating) : '?') + ` <span class="imdb-lens-rating-source">` + escapeHtml(ratingSourceLabel) + `</span>
          </div>
          <div class="imdb-lens-year">` + escapeHtml(movie.Year || 'N/A') + ' · ' + escapeHtml(movie.Runtime !== 'N/A' ? (movie.Runtime || '') : '') + `</div>
          <div class="imdb-lens-year-picker" id="imdb-lens-year-picker"></div>
          <div class="imdb-lens-genres">
            ` + genres.map(g => '<span class="imdb-lens-genre-tag">' + escapeHtml(g) + '</span>').join('') + `
          </div>
        </div>
      </div>
      <div class="imdb-lens-plot">` + escapeHtml(movie.Plot || 'No plot available.') + `</div>
      ` + (ocrText ? '<div class="imdb-lens-ocr-text">Detected: "' + escapeHtml(ocrText) + '"</div>' : '') + `
      <a class="imdb-lens-view-btn" href="` + escapeHtml(detailUrl) + `" target="_blank" rel="noopener noreferrer">
        ` + escapeHtml(linkLabel) + `
        <svg class="imdb-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
      </a>
      <div class="imdb-lens-footer">
        <span>` + (movie.Type ? movie.Type.toUpperCase() : 'MOVIE') + `</span>
        <span>` + (movie.imdbVotes !== 'N/A' ? movie.imdbVotes + ' votes' : '') + `</span>
      </div>
      <div class="imdb-lens-manual imdb-lens-manual-inline">
        <input type="text" id="imdb-lens-manual-input" placeholder="Wrong movie or rating? Search by title..."
               autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"
               data-lpignore="true" data-1p-ignore="true" data-form-type="other" />
        <button id="imdb-lens-manual-btn">Search</button>
        <div class="imdb-lens-manual-status" id="imdb-lens-manual-status"></div>
      </div>`;

    card.querySelector('.imdb-lens-title').addEventListener('click', () => { if (detailUrl !== '#') window.open(detailUrl, '_blank', 'noopener,noreferrer'); });
    card.querySelector('.imdb-lens-close').addEventListener('click', () => card.remove());

    let closeTimer = setTimeout(() => card.remove(), 15000);
    const stopAutoClose = () => clearTimeout(closeTimer);
    const restartAutoClose = () => { closeTimer = setTimeout(() => card.remove(), 5000); };
    card.addEventListener('mouseenter', stopAutoClose);
    card.addEventListener('mouseleave', restartAutoClose);

    const outsideClick = (e) => {
      if (!card.contains(e.target)) {
        card.remove();
        document.removeEventListener('click', outsideClick);
      }
    };
    setTimeout(() => document.addEventListener('click', outsideClick), 100);

    wireInlineSearch(card, {
      onFocus: stopAutoClose,
      onBlur: restartAutoClose,
      onSuccess: (newMovie, query) => {
        document.removeEventListener('click', outsideClick);
        renderMovieCard(card, newMovie, query);
      }
    });

    // Franchises get remade/rebooted under the exact same title a lot
    // (Dune 1984/2021, The Lion King 1994/2019, Aladdin 1992/2019...). This
    // doesn't block the initial render — it fills in a year-picker only if
    // other same-titled entries actually exist.
    loadAlternateYears(card, movie, ocrText);
  }

  async function loadAlternateYears(card, movie, ocrText) {
    const container = card.querySelector('#imdb-lens-year-picker');
    if (!container) return;
    const alternates = await findAlternateYears(movie);
    // The card may have been re-rendered or removed while this was in flight.
    if (!card.isConnected) return;
    const freshContainer = card.querySelector('#imdb-lens-year-picker');
    if (!freshContainer) return;
    if (alternates.length <= 1) { freshContainer.remove(); return; }

    const currentId = movieProviderId(movie);
    freshContainer.innerHTML = alternates.map((alt) => {
      const isActive = alt.id === currentId;
      const label = escapeHtml(String(parseYear(alt.Year) || alt.Year));
      return '<button class="imdb-lens-year-pill' + (isActive ? ' active' : '') + '" data-id="' + escapeHtml(alt.id)
        + '" title="' + escapeHtml(alt.Title) + ' (' + escapeHtml(alt.Year) + ')"' + (isActive ? ' disabled' : '') + '>' + label + '</button>';
    }).join('');

    freshContainer.querySelectorAll('.imdb-lens-year-pill').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const pills = freshContainer.querySelectorAll('.imdb-lens-year-pill');
        pills.forEach((b) => { b.disabled = true; });
        const altMovie = await fetchMovieById(btn.dataset.id);
        if (altMovie) {
          renderMovieCard(card, altMovie, ocrText);
          return;
        }
        pills.forEach((b) => { b.disabled = b.classList.contains('active'); });
      });
    });
  }

  function parseYear(yearStr) {
    const match = /\d{4}/.exec(yearStr || '');
    return match ? parseInt(match[0], 10) : 0;
  }

  // Shared "search a different title" bar wiring: used both on a successful
  // match (so a wrong movie/rating can be corrected without losing the
  // card) and while composing the input's own search/error state.
  function wireInlineSearch(card, { onFocus, onBlur, onSuccess } = {}) {
    const input = card.querySelector('#imdb-lens-manual-input');
    const btn = card.querySelector('#imdb-lens-manual-btn');
    const statusEl = card.querySelector('#imdb-lens-manual-status');
    if (!input || !btn) return;

    if (onFocus) input.addEventListener('focus', onFocus);
    if (onBlur) input.addEventListener('blur', onBlur);

    const setStatus = (message, type) => {
      if (!statusEl) return;
      statusEl.textContent = message || '';
      statusEl.className = 'imdb-lens-manual-status' + (type ? ' ' + type : '');
    };

    const doSearch = async () => {
      const query = input.value.trim();
      if (!query) return;
      btn.disabled = true;
      setStatus('Searching IMDb...', '');
      try {
        const movie = await searchMovieByQuery(query);
        if (movie && movie.Response === 'True') {
          if (onSuccess) {
            onSuccess(movie, query);
          } else {
            setStatus('', '');
          }
        } else {
          btn.disabled = false;
          setStatus('No results for "' + query + '". Try a different title.', 'error');
        }
      } catch {
        btn.disabled = false;
        setStatus('Network error. Check your connection.', 'error');
      }
    };

    btn.addEventListener('click', doSearch);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  }

  function showManualInput(card, x, y, detectedText, message) {
    getCardBody(card).innerHTML = `
      <button class="imdb-lens-close" title="Close">×</button>
      <div class="imdb-lens-error">` + escapeHtml(message) + `</div>
      <div class="imdb-lens-manual">
        <input type="text" id="imdb-lens-manual-input" placeholder="Enter movie title..." value="` + escapeHtml(detectedText) + `"
               autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"
               data-lpignore="true" data-1p-ignore="true" data-form-type="other" />
        <button id="imdb-lens-manual-btn">Search</button>
        <div class="imdb-lens-manual-status" id="imdb-lens-manual-status"></div>
      </div>`;

    card.querySelector('.imdb-lens-close').addEventListener('click', () => card.remove());

    wireInlineSearch(card, {
      onSuccess: (movie, query) => renderMovieCard(card, movie, query)
    });

    card.querySelector('#imdb-lens-manual-input').focus();
  }

  function safeExternalUrl(value, allowedHosts) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname.toLowerCase())) return '';
      return url.href;
    } catch {
      return '';
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      removeExistingCards();
      removeSelectBtn();
      if (isScanMode) {
        comboArmed = true;
        exitScanMode();
      }
    }
  });
})();
