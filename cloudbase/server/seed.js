'use strict'

/**
 * 线上测试数据初始化：幂等（已有商品则跳过）。
 * 用法：node server/seed.js
 */

const fs = require('node:fs')
const path = require('node:path')

function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const idx = text.indexOf('=')
    if (idx <= 0) continue
    const key = text.slice(0, idx).trim()
    let value = text.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}
loadEnvFile(process.env.ENV_FILE || path.join(__dirname, '..', '.env'))

const { createMysqlRepo } = require('./repo.mysql')

const NOW = Date.now()
const DAY = 24 * 3600 * 1000

const USERS = [
  { id: 'seed_owner_1', openid: 'seed_owner_1', nick: '华算科技 · 深圳', status: '正常', exposure: 'open', createdAt: NOW - 30 * DAY },
  { id: 'seed_owner_2', openid: 'seed_owner_2', nick: '云腾智算 · 上海', status: '正常', exposure: 'open', createdAt: NOW - 25 * DAY }
]

const PROFILES = [
  {
    id: 'seed_owner_1', uid: 'seed_owner_1', subjectType: '民企', city: '深圳', exposure: 'open',
    subjectKind: 'company', phonePublic: true, subject: '华算科技（深圳）有限公司', contact: '张经理',
    quals: ['营业执照已认证'], joined: '2025-08-12', createdAt: NOW - 30 * DAY, updatedAt: NOW - 2 * DAY
  },
  {
    id: 'seed_owner_2', uid: 'seed_owner_2', subjectType: '民企', city: '上海', exposure: 'open',
    subjectKind: 'company', phonePublic: true, subject: '上海云腾智算科技有限公司', contact: '李经理',
    quals: ['营业执照已认证'], joined: '2025-09-03', createdAt: NOW - 25 * DAY, updatedAt: NOW - 3 * DAY
  }
]

function product(no, extra) {
  return Object.assign({
    ownerId: 'seed_owner_1',
    tradeMode: '出售',
    side: 'supply',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    qty: 1,
    minQty: 1,
    priceUnit: '台',
    supply: '现货',
    tax: '含专票',
    city: '深圳',
    cond: '9 成新',
    deliver: '自提 / 物流',
    status: '在售',
    note: '',
    accept: '同台验收、原件比对',
    requirements: '提供采购凭证与序列号',
    limit: '',
    must: ['接受同台互验'],
    nego: ['价格可议'],
    flow: ['提交咨询', '平台核对', '建三方企微群', '线下看货验机', '线下签约与付款'],
    heat: 0,
    createdAt: NOW - no * 3600 * 1000
  }, extra, { id: 'seed_p' + no })
}

const PRODUCTS = [
  product(3, {
    title: 'NVIDIA H100 80G 整机（8 卡）', brand: 'NVIDIA', model: 'H100 80G SXM', qty: 6, price: 235000,
    note: '整机 8 卡，可拆单，支持同台验收。'
  }),
  product(7, {
    title: 'NVIDIA A100 40G 显卡（现货）', model: 'A100 40G PCIe', qty: 20, price: 68500,
    cond: '95 新', city: '东莞', note: '原厂拆机，无维修史，可单卡出。'
  }),
  product(12, {
    title: 'RTX 4090 24G 八卡服务器', model: 'RTX 4090', qty: 4, price: 168000,
    cat: 'GPU 服务器', city: '北京', note: '适合推理与小模型训练，提供上架测试。'
  }),
  product(20, {
    ownerId: 'seed_owner_2',
    title: '昇腾 910B 训练服务器（8 卡）', brand: '华为昇腾', model: '910B', qty: 2, price: 920000,
    city: '上海', cond: '全新', note: '整机原封，含三年原厂服务。'
  })
]

const DEMANDS = [
  Object.assign({
    id: 'seed_d1',
    ownerId: 'seed_owner_2',
    tradeMode: '求购',
    side: 'demand',
    title: '求购 8 台 H100 80G 整机',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'H100 80G',
    qty: 8,
    budget: 228000,
    budgetUnit: '台',
    supply: '现货',
    tax: '含专票',
    city: '上海',
    cond: '9 成新以上',
    status: '求购中',
    must: ['接受同台互验', '提供设备实拍图片', '提供设备实拍视频'],
    sameMachine: true,
    codeAsk: true,
    note: '需 7 天内交付，接受分两批。',
    responses: 0
  }, { createdAt: NOW - 5 * 3600 * 1000 }),
  Object.assign({
    id: 'seed_d2',
    ownerId: 'seed_owner_1',
    tradeMode: '求购',
    side: 'demand',
    title: '求购 A800 80G 显卡 16 张',
    cat: 'GPU 显卡',
    brand: 'NVIDIA',
    model: 'A800 80G',
    qty: 16,
    budget: 72000,
    budgetUnit: '张',
    supply: '现货',
    tax: '含专票',
    city: '深圳',
    cond: '95 新以上',
    status: '求购中',
    must: ['接受同台互验', '提供序列号'],
    sameMachine: false,
    codeAsk: true,
    note: '可接受分批交付，长期合作优先。',
    responses: 0
  }, { createdAt: NOW - 9 * 3600 * 1000 })
]

async function main() {
  const url = String(process.env.MYSQL_URL || '').trim()
  if (!url) throw new Error('MYSQL_URL 未配置')
  const repo = createMysqlRepo({ url })
  await repo.initSchema()
  const existing = await repo.count('products', {})
  if (existing > 0) {
    console.log('[seed] 已有 ' + existing + ' 条商品，跳过')
    await repo.close()
    return
  }
  for (const doc of USERS) {
    if (await repo.get('users', doc.id)) continue
    await repo.insert('users', doc)
  }
  for (const doc of PROFILES) {
    if (await repo.get('profiles', doc.id)) continue
    await repo.insert('profiles', doc)
  }
  for (const doc of PRODUCTS) await repo.insert('products', doc)
  for (const doc of DEMANDS) await repo.insert('demands', doc)
  console.log('[seed] 写入用户 ' + USERS.length + ' / 档案 ' + PROFILES.length +
    ' / 商品 ' + PRODUCTS.length + ' / 需求 ' + DEMANDS.length)
  await repo.close()
}

main().catch((err) => {
  console.error('[seed] 失败：' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
