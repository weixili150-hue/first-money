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

// 查价格（返回价位数组，如 [{count:1, price:0.015}, {count:2, price:0.02}]）
async function getPrices(apiKey, { service, country }) {
  const result = await call(apiKey, {
    action: 'getPrices',
    service,
    country,
  });
  return result;
}

// 解析 getPrices 返回值，提取价位列表
// API 返回格式(新): {"33":{"dr":{"cost":0.05,"count":15590,"physicalCount":7035}}}
// 或旧格式: {"33":{"dr":{"1":0.015, "2":0.02}}}
// 或文本格式: price1:count1;price2:count2
function parsePrices(raw, maxPrice) {
  const prices = [];
  if (!raw || raw === 'NO_NUMBERS') return prices;

  try {
    const json = JSON.parse(raw);
    for (const countryData of Object.values(json)) {
      for (const serviceData of Object.values(countryData)) {
        // 新格式：{"cost":0.05,"count":15590,...} — cost 字段就是价格
        if (typeof serviceData.cost === 'number' && serviceData.cost > 0 && serviceData.cost <= maxPrice + 0.001) {
          prices.push({
            price: serviceData.cost,
            count: typeof serviceData.count === 'number' ? serviceData.count : 1,
          });
          continue; // 新格式匹配成功，跳过旧格式遍历
        }
        // 旧格式：{"1":0.015, "2":0.02} — key=数量, value=价格
        for (const [qty, price] of Object.entries(serviceData)) {
          const p = parseFloat(price);
          if (p > 0 && p <= maxPrice + 0.001) {
            prices.push({ price: p, count: parseInt(qty) || 1 });
          }
        }
      }
    }
    if (prices.length > 0) return prices;
  } catch (e) { /* Not JSON, try text format */ }

  // 文本格式：price1:count1;price2:count2
  const parts = raw.split(/[;,]/);
  for (const part of parts) {
    const segs = part.split(':');
    const price = parseFloat(segs[0]);
    const count = segs[1] ? parseInt(segs[1]) : 1;
    if (price > 0 && price <= maxPrice + 0.001) {
      prices.push({ price, count });
    }
  }
  return prices;
}

module.exports = {
  getBalance,
  getNumber,
  getStatus,
  cancelActivation,
  getPrices,
  parsePrices,
};
