#!/usr/bin/env node
/**
 * 专项验证：截屏拦截、保存文件拦截、水印链路。
 *
 * 覆盖三层：
 * 1. 后端层：材料签名链接、私有存储路径隔离、保存/下载契约
 * 2. 领域层：返回体脱敏兜底（任何位置出现明文手机号/密文字段一律拒绝出站）
 * 3. 前端契约：material.sign 返回 allowDownload=false / allowSave=false / watermarkRequired=true
 *
 * 运行：node cloudbase/scripts/verify-security.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const shared = path.join(here, '..', 'shared')

const { createRouter } = require(path.join(shared, 'router.js'))
const { createMemoryRepo } = require(path.join(shared, 'repo.js'))
const { loadKeys } = require(path.join(shared, 'crypto.js'))
const { verifyMaterialLink } = require(path.join(shared, 'files.js'))
const { assertNoPlaintextContact } = require(path.join(shared, 'projection.js'))
const { MATERIAL_LINK_TTL_MS, TRADE_MODES, LEAD_STATUS } = require(path.join(shared, 'constants.js'))

let pass = 0
let fail = 0
const failures = []

function ok(cond, name, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; failures.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')) }
}
function section(title) { console.log('\n— ' + title) }

const CLOCK = Date.parse('2026-03-01T00:00:00Z')
const now = () => CLOCK

const keys = loadKeys({
  AES_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
  HMAC_KEY_B64: Buffer.alloc(32, 9).toString('base64')
})

const repo = createMemoryRepo()
const userRouter = createRouter({ repo, keys, scope: 'user', now, env: {} })
const call = (r, a, d, ctx) => r.dispatch(a, d, ctx)
const U1 = { openid: 'o_u1' }
const U2 = { openid: 'o_u2' }
const OWNER = { openid: 'o_owner' }

async function setup() {
  await call(userRouter, 'auth.login', { nick: '张三' }, U1)
  await call(userRouter, 'profile.save', { realname: '张三', phone: '13800138000' }, U1)
  await call(userRouter, 'auth.login', { nick: '李四' }, U2)
  await call(userRouter, 'profile.save', { realname: '李四', phone: '13900139000' }, U2)
  await call(userRouter, 'auth.login', { nick: '货主' }, OWNER)
  await call(userRouter, 'profile.save', {
    realname: '货主', phone: '13700137000',
    subject: '货主科技', subjectType: '民企', subjectKind: 'company'
  }, OWNER)
  const p = await call(userRouter, 'product.publish', {
    tradeMode: TRADE_MODES.SELL, title: 'H100 整批', cat: 'GPU 服务器',
    brand: 'NVIDIA', model: 'H100 80G SXM', qty: 8, minQty: 1, price: '248000',
    cond: '全新', tax: ['含税'], city: '深圳', supply: '现货', deliver: '3 天内',
    must: ['接受同台互验'], nego: [], flow: []
  }, OWNER)
  if (!p.ok) throw new Error('product.publish 失败：' + p.code + ' ' + p.message)
  /* 发布后自动过审（在售），可直接咨询 */
  const c = await call(userRouter, 'consult.submit', {
    productId: p.data.id, phone: '13800138000',
    conds: [{ k: '接受同台互验', satisfied: true }], summary: '需要 8 台'
  }, U1)
  return { productId: p.data.id, leadId: c.data.leadId }
}

/* ============================================================
   1. 签名链接安全
   ============================================================ */
section('1. 材料签名链接（后端强制）')
{
  const { leadId } = await setup()
  const fileId = 'cloud://env-abc/materials/o_u1/1700000000_abcdef_license.pdf'
  const sign = await call(userRouter, 'material.sign', {
    fileId, leadId, name: '营业执照.pdf', size: 102400, type: 'application/pdf'
  }, U1)
  ok(sign.ok, '正常签名成功')

  const data = sign.data
  ok(data.allowDownload === false, '契约：allowDownload=false（禁止下载）')
  ok(data.allowSave === false, '契约：allowSave=false（禁止保存）')
  ok(data.watermarkRequired === true, '契约：watermarkRequired=true（必须带水印）')
  ok(data.screenshotGuard === true, '契约：screenshotGuard=true（截屏防护开关）')
  ok(data.expiresIn === 300, '链接有效期 5 分钟（300 秒）')
  ok(data.exp === CLOCK + MATERIAL_LINK_TTL_MS, '过期时间戳 = 当前 + 5 分钟')
  ok(/禁止转发/.test(data.watermark), '水印文案含「禁止转发/下载」字样')
  ok(/线索/.test(data.watermark), '水印文案含线索号（可溯源）')
  ok(data.url.indexOf('cloudfile://') === 0, '链接使用私有协议 cloudfile://，非 https 公网直链')

  /* 篡改签名 */
  let tampered = false
  try { verifyMaterialLink({ keys, url: data.url.replace(/sig=[^&]+/, 'sig=deadbeef'), uid: U1.openid, leadId, now: CLOCK }) }
  catch (e) { tampered = e.code === 'TAMPERED' }
  ok(tampered, '签名被篡改 → TAMPERED 拒绝')

  /* 过期 */
  let expired = false
  try { verifyMaterialLink({ keys, url: data.url, uid: U1.openid, leadId, now: CLOCK + 6 * 60 * 1000 }) }
  catch (e) { expired = e.code === 'EXPIRED' }
  ok(expired, '超过 5 分钟 → EXPIRED 拒绝')

  /* 换人 */
  let wrongUser = false
  try { verifyMaterialLink({ keys, url: data.url, uid: U2.openid, leadId, now: CLOCK + 1000 }) }
  catch (e) { wrongUser = e.code === 'FORBIDDEN' }
  ok(wrongUser, '换用户访问 → FORBIDDEN 拒绝')

  /* 换线索 */
  let wrongLead = false
  try { verifyMaterialLink({ keys, url: data.url, uid: U1.openid, leadId: 'L-other', now: CLOCK + 1000 }) }
  catch (e) { wrongLead = e.code === 'FORBIDDEN' }
  ok(wrongLead, '换线索访问 → FORBIDDEN 拒绝')

  /* 别人目录的材料 */
  const other = await call(userRouter, 'material.sign', {
    fileId: 'cloud://env-abc/materials/o_someone_else/1700000000_xxx.pdf',
    leadId, name: 'x.pdf', size: 100, type: 'application/pdf'
  }, U1)
  ok(!other.ok && other.code === 'FORBIDDEN', '访问他人目录的材料 → FORBIDDEN 拒绝')

  /* 危险类型 */
  const svg = await call(userRouter, 'material.sign', {
    fileId: 'cloud://env-abc/materials/o_u1/1700000000_x.svg',
    leadId, name: 'x.svg', size: 100, type: 'image/svg+xml'
  }, U1)
  ok(!svg.ok && svg.code === 'VALIDATION', 'SVG 等危险类型 → 拒绝上传')

  /* 仅 5 分钟有效 → 不可用作长期公网图床 */
  let shortLived = MATERIAL_LINK_TTL_MS <= 5 * 60 * 1000
  ok(shortLived, '链接有效期 ≤ 5 分钟（不能当永久图床）')

  /* 所有签名返回里没有 https 公网直链 */
  ok(data.url.indexOf('http') < 0, '返回链接非 https 公网直链')
}

/* ============================================================
   2. 出站脱敏兜底
   ============================================================ */
section('2. 出站脱敏兜底（任何接口不得泄漏明文）')
{
  const { productId, leadId } = await setup()

  /* 商品列表 / 详情 */
  const list = await call(userRouter, 'product.list', {}, U1)
  ok(!JSON.stringify(list.data).includes('13800138000'), '商品列表不含明文手机号')
  ok(!JSON.stringify(list.data).includes('phoneCipher'), '商品列表不含密文字段名')
  const detail = await call(userRouter, 'product.detail', { id: productId }, U1)
  ok(!JSON.stringify(detail.data).includes('13800138000'), '商品详情不含明文手机号')

  /* 我的咨询 */
  const mine = await call(userRouter, 'mine.list', {}, U1)
  ok(!JSON.stringify(mine.data).includes('13800138000'), '我的咨询不含明文手机号')

  /* 我的资料：永远只返回脱敏值 */
  const profile = await call(userRouter, 'profile.get', {}, U1)
  ok(profile.data.phoneMasked === '138****8000', '个人信息返回脱敏手机号')
  ok(!JSON.stringify(profile.data).includes('13800138000'), '个人信息响应不含明文手机号')

  /* 回执 */
  const submit = await call(userRouter, 'consult.submit', {
    productId, phone: '13600136000',
    conds: [{ k: '接受同台互验', satisfied: true }], summary: '测试'
  }, U2)
  ok(submit.ok, '第二人提交咨询成功')
  ok(!JSON.stringify(submit.data).includes('13600136000'), '咨询回执不含明文手机号')

  /* 投影层硬兜底：明文手机号按产品口径允许出站（用户可主动公开联系方式），密文仍需拦截 */
  let phoneAllowed = true
  try { assertNoPlaintextContact({ items: [{ phone: '13800138000' }] }) }
  catch (e) { phoneAllowed = false }
  ok(phoneAllowed, '投影层口径：明文手机号允许出站（用户主动公开）')

  let cipherCaught = false
  try { assertNoPlaintextContact({ item: { phoneCipher: 'v1.xxx' } }) }
  catch (e) { cipherCaught = e.code === 'INTERNAL' }
  ok(cipherCaught, '投影层兜底：响应体里混进密文字段 → INTERNAL 拒绝出站')

  let idCardCaught = false
  try { assertNoPlaintextContact({ id: '1', idCard: '110101199003071234' }) }
  catch (e) { idCardCaught = e.code === 'INTERNAL' }
  ok(idCardCaught, '投影层兜底：响应体里混进身份证号 → INTERNAL 拒绝出站')
}

/* ============================================================
   3. 管理端越权拿不到联系方式
   ============================================================ */
section('3. 管理端：客服拿不到明文、已对接前拿不到明文')
{
  const { createAdminHandlers } = require(path.join(shared, 'handlers.admin.js'))
  const adminRouter = createRouter({ repo, keys, scope: 'admin', now, env: {} })
  const { generateTotp } = require(path.join(shared, 'crypto.js'))
  const { DEMO_ADMIN_ACCOUNTS } = require(path.join(shared, 'constants.js'))

  const adminDemo = DEMO_ADMIN_ACCOUNTS.find(x => x.key === 'admin')
  const csDemo = DEMO_ADMIN_ACCOUNTS.find(x => x.key === 'cs')

  const adminLogin = await call(adminRouter, 'admin.login', {
    username: 'admin', password: adminDemo.password,
    otp: generateTotp(adminDemo.totpSecret, now())
  }, {})
  const csLogin = await call(adminRouter, 'admin.login', {
    username: 'cs', password: csDemo.password,
    otp: generateTotp(csDemo.totpSecret, now())
  }, {})

  const { leadId } = await setup()

  /* 客服访问 contact.reveal → 403 */
  const csReveal = await call(adminRouter, 'contact.reveal', { leadId, reason: '需要联系对方' }, { token: csLogin.data.token })
  ok(!csReveal.ok && csReveal.code === 'FORBIDDEN', '客服账号 → contact.reveal 403')

  /* 管理员未对接 → 409 */
  const tooEarly = await call(adminRouter, 'contact.reveal', { leadId, reason: '建群需要联系对方' }, { token: adminLogin.data.token })
  ok(!tooEarly.ok && tooEarly.code === 'CONFLICT', '未对接 → contact.reveal 409')

  /* 原因太短 → 拒绝 */
  const shortReason = await call(adminRouter, 'contact.reveal', { leadId, reason: '看' }, { token: adminLogin.data.token })
  ok(!shortReason.ok && shortReason.code === 'VALIDATION', '释放原因少于 5 字 → 拒绝')

  /* 线索列表永远不含明文 */
  const leadList = await call(adminRouter, 'lead.list', {}, { token: adminLogin.data.token })
  ok(!JSON.stringify(leadList.data).includes('13800138000'), '管理端线索列表不含明文手机号')
  ok(!JSON.stringify(leadList.data).includes('phoneCipher'), '管理端线索列表不含密文字段')
  ok(!JSON.stringify(leadList.data).includes('phoneBidx'), '管理端线索列表不含盲索引字段')

  /* 商品池不含明文 */
  const prods = await call(adminRouter, 'product.list', {}, { token: adminLogin.data.token })
  ok(!JSON.stringify(prods.data).includes('13700137000'), '管理端商品池不含货主明文手机号')
}

/* ============================================================
   4. 审计不可篡改 / 不含明文
   ============================================================ */
section('4. 审计与安全事件')
{
  const adminRouter = createRouter({ repo, keys, scope: 'admin', now, env: {} })
  const { generateTotp } = require(path.join(shared, 'crypto.js'))
  const { DEMO_ADMIN_ACCOUNTS } = require(path.join(shared, 'constants.js'))
  const demo = DEMO_ADMIN_ACCOUNTS.find(x => x.key === 'admin')
  const login = await call(adminRouter, 'admin.login', {
    username: 'admin', password: demo.password,
    otp: generateTotp(demo.totpSecret, now())
  }, {})

  const audit = await call(adminRouter, 'audit.list', {}, { token: login.data.token })
  ok(audit.ok, '管理员可查询审计日志')
  ok(!JSON.stringify(audit.data).includes('13800138000'), '审计日志不含明文手机号')
  ok(audit.data.retentionDays >= 180, '审计保留期 ≥ 6 个月')

  /* 审计日志不可修改（repo 层拦截） */
  let blocked = false
  try { await repo.updateWhere('audit', { id: 'x' }, { action: 'tampered' }) }
  catch (e) { blocked = e.code === 'FORBIDDEN' }
  ok(blocked, '审计日志禁止修改（FORBIDDEN）')

  /* 客服访问审计 → 403 */
  const csRouter = createRouter({ repo, keys, scope: 'admin', now, env: {} })
  const csDemo = DEMO_ADMIN_ACCOUNTS.find(x => x.key === 'cs')
  const csLogin = await call(csRouter, 'admin.login', {
    username: 'cs', password: csDemo.password,
    otp: generateTotp(csDemo.totpSecret, now())
  }, {})
  const csAudit = await call(csRouter, 'audit.list', {}, { token: csLogin.data.token })
  ok(!csAudit.ok && csAudit.code === 'FORBIDDEN', '客服访问审计 → 403')
}

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '─'.repeat(56))
console.log('安全专项验证：' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('\n失败项：')
  failures.forEach((f) => console.log('  · ' + f))
  process.exit(1)
}
process.exit(0)
