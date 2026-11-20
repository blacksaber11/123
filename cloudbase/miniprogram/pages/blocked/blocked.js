/* 黑名单管理：查看已拉黑的用户，可移出
   入口：我的 - 设置 - 隐私与安全 - 黑名单管理
   移出后对方可以重新发私信，我也能重新看到对方发布的商品与资讯。 */
const { request } = require('../../utils/request')
const { readUser } = require('../../utils/auth')

Page({
  data: {
    loading: true,
    error: '',
    items: []
  },

  onShow() {
    this.load()
  },

  async load() {
    const user = readUser()
    if (!user || !user.uid) {
      this.setData({ loading: false, items: [], error: '' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      const res = await request('user', 'block.list', {}, { silent: true })
      this.setData({ loading: false, items: (res && res.items) || [] })
    } catch (err) {
      this.setData({ loading: false, error: (err && err.message) || '暂时无法加载黑名单' })
    }
  },

  retry() {
    this.load()
  },

  /* 移出黑名单：二次确认后调用服务端，成功后从列表移除 */
  remove(e) {
    const uid = e.currentTarget.dataset.uid
    const nick = e.currentTarget.dataset.nick || '该用户'
    if (!uid) return
    wx.showModal({
      title: '移出黑名单',
      content: '移出后「' + nick + '」可以重新给你发私信，你也能看到对方发布的商品与资讯。',
      confirmText: '移出',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await request('user', 'block.remove', { uid }, { silent: true })
          this.setData({ items: this.data.items.filter((it) => it.uid !== uid) })
          wx.showToast({ title: '已移出', icon: 'none' })
        } catch (err) {
          wx.showToast({ title: (err && err.message) || '操作失败，请稍后重试', icon: 'none' })
        }
      }
    })
  }
})
