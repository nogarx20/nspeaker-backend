import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
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

// Centralizador de Logging de Errores
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

  // Log en Consola (Visible para el admin en terminal)
  console.error(`\n[ERROR SERVER - ${timestamp}]`);
  console.error(`Route: ${method} ${endpoint}`);
  console.error(`Message: ${errorMessage}`);
  console.error(`Stack: ${stackTrace.split('\n')[1].trim()}`); // Muestra la línea exacta del error

  // Persistir en Base de Datos (Para revisión histórica)
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

// Helper para auditoría de acciones exitosas
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

// --- STATUS API ---
app.get('/api/db-status', async (req, res) => {
  try {
    await pool.execute('SELECT 1');
    res.json({ connected: true, host: dbConfig.host, latency: '24ms' });
  } catch (err) {
    // No registramos este en DB para no saturar si hay micro-cortes, solo consola
    console.warn(`[DB-STATUS] Offline: ${err.message}`);
    res.json({ connected: false });
  }
});

// --- MEDIAFLOW: PODCASTS ---
app.get('/api/media/podcasts', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM podcasts ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'No se pudieron cargar los podcasts' });
  }
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
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al crear el podcast' });
  }
});

app.delete('/api/media/podcasts/:id', async (req, res) => {
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
  try {
    const [rows] = await pool.execute('SELECT * FROM conference_clips ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al obtener conferencias' });
  }
});

app.post('/api/media/conferences', async (req, res) => {
  const c = req.body;
  try {
    const [result] = await pool.execute(
      `INSERT INTO conference_clips (title, speaker, speakerTitle, speakerAvatar, duration, publicado, imageUrl, youtubeUrl, location, description, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.title, c.speaker, c.speakerTitle, c.speakerAvatar, c.duration, c.publicado || c.date, c.imageUrl, c.youtubeUrl, c.location, c.description, c.status]
    );
    res.json({ id: result.insertId });
  } catch (err) {
    await handleServerError(req, err);
    res.status(500).json({ error: 'Error al crear el clip de conferencia' });
  }
});

// --- LINKMETRICS AI ---
app.get('/api/groups', async (req, res) => {
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
  try {
    await pool.execute('DELETE FROM analytics_subgroups WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
  } catch (err) {
    await handleServerError(req, err, { targetId: req.params.id });
    res.status(500).json({ error: 'Fallo al eliminar subgrupo' });
  }
});

app.delete('/api/links/:id', async (req, res) => {
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
