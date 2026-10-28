/**
 * X Region Highlighter — Content Script (ISOLATED World)
 *
 * Highlights Non-US and South Asia posts & replies on x.com / twitter.com
 * using X's built-in "Account based in" and "Connected via" metadata.
 *
 * Zero external servers. 100% local cache in chrome.storage.local.
 */

(function () {
  'use strict';

  if (window.__XRH_CONTENT_LOADED__) return;
  window.__XRH_CONTENT_LOADED__ = true;

  const SETTINGS_KEY = 'xrh_settings_v1';
  const CACHE_KEY = 'xrh_account_cache_v1';
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const UNKNOWN_TTL_MS = 15 * 60 * 1000;         // 15 minutes for empty records
  const MAX_CACHE_ENTRIES = 40000;

  const EVENT_FETCH_REQ = 'xrh-fetch-account';
  const EVENT_FETCH_RES = 'xrh-fetch-account-result';
  const EVENT_PASSIVE_DATA = 'xrh-passive-about-data';

  const DEFAULT_SETTINGS = {
    enabled: true,
    highlightSouthAsia: true,
    highlightNonUS: true,
    showUSBadge: true,
    checkConnectedVia: true,
    flagVpnMismatch: true
  };

  let settings = { ...DEFAULT_SETTINGS };

  // In-memory handle cache: handle -> { b: basedIn, v: connectedVia, a: locationAccurate, c: createdCountryAccurate, t: timestamp }
  const memoryCache = new Map();
  const pendingRequests = new Map(); // handle -> Promise
  let cacheDirty = false;
  let saveTimer = null;

  const RESERVED_PATHS = new Set([
    'home', 'explore', 'notifications', 'messages', 'settings', 'i',
    'search', 'compose', 'topics', 'lists', 'bookmarks', 'communities',
    'communitynotes', 'jobs', 'grok', 'premium', 'tos', 'privacy', 'login', 'logout'
  ]);

  // Tier 1: United States & US territories
  const US_LOCATIONS = new Set([
    'united states',
    'united states of america',
    'usa',
    'us',
    'america',
    'puerto rico',
    'guam',
    'us virgin islands',
    'u.s. virgin islands',
    'united states virgin islands',
    'american samoa',
    'northern mariana islands',
    'united states minor outlying islands'
  ]);

  // Tier 2: South Asia regional labels and constituent countries
  const SOUTH_ASIA_LOCATIONS = new Set([
    'south asia',
    'southern asia',
    'india',
    'pakistan',
    'bangladesh',
    'sri lanka',
    'nepal',
    'bhutan',
    'maldives',
    'afghanistan'
  ]);

  const COUNTRY_ALIASES = {
    'united states of america': 'united states',
    'usa': 'united states',
    'us': 'united states',
    'america': 'united states',
    'uk': 'united kingdom',
    'great britain': 'united kingdom',
    'britain': 'united kingdom',
    'united kingdom of great britain and northern ireland': 'united kingdom',
    'uae': 'united arab emirates',
    'russian federation': 'russia',
    'republic of korea': 'south korea',
    'korea': 'south korea',
    "democratic people's republic of korea": 'north korea',
    'türkiye': 'turkey',
    'turkiye': 'turkey',
    'viet nam': 'vietnam',
    'czechia': 'czech republic',
    'burma': 'myanmar',
    'iran (islamic republic of)': 'iran',
    'venezuela (bolivarian republic of)': 'venezuela',
    'bolivia (plurinational state of)': 'bolivia',
    'syrian arab republic': 'syria',
    'republic of moldova': 'moldova',
    'cabo verde': 'cape verde',
    'swaziland': 'eswatini',
    'dr congo': 'democratic republic of the congo',
    'congo-kinshasa': 'democratic republic of the congo',
    'republic of the congo': 'congo',
    'congo-brazzaville': 'congo',
    "cote d'ivoire": 'ivory coast',
    'macau': 'macao',
    'east timor': 'timor-leste',
    'reunion': 'réunion',
    'curacao': 'curaçao',
    'u.s. virgin islands': 'us virgin islands',
    'united states virgin islands': 'us virgin islands'
  };

  const COUNTRY_FLAGS = {
    'afghanistan': '🇦🇫', 'albania': '🇦🇱', 'algeria': '🇩🇿', 'andorra': '🇦🇩', 'angola': '🇦🇴',
    'antigua and barbuda': '🇦🇬', 'argentina': '🇦🇷', 'armenia': '🇦🇲', 'australia': '🇦🇺', 'austria': '🇦🇹',
    'azerbaijan': '🇦🇿', 'bahamas': '🇧🇸', 'bahrain': '🇧🇭', 'bangladesh': '🇧🇩', 'barbados': '🇧🇧',
    'belarus': '🇧🇾', 'belgium': '🇧🇪', 'belize': '🇧🇿', 'benin': '🇧🇯', 'bhutan': '🇧🇹',
    'bolivia': '🇧🇴', 'bosnia and herzegovina': '🇧🇦', 'bosnia': '🇧🇦', 'botswana': '🇧🇼', 'brazil': '🇧🇷',
    'brunei': '🇧🇳', 'bulgaria': '🇧🇬', 'burkina faso': '🇧🇫', 'burundi': '🇧🇮', 'cambodia': '🇰🇭',
    'cameroon': '🇨🇲', 'canada': '🇨🇦', 'cape verde': '🇨🇻', 'central african republic': '🇨🇫', 'chad': '🇹🇩',
    'chile': '🇨🇱', 'china': '🇨🇳', 'colombia': '🇨🇴', 'comoros': '🇰🇲', 'congo': '🇨🇬',
    'costa rica': '🇨🇷', 'croatia': '🇭🇷', 'cuba': '🇨🇺', 'cyprus': '🇨🇾', 'czech republic': '🇨🇿',
    'democratic republic of the congo': '🇨🇩', 'denmark': '🇩🇰', 'djibouti': '🇩🇯', 'dominica': '🇩🇲',
    'dominican republic': '🇩🇴', 'ecuador': '🇪🇨', 'egypt': '🇪🇬', 'el salvador': '🇸🇻',
    'england': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'equatorial guinea': '🇬🇶', 'eritrea': '🇪🇷', 'estonia': '🇪🇪', 'eswatini': '🇸🇿',
    'ethiopia': '🇪🇹', 'europe': '🇪🇺', 'european union': '🇪🇺', 'fiji': '🇫🇯', 'finland': '🇫🇮',
    'france': '🇫🇷', 'gabon': '🇬🇦', 'gambia': '🇬🇲', 'georgia': '🇬🇪', 'germany': '🇩🇪',
    'ghana': '🇬🇭', 'greece': '🇬🇷', 'grenada': '🇬🇩', 'guatemala': '🇬🇹', 'guinea': '🇬🇳',
    'guinea-bissau': '🇬🇼', 'guyana': '🇬🇾', 'haiti': '🇭🇹', 'honduras': '🇭🇳', 'hong kong': '🇭🇰',
    'hungary': '🇭🇺', 'iceland': '🇮🇸', 'india': '🇮🇳', 'indonesia': '🇮🇩', 'iran': '🇮🇷',
    'iraq': '🇮🇶', 'ireland': '🇮🇪', 'israel': '🇮🇱', 'italy': '🇮🇹', 'ivory coast': '🇨🇮',
    'jamaica': '🇯🇲', 'japan': '🇯🇵', 'jordan': '🇯🇴', 'kazakhstan': '🇰🇿', 'kenya': '🇰🇪',
    'kiribati': '🇰🇮', 'kosovo': '🇽🇰', 'kuwait': '🇰🇼', 'kyrgyzstan': '🇰🇬',
    'laos': '🇱🇦', 'latvia': '🇱🇻', 'lebanon': '🇱🇧', 'lesotho': '🇱🇸', 'liberia': '🇱🇷',
    'libya': '🇱🇾', 'liechtenstein': '🇱🇮', 'lithuania': '🇱🇹', 'luxembourg': '🇱🇺', 'macao': '🇲🇴',
    'madagascar': '🇲🇬', 'malawi': '🇲🇼', 'malaysia': '🇲🇾', 'maldives': '🇲🇻',
    'mali': '🇲🇱', 'malta': '🇲🇹', 'marshall islands': '🇲🇭', 'mauritania': '🇲🇷', 'mauritius': '🇲🇺',
    'mexico': '🇲🇽', 'micronesia': '🇫🇲', 'moldova': '🇲🇩', 'monaco': '🇲🇨', 'mongolia': '🇲🇳',
    'montenegro': '🇲🇪', 'morocco': '🇲🇦', 'mozambique': '🇲🇿', 'myanmar': '🇲🇲',
    'namibia': '🇳🇦', 'nauru': '🇳🇷', 'nepal': '🇳🇵', 'netherlands': '🇳🇱', 'new zealand': '🇳🇿',
    'nicaragua': '🇳🇮', 'niger': '🇳🇪', 'nigeria': '🇳🇬', 'north korea': '🇰🇵', 'north macedonia': '🇲🇰',
    'norway': '🇳🇴', 'oman': '🇴🇲', 'pakistan': '🇵🇰', 'palau': '🇵🇼',
    'palestine': '🇵🇸', 'panama': '🇵🇦', 'papua new guinea': '🇵🇬', 'paraguay': '🇵🇾', 'peru': '🇵🇪',
    'philippines': '🇵🇭', 'poland': '🇵🇱', 'portugal': '🇵🇹', 'puerto rico': '🇵🇷', 'qatar': '🇶🇦',
    'romania': '🇷🇴', 'russia': '🇷🇺', 'rwanda': '🇷🇼', 'saint kitts and nevis': '🇰🇳',
    'saint lucia': '🇱🇨', 'saint vincent and the grenadines': '🇻🇨', 'samoa': '🇼🇸', 'san marino': '🇸🇲',
    'sao tome and principe': '🇸🇹', 'saudi arabia': '🇸🇦', 'scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'senegal': '🇸🇳',
    'serbia': '🇷🇸', 'seychelles': '🇸🇨', 'sierra leone': '🇸🇱', 'singapore': '🇸🇬', 'slovakia': '🇸🇰',
    'slovenia': '🇸🇮', 'solomon islands': '🇸🇧', 'somalia': '🇸🇴', 'south africa': '🇿🇦',
    'south korea': '🇰🇷', 'south sudan': '🇸🇸', 'spain': '🇪🇸', 'sri lanka': '🇱🇰', 'sudan': '🇸🇩',
    'suriname': '🇸🇷', 'sweden': '🇸🇪', 'switzerland': '🇨🇭', 'syria': '🇸🇾', 'taiwan': '🇹🇼',
    'tajikistan': '🇹🇯', 'tanzania': '🇹🇿', 'thailand': '🇹🇭', 'timor-leste': '🇹🇱', 'togo': '🇹🇬',
    'tonga': '🇹🇴', 'trinidad and tobago': '🇹🇹', 'tunisia': '🇹🇳', 'turkey': '🇹🇷',
    'turkmenistan': '🇹🇲', 'tuvalu': '🇹🇻', 'uganda': '🇺🇬', 'ukraine': '🇺🇦',
    'united arab emirates': '🇦🇪', 'united kingdom': '🇬🇧', 'united states': '🇺🇸',
    'uruguay': '🇺🇾', 'uzbekistan': '🇺🇿', 'vanuatu': '🇻🇺', 'vatican city': '🇻🇦', 'venezuela': '🇻🇪',
    'vietnam': '🇻🇳', 'wales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿', 'yemen': '🇾🇪', 'zambia': '🇿🇲', 'zimbabwe': '🇿🇼',
    'aland islands': '🇦🇽', 'american samoa': '🇦🇸', 'anguilla': '🇦🇮', 'aruba': '🇦🇼', 'bermuda': '🇧🇲',
    'bonaire': '🇧🇶', 'british virgin islands': '🇻🇬', 'cayman islands': '🇰🇾', 'christmas island': '🇨🇽',
    'cook islands': '🇨🇰', 'curaçao': '🇨🇼', 'falkland islands': '🇫🇰', 'faroe islands': '🇫🇴',
    'french guiana': '🇬🇫', 'french polynesia': '🇵🇫', 'gibraltar': '🇬🇮', 'greenland': '🇬🇱',
    'guadeloupe': '🇬🇵', 'guam': '🇬🇺', 'guernsey': '🇬🇬', 'isle of man': '🇮🇲', 'jersey': '🇯🇪',
    'martinique': '🇲🇶', 'mayotte': '🇾🇹', 'montserrat': '🇲🇸', 'new caledonia': '🇳🇨',
    'norfolk island': '🇳🇫', 'northern mariana islands': '🇲🇵', 'niue': '🇳🇺', 'réunion': '🇷🇪',
    'saint barthelemy': '🇧🇱', 'saint helena': '🇸🇭', 'saint martin': '🇲🇫',
    'saint pierre and miquelon': '🇵🇲', 'sint maarten': '🇸🇽', 'svalbard': '🇸🇯', 'tokelau': '🇹🇰',
    'turks and caicos islands': '🇹🇨', 'us virgin islands': '🇻🇮', 'wallis and futuna': '🇼🇫',
    'western sahara': '🇪🇭', 'antarctica': '🇦🇶'
  };

  const REGION_FLAGS = {
    'south asia': '🌏',
    'southern asia': '🌏',
    'east asia': '🌏',
    'southeast asia': '🌏',
    'south-east asia': '🌏',
    'central asia': '🌏',
    'east asia & pacific': '🌏',
    'east asia and pacific': '🌏',
    'asia': '🌏',
    'oceania': '🌏',
    'australasia': '🌏',
    'west asia': '🌍',
    'middle east': '🌍',
    'africa': '🌍',
    'north africa': '🌍',
    'sub-saharan africa': '🌍',
    'europe': '🇪🇺',
    'eastern europe (non-eu)': '🌍',
    'north america': '🌎',
    'central america': '🌎',
    'caribbean': '🌎',
    'south america': '🌎',
    'latin america': '🌎'
  };

  function normalizeLocation(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const cleaned = raw
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/\s+/g, ' ');
    if (!cleaned || cleaned === 'unknown' || cleaned === 'null' || cleaned === 'none' || cleaned === 'n/a') {
      return '';
    }
    return COUNTRY_ALIASES[cleaned] || cleaned;
  }

  function formatLocationName(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (!trimmed) return '';
    const lower = normalizeLocation(trimmed);
    if (lower === 'united states') return 'United States';
    if (lower === 'united kingdom') return 'United Kingdom';
    if (lower === 'united arab emirates') return 'UAE';
    if (lower === 'south asia' || lower === 'southern asia') return 'South Asia';
    return trimmed
      .split(/\s+/)
      .map((w) => {
        const lw = w.toLowerCase();
        if (lw === 'and' || lw === 'of' || lw === 'the') return lw;
        if (lw === '(non-eu)') return '(Non-EU)';
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      })
      .join(' ');
  }

  /**
   * Extract the country or region name from X's `about_profile.source` ("Connected via") string.
   * Examples:
   * - "India App Store" -> "india"
   * - "South Asia Android App" -> "south asia"
   * - "United States App Store" -> "united states"
   * - "Russian Federation Android App" -> "russia"
   * - "Web" / "Twitter for iPhone" -> ""
   */
  function extractConnectedViaRegion(source) {
    if (!source || typeof source !== 'string') return '';
    const s = source.trim();
    if (!s) return '';

    const lower = s.toLowerCase();
    if (
      lower === 'web' ||
      lower === 'x for web' ||
      lower === 'twitter web app' ||
      lower.startsWith('twitter for ') ||
      lower.startsWith('x for ')
    ) {
      return '';
    }

    // Strip known platform suffixes first
    const stripped = s
      .replace(/\s+(?:app\s+store|android\s+app|ios\s+app|google\s+play|play\s+store|web\s+app|ipad\s+app|iphone\s+app|mac\s+app|app|client)$/i, '')
      .trim();

    const normStripped = normalizeLocation(stripped);
    if (
      normStripped &&
      (Object.prototype.hasOwnProperty.call(COUNTRY_FLAGS, normStripped) ||
        Object.prototype.hasOwnProperty.call(REGION_FLAGS, normStripped) ||
        US_LOCATIONS.has(normStripped) ||
        SOUTH_ASIA_LOCATIONS.has(normStripped))
    ) {
      return normStripped;
    }

    // Fallback: peel words from the end until prefix matches a known country or region
    const words = lower.split(/\s+/);
    for (let i = words.length; i > 0; i--) {
      const candidate = normalizeLocation(words.slice(0, i).join(' '));
      if (
        Object.prototype.hasOwnProperty.call(COUNTRY_FLAGS, candidate) ||
        Object.prototype.hasOwnProperty.call(REGION_FLAGS, candidate) ||
        US_LOCATIONS.has(candidate) ||
        SOUTH_ASIA_LOCATIONS.has(candidate)
      ) {
        return candidate;
      }
    }

    return '';
  }

  function getFlagEmoji(locationName) {
    const norm = normalizeLocation(locationName);
    if (!norm) return '🌐';
    if (Object.prototype.hasOwnProperty.call(COUNTRY_FLAGS, norm)) {
      return COUNTRY_FLAGS[norm];
    }
    if (Object.prototype.hasOwnProperty.call(REGION_FLAGS, norm)) {
      return REGION_FLAGS[norm];
    }
    return '🌍';
  }

  /**
   * Convert a regional indicator flag emoji to X's first-party Twemoji SVG URL
   * so country flags render crisply on Windows Chrome as well as macOS/Linux.
   */
  function flagToTwemojiSvgUrl(emoji) {
    if (!emoji) return null;
    const points = Array.from(emoji).map((ch) => ch.codePointAt(0));
    if (points.length < 2) return null;
    // Check if regional indicator symbols (0x1F1E6..0x1F1FF)
    if (points[0] >= 0x1f1e6 && points[0] <= 0x1f1ff) {
      const hex = points.map((p) => p.toString(16)).join('-');
      return `https://abs-0.twimg.com/emoji/v2/svg/${hex}.svg`;
    }
    return null;
  }

  /**
   * Classify an account record into:
   * - 'south_asia' (Tier 2: High-visibility Red/Orange alert highlight)
   * - 'non_us'     (Tier 3: Amber/Gold Non-US highlight)
   * - 'us'         (Tier 1: Unhighlighted, optional subtle US badge)
   * - 'unknown'    (No location reported)
   */
  function classifyRecord(record) {
    if (!record) {
      return { tier: 'unknown', flag: '🌐', badgeText: '', tooltipLines: [] };
    }

    const basedInRaw = record.b || record.basedIn || null;
    const connectedViaRaw = record.v || record.connectedVia || null;
    const locationAccurate = record.a !== false && record.locationAccurate !== false;

    const normBased = normalizeLocation(basedInRaw);
    const viaRegion = extractConnectedViaRegion(connectedViaRaw);
    const normVia = normalizeLocation(viaRegion);

    const basedIsSouthAsia = SOUTH_ASIA_LOCATIONS.has(normBased);
    const viaIsSouthAsia = settings.checkConnectedVia && SOUTH_ASIA_LOCATIONS.has(normVia);

    const basedIsUS = US_LOCATIONS.has(normBased);
    const viaIsUS = US_LOCATIONS.has(normVia);

    const basedIsOtherNonUS = Boolean(normBased && !basedIsUS && !basedIsSouthAsia);
    const viaIsOtherNonUS = Boolean(
      settings.checkConnectedVia && normVia && !viaIsUS && !viaIsSouthAsia
    );

    const vpnMismatch = !locationAccurate && settings.flagVpnMismatch;

    const tooltipLines = [];
    if (basedInRaw) tooltipLines.push(`Account based in: ${basedInRaw}`);
    else tooltipLines.push('Account based in: Not reported');
    if (connectedViaRaw) tooltipLines.push(`Connected via: ${connectedViaRaw}`);
    if (!locationAccurate) {
      tooltipLines.push('⚠️ X reports location_accurate: false (VPN / proxy / travel mismatch)');
    }

    // TIER 2: SOUTH ASIA
    if (basedIsSouthAsia || viaIsSouthAsia) {
      let specificCountry = '';
      if (basedIsSouthAsia && normBased !== 'south asia' && normBased !== 'southern asia') {
        specificCountry = formatLocationName(basedInRaw);
      } else if (viaIsSouthAsia && normVia !== 'south asia' && normVia !== 'southern asia') {
        specificCountry = formatLocationName(viaRegion);
      }

      const flag = specificCountry ? getFlagEmoji(specificCountry) : '🌏';
      let badgeText = 'South Asia';
      if (basedIsSouthAsia) {
        if (specificCountry) {
          badgeText = `South Asia · ${specificCountry}`;
        } else {
          badgeText = 'South Asia';
        }
        if (
          settings.checkConnectedVia &&
          normVia &&
          normVia !== normBased &&
          !SOUTH_ASIA_LOCATIONS.has(normVia)
        ) {
          badgeText += ` (via ${formatLocationName(viaRegion)})`;
        }
      } else {
        // Flagged because Connected Via is South Asia while Based In is different
        const viaLabel = specificCountry || 'South Asia';
        if (basedInRaw) {
          badgeText = `South Asia · via ${viaLabel} (claims ${formatLocationName(basedInRaw)})`;
        } else {
          badgeText = `South Asia · via ${viaLabel}`;
        }
      }

      if (vpnMismatch) badgeText += ' ⚠️';

      return {
        tier: 'south_asia',
        flag,
        badgeText,
        vpnMismatch,
        basedInRaw,
        connectedViaRaw,
        tooltipLines
      };
    }

    // TIER 3: OTHER NON-US
    if (basedIsOtherNonUS || viaIsOtherNonUS) {
      const primaryLoc = basedIsOtherNonUS ? basedInRaw : viaRegion;
      const flag = getFlagEmoji(primaryLoc);
      let badgeText = '';

      if (basedIsOtherNonUS) {
        badgeText = formatLocationName(basedInRaw);
        if (
          settings.checkConnectedVia &&
          normVia &&
          normVia !== normBased &&
          !viaIsUS
        ) {
          badgeText += ` · via ${formatLocationName(viaRegion)}`;
        }
      } else {
        // Based in US (or unknown), but Connected Via a Non-US App Store / Play Store
        const viaFormatted = formatLocationName(viaRegion);
        if (basedIsUS) {
          badgeText = `US · via ${viaFormatted}`;
        } else {
          badgeText = `via ${viaFormatted}`;
        }
      }

      if (vpnMismatch) badgeText += ' ⚠️';

      return {
        tier: 'non_us',
        flag,
        badgeText,
        vpnMismatch,
        basedInRaw,
        connectedViaRaw,
        tooltipLines
      };
    }

    // TIER 1: UNITED STATES
    if (basedIsUS || viaIsUS) {
      const flag = '🇺🇸';
      let badgeText = 'US';
      if (vpnMismatch) badgeText += ' ⚠️';

      return {
        tier: 'us',
        flag,
        badgeText,
        vpnMismatch,
        basedInRaw,
        connectedViaRaw,
        tooltipLines
      };
    }

    return {
      tier: 'unknown',
      flag: '🌐',
      badgeText: '',
      vpnMismatch,
      basedInRaw,
      connectedViaRaw,
      tooltipLines
    };
  }

  // ============================================================================
  // STORAGE & CACHE MANAGEMENT
  // ============================================================================

  function loadInitialState() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get([SETTINGS_KEY, CACHE_KEY], (data) => {
      if (chrome.runtime?.lastError) return;
      if (data && data[SETTINGS_KEY]) {
        settings = { ...DEFAULT_SETTINGS, ...data[SETTINGS_KEY] };
      }
      if (data && data[CACHE_KEY] && typeof data[CACHE_KEY] === 'object') {
        const now = Date.now();
        for (const [handle, entry] of Object.entries(data[CACHE_KEY])) {
          if (!entry || typeof entry !== 'object') continue;
          const age = now - (entry.t || 0);
          const ttl = entry.b || entry.v ? CACHE_TTL_MS : UNKNOWN_TTL_MS;
          if (age < ttl) {
            memoryCache.set(handle.toLowerCase(), entry);
          }
        }
      }
      applyBodyEnabledAttribute();
      scanAllVisibleElements(true);
    });
  }

  function scheduleCachePersist() {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!cacheDirty || !chrome?.storage?.local) return;
      cacheDirty = false;

      // Trim oldest if exceeding max entries
      if (memoryCache.size > MAX_CACHE_ENTRIES) {
        const excess = memoryCache.size - MAX_CACHE_ENTRIES;
        let removed = 0;
        for (const k of memoryCache.keys()) {
          memoryCache.delete(k);
          if (++removed >= excess) break;
        }
      }

      const serialized = Object.fromEntries(memoryCache.entries());
      chrome.storage.local.set({ [CACHE_KEY]: serialized });
    }, 1200);
  }

  function storeAccountRecord(screenName, rawData) {
    if (!screenName || !rawData) return null;
    const key = screenName.trim().toLowerCase();
    const compact = {
      b: rawData.basedIn || rawData.b || null,
      v: rawData.connectedVia || rawData.v || null,
      a: rawData.locationAccurate !== false && rawData.a !== false,
      c:
        typeof rawData.createdCountryAccurate === 'boolean'
          ? rawData.createdCountryAccurate
          : typeof rawData.c === 'boolean'
            ? rawData.c
            : null,
      t: Date.now()
    };
    memoryCache.set(key, compact);
    cacheDirty = true;
    scheduleCachePersist();
    return compact;
  }

  // Listen for passive `about_profile` data from page-script.js
  window.addEventListener(EVENT_PASSIVE_DATA, (event) => {
    try {
      const payload = JSON.parse(event.detail || '{}');
      if (!Array.isArray(payload.entries)) return;
      let updatedAny = false;
      for (const item of payload.entries) {
        if (item && item.screenName && (item.basedIn || item.connectedVia)) {
          storeAccountRecord(item.screenName, item);
          updatedAny = true;
        }
      }
      if (updatedAny && settings.enabled) {
        scanAllVisibleElements(false);
      }
    } catch (_) {}
  });

  // Listen for settings or cache updates from popup
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[SETTINGS_KEY]) {
        settings = {
          ...DEFAULT_SETTINGS,
          ...(changes[SETTINGS_KEY].newValue || {})
        };
        applyBodyEnabledAttribute();
        refreshAllRenderedState();
      }
      if (changes[CACHE_KEY] && !changes[CACHE_KEY].newValue) {
        // Cache was cleared from popup
        memoryCache.clear();
        refreshAllRenderedState();
      }
    });
  }

  chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'XRH_CLEAR_CACHE') {
      memoryCache.clear();
      cacheDirty = false;
      refreshAllRenderedState();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'XRH_RESCAN') {
      refreshAllRenderedState();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  function applyBodyEnabledAttribute() {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute('data-xrh-enabled', settings.enabled ? 'true' : 'false');
    root.setAttribute(
      'data-xrh-hl-south-asia',
      settings.enabled && settings.highlightSouthAsia ? 'true' : 'false'
    );
    root.setAttribute(
      'data-xrh-hl-non-us',
      settings.enabled && settings.highlightNonUS ? 'true' : 'false'
    );
  }

  // ============================================================================
  // PAGE SCRIPT RPC (AboutAccountQuery)
  // ============================================================================

  function fetchAccountViaPageScript(screenName) {
    const key = screenName.trim().toLowerCase();
    if (pendingRequests.has(key)) {
      return pendingRequests.get(key);
    }

    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const promise = new Promise((resolve) => {
      let settled = false;
      let timer = null;

      function onResult(event) {
        let res;
        try {
          res = JSON.parse(event.detail || '{}');
        } catch (_) {
          return;
        }
        if (res.requestId !== requestId) return;
        cleanup();
        if (res.success && res.data) {
          const saved = storeAccountRecord(key, res.data);
          try {
            chrome.runtime?.sendMessage?.({ type: 'XRH_STATUS_UPDATE', rateLimitedUntil: 0 });
          } catch (_) {}
          resolve(saved);
        } else {
          if (res.code === 'RATE_LIMITED' && res.retryAfter) {
            try {
              chrome.runtime?.sendMessage?.({
                type: 'XRH_STATUS_UPDATE',
                rateLimitedUntil: res.retryAfter
              });
            } catch (_) {}
          } else if (res.code === 'NOT_FOUND') {
            // Cache empty entry briefly so we don't hammer 404/suspended accounts
            storeAccountRecord(key, { basedIn: null, connectedVia: null, locationAccurate: true });
          }
          resolve(null);
        }
      }

      function cleanup() {
        if (settled) return;
        settled = true;
        window.removeEventListener(EVENT_FETCH_RES, onResult);
        if (timer) clearTimeout(timer);
      }

      window.addEventListener(EVENT_FETCH_RES, onResult);
      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 12000);

      window.dispatchEvent(
        new CustomEvent(EVENT_FETCH_REQ, {
          detail: JSON.stringify({ requestId, screenName: key })
        })
      );
    }).finally(() => {
      pendingRequests.delete(key);
    });

    pendingRequests.set(key, promise);
    return promise;
  }

  function getOrFetchAccount(screenName) {
    const key = screenName.trim().toLowerCase();
    if (memoryCache.has(key)) {
      const cached = memoryCache.get(key);
      const age = Date.now() - (cached.t || 0);
      const ttl = cached.b || cached.v ? CACHE_TTL_MS : UNKNOWN_TTL_MS;
      if (age < ttl) {
        return Promise.resolve(cached);
      }
    }
    return fetchAccountViaPageScript(key);
  }

  // ============================================================================
  // DOM EXTRACTION & BADGE / HIGHLIGHT RENDERING
  // ============================================================================

  function extractHandleFromUserNameContainer(container) {
    if (!container) return null;

    // 1. Check profile links inside the User-Name block
    const links = container.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (match) {
        const candidate = match[1];
        if (!RESERVED_PATHS.has(candidate.toLowerCase())) {
          return candidate;
        }
      }
    }

    // 2. Fallback for profile headers or quote headers where @handle is plain text
    const spans = container.querySelectorAll('span, div[dir="ltr"]');
    const candidates = [];
    for (const node of spans) {
      const text = (node.textContent || '').trim();
      if (text.startsWith('@') && /^@[A-Za-z0-9_]{1,15}$/.test(text)) {
        candidates.push(text.slice(1));
      }
    }
    if (candidates.length > 0) {
      return candidates[candidates.length - 1];
    }

    return null;
  }

  function findBadgeInsertionTarget(userNameContainer, handle) {
    const lowerHandle = handle.toLowerCase();

    // Look for the @handle link or span
    const links = Array.from(userNameContainer.querySelectorAll('a'));
    const handleLink = links.find(
      (a) => (a.textContent || '').trim().toLowerCase() === `@${lowerHandle}`
    );
    if (handleLink && handleLink.parentElement) {
      const wrapper = handleLink.parentElement;
      if (wrapper.parentElement) {
        return { parent: wrapper.parentElement, before: wrapper.nextSibling };
      }
      return { parent: wrapper, before: null };
    }

    // Look for any span whose text is @handle
    const spans = Array.from(userNameContainer.querySelectorAll('span'));
    const handleSpan = spans.find(
      (s) => (s.textContent || '').trim().toLowerCase() === `@${lowerHandle}`
    );
    if (handleSpan && handleSpan.parentElement) {
      return { parent: handleSpan.parentElement, before: handleSpan.nextSibling };
    }

    // Fallback to the primary link
    const firstLink = userNameContainer.querySelector(`a[href="/${handle}" i]`);
    if (firstLink && firstLink.parentElement) {
      return { parent: firstLink.parentElement, before: firstLink.nextSibling };
    }

    return { parent: userNameContainer, before: null };
  }

  // Tooltip Singleton
  let tooltipEl = null;
  function getTooltipEl() {
    if (tooltipEl && tooltipEl.isConnected) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'xrh-tooltip';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function showTooltip(badgeEl, handle, classification) {
    const el = getTooltipEl();
    el.textContent = '';

    const title = document.createElement('div');
    title.className = 'xrh-tooltip-title';
    const tierLabel =
      classification.tier === 'south_asia'
        ? '🌏 South Asia Account'
        : classification.tier === 'non_us'
          ? '🌍 Non-US Account'
          : classification.tier === 'us'
            ? '🇺🇸 US Account'
            : '🌐 Account Info';
    title.textContent = `@${handle} — ${tierLabel}`;
    el.appendChild(title);

    for (const line of classification.tooltipLines) {
      const row = document.createElement('div');
      row.className = 'xrh-tooltip-row';
      row.textContent = line;
      el.appendChild(row);
    }

    const hint = document.createElement('div');
    hint.className = 'xrh-tooltip-hint';
    hint.textContent = 'Right-click badge to refresh location from X';
    el.appendChild(hint);

    el.classList.add('xrh-tooltip-visible');

    const rect = badgeEl.getBoundingClientRect();
    const tooltipRect = el.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;

    if (left + tooltipRect.width > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - tooltipRect.width - 12);
    }
    if (top + tooltipRect.height > window.innerHeight - 12) {
      top = Math.max(12, rect.top - tooltipRect.height - 6);
    }

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function hideTooltip() {
    if (tooltipEl) {
      tooltipEl.classList.remove('xrh-tooltip-visible');
    }
  }

  function buildBadgeElement(handle, classification) {
    if (classification.tier === 'unknown') return null;
    if (classification.tier === 'us' && !settings.showUSBadge && !classification.vpnMismatch) {
      return null;
    }

    const badge = document.createElement('span');
    badge.className = `xrh-badge xrh-badge--${classification.tier.replace('_', '-')}`;
    badge.dataset.xrhHandle = handle.toLowerCase();
    badge.dataset.xrhTier = classification.tier;

    // Flag icon (Twemoji SVG with text fallback so Windows renders flags properly)
    const flagWrap = document.createElement('span');
    flagWrap.className = 'xrh-badge-flag';
    const twemojiUrl = flagToTwemojiSvgUrl(classification.flag);
    if (twemojiUrl) {
      const img = document.createElement('img');
      img.src = twemojiUrl;
      img.alt = classification.flag;
      img.className = 'xrh-badge-flag-img';
      const fallback = document.createElement('span');
      fallback.textContent = classification.flag;
      fallback.style.display = 'none';
      img.addEventListener('error', () => {
        img.style.display = 'none';
        fallback.style.display = 'inline';
      });
      flagWrap.appendChild(img);
      flagWrap.appendChild(fallback);
    } else {
      flagWrap.textContent = classification.flag;
    }
    badge.appendChild(flagWrap);

    // Label text
    const textSpan = document.createElement('span');
    textSpan.className = 'xrh-badge-text';
    textSpan.textContent = classification.badgeText;
    badge.appendChild(textSpan);

    // Hover tooltip
    badge.addEventListener('mouseenter', () => showTooltip(badge, handle, classification));
    badge.addEventListener('mouseleave', hideTooltip);

    // Right-click to force refresh this handle
    badge.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideTooltip();
      const key = handle.toLowerCase();
      memoryCache.delete(key);
      badge.textContent = '↻ Refreshing…';
      fetchAccountViaPageScript(key).then(() => {
        refreshAllRenderedState();
      });
    });

    // Prevent clicking the badge from triggering tweet navigation
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    return badge;
  }

  /**
   * Determine whether a User-Name element belongs to the main author of the tweet/reply
   * or to an embedded quote-tweet inside the article.
   */
  function isPrimaryTweetAuthor(userNameEl, tweetArticle) {
    if (!tweetArticle) return false;
    const firstUserName = tweetArticle.querySelector(
      '[data-testid="User-Name"], [data-testid="UserName"]'
    );
    return firstUserName === userNameEl;
  }

  function applyAccountToUserNameEl(userNameEl, handle, record) {
    // Remove any existing badge or shimmer inside this User-Name block
    userNameEl.querySelectorAll('.xrh-badge, .xrh-shimmer').forEach((n) => n.remove());

    if (!settings.enabled || !record) {
      clearHighlightForUserName(userNameEl);
      return;
    }

    const classification = classifyRecord(record);
    const badge = buildBadgeElement(handle, classification);
    if (badge) {
      const target = findBadgeInsertionTarget(userNameEl, handle);
      if (target && target.parent) {
        target.parent.insertBefore(badge, target.before);
      }
    }

    const tweetArticle = userNameEl.closest('article[data-testid="tweet"]');
    if (tweetArticle) {
      if (isPrimaryTweetAuthor(userNameEl, tweetArticle)) {
        applyTweetHighlight(tweetArticle, userNameEl, classification);
      } else {
        // Quoted tweet inside someone else's post: highlight only the quote card container
        applyQuoteCardHighlight(userNameEl, classification);
      }
      return;
    }

    const userCell = userNameEl.closest('[data-testid="UserCell"]');
    if (userCell) {
      applyUserCellHighlight(userCell, classification);
    }
  }

  function applyTweetHighlight(tweetArticle, userNameEl, classification) {
    if (classification.tier === 'south_asia' && settings.highlightSouthAsia) {
      tweetArticle.setAttribute('data-xrh-tweet-tier', 'south-asia');
      userNameEl.setAttribute('data-xrh-author-tier', 'south-asia');
    } else if (classification.tier === 'non_us' && settings.highlightNonUS) {
      tweetArticle.setAttribute('data-xrh-tweet-tier', 'non-us');
      userNameEl.setAttribute('data-xrh-author-tier', 'non-us');
    } else {
      tweetArticle.removeAttribute('data-xrh-tweet-tier');
      userNameEl.removeAttribute('data-xrh-author-tier');
    }
  }

  function applyQuoteCardHighlight(userNameEl, classification) {
    const quoteCard = userNameEl.closest('div[role="link"]');
    if (!quoteCard) return;
    if (classification.tier === 'south_asia' && settings.highlightSouthAsia) {
      quoteCard.setAttribute('data-xrh-quote-tier', 'south-asia');
    } else if (classification.tier === 'non_us' && settings.highlightNonUS) {
      quoteCard.setAttribute('data-xrh-quote-tier', 'non-us');
    } else {
      quoteCard.removeAttribute('data-xrh-quote-tier');
    }
  }

  function applyUserCellHighlight(userCell, classification) {
    if (classification.tier === 'south_asia' && settings.highlightSouthAsia) {
      userCell.setAttribute('data-xrh-cell-tier', 'south-asia');
    } else if (classification.tier === 'non_us' && settings.highlightNonUS) {
      userCell.setAttribute('data-xrh-cell-tier', 'non-us');
    } else {
      userCell.removeAttribute('data-xrh-cell-tier');
    }
  }

  function clearHighlightForUserName(userNameEl) {
    userNameEl.removeAttribute('data-xrh-author-tier');
    const tweetArticle = userNameEl.closest('article[data-testid="tweet"]');
    if (tweetArticle && isPrimaryTweetAuthor(userNameEl, tweetArticle)) {
      tweetArticle.removeAttribute('data-xrh-tweet-tier');
    }
    const quoteCard = userNameEl.closest('div[role="link"]');
    if (quoteCard) quoteCard.removeAttribute('data-xrh-quote-tier');
    const userCell = userNameEl.closest('[data-testid="UserCell"]');
    if (userCell) userCell.removeAttribute('data-xrh-cell-tier');
  }

  function processUserNameElement(userNameEl, forceReapply = false) {
    if (!settings.enabled) return;

    const handle = extractHandleFromUserNameContainer(userNameEl);
    if (!handle) return;

    const key = handle.toLowerCase();
    const prevHandle = userNameEl.dataset.xrhProcessedHandle;

    if (!forceReapply && prevHandle === key && userNameEl.querySelector('.xrh-badge')) {
      return;
    }

    userNameEl.dataset.xrhProcessedHandle = key;

    // Fast path: already in memory cache
    if (memoryCache.has(key)) {
      const cached = memoryCache.get(key);
      const age = Date.now() - (cached.t || 0);
      const ttl = cached.b || cached.v ? CACHE_TTL_MS : UNKNOWN_TTL_MS;
      if (age < ttl) {
        applyAccountToUserNameEl(userNameEl, handle, cached);
        return;
      }
    }

    // Show subtle loading shimmer while querying AboutAccountQuery
    if (!userNameEl.querySelector('.xrh-shimmer, .xrh-badge')) {
      const shimmer = document.createElement('span');
      shimmer.className = 'xrh-shimmer';
      const target = findBadgeInsertionTarget(userNameEl, handle);
      if (target && target.parent) {
        target.parent.insertBefore(shimmer, target.before);
      }
    }

    getOrFetchAccount(handle).then((record) => {
      if (!userNameEl.isConnected) return;
      // Verify the element hasn't been recycled by X's virtual scroller for a different handle
      const currentHandle = extractHandleFromUserNameContainer(userNameEl);
      if (!currentHandle || currentHandle.toLowerCase() !== key) return;
      applyAccountToUserNameEl(userNameEl, currentHandle, record);
    });
  }

  function scanAllVisibleElements(forceReapply = false) {
    if (!document.body) return;
    if (!settings.enabled) {
      clearAllDecorations();
      return;
    }
    const nodes = document.querySelectorAll(
      '[data-testid="User-Name"], [data-testid="UserName"]'
    );
    for (const node of nodes) {
      processUserNameElement(node, forceReapply);
    }
  }

  function clearAllDecorations() {
    document.querySelectorAll('.xrh-badge, .xrh-shimmer').forEach((el) => el.remove());
    document.querySelectorAll('[data-xrh-tweet-tier]').forEach((el) =>
      el.removeAttribute('data-xrh-tweet-tier')
    );
    document.querySelectorAll('[data-xrh-author-tier]').forEach((el) =>
      el.removeAttribute('data-xrh-author-tier')
    );
    document.querySelectorAll('[data-xrh-quote-tier]').forEach((el) =>
      el.removeAttribute('data-xrh-quote-tier')
    );
    document.querySelectorAll('[data-xrh-cell-tier]').forEach((el) =>
      el.removeAttribute('data-xrh-cell-tier')
    );
    document.querySelectorAll('[data-xrh-processed-handle]').forEach((el) =>
      delete el.dataset.xrhProcessedHandle
    );
  }

  function refreshAllRenderedState() {
    if (!settings.enabled) {
      clearAllDecorations();
      return;
    }
    scanAllVisibleElements(true);
  }

  // ============================================================================
  // MUTATION OBSERVER & INITIALIZATION
  // ============================================================================

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled || !settings.enabled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanAllVisibleElements(false);
    });
  }

  function startObserver() {
    if (!document.body) {
      setTimeout(startObserver, 40);
      return;
    }
    applyBodyEnabledAttribute();
    scanAllVisibleElements(false);

    const observer = new MutationObserver((mutations) => {
      if (!settings.enabled) return;
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length > 0) {
          scheduleScan();
          break;
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  loadInitialState();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }
})();
