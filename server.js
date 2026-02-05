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
    
    // MIGRACIÓN AUTOMÁTICA: Asegurar que las columnas existan
    console.log('Verificando integridad de columnas...');
    const tables = ['analytics_groups', 'analytics_subgroups', 'smart_links'];
    for (const table of tables) {
      try {
        await connection.query(`ALTER TABLE ${table} ADD COLUMN created_by VARCHAR(255) DEFAULT 'system@inspeaker.com.co' AFTER id`);
        console.log(`Columna 'created_by' agregada exitosamente a ${table}`);
      } catch (err) {
        if (err.code !== 'ER_DUP_FIELDNAME') {
          console.error(`Error verificando tabla ${table}:`, err.message);
        }
      }
    }

    // Crear tabla de usuarios si no existe y sembrar usuarios iniciales
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
      console.log('Sembrando usuarios iniciales...');
      await connection.query('INSERT INTO users (email, password) VALUES (?, ?), (?, ?)', [
        'lider.software@wisdomtecnology.com.co', 'GalaxyS2',
        'gerencia.ti@wisdomtecnology.com.co', 'Sittca1985!.'
      ]);
    }
    
    console.log('----------------------------------------');
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

// --- AUTHENTICATION ROUTES ---

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Datos incompletos' });
  
  try {
    const [existing] = await pool.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) return res.status(400).json({ success: false, error: 'El usuario ya existe' });

    await pool.execute('INSERT INTO users (email, password) VALUES (?, ?)', [email, password]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [users] = await pool.execute('SELECT email, password FROM users WHERE email = ? AND password = ?', [email, password]);
    if (users.length > 0) {
      res.json({ success: true, user: { email: users[0].email } });
    } else {
      res.status(401).json({ success: false, error: 'Credenciales inválidas' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ANALYTICS ROUTES ---

app.get('/l/:maskedCode', async (req, res) => {
  let { maskedCode } = req.params;
  let shortCode = maskedCode;
  try {
    const decoded = Buffer.from(maskedCode, 'base64').toString('utf-8');
    if (decoded.startsWith('INS-')) shortCode = decoded;
  } catch (e) {}

  const errorResponse = `<div style="text-align:center;padding:50px;font-family:sans-serif;background:#0A0A0A;color:white;height:100vh;display:flex;flex-direction:column;justify-content:center;"><h1 style="color:#F97316;font-size:4rem;margin:0;">ERROR</h1><h2 style="text-transform:uppercase;letter-spacing:0.2em;">Link No Reconocido</h2><p style="color:#666;">El enlace solicitado no está activo, ha expirado o el código es inválido.</p><a href="https://inspeaker.com.co" style="color:#F97316;text-decoration:none;margin-top:20px;font-weight:bold;">VOLVER A !NSPEAKER</a></div>`;

  try {
    const [rows] = await pool.execute(`SELECT l.*, g.status as groupStatus FROM smart_links l JOIN analytics_subgroups sg ON l.subgroup_id = sg.id JOIN analytics_groups g ON sg.group_id = g.id WHERE l.shortCode = ?`, [shortCode]);
    if (rows.length === 0) return res.status(404).send(errorResponse);
    const link = rows[0];
    const now = new Date();
    const expiry = new Date(link.expiresAt);
    expiry.setHours(23, 59, 59, 999);
    if (link.groupStatus !== 'Publicado' || now > expiry) return res.status(403).send(errorResponse);
    await pool.execute('UPDATE smart_links SET clicks = clicks + 1 WHERE id = ?', [link.id]);
    res.redirect(302, link.targetUrl);
  } catch (err) {
    res.status(500).send('Error interno del servidor !NSPEAKER.');
  }
});

app.get('/api/db-status', async (req, res) => {
  try {
    const start = Date.now();
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    const latency = Date.now() - start;
    res.json({ connected: true, host: dbConfig.host, latency: `${latency}ms` });
  } catch (err) {
    res.json({ connected: false });
  }
});

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
  const { name, subgroupCount, userEmail } = req.body;
  const groupId = `g-${Date.now()}`;
  const createdAt = getAdjustedDateTime();
  const creator = userEmail || 'system@inspeaker.com.co';
  try {
    await pool.execute('INSERT INTO analytics_groups (id, name, createdAt, status, created_by) VALUES (?, ?, ?, ?, ?)', [groupId, name, createdAt, 'No Publicado', creator]);
    await logAuditAction('group', groupId, 'CREATE', creator, `Nombre: ${name}, Subgrupos iniciales: ${subgroupCount}`);
    for (let i = 0; i < subgroupCount; i++) {
      const sgId = `sg-${Date.now()}-${i}`;
      await pool.execute('INSERT INTO analytics_subgroups (id, group_id, name, created_by) VALUES (?, ?, ?, ?)', [sgId, groupId, `Subgrupo ${i + 1}`, creator]);
      await logAuditAction('subgroup', sgId, 'CREATE_INITIAL', creator, `Perteneciente al grupo: ${groupId}`);
    }
    res.json({ id: groupId, name, createdAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/groups/:id', async (req, res) => {
  const { name, userEmail } = req.body;
  const creator = userEmail || 'system@inspeaker.com.co';
  try {
    const [rows] = await pool.execute('SELECT status FROM analytics_groups WHERE id = ?', [req.params.id]);
    if (rows.length > 0 && rows[0].status === 'Publicado') return res.status(403).json({ error: 'Bloqueado' });
    await pool.execute('UPDATE analytics_groups SET name = ? WHERE id = ?', [name, req.params.id]);
    await logAuditAction('group', req.params.id, 'RENAME', creator, `Nuevo nombre: ${name}`);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/groups/:id/status', async (req, res) => {
  const { status, userEmail } = req.body;
  const creator = userEmail || 'system@inspeaker.com.co';
  const publishedAt = status === 'Publicado' ? getAdjustedDateTime() : null;
  try {
    await pool.execute('UPDATE analytics_groups SET status = ?, publishedAt = ? WHERE id = ?', [status, publishedAt, req.params.id]);
    await logAuditAction('group', req.params.id, 'STATUS_CHANGE', creator, `Nuevo estado: ${status}`);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/groups/:id', async (req, res) => {
  const { userEmail } = req.query;
  const creator = userEmail || 'system@inspeaker.com.co';
  try {
    const [rows] = await pool.execute('SELECT status FROM analytics_groups WHERE id = ?', [req.params.id]);
    if (rows.length > 0 && rows[0].status === 'Publicado') return res.status(403).json({ error: 'Bloqueado' });
    await logAuditAction('group', req.params.id, 'DELETE', creator);
    await pool.execute('DELETE FROM analytics_groups WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/groups/:groupId/subgroups', async (req, res) => {
  const { name, count, userEmail } = req.body;
  const { groupId } = req.params;
  const creator = userEmail || 'system@inspeaker.com.co';
  try {
    for (let i = 0; i < (count || 1); i++) {
      const sgId = `sg-${Date.now()}-${i}`;
      const finalName = (count && count > 1) ? `${name} ${i + 1}` : name;
      await pool.execute('INSERT INTO analytics_subgroups (id, group_id, name, created_by) VALUES (?, ?, ?, ?)', [sgId, groupId, finalName, creator]);
      await logAuditAction('subgroup', sgId, 'CREATE', creator, `Nombre: ${finalName}, Grupo: ${groupId}`);
    }
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/subgroups/:id', async (req, res) => {
  const { name, userEmail } = req.body;
  const creator = userEmail || 'system@inspeaker.com.co';
  try {
    await pool.execute('UPDATE analytics_subgroups SET name = ? WHERE id = ?', [name, req.params.id]);
    await logAuditAction('subgroup', req.params.id, 'RENAME', creator, `Nuevo nombre: ${name}`);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/subgroups/:id', async (req, res) => {
  const { userEmail } = req.query;
  const creator = userEmail || 'system@inspeaker.com.co';
  try {
    await logAuditAction('subgroup', req.params.id, 'DELETE', creator);
    await pool.execute('DELETE FROM analytics_subgroups WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/subgroups/:subgroupId/links', async (req, res) => {
  const { subgroupId } = req.params;
  const { count, expiresAt, userEmail } = req.body;
  const creator = userEmail || 'system@inspeaker.com.co';
  const createdAt = getAdjustedDateTime();
  try {
    for (let i = 0; i < count; i++) {
      const linkId = `l-${Date.now()}-${i}`;
      const label = `Link Inteligente ${i + 1}`;
      const shortCode = `INS-${Math.random().toString(36).substring(7).toUpperCase()}`;
      await pool.execute('INSERT INTO smart_links (id, subgroup_id, label, targetUrl, shortCode, clicks, createdAt, expiresAt, created_by) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)', [linkId, subgroupId, label, 'https://inspeaker.com.co', shortCode, createdAt, expiresAt, creator]);
      await logAuditAction('link', linkId, 'CREATE', creator, `Label: ${label}, Subgrupo: ${subgroupId}, Expira: ${expiresAt}`);
    }
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/links/:id', async (req, res) => {
  const { label, expiresAt, userEmail } = req.body;
  const creator = userEmail || 'system@inspeaker.com.co';
  try {
    await pool.execute('UPDATE smart_links SET label = ?, expiresAt = ? WHERE id = ?', [label, expiresAt, req.params.id]);
    await logAuditAction('link', req.params.id, 'UPDATE', creator, `Nuevo label: ${label}, Nueva expiración: ${expiresAt}`);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/links/:id', async (req, res) => {
  const { userEmail } = req.query;
  const creator = userEmail || 'system@inspeaker.com.co';
  try {
    await logAuditAction('link', req.params.id, 'DELETE', creator);
    await pool.execute('DELETE FROM smart_links WHERE id = ?', [req.params.id]);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDB();
const PORT = 3001;
app.listen(PORT, () => console.log(`Backend !NSPEAKER escuchando en puerto ${PORT}`));
