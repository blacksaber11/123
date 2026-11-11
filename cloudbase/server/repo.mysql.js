'use strict'

/**
 * 生产环境 MySQL 仓储实现（与 shared/repo.js 的内存 / 云数据库实现保持同一接口）。
 *
 * 表结构：
 *   docs(collection, id, data JSON)   —— 所有业务集合统一落一张文档表
 *   counters(id, key_name, window_start, count_value) —— 限流 / 统计计数
 *
 * 说明：
 *   1) 业务查询字段大多不是索引列，条件用 JSON_EXTRACT 下推，
 *      写入用事务 + SELECT ... FOR UPDATE 串行化，保证唯一约束 / CAS 语义；
 *   2) 数据量级是平台型业务（万级文档），全表按 collection 过滤可接受；
 *   3) 不引入 ORM，保持与云开发实现同样的行为口径。
 */

const mysql = require('mysql2/promise')
const { AppError, CODES } = require('../shared/errors')
const { COLLECTIONS, UNIQUE_INDEXES } = require('../shared/repo')

const FIELD_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/

function jsonPath(field) {
  const name = String(field || '')
  if (!FIELD_RE.test(name)) throw new AppError(CODES.INTERNAL, '查询字段非法')
  return '$.' + name
}

function isConditionObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

/** 把仓储层 query 编译成 SQL 条件；参数顺序与占位符严格一致 */
function buildWhere(query) {
  const clauses = []
  const params = []
  const q = query || {}
  for (const key of Object.keys(q)) {
    const cond = q[key]
    const path = jsonPath(key)
    const raw = 'JSON_EXTRACT(data, ?)'

    if (!isConditionObject(cond)) {
      /* JSON_UNQUOTE 后与参数比较：数字参数走数值比较，字符串走字符比较 */
      clauses.push('JSON_UNQUOTE(' + raw + ') = ?')
      params.push(path, typeof cond === 'boolean' ? String(cond) : cond)
      continue
    }

    if ('$in' in cond) {
      const list = Array.isArray(cond.$in) ? cond.$in : []
      if (!list.length) {
        clauses.push('1 = 0')
      } else {
        clauses.push('JSON_UNQUOTE(' + raw + ') IN (' + list.map(() => '?').join(', ') + ')')
        params.push(path, ...list.map((v) => (typeof v === 'boolean' ? String(v) : v)))
      }
    }
    if ('$ne' in cond) {
      clauses.push('(' + raw + ' IS NULL OR JSON_UNQUOTE(' + raw + ') <> ?)')
      params.push(path, path, typeof cond.$ne === 'boolean' ? String(cond.$ne) : cond.$ne)
    }
    if ('$gte' in cond) {
      clauses.push('JSON_UNQUOTE(' + raw + ') >= ?')
      params.push(path, cond.$gte)
    }
    if ('$lt' in cond) {
      clauses.push('JSON_UNQUOTE(' + raw + ') < ?')
      params.push(path, cond.$lt)
    }
    if ('$exists' in cond) {
      clauses.push(cond.$exists ? raw + ' IS NOT NULL' : raw + ' IS NULL')
      params.push(path)
    }
    if ('$regex' in cond) {
      const flags = /i/i.test(String(cond.$options || '')) ? '(?i)' : ''
      clauses.push('JSON_UNQUOTE(' + raw + ') REGEXP ?')
      params.push(path, flags + String(cond.$regex))
    }
  }
  return {
    /* 外层 SQL 统一以 WHERE collection = ? 开头，这里只拼 AND 子句 */
    sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '',
    params
  }
}

function buildOrder(sort) {
  if (!sort) return { sql: '', params: [] }
  const specs = Array.isArray(sort) ? sort : [sort]
  const parts = []
  const params = []
  for (const spec of specs) {
    const field = typeof spec === 'string' ? spec : spec.field
    const desc = typeof spec === 'object' && spec.dir === 'desc'
    const path = jsonPath(field)
    /* 缺失字段排最后，和内存实现的 undefined / null 排序口径一致 */
    parts.push('(JSON_EXTRACT(data, ?) IS NULL) ASC')
    params.push(path)
    parts.push('JSON_EXTRACT(data, ?) ' + (desc ? 'DESC' : 'ASC'))
    params.push(path)
  }
  parts.push('id ASC')
  return { sql: ' ORDER BY ' + parts.join(', '), params }
}

function parseRow(row) {
  if (!row) return null
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  return data && typeof data === 'object' ? data : null
}

function isDuplicateError(err) {
  return !!err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)
}

/** 连接串 → mysql2 配置；密码里的特殊字符交给 URL 解码处理 */
function parseUrl(raw) {
  const url = new URL(String(raw))
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, ''))
  }
}

function createMysqlRepo(options) {
  const opts = options || {}
  const base = Object.assign(
    {
      waitForConnections: true,
      connectionLimit: Number(opts.connectionLimit || 10),
      charset: 'utf8mb4',
      timezone: 'Z',
      supportBigNumbers: true
    },
    opts.url ? parseUrl(opts.url) : opts.config || {}
  )
  const pool = opts.pool || mysql.createPool(base)

  async function withTx(fn) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const out = await fn(conn)
      await conn.commit()
      return out
    } catch (err) {
      try {
        await conn.rollback()
      } catch (rollbackErr) {
        /* 回滚失败不覆盖原始错误 */
      }
      throw err
    } finally {
      conn.release()
    }
  }

  async function findWith(conn, collection, query, opts2) {
    const o = opts2 || {}
    const where = buildWhere(query)
    const order = buildOrder(o.sort)
    let sql = 'SELECT data FROM docs WHERE collection = ?' + where.sql + order.sql
    const params = [collection, ...where.params, ...order.params]
    const limit = Number.isFinite(o.limit) ? Math.max(0, Math.min(100000, Math.floor(o.limit))) : 0
    const skip = Number.isFinite(o.skip) ? Math.max(0, Math.floor(o.skip)) : 0
    if (limit) {
      sql += ' LIMIT ? OFFSET ?'
      params.push(limit, skip)
    } else if (skip) {
      sql += ' LIMIT 18446744073709551615 OFFSET ?'
      params.push(skip)
    }
    const [rows] = await conn.query(sql, params)
    return rows.map(parseRow).filter(Boolean)
  }

  /** 唯一约束校验（事务内执行）；doc 为即将写入的完整文档 */
  async function assertNoDuplicate(conn, collection, doc, excludeId) {
    const specs = UNIQUE_INDEXES[collection] || []
    for (const fields of specs) {
      if (fields.length === 1 && doc[fields[0]] === undefined) continue
      const query = {}
      let usable = true
      for (const f of fields) {
        if (doc[f] === undefined) {
          usable = false
          break
        }
        query[f] = doc[f]
      }
      if (!usable) continue
      const rows = await findWith(conn, collection, query, { limit: 2 })
      if (rows.some((row) => row.id !== excludeId)) {
        throw new AppError(CODES.CONFLICT, '记录已存在')
      }
    }
    if (collection === 'leads' && (doc.status === '已对接' || doc.status === '已成交')) {
      for (const key of ['productId', 'demandId']) {
        if (!doc[key]) continue
        const rows = await findWith(conn, collection, {
          [key]: doc[key],
          status: { $regex: '^(已对接|已成交)$' }
        }, { limit: 2 })
        if (rows.some((row) => row.id !== excludeId)) {
          throw new AppError(CODES.CONFLICT, '该对象已有占用中的线索')
        }
      }
    }
  }

  return {
    async initSchema() {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS docs (' +
        ' collection VARCHAR(64) NOT NULL,' +
        ' id VARCHAR(191) NOT NULL,' +
        ' data JSON NOT NULL,' +
        ' updated_at BIGINT NOT NULL DEFAULT 0,' +
        ' PRIMARY KEY (collection, id),' +
        ' KEY idx_collection (collection)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'
      )
      await pool.query(
        'CREATE TABLE IF NOT EXISTS counters (' +
        ' id VARCHAR(191) NOT NULL PRIMARY KEY,' +
        ' key_name VARCHAR(191) NOT NULL,' +
        ' window_start BIGINT NOT NULL,' +
        ' count_value BIGINT NOT NULL DEFAULT 0' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'
      )
    },

    async ping() {
      await pool.query('SELECT 1')
      return true
    },

    async get(collection, id) {
      if (!COLLECTIONS.includes(collection)) throw new AppError(CODES.INTERNAL, '未知集合')
      if (!id) return null
      const [rows] = await pool.query(
        'SELECT data FROM docs WHERE collection = ? AND id = ? LIMIT 1',
        [collection, String(id)]
      )
      if (rows.length) return parseRow(rows[0])
      /* 兼容历史数据：早期写入没有把业务 id 放到主键上 */
      const [legacy] = await pool.query(
        'SELECT data FROM docs WHERE collection = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, ?)) = ? LIMIT 1',
        [collection, jsonPath('id'), String(id)]
      )
      return legacy.length ? parseRow(legacy[0]) : null
    },

    async find(collection, query, opts2) {
      if (!COLLECTIONS.includes(collection)) throw new AppError(CODES.INTERNAL, '未知集合')
      return findWith(pool, collection, query, opts2)
    },

    async count(collection, query) {
      if (!COLLECTIONS.includes(collection)) throw new AppError(CODES.INTERNAL, '未知集合')
      const where = buildWhere(query)
      const [rows] = await pool.query(
        'SELECT COUNT(*) AS total FROM docs WHERE collection = ?' + where.sql,
        [collection, ...where.params]
      )
      return Number((rows[0] && rows[0].total) || 0)
    },

    async insert(collection, doc) {
      if (!COLLECTIONS.includes(collection)) throw new AppError(CODES.INTERNAL, '未知集合')
      if (!doc || !doc.id) throw new AppError(CODES.VALIDATION, '记录缺少 id')
      try {
        await withTx(async (conn) => {
          await assertNoDuplicate(conn, collection, doc, doc.id)
          await conn.query(
            'INSERT INTO docs (collection, id, data, updated_at) VALUES (?, ?, ?, ?)',
            [collection, String(doc.id), JSON.stringify(doc), Date.now()]
          )
        })
      } catch (err) {
        if (isDuplicateError(err)) throw new AppError(CODES.CONFLICT, '记录已存在')
        throw err
      }
      return doc
    },

    async updateWhere(collection, query, patch) {
      if (!COLLECTIONS.includes(collection)) throw new AppError(CODES.INTERNAL, '未知集合')
      if (collection === 'audit') throw new AppError(CODES.FORBIDDEN, '审计日志不可修改')
      if (!query || !Object.keys(query).length) {
        throw new AppError(CODES.INTERNAL, '更新条件不能为空')
      }
      if (!patch || !Object.keys(patch).length) return { count: 0 }
      return withTx(async (conn) => {
        const where = buildWhere(query)
        /* FOR UPDATE 锁住命中行，等价于比较并交换 */
        const [rows] = await conn.query(
          'SELECT id, data FROM docs WHERE collection = ?' + where.sql + ' FOR UPDATE',
          [collection, ...where.params]
        )
        if (!rows.length) return { count: 0 }
        const merged = rows.map((row) => ({
          id: row.id,
          next: Object.assign({}, parseRow(row), patch)
        }))
        for (const item of merged) {
          await assertNoDuplicate(conn, collection, item.next, item.id)
        }
        for (const item of merged) {
          await conn.query(
            'UPDATE docs SET data = ?, updated_at = ? WHERE collection = ? AND id = ?',
            [JSON.stringify(item.next), Date.now(), collection, item.id]
          )
        }
        return { count: merged.length }
      })
    },

    async removeWhere(collection, query, limit) {
      if (!COLLECTIONS.includes(collection)) throw new AppError(CODES.INTERNAL, '未知集合')
      if (collection === 'audit') throw new AppError(CODES.FORBIDDEN, '审计日志不可删除')
      if (!query || !Object.keys(query).length) {
        throw new AppError(CODES.INTERNAL, '删除条件不能为空')
      }
      const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 100
      return withTx(async (conn) => {
        const where = buildWhere(query)
        const [rows] = await conn.query(
          'SELECT id FROM docs WHERE collection = ?' + where.sql + ' LIMIT ? FOR UPDATE',
          [collection, ...where.params, max]
        )
        if (!rows.length) return { count: 0 }
        const ids = rows.map((row) => row.id)
        await conn.query(
          'DELETE FROM docs WHERE collection = ? AND id IN (' + ids.map(() => '?').join(', ') + ')',
          [collection, ...ids]
        )
        return { count: ids.length }
      })
    },

    async incrCounter(key, windowStart, delta) {
      const step = Number.isFinite(delta) ? Math.floor(delta) : 1
      const id = `${key}@${windowStart}`
      if (step > 0) {
        /* 单行原子自增：原「SELECT ... FOR UPDATE 后 INSERT」在并发首帧会互相等锁死锁，
           改为 upsert 后不再需要事务，也少一次往返 */
        await pool.query(
          'INSERT INTO counters (id, key_name, window_start, count_value) VALUES (?, ?, ?, ?) ' +
          'ON DUPLICATE KEY UPDATE count_value = count_value + VALUES(count_value)',
          [id, String(key), Number(windowStart), step]
        )
      }
      const [rows] = await pool.query('SELECT count_value FROM counters WHERE id = ?', [id])
      return rows.length ? Number(rows[0].count_value || 0) : 0
    },

    async close() {
      await pool.end()
    }
  }
}

module.exports = { createMysqlRepo }
