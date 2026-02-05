
import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import dotenv from 'dotenv';
import session from 'express-session';

dotenv.config();

const app = express();

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());

app.use(session({
  secret: 'nspeaker_ultra_secret_key_2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));
const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 15000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
};
let pool;

async function initDB() {
  try {
    pool = mysql.createPool(dbConfig);
    const connection = await pool.getConnection();
    console.log('--- !NSPEAKER REMOTE DATABASE STATUS ---');
    console.log(`CONNECTED TO: ${dbConfig.host}`);
    
    // Asegurar que la tabla audit_logs tenga la columna session_id (migración silenciosa)
    try {
      await connection.query("ALTER TABLE audit_logs ADD COLUMN session_id VARCHAR(255) AFTER id");
    } catch (e) {}

    connection.release();
  } catch (err) {
    console.error('ERROR DE CONEXIÓN REMOTA:', err.message);
  }
}

const getAdjustedDateTime = () => {
  const date = new Date();
  date.setHours(date.getHours() + 7);
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

const logAuditAction = async (sessionId, entityType, entityId, action, userEmail, details = null) => {
  try {
    const timestamp = getAdjustedDateTime();
    await pool.execute(
      'INSERT INTO audit_logs (session_id, entity_type, entity_id, action, user_email, timestamp, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sessionId || 'no-session', entityType, entityId, action, userEmail || 'unknown@system', timestamp, details]
    );
  } catch (err) {
    console.error('Error al guardar log de auditoría:', err.message);
  }
};

const isAuthenticated = (req, res, next) => {
  if (req.session.user) return next();
  res.status(401).json({ success: false, error: 'Sesión no iniciada' });
};

// --- AUTHENTICATION & SESSION HISTORY ---

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  try {
    await pool.execute('INSERT INTO users (email, password) VALUES (?, ?)', [email, password]);
    await logAuditAction(req.sessionID, 'user', email, 'REGISTER', email, 'Usuario registrado manualmente');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await pool.execute('SELECT email FROM users WHERE email = ? AND password = ?', [email, password]);
    if (users.length > 0) {
      req.session.user = { email: users[0].email };
      await logAuditAction(req.sessionID, 'session', 'auth', 'LOGIN', users[0].email, 'Inicio de sesión exitoso');
      res.json({ success: true, user: req.session.user });
    } else {
      res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/logout', isAuthenticated, async (req, res) => {
  const userEmail = req.session.user.email;
  const oldSessionID = req.sessionID;
  req.session.destroy(async (err) => {
    if (err) return res.status(500).json({ success: false });
    await logAuditAction(oldSessionID, 'session', 'auth', 'LOGOUT', userEmail, 'Cierre de sesión manual');
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.get('/api/session', (req, res) => {
  if (req.session.user) {
    res.json({ success: true, user: req.session.user });
  } else {
    res.status(401).json({ success: false });
  }
});

// --- PROTECTED ANALYTICS ROUTES WITH AUDIT ---

app.get('/api/groups', isAuthenticated, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups', isAuthenticated, async (req, res) => {
  const { name, subgroupCount } = req.body;
  const groupId = `g-${Date.now()}`;
  const createdAt = getAdjustedDateTime();
  const creator = req.session.user.email;
  try {
    await pool.execute('INSERT INTO analytics_groups (id, name, createdAt, status, created_by) VALUES (?, ?, ?, ?, ?)', [groupId, name, createdAt, 'No Publicado', creator]);
    await logAuditAction(req.sessionID, 'group', groupId, 'CREATE', creator, `Cultura: ${name}`);
    for (let i = 0; i < subgroupCount; i++) {
      const sgId = `sg-${Date.now()}-${i}`;
      await pool.execute('INSERT INTO analytics_subgroups (id, group_id, name, created_by) VALUES (?, ?, ?, ?)', [sgId, groupId, `Subgrupo ${i + 1}`, creator]);
    }
    res.json({ id: groupId, name, createdAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/groups/:id', isAuthenticated, async (req, res) => {
  const { name } = req.body;
  try {
    await pool.execute('UPDATE analytics_groups SET name = ? WHERE id = ?', [name, req.params.id]);
    await logAuditAction(req.sessionID, 'group', req.params.id, 'RENAME', req.session.user.email, `Nuevo nombre: ${name}`);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/groups/:id/status', isAuthenticated, async (req, res) => {
  const { status } = req.body;
  const publishedAt = status === 'Publicado' ? getAdjustedDateTime() : null;
  try {
    await pool.execute('UPDATE analytics_groups SET status = ?, publishedAt = ? WHERE id = ?', [status, publishedAt, req.params.id]);
    await logAuditAction(req.sessionID, 'group', req.params.id, 'STATUS_CHANGE', req.session.user.email, `Estado: ${status}`);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/groups/:id', isAuthenticated, async (req, res) => {
  try {
    await pool.execute('DELETE FROM analytics_groups WHERE id = ?', [req.params.id]);
    await logAuditAction(req.sessionID, 'group', req.params.id, 'DELETE', req.session.user.email, 'Eliminación de cultura');
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/subgroups/:subgroupId/links', isAuthenticated, async (req, res) => {
  const { subgroupId } = req.params;
  const { count, expiresAt } = req.body;
  const creator = req.session.user.email;
  const createdAt = getAdjustedDateTime();
  try {
    for (let i = 0; i < count; i++) {
      const linkId = `l-${Date.now()}-${i}`;
      const shortCode = `INS-${Math.random().toString(36).substring(7).toUpperCase()}`;
      await pool.execute('INSERT INTO smart_links (id, subgroup_id, label, targetUrl, shortCode, clicks, createdAt, expiresAt, created_by) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)', [linkId, subgroupId, `Link ${i+1}`, 'https://inspeaker.com.co', shortCode, createdAt, expiresAt, creator]);
    }
    await logAuditAction(req.sessionID, 'subgroup', subgroupId, 'GENERATE_LINKS', creator, `Generados ${count} links`);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDB();
const PORT = 3001;
app.listen(PORT, () => console.log(`Backend !NSPEAKER con Auditoría en puerto ${PORT}`));