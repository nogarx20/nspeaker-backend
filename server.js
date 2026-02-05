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
    
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const [rows] = await connection.query('SELECT COUNT(*) as count FROM users');
    if (rows[0].count === 0) {
      await connection.query('INSERT INTO users (email, password) VALUES (?, ?), (?, ?)', [
        'lider.software@wisdomtecnology.com.co', 'GalaxyS2',
        'gerencia.ti@wisdomtecnology.com.co', 'Sittca1985!.'
      ]);
    }
    
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

const logAuditAction = async (entityType, entityId, action, userEmail, details = null) => {
  try {
    const timestamp = getAdjustedDateTime();
    await pool.execute(
      'INSERT INTO audit_logs (entity_type, entity_id, action, user_email, timestamp, details) VALUES (?, ?, ?, ?, ?, ?)',
      [entityType, entityId, action, userEmail || 'unknown@system', timestamp, details]
    );
  } catch (err) {
    console.error('Error al guardar log de auditoría:', err.message);
  }
};

// --- REDIRECCIÓN CON FILTRO DE BOTS ---

app.get('/l/:maskedCode', async (req, res) => {
  let { maskedCode } = req.params;
  const userAgent = req.headers['user-agent'] || '';
  
  const botPatterns = [
    'WhatsApp', 'facebookexternalhit', 'Facebot', 'Twitterbot', 
    'LinkedInBot', 'Slackbot', 'TelegramBot', 'Discordbot', 
    'Googlebot', 'bingbot', 'Slack-ImgProxy', 'Slackbot-LinkExpanding',
    'Pinterest', 'crawler', 'bot', 'spider'
  ];
  
  const isBot = botPatterns.some(pattern => userAgent.toLowerCase().includes(pattern.toLowerCase()));

  let shortCode = maskedCode;
  try {
    const decoded = Buffer.from(maskedCode, 'base64').toString('utf-8');
    if (decoded.startsWith('INS-')) shortCode = decoded;
  } catch (e) {}

  const errorResponse = `<div style="text-align:center;padding:50px;font-family:sans-serif;background:#0A0A0A;color:white;height:100vh;display:flex;flex-direction:column;justify-content:center;"><h1 style="color:#F97316;font-size:4rem;margin:0;">ERROR</h1><h2 style="text-transform:uppercase;letter-spacing:0.2em;">Link No Reconocido</h2><p style="color:#666;">El enlace solicitado no está activo o ha expirado.</p><a href="https://inspeaker.com.co" style="color:#F97316;text-decoration:none;margin-top:20px;font-weight:bold;">VOLVER A !NSPEAKER</a></div>`;

  try {
    const [rows] = await pool.execute(`
      SELECT l.*, g.status as groupStatus 
      FROM smart_links l 
      JOIN analytics_subgroups sg ON l.subgroup_id = sg.id 
      JOIN analytics_groups g ON sg.group_id = g.id 
      WHERE l.shortCode = ?`, [shortCode]);
    
    if (rows.length === 0) return res.status(404).send(errorResponse);
    
    const link = rows[0];
    const now = new Date();
    const expiry = new Date(link.expiresAt);
    expiry.setHours(23, 59, 59, 999);

    if (link.groupStatus !== 'Publicado' || now > expiry) return res.status(403).send(errorResponse);

    if (!isBot) {
      await pool.execute('UPDATE smart_links SET clicks = clicks + 1 WHERE id = ?', [link.id]);
      await logAuditAction('link', link.id, 'CLICK_REAL', 'anonymous', `User-Agent: ${userAgent}`);
    } else {
      await logAuditAction('link', link.id, 'CRAWLER_PREVIEW', 'system', `Detección de Bot: ${userAgent}`);
    }

    res.redirect(302, link.targetUrl);
  } catch (err) {
    res.status(500).send('Error en el motor de redirección !NSPEAKER.');
  }
});

// --- AUTHENTICATION ---

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, error: 'El usuario ya existe' });
    }
    await pool.execute('INSERT INTO users (email, password) VALUES (?, ?)', [email, password]);
    await logAuditAction('user', email, 'REGISTER', email, 'Registro de nuevo usuario');
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
      await logAuditAction('session', 'auth', 'LOGIN', users[0].email, 'Inicio de sesión exitoso');
      res.json({ success: true, user: { email: users[0].email } });
    } else {
      res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  res.json({ success: true });
});

// --- CRUD ROUTES ---

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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups', async (req, res) => {
  const { name, subgroupCount } = req.body;
  const groupId = `g-${Date.now()}`;
  const createdAt = getAdjustedDateTime();
  const creator = 'system@inspeaker.com.co'; // En versión sin sesión, usamos un fallback o lo pasamos desde el front
  try {
    await pool.execute('INSERT INTO analytics_groups (id, name, createdAt, status, created_by) VALUES (?, ?, ?, ?, ?)', [groupId, name, createdAt, 'No Publicado', creator]);
    await logAuditAction('group', groupId, 'CREATE', creator, `Cultura: ${name}`);
    for (let i = 0; i < subgroupCount; i++) {
      const sgId = `sg-${Date.now()}-${i}`;
      await pool.execute('INSERT INTO analytics_subgroups (id, group_id, name, created_by) VALUES (?, ?, ?, ?)', [sgId, groupId, `Subgrupo ${i + 1}`, creator]);
    }
    res.json({ id: groupId, name, createdAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/db-status', async (req, res) => {
  try {
    const start = Date.now();
    await pool.execute('SELECT 1');
    const latency = Date.now() - start;
    res.json({ connected: true, host: dbConfig.host, latency: `${latency}ms` });
  } catch (err) {
    res.json({ connected: false });
  }
});

initDB();
const PORT = 3001;
app.listen(PORT, () => console.log(`Backend !NSPEAKER (Modo Stateless) en puerto ${PORT}`));
