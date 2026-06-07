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
