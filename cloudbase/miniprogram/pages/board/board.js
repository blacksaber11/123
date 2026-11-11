/* 商机榜单：需求榜 / 火热榜 / 供给榜 / 品类榜，数据来自 insights.market 聚合结果 */
const { request } = require('../../utils/request')

const TABS = [
  { key: 'demand', title: '需求榜', desc: '求购数量最多' },
  { key: 'hot', title: '火热榜', desc: '发起咨询 / 聊天最多' },
  { key: 'supply', title: '供给榜', desc: '在售货源最多' },
  { key: 'boards', title: '品类榜', desc: '按 GPU / 内存 / CPU 等品类聚合在售与求购热度' }
]

function priceText(price) {
  const n = Number(price) || 0
  return n > 0 ? '¥' + n : '面议'
}

Page({
  data: {
    loading: true,
    locked: false,
    hint: '',
    day: '',
    tabs: TABS,
    tab: 'demand',
    desc: TABS[0].desc,
    rankItems: [],
    boards: []
  },

  onLoad() {
    this.load()
  },

  async load() {
    this.setData({ loading: true })
    try {
      const res = await request('user', 'insights.market', { limit: 10 }, { silent: true })
      this.ranks = (res && Array.isArray(res.ranks)) ? res.ranks : []
      this.boardData = (res && Array.isArray(res.boards)) ? res.boards : []
      this.setData({
        loading: false,
        locked: !!(res && res.locked),
        hint: (res && res.hint) || '',
        day: (res && res.day) || '',
        boards: this.boardData.map((b) => ({
          scope: b.scope,
          meta: '浏览 ' + (Number(b.views) || 0) + ' · 咨询 ' + (Number(b.consults) || 0),
          items: (Array.isArray(b.items) ? b.items : []).slice(0, 6).map((it) => ({
            key: it.kind + '-' + it.id,
            kind: it.kind,
            title: it.model || it.title || '未命名',
            meta: [it.city, it.qty ? it.qty + ' 台' : ''].filter(Boolean).join(' · '),
            price: priceText(it.price)
          }))
        }))
      })
      this.render()
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: '榜单加载失败，请稍后重试', icon: 'none' })
    }
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    const meta = TABS.filter((t) => t.key === tab)[0]
    this.setData({ tab, desc: meta ? meta.desc : '' })
    this.render()
  },

  render() {
    const tab = this.data.tab
    const entry = (this.ranks || []).filter((b) => b.key === tab)[0]
    const items = (entry && Array.isArray(entry.items) ? entry.items : []).map((it) => {
      const base = {
        key: it.rank + '-' + it.name,
        rank: it.rank,
        top: it.rank <= 3,
        name: it.name,
        cat: it.cat || ''
      }
      if (tab === 'demand') {
        return Object.assign(base, { main: (it.qty || 0) + ' 台', sub: (it.count || 0) + ' 条求购' })
      }
      if (tab === 'hot') {
        return Object.assign(base, { main: (it.consults || 0) + ' 次咨询', sub: (it.listings || 0) + ' 条在售' })
      }
      return Object.assign(base, {
        main: (it.listings || 0) + ' 条在售',
        sub: '库存 ' + (it.qty || 0) + ' 台 · ' + (it.relation || '暂无求购')
      })
    })
    this.setData({ rankItems: items })
  },

  /* 会员过期或无权限直接进入本页时，回到商机页开通 */
  goBiz() {
    wx.navigateBack({
      fail: () => wx.redirectTo({ url: '/pages/biz/biz' })
    })
  }
})
