'use strict'

/**
 * 运营洞察域：浏览量、风险池、实时在线人数、搜索热榜、品类榜单。
 *
 * 设计口径：
 * 1. 浏览量：商品 / 求购详情被打开时计数，天然归属「详情页」，不区分是否咨询；
 *    同一用户重复打开按会话内去重，避免刷量把榜单刷穿。
 * 2. 风险池：发布即在售（自动基础审核），系统按敏感词 / 价格异常 / 品类冷门等规则
 *    把可疑内容标记为「风险待看」；人工看不看都不影响展示，只有明确打回才改状态。
 * 3. 在线人数：用户端心跳写入在线标记集合，按窗口过期统计当前在线人数。
 * 4. 榜单：搜索热榜取搜索埋点，品类榜取在售商品的浏览量 / 咨询量，用于辅助囤货决策。
 */

const { AppError, CODES } = require('./errors')
const { str, enumOf, normalizePaging } = require('./validate')
const { randomId, sha256Hex } = require('./crypto')
const { appendAudit } = require('./audit')
const { scanSensitive } = require('./sensitive')

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/** 在线心跳有效期：超过这个时长视为离线 */
const ONLINE_TTL_MS = 5 * MINUTE_MS

/** 浏览去重窗口：同一用户对同一对象，窗口内只计一次 */
const VIEW_DEDUPE_MS = 30 * MINUTE_MS

/**
 * 风险判定规则。
 * 命中任意一条即标记为「风险待看」，但不阻断展示、不影响发布。
 */
const RISK_RULES = Object.freeze([
  {
    code: 'price_outlier',
    label: '价格异常',
    desc: '单价偏离该品类常规区间（过低或过高）',
    /* 单价单位：元 */
    check(doc) {
      const price = Number(doc.price || doc.budget) || 0
      if (price <= 0) return false
      const cat = String(doc.cat || '')
      /* GPU 类目单价普遍在万元级，明显低于 1 万的大概率是录错 */
      if (/GPU|NPU|加速卡|服务器|超节点|一体机/.test(cat) && price < 10000) return true
      /* 单价过亿：多为录入错误 */
      if (price > 100000000) return true
      return false
    }
  },
  {
    code: 'contact_in_text',
    label: '疑似联系方式',
    desc: '正文或备注中出现手机号、微信号等联系方式',
    check(doc) {
      const text = [doc.title, doc.note, doc.accept, doc.requirements, doc.limit]
        .filter(Boolean).join(' ')
      /* 手机号 / 微信号 / QQ 号 */
      if (/1[3-9]\d{9}/.test(text)) return true
      if (/(微信|weixin|wx|vx|v信)\s*[:：]?\s*[a-zA-Z0-9_-]{5,}/i.test(text)) return true
      if (/\bqq\s*[:：]?\s*\d{5,12}\b/i.test(text)) return true
      return false
    }
  },
  {
    code: 'repeat_listing',
    label: '疑似重复铺货',
    desc: '同一货主在短时间内发布多条高度雷同的商品',
    check() { return false }  /* 需要上下文，由 detectRisk 统一判定 */
  },
  {
    code: 'low_information',
    label: '信息过少',
    desc: '标题与说明过短，疑似空铺占位',
    check(doc) {
      const title = String(doc.title || '').trim()
      const note = String(doc.note || '').trim()
      return title.length < 6 && note.length < 10
    }
  }
])

/** 风险状态：待看 / 已确认风险 / 已排除 */
const RISK_STATUS = Object.freeze({
  PENDING: '待看',
  CONFIRMED: '已打回',
  CLEARED: '已排除'
})

const RISK_STATUS_LIST = Object.freeze([RISK_STATUS.PENDING, RISK_STATUS.CONFIRMED, RISK_STATUS.CLEARED])

/* 风险单：五类视图（商品 / 用户 / 咨询 / 对话 / 系统）+ 处置状态 */
const RISK_TYPES = Object.freeze(['商品', '用户', '咨询', '对话', '系统'])
const RISK_LEVELS = Object.freeze(['高', '中', '低'])
const RISK_CASE_STATUS = Object.freeze(['待处理', '处理中', '已处理', '已忽略'])
const RISK_CASE_STATUS_LIST = Object.freeze(RISK_CASE_STATUS)

/* 用户 / 咨询 / 系统侧的风险规则（商品类沿用 RISK_RULES） */
const RISK_EXTRA_RULES = Object.freeze([
  { code: 'user_no_license', type: '用户', label: '资质未上传', level: '低', desc: '用户未上传营业执照等主体资质' },
  { code: 'user_rejected_many', type: '用户', label: '多次被驳回', level: '中', desc: '发布内容累计被平台驳回 3 次以上' },
  { code: 'user_status_abnormal', type: '用户', label: '账号状态异常', level: '高', desc: '账号处于封禁或限制状态' },
  { code: 'consult_contact', type: '咨询', label: '咨询含联系方式', level: '中', desc: '咨询内容出现手机号 / 微信号，存在绕过平台交易风险' },
  { code: 'consult_overdue', type: '咨询', label: '超时未分配', level: '低', desc: '咨询单超过 24 小时仍未分配坐席' },
  { code: 'sensitive_porn', type: '商品', label: '涉黄内容', level: '中', desc: '标题或正文包含色情 / 低俗敏感词，需人工查看' },
  { code: 'sensitive_violence', type: '商品', label: '涉暴内容', level: '高', desc: '标题或正文包含暴力 / 凶杀 / 武器等敏感词，需人工查看' },
  { code: 'sensitive_politics', type: '商品', label: '涉政内容', level: '高', desc: '标题或正文包含反动 / 分裂 / 邪教等敏感词，需人工查看' },
  { code: 'system_payment_pending', type: '系统', label: '收款待确认超时', level: '中', desc: '收款单超过 3 天仍未财务确认' },
  { code: 'system_error', type: '系统', label: '运行错误', level: '高', desc: '近 24 小时出现系统级错误日志' }
])

/** 榜单维度：品类 */
const BOARD_SCOPES = Object.freeze(['all', 'GPU', '内存', 'CPU', 'NPU', '存储', '网络', '其他'])

/**
 * 品类归并到榜单维度。
 * 设备目录里品类很细，榜单按大类归并，便于商家看整体趋势。
 */
function boardScopeOf(cat, model) {
  const text = `${cat || ''} ${model || ''}`
  /* NPU 先判：昇腾 / 寒武纪的品类名常带「加速卡」，先判 GPU 会被误归入 GPU */
  if (/NPU|昇腾|910|寒武纪|Atlas/i.test(text)) return 'NPU'
  if (/GPU|NVIDIA|加速卡|H100|H200|A100|B200|B300|L40|V100|RTX|4090|5090/i.test(text)) return 'GPU'
  if (/内存|内存条|DDR|DRAM|RAM|条/.test(text)) return '内存'
  if (/CPU|处理器|EPYC|Xeon|至强|锐龙/i.test(text)) return 'CPU'
  if (/存储|SSD|闪存|硬盘|分布式存储|全闪/i.test(text)) return '存储'
  if (/网络|交换机|光模块|线缆|DPU|网卡/i.test(text)) return '网络'
  return '其他'
}

/** 机型归一化：忽略大小写、空格与常见分隔符 */
function normalizeModel(model) {
  return String(model || '').toLowerCase().replace(/[\s\-_/]+/g, '').replace(/[（）()]/g, '')
}

/**
 * 搜索热榜：从 counters 中汇总当日搜索词。
 * 同时兼容「总计键 search:<日>:<词>」与「维度键 search:<日>:<维度>:<词>」。
 */
function hotSearchesOf(counters, day, limit) {
  const searchCounts = {}
  for (const row of counters) {
    const prefix = 'search:' + day + ':'
    const key = String(row.key || '')
    if (key.indexOf(prefix) !== 0) continue
    const rest = key.slice(prefix.length)
    const parts = rest.split(':')
    const n = Number(row.count) || 0
    if (parts.length === 1) {
      /* 总计键：search:<日>:<词> */
      const word = parts[0]
      searchCounts[word] = searchCounts[word] || { word, total: 0, scopes: {} }
      searchCounts[word].total += n
      searchCounts[word].scopes['全部'] = (searchCounts[word].scopes['全部'] || 0) + n
      continue
    }
    /* 分维度键：search:<日>:<维度>:<词> */
    const scope = parts[parts.length - 2]
    const word = parts.slice(parts.length - 1).join(':')
    searchCounts[word] = searchCounts[word] || { word, total: 0, scopes: {} }
    searchCounts[word].scopes[scope] = (searchCounts[word].scopes[scope] || 0) + n
  }
  return Object.keys(searchCounts)
    .map((k) => searchCounts[k])
    .sort((a, b) => b.total - a.total || a.word.localeCompare(b.word))
    .slice(0, limit || 20)
}

/** 型号榜：同型号聚合在售货源，按浏览量 / 咨询量排序 */
function modelBoardsOf(onSale, limit) {
  const modelMap = {}
  for (const p of onSale) {
    const model = normalizeModel(p.model || p.title)
    if (!model) continue
    if (!modelMap[model]) {
      modelMap[model] = {
        model: p.model || p.title,
        normalized: model,
        scope: boardScopeOf(p.cat, p.model),
        listings: 0,
        qty: 0,
        views: 0,
        consults: 0,
        avgPrice: 0,
        priceSum: 0
      }
    }
    const m = modelMap[model]
    m.listings += 1
    m.qty += Number(p.qty) || 0
    m.views += Number(p.views) || 0
    m.consults += Number(p.heat) || 0
    const price = Number(p.price) || 0
    if (price > 0) { m.priceSum += price; m.avgPrice = Math.round(m.priceSum / m.listings) }
  }
  return Object.keys(modelMap)
    .map((k) => modelMap[k])
    .sort((a, b) => b.views - a.views || b.consults - a.consults)
    .slice(0, limit || 30)
}

/**
 * 每日搜索最多的商品：把搜索词落到具体在售型号上。
 * 同一搜索词只给命中的型号加一次搜索量，避免同型号多条货源被重复累加。
 */
function hotProductsOf(onSale, hotSearches, limit) {
  const modelRows = {}
  for (const m of modelBoardsOf(onSale, 500)) modelRows[m.normalized] = Object.assign({ searches: 0 }, m)
  for (const item of hotSearches || []) {
    const word = String(item.word || '').toLowerCase().replace(/\s+/g, '')
    if (!word) continue
    const hit = {}
    for (const p of onSale) {
      const text = `${p.model || ''} ${p.title || ''} ${p.brand || ''}`.toLowerCase().replace(/\s+/g, '')
      if (text.indexOf(word) < 0) continue
      const key = normalizeModel(p.model || p.title)
      if (key) hit[key] = true
    }
    Object.keys(hit).forEach((key) => {
      if (modelRows[key]) modelRows[key].searches += Number(item.total) || 0
    })
  }
  return Object.keys(modelRows)
    .map((k) => modelRows[k])
    .filter((m) => m.searches > 0)
    .sort((a, b) => b.searches - a.searches || b.views - a.views)
    .slice(0, limit || 20)
}

/** 品类榜单：按维度聚合在售货源与求购需求 */
function boardsOf(products, demands, limit) {
  const map = {}
  const push = (key, row, kind) => {
    if (!map[key]) map[key] = { scope: key, items: [], views: 0, consults: 0, qty: 0 }
    map[key].items.push({
      id: row.id,
      kind,
      title: row.title || row.model || '',
      cat: row.cat || '',
      brand: row.brand || '',
      model: row.model || '',
      city: row.city || '',
      price: Number(row.price) || Number(row.budget) || 0,
      qty: Number(row.qty) || 0,
      views: Number(row.views) || 0,
      consults: Number(row.heat) || 0
    })
    map[key].views += Number(row.views) || 0
    map[key].consults += Number(row.heat) || 0
    map[key].qty += Number(row.qty) || 0
  }
  for (const p of products) push(boardScopeOf(p.cat, p.model), p, '货源')
  for (const d of demands) push(boardScopeOf(d.cat, d.model), d, '求购')
  return Object.keys(map).map((key) => {
    const entry = map[key]
    entry.items.sort((a, b) => b.views - a.views || b.consults - a.consults)
    entry.items = entry.items.slice(0, limit || 10)
    return entry
  }).sort((a, b) => b.views - a.views || b.consults - a.consults)
}

/** 榜单聚合键：优先型号，其次品类 */
function rankKeyOf(row) {
  const model = normalizeModel(row.model || row.item || row.title)
  return model || String(row.cat || '其他')
}

function rankNameOf(row) {
  return String(row.model || row.item || row.title || row.cat || '其他')
}

/** 需求榜：求购数量最多的型号 / 品类 */
function demandRanksOf(demands, limit) {
  const map = {}
  for (const d of demands) {
    const key = rankKeyOf(d)
    if (!map[key]) map[key] = { name: rankNameOf(d), cat: d.cat || '', count: 0, qty: 0 }
    map[key].count += 1
    map[key].qty += Number(d.qty) || 0
  }
  return Object.keys(map)
    .map((k) => map[k])
    .sort((a, b) => b.qty - a.qty || b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit || 5)
    .map((item, idx) => Object.assign({ rank: idx + 1 }, item))
}

/** 火热榜：发起咨询 / 聊天最多的商品型号 */
function hotRanksOf(onSale, limit) {
  const map = {}
  for (const p of onSale) {
    const key = rankKeyOf(p)
    if (!map[key]) map[key] = { name: rankNameOf(p), cat: p.cat || '', consults: 0, listings: 0, views: 0 }
    map[key].consults += Number(p.heat) || 0
    map[key].views += Number(p.views) || 0
    map[key].listings += 1
  }
  return Object.keys(map)
    .map((k) => map[k])
    .filter((item) => item.consults > 0)
    .sort((a, b) => b.consults - a.consults || b.views - a.views || b.listings - a.listings)
    .slice(0, limit || 5)
    .map((item, idx) => Object.assign({ rank: idx + 1 }, item))
}

/** 供给榜：在售货源最多的型号，并给出供大于求 / 供不应求关系 */
function supplyRanksOf(onSale, demands, limit) {
  const map = {}
  for (const p of onSale) {
    const key = rankKeyOf(p)
    if (!map[key]) map[key] = { name: rankNameOf(p), cat: p.cat || '', listings: 0, qty: 0, demandQty: 0 }
    map[key].listings += 1
    map[key].qty += Number(p.qty) || 0
  }
  for (const d of demands || []) {
    const key = rankKeyOf(d)
    if (!map[key]) map[key] = { name: rankNameOf(d), cat: d.cat || '', listings: 0, qty: 0, demandQty: 0 }
    map[key].demandQty += Number(d.qty) || 0
  }
  return Object.keys(map)
    .map((k) => map[k])
    .filter((item) => item.listings > 0)
    .sort((a, b) => b.listings - a.listings || b.qty - a.qty)
    .slice(0, limit || 5)
    .map((item, idx) => {
      let relation = '暂无求购'
      if (item.demandQty > 0) {
        const ratio = item.qty / item.demandQty
        relation = ratio >= 1.2 ? '供大于求' : (ratio <= 0.8 ? '供不应求' : '供需平衡')
      }
      return Object.assign({ rank: idx + 1, relation }, item)
    })
}

/**
 * 商机页三个榜单：需求榜 / 火热榜 / 供给榜。
 * 只下发聚合结果，不含联系人、联系方式与真实用户身份。
 */
function marketRanksOf(onSale, openDemands, limit) {
  return [
    { key: 'demand', title: '需求榜', desc: '求购数量最多', items: demandRanksOf(openDemands, limit) },
    { key: 'hot', title: '火热榜', desc: '发起咨询 / 聊天最多', items: hotRanksOf(onSale, limit) },
    { key: 'supply', title: '供给榜', desc: '在售货源最多', items: supplyRanksOf(onSale, openDemands, limit) }
  ]
}

/** 窗口起点：按固定窗口对齐 */
function windowStartOf(at, windowMs) {
  return Math.floor(at / windowMs) * windowMs
}

/** 日期键：YYYY-MM-DD（东八区） */
function dayKeyOf(at) {
  const d = new Date(at + 8 * 60 * 60 * 1000)
  const m = ('0' + (d.getMonth() + 1)).slice(-2)
  const day = ('0' + d.getDate()).slice(-2)
  return d.getFullYear() + '-' + m + '-' + day
}

function createInsightsUserHandlers(deps) {
  const { repo } = deps
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  /**
   * 浏览量计数：打开详情时调用。
   * 同一用户对同一对象在 30 分钟内只计一次，防止刷新刷量。
   */
  async function countView(collection, id, uid) {
    if (!id) return 0
    const at = now()
    /* 去重键：用户 + 对象 + 时间窗 */
    const bucket = windowStartOf(at, VIEW_DEDUPE_MS)
    const dedupeKey = `view:${collection}:${id}:${uid || 'anon'}:${bucket}`
    const hit = await repo.incrCounter(dedupeKey, bucket)
    const doc = await repo.get(collection, id)
    const current = Number((doc && doc.views) || 0)
    /* 窗口内已计过：不累加，直接回读当前值 */
    if (hit > 1) return current
    const next = current + 1
    await repo.updateWhere(collection, { id }, { views: next, lastViewedAt: at })
    return next
  }

  return {
    /**
     * 商品 / 求购浏览量计数。
     * 属主自己打开不计数（自己看自己不算浏览量）。
     */
    'view.count': async (data, ctx) => {
      const kind = enumOf(data.kind || 'product', ['product', 'demand'], '对象类型')
      const id = str(data.id, { field: '对象标识', required: true, max: 64 })
      const uid = ctx.openid
      const collection = kind === 'product' ? 'products' : 'demands'
      const doc = await repo.get(collection, id)
      if (!doc) throw new AppError(CODES.NOT_FOUND, '对象不存在')
      if (doc.ownerId === uid) {
        return { id, views: Number(doc.views) || 0, mine: true }
      }
      const views = await countView(collection, id, uid)
      return { id, views, mine: false }
    },

    /**
     * 搜索埋点：记录用户搜索词，用于生成「每日搜索最多」。
     * 只记录关键词本身与归属品类，不记录用户身份。
     */
    'search.log': async (data, ctx) => {
      const q = str(data.q, { field: '搜索词', required: true, min: 1, max: 30 }).trim()
      const at = now()
      const day = dayKeyOf(at)
      const scope = boardScopeOf(data.cat || '', data.model || '')
      /* 按「日期 + 搜索词」聚合计数：窗口起点按自然日对齐 */
      const start = windowStartOf(at, DAY_MS)
      const key = `search:${day}:${q.toLowerCase()}`
      await repo.incrCounter(key, start)
      /* 分类目维度单独聚合，便于看「GPU 榜单」 */
      if (scope !== '其他') {
        await repo.incrCounter(`search:${day}:${scope}:${q.toLowerCase()}`, start)
      }
      await repo.insert('searchLogs', {
        id: randomId('sl'),
        /* 只留不可逆标识：埋点用于回溯搜索热度，不需要反查是谁搜的 */
        uidHash: sha256Hex(String(ctx.openid)).slice(0, 16),
        q,
        scope,
        day,
        at
      }).catch(() => {})
      return { ok: true }
    },

    /**
     * 商机页「囤货榜单」：给商家看品类 / 型号 / 搜索热度，辅助备货。
     * 只下发聚合后的公开货源信息，不含联系方式与用户身份。
     */
    'insights.market': async (data, ctx) => {
      const at = now()
      const day = dayKeyOf(at)
      const limit = Math.min(20, Math.max(5, Number(data && data.limit) || 20))
      /* 产品热度榜单与供求关系属于商机会员权益：未开通只回锁定态，不下发数据 */
      const access = ctx && ctx.openid ? await repo.get('bizAccess', ctx.openid) : null
      const unlocked = !!(access && access.status === '已开通' && Number(access.expireAt) > at)
      if (!unlocked) {
        return {
          at,
          day,
          locked: true,
          hint: '开通商机会员后可查看产品热度榜单与供求关系',
          boards: [],
          ranks: [],
          modelBoards: [],
          hotSearches: [],
          hotProducts: []
        }
      }
      /* 私密发布＝匿名公开：内容计入榜单与热度，但不暴露发布者 */
      const products = await repo.find('products', { status: '在售' }, { limit: 100000 })
      const onSale = products.filter((p) => !p.deleted)
      const demands = await repo.find('demands', { status: '求购中' }, { limit: 100000 })
      const openDemands = demands.filter((d) => !d.deleted)
      const counters = await repo.find('counters', {}, { limit: 5000 })
      const hotSearches = hotSearchesOf(counters, day, 12)
      return {
        at,
        day,
        boards: boardsOf(onSale, openDemands, limit),
        ranks: marketRanksOf(onSale, openDemands, Math.min(8, limit)),
        modelBoards: modelBoardsOf(onSale, 30),
        hotSearches,
        hotProducts: hotProductsOf(onSale, hotSearches, limit)
      }
    },

    /**
     * 客户端安全行为上报：截屏 / 录屏 / 尝试保存。
     * 只落「谁在哪个页面做了什么」，不存任何页面内容，管理端「行为数据中心」按人按页追溯。
     */
    'behavior.report': async (data, ctx) => {
      const kind = enumOf(data.kind, ['screenshot', 'screen_record', 'copy_contact', 'save_attempt'], '行为类型')
      const page = str(data.page, { field: '页面', max: 80 })
      const at = now()
      await repo.insert('behaviorEvents', {
        id: randomId('E'),
        uid: ctx.openid,
        kind,
        page,
        at,
        day: dayKeyOf(at),
        createdAt: at
      }).catch(() => {})
      return { ok: true }
    },

    'online.ping': async (data, ctx) => {
      const at = now()
      const uid = ctx.openid
      const id = 'on_' + uid
      const existing = await repo.get('onlineUsers', id)
      if (existing) {
        await repo.updateWhere('onlineUsers', { id }, { lastSeenAt: at })
      } else {
        await repo.insert('onlineUsers', {
          id,
          uid,
          lastSeenAt: at,
          createdAt: at
        }).catch(() => {})
      }
      return { ok: true, online: true }
    }
  }
}

function createInsightsAdminHandlers(deps) {
  const { repo } = deps
  /* 微信订阅消息：风险打回等系统消息同步推送，未配置模板时静默跳过 */
  const subscribe = deps.subscribe
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()

  async function audit(ctx, action, target, reason, result) {
    appendAudit(repo, {
      actorType: 'admin',
      actorId: (ctx && ctx.accountId) || 'admin',
      action,
      target: target || '',
      reason: reason || '',
      result: result || 'allow',
      at: now()
    })
  }

  /** 风险打回属于平台处置：同步站内信，避免用户只在列表里看到一个原因 */
  async function notifyOwner(uid, { title, body, targetType, targetId, reason }) {
    if (!uid) return
    await repo.insert('outbox', {
      id: randomId('M'),
      type: 'system.notice',
      payload: {
        uid,
        channel: 'system',
        from: 'system',
        title,
        body,
        reason: reason || '',
        targetType: targetType || '',
        targetId: targetId || ''
      },
      status: 'pending',
      createdAt: now()
    })
    if (subscribe) await subscribe.system(uid, { title, body, at: now() }).catch(() => {})
  }

  /** 强制下架时把仍处于「已对接」的线索一并收尾，避免线索悬空 */
  async function closeMatchedLeads(field, id, reason, at) {
    const rows = await repo.find('leads', { [field]: id, status: '已对接' }, { limit: 50 })
    for (const lead of rows) {
      const res = await repo.updateWhere('leads', { id: lead.id, status: '已对接' }, { status: '已关闭', closedReason: reason, closedAt: at })
      if (!res || res.count === 0) continue
      appendAudit(repo, {
        actorType: 'system',
        actorId: 'state-machine',
        action: 'lead.closedByRisk',
        target: `${lead.id}:已对接->已关闭`,
        reason,
        result: 'allow',
        at
      })
    }
  }

  /** 风险单落库：同一对象 + 同一规则只保留一条，重复扫描只刷新详情 */
  async function upsertRiskCase(candidate, at) {
    const fingerprint = `${candidate.type}|${candidate.ruleCode}|${candidate.targetId}`
    const existing = await repo.find('riskCases', { fingerprint }, { limit: 1 })
    if (existing[0]) {
      if (existing[0].status === '已处理' || existing[0].status === '已忽略') return
      await repo.updateWhere('riskCases', { fingerprint }, {
        targetLabel: candidate.targetLabel,
        detail: candidate.detail,
        level: candidate.level,
        updatedAt: at
      })
      return
    }
    await repo.insert('riskCases', Object.assign({
      id: randomId('RC'),
      fingerprint,
      status: '待处理',
      owner: '',
      action: '',
      reason: '',
      createdAt: at,
      updatedAt: at
    }, candidate))
  }

  /** 全量扫描：商品 / 用户 / 咨询 / 对话 / 系统五类风险，幂等写入 riskCases */
  async function scanRiskCases(at) {
    const [products, demands, users, profiles, leads, payments, systemLogs, messages] = await Promise.all([
      repo.find('products', {}, { limit: 2000 }),
      repo.find('demands', {}, { limit: 2000 }),
      repo.find('users', {}, { limit: 5000 }),
      repo.find('profiles', {}, { limit: 5000 }),
      repo.find('leads', {}, { limit: 5000 }),
      repo.find('payments', {}, { limit: 5000 }),
      repo.find('systemLogs', { at: { $gte: at - DAY_MS } }, { limit: 1000 }),
      repo.find('outbox', {}, { sort: { createdAt: -1 }, limit: 5000 })
    ])
    const ruleLabels = {}
    for (const rule of RISK_RULES) ruleLabels[rule.code] = { label: rule.label, level: '中' }
    for (const rule of RISK_EXTRA_RULES) ruleLabels[rule.code] = { label: rule.label, level: rule.level }

    /* 1) 商品 / 需求：沿用发布时的风险命中 */
    for (const doc of products.concat(demands)) {
      if ((doc.riskStatus || RISK_STATUS.PENDING) !== RISK_STATUS.PENDING) continue
      const hits = Array.isArray(doc.riskHits) && doc.riskHits.length ? doc.riskHits : ['manual_review']
      for (const hit of hits) {
        const code = typeof hit === 'string' ? hit : String((hit && hit.code) || 'manual_review')
        const meta = ruleLabels[code] || { label: '人工待复核', level: '中' }
        const detail = [doc.riskReason, hit && hit.desc ? hit.desc : ''].filter(Boolean).join('；')
        await upsertRiskCase({
          type: '商品',
          ruleCode: code,
          ruleLabel: (hit && hit.label) || meta.label,
          level: meta.level,
          targetId: doc.id,
          targetLabel: doc.title || doc.model || doc.id,
          uid: doc.ownerId || '',
          detail
        }, at)
      }
    }

    /* 2) 用户：资质缺失 / 多次驳回 / 账号异常 */
    const profileOf = new Map()
    for (const profile of profiles) if (profile && profile.uid) profileOf.set(profile.uid, profile)
    const rejectedByOwner = {}
    for (const doc of products) {
      if (doc.status === '已驳回') rejectedByOwner[doc.ownerId] = (rejectedByOwner[doc.ownerId] || 0) + 1
    }
    for (const user of users) {
      const profile = profileOf.get(user.id) || {}
      const quals = Array.isArray(profile.quals) ? profile.quals.map(String) : []
      const label = String(user.nick || user.id)
      if (!quals.some((item) => item.indexOf('营业执照') >= 0)) {
        await upsertRiskCase({
          type: '用户', ruleCode: 'user_no_license', ruleLabel: '资质未上传', level: '低',
          targetId: user.id, targetLabel: label, uid: user.id, detail: '未上传营业执照'
        }, at)
      }
      if ((rejectedByOwner[user.id] || 0) >= 3) {
        await upsertRiskCase({
          type: '用户', ruleCode: 'user_rejected_many', ruleLabel: '多次被驳回', level: '中',
          targetId: user.id, targetLabel: label, uid: user.id,
          detail: `累计被驳回 ${rejectedByOwner[user.id]} 次`
        }, at)
      }
      if (user.status && user.status !== '正常') {
        await upsertRiskCase({
          type: '用户', ruleCode: 'user_status_abnormal', ruleLabel: '账号状态异常', level: '高',
          targetId: user.id, targetLabel: label, uid: user.id, detail: `当前状态：${user.status}`
        }, at)
      }
    }

    /* 3) 咨询：正文含联系方式 / 超时未分配 */
    const contactRe = /1[3-9]\d{9}|(微信|weixin|wx|vx|v信)\s*[:：]?\s*[a-zA-Z0-9_-]{5,}|qq\s*[:：]?\s*\d{5,12}/i
    for (const lead of leads) {
      const text = String(lead.formSummary || '')
      const label = `咨询单 ${lead.id}`
      if (contactRe.test(text)) {
        await upsertRiskCase({
          type: '咨询', ruleCode: 'consult_contact', ruleLabel: '咨询含联系方式', level: '中',
          targetId: lead.id, targetLabel: label, uid: lead.uid || '',
          detail: '咨询内容疑似包含手机号 / 微信号'
        }, at)
      }
      if (lead.status === '待分配' && at - (Number(lead.createdAt) || at) > DAY_MS) {
        await upsertRiskCase({
          type: '咨询', ruleCode: 'consult_overdue', ruleLabel: '超时未分配', level: '低',
          targetId: lead.id, targetLabel: label, uid: lead.uid || '',
          detail: '超过 24 小时仍未分配坐席'
        }, at)
      }
      for (const hit of scanSensitive(text)) {
        await upsertRiskCase({
          type: '咨询', ruleCode: hit.code, ruleLabel: hit.label, level: hit.level,
          targetId: lead.id, targetLabel: label, uid: lead.uid || '',
          detail: `咨询内容命中${hit.name}敏感词：${hit.words.slice(0, 6).join('、')}`
        }, at)
      }
    }

    /* 4) 对话：站内留言 / 直聊消息命中色情、暴力、反动词库，只提示、不自动拦截 */
    for (const msg of messages) {
      const payload = msg.payload || {}
      if (payload.kind && payload.kind !== 'text') continue
      const text = String(payload.body || '')
      const hits = scanSensitive(text)
      if (!hits.length) continue
      const threadId = String(payload.threadId || payload.channel || payload.uid || '')
      const online = payload.channel === 'kf'
      const label = `${online ? '客服留言' : '站内对话'} ${payload.targetTitle || payload.leadId || threadId}`.slice(0, 80)
      for (const hit of hits) {
        await upsertRiskCase({
          type: '对话', ruleCode: hit.code, ruleLabel: hit.label, level: hit.level,
          targetId: threadId || msg.id, targetLabel: label, uid: payload.uid || '',
          detail: `消息命中${hit.name}敏感词：${hit.words.slice(0, 6).join('、')}`
        }, at)
      }
    }

    /* 5) 系统：收款待确认超时 / 近期运行错误 */
    for (const payment of payments) {
      if (payment.status !== '待确认') continue
      if (at - (Number(payment.paidAt) || Number(payment.createdAt) || at) <= 3 * DAY_MS) continue
      await upsertRiskCase({
        type: '系统', ruleCode: 'system_payment_pending', ruleLabel: '收款待确认超时', level: '中',
        targetId: payment.id, targetLabel: `收款单 ${payment.id}`, uid: payment.uid || '',
        detail: `${payment.bizType || '收款'} · ${payment.received || 0} 元待确认`
      }, at)
    }
    const errorLogs = systemLogs.filter((row) => row.level === 'error')
    if (errorLogs.length) {
      await upsertRiskCase({
        type: '系统', ruleCode: 'system_error', ruleLabel: '运行错误', level: '高',
        targetId: 'system_recent_error', targetLabel: '近 24 小时运行错误',
        uid: '', detail: `近 24 小时出现 ${errorLogs.length} 条错误日志`
      }, at)
    }
  }

  /** 统计当前在线人数：lastSeenAt 在 TTL 内的算在线 */
  async function onlineCount() {
    const at = now()
    const rows = await repo.find('onlineUsers', {}, { limit: 5000 })
    let online = 0
    for (const row of rows) {
      if (at - (Number(row.lastSeenAt) || 0) <= ONLINE_TTL_MS) online += 1
    }
    return { online, tracked: rows.length, ttlMs: ONLINE_TTL_MS }
  }

  /** 读取全部商品与需求（榜单用）：已过千条，不能再按 500 条采样，否则榜单缺项 */
  async function allListings() {
    const products = await repo.find('products', {}, { limit: 100000 })
    const demands = await repo.find('demands', {}, { limit: 100000 })
    return { products, demands }
  }

  return {
    /**
     * 实时运营看板：在线人数、搜索热榜、品类榜单。
     * 榜单用于辅助商家囤货：浏览量高 = 关注度高，可提前备货。
     */
    'insights.board': async (data) => {
      const at = now()
      const day = dayKeyOf(at)
      const online = await onlineCount()
      const { products, demands } = await allListings()

      /* ---------- 搜索热榜：当日搜索词 Top ---------- */
      const counters = await repo.find('counters', {}, { limit: 5000 })
      const hotSearches = hotSearchesOf(counters, day, 20)

      /* ---------- 品类榜单：在售货源 / 求购需求按浏览量、咨询量排序 ---------- */
      const onSale = products.filter((p) => p.status === '在售' && !p.deleted)
      const openDemands = demands.filter((d) => d.status === '求购中' && !d.deleted)
      const boards = boardsOf(onSale, openDemands, 20)

      /* ---------- 型号榜：同型号聚合，囤货参考价值更高 ---------- */
      const modelBoards = modelBoardsOf(onSale, 30)

      /* ---------- 搜索最多的商品：搜索词落到具体型号 ---------- */
      const hotProducts = hotProductsOf(onSale, hotSearches, 20)

      return {
        at,
        day,
        online: online.online,
        onlineTracked: online.tracked,
        onlineTtlMs: online.ttlMs,
        totals: {
          products: products.length,
          onSale: onSale.length,
          demands: demands.length,
          openDemands: openDemands.length
        },
        hotSearches,
        hotProducts,
        boards,
        modelBoards
      }
    },

    /** 搜索热榜（单独取，供榜单页刷新） */
    'insights.searches': async (data) => {
      const at = now()
      const day = data.day || dayKeyOf(at)
      const scope = data.scope ? enumOf(data.scope, BOARD_SCOPES, '榜单维度') : ''
      const counters = await repo.find('counters', {}, { limit: 5000 })
      const map = {}
      for (const row of counters) {
        const key = String(row.key || '')
        const prefix = 'search:' + day + ':'
        if (key.indexOf(prefix) !== 0) continue
        const rest = key.slice(prefix.length)
        const parts = rest.split(':')
        const n = Number(row.count) || 0
        if (scope && scope !== 'all') {
          /* 指定维度：只取「search:<日>:<维度>:<词>」这种带维度的键 */
          if (parts.length < 3 || parts[parts.length - 2] !== scope) continue
          const word = parts.slice(parts.length - 1).join(':')
          map[word] = (map[word] || 0) + n
          continue
        }
        /* 全维度：只取「search:<日>:<词>」这种总计键，避免与分维度键重复累加 */
        if (parts.length !== 1) continue
        map[parts[0]] = (map[parts[0]] || 0) + n
      }
      const items = Object.keys(map)
        .map((word) => ({ word, count: map[word] }))
        .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
        .slice(0, 30)
      return { day, scope: scope || 'all', items, total: items.length }
    },

    /**
     * 品类榜单：按维度取货源 / 求购排行。
     * scope=all 时返回所有维度。
     */
    'insights.boards': async (data) => {
      const at = now()
      const scope = data.scope ? enumOf(data.scope, BOARD_SCOPES, '榜单维度') : 'all'
      const limit = Math.min(Math.max(Number(data.limit) || 20, 1), 50)
      const { products, demands } = await allListings()
      const map = {}
      const push = (key, row, kind) => {
        if (!map[key]) map[key] = { scope: key, items: [], views: 0, consults: 0, qty: 0 }
        map[key].items.push({
          id: row.id,
          kind,
          title: row.title || row.model || '',
          cat: row.cat || '',
          brand: row.brand || '',
          model: row.model || '',
          city: row.city || '',
          price: Number(row.price) || 0,
          qty: Number(row.qty) || 0,
          views: Number(row.views) || 0,
          consults: Number(row.heat) || 0,
          at: Number(row.createdAt) || at
        })
        map[key].views += Number(row.views) || 0
        map[key].consults += Number(row.heat) || 0
        map[key].qty += Number(row.qty) || 0
      }
      for (const p of products.filter((p) => p.status === '在售' && !p.deleted)) {
        push(boardScopeOf(p.cat, p.model), p, '货源')
      }
      for (const d of demands.filter((d) => d.status === '求购中' && !d.deleted)) {
        push(boardScopeOf(d.cat, d.model), d, '求购')
      }
      const list = Object.keys(map).map((key) => {
        const entry = map[key]
        entry.items.sort((a, b) => b.views - a.views || b.consults - a.consults)
        entry.items = entry.items.slice(0, limit)
        entry.total = entry.items.length
        return entry
      }).sort((a, b) => b.views - a.views || b.consults - a.consults)
      const filtered = scope === 'all' ? list : list.filter((e) => e.scope === scope)
      return { at, scope, boards: filtered, total: filtered.length }
    },

    /**
     * 风险池：列出系统标记为「风险待看」的商品与需求。
     * 只读列表，人工看不看都不影响展示。
     */
    'risk.list': async (data) => {
      const at = now()
      const page = normalizePaging(data)
      const status = data.status ? enumOf(data.status, RISK_STATUS_LIST, '风险状态') : RISK_STATUS.PENDING
      /* 商品 / 需求都已过千条：全量读取后再筛选与统计，
         按 200 / 500 条采样会让风险项漏列、各状态数量也不准 */
      const [allProducts, allDemands] = await Promise.all([
        repo.find('products', {}, { limit: 100000 }),
        repo.find('demands', {}, { limit: 100000 })
      ])
      const products = allProducts.filter((p) => p.riskStatus === status)
      const demands = allDemands.filter((d) => d.riskStatus === status)
      const all = products.map((p) => Object.assign(riskViewOf(p, 'product'), { at: Number(p.createdAt) || at }))
        .concat(demands.map((d) => Object.assign(riskViewOf(d, 'demand'), { at: Number(d.createdAt) || at })))
        .sort((a, b) => b.at - a.at)
      const start = (page.page - 1) * page.limit
      const items = all.slice(start, start + page.limit)
      const counts = {}
      for (const name of RISK_STATUS_LIST) counts[name] = 0
      /* 计数与列表同一口径：只统计被系统标记过风险状态的内容，
         未标记（历史数据 / 测试数据）不计入，避免「待看」数量虚高 */
      for (const row of allProducts.concat(allDemands)) {
        if (!row.riskStatus || counts[row.riskStatus] === undefined) continue
        counts[row.riskStatus] += 1
      }
      return { items, total: all.length, page: page.page, limit: page.limit, counts }
    },

    /**
     * 风险处置：人工打回或排除。
     * 打回 = 强制下架（用户可编辑后再发布）；排除 = 确认无风险，不再提示。
     */
    'risk.handle': async (data, ctx) => {
      const kind = enumOf(data.kind || 'product', ['product', 'demand'], '对象类型')
      const id = str(data.id, { field: '对象标识', required: true, max: 64 })
      const decision = enumOf(data.decision, ['打回', '排除'], '处置动作')
      const reason = str(data.reason, { field: '处置原因', max: 100 })
      if (decision === '打回' && reason.length < 2) {
        throw new AppError(CODES.VALIDATION, '打回时请填写原因')
      }
      const at = now()
      const collection = kind === 'product' ? 'products' : 'demands'
      const doc = await repo.get(collection, id)
      if (!doc) throw new AppError(CODES.NOT_FOUND, '对象不存在')
      if (decision === '打回') {
        /* 打回 = 退回修改：置为「已驳回」而不是「已下架」，
           这样发布方可以编辑后重新提交，避免「下架后无法自助恢复」的死路 */
        const res = await repo.updateWhere(collection, { id }, {
          riskStatus: RISK_STATUS.CONFIRMED,
          riskReason: reason,
          riskHandledBy: (ctx && ctx.accountId) || 'admin',
          riskHandledAt: at,
          status: '已驳回',
          reviewReason: reason,
          offlineReason: reason,
          updatedAt: at
        })
        if (!res || !res.count) throw new AppError(CODES.CONFLICT, '对象状态已变更，请刷新后重试')
        /* 收尾：洽谈中 / 已对接的线索随打回一并关闭，不留悬空工单 */
        const linked = kind === 'product' ? 'productId' : 'demandId'
        const pendingStatus = kind === 'product' ? '洽谈中' : '已对接'
        if (doc.status === pendingStatus) {
          await closeMatchedLeads(linked, id, '内容被平台打回', at)
        }
        /* 回执：把处置结论同步给发布方，用户端「消息」可见 */
        const label = kind === 'product' ? '商品' : '需求'
        await notifyOwner(doc.ownerId, {
          title: `${label}被退回`,
          body: `你的${label}「${doc.title || doc.model || id}」经平台复核未通过：${reason}。修改后可重新发布上架。`,
          targetType: kind,
          targetId: id,
          reason
        })
      } else {
        const res = await repo.updateWhere(collection, { id }, {
          riskStatus: RISK_STATUS.CLEARED,
          riskReason: reason,
          riskHandledBy: (ctx && ctx.accountId) || 'admin',
          riskHandledAt: at
        })
        if (!res || !res.count) throw new AppError(CODES.CONFLICT, '对象状态已变更，请刷新后重试')
      }
      await audit(ctx, 'risk.handle', `${kind}:${id}`, `${decision}${reason ? '：' + reason : ''}`)
      return { id, kind, decision, riskStatus: decision === '打回' ? RISK_STATUS.CONFIRMED : RISK_STATUS.CLEARED }
    },

    /**
     * 风险单：四类视图（商品 / 用户 / 咨询 / 系统）。
     * refresh=true 时先跑一次全量扫描，再返回结果。
     */
    'risk.cases': async (data) => {
      const at = now()
      if (data.refresh) await scanRiskCases(at)
      const page = normalizePaging(data)
      const type = data.type ? enumOf(data.type, RISK_TYPES, '风险类型') : ''
      const status = data.status ? enumOf(data.status, RISK_CASE_STATUS_LIST, '处置状态') : ''
      const level = data.level ? enumOf(data.level, RISK_LEVELS, '风险等级') : ''
      const keyword = str(data.keyword, { field: '关键词', max: 40 }).toLowerCase()
      const query = {}
      if (type) query.type = type
      if (status) query.status = status
      if (level) query.level = level
      let rows = await repo.find('riskCases', query, { limit: 5000 })
      if (keyword) {
        rows = rows.filter((row) => [row.targetLabel, row.targetId, row.ruleLabel, row.detail, row.uid]
          .map((item) => String(item == null ? '' : item).toLowerCase()).join(' ').includes(keyword))
      }
      const levelWeight = { 高: 3, 中: 2, 低: 1 }
      rows.sort((a, b) => (levelWeight[b.level] || 0) - (levelWeight[a.level] || 0)
        || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      const allRows = await repo.find('riskCases', {}, { limit: 10000 })
      const counts = { total: allRows.length, byType: {}, byStatus: {}, byLevel: {} }
      for (const name of RISK_TYPES) counts.byType[name] = 0
      for (const name of RISK_CASE_STATUS_LIST) counts.byStatus[name] = 0
      for (const name of RISK_LEVELS) counts.byLevel[name] = 0
      for (const row of allRows) {
        if (counts.byType[row.type] !== undefined) counts.byType[row.type] += 1
        if (counts.byStatus[row.status] !== undefined) counts.byStatus[row.status] += 1
        if (counts.byLevel[row.level] !== undefined) counts.byLevel[row.level] += 1
      }
      const items = rows.slice((page.page - 1) * page.limit, page.page * page.limit).map((row) => ({
        id: row.id,
        type: row.type,
        level: row.level,
        ruleCode: row.ruleCode,
        ruleLabel: row.ruleLabel,
        targetId: row.targetId,
        targetLabel: row.targetLabel,
        uid: row.uid || '',
        detail: row.detail || '',
        status: row.status,
        owner: row.owner || '',
        action: row.action || '',
        reason: row.reason || '',
        createdAt: Number(row.createdAt) || 0,
        createdText: timeTextOf(row.createdAt),
        updatedAt: Number(row.updatedAt) || 0
      }))
      return {
        items,
        total: rows.length,
        page: page.page,
        limit: page.limit,
        counts,
        types: RISK_TYPES,
        statusList: RISK_CASE_STATUS_LIST,
        levels: RISK_LEVELS,
        rules: RISK_EXTRA_RULES.concat(RISK_RULES.map((rule) => ({
          code: rule.code,
          type: '商品',
          label: rule.label,
          level: '中',
          desc: rule.desc
        }))),
        at
      }
    },

    /** 风险单处置：认领 / 处理中 / 已处理 / 已忽略，全程留痕 */
    'risk.caseUpdate': async (data, ctx) => {
      const id = str(data.id, { field: '风险单', required: true, max: 64 })
      const row = await repo.get('riskCases', id)
      if (!row) throw new AppError(CODES.NOT_FOUND, '风险单不存在')
      const at = now()
      const status = data.status ? enumOf(data.status, RISK_CASE_STATUS_LIST, '处置状态') : row.status
      const owner = data.owner !== undefined ? str(data.owner, { field: '处理人', max: 32 }) : (row.owner || '')
      const action = data.action !== undefined ? str(data.action, { field: '处置动作', max: 60 }) : (row.action || '')
      const reason = data.reason !== undefined ? str(data.reason, { field: '处置说明', max: 200 }) : (row.reason || '')
      const res = await repo.updateWhere('riskCases', { id }, { status, owner, action, reason, updatedAt: at })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '风险单状态已变更，请刷新后重试')
      await audit(ctx, 'risk.caseUpdate', id, `${status}${reason ? '：' + reason : ''}`)
      return { id, status, owner, action, reason, updatedAt: at }
    }
  }
}

/** 风险单时间展示（本地简单格式化，避免跨模块依赖） */
function timeTextOf(ms) {
  if (!ms) return ''
  const d = new Date(Number(ms) + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/**
 * 风险池条目视图：只给脱敏信息。
 */
function riskViewOf(doc, kind) {
  return {
    id: doc.id,
    kind,
    title: doc.title || doc.model || '',
    cat: doc.cat || '',
    brand: doc.brand || '',
    model: doc.model || '',
    city: doc.city || '',
    price: Number(doc.price || doc.budget) || 0,
    qty: Number(doc.qty) || 0,
    status: doc.status || '',
    views: Number(doc.views) || 0,
    consults: Number(doc.heat) || 0,
    riskStatus: doc.riskStatus || RISK_STATUS.PENDING,
    riskReason: doc.riskReason || '',
    riskHits: Array.isArray(doc.riskHits) ? doc.riskHits : [],
    riskHandledBy: doc.riskHandledBy || '',
    riskHandledAt: Number(doc.riskHandledAt) || 0
  }
}

/**
 * 发布时自动判定风险：命中规则即标记为「风险待看」。
 * 不阻断发布，不影响展示，只是给人工一个可选的复核入口。
 */
function detectRisk(doc, context) {
  const ctx = context || {}
  const hits = []
  for (const rule of RISK_RULES) {
    if (rule.code === 'repeat_listing') continue
    let hit = false
    try { hit = !!rule.check(doc) } catch (err) { hit = false }
    if (hit) hits.push({ code: rule.code, label: rule.label, desc: rule.desc })
  }
  /* 重复铺货：同一货主 24 小时内发布多条同型号 */
  if (ctx.sameModelCount >= 3) {
    hits.push({
      code: 'repeat_listing',
      label: '疑似重复铺货',
      desc: `同一货主 24 小时内发布同型号 ${ctx.sameModelCount} 条`
    })
  }
  /* 敏感词：色情 / 暴力 / 反动，命中只提示风险，不拦截发布 */
  const text = [doc.title, doc.note, doc.accept, doc.requirements, doc.limit, doc.detail, doc.item, doc.model]
    .filter(Boolean).join(' ')
  for (const hit of scanSensitive(text)) {
    hits.push({
      code: hit.code,
      label: hit.label,
      desc: `命中${hit.name}敏感词：${hit.words.slice(0, 6).join('、')}${hit.words.length > 6 ? ' 等' : ''}`
    })
  }
  if (!hits.length) return { riskStatus: RISK_STATUS.CLEARED, riskHits: [] }
  return { riskStatus: RISK_STATUS.PENDING, riskHits: hits }
}

module.exports = {
  RISK_STATUS,
  RISK_STATUS_LIST,
  RISK_RULES,
  RISK_EXTRA_RULES,
  RISK_TYPES,
  BOARD_SCOPES,
  ONLINE_TTL_MS,
  VIEW_DEDUPE_MS,
  boardScopeOf,
  normalizeModel,
  dayKeyOf,
  windowStartOf,
  detectRisk,
  createInsightsUserHandlers,
  createInsightsAdminHandlers
}
