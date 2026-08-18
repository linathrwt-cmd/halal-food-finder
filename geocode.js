// Resolves a Google Maps share link (maps.app.goo.gl, goo.gl/maps, or a
// full maps.google.com URL) into { latitude, longitude } — WITHOUT the
// Google Maps/Places API, so it needs no API key and costs nothing.
//
// How: Google embeds coordinates directly in the URL once a short link is
// followed to its real destination (e.g. .../@48.1374,11.5755,15z or
// !3d48.1374!4d11.5755). We just follow the redirect chain a browser would
// follow and pattern-match the coordinates out of wherever they land.
//
// This is best-effort: if Google changes their URL format, shows an
// unexpected interstitial, or the link is slow/unreachable, we time out
// and return null rather than block the place submission. Places without
// coordinates simply won't appear on the map — everything else still works.

const COORD_PATTERNS = [
  /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,               // .../@48.1374,11.5755,15z
  /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,            // place-detail encoded coords
  /[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)(?:&|$)/,    // ...?q=48.1374,11.5755
];

function extractCoords(text) {
  if (!text) return null;
  for (const pattern of COORD_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const latitude = parseFloat(match[1]);
      const longitude = parseFloat(match[2]);
      if (
        Number.isFinite(latitude) && Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
      ) {
        return { latitude, longitude };
      }
    }
  }
  return null;
}

async function resolveCoordsFromMapsLink(mapsUrl, { timeoutMs = 6000, maxHops = 8 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let currentUrl = mapsUrl;

  try {
    for (let hop = 0; hop < maxHops; hop++) {
      const direct = extractCoords(currentUrl);
      if (direct) return direct;

      let res;
      try {
        res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HalalFinderBot/1.0)' }
        });
      } catch (fetchErr) {
        console.log('[GEOCODE] Fetch failed for', currentUrl, '-', fetchErr.message);
        break;
      }

      const location = res.headers.get('location');
      if (location) {
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // Google sometimes shows an EU/regional consent interstitial instead
      // of redirecting straight to the place. Its "continue" param holds
      // the real destination — follow that as one more hop.
      try {
        const parsed = new URL(currentUrl);
        if (parsed.hostname.includes('consent.google') && parsed.searchParams.has('continue')) {
          currentUrl = decodeURIComponent(parsed.searchParams.get('continue'));
          continue;
        }
      } catch (_) {
        // malformed URL — nothing more we can do with it
      }

      const body = await res.text().catch(() => '');
      const found = extractCoords(body) || extractCoords(currentUrl);
      if (found) return found;

      break;
    }
  } catch (err) {
    console.log('[GEOCODE] Could not resolve coordinates for', mapsUrl, '-', err.message);
  } finally {
    clearTimeout(timer);
  }
  return null;
}

module.exports = { resolveCoordsFromMapsLink, extractCoords };
