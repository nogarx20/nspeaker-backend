
import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

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
  queueLimit: 0,
  connectTimeout: 15000
};

let pool;
async function initDB() {
  try {
    pool = mysql.createPool(dbConfig);
    const connection = await pool.getConnection();
    console.log('--- !NSPEAKER REMOTE DATABASE CONNECTED ---');
    connection.release();
  } catch (err) {
    console.error('CRITICAL ERROR: No se pudo establecer conexión remota:', err.message);
  }
}

const getAdjustedDateTime = () => {
  const date = new Date();
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

const nil = (val) => (val === undefined || val === '' || val === null) ? null : val;

const handleServerError = async (req, error, contextData = null) => {
  const timestamp = getAdjustedDateTime();
  const endpoint = req.originalUrl;
  const method = req.method;
  const errorMessage = error.message;
  const stackTrace = error.stack;
  const requestData = JSON.stringify({
    body: req.body,
    params: req.params,
    query: req.query,
    context: contextData
  });

  console.error(`\n[ERROR SERVER - ${timestamp}]`);
  console.error(`Route: ${method} ${endpoint}`);
  console.error(`Message: ${errorMessage}`);

  try {
    if (pool) {
      await pool.execute(
        'INSERT INTO error_logs (endpoint, method, error_message, stack_trace, request_data) VALUES (?, ?, ?, ?, ?)',
        [endpoint, method, errorMessage, stackTrace, requestData]
      );
    }
  } catch (dbErr) {
    console.error('ERROR AL GUARDAR LOG EN DB:', dbErr.message);
  }
};

const logAction = async (type, id, action, email, details) => {
  try {
    if (pool) {
      await pool.execute(
        'INSERT INTO audit_logs (entity_type, entity_id, action, user_email, details) VALUES (?, ?, ?, ?, ?)',
        [type, String(id), action, email || 'system', details]
      );
    }
  } catch (e) { console.error('Audit Log Error:', e.message); }
};

// --- AUTH API ---
app.post('/api/login', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const { email, password } = req.body;
  try {
    const [users] = await pool.execute('SELECT email FROM users WHERE email = ? AND password = ?', [email, password]);
    if (users.length > 0) {
      await logAction('session', 'auth', 'LOGIN', email, 'Acceso exitoso al ecosistema');
      res.json({ success: true, user: { email: users[0].email } });
    } else {
      res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error interno en la autenticación' });
  }
});

app.post('/api/register', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const { email, password } = req.body;
  try {
    const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) return res.status(400).json({ success: false, error: 'Usuario ya existe' });
    
    await pool.execute('INSERT INTO users (email, password) VALUES (?, ?)', [email, password]);
    await logAction('user', 'new', 'REGISTER', email, 'Usuario registrado');
    res.json({ success: true });
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al registrar usuario' });
  }
});

app.get('/api/db-status', async (req, res) => {
  if (!pool) return res.json({ connected: false });
  try {
    await pool.execute('SELECT 1');
    res.json({ connected: true, host: dbConfig.host, latency: '24ms' });
  } catch (err) {
    console.warn(`[DB-STATUS] Offline: ${err.message}`);
    res.json({ connected: false });
  }
});

// --- SPEAKERS API ---
app.get('/api/speakers', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT * FROM speakers ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al obtener ponentes' });
  }
});

app.post('/api/speakers', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const s = req.body;
  const userEmail = s.userEmail || 'admin@inspeaker.com.co';
  try {
    const [result] = await pool.execute(
      'INSERT INTO speakers (name, title, imageUrl, specialties, bio, isVerified) VALUES (?, ?, ?, ?, ?, ?)',
      [nil(s.name), nil(s.title), nil(s.imageUrl), nil(s.specialties), nil(s.bio), s.isVerified ? 1 : 0]
    );
    await logAction('speaker', result.insertId, 'CREATE', userEmail, s.name);
    res.json({ id: result.insertId });
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al crear ponente' });
  }
});

app.put('/api/speakers/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const s = req.body;
  const { id } = req.params;
  const userEmail = s.userEmail || 'admin@inspeaker.com.co';
  try {
    await pool.execute(
      'UPDATE speakers SET name=?, title=?, imageUrl=?, specialties=?, bio=?, isVerified=? WHERE id=?',
      [nil(s.name), nil(s.title), nil(s.imageUrl), nil(s.specialties), nil(s.bio), s.isVerified ? 1 : 0, id]
    );
    await logAction('speaker', id, 'UPDATE', userEmail, s.name);
    res.json({ success: true });
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al actualizar ponente' });
  }
});

app.delete('/api/speakers/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const { id } = req.params;
  try {
    await pool.execute('DELETE FROM speakers WHERE id = ?', [id]);
    await logAction('speaker', id, 'DELETE', 'admin@inspeaker.com.co', 'Eliminación permanente');
    res.sendStatus(200);
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al eliminar ponente' });
  }
});

// --- MEDIAFLOW: PODCASTS ---
app.get('/api/media/podcasts', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT * FROM podcasts ORDER BY date DESC, id DESC');
    res.json(rows);
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'No se pudieron cargar los podcasts' });
  }
});

app.post('/api/media/podcasts', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const p = req.body;
  try {
    const [result] = await pool.execute(
      `INSERT INTO podcasts (title, speaker, speakerTitle, speakerAvatar, company, date, description, location, duration, imageUrl, instagramUrl, youtubeUrl, spotifyUrl, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nil(p.title), nil(p.speaker), nil(p.speakerTitle), nil(p.speakerAvatar), 
        nil(p.company), nil(p.date), nil(p.description), nil(p.location), 
        nil(p.duration) || '00:00', nil(p.imageUrl), nil(p.instagramUrl) || '#', 
        nil(p.youtubeUrl) || '#', nil(p.spotifyUrl) || '#', nil(p.status) || 'BORRADOR'
      ]
    );
    await logAction('podcast', result.insertId, 'CREATE', 'admin@inspeaker.com.co', p.title);
    res.json({ id: result.insertId });
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al crear el podcast' });
  }
});

app.put('/api/media/podcasts/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const p = req.body;
  const { id } = req.params;
  try {
    await pool.execute(
      `UPDATE podcasts SET title=?, speaker=?, speakerTitle=?, speakerAvatar=?, company=?, date=?, description=?, location=?, duration=?, imageUrl=?, instagramUrl=?, youtubeUrl=?, spotifyUrl=?, status=? WHERE id=?`,
      [
        nil(p.title), nil(p.speaker), nil(p.speakerTitle), nil(p.speakerAvatar), 
        nil(p.company), nil(p.date), nil(p.description), nil(p.location), 
        nil(p.duration), nil(p.imageUrl), nil(p.instagramUrl), nil(p.youtubeUrl), 
        nil(p.spotifyUrl), nil(p.status), id
      ]
    );
    res.json({ success: true });
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al actualizar el podcast' });
  }
});

app.delete('/api/media/podcasts/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  try {
    await pool.execute('DELETE FROM podcasts WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
  } catch (err) {
    await handleServerError(req, err, { id: req.params.id });
    res.status(500).json({ error: 'No se pudo eliminar el podcast' });
  }
});

// --- MEDIAFLOW: CONFERENCES ---
app.get('/api/media/conferences', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT * FROM conference_clips ORDER BY publicado DESC, id DESC');
    res.json(rows);
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al obtener conferencias' });
  }
});

app.post('/api/media/conferences', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const c = req.body;
  try {
    const [result] = await pool.execute(
      `INSERT INTO conference_clips (title, speaker, speakerTitle, speakerAvatar, duration, publicado, imageUrl, youtubeUrl, location, description, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nil(c.title), nil(c.speaker), nil(c.speakerTitle), nil(c.speakerAvatar), 
        nil(c.duration) || '00:00', nil(c.publicado) || nil(c.date), nil(c.imageUrl), 
        nil(c.youtubeUrl) || '', nil(c.location), nil(c.description), nil(c.status) || 'BORRADOR'
      ]
    );
    await logAction('conference', result.insertId, 'CREATE', 'admin@inspeaker.com.co', c.title);
    res.json({ id: result.insertId });
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al crear el clip de conferencia' });
  }
});

app.put('/api/media/conferences/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const c = req.body;
  const { id } = req.params;
  try {
    await pool.execute(
      `UPDATE conference_clips SET title=?, speaker=?, speakerTitle=?, speakerAvatar=?, duration=?, publicado=?, imageUrl=?, youtubeUrl=?, location=?, description=?, status=? WHERE id=?`,
      [
        nil(c.title), nil(c.speaker), nil(c.speakerTitle), nil(c.speakerAvatar), 
        nil(c.duration), nil(c.publicado) || nil(c.date), nil(c.imageUrl), 
        nil(c.youtubeUrl), nil(c.location), nil(c.description), nil(c.status), id
      ]
    );
    res.json({ success: true });
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al actualizar la conferencia' });
  }
});

app.delete('/api/media/conferences/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  try {
    await pool.execute('DELETE FROM conference_clips WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
  } catch (err) {
    await handleServerError(req, err, { id: req.params.id });
    res.status(500).json({ error: 'No se pudo eliminar la conferencia' });
  }
});

// --- LINKMETRICS AI ---
app.get('/api/groups', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const [groups] = await pool.execute('SELECT * FROM analytics_groups ORDER BY createdAt DESC');
    const [subgroups] = await pool.execute('SELECT * FROM analytics_subgroups');
    const [links] = await pool.execute('SELECT * FROM smart_links');
    
    const result = groups.map(g => ({
      ...g,
      subgroups: subgroups.filter(sg => sg.group_id === g.id).map(sg => ({
        ...sg,
        links: links.filter(l => l.subgroup_id === sg.id)
      }))
    }));
    res.json(result);
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al sincronizar LinkMetrics AI' });
  }
});

app.post('/api/groups', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const { name, subgroupCount } = req.body;
  const groupId = uuidv4();
  try {
    await pool.execute('INSERT INTO analytics_groups (id, name, createdAt, created_by) VALUES (?, ?, ?, ?)', [groupId, name, getAdjustedDateTime(), 'admin@inspeaker.com.co']);
    for (let i = 1; i <= subgroupCount; i++) {
      await pool.execute('INSERT INTO analytics_subgroups (id, group_id, name, created_by) VALUES (?, ?, ?, ?)', [uuidv4(), groupId, `Subgrupo ${i}`, 'admin@inspeaker.com.co']);
    }
    res.json({ id: groupId });
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Fallo al crear nueva cultura digital' });
  }
});

app.put('/api/groups/:id/status', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const { status } = req.body;
  const publishedAt = status === 'Publicado' ? getAdjustedDateTime() : null;
  try {
    await pool.execute('UPDATE analytics_groups SET status = ?, publishedAt = ? WHERE id = ?', [status, publishedAt, req.params.id]);
    res.sendStatus(200);
  } catch (err) {
    await handleServerError(req, err, { targetId: req.params.id });
    res.status(500).json({ error: 'Error al actualizar estado de publicación' });
  }
});

app.delete('/api/groups/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  try {
    await pool.execute('DELETE FROM analytics_groups WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
  } catch (err) {
    await handleServerError(req, err, { targetId: req.params.id });
    res.status(500).json({ error: 'No se pudo eliminar la cultura' });
  }
});

// --- SUBGROUPS & LINKS ---
app.post('/api/groups/:groupId/subgroups', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const { name, count } = req.body;
  try {
    for (let i = 0; i < count; i++) {
      await pool.execute('INSERT INTO analytics_subgroups (id, group_id, name, created_by) VALUES (?, ?, ?, ?)', [uuidv4(), req.params.groupId, name, 'admin@inspeaker.com.co']);
    }
    res.sendStatus(200);
  } catch (err) {
    await handleServerError(req, err, { groupId: req.params.groupId });
    res.status(500).json({ error: 'Error al añadir subgrupos' });
  }
});

app.post('/api/subgroups/:subgroupId/links', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  const { count, expiresAt } = req.body;
  try {
    for (let i = 0; i < count; i++) {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      await pool.execute(
        'INSERT INTO smart_links (id, subgroup_id, label, targetUrl, shortCode, createdAt, expiresAt, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), req.params.subgroupId, `Enlace ${i+1}`, 'https://inspeaker.com.co', code, getAdjustedDateTime(), expiresAt, 'admin@inspeaker.com.co']
      );
    }
    res.sendStatus(200);
  } catch (err) {
    await handleServerError(req, err, { subgroupId: req.params.subgroupId });
    res.status(500).json({ error: 'Error al generar links inteligentes' });
  }
});

app.delete('/api/subgroups/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  try {
    await pool.execute('DELETE FROM analytics_subgroups WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
  } catch (err) {
    await handleServerError(req, err, { targetId: req.params.id });
    res.status(500).json({ error: 'Fallo al eliminar subgrupo' });
  }
});

app.delete('/api/links/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database initializing' });
  try {
    await pool.execute('DELETE FROM smart_links WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
  } catch (err) {
    await handleServerError(req, err, { targetId: req.params.id });
    res.status(500).json({ error: 'No se pudo borrar el link' });
  }
});

initDB();
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`EVVA Backend Running on ${PORT} with Advanced Logging`));
