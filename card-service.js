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
    const smsCode = result.split(':').slice(1).join(':') || '';
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
    const smsCode = lastStatus.split(':').slice(1).join(':') || '';
    updateCard(card.id, { status: 'completed', sms_code: smsCode });
    return { success: true, smsCode, phoneNumber: card.phone_number };
  }

  // 退款
  const cancelResult = await cancelActivation(config.hero_api_key, card.activation_id);

  if (cancelResult === 'OTP_RECEIVED' || cancelResult.includes('OTP_RECEIVED')) {
    // 退款被拒，码刚好到
    const statusResult = await getStatus(config.hero_api_key, card.activation_id);
    if (statusResult.startsWith('STATUS_OK:')) {
      const smsCode = statusResult.split(':').slice(1).join(':') || '';
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
