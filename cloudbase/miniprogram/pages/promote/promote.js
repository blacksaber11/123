/* 推广中心：协议开通、推广码分享、佣金 / 提现记录（人工分账，比例由平台统一设置） */
const { request } = require('../../utils/request')
const { writeMyRefCode } = require('../../utils/auth')

const MIN_WITHDRAW = 100
const MAX_WITHDRAW = 20000
const FEE_RATE = 0.05

/* v5.1 状态口径；兼容旧文案「已打款 / 已取消」 */
const WITHDRAW_STATUS = {
  待审核: { text: '待审核', cls: 'wait' },
  待打款: { text: '待打款', cls: 'wait' },
  打款中: { text: '打款中', cls: 'info' },
  已到账: { text: '已到账', cls: 'ok' },
  已打款: { text: '已到账', cls: 'ok' },
  打款失败: { text: '打款失败', cls: 'fail' },
  已驳回: { text: '已驳回', cls: 'fail' },
  已撤销: { text: '已撤销', cls: 'muted' },
  已取消: { text: '已撤销', cls: 'muted' }
}

const COMMISSION_STATUS = {
  待结算: 'wait',
  可提现: 'ok',
  已提现: 'muted',
  已冲正: 'fail'
}

const AGREEMENT_POINTS = [
  '分享任意页面（商品、商机、需求、资讯等）的链接、二维码或朋友圈，好友打开并登录即自动绑定，绑定后不可改绑；自邀、刷单不计佣金。',
  '只有好友第一次付款成功才按平台统一比例产生一级佣金，第二次及以后的付款（含续费）不产生佣金；普通推广人没有二级收入，仅客服绑定账号另按其下级的首次付款计二级佣金。佣金先进入待结算，微信 / 虚拟支付冻结至次月 15 日，Apple 内购须等平台确认款项到账后解冻。',
  '佣金比例由平台统一设置，推广者不可修改；平台调整只影响之后产生的新订单。',
  '可提现余额最低 100 元起提，单笔上限 20,000 元，无阶梯费率。',
  '提现提交后由平台人工审核并打款，扣 5% 手续费，到账以打款回填为准。',
  '发现虚假交易、恶意退款等违规行为，平台有权追回佣金并关闭推广资格。'
]

function money(v) {
  const n = Number(v)
  return (isFinite(n) ? n : 0).toFixed(2)
}

function toast(title) {
  wx.showToast({ title: title, icon: 'none', duration: 2200 })
}

/* 协议标题统一去掉自带的书名号：模板里会再包一层《》，避免出现《《…》》 */
function plainTitle(title) {
  return String(title || '').replace(/^《/, '').replace(/》$/, '')
}

/* 协议正文按行拆分：服务端下发的是整段文本，一行一条 */
function textLines(text) {
  if (Array.isArray(text)) return text.filter(Boolean)
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

function mapCommission(row) {
  const item = row || {}
  const status = String(item.status || '')
  return Object.assign({}, item, {
    amountText: money(item.amount),
    baseText: money(item.base),
    statusText: status || '待结算',
    statusClass: COMMISSION_STATUS[status] || 'wait',
    createdText: item.createdText || '',
    eligibleText: item.eligibleText || ''
  })
}

function mapWithdrawal(row) {
  const item = row || {}
  const status = String(item.status || '')
  const meta = WITHDRAW_STATUS[status] || { text: status || '待审核', cls: 'wait' }
  return Object.assign({}, item, {
    amountText: money(item.amount),
    feeText: money(item.fee),
    taxText: money(item.tax),
    netText: money(item.net),
    statusText: meta.text,
    statusClass: meta.cls,
    applyText: item.applyText || '',
    paidText: item.paidText || '',
    failText: item.failReason || item.reviewNote || '',
    cancelable: item.canCancel === true || status === '待审核'
  })
}

Page({
  data: {
    loading: true,
    error: '',
    active: false,
    refCode: '',
    rateText: '—',
    level2RateText: '—',
    level2Note: '',
    amounts: {
      pending: '0.00',
      available: '0.00',
      withdrawn: '0.00',
      earning: '0.00'
    },
    referrals: 0,
    level1Count: 0,
    level2Count: 0,
    buyers: 0,
    statsText: '',
    minWithdraw: MIN_WITHDRAW,
    maxWithdraw: MAX_WITHDRAW,
    feeRate: FEE_RATE,
    feeRateText: '5%',
    freezeDay: 15,
    reviewNote: '',
    agreementTitle: '推广服务协议',
    agreementVersion: '',
    agreementPoints: AGREEMENT_POINTS,
    /* 协议全文：点文字里的协议名或「查看协议全文」展开 */
    agreementText: [],
    agreementOpen: false,
    agreed: false,
    realName: '',
    applying: false,
    tab: 'commission',
    listsLoading: false,
    commissions: [],
    commissionTotal: 0,
    withdrawals: [],
    withdrawTotal: 0,
    sheetOpen: false,
    withdrawAmount: '',
    withdrawFee: '0.00',
    withdrawNet: '0.00',
    withdrawing: false
  },

  onLoad() {
    this._loadedAt = Date.now()
    this.refresh()
  },

  onShow() {
    /* 从登录页 / 后台返回时补刷新，首次进入由 onLoad 负责 */
    if (this._loadedAt && Date.now() - this._loadedAt > 1500) this.refresh()
  },

  /** 推广中心概览：接口名与 shared/promote.js 注册的 promote.summary 保持一致 */
  async fetchOverview() {
    const res = await request('user', 'promote.summary', {}, { silent: true })
    return res || {}
  },

  async refresh() {
    this.setData({ loading: true, error: '' })
    try {
      const overview = await this.fetchOverview()
      this.applyOverview(overview)
      this.setData({ loading: false })
      if (this.data.active) {
        this.loadLists()
      } else {
        this.loadAgreement()
      }
    } catch (err) {
      this.setData({
        loading: false,
        error: (err && err.message) || '加载失败，请稍后重试'
      })
    }
  },

  applyOverview(res) {
    const data = res || {}
    const totals = data.totals || {}
    const counts = data.counts || {}
    const rules = data.rules || {}
    const active = data.active === true || data.status === 'active'
    const refCode = String(data.refCode || data.shareRef || '')
    const referrals = Number(counts.referrals) || 0
    const level1Count = Number(counts.level1) || referrals
    const level2Count = Number(counts.level2) || 0
    const buyers = Number(counts.buyers) || 0
    /* 绑定人数由后端概览下发；老接口没有该字段时不展示，避免误报 0 人 */
    const statsText = counts.referrals === undefined || counts.referrals === null
      ? ''
      : '一级 ' + level1Count + ' 人 · 二级 ' + level2Count + ' 人' + (counts.buyers === undefined || counts.buyers === null ? '' : ' · 成交 ' + buyers + ' 人')
    /* 已开通：把自己的推广码写入全局与本地缓存，任意页面分享 / 海报都会带上自己的 ref */
    if (active && refCode) writeMyRefCode(refCode)
    this.setData({
      active,
      refCode,
      rateText: data.rateText || rules.rateText || '—',
      level2RateText: data.level2RateText || rules.level2RateText || '—',
      level2Note: rules.level2Note || '',
      amounts: {
        pending: money(totals.pending),
        available: money(totals.available),
        withdrawn: money(totals.withdrawn),
        earning: money(totals.earning)
      },
      referrals,
      buyers,
      statsText,
      minWithdraw: Number(rules.minWithdraw) || MIN_WITHDRAW,
      maxWithdraw: Number(rules.maxWithdraw) || MAX_WITHDRAW,
      feeRate: Number(rules.feeRate) || FEE_RATE,
      feeRateText: rules.feeText || '5%',
      freezeDay: Number(rules.freezeDay) || 15,
      reviewNote: rules.reviewNote || '',
      agreementVersion: data.agreementVersion || this.data.agreementVersion
    })
  },

  /** 未开通时拉协议版本与提现规则：开通要提交 agreementVersion */
  async loadAgreement() {
    try {
      const info = await request('user', 'promote.agreement', {}, { silent: true })
      if (!info) return
      this.setData({
        agreementTitle: plainTitle(info.title) || this.data.agreementTitle,
        agreementVersion: info.version || this.data.agreementVersion,
        agreementText: textLines(info.text),
        minWithdraw: Number(info.minWithdraw) || this.data.minWithdraw,
        maxWithdraw: Number(info.maxWithdraw) || this.data.maxWithdraw,
        feeRate: Number(info.feeRate) || this.data.feeRate,
        feeRateText: info.feeText || this.data.feeRateText,
        freezeDay: Number(info.freezeDay) || this.data.freezeDay
      })
    } catch (err) {
      /* 协议接口失败不阻塞页面，版本号由概览兜底 */
    }
  },

  async loadLists() {
    this.setData({ listsLoading: true })
    try {
      const commissions = await request('user', 'promote.commissions', { page: 1, limit: 10 }, { silent: true })
      this.setData({
        commissions: ((commissions && commissions.items) || []).map(mapCommission),
        commissionTotal: Number(commissions && commissions.total) || 0
      })
    } catch (err) {
      /* 单块失败不影响另一块 */
    }
    try {
      const list = await request('user', 'promote.withdrawals', { page: 1, limit: 10 }, { silent: true })
      this.setData({
        withdrawals: ((list && list.items) || []).map(mapWithdrawal),
        withdrawTotal: Number(list && list.total) || 0
      })
    } catch (err) {
      /* 单块失败不影响另一块 */
    }
    this.setData({ listsLoading: false })
  },

  toggleAgreed() {
    this.setData({ agreed: !this.data.agreed })
  },

  /* 展开 / 收起协议全文：勾选文字里的协议名与「查看协议全文」都走这里 */
  toggleAgreement() {
    this.setData({ agreementOpen: !this.data.agreementOpen })
  },

  onRealName(e) {
    this.setData({ realName: (e.detail && e.detail.value) || '' })
  },

  async onApply() {
    if (this.data.applying) return
    if (!this.data.agreed) return toast('请先阅读并同意推广服务协议')
    const realName = String(this.data.realName || '').trim()
    if (realName.length < 2) return toast('请填写真实姓名')
    this.setData({ applying: true })
    try {
      await request('user', 'promote.open', {
        agreed: true,
        agreementVersion: this.data.agreementVersion || '',
        realName
      })
      wx.showToast({ title: '已开通推广资格', icon: 'success' })
      await this.refresh()
    } catch (err) {
      /* request 已统一 toast */
    }
    this.setData({ applying: false })
  },

  copyCode() {
    if (!this.data.refCode) return
    wx.setClipboardData({
      data: this.data.refCode,
      success: () => wx.showToast({ title: '推广码已复制', icon: 'none' })
    })
  },

  onShareAppMessage() {
    return {
      title: '算力聚合 · 优质货源与求购需求',
      path: '/pages/home/home'
    }
  },

  switchTab(e) {
    const tab = (e.currentTarget && e.currentTarget.dataset.tab) || 'commission'
    if (tab === this.data.tab) return
    this.setData({ tab })
  },

  openWithdraw() {
    if (!this.data.active) return
    const available = Number(this.data.amounts.available) || 0
    if (available < this.data.minWithdraw) {
      return toast('可提现余额不足 ¥' + this.data.minWithdraw)
    }
    this._requestId = ''
    this.setData({
      sheetOpen: true,
      withdrawAmount: '',
      withdrawFee: '0.00',
      withdrawNet: '0.00'
    })
  },

  closeWithdraw() {
    if (this.data.withdrawing) return
    this.setData({ sheetOpen: false })
  },

  noop() {},

  onAmount(e) {
    const raw = String((e.detail && e.detail.value) || '').replace(/[^\d.]/g, '')
    const amount = Number(raw) || 0
    const fee = amount * (Number(this.data.feeRate) || FEE_RATE)
    this.setData({
      withdrawAmount: raw,
      withdrawFee: money(fee),
      withdrawNet: money(amount - fee)
    })
  },

  async submitWithdraw() {
    if (this.data.withdrawing) return
    const amount = Math.round((Number(this.data.withdrawAmount) || 0) * 100) / 100
    const min = Number(this.data.minWithdraw) || MIN_WITHDRAW
    const max = Number(this.data.maxWithdraw) || MAX_WITHDRAW
    const available = Number(this.data.amounts.available) || 0
    if (!(amount > 0)) return toast('请输入提现金额')
    if (amount < min) return toast('单笔提现最低 ¥' + min)
    if (amount > max) return toast('单笔提现最高 ¥' + max)
    if (amount > available) return toast('超过当前可提现金额')
    /* 同一个 requestId 重试不会重复建单；成功后清空，下一笔重新生成 */
    const requestId = this._requestId || ('w' + Date.now() + Math.floor(Math.random() * 1000))
    this._requestId = requestId
    this.setData({ withdrawing: true })
    try {
      await request('user', 'promote.withdraw', { amount, requestId })
      this._requestId = ''
      this.setData({ sheetOpen: false })
      wx.showToast({ title: '已提交，等待人工审核', icon: 'none' })
      await this.refresh()
    } catch (err) {
      /* request 已统一 toast，保留 requestId 便于原单重试 */
    }
    this.setData({ withdrawing: false })
  },

  onCancelWithdraw(e) {
    const id = (e.currentTarget && e.currentTarget.dataset.id) || ''
    if (!id) return
    wx.showModal({
      title: '撤销提现申请',
      content: '撤销后本次提现金额会退回可提现余额，确定撤销吗？',
      confirmText: '撤销',
      confirmColor: '#c0392b',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await request('user', 'promote.withdrawCancel', { id })
          wx.showToast({ title: '已撤销', icon: 'none' })
          await this.refresh()
        } catch (err) {
          /* request 已统一 toast */
        }
      }
    })
  },

  retry() {
    this.refresh()
  }
})
