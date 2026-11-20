/* 推广中心：协议开通、分享任意页面绑定下级、佣金 / 提现记录（人工分账，比例由平台统一设置） */
const { request } = require('../../utils/request')
const { writeMyRefCode } = require('../../utils/auth')

const MIN_WITHDRAW = 0.01
const MAX_WITHDRAW = 20000
const DAILY_MAX_WITHDRAW = 20000
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
  '只有好友第一次付款成功才按平台统一比例产生佣金，第二次及以后的付款（含续费）不产生佣金。佣金先进入待结算，微信 / 虚拟支付冻结至次月 15 日，Apple 内购须等平台确认款项到账后解冻。',
  '佣金比例由平台统一设置，推广者不可修改；平台调整只影响之后产生的新订单。客服绑定用户可拿一级 + 二级佣金，普通推广用户（含商机会员）只有一级佣金。',
  '可提现余额不设起提门槛，有多少可提多少，单笔上限 20,000 元，无阶梯费率；每月最多申请 1 次（被驳回或主动取消不占次数）。',
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
    reviewedText: item.reviewedText || '',
    paidText: item.paidText || '',
    /* 收款卡：开户行 + 脱敏卡号，方便用户核对打款去向 */
    bankText: [item.bankName, item.bankAccountMasked].filter(Boolean).join(' '),
    bankHolder: item.bankHolder || '',
    voucherUrl: item.voucherUrl || '',
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
    /* 客服绑定用户可拿两级，普通推广（含商机会员）只有一级 */
    level2Enabled: false,
    level2RateText: '—',
    amounts: {
      pending: '0.00',
      available: '0.00',
      withdrawn: '0.00',
      earning: '0.00'
    },
    referrals: 0,
    buyers: 0,
    statsText: '',
    minWithdraw: MIN_WITHDRAW,
    maxWithdraw: MAX_WITHDRAW,
    dailyMaxWithdraw: DAILY_MAX_WITHDRAW,
    monthlyMaxCount: 1,
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
    /* 开通时选填收款银行卡；未填可开通后再补，提现前必须补全 */
    openBankHolder: '',
    openBankName: '',
    openBankAccount: '',
    /* 已开通后的收款银行卡（脱敏展示） */
    bank: { holder: '', name: '', masked: '', ready: false },
    bankSheetOpen: false,
    bankHolderInput: '',
    bankNameInput: '',
    bankAccountInput: '',
    bankSaving: false,
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
    const buyers = Number(counts.buyers) || 0
    const bank = data.bank || {}
    /* 银行信息：接口只下发脱敏卡号，编辑时仅回填持卡人与开户行 */
    const bankView = {
      holder: bank.bankHolder || '',
      name: bank.bankName || '',
      masked: bank.bankAccountMasked || '',
      ready: bank.bankReady === true
    }
    /* 绑定人数由后端概览下发；老接口没有该字段时不展示，避免误报 0 人 */
    const statsText = counts.referrals === undefined || counts.referrals === null
      ? ''
      : '已绑定 ' + referrals + ' 人' + (counts.buyers === undefined || counts.buyers === null ? '' : ' · 成交 ' + buyers + ' 人')
    /* 已开通：把自己的推广码写入全局与本地缓存，任意页面分享 / 海报都会带上自己的 ref */
    if (active && refCode) writeMyRefCode(refCode)
    this.setData({
      active,
      refCode,
      rateText: data.rateText || rules.rateText || '—',
      level2Enabled: data.level2Enabled === true,
      level2RateText: data.level2RateText || rules.level2RateText || '—',
      amounts: {
        pending: money(totals.pending),
        available: money(totals.available),
        withdrawn: money(totals.withdrawn),
        earning: money(totals.earning)
      },
      referrals,
      buyers,
      statsText,
      bank: bankView,
      minWithdraw: Number(rules.minWithdraw) || MIN_WITHDRAW,
      maxWithdraw: Number(rules.maxWithdraw) || MAX_WITHDRAW,
      dailyMaxWithdraw: Number(rules.dailyMaxWithdraw) || DAILY_MAX_WITHDRAW,
      monthlyMaxCount: Number(rules.monthlyMaxCount) || 1,
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
        dailyMaxWithdraw: Number(info.dailyMaxWithdraw) || this.data.dailyMaxWithdraw,
        monthlyMaxCount: Number(info.monthlyMaxCount) || this.data.monthlyMaxCount,
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

  /* 开通时选填的收款银行卡 */
  onOpenBankHolder(e) { this.setData({ openBankHolder: (e.detail && e.detail.value) || '' }) },
  onOpenBankName(e) { this.setData({ openBankName: (e.detail && e.detail.value) || '' }) },
  onOpenBankAccount(e) { this.setData({ openBankAccount: (e.detail && e.detail.value) || '' }) },

  /** 已开通后修改收款银行卡：有在途提现单时后端会拒绝 */
  openBank() {
    this.setData({
      bankSheetOpen: true,
      bankHolderInput: this.data.bank.holder || this.data.realName || '',
      bankNameInput: this.data.bank.name || '',
      bankAccountInput: ''
    })
  },

  closeBank() {
    if (this.data.bankSaving) return
    this.setData({ bankSheetOpen: false })
  },

  onBankHolder(e) { this.setData({ bankHolderInput: (e.detail && e.detail.value) || '' }) },
  onBankName(e) { this.setData({ bankNameInput: (e.detail && e.detail.value) || '' }) },
  onBankAccount(e) { this.setData({ bankAccountInput: (e.detail && e.detail.value) || '' }) },

  async saveBank() {
    if (this.data.bankSaving) return
    const holder = String(this.data.bankHolderInput || '').trim()
    const bankName = String(this.data.bankNameInput || '').trim()
    const account = String(this.data.bankAccountInput || '').replace(/\s+/g, '')
    if (!holder) return toast('请填写持卡人姓名')
    if (!bankName) return toast('请填写开户银行')
    if (!/^\d{12,19}$/.test(account)) return toast('银行卡号需为 12–19 位数字')
    this.setData({ bankSaving: true })
    try {
      const res = await request('user', 'promote.saveBank', {
        bankHolder: holder,
        bankName,
        bankAccount: account
      })
      if (res && res.bank) {
        this.setData({
          bank: {
            holder: res.bank.bankHolder || holder,
            name: res.bank.bankName || bankName,
            masked: res.bank.bankAccountMasked || '',
            ready: res.bank.bankReady === true
          }
        })
      }
      this.setData({ bankSheetOpen: false })
      wx.showToast({ title: '收款银行卡已保存', icon: 'success' })
    } catch (err) {
      /* request 已统一 toast */
    }
    this.setData({ bankSaving: false })
  },

  /* 查看打款凭证：微信内直接预览大图 */
  previewVoucher(e) {
    const url = (e.currentTarget && e.currentTarget.dataset.url) || ''
    if (!url) return
    wx.previewImage({ current: url, urls: [url] })
  },

  async onApply() {
    if (this.data.applying) return
    if (!this.data.agreed) return toast('请先阅读并同意推广服务协议')
    const realName = String(this.data.realName || '').trim()
    if (realName.length < 2) return toast('请填写真实姓名')
    this.setData({ applying: true })
    try {
      const bankHolder = String(this.data.openBankHolder || '').trim()
      const bankName = String(this.data.openBankName || '').trim()
      const bankAccount = String(this.data.openBankAccount || '').replace(/\s+/g, '')
      /* 银行卡选填：只填了一部分时提示补全，避免存下不完整资料 */
      if ((bankHolder || bankName || bankAccount) && !(bankHolder && bankName && /^\d{12,19}$/.test(bankAccount))) {
        this.setData({ applying: false })
        return toast('请完整填写收款银行卡，或全部留空稍后补填')
      }
      await request('user', 'promote.open', {
        agreed: true,
        agreementVersion: this.data.agreementVersion || '',
        realName,
        bankHolder,
        bankName,
        bankAccount
      })
      wx.showToast({ title: '已开通推广资格', icon: 'success' })
      await this.refresh()
    } catch (err) {
      /* request 已统一 toast */
    }
    this.setData({ applying: false })
  },

  onShareAppMessage() {
    return {
      title: '推广大使招募 · 分享货源成交拿佣金',
      desc: '把平台货源分享给同行，成交后按单结算佣金，登录即可开通',
      path: '/pages/promote/promote'
    }
  },

  switchTab(e) {
    const tab = (e.currentTarget && e.currentTarget.dataset.tab) || 'commission'
    if (tab === this.data.tab) return
    this.setData({ tab })
  },

  openWithdraw() {
    if (!this.data.active) return
    /* 提现必须落到本人银行卡：未补全先引导填写 */
    if (!this.data.bank.ready) {
      toast('请先填写收款银行卡')
      return this.openBank()
    }
    const available = Number(this.data.amounts.available) || 0
    if (available <= 0) {
      return toast('暂无可提现余额')
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
    if (!this.data.bank.ready) return toast('请先填写收款银行卡')
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
