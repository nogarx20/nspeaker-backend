
import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const dbConfig = {
  host: 'app.sittca.com.co',
  port: 3306,
  user: 'root',
  password: 'galaxys2',
  database: 'nspeaker_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

let pool;

async function initDB() {
  try {
    pool = mysql.createPool(dbConfig);
    console.log('--- !NSPEAKER DATABASE CONNECTED ---');
  } catch (err) {
    console.error('DB CONNECTION ERROR:', err.message);
  }
}

// Helper para auditoría
const logAction = async (type, id, action, email, details) => {
  try {
    await pool.execute(
      'INSERT INTO audit_logs (entity_type, entity_id, action, user_email, details) VALUES (?, ?, ?, ?, ?)',
      [type, String(id), action, email || 'system', details]
    );
  } catch (e) { console.error('Audit Error:', e); }
};

// --- PODCASTS API ---
app.get('/api/media/podcasts', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM podcasts ORDER BY id DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/media/podcasts', async (req, res) => {
  const p = req.body;
  try {
    const [result] = await pool.execute(
      `INSERT INTO podcasts (title, speaker, speakerTitle, speakerAvatar, company, date, description, location, duration, imageUrl, instagramUrl, youtubeUrl, spotifyUrl, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.title, p.speaker, p.speakerTitle, p.speakerAvatar, p.company, p.date, p.description, p.location, p.duration, p.imageUrl, p.instagramUrl, p.youtubeUrl, p.spotifyUrl, p.status]
    );
    await logAction('podcast', result.insertId, 'CREATE', 'admin@inspeaker.com.co', p.title);
    res.json({ id: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/media/podcasts/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM podcasts WHERE id = ?', [req.params.id]);
    await logAction('podcast', req.params.id, 'DELETE', 'admin@inspeaker.com.co', 'Cápsula eliminada');
    res.sendStatus(200);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- CONFERENCES API ---
app.get('/api/media/conferences', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM conference_clips ORDER BY id DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/media/conferences', async (req, res) => {
  const c = req.body;
  try {
    const [result] = await pool.execute(
      `INSERT INTO conference_clips (title, speaker, speakerTitle, speakerAvatar, duration, publicado, imageUrl, youtubeUrl, location, description, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.title, c.speaker, c.speakerTitle, c.speakerAvatar, c.duration, c.publicado || c.date, c.imageUrl, c.youtubeUrl, c.location, c.description, c.status]
    );
    await logAction('conference', result.insertId, 'CREATE', 'admin@inspeaker.com.co', c.title);
    res.json({ id: result.insertId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/media/conferences/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM conference_clips WHERE id = ?', [req.params.id]);
    await logAction('conference', req.params.id, 'DELETE', 'admin@inspeaker.com.co', 'Clip eliminado');
    res.sendStatus(200);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

initDB();
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`MediaFlow Backend Running on ${PORT}`));
