'use strict'

/**
 * 多级缓存：L1 进程内 LRU + TTL，L2 Redis（可选）。
 *
 * 设计口径：
 *   1) L1 永远可用，Redis 只是加速层；Redis 未配置 / 依赖缺失 / 连接失败
 *      时自动降级为纯 L1，任何缓存故障都不向业务抛错。
 *   2) Redis 连续失败 3 次后熔断 30 秒，期间所有 L2 操作直接跳过，
 *      避免每个请求都卡在超时上。
 *   3) key 规范：`{ns}:{scope}:{group}:v{version}:{suffix}`
 *      版本号同时存 L1 与 Redis，写操作 bump 后旧 key 自然失效，
 *      不需要逐个删除具体 key。
 *
 * 环境变量（云函数与本地 dev server 共用）：
 *   REDIS_URL     Redis 连接串，例如 redis://127.0.0.1:6379；不配置则只用 L1
 *   CACHE_NS      缓存命名空间前缀，默认 suanli，用于多环境 / 多项目隔离
 *   CACHE_L1_MAX  L1 最大条目数，默认 256，超出按 LRU 淘汰
 */

const DEFAULT_L1_MAX = 256
const DEFAULT_NS = 'suanli'
const DEFAULT_TTL_SEC = 60
const VERSION_TTL_MS = 3000
const FAILURE_THRESHOLD = 3
const BREAKER_MS = 30 * 1000

function clone(value) {
  if (value === undefined) return undefined
  try {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value))
  } catch (err) {
    return value
  }
}

function toPositiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** 解析 redis://[:password@]host:port/db */
function parseRedisUrl(url) {
  try {
    const u = new URL(String(url))
    return {
      host: u.hostname || '127.0.0.1',
      port: Number(u.port) || 6379,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      db: Number(String(u.pathname || '').replace(/^\//, '')) || 0
    }
  } catch (err) {
    return null
  }
}

/**
 * 内置极简 Redis 客户端（RESP2）：生产环境没有安装 ioredis 时也能用 L2 缓存。
 * 只实现缓存层用到的 GET / SET EX / DEL / SCAN / INCR，连接失败自动熔断重连。
 */
function createMiniRedis(url) {
  const net = require('node:net')
  const cfg = parseRedisUrl(url)
  if (!cfg) throw new Error('REDIS_URL 格式不正确')
  let socket = null
  let connecting = null
  let handshaked = false
  let reconnectAt = 0
  let buffer = Buffer.alloc(0)
  let inflight = []

  function encode(args) {
    const parts = [Buffer.from('*' + args.length + '\r\n')]
    for (const arg of args) {
      const body = Buffer.from(String(arg))
      parts.push(Buffer.from('$' + body.length + '\r\n'), body, Buffer.from('\r\n'))
    }
    return Buffer.concat(parts)
  }

  function parse(buf) {
    if (!buf || !buf.length) return null
    const type = buf[0]
    const nl = buf.indexOf('\r\n')
    if (nl < 0) return null
    const line = buf.subarray(1, nl).toString()
    const rest = buf.subarray(nl + 2)
    if (type === 43) return { value: line, rest }
    if (type === 45) return { error: new Error(line), rest }
    if (type === 58) return { value: Number(line), rest }
    if (type === 36) {
      const len = Number(line)
      if (len === -1) return { value: null, rest }
      if (rest.length < len + 2) return null
      return { value: rest.subarray(0, len).toString(), rest: rest.subarray(len + 2) }
    }
    if (type === 42) {
      const count = Number(line)
      if (count === -1) return { value: null, rest }
      let cur = rest
      const arr = []
      for (let i = 0; i < count; i += 1) {
        const item = parse(cur)
        if (!item) return null
        if (item.error) return item
        arr.push(item.value)
        cur = item.rest
      }
      return { value: arr, rest: cur }
    }
    return { error: new Error('Redis 协议解析失败'), rest }
  }

  function connect() {
    if (socket && !socket.destroyed) return Promise.resolve()
    if (connecting) return connecting
    connecting = new Promise((resolve, reject) => {
      const s = net.connect({ host: cfg.host, port: cfg.port })
      if (typeof s.setNoDelay === 'function') s.setNoDelay(true)
      /* 不阻止进程退出 */
      if (typeof s.unref === 'function') s.unref()
      const timer = setTimeout(() => {
        s.destroy()
        reject(new Error('Redis 连接超时'))
      }, 800)
      s.once('connect', () => {
        clearTimeout(timer)
        socket = s
        connecting = null
        resolve()
      })
      s.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const item = parse(buffer)
          if (!item) break
          buffer = item.rest
          const waiter = inflight.shift()
          if (!waiter) continue
          clearTimeout(waiter.timer)
          if (item.error) waiter.reject(item.error)
          else waiter.resolve(item.value)
        }
      })
      s.on('error', () => {})
      s.on('close', () => {
        socket = null
        connecting = null
        handshaked = false
        buffer = Buffer.alloc(0)
        const waiters = inflight
        inflight = []
        waiters.forEach((w) => {
          clearTimeout(w.timer)
          w.reject(new Error('Redis 连接已关闭'))
        })
        reconnectAt = Date.now() + 3000
      })
    }).catch((err) => {
      connecting = null
      throw err
    })
    return connecting
  }

  function send(args) {
    return new Promise((resolve, reject) => {
      const s = socket
      if (!s || s.destroyed) {
        reject(new Error('Redis 未连接'))
        return
      }
      const timer = setTimeout(() => {
        const idx = inflight.findIndex((w) => w.timer === timer)
        if (idx >= 0) inflight.splice(idx, 1)
        try { s.destroy() } catch (err) { /* ignore */ }
        reject(new Error('Redis 请求超时'))
      }, 1200)
      inflight.push({ resolve, reject, timer })
      try {
        s.write(encode(args))
      } catch (err) {
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  async function command(args) {
    if (Date.now() < reconnectAt) throw new Error('Redis 重连冷却中')
    await connect()
    if (!handshaked) {
      handshaked = true
      if (cfg.password) await send(['AUTH', cfg.username || 'default', cfg.password])
      if (cfg.db) await send(['SELECT', cfg.db])
    }
    return send(args)
  }

  return {
    driver: 'builtin',
    get: (key) => command(['GET', key]),
    set: (key, value, ...rest) => command(['SET', key, value, ...rest]),
    del: (...keys) => command(['DEL', ...(Array.isArray(keys[0]) ? keys[0] : keys)]),
    scan: (...args) => command(['SCAN', ...args]),
    incr: (key) => command(['INCR', key]),
    on: () => {},
    quit: () => {
      try { if (socket) socket.end() } catch (err) { /* ignore */ }
    }
  }
}

function createCache(options) {
  const opts = options || {}
  const env = opts.env || (typeof process !== 'undefined' ? process.env : {}) || {}
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()

  const namespace = String(env.CACHE_NS || DEFAULT_NS).trim() || DEFAULT_NS
  const l1Max = toPositiveInt(env.CACHE_L1_MAX, DEFAULT_L1_MAX)

  /* ---------- L1：Map 插入顺序即访问顺序，命中后重新插入实现 LRU ---------- */
  const l1 = new Map()
  const versions = new Map()
  const pending = new Map()
  let hits = 0
  let misses = 0

  function l1Get(key) {
    const row = l1.get(key)
    if (!row) return { found: false }
    if (row.exp <= now()) {
      l1.delete(key)
      return { found: false }
    }
    /* 重新插入到队尾：最近使用 */
    l1.delete(key)
    l1.set(key, row)
    return { found: true, value: clone(row.value) }
  }

  function l1Set(key, value, ttlSec) {
    const ttl = Number(ttlSec) > 0 ? Number(ttlSec) : DEFAULT_TTL_SEC
    if (l1.has(key)) l1.delete(key)
    l1.set(key, { value: clone(value), exp: now() + ttl * 1000 })
    while (l1.size > l1Max) {
      const oldest = l1.keys().next()
      if (oldest.done) break
      l1.delete(oldest.value)
    }
  }

  function l1DropByPrefix(prefix) {
    const p = String(prefix || '')
    if (!p) return 0
    let count = 0
    for (const key of Array.from(l1.keys())) {
      if (key.indexOf(p) === 0) {
        l1.delete(key)
        count += 1
      }
    }
    return count
  }

  /* ---------- L2：Redis（可选，懒加载，失败静默降级） ---------- */
  let redisClient = opts.redis || null
  let redisTried = false
  let redisDisabled = false
  let failures = 0
  let openUntil = 0
  let l2Hits = 0
  let l2Misses = 0

  function redisReady() {
    if (redisDisabled) return null
    if (redisClient) return redisClient
    if (redisTried) return null
    redisTried = true
    const url = String(env.REDIS_URL || '').trim()
    if (!url) {
      redisDisabled = true
      return null
    }
    try {
      /* 依赖按需加载：未安装 ioredis 时只降级，不影响云函数冷启动 */
      const Redis = require('ioredis')
      redisClient = new Redis(url, {
        connectTimeout: 800,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false
      })
      /* 必须挂 error 监听，否则连接失败会触发 unhandled error 事件 */
      if (typeof redisClient.on === 'function') redisClient.on('error', () => {})
      return redisClient
    } catch (err) {
      /* 没装 ioredis（ECS 直连部署常见）：用内置 RESP 客户端兜底，同样支持 GET/SET/DEL/SCAN/INCR */
      try {
        redisClient = createMiniRedis(url)
        return redisClient
      } catch (miniErr) {
        redisDisabled = true
        return null
      }
    }
  }

  function breakerOpen() {
    return openUntil > now()
  }

  function markFailure() {
    failures += 1
    if (failures >= FAILURE_THRESHOLD) {
      openUntil = now() + BREAKER_MS
      failures = 0
    }
  }

  function markSuccess() {
    failures = 0
  }

  async function l2Get(key) {
    const client = redisReady()
    if (!client || breakerOpen()) return { found: false }
    try {
      const raw = await client.get(key)
      markSuccess()
      if (raw === null || raw === undefined) {
        l2Misses += 1
        return { found: false }
      }
      l2Hits += 1
      try {
        return { found: true, value: JSON.parse(raw) }
      } catch (err) {
        return { found: false }
      }
    } catch (err) {
      markFailure()
      return { found: false }
    }
  }

  async function l2Set(key, value, ttlSec) {
    const client = redisReady()
    if (!client || breakerOpen()) return false
    try {
      const ttl = Number(ttlSec) > 0 ? Math.ceil(Number(ttlSec)) : DEFAULT_TTL_SEC
      await client.set(key, JSON.stringify(value), 'EX', ttl)
      markSuccess()
      return true
    } catch (err) {
      markFailure()
      return false
    }
  }

  async function l2Del(key) {
    const client = redisReady()
    if (!client || breakerOpen()) return false
    try {
      await client.del(key)
      markSuccess()
      return true
    } catch (err) {
      markFailure()
      return false
    }
  }

  async function l2DropByPrefix(prefix) {
    const client = redisReady()
    if (!client || breakerOpen()) return 0
    try {
      let cursor = '0'
      let removed = 0
      do {
        const reply = await client.scan(cursor, 'MATCH', String(prefix) + '*', 'COUNT', 200)
        cursor = Array.isArray(reply) ? reply[0] : '0'
        const keys = Array.isArray(reply) && Array.isArray(reply[1]) ? reply[1] : []
        if (keys.length) {
          await client.del.apply(client, keys)
          removed += keys.length
        }
      } while (cursor !== '0')
      markSuccess()
      return removed
    } catch (err) {
      markFailure()
      return 0
    }
  }

  async function read(key) {
    const local = l1Get(key)
    if (local.found) return local
    const remote = await l2Get(key)
    if (remote.found) {
      /* 回填 L1 只做短驻留：跨进程 bump 版本后旧数据能尽快自然淘汰 */
      l1Set(key, remote.value, 5)
      return remote
    }
    return { found: false }
  }

  async function get(key) {
    try {
      if (!key) return null
      const result = await read(String(key))
      if (result.found) {
        hits += 1
        return result.value
      }
      misses += 1
      return null
    } catch (err) {
      return null
    }
  }

  async function set(key, value, ttlSec) {
    try {
      if (!key || value === undefined) return false
      const ttl = Number(ttlSec) > 0 ? Number(ttlSec) : DEFAULT_TTL_SEC
      l1Set(String(key), value, ttl)
      await l2Set(String(key), value, ttl)
      return true
    } catch (err) {
      return false
    }
  }

  async function del(key) {
    try {
      if (!key) return false
      l1.delete(String(key))
      await l2Del(String(key))
      return true
    } catch (err) {
      return false
    }
  }

  async function delByPrefix(prefix) {
    try {
      if (!prefix) return 0
      const localCount = l1DropByPrefix(String(prefix))
      const remoteCount = await l2DropByPrefix(String(prefix))
      return localCount + remoteCount
    } catch (err) {
      return 0
    }
  }

  function versionKey(group) {
    return `${namespace}:ver:${String(group)}`
  }

  async function version(group) {
    try {
      const name = String(group || '')
      if (!name) return 0
      const cached = versions.get(name)
      if (cached && cached.exp > now()) return cached.value
      const remote = await l2Get(versionKey(name))
      const value = remote.found ? (Number(remote.value) || 0) : (cached ? cached.value : 0)
      versions.set(name, { value, exp: now() + VERSION_TTL_MS })
      return value
    } catch (err) {
      return 0
    }
  }

  async function bump(group) {
    try {
      const name = String(group || '')
      if (!name) return 0
      const current = versions.has(name)
        ? versions.get(name).value
        : await version(name)
      const next = Number(current) + 1
      versions.set(name, { value: next, exp: now() + VERSION_TTL_MS })
      const client = redisReady()
      if (client && !breakerOpen()) {
        try {
          const remote = await client.incr(versionKey(name))
          markSuccess()
          /* 以 Redis 为准，避免多进程 bump 时本进程版本落后 */
          const aligned = Number(remote) || next
          versions.set(name, { value: aligned, exp: now() + VERSION_TTL_MS })
          return aligned
        } catch (err) {
          markFailure()
        }
      }
      return next
    } catch (err) {
      return 0
    }
  }

  /**
   * 缓存穿透保护：同一 key 并发未命中时只执行一次 loader。
   * 合并等待的请求按命中计数（它们没有打到业务层）。
   * 注意：loader 自身的异常必须原样抛出，不能吞掉后重试。
   * @param {Function} [shouldCache] 返回 false 时不落缓存（用于拦截含明文手机号等敏感数据的结果）
   */
  async function wrap(key, ttlSec, loader, shouldCache) {
    const name = String(key || '')
    if (!name) return loader()
    let cached = { found: false }
    try {
      cached = await read(name)
    } catch (err) {
      /* 缓存读失败按未命中处理，业务继续 */
      cached = { found: false }
    }
    if (cached.found) {
      hits += 1
      return cached.value
    }
    if (pending.has(name)) {
      hits += 1
      return await pending.get(name)
    }
    misses += 1
    const task = (async () => {
      try {
        const value = await loader()
        if (value !== undefined && (!shouldCache || shouldCache(value))) {
          try {
            await set(name, value, ttlSec)
          } catch (err) { /* 缓存写入失败不影响业务 */ }
        }
        return value
      } finally {
        pending.delete(name)
      }
    })()
    pending.set(name, task)
    return await task
  }

  /**
   * 拼装带版本号的业务 key。
   * @param {string} scope  user / admin
   * @param {string} group  缓存分组，例如 products
   * @param {string} suffix 业务后缀（身份 + 入参哈希）
   */
  async function keyOf(scope, group, suffix) {
    const v = await version(group)
    return `${namespace}:${String(scope)}:${String(group)}:v${v}:${String(suffix)}`
  }

  function stats() {
    const total = hits + misses
    return {
      hits,
      misses,
      hitRate: total > 0 ? hits / total : 0,
      l1: { size: l1.size, max: l1Max },
      l2: {
        enabled: !redisDisabled && (!!redisClient || !!env.REDIS_URL),
        ready: !!redisClient,
        breakerOpen: breakerOpen(),
        failures,
        hits: l2Hits,
        misses: l2Misses,
        driver: redisClient ? (redisClient.driver || 'ioredis') : (redisDisabled ? 'disabled' : 'none')
      }
    }
  }

  return {
    namespace,
    get,
    set,
    del,
    delByPrefix,
    version,
    bump,
    wrap,
    keyOf,
    stats
  }
}

module.exports = { createCache }
