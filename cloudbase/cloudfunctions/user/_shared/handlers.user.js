'use strict'

const { AppError, CODES } = require('./errors')
const {
  MUST_CONDITIONS,
  LEAD_STATUS,
  SOURCE_LABEL,
  MATERIAL_LINK_TTL_MS,
  RATE_LIMITS,
  TRADE_MODE_OPTIONS,
  RENT_LIMITS,
  PRODUCT_STATUS,
  PRODUCT_PUBLIC_STATUS,
  PRODUCT_CONSULTABLE_STATUS,
  DEMAND_STATUS,
  DEMAND_PUBLIC_STATUS,
  DEMAND_CONSULTABLE_STATUS,
  EXPOSURES,
  EXPOSURE_LABELS,
  VISIBILITIES,
  VISIBILITY_LABELS,
  PUBLISH_CHANNELS,
  TIERS,
  CHAT_RETENTION_DAYS
} = require('./constants')
const { encryptField, decryptField, blindIndex, randomId, sha256Hex, userNoOf } = require('./crypto')
const { recordSensitiveRisk } = require('./sensitive')
const {
  str,
  enumOf,
  arrayOfStrings,
  normalizePhone,
  maskPhone,
  maskName,
  maskSensitiveText,
  normalizePaging
} = require('./validate')
const {
  assertMaterialFile,
  assertOwnedStoragePath,
  assertNoPublicUrl,
  signMaterialLink,
  watermarkText,
  sanitizeFileName
} = require('./files')
const {
  projectProduct,
  projectDemand,
  projectLeadForUser,
  assertNoPlaintextContact,
  assertNoPlaintextContactAllowingPhone
} = require('./projection')
const { encryptFields, decryptFieldOf, masked } = require('./secrets')
const { appendAudit } = require('./audit')
const { buildProduct, buildDemand, judgeTier, blockedLifecycle, mustForDemand, normalizeMedia } = require('./domain')
const { notifyNewBizMatch } = require('./market')
const { detectRisk, normalizeModel } = require('./insights')
const { chatKindOf, mediaState, chatCutoff, DAY_MS } = require('./chatmedia')

const SUBJECT_TYPES = [
  '个人', '个体户', '国央企', '央企', '国企', '上市公司', '民企', '外企',
  '合资企业', '合伙企业', '事业单位', '政府机关', '社会团体', '其他'
]
/* 主体类别：企业主体需营业执照 + 法定代表人身份证，个人主体只需本人身份证 */
const SUBJECT_KINDS = ['company', 'person']

/* 私密发布＝匿名公开：内容可见，但发布者身份与主页入口一律隐藏 */
const ANON_LABEL = '匿名发布'

/** 资质材料类型：与 profile 页上传入口一致 */
const QUAL_KINDS = ['license', 'idcard', 'authorization', 'loi', 'proof', 'other']
const QUAL_STATUS = Object.freeze({ PENDING: '待核验', VERIFIED: '已核验', REJECTED: '已驳回' })

/* 举报 / 投诉 / 意见反馈：统一进 reports 集合，由管理端「举报反馈」处置并回写站内信 */
const REPORT_TYPES = ['举报', '投诉', '意见反馈']
const REPORT_TARGETS = ['product', 'news', 'demand', 'owner', 'chat', 'other']
const REPORT_STATUS = Object.freeze({ PENDING: '待处理', DOING: '处理中', DONE: '已处理', REJECTED: '已驳回' })

/**
 * 资质条目归一化：兼容历史纯字符串 + 新增的原件 fileId。
 * 已核验状态按「类型 + 文件名」继承，用户重新保存不会被重置。
 */
function normalizeQuals(input, existing) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new AppError(CODES.VALIDATION, '资质格式不正确')
  if (input.length > 10) throw new AppError(CODES.VALIDATION, '最多上传 10 份资质')
  const prev = new Map()
  for (const row of (existing && existing.quals) || []) {
    const item = row && typeof row === 'object' ? row : { name: String(row || '') }
    prev.set(`${item.kind || 'other'}|${item.name}`, item)
  }
  const seen = new Set()
  return input.map((raw) => {
    const src = raw && typeof raw === 'object' ? raw : { name: raw }
    const name = str(src.name, { field: '材料名称', required: true, max: 120 }).split(/[\\/]/).pop()
    const kind = enumOf(src.kind || 'other', QUAL_KINDS, '材料类型')
    const fileId = str(src.fileId || src.fileID || '', { field: '原件', max: 1024 })
    /* 只接受云存储 fileID 或 https 链接，禁止客户端本地路径 / file:// */
    if (fileId && !/^(cloud:\/\/|https:\/\/)/i.test(fileId)) {
      throw new AppError(CODES.VALIDATION, '资质原件需先上传到云端')
    }
    const key = `${kind}|${name}`
    if (seen.has(key)) return null
    seen.add(key)
    const old = prev.get(key)
    return {
      name,
      kind,
      fileId,
      status: (old && old.fileId === fileId && old.status) || QUAL_STATUS.PENDING,
      at: Number(src.at) || (old && old.at) || 0
    }
  }).filter(Boolean)
}

/** 可编辑状态：已成交 / 已关闭等终态不允许再改内容，避免绕过状态流转 */
const PRODUCT_EDITABLE_STATUS = [
  PRODUCT_STATUS.DRAFT,
  PRODUCT_STATUS.REJECTED,
  PRODUCT_STATUS.ON_SALE,
  PRODUCT_STATUS.OFFLINE
]
const DEMAND_EDITABLE_STATUS = [
  DEMAND_STATUS.DRAFT,
  DEMAND_STATUS.REJECTED,
  DEMAND_STATUS.OPEN,
  DEMAND_STATUS.OFFLINE
]

/** 编辑回填的属主字段白名单：对外投影不含媒体等字段，密文一律不下发 */
const PRODUCT_OWNER_FIELDS = [
  'id', 'visibility', 'tradeMode', 'side', 'title', 'cat', 'brand', 'model', 'qty', 'minQty',
  'price', 'priceMax', 'priceMode', 'priceUnit', 'currency', 'currencySymbol', 'currencyLabel', 'supply', 'tax', 'deliver', 'cond', 'condLevel', 'city',
  'term', 'closed', 'deposit', 'pay', 'rentLimits', 'must', 'nego', 'flow',
  'note', 'accept', 'requirements', 'limit', 'media',
  'status', 'reviewReason', 'offlineReason', 'createdAt'
]
const DEMAND_OWNER_FIELDS = [
  'id', 'visibility', 'tradeMode', 'side', 'title', 'cat', 'brand', 'model', 'qty', 'budget', 'budgetMax', 'budgetMode', 'budgetUnit',
  'currency', 'currencySymbol', 'currencyLabel',
  'supply', 'tax', 'cond', 'condLevel', 'city', 'term', 'closed', 'deposit', 'pay', 'rentLimits',
  'must', 'note', 'accept', 'sameMachine', 'codeAsk', 'media',
  'status', 'reviewReason', 'offlineReason', 'createdAt'
]
/**
 * 中性回执：不承诺响应时长、不透露档位与被拦截。
 * 只告知「若匹配，后台客服会进行联系」并要求不要重复发起。
 */
const NEUTRAL_RECEIPT = '咨询已提交。若匹配，后台客服会进行联系，请不要重复发起咨询。'

/* 我的库存：本人私有清单，仅用于商机匹配，不对外展示 */
const STOCK_LIMIT = 200
const STOCK_STATUS_ON = '在售'
const STOCK_STATUS_OFF = '已下架'

/* 收藏 / 关注：云端保存，换手机后可恢复 */
const FAV_LIMIT = 500
const FOLLOW_LIMIT = 200

/**
 * 货主匿名键：不可逆哈希，用于「关注货主」。
 * 客户端只拿得到这个键，拿不到对方 openid，也无法反推身份。
 */
function ownerKeyOf(uid) {
  return 'o_' + sha256Hex('owner|' + String(uid || '')).slice(0, 18)
}

/**
 * 货主键反查用户：先按已落库的 ownerKey 字段直查，历史用户回退分页扫描并回填。
 * 早期实现只扫前 500 个用户，用户量上来后主页会 404。
 */
const ownerKeyHits = new Map()
const OWNER_KEY_TTL_MS = 10 * 60 * 1000

async function uidByOwnerKey(repo, ownerKey) {
  const cached = ownerKeyHits.get(ownerKey)
  if (cached && cached.expireAt > Date.now()) return cached.uid
  ownerKeyHits.delete(ownerKey)
  const direct = await repo.find('users', { ownerKey }, { limit: 1 })
  if (direct[0]) {
    ownerKeyHits.set(ownerKey, { uid: direct[0].id, expireAt: Date.now() + OWNER_KEY_TTL_MS })
    return direct[0].id
  }
  const PAGE = 500
  for (let skip = 0; skip <= 50000; skip += PAGE) {
    const rows = await repo.find('users', {}, { limit: PAGE, skip })
    for (const u of rows) {
      if (!u || !u.id || ownerKeyOf(u.id) !== ownerKey) continue
      /* 回填后后续请求可直接走索引字段 */
      await repo.updateWhere('users', { id: u.id }, { ownerKey }).catch(() => {})
      ownerKeyHits.set(ownerKey, { uid: u.id, expireAt: Date.now() + OWNER_KEY_TTL_MS })
      return u.id
    }
    if (rows.length < PAGE) break
  }
  if (ownerKeyHits.size > 4096) ownerKeyHits.clear()
  return ''
}

/** 日期展示（北京时间，只有日期）：作者主页的资讯列表用 */
function shortDate(ms) {
  const n = Number(ms) || 0
  if (!n) return ''
  const d = new Date(n + 8 * 60 * 60 * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 收藏 / 关注的固定 id：同一用户 + 同一对象只落一行，重复收藏走软恢复 */
function relId(prefix, uid, key) {
  return prefix + sha256Hex(String(uid) + '|' + String(key)).slice(0, 22)
}

/** 服务端日期文案：列表只展示到天，避免把毫秒时间戳直接下发 */
function dayText(ms) {
  const n = Number(ms)
  if (!n) return ''
  const d = new Date(n)
  const pad = (v) => (v < 10 ? '0' + v : String(v))
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 商机领取记录 id：与 market.js 的 biz.claim 同口径，领取人凭它回看仅商机发布 / 已结束的内容 */
function bizClaimId(uid, kind, id) {
  return 'bc' + sha256Hex(`${uid}:${kind}:${id}`).slice(0, 24)
}

/**
 * 明文敏感字段探测：共享缓存命中的结果可能被任意用户读到，
 * 含明文手机号 / 真实姓名的列表一律不落共享缓存（与 router 的缓存口径一致）。
 */
const PLAINTEXT_KEYS = new Set(['phone', 'ownerPhone', 'realname', 'phoneCipher', 'realnameCipher', 'idCard'])
function containsPlaintextIdentity(value, depth) {
  const level = depth || 0
  if (!value || typeof value !== 'object' || level > 5) return false
  if (Array.isArray(value)) return value.some((item) => containsPlaintextIdentity(item, level + 1))
  for (const key of Object.keys(value)) {
    if (PLAINTEXT_KEYS.has(key) && value[key]) return true
    if (containsPlaintextIdentity(value[key], level + 1)) return true
  }
  return false
}

function stockView(doc) {
  const d = doc || {}
  return {
    id: d.id,
    cat: d.cat || '',
    brand: d.brand || '',
    model: d.model || '',
    series: d.series || '',
    qty: Number(d.qty) || 0,
    price: Number(d.price) || 0,
    unit: d.unit || '',
    city: d.city || '',
    cond: d.cond || '',
    note: d.note || '',
    status: d.status === STOCK_STATUS_OFF ? STOCK_STATUS_OFF : STOCK_STATUS_ON,
    at: Number(d.at || d.updatedAt || d.createdAt) || 0
  }
}

/** 金额展示：面议 / 区间 / 单价统一口径，避免各端各写一套 */
function amountText(low, max, mode, sym, unit) {
  const lo = Number(low) || 0
  if (mode === 'nego' || !lo) return '现场沟通'
  const hi = Number(max) || 0
  const fmt = (v) => sym + (Math.round(v * 100) / 100)
  return (mode === 'range' && hi > lo ? fmt(lo) + ' - ' + fmt(hi) : fmt(lo)) + (unit || '')
}

function createUserHandlers(deps) {
  const { repo, keys } = deps
  /* 微信订阅消息推送由云函数注入；本地测试 / 未配置环境变量时为 undefined */
  const notify = deps.notify
  /* 商机提醒：发布新商机时给双方各发一次站内信 + 微信订阅消息 */
  const subscribe = deps.subscribe
  /* 微信手机号快捷验证换号能力由运行环境注入（云开发 / ECS 各一套） */
  const exchangePhone = deps.exchangePhone
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const env = deps.env || {}
  /* 共享列表缓存（可选）：公开列表的主体内容与浏览者无关，按入参全站共享一份 */
  const cacheLayer = deps.cache && typeof deps.cache.wrap === 'function' ? deps.cache : null

  /**
   * 公开列表共享缓存：缓存的是「去掉浏览者身份」的基础数据，
   * mine / 私密主体归属在每次请求时叠加，因此 key 不含 openid。
   */
  function listCacheSuffix(action, input) {
    const fields = ['page', 'limit', 'tradeMode', 'cat', 'city', 'q', 'status']
    const parts = fields.map((key) => key + '=' + String(input[key] === undefined ? '' : input[key]))
    return action + ':' + parts.join('&')
  }

  async function sharedList(group, action, input, ttlSec, loader) {
    if (!cacheLayer) return loader()
    try {
      const key = await cacheLayer.keyOf('user', group, listCacheSuffix(action, input))
      return await cacheLayer.wrap(key, ttlSec, loader, (value) => !containsPlaintextIdentity(value))
    } catch (err) {
      /* 缓存故障不影响列表读取 */
      return loader()
    }
  }

  /* 平台设置（订阅消息模板）读取：60 秒缓存，管理端改完无需重启即可生效 */
  let siteCache = { at: 0, doc: null }
  async function readSiteSettings() {
    if (siteCache.doc && Date.now() - siteCache.at < 60 * 1000) return siteCache.doc
    let doc = null
    try {
      doc = (await repo.get('settings', 'site')) || {}
    } catch (err) {
      doc = {}
    }
    siteCache = { at: Date.now(), doc }
    return doc
  }

  /**
   * 会话新消息微信提醒：仅当管理端 / 环境变量配置了模板才推送，
   * 用户未授权或模板字段不匹配时由运行环境吞掉错误，不影响站内消息。
   */
  async function pushChatNotice(toUid, payload) {
    if (!notify || typeof notify.chat !== 'function' || !toUid) return
    try {
      const site = await readSiteSettings()
      const templateId = String(site.tmplChat || env.SUBSCRIBE_TMPL_CHAT || '')
      if (!templateId) return
      await notify.chat({
        openid: toUid,
        templateId,
        sender: payload.sender || '',
        preview: payload.preview || '',
        at: payload.at,
        page: 'pages/msg/msg?threadId=' + encodeURIComponent(payload.threadId || '')
      })
    } catch (err) {
      /* 推送失败不影响站内消息 */
    }
  }

  function phoneAad(uid) {
    return `users.phoneCipher.${uid}`
  }

  function decryptOwnPhone(user) {
    if (!user || !user.phoneCipher) return ''
    try {
      return decryptField({ keys, token: user.phoneCipher, aad: phoneAad(user.id) })
    } catch (err) {
      return ''
    }
  }

  /** 从 storagePath 反推文件名：非法 % 转义不能把整条链路打成 500 */
  function fallbackFileName(fileId) {
    const raw = String(fileId || '').split('/').pop() || 'file'
    try {
      return decodeURIComponent(raw)
    } catch (err) {
      return raw
    }
  }

  async function mustUser(ctx) {
    const user = await repo.get('users', ctx.openid)
    if (!user) throw new AppError(CODES.UNAUTHENTICATED, '请先登录')
    /* 管理端「停用」必须立刻生效：只做列表过滤会让停用账号继续调用全部接口 */
    if (user.status === '停用') throw new AppError(CODES.FORBIDDEN, '账号已停用，请联系平台客服')
    return user
  }

  async function readProfile(uid) {
    const rows = await repo.find('profiles', { uid }, { limit: 1 })
    return rows[0] || null
  }

  /**
   * 进入商机池的前置条件：发布内容公开，且个人信息 / 企业信息设为「公开主体」。
   * 只有公开主体才能发布商机可见内容；不公开主体只能普通发布，否则商机会员拿到的是匿名商机。
   */
  async function assertCanJoinPool(uid, data) {
    /* 只有显式选择商机渠道时校验；历史调用未传 channel / bizPool 时保持原行为 */
    const channel = data.channel || (data.bizPool === true ? PUBLISH_CHANNELS.BOTH : PUBLISH_CHANNELS.NORMAL)
    if (channel === PUBLISH_CHANNELS.NORMAL) return
    if ((data.visibility || VISIBILITIES.PUBLIC) === VISIBILITIES.PRIVATE) {
      throw new AppError(CODES.VALIDATION, '保密发布不能进入商机池，请改为公开或关闭「进入商机池」')
    }
    const profile = await readProfile(uid)
    const exposure = String((profile && profile.exposure) || '').trim()
    if (exposure !== EXPOSURES.OPEN) {
      throw new AppError(CODES.VALIDATION, '只有「公开主体」才能进入商机池，请先在个人信息的公开范围中选择公开主体，或关闭「进入商机池」')
    }
  }

  /**
   * 发布即提醒：正式发布且进入商机池的内容，给发布者与匹配会员各发一次提醒。
   * 草稿、保密内容、普通渠道都不提醒；提醒失败不影响发布结果。
   */
  async function notifyBizPool(kind, doc, at) {
    if (!doc || doc.bizPool !== true) return
    try {
      await notifyNewBizMatch(repo, subscribe, { kind, doc, at })
    } catch (err) {
      /* 提醒失败不影响发布本身 */
    }
  }

  /* ---------- 直聊会话：会话 id 复用咨询线索 id，双方各持一份消息副本 ---------- */
  async function peerDisplayName(peerId) {
    if (!peerId) return '对方'
    try {
      const map = await publicOwnerMap([peerId])
      const info = map.get(peerId)
      /* 主体未公开时只给中性称呼，绝不把真实主体写进消息表 */
      if (info && info.subject) return info.subject
    } catch (err) { /* 称呼失败不影响会话本身 */ }
    return '用户'
  }

  /** 商机会员判定：已开通且在有效期内；直聊里用于展示「商机会员」标识 */
  async function bizMemberOf(uid) {
    if (!uid) return false
    try {
      const access = await repo.get('bizAccess', uid)
      if (!access) return false
      if (access.status !== '已开通') return false
      return (Number(access.expireAt) || 0) > now()
    } catch (err) {
      return false
    }
  }

  async function insertDirectChat(opts) {
    const o = opts || {}
    const base = {
      threadId: o.threadId,
      leadId: o.threadId,
      channel: 'direct',
      targetType: o.targetType || '',
      targetId: o.targetId || '',
      title: o.title || ''
    }
    /* 消息类型扩展：text / image / video / card，媒体与名片字段随消息一起落库 */
    const extra = { kind: o.kind || 'text' }
    if (o.image) extra.image = o.image
    if (o.video) extra.video = o.video
    if (o.poster) extra.poster = o.poster
    if (o.card) extra.card = o.card
    /* 发送方副本：readByUser=true，避免自己的消息在列表里显示未读 */
    const mine = {
      id: randomId('M'),
      type: 'direct.chat',
      payload: Object.assign({}, base, extra, {
        uid: o.fromUid,
        from: 'me',
        peerUid: o.toUid,
        peerName: o.toName || '对方',
        body: o.body
      }),
      status: 'read',
      readByUser: true,
      createdAt: o.at
    }
    /* 接收方副本：未读，消息中心列表可见 */
    const theirs = {
      id: randomId('M'),
      type: 'direct.chat',
      payload: Object.assign({}, base, extra, {
        uid: o.toUid,
        from: 'peer',
        peerUid: o.fromUid,
        peerName: o.fromName || '对方',
        body: o.body
      }),
      status: 'pending',
      readByUser: false,
      /* 管理端直聊监管的未读口径：客服未查看前保持未读 */
      readByStaff: false,
      createdAt: o.at
    }
    /* 私密发布：买家侧副本不带发布人身份，只认「私密发布」，并打上 private 标记 */
    if (o.privateForUid) {
      if (mine.payload.uid === o.privateForUid) {
        mine.payload.peerName = '私密发布'
        mine.payload.private = true
      }
      if (theirs.payload.uid === o.privateForUid) {
        theirs.payload.peerName = '私密发布'
        theirs.payload.private = true
      }
    }
    /* 先写自己副本：对方投递失败时至少发送方能看到已发送内容 */
    await repo.insert('outbox', mine)
    await repo.insert('outbox', theirs)
    return mine.id
  }

  /**
   * 发布商品时同步一条私库存，只用于商机匹配（新发布需求会命中）。
   * 库存写入失败不能影响商品发布，因此整体兜底为 false。
   */
  async function syncStockFromProduct(product, uid, at) {
    const p = product || {}
    const qty = Math.floor(Number(p.qty))
    const price = Number(p.price)
    const city = String(p.city || p.province || '').trim()
    if (!(qty > 0) || !(price > 0) || !city) return false
    const id = 'sk_' + String(p.id)
    try {
      const existing = await repo.get('stocks', id)
      if (existing && existing.ownerId !== uid) return false
      if (!existing) {
        const rows = await repo.find('stocks', { ownerId: uid }, { limit: STOCK_LIMIT })
        if (rows.filter((row) => !row.deleted).length >= STOCK_LIMIT) return false
      }
      const doc = {
        id,
        ownerId: uid,
        cat: p.cat || '其他配件',
        brand: p.brand || '',
        model: p.model || p.title || '',
        /* 系列用于商机撮合的同族判断，客户不必选到具体型号 */
        series: p.series || '',
        qty,
        /* 起订量跟着商品走：库存低于起订量时这单发不出去，商机匹配按它判断 */
        minQty: Math.max(1, Math.min(qty, Math.floor(Number(p.minQty) || 1))),
        price,
        unit: '元 / 件',
        city,
        cond: p.cond || '',
        note: ('来自商品：' + String(p.title || '')).slice(0, 200),
        status: STOCK_STATUS_ON,
        sourceProductId: p.id,
        at,
        updatedAt: at,
        createdAt: existing ? existing.createdAt : at,
        deleted: false
      }
      if (existing) await repo.updateWhere('stocks', { id, ownerId: uid }, doc)
      else await repo.insert('stocks', doc)
      return true
    } catch (err) {
      return false
    }
  }

  /**
   * 同一货主 24 小时内发布的同型号条数：用于识别疑似重复铺货。
   * 只数本人、只数 24 小时内、只数同型号。
   */
  async function sameModelCountOf(collection, uid, model, at) {
    const target = normalizeModel(model)
    if (!target) return 0
    const rows = await repo.find(collection, { ownerId: uid }, { limit: 100 })
    const since = at - 24 * 60 * 60 * 1000
    return rows.filter((row) => {
      if (Number(row.createdAt || 0) < since) return false
      return normalizeModel(row.model || row.title) === target
    }).length
  }

  /**
   * 下架 / 关闭发布内容时，把仍处于「已对接」的线索一并收尾。
   * 否则商品下架后线索会永远停在「已对接」，双方都等不到结论。
   */
  async function closeMatchedLeads(field, id, reason, at, uid) {
    const rows = await repo.find('leads', { [field]: id, status: LEAD_STATUS.MATCHED }, { limit: 50 })
    for (const lead of rows) {
      const res = await repo.updateWhere(
        'leads',
        { id: lead.id, status: LEAD_STATUS.MATCHED },
        { status: LEAD_STATUS.CLOSED, closedReason: reason, closedAt: at }
      )
      if (!res || res.count === 0) continue
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'lead.closedByOwner',
          target: `${lead.id}:${LEAD_STATUS.MATCHED}->${LEAD_STATUS.CLOSED}`,
          reason,
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 线索已收尾：留痕失败不阻断 */
      }
    }
  }

  /** 本人联系人姓名：优先密文，兼容历史明文；解密失败一律返回空串 */
  function decryptOwnRealname(user) {
    if (!user) return ''
    if (user.realnameCipher) {
      try {
        return decryptFieldOf({ keys, collection: 'users', field: 'realname', recordId: user.id, cipher: user.realnameCipher })
      } catch (err) {
        return ''
      }
    }
    return user.realname || ''
  }

  function hasRealname(user) {
    return !!(user && (user.realnameCipher || user.realname))
  }

  /**
   * 发布 / 上架前置的必填口径：主体名称、主体类型、主体类别、联系人与手机号。
   * 与小程序 utils/profile-ready.js 同口径；职位 position 选填，不参与拦截。
   * 缺失字段同时写进 message（前端按「完善」识别并引导）与 meta.missing。
   */
  const PROFILE_REQUIRED_FIELDS = Object.freeze([
    { key: 'subject', label: '主体名称' },
    { key: 'subjectType', label: '主体类型' },
    { key: 'subjectKind', label: '主体类别' },
    { key: 'realname', label: '联系人' },
    { key: 'phone', label: '手机号' }
  ])

  async function assertProfileReady(uid, knownUser) {
    const user = knownUser || await repo.get('users', uid)
    const profile = await readProfile(uid)
    const missing = PROFILE_REQUIRED_FIELDS.filter((f) => {
      if (f.key === 'subject') return !String(decryptProfileField(profile, 'subject') || '').trim()
      if (f.key === 'subjectType') return !String((profile && profile.subjectType) || '').trim()
      if (f.key === 'subjectKind') return !String((profile && profile.subjectKind) || '').trim()
      if (f.key === 'realname') return !hasRealname(user)
      if (f.key === 'phone') return !(user && user.phoneCipher)
      return false
    }).map((f) => f.label)
    if (!missing.length) return
    throw new AppError(
      CODES.VALIDATION,
      `请先完善主体信息和联系方式（缺少：${missing.join('、')}）`,
      { missing }
    )
  }

  /** 档案里的敏感字段（主体名称 / 联系备注）同样只以密文落库 */
  function decryptProfileField(profile, field) {
    if (!profile) return ''
    const cipher = profile[`${field}Cipher`]
    if (cipher) {
      try {
        return decryptFieldOf({ keys, collection: 'profiles', field, recordId: profile.uid || profile.id, cipher })
      } catch (err) {
        return ''
      }
    }
    return profile[field] || ''
  }

  /**
   * 个人名片：本人主动发送的自我介绍卡。
   * 名片由本人在 1:1 会话里主动发出，属于本人可控的自我展示，
   * 因此主体信息、个人信息、联系方式都随名片带上，不再依赖「公开主体」开关；
   * 昵称 / 主体 / 联系人先做敏感信息掩码，避免手机号、身份证号随名片外泄。
   * 手机号只落「允许展示」标记，读取时再解密本人号码，避免明文落库。
   */
  function buildChatCard(user, profile) {
    const nick = maskSensitiveText(String((user && user.nick) || '').trim()) || '平台用户'
    const subject = maskSensitiveText(String(decryptProfileField(profile, 'subject') || ''))
    const contact = maskSensitiveText(String(decryptProfileField(profile, 'contact') || ''))
    const quals = (profile && profile.quals) || []
    return {
      name: nick.slice(0, 24),
      avatar: nick.slice(0, 1),
      /* 主体信息：名称 / 类型 / 类别（company 企业、person 个人） */
      subject: subject.slice(0, 60),
      subjectType: String((profile && profile.subjectType) || '').slice(0, 20),
      subjectKind: String((profile && profile.subjectKind) || '').slice(0, 20),
      /* 联系方式：联系人 / 联系备注（均掩码）+ 展示开关，手机号读取时解密 */
      contact: contact.slice(0, 24),
      /* 个人身份：真实姓名（掩码）、职位（非敏感）、实名状态 */
      realname: maskName(decryptOwnRealname(user)).slice(0, 24),
      position: String((profile && profile.position) || '').slice(0, 20),
      city: maskSensitiveText(String((profile && profile.city) || '')).slice(0, 20),
      verified: hasRealname(user) || quals.some((q) => q && q.status === QUAL_STATUS.VERIFIED),
      /* 只记录本人允许在名片里展示联系电话；号码本身不落库，读取时解密 */
      sharePhone: !!decryptOwnPhone(user)
    }
  }

  /**
   * 名片联系电话：只对本人允许展示的名片，读取时解密发送人当前号码。
   * 号码不写进 outbox，避免明文联系方式落库。
   */
  async function cardWithPhone(card, senderUid) {
    if (!card || typeof card !== 'object' || card.sharePhone !== true) return card
    const uid = String(senderUid || '')
    if (!uid) return card
    const user = await repo.get('users', uid)
    return Object.assign({}, card, { phone: decryptOwnPhone(user) || '' })
  }

  /**
   * 个人信息投影：只给脱敏值，手机号以密文 + 盲索引落库。
   * 本人可回显 realname / subject / contact 明文（用于编辑），但绝不回显手机号明文。
   */
  function buildProfileView(user, profile) {
    const phone = decryptOwnPhone(user)
    const realname = decryptOwnRealname(user)
    return {
      uid: user.id,
      /* 对外可见用户ID：用户本人可抄给客服，用于查账号 / 开权限 */
      userNo: userNoOf(user.id),
      nick: user.nick || '',
      avatar: user.avatar || '',
      status: user.status || '正常',
      hasPhone: !!user.phoneCipher,
      phoneMasked: maskPhone(phone),
      realname,
      realnameMasked: maskName(realname),
      subject: decryptProfileField(profile, 'subject'),
      subjectType: profile ? profile.subjectType || '' : '',
      subjectKind: profile ? profile.subjectKind || '' : '',
      contact: decryptProfileField(profile, 'contact'),
      /* 职位 / 身份：选填，名片与个人信息页回显 */
      position: profile ? profile.position || '' : '',
      city: profile ? profile.city || '' : '',
      quals: (profile && Array.isArray(profile.quals) ? profile.quals : []).map((row) => {
        const item = row && typeof row === 'object' ? row : { name: String(row || '') }
        return {
          name: item.name || '',
          kind: item.kind || 'other',
          fileId: item.fileId || '',
          status: item.status || QUAL_STATUS.PENDING,
          /* 驳回原因要回传本人，否则用户只看到「待核验」永远不知道要改什么 */
          reason: item.reason || '',
          at: Number(item.at) || 0,
          verifiedAt: Number(item.verifiedAt) || 0
        }
      }),
      joined: profile ? profile.joined : '',
      /* 主体与联系方式公开范围：hidden 不公开主体 / open 公开主体 */
      exposure: (profile && profile.exposure) === EXPOSURES.OPEN ? EXPOSURES.OPEN : EXPOSURES.HIDDEN,
      exposureLabel: EXPOSURE_LABELS[(profile && profile.exposure) === EXPOSURES.OPEN ? EXPOSURES.OPEN : EXPOSURES.HIDDEN],
      /* 是否自愿公开联系电话：只有在「公开主体」档才真正生效 */
      phonePublic: !!(profile && profile.phonePublic === true)
    }
  }

  /**
   * 公开页主体展示：按用户自选的公开范围决定是否露主体。
   * hidden 只给标签（主体不落公开响应）；open 才解密主体与联系人，手机号仍脱敏。
   * opts.revealPhone：货主自愿公开联系电话时（profile.phonePublic 且公开范围为 open）才给明文号码。
   * 历史数据中的 matched 按 hidden 处理。
   */
  async function publicOwnerMap(ownerIds, opts) {
    const revealPhone = !!(opts && opts.revealPhone)
    const ids = Array.from(new Set((ownerIds || []).filter(Boolean)))
    const map = new Map()
    if (!ids.length) return map
    const [profiles, users] = await Promise.all([
      repo.find('profiles', { uid: { $in: ids } }, { limit: ids.length }),
      repo.find('users', { id: { $in: ids } }, { limit: ids.length })
    ])
    const usersById = new Map(users.map((u) => [u.id, u]))
    for (const uid of ids) map.set(uid, { exposure: EXPOSURES.HIDDEN, ownerKey: ownerKeyOf(uid), city: '', verified: false })
    for (const p of profiles) {
      const exposure = p.exposure === EXPOSURES.OPEN ? EXPOSURES.OPEN : EXPOSURES.HIDDEN
      const revealed = exposure === EXPOSURES.OPEN
      /* 自愿公开联系电话：必须同时满足「公开主体」与本人主动开启 */
      const phoneShared = exposure === EXPOSURES.OPEN && p.phonePublic === true
      /* 号码明文只给商机会员（revealPhone），货主是否公开由 phoneShared 单独表达 */
      const phonePublic = revealPhone && phoneShared
      const info = {
        exposure,
        /* 匿名货主键：任何档位都下发，用于关注；与主体是否公开无关 */
        ownerKey: ownerKeyOf(p.uid),
        city: p.city || '',
        label: exposure === EXPOSURES.OPEN ? '公开主体' : '平台核验 · 主体已隐藏',
        revealed,
        phonePublic,
        phoneShared,
        subject: '',
        contactName: '',
        phoneMasked: '',
        /* 认证徽标：已实名或任一资质审核通过，与名片口径一致 */
        verified: !!(hasRealname(usersById.get(p.uid)) || ((p.quals || []).some((q) => q && q.status === 'VERIFIED'))),
        /* 仅在 phonePublic 为真时才有值：货主自己公开的联系电话 */
        phone: ''
      }
      if (revealed) {
        const user = usersById.get(p.uid)
        let subject = ''
        let realname = ''
        let phone = ''
        try {
          subject = p.subjectCipher
            ? decryptFieldOf({ keys, collection: 'profiles', field: 'subject', recordId: p.uid || p.id, cipher: p.subjectCipher })
            : (p.subject || '')
        } catch (err) { subject = '' }
        try {
          realname = user && user.realnameCipher
            ? decryptFieldOf({ keys, collection: 'users', field: 'realname', recordId: user.id, cipher: user.realnameCipher })
            : ((user && user.realname) || '')
        } catch (err) { realname = '' }
        try {
          phone = user && user.phoneCipher
            ? decryptField({ keys, token: user.phoneCipher, aad: `users.phoneCipher.${user.id}` })
            : ''
        } catch (err) { phone = '' }
        info.subject = subject
        info.contactName = maskName(realname)
        info.phoneMasked = maskPhone(phone)
        if (phonePublic) info.phone = phone
      }
      map.set(p.uid, info)
    }
    return map
  }

  function attachOwnerInfo(view, info) {
    const it = info || { exposure: EXPOSURES.HIDDEN }
    view.ownerExposure = it.exposure || EXPOSURES.HIDDEN
    view.ownerExposureLabel = it.label || '平台核验 · 主体已隐藏'
    /* 匿名货主键：关注功能使用，不含任何身份信息 */
    view.ownerKey = it.ownerKey || ''
    /* 货主已开启公开电话；是否下发明文号码另由 phonePublic 控制（仅商机会员） */
    view.ownerPhonePublic = it.phoneShared === true
    if (it.revealed) {
      view.ownerSubject = it.subject || ''
      view.ownerContactName = it.contactName || ''
      view.ownerPhoneMasked = it.phoneMasked || ''
      if (it.phonePublic) view.ownerPhone = it.phone || ''
    }
    return view
  }

  /**
   * 已落库的商品 → buildProduct 需要的入参。
   * 草稿存的是「已填部分」，提交审核时要用同一份内容重新走完整校验。
   */
  function productPayloadOf(product) {
    const rental = product.tradeMode === '出租'
    const payload = {
      id: product.id,
      visibility: product.visibility,
      tradeMode: product.tradeMode,
      title: product.title || '',
      cat: product.cat || '',
      brand: product.brand || '',
      model: product.model || '',
      qty: Number(product.qty) || 0,
      minQty: Number(product.minQty) || 0,
      currency: product.currency || 'CNY',
      supply: product.supply || '现货',
      tax: String(product.tax || '').split(' · ').filter(Boolean),
      deliver: product.deliver || '',
      must: Array.isArray(product.must) ? product.must.slice() : [],
      nego: Array.isArray(product.nego) ? product.nego.slice() : [],
      flow: Array.isArray(product.flow) ? product.flow.slice() : [],
      media: Array.isArray(product.media) ? product.media.slice() : [],
      note: product.note || '',
      accept: product.accept || '',
      requirements: product.requirements || '',
      limit: product.limit || ''
    }
    if (rental) {
      payload.rent = Number(product.price) || 0
      payload.term = Array.isArray(product.term) ? product.term.slice() : []
      payload.closed = product.closed || ''
      payload.deposit = product.deposit || ''
      payload.pay = product.pay || ''
      payload.rentLimits = Array.isArray(product.rentLimits) ? product.rentLimits.slice() : []
    } else {
      payload.price = Number(product.price) || 0
      payload.cond = product.cond || ''
      payload.condLevel = product.condLevel || ''
      payload.city = product.city || ''
    }
    return payload
  }

  /** 已落库的需求 → buildDemand 需要的入参 */
  function demandPayloadOf(demand) {
    const rental = demand.tradeMode === '租赁'
    const payload = {
      id: demand.id,
      visibility: demand.visibility,
      tradeMode: demand.tradeMode,
      title: demand.title || '',
      cat: demand.cat || '',
      brand: demand.brand || '',
      model: demand.model || '',
      qty: Number(demand.qty) || 0,
      currency: demand.currency || 'CNY',
      supply: demand.supply || '现货',
      tax: String(demand.tax || '').split(' · ').filter(Boolean),
      city: demand.city || '',
      cond: demand.cond || '',
      condLevel: demand.condLevel || '',
      note: demand.note || '',
      accept: demand.accept || '',
      sameMachine: demand.sameMachine !== false,
      codeAsk: demand.codeAsk !== false,
      media: Array.isArray(demand.media) ? demand.media.slice() : []
    }
    if (rental) {
      payload.rent = Number(demand.budget) || 0
      payload.term = Array.isArray(demand.term) ? demand.term.slice() : []
      payload.closed = demand.closed || ''
      payload.deposit = demand.deposit || ''
      payload.pay = demand.pay || ''
      payload.rentLimits = Array.isArray(demand.rentLimits) ? demand.rentLimits.slice() : []
    } else {
      payload.budget = Number(demand.budget) || 0
    }
    return payload
  }

  function allowedTargetQuery(data) {
    const productId = data.productId ? str(data.productId, { field: '商品', max: 64 }) : ''
    const demandId = data.demandId ? str(data.demandId, { field: '求购', max: 64 }) : ''
    if (!!productId === !!demandId) {
      throw new AppError(CODES.VALIDATION, '请选择要咨询的商品或求购')
    }
    return { productId, demandId }
  }

  /**
   * 加载咨询目标并校验状态机：
   * - 非属主只能看到对外可见状态（待审核 / 草稿 / 已驳回 / 已下架一律按不存在处理）；
   * - 只有「在售」商品 / 「求购中」需求可发起咨询；
   * - 不能咨询自己发布的任何对象（商品与需求通拦）。
   */
  async function loadTarget(productId, demandId, uid) {
    if (productId) {
      const product = await repo.get('products', productId)
      if (!product) throw new AppError(CODES.NOT_FOUND, '商品不存在或已下架')
      if (product.ownerId === uid) throw new AppError(CODES.VALIDATION, '不能咨询自己发布的商品')
      /* 保密发布：内容可匿名浏览与站内对话，仅隐藏主体与联系方式（在 chat.open 中脱敏） */
      if (!PRODUCT_PUBLIC_STATUS.includes(product.status)) {
        throw new AppError(CODES.NOT_FOUND, '商品不存在或已下架')
      }
      if (!PRODUCT_CONSULTABLE_STATUS.includes(product.status)) {
        throw new AppError(CODES.CONFLICT, `商品当前状态为「${product.status}」，暂不可咨询`)
      }
      return { type: 'product', doc: product, title: product.title }
    }
    const demand = await repo.get('demands', demandId)
    if (!demand) throw new AppError(CODES.NOT_FOUND, '求购不存在或已关闭')
    if (demand.ownerId === uid) throw new AppError(CODES.VALIDATION, '不能响应自己发布的求购')
    /* 保密发布：内容可匿名浏览与站内对话，仅隐藏主体与联系方式（在 chat.open 中脱敏） */
    if (!DEMAND_PUBLIC_STATUS.includes(demand.status)) {
      throw new AppError(CODES.NOT_FOUND, '求购不存在或已关闭')
    }
    if (!DEMAND_CONSULTABLE_STATUS.includes(demand.status)) {
      throw new AppError(CODES.CONFLICT, `求购当前状态为「${demand.status}」，暂不可响应`)
    }
    return { type: 'demand', doc: demand, title: demand.title }
  }

  /**
   * 发布方声明的必须条件必须全部出现；历史数据没有 must 时不强制，避免旧数据无法咨询。
   * 客户端只勾选其中一项就提交，过去能绕过其余必须条件，这里统一兜住。
   */
  function assertCondsComplete(conds, target, hint) {
    const must = target && target.doc && Array.isArray(target.doc.must)
      ? target.doc.must.filter((k) => MUST_CONDITIONS.includes(k))
      : []
    if (!must.length) return
    const filled = new Set((conds || []).map((item) => item.k))
    const missing = must.filter((k) => !filled.has(k))
    if (missing.length) {
      throw new AppError(CODES.VALIDATION, `请先确认必须条件：${missing[0]}，${hint || '再试'}`)
    }
  }

  /**
   * 条件对照表：发布方要求 vs 咨询方填写，逐项给出结论与匹配度。
   */
  function buildCompare(conds, target, profile) {
    const rows = conds.map((cond) => ({
      n: cond.k,
      req: '必须满足',
      filled: '已确认满足',
      res: '满足',
      note: cond.note || ''
    }))
    if (target && target.doc && target.doc.city) {
      const city = profile && profile.city ? profile.city : ''
      rows.push({
        n: '所在地',
        req: target.doc.city,
        filled: city || '未填写',
        res: city && city === target.doc.city ? '一致' : '不同城市',
        note: ''
      })
    }
    const met = rows.filter((row) => row.res === '满足' || row.res === '一致').length
    return { rows, matchPct: rows.length ? Math.round((met / rows.length) * 100) : 60 }
  }

  /**
   * 咨询判档：consult.submit 与 chat.open 共用同一套规则与统计口径。
   * 详情页「联系货主」不再以默认档直接建线索，避免绕过 P0 规则。
   * 没有手机号时只跳过手机号类条件，其余规则照常生效，防止空值误伤全部直聊。
   */
  async function judgeConsult({ uid, target, text, phone, phoneBidx }) {
    let rules = await loadRuleSnapshot()
    if (!phone) {
      rules = rules.map((rule) => {
        const cond = Object.assign({}, rule.cond || {})
        delete cond.phoneInvalid
        delete cond.blockedPhoneBidx
        return Object.assign({}, rule, { cond })
      })
    }
    /* 上下文全部由服务端统计，客户端上报的计数一律不采信 */
    const since = now() - 24 * 60 * 60 * 1000
    const recent = await repo.find('leads', { uid, createdAt: { $gte: since } }, { limit: 200 })
    const cats = new Set()
    if (target && target.doc && target.doc.cat) cats.add(target.doc.cat)
    for (const item of recent) {
      if (!item) continue
      const doc = item.productId
        ? await repo.get('products', item.productId)
        : await repo.get('demands', item.demandId)
      if (doc && doc.cat) cats.add(doc.cat)
    }
    const materialCount = await repo.count('files', { ownerUid: uid })
    return judgeTier({
      rules,
      context: {
        text: [text || '', (target && target.title) || ''].join(' '),
        materialCount,
        perDayCount: recent.length,
        crossCategoryCount: cats.size,
        phone,
        phoneBidx,
        category: (target && target.doc && target.doc.cat) || '',
        budget: Number((target && target.doc && target.doc.budget) || 0)
      }
    })
  }

  /**
   * 联系方式不再拦截：用户可以在标题、说明、备注、留言里直接留手机号 / 微信号，
   * 平台照常收单。这里保留函数签名，避免各业务入参调用点全部改写。
   */
  function assertNoContactInText() {}

  /** 读取当前生效的规则快照（判档必须基于快照，保证幂等） */
  async function loadRuleSnapshot() {
    const rows = await repo.find('rules', {}, { limit: 200 })
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      tier: r.tier,
      scope: r.scope || 'global',
      scopeKey: r.scopeKey || '',
      enabled: r.enabled !== false,
      version: r.version || 1,
      cond: r.cond || {}
    }))
  }

  return {
    /** 用户登录：按 openid 建 / 更新用户，返回不含权限敏感字段的资料 */
    'auth.login': async (data, ctx) => {
      const nick = str(data.nick, { field: '昵称', max: 24 })
      const avatar = str(data.avatar, { field: '头像', max: 512 })
      let user = await repo.get('users', ctx.openid)
      if (!user) {
        user = {
          id: ctx.openid,
          openid: ctx.openid,
          nick: nick || '用户' + String(ctx.openid).slice(-4),
          avatar,
          phoneCipher: null,
          phoneBidx: null,
          realname: null,
          status: '正常',
          createdAt: now()
        }
        try {
          await repo.insert('users', user)
        } catch (err) {
          /* 并发首登：唯一索引冲突说明另一请求已建号，回读即可，不能把 500 抛给用户 */
          if (!err || err.code !== CODES.CONFLICT) throw err
          const again = await repo.get('users', ctx.openid)
          if (!again) throw err
          user = again
        }
      } else if (nick || avatar) {
        const patch = {}
        if (nick) patch.nick = nick
        if (avatar) patch.avatar = avatar
        await repo.updateWhere('users', { id: user.id }, patch)
        user = Object.assign({}, user, patch)
      }
      /* 登录也拦一道：停用账号不应拿到任何用户端数据 */
      if (user.status === '停用') throw new AppError(CODES.FORBIDDEN, '账号已停用，请联系平台客服')
      const profile = await readProfile(user.id)
      return buildProfileView(user, profile)
    },

    /**
     * 微信手机号快捷验证：客户端 button open-type="getPhoneNumber" 拿到 code，
     * 服务端换出号码后与 profile.save 同一口径加密落库，只回脱敏值。
     */
    'auth.phone': async (data, ctx) => {
      const user = await mustUser(ctx)
      const code = str(data.code, { field: '手机号授权凭证', required: true, max: 256 })
      if (typeof exchangePhone !== 'function') {
        throw new AppError(CODES.INTERNAL, '当前环境未开通手机号授权，请联系平台客服')
      }
      let phone = ''
      try {
        phone = normalizePhone(await exchangePhone(code))
      } catch (err) {
        if (err instanceof AppError) throw err
        throw new AppError(CODES.VALIDATION, '手机号授权失败，请重新授权')
      }
      await repo.updateWhere('users', { id: user.id }, {
        phoneCipher: encryptField({ keys, value: phone, aad: phoneAad(user.id) }),
        phoneBidx: blindIndex({ keys, value: phone })
      })
      return { hasPhone: true, phoneMasked: maskPhone(phone) }
    },

    /**
     * 手动填写手机号：微信手机号快捷验证不可用（未开通 / 额度耗尽 / 用户拒绝）时的兜底。
     * 只写手机号两个字段，不改主体资料，避免误清空老用户已填内容；同样加密落库并留审计。
     */
    'auth.phoneManual': async (data, ctx) => {
      const user = await mustUser(ctx)
      const phone = normalizePhone(str(data.phone, { field: '手机号', required: true, max: 20 }))
      await repo.updateWhere('users', { id: user.id }, {
        phoneCipher: encryptField({ keys, value: phone, aad: phoneAad(user.id) }),
        phoneBidx: blindIndex({ keys, value: phone })
      })
      await appendAudit(repo, {
        actorType: 'user',
        actorId: user.id,
        action: 'auth.phoneManual',
        target: user.id,
        reason: '微信手机号授权未成功，用户手动填写',
        result: 'allow',
        at: now()
      })
      return { hasPhone: true, phoneMasked: maskPhone(phone) }
    },

    /**
     * 微信订阅消息配置：模板 ID 由管理端「平台设置」下发，环境变量兜底。
     * 前端只有拿到模板 ID 才能拉起订阅授权，不能内置占位模板。
     */
    'notify.config': async () => {
      const site = await readSiteSettings()
      return {
        inquiry: String(site.tmplInquiry || env.SUBSCRIBE_TMPL_INQUIRY || ''),
        chat: String(site.tmplChat || env.SUBSCRIBE_TMPL_CHAT || ''),
        system: String(site.tmplSystem || env.SUBSCRIBE_TMPL_SYSTEM || ''),
        biz: String(site.tmplBiz || env.SUBSCRIBE_TMPL_BIZ || ''),
        chatPage: 'pages/msg/msg'
      }
    },

    /** 消息提醒偏好的读取（商机消息默认开启，用户可在设置里关闭） */
    'notify.prefs': async (data, ctx) => {
      const user = await mustUser(ctx)
      return { biz: user.notifyBiz !== false }
    },

    /** 保存消息提醒偏好：只影响微信推送，站内消息始终保留 */
    'notify.save': async (data, ctx) => {
      const user = await mustUser(ctx)
      const biz = data.biz !== false
      await repo.updateWhere('users', { id: user.id }, { notifyBiz: biz })
      return { biz }
    },

    'profile.get': async (data, ctx) => {
      const user = await mustUser(ctx)
      const profile = await readProfile(user.id)
      return buildProfileView(user, profile)
    },

    /**
     * 手机号字段级加密 + 盲索引；返回脱敏手机号。
     * 联系人、主体名称等同样按敏感字段处理。
     */
    'profile.save': async (data, ctx) => {
      const user = await mustUser(ctx)
      const nick = data.nick === undefined ? undefined : str(data.nick, { field: '昵称', max: 24 })
      const subject = str(data.subject, { field: '主体名称', max: 60 })
      const subjectType = data.subjectType ? enumOf(data.subjectType, SUBJECT_TYPES, '主体类型') : ''
      const subjectKind = data.subjectKind
        ? enumOf(data.subjectKind, SUBJECT_KINDS, '主体类别')
        : ''
      const contact = str(data.contact, { field: '联系备注', max: 60 })
      /* 职位 / 身份：选填，最长 20 字，不参与发布拦截 */
      const position = str(data.position, { field: '职位', max: 20 })
      assertNoContactInText(subject, '主体名称')
      assertNoContactInText(contact, '联系备注')
      assertNoContactInText(position, '职位')
      const city = str(data.city, { field: '城市', max: 20 })
      const realname = str(data.realname, { field: '联系人', max: 20 })
      const exposureInput = data.exposure === undefined || data.exposure === ''
        ? ''
        /* 历史「对接后可见」按「不公开主体」处理，避免旧客户端保存时报错 */
        : enumOf(data.exposure === 'matched' ? EXPOSURES.HIDDEN : data.exposure, Object.values(EXPOSURES), '公开范围')

      const userPatch = {}
      if (nick !== undefined) userPatch.nick = nick
      if (realname) {
        /* 联系人姓名按敏感字段加密落库，明文只留在本次响应里给本人 */
        Object.assign(userPatch, encryptFields({
          keys, collection: 'users', recordId: user.id, fields: { realname }
        }))
        userPatch.realname = null
      } else if (data.realname !== undefined) {
        userPatch.realnameCipher = null
        userPatch.realname = null
      }

      if (data.phone !== undefined && String(data.phone).trim() !== '') {
        const phone = normalizePhone(data.phone)
        userPatch.phoneCipher = encryptField({ keys, value: phone, aad: phoneAad(user.id) })
        userPatch.phoneBidx = blindIndex({ keys, value: phone })
      }
      if (Object.keys(userPatch).length) {
        await repo.updateWhere('users', { id: user.id }, userPatch)
      }

      const existing = await readProfile(user.id)
      /* 老数据里的 matched 不再回写：未显式传值时也归一成 hidden */
      const prevExposure = existing && existing.exposure === EXPOSURES.OPEN ? EXPOSURES.OPEN : EXPOSURES.HIDDEN
      const quals = normalizeQuals(data.quals, existing)
      const patch = {
        subjectType,
        /* 未传主体类别时保留原值：登录等只改手机号的保存不能把类别清空 */
        subjectKind: subjectKind || (existing && existing.subjectKind) || '',
        /* 职位 / 身份：选填可清空；未传时保留原值 */
        position: data.position === undefined ? ((existing && existing.position) || '') : position,
        city,
        quals,
        /* 未显式传值时保留原设置；首次保存默认「不公开主体」，不改变老用户口径 */
        exposure: exposureInput || prevExposure,
        joined: existing && existing.joined ? existing.joined : new Date(now()).toISOString().slice(0, 10)
      }
      /* 自愿公开联系电话：只有「公开主体」档才生效，其他档一律落 false，避免口径漂移 */
      if (data.phonePublic !== undefined) {
        patch.phonePublic = data.phonePublic === true && patch.exposure === EXPOSURES.OPEN
      } else if (existing) {
        patch.phonePublic = existing.phonePublic === true
      } else {
        patch.phonePublic = false
      }
      /* 主体名称、联系备注同为敏感字段：只落密文，历史明文字段置空 */
      Object.assign(patch, encryptFields({
        keys, collection: 'profiles', recordId: user.id, fields: { subject, contact }
      }))
      patch.subject = null
      patch.contact = null
      if (!subject) patch.subjectCipher = null
      if (!contact) patch.contactCipher = null
      if (existing) await repo.updateWhere('profiles', { uid: user.id }, patch)
      else {
        try {
          await repo.insert('profiles', Object.assign({ id: user.id, uid: user.id }, patch))
        } catch (err) {
          /* 并发首存：唯一索引冲突时退化为更新，避免用户看到 500 且数据半写 */
          if (!err || err.code !== CODES.CONFLICT) throw err
          await repo.updateWhere('profiles', { uid: user.id }, patch)
        }
      }
      /* 冗余到 users：客服列表 / 商品池 / 委托单只查一份即可看到「已隐藏」状态 */
      await repo.updateWhere('users', { id: user.id }, { exposure: patch.exposure })

      const nextUser = (await repo.get('users', user.id)) || user
      const nextProfile = await readProfile(user.id)
      return buildProfileView(nextUser, nextProfile)
    },

    /**
     * 公开范围：只改主体曝光与联系电话开关，不触碰主体 / 资质等档案字段。
     * 单独成接口，避免设置页用 profile.save 整档保存把未填写的档案清空。
     */
    'profile.privacy': async (data, ctx) => {
      const user = await mustUser(ctx)
      const existing = await readProfile(user.id)
      const prevExposure = existing && existing.exposure === EXPOSURES.OPEN ? EXPOSURES.OPEN : EXPOSURES.HIDDEN
      const exposure = data.exposure === undefined || data.exposure === ''
        ? prevExposure
        /* 历史「对接后可见」按「不公开主体」处理 */
        : enumOf(data.exposure === 'matched' ? EXPOSURES.HIDDEN : data.exposure, Object.values(EXPOSURES), '公开范围')
      const prevPhone = !!(existing && existing.phonePublic === true)
      const phoneInput = data.phonePublic === undefined ? prevPhone : data.phonePublic === true
      /* 只有「公开主体」档联系电话才真正生效，其他档一律落 false，避免口径漂移 */
      const patch = {
        exposure,
        phonePublic: phoneInput && exposure === EXPOSURES.OPEN
      }
      if (existing) await repo.updateWhere('profiles', { uid: user.id }, patch)
      else {
        try {
          await repo.insert('profiles', Object.assign({
            id: user.id,
            uid: user.id,
            subjectType: '',
            subjectKind: '',
            city: '',
            quals: [],
            joined: new Date(now()).toISOString().slice(0, 10)
          }, patch))
        } catch (err) {
          /* 并发首存：唯一索引冲突时退化为更新 */
          if (!err || err.code !== CODES.CONFLICT) throw err
          await repo.updateWhere('profiles', { uid: user.id }, patch)
        }
      }
      /* 冗余到 users：客服列表 / 商品池 / 委托单只查一份即可看到公开状态 */
      await repo.updateWhere('users', { id: user.id }, { exposure: patch.exposure })
      return { exposure: patch.exposure, phonePublic: patch.phonePublic }
    },

    /**
     * 首次发布商品时，把表单里填写的主体名称回填到个人信息。
     * 仅在个人信息还没有主体名称时生效；后续商品内修改不再回写，避免覆盖用户档案。
     */
    'profile.bootstrapSubject': async (data, ctx) => {
      const user = await mustUser(ctx)
      const subject = str(data.subject, { field: '主体名称', max: 60 })
      if (!subject) return { updated: false }
      assertNoContactInText(subject, '主体名称')
      const existing = await readProfile(user.id)
      if (String(decryptProfileField(existing, 'subject') || '').trim()) {
        return { updated: false, reason: 'already_set' }
      }
      const patch = {}
      Object.assign(patch, encryptFields({
        keys, collection: 'profiles', recordId: user.id, fields: { subject }
      }))
      patch.subject = null
      if (existing) {
        await repo.updateWhere('profiles', { uid: user.id }, patch)
      } else {
        Object.assign(patch, {
          id: user.id,
          uid: user.id,
          subjectType: '',
          city: '',
          quals: [],
          exposure: EXPOSURES.HIDDEN,
          phonePublic: false,
          joined: new Date(now()).toISOString().slice(0, 10)
        })
        try {
          await repo.insert('profiles', patch)
        } catch (err) {
          /* 并发首存：唯一索引冲突时退化为更新 */
          if (!err || err.code !== CODES.CONFLICT) throw err
          delete patch.id
          delete patch.uid
          await repo.updateWhere('profiles', { uid: user.id }, patch)
        }
      }
      return { updated: true }
    },

    /**
     * 材料临时链接：只允许本人文件，5 分钟有效，绑定 uid + leadId。
     * 链接带签名，篡改 / 过期 / 换人全部拒绝。
     */
    'material.sign': async (data, ctx) => {
      const uid = ctx.openid
      const fileId = str(data.fileId, { field: '文件', required: true, max: 1024 })
      const leadId = str(data.leadId, { field: '线索', required: true, max: 64 })
      const lead = await repo.get('leads', leadId)
      if (!lead || lead.uid !== uid) throw new AppError(CODES.FORBIDDEN, '只能查看本人咨询关联的材料')

      const rows = await repo.find('files', { storagePath: fileId }, { limit: 1 })
      let file = rows[0]
      if (!file) {
        assertOwnedStoragePath(fileId, uid)
        /* 文件元信息只解析一次，避免重复校验与不一致 */
        const meta = assertMaterialFile({
          name: data.name || fallbackFileName(fileId),
          size: data.size,
          type: data.type
        })
        file = {
          id: randomId('F'),
          ownerUid: uid,
          leadId,
          name: meta.name,
          size: meta.size,
          type: meta.type,
          storagePath: fileId,
          createdAt: now()
        }
        try {
          await repo.insert('files', file)
        } catch (err) {
          /* 并发重复点击：storagePath 唯一约束冲突时回读已有记录，保证幂等 */
          if (!err || err.code !== CODES.CONFLICT) throw err
          const again = await repo.find('files', { storagePath: fileId }, { limit: 1 })
          if (!again[0]) throw err
          file = again[0]
        }
      }
      if (file.ownerUid !== uid) throw new AppError(CODES.FORBIDDEN, '只能查看本人上传的材料')
      if (file.leadId && file.leadId !== leadId) throw new AppError(CODES.FORBIDDEN, '材料与当前线索不匹配')

      const at = now()
      const exp = at + MATERIAL_LINK_TTL_MS
      const link = signMaterialLink({ keys, fileId: file.id, uid, leadId, exp, storagePath: file.storagePath })
      assertNoPublicUrl(link.url)
      const watermark = watermarkText(uid, leadId, at)
      /* 每次取用材料都留痕：谁、何时、看了哪条线索的哪份材料（不落文件名，避免夹带敏感信息） */
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'material.sign',
          target: `${leadId}:${file.id}`,
          reason: '材料临时链接（5 分钟）',
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 取用留痕失败不能让签链接本身失败，用户拿不到链接却查不出原因 */
      }
      return {
        url: link.url,
        exp,
        expiresIn: MATERIAL_LINK_TTL_MS / 1000,
        watermark,
        name: sanitizeFileName(file.name),
        size: file.size,
        type: file.type,
        /* 防下载 / 防截屏的客户端契约 */
        allowDownload: false,
        allowSave: false,
        watermarkRequired: true,
        screenshotGuard: true
      }
    },

    /**
     * 发布商品：出售 / 出租。
     * data.draft = true 时按「草稿」保存（字段可不全，不对外展示）；
     * 否则直接发布上架（状态：在售）。
     */
    'product.publish': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      const isDraft = data.draft === true || data.draft === 'true' || data.draft === 1
      /* 草稿只是暂存、不对外展示：没有实名也可以先存，正式发布前再补资料 */
      if (!isDraft) await assertProfileReady(uid, user)
      assertNoContactInText(
        [data.title, data.note, data.accept, data.requirements, data.limit, data.must, data.nego, data.flow],
        '发布内容'
      )
      if (!isDraft) await assertCanJoinPool(uid, data)
      const at = now()
      const doc = buildProduct(data, uid, at, { relaxed: isDraft })
      doc.id = doc.id || randomId('P')
      doc.status = isDraft ? PRODUCT_STATUS.DRAFT : PRODUCT_STATUS.ON_SALE
      if (!isDraft) {
        doc.reviewedAt = at
        doc.reviewedBy = 'auto'
      }
      doc.createdAt = at
      doc.views = 0
      /* 自动基础审核：发布即在售，系统把可疑内容标记进风险池供人工可选复核。
         命中风险不阻断发布、不影响展示，只有人工明确打回才改状态。 */
      if (!isDraft) {
        const risk = detectRisk(doc, { sameModelCount: await sameModelCountOf('products', uid, doc.model, at) })
        doc.riskStatus = risk.riskStatus
        doc.riskHits = risk.riskHits
        doc.riskCheckedAt = at
      }
      /* 草稿覆盖同一条：同一货主把草稿改好后再存一次，不应产生第二条记录 */
      const existing = doc.id ? await repo.get('products', doc.id) : null
      if (existing) {
        if (existing.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能修改自己发布的商品')
        if ([PRODUCT_STATUS.DRAFT, PRODUCT_STATUS.REJECTED].indexOf(existing.status) < 0) {
          throw new AppError(CODES.CONFLICT, `商品当前状态为「${existing.status}」，不能直接改写`)
        }
        const patch = Object.assign({}, doc, { id: existing.id, createdAt: existing.createdAt })
        /* 草稿再次保存时未带可见范围：沿用原值，避免保密内容被改回公开 */
        if (data.visibility === undefined) patch.visibility = existing.visibility || VISIBILITIES.PUBLIC
        delete patch.updatedAt
        await repo.updateWhere('products', { id: existing.id, status: existing.status }, patch)
        let stockSynced = false
        if (!isDraft && data.syncStock === true && patch.tradeMode === '出售') {
          stockSynced = await syncStockFromProduct(patch, uid, at)
        }
        /* 正式发布进商机池：给发布者与匹配会员各发一次提醒 */
        if (!isDraft) await notifyBizPool('product', patch, at)
        return {
          id: existing.id,
          tradeMode: doc.tradeMode,
          status: patch.status,
          visibility: patch.visibility,
          visibilityLabel: VISIBILITY_LABELS[patch.visibility],
          stockSynced
        }
      }
      /* 先做输出投影的泄漏校验，再落库：脏数据一旦入库会让所有人的列表投影失败 */
      assertNoPlaintextContact(projectProduct(doc))
      await repo.insert('products', doc)
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'product.publish',
          target: doc.id,
          reason: doc.tradeMode,
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 发布已落库：留痕失败不能把请求变成失败，否则用户重发会造成重复发布 */
      }
      let stockSynced = false
      if (!isDraft && data.syncStock === true && doc.tradeMode === '出售') {
        stockSynced = await syncStockFromProduct(doc, uid, at)
      }
      if (!isDraft) await notifyBizPool('product', doc, at)
      return {
        id: doc.id,
        tradeMode: doc.tradeMode,
        status: doc.status,
        visibility: doc.visibility,
        visibilityLabel: VISIBILITY_LABELS[doc.visibility],
        stockSynced
      }
    },

    /**
     * 提交商品：草稿 / 已驳回 → 直接发布（在售）。
     * 审核不是发布的前置路径——发布即可见，平台可在后台改状态或下架。
     * 提交时按完整口径重新校验一遍，字段不全直接提示补齐。
     */
    'product.submit': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id || data.productId, { field: '商品', required: true, max: 64 })
      const product = await repo.get('products', id)
      if (!product) throw new AppError(CODES.NOT_FOUND, '商品不存在')
      if (product.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能提交自己发布的商品')
      if ([PRODUCT_STATUS.DRAFT, PRODUCT_STATUS.REJECTED].indexOf(product.status) < 0) {
        throw new AppError(CODES.CONFLICT, `商品当前状态为「${product.status}」，无需重新发布`)
      }
      /* 草稿转正式发布：主体信息与联系方式必须齐全，否则发布出去无法对接 */
      await assertProfileReady(uid)
      /* 草稿字段可能不全：先按宽松口径取回已存内容，再走完整校验 */
      const payload = productPayloadOf(product)
      const checked = buildProduct(payload, uid, now(), { relaxed: false })
      /* 草稿期间若把主体改为非公开，转正式发布时自动退出商机池（普通发布不受影响） */
      checked.channel = product.channel || checked.channel
      checked.bizPool = product.bizPool === true
      if (checked.visibility === VISIBILITIES.PRIVATE) {
        checked.channel = PUBLISH_CHANNELS.NORMAL
        checked.bizPool = false
      } else if (checked.channel !== PUBLISH_CHANNELS.NORMAL) {
        const profile = await readProfile(uid)
        if (String((profile && profile.exposure) || '') !== EXPOSURES.OPEN) {
          checked.channel = PUBLISH_CHANNELS.NORMAL
          checked.bizPool = false
        }
      }
      const at = now()
      const res = await repo.updateWhere(
        'products',
        { id, status: product.status },
        {
          status: PRODUCT_STATUS.ON_SALE,
          visibility: checked.visibility,
          channel: checked.channel,
          bizPool: checked.bizPool,
          title: checked.title,
          cat: checked.cat,
          brand: checked.brand,
          model: checked.model,
          qty: checked.qty,
          minQty: checked.minQty,
          price: checked.price,
          priceUnit: checked.priceUnit,
          currency: checked.currency,
          currencySymbol: checked.currencySymbol,
          currencyLabel: checked.currencyLabel,
          tax: checked.tax,
          supply: checked.supply,
          city: checked.city,
          cond: checked.cond,
          deliver: checked.deliver,
          term: checked.term,
          closed: checked.closed,
          deposit: checked.deposit,
          pay: checked.pay,
          rentLimits: checked.rentLimits,
          must: checked.must,
          nego: checked.nego,
          flow: checked.flow,
          note: checked.note,
          accept: checked.accept,
          requirements: checked.requirements,
          limit: checked.limit,
          reviewReason: '',
          reviewedAt: at,
          submittedAt: at
        }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '商品状态已被更新，请刷新后重试')
      await notifyBizPool('product', Object.assign({}, product, checked, { id, status: PRODUCT_STATUS.ON_SALE }), at)
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'product.submit',
          target: id,
          reason: '发布上架',
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 状态已流转：留痕失败不阻断用户 */
      }
      return {
        id,
        status: PRODUCT_STATUS.ON_SALE,
        visibility: checked.visibility,
        visibilityLabel: VISIBILITY_LABELS[checked.visibility]
      }
    },

    /**
     * 发布需求：求购 / 租赁。
     * data.draft = true 时按「草稿」保存；否则直接发布（状态：求购中）。
     */
    'demand.publish': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      const isDraft = data.draft === true || data.draft === 'true' || data.draft === 1
      /* 草稿只是暂存、不对外展示：没有实名也可以先存，正式发布前再补资料 */
      if (!isDraft) await assertProfileReady(uid, user)
      assertNoContactInText(
        [data.title, data.note, data.accept, data.requirements, data.limit, data.must, data.nego, data.flow],
        '发布内容'
      )
      if (!isDraft) await assertCanJoinPool(uid, data)
      const at = now()
      const doc = buildDemand(data, uid, at, { relaxed: isDraft })
      doc.id = doc.id || randomId('D')
      doc.status = isDraft ? DEMAND_STATUS.DRAFT : DEMAND_STATUS.OPEN
      doc.createdAt = at
      doc.views = 0
      /* 自动基础审核：与商品同口径，命中风险只标记进风险池，不阻断发布 */
      if (!isDraft) {
        const risk = detectRisk(doc, { sameModelCount: await sameModelCountOf('demands', uid, doc.model, at) })
        doc.riskStatus = risk.riskStatus
        doc.riskHits = risk.riskHits
        doc.riskCheckedAt = at
      }
      const existing = doc.id ? await repo.get('demands', doc.id) : null
      if (existing) {
        if (existing.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能修改自己发布的需求')
        if ([DEMAND_STATUS.DRAFT, DEMAND_STATUS.REJECTED].indexOf(existing.status) < 0) {
          throw new AppError(CODES.CONFLICT, `需求当前状态为「${existing.status}」，不能直接改写`)
        }
        const patch = Object.assign({}, doc, { id: existing.id, createdAt: existing.createdAt, responses: existing.responses || 0 })
        /* 草稿再次保存时未带可见范围：沿用原值，避免保密内容被改回公开 */
        if (data.visibility === undefined) patch.visibility = existing.visibility || VISIBILITIES.PUBLIC
        await repo.updateWhere('demands', { id: existing.id, status: existing.status }, patch)
        if (!isDraft) await notifyBizPool('demand', patch, at)
        return {
          id: existing.id,
          tradeMode: doc.tradeMode,
          status: patch.status,
          visibility: patch.visibility,
          visibilityLabel: VISIBILITY_LABELS[patch.visibility]
        }
      }
      /* 先校验再落库，避免脏数据入库后拖垮全量列表投影 */
      assertNoPlaintextContact(projectDemand(doc))
      await repo.insert('demands', doc)
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'demand.publish',
          target: doc.id,
          reason: doc.tradeMode,
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 发布已落库：留痕失败不能把请求变成失败，否则用户重发会造成重复发布 */
      }
      if (!isDraft) await notifyBizPool('demand', doc, at)
      return {
        id: doc.id,
        tradeMode: doc.tradeMode,
        status: doc.status,
        visibility: doc.visibility,
        visibilityLabel: VISIBILITY_LABELS[doc.visibility]
      }
    },

    /** 提交需求：草稿 / 已驳回 → 直接发布（求购中）。审核不是发布的前置路径。 */
    'demand.submit': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id || data.demandId, { field: '需求', required: true, max: 64 })
      const demand = await repo.get('demands', id)
      if (!demand) throw new AppError(CODES.NOT_FOUND, '需求不存在')
      if (demand.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能提交自己发布的需求')
      if ([DEMAND_STATUS.DRAFT, DEMAND_STATUS.REJECTED].indexOf(demand.status) < 0) {
        throw new AppError(CODES.CONFLICT, `需求当前状态为「${demand.status}」，无需重新发布`)
      }
      /* 草稿转正式发布：主体信息与联系方式必须齐全 */
      await assertProfileReady(uid)
      const payload = demandPayloadOf(demand)
      const checked = buildDemand(payload, uid, now(), { relaxed: false })
      /* 草稿期间若把主体改为非公开，转正式发布时自动退出商机池（普通发布不受影响） */
      checked.channel = demand.channel || checked.channel
      checked.bizPool = demand.bizPool === true
      if (checked.visibility === VISIBILITIES.PRIVATE) {
        checked.channel = PUBLISH_CHANNELS.NORMAL
        checked.bizPool = false
      } else if (checked.channel !== PUBLISH_CHANNELS.NORMAL) {
        const profile = await readProfile(uid)
        if (String((profile && profile.exposure) || '') !== EXPOSURES.OPEN) {
          checked.channel = PUBLISH_CHANNELS.NORMAL
          checked.bizPool = false
        }
      }
      const at = now()
      const res = await repo.updateWhere(
        'demands',
        { id, status: demand.status },
        {
          status: DEMAND_STATUS.OPEN,
          visibility: checked.visibility,
          channel: checked.channel,
          bizPool: checked.bizPool,
          title: checked.title,
          cat: checked.cat,
          brand: checked.brand,
          model: checked.model,
          qty: checked.qty,
          budget: checked.budget,
          budgetUnit: checked.budgetUnit,
          currency: checked.currency,
          currencySymbol: checked.currencySymbol,
          currencyLabel: checked.currencyLabel,
          tax: checked.tax,
          supply: checked.supply,
          city: checked.city,
          cond: checked.cond,
          term: checked.term,
          closed: checked.closed,
          deposit: checked.deposit,
          pay: checked.pay,
          rentLimits: checked.rentLimits,
          must: checked.must,
          note: checked.note,
          accept: checked.accept,
          sameMachine: checked.sameMachine,
          codeAsk: checked.codeAsk,
          reviewReason: '',
          reviewedAt: at,
          submittedAt: at
        }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '需求状态已被更新，请刷新后重试')
      await notifyBizPool('demand', Object.assign({}, demand, checked, { id, status: DEMAND_STATUS.OPEN }), at)
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'demand.submit',
          target: id,
          reason: '发布上架',
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 状态已流转：留痕失败不阻断用户 */
      }
      return {
        id,
        status: DEMAND_STATUS.OPEN,
        visibility: checked.visibility,
        visibilityLabel: VISIBILITY_LABELS[checked.visibility]
      }
    },

    /**
     * 货主自助下架：在售 / 洽谈中 → 已下架。
     * 洽谈中下架视为放弃本单，联动关闭已对接线索，避免线索悬空。
     * offlineBy 记录「本人下架」，只有本人下架的内容才允许自助重新上架；
     * 平台下架的内容必须联系客服，防止绕过平台处置。
     */
    'product.offline': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id || data.productId, { field: '商品', required: true, max: 64 })
      const product = await repo.get('products', id)
      if (!product) throw new AppError(CODES.NOT_FOUND, '商品不存在')
      if (product.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能下架自己发布的商品')
      if ([PRODUCT_STATUS.ON_SALE, PRODUCT_STATUS.NEGOTIATING].indexOf(product.status) < 0) {
        throw new AppError(CODES.CONFLICT, `商品当前状态为「${product.status}」，不能下架`)
      }
      const reason = str(data.reason, { field: '下架原因', max: 100 }) || '发布方主动下架'
      const at = now()
      const res = await repo.updateWhere(
        'products',
        { id, status: product.status },
        { status: PRODUCT_STATUS.OFFLINE, offlineReason: reason, offlineAt: at, offlineBy: uid }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '商品状态已被更新，请刷新后重试')
      if (product.status === PRODUCT_STATUS.NEGOTIATING) {
        await closeMatchedLeads('productId', id, '货主下架，视为放弃本单', at, uid)
      }
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'product.offline',
          target: `${id}:${product.status}->${PRODUCT_STATUS.OFFLINE}`,
          reason,
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 状态已流转：留痕失败不阻断用户 */
      }
      return { id, from: product.status, to: PRODUCT_STATUS.OFFLINE, reason }
    },

    /** 货主自助重新上架：仅「本人在售时下架」的商品可恢复为在售 */
    'product.online': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id || data.productId, { field: '商品', required: true, max: 64 })
      const product = await repo.get('products', id)
      if (!product) throw new AppError(CODES.NOT_FOUND, '商品不存在')
      if (product.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能上架自己发布的商品')
      if (product.status !== PRODUCT_STATUS.OFFLINE) {
        throw new AppError(CODES.CONFLICT, `商品当前状态为「${product.status}」，不能重新上架`)
      }
      if (product.offlineBy !== uid) {
        throw new AppError(CODES.CONFLICT, '该商品由平台下架，如需恢复请联系客服')
      }
      /* 重新上架等于对外发布：主体信息与联系方式必须齐全 */
      await assertProfileReady(uid)
      const at = now()
      const res = await repo.updateWhere(
        'products',
        { id, status: PRODUCT_STATUS.OFFLINE, offlineBy: uid },
        { status: PRODUCT_STATUS.ON_SALE, offlineReason: '', offlineAt: 0, offlineBy: '' }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '商品状态已被更新，请刷新后重试')
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'product.online',
          target: `${id}:${PRODUCT_STATUS.OFFLINE}->${PRODUCT_STATUS.ON_SALE}`,
          reason: '',
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 状态已流转：留痕失败不阻断用户 */
      }
      return { id, from: PRODUCT_STATUS.OFFLINE, to: PRODUCT_STATUS.ON_SALE }
    },

    /**
     * 货主删除商品：软删除，不再出现在首页 / 商机池 / 我的发布。
     * 洽谈中删除视为放弃本单，联动关闭已对接线索；同步下架关联私库存。
     */
    'product.delete': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id || data.productId, { field: '商品', required: true, max: 64 })
      const product = await repo.get('products', id)
      if (!product || product.deleted === true) throw new AppError(CODES.NOT_FOUND, '商品不存在或已删除')
      if (product.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能删除自己发布的商品')
      const at = now()
      const res = await repo.updateWhere(
        'products',
        { id, ownerId: uid },
        {
          deleted: true,
          deletedAt: at,
          updatedAt: at,
          status: product.status === PRODUCT_STATUS.DEALT ? product.status : PRODUCT_STATUS.OFFLINE,
          offlineReason: '发布方删除',
          offlineAt: at,
          offlineBy: uid
        }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '商品状态已被更新，请刷新后重试')
      if (product.status === PRODUCT_STATUS.NEGOTIATING) {
        await closeMatchedLeads('productId', id, '货主删除商品，视为放弃本单', at, uid)
      }
      /* 私库存只服务商机匹配：商品删除后立即标记失效，避免继续被匹配 */
      try {
        await repo.updateWhere(
          'stocks',
          { sourceProductId: id, ownerId: uid },
          { deleted: true, status: STOCK_STATUS_OFF, updatedAt: at }
        )
      } catch (stockErr) { /* 库存清理失败不影响删除结果 */ }
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'product.delete',
          target: `${id}:${product.status}->已删除`,
          reason: '发布方删除',
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 状态已流转：留痕失败不阻断用户 */
      }
      return { id, deleted: true }
    },

    /**
     * 需求方自助关闭：求购中 / 已对接 → 已关闭。
     * 关闭后不再对外响应；已对接线索一并收尾。
     */
    'demand.close': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id || data.demandId, { field: '需求', required: true, max: 64 })
      const demand = await repo.get('demands', id)
      if (!demand) throw new AppError(CODES.NOT_FOUND, '需求不存在')
      if (demand.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能关闭自己发布的需求')
      if ([DEMAND_STATUS.OPEN, DEMAND_STATUS.MATCHED].indexOf(demand.status) < 0) {
        throw new AppError(CODES.CONFLICT, `需求当前状态为「${demand.status}」，不能关闭`)
      }
      const reason = str(data.reason, { field: '关闭原因', max: 100 }) || '发布方主动关闭'
      const at = now()
      const res = await repo.updateWhere(
        'demands',
        { id, status: demand.status },
        { status: DEMAND_STATUS.CLOSED, closeReason: reason, closedAt: at, closedBy: uid }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '需求状态已被更新，请刷新后重试')
      if (demand.status === DEMAND_STATUS.MATCHED) {
        await closeMatchedLeads('demandId', id, '需求方关闭需求', at, uid)
      }
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'demand.close',
          target: `${id}:${demand.status}->${DEMAND_STATUS.CLOSED}`,
          reason,
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 状态已流转：留痕失败不阻断用户 */
      }
      return { id, from: demand.status, to: DEMAND_STATUS.CLOSED, reason }
    },

    /** 需求方自助重新开启：仅「本人关闭」的需求可恢复为求购中 */
    'demand.reopen': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id || data.demandId, { field: '需求', required: true, max: 64 })
      const demand = await repo.get('demands', id)
      if (!demand) throw new AppError(CODES.NOT_FOUND, '需求不存在')
      if (demand.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能开启自己发布的需求')
      if (demand.status !== DEMAND_STATUS.CLOSED) {
        throw new AppError(CODES.CONFLICT, `需求当前状态为「${demand.status}」，不能重新开启`)
      }
      if (demand.closedBy !== uid) {
        throw new AppError(CODES.CONFLICT, '该需求已由平台关闭或已成交，如需恢复请联系客服')
      }
      /* 重新开启等于对外发布：主体信息与联系方式必须齐全 */
      await assertProfileReady(uid)
      const at = now()
      const res = await repo.updateWhere(
        'demands',
        { id, status: DEMAND_STATUS.CLOSED, closedBy: uid },
        { status: DEMAND_STATUS.OPEN, closeReason: '', closedAt: 0, closedBy: '' }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '需求状态已被更新，请刷新后重试')
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'demand.reopen',
          target: `${id}:${DEMAND_STATUS.CLOSED}->${DEMAND_STATUS.OPEN}`,
          reason: '',
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 状态已流转：留痕失败不阻断用户 */
      }
      return { id, from: DEMAND_STATUS.CLOSED, to: DEMAND_STATUS.OPEN }
    },

    /**
     * 需求方删除需求：软删除，不再出现在求购列表 / 商机池 / 我的发布。
     * 已对接时联动关闭线索，避免响应方一直等待。
     */
    'demand.delete': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id || data.demandId, { field: '需求', required: true, max: 64 })
      const demand = await repo.get('demands', id)
      if (!demand || demand.deleted === true) throw new AppError(CODES.NOT_FOUND, '需求不存在或已删除')
      if (demand.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能删除自己发布的需求')
      const at = now()
      const res = await repo.updateWhere(
        'demands',
        { id, ownerId: uid },
        {
          deleted: true,
          deletedAt: at,
          updatedAt: at,
          status: DEMAND_STATUS.CLOSED,
          closeReason: '发布方删除',
          closedAt: at,
          closedBy: uid
        }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '需求状态已被更新，请刷新后重试')
      if (demand.status === DEMAND_STATUS.MATCHED) {
        await closeMatchedLeads('demandId', id, '需求方删除需求', at, uid)
      }
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'demand.delete',
          target: `${id}:${demand.status}->已删除`,
          reason: '发布方删除',
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 状态已流转：留痕失败不阻断用户 */
      }
      return { id, deleted: true }
    },

    /**
     * 编辑回填：只给属主返回一条完整字段（对外投影不含媒体、备注等编辑所需字段）。
     * 白名单取字段，ownerId 与任何密文都不下发。
     */
    'mine.publish.detail': async (data, ctx) => {
      const uid = ctx.openid
      const kind = data.kind === 'demand' ? 'demand' : 'product'
      const id = str(data.id, { field: kind === 'demand' ? '需求' : '商品', required: true, max: 64 })
      const doc = await repo.get(kind === 'demand' ? 'demands' : 'products', id)
      if (!doc) throw new AppError(CODES.NOT_FOUND, kind === 'demand' ? '需求不存在' : '商品不存在')
      if (doc.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能查看自己发布的内容')
      const fields = kind === 'demand' ? DEMAND_OWNER_FIELDS : PRODUCT_OWNER_FIELDS
      const out = {}
      fields.forEach((k) => {
        if (doc[k] !== undefined) out[k] = doc[k]
      })
      return out
    },

    /**
     * 编辑商品：只更新内容字段，不改状态（在售仍在上架、草稿仍是草稿）。
     * 已成交等终态不允许编辑，避免绕过状态流转；仅属主可改。
     */
    'product.update': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id, { field: '商品', required: true, max: 64 })
      const product = await repo.get('products', id)
      if (!product) throw new AppError(CODES.NOT_FOUND, '商品不存在')
      /* 先判属主再判实名：非属主统一回 FORBIDDEN，不暴露账号资料状态 */
      if (product.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能编辑自己发布的商品')
      const user = await mustUser(ctx)
      /* 编辑即对外可见：主体信息与联系方式必须齐全 */
      await assertProfileReady(uid, user)
      if (PRODUCT_EDITABLE_STATUS.indexOf(product.status) < 0) {
        throw new AppError(CODES.CONFLICT, `商品当前状态为「${product.status}」，不能编辑`)
      }
      assertNoContactInText(
        [data.title, data.note, data.accept, data.requirements, data.limit, data.must, data.nego, data.flow],
        '编辑内容'
      )
      /* 编辑页没有的字段（说明 / 验收 / 接单要求 / 租赁限制）沿用原值，避免保存时被清空 */
      const merged = Object.assign({}, data, {
        /* 编辑页未提交可见范围时沿用原值，避免保密内容被改回公开 */
        visibility: data.visibility !== undefined ? data.visibility : (product.visibility || VISIBILITIES.PUBLIC),
        note: data.note !== undefined ? data.note : product.note,
        accept: data.accept !== undefined ? data.accept : product.accept,
        requirements: data.requirements !== undefined ? data.requirements : product.requirements,
        limit: data.limit !== undefined ? data.limit : product.limit,
        rentLimits: Array.isArray(data.rentLimits) ? data.rentLimits : (product.rentLimits || [])
      })
      const checked = buildProduct(merged, uid, now(), { relaxed: false })
      const patch = {
        visibility: checked.visibility,
        tradeMode: checked.tradeMode,
        title: checked.title,
        cat: checked.cat,
        brand: checked.brand,
        model: checked.model,
        qty: checked.qty,
        minQty: checked.minQty,
        price: checked.price,
        priceUnit: checked.priceUnit,
        currency: checked.currency,
        currencySymbol: checked.currencySymbol,
        currencyLabel: checked.currencyLabel,
        supply: checked.supply,
        tax: checked.tax,
        deliver: checked.deliver,
        cond: checked.cond,
        city: checked.city,
        term: checked.term,
        closed: checked.closed,
        deposit: checked.deposit,
        pay: checked.pay,
        rentLimits: checked.rentLimits,
        must: checked.must,
        nego: checked.nego,
        flow: checked.flow,
        note: checked.note,
        accept: checked.accept,
        requirements: checked.requirements,
        limit: checked.limit,
        /* 编辑页不回传媒体时保留已上传原件，避免保存后清空 */
        media: data.media !== undefined ? checked.media : (product.media || [])
      }
      /* 编辑后重新做一次风险识别：防止先发正常内容过审，再改成违规内容 */
      const at = now()
      const risk = detectRisk(Object.assign({}, product, patch), {
        sameModelCount: await sameModelCountOf('products', uid, patch.model, at)
      })
      patch.riskStatus = risk.riskStatus
      patch.riskHits = risk.riskHits
      patch.riskCheckedAt = at
      assertNoPlaintextContact(projectProduct(Object.assign({}, product, patch)))
      const res = await repo.updateWhere(
        'products',
        { id, ownerId: uid, status: product.status },
        patch
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '商品已被更新，请刷新后重试')
      /* 库存跟着商品走：已有库存行才同步，改为非出售 / 非在售时下架库存，避免商机匹配到旧货 */
      const stockId = `sk_${id}`
      const stock = await repo.get('stocks', stockId)
      if (stock && stock.ownerId === uid) {
        if (checked.tradeMode === '出售' && product.status === PRODUCT_STATUS.ON_SALE) {
          await syncStockFromProduct(Object.assign({}, product, patch), uid, at)
        } else {
          await repo.updateWhere('stocks', { id: stockId, ownerId: uid }, {
            status: STOCK_STATUS_OFF,
            updatedAt: at
          })
        }
      }
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'product.update',
          target: id,
          reason: '编辑商品',
          result: 'allow',
          at: now()
        })
      } catch (auditErr) {
        /* 内容已保存：留痕失败不阻断用户 */
      }
      return {
        id,
        status: product.status,
        visibility: checked.visibility,
        visibilityLabel: VISIBILITY_LABELS[checked.visibility]
      }
    },

    /** 编辑需求：口径同 product.update，只改内容不改状态 */
    'demand.update': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id, { field: '需求', required: true, max: 64 })
      const demand = await repo.get('demands', id)
      if (!demand) throw new AppError(CODES.NOT_FOUND, '需求不存在')
      /* 先判属主再判实名：非属主统一回 FORBIDDEN，不暴露账号资料状态 */
      if (demand.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能编辑自己发布的需求')
      const user = await mustUser(ctx)
      /* 编辑即对外可见：主体信息与联系方式必须齐全 */
      await assertProfileReady(uid, user)
      if (DEMAND_EDITABLE_STATUS.indexOf(demand.status) < 0) {
        throw new AppError(CODES.CONFLICT, `需求当前状态为「${demand.status}」，不能编辑`)
      }
      assertNoContactInText(
        [data.title, data.note, data.accept, data.must, data.flow],
        '编辑内容'
      )
      /* 需求侧的必须条件由「供给类型 / 同台互验 / 暗语视频」联动生成，
         这两个开关不在编辑页里，按原值参与重建，避免条件被默认值改写 */
      const merged = Object.assign({}, data, {
        /* 编辑页未提交可见范围时沿用原值，避免保密内容被改回公开 */
        visibility: data.visibility !== undefined ? data.visibility : (demand.visibility || VISIBILITIES.PUBLIC),
        sameMachine: demand.sameMachine !== false,
        codeAsk: demand.codeAsk !== false,
        note: data.note !== undefined ? data.note : demand.note,
        accept: data.accept !== undefined ? data.accept : demand.accept,
        rentLimits: Array.isArray(data.rentLimits) ? data.rentLimits : (demand.rentLimits || [])
      })
      const checked = buildDemand(merged, uid, now(), { relaxed: false })
      const patch = {
        visibility: checked.visibility,
        tradeMode: checked.tradeMode,
        title: checked.title,
        cat: checked.cat,
        brand: checked.brand,
        model: checked.model,
        qty: checked.qty,
        budget: checked.budget,
        budgetUnit: checked.budgetUnit,
        currency: checked.currency,
        currencySymbol: checked.currencySymbol,
        currencyLabel: checked.currencyLabel,
        supply: checked.supply,
        tax: checked.tax,
        cond: checked.cond,
        city: checked.city,
        term: checked.term,
        closed: checked.closed,
        deposit: checked.deposit,
        pay: checked.pay,
        rentLimits: checked.rentLimits,
        must: checked.must,
        note: checked.note,
        accept: checked.accept,
        /* 编辑页不回传媒体时保留已上传原件，避免保存后清空 */
        media: data.media !== undefined ? checked.media : (demand.media || [])
      }
      assertNoPlaintextContact(projectDemand(Object.assign({}, demand, patch)))
      const res = await repo.updateWhere(
        'demands',
        { id, ownerId: uid, status: demand.status },
        patch
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '需求已被更新，请刷新后重试')
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'demand.update',
          target: id,
          reason: '编辑需求',
          result: 'allow',
          at: now()
        })
      } catch (auditErr) {
        /* 内容已保存：留痕失败不阻断用户 */
      }
      return {
        id,
        status: demand.status,
        visibility: checked.visibility,
        visibilityLabel: VISIBILITY_LABELS[checked.visibility]
      }
    },

    'product.list': async (data, ctx) => {
      const uid = ctx && ctx.openid
      const paging = normalizePaging(data)
      if (paging.capped) {
        return { items: [], page: paging.page, limit: paging.limit, total: 0, hasMore: false, truncated: true }
      }
      const mineOnly = data.mine === true || data.mine === 'true' || data.mine === 1
      const query = { deleted: { $ne: true } }
      if (mineOnly) {
        /* 「我发布的」必须绑定本人，否则会越权看到全量任意状态 */
        if (!uid) throw new AppError(CODES.UNAUTHENTICATED, '请先登录')
        query.ownerId = uid
        if (data.status) query.status = enumOf(data.status, Object.values(PRODUCT_STATUS), '状态')
      } else {
        query.status = PRODUCT_STATUS.ON_SALE
        /* 私密发布＝匿名公开：内容照常进公开列表，只隐藏发布者身份与主页入口 */
        /* 仅商机发布不进入普通列表，只在商机池按型号匹配 */
        query.channel = { $ne: PUBLISH_CHANNELS.POOL }
      }
      if (data.tradeMode) query.tradeMode = enumOf(data.tradeMode, TRADE_MODE_OPTIONS.supply, '交易方式')
      if (data.cat) query.cat = str(data.cat, { field: '品类', max: 30 })
      if (data.city) query.city = str(data.city, { field: '城市', max: 20 })
      if (data.q) {
        query.title = {
          $regex: str(data.q, { field: '关键词', max: 30 }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i'
        }
      }
      /* 基础数据与浏览者无关：保密条目按匿名口径投影，属主归属在下面按请求者叠加 */
      const loadBase = async () => {
        const total = await repo.count('products', query)
        const rows = await repo.find('products', query, {
          sort: { field: 'createdAt', dir: 'desc' },
          skip: paging.skip,
          limit: paging.limit
        })
        const ownerMap = await publicOwnerMap(rows.map((row) => row.ownerId))
        /* 收藏量：本页商品一次性聚合，供列表卡片展示「浏览 / 收藏」 */
        const ids = rows.map((row) => row.id)
        const favRows = ids.length
          ? await repo.find('favorites', {
            targetType: 'product',
            targetId: { $in: ids },
            deleted: { $ne: true }
          }, { limit: 2000 })
          : []
        const favMap = new Map()
        favRows.forEach((row) => {
          favMap.set(row.targetId, (favMap.get(row.targetId) || 0) + 1)
        })
        return {
          items: rows.map((row) => {
            const isPrivate = row.visibility === VISIBILITIES.PRIVATE
            const view = projectProduct(row)
            view.favCount = favMap.get(row.id) || 0
            if (isPrivate) {
              attachOwnerInfo(view, { exposure: EXPOSURES.HIDDEN, label: ANON_LABEL })
              view.contactHidden = true
              view.privateShare = true
            } else {
              attachOwnerInfo(view, ownerMap.get(row.ownerId))
            }
            return { ownerId: row.ownerId, isPrivate, view }
          }),
          page: paging.page,
          limit: paging.limit,
          total,
          hasMore: paging.skip + rows.length < total
        }
      }
      const base = mineOnly
        ? await loadBase()
        : await sharedList('products', 'product.list', data, 30, loadBase)
      /* 自己发布的保密内容仍对属主展示主体：仅对命中的极少数条目补一次主体信息 */
      const ownedPrivate = base.items.filter((item) => item.isPrivate && uid && item.ownerId === uid)
      const ownMap = ownedPrivate.length
        ? await publicOwnerMap(ownedPrivate.map((item) => item.ownerId))
        : null
      const result = {
        items: base.items.map((item) => {
          const mine = !!(uid && item.ownerId === uid)
          const view = Object.assign({}, item.view, { mine })
          if (item.isPrivate) {
            if (mine) {
              delete view.contactHidden
              delete view.privateShare
              attachOwnerInfo(view, ownMap && ownMap.get(item.ownerId))
            } else {
              view.contactHidden = true
            }
          }
          return view
        }),
        page: base.page,
        limit: base.limit,
        total: base.total,
        hasMore: base.hasMore
      }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 产品型号库（用户端）：返回平台新增 / 停用 / 删除的型号，客户端与内置目录合并后供滚轮选择。
     * 只下发增量记录，避免每次发布都传输整棵静态目录。
     * removed 也要下发：内置目录里的型号在平台删除后没有本地记录可删，客户端靠这条标记移出滚轮。
     */
    'catalog.tree': async () => {
      const rows = await repo.find('catalog', {}, {
        sort: { field: 'updatedAt', dir: 'desc' },
        limit: 5000
      })
      const items = rows.map((row) => ({
        key: [row.cat, row.brand, row.series, row.model].join('::'),
        cat: row.cat,
        brand: row.brand,
        series: row.series,
        model: row.model,
        status: row.status || 'active'
      }))
      return { items, total: items.length, at: now() }
    },

    'product.detail': async (data, ctx) => {
      const id = str(data.id || data.productId, { field: '商品', required: true, max: 64 })
      const product = await repo.get('products', id)
      if (!product || product.deleted === true) throw new AppError(CODES.NOT_FOUND, '商品不存在或已下架')
      const isOwner = !!(ctx && ctx.openid && product.ownerId === ctx.openid)
      /* 领取过这条商机的会员：可回看详情；仅商机发布、下架后都不再拦截 */
      const claimed = !isOwner && ctx && ctx.openid
        ? !!(await repo.get('bizClaims', bizClaimId(ctx.openid, 'supply', product.id)))
        : false
      if (!isOwner && !claimed && !PRODUCT_PUBLIC_STATUS.includes(product.status)) {
        throw new AppError(CODES.NOT_FOUND, '商品不存在或已下架')
      }
      /* 仅商机发布不对普通浏览者开放详情 */
      if (!isOwner && !claimed && product.channel === PUBLISH_CHANNELS.POOL) {
        throw new AppError(CODES.NOT_FOUND, '商品不存在或已下架')
      }
      const view = projectProduct(product)
      view.mine = isOwner
      /* 收藏量：与浏览一起展示在商品下方 */
      view.favCount = await repo.count('favorites', {
        targetType: 'product',
        targetId: id,
        deleted: { $ne: true }
      })
      /* 搜索免费、对接收费：联系电话明文只给发布者本人与商机会员 */
      const member = isOwner ? true : await bizMemberOf(ctx && ctx.openid)
      /* 私密发布＝匿名公开：内容照常可看，非属主绝不下发任何发布者身份 */
      const isPrivate = !isOwner && product.visibility === VISIBILITIES.PRIVATE
      if (isPrivate) {
        delete view.ownerLabel
        view.ownerExposure = EXPOSURES.HIDDEN
        view.ownerExposureLabel = ANON_LABEL
        view.contactHidden = true
        view.privateShare = true
        view.owner = null
        view.ownerKey = ''
        view.ownerSubject = ''
      } else {
        const ownerMap = await publicOwnerMap([product.ownerId], { revealPhone: member })
        const ownerInfo = ownerMap.get(product.ownerId) || {}
        attachOwnerInfo(view, ownerInfo)
        view.contactHidden = false
        view.privateShare = false
        /* 非会员：主体照常可见，号码不下发，前端据此引导开通商机会员 */
        view.memberOnlyContact = !member && ownerInfo.phoneShared === true
      }
      assertNoPlaintextContactAllowingPhone(view, 'ownerPhone')
      return view
    },

    'demand.list': async (data, ctx) => {
      const uid = ctx && ctx.openid
      const paging = normalizePaging(data)
      if (paging.capped) {
        return { items: [], page: paging.page, limit: paging.limit, total: 0, hasMore: false, truncated: true }
      }
      const mineOnly = data.mine === true
      const query = { deleted: { $ne: true } }
      if (mineOnly) {
        /* 「我发布的」必须绑定本人，否则会越权看到全量任意状态 */
        if (!uid) throw new AppError(CODES.UNAUTHENTICATED, '请先登录')
        query.ownerId = uid
        /* 我的发布可按任意状态筛选（含草稿 / 待审核 / 已驳回 / 已下架） */
        if (data.status) query.status = enumOf(data.status, Object.values(DEMAND_STATUS), '状态')
      } else {
        query.status = data.status ? enumOf(data.status, DEMAND_PUBLIC_STATUS, '状态') : DEMAND_STATUS.OPEN
        /* 私密发布＝匿名公开：内容照常进公开列表，只隐藏发布者身份与主页入口 */
        /* 仅商机发布不进入普通列表，只在商机池按型号匹配 */
        query.channel = { $ne: PUBLISH_CHANNELS.POOL }
      }
      if (data.tradeMode) query.tradeMode = enumOf(data.tradeMode, TRADE_MODE_OPTIONS.demand, '交易方式')
      if (data.cat) query.cat = str(data.cat, { field: '品类', max: 30 })
      if (data.q) {
        query.title = {
          $regex: str(data.q, { field: '关键词', max: 30 }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i'
        }
      }
      /* 基础数据与浏览者无关：保密条目按匿名口径投影，属主归属在下面按请求者叠加 */
      const loadBase = async () => {
        const total = await repo.count('demands', query)
        const rows = await repo.find('demands', query, {
          sort: { field: 'createdAt', dir: 'desc' },
          skip: paging.skip,
          limit: paging.limit
        })
        const ownerMap = await publicOwnerMap(rows.map((row) => row.ownerId))
        return {
          items: rows.map((row) => {
            const isPrivate = row.visibility === VISIBILITIES.PRIVATE
            const view = projectDemand(row)
            if (isPrivate) {
              attachOwnerInfo(view, { exposure: EXPOSURES.HIDDEN, label: ANON_LABEL })
              view.contactHidden = true
              view.privateShare = true
            } else {
              attachOwnerInfo(view, ownerMap.get(row.ownerId))
            }
            return { ownerId: row.ownerId, isPrivate, view }
          }),
          page: paging.page,
          limit: paging.limit,
          total,
          hasMore: paging.skip + rows.length < total
        }
      }
      const base = mineOnly
        ? await loadBase()
        : await sharedList('demands', 'demand.list', data, 30, loadBase)
      const ownedPrivate = base.items.filter((item) => item.isPrivate && uid && item.ownerId === uid)
      const ownMap = ownedPrivate.length
        ? await publicOwnerMap(ownedPrivate.map((item) => item.ownerId))
        : null
      const result = {
        items: base.items.map((item) => {
          const mine = !!(uid && item.ownerId === uid)
          const view = Object.assign({}, item.view, { mine })
          if (item.isPrivate) {
            if (mine) {
              delete view.contactHidden
              delete view.privateShare
              attachOwnerInfo(view, ownMap && ownMap.get(item.ownerId))
            } else {
              view.contactHidden = true
            }
          }
          return view
        }),
        page: base.page,
        limit: base.limit,
        total: base.total,
        hasMore: base.hasMore
      }
      assertNoPlaintextContact(result)
      return result
    },

    'demand.detail': async (data, ctx) => {
      const id = str(data.id || data.demandId, { field: '求购', required: true, max: 64 })
      const demand = await repo.get('demands', id)
      if (!demand || demand.deleted === true) throw new AppError(CODES.NOT_FOUND, '求购不存在或已关闭')
      const isOwner = !!(ctx && ctx.openid && demand.ownerId === ctx.openid)
      /* 领取过这条商机的会员：可回看详情；仅商机发布、需求关闭后都不再拦截 */
      const claimed = !isOwner && ctx && ctx.openid
        ? !!(await repo.get('bizClaims', bizClaimId(ctx.openid, 'demand', demand.id)))
        : false
      if (!isOwner && !claimed && !DEMAND_PUBLIC_STATUS.includes(demand.status)) {
        throw new AppError(CODES.NOT_FOUND, '求购不存在或已关闭')
      }
      /* 仅商机发布不对普通浏览者开放详情 */
      if (!isOwner && !claimed && demand.channel === PUBLISH_CHANNELS.POOL) {
        throw new AppError(CODES.NOT_FOUND, '求购不存在或已关闭')
      }
      const view = projectDemand(demand)
      view.mine = isOwner
      /* 搜索免费、对接收费：联系电话明文只给发布者本人与商机会员 */
      const member = isOwner ? true : await bizMemberOf(ctx && ctx.openid)
      /* 私密发布＝匿名公开：内容照常可看，非属主绝不下发任何发布者身份 */
      const isPrivate = !isOwner && demand.visibility === VISIBILITIES.PRIVATE
      if (isPrivate) {
        delete view.publisherLabel
        view.ownerExposure = EXPOSURES.HIDDEN
        view.ownerExposureLabel = ANON_LABEL
        view.contactHidden = true
        view.privateShare = true
        view.owner = null
        view.ownerKey = ''
        view.ownerSubject = ''
      } else {
        const ownerMap = await publicOwnerMap([demand.ownerId], { revealPhone: member })
        const ownerInfo = ownerMap.get(demand.ownerId) || {}
        attachOwnerInfo(view, ownerInfo)
        view.contactHidden = false
        view.privateShare = false
        /* 非会员：主体照常可见，号码不下发，前端据此引导开通商机会员 */
        view.memberOnlyContact = !member && ownerInfo.phoneShared === true
      }
      assertNoPlaintextContactAllowingPhone(view, 'ownerPhone')
      return view
    },

    /**
     * 货主主页：只展示对方公开发布的货源与需求。
     * 联系电话只有货主自己开启「公开主体 + 公开联系电话」时才给明文，
     * 其余情况一律走平台坐席对接，页面只给脱敏值或标签。
     */
    'owner.home': async (data, ctx) => {
      await mustUser(ctx)
      const ownerKey = str(data.ownerKey || data.id, { field: '货主标识', required: true, max: 64 })
      /* 从资讯作者头像进入时允许查看未公开主体的公开内容：只聚合公开在架货源 / 需求 / 资讯，不暴露主体与电话 */
      const allowHidden = data.allowHidden === true
      /* 货主键是不可逆哈希：先用它反查本人，再决定给不给主页 */
      const ownerId = await uidByOwnerKey(repo, ownerKey)
      if (!ownerId) throw new AppError(CODES.NOT_FOUND, '货主主页不存在')

      /* 搜索免费、对接收费：号码明文只给商机会员，主体与在架内容不受限 */
      const viewerMember = await bizMemberOf(ctx && ctx.openid)
      const ownerMap = await publicOwnerMap([ownerId], { revealPhone: viewerMember })
      const info = ownerMap.get(ownerId) || {}
      const hidden = !info.revealed
      /* 主体未公开时不提供主页：避免从「同主体货源」反推出隐藏主体；资讯作者入口除外 */
      if (hidden && !allowHidden) {
        throw new AppError(CODES.NOT_FOUND, '该商家未公开主体，请通过咨询由平台对接')
      }

      const productRows = await repo.find('products', {
        ownerId,
        status: PRODUCT_STATUS.ON_SALE,
        visibility: { $ne: VISIBILITIES.PRIVATE },
        channel: { $ne: PUBLISH_CHANNELS.POOL }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 50 })
      const demandRows = await repo.find('demands', {
        ownerId,
        status: DEMAND_STATUS.OPEN,
        visibility: { $ne: VISIBILITIES.PRIVATE },
        channel: { $ne: PUBLISH_CHANNELS.POOL }
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 50 })
      /* 作者发布的资讯：状态「已发布」且未删除；私密资讯不出现在他人主页 */
      const newsRows = await repo.find('news', {
        uid: ownerId,
        official: { $ne: true },
        visibility: { $ne: VISIBILITIES.PRIVATE },
        status: '已发布',
        deleted: { $ne: true }
      }, { sort: { field: 'publishedAt', dir: 'desc' }, limit: 20 })

      const items = productRows.map((row) => ({
        id: row.id,
        type: 'product',
        title: row.title || row.model || '',
        cat: row.cat || '',
        model: row.model || '',
        city: row.city || '',
        tradeMode: row.tradeMode || '出售',
        isRent: row.tradeMode === '出租',
        priceText: amountText(row.price, row.priceMax, row.priceMode, '¥', row.tradeMode === '出租' ? ' / 台 / 月' : ' / 台'),
        qty: Number(row.qty) || 0,
        publishedAt: Number(row.createdAt) || 0
      })).concat(demandRows.map((row) => ({
        id: row.id,
        type: 'demand',
        title: row.title || row.model || '',
        cat: row.cat || '',
        model: row.model || '',
        city: row.city || '',
        tradeMode: row.tradeMode || '求购',
        isRent: row.tradeMode === '租赁',
        priceText: '预算 ' + amountText(row.budget, row.budgetMax, row.budgetMode, '¥', ' / 台'),
        qty: Number(row.qty) || 0,
        publishedAt: Number(row.createdAt) || 0
      })))

      const member = await bizMemberOf(ownerId)
      const result = {
        ownerKey,
        /* 未公开主体：仅隐藏主体 / 联系方式，公开的在架货源、需求与资讯照常展示 */
        hidden,
        /* 商机会员标识：主页、消息列表、会话顶部用同一口径 */
        member,
        memberLabel: member ? '商机会员' : '',
        /* 认证徽标：未公开主体的货主不对外声明任何认证信息 */
        verified: !hidden && info.verified === true,
        ownerSubject: hidden ? '' : (info.subject || ''),
        ownerContactName: hidden ? '' : (info.contactName || ''),
        ownerExposure: info.exposure || EXPOSURES.HIDDEN,
        ownerExposureLabel: info.label || '',
        city: info.city || '',
        /* 货主自愿公开联系电话且浏览者为商机会员时给明文；否则只给脱敏值 */
        phonePublic: !hidden && info.phonePublic === true,
        phone: !hidden && info.phonePublic === true ? (info.phone || '') : '',
        phoneMasked: hidden ? '' : (info.phoneMasked || ''),
        /* 货主公开了电话但浏览者不是会员：前端引导开通 */
        memberOnlyContact: !hidden && !viewerMember && info.phoneShared === true,
        items,
        news: newsRows.map((row) => ({
          id: row.id,
          title: row.title || '',
          summary: row.summary || '',
          cat: row.cat || '',
          views: Number(row.views) || 0,
          published: shortDate(row.publishedAt || row.createdAt),
          publishedAt: Number(row.publishedAt || row.createdAt) || 0
        })),
        total: items.length
      }
      assertNoPlaintextContactAllowingPhone(result, 'phone')
      return result
    },

    /* ---------- 我的库存：本人私有清单，只用于商机匹配 ---------- */
    'stock.list': async (data, ctx) => {
      /* 只按 ownerId 查、排序在内存做：避免云端为「where + orderBy」额外建组合索引 */
      const rows = await repo.find('stocks', { ownerId: ctx.openid }, { limit: STOCK_LIMIT })
      const items = rows
        .filter((row) => !row.deleted)
        .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
        .map(stockView)
      return { items, limit: STOCK_LIMIT }
    },

    'stock.save': async (data, ctx) => {
      const uid = ctx.openid
      /* 客户端预生成 id：本地与云端同标识，保存后无需改名回写 */
      const id = str(data.id, { field: '库存标识', max: 64 }) || randomId('sk')
      const model = str(data.model, { field: '型号', required: true, max: 60 })
      const qty = Math.floor(Number(data.qty))
      if (!(qty > 0) || qty > 100000) throw new AppError(CODES.VALIDATION, '请填写正确的库存数量')
      const price = Number(data.price)
      if (!(price > 0) || price > 999999999) throw new AppError(CODES.VALIDATION, '请填写正确的库存单价')
      const at = now()
      const patch = {
        cat: str(data.cat, { field: '设备类型', max: 20, default: '其他配件' }),
        brand: str(data.brand, { field: '品牌', max: 40 }),
        model,
        series: str(data.series, { field: '系列', max: 40 }),
        qty,
        price,
        unit: str(data.unit, { field: '单位', max: 16, default: '元 / 件' }),
        city: str(data.city, { field: '所在城市', required: true, max: 20 }),
        cond: str(data.cond, { field: '成色', max: 12 }),
        note: str(data.note, { field: '描述', max: 200 }),
        status: data.status === STOCK_STATUS_OFF ? STOCK_STATUS_OFF : STOCK_STATUS_ON,
        at,
        updatedAt: at,
        deleted: false
      }
      /* 上架中的库存会对外展示：主体信息与联系方式必须齐全；仅下架不做拦截 */
      if (patch.status === STOCK_STATUS_ON) await assertProfileReady(uid)
      const existing = await repo.get('stocks', id)
      if (existing) {
        if (existing.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能修改自己的库存')
        const res = await repo.updateWhere('stocks', { id, ownerId: uid }, patch)
        if (!res || !res.count) throw new AppError(CODES.CONFLICT, '库存已变化，请刷新后重试')
        return stockView(Object.assign({}, existing, patch))
      }
      const rows = await repo.find('stocks', { ownerId: uid }, { limit: STOCK_LIMIT })
      const live = rows.filter((row) => !row.deleted).length
      if (live >= STOCK_LIMIT) {
        throw new AppError(CODES.CONFLICT, `库存最多保存 ${STOCK_LIMIT} 条，请先清理已下架的型号`)
      }
      const doc = Object.assign({ id, ownerId: uid, createdAt: at }, patch)
      await repo.insert('stocks', doc)
      return stockView(doc)
    },

    'stock.remove': async (data, ctx) => {
      const uid = ctx.openid
      const id = str(data.id, { field: '库存标识', required: true, max: 64 })
      const doc = await repo.get('stocks', id)
      if (!doc) return { id, removed: false }
      if (doc.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能删除自己的库存')
      /* 软删除：列表只读未删除记录，历史数据保留可追溯 */
      await repo.updateWhere('stocks', { id, ownerId: uid }, { deleted: true, deletedAt: now() })
      return { id, removed: true }
    },

    /* ---------- 收藏 / 关注：本地缓存优先，云端只做换机恢复与增量对账 ---------- */
    /**
     * 收藏列表。since 为上一次同步时服务端返回的时间戳：
     * - since = 0：全量（首次登录 / 换手机 / 本地缓存被清）；
     * - since > 0：只返回这段时间内有变化的条目，并用 removed 告知已取消的 id。
     * 客户端平时直接读本地缓存渲染，这里只做增量对账，避免每次切页都全量拉取。
     */
    'fav.list': async (data, ctx) => {
      const since = Math.max(0, Number((data && data.since) || 0) || 0)
      /* 全量只要有效的；增量要连软删的行一起拿，取消收藏才能同步到其它设备 */
      const query = since
        ? { uid: ctx.openid, updatedAt: { $gte: since } }
        : { uid: ctx.openid, deleted: false }
      const rows = await repo.find('favorites', query, { limit: FAV_LIMIT })
      const pick = (type) => rows
        .filter((row) => row.targetType === type && !row.deleted)
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .map((row) => ({ id: row.targetId, at: Number(row.updatedAt) || 0 }))
      const removedOf = (type) => rows
        .filter((row) => row.targetType === type && row.deleted)
        .map((row) => row.targetId)
      const result = {
        product: pick('product'),
        demand: pick('demand'),
        news: pick('news'),
        since,
        full: !since,
        serverTime: now(),
        limit: FAV_LIMIT
      }
      if (since) {
        result.removed = {
          product: removedOf('product'),
          demand: removedOf('demand'),
          news: removedOf('news')
        }
      }
      return result
    },

    /** 幂等写入：on=true 收藏 / on=false 取消，重复调用结果一致，便于多端合并 */
    'fav.set': async (data, ctx) => {
      const uid = ctx.openid
      const targetType = enumOf(String(data.type || '').trim().toLowerCase(), ['product', 'demand', 'news'], '收藏类型')
      const targetId = str(data.id, { field: '收藏对象', required: true, max: 64 })
      const on = data.on !== false
      const at = now()
      const id = relId('fv_', uid, targetType + '|' + targetId)
      const existing = await repo.get('favorites', id)
      if (existing) {
        if (existing.uid !== uid) throw new AppError(CODES.FORBIDDEN, '无权修改该收藏')
        await repo.updateWhere('favorites', { id, uid }, { deleted: !on, updatedAt: at })
        return { type: targetType, id: targetId, on }
      }
      if (!on) return { type: targetType, id: targetId, on: false }
      /* 只接受真实存在的对象，避免把任意字符串刷进收藏表 */
      const collection = targetType === 'product' ? 'products' : (targetType === 'news' ? 'news' : 'demands')
      const target = await repo.get(collection, targetId)
      if (!target) throw new AppError(CODES.NOT_FOUND, '收藏对象不存在或已下架')
      if (targetType === 'news' && (target.deleted === true || target.status !== '已发布')) {
        throw new AppError(CODES.NOT_FOUND, '该资讯已失效，无法收藏')
      }
      const rows = await repo.find('favorites', { uid }, { limit: FAV_LIMIT })
      if (rows.filter((row) => !row.deleted).length >= FAV_LIMIT) {
        throw new AppError(CODES.CONFLICT, `收藏最多保存 ${FAV_LIMIT} 条，请先清理`)
      }
      await repo.insert('favorites', {
        id, uid, targetType, targetId, createdAt: at, updatedAt: at, deleted: false
      })
      return { type: targetType, id: targetId, on: true }
    },

    /** 关注列表：口径与收藏一致，since 为增量对账时间戳 */
    'follow.list': async (data, ctx) => {
      const since = Math.max(0, Number((data && data.since) || 0) || 0)
      const query = since
        ? { uid: ctx.openid, updatedAt: { $gte: since } }
        : { uid: ctx.openid, deleted: false }
      const rows = await repo.find('follows', query, { limit: FOLLOW_LIMIT })
      const items = rows
        .filter((row) => !row.deleted)
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .map((row) => ({
          id: row.targetKey,
          type: row.targetType === 'product' ? 'product' : 'account',
          nick: row.nick || '货主',
          short: row.short || String(row.nick || '货').slice(-1),
          city: row.city || '',
          verified: true,
          at: Number(row.updatedAt) || 0
        }))
      const removed = rows.filter((row) => row.deleted).map((row) => row.targetKey)
      const result = {
        items,
        since,
        full: !since,
        serverTime: now(),
        limit: FOLLOW_LIMIT
      }
      if (since) result.removed = removed
      assertNoPlaintextContact(result)
      return result
    },

    /** 关注货主 / 商品：只存匿名键与展示用昵称，不落对方 openid */
    'follow.set': async (data, ctx) => {
      const uid = ctx.openid
      const targetType = enumOf(String(data.type || 'account').trim().toLowerCase(), ['account', 'product'], '关注类型')
      const targetKey = str(data.id, { field: '关注对象标识', required: true, max: 64 })
      const on = data.on !== false
      const nick = str(data.nick, { field: '关注对象名称', max: 40 })
      const city = str(data.city, { field: '所在城市', max: 20 })
      const at = now()
      const id = relId('fw_', uid, targetType + '|' + targetKey)
      const existing = await repo.get('follows', id)
      if (existing) {
        if (existing.uid !== uid) throw new AppError(CODES.FORBIDDEN, '无权修改该关注')
        const patch = { deleted: !on, updatedAt: at }
        if (on && nick) {
          patch.nick = nick
          patch.short = nick.slice(-1)
        }
        if (on && city) patch.city = city
        await repo.updateWhere('follows', { id, uid }, patch)
        return { id: targetKey, type: targetType, on }
      }
      if (!on) return { id: targetKey, type: targetType, on: false }
      const rows = await repo.find('follows', { uid }, { limit: FOLLOW_LIMIT })
      if (rows.filter((row) => !row.deleted).length >= FOLLOW_LIMIT) {
        throw new AppError(CODES.CONFLICT, `最多关注 ${FOLLOW_LIMIT} 个对象，请先清理`)
      }
      if (targetType === 'product') {
        const product = await repo.get('products', targetKey)
        if (!product || product.deleted === true || product.status !== '在售') {
          throw new AppError(CODES.NOT_FOUND, '商品已失效，无法关注')
        }
      }
      await repo.insert('follows', {
        id,
        uid,
        targetKey,
        targetType,
        nick: nick || (targetType === 'product' ? '商品' : '货主'),
        short: (nick || (targetType === 'product' ? '品' : '货')).slice(-1),
        city,
        createdAt: at,
        updatedAt: at,
        deleted: false
      })
      return { id: targetKey, type: targetType, on: true }
    },

    /** 我的关注：账号与商品分开返回，并标记注销 / 下架失效态 */
    'follow.overview': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const rows = (await repo.find('follows', { uid }, { limit: FOLLOW_LIMIT }))
        .filter((row) => !row.deleted)
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      const accountRows = rows.filter((row) => row.targetType !== 'product')
      const productRows = rows.filter((row) => row.targetType === 'product')
      const accounts = []
      for (const row of accountRows) {
        const ownerId = await uidByOwnerKey(repo, row.targetKey)
        const owner = ownerId ? await repo.get('users', ownerId) : null
        accounts.push({
          id: row.targetKey,
          type: 'account',
          nick: row.nick || '货主',
          short: row.short || String(row.nick || '货').slice(-1),
          city: row.city || '',
          at: Number(row.updatedAt) || 0,
          valid: !!owner && owner.status !== '停用',
          invalidText: owner && owner.status !== '停用' ? '' : '账号已注销'
        })
      }
      const products = []
      if (productRows.length) {
        const ids = productRows.map((row) => row.targetKey)
        const found = await repo.find('products', { id: { $in: ids } }, { limit: FOLLOW_LIMIT })
        const map = {}
        found.forEach((p) => { map[p.id] = p })
        productRows.forEach((row) => {
          const p = map[row.targetKey]
          const valid = !!p && p.deleted !== true && p.status === '在售'
          products.push({
            id: row.targetKey,
            type: 'product',
            title: valid ? (p.title || row.nick || '商品') : '商品已失效',
            nick: row.nick || '商品',
            priceText: valid ? (p.priceText || '') : '',
            city: valid ? (p.city || '') : '',
            at: Number(row.updatedAt) || 0,
            valid,
            invalidText: valid ? '' : '商品已失效'
          })
        })
      }
      return { accounts, products }
    },

    /** 我收藏的资讯：按收藏时间倒序，已删除 / 已下架标记为失效 */
    'news.fav.list': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const rows = (await repo.find('favorites', { uid, targetType: 'news' }, { limit: FAV_LIMIT }))
        .filter((row) => !row.deleted)
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      const ids = rows.map((row) => row.targetId)
      let newsMap = {}
      if (ids.length) {
        const found = await repo.find('news', { id: { $in: ids } }, { limit: FAV_LIMIT })
        found.forEach((n) => { newsMap[n.id] = n })
      }
      const items = rows.map((row) => {
        const n = newsMap[row.targetId]
        const valid = !!n && n.deleted !== true && n.status === '已发布'
        return {
          id: row.targetId,
          title: valid ? (n.title || '资讯') : '资讯已失效',
          cat: valid ? (n.cat || '') : '',
          city: valid ? (n.city || '') : '',
          author: valid ? (n.author || '平台用户') : '',
          publishedText: valid ? (n.publishedText || dayText(n.createdAt)) : '',
          valid,
          at: Number(row.updatedAt) || 0
        }
      })
      return { items, total: items.length, limit: FAV_LIMIT }
    },

    /**
     * 咨询提交：必须条件全部满足才可提交。
     * 提交即判档（基于规则快照，幂等）；P0 直接进已拦截箱，不投递、不计热度、不通知。
     * 对外只返回中性回执，不告知档位与是否被拦截。
     */
    'consult.submit': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      const { productId, demandId } = allowedTargetQuery(data)
      const target = await loadTarget(productId, demandId, uid)

      /* 手机号直接用微信授权过来的：客户端不再手填，未传时回落到本人已授权号码 */
      const phoneInput = String(data.phone || '').trim()
      const ownPhone = decryptOwnPhone(user)
      if (!phoneInput && !ownPhone) {
        throw new AppError(CODES.VALIDATION, '请先在「我的 - 个人信息」授权微信手机号')
      }
      const phone = normalizePhone(phoneInput || ownPhone)
      if (!Array.isArray(data.conds)) throw new AppError(CODES.VALIDATION, '请逐项确认必须条件')
      if (data.conds.length > MUST_CONDITIONS.length) {
        throw new AppError(CODES.VALIDATION, '必须条件项过多')
      }
      const conds = data.conds.map((item) => {
        const src = item || {}
        const k = str(src.k, { field: '必须条件', required: true, max: 40 })
        if (!MUST_CONDITIONS.includes(k)) throw new AppError(CODES.VALIDATION, '未知的必须条件')
        const note = str(src.note, { field: '备注', max: 60 })
        assertNoContactInText(note, '备注')
        return { k, satisfied: src.satisfied === true, note }
      })
      assertCondsComplete(conds, target, '无法提交咨询')
      const unmet = conds.filter((item) => item.satisfied !== true)
      if (unmet.length > 0) {
        throw new AppError(CODES.VALIDATION, '必须条件未满足，无法提交咨询')
      }

      const profile = await readProfile(uid)
      const phoneBidx = blindIndex({ keys, value: phone })
      /* 补充材料（选填）：图片 5 张 / 视频 3 段，只落元信息，文件本体另行上传 */
      const media = normalizeMedia(data.media)
      /* 先做文本校验，再消耗去重计数，避免校验失败却占用当天配额 */
      const summary = str(data.summary, { field: '需求说明', max: 200 })
      assertNoContactInText(summary, '需求说明')
      const dayWindow = RATE_LIMITS.duplicateConsult.windowMs
      const dupKey = `consult-dup:${phoneBidx}:${target.type}:${target.doc.id}`
      const dupWindow = Math.floor(now() / dayWindow) * dayWindow
      const dupCount = await repo.incrCounter(dupKey, dupWindow)
      if (dupCount > 1) {
        /* 重复提交不叠加计数，避免反复点击把计数推到高位 */
        await repo.incrCounter(dupKey, dupWindow, -1).catch(() => {})
        throw new AppError(CODES.CONFLICT, '24 小时内已提交过相同咨询，请勿重复提交')
      }

      const existingProfile = profile || {}
      const compare = buildCompare(conds, target, existingProfile)
      const at = now()
      let leadId = ''
      let verdictRef = null
      let blockedRef = false

      try {
        /* 判档与详情页直聊共用同一份规则与统计口径 */
        const verdict = await judgeConsult({ uid, target, text: summary, phone, phoneBidx })
        leadId = randomId('L')
        const blocked = verdict.tier === 'P0'
        /* 咨询手机号加密落档：放在线索落库前，任何一步失败都能整体回滚重试，不留半写状态。
           P0 拦截路径刻意不更新：防止拦截对象用假号码污染档案，影响合法咨询的联系释放 */
        if (!blocked) {
          await repo.updateWhere('users', { id: user.id }, {
            phoneCipher: encryptField({ keys, value: phone, aad: phoneAad(user.id) }),
            phoneBidx
          })
        }
        if (blocked) {
          /* 拦截记录先于线索落库：拦截记录写失败可整体回滚重试；
             反序会出现「已拦截线索但没有复核记录」，该线索将永远无法恢复 */
          const life = blockedLifecycle(at)
          await repo.insert('blocked', {
            id: randomId('B'),
            leadId,
            ruleId: verdict.hits.length ? verdict.hits[0].ruleId : '',
            reason: verdict.hits.length ? verdict.hits[0].reason : '命中 P0 规则',
            at,
            reviewDeadline: life.reviewDeadline,
            cleanupAt: life.cleanupAt
          })
        }
        const lead = {
          id: leadId,
          source: SOURCE_LABEL,
          productId: productId || '',
          demandId: demandId || '',
          uid,
          buyerBidx: phoneBidx,
          formSummary: summary || `咨询${target.title}`,
          compare: compare.rows,
          matchPct: compare.matchPct,
          /* 补充材料清单（只落元信息，文件本体走私有存储 + 鉴权链接） */
          media,
          status: blocked ? LEAD_STATUS.BLOCKED : LEAD_STATUS.PENDING,
          assignedTo: '',
          tier: verdict.tier,
          tierName: verdict.tierName,
          ruleVersion: verdict.ruleVersion,
          hits: verdict.hits,
          createdAt: at,
          contactReleased: false
        }
        await repo.insert('leads', lead)
        verdictRef = verdict
        blockedRef = blocked
      } catch (err) {
        /* 线索没落库就失败，必须归还去重配额，否则用户会被自己锁死 24 小时 */
        await repo.incrCounter(dupKey, dupWindow, -1).catch(() => {})
        throw err
      }

      /* 咨询内容命中色情 / 暴力 / 反动敏感词：写入风险单，等待平台人工查看处置 */
      try {
        await recordSensitiveRisk({
          repo,
          at,
          type: '咨询',
          targetId: leadId,
          targetLabel: `${target.type === 'product' ? '商品' : '需求'}咨询 ${target.title || ''}`.trim(),
          uid,
          text: summary
        })
      } catch (riskErr) { /* 风险登记失败不影响咨询提交 */ }

      if (blockedRef) {
        try {
          await appendAudit(repo, {
            actorType: 'system',
            actorId: 'filter',
            action: 'consult.blocked',
            target: leadId,
            reason: verdictRef.tierName,
            result: 'blocked',
            at
          })
        } catch (auditErr) {
          /* 拦截结果已落库：留痕失败不改变拦截事实，也不能把回执变成报错 */
        }
        /* P0：只给中性回执，不投递、不通知、不计热度 */
        const receipt = { leadId, receipt: NEUTRAL_RECEIPT, submittedAt: new Date(at).toISOString() }
        assertNoPlaintextContact(receipt)
        return receipt
      }

      /* 线索已落库：站内信与留痕属于事后记录，任何一步失败都不能把
         成功的咨询变成报错，否则用户重试会被 24h 去重拦住且无从恢复 */
      try {
        await repo.insert('outbox', {
          id: randomId('M'),
          type: 'consult.created',
          payload: {
            uid,
            leadId,
            targetType: target.type,
            targetId: target.doc.id,
            title: '咨询已提交',
            body: NEUTRAL_RECEIPT
          },
          status: 'pending',
          createdAt: at
        })
      } catch (mailErr) { /* 站内信投递失败不影响咨询结果 */ }

      /* 必须条件已全部满足：直接为双方开通会话，不再等平台转达。
         不公开主体不会代转联系方式，双方在站内会话里沟通。 */
      let threadId = ''
      try {
        const ownerId = target.doc.ownerId
        if (ownerId && ownerId !== uid) {
          /* 私密发布：咨询同样不向买家暴露发布人身份，只显示「私密发布」 */
          const secretTarget = target.doc.visibility === VISIBILITIES.PRIVATE
          const ownerName = secretTarget ? '私密发布' : await peerDisplayName(ownerId)
          const buyerName = maskName(String(user.nick || user.realname || '')) || '用户'
          const body = summary || `我已确认必须条件，想就「${target.title}」进一步沟通。`
          threadId = leadId
          await insertDirectChat({
            threadId,
            at,
            fromUid: uid,
            fromName: buyerName,
            toUid: ownerId,
            toName: ownerName,
            body,
            targetType: target.type,
            targetId: target.doc.id,
            title: target.title,
            privateForUid: secretTarget ? uid : ''
          })
          await repo.updateWhere('leads', { id: leadId }, { threadId, chatOpenedAt: at })
        }
      } catch (chatErr) {
        /* 会话开通失败时回落到原有回执，线索仍在，可由坐席人工转达 */
        threadId = ''
      }

      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'consult.submit',
          target: leadId,
          reason: '',
          result: 'allow',
          at
        })
      } catch (auditErr) { /* 留痕失败不影响咨询结果 */ }

      /* 订阅消息：有人响应求购 / 咨询商品时提醒发布方。
         一次授权只对应一次推送，未授权、模板未配置或推送失败都不影响咨询结果；
         推送内容只含标题与类型，不带咨询人联系方式 */
      try {
        const ownerId = target.doc.ownerId
        if (ownerId && ownerId !== uid && notify && typeof notify.inquiry === 'function') {
          const site = await readSiteSettings()
          const templateId = String(site.tmplInquiry || env.SUBSCRIBE_TMPL_INQUIRY || '')
          if (templateId) {
            await notify.inquiry({
              openid: ownerId,
              templateId,
              targetType: target.type,
              targetId: target.doc.id,
              title: target.title,
              at
            })
          }
        }
      } catch (notifyErr) { /* 推送失败不影响咨询结果 */ }

      const receipt = {
        leadId,
        receipt: threadId
          ? '必须条件已满足，已为你开启与对方的直接会话。可协商条件可在会话中继续沟通；平台不代转联系方式，请使用站内会话。'
          : NEUTRAL_RECEIPT,
        threadId,
        chatReady: !!threadId,
        submittedAt: new Date(at).toISOString()
      }
      assertNoPlaintextContact(receipt)
      return receipt
    },

    /**
     * 直接开聊：详情页点「联系货主」后，先在这里完成条件确认与线索落库，
     * 服务端校验通过就直接返回会话 id，客户端跳到与货主的对话，不再走平台转达。
     *
     * 与 consult.submit 的差别：这里只做「条件确认 + 开会话」，
     * 不收集采购数量 / 报价等表单信息，条件确认由客户端逐项勾选后带上。
     */
    'chat.open': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      const { productId, demandId } = allowedTargetQuery(data)
      const target = await loadTarget(productId, demandId, uid)

      /* 发布方声明的必须条件必须逐项满足；历史数据没有 must 时允许空列表，避免死路 */
      if (!Array.isArray(data.conds)) throw new AppError(CODES.VALIDATION, '请逐项确认必须条件')
      if (data.conds.length > MUST_CONDITIONS.length) {
        throw new AppError(CODES.VALIDATION, '必须条件项过多')
      }
      const conds = data.conds.map((item) => {
        const src = item || {}
        const k = str(src.k, { field: '必须条件', required: true, max: 40 })
        if (!MUST_CONDITIONS.includes(k)) throw new AppError(CODES.VALIDATION, '未知的必须条件')
        return { k, satisfied: src.satisfied === true, note: '' }
      })
      assertCondsComplete(conds, target, '暂时无法直接对话')
      const unmet = conds.filter((item) => item.satisfied !== true)
      if (unmet.length > 0) {
        throw new AppError(CODES.VALIDATION, '必须条件未满足，暂时无法直接对话')
      }

      /* 手机号只用于规则判档与客服联系；缺失时不阻断直聊，但手机号类规则不参与 */
      let phone = ''
      if (data.phone) phone = normalizePhone(data.phone)
      else {
        const ownPhone = decryptOwnPhone(user)
        if (ownPhone) {
          try { phone = normalizePhone(ownPhone) } catch (err) { phone = '' }
        }
      }
      const phoneBidx = phone ? blindIndex({ keys, value: phone }) : ''

      /* 同一用户 + 同一标的只留一条线索：再次进入直接复用已有会话 */
      const existing = await repo.find('leads', {
        uid,
        [productId ? 'productId' : 'demandId']: productId || demandId
      }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 1 })
      let lead = existing[0] || null
      const at = now()

      /* 已拦截线索不得复用：既不建会话，也不向货主投递任何消息 */
      if (lead && lead.status === LEAD_STATUS.BLOCKED) {
        const receipt = { leadId: lead.id, threadId: '', chatReady: false, receipt: NEUTRAL_RECEIPT }
        assertNoPlaintextContact(receipt)
        return receipt
      }

      if (!lead) {
        const profile = await readProfile(uid)
        const compare = buildCompare(conds, target, profile)
        /* 与提交咨询同口径判档：详情页直聊不能以默认档绕过 P0 规则 */
        const verdict = await judgeConsult({ uid, target, text: '', phone, phoneBidx })
        const blocked = verdict.tier === TIERS.P0
        /* 确定性线索号：同一用户同一标的并发直聊时只有一个请求能插入成功，
           其余请求复用同一条线索，避免一次点击产生多条线索与会话 */
        const leadId = 'L' + sha256Hex(`chat:${uid}:${productId || demandId}`).slice(0, 22)
        if (!blocked && phone) {
          await repo.updateWhere('users', { id: user.id }, {
            phoneCipher: encryptField({ keys, value: phone, aad: phoneAad(user.id) }),
            phoneBidx
          })
        }
        lead = {
          id: leadId,
          source: SOURCE_LABEL,
          productId: productId || '',
          demandId: demandId || '',
          uid,
          buyerBidx: phoneBidx,
          formSummary: `已确认必须条件，想就「${target.title}」直接沟通`,
          compare: compare.rows,
          matchPct: compare.matchPct,
          media: [],
          status: blocked ? LEAD_STATUS.BLOCKED : LEAD_STATUS.PENDING,
          assignedTo: '',
          tier: verdict.tier,
          tierName: verdict.tierName,
          ruleVersion: verdict.ruleVersion,
          hits: verdict.hits,
          createdAt: at,
          threadId: '',
          contactReleased: false
        }
        let created = true
        try {
          await repo.insert('leads', lead)
        } catch (err) {
          if (!err || err.code !== CODES.CONFLICT) throw err
          /* 并发直聊：另一个请求已经建好同一条线索，直接复用 */
          created = false
          const again = await repo.find('leads', {
            uid,
            [productId ? 'productId' : 'demandId']: productId || demandId
          }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 1 })
          const reused = again[0]
          if (!reused) throw err
          if (reused.status === LEAD_STATUS.BLOCKED) {
            const receipt = { leadId: reused.id, threadId: '', chatReady: false, receipt: NEUTRAL_RECEIPT }
            assertNoPlaintextContact(receipt)
            return receipt
          }
          lead = reused
        }
        if (created && blocked) {
          const life = blockedLifecycle(at)
          /* 拦截单与线索一起落库；并发下只有建单成功的请求写拦截记录 */
          try {
            await repo.insert('blocked', {
              id: randomId('B'),
              leadId,
              ruleId: verdict.hits.length ? verdict.hits[0].ruleId : '',
              reason: verdict.hits.length ? verdict.hits[0].reason : '命中 P0 规则',
              at,
              reviewDeadline: life.reviewDeadline,
              cleanupAt: life.cleanupAt
            })
          } catch (blockedErr) {
            if (!blockedErr || blockedErr.code !== CODES.CONFLICT) throw blockedErr
          }
          try {
            await appendAudit(repo, {
              actorType: 'system',
              actorId: 'filter',
              action: 'consult.blocked',
              target: leadId,
              reason: verdict.tierName,
              result: 'blocked',
              at
            })
          } catch (auditErr) {
            /* 拦截事实已落库：留痕失败不改变结果，也不能把回执变成报错 */
          }
          const receipt = { leadId, threadId: '', chatReady: false, receipt: NEUTRAL_RECEIPT }
          assertNoPlaintextContact(receipt)
          return receipt
        }
      }

      /* 开会话：双方各持一份消息副本，会话 id 复用线索 id。
         并发直聊时用 threadId 空值做 CAS，只有第一个请求投递开场消息，
         其余请求直接复用已建好的会话，避免重复消息。 */
      let threadId = lead.threadId || ''
      const ownerId = target.doc.ownerId
      /* 私密发布：会话对买家隐藏发布人主体与主页入口 */
      const secret = target.doc.visibility === VISIBILITIES.PRIVATE
      if (!threadId && ownerId && ownerId !== uid) {
        threadId = lead.id
        let ownsChat = true
        const hasThreadField = Object.prototype.hasOwnProperty.call(lead, 'threadId')
        if (hasThreadField) {
          const claimed = await repo.updateWhere(
            'leads', { id: lead.id, threadId: '' }, { threadId, chatOpenedAt: at }
          )
          ownsChat = !!(claimed && claimed.count)
          if (!ownsChat) {
            const fresh = await repo.get('leads', lead.id)
            if (fresh && fresh.threadId) threadId = fresh.threadId
            else ownsChat = true /* 历史线索没有 threadId 字段，退回旧路径 */
          }
        }
        if (ownsChat) {
          try {
            const ownerName = secret ? '私密发布' : await peerDisplayName(ownerId)
            const buyerName = maskName(String(user.nick || user.realname || '')) || '用户'
            await insertDirectChat({
              threadId,
              at,
              fromUid: uid,
              fromName: buyerName,
              toUid: ownerId,
              toName: ownerName,
              body: `我已确认全部必须条件，想就「${target.title}」与你直接沟通。`,
              targetType: target.type,
              targetId: target.doc.id,
              title: target.title,
              privateForUid: secret ? uid : ''
            })
            if (!hasThreadField) {
              await repo.updateWhere('leads', { id: lead.id }, { threadId, chatOpenedAt: at })
            }
          } catch (chatErr) {
            threadId = ''
            /* 消息没落库就把会话标记回滚，后续重试仍可开通 */
            await repo.updateWhere('leads', { id: lead.id, threadId: lead.id }, { threadId: '' })
              .catch(() => {})
          }
        }
      }

      /* 直聊与咨询单同样留痕：管理端服务记录才能看到「谁在什么时间开了会话」 */
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'chat.open',
          target: `${lead.id}:${lead.status}`,
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 会话已建立：留痕失败不阻断 */
      }

      /* 货主主页：对方公开了联系电话时一并返回，让会员可以直接拨打；
         私密发布不下发任何发布者身份，会话照常开通 */
      const myMember = await bizMemberOf(uid)
      const ownerMap = secret ? null : await publicOwnerMap([ownerId], { revealPhone: myMember })
      const info = (ownerMap && ownerMap.get(ownerId)) || {}
      const phonePublic = !secret && myMember && info.phonePublic === true

      const result = {
        threadId,
        chatReady: !!threadId,
        peerName: secret ? '私密发布' : await peerDisplayName(ownerId),
        /* 直聊标识：对方 / 自己为商机会员时，会话顶部展示「商机会员」；私密发布不暴露会员身份 */
        peerMember: secret ? false : await bizMemberOf(ownerId),
        myMember,
        targetType: target.type,
        targetId: target.doc.id,
        title: target.title,
        /* 私密发布标记：前端据此隐藏「查看主页」与主体信息 */
        private: secret,
        /* 货主自愿公开联系电话且本人为商机会员时给明文；私密发布与未公开时一律不给 */
        phonePublic,
        phone: phonePublic ? (info.phone || '') : '',
        phoneMasked: secret ? '' : (info.phoneMasked || ''),
        /* 货主公开了电话但本人不是会员：前端引导开通 */
        memberOnlyContact: !secret && !myMember && info.phoneShared === true,
        ownerSubject: secret ? '' : (info.revealed ? (info.subject || '') : '')
      }
      assertNoPlaintextContactAllowingPhone(result, 'phone')
      return result
    },

    /**
     * 催办：用户对仍在流转中的咨询发起一次提醒。
     * 24 小时内只允许一次，避免刷屏；已成交 / 已关闭 / 已拦截不再催办。
     */
    'lead.remind': async (data, ctx) => {
      const uid = ctx.openid
      const leadId = str(data.leadId || data.id, { field: '咨询', required: true, max: 64 })
      const lead = await repo.get('leads', leadId)
      if (!lead) throw new AppError(CODES.NOT_FOUND, '咨询不存在')
      if (lead.uid !== uid) throw new AppError(CODES.FORBIDDEN, '只能催办自己的咨询')
      const allowed = [LEAD_STATUS.PENDING, LEAD_STATUS.FOLLOWING, LEAD_STATUS.MATCHED]
      if (allowed.indexOf(lead.status) < 0) {
        throw new AppError(CODES.CONFLICT, `当前状态「${lead.status}」无需催办`)
      }
      const at = now()
      const last = Number(lead.remindedAt) || 0
      if (last && at - last < 24 * 60 * 60 * 1000) {
        throw new AppError(CODES.CONFLICT, '已催办，请 24 小时后再试')
      }
      const remindCount = (Number(lead.remindCount) || 0) + 1
      const res = await repo.updateWhere('leads', { id: leadId, uid }, {
        remindedAt: at,
        remindCount,
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '咨询状态已更新，请刷新后重试')
      try {
        await appendAudit(repo, {
          actorType: 'user',
          actorId: uid,
          action: 'lead.remind',
          target: leadId,
          reason: `第 ${remindCount} 次催办`,
          result: 'allow',
          at
        })
      } catch (auditErr) {
        /* 已记录催办：留痕失败不阻断 */
      }
      return { leadId, remindedAt: at, remindCount, statusText: '已提醒坐席优先跟进' }
    },

    'mine.list': async (data, ctx) => {
      const uid = ctx.openid
      const paging = normalizePaging(data)
      /* 已拦截线索只留在风控侧：用户端不展示，避免反推规则或形成无法操作的红点 */
      const query = { uid, status: { $ne: LEAD_STATUS.BLOCKED } }
      const total = await repo.count('leads', query)
      const rows = await repo.find('leads', query, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: paging.skip,
        limit: paging.limit
      })
      const items = []
      const productIds = Array.from(new Set(rows.filter((l) => l.productId).map((l) => l.productId)))
      const demandIds = Array.from(new Set(rows.filter((l) => l.demandId).map((l) => l.demandId)))
      const [products, demands] = await Promise.all([
        productIds.length ? repo.find('products', { id: { $in: productIds } }, { limit: productIds.length }) : [],
        demandIds.length ? repo.find('demands', { id: { $in: demandIds } }, { limit: demandIds.length }) : []
      ])
      const targetById = new Map()
      for (const p of products) targetById.set(p.id, { title: p.title || '', ownerId: p.ownerId, secret: p.visibility === VISIBILITIES.PRIVATE })
      for (const d of demands) targetById.set(d.id, { title: d.title || '', ownerId: d.ownerId, secret: d.visibility === VISIBILITIES.PRIVATE })
      /* 只有「已对接 / 已成交」才按公开范围展示对方主体；未建联前一律不露；
         私密发布的目标全程不注入身份，只能由对方主动发名片披露 */
      const matchedIds = []
      for (const lead of rows) {
        if (lead.status !== LEAD_STATUS.MATCHED && lead.status !== LEAD_STATUS.DEALT) continue
        const target = targetById.get(lead.productId || lead.demandId)
        if (target && target.ownerId && !target.secret) matchedIds.push(target.ownerId)
      }
      const ownerMap = await publicOwnerMap(matchedIds)
      for (const lead of rows) {
        const target = targetById.get(lead.productId || lead.demandId)
        const view = projectLeadForUser(lead, target ? target.title : '')
        if ((lead.status === LEAD_STATUS.MATCHED || lead.status === LEAD_STATUS.DEALT) && target && !target.secret) {
          attachOwnerInfo(view, ownerMap.get(target.ownerId))
        }
        items.push(view)
      }
      const result = { items, page: paging.page, limit: paging.limit, total, hasMore: paging.skip + rows.length < total }
      assertNoPlaintextContact(result)
      return result
    },

    /** 我发布的（商品 + 需求），只返回自己的 */
    'mine.publish.list': async (data, ctx) => {
      const uid = ctx.openid
      const paging = normalizePaging(data)
      /* 已删除的内容不再回到「我发布的」，避免删了又出现 */
      const query = { ownerId: uid, deleted: { $ne: true } }
      const newsQuery = { uid, deleted: { $ne: true } }
      const productTotal = await repo.count('products', query)
      const demandTotal = await repo.count('demands', query)
      const newsTotal = await repo.count('news', newsQuery)
      const products = await repo.find('products', query, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: paging.skip,
        limit: paging.limit
      })
      const demands = await repo.find('demands', query, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: paging.skip,
        limit: paging.limit
      })
      const news = await repo.find('news', newsQuery, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: paging.skip,
        limit: paging.limit
      })
      const result = {
        /* 自助恢复标识只回给属主：不在公共投影里下发 openid */
        products: products.map((row) => Object.assign(projectProduct(row), {
          selfOffline: !!row.offlineBy && row.offlineBy === uid
        })),
        demands: demands.map((row) => Object.assign(projectDemand(row), {
          selfClosed: !!row.closedBy && row.closedBy === uid,
          closeReason: row.closeReason || ''
        })),
        /* 我投稿的资讯：只回展示所需字段，正文仍从资讯详情读取 */
        news: news.map((row) => ({
          id: row.id,
          title: row.title || '',
          summary: row.summary || '',
          city: row.city || '',
          status: row.status || '',
          reason: row.reason || '',
          views: Number(row.views) || 0,
          createdAt: Number(row.createdAt) || 0
        })),
        page: paging.page,
        limit: paging.limit,
        total: productTotal + demandTotal + newsTotal,
        hasMore: paging.skip + products.length < productTotal ||
          paging.skip + demands.length < demandTotal ||
          paging.skip + news.length < newsTotal
      }
      assertNoPlaintextContact(result)
      return result
    },

    'msg.list': async (data, ctx) => {
      const uid = ctx.openid
      /* 注销 / 停用后不再提供站内信读取，避免停用账号继续使用平台能力 */
      await mustUser(ctx)
      const paging = normalizePaging(data)
      /* 服务端只保留 30 天聊天记录：更早的消息不再查询 / 下发 */
      const query = { 'payload.uid': uid, createdAt: { $gte: chatCutoff(now()) } }
      const total = await repo.count('outbox', query)
      const rows = await repo.find('outbox', query, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: paging.skip,
        limit: paging.limit
      })
      /* 名片联系电话：读取时解密发送人号码（号码不落库），同一发送人只解一次 */
      const cardPhones = new Map()
      for (const msg of rows) {
        const p = msg.payload || {}
        if (!p.card || p.card.sharePhone !== true) continue
        const senderUid = p.from === 'peer' ? (p.peerUid || '') : uid
        if (!senderUid || cardPhones.has(senderUid)) continue
        const card = await cardWithPhone(p.card, senderUid)
        cardPhones.set(senderUid, card.phone || '')
      }
      /* 商机会员：消息列表里也要直接看到对方标识，与会话内保持同一口径 */
      const peerMembers = new Map()
      for (const msg of rows) {
        const p = msg.payload || {}
        if (!(p.channel === 'direct' || msg.type === 'direct.chat')) continue
        const peerUid = p.peerUid || ''
        if (!peerUid || peerMembers.has(peerUid)) continue
        peerMembers.set(peerUid, await bizMemberOf(peerUid))
      }
      const result = {
        items: rows.map((msg) => {
          const p = msg.payload || {}
          const from = p.from || 'system'
          const senderUid = from === 'peer' ? (p.peerUid || '') : uid
          const phone = p.card && p.card.sharePhone === true ? (cardPhones.get(senderUid) || '') : ''
          const isDirect = p.channel === 'direct' || msg.type === 'direct.chat'
          const peerMember = isDirect && peerMembers.get(p.peerUid || '') === true
          /* 图片 / 视频：7 天未打开即过期，过期只下发占位标记，不再暴露文件地址 */
          const media = mediaState(p, msg.createdAt, now())
          return {
            id: msg.id,
            type: msg.type,
            channel: p.channel || '',
            from,
            staffName: p.staffName || '',
            title: p.title || '站内消息',
            body: p.body || '',
            kind: chatKindOf(p),
            image: media.image,
            video: media.video,
            poster: media.poster,
            mediaExpired: media.expired,
            mediaExpiresAt: media.expiresAt,
            card: p.card ? Object.assign({}, p.card, phone ? { phone } : {}) : null,
            /* 系统提示（下架 / 退回等）的原因单独下发，用户端按「系统提示」样式展示 */
            reason: p.reason || '',
            isSystem: from === 'system',
            status: msg.status,
            /* 关联线索号：本人线索，用户可从站内消息查看进展 */
            leadId: p.leadId || '',
            targetType: p.targetType || '',
            targetId: p.targetId || '',
            /* 直聊会话：threadId 用于消息页聚合，peerName 由服务端按公开范围脱敏 */
            threadId: p.threadId || '',
            peerName: p.peerName || '',
            /* 私密发布会话：前端隐藏「查看主页」与主体信息 */
            private: p.private === true,
            /* 对方为商机会员时，消息列表直接在名字后展示标识 */
            peerMember,
            memberLabel: peerMember ? '商机会员' : '',
            /* 客服回复 / 对方直聊消息按 readByUser 计未读，系统通知沿用 status */
            unread: from === 'staff' || from === 'peer' ? msg.readByUser !== true : msg.status !== 'read',
            createdAt: msg.createdAt
          }
        }),
        page: paging.page,
        limit: paging.limit,
        total,
        hasMore: paging.skip + rows.length < total
      }
      /* 名片里本人主动展示的电话属于受控展示，其余联系方式仍参与明文拦截 */
      assertNoPlaintextContactAllowingPhone(result, 'phone')
      return result
    },

    'msg.read': async (data, ctx) => {
      const id = str(data.id, { field: '消息', required: true, max: 64 })
      const msg = await repo.get('outbox', id)
      if (!msg || !msg.payload || msg.payload.uid !== ctx.openid) {
        throw new AppError(CODES.NOT_FOUND, '消息不存在')
      }
      await repo.updateWhere('outbox', { id, 'payload.uid': ctx.openid }, { status: 'read', readByUser: true })
      return { id, status: 'read' }
    },

    /**
     * 会话级展示授权：仅对当前直聊会话的另一方展示本人主体与联系方式。
     * 不改变主页 exposure，其他人看主页仍然隐藏。
     */
    'chat.reveal': async (data, ctx) => {
      const uid = ctx.openid
      const threadId = str(data.threadId || data.id, { field: '会话', required: true, max: 64 })
      const lead = await repo.get('leads', threadId)
      if (!lead) throw new AppError(CODES.NOT_FOUND, '会话不存在')
      const target = lead.productId
        ? await repo.get('products', lead.productId)
        : (lead.demandId ? await repo.get('demands', lead.demandId) : null)
      const ownerId = (target && target.ownerId) || ''
      if (lead.uid !== uid && ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '无权操作该会话')
      const on = data.on !== false
      const id = 'rv_' + sha256Hex(String(threadId) + '|' + String(uid)).slice(0, 22)
      const patch = { threadId, uid, on, at: now() }
      const existing = await repo.get('chatReveals', id)
      if (existing) await repo.updateWhere('chatReveals', { id }, patch)
      else await repo.insert('chatReveals', Object.assign({ id }, patch))
      return { threadId, on }
    },

    /**
     * 直聊会话内容：必须条件满足后由 consult.submit 自动开通。
     * 只有会话双方可读；读取即把对方消息标记为已读。
     */
    'msg.thread': async (data, ctx) => {
      const uid = ctx.openid
      const threadId = str(data.threadId || data.id, { field: '会话', required: true, max: 64 })
      const lead = await repo.get('leads', threadId)
      if (!lead) throw new AppError(CODES.NOT_FOUND, '会话不存在')
      if (lead.status === LEAD_STATUS.BLOCKED) throw new AppError(CODES.FORBIDDEN, '该会话不可用')
      const target = lead.productId
        ? await repo.get('products', lead.productId)
        : (lead.demandId ? await repo.get('demands', lead.demandId) : null)
      const ownerId = (target && target.ownerId) || ''
      if (lead.uid !== uid && ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '无权查看该会话')

      const rows = await repo.find('outbox', {
        'payload.uid': uid,
        'payload.threadId': threadId,
        /* 聊天记录只保留 30 天，更早的消息不再下发 */
        createdAt: { $gte: chatCutoff(now()) }
      }, {
        sort: { field: 'createdAt', dir: 'asc' },
        limit: 200
      })
      /* 拉取即已读：对方消息逐条置为已读，未读数在消息列表里自然归零 */
      for (const msg of rows) {
        const p = msg.payload || {}
        if (p.from === 'peer' && msg.readByUser !== true) {
          await repo.updateWhere('outbox', { id: msg.id, 'payload.uid': uid }, {
            status: 'read',
            readByUser: true
          }).catch(() => {})
        }
      }
      const peerId = lead.uid === uid ? ownerId : lead.uid
      /* 私密发布：买家侧不展示发布人主体、主页入口与联系方式 */
      const isPrivateTarget = !!(target && target.visibility === VISIBILITIES.PRIVATE)
      const buyerView = isPrivateTarget && lead.uid === uid
      const peerName = buyerView ? '私密发布' : await peerDisplayName(peerId)
      /* 私密发布会话：买家侧不暴露对方是否为商机会员 */
      const [myMember, peerMember] = await Promise.all([bizMemberOf(uid), buyerView ? false : bizMemberOf(peerId)])
      const revealRows = await repo.find('chatReveals', { threadId }, { limit: 4 })
      const myReveal = revealRows.some((row) => row.uid === uid && row.on === true)
      const peerReveal = revealRows.find((row) => row.uid === peerId && row.on === true)
      let peerContact = null
      if (!buyerView && peerReveal && peerId) {
        const [peerUser, peerProfile] = await Promise.all([repo.get('users', peerId), readProfile(peerId)])
        peerContact = {
          subject: decryptProfileField(peerProfile, 'subject'),
          subjectType: (peerProfile && peerProfile.subjectType) || '',
          contact: decryptProfileField(peerProfile, 'contact'),
          phone: decryptOwnPhone(peerUser),
          realname: decryptOwnRealname(peerUser)
        }
      }
      /* 名片联系电话：读取时解密发送人号码（号码不落库），同一发送人只解一次 */
      const cardPhones = new Map()
      for (const msg of rows) {
        const p = msg.payload || {}
        if (!p.card || p.card.sharePhone !== true) continue
        const senderUid = p.from === 'peer' ? (p.peerUid || '') : (p.uid || '')
        if (!senderUid || cardPhones.has(senderUid)) continue
        const card = await cardWithPhone(p.card, senderUid)
        cardPhones.set(senderUid, card.phone || '')
      }
      /* 会话标的卡：双方看到同一条商品 / 需求，前端可点进详情，避免对话跑题 */
      const targetMedia = Array.isArray(target && target.media) ? target.media : []
      const targetCover = targetMedia
        .filter((m) => m && (m.kind === 'image' || /^image\//i.test(String(m.type || ''))))
        .map((m) => m.fileId || m.url || '')[0] || ''
      const targetCard = target ? {
        type: lead.productId ? 'product' : 'demand',
        id: target.id,
        title: target.title || lead.formSummary || '',
        cover: targetCover,
        price: Number(target.price || target.budget || 0),
        priceMode: target.priceMode || target.budgetMode || 'fixed',
        priceUnit: target.priceUnit || target.budgetUnit || '',
        currencySymbol: target.currencySymbol || '¥',
        city: target.city || '',
        tradeMode: target.tradeMode || '',
        status: target.status || ''
      } : null
      const result = {
        threadId,
        peerName,
        /* 对方匿名主页键：会话头像点击进入对方主页用，不可反推 openid */
        peerKey: buyerView ? '' : (peerId ? ownerKeyOf(peerId) : ''),
        title: (target && target.title) || lead.formSummary || '',
        targetType: lead.productId ? 'product' : 'demand',
        targetId: lead.productId || lead.demandId || '',
        /* 顶部商品卡展示字段：仅公开信息，不含联系方式 */
        target: targetCard,
        status: lead.status,
        /* 私密发布会话标记：前端隐藏「查看主页」与主体信息 */
        private: buyerView,
        myReveal,
        peerContact,
        /* 商机会员标识：跟在会话标题（对方名字）后面，只表示对方是商机会员 */
        myMember,
        peerMember,
        memberLabel: peerMember ? '商机会员' : '',
        items: rows.map((msg) => {
          const p = msg.payload || {}
          const senderUid = p.from === 'peer' ? (p.peerUid || '') : (p.uid || '')
          const phone = p.card && p.card.sharePhone === true ? (cardPhones.get(senderUid) || '') : ''
          const media = mediaState(p, msg.createdAt, now())
          return {
            id: msg.id,
            role: p.from === 'me' ? 'me' : 'peer',
            kind: chatKindOf(p),
            text: p.body || '',
            image: media.image,
            video: media.video,
            poster: media.poster,
            mediaExpired: media.expired,
            mediaExpiresAt: media.expiresAt,
            card: p.card ? Object.assign({}, p.card, phone ? { phone } : {}) : null,
            private: p.private === true,
            at: Number(msg.createdAt) || 0,
            /* 已读回执：客服在管理端点开会话后，用户侧展示「已读」 */
            read: p.from === 'me' ? msg.readByStaff === true : false
          }
        })
      }
      /* 会话双方授权后才回传对方联系方式；名片电话是本人主动展示，均属受控展示 */
      assertNoPlaintextContactAllowingPhone({ threadId, peerName: result.peerName, title: result.title, items: result.items }, 'phone')
      return result
    },

    /** 用户给平台客服留言；带 threadId 时改为给对方（货主 / 需求方）直聊 */
    'msg.send': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      /* 消息类型：文本 / 图片 / 视频 / 个人名片；媒体与名片不参与文本内容校验 */
      const kind = data.kind ? enumOf(data.kind, ['text', 'image', 'video', 'card'], '消息类型') : 'text'
      const at = now()
      let body = ''
      let image = ''
      let video = ''
      let poster = ''
      let card = null
      if (kind === 'image') {
        image = str(data.image, { field: '图片', required: true, max: 1024 })
        if (!/^(https:\/\/|cloud:\/\/)/i.test(image)) {
          throw new AppError(CODES.VALIDATION, '图片需先上传到云端')
        }
        body = '[图片]'
      } else if (kind === 'video') {
        video = str(data.video, { field: '视频', required: true, max: 1024 })
        if (!/^(https:\/\/|cloud:\/\/)/i.test(video)) {
          throw new AppError(CODES.VALIDATION, '视频需先上传到云端')
        }
        poster = str(data.poster || '', { field: '视频封面', max: 1024 })
        if (poster && !/^(https:\/\/|cloud:\/\/)/i.test(poster)) {
          throw new AppError(CODES.VALIDATION, '视频封面需先上传到云端')
        }
        body = '[视频]'
      } else if (kind === 'card') {
        /* 名片内容由服务端按本人档案生成，避免客户端伪造主体 / 实名状态 */
        card = buildChatCard(user, await readProfile(uid))
        body = '[名片] ' + (card.subject || card.name)
      } else {
        body = str(data.body || data.content, { field: '消息内容', required: true, max: 500 })
        assertNoContactInText(body, '消息内容')
      }
      const threadId = str(data.threadId, { field: '会话', max: 64 })
      if (threadId) {
        const lead = await repo.get('leads', threadId)
        if (!lead || lead.status === LEAD_STATUS.BLOCKED) {
          throw new AppError(CODES.NOT_FOUND, '会话不存在')
        }
        const target = lead.productId
          ? await repo.get('products', lead.productId)
          : (lead.demandId ? await repo.get('demands', lead.demandId) : null)
        const ownerId = (target && target.ownerId) || ''
        const isBuyer = lead.uid === uid
        if (!isBuyer && ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '无权在该会话中发言')
        const peerId = isBuyer ? ownerId : lead.uid
        if (!peerId) throw new AppError(CODES.NOT_FOUND, '对方账号不存在')
        const senderName = await peerDisplayName(uid)
        const privateForUid = target && target.visibility === VISIBILITIES.PRIVATE ? lead.uid : ''
        const mine = await insertDirectChat({
          threadId,
          at,
          fromUid: uid,
          fromName: senderName,
          toUid: peerId,
          toName: await peerDisplayName(peerId),
          body,
          kind,
          image,
          video,
          poster,
          card,
          targetType: lead.productId ? 'product' : 'demand',
          targetId: lead.productId || lead.demandId || '',
          title: (target && target.title) || '',
          privateForUid
        })
        /* 直聊消息命中敏感词：写入风险单，交给平台人工查看 */
        if (kind === 'text') {
          try {
            await recordSensitiveRisk({
              repo, at, type: '对话', targetId: threadId,
              targetLabel: '站内对话 ' + ((target && target.title) || threadId),
              uid, text: body
            })
          } catch (riskErr) { /* 风险登记不影响消息发送 */ }
        }
        /* 微信订阅消息：对方不在小程序里时也能收到提醒，点开直达该会话 */
        await pushChatNotice(peerId, {
          sender: privateForUid && peerId === lead.uid ? '私密发布' : senderName,
          preview: kind === 'image' ? '[图片]' : (kind === 'video' ? '[视频]' : (kind === 'card' ? '[名片]' : body)),
          threadId,
          at
        })
        /* 回显给发送人：卡片带上本人当前号码，号码只回显不落库 */
        return {
          id: mine,
          threadId,
          kind,
          body,
          image,
          video,
          poster,
          card: card ? Object.assign({}, card, { phone: decryptOwnPhone(user) || '' }) : null,
          createdAt: at
        }
      }
      const doc = {
        id: randomId('M'),
        type: 'kf.chat',
        payload: {
          uid,
          channel: 'kf',
          from: 'user',
          title: '用户留言',
          body,
          kind,
          image,
          video,
          poster,
          card,
          staffName: '',
          /* 委托 / 商品上下文：管理端按 targetId 汇总对话，用户详情也能按对象归组 */
          targetType: ['agency', 'product', 'demand'].includes(String(data.targetType || '')) ? String(data.targetType) : '',
          targetId: String(data.targetId || '').slice(0, 64),
          targetTitle: String(data.targetTitle || '').slice(0, 120)
        },
        status: 'pending',
        readByUser: true,
        readByStaff: false,
        createdAt: at
      }
      await repo.insert('outbox', doc)
      /* 客服留言命中敏感词：写入风险单，平台必须人工查看处理 */
      if (kind === 'text') {
        try {
          await recordSensitiveRisk({
            repo, at, type: '对话', targetId: uid,
            targetLabel: '用户留言 ' + (user.nick || uid),
            uid, text: body
          })
        } catch (riskErr) { /* 风险登记不影响消息发送 */ }
      }
      return {
        id: doc.id,
        kind,
        body,
        image,
        video,
        poster,
        /* 回显给发送人：卡片带上本人当前号码，号码只回显不落库 */
        card: card ? Object.assign({}, card, { phone: decryptOwnPhone(user) || '' }) : null,
        createdAt: at
      }
    },

    /**
     * 打开聊天图片 / 视频：登记已打开，把媒体保留期从 7 天延长到 30 天。
     * 客户端拿到成功回执后再落本地缓存，过期媒体不再允许打开。
     */
    'msg.mediaOpen': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const id = str(data.id, { field: '消息', required: true, max: 64 })
      const msg = await repo.get('outbox', id)
      const p = (msg && msg.payload) || null
      if (!msg || !p || p.uid !== uid) throw new AppError(CODES.NOT_FOUND, '消息不存在')
      if (!p.image && !p.video) throw new AppError(CODES.VALIDATION, '该消息没有可查看的图片或视频')
      const state = mediaState(p, msg.createdAt, now())
      if (state.expired) throw new AppError(CODES.VALIDATION, '图片/视频已过期，无法查看')
      const openedAt = Number(p.mediaOpenedAt) || now()
      await repo.updateWhere('outbox', { id, 'payload.uid': uid }, {
        payload: Object.assign({}, p, { mediaOpenedAt: openedAt })
      })
      /* 打开登记：清理任务据此把文件保留到消息 30 天到期，而不是 7 天 */
      try {
        const url = String(p.video || p.image || '')
        const key = 'cm_' + sha256Hex(url).slice(0, 22)
        const row = await repo.get('chatMedia', key)
        const patch = {
          id: key,
          url,
          kind: p.video ? 'video' : 'image',
          uid: String(p.uid || ''),
          createdAt: Number(msg.createdAt) || openedAt,
          openedAt,
          expireAt: (Number(msg.createdAt) || openedAt) + CHAT_RETENTION_DAYS * DAY_MS
        }
        if (row) await repo.updateWhere('chatMedia', { id: key }, patch)
        else await repo.insert('chatMedia', Object.assign({ updatedAt: openedAt }, patch))
      } catch (err) {
        /* 登记失败不影响本次查看，文件最多按未打开口径清理 */
      }
      return { id, openedAt, expiresAt: state.expiresAt }
    },

    /**
     * 注销账号申请：提交后进入管理端「注销申请」，管理员核实后停用账号。
     * 注销不可逆，因此这里只登记申请，不直接停用。
     */
    'account.deleteApply': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const reason = str(data.reason || '', { field: '注销原因', max: 200 })
      const rows = await repo.find('accountRequests', { uid }, { limit: 10 })
      if (rows.some((r) => r.status === '待处理')) {
        throw new AppError(CODES.CONFLICT, '已有待处理的注销申请，平台会尽快联系你')
      }
      const at = now()
      const doc = {
        id: randomId('AD'),
        uid,
        reason,
        status: '待处理',
        handlerNote: '',
        handledAt: 0,
        handledBy: '',
        createdAt: at,
        updatedAt: at
      }
      await repo.insert('accountRequests', doc)
      return { id: doc.id, status: doc.status, createdAt: at }
    },

    /** 注销申请进度：设置页展示，避免用户重复提交 */
    'account.deleteStatus': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const rows = await repo.find('accountRequests', { uid }, {
        sort: { field: 'createdAt', dir: 'desc' },
        limit: 1
      })
      const row = rows[0]
      if (!row) return { status: '' }
      return {
        id: row.id,
        status: row.status || '待处理',
        handlerNote: row.handlerNote || '',
        createdAt: Number(row.createdAt) || 0,
        handledAt: Number(row.handledAt) || 0
      }
    },

    /** 撤回注销申请：仅待处理状态可撤回 */
    'account.deleteCancel': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const rows = await repo.find('accountRequests', { uid }, { limit: 10 })
      const open = rows.filter((r) => r.status === '待处理')
      if (!open.length) throw new AppError(CODES.CONFLICT, '当前没有待处理的注销申请')
      const at = now()
      for (const row of open) {
        await repo.updateWhere('accountRequests', { id: row.id }, { status: '已撤销', handledAt: at, updatedAt: at })
      }
      return { cancelled: open.length }
    },

    /**
     * 举报 / 投诉 / 意见反馈：用户端提交后进入管理端「举报反馈」队列。
     * 处置结果通过站内信回写给提交人，避免「提交后没有下文」。
     */
    'report.create': async (data, ctx) => {
      const uid = ctx.openid
      const user = await mustUser(ctx)
      const type = enumOf(data.type || '意见反馈', REPORT_TYPES, '反馈类型')
      const content = str(data.content, { field: '反馈内容', required: true, min: 5, max: 800 })
      const targetType = enumOf(data.targetType || 'other', REPORT_TARGETS, '对象类型')
      const targetId = str(data.targetId || '', { field: '对象标识', max: 64 })
      const targetTitle = str(data.targetTitle || '', { field: '对象名称', max: 120 })
      /* 联系方式默认用微信授权过来的本人手机号，用户手填时以手填为准 */
      const contact = str(data.contact || decryptOwnPhone(user) || '', { field: '联系方式', max: 60 })
      const at = now()
      /* 24 小时内最多 10 条：举报是人工处置，需要防止刷接口把队列打爆 */
      const rows = await repo.find('reports', { uid }, { limit: 50 })
      const recent = rows.filter((r) => Number(r.createdAt || 0) >= at - 24 * 60 * 60 * 1000)
      if (recent.length >= 10) throw new AppError(CODES.RATE_LIMITED, '今天提交次数过多，请明天再试')
      const doc = {
        id: randomId('RP'),
        type,
        targetType,
        targetId,
        targetTitle,
        content,
        contact,
        uid,
        status: REPORT_STATUS.PENDING,
        handlerNote: '',
        handledAt: 0,
        handledBy: '',
        createdAt: at,
        updatedAt: at
      }
      await repo.insert('reports', doc)
      return { id: doc.id, type, status: doc.status, createdAt: at }
    },

    /** 我提交的举报 / 反馈：展示处置进度与平台回复 */
    'report.mine': async (data, ctx) => {
      const uid = ctx.openid
      await mustUser(ctx)
      const page = normalizePaging(data)
      const rows = await repo.find('reports', { uid }, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: (page.page - 1) * page.limit,
        limit: page.limit
      })
      const total = await repo.count('reports', { uid })
      return {
        items: rows.map((r) => ({
          id: r.id,
          type: r.type || '意见反馈',
          targetType: r.targetType || 'other',
          targetTitle: r.targetTitle || '',
          content: r.content || '',
          status: r.status || REPORT_STATUS.PENDING,
          handlerNote: r.handlerNote || '',
          createdAt: Number(r.createdAt) || 0,
          handledAt: Number(r.handledAt) || 0
        })),
        total,
        page: page.page,
        limit: page.limit,
        statusList: [REPORT_STATUS.PENDING, REPORT_STATUS.DOING, REPORT_STATUS.DONE, REPORT_STATUS.REJECTED]
      }
    },

    /** 我发布的需求收到的响应，供消息页需求响应列表使用 */
    'demand.responses': async (data, ctx) => {
      const uid = ctx.openid
      const demandId = str(data.demandId || data.id, { field: '求购', required: true, max: 64 })
      const demand = await repo.get('demands', demandId)
      if (!demand) throw new AppError(CODES.NOT_FOUND, '需求不存在')
      if (demand.ownerId !== uid) throw new AppError(CODES.FORBIDDEN, '只能查看自己发布需求的响应')
      const rows = await repo.find('leads', { demandId }, {
        sort: [
          { field: 'matchPct', dir: 'desc' },
          { field: 'createdAt', dir: 'asc' }
        ],
        limit: 100
      })
      const items = []
      for (const lead of rows) {
        /* 已拦截线索对需求方不可见，避免暴露风控结果 */
        if (lead.status === LEAD_STATUS.BLOCKED) continue
        const respondent = await repo.get('users', lead.uid)
        const compare = Array.isArray(lead.compare) ? lead.compare : []
        const metCount = compare.filter((row) => row.res === '满足' || row.res === '一致').length
        items.push({
          id: lead.id,
          masked: respondent && respondent.nick ? maskName(respondent.nick) : '响应人' + String(lead.id).slice(-4),
          matchPct: Number(lead.matchPct) || 0,
          status: lead.status,
          total: compare.length,
          metCount,
          allMet: compare.length > 0 && metCount === compare.length,
          conds: compare.map((row) => ({ n: row.n, ok: row.res === '满足' || row.res === '一致' })),
          at: lead.createdAt
        })
      }
      const result = { demandId, title: demand.title, items }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 平台公开配置：小程序「商机」页展示企微活码、套餐价格与客服信息。
     * 只读、不含任何管理字段；未配置时返回空活码，由前端显示占位提示。
     */
    'site.get': async () => {
      const doc = (await repo.get('settings', 'site')) || {}
      return {
        site: {
          qrUrl: doc.qrUrl || '',
          qrNote: doc.qrNote || '添加企业微信客服，核对收款后即时开通商机会员',
          wecomId: doc.wecomId || '',
          planPrice: doc.planPrice || '99 元 / 月',
          planDays: Number(doc.planDays) || 30,
          planNote: doc.planNote || '商机会员可按需求匹配全平台同类产品，并查看已领取商机的联系方式',
          siteName: doc.siteName || '算力聚合',
          servicePhone: doc.servicePhone || '',
          serviceTime: doc.serviceTime || '工作日 09:00 - 18:00'
        }
      }
    },

    /** 客户端可获取的常量口径（选项列表、限制条款等），避免前后端两套枚举漂移 */
    'meta.options': async () => {
      return {
        tradeMode: {
          supply: TRADE_MODE_OPTIONS.supply.slice(),
          demand: TRADE_MODE_OPTIONS.demand.slice()
        },
        rentLimits: RENT_LIMITS.slice(),
        mustConditions: MUST_CONDITIONS.slice()
      }
    }
  }
}

module.exports = { createUserHandlers, NEUTRAL_RECEIPT, SUBJECT_TYPES, REPORT_TYPES, REPORT_TARGETS, REPORT_STATUS }
