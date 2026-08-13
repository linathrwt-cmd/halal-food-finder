const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves the website

const id = () => crypto.randomUUID();

// ---------- Users / auth ----------

// Very simple email-based "login": creates the user if new, returns existing
// user if the email is already known. No password — matches the site's
// "name + email, then verify" flow. Real email sending isn't wired up yet
// (see README) — is_email_verified starts at 0 until that's added.
// Lets the frontend check if an email is already known before deciding
// whether to ask for a name + show the verify screen, or log straight in.
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

// Mocked "verify" step for now — flips the flag immediately.
// Swap this for a real emailed verification link/token when ready (see README).
app.post('/api/verify-email', (req, res) => {
  const { userId } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  db.prepare('UPDATE users SET is_email_verified = 1 WHERE id = ?').run(userId);
  res.json(toUserJson(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)));
});

function toUserJson(u) {
  return {
    id: u.id, name: u.name, email: u.email,
    isEmailVerified: !!u.is_email_verified,
    isIdVerified: !!u.is_id_verified,
    voteWeight: u.is_id_verified ? 2 : (u.is_email_verified ? 1 : 0)
  };
}

// ---------- Places ----------

app.get('/api/category-counts', (req, res) => {
  const rows = db.prepare('SELECT category, COUNT(*) as count FROM places GROUP BY category').all();
  const counts = { restaurant: 0, supermarket: 0, butcher: 0 };
  rows.forEach(r => { counts[r.category] = r.count; });
  res.json(counts);
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

const ALLOWED_CITIES = new Set([
  "Berlin", "Hamburg", "München", "Köln", "Frankfurt am Main", "Stuttgart",
  "Düsseldorf", "Leipzig", "Dortmund", "Essen", "Bremen", "Dresden",
  "Hannover", "Nürnberg", "Duisburg", "Bochum", "Wuppertal", "Bielefeld",
  "Bonn", "Münster", "Karlsruhe", "Mannheim", "Augsburg", "Wiesbaden",
  "Mönchengladbach", "Gelsenkirchen", "Aachen", "Braunschweig", "Kiel",
  "Chemnitz", "Halle (Saale)", "Magdeburg", "Freiburg im Breisgau",
  "Krefeld", "Lübeck", "Oberhausen", "Erfurt", "Mainz", "Rostock", "Kassel"
]);

app.post('/api/places', (req, res) => {
  const { name, category, address, city, details, notes, confidence, hasCertificate, userId } = req.body;
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

  const newId = id();
  db.prepare(`
    INSERT INTO places
      (id, name, category, address, city, details, notes, confidence, has_certificate, submitted_by_user_id, submitted_by_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId, name.trim(), category, address.trim(), city.trim(), details || '', notes || '',
         confidence, hasCertificate ? 1 : 0, userId, user.name);

  res.json(toPlaceJson(db.prepare('SELECT * FROM places WHERE id = ?').get(newId)));
});

app.post('/api/places/:placeId/vote', (req, res) => {
  const { placeId } = req.params;
  const { userId, voteType } = req.body; // voteType: 'up' | 'down'
  if (!['up', 'down'].includes(voteType)) return res.status(400).json({ error: 'Invalid vote type.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (!user.is_email_verified) return res.status(403).json({ error: 'Verify your email before voting.' });

  const place = db.prepare('SELECT * FROM places WHERE id = ?').get(placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });

  const weight = user.is_id_verified ? 2 : 1;
  const existing = db.prepare('SELECT * FROM votes WHERE place_id = ? AND user_id = ?').get(placeId, userId);

  const tx = db.transaction(() => {
    if (existing && existing.vote_type === voteType) {
      // toggle off
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
  if (!user.is_email_verified) return res.status(403).json({ error: 'Verify your email before commenting.' });

  const place = db.prepare('SELECT id FROM places WHERE id = ?').get(placeId);
  if (!place) return res.status(404).json({ error: 'Place not found.' });

  const newId = crypto.randomUUID();
  db.prepare('INSERT INTO comments (id, place_id, user_id, username, text) VALUES (?, ?, ?, ?, ?)')
    .run(newId, placeId, userId, user.name, text.trim());

  const row = db.prepare('SELECT id, user_id, username, text, created_at FROM comments WHERE id = ?').get(newId);
  res.json({ id: row.id, userId: row.user_id, username: row.username, text: row.text, createdAt: row.created_at });
});

// Only the comment's own author can delete it.
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
    details: p.details, notes: p.notes, confidence: p.confidence,
    hasCertificate: !!p.has_certificate, submittedBy: p.submitted_by_name,
    upvotes, downvotes, trustScore: upvotes - downvotes
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Halal Finder API running on port ${PORT}`));
