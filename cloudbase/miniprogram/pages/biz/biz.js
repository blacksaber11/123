/* 商机：按我的库存自动匹配平台核验后的代采 / 代售委托与求购需求，99 元 / 月开通 */
const biz = require('../../utils/biz')
const guard = require('../../utils/guard')
const sharePoster = require('../../utils/share-poster')
const { request, xpayOrder } = require('../../utils/request')
const { goThread } = require('../../utils/chat')

/* 分享图兜底：海报未生成 / 低版本基础库时用静态商机底图 */
const SHARE_CARD = '/assets/share/card-biz.png'


const FILTERS = [
  { key: 'all', label: '全部' },
  { key: '代采', label: '代采' },
  { key: '代售', label: '代售' },
  { key: 'demand', label: '求购 / 租赁' },
  { key: 'supply', label: '匹配我需求的货源' }
]

/* 套餐时长按自然月展示：月度即 1 个月，不写「30 天」 */
const PLAN_TERMS = { month: '1 个月', quarter: '3 个月', half: '6 个月', year: '12 个月' }
const withTerm = (plans) => (Array.isArray(plans) ? plans : []).map((p) => Object.assign({}, p, {
  termText: PLAN_TERMS[p.key] || (p.days ? p.days + ' 天' : '')
}))
const LOCAL_PLANS = withTerm(biz.PLANS)

/* 提示力度：三档预设与后端 BIZ_PREF_PRESETS 同口径，离线预览时也能用 */
const PREF_PRESETS = {
  loose: { level: 'loose', brand: 'any', model: 'series', qty: 'any', cap: 'any' },
  standard: { level: 'standard', brand: 'any', model: 'core', qty: 'meet', cap: 'same' },
  strict: { level: 'strict', brand: 'same', model: 'exact', qty: 'exceed', cap: 'same' }
}
const PREF_LEVELS = [
  { key: 'loose', name: '宽松', desc: '同系列即可，数量和容量不限，看到的商机最多' },
  { key: 'standard', name: '标准', desc: '同核心型号、容量一致，数量达到起订量（默认）' },
  { key: 'strict', name: '严格', desc: '只接指定品牌、型号完全一致，且库存量要覆盖需求量' }
]
const PREF_DIMS = [
  { key: 'brand', name: '品牌', options: [{ key: 'any', label: '不限品牌' }, { key: 'same', label: '只接指定品牌' }] },
  {
    key: 'model',
    name: '型号',
    options: [{ key: 'series', label: '同系列即可' }, { key: 'core', label: '同核心型号' }, { key: 'exact', label: '型号完全一致' }]
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
  }
]
const prefNameOf = (level) => ((PREF_LEVELS.filter((l) => l.key === level)[0] || {}).name || '自定义')
/* 维度当前选中值冗余到 options 外层，避免 WXML 里做对象动态取值 */
const dimsWithValue = (prefs) => PREF_DIMS.map((d) => Object.assign({}, d, { value: (prefs && prefs[d.key]) || '' }))

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
    items: [],
    total: 0,
    /* 平台对接按钮 loading：同一时刻只允许提交一张卡片 */
    consultingId: '',
    sheetOpen: false,
    /* 已登录但 biz.list 失败：给出重试入口，不回落演示数据 */
    loadFailed: false,
    /* 分享落地：从分享卡片进来时只展示被分享的那一条 */
    focusId: '',
    /* 我的商机：从「我的」页进入时只展示我领取过的商机，不展示榜单与统计 */
    mineMode: false,
    /* 提示力度：三档预设 + 品牌 / 型号 / 数量 / 容量四维微调 */
    prefs: Object.assign({}, PREF_PRESETS.standard),
    prefLevels: PREF_LEVELS,
    prefDims: dimsWithValue(PREF_PRESETS.standard),
    prefLevelName: prefNameOf('standard'),
    prefOpen: false,
    prefSaving: false
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
    /* 后台「系统设置」里的套餐价格，登录后先拉一次 */
    this.loadSite()
    this.refresh()
  },

  onShow() {
    /* 商机页允许分享：分享的是公开的货盘与榜单信息 */
    guard.enableShare()
    this.refresh()
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
        '平台居中对接，条件匹配再沟通'
      ].filter(Boolean).join(' · ')
      return {
        title: guard.scrubContact(title),
        desc: guard.scrubContact(desc),
        imageUrl: sharePoster.cached('biz', opp) || SHARE_CARD,
        /* 带上商机 id：对方点开直接定位到这一条，而不是停在列表 */
        path: opp.id ? '/pages/biz/biz?id=' + encodeURIComponent(opp.id) : '/pages/biz/biz'
      }
    }
    return {
      title: '算力聚合 · 实时货盘与囤货榜单',
      desc: 'GPU / 内存 / CPU 品类榜与今日热词，帮你判断囤货方向',
      imageUrl: SHARE_CARD,
      path: '/pages/biz/biz'
    }
  },

  /* 当前可见列表与全量商机里找这一条，兼容筛选后分享已领取条目 */
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
      const res = await request('user', 'biz.list', {}, { silent: true })
      if (!res || !Array.isArray(res.items)) return null
      return res
    } catch (e) {
      return null
    }
  },

  applyRemote(res) {
    const pool = res.items
      /* 兜底：云端已经过滤本人发布与未匹配商机，这里再过滤一次 */
      .filter((o) => o && !(o.isMine || o.mine) && o.matched !== false)
      .map((o) => {
        const platformOnly = o.type === 'agency'
        const merged = Object.assign({}, o, {
          unit: o.unit || '台',
          isAgency: platformOnly,
          platformOnly: platformOnly,
          feeText: o.feeText || (platformOnly ? '成交后支付' : (o.type === 'supply' ? '需求匹配' : '求购需求')),
          /* 代采 / 代售由平台代为对接：不下发对方电话，也不开放自助领取 */
          contact: platformOnly ? '平台代为对接' : o.contact,
          phone: platformOnly ? '' : o.phone,
          contactVisible: platformOnly ? false : !!o.contactVisible,
          /* 已标记不满足：仍留在列表「不满足」分类里，不再提醒也不可自助领取 */
          unsatisfied: !!o.unsatisfied,
          canClaim: platformOnly ? false : !!o.canClaim,
          /* 已领取的求购 / 货源即使对方没留联系方式，也要能发起站内对话 */
          canChat: !o.closed && (o.type === 'demand' || o.type === 'supply') && (!!o.claimed || !!o.contactVisible),
          consulted: !!(o.consulted || biz.isConsulted(o.id))
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
    const prefs = res.prefs && typeof res.prefs === 'object' ? res.prefs : this.data.prefs
    this.setData({
      remote: true,
      loadFailed: false,
      unlocked: !!res.unlocked,
      prefs,
      prefLevelName: prefNameOf(prefs.level),
      prefDims: dimsWithValue(prefs),
      expireText: res.expireText || '',
      daysLeft: Number(res.daysLeft) || 0,
      plan: (selectedPlan && selectedPlan.label) || (res.plan && res.plan.label) || this.data.plan,
      price: (selectedPlan && selectedPlan.price) || this.data.price,
      plans,
      planKey: keep,
      selectedPlan,
      total: all.length,
      items: this.filterItems(all),
      stats
    })
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
    this.setData({ state: 'all', filter: 'all', focusId: hit.id, items: [hit] })
  },

  /* 退出分享定位，恢复完整商机列表 */
  clearFocus() {
    this.focusShown = true
    this.focusId = ''
    this.setData({ focusId: '', state: 'open', filter: 'all' })
    this.setData({ items: this.filterItems(this.source || []) })
  },

  /* 云端不可用时的本地演示数据（仅未登录预览） */
  applyLocal() {
    this.remote = false
    const all = biz.opportunities()
    this.source = all
    const info = biz.unlockInfo()
    const stats = biz.stats()
    stats.open = all.filter((o) => !o.claimed && !o.unsatisfied).length
    this.setData({
      remote: false,
      loadFailed: false,
      unlocked: info.unlocked,
      expireText: info.expireText,
      daysLeft: Number(info.daysLeft) || 0,
      stats,
      total: all.length,
      items: this.filterItems(all)
    })
    this.preparePosters(this.data.items)
    this.applyFocus(all)
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
      if (filter === 'demand') return o.kind === '求购' || o.kind === '租赁'
      if (filter === 'supply') return o.type === 'supply'
      return o.kind === filter
    })
  },

  switchState(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.state) return
    /* 会员未开通：已领取 / 不满足没有可看的内容，直接引导开通 */
    if (key !== 'open' && !this.data.unlocked) {
      this.openSheet()
      return
    }
    /* 切状态即退出分享定位 */
    if (this.data.focusId) {
      this.focusShown = true
      this.focusId = ''
      this.setData({ focusId: '' })
    }
    this.setData({ state: key })
    if (this.source) {
      this.setData({ items: this.filterItems(this.source) })
      return
    }
    this.refresh()
  },

  switchFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.key })
    /* 已加载过数据就本地切筛选，不必每次切 Tab 都重新请求云端 */
    if (this.source) {
      this.setData({ items: this.filterItems(this.source) })
      return
    }
    this.refresh()
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
    this.setData({ prefs: Object.assign({}, preset), prefDims: dimsWithValue(preset) })
  },

  pickPrefDim(e) {
    const ds = e.currentTarget.dataset
    if (!ds.dim || !ds.key) return
    const prefs = Object.assign({}, this.data.prefs)
    prefs[ds.dim] = ds.key
    prefs.level = 'custom'
    this.setData({ prefs, prefDims: dimsWithValue(prefs) })
  },

  async savePref() {
    if (this.data.prefSaving) return
    this.setData({ prefSaving: true })
    const payload = Object.assign({ save: true }, this.data.prefs)
    try {
      if (this.remote || guard.boundToAccount()) {
        const res = await request('user', 'biz.prefs', payload, { silent: true })
        const prefs = (res && res.prefs) || this.data.prefs
        this.setData({
          prefs,
          prefLevelName: prefNameOf(prefs.level),
          prefDims: dimsWithValue(prefs),
          prefOpen: false
        })
        wx.showToast({ title: '已保存，正在按新力度重新匹配', icon: 'none' })
        this.refresh()
        return
      }
      /* 未登录预览：只改本地展示，不落库 */
      this.setData({
        prefOpen: false,
        prefLevelName: prefNameOf(this.data.prefs.level),
        prefDims: dimsWithValue(this.data.prefs)
      })
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
   * 查看商机：列表上不再直接领取，统一进入商机页逐项确认必须条件，
   * 全部满足后才允许领取；不满足可标记，商机仍保留在「不满足」分类里。
   */
  viewOpp(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    if (!ds.id) return
    if (!this.data.unlocked) {
      this.openSheet()
      return
    }
    const url = '/pages/bizdetail/bizdetail?id=' + encodeURIComponent(ds.id) +
      (ds.type ? '&type=' + encodeURIComponent(ds.type) : '')
    wx.navigateTo({ url })
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
    if (opp.consulted || this.consulting) return
    this.consulting = true
    this.setData({ consultingId: id })
    try {
      /* 优先走后端 biz.consult；接口不可用（无 message）时才落到本地演示 */
      if (this.remote || guard.boundToAccount()) {
        try {
          await request('user', 'biz.consult', { agencyId: id }, { silent: true })
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
      /* 咨询统一进入与平台的客服会话，委托上下文随消息落库，工作台可按委托查看 */
      try {
        await request('user', 'msg.send', {
          body: '我想咨询该委托：' + (opp.title || '') + '（委托编号 ' + id + '）',
          targetType: 'agency',
          targetId: id,
          targetTitle: opp.title || ''
        }, { silent: true })
        wx.switchTab({ url: '/pages/msg/msg' })
        return
      } catch (err) {
        /* 对话建立失败不影响已提交的对接申请 */
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
    this.setData({ items: this.filterItems(this.source) })
  },

  /* 已领取后再发起对话：条件已在领取时逐项确认，直接用商机页的结果开聊 */
  chatOpp(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    const opp = (this.data.items || []).filter((o) => o.id === ds.id)[0] || this.findOpp(ds.id)
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
