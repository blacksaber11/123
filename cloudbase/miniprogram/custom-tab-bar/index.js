/* 自定义底部导航：首页 / 资讯 / ＋发布 / 消息 / 我的
   发布页不是 tab 页，用 navigateTo 打开，发布页因此不会出现底部导航。
   资讯复用首页的资讯圈视图：点「资讯」切到首页并让其进入 news，
   点「首页」让其回到在售货源，避免再多一个页面。 */
const { getUser } = require('../utils/auth')
const { request } = require('../utils/request')

/* 商机角标缓存：每个 tab 页各有一份 tabBar 实例，模块级缓存 30 秒内不重复请求；
   首页拉到结果后会调 setBizBadge 回填，其他 tab 页直接复用 */
let bizCache = { uid: '', at: 0, count: 0 }
/* 同一时刻只允许一个角标请求在飞：多个 tabBar 实例同时 show 时不重复打接口 */
let bizPending = false

Component({
  data: {
    selected: 0,
    unread: 0,
    /* 首页「商机」数字：>0 才显示，>99 显示 99+ */
    bizBadge: 0,
    /* 页面打开整屏弹层（如发布资讯）时可临时隐藏导航，避免遮住弹层底部按钮 */
    hidden: false
  },

  attached() {
    this.refreshUnread()
    this.refreshBizBadge()
    this.startBadgeTimer()
  },

  detached() {
    this.stopBadgeTimer()
  },

  pageLifetimes: {
    show() {
      this.refreshUnread()
      this.refreshBizBadge()
    }
  },

  methods: {
    /* 未读角标每 20 秒兜底刷新：不依赖切页 onShow，后台收到新消息也能及时亮起 */
    startBadgeTimer() {
      this.stopBadgeTimer()
      this.badgeTimer = setInterval(() => this.refreshUnread(), 20000)
    },

    stopBadgeTimer() {
      if (this.badgeTimer) {
        clearInterval(this.badgeTimer)
        this.badgeTimer = null
      }
    },

    refreshUnread() {
      let n = 0
      try {
        n = require('../utils/inbox').unreadCount()
      } catch (e) {}
      if (n !== this.data.unread) this.setData({ unread: n })
    },

    /* 首页已拿到 biz.badge 结果：直接回填并刷新缓存时间 */
    setBizBadge(n) {
      const v = Math.max(0, Number(n) || 0)
      const me = getUser()
      bizCache = { uid: (me && me.uid) || '', at: Date.now(), count: v }
      if (v !== this.data.bizBadge) this.setData({ bizBadge: v })
    },

    /* 非首页的 tab 页自行取一次；未登录不请求，避免空白账号打接口 */
    refreshBizBadge(force) {
      const me = getUser()
      const uid = (me && me.uid) || ''
      if (!uid) {
        if (this.data.bizBadge) this.setData({ bizBadge: 0 })
        return
      }
      if (!force && bizCache.uid === uid && Date.now() - bizCache.at < 30000) {
        if (bizCache.count !== this.data.bizBadge) this.setData({ bizBadge: bizCache.count })
        return
      }
      if (bizPending) return
      bizPending = true
      request('user', 'biz.badge', {}, { silent: true })
        .then((res) => {
          const n = Math.max(0, Number(res && res.count) || 0)
          bizCache = { uid, at: Date.now(), count: n }
          if (n !== this.data.bizBadge) this.setData({ bizBadge: n })
        })
        .catch(() => {})
        .then(() => { bizPending = false })
    },

    switchTab(e) {
      const index = Number(e.currentTarget.dataset.index)
      if (index === 0 || index === 1) {
        this.openHome(index === 0 ? 'sell' : 'news')
        return
      }
      if (index === 3) {
        wx.switchTab({ url: '/pages/msg/msg' })
        return
      }
      wx.switchTab({ url: '/pages/mine/mine' })
    },

    /* 首页 / 资讯 共用同一个页面（pages/home/home），只是内部视图不同。
       两层判断：
       1) 是否已经在首页 —— 只看路由，路由一定取得到；
       2) 真正切视图 —— 用首页自己注册的回调。
       不能用 getCurrentPages() 取页面自定义方法来判断/调用：部分基础库取不到，
       会静默走 wx.switchTab 到当前页（微信直接忽略），表现就是「点了没反应」。
       也必须在首页可见时才调回调，否则页面在后台被切视图、界面停在原页。 */
    openHome(want) {
      const app = getApp()
      const g = (app && app.globalData) ? app.globalData : {}
      const pages = getCurrentPages() || []
      const cur = pages[pages.length - 1]
      const route = String((cur && cur.route) || '').replace(/^\//, '')
      const onHome = route === 'pages/home/home'

      if (onHome && typeof g.homeSwitch === 'function') {
        g.homeTab = ''
        g.homeSwitch(want)
        return
      }

      /* 回调还没注册（首次编译 / 热重载后）：写落点交给首页 onShow 消费 */
      g.homeTab = want
      if (onHome) {
        /* 已在首页：switchTab 到当前页不会触发 onShow，落点没人消费。
           用 reLaunch 带 tab 参数重建首页，保证这一次点击一定生效。 */
        wx.reLaunch({ url: '/pages/home/home?tab=' + want })
        return
      }
      wx.switchTab({ url: '/pages/home/home' })
    },

    goPublish() {
      wx.navigateTo({ url: '/pages/publish/publish' })
    }
  }
})
