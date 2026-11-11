'use strict'

const { AppError, CODES } = require('./errors')

/**
 * 仓储接口约定（repo.cloud.js 提供云数据库实现）：
 *   repo.get(collection, id)                      -> doc | null
 *   repo.find(collection, query, opts)            -> doc[]  opts: {sort, skip, limit}
 *   repo.count(collection, query)                 -> number
 *   repo.insert(collection, doc)                  -> doc（唯一约束冲突抛 CONFLICT）
 *   repo.updateWhere(collection, query, patch)    -> { count }（CAS：不匹配则 count=0）
 *   repo.incrCounter(key, windowStart, delta)     -> count（原子自增，delta 可为负数用于回滚）
 *
 * 约束：
 *   1) 审计集合追加式，updateWhere 直接拒绝；
 *   2) leads 在 status=已对接 时对 productId / demandId 唯一（同一商品/需求同时只能一条已对接）；
 *   3) updateWhere 为比较并交换语义：只有当前命中 query 的记录会被更新。
 */

const COLLECTIONS = Object.freeze([
  'users', 'profiles', 'products', 'demands', 'leads', 'blocked', 'rules',
  'sessions', 'counters', 'audit', 'outbox', 'files', 'accounts', 'stocks',
  'agencies', 'quotes', 'news', 'bizAccess', 'bizClaims', 'bizMarks', 'bizPrefs',
  'onlineUsers', 'searchLogs', 'favorites', 'follows', 'behaviorEvents',
  /* settings：平台级配置（咨询单审批排序权重等）；catalog：平台维护的产品型号 */
  'settings', 'catalog',
  /* P0 数据底座：会员订单流水、收款流水、日快照、风险单、系统/登录日志、角色与临时权限 */
  'bizOrders', 'payments', 'dailyStats', 'riskCases', 'systemLogs', 'loginLogs',
  'roles', 'accountPermissions',
  /* 用户行为事件（90 天保留）与直聊会话级展示授权 */
  'userEvents', 'chatReveals',
  /* 用户提交的举报 / 投诉 / 意见反馈、账号注销申请、退款申请 */
  'reports', 'accountRequests', 'refundRequests',
  /* 聊天媒体打开登记：已打开的图片 / 视频保留 30 天，未打开 7 天后清理 */
  'chatMedia',
  /* 资讯互动：点赞、评论与「我的评论」已读位置 */
  'newsLikes', 'newsComments', 'commentReads'
])

const UNIQUE_INDEXES = Object.freeze({
  users: [['openid']],
  profiles: [['uid']],
  sessions: [['tokenHash']],
  /* counters 的 id 已经含窗口起点（key@windowStart），不能再对 key 建唯一索引，否则跨窗口会冲突 */
  counters: [['id']],
  files: [['storagePath']],
  /* 管理账号：账号名唯一，登录时与环境变量账号合并 */
  accounts: [['username']],
  /* 收藏：同一用户对同一对象只留一条（软删后重新收藏走同一行） */
  favorites: [['uid', 'targetType', 'targetId']],
  /* 关注货主 / 商品：同一用户对同一对象只留一条（targetKey 为匿名货主键或商品 id） */
  follows: [['uid', 'targetKey']],
  /* 资讯点赞：同一用户对同一篇资讯只留一条 */
  newsLikes: [['uid', 'newsId']],
  /* 评论已读位置：每个用户一条 */
  commentReads: [['uid']],
  /* 日快照：同一天只保留一条聚合记录 */
  dailyStats: [['date']],
  /* 自定义角色：角色标识唯一 */
  roles: [['roleKey']]
})

function clone(value) {
  if (value === undefined) return undefined
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}

function getPath(doc, path) {
  const parts = String(path).split('.')
  let cur = doc
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[part]
  }
  return cur
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 支持精确值、$in / $ne / $gte / $lt / $exists 与点号路径 */
function matchDoc(doc, query) {
  if (!query) return true
  for (const key of Object.keys(query)) {
    const cond = query[key]
    const actual = getPath(doc, key)
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$in' in cond && !cond.$in.some((v) => deepEqual(actual, v))) return false
      if ('$ne' in cond && deepEqual(actual, cond.$ne)) return false
      if ('$gte' in cond && !(actual >= cond.$gte)) return false
      if ('$lt' in cond && !(actual < cond.$lt)) return false
      if ('$exists' in cond && (actual !== undefined) !== cond.$exists) return false
      if ('$regex' in cond) {
        const re = new RegExp(String(cond.$regex), cond.$options || '')
        if (!re.test(String(actual == null ? '' : actual))) return false
      }
      continue
    }
    if (!deepEqual(actual, cond)) return false
  }
  return true
}

function applySort(rows, sort) {
  if (!sort) return rows
  const specs = Array.isArray(sort) ? sort : [sort]
  return rows.slice().sort((a, b) => {
    for (const spec of specs) {
      const field = typeof spec === 'string' ? spec : spec.field
      const dir = typeof spec === 'string' ? 'asc' : spec.dir === 'desc' ? -1 : 1
      const av = getPath(a, field)
      const bv = getPath(b, field)
      if (av === bv) continue
      if (av === undefined || av === null) return 1
      if (bv === undefined || bv === null) return -1
      if (av > bv) return dir
      if (av < bv) return -dir
    }
    return 0
  })
}

function assertCollection(name) {
  if (!COLLECTIONS.includes(name)) throw new AppError(CODES.INTERNAL, '未知集合')
}

function createMemoryRepo(seed) {
  const state = {}
  for (const name of COLLECTIONS) state[name] = []
  if (seed && typeof seed === 'object') {
    for (const name of Object.keys(seed)) {
      if (!COLLECTIONS.includes(name) || !Array.isArray(seed[name])) continue
      state[name] = seed[name].map((doc) => clone(doc))
    }
  }

  // 串行化写操作：模拟数据库行锁 + 事务，保证 CAS / 唯一约束在并发下成立
  let chain = Promise.resolve()
  function withLock(fn) {
    const run = chain.then(() => fn())
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  function uniqueViolation(collection, doc, excludeId) {
    const specs = UNIQUE_INDEXES[collection] || []
    for (const fields of specs) {
      const hit = state[collection].some((row) => {
        if (row.id === excludeId) return false
        return fields.every((f) => deepEqual(getPath(row, f), getPath(doc, f)))
      })
      if (hit) return true
    }
    /* 同一商品 / 需求同一时刻只允许一条占用中的线索：
       已对接（洽谈中）与已成交（已占用）都算占用，避免成交后又并发建群 */
    if (collection === 'leads' && (doc.status === '已对接' || doc.status === '已成交')) {
      const dup = state.leads.some((row) => {
        if (row.id === excludeId) return false
        if (row.status !== '已对接' && row.status !== '已成交') return false
        if (doc.productId && row.productId === doc.productId) return true
        if (doc.demandId && row.demandId === doc.demandId) return true
        return false
      })
      if (dup) return true
    }
    return false
  }

  return {
    async get(collection, id) {
      assertCollection(collection)
      const doc = state[collection].find((row) => row.id === id)
      return doc ? clone(doc) : null
    },

    async find(collection, query, opts) {
      assertCollection(collection)
      const o = opts || {}
      let rows = state[collection].filter((row) => matchDoc(row, query))
      if (o.sort) rows = applySort(rows, o.sort)
      const skip = Number.isFinite(o.skip) ? Math.max(0, o.skip) : 0
      if (skip) rows = rows.slice(skip)
      if (Number.isFinite(o.limit) && o.limit >= 0) rows = rows.slice(0, o.limit)
      return rows.map((row) => clone(row))
    },

    async count(collection, query) {
      assertCollection(collection)
      return state[collection].filter((row) => matchDoc(row, query)).length
    },

    async insert(collection, doc) {
      assertCollection(collection)
      return withLock(() => {
        if (!doc || !doc.id) throw new AppError(CODES.VALIDATION, '记录缺少 id')
        if (state[collection].some((row) => row.id === doc.id)) {
          throw new AppError(CODES.CONFLICT, '记录已存在')
        }
        if (uniqueViolation(collection, doc, doc.id)) {
          throw new AppError(CODES.CONFLICT, '记录已存在')
        }
        const stored = clone(doc)
        state[collection].push(stored)
        return clone(stored)
      })
    },

    async updateWhere(collection, query, patch) {
      assertCollection(collection)
      if (collection === 'audit') throw new AppError(CODES.FORBIDDEN, '审计日志不可修改')
      /* 空条件会命中整张表，属于高危误操作，直接拦住 */
      if (!query || !Object.keys(query).length) {
        throw new AppError(CODES.INTERNAL, '更新条件不能为空')
      }
      if (!patch || !Object.keys(patch).length) return { count: 0 }
      return withLock(() => {
        const matched = state[collection].filter((row) => matchDoc(row, query))
        if (matched.length === 0) return { count: 0 }
        for (const row of matched) {
          const next = Object.assign({}, row, clone(patch))
          if (uniqueViolation(collection, next, row.id)) {
            throw new AppError(CODES.CONFLICT, '已存在冲突记录')
          }
        }
        for (const row of matched) Object.assign(row, clone(patch))
        return { count: matched.length }
      })
    },

    /** 按条件批量删除（用于行为事件 90 天清理）；空条件一律拒绝 */
    async removeWhere(collection, query, limit) {
      assertCollection(collection)
      /* 审计日志只允许追加：删除与修改一样视为篡改 */
      if (collection === 'audit') throw new AppError(CODES.FORBIDDEN, '审计日志不可删除')
      if (!query || !Object.keys(query).length) {
        throw new AppError(CODES.INTERNAL, '删除条件不能为空')
      }
      return withLock(() => {
        const max = Number.isFinite(limit) ? Math.max(1, limit) : 100
        let count = 0
        for (let i = state[collection].length - 1; i >= 0 && count < max; i -= 1) {
          if (matchDoc(state[collection][i], query)) {
            state[collection].splice(i, 1)
            count += 1
          }
        }
        return { count }
      })
    },

    async incrCounter(key, windowStart, delta) {
      const step = Number.isFinite(delta) ? delta : 1
      return withLock(() => {
        const id = `${key}@${windowStart}`
        let row = state.counters.find((item) => item.id === id)
        if (!row) {
          /* 回滚（负数）时若计数记录不存在，视为 0，不凭空造一条 */
          if (step <= 0) return 0
          row = { id, key: String(key), windowStart: Number(windowStart), count: 0 }
          state.counters.push(row)
        }
        row.count = Math.max(0, row.count + step)
        return row.count
      })
    },

    /** 仅供本地调试 / 测试：直接读取原始集合快照 */
    _snapshot() {
      return clone(state)
    }
  }
}

module.exports = { COLLECTIONS, UNIQUE_INDEXES, createMemoryRepo }
