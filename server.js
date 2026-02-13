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

// Conectar a MySQL
async function initDB() {
  try {
    pool = mysql.createPool(dbConfig);
    const connection = await pool.getConnection();
    connection.release();
    console.log('✅ Conectado a MySQL remoto');
  } catch (err) {
    console.error('❌ Error MySQL:', err.message);
  }
}

// Endpoint de prueba
app.get('/api/db-status', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    res.json({ connected: true });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

initDB();

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Backend corriendo en puerto ${PORT}`);
});
