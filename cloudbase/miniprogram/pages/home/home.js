/* 首页：三个视图（在售货源 / 求购需求 / 资讯圈）+ 工具入口 + 搜索 + 排序筛选条 */
const { gate, getUser } = require('../../utils/auth')
const guard = require('../../utils/guard')
const fav = require('../../utils/fav')
const shop = require('../../utils/shop')
const { request, uploadFile } = require('../../utils/request')
const features = require('../../utils/features')
const { CITY_TREE, CITY_FLAT, matchKeyword } = require('../../utils/board')
const catalog = require('../../utils/catalog')

const SELL_SORTS = ['综合', '价格升序', '价格降序', '最新', '成交优先']
const DEMAND_SORTS = ['最新发布', '预算从高到低', '预算从低到高']

/* 设备类型与品牌直接取自设备目录，目录里新增品类后筛选面板自动跟上 */
const DEVICE_CATS = catalog.currentCats()
const DEFAULT_BRAND_CATS = ['GPU 服务器', 'GPU 加速卡', 'AI 一体机']
function brandOptsOf(cats) {
  const list = []
  const tree = catalog.currentTree()
  const src = (cats && cats.length) ? cats : DEFAULT_BRAND_CATS
  src.forEach((c) => {
    Object.keys(tree[c] || {}).forEach((b) => { if (list.indexOf(b) < 0) list.push(b) })
  })
  return list
}

/* 筛选维度：两个 Tab 各自保存、各自生效。
   设备类型取自完整设备目录；品牌随已选设备类型联动，
   避免后端数据里出现新城市 / 新品类时用户筛不到。 */
const FILTER_DEFS = {
  sell: [
    { key: 'cat', label: '设备类型', opts: DEVICE_CATS },
    { key: 'brand', label: '品牌', opts: brandOptsOf() },
    { key: 'city', label: '交易地/发货地', opts: [] },
    { key: 'mode', label: '交易方式', opts: ['出售', '出租'] },
    { key: 'cond', label: '成色', opts: ['全新', '二手', '拆机件'] },
    { key: 'tax', label: '税费', opts: ['含税', '不含税', '可开专票'] }
  ],
  buy: [
    { key: 'cat', label: '设备类型', opts: DEVICE_CATS },
    { key: 'brand', label: '品牌', opts: brandOptsOf() },
    { key: 'city', label: '交付城市', opts: [] },
    { key: 'mode', label: '交易方式', opts: ['求购', '租赁'] },
    { key: 'cond', label: '成色要求', opts: ['仅全新', '可接受二手'] },
    { key: 'tax', label: '税费要求', opts: ['必须含税', '可不开票'] }
  ]
}

/* 城市口径统一：后端存「深圳市」，演示数据存「深圳」，两种都能互相匹配 */
function cityOf(item) {
  return String(item.city || '').replace(/(市|地区|盟|自治州)$/, '')
}

/* 交易方式口径：出售 / 出租 / 求购 / 租赁 */
function modeOf(item, isDemand) {
  if (isDemand) return item.isRent ? '租赁' : '求购'
  return item.isRent ? '出租' : '出售'
}

/* 单个商品的筛选匹配 */
function matchFilter(x, f, isDemand) {
  const sel = (k) => f[k] || []
  const cat = sel('cat')
  if (cat.length && cat.indexOf(x.cat) < 0) return false
  const brand = sel('brand')
  if (brand.length && brand.indexOf(x.brand) < 0) return false
  const city = sel('city')
  if (city.length && !city.some((c) => cityOf({ city: c }) === cityOf(x))) return false
  const mode = sel('mode')
  if (mode.length && mode.indexOf(modeOf(x, isDemand)) < 0) return false
  const cond = sel('cond')
  if (cond.length && !cond.some((c) => String(x.cond || '').indexOf(c) >= 0)) return false
  const tax = sel('tax')
  if (tax.length && !tax.some((t) => String(x.tax || '').indexOf(t) >= 0)) return false
  return true
}

const NEWS_SORTS = ['最新发布', '官方优先']

/* 社交总开关的本地缓存：关闭时首页只留资讯 + 工具栏，避免货源 / 求购在审核期露出。
   冷启动先用上次值渲染，拉到最新配置后由 syncSocial 校正。 */
function cachedSocial() {
  try {
    const v = wx.getStorageSync('featureFlags')
    if (v && typeof v.chatEnabled === 'boolean') return v.chatEnabled
  } catch (e) {}
  return false
}

/* 同城口径：取账号资料里的所在城市；未设置时不再给默认城市（按全国口径展示） */
function localCity() {
  try {
    const u = getUser()
    return (u && u.city) ? String(u.city).replace(/市$/, '') : ''
  } catch (e) {
    return ''
  }
}

Page({
  data: {
    /* 社交总开关关闭：只展示资讯视图，隐藏在售货源 / 求购需求列表与商机入口 */
    socialOn: cachedSocial(),
    tab: cachedSocial() ? 'sell' : 'news',
    /* 朋友圈单页模式：只做浏览，底部提示从右上角进入完整小程序 */
    singlePage: false,
    sortOptions: cachedSocial() ? SELL_SORTS : NEWS_SORTS,
    sort: cachedSocial() ? '综合' : NEWS_SORTS[0],
    search: '',
    filterOpen: false,
    filterGroups: [],
    activeChips: [],
    activeCount: 0,
    /* 城市两级菜单：左侧大区、右侧该大区下的城市，选中集合同一份 */
    cityProvs: [],
    cityOpts: [],
    cityProvName: '热门',
    citySelCount: 0,
    items: [],
    loading: false,
    /* 服务端是否还有下一页：空态里据此提供「加载更多」 */
    hasMore: false,
    /* 资讯接口失败：展示重试空态，不再回落演示数据 */
    newsError: false,
    /* 商机角标：与我的库存匹配、尚未领取的商机数量（未登录为 0） */
    bizBadge: 0,
    /* 商机按钮副标题：只显示「N 条商机」，不罗列型号；没商机时回落文案 */
    bizHint: '',
    /* 资讯圈：全国 / 同城 / 指定城市，按发布地址筛选 */
    /* 评论总开关：后台关闭后隐藏评论框、评论区与评论数 */
    commentEnabled: true,
    newsScope: 'all',
    newsLocalCity: '',
    newsCity: '',
    newsCityOptions: CITY_FLAT,
    newsSheet: false,
    newsStats: { city: '全国' },
    newsPubOpen: false,
    newsPub: { title: '', content: '', city: '' },
    /* 资讯媒体：图片最多 9 张、视频最多 1 段，上传后随正文一起提交 */
    newsMedia: [],
    newsMediaUrls: [],
    newsMediaImgCount: 0,
    newsMediaVideoCount: 0,
    newsUploading: false,
    /* 资讯私密发布：默认关闭；开启后不显示发布人、不进主页 */
    newsPrivate: false,
    newsSubmitting: false,
    /* 键盘高度：发布资讯弹层随键盘抬升，底部「发布」按钮始终可见 */
    kbH: 0,
    /* 首页横幅：内容与滚动速度由管理端配置，点击弹窗展示详情 */
    bannerText: '',
    bannerItems: [],
    bannerDur: 20,
    bannerOpen: false
  },

  onLoad(options) {
    this.initState()
    if (typeof wx.onKeyboardHeightChange === 'function') {
      this.onKbChange = (res) => {
        this.setData({ kbH: Math.max(0, Number(res && res.height) || 0) })
      }
      wx.onKeyboardHeightChange(this.onKbChange)
    }
    this.registerHomeSwitch()
    this.setData(Object.assign(this.filterPatch(this.data.tab), { newsLocalCity: localCity() }))
    /* 分享落地链接带 tab 参数：直接落到对应视图（货源 / 求购 / 资讯） */
    const want = String((options && options.tab) || '')
    /* 旧版货盘链接：货盘已独立成页，转发出去的旧链接也要能打开 */
    if (want === 'market') {
      wx.navigateTo({ url: '/pages/market/market' })
      return
    }
    if (want && ['sell', 'buy', 'news'].indexOf(want) >= 0) {
      /* 开关关闭时货源 / 求购不对外展示：旧的分享链接统一落到资讯 */
      const target = this.data.socialOn ? want : 'news'
      this.setData({ tab: target, sortOptions: this.sortOptionsOf(target), sort: this.sortStore[target] })
      this.syncNavTitle(target)
    }
    this.loadList()
    this.loadBanner()
    this.refreshCatalog()
  },

  /* 型号目录以服务端为准：管理端增删型号后，设备类型 / 品牌筛选项自动跟上 */
  refreshCatalog() {
    catalog.loadCatalog().then((res) => {
      if (!res || !res.tree) return
      const cats = (res.cats && res.cats.length) ? res.cats : Object.keys(res.tree)
      if (cats.join('|') !== DEVICE_CATS.join('|')) {
        DEVICE_CATS.splice(0, DEVICE_CATS.length)
        cats.forEach((c) => DEVICE_CATS.push(c))
      }
      /* 品牌随目录变化：已选品牌不在新目录里时移除，避免筛出空列表 */
      const tab = this.data.tab
      const f = this.filters && this.filters[tab]
      if (f && (f.cat || []).length) {
        const allow = brandOptsOf(f.cat)
        f.brand = (f.brand || []).filter((b) => allow.indexOf(b) >= 0)
      }
      this.setData(this.filterPatch(tab))
    }).catch(() => {})
  },

  /* 各视图的排序选项：与 goTab 保持同一份口径 */
  sortOptionsOf(tab) {
    return tab === 'sell' ? SELL_SORTS
      : tab === 'buy' ? DEMAND_SORTS : NEWS_SORTS
  },

  /* 各视图的关键字、筛选条件与排序各自保存；onLoad / onShow 都要能安全调用 */
  initState() {
    if (!this.filters) {
      this.keywords = { sell: '', buy: '', news: '' }
      this.filters = { sell: {}, buy: {}, news: {} }
      this.sortStore = { sell: SELL_SORTS[0], buy: DEMAND_SORTS[0], news: NEWS_SORTS[0] }
    }
    /* 各视图最近一次的渲染结果：切视图时先用它立刻铺满，再静默刷新，
       避免旧视图的列表残留在屏幕上（切过去还要「等一小会儿」才变） */
    if (!this.tabCache) this.tabCache = { sell: null, buy: null, news: null }
  },

  onShow() {
    this.initState()
    gate(this.route || 'pages/home/home', this.options)
    /* 社交总开关：关闭后只留资讯视图；切换开关后回到本页即生效 */
    this.syncSocial()
    /* 底部导航带来的落点会自己触发一次加载，避免和下面的刷新重复请求 */
    const switched = this.applyHomeTab()
    this.syncTabBar()
    /* 弹层没打开时保证导航栏可见（重新编译 / 异常退出弹层后自愈） */
    this.setTabBarHidden(this.data.newsPubOpen === true)
    /* 首页允许分享：分享的是公开货源信息，卡片与文案按当前视图区分；朋友圈同开 */
    guard.enableShare(true)
    const sp = guard.isSinglePage()
    if (sp !== this.data.singlePage) this.setData({ singlePage: sp })
    /* 用户可能在「我的」里改过所在城市，回到首页时同步同城口径 */
    const lc = localCity()
    if (lc !== this.data.newsLocalCity) this.setData({ newsLocalCity: lc })
    this.refreshFav()
    /* 回到首页重新拉一次信息流：刚发布的商品 / 需求要能立刻看到 */
    if (!switched) this.loadList(true)
    this.loadBanner()
    this.loadBizBadge()
    this.refreshCatalog()
    this.startBizTimer()
    /* 在线心跳：登录后回到首页时 app.onShow 不会再触发，这里补一次 */
    const me = getUser()
    if (me && me.uid) request('user', 'online.ping', {}, { silent: true }).catch(() => {})
  },

  /* 分享标题取自当前视图第一条真实内容：型号随列表变化，不会永远固定某个型号 */
  shareSample() {
    const head = (this.data.items || [])[0] || {}
    const model = [head.brand, head.model].filter(Boolean).join(' ')
    const cover = String(head.cover || '')
    return {
      model: String(model || '').trim(),
      title: String(head.title || '').trim(),
      cover: /^https?:\/\//.test(cover) ? cover : ''
    }
  },

  /* 分享卡片：首页三个视图（货源 / 求购 / 资讯）文案各不相同 */
  onShareAppMessage(res) {
    /* 信息流里的「转发」按钮带资讯 id：直接分享到这条资讯详情 */
    const ds = (res && res.target && res.target.dataset) || {}
    if (ds.id) {
      return {
        title: ds.title || '算力聚合 · 资讯',
        path: '/pages/news/news?id=' + encodeURIComponent(ds.id)
      }
    }
    const tab = this.data.tab
    const s = this.shareSample()
    if (tab === 'news') {
      return {
        title: guard.scrubContact(s.title ? s.title + '｜行情与避坑，点开看全文' : '算力行情速递 · 今日报价与交易避坑，点开就看'),
        desc: '今日报价、机房清退与交易避坑，登录看同行都在聊什么',
        imageUrl: s.cover || '/assets/share/card-home.png',
        path: '/pages/home/home?tab=news'
      }
    }
    if (tab === 'buy') {
      return {
        title: guard.scrubContact(s.model
          ? '同行正在求购 ' + s.model + '，登录抢占对接先机'
          : '同行正在集中求购，登录抢占对接先机'),
        desc: '求购与租赁需求持续更新，登录查看需求方与条件',
        imageUrl: s.cover || '/assets/share/card-demand.png',
        path: '/pages/home/home?tab=buy'
      }
    }
    return {
      title: guard.scrubContact(s.model
        ? s.model + ' 现货在售，登录看货主实价'
        : '今日现货货源持续更新，登录看货主实价'),
      desc: 'GPU 服务器 / 内存 / 整机实时挂牌，登录查看货主与实时报价',
      imageUrl: s.cover || '/assets/share/card-product.png',
      path: '/pages/home/home?tab=sell'
    }
  },

  /* 分享到朋友圈：单页模式只能浏览，title / query 与好友分享保持同一口径 */
  onShareTimeline() {
    const tab = this.data.tab
    const s = this.shareSample()
    if (tab === 'news') {
      return {
        title: guard.scrubContact(s.title ? s.title + '｜行情与避坑，点开看全文' : '算力行情速递 · 今日报价与交易避坑，点开就看'),
        query: 'tab=news',
        imageUrl: s.cover || '/assets/share/card-home.png'
      }
    }
    if (tab === 'buy') {
      return {
        title: guard.scrubContact(s.model
          ? '同行正在求购 ' + s.model + '，登录抢占对接先机'
          : '同行正在集中求购，登录抢占对接先机'),
        query: 'tab=buy',
        imageUrl: s.cover || '/assets/share/card-demand.png'
      }
    }
    return {
      title: guard.scrubContact(s.model
        ? s.model + ' 现货在售，登录看货主实价'
        : '今日现货货源持续更新，登录看货主实价'),
      query: 'tab=sell',
      imageUrl: s.cover || '/assets/share/card-product.png'
    }
  },

  /* 底部导航「首页 / 资讯」共用本页：首页把切视图的方法注册到全局，
     tabBar 直接调用。不依赖 getCurrentPages() 能否取到页面自定义方法
     （部分基础库取不到，回落到 switchTab 到当前页会被微信忽略，点了没反应）。 */
  registerHomeSwitch() {
    const app = getApp()
    if (!app) return
    app.globalData = app.globalData || {}
    this.homeSwitchHandler = (want) => {
      if (!want) return
      this.goTab(want)
    }
    app.globalData.homeSwitch = this.homeSwitchHandler
  },

  /* 底部导航「首页 / 资讯」共用本页：进入前由 tabBar 写入落点，取到即清空。
     返回 true 表示本次 onShow 已经由切视图触发了加载。 */
  applyHomeTab() {
    const app = getApp()
    const want = (app && app.globalData && app.globalData.homeTab) || ''
    if (!want) return false
    app.globalData.homeTab = ''
    this.goTab(this.data.socialOn ? want : 'news')
    return true
  },

  /* 社交总开关：关闭时只保留资讯视图。
     开关还没从服务端拉到时先按完整版展示，拉到真实值后再切换，
     避免完整版用户每次冷启动先被锁成资讯页。 */
  syncSocial() {
    if (!features.loaded()) {
      /* 还没拿到开关：保持当前（缓存）判断，同时补拉一次，回来后 app 会再调本方法 */
      features.ensure().catch(() => {})
      return
    }
    const on = features.chatEnabled()
    /* 评论也是社交内容：总开关关闭时卡片上的评论框与评论区一起隐藏 */
    const commentOn = this.newsCommentBase !== false && on
    if (commentOn !== this.data.commentEnabled) this.setData({ commentEnabled: commentOn })
    if (on === this.data.socialOn) return
    const wasOff = this.data.socialOn === false
    this.setData({ socialOn: on })
    /* 关闭：强制回到资讯；打开：此前被强制停在资讯的，回到在售货源 */
    if (!on && this.data.tab !== 'news') this.goTab('news')
    if (on && wasOff && this.data.tab === 'news') this.goTab('sell')
  },

  // 自定义 tabBar 的选中态由页面自己同步：首页 / 资讯 共用一页，按目标视图区分
  // 传 tab 是为了在 setData 之前就把高亮切过去，避免数据还没回来时高亮还停在旧项
  syncTabBar(tab) {
    const t = tab || this.data.tab
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (!bar || !bar.setData) return
    bar.setData({ selected: t === 'news' ? 1 : 0 })
    /* 切回首页时页面是复用的，tabBar 的 pageLifetimes.show 不一定触发：
       主动同步一次社交开关，避免管理端打开后仍停在两项导航 */
    if (typeof bar.syncSocial === 'function') bar.syncSocial()
    /* 未读角标同理：各 tab 页各有一份 tabBar 实例，不复用消息页刚清掉的那份，
       这里重读一次缓存，避免已读消息切页后又亮起来 */
    if (typeof bar.refreshUnread === 'function') bar.refreshUnread()
  },

  // 导航栏标题随视图切换：资讯页显示「资讯」，货源 / 求购仍为「算力聚合」
  syncNavTitle(tab) {
    const t = tab || this.data.tab
    wx.setNavigationBarTitle({ title: t === 'news' ? '资讯' : '算力聚合', fail: () => {} })
  },

  // 从详情页返回时同步收藏状态（资讯没有收藏）
  refreshFav() {
    if (this.data.tab !== 'sell' && this.data.tab !== 'buy') return
    if (!this.data.items.length) return
    const type = this.data.tab === 'sell' ? 'product' : 'demand'
    const items = this.data.items.map((x) => Object.assign({}, x, { fav: fav.isFav(type, x.id) }))
    this.setData({ items })
  },

  switchTab(e) {
    this.goTab(e.currentTarget.dataset.tab)
  },

  /* 实时货盘：独立页面，返回走原生导航栏箭头 / iOS 侧滑 */
  goMarket() {
    wx.navigateTo({ url: '/pages/market/market' })
  },

  /* 切视图：各视图的关键字、筛选条件与排序各自保存 */
  goTab(tab) {
    if (!tab) return
    /* 底部导航把「首页」传 sell、「资讯」传 news；未知落点统一回在售货源。 */
    const target = ['sell', 'buy', 'news'].indexOf(tab) >= 0 ? tab : 'sell'
    this.initState()
    /* 先同步高亮：即使目标视图与当前一致，点击也要有可见反馈 */
    this.syncTabBar(target)
    this.syncNavTitle(target)
    if (target === this.data.tab) return
    this.keywords[this.data.tab] = this.data.search
    this.sortStore[this.data.tab] = this.data.sort
    const sortOptions = this.sortOptionsOf(target)
    /* 切视图必须同步完成：先用该视图上一次的渲染结果铺上，
       没有缓存就立刻换成空列表 + 加载态，绝不让旧视图的列表继续留在屏幕上 */
    const cached = this.tabCache[target]
    const patch = Object.assign({
      tab: target,
      sortOptions,
      sort: this.sortStore[target] || sortOptions[0],
      search: this.keywords[target] || '',
      items: cached ? cached.items : [],
      loading: !cached
    }, this.filterPatch(target))
    /* 资讯头部的统计条同步到目标视图的筛选范围，不能沿用上一个视图的城市 */
    if (target === 'news') {
      patch.newsStats = cached ? cached.newsStats : { city: cityOf({ city: this.newsTargetCity() }) || '全国' }
    }
    this.setData(patch)
    /* 换视图后回到列表顶部：不复用上一个视图的滚动位置，避免切过去停在半截 */
    if (typeof wx.pageScrollTo === 'function') wx.pageScrollTo({ scrollTop: 0, duration: 0 })
    this.loadList(true)
  },

  changeSort(e) {
    const sort = e.currentTarget.dataset.sort
    this.sortStore[this.data.tab] = sort
    this.setData({ sort })
    this.loadList(true)
  },

  /* ---------- 搜索 ---------- */

  onSearch(e) {
    this.setData({ search: e.detail.value })
    this.loadList()
  },

  clearSearch() {
    this.setData({ search: '' })
    this.loadList(true)
  },

  /* ---------- 筛选 ---------- */

  // 生成筛选面板的分组与选中态；品牌随已选设备类型联动
  buildGroups(tab) {
    const f = this.filters[tab] || {}
    /* 资讯圈没有筛选面板：返回空分组，排序条上的筛选入口同步隐藏 */
    if (!FILTER_DEFS[tab]) return []
    return FILTER_DEFS[tab].map((d) => {
      const opts = d.key === 'brand' ? brandOptsOf(f.cat) : d.opts
      return {
        key: d.key,
        label: d.label,
        opts: opts.map((o) => ({ v: o, on: (f[d.key] || []).indexOf(o) >= 0 }))
      }
    })
  },

  // 已选条件 chips（用于排序条下方与筛选按钮角标）
  buildChips(tab) {
    const f = this.filters[tab] || {}
    const chips = []
    ;(FILTER_DEFS[tab] || []).forEach((d) => {
      (f[d.key] || []).forEach((v) => chips.push({ key: d.key, v, label: d.label + '：' + v }))
    })
    return chips
  },

  /* 城市两级菜单：左侧大区、右侧城市；选中集合按城市名跨大区共用一份 */
  buildCityView(tab) {
    const sel = ((this.filters[tab] || {}).city) || []
    const idx = Math.min(this.cityProv || 0, CITY_TREE.length - 1)
    const cur = CITY_TREE[idx] || CITY_TREE[0]
    return {
      cityProvs: CITY_TREE.map((g, i) => ({
        p: g.p,
        active: i === idx,
        count: g.cities.filter((c) => sel.indexOf(c) >= 0).length
      })),
      cityOpts: cur.cities.map((c) => ({ v: c, on: sel.indexOf(c) >= 0 })),
      cityProvName: cur.p,
      citySelCount: sel.length
    }
  },

  /* 一次算好筛选面板需要的全部状态，避免各处漏更新城市菜单 */
  filterPatch(tab) {
    const chips = this.buildChips(tab)
    return Object.assign({
      filterGroups: this.buildGroups(tab),
      activeChips: chips,
      activeCount: chips.length
    }, this.buildCityView(tab))
  },

  switchCityProv(e) {
    const i = Number(e.currentTarget.dataset.i) || 0
    this.cityProv = i
    this.setData(this.buildCityView(this.data.tab))
  },

  toggleCity(e) {
    this.toggleFilterValue('city', e.currentTarget.dataset.v)
  },

  openFilter() {
    const tab = this.data.tab
    this.setData(Object.assign({ filterOpen: true }, this.filterPatch(tab)))
  },

  closeFilter() {
    this.setData({ filterOpen: false })
  },

  toggleFilter(e) {
    this.toggleFilterValue(e.currentTarget.dataset.k, e.currentTarget.dataset.v)
  },

  /* 面板选项与城市两级菜单共用：切换一个值并按新条件刷新列表 */
  toggleFilterValue(key, val) {
    const tab = this.data.tab
    const f = this.filters[tab] || {}
    const cur = (f[key] || []).slice()
    const idx = cur.indexOf(val)
    if (idx >= 0) cur.splice(idx, 1)
    else cur.push(val)
    f[key] = cur
    /* 设备类型变化后，已选品牌若不在新类型的品牌范围内则自动移除 */
    if (key === 'cat') {
      const allow = brandOptsOf(cur)
      f.brand = (f.brand || []).filter((b) => allow.indexOf(b) >= 0)
    }
    this.filters[tab] = f
    this.setData(this.filterPatch(tab))
    this.loadList(true)
  },

  removeChip(e) {
    const key = e.currentTarget.dataset.k
    const val = e.currentTarget.dataset.v
    const tab = this.data.tab
    const f = this.filters[tab] || {}
    f[key] = (f[key] || []).filter((v) => v !== val)
    this.filters[tab] = f
    this.setData(this.filterPatch(tab))
    this.loadList(true)
  },

  // 重置当前 Tab 的筛选条件（保留关键字）
  resetFilter() {
    const tab = this.data.tab
    this.filters[tab] = {}
    this.cityProv = 0
    this.setData(this.filterPatch(tab))
    this.loadList(true)
  },

  // 空状态里的「清空筛选条件」：条件与关键字一起清
  clearFilter() {
    const tab = this.data.tab
    this.filters[tab] = {}
    this.keywords[tab] = ''
    this.cityProv = 0
    this.setData(Object.assign({ search: '' }, this.filterPatch(tab)))
    this.loadList(true)
  },

  /* ---------- 列表 ---------- */

  /**
   * immediate = true：切视图 / 换排序 / 换筛选等确定性操作，立刻请求；
   * immediate = false（默认）：只用于搜索输入框，逐字触发要防抖，避免打一串接口。
   */
  loadList(immediate) {
    /* 连续操作时先取消上一次延迟任务，避免旧结果覆盖新结果 */
    if (this.listTimer) {
      clearTimeout(this.listTimer)
      this.listTimer = null
    }
    if (immediate) {
      /* 没有可展示的内容时先给加载态，避免空态文案闪一下 */
      if (!this.data.items.length && !this.data.loading) this.setData({ loading: true })
      this.logSearch()
      this.fetchList()
      return
    }
    this.setData({ loading: true })
    this.listTimer = setTimeout(() => {
      this.listTimer = null
      this.logSearch()
      this.fetchList()
    }, 200)
  },

  /**
   * 首页横幅：管理端在「设置 - 首页横幅」维护内容与速度，保存后即时生效（无需重新上传小程序）。
   * 多条标题用分隔符连成一条滚动文案；速度是像素 / 秒，换算成单次循环时长。
   * 15 秒内不重复拉取（onLoad / onShow 会连续触发）；关闭开关后横幅展位整体消失。
   */
  async loadBanner(force) {
    const now = Date.now()
    if (!force && this.bannerAt && now - this.bannerAt < 15000 && this.data.bannerText) return
    /* 并发合并：onLoad 与 onShow 同时触发时只发一次请求 */
    if (this.bannerLoading) return
    this.bannerLoading = true
    this.bannerAt = now
    try {
      const res = await request('user', 'site.get', {}, { silent: true })
      this.bannerTries = 0
      const b = (res && res.site && res.site.banner) || {}
      const items = b.enabled === false ? [] : (b.items || []).filter((x) => x && x.title)
      if (!items.length) {
        if (this.data.bannerText || this.data.bannerOpen) {
          this.setData({ bannerText: '', bannerItems: [], bannerOpen: false })
        }
        return
      }
      const speed = Math.min(200, Math.max(10, Number(b.speed) || 40))
      const text = items.map((x) => x.title).join('　　·　　')
      /* 估算宽度 = 字数 × 14px + 间隔，除以速度得到一整轮时长（秒） */
      const dur = Math.min(90, Math.max(6, (text.length * 14 + 48) / speed))
      this.setData({
        bannerText: text,
        bannerItems: items,
        bannerDur: Math.round(dur * 10) / 10
      })
    } catch (err) {
      /* 失败不缓存：登录尚未完成 / 网络抖动时自动补拉，避免首屏永久缺失横幅 */
      this.bannerAt = 0
      this.retryBanner()
    } finally {
      this.bannerLoading = false
    }
  },

  /** 首屏拉取失败后补拉两次（1.5s / 3s），覆盖静默登录尚未完成的空窗期 */
  retryBanner() {
    if (this.bannerTimer) return
    const tries = Number(this.bannerTries) || 0
    if (tries >= 2) return
    this.bannerTries = tries + 1
    this.bannerTimer = setTimeout(() => {
      this.bannerTimer = null
      this.loadBanner(true)
    }, 1500 * (tries + 1))
  },

  openBanner() {
    if (!this.data.bannerItems.length) return
    this.setData({ bannerOpen: true })
  },

  closeBanner() {
    if (this.data.bannerOpen) this.setData({ bannerOpen: false })
  },

  /* 弹窗内部点击不透传到遮罩 */
  noop() {},

  /**
   * 商机角标：只取数量，不拉商机卡片。
   * 只要按库存 / 已发布需求匹配到商机就显示，未开通也提示（用于引导开通）；
   * 已领取的商机不再计入，只有发布方删除 / 关闭条目后才会减少。
   */
  loadBizBadge() {
    const me = getUser()
    if (!me || !me.uid) {
      if (this.data.bizBadge || this.data.bizHint) this.setData({ bizBadge: 0, bizHint: '' })
      this.syncTabBizBadge(0)
      return
    }
    request('user', 'biz.badge', {}, { silent: true })
      .then((res) => {
        const n = Math.max(0, Number(res && res.count) || 0)
        /* 副标题只显示匹配数量，不再罗列型号，避免按钮被撑长 */
        const hint = n > 0 ? n + ' 条商机' : ''
        const patch = {}
        if (n !== this.data.bizBadge) patch.bizBadge = n
        if (hint !== this.data.bizHint) patch.bizHint = hint
        if (Object.keys(patch).length) this.setData(patch)
        this.syncTabBizBadge(n)
      })
      .catch(() => {})
  },

  /* 底部导航「首页」槽位复用同一次结果，避免 tabBar 再发一次请求 */
  syncTabBizBadge(n) {
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (bar && bar.setBizBadge) bar.setBizBadge(n)
  },

  /* 页面可见期间每 30 秒刷一次角标：商机由他人发布 / 关闭，数字要能自己变化 */
  startBizTimer() {
    this.stopBizTimer()
    this.bizTimer = setInterval(() => this.loadBizBadge(), 30000)
  },

  stopBizTimer() {
    if (this.bizTimer) {
      clearInterval(this.bizTimer)
      this.bizTimer = null
    }
  },

  /**
   * 搜索埋点：用于管理端「每日搜索最多」榜单。
   * 输入框是逐字触发的，同一关键词只上报一次，避免把热词榜刷成前缀碎片。
   */
  logSearch() {
    const q = String(this.data.search || '').trim()
    if (!q) return
    const tab = this.data.tab
    this.searchLogged = this.searchLogged || {}
    if (this.searchLogged[tab] === q) return
    this.searchLogged[tab] = q
    const f = (this.filters && this.filters[tab]) || {}
    const cat = (f.cat && f.cat[0]) || ''
    request('user', 'search.log', { q, cat }, { silent: true }).catch(() => {})
  },

  /* 云端优先：信息流读真实商品 / 需求；云端不可用时回落到本地演示数据 */
  async fetchList() {
    const isDemand = this.data.tab === 'buy'
    /* 请求序号：切 Tab 或连续搜索时丢弃过期结果，避免旧请求覆盖新列表 */
    const seq = (this.listSeq = (this.listSeq || 0) + 1)
    /* 资讯圈：官方资讯 + 用户发布，按发布地址做全国 / 同城 / 指定城市筛选 */
    if (this.data.tab === 'news') {
      this.fetchNews(seq)
      return
    }
    this.page = 1
    this.hasMore = false
    const source = await this.loadFromCloud(isDemand, 1)
    if (seq !== this.listSeq) return
    if ((this.data.tab === 'buy') !== isDemand) return
    /* 云端返回空列表是合法结果（确实没有在售商品），不再回落演示数据 */
    const list = (source && source.list) || []
    this.cloudList = list
    this.hasMore = !!(source && source.hasMore)
    this.applyList(list, isDemand)
  },

  /* 触底加载下一页：只对货源 / 求购生效，资讯一次取回 */
  onReachBottom() {
    if (this.data.tab === 'sell' || this.data.tab === 'buy') this.loadMore()
  },

  async loadMore() {
    if (this.loadingMore || !this.hasMore) return
    const isDemand = this.data.tab === 'buy'
    const seq = this.listSeq
    const next = (this.page || 1) + 1
    this.loadingMore = true
    try {
      const res = await this.loadFromCloud(isDemand, next)
      /* 请求期间切了 Tab 或重新搜索：丢弃这一页 */
      if (!res || seq !== this.listSeq) return
      if ((this.data.tab === 'buy') !== isDemand) return
      this.page = next
      this.hasMore = res.hasMore
      this.cloudList = (this.cloudList || []).concat(res.list)
      this.applyList(this.cloudList, isDemand)
    } finally {
      this.loadingMore = false
    }
  },

  /* 返回 { list, hasMore } 表示云端结果；返回 null 表示云端不可用（不再用演示数据顶替） */
  async loadFromCloud(isDemand, page) {
    const q = String(this.data.search || '').trim()
    const f = (this.filters && this.filters[this.data.tab]) || {}
    try {
      const body = { page: page || 1, limit: 20 }
      /* 关键词交给后端检索，才能搜到第 1 页之后的数据 */
      if (q) body.q = q
      /* 货源列表的筛选与排序一并下推服务端：分页与 hasMore 才不会被本地过滤带偏。
         求购列表服务端暂不支持这些维度，沿用本地过滤，避免条件被静默丢弃。 */
      if (!isDemand) {
        if ((f.cat || []).length) body.cats = f.cat
        if ((f.brand || []).length) body.brands = f.brand
        if ((f.city || []).length) body.cities = f.city
        if ((f.mode || []).length) body.modes = f.mode
        if ((f.cond || []).length) body.conds = f.cond
        if ((f.tax || []).length) body.taxes = f.tax
        /* 搜索场景固定按发布时间倒序，与原来的搜索结果顺序保持一致 */
        body.sort = q ? '最新' : String(this.data.sort || '')
      }
      /* 代采 / 代售只在商机池展示，不再混入普通商品 / 需求列表 */
      const res = await (isDemand
        ? request('user', 'demand.list', body, { silent: true })
        : request('user', 'product.list', body, { silent: true }))
      /* 响应里没有 items 说明接口不可用（不是「确实没有数据」），按离线处理 */
      if (!res || !Array.isArray(res.items)) return null
      const list = isDemand ? shop.toDemands(res.items) : shop.toProducts(res.items)
      /* 自己发布的商品 / 需求不在首页信息流展示：避免自己看到并咨询自己 */
      return { list: list.filter((x) => !x.mine), hasMore: res.hasMore === true }
    } catch (e) {
      return null
    }
  },

  /* ---------- 资讯圈 ---------- */

  /* 资讯接口失败时展示空态 + 重试，不再用演示资讯冒充真实内容 */
  async fetchNews(seq) {
    let list = null
    let mine = []
    const me = getUser()
    /* 资讯列表与「我的投稿」并行请求：两个串行会多一个来回，切过来要白等一程 */
    const [newsRes, ownRes] = await Promise.all([
      request('user', 'news.list', {
        page: 1,
        limit: 50,
        scope: this.data.newsScope,
        city: this.newsTargetCity()
      }, { silent: true }).catch(() => null),
      /* 未登录访客不请求「我的投稿」：避免 401 把人从资讯页弹回登录页 */
      (me && me.uid)
        ? request('user', 'news.mine', {}, { silent: true }).catch(() => null)
        : Promise.resolve(null)
    ])
    if (newsRes && Array.isArray(newsRes.items)) list = newsRes.items
    /* 自己的投稿：审核中 / 被驳回也要看得见，不能「投了就消失」 */
    if (ownRes && Array.isArray(ownRes.items)) mine = ownRes.items
    if (seq !== this.listSeq || this.data.tab !== 'news') return
    const failed = list === null
    if (failed) {
      this.applyNews([], true)
      return
    }
    /* 评论总开关：后台关闭或社交总开关（含审核期隐藏）关闭后，卡片上不再渲染评论框与评论区 */
    if (newsRes) {
      this.newsCommentBase = newsRes.commentEnabled !== false
      this.setData({ commentEnabled: this.newsCommentBase && features.chatEnabled() })
    }
    const pending = mine
      .filter((n) => n.status === '待审核' || n.status === '已驳回')
      .map((n) => Object.assign({}, n, {
        official: false,
        cat: '我的投稿',
        author: '我',
        published: n.createdText,
        selfStatus: n.status,
        selfReason: n.reason || ''
      }))
    this.applyNews(pending.concat(list), false)
  },

  newsTargetCity() {
    if (this.data.newsScope === 'city') return this.data.newsLocalCity
    if (this.data.newsScope === 'pick') return this.data.newsCity
    return ''
  },

  /* 按发布地址筛选 + 关键字匹配；官方优先时把官方资讯排到前面 */
  applyNews(source, failed) {
    const city = cityOf({ city: this.newsTargetCity() })
    const words = String(this.data.search || '').trim().split(/\s+/).filter(Boolean)
    let list = source.filter((n) => {
      if (city && cityOf({ city: n.city }) !== city) return false
      const hay = [n.title, n.summary, n.cat, n.city, n.author].join(' ').toLowerCase()
      return words.every((w) => hay.indexOf(w.toLowerCase()) >= 0)
    })
    /* 朋友圈式媒体：补预览图集合与互动默认值，模板直接用 */
    list = list.map((n) => {
      const media = Array.isArray(n.media) ? n.media.filter((m) => m && m.fileId) : []
      return Object.assign({
        likes: 0,
        liked: false,
        commentCount: 0,
        commentOpen: false,
        commentDraft: '',
        hasFull: String(n.content || '').length > String(n.summary || '').length
      }, n, {
        media,
        mediaCount: media.length,
        mediaUrls: media.filter((m) => m.kind !== 'video').map((m) => m.fileId)
      })
    })
    if (this.data.sort === '官方优先') {
      list = list.slice().sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0))
    }
    const stats = { city: city || '全国' }
    this.setData({
      items: list,
      loading: false,
      newsError: !!failed,
      newsStats: stats
    })
    /* 失败不写入缓存：下次切回资讯时重新请求，而不是继续展示错误空态 */
    this.tabCache.news = failed ? null : { items: list, newsStats: stats }
  },

  /* 资讯加载失败后的重试入口 */
  retryNews() {
    this.tabCache.news = null
    this.setData({ items: [], loading: true, newsError: false })
    this.loadList(true)
  },

  switchNewsScope(e) {
    const s = e.currentTarget.dataset.scope
    if (s === 'pick') {
      this.setData({ newsSheet: true })
      return
    }
    /* 资料里没填城市时不能把全国内容当成「同城」展示 */
    if (s === 'city' && !this.data.newsLocalCity) {
      wx.showToast({ title: '未设置城市，请先在「我的」填写所在城市', icon: 'none' })
      return
    }
    if (this.data.newsScope === s) return
    /* 换了筛选范围，旧列表不再适用：立刻清空并请求，不要先显示上一个范围的内容 */
    this.tabCache.news = null
    this.setData({ newsScope: s, items: [], loading: true, newsError: false })
    this.loadList(true)
  },

  closeNewsSheet() {
    this.setData({ newsSheet: false })
  },

  pickNewsCity(e) {
    this.tabCache.news = null
    this.setData({
      newsCity: e.currentTarget.dataset.v,
      newsScope: 'pick',
      newsSheet: false,
      items: [],
      loading: true,
      newsError: false
    })
    this.loadList(true)
  },

  openNewsPub() {
    /* 发布城市取账号资料里的所在城市，不允许手动修改；未设置时由用户先去「我的」补全 */
    const city = localCity()
    /* 弹层是整屏模态：先收起自定义 tabBar，避免底部「取消 / 发布」被导航栏盖住点不到 */
    this.setTabBarHidden(true)
    this.setData({
      newsLocalCity: city,
      newsPubOpen: true,
      newsSubmitting: false,
      newsPrivate: false,
      newsPub: { title: '', content: '', city: city }
    })
    this.setNewsMedia([])
  },

  /* 媒体集合统一入口：同步九宫格预览与「还能传几张」 */
  setNewsMedia(list) {
    const media = Array.isArray(list) ? list : []
    this.setData({
      newsMedia: media,
      newsMediaUrls: media.filter((m) => m.kind !== 'video').map((m) => m.fileId),
      newsMediaImgCount: media.filter((m) => m.kind === 'image').length,
      newsMediaVideoCount: media.filter((m) => m.kind === 'video').length
    })
  },

  /* 从相册选图：最多 9 张，单张 10MB 以内 */
  chooseNewsImage() {
    if (this.data.newsUploading) return
    const remain = 9 - this.data.newsMediaImgCount
    if (remain <= 0) return wx.showToast({ title: '最多上传 9 张图片', icon: 'none' })
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => this.addNewsMedia('image', (res && res.tempFiles) || [])
    })
  },

  /* 选视频：最多 1 段，60 秒以内，50MB 以内 */
  chooseNewsVideo() {
    if (this.data.newsUploading) return
    if (this.data.newsMediaVideoCount >= 1) return wx.showToast({ title: '最多上传 1 段视频', icon: 'none' })
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      maxDuration: 60,
      success: (res) => this.addNewsMedia('video', (res && res.tempFiles) || [])
    })
  },

  async addNewsMedia(kind, files) {
    const limit = { image: 9, video: 1 }
    const maxBytes = kind === 'image' ? 10 * 1024 * 1024 : 50 * 1024 * 1024
    const current = this.data.newsMedia || []
    const room = limit[kind] - current.filter((m) => m.kind === kind).length
    const picked = []
    let oversize = 0
    for (const f of files) {
      if (picked.length >= room) break
      const size = Number(f && f.size) || 0
      if (size > maxBytes) { oversize += 1; continue }
      picked.push({ f, size })
    }
    if (oversize) wx.showToast({ title: kind === 'image' ? '单张图片不能超过 10MB' : '视频不能超过 50MB', icon: 'none' })
    if (!picked.length) return
    this.setData({ newsUploading: true })
    wx.showLoading({ title: '上传中', mask: true })
    const added = []
    try {
      for (let i = 0; i < picked.length; i += 1) {
        const { f, size } = picked[i]
        const path = f.tempFilePath
        const ext = (String(path).match(/\.([a-z0-9]+)$/i) || [])[1] || (kind === 'video' ? 'mp4' : 'jpg')
        const type = kind === 'video'
          ? (ext === 'mov' ? 'video/quicktime' : 'video/mp4')
          : ({ png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg')
        const up = await uploadFile(path, { cloudPath: 'news/' + kind + '/' + Date.now() + '-' + i + '.' + ext })
        const fileId = typeof up === 'string' ? up : ((up && (up.fileId || up.url)) || '')
        if (!fileId) throw new Error('上传失败')
        added.push({
          key: 'nm' + Date.now() + i,
          kind,
          name: String(f.name || (kind === 'video' ? '视频' : '图片')).slice(0, 30),
          type,
          size,
          fileId
        })
      }
      this.setNewsMedia(current.concat(added))
    } catch (err) {
      if (added.length) this.setNewsMedia(current.concat(added))
      wx.showToast({ title: (err && err.message) || '上传失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ newsUploading: false })
    }
  },

  removeNewsMedia(e) {
    const key = e.currentTarget.dataset.key
    this.setNewsMedia((this.data.newsMedia || []).filter((m) => m.key !== key))
  },

  previewNewsImage(e) {
    const src = e.currentTarget.dataset.src
    const list = e.currentTarget.dataset.list || []
    if (!src) return
    wx.previewImage({ current: src, urls: list.length ? list : [src] })
  },

  closeNewsPub() {
    this.setData({ newsPubOpen: false })
    this.setTabBarHidden(false)
  },

  /* 自定义 tabBar 的显隐：发布资讯弹层打开时隐藏，关闭后恢复 */
  setTabBarHidden(hidden) {
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (bar && bar.setData && bar.data && bar.data.hidden !== hidden) bar.setData({ hidden })
  },

  onNewsPubInput(e) {
    const f = e.currentTarget.dataset.f
    if (!f) return
    const d = Object.assign({}, this.data.newsPub)
    d[f] = e.detail.value
    this.setData({ newsPub: d })
  },

  toggleNewsPrivate(e) {
    const on = e && e.detail && typeof e.detail.value === 'boolean'
      ? e.detail.value
      : !this.data.newsPrivate
    this.setData({ newsPrivate: on })
  },

  submitNews() {
    if (this.data.newsSubmitting) return
    if (this.data.newsUploading) return wx.showToast({ title: '媒体还在上传，请稍候', icon: 'none' })
    const d = this.data.newsPub
    const title = String(d.title || '').trim()
    const content = String(d.content || '').trim()
    /* 发布城市跟随账号资料，前端不提供编辑入口，提交时再取一次最新值 */
    const city = localCity()
    /* 长度口径与服务端 normalizeNewsInput 一致，避免提交后才被驳回 */
    if (title.length < 4) return wx.showToast({ title: '标题至少 4 个字', icon: 'none' })
    if (content.length < 10) return wx.showToast({ title: '内容至少 10 个字', icon: 'none' })
    if (!city) return wx.showToast({ title: '未设置城市，请先在「我的」填写所在城市', icon: 'none' })
    this.setData({ newsSubmitting: true })
    /* 发布即展示：服务端自动筛查违禁词，命中会直接驳回并返回原因 */
    request('user', 'news.submit', {
      title,
      content,
      city,
      media: (this.data.newsMedia || []).map((m) => ({
        name: m.name,
        type: m.type,
        size: m.size,
        fileId: m.fileId
      })),
      visibility: this.data.newsPrivate ? 'private' : 'public'
    }, { silent: true })
      .then(() => {
        this.setData({ newsSubmitting: false, newsPubOpen: false, newsScope: 'all', newsLocalCity: city })
        this.setNewsMedia([])
        this.setTabBarHidden(false)
        this.tabCache.news = null
        this.loadList(true)
        wx.showToast({ title: '发布成功，资讯圈可见', icon: 'none' })
      })
      .catch((err) => {
        this.setData({ newsSubmitting: false })
        wx.showToast({ title: (err && err.message) || '提交失败，请稍后重试', icon: 'none' })
      })
  },

  /* ---------- 算力工具：部署 / 微调 / 功耗 / 回本四个测算 ---------- */

  openTools() {
    wx.navigateTo({ url: '/pages/tools/tools' })
  },

  /* 首页工具入口「我的库存」：维护现货清单，用于商机自动匹配 */
  goStock() {
    wx.navigateTo({ url: '/pages/stock/stock' })
  },

  /* 首页工具入口「商机」：已缴费委托 + 求购需求，按库存匹配 */
  goBiz() {
    wx.navigateTo({ url: '/pages/biz/biz' })
  },

  /* 货源：筛选 / 排序已由服务端完成，这里只补收藏等展示态；
     求购：服务端暂不支持这些维度，仍按当前页做本地过滤 */
  applyList(source, isDemand) {
    const f = (this.filters && this.filters[this.data.tab]) || {}
    const kw = this.data.search
    const sort = this.data.sort
    let list = isDemand
      ? source.filter((x) => matchFilter(x, f, true) && matchKeyword(x, kw))
      : source.slice()
    if (isDemand) {
      /* 搜索场景统一按发布时间倒序：最新发布的排前面，避免旧货排在搜索结果首位 */
      if (String(kw || '').trim()) {
        list.sort((a, b) => (Number(b.publishedAt) || 0) - (Number(a.publishedAt) || 0))
      } else if (sort === '预算从高到低') {
        list.sort((a, b) => b.budget - a.budget)
      } else if (sort === '预算从低到高') {
        list.sort((a, b) => a.budget - b.budget)
      }
    }
    // 标记收藏状态；清单进度按实际条目计算，保证与详情页一致
    const type = isDemand ? 'demand' : 'product'
    list = list.map((x) => Object.assign({}, x, {
      fav: fav.isFav(type, x.id),
      checklistDone: x.checklist ? x.checklist.filter((c) => c.ok).length : x.checklistDone,
      checklistTotal: x.checklist ? x.checklist.length : 8
    }))
    this.setData({ items: list, loading: false, hasMore: !!this.hasMore })
    /* 记住这次的渲染结果，下次切回该视图时先铺上去再静默刷新 */
    this.tabCache[this.data.tab] = { items: list }
  },

  toggleFav(e) {
    const id = e.currentTarget.dataset.id
    const type = this.data.tab === 'sell' ? 'product' : 'demand'
    const on = fav.toggleFav(type, id)
    const items = this.data.items.map((x) => (x.id === id ? Object.assign({}, x, { fav: on }) : x))
    this.setData({ items })
    if (this.tabCache) this.tabCache[this.data.tab] = { items }
    wx.showToast({ title: on ? '已收藏' : '已取消收藏', icon: 'none' })
  },

  openDetail(e) {
    const id = e.currentTarget.dataset.id
    /* 资讯卡片不跳详情页 */
    if (this.data.tab === 'news') return
    if (this.data.tab === 'sell') {
      wx.navigateTo({ url: '/pages/product/product?id=' + id })
    } else {
      wx.navigateTo({ url: '/pages/demand/demand?id=' + id })
    }
  },

  /* 点对方头像进入对方主页：私密发布不下发 ownerKey / authorKey，天然无法进入 */
  openOwner(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const nick = e.currentTarget.dataset.nick || ''
    wx.navigateTo({
      url: '/pages/userhome/userhome?key=' + encodeURIComponent(key) + '&nick=' + encodeURIComponent(nick)
    })
  },

  /* 资讯：列表只展示标题与开头，全文进详情页 */
  openNews(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/news/news?id=' + encodeURIComponent(id) })
  },

  /* 信息流互动：只更新当前卡片，不整页重渲染 */
  newsIndex(id) {
    return (this.data.items || []).findIndex((n) => n.id === id)
  },

  patchNewsItem(id, patch) {
    const idx = this.newsIndex(id)
    if (idx < 0) return -1
    const data = {}
    Object.keys(patch).forEach((k) => { data['items[' + idx + '].' + k] = patch[k] })
    this.setData(data)
    const cache = this.tabCache && this.tabCache.news
    if (cache && Array.isArray(cache.items)) {
      const ci = cache.items.findIndex((n) => n.id === id)
      if (ci >= 0) cache.items[ci] = Object.assign({}, cache.items[ci], patch)
    }
    return idx
  },

  async toggleNewsLike(e) {
    const id = e.currentTarget.dataset.id
    const idx = this.newsIndex(id)
    if (idx < 0 || this.newsLiking) return
    const item = this.data.items[idx]
    this.newsLiking = true
    try {
      const res = await request('user', 'news.like', { id, on: !item.liked }, { silent: true })
      this.patchNewsItem(id, { liked: !!(res && res.liked), likes: Number(res && res.likes) || 0 })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '操作失败，请重试', icon: 'none' })
    } finally {
      this.newsLiking = false
    }
  },

  async toggleNewsComments(e) {
    if (!this.data.commentEnabled) return
    const id = e.currentTarget.dataset.id
    const idx = this.newsIndex(id)
    if (idx < 0) return
    if (this.data.items[idx].commentOpen) {
      this.patchNewsItem(id, { commentOpen: false })
      return
    }
    this.patchNewsItem(id, { commentOpen: true, commentLoading: true })
    await this.loadNewsComments(id)
  },

  async loadNewsComments(id) {
    if (!this.data.commentEnabled) return
    try {
      const res = await request('user', 'news.comment.list', { id, page: 1, limit: 20 }, { silent: true })
      const items = (res && res.items) || []
      const total = Number(res && res.total)
      this.patchNewsItem(id, {
        comments: items,
        commentCount: Number.isFinite(total) ? total : items.length,
        commentLoading: false
      })
    } catch (err) {
      this.patchNewsItem(id, { commentLoading: false })
      wx.showToast({ title: (err && err.message) || '评论加载失败', icon: 'none' })
    }
  },

  onNewsCommentInput(e) {
    if (!this.data.commentEnabled) return
    const id = e.currentTarget.dataset.id
    this.patchNewsItem(id, { commentDraft: e.detail.value })
  },

  /* 点评论框时展开评论列表（已展开则不重复拉取） */
  onNewsCommentFocus(e) {
    if (!this.data.commentEnabled) return
    const id = e.currentTarget.dataset.id
    const idx = this.newsIndex(id)
    if (idx < 0 || this.data.items[idx].commentOpen) return
    this.patchNewsItem(id, { commentOpen: true, commentLoading: true })
    this.loadNewsComments(id)
  },

  async sendNewsComment(e) {
    if (!this.data.commentEnabled) return
    const id = e.currentTarget.dataset.id
    const idx = this.newsIndex(id)
    if (idx < 0 || this.newsCommentSending) return
    const content = String(this.data.items[idx].commentDraft || '').trim()
    if (!content) return wx.showToast({ title: '请先输入评论内容', icon: 'none' })
    this.newsCommentSending = true
    try {
      await request('user', 'news.comment.add', { id, content }, { silent: true })
      this.patchNewsItem(id, { commentDraft: '' })
      await this.loadNewsComments(id)
      wx.showToast({ title: '评论成功', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '评论失败，请重试', icon: 'none' })
    } finally {
      this.newsCommentSending = false
    }
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/publish/publish' })
  },

  onPullDownRefresh() {
    this.loadList(true)
    this.loadBizBadge()
    /* 下拉即拉取最新横幅：后台改完内容 / 开关，下拉一次就生效 */
    this.loadBanner(true)
    if (this.pullTimer) clearTimeout(this.pullTimer)
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null
      wx.stopPullDownRefresh()
    }, 400)
  },

  /* 离开首页（切 tab / 进详情 / 发布）时停掉角标定时器 */
  onHide() {
    this.stopBizTimer()
  },

  onUnload() {
    this.stopBizTimer()
    if (this.onKbChange && typeof wx.offKeyboardHeightChange === 'function') {
      wx.offKeyboardHeightChange(this.onKbChange)
    }
    /* 注销给 tabBar 的切换回调：页面已销毁，再调用会 setData 报错 */
    const app = getApp()
    if (app && app.globalData && app.globalData.homeSwitch === this.homeSwitchHandler) {
      app.globalData.homeSwitch = null
    }
    /* 页面卸载时清掉延迟任务，避免回调里 setData 报错 */
    if (this.listTimer) {
      clearTimeout(this.listTimer)
      this.listTimer = null
    }
    if (this.pullTimer) {
      clearTimeout(this.pullTimer)
      this.pullTimer = null
    }
    if (this.bannerTimer) {
      clearTimeout(this.bannerTimer)
      this.bannerTimer = null
    }
  }
})
