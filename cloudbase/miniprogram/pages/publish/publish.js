/* 发布页：入口卡片 + 表单 */
const { gate } = require('../../utils/auth')
const notify = require('../../utils/notify')
const { request, uploadFile } = require('../../utils/request')
const catalog = require('../../utils/catalog')
const { normalizePhone, isValidContactPhone, contactPhoneError } = require('../../utils/validate')
const { ensureProfileReady } = require('../../utils/profile-ready')
const { normSearch, searchHit } = require('../../utils/model')
const parse = require('../../utils/publish-parse')
const M = require('../../utils/mock')

// 表单选项：multi 为多选，def 为默认选中项
const GROUPS = {
  rentTerm: { multi: true, list: ['1 个月', '3 个月', '6 个月', '12 个月', '长期', '可议'], def: ['6 个月'] },
  closed: { list: ['闭口价（不议价）', '开口价（可议价）'], def: '闭口价（不议价）' },
  deposit: { list: ['免押金', '1 个月租金', '2 个月租金', '可议'], def: '1 个月租金' },
  pay: { list: ['月付', '季付', '半年付', '年付'], def: '季付' },
  /* 租赁限制条款：与云函数 RENT_LIMITS 枚举一一对应，多选、可留空 */
  rentLimits: {
    multi: true,
    list: [
      '不得转租或二次转让',
      '用途仅限训练 / 推理等合规业务',
      '数据不得落地存储，任务结束须清除',
      '需签署保密协议（NDA）',
      '逾期交租按日加收违约金',
      '提前退租押金不退',
      '到期未续租须退还并通过验收',
      '设备损耗按验收标准承担',
      '租赁期间不得变更机房 / 网络策略',
      '须配合出租方定期巡检'
    ],
    def: []
  },
  supply: { list: ['现货', '期货'], def: '现货' },
  tax: { list: ['含税', '不含税', '可开专票', '可开普票'], def: '含税' },
  deliver: { list: ['当日可提', '3 天内', '7 天内', '30 天内', '可议'], def: '3 天内' }
}

// 需求验收方式：现场压测 / 第三方报告，可多选
const ACCEPT_OPTIONS = ['现场压测', '第三方报告']

// 交易地按「省 / 直辖市 → 城市」两级选择
const CITY_TREE = M.CITY_TREE
const PROVINCES = Object.keys(CITY_TREE)

// 设备目录：设备类型 → 品牌 → 系列 → 型号，四级滚轮
// 优先用服务端完整目录（含管理端型号库增删）；首次渲染先用本机缓存 / 内置目录兜底，
// 联网后在 refreshCatalog 中替换为最新目录
let DEVICE_TREE = catalog.currentTree()
let DEVICE_CATS = catalog.currentCats()

/* 粘贴识别的索引：设备目录 2271 条、城市别名 746 条，首次识别时才建，目录刷新后置空重建 */
let PARSE_DEVICE_INDEX = null
let PARSE_CITY_INDEX = null

/* 入口页识别出的批量队列：入口页写入，压入的表单页 onLoad 读取后逐条发布（同模块共享） */
let PASTE_BATCH = null

/* 已发布过的同型号内容：识别时默认排除，避免重复发布；缓存 60 秒 */
let PUBLISHED_KEYS = null
let PUBLISHED_AT = 0

function loadPublishedKeys() {
  const now = Date.now()
  if (PUBLISHED_KEYS && now - PUBLISHED_AT < 60 * 1000) return Promise.resolve(PUBLISHED_KEYS)
  return request('user', 'mine.publish.list', { page: 1, limit: 50 }, { silent: true })
    .then((res) => {
      const set = new Set()
      ;((res && res.products) || []).forEach((p) => {
        const m = normSearch(p.model || '')
        if (m) set.add('sell|' + m)
      })
      ;((res && res.demands) || []).forEach((d) => {
        const m = normSearch(d.model || '')
        if (m) set.add('buy|' + m)
      })
      PUBLISHED_KEYS = set
      PUBLISHED_AT = now
      return set
    })
    .catch(() => new Set())
}

/* 同侧（商品 / 需求）+ 同型号就算重复；出售 / 出租不区分，识别阶段拿不到最终模式 */
function dupKeyOf(rec) {
  const model = normSearch((rec && rec.device && rec.device.model) || '')
  if (!model) return ''
  return (rec.type === 'buy' ? 'buy' : 'sell') + '|' + model
}

/**
 * 粘贴识别优先走云函数：规则放在服务端（cloudfunctions/user/_shared/publish-parse.js），
 * 以后新增 / 调整识别规则只需重新部署云函数，不用重新提审小程序；
 * 云函数不可用（未登录 / 网络异常 / 超时）时回落到本地同一份规则。
 */
function parseByCloud(text) {
  return request('user', 'parse.publish', { text: text }, { silent: true })
    .then((res) => (res && Array.isArray(res.records) ? res : null))
    .catch(() => null)
}

function ensureParseIndex() {
  if (!PARSE_DEVICE_INDEX) PARSE_DEVICE_INDEX = parse.buildDeviceIndex(DEVICE_TREE)
  if (!PARSE_CITY_INDEX) PARSE_CITY_INDEX = parse.buildCityIndex(CITY_TREE)
  return { deviceIndex: PARSE_DEVICE_INDEX, cityIndex: PARSE_CITY_INDEX }
}

function brandsOf(cat) {
  return Object.keys(DEVICE_TREE[cat] || {})
}
function seriesOf(cat, brand) {
  return Object.keys((DEVICE_TREE[cat] || {})[brand] || {})
}
function modelsOf(cat, brand, series) {
  return (((DEVICE_TREE[cat] || {})[brand] || {})[series]) || []
}
// 按选中的四列下标，算出四列各自的候选与合法下标
function clampIndex(v, len) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.floor(n), Math.max(0, len - 1))
}

function deviceColumns(index) {
  const cats = DEVICE_CATS
  /* 设备目录为空时返回空列，页面照常渲染而不是整页白屏 */
  if (!cats.length) return { cols: [[], [], [], []], index: [0, 0, 0, 0] }
  const raw = Array.isArray(index) ? index : []
  const ci = clampIndex(raw[0], cats.length)
  const cat = cats[ci]
  const brands = brandsOf(cat)
  const bi = clampIndex(raw[1], brands.length)
  const brand = brands[bi] || ''
  const seriesList = seriesOf(cat, brand)
  const si = clampIndex(raw[2], seriesList.length)
  const series = seriesList[si] || ''
  const models = modelsOf(cat, brand, series)
  const mi = clampIndex(raw[3], models.length)
  return {
    cols: [cats, brands, seriesList, models],
    index: [ci, bi, si, mi]
  }
}

/** 编辑回填：把已保存的条件合并回预设选项，自定义条件也一并保留 */
function mergeOptions(list, values) {
  const picked = Array.isArray(values) ? values : []
  const out = (list || []).map((v) => ({ v, on: picked.indexOf(v) > -1 }))
  picked.forEach((v) => {
    if (!out.some((o) => o.v === v)) out.push({ v, on: true })
  })
  return out
}

/** 编辑回填：按「类型 / 品牌 / 系列 / 型号」反查四级滚轮下标 */
function deviceIndexOf(cat, brand, model) {
  const ci = Math.max(0, DEVICE_CATS.indexOf(cat))
  const catName = DEVICE_CATS[ci] || ''
  const brands = brandsOf(catName)
  const bi = Math.max(0, brands.indexOf(brand))
  const brandName = brands[bi] || ''
  const seriesList = seriesOf(catName, brandName)
  let si = 0
  for (let i = 0; i < seriesList.length; i++) {
    if (modelsOf(catName, brandName, seriesList[i]).indexOf(model) > -1) {
      si = i
      break
    }
  }
  const first = deviceColumns([ci, bi, si, 0])
  const mi = Math.max(0, (first.cols[3] || []).indexOf(model))
  return deviceColumns([ci, bi, si, mi])
}

// 媒体上限：图片 5 张 / 视频 3 段；大小上限与后端 shared/constants.js 保持同口径
// 图片 10MB（手机直出照片）、文档 20MB、视频 50MB（约 1 分钟 1080p）
const MEDIA_LIMIT = { image: 5, video: 3 }
const MEDIA_MAX_BYTES = { image: 10 * 1024 * 1024, doc: 20 * 1024 * 1024, video: 50 * 1024 * 1024 }
const MEDIA_SIZE_TEXT = { image: '单张图片不能超过 10MB', doc: '单个文件不能超过 20MB', video: '单段视频不能超过 50MB' }
const MEDIA_MAX_NAME_LEN = 30

/* 按临时文件扩展名识别真实媒体类型：iPhone 常见的 MOV 不再被当成 MP4 上传 */
function mediaMeta(kind, file) {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(String((file && file.tempFilePath) || ''))
  const ext = (m ? m[1] : '').toLowerCase()
  if (kind === 'image') {
    if (ext === 'png') return { type: 'image/png', ext: 'png' }
    if (ext === 'webp') return { type: 'image/webp', ext: 'webp' }
    return { type: 'image/jpeg', ext: 'jpg' }
  }
  if (ext === 'mov') return { type: 'video/quicktime', ext: 'mov' }
  if (ext === 'm4v') return { type: 'video/x-m4v', ext: 'm4v' }
  return { type: 'video/mp4', ext: 'mp4' }
}

function fmtSize(n) {
  const size = Number(n) || 0
  if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB'
  if (size >= 1024) return Math.round(size / 1024) + ' KB'
  return size + ' B'
}

/** 金额千分位：服务费试算与展示统一走这里 */
function fmtMoney(n) {
  const v = Math.round(Number(n) || 0)
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 服务费：代采 / 代售统一后付费，发布、审核、上架都不收费，成交后再支付。
 * 计费口径：≤3 万 299 元 / 单；3 万–100 万 1% 封顶 5000；100 万元以上 0.5% 上不封顶；
 * 1000 万元及以上代采 / 代售同样按 0.5% 收取（仅资料核验要求不同），成交后支付；
 * 租赁：按首月租金合计，服务费为一个月租金，买卖双方各承担 50%，委托方只支付半个月租金。
 * 与云函数 shared/market.js 的 agencyFee 保持同一口径，最终以服务端计算为准。
 */
const LARGE_AMOUNT_THRESHOLD = 10000000

function agencyFee(amount, rental, side) {
  const total = Number(amount) || 0
  if (!(total > 0)) return { fee: 0, upfront: 0, rule: '', note: '' }

  /* 租赁：一个月租金由买卖双方各承担 50%，委托方账单为半个月租金 */
  if (rental) {
    return {
      fee: total * 0.5,
      upfront: 0,
      deferredFee: true,
      rule: '按首月租金合计，买卖双方各承担 50%（成交后支付）',
      note: '本账单为委托方应承担的半个月租金，另一方 50% 由平台另行收取，成交后支付。'
    }
  }

  /* 1000 万元及以上：费率与 100 万元以上一致（0.5% 上不封顶），只是资料核验要求更高 */
  if (total >= LARGE_AMOUNT_THRESHOLD) {
    return {
      fee: total * 0.005,
      upfront: 0,
      largeAmount: true,
      deferredFee: true,
      rule: '100 万元以上：0.5%，上不封顶（成交后支付）',
      note: side === 'buy'
        ? '提交采购意向函、验资证明、联系人身份证，委托授权书可选；资料核验后上架；订单只对平台可见；成交后支付 0.5% 服务费。'
        : '提交营业执照、物权证明、联系人身份证，委托授权书可选；资料核验后上架；成交后支付 0.5% 服务费。'
    }
  }

  if (total <= 30000) {
    return { fee: 299, upfront: 0, rule: '≤ 3 万元：299 元 / 单', note: '3 万元以内按单收取 299 元服务费，成交后支付。' }
  }
  if (total <= 1000000) {
    return { fee: Math.min(total * 0.01, 5000), upfront: 0, rule: '3 万 – 100 万元：1%，封顶 5,000 元', note: '3 万至 100 万元按 1% 收取，单笔封顶 5,000 元，成交后支付。' }
  }
  return {
    fee: total * 0.005,
    upfront: 0,
    rule: '100 万元以上：0.5%，上不封顶（成交后支付）',
    note: '100 万元以上按成交金额 0.5% 收取，上不封顶，成交后支付。'
  }
}

/** 本地日期（YYYY-MM-DD）：截止时间选择器的最早 / 最晚与默认值都走这里 */
function dateStr(offsetDays) {
  const d = new Date()
  d.setDate(d.getDate() + Number(offsetDays || 0))
  const mm = d.getMonth() + 1
  const dd = d.getDate()
  return d.getFullYear() + '-' + (mm < 10 ? '0' + mm : mm) + '-' + (dd < 10 ? '0' + dd : dd)
}

// 条件与流程的展示口径：发布方设定，对方必须满足 / 可协商
const SIDE_TITLE = {
  seller: { must: '买家必须满足', nego: '可与买家协商', flow: '购买流程', who: '买家' },
  buyer: { must: '供给方必须满足', nego: '可与供给方协商', flow: '响应流程', who: '供给方' },
  renter: { must: '承租方必须满足', nego: '可与承租方协商', flow: '租赁流程', who: '承租方' },
  lessor: { must: '出租方必须满足', nego: '可与出租方协商', flow: '租赁申请流程', who: '出租方' }
}

function sideOf(type, isRent) {
  if (type === 'buy') return isRent ? 'lessor' : 'buyer'
  return isRent ? 'renter' : 'seller'
}

Page({
  data: {
    /* 自定义导航：状态栏 + 标题栏高度，标题随发布类型变化 */
    statusBarH: 20,
    navH: 44,
    navTitle: '发布',
    type: '', // sell / buy / ''（入口页）
    mode: '', // 出售/出租/求购/租赁
    isRent: false,
    /* 成色：全新 / 二手；二手再标几成新，商机按「新二手 + 起订量」匹配 */
    condType: 'new',
    condLevel: '9成新',
    condLevels: ['95新', '9成新', '8成新', '7成新及以下'],
    /* 更多要求默认收起：条件与流程不预设，用户自己添加 */
    moreOpen: false,
    /* 币种：默认人民币 */
    currency: 'CNY',
    currencyIndex: 0,
    currencyOptions: [
      { code: 'CNY', symbol: '¥', label: '人民币' },
      { code: 'USD', symbol: '$', label: '美元' },
      { code: 'USDT', symbol: '₮', label: 'USDT' },
      { code: 'HKD', symbol: 'HK$', label: '港币' },
      { code: 'EUR', symbol: '€', label: '欧元' },
      { code: 'GBP', symbol: '£', label: '英镑' },
      { code: 'JPY', symbol: '¥', label: '日元' },
      { code: 'SGD', symbol: 'S$', label: '新加坡元' },
      { code: 'AED', symbol: 'د.إ', label: '迪拉姆' },
      { code: 'BTC', symbol: '₿', label: '比特币' }
    ],
    currencyLabels: ['人民币 ¥', '美元 $', 'USDT ₮', '港币 HK$', '欧元 €', '英镑 £', '日元 ¥', '新加坡元 S$', '迪拉姆 د.إ', '比特币 ₿'],
    form: { title: '', qty: '', minQty: '', maxQty: '', price: '', priceMax: '', priceMode: 'fixed', accept: '', limit: '', note: '', cat: '', brand: '', series: '', model: '', device: '', devicePath: '', province: '', city: '' },
    modeOptions: ['出售', '出租'],
    /* 设备列在 onLoad 里计算：模块加载阶段算会让缺键 / 空目录直接白屏 */
    deviceCols: [],
    deviceIndex: [0, 0, 0, 0],
    /* 设备搜索：输入关键词即时匹配，点结果直接选中并回填到同一个输入框 */
    deviceKeyword: '',
    deviceResults: [],
    deviceSearchOpen: false,
    /* 需求侧只选设备类型时用的单列滚轮 */
    catIndex: 0,
    catOptions: DEVICE_CATS,
    /* 需求验收方式：现场压测 / 第三方报告 */
    acceptOpts: ACCEPT_OPTIONS.map((v) => ({ v, on: false })),
    provinces: PROVINCES,
    cities: [],
    groups: {},
    selected: {},
    /* 条件设置：必须条件 / 可沟通条件（可自己新增） */
    condSide: 'seller',
    mustTitle: '买家必须满足',
    negoTitle: '可与买家协商',
    flowTitle: '购买流程',
    mustOpts: [],
    negoOpts: [],
    mustInput: '',
    negoInput: '',
    /* 交易流程（可增删与排序） */
    flow: [],
    stepSeq: 0,
    stepName: '',
    stepDesc: '',
    /* 出售商品可同步一条私库存，参与平台新需求的商机匹配 */
    syncStock: true,
    /* 发布方式：默认公开并自动进入商机匹配，可切换为仅发商机池 */
    /* 仅发商机池：只进匹配池，首页 / 搜索 / 货架都看不到；默认关闭，由用户自行选择 */
    poolOnly: false,
    /* 代采 / 代售设备：只能从平台预设型号库选择，支持搜索或展开目录 */
    agDeviceCols: [],
    agDeviceIndex: [0, 0, 0, 0],
    agDevicePath: '',
    agDeviceKeyword: '',
    agDeviceResults: [],
    agDeviceSearchOpen: false,
    /* 媒体：选填，图片最多 5 张、视频最多 3 段，可自定义命名 */
    imgList: [],
    videoList: [],
    mediaSeq: 0,
    /* 当前草稿 id：连续存草稿覆盖同一条 */
    draftId: '',
    /* 编辑模式：从「我的 · 我发布的」带 id + kind 进入，回填后原地保存 */
    editing: false,
    editId: '',
    editKind: 'product',
    editStatus: '',
    editLoading: false,
    /* 是否由「发布类型选择」压入：返回 / 发布成功都退回上一层入口页 */
    fromEntry: false,
    /* 代采 / 代售委托：独立于普通发布流程，不影响原有表单与校验 */
    agencyType: '', // buy / sell
    /* 重新提交：被驳回的委托带 id 回到本页预填，提交时原地覆盖并重新排队审核 */
    agencyResubmitId: '',
    agencyMode: '求购',
    agencyModeOptions: ['求购', '租赁'],
    agencyRent: false,
    agencyTerms: ['3 个月', '6 个月', '12 个月', '长期'],
    agencyTerm: '6 个月',
    /* 截止时间：到期仍未成交则委托自动停止；代采合同即以此时间为准 */
    agencyDeadline: '',
    agencyDeadlineMin: dateStr(1),
    agencyDeadlineMax: dateStr(365),
    agencySubjectType: 'company', // company 企业 / person 个人
    agencyForm: { item: '', qty: '', price: '', subject: '', creditCode: '', legal: '', idCard: '', phone: '' },
    agencyAgree: false,
    /* 代采 / 代售的条件与流程：常显，条件逐项添加、流程可增删排序 */
    agencyCondSide: 'buyer',
    agencyMustTitle: '供给方必须满足',
    agencyNegoTitle: '可与供给方协商',
    agencyFlowTitle: '交易流程',
    agencyMustOpts: [],
    agencyNegoOpts: [],
    agencyMustInput: '',
    agencyNegoInput: '',
    agencyFlow: [],
    agencyStepSeq: 0,
    agencyStepName: '',
    agencyStepDesc: '',
    agLicense: null,
    agProof: null,
    agLoi: null,
    agAuthorization: null,
    agIdcard: null,
    agOther: [],
    feeAmountText: '—',
    feeText: '0',
    feeRule: '填写金额后自动试算',
    feeNote: '发布、审核、上架都不收费，成交后再支付服务费。',
    /* 粘贴文字自动填表：在入口页一次识别多条，出→商品、收→需求，逐条发布 */
    pasteOpen: true,
    pasteText: '',
    pasteRecords: [],
    pasteSellCount: 0,
    pasteBuyCount: 0,
    pasteQueue: [],
    pasteTotal: 0,
    pasteDone: 0
  },

  onLoad(options) {
    const opts = options || {}
    /* entry=1：本页是从「发布类型选择」压进来的表单页，返回时退回上一层入口页 */
    this.setData({ fromEntry: opts.entry === '1' })
    /* 自定义导航尺寸：状态栏高度 + 与胶囊对齐的标题栏高度 */
    let statusBarH = 20
    let navH = 44
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      if (info && info.statusBarHeight) statusBarH = info.statusBarHeight
    } catch (e) {}
    try {
      const rect = wx.getMenuButtonBoundingClientRect()
      if (rect && rect.height && rect.top >= statusBarH) {
        navH = (rect.top - statusBarH) * 2 + rect.height
      }
    } catch (e) {}
    this.setData({ statusBarH, navH })
    /* 从首页「实时货盘 / 找平台代采」直达代采委托表单 */
    if (opts.agency === 'buy' || opts.agency === 'sell') {
      let target = ''
      try {
        target = opts.target ? decodeURIComponent(opts.target) : ''
      } catch (e) {
        target = ''
      }
      this.enterAgency(opts.agency, target)
      /* 被驳回的委托：进入表单后拉取本人委托详情回填，可改内容、重传材料后重新提交 */
      if (opts.agencyId) this.loadAgencyResubmit(String(opts.agencyId))
      return
    }
    /* entry=1：本页是从「发布类型选择」压进来的表单页，返回时退回上一层入口页 */
    this.setData({ type: opts.type || '' })
    this.setData({ deviceCols: deviceColumns([0, 0, 0, 0]).cols })
    /* 平台型号库会在后台合并进来，编辑回填前会等待 catalogReady */
    this.catalogReady = this.refreshCatalog()
    if (opts.id) {
      /* 编辑：先按 kind 定好出售 / 求购，再拉详情回填；回填前不允许提交 */
      const kind = opts.kind === 'demand' ? 'demand' : 'product'
      this.setData({
        editing: true,
        editId: String(opts.id),
        editKind: kind,
        type: kind === 'demand' ? 'buy' : 'sell',
        mode: kind === 'demand' ? '求购' : '出售'
      })
      this.initSelected()
      this.checkRent()
      this.syncModeOptions()
      this.syncTitle()
      this.resetCondFlow()
      this.loadEdit()
      return
    }
    if (opts.type === 'sell') {
      /* 商品默认公开展示：内容进列表，展示发布者身份 */
      this.setData({ mode: '出售' })
    } else if (opts.type === 'buy') {
      this.setData({ mode: '求购' })
    }
    this.initSelected()
    this.checkRent()
    this.syncModeOptions()
    this.syncTitle()
    this.resetCondFlow()
    /* 入口页点「逐条发布」：取队列第一条填表，其余发布成功后自动接着载入 */
    if (opts.paste === '1' && PASTE_BATCH) {
      const batch = PASTE_BATCH
      PASTE_BATCH = null
      this.setData({
        pasteQueue: batch.list.slice(1),
        pasteTotal: batch.total,
        pasteDone: 0
      })
      this.applyPasteRecord(batch.list[0])
    }
  },

  onShow() {
    gate(this.route || 'pages/publish/publish', this.options)
    /* 管理端刚增删过型号：返回本页时静默刷新目录（60s 内直接用内存缓存，不重复请求） */
    this.refreshCatalog()
    /* 返回本页后恢复离开提醒（跳去个人信息时临时关闭过） */
    this.syncLeaveGuard()
  },

  /* ---------- 离开提醒：已填写内容时，返回前先问是否存草稿 ---------- */
  hasDraftContent() {
    const f = this.data.form || {}
    if (String(f.title || '').trim()) return true
    if (String(f.device || '').trim()) return true
    if (String(f.price || '').trim() || String(f.qty || '').trim()) return true
    if (String(f.note || '').trim()) return true
    if (String(this.data.pasteText || '').trim()) return true
    if ((this.data.pasteQueue || []).length) return true
    if ((this.data.imgList || []).length) return true
    if ((this.data.videoList || []).length) return true
    return false
  },

  /* 只在「发布 / 编辑表单」里有内容时开启返回询问；选类型的入口页和提交成功后的空表单都不提示 */
  syncLeaveGuard() {
    if (this.data.agencyType) return
    const inForm = !!this.data.type
    const on = inForm && (this.data.editing || this.hasDraftContent())
    const pending = (this.data.pasteQueue || []).length
    /* 剩余待发布条数变化时也要重注册，提示里带上「另有 N 条待发布」 */
    if (on === this._leaveGuard && pending === this._leavePending) return
    this._leaveGuard = on
    this._leavePending = pending
    if (!wx.enableAlertBeforeUnload) return
    const tail = pending ? '（另有 ' + pending + ' 条待发布）' : ''
    try {
      if (on) {
        wx.enableAlertBeforeUnload({
          message: this.data.editing
            ? '修改还没保存：点「取消」留在本页继续编辑；点「确定」直接退出，修改不保存。'
            : '内容还没保存：点「取消」留在本页，可点底部「存草稿」保留；点「确定」直接退出，内容不保存。' + tail
        })
      } else {
        wx.disableAlertBeforeUnload()
      }
    } catch (e) {}
  },

  onUnload() {
    if (!wx.disableAlertBeforeUnload) return
    try { wx.disableAlertBeforeUnload() } catch (e) {}
  },

  // 交易方式候选：发布商品 → 出售/出租；发布需求 → 求购/租赁
  syncModeOptions() {
    this.setData({ modeOptions: this.data.type === 'buy' ? ['求购', '租赁'] : ['出售', '出租'] })
  },

  syncTitle() {
    const type = this.data.type
    let title = '发布'
    if (this.data.editing) {
      title = this.data.editKind === 'demand'
        ? (this.data.isRent ? '编辑租赁需求' : '编辑求购需求')
        : (this.data.isRent ? '编辑出租设备' : '编辑商品')
    } else if (type === 'sell') title = this.data.isRent ? '发布出租设备' : '发布商品'
    else if (type === 'buy') title = this.data.isRent ? '发布租赁需求' : '发布求购需求'
    this.setData({ navTitle: title })
  },

  checkRent() {
    const isRent = this.data.mode === '出租' || this.data.mode === '租赁'
    this.setData({ isRent })
  },

  /* ---------- 选项组 ---------- */
  initSelected() {
    const selected = {}
    Object.keys(GROUPS).forEach((k) => {
      selected[k] = GROUPS[k].multi ? GROUPS[k].def.slice() : GROUPS[k].def
    })
    this.setData({ selected, groups: this.buildGroups(selected) })
  },

  buildGroups(selected) {
    const groups = {}
    Object.keys(GROUPS).forEach((key) => {
      const g = GROUPS[key]
      const sel = selected[key]
      groups[key] = g.list.map((v) => ({
        v,
        on: g.multi ? (sel || []).indexOf(v) > -1 : sel === v
      }))
    })
    return groups
  },

  pickChip(e) {
    const key = e.currentTarget.dataset.key
    const val = e.currentTarget.dataset.val
    const g = GROUPS[key]
    if (!g) return
    const selected = Object.assign({}, this.data.selected)
    if (g.multi) {
      const arr = (selected[key] || []).slice()
      const i = arr.indexOf(val)
      if (i > -1) arr.splice(i, 1)
      else arr.push(val)
      selected[key] = arr
    } else {
      selected[key] = val
    }
    this.setData({ selected, groups: this.buildGroups(selected) })
  },

  /* ---------- 条件设置：必须条件 / 可沟通条件 ---------- */
  // 切换出售 / 出租 / 求购 / 租赁时，只换文案与候选，不预设任何条件与流程
  resetCondFlow() {
    const type = this.data.type
    const isRent = this.data.isRent
    const side = sideOf(type, isRent)
    const t = SIDE_TITLE[side]
    const presets = M.COND_PRESETS
    const mustList = presets[side] || []
    const negoList = (isRent ? presets.negoRent : presets.nego) || []
    this.setData({
      condSide: side,
      mustTitle: t.must,
      negoTitle: t.nego,
      flowTitle: t.flow,
      mustOpts: mustList.map((v) => ({ v, on: false })),
      negoOpts: negoList.map((v) => ({ v, on: false })),
      flow: [],
      stepSeq: 0,
      mustInput: '',
      negoInput: '',
      stepName: '',
      stepDesc: ''
    })
  },

  /* 更多要求：默认收起，展开后才显示条件与交易流程 */
  toggleMore() {
    this.setData({ moreOpen: !this.data.moreOpen })
  },

  /* 成色：全新 / 二手；二手时再选几成新 */
  pickCondType(e) {
    const v = e.currentTarget.dataset.v === 'used' ? 'used' : 'new'
    this.setData({ condType: v })
  },

  pickCondLevel(e) {
    this.setData({ condLevel: String(e.currentTarget.dataset.v || '') })
  },

  pickCond(e) {
    const kind = e.currentTarget.dataset.kind
    const val = e.currentTarget.dataset.v
    const key = kind === 'must' ? 'mustOpts' : 'negoOpts'
    const opts = this.data[key].map((o) => (o.v === val ? Object.assign({}, o, { on: !o.on }) : o))
    this.setData({ [key]: opts })
  },

  onCondInput(e) {
    const kind = e.currentTarget.dataset.kind
    this.setData(kind === 'must' ? { mustInput: e.detail.value } : { negoInput: e.detail.value })
  },

  // 自定义新增一条条件，并默认选中
  addCond(e) {
    const kind = e.currentTarget.dataset.kind
    const key = kind === 'must' ? 'mustOpts' : 'negoOpts'
    const inputKey = kind === 'must' ? 'mustInput' : 'negoInput'
    const val = String(this.data[inputKey] || '').trim()
    if (!val) {
      wx.showToast({ title: '请先输入条件内容', icon: 'none' })
      return
    }
    if (this.data[key].some((o) => o.v === val)) {
      wx.showToast({ title: '该条件已存在', icon: 'none' })
      return
    }
    this.setData({ [key]: this.data[key].concat([{ v: val, on: true }]), [inputKey]: '' })
  },

  /* ---------- 交易流程：改步骤 / 增删 / 排序 ---------- */
  onStepInput(e) {
    const i = Number(e.currentTarget.dataset.i)
    const k = e.currentTarget.dataset.k
    const flow = this.data.flow.slice()
    flow[i] = Object.assign({}, flow[i], { [k]: e.detail.value })
    this.setData({ flow })
  },

  onStepDraft(e) {
    const k = e.currentTarget.dataset.k
    this.setData(k === 'name' ? { stepName: e.detail.value } : { stepDesc: e.detail.value })
  },

  addStep() {
    const n = String(this.data.stepName || '').trim()
    const d = String(this.data.stepDesc || '').trim()
    if (!n) {
      wx.showToast({ title: '请填写步骤名称', icon: 'none' })
      return
    }
    const seq = this.data.stepSeq + 1
    this.setData({
      flow: this.data.flow.concat([{ id: 's' + seq, n, d }]),
      stepSeq: seq,
      stepName: '',
      stepDesc: ''
    })
  },

  removeStep(e) {
    const i = Number(e.currentTarget.dataset.i)
    const flow = this.data.flow.slice()
    flow.splice(i, 1)
    this.setData({ flow })
  },

  moveStep(e) {
    const i = Number(e.currentTarget.dataset.i)
    const j = e.currentTarget.dataset.dir === 'up' ? i - 1 : i + 1
    if (j < 0 || j >= this.data.flow.length) return
    const flow = this.data.flow.slice()
    const tmp = flow[i]
    flow[i] = flow[j]
    flow[j] = tmp
    this.setData({ flow })
  },

  /* ---------- 文本输入 ---------- */
  onInput(e) {
    const key = e.currentTarget.dataset.key
    const form = Object.assign({}, this.data.form)
    form[key] = e.detail.value
    this.setData({ form })
    this.syncLeaveGuard()
  },

  /* 价格方式：固定单价 / 价格区间 / 现场沟通；切回固定时清掉最高价 */
  pickPriceMode(e) {
    const raw = e.currentTarget.dataset.mode
    const mode = raw === 'range' || raw === 'nego' ? raw : 'fixed'
    if (mode === this.data.form.priceMode) return
    const form = Object.assign({}, this.data.form, { priceMode: mode })
    if (mode === 'fixed') form.priceMax = ''
    this.setData({ form })
    this.syncLeaveGuard()
  },

  /* ---------- 设备搜索：把四级目录摊平成一行一条，输入即匹配 ---------- */
  deviceSearchIndex() {
    if (this.deviceFlat) return this.deviceFlat
    const out = []
    DEVICE_CATS.forEach((cat) => {
      Object.keys(DEVICE_TREE[cat] || {}).forEach((brand) => {
        Object.keys(DEVICE_TREE[cat][brand] || {}).forEach((series) => {
          (DEVICE_TREE[cat][brand][series] || []).forEach((model) => {
            out.push({
              k: cat + '|' + brand + '|' + series + '|' + model,
              cat,
              brand,
              series,
              model,
              path: [cat, brand, series].join(' · '),
              hay: (cat + ' ' + brand + ' ' + series + ' ' + model).toLowerCase()
            })
          })
        })
      })
    })
    this.deviceFlat = out
    return out
  },

  /* 输入即匹配：整串包含 / 多词乱序 / 子序列兜底都算命中；
     型号前缀命中的排前面，最多 20 条。空关键词返回目录前 20 条，点开即可浏览。 */
  matchDevices(rawKeyword) {
    const kw = String(rawKeyword == null ? '' : rawKeyword)
    const query = normSearch(kw)
    const toItem = (it) => ({
      k: it.k,
      model: it.model,
      path: it.path,
      cat: it.cat,
      brand: it.brand,
      series: it.series
    })
    const index = this.deviceSearchIndex()
    if (!query) return { results: index.slice(0, 20).map(toItem) }
    const head = []
    const rest = []
    index.forEach((it) => {
      if (!searchHit(it.hay, kw)) return
      if (normSearch(it.model).indexOf(query) === 0) head.push(it)
      else rest.push(it)
    })
    return { results: head.concat(rest).slice(0, 20).map(toItem) }
  },

  /* 原样保留输入内容（含空格），只把关键词用于匹配；回写 trim 后的值会导致空格打不进去 */
  onDeviceSearch(e) {
    const value = String((e.detail && e.detail.value) || '')
    this.setData({
      deviceKeyword: value,
      deviceResults: this.matchDevices(value).results,
      deviceSearchOpen: true,
      'form.model': '',
      'form.device': '',
      'form.devicePath': ''
    })
  },

  /* 空输入框聚焦时列出目录前 30 条，替代原来的「展开目录」入口 */
  focusDeviceSearch() {
    if (String(this.data.deviceKeyword || '').trim()) return
    this.setData({ deviceResults: this.matchDevices('').results, deviceSearchOpen: true })
  },

  clearDeviceSearch() {
    this.setData({
      deviceKeyword: '',
      deviceResults: [],
      deviceSearchOpen: false,
      'form.model': '',
      'form.device': '',
      'form.devicePath': ''
    })
  },

  /* 选中一个设备：反算四级下标，同步滚轮位置后回填表单，并把型号显示在同一个输入框里 */
  applyDevice(item) {
    if (!item) return
    const cat = DEVICE_CATS[Math.max(0, DEVICE_CATS.indexOf(item.cat))] || ''
    const brands = brandsOf(cat)
    const brand = brands[Math.max(0, brands.indexOf(item.brand))] || ''
    const seriesList = seriesOf(cat, brand)
    const series = seriesList[Math.max(0, seriesList.indexOf(item.series))] || ''
    const models = modelsOf(cat, brand, series)
    const mi = Math.max(0, models.indexOf(item.model))
    const next = deviceColumns([DEVICE_CATS.indexOf(cat), brands.indexOf(brand), seriesList.indexOf(series), mi])
    this.setData({
      deviceIndex: next.index,
      deviceCols: next.cols,
      deviceKeyword: item.model,
      deviceResults: [],
      deviceSearchOpen: false,
      'form.cat': cat,
      'form.brand': brand,
      'form.series': series,
      'form.model': item.model,
      'form.device': item.model,
      'form.devicePath': [cat, brand, series].join(' · ')
    })
  },

  pickDeviceSearch(e) {
    const item = (this.data.deviceResults || [])[Number(e.currentTarget.dataset.i)]
    if (!item) return
    this.applyDevice(item)
    this.syncLeaveGuard()
  },

  /* ---------- 粘贴文字自动填表 ---------- */
  togglePaste() {
    this.setData({ pasteOpen: !this.data.pasteOpen })
  },

  onPasteInput(e) {
    this.setData({ pasteText: String((e.detail && e.detail.value) || '') })
  },

  onPasteClear() {
    PASTE_BATCH = null
    this.setData({
      pasteText: '',
      pasteRecords: [],
      pasteSellCount: 0,
      pasteBuyCount: 0,
      pasteQueue: [],
      pasteTotal: 0,
      pasteDone: 0
    })
    this.syncLeaveGuard()
  },

  /* 识别：出→商品、收→需求；多条先列成清单勾选，再逐条进入对应表单发布 */
  async onPasteParse() {
    const text = String(this.data.pasteText || '').trim()
    if (!text) {
      wx.showToast({ title: '请先粘贴文字', icon: 'none' })
      return
    }
    /* 等平台型号目录合并完，型号匹配更准 */
    if (this.catalogReady) {
      try { await this.catalogReady } catch (e) { /* 目录拉取失败用内置目录继续 */ }
    }
    /* 识别的规则在云端：先调云函数，失败再用本地规则兜底 */
    wx.showLoading({ title: '识别中', mask: true })
    let res = await parseByCloud(text)
    if (!res) {
      try {
        res = parse.parseText(text, ensureParseIndex())
      } catch (e) {
        wx.hideLoading()
        wx.showToast({ title: '识别失败，请手动填写', icon: 'none' })
        return
      }
    }
    wx.hideLoading()
    /* 云端已补过缺省值；本地兜底时在这里补：没价格→现场沟通，避免用户再选一次 */
    const records = parse.fillDefaults((res && res.records) || [], {})
    if (!records.length) {
      wx.showToast({ title: '没有识别到可发布的内容', icon: 'none' })
      return
    }
    /* 已经发布过的同款同型号默认排除，避免重复发布 */
    let published = new Set()
    try { published = await loadPublishedKeys() } catch (e) { /* 拉取失败就不做去重 */ }
    let dupCount = 0
    records.forEach((r) => {
      const key = dupKeyOf(r)
      if (key && published.has(key)) {
        r.checked = false
        r.duplicate = true
        r.warnings = ['已发布过同型号，已默认排除'].concat(r.warnings || [])
        dupCount++
      }
    })
    const checkedCount = records.filter((r) => r.checked).length
    this.setData({
      pasteRecords: records,
      pasteSellCount: records.filter((r) => r.type !== 'buy' && r.checked).length,
      pasteBuyCount: records.filter((r) => r.type === 'buy' && r.checked).length,
      pasteQueue: [],
      pasteTotal: 0,
      pasteDone: 0
    })
    if (!checkedCount) {
      wx.showToast({ title: '识别到的内容均已发布过，已默认排除', icon: 'none' })
      return
    }
    if (dupCount && checkedCount < records.length) {
      wx.showToast({ title: '已排除 ' + dupCount + ' 条同型号内容', icon: 'none' })
    }
    /* 只识别到一条：直接进表单，少点一步 */
    if (records.length === 1) this.onPasteConfirm()
  },

  onPasteToggleAll() {
    const records = this.data.pasteRecords || []
    const allOn = records.length > 0 && records.every((r) => r.checked)
    this.setData({
      pasteRecords: records.map((r) => Object.assign({}, r, { checked: !allOn }))
    })
  },

  onPasteToggle(e) {
    const i = Number(e.currentTarget.dataset.i)
    const records = (this.data.pasteRecords || []).map((r, idx) => (
      idx === i ? Object.assign({}, r, { checked: !r.checked }) : r
    ))
    this.setData({ pasteRecords: records })
  },

  onPasteRemove(e) {
    const i = Number(e.currentTarget.dataset.i)
    const records = (this.data.pasteRecords || []).filter((r, idx) => idx !== i)
    this.setData({ pasteRecords: records })
  },

  /* 勾选确认：入口页把整批队列交给压入的表单页；表单页内则直接填当前表单 */
  onPasteConfirm() {
    const picked = (this.data.pasteRecords || []).filter((r) => r.checked)
    if (!picked.length) {
      wx.showToast({ title: '请至少勾选一条', icon: 'none' })
      return
    }
    if (this.data.type) {
      this.setData({
        pasteRecords: [],
        pasteQueue: picked.slice(1),
        pasteTotal: picked.length,
        pasteDone: 0
      })
      this.applyPasteRecord(picked[0])
      if (picked.length > 1) {
        wx.showToast({ title: '已载入第 1 条，共 ' + picked.length + ' 条', icon: 'none' })
      }
      return
    }
    PASTE_BATCH = { list: picked, total: picked.length }
    this.setData({ pasteRecords: [], pasteQueue: [], pasteTotal: 0, pasteDone: 0 })
    const type = picked[0].type === 'buy' ? 'buy' : 'sell'
    wx.navigateTo({ url: '/pages/publish/publish?entry=1&type=' + type + '&paste=1' })
  },

  /* 结束批量：丢弃剩余队列，当前这条照常发布 */
  onPasteCancelQueue() {
    this.setData({ pasteQueue: [], pasteTotal: 0, pasteDone: 0 })
    this.syncLeaveGuard()
  },

  /* 把一条识别结果整体写入表单：先回到空表单基线，再按识别结果覆盖 */
  applyPasteRecord(rec) {
    if (!rec) return
    const isBuy = this.data.type === 'buy'
    const isRent = this.data.isRent
    const side = sideOf(this.data.type, isRent)
    const f = rec.fields || {}

    /* 选项组：默认值打底，识别到的值覆盖（多选键如 rentTerm 本身就是数组） */
    const selected = {}
    Object.keys(GROUPS).forEach((k) => {
      selected[k] = GROUPS[k].multi ? GROUPS[k].def.slice() : GROUPS[k].def
    })
    Object.keys(rec.picked || {}).forEach((k) => {
      if (!GROUPS[k]) return
      selected[k] = GROUPS[k].multi
        ? (Array.isArray(rec.picked[k]) ? rec.picked[k].slice() : [])
        : rec.picked[k]
    })

    /* 能默认的直接用默认值：现货 / 含税 / 3 天内；原文写到的再覆盖 */
    const condType = f.condType === 'used' ? 'used' : 'new'

    /* 交易地缺省内已由服务端用账号城市补齐，这里直接回填 */
    const province = String(f.province || '')
    const city = String(f.city || '')
    const qty = String(f.qty || '')
    /* 起订量不兜底：原文没写就留空，避免把 100 台起订写成 1 台起订 */
    const minQty = isBuy ? '' : String(f.minQty || '')

    const form = this.data.form && this.data.form.title !== undefined
      ? Object.assign({}, this.data.form)
      : {}
    form.title = String(rec.title || '')
    form.qty = qty
    form.minQty = minQty
    /* 每批上限只在出售时有意义：直接发布时另写入「可承接数量」 */
    form.maxQty = isBuy || isRent ? '' : String(f.maxQty || '')
    /* 价格：原文没给金额时默认「现场沟通」，不公开金额也不拦发布 */
    const priceNum = Number(String(f.price == null ? '' : f.price).replace(/,/g, ''))
    const priceMaxNum = Number(String(f.priceMax == null ? '' : f.priceMax).replace(/,/g, ''))
    let priceMode = f.priceMode || 'fixed'
    if (!(priceNum > 0)) priceMode = 'nego'
    /* 区间只给了一头：按固定单价处理，避免卡在「请填写最高价」 */
    else if (priceMode === 'range' && !(priceMaxNum > 0)) priceMode = 'fixed'
    form.price = priceNum > 0 ? String(f.price) : ''
    form.priceMode = priceMode
    form.priceMax = priceMode === 'range' ? String(f.priceMax) : ''

    form.accept = ''
    form.limit = ''
    form.note = String(rec.note || '')
    form.cat = ''
    form.brand = ''
    form.series = ''
    form.model = ''
    form.device = ''
    form.devicePath = ''
    form.province = province
    form.city = city

    const presets = M.COND_PRESETS
    const mustList = presets[side] || []
    const negoList = (isRent ? presets.negoRent : presets.nego) || []
    const mustOpts = mergeOptions(mustList, rec.must || [])
    const negoOpts = mergeOptions(negoList, rec.nego || [])
    const flow = (rec.flow || []).slice(0, 12).map((s, i) => ({ id: 's' + (i + 1), n: s.n, d: s.d }))
    /* 币种：识别到「75 万美金」这类写法时切到对应币种，否则保持人民币 */
    const curList = this.data.currencyOptions || []
    const curCode = f.currency || 'CNY'
    const curIndex = Math.max(0, curList.findIndex((c) => c.code === curCode))

    this.setData({
      form,
      currency: curList[curIndex] ? curList[curIndex].code : 'CNY',
      currencyIndex: curIndex,
      condType: condType || '',
      condLevel: f.condLevel || '9成新',
      cities: province ? (CITY_TREE[province] || []).slice() : [],
      deviceKeyword: '',
      deviceResults: [],
      deviceSearchOpen: false,
      acceptOpts: ACCEPT_OPTIONS.map((v) => ({ v, on: false })),
      selected,
      groups: this.buildGroups(selected),
      condSide: side,
      mustTitle: SIDE_TITLE[side].must,
      negoTitle: SIDE_TITLE[side].nego,
      flowTitle: SIDE_TITLE[side].flow,
      mustOpts,
      negoOpts,
      flow,
      stepSeq: flow.length,
      mustInput: '',
      negoInput: '',
      stepName: '',
      stepDesc: '',
      /* 识别到条件或流程时自动展开「更多要求」，用户能直接看到并复核 */
      moreOpen: mustOpts.some((o) => o.on) || negoOpts.some((o) => o.on) || flow.length > 0,
      imgList: [],
      videoList: [],
      mediaSeq: 0,
      draftId: ''
    })

    this.applyDevice(rec.device)
    this.syncLeaveGuard()

    const warns = (rec.warnings || []).slice()
    if (warns.length) {
      wx.showModal({
        title: '已自动填写，请核对',
        content: warns.slice(0, 3).join('\n'),
        showCancel: false,
        confirmText: '去核对',
        success: () => {
          try { wx.pageScrollTo({ scrollTop: 0, duration: 200 }) } catch (e) {}
        }
      })
    }
  },

  /* 批量里可能既有出（商品）又有收（需求）：下一条类型变了就原地切表单 */
  switchPasteType(rec) {
    const nextType = rec && rec.type === 'buy' ? 'buy' : 'sell'
    if (nextType === this.data.type) return
    this.setData({
      type: nextType,
      mode: nextType === 'buy' ? '求购' : '出售',
      isRent: false
    })
    this.syncModeOptions()
    this.syncTitle()
    this.resetCondFlow()
  },

  /* 批量发布：一条成功后自动载入下一条，全部完成再回入口页 */
  continueQueueAfterPublish() {
    const queue = (this.data.pasteQueue || []).slice()
    if (queue.length) {
      this.setData({
        pasteQueue: queue.slice(1),
        pasteDone: this.data.pasteDone + 1
      })
      this.switchPasteType(queue[0])
      this.applyPasteRecord(queue[0])
      wx.showToast({ title: '已载入下一条（剩 ' + (queue.length - 1) + ' 条）', icon: 'none' })
      return
    }
    if (this.data.pasteTotal > 0) {
      const total = this.data.pasteTotal
      this.setData({ pasteTotal: 0, pasteDone: 0 })
      wx.showToast({ title: '全部 ' + total + ' 条已发布', icon: 'none' })
    }
    this.backToEntry()
  },

  /* 仅发商机池开关：只进匹配池，不在首页、搜索与货架展示 */
  togglePoolOnly(e) {
    const on = e && e.detail && typeof e.detail.value === 'boolean'
      ? e.detail.value
      : !this.data.poolOnly
    this.setData({ poolOnly: on })
  },

  /* 代采 / 代售设备搜索：输入型号 / 品牌 / 系列，下面列出匹配项，点选即回填到同一个框 */
  onAgencyDeviceSearch(e) {
    const value = String((e.detail && e.detail.value) || '')
    this.setData({
      agDeviceKeyword: value,
      agDeviceResults: this.matchDevices(value).results,
      agDeviceSearchOpen: true,
      agDevicePath: '',
      'agencyForm.item': ''
    })
  },

  /* 空输入框聚焦时列出目录前 30 条，替代原来的「展开目录」入口 */
  focusAgencyDeviceSearch() {
    if (String(this.data.agDeviceKeyword || '').trim()) return
    this.setData({ agDeviceResults: this.matchDevices('').results, agDeviceSearchOpen: true })
  },

  clearAgencyDeviceSearch() {
    this.setData({
      agDeviceKeyword: '',
      agDeviceResults: [],
      agDeviceSearchOpen: false,
      agDevicePath: '',
      'agencyForm.item': ''
    })
  },

  /* 点搜索结果：反算四级下标同步目录滚轮，并回填设备型号 */
  pickAgencyDeviceSearch(e) {
    const item = (this.data.agDeviceResults || [])[Number(e.currentTarget.dataset.i)]
    if (!item) return
    const cat = DEVICE_CATS[Math.max(0, DEVICE_CATS.indexOf(item.cat))] || ''
    const brands = brandsOf(cat)
    const brand = brands[Math.max(0, brands.indexOf(item.brand))] || ''
    const seriesList = seriesOf(cat, brand)
    const series = seriesList[Math.max(0, seriesList.indexOf(item.series))] || ''
    const models = modelsOf(cat, brand, series)
    const mi = Math.max(0, models.indexOf(item.model))
    const next = deviceColumns([DEVICE_CATS.indexOf(cat), brands.indexOf(brand), seriesList.indexOf(series), mi])
    this.setData({
      agDeviceIndex: next.index,
      agDeviceCols: next.cols,
      agDeviceKeyword: item.model,
      agDeviceResults: [],
      agDeviceSearchOpen: false,
      agDevicePath: [cat, brand, series].filter(Boolean).join(' · '),
      agencyCat: cat,
      'agencyForm.item': item.model
    })
  },

  /* 需求侧：设备类型必选，品牌 / 型号选填（填了能匹配到具体库存） */
  pickCategory(e) {
    const i = Number(e.detail.value)
    const cat = DEVICE_CATS[i] || ''
    const next = deviceColumns([i, 0, 0, 0])
    this.setData({
      catIndex: i,
      deviceIndex: next.index,
      deviceCols: next.cols,
      'form.cat': cat,
      'form.brand': '',
      'form.series': '',
      'form.model': '',
      'form.devicePath': cat,
      'form.device': ''
    })
  },

  /* 需求侧品牌 / 型号：四级目录选填，选完回填品牌与型号，用于精准匹配库存 */
  pickDemandDevice(e) {
    const raw = e.detail.value || []
    const next = deviceColumns(raw.map(Number))
    const cat = next.cols[0][next.index[0]] || ''
    const brand = next.cols[1][next.index[1]] || ''
    const series = next.cols[2][next.index[2]] || ''
    const model = next.cols[3][next.index[3]] || ''
    this.setData({
      catIndex: Math.max(0, DEVICE_CATS.indexOf(cat)),
      deviceIndex: next.index,
      deviceCols: next.cols,
      'form.cat': cat,
      'form.brand': brand,
      'form.series': series,
      'form.model': model,
      'form.devicePath': cat
    })
  },

  /* 清空选填的品牌 / 型号，回到「只按设备类型匹配」 */
  clearDemandDevice() {
    const i = Math.max(0, DEVICE_CATS.indexOf(this.data.form.cat))
    const next = deviceColumns([i, 0, 0, 0])
    this.setData({
      deviceIndex: next.index,
      deviceCols: next.cols,
      'form.brand': '',
      'form.series': '',
      'form.model': ''
    })
  },

  // 需求验收方式：现场压测 / 第三方报告，可多选
  pickAccept(e) {
    const v = e.currentTarget.dataset.v
    this.setData({
      acceptOpts: this.data.acceptOpts.map((o) => (o.v === v ? { v: o.v, on: !o.on } : o))
    })
  },

  // 先选省 / 直辖市，再选市；换省后清空已选城市
  pickProvince(e) {
    const i = Number(e.detail.value)
    const province = this.data.provinces[i] || ''
    this.setData({
      'form.province': province,
      'form.city': '',
      cities: (CITY_TREE[province] || []).slice()
    })
  },

  pickCity(e) {
    const i = Number(e.detail.value)
    this.setData({ 'form.city': this.data.cities[i] || '' })
  },

  /* ---------- 平台型号库：合并进四级滚轮 ---------- */
  async refreshCatalog() {
    try {
      const res = await catalog.loadCatalog()
      if (!res || !res.tree) return
      DEVICE_TREE = res.tree
      DEVICE_CATS = res.cats
      /* 目录变了，搜索索引与粘贴识别的型号索引都必须重建 */
      this.deviceFlat = null
      PARSE_DEVICE_INDEX = null
      const next = deviceColumns(this.data.deviceIndex)
      this.setData({
        catOptions: DEVICE_CATS,
        deviceIndex: next.index,
        deviceCols: next.cols
      })
      if (this.data.deviceKeyword) this.onDeviceSearch({ detail: { value: this.data.deviceKeyword } })
    } catch (e) {
      /* 目录刷新失败沿用内置目录，不打断发布流程 */
    }
  },

  /* ---------- 编辑模式：回填与保存 ---------- */
  async loadEdit() {
    /* 编辑回填依赖完整目录：先等平台型号合并完成，避免型号定位偏差 */
    if (this.catalogReady) {
      try { await this.catalogReady } catch (e) { /* 目录拉取失败用内置目录继续 */ }
    }
    this.setData({ editLoading: true })
    wx.showLoading({ title: '加载中', mask: true })
    try {
      const doc = await request('user', 'mine.publish.detail', {
        id: this.data.editId,
        kind: this.data.editKind
      }, { silent: true })
      this.fillForm(doc || {})
    } catch (e) {
      /* 未登录已由 request 统一跳登录页，这里不再叠加弹层 */
      if (e && e.code === 'UNAUTHENTICATED') return
      /* 其余失败：回填不了就退回上一页，避免在空表单上误发成新条目 */
      wx.showModal({
        title: '无法加载',
        content: (e && e.message) || '内容加载失败，请返回后重试',
        showCancel: false,
        confirmText: '返回',
        success: () => this.backToMine()
      })
    } finally {
      wx.hideLoading()
      this.setData({ editLoading: false })
    }
  },

  fillForm(doc) {
    const isBuy = this.data.editKind === 'demand'
    const mode = doc.tradeMode || (isBuy ? '求购' : '出售')
    const isRent = mode === '出租' || mode === '租赁'
    const cat = String(doc.cat || '')
    const brand = String(doc.brand || '')
    const model = String(doc.model || '')
    const city = String(doc.city || '')
    let province = ''
    PROVINCES.forEach((p) => {
      if ((CITY_TREE[p] || []).indexOf(city) > -1) province = p
    })

    const selected = Object.assign({}, this.data.selected)
    selected.supply = doc.supply || selected.supply
    /* 税费是单选：回填时取第一个值，保持 selected.tax 为字符串 */
    if (doc.tax) selected.tax = (Array.isArray(doc.tax) ? doc.tax[0] : String(doc.tax).split(' · ')[0]) || selected.tax
    if (isRent) {
      if (Array.isArray(doc.term) && doc.term.length) selected.rentTerm = doc.term.slice()
      if (Array.isArray(doc.rentLimits) && doc.rentLimits.length) selected.rentLimits = doc.rentLimits.slice()
      selected.deposit = doc.deposit || selected.deposit
      selected.pay = doc.pay || selected.pay
      /* 服务端枚举与表单文案不同，回填时换回表单口径 */
      if (doc.closed) {
        selected.closed = (doc.closed === '接受闭口价' || doc.closed === '闭口价（不议价）')
          ? '闭口价（不议价）'
          : '开口价（可议价）'
      }
      if (doc.deliver) selected.deliver = doc.deliver === '当日可起租' ? '当日可提' : doc.deliver
    } else {
      if (doc.deliver) selected.deliver = doc.deliver
    }
    /* 成色：服务端只存「全新 / 二手」，几成新单独回填 */
    const condRaw = String(doc.cond || '')
    const condType = (condRaw && condRaw !== '全新') ? 'used' : 'new'
    const condLevel = String(doc.condLevel || '9成新')

    /* 买卖两侧都按已保存的「品类 / 品牌 / 型号」反查四级滚轮下标：
       否则编辑需求时滚轮停在默认型号，点一次「确定」就会把原型号覆盖掉 */
    const next = DEVICE_CATS.indexOf(cat) < 0 ? null : deviceIndexOf(cat, brand, model)
    const seriesName = next ? (next.cols[2][next.index[2]] || '') : ''

    /* 媒体只回填元信息：编辑页不再持有原文件路径，保存时按名称 / 类型 / 大小原样上送。
       必须同时保留 fileId：编辑保存会把整个列表重新提交，丢了 fileId 原件就变成不可预览的占位。 */
    const media = Array.isArray(doc.media) ? doc.media : []
    let seq = 0
    const toItem = (m, kind) => {
      seq++
      return {
        key: 'e' + seq,
        name: String(m.name || (kind === 'image' ? '图片' : '视频')),
        path: '',
        size: Number(m.size) || 0,
        sizeText: fmtSize(m.size),
        type: m.type || (kind === 'image' ? 'image/jpeg' : 'video/mp4'),
        fileId: String(m.fileId || ''),
        kind
      }
    }
    const imgList = media.filter((m) => m && m.kind === 'image').map((m) => toItem(m, 'image'))
    const videoList = media.filter((m) => m && m.kind !== 'image').map((m) => toItem(m, 'video'))

    const side = sideOf(this.data.type, isRent)
    const presets = M.COND_PRESETS
    const mustList = presets[side] || []
    const negoList = (isRent ? presets.negoRent : presets.nego) || []
    const bodyFlow = Array.isArray(doc.flow) ? doc.flow : []
    const flow = bodyFlow.length
      ? bodyFlow.map((s, i) => {
        const parts = String(s).split('｜')
        return { id: 's' + (i + 1), n: parts[0] || '', d: parts[1] || '' }
      })
      : this.data.flow

    this.setData({
      mode,
      isRent,
      condType,
      condLevel,
      editStatus: doc.status || '',
      /* 发布方式：仅发商机池为 channel=pool，其余为公开并同时进池 */
      poolOnly: doc.channel === 'pool',
      selected,
      groups: this.buildGroups(selected),
      mustOpts: mergeOptions(mustList, doc.must),
      negoOpts: mergeOptions(negoList, doc.nego),
      acceptOpts: ACCEPT_OPTIONS.map((v) => ({ v, on: String(doc.accept || '').indexOf(v) > -1 })),
      mustInput: '',
      negoInput: '',
      flow,
      stepSeq: flow.length,
      /* 已保存过条件 / 流程时自动展开，避免用户以为丢了 */
      moreOpen: !!((doc.must || []).length || (doc.nego || []).length || flow.length),
      imgList,
      videoList,
      mediaSeq: seq,
      cities: province ? (CITY_TREE[province] || []).slice() : [],
      deviceCols: next ? next.cols : this.data.deviceCols,
      deviceIndex: next ? next.index : this.data.deviceIndex,
      /* 编辑回填时把已选型号显示在同一个搜索框里 */
      deviceKeyword: model || '',
      deviceResults: [],
      deviceSearchOpen: false,
      catIndex: Math.max(0, DEVICE_CATS.indexOf(cat)),
      condSide: side,
      mustTitle: SIDE_TITLE[side].must,
      negoTitle: SIDE_TITLE[side].nego,
      flowTitle: SIDE_TITLE[side].flow,
      form: {
        title: String(doc.title || ''),
        qty: doc.qty ? String(doc.qty) : '',
        minQty: doc.minQty ? String(doc.minQty) : '',
        price: String((isBuy ? doc.budget : doc.price) || ''),
        priceMode: String((isBuy ? doc.budgetMode : doc.priceMode) || 'fixed'),
        priceMax: String((isBuy ? doc.budgetMax : doc.priceMax) || ''),
        accept: String(doc.accept || ''),
        limit: String(doc.limit || ''),
        note: String(doc.note || ''),
        cat,
        brand,
        series: seriesName,
        /* 编辑回填必须同时写 model 与 device：保存校验与页面展示分别读这两个字段，
           之前商品只回填 device、需求只回填 model，导致二次编辑被「请选择设备型号」拦住 */
        model,
        device: model,
        devicePath: [cat, brand, seriesName].filter(Boolean).join(' · '),
        province,
        city
      }
    })
    this.checkRent()
    this.syncModeOptions()
    this.syncTitle()
  },

  backToMine() {
    /* 保存 / 发布成功后退出：先解除返回询问，避免自己弹自己 */
    this._leaveGuard = false
    /* 新增内容后下次识别要重新拉取已发布列表，避免把刚发的又当重复排除 */
    PUBLISHED_KEYS = null
    if (wx.disableAlertBeforeUnload) {
      try { wx.disableAlertBeforeUnload() } catch (e) {}
    }
    /* 发布 / 编辑成功：标记「我的」本地快照失效，避免 60 秒内显示旧列表 */
    try {
      const app = getApp()
      if (app && app.globalData) app.globalData.mineDirty = true
    } catch (e) {}
    const pages = getCurrentPages() || []
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/mine/mine' })
  },

  /* ---------- 媒体（选填）：图片 5 张 / 视频 3 段，单文件大小受限 ---------- */
  /* 把本次选择结果并入列表：超限的文件跳过并提示，避免一次性占满存储。
     选中即上传到平台存储，管理端审核时可直接看到原件，不再只有文件名。 */
  async addMedia(kind, files) {
    const listKey = kind === 'image' ? 'imgList' : 'videoList'
    const list = this.data[listKey].slice()
    const limit = MEDIA_LIMIT[kind]
    const maxBytes = MEDIA_MAX_BYTES[kind]
    let seq = this.data.mediaSeq
    let oversize = 0
    let overflow = 0
    const pending = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i] || {}
      const size = Number(f.size) || 0
      if (size > maxBytes) {
        oversize++
        continue
      }
      if (list.length + pending.length >= limit) {
        overflow++
        continue
      }
      seq++
      const fallbackName = kind === 'image'
        ? (this.data.type === 'buy' ? '资质材料 ' + seq : '设备实拍图 ' + seq)
        : (this.data.type === 'buy' ? '验资视频 ' + seq : '设备实拍视频 ' + seq)
      const meta = mediaMeta(kind, f)
      pending.push({
        key: 'm' + seq,
        seq,
        name: fallbackName,
        path: f.tempFilePath || '',
        size,
        sizeText: fmtSize(size),
        type: meta.type,
        ext: meta.ext,
        kind
      })
    }
    if (pending.length) {
      wx.showLoading({ title: '上传中', mask: true })
      try {
        for (let i = 0; i < pending.length; i++) {
          const it = pending[i]
          if (!it.path) continue
          it.fileId = await uploadFile(it.path, {
            cloudPath: 'publish/' + kind + '/' + Date.now() + '-' + it.seq + '.' + (it.ext || 'jpg')
          })
        }
      } catch (err) {
        wx.hideLoading()
        wx.showToast({ title: (err && err.message) || '上传失败，请重试', icon: 'none' })
        return
      }
      wx.hideLoading()
    }
    const accepted = pending.filter((it) => it.fileId)
    this.setData({ [listKey]: list.concat(accepted), mediaSeq: seq })
    this.syncLeaveGuard()
    if (oversize) {
      wx.showToast({ title: '已跳过 ' + oversize + ' 个' + (kind === 'image' ? '图片' : '视频') + '（' + MEDIA_SIZE_TEXT[kind] + '）', icon: 'none' })
    } else if (overflow) {
      wx.showToast({ title: '最多 ' + limit + (kind === 'image' ? ' 张图片' : ' 段视频'), icon: 'none' })
    } else if (accepted.length) {
      wx.showToast({ title: '已添加 ' + accepted.length + (kind === 'image' ? ' 张' : ' 段'), icon: 'none' })
    }
  },

  uploadImage() {
    const remain = MEDIA_LIMIT.image - this.data.imgList.length
    if (remain <= 0) {
      wx.showToast({ title: '最多上传 5 张图片', icon: 'none' })
      return
    }
    const pick = (res) => {
      /* chooseMedia 返回 tempFiles（含 size），chooseImage 只保证 tempFilePaths */
      const files = (res && res.tempFiles) || ((res && res.tempFilePaths) || []).map((p) => ({ tempFilePath: p }))
      if (files.length) this.addMedia('image', files)
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: remain, mediaType: ['image'], success: pick })
    } else {
      wx.chooseImage({ count: remain, success: pick })
    }
  },

  uploadVideo() {
    const remain = MEDIA_LIMIT.video - this.data.videoList.length
    if (remain <= 0) {
      wx.showToast({ title: '最多上传 3 段视频', icon: 'none' })
      return
    }
    const pick = (res) => {
      const files = (res && res.tempFiles) ||
        ((res && res.tempFilePath) ? [{ tempFilePath: res.tempFilePath, size: res.size }] : [])
      if (files.length) this.addMedia('video', files)
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: remain, mediaType: ['video'], success: pick })
    } else {
      wx.chooseVideo({ maxDuration: 60, success: pick })
    }
  },

  // 自定义命名：文件叫什么由发布方决定，方便交易对象快速识别
  renameMedia(e) {
    const kind = e.currentTarget.dataset.kind
    const i = Number(e.currentTarget.dataset.i)
    const listKey = kind === 'image' ? 'imgList' : 'videoList'
    const cur = this.data[listKey][i]
    if (!cur) return
    wx.showModal({
      title: '给文件命名',
      editable: true,
      placeholderText: kind === 'image' ? '如：营业执照 / 整机正面实拍' : '如：验资视频 / 开机铭牌实拍',
      content: cur.name,
      success: (res) => {
        if (!res.confirm) return
        const name = String(res.content || '').trim().slice(0, MEDIA_MAX_NAME_LEN)
        if (!name) {
          wx.showToast({ title: '名称不能为空', icon: 'none' })
          return
        }
        const list = this.data[listKey].slice()
        list[i] = Object.assign({}, list[i], { name })
        this.setData({ [listKey]: list })
      }
    })
  },

  removeMedia(e) {
    const kind = e.currentTarget.dataset.kind
    const i = Number(e.currentTarget.dataset.i)
    const listKey = kind === 'image' ? 'imgList' : 'videoList'
    const list = this.data[listKey].slice()
    list.splice(i, 1)
    this.setData({ [listKey]: list })
    this.syncLeaveGuard()
  },

  /* ---------- 提交 ---------- */
  // 把表单字段翻译成云函数契约（buildProduct / buildDemand 的字段名与枚举）
  buildPayload(opts) {
    const f = this.data.form
    const num = (v) => Number(String(v).replace(/,/g, '').trim())
    const isBuy = this.data.type === 'buy'
    const sel = this.data.selected || {}
    const path = String(f.devicePath || '').split(' · ')
    const cat = String(f.cat || path[0] || '').trim()
    const brand = String(f.brand || path[1] || '').trim()
    const series = String(f.series || path[2] || '').trim()
    const model = String(f.model || f.device || series || '').trim()
    const rental = this.data.isRent
    const tradeMode = isBuy ? (rental ? '租赁' : '求购') : (rental ? '出租' : '出售')
    /* 出租与租赁的「可交付时间」枚举不同：出租方用「当日可起租」 */
    const deliver = rental
      ? (sel.deliver === '当日可提' ? '当日可起租' : (sel.deliver || '当日可起租'))
      : (sel.deliver || '3 天内')
    /* 租赁需求对「闭口价」的口径是接受度，需要换成需求侧枚举 */
    const closed = rental && isBuy
      ? (sel.closed === '闭口价（不议价）' ? '接受闭口价' : '只接受可议价')
      : sel.closed

    /* 发布方式只看用户开关：普通发布内容公开并自动进入商机匹配；仅发商机池只进匹配不公开 */
    /* 仅发商机池：channel=pool 只出现在他人匹配里，首页 / 搜索 / 货架均不展示 */
    const poolOnly = this.data.poolOnly === true
    const payload = {
      tradeMode,
      visibility: 'public',
      channel: poolOnly ? 'pool' : 'both',
      currency: this.data.currency || 'CNY',
      title: String(f.title || '').trim(),
      cat,
      brand,
      series,
      model,
      qty: num(f.qty),
      supply: sel.supply || '现货',
      /* 税费是单选（selected.tax 为字符串），服务端契约要数组；这里统一数组化，
         否则 '含税'.slice() 仍是字符串，服务端会报「税费格式不正确」 */
      tax: Array.isArray(sel.tax) ? sel.tax.slice() : (sel.tax ? [String(sel.tax)] : []),
      deliver,
      must: (this.data.mustOpts || []).filter((o) => o.on).map((o) => o.v),
      nego: (this.data.negoOpts || []).filter((o) => o.on).map((o) => o.v),
      flow: (this.data.flow || [])
        .filter((s) => String(s.n || '').trim())
        .map((s) => {
          const name = String(s.n).trim()
          const desc = String(s.d || '').trim()
          return (desc ? name + '｜' + desc : name).slice(0, 120)
        }),
      /* 媒体元信息 + 上传得到的 fileId：管理端据此直接展示原件。
         编辑时同样整份提交（列表已回填原件的 fileId）：服务端按此保留未删的原件、
         并接收本次新上传的图片 / 视频。之前编辑时直接删掉 media，新素材永远存不进管理端。 */
      media: this.data.imgList.concat(this.data.videoList).map((m) => ({
        name: m.name,
        type: m.type,
        size: m.size,
        kind: m.kind,
        fileId: m.fileId || ''
      }))
    }
    /* 商品展示信息：验收标准 / 可承接数量 / 交易说明，均由发布者填写 */
    if (!isBuy) {
      payload.accept = String(f.accept || '').trim()
      /* 每批上限单独一个输入框，服务端没有对应字段：并进「可承接数量」展示 */
      const maxQty = String(f.maxQty || '').trim()
      const limitText = String(f.limit || '').trim()
      payload.limit = maxQty
        ? ('每批最多 ' + maxQty + ' 台' + (limitText ? '；' + limitText : ''))
        : limitText
      payload.note = String(f.note || '').trim()
    } else {
      /* 需求验收方式：现场压测 / 第三方报告 */
      payload.accept = (this.data.acceptOpts || [])
        .filter((o) => o.on)
        .map((o) => o.v)
        .join(' + ')
    }
    if (opts && opts.draft) payload.draft = true
    /* 同一草稿反复保存要覆盖同一条，带上 id */
    if (this.data.draftId) payload.id = this.data.draftId
    /* 价格方式：固定 / 区间 / 现场沟通；面议不落金额 */
    const priceMode = f.priceMode || 'fixed'
    const priceMax = priceMode === 'range' ? num(f.priceMax) : 0
    if (isBuy) {
      payload.budgetMode = priceMode
      payload.budgetMax = priceMax
    } else {
      payload.priceMode = priceMode
      payload.priceMax = priceMax
    }
    if (rental) {
      /* 出租用月租金，租赁需求用月租金预算；服务端字段都叫 rent */
      payload.rent = priceMode === 'nego' ? 0 : num(f.price)
      payload.term = (sel.rentTerm || []).slice()
      payload.closed = closed
      payload.deposit = sel.deposit
      payload.pay = sel.pay
      payload.rentLimits = (sel.rentLimits || []).slice()
    } else {
      if (isBuy) payload.budget = priceMode === 'nego' ? 0 : num(f.price)
      else payload.price = priceMode === 'nego' ? 0 : num(f.price)
      /* 成色：全新 / 二手，二手再带几成新；商机按「新二手」匹配 */
      payload.cond = this.data.condType === 'used' ? '二手' : '全新'
      payload.condLevel = this.data.condType === 'used' ? this.data.condLevel : ''
      payload.city = String(f.city || '').trim()
      if (!isBuy) payload.minQty = num(f.minQty)
    }
    /* 出售商品可同步一条私库存用于商机匹配；草稿与租赁不写库存 */
    if (!isBuy && !rental && !(opts && opts.draft) && this.data.syncStock) {
      payload.syncStock = true
    }
    return payload
  },

  /* 存草稿：只要求标题，其余字段可空；存完在「我的 · 我发布的」里补齐再提交 */
  async saveDraft() {
    if (this.submitting) return
    /* 编辑模式不产生新草稿：保存修改走 update，状态保持不变 */
    if (this.data.editing) return
    const f = this.data.form
    if (!String(f.title || '').trim()) {
      wx.showToast({ title: '请先填写标题', icon: 'none' })
      return
    }
    const isBuy = this.data.type === 'buy'
    const payload = this.buildPayload({ draft: true })
    this.submitting = true
    try {
      const res = await request('user', isBuy ? 'demand.publish' : 'product.publish', payload)
      this.setData({ draftId: (res && res.id) || this.data.draftId })
    } catch (e) {
      /* request 已按错误码提示，留在当前页让用户修改 */
      return
    } finally {
      this.submitting = false
    }
    wx.showModal({
      title: '已存草稿',
      content: '草稿不会对外展示，可在「我的 · 我发布的」里补齐信息后重新提交。',
      showCancel: false,
      confirmText: '知道了',
      success: () => {
        /* 我的发布列表有 60 秒本地快照：不标脏会命中缓存，看起来像「草稿没存上」 */
        try {
          const app = getApp()
          if (app && app.globalData) {
            app.globalData.mineDirty = true
            /* 落地「我的 · 我发布的」对应子类，不用用户自己找 */
            app.globalData.minePub = isBuy ? 'demand' : 'product'
          }
        } catch (e) {}
        /* 存草稿后回到「发布类型选择」，由用户决定继续发布或退出 */
        this.backToEntry()
      }
    })
  },

  /* 提交发布：整段流程先加锁，避免连点或授权弹窗期间落下两条记录 */
  async submit() {
    if (this.submitting) return
    this.submitting = true
    try {
      await this.submitNow()
    } catch (e) {
      /* 未预期的异常不能让按钮永久锁死 */
    } finally {
      this.submitting = false
    }
  },

  async submitNow() {
    const f = this.data.form
    const num = (v) => Number(String(v).replace(/,/g, '').trim())
    const err = (t) => wx.showToast({ title: t, icon: 'none' })
    const isBuy = this.data.type === 'buy'
    const qtyWord = isBuy ? '需求' : (this.data.isRent ? '可租' : '可售')
    const priceWord = isBuy
      ? (this.data.isRent ? '月租金预算' : '预算单价')
      : (this.data.isRent ? '月租金' : '出售单价')
    const priceMode = f.priceMode || 'fixed'

    if (!String(f.title || '').trim()) return err('请填写标题')
    if (String(f.title).trim().length < 4) return err('标题至少 4 个字')
    /* 设备必须选到平台预设型号库里的型号，否则无法参与商机匹配；
       编辑回填时 model / device 只有一个有值，两者取其一即可，避免老数据被误拦。 */
    const deviceModel = String(f.model || f.device || '').trim()
    if (!deviceModel) return err('请选择设备型号')
    if (!(num(f.qty) > 0)) return err('请填写' + qtyWord + '数量')
    /* 起订量只属于供给方（发布商品）；需求方只表达明确需求量，不校验起订量 */
    if (!isBuy) {
      if (!(num(f.minQty) > 0)) return err(this.data.isRent ? '请填写起租数量' : '请填写起订量')
      if (num(f.minQty) > num(f.qty)) return err(this.data.isRent ? '起租数量不能大于可租数量' : '起订量不能大于可售数量')
    }
    /* 价格方式：现场沟通不填金额；价格区间需给出高于最低价的最高价 */
    if (priceMode !== 'nego') {
      if (!(num(f.price) > 0)) return err('请填写' + priceWord)
      if (priceMode === 'range') {
        if (!(num(f.priceMax) > 0)) return err('请填写最高价')
        if (!(num(f.priceMax) > num(f.price))) return err('最高价需高于最低价')
      }
    }
    if (!this.data.isRent && !f.city) return err(isBuy ? '请选择交付城市' : '请选择交易地/发货地')
    if (this.data.isRent && !(this.data.selected.rentTerm || []).length) return err('请选择租期')
    /* 现货/期货、税费、成色、交付时间：原文没写就留空，必须由用户自己确认 */
    const sel = this.data.selected || {}
    if (!sel.supply) return err('请选择' + (isBuy ? '期望供给' : (this.data.isRent ? '供给状态' : '供给类型')))
    if (!sel.tax) return err('请选择税费')
    if (!this.data.isRent && !this.data.condType) return err(isBuy ? '请选择成色要求' : '请选择成色')
    if (!sel.deliver) return err(isBuy ? '请选择期望交付时间' : (this.data.isRent ? '请选择可起租时间' : '请选择交付时间'))
    /* 联系方式统一使用「我的信息」中已绑定的手机号，发布页不再填写 */
    const must = this.data.mustOpts.filter((o) => o.on).map((o) => o.v)
    const nego = this.data.negoOpts.filter((o) => o.on).map((o) => o.v)
    const flow = this.data.flow.filter((s) => String(s.n || '').trim())
    if (flow.some((s) => !String(s.n || '').trim())) return err('交易流程步骤名称不能为空')

    /* 发布 / 编辑前先确认资料齐全：缺主体信息或联系方式时弹窗引导补齐 */
    if (!(await ensureProfileReady())) return

    /* 编辑：原地更新内容，状态不变（在售仍上架、草稿仍是草稿），也不申请发布订阅 */
    if (this.data.editing) {
      const payload = this.buildPayload()
      payload.id = this.data.editId
      try {
        await request('user', this.data.editKind === 'demand' ? 'demand.update' : 'product.update', payload)
      } catch (e) {
        return
      }
      wx.showModal({
        title: '已保存',
        content: '修改已生效，当前状态保持不变。可在「我的 · 我发布的」中继续管理。',
        showCancel: false,
        confirmText: '知道了',
        success: () => this.backToMine()
      })
      return
    }

    /* 发布后（求购被响应 / 商品被咨询）通过微信服务通知提醒发布方。
       订阅消息必须由点击触发，这里借「提交」这一次点击申请授权；未授权不影响发布。
       先等授权弹窗关闭再弹审核提示，避免两个弹层抢焦点；
       模板未配置或环境不支持时不会弹框，直接继续。 */
    if (notify.configured() && notify.supported()) await notify.requestSubscribe()

    /* 真正落库：商品进 products、需求进 demands，
       管理端 product.list / demand.list 读到的就是这份真实数据 */
    const payload = this.buildPayload()
    let published = null
    try {
      published = await request('user', isBuy ? 'demand.publish' : 'product.publish', payload)
    } catch (e) {
      /* request 已按错误码提示（未实名 / 校验失败 / 限流），留在当前页让用户修改 */
      return
    }

    // 自动过审：发布即上架，不再有「平台审核中」的等待环节
    const typeLabel = isBuy
      ? (this.data.isRent ? '租赁需求' : '求购需求')
      : (this.data.isRent ? '出租设备' : '出售商品')
    /* 条件与流程都是选填，没填就不提，避免低价值商品发布时堆一串 0 */
    const extra = []
    if (must.length) extra.push('必须条件 ' + must.length + ' 条')
    if (nego.length) extra.push('可协商条件 ' + nego.length + ' 条')
    if (flow.length) extra.push('交易流程 ' + flow.length + ' 步')
    const extraText = extra.length ? '（' + extra.join(' / ') + '）' : ''
    /* 发布回执：让用户立刻看到「上传一次就够了」——刚发布就能匹配到多少条对方内容。
       保密发布不进商机池、编辑旧内容不算新发布，都不显示这句 */
    const matchCount = published && typeof published.matchCount === 'number' ? published.matchCount : 0
    const matchNoun = isBuy ? '货源' : '求购'
    const privatePublish = published && published.visibility === 'private'
    const receipt = (!this.data.editing && !privatePublish)
      ? (matchCount > 0
        ? '已进入商机池。目前有 ' + matchCount + ' 条' + matchNoun + '与它匹配。\n有新的匹配' + matchNoun + '，会直接提醒你，不用天天盯群。\n\n'
        : '已进入商机池。未来有新' + matchNoun + '匹配，会第一时间提醒你，不用天天盯群。\n\n')
      : ''
    /* 两种发布方式：普通发布公开并进匹配；仅发商机池只进匹配不公开 */
    const poolPublish = this.data.poolOnly === true
    const successText = poolPublish
      ? '你的' + typeLabel + '已发布到商机池' + extraText + '。\n\n内容只进入商机匹配，不会出现在首页、搜索、货架与需求列表中：只有匹配到你的会员才能在「商机」里看到，并可直接与你对话。可在「我的 · 我发布的」中查看与管理（会标注「仅商机池」）。材料已加密存储，仅平台内可见，查看时叠加账号与昵称水印。'
      : '你的' + typeLabel + '已发布并上架到「' + (isBuy ? '求购需求' : '在售货源') + '」' + extraText + '。\n\n内容公开，并已自动进入商机匹配；有用户满足必须条件即可与你直接对话，并会通过站内消息通知你。可在「我的 · 我发布的」中查看与管理。材料已加密存储，仅平台内可见，查看时叠加账号与昵称水印。\n\n平台不审核交易流程，只做信息撮合，发现违规内容时按规则处置。'
    wx.showModal({
      title: '发布成功',
      content: receipt + successText +
        (published && published.stockSynced ? '\n\n已同步到「我的库存」：平台新发布的求购需求会与这条货源匹配，匹配结果在「商机」中查看。' : ''),
      showCancel: false,
      confirmText: '知道了',
      success: () => {
        /* 「我的」列表有 60 秒快照：标脏后返回即可看到新发布的内容 */
        try {
          const app = getApp()
          if (app && app.globalData) {
            app.globalData.mineDirty = true
            app.globalData.minePub = isBuy ? 'demand' : 'product'
          }
        } catch (e) {}
        /* 发布成功后回到「发布类型选择」，不留在表单、也不跳回首页；
           粘贴批量发布时先载入下一条待发布记录 */
        this.continueQueueAfterPublish()
      }
    })
  },

  /* 是否把这条出售商品同步进私库存（仅用于商机匹配） */
  toggleSyncStock(e) {
    const on = e && e.detail && typeof e.detail.value === 'boolean'
      ? e.detail.value
      : !this.data.syncStock
    this.setData({ syncStock: on })
  },

  reset() {
    this.setData({
      condType: 'new',
      condLevel: '9成新',
      moreOpen: false,
      form: { title: '', qty: '', minQty: '', maxQty: '', price: '', priceMax: '', priceMode: 'fixed', accept: '', limit: '', note: '', cat: '', brand: '', series: '', model: '', device: '', devicePath: '', province: '', city: '' },
      cities: [],
      deviceIndex: [0, 0, 0, 0],
      deviceCols: deviceColumns([0, 0, 0, 0]).cols,
      deviceKeyword: '',
      deviceResults: [],
      deviceSearchOpen: false,
      acceptOpts: ACCEPT_OPTIONS.map((v) => ({ v, on: false })),
      syncStock: true,
      poolOnly: false,
      imgList: [],
      videoList: [],
      mediaSeq: 0,
      draftId: '',
      /* 粘贴识别与批量队列一并清空，避免下次进入残留 */
      pasteOpen: false,
      pasteText: '',
      pasteRecords: [],
      pasteQueue: [],
      pasteTotal: 0,
      pasteDone: 0,
      /* 清空后回到「点加号之后」的入口卡片：从哪进来就停在哪，不再跳首页 / 我的 */
      type: '',
      mode: '',
      agencyType: ''
    })
    this.initSelected()
    this.checkRent()
    this.syncModeOptions()
    this.syncTitle()
    this.resetCondFlow()
    /* 内容已清空 / 已保存：关闭返回询问 */
    this._leaveGuard = false
    if (wx.disableAlertBeforeUnload) {
      try { wx.disableAlertBeforeUnload() } catch (e) {}
    }
  },

  /* ---------- 代采 / 代售委托 ---------- */
  openAgency(e) {
    const t = e.currentTarget.dataset.type === 'sell' ? 'sell' : 'buy'
    wx.navigateTo({ url: '/pages/publish/publish?entry=1&agency=' + t })
  },

  enterAgency(t, target) {
    this.setData({
      type: '',
      agencyType: t,
      agencyResubmitId: '',
      /* 交易方式必须与服务端 TRADE_MODES 枚举一致：代采为「求购 / 租赁」，代售为「出售 / 出租」 */
      agencyMode: t === 'buy' ? '求购' : '出售',
      agencyModeOptions: t === 'buy' ? ['求购', '租赁'] : ['出售', '出租'],
      agencyRent: false,
      agencyDeadline: dateStr(30),
      agencyDeadlineMin: dateStr(1),
      agencyDeadlineMax: dateStr(365),
      agencySubjectType: 'company',
      agencyForm: { item: target || '', qty: '', price: '', subject: '', creditCode: '', legal: '', idCard: '', phone: '' },
      agencyTerm: '6 个月',
      agencyAgree: false,
      /* 代采 / 代售直接对接平台：不公开展示、不进商机池；设备只能从平台预设型号库选择 */
      agDeviceCols: deviceColumns([0, 0, 0, 0]).cols,
      agDeviceIndex: [0, 0, 0, 0],
      agDevicePath: '',
      agDeviceKeyword: '',
      agDeviceResults: [],
      agencyCat: '',
      agLicense: null,
      agProof: null,
      agLoi: null,
      agAuthorization: null,
      agIdcard: null,
      agOther: [],
      feeAmountText: '—',
      feeText: '0',
      feeLarge: false,
        feeDeferred: false,
      feeRule: '填写金额后自动试算',
      agencySubmitText: '填写金额后试算',
      agencySubmitTip: t === 'buy'
        ? '发布、审核、上架都不收费，成交后支付服务费；审核通过后直接在平台内发布，有人咨询时由客服对接。'
        : '发布、审核、上架都不收费，成交后支付服务费；审核通过后开始代寻、撮合。',
      feeNote: t === 'buy'
        ? '代采委托直接对接平台，资料仅平台可见；审核通过后直接在平台内发布，有人咨询时客服对接确认交易条件，成交后支付服务费。'
        : '代售委托直接对接平台，资料仅平台可见；审核通过后开始代寻、撮合，成交后支付服务费。'
    })
    this.setData({ navTitle: t === 'buy' ? '发起代采' : '发起代售' })
    this.resetAgencyCondFlow()
  },

  /* 被驳回委托的重新编辑：拉本人委托详情回填，材料沿用已上传文件，可逐项重传 */
  async loadAgencyResubmit(id) {
    if (!id) return
    wx.showLoading({ title: '加载中', mask: true })
    try {
      const d = await request('user', 'agency.detail', { id }, { silent: false })
      if (!d) return
      const side = d.side === 'sell' ? 'sell' : 'buy'
      const rental = d.rental === true
      const media = Array.isArray(d.media) ? d.media : []
      const fileOf = (kind) => {
        const hit = media.filter((m) => m && m.kind === kind)[0]
        if (!hit) return null
        return {
          key: 'ag-' + kind,
          name: hit.name || '',
          path: '',
          fileId: hit.fileId || '',
          size: 0,
          sizeText: '已上传',
          type: 'image/jpeg'
        }
      }
      const others = media.filter((m) => m && m.kind === 'other').map((m, i) => ({
        key: 'ag-other-' + i,
        name: m.name || '补充材料',
        path: '',
        fileId: m.fileId || '',
        size: 0,
        sizeText: '已上传',
        type: 'image/jpeg'
      }))
      const item = String(d.item || '')
      /* 型号库里反查品牌 / 系列；目录外的历史型号只展示品类，输入框仍显示原型号 */
      let agDeviceCols = deviceColumns([0, 0, 0, 0]).cols
      let agDeviceIndex = [0, 0, 0, 0]
      let agDevicePath = String(d.cat || '')
      const hit = item ? this.deviceSearchIndex().filter((r) => r.model === item)[0] : null
      if (hit) {
        const next = deviceIndexOf(hit.cat, hit.brand, hit.model)
        agDeviceCols = next.cols
        agDeviceIndex = next.index
        agDevicePath = [next.cols[0][next.index[0]], next.cols[1][next.index[1]], next.cols[2][next.index[2]]]
          .filter(Boolean)
          .join(' · ')
      }
      const currency = d.currency || 'CNY'
      const currencyList = this.data.currencyOptions || []
      this.setData({
        agencyResubmitId: id,
        agencyType: side,
        agencyMode: d.mode || (side === 'buy' ? '求购' : '出售'),
        agencyModeOptions: side === 'buy' ? ['求购', '租赁'] : ['出售', '出租'],
        agencyRent: rental,
        agencyTerm: d.term || '6 个月',
        /* 回填原截止时间；已过期时留空，要求重新选择 */
        agencyDeadline: /^\d{4}-\d{2}-\d{2}$/.test(String(d.deadline || '')) && d.deadline >= dateStr(1) ? d.deadline : '',
        agencyDeadlineMin: dateStr(1),
        agencyDeadlineMax: dateStr(365),
        agencySubjectType: d.subjectType === 'person' ? 'person' : 'company',
        agencyForm: {
          item,
          qty: Number(d.qty) ? String(d.qty) : '',
          price: Number(d.price) ? String(d.price) : '',
          subject: d.subject || '',
          creditCode: d.creditCode || '',
          legal: d.legal || '',
          idCard: d.idCard || '',
          phone: d.phone || ''
        },
        currency,
        currencyIndex: Math.max(0, currencyList.findIndex((c) => c.code === currency)),
        agencyCat: d.cat || '',
        agDeviceKeyword: item,
        agDeviceResults: [],
        agDeviceSearchOpen: false,
        agDevicePath,
        agDeviceCols,
        agDeviceIndex,
        agLicense: fileOf('license'),
        agProof: fileOf('proof'),
        agLoi: fileOf('loi'),
        agAuthorization: fileOf('authorization'),
        agIdcard: fileOf('idcard'),
        agOther: others,
        navTitle: side === 'buy' ? '重新提交代采' : '重新提交代售'
      })
      /* 条件与流程：预设项合并原选择，自定义项原样保留 */
      const condSide = sideOf(side, rental)
      const presets = M.COND_PRESETS
      const flow = (Array.isArray(d.flow) ? d.flow : []).map((text, i) => {
        const s = String(text || '')
        const k = s.indexOf('：')
        return {
          id: 'as' + (i + 1),
          n: k > -1 ? s.slice(0, k) : s,
          d: k > -1 ? s.slice(k + 1) : ''
        }
      })
      this.setData({
        agencyCondSide: condSide,
        agencyMustTitle: SIDE_TITLE[condSide].must,
        agencyNegoTitle: SIDE_TITLE[condSide].nego,
        agencyFlowTitle: '交易流程',
        agencyMustOpts: mergeOptions(presets[condSide] || [], d.must || []),
        agencyNegoOpts: mergeOptions((rental ? presets.negoRent : presets.nego) || [], d.nego || []),
        agencyFlow: flow,
        agencyStepSeq: flow.length
      })
      this.calcFee()
    } catch (err) {
      /* request 已按错误码提示（委托不存在 / 非本人 / 状态已变化） */
    } finally {
      wx.hideLoading()
    }
  },

  pickCurrency(e) {
    const idx = Number(e.detail.value) || 0
    const opts = this.data.currencyOptions || []
    const c = opts[Math.min(idx, opts.length - 1)] || opts[0]
    this.setData({ currency: c.code, currencyIndex: idx })
  },

  /* 截止时间（必填）：最早明天 */
  pickAgencyDeadline(e) {
    this.setData({ agencyDeadline: e.detail.value || '' })
  },

  pickAgencySubject(e) {
    const v = e.currentTarget.dataset.v === 'person' ? 'person' : 'company'
    this.setData({ agencySubjectType: v })
  },

  closeAgency() {
    /* 从入口页压入的委托表单：退回下面的入口页 */
    if (this.data.fromEntry) return this.backToEntry()
    this.setData({ agencyType: '', agencyResubmitId: '', agencyRent: false, agencyAgree: false, agencyDeadline: '' })
    this.syncTitle()
  },

  /* 提交委托后直达「我的订单 - 代采代售」，让用户立即看到进度时间线 */
  goMineAgency() {
    this.setData({ agencyType: '', agencyResubmitId: '', agencyRent: false, agencyAgree: false })
    try {
      const app = getApp()
      if (app && app.globalData) {
        app.globalData.mineView = 'agency'
        app.globalData.mineDirty = true
      }
    } catch (e) {}
    wx.switchTab({ url: '/pages/mine/mine' })
  },

  pickAgencyMode(e) {
    const v = String(e.currentTarget.dataset.v || '')
    if (!v) return
    const agencyRent = v === '租赁' || v === '出租'
    this.setData({ agencyMode: v, agencyRent })
    /* 买卖与租赁的侧别不同，条件预设与流程文案要跟着换 */
    this.resetAgencyCondFlow()
    this.calcFee()
  },

  /* 代采 / 代售的条件与流程：侧别由委托类型 + 买卖 / 租赁决定 */
  resetAgencyCondFlow() {
    const side = sideOf(this.data.agencyType, this.data.agencyRent)
    const t = SIDE_TITLE[side]
    const presets = M.COND_PRESETS
    this.setData({
      agencyCondSide: side,
      agencyMustTitle: t.must,
      agencyNegoTitle: t.nego,
      agencyFlowTitle: '交易流程',
      agencyMustOpts: (presets[side] || []).map((v) => ({ v, on: false })),
      agencyNegoOpts: ((this.data.agencyRent ? presets.negoRent : presets.nego) || []).map((v) => ({ v, on: false })),
      agencyFlow: [],
      agencyStepSeq: 0,
      agencyMustInput: '',
      agencyNegoInput: '',
      agencyStepName: '',
      agencyStepDesc: ''
    })
  },

  pickAgencyCond(e) {
    const kind = e.currentTarget.dataset.kind
    const val = e.currentTarget.dataset.v
    const key = kind === 'must' ? 'agencyMustOpts' : 'agencyNegoOpts'
    const opts = this.data[key].map((o) => (o.v === val ? Object.assign({}, o, { on: !o.on }) : o))
    this.setData({ [key]: opts })
  },

  onAgencyCondInput(e) {
    const kind = e.currentTarget.dataset.kind
    this.setData(kind === 'must' ? { agencyMustInput: e.detail.value } : { agencyNegoInput: e.detail.value })
  },

  addAgencyCond(e) {
    const kind = e.currentTarget.dataset.kind
    const key = kind === 'must' ? 'agencyMustOpts' : 'agencyNegoOpts'
    const inputKey = kind === 'must' ? 'agencyMustInput' : 'agencyNegoInput'
    const val = String(this.data[inputKey] || '').trim()
    if (!val) {
      wx.showToast({ title: '请先输入条件内容', icon: 'none' })
      return
    }
    if (this.data[key].some((o) => o.v === val)) {
      wx.showToast({ title: '该条件已存在', icon: 'none' })
      return
    }
    this.setData({ [key]: this.data[key].concat([{ v: val, on: true }]), [inputKey]: '' })
  },

  onAgencyStepInput(e) {
    const i = Number(e.currentTarget.dataset.i)
    const k = e.currentTarget.dataset.k
    const flow = this.data.agencyFlow.slice()
    flow[i] = Object.assign({}, flow[i], { [k]: e.detail.value })
    this.setData({ agencyFlow: flow })
  },

  onAgencyStepDraft(e) {
    const k = e.currentTarget.dataset.k
    this.setData(k === 'name' ? { agencyStepName: e.detail.value } : { agencyStepDesc: e.detail.value })
  },

  addAgencyStep() {
    const n = String(this.data.agencyStepName || '').trim()
    const d = String(this.data.agencyStepDesc || '').trim()
    if (!n) {
      wx.showToast({ title: '请填写步骤名称', icon: 'none' })
      return
    }
    const seq = this.data.agencyStepSeq + 1
    this.setData({
      agencyFlow: this.data.agencyFlow.concat([{ id: 'as' + seq, n, d }]),
      agencyStepSeq: seq,
      agencyStepName: '',
      agencyStepDesc: ''
    })
  },

  removeAgencyStep(e) {
    const i = Number(e.currentTarget.dataset.i)
    const flow = this.data.agencyFlow.slice()
    flow.splice(i, 1)
    this.setData({ agencyFlow: flow })
  },

  moveAgencyStep(e) {
    const i = Number(e.currentTarget.dataset.i)
    const j = e.currentTarget.dataset.dir === 'up' ? i - 1 : i + 1
    if (j < 0 || j >= this.data.agencyFlow.length) return
    const flow = this.data.agencyFlow.slice()
    const tmp = flow[i]
    flow[i] = flow[j]
    flow[j] = tmp
    this.setData({ agencyFlow: flow })
  },

  pickAgencyTerm(e) {
    this.setData({ agencyTerm: String(e.currentTarget.dataset.v || '') })
  },

  onAgencyInput(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const form = Object.assign({}, this.data.agencyForm, { [key]: e.detail.value })
    this.setData({ agencyForm: form })
    if (key === 'qty' || key === 'price') this.calcFee()
  },

  /* 联系电话失焦归一化：粘贴的 +86 / 空格 / 短横线统一成纯数字（座机也保留） */
  onAgencyPhoneBlur(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const raw = String((e.detail && e.detail.value) || '')
    const val = normalizePhone(raw)
    if (val && val !== raw && isValidContactPhone(val)) {
      const form = Object.assign({}, this.data.agencyForm, { [key]: val })
      this.setData({ agencyForm: form })
    }
  },

  /* 按「数量 × 单价」算交易金额，再按档位试算服务费；租赁取首月租金合计后按 50% 计 */
  calcFee() {
    const f = this.data.agencyForm
    const qty = Number(f.qty) || 0
    const price = Number(String(f.price || '').replace(/,/g, '')) || 0
    const amount = qty > 0 && price > 0 ? qty * price : 0
    const res = agencyFee(amount, this.data.agencyRent, this.data.agencyType)
    let submitText = '填写金额后试算'
    /* 代采 / 代售统一后付费：发布、审核、上架都不收费，成交后再支付服务费 */
    let submitTip = '发布、审核、上架都不收费，成交后支付服务费。'
    if (amount > 0) {
      if (this.data.agencyRent) {
        submitText = '提交审核'
        submitTip = '审核通过后即上架；成交后支付半个月租金（服务费为一个月租金，买卖双方各承担 50%）。'
      } else if (res.largeAmount) {
        submitText = '提交资料核验 · 成交后付费'
        submitTip = this.data.agencyType === 'buy'
          ? '大额代采订单只对平台可见。提交后核验资料，通过后由坐席代为寻源；成交后按 0.5% 支付服务费。'
          : '大额代售审核通过后上架；成交后按 0.5% 支付服务费。'
      } else if (this.data.agencyType === 'buy') {
        submitText = '提交审核'
        submitTip = '审核通过后直接在平台内发布，有人咨询时客服与你对接；成交后支付服务费。'
      } else {
        submitText = '提交审核'
        submitTip = '审核通过后即上架；成交后支付服务费。'
      }
    }
    this.setData({
      feeAmountText: amount > 0 ? fmtMoney(amount) : '—',
      feeText: fmtMoney(res.fee),
      feeLarge: res.largeAmount === true,
        feeDeferred: res.deferredFee === true,
      feeRule: res.rule || '填写金额后自动试算',
      feeNote: this.data.agencyType === 'buy'
        ? '发布、审核、上架都不收费，成交后支付服务费；审核通过后直接在平台内发布，有人咨询时客服对接。'
        : '发布、审核、上架都不收费；审核通过后开始代寻、撮合，成交后支付服务费。',
      agencySubmitText: submitText,
      agencySubmitTip: submitTip
    })
  },

  chooseAgencyFile(e) {
    const kind = e.currentTarget.dataset.kind || 'license'
    if (kind === 'other' && this.data.agOther.length >= 3) {
      wx.showToast({ title: '补充材料最多 3 张', icon: 'none' })
      return
    }
    const pick = async (res) => {
      const files = (res && res.tempFiles) ||
        ((res && res.tempFilePaths) || []).map((p) => ({ tempFilePath: p }))
      const file = files[0]
      if (!file) return
      const size = Number(file.size) || 0
      if (size > MEDIA_MAX_BYTES.image) {
        wx.showToast({ title: MEDIA_SIZE_TEXT.image, icon: 'none' })
        return
      }
      const labelMap = {
        license: '营业执照',
        proof: this.data.agencyType === 'buy' ? '验资证明' : '物权证明',
        loi: '采购意向函',
        authorization: '委托授权书',
        idcard: '联系人身份证'
      }
      const fallback = labelMap[kind] || ('补充材料 ' + (this.data.agOther.length + 1))
      /* 选中即上传：管理端审核时直接看到原件，而不是只有文件名 */
      let fileId = ''
      if (file.tempFilePath) {
        wx.showLoading({ title: '上传中', mask: true })
        try {
          fileId = await uploadFile(file.tempFilePath, {
            cloudPath: 'agency/' + kind + '/' + Date.now() + '.jpg'
          })
        } catch (err) {
          wx.hideLoading()
          wx.showToast({ title: (err && err.message) || '上传失败，请重试', icon: 'none' })
          return
        }
        wx.hideLoading()
      }
      const item = {
        key: 'ag' + Date.now(),
        name: fallback,
        path: file.tempFilePath || '',
        fileId,
        size,
        sizeText: fmtSize(size),
        type: 'image/jpeg'
      }
      if (kind === 'license') this.setData({ agLicense: item })
      else if (kind === 'proof') this.setData({ agProof: item })
      else if (kind === 'loi') this.setData({ agLoi: item })
      else if (kind === 'authorization') this.setData({ agAuthorization: item })
      else if (kind === 'idcard') this.setData({ agIdcard: item })
      else this.setData({ agOther: this.data.agOther.concat(item) })
    }
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: 1, mediaType: ['image'], success: pick })
    } else {
      wx.chooseImage({ count: 1, success: pick })
    }
  },

  removeAgencyFile(e) {
    const kind = e.currentTarget.dataset.kind
    if (kind === 'license') {
      this.setData({ agLicense: null })
      return
    }
    if (kind === 'proof') {
      this.setData({ agProof: null })
      return
    }
    const singles = { loi: 'agLoi', authorization: 'agAuthorization', idcard: 'agIdcard' }
    if (singles[kind]) {
      this.setData({ [singles[kind]]: null })
      return
    }
    const i = Number(e.currentTarget.dataset.i)
    const list = this.data.agOther.slice()
    list.splice(i, 1)
    this.setData({ agOther: list })
  },

  toggleAgencyAgree() {
    this.setData({ agencyAgree: !this.data.agencyAgree })
  },

  /* 服务费规则 / 委托流程说明页：navigateTo 打开，返回后表单内容不丢失 */
  openAgencyDoc(e) {
    const kind = e.currentTarget.dataset.kind === 'flow' ? 'flow' : 'fee'
    wx.navigateTo({
      url: '/pages/agencydoc/agencydoc?kind=' + kind +
        '&side=' + (this.data.agencyType === 'sell' ? 'sell' : 'buy') +
        '&rental=' + (this.data.agencyRent ? 1 : 0)
    })
  },

  async submitAgency() {
    if (this.submitting) return
    const f = this.data.agencyForm
    const err = (t) => wx.showToast({ title: t, icon: 'none' })
    const isBuy = this.data.agencyType === 'buy'
    const qty = Number(f.qty) || 0
    const price = Number(String(f.price || '').replace(/,/g, '')) || 0

    const isCompany = this.data.agencySubjectType === 'company'
    if (!String(f.item || '').trim()) return err('请从平台预设型号库选择设备')
    if (!(qty > 0)) return err('请填写数量')
    if (!(price > 0)) return err(this.data.agencyRent ? '请填写月租金' : (isBuy ? '请填写采购预算' : '请填写期望售价'))
    /* 截止时间必填，最早明天：到期仍未成交则委托自动停止 */
    const deadline = String(this.data.agencyDeadline || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return err('请选择截止时间')
    if (deadline < dateStr(1)) return err('截止时间最早为明天')
    if (isCompany) {
      if (!String(f.subject || '').trim()) return err('请填写企业名称')
      if (!/^[0-9A-Za-z]{18}$/.test(String(f.creditCode || '').trim())) return err('请填写 18 位统一社会信用代码')
      if (!String(f.legal || '').trim()) return err('请填写法定代表人')
      if (!this.data.agLicense) return err('请上传营业执照')
    } else {
      if (!String(f.subject || '').trim()) return err('请填写姓名')
      if (!/^\d{17}[\dXx]$/.test(String(f.idCard || '').trim())) return err('请填写 18 位身份证号')
    }
    /* 联系电话先归一化（去空格 / 短横线 / +86 前缀）再校验：
       手机、座机、400 都允许，只拦空值和带 * 的脱敏号码 */
    const phone = normalizePhone(String(f.phone || ''))
    if (phone !== String(f.phone || '')) {
      this.setData({ agencyForm: Object.assign({}, f, { phone }) })
    }
    if (!isValidContactPhone(phone)) return err('联系人电话：' + contactPhoneError(String(f.phone || '')))
    /* 代采 / 代售：验资（代采）/ 物权证明（代售）与联系人身份证必传；委托授权书作为补充材料选填 */
    if (!this.data.agIdcard) return err('请上传联系人身份证')
    if (!this.data.agProof) return err(isBuy ? '请上传验资证明' : '请上传物权证明')
    /* 1000 万元及以上代采：补采购意向函；代售的物权证明已在上面统一必传 */
    const largeAmount = this.data.feeLarge === true
    if (largeAmount && isBuy && !this.data.agLoi) return err('请上传采购意向函')
    if (!this.data.agencyAgree) return err('请先阅读并勾选服务费规则')

    /* 代采 / 代售也是对外发布：提交前先确认主体信息与联系方式齐全 */
    if (!(await ensureProfileReady())) return

    const fee = Number(String(this.data.feeText).replace(/,/g, '')) || 0
    /* 与「发布商品」的更多要求同口径：勾选的条件 + 自定义条件，流程按步骤顺序提交 */
    const must = this.data.agencyMustOpts.filter((o) => o.on).map((o) => o.v)
    const nego = this.data.agencyNegoOpts.filter((o) => o.on).map((o) => o.v)
    const flow = this.data.agencyFlow.map((s) => (s.d ? s.n + '：' + s.d : s.n))
    this.submitting = true
    const payload = {
      /* 被驳回的委托：带原委托 id 重新提交，服务端原地覆盖并重新排队审核 */
      id: this.data.agencyResubmitId || undefined,
      side: isBuy ? 'buy' : 'sell',
      mode: this.data.agencyMode,
      rental: this.data.agencyRent,
      term: this.data.agencyRent ? this.data.agencyTerm : '',
      /* 代采 / 代售直接对接平台：可见范围与发布渠道不开放选择，由服务端统一处理 */
      item: String(f.item || '').trim(),
      cat: String(this.data.agencyCat || ''),
      qty,
      price,
      currency: this.data.currency || 'CNY',
      amount: qty * price,
      /* 截止时间：到点仍未成交即停止，代采合同以该时间为准 */
      deadline,
      /* 交易流程 / 必要条件 / 可协商条件：逐项添加后提交，全部选填 */
      flow,
      must,
      nego,
      subjectType: isCompany ? 'company' : 'person',
      subject: String(f.subject || '').trim(),
      creditCode: isCompany ? String(f.creditCode || '').trim() : '',
      legal: isCompany ? String(f.legal || '').trim() : '',
      idCard: isCompany ? '' : String(f.idCard || '').trim(),
      phone,
      serviceFee: fee,
      /* 后付费：发布时 payAmount 恒为 0，成交后再付服务费 */
      payAmount: 0,
      /* 只提交已上传的材料，未上传项不占位；fileId 供管理端直接预览原件 */
      media: [
        this.data.agLicense && { name: this.data.agLicense.name, kind: 'license', fileId: this.data.agLicense.fileId || '' },
        this.data.agProof && { name: this.data.agProof.name, kind: 'proof', fileId: this.data.agProof.fileId || '' },
        this.data.agLoi && { name: this.data.agLoi.name, kind: 'loi', fileId: this.data.agLoi.fileId || '' },
        this.data.agAuthorization && { name: this.data.agAuthorization.name, kind: 'authorization', fileId: this.data.agAuthorization.fileId || '' },
        this.data.agIdcard && { name: this.data.agIdcard.name, kind: 'idcard', fileId: this.data.agIdcard.fileId || '' }
      ].filter(Boolean).concat(this.data.agOther.map((m) => ({ name: m.name, kind: 'other', fileId: m.fileId || '' })))
    }
    /* 必须等云端落库成功再提示：接口失败时明确报错，不能假装「已提交」 */
    try {
      await request('user', 'agency.submit', payload, { silent: false })
      /* 后付费：提交后进入审核，审核通过即上架，成交后支付服务费 */
      const resubmit = !!this.data.agencyResubmitId
      wx.showModal({
        title: resubmit ? '已重新提交' : '已提交，等待审核',
        content: resubmit
          ? '已按退回原因修改并重新提交，将在 1 个工作日内重新审核，结果通过站内信通知。\n进度可在「我的 - 我的订单 - 代采代售」查看。'
          : (this.data.agencyRent
            ? '你的租赁委托已提交，将在 1 个工作日内完成审核。\n审核通过后即上架；成交后支付半个月租金（服务费为一个月租金，买卖双方各承担 50%）。\n进度可在「我的 - 我的订单 - 代采代售」查看，审核前可随时撤销。'
            : (largeAmount
              ? (isBuy
                ? '本单代采金额达到 1000 万元，成交后按 0.5% 支付服务费，订单只对平台可见。\n将在 1 个工作日内完成审核，通过后直接在平台内发布，有人咨询时客服与你对接交易条件。'
                : '本单代售金额达到 1000 万元，成交后按 0.5% 支付服务费。\n客服将在 1 个工作日内核对营业执照、物权证明、联系人身份证与联系人信息（委托授权书可选），通过后上架。')
              : (isBuy
                ? '你的代采委托已提交，将在 1 个工作日内完成审核。\n审核通过后直接在平台内发布，有人咨询时客服对接；成交后支付服务费。\n进度可在「我的 - 我的订单 - 代采代售」查看，审核前可随时撤销。'
                : '你的代售委托已提交，将在 1 个工作日内完成审核。\n审核通过后即上架，成交后支付服务费。\n进度可在「我的 - 我的订单 - 代采代售」查看，审核前可随时撤销。'))),
        showCancel: false,
        confirmText: '查看进度',
        success: () => this.goMineAgency()
      })
      return
    } catch (err) {
      /* request 已按错误码提示（字段不合规 / 同时进行委托超限），留在当前页修改 */
    } finally {
      this.submitting = false
    }
  },

  noop() {},

  /* ---------- 入口页跳转 ---------- */
  /* 入口页不原地切成表单，而是压入新的表单页：
     这样系统返回 / 侧滑返回时，落点是下面的「发布类型选择」，不会直接回到首页 */
  goSell() {
    wx.navigateTo({ url: '/pages/publish/publish?entry=1&type=sell' })
  },

  goBuy() {
    wx.navigateTo({ url: '/pages/publish/publish?entry=1&type=buy' })
  },

  /* 取消发布 / 返回：回到「发布类型选择」 */
  goBack() {
    /* 从入口页压入的表单：退回下面的入口页；已填写内容时先确认，避免误触丢失 */
    if (this.data.fromEntry) {
      if (!this.hasDraftContent()) return this.backToEntry()
      const pending = (this.data.pasteQueue || []).length
      wx.showModal({
        title: '退出填写',
        content: (pending ? '还有 ' + pending + ' 条粘贴识别的记录未发布。' : '') + '本次填写的内容不会保留。需要保留请先点底部「存草稿」。',
        cancelText: '继续填写',
        confirmText: '退出',
        success: (r) => {
          if (r.confirm) this.backToEntry()
        }
      })
      return
    }
    const pages = getCurrentPages() || []
    if (pages.length > 1) {
      /* 首页 / 商机 / 工具带进来的直达表单：换成入口页，落点仍是选择类型 */
      this._leaveGuard = false
      if (wx.disableAlertBeforeUnload) {
        try { wx.disableAlertBeforeUnload() } catch (e) {}
      }
      wx.redirectTo({ url: '/pages/publish/publish' })
      return
    }
    this.setData({ type: '', mode: '' })
    this.checkRent()
    this.syncModeOptions()
    this.syncTitle()
    /* 回到选类型入口页：这里没有可保存的表单，不能再弹「存草稿」 */
    this._leaveGuard = false
    if (wx.disableAlertBeforeUnload) {
      try { wx.disableAlertBeforeUnload() } catch (e) {}
    }
  },

  /* 发布成功 / 存草稿成功：回到「发布类型选择」；不再把用户丢回首页 */
  backToEntry() {
    PASTE_BATCH = null
    this._leaveGuard = false
    if (wx.disableAlertBeforeUnload) {
      try { wx.disableAlertBeforeUnload() } catch (e) {}
    }
    const pages = getCurrentPages() || []
    if (this.data.fromEntry && pages.length > 1) {
      wx.navigateBack()
      return
    }
    this.reset()
  },

  /* 自定义导航返回：在某个发布表单里未发布退出时，先回「发布类型选择」；
     编辑模式回「我发布的」，只有在入口页退出才真正离开发布页 */
  onNavBack() {
    if (this.data.editing) return this.backToMine()
    if (this.data.agencyType) return this.closeAgency()
    if (this.data.type) return this.goBack()
    const pages = getCurrentPages() || []
    if (pages.length > 1) return wx.navigateBack()
    wx.switchTab({ url: '/pages/home/home' })
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ mode })
    this.checkRent()
    this.syncTitle()
    this.resetCondFlow()
  }
})
