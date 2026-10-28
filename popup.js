/**
 * X Region Highlighter — Popup Controller
 * Manages toggles, live cache breakdown, and JSON cache export/import.
 */

(function () {
  'use strict';

  const SETTINGS_KEY = 'xrh_settings_v1';
  const CACHE_KEY = 'xrh_account_cache_v1';

  const DEFAULT_SETTINGS = {
    enabled: true,
    highlightSouthAsia: true,
    highlightNonUS: true,
    showUSBadge: true,
    checkConnectedVia: true,
    flagVpnMismatch: true
  };

  const US_LOCATIONS = new Set([
    'united states', 'united states of america', 'usa', 'us', 'america',
    'puerto rico', 'guam', 'us virgin islands', 'u.s. virgin islands',
    'united states virgin islands', 'american samoa', 'northern mariana islands'
  ]);

  const SOUTH_ASIA_LOCATIONS = new Set([
    'south asia', 'southern asia', 'india', 'pakistan', 'bangladesh',
    'sri lanka', 'nepal', 'bhutan', 'maldives', 'afghanistan'
  ]);

  const elEnabled = document.getElementById('toggle-enabled');
  const elSouthAsia = document.getElementById('toggle-south-asia');
  const elNonUS = document.getElementById('toggle-non-us');
  const elUSBadge = document.getElementById('toggle-us-badge');
  const elConnectedVia = document.getElementById('toggle-connected-via');
  const elVpnMismatch = document.getElementById('toggle-vpn-mismatch');

  const statTotal = document.getElementById('stat-total');
  const statUS = document.getElementById('stat-us');
  const statSA = document.getElementById('stat-sa');
  const statNonUS = document.getElementById('stat-nonus');

  const btnExport = document.getElementById('btn-export');
  const btnImport = document.getElementById('btn-import');
  const btnClear = document.getElementById('btn-clear');
  const fileImport = document.getElementById('file-import');
  const statusMsg = document.getElementById('status-msg');

  let currentSettings = { ...DEFAULT_SETTINGS };

  function showStatus(text, isError = false) {
    statusMsg.textContent = text;
    statusMsg.style.color = isError ? '#fca5a5' : '#4ade80';
    setTimeout(() => {
      if (statusMsg.textContent === text) {
        statusMsg.textContent = '';
      }
    }, 3000);
  }

  function normalizeLoc(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function extractViaLoc(source) {
    if (!source || typeof source !== 'string') return '';
    const lower = source.trim().toLowerCase();
    if (lower === 'web' || lower.startsWith('twitter for ') || lower.startsWith('x for ')) {
      return '';
    }
    return lower
      .replace(/\s+(?:app\s+store|android\s+app|ios\s+app|google\s+play|play\s+store|web\s+app|ipad\s+app|iphone\s+app|mac\s+app|app|client)$/i, '')
      .trim();
  }

  function classifyForStats(entry, checkVia) {
    if (!entry || typeof entry !== 'object') return 'unknown';
    const b = normalizeLoc(entry.b || entry.basedIn);
    const v = checkVia ? normalizeLoc(extractViaLoc(entry.v || entry.connectedVia)) : '';

    if (SOUTH_ASIA_LOCATIONS.has(b) || (v && SOUTH_ASIA_LOCATIONS.has(v))) {
      return 'south_asia';
    }
    const bIsUS = US_LOCATIONS.has(b);
    const vIsUS = US_LOCATIONS.has(v);
    const bIsNonUS = Boolean(b && !bIsUS);
    const vIsNonUS = Boolean(v && !vIsUS);

    if (bIsNonUS || vIsNonUS) return 'non_us';
    if (bIsUS || vIsUS) return 'us';
    return 'unknown';
  }

  function refreshStats() {
    chrome.storage.local.get([CACHE_KEY, SETTINGS_KEY], (data) => {
      const settings = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
      const cache = data[CACHE_KEY] || {};
      const entries = Object.values(cache);

      let total = 0;
      let us = 0;
      let sa = 0;
      let nonus = 0;

      for (const entry of entries) {
        if (!entry || (!entry.b && !entry.v)) continue;
        total++;
        const tier = classifyForStats(entry, settings.checkConnectedVia);
        if (tier === 'south_asia') sa++;
        else if (tier === 'non_us') nonus++;
        else if (tier === 'us') us++;
      }

      statTotal.textContent = total.toLocaleString();
      statUS.textContent = us.toLocaleString();
      statSA.textContent = sa.toLocaleString();
      statNonUS.textContent = nonus.toLocaleString();
    });
  }

  function saveSettings() {
    currentSettings = {
      enabled: elEnabled.checked,
      highlightSouthAsia: elSouthAsia.checked,
      highlightNonUS: elNonUS.checked,
      showUSBadge: elUSBadge.checked,
      checkConnectedVia: elConnectedVia.checked,
      flagVpnMismatch: elVpnMismatch.checked
    };
    chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings }, () => {
      refreshStats();
      showStatus('Settings saved & applied');
    });
  }

  function init() {
    chrome.storage.local.get([SETTINGS_KEY], (data) => {
      currentSettings = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
      elEnabled.checked = currentSettings.enabled !== false;
      elSouthAsia.checked = currentSettings.highlightSouthAsia !== false;
      elNonUS.checked = currentSettings.highlightNonUS !== false;
      elUSBadge.checked = currentSettings.showUSBadge !== false;
      elConnectedVia.checked = currentSettings.checkConnectedVia !== false;
      elVpnMismatch.checked = currentSettings.flagVpnMismatch !== false;
      refreshStats();
    });
  }

  [elEnabled, elSouthAsia, elNonUS, elUSBadge, elConnectedVia, elVpnMismatch].forEach((input) => {
    input.addEventListener('change', saveSettings);
  });

  btnClear.addEventListener('click', () => {
    chrome.storage.local.remove(CACHE_KEY, () => {
      chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] }, (tabs) => {
        for (const tab of tabs || []) {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, { type: 'XRH_CLEAR_CACHE' }).catch(() => {});
          }
        }
      });
      refreshStats();
      showStatus('Local cache cleared');
    });
  });

  btnExport.addEventListener('click', () => {
    chrome.storage.local.get([CACHE_KEY], (data) => {
      const cache = data[CACHE_KEY] || {};
      const payload = {
        extension: 'x-region-highlighter',
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        accountCount: Object.keys(cache).length,
        accounts: cache
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `x-region-cache-${dateStr}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showStatus(`Exported ${Object.keys(cache).length.toLocaleString()} accounts`);
    });
  });

  btnImport.addEventListener('click', () => {
    fileImport.value = '';
    fileImport.click();
  });

  fileImport.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        const incoming = parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : parsed;
        if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
          throw new Error('Invalid JSON structure');
        }
        chrome.storage.local.get([CACHE_KEY], (data) => {
          const existing = data[CACHE_KEY] || {};
          let importedCount = 0;
          for (const [handle, record] of Object.entries(incoming)) {
            if (!handle || typeof record !== 'object' || !record) continue;
            const cleanHandle = handle.trim().toLowerCase().replace(/^@/, '');
            if (!/^[a-z0-9_]{1,15}$/.test(cleanHandle)) continue;
            existing[cleanHandle] = {
              b: typeof record.b === 'string' ? record.b : typeof record.basedIn === 'string' ? record.basedIn : typeof record.country === 'string' ? record.country : null,
              v: typeof record.v === 'string' ? record.v : typeof record.connectedVia === 'string' ? record.connectedVia : typeof record.device === 'string' ? record.device : null,
              a: record.a !== false && record.locationAccurate !== false,
              c: typeof record.c === 'boolean' ? record.c : null,
              t: Number.isFinite(record.t) ? record.t : Date.now()
            };
            importedCount++;
          }
          chrome.storage.local.set({ [CACHE_KEY]: existing }, () => {
            refreshStats();
            showStatus(`Imported ${importedCount.toLocaleString()} accounts`);
          });
        });
      } catch (err) {
        showStatus('Invalid JSON file', true);
      }
    };
    reader.readAsText(file);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[CACHE_KEY]) {
      refreshStats();
    }
  });

  init();
})();
