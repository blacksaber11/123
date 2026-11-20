#!/usr/bin/env node
/**
 * 本地验证脚本：不依赖云环境，直接跑领域层与路由层。
 *
 * 覆盖红线（对应《平台整体逻辑设计 v3.2》9.6 的 10 条不达标不上线）：
 *   1. 字段级加密 + 盲索引，接口默认不返回明文手机号
 *   2. 越权：客服账号只能访问三页四动作，联系方式明文拿不到
 *   3. 限流：咨询 10 次 / 小时，登录 5 次 / 15 分钟
 *   4. 签名链接：过期 / 篡改 / 换人 / 换线索全部拒绝
 *   5. 状态机白名单 + 条件更新（CAS）
 *   6. 已对接唯一约束：同一商品同时只允许一条已对接
 *   7. 深分页截断：100 页封顶
 *   8. 交易方式隔离：租赁不落交易地与成色，出租 / 租赁字段完整
 *
 * 运行：node cloudbase/scripts/verify.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const shared = path.join(here, '..', 'shared')

const { createRouter } = require(path.join(shared, 'router.js'))
const { createMemoryRepo } = require(path.join(shared, 'repo.js'))
const { loadKeys, encryptField, decryptField, blindIndex, generateTotp, sha256Hex, userNoOf } = require(path.join(shared, 'crypto.js'))
const { verifyMaterialLink } = require(path.join(shared, 'files.js'))
const { buildProduct, buildDemand, judgeTier } = require(path.join(shared, 'domain.js'))
const { createCsEngine, monthKeyOf, CS_STATUS } = require(path.join(shared, 'cs.js'))
const { TICKET_STATE, closeIdleLeads } = require(path.join(shared, 'consultflow.js'))
const { DEMO_ADMIN_ACCOUNTS, TRADE_MODES, LEAD_STATUS, RATE_LIMITS, PRODUCT_STATUS, DEMAND_STATUS, VISIBILITIES } = require(path.join(shared, 'constants.js'))

let pass = 0
let fail = 0
const failures = []

function ok(cond, name, detail) {
  if (cond) {
    pass += 1
    console.log('  ✓ ' + name)
  } else {
    fail += 1
    failures.push(name + (detail ? ' → ' + detail : ''))
    console.log('  ✗ ' + name + (detail ? ' → ' + detail : ''))
  }
}

function section(title) {
  console.log('\n— ' + title)
}

/* 固定时间：便于断言过期行为 */
let CLOCK = Date.parse('2026-03-01T00:00:00Z')
const now = () => CLOCK

/* 固定密钥（仅本地验证用） */
const keys = loadKeys({
  AES_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
  HMAC_KEY_B64: Buffer.alloc(32, 9).toString('base64')
})

const repo = createMemoryRepo()
const userRouter = createRouter({ repo, keys, scope: 'user', now, env: {} })
const adminRouter = createRouter({ repo, keys, scope: 'admin', now, env: {} })

/* 对话总开关默认关闭（审核期间），线上需在管理端手动打开；
   本地用例默认按「已开放」运行，开关本身的关闭 / 恢复行为在设置章节单独验证 */
await repo.insert('settings', { id: 'site', chatEnabled: true })

/**
 * 发布类动作前置：未完成主体信息的账号先补一份完整主体。
 * 线上发布要求「主体名称 / 类型 / 类别 / 联系人 / 手机号」齐全（见 assertProfileReady），
 * 这里统一补默认值，避免每个用例重复写同一段 fixture；用例自己显式设置的主体不会被覆盖。
 */
const PUBLISH_ACTIONS = new Set([
  'product.publish', 'product.submit', 'product.edit', 'product.update',
  'demand.publish', 'demand.submit', 'demand.edit', 'demand.update',
  'agency.submit', 'agency.update', 'stock.save', 'stock.setStatus'
])
function readyPhoneOf(openid) {
  let sum = 7
  for (const ch of String(openid)) sum = (sum * 31 + ch.charCodeAt(0)) | 0
  return '138' + String(Math.abs(sum)).padStart(8, '0').slice(0, 8)
}

/** 补全发布必需的主体信息；profile.save 是整档保存，必须把原档案一起回传，避免把已填字段清空 */
async function ensureProfileReady(router, ctx) {
  const cur = await router.dispatch('profile.get', {}, ctx)
  const p = (cur && cur.ok && cur.data) || {}
  if (p.subject && p.subjectType && p.subjectKind && p.phoneMasked) return
  await router.dispatch('profile.save', {
    nick: p.nick || '',
    subject: p.subject || '验证用主体',
    subjectType: p.subjectType || '民企',
    subjectKind: p.subjectKind || 'company',
    contact: p.contact || '',
    position: p.position || '',
    city: p.city || '',
    realname: p.realname || '验证联系人',
    exposure: p.exposure || 'hidden',
    phone: p.phoneMasked ? undefined : readyPhoneOf(ctx.openid)
  }, ctx)
}

const beijingDateText = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
/* 默认截止时间：30 天后（北京时间），供代采 / 代售提交用例使用 */
const DEFAULT_AGENCY_DEADLINE = beijingDateText(Date.now() + 30 * 86400000)

const call = async (router, action, data, ctx) => {
  if (PUBLISH_ACTIONS.has(action) && ctx && ctx.openid) {
    await ensureProfileReady(router, ctx)
  }
  /* 代采 / 代售委托必须填写截止时间：默认补 30 天后的日期，负向用例显式传 deadline: '' */
  if (action === 'agency.submit' && data && !('deadline' in data)) {
    data = Object.assign({}, data, { deadline: DEFAULT_AGENCY_DEADLINE })
  }
  return router.dispatch(action, data, ctx)
}

/* 代采 / 代售未单独设置必须条件时的默认三条，与 market.js 的 AGENCY_MUST_DEFAULT 一致 */
const AGENCY_MUST_FOR_TEST = ['可按委托价格与数量成交', '可在截止时间前完成交付', '接受平台居中对接与订单核验']

/**
 * 领取商机：按发布方实际必须条件补齐 conds（服务端会逐项复核），用例无需重复书写。
 * 传 conds: false 时故意不带条件，用于验证服务端拦截。
 */
const claimOf = async (data, ctx) => {
  const ids = {
    demand: ['demands', data.demandId],
    supply: ['products', data.supplyId],
    agency: ['agencies', data.agencyId]
  }
  const entry = ids[data.targetType] || []
  const doc = entry[1] ? await repo.get(entry[0], entry[1]) : null
  const must = doc && Array.isArray(doc.must) && doc.must.length
    ? doc.must
    : (data.targetType === 'agency' ? AGENCY_MUST_FOR_TEST : [])
  const payload = Object.assign({}, data)
  if (payload.conds !== false) payload.conds = must
  else delete payload.conds
  return call(userRouter, 'biz.claim', payload, ctx)
}

const USER = { openid: 'o_user_0001', ip: '10.0.0.1' }
const USER2 = { openid: 'o_user_0002', ip: '10.0.0.2' }
const USER3 = { openid: 'o_user_0003', ip: '10.0.0.3' }
const OWNER = { openid: 'o_user_owner', ip: '10.0.0.4' }

/* ============================================================
   1. 加密与盲索引
   ============================================================ */
section('1. 字段级加密与盲索引')
{
  const cipher = encryptField({ keys, value: '13800138000', aad: 'users.phoneCipher.o_user_0001' })
  ok(!cipher.includes('13800138000'), '密文不含明文手机号')
  ok(cipher.startsWith('v1.'), '密文带版本前缀 v1')
  const bi1 = blindIndex({ keys, value: '13800138000' })
  const bi2 = blindIndex({ keys, value: '+86 138-0013-8000' })
  ok(bi1 === bi2, '盲索引对归一化后的同一号码一致')
  ok(bi1 !== blindIndex({ keys, value: '13800138001' }), '不同号码盲索引不同')
  ok(!bi1.includes('13800138000'), '盲索引不含明文')

  /* AAD 绑定：把 A 记录密文搬到 B 记录上必须失败 */
  const { decryptField } = require(path.join(shared, 'crypto.js'))
  let tampered = false
  try {
    decryptField({ keys, token: cipher, aad: 'users.phoneCipher.o_user_9999' })
  } catch (err) {
    tampered = true
  }
  ok(tampered, '密文换记录 id 后解密失败（AAD 绑定）')
}

/* ============================================================
   2. 登录与个人信息（明文永不返回）
   ============================================================ */
section('2. 登录、个人信息与保密')
{
  const r = await call(userRouter, 'auth.login', { nick: '张三' }, USER)
  ok(r.ok && r.data.uid === USER.openid, '登录按 openid 建档')
  ok(!JSON.stringify(r.data).includes('phoneCipher'), '登录响应不含密文字段')

  const r2 = await call(userRouter, 'profile.save', {
    nick: '张三',
    phone: '13800138000',
    realname: '张三',
    subject: '杭州云帆数据科技有限公司',
    subjectType: '民企',
    contact: '采购负责人',
    city: '杭州'
  }, USER)
  ok(r2.ok, '保存个人信息成功')
  ok(r2.data.phoneMasked === '138****8000', '手机号回显为脱敏值')
  ok(!JSON.stringify(r2.data).includes('13800138000'), '响应体不含明文手机号')

  const raw = await repo.get('users', USER.openid)
  ok(typeof raw.phoneCipher === 'string' && raw.phoneCipher.length > 20, '手机号以密文落库')
  ok(raw.phoneCipher.indexOf('13800138000') < 0, '落库密文不含明文')
  ok(typeof raw.phoneBidx === 'string' && raw.phoneBidx.startsWith('bi1.'), '落库含盲索引')
  const rawProfile = (await repo.find('profiles', { uid: USER.openid }))[0]
  ok(rawProfile.subject === null || rawProfile.subject === undefined, '主体名称不再以明文落库')
  ok(typeof rawProfile.subjectCipher === 'string' && rawProfile.subjectCipher.indexOf('杭州云帆数据科技有限公司') < 0, '主体名称以密文落库且密文不含明文')
  ok(typeof raw.realnameCipher === 'string' && raw.realnameCipher.indexOf('张三') < 0, '联系人姓名以密文落库且密文不含明文')
  ok(raw.realname === null || raw.realname === undefined, '联系人明文字段已清空')

  /* 公开范围：默认不公开主体，可切换为公开主体，并冗余到 users 供平台侧查看 */
  const expDefault = await call(userRouter, 'profile.save', { nick: '张三', phone: '13800138000', realname: '张三' }, USER)
  ok(expDefault.ok && expDefault.data.exposure === 'hidden', '未选择时公开范围默认「不公开主体」')
  /* 公开主体前提：主体名称 + 职位 / 身份，营业执照等原件可后补 */
  const expNoPos = await call(userRouter, 'profile.save', { nick: '张三', phone: '13800138000', realname: '张三', exposure: 'open' }, USER)
  ok(!expNoPos.ok && expNoPos.code === 'VALIDATION', '未填职位时不能切换为「公开主体」')
  const expOpen = await call(userRouter, 'profile.save', { nick: '张三', phone: '13800138000', realname: '张三', subject: '杭州云帆数据科技有限公司', position: '采购经理', exposure: 'open' }, USER)
  ok(expOpen.ok && expOpen.data.exposure === 'open' && expOpen.data.exposureLabel === '公开主体', '填好主体名称与职位后可切换为「公开主体」')
  const expRaw = (await repo.find('profiles', { uid: USER.openid }))[0]
  ok(expRaw.exposure === 'open', '公开范围落库')
  const userRawExp = await repo.get('users', USER.openid)
  ok(userRawExp.exposure === 'open', '公开范围冗余到 users，平台侧可直接看到隐藏状态')
  const expBad = await call(userRouter, 'profile.save', { nick: '张三', exposure: 'public' }, USER)
  ok(!expBad.ok && expBad.code === 'VALIDATION', '非法公开范围被拒绝')
  await call(userRouter, 'profile.save', { nick: '张三', phone: '13800138000', realname: '张三', exposure: 'hidden' }, USER)

  /* 手动填写手机号：微信快捷验证不可用时的兜底，只写号码、加密落库 */
  const manualBad = await call(userRouter, 'auth.phoneManual', { phone: '123' }, USER)
  ok(!manualBad.ok && manualBad.code === 'VALIDATION', '手填手机号：格式错误 → VALIDATION')
  const manual = await call(userRouter, 'auth.phoneManual', { phone: '13712345678' }, USER)
  ok(manual.ok && manual.data.hasPhone === true && manual.data.phoneMasked === '137****5678', '手填手机号：保存成功，只回脱敏值')
  ok(!JSON.stringify(manual.data).includes('13712345678'), '手填手机号响应不含明文')
  const manualRaw = await repo.get('users', USER.openid)
  ok(typeof manualRaw.phoneCipher === 'string' && manualRaw.phoneCipher.indexOf('13712345678') < 0, '手填手机号以密文落库')
  const manualAnon = await call(userRouter, 'auth.phoneManual', { phone: '13712345678' }, {})
  ok(!manualAnon.ok && manualAnon.code === 'UNAUTHENTICATED', '未登录手填手机号 → UNAUTHENTICATED')
  await call(userRouter, 'profile.save', { nick: '张三', phone: '13800138000', realname: '张三', exposure: 'hidden' }, USER)

  /* 发布页主体信息：个人档案为空时首次回填；已有主体时后续商品内修改不再回写 */
  const BOOT = { openid: 'o_user_boot', ip: '10.0.0.9' }
  await call(userRouter, 'auth.login', { nick: '首次发布用户' }, BOOT)
  const bootEmpty = await call(userRouter, 'profile.get', {}, BOOT)
  ok(bootEmpty.ok && !bootEmpty.data.subject, '未设置主体的新用户，个人档案主体为空')
  ok(/^U[2-9A-HJ-NP-Z]{8}$/.test(bootEmpty.data.userNo || ''), '用户端个人档案返回对外用户ID')
  const bootFirst = await call(userRouter, 'profile.bootstrapSubject', { subject: '杭州云帆数据科技有限公司' }, BOOT)
  ok(bootFirst.ok && bootFirst.data.updated === true, '首次发布商品的主体名称回填个人信息')
  const bootAfter = await call(userRouter, 'profile.get', {}, BOOT)
  ok(bootAfter.data.subject === '杭州云帆数据科技有限公司', '回填后个人信息可读到主体名称')
  const bootSecond = await call(userRouter, 'profile.bootstrapSubject', { subject: '另一家公司' }, BOOT)
  ok(bootSecond.ok && bootSecond.data.updated === false, '个人信息已有主体时不再回写')
  const bootFinal = await call(userRouter, 'profile.get', {}, BOOT)
  ok(bootFinal.data.subject === '杭州云帆数据科技有限公司', '后续商品内修改的主体名称不会覆盖个人信息')
}

/* ============================================================
   3. 发布商品：出售 / 出租字段隔离
   ============================================================ */
section('3. 发布商品：出售 / 出租')
let sellId = ''
let rentId = ''
{
  const sell = buildProduct({
    tradeMode: TRADE_MODES.SELL,
    title: 'H100 80G SXM 全新现货',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G SXM',
    qty: 8, minQty: 1, price: '248000', cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货', deliver: '3 天内',
    must: ['接受同台互验', '可提供采购意向函'], nego: ['价格可议'], flow: ['提交咨询', '线下看货']
  }, USER.openid, now())
  ok(sell.priceUnit === '¥ / 台', '出售单价口径为 ¥ / 台')
  ok(sell.currency === 'CNY' && sell.currencySymbol === '¥', '未选币种时默认人民币')
  ok(sell.city === '深圳' && sell.cond === '全新', '出售保留交易地与成色')
  ok(sell.deposit === '' && sell.pay === '', '出售不出现押金与租金支付字段')
  ok(sell.rentLimits.length === 0, '出售不出现租赁限制条款')

  const rent = buildProduct({
    tradeMode: TRADE_MODES.RENT,
    title: 'H100 80G SXM 整包出租',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G SXM',
    qty: 8, minQty: 1, rent: '18000',
    term: ['6 个月', '12 个月'], closed: '闭口价（不议价）',
    deposit: '1 个月租金', pay: '月付', supply: '现货', deliver: '当日可起租',
    tax: ['含税'],
    rentLimits: ['不得转租或二次转让', '需签署保密协议（NDA）'],
    must: ['接受同台互验', '不得转租或二次转让'], nego: ['租金可议'], flow: ['提交承租意向', '远程接入开通']
  }, USER.openid, now())
  ok(rent.priceUnit === '¥ / 台 / 月', '出租租金口径为 ¥ / 台 / 月')
  ok(rent.city === '' && rent.cond === '', '出租不落交易地与成色')
  ok(rent.term.length === 2, '出租保存租期选项')
  ok(rent.closed === '闭口价（不议价）', '出租保存是否闭口')
  ok(rent.deposit === '1 个月租金' && rent.pay === '月付', '出租保存押金与支付方式')
  ok(rent.rentLimits.length === 2, '出租保存租赁限制条款')

  /* 客户端伪造交易地与成色也必须被服务端丢弃 */
  const forged = buildProduct({
    tradeMode: TRADE_MODES.RENT,
    title: 'A100 长期出租', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 4, rent: '11500', term: ['12 个月'], closed: '开口价（可议价）',
    deposit: '免押金', pay: '季付', supply: '现货', tax: ['含税'],
    city: '北京', cond: '全新'
  }, USER.openid, now())
  ok(forged.city === '' && forged.cond === '', '出租场景服务端强制清空交易地与成色')

  /* 非法取值拒绝 */
  let rejected = false
  try {
    buildProduct({
      tradeMode: TRADE_MODES.RENT, title: '非法租期房源', cat: 'GPU 服务器',
      brand: 'NVIDIA', model: 'A100 80G', qty: 2, rent: '1000',
      term: ['99 年'], closed: '闭口价（不议价）', deposit: '免押金', pay: '月付',
      supply: '现货', tax: ['含税']
    }, USER.openid, now())
  } catch (err) {
    rejected = true
  }
  ok(rejected, '非法租期取值被拒绝')

  /* 金额格式校验 */
  let badAmount = false
  try {
    buildProduct({
      tradeMode: TRADE_MODES.SELL, title: '非法金额房源', cat: 'GPU 服务器',
      brand: 'NVIDIA', model: 'A100 80G', qty: 2, price: '24.8万',
      cond: '全新', tax: ['含税'], city: '深圳', supply: '现货'
    }, USER.openid, now())
  } catch (err) {
    badAmount = true
  }
  ok(badAmount, '金额含单位后被拒绝（只接受纯数字）')
}

/* ============================================================
   4. 发布需求：求购 / 租赁
   ============================================================ */
section('4. 发布需求：求购 / 租赁')
{
  const buy = buildDemand({
    tradeMode: TRADE_MODES.BUY,
    title: '训练集群扩容，需 64 台 H100',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G SXM',
    qty: 64, budget: '235000', tax: ['必须含税'], city: '广州',
    supply: '现货', sameMachine: true, codeAsk: true, cond: '可接受二手'
  }, USER.openid, now())
  ok(buy.budgetUnit === '¥ / 台', '求购预算口径为 ¥ / 台')
  ok(buy.city === '广州' && buy.cond === '可接受二手', '求购保留交易地与成色要求')
  ok(buy.must.includes('提供设备实拍图片'), '求购现货必须条件含实拍图片')
  ok(buy.must.includes('支持资金监管账户') === false, '求购现货不要求资金监管账户')

  const lease = buildDemand({
    tradeMode: TRADE_MODES.LEASE,
    title: '训练集群扩容，需租 32 台 H100',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G SXM',
    qty: 32, rent: '16000', term: ['6 个月'], closed: '接受闭口价',
    deposit: '接受 1 个月租金', pay: '月付', tax: ['必须含税'],
    supply: '现货', sameMachine: true, codeAsk: true
  }, USER.openid, now())
  ok(lease.budgetUnit === '¥ / 台 / 月', '租赁预算口径为 ¥ / 台 / 月')
  ok(lease.city === '' && lease.cond === '', '租赁不落交易地与成色要求')
  ok(lease.must.includes('明确租金 / 租期 / 押金条款'), '租赁必须条件固定含租金条款')
  ok(lease.must.includes('提供设备实拍视频'), '租赁现货必须条件含实拍视频')

  const leaseFuture = buildDemand({
    tradeMode: TRADE_MODES.LEASE,
    title: '期货租赁需求', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 16, rent: '10500', term: ['1 个月'], closed: '只接受可议价',
    deposit: '接受免押', pay: '季付', tax: ['含税'], supply: '期货'
  }, USER.openid, now())
  ok(leaseFuture.must.includes('支持租金资金监管账户'), '租赁期货必须条件含租金资金监管账户')
  ok(leaseFuture.must.includes('提供设备实拍图片') === false, '租赁期货不要求实拍图片')
}

/* ============================================================
   5. 咨询提交：必须条件、判档幂等、24h 去重
   ============================================================ */
section('5. 咨询提交与判档')
let leadId = ''
{
  /* 两个账号各完成登录与实名 */
  await call(userRouter, 'auth.login', { nick: '张三' }, USER)
  await call(userRouter, 'profile.save', { nick: '张三', realname: '张三', subject: '杭州云帆数据科技有限公司', position: '采购经理', exposure: 'open' }, USER)
  await call(userRouter, 'auth.login', { nick: '李四' }, USER2)
  await call(userRouter, 'profile.save', { nick: '李四', realname: '李四' }, USER2)
  await call(userRouter, 'auth.login', { nick: '王五' }, USER3)
  await call(userRouter, 'profile.save', { nick: '王五', realname: '王五' }, USER3)
  await call(userRouter, 'auth.login', { nick: '货主' }, OWNER)
  await call(userRouter, 'profile.save', { nick: '货主', realname: '货主' }, OWNER)

  /* 在售商品由货主账号发布（咨询人不能是自己） */
  const publish = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: 'H100 80G SXM 全新现货',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G SXM',
    qty: 8, minQty: 1, price: '248000', cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货', deliver: '3 天内',
    must: ['接受同台互验', '可提供采购意向函'], nego: [], flow: []
  }, OWNER)
  ok(publish.ok, '发布商品成功')
  sellId = publish.data.id
  ok(publish.data.status === PRODUCT_STATUS.ON_SALE, '发布后直接上架可见（审核不是前置路径）')

  /* 自己发布的商品 */
  const selfPublish = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: 'A100 80G 二手整批自用',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 4, minQty: 1, price: '118000', cond: '二手',
    tax: ['含税'], city: '北京', supply: '现货', deliver: '3 天内',
    must: [], nego: [], flow: [],
    syncStock: true
  }, USER)
  ok(selfPublish.ok, '发布自己的商品成功')
  const selfSellId = selfPublish.data.id
  ok(selfPublish.data.stockSynced === true, '勾选同步库存后商品写入私库存')
  const myStock = await call(userRouter, 'stock.list', {}, USER)
  ok(myStock.ok && myStock.data.items.some((s) => s.model === 'A100 80G'), '我的库存包含同步的货源')
  /* 发布即上架，无需审核 */

  /* 收藏 / 关注：云端保存，换手机可恢复 */
  const favOn = await call(userRouter, 'fav.set', { type: 'product', id: sellId, on: true }, USER3)
  ok(favOn.ok && favOn.data.on === true, '收藏商品成功')
  const favList = await call(userRouter, 'fav.list', {}, USER3)
  ok(favList.ok && favList.data.product.some((x) => x.id === sellId), '收藏列表包含刚收藏的商品')
  const favAgain = await call(userRouter, 'fav.set', { type: 'product', id: sellId, on: true }, USER3)
  ok(favAgain.ok, '重复收藏幂等（不报错）')
  const favRaw = await repo.find('favorites', { uid: USER3.openid }, { limit: 10 })
  ok(favRaw.filter((row) => row.targetId === sellId && !row.deleted).length === 1, '同一对象只落一行收藏')
  await call(userRouter, 'fav.set', { type: 'product', id: sellId, on: false }, USER3)
  const favAfter = await call(userRouter, 'fav.list', {}, USER3)
  ok(favAfter.ok && !favAfter.data.product.some((x) => x.id === sellId), '取消收藏后列表不再显示')
  /* 增量同步：客户端平时读本地缓存，只按 since 对账变化 */
  ok(favList.data.full === true && typeof favList.data.serverTime === 'number', '首次拉取为全量并下发服务端时间')
  const favDelta = await call(userRouter, 'fav.list', { since: favList.data.serverTime }, USER3)
  ok(favDelta.ok && favDelta.data.full === false, '带 since 时按增量返回')
  ok((favDelta.data.removed.product || []).indexOf(sellId) >= 0, '增量结果包含已取消的收藏 id')
  const favBad = await call(userRouter, 'fav.set', { type: 'product', id: 'no_such_product', on: true }, USER2)
  ok(!favBad.ok, '收藏不存在的对象被拒绝')
  const favBadType = await call(userRouter, 'fav.set', { type: 'user', id: sellId, on: true }, USER3)
  ok(!favBadType.ok, '非法收藏类型被拒绝')

  const det = await call(userRouter, 'product.detail', { id: sellId }, USER3)
  ok(det.ok && /^o_/.test(det.data.ownerKey || ''), '商品详情下发匿名货主键（非 openid）')
  ok(!JSON.stringify(det.data).includes(OWNER.openid), '详情不泄露货主 openid')
  const follow = await call(userRouter, 'follow.set', { id: det.data.ownerKey, nick: '某某科技', city: '深圳', on: true }, USER3)
  ok(follow.ok && follow.data.on === true, '关注货主成功')
  const followList = await call(userRouter, 'follow.list', {}, USER3)
  ok(followList.ok && followList.data.items.some((f) => f.id === det.data.ownerKey), '关注列表返回该货主')
  ok(!JSON.stringify(followList.data).includes(OWNER.openid), '关注列表不泄露货主 openid')
  const followBad = await call(userRouter, 'follow.set', { id: det.data.ownerKey, nick: '13800138000' }, USER3)
  ok(followBad.ok, '关注昵称可以直接填写联系方式（平台不拦截）')
  const unfollow = await call(userRouter, 'follow.set', { id: det.data.ownerKey, on: false }, USER3)
  ok(unfollow.ok && unfollow.data.on === false, '取消关注成功')

  /* 必须条件未全部满足 → 拒绝 */
  const bad = await call(userRouter, 'consult.submit', {
    productId: sellId,
    phone: '13800138000',
    conds: [{ k: '接受同台互验', satisfied: false }],
    summary: '需要 8 台 H100'
  }, USER)
  ok(!bad.ok && bad.code === 'VALIDATION', '必须条件未满足时拒绝提交')

  /* 正常提交（咨询人 = USER，货主 = USER2） */
  const good = await call(userRouter, 'consult.submit', {
    productId: sellId,
    phone: '13800138000',
    conds: [{ k: '接受同台互验', satisfied: true }, { k: '可提供采购意向函', satisfied: true }],
    summary: '需要 8 台 H100，预算 220000 元 / 台'
  }, USER)
  ok(good.ok, '必须条件全满足时提交成功')
  ok(good.data && !!good.data.leadId, '提交返回线索号')
  ok(!JSON.stringify(good.data).includes('P1') && !JSON.stringify(good.data).includes('档'), '回执不透露档位')
  ok(!JSON.stringify(good.data).includes('13800138000'), '回执不含明文手机号')
  ok(good.data.chatReady === true && !!good.data.threadId, '必须条件满足后自动开通直聊会话')
  leadId = good.data.leadId

  /* 直聊：双方可读可写，第三方不可见 */
  const thread1 = await call(userRouter, 'msg.thread', { threadId: leadId }, USER)
  ok(thread1.ok && thread1.data.items.length >= 1, '发起人可读取直聊会话')
  ok((thread1.data.items || []).every((it) => it.role === 'me'), '发起人视角首条消息为自己发出')
  const reply = await call(userRouter, 'msg.send', { threadId: leadId, body: '可以，先看一份检测报告' }, OWNER)
  ok(reply.ok, '货主可在会话中直接回复')
  const thread2 = await call(userRouter, 'msg.thread', { threadId: leadId }, USER)
  ok((thread2.data.items || []).some((it) => it.role === 'peer' && it.text.indexOf('检测报告') >= 0), '发起人能看到货主回复')
  const outsider = await call(userRouter, 'msg.thread', { threadId: leadId }, USER3)
  ok(!outsider.ok && outsider.code === 'FORBIDDEN', '非会话双方无法读取直聊内容')

  /* 24 小时内同一手机号 + 同一目标只建一条 */
  const dup = await call(userRouter, 'consult.submit', {
    productId: sellId,
    phone: '13800138000',
    conds: [{ k: '接受同台互验', satisfied: true }, { k: '可提供采购意向函', satisfied: true }],
    summary: '重复提交'
  }, USER)
  ok(!dup.ok && dup.code === 'CONFLICT', '24 小时内同一手机号对同一目标重复提交被拒')

  /* 文本里带手机号 → 允许，平台照常收单。
     用独立账号发起，避免覆盖 USER 已留存的手机号（后面 contact.reveal 依赖它） */
  const LEAKER = { openid: 'o_user_leak', ip: '10.0.0.11' }
  await call(userRouter, 'auth.login', { nick: '留号用户' }, LEAKER)
  await call(userRouter, 'profile.save', { nick: '留号用户' }, LEAKER)
  const leak = await call(userRouter, 'consult.submit', {
    productId: sellId,
    phone: '13700137000',
    conds: [{ k: '接受同台互验', satisfied: true }, { k: '可提供采购意向函', satisfied: true }],
    summary: '联系我 13700137000'
  }, LEAKER)
  ok(leak.ok, '需求说明中可以直接留手机号（平台不拦截）')

  /* 咨询自己发布的商品 → 拒绝 */
  const selfConsult = await call(userRouter, 'consult.submit', {
    productId: selfSellId,
    phone: '13800138000',
    conds: [{ k: '接受同台互验', satisfied: true }],
    summary: '咨询自己发布的商品'
  }, USER)
  ok(!selfConsult.ok, '咨询自己发布的商品被拒')
}

/* ============================================================
   6. 判档幂等与 P0 拦截
   ============================================================ */
section('6. 判档幂等与 P0 拦截')
{
  const rules = [
    { id: 'r_p0', name: '禁用词', tier: 'P0', enabled: true, version: 1, cond: { blockedWords: ['包过', '稳赚'] } },
    { id: 'r_p1', name: '材料不足', tier: 'P1', enabled: true, version: 1, cond: { requireMaterials: 2 } }
  ]
  const a = judgeTier({ rules, context: { text: '正常咨询内容', materialCount: 0, perDayCount: 1 } })
  const b = judgeTier({ rules, context: { text: '正常咨询内容', materialCount: 0, perDayCount: 1 } })
  ok(a.tier === b.tier && a.ruleVersion === b.ruleVersion, '同一规则快照 + 同一输入判档结果一致（幂等）')

  const c = judgeTier({ rules, context: { text: '保证包过，稳赚', materialCount: 0, perDayCount: 1 } })
  ok(c.tier === 'P0', '命中禁用词判为 P0')

  const d = judgeTier({ rules: [rules[1]], context: { text: '正常', materialCount: 0, perDayCount: 1 } })
  ok(d.tier === 'P1', '材料不足判为 P1')

  /* 规则版本变化后判档结果跟着变（可追溯） */
  const e = judgeTier({ rules: [{ ...rules[1], version: 2 }], context: { text: '正常', materialCount: 0, perDayCount: 1 } })
  ok(e.ruleVersion !== d.ruleVersion, '规则版本变化会体现在判档快照里')

  /* P0 线索：进已拦截箱、不计热度、不通知 */
  await repo.insert('rules', { id: 'r_p0', name: '禁用词', tier: 'P0', enabled: true, version: 1, scope: 'global', cond: { blockedWords: ['包过'] } })
  const blockedSubmit = await call(userRouter, 'consult.submit', {
    productId: sellId,
    phone: '13900139000',
    conds: [{ k: '接受同台互验', satisfied: true }, { k: '可提供采购意向函', satisfied: true }],
    summary: '保证包过'
  }, USER)
  ok(blockedSubmit.ok, 'P0 命中时仍返回中性回执（不暴露拦截）')
  const blockedLead = await repo.get('leads', blockedSubmit.data.leadId)
  ok(blockedLead.status === LEAD_STATUS.BLOCKED, 'P0 线索状态为已拦截')
  ok((await repo.find('blocked', { leadId: blockedSubmit.data.leadId })).length === 1, 'P0 线索进入已拦截箱')
  const heat = await repo.find('leads', { productId: sellId })
  const { countHeat } = require(path.join(shared, 'domain.js'))
  /* 热度只统计未被拦截的线索：本节前面还留有一条「说明带手机号」的正常线索 */
  const heatable = heat.filter((row) => row.status !== LEAD_STATUS.BLOCKED).length
  ok(countHeat(heat) === heatable, 'P0 拦截不计入咨询热度')
  const outbox = await repo.find('outbox', {})
  ok(outbox.every((m) => m.payload.leadId !== blockedSubmit.data.leadId), 'P0 线索不投递通知（outbox 无记录）')
}

/* ============================================================
   7. 管理端登录、MFA 与 RBAC
   ============================================================ */
section('7. 管理端 MFA 与 RBAC')
let adminToken = ''
{
  const demo = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'admin')
  const noOtp = await call(adminRouter, 'admin.login', { username: 'admin', password: demo.password }, {})
  ok(!noOtp.ok && noOtp.code === 'VALIDATION', '缺动态口令时登录被拒')

  const badOtp = await call(adminRouter, 'admin.login', {
    username: 'admin', password: demo.password, otp: '000000'
  }, {})
  ok(!badOtp.ok && badOtp.code === 'UNAUTHENTICATED', '动态口令错误时登录被拒')

  const badPass = await call(adminRouter, 'admin.login', {
    username: 'admin', password: 'wrong-password', otp: generateTotp(demo.totpSecret, now())
  }, {})
  ok(!badPass.ok && badPass.code === 'UNAUTHENTICATED', '口令错误时登录被拒')

  const login = await call(adminRouter, 'admin.login', {
    username: 'admin', password: demo.password, otp: generateTotp(demo.totpSecret, now())
  }, {})
  ok(login.ok && !!login.data.token, '口令 + 动态口令双因子登录成功')
  adminToken = login.data.token

  /* 未带 token */
  const noToken = await call(adminRouter, 'lead.list', {}, {})
  ok(!noToken.ok && noToken.code === 'UNAUTHENTICATED', '未带 token 访问被拒')

  /* 伪造 token */
  const badToken = await call(adminRouter, 'lead.list', {}, { token: 'forged-token' })
  ok(!badToken.ok && badToken.code === 'UNAUTHENTICATED', '伪造 token 被拒')

  /* 客服账号只能访问三页四动作 */
  const csDemo = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'cs')
  const csLogin = await call(adminRouter, 'admin.login', {
    username: 'cs', password: csDemo.password, otp: generateTotp(csDemo.totpSecret, now())
  }, {})
  ok(csLogin.ok, '客服账号登录成功')
  const csCtx = { token: csLogin.data.token }

  /* 带 token 自动登录时前端靠该接口刷新权限快照：必须带出两个新菜单页 */
  const csSession = await call(adminRouter, 'admin.session', {}, csCtx)
  ok(csSession.ok && csSession.data.pages.includes('consult') && csSession.data.pages.includes('cs'),
    '权限刷新接口带出咨询工单与客服业务页面',
    JSON.stringify(csSession.data && csSession.data.pages))

  const csList = await call(adminRouter, 'product.list', {}, csCtx)
  ok(csList.ok, '客服可访问商品池')
  const csDemand = await call(adminRouter, 'demand.list', {}, csCtx)
  ok(csDemand.ok, '客服可访问求购池')
  /* 四个模块的工单详情都要能对应到发布用户 */
  ok(csList.data.items.every((x) => !x.ownerId || (x.user && x.user.id === x.ownerId)),
    '商品池每条都带发布用户信息（可直接对应到用户）')
  ok(csList.data.items.every((x) => !x.user || /^U[2-9A-HJ-NP-Z]{8}$/.test(x.user.userNo)),
    '商品发布用户带对外用户ID')
  ok(csDemand.data.items.every((x) => !x.ownerId || (x.user && x.user.id === x.ownerId)),
    '求购池每条都带发布用户信息（可直接对应到用户）')
  const csLead = await call(adminRouter, 'lead.list', {}, csCtx)
  ok(csLead.ok, '客服可访问咨询单')

  const csStats = await call(adminRouter, 'stats.overview', {}, csCtx)
  ok(!csStats.ok && csStats.code === 'FORBIDDEN', '客服不再显示数据看板（访问概览被拒）')
  const csTrend = await call(adminRouter, 'stats.trend', {}, csCtx)
  ok(!csTrend.ok && csTrend.code === 'FORBIDDEN', '客服不再显示数据看板（访问趋势被拒）')
  const csBlocked = await call(adminRouter, 'blocked.list', {}, csCtx)
  ok(!csBlocked.ok && csBlocked.code === 'FORBIDDEN', '客服访问已拦截箱被拒（越权）')
  const csRules = await call(adminRouter, 'rules.list', {}, csCtx)
  ok(!csRules.ok && csRules.code === 'FORBIDDEN', '客服访问筛选规则被拒（越权）')
  const csAudit = await call(adminRouter, 'audit.list', {}, csCtx)
  ok(!csAudit.ok && csAudit.code === 'FORBIDDEN', '客服访问审计日志被拒（越权）')
  /* 客服领取后可推进工单直到成交；联系方式明文仍只归管理员释放 */
  const csStatus = await call(adminRouter, 'lead.updateStatus', { leadId, to: LEAD_STATUS.FOLLOWING }, csCtx)
  ok(csStatus.ok, '客服可推进咨询单状态（领取后跟进）')
  const csReveal = await call(adminRouter, 'contact.reveal', { leadId, reason: '需要联系对方' }, csCtx)
  ok(!csReveal.ok && csReveal.code === 'FORBIDDEN', '客服释放联系方式被拒（越权）')

  /* 发布即上架 / 上下架 / 需求关闭：发布即在售 → 下架 → 重新上架 */
  const published = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.RENT,
    title: '审核用例 A100 整包出租',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 4, minQty: 1, rent: '11500', term: ['6 个月'], closed: '闭口价（不议价）',
    deposit: '免押金', pay: '月付', supply: '现货', tax: ['含税'],
    must: ['接受同台互验'], nego: [], flow: []
  }, OWNER)
  ok(published.ok && published.data.status === PRODUCT_STATUS.ON_SALE, '新发布商品直接上架')
  const visibleAtOnce = await call(userRouter, 'product.detail', { id: published.data.id }, USER)
  ok(visibleAtOnce.ok, '发布后立即对外可见')
  const csReview = await call(adminRouter, 'product.review', { productId: published.data.id, decision: '通过' }, csCtx)
  ok(csReview.ok, '客服可审核商品（商品池一线运营权限）')
  /* 已在售的商品也可以审核（审核是可选处置，不是发布前置） */
  const reviewAgain = await call(adminRouter, 'product.review', { productId: published.data.id, decision: '通过' }, { token: adminToken })
  ok(reviewAgain.ok, '平台可在后台对已上架商品做审核处置')
  const offline = await call(adminRouter, 'product.offline', { productId: published.data.id, reason: '货主申请下架' }, { token: adminToken })
  ok(offline.ok && offline.data.to === PRODUCT_STATUS.OFFLINE, '在售商品可下架')
  const hiddenOffline = await call(userRouter, 'product.detail', { id: published.data.id }, USER)
  ok(!hiddenOffline.ok, '已下架商品对外不可见')
  const online = await call(adminRouter, 'product.online', { productId: published.data.id }, { token: adminToken })
  ok(online.ok && online.data.to === PRODUCT_STATUS.ON_SALE, '已下架商品可重新上架')

  /* 求购需求关闭 */
  const demandPub = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY,
    title: '审核用例：求购 A100',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 4, budget: '118000', tax: ['含税'], city: '北京', supply: '现货'
  }, OWNER)
  ok(demandPub.ok, '发布求购需求成功')
  const demandClosed = await call(adminRouter, 'demand.close', { demandId: demandPub.data.id, reason: '买方撤销需求' }, { token: adminToken })
  ok(demandClosed.ok && demandClosed.data.to === DEMAND_STATUS.CLOSED, '求购需求可关闭')

  /* 越权必须落审计 */
  const auditRows = await repo.find('audit', { action: 'lead.updateStatus' })
  ok(auditRows.length >= 1, '越权尝试已写入审计日志')
}

/* ============================================================
   8. 联系方式释放的四重约束
   ============================================================ */
section('8. 联系方式释放')
{
  /* 未对接 → 拒绝 */
  const tooEarly = await call(adminRouter, 'contact.reveal', { leadId, reason: '需要联系对方' }, { token: adminToken })
  ok(!tooEarly.ok && tooEarly.code === 'CONFLICT', '未对接时释放联系方式被拒')

  /* 原因太短 → 拒绝 */
  await repo.updateWhere('leads', { id: leadId }, { status: LEAD_STATUS.MATCHED })
  const shortReason = await call(adminRouter, 'contact.reveal', { leadId, reason: '看' }, { token: adminToken })
  ok(!shortReason.ok && shortReason.code === 'VALIDATION', '释放原因少于 5 字被拒')

  /* 正常释放 */
  const reveal = await call(adminRouter, 'contact.reveal', { leadId, reason: '建群需要邀请对方' }, { token: adminToken })
  ok(reveal.ok && reveal.data.phone === '13800138000', '已对接 + 原因充足时返回明文手机号')
  const revealAudit = await repo.find('audit', { action: 'contact.reveal' })
  ok(revealAudit.length >= 1, '释放联系方式已写审计')
  ok(revealAudit.some((a) => a.result === 'allow'), '审计记录了放行结果')
  ok(revealAudit.every((a) => !String(a.reason).includes('13800138000')), '审计原因不含明文手机号')

  /* 双方联系：按 uid 明确查看咨询方 / 发布方，非本单关联方一律拒绝 */
  const revealConsult = await call(adminRouter, 'contact.reveal', {
    leadId, uid: USER.openid, reason: '联系咨询方确认需求'
  }, { token: adminToken })
  ok(revealConsult.ok && revealConsult.data.side === '咨询方' && revealConsult.data.uid === USER.openid,
    '按 uid 释放咨询方联系方式并标明身份')
  const strangerReveal = await call(adminRouter, 'contact.reveal', {
    leadId, uid: USER3.openid, reason: '测试越权查人'
  }, { token: adminToken })
  ok(!strangerReveal.ok && strangerReveal.code === 'VALIDATION', '非本单关联方禁止按 uid 释放联系方式')

  /* 双方条件核对：咨询方与发布方必须分开，且带出发布方的委托条件 */
  const leadDetail = await call(adminRouter, 'lead.detail', { leadId: leadId }, { token: adminToken })
  ok(leadDetail.ok && leadDetail.data.consultUser && leadDetail.data.consultUser.id === USER.openid,
    '咨询单详情把发起咨询的用户识别为咨询方')
  ok(leadDetail.ok && leadDetail.data.publisherUser && leadDetail.data.publisherUser.id === OWNER.openid,
    '咨询单详情把商品货主识别为发布方')
  ok(leadDetail.ok && leadDetail.data.publisherSide && leadDetail.data.publisherSide.type === '商品',
    '咨询单详情返回发布方的委托条件')
  ok(leadDetail.ok && leadDetail.data.satisfaction && leadDetail.data.satisfaction.total >= 1
    && leadDetail.data.satisfaction.met >= 1,
    '咨询单详情统计双方条件满足情况')

  /* 不公开主体：平台不代转联系方式，即使已对接也拒绝 */
  const hiddenTarget = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: 'A100 80G 隐藏主体验证',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 2, minQty: 1, price: '118000', cond: '二手',
    tax: ['含税'], city: '北京', supply: '现货',
    must: [], nego: [], flow: []
  }, USER)
  ok(hiddenTarget.ok, '隐藏主体验证用商品发布成功')
  const hiddenConsult = await call(userRouter, 'consult.submit', {
    productId: hiddenTarget.data.id, phone: '13700137000', conds: [],
    summary: '不公开主体验证：想了解这批卡'
  }, USER2)
  ok(hiddenConsult.ok, '不公开主体仍可提交咨询、走站内会话', hiddenConsult.code + ': ' + hiddenConsult.message)
  const hiddenLeadId = hiddenConsult.data.leadId
  await repo.updateWhere('leads', { id: hiddenLeadId }, { status: LEAD_STATUS.MATCHED })
  const hiddenReveal = await call(adminRouter, 'contact.reveal', {
    leadId: hiddenLeadId, reason: '建群需要邀请对方'
  }, { token: adminToken })
  ok(!hiddenReveal.ok && hiddenReveal.code === 'CONFLICT', '不公开主体的线索不能释放联系方式')
  ok(String(hiddenReveal.message || '').includes('不公开主体'), '拒绝原因说明平台不代转、仅站内沟通')

  /* 列表与详情永远不含明文 */
  const products = await call(userRouter, 'product.list', {}, USER)
  ok(!JSON.stringify(products.data).includes('13800138000'), '商品列表不含明文手机号')
  const detail = await call(userRouter, 'product.detail', { id: sellId }, USER)
  ok(!JSON.stringify(detail.data).includes('13800138000'), '商品详情不含明文手机号')
  const leads = await call(adminRouter, 'lead.list', {}, { token: adminToken })
  ok(leads.ok, '管理端线索列表正常返回，允许展示用户留下的联系方式')
}

/* ============================================================
   9. 状态机白名单与 CAS
   ============================================================ */
section('9. 状态机与唯一约束')
{
  const bad = await call(adminRouter, 'lead.updateStatus', { leadId, to: LEAD_STATUS.PENDING }, { token: adminToken })
  ok(!bad.ok && bad.code === 'CONFLICT', '已对接不可回退到待分配')

  const forward = await call(adminRouter, 'lead.updateStatus', {
    leadId, to: LEAD_STATUS.DEALT, reason: '双方线下确认成交'
  }, { token: adminToken })
  ok(forward.ok && forward.data.from === LEAD_STATUS.MATCHED, '已对接 → 已成交 允许')

  /* 同一商品同时只允许一条占用中的线索（另起一个商品，避免与上面的已成交冲突） */
  const publish2 = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: 'A100 80G 二手整批',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 12, minQty: 2, price: '118000', cond: '二手',
    tax: ['含税'], city: '北京', supply: '现货', deliver: '3 天内',
    must: ['接受同台互验', '可提供采购意向函'], nego: [], flow: []
  }, OWNER)
  const sell2Id = publish2.data && publish2.data.id
  ok(!!sell2Id, '第二个商品发布成功（用于唯一占用校验）')
  await repo.updateWhere('products', { id: sell2Id }, { status: PRODUCT_STATUS.ON_SALE })

  const second = await call(userRouter, 'consult.submit', {
    productId: sell2Id,
    phone: '13700137000',
    conds: [{ k: '接受同台互验', satisfied: true }, { k: '可提供采购意向函', satisfied: true }],
    summary: '第二位咨询人'
  }, USER2)
  ok(second.ok, '第二位咨询人可提交咨询')

  /* 第二条线索按状态机推进：待分配 → 跟进中 → 已对接 */
  const toFollowing = await call(adminRouter, 'lead.updateStatus', {
    leadId: second.data.leadId, to: LEAD_STATUS.FOLLOWING, reason: '坐席首响'
  }, { token: adminToken })
  ok(toFollowing.ok, '待分配 → 跟进中 允许')
  const secondMatched = await call(adminRouter, 'lead.updateStatus', {
    leadId: second.data.leadId, to: LEAD_STATUS.MATCHED, reason: '建群成功'
  }, { token: adminToken })
  ok(secondMatched.ok, '跟进中 → 已对接 允许（此时无其他占用线索）')

  /* 已对接后商品自动转「洽谈中」，同商品再咨询必须拒绝 */
  const negotiated = await repo.get('products', sell2Id)
  ok(negotiated.status === PRODUCT_STATUS.NEGOTIATING, '线索已对接后商品自动转「洽谈中」')
  const thirdOnMatched = await call(userRouter, 'consult.submit', {
    productId: sell2Id,
    phone: '13600136000',
    conds: [{ k: '接受同台互验', satisfied: true }, { k: '可提供采购意向函', satisfied: true }],
    summary: '洽谈中仍咨询'
  }, USER3)
  ok(!thirdOnMatched.ok && thirdOnMatched.code === 'CONFLICT', '洽谈中商品不可再发起咨询')

  /* 唯一约束：新商品上两条线索，其一已对接后另一条不能再对接 */
  const publish3 = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: 'A100 80G 整批（唯一约束用例）',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 8, minQty: 1, price: '118000', cond: '二手',
    tax: ['含税'], city: '北京', supply: '现货', deliver: '3 天内',
    must: ['接受同台互验', '可提供采购意向函'], nego: [], flow: []
  }, OWNER)
  const sell3Id = publish3.data.id
  await repo.updateWhere('products', { id: sell3Id }, { status: PRODUCT_STATUS.ON_SALE })
  const fourth = await call(userRouter, 'consult.submit', {
    productId: sell3Id,
    phone: '13700137000',
    conds: [{ k: '接受同台互验', satisfied: true }, { k: '可提供采购意向函', satisfied: true }],
    summary: '第四条线索'
  }, USER2)
  ok(fourth.ok, '第四条线索可提交')
  const third = await call(userRouter, 'consult.submit', {
    productId: sell3Id,
    phone: '13600136000',
    conds: [{ k: '接受同台互验', satisfied: true }, { k: '可提供采购意向函', satisfied: true }],
    summary: '第三位咨询人'
  }, USER3)
  ok(third.ok, '第三位咨询人可提交咨询')
  await call(adminRouter, 'lead.updateStatus', {
    leadId: fourth.data.leadId, to: LEAD_STATUS.FOLLOWING, reason: '坐席首响'
  }, { token: adminToken })
  const fourthMatched = await call(adminRouter, 'lead.updateStatus', {
    leadId: fourth.data.leadId, to: LEAD_STATUS.MATCHED, reason: '建群成功'
  }, { token: adminToken })
  ok(fourthMatched.ok, '第四条线索对接成功')
  const thirdFollow = await call(adminRouter, 'lead.updateStatus', {
    leadId: third.data.leadId, to: LEAD_STATUS.FOLLOWING, reason: '坐席首响'
  }, { token: adminToken })
  ok(thirdFollow.ok, '第三条线索可转跟进中')
  const cas = await call(adminRouter, 'lead.updateStatus', {
    leadId: third.data.leadId, to: LEAD_STATUS.MATCHED, reason: '并发建群'
  }, { token: adminToken })
  ok(!cas.ok && cas.code === 'CONFLICT', '同一商品已有占用线索时再建群被拒（唯一约束）')

  /* CAS：基于过期状态更新返回 count=0 */
  const stale = await repo.updateWhere('leads', { id: leadId, status: LEAD_STATUS.PENDING }, { assignedTo: 'x' })
  ok(stale.count === 0, 'CAS：状态不匹配时不更新')
}

/* ============================================================
   10. 材料签名链接：过期 / 篡改 / 换人
   ============================================================ */
section('10. 材料签名链接与水印')
{
  const fileId = 'cloud://env-abc/materials/o_user_0001/1700000000_a1b2c3_license.pdf'
  const sign = await call(userRouter, 'material.sign', {
    fileId, leadId, name: '营业执照.pdf', size: 102400, type: 'application/pdf'
  }, USER)
  ok(sign.ok, '材料签名成功')
  ok(sign.data.expiresIn === 300, '签名链接有效期 5 分钟')
  ok(sign.data.allowDownload === false && sign.data.allowSave === false, '契约声明禁止下载与保存')
  ok(sign.data.watermarkRequired === true && sign.data.screenshotGuard === true, '契约声明带水印并拦截截屏')
  ok(/禁止转发/.test(sign.data.watermark), '水印文案含查看人与时间')

  /* 过期 */
  let expiredRejected = false
  try {
    verifyMaterialLink({ keys, url: sign.data.url, uid: USER.openid, leadId, now: CLOCK + 6 * 60 * 1000 })
  } catch (err) {
    expiredRejected = err.code === 'EXPIRED'
  }
  ok(expiredRejected, '超过 5 分钟后链接失效')

  /* 未过期时可校验 */
  const valid = verifyMaterialLink({ keys, url: sign.data.url, uid: USER.openid, leadId, now: CLOCK + 60 * 1000 })
  ok(valid.fileId && valid.uid === USER.openid, '有效期内链接校验通过')

  /* 换人 */
  let otherUser = false
  try {
    verifyMaterialLink({ keys, url: sign.data.url, uid: 'o_other', leadId, now: CLOCK + 1000 })
  } catch (err) {
    otherUser = err.code === 'FORBIDDEN'
  }
  ok(otherUser, '链接换人访问被拒')

  /* 换线索 */
  let otherLead = false
  try {
    verifyMaterialLink({ keys, url: sign.data.url, uid: USER.openid, leadId: 'L-other', now: CLOCK + 1000 })
  } catch (err) {
    otherLead = err.code === 'FORBIDDEN'
  }
  ok(otherLead, '链接换线索访问被拒')

  /* 篡改签名 */
  let tampered = false
  try {
    verifyMaterialLink({ keys, url: sign.data.url.replace(/sig=[^&]+/, 'sig=deadbeef'), uid: USER.openid, leadId, now: CLOCK + 1000 })
  } catch (err) {
    tampered = err.code === 'TAMPERED'
  }
  ok(tampered, '签名被篡改时校验失败')

  /* 别人的路径 */
  const otherPath = await call(userRouter, 'material.sign', {
    fileId: 'cloud://env-abc/materials/o_someone_else/1700000000_a1b2c3_license.pdf',
    leadId, name: 'x.pdf', size: 100, type: 'application/pdf'
  }, USER)
  ok(!otherPath.ok && otherPath.code === 'FORBIDDEN', '访问他人目录的材料被拒')

  /* 非法类型 */
  const badType = await call(userRouter, 'material.sign', {
    fileId: 'cloud://env-abc/materials/o_user_0001/1700000000_a1b2c3_x.svg',
    leadId, name: 'x.svg', size: 100, type: 'image/svg+xml'
  }, USER)
  ok(!badType.ok && badType.code === 'VALIDATION', 'SVG 等危险类型被拒')
}

/* ============================================================
   11. 限流
   ============================================================ */
section('11. 限流')
{
  /* 材料签名 60 次 / 小时 → 累计第 61 次触发限流（前面已用过 3 次） */
  const limiter = createRouter({ repo, keys, scope: 'user', now, env: {} })
  const { peek } = require(path.join(shared, 'ratelimit.js'))
  const usedBefore = await peek(repo, { key: 'material:' + USER.openid, now: CLOCK, windowMs: RATE_LIMITS.materialSign.windowMs })
  let limited = false
  let calls = 0
  for (let i = 0; i < 80; i += 1) {
    calls += 1
    const r = await call(limiter, 'material.sign', {
      fileId: `cloud://env-abc/materials/o_user_0001/170000000${i}_a1b2c3_license.pdf`,
      leadId, name: 'x.pdf', size: 100, type: 'application/pdf'
    }, USER)
    if (!r.ok && r.code === 'RATE_LIMITED') {
      limited = true
      break
    }
  }
  ok(limited, '材料签名超过 60 次/小时后触发限流')
  ok(usedBefore + calls === 61, '限流在窗口内累计第 61 次触发（前面已用 ' + usedBefore + ' 次，本次 ' + calls + ' 次）')

  /* 窗口滚动后恢复 */
  CLOCK += 61 * 60 * 1000
  const after = await call(limiter, 'material.sign', {
    fileId: 'cloud://env-abc/materials/o_user_0001/1700000009_a1b2c3_license.pdf',
    leadId, name: 'x.pdf', size: 100, type: 'application/pdf'
  }, USER)
  ok(after.ok, '窗口滚动后限流解除')

  /* 代采代售对接 10 次 / 小时：每次都会写咨询消息与材料，超限必须拦截 */
  let bizLimited = false
  let bizCalls = 0
  for (let i = 0; i < 14; i += 1) {
    bizCalls += 1
    const r = await call(limiter, 'biz.consult', { agencyId: 'AG-not-exist' }, USER)
    if (!r.ok && r.code === 'RATE_LIMITED') {
      bizLimited = true
      break
    }
  }
  ok(bizLimited && bizCalls === 11, '代采代售对接超过 10 次/小时后触发限流', `calls=${bizCalls}`)
}

/* ============================================================
   12. 深分页截断
   ============================================================ */
section('12. 深分页与列表防护')
{
  const deep = await call(userRouter, 'product.list', { page: 500, limit: 10 }, USER)
  ok(deep.ok && deep.data.truncated === true, '超过 100 页的请求被截断')
  ok(deep.data.items.length === 0, '被截断的请求不返回数据')
}

/* ============================================================
   13. 审计不可篡改
   ============================================================ */
section('13. 审计不可篡改')
{
  let rejected = false
  try {
    await repo.updateWhere('audit', { id: 'any' }, { action: 'tampered' })
  } catch (err) {
    rejected = err.code === 'FORBIDDEN'
  }
  ok(rejected, '审计日志拒绝修改')

  const auditList = await call(adminRouter, 'audit.list', {}, { token: adminToken })
  ok(auditList.ok && auditList.data.items.length > 0, '管理员可查询审计日志')
  ok(auditList.data.retentionDays >= 180, '审计保留期 ≥ 6 个月')
  ok(!JSON.stringify(auditList.data).includes('13800138000'), '审计日志不含明文手机号')
}

/* ============================================================
   13·1 行为数据中心：截屏上报 → 管理端可查
   ============================================================ */
section('13·1 行为数据中心')
{
  const rep = await call(userRouter, 'behavior.report', { kind: 'screenshot', page: 'pages/product/detail' }, USER)
  ok(rep.ok, '客户端截屏行为上报成功')

  const bad = await call(userRouter, 'behavior.report', { kind: 'unknown_kind', page: 'x' }, USER)
  ok(!bad.ok && bad.code === 'VALIDATION', '非法行为类型被拒绝')

  const beh = await call(adminRouter, 'behavior.list', { category: 'capture', days: 7 }, { token: adminToken })
  ok(beh.ok && beh.data.items.length >= 1, '管理端行为中心可查到截屏记录')
  ok(beh.data.items.some((it) => it.category === 'capture' && /截屏/.test(it.title)), '截屏记录归类正确且标题可读')
  ok(beh.data.summary && beh.data.summary.capture >= 1, '分类统计包含截屏数量')
  ok(!JSON.stringify(beh.data).includes('o_user_0001'), '行为记录对外只给匿名用户标识，不暴露 openid 原文')
}

/* ============================================================
   14. 未登录与越权边界
   ============================================================ */
section('14. 未登录与越权边界')
{
  const anon = await call(userRouter, 'profile.get', {}, {})
  ok(!anon.ok && anon.code === 'UNAUTHENTICATED', '未登录访问个人信息被拒')
  const anon2 = await call(userRouter, 'consult.submit', { productId: sellId }, {})
  ok(!anon2.ok && anon2.code === 'UNAUTHENTICATED', '未登录提交咨询被拒')
  const noop = await call(userRouter, 'not.exist.action', {}, USER)
  ok(!noop.ok && noop.code === 'NOT_FOUND', '不存在的接口返回 NOT_FOUND')
  const selfConsult = await call(userRouter, 'consult.submit', {
    productId: sellId,
    phone: '13800138000',
    conds: [{ k: '接受同台互验', satisfied: true }],
    summary: '咨询自己发布的商品'
  }, USER)
  ok(!selfConsult.ok, '咨询自己发布的商品被拒')
}

/* ============================================================
   15. 出站字段保护
   ============================================================ */
section('15. 出站字段保护')
{
  const { assertNoPlaintextContact } = require(path.join(shared, 'projection.js'))
  let plainOk = true
  try {
    assertNoPlaintextContact({ items: [{ phone: '13800138000' }] })
  } catch (err) {
    plainOk = false
  }
  ok(plainOk, '用户填写的明文手机号可以正常出站（平台不拦截）')

  let cipherLeak = false
  try {
    assertNoPlaintextContact({ item: { phoneCipher: 'v1.xxx' } })
  } catch (err) {
    cipherLeak = err.code === 'INTERNAL'
  }
  ok(cipherLeak, '响应体出现密文字段时拒绝出站')
}

/* ============================================================
   16. 前端手机号校验与云函数同口径（防「合法号码被前端误拦截」回归）
   ============================================================ */
section('16. 前端手机号校验口径')
{
  const { normalizePhone, isValidPhone, phoneError } = require(path.join(here, '..', 'miniprogram', 'utils', 'validate.js'))
  /* 带分隔符 / 全角 / +86 前缀的写法都是用户真实会输入的，必须判为合法；
     粘贴带零宽字符或夹带「手机：」字样的号码同样不能误拦截 */
  const accepted = ['13800138000', '138 0013 8000', '138-0013-8000', '(138)0013-8000',
    '+8613800138000', '008613800138000', '8613800138000', '１３８００１３８０００',
    '13800138000\u200b', '手机：13800138000']
  accepted.forEach((raw) => {
    ok(isValidPhone(raw) && normalizePhone(raw) === '13800138000', `前端接受合法号码：${raw}`)
  })
  const rejected = ['1380013800', '23800138000', '12800138000', '138001380001', '']
  rejected.forEach((raw) => {
    ok(!isValidPhone(raw), `前端拒绝非法号码：${raw || '(空)'}`)
  })
  /* 报错要指出问题（位数 / 脱敏号），不能只说「请填写 11 位」 */
  ok(phoneError('1380013800') === '手机号需 11 位数字，当前 10 位，请检查', '位数不足时提示当前位数')
  ok(phoneError('138****6688').indexOf('脱敏') > -1, '填了脱敏号码时明确提示')
}

/* ============================================================
   17. 起订量归属与发布媒体校验
   ============================================================ */
section('17. 起订量归属与发布媒体校验')
{
  const baseSell = {
    tradeMode: TRADE_MODES.SELL, title: '媒体校验用商品', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H100 80G SXM', qty: 8, price: '248000',
    cond: '全新', tax: ['含税'], city: '深圳', supply: '现货'
  }
  const baseDemand = {
    tradeMode: TRADE_MODES.BUY, title: '媒体校验用需求', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H100 80G SXM', qty: 64, budget: '235000',
    tax: ['必须含税'], city: '广州', supply: '现货', cond: '可接受二手'
  }

  /* 起订量只属于供给方：需求侧只落明确需求量，客户端伪造的 minQty 被忽略 */
  const demand = buildDemand({ ...baseDemand, minQty: 10 }, USER.openid, now())
  ok(demand.minQty === undefined, '需求侧不落 minQty（伪造字段被忽略）')
  ok(demand.qty === 64, '需求侧只保留明确需求量')
  ok(buildProduct({ ...baseSell, minQty: 2 }, USER.openid, now()).minQty === 2, '供给方保留起订量')
  ok(buildProduct(baseSell, USER.openid, now()).minQty === 1, '供给方未填起订量时默认 1')
  ok(Array.isArray(demand.media) && demand.media.length === 0, '未上传媒体时 media 为空数组')

  const img = (i) => ({ name: '营业执照 ' + i + '.png', type: 'image/png', size: 1.2 * 1024 * 1024 })
  const vid = (i) => ({ name: '验资视频 ' + i + '.mp4', type: 'video/mp4', size: 20 * 1024 * 1024 })
  const codeOf = (fn) => {
    try { fn(); return '' } catch (err) { return err.code }
  }

  const full = buildDemand({
    ...baseDemand,
    media: [img(1), img(2), img(3), img(4), img(5), vid(1), vid(2), vid(3)]
  }, USER.openid, now())
  ok(full.media.length === 8, '5 张图片 + 3 段视频全部接收')
  ok(full.media.filter((m) => m.kind === 'video').length === 3, '视频分组计数为 3')
  ok(full.media[0].size === Math.floor(1.2 * 1024 * 1024), '文件大小取整后落库')

  ok(codeOf(() => buildDemand({ ...baseDemand, media: [img(1), img(2), img(3), img(4), img(5), img(6)] }, USER.openid, now())) === 'VALIDATION', '第 6 张图片被拒绝')
  ok(codeOf(() => buildDemand({ ...baseDemand, media: [img(1), img(2), img(3), img(4), img(5), { name: '资质.pdf', type: 'application/pdf', size: 1024 }] }, USER.openid, now())) === 'VALIDATION', 'PDF 计入图片分组（第 6 个被拒绝）')
  ok(codeOf(() => buildDemand({ ...baseDemand, media: [vid(1), vid(2), vid(3), vid(4)] }, USER.openid, now())) === 'VALIDATION', '第 4 段视频被拒绝')
  /* 大小上限按手机常规拍摄体量：图片 10MB、视频 50MB、文档 20MB */
  ok(codeOf(() => buildProduct({ ...baseSell, media: [{ name: '大图.jpg', type: 'image/jpeg', size: 11 * 1024 * 1024 }] }, USER.openid, now())) === 'VALIDATION', '单张图片超过 10MB 被拒绝')
  ok(buildProduct({ ...baseSell, media: [{ name: '手机直出.jpg', type: 'image/jpeg', size: 8 * 1024 * 1024 }] }, USER.openid, now()).media.length === 1, '8MB 手机直出照片可上传')
  ok(codeOf(() => buildProduct({ ...baseSell, media: [{ name: '长视频.mp4', type: 'video/mp4', size: 51 * 1024 * 1024 }] }, USER.openid, now())) === 'VALIDATION', '单段视频超过 50MB 被拒绝')
  ok(buildProduct({ ...baseSell, media: [{ name: '手机视频.mp4', type: 'video/mp4', size: 40 * 1024 * 1024 }] }, USER.openid, now()).media.length === 1, '40MB 手机视频可上传')
  ok(buildProduct({ ...baseSell, media: [{ name: 'iPhone 拍摄.mov', type: 'video/quicktime', size: 20 * 1024 * 1024 }] }, USER.openid, now()).media.length === 1, 'MOV 视频可上传')
  ok(buildProduct({ ...baseSell, media: [{ name: '安卓导出.m4v', type: 'video/x-m4v', size: 20 * 1024 * 1024 }] }, USER.openid, now()).media.length === 1, 'M4V 视频可上传')
  ok(codeOf(() => buildProduct({ ...baseSell, media: [{ name: '矢量.svg', type: 'image/svg+xml', size: 1024 }] }, USER.openid, now())) === 'VALIDATION', '非白名单格式被拒绝')
  ok(codeOf(() => buildProduct({ ...baseSell, media: [{ name: '零字节.png', type: 'image/png', size: 0 }] }, USER.openid, now())) === 'VALIDATION', '空文件被拒绝')
  ok(codeOf(() => buildProduct({ ...baseSell, media: 'not-an-array' }, USER.openid, now())) === 'VALIDATION', '媒体列表非数组被拒绝')

  const renamed = buildProduct({
    ...baseSell,
    media: [
      { name: '../../<script>.png', type: 'image/png', size: 1024 },
      { name: '   ', type: 'image/jpeg', size: 1024 },
      { name: '水印设备图'.repeat(20) + '.jpg', type: 'image/jpeg', size: 1024 }
    ]
  }, USER.openid, now())
  ok(!/[\\/<>]/.test(renamed.media[0].name) && renamed.media[0].name.indexOf('script') >= 0, '文件名路径与尖括号被净化且保留可读主体')
  ok(renamed.media[1].name.length > 0, '空名称回填默认名')
  ok(renamed.media[2].name.length <= 30, '超长名称截断到 30 字')
}

/* ============================================================
   18. 工单分配 / 转派、客服服务记录与操作日志
   ============================================================ */
section('18. 工单分配、服务记录与操作日志')
{
  const adminCtx = { token: adminToken }
  const staffRes = await call(adminRouter, 'staff.list', {}, adminCtx)
  ok(staffRes.ok && staffRes.data.items.some((s) => s.username === 'cs'), '坐席列表返回启用中的客服账号')

  const csDemo = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'cs')
  const csLogin = await call(adminRouter, 'admin.login', {
    username: 'cs', password: csDemo.password, otp: generateTotp(csDemo.totpSecret, now())
  }, {})
  const csCtx = { token: csLogin.data.token }
  const csStaff = await call(adminRouter, 'staff.list', {}, csCtx)
  ok(csStaff.ok, '客服可读取坐席列表（转派需要）')
  const csService = await call(adminRouter, 'service.records', {}, csCtx)
  ok(csService.ok, '客服可查看自己的服务记录')

  /* 造一条待分配线索，验证坐席必须真实存在 */
  await repo.updateWhere('leads', { id: leadId }, { status: LEAD_STATUS.PENDING, assignedTo: '', assignedAccount: '' })
  const badAssign = await call(adminRouter, 'lead.assign', { leadId, assignee: '幽灵客服' }, adminCtx)
  ok(!badAssign.ok && badAssign.code === 'VALIDATION', '分配到不存在的坐席被拒')

  const assigned = await call(adminRouter, 'lead.assign', { leadId, assignee: 'cs' }, adminCtx)
  ok(assigned.ok && assigned.data.assignedAccount === 'cs', '分配给真实客服账号成功')
  ok(assigned.data.assignedTo === '客服坐席' && assigned.data.transferred === false, '记录坐席展示名并标记为首次分配')

  const transfer = await call(adminRouter, 'lead.assign', {
    leadId, assignee: 'admin', reason: '工单需要管理员复核'
  }, adminCtx)
  ok(transfer.ok && transfer.data.transferred === true && transfer.data.assignedTo === '平台管理员', '工单可在客服之间转派')

  const auditByLead = await call(adminRouter, 'audit.list', { leadId }, adminCtx)
  ok(auditByLead.ok && auditByLead.data.items.length >= 2 && auditByLead.data.items.every((i) => i.leadId === leadId), '操作日志可按工单回溯')
  ok(auditByLead.data.items.some((i) => i.actorName === '平台管理员'), '操作日志回填操作人展示名')

  const auditByActor = await call(adminRouter, 'audit.list', { actorId: 'admin', action: 'lead.assign' }, adminCtx)
  ok(auditByActor.ok && auditByActor.data.items.length >= 2, '操作日志可按操作人 + 动作筛选')

  const service = await call(adminRouter, 'service.records', {}, adminCtx)
  ok(service.ok && service.data.items.some((i) => i.action === 'lead.assign'), '客服服务记录包含分配 / 转派动作')
  ok(Array.isArray(service.data.staff) && service.data.staff.some((s) => s.username === 'admin' && s.handled >= 2), '服务记录返回每位坐席的处理量')
  const serviceByLead = await call(adminRouter, 'service.records', { leadId }, adminCtx)
  ok(serviceByLead.ok && serviceByLead.data.items.every((i) => i.leadId === leadId), '服务记录可按工单筛选')
}

/* ============================================================
   19. 筛选规则可配置 + 强制下架 + 草稿状态
   ============================================================ */
section('19. 筛选规则配置、强制下架与草稿流转')
{
  const adminCtx = { token: adminToken }

  /* ---- 规则列表：条件与说明都要下发，且不含盲索引 ---- */
  const rulesRes = await call(adminRouter, 'rules.list', {}, adminCtx)
  ok(rulesRes.ok, '规则列表可读')
  ok(Array.isArray(rulesRes.data.types) && rulesRes.data.types.length > 0, '规则类型由后端下发（新增规则表单可用）')
  ok(Array.isArray(rulesRes.data.tiers) && rulesRes.data.tiers.length === 4, '档位说明由后端下发（P0/P1/P2/默认）')
  const listed = rulesRes.data.items || []
  ok(listed.length > 0 && listed.every((r) => typeof r.condText === 'string' && r.condText.length > 0), '每条规则都带可读的条件说明')
  ok(!JSON.stringify(rulesRes.data).includes('blockedPhoneBidx'), '规则列表不下发盲索引')

  /* ---- 新增手机号黑名单规则：明文不出规则表 ---- */
  const created = await call(adminRouter, 'rule.create', {
    name: '黑名单手机号测试',
    type: 'phone',
    value: '13800138000, 13900139000',
    tier: 'P0',
    scope: 'global',
    note: '验证用例'
  }, adminCtx)
  ok(created.ok, '可新增手机号黑名单规则')
  ok(created.data.condText.indexOf('黑名单手机号') >= 0, '黑名单规则的条件说明可读')
  ok(!JSON.stringify(created.data).includes('13800138000'), '新增响应不含明文手机号')
  const storedRule = await repo.get('rules', created.data.id)
  ok(storedRule && Array.isArray(storedRule.cond.blockedPhoneBidx) && storedRule.cond.blockedPhoneBidx.length === 2, '规则表只落盲索引')
  ok(JSON.stringify(storedRule.cond).indexOf('13800138000') < 0, '规则表不落明文手机号')
  ok(storedRule.version === 1 && storedRule.enabled === true, '新增规则默认启用且版本号为 1')

  /* 非法手机号被拒 */
  const badPhone = await call(adminRouter, 'rule.create', {
    name: '非法号码', type: 'phone', value: '12345', tier: 'P0', scope: 'global'
  }, adminCtx)
  ok(!badPhone.ok && badPhone.code === 'VALIDATION', '非法手机号被拒')

  /* ---- 修改规则：条件与档位都可改，版本号自增 ---- */
  const updated = await call(adminRouter, 'rule.update', {
    id: created.data.id,
    name: '黑名单手机号测试（改）',
    type: 'phone',
    value: '13800138000',
    tier: 'P2',
    scope: 'global'
  }, adminCtx)
  ok(updated.ok && updated.data.version === 2, '可修改规则且版本号自增')
  ok(updated.data.tier === 'P2', '可修改规则档位')

  /* 版本冲突：拿旧版本号改会被拒 */
  const stale = await call(adminRouter, 'rule.update', {
    id: created.data.id, name: '并发修改', type: 'phone', tier: 'P0', scope: 'global', version: 1
  }, adminCtx)
  ok(!stale.ok && stale.code === 'CONFLICT', '并发修改同一规则被拒（版本 CAS）')

  /* 客服无权新增规则 */
  const csDemo = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'cs')
  const csLogin2 = await call(adminRouter, 'admin.login', {
    username: 'cs', password: csDemo.password, otp: generateTotp(csDemo.totpSecret, now())
  }, {})
  const csRule = await call(adminRouter, 'rule.create', {
    name: '客服越权建规则', type: 'word', value: 'x', tier: 'P0', scope: 'global'
  }, { token: csLogin2.data.token })
  ok(!csRule.ok && csRule.code === 'FORBIDDEN', '客服不能新增筛选规则（越权）')

  /* ---- 黑名单规则真的能命中判档 ---- */
  /* 先把档位改回 P0（前面用例改成了 P2），验证黑名单命中即拦截 */
  const backToP0 = await call(adminRouter, 'rule.update', {
    id: created.data.id,
    name: '黑名单手机号测试',
    type: 'phone',
    value: '13800138000',
    tier: 'P0',
    scope: 'global',
    version: updated.data.version
  }, adminCtx)
  ok(backToP0.ok, '规则档位可改回 P0')
  const blockedProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: '黑名单命中用例商品',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G',
    qty: 1, minQty: 1, price: '248000', cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货',
    must: ['接受同台互验'], nego: [], flow: []
  }, OWNER)
  const blackConsult = await call(userRouter, 'consult.submit', {
    productId: blockedProduct.data.id,
    phone: '13800138000',
    conds: [{ k: '接受同台互验', satisfied: true }],
    summary: '正常咨询说明'
  }, USER)
  ok(blackConsult.ok, '咨询可提交（对外仍是中性回执）')
  const blackLead = await repo.get('leads', blackConsult.data.leadId)
  ok(blackLead && blackLead.tier === 'P0', '命中手机号黑名单的咨询被判为 P0')
  ok(blackLead && blackLead.status === '已拦截', 'P0 命中进已拦截箱')

  /* ---- 强制下架：必须填理由，理由同步给货主 ---- */
  const offProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: '强制下架用例商品',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G',
    qty: 1, minQty: 1, price: '248000', cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货',
    must: ['接受同台互验'], nego: [], flow: []
  }, OWNER)
  const noReason = await call(adminRouter, 'product.offline', { productId: offProduct.data.id }, adminCtx)
  ok(!noReason.ok && noReason.code === 'VALIDATION', '下架不填理由被拒')

  const offOk = await call(adminRouter, 'product.offline', {
    productId: offProduct.data.id, reason: '信息不实 / 与实物不符'
  }, adminCtx)
  ok(offOk.ok && offOk.data.to === PRODUCT_STATUS.OFFLINE, '选理由即可强制下架商品')
  const offDoc = await repo.get('products', offProduct.data.id)
  ok(offDoc.status === PRODUCT_STATUS.OFFLINE && offDoc.offlineReason === '信息不实 / 与实物不符', '下架理由落到商品记录上')

  const ownerMsgs = await call(userRouter, 'msg.list', { page: 1, limit: 50 }, OWNER)
  const notice = (ownerMsgs.data.items || []).filter((m) => m.targetId === offProduct.data.id)[0]
  ok(!!notice, '下架后货主收到系统提示')
  ok(notice && notice.reason === '信息不实 / 与实物不符', '系统提示带上下架理由')
  ok(notice && notice.from === 'system', '系统提示来源标记为 system')

  /* 已下架不可重复下架 */
  const offAgain = await call(adminRouter, 'product.offline', {
    productId: offProduct.data.id, reason: '重复下架'
  }, adminCtx)
  ok(!offAgain.ok && offAgain.code === 'CONFLICT', '已下架商品不可重复下架')

  /* ---- 草稿：可存草稿 → 提交审核，状态链完整 ---- */
  const draft = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: '草稿用例商品',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G',
    qty: 1, minQty: 1, price: '248000', cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货',
    must: ['接受同台互验'], nego: [], flow: [],
    draft: true
  }, OWNER)
  ok(draft.ok && draft.data.status === PRODUCT_STATUS.DRAFT, '可存草稿（字段不全也能存）')
  const draftVisible = await call(userRouter, 'product.detail', { id: draft.data.id }, USER)
  ok(!draftVisible.ok, '草稿对外不可见')
  const draftSubmit = await call(userRouter, 'product.submit', { id: draft.data.id }, OWNER)
  ok(draftSubmit.ok && draftSubmit.data.status === PRODUCT_STATUS.ON_SALE, '草稿可直接发布上架（审核不是前置路径）')
  const publishedVisible = await call(userRouter, 'product.detail', { id: draft.data.id }, USER)
  ok(publishedVisible.ok, '发布后立即对外可见，无需审核')
  const submitAgain = await call(userRouter, 'product.submit', { id: draft.data.id }, OWNER)
  ok(!submitAgain.ok && submitAgain.code === 'CONFLICT', '已发布商品重复提交被拒')

  /* 草稿字段不全时发布必须被拒 */
  const badDraft = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: '半截草稿', draft: true
  }, OWNER)
  const badSubmit = await call(userRouter, 'product.submit', { id: badDraft.data.id }, OWNER)
  ok(!badSubmit.ok && badSubmit.code === 'VALIDATION', '字段不全的草稿发布被拒')

  /* 字段齐全的草稿可以正常发布上架 */
  const goodDraft = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: '完整草稿用例',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G',
    qty: 1, minQty: 1, price: '248000', cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货',
    must: ['接受同台互验'], nego: [], flow: [],
    draft: true
  }, OWNER)
  ok(goodDraft.ok && goodDraft.data.status === PRODUCT_STATUS.DRAFT, '字段齐全也能存草稿')
  const goodSubmit = await call(userRouter, 'product.submit', { id: goodDraft.data.id }, OWNER)
  ok(goodSubmit.ok && goodSubmit.data.status === PRODUCT_STATUS.ON_SALE, '完整草稿可直接发布上架')

  /* 平台可在后台审核：发布后照样能退回 */
  const rejectProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: '驳回用例商品',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G',
    qty: 1, minQty: 1, price: '248000', cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货',
    must: ['接受同台互验'], nego: [], flow: []
  }, OWNER)
  ok(rejectProduct.data.status === PRODUCT_STATUS.ON_SALE, '商品发布后直接就是在售')
  const noRejectReason = await call(adminRouter, 'product.review', {
    productId: rejectProduct.data.id, decision: '驳回'
  }, adminCtx)
  ok(!noRejectReason.ok && noRejectReason.code === 'VALIDATION', '驳回不填理由被拒')
  const reject = await call(adminRouter, 'product.review', {
    productId: rejectProduct.data.id, decision: '驳回', reason: '资质图片不清晰'
  }, adminCtx)
  ok(reject.ok && reject.data.to === PRODUCT_STATUS.REJECTED, '平台可在后台把在售商品退回')
  const mineList = await call(userRouter, 'mine.publish.list', { page: 1, limit: 50 }, OWNER)
  const rejectedRow = (mineList.data.products || []).filter((p) => p.id === rejectProduct.data.id)[0]
  ok(rejectedRow && rejectedRow.status === PRODUCT_STATUS.REJECTED, '我的发布能看到已驳回状态')
  ok(rejectedRow && rejectedRow.reviewReason === '资质图片不清晰', '我的发布能看到驳回原因')
  const rejectResubmit = await call(userRouter, 'product.submit', { id: rejectProduct.data.id }, OWNER)
  ok(rejectResubmit.ok && rejectResubmit.data.status === PRODUCT_STATUS.ON_SALE, '已驳回商品可修改后重新发布上架')

  /* ---- 平台统一「设置状态」：可改到任意目标状态，下架 / 退回必填理由 ---- */
  const setToOffline = await call(adminRouter, 'product.setStatus', {
    productId: draft.data.id, to: PRODUCT_STATUS.OFFLINE
  }, adminCtx)
  ok(!setToOffline.ok && setToOffline.code === 'VALIDATION', '设置为已下架不填理由被拒')
  const setOk = await call(adminRouter, 'product.setStatus', {
    productId: draft.data.id, to: PRODUCT_STATUS.OFFLINE, reason: '信息不实 / 与实物不符'
  }, adminCtx)
  ok(setOk.ok && setOk.data.to === PRODUCT_STATUS.OFFLINE, '平台可把商品改到已下架')
  const setBack = await call(adminRouter, 'product.setStatus', {
    productId: draft.data.id, to: PRODUCT_STATUS.ON_SALE
  }, adminCtx)
  ok(setBack.ok && setBack.data.to === PRODUCT_STATUS.ON_SALE, '平台可把商品重新上架')
  const badTarget = await call(adminRouter, 'product.setStatus', {
    productId: draft.data.id, to: '随便一个状态'
  }, adminCtx)
  ok(!badTarget.ok && badTarget.code === 'VALIDATION', '非法目标状态被拒')

  /* ---- 需求侧：草稿 + 发布即求购中 + 平台设置状态 ---- */
  /* 需求侧不强制型号：只填设备类型 + 数量 + 预算即可发布 */
  const noModel = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY,
    title: '不填型号的需求用例',
    cat: 'GPU 服务器',
    qty: 32,
    budget: '235000',
    tax: ['含税'],
    city: '广州',
    supply: '现货'
  }, OWNER)
  ok(noModel.ok && noModel.data.status === DEMAND_STATUS.OPEN, '需求不填型号也能发布上架')
  const noModelDoc = await repo.get('demands', noModel.data.id)
  ok(noModelDoc && noModelDoc.brand === '' && noModelDoc.model === '', '未填型号时品牌与型号落空值')

  const demandDraft = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY,
    title: '需求草稿用例',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G',
    qty: 4, budget: '235000', tax: ['含税'], city: '广州', supply: '现货',
    draft: true
  }, OWNER)
  ok(demandDraft.ok && demandDraft.data.status === DEMAND_STATUS.DRAFT, '需求可存草稿')
  const demandSubmit = await call(userRouter, 'demand.submit', { id: demandDraft.data.id }, OWNER)
  ok(demandSubmit.ok && demandSubmit.data.status === DEMAND_STATUS.OPEN, '需求草稿可直接发布上架')
  const demandVisible = await call(userRouter, 'demand.detail', { id: demandDraft.data.id }, USER)
  ok(demandVisible.ok, '需求发布后立即对外可见，无需审核')
  const demandOffline = await call(adminRouter, 'demand.setStatus', {
    demandId: demandDraft.data.id, to: DEMAND_STATUS.OFFLINE, reason: '需求描述不实'
  }, adminCtx)
  ok(demandOffline.ok && demandOffline.data.to === DEMAND_STATUS.OFFLINE, '平台可把需求改到已下架')
  const demandNotice = await call(userRouter, 'msg.list', { page: 1, limit: 50 }, OWNER)
  ok((demandNotice.data.items || []).some((m) => m.targetId === demandDraft.data.id && m.reason === '需求描述不实'), '需求下架理由同步给需求方')

  /* ---- 咨询可带补充材料：图片 5 张 + 视频 3 段，命名后随咨询落库 ---- */
  /* 复用上面已重新上架的商品，避免重复发布触发发布频控 */
  const withMedia = await call(userRouter, 'consult.submit', {
    productId: draft.data.id,
    phone: '13500135000',
    conds: [{ k: '接受同台互验', satisfied: true }],
    summary: '带补充材料的咨询',
    media: [
      { name: '营业执照.png', type: 'image/png', size: 1024, kind: 'image' },
      { name: '验资视频.mp4', type: 'video/mp4', size: 2048, kind: 'video' }
    ]
  }, USER)
  ok(withMedia.ok, '带补充材料的咨询可提交')
  const mediaLead = await repo.get('leads', withMedia.data.leadId)
  ok(mediaLead && Array.isArray(mediaLead.media) && mediaLead.media.length === 2, '补充材料随咨询落库')
  ok(mediaLead && mediaLead.media[0].name === '营业执照.png', '补充材料保留自定义名称')

  /* 第 6 张图片 / 第 4 段视频被拒 */
  const tooMany = await call(userRouter, 'consult.submit', {
    productId: draft.data.id,
    phone: '13500135001',
    conds: [{ k: '接受同台互验', satisfied: true }],
    summary: '材料超限',
    media: Array.from({ length: 6 }, (_, i) => ({ name: '图' + i + '.png', type: 'image/png', size: 1024, kind: 'image' }))
  }, USER)
  ok(!tooMany.ok && tooMany.code === 'VALIDATION', '咨询附 6 张图片被拒')
}

/* ============================================================
   20. 设备目录：单一真源 + 主流品牌齐备 + 按常见度排序
   ============================================================ */
section('20. 设备目录')
{
  const { DEVICE_CATALOG } = require(path.join(here, '..', 'device-catalog.js'))
  const cats = Object.keys(DEVICE_CATALOG)
  ok(cats.length >= 15, '设备品类数量充足（' + cats.length + ' 个）')
  ok(cats[0] === 'GPU 服务器', '最高频品类排在首位（GPU 服务器）')
  ok(cats.indexOf('GPU 加速卡') > 0 && cats.indexOf('GPU 加速卡') < 5, 'GPU 加速卡靠前')

  /* 主流品牌不能缺：戴尔 B300、超聚变 GPU 服务器都要在 */
  const gpu = DEVICE_CATALOG['GPU 服务器'] || {}
  ok(!!gpu['戴尔'], 'GPU 服务器含戴尔')
  ok(!!gpu['超聚变'], 'GPU 服务器含超聚变')
  ok(!!gpu['NVIDIA'] && !!gpu['浪潮'] && !!gpu['超微'] && !!gpu['联想'], 'GPU 服务器含主流 OEM 品牌')

  const dellModels = JSON.stringify(gpu['戴尔'] || {})
  ok(dellModels.indexOf('B300') >= 0, '戴尔有 B300 机型')
  ok(dellModels.indexOf('XE9680') >= 0, '戴尔有 PowerEdge XE9680')
  const xfusion = JSON.stringify(gpu['超聚变'] || {})
  ok(xfusion.indexOf('B300') >= 0, '超聚变有 B300 机型')
  ok(xfusion.indexOf('FusionServer') >= 0, '超聚变有 FusionServer 系列')

  /* 品牌顺序按常见度：主流 OEM 排在前面 */
  const brands = Object.keys(gpu)
  ok(brands.indexOf('NVIDIA') === 0, 'NVIDIA 排在 GPU 服务器品牌首位')
  ok(brands.indexOf('戴尔') <= 3 && brands.indexOf('超聚变') <= 3, '戴尔 / 超聚变靠前')

  /* 目录里不能有重复品牌（浪潮 与 浪潮信息 曾同时存在） */
  const dup = []
  cats.forEach((c) => {
    const seen = new Set()
    Object.keys(DEVICE_CATALOG[c] || {}).forEach((b) => {
      const key = b.replace(/信息|股份|科技/g, '')
      if (seen.has(key)) dup.push(c + '/' + b)
      seen.add(key)
    })
  })
  ok(dup.length === 0, '同一品类下没有同义重复品牌' + (dup.length ? '：' + dup.join('、') : ''))

  /* 小程序与原型必须用同一份目录内容（各自持有一份拷贝，但结构必须一致） */
  const mock = require(path.join(here, '..', 'miniprogram', 'utils', 'mock.js'))
  ok(JSON.stringify(mock.DEVICE_TREE) === JSON.stringify(DEVICE_CATALOG), '小程序 mock 的目录与真源完全一致')
  /* 小程序包里不能残留对新文件的 require：微信开发者工具的模块缓存不识别新增文件 */
  const miniprogramDir = path.join(here, '..', 'miniprogram')
  const jsFiles = []
  const walk = (dir) => {
    fs.readdirSync(dir).forEach((f) => {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (f.endsWith('.js')) jsFiles.push(p)
    })
  }
  walk(miniprogramDir)
  const badRequire = jsFiles.filter((f) => /require\(['"]\.\/device-catalog['"]\)/.test(fs.readFileSync(f, 'utf8')))
  ok(badRequire.length === 0, '小程序包里没有对 device-catalog 的 require（避免开发者工具模块缓存不识别）')

  /* 演示数据引用的品类 / 品牌 / 型号都要在目录里 */
  const miss = []
  const checkRow = (p) => {
    const b = (DEVICE_CATALOG[p.cat] || {})[p.brand]
    const models = b ? (Array.isArray(b) ? b : Object.values(b).flat()) : []
    if (models.indexOf(p.model) < 0) miss.push(p.cat + '/' + p.brand + '/' + p.model)
  }
  mock.PRODUCTS.concat(mock.MY_PRODUCTS, mock.DEMANDS, mock.MY_DEMANDS).forEach(checkRow)
  ok(miss.length === 0, '演示数据的型号全部在目录中' + (miss.length ? '：' + miss.join('、') : ''))
}

/* ============================================================
   21. 分享：只分享公开信息，接收方看不到联系方式
   ============================================================ */
section('21. 分享与信息隔离')
{
  const guard = require(path.join(here, '..', 'miniprogram', 'utils', 'guard.js'))

  /* 分享路径只夹带 id 与来源标记，不带任何身份 / 联系方式字段 */
  const pPath = guard.sharePath('product', 'p_1001')
  const dPath = guard.sharePath('demand', 'd_2001')
  ok(pPath === '/pages/product/product?id=p_1001&from=share', '商品分享路径只带 id 与 from=share')
  ok(dPath === '/pages/demand/demand?id=d_2001&from=share', '需求分享路径只带 id 与 from=share')
  const leak = [pPath, dPath].filter((x) => /(uid|phone|mobile|openid|lead|contact|token)/i.test(x))
  ok(leak.length === 0, '分享路径不含身份 / 联系方式字段' + (leak.length ? '：' + leak.join('、') : ''))

  /* 标题只用结构化公开字段拼，且兜底剔除手机号 / 座机 / 邮箱 / 微信号 */
  const dirty = guard.shareTitle('product', {
    brand: 'NVIDIA', model: 'H100 80G', qty: 8, city: '深圳',
    priceText: '¥24万/台', title: '联系 13800138000'
  })
  ok(dirty.indexOf('13800138000') < 0, '分享标题不会带出手机号')
  ok(dirty.indexOf('H100') >= 0 && dirty.indexOf('出售') >= 0, '分享标题含型号与交易方式')
  ok(dirty.indexOf('联系') < 0, '分享标题不读自由文本标题（避免夹带联系方式）')

  const demandTitle = guard.shareTitle('demand', {
    brand: '华为', model: 'Atlas 900 A2', qty: 64, city: '北京', budgetText: '¥180万'
  })
  ok(demandTitle.indexOf('求购') >= 0 && demandTitle.indexOf('预算') >= 0, '需求分享标题用「求购 + 预算」口径')
  const rentTitle = guard.shareTitle('product', { model: 'H100', isRent: true, qty: 4, priceText: '¥3.2万/月' })
  ok(rentTitle.indexOf('出租') >= 0, '租赁商品分享标题用「出租」口径')

  ok(guard.scrubContact('微信：abc12345').indexOf('abc12345') < 0, '分享文案过滤微信号')
  ok(guard.scrubContact('邮箱 a@b.com').indexOf('@') < 0, '分享文案过滤邮箱')
  ok(guard.scrubContact('电话 0755-88886666').indexOf('88886666') < 0, '分享文案过滤座机')

  /* 页面接入：详情页 / 我的发布三个入口都能分享，且共用同一口径 */
  const pagesDir = path.join(here, '..', 'miniprogram', 'pages')
  const readPage = (f) => fs.readFileSync(path.join(pagesDir, f), 'utf8')
  ;['product/product.js', 'demand/demand.js', 'mine/mine-core.js'].forEach((f) => {
    const src = readPage(f)
    ok(/onShareAppMessage\s*\(/.test(src), f + ' 已实现 onShareAppMessage')
    ok(src.indexOf('guard.shareCard(') >= 0,
      f + ' 分享走 shareCard 统一口径（标题+描述+卡片图+路径）')
    ok(src.indexOf('guard.enableShare(') >= 0, f + ' 分享入口调用 enableShare（只开微信好友）')
    /* 分享返回值不能夹带联系方式字段 */
    const i = src.indexOf('onShareAppMessage')
    const tail = src.slice(i)
    const end = tail.indexOf('\n  },')
    const body = (end > 0 ? tail.slice(0, end) : tail.slice(0, 1200)).replace(/\/\*[\s\S]*?\*\//g, '')
    ok(!/(phone|mobile|contact|openid|uid)\s*:/.test(body), f + ' 分享返回值不含联系方式字段')
  })

  /* 只开「发送给朋友」，不开朋友圈（朋友圈是公开广播） */
  const guardSrc = fs.readFileSync(path.join(here, '..', 'miniprogram', 'utils', 'guard.js'), 'utf8')
  const enableIdx = guardSrc.indexOf('function enableShare')
  const enableBody = enableIdx < 0 ? '' : guardSrc.slice(enableIdx, enableIdx + 400)
  /* 默认只开「发送给朋友」，朋友圈是公开广播，必须由页面显式传 true 才开；且任何页面都不得放开群发外渠道 */
  ok(/'shareAppMessage', 'shareTimeline'\] : \['shareAppMessage'\]/.test(enableBody), 'enableShare 默认只开放「发送给朋友」，朋友圈需显式开启')
  ok(enableBody.indexOf('shareAppMessage') >= 0 && enableBody.indexOf('withShareTicket') >= 0, 'enableShare 不携带群发 shareTicket')

  /* 详情页有分享按钮、分享落地有保密提示、页面不绑定明文联系方式 */
  ;['product/product.wxml', 'demand/demand.wxml'].forEach((f) => {
    const src = readPage(f)
    ok(src.indexOf('open-type="share"') >= 0, f + ' 有分享按钮')
    ok(src.indexOf('share-tip') >= 0, f + ' 分享落地有保密提示')
    const stripped = src.replace(/ownerPhone/g, '').replace(/seller\.phone/g, '')
    ok(!/\{\{[^}]*\b(phone|mobile)\b[^}]*\}\}/.test(stripped)
      && !/\{\{[^}]*phoneMasked[^}]*\}\}/.test(stripped),
      f + ' 模板不绑定私有机号字段（ownerPhone / seller.phone 为货主自愿公开，走白名单）')
  })
  ok(readPage('mine/mine.wxml').indexOf('open-type="share"') >= 0, '我的发布列表有分享按钮')
  /* 列表条目统一由 adaptPub 标注 kind，分享据此落地到需求详情 */
  const mineJs = readPage('mine/mine.js') + '\n' + readPage('mine/mine-core.js')
  ok(/adaptPub[\s\S]{0,1200}?kind: kind,/.test(mineJs)
    && /kind === 'demand'/.test(mineJs)
    && /MY_DEMANDS/.test(mineJs) === false,
    '我的需求条目带 kind，分享落地到需求详情而不是商品详情')
}

/* ============================================================
   22. 业务全链路（顺序执行：发布 → 可见 → 咨询 → 工单 → 对接 → 成交 → 检索）
   ============================================================ */
section('22. 业务全链路回归')
{
  const SELLER = { openid: 'o_chain_seller', ip: '10.9.0.1' }
  const BUYER = { openid: 'o_chain_buyer', ip: '10.9.0.2' }
  const OUTSIDER = { openid: 'o_chain_other', ip: '10.9.0.3' }
  const MARK = '链路E2E·H200'

  await call(userRouter, 'auth.login', { nick: '链路货主' }, SELLER)
  await call(userRouter, 'profile.save', {
    nick: '链路货主', phone: '13900139002', realname: '货主甲',
    subject: '链路测试科技有限公司', city: '上海'
  }, SELLER)
  await call(userRouter, 'auth.login', { nick: '链路买家' }, BUYER)
  await call(userRouter, 'profile.save', {
    nick: '链路买家', phone: '13900139003', realname: '买家乙', exposure: 'open',
    position: '采购经理', subject: '链路采购有限公司', city: '上海'
  }, BUYER)

  /* ① 存草稿：草稿只有自己可见 */
  const draft = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: MARK + ' 整机',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 8, minQty: 1, price: '298000', cond: '全新',
    tax: ['含税'], city: '上海', supply: '现货', deliver: '7 天内',
    must: ['接受同台互验', '可提供采购意向函'], nego: [], flow: [],
    draft: true
  }, SELLER)
  ok(draft.ok && draft.data.status === PRODUCT_STATUS.DRAFT, '① 发布前可先存草稿')
  const draftHidden = await call(userRouter, 'product.detail', { id: draft.data.id }, BUYER)
  ok(!draftHidden.ok, '① 草稿对外不可见')

  /* ② 直接发布：审核不是必要路径，发布即可见 */
  const submit = await call(userRouter, 'product.submit', { id: draft.data.id }, SELLER)
  ok(submit.ok && submit.data.status === PRODUCT_STATUS.ON_SALE, '② 草稿可直接发布上架，无需等待审核')
  const visible = await call(userRouter, 'product.detail', { id: draft.data.id }, BUYER)
  ok(visible.ok && visible.data.id === draft.data.id, '② 发布后他人立即可见')
  ok(JSON.stringify(visible.data).indexOf('13900139002') < 0, '② 他人视角拿不到货主手机号')

  /* ③ 公开检索：按关键词能搜到刚发布的商品 */
  const search = await call(userRouter, 'product.list', { q: MARK }, BUYER)
  ok(search.ok && (search.data.items || []).some((p) => p.id === draft.data.id), '③ 首页搜索能检索到新发布的商品')

  /* ③.1 首页筛选 / 排序下推：城市、品类、关键词（跨字段）、价格排序都要由服务端生效 */
  const byCity = await call(userRouter, 'product.list', { city: '上海', limit: 50 }, BUYER)
  ok(byCity.ok && (byCity.data.items || []).length > 0 &&
    byCity.data.items.every((p) => String(p.city || '').indexOf('上海') === 0),
    '③.1 城市筛选由服务端过滤生效')
  const byCat = await call(userRouter, 'product.list', { cat: 'GPU 服务器', limit: 50 }, BUYER)
  ok(byCat.ok && (byCat.data.items || []).length > 0 &&
    byCat.data.items.every((p) => p.cat === 'GPU 服务器'), '③.1 品类筛选由服务端过滤生效')
  const kwCity = await call(userRouter, 'product.list', { q: '上海', limit: 50 }, BUYER)
  ok(kwCity.ok && (kwCity.data.items || []).some((p) => p.id === draft.data.id),
    '③.1 关键词可命中城市等非标题字段（与首页搜索口径一致）')
  const priceAsc = await call(userRouter, 'product.list', { sort: '价格升序', limit: 50 }, BUYER)
  const ascPrices = (priceAsc.ok ? priceAsc.data.items : []).map((p) => Number(p.price) || 0).filter((n) => n > 0)
  ok(ascPrices.every((n, i) => i === 0 || ascPrices[i - 1] <= n), '③.1 价格升序排序由服务端生效')

  /* ④ 咨询：必须条件逐项满足才能提交 */
  const notMet = await call(userRouter, 'consult.submit', {
    productId: draft.data.id, phone: '13900139003',
    conds: [{ k: '接受同台互验', satisfied: false }],
    summary: '想采购 8 台'
  }, BUYER)
  ok(!notMet.ok && notMet.code === 'VALIDATION', '④ 必须条件未满足时不能提交咨询')
  const consult = await call(userRouter, 'consult.submit', {
    productId: draft.data.id, phone: '13900139003',
    conds: [{ k: '接受同台互验', satisfied: true }, { k: '可提供采购意向函', satisfied: true }],
    summary: MARK + ' 采购 8 台，预算 290000 元 / 台'
  }, BUYER)
  ok(consult.ok && !!consult.data.leadId, '④ 条件满足后咨询建档成功')
  const chainLeadId = consult.data.leadId

  /* ⑤ 工单：分配 → 转派 → 全流程留痕 */
  const assign = await call(adminRouter, 'lead.assign', { leadId: chainLeadId, assignee: 'cs' }, { token: adminToken })
  ok(assign.ok && assign.data.assignedAccount === 'cs', '⑤ 工单可分配给指定客服')
  const transfer = await call(adminRouter, 'lead.assign', {
    leadId: chainLeadId, assignee: 'admin', reason: '大额订单需管理员复核'
  }, { token: adminToken })
  ok(transfer.ok && transfer.data.transferred === true, '⑤ 工单可从客服转派给管理员')
  const auditChain = await call(adminRouter, 'audit.list', { leadId: chainLeadId }, { token: adminToken })
  ok(auditChain.ok && auditChain.data.items.length >= 2, '⑤ 分配与转派都写入操作日志')

  /* ⑥ 未对接不得释放联系方式 */
  const early = await call(adminRouter, 'contact.reveal', {
    leadId: chainLeadId, reason: '想提前联系'
  }, { token: adminToken })
  ok(!early.ok && early.code === 'CONFLICT', '⑥ 未对接时释放联系方式被拒')

  /* ⑦ 推进：待分配 → 跟进中 → 已对接，商品自动转洽谈中 */
  const following = await call(adminRouter, 'lead.updateStatus', {
    leadId: chainLeadId, to: LEAD_STATUS.FOLLOWING, reason: '坐席已首次响应'
  }, { token: adminToken })
  ok(following.ok, '⑦ 待分配 → 跟进中')
  const matched = await call(adminRouter, 'lead.updateStatus', {
    leadId: chainLeadId, to: LEAD_STATUS.MATCHED, reason: '双方已建群'
  }, { token: adminToken })
  ok(matched.ok, '⑦ 跟进中 → 已对接')
  const negotiating = await repo.get('products', draft.data.id)
  ok(negotiating.status === PRODUCT_STATUS.NEGOTIATING, '⑦ 对接后商品自动转「洽谈中」')
  const leadOutbox = await repo.find('outbox', {})
  ok(leadOutbox.some((m) => m.payload && m.payload.uid === BUYER.openid && m.payload.leadId === chainLeadId &&
    String(m.payload.title || '').indexOf('已对接') > -1), '⑦ 线索推进「已对接」给咨询人发站内信')

  /* ⑧ 已对接后释放联系方式：明文仅此接口出现，且必须写审计 */
  const reveal = await call(adminRouter, 'contact.reveal', {
    leadId: chainLeadId, reason: '建群邀请双方'
  }, { token: adminToken })
  ok(reveal.ok && reveal.data.phone === '13900139003', '⑧ 已对接后可释放联系方式')
  const revealAudit = await call(adminRouter, 'audit.list', {
    leadId: chainLeadId, action: 'contact.reveal'
  }, { token: adminToken })
  ok(revealAudit.ok && revealAudit.data.items.some((a) => a.result === 'allow'), '⑧ 释放联系方式写入审计日志')

  /* ⑧.1 咨询电话与档案解耦：提交时的号码只落线索，不能覆盖实名档案手机号 */
  const phoneProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: MARK + ' 咨询电话隔离用例', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'A800 80G', qty: 1, price: '120000', cond: '全新',
    tax: ['含税'], city: '北京', supply: '现货'
  }, SELLER)
  ok(phoneProduct.ok, '⑧.1 新建咨询电话隔离用例商品')
  const otherPhoneConsult = await call(userRouter, 'consult.submit', {
    productId: phoneProduct.data.id, phone: '13900139099', conds: [],
    summary: MARK + ' 用另一个号码发起咨询'
  }, BUYER)
  ok(otherPhoneConsult.ok, '⑧.1 用与档案不同的号码提交咨询')
  const buyerAfterSubmit = await repo.get('users', BUYER.openid)
  const buyerPhoneNow = decryptField({ keys, token: buyerAfterSubmit.phoneCipher, aad: 'users.phoneCipher.' + BUYER.openid })
  ok(buyerPhoneNow === '13900139003', '⑧.1 咨询手机号不回写档案（档案仍为授权号码）')
  const leadPhoneDoc = await repo.get('leads', otherPhoneConsult.data.leadId)
  ok(leadPhoneDoc.contactPhoneMasked === '139****9099' && !!leadPhoneDoc.contactPhoneCipher &&
    JSON.stringify(leadPhoneDoc).indexOf('13900139099') < 0, '⑧.1 咨询电话加密落在线索并保留脱敏值')
  await call(adminRouter, 'lead.assign', { leadId: otherPhoneConsult.data.leadId, assignee: 'admin' }, { token: adminToken })
  await call(adminRouter, 'lead.updateStatus', {
    leadId: otherPhoneConsult.data.leadId, to: LEAD_STATUS.FOLLOWING, reason: '电话隔离用例跟进'
  }, { token: adminToken })
  await call(adminRouter, 'lead.updateStatus', {
    leadId: otherPhoneConsult.data.leadId, to: LEAD_STATUS.MATCHED, reason: '电话隔离用例对接'
  }, { token: adminToken })
  const otherReveal = await call(adminRouter, 'contact.reveal', {
    leadId: otherPhoneConsult.data.leadId, reason: '按咨询留存号码联系'
  }, { token: adminToken })
  ok(otherReveal.ok && otherReveal.data.phone === '13900139099', '⑧.1 释放的是本次咨询留存的号码')

  /* ⑨ 成交：线索与商品同步完结 */
  const dealt = await call(adminRouter, 'lead.updateStatus', {
    leadId: chainLeadId, to: LEAD_STATUS.DEALT, reason: '双方确认成交'
  }, { token: adminToken })
  ok(dealt.ok, '⑨ 已对接 → 已成交')
  const dealtProduct = await repo.get('products', draft.data.id)
  ok(dealtProduct.status === PRODUCT_STATUS.DEALT, '⑨ 成交后商品同步转「已成交」')
  const onSaleAfter = await call(userRouter, 'product.list', { q: MARK }, OUTSIDER)
  ok(onSaleAfter.ok && !(onSaleAfter.data.items || []).some((p) => p.id === draft.data.id), '⑨ 成交后不再出现在在售列表')

  /* ⑩ 完结检索：我的发布、管理端按状态 + 关键词都能找回这条链路 */
  const mine = await call(userRouter, 'mine.publish.list', { page: 1, limit: 50 }, SELLER)
  ok(mine.ok && (mine.data.products || []).some((p) => p.id === draft.data.id), '⑩ 我的发布能看到已成交商品')
  ok(mine.data.total >= 1, '⑩ 我的发布总数与列表同源')
  const adminSearch = await call(adminRouter, 'lead.list', {
    status: LEAD_STATUS.DEALT, q: MARK
  }, { token: adminToken })
  ok(adminSearch.ok && (adminSearch.data.items || []).some((l) => l.id === chainLeadId),
    '⑩ 管理端可按状态 + 关键词检索到已成交线索')
  const fullAudit = await call(adminRouter, 'audit.list', { leadId: chainLeadId }, { token: adminToken })
  ok(fullAudit.ok &&
    fullAudit.data.items.some((a) => a.action === 'contact.reveal') &&
    fullAudit.data.items.some((a) => a.action === 'lead.updateStatus'),
    '⑩ 全链路操作可完整回溯')
  ok(JSON.stringify(adminSearch.data).indexOf('13900139003') < 0, '⑩ 线索检索结果不含明文手机号')
}

/* ============================================================
   11. 管理端用户数据：多维筛选与脱敏
   ============================================================ */
section('11. 管理端用户数据（多维筛选 / 脱敏）')
{
  const adminCtx = { token: adminToken }
  const U = { openid: 'o_usr_list', ip: '10.11.0.1' }
  await call(userRouter, 'auth.login', { nick: '用户数据测试' }, U)
  const saved = await call(userRouter, 'profile.save', {
    nick: '用户数据测试', phone: '13700137000', realname: '测试甲',
    subject: '用户数据测试有限公司', subjectType: '民企', city: '深圳',
    quals: ['营业执照']
  }, U)
  ok(saved.ok, '用户数据测试账号资料保存成功', JSON.stringify(saved).slice(0, 120))

  const list = await call(adminRouter, 'user.list', {}, adminCtx)
  ok(list.ok && Array.isArray(list.data.items), '管理员可读取用户数据列表')
  /* 管理端要能直接拨号联系用户，列表 / 详情对已登录的后台账号下发可拨号号码；
     但密文与盲索引属于内部字段，任何接口都不能下发 */
  const listJson = JSON.stringify(list.data)
  ok(listJson.indexOf('phoneCipher') < 0 && listJson.indexOf('phoneBidx') < 0, '用户数据列表不下发手机号密文与盲索引')
  const listRow = (list.data.items || []).find((x) => x.id === 'o_usr_list') || {}
  ok(/^1\d{2}\*{4}\d{4}$/.test(String(listRow.phoneMasked || '')), '用户数据列表手机号同时带掩码字段', listRow.phoneMasked)
  ok(list.data.items.every((x) => /^U[2-9A-HJ-NP-Z]{8}$/.test(x.userNo || '')), '用户列表返回对外用户ID（U + 8 位）')
  const targetUserNo = (list.data.items.find((x) => x.id === 'o_usr_list') || {}).userNo
  const byNo = await call(adminRouter, 'user.list', { q: targetUserNo }, adminCtx)
  ok(byNo.ok && byNo.data.items.length === 1 && byNo.data.items[0].id === 'o_usr_list', '可按用户ID 精确检索到用户')

  const withLic = await call(adminRouter, 'user.list', { hasLicense: 'yes' }, adminCtx)
  ok(withLic.ok && withLic.data.items.length > 0 && withLic.data.items.every((x) => x.hasLicense),
    '按「已上传营业执照」筛选只返回已上传用户')
  const withoutLic = await call(adminRouter, 'user.list', { hasLicense: 'no' }, adminCtx)
  ok(withoutLic.ok && withoutLic.data.items.every((x) => !x.hasLicense),
    '按「未上传营业执照」筛选只返回未上传用户')

  const qualUnverified = await call(adminRouter, 'user.list', { qualStatus: 'unverified' }, adminCtx)
  ok(qualUnverified.ok && qualUnverified.data.items.some((x) => x.id === 'o_usr_list') &&
    qualUnverified.data.items.every((x) => x.qualCount > 0 && x.qualVerified === false),
    '按「未核验」筛选只返回已上传但未核验的用户')
  const qualNone = await call(adminRouter, 'user.list', { qualStatus: 'none' }, adminCtx)
  ok(qualNone.ok && qualNone.data.items.every((x) => x.qualCount === 0),
    '按「未上传资质」筛选只返回没有资质材料的用户')

  const byType = await call(adminRouter, 'user.list', { subjectType: '民企' }, adminCtx)
  ok(byType.ok && byType.data.items.some((x) => x.id === 'o_usr_list') &&
    byType.data.items.every((x) => x.subjectType === '民企'), '按企业主体筛选命中目标用户')

  const byCity = await call(adminRouter, 'user.list', { city: '深圳' }, adminCtx)
  ok(byCity.ok && byCity.data.items.some((x) => x.id === 'o_usr_list') &&
    byCity.data.items.every((x) => x.city === '深圳'), '按地点筛选命中目标用户')

  const byQ = await call(adminRouter, 'user.list', { q: '用户数据测试' }, adminCtx)
  ok(byQ.ok && byQ.data.items.some((x) => x.id === 'o_usr_list'), '按关键词筛选命中目标用户')

  const detail = await call(adminRouter, 'user.detail', { id: 'o_usr_list' }, adminCtx)
  ok(detail.data.user.city === '深圳', '管理员可查看用户详情')
  ok(detail.data.user.userNo === targetUserNo, '用户详情与管理端列表的用户ID 一致')
  ok(detail.data.user.subject.indexOf('用户数据测试') >= 0, '详情主体名称解密后可读（脱敏）', detail.data.user.subject)
  ok(detail.data.user.phoneMasked === '137****7000', '详情手机号仅返回掩码',
    JSON.stringify({ masked: detail.data.user.phoneMasked, saved: detail.data.user.phoneSaved }))
  const detailJson = JSON.stringify(detail.data)
  ok(detailJson.indexOf('phoneCipher') < 0 && detailJson.indexOf('phoneBidx') < 0, '用户详情不下发手机号密文与盲索引')

  /* 会员过期要显示「已到期」，不能沿用 bizAccess 里落库的「已开通」 */
  await repo.insert('bizAccess', {
    id: 'o_usr_list', uid: 'o_usr_list', status: '已开通', planKey: 'month', days: 30,
    expireAt: now() - 1000, openedAt: now() - 31 * 24 * 60 * 60 * 1000,
    staff: 'test', note: '过期样例'
  })
  const expiredDetail = await call(adminRouter, 'user.detail', { id: 'o_usr_list' }, adminCtx)
  ok(expiredDetail.ok && expiredDetail.data.tabs.membership.status === '已到期' &&
    expiredDetail.data.tabs.overview.memberStatus === '已到期',
    '过期会员在详情中显示已到期而不是已开通')
  const expiredList = await call(adminRouter, 'user.list', { q: targetUserNo }, adminCtx)
  ok(expiredList.ok && expiredList.data.items[0].memberStatus === '已到期', '过期会员在列表中显示已到期')

  const missing = await call(adminRouter, 'user.detail', { id: 'o_not_exist' }, adminCtx)
  ok(!missing.ok && missing.code === 'NOT_FOUND', '不存在的用户返回 NOT_FOUND')

  const csDemo = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'cs')
  const csLoginX = await call(adminRouter, 'admin.login', {
    username: 'cs', password: csDemo.password, otp: generateTotp(csDemo.totpSecret, now())
  }, {})
  const csCtxX = { token: csLoginX.data.token }
  /* 客服要在「用户账号」里找到具体用户，并在企微收款后手动开通商机会员时长 */
  const csList = await call(adminRouter, 'user.list', {}, csCtxX)
  ok(csList.ok && Array.isArray(csList.data.items), '客服可读取用户列表（便于按用户开通商机）')
  const csListJson = JSON.stringify(csList.data)
  ok(csListJson.indexOf('phoneCipher') < 0 && csListJson.indexOf('phoneBidx') < 0, '客服看到的用户列表同样不下发手机号密文与盲索引')
  const csDetailX = await call(adminRouter, 'user.detail', { id: 'o_usr_list' }, csCtxX)
  ok(csDetailX.ok, '客服可查看用户详情')
  const csGrant = await call(adminRouter, 'biz.grant', { uid: 'o_usr_list', days: 30 }, csCtxX)
  ok(csGrant.ok, '客服可为用户开通 / 续费商机会员时长')
  const csRevoke = await call(adminRouter, 'biz.revoke', { uid: 'o_usr_list' }, csCtxX)
  ok(!csRevoke.ok && csRevoke.code === 'FORBIDDEN', '客服停用商机会员被拒（仅管理员）')
  /* 系统设置涉及企微活码与套餐价格，仍只允许管理员保存 */
  const csSetting = await call(adminRouter, 'setting.save', {
    planPrice: '99 元 / 月', planDays: 30, siteName: '算力聚合'
  }, csCtxX)
  ok(!csSetting.ok && csSetting.code === 'FORBIDDEN', '客服保存系统设置被拒（仅管理员）')
}

/* ============================================================
   22.1 举报处置：客服可受理回复，但联动下架必须握有内容下架权限
   ============================================================ */
{
  const OWNER_R = { openid: 'o_report_owner', ip: '10.11.1.1' }
  const REPORTER_R = { openid: 'o_report_reporter', ip: '10.11.1.2' }
  await call(userRouter, 'auth.login', { nick: '被举报货主' }, OWNER_R)
  await call(userRouter, 'profile.save', {
    nick: '被举报货主', phone: '13500135000', realname: '举报甲',
    subject: '举报测试科技有限公司', city: '北京'
  }, OWNER_R)
  await call(userRouter, 'auth.login', { nick: '举报人' }, REPORTER_R)
  const rpProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: '举报用例商品', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'A100 40G', qty: 2, price: '88000', cond: '二手',
    tax: ['含税'], city: '北京', supply: '现货'
  }, OWNER_R)
  ok(rpProduct.ok, '举报用例商品已上架', JSON.stringify(rpProduct))
  const rid = rpProduct.data.id
  const report = await call(userRouter, 'report.create', {
    type: '举报', targetType: 'product', targetId: rid, targetTitle: '举报用例商品',
    content: '该商品图片与描述涉嫌虚假，请核实处理', contact: '13700137000'
  }, REPORTER_R)
  ok(report.ok && report.data.status === '待处理', '用户可提交商品举报')

  const csDemoR = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'cs')
  const csLoginR = await call(adminRouter, 'admin.login', {
    username: 'cs', password: csDemoR.password, otp: generateTotp(csDemoR.totpSecret, now())
  }, {})
  const csCtxR = { token: csLoginR.data.token }
  /* 受理弹窗要直接看到被举报内容：列表接口需带回商品正文、发布人、举报人 */
  const csListR = await call(adminRouter, 'report.list', { status: '待处理' }, csCtxR)
  const rpRow = (csListR.data.items || []).filter((x) => x.id === report.data.id)[0]
  ok(rpRow && rpRow.targetPreview && rpRow.targetPreview.title === '举报用例商品' && rpRow.targetPreview.city === '北京',
    '举报列表带回被举报商品正文（受理即可看到）', JSON.stringify(rpRow && rpRow.targetPreview))
  ok(rpRow && rpRow.targetPreview.owner && rpRow.targetPreview.owner.nick === '被举报货主',
    '举报列表带出商品发布人昵称', JSON.stringify(rpRow && rpRow.targetPreview && rpRow.targetPreview.owner))
  ok(rpRow && rpRow.reporter && rpRow.reporter.uid === rpRow.uid && rpRow.reporter.nick === '举报人',
    '举报列表带出举报人信息', JSON.stringify(rpRow && rpRow.reporter))
  const csReply = await call(adminRouter, 'report.handle', {
    id: report.data.id, status: '已处理', note: '已核实，商品信息已要求货主补充', targetAction: ''
  }, csCtxR)
  ok(csReply.ok, '客服可受理举报并回复用户（不动内容）')
  const stillOn = await repo.get('products', rid)
  ok(stillOn && stillOn.status === PRODUCT_STATUS.ON_SALE, '仅回复不联动内容时商品保持上架')
  const csOffline = await call(adminRouter, 'report.handle', {
    id: report.data.id, status: '已处理', note: '核实违规，联动下架', targetAction: 'offline'
  }, csCtxR)
  ok(csOffline.ok && csOffline.data.targetResult && csOffline.data.targetResult.to === PRODUCT_STATUS.OFFLINE,
    '客服可用举报单联动下架商品（已具备内容下架权限）', JSON.stringify(csOffline))
  const csOfflineProduct = await repo.get('products', rid)
  ok(csOfflineProduct && csOfflineProduct.status === PRODUCT_STATUS.OFFLINE, '联动下架后商品状态为已下架')

  const report2 = await call(userRouter, 'report.create', {
    type: '举报', targetType: 'product', targetId: rid, targetTitle: '举报用例商品',
    content: '同一商品再次举报，交由管理员下架核实', contact: '13700137000'
  }, REPORTER_R)
  const adminOffline = await call(adminRouter, 'report.handle', {
    id: report2.data.id, status: '已处理', note: '管理员核实后下架', targetAction: 'offline'
  }, { token: adminToken })
  ok(adminOffline.ok && adminOffline.data.targetResult && adminOffline.data.targetResult.to === PRODUCT_STATUS.OFFLINE,
    '管理员可按举报联动下架商品')
  const offDoc = await repo.get('products', rid)
  ok(offDoc && offDoc.status === PRODUCT_STATUS.OFFLINE, '下架后商品状态为已下架')

  /* 通知对象口径：举报人 / 发布人的用户ID 按 uid 现算，弹窗里能直接对上号 */
  ok(rpRow && /^U[23456789A-HJ-NP-Z]{8}$/.test((rpRow.reporter && rpRow.reporter.userNo) || ''),
    '举报列表举报人带用户ID（U 开头编号）', String(rpRow && rpRow.reporter && rpRow.reporter.userNo))
  ok(rpRow && /^U[23456789A-HJ-NP-Z]{8}$/.test((rpRow.targetPreview && rpRow.targetPreview.owner && rpRow.targetPreview.owner.userNo) || ''),
    '举报列表发布人带用户ID（U 开头编号）', String(rpRow && rpRow.targetPreview && rpRow.targetPreview.owner && rpRow.targetPreview.owner.userNo))

  /* 被举报对象是资讯：处置动作按类型走「下架资讯」，不能统一套「下架商品」 */
  await repo.insert('news', {
    id: 'NEWS_RP_CASE', uid: 'o_report_owner', title: '被举报资讯用例', content: '资讯正文内容',
    status: '已发布', createdAt: now(), updatedAt: now()
  })
  const newsReport = await call(userRouter, 'report.create', {
    type: '举报', targetType: 'news', targetId: 'NEWS_RP_CASE', targetTitle: '被举报资讯用例',
    content: '该资讯内容涉嫌违规，请核实处理', contact: '13700137000'
  }, REPORTER_R)
  ok(newsReport.ok, '用户可提交资讯举报')
  const newsHandled = await call(adminRouter, 'report.handle', {
    id: newsReport.data.id, status: '已处理', note: '资讯内容违规，已下架', targetAction: 'offline'
  }, { token: adminToken })
  ok(newsHandled.ok && newsHandled.data.targetResult && newsHandled.data.targetResult.to === '已下架',
    '举报资讯可联动下架资讯（状态 → 已下架）', JSON.stringify(newsHandled.data && newsHandled.data.targetResult))
  const newsAfter = await repo.get('news', 'NEWS_RP_CASE')
  ok(newsAfter && newsAfter.status === '已下架', '资讯下架后状态为已下架')

  /* 账号类处置：限制发布 / 资讯 / 对话，与内容下架互不替代 */
  const restrictReport = await call(userRouter, 'report.create', {
    type: '举报', targetType: 'product', targetId: rid, targetTitle: '举报用例商品',
    content: '同一账号多次发布违规内容，申请限制账号', contact: '13700137000'
  }, REPORTER_R)
  const restricted = await call(adminRouter, 'report.handle', {
    id: restrictReport.data.id, status: '已处理', note: '多次发布违规内容', targetAction: 'restrict', restrictDays: 7
  }, { token: adminToken })
  ok(restricted.ok && restricted.data.targetResult && restricted.data.targetResult.to === '限制 7 天',
    '举报处置可限制被举报账号（按天数）', JSON.stringify(restricted.data))
  const ownerDoc = await repo.get('users', 'o_report_owner')
  ok(ownerDoc && Number(ownerDoc.restrictions && ownerDoc.restrictions.publishUntil) > now(),
    '限制账号后发布 / 资讯 / 对话截止时间落库')
  ok(restricted.data.notified && restricted.data.notified.target === true && restricted.data.notified.reporter === true,
    '处置结果同时通知举报人与被举报人', JSON.stringify(restricted.data.notified))
  const rpNotices = await repo.find('outbox', {})
  ok(rpNotices.some((m) => m.payload && m.payload.uid === 'o_report_owner' && /账号功能已被限制/.test(m.payload.title || '')),
    '被举报人收到「账号功能已被限制」站内信')

  /* 账号类举报被驳回：也要通知被举报人，且文案不能是「账号已下架」 */
  const ownerReport = await call(userRouter, 'report.create', {
    type: '举报', targetType: 'owner', targetId: 'o_report_owner', targetTitle: '被举报货主',
    content: '该账号疑似冒用他人资质，请核实', contact: '13700137000'
  }, REPORTER_R)
  const ownerRejected = await call(adminRouter, 'report.handle', {
    id: ownerReport.data.id, status: '已驳回', note: '经核实资质真实，举报不成立'
  }, { token: adminToken })
  ok(ownerRejected.ok && ownerRejected.data.notified && ownerRejected.data.notified.target === true,
    '账号类举报被驳回时也会通知被举报人', JSON.stringify(ownerRejected.data && ownerRejected.data.notified))
  const rejectNotices = (await repo.find('outbox', {}))
    .filter((m) => m.payload && m.payload.uid === 'o_report_owner' && /未发现违规/.test(m.payload.title || ''))
  ok(rejectNotices.length >= 1, '被举报人收到「未发现违规」结论站内信')

  /* 会话类举报：targetId 是会话线程号时，按 leads.threadId 反查到咨询工单，列表点 ID 可直接打开 */
  await repo.insert('leads', {
    id: 'LD_RP_CHAT_CASE', threadId: 'TH_RP_CHAT_CASE', targetType: 'agency',
    serviceStage: 'communicating', agencyTitle: '举报用例委托 · A100 40G',
    uid: 'o_report_owner', assignedAccount: 'cs', assignedTo: '客服坐席',
    createdAt: now(), updatedAt: now()
  })
  const chatReport = await call(userRouter, 'report.create', {
    type: '举报', targetType: 'chat', targetId: 'TH_RP_CHAT_CASE', targetTitle: '咨询会话',
    content: '咨询会话中出现辱骂内容，请核实处理', contact: '13700137000'
  }, REPORTER_R)
  ok(chatReport.ok, '用户可提交会话类举报')
  const chatList = await call(adminRouter, 'report.list', { targetType: 'chat' }, { token: adminToken })
  const chatRow = (chatList.data.items || []).filter((x) => x.id === chatReport.data.id)[0]
  ok(chatRow && chatRow.targetLeadId === 'LD_RP_CHAT_CASE' &&
    chatRow.targetPreview && chatRow.targetPreview.status === '沟通中' &&
    chatRow.targetPreview.title === '举报用例委托 · A100 40G',
    '会话类举报按会话线程号反查到咨询工单（列表点 ID 可查看）',
    JSON.stringify(chatRow && { leadId: chatRow.targetLeadId, preview: chatRow.targetPreview }))
}

/* ============================================================
   23. 编辑商品 / 求购需求：属主可改、状态不变、终态不可改
   ============================================================ */
section('23. 编辑商品与求购需求')
{
  const OWNER = { openid: 'o_edit_owner', ip: '10.12.0.1' }
  const OTHER = { openid: 'o_edit_other', ip: '10.12.0.2' }
  await call(userRouter, 'auth.login', { nick: '编辑货主' }, OWNER)
  await call(userRouter, 'profile.save', {
    nick: '编辑货主', phone: '13600136000', realname: '编辑甲',
    subject: '编辑测试科技有限公司', city: '北京'
  }, OWNER)
  await call(userRouter, 'auth.login', { nick: '编辑旁观' }, OTHER)

  const baseProduct = {
    tradeMode: TRADE_MODES.SELL,
    title: '编辑前商品',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G',
    qty: 8, minQty: 1, price: '248000', cond: '全新',
    tax: ['含税'], city: '北京', supply: '现货', deliver: '7 天内',
    must: ['接受同台互验'], nego: [], flow: [], phone: '13800138000',
    media: [{ name: '设备正面.png', type: 'image/png', size: 204800 }]
  }
  const pub = await call(userRouter, 'product.publish', baseProduct, OWNER)
  ok(pub.ok && pub.data.status === PRODUCT_STATUS.ON_SALE, '编辑用例商品已直接上架')
  const pid = pub.data.id

  /* 发布页补充手机号：必须加密落库、仅属主可解密回填、管理端只得到脱敏值 */
  const phoneDoc = await repo.get('products', pid)
  ok(!!phoneDoc.ownerPhoneCipher && !!phoneDoc.ownerPhoneBidx, '发布补充手机号加密落库并生成盲索引')
  ok(String(phoneDoc.ownerPhoneCipher).indexOf('13800138000') < 0, '落库手机号为密文而非明文')
  const publicDetail = await call(userRouter, 'product.detail', { id: pid }, OTHER)
  ok(publicDetail.ok && JSON.stringify(publicDetail.data).indexOf('13800138000') < 0,
    '公开详情不下发货主手机号明文')

  const backfill = await call(userRouter, 'mine.publish.detail', { id: pid, kind: 'product' }, OWNER)
  ok(backfill.ok && backfill.data.id === pid, '属主可读取编辑回填数据')
  ok(backfill.data.phone === '13800138000', '编辑回填带回货主补充手机号（属主解密）')
  const adminDetail = await call(adminRouter, 'product.detail', { id: pid }, { token: adminToken })
  ok(adminDetail.ok && adminDetail.data.product && adminDetail.data.product.ownerPhoneMasked === '138****8000',
    '管理端审核详情展示脱敏手机号')
  ok(JSON.stringify(adminDetail.data).indexOf('13800138000') < 0, '管理端详情不下发明文手机号')
  ok((backfill.data.media || []).length === 1, '回填带回媒体等对外投影没有的字段')
  ok(typeof backfill.data.must !== 'undefined' && backfill.data.must.length === 1, '回填带回必须条件')
  ok(JSON.stringify(backfill.data).indexOf('ownerId') < 0, '回填不下发 ownerId')
  const otherBackfill = await call(userRouter, 'mine.publish.detail', { id: pid, kind: 'product' }, OTHER)
  ok(!otherBackfill.ok && otherBackfill.code === 'FORBIDDEN', '他人不能读取我的编辑回填数据')

  const edited = await call(userRouter, 'product.update', {
    ...baseProduct, id: pid, title: '编辑后商品', price: '268000', qty: 6
  }, OWNER)
  ok(edited.ok && edited.data.status === PRODUCT_STATUS.ON_SALE, '编辑已上架商品后状态保持在售（不重新进审核）')
  const afterEdit = await call(userRouter, 'product.detail', { id: pid }, OTHER)
  ok(afterEdit.ok && afterEdit.data.title === '编辑后商品' && String(afterEdit.data.price) === '268000',
    '编辑后的标题与价格立即对外生效')
  ok((afterEdit.data.media || []).length === 0, '公开详情不下发媒体等材料（隐私口径不变）')
  const editedDoc = await repo.get('products', pid)
  ok((editedDoc.media || []).length === 1, '编辑未上传新媒体时原媒体保留')
  const editAudit = await call(adminRouter, 'audit.list', { action: 'product.update' }, { token: adminToken })
  ok(editAudit.ok && editAudit.data.items.some((a) => a.action === 'product.update' && String(a.target) === pid),
    '编辑商品写入操作日志')

  const hacked = await call(userRouter, 'product.update', {
    ...baseProduct, id: pid, title: '他人篡改'
  }, OTHER)
  ok(!hacked.ok && hacked.code === 'FORBIDDEN', '非属主不能编辑商品')
  const missingEdit = await call(userRouter, 'product.update', {
    ...baseProduct, id: 'p_not_exist'
  }, OWNER)
  ok(!missingEdit.ok && missingEdit.code === 'NOT_FOUND', '编辑不存在的商品返回 NOT_FOUND')

  const baseDemand = {
    tradeMode: TRADE_MODES.BUY,
    title: '编辑前需求',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G',
    qty: 32, budget: '235000', tax: ['必须含税'],
    city: '北京', supply: '现货', cond: '全新'
  }
  const dpub = await call(userRouter, 'demand.publish', baseDemand, OWNER)
  ok(dpub.ok && dpub.data.status === DEMAND_STATUS.OPEN, '编辑用例需求已发布')
  const dedit = await call(userRouter, 'demand.update', {
    ...baseDemand, id: dpub.data.id, title: '编辑后需求', qty: 16, budget: '228000'
  }, OWNER)
  ok(dedit.ok && dedit.data.status === DEMAND_STATUS.OPEN, '编辑求购需求后状态保持求购中')
  const dafter = await call(userRouter, 'demand.detail', { id: dpub.data.id }, OTHER)
  ok(dafter.ok && dafter.data.title === '编辑后需求' && String(dafter.data.budget) === '228000',
    '需求编辑结果对其他用户立即生效')

  const closed = await call(adminRouter, 'demand.close', {
    demandId: dpub.data.id, reason: '编辑终态校验'
  }, { token: adminToken })
  ok(closed.ok && closed.data.to === DEMAND_STATUS.CLOSED, '需求可被平台关闭')
  const closedEdit = await call(userRouter, 'demand.update', {
    ...baseDemand, id: dpub.data.id, title: '关闭后仍想改'
  }, OWNER)
  ok(!closedEdit.ok && closedEdit.code === 'CONFLICT', '已关闭的需求不能再编辑')
}

/* ============================================================
   24. 交易服务：代采 / 代售、现货盘、资讯、商机权限
   ============================================================ */
section('24. 交易服务：代采 / 代售、现货盘、资讯与商机')
{
  const AGENT = { openid: 'o_mk_agent', ip: '10.20.0.1' }
  const SEEKER = { openid: 'o_mk_seeker', ip: '10.20.0.2' }
  const POOR = { openid: 'o_mk_poor', ip: '10.20.0.3' }

  await call(userRouter, 'auth.login', { nick: '委托方' }, AGENT)
  await call(userRouter, 'profile.save', { nick: '委托方', phone: '13900002222', realname: '赵敏', subject: '委托测试有限公司', position: '采购经理', exposure: 'open' }, AGENT)
  await call(userRouter, 'auth.login', { nick: '库存方' }, SEEKER)
  await call(userRouter, 'profile.save', { nick: '库存方', phone: '13700003333', realname: '钱进', subject: '库存测试有限公司', position: '采购经理', exposure: 'open' }, SEEKER)
  await call(userRouter, 'auth.login', { nick: '无库存' }, POOR)
  await call(userRouter, 'profile.save', { nick: '无库存', phone: '13600004444', realname: '孙空' }, POOR)

  /* 截止时间必填：缺失、过去、超过 365 天都拒绝；通过校验的截止日当天 23:59:59.999 到期 */
  const noDeadline = await call(userRouter, 'agency.submit', {
    side: 'buy', mode: TRADE_MODES.BUY, item: 'H100 80G SXM', qty: 1, price: 20000, deadline: ''
  }, USER3)
  ok(!noDeadline.ok && noDeadline.code === 'VALIDATION' && noDeadline.message === '请选择委托截止时间',
    '未选择截止时间时返回明确提示')
  const pastDeadline = await call(userRouter, 'agency.submit', {
    side: 'buy', mode: TRADE_MODES.BUY, item: 'H100 80G SXM', qty: 1, price: 20000,
    deadline: beijingDateText(Date.now() - 86400000)
  }, USER3)
  ok(!pastDeadline.ok && pastDeadline.code === 'VALIDATION', '截止时间早于今天被拒绝')

  /* ① 代采委托：服务费由服务端按成交金额重算，客户端传值无效 */
  const agencyPub = await call(userRouter, 'agency.submit', {
    side: 'buy',
    mode: TRADE_MODES.BUY,
    rental: false,
    term: [],
    item: 'H100 80G SXM',
    qty: 2,
    price: 20000,
    amount: 40000,
    serviceFee: 1,
    upfront: 0,
    detail: '求购两张整卡，接受同台互验，深圳面交',
    city: '深圳',
    subjectType: 'company',
    subject: '深圳算力互联科技有限公司',
    creditCode: '91440300MA5F12345X',
    legal: '赵敏',
    phone: '13900002222',
    authPhone: '13900002222',
    media: [
      { name: 'license.pdf', kind: 'license' },
      { name: 'proof.pdf', kind: 'proof' },
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }, AGENT)
  ok(agencyPub.ok, '代采委托提交成功' + (agencyPub.ok ? '' : `（${agencyPub.code || ''} ${agencyPub.message || ''}）`))
  ok(agencyPub.data.serviceFee === 400 && agencyPub.data.payNow === 0,
    '服务费按成交金额重算（40000 × 1% = 400），后付费且忽略客户端传的 1 元')
  ok(agencyPub.data.status === '待审核', '代采 / 代购提交后进入平台审核（待审核）')
  ok(agencyPub.data.payAmount === 0 && agencyPub.data.canCancel === true, '审核通过前不要求缴费，用户可自助撤销')
  ok(agencyPub.data.deadline === DEFAULT_AGENCY_DEADLINE && agencyPub.data.deadlineText === DEFAULT_AGENCY_DEADLINE,
    '委托返回截止时间字段')

  const agencyDoc = await repo.get('agencies', agencyPub.data.id)
  const agencyRaw = JSON.stringify(agencyDoc)
  ok(agencyRaw.indexOf('13900002222') < 0 && agencyRaw.indexOf('深圳算力互联科技有限公司') < 0,
    '委托主体与手机号明文不落库')
  ok(typeof agencyDoc.phoneCipher === 'string' && typeof agencyDoc.subjectMasked === 'string',
    '委托敏感字段以密文 + 脱敏值落库')
  ok(agencyDoc.media[0].name === 'license.pdf' && !agencyDoc.media[0].path, '委托材料只保留文件名')

  /* ①'' 1000 万元以上代采：不再免单，成交后按 0.5% 收；须亮明主体 + 资料齐全 */
  /* 独立账号：大额分支有 5 条 / 天提交限额，不能占用主委托方的配额 */
  const BIGAGENT = { openid: 'o_verify_big_agent' }
  await call(userRouter, 'auth.login', { nick: '大额委托方' }, BIGAGENT)
  const bigBase = {
    side: 'buy',
    mode: TRADE_MODES.BUY,
    item: 'H200 141G SXM',
    qty: 100,
    price: 200000,
    city: '深圳',
    subjectType: 'company',
    subject: '深圳算力互联科技有限公司',
    creditCode: '91440300MA5F12345X',
    legal: '赵敏',
    phone: '13900002222',
    media: [
      { name: 'license.pdf', kind: 'license' },
      { name: 'loi.pdf', kind: 'loi' },
      { name: 'proof.pdf', kind: 'proof' },
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }
  await call(userRouter, 'profile.save', { nick: '大额委托方', phone: '13900002222', realname: '赵敏', exposure: 'hidden' }, BIGAGENT)
  const bigNoAuthPhone = await call(userRouter, 'agency.submit', bigBase, BIGAGENT)
  ok(bigNoAuthPhone.ok, '未填授权书联系人电话时仍可提交（复用联系人手机号）' +
    (bigNoAuthPhone.ok ? '' : `（${bigNoAuthPhone.code || ''} ${bigNoAuthPhone.message || ''}）`))

  await call(userRouter, 'profile.save', { nick: '大额委托方', phone: '13900002222', realname: '赵敏', exposure: 'hidden' }, BIGAGENT)
  const bigMissing = await call(userRouter, 'agency.submit', Object.assign({}, bigBase, {
    media: [{ name: 'license.pdf', kind: 'license' }]
  }), BIGAGENT)
  ok(!bigMissing.ok && String(bigMissing.message || '').includes('请补齐必传材料'), '缺少意向函 / 授权书 / 身份证时被拒绝')

  const bigMismatch = await call(userRouter, 'agency.submit', Object.assign({}, bigBase, { authPhone: '13800000000' }), BIGAGENT)
  ok(bigMismatch.ok, '授权书电话与联系人电话不一致不再拦截提交')
  const bigMismatchDoc = bigMismatch.ok ? await repo.get('agencies', bigMismatch.data.id) : {}
  ok(bigMismatchDoc.authPhoneMatched === false, '不一致仅落库标记，交由客服审核核验')
  ok(typeof bigMismatchDoc.authPhoneCipher === 'string' && bigMismatchDoc.authPhoneCipher &&
    JSON.stringify(bigMismatchDoc).indexOf('13800000000') < 0 && bigMismatchDoc.authPhoneMasked === '138****0000',
    '授权书联系人电话加密落库并保留脱敏值')
  const bigMismatchDetail = await call(userRouter, 'agency.detail', { id: bigMismatch.data.id }, BIGAGENT)
  ok(bigMismatchDetail.ok && bigMismatchDetail.data.authPhone === '13800000000',
    '属主重新编辑时可回填授权书联系人电话（解密）')
  if (bigMismatch.ok) await call(userRouter, 'agency.cancel', { id: bigMismatch.data.id }, BIGAGENT)

  const bigOk = await call(userRouter, 'agency.submit', Object.assign({}, bigBase, { authPhone: '13900002222' }), BIGAGENT)
  ok(bigOk.ok, '资料齐全且电话一致时大额代采委托提交成功')
  ok(bigOk.data.serviceFee === 100000 && bigOk.data.payNow === 0 && bigOk.data.deferredFee === true,
    '1000 万元以上代采不免单：2000 万元 × 0.5% = 10 万元，成交后支付')
  const bigDoc = await repo.get('agencies', bigOk.data.id)
  ok(bigDoc.serviceFee === 100000 && bigDoc.largeAmount === true && !bigDoc.freeLarge &&
    bigDoc.authPhoneMatched === true && bigDoc.materialVerified === false,
    '大额委托落库为 0.5% 后付费 / 电话一致 / 资料待核验')
  ok(bigDoc.visibility === VISIBILITIES.PRIVATE, '1000 万元及以上代采强制保密，不进商机池 / 现货盘')
  await call(userRouter, 'agency.cancel', { id: bigOk.data.id }, BIGAGENT)
  await call(userRouter, 'profile.save', { nick: '大额委托方', phone: '13900002222', realname: '赵敏', exposure: 'hidden' }, BIGAGENT)

  /* ①' 用户自助撤销：未缴费可撤销，非属主不可操作，撤销后状态可查 */
  const agencyCancel = await call(userRouter, 'agency.submit', {
    side: 'sell',
    mode: TRADE_MODES.SELL,
    item: 'A100 40G PCIE',
    qty: 1,
    price: 50000,
    currency: 'USD',
    city: '广州',
    subjectType: 'person',
    subject: '赵敏',
    idCard: '440101199001011234',
    phone: '13900002222',
    authPhone: '13900002222',
    media: [
      { name: 'proof.pdf', kind: 'proof' },
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }, AGENT)
  ok(agencyCancel.ok && agencyCancel.data.canCancel === true, '未缴费的委托可自助撤销')
  ok(agencyCancel.data.currency === 'USD' && agencyCancel.data.currencySymbol === '$' &&
    agencyCancel.data.currencyLabel === '美元', '委托币种随单落库并回显（美元）')
  const cancelDoc = await repo.get('agencies', agencyCancel.data.id)
  ok(cancelDoc.currency === 'USD' && cancelDoc.currencySymbol === '$' && cancelDoc.currencyLabel === '美元',
    '委托币种持久化到委托单，详情与账单不会回退人民币')
  const adminAgencyRow = (await call(adminRouter, 'agency.list', { keyword: 'A100 40G PCIE' },
    { token: adminToken })).data.items.filter((row) => row.id === agencyCancel.data.id)[0]
  ok(!!adminAgencyRow && adminAgencyRow.authPhoneMasked === '139****2222' &&
    adminAgencyRow.currencyLabel === '美元', '管理端委托列表展示授权书电话（脱敏）与币种')
  const cancelByOther = await call(userRouter, 'agency.cancel', { id: agencyCancel.data.id }, SEEKER)
  ok(!cancelByOther.ok && cancelByOther.code === 'FORBIDDEN', '非属主不能撤销他人委托')
  const cancelOk = await call(userRouter, 'agency.cancel', { id: agencyCancel.data.id }, AGENT)
  ok(cancelOk.ok && cancelOk.data.status === '已关闭' && cancelOk.data.selfClosed === true,
    '撤销后委托关闭并标记为本人撤销')
  const cancelAgain = await call(userRouter, 'agency.cancel', { id: agencyCancel.data.id }, AGENT)
  ok(!cancelAgain.ok && cancelAgain.code === 'CONFLICT', '已结束的委托不能重复撤销')
  const mineAgency = await call(userRouter, 'agency.mine', {}, AGENT)
  ok(mineAgency.ok && mineAgency.data.items.some((a) => a.id === agencyCancel.data.id && a.status === '已关闭'),
    '我的委托可查到撤销结果')

  const boardBefore = await call(userRouter, 'agency.board', {}, SEEKER)
  ok(boardBefore.ok && !boardBefore.data.items.some((i) => i.model === 'H100 80G SXM'),
    '未确认到账的委托不进入现货盘')

  /* 客服登录：确认到账 → 现货盘可见 */
  const csDemoMk = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'cs')
  const csLoginMk = await call(adminRouter, 'admin.login', {
    username: 'cs', password: csDemoMk.password, otp: generateTotp(csDemoMk.totpSecret, now())
  }, {})
  const csCtxMk = { token: csLoginMk.data.token }

  const csAgencyList = await call(adminRouter, 'agency.list', {}, csCtxMk)
  ok(csAgencyList.ok, '客服可访问代采 / 代售委托列表')
  ok(csAgencyList.data.items.some((i) => i.id === agencyPub.data.id && i.ownerNick === '委托方'),
    '代采工单在管理端带出委托方昵称')
  const csAgencyUpdate = await call(adminRouter, 'agency.update', {
    id: agencyPub.data.id, side: 'buy', mode: TRADE_MODES.BUY, item: 'H100 80G SXM',
    qty: 2, price: 20000, city: '深圳', detail: '求购两张整卡，接受同台互验，深圳面交'
  }, csCtxMk)
  ok(csAgencyUpdate.ok, '客服可修改代采 / 代售委托内容（委托一线运营权限）', JSON.stringify(csAgencyUpdate))
  const csAgencyClose = await call(adminRouter, 'agency.close', { id: agencyPub.data.id }, csCtxMk)
  ok(!csAgencyClose.ok && csAgencyClose.code === 'CONFLICT', '客服关闭委托不再被角色拦截（待审核状态返回状态冲突）')

  /* ①''' 租赁服务费：一个月租金，买卖双方各承担 50%，委托方账单只收半个月租金；
     不限金额，千万元以上同样按半个月租金，不改按 0.5% */
  const RENTAGENT = { openid: 'o_verify_rent_agent' }
  await call(userRouter, 'auth.login', { nick: '租赁委托方' }, RENTAGENT)
  await call(userRouter, 'profile.save', {
    nick: '租赁委托方', phone: '13900003333', realname: '钱磊', exposure: 'hidden'
  }, RENTAGENT)
  const rentBase = {
    side: 'sell',
    mode: TRADE_MODES.RENT,
    term: '6 个月',
    item: 'H100 80G SXM',
    qty: 2,
    price: 60000,
    city: '深圳',
    subjectType: 'person',
    subject: '钱磊',
    idCard: '440101199001011234',
    phone: '13900003333',
    authPhone: '13900003333',
    media: [
      { name: 'proof.pdf', kind: 'proof' },
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }
  const rentPub = await call(userRouter, 'agency.submit', rentBase, RENTAGENT)
  ok(rentPub.ok && rentPub.data.rental === true, '租赁委托提交成功')
  ok(rentPub.data.serviceFee === 60000 && rentPub.data.payNow === 0 && rentPub.data.deferredFee === true,
    '租赁服务费为一个月租金、委托方承担 50%：60000 × 2 台 × 50% = 6 万，成交后支付',
    (rentPub.ok ? `serviceFee=${rentPub.data.serviceFee}` : rentPub.code + ': ' + rentPub.message))
  const rentDoc = await repo.get('agencies', rentPub.data.id)
  ok(rentDoc.largeAmount !== true && rentDoc.deferredFee === true && rentDoc.serviceFee === 60000,
    '租赁委托落库为后付费，且不标记为大额 0.5% 计费')

  /* 首月租金合计 1200 万元：租赁仍只收半个月租金，不按 0.5% */
  const rentBig = await call(userRouter, 'agency.submit', Object.assign({}, rentBase, {
    side: 'buy', mode: TRADE_MODES.LEASE, term: '12 个月', qty: 2, price: 6000000
  }), RENTAGENT)
  ok(rentBig.ok && rentBig.data.serviceFee === 6000000 && rentBig.data.payNow === 0,
    '首月租金 1200 万元的租赁仍按半个月租金收 600 万元，不改按 0.5% 计费',
    (rentBig.ok ? `serviceFee=${rentBig.data.serviceFee}` : rentBig.code + ': ' + rentBig.message))
  const rentBigDoc = await repo.get('agencies', rentBig.data.id)
  ok(rentBigDoc.largeAmount !== true, '大额租赁不触发大额资料核验与 0.5% 标记')
  await call(userRouter, 'agency.cancel', { id: rentBig.data.id }, RENTAGENT)

  /* 成交后账单业务类型为「租赁服务费」，金额等于委托方应承担的半个月租金。
     租赁委托同样不能在委托页直接点成交，必须走工单流程（条件 → 合同归档 → 登记成交）。 */
  await call(adminRouter, 'agency.review', { id: rentPub.data.id, decision: '通过' }, csCtxMk)
  const RENT_LEAD = 'ld_rent_flow'
  await repo.insert('leads', {
    id: RENT_LEAD, uid: SEEKER.openid, targetType: 'agency', targetId: rentPub.data.id, agencyId: rentPub.data.id,
    agencyTitle: '出租 H100 80G SXM', agencySide: 'sell', status: LEAD_STATUS.PENDING,
    csStatus: '待领取', csClaimedAt: 0, assignedTo: '', assignedAccount: '', threadId: RENT_LEAD,
    ticketState: TICKET_STATE.TICKETED, serviceStage: 'communicating', stageAt: CLOCK, stageVersion: 0,
    createdAt: CLOCK, updatedAt: CLOCK
  })
  await call(adminRouter, 'lead.claim', { leadId: RENT_LEAD }, csCtxMk)
  await repo.insert('outbox', {
    id: 'M_mk_rent_user_chat',
    type: 'kf.chat',
    payload: {
      uid: SEEKER.openid, channel: 'kf', from: 'user', threadId: RENT_LEAD,
      targetType: 'agency', targetId: rentPub.data.id, title: '租赁 H100', body: '可以按半年租期签'
    },
    status: 'read',
    createdAt: CLOCK + 30
  })
  const rentTerms = await call(adminRouter, 'consult.terms', {
    leadId: RENT_LEAD, amount: 120000, delivery: '深圳面交', payment: '对公转账', condition: '验收后付款'
  }, csCtxMk)
  ok(rentTerms.ok && rentTerms.data.stage === 'terms', '租赁工单确认交易条件')
  const rentContract = await call(adminRouter, 'consult.contractSubmit', {
    leadId: RENT_LEAD, fileId: 'https://cdn.example.com/rent-contract.pdf', fileName: '租赁居间合同.pdf', signDate: '2026-02-26'
  }, csCtxMk)
  ok(rentContract.ok && rentContract.data.stage === 'contract', '租赁工单上传居间合同')
  await call(adminRouter, 'contract.lock', { leadId: RENT_LEAD }, csCtxMk)
  await call(adminRouter, 'contract.review', { leadId: RENT_LEAD, decision: 'approve' }, { token: adminToken })
  const rentDeal = await call(adminRouter, 'consult.proposeDeal', { leadId: RENT_LEAD, amount: 120000 }, csCtxMk)
  ok(rentDeal.ok && rentDeal.data.stage === 'fee', '租赁委托按工单流程登记成交')
  const rentBill = (await repo.find('payments', { agencyId: rentPub.data.id }, { limit: 1 }))[0]
  ok(!!rentBill && rentBill.bizType === '租赁服务费' && rentBill.amount === 60000,
    '租赁成交后账单业务类型为「租赁服务费」，金额为半个月租金 6 万')

  /* 代采工单：客服审核通过 → 已通过 → 平台按工单联系方式联系用户 → 上架 */
  const reviewByUser = await call(userRouter, 'agency.review', { id: agencyPub.data.id, decision: '通过' }, AGENT)
  ok(!reviewByUser.ok, '用户端不可自行审核工单')
  const reviewList = await call(adminRouter, 'agency.list', { status: '待审核' }, csCtxMk)
  ok(reviewList.ok && reviewList.data.items.some((i) => i.id === agencyPub.data.id),
    '管理端工单列表可按「待审核」筛出代采工单')
  const reviewed = await call(adminRouter, 'agency.review', { id: agencyPub.data.id, decision: '通过' }, csCtxMk)
  ok(reviewed.ok && reviewed.data.status === '已上架' && reviewed.data.approvedAt > 0 &&
    reviewed.data.confirmedAt > 0, '客服审核通过后直接上架（不再要求确认付款）')
  const reviewAgain = await call(adminRouter, 'agency.review', { id: agencyPub.data.id, decision: '通过' }, csCtxMk)
  ok(!reviewAgain.ok && reviewAgain.code === 'CONFLICT', '同一工单不能重复审核')
  const reviewOutbox = await repo.find('outbox', {})
  ok(reviewOutbox.some((m) => m.payload && m.payload.uid === AGENT.openid &&
    String(m.payload.title || '').indexOf('审核通过') > -1), '审核通过后通知委托方等待平台联系')

  const revealNoReason = await call(adminRouter, 'agency.reveal', { id: agencyPub.data.id }, csCtxMk)
  ok(!revealNoReason.ok && revealNoReason.code === 'VALIDATION', '查看工单联系方式必须填写原因')
  const reveal = await call(adminRouter, 'agency.reveal', { id: agencyPub.data.id, reason: '审核通过后联系委托方' }, csCtxMk)
  ok(reveal.ok && reveal.data.phone === '13900002222', '审核通过后可解密委托方联系方式（留痕）')

  /* 驳回工单：必须写原因，驳回后不再释放联系方式 */
  const rejectTarget = await call(userRouter, 'agency.submit', {
    side: 'buy',
    mode: TRADE_MODES.BUY,
    item: 'A100 80G SXM',
    qty: 1,
    price: 90000,
    city: '上海',
    subjectType: 'person',
    subject: '赵敏',
    idCard: '440101199001011234',
    phone: '13900002222',
    authPhone: '13900002222',
    media: [
      { name: 'proof.pdf', kind: 'proof' },
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }, AGENT)
  ok(rejectTarget.ok && rejectTarget.data.status === '待审核', '第二条代采工单同样进入待审核')
  const rejectNoNote = await call(adminRouter, 'agency.review', { id: rejectTarget.data.id, decision: '驳回' }, csCtxMk)
  ok(!rejectNoNote.ok && rejectNoNote.code === 'VALIDATION', '驳回工单必须填写原因')
  const rejectOk = await call(adminRouter, 'agency.review', {
    id: rejectTarget.data.id, decision: '驳回', note: '需求描述不清晰'
  }, csCtxMk)
  ok(rejectOk.ok && rejectOk.data.status === '已驳回' && rejectOk.data.reason === '需求描述不清晰',
    '驳回后工单状态为已驳回并记录原因')
  const revealRejected = await call(adminRouter, 'agency.reveal', { id: rejectTarget.data.id, reason: '复核资料' }, csCtxMk)
  ok(!revealRejected.ok, '已驳回工单不可查看联系方式')

  /* 驳回后的自助处理：本人可看详情回填、重新提交、删除；他人不可操作 */
  const rejectedDetail = await call(userRouter, 'agency.detail', { id: rejectTarget.data.id }, AGENT)
  ok(rejectedDetail.ok && rejectedDetail.data.phone === '13900002222' &&
    rejectedDetail.data.canResubmit === true && rejectedDetail.data.canDelete === true,
  '被驳回的委托本人可读回填信息，并带重新提交 / 删除能力位')
  const detailByOther = await call(userRouter, 'agency.detail', { id: rejectTarget.data.id }, SEEKER)
  ok(!detailByOther.ok && detailByOther.code === 'FORBIDDEN', '他人不可查看被驳回的委托详情')

  const resubmitInput = {
    id: rejectTarget.data.id,
    side: 'buy',
    mode: TRADE_MODES.BUY,
    item: 'A100 80G SXM',
    qty: 1,
    price: 95000,
    city: '上海',
    subjectType: 'person',
    subject: '赵敏',
    idCard: '440101199001011234',
    phone: '13900002222',
    authPhone: '13900002222',
    media: [
      { name: 'proof.pdf', kind: 'proof' },
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }
  const resubmitted = await call(userRouter, 'agency.submit', resubmitInput, AGENT)
  ok(resubmitted.ok && resubmitted.data.resubmitted === true && resubmitted.data.id === rejectTarget.data.id &&
    resubmitted.data.status === '待审核' && resubmitted.data.price === 95000,
  '被驳回的委托可原地重新提交，回到待审核')
  const resubmitAgain = await call(userRouter, 'agency.submit', resubmitInput, AGENT)
  ok(!resubmitAgain.ok && resubmitAgain.code === 'CONFLICT', '非驳回状态不可再次走重新提交')
  const deleteBeforeReject = await call(userRouter, 'agency.delete', { id: rejectTarget.data.id }, AGENT)
  ok(!deleteBeforeReject.ok && deleteBeforeReject.code === 'CONFLICT', '未驳回的委托不可删除')

  await call(adminRouter, 'agency.review', {
    id: rejectTarget.data.id, decision: '驳回', note: '材料仍不清晰'
  }, csCtxMk)
  const deleteByOther = await call(userRouter, 'agency.delete', { id: rejectTarget.data.id }, SEEKER)
  ok(!deleteByOther.ok && deleteByOther.code === 'FORBIDDEN', '他人不可删除被驳回的委托')
  const deleteOk = await call(userRouter, 'agency.delete', { id: rejectTarget.data.id }, AGENT)
  ok(deleteOk.ok && deleteOk.data.deleted === true, '本人可删除被驳回的委托')
  const mineAfterDelete = await call(userRouter, 'agency.mine', {}, AGENT)
  ok(mineAfterDelete.ok && !mineAfterDelete.data.items.some((i) => i.id === rejectTarget.data.id),
    '删除后不再出现在我的委托')


  const confirmed = await call(adminRouter, 'agency.confirm', { id: agencyPub.data.id }, csCtxMk)
  ok(confirmed.ok && confirmed.data.status === '已上架', '审核通过后确认上架接口保持幂等兼容')
  ok(confirmed.data.expiresAt === Date.parse(DEFAULT_AGENCY_DEADLINE + 'T23:59:59.999+08:00'),
    '委托合同期即截止日当天 23:59:59.999')
  const confirmAgain = await call(adminRouter, 'agency.confirm', { id: agencyPub.data.id }, csCtxMk)
  ok(confirmAgain.ok && confirmAgain.data.status === '已上架', '重复确认上架幂等且不再校验付款')

  const outboxAfterConfirm = await repo.find('outbox', {})
  ok(outboxAfterConfirm.some((m) => m.payload && m.payload.uid === AGENT.openid &&
    `${m.payload.title || ''}${m.payload.body || ''}`.indexOf('已上架') > -1), '委托上架给委托方发站内信回执')

  const boardAfter = await call(userRouter, 'agency.board', {}, SEEKER)
  ok(boardAfter.ok && !boardAfter.data.items.some((i) => i.model === 'H100 80G SXM'),
    '代采委托上架后只进入商机池，不进入现货盘')

  /* ② 粘贴报价：只存结构化条目，现货盘取最低卖价 */
  const quotePub = await call(userRouter, 'quote.paste', {
    raw: '原始长文本：H100 80G SXM 23 万，深圳现货，可议价 13900002222',
    items: [{ cat: '其他', model: 'H100 80G SXM', price: 230000, city: '深圳' }]
  }, SEEKER)
  ok(quotePub.ok && quotePub.data.itemCount === 1, '粘贴报价解析成功')
  const quoteDoc = await repo.get('quotes', quotePub.data.id)
  const quoteRaw = JSON.stringify(quoteDoc)
  ok(!('raw' in quoteDoc) && quoteRaw.indexOf('原始长文本') < 0, '粘贴报价原始长文本不落库')
  ok(quoteRaw.indexOf('13900002222') < 0, '粘贴报价中的手机号被拒绝 / 不入库')

  /* 客户端粘贴解析：支持「万」量级；没写城市不生成占位假城市；0 价不允许落库 */
  const { parseQuoteLine } = require(path.join(here, '..', 'miniprogram', 'utils', 'board.js'))
  const wanRow = parseQuoteLine('H100 SXM 22万 8张 上海')
  ok(!!wanRow && wanRow.price === 220000, '报价解析支持「万」量级（22万 → 220000）')
  ok(!!wanRow && wanRow.model.indexOf('22万') < 0 && wanRow.city === '上海' && wanRow.qty === '8',
    '万级价格不混入型号，数量与城市解析正确')
  const yuanRow = parseQuoteLine('DDR5 64G 6400 金百达 ¥1850 200根 杭州')
  ok(!!yuanRow && yuanRow.price === 1850 && yuanRow.city === '杭州', '报价解析兼容 ¥ 元级价格')
  const noCityRow = parseQuoteLine('A100 80G PCIE 96000元')
  ok(!!noCityRow && noCityRow.price === 96000 && noCityRow.city === '', '未写城市时留空，不生成占位城市分组')
  const zeroQuote = await call(userRouter, 'quote.paste', {
    items: [{ cat: '其他', model: 'H100 80G SXM', price: 0, city: '深圳' }]
  }, SEEKER)
  ok(!zeroQuote.ok && zeroQuote.code === 'VALIDATION', '0 价报价被拒绝落库（避免货盘假盘口）')

  const boardSell = await call(userRouter, 'agency.board', {}, SEEKER)
  const sellRow = boardSell.data.items.find((i) => i.model === 'H100 80G SXM')
  ok(!!sellRow && sellRow.sellPrice === 230000, '现货盘聚合粘贴报价卖价')
  ok(!!sellRow && Number(sellRow.priceLevel) > 0 && !!sellRow.priceLevelText,
    '现货盘输出最终价格水平（货盘基准 + 报价）')
  ok(!!sellRow && Number(sellRow.priceLow) > 0 &&
    Number(sellRow.priceLow) <= Number(sellRow.priceHigh) && !!sellRow.confidenceText,
    '价格水平给出参考区间与置信度')

  /* 求购需求接入买方盘口：预算取上限、数量累加，且不泄漏求购方身份 */
  const buyDemand = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY,
    title: '现货盘买方需求 H100',
    cat: 'GPU 加速卡', brand: 'NVIDIA', model: 'H100 80G SXM',
    qty: 6, budget: '236000', tax: ['含税'],
    city: '深圳', supply: '现货', cond: '全新'
  }, OWNER)
  ok(buyDemand.ok, '求购需求发布成功（现货盘买方数据源）')
  const boardBuy = await call(userRouter, 'agency.board', {}, SEEKER)
  const buyRow = boardBuy.data.items.find((i) => i.model === 'H100 80G SXM')
  ok(!!buyRow && Number(buyRow.buyPrice) >= 236000, '现货盘买方价取自求购预算（不再恒为空）')
  const buyRowText = JSON.stringify(buyRow || {})
  ok(buyRowText.indexOf('o_user_owner') < 0 && buyRowText.indexOf('139') < 0,
    '现货盘买方聚合不泄漏求购方身份与联系方式')

  const priceLevels = await call(adminRouter, 'price.levels', { limit: 50 }, csCtxMk)
  ok(priceLevels.ok && priceLevels.data.items.some((i) => i.model === 'H100 80G SXM' && i.priceLevel > 0),
    '管理端价格水平页可读取货盘定价结果')
  ok(priceLevels.ok && priceLevels.data.totals.withLevel >= 1, '价格水平汇总统计有数据')

  /* ③ 资讯：用户投稿自动筛查违禁词，通过即发布；发布 / 下架归客服日常运营，审核仍归管理员 */
  const newsSub = await call(userRouter, 'news.submit', {
    title: 'H100 现货行情周报',
    content: '本周 H100 整卡现货价格小幅回落，租赁需求稳定，建议按周锁价。',
    city: '深圳'
  }, SEEKER)
  ok(newsSub.ok && newsSub.data.status === '已发布', '资讯通过基础筛查后直接发布，无需人工审核')

  const userNews0 = await call(userRouter, 'news.list', {}, SEEKER)
  ok(userNews0.data.items.some((n) => n.title === 'H100 现货行情周报'), '发布后的资讯立即对用户可见')

  /* 朋友圈式媒体：9 图 + 1 视频可发布，媒体与点赞 / 评论数随列表直接下发 */
  const mediaItems = []
  for (let i = 1; i <= 9; i += 1) {
    mediaItems.push({ name: '机房 ' + i, type: 'image/jpeg', size: 1024 * 200, fileId: 'https://cdn.example.com/news/p' + i + '.jpg' })
  }
  mediaItems.push({ name: '开箱视频', type: 'video/mp4', size: 1024 * 1024 * 5, fileId: 'https://cdn.example.com/news/v1.mp4' })
  const newsMedia = await call(userRouter, 'news.submit', {
    title: 'H100 机房实拍图集',
    content: '机房实拍与开箱视频，供同行参考选型。',
    city: '深圳',
    media: mediaItems
  }, SEEKER)
  ok(newsMedia.ok, '资讯支持图片 + 视频混合发布')
  const listMedia = await call(userRouter, 'news.list', {}, SEEKER)
  const mediaHit = listMedia.data.items.filter((n) => n.title === 'H100 机房实拍图集')[0]
  ok(mediaHit && mediaHit.mediaCount === 10 &&
    mediaHit.media.filter((m) => m.kind === 'image').length === 9 &&
    mediaHit.media.filter((m) => m.kind === 'video').length === 1,
  '资讯列表下发 9 图 + 1 视频媒体')

  const tooManyVideos = await call(userRouter, 'news.submit', {
    title: '两段视频超限用例',
    content: '这条资讯用于验证视频数量上限，应该被拒绝。',
    city: '深圳',
    media: [mediaItems[9], Object.assign({}, mediaItems[9], { name: '第二段' })]
  }, SEEKER)
  ok(!tooManyVideos.ok && tooManyVideos.code === 'VALIDATION', '资讯最多上传 1 段视频')

  const newsLike = await call(userRouter, 'news.like', { id: newsSub.data.id, on: true }, SEEKER)
  ok(newsLike.ok && newsLike.data.likes === 1, '资讯可点赞')
  const listAfterLike = await call(userRouter, 'news.list', {}, SEEKER)
  const likedHit = listAfterLike.data.items.filter((n) => n.id === newsSub.data.id)[0]
  ok(likedHit && likedHit.liked === true && likedHit.likes === 1, '资讯列表返回点赞数与我的点赞态')

  /* 社交总开关默认关闭：先打开再验证评论链路，末尾关闭并验证服务端拦截 */
  await call(adminRouter, 'setting.save', { socialEnabled: true }, { token: adminToken })

  /* 评论链路：可评论 / 回复；删除根评论级联隐藏回复；下架后禁止读评论 */
  const cRoot = await call(userRouter, 'news.comment.add', {
    id: newsSub.data.id,
    content: '这条行情对采购很有参考价值'
  }, SEEKER)
  ok(cRoot.ok && !!cRoot.data.id, '已发布资讯可发表评论')
  const cReply = await call(userRouter, 'news.comment.add', {
    id: newsSub.data.id,
    content: '同感，本周价格确实回落了',
    parentId: cRoot.data.id
  }, SEEKER)
  ok(cReply.ok, '可回复已有评论')
  const cList0 = await call(userRouter, 'news.comment.list', { id: newsSub.data.id }, SEEKER)
  ok(cList0.ok && cList0.data.total === 2 && cList0.data.items.length === 1 &&
    cList0.data.items[0].replies.length === 1, '评论列表返回根评论及其回复')
  const listComments = await call(userRouter, 'news.list', {}, SEEKER)
  const commentHit = listComments.data.items.filter((n) => n.id === newsSub.data.id)[0]
  ok(commentHit && commentHit.commentCount === 2, '资讯列表直接返回评论数')
  const cDel = await call(userRouter, 'news.comment.delete', { id: cRoot.data.id }, SEEKER)
  ok(cDel.ok, '可删除自己的评论')
  const cList1 = await call(userRouter, 'news.comment.list', { id: newsSub.data.id }, SEEKER)
  ok(cList1.ok && cList1.data.total === 0 && cList1.data.items.length === 0,
    '删除根评论后回复一并隐藏，评论数归零')

  /* 关闭社交总开关：评论发表 / 读取 / 私聊全部被服务端拒绝，用户端拿到关闭状态 */
  await call(adminRouter, 'setting.save', { socialEnabled: false }, { token: adminToken })
  const socialOffAdd = await call(userRouter, 'news.comment.add', {
    id: newsSub.data.id,
    content: '开关关闭后不应允许评论'
  }, SEEKER)
  ok(!socialOffAdd.ok && socialOffAdd.code === 'FORBIDDEN', '社交总开关关闭后评论发表被拒绝')
  const socialOffList = await call(userRouter, 'news.comment.list', { id: newsSub.data.id }, SEEKER)
  ok(socialOffList.ok && socialOffList.data.enabled === false && socialOffList.data.total === 0,
    '社交总开关关闭后评论列表不再下发内容')
  const socialOffSite = await call(userRouter, 'site.get', {}, SEEKER)
  ok(socialOffSite.ok && socialOffSite.data.site.socialEnabled === false &&
    socialOffSite.data.site.chatEnabled === false, '社交总开关关闭后 site.get 下发关闭状态')
  const socialOffThread = await call(userRouter, 'msg.thread', { threadId: 'none' }, SEEKER)
  ok(!socialOffThread.ok && socialOffThread.code === 'FORBIDDEN', '社交总开关关闭后会话读取被拒绝')
  await call(adminRouter, 'setting.save', { socialEnabled: true }, { token: adminToken })

  const badNews = await call(userRouter, 'news.submit', {
    title: '测试违禁词拦截',
    content: '这里写着赌博和色情等违禁内容，应该被系统自动驳回。',
    city: '深圳'
  }, SEEKER)
  ok(!badNews.ok && badNews.code === 'VALIDATION' && /违禁词/.test(badNews.message || ''),
    '命中违禁词自动驳回')

  const userNews1 = await call(userRouter, 'news.list', {}, SEEKER)
  ok(!userNews1.data.items.some((n) => n.title === '测试违禁词拦截'), '被自动驳回的资讯不入库、不对外展示')

  const csNewsReview = await call(adminRouter, 'news.review', { id: newsSub.data.id, decision: '通过' }, csCtxMk)
  ok(!csNewsReview.ok && csNewsReview.code === 'FORBIDDEN', '客服审核资讯被拒（仅管理员）')

  const newsOff = await call(adminRouter, 'news.offline', { id: newsSub.data.id, reason: '内容过期' }, { token: adminToken })
  ok(newsOff.ok && newsOff.data.status === '已下架', '管理员可下架已发布资讯')

  const closedComments = await call(userRouter, 'news.comment.list', { id: newsSub.data.id }, SEEKER)
  ok(!closedComments.ok && closedComments.code === 'NOT_FOUND', '已下架资讯不再开放评论读取')

  const userNews2 = await call(userRouter, 'news.list', {}, SEEKER)
  ok(!userNews2.data.items.some((n) => n.title === 'H100 现货行情周报'), '已下架资讯不再对外展示')

  /* 资讯发布 / 下架归属客服日常运营，审核与定时设置仍仅管理员 */
  const newsSub2 = await call(userRouter, 'news.submit', {
    title: '客服日常运营下架用例',
    content: '这条资讯用于验证客服可以下架违规或过期内容。',
    city: '深圳'
  }, SEEKER)
  const csNewsOffline = await call(adminRouter, 'news.offline', { id: newsSub2.data.id, reason: '内容过期' }, csCtxMk)
  ok(csNewsOffline.ok && csNewsOffline.data.status === '已下架', '客服可下架资讯（日常运营）')

  /* ④ 商机权限：99 元 / 月，客服收款后开通；领取需「已开通 + 库存匹配」 */
  /* 代采 / 代售不提供可见范围与发布渠道选择：1000 万元及以上代采落为保密，
     其余由平台统一公开匹配；另建一条公开代售委托验证商机领取链路 */
  const poolAgency = await call(userRouter, 'agency.submit', {
    side: 'sell',
    mode: TRADE_MODES.SELL,
    item: 'H100 80G SXM',
    qty: 1,
    price: 200000,
    city: '深圳',
    subjectType: 'person',
    subject: '赵敏',
    idCard: '440101199001011234',
    phone: '13900002222',
    authPhone: '13900002222',
    media: [
      { name: 'proof.pdf', kind: 'proof' },
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }, AGENT)
  ok(poolAgency.ok && (await repo.get('agencies', poolAgency.data.id)).visibility === VISIBILITIES.PUBLIC,
    '代售委托不提供可见范围选择，统一由平台公开匹配')
  /* 代售与代采统一先审核：审核通过后再确认服务费到账并上架 */
  const poolReview = await call(adminRouter, 'agency.review', { id: poolAgency.data.id, decision: '通过' }, csCtxMk)
  ok(poolReview.ok, '公开代售委托平台审核通过')
  await call(adminRouter, 'agency.confirm', { id: poolAgency.data.id }, csCtxMk)

  const status0 = await call(userRouter, 'biz.status', {}, SEEKER)
  ok(status0.ok && status0.data.unlocked === false && status0.data.status === '未开通', '新用户商机权限未开通')

  const claim0 = await call(userRouter, 'biz.claim', { targetType: 'agency', agencyId: poolAgency.data.id }, SEEKER)
  ok(!claim0.ok && claim0.code === 'CONFLICT', '未开通商机时领取被拒')

  await call(userRouter, 'stock.save', {
    cat: '其他', model: 'H100 80G SXM', qty: 5, price: 210000, city: '深圳'
  }, SEEKER)

  /* 另有一条与库存无关的公开求购，用于验证「所有已发布需求都进商机池」 */
  await repo.insert('demands', {
    id: 'd_mk_open',
    ownerId: AGENT.openid,
    tradeMode: TRADE_MODES.BUY,
    title: '求购 B200 整机',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'B200',
    qty: 2,
    budget: 150000,
    city: '北京',
    status: DEMAND_STATUS.OPEN,
    bizPool: true,
    deleted: false,
    createdAt: now(),
    updatedAt: now()
  })

  /* 代售＝平台代卖，匹配需求方：SEEKER 发布一条能对上代售委托的求购 */
  await repo.insert('demands', {
    id: 'd_mk_seeker_h100',
    ownerId: SEEKER.openid,
    tradeMode: TRADE_MODES.BUY,
    title: '求购 H100',
    cat: '其他',
    model: 'H100 80G SXM',
    qty: 1,
    budget: 200000,
    city: '深圳',
    status: DEMAND_STATUS.OPEN,
    deleted: false,
    createdAt: now(),
    updatedAt: now()
  })

  const list0 = await call(userRouter, 'biz.list', {}, SEEKER)
  const mkItem0 = list0.data.items.find((i) => i.type === 'agency' && i.id === poolAgency.data.id)
  ok(!!mkItem0 && mkItem0.matched === true && mkItem0.matchVia === '我的需求',
    '商机池按我发布的需求匹配出公开代售委托')
  /* 代采 / 代售统一走「先确认交易流程条件 → 领取 → 平台对接」 */
  const buyItem0 = list0.data.items.find((i) => i.type === 'agency' && i.id === agencyPub.data.id)
  ok(!!buyItem0 && buyItem0.matchVia === '我的库存', '1000 万元以下的公开代采委托按我的库存进入商机池')
  ok(!!buyItem0 && buyItem0.canClaim === false && buyItem0.contact === '平台代为对接',
    '未开通时代采委托不可领取，只提示平台代为对接')
  ok(mkItem0.contactVisible === false && mkItem0.canClaim === false, '未开通时联系方式与领取能力锁定')
  ok(buyItem0.model === 'H100 80G SXM' && buyItem0.qty === 2 && buyItem0.priceText.includes('2 万'),
    '委托未领取也直接展示型号、数量与金额', JSON.stringify({ model: buyItem0.model, qty: buyItem0.qty, price: buyItem0.priceText }))
  ok(!('masked' in buyItem0) && !('masked' in mkItem0), '委托不再有「领取后可见」的脱敏字段')
  ok(Array.isArray(buyItem0.info) && buyItem0.info.some((r) => r.k === '所在城市') &&
    buyItem0.info.some((r) => r.k === '委托数量'),
    '未领取的委托同样下发全部信息（含数量）', JSON.stringify(buyItem0.info))
  /* 代采 / 代售只在商机池展示，不再提供普通信息流 */
  const feedSell = await call(userRouter, 'agency.feed', { side: 'sell' }, SEEKER)
  ok(!feedSell.ok && feedSell.code === 'NOT_FOUND', '代采 / 代售不再进入普通信息流')
  ok(!list0.data.items.some((i) => i.type === 'demand' && i.id === 'd_mk_open'),
    '库存不满足的求购不进入商机列表')

  const statusBefore = await call(userRouter, 'biz.status', {}, SEEKER)
  ok(statusBefore.ok && statusBefore.data.status === '未开通' && statusBefore.data.unlocked === false,
    '未开通时商机权限为未开通且不可查看联系方式')
  const applyGone = await call(userRouter, 'biz.apply', { note: '需要查看联系方式' }, SEEKER)
  ok(!applyGone.ok && applyGone.code === 'NOT_FOUND', '人工商机申请入口已下线，统一走微信支付开通')

  /* 7 天体验：确认后立即开通，权益与付费会员一致，每人限一次；到期后仍需付费开通 */
  const TRIAL_USER = { openid: 'o_user_trial', ip: '10.0.8.9' }
  await call(userRouter, 'auth.login', { nick: '体验用户' }, TRIAL_USER)
  const trialBefore = await call(userRouter, 'biz.status', {}, TRIAL_USER)
  ok(trialBefore.ok && trialBefore.data.unlocked === false && trialBefore.data.trialAvailable === true,
    '未开通过会员的用户可申请 7 天体验')
  const trial = await call(userRouter, 'biz.trial', {}, TRIAL_USER)
  ok(trial.ok && trial.data.status === '已开通' && trial.data.planLabel === '7 天体验',
    '确认后可直接开通 7 天体验' + (trial.ok ? '' : ' → ' + trial.message))
  ok(trial.ok && trial.data.expireAt === now() + 7 * 24 * 60 * 60 * 1000, '体验有效期 7 天')
  const trialAgain = await call(userRouter, 'biz.trial', {}, TRIAL_USER)
  ok(!trialAgain.ok, '7 天体验每人限一次')
  const trialList = await call(userRouter, 'biz.list', {}, TRIAL_USER)
  ok(trialList.ok && trialList.data.unlocked === true && trialList.data.trialAvailable === false,
    '体验期内解锁商机权益，且不再展示体验入口')

  const csGrant = await call(adminRouter, 'biz.grant', { uid: SEEKER.openid, note: '微信收款 99 元' }, csCtxMk)
  ok(csGrant.ok && csGrant.data.status === '已开通', '客服确认收款后开通商机权限')
  const grantExpire = csGrant.data.expireAt
  ok(grantExpire === now() + 30 * 24 * 60 * 60 * 1000, '商机权限有效期 30 天')

  /* 按套餐开通：月度按自然月到期（下月同日 23:59:59 前结束），不按固定 30 天折算 */
  const MONTH_BUYER = { openid: 'o_user_month_plan', ip: '10.0.8.8' }
  await call(userRouter, 'auth.login', { nick: '按月开通' }, MONTH_BUYER)
  const monthGrant = await call(adminRouter, 'biz.grant', { uid: MONTH_BUYER.openid, plan: 'month', note: '按月开通' }, csCtxMk)
  const monthShift = 8 * 60 * 60 * 1000
  const monthBase = new Date(now() + monthShift)
  const monthTarget = new Date(Date.UTC(monthBase.getUTCFullYear(), monthBase.getUTCMonth() + 1, 1,
    monthBase.getUTCHours(), monthBase.getUTCMinutes(), monthBase.getUTCSeconds(), monthBase.getUTCMilliseconds()))
  const monthLast = new Date(Date.UTC(monthTarget.getUTCFullYear(), monthTarget.getUTCMonth() + 1, 0)).getUTCDate()
  const monthExpire = monthBase.getUTCDate() > monthLast
    ? Date.UTC(monthTarget.getUTCFullYear(), monthTarget.getUTCMonth(), monthLast, 23, 59, 59, 999) - monthShift
    : Date.UTC(monthTarget.getUTCFullYear(), monthTarget.getUTCMonth(), monthBase.getUTCDate(),
      monthBase.getUTCHours(), monthBase.getUTCMinutes(), monthBase.getUTCSeconds(), monthBase.getUTCMilliseconds()) - monthShift - 1000
  ok(monthGrant.ok && monthGrant.data.expireAt === monthExpire,
    '月度会员按自然月到期：下月同日 23:59:59 前结束，不按固定 30 天', String(monthGrant.data.expireAt))

  const status1 = await call(userRouter, 'biz.status', {}, SEEKER)
  ok(status1.ok && status1.data.unlocked === true, '开通后商机权限生效')

  /* 代采 / 代售：未领取前不允许直接申请平台对接 */
  const consultBeforeClaim = await call(userRouter, 'biz.consult', { agencyId: agencyPub.data.id }, SEEKER)
  ok(!consultBeforeClaim.ok && consultBeforeClaim.code === 'CONFLICT',
    '未领取代采委托时不能提交平台对接申请')

  /* 发布者的必须条件由服务端复核：不带条件直接领取要被拦下 */
  const claimNoConds = await claimOf({
    targetType: 'agency', agencyId: poolAgency.data.id, conds: false
  }, SEEKER)
  ok(!claimNoConds.ok && claimNoConds.code === 'CONFLICT' && String(claimNoConds.message || '').includes('必须条件'),
    '未逐项确认发布者必须条件时领取被拒')

  const claim1 = await claimOf({ targetType: 'agency', agencyId: poolAgency.data.id }, SEEKER)
  ok(claim1.ok, '代售委托可确认交易条件后自助领取')
  const buyClaim = await claimOf({ targetType: 'agency', agencyId: agencyPub.data.id }, SEEKER)
  ok(buyClaim.ok, '代采委托可确认交易条件后自助领取')
  const listAgency1 = await call(userRouter, 'biz.list', {}, SEEKER)
  const agencyItem1 = listAgency1.data.items.find((i) => i.type === 'agency' && i.id === poolAgency.data.id)
  ok(!!agencyItem1 && agencyItem1.claimed === true && agencyItem1.contact === '平台代为对接' &&
    agencyItem1.contactVisible === false, '领取后委托显示「平台代为对接」，联系方式仍由平台居中')
  ok(agencyItem1.org === '平台' && agencyItem1.media.length === 0,
    '委托方统一显示为平台，营业执照 / 授权书等材料不下发商机池')
  ok(agencyItem1.model === 'H100 80G SXM' && agencyItem1.priceText.includes('20 万'),
    '委托型号与金额全程可见（领取前后一致）', JSON.stringify({ model: agencyItem1.model, price: agencyItem1.priceText }))
  ok(Array.isArray(agencyItem1.info) &&
    agencyItem1.info.some((r) => r.k === '委托数量' && r.v === '1 台') &&
    agencyItem1.info.some((r) => r.k === '所在城市' && r.v === '深圳'),
    '商机详情下发发布者设定的全部信息（数量 / 城市）', JSON.stringify(agencyItem1.info))

  /* 不做独家锁：委托对匹配会员始终可见，其他会员也可以领取并申请平台对接 */
  const RIVAL = { openid: 'o_user_rival', ip: '10.0.9.9' }
  await call(userRouter, 'auth.login', { nick: '竞争会员' }, RIVAL)
  await ensureProfileReady(userRouter, RIVAL)
  await call(userRouter, 'profile.save', {
    nick: '竞争会员', phone: '13900009999', realname: '竞争会员',
    subject: '竞争主体商贸有限公司', position: '采购经理', exposure: 'open'
  }, RIVAL)
  await call(userRouter, 'stock.save', {
    cat: '其他', model: 'H100 80G SXM', qty: 2, price: 205000, city: '深圳'
  }, RIVAL)
  /* 代售匹配需求方：竞争会员也要有能对上的需求，验证多条领取记录并存 */
  await repo.insert('demands', {
    id: 'd_rival_h100',
    ownerId: RIVAL.openid,
    tradeMode: TRADE_MODES.BUY,
    title: '求购 H100',
    cat: '其他',
    model: 'H100 80G SXM',
    qty: 1,
    budget: 200000,
    city: '深圳',
    status: DEMAND_STATUS.OPEN,
    deleted: false,
    createdAt: now(),
    updatedAt: now()
  })
  await call(adminRouter, 'biz.grant', { uid: RIVAL.openid, note: '微信收款 99 元' }, csCtxMk)
  const rivalList = await call(userRouter, 'biz.list', {}, RIVAL)
  const rivalItem = rivalList.data.items.find((i) => i.type === 'agency' && i.id === poolAgency.data.id)
  ok(!!rivalItem, '已被他人领取的委托仍出现在其他匹配会员的商机池')
  ok(rivalItem.claimed === false && rivalItem.canClaim === true && rivalItem.org === '平台',
    '他人领取不影响本人领取，且委托方统一显示为平台', JSON.stringify(rivalItem))
  const rivalClaim = await claimOf({ targetType: 'agency', agencyId: poolAgency.data.id }, RIVAL)
  ok(rivalClaim.ok && rivalClaim.data.claimCount >= 2,
    '多个匹配会员可以领取同一委托', JSON.stringify(rivalClaim))
  const rivalConsult = await call(userRouter, 'biz.consult', { agencyId: poolAgency.data.id }, RIVAL)
  ok(rivalConsult.ok, '领取后多个会员都可以申请平台对接')

  /* 代采 / 代售领取即生成绑定工单；「联系平台」复用同一张工单，不再重复建单 */
  const consult1 = await call(userRouter, 'biz.consult', { agencyId: agencyPub.data.id }, SEEKER)
  ok(consult1.ok && consult1.data.consulted === true && consult1.data.already === true,
    '领取时已自动建单，代采委托提交对接申请复用同一张工单')
  const consultLead = await repo.get('leads', consult1.data.leadId)
  ok(!!consultLead && consultLead.targetType === 'agency' && consultLead.agencyId === agencyPub.data.id &&
    consultLead.status === LEAD_STATUS.PENDING && consultLead.ticketState === TICKET_STATE.TICKETED &&
    consultLead.serviceStage === 'communicating' && consultLead.threadId === consultLead.id,
    '领取生成的工单与商机绑定并进入客服待领取', JSON.stringify(consultLead && {
      targetType: consultLead.targetType, agencyId: consultLead.agencyId, ticketState: consultLead.ticketState,
      serviceStage: consultLead.serviceStage
    }))
  const consult2 = await call(userRouter, 'biz.consult', { agencyId: agencyPub.data.id }, SEEKER)
  ok(consult2.ok && consult2.data.already === true && consult2.data.leadId === consult1.data.leadId,
    '重复提交对接申请返回同一张工单')
  const listConsulted = await call(userRouter, 'biz.list', {}, SEEKER)
  const consultedItem = listConsulted.data.items.find((i) => i.type === 'agency' && i.id === agencyPub.data.id)
  ok(!!consultedItem && consultedItem.consulted === true && consultedItem.consultText === '已提交 · 待平台核实',
    '商机卡片回显「已提交 · 待平台核实」')

  /* 平台对接单不再依赖用户标记优先：管理端按上传资料与主体信息齐全度排序处理 */
  const adminLeads = await call(adminRouter, 'lead.list', {}, { token: adminToken })
  const agencyRow = (adminLeads.data.items || []).find((l) => l.id === consult1.data.leadId)
  ok(!!agencyRow && agencyRow.targetType === 'agency' && typeof agencyRow.completeness === 'number',
    '管理端咨询单下发代采资料齐全度')
  ok(!!agencyRow && !!agencyRow.completenessText && Array.isArray(agencyRow.missingMaterials),
    '管理端咨询单展示齐全度文案与缺失项')
  ok(!!agencyRow && !('priority' in agencyRow) && !('priorityAt' in agencyRow),
    '管理端咨询单不再包含用户优先标记字段')

  /* 自响应拦截：不能响应自己发布的委托 / 需求，也不能因自己有库存就把自己的需求当商机 */
  const selfConsult = await call(userRouter, 'biz.consult', { agencyId: agencyPub.data.id }, AGENT)
  ok(!selfConsult.ok && String(selfConsult.message || '').includes('自己'), '不能响应自己发布的委托')
  const agentList = await call(userRouter, 'biz.list', {}, AGENT)
  ok(!agentList.data.items.some((i) => i.type === 'agency' && i.id === agencyPub.data.id),
    '自己发布的委托不出现在自己的商机列表')
  ok(!agentList.data.items.some((i) => i.type === 'demand' && i.id === 'd_mk_open'),
    '自己发布的需求不出现在自己的商机列表')

  /* 需求侧只选设备类型、不填型号：品类命中即应可领取，不能被型号比对一票否决 */
  await repo.insert('demands', {
    id: 'd_mk_cat_only',
    ownerId: AGENT.openid,
    tradeMode: TRADE_MODES.BUY,
    title: '求购内存条一批',
    cat: '其他',
    brand: '',
    model: '',
    qty: 3,
    budget: 50000,
    city: '深圳',
    status: DEMAND_STATUS.OPEN,
    bizPool: true,
    deleted: false,
    visibility: VISIBILITIES.PUBLIC,
    createdAt: now(),
    updatedAt: now()
  })
  const listCat = await call(userRouter, 'biz.list', {}, SEEKER)
  const catItem = listCat.data.items.find((i) => i.type === 'demand' && i.id === 'd_mk_cat_only')
  ok(!!catItem && catItem.matched === true && catItem.canClaim === true, '未填型号的求购需求按品类命中，可正常领取')
  const catClaim = await claimOf({ targetType: 'demand', demandId: 'd_mk_cat_only' }, SEEKER)
  ok(catClaim.ok && catClaim.data.already === false, '需求方未填型号时领取成功')

  /* 有权限但库存不匹配：仍不能领取需求联系方式 */
  await call(adminRouter, 'biz.grant', { uid: POOR.openid }, csCtxMk)
  const poorClaim = await claimOf({ targetType: 'demand', demandId: 'd_mk_open' }, POOR)
  ok(!poorClaim.ok && poorClaim.code === 'FORBIDDEN', '库存不匹配时领取被拒')

  const list1 = await call(userRouter, 'biz.list', {}, SEEKER)
  const demandItem1 = list1.data.items.find((i) => i.type === 'demand' && i.id === 'd_mk_cat_only')
  ok(!!demandItem1 && demandItem1.contactVisible === true && demandItem1.claimed === true,
    '领取需求后商机池展示求购方联系方式')

  /* ⑤ 续费累加、停用权限（停用仅管理员） */
  const renew = await call(adminRouter, 'biz.grant', { uid: SEEKER.openid }, csCtxMk)
  ok(renew.ok && renew.data.expireAt === grantExpire + 30 * 24 * 60 * 60 * 1000, '续费按剩余有效期累加 30 天')

  const csRevoke = await call(adminRouter, 'biz.revoke', { uid: SEEKER.openid, reason: '测试' }, csCtxMk)
  ok(!csRevoke.ok && csRevoke.code === 'FORBIDDEN', '客服停用商机权限被拒（仅管理员）')

  const revoked = await call(adminRouter, 'biz.revoke', { uid: SEEKER.openid, reason: '到期未续费' }, { token: adminToken })
  ok(revoked.ok && revoked.data.status === '已停用', '管理员停用商机权限')

  const status2 = await call(userRouter, 'biz.status', {}, SEEKER)
  ok(status2.ok && status2.data.unlocked === false, '停用后权限立即失效')

  const list2 = await call(userRouter, 'biz.list', {}, SEEKER)
  const demandItem2 = list2.data.items.find((i) => i.type === 'demand' && i.id === 'd_mk_cat_only')
  ok(!!demandItem2 && demandItem2.contactVisible === false, '权限失效后不再下发已领取的联系方式')

  /* 管理端其余权限边界 */
  const csQuoteList = await call(adminRouter, 'quote.list', {}, csCtxMk)
  ok(!csQuoteList.ok && csQuoteList.code === 'FORBIDDEN', '客服查看粘贴报价被拒（仅管理员）')
  const adminQuoteList = await call(adminRouter, 'quote.list', {}, { token: adminToken })
  ok(adminQuoteList.ok && adminQuoteList.data.total >= 1, '管理员可查看粘贴报价')

  /* 管理端委托对话：无历史消息也能直接发起，支持文本与图片 / 视频 */
  const chatEmpty = await call(adminRouter, 'agency.chats', { id: agencyPub.data.id }, { token: adminToken })
  ok(chatEmpty.ok, '管理端可读取委托专属会话')
  const chatText = await call(adminRouter, 'agency.reply', {
    id: agencyPub.data.id, uid: AGENT.openid, body: '已收到，稍后与您联系'
  }, { token: adminToken })
  ok(chatText.ok, '管理端可直接发起委托对话')
  const chatImage = await call(adminRouter, 'agency.reply', {
    id: agencyPub.data.id, uid: AGENT.openid, kind: 'image', image: 'https://cdn.example.com/agency.png'
  }, { token: adminToken })
  ok(chatImage.ok, '管理端可发送图片消息')
  const chatVideo = await call(adminRouter, 'agency.reply', {
    id: agencyPub.data.id, uid: AGENT.openid, kind: 'video', video: 'https://cdn.example.com/agency.mp4'
  }, { token: adminToken })
  ok(chatVideo.ok, '管理端可发送视频消息')
  const chatWrongUser = await call(adminRouter, 'agency.reply', {
    id: agencyPub.data.id, uid: SEEKER.openid, body: '越权回复'
  }, { token: adminToken })
  ok(!chatWrongUser.ok && chatWrongUser.code === 'FORBIDDEN', '只能回复该委托的发布人')
  const chatList = await call(adminRouter, 'agency.chats', { id: agencyPub.data.id }, { token: adminToken })
  const chatThread = (chatList.data.threads || []).filter((t) => t.uid === AGENT.openid)[0] || {}
  const chatMsgs = chatThread.messages || []
  ok(chatMsgs.some((m) => m.from === 'staff' && m.body === '已收到，稍后与您联系') &&
    chatMsgs.some((m) => m.kind === 'image' && m.image.indexOf('https://') === 0) &&
    chatMsgs.some((m) => m.kind === 'video' && m.video.indexOf('https://') === 0),
  '委托会话按时间返回文本与图片 / 视频')

  /* 成交必须走工单流程：领取 → 双方沟通 → 确认条件 → 合同归档 → 锁定唯一对接方 → 登记成交。
     委托页不再提供「直接确认成交」入口。 */
  const flowClaim = await call(adminRouter, 'lead.claim', { leadId: consultLead.id }, csCtxMk)
  ok(flowClaim.ok, '客服领取代采委托工单')
  await repo.insert('outbox', {
    id: 'M_mk_agency_user_chat',
    type: 'kf.chat',
    payload: {
      uid: SEEKER.openid, channel: 'kf', from: 'user', threadId: consultLead.id,
      targetType: 'agency', targetId: agencyPub.data.id, title: '代采 H100', body: '可以按 25 万成交'
    },
    status: 'read',
    createdAt: CLOCK + 30
  })
  const flowTerms = await call(adminRouter, 'consult.terms', {
    leadId: consultLead.id, amount: 250000, delivery: '深圳面交', payment: '对公转账', condition: '验收后付款'
  }, csCtxMk)
  ok(flowTerms.ok && flowTerms.data.stage === 'terms', '工单确认交易条件后才能继续')
  const flowContract = await call(adminRouter, 'consult.contractSubmit', {
    leadId: consultLead.id, fileId: 'https://cdn.example.com/mk-contract.pdf', fileName: '居间合同.pdf', signDate: '2026-02-26'
  }, csCtxMk)
  ok(flowContract.ok && flowContract.data.stage === 'contract', '工单上传居间合同')
  const flowSkipLock = await call(adminRouter, 'contract.review', { leadId: consultLead.id, decision: 'approve' }, { token: adminToken })
  ok(!flowSkipLock.ok && flowSkipLock.code === 'CONFLICT', '未确定唯一对接方不能归档合同')
  const flowLock = await call(adminRouter, 'contract.lock', { leadId: consultLead.id }, csCtxMk)
  ok(flowLock.ok && flowLock.data.agencyStatus === '已锁定', '合同待审核时锁定唯一对接方')
  const flowReview = await call(adminRouter, 'contract.review', { leadId: consultLead.id, decision: 'approve' }, { token: adminToken })
  ok(flowReview.ok && flowReview.data.stage === 'signed', '居间合同审核归档')
  const flowDeal = await call(adminRouter, 'consult.proposeDeal', { leadId: consultLead.id, amount: 250000 }, csCtxMk)
  ok(flowDeal.ok && flowDeal.data.stage === 'fee', '合同归档后客服登记成交，工单进入服务费待支付')
  const dealtDoc = await repo.get('agencies', agencyPub.data.id)
  ok(dealtDoc.status === '已成交' && dealtDoc.dealAmount === 250000 &&
    dealtDoc.dealConfirmedAt > 0 && !!dealtDoc.dealConfirmedBy,
  '委托单在流程内成交并记录金额与确认人')
  const directDeal = await call(adminRouter, 'agency.close', {
    id: agencyPub.data.id, dealt: true, dealAmount: 260000
  }, { token: adminToken })
  ok(!directDeal.ok && directDeal.code === 'CONFLICT',
    '委托页不能跳过工单流程直接确认成交')

  const dealByOwner = await call(userRouter, 'agency.dealConfirm', { id: agencyPub.data.id }, AGENT)
  ok(!dealByOwner.ok, '委托方确认成交接口已下线')
  const receiptGone = await call(userRouter, 'agency.receipt', { id: agencyPub.data.id }, AGENT)
  ok(!receiptGone.ok, '委托方确认收货接口已下线')

  const mineDealt = await call(userRouter, 'agency.mine', {}, AGENT)
  const dealtItem = mineDealt.data.items.find((i) => i.id === agencyPub.data.id)
  ok(!!dealtItem && dealtItem.statusText === '已成交' && dealtItem.canConfirmDeal !== true &&
    dealtItem.canConfirmReceipt !== true && !!dealtItem.dealAmountText &&
    !!dealtItem.dealConfirmedAtText && !!dealtItem.dealConfirmedBy &&
    dealtItem.progress.some((p) => p.key === 'dealt' && p.done),
  '我的委托展示平台确认成交信息与进度，不再有委托方确认入口')
  ok(dealtItem.flowNodes.some((n) => n.label === '平台确认成交') &&
    !dealtItem.flowNodes.some((n) => n.label === '待确认成交'), '流程节点展示「平台确认成交」')
  ok(dealtItem.feeStatus === 'pending' && dealtItem.feeDueAt > 0 &&
    dealtItem.feeStatusText.indexOf('前到账') > -1, '成交后生成服务费账单并给出应到账日')
  const feeBill = (await repo.find('payments', { agencyId: agencyPub.data.id }, { limit: 1 }))[0]
  /* 挂牌 4 万、议价成交 25 万：服务费按成交金额重算（1% = 2500，未触顶 5000） */
  ok(!!feeBill && feeBill.amount === 2500 && feeBill.bizType === '代采服务费' &&
    feeBill.status === '待确认', '后付费账单为待确认收款单，金额按成交金额重算')
  const workdayDue = dealtItem.feeDueAt
  ok(workdayDue === (function () {
    let day = Math.floor((now() + 8 * 3600 * 1000) / 86400000) * 86400000 - 8 * 3600 * 1000
    let left = 3
    while (left > 0) {
      day += 86400000
      const wd = new Date(day + 8 * 3600 * 1000).getUTCDay()
      if (wd !== 0 && wd !== 6) left -= 1
    }
    return day + 86400000 - 1
  })(), '应到账日按打款后 3 个工作日（跳过周六日）计算')

  /* 服务费未到账前不能确认完成：收尾必须发生在收款之后 */
  const earlyComplete = await call(adminRouter, 'agency.complete', { id: agencyPub.data.id }, { token: adminToken })
  ok(!earlyComplete.ok && earlyComplete.code === 'CONFLICT', '服务费未到账不能确认完成')

  /* 财务确认服务费到账后回写委托单 */
  const paidBill = (await repo.find('payments', { agencyId: agencyPub.data.id }, { limit: 1 }))[0]
  const financeOk = await call(adminRouter, 'payment.feeConfirm', { id: paidBill.id }, { token: adminToken })
  ok(financeOk.ok, '财务确认服务费到账')
  const feePaidDoc = await repo.get('agencies', agencyPub.data.id)
  ok(feePaidDoc.feeStatus === 'paid' && feePaidDoc.feePaidAt > 0,
    '收款单确认后回写委托单 feeStatus=paid 与到账时间')
  const minePaid = await call(userRouter, 'agency.mine', {}, AGENT)
  const paidItem = minePaid.data.items.find((i) => i.id === agencyPub.data.id)
  ok(!!paidItem && paidItem.feeStatusText === '已到账' && paidItem.feeStatus === 'paid' &&
    paidItem.flowNodes.some((n) => n.label === '服务费到账'),
    '我的委托展示服务费已到账节点，且不再有上报支付入口')

  /* 交易收尾：服务费到账后平台确认完成，委托归档 */
  const doneRes = await call(adminRouter, 'agency.complete', { id: agencyPub.data.id }, { token: adminToken })
  ok(doneRes.ok && doneRes.data.status === '已完成' && doneRes.data.completedAt > 0 &&
    !!doneRes.data.completedBy, '服务费到账后平台确认完成，交易结束')
  const doneAgain = await call(adminRouter, 'agency.complete', { id: agencyPub.data.id }, { token: adminToken })
  ok(!doneAgain.ok && doneAgain.code === 'CONFLICT', '已完成委托不能重复确认完成')
  const mineDone = await call(userRouter, 'agency.mine', {}, AGENT)
  const doneItem = mineDone.data.items.find((i) => i.id === agencyPub.data.id)
  ok(!!doneItem && doneItem.progress.some((p) => p.key === 'done' && p.done) &&
    doneItem.flowNodes.some((n) => n.label === '已完成'), '我的委托进度以「已完成」收尾')

  /* 到截止时间仍未成交：读取时惰性关闭，已成交 / 已完成不受影响 */
  const EXPIRE_USER = { openid: 'o_user_expire', ip: '10.0.0.99' }
  await call(userRouter, 'auth.login', { nick: '到期验证' }, EXPIRE_USER)
  await call(userRouter, 'profile.save', {
    nick: '到期验证', phone: '13800139999', realname: '到期验证',
    subject: '验证用主体', subjectType: '民企', contact: '负责人', city: '杭州'
  }, EXPIRE_USER)
  const expireTarget = await call(userRouter, 'agency.submit', {
    side: 'buy', mode: TRADE_MODES.BUY, item: 'A100 80G', qty: 1, price: 30000,
    subjectType: 'company', subject: '验证用主体', phone: '13800139999',
    authPhone: '13800139999',
    legal: '到期验证', creditCode: '91330100MA27X1234X',
    media: [
      { name: 'license.jpg', kind: 'license' },
      { name: 'proof.pdf', kind: 'proof' },
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }, EXPIRE_USER)
  await call(adminRouter, 'agency.review', { id: expireTarget.data.id, decision: '通过' }, csCtxMk)
  await repo.updateWhere('agencies', { id: expireTarget.data.id },
    { deadlineAt: now() - 1000, expiresAt: now() - 1000 })
  const expiredDetail = await call(userRouter, 'agency.detail', { id: expireTarget.data.id }, EXPIRE_USER)
  ok(expiredDetail.ok && expiredDetail.data.status === '已关闭' && expiredDetail.data.expired === true &&
    expiredDetail.data.closeReason === '已到截止时间' && expiredDetail.data.closedAt > 0,
  '过截止时间仍未成交的委托在读取时自动关闭并记录原因')
  ok(!expiredDetail.data.canConfirmDeal &&
    expiredDetail.data.flowNodes.some((n) => n.label === '已关闭'), '到期委托不再提供任何成交入口')

  /* 并发兜底：同一账号同时提交 10 条，进行中的委托不得超过 5 条 */
  const BURST = { openid: 'o_mk_agent_burst', ip: '10.20.0.9' }
  await call(userRouter, 'auth.login', { nick: '并发委托方' }, BURST)
  await call(userRouter, 'profile.save', { nick: '并发委托方', phone: '13500005555', realname: '周齐', subject: '并发委托有限公司', position: '采购经理', exposure: 'open' }, BURST)
  const burstBase = {
    side: 'buy', mode: TRADE_MODES.BUY, rental: false, term: [], qty: 1, price: 20000,
    amount: 20000, detail: '并发提交校验', city: '深圳', subjectType: 'company',
    subject: '深圳并发算力有限公司', creditCode: '91440300MA5F99999X', legal: '周齐',
    phone: '13500005555', authPhone: '13500005555',
    deadline: beijingDateText(CLOCK + 30 * 86400000),
    media: [
      { name: 'license.pdf', kind: 'license' },
      { name: 'proof.pdf', kind: 'proof' },
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => call(
    userRouter, 'agency.submit', Object.assign({}, burstBase, { item: `H200 并发 ${i}` }), BURST
  )))
  const burstOkCount = burst.filter((r) => r.ok).length
  const burstActive = await repo.count('agencies', {
    ownerId: 'o_mk_agent_burst',
    status: { $in: ['待审核', '待确认', '已通过', '已上架'] },
    deleted: { $ne: true }
  })
  ok(burstOkCount === 5 && burstActive === 5, '并发提交 10 条代采委托：每日 5 条限流生效，仅 5 条落库')

  /* 直接成交入口已下线：未走工单流程的委托即使审核上架也不能直接确认成交 */
  const feeAgency = burst.filter((r) => r.ok)[0].data
  const burstConfirm = await call(adminRouter, 'agency.review', { id: feeAgency.id, decision: '通过' }, csCtxMk)
  ok(burstConfirm.ok && burstConfirm.data.status === '已上架', '并发用例的委托可正常审核上架' + (burstConfirm.ok ? '' : `（${burstConfirm.code} ${burstConfirm.message}）`))
  const burstClose = await call(adminRouter, 'agency.close', { id: feeAgency.id, dealt: true, dealAmount: 30000 }, { token: adminToken })
  ok(!burstClose.ok && burstClose.code === 'CONFLICT',
    '未走工单流程的委托不能直接确认成交' + (burstClose.ok ? '' : `（${burstClose.code} ${burstClose.message}）`))
  const burstAgencyDoc = await repo.get('agencies', feeAgency.id)
  ok(burstAgencyDoc.status === '已上架' && !burstAgencyDoc.dealAmount, '直接成交被拒后委托保持已上架')
  const feeBills = await repo.find('payments', { agencyId: feeAgency.id })
  ok(feeBills.length === 0, `直接成交被拒后不生成服务费账单（实际 ${feeBills.length} 张）`)

  /* 进行中上限：已有 10 条进行中委托时，再提交应被拒绝且数量不增加 */
  const CAP = { openid: 'o_mk_agent_cap', ip: '10.20.0.10' }
  await call(userRouter, 'auth.login', { nick: '委托上限' }, CAP)
  await call(userRouter, 'profile.save', { nick: '委托上限', phone: '13500006666', realname: '吴限', subject: '委托上限有限公司', position: '采购经理', exposure: 'open' }, CAP)
  for (let i = 0; i < 10; i++) {
    await repo.insert('agencies', {
      id: 'AG_CAP_' + i,
      ownerId: 'o_mk_agent_cap',
      side: 'buy',
      kind: '代采',
      status: '待审核',
      createdAt: CLOCK - 60000,
      deleted: false
    })
  }
  const capRes = await call(userRouter, 'agency.submit', Object.assign({}, burstBase, { item: 'H200 上限校验' }), CAP)
  const capCount = await repo.count('agencies', {
    ownerId: 'o_mk_agent_cap',
    status: { $in: ['待审核', '待确认', '已通过', '已上架'] },
    deleted: { $ne: true }
  })
  ok(!capRes.ok && capRes.code === 'CONFLICT' && capCount === 10,
    `进行中委托达到 10 条后拒绝新提交（实际 ${capCount} 条，${capRes.ok ? '仍可提交' : capRes.code}）`)
}

/* ============================================================
   25. 运营洞察：浏览量、风险池、在线人数、榜单、商机领取并发
   ============================================================ */
section('25. 运营洞察：浏览量、风险池、在线人数与榜单')
{
  const V1 = { openid: 'o_ins_v1', ip: '10.30.0.1' }
  const V2 = { openid: 'o_ins_v2', ip: '10.30.0.2' }
  const V3 = { openid: 'o_ins_v3', ip: '10.30.0.3' }

  /* 本节自建客服会话：避免依赖其他章节的局部变量 */
  const csLoginIns = await call(adminRouter, 'admin.login', {
    username: 'cs', password: 'Cs@12345', otp: generateTotp('GEZDGNBVGY3TQOJQ', CLOCK)
  }, { ip: '10.30.0.9' })
  ok(csLoginIns.ok && !!csLoginIns.data.token, '客服登录成功（用于洞察权限校验）')
  const csTokenIns = csLoginIns.data.token

  await call(userRouter, 'auth.login', { nick: '浏览者一' }, V1)
  await call(userRouter, 'profile.save', { nick: '浏览者一', phone: '13500001111', realname: '甲一', subject: '浏览者一有限公司', position: '采购经理', exposure: 'open' }, V1)
  await call(userRouter, 'auth.login', { nick: '浏览者二' }, V2)
  await call(userRouter, 'profile.save', { nick: '浏览者二', phone: '13500002222', realname: '乙二', subject: '浏览者二有限公司', position: '采购经理', exposure: 'open' }, V2)
  await call(userRouter, 'auth.login', { nick: '浏览者三' }, V3)
  await call(userRouter, 'profile.save', { nick: '浏览者三', phone: '13500003333', realname: '丙三', subject: '浏览者三有限公司', position: '采购经理', exposure: 'open' }, V3)

  /* 供浏览量与榜单使用的在售商品 */
  const viewProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: 'NVIDIA H100 80G SXM 整机 8 卡',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'H100 80G SXM',
    qty: 6,
    price: 235000,
    priceUnit: '台',
    supply: '现货',
    tax: ['含专票'],
    city: '深圳',
    cond: '二手'
  }, V1)
  ok(viewProduct.ok, '浏览量验证用的商品发布成功' + (viewProduct.ok ? '' : ' → ' + viewProduct.message))
  const viewProductId = (viewProduct.data && viewProduct.data.id) || ''

  /* ① 浏览量计数：属主自己打开不计入，他人打开计入 */
  const viewOwner = await call(userRouter, 'view.count', { kind: 'product', id: viewProductId }, V1)
  ok(viewOwner.ok && viewOwner.data.mine === true && viewOwner.data.views === 0,
    '属主自己查看商品不计浏览量')

  const view1 = await call(userRouter, 'view.count', { kind: 'product', id: viewProductId }, V2)
  ok(view1.ok && view1.data.views === 1, '他人查看商品浏览量 +1')

  const view2 = await call(userRouter, 'view.count', { kind: 'product', id: viewProductId }, V2)
  ok(view2.ok && view2.data.views === 1, '同一用户 30 分钟内重复查看不重复计数')

  const view3 = await call(userRouter, 'view.count', { kind: 'product', id: viewProductId }, V3)
  ok(view3.ok && view3.data.views === 2, '不同用户查看累加浏览量')

  const detail = await call(userRouter, 'product.detail', { id: viewProductId }, V2)
  ok(detail.ok && detail.data.views === 2, '商品详情返回浏览量')

  const ownerList = await call(userRouter, 'product.list', { mine: true }, V1)
  const mineProduct = ownerList.data.items.find((p) => p.id === viewProductId)
  ok(mineProduct && mineProduct.views === 2, '货主在「我的发布」里能看到浏览量')

  /* ② 风险池：价格异常进池，发布不阻断，展示不受影响 */
  const riskProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: 'H100 80G SXM 整机 8 卡 超低价急出',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'H100 80G SXM',
    qty: 1,
    price: 500,
    priceUnit: '台',
    supply: '现货',
    tax: ['含专票'],
    city: '深圳',
    cond: '二手'
  }, V3)
  ok(riskProduct.ok && riskProduct.data && riskProduct.data.status === PRODUCT_STATUS.ON_SALE,
    '命中风险的商品仍正常发布（不阻断）' + (riskProduct.ok ? '' : ' → ' + riskProduct.message))

  const riskList = await call(adminRouter, 'risk.list', {}, { token: adminToken })
  const riskId = (riskProduct.data && riskProduct.data.id) || ''
  ok(riskList.ok && riskList.data.items.some((r) => r.id === riskId),
    '风险商品进入风险池')

  const riskItem = riskList.data.items.find((r) => r.id === riskId)
  ok(riskItem && riskItem.riskHits.some((h) => h.code === 'price_outlier'),
    '风险原因标注为价格异常')

  const stillOnSale = await call(userRouter, 'product.list', {}, V2)
  ok(stillOnSale.ok && stillOnSale.data.items.some((p) => p.id === riskId),
    '风险池中的商品对外照常展示（不影响任何内容）')

  const csRiskHandle = await call(adminRouter, 'risk.handle', {
    kind: 'product', id: riskId, decision: '打回', reason: '价格明显异常'
  }, { token: csTokenIns })
  ok(!csRiskHandle.ok && csRiskHandle.code === 'FORBIDDEN', '客服打回风险商品被拒（仅管理员）')

  const riskBack = await call(adminRouter, 'risk.handle', {
    kind: 'product', id: riskId, decision: '打回', reason: '价格明显异常'
  }, { token: adminToken })
  ok(riskBack.ok && riskBack.data.riskStatus === '已打回', '管理员打回风险商品')

  const afterBack = await call(userRouter, 'product.detail', { id: riskId }, V3)
  /* 打回 = 退回修改：置为「已驳回」，出版物里立即消失，发布方修改后可重新提交 */
  ok(afterBack.ok && afterBack.data.status === PRODUCT_STATUS.REJECTED, '打回后商品退回修改（不再公开展示）')
  const backToPublic = await call(userRouter, 'product.list', {}, V2)
  ok(backToPublic.ok && !backToPublic.data.items.some((p) => p.id === riskId), '打回后商品从公开列表移除')

  /* ③ 在线人数：心跳写入，超期不算在线 */
  await call(userRouter, 'online.ping', {}, V1)
  await call(userRouter, 'online.ping', {}, V2)
  const board0 = await call(adminRouter, 'insights.board', {}, { token: adminToken })
  ok(board0.ok && board0.data.online === 2, '实时在线人数按心跳统计')

  CLOCK += 10 * 60 * 1000
  const board1 = await call(adminRouter, 'insights.board', {}, { token: adminToken })
  ok(board1.ok && board1.data.online === 0, '超过心跳有效期后不再计入在线')
  CLOCK -= 10 * 60 * 1000

  /* ④ 搜索热榜：搜索埋点计入当日榜 */
  await call(userRouter, 'search.log', { q: 'H100 80G', cat: 'GPU 服务器', model: 'H100 80G' }, V1)
  await call(userRouter, 'search.log', { q: 'H100 80G', cat: 'GPU 服务器', model: 'H100 80G' }, V2)
  await call(userRouter, 'search.log', { q: 'DDR5 64G', cat: '内存条', model: 'DDR5 64G' }, V1)

  const searches = await call(adminRouter, 'insights.searches', {}, { token: adminToken })
  ok(searches.ok && searches.data.items.length > 0, '搜索热榜有数据')
  const h100Search = searches.data.items.find((i) => i.word === 'h100 80g')
  ok(!!h100Search && h100Search.count === 2, '每日搜索最多按词聚合计数')

  /* 内存类货源：用于验证内存榜单单独成维度 */
  const memProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: 'DDR5 64G 6400 服务器内存条 整批',
    cat: '内存条',
    brand: 'Micron',
    model: 'DDR5 64G',
    qty: 200,
    price: 1880,
    priceUnit: '根',
    supply: '现货',
    tax: ['含专票'],
    city: '深圳',
    cond: '二手'
  }, V1)
  ok(memProduct.ok, '内存类商品发布成功（用于内存榜）')

  /* ⑤ 品类榜单：GPU / 内存等维度分别排行 */
  const boards = await call(adminRouter, 'insights.boards', {}, { token: adminToken })
  ok(boards.ok && boards.data.boards.length > 0, '品类榜单有数据')
  const gpuBoard = boards.data.boards.find((b) => b.scope === 'GPU')
  ok(!!gpuBoard && gpuBoard.items.length > 0, 'GPU 榜单有货源条目')
  ok(gpuBoard && gpuBoard.items.some((i) => i.views > 0), '榜单条目带浏览量')

  const memBoard = boards.data.boards.find((b) => b.scope === '内存')
  ok(!!memBoard && memBoard.items.length > 0, '内存榜单独成维度且有货源')

  const csBoard = await call(adminRouter, 'insights.boards', {}, { token: csTokenIns })
  ok(csBoard.ok, '客服可查看榜单（辅助备货）')

  const csInsight = await call(adminRouter, 'insights.board', {}, { token: csTokenIns })
  ok(csInsight.ok && typeof csInsight.data.online === 'number', '客服可查看实时在线人数')

  /* ⑥ 商机领取：同一商机允许多人各领一次，同一用户幂等 */
  const demandForClaim = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY,
    title: '求购 A100 40G 整机 4 台',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'A100 40G',
    qty: 4,
    budget: 90000,
    supply: '现货',
    tax: ['含专票'],
    city: '上海'
  }, V1)
  ok(demandForClaim.ok, '并发验证用的求购发布成功' + (demandForClaim.ok ? '' : ' → ' + demandForClaim.message))

  await call(userRouter, 'stock.save', { cat: 'GPU 服务器', model: 'A100 40G', qty: 4, price: 90000, city: '上海' }, V2)
  await call(userRouter, 'stock.save', { cat: 'GPU 服务器', model: 'A100 40G', qty: 4, price: 90000, city: '上海' }, V3)

  for (const buyer of [V2, V3]) {
    await call(adminRouter, 'biz.grant', { uid: buyer.openid }, { token: csTokenIns })
  }
  const claimA = await claimOf({ targetType: 'demand', demandId: demandForClaim.data.id }, V2)
  const claimB = await claimOf({ targetType: 'demand', demandId: demandForClaim.data.id }, V3)
  ok(claimA.ok && claimB.ok, '同一商机可被多个用户分别领取' +
    (claimA.ok && claimB.ok ? '' : ' → ' + (claimA.message || 'A 无返回') + ' / ' + (claimB.message || 'B 无返回')))
  ok(!!(claimA.data && claimB.data) && claimA.data.id !== claimB.data.id, '每个用户有独立的领取记录')

  const claimA2 = await claimOf({ targetType: 'demand', demandId: demandForClaim.data.id }, V2)
  ok(claimA2.ok && claimA2.data.already === true && claimA2.data.id === claimA.data.id,
    '同一用户重复领取幂等，不产生第二条记录')
  ok(/已有\s*\d+\s*家领取/.test(String(claimA.data.claimText || '')), '领取响应返回领取人数（已有 N 家领取）')

  /* ⑦ 不设名额上限：只要是商机会员且库存匹配，多家都可以领取 */
  const V4 = { openid: 'o_ins_v4', ip: '10.30.0.4' }
  const V5 = { openid: 'o_ins_v5', ip: '10.30.0.5' }
  for (const buyer of [V4, V5]) {
    await call(userRouter, 'auth.login', { nick: '并发领取用户' }, buyer)
    await call(userRouter, 'profile.save', { nick: '并发领取用户', realname: '并发领取用户', subject: '并发领取有限公司', position: '采购经理', exposure: 'open' }, buyer)
    await call(userRouter, 'stock.save', { cat: 'GPU 服务器', model: 'A100 40G', qty: 4, price: 90000, city: '上海' }, buyer)
    await call(adminRouter, 'biz.grant', { uid: buyer.openid }, { token: csTokenIns })
  }
  const claimThird = await claimOf({ targetType: 'demand', demandId: demandForClaim.data.id }, V4)
  ok(claimThird.ok, '第 3 家可正常领取（不设名额上限）')
  const claimFourth = await claimOf({ targetType: 'demand', demandId: demandForClaim.data.id }, V5)
  ok(claimFourth.ok, '第 4 家仍可领取，商机会员都可领取')

  const listAfterClaim = await call(userRouter, 'biz.list', {}, V5)
  const claimedRow = listAfterClaim.ok
    ? listAfterClaim.data.items.filter((it) => it.id === demandForClaim.data.id)[0]
    : null
  ok(!!claimedRow && claimedRow.claimCount >= 4 && claimedRow.canClaim === false,
    '商机列表回显领取人数，已领取用户不可重复领取')

  /* ⑧ 仅发商机池：只进匹配池，首页 / 搜索列表不展示，会员可从商机池打开详情 */
  const V6 = { openid: 'o_ins_v6', ip: '10.30.0.6' }
  await call(userRouter, 'auth.login', { nick: '商机池发布' }, V6)
  const poolOnly = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY,
    title: '仅商机池求购 A100 40G 整机 4 台',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'A100 40G',
    qty: 4,
    budget: 90000,
    supply: '现货',
    tax: ['含专票'],
    city: '上海',
    visibility: 'public',
    channel: 'pool'
  }, V6)
  ok(poolOnly.ok, '仅发商机池的需求发布成功' + (poolOnly.ok ? '' : ' → ' + poolOnly.message))
  const homeDemands = await call(userRouter, 'demand.list', { limit: 50 }, V4)
  ok(homeDemands.ok && !homeDemands.data.items.some((d) => d.id === poolOnly.data.id),
    '仅发商机池的内容不出现在首页 / 搜索列表')
  const poolList = await call(userRouter, 'biz.list', {}, V4)
  ok(poolList.ok && poolList.data.items.some((i) => i.id === poolOnly.data.id),
    '仅发商机池的内容只出现在匹配到的商机池里')
  const poolDetail = await call(userRouter, 'demand.detail', { id: poolOnly.data.id }, V4)
  ok(poolDetail.ok, '会员可从商机池直接打开仅商机池的详情（未领取也可查看）')
  const V7 = { openid: 'o_ins_v7', ip: '10.30.0.7' }
  await call(userRouter, 'auth.login', { nick: '普通浏览者' }, V7)
  const poolDetailDenied = await call(userRouter, 'demand.detail', { id: poolOnly.data.id }, V7)
  ok(!poolDetailDenied.ok && poolDetailDenied.code === 'NOT_FOUND',
    '非会员拿到 id 也看不到仅商机池的详情')

  /* ⑨ 用户端囤货榜单：品类榜 / 型号榜 / 搜索最多商品 */
  const market = await call(userRouter, 'insights.market', { limit: 10 }, V4)
  ok(market.ok && Array.isArray(market.data.boards) && market.data.boards.length > 0, '商机页可查看品类榜单')
  const marketGpu = market.ok ? market.data.boards.find((b) => b.scope === 'GPU') : null
  ok(!!marketGpu && marketGpu.items.length > 0, '用户端 GPU 榜单有货源条目')
  ok(market.ok && Array.isArray(market.data.modelBoards) && market.data.modelBoards.length > 0,
    '用户端返回型号榜')
  ok(market.ok && Array.isArray(market.data.hotProducts), '用户端返回每日搜索最多的商品')
}

/* ============================================================
   26. 客服会话可见范围：本人跟进 + 公共池
   ============================================================ */
section('26. 客服会话可见范围：本人跟进 + 公共池')
{
  const POOL = { openid: 'o_chat_pool', ip: '10.40.0.1' }
  const MINE = { openid: 'o_chat_mine', ip: '10.40.0.2' }

  /* 本节自建客服会话：避免复用其它章节的 token 与登录限流窗口 */
  const csDemoChat = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'cs')
  const csLoginChat = await call(adminRouter, 'admin.login', {
    username: 'cs',
    password: csDemoChat.password,
    otp: generateTotp(csDemoChat.totpSecret, CLOCK)
  }, { ip: '10.40.0.9' })
  ok(csLoginChat.ok && !!csLoginChat.data.token, '客服登录成功（可见范围校验）')
  const csChat = { token: csLoginChat.data.token }

  for (const user of [POOL, MINE]) {
    await call(userRouter, 'auth.login', { nick: '会话用户' }, user)
    await call(userRouter, 'profile.save', { nick: '会话用户', realname: '会话用户' }, user)
    const sent = await call(userRouter, 'msg.send', { body: '想咨询 H100 现货' }, user)
    ok(sent.ok && sent.data.waiting === true && !!sent.data.threadId, '用户给平台客服留言成功（先生成待领取工单）')
  }

  const leaveOf = async (uidv) => {
    const rows = await repo.find('leads', { uid: uidv, source: 'kf_leave' }, { limit: 5 })
    return rows[0] || null
  }
  const poolLeave = await leaveOf(POOL.openid)
  const mineLeave = await leaveOf(MINE.openid)
  ok(!!poolLeave && !!mineLeave, '平台留言先生成待领取工单，客服领取后才进入消息中心')
  const beforeClaimThreads = await call(adminRouter, 'msg.threads', {}, csChat)
  ok(beforeClaimThreads.ok && !beforeClaimThreads.data.items.some((t) => t.uid === POOL.openid),
    '未领取的留言不进入消息中心')
  const claimPool = await call(adminRouter, 'lead.claim', { leadId: poolLeave.id }, csChat)
  ok(claimPool.ok && claimPool.data.csStatus === '服务中', '客服领取平台留言工单后进入服务中')

  /* 没有任何线索的留言属于公共池：新用户找客服必须有人能接待 */
  const poolView = await call(adminRouter, 'msg.list', { uid: POOL.openid }, csChat)
  ok(poolView.ok, '公共池用户（无线索）：客服可查看会话')
  const poolThreads = await call(adminRouter, 'msg.threads', {}, csChat)
  ok(poolThreads.ok && poolThreads.data.items.some((t) => t.uid === POOL.openid), '公共池用户出现在客服会话列表')
  ok((poolView.data.items || []).some((m) => String(m.body || '').indexOf('H100 现货') > -1),
    '领取后待领取期间的留言原样接入消息中心')
  /* 领取后用户端要能看到「客服已接入」，且后续追问并入同一会话而不是新开待领取工单 */
  const claimNoteView = await call(userRouter, 'msg.list', { page: 1, limit: 100 }, POOL)
  ok(claimNoteView.ok && (claimNoteView.data.items || []).some((m) => m.platformChat === true),
    '平台客服咨询消息标记 platformChat，用户端固定归入平台客服会话')
  ok(claimNoteView.ok && (claimNoteView.data.items || []).some((m) =>
    m.from === 'system' && m.platformChat === true && String(m.body || '').indexOf('接入') > -1),
    '客服领取后用户端收到「客服已接入」系统提示')
  const leadsBeforeFollow = (await repo.find('leads', { uid: POOL.openid, source: 'kf_leave' })).length
  const followUp = await call(userRouter, 'msg.send', { body: '那 4090 现在什么价' }, POOL)
  const leadsAfterFollow = (await repo.find('leads', { uid: POOL.openid, source: 'kf_leave' })).length
  ok(followUp.ok && leadsAfterFollow === leadsBeforeFollow && followUp.data.threadId === poolLeave.id,
    '领取后用户继续发言并入同一会话，不另开待领取工单')
  const poolView2 = await call(adminRouter, 'msg.list', { uid: POOL.openid }, csChat)
  ok(poolView2.ok && (poolView2.data.items || []).some((m) => String(m.body || '').indexOf('4090') > -1),
    '客服会话里能看到用户领取后的追问')

  /* 升级前领取的工单没有 csStatus 字段：追问同样并入原会话，不能重新刷一张待领取工单 */
  const LEGACY = { openid: 'o_legacy_serving', ip: '10.40.0.31' }
  await call(userRouter, 'auth.login', { nick: '历史会话用户' }, LEGACY)
  await repo.insert('leads', {
    id: 'LD_LEGACY_SERVING',
    uid: LEGACY.openid,
    targetType: 'agency',
    targetId: '',
    agencyId: '',
    agencyTitle: '历史平台客服咨询',
    source: 'kf_leave',
    status: LEAD_STATUS.FOLLOWING,
    threadId: 'LD_LEGACY_SERVING',
    ticketState: TICKET_STATE.TICKETED,
    assignedAccount: 'cs',
    assignedTo: '客服一号',
    assignedAt: CLOCK - 1000,
    createdAt: CLOCK - 1000,
    updatedAt: CLOCK - 1000
  })
  const legacyFollow = await call(userRouter, 'msg.send', { body: '历史会话继续追问' }, LEGACY)
  const legacyLeads = await repo.find('leads', { uid: LEGACY.openid, source: 'kf_leave' })
  ok(legacyFollow.ok && legacyLeads.length === 1 && legacyFollow.data.threadId === 'LD_LEGACY_SERVING',
    '升级前领取的工单（无 csStatus）追问并入原会话，不另开待领取工单',
    JSON.stringify(legacyFollow.data))
  /* 清理用例数据：历史工单会污染后面的客服档案 / 待办统计 */
  await repo.removeWhere('leads', { id: 'LD_LEGACY_SERVING' })
  await repo.removeWhere('outbox', { 'payload.uid': LEGACY.openid })

  /* 有线索但尚未分配：仍属公共池，客服可查看 */
  /* 另开一个货主账号发布在售商品：前面的 sellId 已在本节之前被标记为已成交 */
  const CHAT_OWNER = { openid: 'o_chat_owner', ip: '10.40.0.3' }
  await call(userRouter, 'auth.login', { nick: '会话货主' }, CHAT_OWNER)
  await call(userRouter, 'profile.save', { nick: '会话货主', realname: '会话货主' }, CHAT_OWNER)
  const chatProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: 'A100 80G PCIe 现货 4 台',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 4, minQty: 1, price: '118000', cond: '全新',
    tax: ['含税'], city: '上海', supply: '现货', deliver: '3 天内',
    must: ['接受同台互验', '可提供采购意向函'], nego: [], flow: []
  }, CHAT_OWNER)
  ok(chatProduct.ok, '可见范围校验用商品发布成功', chatProduct.message)
  const mineConsult = await call(userRouter, 'consult.submit', {
    productId: chatProduct.data.id,
    phone: '13700137000',
    conds: [{ k: '接受同台互验', satisfied: true }, { k: '可提供采购意向函', satisfied: true }],
    summary: '需要 4 台 H100，预算 220000 元 / 台'
  }, MINE)
  ok(mineConsult.ok && !!mineConsult.data.leadId, '待分配线索的咨询提交成功', mineConsult.message)
  const poolAssign = await call(adminRouter, 'msg.list', { uid: MINE.openid }, csChat)
  ok(poolAssign.ok, '未分配线索：客服可查看（公共池）')

  /* 分配给管理员后，客服不再能翻看该用户会话 */
  const assigned = await call(adminRouter, 'lead.assign', { leadId: mineConsult.data.leadId, assignee: 'admin' }, { token: adminToken })
  ok(assigned.ok && assigned.data.assignedAccount === 'admin', '线索分配给管理员')
  const assignedLeave = await call(adminRouter, 'lead.assign', { leadId: mineLeave.id, assignee: 'admin' }, { token: adminToken })
  ok(assignedLeave.ok, '待领取的留言工单同样可转派给管理员')
  const mineView = await call(adminRouter, 'msg.list', { uid: MINE.openid }, csChat)
  ok(!mineView.ok && mineView.code === 'FORBIDDEN', '他人跟进后客服查看会话被拒')
  const mineReply = await call(adminRouter, 'msg.reply', { uid: MINE.openid, body: '你好' }, csChat)
  ok(!mineReply.ok && mineReply.code === 'FORBIDDEN', '他人跟进后客服回复被拒')
  const threadsAfter = await call(adminRouter, 'msg.threads', {}, csChat)
  ok(threadsAfter.ok && !threadsAfter.data.items.some((t) => t.uid === MINE.openid),
    '他人跟进的用户不再出现在客服会话列表')
  ok(threadsAfter.data.items.some((t) => t.uid === POOL.openid), '公共池用户仍保留在客服会话列表')
  /* 领取校验完成后把该留言工单放回公共池，避免影响后续客服服务量统计 */
  await repo.updateWhere('leads', { id: poolLeave.id }, {
    csStatus: CS_STATUS.WAITING, assignedAccount: '', assignedTo: '', csClaimedAt: 0
  })

  /* 管理员不受可见范围限制（对账 / 投诉核查需要全量） */
  const adminView = await call(adminRouter, 'msg.list', { uid: MINE.openid }, { token: adminToken })
  ok(adminView.ok, '管理员可查看任意用户会话')

  /* 用户之间直聊：咨询建立的会话里双方可互发消息，管理端必须能看到完整记录 */
  const directSend = await call(userRouter, 'msg.send', {
    threadId: mineConsult.data.leadId, body: '方便约时间同台验机吗？'
  }, MINE)
  ok(directSend.ok && !!directSend.data.id, '买家在咨询会话中发起直聊')
  const directReply = await call(userRouter, 'msg.send', {
    threadId: mineConsult.data.leadId, body: '可以，明天下午两点'
  }, CHAT_OWNER)
  ok(directReply.ok, '货主回复直聊')

  const directThreads = await call(adminRouter, 'msg.directThreads', {}, { token: adminToken })
  const directRow = directThreads.ok &&
    directThreads.data.items.find((t) => t.threadId === mineConsult.data.leadId)
  ok(!!directRow && directRow.total >= 2, '管理端直聊列表可见用户之间的会话')

  const directDetail = await call(adminRouter, 'msg.directThread', {
    threadId: mineConsult.data.leadId
  }, { token: adminToken })
  ok(directDetail.ok && directDetail.data.items.length >= 2 &&
    directDetail.data.items.some((m) => String(m.body).indexOf('同台验机') > -1) &&
    directDetail.data.items.some((m) => String(m.body).indexOf('明天下午两点') > -1),
    '管理端可查看双方完整聊天记录')

  const directNoNote = await call(adminRouter, 'msg.directHandle', {
    threadId: mineConsult.data.leadId, action: '警告', note: ''
  }, { token: adminToken })
  ok(!directNoNote.ok, '直聊处置必须填写说明')
  const directWarn = await call(adminRouter, 'msg.directHandle', {
    threadId: mineConsult.data.leadId, action: '警告', note: '提示双方线下交易注意验机'
  }, { token: adminToken })
  ok(directWarn.ok, '管理端可对直聊发出警告')
}

/* ============================================================
   27. 可见范围：公开 / 保密
   ============================================================ */
section('27. 可见范围：公开 / 保密')
{
  const PUB = { openid: 'o_vis_pub', ip: '10.50.0.1' }
  const VIEWER = { openid: 'o_vis_viewer', ip: '10.50.0.2' }
  /* 平台角色：管理员 / 客服可看保密内容完整详情 */
  const STAFF = { openid: 'o_vis_staff', ip: '10.50.0.3', role: 'admin' }

  await call(userRouter, 'auth.login', { nick: '保密发布者' }, PUB)
  await call(userRouter, 'profile.save', { nick: '保密发布者', phone: '13500005555', realname: '发布者' }, PUB)
  await call(userRouter, 'auth.login', { nick: '普通访客' }, VIEWER)

  const baseProduct = {
    tradeMode: TRADE_MODES.SELL,
    title: 'H200 141G 整机 8 卡 现货',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 2, price: 300000, priceUnit: '台', supply: '现货',
    tax: ['含专票'], city: '深圳', cond: '全新'
  }
  const defaultPub = await call(userRouter, 'product.publish', baseProduct, PUB)
  ok(defaultPub.ok && defaultPub.data.visibility === VISIBILITIES.PUBLIC && defaultPub.data.visibilityLabel === '公开',
    '商品未指定可见范围时默认公开')

  const privateProduct = await call(userRouter, 'product.publish',
    Object.assign({}, baseProduct, { title: 'H200 内部保密价', visibility: VISIBILITIES.PRIVATE }), PUB)
  ok(privateProduct.ok && privateProduct.data.visibility === VISIBILITIES.PRIVATE && privateProduct.data.visibilityLabel === '保密',
    '商品可发布为保密并返回可见范围')

  const publicList = await call(userRouter, 'product.list', { limit: 100 }, VIEWER)
  ok(publicList.ok && !publicList.data.items.some((p) => p.id === privateProduct.data.id),
    '私密商品不出现在公共列表')
  ok(publicList.data.items.some((p) => p.id === defaultPub.data.id), '公共商品列表正常展示公开商品')

  const market = await call(userRouter, 'insights.market', {}, VIEWER)
  const boardIds = market.ok
    ? market.data.boards.reduce((acc, b) => acc.concat((b.items || []).map((i) => i.id)), [])
    : []
  ok(market.ok && boardIds.indexOf(privateProduct.data.id) < 0, '榜单 / 热度统计不包含私密商品')

  const sealed = await call(userRouter, 'product.detail', { id: privateProduct.data.id }, VIEWER)
  ok(!sealed.ok, '非本人打开私密商品返回不存在')

  const ownerView = await call(userRouter, 'product.detail', { id: privateProduct.data.id }, PUB)
  ok(ownerView.ok && ownerView.data.title === 'H200 内部保密价' && ownerView.data.isPrivate === true,
    '本人可查看私密商品完整详情')

  const staffView = await call(adminRouter, 'product.detail', { id: privateProduct.data.id }, { token: adminToken })
  ok(staffView.ok && staffView.data.product && staffView.data.product.title === 'H200 内部保密价',
    '平台管理端可查看私密商品完整详情')

  const mineList = await call(userRouter, 'product.list', { mine: true }, PUB)
  const mineRow = mineList.data.items.find((p) => p.id === privateProduct.data.id)
  ok(!!mineRow && mineRow.visibility === VISIBILITIES.PRIVATE && mineRow.visibilityLabel === '保密',
    '我的发布包含保密商品并带保密标识')

  const baseDemand = {
    tradeMode: TRADE_MODES.BUY,
    title: '求购 H200 整机 8 卡',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 8, budget: '310000', tax: ['必须含税'],
    city: '北京', supply: '现货', cond: '全新'
  }
  const privateDemand = await call(userRouter, 'demand.publish',
    Object.assign({}, baseDemand, { title: '内部保密求购 H200', visibility: VISIBILITIES.PRIVATE }), PUB)
  ok(privateDemand.ok && privateDemand.data.visibility === VISIBILITIES.PRIVATE, '需求可发布为保密')

  const demandList = await call(userRouter, 'demand.list', {}, VIEWER)
  ok(demandList.ok && !demandList.data.items.some((d) => d.id === privateDemand.data.id),
    '私密需求不出现在公共列表')

  const demandSealed = await call(userRouter, 'demand.detail', { id: privateDemand.data.id }, VIEWER)
  ok(!demandSealed.ok, '非本人打开私密需求返回不存在')

  const demandOwner = await call(userRouter, 'demand.detail', { id: privateDemand.data.id }, PUB)
  ok(demandOwner.ok && demandOwner.data.title === '内部保密求购 H200', '本人可查看私密需求完整详情')

  const demandStaff = await call(adminRouter, 'demand.detail', { id: privateDemand.data.id }, { token: adminToken })
  ok(demandStaff.ok && demandStaff.data.demand && demandStaff.data.demand.title === '内部保密求购 H200',
    '平台管理端可查看私密需求完整详情')
}

/* ============================================================
   34. 咨询单领取、审批优先级排序规则、产品型号库
   ============================================================ */
section('34. 咨询单领取 / 排序规则 / 产品型号库')
{
  const adminCtx = { token: adminToken }
  const csDemo = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'cs')
  const csLogin = await call(adminRouter, 'admin.login', {
    username: 'cs', password: csDemo.password, otp: generateTotp(csDemo.totpSecret, now())
  }, {})
  const csCtx = { token: csLogin.data.token }

  await repo.insert('leads', {
    id: 'lead_claim_test',
    uid: 'o_usr_list',
    productId: '', demandId: '', source: '小程序咨询',
    status: LEAD_STATUS.PENDING, tier: 'P2', tierName: '优先',
    assignedTo: '', assignedAccount: '', formSummary: '领取测试单',
    compare: [], matchPct: 80, contactReleased: false, createdAt: now()
  })

  /* ① 先领取：归属领取人、状态进入跟进中 */
  const claim = await call(adminRouter, 'lead.claim', { leadId: 'lead_claim_test' }, csCtx)
  ok(claim.ok && claim.data.status === LEAD_STATUS.FOLLOWING, '客服领取后咨询单进入跟进中')
  ok(claim.ok && claim.data.assignedAccount === 'cs', '领取后计入领取人名下')
  const claimAgain = await call(adminRouter, 'lead.claim', { leadId: 'lead_claim_test' }, csCtx)
  ok(claimAgain.ok && claimAgain.data.already === true, '本人重复领取幂等')
  const claimOther = await call(adminRouter, 'lead.claim', { leadId: 'lead_claim_test' }, adminCtx)
  ok(!claimOther.ok && claimOther.code === 'CONFLICT', '已被他人领取时拒绝再次领取')

  /* ② 我的已领取：未完成前持续可见，成交后移出 */
  const mine = await call(adminRouter, 'lead.list', { mine: true }, csCtx)
  ok(mine.ok && mine.data.items.some((l) => l.id === 'lead_claim_test'), '未完成咨询单出现在领取人的我的已领取')
  const otherMine = await call(adminRouter, 'lead.list', { mine: true }, adminCtx)
  ok(otherMine.ok && !otherMine.data.items.some((l) => l.id === 'lead_claim_test'), '其他账号的我的已领取看不到该单')

  const detail = await call(adminRouter, 'lead.detail', { leadId: 'lead_claim_test' }, csCtx)
  ok(detail.ok && detail.data.timeline.some((t) => t.action === 'lead.claim'), '领取写入全程操作记录')
  ok(detail.ok && typeof detail.data.priorityScore === 'number' && !!detail.data.priorityParts,
    '详情返回审批优先级与拆解')
  ok(detail.ok && detail.data.consultUser && /^U[2-9A-HJ-NP-Z]{8}$/.test(detail.data.consultUser.userNo || ''),
    '咨询单详情返回咨询方用户（含对外用户ID）')
  ok(detail.ok && detail.data.publisherUser === null, '无关联商品 / 需求时发布方为空，不会把咨询方当成发布方')
  ok(detail.ok && detail.data.satisfaction && detail.data.satisfaction.total === 0,
    '咨询单详情返回双方条件满足情况（无对比项时 total 为 0）')

  const toMatched = await call(adminRouter, 'lead.updateStatus', { leadId: 'lead_claim_test', to: LEAD_STATUS.MATCHED }, csCtx)
  ok(toMatched.ok, '领取后可标记已对接')
  const toDealt = await call(adminRouter, 'lead.updateStatus', { leadId: 'lead_claim_test', to: LEAD_STATUS.DEALT }, csCtx)
  ok(toDealt.ok, '已对接后可标记已成交')
  const doneMine = await call(adminRouter, 'lead.list', { mine: true }, csCtx)
  ok(doneMine.ok && !doneMine.data.items.some((l) => l.id === 'lead_claim_test'), '成交后自动移出我的已领取')

  /* ③ 排序规则设置：权重 / 大额门槛 */
  const sortRead = await call(adminRouter, 'rule.sort', {}, adminCtx)
  ok(sortRead.ok && sortRead.data.rules && sortRead.data.rules.weights, '排序规则可读取（含默认权重）')
  ok(sortRead.data.factors && sortRead.data.factors.length === 4, '排序规则返回四个权重因子')

  const badSort = await call(adminRouter, 'rule.sortSave', {
    weights: { completeness: 0, amount: 0, subject: 0, waiting: 0 }
  }, adminCtx)
  ok(!badSort.ok && badSort.code === 'VALIDATION', '权重合计为 0 时拒绝保存')

  const saved = await call(adminRouter, 'rule.sortSave', {
    weights: { completeness: 50, amount: 20, subject: 20, waiting: 10 },
    amountThreshold: 5000000, enabled: true, largeCompletenessFirst: true
  }, adminCtx)
  ok(saved.ok && saved.data.rules.weights.completeness === 50, '排序规则保存成功')
  const sortBack = await call(adminRouter, 'rule.sort', {}, adminCtx)
  ok(sortBack.data.rules.amountThreshold === 5000000, '排序规则持久化后可读回')

  const sortAudit = await call(adminRouter, 'audit.list', { action: 'rule.sortSave' }, adminCtx)
  ok(sortAudit.ok && sortAudit.data.items.length >= 1, '保存排序规则写入操作日志')

  const csSort = await call(adminRouter, 'rule.sortSave', {
    weights: { completeness: 1, amount: 1, subject: 1, waiting: 1 }
  }, csCtx)
  ok(!csSort.ok && csSort.code === 'FORBIDDEN', '客服无排序规则配置权限')

  /* ④ 产品型号库：平台上传 → 用户端滚轮可读；停用 / 删除后不可见 */
  const catSave = await call(adminRouter, 'catalog.save', {
    cat: 'GPU 服务器', brand: 'NVIDIA', series: '测试系列', model: '测试型号 X1'
  }, adminCtx)
  ok(catSave.ok && catSave.data.status === 'active', '平台可新增产品型号')

  const catTree = await call(userRouter, 'catalog.tree', {}, USER)
  ok(catTree.ok && catTree.data.items.some((i) => i.model === '测试型号 X1' && i.status === 'active'),
    '新增型号出现在用户端型号目录（滚轮可用）')
  const catTreeSeries = ((catTree.data.tree['GPU 服务器'] || {}).NVIDIA || {})['测试系列'] || []
  ok(catTree.data.tree && catTreeSeries.indexOf('测试型号 X1') >= 0,
    '用户端直接拿到合并后的完整目录（无需依赖小程序打包目录）')

  const catDisable = await call(adminRouter, 'catalog.save', {
    cat: 'GPU 服务器', brand: 'NVIDIA', series: '测试系列', model: '测试型号 X1', status: 'disabled'
  }, adminCtx)
  ok(catDisable.ok && catDisable.data.status === 'disabled', '平台可停用型号')

  const catTree2 = await call(userRouter, 'catalog.tree', {}, USER)
  ok(catTree2.data.items.some((i) => i.model === '测试型号 X1' && i.status === 'disabled'),
    '停用状态下发用户端用于移出滚轮')
  ok(catTree2.ok && (((catTree2.data.tree['GPU 服务器'] || {}).NVIDIA || {})['测试系列'] || []).indexOf('测试型号 X1') < 0,
    '停用型号从完整目录中移除')

  const csCatalog = await call(adminRouter, 'catalog.save', {
    cat: 'X', brand: 'Y', series: 'Z', model: 'W'
  }, csCtx)
  ok(!csCatalog.ok && csCatalog.code === 'FORBIDDEN', '客服无产品型号库维护权限')

  const catRemove = await call(adminRouter, 'catalog.remove', { id: catSave.data.id }, adminCtx)
  ok(catRemove.ok, '型号可软删除')
  const catTree3 = await call(userRouter, 'catalog.tree', {}, USER)
  ok(catTree3.data.items.some((i) => i.model === '测试型号 X1' && i.status === 'removed'),
    '软删除后用户端目录标记为 removed，滚轮不再展示（含内置型号）')

  const catAudit = await call(adminRouter, 'audit.list', { action: 'catalog.save' }, adminCtx)
  ok(catAudit.ok && catAudit.data.items.length >= 1, '维护产品型号写入操作日志')
}

/* ============================================================
   35. 系统设置（企微活码 / 商机套餐）与单用户手动调整
   ============================================================ */
section('35. 系统设置 / 单用户手动调整')
{
  const adminCtx = { token: adminToken }
  const def = await call(adminRouter, 'setting.get', {}, adminCtx)
  ok(def.ok && !!def.data.settings.planPrice && def.data.settings.planDays >= 1, '系统设置可读取默认套餐')

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const savedSet = await call(adminRouter, 'setting.save', {
    qrUrl: png, qrNote: '扫码添加企业微信，核对收款后开通', wecomId: 'suanli-cs',
    planPrice: '129 元 / 月', planDays: 90, planNote: '按需求匹配全平台同类产品',
    siteName: '算力聚合', servicePhone: '400-000-0000', serviceTime: '工作日 09:00 - 18:00'
  }, adminCtx)
  ok(savedSet.ok, '管理员可保存企微活码与商机套餐')

  const readSet = await call(adminRouter, 'setting.get', {}, adminCtx)
  ok(readSet.data.settings.qrUrl === png && readSet.data.settings.planDays === 90 &&
    readSet.data.settings.planPrice === '129 元 / 月', '保存后设置持久化可读回')

  /* 设置页各自提交自己的字段：套餐页保存不能清空通知模板与企微活码 */
  await call(adminRouter, 'setting.save', {
    planPrice: '129 元 / 月', planDays: 90, siteName: '算力聚合',
    tmplInquiry: 'TPL_INQ', tmplChat: 'TPL_CHAT', tmplSystem: 'TPL_SYS', tmplBiz: 'TPL_BIZ'
  }, adminCtx)
  const partialSave = await call(adminRouter, 'setting.save', {
    planPrice: '139 元 / 月', planDays: 90, siteName: '算力聚合'
  }, adminCtx)
  const afterPartial = await call(adminRouter, 'setting.get', {}, adminCtx)
  ok(partialSave.ok && afterPartial.data.settings.tmplSystem === 'TPL_SYS' &&
    afterPartial.data.settings.tmplBiz === 'TPL_BIZ' && afterPartial.data.settings.tmplInquiry === 'TPL_INQ' &&
    afterPartial.data.settings.qrUrl === png, '套餐页部分保存不会清空通知模板与企微活码')

  /* 小程序商机页读取同一份配置，扫码即可加企微开通 */
  const sitePublic = await call(userRouter, 'site.get', {}, { openid: 'o_usr_list', ip: '10.40.0.1' })
  ok(sitePublic.ok && sitePublic.data.site.qrUrl === png && sitePublic.data.site.planDays === 90,
    '小程序可读取企微活码与套餐口径')

  /* 首页横幅：管理端配置多条标题 / 正文 / 滚动速度，小程序读取后横向滚动，点击弹窗展示 */
  const bannerSave = await call(adminRouter, 'setting.save', {
    qrUrl: png, qrNote: '扫码添加企业微信', planPrice: '129 元 / 月', planDays: 90,
    planNote: '按需求匹配', siteName: '算力聚合', servicePhone: '400-000-0000', serviceTime: '工作日 09:00 - 18:00',
    bannerEnabled: true, bannerSpeed: 60,
    bannerItems: [
      { id: 'bn1', title: '平台服务费改为成交后支付', content: '买卖双方成交后各承担 50%。' },
      { id: 'bn2', title: '本周 H100 现货报价回落 4%', content: '' }
    ]
  }, adminCtx)
  ok(bannerSave.ok, '管理员可保存首页横幅内容与滚动速度')

  const bannerRead = await call(adminRouter, 'setting.get', {}, adminCtx)
  ok(bannerRead.data.settings.bannerSpeed === 60 && bannerRead.data.settings.bannerItems.length === 2 &&
    bannerRead.data.settings.bannerItems[0].title === '平台服务费改为成交后支付', '横幅配置持久化可读回')

  const siteBanner = await call(userRouter, 'site.get', {}, { openid: 'o_usr_list', ip: '10.40.0.1' })
  ok(siteBanner.data.site.banner.enabled === true && siteBanner.data.site.banner.speed === 60 &&
    siteBanner.data.site.banner.items.length === 2, '小程序可读取首页横幅')

  /* 冷启动：静默登录尚未完成时也要能读到横幅，否则首页首屏永远缺横幅 */
  const siteAnon = await call(userRouter, 'site.get', {}, {})
  ok(siteAnon.ok && siteAnon.data.site.banner.items.length === 2, '未登录（冷启动）也能读取首页横幅')

  /* 关闭开关：用户端读到 enabled=false，前端据此隐藏整个横幅展位（已配置内容保留） */
  await call(adminRouter, 'setting.save', { bannerEnabled: false }, adminCtx)
  const siteOff = await call(userRouter, 'site.get', {}, {})
  const bannerOffAdmin = await call(adminRouter, 'setting.get', {}, adminCtx)
  ok(siteOff.ok && siteOff.data.site.banner.enabled === false &&
    bannerOffAdmin.data.settings.bannerItems.length === 2, '关闭横幅后用户端可感知，已配置内容不被清空')
  await call(adminRouter, 'setting.save', { bannerEnabled: true }, adminCtx)

  /* 对话总开关：关闭时用户端下发 chatEnabled=false，服务端拒绝发消息；
     打开后恢复，确保审核期间关停不只靠前端隐藏入口 */
  const CHAT_CTX = { openid: USER.openid, ip: USER.ip }
  const chatOnSite = await call(userRouter, 'site.get', {}, {})
  ok(chatOnSite.ok && chatOnSite.data.site.chatEnabled === true, '对话开关打开时用户端读到 chatEnabled=true')
  await call(adminRouter, 'setting.save', { chatEnabled: false }, adminCtx)
  const chatOffSite = await call(userRouter, 'site.get', {}, {})
  const chatOffSend = await call(userRouter, 'msg.send', { body: '关闭期间不应发出' }, CHAT_CTX)
  const chatOffAdmin = await call(adminRouter, 'setting.get', {}, adminCtx)
  ok(chatOffSite.ok && chatOffSite.data.site.chatEnabled === false &&
    chatOffAdmin.data.settings.chatEnabled === false, '关闭对话开关后后台与用户端均可感知')
  ok(!chatOffSend.ok && chatOffSend.code === 'FORBIDDEN', '关闭对话后发送消息被服务端拒绝')
  await call(adminRouter, 'setting.save', { chatEnabled: true }, adminCtx)
  const chatOnSend = await call(userRouter, 'msg.send', { body: '开启后恢复发送' }, CHAT_CTX)
  ok(chatOnSend.ok, '打开对话开关后恢复发送消息')

  const badSpeed = await call(adminRouter, 'setting.save', {
    planPrice: '99 元 / 月', planDays: 30, siteName: 'x', bannerSpeed: 500
  }, adminCtx)
  ok(!badSpeed.ok && badSpeed.code === 'VALIDATION', '横幅滚动速度越界被拒')
  const badBanner = await call(adminRouter, 'setting.save', {
    planPrice: '99 元 / 月', planDays: 30, siteName: 'x', bannerItems: [{ title: '' }]
  }, adminCtx)
  ok(!badBanner.ok && badBanner.code === 'VALIDATION', '横幅缺少标题被拒')

  const badDays = await call(adminRouter, 'setting.save', { planPrice: '99 元 / 月', planDays: 0, siteName: 'x' }, adminCtx)
  ok(!badDays.ok && badDays.code === 'VALIDATION', '默认开通天数非法被拒')
  const badQr = await call(adminRouter, 'setting.save', {
    qrUrl: 'javascript:alert(1)', planPrice: '99 元 / 月', planDays: 30, siteName: 'x'
  }, adminCtx)
  ok(!badQr.ok && badQr.code === 'VALIDATION', '非图片二维码被拒')

  /* 单用户手动调整：账号状态 / 曝光范围 / 内部备注 */
  const adj = await call(adminRouter, 'user.admin', {
    uid: 'o_usr_list', status: '停用', exposure: 'hidden', note: '电话核对后人工停用'
  }, adminCtx)
  ok(adj.ok && adj.data.status === '停用', '管理员可手动调整账号状态')
  const adjDetail = await call(adminRouter, 'user.detail', { id: 'o_usr_list' }, adminCtx)
  ok(adjDetail.ok && adjDetail.data.user.note === '电话核对后人工停用', '内部备注写入用户详情')
  ok(adjDetail.data.user.exposure === 'hidden', '曝光范围调整生效')
  const adjBad = await call(adminRouter, 'user.admin', { uid: 'o_usr_list', exposure: 'public' }, adminCtx)
  ok(!adjBad.ok && adjBad.code === 'VALIDATION', '非法曝光范围被拒')
  const adjMissing = await call(adminRouter, 'user.admin', { uid: 'o_not_exist', status: '正常' }, adminCtx)
  ok(!adjMissing.ok && adjMissing.code === 'NOT_FOUND', '调整不存在的用户返回 NOT_FOUND')

  const setAudit = await call(adminRouter, 'audit.list', { action: 'setting.save' }, adminCtx)
  ok(setAudit.ok && setAudit.data.items.length >= 1, '保存系统设置写入操作日志')
  const uaAudit = await call(adminRouter, 'audit.list', { action: 'user.admin' }, adminCtx)
  ok(uaAudit.ok && uaAudit.data.items.length >= 1, '手动调整用户写入操作日志')
}

/* ============================================================
   36. P0 数据底座：会员流水 / 收款财务 / 日趋势 / 风险单 / 日志 / 角色
   ============================================================ */
section('36. P0 数据底座')
{
  const adminCtx = { token: adminToken }
  const uid = 'o_usr_list'

  /* 会员套餐：季度套餐写订单流水 */
  const grant = await call(adminRouter, 'biz.grant', { uid, plan: 'quarter', note: '季度续费' }, adminCtx)
  ok(grant.ok && grant.data.daysLeft >= 89 && grant.data.planKey === 'quarter', '季度套餐开通成功且按 90 天计算')
  const orders = await call(adminRouter, 'biz.orders', { uid }, adminCtx)
  const quarterOrder = orders.ok ? orders.data.items.find((o) => o.planKey === 'quarter') : null
  ok(!!quarterOrder && quarterOrder.amount === 268 && quarterOrder.days === 90, '会员开通写入订单流水且金额为套餐实收价')
  const badPlan = await call(adminRouter, 'biz.grant', { uid, plan: 'decade' }, adminCtx)
  ok(!badPlan.ok && badPlan.code === 'VALIDATION', '非法套餐被拒绝')

  /* 手动改到期时间：管理员可调整，非法值 / 未开通用户被拒 */
  const expireAt = now() + 40 * 86400e3
  const setExpire = await call(adminRouter, 'biz.setExpire', { uid, expireAt, reason: '线下补偿' }, adminCtx)
  ok(setExpire.ok && setExpire.data.expireAt === expireAt && setExpire.data.daysLeft >= 39, '管理员可手动修改会员到期时间')
  const badExpire = await call(adminRouter, 'biz.setExpire', { uid, expireAt: 0 }, adminCtx)
  ok(!badExpire.ok && badExpire.code === 'VALIDATION', '非法到期时间被拒绝')
  const missingExpire = await call(adminRouter, 'biz.setExpire', { uid: 'o_not_exist', expireAt }, adminCtx)
  ok(!missingExpire.ok && missingExpire.code === 'NOT_FOUND', '未开通会员的用户改到期返回 NOT_FOUND')

  /* 微信支付自动入账 → 收款流水可查；人工确认只服务委托服务费 */
  const WXPAY_NO = 'WXPAY_VERIFY_MEMBER_' + now()
  const pay = await call(adminRouter, 'biz.grant', {
    uid, plan: 'month', amount: 99, method: '微信支付', paymentId: WXPAY_NO, note: '微信支付自动入账'
  }, adminCtx)
  ok(pay.ok && !!pay.data.orderId && pay.data.orderId.indexOf('BO') === 0, '微信支付开通会员并回填订单号')
  const payAgain = await call(adminRouter, 'biz.grant', {
    uid, plan: 'month', amount: 99, method: '微信支付', paymentId: WXPAY_NO
  }, adminCtx)
  ok(payAgain.ok && payAgain.data.orderId === pay.data.orderId, '同一微信支付单重复投递保持幂等')
  const payList = await call(adminRouter, 'payment.list', { uid, limit: 100 }, adminCtx)
  const bills = payList.ok ? payList.data.items : []
  const memberBill = bills.find((row) => row.orderId === pay.data.orderId) || null
  ok(!!memberBill && memberBill.status === '已确认' &&
    memberBill.method === '微信支付' && memberBill.amount === 99 && memberBill.received === 99 &&
    memberBill.agencyId === '', '微信支付自动写入收款流水：应收 / 实收 99 元、已确认、方式为微信支付')
  const manualBill = bills.find((row) => row.orderId === quarterOrder.id) || null
  ok(!!manualBill && manualBill.status === '已确认' && manualBill.method === '企业微信收款' &&
    manualBill.received === 268, '手动开通同样写入收款流水：实收 268 元、方式企业微信收款')
  const feeBad = await call(adminRouter, 'payment.feeConfirm', { id: memberBill.id }, adminCtx)
  ok(!feeBad.ok && feeBad.code === 'VALIDATION', '会员流水不能走服务费确认到账')
  const finance = await call(adminRouter, 'finance.summary', {}, adminCtx)
  const allOrders = await call(adminRouter, 'biz.orders', { limit: 1 }, adminCtx)
  const expectedRevenue = (allOrders.ok && allOrders.data.totalAmount) || 0
  ok(finance.ok && finance.data.totals.memberRevenue === expectedRevenue && expectedRevenue >= 466 &&
    finance.data.totals.revenue === finance.data.totals.memberRevenue + finance.data.totals.serviceFeeRevenue &&
    finance.data.months.length === 6,
    '财务汇总营收 = 会员收入 + 委托服务费收入，会员部分统计所有实收 > 0 的订单（含手动开通）',
    JSON.stringify(finance.ok ? finance.data.totals : finance))
  const finCash = finance.data.cash || {}
  ok(finCash.incomeTotal >= 99 && finCash.refundTotal === 0 && finCash.withdrawPaid === 0 &&
    finCash.balance === Math.round((finCash.incomeTotal - finCash.refundTotal - finCash.withdrawPaid) * 100) / 100 &&
    typeof finCash.balanceMonth === 'number',
    '现金结余 = 收款 − 退款 − 已打款提现', JSON.stringify(finCash))
  ok(Array.isArray(finance.data.recentCash) && finance.data.recentCash.length >= 1 &&
    finance.data.recentCash[0].kind === '收款' && finance.data.recentCash[0].direction === 'in' &&
    !isNaN(Number(finance.data.recentCash[0].amount)),
    '最近资金流水含收款入账且金额为数值', JSON.stringify((finance.data.recentCash || [])[0]))

  const noteEdit = await call(adminRouter, 'payment.updateNote', {
    id: memberBill.id, note: '微信支付自动入账 · 已对账', voucher: '/uploads/demo.png'
  }, adminCtx)
  ok(noteEdit.ok && noteEdit.data.note === '微信支付自动入账 · 已对账' &&
    noteEdit.data.voucher === '/uploads/demo.png', '收款入账的备注与凭证可修改')
  const noteBad = await call(adminRouter, 'payment.updateNote', {
    id: memberBill.id, note: 'x', voucher: 'javascript:alert(1)'
  }, adminCtx)
  ok(!noteBad.ok && noteBad.code === 'VALIDATION', '凭证地址只接受 http(s) 或站内路径')

  const manualPay = await call(adminRouter, 'payment.manual', {
    uid, amount: 500, method: '对公转账', note: '线下补录服务费', paidAt: now()
  }, adminCtx)
  ok(manualPay.ok && manualPay.data.amount === 500 && manualPay.data.status === '已确认' &&
    manualPay.data.manual === true, '财务可补录线下入账并直接确认', JSON.stringify(manualPay.data || {}))
  const manualBad = await call(adminRouter, 'payment.manual', {
    uid, amount: 100, bizType: '会员', method: '现金'
  }, adminCtx)
  ok(!manualBad.ok && manualBad.code === 'VALIDATION', '补录入账仅支持「其他」业务类型')

  const finComm = await call(adminRouter, 'finance.commissions', { page: 1, limit: 5 }, adminCtx)
  ok(finComm.ok && Array.isArray(finComm.data.items) && finComm.data.types.length === 2 &&
    finComm.data.types.indexOf('客服委托') > -1 && finComm.data.types.indexOf('推广佣金') > -1 &&
    finComm.data.totals && typeof finComm.data.totals.count === 'number',
    '佣金台账只含客服委托与推广佣金两类')
  const csDemo2 = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'cs')
  const csLogin2 = await call(adminRouter, 'admin.login', {
    username: 'cs', password: csDemo2.password, otp: generateTotp(csDemo2.totpSecret, now())
  }, {})
  const csFinance = await call(adminRouter, 'finance.summary', {}, { token: csLogin2.data.token })
  ok(!csFinance.ok && csFinance.code === 'FORBIDDEN', '客服默认无权查看财务汇总')
  const csExpire = await call(adminRouter, 'biz.setExpire', { uid, expireAt }, { token: csLogin2.data.token })
  ok(!csExpire.ok && csExpire.code === 'FORBIDDEN', '客服默认无权修改会员到期时间')
  const csFee = await call(adminRouter, 'payment.feeConfirm', { id: memberBill.id }, { token: csLogin2.data.token })
  ok(!csFee.ok && csFee.code === 'FORBIDDEN', '客服默认无权确认委托服务费到账')

  /* 日趋势与漏斗 */
  const trend = await call(adminRouter, 'stats.trend', { days: 30 }, adminCtx)
  ok(trend.ok && trend.data.series.length === 30 && trend.data.funnel.length === 4, '看板趋势返回 30 天序列与四级漏斗')
  const snapshot = await repo.find('dailyStats', {}, { limit: 5 })
  ok(snapshot.length >= 1, '当天快照写入 dailyStats')

  /* 风险单：四类视图 + 处置 */
  const cases = await call(adminRouter, 'risk.cases', { refresh: true }, adminCtx)
  ok(cases.ok && cases.data.counts.total >= 1 && cases.data.types.length === 5, '风险扫描生成商品 / 用户 / 咨询 / 对话 / 系统五类风险单')
  const one = cases.data.items[0]
  const denyUnclaimed = await call(adminRouter, 'risk.caseUpdate', {
    id: one.id, status: '已处理', owner: '风控 · 王工', action: '已核实', reason: '未领取直接处置'
  }, adminCtx)
  ok(!denyUnclaimed.ok, '未领取的风险单不能直接处置，需先领取')
  const claimed = await call(adminRouter, 'risk.caseUpdate', {
    id: one.id, status: '处理中', owner: '风控 · 王工', action: '领取', reason: '领取处理'
  }, adminCtx)
  ok(claimed.ok && claimed.data.status === '处理中' && !!claimed.data.ownerAccount, '风险单领取后写入领取人归属')
  const handled = await call(adminRouter, 'risk.caseUpdate', {
    id: one.id, status: '已处理', owner: '风控 · 王工', action: '已核实', reason: '人工复核无风险'
  }, adminCtx)
  ok(handled.ok && handled.data.status === '已处理', '风险单领取后可处置并留痕')

  /* 系统日志 / 登录日志 */
  const logs = await call(adminRouter, 'log.list', { tab: 'system' }, adminCtx)
  ok(logs.ok && Array.isArray(logs.data.items), '系统运行日志可查询')
  const loginLogs = await call(adminRouter, 'log.list', { tab: 'login' }, adminCtx)
  ok(loginLogs.ok && loginLogs.data.items.length >= 1, '登录日志记录成功与失败登录')
  const health = await call(adminRouter, 'log.system', {}, adminCtx)
  ok(health.ok && health.data.counts && health.data.health, '系统健康概览可读取')

  /* 自定义角色 + 临时权限 */
  const roleSave = await call(adminRouter, 'role.save', {
    roleKey: 'finance_viewer', name: '财务只读', pages: ['finance', 'stats'], actions: ['finance.summary', 'stats.trend']
  }, adminCtx)
  ok(roleSave.ok && roleSave.data.builtin === false, '可新增自定义角色并配置页面 / 动作')
  const roleList = await call(adminRouter, 'role.list', {}, adminCtx)
  ok(roleList.ok && roleList.data.roles.some((r) => r.roleKey === 'finance_viewer') && roleList.data.pages.length >= 20,
    '角色列表包含内置角色、自定义角色与可选页面')
  const roleBuiltin = await call(adminRouter, 'role.save', { roleKey: 'admin', name: '改超管', pages: ['stats'] }, adminCtx)
  ok(!roleBuiltin.ok && roleBuiltin.code === 'CONFLICT', '内置角色不可修改')
  /* 角色收敛：只保留管理员 / 客服坐席，财务 / 电销 / 预设岗位不再下发 */
  const builtinKeys = roleList.data.roles.filter((r) => r.builtin).map((r) => r.roleKey).sort().join(',')
  ok(builtinKeys === 'admin,cs', '角色列表只保留管理员 / 客服坐席两类内置角色', builtinKeys)
  const presetCreate = await call(adminRouter, 'account.create', {
    username: 'verifyops', name: '预设运营', org: '算力聚合', role: 'ops',
    password: 'VerifyOps@2026', totpSecret: 'JBSWY3DPEHPK3PXP'
  }, adminCtx)
  ok(!presetCreate.ok, '已下线的预设岗位不能再创建账号', presetCreate.message)
  /* 客服权限：工作台 / 工单 / 服务记录开放；数据看板、财务 / 系统设置仍受限 */
  const csToken = { token: csLogin2.data.token }
  const csStatsNew = await call(adminRouter, 'stats.overview', {}, csToken)
  ok(!csStatsNew.ok && csStatsNew.code === 'FORBIDDEN', '客服不再显示数据看板')
  const csServiceNew = await call(adminRouter, 'service.records', {}, csToken)
  ok(csServiceNew.ok, '客服可查看服务记录')
  ok(Array.isArray(csServiceNew.data.staff) && csServiceNew.data.staff.length === 1 &&
    csServiceNew.data.staff[0].username === 'cs', '客服服务记录只返回本人')
  ok((csServiceNew.data.items || []).every((i) => i.actorId === 'cs'), '客服只能看到自己的服务记录')
  const csSetting = await call(adminRouter, 'setting.save', { hotline: '400-000-0000' }, csToken)
  ok(!csSetting.ok && csSetting.code === 'FORBIDDEN', '系统设置仍仅管理员可改')
  const csRemindSet = await call(adminRouter, 'biz.remindSetting', {
    memberRemind: { enabled: true, days: 5, hour: 9, maxTimes: 2, intervalDays: 1, title: '会员即将到期', body: '还有 {days} 天到期（{expire}）' }
  }, csToken)
  ok(csRemindSet.ok && csRemindSet.data.memberRemind.days === 5, '客服可调整会员到期提醒文案与次数')
  const permBad = await call(adminRouter, 'permission.save', { username: 'cs', extraPages: ['finance'], expiresAt: now() - 1000 }, adminCtx)
  ok(!permBad.ok && permBad.code === 'VALIDATION', '临时权限到期时间必须晚于当前时间')
  const perm = await call(adminRouter, 'permission.save', {
    username: 'cs', extraPages: ['finance'], extraActions: ['finance.summary'], expiresAt: now() + 3600 * 1000, note: '临时对账'
  }, adminCtx)
  ok(perm.ok && perm.data.status === 'active', '可给账号叠加临时页面 / 动作权限')
  const csFinanceTemp = await call(adminRouter, 'finance.summary', {}, { token: csLogin2.data.token })
  ok(csFinanceTemp.ok, '临时权限生效后客服可访问财务汇总')
  const roleRemove = await call(adminRouter, 'role.remove', { roleKey: 'finance_viewer' }, adminCtx)
  ok(roleRemove.ok && roleRemove.data.status === 'disabled', '自定义角色可停用')
}

/* ============================================================
   28. 商机池：主体可见门槛 / 会员分层 / 发布方开关
   ============================================================ */
section('28. 商机池：主体可见门槛 / 会员分层 / 发布方开关')
{
  const PUB2 = { openid: 'o_pool_pub', ip: '10.60.0.1' }
  const SEEK = { openid: 'o_pool_seek', ip: '10.60.0.2' }
  await call(userRouter, 'auth.login', { nick: '商机发布者' }, PUB2)
  await call(userRouter, 'profile.save', {
    nick: '商机发布者', realname: '发布者丙', phone: '13900006001', subject: '商机测试有限公司'
  }, PUB2)

  /* 主体默认隐藏：普通发布同样自动进池，是否公开主体不再是门槛 */
  const hiddenPool = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '隐藏主体进池', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 10, budget: 260000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税']
  }, PUB2)
  ok(hiddenPool.ok && (await repo.get('demands', hiddenPool.data.id)).bizPool === true,
    '未公开主体普通发布也自动进入商机池', hiddenPool.message)

  await call(userRouter, 'profile.save', {
    nick: '商机发布者', realname: '发布者丙', phone: '13900006001', subject: '商机测试有限公司', position: '采购经理', exposure: 'open'
  }, PUB2)

  const poolPub = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 10 台 H200', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 10, budget: 260000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税']
  }, PUB2)
  ok(poolPub.ok && (await repo.get('demands', poolPub.data.id)).bizPool === true, '公开主体普通发布自动进入商机池', poolPub.message)

  /* 兼容历史数据：旧「普通发布」（public 且 bizPool=false）同样纳入匹配池 */
  const legacyPub = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '旧普通发布需求', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 10, budget: 260000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税']
  }, PUB2)
  await repo.updateWhere('demands', { id: legacyPub.data.id }, { bizPool: false, channel: 'normal' })
  ok((await repo.get('demands', legacyPub.data.id)).bizPool === false, '构造旧普通发布历史数据（bizPool=false）')

  /* 私密发布：不进入匹配池、不触发提醒 */
  const privPub = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, visibility: 'private', title: '私密发布需求', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 10, budget: 260000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税']
  }, PUB2)
  ok(privPub.ok && (await repo.get('demands', privPub.data.id)).bizPool === false, '私密发布不进入商机池', privPub.message)

  await call(userRouter, 'auth.login', { nick: '商机查看者' }, SEEK)
  await call(userRouter, 'profile.save', {
    nick: '商机查看者', realname: '商机查看者', phone: '13900006002', subject: '商机查看有限公司', position: '采购经理', exposure: 'open'
  }, SEEK)
  const seekStock = await call(userRouter, 'stock.save', {
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G', qty: 15, price: 250000, city: '深圳',
    images: ['cloud://test.bucket/stock/h200-1.jpg', 'https://cdn.example.com/stock/h200-2.jpg']
  }, SEEK)
  ok(seekStock.ok && (seekStock.data.images || []).length === 2, '库存支持上传图片并原样回传', seekStock.message)
  const badStockImg = await call(userRouter, 'stock.save', {
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G', qty: 15, price: 250000, city: '深圳',
    images: ['wxfile://tmp_123.jpg']
  }, SEEK)
  ok(!badStockImg.ok && String(badStockImg.message).includes('云端'), '库存图片拒绝本机临时路径', badStockImg.message)

  /* 匿名主体发布：照样进池，但对他人展示时主体脱敏，仍可通过 ownerKey 打开主页 */
  const ANON = { openid: 'o_pool_anon', ip: '10.60.0.9' }
  await call(userRouter, 'auth.login', { nick: '匿名商机主体' }, ANON)
  await call(userRouter, 'profile.save', {
    nick: '匿名商机主体', realname: '匿名主体', phone: '13900006009', subject: '匿名测试有限公司'
  }, ANON)
  const anonPub = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 9 台 H200', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 9, budget: 259000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税']
  }, ANON)
  ok(anonPub.ok && (await repo.get('demands', anonPub.data.id)).bizPool === true,
    '匿名主体需求同样进入商机池', anonPub.message)

  /* 未开通会员：角标照常显示匹配数（开通前无法消除），列表锁定且全部脱敏，看不到榜单 */
  const badge = await call(userRouter, 'biz.badge', {}, SEEK)
  ok(badge.ok && badge.data.unlocked === false && Number(badge.data.count) >= 1,
    '未开通商机会员也显示商机角标', badge.message)
  const listLocked = await call(userRouter, 'biz.list', {}, SEEK)
  ok(listLocked.ok && listLocked.data.locked === true, '未开通商机会员时商机列表为锁定态')
  const lockedItems = listLocked.data.items || []
  ok(lockedItems.length > 0 && lockedItems.every((i) => !('masked' in i) && i.canClaim === false &&
    i.phone === '' && i.contactVisible === false), '未开通时联系方式与领取能力锁定')
  ok(lockedItems.some((i) => i.model && i.model !== '****' && /^¥/.test(String(i.priceText || ''))),
    '未开通时型号与价格仍可见，便于判断商机真实性')
  const lockIds = (listLocked.data.items || []).map((i) => i.id)
  ok(lockIds.indexOf(poolPub.data.id) >= 0 && lockIds.indexOf(legacyPub.data.id) >= 0 &&
    lockIds.indexOf(hiddenPool.data.id) >= 0 && lockIds.indexOf(anonPub.data.id) >= 0 &&
    lockIds.indexOf(privPub.data.id) < 0,
    '普通发布（含旧 public+bizPool=false）自动进池，私密发布排除')
  const anonLocked = lockedItems.filter((i) => i.id === anonPub.data.id)[0]
  ok(!!anonLocked && !!anonLocked.ownerKey && !!anonLocked.org &&
    anonLocked.org !== '匿名测试有限公司', '匿名主体商机带 ownerKey，主体脱敏且不为空')
  const marketLocked = await call(userRouter, 'insights.market', { limit: 10 }, SEEK)
  ok(marketLocked.ok && marketLocked.data.locked === true && (marketLocked.data.boards || []).length === 0,
    '未开通会员拿不到热度榜单与供求关系')

  await call(adminRouter, 'biz.grant', { uid: SEEK.openid, note: '微信收款 99 元' }, { token: adminToken })

  /* 开通会员：可见匹配结果与必须条件 */
  const listOpen = await call(userRouter, 'biz.list', {}, SEEK)
  ok(listOpen.ok && listOpen.data.locked === false, '开通商机后可查看商机信息')
  const openItem = (listOpen.data.items || []).filter((i) => i.id === poolPub.data.id)[0]
  ok(!!openItem && openItem.matched === true && Array.isArray(openItem.must),
    '开通后下发库存匹配结果与必须条件')
  const anonOpen = (listOpen.data.items || []).filter((i) => i.id === anonPub.data.id)[0]
  ok(!!anonOpen && !!anonOpen.ownerKey && !!anonOpen.org && anonOpen.org !== '匿名测试有限公司',
    '会员查看匿名主体商机：主体保持脱敏，ownerKey 可跳主页')
  const marketOpen = await call(userRouter, 'insights.market', { limit: 10 }, SEEK)
  ok(marketOpen.ok && marketOpen.data.locked !== true && Array.isArray(marketOpen.data.boards),
    '开通后可查看产品热度榜单与供求关系')

  /* 「我的商机」角标与列表只算已领取，不把商机池里可领取的也计进去 */
  const badgeBefore = await call(userRouter, 'biz.badge', {}, SEEK)
  ok(badgeBefore.ok && badgeBefore.data.claimed === 0, '「我的商机」角标统计已领取条数：领取前为 0')
  /* 商机被领取不再提醒：提醒只发生在「发布新商机」时，领取后由对方主动发消息才产生聊天提醒 */
  const noticesBeforeClaim = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub.data.id
  }, { limit: 20 })
  const claimPool = await claimOf({ targetType: 'demand', demandId: poolPub.data.id }, SEEK)
  ok(claimPool.ok, '商机会员可领取匹配的商机', claimPool.message)
  const claimNotices = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub.data.id
  }, { limit: 20 })
  ok(claimNotices.length === noticesBeforeClaim.length, '领取商机不再给领取方 / 发布方新增站内提醒')
  await claimOf({ targetType: 'demand', demandId: poolPub.data.id }, SEEK)
  const claimNoticesAgain = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub.data.id
  }, { limit: 20 })
  ok(claimNoticesAgain.length === noticesBeforeClaim.length, '重复领取同样不产生提醒')
  const badgeAfter = await call(userRouter, 'biz.badge', {}, SEEK)
  ok(badgeAfter.ok && badgeAfter.data.claimed === 1,
    '领取后「我的商机」角标为已领取 1 条（不是可领取条数）',
    badgeAfter.ok ? `claimed=${badgeAfter.data.claimed} / count=${badgeAfter.data.count}` : badgeAfter.message)
  const mineList = await call(userRouter, 'biz.list', {}, SEEK)
  const mineClaimedIds = (mineList.data.items || []).filter((i) => i.claimed).map((i) => i.id)
  ok(mineClaimedIds.indexOf(poolPub.data.id) >= 0 && mineClaimedIds.indexOf(privPub.data.id) < 0,
    '「我的商机」列表只包含已领取的条目')

  const claimPriv = await claimOf({ targetType: 'demand', demandId: privPub.data.id }, SEEK)
  ok(!claimPriv.ok && claimPriv.code === 'NOT_FOUND', '私密发布的需求不可领取')

  /* 领取方未公开主体也能领取：匿名主体开通会员后同样可领取 */
  await call(adminRouter, 'biz.grant', { uid: ANON.openid, note: '匿名主体领取测试' }, { token: adminToken })
  await call(userRouter, 'stock.save', {
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G', qty: 20, price: 250000, city: '深圳'
  }, ANON)
  const anonClaim = await claimOf({ targetType: 'demand', demandId: poolPub.data.id }, ANON)
  ok(anonClaim.ok, '领取方未公开主体也可领取商机', anonClaim.message)

  /* 发布即提醒：新需求进池时，匹配会员与发布者各收到一条站内信，同一条商机只提醒一次 */
  const poolPub2 = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 12 台 H200', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 12, budget: 258000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税'], bizPool: true
  }, PUB2)
  ok(poolPub2.ok, '发布新需求进入商机池', poolPub2.message)
  const seekNotice = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub2.data.id, 'payload.uid': SEEK.openid
  }, { limit: 10 })
  ok(seekNotice.length === 1 && String((seekNotice[0].payload || {}).body || '').includes('可在商机页查看'),
    '匹配的商机会员收到一条「可在商机页查看」提醒',
    `count=${seekNotice.length}`)
  const pubNotice = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub2.data.id, 'payload.uid': PUB2.openid
  }, { limit: 10 })
  /* 汇总只统计「商机池商品」：对方私库存不告知需求方，匿名主体的商品也计入匹配 */
  ok(pubNotice.length === 1 && String((pubNotice[0].payload || {}).body || '').includes('1 家货源'),
    '需求发布者的汇总提醒只统计商机池商品，不把对方私库存算进去',
    `count=${pubNotice.length}`)
  /* 所有匹配用户都会收到提醒：非会员也提醒，文案引导开通 */
  const NOMEM = { openid: 'o_pool_nomem', ip: '10.60.0.3' }
  await call(userRouter, 'auth.login', { nick: '未开通会员的货源方' }, NOMEM)
  await call(userRouter, 'profile.save', {
    nick: '未开通会员的货源方', realname: '未开通会员', phone: '13900006003', subject: '未开通会员货源有限公司', position: '采购经理', exposure: 'open'
  }, NOMEM)
  await call(userRouter, 'stock.save', {
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G', qty: 30, price: 252000, city: '深圳'
  }, NOMEM)
  CLOCK += 61 * 60 * 1000
  /* 换一个新发布号，避免同一账号的发布频率限制干扰本用例 */
  const PUBB = { openid: 'o_pool_pubb', ip: '10.60.0.8' }
  await call(userRouter, 'auth.login', { nick: '商机发布者丁' }, PUBB)
  await call(userRouter, 'profile.save', {
    nick: '商机发布者丁', realname: '发布者丁', phone: '13900006008', subject: '商机测试丁有限公司', position: '采购经理', exposure: 'open'
  }, PUBB)
  const poolPub3 = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 8 台 H200', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 8, budget: 256000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税'], bizPool: true
  }, PUBB)
  ok(poolPub3.ok, '再次发布新需求进入商机池', poolPub3.message)
  const nomemNotice = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub3.data.id, 'payload.uid': NOMEM.openid
  }, { limit: 10 })
  ok(nomemNotice.length === 1 &&
    String((nomemNotice[0].payload || {}).body || '').includes('开通商机会员即可查看') &&
    String((nomemNotice[0].payload || {}).body || '').includes('与你的库存匹配'),
    '未开通会员的货源方也收到新商机提醒，文案引导开通且按库存来源描述',
    `count=${nomemNotice.length}`)
  const seekNotice3 = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub3.data.id, 'payload.uid': SEEK.openid
  }, { limit: 10 })
  ok(seekNotice3.length === 1, '新商机按条提醒：会员对每个新商机各收到一条')
  const pubNotice3 = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub3.data.id, 'payload.uid': PUBB.openid
  }, { limit: 10 })
  ok(pubNotice3.length === 1 && String((pubNotice3[0].payload || {}).body || '').includes('1 家货源'),
    '对方仅有库存时需求发布者的汇总仍只统计商机池商品')

  /* 「只看公开主体」跟随提醒：接收方开启后，发布方主体未公开则不打扰 */
  await call(userRouter, 'biz.prefs', { save: true, level: 'standard', onlyOpenSubject: true }, NOMEM)
  CLOCK += 61 * 60 * 1000
  const anonPub2 = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 7 台 H200', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 7, budget: 257000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税']
  }, ANON)
  ok(anonPub2.ok, '匿名主体再次发布需求', anonPub2.message)
  const nomemFiltered = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': anonPub2.data.id, 'payload.uid': NOMEM.openid
  }, { limit: 10 })
  ok(nomemFiltered.length === 0, '只看公开主体：发布方未公开时不打扰该接收方',
    `count=${nomemFiltered.length}`)
  await call(userRouter, 'biz.prefs', { save: true, level: 'standard', onlyOpenSubject: false }, NOMEM)
  CLOCK += 61 * 60 * 1000
  const anonPub3 = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 8 台 H200', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 8, budget: 257000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税']
  }, ANON)
  ok(anonPub3.ok, '关闭筛选后匿名主体再次发布需求', anonPub3.message)
  const nomemUnfiltered = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': anonPub3.data.id, 'payload.uid': NOMEM.openid
  }, { limit: 10 })
  ok(nomemUnfiltered.length === 1, '关闭筛选后非会员重新收到匿名主体的商机提醒',
    `count=${nomemUnfiltered.length}`)

  /* 反向用例：对方在商机池发布了对应商品，需求发布者才会收到汇总提醒 */
  const PROD = { openid: 'o_pool_prod', ip: '10.60.0.4' }
  await call(userRouter, 'auth.login', { nick: '商机池货源方' }, PROD)
  await call(userRouter, 'profile.save', {
    nick: '商机池货源方', realname: '货源方丁', phone: '13900006004', subject: '货源测试有限公司', position: '采购经理', exposure: 'open'
  }, PROD)
  await call(adminRouter, 'biz.grant', { uid: PROD.openid, note: '微信收款 99 元' }, { token: adminToken })
  const prodPool = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: 'H200 141G 商机池现货',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 30, minQty: 1, price: '252000', cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货', deliver: '3 天内',
    must: [], nego: [], flow: []
  }, PROD)
  ok(prodPool.ok && (await repo.get('products', prodPool.data.id)).bizPool === true,
    '货源方在商机池发布对应商品', prodPool.message)
  CLOCK += 61 * 60 * 1000
  /* 换一个新发布号，避免同一账号的发布频率限制干扰本用例 */
  const PUB5 = { openid: 'o_pool_pub2', ip: '10.60.0.5' }
  await call(userRouter, 'auth.login', { nick: '商机发布者乙' }, PUB5)
  await call(userRouter, 'profile.save', {
    nick: '商机发布者乙', realname: '发布者戊', phone: '13900006005', subject: '商机测试乙有限公司', position: '采购经理', exposure: 'open'
  }, PUB5)
  const poolPub4 = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 6 台 H200', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 6, budget: 258000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税'], bizPool: true
  }, PUB5)
  ok(poolPub4.ok, '发布新需求（商机池已有对应商品）', poolPub4.message)
  const pubNotice4 = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub4.data.id, 'payload.uid': PUB5.openid
  }, { limit: 10 })
  const pubNotice4Body = pubNotice4.length ? String((pubNotice4[0].payload || {}).body) : ''
  ok(pubNotice4.length === 1 && /家货源与/.test(pubNotice4Body),
    '商机池商品匹配时需求发布者收到汇总提醒',
    pubNotice4Body)
  const prodNotice = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub4.data.id, 'payload.uid': PROD.openid
  }, { limit: 10 })
  ok(prodNotice.length === 1 &&
    String((prodNotice[0].payload || {}).body || '').includes('与你发布的货源匹配'),
    '商机池货源方同样收到「有新的商机可查看」提醒，且按商品来源描述',
    prodNotice.length ? String((prodNotice[0].payload || {}).body) : '')

  /* 提示力度：三档预设 + 维度微调，直接决定「什么算匹配」 */
  const prefDefault = await call(userRouter, 'biz.prefs', {}, SEEK)
  ok(prefDefault.ok && prefDefault.data.prefs.level === 'standard', '提示力度默认为标准档')
  ok((prefDefault.data.prefPresets || []).length === 3, '下发宽松 / 标准 / 严格三档预设')
  const prefStrict = await call(userRouter, 'biz.prefs', { save: true, level: 'strict' }, SEEK)
  ok(prefStrict.ok && prefStrict.data.prefs.level === 'strict' &&
    prefStrict.data.prefs.brand === 'same' && prefStrict.data.prefs.qty === 'exceed',
    '可保存严格档：只接指定品牌，且库存量要覆盖需求量', prefStrict.message)
  CLOCK += 24 * 60 * 60 * 1000
  const bigDemand = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 20 台 H200', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 20, budget: 260000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税'], bizPool: true
  }, PUB2)
  ok(bigDemand.ok, '发布超出库存量的需求', bigDemand.message)
  const strictNotice = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': bigDemand.data.id, 'payload.uid': SEEK.openid
  }, { limit: 10 })
  ok(strictNotice.length === 0, '严格档：库存量不足需求量时不提醒')
  const prefLoose = await call(userRouter, 'biz.prefs', { save: true, level: 'loose' }, SEEK)
  ok(prefLoose.ok && prefLoose.data.prefs.level === 'loose' &&
    prefLoose.data.prefs.qty === 'any' && prefLoose.data.prefs.model === 'series',
    '可切换宽松档：同系列即可，数量不限', prefLoose.message)
  CLOCK += 61 * 60 * 1000
  const bigDemand2 = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 30 台 H200', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 30, budget: 260000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税'], bizPool: true
  }, PUB2)
  ok(bigDemand2.ok, '再次发布超出库存量的需求', bigDemand2.message)
  const looseNotice = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': bigDemand2.data.id, 'payload.uid': SEEK.openid
  }, { limit: 10 })
  ok(looseNotice.length === 1, '宽松档：数量不满足也提醒')
  const prefCustom = await call(userRouter, 'biz.prefs', {
    save: true, brand: 'same', model: 'series', qty: 'any', cap: 'any'
  }, SEEK)
  ok(prefCustom.ok && prefCustom.data.prefs.level === 'custom' &&
    prefCustom.data.prefs.brand === 'same' && prefCustom.data.prefs.model === 'series',
    '非预设组合按维度微调，落为自定义档', prefCustom.message)
  await call(userRouter, 'biz.prefs', { save: true, level: 'standard' }, SEEK)

  /* 商机展示设置：「只看公开主体」是独立开关，命中隐藏主体时返回 hiddenCount */
  const badgeAll = await call(userRouter, 'biz.badge', {}, SEEK)
  const prefOpenSubject = await call(userRouter, 'biz.prefs', { save: true, level: 'standard', onlyOpenSubject: true }, SEEK)
  ok(prefOpenSubject.ok && prefOpenSubject.data.prefs.onlyOpenSubject === true,
    '可保存「只看公开主体」独立开关', prefOpenSubject.message)
  const listFiltered = await call(userRouter, 'biz.list', {}, SEEK)
  const filteredIds = (listFiltered.data.items || []).map((i) => i.id)
  ok(filteredIds.indexOf(poolPub.data.id) >= 0 && filteredIds.indexOf(anonPub.data.id) < 0,
    '只看公开主体：隐藏主体条目被筛掉，公开主体条目保留')
  ok(Number(listFiltered.data.hiddenCount) >= 1, '筛选后返回被隐藏的条数 hiddenCount',
    `hiddenCount=${listFiltered.data.hiddenCount}`)
  ok(Number(listFiltered.data.matchedCount) <= (listFiltered.data.items || []).length,
    'matchedCount 与筛选后的条目一致')
  const badgeFiltered = await call(userRouter, 'biz.badge', {}, SEEK)
  ok(badgeFiltered.ok && Number(badgeFiltered.data.count) <= Number(badgeAll.data.count),
    '商机角标同步应用「只看公开主体」筛选')
  const prefStrictKeep = await call(userRouter, 'biz.prefs', { save: true, level: 'strict' }, SEEK)
  ok(prefStrictKeep.ok && prefStrictKeep.data.prefs.onlyOpenSubject === true,
    '切换档位不影响独立的「只看公开主体」开关', prefStrictKeep.message)
  await call(userRouter, 'biz.prefs', { save: true, level: 'standard', onlyOpenSubject: false }, SEEK)
}

/* ============================================================
   29. 商机匹配：普通 / 私密发布、反向货源、三榜
   ============================================================ */
section('29. 商机匹配：普通 / 私密发布、反向货源、三榜')
{
  const CH_PUB = { openid: 'o_chan_pub', ip: '10.61.0.1' }
  const CH_SEEK = { openid: 'o_chan_seek', ip: '10.61.0.2' }
  const CH_OTHER = { openid: 'o_chan_other', ip: '10.61.0.3' }
  for (const u of [CH_PUB, CH_SEEK, CH_OTHER]) {
    await call(userRouter, 'auth.login', { nick: '渠道测试用户' }, u)
  }
  await call(userRouter, 'profile.save', {
    nick: '渠道发布者', realname: '渠道发布者', phone: '13900007001',
    subject: '渠道测试有限公司', position: '采购经理', exposure: 'open', phonePublic: true
  }, CH_PUB)

  /* ① 私密发布：不进入商机池，但普通列表 / 详情按匿名口径照常可看 */
  const privProd = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, visibility: 'private', title: '私密 H200 货源', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H200 141G', qty: 20, price: 258000, cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货'
  }, CH_PUB)
  ok(privProd.ok && (await repo.get('products', privProd.data.id)).bizPool === false,
    '私密发布不进入商机池', privProd.message)
  const pubList = await call(userRouter, 'product.list', { limit: 50 }, CH_OTHER)
  const privListItem = (pubList.data.items || []).filter((i) => i.id === privProd.data.id)[0]
  ok(pubList.ok && !privListItem, '私密货源不出现在普通列表')
  const privDetail = await call(userRouter, 'product.detail', { id: privProd.data.id }, CH_OTHER)
  ok(!privDetail.ok, '私密货源非本人不可查看')
  const mineDetail = await call(userRouter, 'product.detail', { id: privProd.data.id }, CH_PUB)
  ok(mineDetail.ok, '发布者本人仍可查看私密货源')

  /* ② 普通发布：自动进入商机池，同时照常出现在普通列表 */
  const normalOnly = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: '普通发布 A100 货源', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'A100 80G', qty: 6, price: 118000, cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货'
  }, CH_PUB)
  ok(normalOnly.ok && (await repo.get('products', normalOnly.data.id)).bizPool === true,
    '普通发布自动进入商机池')
  const normalList = await call(userRouter, 'product.list', { limit: 50 }, CH_OTHER)
  ok(normalList.ok && normalList.data.items.some((i) => i.id === normalOnly.data.id), '普通发布商品正常出现在普通列表')

  /* ③ 历史旧普通发布（public 且 bizPool=false）：同样纳入商机匹配 */
  const legacyProd = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: '旧普通发布 H200 货源', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H200 141G', qty: 15, price: 257000, cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货'
  }, CH_PUB)
  await repo.updateWhere('products', { id: legacyProd.data.id }, { bizPool: false, channel: 'normal' })
  ok((await repo.get('products', legacyProd.data.id)).bizPool === false,
    '构造旧普通发布历史货源（bizPool=false）')

  /* ④ 公开货源用于反向匹配（普通发布已合并原「二者都发」） */
  const bothPub = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: '公开 H200 货源', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H200 141G', qty: 30, price: 256000, cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货'
  }, CH_PUB)
  const bothRaw = await repo.get('products', bothPub.data.id)
  ok(bothPub.ok && bothRaw.bizPool === true, '公开货源自动进入商机池')
  const bothList = await call(userRouter, 'product.list', { limit: 50 }, CH_OTHER)
  ok(bothList.data.items.some((i) => i.id === bothPub.data.id), '公开货源仍在普通列表')

  /* ⑤ 需求侧：私密需求不进池，普通需求自动进池并正常出现在普通需求列表 */
  const privDemand = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, visibility: 'private', title: '私密求购 H200', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H200 141G', qty: 5, budget: 250000, city: '深圳',
    supply: '现货', cond: '全新', tax: ['含税']
  }, CH_PUB)
  ok(privDemand.ok && (await repo.get('demands', privDemand.data.id)).bizPool === false,
    '私密需求不进入商机池', privDemand.message)
  const demandList = await call(userRouter, 'demand.list', { limit: 50 }, CH_OTHER)
  ok(demandList.ok && !demandList.data.items.some((i) => i.id === privDemand.data.id),
    '私密需求不出现在普通需求列表')

  /* ⑥ 反向货源：求购方无库存，别人货源命中自己的需求才出现 */
  await call(userRouter, 'profile.save', {
    nick: '商机求购方', realname: '商机求购方', phone: '13900007002', subject: '商机求购有限公司', position: '采购经理', exposure: 'open'
  }, CH_SEEK)
  const seekDemand = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 12 台 H200', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H200 141G', qty: 12, budget: 250000, city: '深圳',
    supply: '现货', cond: '', tax: ['含税'], channel: 'both'
  }, CH_SEEK)
  ok(seekDemand.ok, '求购方发布需求用于反向匹配', seekDemand.message)
  await call(adminRouter, 'biz.grant', { uid: CH_SEEK.openid, note: '反向商机测试' }, { token: adminToken })
  const revList = await call(userRouter, 'biz.list', {}, CH_SEEK)
  const revItems = (revList.data.items || []).filter((i) => i.type === 'supply')
  ok(revList.ok && revItems.some((i) => i.id === bothPub.data.id), '满足我已发布需求的他人货源作为商机展示', revList.message)
  ok(revItems.some((i) => i.id === legacyProd.data.id), '旧 public+bizPool=false 货源同样进入商机匹配')
  ok(revItems.every((i) => String(i.demandText || '').indexOf('匹配我的需求') === 0), '反向商机标注命中了我的哪条需求')
  ok(!revItems.some((i) => i.id === privProd.data.id), '私密发布的货源不进入商机池')
  ok(!(revList.data.items || []).some((i) => i.type === 'demand' && i.id === seekDemand.data.id),
    '自己发布的需求不会出现在自己的商机列表')

  /* ⑦ supply 领取：解锁货主联系方式，重复领取幂等 */
  const supplyClaim = await claimOf({ targetType: 'supply', supplyId: bothPub.data.id }, CH_SEEK)
  ok(supplyClaim.ok && !!supplyClaim.data.contact && !!supplyClaim.data.contact.phone,
    '领取匹配货源的商机后可获取联系方式', supplyClaim.message)
  const supplyClaim2 = await claimOf({ targetType: 'supply', supplyId: bothPub.data.id }, CH_SEEK)
  ok(supplyClaim2.ok && supplyClaim2.data.already === true, '重复领取同一货源幂等')
  const revAfter = await call(userRouter, 'biz.list', {}, CH_SEEK)
  const revItemAfter = (revAfter.data.items || []).filter((i) => i.id === bothPub.data.id)[0]
  ok(!!revItemAfter && revItemAfter.claimed === true && revItemAfter.contactVisible === true,
    '领取后商机列表回显联系方式可见')

  await call(adminRouter, 'biz.grant', { uid: CH_OTHER.openid, note: '无需求领取测试' }, { token: adminToken })
  const otherNoDemand = await claimOf({ targetType: 'supply', supplyId: bothPub.data.id }, CH_OTHER)
  ok(!otherNoDemand.ok && otherNoDemand.code === 'FORBIDDEN', '没有匹配求购时不能领取货源')

  /* ⑧ 三个榜单：需求榜 / 火热榜 / 供给榜 */
  const market = await call(userRouter, 'insights.market', { limit: 10 }, CH_SEEK)
  const ranks = market.data.ranks || []
  ok(market.ok && ranks.length === 3, '商机榜单返回三个榜单')
  ok(ranks.map((r) => r.key).join(',') === 'demand,hot,supply', '榜单依次为需求榜 / 火热榜 / 供给榜')
  ok(ranks.every((r) => Array.isArray(r.items)), '每个榜单都返回条目')
}

/* ============================================================
   30. 敏感词风控 / 留言渠道 / 主体类型
   ============================================================ */
section('30. 敏感词风控 / 留言渠道 / 主体类型')
{
  const { scanSensitive } = require(path.join(shared, 'sensitive.js'))
  const pornHit = scanSensitive('你们这边可以 约 炮 吗')
  ok(pornHit.length === 1 && pornHit[0].code === 'sensitive_porn' && pornHit[0].words.indexOf('约炮') >= 0,
    '词库可识别拆字书写的涉黄敏感词')
  const multiHit = scanSensitive('卖枪 和 台独')
  ok(multiHit.length === 2
    && multiHit.some((h) => h.code === 'sensitive_violence')
    && multiHit.some((h) => h.code === 'sensitive_politics'),
  '暴力 / 反动词库分别命中并归类')

  const WX = { openid: 'o_sensitive_chat', ip: '10.70.0.1' }
  await call(userRouter, 'auth.login', { nick: '敏感词测试' }, WX)
  const kfPorn = await call(userRouter, 'msg.send', { body: '你们这边可以约炮吗' }, WX)
  ok(kfPorn.ok, '命中敏感词的客服留言照常发送，不做拦截', kfPorn.message)

  const risk30 = await call(adminRouter, 'risk.cases', { refresh: true, type: '对话', limit: 200 }, { token: adminToken })
  const pornCase = (risk30.data.items || []).find((c) => c.ruleCode === 'sensitive_porn' && c.targetId === WX.openid)
  ok(!!pornCase && pornCase.status === '待处理', '留言命中涉黄词生成「对话」待处理风险单，等待人工查看')

  const claimed30 = await call(adminRouter, 'risk.caseUpdate', {
    id: pornCase.id, status: '处理中', owner: '风控 · 李工', action: '领取', reason: '领取处理'
  }, { token: adminToken })
  ok(claimed30.ok && claimed30.data.status === '处理中', '待处理风险单需先领取')
  const handled30 = await call(adminRouter, 'risk.caseUpdate', {
    id: pornCase.id, status: '已处理', owner: '风控 · 李工', action: '已核实', reason: '人工查看后确认处置'
  }, { token: adminToken })
  ok(handled30.ok && handled30.data.status === '已处理', '风险单必须由平台人工查看后处置')
  const afterHandle = (await call(adminRouter, 'risk.cases', { refresh: true, type: '对话', limit: 200 }, { token: adminToken }))
    .data.items.find((c) => c.id === pornCase.id)
  ok(!!afterHandle && afterHandle.status === '已处理', '重新扫描不会自动放过已人工处置的风险单')

  const kfPorn2 = await call(userRouter, 'msg.send', { body: '约炮 价格怎么算' }, WX)
  ok(kfPorn2.ok, '再次命中敏感词仍照常发送')
  const reopened = (await call(adminRouter, 'risk.cases', { type: '对话', limit: 200 }, { token: adminToken }))
    .data.items.find((c) => c.id === pornCase.id)
  ok(!!reopened && reopened.status === '待处理', '已处理的风险单再次命中时重新打开为待处理')

  const badProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: '自制炸弹货源测试', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H100 80G', qty: 5, price: 200000, cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货'
  }, WX)
  ok(badProduct.ok, '含涉暴词的商品照常发布，仅提示风险', badProduct.message)
  const prodRiskList = await call(adminRouter, 'risk.list', {}, { token: adminToken })
  const badRiskItem = (prodRiskList.data.items || []).find((r) => r.id === badProduct.data.id)
  ok(!!badRiskItem && badRiskItem.riskHits.some((h) => h.code === 'sensitive_violence'),
    '商品发布即标记涉暴敏感词风险命中')
  const prodCase = (await call(adminRouter, 'risk.cases', { refresh: true, type: '商品', limit: 200 }, { token: adminToken }))
    .data.items.find((c) => c.targetId === badProduct.data.id && c.ruleCode === 'sensitive_violence')
  ok(!!prodCase && prodCase.status === '待处理', '商品涉暴风险进入待处理风险单')

  /* 咨询正文命中敏感词：全量扫描生成「咨询」风险单 */
  const LEAD30 = 'LD_SENSITIVE_TEST_30'
  await repo.insert('leads', {
    id: LEAD30, uid: WX.openid, status: '已分配', formSummary: '想了解裸聊服务',
    createdAt: now(), updatedAt: now()
  })
  const consultCase = (await call(adminRouter, 'risk.cases', { refresh: true, type: '咨询', limit: 200 }, { token: adminToken }))
    .data.items.find((c) => c.targetId === LEAD30 && c.ruleCode === 'sensitive_porn')
  ok(!!consultCase, '咨询内容命中敏感词生成「咨询」风险单')

  /* 管理端消息中心：只收客服留言渠道，直聊不混入；图片与名片可见 */
  const directBody = '用户之间直聊内容不应出现在客服消息里'
  await repo.insert('outbox', {
    id: 'M_DIRECT_30', type: 'chat.direct',
    payload: {
      uid: WX.openid, channel: 'direct', from: 'me', peer: 'o_peer_30',
      body: directBody, kind: 'text', threadId: 'LD_DIRECT_30'
    },
    status: 'pending', readByUser: true, readByStaff: false, createdAt: now()
  })
  const imgMsg = await call(userRouter, 'msg.send', {
    kind: 'image', image: 'https://cdn.example.com/chat-30.png'
  }, WX)
  ok(imgMsg.ok && imgMsg.data.kind === 'image', '用户留言可发送图片')
  const cardMsg = await call(userRouter, 'msg.send', { kind: 'card' }, WX)
  ok(cardMsg.ok && cardMsg.data.kind === 'card' && !!cardMsg.data.card, '用户留言可发送个人名片')

  /* 连续留言合并到同一张待领取工单，领取后才接入消息中心 */
  const wxLeave = await repo.find('leads', { uid: WX.openid, source: 'kf_leave' }, { limit: 5 })
  ok(wxLeave.length === 1, '同一用户的连续留言合并到一张待领取工单', JSON.stringify(wxLeave.map((l) => l.id)))
  const wxClaim = await call(adminRouter, 'lead.claim', { leadId: wxLeave[0].id }, { token: adminToken })
  ok(wxClaim.ok, '管理端领取平台留言工单后消息进入消息中心')

  /* 老数据没有 kind 字段：按图片 / 名片内容兼容识别 */
  await repo.insert('outbox', {
    id: 'M_LEGACY_IMG_30', type: 'kf.chat',
    payload: {
      uid: WX.openid, channel: 'kf', from: 'user', body: '[图片]',
      image: 'https://cdn.example.com/legacy-30.png'
    },
    status: 'pending', readByUser: true, readByStaff: false, createdAt: now()
  })
  await repo.insert('outbox', {
    id: 'M_LEGACY_CARD_30', type: 'kf.chat',
    payload: {
      uid: WX.openid, channel: 'kf', from: 'user', body: '[名片] 老数据',
      card: { name: '老数据名片', subject: '历史企业', uid: '' }
    },
    status: 'pending', readByUser: true, readByStaff: false, createdAt: now()
  })

  const adminMsgs = await call(adminRouter, 'msg.list', { uid: WX.openid, limit: 100 }, { token: adminToken })
  ok(adminMsgs.ok, '管理端可读取用户「咨询客服」留言', adminMsgs.message)
  const msgItems = (adminMsgs.data && adminMsgs.data.items) || []
  ok(!msgItems.some((m) => m.body === directBody || m.channel === 'direct'),
    '管理端消息中心不展示用户之间的直聊')
  ok(msgItems.some((m) => m.kind === 'image' && /chat-30\.png/.test(m.image)),
    '管理端可以看到用户留言里的图片')
  ok(msgItems.some((m) => m.kind === 'image' && /legacy-30\.png/.test(m.image)),
    '没有 kind 字段的历史图片消息也能识别展示')
  ok(msgItems.some((m) => m.kind === 'card' && m.card && m.card.name === '老数据名片'),
    '管理端可以看到用户留言里的名片（含历史数据）')
  ok(msgItems.some((m) => m.kind === 'card' && m.card && !!m.card.name && m.body.indexOf('名片') >= 0),
    '新发送的名片消息同样可在管理端渲染')

  /* 用户管理：主体类型筛选枚举与用户端设置保持一致 */
  const adminUsers = await call(adminRouter, 'user.list', { q: '敏感词测试', limit: 20 }, { token: adminToken })
  const types30 = (adminUsers.data && adminUsers.data.subjectTypes) || []
  const NEED_TYPES = [
    '个人', '个体户', '国央企', '央企', '国企', '上市公司', '民企', '外企',
    '合资企业', '合伙企业', '事业单位', '政府机关', '社会团体', '其他'
  ]
  ok(adminUsers.ok && types30.length === NEED_TYPES.length && NEED_TYPES.every((t) => types30.indexOf(t) >= 0),
    '用户管理下发完整 14 种主体类型筛选（含个人 / 国央企 / 上市公司 / 个体户）')
}

/* ============================================================
   31. 商品对话 / 作业记录 / 待办 / 用户导出
   ============================================================ */
section('31. 商品对话 / 作业记录 / 待办 / 用户导出')
{
  const A = { openid: 'o_chat31_a', ip: '10.31.0.1' }
  const B = { openid: 'o_chat31_b', ip: '10.31.0.2' }
  await call(userRouter, 'auth.login', { nick: '对话卖家31' }, A)
  await call(userRouter, 'auth.login', { nick: '对话买家31' }, B)

  const PRODUCT_ID = 'P_CHAT_31'
  const LEAD_ID = 'LD_CHAT_31'
  await repo.insert('products', {
    id: PRODUCT_ID, title: '对话测试商品31', ownerId: A.openid, status: '在售',
    deleted: false, createdAt: now() - 10000
  })
  /* 线索不限制状态：关闭态也应能看到历史直聊 */
  await repo.insert('leads', {
    id: LEAD_ID, uid: B.openid, productId: PRODUCT_ID, ownerId: A.openid,
    status: '已关闭', createdAt: now() - 9000
  })
  const directBase = {
    type: 'direct.chat',
    payload: { uid: B.openid, channel: 'direct', from: 'me', peerUid: A.openid, peerName: '对话卖家31', kind: 'text', threadId: LEAD_ID },
    status: 'pending', createdAt: now() - 5000
  }
  await repo.insert('outbox', Object.assign({}, directBase, {
    id: 'M_CHAT31_D1',
    payload: Object.assign({}, directBase.payload, { body: '你好，这个还有货吗？' }),
    createdAt: now() - 5000
  }))
  await repo.insert('outbox', {
    id: 'M_CHAT31_D2', type: 'direct.chat',
    payload: {
      uid: A.openid, channel: 'direct', from: 'me', peerUid: B.openid, peerName: '对话买家31',
      kind: 'text', threadId: LEAD_ID, body: '有的，可以聊'
    },
    status: 'pending', createdAt: now() - 4500
  })
  await repo.insert('outbox', {
    id: 'M_CHAT31_KF_IMG', type: 'kf.chat',
    payload: {
      uid: B.openid, channel: 'kf', from: 'user', body: '[图片]',
      kind: 'image', image: 'https://cdn.example.com/chat-31.png',
      targetType: 'product', targetId: PRODUCT_ID, targetTitle: '对话测试商品31'
    },
    status: 'pending', readByUser: true, readByStaff: false, createdAt: now() - 3000
  })
  await repo.insert('outbox', {
    id: 'M_CHAT31_KF_CARD', type: 'kf.chat',
    payload: {
      uid: B.openid, channel: 'kf', from: 'staff', staffName: '客服小助手',
      body: '[名片] 平台客服', kind: 'card', card: { name: '客服名片', subject: '平台', uid: '' }
    },
    status: 'pending', readByUser: false, readByStaff: true, createdAt: now() - 1000
  })
  /* 老客服消息：没有商品定向字段，但发送人是该商品已有线索用户，也应并入 */
  await repo.insert('outbox', {
    id: 'M_CHAT31_KF_OLD', type: 'kf.chat',
    payload: { uid: B.openid, channel: 'kf', from: 'user', body: '更早的客服咨询', kind: 'text' },
    status: 'pending', readByUser: true, readByStaff: true, createdAt: now() - 2000
  })

  const chats = await call(adminRouter, 'product.chats', { id: PRODUCT_ID }, { token: adminToken })
  ok(chats.ok, '商品对话接口可读取', chats.message)
  const chatThreads = (chats.data && chats.data.threads) || []
  const directThread = chatThreads.find((t) => t.channel === 'direct')
  const kfThreadB = chatThreads.find((t) => t.channel === 'kf' && t.uid === B.openid)
  ok(!!directThread && directThread.threadId === LEAD_ID, '商品对话返回直聊会话且 threadId=线索 id')
  ok(!!kfThreadB && kfThreadB.threadId === `kf:product:${PRODUCT_ID}:${B.openid}`,
    '客服会话按用户拆分为独立 threadId')
  ok(!!kfThreadB && kfThreadB.messages.some((m) => m.body === '更早的客服咨询'),
    '商品下已有直聊线索用户的历史客服留言同样可见')
  const allChatMsgs = chatThreads.reduce((acc, t) => acc.concat(t.messages || []), [])
  ok(allChatMsgs.some((m) => m.kind === 'image' && /chat-31\.png/.test(m.image)), '对话消息包含图片类型')
  ok(allChatMsgs.some((m) => m.kind === 'card' && m.card && m.card.name === '客服名片'), '对话消息包含名片类型')
  ok(allChatMsgs.some((m) => m.fromStaff === true && m.fromName === '客服小助手'), '客服消息带 fromName / fromStaff')
  ok(allChatMsgs.some((m) => m.fromStaff === false && m.fromName === '对话买家31'), '用户消息带昵称 fromName')
  ok(chatThreads.every((t, i) => i === 0 || chatThreads[i - 1].lastAt >= t.lastAt), '会话按 lastAt 倒序')
  ok(kfThreadB && kfThreadB.messages.every((m, i) => i === 0 || kfThreadB.messages[i - 1].at <= m.at),
    '会话内消息按 at 正序')

  const todos = await call(adminRouter, 'admin.todos', {}, { token: adminToken })
  const TODO_KEYS = ['leads', 'agency', 'unread', 'reports', 'risk', 'payments',
    'withdrawPending', 'withdrawPayout', 'withdrawFailed', 'withdrawTimeout', 'total']
  ok(todos.ok && TODO_KEYS.every((k) => typeof todos.data[k] === 'number'),
    'admin.todos 返回 11 个数字键（含推广提现待办）', todos.message)
  ok(todos.ok && todos.data.total === todos.data.leads + todos.data.agency + todos.data.contracts +
    todos.data.unread + todos.data.reports + todos.data.risk +
    todos.data.withdrawPending + todos.data.withdrawPayout + todos.data.withdrawFailed,
  'admin.todos.total 口径包含提现待审核 / 待打款 / 打款失败')

  const workbench = await call(adminRouter, 'workbench.data', { period: '7d' }, { token: adminToken })
  ok(workbench.ok && workbench.data.role === 'admin', 'workbench.data 返回当前角色', workbench.message)
  ok(workbench.ok && Array.isArray(workbench.data.accounts)
    && workbench.data.accounts.some((row) => row.username === 'admin'), 'workbench.data 账号列表含当前登录账号')
  ok(workbench.ok && workbench.data.todos && TODO_KEYS.every((k) => typeof workbench.data.todos[k] === 'number'),
    'workbench.data.todos 含 11 个待办键（含推广提现）')
  ok(workbench.ok && workbench.data.mine && workbench.data.mine.username === 'admin', 'workbench.data.mine 为当前账号')

  const exported = await call(adminRouter, 'user.export', {}, { token: adminToken })
  ok(exported.ok && /\.xlsx$/.test(exported.data.filename), '用户导出返回 xlsx 文件名', exported.message)
  const xlsxBuf = exported.ok ? Buffer.from(exported.data.base64, 'base64') : Buffer.alloc(0)
  ok(xlsxBuf.length > 1000 && xlsxBuf.slice(0, 2).toString() === 'PK', 'xlsx base64 解码后是 ZIP 且长度足够')
  ok(exported.ok && exported.data.total > 0, '用户导出 total 大于 0')
  const zlib = require('zlib')
  const sheetOf = (buf) => {
    let offset = 0
    while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
      const method = buf.readUInt16LE(offset + 8)
      const compSize = buf.readUInt32LE(offset + 18)
      const nameLen = buf.readUInt16LE(offset + 26)
      const extraLen = buf.readUInt16LE(offset + 28)
      const name = buf.slice(offset + 30, offset + 30 + nameLen).toString('utf8')
      const dataStart = offset + 30 + nameLen + extraLen
      if (/sheet1\.xml$/.test(name)) {
        const raw = buf.slice(dataStart, dataStart + compSize)
        return (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8')
      }
      offset = dataStart + compSize
    }
    return ''
  }
  const sheetXml = sheetOf(xlsxBuf)
  ok(sheetXml.indexOf('手机号') >= 0 && sheetXml.indexOf('会员到期') >= 0,
    'xlsx 内容包含「手机号」「会员到期」表头')

  /* 管理端先勾选数据项再导出：只输出勾选的列 */
  const pickedExport = await call(adminRouter, 'user.export', { fields: ['nick', 'phone'] }, { token: adminToken })
  const pickedXml = pickedExport.ok ? sheetOf(Buffer.from(pickedExport.data.base64, 'base64')) : ''
  ok(pickedExport.ok && pickedXml.indexOf('昵称') >= 0 && pickedXml.indexOf('手机号') >= 0
    && pickedXml.indexOf('会员到期') < 0, '用户导出只包含勾选的数据项', pickedExport.message)
  const noField = await call(adminRouter, 'user.export', { fields: ['not-exist'] }, { token: adminToken })
  ok(noField.ok === false && noField.code === 'VALIDATION', '未勾选有效数据项时拒绝导出', noField.message)

  const BIZ = { openid: 'o_biz_open_31', ip: '10.31.0.9' }
  await call(userRouter, 'auth.login', { nick: '商机埋点31' }, BIZ)
  const bizList = await call(userRouter, 'biz.list', {}, BIZ)
  const bizEvents = await repo.find('userEvents', { uid: BIZ.openid, kind: 'biz_open' }, { limit: 10 })
  ok(bizList.ok && bizEvents.length >= 1, '打开商机会员页落库 biz_open 事件')

  /* 用户详情「历史发布」跳转依赖按 ID 取详情 */
  const pDetail = await call(adminRouter, 'product.detail', { id: PRODUCT_ID }, { token: adminToken })
  ok(pDetail.ok && pDetail.data.product && pDetail.data.product.id === PRODUCT_ID,
    '商品详情可读取（历史发布跳转）', pDetail.message)
  await repo.insert('demands', {
    id: 'DM_CHAT_31', title: '对话测试需求31', ownerId: A.openid, deleted: false, createdAt: now()
  })
  const dDetail = await call(adminRouter, 'demand.detail', { id: 'DM_CHAT_31' }, { token: adminToken })
  ok(dDetail.ok && dDetail.data.demand && dDetail.data.demand.id === 'DM_CHAT_31',
    '需求详情可读取（历史发布跳转）', dDetail.message)
}

/* ============================================================
   32. 退款自动回滚与 iOS 退款问询
   ============================================================ */
section('32. 退款自动回滚与 iOS 退款问询')
{
  const { createMarketAdminHandlers } = require(path.join(shared, 'market.js'))
  /* 退款推送与 iOS 问询是服务端内部动作，不经 router / RBAC，直接调用 handler */
  const marketAdmin = createMarketAdminHandlers({ repo, keys, now })
  const internalCtx = { accountId: '', session: { role: 'admin' } }

  const R1 = { openid: 'o_refund_0001', ip: '10.50.0.1' }
  const R2 = { openid: 'o_refund_0002', ip: '10.50.0.2' }
  const R3 = { openid: 'o_refund_0003', ip: '10.50.0.3' }
  await call(userRouter, 'auth.login', { nick: '退款测试1' }, R1)
  await call(userRouter, 'auth.login', { nick: '退款测试2' }, R2)
  await call(userRouter, 'auth.login', { nick: '退款测试3' }, R3)

  const NO1 = 'XP_REFUND_V1'
  const NO2 = 'XP_REFUND_V2'
  const NO3 = 'XP_REFUND_V3'
  /* 同一用户（R1）的第二笔会员单：用于验证 90 天内第 2 次退款触发风控 */
  const NO4 = 'XP_REFUND_V4'
  const g1 = await call(adminRouter, 'biz.grant', {
    uid: R1.openid, plan: 'month', amount: 99, method: '微信支付', paymentId: NO1, channel: 'apple'
  }, { token: adminToken })
  ok(g1.ok, '会员开通成功（iOS 渠道）', g1.message)
  const pay1 = (await repo.find('payments', { paymentId: NO1 }, { limit: 1 }))[0]
  ok(!!pay1 && pay1.channel === 'apple' && pay1.status === '已确认',
    '收款单记录支付渠道 channel=apple')
  await call(adminRouter, 'biz.grant', {
    uid: R2.openid, plan: 'month', amount: 99, method: '微信支付', paymentId: NO2, channel: 'apple'
  }, { token: adminToken })
  await call(adminRouter, 'biz.grant', {
    uid: R3.openid, plan: 'month', amount: 99, method: '微信支付', paymentId: NO3, channel: 'apple'
  }, { token: adminToken })
  await call(adminRouter, 'biz.grant', {
    uid: R1.openid, plan: 'month', amount: 99, method: '微信支付', paymentId: NO4, channel: 'apple'
  }, { token: adminToken })
  const appleFinance = await call(adminRouter, 'finance.summary', {}, { token: adminToken })
  const appleRow = ((appleFinance.ok && appleFinance.data.byChannel) || []).find((row) => row.key === 'apple')
  ok(appleFinance.ok && !!appleRow && appleRow.amount === 396 && appleRow.count === 4 &&
    appleFinance.data.totals.appleRevenue === 396,
    'Apple 内购营收单独出表：4 笔共 396 元，与微信支付分列',
    JSON.stringify(appleFinance.ok ? appleFinance.data.byChannel : appleFinance))

  const todaySec = Math.floor(now() / 1000)
  const nowQuery = await marketAdmin['biz.iosRefundQuery']({
    outTradeNo: NO1, provideStatus: '1', orderTime: String(todaySec)
  }, internalCtx)
  ok(nowQuery.resultCode === 0 && /未领取/.test(nowQuery.evidence),
    'iOS 问询：7 天内且未领取商机 → 建议退款', JSON.stringify(nowQuery))

  const undelivered = await marketAdmin['biz.iosRefundQuery']({
    outTradeNo: NO1, provideStatus: '0', orderTime: String(todaySec)
  }, internalCtx)
  ok(undelivered.resultCode === 0 && /未发货/.test(undelivered.evidence),
    'iOS 问询：未发货 → 建议退款', JSON.stringify(undelivered))

  await repo.insert('bizClaims', {
    id: 'BC_REFUND_1', uid: R1.openid, targetType: 'demand', targetId: 'DM_REFUND_1', at: now()
  })
  const claimedQuery = await marketAdmin['biz.iosRefundQuery']({
    outTradeNo: NO1, provideStatus: '1', orderTime: String(todaySec)
  }, internalCtx)
  ok(claimedQuery.resultCode === 1 && claimedQuery.claimed === 1 && /已领取 1 条商机/.test(claimedQuery.evidence),
    'iOS 问询：已领取商机 → 拒绝退款并附使用凭据', JSON.stringify(claimedQuery))

  const oldQuery = await marketAdmin['biz.iosRefundQuery']({
    outTradeNo: NO2, provideStatus: '2', orderTime: String(Math.floor((now() - 8 * 86400e3) / 1000))
  }, internalCtx)
  ok(oldQuery.resultCode === 1 && /超过 7 天/.test(oldQuery.evidence),
    'iOS 问询：超过 7 天且未领商机 → 拒绝退款', JSON.stringify(oldQuery))

  const unknownQuery = await marketAdmin['biz.iosRefundQuery']({
    outTradeNo: 'XP_NOT_EXIST', provideStatus: '1', orderTime: String(todaySec)
  }, internalCtx)
  ok(unknownQuery.resultCode === 0, 'iOS 问询：查不到开通记录 → 建议退款')

  const refund1 = await marketAdmin['payment.systemRefund']({
    outTradeNo: NO1, success: true
  }, internalCtx)
  const pay1After = await repo.get('payments', pay1.id)
  const access1 = await repo.get('bizAccess', R1.openid)
  const user1 = await repo.get('users', R1.openid)
  ok(refund1.found === true && refund1.refunded === true, '退款推送：定位到收款单并完成回滚')
  ok(pay1After.status === '已退款' && pay1After.refundSource === 'Apple 退款',
    '退款推送：收款单置已退款且记录来源')
  ok(access1.status === '已停用' && access1.expireAt === now(),
    '退款推送：会员权限立即停用且剩余天数不补')
  ok(user1.refundCount === 1 && !user1.riskFlag, '首次退款：风控计数为 1，未标记风险')

  const refund2 = await marketAdmin['payment.systemRefund']({
    outTradeNo: NO4, success: true
  }, internalCtx)
  const user1After = await repo.get('users', R1.openid)
  ok(refund2.found === true && refund2.refunded === true, '第二次退款推送：回滚成功')
  ok(user1After.refundCount === 2 && user1After.riskFlag === true && !!user1After.riskSince,
    '90 天内第 2 次退款：标记风险账号')

  const dupRefund = await marketAdmin['payment.systemRefund']({ outTradeNo: NO1, success: true }, internalCtx)
  const user1Dup = await repo.get('users', R1.openid)
  ok(dupRefund.refunded === true && user1Dup.refundCount === 2,
    '重复推送同一退款：幂等，不重复累计风控次数')

  const refundedQuery = await marketAdmin['biz.iosRefundQuery']({
    outTradeNo: NO1, provideStatus: '1', orderTime: String(todaySec)
  }, internalCtx)
  ok(refundedQuery.resultCode === 0 && /已退款/.test(refundedQuery.evidence),
    'iOS 问询：订单已退款 → 同意退款（无重复扣费风险）')

  const notFound = await marketAdmin['payment.systemRefund']({ outTradeNo: 'XP_NOT_EXIST' }, internalCtx)
  ok(notFound.found === false && notFound.refunded === false,
    '未知单号：返回 found=false，避免微信无限重推')

  const failed = await marketAdmin['payment.systemRefund']({ outTradeNo: NO3, success: false }, internalCtx)
  const pay3After = (await repo.find('payments', { paymentId: NO3 }, { limit: 1 }))[0]
  const access3 = await repo.get('bizAccess', R3.openid)
  ok(failed.found === true && failed.refunded === false && pay3After.status === '已确认' &&
    access3.status === '已开通', '退款失败通知：不回滚收款单与会员权限')

  /* appendAudit 不阻塞业务，等一个事件循环再断言审计落库 */
  await new Promise((resolve) => setTimeout(resolve, 0))
  const refundAudits = await repo.find('audit', { action: 'payment.refund' })
  const queryAudits = await repo.find('audit', { action: 'payment.iosRefundQuery' })
  ok(refundAudits.some((item) => item.target === pay1.id) && queryAudits.length >= 3,
    '退款与 iOS 问询均写入审计', `refund=${refundAudits.length} query=${queryAudits.length}`)
}

/* ============================================================
   37. 推广分佣与人工分账（v5.1 人工分账交付版）
   ============================================================ */
section('37. 推广分佣与人工分账')
{
  const promoLogin = (ctx, nick, ref) => {
    const body = { nick }
    if (ref) {
      body.ref = ref
      body.refScene = 'share'
    }
    return call(userRouter, 'auth.login', body, ctx)
  }
  /* 推广提现统一使用的测试银行卡 */
  const TEST_BANK = { bankHolder: '测试持卡人', bankName: '中国工商银行杭州分行', bankAccount: '6222021234567890123' }
  const promoOpen = async (ctx, nick) => {
    await promoLogin(ctx, nick)
    const ag = await call(userRouter, 'promote.agreement', {}, ctx)
    const res = await call(userRouter, 'promote.open', Object.assign({
      agreed: true, agreementVersion: ag.data.version
    }, TEST_BANK), ctx)
    return { ag, res }
  }
  const promoGrant = (buyerUid, paymentId, amount) => call(adminRouter, 'biz.grant', {
    uid: buyerUid,
    plan: 'month',
    amount,
    method: '微信支付',
    paymentId,
    channel: 'wxpay',
    transactionId: 'TX' + paymentId
  }, { token: adminToken })
  const commissionOf = async (paymentId) =>
    (await repo.find('commissions', { paymentId }, { limit: 1 }))[0]
  const loginAdmin = async (key) => {
    const acc = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === key)
    const r = await call(adminRouter, 'admin.login', {
      username: acc.username, password: acc.password, otp: generateTotp(acc.totpSecret, now())
    }, {})
    return r.ok ? r.data.token : ''
  }

  const P1 = { openid: 'o_promo_p1' }
  const B1 = { openid: 'o_buyer_p1' }
  const P2 = { openid: 'o_promo_p2' }
  const B2 = { openid: 'o_buyer_p2' }
  const P3 = { openid: 'o_promo_p3' }
  const B3 = { openid: 'o_buyer_p3' }
  const P4 = { openid: 'o_promo_p4' }
  const B4A = { openid: 'o_buyer_p4a' }
  const B4B = { openid: 'o_buyer_p4b' }
  const P5 = { openid: 'o_promo_p5' }
  const B5 = { openid: 'o_buyer_p5' }
  const B6 = { openid: 'o_buyer_p6' }
  const P6 = { openid: 'o_promo_p6' }
  const B7 = { openid: 'o_buyer_p7' }

  let financeToken = await loginAdmin('finance')
  ok(!!financeToken, '财务账号可登录（人工审核 / 执行分离用）')

  /* ---- 开通推广：协议、统一比例、推广码 ---- */
  await promoLogin(P1, '推广者一')
  const agBad = await call(userRouter, 'promote.open', {
    agreed: true, agreementVersion: '2000-01-01'
  }, P1)
  ok(!agBad.ok && agBad.code === 'VALIDATION', '协议版本不匹配时不能开通推广')
  const noAgree = await call(userRouter, 'promote.open', { agreed: false }, P1)
  ok(!noAgree.ok && noAgree.code === 'VALIDATION', '未勾选协议不能开通推广')
  const p1 = await promoOpen(P1, '推广者一')
  ok(p1.res.ok && p1.res.data.active === true && /^R[A-Z0-9]{7}$/.test(p1.res.data.refCode || ''),
    '开通推广成功并生成推广码')
  ok(p1.res.data.rate === 0.15 && p1.res.data.level2Rate === 0.15 &&
    p1.res.data.rateEditable === false && p1.res.data.feeRate === 0.05,
    '一级 / 二级佣金均 15%（只读），提现手续费 5%')
  ok(p1.res.data.bank && p1.res.data.bank.bankReady === true &&
    p1.res.data.bank.bankAccountMasked === '**** **** **** 0123' && !p1.res.data.bank.bankAccount,
  '开通时可登记收款银行卡，接口只回显脱敏卡号')

  /* ---- 银行卡选填：未填可开通，但提现前必须补全 ---- */
  const P7 = { openid: 'o_promo_p7' }
  await promoLogin(P7, '推广者七')
  const agP7 = await call(userRouter, 'promote.agreement', {}, P7)
  const p7Open = await call(userRouter, 'promote.open', {
    agreed: true, agreementVersion: agP7.data.version
  }, P7)
  ok(p7Open.ok && p7Open.data.active === true && p7Open.data.bank.bankReady === false,
    '银行卡选填：不填也可先开通推广')
  const p7Wd = await call(userRouter, 'promote.withdraw', {
    amount: 100, requestId: 'WQ_P7_NOBANK'
  }, P7)
  ok(!p7Wd.ok && p7Wd.code === 'VALIDATION', '未填写收款银行卡不能申请提现')
  const p7BadBank = await call(userRouter, 'promote.saveBank', {
    bankHolder: '推广者七', bankName: '中国银行', bankAccount: '123'
  }, P7)
  ok(!p7BadBank.ok && p7BadBank.code === 'VALIDATION', '银行卡号需为 12–19 位数字')
  const p7Bank = await call(userRouter, 'promote.saveBank', TEST_BANK, P7)
  ok(p7Bank.ok && p7Bank.data.bank.bankReady === true &&
    p7Bank.data.bank.bankAccountMasked === '**** **** **** 0123',
  '开通后可补填收款银行卡，仅回显脱敏卡号')
  /* P7 只用于验证「银行卡选填 + 事后补填」，用例结束置回未开通，避免影响后续推广者列表计数 */
  await repo.updateWhere('users', { id: P7.openid }, { promoterStatus: 'none' })
  const refCode = p1.res.data.refCode
  const p1Login = await call(userRouter, 'auth.login', {}, P1)
  ok(p1Login.ok && p1Login.data.promoter && p1Login.data.promoter.active === true &&
    p1Login.data.promoter.refCode === refCode,
  '登录态下发自己的推广码（任意页面分享 / 海报据此带上 ref，别人打开即绑定）')
  const bLoginNoPromoter = await call(userRouter, 'auth.login', {}, B1)
  ok(bLoginNoPromoter.ok && bLoginNoPromoter.data.promoter && bLoginNoPromoter.data.promoter.active === true &&
    !!bLoginNoPromoter.data.promoter.refCode,
  '未开通推广的账号也下发推广码：普通用户分享任意页面同样能绑定下级（是否计佣仍由开通状态决定）')

  const selfBind = await promoLogin(P1, '推广者一', refCode)
  const selfBindRow = await repo.get('referralBindings', P1.openid)
  ok(selfBind.ok && !selfBindRow, '推广者用自己推广码登录不会自绑')

  /* ---- 绑定：首次登录即绑定，不支持改绑 ---- */
  const b1Login = await promoLogin(B1, '买家一', refCode)
  const bind1 = await repo.get('referralBindings', B1.openid)
  ok(b1Login.ok && bind1 && bind1.refUid === P1.openid, '买家带推广码登录自动绑定推广人')
  const rebind = await call(userRouter, 'promote.bind', { ref: 'RZZZZZZZ' }, B1)
  ok(rebind.ok && rebind.data.bound === false && rebind.data.reason === 'already',
    '已绑定用户不可改绑')

  /* 登录回执：客户端据此决定推广码要不要保留重试（终态即消费掉，临时失败保留） */
  const receipt = await call(userRouter, 'auth.login', { nick: '回执买家', ref: refCode, refScene: 'share' },
    { openid: 'o_buyer_receipt1' })
  ok(receipt.ok && receipt.data.promoterBind && receipt.data.promoterBind.bound === true &&
    receipt.data.promoterBind.reason === '',
  '首次带码登录回执 bound=true')
  const receiptAgain = await call(userRouter, 'auth.login', { nick: '回执买家', ref: refCode },
    { openid: 'o_buyer_receipt1' })
  ok(receiptAgain.ok && receiptAgain.data.promoterBind &&
    receiptAgain.data.promoterBind.reason === 'already',
  '已绑定账号再次带码登录回执 already（终态，客户端不再重试）')
  const receiptBad = await call(userRouter, 'auth.login', { nick: '回执买家二', ref: 'R_BAD_CODE_TOO_LONG_1234' },
    { openid: 'o_buyer_receipt2' })
  ok(receiptBad.ok && receiptBad.data.promoterBind &&
    receiptBad.data.promoterBind.reason === 'invalid-ref',
  '推广码格式非法回执 invalid-ref（终态，避免反复重试）')

  /* ---- 资金口径：默认不开分账，订单资金不冻结，只有佣金在台账预留 ---- */
  const cfgDefault = await call(adminRouter, 'promote.settings', {}, { token: adminToken })
  ok(cfgDefault.ok && cfgDefault.data.splitEnabled === false,
    '默认关闭分账：订单资金正常结算可随时取用，只有佣金在台账预留')
  /* 本场景显式开启分账，用于覆盖路径 A（分账出款 / 分账回退）链路 */
  const splitOn = await call(adminRouter, 'promote.saveSettings', { splitEnabled: true }, { token: adminToken })
  ok(splitOn.ok && splitOn.data.splitEnabled === true, '开启路径 A 分账以覆盖分账出款链路')

  /* ---- 实时计佣：999 元 → 通道费 9.99 / 佣金 148.35 / 净额 140.93 ---- */
  const pay1 = await promoGrant(B1.openid, 'PROMO_PAY_001', 999)
  const c1 = await commissionOf('PROMO_PAY_001')
  ok(pay1.ok && c1 && c1.uid === P1.openid && c1.buyerUid === B1.openid,
    '支付成功实时计佣且佣金落在推广者（不是付款人）')
  ok(c1.channelCost === 9.99 && c1.base === 989.01 && c1.amount === 148.35 && c1.netAmount === 140.93,
    '计佣公式：通道费 9.99 / 基数 989.01 / 佣金 148.35 / 净额 140.93')
  ok(c1.status === '待结算' && c1.eligibleAt === Date.parse('2026-04-14T16:00:00Z'),
    '佣金冻结至支付月次月 15 日 00:00（北京时间）')
  const s1Pending = await call(userRouter, 'promote.summary', {}, P1)
  ok(s1Pending.data.totals.pending === 148.35 && s1Pending.data.totals.available === 0,
    '冻结期内佣金显示待结算、可提现为 0')
  const early = await call(userRouter, 'promote.withdraw', {
    amount: 148.35, requestId: 'WQ_EARLY'
  }, P1)
  ok(!early.ok && early.code === 'VALIDATION', '冻结期内无法申请提现')

  /* 未绑定推广人的支付不计佣 */
  await promoLogin(B6, '未绑定买家')
  await promoGrant(B6.openid, 'PROMO_PAY_UNBOUND', 999)
  ok(!(await commissionOf('PROMO_PAY_UNBOUND')), '未绑定推广人的支付不计佣')

  /* 乱序确认：先落一条「付款时间更晚」的已确认收款，再确认首笔真实付款。
     首笔判断只认不晚于本笔的收款，更晚的付款不能把首笔佣金挡掉。
     用独立推广人 P9，用例结束清理，避免污染后面 P1 的结算断言 */
  const P9 = { openid: 'o_promo_p9' }
  const p9 = await promoOpen(P9, '推广者九')
  const BLATE = { openid: 'o_buyer_late1' }
  await promoLogin(BLATE, '乱序确认买家', p9.res.data.refCode)
  await repo.insert('payments', {
    id: 'PAY_LATE_0001',
    uid: BLATE.openid,
    bizType: '会员续费',
    status: '已确认',
    amount: 999,
    received: 999,
    paidAt: CLOCK + 3 * 24 * 60 * 60 * 1000
  })
  await promoGrant(BLATE.openid, 'PROMO_PAY_LATE_001', 999)
  const cLate = await commissionOf('PROMO_PAY_LATE_001')
  ok(!!cLate && cLate.uid === P9.openid,
    '补录 / 乱序确认时按付款时间判断首笔，后付的款不会挡掉首笔佣金')
  await repo.removeWhere('commissions', { paymentId: 'PROMO_PAY_LATE_001' })
  await repo.removeWhere('payments', { id: 'PAY_LATE_0001' })
  await repo.removeWhere('payments', { paymentId: 'PROMO_PAY_LATE_001' })
  await repo.removeWhere('referralBindings', { uid: BLATE.openid })
  await repo.removeWhere('outbox', { 'payload.uid': P9.openid })
  await repo.updateWhere('users', { id: P9.openid }, { promoterStatus: 'none' })

  /* ---- 其余场景数据准备（均为 3 月支付，4 月 15 日统一结算） ---- */
  const p2 = await promoOpen(P2, '推广者二')
  await promoLogin(B2, '买家二', p2.res.data.refCode)
  await promoGrant(B2.openid, 'PROMO_PAY_002', 999)

  const p3 = await promoOpen(P3, '推广者三')
  await promoLogin(B3, '买家三', p3.res.data.refCode)
  await promoGrant(B3.openid, 'PROMO_PAY_003', 999)

  const p4 = await promoOpen(P4, '推广者四')
  await promoLogin(B4A, '买家四A', p4.res.data.refCode)
  await promoLogin(B4B, '买家四B', p4.res.data.refCode)
  await promoGrant(B4A.openid, 'PROMO_PAY_004A', 999)
  await promoGrant(B4B.openid, 'PROMO_PAY_004B', 999)

  const p5 = await promoOpen(P5, '推广者五')
  await promoLogin(B5, '买家五', p5.res.data.refCode)
  await promoGrant(B5.openid, 'PROMO_PAY_005', 40000)
  const c5 = await commissionOf('PROMO_PAY_005')
  ok(c5 && c5.amount === 5940 && c5.netAmount === 5643, '大额订单计佣：佣金 5940 / 净额 5643')

  /* ---- 次月 15 日后自动结算 ---- */
  CLOCK = Date.parse('2026-04-15T00:00:00Z')
  adminToken = await loginAdmin('admin')
  financeToken = await loginAdmin('finance')
  const settle = await call(adminRouter, 'promote.runSettle', {}, { token: adminToken })
  ok(settle.ok, '日终结算任务执行成功')
  const c1After = await repo.get('commissions', c1.id)
  ok(c1After.status === '可提现', '次月 15 日后佣金自动转为可提现')
  const s1Ready = await call(userRouter, 'promote.summary', {}, P1)
  ok(s1Ready.data.totals.available === 148.35 && s1Ready.data.totals.pending === 0,
    '结算后可提现余额 148.35 元')

  /* ---- 主链路：申请 → 审核 → 领取 → 回填 → 核销 ---- */
  const w1 = await call(userRouter, 'promote.withdraw', {
    amount: 148.35, requestId: 'WQ_P1_A'
  }, P1)
  ok(w1.ok && w1.data.withdrawal.status === '待审核' &&
    w1.data.withdrawal.fee === 7.42 && w1.data.withdrawal.net === 140.93,
    '提现申请：手续费 7.42、净额 140.93、进入待审核')
  const w1id = w1.data.withdrawal.id
  const w1dup = await call(userRouter, 'promote.withdraw', {
    amount: 100, requestId: 'WQ_P1_A'
  }, P1)
  ok(w1dup.ok && w1dup.data.idempotent === true && w1dup.data.withdrawal.id === w1id,
    '同一 requestId 重复提交保持幂等')
  const w1more = await call(userRouter, 'promote.withdraw', {
    amount: 100, requestId: 'WQ_P1_B'
  }, P1)
  ok(!w1more.ok && w1more.code === 'CONFLICT', '已有在途提现单时不允许再申请')
  const todoPending = await call(adminRouter, 'admin.todos', {}, { token: adminToken })
  ok(todoPending.ok && todoPending.data.withdrawPending >= 1 &&
    typeof todoPending.data.withdrawPayout === 'number' &&
    typeof todoPending.data.withdrawFailed === 'number' &&
    typeof todoPending.data.withdrawTimeout === 'number',
    '工作台待办统计到「提现待审核」，并下发待打款 / 失败 / 超时口径')

  const appr1 = await call(adminRouter, 'promote.withdrawApprove', { id: w1id }, { token: financeToken })
  ok(appr1.ok && appr1.data.status === '待打款' && appr1.data.items.length === 1 &&
    appr1.data.items[0].amount === 140.93, '审核通过生成 1 条出款明细，金额 140.93')
  const todoPayout = await call(adminRouter, 'admin.todos', {}, { token: adminToken })
  ok(todoPayout.ok && todoPayout.data.withdrawPayout >= 1 && todoPayout.data.withdrawPending === 0,
    '审核通过后从「待审核」流转到工作台「待打款」待办')
  ok(appr1.data.items[0].path === 'A' && appr1.data.items[0].type === 'manualSplit',
    '有微信交易号时走人工分账（路径 A）')
  const items1 = await call(adminRouter, 'promote.payoutItems', { withdrawalId: w1id }, { token: adminToken })
  ok(items1.ok && Array.isArray(items1.data.items) && items1.data.items.length === 1,
    '出款明细接口可按提现单查询')

  const claim1 = await call(adminRouter, 'promote.payoutClaim', { id: w1id }, { token: adminToken })
  ok(claim1.ok && claim1.data.status === '打款中', '财务领取后进入打款中')
  const noVoucher = await call(adminRouter, 'promote.payoutMark', {
    id: w1id, payoutNo: 'PN-PROMO-001', amount: 140.93
  }, { token: adminToken })
  ok(!noVoucher.ok && noVoucher.code === 'VALIDATION', '回填必须上传出款凭证')
  const badAmount = await call(adminRouter, 'promote.payoutMark', {
    id: w1id, payoutNo: 'PN-PROMO-001', amount: 180, voucherUrl: 'https://img.example/v1.png'
  }, { token: adminToken })
  ok(!badAmount.ok && badAmount.code === 'VALIDATION', '回填金额与明细合计不一致被拒')
  const mark1 = await call(adminRouter, 'promote.payoutMark', {
    id: w1id, payoutNo: 'PN-PROMO-001', amount: 140.93,
    payoutAt: now(), voucherUrl: 'https://img.example/v1.png'
  }, { token: adminToken })
  ok(mark1.ok && mark1.data.status === '已到账' && mark1.data.payoutAmount === 140.93 &&
    mark1.data.items === 1, '回填成功：提现单已到账并核销 1 条明细')
  /* 用户端提现记录闭环：状态 / 到账时间 / 打款单号 / 凭证截图 / 收款卡脱敏展示 */
  const w1UserList = await call(userRouter, 'promote.withdrawals', {}, P1)
  const w1UserRow = ((w1UserList.data && w1UserList.data.items) || [])[0]
  ok(w1UserList.ok && w1UserRow && w1UserRow.status === '已到账' && !!w1UserRow.paidText &&
    w1UserRow.payoutNo === 'PN-PROMO-001' && w1UserRow.voucherUrl === 'https://img.example/v1.png',
    '用户提现记录可见已到账状态、到账时间、打款单号与打款凭证')
  ok(w1UserRow && w1UserRow.bankHolder === TEST_BANK.bankHolder &&
    w1UserRow.bankAccountMasked === '**** **** **** 0123' &&
    w1UserRow.bankAccount === undefined,
    '用户提现记录展示收款卡持卡人与脱敏卡号，不返回完整卡号')
  const w1AdminList = await call(adminRouter, 'promote.withdrawList', { q: w1id }, { token: adminToken })
  const w1AdminRow = ((w1AdminList.data && w1AdminList.data.items) || [])[0]
  ok(w1AdminList.ok && w1AdminRow && w1AdminRow.bankAccount === TEST_BANK.bankAccount &&
    w1AdminRow.bankName === TEST_BANK.bankName && w1AdminRow.bankReady === true &&
    w1AdminRow.voucherUrl === 'https://img.example/v1.png',
    '管理端提现列表返回完整收款卡信息与打款凭证（财务据此核对打款）')
  const w1doc = await repo.get('promoterWithdrawals', w1id)
  ok(w1doc.activeKey === 'R#' + w1id && w1doc.payoutNo === 'PN-PROMO-001' &&
    w1doc.voucherUrl === 'https://img.example/v1.png', '终态改写唯一退休键并留痕单据号 / 凭证')
  const c1paid = await repo.get('commissions', c1.id)
  ok(c1paid.status === '已提现' && c1paid.withdrawnAmount === 148.35 && c1paid.payoutAmount === 140.93,
    '佣金核销：已提现、毛额 148.35、实付净额 140.93')
  const u1 = await repo.get('users', P1.openid)
  ok(u1.promoterAvailable === 0 && u1.promoterWithdrawing === 0 && u1.promoterWithdrawn === 148.35,
    '用户余额归零并累计已到账 148.35')
  const markAgain = await call(adminRouter, 'promote.payoutMark', {
    id: w1id, payoutNo: 'PN-PROMO-001', amount: 140.93, voucherUrl: 'https://img.example/v1.png'
  }, { token: adminToken })
  ok(markAgain.ok && markAgain.data.idempotent === true, '重复回填同一提现单保持幂等')
  /* I9 硬约束：在途明细占用 commissionId，终态改写唯一退休键；同一佣金第二条在途明细必须被拒 */
  const w1items = await repo.find('promotePayoutItems', { withdrawalId: w1id }, { limit: 10 })
  ok(w1items.length === 1 && w1items[0].status === 'done' &&
    w1items[0].activeCommissionKey === 'R#' + w1items[0].id,
    '已出款明细改写入唯一退休键，不再占用佣金位')
  await repo.insert('promotePayoutItems', {
    id: 'PI_DUP_GUARD_1', withdrawalId: 'W_DUP_GUARD_1', commissionId: c1.id,
    activeCommissionKey: c1.id, status: 'todo', grossPart: 0
  })
  let dupRejected = false
  try {
    await repo.insert('promotePayoutItems', {
      id: 'PI_DUP_GUARD_2', withdrawalId: 'W_DUP_GUARD_2', commissionId: c1.id,
      activeCommissionKey: c1.id, status: 'todo', grossPart: 0
    })
  } catch (err) {
    dupRejected = true
  }
  ok(dupRejected, '同一佣金第二条在途明细被唯一约束拒绝')
  await repo.removeWhere('promotePayoutItems', {
    withdrawalId: { $in: ['W_DUP_GUARD_1', 'W_DUP_GUARD_2'] }
  })
  const payoutList1 = await call(adminRouter, 'promote.payoutList', { status: '已到账' }, { token: adminToken })
  ok(payoutList1.ok && Array.isArray(payoutList1.data.items) && payoutList1.data.items.length >= 1,
    '已到账出款列表可查询')

  /* ---- 单据号唯一 → 打款失败 → 重新领取 → 重试成功 ---- */
  const w2 = await call(userRouter, 'promote.withdraw', {
    amount: 148.35, requestId: 'WQ_P2_A'
  }, P2)
  const w2id = w2.data.withdrawal.id
  await call(adminRouter, 'promote.withdrawApprove', { id: w2id }, { token: financeToken })
  await call(adminRouter, 'promote.payoutClaim', { id: w2id }, { token: adminToken })
  const dupNo = await call(adminRouter, 'promote.payoutMark', {
    id: w2id, payoutNo: 'PN-PROMO-001', amount: 140.93, voucherUrl: 'https://img.example/v2.png'
  }, { token: adminToken })
  ok(!dupNo.ok && dupNo.code === 'CONFLICT', '出款单据号全局唯一，重复使用被拒')
  const fail2 = await call(adminRouter, 'promote.payoutMark', {
    id: w2id, result: 'failed', failReason: '商户号余额不足'
  }, { token: adminToken })
  ok(fail2.ok && fail2.data.status === '打款失败', '打款失败可登记并保留原因')
  const u2fail = await repo.get('users', P2.openid)
  ok(u2fail.promoterWithdrawing === 148.35 && u2fail.promoterAvailable === 0,
    '打款失败仍占用余额，不自动退回（I3）')
  const w2blocked = await call(userRouter, 'promote.withdraw', {
    amount: 100, requestId: 'WQ_P2_B'
  }, P2)
  ok(!w2blocked.ok && w2blocked.code === 'CONFLICT', '失败单未处理前不允许再申请提现')
  const reclaim = await call(adminRouter, 'promote.payoutClaim', { id: w2id }, { token: adminToken })
  ok(reclaim.ok && reclaim.data.status === '打款中', '打款失败可重新领取出款')
  const retry2 = await call(adminRouter, 'promote.payoutMark', {
    id: w2id, payoutNo: 'PN-PROMO-002', amount: 140.93, voucherUrl: 'https://img.example/v2b.png'
  }, { token: adminToken })
  ok(retry2.ok && retry2.data.status === '已到账', '失败后重新打款成功')

  /* ---- 退回余额：释放占用、余额原路恢复 ---- */
  const w3 = await call(userRouter, 'promote.withdraw', {
    amount: 148.35, requestId: 'WQ_P3_A'
  }, P3)
  const w3id = w3.data.withdrawal.id
  await call(adminRouter, 'promote.withdrawApprove', { id: w3id }, { token: financeToken })
  const cancel3 = await call(adminRouter, 'promote.payoutCancel', {
    id: w3id, reason: '财务退回余额'
  }, { token: adminToken })
  ok(cancel3.ok && cancel3.data.status === '已撤销', '退回余额：提现单置已撤销')
  const u3 = await repo.get('users', P3.openid)
  ok(u3.promoterAvailable === 148.35 && u3.promoterWithdrawing === 0,
    '退回余额：可提现余额恢复 148.35')

  /* ---- 批量审核：逐笔独立事务，失效单不影响其他单 ---- */
  const w3b = await call(userRouter, 'promote.withdraw', {
    amount: 148.35, requestId: 'WQ_P3_B'
  }, P3)
  const w3bid = w3b.data.withdrawal.id
  const batchAppr = await call(adminRouter, 'promote.withdrawApprove', {
    ids: [w3bid, w3id], note: '中台批量审核'
  }, { token: financeToken })
  ok(batchAppr.ok && batchAppr.data.approved === 1 && batchAppr.data.failed.length === 1,
    '批量审核逐笔独立：成功 1 笔，已撤销单失败 1 笔')
  const w3bdoc = await repo.get('promoterWithdrawals', w3bid)
  ok(w3bdoc.status === '待打款', '批量审核通过后进入待打款')

  /* ---- 已冲正佣金：跳过核销并记 uncovered（文档 3.9） ---- */
  const w4 = await call(userRouter, 'promote.withdraw', {
    amount: 296.70, requestId: 'WQ_P4_A'
  }, P4)
  const w4id = w4.data.withdrawal.id
  const appr4 = await call(adminRouter, 'promote.withdrawApprove', { id: w4id }, { token: financeToken })
  ok(appr4.ok && appr4.data.items.length === 2, '跨两笔佣金生成 2 条出款明细')
  const rev4 = await call(adminRouter, 'promote.reverseCommission', {
    paymentId: 'PROMO_PAY_004A', reason: '买家退款'
  }, { token: adminToken })
  ok(rev4.ok && rev4.data.reversed === true, '未出款佣金退款后立即冲正')
  await call(adminRouter, 'promote.payoutClaim', { id: w4id }, { token: adminToken })
  const mark4 = await call(adminRouter, 'promote.payoutMark', {
    id: w4id, payoutNo: 'PN-PROMO-004', amount: 140.93, voucherUrl: 'https://img.example/v4.png'
  }, { token: adminToken })
  ok(mark4.ok && mark4.data.status === '已到账' && mark4.data.uncoveredAmount === 140.93,
    '已冲正明细跳过核销，记 uncovered=140.93')
  const w4doc = await repo.get('promoterWithdrawals', w4id)
  ok(w4doc.uncoveredAmount === 140.93, '提现单留存 uncoveredAmount 供对账告警')

  /* ---- 大额双人复核：≥5000 元复核人 ≠ 审核人 ≠ 执行人 ---- */
  const w5 = await call(userRouter, 'promote.withdraw', {
    amount: 5940, requestId: 'WQ_P5_A'
  }, P5)
  ok(w5.ok && w5.data.withdrawal.net === 5643, '大额提现：手续费 297、净额 5643')
  const w5id = w5.data.withdrawal.id
  await call(adminRouter, 'promote.withdrawApprove', { id: w5id }, { token: financeToken })
  await call(adminRouter, 'promote.payoutClaim', { id: w5id }, { token: adminToken })
  const noCheck = await call(adminRouter, 'promote.payoutMark', {
    id: w5id, payoutNo: 'PN-PROMO-005', amount: 5643, voucherUrl: 'https://img.example/v5.png'
  }, { token: adminToken })
  ok(!noCheck.ok && noCheck.code === 'VALIDATION', '≥5000 元必须填写复核人')
  const sameReviewer = await call(adminRouter, 'promote.payoutMark', {
    id: w5id, payoutNo: 'PN-PROMO-005', amount: 5643,
    voucherUrl: 'https://img.example/v5.png', checkedBy: 'finance'
  }, { token: adminToken })
  ok(!sameReviewer.ok && sameReviewer.code === 'VALIDATION', '复核人不能与审核人相同')
  const sameExecutor = await call(adminRouter, 'promote.payoutMark', {
    id: w5id, payoutNo: 'PN-PROMO-005', amount: 5643,
    voucherUrl: 'https://img.example/v5.png', checkedBy: 'admin'
  }, { token: adminToken })
  ok(!sameExecutor.ok && sameExecutor.code === 'VALIDATION', '复核人不能与执行人相同')
  const okCheck = await call(adminRouter, 'promote.payoutMark', {
    id: w5id, payoutNo: 'PN-PROMO-005', amount: 5643,
    voucherUrl: 'https://img.example/v5.png', checkedBy: 'risk_checker'
  }, { token: adminToken })
  ok(okCheck.ok && okCheck.data.status === '已到账', '双人复核通过后完成大额出款')

  /* ---- 管理端查询与对账 ---- */
  const list = await call(adminRouter, 'promote.list', {}, { token: adminToken })
  ok(list.ok && list.data.items.length === 5 && list.data.payoutMode === 'manual',
    '推广者列表 5 人，出款模式为人工')
  const stats = await call(adminRouter, 'promote.stats', {}, { token: adminToken })
  ok(stats.ok && stats.data.promoters === 5 && stats.data.paidCount === 4,
    '推广统计：推广者 5 人、已到账 4 笔')
  const settings = await call(adminRouter, 'promote.settings', {}, { token: adminToken })
  ok(settings.ok && settings.data.commissionRate === 0.15 && settings.data.level2Rate === 0.15 &&
    settings.data.payoutMode === 'manual' && settings.data.autoApprove === false,
    '规则设置：一级 / 二级均 15% · 人工分账 · 必须人工审核')
  const export1 = await call(adminRouter, 'promote.payoutExport', { id: w1id }, { token: adminToken })
  ok(export1.ok && export1.data.rows === 1 && export1.data.content.indexOf(w1id) > -1,
    '人工出款 CSV 导出包含提现单号')
  const rec = await call(adminRouter, 'promote.reconcile', {}, { token: adminToken })
  const fundingIssueTypes = ['user-ledger-drift', 'commission-overpaid', 'commission-over-withdrawn', 'duplicate-payout-no', 'duplicate-active-item']
  const fundingIssues = rec.ok
    ? rec.data.issues.filter((issue) => fundingIssueTypes.indexOf(issue.type) > -1)
    : [{ type: 'reconcile-failed' }]
  ok(rec.ok && fundingIssues.length === 0, '对账无资金类差异（台账 / 佣金 / 单据号 / 占用）',
    JSON.stringify(fundingIssues.slice(0, 2)))

  /* ---- 中台检索 / 状态筛选（与 console 传参保持同一口径） ---- */
  const p1row = list.data.items.find((it) => it.nick === '推广者一')
  const searchWd = await call(adminRouter, 'promote.withdrawList', { q: w1id }, { token: adminToken })
  ok(searchWd.ok && searchWd.data.total === 1 && searchWd.data.items[0].id === w1id,
    '提现单按单号检索命中')
  const searchCm = await call(adminRouter, 'promote.commissions', { q: '推广者一', limit: 5 }, { token: adminToken })
  ok(searchCm.ok && searchCm.data.items.length > 0 && searchCm.data.items.every((it) => it.uid === p1row.uid),
    '佣金明细按昵称检索命中')
  const searchPm = await call(adminRouter, 'promote.list', { q: '推广者一' }, { token: adminToken })
  ok(searchPm.ok && searchPm.data.items.length === 1 && searchPm.data.items[0].uid === p1row.uid,
    '推广者按昵称检索命中')
  /* 用户ID 口径：中台展示的 userNo（U 开头）与 uid 都能检索 */
  const p1No = userNoOf(p1row.uid)
  const searchPmNo = await call(adminRouter, 'promote.list', { q: p1No }, { token: adminToken })
  ok(searchPmNo.ok && searchPmNo.data.items.length === 1 && searchPmNo.data.items[0].uid === p1row.uid &&
    searchPmNo.data.items[0].userNo === p1No, '推广者按用户ID（userNo）检索命中')
  const searchCmNo = await call(adminRouter, 'promote.commissions', { q: p1No, limit: 5 }, { token: adminToken })
  ok(searchCmNo.ok && searchCmNo.data.items.length > 0 &&
    searchCmNo.data.items.every((it) => it.uid === p1row.uid && it.userNo === p1No && !!it.nick),
  '佣金明细按用户ID检索命中，并返回昵称 / 用户ID')
  const searchWdNo = await call(adminRouter, 'promote.withdrawList', { q: p1No }, { token: adminToken })
  ok(searchWdNo.ok && searchWdNo.data.items.length === 1 && searchWdNo.data.items[0].id === w1id &&
    searchWdNo.data.items[0].userNo === p1No, '提现单按用户ID检索命中，并返回用户ID')
  const payoutByNick = await call(adminRouter, 'promote.payoutList', { status: '已到账', q: '推广者一' }, { token: adminToken })
  ok(payoutByNick.ok && payoutByNick.data.items.length === 1 &&
    payoutByNick.data.items[0].id === w1id && payoutByNick.data.items[0].nick === '推广者一' &&
    payoutByNick.data.items[0].userNo === p1No,
  '待打款清单按收款人昵称检索命中，并返回昵称 / 用户ID（收款人不再显示 —）')
  const block = await call(adminRouter, 'promote.setStatus', {
    uid: p1row.uid, status: 'blocked', reason: 'verify'
  }, { token: adminToken })
  const blockedList = await call(adminRouter, 'promote.list', { status: '封禁' }, { token: adminToken })
  ok(block.ok && blockedList.ok && blockedList.data.items.length === 1 &&
    blockedList.data.items[0].uid === p1row.uid, '封禁推广者按状态筛选命中')
  /* 绑定只对正常状态的推广者生效：封禁期间推广码不再拉新，避免违规账号继续锁客 */
  const B8 = { openid: 'o_buyer_p8' }
  await promoLogin(B8, '封禁期买家', refCode)
  ok(!(await repo.get('referralBindings', B8.openid)), '推广者封禁期间其推广码不再绑定新用户')
  const unblock = await call(adminRouter, 'promote.setStatus', {
    uid: p1row.uid, status: 'active', reason: 'verify-restore'
  }, { token: adminToken })
  ok(unblock.ok && unblock.data.status === 'active', '推广者解封恢复 active')

  /* ---- 管理端手动开通推广：无需用户本人签署协议 ---- */
  const BM = { openid: 'o_buyer_admin_open' }
  await promoLogin(BM, '待开通用户')
  const beforeOpen = await repo.get('users', BM.openid)
  const adminOpen = await call(adminRouter, 'promote.openByAdmin', { uid: BM.openid }, { token: adminToken })
  const afterOpen = await repo.get('users', BM.openid)
  ok(beforeOpen && beforeOpen.promoterStatus !== 'active' && adminOpen.ok && adminOpen.data.opened === true &&
    afterOpen.promoterStatus === 'active' && !!afterOpen.refCode && !!afterOpen.promoterOpenedAt,
  '管理端可为未开通用户手动开通推广，并立即生成推广码')
  const openAgain = await call(adminRouter, 'promote.openByAdmin', { uid: BM.openid }, { token: adminToken })
  ok(openAgain.ok && openAgain.data.opened === false && openAgain.data.reason === 'already',
    '重复开通幂等，不会重复授权')
  const openLogin = await call(userRouter, 'auth.login', {}, BM)
  ok(openLogin.ok && openLogin.data.promoter && openLogin.data.promoter.refCode === afterOpen.refCode,
    '手动开通后登录即拿到自己的推广码，分享任意页面即可绑定')

  /* ---- 开通前的分享绑定：能绑定，但不计佣、也不计入绑定人数（文档 3.3） ---- */
  const PRE = { openid: 'o_preopen_promoter' }
  const PRE_B1 = { openid: 'o_preopen_buyer1' }
  const PRE_B2 = { openid: 'o_preopen_buyer2' }
  await promoLogin(PRE, '开通前分享者')
  const preRef = (await repo.get('users', PRE.openid)).refCode
  await promoLogin(PRE_B1, '开通前绑定买家', preRef)
  ok(!!(await repo.get('referralBindings', PRE_B1.openid)),
    '未开通推广时分享的推广码同样能绑定下级（归属先到先得）')
  await promoOpen(PRE, '开通前分享者')
  const preOpened = await repo.get('users', PRE.openid)
  /* 模拟「开通前分享带来的绑定」：绑定时间早于开通时间 */
  await repo.updateWhere('referralBindings', { id: PRE_B1.openid }, {
    boundAt: Number(preOpened.promoterOpenedAt) - 60 * 1000
  })
  await promoLogin(PRE_B2, '开通后绑定买家', preOpened.refCode)
  await promoGrant(PRE_B1.openid, 'PROMO_PAY_PREOPEN', 999)
  await promoGrant(PRE_B2.openid, 'PROMO_PAY_AFTEROPEN', 999)
  ok(!(await commissionOf('PROMO_PAY_PREOPEN')),
    '开通推广前绑定的下级，之后付款也不计佣（开通前的分享不追溯）')
  const cAfterOpen = await commissionOf('PROMO_PAY_AFTEROPEN')
  ok(cAfterOpen && cAfterOpen.uid === PRE.openid && cAfterOpen.level === 1,
    '开通推广后绑定的下级首次付款正常计佣')
  const preSummary = await call(userRouter, 'promote.summary', {}, PRE)
  ok(preSummary.ok && preSummary.data.counts.level1 === 1 && preSummary.data.counts.referrals === 1,
    '推广中心绑定人数只统计开通后的绑定（开通前绑定的 1 人不显示）')
  const preAdminList = await call(adminRouter, 'promote.list', { q: '开通前分享者' }, { token: adminToken })
  const preAdminDetail = await call(adminRouter, 'promote.detail', { uid: PRE.openid }, { token: adminToken })
  ok(preAdminList.ok && preAdminList.data.items.length === 1 && preAdminList.data.items[0].referrals === 1,
    '推广管理列表绑定人数只统计开通后的绑定')
  ok(preAdminDetail.ok && preAdminDetail.data.counts.level1 === 1 &&
    preAdminDetail.data.level1.length === 1 && preAdminDetail.data.level1[0].uid === PRE_B2.openid,
    '推广详情名单不展示开通前绑定的下级')

  /* ---- 两级推广链路：up → mid → buyer → deepBuyer ---- */
  const upPromo = await promoOpen({ openid: 'o_promo_up' }, '上级推广')
  await promoLogin({ openid: 'o_promo_mid' }, '中级推广', upPromo.res.data.refCode)
  const midPromo = await promoOpen({ openid: 'o_promo_mid' }, '中级推广')
  await promoLogin({ openid: 'o_buyer_l2' }, '二级买家', midPromo.res.data.refCode)
  const buyerPromo = await promoOpen({ openid: 'o_buyer_l2' }, '二级买家')
  await promoLogin({ openid: 'o_deep_buyer' }, '三级买家', buyerPromo.res.data.refCode)
  await promoGrant('o_promo_mid', 'PROMO_PAY_L1_001', 999)
  await promoGrant('o_deep_buyer', 'PROMO_PAY_L2_001', 999)

  const cUp = await commissionOf('PROMO_PAY_L1_001')
  const cBuyer = await commissionOf('PROMO_PAY_L2_001')
  const cMid = await commissionOf('PROMO_PAY_L2_001#L2')
  ok(cUp && cUp.uid === 'o_promo_up' && cUp.level === 1 && cUp.amount === 148.35,
    '一级佣金 15% 给直接推广人（上级推广 148.35）')
  ok(cBuyer && cBuyer.uid === 'o_buyer_l2' && cBuyer.level === 1 && cBuyer.amount === 148.35,
    '下级首次付款照常给一级推广人 15%')
  ok(!cMid, '普通推广人只有一级佣金，不产生二级佣金')

  const midSummary = await call(userRouter, 'promote.summary', {}, { openid: 'o_promo_mid' })
  ok(midSummary.ok && midSummary.data.promoteType === 'normal' && midSummary.data.level2Enabled === false &&
    midSummary.data.totals.level2Earning === 0 && midSummary.data.counts.level1 === 1 &&
    midSummary.data.counts.level2 === 0, '推广中心汇总：普通推广人只有一级，二级收入与二级人数均为 0')

  const detailUp = await call(adminRouter, 'promote.detail', { uid: 'o_promo_up' }, { token: adminToken })
  const detailMid = await call(adminRouter, 'promote.detail', { uid: 'o_promo_mid' }, { token: adminToken })
  ok(detailUp.ok && detailUp.data.counts.level1 === 1 && detailUp.data.level1[0].uid === 'o_promo_mid' &&
    detailUp.data.counts.level2 === 1 && detailUp.data.level2[0].uid === 'o_buyer_l2' &&
    detailUp.data.level2[0].parentUid === 'o_promo_mid',
    '推广详情：上级的一级名单含中级、二级名单含二级买家（带所属一级）')
  ok(detailMid.ok && detailMid.data.counts.level1 === 1 && detailMid.data.level1[0].uid === 'o_buyer_l2' &&
    detailMid.data.counts.level2 === 1 && detailMid.data.level2[0].uid === 'o_deep_buyer' &&
    detailUp.data.opened.level1Promoter === 1 && detailMid.data.opened.level1Promoter === 1,
    '同一用户可同时出现在某人的一级名单与另一人的二级名单，开通情况逐人可见')
  ok(detailUp.data.funnel && detailUp.data.funnel.level1.total === 1 && detailUp.data.funnel.level1.paid === 1 &&
    detailUp.data.funnel.level1.rate === 100 && detailUp.data.funnel.level1.paidAmount === 999 &&
    detailUp.data.level1[0].paid === true && detailUp.data.level1[0].paidAmount === 999 &&
    detailUp.data.level1[0].commission === 148.35 && detailUp.data.commissionStats.total === 148.35,
    '推广详情：一级付款人数 / 付款比例 / 累计付款 / 贡献佣金口径正确')
  ok(detailUp.data.funnel.level2.total === 1 && detailUp.data.funnel.level2.paid === 0 &&
    detailUp.data.funnel.total.paid === 1 && detailUp.data.paidRate === 50 && detailUp.data.paidUsers === 1,
    '推广详情：两级付款漏斗与整体付款比例正确')

  /* ---- 二级佣金只发给客服绑定账号：中级推广被客服绑定后，其下级的首次付款才额外计二级 ---- */
  await repo.insert('csBindings', {
    id: 'cs_verify_mid', csId: 'cs_verify_mid', csName: '客服M', uid: 'o_promo_mid',
    nick: '中级推广', boundAt: now() - 2000, updatedAt: now() - 2000
  })
  await promoLogin({ openid: 'o_deep_buyer_cs' }, '客服二级买家', buyerPromo.res.data.refCode)
  await promoGrant('o_deep_buyer_cs', 'PROMO_PAY_CS_L2', 999)
  const cCsL2 = await commissionOf('PROMO_PAY_CS_L2#L2')
  ok(cCsL2 && cCsL2.uid === 'o_promo_mid' && cCsL2.level === 2 && cCsL2.amount === 148.35,
    '客服绑定账号额外获得二级佣金（其下级的首次付款 15%）')
  const detailMidCs = await call(adminRouter, 'promote.detail', { uid: 'o_promo_mid' }, { token: adminToken })
  ok(detailMidCs.ok && detailMidCs.data.csBound === true && detailMidCs.data.commissionStats.level2Count === 1 &&
    detailMidCs.data.level2Earning === 148.35 && detailMidCs.data.funnel.level2.total === 2 &&
    detailMidCs.data.funnel.level2.paid === 2 && detailMidCs.data.funnel.level2.rate === 100,
  '客服绑定账号推广详情：二级名单 / 二级付款人数 / 二级佣金可见')

  /* ---- 客服绑定账号：未开通推广也按两级佣金计入其推广收入 ---- */
  await promoLogin({ openid: 'o_cs_bound_user' }, '客服绑定用户')
  await promoLogin({ openid: 'o_cs_buyer' }, '客服买家')
  await repo.insert('csBindings', {
    id: 'cs_verify_x', csId: 'cs_verify_x', csName: '客服X', uid: 'o_cs_bound_user',
    nick: '客服绑定用户', boundAt: now() - 1000, updatedAt: now() - 1000
  })
  await repo.insert('referralBindings', {
    id: 'o_cs_buyer', refUid: 'o_cs_bound_user', boundAt: now() - 1000
  })
  await promoGrant('o_cs_buyer', 'PROMO_PAY_CS_001', 999)
  const cCs = await commissionOf('PROMO_PAY_CS_001')
  ok(cCs && cCs.uid === 'o_cs_bound_user' && cCs.amount === 148.35,
    '客服绑定账号未开通推广也按一级计佣，计入其推广收入')
  const detailCs = await call(adminRouter, 'promote.list', { q: '客服绑定用户' }, { token: adminToken })
  ok(detailCs.ok && detailCs.data.items.length === 1 && detailCs.data.items[0].csBound === true,
    '推广管理名单可见客服绑定账号及其开通情况')
  /* 客服绑定（未开通推广）账号也要能被检索到，且佣金明细带昵称 */
  const csBoundNo = userNoOf('o_cs_bound_user')
  const detailCsNo = await call(adminRouter, 'promote.list', { q: csBoundNo }, { token: adminToken })
  ok(detailCsNo.ok && detailCsNo.data.items.length === 1 &&
    detailCsNo.data.items[0].uid === 'o_cs_bound_user' && detailCsNo.data.items[0].userNo === csBoundNo,
  '客服绑定（未开通）账号按用户ID检索命中')
  const csComm = await call(adminRouter, 'promote.commissions', { q: '客服绑定用户' }, { token: adminToken })
  ok(csComm.ok && csComm.data.total === 1 && csComm.data.items[0].uid === 'o_cs_bound_user' &&
    csComm.data.items[0].nick === '客服绑定用户',
  '客服绑定（未开通）账号的佣金可按昵称检索命中（不再漏出活跃推广者名单）')

  /* ============================================================
     37.1 退款闭环回归（3.9 / 8.7 / 8.8）
     ============================================================ */
  /* 2000 元订单 → 通道费 20 / 基数 1980 / 佣金 297 / 净额 282.15 */
  const op6 = await promoOpen({ openid: 'o_promo_r6' }, '退款推广六')
  const b6a = { openid: 'o_buyer_r6a' }
  const b6b = { openid: 'o_buyer_r6b' }
  await promoLogin(b6a, '退款买家六A', op6.res.data.refCode)
  await promoLogin(b6b, '退款买家六B', op6.res.data.refCode)
  await promoGrant(b6a.openid, 'PROMO_PAY_006A', 2000)
  await promoGrant(b6b.openid, 'PROMO_PAY_006B', 2000)

  const op7 = await promoOpen({ openid: 'o_promo_r7' }, '退款推广七')
  const b7a = { openid: 'o_buyer_r7a' }
  const b7b = { openid: 'o_buyer_r7b' }
  await promoLogin(b7a, '退款买家七A', op7.res.data.refCode)
  await promoLogin(b7b, '退款买家七B', op7.res.data.refCode)
  await promoGrant(b7a.openid, 'PROMO_PAY_007A', 2000)
  await promoGrant(b7b.openid, 'PROMO_PAY_007B', 2000)

  const op8 = await promoOpen({ openid: 'o_promo_r8' }, '退款推广八')
  const b8a = { openid: 'o_buyer_r8a' }
  const b8b = { openid: 'o_buyer_r8b' }
  await promoLogin(b8a, '退款买家八A', op8.res.data.refCode)
  await promoLogin(b8b, '退款买家八B', op8.res.data.refCode)
  await promoGrant(b8a.openid, 'PROMO_PAY_008A', 2000)
  await promoGrant(b8b.openid, 'PROMO_PAY_008B', 2000)

  const op10 = await promoOpen({ openid: 'o_promo_r10' }, '退款推广十')
  const b10 = { openid: 'o_buyer_r10' }
  await promoLogin(b10, '退款买家十', op10.res.data.refCode)
  await promoGrant(b10.openid, 'PROMO_PAY_010', 2000)
  /* 路径 B：不可分账（模拟虚拟支付 / 超期），出款只能走商家转账 */
  const c10row = await commissionOf('PROMO_PAY_010')
  await repo.updateWhere('commissions', { id: c10row.id }, {
    splitBlocked: true, splitBlockedReason: 'verify-path-B'
  })

  CLOCK = Date.parse('2026-05-15T00:00:00Z')
  adminToken = await loginAdmin('admin')
  financeToken = await loginAdmin('finance')
  const settle2 = await call(adminRouter, 'promote.runSettle', {}, { token: adminToken })
  ok(settle2.ok, '退款闭环回归：5 月 15 日结算完成')

  /* ---- 场景一：佣金仍在「待审核」时退款 ---- */
  const s6 = await call(userRouter, 'promote.summary', {}, { openid: 'o_promo_r6' })
  ok(s6.data.totals.available === 594, '待审核退款用例：两笔佣金结算后可提现 594')
  const w6 = await call(userRouter, 'promote.withdraw', {
    amount: 300, requestId: 'WQ_R6'
  }, { openid: 'o_promo_r6' })
  const w6id = w6.data.withdrawal.id
  const rev6 = await call(adminRouter, 'promote.reverseCommission', {
    paymentId: 'PROMO_PAY_006A', reason: '买家退款（待审核期间）'
  }, { token: adminToken })
  const w6doc = await repo.get('promoterWithdrawals', w6id)
  const u6 = await repo.get('users', 'o_promo_r6')
  ok(rev6.ok && rev6.data.reversed === true, '待审核期间退款：佣金直接冲正')
  ok(w6doc.status === '已撤销' && /退款冲正自动撤销/.test(w6doc.cancelReason || ''),
    '待审核提现单被自动撤销并留痕原因')
  ok(u6.promoterAvailable === 297 && u6.promoterWithdrawing === 0,
    '撤销后只扣被冲正佣金：另一笔 297 完好、无占用残留')

  /* ---- 场景二：佣金在「待打款 / 打款中」时退款 ---- */
  const w7 = await call(userRouter, 'promote.withdraw', {
    amount: 400, requestId: 'WQ_R7'
  }, { openid: 'o_promo_r7' })
  const w7id = w7.data.withdrawal.id
  await call(adminRouter, 'promote.withdrawApprove', { id: w7id }, { token: financeToken })
  const u7a = await repo.get('users', 'o_promo_r7')
  const s7 = await call(userRouter, 'promote.summary', {}, { openid: 'o_promo_r7' })
  ok(u7a.promoterAvailable === 194 && u7a.promoterWithdrawing === 400,
    '待打款期间：占用 400，可用 194')
  ok(s7.data.totals.available === 194, '待打款期间可提现不虚高（仍为 194）')
  const rev7 = await call(adminRouter, 'promote.reverseCommission', {
    paymentId: 'PROMO_PAY_007A', reason: '买家退款（待打款期间）'
  }, { token: adminToken })
  const u7b = await repo.get('users', 'o_promo_r7')
  ok(rev7.ok && rev7.data.reversed === true, '待打款期间退款：佣金冲正照常')
  ok(u7b.promoterAvailable === 194 && u7b.promoterWithdrawing === 400,
    '冲正不重复扣减可提现（在途毛额已在提现中）')
  await call(adminRouter, 'promote.payoutClaim', { id: w7id }, { token: adminToken })
  const mark7 = await call(adminRouter, 'promote.payoutMark', {
    id: w7id, payoutNo: 'PN-PROMO-R7', amount: 97.85, voucherUrl: 'https://img.example/r7.png'
  }, { token: adminToken })
  ok(mark7.ok && mark7.data.payoutAmount === 97.85 && mark7.data.uncoveredAmount === 282.15,
    '打款跳过已冲正明细：实付 97.85、uncovered 282.15')
  const w7doc = await repo.get('promoterWithdrawals', w7id)
  ok(w7doc.uncoveredAmount === 282.15 && w7doc.status === '已到账',
    '提现单按可用明细合计闭合到账')
  const u7c = await repo.get('users', 'o_promo_r7')
  ok(u7c.promoterAvailable === 194 && u7c.promoterWithdrawing === 0,
    '到账后可用余额仍为 194（未被重复扣减）')
  ok(u7c.promoterWithdrawn === 103,
    '累计已提现只统计真实出款毛额 103，冲正失效部分不虚增')

  /* 剩余 194 继续可提现，出款后佣金累计实付 = 净额 */
  /* 同月已有一笔到账单：再次申请按「每月 1 次」拒绝 */
  const w7same = await call(userRouter, 'promote.withdraw', {
    amount: 194, requestId: 'WQ_R7B'
  }, { openid: 'o_promo_r7' })
  ok(!w7same.ok && String(w7same.message || '').includes('每月最多申请'),
    '同一自然月内提现申请最多 1 次')
  /* 提现次数按月限制：第二笔申请时把时钟挪到次月，验证剩余余额仍可正常提现 */
  const clockBeforeW7b = CLOCK
  CLOCK = Date.parse('2026-06-16T00:00:00Z')
  const w7b = await call(userRouter, 'promote.withdraw', {
    amount: 194, requestId: 'WQ_R7B'
  }, { openid: 'o_promo_r7' })
  CLOCK = clockBeforeW7b
  ok(w7b.ok && w7b.data.withdrawal.net === 184.30, '退款后剩余 194 可再次申请，净额 184.30')
  const w7bid = w7b.data.withdrawal.id
  await call(adminRouter, 'promote.withdrawApprove', { id: w7bid }, { token: financeToken })
  await call(adminRouter, 'promote.payoutClaim', { id: w7bid }, { token: adminToken })
  await call(adminRouter, 'promote.payoutMark', {
    id: w7bid, payoutNo: 'PN-PROMO-R7B', amount: 184.30, voucherUrl: 'https://img.example/r7b.png'
  }, { token: adminToken })
  const c7b = await repo.get('commissions', (await commissionOf('PROMO_PAY_007B')).id)
  ok(c7b.status === '已提现' && c7b.payoutAmount === 282.15,
    '佣金分两次出款，累计实付等于净额 282.15')
  const u7f = await repo.get('users', 'o_promo_r7')
  ok(u7f.promoterWithdrawn === 297 && u7f.promoterAvailable === 0 && u7f.promoterDebt === 0,
    '两笔出款后累计已提现 297，与剩余佣金毛额闭合')

  /* 路径 A 已出款：未回退禁止退款 → 回填回退单号 → 退款闭环 */
  const pay7bRow = (await repo.find('payments', { paymentId: 'PROMO_PAY_007B' }, { limit: 1 }))[0]
  const blockRefund7a = await call(adminRouter, 'payment.refund', {
    id: pay7bRow.id, reason: '买家申请退款'
  }, { token: adminToken })
  ok(!blockRefund7a.ok && blockRefund7a.code === 'CONFLICT', '已出款未回退：禁止退款（路径 A）')
  const rev7b = await call(adminRouter, 'promote.reverseCommission', {
    paymentId: 'PROMO_PAY_007B', reason: '已出款，等待分账回退'
  }, { token: adminToken })
  const u7d = await repo.get('users', 'o_promo_r7')
  ok(rev7b.ok && rev7b.data.reversed === false && rev7b.data.debt === 282.15,
    '分账路径未回退：不标记冲正，按净额记欠款 282.15')
  ok(u7d.promoterDebt === 282.15, '欠款 282.15 落账')
  const recDebt = await call(adminRouter, 'promote.reconcile', {}, { token: adminToken })
  const debtIssues = recDebt.ok
    ? recDebt.data.issues.filter((issue) => issue.type === 'user-ledger-drift')
    : [{ type: 'reconcile-failed' }]
  ok(recDebt.ok && debtIssues.length === 0,
    '已出款待回退期间对账不误报余额漂移', JSON.stringify(debtIssues.slice(0, 2)))
  const blockRefund7b = await call(adminRouter, 'payment.refund', {
    id: pay7bRow.id, reason: '买家申请退款'
  }, { token: adminToken })
  ok(!blockRefund7b.ok && blockRefund7b.code === 'CONFLICT', '仅记欠款仍禁止退款，需先回填回退单号')
  const backfill7 = await call(adminRouter, 'promote.reverseCommission', {
    paymentId: 'PROMO_PAY_007B', reason: '分账回退成功',
    splitRefundDone: true, splitRefundNo: 'RF-PROMO-007B'
  }, { token: adminToken })
  const c7bdoc = await commissionOf('PROMO_PAY_007B')
  const u7e = await repo.get('users', 'o_promo_r7')
  ok(backfill7.ok && backfill7.data.reversed === true && c7bdoc.status === '已冲正' &&
    c7bdoc.refundNo === 'RF-PROMO-007B', '回填回退单号后佣金冲正并留痕')
  ok(u7e.promoterDebt === 0, '回填成功后欠款清零')
  const refund7 = await call(adminRouter, 'payment.refund', {
    id: pay7bRow.id, reason: '分账回退完成后退款'
  }, { token: adminToken })
  ok(refund7.ok && refund7.data.refunded === true, '回退完成后退款成功（路径 A 闭环）')

  /* ---- 场景三：整单明细全部失效 → 退回余额不得虚增 ---- */
  const w8 = await call(userRouter, 'promote.withdraw', {
    amount: 500, requestId: 'WQ_R8'
  }, { openid: 'o_promo_r8' })
  const w8id = w8.data.withdrawal.id
  await call(adminRouter, 'promote.withdrawApprove', { id: w8id }, { token: financeToken })
  await call(adminRouter, 'promote.reverseCommission', {
    paymentId: 'PROMO_PAY_008A', reason: '买家退款'
  }, { token: adminToken })
  await call(adminRouter, 'promote.reverseCommission', {
    paymentId: 'PROMO_PAY_008B', reason: '买家退款'
  }, { token: adminToken })
  const u8a = await repo.get('users', 'o_promo_r8')
  ok(u8a.promoterAvailable === 0 && u8a.promoterWithdrawing === 500,
    '两笔佣金冲正后：未占用部分扣净、占用保留待提现单处理')
  await call(adminRouter, 'promote.payoutClaim', { id: w8id }, { token: adminToken })
  const mark8 = await call(adminRouter, 'promote.payoutMark', {
    id: w8id, payoutNo: 'PN-PROMO-R8', amount: 475, voucherUrl: 'https://img.example/r8.png'
  }, { token: adminToken })
  ok(!mark8.ok && mark8.code === 'CONFLICT', '明细全部失效时回填被拒，需退回余额')
  const cancel8 = await call(adminRouter, 'promote.payoutCancel', {
    id: w8id, reason: '佣金均已冲正'
  }, { token: adminToken })
  const u8b = await repo.get('users', 'o_promo_r8')
  ok(cancel8.ok && cancel8.data.released === 0 && u8b.promoterAvailable === 0 &&
    u8b.promoterWithdrawing === 0, '退回余额只释放未冲正毛额：不产生虚增余额')

  /* ---- 场景四：路径 B（转账）已到账 → 补录回退凭证清欠款 → 退款 ---- */
  const w10 = await call(userRouter, 'promote.withdraw', {
    amount: 297, requestId: 'WQ_R10'
  }, { openid: 'o_promo_r10' })
  const w10id = w10.data.withdrawal.id
  await call(adminRouter, 'promote.withdrawApprove', { id: w10id }, { token: financeToken })
  await call(adminRouter, 'promote.payoutClaim', { id: w10id }, { token: adminToken })
  const mark10 = await call(adminRouter, 'promote.payoutMark', {
    id: w10id, payoutNo: 'PN-PROMO-R10', amount: 282.15, voucherUrl: 'https://img.example/r10.png'
  }, { token: adminToken })
  ok(mark10.ok && mark10.data.status === '已到账', '路径 B（不可分账）按商家转账口径出款成功')
  const rev10 = await call(adminRouter, 'promote.reverseCommission', {
    paymentId: 'PROMO_PAY_010', reason: '转账已到账，无法原路回退'
  }, { token: adminToken })
  const u10a = await repo.get('users', 'o_promo_r10')
  ok(rev10.ok && rev10.data.reversed === true && u10a.promoterDebt === 282.15,
    '路径 B 冲正即置已冲正并记欠款 282.15')
  const pay10Row = (await repo.find('payments', { paymentId: 'PROMO_PAY_010' }, { limit: 1 }))[0]
  const block10 = await call(adminRouter, 'payment.refund', {
    id: pay10Row.id, reason: '买家退款'
  }, { token: adminToken })
  ok(!block10.ok && block10.code === 'CONFLICT', '未补录回退凭证前禁止退款（路径 B）')
  const back10 = await call(adminRouter, 'promote.reverseCommission', {
    paymentId: 'PROMO_PAY_010', reason: '线下追回完成', splitRefundNo: 'TRF-PROMO-010'
  }, { token: adminToken })
  const u10b = await repo.get('users', 'o_promo_r10')
  ok(back10.ok && back10.data.reason === 'backfill-recorded' && u10b.promoterDebt === 0,
    '已冲正后补录回退单号：清欠款且不重复改余额')
  const refund10 = await call(adminRouter, 'payment.refund', {
    id: pay10Row.id, reason: '已线下追回'
  }, { token: adminToken })
  ok(refund10.ok && refund10.data.refunded === true, '路径 B 补录后退款成功（闭环）')

  /* ---- 场景五前置：Apple 渠道到账冻结（不看日历，等财务确认结算到账） ---- */
  const p6 = await promoOpen(P6, '推广者六')
  await promoLogin(B7, '买家七', p6.res.data.refCode)
  await call(adminRouter, 'biz.grant', {
    uid: B7.openid, plan: 'month', amount: 999, method: '微信支付',
    paymentId: 'PROMO_PAY_007', channel: 'apple'
  }, { token: adminToken })
  const ca = await commissionOf('PROMO_PAY_007')
  ok(!!ca && ca.channel === 'apple' && ca.status === '待结算' && ca.arrivalHold === true,
    'Apple 渠道计佣后进入到账冻结（待结算，不按次月 15 日日历解冻）')
  ok(ca.channelCost === 119.88 && ca.base === 879.12 && ca.amount === 131.87 && ca.netAmount === 125.28,
    'Apple 渠道计佣口径：12% 通道成本 → 基数 879.12 / 佣金 131.87 / 净额 125.28')
  ok(ca.eligibleAt === Date.parse('2026-06-14T16:00:00Z'),
    'Apple 冻结佣金仍记录日历解冻日（6 月 15 日）作参考，到账前不生效')
  const caList = await call(userRouter, 'promote.commissions', {}, P6)
  ok(caList.ok && caList.data.items.length === 1 && caList.data.items[0].arrivalHold === true &&
    caList.data.items[0].eligibleText === '待平台确认到账',
    '推广者佣金列表对到账冻结佣金显示「待平台确认到账」')

  /* ---- 场景五：微信 / Apple 渠道退款推送（钱已退，无法拦截） ---- */
  const op11 = await promoOpen({ openid: 'o_promo_r11' }, '退款推广十一')
  const b11 = { openid: 'o_buyer_r11' }
  await promoLogin(b11, '退款买家十一', op11.res.data.refCode)
  await promoGrant(b11.openid, 'PROMO_PAY_011', 2000)
  CLOCK = Date.parse('2026-06-15T00:00:00Z')
  adminToken = await loginAdmin('admin')
  financeToken = await loginAdmin('finance')
  await call(adminRouter, 'promote.runSettle', {}, { token: adminToken })
  const w11 = await call(userRouter, 'promote.withdraw', {
    amount: 297, requestId: 'WQ_R11'
  }, { openid: 'o_promo_r11' })
  const w11id = w11.data.withdrawal.id
  await call(adminRouter, 'promote.withdrawApprove', { id: w11id }, { token: financeToken })
  await call(adminRouter, 'promote.payoutClaim', { id: w11id }, { token: adminToken })
  await call(adminRouter, 'promote.payoutMark', {
    id: w11id, payoutNo: 'PN-PROMO-R11', amount: 282.15, voucherUrl: 'https://img.example/r11.png'
  }, { token: adminToken })
  const require2 = createRequire(import.meta.url)
  const { createMarketAdminHandlers: createMarketAdmin2 } = require2(path.join(shared, 'market.js'))
  const marketAdmin2 = createMarketAdmin2({ repo, keys, now })
  const internalCtx2 = { accountId: '', session: { role: 'admin' } }
  const sysRefund11 = await marketAdmin2['payment.systemRefund']({
    outTradeNo: 'PROMO_PAY_011', success: true
  }, internalCtx2)
  const c11 = await commissionOf('PROMO_PAY_011')
  const u11 = await repo.get('users', 'o_promo_r11')
  ok(sysRefund11.found === true && sysRefund11.refunded === true,
    '渠道退款推送：已出款未回填也不拦截，直接退款成功')
  ok(u11.promoterDebt === 282.15 && c11.status === '已提现',
    '渠道退款后佣金记欠款、待补录回退单号（不误置已冲正）')
  const back11 = await call(adminRouter, 'promote.reverseCommission', {
    paymentId: 'PROMO_PAY_011', reason: '分账回退成功', splitRefundDone: true, splitRefundNo: 'RF-PROMO-011'
  }, { token: adminToken })
  const u11b = await repo.get('users', 'o_promo_r11')
  ok(back11.ok && back11.data.reversed === true && u11b.promoterDebt === 0,
    '渠道退款后补录回退单号：冲正并清欠款')

  /* ---- Apple 到账确认：6 月 15 日结算任务已跑过，冻结佣金仍保持待结算 ---- */
  const caHeld = await repo.get('commissions', ca.id)
  ok(caHeld.status === '待结算' && caHeld.arrivalHold === true,
    '日历解冻日已过，到账冻结佣金不被结算任务解冻')
  const badMonth = await call(adminRouter, 'promote.appleSettle', { month: '2026-5' }, { token: financeToken })
  ok(!badMonth.ok && badMonth.code === 'VALIDATION', '到账月份必须为 YYYY-MM 格式')
  /* 推广者六预置 50 元欠款：确认到账时自动抵扣 */
  await repo.updateWhere('users', { id: P6.openid }, { promoterDebt: 50 })
  const arr1 = await call(adminRouter, 'promote.appleSettle', { month: '2026-05' }, { token: financeToken })
  ok(arr1.ok && arr1.data.count === 1 && arr1.data.amount === 131.87 && arr1.data.offset === 50,
    '财务确认 5 月 Apple 到账：解冻 1 笔 131.87，其中 50 元自动抵扣欠款')
  const caAfter = await repo.get('commissions', ca.id)
  const u6a = await repo.get('users', P6.openid)
  ok(caAfter.status === '可提现' && caAfter.arrivalHold === false && Number(caAfter.arrivedAt) === CLOCK &&
    caAfter.offsetToDebt === 50,
    '确认到账后佣金转可提现，回填 arrivedAt 与 offsetToDebt')
  ok(u6a.promoterAvailable === 81.87 && u6a.promoterDebt === 0 && u6a.promoterPending === 0,
    '确认到账后：可提现 81.87（131.87 − 50）、欠款清零、待结算清零')
  const arr2 = await call(adminRouter, 'promote.appleSettle', { month: '2026-05' }, { token: financeToken })
  ok(arr2.ok && arr2.data.count === 0, '同一月份重复确认到账保持幂等（0 笔）')
  const arrAudit = await repo.find('audit', { action: 'promote.appleSettle' }, { limit: 5 })
  ok(arrAudit.length >= 1, '确认到账动作写入审计日志')
  /* 开关关闭后，新 Apple 佣金回到次月 15 日日历解冻 */
  const setOff = await call(adminRouter, 'promote.saveSettings', { appleArrivalHold: false }, { token: adminToken })
  ok(setOff.ok, '关闭 Apple 到账冻结开关成功', setOff.message)
  /* 同一个买家第二次付款不再计佣（仅首次付款产生佣金） */
  await call(adminRouter, 'biz.grant', {
    uid: B7.openid, plan: 'month', amount: 999, method: '微信支付',
    paymentId: 'PROMO_PAY_RENEW_007', channel: 'apple'
  }, { token: adminToken })
  ok(!(await commissionOf('PROMO_PAY_RENEW_007')),
    '同一买家第二次付款不再计佣（推广佣金只认首次付款）')

  /* 开关关闭后，新 Apple 佣金回到次月 15 日日历解冻：换一个尚未付过款的买家 */
  const b12 = { openid: 'o_buyer_r12' }
  await promoLogin(b12, '买家十二', p6.res.data.refCode)
  await call(adminRouter, 'biz.grant', {
    uid: b12.openid, plan: 'month', amount: 999, method: '微信支付',
    paymentId: 'PROMO_PAY_008', channel: 'apple'
  }, { token: adminToken })
  const ca2 = await commissionOf('PROMO_PAY_008')
  ok(!!ca2 && ca2.status === '待结算', '关闭开关后 Apple 支付仍正常计佣')
  ok(!!ca2 && ca2.arrivalHold === false, '关闭开关后新 Apple 佣金不再到账冻结')
  ok(!!ca2 && ca2.eligibleAt === Date.parse('2026-07-14T16:00:00Z'),
    '关闭开关后 Apple 佣金按次月 15 日（7 月 15 日）日历解冻')
  await call(adminRouter, 'promote.saveSettings', { appleArrivalHold: true }, { token: adminToken })
  ok((await call(adminRouter, 'promote.settings', {}, { token: adminToken })).data.appleArrivalHold === true,
    '到账冻结开关恢复开启')

  /* ---- 退款闭环后对账仍然无资金类差异 ---- */
  const rec2 = await call(adminRouter, 'promote.reconcile', {}, { token: adminToken })
  const funding2 = rec2.ok
    ? rec2.data.issues.filter((issue) => [
      'user-ledger-drift', 'commission-overpaid', 'commission-over-withdrawn',
      'duplicate-payout-no', 'duplicate-active-item', 'paid-items-mismatch'
    ].indexOf(issue.type) > -1)
    : [{ type: 'reconcile-failed' }]
  ok(rec2.ok && funding2.length === 0, '退款闭环后对账无资金类差异', JSON.stringify(funding2.slice(0, 2)))

  /* ---- 三项定时任务：计佣补偿 / 分账完结清单 / 待打款超时提醒 ---- */
  const { createPromoteEngine } = require(path.join(shared, 'promote.js'))
  const promoteEngine = createPromoteEngine({ repo, now })
  const jobAt = CLOCK
  /* 模拟「支付成功但计佣失败」：只有收款单，没有佣金（首次付款的买家） */
  const b13 = { openid: 'o_buyer_r13' }
  await promoLogin(b13, '买家十三', p2.res.data.refCode)
  await repo.insert('payments', {
    id: 'PY_PROMO_COMP_1',
    uid: b13.openid,
    nick: '买家十三',
    bizType: '会员续费',
    planKey: 'month',
    planLabel: '月度会员',
    days: 30,
    amount: 999,
    received: 999,
    method: '微信支付',
    channel: 'wxpay',
    status: '已确认',
    paidAt: jobAt,
    confirmedAt: jobAt,
    orderId: 'BO_PROMO_COMP_1',
    paymentId: 'PROMO_PAY_COMP_1',
    outTradeNo: 'PROMO_PAY_COMP_1',
    createdAt: jobAt,
    updatedAt: jobAt
  })
  const comp1 = await promoteEngine.compensateCommissions()
  const compDoc = await commissionOf('PROMO_PAY_COMP_1')
  ok(comp1.created === 1 && !!compDoc && compDoc.uid === P2.openid && compDoc.amount === 148.35 &&
    compDoc.netAmount === 140.93 && compDoc.status === '待结算',
    '计佣补偿：漏计佣的会员收款单补齐佣金（148.35 / 净额 140.93）', JSON.stringify(comp1.failed.slice(0, 2)))
  const comp2 = await promoteEngine.compensateCommissions()
  ok(comp2.created === 0 && comp2.scanned >= 1, '计佣补偿幂等：重复执行不重复计佣')
  const compAudit = await repo.find('audit', { action: 'promote.commission.compensate' }, { limit: 5 })
  ok(compAudit.length >= 1, '计佣补偿写入审计日志')

  /* 分账完结清单：仅路径 A 出款完成、且该订单佣金全部结清的单 */
  const splitList = await promoteEngine.buildSplitCompletionList()
  ok(splitList.enabled === true && splitList.count >= 1 &&
    splitList.items.some((it) => it.transactionId === 'TXPROMO_PAY_001'),
    '分账完结清单：路径 A 已出款且佣金结清的单进入清单', JSON.stringify(splitList.items.slice(0, 2)))
  await call(adminRouter, 'promote.saveSettings', { splitEnabled: false }, { token: adminToken })
  const splitOff = await promoteEngine.buildSplitCompletionList()
  ok(splitOff.enabled === false && splitOff.count === 0 && splitOff.items.length === 0,
    '关闭分账后分账完结清单为空（不存在冻结资金）')
  await call(adminRouter, 'promote.saveSettings', { splitEnabled: true }, { token: adminToken })

  /* 待打款超时提醒：审核通过超过 24 小时仍未回填 */
  const staleId = 'W_PROMO_STALE_1'
  await repo.insert('promoterWithdrawals', {
    id: staleId,
    uid: P3.openid,
    requestId: 'WQ_PROMO_STALE',
    activeKey: 'W#' + staleId,
    amount: 120,
    fee: 6,
    tax: 0,
    deductToDebt: 0,
    net: 114,
    status: '待打款',
    method: '',
    payoutMode: 'manual',
    applyAt: jobAt - 48 * 3600 * 1000,
    appliedAt: jobAt - 48 * 3600 * 1000,
    reviewedAt: jobAt - 48 * 3600 * 1000,
    reviewedBy: 'finance',
    payoutDeadlineAt: jobAt - 25 * 3600 * 1000,
    createdAt: jobAt - 48 * 3600 * 1000,
    updatedAt: jobAt - 48 * 3600 * 1000
  })
  const remind1 = await promoteEngine.remindPayoutTimeout()
  const staleDoc = await repo.get('promoterWithdrawals', staleId)
  const staleNote = remind1.items.filter((it) => it.id === staleId)[0]
  ok(remind1.reminded >= 1 && !!staleNote && staleNote.overdueHours >= 24 &&
    staleDoc.payoutTimeoutCount === 1 && Number(staleDoc.payoutTimeoutRemindedAt) === jobAt,
    '待打款超时提醒：超过 24 小时未回填的单被标记', JSON.stringify(remind1.items.slice(0, 2)))
  const remind2 = await promoteEngine.remindPayoutTimeout()
  ok(remind2.reminded === 0 && remind2.skipped >= 1, '同一笔同一天只提醒一次，任务重跑不重复通知')
  const timeoutAudit = await repo.find('audit', { action: 'promote.payout.timeout' }, { limit: 5 })
  ok(timeoutAudit.length >= 1, '待打款超时写入审计日志')
  const outbox = await repo.find('outbox', {}, { limit: 500 })
  ok(outbox.some((m) => m.payload && m.payload.uid === P3.openid && m.payload.targetId === staleId &&
    String(m.payload.title || '').indexOf('提现') > -1), '待打款超时给推广者发进度提醒')

  const warnJob = await promoteEngine.warnExpiringCommissions()
  ok(warnJob && typeof warnJob.settled === 'number' && typeof warnJob.splitExpired === 'number',
    '超期预警任务可用：复用日终扫描（到期分账 / 日限额）')
}

/* ============================================================
   38. 客服业务：绑定用户 / 委托佣金 / 咨询领取与评价
   ============================================================ */
section('38. 客服业务：绑定、委托佣金与咨询评价')
{
  const loginAdmin = async (key) => {
    const acc = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === key)
    const r = await call(adminRouter, 'admin.login', {
      username: acc.username, password: acc.password, otp: generateTotp(acc.totpSecret, now())
    }, {})
    return r.ok ? r.data.token : ''
  }
  const adminCtx = { token: adminToken }
  const csToken = await loginAdmin('cs')
  ok(!!csToken, '客服账号可登录')
  const csCtx = { token: csToken }
  /* 前面的路由用例会产生真实的工单服务与佣金（同一客服坐席），
     本节统计按「本段增量」判断，避免被既有数据干扰 */
  const csBaseResp = await call(adminRouter, 'cs.settings', {}, csCtx)
  const csBaseStats = (csBaseResp.ok && csBaseResp.data.items[0] && csBaseResp.data.items[0].stats) || {}

  const A = { openid: 'o_cs_bound' }
  const B = { openid: 'o_cs_direct' }
  const C = { openid: 'o_cs_deep' }
  const D = { openid: 'o_cs_other' }
  await call(userRouter, 'auth.login', { nick: '客服绑定用户' }, A)
  await call(userRouter, 'auth.login', { nick: '直接下级' }, B)
  await call(userRouter, 'auth.login', { nick: '两级下级' }, C)
  await call(userRouter, 'auth.login', { nick: '无邀请人' }, D)

  /* ---- 比例配置：客服只有委托佣金（会员提成已取消） ---- */
  const rateDefault = await call(adminRouter, 'cs.settings', {}, adminCtx)
  ok(rateDefault.ok && rateDefault.data.settings.agencyRate === 0.2 &&
    rateDefault.data.settings.rate === undefined,
    '客服只有委托佣金默认 20%，不设会员提成比例', JSON.stringify(rateDefault.data && rateDefault.data.settings))
  const badRate = await call(adminRouter, 'cs.saveSettings', { agencyRate: 0.6 }, adminCtx)
  ok(!badRate.ok && badRate.code === 'VALIDATION', '委托佣金比例超出 0~50% 区间被拒绝')
  const savedRate = await call(adminRouter, 'cs.saveSettings', { agencyRate: 0.22 }, adminCtx)
  ok(savedRate.ok && savedRate.data.agencyRate === 0.22, '管理员可调整全局默认委托佣金比例')
  await call(adminRouter, 'cs.saveSettings', { agencyRate: 0.2 }, adminCtx)
  const ownRate = await call(adminRouter, 'cs.saveAgencyRate', { csId: 'cs', rate: 0.12 }, adminCtx)
  ok(ownRate.ok && ownRate.data.rate === 0.12 && ownRate.data.source === 'staff',
    '客服单独委托佣金比例优先生效', JSON.stringify(ownRate.data))
  const clearRate = await call(adminRouter, 'cs.saveAgencyRate', { csId: 'cs', rate: null }, adminCtx)
  ok(clearRate.ok && clearRate.data.rate === 0.2 && clearRate.data.source === 'global',
    '清空单独比例后回落全局默认 20%')
  const csForbidden = await call(adminRouter, 'cs.saveSettings', { agencyRate: 0.1 }, csCtx)
  ok(!csForbidden.ok && csForbidden.code === 'FORBIDDEN', '客服不能自行调整委托佣金比例')

  /* ---- 绑定：一个客服一个用户 / 一个用户一个客服 ---- */
  const bindBad = await call(adminRouter, 'cs.bind', { csId: 'cs' }, adminCtx)
  ok(!bindBad.ok && bindBad.code === 'VALIDATION', '绑定必须指定用户账号')
  const binded = await call(adminRouter, 'cs.bind', { csId: 'cs', uid: A.openid }, adminCtx)
  ok(binded.ok && binded.data.uid === A.openid && binded.data.csId === 'cs', '客服可绑定一个用户账号')
  const bindAgain = await call(adminRouter, 'cs.bind', { csId: 'cs', uid: B.openid }, adminCtx)
  ok(!bindAgain.ok && bindAgain.code === 'CONFLICT', '同一客服不能再绑定第二个用户')
  const bindTaken = await call(adminRouter, 'cs.bind', { csId: 'admin', uid: A.openid }, adminCtx)
  ok(!bindTaken.ok && bindTaken.code === 'CONFLICT', '同一用户不能同时归属两个客服')
  const bindSelf = await call(adminRouter, 'cs.bind', { csId: 'cs', uid: B.openid }, csCtx)
  ok(!bindSelf.ok && bindSelf.code === 'FORBIDDEN', '客服不能自行绑定用户（管理端控制）')

  /* ---- 绑定即锁定：绑定瞬间写入当时的委托佣金比例快照 ---- */
  const boundDoc = await repo.get('csBindings', 'cs')
  ok(boundDoc && boundDoc.agencyRate === 0.2 && boundDoc.agencyRateSource === 'global' &&
    boundDoc.memberRate === undefined,
    '绑定时锁定当时的委托佣金 20%，不再锁定会员提成', JSON.stringify(boundDoc))
  const lockView = await call(adminRouter, 'cs.settings', {}, adminCtx)
  const lockRow = (lockView.data.items || []).filter((it) => it.csId === 'cs')[0]
  ok(lockRow && lockRow.rateLocked === true && lockRow.lockedAgencyRate === 0.2 &&
    lockRow.lockedMemberRate === undefined,
    '管理端只展示绑定锁定的委托佣金比例', JSON.stringify(lockRow && {
      agency: lockRow.lockedAgencyRate, locked: lockRow.rateLocked
    }))

  /* ---- 推广规则拆分：客服绑定（两级）与普通推广（一级）分开设置 ---- */
  const promoteBase = await call(adminRouter, 'promote.settings', {}, adminCtx)
  ok(promoteBase.ok && promoteBase.data.csLevel1Rate !== undefined &&
    promoteBase.data.commissionRate !== undefined && promoteBase.data.level2Rate !== undefined,
    '推广规则同时返回客服绑定一级 / 普通一级 / 二级比例', JSON.stringify(promoteBase.data))
  const oldPromote = {
    commissionRate: Number(promoteBase.data.commissionRate),
    csLevel1Rate: Number(promoteBase.data.csLevel1Rate),
    level2Rate: Number(promoteBase.data.level2Rate)
  }
  const setSplit = await call(adminRouter, 'promote.saveSettings', {
    commissionRate: 0.1, csLevel1Rate: 0.2, level2Rate: 0.12
  }, adminCtx)
  ok(setSplit.ok && setSplit.data.commissionRate === 0.1 && setSplit.data.csLevel1Rate === 0.2 &&
    setSplit.data.level2Rate === 0.12,
    '客服绑定与普通推广一级比例可分别保存', JSON.stringify(setSplit.data))
  const csHome = await call(userRouter, 'promote.summary', {}, A)
  ok(csHome.ok && csHome.data.promoteType === 'cs' && csHome.data.level2Enabled === true &&
    csHome.data.rate === 0.2 && csHome.data.level2Rate === 0.12,
    '客服绑定用户按专属一级 + 二级比例展示',
    JSON.stringify(csHome.data && { type: csHome.data.promoteType, rate: csHome.data.rate, l2: csHome.data.level2Rate }))
  const normalHome = await call(userRouter, 'promote.summary', {}, D)
  ok(normalHome.ok && normalHome.data.promoteType === 'normal' && normalHome.data.level2Enabled === false &&
    normalHome.data.rate === 0.1,
    '普通推广用户（含商机会员）只有一级比例、无二级',
    JSON.stringify(normalHome.data && { type: normalHome.data.promoteType, rate: normalHome.data.rate }))

  /* ---- 每日工作量：按北京时间自然日返回，客服只能看本人 ---- */
  const dailyAdmin = await call(adminRouter, 'cs.daily', { days: 7 }, adminCtx)
  const dailyRow = (dailyAdmin.ok && (dailyAdmin.data.items || []).filter((it) => it.csId === 'cs')[0]) || null
  ok(!!dailyRow && dailyRow.items.length === 7 && dailyRow.items[6].day &&
    dailyRow.totals && typeof dailyRow.totals.commission === 'number',
    '管理员可查全部客服的每日工作量（按自然日）', JSON.stringify(dailyRow && { days: dailyRow.items.length }))
  const dailyMine = await call(adminRouter, 'cs.daily', { csId: 'admin', days: 7 }, csCtx)
  ok(dailyMine.ok && dailyMine.data.items.length === 1 && dailyMine.data.items[0].csId === 'cs',
    '客服只能查看自己的每日工作量')
  const dailyClamp = await call(adminRouter, 'cs.daily', { days: 999 }, adminCtx)
  ok(dailyClamp.ok && dailyClamp.data.days === 30, '每日工作量天数上限收敛到 30 天')

  /* ---- 会员支付只产生推广佣金，不再产生客服提成 ---- */
  await repo.insert('referralBindings', {
    id: B.openid, refUid: A.openid, scene: 'share', createdAt: now() - 10 * 86400000
  })
  await repo.insert('referralBindings', {
    id: C.openid, refUid: B.openid, scene: 'share', createdAt: now() - 9 * 86400000
  })
  const payMonth = (buyer, paymentId, amount) => call(adminRouter, 'biz.grant', {
    uid: buyer,
    plan: 'month',
    amount,
    method: '微信支付',
    paymentId,
    channel: 'wxpay',
    transactionId: 'TX' + paymentId
  }, adminCtx)

  const payDirect = await payMonth(B.openid, 'CS_PAY_DIRECT', 1000)
  ok(payDirect.ok, '直接下级会员支付成功（只产生推广佣金）')
  const rowsDirect = await repo.find('csAgencyCommissions', { paymentId: 'CS_PAY_DIRECT' }, { limit: 5 })
  ok(rowsDirect.length === 0, '会员支付不再产生客服提成')
  const salaryAfterPay = await call(adminRouter, 'cs.salary', {}, csCtx)
  ok(salaryAfterPay.ok && salaryAfterPay.data.memberCommission === undefined &&
    salaryAfterPay.data.monthSalary === salaryAfterPay.data.agencyCommission,
    '客服工资只含委托佣金，不含会员提成', JSON.stringify(salaryAfterPay.data))
  await payMonth(B.openid, 'CS_PAY_DIRECT', 1000)
  const rowsAgain = await repo.find('csAgencyCommissions', { paymentId: 'CS_PAY_DIRECT' }, { limit: 5 })
  ok(rowsAgain.length === 0, '同一支付单号重复回调仍不计客服提成（幂等）')

  await payMonth(C.openid, 'CS_PAY_DEEP', 800)
  await payMonth(D.openid, 'CS_PAY_NONE', 500)
  await payMonth(A.openid, 'CS_PAY_SELF', 600)

  /* ---- 计佣按推广者身份取比例：客服绑定一级 vs 普通一级 ---- */
  const directRows = await repo.find('commissions', { paymentId: 'CS_PAY_DIRECT' }, { limit: 5 })
  ok(directRows.length === 1 && directRows[0].uid === A.openid && directRows[0].level === 1 &&
    directRows[0].rate === 0.2,
    '客服绑定用户的一级佣金按 csLevel1Rate 计提', JSON.stringify(directRows.map((r) => ({ uid: r.uid, rate: r.rate }))))
  const deepL1 = await repo.find('commissions', { paymentId: 'CS_PAY_DEEP' }, { limit: 5 })
  ok(deepL1.length === 0, '普通推广人（未开通 / 非客服绑定）不产生一级佣金')
  const deepL2 = await repo.find('commissions', { paymentId: 'CS_PAY_DEEP#L2' }, { limit: 5 })
  ok(deepL2.length === 1 && deepL2[0].uid === A.openid && deepL2[0].level === 2 &&
    deepL2[0].rate === 0.12,
    '客服绑定用户的二级佣金按 level2Rate 计提', JSON.stringify(deepL2.map((r) => ({ uid: r.uid, rate: r.rate }))))
  const noneRows = await repo.find('commissions', { paymentId: 'CS_PAY_NONE' }, { limit: 5 })
  ok(noneRows.length === 0, '未绑定推广关系的普通用户付款不计佣')

  /* ---- 客服绑定账号：封禁 / 停用即停佣；开通时间不参与判定 ---- */
  const { createPromoteEngine } = require(path.join(shared, 'promote.js'))
  const csPromoteEngine = createPromoteEngine({ repo, now })
  const CS2 = { openid: 'o_cs_verify_owner' }
  const CS2_B1 = { openid: 'o_cs_verify_buyer1' }
  const CS2_B2 = { openid: 'o_cs_verify_buyer2' }
  const CS2_B3 = { openid: 'o_cs_verify_buyer3' }
  const CS2_B4 = { openid: 'o_cs_verify_buyer4' }
  await call(userRouter, 'auth.login', { nick: '客服绑定验证账号' }, CS2)
  await repo.insert('csBindings', {
    id: 'cs_verify_2', uid: CS2.openid, csId: 'cs', agencyRate: 0.2, createdAt: now()
  })
  await call(userRouter, 'auth.login', { nick: '客服绑定验证买家一' }, CS2_B1)
  await call(userRouter, 'auth.login', { nick: '客服绑定验证买家二' }, CS2_B2)
  await call(userRouter, 'auth.login', { nick: '客服绑定验证买家三' }, CS2_B3)
  await call(userRouter, 'auth.login', { nick: '客服绑定验证买家四' }, CS2_B4)
  await repo.insert('referralBindings', {
    id: CS2_B1.openid, refUid: CS2.openid, scene: 'share', boundAt: now() - 3000, createdAt: now() - 3000
  })
  await payMonth(CS2_B1.openid, 'CS2_PAY_BEFORE_BLOCK', 500)
  const cs2Before = await repo.find('commissions', { paymentId: 'CS2_PAY_BEFORE_BLOCK' }, { limit: 5 })
  ok(cs2Before.length === 1 && cs2Before[0].uid === CS2.openid && cs2Before[0].level === 1,
    '客服绑定账号未开通推广、绑定即生效，按一级计佣')

  const blockCs2 = await call(adminRouter, 'promote.setStatus',
    { uid: CS2.openid, status: 'blocked', reason: '验证封禁' }, adminCtx)
  ok(blockCs2.ok, '管理端可封禁客服绑定账号')
  await repo.insert('referralBindings', {
    id: CS2_B2.openid, refUid: CS2.openid, scene: 'share', boundAt: now(), createdAt: now()
  })
  await payMonth(CS2_B2.openid, 'CS2_PAY_BLOCKED', 500)
  ok((await repo.find('commissions', { paymentId: 'CS2_PAY_BLOCKED' }, { limit: 5 })).length === 0,
    '客服绑定账号被封禁后停止一级计佣')
  await repo.insert('referralBindings', {
    id: CS2_B3.openid, refUid: CS2_B2.openid, scene: 'share', boundAt: now(), createdAt: now()
  })
  await payMonth(CS2_B3.openid, 'CS2_PAY_BLOCKED_DEEP', 500)
  ok((await repo.find('commissions', { paymentId: 'CS2_PAY_BLOCKED_DEEP#L2' }, { limit: 5 })).length === 0,
    '客服绑定账号被封禁后停止二级计佣')
  await call(adminRouter, 'promote.setStatus', { uid: CS2.openid, status: 'active', reason: '验证解封' }, adminCtx)

  /* 客服身份以绑定为准：之后才开通推广，也不按开通时间追溯失效 */
  const cs2OpenedAt = now()
  await repo.updateWhere('users', { id: CS2.openid }, {
    promoterStatus: 'active', promoterOpenedAt: cs2OpenedAt, promoterSince: cs2OpenedAt
  })
  const csLate = await csPromoteEngine.createCommission({
    uid: CS2.openid,
    relationUid: CS2_B1.openid,
    paymentId: 'CS2_PAY_BEFORE_OPEN',
    amount: 1000,
    channel: 'wxpay',
    at: cs2OpenedAt - 2000
  })
  ok(!!csLate && csLate.uid === CS2.openid && csLate.level === 1,
    '客服绑定账号的佣金不看开通时间：绑定早于开通、付款早于开通也按客服身份计入')

  /* 账号停用：客服绑定同样停止计佣 */
  await repo.updateWhere('users', { id: CS2.openid }, { status: '停用' })
  await repo.insert('referralBindings', {
    id: CS2_B4.openid, refUid: CS2.openid, scene: 'share', boundAt: now(), createdAt: now()
  })
  await payMonth(CS2_B4.openid, 'CS2_PAY_DISABLED', 500)
  ok((await repo.find('commissions', { paymentId: 'CS2_PAY_DISABLED' }, { limit: 5 })).length === 0,
    '账号被停用后客服绑定账号停止计佣')
  await repo.updateWhere('users', { id: CS2.openid }, { status: '正常' })

  /* 恢复原始比例，避免影响后续用例 */
  await call(adminRouter, 'promote.saveSettings', oldPromote, adminCtx)

  const statsAdmin = await call(adminRouter, 'cs.settings', {}, adminCtx)
  const csRow = statsAdmin.data.items.filter((it) => it.csId === 'cs')[0]
  ok(!!csRow && csRow.stats.agencyFeeTotal === (Number(csBaseStats.agencyFeeTotal) || 0) &&
    csRow.stats.commissionTotal === (Number(csBaseStats.commissionTotal) || 0) &&
    csRow.stats.monthAgencyFee === (Number(csBaseStats.monthAgencyFee) || 0) &&
    csRow.stats.ratingCount === 0 &&
    csRow.stats.rateLocked === true && csRow.stats.lockedAgencyRate === 0.2,
    '客服档案只统计委托服务费，会员支付不进入业绩', JSON.stringify(csRow && csRow.stats))
  const statsMine = await call(adminRouter, 'cs.settings', {}, csCtx)
  ok(statsMine.ok && statsMine.data.items.length === 1 && statsMine.data.items[0].csId === 'cs',
    '客服只能看到自己的档案')
  const commMine = await call(adminRouter, 'cs.commissions', { csId: 'admin' }, csCtx)
  ok(commMine.ok && commMine.data.csId === 'cs' &&
    commMine.data.total === (Number(csBaseStats.orderCount) || 0),
    '客服委托佣金流水强制只看自己，会员支付不产生记录')
  const commAdmin = await call(adminRouter, 'cs.commissions', { csId: 'cs' }, adminCtx)
  ok(commAdmin.ok && commAdmin.data.total === (Number(csBaseStats.orderCount) || 0),
    '管理员查看指定客服委托佣金流水')

  /* ---- 代采代售咨询：等待领取 → 客服接入 → 对话 → 结束 → 评价 ---- */
  const LEAD_ID = 'ld_cs_verify_1'
  await repo.insert('leads', {
    id: LEAD_ID,
    uid: B.openid,
    targetType: 'agency',
    targetId: 'agy_cs_verify',
    agencyTitle: '代售 · 验证委托',
    formSummary: '代售 · 验证委托',
    status: LEAD_STATUS.PENDING,
    csStatus: '待领取',
    csClaimedAt: 0,
    csId: '',
    csName: '',
    threadId: LEAD_ID,
    assignedAccount: '',
    createdAt: now(),
    updatedAt: now()
  })
  await repo.insert('outbox', {
    id: 'M_cs_wait',
    type: 'kf.chat',
    payload: {
      uid: B.openid,
      channel: 'kf',
      from: 'system',
      staffName: '平台客服',
      threadId: LEAD_ID,
      targetType: 'agency',
      targetId: 'agy_cs_verify',
      title: '代售 · 验证委托',
      body: '需求已提交，工单已生成，正在等待平台客服处理',
      csStatus: '待领取'
    },
    status: 'pending',
    createdAt: now()
  })

  const waitThread = await call(userRouter, 'msg.thread', { threadId: LEAD_ID }, B)
  ok(waitThread.ok && waitThread.data.kind === 'cs' &&
    waitThread.data.cs.status === '待领取' && waitThread.data.cs.waiting === true &&
    waitThread.data.cs.canSend === false,
    '未领取时用户端显示「正在等待平台客服处理」且不能发言', JSON.stringify(waitThread.data && waitThread.data.cs))
  ok(waitThread.data.items.some((it) => it.role === 'system' && it.text.indexOf('正在等待平台客服处理') > -1),
    '未领取时会话内展示平台等待提示')
  const waitSend = await call(userRouter, 'msg.send', { threadId: LEAD_ID, body: '在吗' }, B)
  ok(!waitSend.ok && waitSend.code === 'CONFLICT', '客服未领取前用户不能发消息')

  const unclaimedReply = await call(adminRouter, 'msg.reply', {
    threadId: LEAD_ID, body: '未领取直接回复'
  }, csCtx)
  ok(!unclaimedReply.ok && unclaimedReply.code === 'FORBIDDEN', '客服未领取不能直接回复用户')
  const adminUnclaimedReply = await call(adminRouter, 'msg.reply', {
    threadId: LEAD_ID, body: '管理员未领取直接回复'
  }, { token: adminToken })
  ok(!adminUnclaimedReply.ok && adminUnclaimedReply.code === 'FORBIDDEN', '管理员也必须先领取才能回复咨询')

  const claim = await call(adminRouter, 'lead.claim', { leadId: LEAD_ID }, csCtx)
  ok(claim.ok && claim.data.csStatus === '服务中', '客服领取后咨询进入服务中', JSON.stringify(claim.data))
  const servingThread = await call(userRouter, 'msg.thread', { threadId: LEAD_ID }, B)
  ok(servingThread.ok && servingThread.data.cs.status === '服务中' &&
    servingThread.data.cs.canSend === true && !!servingThread.data.cs.csName,
    '领取后用户端显示哪个客服正在接入并可对话', JSON.stringify(servingThread.data && servingThread.data.cs))
  ok(servingThread.data.cs.stage === 'communicating' && servingThread.data.cs.stageLabel === '沟通中',
    '会话同步返回客服标准流程阶段，供用户端展示服务进度', JSON.stringify(servingThread.data && servingThread.data.cs))

  const staffReply = await call(adminRouter, 'msg.reply', { threadId: LEAD_ID, body: '你好，我来对接' }, csCtx)
  ok(staffReply.ok && staffReply.data.threadId === LEAD_ID, '客服可在咨询会话内回复用户')
  const userSend = await call(userRouter, 'msg.send', { threadId: LEAD_ID, body: '麻烦帮我看下报价' }, B)
  ok(userSend.ok, '服务中用户可正常发消息')
  const servedThread = await call(userRouter, 'msg.thread', { threadId: LEAD_ID }, B)
  const texts = servedThread.data.items.map((it) => it.text)
  ok(texts.indexOf('你好，我来对接') > -1 && texts.indexOf('麻烦帮我看下报价') > -1,
    '双方消息在同一咨询会话内可见', JSON.stringify(texts))

  const end = await call(adminRouter, 'lead.endService', { leadId: LEAD_ID }, csCtx)
  ok(end.ok && end.data.csStatus === '已结束', '客服结束服务后咨询状态变为已结束', JSON.stringify(end.data))
  const endAgain = await call(adminRouter, 'lead.endService', { leadId: LEAD_ID }, csCtx)
  ok(endAgain.ok && endAgain.data.already === true, '重复结束服务幂等')
  const rated = await call(userRouter, 'consult.rate', {
    leadId: LEAD_ID, score: 5, tags: ['专业', '响应快'], text: '对接很快'
  }, B)
  ok(rated.ok && rated.data.rating === 5, '结束后用户可对客服打分评价', JSON.stringify(rated.data))
  const ratedRow = await repo.find('csRatings', { leadId: LEAD_ID }, { limit: 5 })
  ok(ratedRow.length === 1 && ratedRow[0].csId === 'cs' && ratedRow[0].score === 5,
    '评价落库并归属到对应客服', JSON.stringify(ratedRow[0]))
  const ratedAgain = await call(userRouter, 'consult.rate', { leadId: LEAD_ID, score: 3 }, B)
  ok(!ratedAgain.ok && ratedAgain.code === 'CONFLICT', '同一咨询不能重复评价')
  const rateOther = await call(userRouter, 'consult.rate', { leadId: LEAD_ID, score: 5 }, D)
  ok(!rateOther.ok && rateOther.code === 'NOT_FOUND', '非咨询本人不能评价')
  const ratingBad = await call(userRouter, 'consult.rate', { leadId: LEAD_ID, score: 9 }, B)
  ok(!ratingBad.ok && ratingBad.code === 'CONFLICT', '已评价后不接受再次提交（含非法分值）')

  /* 结束后用户再发言：工单回到待领取，必须由客服重新领取后才能继续对话 */
  const endSend = await call(userRouter, 'msg.send', { threadId: LEAD_ID, body: '还在吗' }, B)
  ok(endSend.ok && endSend.data.waiting === true && endSend.data.threadId === LEAD_ID,
    '结束后用户再发消息需要客服重新领取')
  const endReply = await call(adminRouter, 'msg.reply', { threadId: LEAD_ID, body: '已结束' }, csCtx)
  ok(!endReply.ok && (endReply.code === 'FORBIDDEN' || endReply.code === 'CONFLICT'), '重新领取前客服不能再回复')
  const reclaim = await call(adminRouter, 'lead.claim', { leadId: LEAD_ID }, csCtx)
  ok(reclaim.ok && reclaim.data.csStatus === '服务中', '重新领取后可继续服务')
  const reEnd = await call(adminRouter, 'lead.endService', { leadId: LEAD_ID }, csCtx)
  ok(reEnd.ok && reEnd.data.csStatus === '已结束', '重新服务后可再次结束')

  const ratingRows = await call(adminRouter, 'cs.ratings', { csId: 'cs' }, adminCtx)
  ok(ratingRows.ok && ratingRows.data.total === 1 && ratingRows.data.items[0].leadId === LEAD_ID &&
    ratingRows.data.items[0].tags.join(',') === '专业,响应快',
    '评价自动记入客服档案', JSON.stringify(ratingRows.data.items[0]))
  const statsAfter = await call(adminRouter, 'cs.settings', {}, csCtx)
  const csAfter = statsAfter.data.items[0]
  ok(statsAfter.ok && csAfter.stats.ratingCount === 1 && csAfter.stats.ratingAvg === 5 &&
    csAfter.stats.servedCount === (Number(csBaseStats.servedCount) || 0) + 1 &&
    csAfter.stats.endedCount === (Number(csBaseStats.endedCount) || 0) + 1,
    '客服档案聚合评分与服务单数', JSON.stringify(csAfter && csAfter.stats))
  const rateLog = await repo.find('audit', { action: 'consult.rate' }, { limit: 5 })
  ok(rateLog.length === 1, '评价写入审计日志')

  /* ---- 工单超时未回复自动结束 ---- */
  await repo.insert('leads', {
    id: 'LD_IDLE_TEST',
    uid: B.openid,
    targetType: 'agency',
    agencyId: 'agy_idle',
    agencyTitle: '超时测试委托',
    status: LEAD_STATUS.FOLLOWING,
    csStatus: CS_STATUS.SERVING,
    assignedAccount: 'cs',
    assignedTo: '客服坐席',
    csClaimedAt: now() - 31 * 60000,
    serviceStage: 'communicating',
    stageVersion: 1,
    ticketState: TICKET_STATE.TICKETED,
    createdAt: now() - 40 * 60000,
    updatedAt: now() - 31 * 60000
  })
  const idleEnded = await closeIdleLeads(repo, { at: now(), minutes: 30 })
  ok(idleEnded.indexOf('LD_IDLE_TEST') >= 0, '领取后超时未回复的工单被自动结束')
  const idleRow = await repo.get('leads', 'LD_IDLE_TEST')
  ok(idleRow.csStatus === CS_STATUS.ENDED && idleRow.autoEnded === true && idleRow.serviceStage === 'aborted',
    '超时结束后工单闭合且标记为系统自动结束', JSON.stringify(idleRow))
  const idleMsg = await repo.find('outbox', { id: 'M' + sha256Hex('cs-end:LD_IDLE_TEST').slice(0, 22) }, { limit: 5 })
  ok(idleMsg.length === 1 && idleMsg[0].payload.askRating === true, '超时结束后给用户推送评价邀请')
  const idleReset = await call(userRouter, 'msg.send', { threadId: 'LD_IDLE_TEST', body: '我又来了' }, B)
  ok(idleReset.ok && idleReset.data.waiting === true, '结束后用户再次发消息需要重新领取')
  const idleAfter = await repo.get('leads', 'LD_IDLE_TEST')
  ok(idleAfter.csStatus === CS_STATUS.WAITING && !idleAfter.assignedAccount &&
    idleAfter.serviceStage === 'communicating', '重新发起后工单回到待领取且阶段重置为沟通中')
  const idleReply = await call(adminRouter, 'msg.reply', { threadId: 'LD_IDLE_TEST', body: '在的' }, csCtx)
  ok(!idleReply.ok && (idleReply.code === 'FORBIDDEN' || idleReply.code === 'CONFLICT'),
    '未重新领取前客服不能直接回复')
  await repo.updateWhere('leads', { id: 'LD_IDLE_TEST' }, { csStatus: CS_STATUS.WAITING, assignedAccount: '', assignedTo: '' })

  /* ---- 代采代售佣金与客服工资（引擎层 P1 底座） ---- */
  const csEngine = createCsEngine({ repo, now })
  const MK_NOW = monthKeyOf(CLOCK)
  const clockCn = new Date(CLOCK + 8 * 3600 * 1000)
  const prevMonthAt = Date.UTC(clockCn.getUTCFullYear(), clockCn.getUTCMonth() - 1, 15, 4) - 8 * 3600 * 1000
  const MK_PREV = monthKeyOf(prevMonthAt)
  /* 既有工单佣金（前面路由用例已确认到账的部分）作为底座，本节只断言增量 */
  const salaryBase = await csEngine.salaryOf('cs', MK_NOW)
  const agencySettings = await call(adminRouter, 'cs.settings', {}, adminCtx)
  ok(agencySettings.data.settings.agencyRate === 0.2 && agencySettings.data.settings.agencyRateMax === 0.5,
    '代采代售佣金默认 20%，区间 0~50%', JSON.stringify(agencySettings.data.settings))
  ok(agencySettings.data.settings.idleMinutes === 30 && agencySettings.data.settings.idleMin === 5 &&
    agencySettings.data.settings.idleMax === 240, '超时自动结束默认 30 分钟，区间 5~240')
  const badIdle = await call(adminRouter, 'cs.saveSettings', { idleMinutes: 2 }, adminCtx)
  ok(!badIdle.ok && badIdle.code === 'VALIDATION', '超时时长低于下限被拒绝')
  const idleSaved = await call(adminRouter, 'cs.saveSettings', { idleMinutes: 20 }, adminCtx)
  ok(idleSaved.ok && idleSaved.data.idleMinutes === 20, '超时时长可在管理端配置')
  await call(adminRouter, 'cs.saveSettings', { idleMinutes: 30 }, adminCtx)
  const badAgencyRate = await call(adminRouter, 'cs.saveSettings', { agencyRate: 0.6 }, adminCtx)
  ok(!badAgencyRate.ok && badAgencyRate.code === 'VALIDATION', '代采佣金比例超过上限被拒绝')
  const agencyOnly = await call(adminRouter, 'cs.saveSettings', { agencyRate: 0.25 }, adminCtx)
  ok(agencyOnly.ok && agencyOnly.data.agencyRate === 0.25 && agencyOnly.data.rate === undefined,
    '只改委托佣金比例，不再存在会员提成比例', JSON.stringify(agencyOnly.data))
  await call(adminRouter, 'cs.saveSettings', { agencyRate: 0.2 }, adminCtx)

  const feeDefault = await csEngine.recordAgencyFeePaid({
    paymentId: 'PAY_AG_P1', csId: 'cs', csName: '客服坐席', agencyId: 'agy_p1',
    leadId: 'ld_p1', item: 'H100 整机', feeAmount: 5000, paidAt: CLOCK
  })
  ok(feeDefault && feeDefault.commission === 1000 && feeDefault.rate === 0.2 &&
    feeDefault.rateSource === 'binding' && feeDefault.monthKey === MK_NOW,
    '服务费实收 5000 按绑定锁定的 20% 计提 1000', JSON.stringify(feeDefault))
  const feeRepeat = await csEngine.recordAgencyFeePaid({
    paymentId: 'PAY_AG_P1', csId: 'cs', feeAmount: 5000, paidAt: CLOCK
  })
  ok(feeRepeat === null, '同一笔服务费账单只计提一次佣金')
  await csEngine.saveAgencyRate('cs', 0.3, 'admin')
  const feeStaff = await csEngine.recordAgencyFeePaid({
    paymentId: 'PAY_AG_P1B', csId: 'cs', feeAmount: 1000, paidAt: CLOCK
  })
  ok(feeStaff && feeStaff.commission === 200 && feeStaff.rateSource === 'binding',
    '已绑定账号调价不追溯，仍按锁定 20% 计提（1000 → 200）', JSON.stringify(feeStaff))
  await csEngine.saveAgencyRate('cs', null, 'admin')

  const salaryNow = await csEngine.salaryOf('cs', MK_NOW)
  ok(salaryNow.memberCommission === undefined && salaryNow.agencyCommission === 1200 &&
    salaryNow.monthSalary === 1200 && salaryNow.agencyOrderCount === 2,
    '工资只含委托佣金 1200，不再叠加会员提成', JSON.stringify(salaryNow))

  const feePrev = await csEngine.recordAgencyFeePaid({
    paymentId: 'PAY_AG_PREV', csId: 'cs', feeAmount: 1000, paidAt: prevMonthAt
  })
  ok(feePrev && feePrev.monthKey === MK_PREV, '佣金按到账月份归档（上月单不混入本月）')
  const salaryPrevBefore = await csEngine.salaryOf('cs', MK_PREV)
  ok(salaryPrevBefore.agencyCommission === 200 && salaryPrevBefore.monthSalary === 200,
    '上月工资只含上月到账的佣金')
  const reversed = await csEngine.reverseAgencyCommission({ paymentId: 'PAY_AG_PREV', reason: '服务费退款', at: CLOCK })
  ok(reversed && reversed.reversedCommission === 200 && reversed.reversedAt === CLOCK, '退款冲正记录冲正金额与时间')
  const reverseAgain = await csEngine.reverseAgencyCommission({ paymentId: 'PAY_AG_PREV', at: CLOCK + 86400000 })
  ok(reverseAgain && reverseAgain.reversedAt === CLOCK, '重复冲正幂等，不重复扣回')
  const salaryPrevAfter = await csEngine.salaryOf('cs', MK_PREV)
  const salaryNowAfter = await csEngine.salaryOf('cs', MK_NOW)
  ok(salaryPrevAfter.monthSalary === 200 && salaryNowAfter.monthSalary === 1000,
    '冲正只扣当月工资，不改历史月份（本月 1200 → 1000）',
    JSON.stringify({ prev: salaryPrevAfter.monthSalary, now: salaryNowAfter.monthSalary }))
  ok(salaryNowAfter.totalAgencyCommission === salaryBase.totalAgencyCommission + 1200 &&
    salaryNowAfter.totalSalary === salaryNowAfter.totalAgencyCommission,
    '累计工资只含委托佣金净额 1200（叠加既有工单佣金）', JSON.stringify(salaryNowAfter))
  const statsP1 = await csEngine.statsOf('cs')
  ok(statsP1.agencyRate === 0.2 && statsP1.monthSalary === 1000 && statsP1.monthAgencyCommission === 1000,
    '客服档案同步展示工资与委托佣金口径', JSON.stringify({ rate: statsP1.agencyRate, salary: statsP1.monthSalary }))
}

/* ============================================================
   39. 代采代售咨询标准流程：条件 → 居间合同 → 签约 → 服务费 → 佣金 → 完成
   ============================================================ */
section('39. 咨询标准流程：合同、服务费与佣金闭环')
{
  const loginAdmin = async (key) => {
    const acc = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === key)
    const r = await call(adminRouter, 'admin.login', {
      username: acc.username, password: acc.password, otp: generateTotp(acc.totpSecret, now())
    }, {})
    return r.ok ? r.data.token : ''
  }
  const csCtxP3 = { token: await loginAdmin('cs') }
  const adminCtxP3 = { token: adminToken }
  ok(!!csCtxP3.token && !!adminCtxP3.token, '客服与管理员账号可登录')

  const OWNER = { openid: 'o_p3_owner' }
  const BUYER = { openid: 'o_p3_buyer' }
  await call(userRouter, 'auth.login', { nick: '流程委托方' }, OWNER)
  await call(userRouter, 'auth.login', { nick: '流程对接方' }, BUYER)

  const pub = await call(userRouter, 'agency.submit', {
    side: 'sell', mode: TRADE_MODES.SELL, item: 'H200 141G', qty: 1, price: 300000, amount: 300000,
    detail: '现货一台，支持验机', city: '杭州', subjectType: 'company', subject: '流程测试有限公司',
    creditCode: '91330100MA2ABCDE1X', legal: '周委托', phone: '13500001111', authPhone: '13500001111',
    media: [
      { name: 'license.pdf', kind: 'license' },
      { name: 'proof.pdf', kind: 'proof' },
      { name: 'authorization.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }, OWNER)
  ok(pub.ok, '代售委托提交成功')
  /* 新发布委托同步生成上架审核工单：进入工作台「待领取」，客服领取后核对并审核 */
  const auditTicketId = 'au' + sha256Hex(`agency-audit:${pub.data.id}`).slice(0, 24)
  const auditTicket = await repo.get('leads', auditTicketId)
  ok(auditTicket && auditTicket.ticketKind === 'audit' && auditTicket.ticketState === TICKET_STATE.TICKETED &&
    !auditTicket.assignedAccount, '新发布委托生成待领取的上架审核工单',
  JSON.stringify(auditTicket && { kind: auditTicket.ticketKind, state: auditTicket.ticketState, cs: auditTicket.assignedAccount }))
  const auditBench = await call(adminRouter, 'consult.list', { tab: 'unclaimed', page: 1, limit: 100 }, csCtxP3)
  const auditBenchRow = (auditBench.data.items || []).find((it) => it.leadId === auditTicketId)
  ok(auditBench.ok && !!auditBenchRow && auditBenchRow.ticketKind === 'audit' && auditBenchRow.stageLabel === '待领取',
    '上架审核工单进入工单中心「待领取」分栏')
  const approve = await call(adminRouter, 'agency.review', { id: pub.data.id, decision: '通过' }, adminCtxP3)
  ok(approve.ok && approve.data.status === '已上架', '委托审核通过并上架')
  const auditClosed = await repo.get('leads', auditTicketId)
  ok(auditClosed.ticketState === TICKET_STATE.INVALID && auditClosed.status === LEAD_STATUS.CLOSED &&
    auditClosed.auditResult === '通过', '审核通过后审核工单自动收尾',
  JSON.stringify({ state: auditClosed.ticketState, status: auditClosed.status, result: auditClosed.auditResult }))

  /* 委托方发起的咨询工单：代采代售咨询按 agencyId 一对一关联 */
  const P3_LEAD = 'ld_p3_flow'
  await repo.insert('leads', {
    id: P3_LEAD, uid: BUYER.openid, targetType: 'agency', targetId: pub.data.id, agencyId: pub.data.id,
    agencyTitle: '代售 H200 141G', agencySide: 'sell', status: LEAD_STATUS.PENDING,
    csStatus: '待领取', csClaimedAt: 0, assignedTo: '', assignedAccount: '', threadId: P3_LEAD,
    createdAt: CLOCK, updatedAt: CLOCK
  })

  /* 合同审核通过前允许多家对接：同一商机的第二条领取 / 工单 */
  const RIVAL3 = { openid: 'o_p3_rival' }
  await call(userRouter, 'auth.login', { nick: '流程竞争方' }, RIVAL3)
  const RIVAL_LEAD = 'ld_p3_rival'
  const RIVAL_CLAIM = 'bc' + sha256Hex(`${RIVAL3.openid}:agency:${pub.data.id}`).slice(0, 24)
  await repo.insert('leads', {
    id: RIVAL_LEAD, uid: RIVAL3.openid, targetType: 'agency', targetId: pub.data.id, agencyId: pub.data.id,
    agencyTitle: '代售 H200 141G', agencySide: 'sell', status: LEAD_STATUS.PENDING,
    csStatus: '待领取', csClaimedAt: 0, assignedTo: '', assignedAccount: '', threadId: RIVAL_LEAD,
    ticketState: TICKET_STATE.TICKETED, serviceStage: 'communicating', stageAt: CLOCK, stageVersion: 0,
    createdAt: CLOCK, updatedAt: CLOCK
  })
  await repo.insert('bizClaims', {
    id: RIVAL_CLAIM, uid: RIVAL3.openid, targetType: 'agency', targetId: pub.data.id, at: CLOCK
  })

  const earlyDetail = await call(adminRouter, 'consult.detail', { leadId: P3_LEAD }, csCtxP3)
  ok(!earlyDetail.ok && earlyDetail.code === 'FORBIDDEN', '未领取的咨询不能查看标准流程详情')
  const earlyTerms = await call(adminRouter, 'consult.terms', { leadId: P3_LEAD, amount: 300000 }, csCtxP3)
  ok(!earlyTerms.ok, '未领取的咨询不能确认条件')

  /* 用户咨询提交即生成工单：未领取的工单直接进入工单中心「待领取」分栏 */
  const listUnclaimed = await call(adminRouter, 'consult.list', { tab: 'all' }, csCtxP3)
  const unclaimedRow = (listUnclaimed.data.items || []).find((it) => it.leadId === P3_LEAD)
  ok(listUnclaimed.ok && !!unclaimedRow && unclaimedRow.unclaimed === true && unclaimedRow.stageLabel === '待领取',
    '待领取的咨询直接进入工单中心', JSON.stringify((listUnclaimed.data || {}).counts))

  const unclaimedTab = await call(adminRouter, 'consult.list', { tab: 'unclaimed' }, csCtxP3)
  ok(unclaimedTab.ok && (unclaimedTab.data.items || []).some((it) => it.leadId === P3_LEAD),
    '工单中心提供「待领取」分栏，未领取工单可在此领取')

  const claim = await call(adminRouter, 'lead.claim', { leadId: P3_LEAD }, csCtxP3)
  ok(claim.ok, '客服领取咨询')
  const listAfterClaim = await call(adminRouter, 'consult.list', { tab: 'communicating' }, csCtxP3)
  ok(listAfterClaim.ok && (listAfterClaim.data.items || []).some((it) => it.leadId === P3_LEAD),
    '领取后工单归入沟通中分栏')
  const leadClaimed = await repo.get('leads', P3_LEAD)
  ok(leadClaimed.serviceStage === 'communicating' && leadClaimed.assignedAccount === 'cs',
    '领取后工单初始化为沟通中并归属领用人')
  /* 同一委托统一归口：领取时把同委托下其他未分配的咨询工单一并接入，避免多个客服分别对接 */
  const rivalAdopted = await repo.get('leads', RIVAL_LEAD)
  ok(claim.data.adopted >= 1 && rivalAdopted.assignedAccount === 'cs' &&
    rivalAdopted.csStatus === CS_STATUS.SERVING && rivalAdopted.csClaimedAt > 0,
  '同一委托的其他工单自动归属同一客服', JSON.stringify({ adopted: claim.data.adopted, account: rivalAdopted.assignedAccount }))

  /* 新工单先对话：领取后不直接出现「确认满足条件」，双方聊过之后才出现 */
  const detailNoChat = await call(adminRouter, 'consult.detail', { leadId: P3_LEAD }, csCtxP3)
  ok(detailNoChat.ok && detailNoChat.data.chatStarted === false && detailNoChat.data.actions.canTerms === false,
    '新工单领取后先对话，不出现「确认满足条件」')
  await repo.insert('outbox', {
    id: 'M_p3_staff_chat',
    type: 'kf.chat',
    payload: {
      uid: BUYER.openid, channel: 'kf', from: 'staff', threadId: P3_LEAD,
      targetType: 'agency', targetId: pub.data.id, title: '咨询验机', body: '在的，可以安排验机'
    },
    status: 'read',
    createdAt: CLOCK + 10
  })
  const detailStaffOnly = await call(adminRouter, 'consult.detail', { leadId: P3_LEAD }, csCtxP3)
  ok(detailStaffOnly.ok && detailStaffOnly.data.chatStarted === false && detailStaffOnly.data.actions.canTerms === false,
    '只有客服发言不算对话，继续等用户回复')
  /* 用户提交的咨询内容在领取时随工单落库，本身就是用户说过的话：
     不能因为早于领取时间就忽略，否则客服回完消息仍看不到「确认满足条件」 */
  await repo.updateWhere('leads', { id: P3_LEAD }, { intakeBody: '想采购 8 卡 H200，预算 30 万' })
  const detailIntake = await call(adminRouter, 'consult.detail', { leadId: P3_LEAD }, csCtxP3)
  ok(detailIntake.ok && detailIntake.data.chatStarted === true && detailIntake.data.actions.canTerms === true,
    '用户咨询内容 + 客服回复即视为已对话，工单不会卡在沟通中')
  await repo.updateWhere('leads', { id: P3_LEAD }, { intakeBody: '' })
  await repo.insert('outbox', {
    id: 'M_p3_user_chat',
    type: 'kf.chat',
    payload: {
      uid: BUYER.openid, channel: 'kf', from: 'user', threadId: P3_LEAD,
      targetType: 'agency', targetId: pub.data.id, title: '咨询验机', body: '好的，什么价格'
    },
    status: 'read',
    createdAt: CLOCK + 20
  })
  const detailChatted = await call(adminRouter, 'consult.detail', { leadId: P3_LEAD }, csCtxP3)
  ok(detailChatted.ok && detailChatted.data.chatStarted === true && detailChatted.data.actions.canTerms === true,
    '双方对话之后才出现「确认满足条件」，随后进入居间合同')

  /* 管理员在委托单列表就能看到咨询作业走到第几步，不必点进咨询工单 */
  const agencyWithConsult = await call(adminRouter, 'agency.list', {}, csCtxP3)
  const agencyRow = (agencyWithConsult.data.items || []).find((it) => it.id === pub.data.id)
  ok(agencyWithConsult.ok && !!agencyRow && agencyRow.consultStage === 'communicating' &&
    agencyRow.consultStageLabel === '沟通中' && !!agencyRow.consultCsName,
    '委托单列表带出咨询作业进度与归属客服', JSON.stringify(agencyRow && { stage: agencyRow.consultStage, label: agencyRow.consultStageLabel }))

  /* 消息中心会话带出委托上下文：客服在聊天里即可看到进度并一键进入委托工单 */
  await repo.insert('outbox', {
    id: 'M_p3_chat_ctx',
    type: 'kf.chat',
    payload: {
      uid: BUYER.openid,
      channel: 'kf',
      from: 'user',
      body: '这台 H200 还在吗',
      threadId: P3_LEAD,
      targetType: 'agency',
      targetId: pub.data.id,
      targetTitle: '代售 H200 141G'
    },
    status: 'pending',
    readByUser: true,
    createdAt: CLOCK
  })
  /* 同一委托被另一位用户也咨询过：消息中心必须按会话 uid 取自己的咨询单，不能串号 */
  const ownLead = await repo.get('leads', P3_LEAD)
  await repo.insert('leads', Object.assign({}, ownLead, {
    id: 'LD_p3_decoy',
    uid: 'o_p3_decoy',
    status: LEAD_STATUS.CLOSED,
    csStatus: CS_STATUS.ENDED,
    updatedAt: CLOCK + 1,
    createdAt: CLOCK
  }))
  const threads = await call(adminRouter, 'msg.threads', {}, csCtxP3)
  const threadRow = (threads.data.items || []).find((t) => t.uid === BUYER.openid)
  ok(threads.ok && !!threadRow && threadRow.leadId === P3_LEAD && threadRow.consultStage === 'communicating' &&
    threadRow.consultStageLabel === '沟通中',
    '消息中心会话带出委托工单与当前步骤',
    JSON.stringify(threadRow && { leadId: threadRow.leadId, stage: threadRow.consultStage }))

  const detail = await call(adminRouter, 'consult.detail', { leadId: P3_LEAD }, csCtxP3)
  ok(detail.ok && detail.data.stage === 'communicating' && !!detail.data.agency && !!detail.data.parties,
    '详情返回左对话右委托与双方联系方式结构')
  ok(detail.data.parties.consult.masked === true && detail.data.parties.owner.masked === true,
    '双方联系方式默认脱敏，需单独调阅', JSON.stringify(detail.data.parties))

  const terms = await call(adminRouter, 'consult.terms', {
    leadId: P3_LEAD, amount: 300000, delivery: '杭州面交', payment: '对公转账', condition: '验机合格后付款'
  }, csCtxP3)
  ok(terms.ok && terms.data.stage === 'terms' && terms.data.terms.amount === 300000,
    '确认条件后进入条件已确认阶段')

  const skipContract = await call(adminRouter, 'consult.proposeDeal', { leadId: P3_LEAD, amount: 300000 }, csCtxP3)
  ok(!skipContract.ok && skipContract.code === 'CONFLICT', '未上传居间合同不能登记成交')

  const noSignDate = await call(adminRouter, 'consult.contractSubmit', {
    leadId: P3_LEAD, fileId: 'https://cdn.example.com/ct-v1.pdf', fileName: '居间合同.pdf'
  }, csCtxP3)
  ok(!noSignDate.ok && noSignDate.code === 'VALIDATION', '上传合同必须填写签约日期')

  const contract = await call(adminRouter, 'consult.contractSubmit', {
    leadId: P3_LEAD, fileId: 'https://cdn.example.com/ct-v1.pdf', fileName: '居间合同.pdf', signDate: '2026-02-26'
  }, csCtxP3)
  ok(contract.ok && contract.data.stage === 'contract' && contract.data.version === 1,
    '客服上传合同扫描件后进入合同待审核')

  const selfReview = await call(adminRouter, 'contract.review', { leadId: P3_LEAD, decision: 'approve' }, csCtxP3)
  ok(!selfReview.ok && selfReview.code === 'FORBIDDEN', '客服不能自己审核居间合同')

  /* 唯一对接方在「居间合同已上传、待审核」时由管理员手动确定，不再由审核通过自动锁定 */
  const earlyReview = await call(adminRouter, 'contract.review', { leadId: P3_LEAD, decision: 'approve' }, adminCtxP3)
  ok(!earlyReview.ok && earlyReview.code === 'CONFLICT', '未确定唯一对接方时不能审核通过居间合同',
    JSON.stringify(earlyReview))

  /* 跟进客服可一键结束同委托的其他对接；管理员审批时也能确定，重复提交保持幂等 */
  const lock = await call(adminRouter, 'contract.lock', { leadId: P3_LEAD }, csCtxP3)
  ok(lock.ok && lock.data.locked === true && lock.data.closedOthers === 1 &&
    lock.data.agencyStatus === '已锁定' && lock.data.stage === 'contract',
  '合同待审核时客服一键确定唯一对接方，结束其他 1 家对接', JSON.stringify(lock.data))
  const lockAgain = await call(adminRouter, 'contract.lock', { leadId: P3_LEAD }, adminCtxP3)
  ok(lockAgain.ok && lockAgain.data.already === true && lockAgain.data.closedOthers === 0,
    '管理员重复确定唯一对接方保持幂等', JSON.stringify(lockAgain.data))

  /* 合同归档即退出商机池：唯一对接方锁定，其余对接方工单关闭并清理领取记录 */
  const lockedAgency = await repo.get('agencies', pub.data.id)
  ok(lockedAgency.status === '已锁定' && lockedAgency.claimUid === BUYER.openid &&
    lockedAgency.lockedLeadId === P3_LEAD && lockedAgency.lockedAt > 0,
  '确定唯一对接方后委托改为已锁定并记录对接工单', JSON.stringify(lockedAgency && {
    status: lockedAgency.status, claimUid: lockedAgency.claimUid, lockedLeadId: lockedAgency.lockedLeadId
  }))
  const rivalLeadAfter = await repo.get('leads', RIVAL_LEAD)
  ok(rivalLeadAfter.status === LEAD_STATUS.CLOSED && rivalLeadAfter.ticketState === TICKET_STATE.INVALID &&
    rivalLeadAfter.csStatus === CS_STATUS.ENDED && rivalLeadAfter.serviceStage === 'aborted',
  '其余对接方工单自动关闭并置为无效（阶段同步终止）', JSON.stringify(rivalLeadAfter && {
    status: rivalLeadAfter.status, ticketState: rivalLeadAfter.ticketState,
    csStatus: rivalLeadAfter.csStatus, stage: rivalLeadAfter.serviceStage
  }))
  const rivalClaimAfter = await repo.get('bizClaims', RIVAL_CLAIM)
  ok(!rivalClaimAfter, '其余对接方的领取记录随工单关闭一并清理')
  const soldMsgs = await repo.find('outbox', {})
  ok(soldMsgs.some((m) => m.type === 'kf.chat' && m.payload && m.payload.uid === RIVAL3.openid &&
    String(m.payload.body || '').indexOf('已售出') > -1),
  '被结束的对接方收到「商品已售出」系统消息')
  const rivalConsultLocked = await call(userRouter, 'biz.consult', { agencyId: pub.data.id }, RIVAL3)
  ok(!rivalConsultLocked.ok && rivalConsultLocked.code === 'CONFLICT' &&
    String(rivalConsultLocked.message || '').includes('锁定'),
  '锁定后其他会员不能再申请对接', JSON.stringify(rivalConsultLocked))

  /* 同一委托咨询 / 对接人数：工单列表卡片与详情都能直接看到 */
  const listStats = await call(adminRouter, 'consult.list', { tab: 'all' }, adminCtxP3)
  const statRow = (listStats.data.items || []).find((it) => it.leadId === P3_LEAD)
  ok(listStats.ok && !!statRow && statRow.consultTotal >= 3 && statRow.consultActive === 1,
    '工单列表带出同一委托的咨询 / 对接人数', JSON.stringify(statRow && {
      total: statRow.consultTotal, active: statRow.consultActive
    }))
  const detailLocked = await call(adminRouter, 'consult.detail', { leadId: P3_LEAD }, adminCtxP3)
  ok(detailLocked.ok && detailLocked.data.agencyThreads.total >= 3 &&
    detailLocked.data.agencyThreads.active === 1 && detailLocked.data.agencyThreads.isLockedLead === true &&
    (detailLocked.data.peers || []).some((p) => p.current && p.locked) &&
    (detailLocked.data.peers || []).some((p) => p.stage === 'closed'),
  '工单详情显示同委托各单的客服、阶段与唯一对接方', JSON.stringify(detailLocked.data && detailLocked.data.agencyThreads))

  const contractOk = await call(adminRouter, 'contract.review', { leadId: P3_LEAD, decision: 'approve' }, adminCtxP3)
  ok(contractOk.ok && contractOk.data.status === '已归档' && contractOk.data.stage === 'signed' &&
    contractOk.data.agencyLocked === true,
    '确定唯一对接方后审核通过：合同归档、工单进入已签约')
  const listSigned = await call(adminRouter, 'consult.list', { tab: 'contract' }, csCtxP3)
  ok(listSigned.ok && (listSigned.data.items || []).some((it) => it.leadId === P3_LEAD),
    '已签约工单仍归入合同进度分栏')

  /* 平台直接确认成交：客服登记后委托立即成交、账单生成，委托方只收通知 */
  const deal = await call(adminRouter, 'consult.proposeDeal', { leadId: P3_LEAD, amount: 300000 }, csCtxP3)
  ok(deal.ok && deal.data.stage === 'fee', '客服登记成交后工单直接进入服务费待支付')
  const dealAgain = await call(adminRouter, 'consult.proposeDeal', { leadId: P3_LEAD, amount: 300000 }, csCtxP3)
  ok(!dealAgain.ok && dealAgain.code === 'CONFLICT', '已登记成交的工单不能重复登记')
  const p3Bills = await repo.find('payments', { agencyId: pub.data.id })
  ok(p3Bills.length === 1, `同一委托只生成一张服务费账单（实际 ${p3Bills.length} 张）`)
  const agencyDealt = await repo.get('agencies', pub.data.id)
  ok(agencyDealt.status === '已成交' && agencyDealt.dealCsId === 'cs' &&
    agencyDealt.dealConfirmedAt > 0 && agencyDealt.dealConfirmedBy !== '',
  '委托单由平台直接确认成交，并记录确认客服')
  const dealNotice = await repo.find('outbox', {})
  ok(dealNotice.some((m) => m.payload && m.payload.uid === OWNER.openid &&
    String(m.payload.title || '').indexOf('已成交') > -1), '委托方收到成交通知（无需确认）')

  const progress = await call(userRouter, 'consult.progress', { id: pub.data.id }, OWNER)
  ok(progress.ok && progress.data.stage === 'fee' &&
    progress.data.actions.indexOf('dealConfirm') < 0 &&
    progress.data.actions.indexOf('payProof') > -1 &&
    progress.data.contract.status === '已归档',
    '委托方在小程序看到进度与付款入口，不再有成交确认入口', JSON.stringify(progress.data))
  const billId = `PY_AG_${pub.data.id}`
  const bill = await repo.get('payments', billId)
  ok(!!bill && bill.amount === 3000 && bill.status === '待确认',
    '服务费账单按 1% 生成（30 万 → 3000）', JSON.stringify(bill && { amount: bill.amount, status: bill.status }))

  const noProof = await call(userRouter, 'agency.payProof', { id: pub.data.id, files: [] }, OWNER)
  ok(!noProof.ok && noProof.code === 'VALIDATION', '未上传凭证不能提交打款')
  const proof = await call(userRouter, 'agency.payProof', {
    id: pub.data.id, files: ['https://cdn.example.com/pay.jpg'], note: '已对公转账'
  }, OWNER)
  ok(proof.ok && proof.data.files.length === 1, '委托方上传服务费打款凭证')
  const billProof = await repo.get('payments', billId)
  ok(billProof.proofFiles.length === 1 && billProof.proofBy === OWNER.openid,
    '打款凭证写入账单并记录上传人')

  const adminProof = await call(adminRouter, 'consult.uploadProof', {
    leadId: P3_LEAD, files: ['https://cdn.example.com/bank.jpg'], fileName: '银行回单.jpg'
  }, csCtxP3)
  ok(adminProof.ok, '客服可追加银行回单')
  const fileUrls = await call(adminRouter, 'consult.fileUrls', { leadId: P3_LEAD }, csCtxP3)
  ok(fileUrls.ok && fileUrls.data.urls['https://cdn.example.com/bank.jpg'] === 'https://cdn.example.com/bank.jpg',
    '合同与凭证可换取临时链接', JSON.stringify(fileUrls.data))

  /* 服务费到账由财务角色确认（需求文档：财务确认到账） */
  const finDemo = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'finance')
  const finLogin = await call(adminRouter, 'admin.login', {
    username: 'finance', password: finDemo.password, otp: generateTotp(finDemo.totpSecret, now())
  }, {})
  const feeConfirm = await call(adminRouter, 'payment.feeConfirm', { id: billId, received: 3000 },
    { token: finLogin.data.token })
  ok(feeConfirm.ok, '财务确认服务费到账')
  const leadPaid = await repo.get('leads', P3_LEAD)
  ok(leadPaid.serviceStage === 'paid', '到账后工单进入服务费已到账')
  const comms = await repo.find('csAgencyCommissions', { paymentId: billId }, { limit: 5 })
  ok(comms.length === 1 && comms[0].csId === 'cs' && comms[0].commission === 600,
    '按服务费实收 20% 计提客服佣金 600', JSON.stringify(comms))
  const salaryP3 = await call(adminRouter, 'cs.salary', {}, csCtxP3)
  ok(salaryP3.ok && salaryP3.data.agencyCommission === 1600,
    '工作台工资包含本单佣金（1000 + 600）', JSON.stringify(salaryP3.data))

  const complete = await call(adminRouter, 'consult.complete', { leadId: P3_LEAD, note: '服务完成' }, csCtxP3)
  ok(complete.ok && complete.data.stage === 'done', '客服确认完成（服务费到账后唯一的收尾动作）')
  const agencyArchived = await repo.get('agencies', pub.data.id)
  ok(agencyArchived.status === '已完成' && agencyArchived.completedAt > 0 &&
    agencyArchived.completedBy !== '', '确认完成时委托同步归档（已完成 + 完成时间/人）')
  const leadClosed = await repo.get('leads', P3_LEAD)
  ok(leadClosed.status === LEAD_STATUS.CLOSED && leadClosed.csStatus === CS_STATUS.ENDED &&
    leadClosed.csEndedAt > 0, '确认完成后工单真正闭合（已关闭 + 已结束 + 结束时间）',
    JSON.stringify({ status: leadClosed.status, csStatus: leadClosed.csStatus, csEndedAt: leadClosed.csEndedAt }))
  const endMsgs = await repo.find('outbox', {})
  ok(endMsgs.some((m) => m.type === 'kf.chat' && m.payload && m.payload.uid === BUYER.openid &&
    m.payload.askRating === true), '工单闭合后用户收到服务评价提醒')
  const csStats = await call(adminRouter, 'cs.settings', {}, csCtxP3)
  const csStatRow = (csStats.data.items || []).find((it) => it.csId === leadClosed.assignedAccount)
  ok(csStats.ok && !!csStatRow && Number(csStatRow.stats.endedCount) >= 1,
    '客服档案已结束工单数随工单闭合累加',
    JSON.stringify(csStatRow && csStatRow.stats && { ended: csStatRow.stats.endedCount }))

  /* 已完成 / 已终止的工单不再占用工作台，统一回到「代采代售」按工单状态筛选 */
  const benchDone = await call(adminRouter, 'consult.list', { tab: 'all', page: 1, limit: 100 }, adminCtxP3)
  ok(benchDone.ok && !(benchDone.data.items || []).some((row) => row.leadId === P3_LEAD),
    '工作台只显示进行中的工单（已完成的工单不再出现）')
  const agencyDone = await call(adminRouter, 'agency.list', { consult: 'done', page: 1, limit: 50 }, adminCtxP3)
  ok(agencyDone.ok && (agencyDone.data.items || []).some((row) => row.id === pub.data.id && row.consultState === 'done'),
    '代采代售可按「工单已完成」筛选')
  const agencyActive = await call(adminRouter, 'agency.list', { consult: 'active', page: 1, limit: 50 }, adminCtxP3)
  ok(agencyActive.ok && !(agencyActive.data.items || []).some((row) => row.id === pub.data.id),
    '按「工单进行中」筛选时不包含已完成工单')
  const agencySorted = await call(adminRouter, 'agency.list', { sort: 'created_asc', page: 1, limit: 50 }, adminCtxP3)
  const sortedTimes = (agencySorted.data.items || []).map((row) => Number(row.createdAt) || 0)
  ok(agencySorted.ok && sortedTimes.every((ms, i) => i === 0 || ms >= sortedTimes[i - 1]),
    '代采代售支持按提交时间排序')

  const contractFile = await call(userRouter, 'consult.contractFile', { id: pub.data.id }, OWNER)
  ok(contractFile.ok && contractFile.data.files.length === 1 &&
    contractFile.data.urls['https://cdn.example.com/ct-v1.pdf'] === 'https://cdn.example.com/ct-v1.pdf',
    '委托方签约后可查看合同扫描件')
  const otherFile = await call(userRouter, 'consult.contractFile', { id: pub.data.id }, { openid: 'o_not_mine' })
  ok(!otherFile.ok, '非委托方不能查看合同')

  /* 退款：佣金自动冲正、工资按当月扣回、委托单回到待支付 */
  const refund = await call(adminRouter, 'payment.refund', { id: billId, reason: '客户申请退回服务费' }, adminCtxP3)
  ok(refund.ok && refund.data.refunded, '服务费退款成功')
  const commsAfter = await repo.find('csAgencyCommissions', { paymentId: billId }, { limit: 5 })
  ok(commsAfter.length === 1 && commsAfter[0].status === '已冲正' && commsAfter[0].reversedCommission === 600,
    '退款自动冲正客服佣金 600', JSON.stringify(commsAfter))
  const salaryAfter = await call(adminRouter, 'cs.salary', {}, csCtxP3)
  ok(salaryAfter.ok && salaryAfter.data.agencyCommission === 1000, '冲正当月工资扣回该单佣金')
  ok((await repo.get('agencies', pub.data.id)).feeStatus === 'pending', '委托单服务费回到待支付')
  const refundedAgency = await repo.get('agencies', pub.data.id)
  const refundedLead = await repo.get('leads', P3_LEAD)
  ok(refundedAgency.status === '已成交' && !refundedAgency.completedAt && refundedAgency.completedBy === '',
    '已完成后退款：委托退回已成交并清空完成信息', JSON.stringify({ status: refundedAgency.status, completedAt: refundedAgency.completedAt }))
  ok(refundedLead.serviceStage === 'fee', '已完成后退款：工单退回服务费待支付')
  const reBills = await repo.find('payments', { agencyId: pub.data.id }, { limit: 5 })
  const reBill = reBills.filter((p) => p.status === '待确认')[0]
  const reAgency = await repo.get('agencies', pub.data.id)
  ok(!!reBill && reBill.id === `PY_AG_${pub.data.id}_2` && reAgency.feeBillId === reBill.id &&
    reBill.amount === 3000, '退款后按同号顺延重开待确认账单，可再次收款', JSON.stringify(reBills))
}

/* ============================================================
   40. 缓存一致性：举报处置后立即失效
   ============================================================ */
section('40. 缓存一致性：举报处置后立即失效')
{
  const { createCache } = require(path.join(shared, 'cache.js'))
  const cache = createCache({ env: {}, now })
  const cacheUser = createRouter({ repo, keys, scope: 'user', now, env: {}, cache })
  const cacheAdmin = createRouter({ repo, keys, scope: 'admin', now, env: {}, cache })

  const C_OWNER = { openid: 'o_cache_owner', ip: '10.9.0.1' }
  const C_VIEW = { openid: 'o_cache_viewer', ip: '10.9.0.2' }
  await call(cacheUser, 'auth.login', { nick: '缓存货主' }, C_OWNER)
  await call(cacheUser, 'auth.login', { nick: '缓存买家' }, C_VIEW)

  const pubC = await call(cacheUser, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: '缓存一致性验证 H100 整机',
    cat: 'GPU 服务器',
    brand: 'NVIDIA',
    model: 'H100 80G SXM',
    qty: 2,
    priceMode: 'fixed',
    price: 210000,
    supply: '现货',
    tax: ['含税'],
    city: '杭州',
    cond: '全新',
    deliver: '3 天内',
    must: ['接受同台互验']
  }, C_OWNER)
  ok(pubC.ok, '缓存用例商品发布成功', JSON.stringify(pubC))
  const productIdC = pubC.data.id

  const first = await call(cacheUser, 'product.detail', { id: productIdC }, C_VIEW)
  const second = await call(cacheUser, 'product.detail', { id: productIdC }, C_VIEW)
  ok(first.ok && second.ok && second.data.status === PRODUCT_STATUS.ON_SALE, '商品详情进入缓存')

  const repC = await call(cacheUser, 'report.create', {
    type: '举报',
    content: '商品实际配置与描述不一致，请核实',
    targetType: 'product',
    targetId: productIdC,
    targetTitle: '缓存一致性验证 H100 整机'
  }, C_VIEW)
  ok(repC.ok, '举报提交成功')

  const demoAdmin = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'admin')
  const adminLoginC = await call(cacheAdmin, 'admin.login', {
    username: demoAdmin.username,
    password: demoAdmin.password,
    otp: generateTotp(demoAdmin.totpSecret, now())
  }, {})
  const handledC = await call(cacheAdmin, 'report.handle', {
    id: repC.data.id, status: '已处理', note: '缓存联动验证，执行下架', targetAction: 'offline'
  }, { token: adminLoginC.data.token })
  ok(handledC.ok, '管理员处置举报并联动下架')

  const afterC = await call(cacheUser, 'product.detail', { id: productIdC }, C_VIEW)
  ok(!afterC.ok && afterC.code === 'NOT_FOUND', '处置后详情缓存立即失效（不再返回已下架商品）', JSON.stringify(afterC))
}

/* ============================================================
   41. 多级缓存：L2(Redis) 读写 / 版本隔离 / 故障降级 / 熔断
   ============================================================ */
section('41. 多级缓存：L2 读写 / 版本隔离 / 故障降级')
{
  const { createCache } = require(path.join(shared, 'cache.js'))

  /* 最小可用的 Redis 桩：只实现缓存层用到的 GET/SET EX/DEL/INCR/SCAN */
  const store = new Map()
  let redisCalls = 0
  const fakeRedis = {
    driver: 'fake',
    on() {},
    async get(key) {
      redisCalls += 1
      const value = store.get(key)
      return value === undefined ? null : value
    },
    async set(key, value, ...rest) {
      redisCalls += 1
      store.set(key, value)
      return 'OK'
    },
    async del(...keys) {
      redisCalls += 1
      const list = Array.isArray(keys[0]) ? keys[0] : keys
      list.forEach((k) => store.delete(k))
      return list.length
    },
    async incr(key) {
      redisCalls += 1
      const next = Number(store.get(key) || 0) + 1
      store.set(key, String(next))
      return next
    },
    async scan() {
      return ['0', []]
    }
  }

  const cacheA = createCache({ env: {}, now, redis: fakeRedis })
  const cacheB = createCache({ env: {}, now, redis: fakeRedis })

  await cacheA.set('demo:product', { price: 210000 }, 45)
  ok(store.has('demo:product'), '写入同时落 L2（Redis）')
  /* B 实例的 L1 为空，只能从 Redis 回读，验证跨进程共享 */
  const fromB = await cacheB.get('demo:product')
  ok(fromB && fromB.price === 210000, '另一实例 L1 未命中时从 L2 回读成功', JSON.stringify(fromB))
  ok(cacheB.stats().l2.hits >= 1, 'L2 命中计数递增', JSON.stringify(cacheB.stats().l2))
  ok(store.get('demo:product').indexOf('210000') >= 0, 'L2 存的是 JSON 序列化结果')

  const keyV0 = await cacheA.keyOf('user', 'products', 'hash')
  const bumped = await cacheA.bump('products')
  const keyV1 = await cacheB.keyOf('user', 'products', 'hash')
  ok(keyV0 === 'suanli:user:products:v0:hash', '缓存 key 含分组版本号', keyV0)
  ok(bumped === 1 && keyV1 === 'suanli:user:products:v1:hash', 'bump 后版本号写入 L2，另一实例立即读到新 key', keyV1)
  ok(keyV0 !== keyV1, '版本变化后旧 key 不再被命中（无需逐个删除）')

  await cacheA.del('demo:product')
  ok(!store.has('demo:product'), '删除同时清理 L1 与 L2')

  /* 故障降级：Redis 全部报错时业务仍然可用，连续失败后熔断 */
  let failCalls = 0
  const brokenRedis = {
    driver: 'broken',
    on() {},
    async get() { failCalls += 1; throw new Error('redis down') },
    async set() { failCalls += 1; throw new Error('redis down') },
    async del() { failCalls += 1; throw new Error('redis down') },
    async incr() { failCalls += 1; throw new Error('redis down') },
    async scan() { failCalls += 1; throw new Error('redis down') }
  }
  const cacheF = createCache({ env: {}, now, redis: brokenRedis })
  const degraded = await cacheF.wrap('biz:list', 30, async () => ({ rows: [1, 2, 3] }))
  ok(degraded && degraded.rows.length === 3, 'Redis 故障时 wrap 仍返回业务数据（自动降级 L1）')
  const degraded2 = await cacheF.wrap('biz:list', 30, async () => ({ rows: [] }))
  ok(degraded2.rows.length === 3, '降级后 L1 仍然生效，不会重复回源')
  for (let i = 0; i < 3; i += 1) await cacheF.get('miss:' + i)
  const statsF = cacheF.stats()
  ok(statsF.l2.breakerOpen === true, '连续失败达阈值后熔断，后续请求跳过 L2', JSON.stringify(statsF.l2))
  const before = failCalls
  await cacheF.get('miss:after-breaker')
  ok(failCalls === before, '熔断期内不再发起 Redis 请求（避免每个请求卡超时）', String(failCalls))
  ok(redisCalls > 0, '正常路径确实访问了 L2', String(redisCalls))
}

/* ============================================================
   42. 用户黑名单：私聊拦截 / 内容隐藏 / 黑名单管理
   ============================================================ */
section('42. 用户黑名单：私聊拦截 / 内容隐藏 / 黑名单管理')
{
  const BLK_A = { openid: 'o_block_a', ip: '10.9.0.1' }
  const BLK_B = { openid: 'o_block_b', ip: '10.9.0.2' }
  await call(userRouter, 'auth.login', { nick: '拉黑方' }, BLK_A)
  await call(userRouter, 'auth.login', { nick: '被拉黑方' }, BLK_B)

  /* 被拉黑方发布商品与资讯，作为「内容隐藏」的标的 */
  const bProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: '黑名单验证商品',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 2, minQty: 1, price: '98000', cond: '二手',
    tax: ['含税'], city: '北京', supply: '现货', deliver: '3 天内',
    must: [], nego: [], flow: []
  }, BLK_B)
  ok(bProduct.ok, '被拉黑方发布商品成功')
  const bNews = await call(userRouter, 'news.submit', {
    title: '黑名单验证资讯',
    content: '被拉黑方发布的资讯，用于验证拉黑后对拉黑者不可见。',
    city: '北京'
  }, BLK_B)
  ok(bNews.ok, '被拉黑方发布资讯成功')
  /* 被拉黑方的求购：求购列表 / 详情 / 商机池都需按拉黑关系过滤 */
  const bDemand = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY,
    title: '黑名单验证求购',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 2, budget: '95000', tax: ['含税'], city: '北京', supply: '现货'
  }, BLK_B)
  ok(bDemand.ok, '被拉黑方发布求购成功')
  /* 拉黑方库存与该求购匹配：验证商机池不会把被拉黑者的求购推给拉黑方 */
  await call(userRouter, 'stock.save', {
    cat: 'GPU 服务器', model: 'A100 80G', qty: 2, price: 90000, city: '北京'
  }, BLK_A)

  /* 拉黑方也发布一件商品：验证被拉黑方不能反过来发起私聊（双向静默） */
  const aProduct = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL,
    title: '拉黑方商品',
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 80G',
    qty: 2, minQty: 1, price: '99000', cond: '二手',
    tax: ['含税'], city: '北京', supply: '现货', deliver: '3 天内',
    must: [], nego: [], flow: []
  }, BLK_A)
  ok(aProduct.ok, '拉黑方发布商品成功')

  const selfBlock = await call(userRouter, 'block.add', { uid: BLK_A.openid }, BLK_A)
  ok(!selfBlock.ok && selfBlock.code === 'VALIDATION', '不能拉黑自己')

  const addBlock = await call(userRouter, 'block.add', { uid: BLK_B.openid }, BLK_A)
  ok(addBlock.ok && addBlock.data.blocked === true, '拉黑用户成功')
  const addAgain = await call(userRouter, 'block.add', { uid: BLK_B.openid }, BLK_A)
  ok(addAgain.ok && addAgain.data.blocked === true, '重复拉黑幂等（不产生第二条记录）')

  const blkList = await call(userRouter, 'block.list', {}, BLK_A)
  const blkRow = (blkList.data && blkList.data.items && blkList.data.items[0]) || {}
  ok(blkList.ok && blkList.data.total === 1 && blkRow.uid === BLK_B.openid, '黑名单列表返回已拉黑的用户')
  ok(!!blkRow.nick && !!blkRow.ownerKey, '黑名单条目返回昵称与货主键（供客户端展示 / 二次操作）')

  /* 商品：列表与详情都必须看不到，第三方不受影响 */
  const aProducts = await call(userRouter, 'product.list', { limit: 100 }, BLK_A)
  ok(!aProducts.data.items.some((it) => it.id === bProduct.data.id), '拉黑后在商品列表看不到对方商品')
  const aDetail = await call(userRouter, 'product.detail', { id: bProduct.data.id }, BLK_A)
  ok(!aDetail.ok && aDetail.code === 'NOT_FOUND', '拉黑后对方商品详情按不存在处理')
  const otherProducts = await call(userRouter, 'product.list', { limit: 100 }, USER3)
  ok(otherProducts.data.items.some((it) => it.id === bProduct.data.id), '拉黑只影响本人，第三方仍能看到该商品')

  /* 资讯：列表与详情同样过滤 */
  const aNews = await call(userRouter, 'news.list', {}, BLK_A)
  ok(!aNews.data.items.some((n) => n.id === bNews.data.id), '拉黑后在资讯列表看不到对方资讯')
  const aNewsDetail = await call(userRouter, 'news.detail', { id: bNews.data.id }, BLK_A)
  ok(!aNewsDetail.ok && aNewsDetail.code === 'NOT_FOUND', '拉黑后对方资讯详情按不存在处理')

  /* 求购：列表与详情同样过滤，不能从详情页绕过 */
  const aDemands = await call(userRouter, 'demand.list', { limit: 100 }, BLK_A)
  ok(!aDemands.data.items.some((it) => it.id === bDemand.data.id), '拉黑后在求购列表看不到对方求购')
  const aDemandDetail = await call(userRouter, 'demand.detail', { id: bDemand.data.id }, BLK_A)
  ok(!aDemandDetail.ok && aDemandDetail.code === 'NOT_FOUND', '拉黑后对方求购详情按不存在处理')

  /* 商机池：共享缓存取出后按浏览者过滤，不能从池子绕过屏蔽 */
  const aBiz = await call(userRouter, 'biz.list', {}, BLK_A)
  ok(!aBiz.data.items.some((it) => it.type === 'demand' && it.id === bDemand.data.id), '拉黑后商机池不出现对方求购')

  /* 主页：拉黑者打不开被拉黑者主页，避免从主页绕过 */
  const aHome = await call(userRouter, 'owner.home', { ownerKey: blkRow.ownerKey }, BLK_A)
  ok(!aHome.ok && aHome.code === 'NOT_FOUND', '拉黑后对方主页不可见')

  /* 私聊：双向静默，且回执中性不暴露「已被拉黑」 */
  const chatByBlocker = await call(userRouter, 'chat.open', { productId: bProduct.data.id, conds: [] }, BLK_A)
  ok(chatByBlocker.ok && chatByBlocker.data.chatReady === false &&
    chatByBlocker.data.receipt === '暂时无法与该用户发起私聊', '拉黑者不能向对方发起私聊（中性回执）')
  const chatByBlocked = await call(userRouter, 'chat.open', { productId: aProduct.data.id, conds: [] }, BLK_B)
  ok(chatByBlocked.ok && chatByBlocked.data.chatReady === false &&
    chatByBlocked.data.receipt === '暂时无法与该用户发起私聊', '被拉黑者也不能向拉黑者发起私聊（双向静默）')

  /* 移出：用客户端实际使用的 ownerKey 入口移出，恢复内容与私聊 */
  const removeByUid = await call(userRouter, 'block.remove', { uid: BLK_B.openid }, BLK_A)
  ok(removeByUid.ok && removeByUid.data.blocked === false, '移出黑名单成功')
  const addByOwnerKey = await call(userRouter, 'block.add', { ownerKey: blkRow.ownerKey }, BLK_A)
  ok(addByOwnerKey.ok && addByOwnerKey.data.blocked === true, '支持按货主键拉黑（客户端主页入口）')
  const removeByOwnerKey = await call(userRouter, 'block.remove', { ownerKey: blkRow.ownerKey }, BLK_A)
  ok(removeByOwnerKey.ok && removeByOwnerKey.data.blocked === false, '支持按货主键移出')

  const blkListEmpty = await call(userRouter, 'block.list', {}, BLK_A)
  ok(blkListEmpty.ok && blkListEmpty.data.total === 0, '移出后黑名单为空')
  const restoredProducts = await call(userRouter, 'product.list', { limit: 100 }, BLK_A)
  ok(restoredProducts.data.items.some((it) => it.id === bProduct.data.id), '移出后对方商品恢复可见')
  const restoredNews = await call(userRouter, 'news.list', {}, BLK_A)
  ok(restoredNews.data.items.some((n) => n.id === bNews.data.id), '移出后对方资讯恢复可见')
  const restoredDemands = await call(userRouter, 'demand.list', { limit: 100 }, BLK_A)
  ok(restoredDemands.data.items.some((it) => it.id === bDemand.data.id), '移出后对方求购恢复可见')
  const restoredBiz = await call(userRouter, 'biz.list', {}, BLK_A)
  ok(restoredBiz.data.items.some((it) => it.type === 'demand' && it.id === bDemand.data.id), '移出后商机池恢复显示对方求购')
  const restoredChat = await call(userRouter, 'chat.open', { productId: bProduct.data.id, conds: [] }, BLK_A)
  ok(restoredChat.ok && restoredChat.data.chatReady === true, '移出后恢复私聊')
}

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '─'.repeat(56))
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  · ' + f))
  process.exit(1)
}
process.exit(0)
