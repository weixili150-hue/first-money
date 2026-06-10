const { getConfig, getCardByCode, updateCard, addPendingRefund, getPendingRefunds, markRefundDone, getIdleCards, recordCountryFailure, getRecentFailures, clearCountryFailures } = require('./db');
const { getBalance, getNumber, getStatus, cancelActivation, getPrices, parsePrices } = require('./hero-api');

// 轮询间隔（毫秒）
const POLL_INTERVAL = 5000;
// 退款冷静期（毫秒）
const COOLDOWN_MS = 120 * 1000; // 2 分钟

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
  43: { flag: '🇬🇧', name: '英国', code: '+44' },
  21: { flag: '🇮🇳', name: '印度', code: '+91' },
  42: { flag: '🇲🇽', name: '墨西哥', code: '+52' },
  34: { flag: '🇦🇷', name: '阿根廷', code: '+54' },
  19: { flag: '🇳🇬', name: '尼日利亚', code: '+234' },
};

function getCountryInfo(countryId) {
  return COUNTRIES[countryId] || { flag: '🌍', name: '国家' + countryId, code: '' };
}

// 根据手机号前缀推断真实国家
function detectCountryByPhone(phone) {
  if (!phone) return null;
  const clean = phone.replace(/[\s\-()]+/g, '');
  const prefixMap = { '44': 43, '91': 21, '62': 12, '63': 6, '84': 3, '60': 16, '66': 22, '55': 11, '254': 14, '20': 9, '57': 33, '7': 2, '52': 42, '54': 34, '234': 19 };
  const keys = Object.keys(prefixMap).sort((a, b) => b.length - a.length);
  for (const prefix of keys) {
    if (clean.startsWith(prefix)) return getCountryInfo(prefixMap[prefix]);
  }
  return null;
}

// 格式化手机号：447549881566 → +44 7549 881566
function formatPhoneNumber(phone) {
  if (!phone) return phone;
  const clean = phone.replace(/[\s\-()]+/g, '');
  const prefixMap = { '254': 3, '234': 3, '44': 2, '91': 2, '62': 2, '63': 2, '84': 2, '60': 2, '66': 2, '55': 2, '20': 2, '57': 2, '7': 1, '52': 2, '54': 2 };
  const keys = Object.keys(prefixMap).sort((a, b) => b.length - a.length);
  for (const prefix of keys) {
    if (clean.startsWith(prefix)) {
      const rest = clean.slice(prefix.length);
      return '+' + prefix + '  ' + rest;
    }
  }
  return '+' + clean;
}

// 冷却阈值：10分钟内同一价位失败2次以上 → 跳过该价位
const COOLDOWN_FAILURE_LIMIT = 2;
const COOLDOWN_WINDOW_MIN = 10;

function isPriceInCooldown(countryId, price) {
  const failures = getRecentFailures(countryId, price, COOLDOWN_WINDOW_MIN);
  return failures >= COOLDOWN_FAILURE_LIMIT;
}

// 价格缓存（避免每次购买都查所有国家价格）
const priceCache = {
  data: null,        // [{country_id, price, country_name}, ...]
  timestamp: 0,
  TTL: 10 * 60 * 1000, // 10分钟缓存
};

function invalidatePriceCache() {
  priceCache.data = null;
  priceCache.timestamp = 0;
}

// 收集所有国家所有价位，全球排序，逐个尝试
async function tryBuyNumber(config) {
  // 收集配置的国家
  let countryEntries = [];
  if (config.countries_config && Array.isArray(config.countries_config) && config.countries_config.length > 0) {
    countryEntries = config.countries_config;
  } else if (config.country_id > 0) {
    countryEntries = [{ country_id: config.country_id, max_price: config.max_price }];
  }

  if (countryEntries.length === 0) return { error: '未配置任何国家' };

  // 使用缓存或重新查询价位
  let allTiers;
  const now = Date.now();
  if (priceCache.data && (now - priceCache.timestamp) < priceCache.TTL) {
    allTiers = priceCache.data;
    console.log('[价位缓存] 使用缓存，' + allTiers.length + ' 个价位');
  } else {
    allTiers = [];
    for (const entry of countryEntries) {
      const cname = getCountryInfo(entry.country_id).name;
      console.log(`[价位查询] ${cname}(${entry.country_id}) 最高 $${entry.max_price}...`);
      try {
        const raw = await getPrices(config.hero_api_key, {
          service: config.service_code,
          country: entry.country_id,
        });
        const prices = parsePrices(raw, entry.max_price);
        console.log(`[价位查询] ${cname} 可用价位: ${prices.map(p => '$' + p.price).join(', ') || '无'}`);
        for (const p of prices) {
          allTiers.push({
            country_id: entry.country_id,
            price: p.price,
            country_name: cname,
          });
        }
      } catch (e) {
        console.log(`[价位查询] ${cname} 查询失败，使用配置最高价 $${entry.max_price}`);
        allTiers.push({
          country_id: entry.country_id,
          price: entry.max_price,
          country_name: cname,
        });
      }
    }

    if (allTiers.length === 0) {
      // 如果有缓存但已过期且查询全失败，用旧缓存兜底
      if (priceCache.data && priceCache.data.length > 0) {
        console.log('[价位缓存] 查询失败，使用过期缓存兜底');
        allTiers = priceCache.data;
      } else {
        return { error: 'NO_NUMBERS' };
      }
    } else {
      // 更新缓存
      priceCache.data = allTiers;
      priceCache.timestamp = now;
    }
  }

  // 按价格全球排序，同价格随机（避免总让一个国家扛）
  allTiers.sort((a, b) => a.price - b.price || Math.random() - 0.5);

  // 逐个尝试
  for (const tier of allTiers) {
    if (isPriceInCooldown(tier.country_id, tier.price)) {
      console.log(`[购买] ${tier.country_name} $${tier.price} 在冷却中，跳过`);
      continue;
    }

    console.log(`[购买] 尝试 ${tier.country_name}(${tier.country_id}) $${tier.price}`);
    const result = await getNumber(config.hero_api_key, {
      service: config.service_code,
      country: tier.country_id,
      maxPrice: tier.price,
    });

    if (!result.error) {
      console.log(`[购买] ✅ 成功 ${tier.country_name} $${tier.price}`);
      clearCountryFailures(tier.country_id, tier.price);
      return { ...result, countryId: tier.country_id, price: tier.price };
    }

    console.log(`[购买] ❌ ${tier.country_name} $${tier.price} 失败: ${result.error}`);
    if (result.error === 'NO_NUMBERS') {
      recordCountryFailure(tier.country_id, tier.price, 'no_numbers');
      invalidatePriceCache(); // 缓存可能不准确了，下次重查
    } else if (result.error === 'NO_BALANCE') {
      return { error: 'NO_BALANCE' };
    }
  }

  return { error: 'NO_NUMBERS' };
}

function getMinMaxPrice(config) {
  let min = config.max_price || 1;
  if (config.countries_config && Array.isArray(config.countries_config) && config.countries_config.length > 0) {
    for (const c of config.countries_config) {
      if (c.max_price < min) min = c.max_price;
    }
  }
  return min;
}

function getConfigOrThrow() {
  const config = getConfig();
  if (!config.hero_api_key) throw new Error('请先配置 HeroSMS API Key');
  if (!config.service_code) throw new Error('请先配置服务代码');
  const hasCountries = (config.countries_config && Array.isArray(config.countries_config) && config.countries_config.length > 0) || config.country_id > 0;
  if (!hasCountries) throw new Error('请先配置至少一个国家');
  return config;
}

// 兑换卡密 → 购买手机号（或恢复已有状态）
async function redeemCard(code) {
  const card = getCardByCode(code);
  if (!card) return { success: false, error: '卡密不存在' };

  // 已完成 → 直接返回验证码（10分钟内有效）
  if (card.status === 'completed' && card.sms_code) {
    const elapsed = card.purchased_at ? Date.now() - new Date(card.purchased_at).getTime() : 0;
    if (elapsed < 600000) { // 10分钟内
      const country = detectCountryByPhone(card.phone_number) || getCountryInfo(card.country_id || 0);
      return {
        success: true,
        code,
        resumed: true,
        smsCode: card.sms_code,
        phoneNumber: formatPhoneNumber(card.phone_number),
        country,
      };
    }
    // 超过10分钟，也返回码（但标记过期）
    const country = detectCountryByPhone(card.phone_number) || getCountryInfo(card.country_id || 0);
    return { success: true, code, resumed: true, smsCode: card.sms_code, phoneNumber: formatPhoneNumber(card.phone_number), country, expired: true };
  }

  // 活跃中 → 恢复进度
  let needsNewPurchase = false;
  if (card.status === 'active' && card.phone_number) {
    const elapsed = card.purchased_at ? Date.now() - new Date(card.purchased_at).getTime() : 0;
    if (elapsed < 600000) { // 10分钟内可恢复
      const country = detectCountryByPhone(card.phone_number) || getCountryInfo(card.country_id || 0);
      return {
        success: true,
        code,
        resumed: true,
        phoneNumber: formatPhoneNumber(card.phone_number),
        activationId: card.activation_id,
        verifyStarted: !!card.verify_started_at,
        country,
      };
    }
    // 超过10分钟，卡密过期，退款旧号，然后重新购买
    if (card.activation_id) {
      addPendingRefund(card.activation_id, card.purchased_at);
      console.log(`[过期退款] 卡密 ${card.code} 超过10分钟，旧号 ${card.activation_id} 加入待退款`);
    }
    updateCard(card.id, { status: 'unused', activation_id: null, phone_number: null, sms_code: null, purchased_at: null, used_at: null, verify_started_at: null });
    needsNewPurchase = true;
  }

  // 卡密未使用 → 新购买
  if (card.status !== 'unused' && !needsNewPurchase) return { success: false, error: '卡密已被使用' };

  const config = getConfigOrThrow();

  // 查余额（取所有国家中最低的最高价作为最低门槛）
  const minMaxPrice = getMinMaxPrice(config);
  const balance = await getBalance(config.hero_api_key);
  if (balance === null) return { success: false, error: '查询余额失败，请检查 API Key' };
  if (balance < minMaxPrice) return { success: false, error: '系统余额不足，请联系管理员' };

  // 多国依次尝试买号
  const result = await tryBuyNumber(config);

  if (result.error) {
    if (result.error === 'NO_NUMBERS') return { success: false, error: '当前所有国家号码售罄，请稍后再试' };
    if (result.error === 'NO_BALANCE') return { success: false, error: '系统余额不足，请联系管理员' };
    return { success: false, error: `购买号码失败: ${result.error}` };
  }

  // 更新卡密
  updateCard(card.id, {
    status: 'active',
    activation_id: result.activationId,
    phone_number: result.phoneNumber,
    country_id: result.countryId,
    price: result.price,
    purchased_at: new Date().toISOString(),
    used_at: new Date().toISOString(),
  });

  const country = detectCountryByPhone(result.phoneNumber) || getCountryInfo(result.countryId);

  return {
    success: true,
    code,
    phoneNumber: formatPhoneNumber(result.phoneNumber),
    activationId: result.activationId,
    country,
  };
}

// 轮询获取验证码
async function pollForCode(code) {
  const card = getCardByCode(code);
  if (!card || !card.activation_id) return { success: false, error: '无激活记录' };
  if (card.status === 'completed' && card.sms_code) {
    const country = getCountryInfo(card.country_id || 0);
    return { success: true, smsCode: card.sms_code, phoneNumber: formatPhoneNumber(card.phone_number), country };
  }

  const config = getConfigOrThrow();
  const result = await getStatus(config.hero_api_key, card.activation_id);

  if (result.startsWith('STATUS_OK:')) {
    const smsCode = result.split(':').slice(1).join(':') || '';
    updateCard(card.id, { status: 'completed', sms_code: smsCode });
    const country = detectCountryByPhone(card.phone_number) || getCountryInfo(card.country_id || 0);
    return { success: true, smsCode, phoneNumber: formatPhoneNumber(card.phone_number), country };
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

// 记录当前号码的国家+价位失败
function recordFailureForCard(card, failureType) {
  if (card.country_id && card.price) {
    recordCountryFailure(card.country_id, card.price, failureType);
    const country = getCountryInfo(card.country_id);
    console.log(`[失败记录] ${country.name}(${card.country_id}) $${card.price} ${failureType}`);
  }
}

// 超时退款换号（先买新号，再退旧号，防止退成功但买失败的情况）
async function handleTimeout(code) {
  const card = getCardByCode(code);
  if (!card || !card.activation_id) return { success: false, error: '无激活记录' };
  if (card.status === 'completed' && card.sms_code) {
    return { success: true, smsCode: card.sms_code, phoneNumber: card.phone_number };
  }

  // 限制每张卡密最多换 3 次号
  if ((card.replace_count || 0) >= 3) {
    return { success: false, error: '该卡密已更换多次，请联系客服处理' };
  }

  const config = getConfigOrThrow();

  // 最后查一次码
  const lastStatus = await getStatus(config.hero_api_key, card.activation_id);
  if (lastStatus.startsWith('STATUS_OK:')) {
    const smsCode = lastStatus.split(':').slice(1).join(':') || '';
    updateCard(card.id, { status: 'completed', sms_code: smsCode });
    return { success: true, smsCode, phoneNumber: card.phone_number };
  }

  // 记录旧国家无码失败
  recordFailureForCard(card, 'no_code');

  // 先买新号（多国尝试）
  const newResult = await tryBuyNumber(config);

  if (newResult.error) {
    return { success: false, error: `新号码购买失败: ${newResult.error}，原号码仍可使用` };
  }

  // 新号到手了，现在退旧号
  const cancelResult = await cancelActivation(config.hero_api_key, card.activation_id);

  if (cancelResult === 'OTP_RECEIVED' || cancelResult.includes('OTP_RECEIVED')) {
    const statusResult = await getStatus(config.hero_api_key, card.activation_id);
    if (statusResult.startsWith('STATUS_OK:')) {
      const smsCode = statusResult.split(':').slice(1).join(':') || '';
      addPendingRefund(newResult.activationId, new Date().toISOString());
      updateCard(card.id, { status: 'completed', sms_code: smsCode });
      console.log(`[延迟退款] 新号 ${newResult.activationId} 未使用，加入待退款队列`);
      return { success: true, smsCode, phoneNumber: card.phone_number };
    }
    addPendingRefund(card.activation_id, card.purchased_at);
  } else if (cancelResult === 'ACCESS_CANCEL') {
    console.log(`[退款] 旧号 ${card.activation_id} 退款成功`);
  } else {
    addPendingRefund(card.activation_id, card.purchased_at);
    console.log(`[延迟退款] 旧号 ${card.activation_id} 退款失败(${cancelResult})，加入待退款队列`);
  }

  // 更新为新的激活信息
  updateCard(card.id, {
    activation_id: newResult.activationId,
    phone_number: newResult.phoneNumber,
    country_id: newResult.countryId,
    price: newResult.price,
    replace_count: (card.replace_count || 0) + 1,
    sms_code: null,
    purchased_at: new Date().toISOString(),
  });

  const country = detectCountryByPhone(newResult.phoneNumber) || getCountryInfo(newResult.countryId);

  return {
    success: true,
    replaced: true,
    phoneNumber: formatPhoneNumber(newResult.phoneNumber),
    activationId: newResult.activationId,
    country,
  };
}

// 用户主动换号
async function requestReplaceNumber(code) {
  const card = getCardByCode(code);
  if (!card || !card.activation_id) return { success: false, error: '无激活记录' };

  // 防御竞态：验证码刚好在换号前到达
  if (card.status === 'completed' && card.sms_code) {
    return { success: true, smsCode: card.sms_code, phoneNumber: card.phone_number };
  }

  // 限制每张卡密最多换 3 次号
  const replaceCount = card.replace_count || 0;
  if (replaceCount >= 3) {
    return { success: false, error: '该卡密已更换多次，请联系客服处理' };
  }

  const elapsed = card.purchased_at ? Date.now() - new Date(card.purchased_at).getTime() : 0;

  // 已过冷静期 → 直接退款换号
  if (elapsed >= COOLDOWN_MS) {
    return handleTimeout(code);
  }

  // 冷静期内 → 先买新号，旧号定时退款
  const config = getConfigOrThrow();
  const oldActivationId = card.activation_id;
  const oldPurchasedAt = card.purchased_at;

  // 记录旧国家不可用失败
  recordFailureForCard(card, 'unavailable');

  // 多国尝试买新号
  const result = await tryBuyNumber(config);

  if (result.error) {
    return { success: false, error: `购买新号码失败: ${result.error}` };
  }

  // 记录旧号待退款
  addPendingRefund(oldActivationId, oldPurchasedAt);
  console.log(`[延迟退款] 激活ID ${oldActivationId} 已加入待退款队列，将在2分钟后自动退款`);

  // 更新卡密为新号
  updateCard(card.id, {
    activation_id: result.activationId,
    phone_number: result.phoneNumber,
    country_id: result.countryId,
    price: result.price,
    replace_count: (card.replace_count || 0) + 1,
    sms_code: null,
    purchased_at: new Date().toISOString(),
  });

  const country = detectCountryByPhone(result.phoneNumber) || getCountryInfo(result.countryId);

  return {
    success: true,
    replaced: true,
    phoneNumber: formatPhoneNumber(result.phoneNumber),
    activationId: result.activationId,
    country,
  };
}

// 定时处理待退款队列
async function processPendingRefunds() {
  const config = getConfig();
  if (!config.hero_api_key) return; // 还没配置，跳过

  const pending = getPendingRefunds();
  for (const p of pending) {
    const elapsed = Date.now() - new Date(p.purchased_at).getTime();
    if (elapsed < COOLDOWN_MS) continue; // 冷静期还没过

    console.log(`[延迟退款] 处理激活ID ${p.activation_id}...`);
    const result = await cancelActivation(config.hero_api_key, p.activation_id);
    console.log(`[延迟退款] 激活ID ${p.activation_id} 退款结果: ${result}`);

    if (result === 'ACCESS_CANCEL') {
      markRefundDone(p.id, 'refunded');
    } else if (result === 'OTP_RECEIVED' || result.includes('OTP_RECEIVED')) {
      // 码到了，其实是好事，但我们不需要它了，退款被拒也不亏
      markRefundDone(p.id, 'otp_received_no_refund');
    } else {
      // 其他错误标记重试
      markRefundDone(p.id, 'error_' + result.substring(0, 20));
    }
  }
}

// 定时检查：20分钟未操作的卡自动退款
async function autoRefundIdleCards() {
  const config = getConfig();
  if (!config.hero_api_key) return;

  const idleCards = getIdleCards(20);
  for (const card of idleCards) {
    console.log(`[空闲退款] 卡密 ${card.code} 超过20分钟未操作，激活ID ${card.activation_id}，尝试退款...`);
    const result = await cancelActivation(config.hero_api_key, card.activation_id);
    console.log(`[空闲退款] 激活ID ${card.activation_id} 退款结果: ${result}`);

    if (result === 'ACCESS_CANCEL') {
      updateCard(card.id, { status: 'unused', activation_id: null, phone_number: null, sms_code: null, purchased_at: null, used_at: null });
    } else if (result === 'OTP_RECEIVED' || result.includes('OTP_RECEIVED')) {
      // 有验证码到了，尝试获取码内容
      const statusResult = await getStatus(config.hero_api_key, card.activation_id);
      if (statusResult.startsWith('STATUS_OK:')) {
        const smsCode = statusResult.split(':').slice(1).join(':') || '';
        updateCard(card.id, { status: 'completed', sms_code: smsCode, verify_started_at: new Date().toISOString() });
        console.log(`[空闲退款] 卡密 ${card.code} 验证码已到: ${smsCode}`);
      } else {
        updateCard(card.id, { verify_started_at: new Date().toISOString() });
      }
    } else if (result.includes('EARLY_CANCEL_DENIED')) {
      // 还在冷静期？不太可能但加入待退款队列
      addPendingRefund(card.activation_id, card.purchased_at);
    } else {
      // 其他错误，标记 verify_started 防止反复尝试
      updateCard(card.id, { verify_started_at: new Date().toISOString() });
    }
  }
}

module.exports = {
  redeemCard,
  pollForCode,
  handleTimeout,
  requestReplaceNumber,
  processPendingRefunds,
  autoRefundIdleCards,
  invalidatePriceCache,
  COOLDOWN_MS,
  POLL_INTERVAL,
};
