/**
 * admin 云函数入口（微信云开发）。
 *
 * 管理端通过 token 鉴权（token 在 sessions 集合里，scrypt+SHA256），
 * 客服 / 管理员由 RBAC 控制能访问哪些动作。
 */

const cloud = require('wx-server-sdk')

const { createRouter } = require('./_shared/router')
const { createCloudRepo } = require('./_shared/repo.cloud')
const { createCache } = require('./_shared/cache')
const { loadKeys } = require('./_shared/crypto')

/**
 * 初始化失败（密钥缺失 / 数据库不可用）不能让模块加载直接抛错，
 * 否则对外只表现为「函数调用失败」这种不可诊断的 500。
 */
let router = null

try {
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  const keys = loadKeys({
    AES_KEY_B64: process.env.AES_KEY_B64,
    HMAC_KEY_B64: process.env.HMAC_KEY_B64
  })
  const repo = createCloudRepo(cloud)
  /* 多级缓存：未配置 REDIS_URL 时自动只用进程内 L1，不依赖 Redis */
  const cache = createCache({ env: process.env })
  router = createRouter({
    repo,
    keys,
    cache,
    scope: 'admin',
    env: process.env,
    cloud,
    now: () => Date.now()
  })
} catch (err) {
  router = null
}

exports.main = async (event) => {
  if (!router) {
    return {
      ok: false,
      code: 'INTERNAL',
      message: '服务未完成初始化（密钥或数据库配置缺失），请联系技术处理'
    }
  }
  const evt = event && typeof event === 'object' ? event : {}
  const action = typeof evt.action === 'string' ? evt.action : ''
  /* 入参非法（null / 数组 / 字符串）时按空对象处理，handler 侧统一走参数校验 */
  const data = evt.data && typeof evt.data === 'object' && !Array.isArray(evt.data) ? evt.data : {}
  const token = typeof evt.token === 'string' ? evt.token : ''
  let wxContext = {}
  try {
    wxContext = cloud.getWXContext() || {}
  } catch (err) {
    wxContext = {}
  }
  /* 只信任平台注入的 CLIENTIP；evt.__trace__ 由调用方传入，可伪造，不用于审计 */
  return router.dispatch(action, data, { token, ip: wxContext.CLIENTIP || '' })
}
