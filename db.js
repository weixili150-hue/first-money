const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'first-money.db');

// 确保 data 目录存在
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTables();
  }
  return db;
}

function initTables() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS configs (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      hero_api_key TEXT NOT NULL DEFAULT '',
      service_code TEXT NOT NULL DEFAULT '',
      country_id INTEGER NOT NULL DEFAULT 0,
      max_price REAL NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'unused',
      activation_id TEXT,
      phone_number TEXT,
      sms_code TEXT,
      purchased_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME
    );
  `);

  // 确保 configs 有且仅有一行
  const row = d.prepare('SELECT id FROM configs').get();
  if (!row) {
    d.prepare("INSERT INTO configs (id, hero_api_key, service_code, country_id, max_price) VALUES (1, '', '', 0, 0)").run();
  }
}

// --- configs 操作 ---
function getConfig() {
  return getDb().prepare('SELECT * FROM configs WHERE id = 1').get();
}

function updateConfig({ hero_api_key, service_code, country_id, max_price }) {
  const d = getDb();
  d.prepare(`
    UPDATE configs
    SET hero_api_key = ?, service_code = ?, country_id = ?, max_price = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(hero_api_key, service_code, country_id, max_price);
  return getConfig();
}

// --- cards 操作 ---
function createCards(codes) {
  const d = getDb();
  const insert = d.prepare('INSERT INTO cards (code) VALUES (?)');
  const insertMany = d.transaction((codes) => {
    for (const code of codes) {
      insert.run(code);
    }
  });
  insertMany(codes);
  return codes;
}

function getCardByCode(code) {
  return getDb().prepare('SELECT * FROM cards WHERE code = ?').get(code);
}

function updateCard(id, fields) {
  const d = getDb();
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  vals.push(id);
  d.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getDb().prepare('SELECT * FROM cards WHERE id = ?').get(id);
}

function getCards({ page = 1, limit = 50, status } = {}) {
  const d = getDb();
  let sql = 'SELECT * FROM cards';
  const conditions = [];
  const params = [];
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, (page - 1) * limit);
  const rows = d.prepare(sql).all(...params);
  const total = d.prepare('SELECT COUNT(*) as count FROM cards').get().count;
  return { rows, total, page, limit };
}

function getUnusedCards() {
  return getDb().prepare("SELECT * FROM cards WHERE status = 'unused' ORDER BY created_at DESC").all();
}

module.exports = {
  getDb,
  getConfig,
  updateConfig,
  createCards,
  getCardByCode,
  updateCard,
  getCards,
  getUnusedCards,
};
