/**
 * X Region Highlighter — Page Context Script (MAIN World)
 *
 * Runs inside the x.com / twitter.com page context to:
 * 1. Capture X's own live GraphQL headers (Authorization + X-Csrf-Token).
 * 2. Passively observe X's own GraphQL responses if they contain `about_profile`.
 * 3. Query X's internal `AboutAccountQuery` endpoint (`XRqGa7EeokUU5kppkh13EA`)
 *    with polite rate-limiting, deduplication, and GET/POST bucket fallback.
 *
 * PRIVACY GUARANTEE:
 * Only communicates with same-origin `/i/api/graphql/...` on x.com / twitter.com.
 * Zero external network calls.
 */

(function () {
  'use strict';

  if (window.__XRH_MAIN_INJECTED__) return;
  window.__XRH_MAIN_INJECTED__ = true;

  const ABOUT_QUERY_ID = 'XRqGa7EeokUU5kppkh13EA';
  const GRAPHQL_PATH_RE = /\/i\/api\/graphql\//;

  // X's standard public web-client bearer token (embedded in x.com's own bundle)
  const PUBLIC_BEARER_TOKEN =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const EVENT_FETCH_REQ = 'xrh-fetch-account';
  const EVENT_FETCH_RES = 'xrh-fetch-account-result';
  const EVENT_PASSIVE_DATA = 'xrh-passive-about-data';

  let capturedHeaders = null;

  function readCsrfCookie() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    } catch (_) {
      return null;
    }
  }

  function normalizeHeadersObject(rawHeaders) {
    if (!rawHeaders) return null;
    let obj = {};
    if (rawHeaders instanceof Headers) {
      for (const [k, v] of rawHeaders.entries()) {
        obj[k.toLowerCase()] = v;
      }
    } else if (Array.isArray(rawHeaders)) {
      for (const pair of rawHeaders) {
        if (Array.isArray(pair) && pair.length >= 2) {
          obj[String(pair[0]).toLowerCase()] = String(pair[1]);
        }
      }
    } else if (typeof rawHeaders === 'object') {
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (typeof v === 'string') {
          obj[k.toLowerCase()] = v;
        }
      }
    }
    return obj;
  }

  function tryCaptureHeaders(rawHeaders) {
    const obj = normalizeHeadersObject(rawHeaders);
    if (!obj) return;
    if (!obj['authorization'] || !obj['x-csrf-token']) return;

    // Keep safe standard X headers for GraphQL calls
    const allowed = [
      'authorization',
      'x-csrf-token',
      'x-twitter-active-user',
      'x-twitter-auth-type',
      'x-twitter-client-language'
    ];
    const clean = {};
    for (const key of allowed) {
      if (obj[key]) clean[key] = obj[key];
    }
    capturedHeaders = clean;
  }

  function buildRequestHeaders() {
    const csrf = readCsrfCookie();
    if (capturedHeaders) {
      return {
        ...capturedHeaders,
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json'
      };
    }
    if (!csrf) return null;
    return {
      'authorization': PUBLIC_BEARER_TOKEN,
      'x-csrf-token': csrf,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json'
    };
  }

  function parseAboutResponse(json, requestedScreenName) {
    const user = json?.data?.user_result_by_screen_name?.result;
    if (!user || typeof user !== 'object') {
      return null;
    }

    const returnedName = user?.core?.screen_name;
    if (
      requestedScreenName &&
      returnedName &&
      returnedName.toLowerCase() !== requestedScreenName.toLowerCase()
    ) {
      return null;
    }

    const profile = user?.about_profile;
    if (!profile || typeof profile !== 'object') {
      return {
        basedIn: null,
        connectedVia: null,
        locationAccurate: true,
        createdCountryAccurate: null,
        createdAt: user?.core?.created_at || null
      };
    }

    return {
      basedIn: typeof profile.account_based_in === 'string' && profile.account_based_in.trim()
        ? profile.account_based_in.trim()
        : null,
      connectedVia: typeof profile.source === 'string' && profile.source.trim()
        ? profile.source.trim()
        : null,
      locationAccurate: profile.location_accurate !== false,
      createdCountryAccurate: typeof profile.created_country_accurate === 'boolean'
        ? profile.created_country_accurate
        : null,
      createdAt: user?.core?.created_at || null
    };
  }

  /**
   * Passively walk GraphQL payloads to see if X already included `about_profile`
   * on any `User` object (saves API calls when present).
   */
  function harvestPassiveAboutProfiles(data) {
    if (!data || typeof data !== 'object') return;
    const found = [];
    const visited = new Set();
    const stack = [data];
    let steps = 0;
    const MAX_STEPS = 80000;

    while (stack.length > 0 && steps < MAX_STEPS) {
      steps++;
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (visited.has(node)) continue;
      visited.add(node);

      const screenName = node?.core?.screen_name || node?.legacy?.screen_name;
      const about = node?.about_profile;
      if (
        typeof screenName === 'string' &&
        screenName.length > 0 &&
        about &&
        typeof about === 'object' &&
        (about.account_based_in || about.source)
      ) {
        found.push({
          screenName: screenName.toLowerCase(),
          basedIn: typeof about.account_based_in === 'string' ? about.account_based_in.trim() : null,
          connectedVia: typeof about.source === 'string' ? about.source.trim() : null,
          locationAccurate: about.location_accurate !== false,
          createdCountryAccurate:
            typeof about.created_country_accurate === 'boolean' ? about.created_country_accurate : null,
          createdAt: node?.core?.created_at || node?.legacy?.created_at || null
        });
      }

      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) stack.push(node[i]);
      } else {
        for (const k in node) {
          if (Object.prototype.hasOwnProperty.call(node, k)) {
            stack.push(node[k]);
          }
        }
      }
    }

    if (found.length > 0) {
      window.dispatchEvent(
        new CustomEvent(EVENT_PASSIVE_DATA, {
          detail: JSON.stringify({ entries: found })
        })
      );
    }
  }

  // Intercept window.fetch for same-origin GraphQL header capture
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input?.url || '';
      if (url && GRAPHQL_PATH_RE.test(url)) {
        if (init?.headers) tryCaptureHeaders(init.headers);
        else if (input?.headers) tryCaptureHeaders(input.headers);
      }
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  // Intercept XMLHttpRequest for same-origin GraphQL header capture + passive harvest
  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__xrhUrl = typeof url === 'string' ? url : String(url || '');
      this.__xrhHeaders = {};
    } catch (_) {}
    return origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (this.__xrhHeaders && typeof name === 'string') {
        this.__xrhHeaders[name.toLowerCase()] = value;
      }
    } catch (_) {}
    return origXHRSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    try {
      if (this.__xrhUrl && GRAPHQL_PATH_RE.test(this.__xrhUrl)) {
        tryCaptureHeaders(this.__xrhHeaders);
        this.addEventListener(
          'loadend',
          function () {
            try {
              if (this.status >= 200 && this.status < 300) {
                let parsed = null;
                if (this.responseType === 'json') {
                  parsed = this.response;
                } else if (!this.responseType || this.responseType === 'text') {
                  if (this.responseText && this.responseText.length < 4 * 1024 * 1024) {
                    parsed = JSON.parse(this.responseText);
                  }
                }
                if (parsed) harvestPassiveAboutProfiles(parsed);
              }
            } catch (_) {}
          },
          { once: true }
        );
      }
    } catch (_) {}
    return origXHRSend.apply(this, arguments);
  };

  // Polite rate-limited queue with GET / POST bucket switching on 429
  const queue = [];
  const inFlight = new Map(); // screenName -> Promise
  let activeCount = 0;
  let lastRequestAt = 0;
  const MAX_CONCURRENT = 3;
  const MIN_INTERVAL_MS = 220;
  const DEFAULT_429_COOLDOWN_MS = 3 * 60 * 1000;

  let usePostBucket = false;
  let getBucketResetAt = 0;
  let postBucketResetAt = 0;
  let globalRateLimitUntil = 0;
  let pumpTimer = null;

  function readRateLimitDeadline(headers) {
    const now = Date.now();
    try {
      const resetSec = Number(headers?.get('x-rate-limit-reset'));
      if (Number.isFinite(resetSec) && resetSec * 1000 > now) {
        return resetSec * 1000;
      }
      const retryAfter = headers?.get('retry-after');
      if (retryAfter) {
        const sec = Number(retryAfter);
        if (Number.isFinite(sec) && sec > 0) return now + sec * 1000;
      }
    } catch (_) {}
    return now + DEFAULT_429_COOLDOWN_MS;
  }

  function schedulePump(delayMs = 0) {
    if (pumpTimer !== null) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      pumpQueue();
    }, Math.max(0, delayMs));
  }

  function pumpQueue() {
    if (queue.length === 0) return;
    if (activeCount >= MAX_CONCURRENT) return;

    const now = Date.now();
    if (globalRateLimitUntil > now) {
      const err = Object.assign(new Error('Rate limited by X API'), {
        code: 'RATE_LIMITED',
        retryAfter: globalRateLimitUntil
      });
      while (queue.length > 0) {
        const item = queue.shift();
        item.reject(err);
      }
      return;
    }

    const elapsed = now - lastRequestAt;
    if (elapsed < MIN_INTERVAL_MS) {
      schedulePump(MIN_INTERVAL_MS - elapsed);
      return;
    }

    const item = queue.shift();
    if (!item) return;

    activeCount++;
    lastRequestAt = Date.now();

    executeLookup(item.screenName)
      .then(item.resolve, item.reject)
      .finally(() => {
        activeCount--;
        if (queue.length > 0) schedulePump(MIN_INTERVAL_MS);
      });

    if (queue.length > 0 && activeCount < MAX_CONCURRENT) {
      schedulePump(MIN_INTERVAL_MS);
    }
  }

  async function executeLookup(screenName, attempt = 0) {
    const headers = buildRequestHeaders();
    if (!headers) {
      throw Object.assign(new Error('Waiting for X session token'), { code: 'NO_HEADERS' });
    }

    const now = Date.now();
    if (usePostBucket && now < postBucketResetAt) usePostBucket = false;
    if (!usePostBucket && now < getBucketResetAt) usePostBucket = true;
    const method = usePostBucket ? 'POST' : 'GET';

    const variables = encodeURIComponent(JSON.stringify({ screenName }));
    const url = `/i/api/graphql/${ABOUT_QUERY_ID}/AboutAccountQuery?variables=${variables}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);

    try {
      const res = await origFetch(url, {
        method,
        headers,
        credentials: 'include',
        signal: controller.signal
      });

      if (res.status === 429) {
        const deadline = readRateLimitDeadline(res.headers);
        if (method === 'POST') {
          postBucketResetAt = deadline;
          usePostBucket = false;
        } else {
          getBucketResetAt = deadline;
          usePostBucket = true;
        }

        const bothExhausted = Date.now() < getBucketResetAt && Date.now() < postBucketResetAt;
        if (!bothExhausted && attempt < 1) {
          // Immediately retry once using the other HTTP method bucket
          return executeLookup(screenName, attempt + 1);
        }

        globalRateLimitUntil = Math.min(
          getBucketResetAt || deadline,
          postBucketResetAt || deadline
        );
        throw Object.assign(new Error('Rate limit reached'), {
          code: 'RATE_LIMITED',
          retryAfter: globalRateLimitUntil
        });
      }

      if (res.status === 401 || res.status === 403) {
        capturedHeaders = null;
        throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'UNAUTHORIZED' });
      }

      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'HTTP_ERROR' });
      }

      const json = await res.json();
      const parsed = parseAboutResponse(json, screenName);
      if (!parsed) {
        throw Object.assign(new Error('Empty or mismatched profile'), { code: 'NOT_FOUND' });
      }
      return parsed;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function queueAccountLookup(screenName) {
    const key = String(screenName || '').trim().toLowerCase();
    if (inFlight.has(key)) {
      return inFlight.get(key);
    }
    const promise = new Promise((resolve, reject) => {
      queue.push({ screenName: key, resolve, reject });
      pumpQueue();
    }).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  window.addEventListener(EVENT_FETCH_REQ, async (event) => {
    let detail = {};
    try {
      detail = JSON.parse(event.detail || '{}');
    } catch (_) {
      return;
    }
    const { requestId, screenName } = detail;
    if (!requestId || !screenName) return;

    try {
      const data = await queueAccountLookup(screenName);
      window.dispatchEvent(
        new CustomEvent(EVENT_FETCH_RES, {
          detail: JSON.stringify({
            requestId,
            screenName,
            success: true,
            data
          })
        })
      );
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent(EVENT_FETCH_RES, {
          detail: JSON.stringify({
            requestId,
            screenName,
            success: false,
            error: err?.message || 'Lookup failed',
            code: err?.code || 'ERROR',
            retryAfter: err?.retryAfter || null
          })
        })
      );
    }
  });
})();
