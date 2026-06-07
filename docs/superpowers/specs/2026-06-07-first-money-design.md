# First Money 设计文档

> 手机验证码中间商平台 — 低价从 HeroSMS 采购国外手机号，通过闲鱼高价售出，赚取差价。

## 1. 业务概述

用户在闲鱼上购买虚拟商品后，闲鱼自动发货一个卡密。用户在 First Money 网站输入卡密兑换手机号和验证码，用于 OpenAI 等国外平台的手机验证。

**核心流程：**

```
后台生成卡密 → 导入闲鱼
    ↓
买家在闲鱼下单 → 闲鱼自动发卡密
    ↓
买家访问 First Money 网站 → 输入卡密
    ↓
系统调用 HeroSMS API 实时购买手机号 → 显示给用户
    ↓
用户去 OpenAI 输入手机号 → 点击"我已发送验证码"
    ↓
系统轮询 HeroSMS 获取验证码 → 显示给用户
```

## 2. 技术选型

| 层面 | 选型 | 原因 |
|------|------|------|
| 后端 | Node.js + Express | 轻量，异步 IO 适合轮询 HeroSMS API |
| 数据库 | SQLite (better-sqlite3) | 零配置，数据量不大，够用 |
| 前端 | 纯 HTML + CSS + 原生 JS | 简单直接，移动端友好 |
| 部署 | 单命令启动 | `node server.js` |

## 3. 上游 API（HeroSMS）

### Base URL
```
https://hero-sms.com/stubs/handler_api.php
```

### 认证方式
API Key 通过查询参数 `api_key` 传递。

### 核心接口

| 接口 | 方法 | 参数 | 返回 |
|------|------|------|------|
| 查余额 | GET | `action=getBalance` | `ACCESS_BALANCE:100.5` |
| 买号码 | GET | `action=getNumber&service=xx&country=xx&maxPrice=xx` | `ACCESS_NUMBER:激活ID:手机号` |
| 查状态 | GET | `action=getStatus&id=激活ID` | `STATUS_WAIT_CODE` / `STATUS_OK:验证码` |
| 退款 | GET | `action=setStatus&id=激活ID&status=8` | `ACCESS_CANCEL` |
| 查价格 | GET | `action=getPrices&service=xx&country=xx` | 价格和数量 |

### 退款限制

| 限制 | 说明 |
|------|------|
| 2 分钟内不能取消 | `EARLY_CANCEL_DENIED` — 最少等 120 秒 |
| 20 分钟后不能免费取消 | `FREE_CANCELLATION_EXPIRED` |
| 收到过码不能取消 | `OTP_RECEIVED` — 验证码已到达 |

**有效退款窗口：购买后 2 分钟 ~ 20 分钟，且未收到验证码。**

## 4. 数据库设计

### cards 表
```sql
CREATE TABLE cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,          -- 卡密，格式 FM-XXXX-XXXX-XXXX
    status TEXT NOT NULL DEFAULT 'unused',  -- unused/active/completed
    activation_id TEXT,                 -- HeroSMS 返回的激活ID
    phone_number TEXT,                  -- 电话号码
    sms_code TEXT,                      -- 验证码
    purchased_at DATETIME,             -- 购买手机号的时间（用于计算 2 分钟退款窗口）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME                    -- 首次兑换时间
);
```

**状态流转：**
```
unused → active → completed
           ↑        │
           │        │（退款换号时，更新 activation_id/phone_number/purchased_at，
           │        │ status 保持 active，不新增行）
           │        │
           └────────┘
```
**关键规则：**
- 同一卡密退款重新买号时，直接更新当前行的 `activation_id`、`phone_number`、`purchased_at`，不新增行
- `purchased_at` 用于判断是否已满 2 分钟退款冷静期
- `used_at` 记录首次兑换时间，保持不变

### configs 表
```sql
CREATE TABLE configs (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    hero_api_key TEXT NOT NULL,
    service_code TEXT NOT NULL,         -- 如 "op"（OpenAI）
    country_id INTEGER NOT NULL,        -- 国家ID
    max_price REAL NOT NULL,           -- 最高价格（美元）
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO configs (id, hero_api_key, service_code, country_id, max_price) 
VALUES (1, '', '', 0, 0);
```

## 5. 核心流程

### 5.1 正常兑换流程

```
用户输入卡密
    ↓
后端验证：卡密存在 且 status='unused'
    ↓                                     ┌─ 查余额不足 → 告警，提示管理员
后端调 getPrices 确认价格 → 调 getBalance 确认余额
    ↓
调 getNumber(service, country, maxPrice) 
    ├─ NO_NUMBERS → 提示用户"当前号码售罄，稍后再试"
    ├─ NO_BALANCE → 提示管理员充值
    └─ 成功 → 获得 activation_id + phoneNumber
    ↓
更新 cards: status='active', activation_id, phone_number, used_at=now
    ↓
页面上显示手机号
    ↓
用户去 OpenAI 输入手机号 → 点击"我已发送验证码"
    ↓
后端开始轮询 getStatus（每 5 秒），从购买时起算满 2 分钟
    ├─ 收到 STATUS_OK:xxxx → 提取验证码，更新 sms_code, status='completed'
    │                        页面显示验证码
    └─ 2 分钟到 → 进入超时处理（见 5.2）
```

### 5.2 超时退款换号

```
满 120 秒仍未收到码
    ↓
最后查一次 getStatus
    ├─ STATUS_OK → 显示验证码，结束
    └─ 仍然是 STATUS_WAIT_CODE
           ↓
       调 setStatus(status=8) 退款
           ├─ ACCESS_CANCEL → 退款成功
           │      ↓
           │  更新 cards 当前行: activation_id=null, phone_number=null
           │  （status 保持 active，不新增行）
           │      ↓
           │  调 getNumber 购买新号码
           │      ↓
           │  更新 cards 当前行: activation_id, phone_number, purchased_at=now
           │      ↓
           │  页面刷新显示新号码，提示"正在为您更换新号码..."
           │
           ├─ OTP_RECEIVED → 退款被拒（码刚好到）
           │      ↓
           │  调 getStatus 取出验证码 → 显示给用户
           │
           └─ 其他错误 → 重试一次，仍失败则告警
```

### 5.3 用户主动要求换号

```
用户点击"号码不可用，换一个"
    ↓
检查：购买到现在是否 ≥ 120 秒？
    ├─ 不足 120 秒 → 页面倒计时显示剩余秒数，按钮禁用
    └─ ≥ 120 秒
        ↓
   调 setStatus(status=8) 退款
        ├─ 成功 → 买新号 → 更新 cards → 显示
        ├─ OTP_RECEIVED → 取出验证码显示
        └─ 失败 → 重试，告警
```

## 6. 页面设计

### 6.1 后台管理页 `/admin`

**配置区：**
- HeroSMS API Key（密码框）
- 服务代码（文本输入）
- 国家 ID（文本输入）
- 最高价格 $（数字输入）
- 保存按钮

**卡密生成区：**
- 生成数量 + 生成按钮
- 最近卡密列表（表格：卡密、状态、兑换时间）
- 导出未使用卡密按钮（一键复制到剪贴板）

**订单记录区：**
- 表格：卡密、手机号、验证码、状态、创建时间

### 6.2 用户兑换页 `/`

- 标题 + 简短说明
- 卡密输入框（分段输入 FM-XXXX-XXXX-XXXX）
- 确认兑换按钮
- 兑换成功后显示区：
  - 手机号（大字显示，可复制）
  - 操作提示文字
  - 【号码不可用，换一个】按钮
  - 【我已发送验证码】按钮
  - 验证码区域（收到后大字显示）
  - 状态提示文字（"正在获取验证码..." / "正在更换新号码..."）

## 7. 安全措施

- 后台页设置简单密码验证（环境变量 `ADMIN_PASSWORD`）
- 配置中的 API Key 不通过前端传输
- 卡密格式校验
- 同一卡密不能重复兑换
- SQLite 文件放在项目目录内

## 8. 项目结构

```
first-money/
├── server.js              # Express 入口
├── package.json
├── db.js                  # SQLite 初始化 + 操作
├── hero-api.js            # HeroSMS API 封装
├── card-service.js        # 卡密 + 兑换 + 退款逻辑
├── public/
│   ├── index.html         # 用户兑换页
│   └── admin.html         # 管理后台
├── .env                   # 环境变量（ADMIN_PASSWORD、PORT）
└── data/                  # SQLite 数据库文件存放
```

## 9. 待上线前确认

- [ ] 获取 HeroSMS 上 OpenAI 对应的 service_code
- [ ] 获取目标国家 ID
- [ ] 用真实 API Key 测试：购买 → 等 2 分钟 → 退款，验证余额退回
- [ ] 确认闲鱼自动发货的卡密导入格式
