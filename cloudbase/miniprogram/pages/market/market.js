/* 实时货盘：聚合平台在售商品与 24 小时内的卖方报价，按品类与关键字筛选；
   代采 / 代售只在商机池展示，不进入货盘。
   独立页面：从首页进入后与其它子页一致，支持左上角返回与侧滑返回。 */
const guard = require('../../utils/guard')
const { request } = require('../../utils/request')
const B = require('../../utils/board')

Page({
  data: {
    search: '',
    cats: [],
    cat: '全部',
    stats: { count: 0, updatedAt: '' },
    items: [],
    loading: true,
    /* 粘贴发布报价：文本域 → 解析预览 → 发布 */
    pasteOpen: false,
    pasteText: '',
    pastePreview: [],
    kbH: 0
  },

  onLoad() {
    /* 粘贴弹层是 fixed 定位，键盘弹起时要用高度把弹层整体上移 */
    if (typeof wx.onKeyboardHeightChange === 'function') {
      this.onKbChange = (res) => {
        this.setData({ kbH: Math.max(0, Number(res && res.height) || 0) })
      }
      wx.onKeyboardHeightChange(this.onKbChange)
    }
    this.load()
  },

  onShow() {
    /* 公开货盘允许转发与分享朋友圈 */
    guard.enableShare(true)
  },

  onUnload() {
    if (this.onKbChange && typeof wx.offKeyboardHeightChange === 'function') {
      wx.offKeyboardHeightChange(this.onKbChange)
    }
  },

  async onPullDownRefresh() {
    await this.load()
    wx.stopPullDownRefresh()
  },

  async load() {
    const seq = (this.seq || 0) + 1
    this.seq = seq
    this.setData({ loading: true })
    let list = null
    try {
      const res = await request('user', 'agency.board', { page: 1, limit: 50 }, { silent: true })
      if (res && Array.isArray(res.items)) list = res.items.map((b) => Object.assign({}, b))
    } catch (e) {}
    if (seq !== this.seq) return
    if (list === null) list = B.BOARD_DEMO.map((b) => Object.assign({}, b))
    /* 产品类型筛选：主品类打底 + 云端数据里出现的品类；已选品类失效时回到「全部」 */
    const cats = B.boardCatList(list)
    const cat = cats.indexOf(this.data.cat) >= 0 ? this.data.cat : '全部'
    this.source = list
    this.setData({
      cats: cats,
      cat: cat,
      stats: { count: list.length, updatedAt: B.fmtClock() }
    })
    this.apply()
  },

  /* 买价 = 货盘最高预算，卖价 = 货盘最低报价；价差按卖价 - 买价计算 */
  apply() {
    const cat = this.data.cat
    const kw = this.data.search
    let list = (this.source || []).filter((b) => (cat === '全部' || b.cat === cat) && B.matchKeyword(b, kw))
    list = list.map((b) => {
      const buy = Number(b.buyPrice) || 0
      const sell = Number(b.sellPrice) || 0
      const spread = (buy > 0 && sell > 0) ? sell - buy : 0
      return Object.assign({}, b, {
        buyText: buy > 0 ? '¥ ' + B.fmtPrice(buy) : '待补充',
        sellText: sell > 0 ? '¥ ' + B.fmtPrice(sell) : '待补充',
        spreadText: (buy > 0 && sell > 0) ? (spread >= 0 ? '价差 +' : '价差 ') + B.fmtPrice(spread) : '待撮合',
        spreadPct: (buy > 0 && sell > 0) ? (spread / buy * 100).toFixed(1) : ''
      })
    })
    this.setData({ items: list, loading: false })
  },

  pickCat(e) {
    this.setData({ cat: e.currentTarget.dataset.v })
    this.apply()
  },

  onSearch(e) {
    this.setData({ search: e.detail.value })
    this.apply()
  },

  clearSearch() {
    this.setData({ search: '' })
    this.apply()
  },

  /* ---------- 粘贴发布报价 ---------- */

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
    const rows = lines.map((l) => B.parseQuoteLine(l)).filter(Boolean)
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
    })).concat(this.source || [])
    this.source = merged
    this.setData({
      pasteOpen: false,
      pasteText: '',
      pastePreview: [],
      cats: B.boardCatList(merged),
      stats: { count: merged.length, updatedAt: B.fmtClock() }
    })
    this.apply()
    wx.showToast({ title: '已发布 ' + rows.length + ' 条报价，24 小时后自动过期', icon: 'none' })
  },

  /* 委托代采：直接进发布页的代采表单，主体核验与缴费都在那边完成 */
  openDaicai(e) {
    const target = String(e.currentTarget.dataset.target || '')
    wx.navigateTo({ url: '/pages/publish/publish?agency=buy&target=' + encodeURIComponent(target) })
  },

  onShareAppMessage() {
    return {
      title: '实时货盘 · 在售与求购价差一目了然',
      desc: '按品类与型号汇总买卖盘口，价格与城市公开，委托方身份不公开',
      imageUrl: guard.shareImage('biz'),
      path: '/pages/market/market'
    }
  },

  onShareTimeline() {
    return {
      title: '实时货盘 · 在售与求购价差一目了然',
      imageUrl: guard.shareImage('biz')
    }
  }
})
