/* 资讯详情：列表只给标题与开头，全文在这里展示
   - 展示作者信息、发布时间、浏览量；
   - 点头像 / 作者行进入作者主页（在架商品 + TA 的资讯）；
   - 关注作者复用本地 + 云端关注列表；官方资讯没有作者主页。 */
const fav = require('../../utils/fav')
const guard = require('../../utils/guard')
const { request } = require('../../utils/request')

Page({
  data: {
    loading: true,
    error: '',
    news: null,
    following: false,
    /* 互动：点赞 / 收藏 / 评论 */
    liked: false,
    likes: 0,
    faved: false,
    commentTotal: 0,
    comments: [],
    commentLoading: false,
    commentSending: false,
    commentInput: '',
    replyTo: null,
    /* 朋友圈单页模式：只做浏览，底部提示从右上角进入完整小程序 */
    singlePage: false
  },

  onLoad(options) {
    const id = decodeURIComponent((options && options.id) || '')
    if (!id) {
      this.setData({ loading: false, error: '资讯不存在或已下架' })
      return
    }
    this.newsId = id
    this.load()
  },

  onShow() {
    /* 资讯允许分享到好友与朋友圈：内容本身是公开的 */
    guard.enableShare(true)
    const sp = guard.isSinglePage()
    if (sp !== this.data.singlePage) this.setData({ singlePage: sp })
    const news = this.data.news
    if (news && news.authorKey) {
      this.setData({ following: fav.isFollowing(news.authorKey) })
    }
  },

  async load() {
    this.setData({ loading: true, error: '' })
    try {
      const doc = await request('user', 'news.detail', { id: this.newsId }, { silent: true })
      if (!doc || !doc.id) throw new Error('资讯不存在或已下架')
      const news = {
        id: doc.id,
        title: doc.title || '未命名资讯',
        cat: doc.cat || '',
        summary: doc.summary || '',
        content: doc.content || doc.summary || '',
        author: doc.author || (doc.official ? '平台运营' : '平台用户'),
        authorShort: String(doc.author || (doc.official ? '平台运营' : '平台用户')).slice(0, 1),
        authorKey: doc.authorKey || '',
        official: doc.official === true,
        city: doc.city || '',
        publishedText: doc.publishedText || '',
        views: Number(doc.views) || 0
      }
      this.setData({
        loading: false,
        news,
        following: news.authorKey ? fav.isFollowing(news.authorKey) : false,
        liked: doc.liked === true,
        likes: Number(doc.likes) || 0,
        faved: fav.isFav('news', news.id),
        commentTotal: Number(doc.commentCount) || 0
      })
      this.loadComments()
    } catch (err) {
      this.setData({ loading: false, error: (err && err.message) || '暂时无法加载这篇资讯' })
    }
  },

  retry() {
    this.load()
  },

  /* 作者头像 / 作者行：进入作者主页，看 TA 的在架商品与资讯 */
  openAuthor() {
    const n = this.data.news
    if (!n || !n.authorKey) return
    wx.navigateTo({
      url: '/pages/userhome/userhome?key=' + encodeURIComponent(n.authorKey) +
        '&nick=' + encodeURIComponent(n.author) + '&from=news'
    })
  },

  /* 举报该资讯：进入统一举报表单，提交后进入管理端「风险提示 - 举报反馈」 */
  report() {
    const n = this.data.news || {}
    wx.navigateTo({
      url: '/pages/report/report?targetType=news'
        + '&targetId=' + encodeURIComponent(n.id || this.newsId || '')
        + '&targetTitle=' + encodeURIComponent(n.title || '资讯')
    })
  },

  toggleFollow() {
    const n = this.data.news
    if (!n || !n.authorKey) return
    const on = fav.toggleFollow({
      id: n.authorKey,
      nick: n.author,
      short: String(n.author || '资').slice(-1),
      city: n.city || '',
      verified: !!n.authorVerified
    })
    this.setData({ following: on })
    wx.showToast({
      title: on ? '已关注，可在「我的 - 我的关注」查看' : '已取消关注',
      icon: 'none'
    })
  },

  /* ---------- 点赞 / 收藏 ---------- */
  async toggleLike() {
    if (this.liking) return
    this.liking = true
    try {
      const res = await request('user', 'news.like', {
        id: this.newsId,
        on: !this.data.liked
      }, { silent: true })
      this.setData({ liked: res.liked === true, likes: Number(res.likes) || 0 })
    } catch (err) {
      wx.showToast({ title: (err && err.message) || '操作失败，请稍后再试', icon: 'none' })
    } finally {
      this.liking = false
    }
  },

  toggleFav() {
    const on = fav.toggleFav('news', this.newsId)
    this.setData({ faved: on })
    wx.showToast({
      title: on ? '已收藏，可在「我的 - 我的收藏 - 资讯」查看' : '已取消收藏',
      icon: 'none'
    })
  },

  /* ---------- 评论 ---------- */
  async loadComments() {
    this.setData({ commentLoading: true })
    try {
      const res = await request('user', 'news.comment.list', { id: this.newsId }, { silent: true })
      this.setData({
        comments: (res && res.items) || [],
        commentTotal: Number(res && res.total) || 0,
        commentLoading: false
      })
    } catch (err) {
      this.setData({ commentLoading: false })
    }
  },

  onCommentInput(e) {
    this.setData({ commentInput: (e && e.detail && e.detail.value) || '' })
  },

  /* 点某条评论的「回复」：输入框切换为回复态 */
  startReply(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    if (!ds.id) return
    this.setData({ replyTo: { id: ds.id, author: ds.author || '用户' } })
  },

  cancelReply() {
    this.setData({ replyTo: null })
  },

  async sendComment() {
    if (this.data.commentSending) return
    const content = String(this.data.commentInput || '').trim()
    if (!content) {
      wx.showToast({ title: '先写点内容吧', icon: 'none' })
      return
    }
    this.setData({ commentSending: true })
    try {
      await request('user', 'news.comment.add', {
        id: this.newsId,
        content,
        parentId: this.data.replyTo ? this.data.replyTo.id : ''
      }, { silent: true })
      this.setData({ commentInput: '', replyTo: null, commentSending: false })
      await this.loadComments()
      wx.showToast({ title: '评论成功', icon: 'none' })
    } catch (err) {
      this.setData({ commentSending: false })
      wx.showToast({ title: (err && err.message) || '评论失败，请稍后再试', icon: 'none' })
    }
  },

  onShareAppMessage() {
    const news = this.data.news || {}
    return {
      title: news.title || '资讯',
      desc: guard.scrubContact(news.summary || '算力聚合 · 行情与避坑指南'),
      path: '/pages/news/news?id=' + encodeURIComponent(this.newsId || '')
    }
  },

  /* 分享到朋友圈：朋友圈只能带 title / query，落到同一篇资讯 */
  onShareTimeline() {
    const news = this.data.news || {}
    return {
      title: (news.title || '资讯') + ' · 算力聚合',
      query: 'id=' + encodeURIComponent(this.newsId || '')
    }
  }
})
