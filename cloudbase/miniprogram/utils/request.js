/**
 * 业务请求封装。
 *
 * 两种运行模式：
 * 1) 线上 / 本地联调：app.globalData.apiBase（或 devApiBase）非空时走 HTTPS 接口，
 *    用户登录由 wx.login(code) → 服务端 code2session 换 openid，并下发 HMAC 令牌；
 * 2) 未配置接口地址时回退 wx.cloud.callFunction（云开发模式）。
 *
 * 统一返回 { ok, code, data, message }，业务层只看 ok。
 */

const CODE = {
  OK: 'OK',
  VALIDATION: 'VALIDATION',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  EXPIRED: 'EXPIRED',
  TAMPERED: 'TAMPERED',
  INTERNAL: 'INTERNAL'
}

/** 需要重新登录的错误码 */
const NEED_LOGIN = [CODE.UNAUTHENTICATED]

/** 单次云函数调用的兜底超时：超时按网络异常处理，避免按钮永久 loading */
const TIMEOUT_MS = 15000

/** 把 wx 的原始错误折叠成一句话，不向前端暴露内部细节 */
function failMessage(err) {
  const msg = String((err && (err.errMsg || err.message)) || '')
  if (/timeout|超时/i.test(msg)) return '请求超时，请检查网络后重试'
  if (/FunctionName|FUNCTION_NOT_FOUND|not found/i.test(msg)) return '服务尚未部署，请稍后重试'
  return '网络异常，请稍后重试'
}

/** 登录令牌缓存键：HTTP 模式下服务端签发，30 天有效 */
const TOKEN_KEY = 'suanli_token_v1'

/**
 * HTTP 接口地址：app.globalData.apiBase 优先（线上 HTTPS），
 * devApiBase 保留给本地联调（cloudbase/scripts/admin-dev-server.mjs）。
 */
function httpConfig() {
  try {
    const app = getApp()
    const g = (app && app.globalData) || {}
    const base = String(g.apiBase || g.devApiBase || '').trim().replace(/\/+$/, '')
    if (!base) return null
    const local = /\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base)
    return { base, local, devOpenid: local ? String(g.devOpenid || 'o_demo_user_1') : '' }
  } catch (err) {
    return null
  }
}

function readToken() {
  try {
    return String(wx.getStorageSync(TOKEN_KEY) || '')
  } catch (err) {
    return ''
  }
}

function writeToken(token) {
  try {
    if (token) wx.setStorageSync(TOKEN_KEY, token)
    else wx.removeStorageSync(TOKEN_KEY)
  } catch (err) {
    /* 本地缓存失败不阻断本次请求 */
  }
}

/** 令牌失效时同时清掉登录态缓存，避免带着旧用户信息反复撞接口 */
function clearSession() {
  writeToken('')
  try {
    wx.removeStorageSync('suanli_user_auth_v1')
  } catch (err) {
    /* no-op */
  }
}

/** 统一 POST：成功解包 data，失败按 {code,message} 抛错 */
function httpPost(conf, pathname, payload, finish, resolve, reject) {
  const headers = { 'Content-Type': 'application/json' }
  if (payload && payload.token) headers.Authorization = 'Bearer ' + payload.token
  try {
    wx.request({
      url: conf.base + pathname,
      method: 'POST',
      header: headers,
      data: payload || {},
      success: (res) => {
        const body = (res && res.data) || {}
        if (body && body.ok) {
          finish(resolve, body.data)
          return
        }
        if (body && body.code === CODE.UNAUTHENTICATED) clearSession()
        finish(reject, {
          code: (body && body.code) || CODE.INTERNAL,
          message: (body && body.message) || '服务暂时不可用'
        })
      },
      fail: (err) => {
        finish(reject, { code: CODE.INTERNAL, message: failMessage(err) })
      }
    })
  } catch (err) {
    finish(reject, { code: CODE.INTERNAL, message: failMessage(err) })
  }
}

/** 登录：wx.login 拿 code → 服务端换 openid 并签发令牌 */
function loginHttp(conf, data, finish, resolve, reject) {
  try {
    wx.login({
      success: (login) => {
        if (!login || !login.code) {
          finish(reject, { code: CODE.UNAUTHENTICATED, message: '微信登录失败，请重试' })
          return
        }
        httpPost(conf, '/auth/login', {
          code: login.code,
          nick: (data && data.nick) || '',
          avatar: (data && data.avatar) || '',
          devOpenid: conf.devOpenid
        }, (fn, payload) => {
          if (fn === resolve && payload && payload.token) {
            writeToken(payload.token)
            finish(resolve, payload.user)
            return
          }
          finish(fn, payload)
        }, resolve, reject)
      },
      fail: (err) => {
        finish(reject, { code: CODE.UNAUTHENTICATED, message: failMessage(err) })
      }
    })
  } catch (err) {
    finish(reject, { code: CODE.INTERNAL, message: failMessage(err) })
  }
}

/** HTTP 模式：POST {action,data,token}，生产环境令牌走 Authorization 头 */
function httpCall(conf, scope, action, data, extra, finish, resolve, reject) {
  if (scope === 'user' && action === 'auth.login') {
    loginHttp(conf, data, finish, resolve, reject)
    return
  }
  const payload = {
    action,
    data: data || {},
    token: (extra && extra.token) || readToken()
  }
  if (conf.local) payload.openid = conf.devOpenid
  httpPost(conf, scope === 'admin' ? '/admin' : '/user', payload, finish, resolve, reject)
}

/**
 * 上传资质原件：HTTP 模式走服务端 /api/upload，未配置接口地址时回退云存储。
 * 返回可直接展示的 https 地址（或云存储 fileID）。
 */
function uploadFile(filePath, options) {
  const opts = options || {}
  const cloudPath = String(opts.cloudPath || ('quals/' + Date.now() + '.jpg'))
  const conf = httpConfig()
  if (!conf) {
    return new Promise((resolve, reject) => {
      if (!wx.cloud || !wx.cloud.uploadFile) {
        reject({ code: CODE.INTERNAL, message: '当前环境不支持上传原件' })
        return
      }
      wx.cloud.uploadFile({ cloudPath, filePath }).then((res) => {
        if (!res || !res.fileID) throw new Error('upload failed')
        resolve(res.fileID)
      }).catch(() => reject({ code: CODE.INTERNAL, message: '上传失败，请重试' }))
    })
  }
  return new Promise((resolve, reject) => {
    const token = readToken()
    const header = token ? { Authorization: 'Bearer ' + token } : {}
    /* 聊天媒体上传带 kind=chat：放宽到图片 10MB / 视频 50MB */
    const query = opts.kind ? '?kind=' + encodeURIComponent(String(opts.kind)) : ''
    try {
      wx.uploadFile({
        url: conf.base + '/upload' + query,
        filePath,
        name: 'file',
        header,
        success: (res) => {
          let body = {}
          try {
            body = JSON.parse((res && res.data) || '{}')
          } catch (err) {
            body = {}
          }
          if (body && body.ok && body.data && body.data.fileId) {
            resolve(body.data.fileId)
            return
          }
          if (body && body.code === CODE.UNAUTHENTICATED) clearSession()
          reject({
            code: (body && body.code) || CODE.INTERNAL,
            message: (body && body.message) || '上传失败，请重试'
          })
        },
        fail: (err) => reject({ code: CODE.INTERNAL, message: failMessage(err) })
      })
    } catch (err) {
      reject({ code: CODE.INTERNAL, message: failMessage(err) })
    }
  })
}

/**
 * 小程序码：服务端用 access_token 调 getwxacode 生成 PNG，返回 dataURL。
 * 只给分享海报使用；云开发模式没有该接口时返回空串，海报退回不带码的版本。
 */
function wxacode(path, width) {
  const conf = httpConfig()
  if (!conf) return Promise.resolve('')
  const target = String(path || '').replace(/^\/+/, '')
  if (!target) return Promise.resolve('')
  return new Promise((resolve) => {
    const token = readToken()
    const header = { 'Content-Type': 'application/json' }
    if (token) header.Authorization = 'Bearer ' + token
    try {
      wx.request({
        url: conf.base + '/wxacode',
        method: 'POST',
        header,
        data: { path: target, width: Number(width) || 280 },
        success: (res) => {
          const body = (res && res.data) || {}
          resolve((body && body.ok && body.data && body.data.image) || '')
        },
        fail: () => resolve('')
      })
    } catch (err) {
      resolve('')
    }
  })
}

/**
 * 调用云函数。
 * @param {string} scope 'user' | 'admin'
 * @param {string} action 接口名
 * @param {object} data 入参
 * @param {object} extra 额外上下文（admin 传 token）
 */
function call(scope, action, data, extra) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(payload)
    }

    const timer = setTimeout(() => {
      finish(reject, { code: CODE.INTERNAL, message: '请求超时，请检查网络后重试' })
    }, TIMEOUT_MS)

    const http = httpConfig()
    if (http) {
      httpCall(http, scope, action, data, extra, finish, resolve, reject)
      return
    }

    try {
      wx.cloud.callFunction({
        name: scope === 'admin' ? 'admin' : 'user',
        data: {
          action,
          data: data || {},
          token: (extra && extra.token) || ''
        },
        success: (res) => {
          const body = (res && res.result) || {}
          if (body && body.ok) {
            finish(resolve, body.data)
            return
          }
          finish(reject, {
            code: (body && body.code) || CODE.INTERNAL,
            message: (body && body.message) || '服务暂时不可用'
          })
        },
        fail: (err) => {
          finish(reject, { code: CODE.INTERNAL, message: failMessage(err) })
        }
      })
    } catch (err) {
      /* wx.cloud 未初始化或基础库异常，同样按网络异常处理，不让异常冒到页面 */
      finish(reject, { code: CODE.INTERNAL, message: failMessage(err) })
    }
  })
}

/**
 * 带统一错误处理的包装：失败自动 toast，需要登录时跳登录页。
 */
async function request(scope, action, data, options) {
  const opts = options || {}
  try {
    return await call(scope, action, data, opts)
  } catch (err) {
    const e = err || {}
    if (NEED_LOGIN.indexOf(e.code) >= 0) {
      gotoLogin()
    } else if (!opts.silent) {
      /* 资料未完善类拦截：弹窗引导去个人信息页补齐，避免只 toast 用户不知道去哪填 */
      if (String(e.message || '').indexOf('完善') >= 0) {
        wx.showModal({
          title: '资料未完善',
          content: e.message,
          confirmText: '去完善',
          success: (res) => {
            if (res.confirm) wx.navigateTo({ url: '/pages/profile/profile' })
          }
        })
      } else {
        wx.showToast({ title: e.message || '操作失败', icon: 'none', duration: 2200 })
      }
    }
    throw e
  }
}

/** 登录过期跳转：已在登录页就不再重复入栈，避免页面栈溢出 */
function gotoLogin() {
  try {
    const pages = getCurrentPages() || []
    const current = pages.length ? pages[pages.length - 1] : null
    if (current && current.route === 'pages/login/login') return
    const url = '/pages/login/login?from=' + encodeURIComponent(getCurrentPagesPath())
    if (pages.length > 0) {
      wx.redirectTo({ url })
    } else {
      wx.reLaunch({ url })
    }
  } catch (err) {
    /* 跳转失败不影响原始错误向上抛出 */
  }
}

/**
 * 登录回跳时允许携带的 query 白名单。
 * 只保留「定位到同一份内容」所需的参数，openid / 手机号 / 线索号一律不带走。
 */
const RETURN_KEYS = ['id', 'type', 'kind', 'from', 'tab', 'sub', 'threadId']

/** 拼安全 query：白名单外的参数直接丢弃 */
function safeQuery(options) {
  const o = options || {}
  const parts = []
  RETURN_KEYS.forEach((k) => {
    const v = o[k]
    if (v === undefined || v === null || v === '') return
    parts.push(k + '=' + encodeURIComponent(String(v)))
  })
  return parts.length ? '?' + parts.join('&') : ''
}

/** 页面路径 + 安全 query：登录回跳后仍能回到同一件商品 / 需求 */
function safePath(route, options) {
  const raw = String(route || 'pages/home/home').split('?')[0]
  return '/' + raw.replace(/^\//, '') + safeQuery(options)
}

function getCurrentPagesPath() {
  try {
    const pages = getCurrentPages() || []
    if (!pages.length) return '/pages/home/home'
    const page = pages[pages.length - 1] || {}
    /* 详情页 / 分享落地页的 id 必须带回，否则回跳后会落到默认演示数据 */
    return safePath(page.route, page.options)
  } catch (err) {
    return '/pages/home/home'
  }
}

/** 分页参数 */
function paging(page, limit) {
  return { page: page || 1, limit: limit || 10 }
}

/**
 * 微信虚拟支付下单：wx.login 取 code → 服务端校验 openid 并签名，
 * 返回可直接传给 wx.requestVirtualPayment 的参数。
 */
function xpayOrder(planKey) {
  return new Promise((resolve, reject) => {
    const conf = httpConfig()
    if (!conf) {
      reject({ code: CODE.INTERNAL, message: '当前环境不支持微信支付' })
      return
    }
    try {
      wx.login({
        success: (login) => {
          if (!login || !login.code) {
            reject({ code: CODE.UNAUTHENTICATED, message: '微信登录失败，请重试' })
            return
          }
          wx.request({
            url: conf.base + '/xpay/order',
            method: 'POST',
            header: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + readToken()
            },
            data: { code: login.code, planKey: planKey || 'month' },
            success: (res) => {
              const body = (res && res.data) || {}
              if (body && body.ok) {
                resolve(body.data)
                return
              }
              if (body && body.code === CODE.UNAUTHENTICATED) clearSession()
              reject({
                code: (body && body.code) || CODE.INTERNAL,
                message: (body && body.message) || '下单失败，请稍后重试'
              })
            },
            fail: (err) => reject({ code: CODE.INTERNAL, message: failMessage(err) })
          })
        },
        fail: (err) => reject({ code: CODE.UNAUTHENTICATED, message: failMessage(err) })
      })
    } catch (err) {
      reject({ code: CODE.INTERNAL, message: failMessage(err) })
    }
  })
}

module.exports = { call, request, paging, CODE, NEED_LOGIN, safePath, clearSession, uploadFile, xpayOrder, wxacode }
