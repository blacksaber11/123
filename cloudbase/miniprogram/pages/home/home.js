/* 首页：四个视图（在售货源 / 求购需求 / 实时货盘 / 资讯圈）+ 工具入口 + 搜索 + 排序筛选条 */
const { gate, getUser } = require('../../utils/auth')
const guard = require('../../utils/guard')
const M = require('../../utils/mock')
const fav = require('../../utils/fav')
const shop = require('../../utils/shop')
const { request } = require('../../utils/request')

const SELL_SORTS = ['综合', '价格升序', '价格降序', '最新', '成交优先']
const DEMAND_SORTS = ['最新发布', '预算从高到低', '预算从低到高']

/* 设备类型与品牌直接取自设备目录，目录里新增品类后筛选面板自动跟上 */
const DEVICE_CATS = Object.keys(M.DEVICE_TREE || {})
const DEFAULT_BRAND_CATS = ['GPU 服务器', 'GPU 加速卡', 'AI 一体机']
function brandOptsOf(cats) {
  const list = []
  const src = (cats && cats.length) ? cats : DEFAULT_BRAND_CATS
  src.forEach((c) => {
    Object.keys(M.DEVICE_TREE[c] || {}).forEach((b) => { if (list.indexOf(b) < 0) list.push(b) })
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

/* 交易城市：大区 → 城市两级菜单，城市取自算力设备交易与机房资源集中的区域，
   除一线城市外也覆盖廊坊、张家口、芜湖等数据中心枢纽。城市筛选由专用菜单渲染，
   因此 city 的 opts 留空，由 CITY_TREE 提供选项。 */
const CITY_TREE = [
  { p: '热门', cities: ['深圳', '北京', '上海', '杭州', '成都', '广州', '武汉', '南京', '苏州', '西安', '重庆', '东莞'] },
  { p: '华北', cities: ['北京', '天津', '石家庄', '廊坊', '张家口', '太原', '呼和浩特'] },
  { p: '东北', cities: ['沈阳', '大连', '长春', '哈尔滨', '大庆'] },
  { p: '华东', cities: ['上海', '南京', '苏州', '无锡', '常州', '南通', '杭州', '宁波', '温州', '嘉兴', '合肥', '芜湖', '福州', '厦门', '泉州', '济南', '青岛', '南昌', '赣州'] },
  { p: '华中', cities: ['武汉', '宜昌', '襄阳', '长沙', '株洲', '郑州', '洛阳'] },
  { p: '华南', cities: ['广州', '深圳', '东莞', '佛山', '珠海', '惠州', '中山', '汕头', '南宁', '桂林', '海口', '三亚'] },
  { p: '西南', cities: ['成都', '绵阳', '重庆', '贵阳', '昆明', '拉萨'] },
  { p: '西北', cities: ['西安', '咸阳', '兰州', '西宁', '银川', '乌鲁木齐'] }
]

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

/* 关键字匹配：空格分词，全部命中才算匹配 */
function matchKeyword(x, kw) {
  const words = String(kw || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [x.title, x.cat, x.brand, x.model, x.city, x.subText, x.note].join(' ').toLowerCase()
  return words.every((w) => hay.indexOf(w.toLowerCase()) >= 0)
}

/* ============================================================
   实时货盘：自动聚合平台在售商品与用户粘贴的报价，按产品类型筛选。
   代采 / 代售委托只在商机池展示，不进入货盘。
   云端 agency.board / quote.paste 就绪前回落本地演示数据，
   与 consult 页「本地演示、云端到达后覆盖」同一模式。
   ============================================================ */
const MARKET_SORTS = ['最新', '价格升序', '价格降序']
const NEWS_SORTS = ['最新发布', '官方优先']

/* 实时货盘：卖价来自平台在售商品与用户报价；代采 / 代售只在商机池展示。 */
const BOARD_DEMO = [
  { id: 'b1', cat: 'GPU 加速卡', model: 'H100 80G SXM', buyPrice: 215000, sellPrice: 228000, buyCount: 6, sellCount: 4, city: '上海', updated: '3 分钟前' },
  { id: 'b2', cat: 'GPU 加速卡', model: 'A100 80G PCIE', buyPrice: 96000, sellPrice: 102000, buyCount: 4, sellCount: 7, city: '深圳', updated: '12 分钟前' },
  { id: 'b3', cat: 'GPU 加速卡', model: 'RTX 4090 24G', buyPrice: 15400, sellPrice: 16300, buyCount: 11, sellCount: 9, city: '东莞', updated: '25 分钟前' },
  { id: 'b4', cat: 'GPU 服务器', model: '8 卡 H100 HGX 整机', buyPrice: 1780000, sellPrice: 1890000, buyCount: 2, sellCount: 1, city: '张家口', updated: '40 分钟前' },
  { id: 'b5', cat: '内存条', model: 'DDR5 64G 6400 金百达', buyPrice: 1780, sellPrice: 1880, buyCount: 8, sellCount: 12, city: '杭州', updated: '1 小时前' },
  { id: 'b6', cat: '内存条', model: 'DDR5 RDIMM 96G 5600', buyPrice: 3850, sellPrice: 4050, buyCount: 5, sellCount: 3, city: '北京', updated: '1 小时前' },
  { id: 'b7', cat: '服务器整机', model: '4 卡 L40S 推理整机', buyPrice: 420000, sellPrice: 448000, buyCount: 3, sellCount: 2, city: '成都', updated: '2 小时前' },
  { id: 'b8', cat: '其他配件', model: '企业级 SSD 3.84T NVMe', buyPrice: 2050, sellPrice: 2180, buyCount: 6, sellCount: 5, city: '南京', updated: '2 小时前' }
]

/* 实时货盘分类：固定主品类打底，再合并货盘里出现的品类。
   货盘为空（云端还没数据 / 接口不可用）时也要有分类可筛，不能只剩「全部」 */
const BOARD_MAIN_CATS = ['GPU 服务器', 'GPU 加速卡', 'AI 一体机', '推理服务器', 'CPU 服务器', 'NPU 加速卡', '消费级显卡', 'AI 工作站', '内存条', '服务器配件']

function boardCatList(list) {
  const cats = ['全部']
  BOARD_MAIN_CATS.forEach((c) => { if (cats.indexOf(c) < 0) cats.push(c) })
  ;(list || []).forEach((b) => { if (b.cat && cats.indexOf(b.cat) < 0) cats.push(b.cat) })
  return cats
}

/* 资讯圈：官方资讯 + 用户发布，按发布地址做全国 / 同城 / 指定城市筛选 */
const NEWS_DEMO = [
  { id: 'nw1', official: true, cat: '平台公告', title: '代采 / 代售服务费规则更新：全部改为成交后支付', summary: '代采 / 代售委托发布、审核、上架全程不收费，成交后再支付服务费：≤3 万元 299 元 / 单，3 万–100 万元 1% 封顶 5,000 元，100 万元以上 0.5% 上不封顶；算力租赁按首月租金合计，买卖双方各承担 50%。', city: '上海', author: '平台运营', published: '2 小时前', views: 1862 },
  { id: 'nw2', official: true, cat: '行情', title: 'H100 80G 本周现货报价回落 4%，整机交付周期缩短', summary: '受新增到货影响，华东、华南两地 H100 单卡报价环比回落约 4%，8 卡整机交付周期从 4 周缩短到 2–3 周。', city: '深圳', author: '平台行情组', published: '5 小时前', views: 2431 },
  { id: 'nw3', official: false, cat: '求购', title: '深圳南山求购 A100 80G PCIE 20 张，可含税', summary: '预算 9.6 万 / 张以内，要求原厂质保剩余 1 年以上，支持现场验货，本月内交付。', city: '深圳', author: '陈先生', published: '30 分钟前', views: 236 },
  { id: 'nw4', official: false, cat: '出货', title: '张家口机房清退一批 8 卡 H100 HGX 整机', summary: '共 4 台，成色九成新，含原机柜与交换机，支持整批或拆售，可安排现场验机。', city: '张家口', author: '华北算力', published: '1 小时前', views: 812 },
  { id: 'nw5', official: true, cat: '避坑指南', title: '居间交易防跳单：平台如何保障委托双方权益', summary: '委托方与货主直接加微信后绕开平台，是算力设备交易最常见的纠纷来源。本文说明平台的流程留痕、节点确认与资金隔离方式。', city: '北京', author: '平台运营', published: '昨天', views: 1580 },
  { id: 'nw6', official: false, cat: '租赁', title: '杭州机房释放 32 台 A800 整机，可月付', summary: '单机 8 卡，带宽 200G IB，起租 3 个月，可月付；同城可上门看机，异地支持远程压测。', city: '杭州', author: '云栖算力', published: '昨天', views: 967 },
  { id: 'nw7', official: false, cat: '求购', title: '成都求购 DDR5 64G 6400 内存 200 根', summary: '品牌不限，要求原厂颗粒、可开专票，单价 1800 元以内，一周内到货。', city: '成都', author: '西南智算', published: '2 天前', views: 348 }
]

const CITY_FLAT = []
CITY_TREE.forEach((g) => g.cities.forEach((c) => { if (CITY_FLAT.indexOf(c) < 0) CITY_FLAT.push(c) }))

/* 同城口径：优先取登录用户资料里的所在城市；未登录时给一个可切换的默认值 */
function localCity() {
  try {
    const u = getUser()
    if (u && u.city) return String(u.city).replace(/市$/, '')
    return wx.getStorageSync('city') || '深圳'
  } catch (e) {
    return '深圳'
  }
}

function fmtPrice(n) {
  return String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtClock() {
  const d = new Date()
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
}

/* 按型号猜品类：内存商粘贴的大多是小货，猜不中的归「其他配件」 */
function guessCat(model) {
  const s = String(model || '')
  if (/DDR\d|内存/i.test(s)) return '内存条'
  if (/H100|A100|B200|B300|4090|加速卡|显卡/i.test(s)) return 'GPU 加速卡'
  if (/整机|服务器|HGX/i.test(s)) return '服务器整机'
  return '其他配件'
}

/* 粘贴解析（演示口径）：一行 = 一条报价，提取型号 / 价格 / 数量 / 城市。
   解析不到的字段留空，交给发布者在预览里确认后删除，宁可少提取不乱猜。 */
function parseQuoteLine(line) {
  const ln = String(line || '').replace(/^\s*[\d]+[\.、)）]\s*/, '').trim()
  if (!ln) return null
  let price = 0
  const pm = ln.match(/[¥￥]\s*([\d,]+)|([\d,]{3,})\s*(?:元|块)/)
  if (pm) price = Number((pm[1] || pm[2]).replace(/,/g, ''))
  let qty = ''
  let unit = '件'
  const qm = ln.match(/(\d+)\s*(根|条|张|片|台|块|个|组)/)
  if (qm) { qty = qm[1]; unit = qm[2] }
  let city = ''
  CITY_FLAT.forEach((c) => { if (!city && ln.indexOf(c) >= 0) city = c })
  let model = ln
  if (pm) model = model.split(pm[0])[0]
  model = model.replace(/[¥￥][\d,.]*\s*(?:元|块)?/g, ' ')
    .replace(/\d+\s*(根|条|张|片|台|块|个|组)/g, ' ')
  if (city) model = model.split(city).join(' ')
  model = model.replace(/[-–—|｜,，、;；:：\s]+/g, ' ').trim()
  if (!model && !price) return null
  return {
    title: model || '未命名报价',
    cat: guessCat(model),
    model: model || '未命名报价',
    price,
    priceText: price > 0 ? '¥ ' + fmtPrice(price) : '价格面议',
    qty: qty || '面议',
    unit,
    city: city || '城市未填写',
    hoursLeft: 24
  }
}

Page({
  data: {
    tab: 'sell',
    /* 朋友圈单页模式：只做浏览，底部提示从右上角进入完整小程序 */
    singlePage: false,
    sortOptions: SELL_SORTS,
    sort: '综合',
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
    /* 商机角标：与我的库存匹配、尚未领取的商机数量（未登录为 0） */
    bizBadge: 0,
    /* 资讯圈：全国 / 同城 / 指定城市，按发布地址筛选 */
    newsScope: 'all',
    newsLocalCity: '',
    newsCity: '',
    newsCityOptions: CITY_FLAT,
    newsSheet: false,
    newsStats: { city: '全国' },
    newsPubOpen: false,
    newsPub: { title: '', content: '', city: '' },
    /* 资讯私密发布：默认关闭；开启后不显示发布人、不进主页 */
    newsPrivate: false,
    newsSubmitting: false,
    /* 实时货盘：买价 / 卖价 + 产品类型筛选（先展示主品类，云端数据回来再合并） */
    boardCats: boardCatList([]),
    boardCat: '全部',
    boardStats: { count: 0, updatedAt: '' },
    /* 粘贴发布弹层：长文本 → 解析预览 → 确认发布（补充卖方报价） */
    pasteOpen: false,
    pasteText: '',
    pastePreview: [],
    /* 键盘高度：弹层整块抬到键盘上方，底部「发布」按钮始终可见 */
    kbH: 0
  },

  onLoad(options) {
    this.initState()
    /* 弹层内输入时系统会把固定定位的底部按钮压到键盘下方，这里按键盘高度抬升弹层 */
    if (typeof wx.onKeyboardHeightChange === 'function') {
      this.onKbChange = (res) => {
        this.setData({ kbH: Math.max(0, Number(res && res.height) || 0) })
      }
      wx.onKeyboardHeightChange(this.onKbChange)
    }
    this.registerHomeSwitch()
    this.setData(Object.assign(this.filterPatch('sell'), { newsLocalCity: localCity() }))
    /* 分享落地链接带 tab 参数：直接落到对应视图（货源 / 求购 / 货盘 / 资讯） */
    const want = String((options && options.tab) || '')
    if (want && ['sell', 'buy', 'market', 'news'].indexOf(want) >= 0) {
      this.setData({ tab: want, sortOptions: this.sortOptionsOf(want), sort: this.sortStore[want] })
    }
    this.loadList()
  },

  /* 各视图的排序选项：与 goTab 保持同一份口径 */
  sortOptionsOf(tab) {
    return tab === 'sell' ? SELL_SORTS
      : tab === 'buy' ? DEMAND_SORTS
        : tab === 'market' ? MARKET_SORTS : NEWS_SORTS
  },

  /* 各视图的关键字、筛选条件与排序各自保存；onLoad / onShow 都要能安全调用 */
  initState() {
    if (!this.filters) {
      this.keywords = { sell: '', buy: '', market: '', news: '' }
      this.filters = { sell: {}, buy: {}, market: {}, news: {} }
      this.sortStore = { sell: SELL_SORTS[0], buy: DEMAND_SORTS[0], market: MARKET_SORTS[0], news: NEWS_SORTS[0] }
    }
    /* 各视图最近一次的渲染结果：切视图时先用它立刻铺满，再静默刷新，
       避免旧视图的列表残留在屏幕上（切过去还要「等一小会儿」才变） */
    if (!this.tabCache) this.tabCache = { sell: null, buy: null, market: null, news: null }
  },

  onShow() {
    this.initState()
    gate(this.route || 'pages/home/home', this.options)
    /* 底部导航带来的落点会自己触发一次加载，避免和下面的刷新重复请求 */
    const switched = this.applyHomeTab()
    this.syncTabBar()
    /* 弹层没打开时保证导航栏可见（重新编译 / 异常退出弹层后自愈） */
    if (!this.data.newsPubOpen) this.setTabBarHidden(false)
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
    this.loadBizBadge()
    this.startBizTimer()
    /* 在线心跳：登录后回到首页时 app.onShow 不会再触发，这里补一次 */
    const me = getUser()
    if (me && me.uid) request('user', 'online.ping', {}, { silent: true }).catch(() => {})
  },

  /* 分享卡片：首页三个视图（货源 / 求购 / 资讯）文案各不相同 */
  onShareAppMessage() {
    const tab = this.data.tab
    if (tab === 'news') {
      return {
        title: '算力聚合 · 行情与避坑指南',
        desc: 'H100 / A100 报价行情、机房清退与交易避坑',
        imageUrl: '/assets/share/card-home.png',
        path: '/pages/home/home?tab=news'
      }
    }
    if (tab === 'buy') {
      return {
        title: '算力聚合 · 正在求购的算力需求',
        desc: '求购与租赁需求持续更新，条件对齐即可直接响应',
        imageUrl: '/assets/share/card-demand.png',
        path: '/pages/home/home?tab=buy'
      }
    }
    if (tab === 'market') {
      return {
        title: '算力聚合 · 实时货盘与囤货榜单',
        desc: '按品类与型号汇总的买卖盘口，帮你判断囤货方向',
        imageUrl: '/assets/share/card-biz.png',
        path: '/pages/home/home?tab=market'
      }
    }
    return {
      title: '算力聚合 · 算力货源直连',
      desc: 'GPU 服务器 / 内存 / 整机，先确认条件再与货主直接对话',
      imageUrl: '/assets/share/card-product.png',
      path: '/pages/home/home?tab=sell'
    }
  },

  /* 分享到朋友圈：单页模式只能浏览，title / query 与好友分享保持同一口径 */
  onShareTimeline() {
    const tab = this.data.tab
    if (tab === 'news') {
      return { title: '算力聚合 · 行情与避坑指南', query: 'tab=news', imageUrl: '/assets/share/card-home.png' }
    }
    if (tab === 'buy') {
      return { title: '算力聚合 · 正在求购的算力需求', query: 'tab=buy', imageUrl: '/assets/share/card-demand.png' }
    }
    if (tab === 'market') {
      return { title: '算力聚合 · 实时货盘与囤货榜单', query: 'tab=market', imageUrl: '/assets/share/card-biz.png' }
    }
    return { title: '算力聚合 · 算力货源直连', query: 'tab=sell', imageUrl: '/assets/share/card-product.png' }
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
    this.goTab(want)
    return true
  },

  // 自定义 tabBar 的选中态由页面自己同步：首页 / 资讯 共用一页，按目标视图区分
  // 传 tab 是为了在 setData 之前就把高亮切过去，避免数据还没回来时高亮还停在旧项
  syncTabBar(tab) {
    const t = tab || this.data.tab
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (bar && bar.setData) bar.setData({ selected: t === 'news' ? 1 : 0 })
  },

  // 从详情页返回时同步收藏状态（资讯 / 货盘没有收藏）
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

  /* 切视图：各视图的关键字、筛选条件与排序各自保存 */
  goTab(tab) {
    if (!tab) return
    /* 底部导航把「首页」传 sell、「资讯」传 news；未知落点统一回在售货源。
       页内「实时货盘 / 求购需求」入口仍按 market / buy 正常切换。 */
    const target = ['sell', 'buy', 'market', 'news'].indexOf(tab) >= 0 ? tab : 'sell'
    this.initState()
    /* 先同步高亮：即使目标视图与当前一致，点击也要有可见反馈 */
    this.syncTabBar(target)
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
    if (cached && target === 'market') {
      Object.assign(patch, {
        boardCats: cached.boardCats,
        boardCat: cached.boardCat,
        boardStats: cached.boardStats
      })
    }
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
    /* 资讯圈 / 实时货盘没有筛选面板：返回空分组，排序条上的筛选入口同步隐藏 */
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
   * 商机角标：只取数量，不拉商机卡片。
   * 只要按库存 / 已发布需求匹配到商机就显示，未开通也提示（用于引导开通）；
   * 已领取的商机不再计入，只有发布方删除 / 关闭条目后才会减少。
   */
  loadBizBadge() {
    const me = getUser()
    if (!me || !me.uid) {
      if (this.data.bizBadge) this.setData({ bizBadge: 0 })
      this.syncTabBizBadge(0)
      return
    }
    request('user', 'biz.badge', {}, { silent: true })
      .then((res) => {
        const n = Math.max(0, Number(res && res.count) || 0)
        if (n !== this.data.bizBadge) this.setData({ bizBadge: n })
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
    /* 实时货盘：价格来自在售商品与用户报价，云端就绪前回落本地演示数据 */
    if (this.data.tab === 'market') {
      this.fetchQuotes(seq)
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

  /* 触底加载下一页：只对货源 / 求购生效，货盘与资讯一次取回 */
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
    try {
      const body = { page: page || 1, limit: 20 }
      /* 关键词交给后端检索，才能搜到第 1 页之后的数据 */
      if (q) body.q = q
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

  /* 实时货盘：聚合平台在售商品与 24 小时内的卖方报价，代采 / 代售只进商机池 */
  async fetchQuotes(seq) {
    let list = null
    try {
      const res = await request('user', 'agency.board', { page: 1, limit: 50 }, { silent: true })
      if (res && Array.isArray(res.items)) list = res.items.map((b) => Object.assign({}, b))
    } catch (e) {}
    if (seq !== this.listSeq || this.data.tab !== 'market') return
    if (list === null) list = BOARD_DEMO.map((b) => Object.assign({}, b))
    /* 产品类型筛选：主品类打底 + 云端数据里出现的品类；已选品类失效时回到「全部」 */
    const cats = boardCatList(list)
    const cat = cats.indexOf(this.data.boardCat) >= 0 ? this.data.boardCat : '全部'
    this.boardSource = list
    this.setData({
      boardCats: cats,
      boardCat: cat,
      boardStats: { count: list.length, updatedAt: fmtClock() }
    })
    this.applyBoard()
  },

  /* 买价 = 货盘最高预算，卖价 = 货盘最低报价；价差按卖价 - 买价计算 */
  applyBoard() {
    const cat = this.data.boardCat
    const kw = this.data.search
    let list = (this.boardSource || []).filter((b) => (cat === '全部' || b.cat === cat) && matchKeyword(b, kw))
    list = list.map((b) => {
      const buy = Number(b.buyPrice) || 0
      const sell = Number(b.sellPrice) || 0
      const spread = (buy > 0 && sell > 0) ? sell - buy : 0
      return Object.assign({}, b, {
        buyText: buy > 0 ? '¥ ' + fmtPrice(buy) : '待补充',
        sellText: sell > 0 ? '¥ ' + fmtPrice(sell) : '待补充',
        spreadText: (buy > 0 && sell > 0) ? (spread >= 0 ? '价差 +' : '价差 ') + fmtPrice(spread) : '待撮合',
        spreadPct: (buy > 0 && sell > 0) ? (spread / buy * 100).toFixed(1) : ''
      })
    })
    this.setData({ items: list, loading: false })
    this.tabCache.market = {
      items: list,
      boardCats: this.data.boardCats,
      boardCat: cat,
      boardStats: this.data.boardStats
    }
  },

  pickBoardCat(e) {
    this.setData({ boardCat: e.currentTarget.dataset.v })
    this.applyBoard()
  },

  /* ---------- 资讯圈 ---------- */

  /* 云端 news.list 就绪前回落演示数据 + 本机刚发布的资讯 */
  async fetchNews(seq) {
    let list = null
    let mine = []
    /* 资讯列表与「我的投稿」并行请求：两个串行会多一个来回，切过来要白等一程 */
    const [newsRes, ownRes] = await Promise.all([
      request('user', 'news.list', {
        page: 1,
        limit: 50,
        scope: this.data.newsScope,
        city: this.newsTargetCity()
      }, { silent: true }).catch(() => null),
      request('user', 'news.mine', {}, { silent: true }).catch(() => null)
    ])
    if (newsRes && Array.isArray(newsRes.items)) list = newsRes.items
    /* 自己的投稿：审核中 / 被驳回也要看得见，不能「投了就消失」 */
    if (ownRes && Array.isArray(ownRes.items)) mine = ownRes.items
    if (seq !== this.listSeq || this.data.tab !== 'news') return
    if (list === null) {
      list = (this.localNews || []).concat(NEWS_DEMO)
    } else {
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
      list = pending.concat(list)
    }
    this.applyNews(list)
  },

  newsTargetCity() {
    if (this.data.newsScope === 'city') return this.data.newsLocalCity
    if (this.data.newsScope === 'pick') return this.data.newsCity
    return ''
  },

  /* 按发布地址筛选 + 关键字匹配；官方优先时把官方资讯排到前面 */
  applyNews(source) {
    const city = cityOf({ city: this.newsTargetCity() })
    const words = String(this.data.search || '').trim().split(/\s+/).filter(Boolean)
    let list = source.filter((n) => {
      if (city && cityOf({ city: n.city }) !== city) return false
      const hay = [n.title, n.summary, n.cat, n.city, n.author].join(' ').toLowerCase()
      return words.every((w) => hay.indexOf(w.toLowerCase()) >= 0)
    })
    if (this.data.sort === '官方优先') {
      list = list.slice().sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0))
    }
    this.setData({
      items: list,
      loading: false,
      newsStats: { city: city || '全国' }
    })
    this.tabCache.news = { items: list, newsStats: { city: city || '全国' } }
  },

  switchNewsScope(e) {
    const s = e.currentTarget.dataset.scope
    if (s === 'pick') {
      this.setData({ newsSheet: true })
      return
    }
    if (this.data.newsScope === s) return
    /* 换了筛选范围，旧列表不再适用：立刻清空并请求，不要先显示上一个范围的内容 */
    this.tabCache.news = null
    this.setData({ newsScope: s, items: [], loading: true })
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
      loading: true
    })
    this.loadList(true)
  },

  openNewsPub() {
    /* 发布城市固定读本机定位 / 用户资料，不允许手动修改 */
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
  },

  closeNewsPub() {
    this.setTabBarHidden(false)
    this.setData({ newsPubOpen: false })
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
    const d = this.data.newsPub
    const title = String(d.title || '').trim()
    const content = String(d.content || '').trim()
    /* 发布城市跟随本机定位，前端不提供编辑入口，提交时再取一次最新值 */
    const city = localCity()
    /* 长度口径与服务端 normalizeNewsInput 一致，避免提交后才被驳回 */
    if (title.length < 4) return wx.showToast({ title: '标题至少 4 个字', icon: 'none' })
    if (content.length < 10) return wx.showToast({ title: '内容至少 10 个字', icon: 'none' })
    if (!city) return wx.showToast({ title: '未获取到定位城市，请先在「我的」设置所在城市', icon: 'none' })
    this.setData({ newsSubmitting: true })
    /* 发布即展示：服务端自动筛查违禁词，命中会直接驳回并返回原因 */
    request('user', 'news.submit', {
      title,
      content,
      city,
      visibility: this.data.newsPrivate ? 'private' : 'public'
    }, { silent: true })
      .then(() => {
        this.setData({ newsSubmitting: false, newsPubOpen: false, newsScope: 'all', newsLocalCity: city })
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

  /* 粘贴发布：长文本 → 解析预览 → 补充卖方报价（云端 quote.paste 就绪前为演示态） */
  openPaste() {
    this.setData({ pasteOpen: true, pasteText: '', pastePreview: [] })
  },

  closePaste() {
    this.setData({ pasteOpen: false })
  },

  onPasteInput(e) {
    this.setData({ pasteText: e.detail.value })
  },

  parsePaste() {
    if (!String(this.data.pasteText || '').trim()) {
      wx.showToast({ title: '先粘贴一段报价文字', icon: 'none' })
      return
    }
    const lines = String(this.data.pasteText).split(/[\n;；]+/)
    const rows = lines.map((l) => parseQuoteLine(l)).filter(Boolean)
    if (!rows.length) {
      wx.showToast({ title: '没有解析出报价，请检查文字格式', icon: 'none' })
      return
    }
    this.setData({
      pastePreview: rows.map((r, i) => Object.assign({ id: 'pv' + (i + 1) }, r))
    })
  },

  removePreview(e) {
    const i = Number(e.currentTarget.dataset.i) || 0
    const rows = this.data.pastePreview.slice()
    rows.splice(i, 1)
    this.setData({ pastePreview: rows })
  },

  async confirmPaste() {
    const rows = this.data.pastePreview
    if (!rows.length) {
      wx.showToast({ title: '先解析出至少一条报价', icon: 'none' })
      return
    }
    /* 先落库再加进货盘：接口失败时保留弹层，不能「本地显示了、服务端没有」 */
    try {
      await request('user', 'quote.paste', { raw: this.data.pasteText, items: rows }, { silent: false })
    } catch (err) {
      /* request 已提示具体原因（频控 / 字段不合规），留在弹层修改 */
      return
    }
    /* 报价并入实时货盘的卖方一侧 */
    const merged = rows.map((r) => ({
      id: 'q' + Date.now() + '-' + r.id,
      cat: r.cat,
      model: r.model,
      buyPrice: 0,
      sellPrice: Number(r.price) || 0,
      buyCount: 0,
      sellCount: 1,
      city: r.city,
      updated: '刚刚'
    })).concat(this.boardSource || [])
    this.boardSource = merged
    this.setData({
      pasteOpen: false,
      pasteText: '',
      pastePreview: [],
      boardCats: boardCatList(merged),
      boardStats: { count: merged.length, updatedAt: fmtClock() }
    })
    this.applyBoard()
    wx.showToast({ title: '已发布 ' + rows.length + ' 条报价，24 小时后自动过期', icon: 'none' })
  },

  /* 委托代采：首页货盘上的入口直接进发布页的代采表单，主体核验与缴费都在那边完成 */
  openDaicai(e) {
    const target = String(e.currentTarget.dataset.target || '')
    wx.navigateTo({ url: '/pages/publish/publish?agency=buy&target=' + encodeURIComponent(target) })
  },

  /* 首页工具入口「我的库存」：维护现货清单，用于商机自动匹配 */
  goStock() {
    wx.navigateTo({ url: '/pages/stock/stock' })
  },

  /* 首页工具入口「商机」：已缴费委托 + 求购需求，按库存匹配 */
  goBiz() {
    wx.navigateTo({ url: '/pages/biz/biz' })
  },

  /* 本地筛选 + 排序 + 收藏态，渲染口径与云端 / 演示数据完全一致 */
  applyList(source, isDemand) {
    const f = (this.filters && this.filters[this.data.tab]) || {}
    const kw = this.data.search
    let list = source.filter((x) => matchFilter(x, f, isDemand) && matchKeyword(x, kw))
    const sort = this.data.sort
    /* 搜索场景统一按发布时间倒序：最新发布的排前面，避免旧货排在搜索结果首位 */
    if (String(kw || '').trim()) {
      list.sort((a, b) => (Number(b.publishedAt) || 0) - (Number(a.publishedAt) || 0))
    } else if (!isDemand) {
      if (sort === '价格升序') list.sort((a, b) => a.price - b.price)
      else if (sort === '价格降序') list.sort((a, b) => b.price - a.price)
      else if (sort === '成交优先') list.sort((a, b) => b.inquiries - a.inquiries)
      // 「最新」与「综合」保持数据源顺序（已按发布时间倒序）
    } else {
      if (sort === '预算从高到低') list.sort((a, b) => b.budget - a.budget)
      else if (sort === '预算从低到高') list.sort((a, b) => a.budget - b.budget)
    }
    // 标记收藏状态；清单进度按实际条目计算，保证与详情页一致
    const type = isDemand ? 'demand' : 'product'
    list = list.map((x) => Object.assign({}, x, {
      fav: fav.isFav(type, x.id),
      checklistDone: x.checklist ? x.checklist.filter((c) => c.ok).length : x.checklistDone,
      checklistTotal: x.checklist ? x.checklist.length : 8
    }))
    this.setData({ items: list, loading: false })
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
    /* 货盘 / 资讯卡片不跳详情页 */
    if (this.data.tab === 'market' || this.data.tab === 'news') return
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

  goPublish() {
    wx.navigateTo({ url: '/pages/publish/publish' })
  },

  onPullDownRefresh() {
    this.loadList(true)
    this.loadBizBadge()
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
  }
})
