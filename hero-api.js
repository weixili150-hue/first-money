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
