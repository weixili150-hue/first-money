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
      countries_config TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS country_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country_id INTEGER NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      failure_type TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'unused',
      activation_id TEXT,
      phone_number TEXT,
      sms_code TEXT,
      purchased_at DATETIME,
      country_id INTEGER,
      price REAL,
      replace_count INTEGER DEFAULT 0,
      verify_started_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS pending_refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activation_id TEXT NOT NULL,
      purchased_at DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 迁移：给 cards 加 verify_started_at 列（兼容旧数据库）
  try { d.exec('ALTER TABLE cards ADD COLUMN verify_started_at DATETIME'); } catch (e) { /* 已存在 */ }
  // 迁移：给 cards 加 country_id 列
  try { d.exec('ALTER TABLE cards ADD COLUMN country_id INTEGER'); } catch (e) { /* 已存在 */ }
  // 迁移：给 cards 加 price 列（购买价位）
  try { d.exec('ALTER TABLE cards ADD COLUMN price REAL'); } catch (e) { /* 已存在 */ }
  // 迁移：给 cards 加 replace_count 列
  try { d.exec('ALTER TABLE cards ADD COLUMN replace_count INTEGER DEFAULT 0'); } catch (e) { /* 已存在 */ }
  // 迁移：给 country_failures 加 price 列
  try { d.exec('ALTER TABLE country_failures ADD COLUMN price REAL NOT NULL DEFAULT 0'); } catch (e) { /* 已存在 */ }
  // 迁移：给 configs 加 countries_config 列
  try { d.exec('ALTER TABLE configs ADD COLUMN countries_config TEXT DEFAULT \'[]\''); } catch (e) { /* 已存在 */ }

  // 确保 configs 有且仅有一行
  const row = d.prepare('SELECT id FROM configs').get();
  if (!row) {
    d.prepare("INSERT INTO configs (id, hero_api_key, service_code, country_id, max_price) VALUES (1, '', '', 0, 0)").run();
  }
}

// --- configs 操作 ---
function getConfig() {
  const row = getDb().prepare('SELECT * FROM configs WHERE id = 1').get();
  if (row && row.countries_config) {
    try { row.countries_config = JSON.parse(row.countries_config); } catch (e) { row.countries_config = []; }
  } else {
    row = { ...row, countries_config: [] };
  }

  // 环境变量覆盖数据库值（用于 Render 等部署平台，避免重新部署丢配置）
  if (process.env.HERO_API_KEY) row.hero_api_key = process.env.HERO_API_KEY;
  if (process.env.SERVICE_CODE) row.service_code = process.env.SERVICE_CODE;
  if (process.env.COUNTRY_ID) row.country_id = parseInt(process.env.COUNTRY_ID);
  if (process.env.MAX_PRICE) row.max_price = parseFloat(process.env.MAX_PRICE);
  if (process.env.COUNTRIES_CONFIG) {
    try { row.countries_config = JSON.parse(process.env.COUNTRIES_CONFIG); } catch (e) {}
  }

  return row;
}

function updateConfig({ hero_api_key, service_code, country_id, max_price, countries_config }) {
  const d = getDb();
  const configJson = countries_config ? JSON.stringify(countries_config) : null;
  d.prepare(`
    UPDATE configs
    SET hero_api_key = ?, service_code = ?, country_id = ?, max_price = ?,
        countries_config = COALESCE(?, countries_config),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(hero_api_key, service_code, country_id, max_price, configJson);
  return getConfig();
}

// --- country_failures 操作 ---
function recordCountryFailure(countryId, price, failureType) {
  return getDb().prepare(
    "INSERT INTO country_failures (country_id, price, failure_type) VALUES (?, ?, ?)"
  ).run(countryId, price, failureType);
}

function getRecentFailures(countryId, price, minutes) {
  const rows = getDb().prepare(`
    SELECT COUNT(*) as count FROM country_failures
    WHERE country_id = ? AND price = ? AND created_at >= datetime('now', '-' || ? || ' minutes')
  `).get(countryId, price, minutes);
  return rows.count;
}

function clearCountryFailures(countryId, price) {
  return getDb().prepare("DELETE FROM country_failures WHERE country_id = ? AND price = ?").run(countryId, price);
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

// --- pending_refunds 操作 ---
function addPendingRefund(activationId, purchasedAt) {
  return getDb().prepare(
    "INSERT INTO pending_refunds (activation_id, purchased_at) VALUES (?, ?)"
  ).run(activationId, purchasedAt);
}

function getPendingRefunds() {
  return getDb().prepare(
    "SELECT * FROM pending_refunds WHERE status = 'pending' ORDER BY created_at ASC"
  ).all();
}

function markRefundDone(id, result) {
  return getDb().prepare(
    "UPDATE pending_refunds SET status = ? WHERE id = ?"
  ).run(result, id);
}

// 标记用户已点击"我已发送验证码"
function setVerifyStarted(id) {
  return getDb().prepare(
    "UPDATE cards SET verify_started_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(id);
}

// 查找超过20分钟未操作的空闲活跃卡
function getIdleCards(minutes) {
  return getDb().prepare(`
    SELECT * FROM cards
    WHERE status = 'active'
      AND verify_started_at IS NULL
      AND purchased_at IS NOT NULL
      AND datetime(purchased_at, '+' || ? || ' minutes') <= datetime('now')
  `).all(minutes);
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
  addPendingRefund,
  getPendingRefunds,
  markRefundDone,
  setVerifyStarted,
  getIdleCards,
  recordCountryFailure,
  getRecentFailures,
  clearCountryFailures,
};
