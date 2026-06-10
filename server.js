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
  getCardByOrderNo,
  getUnusedUnboundCard,
  bindCardToOrder,
  updateCard,
  addPendingRefund,
} = require('./db');
const {
  redeemCard,
  pollForCode,
  handleTimeout,
  requestReplaceNumber,
  processPendingRefunds,
  autoRefundIdleCards,
  COOLDOWN_MS,
} = require('./card-service');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DEMO_MODE = process.env.DEMO_MODE === 'true';

// 国家信息映射
const COUNTRIES = {
  33: { flag: '🇨🇴', name: '哥伦比亚', code: '+57' },
  2:  { flag: '🇰🇿', name: '哈萨克斯坦', code: '+7' },
  12: { flag: '🇮🇩', name: '印度尼西亚', code: '+62' },
  6:  { flag: '🇵🇭', name: '菲律宾', code: '+63' },
  3:  { flag: '🇻🇳', name: '越南', code: '+84' },
  16: { flag: '🇲🇾', name: '马来西亚', code: '+60' },
  22: { flag: '🇹🇭', name: '泰国', code: '+66' },
  11: { flag: '🇧🇷', name: '巴西', code: '+55' },
  14: { flag: '🇰🇪', name: '肯尼亚', code: '+254' },
  9:  { flag: '🇪🇬', name: '埃及', code: '+20' },
};

function getCountryInfo(countryId) {
  return COUNTRIES[countryId] || { flag: '🌍', name: '未知国家', code: '' };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- 演示模式 ----
if (DEMO_MODE) {
  console.log('🎭 演示模式已开启 - 不会真实购买手机号');

  // 模拟数据存储
  const demoStore = new Map();

  app.post('/api/redeem', (req, res) => {
    let { code, orderNo } = req.body;

    // 支持订单号查询
    let card;
    if (orderNo) {
      card = getCardByOrderNo(orderNo.toString().trim());
      if (!card) return res.json({ success: false, error: '订单号不存在，请确认后重试' });
      code = card.code; // 转为卡密处理
    }

    if (!code) return res.status(400).json({ error: '请输入兑换码或订单号' });
    if (!card) card = getCardByCode(code.trim().toUpperCase());
    if (!card) return res.json({ success: false, error: '卡密不存在' });

    // 已完成 → 返回验证码
    if (card.status === 'completed' && card.sms_code) {
      const countryInfo = getCountryInfo(card.country_id || 33);
      return res.json({ success: true, resumed: true, smsCode: card.sms_code, phoneNumber: card.phone_number, country: countryInfo });
    }

    // 活跃中 → 恢复
    if (card.status === 'active' && card.phone_number) {
      const elapsed = card.purchased_at ? Date.now() - new Date(card.purchased_at).getTime() : 0;
      if (elapsed < 600000) {
        const countryInfo = getCountryInfo(card.country_id || 33);
        return res.json({ success: true, resumed: true, phoneNumber: card.phone_number, verifyStarted: !!card.verify_started_at, country: countryInfo });
      }
      // 过期了，重置
      const db = require('./db');
      db.updateCard(card.id, { status: 'unused', activation_id: null, phone_number: null, sms_code: null, purchased_at: null, used_at: null, verify_started_at: null });
      card.status = 'unused';
    }

    if (card.status !== 'unused') return res.json({ success: false, error: '卡密已被使用' });

    // 从配置中选一个国家（演示模式优先用第一个）
    const config = getConfig();
    let countryId = config.country_id || 33;
    let countryPrefix = '+57';
    if (config.countries_config && Array.isArray(config.countries_config) && config.countries_config.length > 0) {
      countryId = config.countries_config[0].country_id;
    }
    const countryInfo = getCountryInfo(countryId);
    countryPrefix = countryInfo.code;

    const phoneNumber = countryPrefix + ' 3' + Math.floor(Math.random() * 1000000000).toString().padStart(9, '0');
    demoStore.set(code.trim().toUpperCase(), {
      phoneNumber,
      purchasedAt: Date.now(),
      smsCode: Math.floor(100000 + Math.random() * 900000).toString(),
    });

    // 更新数据库（不调 HeroSMS）
    const db = require('./db');
    const c = db.getCardByCode(code.trim().toUpperCase());
    db.updateCard(c.id, {
      status: 'active',
      activation_id: 'demo_' + Date.now(),
      phone_number: phoneNumber,
      country_id: countryId,
      price: (config.countries_config && config.countries_config.length > 0) ? config.countries_config[0].max_price : (config.max_price || 0.05),
      purchased_at: new Date().toISOString(),
      used_at: new Date().toISOString(),
    });

    res.json({ success: true, phoneNumber, activationId: 'demo_id', country: countryInfo });
  });

  app.get('/api/status/:code', (req, res) => {
    const data = demoStore.get(req.params.code);
    if (!data) return res.json({ success: false, waiting: false, status: '无记录' });

    const elapsed = Date.now() - data.purchasedAt;
    // 演示模式：5秒后自动发验证码
    if (elapsed > 5000) {
      const card = getCardByCode(req.params.code);
      const countryInfo = getCountryInfo(card ? card.country_id : 33);
      return res.json({ success: true, smsCode: data.smsCode, phoneNumber: data.phoneNumber, country: countryInfo });
    }
    res.json({ success: false, waiting: true, status: 'STATUS_WAIT_CODE' });
  });

  app.get('/api/cooldown/:code', (req, res) => {
    res.json({ cooldownRemaining: 0 });
  });

  app.post('/api/replace', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: '缺少卡密' });
    const card = getCardByCode(code.trim().toUpperCase());
    if (!card || !card.activation_id) return res.json({ success: false, error: '无激活记录' });

    // 换号次数限制
    const replaceCount = card.replace_count || 0;
    if (replaceCount >= 3) {
      return res.json({ success: false, error: '该卡密已更换多次，请联系客服处理' });
    }

    const config = getConfig();
    let countryId = config.country_id || 33;
    let prefix = '+57';
    if (config.countries_config && Array.isArray(config.countries_config) && config.countries_config.length > 0) {
      countryId = config.countries_config[0].country_id;
    }
    const ci = getCountryInfo(countryId);
    prefix = ci.code;

    const newPhone = prefix + ' 3' + Math.floor(Math.random() * 1000000000).toString().padStart(9, '0');
    demoStore.set(code.trim().toUpperCase(), {
      phoneNumber: newPhone,
      purchasedAt: Date.now(),
      smsCode: Math.floor(100000 + Math.random() * 900000).toString(),
    });

    const db = require('./db');
    db.updateCard(card.id, {
      activation_id: 'demo_' + Date.now(),
      phone_number: newPhone,
      country_id: countryId,
      price: (config.countries_config && config.countries_config.length > 0) ? config.countries_config[0].max_price : (config.max_price || 0.05),
      replace_count: replaceCount + 1,
      sms_code: null,
      purchased_at: new Date().toISOString(),
    });

    res.json({ success: true, replaced: true, phoneNumber: newPhone, activationId: 'demo_id', country: ci });
  });

  app.post('/api/timeout', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: '缺少卡密' });
    const card = getCardByCode(code.trim().toUpperCase());
    if (!card || !card.activation_id) return res.json({ success: false, error: '无激活记录' });

    const replaceCount = card.replace_count || 0;
    if (replaceCount >= 3) {
      return res.json({ success: false, error: '该卡密已更换多次，请联系客服处理' });
    }

    const config = getConfig();
    let countryId = config.country_id || 33;
    let prefix = '+57';
    if (config.countries_config && Array.isArray(config.countries_config) && config.countries_config.length > 0) {
      countryId = config.countries_config[0].country_id;
    }
    const ci = getCountryInfo(countryId);
    prefix = ci.code;

    const newPhone = prefix + ' 3' + Math.floor(Math.random() * 1000000000).toString().padStart(9, '0');
    demoStore.set(code.trim().toUpperCase(), {
      phoneNumber: newPhone,
      purchasedAt: Date.now(),
      smsCode: Math.floor(100000 + Math.random() * 900000).toString(),
    });

    const db = require('./db');
    db.updateCard(card.id, {
      activation_id: 'demo_' + Date.now(),
      phone_number: newPhone,
      country_id: countryId,
      price: (config.countries_config && config.countries_config.length > 0) ? config.countries_config[0].max_price : (config.max_price || 0.05),
      replace_count: replaceCount + 1,
      sms_code: null,
      purchased_at: new Date().toISOString(),
    });

    res.json({ success: true, replaced: true, phoneNumber: newPhone, activationId: 'demo_id', country: ci });
  });
}

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
    let { code, orderNo } = req.body;
    if (orderNo) {
      const cardByOrder = getCardByOrderNo(orderNo.toString().trim());
      if (!cardByOrder) return res.json({ success: false, error: '订单号不存在，请确认后重试' });
      code = cardByOrder.code;
    }
    if (!code) return res.status(400).json({ error: '请输入兑换码或订单号' });
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

// 标记用户已点击"我已发送验证码"
app.post('/api/verify-started', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '缺少卡密' });
  const card = getCardByCode(code.trim().toUpperCase());
  if (!card) return res.json({ success: false, error: '卡密不存在' });
  const { setVerifyStarted } = require('./db');
  setVerifyStarted(card.id);
  res.json({ success: true });
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
  const { hero_api_key, service_code, country_id, max_price, countries_config } = req.body;
  if (!hero_api_key || !service_code) {
    return res.status(400).json({ error: 'API Key 和服务代码为必填' });
  }
  const config = updateConfig({
    hero_api_key,
    service_code,
    country_id: parseInt(country_id) || 0,
    max_price: parseFloat(max_price) || 0,
    countries_config: countries_config || undefined,
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

// 数据统计
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const db = require('./db');
  const d = db.getDb();

  // 国家+价位维度成交量
  const byCountry = d.prepare(`
    SELECT country_id, price,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as got_code,
      SUM(CASE WHEN status = 'active' AND verify_started_at IS NOT NULL THEN 1 ELSE 0 END) as waiting,
      SUM(CASE WHEN status = 'active' AND verify_started_at IS NULL THEN 1 ELSE 0 END) as idle
    FROM cards WHERE status IN ('active','completed') AND country_id IS NOT NULL
    GROUP BY country_id, price ORDER BY total DESC
  `).all();

  // 价位失败统计（最近7天）
  const failures = d.prepare(`
    SELECT country_id, price, failure_type, COUNT(*) as count
    FROM country_failures
    WHERE created_at >= datetime('now', '-7 days')
    GROUP BY country_id, price, failure_type
    ORDER BY count DESC
  `).all();

  // 换号次数分布
  const replaceDist = d.prepare(`
    SELECT replace_count, COUNT(*) as count
    FROM cards WHERE replace_count > 0
    GROUP BY replace_count ORDER BY replace_count
  `).all();

  // 总览
  const overview = d.prepare(`
    SELECT
      COUNT(*) as total_used,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as total_success,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as total_active,
      SUM(COALESCE(price, 0)) as total_spent,
      COUNT(DISTINCT country_id) as countries_used
    FROM cards WHERE status IN ('active','completed')
  `).get();

  // 退款统计
  const refunds = d.prepare(`
    SELECT status, COUNT(*) as count FROM pending_refunds GROUP BY status
  `).all();

  // 国家名称映射
  const countryMap = {
    33:'哥伦比亚',2:'哈萨克斯坦',12:'印度尼西亚',6:'菲律宾',
    3:'越南',16:'马来西亚',22:'泰国',11:'巴西',14:'肯尼亚',
    9:'埃及',43:'英国',21:'印度',42:'墨西哥',34:'阿根廷',19:'尼日利亚'
  };

  res.json({
    overview,
    byCountry: byCountry.map(r => ({
      ...r,
      country_name: countryMap[r.country_id] || ('国家'+r.country_id),
      success_rate: r.total > 0 ? Math.round(r.got_code / r.total * 100) : 0
    })),
    failures: failures.map(r => ({
      ...r,
      country_name: countryMap[r.country_id] || ('国家'+r.country_id),
      type_name: { no_numbers:'售罄', unavailable:'不可用', no_code:'未收到码' }[r.failure_type] || r.failure_type
    })),
    replaceDist,
    refunds,
  });
});

// 余额查询
app.get('/api/admin/balance', requireAdmin, async (req, res) => {
  const config = getConfig();
  try {
    const { getBalance } = require('./hero-api');
    const balance = await getBalance(config.hero_api_key);

    // 计算最低价位和可买次数
    let minPrice = 0.05;
    if (config.countries_config && config.countries_config.length > 0) {
      minPrice = Math.min(...config.countries_config.map(c => c.max_price));
    } else if (config.max_price > 0) {
      minPrice = config.max_price;
    }
    const estimatedBuys = Math.floor(balance / minPrice);

    res.json({ balance, minPrice, estimatedBuys });
  } catch (e) {
    res.json({ balance: null, error: '查询失败' });
  }
});

// 绑定订单号到卡密（必须在 :id/reset 之前注册，否则 bind 会被 :id 截胡）
app.post('/api/admin/cards/bind', requireAdmin, (req, res) => {
  const { orderNo } = req.body;
  if (!orderNo) return res.status(400).json({ error: '请输入订单号' });

  // 检查订单号是否已绑定
  const existing = getCardByOrderNo(orderNo.toString().trim());
  if (existing) return res.json({ success: false, error: '该订单号已绑定卡密 ' + existing.code });

  // 取一张未使用的卡密
  const card = getUnusedUnboundCard();
  if (!card) return res.json({ success: false, error: '没有可用卡密，请先生成' });

  bindCardToOrder(card.id, orderNo.toString().trim());

  res.json({
    success: true,
    orderNo: orderNo.toString().trim(),
    code: card.code,
    guide: '使用说明：\n\n1. 打开 openai.com 注册账号\n2. 选择对应国家，输入手机号\n3. 回到 ' + (process.env.SITE_URL || 'https://first-money.onrender.com') + ' 输入订单号查看验证码\n\n如遇问题请联系客服。',
  });
});

// 手动重置卡密（管理员操作）
app.post('/api/admin/cards/:id/reset', requireAdmin, async (req, res) => {
  const db = require('./db');
  const card = db.getDb().prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.json({ success: false, error: '卡密不存在' });

  try {
    // 如果有真实激活ID，尝试退款
    if (card.activation_id && !card.activation_id.startsWith('demo_')) {
      const config = getConfig();
      if (config.hero_api_key) {
        const { cancelActivation } = require('./hero-api');
        const result = await cancelActivation(config.hero_api_key, card.activation_id);
        if (result !== 'ACCESS_CANCEL') {
          // 退款失败（可能在冷静期），加入待退款队列
          addPendingRefund(card.activation_id, card.purchased_at || new Date().toISOString());
          console.log(`[管理员重置] 激活ID ${card.activation_id} 退款失败(${result})，加入待退款队列`);
        } else {
          console.log(`[管理员重置] 激活ID ${card.activation_id} 退款成功`);
        }
      }
    }

    // 重置卡密为未使用
    updateCard(card.id, {
      status: 'unused',
      activation_id: null,
      phone_number: null,
      sms_code: null,
      purchased_at: null,
      used_at: null,
      verify_started_at: null,
      replace_count: 0,
    });

    res.json({ success: true, message: '卡密已重置' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`First Money 运行在 http://localhost:${PORT}`);
});

// 后台定时处理延迟退款（每 15 秒检查一次）
setInterval(async () => {
  try {
    await processPendingRefunds();
  } catch (e) {
    // 静默处理，避免崩溃
  }
}, 15000);

// 后台定时处理空闲卡退款（每 60 秒检查一次）
setInterval(async () => {
  try {
    await autoRefundIdleCards();
  } catch (e) {
    // 静默处理，避免崩溃
  }
}, 60000);

// 后台清理旧数据（每 1 小时）
setInterval(() => {
  try {
    const db = require('./db');
    db.getDb().prepare("DELETE FROM country_failures WHERE created_at < datetime('now', '-24 hours')").run();
  } catch (e) { /* 静默 */ }
}, 3600000);
// deploy trigger 2026年 6月10日 星期三 12时04分41秒 CST
