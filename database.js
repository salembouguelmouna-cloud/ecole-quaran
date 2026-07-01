const bcrypt = require('bcryptjs');
const path = require('path');

function convertSql(sql, params) {
  let i = 0;
  const text = sql.replace(/\?/g, () => `$${++i}`);
  return { text, values: params };
}

let db;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  db = {
    get(sql, ...params) { return pool.query(convertSql(sql, params)).then(r => r.rows[0] || null); },
    all(sql, ...params) { return pool.query(convertSql(sql, params)).then(r => r.rows); },
    run(sql, ...params) { return pool.query(convertSql(sql, params)).then(r => ({ changes: r.rowCount, lastInsertRowid: null })); },
    exec(sql) { return pool.query(sql); },
    isPG: true,
  };
} else {
  const Database = require('better-sqlite3');
  const sqlite = new Database(path.join(__dirname, 'school.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  db = {
    get(sql, ...params) { return Promise.resolve(sqlite.prepare(sql).get(...params)); },
    all(sql, ...params) { return Promise.resolve(sqlite.prepare(sql).all(...params)); },
    run(sql, ...params) {
      const r = sqlite.prepare(sql).run(...params);
      return Promise.resolve({ changes: r.changes, lastInsertRowid: r.lastInsertRowid });
    },
    exec(sql) { return Promise.resolve(sqlite.exec(sql)); },
    isPG: false,
  };
}

async function initDB() {
  if (db.isPG) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        school_name TEXT DEFAULT 'منارة حميم',
        phone TEXT DEFAULT '',
        logo TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER NOT NULL DEFAULT 1 REFERENCES admins(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        level TEXT DEFAULT '',
        parent_name TEXT NOT NULL,
        parent_username TEXT UNIQUE NOT NULL,
        parent_password TEXT NOT NULL,
        parent_password_raw TEXT DEFAULT '',
        parent_phone TEXT DEFAULT '',
        photo TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS progress (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        date DATE NOT NULL DEFAULT CURRENT_DATE,
        presence BOOLEAN DEFAULT TRUE,
        memorization TEXT DEFAULT '',
        revision TEXT DEFAULT '',
        behavior TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT NOT NULL,
        school_name TEXT DEFAULT 'منارة حميم',
        phone TEXT DEFAULT '',
        logo TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER NOT NULL DEFAULT 1,
        name TEXT NOT NULL,
        level TEXT DEFAULT '',
        parent_name TEXT NOT NULL,
        parent_username TEXT UNIQUE NOT NULL,
        parent_password TEXT NOT NULL,
        parent_password_raw TEXT DEFAULT '',
        parent_phone TEXT DEFAULT '',
        photo TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        date DATE NOT NULL DEFAULT (date('now')),
        presence BOOLEAN DEFAULT 1,
        memorization TEXT DEFAULT '',
        revision TEXT DEFAULT '',
        behavior TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      );
    `);

    try { await db.exec('ALTER TABLE admins ADD COLUMN school_name TEXT DEFAULT \'منارة حميم\''); } catch (e) {}
    try { await db.exec('ALTER TABLE admins ADD COLUMN phone TEXT DEFAULT \'\''); } catch (e) {}
    try { await db.exec('ALTER TABLE admins ADD COLUMN logo TEXT DEFAULT \'\''); } catch (e) {}
    try { await db.exec('ALTER TABLE students ADD COLUMN admin_id INTEGER NOT NULL DEFAULT 1 REFERENCES admins(id)'); } catch (e) {}
    try { await db.exec('ALTER TABLE students ADD COLUMN parent_phone TEXT DEFAULT \'\''); } catch (e) {}
    try { await db.exec('ALTER TABLE students ADD COLUMN photo TEXT DEFAULT \'\''); } catch (e) {}
  }

  const adminExists = await db.get('SELECT COUNT(*) as count FROM admins');
  if (parseInt(adminExists.count) === 0) {
    const hashed = bcrypt.hashSync('admin123', 10);
    await db.run('INSERT INTO admins (username, password, name, school_name) VALUES (?, ?, ?, ?)', 'admin', hashed, 'الأستاذ', 'منارة حميم');
    console.log('الحساب الافتراضي: admin / admin123');
    console.log('يمكن للمدرسين إنشاء حساباتهم من /register');
  }
}

module.exports = db;
module.exports.ready = initDB().catch(e => { console.error('Database init error:', e); process.exit(1); });