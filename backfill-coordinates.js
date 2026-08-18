// Run this ONCE after deploying the map feature, to fill in latitude/
// longitude for places that were submitted before it existed.
//
// Locally:      node backfill-coordinates.js
// On Render:    use the Shell tab on your service and run the same command
//               (make sure DB_PATH is set the same way it is for the app,
//               so this touches the real persistent-disk database).
//
// Before running: open geocode.js and replace the placeholder email in
// NOMINATIM_USER_AGENT with a real contact — Nominatim's usage policy
// requires this, and requests without it may get blocked.
//
// Safe to re-run — it only looks at rows where latitude/longitude are
// still NULL, and skips anything it can't resolve without erroring out.

const db = require('./db');
const { resolveCoordinates } = require('./geocode');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const rows = db.prepare(
    'SELECT id, name, city, country FROM places WHERE latitude IS NULL OR longitude IS NULL'
  ).all();

  console.log(`[BACKFILL] ${rows.length} place(s) missing coordinates.`);

  let resolved = 0;
  let failed = 0;

  for (const row of rows) {
    const coords = await resolveCoordinates({
      name: row.name, city: row.city, country: row.country, debug: true
    });
    if (coords) {
      db.prepare('UPDATE places SET latitude = ?, longitude = ? WHERE id = ?')
        .run(coords.latitude, coords.longitude, row.id);
      resolved++;
      console.log(`[BACKFILL] ✓ ${row.name} -> ${coords.latitude}, ${coords.longitude}`);
    } else {
      failed++;
      console.log(`[BACKFILL] ✗ ${row.name} — could not resolve coordinates.`);
    }
    // Nominatim's usage policy caps automated use at ~1 request/second —
    // pace every place through the loop, not just the ones that hit it.
    await sleep(1100);
  }

  console.log(`[BACKFILL] Done. Resolved: ${resolved}, Still missing: ${failed}.`);

  // Close the native database handle cleanly BEFORE the process exits.
  // Forcing an immediate process.exit() here (instead of closing first and
  // letting Node shut down naturally) races with better-sqlite3's native
  // cleanup and can crash the process — this way avoids that entirely.
  db.close();
}

run().catch(err => {
  console.error('[BACKFILL] Fatal error:', err);
  try { db.close(); } catch (_) { /* already closed or never opened */ }
  process.exitCode = 1;
});
