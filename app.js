/*
 * Election Dashboard — application logic
 *
 * A static browser application: no build step, framework, or server is needed.
 * - Loads unofficial results from civicAPI.
 * - Lets visitors search, follow, and remove races.
 * - Remembers followed races only in this browser's localStorage.
 * - Refreshes live results while the dashboard is visible.
 * - Supports an optional install-as-app prompt.
 *
 * Sections below follow the path data takes through the application:
 * configuration → state → API normalization → loading/search → HTML views
 * → browser events → PWA installation.
 */

// -----------------------------------------------------------------------------
// 1. Configuration and reference data
// -----------------------------------------------------------------------------

const API_BASE_URL = 'https://civicapi.org/api/v2';
const FOLLOWED_RACES_STORAGE_KEY = 'racewatch-follow-v2';
const REFRESH_INTERVAL_MS = 30000;
const MAX_FEED_RESULTS = 60;
const SEARCH_CACHE_DURATION_MS = 90000;
const LOCAL_PAGE_SIZE = 60;
const SEARCH_START_DATE = '2026-11-01';
const SEARCH_END_DATE = '2026-11-04';

// civicAPI IDs for the three nationwide collections shown in the discovery tab.
const RACE_FEEDS = {
  senate: { id: 87528, name: 'U.S. Senate' },
  house: { id: 87524, name: 'U.S. House' },
  gov: { id: 87535, name: 'Governor' },
};

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas',
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming',
};

// Different civicAPI endpoints sometimes use different keys for a race name.
const RACE_NAME_FIELDS = [
  'name', 'title', 'race_name', 'raceName', 'race', 'office', 'contest',
  'position', 'description', 'election_name', 'electionName', 'label',
  'district_name',
];

// -----------------------------------------------------------------------------
// 2. Shared state and small utility functions
// -----------------------------------------------------------------------------

// The IDs saved to localStorage, for example "house:ny-12" or "c:12345".
let followedRaceIds = [];
let activeCategory = 'all';
let selectedState = '';
let searchText = '';
let lastUpdated = null;
let viewMessage = '';
let activeTab;

// API data and errors for feed-based races and individually requested races.
const feedData = {};
const customRaces = {};
const customRaceErrors = {};
const customRaceNames = {};

// Search state for statewide, local, and otherwise unclassified races.
let localSearchResults = [];
let localSearchMessage = '';
let localSearchSequence = 0;
let localSearchTimer = null;
let localSearchDebugData = null;
let localVisibleLimit = LOCAL_PAGE_SIZE;
let searchCacheKey = '';
let searchCachedAt = 0;
let pendingSearchKey = '';
let searchAbortController = null;

// Network synchronization: do not start duplicate feed or race-detail requests.
let feedRegions = [];
let feedRaceIds = new Set();
let lastFeedLoadAt = 0;
let feedLoadPromise = null;
const customRacesInFlight = new Map();

// Short-lived, bounded caches for discovery (never used for scheduled live
// refreshes). They avoid repeating identical searches and race-detail requests
// when a visitor changes filters or returns to a previous query.
const SEARCH_CACHE_MAX_ENTRIES = 20;
const cachedSearchResponses = new Map();
const cachedRaceDetails = new Map();
// Share simultaneous detail fetches, including those started by different searches.
const raceDetailsInFlight = new Map();

// HTML for each race currently displayed in the dashboard. This lets a live
// refresh replace just the rows whose visible data changed.
let renderedDashboardRaceRows = new Map();

/** Read a fresh cached value, removing expired entries. */
function getCachedValue(cache, key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.savedAt >= SEARCH_CACHE_DURATION_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

/** Save only a small number of completed API responses in memory. */
function cacheValue(cache, key, value) {
  cache.delete(key);
  cache.set(key, { value, savedAt: Date.now() });
  if (cache.size > SEARCH_CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

/**
 * Reuse a larger state-search response only when it represents a complete set
 * small enough to fit in the requested limit. Never take an arbitrary first
 * 100 from a 500-result response: civicAPI's ordering is not guaranteed.
 *
 * The other request parameters (state, query, country, dates) must be equal,
 * and an expired cache entry is never reused.
 */
function getCompatibleCachedStateSearch(parameters) {
  if (!parameters.get('province')) return undefined;

  const requestedLimit = Number(parameters.get('limit'));
  const matchingParameters = new URLSearchParams(parameters);
  matchingParameters.delete('limit');

  for (const cacheKey of cachedSearchResponses.keys()) {
    const cachedParameters = new URLSearchParams(cacheKey);
    const largerLimit = Number(cachedParameters.get('limit'));
    if (largerLimit <= requestedLimit) continue;
    cachedParameters.delete('limit');
    if (cachedParameters.toString() !== matchingParameters.toString()) continue;

    const response = getCachedValue(cachedSearchResponses, cacheKey);
    if (response === undefined) continue;

    const raceList = Array.isArray(response)
      ? response
      : firstAvailableField(response, ['races', 'results', 'data', 'items', 'hits']);
    if (raceList == null) continue;
    const races = Array.isArray(raceList) ? raceList : Object.values(raceList);

    // An unsaturated larger request is complete, unless response metadata
    // explicitly says there are more races than were returned.
    const reportedCount = response && !Array.isArray(response)
      ? Number(response.count)
      : NaN;
    if (races.length >= largerLimit || races.length > requestedLimit ||
        (Number.isFinite(reportedCount) && reportedCount > races.length) ||
        response.has_more === true || response.hasMore === true ||
        response.next != null || response.next_page != null) {
      continue;
    }
    return response;
  }
  return undefined;
}

/** Create the same AbortError that fetch would return for a canceled search. */
function raceDetailAbortError() {
  const error = new Error('The race detail request was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Fetch race details only once for simultaneous callers. Each caller may have
 * its own AbortSignal: canceling one search stops only that caller, while the
 * underlying request is canceled when nobody is waiting for it anymore.
 *
 * The completed-response cache is used only when explicitly requested;
 * live polling and manual refreshes still fetch fresh results.
 */
async function getRaceDetail(raceNumber, { signal, useCache = false } = {}) {
  if (signal && signal.aborted) throw raceDetailAbortError();

  const key = String(raceNumber);
  if (useCache) {
    const cached = getCachedValue(cachedRaceDetails, key);
    if (cached !== undefined) return cached;
  }

  let request = raceDetailsInFlight.get(key);
  if (!request) {
    const controller = new AbortController();
    request = { controller, subscribers: 0, finished: false, promise: null };
    request.promise = (async () => {
      const response = await fetch(`${API_BASE_URL}/race/${encodeURIComponent(raceNumber)}`,
        { signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const detail = await response.json();
      if (!controller.signal.aborted) cacheValue(cachedRaceDetails, key, detail);
      return detail;
    })();
    raceDetailsInFlight.set(key, request);

    // Supply both success and failure handlers to avoid unhandled rejections.
    request.promise.then(
      () => {
        request.finished = true;
        if (raceDetailsInFlight.get(key) === request) raceDetailsInFlight.delete(key);
      },
      () => {
        request.finished = true;
        if (raceDetailsInFlight.get(key) === request) raceDetailsInFlight.delete(key);
      },
    );
  }

  // Returning a separate promise lets each caller cancel independently.
  return new Promise((resolve, reject) => {
    request.subscribers++;
    let settled = false;

    function release() {
      if (settled) return false;
      settled = true;
      if (signal) signal.removeEventListener('abort', abort);
      request.subscribers--;
      if (!request.subscribers && !request.finished) {
        // Remove the abandoned request now so a new search can start afresh.
        if (raceDetailsInFlight.get(key) === request) raceDetailsInFlight.delete(key);
        request.controller.abort();
      }
      return true;
    }

    function abort() {
      if (release()) reject(raceDetailAbortError());
    }

    if (signal) signal.addEventListener('abort', abort, { once: true });
    request.promise.then(
      detail => { if (release()) resolve(detail); },
      error => { if (release()) reject(error); },
    );
    // Handle an abort occurring between the first check and listener setup.
    if (signal && signal.aborted) abort();
  });
}

const select = selector => document.querySelector(selector);

// Escape text before inserting values returned by the API into innerHTML.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function nameForFeed(feedType) {
  return RACE_FEEDS[feedType]
    ? RACE_FEEDS[feedType].name
    : 'Local race or ballot question';
}

function titleCase(value) {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function nameForScope(scope) {
  return {
    province: 'Statewide',
    district: 'District',
    municipality: 'Municipality',
  }[scope] || titleCase(scope);
}

function isBallotQuestionChoice(name) {
  return /^(yes|no|for|against|approve|reject|in favor|opposed)\b/i
    .test(String(name).trim());
}

function partyClass(party) {
  const normalizedParty = (party || '').toLowerCase();
  if (/^d(em|$)/.test(normalizedParty)) return 'd';
  if (/^r(ep|$)|gop/.test(normalizedParty)) return 'r';
  return 'o';
}

function formatPercent(percent) {
  return percent == null ? '–' : (Math.round(percent * 10) / 10) + '%';
}

// Keep the existing storage key so current visitors retain their followed races.
try {
  followedRaceIds = JSON.parse(localStorage.getItem(FOLLOWED_RACES_STORAGE_KEY)) || [];
} catch (error) {
  // Storage may be disabled or contain invalid JSON; start with an empty list.
}

activeTab = followedRaceIds.length ? 'dash' : 'find';

/**
 * Guests still use the exact existing storage key. Signed-in users write only
 * the individual change to Firestore; do not overwrite this device's guest list.
 */
function saveFollowedRaces(action, raceId) {
  if (window.electionCloud && window.electionCloud.isSignedIn()) {
    window.electionCloud.saveChange(action, raceId);
  } else {
    try {
      localStorage.setItem(
        FOLLOWED_RACES_STORAGE_KEY,
        JSON.stringify(followedRaceIds),
      );
    } catch (error) {
      // Browsers in private/restricted modes may reject localStorage writes.
    }
  }

  updateInstallBanner();
}

/** Prevent accidental edits while Google is switching/loading an account. */
function canChangeFollowedRaces() {
  return !window.electionCloud || window.electionCloud.canEdit();
}

/** Guest dashboards have no race cap; only signed-in Google accounts do. */
function googleAccountRaceLimit() {
  return window.electionCloud?.isSignedIn()
    ? window.electionCloud.raceLimit
    : Infinity;
}

/** Stop additions to a full Google account and explain how to make room. */
function canFollowAnotherRace() {
  if (followedRaceIds.length < googleAccountRaceLimit()) return true;
  viewMessage = `Google accounts can save up to ${googleAccountRaceLimit()} races. ` +
    'Remove a race from My Dashboard to follow another.';
  render();
  return false;
}

/** Expose only the small bridge Firebase needs; election logic stays here. */
window.electionDashboard = {
  guestRaces() {
    try {
      const raw = JSON.parse(localStorage.getItem(FOLLOWED_RACES_STORAGE_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(id => typeof id === 'string') : [];
    } catch (error) {
      return [];
    }
  },

  /** Repaint only when the race IDs genuinely changed. */
  applyRaces(ids) {
    const uniqueIds = [...new Set(ids.filter(id => typeof id === 'string'))];
    if (uniqueIds.length === followedRaceIds.length &&
        uniqueIds.every((id, index) => id === followedRaceIds[index])) return;

    followedRaceIds = uniqueIds;
    render();
    updateInstallBanner();

    // Race details may be missing when logging in on a different device.
    const unknownCustom = followedRaceIds.filter(id =>
      id.startsWith('c:') && !customRaces[id] && !customRacesInFlight.has(id));
    if (unknownCustom.length) {
      runWithConcurrencyLimit(unknownCustom, 4, loadCustomRace).then(() => {
        if (activeTab === 'dash') updateDashboardResults();
        else render();
      });
    }
    // loadResults reuses fresh feeds and retrieves a feed missing on this device.
    loadResults();
  },

  // The signed-in account may load the same IDs as before (including an empty
  // list), but the dashboard disclaimer still needs to update at login/logout.
  refreshAccountUI() {
    render();
  },
};

// -----------------------------------------------------------------------------
// 3. Convert civicAPI responses into the race/candidate format used by the UI
// -----------------------------------------------------------------------------

/**
 * Return the first non-empty value from a list of possible API field names.
 * civicAPI's feed, search, and detail endpoints are not always consistent.
 */
function firstAvailableField(object, fieldNames) {
  if (object) {
    for (const fieldName of fieldNames) {
      if (object[fieldName] != null && object[fieldName] !== '') {
        return object[fieldName];
      }
    }
  }
}

/**
 * Determine whether a race is statewide or local, but only when civicAPI
 * explicitly identifies that scope. A district or region in the response
 * does not, by itself, establish an election's scope.
 *
 * Search responses use election_type; detail responses use election_scope.
 * In detail responses, election_type may instead name an office.
 */
function raceScope(object) {
  if (!object || typeof object !== 'object') return '';

  const classify = value => {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, ' ');

    if (['statewide', 'state wide', 'provincewide', 'province wide'].includes(normalized)) {
      return 'province';
    }
    if (['local', 'municipal', 'municipality', 'city', 'county',
      'town', 'township', 'village', 'parish', 'borough'].includes(normalized)) {
      return 'municipality';
    }
    return '';
  };

  return classify(object.election_scope) || classify(object.election_type);
}

/**
 * Normalize candidates, votes, reporting percentage, and display labels.
 * "feedType" is senate/house/gov/custom; "regionKey" is the API's region ID.
 * The output shape intentionally matches the one used by the original app.
 */
function normalizeRegion(feedType, regionKey, regionData) {
  let candidateList = firstAvailableField(regionData, ['candidates', 'results', 'choices']) || [];
  if (!Array.isArray(candidateList)) candidateList = Object.values(candidateList);

  const winner = regionData && regionData.winner;
  const candidates = candidateList.map(candidateData => {
    let party = firstAvailableField(candidateData, [
      'party', 'party_name', 'partyName', 'affiliation', 'abbr',
    ]);

    if (party && typeof party === 'object') {
      party = firstAvailableField(party, ['abbr', 'abbreviation', 'name', 'short']);
    }

    const candidate = {
      id: firstAvailableField(candidateData, ['id', 'candidate_id', 'candidateId']),
      name: firstAvailableField(candidateData, [
        'name', 'candidate', 'candidate_name', 'candidateName', 'full_name',
      ]) || 'Unknown',
      party: party || '',
      votes: Number(firstAvailableField(candidateData, [
        'votes', 'vote_count', 'voteCount', 'total',
      ])) || 0,
      pct: firstAvailableField(candidateData, [
        'percent', 'pct', 'percentage', 'vote_pct', 'share',
      ]),
      won: !!firstAvailableField(candidateData, [
        'winner', 'won', 'elected', 'is_winner',
      ]),
    };

    // Some endpoints specify the winner on the race, not on each candidate.
    if (!candidate.won && winner != null && winner !== false && winner !== '') {
      const winnerId = typeof winner === 'object'
        ? firstAvailableField(winner, ['id', 'candidate_id'])
        : winner;
      const winnerName = typeof winner === 'object' ? winner.name : winner;

      candidate.won = (
        (candidate.id != null && String(winnerId) === String(candidate.id)) ||
        winnerName === candidate.name ||
        (typeof winner === 'string' && winner === candidate.party)
      );
    }

    return candidate;
  });

  // Fall back to vote totals if the API did not give candidate percentages.
  const totalVotes = candidates.reduce((sum, candidate) => sum + candidate.votes, 0);
  candidates.forEach(candidate => {
    candidate.pct = candidate.pct != null && !isNaN(candidate.pct)
      ? Number(candidate.pct)
      : (totalVotes ? candidate.votes / totalVotes * 100 : null);
  });
  candidates.sort((first, second) => second.votes - first.votes);

  const regionParts = regionKey.split('-');
  const stateCode = regionParts[0].toUpperCase();
  const stateName = STATE_NAMES[stateCode] || stateCode;
  const label = feedType === 'house'
    ? (regionParts[1] === 'al'
      ? stateName + ' at-large'
      : `${stateName} District ${parseInt(regionParts[1], 10) || regionParts.slice(1).join(' ')}`)
    : stateName + (regionParts.length > 1
      ? ' (' + regionParts.slice(1).join(' ').toUpperCase() + ')'
      : '');

  const percentReporting = firstAvailableField(regionData, [
    'percent_reporting', 'pct_reporting', 'percentReporting',
  ]);

  return {
    k: feedType,
    key: regionKey,
    eid: firstAvailableField(regionData, ['election_id', 'electionId']),
    id: feedType + ':' + regionKey,
    state: stateCode,
    label,
    total: totalVotes,
    reporting: percentReporting != null && !isNaN(percentReporting)
      ? Number(percentReporting)
      : null,
    cands: candidates,
    raw: regionData,
  };
}

/** Extract one region per contest from a Senate, House, or governor feed. */
function regionsFromFeed(response, feedType) {
  let topLevel = Array.isArray(response) ? response[0] : response;
  topLevel = topLevel || {};

  const regionResults = topLevel.region_results ||
    (topLevel.race && topLevel.race.region_results) ||
    (topLevel.data && topLevel.data.region_results) || {};

  const entries = Array.isArray(regionResults)
    ? regionResults.map((region, index) => [
      firstAvailableField(region, ['key', 'id', 'region', 'code', 'slug']) || String(index),
      region,
    ])
    : Object.entries(regionResults);

  return entries.map(([regionKey, regionData]) =>
    normalizeRegion(feedType, String(regionKey).toLowerCase(), regionData));
}

function allKnownRaces() {
  return feedRegions.concat(Object.values(customRaces));
}

/** Find a usable race title, even when civicAPI puts it under an unusual key. */
function raceName(object) {
  let value = firstAvailableField(object, RACE_NAME_FIELDS);
  if (value && typeof value === 'object') {
    value = firstAvailableField(value, ['name', 'title', 'label']);
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }

  const excludedField = /(^|_)(id|date|country|province|state|status|url|type|slug|key|at)$|id$|date$|url$/i;
  const possibleNames = Object.entries(object || {})
    .filter(([fieldName, fieldValue]) =>
      typeof fieldValue === 'string' &&
      fieldValue.length > 3 &&
      !excludedField.test(fieldName) &&
      !/^\d{4}-\d\d-\d\d/.test(fieldValue) &&
      !/^https?:/.test(fieldValue))
    .sort((first, second) => second[1].length - first[1].length);

  return possibleNames.length ? possibleNames[0][1] : '';
}

/**
 * Convert an individually loaded race to the same shape as a feed race.
 * Some races provide candidates directly; others only list region results.
 */
function buildCustomRace(raceNumber, response) {
  let topLevel = Array.isArray(response) ? response[0] : response;
  topLevel = topLevel || {};

  if (topLevel.race && typeof topLevel.race === 'object') {
    topLevel = topLevel.race;
  } else if (topLevel.data && typeof topLevel.data === 'object' && !Array.isArray(topLevel.data)) {
    topLevel = topLevel.data;
  }

  let normalized = normalizeRegion('custom', 'c-' + raceNumber, topLevel);

  if (!normalized.cands.length) {
    // Aggregate the same candidate across reporting regions without double rows.
    const combinedCandidates = {};
    regionsFromFeed(response, 'custom').forEach(region => {
      region.cands.forEach(candidate => {
        const key = candidate.name + '|' + candidate.party;
        const combined = combinedCandidates[key] || (combinedCandidates[key] = {
          name: candidate.name,
          party: candidate.party,
          votes: 0,
          won: false,
        });
        combined.votes += candidate.votes;
        combined.won = combined.won || candidate.won;
      });
    });

    normalized = normalizeRegion('custom', 'c-' + raceNumber, {
      candidates: Object.values(combinedCandidates),
      percent_reporting: topLevel.percent_reporting,
    });
  }

  const customId = 'c:' + raceNumber;
  normalized.scope = raceScope(topLevel) ||
    raceScope(response && !Array.isArray(response) ? response : {});
  normalized.id = customId;
  normalized.label = raceName(topLevel) ||
    (customRaceNames[customId] && !/^Race \d+$/.test(customRaceNames[customId])
      ? customRaceNames[customId]
      : '') ||
    'Race ' + raceNumber;
  normalized.state = '';

  return normalized;
}

// -----------------------------------------------------------------------------
// 4. Request and refresh live results
// -----------------------------------------------------------------------------

/**
 * Avoid fetching a custom race twice when a manual Follow overlaps a refresh.
 * The map is cleared after the request settles.
 */
function loadCustomRace(raceId, useRecentSearchDetail = false) {
  if (customRacesInFlight.has(raceId)) return customRacesInFlight.get(raceId);

  const raceNumber = raceId.slice(2);
  const work = (async () => {
    try {
      // Only a newly followed search result may reuse recent detail data.
      // Manual refreshes and the 30-second polling always request fresh data.
      const detail = await getRaceDetail(raceNumber, {
        useCache: useRecentSearchDetail,
      });
      customRaces[raceId] = buildCustomRace(raceNumber, detail);
      delete customRaceErrors[raceId];
    } catch (error) {
      customRaceErrors[raceId] = error.message;
    }
  })();

  customRacesInFlight.set(raceId, work);
  work.finally(() => {
    if (customRacesInFlight.get(raceId) === work) {
      customRacesInFlight.delete(raceId);
    }
  });
  return work;
}

/** Run promises in bounded parallel batches to avoid overloading civicAPI. */
async function runWithConcurrencyLimit(items, concurrency, task) {
  let nextIndex = 0;

  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        await task(items[nextIndex++]);
      }
    },
  ));
}

/**
 * Refresh only feeds relevant to the current tab:
 * - Discovery needs all three collections, but reuses any still-fresh feeds.
 * - The personal dashboard needs only the types of races being followed.
 * - A forced refresh bypasses the interval for those relevant feeds.
 * - Followed custom races continue refreshing every 30 seconds, as before.
 * - No refresh overlaps another one.
 */
async function loadResults(force = false) {
  if (feedLoadPromise) return feedLoadPromise;

  const now = Date.now();
  const refreshDue = force || !lastFeedLoadAt ||
    now - lastFeedLoadAt >= REFRESH_INTERVAL_MS;
  const wantedFeedTypes = activeTab === 'find'
    ? Object.keys(RACE_FEEDS)
    : Object.keys(RACE_FEEDS).filter(feedType =>
      followedRaceIds.some(id => id.startsWith(feedType + ':')));

  // A tab switch can require a feed not fetched yet even if another feed was
  // refreshed recently. Track freshness per feed, not just globally.
  const feedTypes = wantedFeedTypes.filter(feedType =>
    force || !feedData[feedType] ||
    now - feedData[feedType].checkedAt >= REFRESH_INTERVAL_MS);

  if (!refreshDue && !feedTypes.length) return;

  feedLoadPromise = (async () => {
    await Promise.all(feedTypes.map(async feedType => {
      const feed = RACE_FEEDS[feedType];

      try {
        const response = await fetch(`${API_BASE_URL}/race/${feed.id}`);
        if (!response.ok) throw new Error('HTTP ' + response.status);

        const raw = await response.json();
        feedData[feedType] = {
          raw,
          regions: regionsFromFeed(raw, feedType),
          checkedAt: Date.now(),
        };
      } catch (error) {
        // Retain previously displayed results if a later request fails.
        feedData[feedType] = {
          err: error.message,
          regions: (feedData[feedType] && feedData[feedType].regions) || [],
          raw: feedData[feedType] && feedData[feedType].raw,
          checkedAt: Date.now(),
        };
      }
    }));

    feedRegions = Object.values(feedData).flatMap(feed => feed.regions || []);
    feedRaceIds = new Set(
      feedRegions.map(race => race.eid)
        .filter(id => id != null)
        .map(String),
    );

    // While first opening the dashboard, show the feed data promptly.
    if (activeTab === 'dash' && !lastUpdated) updateDashboardResults();

    if (refreshDue) {
      await runWithConcurrencyLimit(
        followedRaceIds.filter(id => id.startsWith('c:')),
        4,
        loadCustomRace,
      );
    }

    lastUpdated = new Date();
    lastFeedLoadAt = Date.now();

    if (activeTab === 'dash') {
      updateDashboardResults();
    } else {
      const listElement = select('#list');
      if (listElement) listElement.innerHTML = feedRaceListHtml();
      renderLocalResults();
    }
  })();

  try {
    return await feedLoadPromise;
  } finally {
    feedLoadPromise = null;
  }
}

// -----------------------------------------------------------------------------
// 5. Statewide, local, and candidate search
// -----------------------------------------------------------------------------

/** Normalize the results of /race/search, preserving candidates when supplied. */
function normalizeSearchResults(response) {
  let races = Array.isArray(response)
    ? response
    : firstAvailableField(response, ['races', 'results', 'data', 'items', 'hits']) || [];
  if (!Array.isArray(races)) races = Object.values(races);

  return races.map(race => {
    const id = firstAvailableField(race, ['id', 'race_id', 'raceid', 'raceId']);
    const name = raceName(race);
    const candidates = firstAvailableField(race, ['candidates', 'results', 'choices']);

    return {
      id,
      name: name || 'Race ' + id,
      noName: !name,
      scope: raceScope(race),
      sub: [
        firstAvailableField(race, ['district', 'province', 'state']),
        firstAvailableField(race, ['date', 'election_date', 'electionDate']),
      ].filter(Boolean).join(' · '),
      // Search results with a candidates array need no immediate detail fetch.
      rr: Array.isArray(candidates) ? buildCustomRace(id, race) : null,
    };
  }).filter(race => race.id != null);
}

function searchCategoryForRace(race) {
  if (race.scope === 'province') return 'statewide';
  if (race.scope === 'municipality' || race.scope === 'district') return 'local';
  return 'other';
}

/** Preserve a short sample of the API response for the troubleshooting panel. */
function summarizeSearchDebugData(response) {
  const results = Array.isArray(response)
    ? response
    : firstAvailableField(response, ['races', 'results', 'data', 'items', 'hits']);
  const races = Array.isArray(results) ? results : [];
  return {
    count: response && response.count != null ? response.count : races.length,
    returned: races.length,
    sample: races.slice(0, 2),
  };
}

/** Build the secondary race search list, grouped by scope. */
function localResultsHtml() {
  // Exclude races already present in the three main feed collections.
  const visibleCandidates = localSearchResults.filter(
    race => !feedRaceIds.has(String(race.id)),
  );
  const groups = activeCategory === 'statewide'
    ? [['statewide', 'Statewide races']]
    : activeCategory === 'local'
      ? [['local', 'Local races']]
      : [
        ['statewide', 'Statewide'],
        ['local', 'Local'],
        ['other', 'Unclassified races'],
      ];

  function raceCard(race) {
    const id = 'c:' + race.id;
    const isFollowed = followedRaceIds.includes(id);
    const candidateNames = race.rr
      ? (race.rr.cands.length
        ? race.rr.cands.slice(0, 4).map(candidate =>
          escapeHtml(candidate.name) +
          (candidate.party ? ' (' + escapeHtml(candidate.party.slice(0, 3)) + ')' : '')
        ).join(', ')
        : 'No candidates listed by civicAPI yet')
      : race.fail
        ? 'Candidates could not be loaded'
        : race.tried
          ? 'Loading candidates…'
          : 'Follow to see candidates';

    const followButton = isFollowed
      ? `<button class="btn alt" data-drop="${escapeHtml(id)}">Following</button>`
      : `<button class="btn" data-addl="${escapeHtml(race.id)}" data-name="${escapeHtml(race.name)}">Follow</button>`;

    return `<div class="item"><div>${escapeHtml(race.name)}<small>${escapeHtml(race.sub)}</small><small>${candidateNames}</small></div>${followButton}</div>`;
  }

  let content = '';
  let matchingCount = 0;

  groups.forEach(([category, heading]) => {
    const matches = visibleCandidates
      .filter(race => searchCategoryForRace(race) === category)
      .sort((first, second) => first.name.localeCompare(second.name, 'en', { numeric: true }));

    if (matches.length) {
      matchingCount += matches.length;
      content += `<h2 class="h2">${heading}</h2>` +
        matches.slice(0, localVisibleLimit).map(raceCard).join('');

      if (matches.length > localVisibleLimit) {
        content += `<div class="msg">Showing ${localVisibleLimit} of ${matches.length} ${heading.toLowerCase()}. <button class="btn alt" data-showmore>Show more</button></div>`;
      }
    }
  });

  const noResultsMessage = !matchingCount && localSearchResults.length && !localSearchMessage
    ? `<div class="msg">${activeCategory === 'all'
      ? 'Everything that matched is already listed above.'
      : 'No races in this category for that search.'}</div>`
    : '';

  const debugPanel = localSearchDebugData
    ? `<details><summary>Raw data from civicAPI search (for troubleshooting)</summary><pre>${escapeHtml(JSON.stringify(localSearchDebugData.search, null, 1).slice(0, 1500))}</pre><pre>${escapeHtml(localSearchDebugData.detail ? JSON.stringify(localSearchDebugData.detail, null, 1).slice(0, 1500) : 'No race detail loaded')}</pre></details>`
    : '';

  const statusMessage = localSearchMessage
    ? `<div class="msg${/failed/.test(localSearchMessage) ? ' err' : ''}">${escapeHtml(localSearchMessage)}</div>`
    : '';

  return statusMessage + noResultsMessage + content + debugPanel;
}

/** Repaint only the local-races section, avoiding changes to filters. */
function renderLocalResults() {
  const container = select('#local');
  if (container) container.innerHTML = localResultsHtml();
}

/**
 * Search civicAPI for races in the selected state and/or text query.
 *
 * It intentionally keeps the original behavior:
 * - At least 3 characters are required when no state is selected.
 * - Changing category chips reuses the same search if possible.
 * - Typing waits 450 ms, cancels the old request, and ignores stale answers.
 * - Successful responses are cached for 90 seconds.
 * - A candidate-name fallback checks up to 12 missing race details.
 */
function searchLocalRaces(force = false) {
  const query = searchText.trim();
  const key = JSON.stringify([selectedState, query]);
  if (force) searchCacheKey = '';

  if (!['all', 'statewide', 'local'].includes(activeCategory) ||
      (!selectedState && query.length < 3)) {
    clearTimeout(localSearchTimer);
    if (searchAbortController) searchAbortController.abort();
    ++localSearchSequence;
    pendingSearchKey = '';
    searchCacheKey = '';
    localSearchResults = [];
    localSearchDebugData = null;
    localSearchMessage = (
      ['all', 'statewide', 'local'].includes(activeCategory) &&
      !selectedState && query.length < 3 && activeCategory !== 'all'
    ) ? `Pick a state to see ${activeCategory} races.` : '';
    return renderLocalResults();
  }

  if (!force && key === pendingSearchKey) return renderLocalResults();
  if (!force && key === searchCacheKey &&
      Date.now() - searchCachedAt < SEARCH_CACHE_DURATION_MS) {
    return renderLocalResults();
  }

  clearTimeout(localSearchTimer);
  if (searchAbortController) searchAbortController.abort();

  const controller = new AbortController();
  const signal = controller.signal;
  searchAbortController = controller;
  const requestSequence = ++localSearchSequence;
  pendingSearchKey = key;
  localSearchResults = [];
  localSearchDebugData = null;
  localVisibleLimit = LOCAL_PAGE_SIZE;
  localSearchMessage = 'Searching other races…';
  renderLocalResults();

  localSearchTimer = setTimeout(async () => {
    localSearchTimer = null;
    let succeeded = false;

    // Preserve both snake_case and camelCase date parameters for civicAPI.
    async function requestSearch(searchQuery, limit = 100) {
      const parameters = new URLSearchParams({
        country: 'US',
        start_date: SEARCH_START_DATE,
        end_date: SEARCH_END_DATE,
        startDate: SEARCH_START_DATE,
        endDate: SEARCH_END_DATE,
        limit,
      });
      if (selectedState) parameters.set('province', selectedState);
      if (searchQuery) parameters.set('query', searchQuery);

      const requestKey = parameters.toString();
      if (!force) {
        const cached = getCachedValue(cachedSearchResponses, requestKey);
        if (cached !== undefined) return cached;

        // A complete 500-race state response can also satisfy a 100-race
        // fallback without an extra network call, when it contains <= 100 races.
        const compatible = getCompatibleCachedStateSearch(parameters);
        if (compatible !== undefined) return compatible;
      }

      const response = await fetch(`${API_BASE_URL}/race/search?${parameters}`, { signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const result = await response.json();
      if (!signal.aborted) cacheValue(cachedSearchResponses, requestKey, result);
      return result;
    }

    /** Load missing details to discover a race's scope or candidate names. */
    async function enrichRace(race) {
      if (signal.aborted || requestSequence !== localSearchSequence) return;
      race.tried = true;

      try {
        // Reuse recently fetched race details across searches and filters.
        const raw = await getRaceDetail(race.id, { signal, useCache: !force });
        if (signal.aborted || requestSequence !== localSearchSequence) return;

        if (localSearchDebugData && !localSearchDebugData.detail) {
          localSearchDebugData.detail = raw;
        }
        race.rr = buildCustomRace(race.id, raw);
        if (race.rr.scope) race.scope = race.rr.scope;
        if (race.noName && !/^Race \d+$/.test(race.rr.label)) {
          race.name = race.rr.label;
          race.noName = false;
        }
      } catch (error) {
        if (error.name !== 'AbortError') race.fail = true;
      }
    }

    try {
      const notFeed = race => !Object.values(RACE_FEEDS)
        .some(feed => String(feed.id) === String(race.id));

      const response = await requestSearch(query, query ? 100 : 500);
      if (signal.aborted || requestSequence !== localSearchSequence) return;

      let results = normalizeSearchResults(response).filter(notFeed);
      localSearchDebugData = {
        search: summarizeSearchDebugData(response),
        detail: null,
      };

      if (!results.length && query && selectedState) {
        // If race-name search yields nothing, search candidate names instead.
        const otherResponse = await requestSearch('', 100);
        if (signal.aborted || requestSequence !== localSearchSequence) return;

        results = normalizeSearchResults(otherResponse).filter(notFeed);
        const lowerQuery = query.toLowerCase();
        const matchingCandidates = () => results.filter(race =>
          race.rr && race.rr.cands.some(candidate =>
            candidate.name.toLowerCase().includes(lowerQuery)));
        let matches = matchingCandidates();

        if (!matches.length) {
          const missingCandidates = results.filter(race =>
            !race.rr || !race.rr.cands.length).slice(0, 12);

          if (missingCandidates.length) {
            localSearchMessage = `Checking missing candidate details in ${STATE_NAMES[selectedState]}…`;
            await runWithConcurrencyLimit(missingCandidates, 3, enrichRace);
            if (signal.aborted || requestSequence !== localSearchSequence) return;
            matches = matchingCandidates();
          }
        }

        localSearchResults = matches;
        localSearchMessage = matches.length
          ? ''
          : `No candidate matching “${query}” among ${results.length} races returned for ${STATE_NAMES[selectedState]}.`;
      } else {
        localSearchResults = results;
        localSearchMessage = results.length
          ? ''
          : 'No other races found for that search.';

        // Show the search matches before waiting for individual race details.
        renderLocalResults();

        // Only request details where the search response did not identify scope.
        const unknownScope = results.filter(race => !race.scope).slice(0, 12);
        await runWithConcurrencyLimit(unknownScope, 3, enrichRace);
        if (signal.aborted || requestSequence !== localSearchSequence) return;
      }

      succeeded = true;
    } catch (error) {
      if (signal.aborted || requestSequence !== localSearchSequence) return;
      localSearchResults = [];
      localSearchMessage = 'Search failed (' + error.message + ').';
    } finally {
      if (requestSequence === localSearchSequence && !signal.aborted) {
        pendingSearchKey = '';
        if (succeeded) {
          searchCacheKey = key;
          searchCachedAt = Date.now();
        }
        renderLocalResults();
      }
    }
  }, 450);
}

// -----------------------------------------------------------------------------
// 6. Add and remove followed races
// -----------------------------------------------------------------------------

/** Immediately show candidate data from search, then refresh from race detail. */
async function followLocalRace(raceNumber, name) {
  if (!canChangeFollowedRaces()) return;
  const id = 'c:' + raceNumber;
  if (followedRaceIds.includes(id)) return;
  if (!canFollowAnotherRace()) return;

  customRaceNames[id] = name;
  const searchMatch = localSearchResults.find(race => String(race.id) === String(raceNumber));
  if (searchMatch && searchMatch.rr) customRaces[id] = searchMatch.rr;

  followedRaceIds.push(id);
  saveFollowedRaces('add', id);
  render();
  loadCustomRace(id, true).then(() => {
    if (activeTab === 'dash') updateDashboardResults();
    else render();
  });
}

function followFeedRace(id) {
  if (!canChangeFollowedRaces()) return;
  if (followedRaceIds.includes(id)) return;
  if (!canFollowAnotherRace()) return;
  viewMessage = '';
  followedRaceIds.push(id);
  saveFollowedRaces('add', id);
  render();
}

function unfollowRace(id) {
  if (!canChangeFollowedRaces()) return;
  followedRaceIds = followedRaceIds.filter(followedId => followedId !== id);
  delete customRaces[id];
  delete customRaceErrors[id];
  saveFollowedRaces('remove', id);
  render();
}

// -----------------------------------------------------------------------------
// 7. Generate the two views (HTML strings inserted into <main>)
// -----------------------------------------------------------------------------

/** Main Senate / House / Governor list on "Choose Races to Follow". */
function feedRaceListHtml() {
  if (activeCategory === 'statewide' || activeCategory === 'local') return '';

  const races = allKnownRaces();
  if (!races.length) {
    const errors = Object.entries(feedData)
      .filter(([, feed]) => feed.err)
      .map(([feedType, feed]) => `${RACE_FEEDS[feedType].name}: ${feed.err}`)
      .join('; ');

    return `<div class="msg${errors ? ' err' : ''}">${errors
      ? 'Could not load races (' + escapeHtml(errors) + '). Check your connection, then tap Refresh.'
      : 'Loading races…'}</div>`;
  }

  const lowerQuery = searchText.toLowerCase();
  const matchingRaces = races
    .filter(race =>
      (activeCategory === 'all' || race.k === activeCategory) &&
      (!selectedState || race.state === selectedState) &&
      (!lowerQuery || (
        race.label + ' ' + race.cands.map(candidate => candidate.name).join(' ')
      ).toLowerCase().includes(lowerQuery)))
    .sort((first, second) => first.label.localeCompare(second.label, 'en', { numeric: true }));

  if (!matchingRaces.length) {
    return '<div class="msg">No races match. Clear a filter or try a different name.</div>';
  }

  const cards = matchingRaces.slice(0, MAX_FEED_RESULTS).map(race => {
    const isFollowed = followedRaceIds.includes(race.id);
    const candidateNames = race.cands.slice(0, 3).map(candidate =>
      escapeHtml(candidate.name) +
      (candidate.party ? ' (' + escapeHtml(candidate.party.slice(0, 3)) + ')' : '')
    ).join(', ');

    const followButton = isFollowed
      ? `<button class="btn alt" data-drop="${escapeHtml(race.id)}">Following</button>`
      : `<button class="btn" data-add="${escapeHtml(race.id)}">Follow</button>`;

    return `<div class="item"><div>${escapeHtml(race.label)}<small>${nameForFeed(race.k)}${candidateNames ? ' · ' + candidateNames : ''}</small></div>${followButton}</div>`;
  }).join('');

  return cards + (matchingRaces.length > MAX_FEED_RESULTS
    ? `<div class="msg">Showing ${MAX_FEED_RESULTS} of ${matchingRaces.length}. Pick a state or type a name to narrow the list.</div>`
    : '');
}

/** Search filters, race lists, and the fallback "Add by race ID" form. */
function findViewHtml() {
  const categoryChips = [
    ['all', 'All'],
    ['senate', 'Senate'],
    ['house', 'House'],
    ['gov', 'Governor'],
    ['statewide', 'Statewide'],
    ['local', 'Local'],
  ].map(([value, label]) =>
    `<button class="chip" data-ch="${value}" aria-pressed="${activeCategory === value}">${label}</button>`
  ).join('');

  const stateOptions = Object.entries(STATE_NAMES).map(([code, name]) =>
    `<option value="${code}"${selectedState === code ? ' selected' : ''}>${name}</option>`
  ).join('');

  return `<div class="bar"><span>${followedRaceIds.length} ${followedRaceIds.length === 1 ? 'race' : 'races'} followed</span></div>
  <div class="chips">${categoryChips}</div>
  <div class="search"><select id="state" aria-label="State"><option value="">All states</option>${stateOptions}</select><input id="q" type="search" value="${escapeHtml(searchText)}" placeholder="Race name or candidate" aria-label="Search races"></div>
  ${viewMessage ? `<div class="msg err">${escapeHtml(viewMessage)}</div>` : ''}<div id="list">${feedRaceListHtml()}</div>
  ${['all', 'statewide', 'local'].includes(activeCategory) ? `<div id="local">${localResultsHtml()}</div>` : ''}
  <p class="num" style="margin:12px 4px">Candidate-name search covers U.S. House, Senate and governor races. Statewide, Local and Other races are searched by race name. Races already listed under Senate, House or Governor are not repeated.</p>
  <details><summary>Can’t find a race? Add it by civicAPI race ID</summary><form class="search" id="idf" style="margin-top:8px"><input id="rid" inputmode="numeric" placeholder="Race ID, e.g. 12345" aria-label="civicAPI race ID"><button class="btn">Add</button></form></details>`;
}

/** Generate a separate group of table rows for each followed race. */
function dashboardRowsByRace() {
  const knownRaces = allKnownRaces();
  const racesById = Object.fromEntries(knownRaces.map(race => [race.id, race]));
  const rowsByRace = new Map();

  followedRaceIds.forEach(id => {
    const race = racesById[id];
    const removeButton = `<button class="x" data-drop="${escapeHtml(id)}">Remove</button>`;
    // The data attribute is invisible. It identifies which rows belong to
    // this race when a subsequent refresh changes only that race's totals.
    const rowTag = `<tr data-race-id="${escapeHtml(id)}"`;
    let raceRows = '';

    if (!race) {
      const raceTitle = escapeHtml(id.startsWith('c:') ? 'Race ' + id.slice(2) : id);
      const placeholder = customRaceErrors[id]
        ? 'Could not load this race (' + escapeHtml(customRaceErrors[id]) + ').'
        : knownRaces.length
          ? 'This race is not in the feed right now.'
          : 'Loading…';

      raceRows = `${rowTag} class="first"><td class="race">${raceTitle}<small>&nbsp;</small>${removeButton}</td><td colspan="3">${placeholder}</td></tr>`;
      rowsByRace.set(id, raceRows);
      return;
    }

    const reportingText = race.reporting != null
      ? formatPercent(race.reporting) + ' reporting'
      : race.total
        ? ''
        : 'No votes reported yet';

    const raceCell = `<td class="race" rowspan="${Math.max(race.cands.length, 1)}">${escapeHtml(race.label)}<small>${race.scope ? escapeHtml(nameForScope(race.scope)) : nameForFeed(race.k)}${reportingText ? ' · ' + reportingText : ''}</small>${removeButton}</td>`;

    if (!race.cands.length) {
      raceRows += `${rowTag} class="first">${raceCell}<td colspan="3">No candidates listed yet.</td></tr>`;
    }

    race.cands.forEach((candidate, index) => {
      const isMeasure = !candidate.party && isBallotQuestionChoice(candidate.name);
      const badgeClass = isMeasure
        ? (/^(yes|for|approve)/i.test(candidate.name.trim()) ? 'y' : 'n')
        : partyClass(candidate.party);
      const badge = isMeasure
        ? '<span class="pty m">Measure</span>'
        : `<span class="pty ${badgeClass}">${escapeHtml(candidate.party || '—')}</span>`;
      const winnerLabel = candidate.won ? ' <span class="win">✓ Called</span>' : '';
      const voteLabel = candidate.votes
        ? ' · ' + candidate.votes.toLocaleString() + ' votes'
        : '';

      raceRows += `${rowTag}${index ? '' : ' class="first"'}>${index ? '' : raceCell}<td>${badge}</td><td>${escapeHtml(candidate.name)}${winnerLabel}</td><td class="track"><div class="meter"><i class="${badgeClass}" style="width:${Math.min(100, candidate.pct || 0)}%"></i></div><div class="num">${formatPercent(candidate.pct)}${voteLabel}</div></td></tr>`;
    });
    rowsByRace.set(id, raceRows);
  });

  return rowsByRace;
}

function dashboardDebugHtml() {
  return Object.entries(feedData).map(([feedType, feed]) => {
    const raw = Array.isArray(feed.raw) ? feed.raw[0] || {} : feed.raw;
    const example = JSON.stringify(feed.regions[0] && feed.regions[0].raw, null, 1) || 'none';
    const debugText = feed.raw
      ? 'top-level keys: ' + Object.keys(raw).join(', ') +
        '\nregions: ' + feed.regions.length +
        '\nsample: ' + example.slice(0, 1200)
      : 'not loaded';

    return `<b>${RACE_FEEDS[feedType].name}</b>${feed.err ? ' (error: ' + escapeHtml(feed.err) + ')' : ''}<pre>${escapeHtml(debugText)}</pre>`;
  }).join('');
}

function dashboardUpdatedText() {
  return lastUpdated
    ? 'Updated ' + lastUpdated.toLocaleTimeString() + ' · refreshes every 30 seconds'
    : 'Loading results…';
}

/** Personal dashboard table, including live totals and winner indicators. */
function dashboardViewHtml() {
  // Only Google-account dashboards show this note, immediately below the table.
  // Existing accounts with more than 20 races retain their selections.
  const limit = googleAccountRaceLimit();
  const limitNote = Number.isFinite(limit)
    ? `<p class="num dashboard-limit-note">Google accounts can save up to ${limit} races on their dashboard. To follow another race after reaching the limit, remove one first.</p>`
    : '';

  if (!followedRaceIds.length) {
    renderedDashboardRaceRows = new Map();
    return `<div class="empty"><b>No races yet</b>Pick the Senate, House or governor races you want to follow.<br><br><button class="btn" data-go="find">Find races</button></div>${limitNote}`;
  }

  renderedDashboardRaceRows = dashboardRowsByRace();
  const tableRows = [...renderedDashboardRaceRows.values()].join('');

  return `<div class="bar"><span id="dashboard-updated">${dashboardUpdatedText()}</span><button class="btn alt" data-reload>Refresh</button></div>
  <div class="wrap"><table><thead><tr><th>Race</th><th>Party</th><th>Candidate</th><th>Live results</th></tr></thead><tbody id="dashboard-rows">${tableRows}</tbody></table></div>
  ${limitNote}
  <p class="num" style="margin:10px 4px">Before polls close, a race may list candidates who are not on the November ballot.</p>
  <details id="dashboard-debug"><summary>Raw data from civicAPI (for troubleshooting)</summary><div id="dashboard-debug-data">${dashboardDebugHtml()}</div></details>`;
}

/**
 * Update only those race rows whose visible results changed. Unchanged rows
 * retain their DOM nodes, so an automatic refresh doesn't reset the whole
 * table, lose focus, collapse an open troubleshooting panel, or jump scroll.
 * A change to the followed-race list still uses the normal full render.
 */
function updateDashboardResults() {
  if (activeTab !== 'dash') return;

  const body = select('#dashboard-rows');
  if (!body || followedRaceIds.length !== renderedDashboardRaceRows.size ||
      followedRaceIds.some(id => !renderedDashboardRaceRows.has(id))) {
    render();
    return;
  }

  const updatedRows = dashboardRowsByRace();
  const changedRows = [...updatedRows].filter(([id, markup]) =>
    markup !== renderedDashboardRaceRows.get(id));

  if (changedRows.length) {
    // Avoid even reading table DOM nodes if all results are unchanged.
    const rowsById = new Map();
    body.querySelectorAll('tr[data-race-id]').forEach(row => {
      const id = row.getAttribute('data-race-id');
      if (!rowsById.has(id)) rowsById.set(id, []);
      rowsById.get(id).push(row);
    });

    for (const [id, nextMarkup] of changedRows) {
      const previousRows = rowsById.get(id);
      if (!previousRows || !previousRows.length) {
        // Unexpected DOM structure: recover using the normal full render.
        render();
        return;
      }

      // Parse new rows in a table context so <tr> elements are valid.
      const newBody = document.createElement('tbody');
      newBody.innerHTML = nextMarkup;
      for (const newRow of [...newBody.children]) {
        body.insertBefore(newRow, previousRows[0]);
      }
      previousRows.forEach(row => row.remove());
    }
  }

  renderedDashboardRaceRows = updatedRows;
  const timestamp = select('#dashboard-updated');
  if (timestamp) timestamp.textContent = dashboardUpdatedText();
  updateDashboardDebugIfOpen();
}

/** Keep troubleshooting data current, but serialize it only when visible. */
function updateDashboardDebugIfOpen() {
  const details = select('#dashboard-debug');
  if (details && details.open) {
    const content = select('#dashboard-debug-data');
    if (content) content.innerHTML = dashboardDebugHtml();
  }
}

/** Rebuild the active tab while preserving scroll position and tab selection. */
function render() {
  const previousScrollPosition = window.scrollY;

  if (activeTab !== 'dash') renderedDashboardRaceRows = new Map();
  select('#main').innerHTML = (
    activeTab === 'dash' ? dashboardViewHtml() : findViewHtml()
  ) + `<footer>Live results powered by <a href="https://civicapi.org" target="_blank" rel="noopener">civicAPI</a></footer>`;

  const dashboardDebug = select('#dashboard-debug');
  if (dashboardDebug) {
    dashboardDebug.addEventListener('toggle', updateDashboardDebugIfOpen);
  }

  window.scrollTo(0, previousScrollPosition);
  select('#t-dash').setAttribute('aria-selected', activeTab === 'dash');
  select('#t-find').setAttribute('aria-selected', activeTab === 'find');
}

function goToTab(nextTab) {
  // Cancel stale discovery searches when returning to the dashboard.
  if (nextTab === 'dash' && searchAbortController) {
    searchAbortController.abort();
    searchAbortController = null;
    pendingSearchKey = '';
    ++localSearchSequence;
  }

  activeTab = nextTab;
  viewMessage = '';
  render();

  // loadResults itself decides whether each feed needs a request. Calling it
  // after every tab switch also loads a feed that discovery hasn't seen yet.
  loadResults();
}

// -----------------------------------------------------------------------------
// 8. User interactions and automatic refreshing
// -----------------------------------------------------------------------------

// Event delegation works for buttons and forms rebuilt by render().
select('#main').addEventListener('submit', async event => {
  if (event.target.id !== 'idf') return;
  event.preventDefault();

  if (!canChangeFollowedRaces()) return;
  const accountAtSubmit = window.electionCloud?.accountKey() || 'guest';
  const raceNumber = select('#rid').value.trim();
  if (!/^\d+$/.test(raceNumber)) {
    viewMessage = 'Enter the numeric race ID.';
    return render();
  }

  const id = 'c:' + raceNumber;
  if (followedRaceIds.includes(id)) {
    viewMessage = 'You already follow that race.';
    return render();
  }
  if (!canFollowAnotherRace()) return;

  viewMessage = 'Looking up race ' + raceNumber + '…';
  render();
  await loadCustomRace(id);

  // Do not add a race to a different Google account if sign-in changed while
  // the civicAPI request was in flight.
  if (!canChangeFollowedRaces() ||
      (window.electionCloud?.accountKey() || 'guest') !== accountAtSubmit) return;

  if (customRaceErrors[id]) {
    viewMessage = `Could not load race ${raceNumber} (${customRaceErrors[id]}). Check the ID and try again.`;
    delete customRaceErrors[id];
    return render();
  }

  // Another device or browser tab may have filled the account during lookup.
  if (followedRaceIds.includes(id) || !canFollowAnotherRace()) return;
  followedRaceIds.push(id);
  saveFollowedRaces('add', id);
  goToTab('dash');
});

select('#t-dash').onclick = () => goToTab('dash');
select('#t-find').onclick = () => goToTab('find');

select('#main').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.dataset.go) {
    goToTab(button.dataset.go);
  } else if (button.dataset.drop) {
    unfollowRace(button.dataset.drop);
  } else if (button.dataset.add) {
    followFeedRace(button.dataset.add);
  } else if (button.dataset.addl) {
    followLocalRace(button.dataset.addl, button.dataset.name);
  } else if (button.dataset.ch) {
    activeCategory = button.dataset.ch;
    render();
    searchLocalRaces();
  } else if (button.hasAttribute('data-showmore')) {
    localVisibleLimit += LOCAL_PAGE_SIZE;
    renderLocalResults();
  } else if (button.hasAttribute('data-reload')) {
    loadResults(true);
    if (activeTab === 'find') searchLocalRaces(true);
  }
});

select('#main').addEventListener('input', event => {
  if (event.target.id === 'q') {
    searchText = event.target.value.trim();
    select('#list').innerHTML = feedRaceListHtml();
    searchLocalRaces();
  }
});

select('#main').addEventListener('change', event => {
  if (event.target.id === 'state') {
    selectedState = event.target.value;
    select('#list').innerHTML = feedRaceListHtml();
    searchLocalRaces();
  }
});

// Poll only when the dashboard is on screen and at least one race is followed.
setInterval(() => {
  if (!document.hidden && activeTab === 'dash' && followedRaceIds.length) {
    loadResults();
  }
}, REFRESH_INTERVAL_MS);

// Also refresh when the user returns to a backgrounded tab.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeTab === 'dash') loadResults();
});

// Initial UI and civicAPI load; service worker keeps the static shell offline.
render();
loadResults();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// -----------------------------------------------------------------------------
// 9. Progressive Web App (PWA) installation banner
// -----------------------------------------------------------------------------

let deferredInstallPrompt = null;

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const INSTALL_DISMISSED_STORAGE_KEY = 'election-install-dismissed';

/** An installed PWA should not display the install prompt. */
function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    navigator.standalone === true;
}

/** Don't show the banner for seven days after the visitor dismisses it. */
function wasInstallBannerDismissed() {
  try {
    const timestamp = Number(localStorage.getItem(INSTALL_DISMISSED_STORAGE_KEY));
    return timestamp > 0 &&
      Date.now() - timestamp < 7 * 24 * 60 * 60 * 1000;
  } catch (error) {
    return false;
  }
}

/** Display iOS home-screen instructions or the Android/Chromium install button. */
function updateInstallBanner() {
  const banner = document.getElementById('install-banner');
  const description = document.getElementById('install-description');
  const installButton = document.getElementById('install-button');

  // Only suggest installing after the visitor has followed a race.
  if (
    followedRaceIds.length === 0 ||
    isInstalled() ||
    wasInstallBannerDismissed() ||
    (!isIOS && !deferredInstallPrompt)
  ) {
    banner.hidden = true;
    return;
  }

  if (isIOS) {
    description.textContent =
      'On iPhone: Open this site in Safari, tap Share, ' +
      'then Add to Home Screen.';
    installButton.hidden = true;
  } else {
    description.textContent =
      'Add the dashboard to your home screen for ' +
      'quick access to your followed races.';
    installButton.hidden = false;
  }

  banner.hidden = false;
}

// Chromium browsers emit this event once the site becomes installable.
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallBanner();
});

// The browser, not the app, controls the final installation dialog.
document.getElementById('install-button').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;

  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;

  try {
    const result = await promptEvent.prompt();
    if (result.outcome === 'dismissed') {
      dismissInstallBanner();
    } else {
      document.getElementById('install-banner').hidden = true;
    }
  } catch (error) {
    console.error('Installation prompt failed:', error);
  }

  updateInstallBanner();
});

function dismissInstallBanner() {
  try {
    localStorage.setItem(INSTALL_DISMISSED_STORAGE_KEY, String(Date.now()));
  } catch (error) {
    // The browser may block localStorage; hiding still works for this session.
  }

  document.getElementById('install-banner').hidden = true;
}

document.getElementById('install-dismiss')
  .addEventListener('click', dismissInstallBanner);

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  document.getElementById('install-banner').hidden = true;
});

updateInstallBanner();
