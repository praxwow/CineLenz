document.addEventListener('DOMContentLoaded', () => {
  // Chrome extension popups grow to fit new content just fine, but don't
  // reliably shrink back down when collapsible content (info boxes)
  // closes — leaving dead space at the bottom. Forcing a reflow via a
  // brief display toggle makes Chrome re-measure and resize the popup
  // window to the now-shorter content.
  function shrinkPopupToContent() {
    requestAnimationFrame(() => {
      document.body.style.display = 'none';
      void document.body.offsetHeight; // force reflow
      document.body.style.display = '';
    });
  }
  // The settings screen swap is excluded here and handled explicitly
  // (see setSettingsPanelOpen) — it has its own slide/fade transition,
  // and firing this display:none/'' hack mid-transition would reset
  // the animation and make it snap instead of sliding smoothly.
  new MutationObserver((mutations) => {
    const relevant = mutations.some((m) => m.target.id !== 'settingsView');
    if (relevant) shrinkPopupToContent();
  }).observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });

  // Generic info-button toggle: every ⓘ button reveals the .info-detail
  // block named by its data-info id, one open at a time.
  document.querySelectorAll('.info-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.info);
      if (!target) return;
      const isOpening = target.hasAttribute('hidden');
      document.querySelectorAll('.info-detail[id]').forEach((d) => d.setAttribute('hidden', ''));
      document.querySelectorAll('.info-btn').forEach((b) => b.classList.remove('active'));
      if (isOpening) {
        target.removeAttribute('hidden');
        btn.classList.add('active');
      }
    });
  });

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

  // API Settings screen: all provider keys/engine config live behind the
  // gear icon as a separate "card" that slides in over the main screen
  // (rather than expanding inline below it), so the popup always shows
  // exactly one screen's worth of content at a time. There's a single
  // persistent header for both screens — the gear button itself morphs
  // into a back arrow (same element, swapped icon) rather than showing a
  // second duplicate header bar inside the settings screen. Values are
  // API credentials are stored locally; non-secret preferences sync across Chrome.
  const settingsToggleBtn = document.getElementById('settingsToggle');
  const popupContainer = document.getElementById('popupContainer');
  const mainView = document.getElementById('mainView');
  const settingsView = document.getElementById('settingsView');
  const headerTagline = document.getElementById('headerTagline');
  const SCREEN_TRANSITION_MS = 220;
  let settingsCloseTimer = null;

  const GEAR_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>`;
  const BACK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>`;

  function setSettingsPanelOpen(open) {
    clearTimeout(settingsCloseTimer);
    if (open) {
      settingsView.removeAttribute('hidden');
      // Force layout before adding the classes so the browser has a
      // starting state to transition *from* — otherwise it just snaps.
      void settingsView.offsetHeight;
      // 'settings-active' takes #mainView out of document flow right
      // away; 'settings-open' drives the actual fade/slide. Both flip
      // together on open, so there's never a frame where both screens
      // are in flow at once.
      popupContainer.classList.add('settings-active');
      popupContainer.classList.add('settings-open');
      settingsCloseTimer = setTimeout(shrinkPopupToContent, SCREEN_TRANSITION_MS);
    } else {
      // Only flip 'settings-open' now (starts the fade back) — keep
      // 'settings-active' (mainView still out of flow) until the fade
      // finishes, so #settingsView alone still defines the popup's
      // height for the whole closing animation instead of both screens
      // briefly stacking in flow together (which is what caused a
      // transient over-tall popup + scrollbar on the way back).
      popupContainer.classList.remove('settings-open');
      settingsCloseTimer = setTimeout(() => {
        popupContainer.classList.remove('settings-active');
        settingsView.setAttribute('hidden', '');
        shrinkPopupToContent();
      }, SCREEN_TRANSITION_MS);
    }
    settingsToggleBtn.innerHTML = open ? BACK_ICON : GEAR_ICON;
    settingsToggleBtn.setAttribute('aria-label', open ? 'Back' : 'API Settings');
    settingsToggleBtn.title = open ? 'Back' : 'API Settings';
    settingsToggleBtn.setAttribute('aria-expanded', String(open));
    headerTagline.textContent = open ? 'Settings' : 'Movie info at your fingertips';
    headerTagline.classList.toggle('tagline-accent', open);
  }

  settingsToggleBtn.addEventListener('click', () => {
    setSettingsPanelOpen(settingsView.hasAttribute('hidden'));
  });

  // Keys default to type="password" (dots, not plain text) so a glance at
  // someone's screen or a screen-share doesn't leak them. Each field gets
  // its own 👁 toggle for when the user actually wants to check/copy one.
  document.querySelectorAll('.key-toggle-visibility').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const nowVisible = input.type === 'password';
      input.type = nowVisible ? 'text' : 'password';
      btn.classList.toggle('active', nowVisible);
    });
  });

  const apiKeyInput = document.getElementById('apiKey');
  const tmdbApiKeyInput = document.getElementById('tmdbApiKey');
  const sourceOmdbRadio = document.getElementById('sourceOmdb');
  const sourceTmdbRadio = document.getElementById('sourceTmdb');
  const omdbKeyGroup = document.getElementById('omdbKeyGroup');
  const tmdbKeyGroup = document.getElementById('tmdbKeyGroup');
  const saveBtn = document.getElementById('saveKey');
  const statusDiv = document.getElementById('keyStatus');
  const darkModeToggle = document.getElementById('darkMode');
  const stickyModeToggle = document.getElementById('stickyMode');
  const textSelectToggle = document.getElementById('textSelectEnabled');

  const ocrLocalRadio = document.getElementById('ocrLocal');
  const ocrGeminiRadio = document.getElementById('ocrGemini');
  const geminiKeyGroup = document.getElementById('geminiKeyGroup');
  const geminiApiKeyInput = document.getElementById('geminiApiKey');
  const geminiModelSelect = document.getElementById('geminiModel');
  const refreshModelsBtn = document.getElementById('refreshModels');
  const modelListStatus = document.getElementById('modelListStatus');
  const saveOcrBtn = document.getElementById('saveOcrSettings');
  const ocrStatusDiv = document.getElementById('ocrStatus');
  let savedGeminiModel = '';

  function populateModelSelect(models, preserveValue) {
    const toKeep = preserveValue || geminiModelSelect.value;
    geminiModelSelect.innerHTML = '';
    models.forEach((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      geminiModelSelect.appendChild(opt);
    });
    if (toKeep && models.includes(toKeep)) {
      geminiModelSelect.value = toKeep;
    } else if (!models.includes(geminiModelSelect.value) && models.length) {
      // Saved/previous model no longer exists on this account — fall
      // back to the top-ranked (recommended) entry instead of silently
      // keeping a dead value.
      geminiModelSelect.value = models[0];
    }
  }

  function refreshModelList(silent) {
    const key = geminiApiKeyInput.value.trim();
    if (!key) {
      if (!silent) {
        modelListStatus.textContent = 'Enter your Gemini API key first, then tap ⟳.';
      }
      return;
    }
    refreshModelsBtn.classList.add('spinning');
    if (!silent) modelListStatus.textContent = 'Fetching current models from your account...';

    chrome.runtime.sendMessage({ action: 'listGeminiModels', apiKey: key }, (response) => {
      refreshModelsBtn.classList.remove('spinning');
      if (chrome.runtime.lastError || !response || response.error) {
        const msg = (response && response.error) || chrome.runtime.lastError?.message || 'Unknown error';
        modelListStatus.textContent = 'Could not fetch models (' + msg + '). Check your key, or try again.';
        return;
      }
      if (!response.models || !response.models.length) {
        modelListStatus.textContent = 'No usable models found for this key.';
        return;
      }
      populateModelSelect(response.models, savedGeminiModel);
      modelListStatus.textContent = response.models.length + ' models loaded from your account.';
    });
  }

  function applyProviderVisibility() {
    const isTmdb = sourceTmdbRadio.checked;
    omdbKeyGroup.classList.toggle('is-inactive', isTmdb);
    tmdbKeyGroup.classList.toggle('is-inactive', !isTmdb);
  }

  function applyOcrVisibility() {
    geminiKeyGroup.classList.toggle('is-inactive', !ocrGeminiRadio.checked);
  }

  readCineLenzSettings(
    ['omdbApiKey', 'tmdbApiKey', 'dataSource', 'darkMode', 'stickyMode', 'textSelectEnabled', 'ocrEngine', 'geminiApiKey', 'geminiModel'],
    (result) => {
      if (result.omdbApiKey) apiKeyInput.value = result.omdbApiKey;
      if (result.tmdbApiKey) tmdbApiKeyInput.value = result.tmdbApiKey;
      const isTmdb = result.dataSource === 'tmdb';
      sourceOmdbRadio.checked = !isTmdb;
      sourceTmdbRadio.checked = isTmdb;
      applyProviderVisibility();
      if (result.darkMode !== undefined) darkModeToggle.checked = result.darkMode;
      stickyModeToggle.checked = !!result.stickyMode;
      textSelectToggle.checked = result.textSelectEnabled !== false;

      const isGemini = result.ocrEngine === 'gemini';
      ocrLocalRadio.checked = !isGemini;
      ocrGeminiRadio.checked = isGemini;
      if (result.geminiApiKey) geminiApiKeyInput.value = result.geminiApiKey;
      savedGeminiModel = result.geminiModel || '';
      if (savedGeminiModel) {
        // Seed the dropdown with the saved choice immediately so it isn't
        // blank while the live fetch (below) is in flight.
        populateModelSelect([savedGeminiModel], savedGeminiModel);
      }
      applyOcrVisibility();

      if (result.geminiApiKey) refreshModelList(true);
    }
  );

  sourceOmdbRadio.addEventListener('change', applyProviderVisibility);
  sourceTmdbRadio.addEventListener('change', applyProviderVisibility);
  ocrLocalRadio.addEventListener('change', applyOcrVisibility);
  ocrGeminiRadio.addEventListener('change', applyOcrVisibility);
  refreshModelsBtn.addEventListener('click', () => refreshModelList(false));

  // Auto-fetch the live model list as soon as a key is entered, instead
  // of relying on the user to notice and tap the ⟳ button — 'change'
  // covers paste + tab-away, 'blur' covers click-away.
  let autoRefreshTimer = null;
  function scheduleAutoRefresh() {
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = setTimeout(() => {
      if (geminiApiKeyInput.value.trim()) refreshModelList(false);
    }, 400);
  }
  geminiApiKeyInput.addEventListener('change', scheduleAutoRefresh);
  geminiApiKeyInput.addEventListener('blur', scheduleAutoRefresh);
  geminiApiKeyInput.addEventListener('paste', scheduleAutoRefresh);

  saveOcrBtn.addEventListener('click', () => {
    const ocrEngine = ocrGeminiRadio.checked ? 'gemini' : 'local';
    const geminiApiKey = geminiApiKeyInput.value.trim();
    const geminiModel = geminiModelSelect.value;

    if (ocrEngine === 'gemini' && !geminiApiKey) {
      ocrStatusDiv.textContent = 'Please enter a Gemini API key, or switch back to PP-OCR.';
      ocrStatusDiv.className = 'status error';
      setTimeout(() => { ocrStatusDiv.textContent = ''; ocrStatusDiv.className = 'status'; }, 3000);
      return;
    }

    chrome.storage.local.set({ geminiApiKey }, () => {
      chrome.storage.sync.set({ ocrEngine, geminiModel }, () => {
      savedGeminiModel = geminiModel;
      ocrStatusDiv.textContent = 'OCR settings saved!';
      ocrStatusDiv.className = 'status success';
      setTimeout(() => { ocrStatusDiv.textContent = ''; ocrStatusDiv.className = 'status'; }, 3000);
      notifyAllTabs({ action: 'settingsUpdated' });
      });
    });
  });

  saveBtn.addEventListener('click', () => {
    const dataSource = sourceTmdbRadio.checked ? 'tmdb' : 'omdb';
    const omdbKey = apiKeyInput.value.trim();
    const tmdbKey = tmdbApiKeyInput.value.trim();
    const activeKey = dataSource === 'tmdb' ? tmdbKey : omdbKey;

    if (!activeKey) {
      showStatus('Please enter an API key for ' + (dataSource === 'tmdb' ? 'TMDB' : 'OMDb') + '.', 'error');
      return;
    }

    chrome.storage.local.set({ omdbApiKey: omdbKey, tmdbApiKey: tmdbKey }, () => {
      chrome.storage.sync.set({ dataSource }, () => {
        showStatus('Settings saved!', 'success');
        notifyAllTabs({ action: 'settingsUpdated' });
      });
    });
  });

  darkModeToggle.addEventListener('change', () => {
    chrome.storage.sync.set({ darkMode: darkModeToggle.checked }, () => {
      notifyAllTabs({ action: 'darkModeChanged', value: darkModeToggle.checked });
    });
  });

  stickyModeToggle.addEventListener('change', () => {
    chrome.storage.sync.set({ stickyMode: stickyModeToggle.checked }, () => {
      notifyAllTabs({ action: 'stickyModeChanged', value: stickyModeToggle.checked });
    });
  });

  textSelectToggle.addEventListener('change', () => {
    chrome.storage.sync.set({ textSelectEnabled: textSelectToggle.checked }, () => {
      notifyAllTabs({ action: 'textSelectModeChanged', value: textSelectToggle.checked });
    });
  });

  // ─── Activation Combo (customizable, Mac-aware) ────────
  // Mac keyboards route some Ctrl+Alt combos through OS-level input-source
  // switching, so Cmd+Option is used as the default there instead;
  // Windows/Linux keep the original Ctrl+Alt+Z. Either way it's fully
  // overridable below via a real recorded keypress.
  const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgentData?.platform || '');

  function defaultCombo() {
    return IS_MAC
      ? { ctrl: false, alt: true, shift: false, meta: true, key: 'z' }
      : { ctrl: true, alt: true, shift: false, meta: false, key: 'z' };
  }

  function comboModifierLabels(combo) {
    const labels = [];
    if (combo.ctrl) labels.push('Ctrl');
    if (combo.meta) labels.push(IS_MAC ? 'Cmd' : 'Win');
    if (combo.alt) labels.push(IS_MAC ? 'Option' : 'Alt');
    if (combo.shift) labels.push('Shift');
    return labels;
  }

  function formatComboLabel(combo) {
    return [...comboModifierLabels(combo), (combo.key || '').toUpperCase()].join('+');
  }

  const comboPillsDisplay = document.getElementById('comboPillsDisplay');
  const howToComboLabel = document.getElementById('howToComboLabel');
  const comboRecorder = document.getElementById('comboRecorder');
  const saveComboBtn = document.getElementById('saveCombo');
  const resetComboBtn = document.getElementById('resetCombo');
  const comboStatus = document.getElementById('comboStatus');
  const comboHint = document.getElementById('comboHint');

  if (comboHint) {
    comboHint.textContent = IS_MAC
      ? 'Needs at least one modifier key (Cmd/Option/Ctrl/Shift) plus a letter or number.'
      : 'Needs at least one modifier key (Ctrl/Alt/Shift/Win) plus a letter or number.';
  }

  let currentCombo = defaultCombo();
  let recordedCombo = null;

  // The badge icon itself is deliberately static (just a generic "3 keys"
  // glyph, no text) since the combo is fully user-customizable — the
  // actual current shortcut is shown as real pills below the description,
  // and in the How to Use card, both rendered here.
  function renderCombo(combo) {
    const modLabels = comboModifierLabels(combo);
    const keyLabel = (combo.key || '').toUpperCase();

    comboPillsDisplay.innerHTML = '';
    [...modLabels, keyLabel].forEach((part, i) => {
      if (i > 0) {
        const plus = document.createElement('span');
        plus.className = 'combo-plus';
        plus.textContent = '+';
        comboPillsDisplay.appendChild(plus);
      }
      const kbd = document.createElement('kbd');
      kbd.textContent = part;
      comboPillsDisplay.appendChild(kbd);
    });

    if (howToComboLabel) howToComboLabel.textContent = formatComboLabel(combo);
  }

  chrome.storage.sync.get(['activationCombo'], (res) => {
    currentCombo = res.activationCombo && res.activationCombo.key ? res.activationCombo : defaultCombo();
    renderCombo(currentCombo);
  });

  function setComboStatus(text, kind) {
    comboStatus.textContent = text;
    comboStatus.className = kind || '';
    if (text) {
      setTimeout(() => {
        comboStatus.textContent = '';
        comboStatus.className = '';
      }, 3000);
    }
  }

  function resetRecorderUI() {
    comboRecorder.textContent = 'Click here, then press keys…';
    comboRecorder.classList.remove('has-combo', 'recording');
    saveComboBtn.disabled = true;
    recordedCombo = null;
  }

  function stopRecording() {
    comboRecorder.classList.remove('recording');
    document.removeEventListener('keydown', handleRecorderKeydown, true);
  }

  function handleRecorderKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      resetRecorderUI();
      stopRecording();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // Wait for a real (non-modifier) key before treating this as a
    // complete combo — a bare Ctrl press alone isn't a usable shortcut.
    if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(e.key)) return;

    const candidate = {
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: e.metaKey,
      key: e.key.toLowerCase()
    };

    if (!candidate.ctrl && !candidate.alt && !candidate.shift && !candidate.meta) {
      setComboStatus('Include at least one modifier key (Ctrl/Alt/Shift/Cmd).', 'error');
      return;
    }

    recordedCombo = candidate;
    comboRecorder.textContent = formatComboLabel(candidate);
    comboRecorder.classList.remove('recording');
    comboRecorder.classList.add('has-combo');
    saveComboBtn.disabled = false;
    setComboStatus('', '');
    stopRecording();
  }

  comboRecorder.addEventListener('click', () => {
    recordedCombo = null;
    saveComboBtn.disabled = true;
    comboRecorder.textContent = 'Press your shortcut now…';
    comboRecorder.classList.add('recording');
    comboRecorder.classList.remove('has-combo');
    setComboStatus('', '');
    document.addEventListener('keydown', handleRecorderKeydown, true);
  });

  saveComboBtn.addEventListener('click', () => {
    if (!recordedCombo) return;
    chrome.storage.sync.set({ activationCombo: recordedCombo }, () => {
      currentCombo = recordedCombo;
      renderCombo(currentCombo);
      notifyAllTabs({ action: 'activationComboChanged', value: currentCombo });
      resetRecorderUI();
      setComboStatus('Shortcut saved!', 'success');
    });
  });

  resetComboBtn.addEventListener('click', () => {
    const def = defaultCombo();
    chrome.storage.sync.set({ activationCombo: def }, () => {
      currentCombo = def;
      renderCombo(currentCombo);
      notifyAllTabs({ action: 'activationComboChanged', value: currentCombo });
      resetRecorderUI();
      setComboStatus('Reset to default.', 'success');
    });
  });

  function notifyAllTabs(msg) {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, msg).catch(() => {}));
    });
  }

  function showStatus(msg, type) {
    statusDiv.textContent = msg;
    statusDiv.className = `status ${type}`;
    setTimeout(() => { statusDiv.textContent = ''; statusDiv.className = 'status'; }, 3000);
  }
});
