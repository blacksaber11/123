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
const { loadKeys, encryptField, blindIndex, generateTotp } = require(path.join(shared, 'crypto.js'))
const { verifyMaterialLink } = require(path.join(shared, 'files.js'))
const { buildProduct, buildDemand, judgeTier } = require(path.join(shared, 'domain.js'))
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
  const expOpen = await call(userRouter, 'profile.save', { nick: '张三', phone: '13800138000', realname: '张三', exposure: 'open' }, USER)
  ok(expOpen.ok && expOpen.data.exposure === 'open' && expOpen.data.exposureLabel === '公开主体', '可切换为「公开主体」')
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
  await call(userRouter, 'profile.save', { nick: '张三', realname: '张三', exposure: 'open' }, USER)
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
  ok(!csStats.ok && csStats.code === 'FORBIDDEN', '客服访问统计被拒（越权）')
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
  ok(!csReview.ok && csReview.code === 'FORBIDDEN', '客服不能审核商品（越权）')
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
  ok(!csService.ok && csService.code === 'FORBIDDEN', '客服访问服务记录被拒（越权）')

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
    subject: '链路采购有限公司', city: '上海'
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
    must: ['接受同台互验'], nego: [], flow: [],
    media: [{ name: '设备正面.png', type: 'image/png', size: 204800 }]
  }
  const pub = await call(userRouter, 'product.publish', baseProduct, OWNER)
  ok(pub.ok && pub.data.status === PRODUCT_STATUS.ON_SALE, '编辑用例商品已直接上架')
  const pid = pub.data.id

  const backfill = await call(userRouter, 'mine.publish.detail', { id: pid, kind: 'product' }, OWNER)
  ok(backfill.ok && backfill.data.id === pid, '属主可读取编辑回填数据')
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
  await call(userRouter, 'profile.save', { nick: '委托方', phone: '13900002222', realname: '赵敏', exposure: 'open' }, AGENT)
  await call(userRouter, 'auth.login', { nick: '库存方' }, SEEKER)
  await call(userRouter, 'profile.save', { nick: '库存方', phone: '13700003333', realname: '钱进' }, SEEKER)
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

  /* ①'' 1000 万元以上代采：不再免单，成交后按 0.5% 收；须亮明主体 + 资料齐全 + 授权书电话一致 */
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
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }
  await call(userRouter, 'profile.save', { nick: '大额委托方', phone: '13900002222', realname: '赵敏', exposure: 'hidden' }, BIGAGENT)
  const bigHidden = await call(userRouter, 'agency.submit', bigBase, BIGAGENT)
  ok(!bigHidden.ok && bigHidden.code === 'VALIDATION', '缺少授权书联系人电话时被拒绝')
  ok(String(bigHidden.message || '').includes('委托授权书'), '拒绝原因提示须填写授权书上的联系人电话',
    (bigHidden.ok ? '提交未被拒绝' : bigHidden.code + ': ' + bigHidden.message))

  await call(userRouter, 'profile.save', { nick: '大额委托方', phone: '13900002222', realname: '赵敏', exposure: 'hidden' }, BIGAGENT)
  const bigMissing = await call(userRouter, 'agency.submit', Object.assign({}, bigBase, {
    media: [{ name: 'license.pdf', kind: 'license' }]
  }), BIGAGENT)
  ok(!bigMissing.ok && String(bigMissing.message || '').includes('请补齐必传材料'), '缺少意向函 / 授权书 / 身份证时被拒绝')

  const bigMismatch = await call(userRouter, 'agency.submit', Object.assign({}, bigBase, { authPhone: '13800000000' }), BIGAGENT)
  ok(bigMismatch.ok, '授权书电话与联系人电话不一致不再拦截提交')
  const bigMismatchDoc = bigMismatch.ok ? await repo.get('agencies', bigMismatch.data.id) : {}
  ok(bigMismatchDoc.authPhoneMatched === false, '不一致仅落库标记，交由客服审核核验')
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
    city: '广州',
    subjectType: 'person',
    subject: '赵敏',
    idCard: '440101199001011234',
    phone: '13900002222',
    authPhone: '13900002222',
    media: [
      { name: 'auth.pdf', kind: 'authorization' },
      { name: 'idcard.jpg', kind: 'idcard' }
    ]
  }, AGENT)
  ok(agencyCancel.ok && agencyCancel.data.canCancel === true, '未缴费的委托可自助撤销')
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
  const csAgencyClose = await call(adminRouter, 'agency.close', { id: agencyPub.data.id }, csCtxMk)
  ok(!csAgencyClose.ok && csAgencyClose.code === 'FORBIDDEN', '客服关闭委托被拒（仅管理员）')

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

  /* 成交后账单业务类型为「租赁服务费」，金额等于委托方应承担的半个月租金 */
  await call(adminRouter, 'agency.review', { id: rentPub.data.id, decision: '通过' }, csCtxMk)
  await call(adminRouter, 'agency.close', {
    id: rentPub.data.id, dealt: true, dealAmount: 120000
  }, { token: adminToken })
  const rentDeal = await call(userRouter, 'agency.dealConfirm', { id: rentPub.data.id }, RENTAGENT)
  ok(rentDeal.ok && rentDeal.data.status === '已成交', '租赁委托确认成交')
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

  const boardSell = await call(userRouter, 'agency.board', {}, SEEKER)
  const sellRow = boardSell.data.items.find((i) => i.model === 'H100 80G SXM')
  ok(!!sellRow && sellRow.sellPrice === 230000, '现货盘聚合粘贴报价卖价')
  ok(!!sellRow && Number(sellRow.priceLevel) > 0 && !!sellRow.priceLevelText,
    '现货盘输出最终价格水平（货盘基准 + 报价）')
  ok(!!sellRow && Number(sellRow.priceLow) > 0 &&
    Number(sellRow.priceLow) <= Number(sellRow.priceHigh) && !!sellRow.confidenceText,
    '价格水平给出参考区间与置信度')

  const priceLevels = await call(adminRouter, 'price.levels', { limit: 50 }, csCtxMk)
  ok(priceLevels.ok && priceLevels.data.items.some((i) => i.model === 'H100 80G SXM' && i.priceLevel > 0),
    '管理端价格水平页可读取货盘定价结果')
  ok(priceLevels.ok && priceLevels.data.totals.withLevel >= 1, '价格水平汇总统计有数据')

  /* ③ 资讯：用户投稿自动筛查违禁词，通过即发布；下架仅管理员 */
  const newsSub = await call(userRouter, 'news.submit', {
    title: 'H100 现货行情周报',
    content: '本周 H100 整卡现货价格小幅回落，租赁需求稳定，建议按周锁价。',
    city: '深圳'
  }, SEEKER)
  ok(newsSub.ok && newsSub.data.status === '已发布', '资讯通过基础筛查后直接发布，无需人工审核')

  const userNews0 = await call(userRouter, 'news.list', {}, SEEKER)
  ok(userNews0.data.items.some((n) => n.title === 'H100 现货行情周报'), '发布后的资讯立即对用户可见')

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

  const userNews2 = await call(userRouter, 'news.list', {}, SEEKER)
  ok(!userNews2.data.items.some((n) => n.title === 'H100 现货行情周报'), '已下架资讯不再对外展示')

  const csNewsOffline = await call(adminRouter, 'news.offline', { id: newsSub.data.id, reason: '内容过期' }, csCtxMk)
  ok(!csNewsOffline.ok && csNewsOffline.code === 'FORBIDDEN', '客服下架资讯被拒（仅管理员）')

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

  const list0 = await call(userRouter, 'biz.list', {}, SEEKER)
  const mkItem0 = list0.data.items.find((i) => i.type === 'agency' && i.id === poolAgency.data.id)
  ok(!!mkItem0 && mkItem0.matched === true, '商机池按我的库存匹配出公开代售委托')
  /* 代采委托由平台代为对接、联系缴费，进入商机池但不可自助领取 */
  const buyItem0 = list0.data.items.find((i) => i.type === 'agency' && i.id === agencyPub.data.id)
  ok(!!buyItem0, '1000 万元以下的公开代采委托进入商机池')
  ok(!!buyItem0 && buyItem0.canClaim === false && buyItem0.contact === '平台代为对接',
    '代采委托由平台代为对接，不开放自助领取')
  ok(mkItem0.contactVisible === false && mkItem0.canClaim === false, '未开通时只能看到脱敏信息')
  /* 代采 / 代售只在商机池展示，不再提供普通信息流 */
  const feedSell = await call(userRouter, 'agency.feed', { side: 'sell' }, SEEKER)
  ok(!feedSell.ok && feedSell.code === 'NOT_FOUND', '代采 / 代售不再进入普通信息流')
  ok(!list0.data.items.some((i) => i.type === 'demand' && i.id === 'd_mk_open'),
    '库存不满足的求购不进入商机列表')

  const apply = await call(userRouter, 'biz.apply', { note: '需要查看联系方式' }, SEEKER)
  ok(apply.ok && apply.data.status === '待确认', '商机开通申请进入待确认')

  const csGrant = await call(adminRouter, 'biz.grant', { uid: SEEKER.openid, note: '微信收款 99 元' }, csCtxMk)
  ok(csGrant.ok && csGrant.data.status === '已开通', '客服确认收款后开通商机权限')
  const grantExpire = csGrant.data.expireAt
  ok(grantExpire === now() + 30 * 24 * 60 * 60 * 1000, '商机权限有效期 30 天')

  const status1 = await call(userRouter, 'biz.status', {}, SEEKER)
  ok(status1.ok && status1.data.unlocked === true, '开通后商机权限生效')

  /* 代采 / 代售均由平台代为对接并联系缴费，开通商机后也不开放自助领取 */
  const claim1 = await call(userRouter, 'biz.claim', { targetType: 'agency', agencyId: poolAgency.data.id }, SEEKER)
  ok(!claim1.ok && String(claim1.message || '').includes('平台代为对接'), '代售委托不支持自助领取，由平台对接缴费')
  const buyClaim = await call(userRouter, 'biz.claim', { targetType: 'agency', agencyId: agencyPub.data.id }, SEEKER)
  ok(!buyClaim.ok && String(buyClaim.message || '').includes('平台代为对接'), '代采委托不支持自助领取，由平台对接缴费')
  const listAgency1 = await call(userRouter, 'biz.list', {}, SEEKER)
  const agencyItem1 = listAgency1.data.items.find((i) => i.type === 'agency' && i.id === poolAgency.data.id)
  ok(!!agencyItem1 && agencyItem1.contact === '平台代为对接' && agencyItem1.contactVisible === false,
    '开通商机后委托仍显示「平台代为对接」，不下发联系方式')

  /* 代采 / 代售进商机池后只能「联系平台」：生成客服工单，平台核实后再推送采购方 */
  const consult1 = await call(userRouter, 'biz.consult', { agencyId: agencyPub.data.id }, SEEKER)
  ok(consult1.ok && consult1.data.consulted === true && consult1.data.already === false,
    '代采委托可提交平台对接申请')
  const consultLead = await repo.get('leads', consult1.data.leadId)
  ok(!!consultLead && consultLead.targetType === 'agency' && consultLead.status === LEAD_STATUS.PENDING,
    '对接申请生成待处理客服工单')
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
  const catClaim = await call(userRouter, 'biz.claim', { targetType: 'demand', demandId: 'd_mk_cat_only' }, SEEKER)
  ok(catClaim.ok && catClaim.data.already === false, '需求方未填型号时领取成功')

  /* 有权限但库存不匹配：仍不能领取需求联系方式 */
  await call(adminRouter, 'biz.grant', { uid: POOR.openid }, csCtxMk)
  const poorClaim = await call(userRouter, 'biz.claim', { targetType: 'demand', demandId: 'd_mk_open' }, POOR)
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

  const closed = await call(adminRouter, 'agency.close', { id: agencyPub.data.id, dealt: true, dealAmount: 250000 }, { token: adminToken })
  ok(closed.ok && closed.data.status === '待确认成交' && closed.data.dealAmount === 250000 &&
    closed.data.dealProposedAt > 0 && !!closed.data.dealProposedBy,
  '管理员发起成交后进入「待确认成交」，登记成交金额与处理人')

  /* 成交两步确认：平台发起 → 委托方确认，确认后才算成交并生成后付费账单 */
  const receiptBeforeDeal = await call(userRouter, 'agency.receipt', { id: agencyPub.data.id }, AGENT)
  ok(!receiptBeforeDeal.ok && receiptBeforeDeal.code === 'CONFLICT', '委托方未确认成交前不能确认收货')
  const dealByOther = await call(userRouter, 'agency.dealConfirm', { id: agencyPub.data.id }, SEEKER)
  ok(!dealByOther.ok && dealByOther.code === 'FORBIDDEN', '非委托方不能确认成交')
  const minePending = await call(userRouter, 'agency.mine', {}, AGENT)
  const pendingItem = minePending.data.items.find((i) => i.id === agencyPub.data.id)
  ok(!!pendingItem && pendingItem.canConfirmDeal === true && pendingItem.statusText === '待确认成交' &&
    pendingItem.flowNodes.some((n) => n.label === '待确认成交'), '我的委托详情带确认成交入口与流程节点')

  const dealConfirmed = await call(userRouter, 'agency.dealConfirm', { id: agencyPub.data.id }, AGENT)
  ok(dealConfirmed.ok && dealConfirmed.data.status === '已成交' && dealConfirmed.data.dealConfirmedAt > 0,
    '委托方确认后委托才算成交')
  ok(dealConfirmed.data.feeStatus === 'pending' && dealConfirmed.data.feeDueAt > 0 &&
    dealConfirmed.data.feeStatusText.indexOf('前到账') > -1, '成交后生成服务费账单并给出应到账日')
  const feeBill = (await repo.find('payments', { agencyId: agencyPub.data.id }, { limit: 1 }))[0]
  ok(!!feeBill && feeBill.amount === 400 && feeBill.bizType === '代采服务费' &&
    feeBill.status === '待确认', '后付费账单为待确认收款单，金额等于服务费')
  const workdayDue = dealConfirmed.data.feeDueAt
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

  const mineDealt = await call(userRouter, 'agency.mine', {}, AGENT)
  const dealtItem = mineDealt.data.items.find((i) => i.id === agencyPub.data.id)
  ok(!!dealtItem && dealtItem.canConfirmReceipt === true && !!dealtItem.dealAmountText &&
    dealtItem.progress.some((p) => p.key === 'dealt' && p.done), '成交后我的委托展示成交金额、确认收货入口与进度')
  const receipt = await call(userRouter, 'agency.receipt', { id: agencyPub.data.id }, AGENT)
  ok(receipt.ok && receipt.data.status === '已完成' && !!receipt.data.receiptText, '委托方确认收货后委托完成')
  ok(receipt.data.flowNodes.some((n) => n.label === '已成交') &&
    receipt.data.flowNodes.some((n) => n.label === '已完成') &&
    !JSON.stringify(receipt.data.flowNodes).includes('平台'), '流程节点按时间展示且不出现平台内部动作文案')
  const receiptAgain = await call(userRouter, 'agency.receipt', { id: agencyPub.data.id }, AGENT)
  ok(!receiptAgain.ok && receiptAgain.code === 'CONFLICT', '已完成委托不能重复确认收货')

  /* 财务确认服务费到账后回写委托单 */
  const paidBill = (await repo.find('payments', { agencyId: agencyPub.data.id }, { limit: 1 }))[0]
  const financeOk = await call(adminRouter, 'payment.confirm', { id: paidBill.id }, { token: adminToken })
  ok(financeOk.ok, '财务确认服务费到账')
  const feePaidDoc = await repo.get('agencies', agencyPub.data.id)
  ok(feePaidDoc.feeStatus === 'paid' && feePaidDoc.feePaidAt > 0,
    '收款单确认后回写委托单 feeStatus=paid 与到账时间')
  const minePaid = await call(userRouter, 'agency.mine', {}, AGENT)
  const paidItem = minePaid.data.items.find((i) => i.id === agencyPub.data.id)
  ok(!!paidItem && paidItem.feeStatusText === '已到账' && paidItem.flowNodes.some((n) => n.label === '已付款'),
    '我的委托展示服务费已到账与已付款节点')

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
  ok(expiredDetail.data.canConfirmDeal === false &&
    expiredDetail.data.flowNodes.some((n) => n.label === '已关闭'), '到期委托不再提供成交确认入口')

  /* 并发兜底：同一账号同时提交 10 条，进行中的委托不得超过 5 条 */
  const BURST = { openid: 'o_mk_agent_burst', ip: '10.20.0.9' }
  await call(userRouter, 'auth.login', { nick: '并发委托方' }, BURST)
  await call(userRouter, 'profile.save', { nick: '并发委托方', phone: '13500005555', realname: '周齐', exposure: 'open' }, BURST)
  const burstBase = {
    side: 'buy', mode: TRADE_MODES.BUY, rental: false, term: [], qty: 1, price: 20000,
    amount: 20000, detail: '并发提交校验', city: '深圳', subjectType: 'company',
    subject: '深圳并发算力有限公司', creditCode: '91440300MA5F99999X', legal: '周齐',
    phone: '13500005555', authPhone: '13500005555',
    deadline: beijingDateText(CLOCK + 30 * 86400000),
    media: [
      { name: 'license.pdf', kind: 'license' },
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

  /* 并发确认成交：同一委托只生成一张服务费账单 */
  const feeAgency = burst.filter((r) => r.ok)[0].data
  const burstConfirm = await call(adminRouter, 'agency.review', { id: feeAgency.id, decision: '通过' }, csCtxMk)
  ok(burstConfirm.ok && burstConfirm.data.status === '已上架', '并发用例的委托可正常审核上架' + (burstConfirm.ok ? '' : `（${burstConfirm.code} ${burstConfirm.message}）`))
  const burstClose = await call(adminRouter, 'agency.close', { id: feeAgency.id, dealt: true, dealAmount: 30000 }, { token: adminToken })
  ok(burstClose.ok && burstClose.data.status === '待确认成交', '并发用例的委托可正常发起成交' + (burstClose.ok ? '' : `（${burstClose.code} ${burstClose.message}）`))
  const burstDeals = await Promise.all([
    call(userRouter, 'agency.dealConfirm', { id: feeAgency.id }, BURST),
    call(userRouter, 'agency.dealConfirm', { id: feeAgency.id }, BURST)
  ])
  ok(burstDeals.some((r) => r.ok && r.data.status === '已成交'), '并发确认成交至少一次成功')
  const feeBills = await repo.find('payments', { agencyId: feeAgency.id })
  ok(feeBills.length === 1 && feeBills[0].amount === 299,
    `并发确认成交只生成一张服务费账单，金额按 3 万元档 299 元计（实际 ${feeBills.length} 张 / ${feeBills.map((b) => b.amount).join(',') || 0} 元）`)

  /* 进行中上限：已有 10 条进行中委托时，再提交应被拒绝且数量不增加 */
  const CAP = { openid: 'o_mk_agent_cap', ip: '10.20.0.10' }
  await call(userRouter, 'auth.login', { nick: '委托上限' }, CAP)
  await call(userRouter, 'profile.save', { nick: '委托上限', phone: '13500006666', realname: '吴限', exposure: 'open' }, CAP)
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
  await call(userRouter, 'profile.save', { nick: '浏览者一', phone: '13500001111', realname: '甲一', exposure: 'open' }, V1)
  await call(userRouter, 'auth.login', { nick: '浏览者二' }, V2)
  await call(userRouter, 'profile.save', { nick: '浏览者二', phone: '13500002222', realname: '乙二' }, V2)
  await call(userRouter, 'auth.login', { nick: '浏览者三' }, V3)
  await call(userRouter, 'profile.save', { nick: '浏览者三', phone: '13500003333', realname: '丙三' }, V3)

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
  const claimA = await call(userRouter, 'biz.claim', { targetType: 'demand', demandId: demandForClaim.data.id }, V2)
  const claimB = await call(userRouter, 'biz.claim', { targetType: 'demand', demandId: demandForClaim.data.id }, V3)
  ok(claimA.ok && claimB.ok, '同一商机可被多个用户分别领取' +
    (claimA.ok && claimB.ok ? '' : ' → ' + (claimA.message || 'A 无返回') + ' / ' + (claimB.message || 'B 无返回')))
  ok(!!(claimA.data && claimB.data) && claimA.data.id !== claimB.data.id, '每个用户有独立的领取记录')

  const claimA2 = await call(userRouter, 'biz.claim', { targetType: 'demand', demandId: demandForClaim.data.id }, V2)
  ok(claimA2.ok && claimA2.data.already === true && claimA2.data.id === claimA.data.id,
    '同一用户重复领取幂等，不产生第二条记录')
  ok(/已有\s*\d+\s*家领取/.test(String(claimA.data.claimText || '')), '领取响应返回领取人数（已有 N 家领取）')

  /* ⑦ 不设名额上限：只要是商机会员且库存匹配，多家都可以领取 */
  const V4 = { openid: 'o_ins_v4', ip: '10.30.0.4' }
  const V5 = { openid: 'o_ins_v5', ip: '10.30.0.5' }
  for (const buyer of [V4, V5]) {
    await call(userRouter, 'auth.login', { nick: '并发领取用户' }, buyer)
    await call(userRouter, 'profile.save', { nick: '并发领取用户', realname: '并发领取用户' }, buyer)
    await call(userRouter, 'stock.save', { cat: 'GPU 服务器', model: 'A100 40G', qty: 4, price: 90000, city: '上海' }, buyer)
    await call(adminRouter, 'biz.grant', { uid: buyer.openid }, { token: csTokenIns })
  }
  const claimThird = await call(userRouter, 'biz.claim', { targetType: 'demand', demandId: demandForClaim.data.id }, V4)
  ok(claimThird.ok, '第 3 家可正常领取（不设名额上限）')
  const claimFourth = await call(userRouter, 'biz.claim', { targetType: 'demand', demandId: demandForClaim.data.id }, V5)
  ok(claimFourth.ok, '第 4 家仍可领取，商机会员都可领取')

  const listAfterClaim = await call(userRouter, 'biz.list', {}, V5)
  const claimedRow = listAfterClaim.ok
    ? listAfterClaim.data.items.filter((it) => it.id === demandForClaim.data.id)[0]
    : null
  ok(!!claimedRow && claimedRow.claimCount >= 4 && claimedRow.canClaim === false,
    '商机列表回显领取人数，已领取用户不可重复领取')

  /* ⑧ 用户端囤货榜单：品类榜 / 型号榜 / 搜索最多商品 */
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
    ok(sent.ok, '用户给平台客服留言成功')
  }

  /* 没有任何线索的留言属于公共池：新用户找客服必须有人能接待 */
  const poolView = await call(adminRouter, 'msg.list', { uid: POOL.openid }, csChat)
  ok(poolView.ok, '公共池用户（无线索）：客服可查看会话')
  const poolThreads = await call(adminRouter, 'msg.threads', {}, csChat)
  ok(poolThreads.ok && poolThreads.data.items.some((t) => t.uid === POOL.openid), '公共池用户出现在客服会话列表')

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
  const mineView = await call(adminRouter, 'msg.list', { uid: MINE.openid }, csChat)
  ok(!mineView.ok && mineView.code === 'FORBIDDEN', '他人跟进后客服查看会话被拒')
  const mineReply = await call(adminRouter, 'msg.reply', { uid: MINE.openid, body: '你好' }, csChat)
  ok(!mineReply.ok && mineReply.code === 'FORBIDDEN', '他人跟进后客服回复被拒')
  const threadsAfter = await call(adminRouter, 'msg.threads', {}, csChat)
  ok(threadsAfter.ok && !threadsAfter.data.items.some((t) => t.uid === MINE.openid),
    '他人跟进的用户不再出现在客服会话列表')
  ok(threadsAfter.data.items.some((t) => t.uid === POOL.openid), '公共池用户仍保留在客服会话列表')

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

  const publicList = await call(userRouter, 'product.list', {}, VIEWER)
  ok(publicList.ok && publicList.data.items.some((p) => p.id === privateProduct.data.id),
    '保密商品内容仍在公共列表匿名展示（不隐藏内容）')
  ok(publicList.data.items.some((p) => p.id === defaultPub.data.id), '公共商品列表正常展示公开商品')

  const market = await call(userRouter, 'insights.market', {}, VIEWER)
  const boardIds = market.ok
    ? market.data.boards.reduce((acc, b) => acc.concat((b.items || []).map((i) => i.id)), [])
    : []
  ok(market.ok && boardIds.indexOf(privateProduct.data.id) < 0, '榜单 / 热度统计不包含保密商品')

  const sealed = await call(userRouter, 'product.detail', { id: privateProduct.data.id }, VIEWER)
  ok(sealed.ok && sealed.data.title === 'H200 内部保密价' && sealed.data.isPrivate === true,
    '非本人打开保密商品可看到完整内容')
  ok(sealed.data.contactHidden === true && !sealed.data.ownerPhone,
    '保密商品只隐藏主体与联系方式：不返回联系电话')
  ok(sealed.data.visibility === VISIBILITIES.PRIVATE && sealed.data.visibilityLabel === '保密',
    '保密商品详情带保密标识')

  const ownerView = await call(userRouter, 'product.detail', { id: privateProduct.data.id }, PUB)
  ok(ownerView.ok && ownerView.data.title === 'H200 内部保密价' && ownerView.data.isPrivate === true,
    '本人可查看保密商品完整详情')

  const staffView = await call(userRouter, 'product.detail', { id: privateProduct.data.id }, STAFF)
  ok(staffView.ok && staffView.data.title === 'H200 内部保密价', '平台角色可查看保密商品完整详情')

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
  ok(demandList.ok && demandList.data.items.some((d) => d.id === privateDemand.data.id),
    '保密需求内容仍在公共列表匿名展示')

  const demandSealed = await call(userRouter, 'demand.detail', { id: privateDemand.data.id }, VIEWER)
  ok(demandSealed.ok && demandSealed.data.title === '内部保密求购 H200' && demandSealed.data.contactHidden === true,
    '非本人打开保密需求可看到完整内容，但不给联系方式')

  const demandOwner = await call(userRouter, 'demand.detail', { id: privateDemand.data.id }, PUB)
  ok(demandOwner.ok && demandOwner.data.title === '内部保密求购 H200', '本人可查看保密需求完整详情')

  const demandStaff = await call(userRouter, 'demand.detail', { id: privateDemand.data.id }, STAFF)
  ok(demandStaff.ok && demandStaff.data.title === '内部保密求购 H200', '平台角色可查看保密需求完整详情')
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

  const catDisable = await call(adminRouter, 'catalog.save', {
    cat: 'GPU 服务器', brand: 'NVIDIA', series: '测试系列', model: '测试型号 X1', status: 'disabled'
  }, adminCtx)
  ok(catDisable.ok && catDisable.data.status === 'disabled', '平台可停用型号')

  const catTree2 = await call(userRouter, 'catalog.tree', {}, USER)
  ok(catTree2.data.items.some((i) => i.model === '测试型号 X1' && i.status === 'disabled'),
    '停用状态下发用户端用于移出滚轮')

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

  /* 小程序商机页读取同一份配置，扫码即可加企微开通 */
  const sitePublic = await call(userRouter, 'site.get', {}, { openid: 'o_usr_list', ip: '10.40.0.1' })
  ok(sitePublic.ok && sitePublic.data.site.qrUrl === png && sitePublic.data.site.planDays === 90,
    '小程序可读取企微活码与套餐口径')

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

  /* 收款登记 → 财务确认 → 自动开通并回填订单 */
  const pay = await call(adminRouter, 'payment.create', {
    uid, bizType: '会员续费', plan: 'month', amount: 99, method: '企业微信', note: '企微转账'
  }, adminCtx)
  ok(pay.ok && pay.data.status === '已确认' && !!pay.data.orderId, '收款登记即入账，会员续费自动开通并回填订单')
  const payConfirm = await call(adminRouter, 'payment.confirm', { id: pay.data.id }, adminCtx)
  ok(payConfirm.ok && payConfirm.data.status === '已确认' && !!payConfirm.data.orderId, '已入账收款单补确认保持幂等并保留订单号')
  const payList = await call(adminRouter, 'payment.list', { uid }, adminCtx)
  ok(payList.ok && payList.data.totals.confirmed >= 99 && payList.data.items[0].status === '已确认', '收款流水可按用户查询并汇总')
  const payBad = await call(adminRouter, 'payment.create', { uid, amount: 0 }, adminCtx)
  ok(!payBad.ok && payBad.code === 'VALIDATION', '收款金额为 0 被拒绝')
  const finance = await call(adminRouter, 'finance.summary', {}, adminCtx)
  ok(finance.ok && finance.data.totals.revenue === 0 && finance.data.months.length === 6,
    '财务汇总只统计微信端支付：手动开通 / 线下登记不计营收，仍返回近 6 个月趋势')
  const csDemo2 = DEMO_ADMIN_ACCOUNTS.find((a) => a.key === 'cs')
  const csLogin2 = await call(adminRouter, 'admin.login', {
    username: 'cs', password: csDemo2.password, otp: generateTotp(csDemo2.totpSecret, now())
  }, {})
  const csFinance = await call(adminRouter, 'finance.summary', {}, { token: csLogin2.data.token })
  ok(!csFinance.ok && csFinance.code === 'FORBIDDEN', '客服默认无权查看财务汇总')
  const csExpire = await call(adminRouter, 'biz.setExpire', { uid, expireAt }, { token: csLogin2.data.token })
  ok(!csExpire.ok && csExpire.code === 'FORBIDDEN', '客服默认无权修改会员到期时间')

  /* 日趋势与漏斗 */
  const trend = await call(adminRouter, 'stats.trend', { days: 30 }, adminCtx)
  ok(trend.ok && trend.data.series.length === 30 && trend.data.funnel.length === 4, '看板趋势返回 30 天序列与四级漏斗')
  const snapshot = await repo.find('dailyStats', {}, { limit: 5 })
  ok(snapshot.length >= 1, '当天快照写入 dailyStats')

  /* 风险单：四类视图 + 处置 */
  const cases = await call(adminRouter, 'risk.cases', { refresh: true }, adminCtx)
  ok(cases.ok && cases.data.counts.total >= 1 && cases.data.types.length === 5, '风险扫描生成商品 / 用户 / 咨询 / 对话 / 系统五类风险单')
  const one = cases.data.items[0]
  const handled = await call(adminRouter, 'risk.caseUpdate', {
    id: one.id, status: '已处理', owner: '风控 · 王工', action: '已核实', reason: '人工复核无风险'
  }, adminCtx)
  ok(handled.ok && handled.data.status === '已处理', '风险单可处置并留痕')

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

  /* 主体默认隐藏：不允许进入商机池，只能普通发布 */
  const hiddenPool = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '隐藏主体进池', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 10, budget: 260000, city: '深圳', supply: '现货', cond: '全新', bizPool: true
  }, PUB2)
  ok(!hiddenPool.ok && hiddenPool.code === 'VALIDATION' && String(hiddenPool.message).includes('商机池'),
    '主体隐藏时不能把需求放进商机池')

  await call(userRouter, 'profile.save', {
    nick: '商机发布者', realname: '发布者丙', phone: '13900006001', subject: '商机测试有限公司', exposure: 'open'
  }, PUB2)

  const poolPub = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '求购 10 台 H200', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 10, budget: 260000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税'], bizPool: true
  }, PUB2)
  ok(poolPub.ok && (await repo.get('demands', poolPub.data.id)).bizPool === true, '公开主体后需求可进入商机池', poolPub.message)

  const outPub = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '普通发布不进池', cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G',
    qty: 10, budget: 260000, city: '深圳', supply: '现货', cond: '全新', tax: ['含税'], bizPool: false
  }, PUB2)
  ok(outPub.ok && (await repo.get('demands', outPub.data.id)).bizPool === false, '发布方可关闭「进入商机池」', outPub.message)

  await call(userRouter, 'auth.login', { nick: '商机查看者' }, SEEK)
  await call(userRouter, 'stock.save', {
    cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H200 141G', qty: 15, price: 250000, city: '深圳'
  }, SEEK)

  /* 未开通会员：角标照常显示匹配数（开通前无法消除），列表锁定且全部脱敏，看不到榜单 */
  const badge = await call(userRouter, 'biz.badge', {}, SEEK)
  ok(badge.ok && badge.data.unlocked === false && Number(badge.data.count) >= 1,
    '未开通商机会员也显示商机角标', badge.message)
  const listLocked = await call(userRouter, 'biz.list', {}, SEEK)
  ok(listLocked.ok && listLocked.data.locked === true, '未开通商机会员时商机列表为锁定态')
  ok((listLocked.data.items || []).every((i) => i.masked === true && i.model === '****'),
    '未开通时商机内容全部脱敏')
  const lockIds = (listLocked.data.items || []).map((i) => i.id)
  ok(lockIds.indexOf(poolPub.data.id) >= 0 && lockIds.indexOf(outPub.data.id) < 0,
    '商机池只包含发布方允许进池的需求')
  const marketLocked = await call(userRouter, 'insights.market', { limit: 10 }, SEEK)
  ok(marketLocked.ok && marketLocked.data.locked === true && (marketLocked.data.boards || []).length === 0,
    '未开通会员拿不到热度榜单与供求关系')

  await call(adminRouter, 'biz.grant', { uid: SEEK.openid, note: '微信收款 99 元' }, { token: adminToken })

  /* 开通会员：可见匹配结果与必须条件；未进池的需求不可领取 */
  const listOpen = await call(userRouter, 'biz.list', {}, SEEK)
  ok(listOpen.ok && listOpen.data.locked === false, '开通商机后可查看商机信息')
  const openItem = (listOpen.data.items || []).filter((i) => i.id === poolPub.data.id)[0]
  ok(!!openItem && openItem.matched === true && Array.isArray(openItem.must),
    '开通后下发库存匹配结果与必须条件')
  const marketOpen = await call(userRouter, 'insights.market', { limit: 10 }, SEEK)
  ok(marketOpen.ok && marketOpen.data.locked !== true && Array.isArray(marketOpen.data.boards),
    '开通后可查看产品热度榜单与供求关系')

  /* 「我的商机」角标与列表只算已领取，不把商机池里可领取的也计进去 */
  const badgeBefore = await call(userRouter, 'biz.badge', {}, SEEK)
  ok(badgeBefore.ok && badgeBefore.data.claimed === 0, '「我的商机」角标统计已领取条数：领取前为 0')
  const claimPool = await call(userRouter, 'biz.claim', { targetType: 'demand', demandId: poolPub.data.id }, SEEK)
  ok(claimPool.ok, '商机会员可领取匹配的商机', claimPool.message)
  /* 领取即通知双方：领取方收到领取成功，发布方收到「被领取」提醒 */
  const claimNotices = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub.data.id
  }, { limit: 10 })
  const claimTo = claimNotices.map((n) => n.payload && n.payload.uid)
  ok(claimTo.indexOf(SEEK.openid) >= 0 && claimTo.indexOf(PUB2.openid) >= 0,
    '领取商机后领取方与发布方都收到站内消息', claimTo.join(' / '))
  const ownerNotice = claimNotices.filter((n) => n.payload && n.payload.uid === PUB2.openid)[0]
  ok(!!ownerNotice && ownerNotice.payload.title === '你的商机被领取',
    '发布方收到「你的商机被领取」提醒')
  await call(userRouter, 'biz.claim', { targetType: 'demand', demandId: poolPub.data.id }, SEEK)
  const claimNoticesAgain = await repo.find('outbox', {
    'payload.targetType': 'biz', 'payload.targetId': poolPub.data.id
  }, { limit: 10 })
  ok(claimNoticesAgain.length === claimNotices.length, '重复领取不重复发站内消息')
  const badgeAfter = await call(userRouter, 'biz.badge', {}, SEEK)
  ok(badgeAfter.ok && badgeAfter.data.claimed === 1,
    '领取后「我的商机」角标为已领取 1 条（不是可领取条数）',
    badgeAfter.ok ? `claimed=${badgeAfter.data.claimed} / count=${badgeAfter.data.count}` : badgeAfter.message)
  const mineList = await call(userRouter, 'biz.list', {}, SEEK)
  const mineClaimedIds = (mineList.data.items || []).filter((i) => i.claimed).map((i) => i.id)
  ok(mineClaimedIds.indexOf(poolPub.data.id) >= 0 && mineClaimedIds.indexOf(outPub.data.id) < 0,
    '「我的商机」列表只包含已领取的条目')

  const claimOut = await call(userRouter, 'biz.claim', { targetType: 'demand', demandId: outPub.data.id }, SEEK)
  ok(!claimOut.ok && claimOut.code === 'NOT_FOUND', '未进入商机池的需求不可领取')
}

/* ============================================================
   29. 商机匹配收敛：三渠道 / 反向货源 / 三榜
   ============================================================ */
section('29. 商机匹配收敛：三渠道 / 反向货源 / 三榜')
{
  const CH_PUB = { openid: 'o_chan_pub', ip: '10.61.0.1' }
  const CH_SEEK = { openid: 'o_chan_seek', ip: '10.61.0.2' }
  const CH_OTHER = { openid: 'o_chan_other', ip: '10.61.0.3' }
  for (const u of [CH_PUB, CH_SEEK, CH_OTHER]) {
    await call(userRouter, 'auth.login', { nick: '渠道测试用户' }, u)
  }
  await call(userRouter, 'profile.save', {
    nick: '渠道发布者', realname: '渠道发布者', phone: '13900007001',
    subject: '渠道测试有限公司', exposure: 'open', phonePublic: true
  }, CH_PUB)

  /* ① 仅商机：不进普通列表，非本人打不开详情 */
  const poolOnly = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: '仅商机 H200 货源', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H200 141G', qty: 20, price: 258000, cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货', channel: 'pool'
  }, CH_PUB)
  ok(poolOnly.ok && (await repo.get('products', poolOnly.data.id)).channel === 'pool', '可选择仅发布到商机', poolOnly.message)
  const pubList = await call(userRouter, 'product.list', { limit: 50 }, CH_OTHER)
  ok(pubList.ok && !pubList.data.items.some((i) => i.id === poolOnly.data.id), '仅商机的商品不出现在普通商品列表')
  const poolDetail = await call(userRouter, 'product.detail', { id: poolOnly.data.id }, CH_OTHER)
  ok(!poolDetail.ok && poolDetail.code === 'NOT_FOUND', '仅商机的商品非本人不可查看详情')
  const mineDetail = await call(userRouter, 'product.detail', { id: poolOnly.data.id }, CH_PUB)
  ok(mineDetail.ok, '发布者本人仍可查看仅商机商品')

  /* ② 仅普通：正常出现在普通列表，但不进商机池 */
  const normalOnly = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: '仅普通 A100 货源', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'A100 80G', qty: 6, price: 118000, cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货', channel: 'normal'
  }, CH_PUB)
  ok(normalOnly.ok && (await repo.get('products', normalOnly.data.id)).bizPool === false, '仅普通发布不进入商机池')
  const normalList = await call(userRouter, 'product.list', { limit: 50 }, CH_OTHER)
  ok(normalList.ok && normalList.data.items.some((i) => i.id === normalOnly.data.id), '仅普通商品正常出现在普通列表')

  /* ③ 二者都发：普通列表与商机池同时可见 */
  const bothPub = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: '双渠道 H200 货源', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H200 141G', qty: 30, price: 256000, cond: '全新',
    tax: ['含税'], city: '深圳', supply: '现货', channel: 'both'
  }, CH_PUB)
  const bothRaw = await repo.get('products', bothPub.data.id)
  ok(bothPub.ok && bothRaw.channel === 'both' && bothRaw.bizPool === true, '二者都发同时进入普通列表与商机池')
  const bothList = await call(userRouter, 'product.list', { limit: 50 }, CH_OTHER)
  ok(bothList.data.items.some((i) => i.id === bothPub.data.id), '二者都发的商品仍在普通列表')

  /* ④ 需求侧渠道：仅商机不进普通需求列表 */
  const poolDemand = await call(userRouter, 'demand.publish', {
    tradeMode: TRADE_MODES.BUY, title: '仅商机求购 H200', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H200 141G', qty: 5, budget: 250000, city: '深圳',
    supply: '现货', cond: '全新', tax: ['含税'], channel: 'pool'
  }, CH_PUB)
  ok(poolDemand.ok && (await repo.get('demands', poolDemand.data.id)).channel === 'pool', '需求可选择仅发布到商机', poolDemand.message)
  const demandList = await call(userRouter, 'demand.list', { limit: 50 }, CH_OTHER)
  ok(demandList.ok && !demandList.data.items.some((i) => i.id === poolDemand.data.id), '仅商机需求不出现在普通需求列表')

  /* ⑤ 反向货源：求购方无库存，别人货源命中自己的需求才出现 */
  await call(userRouter, 'profile.save', {
    nick: '商机求购方', realname: '商机求购方', phone: '13900007002', exposure: 'open'
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
  ok(revItems.every((i) => String(i.demandText || '').indexOf('匹配我的需求') === 0), '反向商机标注命中了我的哪条需求')
  ok(!revItems.some((i) => i.id === normalOnly.data.id), '仅普通发布的货源不进入商机池')
  ok(!(revList.data.items || []).some((i) => i.type === 'demand' && i.id === seekDemand.data.id),
    '自己发布的需求不会出现在自己的商机列表')

  /* ⑥ supply 领取：解锁货主联系方式，重复领取幂等 */
  const supplyClaim = await call(userRouter, 'biz.claim', { targetType: 'supply', supplyId: bothPub.data.id }, CH_SEEK)
  ok(supplyClaim.ok && !!supplyClaim.data.contact && !!supplyClaim.data.contact.phone,
    '领取匹配货源的商机后可获取联系方式', supplyClaim.message)
  const supplyClaim2 = await call(userRouter, 'biz.claim', { targetType: 'supply', supplyId: bothPub.data.id }, CH_SEEK)
  ok(supplyClaim2.ok && supplyClaim2.data.already === true, '重复领取同一货源幂等')
  const revAfter = await call(userRouter, 'biz.list', {}, CH_SEEK)
  const revItemAfter = (revAfter.data.items || []).filter((i) => i.id === bothPub.data.id)[0]
  ok(!!revItemAfter && revItemAfter.claimed === true && revItemAfter.contactVisible === true,
    '领取后商机列表回显联系方式可见')

  await call(adminRouter, 'biz.grant', { uid: CH_OTHER.openid, note: '无需求领取测试' }, { token: adminToken })
  const otherNoDemand = await call(userRouter, 'biz.claim', { targetType: 'supply', supplyId: bothPub.data.id }, CH_OTHER)
  ok(!otherNoDemand.ok && otherNoDemand.code === 'FORBIDDEN', '没有匹配求购时不能领取货源')

  /* ⑦ 三个榜单：需求榜 / 火热榜 / 供给榜 */
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
  const TODO_KEYS = ['leads', 'agency', 'unread', 'reports', 'risk', 'payments', 'total']
  ok(todos.ok && TODO_KEYS.every((k) => typeof todos.data[k] === 'number'),
    'admin.todos 返回 7 个数字键', todos.message)
  ok(todos.ok && todos.data.total === TODO_KEYS.filter((k) => k !== 'total')
    .reduce((sum, k) => sum + todos.data[k], 0), 'admin.todos.total 等于其余六项之和')

  const workbench = await call(adminRouter, 'workbench.data', { period: '7d' }, { token: adminToken })
  ok(workbench.ok && workbench.data.role === 'admin', 'workbench.data 返回当前角色', workbench.message)
  ok(workbench.ok && Array.isArray(workbench.data.accounts)
    && workbench.data.accounts.some((row) => row.username === 'admin'), 'workbench.data 账号列表含当前登录账号')
  ok(workbench.ok && workbench.data.todos && TODO_KEYS.every((k) => typeof workbench.data.todos[k] === 'number'),
    'workbench.data.todos 含 7 个待办键')
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
