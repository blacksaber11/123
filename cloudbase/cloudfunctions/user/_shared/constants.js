'use strict'

/**
 * 全局常量：角色、线索状态机、交易方式、必须条件、限流基线、材料白名单、演示账号。
 * 这里是唯一的口径来源，业务代码与验证脚本共用同一份，避免两边漂移。
 */

const ROLES = Object.freeze({
  USER: 'user',
  CS: 'cs',
  FINANCE: 'finance',
  ADMIN: 'admin'
})

/** 线索状态：待分配 → 跟进中 → 已对接 → 已成交 / 已关闭 */
const LEAD_STATUS = Object.freeze({
  BLOCKED: '已拦截',
  PENDING: '待分配',
  FOLLOWING: '跟进中',
  MATCHED: '已对接',
  DEALT: '已成交',
  CLOSED: '已关闭'
})

/**
 * 商品七态：
 * 草稿 →（发布）在售 → 洽谈中 → 已成交 / 已下架；平台可在后台改状态或退回为已驳回。
 * 审核不是发布的前置路径：发布即在售、对外可见，平台随时可进来做审核处置。
 * 只有「在售」可被咨询；「草稿 / 待审核 / 已驳回 / 已下架」对外不可见。
 */
const PRODUCT_STATUS = Object.freeze({
  DRAFT: '草稿',
  PENDING: '待审核',
  ON_SALE: '在售',
  NEGOTIATING: '洽谈中',
  DEALT: '已成交',
  OFFLINE: '已下架',
  REJECTED: '已驳回'
})

/** 商品对外可见状态（非属主）：草稿 / 待审核 / 已驳回 / 已下架 一律 404 */
const PRODUCT_PUBLIC_STATUS = Object.freeze([
  PRODUCT_STATUS.ON_SALE,
  PRODUCT_STATUS.NEGOTIATING,
  PRODUCT_STATUS.DEALT
])

/** 可发起咨询的商品状态：只有「在售」 */
const PRODUCT_CONSULTABLE_STATUS = Object.freeze([PRODUCT_STATUS.ON_SALE])

/**
 * 求购需求状态：草稿 →（发布）求购中 → 已对接 → 已关闭；平台可在后台改状态 / 下架 / 退回。
 * 审核不是发布的前置路径：发布即求购中、对外可见。
 * 被下架 / 已驳回 / 已关闭的需求不可再对外响应。
 */
const DEMAND_STATUS = Object.freeze({
  DRAFT: '草稿',
  PENDING: '待审核',
  OPEN: '求购中',
  MATCHED: '已对接',
  CLOSED: '已关闭',
  REJECTED: '已驳回',
  OFFLINE: '已下架'
})

const DEMAND_PUBLIC_STATUS = Object.freeze([DEMAND_STATUS.OPEN, DEMAND_STATUS.MATCHED, DEMAND_STATUS.CLOSED])

/** 可响应/咨询的求购状态：只有「求购中」 */
const DEMAND_CONSULTABLE_STATUS = Object.freeze([DEMAND_STATUS.OPEN])

/** 商品形式审核动作（管理端） */
const REVIEW_DECISIONS = Object.freeze({ APPROVE: '通过', REJECT: '驳回' })

/**
 * 状态流转白名单：不在表内的流转一律 CONFLICT。
 * 允许的回退只有两条：跟进中 → 待分配、已拦截 → 待分配（仅组长复核恢复）。
 * 已对接不可回退。
 */
const LEAD_TRANSITIONS = Object.freeze({
  已拦截: ['待分配', '已关闭'],
  待分配: ['跟进中', '已关闭'],
  跟进中: ['已对接', '待分配', '已关闭'],
  已对接: ['已成交', '已关闭'],
  已成交: ['已关闭'],
  已关闭: []
})

/** 只有「已对接 / 已成交」才允许释放联系方式（未建群不得释放） */
const PHONE_REVEALABLE_STATUS = Object.freeze([LEAD_STATUS.MATCHED, LEAD_STATUS.DEALT])

/**
 * 交易方式：四种互斥模式，价格口径与字段集合完全不同。
 * - 出售 / 求购：一次性成交，计价「元 / 台」，需要交易地与成色
 * - 出租 / 租赁：按租期用，计价「元 / 台 / 月」，设备留在出租方机房，无交易地、无成色
 */
const TRADE_MODES = Object.freeze({
  SELL: '出售',
  RENT: '出租',
  BUY: '求购',
  LEASE: '租赁'
})

/** 出售 / 出租 → 在售货源 Tab；求购 / 租赁 → 求购需求 Tab */
const TRADE_SIDE = Object.freeze({
  [TRADE_MODES.SELL]: 'supply',
  [TRADE_MODES.RENT]: 'supply',
  [TRADE_MODES.BUY]: 'demand',
  [TRADE_MODES.LEASE]: 'demand'
})

/** 租赁模式（出租 / 租赁）不填交易地、不填成色 */
const RENTAL_MODES = Object.freeze([TRADE_MODES.RENT, TRADE_MODES.LEASE])

/** 交易方式可选项（按发布入口区分） */
const TRADE_MODE_OPTIONS = Object.freeze({
  supply: Object.freeze([TRADE_MODES.SELL, TRADE_MODES.RENT]),
  demand: Object.freeze([TRADE_MODES.BUY, TRADE_MODES.LEASE])
})

/** 租期档位（出租 / 租赁通用） */
const RENT_TERMS = Object.freeze(['1 个月', '3 个月', '6 个月', '12 个月', '长期', '可议'])

/** 是否闭口价 */
const CLOSED_PRICE = Object.freeze({
  CLOSED: '闭口价（不议价）',
  OPEN: '开口价（可议价）'
})

/** 押金档位（出租方口径 / 承租方接受度口径） */
const RENT_DEPOSIT = Object.freeze([
  '免押金', '1 个月租金', '2 个月租金', '可议',
  '接受免押', '接受 1 个月租金', '接受 2 个月租金'
])

/** 租金支付方式 */
const RENT_PAY = Object.freeze(['月付', '季付', '半年付', '年付'])

/**
 * 租赁限制条款：平台标准条款，逐条勾选后写入发布内容。
 * 承租方（或出租方）须全部接受，硬门槛。
 */
const RENT_LIMITS = Object.freeze([
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
])

/** 买卖场景必须条件（货主对买家） */
const MUST_CONDITIONS_SELL = Object.freeze([
  '接受同台互验',
  '接受先验资再看货',
  '可提供采购意向函',
  '接受指定交易地点',
  '强主体（国企 / 央企）'
])

/** 买卖场景必须条件（买家对货主 / 供给方） */
const MUST_CONDITIONS_BUY = Object.freeze([
  '接受同台互验',
  '提供设备实拍图片',
  '提供设备实拍视频',
  '支持资金监管账户',
  '可提供暗语视频（协商后录制）'
])

/** 租赁场景必须条件（出租方对承租方） */
const MUST_CONDITIONS_RENT = Object.freeze([
  '接受同台互验',
  '接受先验资再看货',
  '可提供采购意向函',
  '强主体（国企 / 央企）',
  '接受签署租赁意向协议',
  '接受按期预付租金',
  '用途仅限训练 / 推理等合规业务',
  '不得转租或二次转让'
])

/** 租赁场景必须条件（承租方对出租方） */
const MUST_CONDITIONS_LEASE = Object.freeze([
  '明确租金 / 租期 / 押金条款',
  '提供设备实拍图片',
  '提供设备实拍视频',
  '接受同台互验',
  '可提供暗语视频（协商后录制）',
  '支持租金资金监管账户'
])

/** 全部必须条件枚举（服务端白名单，客户端提交的未知条件一律拒绝） */
const MUST_CONDITIONS = Object.freeze([
  ...MUST_CONDITIONS_SELL,
  ...MUST_CONDITIONS_BUY,
  ...MUST_CONDITIONS_RENT,
  ...MUST_CONDITIONS_LEASE,
  '接受指定交易地点',
  '支持资金监管账户',
  '可提供暗语视频（协商后录制）'
].filter((item, index, arr) => arr.indexOf(item) === index))

/** 咨询人筛选档位 */
const TIERS = Object.freeze({
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  DEFAULT: '默认'
})

/** 筛选规则条件类型：新增 / 编辑表单与判档引擎共用同一份口径 */
const RULE_TYPES = Object.freeze({
  word: '敏感词',
  phone: '手机号黑名单',
  repeat: '同一账号 24h 咨询次数',
  materials: '资质材料数量',
  cross: '跨品类数量',
  category: '指定品类',
  budget: '预算门槛'
})

/** 档位含义说明：管理端规则页与新增规则弹窗直接展示，避免「填了不知道算哪档」 */
const TIER_GUIDE = Object.freeze([
  { tier: 'P0', name: 'P0 拦截', desc: '命中即进「已拦截」箱，不投递客服、不通知买方（如手机号黑名单、敏感词）' },
  { tier: 'P1', name: 'P1 待核', desc: '正常进入待分配，但标红提示客服先核对资质（如材料不足、跨品类、手机号格式异常）' },
  { tier: 'P2', name: 'P2 优先', desc: '正常投递，但在待分配队列中排在前面（如预算达到门槛、重点品类）' },
  { tier: '默认', name: '默认', desc: '命中只记录、不改变优先级，按提交时间排队' }
])

/** 限流基线：固定窗口计数 */
const RATE_LIMITS = Object.freeze({
  login: { max: 5, windowMs: 15 * 60 * 1000, label: '账号' }, // 5 次 / 15 分钟 / 账号
  consult: { max: 10, windowMs: 60 * 60 * 1000, label: '账号' }, // 10 次 / 小时 / 账号
  materialSign: { max: 60, windowMs: 60 * 60 * 1000, label: '用户' }, // 60 次 / 小时 / 用户
  publishProduct: { max: 10, windowMs: 24 * 60 * 60 * 1000, label: '账号' }, // 10 条 / 天
  publishDemand: { max: 5, windowMs: 24 * 60 * 60 * 1000, label: '账号' }, // 5 条 / 天
  publishAgency: { max: 5, windowMs: 24 * 60 * 60 * 1000, label: '账号' }, // 委托 5 条 / 天
  publishQuote: { max: 10, windowMs: 24 * 60 * 60 * 1000, label: '账号' }, // 粘贴报价 10 次 / 天
  publishNews: { max: 5, windowMs: 24 * 60 * 60 * 1000, label: '账号' }, // 资讯投稿 5 篇 / 天
  bizApply: { max: 3, windowMs: 24 * 60 * 60 * 1000, label: '账号' }, // 商机开通申请 3 次 / 天
  bizClaim: { max: 30, windowMs: 24 * 60 * 60 * 1000, label: '账号' }, // 领取联系方式 30 次 / 天
  msgSend: { max: 120, windowMs: 60 * 60 * 1000, label: '账号' }, // 站内消息 / 直聊 120 条 / 小时
  stockSave: { max: 200, windowMs: 24 * 60 * 60 * 1000, label: '账号' }, // 库存写入 200 次 / 天
  favSave: { max: 500, windowMs: 24 * 60 * 60 * 1000, label: '账号' }, // 收藏 / 取消收藏 500 次 / 天
  followSave: { max: 100, windowMs: 24 * 60 * 60 * 1000, label: '账号' }, // 关注 / 取关 100 次 / 天
  searchLog: { max: 120, windowMs: 60 * 60 * 1000, label: '账号' }, // 搜索埋点 120 次 / 小时
  browse: { max: 300, windowMs: 60 * 1000, label: '用户' }, // 读接口 300 次 / 分钟
  duplicateConsult: { windowMs: 24 * 60 * 60 * 1000 } // 同一手机号 + 同一目标 24 小时去重
})

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 管理端 token 7 天（避免运营期间被反复踢下线）
const MATERIAL_LINK_TTL_MS = 5 * 60 * 1000 // 材料临时链接 5 分钟
const AUDIT_RETENTION_DAYS = 180 // 审计保留 180 天（≥6 个月红线）
const BLOCKED_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000 // 已拦截 24h 内可复核恢复
const BLOCKED_CLEANUP_DAYS = 30 // 已拦截 30 天未复核自动清理

const PAGING = Object.freeze({ maxLimit: 50, defaultLimit: 10, maxPage: 100 })

/** 审计动作 → 中文（操作日志 / 客服服务记录共用同一份口径） */
const AUDIT_ACTION_LABELS = Object.freeze({
  'admin.login': '登录管理端',
  'admin.logout': '退出登录',
  'lead.assign': '分配 / 转派工单',
  'lead.claim': '领取咨询单',
  'lead.updateStatus': '变更工单状态',
  'contact.reveal': '释放联系方式',
  'product.review': '审核商品',
  'product.offline': '下架商品',
  'product.online': '重新上架商品',
  'product.delete': '删除商品',
  'demand.close': '关闭求购需求',
  'demand.offline': '下架求购需求',
  'demand.delete': '删除求购需求',
  'demand.review': '审核求购需求',
  'product.submit': '提交商品审核',
  'demand.submit': '提交需求审核',
  'rule.toggle': '切换筛选规则',
  'rule.create': '新增筛选规则',
  'rule.update': '修改筛选规则',
  'rule.sortSave': '保存排序规则',
  'catalog.save': '维护产品型号',
  'catalog.remove': '删除产品型号',
  'account.create': '新增账号',
  'account.update': '修改账号',
  'account.resetPassword': '重置口令',
  'msg.reply': '回复用户消息',
  'msg.view': '查看用户会话',
  'msg.directHandle': '处置直聊会话',
  'agency.submit': '提交代采 / 代售委托',
  'agency.confirm': '确认委托上架',
  'agency.review': '审核代采 / 代购工单',
  'agency.reveal': '查看委托联系方式',
  'agency.reject': '驳回委托',
  'agency.close': '关闭委托 / 发起成交确认',
  'agency.dealConfirm': '委托方确认成交',
  'agency.expire': '委托到截止时间自动关闭',
  'news.create': '发布官方资讯',
  'news.review': '审核资讯投稿',
  'news.offline': '下架资讯',
  'news.delete': '删除资讯',
  'quote.paste': '提交粘贴报价',
  'quote.remove': '删除粘贴报价',
  'biz.apply': '申请商机权限',
  'biz.grant': '开通 / 续费商机权限',
  'biz.revoke': '停用商机权限',
  'biz.setExpire': '修改商机权限到期时间',
  'biz.claim': '领取商机',
  'user.admin': '手动调整用户',
  'setting.save': '保存系统设置',
  'risk.handle': '风险池处置',
  'report.handle': '处置举报 / 反馈',
  'account.deleteHandle': '处理账号注销申请',
  'refund.handle': '处理退款申请'
})

/** 审计结果码 → 中文 */
const AUDIT_RESULT_LABELS = Object.freeze({
  allow: '成功',
  UNAUTHENTICATED: '认证失败',
  FORBIDDEN: '无权限',
  CONFLICT: '状态冲突',
  VALIDATION: '校验未通过',
  NOT_FOUND: '对象不存在'
})

/**
 * 计入「客服服务记录」的动作：分配 / 转派、状态推进、释放联系方式、回复消息，
 * 以及代采 / 代售确认到账、商机开通续费 —— 这些都由客服坐席在管理端完成。
 */
const SERVICE_ACTIONS = Object.freeze([
  'lead.assign',
  'lead.claim',
  'lead.updateStatus',
  'contact.reveal',
  'msg.reply',
  'agency.confirm',
  'agency.reject',
  'agency.review',
  'agency.reveal',
  'biz.grant',
  'risk.handle'
])

/**
 * 发布媒体（设备实拍图 / 验资视频 / 资质文件）的数量与大小上限。
 * 数量：图片（含 PDF）最多 5 个、视频最多 3 段。
 * 大小按手机常规拍摄体量设定，既不卡住正常拍摄，也不让单个文件撑爆存储：
 * - 图片 10MB：覆盖主流手机 12MP~48MP 直出照片；
 * - 文档 20MB：营业执照扫描件、采购意向函 PDF；
 * - 视频 50MB：约 1 分钟 1080p 手机视频，与服务端单次上传读入内存的上限一致。
 */
const MEDIA_LIMIT = Object.freeze({ image: 5, video: 3 })
const MEDIA_MAX_BYTES = Object.freeze({
  image: 10 * 1024 * 1024,
  doc: 20 * 1024 * 1024,
  video: 50 * 1024 * 1024
})

/** 媒体大小上限的中文提示 */
const MEDIA_SIZE_TEXT = Object.freeze({
  image: '单张图片不能超过 10MB',
  doc: '单个文件不能超过 20MB',
  video: '单段视频不能超过 50MB'
})

/**
 * 站内聊天媒体口径：
 * - 聊天记录（文字 / 图片 / 视频）服务端只保留 30 天；
 * - 图片 / 视频 7 天内未被对方打开即过期（文件同时清理）；
 * - 打开后随聊天记录保留至 30 天，客户端自行落本地缓存。
 */
const CHAT_RETENTION_DAYS = 30
const CHAT_MEDIA_UNOPENED_DAYS = 7
const CHAT_MEDIA_MAX_BYTES = Object.freeze({
  image: 10 * 1024 * 1024,
  video: 50 * 1024 * 1024
})
const CHAT_VIDEO_MAX_SECONDS = 60

/** 材料类型：类型 → 大小上限与归类 */
const MATERIAL_TYPES = Object.freeze({
  'image/jpeg': { ext: ['jpg', 'jpeg'], maxBytes: MEDIA_MAX_BYTES.image, kind: 'image' },
  'image/png': { ext: ['png'], maxBytes: MEDIA_MAX_BYTES.image, kind: 'image' },
  'image/webp': { ext: ['webp'], maxBytes: MEDIA_MAX_BYTES.image, kind: 'image' },
  'application/pdf': { ext: ['pdf'], maxBytes: MEDIA_MAX_BYTES.doc, kind: 'doc' },
  'video/mp4': { ext: ['mp4'], maxBytes: MEDIA_MAX_BYTES.video, kind: 'video' },
  /* iPhone 默认 MOV、部分安卓导出 M4V，统一按视频接收，避免「选得中却传不上」 */
  'video/quicktime': { ext: ['mov'], maxBytes: MEDIA_MAX_BYTES.video, kind: 'video' },
  'video/x-m4v': { ext: ['m4v'], maxBytes: MEDIA_MAX_BYTES.video, kind: 'video' }
})

const MATERIAL_ALLOWED_EXT = Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'pdf', 'mp4', 'mov', 'm4v'])

/** 显式拒绝：svg / html / js / exe 等一律不允许上传 */
const MATERIAL_BLOCKED_EXT = Object.freeze([
  'svg', 'html', 'htm', 'xhtml', 'js', 'mjs', 'cjs', 'ts', 'exe', 'bat', 'cmd', 'sh', 'php',
  'jsp', 'asp', 'aspx', 'zip', 'rar', '7z', 'gz', 'tar', 'iso', 'dll', 'so', 'apk', 'dmg'
])

const MAX_MATERIAL_NAME_LEN = 120

/**
 * 主体与联系方式的公开范围（用户可在「我的 - 个人信息」二选一）：
 * hidden — 不公开主体：公开页只显示「平台核验」，主体与联系人不下发，也不进入商机池；
 *          平台不代转联系方式，双方只能在站内会话沟通；
 * open   — 公开主体：公开页展示主体全称与联系人（小体量商家直连场景），手机号仍脱敏。
 * 历史数据中的 matched（对接后可见）统一按 hidden 处理，不会因此多暴露主体。
 */
const EXPOSURES = Object.freeze({
  HIDDEN: 'hidden',
  OPEN: 'open'
})

const EXPOSURE_LABELS = Object.freeze({
  hidden: '不公开主体',
  open: '公开主体'
})

/**
 * 商品 / 需求 / 代售委托的内容可见范围（与上面的「主体公开范围」相互独立）：
 * public  — 公开：进入列表、搜索、榜单与商机池，展示发布者身份；
 * private — 私密：内容照常进入列表、搜索与榜单，但发布者完全匿名——
 *           不下发头像 / 主体 / 主页入口，主页也不收录，只能由本人在对话中自报身份。
 * 代采委托与 1000 万元及以上代采订单一律按保密处理，只对平台可见。
 */
const VISIBILITIES = Object.freeze({
  PUBLIC: 'public',
  PRIVATE: 'private'
})

const VISIBILITY_LABELS = Object.freeze({
  public: '公开',
  private: '保密'
})

/**
 * 发布渠道：发布方自行选择内容出现在哪里。
 * normal — 仅普通发布：进入公开列表 / 搜索，不参与商机匹配；
 * pool   — 仅商机：只在商机池按型号匹配，不进入普通列表；
 * both   — 二者都发：普通列表与商机池同时可见。
 * 保密发布只能是 normal（隐藏主体只能普通发布）。
 */
const PUBLISH_CHANNELS = Object.freeze({
  NORMAL: 'normal',
  POOL: 'pool',
  BOTH: 'both'
})

const PUBLISH_CHANNEL_LABELS = Object.freeze({
  normal: '仅普通发布',
  pool: '仅商机',
  both: '二者都发'
})

/** 币种：常见 10 种，默认人民币 */
const CURRENCIES = Object.freeze([
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
])
const DEFAULT_CURRENCY = 'CNY'

/**
 * 1000 万元及以上：代采 / 代售统一走资料核验。
 * - 代采 / 代售不免单，成交后按成交金额 0.5% 收取服务费；
 * - 租赁不适用本档：服务费恒为一个月租金，买卖双方各承担 50%；
 * - 1000 万元及以上代采订单只对平台可见，资料核验通过后上架。
 */
const LARGE_AMOUNT_THRESHOLD = 10000000

/** 大额代采 / 需求必传材料（kind 与 agency media 的 kind 同口径） */
const LARGE_FREE_MATERIALS = Object.freeze([
  { kind: 'loi', label: '采购意向函' },
  { kind: 'authorization', label: '委托授权书' },
  { kind: 'idcard', label: '联系人身份证' }
])

/** 大额代售资料核验材料：营业执照、货源证明、委托授权书、联系人身份证 */
const LARGE_SELL_MATERIALS = Object.freeze([
  { kind: 'license', label: '营业执照' },
  { kind: 'proof', label: '货源证明' },
  { kind: 'authorization', label: '委托授权书' },
  { kind: 'idcard', label: '联系人身份证' }
])

/** 字段级加密覆盖范围：这些字段一律不落明文 */
const ENCRYPTED_FIELDS = Object.freeze([
  'phone', 'realname', 'idCard', 'contact', 'subject', 'bankAccount', 'address'
])

/**
 * ⚠️ 演示账号：仅用于本地联调与 verify 脚本。
 * 生产环境必须通过环境变量覆盖（ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_TOTP_SECRET、
 * CS_USERNAME / CS_PASSWORD / CS_TOTP_SECRET、
 * FINANCE_USERNAME / FINANCE_PASSWORD / FINANCE_TOTP_SECRET），落地前务必修改初始口令与 TOTP 密钥。
 */
const DEMO_ADMIN_ACCOUNTS = Object.freeze([
  {
    key: 'admin',
    envPrefix: 'ADMIN',
    username: 'admin',
    password: 'Admin@12345',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    role: ROLES.ADMIN,
    name: '平台管理员',
    org: '算力聚合'
  },
  {
    key: 'cs',
    envPrefix: 'CS',
    username: 'cs',
    password: 'Cs@12345',
    totpSecret: 'GEZDGNBVGY3TQOJQ',
    role: ROLES.CS,
    name: '客服坐席',
    org: '算力聚合'
  },
  {
    key: 'finance',
    envPrefix: 'FINANCE',
    username: 'finance',
    password: 'Finance@12345',
    totpSecret: 'MZXW6YTBOI2AAAAA',
    role: ROLES.FINANCE,
    name: '财务专员',
    org: '算力聚合'
  }
])

const SOURCE_LABEL = '小程序咨询'

module.exports = {
  ROLES,
  LEAD_STATUS,
  LEAD_TRANSITIONS,
  PHONE_REVEALABLE_STATUS,
  PRODUCT_STATUS,
  PRODUCT_PUBLIC_STATUS,
  PRODUCT_CONSULTABLE_STATUS,
  DEMAND_STATUS,
  DEMAND_PUBLIC_STATUS,
  DEMAND_CONSULTABLE_STATUS,
  REVIEW_DECISIONS,
  TRADE_MODES,
  TRADE_SIDE,
  RENTAL_MODES,
  TRADE_MODE_OPTIONS,
  RENT_TERMS,
  CLOSED_PRICE,
  RENT_DEPOSIT,
  RENT_PAY,
  RENT_LIMITS,
  MUST_CONDITIONS,
  MUST_CONDITIONS_SELL,
  MUST_CONDITIONS_BUY,
  MUST_CONDITIONS_RENT,
  MUST_CONDITIONS_LEASE,
  TIERS,
  RULE_TYPES,
  TIER_GUIDE,
  RATE_LIMITS,
  SESSION_TTL_MS,
  MATERIAL_LINK_TTL_MS,
  AUDIT_RETENTION_DAYS,
  BLOCKED_REVIEW_WINDOW_MS,
  BLOCKED_CLEANUP_DAYS,
  PAGING,
  AUDIT_ACTION_LABELS,
  AUDIT_RESULT_LABELS,
  SERVICE_ACTIONS,
  MATERIAL_TYPES,
  MATERIAL_ALLOWED_EXT,
  MATERIAL_BLOCKED_EXT,
  MEDIA_LIMIT,
  MEDIA_MAX_BYTES,
  MEDIA_SIZE_TEXT,
  CHAT_RETENTION_DAYS,
  CHAT_MEDIA_UNOPENED_DAYS,
  CHAT_MEDIA_MAX_BYTES,
  CHAT_VIDEO_MAX_SECONDS,
  MAX_MATERIAL_NAME_LEN,
  EXPOSURES,
  EXPOSURE_LABELS,
  VISIBILITIES,
  VISIBILITY_LABELS,
  PUBLISH_CHANNELS,
  PUBLISH_CHANNEL_LABELS,
  CURRENCIES,
  DEFAULT_CURRENCY,
  LARGE_AMOUNT_THRESHOLD,
  LARGE_FREE_MATERIALS,
  LARGE_SELL_MATERIALS,
  ENCRYPTED_FIELDS,
  DEMO_ADMIN_ACCOUNTS,
  SOURCE_LABEL
}
