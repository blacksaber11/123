/**
 * 小程序入口。
 *
 * 保密要点：
 * 1. 登录态只存在本地缓存，token 与 openid 不打印到 console；
 * 2. 截屏 / 录屏监测在 App.onShow 统一开启，检测到即遮蔽内容；
 * 3. 所有网络请求走 utils/request.js，云函数返回的敏感字段一律不落本地存储。
 */
const { ensureLogin, readUser, readMyRefCode, readPendingRef, writePendingRef, hasPhone } = require('./utils/auth')
const { startScreenGuard, pageShareCard, isSinglePage } = require('./utils/guard')
const { request, bindApp, safePath } = require('./utils/request')
const inbox = require('./utils/inbox')
const features = require('./utils/features')

/* 底部 tab 路由：只有这些页面在栈底时，安卓物理返回才允许退出小程序 */
const TAB_ROUTES = ['pages/home/home', 'pages/msg/msg', 'pages/mine/mine']

/* 未读轮询间隔：消息页是 tabBar 页，只有它 onShow 才拉数据，其它页面靠这个定时补角标 */
const INBOX_POLL_MS = 20000

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

/* 从启动参数里取推广码：ref 优先；scene 需先解码再按 query 解析 */
function refFromOptions(options) {
  const query = (options && options.query) || {}
  let ref = query.ref ? String(query.ref) : ''
  if (!ref && query.scene) {
    let scene = String(query.scene)
    try {
      scene = decodeURIComponent(scene)
    } catch (err) { /* scene 不是合法编码时按原文解析 */ }
    const hit = scene.match(/(?:^|[?&])ref=([^&]+)/)
    if (hit) ref = hit[1]
  }
  try {
    ref = decodeURIComponent(ref)
  } catch (err) { /* 已解码或含非法字符时保持原文 */ }
  return String(ref || '').trim().slice(0, 32)
}

/* 默认分享卡片文案：页面没有自定义 onShareAppMessage 时使用 */
const SHARE_TITLE = '算力聚合 · 优质货源与求购需求'

/* 当前页完整路径（保留原有 query），分享兜底时使用 */
function sharePathOf(page) {
  const route = routeOf(page)
  if (!route) return '/pages/home/home'
  return '/' + route + queryOf(page && page.options)
}

/* 在分享路径后追加推广码：保留原有参数，重复的 ref 先剔除再补 */
function appendShareRef(path, ref) {
  if (!ref) return path
  const raw = String(path || '')
  if (!raw) return raw
  const at = raw.indexOf('?')
  const base = at >= 0 ? raw.slice(0, at) : raw
  const pairs = at >= 0 ? raw.slice(at + 1).split('&').filter(Boolean) : []
  const kept = pairs.filter((p) => p.split('=')[0] !== 'ref')
  kept.push('ref=' + encodeURIComponent(ref))
  return base + '?' + kept.join('&')
}

/* ============================================================
   未登录浏览引导
   - 只在内容页累计停留时长，切到登录 / 发布 / 私信等自身流程页会清零；
   - 累计约 15 秒后自动打开登录页，登录成功按 from 回到刚才浏览的页面；
   - 冷却期内、已绑定手机号都不再打扰，避免反复打断浏览。
   ============================================================ */
const LOGIN_NUDGE_TICK_MS = 5000
const LOGIN_NUDGE_TICKS = 3
const LOGIN_NUDGE_KEY = 'suanli_login_nudge_at'
const LOGIN_NUDGE_COOL_MS = 10 * 60 * 1000
/* 这些页面本身就在登录 / 发布 / 私密会话流程里，不弹浏览引导 */
const LOGIN_NUDGE_SKIP = [
  'pages/login/login',
  'pages/privacy/privacy',
  'pages/publish/publish',
  'pages/profile/profile',
  'pages/mine/sub/sub',
  'pages/consult/consult',
  'pages/chat/chat',
  'pages/report/report',
  'pages/bizform/bizform',
  'pages/agencydoc/agencydoc',
  'pages/blocked/blocked'
]
let loginNudgeTimer = null
let loginNudgeTicks = 0

/* 已绑定手机号才算真正登录：静默登录只拿到 openid 的用户仍需引导授权 */
function signedInWithPhone() {
  return hasPhone(readUser())
}

function loginNudgeCooling() {
  try {
    const at = Number(wx.getStorageSync(LOGIN_NUDGE_KEY) || 0)
    return at > 0 && Date.now() - at < LOGIN_NUDGE_COOL_MS
  } catch (err) {
    return false
  }
}

/* 当前是否停在可浏览的内容页：登录 / 发布 / 会话页以及朋友圈单页都不计入 */
function nudgePage() {
  if (isSinglePage()) return null
  try {
    const pages = getCurrentPages() || []
    const cur = pages[pages.length - 1]
    const route = routeOf(cur)
    if (!route) return null
    if (LOGIN_NUDGE_SKIP.some((p) => route === p || route.indexOf(p + '/') === 0)) return null
    return cur
  } catch (err) {
    return null
  }
}

function stopLoginNudgeWatch() {
  if (!loginNudgeTimer) return
  clearInterval(loginNudgeTimer)
  loginNudgeTimer = null
}

/* 浏览到时长后直接弹出登录页：登录成功后按 from 回到刚才浏览的内容 */
function showLoginNudge(page) {
  try {
    wx.setStorageSync(LOGIN_NUDGE_KEY, Date.now())
  } catch (err) { /* 缓存失败不阻断本次引导 */ }
  const from = safePath(routeOf(page), page.options || {})
  const url = '/pages/login/login?from=' + encodeURIComponent(from)
  wx.navigateTo({
    url,
    /* 页面栈已满时用 redirectTo 顶上，保证登录页一定能弹出来 */
    fail: () => wx.redirectTo({ url, fail: () => {} })
  })
}

/* 每 5 秒记一次：只有停在内容页才累计，切到登录 / 发布页立即清零 */
function tickLoginNudge() {
  if (signedInWithPhone()) {
    stopLoginNudgeWatch()
    return
  }
  /* 刚引导过（用户从登录页返回继续浏览）：本次前台会话不再重复弹 */
  if (loginNudgeCooling()) {
    stopLoginNudgeWatch()
    return
  }
  const page = nudgePage()
  if (!page) {
    loginNudgeTicks = 0
    return
  }
  loginNudgeTicks += 1
  if (loginNudgeTicks < LOGIN_NUDGE_TICKS) return
  stopLoginNudgeWatch()
  showLoginNudge(page)
}

function startLoginNudgeWatch() {
  stopLoginNudgeWatch()
  loginNudgeTicks = 0
  if (signedInWithPhone() || loginNudgeCooling()) return
  loginNudgeTimer = setInterval(tickLoginNudge, LOGIN_NUDGE_TICK_MS)
}

/* 当前小程序版本号：审核期按版本隐藏社交入口时，服务端据此区分待审版本 */
function appVersion() {
  try {
    const info = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null
    const mp = (info && info.miniProgram) || {}
    /* version 只在正式版有值：开发版 / 体验版回落到 develop / trial，
       否则审核隔离开关在提审前的自测阶段完全不生效 */
    return String(mp.version || mp.envVersion || '').trim()
  } catch (err) {
    return ''
  }
}

/* 自己的推广码：推广大使开通后由登录态写入 globalData，分享时统一追加。
   内存为空时回落到本地缓存：静默登录尚未返回 / 本次启动还没拿到登录态，分享也要带上推广码 */
function ownRefCode() {
  try {
    const app = getApp()
    const code = String((app && app.globalData && app.globalData.refCode) || '').trim()
    return code || readMyRefCode()
  } catch (err) {
    return ''
  }
}

/**
 * 统一包装 Page：所有页面分享都追加全局推广码。
 * 页面自带 onShareAppMessage 时先调原逻辑，再补齐标题 / 描述 / 底图并追加 ref；
 * 页面没有定义分享逻辑时，按当前路由与页面数据生成相关文案（pageShareCard），
 * 保证在哪个页面转发，卡片就是那个页面的内容 + 登录引导。
 * 朋友圈（onShareTimeline）同样包装，保证任意页面转发到朋友圈也带推广码。
 */
function installShareRef() {
  if (typeof Page !== 'function' || Page.__promoteRefWrapped) return
  const rawPage = Page
  const wrappedPage = function (options) {
    const opts = options || {}
    const rawShare = typeof opts.onShareAppMessage === 'function' ? opts.onShareAppMessage : null
    opts.onShareAppMessage = function (event) {
      const res = rawShare ? rawShare.call(this, event) : null
      const card = res && typeof res === 'object' ? Object.assign({}, res) : {}
      const fb = pageShareCard(this)
      /* 页面没给标题 / 用了通用标题时，换成和当前页内容相关的吸引力文案 */
      if (!card.title || card.title === SHARE_TITLE) card.title = fb.title
      if (!card.desc) card.desc = fb.desc
      if (!card.imageUrl) card.imageUrl = fb.imageUrl
      if (!card.path) card.path = sharePathOf(this)
      card.path = appendShareRef(card.path, ownRefCode())
      return card
    }
    /* 朋友圈：query 不带问号，先用聊天的追加逻辑补齐 ref 再去掉问号 */
    const rawTimeline = typeof opts.onShareTimeline === 'function' ? opts.onShareTimeline : null
    opts.onShareTimeline = function (event) {
      const res = rawTimeline ? rawTimeline.call(this, event) : null
      const card = res && typeof res === 'object' ? Object.assign({}, res) : {}
      const fb = pageShareCard(this)
      if (!card.title || card.title === SHARE_TITLE) card.title = fb.title
      if (!card.imageUrl) card.imageUrl = fb.imageUrl
      const query = card.query ? String(card.query) : queryOf(this.options).replace(/^\?/, '')
      card.query = appendShareRef('?' + query, ownRefCode()).replace(/^\?/, '')
      return card
    }
    return rawPage(opts)
  }
  wrappedPage.__promoteRefWrapped = true
  Page = wrappedPage
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
    options: null,
    /**
     * 自己的推广码：只有开通推广大使后才有，登录时由服务端下发并缓存在本地。
     * 任意页面分享 / 保存海报都追加它，别人打开即绑定到自己名下。
     */
    refCode: '',
    /**
     * 别人分享给我的推广码：?ref=xxx 或二维码 scene=ref%3Dxxx 解析后放这里。
     * 只在登录时透传给服务端完成绑定；不参与分享，避免把上家的码套进自己的分享。
     */
    incomingRef: '',
    /**
     * 已经用过的推广码：热启动会反复带同一份启动参数，
     * 记下来避免登录成功后又被当成新推广码去补绑（换号也不会串到上家）。
     */
    consumedRef: '',
    /**
     * 发消息 / 对话总开关：由管理端「系统设置」控制，默认关闭。
     * 审核期间隐藏所有对话入口，通过审批后在后台打开。
     */
    chatEnabled: false,
    /* 功能开关是否已从服务端拉取成功：页面据此避免在加载完成前误判 */
    featureFlagsLoaded: false
  },

  onLaunch(options) {
    /* onLaunch 阶段部分基础库取不到 getApp()：先把实例交给请求层，
       否则 httpConfig() 判空后会回落云函数，静默登录直接失败、首屏接口全部 401 */
    bindApp(this)
    /* 冷启动先恢复自己的推广码：尚未登录时分享也能带上，登录后会被服务端结果覆盖 */
    this.globalData.refCode = readMyRefCode()
    /* 上次分享进入但还没绑定成功（登录失败 / 中途退出）时，先把推广码接回来，再按本次启动参数覆盖 */
    const pendingRef = readPendingRef()
    if (pendingRef) this.globalData.incomingRef = pendingRef
    /* 冷启动直接落地分享链接：先记推广码，再走登录绑定 */
    this.captureRef(options)
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

    /* 公开功能开关：审核期间对话默认关闭，小程序据此隐藏消息 / 私信入口 */
    this.loadFeatureFlags()

    /* 保证非 tab 页面下面垫一层首页：安卓物理返回不会直接退出小程序 */
    this.watchRootStack()

    /* 静默登录：wx.login 不弹授权框。进入即浏览，不拦任何界面 */
    ensureLogin(this)
      .then(() => {
        /* 登录后立刻取一次未读：不必等 20 秒后的第一轮轮询 */
        this.pollInbox()
      })
      .catch(() => this.retrySilentLogin(2))

    /* 未登录浏览一会儿后引导登录：只计时，不拦首屏 */
    startLoginNudgeWatch()
  },

  /**
   * 拉取公开功能开关：审核期间对话关闭，
   * 小程序端据此隐藏消息 / 私信入口；管理端打开后用户重新进入即恢复。
   */
  loadFeatureFlags() {
    /* 带上当前版本号：服务端据此只对待审版本隐藏社交入口，线上版本不受影响 */
    return request('user', 'site.get', { ver: appVersion() }, { silent: true })
      .then((data) => {
        const site = (data && data.site) || {}
        this.globalData.chatEnabled = site.chatEnabled === true
        this.globalData.featureFlagsLoaded = true
        /* 落一份缓存：冷启动时底部导航先用上次结果渲染，避免闪一下再切换 */
        try {
          wx.setStorageSync('featureFlags', { chatEnabled: this.globalData.chatEnabled, at: Date.now() })
        } catch (e) {}
        this.syncTabBarFlags()
        /* 正在打开的商品 / 需求 / 会话等非 tab 页同步刷新开关显隐 */
        features.emit()
        return this.globalData.chatEnabled
      })
      .catch(() => this.globalData.chatEnabled)
  },

  /* 开关结果回来后立即刷新底部导航，不必等用户切页 */
  syncTabBarFlags() {
    try {
      const pages = getCurrentPages() || []
      const cur = pages[pages.length - 1]
      if (!cur) return
      const bar = typeof cur.getTabBar === 'function' ? cur.getTabBar() : null
      if (bar && typeof bar.syncSocial === 'function') bar.syncSocial()
      /* 当前页自身的开关显隐也一并刷新：从后台回来时页面 onShow 早于本请求返回，
         不补这一下会停在「关闭」的旧界面（切 tab 前一直不更新） */
      if (typeof cur.syncSocial === 'function') cur.syncSocial()
      if (typeof cur.syncChatFlag === 'function') cur.syncChatFlag()
    } catch (e) { /* 取不到 tabBar / 页面不影响下一轮 */ }
  },

  /* 冷启动静默登录失败时退避重试：审核机首次启动实测 wx.login 失败后
     40 秒内没有任何登录态，首页 / 资讯首屏会一直停在加载失败 */
  retrySilentLogin(times) {
    if (!(times > 0)) return
    setTimeout(() => {
      ensureLogin(this)
        .then(() => this.pollInbox())
        .catch(() => this.retrySilentLogin(times - 1))
    }, times >= 2 ? 1500 : 3000)
  },

  onShow(options) {
    /* 热启动从分享卡片 / 二维码回到前台时补记推广码，并把新推广码补绑一次 */
    const freshRef = this.captureRef(options)
    if (freshRef && readUser()) ensureLogin(this).catch(() => {})
    /* 切回前台时重新挂上防护（onLaunch 里已经挂了一次，这里是兜底） */
    startScreenGuard()
    /* 切回前台同步一次功能开关：管理端刚打开 / 关闭对话时无需重启小程序 */
    this.loadFeatureFlags()
    /* 回到前台时顺手补一次页面栈：冷启动直达详情页等场景都在这里兜住 */
    this.repairRootStack()
    /* 未读轮询重新挂上并立刻补一次，切回前台马上能看到角标 */
    this.startInboxWatch()
    /* 切回前台重新累计浏览时长：后台挂起期间不计入 */
    startLoginNudgeWatch()
    /* 在线心跳：管理端「实时在线人数」按 5 分钟内的心跳统计；未登录不发，失败静默 */
    if (readUser()) request('user', 'online.ping', {}, { silent: true }).catch(() => {})
  },

  /**
   * 记录推广码。
   * 普通分享卡是 ?ref=XXX；小程序码 / 朋友圈场景值会把参数塞进 query.scene=ref%3DXXX，
   * 需要先 decodeURIComponent 再按 query 解析。返回是否拿到了新的推广码。
   */
  captureRef(options) {
    const ref = refFromOptions(options)
    if (!ref || ref === this.globalData.incomingRef) return false
    /* 已经用过的推广码：热启动会重复带同一份启动参数，不再当成新码补绑 */
    if (ref === this.globalData.consumedRef) return false
    this.globalData.incomingRef = ref
    /* 落一份缓存：首次登录失败或小程序被杀，下次启动还能补绑，不会白丢分享来的人 */
    writePendingRef(ref)
    return true
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

  /**
   * 未读轮询开关：消息页是 tabBar 页，只有它 onShow 才拉 msg.list，
   * 用户停在首页 / 商机 / 商品页时完全感知不到新消息。这里全局每 20 秒拉一次，
   * 把未读写进与消息页同一份缓存，底部导航角标就能自己亮起来。
   */
  startInboxWatch() {
    if (this._inboxTimer) return
    this._inboxTimer = setInterval(() => this.pollInbox(), INBOX_POLL_MS)
    this.pollInbox()
  },

  stopInboxWatch() {
    if (!this._inboxTimer) return
    clearInterval(this._inboxTimer)
    this._inboxTimer = null
  },

  async pollInbox() {
    if (this._inboxPolling || !readUser()) return
    /* 消息页自己在 onShow 里刷新并把消息标已读，这里不插手，避免角标被旧数据刷回来 */
    let topRoute = ''
    try {
      const pages = getCurrentPages() || []
      topRoute = routeOf(pages[pages.length - 1])
    } catch (e) { topRoute = '' }
    /* 消息页 / 对话页自己会刷新并标记已读，全局轮询跳过，避免角标反复跳动 */
    if (topRoute === 'pages/msg/msg' || topRoute === 'pages/chat/chat') return
    this._inboxPolling = true
    try {
      const res = await request('user', 'msg.list', { page: 1, limit: 50 }, { silent: true })
      const items = (res && res.items) || []
      let staffUnread = 0
      let sysUnread = 0
      const directUnread = {}
      items.forEach((m) => {
        const isDirect = m.channel === 'direct' || m.type === 'direct.chat'
        if (isDirect) {
          /* 私聊按会话累计未读条数，与消息页的会话角标口径一致 */
          if (m.threadId && m.from === 'peer' && m.unread) {
            directUnread[m.threadId] = (directUnread[m.threadId] || 0) + 1
          }
          return
        }
        const isChat = m.channel === 'kf' || m.type === 'kf.chat'
        if (isChat) {
          if (m.from === 'staff' && m.unread) staffUnread += 1
          return
        }
        if (m.unread) sysUnread += 1
      })
      const directTotal = Object.keys(directUnread).reduce((sum, k) => sum + directUnread[k], 0)
      const prev = inbox.serverCache()
      /* 咨询回复未读只有消息页能算（要逐条比对本地已读），这里保留它算出的那部分 */
      const prevSys = prev ? Number(prev.sysUnread) || 0 : 0
      const inquiryUnread = prev ? Math.max(0, Number(prev.noticeUnread) - prevSys) : 0
      const next = inbox.cacheServer({
        notices: prev ? prev.notices : [],
        chats: prev ? prev.chats : [],
        chatList: prev ? prev.chatList : [],
        noticeUnread: inquiryUnread + sysUnread,
        chatUnread: staffUnread + directTotal,
        sysUnread
      })
      this.syncTabBarUnread(next.unread)
    } catch (e) {
      /* 失败静默：下一轮再试，不打断当前页面 */
    } finally {
      this._inboxPolling = false
    }
  },

  /* 当前页面挂着自定义 tabBar 时直接刷新角标，不必等它自己的 20 秒兜底 */
  syncTabBarUnread(n) {
    try {
      const pages = getCurrentPages() || []
      const cur = pages[pages.length - 1]
      const bar = cur && typeof cur.getTabBar === 'function' ? cur.getTabBar() : null
      if (bar && bar.setData && bar.data.unread !== n) bar.setData({ unread: n })
    } catch (e) { /* 取不到 tabBar 不影响下一轮 */ }
  },

  onHide() {
    this.stopInboxWatch()
    /* 切后台停止浏览计时，避免在后台弹出登录引导 */
    stopLoginNudgeWatch()
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

/* App 注册完成后、页面模块加载前完成包装：所有页面分享统一追加推广码 */
installShareRef()
