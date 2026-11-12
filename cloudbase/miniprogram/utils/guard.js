/**
 * 截屏 / 录屏 / 页面隐藏 时的安全防护。
 *
 * 小程序端能做的防护（全部在这里集中挂载）：
 * 1. wx.setVisualEffectOnCapture({ effect: 'blur' })：iOS 截屏直接模糊（最有效的前端手段）
 * 2. wx.onUserCaptureScreen / onScreenRecordingStateChanged：只静默上报，不向用户展示「不可截图」之类做不到的文案
 * 3. 图片禁止长按菜单（show-menu-by-longpress="false"），聊天图片改用页内查看器，不调用 wx.previewImage
 * 4. 不调用 wx.saveImageToPhotosAlbum / wx.saveVideoToPhotosAlbum / wx.downloadFile / wx.openDocument
 *    任何下载保存能力，材料仅在小程序内通过 canvas 渲染带水印版本
 *    （例外：share-poster 生成的分享海报只含公开字段，允许保存到相册）
 *
 * 真正的保护在后端：材料是私有存储 + 短签名链接 + 换人换线索拒绝。
 * 客户端只做契约配合，不对用户承诺做不到的能力。
 */

const { request } = require('./request')

let guardActive = false
/* 同一类事件 5 秒内只上报一次，避免连续截屏把后端写爆 */
const REPORT_GAP_MS = 5 * 1000
const lastReportAt = {}

/** 上报安全行为：只上报事件类型 + 当前页面，不携带任何页面内容 */
function reportGuard(kind) {
  const at = Date.now()
  if (at - (lastReportAt[kind] || 0) < REPORT_GAP_MS) return
  lastReportAt[kind] = at
  let page = ''
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const cur = pages.length ? pages[pages.length - 1] : null
    page = (cur && cur.route) || ''
  } catch (err) { /* 页面栈不可用时只报事件类型 */ }
  request('user', 'behavior.report', { kind: kind, page: page }, { silent: true }).catch(() => {})
}

function startScreenGuard() {
  if (guardActive) return
  guardActive = true

  /* iOS 截屏时画面直接模糊，看不到敏感内容 */
  if (wx.setVisualEffectOnCapture) {
    try {
      wx.setVisualEffectOnCapture({ effect: 'blur' })
    } catch (err) { /* 基础库版本低时忽略 */ }
  }

  /* 截屏事件：只静默上报，不展示做不到的「禁止截屏」提示 */
  if (wx.onUserCaptureScreen) {
    wx.onUserCaptureScreen(() => {
      reportGuard('screenshot')
    })
  }

  /* 录屏事件：只静默上报，页面内容本身已带账号水印 */
  if (wx.onScreenRecordingStateChanged) {
    try {
      wx.onScreenRecordingStateChanged((res) => {
        if (res && res.state === 'start') reportGuard('screen_record')
      })
    } catch (err) {
      /* 基础库版本低时忽略 */
    }
  }

  /* 页面切后台时：敏感页面清数据，避免从后台预览截图泄漏 */
  if (wx.onAppHide) {
    wx.onAppHide(() => {
      /* 清掉当前正在查看的材料大图 / 视频播放状态等，由各页面 onHide 自行处理 */
    })
  }
}

/**
 * 图片禁止长按保存。
 * 规范：所有 <image> 组件统一加 show-menu-by-longpress="false"，
 * 本函数返回统一的属性名（方便模板里调用）。
 */
function noLongPress() {
  return { 'show-menu-by-longpress': false }
}

/** 保存/下载按钮的统一禁用提示文案 */
function forbidSaveHint() {
  return '内容仅平台内可见'
}

/**
 * 关闭右上角「转发 / 分享到朋友圈」入口：
 * 材料、线索、联系方式只在平台内流转，默认任何页面都不允许转发出去。
 */
function hideShare() {
  if (typeof wx.hideShareMenu !== 'function') return
  try {
    wx.hideShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] })
  } catch (err) {
    /* 基础库版本低时忽略 */
  }
}

/* ============================================================
   分享：只允许分享「已经对外可见的公开信息」
   ------------------------------------------------------------
   规则（与平台保密口径一致）：
   1. 默认只开「发送给朋友」；工具页等纯公开测算页可传 withTimeline 额外开朋友圈
   2. 分享链接只带 id，不带手机号 / uid / 线索号 / openid 等任何身份信息
   3. 分享文案只用结构化公开字段（品牌、型号、数量、城市、价格），不拼自由文本标题
   4. 文案再兜底过滤手机号、座机、邮箱、微信号，避免用户自己把联系方式写进标题
   5. 接收方打开后走正常详情页：联系方式本来就不下发，只能通过平台坐席对接
   ============================================================ */

const SHARE_PAGES = {
  product: 'pages/product/product',
  demand: 'pages/demand/demand'
}

/* 分享卡片图：按内容类型取对应底图，卡片只含公开字段 */
const SHARE_CARDS = {
  product: '/assets/share/card-product.png',
  productRent: '/assets/share/card-rent.png',
  demand: '/assets/share/card-demand.png',
  demandRent: '/assets/share/card-demand-rent.png',
  home: '/assets/share/card-home.png',
  biz: '/assets/share/card-biz.png',
  agency: '/assets/share/card-agency.png'
}

/** 从任意文案里剔除直接联系方式（手机号 / 座机 / 邮箱 / 微信 / QQ） */
function scrubContact(text) {
  return String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
    .replace(/1[3-9]\d{9}/g, ' ')
    .replace(/0\d{2,3}-?\d{7,8}/g, ' ')
    .replace(/(微信|weixin|wechat|wx|电话|手机|qq)\s*[:：]?\s*[A-Za-z0-9_-]{4,}/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function isRentOf(item) {
  if (!item) return false
  if (item.isRent === true) return true
  return /租/.test(String(item.tradeMode || ''))
}

/**
 * 分享卡片标题：不同页面用不同文案，读起来像这个页面真正在讲的事。
 * 例：
 *   商品 →「NVIDIA H100 80G SXM · 出售 32 台 · 深圳 · ¥24.8 万」
 *   需求 →「求购 A100 80G · 64 台 · 北京 · 预算 ¥9.6 万」
 * 主体名称不进标题，避免把公司名带到外部。
 */
function shareTitle(kind, item) {
  const d = item || {}
  if (d.shareTitle) return scrubContact(d.shareTitle)
  const rent = isRentOf(d)
  /* productRent / demandRent 与基础类型共用一套文案，出租 / 求租不能混用 */
  const isDemand = kind === 'demand' || kind === 'demandRent'
  const act = isDemand
    ? (rent ? '求租' : '求购')
    : (rent ? '出租' : '出售')
  const name = [d.brand, d.model || d.cat].filter(Boolean).join(' ') || '算力设备'
  const bits = [name, act]
  if (d.qty) bits.push(String(d.qty) + ' 台')
  if (d.city) bits.push(String(d.city))
  if (isDemand && d.budgetText) bits.push(d.budgetMode === 'nego' ? '价格现场沟通' : '预算 ' + d.budgetText)
  if (!isDemand && d.priceText) bits.push(d.priceMode === 'nego' ? '价格现场沟通' : d.priceText)
  return scrubContact(bits.join(' · '))
}

/**
 * 分享卡片描述：不同页面给不同的引导语。
 * 商品引导「先筛选再联系」，需求引导「对照条件再响应」，避免一律套用同一句。
 */
function shareDesc(kind, item) {
  const d = item || {}
  if (d.shareDesc) return scrubContact(d.shareDesc)
  const rent = isRentOf(d)
  /* 商机带上公开主体信息：主体是平台要求公开的字段，不属于联系方式 */
  const org = d.org ? ' · ' + scrubContact(d.org) : ''
  const must = Array.isArray(d.must) ? d.must.length : 0
  const isDemand = kind === 'demand' || kind === 'demandRent'
  const isProduct = kind === 'product' || kind === 'productRent'
  if (isDemand) {
    return rent
      ? '租赁需求 · 条件确认后可直接与需求方对话' + org
      : '求购需求 · 对照必须条件后可直接响应' + org
  }
  if (isProduct) {
    if (rent) return '出租货源 · 确认条件后可与货主直接对话' + org
    return (must
      ? `${must} 项必须条件 · 确认后可与货主直接对话`
      : '确认条件后可与货主直接对话') + org
  }
  return '算力聚合 · 优质货源与求购需求' + org
}

/** 分享卡片图路径：按类型取底图 */
function shareImage(kind) {
  return SHARE_CARDS[kind] || SHARE_CARDS.home
}

/** 分享路径：租赁与买卖共用同一详情页，kind 只决定底图与文案 */
function sharePath(kind, id) {
  const page = SHARE_PAGES[kind] || SHARE_PAGES[kind === 'demandRent' ? 'demand' : 'product']
  return '/' + page + '?id=' + encodeURIComponent(String(id || '')) + '&from=share'
}

/**
 * 组装分享卡片：标题 + 描述 + 底图 + 路径。
 * 各页面共用这一份结构，只通过 kind 与数据区分文案。
 * item.shareImage 是 share-poster 预生成的海报临时路径，有就优先用，没有回退静态底图。
 */
function shareCard(kind, item, id) {
  const d = item || {}
  const poster = typeof d.shareImage === 'string' ? d.shareImage : ''
  const shareId = (id === undefined || id === null || id === '') ? d.id : id
  return {
    title: shareTitle(kind, d),
    desc: shareDesc(kind, d),
    imageUrl: poster || shareImage(kind),
    path: sharePath(kind, shareId || '')
  }
}

/** 详情页允许「发送给朋友」，工具页等公开页面可再开朋友圈 */
function enableShare(withTimeline) {
  if (typeof wx.showShareMenu !== 'function') return
  try {
    wx.showShareMenu({
      menus: withTimeline ? ['shareAppMessage', 'shareTimeline'] : ['shareAppMessage'],
      withShareTicket: false
    })
  } catch (err) {
    /* 基础库版本低时忽略 */
  }
}

/* ============================================================
   朋友圈单页模式（scene 1154）
   ------------------------------------------------------------
   从朋友圈打开时只有当前这一页，没有底部导航，也不能跳转 / 登录。
   页面据此隐藏依赖跳转的入口，并在顶部提示「前往小程序」。
   ============================================================ */

const SINGLE_PAGE_SCENE = 1154

/** 启动场景值：优先 getEnterOptionsSync（热启动也能拿到最新场景） */
function launchScene() {
  try {
    const opt = (typeof wx.getEnterOptionsSync === 'function' && wx.getEnterOptionsSync()) ||
      (typeof wx.getLaunchOptionsSync === 'function' && wx.getLaunchOptionsSync()) || {}
    return Number(opt.scene) || 0
  } catch (err) {
    return 0
  }
}

/** 是否处于朋友圈单页模式 */
function isSinglePage() {
  return launchScene() === SINGLE_PAGE_SCENE
}

/** 单页模式提示：微信只允许用户从右上角菜单进入完整小程序 */
function singlePageTip() {
  return '朋友圈预览 · 点右上角 ··· 选择「前往小程序」查看完整内容'
}

/* ============================================================
   水印：必须能唯一定位到「某一个账号」，泄漏后可定向追责
   ============================================================ */

const AUTH_KEY = 'suanli_user_auth_v1'

/** 读取本地登录态（只含匿名视图：uid / 昵称 / 脱敏手机号，不含 openid 明文） */
function readAccount() {
  try {
    return wx.getStorageSync(AUTH_KEY) || null
  } catch (err) {
    return null
  }
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function dateText(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function timeText(d) {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/**
 * 账号标识：平台用户 id 尾 8 位 + 昵称。
 * uid 由服务端按 openid 派生且在平台内唯一，是定向追责的主键；昵称给人看。
 */
function accountMark(user) {
  const u = user || readAccount() || {}
  const uid = String(u.uid || '')
  const parts = ['ID ' + (uid ? uid.slice(-8) : '未登录')]
  if (u.nick) parts.push(String(u.nick).slice(0, 10))
  return parts.join(' · ')
}

/** 水印是否绑定到了具体账号（未登录时只有「未登录」） */
function boundToAccount(user) {
  const u = user || readAccount() || {}
  return !!u.uid
}

/** 查看层完整水印：用户 id + 昵称 + 查看时间 */
function watermarkText(user) {
  const d = new Date()
  return accountMark(user) + ' · ' + dateText(d) + ' ' + timeText(d)
}

/** 铺满画面的水印块短文案：用户 id + 昵称，短到不会把内容压住 */
function watermarkTile(user) {
  return accountMark(user)
}

module.exports = {
  startScreenGuard,
  noLongPress,
  forbidSaveHint,
  hideShare,
  enableShare,
  isSinglePage,
  singlePageTip,
  shareTitle,
  shareDesc,
  shareImage,
  sharePath,
  shareCard,
  scrubContact,
  readAccount,
  accountMark,
  boundToAccount,
  watermarkText,
  watermarkTile
}
