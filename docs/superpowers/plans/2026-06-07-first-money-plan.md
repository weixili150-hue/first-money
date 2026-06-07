# First Money 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建手机验证码中间商平台 — 后台生成卡密导入闲鱼，用户凭卡密兑换国外手机号用于 OpenAI 验证。

**Architecture:** Node.js Express 后端 + SQLite 数据库 + 纯 HTML 前端。核心逻辑在 card-service.js 中编排 HeroSMS API（hero-api.js）。4 层结构：路由层(server.js) → 业务层(card-service.js) → API层(hero-api.js) → 数据层(db.js)。

**Tech Stack:** Node.js, Express, better-sqlite3, 原生 HTML/CSS/JS

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `server.js` | Express 启动、路由注册、中间件 |
| `db.js` | SQLite 建表、CRUD 操作 |
| `hero-api.js` | HeroSMS API 封装（纯 HTTP 调用） |
| `card-service.js` | 兑换流程编排、轮询、退款换号 |
| `public/index.html` | 用户兑换页面（输入卡密→手机号→验证码） |
| `public/admin.html` | 管理后台（配置、生成卡密、查看订单） |
| `package.json` | 项目依赖配置 |
| `.env.example` | 环境变量说明 |

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `.gitignore`

- [ ] **Step 1: 初始化 package.json**

```bash
cd ~/Projects/first-money && npm init -y
```

- [ ] **Step 2: 安装依赖**

```bash
cd ~/Projects/first-money && npm install express better-sqlite3 dotenv
```

- [ ] **Step 3: 修改 package.json 添加启动脚本**

```json
{
  "name": "first-money",
  "version": "1.0.0",
  "description": "手机验证码中间商平台",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "dotenv": "^16.0.0",
    "express": "^4.21.0"
  }
}
```

- [ ] **Step 4: 创建 .env.example**

```
PORT=3000
ADMIN_PASSWORD=admin123
```

- [ ] **Step 5: 创建 .gitignore**

```
node_modules/
data/
.env
```

- [ ] **Step 6: 创建 data 目录**

```bash
mkdir -p ~/Projects/first-money/data
```

- [ ] **Step 7: 验证**

```bash
cd ~/Projects/first-money && node -e "require('express'); require('better-sqlite3'); console.log('OK')"
```
Expected: `OK`

---

### Task 2: 数据库层 (db.js)

**Files:**
- Create: `db.js`

- [ ] **Step 1: 创建 db.js**

```javascript
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'first-money.db');

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
```

- [ ] **Step 2: 验证数据库初始化**

```bash
cd ~/Projects/first-money && node -e "
const { getDb, getConfig, getCardByCode } = require('./db');
getDb();
const c = getConfig();
console.log('配置:', JSON.stringify(c));
console.log('OK');
"
```

Expected: 显示默认配置和 `OK`

---

### Task 3: HeroSMS API 封装 (hero-api.js)

**Files:**
- Create: `hero-api.js`

- [ ] **Step 1: 创建 hero-api.js**

```javascript
const BASE = 'https://hero-sms.com/stubs/handler_api.php';

async function call(apiKey, params) {
  const url = new URL(BASE);
  url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString());
  const text = await res.text();
  return text.trim();
}

// 查余额
async function getBalance(apiKey) {
  const result = await call(apiKey, { action: 'getBalance' });
  // 返回格式: ACCESS_BALANCE:100.5
  const match = result.match(/ACCESS_BALANCE:([\d.]+)/);
  return match ? parseFloat(match[1]) : null;
}

// 买号码
async function getNumber(apiKey, { service, country, maxPrice }) {
  const result = await call(apiKey, {
    action: 'getNumber',
    service,
    country,
    maxPrice: maxPrice || undefined,
  });
  // 返回格式: ACCESS_NUMBER:激活ID:手机号
  if (result.startsWith('ACCESS_NUMBER:')) {
    const parts = result.split(':');
    return { activationId: parts[1], phoneNumber: parts[2] };
  }
  return { error: result };
}

// 查激活状态
async function getStatus(apiKey, activationId) {
  const result = await call(apiKey, { action: 'getStatus', id: activationId });
  // STATUS_WAIT_CODE | STATUS_OK:验证码 | STATUS_CANCEL ...
  return result;
}

// 取消激活（退款）
async function cancelActivation(apiKey, activationId) {
  const result = await call(apiKey, {
    action: 'setStatus',
    id: activationId,
    status: 8,
  });
  return result;
}

// 查价格
async function getPrices(apiKey, { service, country }) {
  const result = await call(apiKey, {
    action: 'getPrices',
    service,
    country,
  });
  return result;
}

module.exports = {
  getBalance,
  getNumber,
  getStatus,
  cancelActivation,
  getPrices,
};
```

- [ ] **Step 2: 验证文件加载**

```bash
cd ~/Projects/first-money && node -e "
const hero = require('./hero-api');
console.log('方法:', Object.keys(hero).join(', '));
console.log('OK');
"
```

Expected: `方法: getBalance, getNumber, getStatus, cancelActivation, getPrices` 和 `OK`

---

### Task 4: 核心业务逻辑 (card-service.js)

**Files:**
- Create: `card-service.js`

- [ ] **Step 1: 创建 card-service.js**

```javascript
const { getConfig, getCardByCode, updateCard } = require('./db');
const { getBalance, getNumber, getStatus, cancelActivation } = require('./hero-api');

// 轮询间隔（毫秒）
const POLL_INTERVAL = 5000;
// 退款冷静期（毫秒）
const COOLDOWN_MS = 120 * 1000; // 2 分钟

function getConfigOrThrow() {
  const config = getConfig();
  if (!config.hero_api_key) throw new Error('请先配置 HeroSMS API Key');
  if (!config.service_code) throw new Error('请先配置服务代码');
  if (!config.country_id) throw new Error('请先配置国家 ID');
  return config;
}

// 兑换卡密 → 购买手机号
async function redeemCard(code) {
  const card = getCardByCode(code);
  if (!card) return { success: false, error: '卡密不存在' };
  if (card.status !== 'unused') return { success: false, error: '卡密已被使用' };

  const config = getConfigOrThrow();

  // 查余额
  const balance = await getBalance(config.hero_api_key);
  if (balance === null) return { success: false, error: '查询余额失败，请检查 API Key' };
  if (balance < config.max_price) return { success: false, error: '系统余额不足，请联系管理员' };

  // 买号
  const result = await getNumber(config.hero_api_key, {
    service: config.service_code,
    country: config.country_id,
    maxPrice: config.max_price,
  });

  if (result.error) {
    if (result.error === 'NO_NUMBERS') return { success: false, error: '当前号码售罄，请稍后再试' };
    if (result.error === 'NO_BALANCE') return { success: false, error: '系统余额不足，请联系管理员' };
    return { success: false, error: `购买号码失败: ${result.error}` };
  }

  // 更新卡密
  updateCard(card.id, {
    status: 'active',
    activation_id: result.activationId,
    phone_number: result.phoneNumber,
    purchased_at: new Date().toISOString(),
    used_at: new Date().toISOString(),
  });

  return {
    success: true,
    phoneNumber: result.phoneNumber,
    activationId: result.activationId,
  };
}

// 轮询获取验证码
async function pollForCode(code) {
  const card = getCardByCode(code);
  if (!card || !card.activation_id) return { success: false, error: '无激活记录' };
  if (card.status === 'completed' && card.sms_code) {
    return { success: true, smsCode: card.sms_code, phoneNumber: card.phone_number };
  }

  const config = getConfigOrThrow();
  const result = await getStatus(config.hero_api_key, card.activation_id);

  if (result.startsWith('STATUS_OK:')) {
    const smsCode = result.split(':')[1] || '';
    updateCard(card.id, { status: 'completed', sms_code: smsCode });
    return { success: true, smsCode, phoneNumber: card.phone_number };
  }

  // 检查是否已到 2 分钟退款窗口
  const elapsed = card.purchased_at ? Date.now() - new Date(card.purchased_at).getTime() : 0;
  const canRefund = elapsed >= COOLDOWN_MS;

  return {
    success: false,
    waiting: !canRefund,
    status: result,
    elapsedMs: elapsed,
    canRefund,
  };
}

// 超时退款换号
async function handleTimeout(code) {
  const card = getCardByCode(code);
  if (!card || !card.activation_id) return { success: false, error: '无激活记录' };
  if (card.status === 'completed' && card.sms_code) {
    return { success: true, smsCode: card.sms_code, phoneNumber: card.phone_number };
  }

  const config = getConfigOrThrow();

  // 最后查一次码
  const lastStatus = await getStatus(config.hero_api_key, card.activation_id);
  if (lastStatus.startsWith('STATUS_OK:')) {
    const smsCode = lastStatus.split(':')[1] || '';
    updateCard(card.id, { status: 'completed', sms_code: smsCode });
    return { success: true, smsCode, phoneNumber: card.phone_number };
  }

  // 退款
  const cancelResult = await cancelActivation(config.hero_api_key, card.activation_id);
  
  if (cancelResult === 'OTP_RECEIVED' || cancelResult.includes('OTP_RECEIVED')) {
    // 退款被拒，码刚好到
    const statusResult = await getStatus(config.hero_api_key, card.activation_id);
    if (statusResult.startsWith('STATUS_OK:')) {
      const smsCode = statusResult.split(':')[1] || '';
      updateCard(card.id, { status: 'completed', sms_code: smsCode });
      return { success: true, smsCode, phoneNumber: card.phone_number };
    }
    return { success: false, error: '该号码已收到验证码但获取失败，请联系管理员' };
  }

  if (cancelResult !== 'ACCESS_CANCEL') {
    return { success: false, error: `退款失败: ${cancelResult}` };
  }

  // 退款成功 → 买新号
  const result = await getNumber(config.hero_api_key, {
    service: config.service_code,
    country: config.country_id,
    maxPrice: config.max_price,
  });

  if (result.error) {
    return { success: false, error: `新号码购买失败: ${result.error}` };
  }

  // 更新同一行
  updateCard(card.id, {
    activation_id: result.activationId,
    phone_number: result.phoneNumber,
    sms_code: null,
    purchased_at: new Date().toISOString(),
  });

  return {
    success: true,
    replaced: true,
    phoneNumber: result.phoneNumber,
    activationId: result.activationId,
  };
}

// 用户主动换号
async function requestReplaceNumber(code) {
  const card = getCardByCode(code);
  if (!card || !card.activation_id) return { success: false, error: '无激活记录' };

  const elapsed = card.purchased_at ? Date.now() - new Date(card.purchased_at).getTime() : 0;
  if (elapsed < COOLDOWN_MS) {
    const remainSeconds = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    return { success: false, error: `请等待 ${remainSeconds} 秒后再更换`, cooldownRemaining: remainSeconds };
  }

  return handleTimeout(code);
}

module.exports = {
  redeemCard,
  pollForCode,
  handleTimeout,
  requestReplaceNumber,
  COOLDOWN_MS,
  POLL_INTERVAL,
};
```

- [ ] **Step 2: 验证文件加载**

```bash
cd ~/Projects/first-money && node -e "
const cs = require('./card-service');
console.log('方法:', Object.keys(cs).join(', '));
console.log('OK');
"
```

Expected: `方法: redeemCard, pollForCode, handleTimeout, requestReplaceNumber, COOLDOWN_MS, POLL_INTERVAL` 和 `OK`

---

### Task 5: Express 服务入口 + API 路由 (server.js)

**Files:**
- Create: `server.js`

- [ ] **Step 1: 创建 server.js**

```javascript
require('dotenv').config();
const express = require('express');
const path = require('path');
const {
  getConfig,
  updateConfig,
  createCards,
  getCardByCode,
  getCards,
  getUnusedCards,
} = require('./db');
const {
  redeemCard,
  pollForCode,
  handleTimeout,
  requestReplaceNumber,
  COOLDOWN_MS,
  POLL_INTERVAL,
} = require('./card-service');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- 管理后台鉴权中间件 ----
function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }
  next();
}

// ---- 用户 API ----

// 兑换卡密
app.post('/api/redeem', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: '请输入卡密' });
    const result = await redeemCard(code.trim().toUpperCase());
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 轮询验证码
app.get('/api/status/:code', async (req, res) => {
  try {
    const result = await pollForCode(req.params.code);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取冷却剩余时间
app.get('/api/cooldown/:code', (req, res) => {
  const card = getCardByCode(req.params.code);
  if (!card || !card.purchased_at) return res.json({ cooldownRemaining: 0 });
  const elapsed = Date.now() - new Date(card.purchased_at).getTime();
  const remaining = Math.max(0, Math.ceil((COOLDOWN_MS - elapsed) / 1000));
  res.json({ cooldownRemaining: remaining, canRefund: remaining === 0 });
});

// 用户主动换号
app.post('/api/replace', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: '缺少卡密' });
    const result = await requestReplaceNumber(code.trim().toUpperCase());
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 超时退款换号（前端自动调用）
app.post('/api/timeout', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: '缺少卡密' });
    const result = await handleTimeout(code.trim().toUpperCase());
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- 管理后台 API ----

// 登录验证
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: '密码错误' });
  res.json({ success: true, token: ADMIN_PASSWORD });
});

// 获取配置
app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json(getConfig());
});

// 更新配置
app.post('/api/admin/config', requireAdmin, (req, res) => {
  const { hero_api_key, service_code, country_id, max_price } = req.body;
  if (!hero_api_key || !service_code || !country_id || max_price === undefined) {
    return res.status(400).json({ error: '所有字段均为必填' });
  }
  const config = updateConfig({
    hero_api_key,
    service_code,
    country_id: parseInt(country_id),
    max_price: parseFloat(max_price),
  });
  res.json(config);
});

// 生成卡密
app.post('/api/admin/cards', requireAdmin, (req, res) => {
  const { count } = req.body;
  const n = parseInt(count);
  if (!n || n < 1 || n > 500) return res.status(400).json({ error: '数量应在 1-500 之间' });
  const codes = [];
  for (let i = 0; i < n; i++) {
    const seg = () => Math.random().toString(36).substring(2, 6).toUpperCase();
    codes.push(`FM-${seg()}-${seg()}-${seg()}`);
  }
  createCards(codes);
  res.json({ codes });
});

// 卡密列表
app.get('/api/admin/cards', requireAdmin, (req, res) => {
  const { page, limit, status } = req.query;
  const result = getCards({
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 50,
    status,
  });
  res.json(result);
});

// 导出未使用卡密
app.get('/api/admin/cards/export', requireAdmin, (req, res) => {
  const cards = getUnusedCards();
  const text = cards.map(c => c.code).join('\n');
  res.setHeader('Content-Type', 'text/plain');
  res.send(text);
});

app.listen(PORT, () => {
  console.log(`First Money 运行在 http://localhost:${PORT}`);
});
```

- [ ] **Step 2: 启动服务验证**

```bash
cd ~/Projects/first-money && timeout 3 node server.js 2>&1 || true
```

Expected: `First Money 运行在 http://localhost:3000`

---

### Task 6: 用户兑换页 (public/index.html)

**Files:**
- Create: `public/index.html`

- [ ] **Step 1: 创建 public/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>First Money - 验证码兑换</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #0f0f0f;
  color: #e0e0e0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px;
}
.container { max-width: 420px; width: 100%; }
.header { text-align: center; margin: 40px 0 32px; }
.header h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; color: #fff; }
.header p { font-size: 14px; color: #888; }

.card {
  background: #1a1a1a;
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 16px;
  border: 1px solid #2a2a2a;
}

.input-group { margin-bottom: 16px; }
.input-group label { display: block; font-size: 13px; color: #999; margin-bottom: 6px; }
.input-group input {
  width: 100%; padding: 12px 16px;
  background: #111; border: 1px solid #333; border-radius: 8px;
  color: #fff; font-size: 18px; text-align: center;
  letter-spacing: 2px; outline: none;
}
.input-group input:focus { border-color: #4f9cff; }
.input-group input::placeholder { color: #555; font-size: 14px; }

.btn {
  width: 100%; padding: 12px;
  border: none; border-radius: 8px;
  font-size: 16px; font-weight: 600;
  cursor: pointer; transition: opacity 0.2s;
  color: #fff;
}
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary { background: #4f9cff; }
.btn-primary:hover:not(:disabled) { background: #3d8bfd; }
.btn-danger { background: #444; }
.btn-danger:hover:not(:disabled) { background: #555; }
.btn-outline { background: transparent; color: #4f9cff; border: 1px solid #4f9cff; }

/* 手机号显示 */
.phone-box {
  background: #111; border: 1px solid #333; border-radius: 8px;
  padding: 16px; text-align: center; margin: 12px 0;
}
.phone-number {
  font-size: 32px; font-weight: 700; color: #4f9cff;
  letter-spacing: 1px; word-break: break-all; user-select: all;
}
.phone-hint { font-size: 13px; color: #777; margin-top: 8px; }

/* 验证码显示 */
.code-box {
  background: #0a1a0a; border: 1px solid #2a5a2a; border-radius: 8px;
  padding: 16px; text-align: center; margin: 12px 0;
}
.code-number {
  font-size: 36px; font-weight: 700; color: #4cff4c;
  letter-spacing: 4px; user-select: all;
}

/* 状态提示 */
.status-text { text-align: center; font-size: 14px; color: #888; margin: 8px 0; }
.status-text.waiting { color: #f0a040; }
.status-text.success { color: #4cff4c; }

.hidden { display: none; }
.section { margin-top: 16px; }
.btn-row { display: flex; gap: 10px; margin-top: 12px; }
.btn-row .btn { flex: 1; }

.error-toast {
  position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
  background: #c0392b; color: #fff; padding: 12px 24px;
  border-radius: 8px; font-size: 14px; z-index: 100;
  animation: fadeIn 0.3s;
}
@keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(-10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>First Money</h1>
    <p>输入您的兑换码以获取验证服务</p>
  </div>

  <!-- 输入卡密 -->
  <div class="card" id="inputCard">
    <div class="input-group">
      <label>兑换码</label>
      <input type="text" id="codeInput" placeholder="FM-XXXX-XXXX-XXXX" maxlength="17" autocomplete="off">
    </div>
    <button class="btn btn-primary" id="redeemBtn" onclick="doRedeem()">确认兑换</button>
  </div>

  <!-- 手机号显示 -->
  <div class="card hidden" id="phoneCard">
    <div class="phone-box">
      <div style="font-size:12px;color:#777;margin-bottom:4px;">您的手机号</div>
      <div class="phone-number" id="phoneDisplay">---</div>
    </div>
    <div class="phone-hint">请将此号码输入到 OpenAI 验证页面</div>
    
    <div class="btn-row">
      <button class="btn btn-danger" id="replaceBtn" onclick="doReplace()">号码不可用，换一个</button>
      <button class="btn btn-primary" id="sendCodeBtn" onclick="doSendCode()">我已发送验证码</button>
    </div>
    <div id="cooldownHint" class="status-text hidden"></div>
  </div>

  <!-- 验证码显示 -->
  <div class="card hidden" id="codeCard">
    <div class="code-box">
      <div style="font-size:12px;color:#777;margin-bottom:4px;">您的验证码</div>
      <div class="code-number" id="codeDisplay">---</div>
    </div>
    <div id="codeStatus" class="status-text success">验证码获取成功</div>
  </div>

  <!-- 等待状态 -->
  <div class="card hidden" id="waitingCard">
    <div class="status-text waiting" id="waitingText">正在获取验证码...</div>
  </div>
</div>

<script>
let currentCode = '';
let pollingTimer = null;

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'error-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function $(id) { return document.getElementById(id); }

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

async function api(url, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const res = await fetch(url, opts);
  return res.json();
}

async function doRedeem() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return showToast('请输入兑换码');
  
  $('redeemBtn').disabled = true;
  $('redeemBtn').textContent = '处理中...';
  
  const res = await api('/api/redeem', { code });
  
  if (res.success) {
    currentCode = code;
    $('phoneDisplay').textContent = res.phoneNumber;
    hide($('inputCard'));
    show($('phoneCard'));
    hide($('codeCard'));
    hide($('waitingCard'));
  } else {
    showToast(res.error || '兑换失败');
    $('redeemBtn').disabled = false;
    $('redeemBtn').textContent = '确认兑换';
  }
}

async function doSendCode() {
  hide($('codeCard'));
  show($('waitingCard'));
  $('sendCodeBtn').disabled = true;
  $('replaceBtn').disabled = true;
  
  await startPolling();
}

async function doReplace() {
  $('sendCodeBtn').disabled = true;
  $('replaceBtn').disabled = true;
  $('waitingText').textContent = '正在为您更换新号码...';
  hide($('codeCard'));
  show($('waitingCard'));
  
  const res = await api('/api/replace', { code: currentCode });
  
  if (res.success) {
    $('phoneDisplay').textContent = res.phoneNumber;
    $('waitingText').textContent = '新号码已就绪';
    setTimeout(() => { hide($('waitingCard')); }, 1000);
    $('sendCodeBtn').disabled = false;
    $('replaceBtn').disabled = false;
    hide($('cooldownHint'));
  } else {
    if (res.smsCode) {
      showCode(res.smsCode);
    } else {
      showToast(res.error || '操作失败');
      $('sendCodeBtn').disabled = false;
      $('replaceBtn').disabled = false;
      hide($('waitingCard'));
    }
  }
}

function showCode(smsCode) {
  $('codeDisplay').textContent = smsCode;
  hide($('phoneCard'));
  hide($('waitingCard'));
  show($('codeCard'));
}

async function startPolling() {
  const purchasedAt = Date.now(); // 大约的时间，实际以后端为准
  let timeoutTriggered = false;
  
  async function poll() {
    const cooldownRes = await api('/api/cooldown/' + currentCode);
    const remaining = cooldownRes.cooldownRemaining || 0;
    
    // 检查冷却倒计时
    if (remaining > 0) {
      $('waitingText').textContent = `正在获取验证码...`;
      // 轮询不要过频，10 秒一次
      pollingTimer = setTimeout(poll, 10000);
      return;
    }
    
    // 可以退款了
    if (!timeoutTriggered) {
      const res = await api('/api/status/' + currentCode);
      
      if (res.success) {
        // 拿到码了
        showCode(res.smsCode);
        return;
      }
      
      if (res.canRefund) {
        // 到了 2 分钟，还没码 → 触发超时退款
        timeoutTriggered = true;
        $('waitingText').textContent = '正在为您更换新号码...';
        
        const timeoutRes = await api('/api/timeout', { code: currentCode });
        
        if (timeoutRes.success && timeoutRes.smsCode) {
          showCode(timeoutRes.smsCode);
          return;
        }
        
        if (timeoutRes.success && timeoutRes.replaced) {
          // 换了新号
          $('phoneDisplay').textContent = timeoutRes.phoneNumber;
          $('waitingText').textContent = '新号码已就绪，请重新输入并发送验证码';
          setTimeout(() => { hide($('waitingCard')); }, 1500);
          $('sendCodeBtn').disabled = false;
          $('replaceBtn').disabled = false;
          return;
        }
        
        showToast(timeoutRes.error || '操作失败');
        hide($('waitingCard'));
        $('sendCodeBtn').disabled = false;
        $('replaceBtn').disabled = false;
        return;
      }
    }
    
    pollingTimer = setTimeout(poll, 5000);
  }
  
  poll();
}

// 页面卸载时清除定时器
window.addEventListener('beforeunload', () => {
  if (pollingTimer) clearTimeout(pollingTimer);
});
</script>
</body>
</html>
```

- [ ] **Step 2: 验证页面可访问**

```bash
cd ~/Projects/first-money && node -e "
const express = require('express');
const app = express();
app.use(express.static('public'));
app.listen(3001, () => console.log('OK'));
" &
sleep 1 && curl -s http://localhost:3001/index.html | head -5
kill %1 2>/dev/null
```

Expected: HTML 内容输出

---

### Task 7: 管理后台页 (public/admin.html)

**Files:**
- Create: `public/admin.html`

- [ ] **Step 1: 创建 public/admin.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>First Money - 管理后台</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #0f0f0f;
  color: #e0e0e0;
  min-height: 100vh;
  padding: 24px;
}
.container { max-width: 720px; margin: 0 auto; }
h1 { font-size: 22px; margin-bottom: 24px; color: #fff; }
h2 { font-size: 16px; color: #999; margin-bottom: 12px; border-bottom: 1px solid #2a2a2a; padding-bottom: 8px; }

.card {
  background: #1a1a1a;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  border: 1px solid #2a2a2a;
}

.input-row { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; }
.input-row label { font-size: 13px; color: #999; min-width: 100px; }
.input-row input {
  flex: 1; padding: 10px 12px;
  background: #111; border: 1px solid #333; border-radius: 6px;
  color: #fff; font-size: 14px; outline: none;
}
.input-row input:focus { border-color: #4f9cff; }

.btn {
  padding: 10px 20px; border: none; border-radius: 6px;
  font-size: 14px; font-weight: 600; cursor: pointer;
  color: #fff; transition: opacity 0.2s;
}
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary { background: #4f9cff; }
.btn-primary:hover:not(:disabled) { background: #3d8bfd; }
.btn-outline { background: transparent; border: 1px solid #4f9cff; color: #4f9cff; }
.btn-sm { padding: 6px 12px; font-size: 12px; }

/* 卡密列表 */
.code-list {
  background: #111; border: 1px solid #333; border-radius: 6px;
  max-height: 200px; overflow-y: auto; padding: 12px;
  margin: 12px 0;
}
.code-list code { display: block; font-size: 13px; color: #4f9cff; padding: 2px 0; font-family: monospace; }

/* 订单表格 */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #2a2a2a; }
th { color: #999; font-weight: 600; }
td { color: #ccc; }

.status-badge {
  padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
}
.status-unused { background: #2a2a2a; color: #888; }
.status-active { background: #1a3a5a; color: #4f9cff; }
.status-completed { background: #1a3a1a; color: #4cff4c; }

.hidden { display: none; }
.success-text { color: #4cff4c; font-size: 13px; margin-top: 8px; }
.error-text { color: #e74c3c; font-size: 13px; margin-top: 8px; }

.error-toast {
  position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
  background: #c0392b; color: #fff; padding: 12px 24px;
  border-radius: 8px; font-size: 14px; z-index: 100;
}
</style>
</head>
<body>
<div class="container">
  <h1>First Money 管理后台</h1>

  <!-- 登录 -->
  <div class="card" id="loginCard">
    <h2>管理员登录</h2>
    <div class="input-row">
      <label>密码</label>
      <input type="password" id="pwdInput" placeholder="管理员密码">
    </div>
    <button class="btn btn-primary" onclick="doLogin()">登录</button>
  </div>

  <!-- 主内容 -->
  <div id="mainContent" class="hidden">

    <!-- 配置 -->
    <div class="card">
      <h2>HeroSMS 配置</h2>
      <div class="input-row">
        <label>API Key</label>
        <input type="password" id="apiKeyInput" placeholder="HeroSMS API Key">
      </div>
      <div class="input-row">
        <label>服务代码</label>
        <input type="text" id="serviceInput" placeholder="如 op (OpenAI)">
      </div>
      <div class="input-row">
        <label>国家 ID</label>
        <input type="number" id="countryInput" placeholder="如 2 (哈萨克斯坦)">
      </div>
      <div class="input-row">
        <label>最高价格($)</label>
        <input type="number" id="priceInput" placeholder="如 0.5" step="0.01">
      </div>
      <button class="btn btn-primary" onclick="saveConfig()">保存配置</button>
      <div id="configMsg"></div>
    </div>

    <!-- 生成卡密 -->
    <div class="card">
      <h2>生成卡密</h2>
      <div class="input-row">
        <label>数量</label>
        <input type="number" id="countInput" value="10" min="1" max="500">
      </div>
      <button class="btn btn-primary" onclick="generateCards()">生成</button>
      <div id="generatedCodes" class="code-list hidden"></div>
      <button class="btn btn-outline btn-sm hidden" id="copyBtn" onclick="copyCodes()">一键复制</button>
      <button class="btn btn-outline btn-sm hidden" id="exportBtn" onclick="exportCards()">导出未使用卡密</button>
    </div>

    <!-- 订单记录 -->
    <div class="card">
      <h2>订单记录</h2>
      <div id="ordersTable"></div>
      <div style="margin-top:12px;">
        <button class="btn btn-outline btn-sm" onclick="loadOrders()">刷新</button>
      </div>
    </div>

  </div>
</div>

<script>
let token = '';

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'error-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function $(id) { return document.getElementById(id); }

async function api(url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-admin-password'] = token;
  const opts = body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers };
  const res = await fetch(url, opts);
  return res.json();
}

async function doLogin() {
  const pwd = $('pwdInput').value;
  const res = await api('/api/admin/login', { password: pwd });
  if (res.success) {
    token = pwd;
    $('loginCard').classList.add('hidden');
    $('mainContent').classList.remove('hidden');
    loadConfig();
    loadOrders();
  } else {
    showToast('密码错误');
  }
}

async function loadConfig() {
  try {
    const res = await api('/api/admin/config');
    $('apiKeyInput').value = res.hero_api_key || '';
    $('serviceInput').value = res.service_code || '';
    $('countryInput').value = res.country_id || '';
    $('priceInput').value = res.max_price || '';
  } catch(e) {}
}

async function saveConfig() {
  const res = await api('/api/admin/config', {
    hero_api_key: $('apiKeyInput').value,
    service_code: $('serviceInput').value,
    country_id: parseInt($('countryInput').value) || 0,
    max_price: parseFloat($('priceInput').value) || 0,
  });
  const msg = $('configMsg');
  if (res.error) {
    msg.className = 'error-text';
    msg.textContent = res.error;
  } else {
    msg.className = 'success-text';
    msg.textContent = '配置已保存';
    setTimeout(() => { msg.textContent = ''; }, 2000);
  }
}

async function generateCards() {
  const count = parseInt($('countInput').value);
  if (!count || count < 1 || count > 500) return showToast('数量应在 1-500 之间');
  
  const res = await api('/api/admin/cards', { count });
  if (res.error) return showToast(res.error);
  
  const list = $('generatedCodes');
  list.innerHTML = res.codes.map(c => `<code>${c}</code>`).join('');
  list.classList.remove('hidden');
  $('copyBtn').classList.remove('hidden');
  $('exportBtn').classList.remove('hidden');
}

function copyCodes() {
  const text = $('generatedCodes').innerText;
  navigator.clipboard.writeText(text).then(() => showToast('已复制到剪贴板'));
}

async function exportCards() {
  const res = await fetch('/api/admin/cards/export', { headers: { 'x-admin-password': token } });
  const text = await res.text();
  if (!text.trim()) return showToast('没有未使用的卡密');
  navigator.clipboard.writeText(text).then(() => showToast('已复制 ' + text.split('\n').length + ' 个卡密'));
}

async function loadOrders() {
  const res = await api('/api/admin/cards?limit=50');
  if (res.error) return;
  
  const badges = {
    unused: 'status-unused',
    active: 'status-active',
    completed: 'status-completed',
  };
  
  let html = '<table><thead><tr><th>卡密</th><th>状态</th><th>手机号</th><th>验证码</th><th>创建时间</th></tr></thead><tbody>';
  for (const c of res.rows || []) {
    html += `<tr>
      <td style="font-family:monospace;font-size:12px;">${c.code}</td>
      <td><span class="status-badge ${badges[c.status] || ''}">${c.status}</span></td>
      <td>${c.phone_number || '-'}</td>
      <td>${c.sms_code || '-'}</td>
      <td>${(c.created_at || '').replace('T', ' ').substring(0, 16)}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  $('ordersTable').innerHTML = html;
}
</script>
</body>
</html>
```

- [ ] **Step 2: 验证文件存在**

```bash
ls -la ~/Projects/first-money/public/admin.html
```

---

### Task 8: 集成测试

- [ ] **Step 1: 启动完整服务**

```bash
cd ~/Projects/first-money && node server.js &
sleep 2
```

- [ ] **Step 2: 测试管理员 API**

```bash
# 登录
curl -s -X POST http://localhost:3000/api/admin/login -H 'Content-Type: application/json' -d '{"password":"admin123"}'
# Expected: {"success":true,"token":"admin123"}

# 查配置
curl -s http://localhost:3000/api/admin/config -H 'x-admin-password: admin123'
# Expected: {"id":1,"hero_api_key":"","service_code":"","country_id":0,"max_price":0,...}

# 生成卡密
curl -s -X POST http://localhost:3000/api/admin/cards -H 'Content-Type: application/json' -H 'x-admin-password: admin123' -d '{"count":3}'
# Expected: {"codes":["FM-XXXX-XXXX-XXXX",...]}
```

- [ ] **Step 3: 测试未配置时的用户 API**

```bash
# 尝试兑换（没有配置 API Key 会报错）
curl -s -X POST http://localhost:3000/api/redeem -H 'Content-Type: application/json' -d '{"code":"FM-TEST-TEST-TEST"}'
# Expected: {"success":false,"error":"卡密不存在"}
```

- [ ] **Step 4: 清理**

```bash
kill %1 2>/dev/null
```

- [ ] **Step 5: 验证—完整流程**

1. 访问 `http://localhost:3000/admin` → 登录 → 配置 HeroSMS API Key、服务代码、国家 ID、价格
2. 生成 3 个卡密，复制
3. 访问 `http://localhost:3000/` → 输入卡密 → 兑换
4. 观察是否返回手机号
5. 点击"我已发送验证码"，观察是否轮询拿到验证码

---

### Task 9: 清理与收尾

- [ ] **Step 1: 停掉后台进程**

```bash
pkill -f "node server.js" 2>/dev/null || true
```

- [ ] **Step 2: 确认项目结构**

```bash
cd ~/Projects/first-money && find . -not -path './node_modules/*' -not -path './data/*' -not -name '.DS_Store' | sort
```

Expected:
```
.
.env.example
.gitignore
card-service.js
db.js
docs
docs/superpowers
docs/superpowers/plans
docs/superpowers/plans/2026-06-07-first-money-plan.md
docs/superpowers/specs
docs/superpowers/specs/2026-06-07-first-money-design.md
hero-api.js
package.json
public
public/admin.html
public/index.html
server.js
```

- [ ] **Step 3: 提交代码**

```bash
cd ~/Projects/first-money && git init && git add -A && git commit -m "feat: First Money 初始实现

- Express + SQLite 后端
- 用户兑换页面：卡密输入 → 手机号 → 验证码
- 管理后台：配置、生成卡密、订单查看
- HeroSMS API 封装 + 退款换号逻辑
- 2 分钟退款冷静期对齐保护

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
