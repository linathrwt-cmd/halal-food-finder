// Run this ONCE after deploying the map feature, to fill in latitude/
// longitude for places that were submitted before it existed.
//
// Locally:      node backfill-coordinates.js
// On Render:    use the Shell tab on your service and run the same command
//               (make sure DB_PATH is set the same way it is for the app,
//               so this touches the real persistent-disk database).
//
// Safe to re-run — it only looks at rows where latitude/longitude are
// still NULL, and skips anything it can't resolve without erroring out.

const db = require('./db');
const { resolveCoordsFromMapsLink } = require('./geocode');

async function run() {
  const rows = db.prepare(
    'SELECT id, name, address FROM places WHERE latitude IS NULL OR longitude IS NULL'
  ).all();

  console.log(`[BACKFILL] ${rows.length} place(s) missing coordinates.`);

  let resolved = 0;
  let failed = 0;

  for (const row of rows) {
    const coords = await resolveCoordsFromMapsLink(row.address);
    if (coords) {
      db.prepare('UPDATE places SET latitude = ?, longitude = ? WHERE id = ?')
        .run(coords.latitude, coords.longitude, row.id);
      resolved++;
      console.log(`[BACKFILL] ✓ ${row.name} -> ${coords.latitude}, ${coords.longitude}`);
    } else {
      failed++;
      console.log(`[BACKFILL] ✗ ${row.name} — could not resolve coordinates from its Maps link.`);
    }
  }

  console.log(`[BACKFILL] Done. Resolved: ${resolved}, Still missing: ${failed}.`);
  process.exit(0);
}

run().catch(err => {
  console.error('[BACKFILL] Fatal error:', err);
  process.exit(1);
});
