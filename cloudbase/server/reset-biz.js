'use strict'

/**
 * 商机数据重置（一次性运维脚本）
 *
 * 作用：把商机池里的商机全部删除，再写入 10 条新商机：
 * 代采 2 条、代售 2 条、求购 3 条、租赁 1 条、出租 1 条、出售 1 条。
 *
 * 与 server/index.js 共用 cloudbase/.env 里的 MYSQL_URL：
 *   node server/reset-biz.js            预演：只打印将删除 / 新增的条数
 *   node server/reset-biz.js --yes      真正执行
 *
 * 删除采用软删除（deleted = true），线上各查询都会过滤掉，不会破坏审计数据；
 * 领取记录（我的商机）与「不满足」标记一并清空，避免角标继续计数。
 * 执行后商机池有 20 秒共享缓存，建议重启进程：pm2 restart suanli-platform
 */

const fs = require('fs')
const path = require('path')

function loadEnvFile() {
  const candidates = [path.join(__dirname, '..', '.env'), path.join(__dirname, '.env')]
  const file = candidates.filter((p) => fs.existsSync(p))[0]
  if (!file) return ''
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || process.env[m[1]] != null) continue
    process.env[m[1]] = String(m[2]).trim().replace(/^["']|["']$/g, '')
  }
  return file
}

const { createMysqlRepo } = require('./repo.mysql')

const APPLY = process.argv.includes('--yes')
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const at = (offsetMs) => now - (Number(offsetMs) || 0)

/* 只清理仍在商机池里的条目：已成交 / 已完成 / 已关闭的委托保留，财务记录不动 */
const OPEN_AGENCY_STATUSES = ['待审核', '待确认', '已通过', '已上架']
const OPEN_DEMAND = { status: '求购中', bizPool: true, deleted: { $ne: true } }
const OPEN_AGENCY = { status: { $in: OPEN_AGENCY_STATUSES }, deleted: { $ne: true } }
const OPEN_PRODUCT = { status: '在售', bizPool: true, deleted: { $ne: true } }

/** 截止时间：北京时间某天 23:59:59.999 */
function deadlineOf(days) {
  const t = now + days * DAY
  const dayStart = Math.floor((t + 8 * 60 * 60 * 1000) / DAY) * DAY - 8 * 60 * 60 * 1000
  const end = dayStart + DAY - 1
  const d = new Date(dayStart + 8 * 60 * 60 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return { deadline: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, deadlineAt: end }
}

/* 演示主体：只用于商机池展示，公开主体（exposure = open）才会入池 */
const OWNERS = [
  {
    uid: 'bizdemo_u1', nick: '华算智算', city: '深圳',
    subject: '深圳市华算智算科技有限公司', subjectType: '企业', phone: '13800000001'
  },
  {
    uid: 'bizdemo_u2', nick: '云栖算力', city: '杭州',
    subject: '杭州云栖算力服务有限公司', subjectType: '企业', phone: '13800000002'
  },
  {
    uid: 'bizdemo_u3', nick: '京北智能', city: '北京',
    subject: '北京京北智能科技有限公司', subjectType: '企业', phone: '13800000003'
  }
]

/* 代采 / 代售委托：平台代为对接，委托方信息只展示脱敏主体 */
const AGENCIES = [
  {
    id: 'AGDEMO01', ownerId: 'bizdemo_u3', side: 'buy', item: 'H100 80G SXM', itemCat: 'GPU 加速卡',
    qty: 8, price: 228000, city: '深圳', days: 30, views: 46,
    detail: '客户自用智算集群扩容，接受原厂或授权渠道现货，需提供序列号与出厂证明。',
    subjectMasked: '北京**智能科技有限公司', phoneMasked: '138****0003'
  },
  {
    id: 'AGDEMO02', ownerId: 'bizdemo_u2', side: 'buy', item: '昇腾 910B 64G', itemCat: 'GPU 服务器',
    qty: 4, price: 920000, city: '上海', days: 25, views: 31,
    detail: '国产算力项目采购，要求整机交付、原厂质保三年，可接受分批到货。',
    subjectMasked: '杭州**算力服务有限公司', phoneMasked: '138****0002'
  },
  {
    id: 'AGDEMO03', ownerId: 'bizdemo_u1', side: 'sell', item: 'A100 80G SXM', itemCat: 'GPU 加速卡',
    qty: 6, price: 126000, city: '深圳', days: 20, views: 58,
    detail: '保税仓现货，成色 9 成新，支持现场验机与同台互验，可开专票。',
    subjectMasked: '深圳**智算科技有限公司', phoneMasked: '138****0001'
  },
  {
    id: 'AGDEMO04', ownerId: 'bizdemo_u3', side: 'sell', item: 'RTX 4090 24G', itemCat: 'GPU 加速卡',
    qty: 20, price: 26500, city: '北京', days: 15, views: 73,
    detail: '整批出货，均为非矿卡，可提供上机测试视频，支持拆批。',
    subjectMasked: '北京**智能科技有限公司', phoneMasked: '138****0003'
  }
]

/* 求购 / 租赁需求：条件留空以放宽匹配，方便演示 */
const DEMANDS = [
  {
    id: 'DMDEMO01', ownerId: 'bizdemo_u1', tradeMode: '求购', cat: 'GPU 加速卡', brand: 'NVIDIA',
    model: 'H100 80G SXM', qty: 6, unit: '张', budget: 232000, city: '深圳',
    title: '求购 H100 80G SXM 6 张，深圳现货优先', supply: '现货', tax: '含专票',
    deliver: '3 天内', views: 62, responses: 3,
    must: ['接受同台互验', '提供设备实拍图片', '序列号可官网查询'],
    note: '自用集群扩容，优先深圳或广州仓库现货。'
  },
  {
    id: 'DMDEMO02', ownerId: 'bizdemo_u2', tradeMode: '求购', cat: 'GPU 加速卡', brand: 'NVIDIA',
    model: 'A100 40G PCIe', qty: 16, unit: '张', budget: 68000, city: '东莞',
    title: '求购 A100 40G PCIe 16 张，可分批交付', supply: '现货', tax: '不含税',
    deliver: '一周内', views: 38, responses: 1,
    must: ['接受同台互验', '提供设备实拍图片'],
    note: '预算单价 6.8 万以内，整批优先，可接受两批交付。'
  },
  {
    id: 'DMDEMO03', ownerId: 'bizdemo_u3', tradeMode: '求购', cat: 'GPU 加速卡', brand: 'NVIDIA',
    model: 'L40S 48G', qty: 8, unit: '张', budget: 148000, city: '杭州',
    title: '求购 L40S 48G 8 张，杭州验收', supply: '现货', tax: '含专票',
    deliver: '3 天内', views: 27, responses: 0,
    must: ['提供设备实拍图片', '序列号可官网查询'],
    note: '推理业务扩容，需要 8 卡整机配套。'
  },
  {
    id: 'DMDEMO04', ownerId: 'bizdemo_u2', tradeMode: '租赁', cat: 'GPU 加速卡', brand: 'NVIDIA',
    model: 'A100 40G PCIe', qty: 4, unit: '台 / 月', budget: 9800, city: '上海',
    title: '租赁 A100 40G PCIe 4 台，长租一年', supply: '现货', tax: '含专票',
    deliver: '当日可起租', views: 44, responses: 2,
    term: ['12 个月'], closed: '可接受闭口价', deposit: '押一付三', pay: '月付',
    must: ['提供设备实拍图片'],
    note: '长期稳定使用，要求机房托管与网络带宽包含在内。'
  }
]

/* 出租 / 出售货源：同样进商机池，作为「匹配货源」展示 */
const PRODUCTS = [
  {
    id: 'PDDEMO01', ownerId: 'bizdemo_u1', tradeMode: '租赁', cat: 'GPU 加速卡', brand: 'NVIDIA',
    model: 'H100 80G SXM', qty: 8, minQty: 2, price: 32000, priceUnit: '¥ / 台 / 月',
    cond: '9 成新', city: '', deliver: '当日可起租', views: 96,
    title: '出租 H100 80G SXM 8 台，深圳机房可托管',
    term: ['3 个月', '6 个月', '12 个月'], closed: '可接受闭口价', deposit: '押二付一', pay: '月付',
    must: ['提供设备实拍图片', '机房租用可另议'],
    note: '整机柜交付，含基础运维，可安排现场查看。'
  },
  {
    id: 'PDDEMO02', ownerId: 'bizdemo_u3', tradeMode: '出售', cat: 'GPU 加速卡', brand: 'NVIDIA',
    model: 'RTX 4090 24G', qty: 12, minQty: 1, price: 26800, priceUnit: '¥ / 张',
    cond: '9 成新', city: '上海', deliver: '3 天内', views: 71,
    title: '出售 RTX 4090 24G 12 张，非矿卡',
    must: ['接受同台互验', '提供设备实拍图片'],
    note: '整批出货，可拆批，支持快递保价到付。'
  }
]

function agencyDoc(row) {
  const d = deadlineOf(row.days)
  const amount = Math.round(row.qty * row.price)
  const fee = amount >= 1000000
    ? Math.round(amount * 0.005)
    : Math.min(Math.round(amount * 0.01), 5000)
  const createdAt = at(row.views * 60 * 1000)
  return {
    id: row.id,
    ownerId: row.ownerId,
    side: row.side,
    kind: row.side === 'buy' ? '代采' : '代售',
    mode: '委托',
    rental: false,
    term: [],
    item: row.item,
    itemCat: row.itemCat,
    qty: row.qty,
    price: row.price,
    amount,
    serviceFee: fee,
    upfront: 0,
    payNow: 0,
    feeRule: amount >= 1000000
      ? '100 万元以上，按 0.5% 收取，上不封顶（成交后支付）'
      : '3 万 - 100 万元，按 1% 收取（封顶 5000 元，成交后支付）',
    feeNote: '成交后支付',
    feeStatus: 'unbilled',
    feeDueAt: 0,
    feePaidAt: 0,
    feePaidBy: '',
    feeBillId: '',
    feeBilledAt: 0,
    paidClaimAt: 0,
    paidClaimCount: 0,
    paidClaimNote: '',
    deadline: d.deadline,
    deadlineAt: d.deadlineAt,
    dealProposedAt: 0,
    dealProposedBy: '',
    dealConfirmedAt: 0,
    deferredFee: true,
    largeAmount: amount >= 1000000,
    visibility: 'public',
    exposure: 'open',
    channel: 'both',
    bizPool: true,
    authPhoneMatched: false,
    materialVerified: true,
    detail: row.detail,
    flow: ['平台审核', '平台撮合报价', '现场 / 远程验机', '平台发起成交', '委托方确认'],
    must: ['接受同台互验', '提供设备实拍图片', '序列号可官网查询'],
    nego: false,
    city: row.city,
    subjectType: '企业',
    subjectMasked: row.subjectMasked,
    legalMasked: '张*',
    creditMasked: '9144**********1234',
    idCardMasked: '',
    phoneMasked: row.phoneMasked,
    media: [],
    status: '已上架',
    reason: '',
    closeReason: '',
    reviewNote: '',
    staff: '',
    views: row.views,
    createdAt,
    updatedAt: createdAt,
    approvedAt: createdAt + 2 * 60 * 60 * 1000,
    confirmedAt: createdAt + 2 * 60 * 60 * 1000,
    expiresAt: d.deadlineAt,
    closedAt: 0,
    deleted: false
  }
}

function demandDoc(row) {
  const isRent = row.tradeMode === '租赁'
  return {
    id: row.id,
    ownerId: row.ownerId,
    tradeMode: row.tradeMode,
    title: row.title,
    cat: row.cat,
    brand: row.brand,
    model: row.model,
    qty: row.qty,
    unit: row.unit,
    budget: row.budget,
    budgetMax: row.budget,
    budgetMode: 'fixed',
    budgetUnit: isRent ? '¥ / 台 / 月' : '¥ / 张',
    city: row.city,
    /* 成色条件留空：标准匹配下不限制成色，演示条目更容易被匹配到 */
    cond: '',
    tax: row.tax,
    supply: row.supply,
    deliver: row.deliver,
    term: row.term || [],
    closed: row.closed || '',
    deposit: row.deposit || '',
    pay: row.pay || '',
    must: row.must,
    nego: false,
    flow: ['确认必须条件', '平台撮合报价', '验机 / 验收', '确认成交'],
    note: row.note,
    tags: [],
    accept: '',
    requirements: '',
    limit: '',
    media: [],
    visibility: 'public',
    exposure: 'open',
    channel: 'both',
    bizPool: true,
    status: '求购中',
    views: row.views,
    responses: row.responses,
    deleted: false,
    createdAt: at(row.views * 90 * 1000),
    updatedAt: at(row.views * 90 * 1000)
  }
}

function productDoc(row) {
  const isRent = row.tradeMode === '租赁'
  const createdAt = at(row.views * 60 * 1000)
  return {
    id: row.id,
    ownerId: row.ownerId,
    side: 'supply',
    tradeMode: row.tradeMode,
    title: row.title,
    cat: row.cat,
    brand: row.brand,
    model: row.model,
    qty: row.qty,
    minQty: row.minQty,
    price: row.price,
    priceUnit: row.priceUnit,
    priceMode: 'fixed',
    priceMax: 0,
    currency: 'CNY',
    currencySymbol: '¥',
    cond: row.cond,
    city: row.city,
    deliver: row.deliver,
    term: isRent ? row.term : [],
    closed: isRent ? row.closed : '',
    deposit: isRent ? row.deposit : '',
    pay: isRent ? row.pay : '',
    must: row.must,
    nego: false,
    flow: ['确认必须条件', '平台撮合', '验机 / 验收', '确认成交'],
    note: row.note,
    tags: [],
    accept: '',
    requirements: '',
    limit: '',
    media: [],
    visibility: 'public',
    exposure: 'open',
    channel: 'both',
    bizPool: true,
    status: '在售',
    views: row.views,
    deleted: false,
    createdAt,
    updatedAt: createdAt
  }
}

async function upsertOwner(repo, owner) {
  const user = await repo.get('users', owner.uid)
  if (!user) {
    await repo.insert('users', {
      id: owner.uid,
      openid: owner.uid,
      nick: owner.nick,
      status: '正常',
      exposure: 'open',
      createdAt: now,
      updatedAt: now
    })
  }
  const profiles = await repo.find('profiles', { uid: owner.uid }, { limit: 1 })
  const patch = {
    subject: owner.subject,
    subjectType: owner.subjectType,
    city: owner.city,
    exposure: 'open',
    phonePublic: true,
    updatedAt: now
  }
  if (profiles[0]) {
    await repo.updateWhere('profiles', { uid: owner.uid }, patch)
  } else {
    await repo.insert('profiles', Object.assign({
      id: owner.uid,
      uid: owner.uid,
      createdAt: now
    }, patch))
  }
}

async function main() {
  const envFile = loadEnvFile()
  const url = process.env.MYSQL_URL || process.env.DATABASE_URL
  if (!url) {
    throw new Error('缺少 MYSQL_URL：请在 cloudbase/.env 里配置数据库连接')
  }
  console.log(`环境文件：${envFile || '系统环境变量'}`)
  const repo = createMysqlRepo({ url })
  try {
    const willDelete = {
      demands: await repo.count('demands', OPEN_DEMAND),
      agencies: await repo.count('agencies', OPEN_AGENCY),
      products: await repo.count('products', OPEN_PRODUCT),
      bizClaims: await repo.count('bizClaims', { id: { $ne: '' } }),
      agencyClaims: await repo.count('agencyClaims', { id: { $ne: '' } }),
      bizMarks: await repo.count('bizMarks', { id: { $ne: '' } })
    }
    console.log('将删除：', willDelete)
    console.log(`将新增：代采 2 条、代售 2 条、求购 3 条、租赁 1 条、出租 1 条、出售 1 条（共 10 条）`)
    for (const row of AGENCIES) console.log(`  · ${row.side === 'buy' ? '代采' : '代售'} ${row.item} ×${row.qty}（${row.city}）`)
    for (const row of DEMANDS) console.log(`  · ${row.tradeMode} ${row.model} ×${row.qty}（${row.city}）`)
    for (const row of PRODUCTS) console.log(`  · ${row.tradeMode} ${row.model} ×${row.qty}（${row.city || '线上'}）`)

    if (!APPLY) {
      console.log('\n预演结束：加 --yes 才会真正写入')
      return
    }

    /* 1. 删除旧商机：需求 / 委托 / 进池货源统一软删除，线上查询都会过滤 */
    const removed = {
      demands: (await repo.updateWhere('demands', OPEN_DEMAND, { deleted: true, updatedAt: now })).count,
      agencies: (await repo.updateWhere('agencies', OPEN_AGENCY, { deleted: true, updatedAt: now })).count,
      products: (await repo.updateWhere('products', OPEN_PRODUCT, { deleted: true, updatedAt: now })).count
    }
    /* 2. 清空领取记录与「不满足」标记：否则「我的商机」与角标仍按旧商机计数 */
    for (const collection of ['bizClaims', 'agencyClaims', 'bizMarks']) {
      let left = 1
      while (left > 0) {
        left = (await repo.removeWhere(collection, { id: { $ne: '' } }, 500)).count
      }
    }
    console.log('已删除：', removed)

    /* 3. 演示主体与公开资料 */
    for (const owner of OWNERS) await upsertOwner(repo, owner)

    /* 4. 写入 10 条商机 */
    for (const row of AGENCIES) await repo.insert('agencies', agencyDoc(row))
    for (const row of DEMANDS) await repo.insert('demands', demandDoc(row))
    for (const row of PRODUCTS) await repo.insert('products', productDoc(row))

    console.log('已写入 10 条商机，完成后请重启进程：pm2 restart suanli-platform')
  } finally {
    await repo.close()
  }
}

main().catch((err) => {
  console.error('执行失败：' + (err && err.message))
  process.exitCode = 1
})
