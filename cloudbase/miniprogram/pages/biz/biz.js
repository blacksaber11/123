/* 商机：按我的库存自动匹配平台核验后的代采 / 代售委托与求购需求，99 元 / 月开通 */
const biz = require('../../utils/biz')
const guard = require('../../utils/guard')
const fav = require('../../utils/fav')
const sharePoster = require('../../utils/share-poster')
const notify = require('../../utils/notify')
const { request, xpayOrder } = require('../../utils/request')
const { goThread } = require('../../utils/chat')
const { CITY_TREE } = require('../../utils/board')

/* 收藏类型：求购需求 / 代采代售委托 / 货源分开存，避免不同集合的 id 混淆 */
function favTypeOf(o) {
  if (!o) return 'product'
  if (o.type === 'demand') return 'demand'
  if (o.type === 'agency') return 'agency'
  return 'product'
}

/* 分享图兜底：海报未生成 / 低版本基础库时用静态商机底图 */
const SHARE_CARD = '/assets/share/card-biz.png'

/* 列表封面：与普通商品列表同一口径，优先第一张图片，只有视频时用视频封面 */
function coverOfItem(o) {
  const list = (o && Array.isArray(o.media) ? o.media : []).filter(Boolean)
  const items = list.map((m) => ({
    kind: m.kind === 'video' || /^video\//i.test(String(m.type || m.mime || '')) ? 'video' : 'image',
    url: m.url || m.fileId || m.src || '',
    poster: m.poster || m.cover || ''
  })).filter((m) => m.url)
  const img = items.filter((m) => m.kind === 'image')[0]
  return {
    cover: img ? img.url : ((items[0] && items[0].poster) || ''),
    mediaCount: items.length
  }
}


const FILTERS = [
  { key: 'all', label: '全部' },
  { key: '出租', label: '出租' },
  { key: '出售', label: '出售' },
  { key: '求购', label: '购买' },
  { key: '租赁', label: '租赁' },
  { key: '代采', label: '代采' },
  { key: '代售', label: '代售' },
  { key: 'supply', label: '匹配货源' }
]

/* 套餐时长按自然月展示：月度即 1 个月，不写「30 天」 */
const PLAN_TERMS = { month: '1 个月', quarter: '3 个月', half: '6 个月', year: '12 个月' }
const withTerm = (plans) => (Array.isArray(plans) ? plans : []).map((p) => Object.assign({}, p, {
  termText: PLAN_TERMS[p.key] || (p.days ? p.days + ' 天' : '')
}))
const LOCAL_PLANS = withTerm(biz.PLANS)

/* 提示力度：三档预设与后端 BIZ_PREF_PRESETS 同口径，离线预览时也能用 */
const PREF_PRESETS = {
  loose: { level: 'loose', brand: 'any', model: 'series', qty: 'any', cap: 'any', price: 'any', city: 'any', cond: 'any', tax: 'any', supply: 'any', cities: [] },
  standard: { level: 'standard', brand: 'any', model: 'core', qty: 'meet', cap: 'same', price: 'any', city: 'any', cond: 'same', tax: 'any', supply: 'any', cities: [] },
  strict: { level: 'strict', brand: 'same', model: 'exact', qty: 'exceed', cap: 'same', price: 'fit', city: 'same', cond: 'same', tax: 'same', supply: 'same', cities: [] }
}
const PREF_LEVELS = [
  { key: 'loose', name: '宽松', desc: '同系列即可，价格、城市、成色、税费都不限，看到的商机最多' },
  { key: 'standard', name: '标准', desc: '同核心型号、容量一致，数量达到起订量（默认，价格与地区不限）' },
  { key: 'strict', name: '严格', desc: '指定品牌、型号完全一致，库存量覆盖需求，只接同城且税费 / 现货口径一致' }
]

/* 主体信息筛选：独立于匹配力度，默认「全部」；开启后服务端只返回公开主体的商机 */
const SUBJECT_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '仅公开主体' }
]
const PREF_DIMS = [
  { key: 'brand', name: '品牌', options: [{ key: 'any', label: '不限品牌' }, { key: 'same', label: '只接指定品牌' }] },
  {
    key: 'model',
    name: '型号',
    options: [{ key: 'series', label: '同系列即可' }, { key: 'core', label: '同核心型号' }, { key: 'same', label: '同型号（不限品牌）' }, { key: 'exact', label: '型号完全一致' }]
  },
  {
    key: 'qty',
    name: '数量',
    options: [{ key: 'any', label: '数量不限' }, { key: 'meet', label: '达到起订量' }, { key: 'exceed', label: '库存量覆盖需求' }]
  },
  {
    key: 'cap',
    name: '容量',
    options: [{ key: 'any', label: '容量不限' }, { key: 'fit', label: '不低于需求' }, { key: 'same', label: '容量相同' }]
  },
  {
    key: 'price',
    name: '价格',
    options: [{ key: 'any', label: '价格不限' }, { key: 'fit', label: '报价在预算内' }, { key: 'near', label: '可上浮 10%' }]
  },
  {
    key: 'city',
    name: '城市',
    options: [
      { key: 'any', label: '不限地区' },
      { key: 'same', label: '只接同城' },
      { key: 'pick', label: '指定城市（可多选）' }
    ]
  },
  {
    key: 'cond',
    name: '成色',
    options: [{ key: 'any', label: '成色不限' }, { key: 'same', label: '成色一致' }]
  },
  {
    key: 'tax',
    name: '税费',
    options: [{ key: 'any', label: '税费不限' }, { key: 'same', label: '税费口径有交集' }]
  },
  {
    key: 'supply',
    name: '供给',
    options: [{ key: 'any', label: '现货 / 期货不限' }, { key: 'same', label: '现货期货一致' }]
  }
]
const prefNameOf = (level) => ((PREF_LEVELS.filter((l) => l.key === level)[0] || {}).name || '自定义')

/* 指定城市：按大区分组多选。热门城市与地区重复，只保留地区分组，避免同一城市出现两次 */
const PREF_CITY_GROUPS = CITY_TREE.filter((g) => g.p !== '热门')
const PREF_CITY_MAX = 20

/* 已选城市归一：去「市」、去空、去重，与后端 bizCitiesOf 同口径 */
function prefCitiesOf(prefs) {
  const list = prefs && Array.isArray(prefs.cities) ? prefs.cities : []
  const out = []
  list.forEach((item) => {
    const city = String(item == null ? '' : item).trim().replace(/市$/, '').replace(/\s+/g, '')
    if (city && out.indexOf(city) < 0) out.push(city)
  })
  return out
}

/* 城市分组带上选中态：WXML 不支持 indexOf，先在这里算好 */
function cityGroupsOf(prefs) {
  const chosen = prefCitiesOf(prefs)
  return PREF_CITY_GROUPS.map((g) => ({
    p: g.p,
    cities: g.cities.map((name) => ({ name, on: chosen.indexOf(name) >= 0 }))
  }))
}

/* 已选城市摘要：设置入口和维度标题上都能一眼看到选了哪些城市 */
function cityTextOf(prefs) {
  if (!prefs || prefs.city !== 'pick') return ''
  const list = prefCitiesOf(prefs)
  if (!list.length) return '未选城市'
  return list.length <= 2 ? list.join('/') : list.slice(0, 2).join('/') + ' 等 ' + list.length + ' 城'
}

/* 维度当前选中值冗余到 options 外层，避免 WXML 里做对象动态取值 */
const dimsWithValue = (prefs) => PREF_DIMS.map((d) => Object.assign({}, d, {
  value: (prefs && prefs[d.key]) || '',
  /* 城市维度额外给出已选摘要，收起或切到其他维度时也能确认 */
  extra: d.key === 'city' ? cityTextOf(prefs) : ''
}))

/* 设置面板的一次性视图字段：改完偏好统一走这里，避免各处漏同步 */
function prefView(prefs) {
  const onlyOpenSubject = !!(prefs && prefs.onlyOpenSubject)
  return {
    prefs,
    prefLevelName: prefNameOf(prefs.level),
    prefDims: dimsWithValue(prefs),
    prefCityGroups: cityGroupsOf(prefs),
    prefCityText: cityTextOf(prefs),
    /* 主体信息：全部 / 仅公开主体，默认全部 */
    prefSubject: onlyOpenSubject ? 'open' : 'all'
  }
}

/* 显示时间：与后端 BIZ_PREF_DAYS 同口径，3 / 7 / 30 天，也可手动填 1-90 天 */
const DAY_OPTIONS = [
  { key: 3, label: '3 天内' },
  { key: 7, label: '一周内' },
  { key: 30, label: '一个月内' }
]
const dayLabelOf = (days) => {
  const n = Math.floor(Number(days) || 0)
  if (n === 3) return '3 天内'
  if (n === 7) return '一周内'
  if (n === 30) return '一个月内'
  return n > 0 ? n + ' 天内' : '一个月内'
}

/* 排序：与后端 BIZ_PREF_SORTS 同口径 */
const SORT_OPTIONS = [
  { key: 'latest', label: '最新发布' },
  { key: 'match', label: '库存优先' },
  { key: 'qty', label: '数量优先' }
]
const sortLabelOf = (sort) => ((SORT_OPTIONS.filter((s) => s.key === sort)[0] || SORT_OPTIONS[0]).label)

Page({
  data: {
    plan: biz.PLAN.label,
    price: biz.PLAN.price,
    /* 会员状态：unlocked / expireText 由云端返回，paying 控制按钮防重 */
    unlocked: false,
    expireText: '',
    /* 会员剩余天数倒计时：按自然月到期，由云端 daysLeft 返回 */
    daysLeft: 0,
    /* 微信虚拟支付进行中：按钮 loading，避免重复拉起收银台 */
    paying: false,
    /* 7 天体验：每个账号一次，未开通且未用过时展示体验按钮 */
    trialing: false,
    trialAvailable: false,
    /* 会员四档：管理端设置页可改价格 / 天数，用户端在此选择 */
    plans: LOCAL_PLANS,
    planKey: 'month',
    selectedPlan: LOCAL_PLANS[0],
    /* 是否已连上云端：云端模式不再提供「模拟开通」 */
    remote: false,
    stats: { matched: 0, agency: 0, demands: 0, claimed: 0, open: 0, unsatisfied: 0, stock: { sku: 0, qty: 0 } },
    state: 'open',
    filters: FILTERS,
    filter: 'all',
    filterLabel: '全部',
    /* 筛选栏展开态：cat / sort / model，同一时刻只展开一个，可叠加筛选 */
    filterMenu: '',
    items: [],
    total: 0,
    /* 主体信息筛选开启后，服务端返回被筛掉的条数 */
    hiddenCount: 0,
    /* 列表默认只展示 10 条，下滑继续加载；型号筛选只能从本次匹配到的型号里选 */
    showCount: 10,
    matchModels: [],
    modelFilter: '',
    filteredCount: 0,
    /* 未开通宣传页：只放脱敏预览，固定 10 条高度内部滑动 */
    teaserItems: [],
    /* 手动天数输入框里的临时值，点「确定」才写入偏好 */
    daysInput: '',
    dayOptions: DAY_OPTIONS,
    sortOptions: SORT_OPTIONS,
    dayLabel: '一个月内',
    sortLabel: '最新发布',
    daysCustom: false,
    /* 平台对接按钮 loading：同一时刻只允许提交一张卡片 */
    consultingId: '',
    sheetOpen: false,
    /* 已登录但 biz.list 失败：给出重试入口，不回落演示数据 */
    loadFailed: false,
    /* 分享落地：从分享卡片进来时只展示被分享的那一条 */
    focusId: '',
    /* 我的商机：从「我的」页进入时只展示我领取过的商机，不展示榜单与统计 */
    mineMode: false,
    /* 已领取 / 不满足独立列表页：只展示对应状态并按类别筛选，不展示概览与榜单 */
    listMode: false,
    /* 提示力度：三档预设 + 品牌 / 型号 / 数量 / 容量 / 价格 / 城市 / 成色 / 税费 / 供给九维微调 */
    prefs: Object.assign({}, PREF_PRESETS.standard, { onlyOpenSubject: false }),
    prefLevels: PREF_LEVELS,
    /* 主体信息：全部 / 仅公开主体，独立于提示力度 */
    prefSubjectOptions: SUBJECT_OPTIONS,
    prefSubject: 'all',
    prefDims: dimsWithValue(PREF_PRESETS.standard),
    prefLevelName: prefNameOf('standard'),
    /* 城市选了「指定城市」时的多选面板与已选摘要 */
    prefCityGroups: cityGroupsOf(PREF_PRESETS.standard),
    prefCityText: '',
    prefOpen: false,
    prefSaving: false,
    /* 朋友圈单页模式：只做浏览，底部提示从右上角进入完整小程序 */
    singlePage: false,
    /* 微信商机提醒：额度用完 / 未知时展示提示条，点一下即可开通或续订 */
    wxRemain: -1,
    wxNotifyTip: false,
    wxNotifyBusy: false
  },

  onLoad(options) {
    /* 分享卡片带 ?id=xxx 时定位到该条商机 */
    this.focusId = options && options.id ? String(options.id) : ''
    /* 「我的」→ 我的商机：只看已领取，不展示全部商机与榜单 */
    this.mineMode = !!(options && String(options.mode || '') === 'mine')
    if (this.mineMode) {
      wx.setNavigationBarTitle({ title: '我的商机' })
      this.setData({ mineMode: true, state: 'claimed' })
    }
    /* 「已领取 / 不满足」：与在售库存一致，点开进入独立列表页，页内再按类别筛选 */
    const view = String((options && options.view) || '')
    if (view === 'claimed' || view === 'unsatisfied') {
      this.listMode = view
      wx.setNavigationBarTitle({ title: view === 'claimed' ? '已领取商机' : '不满足商机' })
      this.setData({ listMode: true, state: view, filter: 'all' })
    }
    /* 后台「系统设置」里的套餐价格，登录后先拉一次 */
    this.loadSite()
    this.refresh()
  },

  onShow() {
    /* 商机页允许分享：分享的是公开的货盘与榜单信息；朋友圈同开 */
    guard.enableShare(true)
    const sp = guard.isSinglePage()
    if (sp !== this.data.singlePage) this.setData({ singlePage: sp })
    this.syncNotify()
    this.refresh()
  },

  /* 微信商机提醒：一次授权只推一条，额度用完 / 未知时显示提示条 */
  async syncNotify(force) {
    if (!guard.boundToAccount()) {
      this.setData({ wxNotifyTip: false })
      return
    }
    await notify.loadConfig(force)
    const n = notify.quota('biz')
    const remain = n === null ? -1 : n
    this.setData({ wxRemain: remain, wxNotifyTip: remain <= 0 })
  },

  /* 点提示条开通 / 续订：授权成功立即隐藏，不等服务端额度回流 */
  async renewNotify() {
    if (this.data.wxNotifyBusy) return
    this.setData({ wxNotifyBusy: true })
    const on = await notify.enable('biz')
    if (on) {
      this.setData({
        wxNotifyBusy: false,
        wxNotifyTip: false,
        wxRemain: Math.max(1, Number(this.data.wxRemain) || 0)
      })
      return
    }
    this.setData({ wxNotifyBusy: false })
    this.syncNotify(true)
  },

  /* 分享卡片：点某条商机的「分享」→ 分享该条；右上角分享 → 商机页整体 */
  onShareAppMessage(e) {
    const ds = (e && e.target && e.target.dataset) || {}
    const opp = ds.id ? this.findOpp(ds.id) : null
    if (opp) {
      const amount = opp.priceText
        ? opp.priceText + (opp.unit && !/[\/]|以内|面议/.test(opp.priceText) ? ' / ' + opp.unit : '')
        : ''
      const isDemand = opp.kind === '求购' || opp.kind === '租赁'
      const title = [opp.kind, opp.model, opp.qty ? opp.qty + (opp.unit || '') : '', opp.city]
        .filter(Boolean).join(' · ')
      const desc = [
        opp.org ? '主体 ' + opp.org : '',
        amount ? (isDemand ? '预算 ' : '报价 ') + amount : '',
        '登录查看对接条件与撮合进度'
      ].filter(Boolean).join(' · ')
      return {
        title: guard.scrubContact(title + '，登录看对接条件'),
        desc: guard.scrubContact(desc),
        imageUrl: sharePoster.cached('biz', opp) || SHARE_CARD,
        /* 带上商机 id：对方点开直接定位到这一条，而不是停在列表 */
        path: opp.id ? '/pages/biz/biz?id=' + encodeURIComponent(opp.id) : '/pages/biz/biz'
      }
    }
    return {
      title: '今日实时货盘 · 在售与求购价差，登录看完整盘口',
      desc: 'GPU / 内存 / CPU 品类榜与今日热词，登录看完整买卖盘',
      imageUrl: SHARE_CARD,
      path: '/pages/biz/biz'
    }
  },

  /* 分享到朋友圈：朋友圈只能带 title / query，落到商机页整体 */
  onShareTimeline() {
    const focus = this.focusId ? this.findOpp(this.focusId) : null
    if (focus) {
      return {
        title: guard.scrubContact([focus.kind, focus.model, focus.city].filter(Boolean).join(' · ') + ' · 登录看对接条件'),
        query: 'id=' + encodeURIComponent(focus.id),
        imageUrl: sharePoster.cached('biz', focus) || SHARE_CARD
      }
    }
    return {
      title: '今日实时货盘 · 在售与求购价差，登录看完整盘口',
      query: '',
      imageUrl: SHARE_CARD
    }
  },

  /* 保存海报到相册：发朋友圈、发给好友或转其他平台 */
  savePoster(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const opp = ds.id ? this.findOpp(ds.id) : null
    const path = opp && opp.id ? '/pages/biz/biz?id=' + encodeURIComponent(opp.id) : '/pages/biz/biz'
    sharePoster.save('biz', opp || { id: 'biz', badge: '商机', title: '实时货盘与囤货榜单' }, { path: path })
      .then((ok) => {
        if (ok) wx.showToast({ title: '海报已存到相册', icon: 'success' })
      })
  },


  findOpp(id) {
    const hit = (o) => o && String(o.id) === String(id)
    return (this.data.items || []).filter(hit)[0] || (this.source || []).filter(hit)[0] || null
  },

  /* 前 10 条商机海报串行预生成：逐条排队，避免一次性占用画布导致卡顿 */
  preparePosters(list) {
    const queue = (list || []).slice(0, 10)
    if (!queue.length) return
    this.posterQueue = (this.posterQueue || Promise.resolve()).then(() => {
      let chain = Promise.resolve()
      queue.forEach((opp) => {
        chain = chain.then(() => sharePoster.prepare('biz', opp))
      })
      return chain
    })
  },

  /* 平台配置：会员价格以服务端设置页为准 */
  async loadSite() {
    try {
      const res = await request('user', 'site.get', {}, { silent: true })
      const site = (res && res.site) || null
      if (!site) return
      this.setData({
        plan: site.planPrice || biz.PLAN.label,
        price: site.planPrice || biz.PLAN.price
      })
    } catch (e) { /* 配置读取失败不影响商机列表 */ }
  },

  /* 云端优先：biz.list 直接返回权限状态、商机池与库存条数；未登录预览时才用本地演示数据 */
  async refresh() {
    const res = await this.loadRemote()
    if (res) {
      this.applyRemote(res)
      return
    }
    /* 已绑定真实账号但接口失败：不能拿演示数据冒充真实商机，
       否则用户会看到「没有领取按钮 / 领取后找不到」的假象，直接给重试入口 */
    if (guard.boundToAccount()) {
      this.remote = false
      this.setData({ remote: false, loadFailed: true, items: [], total: 0 })
      return
    }
    this.applyLocal()
  },

  /* 返回 null 表示云端不可用（不是「确实没有商机」） */
  async loadRemote() {
    try {
      /* 主列表加载即视为已读：服务端只对已开通会员记录 seenAt，首页角标随之清零；
         「我的商机 / 已领取 / 不满足」不参与，避免看自己的记录把新商机提醒吃掉 */
      const markSeen = !this.mineMode && !this.listMode
      const res = await request('user', 'biz.list', markSeen ? { markSeen: true } : {}, { silent: true })
      if (!res || !Array.isArray(res.items)) return null
      /* 上次查看时间：晚于它的商机属于「本次新增」，只在这一次置顶，退出后不再保留。
         只取本次进入的第一次结果（onLoad / onShow 会各刷一次），否则第二次的 seenAt
         已经把新商机算成「看过」，置顶与「新」标会立刻消失 */
      if (this.newSince == null) this.newSince = markSeen ? (Number(res.lastSeenAt) || 0) : 0
      return res
    } catch (e) {
      return null
    }
  },

  applyRemote(res) {
    const pool = res.items
      /* 兜底：云端已经过滤本人发布与未匹配商机，这里再过滤一次 */
      .filter((o) => o && !(o.isMine || o.mine) && o.matched !== false)
      /* 统一按发布时间倒序：越晚发布越靠前，避免旧缓存把新商机压到后面 */
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
      .map((o) => {
        const platformOnly = o.type === 'agency'
        const media = coverOfItem(o)
        /* 条件标签与普通商品卡同口径：信息行里取成色 / 税费 / 供给类型 */
        const info = Array.isArray(o.info) ? o.info : []
        const infoVal = function () {
          for (let i = 0; i < arguments.length; i++) {
            const hit = info.filter((it) => it && it.k === arguments[i])[0]
            if (hit && hit.v) return String(hit.v)
          }
          return ''
        }
        const merged = Object.assign({}, o, {
          unit: o.unit || '台',
          /* 列表封面：点开前就能看到实拍图，与普通商品列表一致 */
          cover: o.cover || media.cover,
          mediaCount: o.mediaCount || media.mediaCount,
          /* 租赁 / 出售判断与普通商品卡一致，用于缩略图配色和成色标签显隐 */
          isRent: o.isRent === true || /租/.test(String(o.kind || '')),
          cond: o.cond || infoVal('成色', '成色要求'),
          taxShort: o.taxShort || infoVal('税费', '税费要求'),
          supply: o.supply || infoVal('供给类型'),
          /* 与普通商品卡一致的副信息行：品牌 · 城市 */
          cardSub: [o.brand || infoVal('品牌'), o.city].filter(Boolean).join(' · '),
          views: Number(o.views) || 0,
          isAgency: platformOnly,
          platformOnly: platformOnly,
          /* 代采 / 代售与普通商品卡一致：型号、数量、金额直接展示 */
          feeText: o.feeText || '',
          /* 代采 / 代售由平台统一对接：不展示个人联系方式 */
          contact: platformOnly ? '平台代为对接' : o.contact,
          phone: platformOnly ? '' : o.phone,
          contactVisible: platformOnly ? false : !!o.contactVisible,
          /* 已标记不满足：仍留在列表「不满足」分类里，不再提醒也不可自助领取 */
          unsatisfied: !!o.unsatisfied,
          canClaim: !!o.canClaim,
          /* 已领取的求购 / 货源即使对方没留联系方式，也要能发起站内对话 */
          canChat: !o.closed && (o.type === 'demand' || o.type === 'supply') && (!!o.claimed || !!o.contactVisible),
          consulted: !!(o.consulted || biz.isConsulted(o.id)),
          /* 本次进入时新增的商机：这次置顶并标「新」，退出后 seenAt 前移，下次进入即按正常排序 */
          isNew: !!this.newSince && (Number(o.at) || 0) > this.newSince,
          /* 右上角收藏：与首页商品卡同一套本地缓存 + 云端同步 */
          fav: fav.isFav(favTypeOf(o), o.id)
        })
        merged.stockHint = biz.matchHint(merged)
        return merged
      })
    /* 我的商机：只保留我领取过的条目 */
    const all = this.mineMode ? pool.filter((o) => o.claimed) : pool
    this.remote = true
    this.source = all
    const plans = withTerm(Array.isArray(res.plans) && res.plans.length ? res.plans : this.data.plans)
    const keep = plans.some((p) => p.key === this.data.planKey) ? this.data.planKey : (plans[0] && plans[0].key) || 'month'
    const selectedPlan = plans.filter((p) => p.key === keep)[0] || null
    const stats = {
      matched: Number.isFinite(Number(res.matchedCount))
        ? Number(res.matchedCount)
        : pool.filter((o) => o.matched).length,
      agency: pool.filter((o) => o.type === 'agency').length,
      demands: pool.filter((o) => o.type === 'demand').length,
      supplies: pool.filter((o) => o.type === 'supply').length,
      claimed: pool.filter((o) => o.claimed).length,
      unsatisfied: pool.filter((o) => !o.claimed && o.unsatisfied).length,
      open: pool.filter((o) => !o.claimed && !o.unsatisfied).length,
      stock: { sku: Number(res.stockCount) || 0, qty: 0 }
    }
    const savedPrefs = res.prefs && typeof res.prefs === 'object' ? res.prefs : this.data.prefs
    /* 服务端未下发 onlyOpenSubject 时沿用本地已选值，避免刷新后又跳回「全部」 */
    const prefs = Object.assign({}, savedPrefs, {
      onlyOpenSubject: savedPrefs.onlyOpenSubject === undefined
        ? this.data.prefs.onlyOpenSubject === true
        : savedPrefs.onlyOpenSubject === true
    })
    this.setData(Object.assign(prefView(prefs), {
      remote: true,
      loadFailed: false,
      unlocked: !!res.unlocked,
      /* 7 天体验：服务端按「未开通且未用过」下发，未下发时按不可用处理 */
      trialAvailable: res.trialAvailable === true,
      /* 服务端尚未下发 hiddenCount 时按 0 兼容 */
      hiddenCount: Math.max(0, Math.floor(Number(res.hiddenCount) || 0)),
      dayLabel: dayLabelOf(prefs.days),
      sortLabel: sortLabelOf(prefs.sort),
      showCount: 10,
      expireText: res.expireText || '',
      daysLeft: Number(res.daysLeft) || 0,
      plan: (selectedPlan && selectedPlan.label) || (res.plan && res.plan.label) || this.data.plan,
      price: (selectedPlan && selectedPlan.price) || this.data.price,
      plans,
      planKey: keep,
      selectedPlan,
      total: all.length,
      stats
    }))
    /* 排序偏好刚更新，先 setData 再建列表，保证首屏就按选定排序 */
    this.applyList()
    if (!this.mineMode) this.preparePosters(this.data.items)
    this.applyFocus(all)
  },

  /* 分享落地定位：找到被分享的商机就只展示这一条，找不到给出提示并回到列表 */
  applyFocus(all) {
    const id = this.focusId
    if (!id || this.focusShown || this.mineMode) return
    this.focusShown = true
    const hit = (all || []).filter((o) => o && String(o.id) === id)[0]
    if (!hit) {
      this.focusId = ''
      this.setData({ focusId: '' })
      wx.showToast({ title: '该商机已下架或已领取', icon: 'none' })
      return
    }
    this.setData({ state: 'all', filter: 'all', filterLabel: '全部', focusId: hit.id, items: [hit], filteredCount: 1 })
  },

  /* 退出分享定位，恢复完整商机列表 */
  clearFocus() {
    this.focusShown = true
    this.focusId = ''
    this.setData({ focusId: '', state: 'open', filter: 'all', filterLabel: '全部', showCount: 10 })
    this.applyList()
  },

  /* 云端不可用时的本地演示数据（仅未登录预览） */
  applyLocal() {
    this.remote = false
    /* 与云端卡片同口径：补齐浏览量 / 品牌·城市副信息，卡片不出现空字段 */
    const all = biz.opportunities().map((o) => Object.assign({
      unit: o.unit || '台',
      views: Number(o.views) || 0,
      cardSub: [o.brand, o.city].filter(Boolean).join(' · '),
      fav: fav.isFav(favTypeOf(o), o.id)
    }, o))
    this.source = all
    const info = biz.unlockInfo()
    const stats = biz.stats()
    stats.open = all.filter((o) => !o.claimed && !o.unsatisfied).length
    this.setData({
      remote: false,
      loadFailed: false,
      unlocked: info.unlocked,
      /* 演示数据没有服务端会员状态，不展示 7 天体验入口 */
      trialAvailable: false,
      expireText: info.expireText,
      daysLeft: Number(info.daysLeft) || 0,
      stats,
      total: all.length,
      showCount: 10,
      hiddenCount: 0
    })
    this.applyList()
    this.preparePosters(this.data.items)
    this.applyFocus(all)
  },

  /* 列表分页：先按分类 / 领取状态 / 型号筛选，再排序，最后只截取前 showCount 条 */
  buildList(all) {
    const base = this.filterItems(all)
    const model = this.data.modelFilter
    const picked = model ? base.filter((o) => String(o.matchModel || '') === model) : base
    this.filtered = this.sortItems(picked)
    return this.filtered.slice(0, this.data.showCount)
  },

  /* 排序方式：本次新增置顶 / 最新发布 / 库存匹配优先（有匹配型号的在前）/ 数量从大到小 */
  sortItems(list) {
    const sort = (this.data.prefs && this.data.prefs.sort) || 'latest'
    const at = (o) => Number(o.at) || 0
    /* 本次进入时新增的商机只在这一次置顶，其余按当前排序；下次进入 isNew 全部为 false */
    const fresh = (o) => (o && o.isNew ? 1 : 0)
    const arr = (list || []).slice()
    if (sort === 'match') {
      arr.sort((a, b) => (fresh(b) - fresh(a)) || ((b.matchModel ? 1 : 0) - (a.matchModel ? 1 : 0)) || (at(b) - at(a)))
    } else if (sort === 'qty') {
      arr.sort((a, b) => (fresh(b) - fresh(a)) || ((Number(b.qty) || 0) - (Number(a.qty) || 0)) || (at(b) - at(a)))
    } else {
      /* 最新发布：越晚发布越靠前 */
      arr.sort((a, b) => (fresh(b) - fresh(a)) || (at(b) - at(a)))
    }
    return arr
  },

  filterItems(all) {
    const filter = this.data.filter
    /* 我的商机：固定只看已领取，不提供「可领取」 */
    const state = this.mineMode ? 'claimed' : this.data.state
    return all.filter((o) => {
      /* 领取状态先过滤：已领取 / 不满足各自独立分组，其余进「可领取」 */
      if (state === 'claimed') {
        if (!o.claimed) return false
      } else if (state === 'unsatisfied') {
        if (o.claimed || !o.unsatisfied) return false
      } else if (o.claimed || o.unsatisfied) {
        return false
      }
      if (filter === 'all') return true
      if (filter === 'supply') return o.type === 'supply'
      return o.kind === filter
    })
  },

  /* 已领取 / 不满足：与在售库存一致，点开进入独立列表页，页内再按类别筛选 */
  goView(e) {
    const key = e.currentTarget.dataset.key
    if (key !== 'claimed' && key !== 'unsatisfied') return
    /* 会员未开通：这两类没有可看的内容，直接引导开通 */
    if (!this.data.unlocked) {
      this.openSheet()
      return
    }
    wx.navigateTo({ url: '/pages/biz/biz?view=' + key })
  },

  /* 列表页返回商机主页：页面栈里还有上一页就回退，直接打开时兜底跳回商机页 */
  goBack() {
    const pages = getCurrentPages() || []
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.redirectTo({ url: '/pages/biz/biz' })
  },

  /* 分类筛选：全部 / 出租 / 出售 / 购买 / 租赁 / 代采 / 代售 / 匹配货源，选完收起面板 */
  switchFilter(e) {
    const key = String(e.currentTarget.dataset.key || 'all')
    const hit = FILTERS.filter((f) => f.key === key)[0]
    this.setData({
      filter: key,
      filterLabel: (hit && hit.label) || '全部',
      filterMenu: '',
      showCount: 10
    })
    /* 已加载过数据就本地切筛选，不必每次切分类都重新请求云端 */
    if (this.source) {
      this.applyList()
      return
    }
    this.refresh()
  },

  /* 分类 / 排序 / 型号三个展开按钮：点同一个收起，点另一个直接切换 */
  toggleMenu(e) {
    const menu = String(e.currentTarget.dataset.menu || '')
    this.setData({ filterMenu: this.data.filterMenu === menu ? '' : menu })
  },

  /* 点遮罩收起下拉面板 */
  closeMenu() {
    if (this.data.filterMenu) this.setData({ filterMenu: '' })
  },

  /* 本地筛选 / 排序变化后重新截取前 showCount 条，不重新请求云端 */
  applyList() {
    if (!this.source) return
    /* 型号选项只取当前分类 + 领取状态下真实存在的型号，选了一定有商机 */
    const base = this.filterItems(this.source)
    const models = this.modelsOf(base)
    const modelFilter = models.indexOf(this.data.modelFilter) >= 0 ? this.data.modelFilter : ''
    this.setData({ matchModels: models, modelFilter: modelFilter, teaserItems: this.sortItems(base) })
    this.setData({ items: this.buildList(this.source) })
    this.setData({ filteredCount: (this.filtered || []).length })
  },

  /* 型号去重：同一型号只出现一次，最多展示 50 个 */
  modelsOf(list) {
    const seen = {}
    const out = []
    ;(list || []).forEach((o) => {
      const m = String(o.matchModel || '').trim()
      if (!m || seen[m]) return
      seen[m] = true
      out.push(m)
    })
    return out.slice(0, 50)
  },

  /* 下滑加载更多：每次多展示 10 条，直到全部加载完 */
  onReachBottom() {
    const all = this.filtered || []
    const shown = (this.data.items || []).length
    if (all.length <= shown) return
    const showCount = this.data.showCount + 10
    this.setData({ showCount: showCount, items: all.slice(0, showCount) })
  },

  /* 型号筛选：只能从本次匹配到的型号里选，选「全部型号」清空 */
  pickModel(e) {
    const key = String(e.currentTarget.dataset.key || '')
    this.setData({ modelFilter: key, filterMenu: '', showCount: 10 })
    this.applyList()
  },

  /* 显示时间：3 天内 / 一周内 / 一个月内 / 手动设置 */
  pickDays(e) {
    const key = e.currentTarget.dataset.key
    if (String(key) === 'custom') {
      this.setData({ daysCustom: true, daysInput: String(this.data.prefs.days || 30) })
      return
    }
    const prefs = Object.assign({}, this.data.prefs, { days: Number(key) || 30 })
    this.setData({ prefs, daysCustom: false, dayLabel: dayLabelOf(prefs.days) })
  },

  /* 手动天数：输入框只暂存，点「确定」才生效，避免边输边跳 */
  bindDaysInput(e) {
    this.setData({ daysInput: String(e.detail.value || '') })
  },

  confirmDays() {
    const n = Math.floor(Number(this.data.daysInput) || 0)
    if (n < 1 || n > 90) {
      wx.showToast({ title: '请输入 1-90 天', icon: 'none' })
      return
    }
    const prefs = Object.assign({}, this.data.prefs, { days: n })
    this.setData({ prefs, dayLabel: dayLabelOf(n), daysInput: String(n) })
    wx.showToast({ title: '已设为 ' + n + ' 天内', icon: 'none' })
  },

  /* 排序方式：最新发布 / 库存匹配优先 / 数量从大到小，选完立即重排并收起面板 */
  pickSort(e) {
    const key = String(e.currentTarget.dataset.key || 'latest')
    const prefs = Object.assign({}, this.data.prefs, { sort: key })
    this.setData({ prefs, sortLabel: sortLabelOf(prefs.sort), filterMenu: '', showCount: 10 })
    this.applyList()
    this.persistSort(prefs)
  },

  /* 排序偏好在服务端留档，下次进入仍按上次选的顺序；保存失败不影响当前列表 */
  async persistSort(prefs) {
    if (!this.remote && !guard.boundToAccount()) return
    try {
      await request('user', 'biz.prefs', Object.assign({ save: true }, prefs), { silent: true })
    } catch (e) { /* 排序只是展示顺序，保存失败不回滚 */ }
  },

  /* 商机榜单：独立页面查看多个榜单，不在本页展开顶掉商机列表 */
  goBoard() {
    if (!this.data.unlocked) {
      this.openSheet()
      return
    }
    wx.navigateTo({ url: '/pages/board/board' })
  },

  /* 我的商机 → 回到完整商机页领取新商机；用 navigateTo，返回时仍回到我的商机 */
  goAllBiz() {
    wx.navigateTo({ url: '/pages/biz/biz' })
  },

  openSheet() {
    this.setData({ sheetOpen: true })
  },

  closeSheet() {
    this.setData({ sheetOpen: false })
  },

  /* 提示力度设置：三档预设一键切换，也可按维度微调后保存 */
  openPref() {
    this.setData({ prefOpen: true })
  },

  closePref() {
    this.setData({ prefOpen: false })
  },

  pickPrefLevel(e) {
    const key = e.currentTarget.dataset.key
    const preset = PREF_PRESETS[key]
    if (!preset) return
    /* 切档位不重置显示时间与排序：这两项在同一个设置面板里独立选择 */
    /* 已选城市也保留：切回「不限地区 / 只接同城」后再切回来不用重新勾 */
    const prefs = Object.assign({}, preset, {
      days: this.data.prefs.days,
      sort: this.data.prefs.sort,
      cities: prefCitiesOf(this.data.prefs),
      /* 主体信息是独立开关，切档位时保持不变 */
      onlyOpenSubject: this.data.prefs.onlyOpenSubject === true
    })
    this.setData(prefView(prefs))
  },

  /* 主体信息：全部 / 仅公开主体；切换后立即保存并刷新列表 */
  async pickSubject(e) {
    const key = String(e.currentTarget.dataset.key || 'all')
    const onlyOpenSubject = key === 'open'
    if (onlyOpenSubject === (this.data.prefs.onlyOpenSubject === true)) return
    if (this.subjectSaving) return
    const before = this.data.prefs
    const prefs = Object.assign({}, before, { onlyOpenSubject })
    this.setData(prefView(prefs))
    /* 未登录预览：只改本地展示，不落库 */
    if (!this.remote && !guard.boundToAccount()) {
      this.applyList()
      return
    }
    this.subjectSaving = true
    try {
      const payload = Object.assign({ save: true }, prefs, { onlyOpenSubject })
      const res = await request('user', 'biz.prefs', payload, { silent: true })
      const next = Object.assign({ onlyOpenSubject }, (res && res.prefs) || prefs)
      this.setData(Object.assign(prefView(next), {
        dayLabel: dayLabelOf(next.days),
        sortLabel: sortLabelOf(next.sort),
        showCount: 10
      }))
      /* 主体筛选改变的是服务端匹配结果，保存后重新拉一次列表与隐藏条数 */
      this.refresh()
    } catch (err) {
      /* 保存失败回滚选择，避免界面与云端偏好不一致 */
      this.setData(prefView(before))
      wx.showToast({ title: String((err && err.message) || '保存失败，请稍后重试'), icon: 'none' })
    } finally {
      this.subjectSaving = false
    }
  },

  /* 查看发布者主页：匿名 / 未公开主体也允许进入，敏感字段由主页侧脱敏 */
  openOwner(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const key = String(ds.key || '')
    if (!key) return
    const nick = String(ds.nick || '')
    wx.navigateTo({
      url: '/pages/userhome/userhome?key=' + encodeURIComponent(key) +
        (nick ? '&nick=' + encodeURIComponent(nick) : '') + '&from=biz'
    })
  },

  pickPrefDim(e) {
    const ds = e.currentTarget.dataset
    if (!ds.dim || !ds.key) return
    const prefs = Object.assign({}, this.data.prefs)
    prefs[ds.dim] = ds.key
    prefs.level = 'custom'
    /* 型号选「同型号（不限品牌）」与品牌「只接指定品牌」互斥，自动让另一维度配合 */
    if (ds.dim === 'model' && ds.key === 'same') prefs.brand = 'any'
    if (ds.dim === 'brand' && ds.key === 'same' && prefs.model === 'same') prefs.model = 'core'
    if (ds.dim === 'city' && !Array.isArray(prefs.cities)) prefs.cities = []
    this.setData(prefView(prefs))
  },

  /* 指定城市多选：点一下加入或取消，最多 20 个；一个都不选时按不限地区匹配 */
  togglePrefCity(e) {
    const name = String(e.currentTarget.dataset.city || '')
    if (!name) return
    const cities = prefCitiesOf(this.data.prefs)
    const idx = cities.indexOf(name)
    if (idx >= 0) cities.splice(idx, 1)
    else if (cities.length >= PREF_CITY_MAX) {
      wx.showToast({ title: '最多选择 ' + PREF_CITY_MAX + ' 个城市', icon: 'none' })
      return
    } else cities.push(name)
    const prefs = Object.assign({}, this.data.prefs, { city: 'pick', cities, level: 'custom' })
    this.setData(prefView(prefs))
  },

  /* 清空已选城市：仍停在「指定城市」，未选城市时等同不限地区 */
  clearPrefCities() {
    const prefs = Object.assign({}, this.data.prefs, { city: 'pick', cities: [], level: 'custom' })
    this.setData(prefView(prefs))
  },

  async savePref() {
    if (this.data.prefSaving) return
    this.setData({ prefSaving: true })
    const payload = Object.assign({ save: true }, this.data.prefs, {
      /* 布尔字段显式下发，避免历史偏好缺少该字段时被服务端当成未设置 */
      onlyOpenSubject: this.data.prefs.onlyOpenSubject === true
    })
    try {
      if (this.remote || guard.boundToAccount()) {
        const res = await request('user', 'biz.prefs', payload, { silent: true })
        const saved = (res && res.prefs) || this.data.prefs
        /* 服务端若尚未下发字段，沿用本次提交的值 */
        const prefs = Object.assign({}, saved, {
          onlyOpenSubject: saved.onlyOpenSubject === undefined ? payload.onlyOpenSubject : saved.onlyOpenSubject === true
        })
        this.setData(Object.assign(prefView(prefs), {
          dayLabel: dayLabelOf(prefs.days),
          sortLabel: sortLabelOf(prefs.sort),
          showCount: 10,
          prefOpen: false
        }))
        wx.showToast({ title: '已保存，正在按新设置重新匹配', icon: 'none' })
        this.refresh()
        return
      }
      /* 未登录预览：只改本地展示，不落库 */
      this.setData(Object.assign(prefView(this.data.prefs), {
        prefOpen: false,
        dayLabel: dayLabelOf(this.data.prefs.days),
        sortLabel: sortLabelOf(this.data.prefs.sort),
        showCount: 10
      }))
      wx.showToast({ title: '演示：提示力度已切换', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: String((err && err.message) || '保存失败，请稍后重试'), icon: 'none' })
    } finally {
      this.setData({ prefSaving: false })
    }
  },

  noop() {},

  /* 选择套餐：只切选中态，实际下单在「立即开通」里拉起微信支付 */
  selectPlan(e) {
    const key = e.currentTarget.dataset.key
    const plan = (this.data.plans || []).filter((p) => p.key === key)[0]
    if (!plan) return
    this.setData({
      planKey: key,
      selectedPlan: plan,
      plan: plan.label || this.data.plan,
      price: plan.price || this.data.price
    })
  },

  /**
   * 查看商机：需求 / 货源直接复用普通发布点进去的详情页（展示完全一致），
   * 在详情页逐项确认必须条件后领取并开始对话。
   * 求购 / 代采代售也统一走普通商品详情页，不再单独维护商机详情页。
   */
  viewOpp(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    if (!ds.id) return
    if (!this.data.unlocked) {
      this.openSheet()
      return
    }
    const type = String(ds.type || '')
    const id = encodeURIComponent(ds.id)
    /* 我的商机 / 已领取：详情页直接展示领取时解锁的联系方式 */
    const mine = this.mineMode || this.data.state === 'claimed' ? '&mine=1' : ''
    const biz = type === 'demand' || type === 'agency' ? type : 'supply'
    wx.navigateTo({ url: '/pages/product/product?id=' + id + '&biz=' + biz + mine })
  },

  /* 删除我领取的商机：只移除本人领取记录，商机回到池里可重新领取 */
  async deleteOpp(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const id = String(ds.id || '')
    if (!id || this.deleting) return
    const opp = (this.source || []).filter((o) => String(o.id) === id)[0] || {}
    const type = String(ds.type || opp.type || '')
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '删除商机',
        content: '删除后将从「我的商机」移除，可在商机池重新领取。',
        confirmText: '删除',
        confirmColor: '#e04b4b',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!ok) return
    this.deleting = true
    try {
      if (type) await biz.deleteRemote(type, id)
      biz.unclaim(id)
    } catch (err) {
      this.deleting = false
      return
    }
    this.deleting = false
    const rest = (this.source || []).filter((o) => String(o.id) !== id)
    this.source = rest
    const stats = Object.assign({}, this.data.stats)
    stats.claimed = rest.filter((o) => o.claimed).length
    this.setData({ total: rest.length, stats })
    this.applyList()
    wx.showToast({ title: '已删除', icon: 'none' })
  },

  /* 打开站内对话：条件已在商机页逐项确认，直接带确认结果开通会话 */
  async openChat(opp) {
    if (!opp || !opp.id) return
    if (this.openingChat) return
    this.openingChat = true
    const must = Array.isArray(opp.must) ? opp.must : []
    const conds = must.map((k) => ({ k, satisfied: true }))
    try {
      const payload = opp.type === 'supply' ? { productId: opp.id, conds } : { demandId: opp.id, conds }
      const res = await request('user', 'chat.open', payload, { silent: true })
      /* 直达会话：消息页是 tabBar 页只能 switchTab，threadId 交给消息页当场打开该会话 */
      const threadId = res && res.threadId ? String(res.threadId) : ''
      if (!threadId) {
        wx.showToast({ title: '暂时无法直接对话，请稍后再试', icon: 'none' })
        return
      }
      goThread(threadId)
    } catch (err) {
      const msg = String((err && err.message) || '')
      /* 服务端要求逐项确认必须条件：转到商机页逐条确认后再对话，避免按钮点了没反应 */
      if (msg && msg.indexOf('条件') >= 0 && (opp.type === 'demand' || opp.type === 'supply')) {
        wx.showToast({ title: msg, icon: 'none', duration: 2500 })
        setTimeout(() => this.viewOpp({
          currentTarget: { dataset: { id: opp.id, type: opp.type } }
        }), 600)
        return
      }
      wx.showToast({ title: msg || '发起对话失败，请稍后重试', icon: 'none', duration: 3000 })
    } finally {
      this.openingChat = false
    }
  },

  /**
   * 平台对接：代采 / 代售委托统一由平台居中联系，
   * 不展示委托方电话，也不进入与委托方的聊天。
   */
  async consultOpp(e) {
    const id = e.currentTarget.dataset.id
    const opp = (this.data.items || []).filter((o) => o.id === id)[0]
    if (!opp) return
    if (opp.isMine) {
      wx.showToast({ title: '不能响应自己发布的需求', icon: 'none' })
      return
    }
    /* 先领取再对接：未领取的代采 / 代售先跳详情页确认条件并领取 */
    if (opp.platformOnly && !opp.claimed) {
      this.viewOpp({ currentTarget: { dataset: { id: opp.id, type: opp.type } } })
      return
    }
    if (opp.consulted || this.consulting) return
    this.consulting = true
    this.setData({ consultingId: id })
    try {
      /* biz.consult 会直接生成委托咨询工单并返回会话 threadId；
         后续消息由客服领取后在该会话内跟进，前端不再重复建单 */
      let threadId = ''
      if (this.remote || guard.boundToAccount()) {
        try {
          const res = await request('user', 'biz.consult', { agencyId: id }, { silent: true })
          threadId = String((res && res.threadId) || '')
        } catch (err) {
          const msg = String((err && err.message) || '').trim()
          /* 服务端明确拒绝（自己发布 / 权限未开通 / 无匹配库存）时不能假装已提交 */
          if (msg) {
            wx.showToast({ title: msg, icon: 'none', duration: 3000 })
            return
          }
        }
      }
      this.markConsulted(id)
      /* 进入该委托的专属客服会话，委托上下文由工单携带，工作台可按委托查看 */
      if (threadId) {
        wx.navigateTo({ url: '/pages/chat/chat?threadId=' + encodeURIComponent(threadId) })
        return
      }
      wx.showToast({ title: '已提交对接申请，客服核实后推送采购方', icon: 'none', duration: 3000 })
    } finally {
      this.consulting = false
      this.setData({ consultingId: '' })
    }
  },

  /* 标记已提交：本地留痕 + 当前卡片灰态，刷新后仍保留 */
  markConsulted(id) {
    biz.consult(id)
    const mark = (o) => (o.id === id ? Object.assign({}, o, { consulted: true }) : o)
    const src = (this.source && this.source.length) ? this.source : (this.data.items || [])
    this.source = src.map(mark)
    this.setData({ items: this.buildList(this.source) })
    this.setData({ filteredCount: (this.filtered || []).length })
  },

  /* 已领取后再发起对话：条件已在领取时逐项确认，直接用商机页的结果开聊 */
  chatOpp(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const opp = (this.source || []).filter((o) => o.id === ds.id)[0]
      || (this.data.items || []).filter((o) => o.id === ds.id)[0]
      || this.findOpp(ds.id)
    if (!opp) return
    if (!opp.claimed) {
      /* 未领取：先进入商机页逐项确认条件并领取 */
      this.viewOpp(e)
      return
    }
    this.openChat(opp)
  },

  /* 点整张卡片查看商机：已领取 / 不满足的都进商机页，统一逐项确认后再操作 */
  openDetail(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    this.viewOpp({ currentTarget: { dataset: ds } })
  },

  /* 右上角收藏：本地立即生效，云端后台同步，不触发整卡点击 */
  toggleFav(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const id = String(ds.id || '')
    if (!id) return
    const targetFav = ds.type === 'demand' ? 'demand' : (ds.type === 'agency' ? 'agency' : 'product')
    const on = fav.toggleFav(targetFav, id)
    const all = (this.source || []).map((o) => (
      String(o.id) === id ? Object.assign({}, o, { fav: on }) : o
    ))
    this.source = all
    this.applyList()
    wx.showToast({ title: on ? '已收藏' : '已取消收藏', icon: 'none' })
  },

  copyPhone(e) {
    const phone = e.currentTarget.dataset.phone
    if (!phone) {
      wx.showToast({ title: '联系电话待客服补充', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: String(phone).replace(/\s/g, ''),
      success: () => wx.showToast({ title: '电话已复制', icon: 'none' })
    })
  },

  /**
   * 7 天体验：先弹窗让用户确认，确认后由服务端开通（每个账号仅一次）。
   * 体验期权益与付费会员一致，到期不自动续费。
   */
  startTrial() {
    if (this.data.trialing || this.data.paying) return
    if (!this.remote) {
      wx.showToast({ title: '请先登录后再体验', icon: 'none' })
      return
    }
    if (!this.data.trialAvailable) {
      wx.showToast({ title: '7 天体验已使用过，请开通会员', icon: 'none' })
      return
    }
    wx.showModal({
      title: '开通 7 天体验',
      content: '体验期内可使用商机会员全部权益：查看完整主体与联系方式、领取商机、承接平台委托。每个账号仅可体验一次，到期后需开通会员才能继续使用。',
      confirmText: '确认开通',
      cancelText: '再想想',
      confirmColor: '#4F46E5',
      success: async (res) => {
        if (!res.confirm) return
        this.setData({ trialing: true })
        try {
          await request('user', 'biz.trial', {})
          this.setData({ sheetOpen: false })
          await this.refresh()
          wx.showToast({ title: '已开通 7 天体验', icon: 'none', duration: 2500 })
        } catch (err) {
          /* request 已按错误码提示，失败时保持引导页 */
        } finally {
          this.setData({ trialing: false })
        }
      }
    })
  },

  /**
   * 微信虚拟支付：服务端签名后拉起收银台，支付成功由「道具发货推送」自动加会员时长，
   * 本页轮询开通结果，用户不需要再等人工确认。
   */
  async applyUnlock() {
    if (!this.remote) {
      /* 本地演示数据没有服务端，保留演示入口 */
      biz.activate(30)
      this.setData({ sheetOpen: false })
      this.refresh()
      wx.showToast({ title: '演示：已模拟开通 30 天', icon: 'none' })
      return
    }
    if (this.data.paying) return
    if (typeof wx.requestVirtualPayment !== 'function') {
      wx.showToast({ title: '当前微信版本过低，请升级后再支付', icon: 'none' })
      return
    }
    this.setData({ paying: true })
    wx.showLoading({ title: '正在拉起微信支付', mask: true })
    try {
      const order = await xpayOrder(this.data.planKey)
      wx.hideLoading()
      await new Promise((resolve, reject) => {
        wx.requestVirtualPayment({
          signData: order.signData,
          paySig: order.paySig,
          signature: order.signature,
          mode: 'short_series_goods',
          success: resolve,
          fail: reject
        })
      })
      wx.showLoading({ title: '支付成功，正在开通', mask: true })
      const done = await this.waitAccess()
      wx.hideLoading()
      this.setData({ sheetOpen: false })
      await this.refresh()
      wx.showToast({
        title: done ? '会员已开通，时长已到账' : '支付成功，开通稍有延迟，请下拉刷新',
        icon: 'none',
        duration: 3000
      })
    } catch (err) {
      wx.hideLoading()
      const msg = String((err && (err.errMsg || err.message)) || '')
      /* 用户主动取消：静默返回，不弹错误提示 */
      if (/cancel|取消/i.test(msg)) return
      /* 微信侧错误码要露出来：否则只剩兜底文案，无法判断是环境、签名还是道具配置问题 */
      const code = Number(err && err.errCode) || 0
      const CODE_TIP = {
        '-2': '已取消支付',
        '-4': '支付被风控拦截，请稍后再试',
        '-15005': '用户态签名错误，请重新登录后重试',
        '-15006': '支付签名错误，请联系平台客服',
        '-15007': '登录已过期，请重新登录',
        '-15008': '商户进件未完成，请联系平台客服',
        '-15010': '道具未发布，请联系平台客服',
        '-15011': '支付环境不匹配（开发/体验版需沙箱），请联系平台客服',
        '-15013': '道具价格不一致，请联系平台客服',
        '-15016': '支付参数格式错误，请升级小程序'
      }
      const tip = (err && err.message) || CODE_TIP[String(code)] || (code ? '支付失败（' + code + '）' : '支付未完成，请稍后重试')
      wx.showToast({ title: tip, icon: 'none', duration: 3000 })
    } finally {
      this.setData({ paying: false })
    }
  },

  /* 支付成功后等发货推送落库：最多轮询 6 次，避免用户刚付完就看到「未开通」 */
  async waitAccess() {
    for (let i = 0; i < 6; i++) {
      const res = await this.loadRemote()
      if (res && res.status === '已开通') return true
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    return false
  },

  /* 原型演示：仅云端不可用时可用；云端模式下不再本地伪造已开通 */
  demoActivate() {
    if (this.remote) return
    biz.activate(30)
    this.setData({ sheetOpen: false })
    this.refresh()
    wx.showToast({ title: '演示：已模拟客服开通 30 天', icon: 'none' })
  },

  goStock() {
    wx.navigateTo({ url: '/pages/stock/stock' })
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/publish/publish' })
  }
})
