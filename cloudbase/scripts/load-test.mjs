#!/usr/bin/env node
/**
 * 进程内全链路数据流转 + 高并发压测。
 *
 * 1) flow：用一组全新测试数据走完整业务链路
 *    主体设置 → 发布商品 / 需求 → 咨询开会话 → 站内消息 → 管理员接单 / 释放联系方式
 *    → 商机会员领取 → 购买会员 → 财务确认开通 → 私库存，逐环节校验落库结果。
 * 2) 并发：商机领取、发布、列表缓存、发消息、开会话、档案保存、会员下单、咨询去重、
 *    管理员抢单，校验并发下的唯一性 / 幂等性与落库数量。
 *
 * 运行：node cloudbase/scripts/load-test.mjs
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const shared = path.join(here, '..', 'shared')

const { createMemoryRepo } = require(path.join(shared, 'repo.js'))
const { createRouter } = require(path.join(shared, 'router.js'))
const { createCache } = require(path.join(shared, 'cache.js'))
const { loadKeys, hashPassword, generateTotp, encryptField } = require(path.join(shared, 'crypto.js'))
const {
  TRADE_MODES, PRODUCT_STATUS, DEMAND_STATUS, LEAD_STATUS, EXPOSURES
} = require(path.join(shared, 'constants.js'))

const KEY = Buffer.alloc(32, 7).toString('base64')
const HMAC = Buffer.alloc(32, 9).toString('base64')
const keys = loadKeys({ AES_KEY_B64: KEY, HMAC_KEY_B64: HMAC })

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()

/* 并发场景用的标的 */
const DEMAND_ID = 'D_LOAD_1'
const MSG_PRODUCT_ID = 'P_MSG_1'
const MSG_THREAD_ID = 'T_LOAD_1'
const CHAT_PRODUCT_ID = 'P_CHAT_1'
const CONSULT_PRODUCT_ID = 'P_CONSULT_1'
const CLAIM_LEAD_ID = 'L_ADMIN_CLAIM_1'

/* 全链路流转用的用户与标的 */
const FLOW = {
  seller: 'o_flow_seller',
  buyer: 'o_flow_buyer',
  biz: 'o_flow_biz',
  payer: 'o_flow_payer',
  productId: 'P_FLOW_1',
  demandId: 'D_FLOW_1',
  sellerPhone: '13800138000',
  buyerPhone: '13900139000'
}

const BIZ_MEMBERS = 50
const PUBLISH_USERS = 100
const LIST_CONCURRENCY = 200
const MSG_CONCURRENCY = 50
const CHAT_CONCURRENCY = 8
const PROFILE_CONCURRENCY = 20
const PURCHASE_CONCURRENCY = 10
const CONSULT_CONCURRENCY = 10
const ADMIN_CLAIM_CONCURRENCY = 10

const ADMIN_USERNAME = 'admin'
const ADMIN_PASSWORD = 'Admin@12345'
const ADMIN_TOTP = 'JBSWY3DPEHPK3PXP'

function makeUser(uid, realname, extra) {
  return Object.assign({
    id: uid,
    openid: uid,
    nick: realname,
    realname,
    status: '正常',
    createdAt: NOW - DAY
  }, extra || {})
}

function makeStock(uid, id, model, qty) {
  return {
    id,
    ownerId: uid,
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model,
    cond: '全新',
    qty,
    minQty: 1,
    price: 120000,
    status: '在售',
    deleted: false,
    createdAt: NOW - DAY
  }
}

function buildSeed() {
  const users = [
    /* 并发场景基础用户 */
    makeUser('o_owner', '货主甲'),
    makeUser('o_buyer', '采购乙'),
    makeUser('o_reader', '浏览丙'),
    makeUser('o_chat', '直聊丁'),
    makeUser('o_consult', '咨询戊'),
    makeUser('o_payer', '缴费己'),
    makeUser('o_profiler', '档案庚'),
    /* 全链路流转用户 */
    makeUser(FLOW.seller, '货主辛'),
    makeUser(FLOW.buyer, '采购壬'),
    makeUser(FLOW.biz, '商机会员癸'),
    makeUser(FLOW.payer, '新会员甲')
  ]
  const profiles = [
    { id: 'pf_owner', uid: 'o_owner', exposure: EXPOSURES.OPEN, subject: '甲供应链' },
    { id: 'pf_chat', uid: 'o_chat', exposure: EXPOSURES.OPEN, subject: '丁电子' },
    { id: 'pf_consult', uid: 'o_consult', exposure: EXPOSURES.OPEN, subject: '戊贸易' },
    { id: FLOW.seller, uid: FLOW.seller, exposure: EXPOSURES.OPEN, subject: '辛科技' }
  ]

  /* 50 个已开通商机会员：每人一份匹配库存 */
  const bizAccess = []
  const stocks = []
  for (let i = 0; i < BIZ_MEMBERS; i += 1) {
    const uid = `o_biz_${i}`
    users.push(makeUser(uid, `商机会员${i}`))
    bizAccess.push({
      id: uid,
      uid,
      status: '已开通',
      plan: '标准版',
      expireAt: NOW + 365 * DAY,
      appliedAt: NOW - 30 * DAY
    })
    stocks.push(makeStock(uid, `SK_${uid}`, 'H100 80G', 10))
  }

  /* 100 个可发布用户：每个账号每天限发 10 条，一人一条不会触发限流。
     发布前需主体信息与联系方式完整，这里按发布校验口径补齐，避免压测被业务前置校验拦掉。 */
  for (let i = 0; i < PUBLISH_USERS; i += 1) {
    const uid = `o_pub_${i}`
    users.push(makeUser(uid, `发布用户${i}`, {
      phoneCipher: encryptField({ keys, value: '1380000' + String(1000 + i), aad: `users.phoneCipher.${uid}` })
    }))
    profiles.push({
      id: `pf_${uid}`,
      uid,
      exposure: EXPOSURES.OPEN,
      subject: `发布企业${i}`,
      subjectType: '民企',
      subjectKind: 'company'
    })
  }

  /* 全链路流转的商机会员与库存 */
  bizAccess.push({
    id: FLOW.biz,
    uid: FLOW.biz,
    status: '已开通',
    plan: '标准版',
    expireAt: NOW + 365 * DAY,
    appliedAt: NOW - 30 * DAY
  })
  stocks.push(makeStock(FLOW.biz, `SK_${FLOW.biz}`, 'H100 80G', 10))

  const demand = {
    id: DEMAND_ID,
    ownerId: 'o_owner',
    tradeMode: TRADE_MODES.BUY,
    side: 'demand',
    title: '求购 H100 80G 一批',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'H100 80G',
    qty: 2,
    minQty: 1,
    cond: '全新',
    city: '北京',
    supply: '现货',
    tax: '含税',
    status: DEMAND_STATUS.OPEN,
    visibility: 'public',
    channel: 'both',
    bizPool: true,
    deleted: false,
    createdAt: NOW - DAY
  }

  const msgProduct = {
    id: MSG_PRODUCT_ID,
    ownerId: 'o_owner',
    tradeMode: TRADE_MODES.SELL,
    side: 'supply',
    title: 'H100 80G 现货货源',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'H100 80G',
    qty: 5,
    minQty: 1,
    price: 120000,
    priceUnit: '¥ / 台',
    cond: '全新',
    condLevel: '',
    city: '北京',
    supply: '现货',
    tax: '含税',
    deliver: '3 天内',
    status: PRODUCT_STATUS.ON_SALE,
    visibility: 'public',
    channel: 'normal',
    bizPool: false,
    currency: 'CNY',
    currencySymbol: '¥',
    currencyLabel: '人民币',
    views: 0,
    deleted: false,
    createdAt: NOW - DAY
  }

  const chatProduct = Object.assign({}, msgProduct, {
    id: CHAT_PRODUCT_ID,
    ownerId: 'o_chat',
    title: 'A100 40G 现货货源',
    model: 'A100 40G'
  })

  const consultProduct = Object.assign({}, msgProduct, {
    id: CONSULT_PRODUCT_ID,
    ownerId: 'o_consult',
    title: 'A800 80G 现货货源',
    model: 'A800 80G'
  })

  const lead = {
    id: MSG_THREAD_ID,
    uid: 'o_buyer',
    productId: MSG_PRODUCT_ID,
    status: '已对接',
    createdAt: NOW - 3600 * 1000
  }

  /* 管理员抢单并发场景：一条未分配线索 */
  const claimLead = {
    id: CLAIM_LEAD_ID,
    uid: 'o_buyer',
    productId: MSG_PRODUCT_ID,
    status: LEAD_STATUS.PENDING,
    source: '小程序咨询',
    formSummary: '管理员并发抢单测试',
    assignedTo: '',
    assignedAccount: '',
    createdAt: NOW - 3600 * 1000,
    contactReleased: false
  }

  return {
    users,
    profiles,
    bizAccess,
    stocks,
    demands: [demand],
    products: [msgProduct, chatProduct, consultProduct],
    leads: [lead, claimLead],
    accounts: []
  }
}

function publishPayload(i) {
  return {
    tradeMode: TRADE_MODES.SELL,
    title: `并发压测 H100 货源 ${i}`,
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'A100 40G',
    qty: 2,
    minQty: 1,
    price: '120000',
    cond: '全新',
    city: '北京',
    supply: '现货',
    tax: ['含税'],
    deliver: '3 天内',
    channel: 'normal'
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

async function runScenario(name, count, fn) {
  const latencies = []
  const errors = []
  let failed = 0
  const startedAt = performance.now()
  await Promise.all(Array.from({ length: count }, async (_, i) => {
    const t0 = performance.now()
    try {
      const res = await fn(i)
      if (!res || res.ok !== true) {
        failed += 1
        if (errors.length < 3) errors.push(`${res && res.code}: ${res && res.message}`)
      }
    } catch (err) {
      failed += 1
      if (errors.length < 3) errors.push(String((err && err.message) || err))
    } finally {
      latencies.push(performance.now() - t0)
    }
  }))
  const elapsed = Math.max(performance.now() - startedAt, 0.001)
  latencies.sort((a, b) => a - b)
  const qps = (count / elapsed) * 1000
  return {
    name,
    count,
    failed,
    errors,
    elapsed,
    qps,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99)
  }
}

function printResult(result, extra) {
  console.log(`\n[场景] ${result.name}`)
  console.log(
    `  并发 ${result.count} · 成功 ${result.count - result.failed} · 失败 ${result.failed}` +
    ` · 耗时 ${result.elapsed.toFixed(0)}ms · QPS ${result.qps.toFixed(1)}`
  )
  console.log(
    `  p50 ${result.p50.toFixed(1)}ms · p95 ${result.p95.toFixed(1)}ms · p99 ${result.p99.toFixed(1)}ms`
  )
  if (extra) console.log(`  ${extra}`)
  if (result.errors.length) console.log(`  失败样例：${result.errors.join(' | ')}`)
}

/* ------------------------------------------------------------------ */
/* 全链路数据流转                                                       */
/* ------------------------------------------------------------------ */

async function runFlow(repo, userRouter, adminRouter) {
  const checks = []
  const check = (label, ok, detail) => {
    checks.push({ label, ok: !!ok })
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` · ${detail}` : ''}`)
  }
  const fail = (label, res) => {
    check(label, false, res ? `${res.code}: ${res.message}` : '无响应')
  }

  console.log('\n[全链路] 主体 → 发布 → 咨询 → 会话 → 接单 → 释放联系方式 → 商机领取 → 缴费开通 → 库存')

  /* 1. 主体公开 */
  const saved = await userRouter.dispatch('profile.save', {
    nick: '货主辛',
    realname: '辛老板',
    phone: FLOW.sellerPhone,
    phonePublic: true,
    subject: '北京辛科技有限公司',
    subjectType: '民企',
    subjectKind: 'company',
    exposure: EXPOSURES.OPEN
  }, { openid: FLOW.seller })
  if (!saved.ok) fail('1. 保存主体信息', saved)
  const profile = (await repo.find('profiles', { uid: FLOW.seller }, { limit: 1 }))[0] || {}
  check('1. 主体公开范围落库为 open', profile.exposure === EXPOSURES.OPEN, `exposure=${profile.exposure}`)
  check('1. 主体名称密文落库、明文置空', !!profile.subjectCipher && !profile.subject, `cipher=${!!profile.subjectCipher}`)

  /* 2. 发布商品（普通 + 商机） */
  const productRes = await userRouter.dispatch('product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: 'H100 80G 现货 8 台',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'H100 80G',
    qty: 8,
    minQty: 1,
    price: '118000',
    cond: '全新',
    city: '北京',
    supply: '现货',
    tax: ['含税'],
    deliver: '3 天内',
    channel: 'both',
    syncStock: true,
    must: [],
    nego: [],
    flow: []
  }, { openid: FLOW.seller })
  if (!productRes.ok) fail('2. 发布商品', productRes)
  const productId = (productRes.data && productRes.data.id) || ''
  const product = await repo.get('products', productId)
  check('2. 商品落库且进入商机池', !!product && product.visibility === 'public' && product.bizPool === true,
    `id=${productId} status=${product && product.status}`)
  check('2. 商品同步私库存', !!(await repo.get('stocks', `sk_${productId}`)), '用于新需求匹配')

  /* 3. 发布需求（普通 + 商机） */
  const demandRes = await userRouter.dispatch('demand.publish', {
    tradeMode: TRADE_MODES.BUY,
    title: '求购 H100 80G 两台',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'H100 80G',
    qty: 2,
    minQty: 1,
    budget: '120000',
    city: '北京',
    supply: '现货',
    tax: ['含税'],
    visibility: 'public',
    channel: 'both',
    must: [],
    nego: [],
    flow: []
  }, { openid: FLOW.seller })
  if (!demandRes.ok) fail('3. 发布需求', demandRes)
  const demandId = (demandRes.data && demandRes.data.id) || ''
  const demand = await repo.get('demands', demandId)
  check('3. 需求落库且进入商机池', !!demand && demand.bizPool === true && demand.status === DEMAND_STATUS.OPEN,
    `id=${demandId} status=${demand && demand.status}`)

  /* 4. 买家咨询商品（买家也公开主体，管理员才能把联系方式转给货主） */
  const buyerProfile = await userRouter.dispatch('profile.save', {
    nick: '采购壬',
    realname: '壬经理',
    phone: FLOW.buyerPhone,
    phonePublic: true,
    subject: '壬采购有限公司',
    subjectType: '民企',
    subjectKind: 'company',
    exposure: EXPOSURES.OPEN
  }, { openid: FLOW.buyer })
  check('4. 买家主体公开', buyerProfile.ok, buyerProfile.ok ? '' : `${buyerProfile.code}: ${buyerProfile.message}`)

  const consultRes = await userRouter.dispatch('consult.submit', {
    productId,
    phone: FLOW.buyerPhone,
    conds: [],
    summary: '全链路测试：想了解这批 H100 的交期'
  }, { openid: FLOW.buyer })
  if (!consultRes.ok) fail('4. 提交咨询', consultRes)
  const leadId = (consultRes.data && consultRes.data.leadId) || ''
  const threadId = (consultRes.data && consultRes.data.threadId) || ''
  const lead = await repo.get('leads', leadId)
  check('4. 线索落库为待跟进', !!lead && lead.status === LEAD_STATUS.PENDING, `leadId=${leadId}`)
  check('4. 直接开通会话并复用线索号', !!threadId && threadId === leadId, `threadId=${threadId}`)
  check('4. 会话双方各一份消息副本',
    (await repo.count('outbox', { 'payload.threadId': threadId })) === 2)

  /* 5. 买家在会话里发消息 */
  const msgRes = await userRouter.dispatch('msg.send', {
    threadId,
    body: '全链路测试：请报一下含税价'
  }, { openid: FLOW.buyer })
  check('5. 会话消息投递成功', msgRes.ok, msgRes.ok ? '' : `${msgRes.code}: ${msgRes.message}`)
  check('5. 会话消息副本累计 4 条',
    (await repo.count('outbox', { 'payload.threadId': threadId })) === 4)

  /* 6. 管理员登录并接单 */
  const login = await adminRouter.dispatch('admin.login', {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
    otp: generateTotp(ADMIN_TOTP)
  }, { ip: '127.0.0.1' })
  if (!login.ok) fail('6. 管理员登录', login)
  const adminCtx = { token: (login.data && login.data.token) || '', ip: '127.0.0.1' }
  check('6. 管理员登录拿到会话', !!adminCtx.token)

  const leadList = await adminRouter.dispatch('lead.list', { limit: 50 }, adminCtx)
  const listed = leadList.ok && Array.isArray(leadList.data.items)
    ? leadList.data.items.some((row) => row.id === leadId)
    : false
  check('6. 管理端线索列表可见新线索', listed)

  const claimRes = await adminRouter.dispatch('lead.claim', { leadId }, adminCtx)
  check('6. 管理员领取线索', claimRes.ok, claimRes.ok ? '' : `${claimRes.code}: ${claimRes.message}`)
  const matched = await adminRouter.dispatch('lead.updateStatus', {
    leadId, to: LEAD_STATUS.MATCHED
  }, adminCtx)
  check('6. 线索流转到已对接', matched.ok, matched.ok ? '' : `${matched.code}: ${matched.message}`)

  /* 7. 管理员释放联系方式（公开主体） */
  const reveal = await adminRouter.dispatch('contact.reveal', {
    leadId, reason: '全链路测试：需要建群对接双方'
  }, adminCtx)
  const revealed = JSON.stringify(reveal.data || {})
  check('7. 公开主体可释放联系方式', reveal.ok && revealed.includes(FLOW.buyerPhone),
    reveal.ok ? '联系电话已返回' : `${reveal.code}: ${reveal.message}`)
  check('7. 释放动作写入审计与线索标记',
    (await repo.get('leads', leadId)).contactReleased === true &&
    (await repo.count('audit', { action: 'contact.reveal', target: leadId })) === 1)

  /* 8. 商机会员领取需求 */
  const bizList = await userRouter.dispatch('biz.list', {}, { openid: FLOW.biz })
  const seen = bizList.ok && Array.isArray(bizList.data.items)
    ? bizList.data.items.some((row) => row.id === demandId)
    : false
  check('8. 商机列表匹配到新需求', seen)
  const bizClaim = await userRouter.dispatch('biz.claim', {
    targetType: 'demand', demandId
  }, { openid: FLOW.biz })
  check('8. 商机会员领取成功并拿到联系方式',
    bizClaim.ok && bizClaim.data.contact && bizClaim.data.contact.phone === FLOW.sellerPhone,
    bizClaim.ok ? `claimCount=${bizClaim.data.claimCount}` : `${bizClaim.code}: ${bizClaim.message}`)
  check('8. 领取记录唯一', (await repo.count('bizClaims', { targetType: 'demand', targetId: demandId })) === 1)

  /* 9. 购买商机权限 → 财务确认开通 */
  const purchase = await userRouter.dispatch('biz.purchase', { planKey: 'month' }, { openid: FLOW.payer })
  if (!purchase.ok) fail('9. 提交会员购买', purchase)
  const paymentId = (purchase.data && purchase.data.paymentId) || ''
  const payment = await repo.get('payments', paymentId)
  check('9. 生成待确认收款单', !!payment && payment.status === '待确认', `paymentId=${paymentId}`)
  const confirm = await adminRouter.dispatch('payment.confirm', { id: paymentId }, adminCtx)
  check('9. 财务确认后自动开通会员', confirm.ok, confirm.ok ? '' : `${confirm.code}: ${confirm.message}`)
  const access = await repo.get('bizAccess', FLOW.payer)
  check('9. 会员权限落库为已开通', !!access && access.status === '已开通', `status=${access && access.status}`)

  /* 10. 私库存 */
  const stockRes = await userRouter.dispatch('stock.save', {
    id: '',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'H20 96G',
    cond: '全新',
    qty: 6,
    minQty: 1,
    price: 98000,
    city: '北京'
  }, { openid: FLOW.seller })
  check('10. 私库存保存成功', stockRes.ok, stockRes.ok ? '' : `${stockRes.code}: ${stockRes.message}`)
  check('10. 库存落库且归属于本人',
    (await repo.count('stocks', { ownerId: FLOW.seller, model: 'H20 96G' })) === 1)

  return checks
}

/* ------------------------------------------------------------------ */

async function main() {
  const repo = createMemoryRepo(buildSeed())
  /* 压测只用 L1：env 传空对象，避免本机 REDIS_URL 干扰结果 */
  const cache = createCache({ env: {}, now: () => Date.now() })
  const userRouter = createRouter({ repo, keys, scope: 'user', cache, env: {}, now: () => Date.now() })
  const adminRouter = createRouter({ repo, keys, scope: 'admin', cache, env: {}, now: () => Date.now() })

  const failures = []

  /* ---------- 全链路数据流转 ---------- */
  const checks = await runFlow(repo, userRouter, adminRouter)
  const flowFailed = checks.filter((item) => !item.ok)
  console.log(`\n  全链路 ${checks.length - flowFailed.length}/${checks.length} 项通过`)
  if (flowFailed.length) failures.push(`全链路（${flowFailed.map((i) => i.label).join('、')}）`)

  /* ---------- 高并发 ---------- */
  console.log('\n[高并发]')

  /* a) 50 个不同商机会员并发领取同一条需求 */
  const claimScenario = await runScenario('a) biz.claim 并发领取同一需求', BIZ_MEMBERS, (i) =>
    userRouter.dispatch('biz.claim', { targetType: 'demand', demandId: DEMAND_ID }, { openid: `o_biz_${i}` })
  )
  const claimed = await repo.count('bizClaims', { targetType: 'demand', targetId: DEMAND_ID })
  printResult(claimScenario, `领取记录 claimCount=${claimed}（期望 ${BIZ_MEMBERS}）`)
  if (claimScenario.failed > 0 || claimed !== BIZ_MEMBERS) failures.push('a) biz.claim')

  /* a2) 同一会员重复领取 20 次：幂等，只留一条记录 */
  const dupClaimScenario = await runScenario('a2) 同一会员并发重复领取', 20, () =>
    userRouter.dispatch('biz.claim', { targetType: 'demand', demandId: DEMAND_ID }, { openid: 'o_biz_0' })
  )
  const dupClaimed = await repo.count('bizClaims', { targetId: DEMAND_ID, uid: 'o_biz_0' })
  printResult(dupClaimScenario, `本人领取记录 ${dupClaimed} 条（期望 1）`)
  if (dupClaimScenario.failed > 0 || dupClaimed !== 1) failures.push('a2) 重复领取幂等')

  /* b) 100 个不同货主并发发布商品 */
  const publishScenario = await runScenario('b) product.publish 并发发布', PUBLISH_USERS, (i) =>
    userRouter.dispatch('product.publish', publishPayload(i), { openid: `o_pub_${i}` })
  )
  const published = await repo.count('products', { ownerId: { $regex: '^o_pub_' } })
    .catch(() => 0)
  printResult(publishScenario, `落库商品 ${published} 条`)
  if (publishScenario.failed > 0 || published !== PUBLISH_USERS) failures.push('b) product.publish')

  /* c) 200 并发读商品列表：全部应命中缓存 */
  const before = cache.stats()
  const listScenario = await runScenario('c) product.list 并发读缓存', LIST_CONCURRENCY, () =>
    userRouter.dispatch('product.list', { limit: 20 }, { openid: 'o_reader' })
  )
  const after = cache.stats()
  const hits = after.hits - before.hits
  const misses = after.misses - before.misses
  const hitRate = hits + misses > 0 ? hits / (hits + misses) : 0
  printResult(
    listScenario,
    `缓存命中 ${hits} / 未命中 ${misses} · 命中率 ${(hitRate * 100).toFixed(1)}%`
  )
  if (listScenario.failed > 0 || hitRate < 0.9) failures.push('c) product.list 缓存命中率')

  /* d) 50 并发在同一会话发消息 */
  const msgBefore = await repo.count('outbox', { 'payload.threadId': MSG_THREAD_ID })
  const msgScenario = await runScenario('d) msg.send 并发发消息', MSG_CONCURRENCY, (i) =>
    userRouter.dispatch('msg.send', { threadId: MSG_THREAD_ID, body: `并发压测消息 ${i}` }, { openid: 'o_buyer' })
  )
  const msgAfter = await repo.count('outbox', { 'payload.threadId': MSG_THREAD_ID })
  printResult(msgScenario, `新增消息副本 ${msgAfter - msgBefore} 条（期望 ${MSG_CONCURRENCY * 2}）`)
  if (msgScenario.failed > 0 || msgAfter - msgBefore !== MSG_CONCURRENCY * 2) failures.push('d) msg.send')

  /* e) 同一买家并发开会话：只能有一条线索、一份会话 */
  const chatScenario = await runScenario('e) chat.open 并发开会话', CHAT_CONCURRENCY, () =>
    userRouter.dispatch('chat.open', { productId: CHAT_PRODUCT_ID, conds: [] }, { openid: 'o_buyer' })
  )
  const chatLeads = await repo.find('leads', { uid: 'o_buyer', productId: CHAT_PRODUCT_ID }, { limit: 10 })
  const chatMessages = chatLeads.length
    ? await repo.count('outbox', { 'payload.threadId': chatLeads[0].id })
    : 0
  printResult(
    chatScenario,
    `线索 ${chatLeads.length} 条（期望 1）· 会话消息副本 ${chatMessages} 条（期望 2）`
  )
  if (chatScenario.failed > 0 || chatLeads.length !== 1 || chatMessages !== 2) failures.push('e) chat.open')

  /* f) 同一用户并发保存档案：只能有一条 profile */
  const profileScenario = await runScenario('f) profile.save 并发保存', PROFILE_CONCURRENCY, () =>
    userRouter.dispatch('profile.save', {
      subject: '并发档案测试',
      exposure: EXPOSURES.OPEN,
      phonePublic: true
    }, { openid: 'o_profiler' })
  )
  const profileRows = await repo.count('profiles', { uid: 'o_profiler' })
  printResult(profileScenario, `档案记录 ${profileRows} 条（期望 1）`)
  if (profileScenario.failed > 0 || profileRows !== 1) failures.push('f) profile.save')

  /* g) 同一用户并发提交会员购买：只能生成一张待确认单 */
  const purchaseScenario = await runScenario('g) biz.purchase 并发下单', PURCHASE_CONCURRENCY, () =>
    userRouter.dispatch('biz.purchase', { planKey: 'month' }, { openid: 'o_payer' })
  )
  const pendingPayments = await repo.count('payments', {
    uid: 'o_payer', bizType: '会员续费', status: '待确认'
  })
  printResult(purchaseScenario, `待确认收款单 ${pendingPayments} 张（期望 1）`)
  if (purchaseScenario.failed > 0 || pendingPayments !== 1) failures.push('g) biz.purchase')

  /* h) 同一用户并发咨询同一商品：去重后只留一条线索 */
  const consultScenario = await runScenario('h) consult.submit 并发去重', CONSULT_CONCURRENCY, () =>
    userRouter.dispatch('consult.submit', {
      productId: CONSULT_PRODUCT_ID,
      phone: '13700137000',
      conds: [],
      summary: '并发去重测试'
    }, { openid: 'o_reader' })
  )
  const consultLeads = await repo.count('leads', { uid: 'o_reader', productId: CONSULT_PRODUCT_ID })
  const consultSuccess = consultScenario.count - consultScenario.failed
  printResult(
    consultScenario,
    `线索 ${consultLeads} 条（期望 1）· 成功请求 ${consultSuccess} 个（期望 1）`
  )
  /* 重复请求按冲突返回属于预期，只要落库线索唯一且只有一次成功 */
  if (consultLeads !== 1 || consultSuccess !== 1) failures.push('h) consult.submit 去重')

  /* i) 同一管理员并发抢同一条线索：只能有一条领取审计 */
  const login = await adminRouter.dispatch('admin.login', {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
    otp: generateTotp(ADMIN_TOTP)
  }, { ip: '127.0.0.1' })
  const adminCtx = { token: (login.data && login.data.token) || '', ip: '127.0.0.1' }
  const adminClaimScenario = await runScenario('i) lead.claim 并发抢单', ADMIN_CLAIM_CONCURRENCY, () =>
    adminRouter.dispatch('lead.claim', { leadId: CLAIM_LEAD_ID }, adminCtx)
  )
  const claimAudits = await repo.count('audit', { action: 'lead.claim', target: CLAIM_LEAD_ID })
  printResult(adminClaimScenario, `领取审计 ${claimAudits} 条（期望 1）`)
  if (claimAudits !== 1) failures.push('i) lead.claim 抢占')

  console.log('\n' + '─'.repeat(56))
  if (failures.length) {
    /* 并发失败时把系统日志里的真实异常栈打出来，便于定位而不是只看 INTERNAL */
    const logs = await repo.find('systemLogs', {}, { limit: 5 })
    if (logs.length) {
      console.log('\n[系统错误日志]')
      logs.forEach((row) => {
        const detail = String(row.detail || '').split('\n').slice(0, 2).join(' | ')
        console.log(`  ${row.action}: ${detail || row.message}`)
      })
    }
    console.log(`压测未通过：${failures.join('、')}`)
    process.exitCode = 1
    return
  }
  console.log('全链路数据流转通过，9 个并发场景断言全部通过（去重 / 抢单场景里的冲突拒绝属于预期）')
}

main().catch((err) => {
  console.error('压测执行异常：', err)
  process.exitCode = 1
})
