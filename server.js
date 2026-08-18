const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { resolveCoordinates } = require('./geocode');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const id = () => crypto.randomUUID();

app.get('/api/users/by-email', (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ exists: false });
  res.json({ exists: true, user: toUserJson(user) });
});

app.post('/api/signup', (req, res) => {
  const { name, email } = req.body;
  if (!name?.trim() || !email?.trim()) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  const cleanEmail = email.trim().toLowerCase();

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  if (!user) {
    const newId = id();
    db.prepare('INSERT INTO users (id, name, email) VALUES (?, ?, ?)')
      .run(newId, name.trim(), cleanEmail);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(newId);
  }
  res.json(toUserJson(user));
});

function toUserJson(u) {
  return {
    id: u.id, name: u.name, email: u.email,
    isEmailVerified: !!u.is_email_verified,
    isIdVerified: !!u.is_id_verified,
    voteWeight: u.is_id_verified ? 2 : (u.is_email_verified ? 1 : 0)
  };
}

app.get('/api/category-counts', (req, res) => {
  const rows = db.prepare('SELECT category, COUNT(*) as count FROM places GROUP BY category').all();
  const counts = { restaurant: 0, supermarket: 0, butcher: 0 };
  rows.forEach(r => { counts[r.category] = r.count; });
  res.json(counts);
});

// IMPORTANT: these two routes must stay ABOVE /api/places/:placeId —
// Express matches routes in order, so if :placeId came first it would
// swallow /api/places/search and /api/places/map as if "search" or "map"
// were a place id.
app.get('/api/places/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
  const rows = db.prepare(
    `SELECT * FROM places WHERE name LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE LIMIT 50`
  ).all(like);

  // Names that start with the query read as more relevant than names that
  // merely contain it somewhere in the middle — surface those first.
  const qLower = q.toLowerCase();
  rows.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(qLower) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(qLower) ? 0 : 1;
    return aStarts - bStarts;
  });

  res.json(rows.map(toPlaceJson));
});

app.get('/api/places/map', (req, res) => {
  // Only places we've successfully resolved coordinates for can be pinned.
  const rows = db.prepare(
    'SELECT * FROM places WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
  ).all();
  res.json(rows.map(toPlaceJson));
});

app.get('/api/places/:placeId', (req, res) => {
  const place = db.prepare('SELECT * FROM places WHERE id = ?').get(req.params.placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });
  res.json(toPlaceJson(place));
});

app.get('/api/places', (req, res) => {
  const { category, city } = req.query;
  let rows;
  if (category && city) {
    rows = db.prepare('SELECT * FROM places WHERE category = ? AND city = ?').all(category, city);
  } else if (category) {
    rows = db.prepare('SELECT * FROM places WHERE category = ?').all(category);
  } else {
    rows = db.prepare('SELECT * FROM places').all();
  }
  res.json(rows.map(toPlaceJson));
});

app.get('/api/cities', (req, res) => {
  const { category } = req.query;
  const rows = db.prepare(
    'SELECT city, COUNT(*) as count FROM places WHERE category = ? GROUP BY city ORDER BY city'
  ).all(category);
  res.json(rows);
});

const MAPS_LINK_RE = /^https?:\/\/(www\.)?(maps\.google\.[a-z.]+|google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.app\.goo\.gl)\//i;

const ALLOWED_CITIES = new Set([ "Heidelberg", "Aschaffenburg",
  "Berlin", "Hamburg", "München", "Köln", "Frankfurt am Main", "Stuttgart",
  "Düsseldorf", "Leipzig", "Dortmund", "Essen", "Bremen", "Dresden",
  "Hannover", "Nürnberg", "Duisburg", "Bochum", "Wuppertal", "Bielefeld",
  "Bonn", "Münster", "Karlsruhe", "Mannheim", "Augsburg", "Wiesbaden",
  "Mönchengladbach", "Gelsenkirchen", "Aachen", "Braunschweig", "Kiel",
  "Chemnitz", "Halle (Saale)", "Magdeburg", "Freiburg im Breisgau",
  "Krefeld", "Lübeck", "Oberhausen", "Erfurt", "Mainz", "Rostock", "Kassel"
]);

app.post('/api/places', async (req, res) => {
  const { name, category, address, city, country, details, notes, confidence, hasCertificate, userId } = req.body;
  if (!name?.trim() || !address?.trim() || !city?.trim() || !userId) {
    return res.status(400).json({ error: 'Name, address, city, and userId are required.' });
  }
  if (!MAPS_LINK_RE.test(address.trim())) {
    return res.status(400).json({ error: 'Address must be a valid Google Maps link.' });
  }
  if (!ALLOWED_CITIES.has(city.trim())) {
    return res.status(400).json({ error: 'Please choose a city from the provided list.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  // Best-effort: geocode by name/city/country via Nominatim (OpenStreetMap).
  // Never blocks the submission — if it fails or times out, the place
  // still saves, just without map coordinates for now. debug:true logs the
  // attempt/result so failures show up in your server logs, not silently.
  const coords = await resolveCoordinates({
    name: name.trim(), city: city.trim(), country: country?.trim(), debug: true
  });
  if (!coords) {
    console.log(`[GEOCODE] "${name.trim()}" (${city.trim()}) saved without map coordinates.`);
  }

  const newId = id();
  db.prepare(`
    INSERT INTO places
      (id, name, category, address, city, country, details, notes, confidence, has_certificate, latitude, longitude, submitted_by_user_id, submitted_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId, name.trim(), category, address.trim(), city.trim(), country?.trim() || '', details || '', notes || '',
         confidence, hasCertificate ? 1 : 0, coords?.latitude ?? null, coords?.longitude ?? null, userId, user.name);

  res.json(toPlaceJson(db.prepare('SELECT * FROM places WHERE id = ?').get(newId)));
});

app.post('/api/places/:placeId/vote', (req, res) => {
  const { placeId } = req.params;
  const { userId, voteType } = req.body;
  if (!['up', 'down'].includes(voteType)) return res.status(400).json({ error: 'Invalid vote type.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const place = db.prepare('SELECT * FROM places WHERE id = ?').get(placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });

  const weight = user.is_id_verified ? 2 : 1;
  const existing = db.prepare('SELECT * FROM votes WHERE place_id = ? AND user_id = ?').get(placeId, userId);

  const tx = db.transaction(() => {
    if (existing && existing.vote_type === voteType) {
      db.prepare('DELETE FROM votes WHERE place_id = ? AND user_id = ?').run(placeId, userId);
    } else {
      db.prepare(`
        INSERT INTO votes (place_id, user_id, vote_type, weight)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(place_id, user_id) DO UPDATE SET vote_type = excluded.vote_type, weight = excluded.weight
      `).run(placeId, userId, voteType, weight);
    }
  });
  tx();

  res.json(toPlaceJson(db.prepare('SELECT * FROM places WHERE id = ?').get(placeId)));
});

app.get('/api/places/:placeId/comments', (req, res) => {
  const rows = db.prepare(
    'SELECT id, user_id, username, text, created_at FROM comments WHERE place_id = ? ORDER BY created_at DESC'
  ).all(req.params.placeId);
  res.json(rows.map(r => ({ id: r.id, userId: r.user_id, username: r.username, text: r.text, createdAt: r.created_at })));
});

app.post('/api/places/:placeId/comments', (req, res) => {
  const { placeId } = req.params;
  const { userId, text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Comment text is required.' });
  if (text.trim().length > 500) return res.status(400).json({ error: 'Keep comments under 500 characters.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const place = db.prepare('SELECT id FROM places WHERE id = ?').get(placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });

  const newId = crypto.randomUUID();
  db.prepare('INSERT INTO comments (id, place_id, user_id, username, text) VALUES (?, ?, ?, ?, ?)')
    .run(newId, placeId, userId, user.name, text.trim());

  const row = db.prepare('SELECT id, user_id, username, text, created_at FROM comments WHERE id = ?').get(newId);
  res.json({ id: row.id, userId: row.user_id, username: row.username, text: row.text, createdAt: row.created_at });
});

app.delete('/api/comments/:commentId', (req, res) => {
  const { commentId } = req.params;
  const { userId } = req.body;

  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.user_id !== userId) return res.status(403).json({ error: 'You can only delete your own comments.' });

  db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
  res.json({ deleted: true });
});

app.get('/api/places/:placeId/my-vote', (req, res) => {
  const { placeId } = req.params;
  const { userId } = req.query;
  const vote = db.prepare('SELECT vote_type FROM votes WHERE place_id = ? AND user_id = ?').get(placeId, userId);
  res.json({ voteType: vote?.vote_type || null });
});

function toPlaceJson(p) {
  const votes = db.prepare('SELECT vote_type, weight FROM votes WHERE place_id = ?').all(p.id);
  const upvotes = votes.filter(v => v.vote_type === 'up').reduce((s, v) => s + v.weight, 0);
  const downvotes = votes.filter(v => v.vote_type === 'down').reduce((s, v) => s + v.weight, 0);
  return {
    id: p.id, name: p.name, category: p.category, address: p.address, city: p.city,
    country: p.country || '', details: p.details, notes: p.notes, confidence: p.confidence,
    hasCertificate: !!p.has_certificate, submittedBy: p.submitted_by_name,
    latitude: p.latitude ?? null, longitude: p.longitude ?? null,
    upvotes, downvotes, trustScore: upvotes - downvotes
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Halal Finder API running on port ${PORT}`));

