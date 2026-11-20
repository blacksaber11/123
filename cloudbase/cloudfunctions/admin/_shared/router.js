'use strict'

const { AppError, CODES, toPublic } = require('./errors')
const { createUserHandlers } = require('./handlers.user')
const { createAdminHandlers } = require('./handlers.admin')
const { createMarketUserHandlers, createMarketAdminHandlers } = require('./market')
const { createInsightsUserHandlers, createInsightsAdminHandlers } = require('./insights')
const { createPromoteUserHandlers, createPromoteAdminHandlers } = require('./promote')
const { createSubscribe } = require('./subscribe')
const { can } = require('./rbac')
const { hit, windowStartOf } = require('./ratelimit')
const { appendAudit } = require('./audit')
const { sha256Hex } = require('./crypto')
const { RATE_LIMITS } = require('./constants')
const { recordUserEvent, cleanupUserEvents } = require('./events')

/** 用户行为事件映射：动作成功后自动落库，业务 handler 不需要重复写 */
const USER_EVENT_ACTIONS = Object.freeze({
  'auth.login': { kind: 'login', page: 'login' },
  'product.publish': { kind: 'publish_product', page: 'publish' },
  'product.submit': { kind: 'publish_product', page: 'publish' },
  'demand.publish': { kind: 'publish_demand', page: 'publish' },
  'demand.submit': { kind: 'publish_demand', page: 'publish' },
  'agency.submit': { kind: 'agency', page: 'publish' },
  'consult.submit': { kind: 'consult', page: 'consult' },
  'chat.open': { kind: 'chat', page: 'msg' },
  'biz.claim': { kind: 'claim', page: 'biz' },
  'biz.list': { kind: 'biz_open', page: 'biz' },
  'fav.set': { kind: 'favorite', page: 'favorite', onlyOn: true },
  'follow.set': { kind: 'follow', page: 'follow', onlyOn: true },
  'product.detail': { kind: 'view_product', page: 'product' },
  'demand.detail': { kind: 'view_demand', page: 'demand' },
  'owner.home': { kind: 'view_owner', page: 'owner' }
})

/** 浏览类事件：同一用户对同一对象 30 分钟内只记一次，避免反复打开详情把事件表写爆 */
const VIEW_EVENT_KINDS = Object.freeze({ view_product: true, view_demand: true, view_owner: true })
const VIEW_EVENT_WINDOW_MS = 30 * 60 * 1000
const VIEW_SEEN_MAX = 2048
const viewSeen = new Map()

function seenRecently(uid, kind, refId, at) {
  const key = `${uid}:${kind}:${refId}`
  const exp = viewSeen.get(key)
  if (exp && exp > at) return true
  viewSeen.set(key, at + VIEW_EVENT_WINDOW_MS)
  if (viewSeen.size > VIEW_SEEN_MAX) {
    for (const [k, v] of viewSeen) {
      if (v <= at) viewSeen.delete(k)
    }
    if (viewSeen.size > VIEW_SEEN_MAX) viewSeen.clear()
  }
  return false
}

/**
 * 未登录也可调用的用户端只读动作。
 * 小程序冷启动时首屏渲染早于静默登录完成，首页横幅 / 公开站点配置必须在登录前就能读到，
 * 否则首屏会缺失横幅，且要等用户切页触发 onShow 才会补拉。
 * 这些动作不读取 openid，返回体不含任何个人数据，可安全匿名访问。
 */
const PUBLIC_USER_ACTIONS = Object.freeze({
  'site.get': true,
  'meta.options': true,
  /* 资讯是公开内容：首屏冷启动早于静默登录完成，若要求登录，
     列表会直接落到「资讯加载失败」空态（微信审核实测驳回原因）。
     两个接口匿名时只返回公开字段，点赞 / 评论状态按未登录处理。 */
  'news.list': true,
  'news.detail': true,
  /* 粘贴识别：纯文本解析、不读写任何用户数据，匿名可用（未登录先识别，登录后再发布） */
  'parse.publish': true
})

/** 需要限流的动作：固定窗口 + 计数键 */
const RATE_RULES = {
  'admin.login': {
    limit: RATE_LIMITS.login,
    key: (data) => 'login:' + String((data && data.username) || '').trim().toLowerCase()
  },
  'consult.submit': {
    limit: RATE_LIMITS.consult,
    key: (data, ctx) => 'consult:' + String(ctx.openid)
  },
  /* 粘贴识别：匿名可用的纯计算接口，按 openid / IP 限速，避免被脚本反复调用 */
  'parse.publish': {
    limit: RATE_LIMITS.browse,
    key: (data, ctx) => 'parse:' + String(ctx.openid || ctx.ip || 'anonymous')
  },
  /* 发起对话：与「咨询」分开口径，回看已领取商机的会话不会挤占咨询额度，
     仍保留小时级上限，避免被批量搭会话刷爆 */
  'chat.open': {
    limit: RATE_LIMITS.chatOpen,
    key: (data, ctx) => 'chatOpen:' + String(ctx.openid)
  },
  /* 货主主页：读接口，按账号限速 */
  'owner.home': {
    limit: RATE_LIMITS.browse,
    key: (data, ctx) => 'browse:' + String(ctx.openid)
  },
  'material.sign': {
    limit: RATE_LIMITS.materialSign,
    key: (data, ctx) => 'material:' + String(ctx.openid)
  },
  'product.publish': {
    limit: RATE_LIMITS.publishProduct,
    key: (data, ctx) => 'publishProduct:' + String(ctx.openid)
  },
  'demand.publish': {
    limit: RATE_LIMITS.publishDemand,
    key: (data, ctx) => 'publishDemand:' + String(ctx.openid)
  },
  'agency.submit': {
    limit: RATE_LIMITS.publishAgency,
    /* 带 id 的重新提交沿用原委托，单独计次，不占用每天 5 条的新发布额度 */
    key: (data, ctx) => (data && data.id ? 'agencyResubmit:' : 'publishAgency:') + String(ctx.openid)
  },
  'quote.paste': {
    limit: RATE_LIMITS.publishQuote,
    key: (data, ctx) => 'publishQuote:' + String(ctx.openid)
  },
  'news.submit': {
    limit: RATE_LIMITS.publishNews,
    key: (data, ctx) => 'publishNews:' + String(ctx.openid)
  },
  'biz.claim': {
    limit: RATE_LIMITS.bizClaim,
    key: (data, ctx) => 'bizClaim:' + String(ctx.openid)
  },
  /* 已领取商机的联系方式：只读回看，不占每日领取次数，按浏览档限速 */
  'biz.contact': {
    limit: RATE_LIMITS.browse,
    key: (data, ctx) => 'browse:' + String(ctx.openid)
  },
  /* 标记「不满足」：与领取同档限速，避免被脚本刷跨用户标记 */
  'biz.mark': {
    limit: RATE_LIMITS.bizClaim,
    key: (data, ctx) => 'bizClaim:' + String(ctx.openid)
  },
  /* 代采代售对接：每次都会写咨询消息与媒体，防止高频重复提交刷客服工作台 */
  'biz.consult': {
    limit: RATE_LIMITS.bizConsult,
    key: (data, ctx) => 'bizConsult:' + String(ctx.openid)
  },
  /* 首页商机角标：轻量读接口，与浏览接口同档限速 */
  'biz.badge': {
    limit: RATE_LIMITS.browse,
    key: (data, ctx) => 'browse:' + String(ctx.openid)
  },
  'msg.send': {
    limit: RATE_LIMITS.msgSend,
    key: (data, ctx) => 'msgSend:' + String(ctx.openid)
  },
  'stock.save': {
    limit: RATE_LIMITS.stockSave,
    key: (data, ctx) => 'stockSave:' + String(ctx.openid)
  },
  'fav.set': {
    limit: RATE_LIMITS.favSave,
    key: (data, ctx) => 'favSave:' + String(ctx.openid)
  },
  'follow.set': {
    limit: RATE_LIMITS.followSave,
    key: (data, ctx) => 'followSave:' + String(ctx.openid)
  },
  'search.log': {
    limit: RATE_LIMITS.searchLog,
    key: (data, ctx) => 'searchLog:' + String(ctx.openid)
  },
  /* 商机页囤货榜单：读聚合数据，按账号限速，避免被整站抓取 */
  'insights.market': {
    limit: RATE_LIMITS.browse,
    key: (data, ctx) => 'browse:' + String(ctx.openid)
  },
  /* 读接口防爬：列表 / 详情按账号限速，避免被脚本整站抓取 */
  'product.list': {
    limit: RATE_LIMITS.browse,
    key: (data, ctx) => 'browse:' + String(ctx.openid)
  },
  'product.detail': {
    limit: RATE_LIMITS.browse,
    key: (data, ctx) => 'browse:' + String(ctx.openid)
  },
  'demand.list': {
    limit: RATE_LIMITS.browse,
    key: (data, ctx) => 'browse:' + String(ctx.openid)
  },
  'demand.detail': {
    limit: RATE_LIMITS.browse,
    key: (data, ctx) => 'browse:' + String(ctx.openid)
  },
  /* 推广提现：按账号限速，避免脚本反复提交占用审核队列 */
  'promote.withdraw': {
    limit: RATE_LIMITS.withdraw,
    key: (data, ctx) => 'withdraw:' + String(ctx.openid)
  },
  /* 直聊内容读取：按账号限速，避免用 threadId 枚举他人会话 */
  'msg.thread': {
    limit: RATE_LIMITS.browse,
    key: (data, ctx) => 'browse:' + String(ctx.openid)
  }
}

/**
 * 只读接口缓存规则（按 scope 隔离，避免用户端 / 管理端同名动作串缓存）。
 * group 用于版本号失效：写操作 bump 分组后，该分组下所有 key 自然失效。
 * TTL 口径：列表 30–60 秒，详情 60 秒，型号库 / 设置 300 秒。
 *
 * 注意：这里只白名单「不含消息、联系方式、手机号」的只读接口；
 * 用户端 biz.list 会下发已领取联系方式，因此绝不加入缓存。
 * 详情接口的 key 含请求者身份，同一份缓存只会回给同一身份。
 */
const CACHE_RULES = Object.freeze({
  user: Object.freeze({
    'product.list': { group: 'products', ttl: 30 },
    'product.detail': { group: 'products', ttl: 60 },
    'demand.list': { group: 'demands', ttl: 30 },
    'demand.detail': { group: 'demands', ttl: 60 },
    /* 资讯列表按浏览者缓存：黑名单会过滤被拉黑作者的资讯，不能全站共用 */
    'news.list': { group: 'news', ttl: 30 },
    'biz.badge': { group: 'biz', ttl: 30 },
    'catalog.list': { group: 'catalog', ttl: 300 },
    /* 用户端型号目录与浏览者身份无关：全站共用一份，管理端增删型号后按 catalog 分组失效 */
    'catalog.tree': { group: 'catalog', ttl: 300, shared: true },
    'setting.get': { group: 'settings', ttl: 300 },
    'stats.overview': { group: 'stats', ttl: 60 },
    'insights.market': { group: 'insights', ttl: 60 }
  }),
  admin: Object.freeze({
    'product.list': { group: 'products', ttl: 30 },
    'demand.list': { group: 'demands', ttl: 30 },
    'agency.list': { group: 'agencies', ttl: 30 },
    'biz.list': { group: 'biz', ttl: 30 },
    'catalog.list': { group: 'catalog', ttl: 300 },
    'setting.get': { group: 'settings', ttl: 300 },
    'stats.overview': { group: 'stats', ttl: 60 }
  })
})

/**
 * 写操作 → 缓存分组失效映射。
 * 写操作成功后、返回前 bump；失败不失效，避免把可用的旧缓存也清掉。
 * 消息 / 联系方式类写操作（msg.send、chat.open 等）不参与缓存，无需失效。
 */
const INVALIDATE_MAP = Object.freeze({
  /* 商品类：同时影响看板统计、商机池与榜单口径 */
  'product.publish': ['products', 'stats', 'biz', 'insights'],
  'product.submit': ['products', 'stats', 'biz', 'insights'],
  'product.update': ['products', 'stats', 'biz', 'insights'],
  'product.review': ['products', 'stats', 'biz', 'insights'],
  'product.setStatus': ['products', 'stats', 'biz', 'insights'],
  'product.transfer': ['products', 'stats', 'biz', 'insights'],
  'product.offline': ['products', 'stats', 'biz', 'insights'],
  'product.online': ['products', 'stats', 'biz', 'insights'],
  'product.delete': ['products', 'stats', 'biz', 'insights'],
  'stock.save': ['products', 'stats', 'biz', 'insights'],
  'stock.remove': ['products', 'stats', 'biz', 'insights'],
  /* 需求类：同上，需求状态变化直接影响商机匹配结果 */
  'demand.publish': ['demands', 'stats', 'biz', 'insights'],
  'demand.submit': ['demands', 'stats', 'biz', 'insights'],
  'demand.update': ['demands', 'stats', 'biz', 'insights'],
  'demand.review': ['demands', 'stats', 'biz', 'insights'],
  'demand.setStatus': ['demands', 'stats', 'biz', 'insights'],
  'demand.offline': ['demands', 'stats', 'biz', 'insights'],
  'demand.close': ['demands', 'stats', 'biz', 'insights'],
  'demand.reopen': ['demands', 'stats', 'biz', 'insights'],
  'demand.delete': ['demands', 'stats', 'biz', 'insights'],
  'demand.transfer': ['demands', 'stats', 'biz', 'insights'],
  /* 委托 / 代采代售 */
  'agency.submit': ['agencies'],
  'agency.paid': ['agencies'],
  'agency.cancel': ['agencies'],
  'agency.delete': ['agencies'],
  'agency.payProof': ['agencies', 'payments'],
  'agency.confirm': ['agencies'],
  'agency.review': ['agencies'],
  'agency.reject': ['agencies'],
  'agency.close': ['agencies'],
  'agency.complete': ['agencies', 'payments'],
  /* 商机会员与领取记录（影响角标 / 列表统计） */
  'biz.grant': ['biz'],
  'biz.revoke': ['biz'],
  'biz.setExpire': ['biz'],
  /* 7 天体验开通后会员状态立即变化，商机列表与角标缓存需失效 */
  'biz.trial': ['biz'],
  'biz.claim': ['biz'],
  'biz.mark': ['biz'],
  /* 拉黑 / 移出：商品、需求、资讯、商机池的可见范围随浏览者变化，相关缓存必须立即失效 */
  'block.add': ['products', 'demands', 'news', 'biz', 'insights'],
  'block.remove': ['products', 'demands', 'news', 'biz', 'insights'],
  /* 型号库 / 系统设置 / 筛选规则（规则数进看板统计） */
  'catalog.save': ['catalog'],
  'catalog.remove': ['catalog'],
  /* 评论开关随系统设置保存：资讯列表缓存里带评论数，必须一起失效 */
  'setting.save': ['settings', 'stats', 'news'],
  'rule.toggle': ['stats'],
  'rule.create': ['stats'],
  'rule.update': ['stats'],
  'rule.sort': ['stats'],
  /* 委托服务费确认到账 / 退款同时影响财务与委托单状态 */
  'payment.feeConfirm': ['finance', 'agencies'],
  'payment.refund': ['finance', 'biz', 'agencies'],
  /**
   * 举报处置会联动下架 / 退回 / 删除商品、需求或资讯：
   * 处置后必须清掉对应的列表与详情缓存，否则被下架内容在 TTL 内仍可被命中缓存读到。
   */
  'report.handle': ['products', 'demands', 'news', 'stats', 'biz', 'insights'],
  /* 资讯类：列表为全站共享缓存，发布 / 审核 / 下架 / 删除与点赞都要失效 */
  'news.create': ['news'],
  'news.review': ['news'],
  'news.offline': ['news'],
  'news.publish': ['news'],
  'news.submit': ['news'],
  'news.delete': ['news'],
  'news.like': ['news'],
  'news.comment.add': ['news'],
  'news.comment.delete': ['news'],
  /* 收藏数展示在商品 / 需求详情与列表中 */
  'fav.set': ['products', 'demands', 'agencies', 'news']
})

/** 这些错误属于安全事件，必须落审计 */
const SECURITY_CODES = [CODES.FORBIDDEN, CODES.UNAUTHENTICATED, CODES.RATE_LIMITED]

/** 入参稳定序列化：对象键排序，保证同一入参得到同一份缓存 key */
function stableStringify(value) {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

/* 明文敏感字段：命中任何一个都拒绝写入缓存（脱敏后的 masked 字段不受影响） */
const SENSITIVE_KEYS = new Set([
  'phone',
  'ownerPhone',
  'phoneCipher',
  'realname',
  'ownerRealname',
  'realnameCipher',
  'idCard',
  'idCardCipher'
])

function hasSensitivePayload(value, depth) {
  const level = depth || 0
  if (!value || typeof value !== 'object' || level > 6) return false
  if (Array.isArray(value)) return value.some((item) => hasSensitivePayload(item, level + 1))
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEYS.has(key) && value[key]) return true
    if (hasSensitivePayload(value[key], level + 1)) return true
  }
  return false
}

/* 用户发布 / 发送内容需要做微信内容安全检测的动作：头像昵称、商品、需求、商机、聊天、咨询等 */
const UGC_TEXT_ACTIONS = new Set([
  'auth.login',
  'profile.save',
  'stock.save',
  'product.publish',
  'product.submit',
  'product.update',
  'demand.publish',
  'demand.submit',
  'demand.update',
  'agency.submit',
  'agency.update',
  'news.submit',
  'quote.paste',
  'consult.submit',
  'consult.rate',
  'report.create',
  'msg.send',
  'biz.consult'
])

/* 字段名黑名单：这些是标识 / 链接 / 枚举，不是用户撰写的文本，跳过可减少误判和接口调用 */
const UGC_SKIP_KEYS = new Set([
  'id', 'uid', 'openid', 'unionid', 'phone', 'code', 'token', 'password',
  'avatar', 'url', 'fileId', 'poster', 'cover', 'targetId', 'productId',
  'demandId', 'threadId', 'leadId', 'sessionId', 'accountId', 'ref', 'refScene',
  'city', 'brand', 'model', 'cat', 'tradeMode', 'priceUnit', 'priceMode',
  'supply', 'cond', 'tax', 'deliver', 'pay', 'closed', 'deposit', 'term',
  'side', 'type', 'kind', 'status', 'scene', 'channel', 'currency', 'unit'
])

/* 递归收集用户填写的文字：只取含中文的普通文本，跳过链接 / 超长串 / 标识字段 */
function collectUgcText(value, out, depth) {
  const level = depth || 0
  if (!out || level > 6 || value === null || value === undefined) return
  if (typeof value === 'string') {
    const s = value.trim()
    if (!s || s.length > 1200) return
    if (/^(https?:|wxfile:|cloud:|data:)/i.test(s)) return
    if (!/[\u3400-\u9fa5]/.test(s)) return
    if (out.join('').length >= 1900) return
    out.push(s)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUgcText(item, out, level + 1)
    return
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (UGC_SKIP_KEYS.has(key)) continue
      collectUgcText(value[key], out, level + 1)
    }
  }
}

/**
 * 统一入口：createRouter({repo, keys, scope, now}) → dispatch(action, data, ctx)
 * dispatch 永远返回 { ok, code, data? , message? }，不向外抛异常、不带堆栈。
 */
function createRouter(options) {
  const { repo, keys } = options
  const scope = options.scope === 'admin' ? 'admin' : 'user'
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const env = options.env || (typeof process !== 'undefined' ? process.env : {})
  /* 缓存可选：未传时与接入缓存前的行为完全一致 */
  const cache = options.cache && typeof options.cache.get === 'function' ? options.cache : null
  const cacheRules = CACHE_RULES[scope]

  const subscribe = createSubscribe({ repo, env, now, notify: options.notify })

  const handlers = scope === 'admin'
    ? Object.assign(
      {},
      createAdminHandlers({ repo, keys, now, env, cloud: options.cloud, subscribe }),
      createMarketAdminHandlers({ repo, keys, now, subscribe }),
      createInsightsAdminHandlers({ repo, keys, now, subscribe }),
      createPromoteAdminHandlers({ repo, keys, now, payoutClient: options.payoutClient })
    )
    : Object.assign(
      {},
      createUserHandlers({ repo, keys, now, cache, notify: options.notify, exchangePhone: options.exchangePhone, subscribe }),
      createMarketUserHandlers({ repo, keys, now, cache, subscribe, cloud: options.cloud }),
      createInsightsUserHandlers({ repo, keys, now }),
      createPromoteUserHandlers({ repo, keys, now, payoutClient: options.payoutClient })
    )

  /** 行为事件：只记录成功动作，失败静默；同时按概率触发 90 天清理 */
  async function trackUserEvent(action, input, context, result, at) {
    if (scope !== 'user') return
    const meta = USER_EVENT_ACTIONS[action]
    if (!meta) return
    if (meta.onlyOn && input.on === false) return
    /* 存草稿不算发布行为，避免草稿反复保存刷满操作记录 */
    if (input.draft === true) return
    const kind = meta.kind === 'agency'
      ? (input.side === 'sell' ? 'agency_sell' : 'agency_buy')
      : meta.kind
    const data = result && typeof result === 'object' ? result : {}
    const refId = data.id || data.threadId || data.leadId || input.id || input.productId || input.demandId || input.refId || ''
    const title = data.title || data.item || input.title || input.item || ''
    const uid = context.openid || context.uid
    /* 浏览类事件去重：统计口径本身只需要「看没看过」，重复写入只会给库加压力 */
    if (refId && VIEW_EVENT_KINDS[kind] && seenRecently(uid, kind, refId, at)) return
    await recordUserEvent(repo, {
      uid,
      kind,
      page: meta.page,
      refId,
      title,
      at
    })
    await cleanupUserEvents(repo, at, false)
  }

  /**
   * 缓存 key：scope + action + 请求者身份 + 入参稳定哈希，再拼上分组版本号。
   * 管理端身份用 accountId + role，用户端用 openid，避免不同身份串读。
   */
  async function cacheKeyOf(action, input, context) {
    const rule = cacheRules[action]
    const identity = scope === 'admin'
      ? `${context.accountId || ''}:${(context.session && context.session.role) || ''}`
      : String(context.openid || '')
    /* shared：返回体与浏览者无关，key 去掉身份，所有用户共用一份 */
    const scopeKey = rule.shared ? 'shared' : identity
    const digest = sha256Hex(scopeKey + '\n' + stableStringify(input)).slice(0, 32)
    return cache.keyOf(scope, rule.group, `${action}:${scopeKey}:${digest}`)
  }

  async function resolveSession(token, at) {
    const hash = sha256Hex(String(token))
    const rows = await repo.find('sessions', { tokenHash: hash }, { limit: 1 })
    const session = rows[0]
    if (!session || Number(session.expiresAt) <= at) {
      throw new AppError(CODES.UNAUTHENTICATED, '登录已过期，请重新登录')
    }
    return session
  }

  async function auditSecurityEvent(action, input, context, pub) {
    if (!SECURITY_CODES.includes(pub.code)) return
    // 登录口令错误已由 handler 写入更具体的原因，避免重复记录
    if (scope === 'admin' && action === 'admin.login' && pub.code === CODES.UNAUTHENTICATED) return
    const actorType = scope === 'admin' ? 'admin' : 'user'
    const actorId = (context.session && context.session.accountId)
      || context.openid
      || String(input.username || 'anonymous')
    await appendAudit(repo, {
      actorType,
      actorId,
      action,
      target: input.leadId || input.id || '',
      reason: pub.message,
      ip: context.ip,
      result: pub.code,
      at: now()
    })
  }

  /**
   * 动作级权限：内置角色静态白名单 + 自定义角色 + 账号临时权限（到期自动失效）。
   * 自定义角色与临时权限都落库，因此这里必须按当前 session 异步校验。
   */
  async function canAdminAction(session, action, at) {
    if (!session) return false
    if (can(session.role, action)) return true
    const roleRows = await repo.find('roles', { roleKey: session.role }, { limit: 1 })
    const customRole = roleRows[0]
    if (customRole && customRole.status !== 'disabled' && (customRole.actions || []).includes(action)) return true
    const rows = await repo.find('accountPermissions', { username: session.accountId }, { limit: 1 })
    const permission = rows[0]
    if (!permission || permission.status === 'disabled') return false
    if (Number(permission.expiresAt) > 0 && Number(permission.expiresAt) <= at) return false
    return (permission.extraActions || []).includes(action)
  }

  /** 运行日志：只记录系统级错误，避免把正常的校验失败刷进日志 */
  async function recordSystemError(action, pub, err) {
    if (pub.code !== CODES.INTERNAL) return
    const at = now()
    try {
      await repo.insert('systemLogs', {
        id: 'SL' + at + Math.random().toString(36).slice(2, 8),
        level: 'error',
        scope: scope === 'admin' ? '管理端接口' : '用户端接口',
        action,
        message: pub.message,
        detail: String((err && err.stack) || '').slice(0, 2000),
        result: pub.code,
        at,
        day: new Date(at + 8 * 3600 * 1000).toISOString().slice(0, 10)
      })
    } catch (logErr) { /* 日志失败不影响对外响应 */ }
  }

  async function dispatch(action, data, ctx) {
    const input = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    const context = Object.assign({}, ctx || {})
    const at = now()
    let rateRule = null
    let rateKey = ''
    try {
      if (typeof action !== 'string' || !action) {
        throw new AppError(CODES.NOT_FOUND, '接口不存在')
      }

      /* 先鉴权、后暴露动作是否存在：未登录者探测不到可用接口清单 */
      if (scope === 'admin' && action !== 'admin.login') {
        if (!context.token) throw new AppError(CODES.UNAUTHENTICATED, '登录已过期，请重新登录')
        const session = await resolveSession(context.token, at)
        context.session = session
        context.accountId = session.accountId
      } else if (scope === 'user' && !context.openid && !PUBLIC_USER_ACTIONS[action]) {
        throw new AppError(CODES.UNAUTHENTICATED, '请先登录')
      }

      if (!Object.prototype.hasOwnProperty.call(handlers, action)) {
        throw new AppError(CODES.NOT_FOUND, '接口不存在')
      }
      if (scope === 'admin' && action !== 'admin.login') {
        if (!(await canAdminAction(context.session, action, at))) {
          throw new AppError(CODES.FORBIDDEN, '当前账号无权执行该操作')
        }
      }

      const rule = RATE_RULES[action]
      if (rule) {
        rateRule = rule
        rateKey = rule.key(input, context)
        await hit(repo, {
          key: rateKey,
          max: rule.limit.max,
          windowMs: rule.limit.windowMs,
          now: at
        })
      }

      /* 内容安全：用户发布的文字（含头像昵称、商品、需求、聊天）先过微信检测，
         命中违规直接拒绝；微信接口异常时放行并记录日志，避免影响正常发布 */
      if (scope === 'user' && context.openid && typeof options.secCheck === 'function' && UGC_TEXT_ACTIONS.has(action)) {
        const texts = []
        collectUgcText(input || {}, texts, 0)
        const secText = texts.join('\n').slice(0, 2000)
        if (secText) {
          let verdict = null
          try {
            verdict = await options.secCheck({ type: 'text', text: secText, openid: context.openid })
          } catch (secErr) {
            console.error('[secCheck] ' + action + ' ' + (secErr && secErr.message ? secErr.message : 'failed'))
          }
          if (verdict && verdict.risky) {
            if (action === 'auth.login' && input) {
              /* 微信资料里的昵称 / 头像命中违规时清空后继续登录，不阻断账号进入 */
              delete input.nick
              delete input.avatar
            } else {
              throw new AppError(CODES.VALIDATION, '内容含违规信息，请修改后重试')
            }
          }
        }
      }

      /* 只读接口缓存：wrap 内做并发合并（防击穿），命中后仍记录行为事件 */
      const cacheRule = cache ? cacheRules[action] : null
      if (cacheRule) {
        let cacheKey = ''
        try {
          cacheKey = await cacheKeyOf(action, input, context)
        } catch (cacheErr) {
          cacheKey = ''
        }
        if (cacheKey) {
          const cachedResult = await cache.wrap(
            cacheKey,
            cacheRule.ttl,
            () => handlers[action](input, context),
            (value) => !hasSensitivePayload(value)
          )
          try {
            await trackUserEvent(action, input, context, cachedResult, at)
          } catch (eventErr) {
            /* 行为事件失败不影响主流程 */
          }
          return { ok: true, code: CODES.OK, data: cachedResult === undefined ? null : cachedResult }
        }
      }

      const result = await handlers[action](input, context)
      /* 登录成功归还本次计数：爆破配额只统计失败，避免正常用户被自己锁死 */
      if (rateRule && action === 'admin.login') {
        await repo.incrCounter(rateKey, windowStartOf(at, rateRule.limit.windowMs), -1).catch(() => {})
      }
      /* 领取商机只统计新建领取：之前已领过的再次回看不占每日额度 */
      if (rateRule && action === 'biz.claim' && result && result.already) {
        await repo.incrCounter(rateKey, windowStartOf(at, rateRule.limit.windowMs), -1).catch(() => {})
      }
      /* 写操作成功返回前 bump 分组版本号，旧缓存自然失效 */
      const invalidation = cache ? INVALIDATE_MAP[action] : null
      if (invalidation) {
        for (const group of invalidation) {
          try {
            await cache.bump(group)
          } catch (cacheErr) {
            /* 失效失败不影响写操作 */
          }
        }
      }
      try {
        await trackUserEvent(action, input, context, result, at)
      } catch (eventErr) {
        /* 行为事件失败不影响主流程 */
      }
      return { ok: true, code: CODES.OK, data: result === undefined ? null : result }
    } catch (err) {
      const pub = toPublic(err)
      /* 领取商机失败（条件不符 / 已下架 / 信息未公开等）不占每日额度，
         只统计真正领取成功的次数；本身被限流拦下的也不回滚，避免反复试探 */
      if (rateRule && action === 'biz.claim' && pub.code !== CODES.RATE_LIMITED) {
        await repo.incrCounter(rateKey, windowStartOf(at, rateRule.limit.windowMs), -1).catch(() => {})
      }
      try {
        await auditSecurityEvent(action, input, context, pub)
      } catch (auditErr) {
        // 审计失败不影响对外响应
      }
      try {
        await recordSystemError(action, pub, err)
      } catch (logErr) {
        // 运行日志失败不影响对外响应
      }
      return { ok: false, code: pub.code, message: pub.message }
    }
  }

  return { dispatch, scope, listActions: () => Object.keys(handlers) }
}

module.exports = { createRouter, RATE_RULES, PUBLIC_USER_ACTIONS }
