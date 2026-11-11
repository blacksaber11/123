/**
 * 小程序入口。
 *
 * 保密要点：
 * 1. 登录态只存在本地缓存，token 与 openid 不打印到 console；
 * 2. 截屏 / 录屏监测在 App.onShow 统一开启，检测到即遮蔽内容；
 * 3. 所有网络请求走 utils/request.js，云函数返回的敏感字段一律不落本地存储。
 */
const { ensureLogin, readUser, hasPhone } = require('./utils/auth')
const { startScreenGuard } = require('./utils/guard')
const { request } = require('./utils/request')
const { requestLocation } = require('./utils/location')

/* 底部 tab 路由：只有这些页面在栈底时，安卓物理返回才允许退出小程序 */
const TAB_ROUTES = ['pages/home/home', 'pages/msg/msg', 'pages/mine/mine']

/* 当前页面路由（不带前导 /），取不到时返回空串 */
function routeOf(page) {
  return String((page && page.route) || '').replace(/^\//, '')
}

/* 把页面的 options 还原成 query，过滤空值并剔除内部的补栈标记 */
function queryOf(options, extra) {
  const opts = options || {}
  const parts = Object.keys(opts)
    .filter((k) => k !== '__rootfix' && opts[k] !== undefined && opts[k] !== null && String(opts[k]) !== '')
    .map((k) => k + '=' + encodeURIComponent(String(opts[k])))
  if (extra) parts.push(extra)
  return parts.length ? '?' + parts.join('&') : ''
}

App({
  globalData: {
    /* 云环境 id：部署时改成自己的环境 */
    env: 'suanli-prod-1',
    /**
     * 线上接口地址：阿里云 HTTPS 服务。
     * 登录走 wx.login → 服务端 code2session 换 openid 并下发令牌，
     * 商品 / 需求 / 咨询等全部经此接口落库，运营中台实时可见。
     */
    apiBase: 'https://sljh.qining.xin/api',
    /**
     * 本地联调地址：留空时使用上面的线上地址；
     * 如需连本地 dev server（cloudbase/scripts/admin-dev-server.mjs），填 'http://127.0.0.1:8790/api'，
     * 并在开发者工具勾选「不校验合法域名」。
     */
    devApiBase: '',
    /**
     * 开发者工具自动接本地服务：默认关闭，保证开发者工具 / 体验版都直连线上接口。
     */
    localApiInDevtools: false,
    /* 联调时使用的固定用户（与 dev server 的演示数据对应） */
    devOpenid: 'o_demo_user_1',
    /* 登录态（仅内存 + 本地缓存，不含任何敏感明文） */
    user: null,
    profile: null,
    /* 底部导航「首页 / 货盘」共用首页，进入时指定落在哪个视图：sell / market */
    homeTab: '',
    /* 全局选项口径，由 meta.options 拉取，避免前后端枚举漂移 */
    options: null
  },

  onLaunch() {
    /* 开发者工具自动接本地服务：只在 develop（开发者工具 / 真机调试）生效 */
    if (!String(this.globalData.devApiBase || '').trim() && this.globalData.localApiInDevtools) {
      try {
        const info = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null
        const version = info && info.miniProgram ? info.miniProgram.envVersion : ''
        if (version === 'develop') {
          this.globalData.devApiBase = 'http://127.0.0.1:8790/api'
          console.info('[dev] 已切换到本地联调服务 http://127.0.0.1:8790/api')
        }
      } catch (err) { /* 取不到环境信息时保持走云函数 */ }
    }
    const dev = String(this.globalData.apiBase || this.globalData.devApiBase || '').trim()
    /* 云存储仍要初始化：资质原件上传依赖 wx.cloud.uploadFile */
    if (!wx.cloud) {
      if (!dev) {
        wx.showModal({
          title: '基础库过低',
          content: '当前微信版本不支持云开发，请升级到 2.2.3 以上',
          showCancel: false
        })
        return
      }
    } else {
      try {
        wx.cloud.init({ env: this.globalData.env, traceUser: true })
      } catch (err) {
        /* 环境 id 写错 / 云开发未开通：不能让异常冒到 onLaunch 导致整包白屏 */
        if (!dev) {
          wx.showModal({
            title: '云环境初始化失败',
            content: '请在微信开发者工具中检查云开发环境 ID 与基础库版本后重试。',
            showCancel: false
          })
          return
        }
      }
    }

    /* 截屏 / 录屏 / 保存 防护尽早挂上，越早越好 */
    startScreenGuard()

    /* 保证非 tab 页面下面垫一层首页：安卓物理返回不会直接退出小程序 */
    this.watchRootStack()

    /* 静默登录：wx.login 不弹授权框。进入即浏览，不拦任何界面 */
    ensureLogin(this)
      .then((user) => {
        /* 已有手机号的老用户：顺手申请一次定位（用于同城匹配），拒绝也不影响浏览 */
        if (hasPhone(user)) requestLocation(this)
      })
      .catch(() => {})
  },

  onShow() {
    /* 切回前台时重新挂上防护（onLaunch 里已经挂了一次，这里是兜底） */
    startScreenGuard()
    /* 回到前台时顺手补一次页面栈：冷启动直达详情页等场景都在这里兜住 */
    this.repairRootStack()
    /* 在线心跳：管理端「实时在线人数」按 5 分钟内的心跳统计；未登录不发，失败静默 */
    if (readUser()) request('user', 'online.ping', {}, { silent: true }).catch(() => {})
  },

  /**
   * 页面栈兜底：非 tab 页面成了栈里唯一一页时（分享 / 扫码直达、退出登录后跳登录页等），
   * 安卓物理返回会直接退出小程序。这里把首页垫到栈底再重建当前页，
   * 保证只有首页等 tab 页在栈底时才允许退出。
   */
  watchRootStack() {
    if (this._stackWatched) return
    this._stackWatched = true
    if (typeof wx.onAppRoute === 'function') {
      wx.onAppRoute(() => this.repairRootStack())
    }
    /* 部分客户端不回调 onAppRoute：启动后延迟再查一次 */
    setTimeout(() => this.repairRootStack(), 1200)
  },

  repairRootStack() {
    if (this._stackRepairing) return
    let pages = []
    try {
      pages = getCurrentPages() || []
    } catch (e) {
      return
    }
    if (pages.length !== 1) return
    const cur = pages[0]
    const route = routeOf(cur)
    if (!route || TAB_ROUTES.indexOf(route) > -1) return
    const url = '/' + route + queryOf(cur.options, '__rootfix=1')
    this._stackRepairing = true
    const release = () => {
      setTimeout(() => { this._stackRepairing = false }, 800)
    }
    wx.reLaunch({
      url: '/pages/home/home',
      success: () => {
        wx.navigateTo({ url, fail: release })
        release()
      },
      fail: () => { this._stackRepairing = false }
    })
  },

  onHide() {
    this.globalData.user = null
    this.globalData.profile = null
  },

  /**
   * 全局异常兜底：任何未捕获的脚本错误都在这里收口。
   * 只提示「页面异常，请重试」，不把堆栈抛给用户，也不写敏感字段。
   */
  onError(err) {
    /* 保留最近一次错误信息，便于开发期定位；生产环境可上报到日志云函数 */
    this.globalData.lastError = {
      message: (err && String(err).slice(0, 200)) || 'unknown',
      at: Date.now()
    }
    try {
      wx.showToast({ title: '页面异常，请重试', icon: 'none', duration: 2000 })
    } catch (e) { /* 提示失败不影响运行 */ }
  },

  /** 未处理的 Promise 拒绝：同样收口，避免静默失败导致按钮卡死 */
  onUnhandledRejection(res) {
    const reason = (res && res.reason) || {}
    this.globalData.lastError = {
      message: (reason && (reason.message || reason.errMsg)) || 'unhandledRejection',
      at: Date.now()
    }
  },

  /** 页面不存在（旧链接 / 拼错路径）：回首页，不停在白屏 */
  onPageNotFound(res) {
    try {
      wx.reLaunch({ url: '/pages/home/home' })
    } catch (e) { /* no-op */ }
    /* 阻止默认的「页面不存在」白屏 */
    if (res && typeof res.isPageNotFound === 'boolean') res.isPageNotFound = true
  }
})
