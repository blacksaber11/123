'use strict'

const { AppError, CODES } = require('./errors')
const { UNIQUE_INDEXES, COLLECTIONS } = require('./repo')

/**
 * 基于 wx-server-sdk 的云数据库实现。
 * 注意：本文件只在云函数里被 require，本地 verify 不加载（不需要 wx-server-sdk）。
 *
 * 唯一约束 / CAS 依赖事务实现：
 *   - insert：事务内先按唯一索引查询，再 add；
 *   - updateWhere：事务内先 where().get() 命中，再逐条 update，等价于比较并交换；
 *   - leads 在 status=已对接 时额外校验 productId / demandId 唯一。
 */
function createCloudRepo(cloud) {
  const db = cloud.database()
  const _ = db.command

  function isNotExist(err) {
    if (!err) return false
    if (err.errCode === -1 || err.errCode === 'DATABASE_DOCUMENT_NOT_EXIST') return true
    return /not exist|cannot find document|does not exist/i.test(String(err.message || err.errMsg || ''))
  }

  /** 唯一键冲突（并发下事务校验通过、add 仍可能撞唯一索引） */
  function isDuplicate(err) {
    if (!err) return false
    return /duplicate|E11000|already exist/i.test(String(err.message || err.errMsg || ''))
  }

  function toWhere(query) {
    const out = {}
    for (const key of Object.keys(query || {})) {
      const cond = query[key]
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        /* 区间查询（$gte + $lt 同时出现）必须合并成一个 and，否则只会命中下界 */
        const hasGte = '$gte' in cond
        const hasLt = '$lt' in cond
        if (hasGte && hasLt) {
          out[key] = _.and(_.gte(cond.$gte), _.lt(cond.$lt))
          continue
        }
        if ('$in' in cond) out[key] = _.in(cond.$in)
        else if ('$ne' in cond) out[key] = _.neq(cond.$ne)
        else if (hasGte) out[key] = _.gte(cond.$gte)
        else if (hasLt) out[key] = _.lt(cond.$lt)
        else if ('$regex' in cond) out[key] = db.RegExp({ regexp: String(cond.$regex), options: cond.$options || 'i' })
        continue
      }
      out[key] = cond
    }
    return out
  }

  async function assertNoDuplicate(tx, collection, doc, excludeId) {
    const specs = UNIQUE_INDEXES[collection] || []
    for (const fields of specs) {
      const query = {}
      for (const f of fields) query[f] = doc[f]
      if (fields.length === 1 && doc[fields[0]] === undefined) continue
      const res = await tx.collection(collection).where(query).get()
      const duplicated = (res.data || []).some((row) => row._id !== excludeId && row.id !== excludeId)
      if (duplicated) throw new AppError(CODES.CONFLICT, '记录已存在')
    }
    if (collection === 'leads' && (doc.status === '已对接' || doc.status === '已成交')) {
      for (const key of ['productId', 'demandId']) {
        if (!doc[key]) continue
        const res = await tx.collection('leads').where({
          [key]: doc[key],
          status: db.RegExp({ regexp: '^(已对接|已成交)$', options: '' })
        }).get()
        const duplicated = (res.data || []).some((row) => row._id !== excludeId && row.id !== excludeId)
        if (duplicated) throw new AppError(CODES.CONFLICT, '该对象已有占用中的线索')
      }
    }
  }

  return {
    async get(collection, id) {
      if (!COLLECTIONS.includes(collection)) throw new AppError(CODES.INTERNAL, '未知集合')
      if (!id) return null
      try {
        const res = await db.collection(collection).doc(id).get()
        if (res && res.data) return res.data
      } catch (err) {
        if (!isNotExist(err)) throw err
      }
      /* 兼容历史数据：早期 insert 未写 _id，只能按业务 id 字段回查 */
      const rows = await db.collection(collection).where({ id }).limit(1).get()
      return (rows.data || [])[0] || null
    },

    async find(collection, query, opts) {
      const o = opts || {}
      const specs = o.sort ? (Array.isArray(o.sort) ? o.sort : [o.sort]) : []
      const skip = Number.isFinite(o.skip) ? Math.max(0, o.skip) : 0
      /* 云数据库单次 get 上限 500 条：超过 500 时按页循环取全，
         否则统计 / 财务聚合会被静默截断（内存适配器是全量，线上口径会不一致） */
      const PAGE = 500
      const want = Number.isFinite(o.limit) ? Math.min(Math.max(1, o.limit), 100000) : 20
      const page = (from, size) => {
        let q = db.collection(collection).where(toWhere(query))
        for (const spec of specs) {
          const field = typeof spec === 'string' ? spec : spec.field
          const dir = typeof spec === 'string' ? 'asc' : spec.dir === 'desc' ? 'desc' : 'asc'
          q = q.orderBy(field, dir)
        }
        return q.skip(from).limit(size)
      }
      const out = []
      let from = skip
      while (out.length < want) {
        const size = Math.min(PAGE, want - out.length)
        const res = await page(from, size).get()
        const rows = res.data || []
        for (const row of rows) out.push(row)
        if (rows.length < size) break
        from += rows.length
      }
      return out
    },

    async count(collection, query) {
      const res = await db.collection(collection).where(toWhere(query)).count()
      return res.total || 0
    },

    async insert(collection, doc) {
      if (!doc || !doc.id) throw new AppError(CODES.VALIDATION, '记录缺少 id')
      await db.runTransaction(async (tx) => {
        await assertNoDuplicate(tx, collection, doc, doc.id)
        /* _id 必须等于业务 id：get/updateWhere 都按 _id 定位，
           不写 _id 会导致二次登录 CONFLICT 与计数自增失效 */
        try {
          await tx.collection(collection).add({ data: Object.assign({}, doc, { _id: doc.id }) })
        } catch (err) {
          /* 并发写撞唯一索引：统一成 CONFLICT，调用方才能按幂等逻辑回读而不是报 500 */
          if (isDuplicate(err)) throw new AppError(CODES.CONFLICT, '记录已存在')
          throw err
        }
      })
      return doc
    },

    async updateWhere(collection, query, patch) {
      if (collection === 'audit') throw new AppError(CODES.FORBIDDEN, '审计日志不可修改')
      /* 空条件会命中整张表，属于高危误操作，直接拦住 */
      if (!query || !Object.keys(query).length) {
        throw new AppError(CODES.INTERNAL, '更新条件不能为空')
      }
      if (!patch || !Object.keys(patch).length) return { count: 0 }
      let count = 0
      await db.runTransaction(async (tx) => {
        const res = await tx.collection(collection).where(toWhere(query)).get()
        const rows = res.data || []
        for (const row of rows) {
          const next = Object.assign({}, row, patch)
          await assertNoDuplicate(tx, collection, next, row._id || row.id)
        }
        for (const row of rows) {
          await tx.collection(collection).doc(row._id || row.id).update({ data: patch })
          count += 1
        }
      })
      return { count }
    },

    /** 按条件批量删除（行为事件 90 天清理）；云数据库单次上限 100，循环直到清空 */
    async removeWhere(collection, query, limit) {
      if (!COLLECTIONS.includes(collection)) throw new AppError(CODES.INTERNAL, '未知集合')
      /* 审计日志只允许追加：删除与修改一样视为篡改 */
      if (collection === 'audit') throw new AppError(CODES.FORBIDDEN, '审计日志不可删除')
      if (!query || !Object.keys(query).length) {
        throw new AppError(CODES.INTERNAL, '删除条件不能为空')
      }
      const max = Number.isFinite(limit) ? Math.max(1, limit) : 100
      let count = 0
      while (count < max) {
        const res = await db.collection(collection).where(toWhere(query)).limit(Math.min(100, max - count)).get()
        const rows = res.data || []
        if (!rows.length) break
        for (const row of rows) {
          await db.collection(collection).doc(row._id || row.id).remove()
          count += 1
        }
      }
      return { count }
    },

    async incrCounter(key, windowStart, delta) {
      const step = Number.isFinite(delta) ? delta : 1
      const id = `${key}@${windowStart}`
      /* 事务内读-改-写：并发下不会丢计数，也不会出现 add 成功但 _id 不一致的脏数据 */
      return await db.runTransaction(async (tx) => {
        const ref = tx.collection('counters').doc(id)
        let row = null
        try {
          const res = await ref.get()
          row = res && res.data ? res.data : null
        } catch (err) {
          if (!isNotExist(err)) throw err
        }
        if (!row) {
          /* 回滚（负数）时若计数记录不存在，视为 0，不凭空造一条 */
          if (step <= 0) return 0
          await ref.set({ data: { id, key: String(key), windowStart: Number(windowStart), count: step } })
          return step
        }
        const next = Math.max(0, Number(row.count || 0) + step)
        await ref.update({ data: { count: next } })
        return next
      })
    }
  }
}

/** 云函数侧只读安全兜底：禁止把密钥 / 密文写进日志 */
function safeLog(values) {
  return JSON.stringify(values, (key, value) => {
    if (/(cipher|password|secret|token|otp|sig|key)/i.test(key)) return '[redacted]'
    return value
  })
}

module.exports = { createCloudRepo, safeLog }
