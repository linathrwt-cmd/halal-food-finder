// Resolves a place's location into { latitude, longitude } using
// Nominatim, OpenStreetMap's free geocoding search API. No API key, no
// cost — and unlike scraping Google Maps redirect links, this is exactly
// what Nominatim is built and licensed for, so there's no terms-of-service
// gray area here.
//
// We geocode by the place's NAME plus city/country (not by parsing a
// Google Maps link), since that's the input Nominatim's search endpoint
// actually expects.
//
// Nominatim's usage policy caps automated use at ~1 request/second and
// requires a descriptive User-Agent identifying your app — see
// NOMINATIM_USER_AGENT below. Replace the placeholder email with a real
// contact before deploying, or requests may get rate-limited or blocked:
// https://operations.osmfoundation.org/policies/nominatim/
//
// This is best-effort: uncommon or very new businesses may not be in
// OpenStreetMap's data yet. If a place can't be resolved, we return null
// and it simply won't appear on the map yet — everything else still works.

const NOMINATIM_USER_AGENT = 'HalalFoodFinder/1.0 (community halal-place directory; contact: linathrwt@gmail.com';

async function resolveCoordinates({ name, city, country, debug = false } = {}, { timeoutMs = 6000 } = {}) {
  const query = [name, city, country].filter(Boolean).join(', ');
  const log = (...args) => { if (debug) console.log('[GEOCODE:nominatim]', ...args); };
  if (!query) { log('no name/city/country given, nothing to geocode'); return null; }

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Required by Nominatim's usage policy — identify your app with
        // real contact info, or requests may get rate-limited/blocked.
        'User-Agent': NOMINATIM_USER_AGENT
      }
    });
    if (!res.ok) { log('HTTP', res.status, 'for query', query); return null; }

    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      const latitude = parseFloat(data[0].lat);
      const longitude = parseFloat(data[0].lon);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        log('resolved', query, '->', latitude, longitude);
        return { latitude, longitude };
      }
    }
    log('no results for', query);
  } catch (err) {
    log('lookup failed for', query, '-', err.message);
  } finally {
    clearTimeout(timer);
  }
  return null;
}

module.exports = { resolveCoordinates };
