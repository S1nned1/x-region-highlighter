/**
 * X Region Highlighter — Background Service Worker (Manifest V3)
 * Zero external servers. Zero telemetry.
 * Manages extension badge state and default settings initialization.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  highlightSouthAsia: true,
  highlightNonUS: true,
  showUSBadge: true,
  checkConnectedVia: true,
  flagVpnMismatch: true
};

const SETTINGS_KEY = 'xrh_settings_v1';

function updateActionBadge(enabled, rateLimitedUntil = 0) {
  if (!chrome.action) return;
  const now = Date.now();
  if (!enabled) {
    chrome.action.setBadgeBackgroundColor({ color: '#64748b' });
    chrome.action.setBadgeText({ text: 'OFF' });
  } else if (rateLimitedUntil && rateLimitedUntil > now) {
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    chrome.action.setBadgeText({ text: 'WAIT' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const stored = await chrome.storage.local.get([SETTINGS_KEY]);
    const merged = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
    updateActionBadge(merged.enabled !== false);
  } catch (err) {
    console.warn('[X-Region-Highlighter] Failed to initialize default settings:', err);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    const stored = await chrome.storage.local.get([SETTINGS_KEY, 'xrh_rate_limit_until']);
    const settings = { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
    updateActionBadge(settings.enabled !== false, stored.xrh_rate_limit_until || 0);
  } catch (_) {}
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SETTINGS_KEY] || changes.xrh_rate_limit_until) {
    chrome.storage.local.get([SETTINGS_KEY, 'xrh_rate_limit_until'], (data) => {
      const settings = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
      updateActionBadge(settings.enabled !== false, data.xrh_rate_limit_until || 0);
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'XRH_STATUS_UPDATE') {
    if (typeof msg.rateLimitedUntil === 'number') {
      chrome.storage.local.set({ xrh_rate_limit_until: msg.rateLimitedUntil });
    }
    chrome.storage.local.get([SETTINGS_KEY], (data) => {
      const settings = { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
      updateActionBadge(settings.enabled !== false, msg.rateLimitedUntil || 0);
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
