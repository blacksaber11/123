'use strict'

const { AppError, CODES } = require('./errors')
const { applyRestrictions, stateOf } = require('./restrictions')
const {
  ROLES,
  LEAD_STATUS,
  LEAD_TRANSITIONS,
  PHONE_REVEALABLE_STATUS,
  DEMO_ADMIN_ACCOUNTS,
  SESSION_TTL_MS,
  AUDIT_RETENTION_DAYS,
  BLOCKED_REVIEW_WINDOW_MS,
  BLOCKED_CLEANUP_DAYS,
  TRADE_MODE_OPTIONS,
  TIERS,
  RULE_TYPES,
  TIER_GUIDE,
  PRODUCT_STATUS,
  DEMAND_STATUS,
  REVIEW_DECISIONS,
  AUDIT_ACTION_LABELS,
  AUDIT_RESULT_LABELS,
  SERVICE_ACTIONS,
  EXPOSURES,
  EXPOSURE_LABELS,
  CHAT_RETENTION_DAYS,
  /* 代采代售咨询标准流程的阶段枚举与展示文案，与小程序端共用 */
  CONSULT_STAGE,
  CONSULT_STAGE_LABELS,
  /* 会员到期提醒：内容模板与提前天数等配置，媒体页与定时提醒共用 */
  MEMBER_REMIND_DEFAULTS,
  memberRemindOf
} = require('./constants')
const { hashPassword, verifyPassword, verifyTotp, decryptField, blindIndex, sha256Hex, userNoOf, randomToken, randomId } = require('./crypto')
const { str, enumOf, normalizePaging, normalizePhone, maskSensitiveText, maskPhone, fileRef } = require('./validate')
const {
  projectProductForStaff,
  projectDemand,
  projectLeadForStaff,
  assertNoPlaintextContact
} = require('./projection')
const { appendAudit, projectAudit, isExpired, retentionCutoff } = require('./audit')
/* 字段级解密：AAD 绑定「集合.字段.记录id」，与 encryptFields 的加密口径一致 */
const { decryptFieldOf } = require('./secrets')
const { writeXlsx } = require('./xlsx')
const { ROLE_PAGES, ROLE_ACTIONS, can } = require('./rbac')
const { countHeat } = require('./domain')
const { chatKindOf, mediaState, chatCutoff } = require('./chatmedia')
/* 内置型号库：与小程序 / 用户端共用同一份静态目录，管理端只在其上叠加平台覆盖记录 */
const { DEVICE_CATALOG } = require('./device-catalog')
/* 主体类型与个人资料页共用同一份枚举，避免两边口径漂移 */
const { SUBJECT_TYPES, REPORT_TYPES, REPORT_TARGETS, REPORT_STATUS } = require('./handlers.user')
const REPORT_STATUS_LIST = Object.values(REPORT_STATUS)
const { EVENT_KIND_LIST, cleanupUserEvents } = require('./events')
const { CS_STATUS, RATING_TAGS, csStatusOf, createCsEngine, monthKeyOf, normalizeMonthKey } = require('./cs')
const {
  CONTRACT_STATUS,
  TICKET_STATE,
  TICKET_STATE_LABELS,
  ticketStateOf,
  stageOf: consultStageOf,
  stageLabel: consultStageLabel,
  advance: advanceConsultStage,
  assertStage: assertConsultStage
} = require('./consultflow')
/* 平台确认成交的唯一入口：客服登记成交与管理员委托管理确认成交共用同一套写入 */
const { AGENCY_STATUS, confirmAgencyDeal, lockAgencyForContract } = require('./market')

/**
 * 用户上传材料的管理端摘要：名称 / 类型 / 大小 / 种类 + 上传得到的 fileId。
 * 审核详情据此直接展示图片与视频，不必再让坐席手动打开核对。
 */
function mediaMeta(list) {
  return (Array.isArray(list) ? list : []).map((m) => ({
    name: (m && m.name) || '',
    type: (m && m.type) || '',
    kind: (m && m.kind) || 'other',
    size: Number(m && m.size) || 0,
    fileId: (m && m.fileId) || ''
  }))
}

/**
 * 内置型号库摊平为「品类 / 品牌 / 系列 / 型号」四元组。
 * 顺序沿用静态目录的常见度排序，管理端列表与用户端滚轮口径一致。
 */
function flattenDeviceCatalog() {
  const out = []
  for (const cat of Object.keys(DEVICE_CATALOG || {})) {
    const brands = DEVICE_CATALOG[cat] || {}
    for (const brand of Object.keys(brands)) {
      const seriesMap = brands[brand] || {}
      for (const series of Object.keys(seriesMap)) {
        for (const model of seriesMap[series] || []) out.push({ cat, brand, series, model })
      }
    }
  }
  return out
}

/** 会员四档配置：管理端设置页提交，限制在合理区间，未提交时保持原值 */
const PLAN_KEYS = [
  { key: 'month', label: '月卡', days: 30, price: 99, original: 99 },
  { key: 'quarter', label: '季卡', days: 90, price: 268, original: 297 },
  { key: 'half', label: '半年卡', days: 180, price: 499, original: 594 },
  { key: 'year', label: '年卡', days: 365, price: 899, original: 1188 }
]

/** 首页跑马灯横幅：最多 20 条，标题进滚动条，详情进点击弹窗 */
const BANNER_MAX_ITEMS = 20

function normalizeBannerItems(input, opts) {
  const lenient = !!(opts && opts.lenient)
  if (input === undefined || input === null) return lenient ? [] : null
  const list = Array.isArray(input) ? input : []
  if (!Array.isArray(input) && !lenient) {
    throw new AppError(CODES.VALIDATION, '横幅内容格式不正确')
  }
  if (list.length > BANNER_MAX_ITEMS && !lenient) {
    throw new AppError(CODES.VALIDATION, `横幅最多 ${BANNER_MAX_ITEMS} 条`)
  }
  const out = []
  list.slice(0, BANNER_MAX_ITEMS).forEach((row, i) => {
    const title = String((row && row.title) || '').trim()
    const content = String((row && row.content) || '').trim()
    if (!title) {
      if (lenient) return
      throw new AppError(CODES.VALIDATION, `第 ${i + 1} 条横幅缺少标题`)
    }
    if (!lenient && title.length > 60) {
      throw new AppError(CODES.VALIDATION, `第 ${i + 1} 条横幅标题请控制在 60 字以内`)
    }
    if (!lenient && content.length > 2000) {
      throw new AppError(CODES.VALIDATION, `第 ${i + 1} 条横幅内容请控制在 2000 字以内`)
    }
    out.push({
      id: String((row && row.id) || '') || `bn${i + 1}`,
      title: title.slice(0, 60),
      content: content.slice(0, 2000)
    })
  })
  return out
}

function normalizePlanConfig(input) {
  if (input === undefined || input === null) return null
  if (!Array.isArray(input) || input.length !== PLAN_KEYS.length) {
    throw new AppError(CODES.VALIDATION, '套餐配置需包含月/季/半年/年四档')
  }
  const byKey = new Map(input.map((row) => [String((row && row.key) || ''), row || {}]))
  return PLAN_KEYS.map((def) => {
    const src = byKey.get(def.key)
    if (!src) throw new AppError(CODES.VALIDATION, `缺少${def.label}配置`)
    const days = Number(src.days)
    const price = Number(src.price)
    const original = src.original === undefined || src.original === '' ? def.original : Number(src.original)
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new AppError(CODES.VALIDATION, `${def.label}天数需为 1 - 3650 的整数`)
    }
    if (!Number.isFinite(price) || price <= 0 || price > 999999) {
      throw new AppError(CODES.VALIDATION, `${def.label}价格需大于 0`)
    }
    if (!Number.isFinite(original) || original < price || original > 999999) {
      throw new AppError(CODES.VALIDATION, `${def.label}原价不能低于现价`)
    }
    return {
      key: def.key,
      label: str(src.label || def.label, { field: '套餐名称', max: 12 }),
      days,
      price: Math.round(price * 100) / 100,
      original: Math.round(original * 100) / 100
    }
  })
}

/**
 * 管理账号来源有两处：
 * 1) 环境变量引导账号（缺失时回落到 constants 里的演示值，生产必须覆盖）；
 * 2) accounts 集合里的在线账号（管理员在「账号管理」里新增 / 停用）。
 * 同名时以数据库账号为准，便于在线轮换口令；新增账号禁止占用引导账号名。
 */
/** 生产环境标识：任一变量声明为 production 即视为生产，禁止回落到演示口令 */
function isProduction(env) {
  const source = env || {}
  /* TCB_ENV 由云开发运行时注入（如 prod-1gxxxx），存在即说明已部署到云端 */
  if (String(source.TCB_ENV || '').trim()) return true
  const flags = [source.ENV, source.NODE_ENV, source.WX_ENV, source.APP_ENV]
  return flags.some((flag) => /^(prod|production)$/i.test(String(flag == null ? '' : flag).trim()))
}

function buildAccounts(env) {
  const source = env || {}
  const prod = isProduction(source)
  return DEMO_ADMIN_ACCOUNTS.map((demo) => {
    const prefix = demo.envPrefix
    const rawUsername = source[`${prefix}_USERNAME`]
    const rawPassword = source[`${prefix}_PASSWORD`]
    const rawTotp = source[`${prefix}_TOTP_SECRET`]
    /* 生产环境缺配置直接失败：宁可管理端不可用，也不能用演示口令登录 */
    if (prod && (!rawUsername || !rawPassword || !rawTotp)) {
      throw new AppError(CODES.INTERNAL, '管理端账号未完成生产配置（口令 / 动态口令密钥），已拒绝启动')
    }
    const username = String(rawUsername || demo.username).trim().toLowerCase()
    const password = String(rawPassword || demo.password)
    const totpSecret = String(rawTotp || demo.totpSecret).trim().replace(/\s/g, '')
    return {
      username,
      passwordHash: hashPassword(password),
      totpSecret,
      role: demo.role,
      name: demo.name,
      org: demo.org
    }
  })
}

/**
 * 管理端口令复杂度：至少 10 位，且至少包含大写 / 小写 / 数字 / 符号中的三类。
 * 弱口令（含演示口令）一律拒绝，避免在线新增的账号把后台整体降级。
 */
function assertStrongPassword(password) {
  const value = String(password || '')
  if (value.length < 10) throw new AppError(CODES.VALIDATION, '口令至少 10 位')
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length
  if (classes < 3) throw new AppError(CODES.VALIDATION, '口令需包含大写字母、小写字母、数字、符号中的至少三类')
}

/* ===== P0 数据底座：日期口径、角色与日志通用口径 ===== */
const CN_OFFSET = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/* 管理端全部页面（自定义角色按此勾选，顺序即导航顺序） */
const ALL_ADMIN_PAGES = Object.freeze([
  'workbench', 'stats', 'products', 'demands', 'leads', 'consult', 'messages',
  'service', 'audit', 'behavior', 'blocked', 'rules', 'accounts', 'users', 'biz',
  'finance', 'news', 'boards', 'risk', 'logs', 'roles', 'settings', 'cs', 'promote'
])
/* 全部动作（自定义角色按此勾选；内置角色不可编辑） */
const ALL_ADMIN_ACTIONS = Object.freeze((ROLE_ACTIONS[ROLES.ADMIN] || []).slice())
/* 现阶段角色收敛为两类：管理员统管审批 / 财务 / 系统设置，客服坐席负责日常对接与工单 */
const BUILTIN_ROLES = Object.freeze([
  { roleKey: 'admin', name: '超级管理员', builtin: true, pages: ALL_ADMIN_PAGES.slice(), actions: ALL_ADMIN_ACTIONS.slice() },
  { roleKey: 'cs', name: '客服坐席', builtin: true, pages: (ROLE_PAGES[ROLES.CS] || []).slice(), actions: (ROLE_ACTIONS[ROLES.CS] || []).slice() }
])
const LOG_LEVELS = Object.freeze(['info', 'warn', 'error'])

/* 消息中心生成工单的类型：标题前缀便于客服在咨询工单列表里一眼分辨诉求 */
const LEAD_KIND_LABELS = Object.freeze({
  agency_buy: '代采咨询',
  agency_sell: '代售咨询',
  product: '商品采购',
  demand: '货源出售',
  other: '其他咨询'
})

function dayKeyOf(ms) {
  const d = new Date(Number(ms) + CN_OFFSET)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

function dateText(ms) {
  if (!ms) return ''
  const d = new Date(Number(ms) + CN_OFFSET)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/**
 * 监管页聊天正文脱敏：用户可能在直聊里直接发手机号 / 证件号，
 * 原样出站会触发出站明文校验；先遮住中间位，管理端仍能判断风险。
 */
function redactChatText(value) {
  return String(value == null ? '' : value)
    .replace(/1[3-9]\d{9}/g, (m) => m.slice(0, 3) + '****' + m.slice(-4))
    .replace(/\b\d{17}[\dXx]\b/g, (m) => m.slice(0, 4) + '**********' + m.slice(-4))
}

function createAdminHandlers(deps) {
  const { repo, keys, env } = deps
  /* 微信订阅消息推送：系统消息模板未配置时静默跳过 */
  const subscribe = deps.subscribe
  /* 云存储临时链接：本地开发 / 测试环境没有 cloud 时降级为提示 */
  const cloud = deps.cloud
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  /* 客服业务：绑定关系 / 提成比例 / 提成流水 / 评价档案 */
  const csEngine = createCsEngine({ repo, now })
  const accounts = buildAccounts(env)
  // 未知账号也走一次 scrypt，避免通过响应时间枚举账号
  const dummyHash = hashPassword('dummy-password-for-timing')

  /** 账号视图：口令哈希与 TOTP 密钥只在云端校验，任何接口都不下发 */
  function projectAccount(item, source, id) {
    return {
      id: id || item.id,
      username: item.username,
      name: item.name || item.username,
      org: item.org || '算力聚合',
      role: item.role,
      status: item.status || 'active',
      source,
      createdAt: Number(item.createdAt) || 0,
      updatedAt: Number(item.updatedAt || item.createdAt) || 0
    }
  }

  /** 数据库账号优先于环境变量引导账号：同名时以库内口令 / 状态为准 */
  async function findAccount(username) {
    const rows = await repo.find('accounts', { username }, { limit: 1 })
    const dbAccount = rows[0]
    if (dbAccount) {
      return {
        id: dbAccount.id,
        username: dbAccount.username,
        passwordHash: dbAccount.passwordHash,
        totpSecret: dbAccount.totpSecret,
        role: dbAccount.role,
        name: dbAccount.name || dbAccount.username,
        org: dbAccount.org || '算力聚合',
        status: dbAccount.status || 'active',
        source: 'db'
      }
    }
    const builtin = accounts.find((item) => item.username === username)
    if (!builtin) return null
    return Object.assign({ id: `env:${builtin.username}`, status: 'active', source: 'env' }, builtin)
  }

  async function listAllAccounts() {
    const rows = await repo.find('accounts', {}, {
      sort: { field: 'createdAt', dir: 'asc' },
      limit: 200
    })
    const list = accounts.map((item) => projectAccount(item, 'env', `env:${item.username}`))
    for (const row of rows) list.push(projectAccount(row, 'db', row.id))
    return list
  }

  /** 客服回复 / 会话里展示的坐席名 */
  function staffNameOf(account) {
    if (!account) return ''
    return account.name || account.username || ''
  }

  /**
   * 工作台待办：每次请求只做 6 次限量查询，避免待办数字把库拖慢。
   * 口径与消息中心 / 线索池 / 风险池保持一致。
   */
  async function collectTodos() {
    const [leadRows, agencyRows, contractRows, kfRows, reportRows, riskRows] = await Promise.all([
      repo.find('leads', { status: LEAD_STATUS.PENDING, targetType: 'agency' }, { limit: 1000 }),
      repo.find('agencies', { status: { $in: ['待审核', '已通过', '待确认'] }, deleted: { $ne: true } }, { limit: 1000 }),
      repo.find('agencyContracts', { status: '待审核' }, { limit: 1000 }),
      repo.find('outbox', { 'payload.channel': 'kf' }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 1000 }),
      repo.find('reports', { status: '待处理' }, { limit: 1000 }),
      repo.find('riskCases', { status: '待处理' }, { limit: 1000 })
    ])
    /* 未读会话：用户发来的客服留言且坐席未读，按 uid 去重 */
    const unreadUids = new Set()
    kfRows.forEach((msg) => {
      const p = msg.payload || {}
      if (!p.uid) return
      if (msg.readByStaff === true) return
      if ((p.from || 'user') !== 'user') return
      unreadUids.add(p.uid)
    })
    const counts = {
      leads: leadRows.length,
      agency: agencyRows.length,
      /* 管理员待审核口径：代采代售委托 + 居间合同，用于工作台弹窗与工单中心角标 */
      agencyReview: agencyRows.filter((row) => row.status === '待审核').length,
      contracts: contractRows.length,
      unread: unreadUids.size,
      reports: reportRows.length,
      risk: riskRows.length,
      /* 收款登记即入账，财务待办不再统计；保留 0 以兼容工作台 / 侧边栏的字段读取 */
      payments: 0
    }
    counts.reviewTotal = counts.agencyReview + counts.contracts
    /* 收款已改自动入账，不再计入待办；财务每周对账由财务工作台单独提醒 */
    counts.total = counts.leads + counts.agency + counts.contracts + counts.unread
      + counts.reports + counts.risk
    return counts
  }

  /** 作业记录时间窗：today 取北京时间当天 0 点，7d / 30d 取滚动窗口 */
  function periodStartOf(period, at) {
    if (period === '7d') return at - 7 * DAY_MS
    if (period === '30d') return at - 30 * DAY_MS
    return at - ((at + CN_OFFSET) % DAY_MS)
  }

  const TICKET_ACTIONS = Object.freeze([
    'lead.claim', 'lead.transfer', 'lead.status',
    'report.handle', 'risk.handle', 'agency.review', 'agency.status'
  ])
  const REVIEW_ACTIONS = Object.freeze(['product.review', 'demand.review'])

  /** 登录日志：成功 / 失败都留痕，便于系统日志页排查异地与爆破 */
  async function recordLogin(input) {
    const at = Number(input.at) || now()
    try {
      await repo.insert('loginLogs', {
        id: randomId('LG'),
        username: input.username || '',
        role: input.role || '',
        ip: input.ip || '',
        result: input.result || 'allow',
        reason: input.reason || '',
        at,
        day: dayKeyOf(at),
        createdAt: at
      })
    } catch (err) { /* 日志失败不影响登录流程 */ }
  }

  /** 账号临时权限：过期或停用即失效 */
  async function accountPermissionOf(username, at) {
    if (!username) return null
    const rows = await repo.find('accountPermissions', { username }, { limit: 1 })
    const row = rows[0]
    if (!row || row.status === 'disabled') return null
    if (Number(row.expiresAt) > 0 && Number(row.expiresAt) <= at) return null
    return row
  }

  /**
   * 角色 → 页面 / 动作：内置角色走静态表，自定义角色读 roles 集合。
   * 自定义角色被停用后不再下发任何页面，避免权限残留。
   */
  async function roleGrantsOf(roleKey) {
    const builtin = BUILTIN_ROLES.find((item) => item.roleKey === roleKey)
    if (builtin) return { pages: builtin.pages.slice(), actions: builtin.actions.slice() }
    const rows = await repo.find('roles', { roleKey }, { limit: 1 })
    const role = rows[0]
    if (!role || role.status === 'disabled') return { pages: [], actions: [] }
    return {
      pages: (role.pages || []).filter((page) => ALL_ADMIN_PAGES.includes(page)),
      actions: (role.actions || []).filter((action) => ALL_ADMIN_ACTIONS.includes(action))
    }
  }

  /**
   * 页面 / 动作白名单：登录与「权限刷新」共用一份口径。
   * 内置角色取静态表，再并上账号临时权限（到期自动失效）。
   */
  async function permissionsOf(account, at) {
    const tempPermission = await accountPermissionOf(account.username, at)
    const grants = await roleGrantsOf(account.role)
    const pages = grants.pages
    const actions = grants.actions
    if (tempPermission) {
      for (const page of tempPermission.extraPages || []) {
        if (ALL_ADMIN_PAGES.includes(page) && !pages.includes(page)) pages.push(page)
      }
      for (const action of tempPermission.extraActions || []) {
        if (ALL_ADMIN_ACTIONS.includes(action) && !actions.includes(action)) actions.push(action)
      }
    }
    /* 退出与权限刷新是所有角色必须保留的基础动作，自定义角色漏勾也不影响登录态 */
    for (const base of ['admin.logout', 'admin.session']) {
      if (!actions.includes(base)) actions.push(base)
    }
    return {
      pages,
      actions,
      tempPermission: tempPermission ? {
        extraPages: tempPermission.extraPages || [],
        extraActions: tempPermission.extraActions || [],
        expiresAt: Number(tempPermission.expiresAt) || 0
      } : null
    }
  }

  /** 可分配坐席：启用中的客服与管理员（环境引导账号 + 账号管理里新增的账号） */
  async function listStaff() {
    const all = await listAllAccounts()
    return all
      .filter((item) => item.status === 'active')
      .filter((item) => item.role === ROLES.CS || item.role === ROLES.ADMIN)
      .map((item) => ({
        id: item.id,
        username: item.username,
        name: staffNameOf(item),
        role: item.role,
        roleName: item.role === ROLES.ADMIN ? '管理员' : '客服坐席',
        org: item.org,
        source: item.source
      }))
  }

  /** 坐席校验：分配 / 转派必须落到真实且启用中的账号，不能凭空写一个名字 */
  async function resolveStaff(identifier) {
    const raw = String(identifier == null ? '' : identifier).trim()
    const key = raw.toLowerCase()
    const staff = await listStaff()
    const hit = staff.find((item) => item.username === key) || staff.find((item) => item.name === raw)
    if (!hit) throw new AppError(CODES.VALIDATION, '坐席不存在或已停用，请从坐席列表中选择')
    return hit
  }

  /**
   * 同一委托统一由一个客服跟进：客服领取某条代采代售咨询后，
   * 把同一委托下其他还没人领取的工单一起归到该客服名下，
   * 避免同一商品被多个客服分别对接、用户看到不同口径。
   * options.force 为真时连别人名下的工单一起转过来（由管理员显式转派时使用）。
   */
  async function adoptAgencySiblings(lead, staff, at, options) {
    const o = options || {}
    if (!lead || lead.targetType !== 'agency') return 0
    const agencyId = String(lead.agencyId || lead.targetId || '')
    if (!agencyId) return 0
    const rows = await repo.find('leads', { targetType: 'agency', agencyId }, { limit: 500 })
    let count = 0
    for (const row of rows) {
      if (!row || row.id === lead.id) continue
      if ([LEAD_STATUS.CLOSED, LEAD_STATUS.BLOCKED, LEAD_STATUS.DEALT].indexOf(row.status) >= 0) continue
      if (ticketStateOf(row) === TICKET_STATE.INVALID) continue
      if (row.assignedAccount === staff.username) continue
      if (row.assignedAccount && !o.force) continue
      const patch = {
        assignedTo: staff.name,
        assignedAccount: staff.username,
        assignedAt: at,
        csId: staff.username,
        csName: staff.name,
        csStatus: CS_STATUS.SERVING,
        updatedAt: at
      }
      if (!row.csClaimedAt) patch.csClaimedAt = at
      if (!row.threadId) patch.threadId = row.id
      const res = await repo.updateWhere('leads', { id: row.id }, patch)
      if (!res || !res.count) continue
      count += 1
      /* 会话里补接入提示：该用户换客服时也能看到「本委托由同一客服统一对接」 */
      await repo.insert('outbox', {
        id: 'M' + sha256Hex('cs-adopt:' + row.id).slice(0, 22),
        type: 'kf.chat',
        payload: {
          uid: row.uid,
          channel: 'kf',
          from: 'system',
          staffName: staff.name,
          threadId: row.threadId || row.id,
          targetType: 'agency',
          targetId: agencyId,
          title: row.agencyTitle || '',
          body: `客服 ${staff.name} 已接入，本委托由同一客服统一对接`,
          csStatus: CS_STATUS.SERVING
        },
        status: 'pending',
        createdAt: at
      })
    }
    return count
  }

  /** 审计 target 形如「线索 id」或「线索 id:原状态->新状态」，取出线索 id 便于按工单回溯 */
  function leadIdOfTarget(target) {
    const text = String(target == null ? '' : target)
    const index = text.indexOf(':')
    return index > 0 ? text.slice(0, index) : text
  }

  /** 账号名 → 展示名（projectAudit 会把 actorId 打码，操作人需另行回填） */
  async function staffNameMap() {
    const map = new Map()
    for (const item of await listStaff()) {
      if (item.username) map.set(item.username, item.name)
    }
    return map
  }

  function resultLabelOf(result) {
    return AUDIT_RESULT_LABELS[result] || (result === 'allow' ? '成功' : '已拦截')
  }

  /* ============================================================
     筛选规则：条件归一化与中文说明
     规则页展示的说明与判档引擎读取的是同一份 cond，避免「页面写一套、引擎算一套」
     ============================================================ */
  function maskPhone(phone) {
    return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
  }

  /* ============================================================
     发布用户摘要：咨询单 / 商品 / 需求 / 代采代售四个模块的工单详情共用。
     userNo 与用户端「我的」页展示同一串，客服可据此检索与开权限；
     手机号只给掩码，主体 / 昵称按敏感文本打码，明文一律不出站。
     ============================================================ */
  function buildStaffUser(user, profile) {
    const p = profile || {}
    const uid = (user && user.id) || p.uid || ''
    let subject = ''
    if (p.subjectCipher) {
      try {
        subject = decryptFieldOf({
          keys, collection: 'profiles', field: 'subject', recordId: p.uid || p.id || uid, cipher: p.subjectCipher
        }) || ''
      } catch (err) { subject = '' }
    }
    let phone = ''
    if (user && user.phoneCipher) {
      try {
        phone = decryptField({ keys, token: user.phoneCipher, aad: phoneAad(uid) }) || ''
      } catch (err) { phone = '' }
    }
    const quals = Array.isArray(p.quals) ? p.quals : []
    const hasLicense = quals.some((row) => {
      const item = row && typeof row === 'object' ? row : { name: String(row || '') }
      return item.kind === 'license' || String(item.name || '').indexOf('营业执照') >= 0
    })
    const exposure = p.exposure || EXPOSURES.HIDDEN
    return {
      id: uid,
      userNo: userNoOf(uid),
      nick: maskSensitiveText((user && user.nick) || ''),
      subjectType: p.subjectType || '',
      subject: maskSensitiveText(subject),
      city: p.city || '',
      exposure,
      exposureLabel: EXPOSURE_LABELS[exposure] || EXPOSURE_LABELS.hidden,
      subjectHidden: exposure === EXPOSURES.HIDDEN,
      hasLicense,
      phoneMasked: phone ? maskPhone(phone) : '',
      phoneSaved: !!(user && user.phoneCipher),
      status: (user && user.status) || '',
      joined: p.joined || '',
      /* 以下四项仅单用户查询时补齐，列表场景留空，避免逐条聚合 */
      memberStatus: '',
      publishCount: 0,
      agencyBuy: 0,
      agencySell: 0,
      missing: !user
    }
  }

  /**
   * 批量取发布用户摘要（列表用）。opts.withActivity 时补齐会员状态与发布 / 委托数量。
   */
  async function staffUserMap(ownerIds, opts) {
    const ids = Array.from(new Set((ownerIds || []).filter(Boolean)))
    const map = new Map()
    if (!ids.length) return map
    const withActivity = !!(opts && opts.withActivity)
    const nowMs = now()
    const [users, profiles, accesses] = await Promise.all([
      repo.find('users', { id: { $in: ids } }, { limit: ids.length }),
      repo.find('profiles', { uid: { $in: ids } }, { limit: ids.length }),
      withActivity ? repo.find('bizAccess', { id: { $in: ids } }, { limit: ids.length }) : []
    ])
    const profileOf = new Map(profiles.map((row) => [row.uid || row.id, row]))
    const accessOf = new Map(accesses.map((row) => [row.id, row]))
    const [products, demands, agencies] = withActivity
      ? await Promise.all([
        repo.find('products', { ownerId: { $in: ids } }, { limit: 500 }),
        repo.find('demands', { ownerId: { $in: ids } }, { limit: 500 }),
        repo.find('agencies', { ownerId: { $in: ids }, deleted: { $ne: true } }, { limit: 500 })
      ])
      : [[], [], []]
    const countBy = (rows, uid, test) => rows.filter((row) => row.ownerId === uid && (!test || test(row))).length
    for (const uid of ids) {
      const user = users.find((row) => row.id === uid)
      const summary = buildStaffUser(user, profileOf.get(uid))
      if (withActivity) {
        const access = accessOf.get(uid)
        const expireAt = Number(access && access.expireAt) || 0
        summary.memberStatus = !access ? ''
          : access.status === '已停用' ? '已停用'
            : access.status === '待确认' ? '待确认'
              : access.status === '已开通' && expireAt > nowMs ? '已开通' : '已到期'
        summary.publishCount = countBy(products, uid) + countBy(demands, uid)
        summary.agencyBuy = countBy(agencies, uid, (row) => (row.side || 'buy') === 'buy')
        summary.agencySell = countBy(agencies, uid, (row) => row.side === 'sell')
      }
      map.set(uid, summary)
    }
    return map
  }

  function condTextOf(cond) {
    const c = cond || {}
    const parts = []
    const words = c.blockedWords || c.keyword || c.action
    if (Array.isArray(c.blockedPhones) && c.blockedPhones.length) {
      parts.push(`黑名单手机号 ${c.blockedPhones.length} 个：${c.blockedPhones.join('、')}`)
    } else if (Array.isArray(c.blockedPhoneBidx) && c.blockedPhoneBidx.length) {
      parts.push(`黑名单手机号 ${c.blockedPhoneBidx.length} 个`)
    }
    if (Array.isArray(words) && words.length) parts.push(`敏感词：${words.join('、')}`)
    if (c.maxPerDay) parts.push(`同一账号 24 小时内咨询超过 ${c.maxPerDay} 次`)
    if (c.requireMaterials) parts.push(`有效资质材料少于 ${c.requireMaterials} 份`)
    if (c.crossCategory) parts.push(`跨品类超过 ${c.crossCategory} 个`)
    if (c.phoneInvalid) parts.push('手机号格式不合法')
    if (c.minBudget) parts.push(`预算达到 ${c.minBudget} 元及以上`)
    if (c.cat) parts.push(`仅对「${c.cat}」生效`)
    return parts.length ? parts.join('；') : '未配置具体条件'
  }

  function scopeTextOf(rule) {
    if (rule.scope === 'category' && rule.scopeKey) return `品类：${rule.scopeKey}`
    if (rule.scope === 'product' && rule.scopeKey) return `商品：${rule.scopeKey}`
    return '全平台'
  }

  /** 下发前剔除盲索引：打码号码够前端展示，盲索引不出管理端 */
  function sanitizeRuleCond(cond) {
    const out = Object.assign({}, cond || {})
    delete out.blockedPhoneBidx
    return out
  }

  function intOf(raw, field, min, max) {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new AppError(CODES.VALIDATION, `${field}需为 ${min} - ${max} 的整数`)
    }
    return n
  }

  /** 表单值 → 规则条件；新增规则类型只需在这里补一个分支 */
  function buildRuleCond(type, value) {
    const raw = value == null ? '' : value
    if (type === 'phone') {
      const list = String(raw).split(/[\s,，;；、]+/).map((s) => s.trim()).filter(Boolean)
      if (!list.length) throw new AppError(CODES.VALIDATION, '请填写至少一个黑名单手机号')
      const unique = []
      const bidx = []
      for (const phone of list) {
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          throw new AppError(CODES.VALIDATION, `手机号格式不合法：${phone}`)
        }
        if (unique.indexOf(phone) >= 0) continue
        unique.push(phone)
        /* 只落盲索引与打码号码，规则表不保存明文手机号 */
        bidx.push(blindIndex({ keys, value: phone }))
      }
      if (unique.length > 100) throw new AppError(CODES.VALIDATION, '单条规则最多维护 100 个手机号')
      return { blockedPhoneBidx: bidx, blockedPhones: unique.map(maskPhone) }
    }
    if (type === 'word') {
      const list = String(raw).split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean)
      const unique = list.filter((w, i) => w && list.indexOf(w) === i)
      if (!unique.length) throw new AppError(CODES.VALIDATION, '请填写至少一个敏感词')
      if (unique.length > 30) throw new AppError(CODES.VALIDATION, '单条规则最多 30 个敏感词')
      if (unique.some((w) => w.length > 20)) throw new AppError(CODES.VALIDATION, '单个敏感词不超过 20 个字')
      return { blockedWords: unique }
    }
    if (type === 'repeat') return { maxPerDay: intOf(raw, '咨询次数上限', 1, 100) }
    if (type === 'materials') return { requireMaterials: intOf(raw, '材料份数', 0, 20) }
    if (type === 'cross') return { crossCategory: intOf(raw, '品类数量', 1, 50) }
    if (type === 'budget') return { minBudget: intOf(raw, '预算门槛', 1, 100000000) }
    if (type === 'category') {
      const cat = str(raw, { field: '品类', required: true, max: 30 })
      return { cat }
    }
    throw new AppError(CODES.VALIDATION, '规则类型不支持')
  }

  function normalizeRuleInput(data, base) {
    const name = str(data.name, { field: '规则名称', required: true, max: 40 })
    const type = str(data.type, { field: '规则类型', required: true, max: 20 })
    if (!RULE_TYPES[type]) throw new AppError(CODES.VALIDATION, '规则类型不支持')
    const tier = data.tier ? str(data.tier, { field: '档位', max: 10 }) : (base ? base.tier : TIERS.P2)
    if ([TIERS.P0, TIERS.P1, TIERS.P2, TIERS.DEFAULT].indexOf(tier) < 0) {
      throw new AppError(CODES.VALIDATION, '档位只能是 P0 / P1 / P2 / 默认')
    }
    const scope = data.scope ? str(data.scope, { field: '作用范围', max: 20 }) : 'global'
    if (['global', 'category', 'product'].indexOf(scope) < 0) {
      throw new AppError(CODES.VALIDATION, '作用范围不合法')
    }
    let scopeKey = data.scopeKey ? str(data.scopeKey, { field: '范围对象', max: 60 }) : ''
    if (scope !== 'global' && !scopeKey) throw new AppError(CODES.VALIDATION, '选择品类 / 商品范围时必须填写范围对象')
    /* 未填条件值时沿用原条件；类型变了就不能沿用，必须重新按新类型解析 */
    const reuseCond = data.value === undefined && base && base.type === type
    const cond = reuseCond ? base.cond : buildRuleCond(type, data.value)
    /* 品类范围与品类条件保持同一口径：范围选了品类就同步到判档条件 */
    if (scope === 'category') {
      scopeKey = scopeKey || cond.cat || ''
      cond.cat = scopeKey
    }
    return { name, type, tier, scope, scopeKey, cond, note: str(data.note || '', { field: '备注', max: 100 }) }
  }

  /** 下架 / 退回等需要通知用户的场景：写一条系统站内信，用户在「消息」里能看到 */
  async function notifyUser(uid, { title, body, targetType, targetId, reason, leadId }) {
    if (!uid) return
    await repo.insert('outbox', {
      id: randomId('M'),
      type: 'system.notice',
      payload: {
        uid,
        channel: 'system',
        from: 'system',
        title,
        body,
        reason: reason || '',
        targetType: targetType || '',
        targetId: targetId || '',
        leadId: leadId || ''
      },
      status: 'pending',
      createdAt: now()
    })
    /* 站内信写入后同步推微信订阅消息：系统类走 system 模板，商机类走 biz 模板 */
    if (subscribe) {
      const push = targetType === 'biz' ? subscribe.biz : subscribe.system
      await push(uid, { title, body, at: now() }).catch(() => {})
    }
  }

  function phoneAad(uid) {
    return `users.phoneCipher.${uid}`
  }

  /**
   * 发布时填写的补充手机号：解密后只下发脱敏号给坐席，明文不出服务端。
   * AAD 与用户档案的手机号一致（users.phoneCipher.<uid>），密钥轮换异常时返回空串。
   */
  function ownerPhoneMaskedOf(doc) {
    if (!doc || !doc.ownerPhoneCipher || !doc.ownerId) return ''
    try {
      return maskPhone(decryptField({
        keys,
        token: doc.ownerPhoneCipher,
        aad: phoneAad(doc.ownerId)
      }))
    } catch (err) {
      return ''
    }
  }

  /**
   * 动作级权限判定（与 router 的口径一致）：内置角色白名单 + 自定义角色 + 账号临时权限。
   * 用于「一个动作隐含另一动作」的场景，例如处置举报时联动下架内容。
   */
  async function staffCan(session, action) {
    if (!session) return false
    if (can(session.role, action)) return true
    const roleRows = await repo.find('roles', { roleKey: session.role }, { limit: 1 })
    const customRole = roleRows[0]
    if (customRole && customRole.status !== 'disabled' && (customRole.actions || []).includes(action)) return true
    const permRows = await repo.find('accountPermissions', { username: session.accountId }, { limit: 1 })
    const permission = permRows[0]
    if (!permission || permission.status === 'disabled') return false
    if (Number(permission.expiresAt) > 0 && Number(permission.expiresAt) <= Date.now()) return false
    return (permission.extraActions || []).includes(action)
  }

  /**
   * 留言名片补全：名片里只落了掩码，管理端需要按发送人档案解密明文核对身份。
   * 只回名片展示所需字段，避免把档案里的其它敏感字段一并带出站。
   */
  async function resolveChatCard(card, ownerUid) {
    const c = card && typeof card === 'object' ? card : {}
    const uid = String(c.uid || ownerUid || '')
    const out = {
      uid,
      name: c.name || '',
      avatar: c.avatar || '',
      subject: c.subject || '',
      subjectType: c.subjectType || '',
      subjectKind: c.subjectKind || '',
      contact: c.contact || '',
      realname: c.realname || '',
      position: c.position || '',
      phone: c.phone || '',
      verified: c.verified === true
    }
    if (!uid) return out
    const [user, profile] = await Promise.all([
      repo.get('users', uid),
      repo.find('profiles', { uid }, { limit: 1 }).then((rows) => rows[0] || {})
    ])
    if (user) {
      if (!out.name && user.nick) out.name = user.nick
      if (user.realnameCipher || user.realname) {
        try {
          out.realname = user.realnameCipher
            ? decryptFieldOf({ keys, collection: 'users', field: 'realname', recordId: user.id, cipher: user.realnameCipher })
            : String(user.realname || '')
        } catch (err) { /* 解密失败时保留名片原值 */ }
      }
      if (user.phoneCipher) {
        try {
          out.phone = decryptField({ keys, token: user.phoneCipher, aad: phoneAad(uid) }) || out.phone
        } catch (err) { /* 解密失败时保留名片原值 */ }
      }
    }
    if (profile) {
      const decryptProfile = (field) => {
        const cipher = profile[`${field}Cipher`]
        if (cipher) {
          try {
            return decryptFieldOf({
              keys, collection: 'profiles', field, recordId: profile.uid || profile.id || uid, cipher
            }) || ''
          } catch (err) { return '' }
        }
        return String(profile[field] || '')
      }
      out.subject = decryptProfile('subject') || out.subject
      out.contact = decryptProfile('contact') || out.contact
      out.position = decryptProfile('position') || out.position
      out.subjectType = profile.subjectType || out.subjectType
      out.subjectKind = profile.subjectKind || out.subjectKind
    }
    if (out.realname) out.verified = true
    if (!out.avatar) out.avatar = String(out.name || '名').slice(0, 1)
    return out
  }

  async function loadLead(leadId) {
    const lead = await repo.get('leads', leadId)
    if (!lead) throw new AppError(CODES.NOT_FOUND, '线索不存在')
    return lead
  }

  async function targetTitle(lead) {
    if (lead.productId) {
      const product = await repo.get('products', lead.productId)
      if (product) return { type: 'product', title: product.title, id: product.id }
    }
    if (lead.demandId) {
      const demand = await repo.get('demands', lead.demandId)
      if (demand) return { type: 'demand', title: demand.title, id: demand.id }
    }
    /* 代采 / 代售平台对接工单：关联对象是委托，不是商品或需求 */
    if (lead.targetType === 'agency' || lead.agencyId) {
      const agencyId = lead.agencyId || lead.targetId
      const agency = agencyId ? await repo.get('agencies', agencyId) : null
      if (agency) {
        return {
          type: 'agency',
          title: `${agency.kind || (agency.side === 'buy' ? '代采' : '代售')} ${agency.item || ''}`.trim(),
          id: agency.id
        }
      }
      return { type: 'agency', title: lead.agencyTitle || '代采 / 代售委托', id: lead.targetId || '' }
    }
    return { type: '', title: '', id: '' }
  }

  /**
   * 代采 / 代售资料齐全度。
   * 大额委托（1000 万元及以上）由平台核验后对接，对接顺序只看资料与主体信息是否齐全，
   * 不再依赖用户手动标记「优先对接」。返回 0-100 分与缺失项，供管理端排序与提示。
   */
  function agencyCompleteness(agency) {
    const a = agency || {}
    const media = Array.isArray(a.media) ? a.media : []
    const checks = [
      { label: '主体名称', ok: !!String(a.subjectMasked || '').trim() },
      { label: '主体类型', ok: !!String(a.subjectType || '').trim() },
      { label: '联系电话', ok: !!String(a.phoneMasked || '').trim() },
      { label: '联系人 / 法人', ok: !!String(a.legalMasked || '').trim() },
      { label: '营业执照 / 身份证', ok: !!String(a.creditMasked || '').trim() || !!String(a.idCardMasked || '').trim() },
      { label: '委托材料（意向函 / 授权书等）', ok: media.length >= 2 },
      { label: '数量与金额', ok: Number(a.qty) > 0 && Number(a.amount) > 0 }
    ]
    const missing = checks.filter((item) => !item.ok).map((item) => item.label)
    const filled = checks.length - missing.length
    return {
      score: Math.round((filled / checks.length) * 100),
      filled,
      total: checks.length,
      missing,
      complete: missing.length === 0,
      text: missing.length ? `资料齐全度 ${Math.round((filled / checks.length) * 100)}%（缺 ${missing.length} 项）` : '资料齐全'
    }
  }

  /** 对比项命中率：普通咨询没有委托材料时，用表单对比结果衡量「资料齐全度」 */
  function compareScoreOf(rows) {
    const list = Array.isArray(rows) ? rows : []
    if (!list.length) return null
    const filled = list.filter((row) => row && row.res && !/不|缺|待核/.test(String(row.res))).length
    return Math.round((filled / list.length) * 100)
  }

  /**
   * 咨询双方的联系方式名片：默认只回掩码。
   * 客服确实要打电话 / 加微信时走 consult.reveal，每次查看都落审计。
   */
  async function consultMaskedCard(uid, role) {
    if (!uid) return { uid: '', role, userNo: '', name: '', subject: '', contact: '', phone: '' }
    const card = await resolveChatCard({ uid }, uid)
    return {
      uid,
      role,
      userNo: userNoOf(uid),
      name: card.name || '',
      subject: card.subject || '',
      subjectType: card.subjectType || '',
      subjectKind: card.subjectKind || '',
      realname: card.realname ? maskSensitiveText(card.realname) : '',
      position: card.position || '',
      contact: card.contact ? maskSensitiveText(card.contact) : '',
      phone: card.phone ? maskPhone(card.phone) : '',
      verified: card.verified === true,
      masked: true
    }
  }

  /** 委托内容（客服侧）：只回展示与核验需要的字段，不带宽表内部字段 */
  function consultAgencyView(agency) {
    const a = agency || {}
    return {
      id: a.id || '',
      side: a.side || '',
      kind: a.kind || (a.side === 'buy' ? '代采' : '代售'),
      item: a.item || '',
      cat: a.cat || '',
      brand: a.brand || '',
      model: a.model || '',
      series: a.series || '',
      qty: Number(a.qty) || 0,
      price: Number(a.price) || 0,
      amount: Number(a.amount) || 0,
      currency: a.currency || '',
      city: a.city || '',
      tradeMode: a.tradeMode || '',
      rental: a.rental || '',
      cond: a.cond || '',
      deadline: a.deadline || '',
      deadlineAt: Number(a.deadlineAt) || 0,
      must: Array.isArray(a.must) ? a.must : [],
      nego: a.nego === true,
      note: a.note || '',
      status: a.status || '',
      ownerId: a.ownerId || '',
      subjectMasked: a.subjectMasked || '',
      subjectType: a.subjectType || '',
      phoneMasked: a.phoneMasked || '',
      legalMasked: a.legalMasked || '',
      creditMasked: a.creditMasked || '',
      idCardMasked: a.idCardMasked || '',
      media: mediaMeta(a.media),
      feeStatus: a.feeStatus || 'unbilled',
      serviceFee: Number(a.serviceFee) || 0,
      feeBillId: a.feeBillId || '',
      feePaidAt: Number(a.feePaidAt) || 0,
      claimUid: a.claimUid || '',
      claimAt: Number(a.claimAt) || 0,
      largeAmount: a.largeAmount === true
    }
  }

  /** 居间合同视图：驳回重传按版本叠加，同一 leadId 始终只有一行 */
  function consultContractView(row) {
    if (!row) return null
    return {
      id: row.id || '',
      leadId: row.leadId || '',
      version: Number(row.version) || 1,
      status: row.status || '',
      fileId: row.fileId || '',
      fileName: row.fileName || '',
      fileSize: Number(row.fileSize) || 0,
      signDate: row.signDate || '',
      note: row.note || '',
      submittedBy: row.submittedBy || '',
      submittedByName: row.submittedByName || '',
      submittedAt: Number(row.submittedAt) || 0,
      reviewedBy: row.reviewedBy || '',
      reviewedByName: row.reviewedByName || '',
      reviewedAt: Number(row.reviewedAt) || 0,
      reviewNote: row.reviewNote || ''
    }
  }

  /** 服务费账单视图：线下打款 + 上传凭证 + 财务确认 */
  function consultPaymentView(row) {
    if (!row) return null
    return {
      id: row.id || '',
      status: row.status || '',
      amount: Number(row.amount) || 0,
      received: Number(row.received) || 0,
      method: row.method || '',
      dueAt: Number(row.dueAt) || 0,
      paidAt: Number(row.paidAt) || 0,
      confirmedAt: Number(row.confirmedAt) || 0,
      confirmedBy: row.confirmedBy || '',
      proofFileId: row.proofFileId || '',
      proofFileName: row.proofFileName || '',
      proofFiles: (Array.isArray(row.proofFiles) ? row.proofFiles : (row.proofFileId ? [row.proofFileId] : [])).slice(),
      proofNote: row.proofNote || '',
      proofAt: Number(row.proofAt) || 0
    }
  }

  /** 当前阶段可执行的动作：前端按此渲染按钮，避免点了才报错 */
  /* 消息中心生成的工单没有平台委托，成交确认与凭证上传按钮隐藏，避免调用 agency 接口报错 */
  function consultActionsOf(stage, hasAgency, chatStarted) {
    const linked = hasAgency !== false
    /* 新领取的工单先对话：会话里双方都说过话之后才允许确认满足条件 */
    const chatted = chatStarted !== false
    return {
      canTerms: stage === CONSULT_STAGE.COMMUNICATING && chatted,
      canContract: stage === CONSULT_STAGE.TERMS || stage === CONSULT_STAGE.CONTRACT,
      /* 合同归档后即可登记成交；历史停在「待确认成交」的工单也可由客服补确认 */
      canProposeDeal: (stage === CONSULT_STAGE.SIGNED || stage === CONSULT_STAGE.DEAL_PENDING) && linked,
      canUploadProof: stage === CONSULT_STAGE.FEE && linked,
      canComplete: stage === CONSULT_STAGE.PAID,
      canAbort: stage !== CONSULT_STAGE.DONE && stage !== CONSULT_STAGE.ABORTED
    }
  }

  /**
   * 工单是否已经真正对话：领取后客服与用户各自至少发过一条消息。
   * 领取时写入的咨询内容是用户提交前的留言，不算对话；
   * 因此新工单只有「领取」动作，聊过之后才出现「确认满足条件」。
   */
  async function consultChatStartedOf(lead) {
    const threadId = String((lead && (lead.threadId || lead.id)) || '')
    if (!threadId) return false
    const since = Number((lead && (lead.csClaimedAt || lead.assignedAt)) || 0)
    let user = false
    let staff = false
    try {
      const rows = await repo.find('outbox', { 'payload.threadId': threadId }, { limit: 200 })
      for (const row of rows) {
        const payload = (row && row.payload) || {}
        const at = Number(row && row.createdAt) || 0
        if (since && at <= since) continue
        if (payload.from === 'staff') staff = true
        else if (payload.from === 'user') user = true
        if (staff && user) return true
      }
    } catch (err) {
      /* 会话读取失败不阻塞工单详情，按「还没开始对话」处理 */
      return false
    }
    return false
  }

  /** 流程推进权限：领取该咨询的客服本人或管理员 */
  function consultOperator(lead, ctx) {
    const session = ctx && ctx.session
    const accountId = (session && session.accountId) || ''
    if (isAdminSession(session)) return accountId || 'admin'
    if (!accountId || lead.assignedAccount !== accountId) {
      throw new AppError(
        CODES.FORBIDDEN,
        lead.assignedAccount ? '只有领取该咨询的客服可以推进流程' : '该工单待领取，请先领取后再处理'
      )
    }
    return accountId
  }

  /** 客服姓名：账号表查不到时退回工单上的领取人 */
  async function consultOperatorName(accountId, lead) {
    try {
      const staff = await resolveStaff(accountId)
      return staff.name || accountId
    } catch (err) {
      return (lead && (lead.csName || lead.assignedTo)) || accountId
    }
  }

  /** 工单「左对话右信息」的右栏数据：委托内容 + 双方名片 + 合同 + 账单 + 阶段时间线 */
  async function consultDetailOf(lead) {
    const stage = consultStageOf(lead)
    const agencyId = lead.agencyId || lead.targetId || ''
    const agency = agencyId ? await repo.get('agencies', agencyId) : null
    const [contracts, consultCard, ownerCard, chatStarted] = await Promise.all([
      repo.find('agencyContracts', { leadId: lead.id }, { sort: { field: 'version', dir: 'desc' }, limit: 20 }),
      consultMaskedCard(lead.uid, '对接方'),
      consultMaskedCard(agency && agency.ownerId, '委托方'),
      consultChatStartedOf(lead)
    ])
    const billId = (agency && agency.feeBillId) || (agency ? `PY_AG_${agency.id}` : '')
    const bill = billId ? await repo.get('payments', billId) : null
    /* 咨询方名片优先展示本次咨询填写的联系电话，而不是档案里可能已更换的号码 */
    const consultParty = consultCard
      ? Object.assign({}, consultCard, { phone: lead.contactPhoneMasked || consultCard.phone })
      : consultCard
    return {
      lead: await staffLeadView(lead),
      stage,
      stageLabel: consultStageLabel(stage),
      stageHistory: Array.isArray(lead.stageHistory) ? lead.stageHistory : [],
      terms: lead.terms || null,
      dealAmount: Number(lead.dealAmount) || 0,
      completedAt: Number(lead.completedAt) || 0,
      abortReason: lead.abortReason || '',
      agency: agency ? consultAgencyView(agency) : null,
      parties: { consult: consultParty, owner: ownerCard },
      contract: consultContractView(contracts[0]),
      contracts: contracts.map(consultContractView),
      payment: consultPaymentView(bill),
      /* 会话是否已经发生：false 时新工单只显示「领取 / 继续对话」，不出现条件确认按钮 */
      chatStarted,
      actions: consultActionsOf(stage, !!agency, chatStarted)
    }
  }

  /** 管理端线索视图：关联对象 + 代采 / 代售资料齐全度（用于平台对接排序） */
  async function staffLeadView(lead) {
    const target = await targetTitle(lead)
    const view = Object.assign(projectLeadForStaff(lead), {
      targetType: target.type,
      targetTitle: target.title,
      /* 列表 / 详情统一展示「谁向谁发起」：咨询方 uid 与委托发布方 uid */
      consultUid: lead.uid || '',
      publisherUid: '',
      sideLabel: '',
      /* 代采代售咨询的客服服务状态、领取人、结束时间与用户评价 */
      isCsConsult: target.type === 'agency',
      csStatus: target.type === 'agency' ? csStatusOf(lead) : '',
      csName: lead.csName || lead.assignedTo || '',
      csId: lead.csId || lead.assignedAccount || '',
      csClaimedAt: Number(lead.csClaimedAt || lead.assignedAt) || 0,
      csEndedAt: Number(lead.csEndedAt) || 0,
      threadId: lead.threadId || lead.id || '',
      /* 咨询单状态：ticketed 已生成工单（未领取时展示「待领取」）/ intake 历史待领取 / invalid 无效 */
      ticketState: target.type === 'agency' ? ticketStateOf(lead) : '',
      ticketStateLabel: target.type === 'agency'
        ? (ticketStateOf(lead) === TICKET_STATE.TICKETED && !lead.assignedAccount
          ? '待领取'
          : (TICKET_STATE_LABELS[ticketStateOf(lead)] || ''))
        : '',
      rating: Number(lead.rating) || 0,
      ratingTags: Array.isArray(lead.ratingTags) ? lead.ratingTags : [],
      ratingText: lead.ratingText || '',
      ratedAt: Number(lead.ratedAt) || 0,
      /* 标准流程阶段：只有已生成工单的咨询才有阶段，磋商中仍显示「磋商中」 */
      serviceStage: target.type === 'agency' && ticketStateOf(lead) === TICKET_STATE.TICKETED ? consultStageOf(lead) : '',
      serviceStageLabel: target.type === 'agency' && ticketStateOf(lead) === TICKET_STATE.TICKETED ? consultStageLabel(consultStageOf(lead)) : '',
      stageAt: Number(lead.stageAt) || 0,
      dealAmount: Number(lead.dealAmount) || 0,
      contractId: lead.contractId || ''
    })
    if (target.type === 'agency') {
      view.stageHistory = Array.isArray(lead.stageHistory) ? lead.stageHistory : []
      view.abortReason = lead.abortReason || ''
      view.completedAt = Number(lead.completedAt) || 0
    }
    view.compareScore = compareScoreOf(lead.compare)
    if (target.type === 'agency') {
      const agency = target.id ? await repo.get('agencies', target.id) : null
      const comp = agencyCompleteness(agency)
      return Object.assign(view, {
        agencyId: target.id || '',
        publisherUid: (agency && agency.ownerId) || '',
        sideLabel: agency && agency.side === 'sell' ? '代售' : '代采',
        largeAmount: !!(agency && agency.largeAmount),
        materialVerified: !!(agency && agency.materialVerified),
        completeness: comp.score,
        completenessText: comp.text,
        complete: comp.complete,
        missingMaterials: comp.missing,
        amount: Number(agency && agency.amount) || 0,
        /* 服务费账单：成交后生成，客服上传凭证、财务确认到账 */
        feeStatus: (agency && agency.feeStatus) || 'unbilled',
        serviceFee: Number(agency && agency.serviceFee) || 0,
        feeBillId: (agency && agency.feeBillId) || '',
        feePaidAt: Number(agency && agency.feePaidAt) || 0,
        agencyStatus: (agency && agency.status) || '',
        /* 主体资质：已核验满分；主体与证照都填了给 70；否则 35 */
        subjectScore: agency && agency.materialVerified ? 100
          : agency && agency.subjectMasked && agency.creditMasked ? 70 : 35
      })
    }
    if (target.type === 'product' && target.id) {
      const product = await repo.get('products', target.id)
      if (product) {
        view.publisherUid = product.ownerId || ''
        view.sideLabel = '商品'
        view.amount = (Number(product.price) || 0) * (Number(product.minQty) || 1)
        view.subjectScore = (product.must || []).indexOf('强主体（国企 / 央企）') >= 0 ? 90 : 60
      }
    } else if (target.type === 'demand' && target.id) {
      const demand = await repo.get('demands', target.id)
      if (demand) {
        view.publisherUid = demand.ownerId || ''
        view.sideLabel = '需求'
        view.amount = (Number(demand.budget) || 0) * (Number(demand.qty) || 1)
        view.subjectScore = (demand.must || []).indexOf('强主体（国企 / 央企）') >= 0 ? 90 : 60
      }
    }
    return view
  }

  /* ============================================================
     咨询单审批优先级（排序规则）
     权重与门槛存 settings 集合，管理端「排序规则设置」可在线调整；
     列表排序与页面说明读取同一份配置，避免「页面一套、排序一套」。
     ============================================================ */
  const SORT_FACTORS = Object.freeze([
    { key: 'completeness', label: '资料齐全度', hint: '代采 / 代售看材料与主体信息完整度；普通咨询看对比项命中率' },
    { key: 'amount', label: '金额规模', hint: '委托金额或商品 / 需求预估金额，达到门槛记满分' },
    { key: 'subject', label: '主体资质', hint: '主体信息、证照与强主体要求' },
    { key: 'waiting', label: '等待时长', hint: '提交越久得分越高，避免老工单沉底' }
  ])

  const DEFAULT_SORT_RULES = Object.freeze({
    enabled: true,
    weights: { completeness: 40, amount: 25, subject: 20, waiting: 15 },
    amountThreshold: 10000000,
    largeCompletenessFirst: true
  })

  function normalizeSortRules(row) {
    const raw = row || {}
    const weights = {}
    SORT_FACTORS.forEach((factor) => {
      const value = Number(raw.weights && raw.weights[factor.key])
      weights[factor.key] = Number.isInteger(value) && value >= 0 && value <= 100
        ? value
        : DEFAULT_SORT_RULES.weights[factor.key]
    })
    const threshold = Number(raw.amountThreshold)
    return {
      enabled: raw.enabled !== false,
      weights,
      amountThreshold: Number.isFinite(threshold) && threshold > 0
        ? Math.round(threshold)
        : DEFAULT_SORT_RULES.amountThreshold,
      /* 大额委托（≥ 门槛）之间只按资料齐全度排，落实「千万以上只看资料是否齐全」 */
      largeCompletenessFirst: raw.largeCompletenessFirst !== false,
      updatedAt: Number(raw.updatedAt) || 0,
      updatedBy: raw.updatedBy || ''
    }
  }

  async function loadSortRules() {
    const row = await repo.get('settings', 'lead_sort_rules')
    return normalizeSortRules(row)
  }

  /** 单条咨询单的优先级拆解：0-100 分，权重加权后四舍五入 */
  function priorityOf(view, rules) {
    const weight = rules.weights || {}
    const completeness = view.completeness != null
      ? view.completeness
      : (view.compareScore != null ? view.compareScore : (Number(view.matchPct) || 0))
    const amount = Number(view.amount) || 0
    const amountValue = rules.amountThreshold > 0
      ? Math.min(100, Math.round((amount / rules.amountThreshold) * 100))
      : 0
    const subject = view.subjectScore != null ? view.subjectScore : 60
    const hours = Math.max(0, (now() - Number(view.createdAt || now())) / 3600000)
    const waiting = Math.min(100, Math.round(hours * 4))
    const total = SORT_FACTORS.reduce((sum, factor) => sum + (Number(weight[factor.key]) || 0), 0)
    const score = total > 0
      ? Math.round((
        completeness * (Number(weight.completeness) || 0) +
        amountValue * (Number(weight.amount) || 0) +
        subject * (Number(weight.subject) || 0) +
        waiting * (Number(weight.waiting) || 0)
      ) / total)
      : 0
    return {
      priorityScore: score,
      priorityParts: { completeness, amount: amountValue, subject, waiting },
      amount,
      largeAmount: amount >= rules.amountThreshold
    }
  }

  function compareLeadPriority(a, b, rules) {
    if (!rules.enabled) return (b.matchPct - a.matchPct) || (a.createdAt - b.createdAt)
    /* 千万级以上委托只看资料齐全度，避免大额工单被其他权重稀释 */
    if (rules.largeCompletenessFirst && a.largeAmount && b.largeAmount) {
      const ca = a.priorityParts ? a.priorityParts.completeness : 0
      const cb = b.priorityParts ? b.priorityParts.completeness : 0
      if (ca !== cb) return cb - ca
    }
    if (a.priorityScore !== b.priorityScore) return b.priorityScore - a.priorityScore
    const ca = a.completeness != null ? a.completeness : (a.compareScore || 0)
    const cb = b.completeness != null ? b.completeness : (b.compareScore || 0)
    if (ca !== cb) return cb - ca
    return (a.createdAt || 0) - (b.createdAt || 0)
  }

  /** 咨询单全程操作时间线：领取 / 分配 / 状态变更 / 联系方式释放等 */
  async function leadTimeline(leadId) {
    const rows = await repo.find('audit', {}, { sort: { field: 'at', dir: 'desc' }, limit: 500 })
    const names = await staffNameMap()
    const list = rows
      .filter((row) => leadIdOfTarget(row.target) === leadId)
      .slice(0, 50)
      .map((row) => ({
        action: row.action,
        actionName: AUDIT_ACTION_LABELS[row.action] || row.action,
        actor: names.get(row.actorId) || (row.actorType === 'system' ? '系统' : (row.actorType === 'user' ? '用户' : row.actorId || '')),
        actorType: row.actorType,
        reason: row.reason || '',
        result: row.result,
        resultName: resultLabelOf(row.result),
        at: Number(row.at) || 0
      }))
    return list
  }

  /**
   * 产品型号库：平台维护的型号记录（静态目录内置在用户端，这里只存新增 / 停用 / 删除）。
   * key 采用「品类::品牌::系列::型号」，与前端合并静态目录的口径完全一致。
   */
  function catalogKeyOf(item) {
    return [item.cat, item.brand, item.series, item.model].join('::')
  }

  /** 型号记录 id：内置目录与平台记录共用同一套算法，保证编辑 / 删除能对上同一条 */
  function catalogIdOf(item) {
    return `catalog_${sha256Hex(catalogKeyOf(item)).slice(0, 16)}`
  }

  function projectCatalog(row) {
    return {
      id: row.id,
      key: catalogKeyOf(row),
      cat: row.cat,
      brand: row.brand,
      series: row.series,
      model: row.model,
      status: row.status || 'active',
      source: 'platform',
      note: row.note || '',
      createdAt: Number(row.createdAt) || 0,
      updatedAt: Number(row.updatedAt || row.createdAt) || 0,
      updatedBy: row.updatedBy || ''
    }
  }

  const CATALOG_STATUSES = Object.freeze(['active', 'disabled', 'removed'])

  /** 某商品 / 需求的咨询热度（去重人数，P0 已拦截不计入） */
  async function heatOf(field, id) {
    const rows = await repo.find('leads', { [field]: id }, { limit: 500 })
    return countHeat(rows)
  }

  /** 目标当前唯一的「已对接」线索（同一商品/需求同时只允许一条） */
  async function matchedLeadOf(field, id) {
    const rows = await repo.find('leads', { [field]: id, status: LEAD_STATUS.MATCHED }, { limit: 2 })
    return rows
  }

  /** 系统联动关闭线索（仅 已对接 → 已关闭，货主下架 / 需求关闭场景） */
  async function closeMatchedLead(lead, reason, at) {
    const res = await repo.updateWhere('leads', { id: lead.id, status: LEAD_STATUS.MATCHED }, { status: LEAD_STATUS.CLOSED })
    if (!res || res.count === 0) return false
    await appendAudit(repo, {
      actorType: 'system',
      actorId: 'state-machine',
      action: 'lead.updateStatus',
      target: `${lead.id}:${LEAD_STATUS.MATCHED}->${LEAD_STATUS.CLOSED}`,
      reason,
      result: 'allow',
      at
    })
    return true
  }

  /**
   * 线索状态 → 商品 / 需求状态联动（设计 3.6 / 9.4）：
   * 已对接 → 商品「洽谈中」/ 需求「已对接」
   * 已成交 → 商品「已成交」/ 需求「已关闭」
   * 已关闭（原已对接且未成交）→ 商品「洽谈中」回落「在售」/ 需求回落「求购中」
   */
  function linkedTargetStatus(lead, from, to) {
    if (lead.productId) {
      if (to === LEAD_STATUS.MATCHED) return { collection: 'products', id: lead.productId, expect: PRODUCT_STATUS.ON_SALE, next: PRODUCT_STATUS.NEGOTIATING }
      if (to === LEAD_STATUS.DEALT) return { collection: 'products', id: lead.productId, expect: PRODUCT_STATUS.NEGOTIATING, next: PRODUCT_STATUS.DEALT, acceptExpects: [PRODUCT_STATUS.ON_SALE] }
      if (to === LEAD_STATUS.CLOSED && from === LEAD_STATUS.MATCHED) return { collection: 'products', id: lead.productId, expect: PRODUCT_STATUS.NEGOTIATING, next: PRODUCT_STATUS.ON_SALE }
      return null
    }
    if (lead.demandId) {
      if (to === LEAD_STATUS.MATCHED) return { collection: 'demands', id: lead.demandId, expect: DEMAND_STATUS.OPEN, next: DEMAND_STATUS.MATCHED }
      if (to === LEAD_STATUS.DEALT) return { collection: 'demands', id: lead.demandId, expect: DEMAND_STATUS.MATCHED, next: DEMAND_STATUS.CLOSED, acceptExpects: [DEMAND_STATUS.OPEN] }
      if (to === LEAD_STATUS.CLOSED && from === LEAD_STATUS.MATCHED) return { collection: 'demands', id: lead.demandId, expect: DEMAND_STATUS.MATCHED, next: DEMAND_STATUS.OPEN }
      return null
    }
    return null
  }

  /** 目标状态必须先符合预期，否则拒绝流转，避免线索与商品状态漂移 */
  async function assertTargetReady(link) {
    if (!link) return null
    const doc = await repo.get(link.collection, link.id)
    if (!doc) throw new AppError(CODES.NOT_FOUND, '关联的发布内容不存在')
    const expects = [link.expect].concat(link.acceptExpects || [])
    if (!expects.includes(doc.status)) {
      throw new AppError(CODES.CONFLICT, `关联发布内容当前状态为「${doc.status}」，不允许该操作`)
    }
    return doc
  }

  /** 返回联动前目标的真实状态：acceptExpects 允许从非常规前置状态流转，回滚必须回到真实前置而不是 link.expect */
  async function applyTargetStatus(link) {
    if (!link) return null
    const expects = [link.expect].concat(link.acceptExpects || [])
    const from = (await repo.get(link.collection, link.id) || {}).status
    if (!expects.includes(from)) return null
    const res = await repo.updateWhere(link.collection, { id: link.id, status: from }, { status: link.next })
    if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '关联发布内容状态已被更新，请刷新后重试')
    return from
  }

  async function revertTargetStatus(link, fromStatus) {
    if (!link || !fromStatus) return
    try {
      await repo.updateWhere(link.collection, { id: link.id, status: link.next }, { status: fromStatus })
    } catch (err) {
      /* 回滚失败不覆盖原始错误，交由下一次状态校验兜底 */
    }
  }

  /**
   * 客服会话可见范围。
   * - 管理员：全量（对账、投诉核查需要）；
   * - 客服：只看「本人跟进过」的用户 + 尚无处理人的公共池用户。
   *   公共池保留是为了新会话有人接待；不是自己跟的客户不再随便翻看。
   */
  function isAdminSession(session) {
    return !!session && session.role === ROLES.ADMIN
  }

  async function leadChatAccess(uid, session) {
    if (isAdminSession(session)) return true
    const me = (session && session.accountId) || ''
    const rows = await repo.find('leads', { uid }, { limit: 50 })
    /* 从未产生咨询线索的用户留言（直接找平台客服）属于公共池 */
    if (!rows.length) return true
    return rows.some((lead) => {
      const owner = lead.assignedAccount || ''
      return !owner || (!!me && owner === me)
    })
  }

  /** 委托会话可见范围：管理员 / 已领取该咨询的客服；未分配的咨询仍属公共池 */
  async function agencyChatAccess(lead, session) {
    if (isAdminSession(session)) return true
    if (!lead) return false
    const me = (session && session.accountId) || ''
    const owner = lead.assignedAccount || ''
    return !owner || (!!me && owner === me)
  }

  /** 会话列表用：一次扫描线索，得到「我的 / 公共池 / 有线索」三个 uid 集合 */
  async function chatUidScope(session) {
    if (isAdminSession(session)) return null
    const me = (session && session.accountId) || ''
    const mine = new Set()
    const pool = new Set()
    const all = new Set()
    let skip = 0
    for (let page = 0; page < 5; page += 1) {
      const rows = await repo.find('leads', { uid: { $ne: '' } }, { limit: 500, skip })
      for (const lead of rows) {
        const uid = lead && lead.uid
        if (!uid) continue
        all.add(uid)
        const owner = lead.assignedAccount || ''
        if (me && owner === me) mine.add(uid)
        else if (!owner) pool.add(uid)
      }
      if (rows.length < 500) break
      skip += rows.length
    }
    /* 没有任何线索的用户（纯客服留言）视为公共池 */
    return { visible: (uid) => mine.has(uid) || pool.has(uid) || !all.has(uid) }
  }

  return {
    'admin.login': async (data, ctx) => {
      const username = str(data.username, { field: '账号', required: true, max: 32 }).toLowerCase()
      const password = str(data.password, { field: '口令', required: true, max: 128 })
      if (data.otp === undefined || data.otp === null || String(data.otp).trim() === '') {
        throw new AppError(CODES.VALIDATION, '请输入 6 位动态口令')
      }
      const otp = str(data.otp, { field: '动态口令', required: true, max: 8 })
      if (!/^\d{6}$/.test(otp)) throw new AppError(CODES.VALIDATION, '动态口令格式不正确')

      const account = await findAccount(username)
      const passOk = verifyPassword(password, account ? account.passwordHash : dummyHash)
      const disabled = !!account && account.status === 'disabled'
      if (!account || !passOk || disabled) {
        const reason = disabled ? '账号已停用' : '口令校验失败'
        await appendAudit(repo, {
          actorType: 'admin',
          actorId: username,
          action: 'admin.login',
          target: '',
          reason,
          ip: ctx.ip,
          result: 'UNAUTHENTICATED',
          at: now()
        })
        await recordLogin({ username, ip: ctx.ip, result: 'deny', reason, at: now() })
        throw new AppError(CODES.UNAUTHENTICATED, disabled ? '账号已停用，请联系管理员' : '账号或口令错误')
      }
      if (!verifyTotp(account.totpSecret, otp, now())) {
        await appendAudit(repo, {
          actorType: 'admin',
          actorId: username,
          action: 'admin.login',
          target: '',
          reason: '动态口令校验失败',
          ip: ctx.ip,
          result: 'UNAUTHENTICATED',
          at: now()
        })
        await recordLogin({ username, role: account.role, ip: ctx.ip, result: 'deny', reason: '动态口令校验失败', at: now() })
        throw new AppError(CODES.UNAUTHENTICATED, '动态口令错误')
      }

      const at = now()
      const token = randomToken(32)
      const expiresAt = at + SESSION_TTL_MS
      await repo.insert('sessions', {
        id: randomToken(8),
        tokenHash: sha256Hex(token),
        role: account.role,
        accountId: account.username,
        expiresAt,
        mfaOk: true,
        createdAt: at
      })
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: account.username,
        action: 'admin.login',
        target: '',
        reason: '',
        ip: ctx.ip,
        result: 'allow',
        at
      })
      await recordLogin({ username: account.username, role: account.role, ip: ctx.ip, result: 'allow', at })
      /* 临时权限：页面白名单临时并集，动作权限由路由层校验 */
      const perm = await permissionsOf(account, at)
      return {
        token,
        role: account.role,
        name: account.name,
        org: account.org,
        /* 前端导航直接按这份页面白名单渲染，避免前后端两套权限口径 */
        pages: perm.pages,
        /* 页面内按钮按动作白名单显示，避免客服点到管理员专属动作才报 403 */
        actions: perm.actions,
        tempPermission: perm.tempPermission,
        expiresAt
      }
    },

    /**
     * 刷新登录快照：前端带 token 自动登录时，用服务端当前权限覆盖本地缓存。
     * 角色页面 / 临时权限调整后无需重新登录即可生效。
     */
    'admin.session': async (data, ctx) => {
      const session = ctx.session || {}
      const account = await findAccount(session.accountId)
      if (!account) throw new AppError(CODES.UNAUTHENTICATED, '账号不存在，请重新登录')
      if (account.status === 'disabled') throw new AppError(CODES.UNAUTHENTICATED, '账号已停用，请重新登录')
      const perm = await permissionsOf(account, now())
      return {
        role: account.role,
        name: account.name,
        org: account.org,
        pages: perm.pages,
        actions: perm.actions,
        tempPermission: perm.tempPermission,
        expiresAt: Number(session.expiresAt) || 0
      }
    },

    'admin.logout': async (data, ctx) => {
      const session = ctx.session
      if (session && session.tokenHash) {
        await repo.updateWhere('sessions', { tokenHash: session.tokenHash }, { expiresAt: now() })
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'admin.logout',
        target: '',
        reason: '',
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      return { ok: true }
    },

    /** 工作台待办数字：管理端只读，不写审计 */
    'admin.todos': async () => collectTodos(),

    /**
     * 工作台作业记录：按账号聚合时间窗内的审计动作，并附带当前账号的待办数字。
     * 纯只读，不写审计；paymentAmount 优先按 payment.feeConfirm 的 target（收款单 id）回查金额，
     * 查不到时退回 confirmedBy + 姓名口径，避免环境引导账号没有 accounts 记录时显示空值。
     */
    'workbench.data': async (data, ctx) => {
      const session = ctx.session || {}
      const role = session.role || ''
      const period = data && ['today', '7d', '30d'].includes(data.period) ? data.period : 'today'
      const at = now()
      const from = periodStartOf(period, at)
      const [todos, accountList, auditRows, paymentRows] = await Promise.all([
        collectTodos(),
        listAllAccounts(),
        repo.find('audit', { at: { $gte: from } }, { sort: { field: 'at', dir: 'asc' }, limit: 20000 }),
        repo.find('payments', { confirmedAt: { $gte: from } }, { limit: 5000 })
      ])
      const paymentById = new Map(paymentRows.map((row) => [row.id, row]))
      const paymentByConfirmer = new Map()
      paymentRows.forEach((row) => {
        const amount = Number(row.amount || row.received) || 0
        if (row.confirmedBy) {
          paymentByConfirmer.set(row.confirmedBy, (paymentByConfirmer.get(row.confirmedBy) || 0) + amount)
        }
      })
      const aggregate = new Map()
      auditRows.forEach((entry) => {
        const actorId = String(entry.actorId || '')
        if (!actorId) return
        let row = aggregate.get(actorId)
        if (!row) {
          row = {
            tickets: 0, replies: 0, reviews: 0, payments: 0, paymentAmount: 0,
            risk: 0, reports: 0, actions: 0, lastAt: 0, payIds: new Set()
          }
          aggregate.set(actorId, row)
        }
        const action = entry.action || ''
        row.actions += 1
        row.lastAt = Math.max(row.lastAt, Number(entry.at) || 0)
        if (action === 'msg.reply') row.replies += 1
        if (TICKET_ACTIONS.indexOf(action) >= 0) row.tickets += 1
        if (REVIEW_ACTIONS.indexOf(action) >= 0) row.reviews += 1
        if (action === 'risk.handle') row.risk += 1
        if (action === 'report.handle') row.reports += 1
        /* 委托服务费确认到账，作业量按确认动作统计 */
        if (action === 'payment.feeConfirm') {
          row.payments += 1
          if (entry.target) row.payIds.add(String(entry.target))
        }
      })
      const buildRow = (account) => {
        const username = account.username
        const name = account.name || username
        const agg = aggregate.get(username)
        let paymentAmount = 0
        if (agg && agg.payIds.size) {
          agg.payIds.forEach((id) => {
            const payment = paymentById.get(id)
            paymentAmount += Number(payment && (payment.amount || payment.received)) || 0
          })
        }
        if (!paymentAmount) paymentAmount = paymentByConfirmer.get(name) || 0
        return {
          username,
          name,
          role: account.role || '',
          tickets: agg ? agg.tickets : 0,
          replies: agg ? agg.replies : 0,
          reviews: agg ? agg.reviews : 0,
          payments: agg ? agg.payments : 0,
          paymentAmount,
          risk: agg ? agg.risk : 0,
          reports: agg ? agg.reports : 0,
          actions: agg ? agg.actions : 0,
          lastAt: agg ? agg.lastAt : 0
        }
      }
      const allRows = accountList.map(buildRow)
      const username = String(session.accountId || '')
      let mine = allRows.find((row) => row.username === username)
      if (!mine) {
        mine = buildRow({
          username,
          name: session.name || username,
          role: session.role || ''
        })
      }
      const accounts = role === 'admin'
        ? (allRows.some((row) => row.username === username) ? allRows : allRows.concat(mine))
        : [mine]
      return { role, period, todos, mine, accounts }
    },

    'lead.list': async (data, ctx) => {
      const paging = normalizePaging(data)
      const query = {}
      if (data.status) query.status = enumOf(data.status, Object.values(LEAD_STATUS), '状态')
      if (data.tradeMode) query.tradeMode = enumOf(data.tradeMode, TRADE_MODE_OPTIONS.all, '交易方式')
      if (data.tier) query.tier = enumOf(data.tier, TIERS, '档位')
      /* 来源筛选：工作台只看代采 / 代售相关咨询（targetType=agency），商品与需求的私聊不进平台待办 */
      if (data.targetType) query.targetType = str(data.targetType, { field: '来源类型', max: 20 })
      /* 按委托单反查咨询：代采代售详情里展示「谁咨询了这单 / 谁在跟进」 */
      const agencyId = data.agencyId ? str(data.agencyId, { field: '委托标识', max: 64 }) : ''
      if (agencyId) {
        query.targetType = 'agency'
        query.targetId = agencyId
      }
      /* 客服服务状态：待领取 / 服务中 / 已结束，仅对代采代售咨询生效 */
      if (data.csStatus) {
        query.targetType = 'agency'
        query.csStatus = enumOf(data.csStatus, Object.values(CS_STATUS), '服务状态')
      }
      /* 标准流程阶段：客服工作台按「沟通中 / 合同待审核 / 服务费待支付」等分栏 */
      if (data.serviceStage) {
        query.targetType = 'agency'
        query.serviceStage = enumOf(data.serviceStage, Object.values(CONSULT_STAGE), '流程阶段')
      }
      if (data.assignedTo) query.assignedTo = str(data.assignedTo, { field: '坐席', max: 32 })
      /* 我的已领取：只看当前账号名下未完成的咨询单 */
      const mine = data.mine === true || data.mine === 'true' || data.mine === 1
      if (mine) {
        const accountId = ctx && ctx.session ? ctx.session.accountId : ''
        if (!accountId) throw new AppError(CODES.UNAUTHORIZED, '登录状态已失效，请重新登录')
        query.assignedAccount = accountId
        if (!data.status) {
          query.status = { $in: [LEAD_STATUS.PENDING, LEAD_STATUS.FOLLOWING, LEAD_STATUS.MATCHED] }
        }
      }
      if (data.q) {
        query.formSummary = {
          $regex: str(data.q, { field: '关键词', max: 30 }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i'
        }
      }
      if (data.from || data.to) {
        query.createdAt = {}
        if (data.from) query.createdAt.$gte = Number(data.from) || 0
        if (data.to) query.createdAt.$lt = Number(data.to) || Date.now()
      }
      /* 城市 / 品牌筛选：先取全量候选，再内存过滤（避免 join 复杂度，管理端数据量可控） */
      const cityFilter = data.city ? str(data.city, { field: '城市', max: 20 }) : ''
      const brandFilter = data.brand ? str(data.brand, { field: '品牌', max: 30 }) : ''
      const needJoin = cityFilter || brandFilter
      let all
      if (needJoin) {
        const candidates = await repo.find('leads', query, { limit: 100000 })
        all = []
        for (const lead of candidates) {
          let target = null
          if (lead.productId) target = await repo.get('products', lead.productId)
          else if (lead.demandId) target = await repo.get('demands', lead.demandId)
          if (!target) continue
          if (cityFilter && target.city !== cityFilter) continue
          if (brandFilter && !(target.brand || '').includes(brandFilter)) continue
          all.push(lead)
        }
      } else {
        all = await repo.find('leads', query, { limit: 100000 })
      }
      /* 审批优先级：权重来自 settings 的排序规则，先算全量再排序分页 */
      const rules = await loadSortRules()
      const items = []
      for (const lead of all) {
        const view = await staffLeadView(lead)
        items.push(Object.assign(view, priorityOf(view, rules)))
      }
      items.sort((a, b) => compareLeadPriority(a, b, rules))
      /* 列表直接展示「谁 → 谁」：批量补咨询方 / 委托方昵称，避免前端逐条查用户 */
      const uids = []
      items.forEach((it) => {
        if (it.consultUid) uids.push(it.consultUid)
        if (it.publisherUid) uids.push(it.publisherUid)
      })
      if (uids.length) {
        const nameMap = await staffUserMap(uids)
        items.forEach((it) => {
          const consult = nameMap.get(it.consultUid)
          const publisher = nameMap.get(it.publisherUid)
          it.consultNick = (consult && consult.nick) || ''
          it.publisherNick = (publisher && publisher.nick) || ''
        })
      }
      const total = items.length
      const pageItems = items.slice(paging.skip, paging.skip + paging.limit)
      const result = {
        items: pageItems,
        page: paging.page,
        limit: paging.limit,
        total,
        hasMore: paging.skip + pageItems.length < total,
        sortRules: { enabled: rules.enabled, amountThreshold: rules.amountThreshold }
      }
      assertNoPlaintextContact(result)
      return result
    },

    'lead.detail': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '线索', required: true, max: 64 })
      const lead = await loadLead(leadId)
      const target = await targetTitle(lead)
      let targetDoc = null
      let publisherUid = ''
      /* 发布方（商品货主 / 需求买方 / 代采代售委托方）条件快照：用于核对双方是否满足 */
      let publisherSide = null
      if (target.type === 'product') {
        const product = await repo.get('products', lead.productId)
        targetDoc = product ? projectProductForStaff(product) : null
        if (product) {
          publisherUid = product.ownerId || ''
          publisherSide = {
            type: '商品', title: product.title || target.title, city: product.city || '',
            must: product.must || [], nego: product.nego || [], flow: product.flow || [],
            note: redactChatText(product.note || product.requirements || '')
          }
        }
      } else if (target.type === 'demand') {
        const demand = await repo.get('demands', lead.demandId)
        targetDoc = demand ? projectDemand(demand) : null
        if (demand) {
          publisherUid = demand.ownerId || ''
          publisherSide = {
            type: '需求', title: demand.title || target.title, city: demand.city || '',
            must: demand.must || [], nego: demand.nego || [], flow: demand.flow || [],
            note: redactChatText(demand.note || demand.accept || '')
          }
        }
      } else if (target.type === 'agency') {
        const agency = target.id ? await repo.get('agencies', target.id) : null
        if (agency) {
          publisherUid = agency.ownerId || ''
          publisherSide = {
            type: agency.side === 'sell' ? '代售' : '代采',
            title: target.title, city: agency.city || '',
            must: Array.isArray(agency.must) ? agency.must : [],
            nego: Array.isArray(agency.nego) ? agency.nego : [],
            flow: Array.isArray(agency.flow) ? agency.flow : [],
            note: redactChatText(agency.detail || '')
          }
        }
      }
      const blocked = await repo.find('blocked', { leadId }, { sort: { field: 'at', dir: 'desc' }, limit: 5 })
      const view = await staffLeadView(lead)
      const rules = await loadSortRules()
      const accountId = ctx && ctx.session ? ctx.session.accountId : ''
      /* 双方信息：咨询方（发起咨询的用户）+ 发布方（商品 / 需求 / 委托的所属用户） */
      const consultUid = lead.uid || ''
      const userMap = await staffUserMap([consultUid, publisherUid], { withActivity: true })
      const compareRows = Array.isArray(lead.compare) ? lead.compare : []
      const metCount = compareRows.filter((row) => row.res === '满足' || row.res === '一致').length
      const detail = Object.assign(view, {
        consultUser: (consultUid && userMap.get(consultUid)) || null,
        publisherUser: (publisherUid && userMap.get(publisherUid)) || null,
        publisherSide,
        /* 双方条件是否满足：对比项总数 / 满足数 / 差异数，前端据此给结论标签 */
        satisfaction: {
          total: compareRows.length,
          met: metCount,
          unmet: compareRows.length - metCount,
          allMet: compareRows.length > 0 && metCount === compareRows.length,
          rate: Number(lead.matchPct) || 0
        },
        targetTitle: target.title,
        target: targetDoc,
        blocked: blocked.map((row) => ({
          id: row.id,
          ruleId: row.ruleId,
          reason: row.reason,
          at: row.at,
          reviewDeadline: row.reviewDeadline
        })),
        /* 全程操作时间线：领取、分配、状态变更、联系方式释放均留痕 */
        timeline: await leadTimeline(leadId),
        claimedByMe: !!(accountId && lead.assignedAccount === accountId)
      }, priorityOf(view, rules))
      assertNoPlaintextContact(detail)
      return detail
    },

    /**
     * 状态流转白名单；同一商品/需求同时只允许一条已对接（CAS + 唯一约束）。
     * 「已对接」不可回退；回退只有「跟进中 → 待分配」与「已拦截 → 待分配」。
     */
    'lead.updateStatus': async (data, ctx) => {
      const session = ctx.session
      const leadId = str(data.leadId || data.id, { field: '线索', required: true, max: 64 })
      const to = enumOf(data.to || data.status, Object.values(LEAD_STATUS), '目标状态')
      const reason = str(data.reason, { field: '变更原因', max: 100 })
      const lead = await loadLead(leadId)
      const allowed = LEAD_TRANSITIONS[lead.status] || []
      if (!allowed.includes(to)) {
        throw new AppError(CODES.CONFLICT, `线索不能从「${lead.status}」变更为「${to}」`)
      }
      /* 恢复已拦截必须在 24 小时复核窗口内 */
      if (lead.status === LEAD_STATUS.BLOCKED && to === LEAD_STATUS.PENDING) {
        const life = await repo.find('blocked', { leadId }, { sort: { field: 'at', dir: 'desc' }, limit: 1 })
        const row = life[0]
        if (!row || Number(row.reviewDeadline) <= now()) {
          throw new AppError(CODES.CONFLICT, '已超过 24 小时复核窗口，不能恢复')
        }
        if (!reason) throw new AppError(CODES.VALIDATION, '恢复必须填写复核原因')
      }
      /* 同一商品/需求同时只允许一条「已对接」线索；代采/代售对接工单不绑定商品或需求，跳过 */
      if (to === LEAD_STATUS.MATCHED) {
        const field = lead.productId ? 'productId' : (lead.demandId ? 'demandId' : '')
        const targetId = lead.productId || lead.demandId || ''
        if (field && targetId) {
          const others = (await matchedLeadOf(field, targetId)).filter((row) => row.id !== leadId)
          if (others.length > 0) {
            throw new AppError(CODES.CONFLICT, '该发布内容已有处于「已对接」的线索，不能重复对接')
          }
        }
      }
      /* 线索 → 商品/需求联动；对接与成交必须先校验目标状态，关闭回落允许目标已下架 */
      const link = linkedTargetStatus(lead, lead.status, to)
      if (to === LEAD_STATUS.MATCHED || to === LEAD_STATUS.DEALT) await assertTargetReady(link)
      const appliedFrom = await applyTargetStatus(link)
      const patch = { status: to }
      const res = await repo.updateWhere('leads', { id: leadId, status: lead.status }, patch)
      if (!res || res.count === 0) {
        await revertTargetStatus(link, appliedFrom)
        throw new AppError(CODES.CONFLICT, '线索状态已被更新，请刷新后重试')
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'lead.updateStatus',
        target: `${leadId}:${lead.status}->${to}`,
        reason,
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      /* 关键节点回执：用户从站内消息看进度，对接 / 成交 / 结束必须主动告知 */
      try {
        const target = await targetTitle(lead)
        const NOTICES = {
          [LEAD_STATUS.MATCHED]: {
            title: '咨询已对接',
            body: `你咨询的「${target.title}」已对接成功，客服会联系你确认交付细节。`
          },
          [LEAD_STATUS.DEALT]: {
            title: '咨询已成交',
            body: `「${target.title}」本次撮合已完成，感谢使用平台服务。`
          },
          [LEAD_STATUS.CLOSED]: {
            title: '咨询已结束',
            body: `「${target.title}」的咨询已结束${reason ? '：' + reason : ''}。如仍有需求可重新提交咨询。`
          },
          /* 被风控拦截不能让用户无感：明确告知原因与改法 */
          [LEAD_STATUS.BLOCKED]: {
            title: '咨询暂被拦截',
            body: `「${target.title}」的咨询触发平台风控${reason ? '：' + reason : '（联系方式或内容不符合规范）'}，请修改后重新提交，或联系在线客服核实。`
          },
          /* 复核通过后恢复跟进 */
          [LEAD_STATUS.PENDING]: {
            title: '咨询已恢复',
            body: `「${target.title}」的咨询已通过复核，客服会继续跟进。`
          }
        }
        const notice = NOTICES[to]
        if (notice) {
          await notifyUser(lead.uid, {
            title: notice.title,
            body: notice.body,
            targetType: target.type,
            targetId: target.id,
            reason,
            leadId
          })
        }
      } catch (err) { /* 状态已落库：回执失败不影响主流程 */ }
      return { leadId, from: lead.status, to }
    },

    /**
     * 从消息中心生成咨询工单：客服在会话里确认客户诉求后一键建单。
     * 生成的工单为「待分配」，同时进入咨询工单列表与工作台待办，客服领取后再跟进。
     */
    'lead.create': async (data, ctx) => {
      const session = ctx.session
      const uid = str(data.uid, { field: '用户', required: true, max: 64 })
      const user = await repo.get('users', uid)
      if (!user) throw new AppError(CODES.NOT_FOUND, '用户不存在')
      const kind = str(data.kind || 'other', { field: '工单类型', max: 24 })
      const kindLabel = LEAD_KIND_LABELS[kind]
      if (!kindLabel) throw new AppError(CODES.VALIDATION, '工单类型不正确')
      const note = str(data.note || '', { field: '需求备注', max: 300 })
      /* 同一用户已有从会话生成的咨询工单时直接复用，避免消息里连点生成重复工单 */
      const exists = await repo.find('leads', {
        uid,
        targetType: 'agency',
        source: 'kf_message',
        status: LEAD_STATUS.FOLLOWING
      }, { limit: 1 })
      if (exists[0]) return { leadId: exists[0].id, duplicated: true }
      const at = now()
      const title = kindLabel + (note ? '：' + note.slice(0, 40) : '')
      const staff = await resolveStaff(session.accountId)
      /* 会话沿用消息中心当前的 threadId（缺省为 uid），领取后聊天记录仍落在同一条会话里 */
      const lead = {
        id: randomId('LD'),
        uid,
        targetType: 'agency',
        targetId: '',
        agencyTitle: title,
        source: 'kf_message',
        formSummary: note || title,
        /* 直接建单 = 已领取的正式工单：不再进「待领取咨询」，工作台也不会重复提示 */
        status: LEAD_STATUS.FOLLOWING,
        threadId: str(data.threadId || '', { field: '会话', max: 64 }) || uid,
        /* 消息中心「生成工单」= 直接建单：聊天记录已经在会话里，无需再走待领取 */
        ticketState: TICKET_STATE.TICKETED,
        csStatus: CS_STATUS.SERVING,
        csId: staff.username,
        csName: staff.name,
        csClaimedAt: at,
        assignedTo: staff.name,
        assignedAccount: staff.username,
        assignedAt: at,
        ticketOpenedAt: at,
        ticketOpenedBy: staff.name,
        serviceStage: CONSULT_STAGE.COMMUNICATING,
        stageAt: at,
        stageBy: staff.name,
        stageVersion: 0,
        stageHistory: [{ stage: CONSULT_STAGE.COMMUNICATING, at, by: staff.name, note: '消息中心生成工单' }],
        createdAt: at,
        updatedAt: at
      }
      await repo.insert('leads', lead)
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'lead.create',
        target: `${lead.id}:${kind}`,
        reason: note,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return { leadId: lead.id, duplicated: false }
    },

    /**
     * 分配 / 转派坐席：管理员与客服都可操作。
     * - 坐席必须是启用中的真实账号（不能凭空写名字）
     * - 转派留痕：审计 reason 记录「分配：未分配 → A」/「转派：A → B」
     */
    'lead.assign': async (data, ctx) => {
      const session = ctx.session
      const leadId = str(data.leadId || data.id, { field: '线索', required: true, max: 64 })
      const assignee = str(data.assignee || data.username, { field: '坐席', required: true, max: 64 })
      const note = str(data.reason, { field: '转派说明', max: 100 })
      const lead = await loadLead(leadId)
      /* 处理中的工单可随时转派；已拦截 / 已成交 / 已关闭不能再转派 */
      if ([LEAD_STATUS.BLOCKED, LEAD_STATUS.DEALT, LEAD_STATUS.CLOSED].indexOf(lead.status) >= 0) {
        throw new AppError(CODES.CONFLICT, '当前状态不能分配坐席')
      }
      const stage = lead.targetType === 'agency' ? consultStageOf(lead) : ''
      if (stage === CONSULT_STAGE.DONE || stage === CONSULT_STAGE.ABORTED) {
        throw new AppError(CODES.CONFLICT, '工单已结束，不能转派')
      }
      const staff = await resolveStaff(assignee)
      const from = lead.assignedTo || ''
      if (from && from === staff.name) {
        throw new AppError(CODES.CONFLICT, '该工单已由该客服负责，无需重复分配')
      }
      const at = now()
      const patch = { assignedTo: staff.name, assignedAccount: staff.username, assignedAt: at }
      /* 代采代售工单同步领取人字段，转派后详情 / 提成口径都跟着新客服 */
      if (lead.targetType === 'agency') {
        patch.csId = staff.username
        patch.csName = staff.name
      }
      const res = await repo.updateWhere(
        'leads',
        { id: leadId, status: lead.status },
        patch
      )
      if (!res || res.count === 0) {
        throw new AppError(CODES.CONFLICT, '线索状态已被更新，请刷新后重试')
      }
      const transferred = !!from
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'lead.assign',
        target: leadId,
        reason: `${transferred ? '转派' : '分配'}：${from || '未分配'} → ${staff.name}${note ? '；' + note : ''}`,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return {
        leadId,
        assignedTo: staff.name,
        assignedAccount: staff.username,
        from,
        transferred
      }
    },

    /**
     * 领取咨询单：先把工单认领到自己名下，再开始跟进。
     * - 只有待分配 / 跟进中 / 已对接可以领取；已拦截、已成交、已关闭不可领取；
     * - 已被他人领取时拒绝，避免重复认领；
     * - 领取后未成交 / 未关闭前一直留在领取人的「我的已领取」；
     * - 全程留痕：lead.claim 审计 + 列表详情时间线。
     */
    'lead.claim': async (data, ctx) => {
      const session = ctx.session
      const accountId = session ? session.accountId : ''
      if (!accountId) throw new AppError(CODES.UNAUTHORIZED, '登录状态已失效，请重新登录')
      const leadId = str(data.leadId || data.id, { field: '线索', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if ([LEAD_STATUS.BLOCKED, LEAD_STATUS.DEALT, LEAD_STATUS.CLOSED].indexOf(lead.status) >= 0) {
        throw new AppError(CODES.CONFLICT, `当前状态为「${lead.status}」，不能领取`)
      }
      if (lead.assignedAccount && lead.assignedAccount !== accountId) {
        throw new AppError(CODES.CONFLICT, `该咨询单已被「${lead.assignedTo || lead.assignedAccount}」领取`)
      }
      const staff = await resolveStaff(accountId)
      const at = now()
      /* 重复点击保持幂等：已领取人就是本人时直接返回 */
      if (lead.assignedAccount === accountId) {
        return {
          leadId,
          claimed: true,
          already: true,
          assignedTo: lead.assignedTo || staff.name,
          assignedAccount: accountId,
          assignedAt: lead.assignedAt || at,
          status: lead.status,
          ticketState: lead.targetType === 'agency' ? ticketStateOf(lead) : '',
          csStatus: lead.targetType === 'agency' ? csStatusOf(lead) : ''
        }
      }
      const to = lead.status === LEAD_STATUS.PENDING ? LEAD_STATUS.FOLLOWING : lead.status
      /* 代采代售咨询：用户提交即生成工单，领取只是认领，工单状态始终为「已生成」。
         仅兼容升级前的历史数据：待领取 / 磋商中在领取时补成已生成工单。 */
      const isCs = lead.targetType === 'agency'
      const claimState = isCs ? ticketStateOf(lead) : ''
      const ticketState = isCs && (claimState === TICKET_STATE.INTAKE || claimState === TICKET_STATE.CONSULTING)
        ? TICKET_STATE.TICKETED
        : claimState
      /* 首次领取：把待领取期间暂存的咨询内容一次性接入会话 */
      const firstClaim = !lead.assignedAccount && !lead.csClaimedAt
      const patch = { assignedTo: staff.name, assignedAccount: accountId, assignedAt: at, status: to }
      if (isCs) {
        patch.csStatus = CS_STATUS.SERVING
        patch.csClaimedAt = at
        patch.csId = accountId
        patch.csName = staff.name
        patch.threadId = lead.threadId || leadId
        patch.ticketState = ticketState
        /* 只有已生成工单的咨询才进入流程首阶段；磋商中先谈条件 */
        if (ticketState === TICKET_STATE.TICKETED && !lead.serviceStage) {
          patch.serviceStage = CONSULT_STAGE.COMMUNICATING
          patch.stageAt = at
          patch.stageBy = staff.name
          patch.stageVersion = 0
          patch.stageHistory = [{ stage: CONSULT_STAGE.COMMUNICATING, at, by: staff.name, note: '生成工单' }]
        }
      }
      const res = await repo.updateWhere(
        'leads',
        { id: leadId, status: lead.status },
        patch
      )
      if (!res || res.count === 0) {
        throw new AppError(CODES.CONFLICT, '线索状态已被更新，请刷新后重试')
      }
      if (isCs) {
        const threadId = lead.threadId || leadId
        /* 待领取期间内容只暂存在工单上；首次领取时一次性接入消息中心 */
        if (firstClaim) {
          const body = String(lead.intakeBody || lead.formSummary || '').trim()
          const mediaCount = Array.isArray(lead.intakeMedia) ? lead.intakeMedia.length : 0
          const lines = []
          if (body) lines.push(body)
          if (mediaCount) lines.push(`（附带 ${mediaCount} 个图片 / 视频材料，可在工单详情查看）`)
          if (lines.length) {
            await repo.insert('outbox', {
              id: 'M' + sha256Hex('cs-intake:' + leadId).slice(0, 22),
              type: 'kf.chat',
              payload: {
                uid: lead.uid,
                channel: 'kf',
                from: 'user',
                staffName: '',
                threadId,
                targetType: 'agency',
                targetId: lead.targetId || lead.agencyId || '',
                title: lead.agencyTitle || '',
                body: lines.join('\n'),
                csStatus: CS_STATUS.SERVING
              },
              status: 'read',
              readByStaff: true,
              readByUser: true,
              createdAt: Number(lead.intakeAt) || at
            })
          }
        }
        /* 接入提示写进同一会话流：用户端立刻看到「XX 正在接入」 */
        await repo.insert('outbox', {
          id: 'M' + sha256Hex('cs-claim:' + leadId).slice(0, 22),
          type: 'kf.chat',
          payload: {
            uid: lead.uid,
            channel: 'kf',
            from: 'system',
            staffName: staff.name,
            threadId,
            targetType: 'agency',
            targetId: lead.targetId || lead.agencyId || '',
            title: lead.agencyTitle || '',
            body: ticketState === TICKET_STATE.TICKETED
              ? `客服 ${staff.name} 已接入，工单已生成`
              : `客服 ${staff.name} 正在接入，先与你确认委托条件`,
            csStatus: CS_STATUS.SERVING
          },
          status: 'pending',
          createdAt: at
        })
      }
      /* 同一委托统一由一个客服跟进：把同委托下还没人领取的工单一起接过来 */
      const adopted = isCs ? await adoptAgencySiblings(lead, staff, at) : 0
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: accountId,
        action: 'lead.claim',
        target: leadId,
        reason: `领取：未分配 → ${staff.name}${lead.status !== to ? `；状态 ${lead.status} → ${to}` : ''}${adopted ? `；同委托 ${adopted} 条工单一并接入` : ''}`,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return {
        leadId,
        claimed: true,
        already: false,
        assignedTo: staff.name,
        assignedAccount: accountId,
        assignedAt: at,
        from: lead.status,
        status: to,
        adopted,
        ticketState: isCs ? ticketState : '',
        csStatus: isCs ? CS_STATUS.SERVING : ''
      }
    },

    /**
     * 生成工单：代采 / 代售咨询磋商达成一致后，由领取人把咨询转为正式工单。
     * - 咨询与工单是两件事：待领取、磋商中都不出现在工单中心；
     * - 只有领取人（或具备转派权限的管理员）可以建单；
     * - 建单后同一会话继续沿用，用户端看到「工单已生成」并进入分步流程。
     */
    'consult.openTicket': async (data, ctx) => {
      const session = ctx.session
      const accountId = (session && session.accountId) || ''
      if (!accountId) throw new AppError(CODES.UNAUTHORIZED, '登录状态已失效，请重新登录')
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.CONFLICT, '只有代采 / 代售咨询可以生成工单')
      if ([LEAD_STATUS.BLOCKED, LEAD_STATUS.DEALT, LEAD_STATUS.CLOSED].indexOf(lead.status) >= 0) {
        throw new AppError(CODES.CONFLICT, `当前状态为「${lead.status}」，不能生成工单`)
      }
      const state = ticketStateOf(lead)
      if (state === TICKET_STATE.INVALID) throw new AppError(CODES.CONFLICT, '该咨询已标记为无效，不能生成工单')
      if (state === TICKET_STATE.TICKETED) {
        return {
          leadId,
          ticketState: TICKET_STATE.TICKETED,
          already: true,
          serviceStage: consultStageOf(lead),
          serviceStageLabel: consultStageLabel(consultStageOf(lead))
        }
      }
      const mine = lead.assignedAccount === accountId
      if (!mine && !can(session.role, 'lead.assign')) {
        throw new AppError(CODES.FORBIDDEN, '请先领取该咨询后再生成工单')
      }
      const staff = await resolveStaff(accountId)
      const at = now()
      const note = str(data.note, { field: '成交条件', max: 500 }) || ''
      const stage = CONSULT_STAGE.COMMUNICATING
      const patch = {
        ticketState: TICKET_STATE.TICKETED,
        status: LEAD_STATUS.FOLLOWING,
        csStatus: CS_STATUS.SERVING,
        csId: accountId,
        csName: staff.name,
        ticketOpenedAt: at,
        ticketOpenedBy: staff.name,
        serviceStage: stage,
        stageAt: at,
        stageBy: staff.name,
        stageVersion: 0,
        stageHistory: [{ stage, at, by: staff.name, note: note || '磋商完成，生成工单' }],
        updatedAt: at
      }
      /* 管理员代未领取的咨询建单时，顺手把工单归到自己名下，避免出现无归属工单 */
      if (!lead.assignedAccount) {
        patch.assignedTo = staff.name
        patch.assignedAccount = accountId
        patch.assignedAt = at
      }
      const res = await repo.updateWhere('leads', { id: leadId, assignedAccount: lead.assignedAccount || '' }, patch)
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '咨询状态已变化，请刷新后重试')
      await repo.insert('outbox', {
        id: 'M' + sha256Hex('cs-ticket:' + leadId).slice(0, 22),
        type: 'kf.chat',
        payload: {
          uid: lead.uid,
          channel: 'kf',
          from: 'system',
          staffName: staff.name,
          threadId: lead.threadId || leadId,
          targetType: 'agency',
          targetId: lead.targetId || lead.agencyId || '',
          title: lead.agencyTitle || '',
          body: '条件已确认，工单已生成，客服将按标准流程推进',
          csStatus: CS_STATUS.SERVING
        },
        status: 'pending',
        createdAt: at
      })
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: accountId,
        action: 'consult.openTicket',
        target: leadId,
        reason: note ? `磋商完成，生成工单：${note}` : '磋商完成，生成工单',
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return {
        leadId,
        ticketState: TICKET_STATE.TICKETED,
        already: false,
        serviceStage: stage,
        serviceStageLabel: consultStageLabel(stage),
        hint: '工单已生成，进入标准流程'
      }
    },

    /**
     * 标记无效咨询：用户只是随口问、条件不成立或联系不上时使用。
     * 无效咨询不生成工单、不进入工单中心；已接入会话的会收到结束提示。
     */
    'consult.dismiss': async (data, ctx) => {
      const session = ctx.session
      const accountId = (session && session.accountId) || ''
      if (!accountId) throw new AppError(CODES.UNAUTHORIZED, '登录状态已失效，请重新登录')
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.CONFLICT, '只有代采 / 代售咨询可以标记无效')
      const state = ticketStateOf(lead)
      if (state === TICKET_STATE.TICKETED) throw new AppError(CODES.CONFLICT, '已生成工单，请走工单结束流程')
      if (state === TICKET_STATE.INVALID) {
        return { leadId, ticketState: state, already: true }
      }
      const mine = lead.assignedAccount === accountId
      if (lead.assignedAccount && !mine && !can(session.role, 'lead.assign')) {
        throw new AppError(CODES.FORBIDDEN, '只能处理自己领取的咨询')
      }
      const staff = await resolveStaff(accountId)
      const at = now()
      const note = str(data.reason || data.note, { field: '备注', max: 200 }) || ''
      const res = await repo.updateWhere('leads', { id: leadId, ticketState: lead.ticketState || '' }, {
        ticketState: TICKET_STATE.INVALID,
        status: LEAD_STATUS.CLOSED,
        csStatus: CS_STATUS.ENDED,
        assignedTo: lead.assignedTo || staff.name,
        assignedAccount: lead.assignedAccount || accountId,
        closedAt: at,
        closedBy: staff.name,
        closeReason: note || '咨询条件不成立，标记无效',
        updatedAt: at
      })
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '咨询状态已变化，请刷新后重试')
      if (state === TICKET_STATE.CONSULTING) {
        await repo.insert('outbox', {
          id: 'M' + sha256Hex('cs-dismiss:' + leadId).slice(0, 22),
          type: 'kf.chat',
          payload: {
            uid: lead.uid,
            channel: 'kf',
            from: 'system',
            staffName: staff.name,
            threadId: lead.threadId || leadId,
            targetType: 'agency',
            targetId: lead.targetId || lead.agencyId || '',
            title: lead.agencyTitle || '',
            body: note ? `本次咨询已结束：${note}` : '本次咨询已结束，感谢你的咨询',
            csStatus: CS_STATUS.ENDED
          },
          status: 'pending',
          createdAt: at
        })
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: accountId,
        action: 'consult.dismiss',
        target: leadId,
        reason: note ? `标记无效：${note}` : '标记无效',
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return { leadId, ticketState: TICKET_STATE.INVALID, already: false }
    },

    /**
     * 结束代采代售咨询服务：仅领取人本人或管理员可结束。
     * 结束后用户端会话锁输入并弹出评价入口，评价回写客服档案。
     */
    'lead.endService': async (data, ctx) => {
      const session = ctx.session
      const accountId = (session && session.accountId) || ''
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询可以结束服务')
      if (csStatusOf(lead) === CS_STATUS.ENDED) {
        return { leadId, csStatus: CS_STATUS.ENDED, already: true, csEndedAt: Number(lead.csEndedAt) || 0 }
      }
      if (!isAdminSession(session) && lead.assignedAccount !== accountId) {
        throw new AppError(CODES.FORBIDDEN, '只有领取该咨询的客服可以结束服务')
      }
      const at = now()
      let staff = { name: lead.csName || lead.assignedTo || '' }
      try {
        staff = await resolveStaff(accountId)
      } catch (staffErr) { /* 引导账号未落在账号表时退回线索上的领取人 */ }
      /* 阶段收口：服务费已到账 → 已完成；其余阶段结束即终止（该单不计佣金） */
      const currentStage = consultStageOf(lead)
      if (currentStage !== CONSULT_STAGE.DONE && currentStage !== CONSULT_STAGE.ABORTED) {
        const reason = str(data.reason, { field: '结束原因', max: 100 })
        const closing = currentStage === CONSULT_STAGE.PAID
        await advanceConsultStage(repo, lead, closing ? CONSULT_STAGE.DONE : CONSULT_STAGE.ABORTED, {
          at,
          by: accountId || 'admin',
          note: closing ? '服务费已到账，服务完成' : `客服结束服务${reason ? `：${reason}` : ''}`,
          extra: closing
            ? { completedAt: at }
            : { abortedAt: at, abortReason: reason || '客服结束服务' }
        })
      }
      const patch = {
        csStatus: CS_STATUS.ENDED,
        csEndedAt: at,
        csEndedBy: accountId || 'admin',
        csEndedByName: staff.name || '',
        status: LEAD_STATUS.CLOSED,
        updatedAt: at
      }
      /* 未生成工单就结束服务：按无效咨询收口，避免一直挂在「磋商中」却没有出口 */
      if (ticketStateOf(lead) !== TICKET_STATE.TICKETED) {
        patch.ticketState = TICKET_STATE.INVALID
        patch.closedAt = at
        patch.closeReason = '磋商未达成，客服结束服务'
      }
      const res = await repo.updateWhere('leads', { id: leadId }, patch)
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '咨询单状态已更新，请刷新后重试')
      await repo.insert('outbox', {
        id: 'M' + sha256Hex('cs-end:' + leadId).slice(0, 22),
        type: 'kf.chat',
        payload: {
          uid: lead.uid,
          channel: 'kf',
          from: 'system',
          staffName: staff.name || '',
          threadId: lead.threadId || leadId,
          targetType: 'agency',
          targetId: lead.targetId || lead.agencyId || '',
          title: lead.agencyTitle || '',
          body: '本次咨询服务已结束，请对客服服务进行评价',
          csStatus: CS_STATUS.ENDED,
          askRating: true
        },
        status: 'pending',
        createdAt: at
      })
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: accountId || 'admin',
        action: 'lead.endService',
        target: leadId,
        reason: '结束咨询服务',
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return { leadId, csStatus: CS_STATUS.ENDED, already: false, csEndedAt: at }
    },

    /**
     * 咨询工单列表：用户从代采 / 代售发来的咨询直接生成工单，按标准流程分栏
     * （待领取 / 沟通中 / 合同待审核 / 待成交确认 / 待付服务费 / 已完成）。
     */
    'consult.list': async (data, ctx) => {
      const session = ctx && ctx.session
      const accountId = (session && session.accountId) || ''
      const admin = isAdminSession(session)
      const paging = normalizePaging(data)
      const all = await repo.find('leads', { targetType: 'agency' }, { limit: 100000 })
      /* 用户从代采 / 代售发来的咨询会直接生成工单：未领取的在「待领取」分栏，领取后进入正常流程 */
      /* 工作台只承载进行中的业务：已完成 / 已终止 / 已关闭的工单不再占用分栏，改到「代采代售」按工单状态查看 */
      const tickets = all.filter((lead) => {
        if (ticketStateOf(lead) !== TICKET_STATE.TICKETED) return false
        if (lead.status === LEAD_STATUS.BLOCKED || lead.status === LEAD_STATUS.CLOSED) return false
        const stage = consultStageOf(lead)
        return stage !== CONSULT_STAGE.DONE && stage !== CONSULT_STAGE.ABORTED
      })
      /* 合同待审核：只有「合同待审核」阶段需要查合同，批量取一次避免逐单查询 */
      const contractLeads = tickets.filter((lead) => consultStageOf(lead) === CONSULT_STAGE.CONTRACT)
      const contractRows = contractLeads.length
        ? await repo.find('agencyContracts', { leadId: { $in: contractLeads.map((lead) => lead.id) } }, { limit: 100000 })
        : []
      const contractByLead = new Map()
      contractRows.forEach((row) => {
        const prev = contractByLead.get(row.leadId)
        if (!prev || (Number(row.version) || 0) > (Number(prev.version) || 0)) {
          contractByLead.set(row.leadId, row)
        }
      })
      const bucketOf = (lead) => {
        const stage = consultStageOf(lead)
        /* 未领取优先归入「待领取」，避免按阶段散落到各分栏里找不到 */
        if (!lead.assignedAccount) return 'unclaimed'

        /* 合同待审核单独成栏，管理员从工作台弹窗可直接落到这一栏处理 */
        if (stage === CONSULT_STAGE.CONTRACT) {
          const contract = contractByLead.get(lead.id)
          return contract && contract.status === CONTRACT_STATUS.PENDING ? 'review' : 'contract'
        }
        /* 合同进度栏覆盖「条件已确认 / 合同已归档」两个阶段 */
        if (stage === CONSULT_STAGE.TERMS || stage === CONSULT_STAGE.SIGNED) return 'contract'
        return stage
      }
      /* 客服可见全部待领取工单（先领后做）+ 自己领取的工单；管理员看全部 */
      const visible = tickets.filter((lead) => {
        if (admin) return true
        return !lead.assignedAccount || lead.assignedAccount === accountId
      })
      const counts = { unclaimed: 0, communicating: 0, contract: 0, review: 0, deal_pending: 0, fee: 0, paid: 0, all: visible.length }
      visible.forEach((lead) => {
        const key = bucketOf(lead)
        counts[key] = (counts[key] || 0) + 1
      })
      const tab = data.tab ? str(data.tab, { field: '分栏', max: 32 }) : 'all'
      if (tab !== 'all' && counts[tab] === undefined) {
        throw new AppError(CODES.VALIDATION, '未知的工单分栏')
      }
      const q = data.q ? str(data.q, { field: '关键词', max: 30 }) : ''
      let list = tab === 'all' ? visible.slice() : visible.filter((lead) => bucketOf(lead) === tab)
      if (q) {
        list = list.filter((lead) => String(lead.agencyTitle || lead.formSummary || '').indexOf(q) >= 0)
      }
      const timeOf = (lead) => Number(lead.stageAt) || Number(lead.updatedAt) || Number(lead.createdAt) || 0
      /* 同一委托的对接人数：工单卡片直接显示「N 人咨询 / M 人在对接」，客服一眼看出竞争情况 */
      const agencyStats = new Map()
      all.forEach((lead) => {
        const key = String(lead.agencyId || lead.targetId || '')
        if (!key) return
        const stat = agencyStats.get(key) || { total: 0, active: 0 }
        stat.total += 1
        if (lead.status !== LEAD_STATUS.CLOSED && lead.status !== LEAD_STATUS.BLOCKED &&
          ticketStateOf(lead) !== TICKET_STATE.INVALID &&
          consultStageOf(lead) !== CONSULT_STAGE.DONE && consultStageOf(lead) !== CONSULT_STAGE.ABORTED) {
          stat.active += 1
        }
        agencyStats.set(key, stat)
      })
      list.sort((a, b) => timeOf(b) - timeOf(a))
      const total = list.length
      const items = []
      for (const lead of list.slice(paging.skip, paging.skip + paging.limit)) {
        const view = await staffLeadView(lead)
        const contract = contractByLead.get(lead.id)
        /* 未领取的工单统一显示「待领取」，不提前暴露沟通中阶段 */
        const unclaimed = !lead.assignedAccount
        const stat = agencyStats.get(String(lead.agencyId || lead.targetId || '')) || { total: 0, active: 0 }
        items.push({
          leadId: lead.id,
          agencyId: view.agencyId || '',
          title: maskSensitiveText(String(view.targetTitle || '')),
          sideLabel: view.sideLabel,
          amount: Number(lead.dealAmount) || Number(view.amount) || 0,
          csStatus: view.csStatus,
          csName: view.csName,
          unclaimed,
          stage: unclaimed ? '' : view.serviceStage,
          stageLabel: unclaimed ? '待领取' : view.serviceStageLabel,
          stageAt: timeOf(lead),
          agencyStatus: view.agencyStatus || '',
          feeStatus: view.feeStatus || '',
          rating: view.rating || 0,
          createdAt: Number(lead.createdAt) || 0,
          /* 列表卡片底部直接给出可执行状态，按钮仍统一放在卡片底部操作区 */
          ownerName: lead.assignedTo || lead.csName || '',
          contractStatus: contract ? String(contract.status || '') : '',
          contractVersion: contract ? Number(contract.version) || 0 : 0,
          /* 同一委托有多少人咨询 / 多少人在对接中 */
          consultTotal: stat.total,
          consultActive: stat.active
        })
      }
      return {
        items,
        page: paging.page,
        limit: paging.limit,
        total,
        hasMore: paging.skip + items.length < total,
        tab,
        counts
      }
    },

    /**
     * 咨询工单详情：左对话右信息的数据源。
     * 右栏 = 委托内容 + 双方掩码名片 + 居间合同 + 服务费账单 + 阶段时间线。
     */
    'consult.detail': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询有标准流程')
      consultOperator(lead, ctx)
      const detail = await consultDetailOf(lead)
      /* 同一委托的对接情况：客服能直接看到还有几家在对接、各自停在什么阶段、谁已锁定 */
      const agencyId = String(lead.agencyId || lead.targetId || '')
      if (agencyId) {
        const siblings = await repo.find('leads', { targetType: 'agency', agencyId }, { limit: 500 })
        const endsOf = (row) => row.status === LEAD_STATUS.CLOSED || row.status === LEAD_STATUS.BLOCKED ||
          ticketStateOf(row) === TICKET_STATE.INVALID ||
          consultStageOf(row) === CONSULT_STAGE.DONE || consultStageOf(row) === CONSULT_STAGE.ABORTED
        const agency = await repo.get('agencies', agencyId)
        const lockedLeadId = String((agency && agency.lockedLeadId) || '')
        const active = siblings.filter((row) => !endsOf(row))
        detail.agencyThreads = {
          total: siblings.length,
          active: active.length,
          closed: siblings.length - active.length,
          agencyStatus: (agency && agency.status) || '',
          lockedLeadId,
          isLockedLead: lockedLeadId === String(lead.id)
        }
        detail.peers = siblings
          .slice()
          .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
          .map((row, idx) => ({
            leadId: row.id,
            no: idx + 1,
            current: row.id === lead.id,
            csName: row.csName || row.assignedTo || '',
            stage: endsOf(row) ? 'closed' : consultStageOf(row),
            stageLabel: endsOf(row) ? '已结束' : consultStageLabel(consultStageOf(row)),
            status: row.status || '',
            locked: lockedLeadId === String(row.id),
            createdAt: Number(row.createdAt) || 0
          }))
      }
      return detail
    },

    /**
     * 查看双方联系方式：客服沟通必须看到明文，但每次查看都留审计，
     * 便于事后核对「谁在什么时候看了谁的电话」。
     */
    'consult.reveal': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询有联系方式')
      const accountId = consultOperator(lead, ctx)
      const agencyId = lead.agencyId || lead.targetId || ''
      const agency = agencyId ? await repo.get('agencies', agencyId) : null
      const ownerUid = (agency && agency.ownerId) || ''
      const [consult, owner] = await Promise.all([
        resolveChatCard({ uid: lead.uid }, lead.uid),
        ownerUid ? resolveChatCard({ uid: ownerUid }, ownerUid) : null
      ])
      await appendAudit(repo, {
        /* 审计要能追到具体岗位：客服查看与管理员查看必须可区分 */
        actorType: ctx.role === ROLES.CS ? 'cs' : 'admin',
        actorId: accountId,
        action: 'consult.reveal',
        target: leadId,
        reason: str(data.reason, { field: '查看原因', max: 100 }) || '客服沟通需要',
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      return {
        leadId,
        parties: {
          consult: Object.assign({}, consult, { role: '对接方', masked: false }),
          owner: owner ? Object.assign({}, owner, { role: '委托方', masked: false }) : null
        }
      }
    },

    /**
     * 条件确认：客服在沟通中确认成交金额、交付与付款方式后落库。
     * 金额一旦确认即成为成交金额，后续成交确认、服务费与佣金都以它为口径。
     */
    'consult.terms': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询有标准流程')
      const accountId = consultOperator(lead, ctx)
      assertConsultStage(lead, CONSULT_STAGE.COMMUNICATING, '请先完成沟通并确认条件')
      const amount = Number(data.amount)
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
        throw new AppError(CODES.VALIDATION, '请填写正确的成交金额')
      }
      const at = now()
      const by = await consultOperatorName(accountId, lead)
      const terms = {
        amount: Math.round(amount * 100) / 100,
        delivery: str(data.delivery, { field: '交付方式', max: 100 }),
        payment: str(data.payment, { field: '付款方式', max: 100 }),
        condition: str(data.condition, { field: '确认条件', max: 500 }),
        remark: str(data.remark, { field: '备注', max: 500 }),
        confirmedAt: at,
        confirmedBy: accountId,
        confirmedByName: by
      }
      const updated = await advanceConsultStage(repo, lead, CONSULT_STAGE.TERMS, {
        at,
        by,
        note: '双方条件已确认',
        extra: { terms, dealAmount: terms.amount }
      })
      return {
        leadId,
        stage: updated.serviceStage,
        stageLabel: consultStageLabel(updated.serviceStage),
        terms,
        actions: consultActionsOf(updated.serviceStage)
      }
    },

    /**
     * 居间合同上传：纯线下签署，客服把双方签章的扫描件传上来，管理员审核。
     * 同一工单只有一行合同，驳回重传按版本叠加（version + 1）。
     */
    'consult.contractSubmit': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询需要居间合同')
      const accountId = consultOperator(lead, ctx)
      const stage = consultStageOf(lead)
      if (stage !== CONSULT_STAGE.TERMS && stage !== CONSULT_STAGE.CONTRACT) {
        throw new AppError(CODES.CONFLICT, `当前阶段为「${consultStageLabel(stage)}」，请先确认成交条件`)
      }
      const fileId = fileRef(data.fileId || data.file)
      if (!fileId) throw new AppError(CODES.VALIDATION, '请上传双方签章的居间合同扫描件')
      const fileSize = Math.max(0, Math.floor(Number(data.fileSize) || 0))
      /* 与上传接口一致：PDF 上限 20MB（见 server/index.js 的 UPLOAD_MAX） */
      if (fileSize > 20 * 1024 * 1024) throw new AppError(CODES.VALIDATION, '合同文件不能超过 20MB')
      const signDate = str(data.signDate, { field: '签约日期', max: 20 })
      if (!/^\d{4}-\d{2}-\d{2}$/.test(signDate)) {
        throw new AppError(CODES.VALIDATION, '请填写签约日期（YYYY-MM-DD）')
      }
      const at = now()
      const by = await consultOperatorName(accountId, lead)
      const rows = await repo.find('agencyContracts', { leadId }, { limit: 1 })
      const existing = rows[0] || null
      const version = (existing ? Number(existing.version) || 1 : 0) + 1
      const doc = {
        leadId,
        agencyId: lead.agencyId || lead.targetId || '',
        csId: accountId,
        csName: by,
        version,
        status: CONTRACT_STATUS.PENDING,
        fileId,
        fileName: str(data.fileName || data.name, { field: '合同文件名', max: 120 }),
        fileSize,
        signDate,
        note: str(data.note, { field: '备注', max: 500 }),
        submittedBy: accountId,
        submittedByName: by,
        submittedAt: at,
        reviewedBy: '',
        reviewedByName: '',
        reviewedAt: 0,
        reviewNote: '',
        updatedAt: at
      }
      const contractId = existing ? existing.id : 'CT' + sha256Hex(`agency-contract:${leadId}`).slice(0, 22)
      if (existing) {
        await repo.updateWhere('agencyContracts', { id: existing.id }, doc)
      } else {
        await repo.insert('agencyContracts', Object.assign({ id: contractId, createdAt: at }, doc))
      }
      let updated = lead
      if (stage === CONSULT_STAGE.TERMS) {
        updated = await advanceConsultStage(repo, lead, CONSULT_STAGE.CONTRACT, {
          at,
          by,
          note: `合同已上传（第 ${version} 版）`,
          extra: { contractId }
        })
      } else {
        /* 审核期间替换件：只更新合同版本，阶段保持「合同待审核」 */
        await repo.updateWhere('leads', { id: lead.id }, { contractId, updatedAt: at })
      }
      return {
        leadId,
        contractId,
        version,
        stage: updated.serviceStage,
        stageLabel: consultStageLabel(updated.serviceStage),
        actions: consultActionsOf(updated.serviceStage)
      }
    },

    /**
     * 确定唯一对接方：居间合同上传后、审核前手动执行（管理员或跟进该工单的客服）。
     * 委托立即退出商机池，同委托其他对接方的工单关闭、待审核合同作废，
     * 并给这些用户发「已售出」消息；重复点击保持幂等。
     */
    'contract.lock': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      /* 管理员审批时确定，或由跟进该工单的客服一键结束其他对接；其他客服不能越权操作 */
      const session = (ctx && ctx.session) || {}
      const accountId = session.accountId || ''
      const isOwner = !!accountId && lead.assignedAccount === accountId
      if (!isAdminSession(session) && !isOwner) {
        throw new AppError(CODES.FORBIDDEN, '只有该工单的跟进客服或管理员可以确定唯一对接方')
      }
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询需要确定唯一对接方')
      if ([LEAD_STATUS.BLOCKED, LEAD_STATUS.CLOSED].indexOf(lead.status) >= 0) {
        throw new AppError(CODES.CONFLICT, `当前咨询单状态为「${lead.status}」，不能确定唯一对接方`)
      }
      assertConsultStage(lead, CONSULT_STAGE.CONTRACT, '请先上传居间合同，再确定唯一对接方')
      const contract = (await repo.find('agencyContracts', { leadId }, { limit: 1 }))[0]
      if (!contract) throw new AppError(CODES.NOT_FOUND, '合同尚未上传，不能确定唯一对接方')
      if (contract.status !== CONTRACT_STATUS.PENDING) {
        throw new AppError(CODES.CONFLICT, `合同当前状态为「${contract.status}」，不能确定唯一对接方`)
      }
      const at = now()
      const by = await consultOperatorName(accountId, lead)
      const locked = await lockAgencyForContract(repo, { lead, at, by })
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: accountId,
        action: 'contract.lock',
        target: leadId,
        reason: locked.locked
          ? `确定唯一对接方，结束其他 ${locked.closedOthers || 0} 家对接`
          : '确定唯一对接方（已锁定，重复提交）',
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return {
        leadId,
        locked: !!locked.locked,
        already: locked.reason === 'already',
        closedOthers: Number(locked.closedOthers) || 0,
        agencyStatus: AGENCY_STATUS.LOCKED,
        stage: consultStageOf(lead),
        stageLabel: consultStageLabel(consultStageOf(lead)),
        actions: consultActionsOf(consultStageOf(lead))
      }
    },

    /** 居间合同审核：先手动确定唯一对接方，再归档并进入待成交确认；驳回退回条件确认并写明原因 */
    'contract.review': async (data, ctx) => {
      if (!isAdminSession(ctx.session)) throw new AppError(CODES.FORBIDDEN, '居间合同由管理员审核')
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询需要审核合同')
      const rows = await repo.find('agencyContracts', { leadId }, { limit: 1 })
      const contract = rows[0]
      if (!contract) throw new AppError(CODES.NOT_FOUND, '合同尚未上传')
      if (contract.status !== CONTRACT_STATUS.PENDING) {
        throw new AppError(CODES.CONFLICT, `合同当前状态为「${contract.status}」，不能重复审核`)
      }
      const decision = enumOf(data.decision, ['approve', 'reject'], '审核结果')
      const at = now()
      const accountId = (ctx.session && ctx.session.accountId) || 'admin'
      const by = await consultOperatorName(accountId, lead)
      if (decision === 'approve') {
        assertConsultStage(lead, CONSULT_STAGE.CONTRACT, '只有合同待审核的工单可以归档')
        /* 唯一对接方由管理员在「合同已上传、待审核」阶段手动确定（contract.lock）：
           未确定时不允许归档，避免商机还挂在商机池里、多家同时拿合同去成交 */
        const agencyId = String(lead.agencyId || lead.targetId || '')
        const agency = agencyId ? await repo.get('agencies', agencyId) : null
        const lockedHere = !!agency && String(agency.lockedLeadId || '') === String(lead.id)
        if (agency && agency.status === AGENCY_STATUS.LOCKED && !lockedHere) {
          throw new AppError(CODES.CONFLICT, '该委托已确定其他对接方，本合同不能归档')
        }
        const settled = !!agency && [AGENCY_STATUS.DEALT, AGENCY_STATUS.DONE, AGENCY_STATUS.CLOSED].indexOf(agency.status) >= 0
        if (!lockedHere && !settled) {
          throw new AppError(CODES.CONFLICT, '请先确定唯一对接方（一键结束其他对接）后再审核通过居间合同')
        }
        const moved = await repo.updateWhere('agencyContracts', { id: contract.id, status: CONTRACT_STATUS.PENDING }, {
          status: CONTRACT_STATUS.APPROVED,
          reviewedBy: accountId,
          reviewedByName: by,
          reviewedAt: at,
          signedAt: at,
          reviewNote: str(data.note, { field: '审核说明', max: 200 }),
          updatedAt: at
        })
        /* 并发审核 / 重复点击：合同已被他人处理时不能继续推进工单阶段 */
        if (!moved || moved.count === 0) {
          throw new AppError(CODES.CONFLICT, '合同状态已变更，请刷新后重试')
        }
        const updated = await advanceConsultStage(repo, lead, CONSULT_STAGE.SIGNED, {
          at,
          by,
          note: '居间合同审核通过，已归档',
          extra: { signedAt: at, contractId: contract.id }
        })
        return {
          leadId,
          status: CONTRACT_STATUS.APPROVED,
          stage: updated.serviceStage,
          stageLabel: consultStageLabel(updated.serviceStage),
          /* 唯一对接方已在审核前由管理员手动确定；其余对接方工单已置为无效 */
          agencyLocked: lockedHere,
          actions: consultActionsOf(updated.serviceStage)
        }
      }
      const reason = str(data.note || data.reason, { field: '驳回原因', required: true, max: 200 })
      const moved = await repo.updateWhere('agencyContracts', { id: contract.id, status: CONTRACT_STATUS.PENDING }, {
        status: CONTRACT_STATUS.REJECTED,
        reviewedBy: accountId,
        reviewedByName: by,
        reviewedAt: at,
        reviewNote: reason,
        updatedAt: at
      })
      if (!moved || moved.count === 0) {
        throw new AppError(CODES.CONFLICT, '合同状态已变更，请刷新后重试')
      }
      const updated = await advanceConsultStage(repo, lead, CONSULT_STAGE.TERMS, {
        at,
        by,
        note: `合同驳回：${reason}`,
        extra: { contractId: contract.id }
      })
      return {
        leadId,
        status: CONTRACT_STATUS.REJECTED,
        reviewNote: reason,
        stage: updated.serviceStage,
        stageLabel: consultStageLabel(updated.serviceStage),
        actions: consultActionsOf(updated.serviceStage)
      }
    },

    /**
     * 登记成交：合同归档后由客服核实成交金额并直接确认成交（平台确认，委托方只收成交通知）。
     * 确认后按成交金额计提服务费、生成后付费账单，工单自动进入「服务费待支付」。
     */
    'consult.proposeDeal': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询可以登记成交')
      const accountId = consultOperator(lead, ctx)
      const stage = consultStageOf(lead)
      /* 兼容升级前停在「待确认成交」的历史工单：允许客服在此直接补确认 */
      if (stage !== CONSULT_STAGE.SIGNED && stage !== CONSULT_STAGE.DEAL_PENDING) {
        throw new AppError(CODES.CONFLICT, '请先完成居间合同归档，再登记成交')
      }
      const agencyId = lead.agencyId || lead.targetId || ''
      const agency = agencyId ? await repo.get('agencies', agencyId) : null
      if (!agency) throw new AppError(CODES.NOT_FOUND, '委托不存在')
      const amount = Number(data.amount) || Number(lead.dealAmount) || Number(agency.amount) || 0
      if (!(amount > 0)) throw new AppError(CODES.VALIDATION, '请先确认成交金额')
      const at = now()
      const by = await consultOperatorName(accountId, lead)
      await confirmAgencyDeal(repo, {
        agencyId: agency.id,
        amount,
        at,
        staff: by,
        staffId: accountId,
        actorType: 'admin'
      })
      const fresh = await loadLead(leadId)
      const nextStage = consultStageOf(fresh)
      return {
        leadId,
        stage: nextStage,
        stageLabel: consultStageLabel(nextStage),
        actions: consultActionsOf(nextStage)
      }
    },

    /**
     * 服务费凭证：线下打款后由客服上传转账凭证，财务在「支付记录」里确认到账。
     * 只允许在「服务费待支付」阶段上传，避免账单还没生成就传错。
     */
    'consult.uploadProof': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询需要服务费凭证')
      const accountId = consultOperator(lead, ctx)
      assertConsultStage(lead, CONSULT_STAGE.FEE, '服务费账单还没生成，暂时不能上传凭证')
      const incoming = (Array.isArray(data.files) ? data.files : [data.fileId || data.file])
        .map((item) => fileRef(item))
        .filter(Boolean)
      if (!incoming.length) throw new AppError(CODES.VALIDATION, '请上传服务费转账凭证')
      const agencyId = lead.agencyId || lead.targetId || ''
      const agency = agencyId ? await repo.get('agencies', agencyId) : null
      if (!agency) throw new AppError(CODES.NOT_FOUND, '委托不存在')
      const billId = agency.feeBillId || `PY_AG_${agency.id}`
      const bill = await repo.get('payments', billId)
      if (!bill) throw new AppError(CODES.CONFLICT, '服务费账单尚未生成，请先登记成交')
      const at = now()
      const existing = Array.isArray(bill.proofFiles) ? bill.proofFiles.slice() : (bill.proofFileId ? [bill.proofFileId] : [])
      const files = existing.concat(incoming.filter((item) => existing.indexOf(item) < 0))
      if (files.length > 5) throw new AppError(CODES.VALIDATION, '服务费凭证最多上传 5 个')
      const fileId = files[files.length - 1]
      const patch = {
        proofFiles: files,
        proofFileId: fileId,
        proofFileName: str(data.fileName || data.name, { field: '凭证文件名', max: 120 }),
        proofNote: str(data.note, { field: '备注', max: 200 }),
        proofAt: at,
        proofBy: accountId,
        updatedAt: at
      }
      const res = await repo.updateWhere('payments', { id: billId, status: bill.status }, patch)
      if (!res || !res.count) throw new AppError(CODES.CONFLICT, '账单状态已变化，请刷新后重试')
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: accountId,
        action: 'consult.uploadProof',
        target: billId,
        reason: '上传服务费凭证',
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return { leadId, billId, proofFileId: fileId, proofAt: at }
    },

    /** 合同 / 服务费凭证换临时链接：只允许该工单的领取人与管理员取用，且留审计 */
    'consult.fileUrls': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询有流程文件')
      const accountId = consultOperator(lead, ctx)
      const rows = await repo.find('agencyContracts', { leadId }, { limit: 1 })
      const agencyId = lead.agencyId || lead.targetId || ''
      const agency = agencyId ? await repo.get('agencies', agencyId) : null
      const bill = agency ? await repo.get('payments', agency.feeBillId || `PY_AG_${agency.id}`) : null
      const ids = []
      const add = (value) => {
        const id = fileRef(value)
        if (id && ids.indexOf(id) < 0) ids.push(id)
      }
      add(rows[0] && rows[0].fileId)
      if (rows[0] && Array.isArray(rows[0].files)) rows[0].files.forEach((item) => add(item && (item.fileId || item.id)))
      add(bill && bill.proofFileId)
      if (bill && Array.isArray(bill.proofFiles)) bill.proofFiles.forEach((item) => add(item))
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: accountId,
        action: 'consult.fileUrl',
        target: leadId,
        reason: `查看流程文件 ${ids.length} 个`,
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      const urls = {}
      for (const id of ids) {
        if (/^https:\/\//i.test(id)) { urls[id] = id; continue }
        if (!cloud || typeof cloud.getTempFileURL !== 'function') continue
        try {
          const res = await cloud.getTempFileURL({ fileList: [id] })
          const first = ((res && res.fileList) || [])[0]
          if (first && first.tempFileURL) urls[id] = first.tempFileURL
        } catch (err) { /* 换链失败时前端给出占位提示 */ }
      }
      return { leadId, urls }
    },

    /**
     * 服务费已到账 → 确认完成：这是整笔交易的唯一收尾动作。
     * 工单归档的同时把关联委托置为「已完成」，避免工单结束但委托仍挂在进行中。
     */
    'consult.complete': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询可以确认完成')
      const accountId = consultOperator(lead, ctx)
      assertConsultStage(lead, CONSULT_STAGE.PAID, '服务费未确认到账，不能标记完成')
      const at = now()
      const by = await consultOperatorName(accountId, lead)
      /* 委托与工单同点收尾：服务费到账后一次点击即结束交易 */
      const agencyId = lead.agencyId || lead.targetId || ''
      const agency = agencyId ? await repo.get('agencies', agencyId) : null
      if (agency && agency.status !== '已完成' && agency.status !== '已关闭') {
        const res = await repo.updateWhere('agencies', { id: agency.id, status: agency.status }, {
          status: '已完成',
          completedAt: at,
          completedBy: by,
          updatedAt: at
        })
        if (!res || !res.count) throw new AppError(CODES.CONFLICT, '委托状态已变化，请刷新后重试')
        await appendAudit(repo, {
          actorType: 'admin',
          actorId: accountId,
          action: 'agency.complete',
          target: agency.id,
          reason: '服务费到账，确认完成',
          ip: ctx.ip,
          result: 'allow',
          at
        })
      }
      const updated = await advanceConsultStage(repo, lead, CONSULT_STAGE.DONE, {
        at,
        by,
        note: '服务费已到账，咨询完成，委托同步归档',
        extra: { completedAt: at }
      })
      return {
        leadId,
        stage: updated.serviceStage,
        stageLabel: consultStageLabel(updated.serviceStage),
        actions: consultActionsOf(updated.serviceStage)
      }
    },

    /** 终止服务：客户不付款 / 条件谈不拢时由客服结束流程，工资不计该单佣金 */
    'consult.abort': async (data, ctx) => {
      const leadId = str(data.leadId || data.id, { field: '咨询单', required: true, max: 64 })
      const lead = await loadLead(leadId)
      if (lead.targetType !== 'agency') throw new AppError(CODES.VALIDATION, '只有代采代售咨询可以终止服务')
      const accountId = consultOperator(lead, ctx)
      const stage = consultStageOf(lead)
      if (stage === CONSULT_STAGE.DONE || stage === CONSULT_STAGE.ABORTED) {
        throw new AppError(CODES.CONFLICT, '该咨询已结束')
      }
      const reason = str(data.reason, { field: '终止原因', required: true, max: 200 })
      const at = now()
      const by = await consultOperatorName(accountId, lead)
      const updated = await advanceConsultStage(repo, lead, CONSULT_STAGE.ABORTED, {
        at,
        by,
        note: `终止服务：${reason}`,
        extra: { abortedAt: at, abortReason: reason }
      })
      return {
        leadId,
        stage: updated.serviceStage,
        stageLabel: consultStageLabel(updated.serviceStage),
        abortReason: reason,
        actions: consultActionsOf(updated.serviceStage)
      }
    },

    /** 坐席列表：分配 / 转派下拉、服务记录筛选共用 */
    'staff.list': async () => {
      const items = await listStaff()
      return { items, total: items.length }
    },

    /**
     * 客服业务总览：全局提成比例 + 每位客服的绑定用户、生效比例、业绩、提成与评分。
     * 「我的客服档案」页与管理员配置页共用这一份数据。
     */
    'cs.settings': async (data, ctx) => {
      const me = (ctx.session && ctx.session.accountId) || ''
      const onlyMine = !isAdminSession(ctx.session)
      const settings = await csEngine.readSettings()
      const staff = await listStaff()
      const bindings = await csEngine.listBindings()
      const bindingMap = new Map(bindings.map((row) => [row.csId, row]))
      const items = []
      for (const row of staff) {
        if (onlyMine && row.username !== me) continue
        const [stats, rateInfo] = await Promise.all([
          csEngine.statsOf(row.username),
          csEngine.rateOf(row.username)
        ])
        items.push(Object.assign({}, row, {
          csId: row.username,
          binding: bindingMap.get(row.username) || null,
          rate: rateInfo.rate,
          rateSource: rateInfo.source,
          stats
        }))
      }
      return {
        settings,
        items,
        total: items.length,
        ratingTags: RATING_TAGS.slice()
      }
    },

    /** 全局默认比例：会员提成与代采代售佣金分开配置，只有管理员可以调整 */
    'cs.saveSettings': async (data, ctx) => {
      if (!isAdminSession(ctx.session)) throw new AppError(CODES.FORBIDDEN, '仅管理员可以调整提成比例')
      const payload = {}
      if (data.rate !== undefined) payload.rate = data.rate
      if (data.agencyRate !== undefined) payload.agencyRate = data.agencyRate
      const saved = await csEngine.saveSettings(payload, (ctx.session && ctx.session.accountId) || '')
      const parts = [`会员提成 ${(saved.rate * 100).toFixed(1)}%`, `代采佣金 ${(saved.agencyRate * 100).toFixed(1)}%`]
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: (ctx.session && ctx.session.accountId) || 'admin',
        action: 'cs.saveSettings',
        target: 'cs:settings',
        reason: `全局比例 → ${parts.join(' / ')}`,
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      return saved
    },

    /** 客服单独提成比例：传空值即恢复按全局默认 */
    'cs.saveRate': async (data, ctx) => {
      if (!isAdminSession(ctx.session)) throw new AppError(CODES.FORBIDDEN, '仅管理员可以调整提成比例')
      const csId = str(data.csId, { field: '客服账号', required: true, max: 64 })
      const saved = await csEngine.saveRate(csId, data.rate, (ctx.session && ctx.session.accountId) || '')
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: (ctx.session && ctx.session.accountId) || 'admin',
        action: 'cs.saveRate',
        target: `cs:${csId}`,
        reason: `单独提成比例 → ${(saved.rate * 100).toFixed(1)}%（${saved.source}）`,
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      return saved
    },

    /** 客服单独佣金比例：与会员提成比例分开配置，传空值即恢复全局默认 */
    'cs.saveAgencyRate': async (data, ctx) => {
      if (!isAdminSession(ctx.session)) throw new AppError(CODES.FORBIDDEN, '仅管理员可以调整佣金比例')
      const csId = str(data.csId, { field: '客服账号', required: true, max: 64 })
      const saved = await csEngine.saveAgencyRate(csId, data.rate, (ctx.session && ctx.session.accountId) || '')
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: (ctx.session && ctx.session.accountId) || 'admin',
        action: 'cs.saveAgencyRate',
        target: `cs:${csId}`,
        reason: `代采代售佣金比例 → ${(saved.rate * 100).toFixed(1)}%（${saved.source}）`,
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      return saved
    },

    /**
     * 我的工资：分享开通提成 + 代采代售佣金，按自然月汇总。
     * 客服只能看自己的；管理员可按 csId 查任意客服（工资条核对）。
     */
    'cs.salary': async (data, ctx) => {
      const session = ctx.session
      const me = (session && session.accountId) || ''
      const csId = isAdminSession(session) && data.csId
        ? str(data.csId, { field: '客服账号', max: 64 })
        : me
      if (!csId) throw new AppError(CODES.UNAUTHORIZED, '请先登录')
      const monthKey = data.monthKey ? normalizeMonthKey(data.monthKey) : monthKeyOf(now())
      const [summary, rateInfo] = await Promise.all([
        csEngine.salaryOf(csId, monthKey),
        csEngine.agencyRateOf(csId)
      ])
      return Object.assign({}, summary, {
        agencyRate: rateInfo.rate,
        agencyRateSource: rateInfo.source,
        monthLabel: monthKey
      })
    },

    /** 绑定用户账号：一个客服只能绑一个用户，一个用户也只能归属一个客服 */
    'cs.bind': async (data, ctx) => {
      if (!isAdminSession(ctx.session)) throw new AppError(CODES.FORBIDDEN, '仅管理员可以绑定用户账号')
      const csId = str(data.csId, { field: '客服账号', required: true, max: 64 })
      const staff = await resolveStaff(csId)
      const doc = await csEngine.bind({
        csId: staff.username,
        csName: staff.name,
        uid: data.uid
      }, (ctx.session && ctx.session.accountId) || '')
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: (ctx.session && ctx.session.accountId) || 'admin',
        action: 'cs.bind',
        target: `cs:${staff.username}`,
        reason: `绑定用户 ${doc.uid}`,
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      return doc
    },

    'cs.unbind': async (data, ctx) => {
      if (!isAdminSession(ctx.session)) throw new AppError(CODES.FORBIDDEN, '仅管理员可以解绑用户账号')
      const csId = str(data.csId, { field: '客服账号', required: true, max: 64 })
      const out = await csEngine.unbind(csId)
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: (ctx.session && ctx.session.accountId) || 'admin',
        action: 'cs.unbind',
        target: `cs:${csId}`,
        reason: `解绑用户 ${out.uid}`,
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      return out
    },

    /** 提成流水：管理员可看全部，客服只能看自己的 */
    'cs.commissions': async (data, ctx) => {
      const csId = data.csId ? str(data.csId, { field: '客服账号', max: 64 }) : ''
      const me = (ctx.session && ctx.session.accountId) || ''
      const target = isAdminSession(ctx.session) ? csId : me
      if (!target) throw new AppError(CODES.VALIDATION, '请指定客服账号')
      const paging = normalizePaging(data)
      const result = await csEngine.commissionsOf(target, paging)
      return Object.assign({ csId: target }, result)
    },

    /** 评价记录：管理员可看全部，客服只能看自己的 */
    'cs.ratings': async (data, ctx) => {
      const csId = data.csId ? str(data.csId, { field: '客服账号', max: 64 }) : ''
      const me = (ctx.session && ctx.session.accountId) || ''
      const target = isAdminSession(ctx.session) ? csId : me
      if (!target) throw new AppError(CODES.VALIDATION, '请指定客服账号')
      const paging = normalizePaging(data)
      const result = await csEngine.ratingsOf(target, paging)
      return Object.assign({ csId: target }, result)
    },

    /**
     * 商品形式审核（可选操作，不是发布的前置路径）。
     * 通过 → 在售；驳回 → 已驳回（驳回必须填理由，并同步给货主）。
     * 商品发布后即可见，平台随时可进来审核或改状态。
     */
    'product.review': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.productId || data.id, { field: '商品', required: true, max: 64 })
      const decision = enumOf(data.decision, Object.values(REVIEW_DECISIONS), '审核结论')
      const reason = str(data.reason, { field: '审核意见', max: 100 })
      const product = await repo.get('products', id)
      if (!product) throw new AppError(CODES.NOT_FOUND, '商品不存在')
      /* 已下架 / 已成交是终态，不再受理审核 */
      if ([PRODUCT_STATUS.OFFLINE, PRODUCT_STATUS.DEALT].indexOf(product.status) >= 0) {
        throw new AppError(CODES.CONFLICT, `商品当前状态为「${product.status}」，不能审核`)
      }
      const to = decision === REVIEW_DECISIONS.APPROVE ? PRODUCT_STATUS.ON_SALE : PRODUCT_STATUS.REJECTED
      if (to === PRODUCT_STATUS.REJECTED && !reason) {
        throw new AppError(CODES.VALIDATION, '驳回必须填写审核意见')
      }
      if (product.status === to) {
        return { id, from: product.status, to, reason }
      }
      const res = await repo.updateWhere(
        'products',
        { id, status: product.status },
        { status: to, reviewReason: reason, reviewedAt: now() }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '商品状态已被更新，请刷新后重试')
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'product.review',
        target: `${id}:${product.status}->${to}`,
        reason,
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      /* 审核结论回传货主：驳回必须让货主知道原因，否则只能反复提交 */
      await notifyUser(product.ownerId, {
        title: to === PRODUCT_STATUS.ON_SALE ? '商品审核通过' : '商品被退回',
        body: to === PRODUCT_STATUS.ON_SALE
          ? `你的商品「${product.title}」已通过审核，当前状态：在售。`
          : `你的商品「${product.title}」未通过审核：${reason}。修改后可重新提交。`,
        targetType: 'product',
        targetId: id,
        reason
      })
      return { id, from: product.status, to, reason }
    },

    /**
     * 设置商品状态：平台可把商品改到任意目标状态（含下架 / 重新上架）。
     * 审核不是发布的前置路径——发布即在售，平台在这里做后续处置。
     * 下架与退回必须填理由，理由同步给货主（系统提示）。
     */
    'product.setStatus': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.productId || data.id, { field: '商品', required: true, max: 64 })
      const to = str(data.to, { field: '目标状态', required: true, max: 10 })
      const reason = str(data.reason, { field: '原因', max: 100 })
      const allowed = [
        PRODUCT_STATUS.ON_SALE, PRODUCT_STATUS.OFFLINE,
        PRODUCT_STATUS.REJECTED, PRODUCT_STATUS.NEGOTIATING
      ]
      if (allowed.indexOf(to) < 0) {
        throw new AppError(CODES.VALIDATION, `目标状态只能是 ${allowed.join(' / ')}`)
      }
      /* 下架 / 退回必须给理由：没有理由用户端无法知道怎么处理 */
      if ([PRODUCT_STATUS.OFFLINE, PRODUCT_STATUS.REJECTED].indexOf(to) >= 0 && !reason) {
        throw new AppError(CODES.VALIDATION, to === PRODUCT_STATUS.OFFLINE ? '下架必须选择或填写原因' : '退回必须填写审核意见')
      }
      const product = await repo.get('products', id)
      if (!product) throw new AppError(CODES.NOT_FOUND, '商品不存在')
      if (product.status === to) {
        return { id, from: product.status, to, reason }
      }
      const at = now()
      const res = await repo.updateWhere(
        'products',
        { id, status: product.status },
        {
          status: to,
          offlineReason: to === PRODUCT_STATUS.OFFLINE ? reason : '',
          reviewReason: to === PRODUCT_STATUS.REJECTED ? reason : '',
          offlineAt: to === PRODUCT_STATUS.OFFLINE ? at : 0,
          reviewedAt: now()
        }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '商品状态已被更新，请刷新后重试')
      /* 洽谈中下架视为放弃本单，联动关闭已对接线索 */
      if (product.status === PRODUCT_STATUS.NEGOTIATING && to === PRODUCT_STATUS.OFFLINE) {
        const matched = await matchedLeadOf('productId', id)
        for (const lead of matched) {
          await closeMatchedLead(lead, reason || '商品下架，视为放弃本单', at)
        }
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: to === PRODUCT_STATUS.OFFLINE ? 'product.offline' : 'product.review',
        target: `${id}:${product.status}->${to}`,
        reason,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      if (to === PRODUCT_STATUS.OFFLINE) {
        await notifyUser(product.ownerId, {
          title: '商品已被下架',
          body: `你的商品「${product.title}」已被平台下架，原因：${reason}。如需恢复请联系客服。`,
          targetType: 'product',
          targetId: id,
          reason
        })
      } else if (to === PRODUCT_STATUS.REJECTED) {
        await notifyUser(product.ownerId, {
          title: '商品被退回',
          body: `你的商品「${product.title}」未通过审核：${reason}。修改后可重新发布。`,
          targetType: 'product',
          targetId: id,
          reason
        })
      }
      return { id, from: product.status, to, reason }
    },

    /**
     * 商品强制下架：管理端选择理由即可下架，不受「必须先由货主下架」限制。
     * 已下架 / 已成交不可再下架；洽谈中下架视为放弃本单，联动关闭已对接线索。
     */
    'product.offline': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.productId || data.id, { field: '商品', required: true, max: 64 })
      const reason = str(data.reason, { field: '下架原因', max: 100 })
      if (!reason) throw new AppError(CODES.VALIDATION, '下架必须选择或填写原因')
      const product = await repo.get('products', id)
      if (!product) throw new AppError(CODES.NOT_FOUND, '商品不存在')
      const blocked = [PRODUCT_STATUS.OFFLINE, PRODUCT_STATUS.DEALT]
      if (blocked.includes(product.status)) {
        throw new AppError(CODES.CONFLICT, `商品当前状态为「${product.status}」，不能下架`)
      }
      const at = now()
      /* 先落商品状态（CAS），成功后再联动关闭线索：
         反序会在 CAS 失败时把线索关掉却留下在售商品，导致状态漂移 */
      const res = await repo.updateWhere(
        'products',
        { id, status: product.status },
        { status: PRODUCT_STATUS.OFFLINE, offlineReason: reason, offlineAt: at }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '商品状态已被更新，请刷新后重试')
      if (product.status === PRODUCT_STATUS.NEGOTIATING) {
        const matched = await matchedLeadOf('productId', id)
        for (const lead of matched) {
          await closeMatchedLead(lead, reason || '货主下架，视为放弃本单', at)
        }
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'product.offline',
        target: `${id}:${product.status}->${PRODUCT_STATUS.OFFLINE}`,
        reason,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      /* 下架理由同步给货主，用户端以系统提示展示 */
      await notifyUser(product.ownerId, {
        title: '商品已被下架',
        body: `你的商品「${product.title}」已被平台下架，原因：${reason}。如需恢复请联系客服。`,
        targetType: 'product',
        targetId: id,
        reason
      })
      return { id, from: product.status, to: PRODUCT_STATUS.OFFLINE, reason }
    },

    /** 商品重新上架：已下架 → 在售 */
    'product.online': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.productId || data.id, { field: '商品', required: true, max: 64 })
      const product = await repo.get('products', id)
      if (!product) throw new AppError(CODES.NOT_FOUND, '商品不存在')
      if (product.status !== PRODUCT_STATUS.OFFLINE) {
        throw new AppError(CODES.CONFLICT, `商品当前状态为「${product.status}」，不能重新上架`)
      }
      const res = await repo.updateWhere('products', { id, status: PRODUCT_STATUS.OFFLINE }, {
        status: PRODUCT_STATUS.ON_SALE,
        /* 重新上架后旧的「下架原因」不能再留在详情与列表里 */
        offlineReason: '',
        offlineAt: 0
      })
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '商品状态已被更新，请刷新后重试')
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'product.online',
        target: `${id}:${PRODUCT_STATUS.OFFLINE}->${PRODUCT_STATUS.ON_SALE}`,
        reason: '',
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      /* 恢复上架同样要告诉发布人，否则用户只看到状态莫名其妙变回在售 */
      if (product.ownerId) {
        try {
          await notifyUser(product.ownerId, {
            title: '货源已恢复上架',
            body: `你发布的「${product.title || '货源'}」已由平台恢复上架，现可在货盘中展示。`,
            targetType: 'product',
            targetId: id
          })
        } catch (notifyErr) { /* 状态已恢复：回执失败不回滚 */ }
      }
      return { id, from: PRODUCT_STATUS.OFFLINE, to: PRODUCT_STATUS.ON_SALE }
    },

    /**
     * 求购需求审核：待审核 →（通过）求购中 /（驳回）已驳回。
     * 驳回必须填写原因，结论同步给需求方。
     */
    'demand.review': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.demandId || data.id, { field: '求购需求', required: true, max: 64 })
      const decision = enumOf(data.decision, Object.values(REVIEW_DECISIONS), '审核结论')
      const reason = str(data.reason, { field: '审核意见', max: 100 })
      const demand = await repo.get('demands', id)
      if (!demand) throw new AppError(CODES.NOT_FOUND, '求购需求不存在')
      /* 已关闭 / 已下架是终态，不再受理审核 */
      if ([DEMAND_STATUS.CLOSED, DEMAND_STATUS.OFFLINE].indexOf(demand.status) >= 0) {
        throw new AppError(CODES.CONFLICT, `求购需求当前状态为「${demand.status}」，不能审核`)
      }
      const to = decision === REVIEW_DECISIONS.APPROVE ? DEMAND_STATUS.OPEN : DEMAND_STATUS.REJECTED
      if (to === DEMAND_STATUS.REJECTED && !reason) {
        throw new AppError(CODES.VALIDATION, '驳回必须填写审核意见')
      }
      if (demand.status === to) {
        return { id, from: demand.status, to, reason }
      }
      const res = await repo.updateWhere(
        'demands',
        { id, status: demand.status },
        { status: to, reviewReason: reason, reviewedAt: now() }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '求购需求状态已被更新，请刷新后重试')
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'demand.review',
        target: `${id}:${demand.status}->${to}`,
        reason,
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      await notifyUser(demand.ownerId, {
        title: to === DEMAND_STATUS.OPEN ? '需求审核通过' : '需求被退回',
        body: to === DEMAND_STATUS.OPEN
          ? `你的需求「${demand.title}」已通过审核，当前状态：求购中。`
          : `你的需求「${demand.title}」未通过审核：${reason}。修改后可重新发布。`,
        targetType: 'demand',
        targetId: id,
        reason
      })
      return { id, from: demand.status, to, reason }
    },

    /**
     * 设置需求状态：平台可把需求改到任意目标状态（含下架 / 重新上架 / 关闭）。
     * 审核不是发布的前置路径——发布即求购中，平台在这里做后续处置。
     * 下架与退回必须填理由，理由同步给需求方（系统提示）。
     */
    'demand.setStatus': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.demandId || data.id, { field: '求购需求', required: true, max: 64 })
      const to = str(data.to, { field: '目标状态', required: true, max: 10 })
      const reason = str(data.reason, { field: '原因', max: 100 })
      const allowed = [
        DEMAND_STATUS.OPEN, DEMAND_STATUS.OFFLINE,
        DEMAND_STATUS.REJECTED, DEMAND_STATUS.CLOSED
      ]
      if (allowed.indexOf(to) < 0) {
        throw new AppError(CODES.VALIDATION, `目标状态只能是 ${allowed.join(' / ')}`)
      }
      if ([DEMAND_STATUS.OFFLINE, DEMAND_STATUS.REJECTED].indexOf(to) >= 0 && !reason) {
        throw new AppError(CODES.VALIDATION, to === DEMAND_STATUS.OFFLINE ? '下架必须选择或填写原因' : '退回必须填写审核意见')
      }
      const demand = await repo.get('demands', id)
      if (!demand) throw new AppError(CODES.NOT_FOUND, '求购需求不存在')
      if (demand.status === to) {
        return { id, from: demand.status, to, reason }
      }
      const at = now()
      const res = await repo.updateWhere(
        'demands',
        { id, status: demand.status },
        {
          status: to,
          offlineReason: to === DEMAND_STATUS.OFFLINE ? reason : '',
          closeReason: to === DEMAND_STATUS.CLOSED ? reason : '',
          reviewReason: to === DEMAND_STATUS.REJECTED ? reason : '',
          offlineAt: to === DEMAND_STATUS.OFFLINE ? at : 0,
          closedAt: to === DEMAND_STATUS.CLOSED ? at : 0,
          reviewedAt: now()
        }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '求购需求状态已被更新，请刷新后重试')
      /* 已对接状态下架 / 关闭视为放弃本单，联动关闭已对接线索 */
      if (demand.status === DEMAND_STATUS.MATCHED && [DEMAND_STATUS.OFFLINE, DEMAND_STATUS.CLOSED].indexOf(to) >= 0) {
        const matched = await matchedLeadOf('demandId', id)
        for (const lead of matched) {
          await closeMatchedLead(lead, reason || '需求关闭', at)
        }
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: to === DEMAND_STATUS.OFFLINE ? 'demand.offline' : (to === DEMAND_STATUS.CLOSED ? 'demand.close' : 'demand.review'),
        target: `${id}:${demand.status}->${to}`,
        reason,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      if (to === DEMAND_STATUS.OFFLINE) {
        await notifyUser(demand.ownerId, {
          title: '需求已被下架',
          body: `你的需求「${demand.title}」已被平台下架，原因：${reason}。如需恢复请联系客服。`,
          targetType: 'demand',
          targetId: id,
          reason
        })
      } else if (to === DEMAND_STATUS.REJECTED) {
        await notifyUser(demand.ownerId, {
          title: '需求被退回',
          body: `你的需求「${demand.title}」未通过审核：${reason}。修改后可重新发布。`,
          targetType: 'demand',
          targetId: id,
          reason
        })
      } else if (to === DEMAND_STATUS.CLOSED) {
        await notifyUser(demand.ownerId, {
          title: '需求已关闭',
          body: `你的需求「${demand.title}」已被关闭，原因：${reason}。`,
          targetType: 'demand',
          targetId: id,
          reason
        })
      }
      return { id, from: demand.status, to, reason }
    },

    /**
     * 求购需求强制下架：管理端选理由即可下架（与「关闭」区分：下架保留需求记录并可重新上架）。
     * 已关闭 / 已驳回不可再下架；已对接下架视为放弃本单，联动关闭已对接线索。
     */
    'demand.offline': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.demandId || data.id, { field: '求购需求', required: true, max: 64 })
      const reason = str(data.reason, { field: '下架原因', max: 100 })
      if (!reason) throw new AppError(CODES.VALIDATION, '下架必须选择或填写原因')
      const demand = await repo.get('demands', id)
      if (!demand) throw new AppError(CODES.NOT_FOUND, '求购需求不存在')
      const blocked = [DEMAND_STATUS.CLOSED, DEMAND_STATUS.REJECTED, DEMAND_STATUS.OFFLINE]
      if (blocked.includes(demand.status)) {
        throw new AppError(CODES.CONFLICT, `求购需求当前状态为「${demand.status}」，不能下架`)
      }
      const at = now()
      const res = await repo.updateWhere(
        'demands',
        { id, status: demand.status },
        { status: DEMAND_STATUS.OFFLINE, offlineReason: reason, offlineAt: at }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '求购需求状态已被更新，请刷新后重试')
      if (demand.status === DEMAND_STATUS.MATCHED) {
        const matched = await matchedLeadOf('demandId', id)
        for (const lead of matched) {
          await closeMatchedLead(lead, reason || '需求下架，视为放弃本单', at)
        }
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'demand.offline',
        target: `${id}:${demand.status}->${DEMAND_STATUS.OFFLINE}`,
        reason,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      await notifyUser(demand.ownerId, {
        title: '需求已被下架',
        body: `你的需求「${demand.title}」已被平台下架，原因：${reason}。如需恢复请联系客服。`,
        targetType: 'demand',
        targetId: id,
        reason
      })
      return { id, from: demand.status, to: DEMAND_STATUS.OFFLINE, reason }
    },

    /** 关闭求购需求：求购中 / 已对接 → 已关闭；已对接时联动关闭该需求唯一的已对接线索 */
    'demand.close': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.demandId || data.id, { field: '求购需求', required: true, max: 64 })
      const reason = str(data.reason, { field: '关闭原因', max: 100 })
      if (!reason) throw new AppError(CODES.VALIDATION, '关闭必须选择或填写原因')
      const demand = await repo.get('demands', id)
      if (!demand) throw new AppError(CODES.NOT_FOUND, '求购需求不存在')
      const allowed = [DEMAND_STATUS.OPEN, DEMAND_STATUS.MATCHED]
      if (!allowed.includes(demand.status)) {
        throw new AppError(CODES.CONFLICT, `求购需求当前状态为「${demand.status}」，不能关闭`)
      }
      const at = now()
      /* 先落需求状态（CAS），成功后再联动关闭线索，避免半成功后状态漂移 */
      const res = await repo.updateWhere(
        'demands',
        { id, status: demand.status },
        { status: DEMAND_STATUS.CLOSED, closeReason: reason, closedAt: at }
      )
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '求购需求状态已被更新，请刷新后重试')
      if (demand.status === DEMAND_STATUS.MATCHED) {
        const matched = await matchedLeadOf('demandId', id)
        for (const lead of matched) {
          await closeMatchedLead(lead, reason || '需求关闭', at)
        }
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'demand.close',
        target: `${id}:${demand.status}->${DEMAND_STATUS.CLOSED}`,
        reason,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      await notifyUser(demand.ownerId, {
        title: '需求已关闭',
        body: `你的需求「${demand.title}」已被关闭，原因：${reason}。`,
        targetType: 'demand',
        targetId: id,
        reason
      })
      return { id, from: demand.status, to: DEMAND_STATUS.CLOSED, reason }
    },

    'product.list': async (data) => {
      const paging = normalizePaging(data)
      /* 用户已自行删除的内容不再出现在管理端列表，避免误下架 / 误审核 */
      const query = { deleted: { $ne: true } }
      if (data.cat) query.cat = str(data.cat, { field: '品类', max: 30 })
      if (data.tradeMode) query.tradeMode = enumOf(data.tradeMode, TRADE_MODE_OPTIONS.supply, '交易方式')
      const total = await repo.count('products', query)
      const rows = await repo.find('products', query, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: paging.skip,
        limit: paging.limit
      })
      const items = []
      /* 发布用户：商品列表的「发布人」要能对上用户档案，并支持跳转用户详情 */
      const userMap = await staffUserMap(rows.map((p) => p.ownerId), { withActivity: true })
      for (const p of rows) {
        const view = projectProductForStaff(p)
        view.ownerPhoneMasked = ownerPhoneMaskedOf(p)
        view.heat = await heatOf('productId', p.id)
        view.ownerId = p.ownerId || ''
        view.user = (p.ownerId && userMap.get(p.ownerId)) || null
        items.push(view)
      }
      const result = {
        items, page: paging.page, limit: paging.limit, total, hasMore: paging.skip + rows.length < total
      }
      assertNoPlaintextContact(result)
      return result
    },

    'demand.list': async (data) => {
      const paging = normalizePaging(data)
      const query = { deleted: { $ne: true } }
      if (data.status) query.status = str(data.status, { field: '状态', max: 10 })
      if (data.tradeMode) query.tradeMode = enumOf(data.tradeMode, TRADE_MODE_OPTIONS.demand, '交易方式')
      const total = await repo.count('demands', query)
      const rows = await repo.find('demands', query, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: paging.skip,
        limit: paging.limit
      })
      const items = []
      /* 发布用户：需求列表的「发布人」要能对上用户档案，并支持跳转用户详情 */
      const userMap = await staffUserMap(rows.map((d) => d.ownerId), { withActivity: true })
      for (const d of rows) {
        const view = projectDemand(d)
        view.media = mediaMeta(d.media)
        view.heat = await heatOf('demandId', d.id)
        view.ownerId = d.ownerId || ''
        view.user = (d.ownerId && userMap.get(d.ownerId)) || null
        items.push(view)
      }
      const result = {
        items, page: paging.page, limit: paging.limit, total, hasMore: paging.skip + rows.length < total
      }
      assertNoPlaintextContact(result)
      return result
    },

    /* 单条详情：用户详情里的历史发布跳转用，口径与列表完全一致 */
    'product.detail': async (data) => {
      const id = str(data.id || data.productId, { field: '商品', required: true, max: 64 })
      const doc = await repo.get('products', id)
      if (!doc || doc.deleted) throw new AppError(CODES.NOT_FOUND, '商品不存在或已删除')
      const view = projectProductForStaff(doc)
      view.ownerPhoneMasked = ownerPhoneMaskedOf(doc)
      view.heat = await heatOf('productId', doc.id)
      view.ownerId = doc.ownerId || ''
      const userMap = await staffUserMap([doc.ownerId], { withActivity: true })
      view.user = (doc.ownerId && userMap.get(doc.ownerId)) || null
      const result = { product: view }
      assertNoPlaintextContact(result)
      return result
    },

    'demand.detail': async (data) => {
      const id = str(data.id || data.demandId, { field: '需求', required: true, max: 64 })
      const doc = await repo.get('demands', id)
      if (!doc || doc.deleted) throw new AppError(CODES.NOT_FOUND, '需求不存在或已删除')
      const view = projectDemand(doc)
      view.media = mediaMeta(doc.media)
      view.heat = await heatOf('demandId', doc.id)
      view.ownerId = doc.ownerId || ''
      const userMap = await staffUserMap([doc.ownerId], { withActivity: true })
      view.user = (doc.ownerId && userMap.get(doc.ownerId)) || null
      const result = { demand: view }
      assertNoPlaintextContact(result)
      return result
    },

    'stats.overview': async () => {
      const byStatus = {}
      for (const status of Object.values(LEAD_STATUS)) {
        byStatus[status] = await repo.count('leads', { status })
      }
      const byTier = {}
      for (const tier of Object.values(TIERS)) {
        byTier[tier] = await repo.count('leads', { tier })
      }
      const leadsTotal = await repo.count('leads', {})
      /* 看板「在架 / 总数」两个口径：在架 = 对用户可见且仍可交易的状态 */
      const productsOnSale =
        (await repo.count('products', { status: PRODUCT_STATUS.ON_SALE })) +
        (await repo.count('products', { status: PRODUCT_STATUS.NEGOTIATING }))
      const demandsOpen =
        (await repo.count('demands', { status: DEMAND_STATUS.OPEN })) +
        (await repo.count('demands', { status: DEMAND_STATUS.MATCHED }))
      const stats = {
        products: await repo.count('products', {}),
        productsOnSale,
        demands: await repo.count('demands', {}),
        demandsOpen,
        blocked: await repo.count('blocked', {}),
        rulesEnabled: await repo.count('rules', { enabled: true }),
        leads: { total: leadsTotal, byStatus, byTier },
        conversion: {
          matched: byStatus[LEAD_STATUS.MATCHED] + byStatus[LEAD_STATUS.DEALT],
          dealt: byStatus[LEAD_STATUS.DEALT],
          rate: leadsTotal ? Math.round((byStatus[LEAD_STATUS.DEALT] / leadsTotal) * 100) : 0
        }
      }
      assertNoPlaintextContact(stats)
      return stats
    },

    /**
     * 举报 / 投诉 / 意见反馈：用户端 report.create 写入的队列。
     * 支持按状态 / 类型 / 关键词筛选，关键词同时匹配内容、对象名与联系方式。
     */
    'report.list': async (data) => {
      const paging = normalizePaging(data)
      const status = data.status ? enumOf(data.status, REPORT_STATUS_LIST, '状态') : ''
      const type = data.type ? enumOf(data.type, REPORT_TYPES, '类型') : ''
      const targetType = data.targetType ? enumOf(data.targetType, REPORT_TARGETS, '对象类型') : ''
      const q = String(data.q || '').trim().toLowerCase()
      /* 全量读取后再过滤：按 500 条采样会让更早的举报 / 反馈搜不到 */
      const all = await repo.find('reports', {}, { limit: 100000 })
      const counts = { 待处理: 0, 处理中: 0, 已处理: 0, 已驳回: 0 }
      all.forEach((row) => {
        const key = row.status || '待处理'
        if (counts[key] !== undefined) counts[key] += 1
      })
      const filtered = all
        .filter((row) => (!status || (row.status || '待处理') === status) && (!type || row.type === type) &&
          (!targetType || (row.targetType || 'other') === targetType))
        .filter((row) => {
          if (!q) return true
          return [row.content, row.targetTitle, row.contact, row.uid, row.type]
            .some((v) => String(v || '').toLowerCase().indexOf(q) >= 0)
        })
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      const items = []
      /* 举报对象要能落到具体账号：处置时可直接打开「调整账号」并限制发布 / 对话；
         同时把被举报对象的当前状态、标题等一并带回，前端打开举报详情即可看到商品当前形态 */
      const targetCache = new Map() /* key = type:id，value = { uid, doc, preview } */
      const targetCollection = { product: 'products', demand: 'demands', news: 'news' }
      for (const row of filtered.slice(paging.skip, paging.skip + paging.limit)) {
        let targetUid = ''
        let targetPreview = null
        const targetType = row.targetType || 'other'
        const targetId = row.targetId || ''
        if (targetType === 'owner') {
          targetUid = targetId
          const owner = await repo.get('users', targetId)
          if (owner) {
            targetPreview = { status: owner.status || '正常', title: owner.nickname || owner.username || targetId }
          }
        } else if (targetId && targetCollection[targetType]) {
          const cacheKey = targetType + ':' + targetId
          if (!targetCache.has(cacheKey)) {
            const doc = await repo.get(targetCollection[targetType], targetId)
            let preview = null
            if (doc) {
              preview = {
                status: doc.status || '',
                title: doc.title || doc.model || row.targetTitle || '',
                model: doc.model || '',
                price: Number(doc.price) || 0,
                offlineAt: Number(doc.offlineAt) || 0,
                offlineReason: doc.offlineReason || ''
              }
            }
            targetCache.set(cacheKey, { uid: (doc && doc.uid) || (doc && doc.ownerId) || '', doc, preview })
          }
          const cached = targetCache.get(cacheKey)
          targetUid = cached.uid
          targetPreview = cached.preview
        }
        items.push({
          id: row.id,
          type: row.type || '意见反馈',
          targetType,
          targetId,
          targetUid,
          targetTitle: row.targetTitle || '',
          content: row.content || '',
          contact: row.contact || '',
          uid: row.uid || '',
          status: row.status || '待处理',
          handlerNote: row.handlerNote || '',
          handledBy: row.handledBy || '',
          createdAt: Number(row.createdAt) || 0,
          handledAt: Number(row.handledAt) || 0,
          targetPreview
        })
      }
      return {
        items,
        total: filtered.length,
        page: paging.page,
        limit: paging.limit,
        counts,
        types: REPORT_TYPES,
        targetTypes: REPORT_TARGETS,
        statusList: REPORT_STATUS_LIST
      }
    },

    /**
     * 处置举报：处理中只表示已受理；已处理 / 已驳回必须填写说明。
     * 支持可选 targetAction：下架商品 / 退回草稿，执行后同步通知举报人 + 被举报人。
     */
    'report.handle': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.id, { field: '反馈标识', required: true, max: 64 })
      const status = enumOf(data.status, ['处理中', '已处理', '已驳回'], '处理结论')
      const note = str(data.note || '', { field: '处理说明', max: 300 })
      /* targetAction 可选：''/none（不动商品）、offline（下架）、pending（退回草稿/驳回）；向后兼容 */
      const targetAction = String(data.targetAction || '').trim()
      const validActions = ['', 'none', 'offline', 'pending', 'reject', 'remove']
      if (!validActions.includes(targetAction)) {
        throw new AppError(CODES.VALIDATION, 'targetAction 不合法：' + targetAction)
      }
      const normalizedAction = (targetAction === 'none' || targetAction === 'remove') ? '' : targetAction
      if (status !== '处理中' && !note) {
        throw new AppError(CODES.VALIDATION, '请填写处理说明，用户会收到这条回复')
      }
      if (normalizedAction && status !== '已处理') {
        throw new AppError(CODES.VALIDATION, '执行下架 / 退回等处置时结论必须为「已处理」')
      }
      const doc = await repo.get('reports', id)
      if (!doc) throw new AppError(CODES.NOT_FOUND, '该反馈不存在或已删除')
      const at = now()
      /* ---- 可选：联动处置被举报对象（下架 / 退回草稿） ---- */
      let targetResult = null
      let targetUid = ''
      const targetType = doc.targetType || 'other'
      const targetId = doc.targetId || ''
      const targetCollection = { product: 'products', demand: 'demands', news: 'news' }
      if (normalizedAction && targetId && targetCollection[targetType]) {
        /* 联动下架 / 退回属于内容处置：客服只有举报受理权，不能借举报单绕过内容下架权限 */
        const needAction = { product: 'product.offline', demand: 'demand.offline', news: 'news.offline' }[targetType]
        if (needAction && !(await staffCan(session, needAction))) {
          throw new AppError(CODES.FORBIDDEN, '处置被举报内容需要内容下架权限，请联系管理员')
        }
        const tDoc = await repo.get(targetCollection[targetType], targetId)
        if (!tDoc) throw new AppError(CODES.NOT_FOUND, '被举报对象已不存在，无法执行处置')
        targetUid = tDoc.uid || tDoc.ownerId || ''
        let newStatus = ''
        let newOfflineReason = ''
        if (normalizedAction === 'offline') {
          newStatus = targetType === 'product' ? PRODUCT_STATUS.OFFLINE : targetType === 'demand' ? DEMAND_STATUS.OFFLINE : '已下架'
          newOfflineReason = `举报核实：${note || doc.content || '违规内容'}`
        } else if (normalizedAction === 'pending' || normalizedAction === 'reject') {
          newStatus = targetType === 'product' ? PRODUCT_STATUS.REJECTED : targetType === 'demand' ? DEMAND_STATUS.REJECTED : '已驳回'
        }
        if (newStatus) {
          /* 如果对象当前已是终态（已下架/已驳回/已成交），跳过联动，只处置举报本身 */
          const blocked = [PRODUCT_STATUS.OFFLINE, PRODUCT_STATUS.DEALT, PRODUCT_STATUS.REJECTED,
            DEMAND_STATUS.OFFLINE, DEMAND_STATUS.CLOSED, DEMAND_STATUS.REJECTED]
          if (!blocked.includes(tDoc.status)) {
            const patch = { status: newStatus, updatedAt: at }
            if (newOfflineReason) { patch.offlineReason = newOfflineReason; patch.offlineAt = at }
            const upd = await repo.updateWhere(targetCollection[targetType], { id: targetId }, patch)
            if (upd && upd.count > 0) {
              targetResult = { from: tDoc.status, to: newStatus, reason: newOfflineReason || note }
            }
          } else {
            targetResult = { from: tDoc.status, to: tDoc.status, skipped: true, reason: '对象已是终态' }
          }
        }
      } else if (targetType === 'owner' && normalizedAction === 'offline') {
        /* 举报对象是用户：暂时仅记录，不直接封禁，避免误伤（封禁需独立审核） */
        targetUid = targetId
      }

      /* ---- 写举报处置记录 ---- */
      const updated = await repo.updateWhere('reports', { id }, {
        status,
        handlerNote: note,
        handledAt: status === '处理中' ? 0 : at,
        handledBy: session ? session.accountId : '',
        targetAction: normalizedAction,
        targetActionAt: normalizedAction ? at : 0,
        updatedAt: at
      })
      if (!updated || updated.count === 0) throw new AppError(CODES.CONFLICT, '该反馈已被处理，请刷新后重试')

      const auditTarget = targetResult
        ? `${id}:${status}|${normalizedAction}:${targetResult.from}->${targetResult.to}`
        : `${id}:${status}`
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'report.handle',
        target: auditTarget,
        reason: note,
        ip: ctx.ip,
        result: 'allow',
        at
      })

      /* ---- 通知被举报人（如果有对象+对象被处置） ---- */
      let targetNotified = false
      if (targetUid && status === '已处理') {
        try {
          const actionDesc = normalizedAction === 'offline'
            ? (targetType === 'product' || targetType === 'demand' ? '已下架' : '已下架')
            : normalizedAction === 'pending' || normalizedAction === 'reject' ? '已退回' : '已核实'
          const typeLabel = { product: '商品', demand: '求购需求', news: '资讯', owner: '账号' }[targetType] || '内容'
          await notifyUser(targetUid, {
            title: normalizedAction
              ? `你的${typeLabel}${actionDesc}`
              : '你的内容被举报，平台已核实',
            body: (normalizedAction
              ? `你的${typeLabel}「${doc.targetTitle || targetId}」因被举报，经平台核实${actionDesc}。处理说明：${note || doc.content || '违规内容'}`
              : `你发布的${typeLabel}「${doc.targetTitle || targetId}」被用户举报，经核实平台结论：${note || doc.content || '不成立'}。`) +
              ' 如需申诉请联系客服。',
            reason: note,
            targetType,
            targetId
          })
          targetNotified = true
        } catch (e) { /* 通知失败不影响主流程 */ }
      }

      /* ---- 通知举报人 ---- */
      if (doc.uid) {
        try {
          const actionTip = targetResult && !targetResult.skipped
            ? `；平台已对被举报内容执行「${targetResult.to === (PRODUCT_STATUS.OFFLINE || DEMAND_STATUS.OFFLINE) ? '下架' : '退回'}」处置`
            : ''
          await notifyUser(doc.uid, {
            title: status === '处理中' ? '你的反馈已受理'
              : status === '已处理' ? '你的反馈已核实处理'
              : '你的反馈处理结果',
            body: status === '处理中'
              ? '平台客服已受理你的反馈，正在核实处理，有结论会再次通知你。'
              : `${note || '平台已完成核实'}${doc.targetTitle ? '（对象：' + doc.targetTitle + '）' : ''}${actionTip}。感谢你的反馈，我们会持续优化。`,
            reason: note,
            targetType: 'report',
            targetId: id
          })
        } catch (notifyErr) { /* 通知失败不影响处置结果 */ }
      }

      return {
        id, status, handledAt: status === '处理中' ? 0 : at,
        targetAction: normalizedAction, targetResult, targetNotified
      }
    },

    /** 已拦截箱：含命中规则、命中时间、24h 复核倒计时 */
    'blocked.list': async (data) => {
      const paging = normalizePaging(data)
      const total = await repo.count('blocked', {})
      const rows = await repo.find('blocked', {}, {
        sort: { field: 'at', dir: 'desc' },
        skip: paging.skip,
        limit: paging.limit
      })
      const items = []
      for (const row of rows) {
        const rule = await repo.get('rules', row.ruleId)
        items.push({
          id: row.id,
          leadId: row.leadId,
          ruleId: row.ruleId,
          ruleName: rule ? rule.name : '',
          tier: rule ? rule.tier : '',
          reason: row.reason,
          at: row.at,
          reviewDeadline: row.reviewDeadline,
          reviewable: Number(row.reviewDeadline) > now()
        })
      }
      const result = {
        items, page: paging.page, limit: paging.limit, total,
        hasMore: paging.skip + rows.length < total,
        reviewWindowHours: BLOCKED_REVIEW_WINDOW_MS / 3600000,
        cleanupDays: BLOCKED_CLEANUP_DAYS
      }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 规则列表：返回完整条件（cond）与中文说明（condText），
     * 页面看到的条件与判档引擎读取的是同一份 cond，避免「展示一套、计算另一套」。
     */
    'rules.list': async () => {
      const rows = await repo.find('rules', {}, { sort: { field: 'tier', dir: 'asc' }, limit: 100 })
      const tierMap = {}
      TIER_GUIDE.forEach((item) => { tierMap[item.tier] = item })
      return {
        items: rows.map((rule) => {
          const guide = tierMap[rule.tier]
          return {
            id: rule.id,
            name: rule.name,
            type: rule.type || '',
            typeName: rule.type ? (RULE_TYPES[rule.type] || rule.type) : '',
            scope: rule.scope || 'global',
            scopeKey: rule.scopeKey || '',
            scopeText: scopeTextOf(rule),
            tier: rule.tier,
            tierName: guide ? guide.name : rule.tier,
            tierDesc: guide ? guide.desc : '',
            enabled: !!rule.enabled,
            version: rule.version || 1,
            hitCount: Number(rule.hitCount) || 0,
            cond: sanitizeRuleCond(rule.cond),
            condText: condTextOf(rule.cond),
            note: rule.note || '',
            createdAt: Number(rule.createdAt) || 0,
            updatedAt: Number(rule.updatedAt) || 0
          }
        }),
        /* 新增规则表单的可用类型与档位说明：前端不再硬编码 */
        types: Object.keys(RULE_TYPES).map((key) => ({ key, name: RULE_TYPES[key] })),
        tiers: TIER_GUIDE.map((item) => ({ tier: item.tier, name: item.name, desc: item.desc }))
      }
    },

    /** 规则开关：改规则也留痕，规则版本号自增以保证判档可追溯 */
    'rule.toggle': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.id, { field: '规则', required: true, max: 64 })
      const rule = await repo.get('rules', id)
      if (!rule) throw new AppError(CODES.NOT_FOUND, '规则不存在')
      /* 严格布尔：字符串 "false" 不能因为 !! 变成 true，否则停用会变成启用 */
      let enabled
      if (data.enabled === undefined) {
        enabled = !rule.enabled
      } else if (data.enabled === true || data.enabled === 'true' || data.enabled === 1 || data.enabled === '1') {
        enabled = true
      } else if (data.enabled === false || data.enabled === 'false' || data.enabled === 0 || data.enabled === '0') {
        enabled = false
      } else {
        throw new AppError(CODES.VALIDATION, '启用状态取值不合法')
      }
      const version = (Number(rule.version) || 1) + 1
      const res = await repo.updateWhere('rules', { id, version: rule.version || 1 }, { enabled, version })
      if (!res || res.count === 0) {
        throw new AppError(CODES.CONFLICT, '规则已被更新，请刷新后重试')
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'rule.toggle',
        target: id,
        reason: enabled ? '启用' : '停用',
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      return { id, enabled, version }
    },

    /**
     * 新增筛选规则：条件与档位一起落库，页面新增即可生效（无需再改代码）。
     * 手机号黑名单只落盲索引 + 打码号码，规则表不保存明文。
     */
    'rule.create': async (data, ctx) => {
      const session = ctx.session
      const input = normalizeRuleInput(data, null)
      const at = now()
      const id = randomId('R')
      await repo.insert('rules', {
        id,
        name: input.name,
        type: input.type,
        scope: input.scope,
        scopeKey: input.scopeKey,
        cond: input.cond,
        tier: input.tier,
        enabled: data.enabled === undefined ? true : (data.enabled === true || data.enabled === 'true' || data.enabled === 1 || data.enabled === '1'),
        version: 1,
        hitCount: 0,
        note: input.note,
        createdAt: at,
        updatedAt: at,
        updatedBy: session ? session.accountId : ''
      })
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'rule.create',
        target: id,
        reason: `${input.name}（${RULE_TYPES[input.type] || input.type} / ${input.tier}）`,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return {
        id,
        name: input.name,
        type: input.type,
        tier: input.tier,
        scope: input.scope,
        scopeKey: input.scopeKey,
        cond: sanitizeRuleCond(input.cond),
        condText: condTextOf(input.cond),
        scopeText: scopeTextOf({ scope: input.scope, scopeKey: input.scopeKey })
      }
    },

    /**
     * 修改筛选规则：条件、档位、范围都能改；用版本号做 CAS，并发编辑直接冲突而非覆盖。
     */
    'rule.update': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.id, { field: '规则', required: true, max: 64 })
      const rule = await repo.get('rules', id)
      if (!rule) throw new AppError(CODES.NOT_FOUND, '规则不存在')
      /* 客户端带版本号时做乐观锁：别人改过就提示刷新，避免静默覆盖 */
      if (data.version !== undefined && data.version !== null && data.version !== '') {
        const clientVersion = Number(data.version)
        if (!Number.isInteger(clientVersion) || clientVersion !== (Number(rule.version) || 1)) {
          throw new AppError(CODES.CONFLICT, '规则已被其他人修改，请刷新后重试')
        }
      }
      const input = normalizeRuleInput(data, rule)
      const version = (Number(rule.version) || 1) + 1
      const at = now()
      const patch = {
        name: input.name,
        type: input.type,
        scope: input.scope,
        scopeKey: input.scopeKey,
        cond: input.cond,
        tier: input.tier,
        note: input.note,
        version,
        updatedAt: at,
        updatedBy: session ? session.accountId : ''
      }
      const res = await repo.updateWhere('rules', { id, version: rule.version || 1 }, patch)
      if (!res || res.count === 0) {
        throw new AppError(CODES.CONFLICT, '规则已被更新，请刷新后重试')
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'rule.update',
        target: id,
        reason: `${input.name}（${RULE_TYPES[input.type] || input.type} / ${input.tier}）：${condTextOf(input.cond)}`,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return {
        id,
        name: input.name,
        type: input.type,
        tier: input.tier,
        scope: input.scope,
        scopeKey: input.scopeKey,
        cond: sanitizeRuleCond(input.cond),
        condText: condTextOf(input.cond),
        scopeText: scopeTextOf({ scope: input.scope, scopeKey: input.scopeKey }),
        version
      }
    },

    /**
     * 排序规则（咨询单审批优先级）：读取当前权重与门槛。
     * 前端「排序规则设置」与 lead.list 排序共用这一份配置。
     */
    'rule.sort': async () => {
      const rules = await loadSortRules()
      return {
        rules,
        factors: SORT_FACTORS.map((item) => ({ key: item.key, label: item.label, hint: item.hint })),
        defaults: DEFAULT_SORT_RULES
      }
    },

    /** 保存排序规则：权重 0-100 的整数，合计必须大于 0；门槛按元填写 */
    'rule.sortSave': async (data, ctx) => {
      const session = ctx.session
      const current = await loadSortRules()
      const rawWeights = data.weights || {}
      const weights = {}
      SORT_FACTORS.forEach((factor) => {
        const raw = rawWeights[factor.key]
        if (raw === undefined || raw === null || raw === '') {
          weights[factor.key] = 0
          return
        }
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 0 || value > 100) {
          throw new AppError(CODES.VALIDATION, `${factor.label}权重需为 0 - 100 的整数`)
        }
        weights[factor.key] = value
      })
      const total = SORT_FACTORS.reduce((sum, factor) => sum + weights[factor.key], 0)
      if (total <= 0) throw new AppError(CODES.VALIDATION, '至少给一项排序因素设置大于 0 的权重')
      const thresholdRaw = data.amountThreshold == null || data.amountThreshold === ''
        ? current.amountThreshold
        : Number(data.amountThreshold)
      if (!Number.isInteger(thresholdRaw) || thresholdRaw < 10000 || thresholdRaw > 10000000000) {
        throw new AppError(CODES.VALIDATION, '大额门槛需为 1 万 - 100 亿之间的整数（单位：元）')
      }
      let enabled = current.enabled
      if (data.enabled !== undefined) {
        enabled = data.enabled === true || data.enabled === 'true' || data.enabled === 1 || data.enabled === '1'
      }
      let largeCompletenessFirst = current.largeCompletenessFirst
      if (data.largeCompletenessFirst !== undefined) {
        largeCompletenessFirst = data.largeCompletenessFirst === true ||
          data.largeCompletenessFirst === 'true' ||
          data.largeCompletenessFirst === 1 ||
          data.largeCompletenessFirst === '1'
      }
      const at = now()
      const patch = {
        weights,
        amountThreshold: thresholdRaw,
        enabled,
        largeCompletenessFirst,
        updatedAt: at,
        updatedBy: session ? session.accountId : ''
      }
      const exists = await repo.get('settings', 'lead_sort_rules')
      if (exists) {
        await repo.updateWhere('settings', { id: 'lead_sort_rules' }, patch)
      } else {
        await repo.insert('settings', Object.assign({ id: 'lead_sort_rules', createdAt: at }, patch))
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'rule.sortSave',
        target: 'lead_sort_rules',
        reason: `权重 资料${weights.completeness} / 金额${weights.amount} / 主体${weights.subject} / 等待${weights.waiting}；大额门槛 ${thresholdRaw} 元`,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return {
        rules: normalizeSortRules(Object.assign({ id: 'lead_sort_rules' }, patch)),
        factors: SORT_FACTORS.map((item) => ({ key: item.key, label: item.label, hint: item.hint }))
      }
    },

    /**
     * 产品型号库：内置目录（用户端滚轮的真实数据源）+ 平台覆盖记录（新增 / 停用 / 删除）。
     * 同一「品类::品牌::系列::型号」以平台记录为准，没有平台记录时回落到内置目录。
     */
    'catalog.list': async (data) => {
      const status = data.status ? enumOf(data.status, CATALOG_STATUSES, '状态') : ''
      const q = data.q ? str(data.q, { field: '关键词', max: 40 }).toLowerCase() : ''
      const rows = await repo.find('catalog', {}, {
        sort: { field: 'updatedAt', dir: 'desc' },
        limit: 5000
      })
      const overrides = new Map()
      for (const row of rows) overrides.set(catalogKeyOf(row), row)
      const merged = []
      for (const item of flattenDeviceCatalog()) {
        const key = catalogKeyOf(item)
        const row = overrides.get(key)
        if (row) {
          overrides.delete(key)
          merged.push(projectCatalog(row))
        } else {
          merged.push({
            id: catalogIdOf(item),
            key,
            cat: item.cat,
            brand: item.brand,
            series: item.series,
            model: item.model,
            status: 'active',
            source: 'builtin',
            note: '',
            createdAt: 0,
            updatedAt: 0,
            updatedBy: ''
          })
        }
      }
      /* 平台新增、且不在内置目录里的型号追加在末尾 */
      for (const row of overrides.values()) merged.push(projectCatalog(row))
      const counts = {
        active: merged.filter((item) => item.status === 'active').length,
        disabled: merged.filter((item) => item.status === 'disabled').length,
        removed: merged.filter((item) => item.status === 'removed').length
      }
      let items = status ? merged.filter((item) => item.status === status) : merged
      if (q) {
        items = items.filter((item) => [item.cat, item.brand, item.series, item.model, item.note]
          .join(' ').toLowerCase().includes(q))
      }
      return { items, total: items.length, counts }
    },

    /** 新增 / 修改型号：同一「品类 + 品牌 + 系列 + 型号」只保留一条记录 */
    'catalog.save': async (data, ctx) => {
      const session = ctx.session
      const cat = str(data.cat, { field: '品类', required: true, max: 40 })
      const brand = str(data.brand, { field: '品牌', required: true, max: 40 })
      const series = str(data.series, { field: '系列', required: true, max: 60 })
      const model = str(data.model, { field: '型号', required: true, max: 80 })
      const note = str(data.note || '', { field: '备注', max: 120 })
      const status = data.status ? enumOf(data.status, CATALOG_STATUSES, '状态') : 'active'
      const key = catalogKeyOf({ cat, brand, series, model })
      const id = catalogIdOf({ cat, brand, series, model })
      const at = now()
      const exists = await repo.get('catalog', id)
      const patch = {
        cat,
        brand,
        series,
        model,
        status,
        note,
        source: 'platform',
        updatedAt: at,
        updatedBy: session ? session.accountId : ''
      }
      if (exists) {
        await repo.updateWhere('catalog', { id }, patch)
      } else {
        await repo.insert('catalog', Object.assign({ id, createdAt: at }, patch))
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'catalog.save',
        target: key,
        reason: `${exists ? '更新' : '新增'}型号：${cat} / ${brand} / ${series} / ${model}（${status}）`,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return projectCatalog(Object.assign({ id, createdAt: exists ? exists.createdAt : at }, patch))
    },

    /** 删除型号：软删（status=removed），用户端与默认列表都不再展示 */
    'catalog.remove': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.id, { field: '型号记录', required: true, max: 80 })
      const at = now()
      const existing = await repo.get('catalog', id)
      let row = existing
      if (!row) {
        /* 内置目录里的型号还没有平台记录：按 id 反查，写一条 removed 覆盖记录 */
        const builtin = flattenDeviceCatalog().find((item) => catalogIdOf(item) === id)
        if (!builtin) throw new AppError(CODES.NOT_FOUND, '型号记录不存在')
        row = Object.assign({ id }, builtin)
        await repo.insert('catalog', Object.assign({}, row, {
          status: 'removed',
          source: 'platform',
          note: '',
          createdAt: at,
          updatedAt: at,
          updatedBy: session ? session.accountId : ''
        }))
      } else {
        await repo.updateWhere('catalog', { id }, {
          status: 'removed',
          updatedAt: at,
          updatedBy: session ? session.accountId : ''
        })
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId : '',
        action: 'catalog.remove',
        target: catalogKeyOf(row),
        reason: `删除型号：${row.cat} / ${row.brand} / ${row.series} / ${row.model}`,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return { id, status: 'removed' }
    },

    /**
     * 行为数据中心：把分散在各处的「记录类」数据汇总成一条时间线。
     * - capture：客户端截屏 / 录屏 / 复制联系方式等安全行为（behaviorEvents）
     * - security：风控拦截（审计里 result 非 allow）
     * - user：用户业务动作（发布、上下架、成交、关闭等）
     * - admin：管理端操作
     * - search：搜索词记录
     * 返回统一结构，前端只按分类切换，不再让运营在多个页面之间来回找。
     */
    'behavior.list': async (data) => {
      const paging = normalizePaging(data)
      const at = now()
      const dayMs = 24 * 60 * 60 * 1000
      const days = Math.min(30, Math.max(1, Number(data.days) || 7))
      const from = Math.max(at - days * dayMs, retentionCutoff(at))
      const to = at
      const range = { at: { $gte: from, $lt: to + 1 } }
      const category = str(data.category || 'all', { field: '分类', max: 20 })
      const keyword = str(data.keyword || '', { field: '关键词', max: 40 }).toLowerCase()

      const CAPTURE_LABELS = {
        screenshot: '截屏',
        screen_record: '录屏',
        copy_contact: '复制联系方式',
        save_attempt: '尝试保存内容'
      }
      const userMaskOf = (uid) => (uid ? '用户#' + sha256Hex(String(uid)).slice(0, 6) : '匿名')

      const [eventRows, auditRows, searchRows] = await Promise.all([
        repo.find('behaviorEvents', range, { sort: { field: 'at', dir: 'desc' }, limit: 500 }),
        repo.find('audit', range, { sort: { field: 'at', dir: 'desc' }, limit: 500 }),
        repo.find('searchLogs', range, { sort: { field: 'at', dir: 'desc' }, limit: 500 })
      ])
      const names = await staffNameMap()
      const items = []

      eventRows.forEach((row) => {
        const isCapture = row.kind === 'screenshot' || row.kind === 'screen_record'
        items.push({
          id: row.id,
          at: Number(row.at) || 0,
          category: isCapture ? 'capture' : 'user',
          categoryLabel: isCapture ? '截屏录屏' : '用户行为',
          kind: row.kind,
          title: CAPTURE_LABELS[row.kind] || row.kind || '安全行为',
          detail: row.page ? `页面：${row.page}` : '页面未记录',
          actorName: userMaskOf(row.uid),
          actorType: 'user',
          result: 'warn',
          resultLabel: '需关注',
          target: row.page || ''
        })
      })

      auditRows.forEach((row) => {
        const blocked = row.result && row.result !== 'allow'
        let cat = 'user'
        let catLabel = '用户行为'
        if (row.actorType === 'admin') {
          cat = 'admin'
          catLabel = '管理操作'
        }
        if (blocked) {
          cat = 'security'
          catLabel = '风控拦截'
        }
        items.push({
          id: row.id,
          at: Number(row.at) || 0,
          category: cat,
          categoryLabel: catLabel,
          kind: row.action || '',
          title: AUDIT_ACTION_LABELS[row.action] || row.action || '操作',
          detail: row.reason ? maskSensitiveText(row.reason) : '',
          actorName: row.actorType === 'admin' ? (names.get(row.actorId) || '管理账号') : userMaskOf(row.actorId),
          actorType: row.actorType || 'user',
          result: row.result || 'allow',
          resultLabel: resultLabelOf(row.result),
          target: row.target ? maskSensitiveText(row.target) : ''
        })
      })

      searchRows.forEach((row) => {
        items.push({
          id: row.id,
          at: Number(row.at) || 0,
          category: 'search',
          categoryLabel: '搜索记录',
          kind: 'search',
          title: row.q ? `搜索「${maskSensitiveText(row.q)}」` : '搜索',
          detail: row.scope ? `分类：${row.scope}` : '',
          actorName: userMaskOf(row.uidHash),
          actorType: 'user',
          result: 'allow',
          resultLabel: '记录',
          target: row.scope || ''
        })
      })

      items.sort((a, b) => b.at - a.at)

      const summary = {
        all: items.length,
        capture: items.filter((x) => x.category === 'capture').length,
        security: items.filter((x) => x.category === 'security').length,
        user: items.filter((x) => x.category === 'user').length,
        admin: items.filter((x) => x.category === 'admin').length,
        search: items.filter((x) => x.category === 'search').length
      }

      let matched = category === 'all' ? items : items.filter((x) => x.category === category)
      if (keyword) {
        matched = matched.filter((x) =>
          [x.title, x.detail, x.actorName, x.target].join(' ').toLowerCase().indexOf(keyword) > -1
        )
      }
      const rows = matched.slice(paging.skip, paging.skip + paging.limit)
      const result = {
        items: rows,
        summary: summary,
        days: days,
        from: from,
        to: to,
        page: paging.page,
        limit: paging.limit,
        total: matched.length,
        hasMore: paging.skip + rows.length < matched.length,
        retentionDays: AUDIT_RETENTION_DAYS
      }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 操作日志：谁在什么时候做了什么，支持按操作人 / 动作 / 结果 / 工单 / 时间回溯。
     * 审计只追加不可改；这里额外回填操作人展示名与中文动作名（projectAudit 会打码 actorId）。
     */
    'audit.list': async (data) => {
      const paging = normalizePaging(data)
      const at = now()
      const cutoff = retentionCutoff(at)
      const from = data.from ? Math.max(Number(data.from) || 0, cutoff) : cutoff
      const to = data.to ? Number(data.to) || at : at
      const query = { at: { $gte: from, $lt: to + 1 } }
      if (data.action) query.action = str(data.action, { field: '动作', max: 40 })
      if (data.actorId) query.actorId = str(data.actorId, { field: '操作人', max: 64 }).toLowerCase()
      if (data.result) query.result = str(data.result, { field: '结果', max: 20 })
      const leadId = data.leadId ? str(data.leadId, { field: '工单', max: 64 }) : ''
      let rows
      let total
      if (leadId) {
        /* 工单 id 存在 target 里，取一批后在内存精确匹配（前缀相同但 id 不同的不能算命中） */
        const all = await repo.find('audit', query, { sort: { field: 'at', dir: 'desc' }, limit: 500 })
        const matched = all.filter((row) => leadIdOfTarget(row.target) === leadId)
        total = matched.length
        rows = matched.slice(paging.skip, paging.skip + paging.limit)
      } else {
        total = await repo.count('audit', query)
        rows = await repo.find('audit', query, {
          sort: { field: 'at', dir: 'desc' },
          skip: paging.skip,
          limit: paging.limit
        })
      }
      const names = await staffNameMap()
      const items = rows.map((row) => Object.assign(projectAudit(row), {
        actionLabel: AUDIT_ACTION_LABELS[row.action] || row.action,
        actorName: names.get(row.actorId) || '',
        resultLabel: resultLabelOf(row.result),
        leadId: leadIdOfTarget(row.target)
      }))
      const result = {
        items,
        page: paging.page,
        limit: paging.limit,
        total,
        hasMore: paging.skip + items.length < total,
        retentionDays: AUDIT_RETENTION_DAYS
      }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 客服服务记录：从审计里聚合「分配 / 转派、状态推进、释放联系方式、回复消息」，
     * 既可按客服 / 工单回溯明细，也返回每位坐席的处理量与最近处理时间。
     */
    'service.records': async (data) => {
      const paging = normalizePaging(data)
      const at = now()
      const query = {
        actorType: 'admin',
        action: { $in: SERVICE_ACTIONS.slice() },
        at: { $gte: retentionCutoff(at), $lt: at + 1 }
      }
      if (data.actorId) query.actorId = str(data.actorId, { field: '客服', max: 64 }).toLowerCase()
      const leadId = data.leadId ? str(data.leadId, { field: '工单', max: 64 }) : ''
      /* 工单维度需要先按 target 取线索 id，故一次多取（180 天内客服动作量可控） */
      const rows = await repo.find('audit', query, { sort: { field: 'at', dir: 'desc' }, limit: 500 })
      const names = await staffNameMap()
      const leadCache = new Map()
      const cacheLead = async (id) => {
        if (!id) return null
        if (!leadCache.has(id)) leadCache.set(id, await repo.get('leads', id))
        return leadCache.get(id)
      }
      const matched = []
      for (const row of rows) {
        if (isExpired(row, at)) continue
        const ownerLeadId = leadIdOfTarget(row.target)
        if (leadId && ownerLeadId !== leadId) continue
        const lead = await cacheLead(ownerLeadId)
        const target = lead ? await targetTitle(lead) : { title: '' }
        matched.push({
          row,
          lead,
          leadTitle: target.title || (lead && lead.formSummary) || ''
        })
      }
      const counts = new Map()
      for (const { row } of matched) {
        const cur = counts.get(row.actorId) || { handled: 0, assign: 0, status: 0, reply: 0, lastAt: 0 }
        cur.handled += 1
        if (row.action === 'lead.assign') cur.assign += 1
        else if (row.action === 'lead.updateStatus') cur.status += 1
        else if (row.action === 'msg.reply') cur.reply += 1
        cur.lastAt = Math.max(cur.lastAt, Number(row.at) || 0)
        counts.set(row.actorId, cur)
      }
      const staff = (await listStaff()).map((item) => Object.assign({}, item, counts.get(item.username) || {
        handled: 0, assign: 0, status: 0, reply: 0, lastAt: 0
      }))
      const items = matched.slice(paging.skip, paging.skip + paging.limit).map(({ row, lead, leadTitle }) => ({
        id: row.id,
        at: row.at,
        actorName: names.get(row.actorId) || row.actorId,
        action: row.action,
        actionLabel: AUDIT_ACTION_LABELS[row.action] || row.action,
        leadId: lead ? lead.id : leadIdOfTarget(row.target),
        leadTitle,
        leadStatus: lead ? lead.status : '',
        reason: maskSensitiveText(row.reason || ''),
        result: row.result,
        resultLabel: resultLabelOf(row.result)
      }))
      const result = {
        items,
        staff,
        page: paging.page,
        limit: paging.limit,
        total: matched.length,
        hasMore: paging.skip + items.length < matched.length,
        retentionDays: AUDIT_RETENTION_DAYS
      }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 释放联系方式：admin + 已对接/已成交 + 公开主体 + 原因 ≥5 字 + 审计，缺一不可。
     * 「不公开主体」平台不代转联系方式，双方只能在站内会话沟通，因此直接拒绝。
     * cs 在 router 的 RBAC 层已 403 并落审计。
     */
    'contact.reveal': async (data, ctx) => {
      const session = ctx.session
      if (!session || session.role !== ROLES.ADMIN) {
        throw new AppError(CODES.FORBIDDEN, '无权限执行该操作')
      }
      const leadId = str(data.leadId || data.id, { field: '线索', required: true, max: 64 })
      const reason = str(data.reason, { field: '查看原因', required: true, min: 5, max: 200 })
      const lead = await loadLead(leadId)
      if (!PHONE_REVEALABLE_STATUS.includes(lead.status)) {
        throw new AppError(CODES.CONFLICT, '未建群/未对接，暂不能释放联系方式')
      }
      /* 双方联系方式：默认咨询方（发起咨询的用户）；传 uid 时只允许该单的发布方，避免越权查人 */
      const target = await targetTitle(lead)
      let publisherUid = ''
      if (target.type === 'product') {
        const product = lead.productId ? await repo.get('products', lead.productId) : null
        publisherUid = (product && product.ownerId) || ''
      } else if (target.type === 'demand') {
        const demand = lead.demandId ? await repo.get('demands', lead.demandId) : null
        publisherUid = (demand && demand.ownerId) || ''
      } else if (target.type === 'agency' && target.id) {
        const agency = await repo.get('agencies', target.id)
        publisherUid = (agency && agency.ownerId) || ''
      }
      const requestedUid = String(data.uid || '').trim()
      let revealUid = lead.uid
      let side = '咨询方'
      if (requestedUid && requestedUid !== lead.uid) {
        if (!publisherUid || requestedUid !== publisherUid) {
          throw new AppError(CODES.VALIDATION, '该用户不是此咨询单的关联方')
        }
        revealUid = publisherUid
        side = '发布方'
      }
      if (!revealUid) throw new AppError(CODES.NOT_FOUND, '该咨询单未关联到用户')
      const leadProfile = (await repo.find('profiles', { uid: revealUid }, { limit: 1 }))[0] || {}
      /* 历史 matched 视同 hidden：只有明确「公开主体」才允许平台代转联系方式 */
      if ((leadProfile.exposure || EXPOSURES.HIDDEN) !== EXPOSURES.OPEN) {
        throw new AppError(CODES.CONFLICT, '对方选择「不公开主体」，平台不代转联系方式，请在站内会话沟通')
      }
      const user = await repo.get('users', revealUid)
      /* 咨询方：优先使用本次咨询填写的联系电话（与档案手机号解耦），历史线索回退档案 */
      let leadPhone = ''
      if (revealUid === lead.uid && lead.contactPhoneCipher) {
        try {
          leadPhone = decryptField({ keys, token: lead.contactPhoneCipher, aad: `leads.contactPhone.${lead.id}` }) || ''
        } catch (err) {
          leadPhone = ''
        }
      }
      if (!leadPhone && (!user || !user.phoneCipher)) {
        throw new AppError(CODES.NOT_FOUND, '对方尚未留存联系方式')
      }
      const phone = leadPhone || (() => {
        try {
          return decryptField({ keys, token: user.phoneCipher, aad: phoneAad(user.id) })
        } catch (err) {
          /* 历史密文 / 换密钥后解不开：明确报错，不能把空串当成手机号返回 */
          throw new AppError(CODES.INTERNAL, '联系方式解析失败，请联系技术处理')
        }
      })()
      if (!phone) throw new AppError(CODES.NOT_FOUND, '对方尚未留存有效联系方式')
      await repo.updateWhere('leads', { id: leadId }, { contactReleased: true })
      const at = now()
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session.accountId,
        action: 'contact.reveal',
        target: leadId,
        /* 审计里标明看的是哪一方，避免事后只看到手机号无法回溯 */
        reason: side + '：' + reason,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return { leadId, uid: revealUid, side, phone, revealedAt: at }
    },

    /**
     * 用户数据：跨 users + profiles 的检索视图。
     * 支持按关键词（昵称 / 主体 / 城市）、主体类型、城市、是否上传营业执照、账号状态筛选。
     * 列表只给脱敏信息：手机号仅标记是否留存，主体名称解密后做敏感内容打码。
     */
    'user.list': async (data) => {
      const paging = normalizePaging(data)
      const q = String(data.q || '').trim().toLowerCase().slice(0, 30)
      /* 手机号走盲索引精确匹配：列表 / 详情都不回传明文，只用于定位用户 */
      const rawPhone = String(data.phone || '').replace(/[^\d]/g, '')
      const phoneQuery = rawPhone.length >= 7 ? rawPhone : (/^1[3-9]\d{9}$/.test(q) ? q : '')
      const subjectType = data.subjectType ? enumOf(data.subjectType, SUBJECT_TYPES, '主体类型') : ''
      const city = data.city ? str(data.city, { field: '城市', max: 20 }) : ''
      const hasLicense = data.hasLicense === 'yes' || data.hasLicense === 'no' ? data.hasLicense : ''
      /* 资质核验筛选：verified=至少一项已核验；unverified=有材料但均未核验；none=未上传任何材料 */
      const qualStatus = ['verified', 'unverified', 'none'].includes(data.qualStatus) ? data.qualStatus : ''
      const status = data.status ? enumOf(data.status, ['正常', '停用'], '状态') : ''
      const exposure = data.exposure ? enumOf(data.exposure, Object.values(EXPOSURES), '公开范围') : ''
      /* 历史委托筛选：buy=发起过代采，sell=发起过代售 */
      const agencyQuery = data.agency === 'buy' || data.agency === 'sell' ? data.agency : ''
      /* 会员筛选：yes=当前有效会员（已开通且未过期），no=非会员或已到期 */
      const memberQuery = data.member === 'yes' || data.member === 'no' ? data.member : ''
      /* 联系方式筛选：是否已授权留存手机号 */
      const hasPhone = data.hasPhone === 'yes' || data.hasPhone === 'no' ? data.hasPhone : ''

      const nowMs = now()
      /* 用户量已过万：列表与搜索必须覆盖全量，不能再按 500 条采样，否则搜索会漏人 */
      const [
        users, profiles, products, demands, accesses, agencies,
        userTotal, userActive, memberTotal, licenseTotal, stateOwnedTotal
      ] = await Promise.all([
        repo.find('users', {}, { limit: 100000 }),
        repo.find('profiles', {}, { limit: 100000 }),
        repo.find('products', {}, { limit: 100000 }),
        repo.find('demands', {}, { limit: 100000 }),
        repo.find('bizAccess', {}, { limit: 100000 }),
        repo.find('agencies', { deleted: { $ne: true } }, { limit: 100000 }),
        repo.count('users', {}),
        repo.count('users', { status: { $ne: '停用' } }),
        repo.count('bizAccess', { status: '已开通', expireAt: { $gte: nowMs } }),
        repo.count('profiles', { quals: { $regex: '营业执照' } }),
        repo.count('profiles', { subjectType: { $regex: '国企|央企|事业单位|政府' } })
      ])
      let agencyIds = null
      if (agencyQuery) {
        agencyIds = new Set(agencies.filter((row) => (row.side || 'buy') === agencyQuery).map((row) => row.ownerId))
      }
      let phoneIds = null
      if (phoneQuery) {
        let normalized = ''
        try { normalized = normalizePhone(phoneQuery) } catch (err) { normalized = '' }
        phoneIds = normalized
          ? new Set(users.filter((u) => u.phoneBidx === blindIndex({ keys, value: normalized })).map((u) => u.id))
          : new Set()
      }
      const userById = new Map(users.map((u) => [u.id, u]))
      const accessOf = new Map()
      accesses.forEach((row) => {
        if (row && (row.uid || row.id)) accessOf.set(row.uid || row.id, row)
      })
      const memberStatusOf = (uid) => {
        const row = accessOf.get(uid)
        if (!row) return { status: '未开通', expireAt: 0 }
        if (row.status === '已停用') return { status: '已停用', expireAt: Number(row.expireAt) || 0 }
        if (row.status === '待确认') return { status: '待确认', expireAt: Number(row.expireAt) || 0 }
        if (row.status === '已开通' && Number(row.expireAt) > nowMs) return { status: '已开通', expireAt: Number(row.expireAt) || 0 }
        return { status: '已到期', expireAt: Number(row.expireAt) || 0 }
      }
      const profileOf = new Map()
      profiles.forEach((p) => {
        if (p && p.uid) profileOf.set(p.uid, p)
      })
      /* 按归属人预聚合，避免每个用户都遍历一遍商品 / 需求 / 委托（用户过万时会卡死） */
      const countMap = (rows) => {
        const map = new Map()
        rows.forEach((row) => {
          const uid = row && row.ownerId
          if (uid) map.set(uid, (map.get(uid) || 0) + 1)
        })
        return map
      }
      const productCount = countMap(products)
      const demandCount = countMap(demands)
      const agencyBuyCount = countMap(agencies.filter((row) => (row.side || 'buy') === 'buy'))
      const agencySellCount = countMap(agencies.filter((row) => row.side === 'sell'))

      const all = users.map((u) => {
        const p = profileOf.get(u.id) || {}
        const member = memberStatusOf(u.id)
        const userNo = userNoOf(u.id)
        const qualRows = Array.isArray(p.quals) ? p.quals : []
        const quals = qualRows.map((row) => String((row && typeof row === 'object' ? row.name : row) || ''))
        const qualVerified = qualRows.some((row) => row && typeof row === 'object' && row.status === '已核验')
        let subject = ''
        if (p.subjectCipher) {
          try {
            subject = decryptFieldOf({
              keys, collection: 'profiles', field: 'subject', recordId: p.uid || p.id, cipher: p.subjectCipher
            }) || ''
          } catch (err) {
            /* 密钥轮换后历史密文解不开时按未填写展示 */
          }
        }
        return {
          id: u.id,
          /* 对外可见用户ID：与用户端「我的」页同一串，支持按 ID 检索 */
          userNo,
          nick: maskSensitiveText(u.nick || ''),
          subjectType: p.subjectType || '',
          subject: maskSensitiveText(subject),
          city: p.city || '',
          /* 平台侧始终能看到主体的隐藏状态：hidden 表示对外不露主体与联系方式 */
          exposure: p.exposure || EXPOSURES.HIDDEN,
          exposureLabel: EXPOSURE_LABELS[p.exposure || EXPOSURES.HIDDEN] || EXPOSURE_LABELS.hidden,
          subjectHidden: (p.exposure || EXPOSURES.HIDDEN) === EXPOSURES.HIDDEN,
          hasLicense: quals.some((x) => x.indexOf('营业执照') >= 0),
          hasLegalRep: quals.some((x) => x.indexOf('法定代表人') >= 0),
          qualCount: quals.length,
          qualVerified,
          qualStatusKey: quals.length ? (qualVerified ? 'verified' : 'unverified') : 'none',
          phoneSaved: !!u.phoneCipher,
          memberStatus: member.status,
          memberExpireAt: member.expireAt,
          status: u.status || '正常',
          joined: p.joined || '',
          note: u.adminNote || '',
          publishCount: (productCount.get(u.id) || 0) + (demandCount.get(u.id) || 0),
          agencyBuy: agencyBuyCount.get(u.id) || 0,
          agencySell: agencySellCount.get(u.id) || 0,
          /* 仅服务端检索用：包含未脱敏昵称 / 主体，返回前会删除，不能下发给前端 */
          _hay: [String(u.nick || ''), subject, p.subjectType || '', p.city || '', u.id, userNo].join(' ').toLowerCase()
        }
      })

      const filtered = all.filter((r) => {
        if (phoneIds && !phoneIds.has(r.id)) return false
        if (agencyIds && !agencyIds.has(r.id)) return false
        if (subjectType && r.subjectType !== subjectType) return false
        if (city && r.city !== city) return false
        if (hasLicense === 'yes' && !r.hasLicense) return false
        if (hasLicense === 'no' && r.hasLicense) return false
        if (qualStatus && r.qualStatusKey !== qualStatus) return false
        if (status && r.status !== status) return false
        if (exposure && r.exposure !== exposure) return false
        if (memberQuery === 'yes' && r.memberStatus !== '已开通') return false
        if (memberQuery === 'no' && r.memberStatus === '已开通') return false
        if (hasPhone === 'yes' && !r.phoneSaved) return false
        if (hasPhone === 'no' && r.phoneSaved) return false
        if (q && r._hay.indexOf(q) < 0) return false
        return true
      })
      filtered.sort((a, b) => String(b.joined).localeCompare(String(a.joined)) || String(a.id).localeCompare(String(b.id)))
      /* 检索字段只参与过滤，不能随列表下发（内含未脱敏昵称 / 主体） */
      const items = filtered.slice(paging.skip, paging.skip + paging.limit).map((r) => {
        const item = Object.assign({}, r)
        delete item._hay
        /* 管理端要能直接拨号：只解密当前页（最多 50 条），不对全量用户解密 */
        item.phone = ''
        const source = userById.get(r.id)
        if (source && source.phoneCipher) {
          try {
            item.phone = decryptField({ keys, token: source.phoneCipher, aad: phoneAad(r.id) }) || ''
          } catch (err) { item.phone = '' }
        }
        item.phoneMasked = item.phone ? maskPhone(item.phone) : ''
        /* 资质材料直接随列表下发：管理端无需点开用户详情即可看到每项材料与核验状态 */
        const qProfile = profileOf.get(r.id) || {}
        item.qualItems = (Array.isArray(qProfile.quals) ? qProfile.quals : []).map((row) => {
          const q = row && typeof row === 'object' ? row : { name: String(row || '') }
          return {
            name: maskSensitiveText(q.name || ''),
            kind: q.kind || 'other',
            status: q.status || '待核验',
            at: Number(q.at) || 0,
            fileId: q.fileId || ''
          }
        })
        return item
      })
      const withLicense = all.filter((r) => r.hasLicense).length
      return {
        items,
        page: paging.page,
        limit: paging.limit,
        total: filtered.length,
        hasMore: paging.skip + items.length < filtered.length,
        cities: Array.from(new Set(all.map((r) => r.city).filter(Boolean))).sort(),
        /* 主体类型筛选固定下发完整枚举，避免库里暂时没有的类型从下拉里消失 */
        subjectTypes: SUBJECT_TYPES,
        withLicense,
        withoutLicense: all.length - withLicense,
        /* 用户管理顶部汇总：账号状态、资质、商会会员、国央企主体 */
        summary: {
          total: userTotal,
          active: userActive,
          stopped: Math.max(0, userTotal - userActive),
          members: memberTotal,
          licenses: licenseTotal,
          stateOwned: stateOwnedTotal
        }
      }
    },

    /** 单个用户详情：主体 / 联系人解密后仅回传脱敏值，手机号只给掩码 */
    'user.detail': async (data) => {
      const id = str(data.id || data.uid, { field: '用户', required: true, max: 64 })
      const user = await repo.get('users', id)
      if (!user) throw new AppError(CODES.NOT_FOUND, '用户不存在')
      const profile = (await repo.find('profiles', { uid: id }, { limit: 1 }))[0] || {}
      let subject = ''
      let contact = ''
      let phone = ''
      /* 三项各自解密：任一项密文异常都不影响其余字段展示 */
      if (profile.subjectCipher) {
        try {
          subject = decryptFieldOf({
            keys, collection: 'profiles', field: 'subject', recordId: profile.uid || profile.id, cipher: profile.subjectCipher
          }) || ''
        } catch (err) { subject = '' }
      }
      if (profile.contactCipher) {
        try {
          contact = decryptFieldOf({
            keys, collection: 'profiles', field: 'contact', recordId: profile.uid || profile.id, cipher: profile.contactCipher
          }) || ''
        } catch (err) { contact = '' }
      }
      if (user.phoneCipher) {
        try {
          phone = decryptField({ keys, token: user.phoneCipher, aad: phoneAad(id) }) || ''
        } catch (err) { phone = '' }
      }
      /* 资质：名称 + 原件 fileID + 核验状态；原件链接单独通过 qual.fileUrl 换取 */
      const quals = (Array.isArray(profile.quals) ? profile.quals : []).map((row) => {
        const item = row && typeof row === 'object' ? row : { name: String(row || '') }
        return {
          name: maskSensitiveText(item.name || ''),
          kind: item.kind || 'other',
          fileId: item.fileId || '',
          status: item.status || '待核验',
          at: Number(item.at) || 0
        }
      })
      const hasLicense = quals.some((q) => q.kind === 'license' || q.name.indexOf('营业执照') >= 0)
      const recent = []
      const products = await repo.find('products', { ownerId: id }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 20 })
      const demands = await repo.find('demands', { ownerId: id }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 20 })
      products.concat(demands).slice(0, 5).forEach((x) => {
        recent.push({
          id: x.id,
          title: maskSensitiveText(x.title || ''),
          city: x.city || '',
          status: x.status || '',
          createdAt: Number(x.createdAt) || 0
        })
      })

      /* ===== 用户详情 8 个 Tab：概览 / 会员 / 资质 / 代采 / 代售 / 咨询 / 库存 / 发布与互动 ===== */
      const [access, orders, paymentRows, agencies, leads, stocks, quotes, newsRows, events, favorites, follows] = await Promise.all([
        repo.get('bizAccess', id),
        repo.find('bizOrders', { uid: id }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 100 }),
        repo.find('payments', { uid: id }, { sort: { field: 'paidAt', dir: 'desc' }, limit: 100 }),
        repo.find('agencies', { ownerId: id, deleted: { $ne: true } }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 100 }),
        repo.find('leads', { uid: id }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 100 }),
        repo.find('stocks', { ownerId: id, deleted: { $ne: true } }, { sort: { field: 'updatedAt', dir: 'desc' }, limit: 200 }),
        repo.find('quotes', { ownerId: id, deleted: { $ne: true } }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 20 }),
        repo.find('news', { uid: id, deleted: { $ne: true } }, { sort: { field: 'createdAt', dir: 'desc' }, limit: 20 }),
        repo.find('userEvents', { uid: id }, { sort: { field: 'at', dir: 'desc' }, limit: 300 }),
        repo.find('favorites', { uid: id, deleted: { $ne: true } }, { sort: { field: 'updatedAt', dir: 'desc' }, limit: 200 }),
        repo.find('follows', { uid: id, deleted: { $ne: true } }, { sort: { field: 'updatedAt', dir: 'desc' }, limit: 200 })
      ])
      /* 收藏对象标题：批量取商品 / 需求，避免逐条查询 */
      const favIds = favorites.map((row) => row.targetId).filter(Boolean)
      const [favProducts, favDemands] = favIds.length
        ? await Promise.all([
          repo.find('products', { id: { $in: favIds } }, { limit: 200 }),
          repo.find('demands', { id: { $in: favIds } }, { limit: 200 })
        ])
        : [[], []]
      const favTitle = new Map()
      favProducts.forEach((row) => favTitle.set(row.id, row.title || ''))
      favDemands.forEach((row) => favTitle.set(row.id, row.title || ''))
      const agencySide = (side) => agencies.filter((row) => (row.side || 'buy') === side).map((row) => ({
        id: row.id,
        item: maskSensitiveText(row.item || ''),
        kind: row.kind || (side === 'buy' ? '代采' : '代售'),
        city: row.city || '',
        amount: Number(row.amount) || 0,
        serviceFee: Number(row.serviceFee) || 0,
        status: row.status || '',
        createdAt: Number(row.createdAt) || 0,
        createdText: dateText(row.createdAt)
      }))
      const orderItems = orders.map((row) => ({
        id: row.id,
        planKey: row.planKey || '',
        planLabel: row.planLabel || '',
        days: Number(row.days) || 0,
        amount: Number(row.amount) || 0,
        startAt: Number(row.startAt) || 0,
        expireAt: Number(row.expireAt) || 0,
        method: row.method || '',
        operator: row.operator || '',
        createdAt: Number(row.createdAt) || 0,
        createdText: dateText(row.createdAt)
      }))
      const expireAt = Number(access && access.expireAt) || 0
      const accessActive = !!(access && access.status === '已开通' && expireAt > now())
      /* 状态要区分「已开通但过期」与「从未开通」，否则详情页会把过期会员显示成已开通 */
      const accessStatus = !access
        ? '未开通'
        : access.status === '已开通'
          ? (expireAt > now() ? '已开通' : '已到期')
          : (access.status || '未开通')
      const result = {
        user: {
          id,
          userNo: userNoOf(id),
          nick: maskSensitiveText(user.nick || ''),
          subjectType: profile.subjectType || '',
          subject: maskSensitiveText(subject),
          contact: maskSensitiveText(contact),
          city: profile.city || '',
          quals,
          exposure: profile.exposure || EXPOSURES.HIDDEN,
          exposureLabel: EXPOSURE_LABELS[profile.exposure || EXPOSURES.HIDDEN] || EXPOSURE_LABELS.hidden,
          subjectHidden: (profile.exposure || EXPOSURES.HIDDEN) === EXPOSURES.HIDDEN,
          hasLicense,
          /* 管理端用户详情需要完整手机号，便于电话跟进；列表页同样下发完整号码 */
          phone: phone || '',
          phoneMasked: phone ? maskPhone(phone) : '',
          phoneSaved: !!user.phoneCipher,
          status: user.status || '正常',
          /* 举报处置后的功能限制：发布内容 / 发布资讯 / 发起对话 */
          restrictions: stateOf(user, now()),
          /* 手动调整留痕：管理员在用户页写的内部备注 */
          note: user.adminNote || '',
          joined: profile.joined || ''
        },
        recent,
        tabs: {
          overview: {
            productCount: products.length,
            demandCount: demands.length,
            agencyCount: agencies.length,
            leadCount: leads.length,
            stockCount: stocks.length,
            paymentCount: paymentRows.length,
            memberActive: accessActive,
            memberStatus: accessStatus,
            memberExpireAt: expireAt,
            memberExpireText: expireAt ? dateText(expireAt) : ''
          },
          membership: {
            active: accessActive,
            status: accessStatus,
            startAt: Number(access && access.startAt) || 0,
            expireAt,
            expireText: expireAt ? dateText(expireAt) : '',
            daysLeft: accessActive ? Math.max(0, Math.ceil((expireAt - now()) / DAY_MS)) : 0,
            orders: orderItems
          },
          qualification: {
            subjectType: profile.subjectType || '',
            subject: maskSensitiveText(subject),
            quals,
            hasLicense,
            exposureLabel: EXPOSURE_LABELS[profile.exposure || EXPOSURES.HIDDEN] || EXPOSURE_LABELS.hidden,
            joined: profile.joined || '',
            city: profile.city || ''
          },
          buy: agencySide('buy'),
          sell: agencySide('sell'),
          consult: leads.map((row) => ({
            id: row.id,
            title: maskSensitiveText(row.title || row.summary || '咨询单'),
            status: row.status || '',
            city: row.city || '',
            createdAt: Number(row.createdAt) || 0,
            createdText: dateText(row.createdAt)
          })),
          stock: stocks.map((row) => ({
            id: row.id,
            cat: row.cat || '',
            model: row.model || '',
            qty: Number(row.qty) || 0,
            price: Number(row.price) || 0,
            city: row.city || '',
            updatedAt: Number(row.updatedAt || row.createdAt) || 0,
            updatedText: dateText(row.updatedAt || row.createdAt)
          })),
          publish: {
            products: products.map((row) => ({
              id: row.id,
              title: maskSensitiveText(row.title || ''),
              city: row.city || '',
              status: row.status || '',
              createdAt: Number(row.createdAt) || 0,
              createdText: dateText(row.createdAt)
            })),
            demands: demands.map((row) => ({
              id: row.id,
              title: maskSensitiveText(row.title || ''),
              city: row.city || '',
              status: row.status || '',
              createdAt: Number(row.createdAt) || 0,
              createdText: dateText(row.createdAt)
            })),
            quotes: quotes.map((row) => ({
              id: row.id,
              itemCount: Number(row.itemCount) || 0,
              createdAt: Number(row.createdAt) || 0,
              createdText: dateText(row.createdAt)
            })),
            news: newsRows.map((row) => ({
              id: row.id,
              title: maskSensitiveText(row.title || ''),
              status: row.status || '',
              createdAt: Number(row.createdAt) || 0,
              createdText: dateText(row.createdAt)
            })),
            payments: paymentRows.slice(0, 20).map((row) => ({
              id: row.id,
              bizType: row.bizType || '',
              planLabel: row.planLabel || '',
              received: Number(row.received) || 0,
              method: row.method || '',
              status: row.status || '',
              paidAt: Number(row.paidAt) || 0,
              paidText: dateText(row.paidAt)
            }))
          },
          events: {
            total: events.length,
            items: events.map((row) => ({
              id: row.id,
              kind: row.kind || '',
              label: row.label || '',
              page: row.page || '',
              refId: row.refId || '',
              title: maskSensitiveText(row.title || ''),
              at: Number(row.at) || 0,
              atText: dateText(row.at)
            })),
            counts: events.reduce((acc, row) => {
              acc[row.kind] = (acc[row.kind] || 0) + 1
              return acc
            }, {})
          },
          social: {
            favorites: favorites.map((row) => ({
              id: row.id,
              targetType: row.targetType || '',
              targetId: row.targetId || '',
              title: maskSensitiveText(favTitle.get(row.targetId) || ''),
              at: Number(row.updatedAt || row.createdAt) || 0,
              atText: dateText(row.updatedAt || row.createdAt)
            })),
            follows: follows.map((row) => ({
              id: row.id,
              targetKey: row.targetKey || '',
              nick: maskSensitiveText(row.nick || ''),
              at: Number(row.updatedAt || row.createdAt) || 0,
              atText: dateText(row.updatedAt || row.createdAt)
            }))
          }
        }
      }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 电销线索：近 N 天多次打开商机会员页、但始终没有开通会员的用户。
     * 口径：biz_open 次数 ≥ minOpens，当前会员不是「已开通」，也没有商机会员订单。
     * 手机号与 user.export 同口径解密下发，供电销专员直接拨号。
     */
    'sales.unpaid': async (data) => {
      const at = now()
      const days = Math.max(1, Math.min(90, Number(data.days) || 7))
      const minOpens = Math.max(2, Math.min(50, Number(data.minOpens) || 2))
      const page = normalizePaging(data)
      const keyword = String(data.q || '').trim().toLowerCase().slice(0, 30)
      const since = at - days * DAY_MS
      const [events, users, profiles, accesses, orders] = await Promise.all([
        repo.find('userEvents', { kind: 'biz_open', at: { $gte: since } }, { limit: 200000 }),
        repo.find('users', {}, { limit: 20000 }),
        repo.find('profiles', {}, { limit: 20000 }),
        repo.find('bizAccess', {}, { limit: 20000 }),
        repo.find('bizOrders', {}, { limit: 50000 })
      ])
      const day1 = at - DAY_MS
      const stat = new Map()
      events.forEach((e) => {
        const uid = e && e.uid
        if (!uid) return
        const hitAt = Number(e.at) || 0
        const row = stat.get(uid) || { uid, open1d: 0, open7d: 0, lastAt: 0, firstAt: hitAt }
        row.open7d += 1
        if (hitAt >= day1) row.open1d += 1
        if (hitAt > row.lastAt) row.lastAt = hitAt
        if (hitAt && !row.firstAt) row.firstAt = hitAt
        stat.set(uid, row)
      })
      const accessOf = new Map()
      accesses.forEach((row) => { if (row && (row.uid || row.id)) accessOf.set(row.uid || row.id, row) })
      const paid = new Set(orders.map((row) => row && row.uid).filter(Boolean))
      const userOf = new Map()
      users.forEach((row) => { if (row && row.id) userOf.set(row.id, row) })
      const profileOf = new Map()
      profiles.forEach((p) => { if (p && p.uid) profileOf.set(p.uid, p) })
      const items = []
      stat.forEach((row) => {
        if (row.open7d < minOpens) return
        /* 已购买过的老客不再交给电销，避免重复打扰 */
        if (paid.has(row.uid)) return
        const access = accessOf.get(row.uid)
        const active = access && access.status === '已开通' && Number(access.expireAt) > at
        if (active) return
        const user = userOf.get(row.uid)
        if (!user || user.deleted === true || user.status === '停用') return
        const profile = profileOf.get(row.uid) || {}
        const nick = user.nick || profile.nick || ''
        const city = profile.city || user.city || ''
        const userNo = userNoOf(row.uid)
        if (keyword) {
          const plain = [nick, userNo, city, profile.subject || ''].join(' ').toLowerCase()
          /* 手机号只在解密后参与检索，避免关键词命中率下降 */
          if (plain.indexOf(keyword) < 0) {
            const phoneTry = user.phoneCipher ? decryptField({ keys, token: user.phoneCipher, aad: phoneAad(row.uid) }) || '' : ''
            if (phoneTry.indexOf(keyword) < 0) return
          }
        }
        const phone = user.phoneCipher ? decryptField({ keys, token: user.phoneCipher, aad: phoneAad(row.uid) }) || '' : ''
        items.push({
          id: row.uid,
          userNo,
          nick,
          phone,
          city,
          subjectType: profile.subjectType || user.subjectType || '',
          memberStatus: !access ? '未开通' : (access.status === '已开通' ? '已到期' : access.status),
          expireAt: Number(access && access.expireAt) || 0,
          open1d: row.open1d,
          open7d: row.open7d,
          lastAt: row.lastAt,
          firstAt: row.firstAt,
          joined: Number(user.createdAt) || 0
        })
      })
      /* 打开次数多的排前面，同样次数看最近一次打开时间 */
      items.sort((a, b) => (b.open7d - a.open7d) || (b.lastAt - a.lastAt))
      const total = items.length
      return {
        items: items.slice(page.skip, page.skip + page.limit),
        total,
        page: page.page,
        limit: page.limit,
        days,
        minOpens,
        generatedAt: at
      }
    },
    /**
     * 用户运营数据导出：沿用 user.list 的筛选口径，忽略分页，最多 5000 条。
     * 后台导出允许明文手机号，出站不走 assertNoPlaintextContact；仅管理员可调用。
     */
    'user.export': async (data, ctx) => {
      const session = ctx.session || {}
      /* 导出列白名单：管理端先勾选列再导出，服务端按 key 组装表头与数据 */
      const EXPORT_COLUMNS = [
        { key: 'id', label: '用户ID', value: (r) => r.id },
        { key: 'userNo', label: '用户编号', value: (r) => r.userNo },
        { key: 'nick', label: '昵称', value: (r) => r.nick },
        { key: 'phone', label: '手机号', value: (r) => r.phone },
        { key: 'subject', label: '主体名称', value: (r) => r.subject },
        { key: 'subjectType', label: '主体类型', value: (r) => r.subjectType },
        { key: 'exposureLabel', label: '主体展示', value: (r) => r.exposureLabel },
        { key: 'status', label: '账号状态', value: (r) => r.status },
        { key: 'memberStatus', label: '会员状态', value: (r) => r.memberStatus },
        { key: 'memberExpireAt', label: '会员到期时间', value: (r) => (r.memberExpireAt ? dateText(r.memberExpireAt) : '') },
        { key: 'expireDays', label: '距到期天数', value: (r) => (r.memberExpireAt ? Math.ceil((r.memberExpireAt - nowMs) / DAY_MS) : '') },
        { key: 'bizOpen1d', label: '近1天会员页打开次数', value: (r) => r.bizOpen1d },
        { key: 'bizOpen7d', label: '近7天会员页打开次数', value: (r) => r.bizOpen7d },
        { key: 'favorites', label: '收藏数', value: (r) => r.favorites },
        { key: 'follows', label: '关注数', value: (r) => r.follows },
        { key: 'products', label: '发布商品数', value: (r) => r.products },
        { key: 'demands', label: '发布需求数', value: (r) => r.demands },
        { key: 'leads', label: '咨询数', value: (r) => r.leads },
        { key: 'lastActiveAt', label: '最后活跃时间', value: (r) => (r.lastActiveAt ? dateText(r.lastActiveAt) : '') },
        { key: 'createdAt', label: '注册时间', value: (r) => (r.createdAt ? dateText(r.createdAt) : (r.joined || '')) },
        { key: 'note', label: '备注', value: (r) => r.note }
      ]
      const q = String(data.q || '').trim().toLowerCase().slice(0, 30)
      const phoneQuery = String(data.phone || '').replace(/[^\d]/g, '').slice(0, 11)
      const subjectType = data.subjectType ? enumOf(data.subjectType, SUBJECT_TYPES, '主体类型') : ''
      const city = data.city ? str(data.city, { field: '城市', max: 20 }) : ''
      const status = data.status ? enumOf(data.status, ['正常', '停用'], '状态') : ''
      const memberQuery = data.member === 'yes' || data.member === 'no' ? data.member : ''
      const hasPhone = data.hasPhone === 'yes' || data.hasPhone === 'no' ? data.hasPhone : ''
      const hasLicense = data.hasLicense === 'yes' || data.hasLicense === 'no' ? data.hasLicense : ''
      /* 资质核验筛选：与 user.list 同口径，导出沿用当前筛选条件 */
      const qualStatus = ['verified', 'unverified', 'none'].includes(data.qualStatus) ? data.qualStatus : ''
      const agencyQuery = data.agency === 'buy' || data.agency === 'sell' ? data.agency : ''
      const exposureQuery = data.exposure === 'open' || data.exposure === 'hidden' ? data.exposure : ''
      const nowMs = now()
      const [users, profiles, accesses, favorites, follows, products, demands, leads, agencies, events] = await Promise.all([
        repo.find('users', {}, { limit: 20000 }),
        repo.find('profiles', {}, { limit: 20000 }),
        repo.find('bizAccess', {}, { limit: 20000 }),
        repo.find('favorites', {}, { limit: 50000 }),
        repo.find('follows', {}, { limit: 50000 }),
        repo.find('products', {}, { limit: 50000 }),
        repo.find('demands', {}, { limit: 50000 }),
        repo.find('leads', {}, { limit: 50000 }),
        repo.find('agencies', { deleted: { $ne: true } }, { limit: 100000 }),
        repo.find('userEvents', { kind: 'biz_open' }, { limit: 200000 })
      ])
      const profileOf = new Map()
      profiles.forEach((p) => { if (p && p.uid) profileOf.set(p.uid, p) })
      const accessOf = new Map()
      accesses.forEach((row) => { if (row && (row.uid || row.id)) accessOf.set(row.uid || row.id, row) })
      const memberStatusOf = (uid) => {
        const row = accessOf.get(uid)
        if (!row) return { status: '未开通', expireAt: 0 }
        if (row.status === '已停用') return { status: '已停用', expireAt: Number(row.expireAt) || 0 }
        if (row.status === '待确认') return { status: '待确认', expireAt: Number(row.expireAt) || 0 }
        if (row.status === '已开通' && Number(row.expireAt) > nowMs) return { status: '已开通', expireAt: Number(row.expireAt) || 0 }
        return { status: '已到期', expireAt: Number(row.expireAt) || 0 }
      }
      const countBy = (rows, field) => {
        const map = new Map()
        rows.forEach((row) => {
          const uid = row && row[field]
          if (uid) map.set(uid, (map.get(uid) || 0) + 1)
        })
        return map
      }
      const favCount = countBy(favorites.filter((row) => row && row.deleted !== true), 'uid')
      const followCount = countBy(follows.filter((row) => row && row.deleted !== true), 'uid')
      const productCount = countBy(products, 'ownerId')
      const demandCount = countBy(demands, 'ownerId')
      const leadCount = countBy(leads, 'uid')
      const agencyBuyCount = countBy(agencies.filter((row) => row && (row.side || 'buy') === 'buy'), 'ownerId')
      const agencySellCount = countBy(agencies.filter((row) => row && row.side === 'sell'), 'ownerId')
      const event1d = new Map()
      const event7d = new Map()
      events.forEach((row) => {
        const uid = row && row.uid
        const at = Number(row && row.at) || 0
        if (!uid || !at) return
        if (at >= nowMs - DAY_MS) event1d.set(uid, (event1d.get(uid) || 0) + 1)
        if (at >= nowMs - 7 * DAY_MS) event7d.set(uid, (event7d.get(uid) || 0) + 1)
      })
      const all = users.map((u) => {
        const p = profileOf.get(u.id) || {}
        const member = memberStatusOf(u.id)
        let subject = ''
        if (p.subjectCipher) {
          try {
            subject = decryptFieldOf({
              keys, collection: 'profiles', field: 'subject', recordId: p.uid || p.id, cipher: p.subjectCipher
            }) || ''
          } catch (err) { subject = '' }
        }
        let phone = ''
        if (u.phoneCipher) {
          try {
            phone = decryptField({ keys, token: u.phoneCipher, aad: phoneAad(u.id) }) || ''
          } catch (err) { phone = '' }
        }
        const userNo = userNoOf(u.id)
        const quals = Array.isArray(p.quals) ? p.quals : []
        const licenseDone = quals.some((x) => x && (x.kind === 'license' || x.name === '营业执照') && x.fileId)
        const qualVerified = quals.some((x) => x && x.status === '已核验')
        return {
          id: u.id,
          userNo,
          nick: String(u.nick || ''),
          phone,
          subject,
          subjectType: p.subjectType || '',
          exposure: p.exposure === 'open' ? 'open' : 'hidden',
          status: u.status || '正常',
          exposureLabel: EXPOSURE_LABELS[p.exposure || EXPOSURES.HIDDEN] || EXPOSURE_LABELS.hidden,
          memberStatus: member.status,
          memberExpireAt: member.expireAt,
          bizOpen1d: event1d.get(u.id) || 0,
          bizOpen7d: event7d.get(u.id) || 0,
          hasLicense: licenseDone,
          qualCount: quals.length,
          qualVerified,
          qualStatusKey: quals.length ? (qualVerified ? 'verified' : 'unverified') : 'none',
          agencyBuy: agencyBuyCount.get(u.id) || 0,
          agencySell: agencySellCount.get(u.id) || 0,
          favorites: favCount.get(u.id) || 0,
          follows: followCount.get(u.id) || 0,
          products: productCount.get(u.id) || 0,
          demands: demandCount.get(u.id) || 0,
          leads: leadCount.get(u.id) || 0,
          lastActiveAt: Number(u.lastActiveAt || u.lastLoginAt) || 0,
          createdAt: Number(u.createdAt) || 0,
          joined: p.joined || '',
          note: String(u.adminNote || ''),
          phoneSaved: !!u.phoneCipher,
          _hay: [String(u.nick || ''), subject, p.subjectType || '', p.city || '', u.id, userNo].join(' ').toLowerCase()
        }
      })
      const filtered = all.filter((r) => {
        if (subjectType && r.subjectType !== subjectType) return false
        if (city && (profileOf.get(r.id) || {}).city !== city) return false
        if (status && r.status !== status) return false
        if (phoneQuery && String(r.phone || '').indexOf(phoneQuery) < 0) return false
        if (memberQuery === 'yes' && r.memberStatus !== '已开通') return false
        if (memberQuery === 'no' && r.memberStatus === '已开通') return false
        if (hasPhone === 'yes' && !r.phoneSaved) return false
        if (hasPhone === 'no' && r.phoneSaved) return false
        if (hasLicense === 'yes' && !r.hasLicense) return false
        if (hasLicense === 'no' && r.hasLicense) return false
        if (qualStatus && r.qualStatusKey !== qualStatus) return false
        if (agencyQuery === 'buy' && !r.agencyBuy) return false
        if (agencyQuery === 'sell' && !r.agencySell) return false
        if (exposureQuery && r.exposure !== exposureQuery) return false
        if (q && r._hay.indexOf(q) < 0) return false
        return true
      })
      filtered.sort((a, b) => String(b.joined).localeCompare(String(a.joined)) || String(a.id).localeCompare(String(b.id)))
      const rows = filtered.slice(0, 5000)
      /* 未传字段时导出全部列（兼容脚本 / 旧版管理端）；传了则只输出勾选的列 */
      const asked = Array.isArray(data.fields)
        ? data.fields.map((key) => String(key || '').trim()).filter(Boolean).slice(0, 40)
        : []
      const columns = asked.length
        ? EXPORT_COLUMNS.filter((col) => asked.indexOf(col.key) > -1)
        : EXPORT_COLUMNS
      if (!columns.length) throw new AppError(CODES.VALIDATION, '请选择要导出的数据项')
      const header = columns.map((col) => col.label)
      const body = rows.map((r) => columns.map((col) => col.value(r)))
      const buffer = writeXlsx([{ name: '用户运营数据', rows: [header].concat(body) }])
      const reason = [
        q ? `关键词=${q}` : '',
        phoneQuery ? `手机号=${phoneQuery}` : '',
        status ? `状态=${status}` : '',
        memberQuery ? `会员=${memberQuery}` : '',
        subjectType ? `主体类型=${subjectType}` : '',
        hasPhone ? `留存手机号=${hasPhone}` : '',
        hasLicense ? `资质=${hasLicense}` : '',
        qualStatus ? `资质核验=${qualStatus}` : '',
        agencyQuery ? `历史委托=${agencyQuery}` : '',
        exposureQuery ? `公开范围=${exposureQuery}` : '',
        city ? `城市=${city}` : ''
      ].filter(Boolean).join('；') || '全量'
      try {
        await appendAudit(repo, {
          actorType: 'admin',
          actorId: session.accountId,
          action: 'user.export',
          target: 'users',
          reason: `导出用户运营数据：${reason}；字段=${columns.length}项`.slice(0, 200),
          ip: ctx.ip,
          result: 'allow',
          at: now()
        })
      } catch (err) {
        /* 审计失败不能影响导出结果 */
      }
      return {
        filename: `用户运营数据_${dayKeyOf(nowMs).replace(/-/g, '')}.xlsx`,
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        base64: buffer.toString('base64'),
        total: rows.length
      }
    },

    /**
     * 用户历史对话：该用户参与的全部站内会话（商品 / 需求直聊 + 客服留言）。
     * outbox 同一条消息按收发双方各存一份副本，payload.uid 即副本归属人，
     * 按 uid 过滤后拿到的正好是该用户视角下的消息，不会再出现重复两条。
     */
    'user.chats': async (data) => {
      const uid = str(data.uid || data.id, { field: '用户', required: true, max: 64 })
      const rows = await repo.find('outbox', { 'payload.uid': uid }, {
        sort: { field: 'createdAt', dir: 'desc' },
        limit: 1000
      })
      const map = new Map()
      for (const msg of rows) {
        const p = msg.payload || {}
        const channel = p.channel === 'kf' ? 'kf' : 'direct'
        /* 客服消息按委托 / 商品上下文拆分会话，未带上下文的仍归入默认「客服留言」 */
        const threadId = channel === 'kf'
          ? (p.targetType && p.targetId ? `kf:${p.targetType}:${p.targetId}` : 'kf')
          : (p.threadId || p.leadId || '')
        if (!threadId) continue
        let thread = map.get(threadId)
        if (!thread) {
          thread = {
            threadId,
            channel,
            title: '',
            targetType: '',
            targetId: '',
            targetTitle: '',
            peerUid: '',
            peerName: '',
            total: 0,
            lastBody: '',
            lastKind: 'text',
            lastFrom: '',
            lastAt: 0
          }
          map.set(threadId, thread)
        }
        thread.total += 1
        if (!thread.title && p.title) thread.title = p.title
        if (!thread.targetType && p.targetType) thread.targetType = p.targetType
        if (!thread.targetId && p.targetId) thread.targetId = p.targetId
        if (!thread.targetTitle && p.targetTitle) thread.targetTitle = p.targetTitle
        if (!thread.peerUid && p.peerUid) thread.peerUid = p.peerUid
        if (!thread.peerName && p.peerName) thread.peerName = p.peerName
        const at = Number(msg.createdAt) || 0
        if (at >= thread.lastAt) {
          thread.lastAt = at
          thread.lastBody = redactChatText(p.body || '').slice(0, 60)
          thread.lastKind = chatKindOf(p)
          thread.lastFrom = p.from || ''
        }
      }
      const threads = Array.from(map.values())
      /* 直聊补线索状态；对方昵称取真实昵称（私密发布对买家匿名，但管理端监管可见） */
      const leadMap = new Map()
      const directIds = threads.filter((t) => t.channel === 'direct').map((t) => t.threadId)
      if (directIds.length) {
        const leads = await repo.find('leads', { id: { $in: directIds } }, { limit: 200 })
        leads.forEach((row) => leadMap.set(row.id, row))
      }
      const peerIds = Array.from(new Set(threads.map((t) => t.peerUid).filter(Boolean)))
      const nickMap = new Map()
      if (peerIds.length) {
        const users = await repo.find('users', { id: { $in: peerIds } }, { limit: 200 })
        users.forEach((user) => nickMap.set(user.id, user.nick || ''))
      }
      const items = threads.map((t) => {
        const lead = leadMap.get(t.threadId) || {}
        return {
          threadId: t.threadId,
          channel: t.channel,
          title: maskSensitiveText(t.targetTitle || t.title || (t.channel === 'kf' ? '客服留言' : '直聊会话')),
          targetType: t.targetType,
          targetId: t.targetId,
          targetTitle: maskSensitiveText(t.targetTitle || ''),
          peerUid: t.peerUid,
          peerName: maskSensitiveText(nickMap.get(t.peerUid) || t.peerName || (t.channel === 'kf' ? '平台客服' : '对方')),
          leadStatus: lead.status || '',
          total: t.total,
          lastBody: t.lastBody,
          lastKind: t.lastKind,
          lastFrom: t.lastFrom,
          lastAt: t.lastAt,
          lastText: dateText(t.lastAt)
        }
      })
      items.sort((a, b) => b.lastAt - a.lastAt)
      const result = {
        items,
        total: items.length,
        messages: items.reduce((sum, item) => sum + item.total, 0)
      }
      assertNoPlaintextContact(result)
      return result
    },

    /** 用户历史对话 · 单个会话明细：按该用户视角返回完整消息流（含图片 / 名片） */
    'user.chatThread': async (data) => {
      const uid = str(data.uid || data.id, { field: '用户', required: true, max: 64 })
      const threadId = str(data.threadId, { field: '会话', required: true, max: 64 })
      const channel = data.channel === 'kf' ? 'kf' : 'direct'
      /* 委托 / 商品维度的客服会话：threadId 形如 kf:agency:<id>，按上下文过滤消息 */
      const kfRef = channel === 'kf' && /^kf:(agency|product|demand):.+$/.test(threadId)
        ? threadId.split(':')
        : null
      const query = kfRef
        ? { 'payload.uid': uid, 'payload.channel': 'kf', 'payload.targetType': kfRef[1], 'payload.targetId': kfRef.slice(2).join(':') }
        : channel === 'kf'
          ? { 'payload.uid': uid, 'payload.channel': 'kf' }
          : { 'payload.uid': uid, 'payload.threadId': threadId }
      const rows = await repo.find('outbox', query, {
        sort: { field: 'createdAt', dir: 'asc' },
        limit: 500
      })
      const self = await repo.get('users', uid)
      const selfName = maskSensitiveText((self && self.nick) || '用户')
      let peerUid = ''
      let storedPeerName = ''
      for (const msg of rows) {
        const p = msg.payload || {}
        if (!peerUid && p.peerUid) peerUid = p.peerUid
        if (!storedPeerName && p.peerName) storedPeerName = p.peerName
      }
      const peer = peerUid ? await repo.get('users', peerUid) : null
      const peerName = maskSensitiveText((peer && peer.nick) || storedPeerName || '对方')
      const items = rows.map((msg) => {
        const p = msg.payload || {}
        const outgoing = channel === 'kf' ? p.from === 'user' : p.from === 'me'
        const at = Number(msg.createdAt) || 0
        const media = mediaState(p, at, now())
        return {
          id: msg.id,
          outgoing,
          kind: chatKindOf(p),
          body: redactChatText(p.body || ''),
          image: media.image,
          video: media.video,
          poster: media.poster,
          mediaExpired: media.expired,
          card: p.card || null,
          senderName: channel === 'kf'
            ? (outgoing ? selfName : (p.staffName || '平台客服'))
            : (outgoing ? selfName : peerName),
          at,
          atText: dateText(at)
        }
      })
      const result = {
        threadId,
        channel,
        selfName,
        peerName: channel === 'kf' ? '平台客服' : peerName,
        items,
        total: items.length
      }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 商品下的全部对话：商品发布方与咨询方围绕该商品的直聊 + 平台客服会话。
     * 直聊只取发送方副本（payload.from=me），避免同一条消息的双方副本重复出现；
     * 客服会话既包含明确指向该商品的留言，也包含该商品已有直聊线索用户的客服咨询。
     */
    'product.chats': async (data) => {
      const id = str(data.id || data.productId, { field: '商品', required: true, max: 64 })
      const product = await repo.get('products', id)
      if (!product || product.deleted === true) throw new AppError(CODES.NOT_FOUND, '商品不存在或已删除')
      const leads = await repo.find('leads', { productId: id }, { limit: 200 })
      const threadIds = leads.map((lead) => lead.id).filter(Boolean)
      const leadUids = new Set(leads.map((lead) => lead.uid).filter(Boolean))
      const rows = threadIds.length
        ? await repo.find('outbox', { 'payload.threadId': { $in: threadIds }, 'payload.from': 'me' }, {
          sort: { field: 'createdAt', dir: 'asc' },
          limit: 2000
        })
        : []
      const byThread = new Map()
      for (const msg of rows) {
        const p = msg.payload || {}
        if (!p.threadId) continue
        if (!byThread.has(p.threadId)) byThread.set(p.threadId, [])
        byThread.get(p.threadId).push(msg)
      }
      /* 客服会话：同一 uid 可能既发过商品定向留言，也有更早的普通客服咨询，统一合并到该商品的客服会话 */
      const kfAll = await repo.find('outbox', { 'payload.channel': 'kf' }, {
        sort: { field: 'createdAt', dir: 'asc' },
        limit: 2000
      })
      const kfByUid = new Map()
      const seenKf = new Set()
      for (const msg of kfAll) {
        const p = msg.payload || {}
        if (!p.uid) continue
        const targeted = p.targetType === 'product' && p.targetId === id
        if (!targeted && !leadUids.has(p.uid)) continue
        if (seenKf.has(msg.id)) continue
        seenKf.add(msg.id)
        if (!kfByUid.has(p.uid)) kfByUid.set(p.uid, [])
        kfByUid.get(p.uid).push(msg)
      }
      const leadMap = new Map(leads.map((lead) => [lead.id, lead]))
      const uids = new Set()
      for (const msgs of byThread.values()) {
        for (const msg of msgs) {
          const p = msg.payload || {}
          if (p.uid) uids.add(p.uid)
          if (p.peerUid) uids.add(p.peerUid)
        }
      }
      for (const lead of leads) {
        if (lead.uid) uids.add(lead.uid)
        if (lead.ownerId) uids.add(lead.ownerId)
      }
      for (const uid of kfByUid.keys()) uids.add(uid)
      const users = uids.size ? await repo.find('users', { id: { $in: Array.from(uids) } }, { limit: 500 }) : []
      const nickMap = new Map(users.map((user) => [user.id, maskSensitiveText(user.nick || '用户')]))

      const allMessages = rows.concat(Array.from(kfByUid.values()).reduce((acc, list) => acc.concat(list), []))
      /* 聊天图片 / 视频是 cloud:// fileID，管理端无法直接渲染，统一换成临时链接；失败则保留原值 */
      const cloudIds = Array.from(new Set(allMessages
        .reduce((acc, msg) => {
          const p = msg.payload || {}
          if (/^cloud:\/\//i.test(String(p.image || ''))) acc.push(String(p.image))
          if (/^cloud:\/\//i.test(String(p.video || ''))) acc.push(String(p.video))
          if (/^cloud:\/\//i.test(String(p.poster || ''))) acc.push(String(p.poster))
          return acc
        }, [])))
      const imageUrls = {}
      if (cloudIds.length && cloud && typeof cloud.getTempFileURL === 'function') {
        try {
          const res = await cloud.getTempFileURL({ fileList: cloudIds })
          ;((res && res.fileList) || []).forEach((f) => {
            if (f && f.fileID && f.tempFileURL) imageUrls[f.fileID] = f.tempFileURL
          })
        } catch (err) { /* 换链失败时保留原值，前端给出占位提示 */ }
      }
      const cardCache = new Map()
      const messageOf = async (msg) => {
        const p = msg.payload || {}
        const kind = chatKindOf(p)
        const media = mediaState(p, msg.createdAt, now())
        let card = null
        if (kind === 'card' && p.card) {
          const ownerUid = String(p.card.uid || p.uid || '')
          if (!ownerUid) {
            card = p.card
          } else {
            if (!cardCache.has(ownerUid)) cardCache.set(ownerUid, await resolveChatCard(p.card, ownerUid))
            card = cardCache.get(ownerUid)
          }
        }
        const fromStaff = p.from === 'staff'
        const nickname = nickMap.get(p.uid) || '用户'
        return {
          id: msg.id,
          fromUid: fromStaff ? '' : (p.uid || ''),
          fromName: fromStaff ? (p.staffName || '平台客服') : nickname,
          fromStaff,
          body: redactChatText(p.body || ''),
          kind,
          image: media.image ? (imageUrls[media.image] || media.image) : '',
          video: media.video ? (imageUrls[media.video] || media.video) : '',
          poster: media.poster ? (imageUrls[media.poster] || media.poster) : '',
          mediaExpired: media.expired,
          card,
          at: Number(msg.createdAt) || 0
        }
      }
      const threads = []
      for (const [threadId, msgs] of byThread.entries()) {
        const lead = leadMap.get(threadId) || {}
        const messages = []
        for (const msg of msgs) messages.push(await messageOf(msg))
        messages.sort((a, b) => a.at - b.at)
        const last = messages[messages.length - 1] || {}
        threads.push({
          threadId,
          channel: 'direct',
          uid: lead.uid || '',
          userName: nickMap.get(lead.uid) || '用户',
          peerUid: lead.ownerId || '',
          peerName: nickMap.get(lead.ownerId) || '发布方',
          total: messages.length,
          lastBody: last.body || '',
          lastAt: last.at || 0,
          messages
        })
      }
      for (const [uid, msgs] of kfByUid.entries()) {
        const messages = []
        for (const msg of msgs) messages.push(await messageOf(msg))
        messages.sort((a, b) => a.at - b.at)
        const last = messages[messages.length - 1] || {}
        threads.push({
          threadId: `kf:product:${id}:${uid}`,
          channel: 'kf',
          uid,
          userName: nickMap.get(uid) || '用户',
          peerUid: '',
          peerName: '平台客服',
          total: messages.length,
          lastBody: last.body || '',
          lastAt: last.at || 0,
          messages
        })
      }
      threads.sort((a, b) => b.lastAt - a.lastAt)
      const result = { id, title: maskSensitiveText(product.title || ''), threads }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 用户操作记录：按类型 / 时间筛选，默认返回最近 300 条；90 天前数据顺手清理。
     */
    'user.events': async (data) => {
      const uid = str(data.uid || data.id, { field: '用户', required: true, max: 64 })
      const kind = data.kind ? enumOf(data.kind, EVENT_KIND_LIST, '行为类型') : ''
      const q = str(data.q, { field: '搜索', max: 40 })
      const days = Math.max(0, Math.min(90, Number(data.days) || 0))
      const at = now()
      const rows = await repo.find('userEvents', { uid }, { sort: { field: 'at', dir: 'desc' }, limit: 500 })
      await cleanupUserEvents(repo, at, true)
      const items = rows.filter((row) => {
        if (kind && row.kind !== kind) return false
        if (days > 0 && Number(row.at) < at - days * 86400000) return false
        if (q && String(row.title || '').indexOf(q) < 0) return false
        return true
      }).slice(0, 300).map((row) => ({
        id: row.id,
        kind: row.kind || '',
        label: row.label || '',
        page: row.page || '',
        refId: row.refId || '',
        title: maskSensitiveText(row.title || ''),
        at: Number(row.at) || 0,
        atText: dateText(row.at)
      }))
      const counts = rows.reduce((acc, row) => {
        acc[row.kind] = (acc[row.kind] || 0) + 1
        return acc
      }, {})
      return { items, total: items.length, counts }
    },

    /** 资质原件预览：云存储 fileID 换临时链接；https 直链直接返回 */
    'qual.fileUrl': async (data, ctx) => {
      const uid = str(data.uid || data.id, { field: '用户', required: true, max: 64 })
      const fileId = str(data.fileId, { field: '原件', required: true, max: 1024 })
      /* 归属校验：只允许换取该用户名下已登记的资质原件，杜绝拿任意 fileID 换临时链接 */
      const rows = await repo.find('profiles', { uid }, { limit: 1 })
      const profile = rows[0]
      if (!profile) throw new AppError(CODES.NOT_FOUND, '用户未上传资质')
      const quals = Array.isArray(profile.quals) ? profile.quals : []
      const owned = quals.some((row) => row && typeof row === 'object' && String(row.fileId || '') === fileId)
      if (!owned) throw new AppError(CODES.NOT_FOUND, '原件不存在或不属于该用户')
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: (ctx && ctx.session && ctx.session.accountId) || '',
        action: 'qual.fileUrl',
        target: uid,
        reason: '查看资质原件',
        ip: ctx && ctx.ip,
        result: 'allow',
        at: now()
      })
      if (/^https:\/\//i.test(fileId)) return { url: fileId }
      if (!/^cloud:\/\//i.test(fileId)) throw new AppError(CODES.VALIDATION, '原件地址不正确')
      if (!cloud || typeof cloud.getTempFileURL !== 'function') {
        throw new AppError(CODES.INTERNAL, '当前环境不支持在线预览原件')
      }
      const res = await cloud.getTempFileURL({ fileList: [fileId] })
      const file = (res && res.fileList && res.fileList[0]) || {}
      if (!file.tempFileURL) throw new AppError(CODES.NOT_FOUND, '原件不存在或已过期')
      return { url: file.tempFileURL }
    },

    /**
     * 审核材料预览：按商品 / 需求 / 代采代售记录取出用户上传的文件并换临时链接。
     * 只解析该记录自身 media 里的 fileId，杜绝拿任意 fileID 换链接。
     */
    'media.fileUrls': async (data, ctx) => {
      const id = str(data.id, { field: '记录', required: true, max: 64 })
      const source = enumOf(data.source || 'agency', ['product', 'demand', 'agency'], '记录类型')
      const collection = source === 'product' ? 'products' : (source === 'demand' ? 'demands' : 'agencies')
      const rows = await repo.find(collection, { id }, { limit: 1 })
      const doc = rows[0]
      if (!doc) throw new AppError(CODES.NOT_FOUND, '记录不存在')
      const list = mediaMeta(doc.media).filter((m) => m.fileId)
      const cloudIds = list.filter((m) => /^cloud:\/\//i.test(m.fileId)).map((m) => m.fileId)
      const urlMap = {}
      if (cloudIds.length) {
        if (!cloud || typeof cloud.getTempFileURL !== 'function') {
          throw new AppError(CODES.INTERNAL, '当前环境不支持在线预览原件')
        }
        const res = await cloud.getTempFileURL({ fileList: cloudIds })
        ;((res && res.fileList) || []).forEach((f) => {
          if (f && f.fileID && f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
        })
      }
      const items = list.map((m) => ({
        name: m.name,
        type: m.type,
        kind: m.kind,
        url: /^https:\/\//i.test(m.fileId) ? m.fileId : (urlMap[m.fileId] || '')
      }))
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: (ctx && ctx.session && ctx.session.accountId) || '',
        action: 'media.fileUrls',
        target: `${source}:${id}`,
        reason: '审核查看上传材料',
        ip: ctx && ctx.ip,
        result: 'allow',
        at: now()
      })
      return { items }
    },

    /** 资质核验：按「类型 + 名称」更新状态（待核验 / 已核验 / 已驳回） */
    'qual.verify': async (data, ctx) => {
      const uid = str(data.uid || data.id, { field: '用户', required: true, max: 64 })
      const name = str(data.name, { field: '材料名称', required: true, max: 120 })
      const kind = str(data.kind || 'other', { field: '材料类型', max: 20 })
      const status = enumOf(data.status, ['待核验', '已核验', '已驳回'], '核验状态')
      const reviewReason = str(data.reason || '', { field: '驳回原因', max: 120 })
      const rows = await repo.find('profiles', { uid }, { limit: 1 })
      const profile = rows[0]
      if (!profile) throw new AppError(CODES.NOT_FOUND, '用户未上传资质')
      const quals = (Array.isArray(profile.quals) ? profile.quals : []).map((row) => {
        const item = row && typeof row === 'object' ? Object.assign({}, row) : { name: String(row || ''), kind: 'other' }
        if (String(item.name || '') === name && String(item.kind || 'other') === kind) {
          item.status = status
          item.verifiedAt = now()
          item.verifiedBy = (ctx.session && ctx.session.accountId) || ''
          /* 驳回原因随材料一起存，用户资料页直接展示，避免「一直待核验」 */
          item.reason = status === '已驳回' ? (reviewReason || '材料不清晰或不完整，请重新上传') : ''
        }
        return item
      })
      await repo.updateWhere('profiles', { uid }, { quals, updatedAt: now() })
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: (ctx.session && ctx.session.accountId) || '',
        action: 'qual.verify',
        target: `${uid}:${kind}:${name}`,
        reason: status + (reviewReason ? '：' + reviewReason : ''),
        ip: ctx.ip,
        result: 'allow',
        at: now()
      })
      if (status !== '待核验') {
        try {
          await notifyUser(uid, {
            title: status === '已核验' ? '资质核验已通过' : '资质核验未通过',
            body: status === '已核验'
              ? `「${name}」已通过平台核验。`
              : `「${name}」未通过核验：${reviewReason || '材料不清晰或不完整'}，请在「我的资料」重新上传。`,
            reason: reviewReason,
            targetType: 'qual',
            targetId: `${kind}:${name}`
          })
        } catch (notifyErr) { /* 核验结果已落库：回执失败不回滚 */ }
      }
      return { uid, name, kind, status, reason: reviewReason }
    },

    /** 收藏监管：全量收藏记录，可按用户 / 对象类型筛选 */
    'favorite.list': async (data) => {
      const uid = str(data.uid, { field: '用户', max: 64 })
      const query = { deleted: { $ne: true } }
      if (uid) query.uid = uid
      if (data.targetType) query.targetType = str(data.targetType, { field: '对象类型', max: 20 })
      const rows = await repo.find('favorites', query, { sort: { field: 'updatedAt', dir: 'desc' }, limit: 300 })
      const items = []
      for (const row of rows) {
        const user = await repo.get('users', row.uid)
        items.push({
          id: row.id,
          uid: row.uid,
          nick: (user && user.nick) || '用户' + String(row.uid).slice(-4),
          targetType: row.targetType || '',
          targetId: row.targetId || '',
          at: Number(row.updatedAt || row.createdAt) || 0,
          atText: dateText(row.updatedAt || row.createdAt)
        })
      }
      return { items, total: items.length }
    },

    /** 关注监管：全量关注记录，可按用户筛选 */
    'follow.list': async (data) => {
      const uid = str(data.uid, { field: '用户', max: 64 })
      const query = { deleted: { $ne: true } }
      if (uid) query.uid = uid
      const rows = await repo.find('follows', query, { sort: { field: 'updatedAt', dir: 'desc' }, limit: 300 })
      const items = []
      for (const row of rows) {
        const user = await repo.get('users', row.uid)
        items.push({
          id: row.id,
          uid: row.uid,
          nick: (user && user.nick) || '用户' + String(row.uid).slice(-4),
          targetType: row.targetType || '',
          targetKey: row.targetKey || '',
          targetNick: row.nick || '',
          at: Number(row.updatedAt || row.createdAt) || 0,
          atText: dateText(row.updatedAt || row.createdAt)
        })
      }
      return { items, total: items.length }
    },

    /**
     * 单个用户的手动调整：账号状态 / 对外曝光范围 / 内部备注。
     * 客服也可以调用（用户页需要），但只改这三项，不改动主体资质等敏感资料。
     */
    'user.admin': async (data, ctx) => {
      const id = str(data.uid || data.id, { field: '用户', required: true, max: 64 })
      const user = await repo.get('users', id)
      if (!user) throw new AppError(CODES.NOT_FOUND, '用户不存在')
      const status = data.status ? enumOf(data.status, ['正常', '停用'], '账号状态') : (user.status || '正常')
      const exposure = data.exposure ? enumOf(data.exposure, Object.values(EXPOSURES), '曝光范围') : ''
      const note = data.note === undefined ? (user.adminNote || '') : str(data.note, { field: '内部备注', max: 200 })
      const at = now()
      /* 功能限制：{publish / news / chat: 天数}，0 表示解除，不传表示保持不动 */
      let limit = null
      if (data.restrict && typeof data.restrict === 'object') {
        limit = applyRestrictions(user, {
          publish: data.restrict.publish,
          news: data.restrict.news,
          chat: data.restrict.chat,
          reason: data.restrictReason !== undefined ? data.restrictReason : data.restrict.reason
        }, at, ctx.session ? ctx.session.accountId : '')
      }
      const patch = { status, adminNote: note, updatedAt: at }
      if (limit) patch.restrictions = limit.restrictions
      await repo.updateWhere('users', { id }, patch)
      if (exposure) {
        const profile = (await repo.find('profiles', { uid: id }, { limit: 1 }))[0]
        if (profile) await repo.updateWhere('profiles', { uid: id }, { exposure })
      }
      const limitState = limit ? stateOf({ restrictions: limit.restrictions }, at) : null
      const limitText = limitState
        ? ['publish', 'news', 'chat']
            .filter((kind) => limitState[kind])
            .map((kind) => limitState[kind].label + '至 ' + limitState[kind].untilText)
            .join('；')
        : ''
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: ctx.session ? ctx.session.accountId : '',
        action: 'user.admin',
        target: id,
        reason: `账号 ${status}；曝光 ${exposure || '不变'}；备注${note ? '已更新' : '为空'}` +
          (limit ? `；限制 ${limitText || '已解除'}${limit.restrictions.reason ? '（' + limit.restrictions.reason + '）' : ''}` : ''),
        ip: ctx.ip,
        result: 'allow',
        at
      })
      /* 停用 / 恢复必须通知本人，否则用户不知道为什么突然不能发布 */
      if (status !== (user.status || '正常')) {
        try {
          await notifyUser(id, {
            title: status === '停用' ? '账号已被停用' : '账号已恢复正常',
            body: status === '停用'
              ? '你的账号已被平台停用，暂时无法发布、咨询与联系。如有疑问请在「我的」联系在线客服核实。'
              : '你的账号已恢复正常，可以继续发布与咨询。',
            targetType: 'account',
            targetId: id
          })
        } catch (notifyErr) { /* 状态已落库：回执失败不回滚 */ }
      }
      /* 功能限制变化也要通知：用户被举报处置后需要知道具体到哪天、为什么 */
      if (limit && limit.changed) {
        try {
          const tips = ['publish', 'news', 'chat']
            .filter((kind) => limitState[kind])
            .map((kind) => `「${limitState[kind].label}」至 ${limitState[kind].untilText}`)
          await notifyUser(id, {
            title: tips.length ? '账号功能受限' : '账号功能限制已解除',
            body: tips.length
              ? `你的账号功能受限：${tips.join('；')}。${limit.restrictions.reason ? '原因：' + limit.restrictions.reason + '。' : ''}如有疑问请在「我的」联系在线客服。`
              : '你的账号功能限制已解除，可以继续发布与咨询。',
            targetType: 'account',
            targetId: id
          })
        } catch (notifyErr) { /* 限制已落库：通知失败不回滚 */ }
      }
      return { uid: id, status, exposure, note, restrictions: stateOf({ restrictions: (limit || user).restrictions }, at) }
    },

    /* 注销申请：用户端提交，管理员核实后停用账号。仅管理员可处理，客服只读。 */
    'accountRequest.list': async (data) => {
      const status = data.status ? enumOf(data.status, ['待处理', '已通过', '已驳回', '已撤销'], '状态') : '待处理'
      const rows = await repo.find('accountRequests', status ? { status } : {}, {
        sort: { field: 'createdAt', dir: 'desc' },
        limit: 200
      })
      const items = []
      for (const row of rows) {
        const user = await repo.get('users', row.uid)
        items.push({
          id: row.id,
          uid: row.uid,
          nick: (user && user.nick) || '用户' + String(row.uid || '').slice(-4),
          userStatus: (user && user.status) || '正常',
          reason: row.reason || '',
          status: row.status || '待处理',
          handlerNote: row.handlerNote || '',
          createdAt: Number(row.createdAt) || 0,
          handledAt: Number(row.handledAt) || 0
        })
      }
      return { items, total: items.length }
    },

    /**
     * 审核注销申请：通过后直接把 users.status 置为停用，用户端所有接口立即失效；
     * 驳回必须写原因，结果通过站内信回写给本人。
     */
    'accountRequest.handle': async (data, ctx) => {
      const id = str(data.id, { field: '申请标识', required: true, max: 64 })
      const decision = enumOf(data.decision, ['已通过', '已驳回'], '处理结论')
      const note = str(data.note || '', { field: '处理说明', max: 200 })
      if (decision === '已驳回' && !note) {
        throw new AppError(CODES.VALIDATION, '驳回注销申请需要填写原因')
      }
      const doc = await repo.get('accountRequests', id)
      if (!doc) throw new AppError(CODES.NOT_FOUND, '注销申请不存在')
      if ((doc.status || '待处理') !== '待处理') {
        throw new AppError(CODES.CONFLICT, '该申请已处理，请刷新后查看')
      }
      const at = now()
      const actorId = ctx.session ? ctx.session.accountId : ''
      await repo.updateWhere('accountRequests', { id }, {
        status: decision,
        handlerNote: note,
        handledAt: at,
        handledBy: actorId,
        updatedAt: at
      })
      if (decision === '已通过' && doc.uid) {
        const user = await repo.get('users', doc.uid)
        if (user) {
          await repo.updateWhere('users', { id: doc.uid }, { status: '停用', updatedAt: at })
        }
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId,
        action: 'account.deleteHandle',
        target: doc.uid || id,
        reason: decision + (note ? '：' + note : ''),
        ip: ctx.ip,
        result: 'allow',
        at
      })
      if (doc.uid) {
        try {
          await notifyUser(doc.uid, {
            title: decision === '已通过' ? '账号注销已完成' : '账号注销申请未通过',
            body: decision === '已通过'
              ? '你的账号已按申请注销，将无法再登录与发布。如需恢复请联系平台客服。'
              : '你的注销申请暂未通过：' + (note || '资料核实未完成') + '。如有疑问请联系在线客服。',
            targetType: 'account',
            targetId: doc.uid
          })
        } catch (notifyErr) { /* 状态已落库：回执失败不回滚 */ }
      }
      return { id, status: decision }
    },

    /**
     * 系统设置：企微活码、商机套餐、平台信息。
     * 读取对客服开放（用户页展示套餐口径）；写入仅管理员。
     */
    'setting.get': async () => {
      const doc = (await repo.get('settings', 'site')) || {}
      return {
        settings: {
          qrUrl: doc.qrUrl || '',
          qrNote: doc.qrNote || '添加企业微信客服，核对收款后即时开通商机会员',
          wecomId: doc.wecomId || '',
          planPrice: doc.planPrice || '99 元 / 月',
          planDays: Number(doc.planDays) || 30,
          /* 四档套餐：未配置时前端回落默认四档，保存后原样返回 */
          plans: Array.isArray(doc.plans) && doc.plans.length ? doc.plans : undefined,
          planNote: doc.planNote || '商机会员可按需求匹配全平台同类产品，并查看已领取商机的联系方式',
          siteName: doc.siteName || '算力聚合',
          servicePhone: doc.servicePhone || '',
          serviceTime: doc.serviceTime || '工作日 09:00 - 18:00',
          apiBase: doc.apiBase || '',
          /* 微信订阅消息模板 ID：配置后小程序才能拉起授权并推送 */
          tmplInquiry: doc.tmplInquiry || '',
          tmplChat: doc.tmplChat || '',
          tmplSystem: doc.tmplSystem || '',
          tmplBiz: doc.tmplBiz || '',
          /* 首页跑马灯横幅：标题横向滚动，点击弹窗展示详情 */
          bannerEnabled: doc.bannerEnabled !== false,
          bannerSpeed: Number(doc.bannerSpeed) || 40,
          bannerItems: normalizeBannerItems(doc.bannerItems, { lenient: true }),
          /* 会员到期提醒：文案模板 / 提前天数 / 每日时间 / 提醒次数与间隔 */
          memberRemind: memberRemindOf(doc.memberRemind),
          updatedAt: Number(doc.updatedAt) || 0
        }
      }
    },

    'setting.save': async (data, ctx) => {
      /* 各设置页只提交自己负责的字段：未提交的键保持原值。
         否则套餐页保存（不传通知模板）会把订阅消息模板一并清空，通知整体失效 */
      const patch = {
        updatedAt: now(),
        updatedBy: ctx.session ? ctx.session.accountId : ''
      }
      if (data.qrUrl !== undefined) {
        const qrUrl = String(data.qrUrl || '').slice(0, 400000)
        if (qrUrl && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(qrUrl) && !/^https:\/\//i.test(qrUrl)) {
          throw new AppError(CODES.VALIDATION, '二维码请上传 PNG / JPG / WEBP 图片')
        }
        patch.qrUrl = qrUrl
      }
      if (data.planDays !== undefined) {
        const planDays = Number(data.planDays)
        if (!Number.isInteger(planDays) || planDays < 1 || planDays > 365) {
          throw new AppError(CODES.VALIDATION, '默认开通天数需为 1 - 365 的整数')
        }
        patch.planDays = planDays
      }
      const plans = normalizePlanConfig(data.plans)
      /* 横幅字段按需更新：只改套餐 / 平台的入口不传横幅，保持原配置 */
      const bannerItems = normalizeBannerItems(data.bannerItems, { lenient: false })
      if (data.qrNote !== undefined) patch.qrNote = str(data.qrNote, { field: '扫码说明', max: 60 })
      if (data.wecomId !== undefined) patch.wecomId = str(data.wecomId, { field: '客服企微号', max: 40 })
      if (data.planPrice !== undefined) {
        patch.planPrice = str(data.planPrice, { field: '会员价格', required: true, max: 40 })
      }
      if (data.planNote !== undefined) patch.planNote = str(data.planNote, { field: '套餐说明', max: 80 })
      if (data.siteName !== undefined) {
        patch.siteName = str(data.siteName, { field: '平台名称', required: true, max: 40 })
      }
      if (data.servicePhone !== undefined) patch.servicePhone = str(data.servicePhone, { field: '客服电话', max: 30 })
      if (data.serviceTime !== undefined) patch.serviceTime = str(data.serviceTime, { field: '服务时间', max: 40 })
      if (data.apiBase !== undefined) patch.apiBase = str(data.apiBase, { field: '接口地址', max: 120 })
      /* 模板 ID 由微信公众平台「订阅消息」生成，留空表示不推送；不提交则沿用原值 */
      if (data.tmplInquiry !== undefined) patch.tmplInquiry = str(data.tmplInquiry, { field: '咨询通知模板 ID', max: 120 })
      if (data.tmplChat !== undefined) patch.tmplChat = str(data.tmplChat, { field: '会话通知模板 ID', max: 120 })
      if (data.tmplSystem !== undefined) patch.tmplSystem = str(data.tmplSystem, { field: '系统消息模板 ID', max: 120 })
      if (data.tmplBiz !== undefined) patch.tmplBiz = str(data.tmplBiz, { field: '商机消息模板 ID', max: 120 })
      if (plans) patch.plans = plans
      if (bannerItems) patch.bannerItems = bannerItems
      /* 会员到期提醒只由媒体页「提醒设置」维护，随其它设置一起保存 */
      if (data.memberRemind !== undefined) patch.memberRemind = memberRemindOf(data.memberRemind)
      if (data.bannerEnabled !== undefined) patch.bannerEnabled = data.bannerEnabled === true || data.bannerEnabled === 'true'
      if (data.bannerSpeed !== undefined && data.bannerSpeed !== '') {
        const speed = Number(data.bannerSpeed)
        if (!Number.isFinite(speed) || speed < 10 || speed > 200) {
          throw new AppError(CODES.VALIDATION, '横幅滚动速度需为 10 - 200 之间的数字（像素 / 秒）')
        }
        patch.bannerSpeed = Math.round(speed)
      }
      const exists = await repo.get('settings', 'site')
      if (exists) {
        await repo.updateWhere('settings', { id: 'site' }, patch)
      } else {
        await repo.insert('settings', Object.assign({ id: 'site', createdAt: now() }, patch))
      }
      const merged = Object.assign({}, exists || {}, patch)
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: ctx.session ? ctx.session.accountId : '',
        action: 'setting.save',
        target: 'site',
        reason: `企微活码${merged.qrUrl ? '已上传' : '为空'}；套餐 ${merged.planPrice || ''} / ${merged.planDays || ''} 天；平台 ${merged.siteName || ''}` +
          (bannerItems ? `；首页横幅 ${bannerItems.length} 条` : ''),
        ip: ctx.ip,
        result: 'allow',
        at: patch.updatedAt
      })
      return { settings: patch }
    },

    /**
     * 媒体页 · 会员到期提醒设置。
     * 只读写 settings.memberRemind，不开放其它系统设置；客服坐席也有该动作，
     * 便于日常调整提醒文案、提前天数、提醒时间与次数。
     */
    'biz.remindSetting': async (data, ctx) => {
      const doc = (await repo.get('settings', 'site')) || {}
      if (data.memberRemind === undefined) {
        return { memberRemind: memberRemindOf(doc.memberRemind) }
      }
      const config = memberRemindOf(data.memberRemind)
      const at = now()
      const patch = {
        memberRemind: config,
        updatedAt: at,
        updatedBy: ctx.session ? ctx.session.accountId : ''
      }
      if (doc && doc.id) {
        await repo.updateWhere('settings', { id: 'site' }, patch)
      } else {
        await repo.insert('settings', Object.assign({ id: 'site', createdAt: at }, patch))
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: ctx.session ? ctx.session.accountId : '',
        action: 'biz.remindSetting',
        target: 'site',
        reason: `到期提醒${config.enabled ? '开启' : '关闭'}；提前 ${config.days} 天；${config.hour} 点后提醒；最多 ${config.maxTimes} 次；间隔 ${config.intervalDays} 天`,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return { memberRemind: config }
    },

    /**
     * 消息中心 · 会话列表。
     * 用户留言 / 系统通知 / 客服回复共用 outbox，payload.channel === 'kf' 为客服会话。
     * 会话按最后一条消息时间倒序，unread 只统计「用户发来且客服未读」的消息。
     */
    'msg.threads': async (data, ctx) => {
      const scope = await chatUidScope(ctx.session)
      const rows = await repo.find('outbox', { 'payload.channel': 'kf' }, {
        sort: { field: 'createdAt', dir: 'desc' },
        limit: 500
      })
      const map = new Map()
      for (const msg of rows) {
        const p = msg.payload || {}
        const uid = p.uid
        if (!uid) continue
        /* 会话可见范围：不是本人跟进、也不在公共池的用户直接不展示 */
        if (scope && !scope.visible(uid)) continue
        let thread = map.get(uid)
        if (!thread) {
          thread = {
            uid, nick: '', lastBody: '', lastAt: 0, lastFrom: '', total: 0, unread: 0,
            /* 会话关联的委托上下文，供消息中心直接跳转委托工单 */
            targetType: '', targetId: '', threadId: ''
          }
          map.set(uid, thread)
        }
        thread.total += 1
        const at = Number(msg.createdAt) || 0
        if (at >= thread.lastAt) {
          thread.lastAt = at
          /* 图片 / 视频 / 名片消息没有正文，预览给类型占位，避免会话行只剩「暂无消息」 */
          const preview = redactChatText(p.body || '').slice(0, 60) ||
            (p.kind === 'image' ? '［图片］' : p.kind === 'video' ? '［视频］' : p.kind === 'card' ? '［名片］' : '')
          thread.lastBody = preview
          thread.lastFrom = p.from || 'system'
          /* 以最近一条带委托上下文的消息为准，老留言无 targetType 时保留上次结果 */
          if (p.targetType) {
            thread.targetType = p.targetType
            thread.targetId = p.targetId || ''
            thread.threadId = p.threadId || ''
          }
        }
        if ((p.from || '') === 'user' && msg.readByStaff !== true) thread.unread += 1
      }
      const items = []
      for (const thread of map.values()) {
        const user = await repo.get('users', thread.uid)
        const row = Object.assign({}, thread, {
          nick: (user && user.nick) || '用户' + String(thread.uid).slice(-4)
        })
        /* 代采代售咨询：把关联工单的当前阶段、归属客服带到会话上，消息中心可一键进入作业 */
        if (thread.targetType === 'agency' && thread.targetId) {
          /* 同一委托可能被不同用户分别咨询：必须按当前会话 uid 过滤，
             否则会取到别人的咨询单，客服据此回复会串号 */
          const leads = await repo.find('leads', {
            uid: thread.uid,
            targetType: 'agency',
            targetId: thread.targetId
          }, {
            sort: { field: 'updatedAt', dir: 'desc' },
            limit: 1
          })
          const lead = leads[0] || null
          if (lead) {
            const state = ticketStateOf(lead)
            const stage = state === TICKET_STATE.TICKETED ? consultStageOf(lead) : ''
            row.leadId = lead.id
            row.agencyId = thread.targetId
            /* 标题可能被用户直接写了手机号，出站统一脱敏 */
            row.agencyTitle = redactChatText(lead.agencyTitle || '').slice(0, 40)
            row.ticketState = state
            row.ticketStateLabel = TICKET_STATE_LABELS[state] || ''
            row.consultStage = stage
            row.consultStageLabel = stage ? consultStageLabel(stage) : (TICKET_STATE_LABELS[state] || '')
            row.consultCsName = lead.csName || lead.assignedTo || ''
          }
        }
        /* 消息中心生成的咨询工单没有委托ID，按用户兜底关联，会话里同样能直接进入工单 */
        if (!row.leadId) {
          const leads = await repo.find('leads', {
            uid: thread.uid,
            targetType: 'agency',
            source: 'kf_message'
          }, { sort: { field: 'updatedAt', dir: 'desc' }, limit: 1 })
          const lead = leads[0] || null
          if (lead) {
            const state = ticketStateOf(lead)
            const stage = state === TICKET_STATE.TICKETED ? consultStageOf(lead) : ''
            row.leadId = lead.id
            row.agencyTitle = redactChatText(lead.agencyTitle || '').slice(0, 40)
            row.ticketState = state
            row.ticketStateLabel = TICKET_STATE_LABELS[state] || ''
            row.consultStage = stage
            row.consultStageLabel = stage ? consultStageLabel(stage) : (TICKET_STATE_LABELS[state] || '')
            row.consultCsName = lead.csName || lead.assignedTo || ''
          }
        }
        items.push(row)
      }
      items.sort((a, b) => b.lastAt - a.lastAt)
      const result = {
        items,
        total: items.length,
        unread: items.reduce((sum, item) => sum + item.unread, 0)
      }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 用户直聊监管：channel === 'direct' 的会话按 threadId 汇总，默认全部可见。
     * 仅管理员 / 有消息权限的账号可查看，查看动作写审计。
     * 聊天正文可能被用户直接写了手机号 / 证件号：出站前统一脱敏，避免监管页被出站校验拦截。
     */
    'msg.directThreads': async (data) => {
      const q = str(data.q, { field: '搜索', max: 40 }).toLowerCase()
      const rows = await repo.find('outbox', { 'payload.channel': 'direct' }, {
        sort: { field: 'createdAt', dir: 'desc' },
        limit: 500
      })
      const map = new Map()
      for (const msg of rows) {
        const p = msg.payload || {}
        const threadId = p.threadId || p.leadId
        if (!threadId) continue
        let thread = map.get(threadId)
        if (!thread) {
          thread = {
            threadId,
            ownerUid: p.uid,
            peerUid: p.peerUid || '',
            title: p.title || '',
            lastBody: '',
            lastAt: 0,
            total: 0,
            unread: 0,
            users: new Set()
          }
          map.set(threadId, thread)
        }
        thread.total += 1
        /* 接收方副本（from=peer）即该条消息的唯一投递记录，readByStaff 未置真就算未读 */
        if (p.from === 'peer' && msg.readByStaff !== true) thread.unread += 1
        if (p.uid) thread.users.add(p.uid)
        if (p.peerUid) thread.users.add(p.peerUid)
        const at = Number(msg.createdAt) || 0
        if (at >= thread.lastAt) {
          thread.lastAt = at
          thread.lastBody = redactChatText(p.body || '').slice(0, 60)
        }
      }
      const items = []
      for (const thread of map.values()) {
        const names = []
        for (const uid of thread.users) {
          const user = await repo.get('users', uid)
          names.push((user && user.nick) || '用户' + String(uid).slice(-4))
        }
        const text = `${thread.title} ${names.join(' ')}`.toLowerCase()
        if (q && text.indexOf(q) < 0) continue
        items.push({
          threadId: thread.threadId,
          title: thread.title,
          users: Array.from(thread.users),
          userNames: names,
          total: thread.total,
          unread: thread.unread,
          lastBody: thread.lastBody,
          lastAt: thread.lastAt,
          lastText: dateText(thread.lastAt)
        })
      }
      items.sort((a, b) => b.lastAt - a.lastAt)
      const result = {
        items,
        total: items.length,
        unread: items.reduce((sum, item) => sum + item.unread, 0)
      }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 直聊会话明细：按 threadId 取全部消息，含图片与个人名片。
     * 同一内容会落两份副本（发送方 / 接收方各一条），监管页按「时间 + 发送人 + 类型 + 内容」去重后只展示一条。
     */
    'msg.directThread': async (data) => {
      const threadId = str(data.threadId, { field: '会话', required: true, max: 64 })
      const rows = await repo.find('outbox', {
        'payload.threadId': threadId,
        /* 聊天记录只保留 30 天：更早的消息由清理任务删除 */
        createdAt: { $gte: chatCutoff(now()) }
      }, {
        sort: { field: 'createdAt', dir: 'asc' },
        limit: 500
      })
      const nameCache = new Map()
      async function nameOf(uid) {
        if (!uid) return ''
        if (nameCache.has(uid)) return nameCache.get(uid)
        const user = await repo.get('users', uid)
        const name = (user && user.nick) || '用户' + String(uid).slice(-4)
        nameCache.set(uid, name)
        return name
      }
      const seen = new Set()
      const items = []
      for (const msg of rows) {
        const p = msg.payload || {}
        const kind = chatKindOf(p)
        const media = mediaState(p, msg.createdAt, now())
        /* 发送方副本 from='me'，接收方副本 from='peer'：统一还原真实发送人 */
        const senderUid = p.from === 'me' ? (p.uid || '') : (p.peerUid || '')
        const at = Number(msg.createdAt) || 0
        /* 两份副本时间、正文、图片完全一致，用指纹折叠成一条 */
        const fingerprint = [at, senderUid, kind, p.body || '', p.image || '', p.video || ''].join('|')
        if (seen.has(fingerprint)) continue
        seen.add(fingerprint)
        items.push({
          id: msg.id,
          uid: p.uid || '',
          senderUid,
          senderName: await nameOf(senderUid),
          from: p.from || '',
          peerUid: p.peerUid || '',
          kind,
          image: media.image,
          video: media.video,
          poster: media.poster,
          mediaExpired: media.expired,
          card: p.card || null,
          body: redactChatText(p.body || ''),
          at,
          atText: dateText(at)
        })
      }
      const result = { threadId, items, total: items.length }
      assertNoPlaintextContact(result)
      return result
    },

    /**
     * 直聊监管处置：警告会给会话双方各发一条系统提醒；转风险单进入风险池待跟进。
     * 只记录处置结论，不改动历史消息，便于事后复查。
     */
    'msg.directHandle': async (data, ctx) => {
      const threadId = str(data.threadId, { field: '会话', required: true, max: 64 })
      const action = enumOf(data.action, ['警告', '转风险单'], '处置动作')
      const note = str(data.note, { field: '处置说明', required: true, min: 2, max: 200 })
      const rows = await repo.find('outbox', { 'payload.threadId': threadId }, { limit: 500 })
      if (!rows.length) throw new AppError(CODES.NOT_FOUND, '该会话不存在或已清理')
      const uids = new Set()
      rows.forEach((msg) => {
        const p = msg.payload || {}
        if (p.uid) uids.add(p.uid)
        if (p.peerUid) uids.add(p.peerUid)
      })
      const at = now()
      const session = ctx.session
      if (action === '警告') {
        for (const uid of uids) {
          try {
            await notifyUser(uid, {
              title: '平台安全提醒',
              body: note,
              reason: note,
              targetType: 'chat',
              targetId: threadId
            })
          } catch (notifyErr) { /* 单个用户发送失败不影响其余 */ }
        }
      } else {
        const fingerprint = `chat|direct|${threadId}`
        const existing = await repo.find('riskCases', { fingerprint }, { limit: 1 })
        if (existing[0]) {
          await repo.updateWhere('riskCases', { fingerprint }, {
            detail: note,
            status: existing[0].status === '已处理' || existing[0].status === '已忽略' ? '待处理' : existing[0].status,
            updatedAt: at
          })
        } else {
          await repo.insert('riskCases', {
            id: randomId('RC'),
            fingerprint,
            type: '咨询',
            ruleCode: 'direct-chat',
            targetId: threadId,
            targetLabel: '直聊会话 ' + threadId,
            detail: note,
            level: '高',
            status: '待处理',
            owner: '',
            action: '',
            reason: '',
            createdAt: at,
            updatedAt: at
          })
        }
      }
      await appendAudit(repo, {
        actorType: 'admin',
        actorId: session ? session.accountId || session.username || '' : '',
        action: 'msg.directHandle',
        target: `${threadId}:${action}`,
        reason: note,
        ip: ctx.ip,
        result: 'allow',
        at
      })
      return { threadId, action, users: uids.size }
    },

    /** 消息中心 · 某个用户的完整消息流（客服会话 + 系统通知），按时间正序返回便于渲染 */
    'msg.list': async (data, ctx) => {
      /* 代采代售咨询会话：传 threadId（即咨询单 id）只看该咨询的对话流 */
      const threadId = data.threadId ? str(data.threadId, { field: '会话', max: 64 }) : ''
      let uid = data.uid ? str(data.uid, { field: '用户', max: 64 }) : ''
      if (threadId) {
        const lead = await repo.get('leads', threadId)
        if (!lead) throw new AppError(CODES.NOT_FOUND, '咨询会话不存在')
        uid = lead.uid
        if (!isAdminSession(ctx.session) && lead.assignedAccount && lead.assignedAccount !== ((ctx.session && ctx.session.accountId) || '')) {
          throw new AppError(CODES.FORBIDDEN, '该咨询已由其他客服领取，无法查看会话')
        }
      }
      if (!uid) throw new AppError(CODES.VALIDATION, '请指定用户或会话')
      if (!(await leadChatAccess(uid, ctx.session))) {
        throw new AppError(CODES.FORBIDDEN, '该用户不由你跟进，无法查看会话')
      }
      /* 会话内容属于敏感个人信息：坐席每次进入会话都留痕，便于事后追溯 */
      try {
        await appendAudit(repo, {
          actorType: 'admin',
          actorId: (ctx.session && ctx.session.username) || '',
          action: 'msg.view',
          target: `conversation:${uid}`,
          ip: ctx.ip,
          result: 'allow',
          at: now()
        })
      } catch (auditErr) {
        /* 审计失败不阻断坐席工作 */
      }
      const paging = normalizePaging(data)
      /* 消息中心只展示用户主动发起的「咨询客服」留言，不混入用户之间的直聊；只保留最近 30 天 */
      const query = { 'payload.uid': uid, 'payload.channel': 'kf', createdAt: { $gte: chatCutoff(now()) } }
      if (threadId) query['payload.threadId'] = threadId
      const total = await repo.count('outbox', query)
      const rows = await repo.find('outbox', query, {
        sort: { field: 'createdAt', dir: 'desc' },
        skip: paging.skip,
        limit: paging.limit
      })
      const user = await repo.get('users', uid)
      /* 聊天图片 / 视频是 cloud:// fileID，管理端无法直接渲染，统一换成临时链接 */
      const cloudIds = Array.from(new Set(rows
        .reduce((acc, msg) => {
          const p = msg.payload || {}
          if (/^cloud:\/\//i.test(String(p.image || ''))) acc.push(String(p.image))
          if (/^cloud:\/\//i.test(String(p.video || ''))) acc.push(String(p.video))
          if (/^cloud:\/\//i.test(String(p.poster || ''))) acc.push(String(p.poster))
          return acc
        }, [])))
      const imageUrls = {}
      if (cloudIds.length && cloud && typeof cloud.getTempFileURL === 'function') {
        try {
          const res = await cloud.getTempFileURL({ fileList: cloudIds })
          ;((res && res.fileList) || []).forEach((f) => {
            if (f && f.fileID && f.tempFileURL) imageUrls[f.fileID] = f.tempFileURL
          })
        } catch (err) { /* 换链失败时保留原值，前端给出占位提示 */ }
      }
      /* 名片明文按发送人缓存，一次会话内同一用户只解密一遍 */
      const cardCache = new Map()
      const items = await Promise.all(rows.map(async (msg) => {
        const p = msg.payload || {}
        /* 兼容早期版本没有写 kind 的消息：有名片 / 图片 / 视频即按对应类型展示 */
        const kind = chatKindOf(p)
        const media = mediaState(p, msg.createdAt, now())
        let card = null
        if (kind === 'card' && p.card) {
          const ownerUid = String(p.card.uid || p.uid || '')
          if (!ownerUid) {
            card = p.card
          } else {
            if (!cardCache.has(ownerUid)) cardCache.set(ownerUid, await resolveChatCard(p.card, ownerUid))
            card = cardCache.get(ownerUid)
          }
        }
        return {
          id: msg.id,
          type: msg.type,
          channel: p.channel || '',
          from: p.from || 'system',
          staffName: p.staffName || '',
          title: p.title || '站内消息',
          /* 会话归属：代采代售咨询按 threadId 归组，控制台据此渲染出入会话 */
          threadId: p.threadId || '',
          targetType: p.targetType || '',
          targetId: p.targetId || '',
          csStatus: p.csStatus || '',
          askRating: p.askRating === true,
          body: p.body || '',
          /* 消息类型：text 文本 / image 图片 / video 视频 / card 个人名片 */
          kind,
          image: media.image ? (imageUrls[media.image] || media.image) : '',
          video: media.video ? (imageUrls[media.video] || media.video) : '',
          poster: media.poster ? (imageUrls[media.poster] || media.poster) : '',
          mediaExpired: media.expired,
          card,
          status: msg.status,
          readByUser: msg.readByUser === true,
          readByStaff: msg.readByStaff === true,
          createdAt: msg.createdAt
        }
      }))
      const result = {
        uid,
        nick: (user && user.nick) || '用户' + String(uid).slice(-4),
        items: items.reverse(),
        page: paging.page,
        limit: paging.limit,
        total,
        hasMore: paging.skip + rows.length < total
      }
      assertNoPlaintextContact(result)
      return result
    },

    /** 消息中心 · 客服回复：写入同一会话流，用户端 msg.list 立即可见；支持平台向用户发送图片 / 视频 */
    'msg.reply': async (data, ctx) => {
      const session = ctx.session
      /* 代采代售咨询：带 threadId 回复时写入该咨询的会话流，并按领取关系校验权限 */
      const threadId = data.threadId ? str(data.threadId, { field: '会话', max: 64 }) : ''
      let lead = null
      let uid = data.uid ? str(data.uid, { field: '用户', max: 64 }) : ''
      if (threadId) {
        lead = await repo.get('leads', threadId)
        if (!lead) throw new AppError(CODES.NOT_FOUND, '咨询会话不存在')
        /* 只允许写进代采代售咨询（客服工单）：普通商品的直聊是买卖双方会话，
           客服消息注入会被用户端当作「对方发言」，形成身份冒充 */
        if (lead.targetType && lead.targetType !== 'agency') {
          throw new AppError(CODES.VALIDATION, '该会话为买卖双方直聊，请到消息中心按用户回复')
        }
        uid = lead.uid
        if (!isAdminSession(session) && lead.assignedAccount !== ((session && session.accountId) || '')) {
          throw new AppError(CODES.FORBIDDEN, '请先领取该咨询，再回复用户')
        }
        if (csStatusOf(lead) === CS_STATUS.ENDED) {
          throw new AppError(CODES.CONFLICT, '咨询服务已结束，不能再发送消息')
        }
      }
      if (!uid) throw new AppError(CODES.VALIDATION, '请指定用户或会话')
      if (!(await leadChatAccess(uid, session))) {
        throw new AppError(CODES.FORBIDDEN, '该用户不由你跟进，无法回复')
      }
      const kind = data.kind ? enumOf(data.kind, ['text', 'image', 'video'], '消息类型') : 'text'
      let image = ''
      let video = ''
      let poster = ''
      if (kind === 'image') {
        image = str(data.image, { field: '图片', required: true, max: 1024 })
        if (!/^(https:\/\/|cloud:\/\/)/i.test(image)) {
          throw new AppError(CODES.VALIDATION, '图片需先上传到云端')
        }
      } else if (kind === 'video') {
        video = str(data.video, { field: '视频', required: true, max: 1024 })
        if (!/^(https:\/\/|cloud:\/\/)/i.test(video)) {
          throw new AppError(CODES.VALIDATION, '视频需先上传到云端')
        }
        poster = str(data.poster || '', { field: '视频封面', max: 1024 })
        if (poster && !/^(https:\/\/|cloud:\/\/)/i.test(poster)) {
          throw new AppError(CODES.VALIDATION, '视频封面需先上传到云端')
        }
      }
      const body = kind === 'text'
        ? str(data.body || data.content, { field: '回复内容', required: true, max: 500 })
        : ''
      const user = await repo.get('users', uid)
      if (!user) throw new AppError(CODES.NOT_FOUND, '用户不存在')
      const staff = await findAccount(session ? session.accountId : '')
      const staffName = staffNameOf(staff) || (session ? session.accountId : '客服')
      const at = now()
      const doc = {
        id: randomId('M'),
        type: 'kf.chat',
        payload: {
          uid,
          channel: 'kf',
          from: 'staff',
          staffName,
          title: lead ? (lead.agencyTitle || '咨询回复') : '客服回复',
          body,
          kind,
          image,
          video,
          poster,
          /* 代采代售咨询：写入会话归组键与委托信息，用户端按 threadId 渲染 */
          threadId: threadId || '',
          targetType: lead ? (lead.targetType || 'agency') : '',
          targetId: lead ? (lead.targetId || lead.agencyId || '') : '',
          csStatus: lead ? csStatusOf(lead) : ''
        },
        status: 'pending',
        readByUser: false,
        readByStaff: true,
        createdAt: at
      }
      await repo.insert('outbox', doc)
      try {
        await appendAudit(repo, {
          actorType: 'admin',
          actorId: session ? session.accountId : '',
          action: 'msg.reply',
          target: uid,
          reason: '',
          ip: ctx.ip,
          result: 'allow',
          at
        })
      } catch (auditErr) { /* 回复已落库：留痕失败不影响结果 */ }
      return { id: doc.id, uid, threadId, staffName, kind, image, video, poster, createdAt: at }
    },

    /**
     * 打开聊天图片 / 视频：把媒体保留期从 7 天延长到 30 天。
     * 客服在管理端点开图片 / 视频时调用，与用户端 msg.mediaOpen 同口径。
     */
    'msg.mediaOpen': async (data, ctx) => {
      const id = str(data.id, { field: '消息', required: true, max: 64 })
      const msg = await repo.get('outbox', id)
      const p = (msg && msg.payload) || null
      if (!msg || !p) throw new AppError(CODES.NOT_FOUND, '消息不存在')
      if (!p.image && !p.video) throw new AppError(CODES.VALIDATION, '该消息没有可查看的图片或视频')
      /* 委托会话（targetType=agency）按领取关系管控；直聊同样要求该用户在自己的跟进范围内 */
      if (p.targetType === 'agency') {
        const lead = p.threadId ? await repo.get('leads', p.threadId) : null
        if (lead && !(await agencyChatAccess(lead, ctx.session))) {
          throw new AppError(CODES.FORBIDDEN, '该会话不由你跟进，无法查看')
        }
      } else if (!(await leadChatAccess(p.uid, ctx.session))) {
        throw new AppError(CODES.FORBIDDEN, '该用户不由你跟进，无法查看')
      }
      const state = mediaState(p, msg.createdAt, now())
      if (state.expired) throw new AppError(CODES.VALIDATION, '图片/视频已过期，无法查看')
      const openedAt = Number(p.mediaOpenedAt) || now()
      await repo.updateWhere('outbox', { id }, {
        payload: Object.assign({}, p, { mediaOpenedAt: openedAt })
      })
      try {
        const url = String(p.video || p.image || '')
        const key = 'cm_' + sha256Hex(url).slice(0, 22)
        const row = await repo.get('chatMedia', key)
        const patch = {
          id: key,
          url,
          kind: p.video ? 'video' : 'image',
          uid: String(p.uid || ''),
          createdAt: Number(msg.createdAt) || openedAt,
          openedAt,
          expireAt: (Number(msg.createdAt) || openedAt) + CHAT_RETENTION_DAYS * DAY_MS
        }
        if (row) await repo.updateWhere('chatMedia', { id: key }, patch)
        else await repo.insert('chatMedia', Object.assign({ updatedAt: openedAt }, patch))
      } catch (err) { /* 登记失败不影响本次查看 */ }
      return { id, openedAt, expiresAt: state.expiresAt }
    },

    /** 消息中心 · 已读：传 id 标单条，只传 uid 则把该用户发来的消息全部标为客服已读；传 threadId 则标记直聊会话 */
    'msg.read': async (data, ctx) => {
      const threadId = data.threadId ? str(data.threadId, { field: '会话', max: 64 }) : ''
      if (threadId) {
        /* 会话已读同样受跟进范围约束：避免任意账号把别人的直聊全部标为已读 */
        const lead = await repo.get('leads', threadId)
        if (lead) {
          const allowed = lead.targetType === 'agency'
            ? await agencyChatAccess(lead, ctx.session)
            : await leadChatAccess(lead.uid, ctx.session)
          if (!allowed) throw new AppError(CODES.FORBIDDEN, '该会话不由你跟进')
        } else {
          const first = (await repo.find('outbox', { 'payload.threadId': threadId }, { limit: 1 }))[0]
          const ownerUid = first && first.payload ? first.payload.uid : ''
          if (ownerUid && !(await leadChatAccess(ownerUid, ctx.session))) {
            throw new AppError(CODES.FORBIDDEN, '该会话不由你跟进')
          }
        }
        /* 直聊：接收方副本（from=peer）才是投递记录，兼容历史没有 readByStaff 的数据 */
        const res = await repo.updateWhere(
          'outbox',
          { 'payload.threadId': threadId, readByStaff: { $ne: true } },
          { readByStaff: true }
        )
        return { threadId, count: res ? res.count : 0 }
      }
      const uid = str(data.uid, { field: '用户', required: true, max: 64 })
      if (!(await leadChatAccess(uid, ctx.session))) {
        throw new AppError(CODES.FORBIDDEN, '该用户不由你跟进')
      }
      const id = data.id ? str(data.id, { field: '消息', max: 64 }) : ''
      if (id) {
        const msg = await repo.get('outbox', id)
        if (!msg || !msg.payload || msg.payload.uid !== uid) {
          throw new AppError(CODES.NOT_FOUND, '消息不存在')
        }
        await repo.updateWhere('outbox', { id, 'payload.uid': uid }, { readByStaff: true })
        return { id, uid, read: true }
      }
      const res = await repo.updateWhere(
        'outbox',
        { 'payload.uid': uid, 'payload.from': 'user', readByStaff: { $ne: true } },
        { readByStaff: true }
      )
      return { uid, count: res ? res.count : 0 }
    },

    /** 账号管理 · 列表：环境引导账号 + 在线新增账号，绝不返回口令哈希与 TOTP 密钥 */
    'account.list': async () => {
      const items = await listAllAccounts()
      return { items, total: items.length }
    },

    /** 账号管理 · 新增客服 / 管理员：立即生效，无需改环境变量重启 */
    'account.create': async (data, ctx) => {
      const session = ctx.session
      const username = str(data.username, { field: '账号', required: true, min: 3, max: 32 }).toLowerCase()
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
        throw new AppError(CODES.VALIDATION, '账号只能使用字母、数字、点、下划线或连字符')
      }
      if (accounts.some((item) => item.username === username)) {
        throw new AppError(CODES.CONFLICT, '该账号为环境引导账号，请换一个账号名')
      }
      const password = str(data.password, { field: '初始口令', required: true, min: 10, max: 128 })
      assertStrongPassword(password)
      const totpSecret = String(data.totpSecret || '').trim().toUpperCase().replace(/[\s=]/g, '')
      if (!/^[A-Z2-7]{16,64}$/.test(totpSecret)) {
        throw new AppError(CODES.VALIDATION, '动态口令密钥必须是 16 位以上 Base32 字符')
      }
      const roleInput = data.role ? String(data.role).trim().toLowerCase() : ROLES.CS
      /* 角色可选内置角色或账号管理里新建的自定义角色（停用的不可再分配） */
      if (!BUILTIN_ROLES.some((item) => item.roleKey === roleInput)) {
        const roleRows = await repo.find('roles', { roleKey: roleInput }, { limit: 1 })
        if (!roleRows[0] || roleRows[0].status === 'disabled') {
          throw new AppError(CODES.VALIDATION, '角色不存在或已停用')
        }
      }
      const role = roleInput
      const name = str(data.name, { field: '姓名', required: true, max: 24 })
      const org = str(data.org, { field: '所属组织', max: 40 }) || '算力聚合'
      const exist = await repo.find('accounts', { username }, { limit: 1 })
      if (exist.length > 0) throw new AppError(CODES.CONFLICT, '账号已存在')
      const at = now()
      const doc = {
        id: randomId('A'),
        username,
        passwordHash: hashPassword(password),
        totpSecret,
        role,
        name,
        org,
        status: 'active',
        createdAt: at,
        updatedAt: at,
        createdBy: session ? session.accountId : ''
      }
      await repo.insert('accounts', doc)
      try {
        await appendAudit(repo, {
          actorType: 'admin',
          actorId: session ? session.accountId : '',
          action: 'account.create',
          target: username,
          reason: role,
          ip: ctx.ip,
          result: 'allow',
          at
        })
      } catch (auditErr) { /* 账号已落库：留痕失败不影响结果 */ }
      return projectAccount(doc, 'db', doc.id)
    },

    /** 账号管理 · 启停 / 改名：环境引导账号不在此维护（避免与云函数配置互相覆盖） */
    'account.update': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.id, { field: '账号', required: true, max: 64 })
      const row = await repo.get('accounts', id)
      if (!row) {
        throw new AppError(CODES.NOT_FOUND, '只能管理在线新增的账号，环境引导账号请通过云函数环境变量维护')
      }
      const patch = { updatedAt: now() }
      if (data.name !== undefined) patch.name = str(data.name, { field: '姓名', required: true, max: 24 })
      if (data.org !== undefined) patch.org = str(data.org, { field: '所属组织', max: 40 }) || '算力聚合'
      if (data.status !== undefined) {
        const status = enumOf(String(data.status).trim().toLowerCase(), ['active', 'disabled'], '状态')
        if (status === 'disabled' && session && session.accountId === row.username) {
          throw new AppError(CODES.CONFLICT, '不能停用当前登录账号')
        }
        patch.status = status
      }
      const res = await repo.updateWhere('accounts', { id }, patch)
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '账号已被更新，请刷新后重试')
      /* 停用立即生效：把该账号所有在线会话置为过期 */
      if (patch.status === 'disabled') {
        try {
          await repo.updateWhere('sessions', { accountId: row.username }, { expiresAt: now() })
        } catch (err) { /* 会话清理失败不覆盖账号停用结果 */ }
      }
      try {
        await appendAudit(repo, {
          actorType: 'admin',
          actorId: session ? session.accountId : '',
          action: 'account.update',
          target: row.username,
          reason: patch.status || '',
          ip: ctx.ip,
          result: 'allow',
          at: now()
        })
      } catch (auditErr) { /* 账号已更新：留痕失败不影响结果 */ }
      return projectAccount(Object.assign({}, row, patch), 'db', id)
    },

    /** 账号管理 · 重置口令 / 动态口令密钥：重置他人账号时同时踢掉在线会话 */
    'account.resetPassword': async (data, ctx) => {
      const session = ctx.session
      const id = str(data.id, { field: '账号', required: true, max: 64 })
      const row = await repo.get('accounts', id)
      if (!row) {
        throw new AppError(CODES.NOT_FOUND, '只能管理在线新增的账号，环境引导账号请通过云函数环境变量维护')
      }
      const password = str(data.password, { field: '新口令', required: true, min: 10, max: 128 })
      assertStrongPassword(password)
      const at = now()
      const patch = { passwordHash: hashPassword(password), updatedAt: at }
      if (data.totpSecret !== undefined && String(data.totpSecret).trim() !== '') {
        const secret = String(data.totpSecret).trim().toUpperCase().replace(/[\s=]/g, '')
        if (!/^[A-Z2-7]{16,64}$/.test(secret)) {
          throw new AppError(CODES.VALIDATION, '动态口令密钥必须是 16 位以上 Base32 字符')
        }
        patch.totpSecret = secret
      }
      const res = await repo.updateWhere('accounts', { id }, patch)
      if (!res || res.count === 0) throw new AppError(CODES.CONFLICT, '账号已被更新，请刷新后重试')
      let sessionsClosed = 0
      if (!session || session.accountId !== row.username) {
        try {
          const closed = await repo.updateWhere('sessions', { accountId: row.username }, { expiresAt: at })
          sessionsClosed = closed ? closed.count : 0
        } catch (err) { /* 会话清理失败不影响口令重置 */ }
      }
      try {
        await appendAudit(repo, {
          actorType: 'admin',
          actorId: session ? session.accountId : '',
          action: 'account.resetPassword',
          target: row.username,
          reason: '',
          ip: ctx.ip,
          result: 'allow',
          at
        })
      } catch (auditErr) { /* 口令已重置：留痕失败不影响结果 */ }
      return { id, username: row.username, resetAt: at, sessionsClosed }
    },

    /* ==================================================================
       P0 增长看板：日趋势 / 漏斗 / 关键指标，并把当天快照落入 dailyStats
       ================================================================== */
    'stats.trend': async (data) => {
      const days = Math.min(90, Math.max(7, Number(data.days) || 30))
      const at = now()
      const todayStart = at - ((at + CN_OFFSET) % DAY_MS)
      const start = todayStart - (days - 1) * DAY_MS
      const series = []
      const byDay = {}
      for (let i = 0; i < days; i += 1) {
        const key = dayKeyOf(start + i * DAY_MS)
        const row = {
          date: key, dau: 0, newUsers: 0, products: 0, demands: 0,
          leads: 0, matched: 0, deals: 0, orders: 0, revenue: 0
        }
        series.push(row)
        byDay[key] = row
      }
      const bucketOf = (ms) => byDay[dayKeyOf(Number(ms) || 0)]

      const users = await repo.find('users', {}, { limit: 100000 })
      for (const row of users) {
        const bucket = bucketOf(row.createdAt)
        if (bucket) bucket.newUsers += 1
      }
      const products = await repo.find('products', {}, { limit: 100000 })
      for (const row of products) {
        const bucket = bucketOf(row.createdAt)
        if (bucket) bucket.products += 1
      }
      const demands = await repo.find('demands', {}, { limit: 100000 })
      for (const row of demands) {
        const bucket = bucketOf(row.createdAt)
        if (bucket) bucket.demands += 1
      }
      const leads = await repo.find('leads', {}, { limit: 100000 })
      for (const row of leads) {
        const bucket = bucketOf(row.createdAt)
        if (!bucket) continue
        bucket.leads += 1
        if (row.status === LEAD_STATUS.MATCHED || row.status === LEAD_STATUS.DEALT) bucket.matched += 1
        if (row.status === LEAD_STATUS.DEALT) bucket.deals += 1
      }
      /* 营收只统计微信端调起的支付：手动开通会员 / 线下登记收款不计营收 */
      const orders = await repo.find('bizOrders', {}, { limit: 100000 })
      for (const row of orders) {
        if (row.method !== '微信支付') continue
        const bucket = bucketOf(row.createdAt)
        if (!bucket) continue
        bucket.orders += 1
        bucket.revenue += Number(row.amount) || 0
      }
      /* 日活：行为事件按天去重 uid；历史缺失时回落到已落库的快照 */
      const events = await repo.find('behaviorEvents', { at: { $gte: start } }, { limit: 300000 })
      const dauSets = {}
      for (const event of events) {
        const key = event.day || dayKeyOf(event.at)
        if (!byDay[key]) continue
        if (!dauSets[key]) dauSets[key] = new Set()
        if (event.uid) dauSets[key].add(event.uid)
      }
      for (const key of Object.keys(dauSets)) byDay[key].dau = dauSets[key].size
      const stored = await repo.find('dailyStats', { date: { $gte: series[0].date } }, { limit: 200 })
      for (const row of stored) {
        const bucket = byDay[row.date]
        if (bucket && Number(row.dau) > bucket.dau) bucket.dau = Number(row.dau)
      }
      for (const row of series) row.revenue = Math.round(row.revenue * 100) / 100

      /* 当天快照：dailyStats 按 date 唯一，存在则覆盖，形成可回溯的日活历史 */
      const todayRow = series[series.length - 1]
      const snapshot = Object.assign({ id: 'ds_' + todayRow.date, updatedAt: at }, todayRow)
      try {
        await repo.insert('dailyStats', snapshot)
      } catch (insertErr) {
        try { await repo.updateWhere('dailyStats', { date: todayRow.date }, Object.assign({}, todayRow, { updatedAt: at })) } catch (updateErr) { /* 快照失败不影响看板 */ }
      }

      const productOnSale = products.filter((row) => row.status === PRODUCT_STATUS.ON_SALE).length
      const demandOpen = demands.filter((row) => row.status === DEMAND_STATUS.OPEN).length
      const exposure = productOnSale + demandOpen
      const matchedTotal = leads.filter((row) => row.status === LEAD_STATUS.MATCHED || row.status === LEAD_STATUS.DEALT).length
      const dealtTotal = leads.filter((row) => row.status === LEAD_STATUS.DEALT).length
      const rate = (numerator, denominator) => (denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0)
      const funnel = [
        { key: 'exposure', label: '在架曝光', value: exposure, rate: 100 },
        { key: 'consult', label: '咨询线索', value: leads.length, rate: rate(leads.length, exposure) },
        { key: 'match', label: '完成对接', value: matchedTotal, rate: rate(matchedTotal, leads.length) },
        { key: 'deal', label: '成交', value: dealtTotal, rate: rate(dealtTotal, matchedTotal) }
      ]
      /* 环比：后半段 vs 前半段，识别增长 / 回落 */
      const half = Math.max(1, Math.floor(days / 2))
      const prevRows = series.slice(0, days - half)
      const currRows = series.slice(days - half)
      const sumOf = (rows, field) => rows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0)
      const growthOf = (field) => {
        const prev = sumOf(prevRows, field)
        const curr = sumOf(currRows, field)
        return prev ? Math.round(((curr - prev) / prev) * 1000) / 10 : (curr ? 100 : 0)
      }
      return {
        at,
        days,
        series,
        funnel,
        totals: {
          dauToday: series[series.length - 1].dau,
          newUsers: sumOf(series, 'newUsers'),
          products: sumOf(series, 'products'),
          demands: sumOf(series, 'demands'),
          leads: sumOf(series, 'leads'),
          deals: dealtTotal,
          orders: sumOf(series, 'orders'),
          revenue: Math.round(sumOf(series, 'revenue') * 100) / 100
        },
        growth: {
          dau: growthOf('dau'),
          newUsers: growthOf('newUsers'),
          leads: growthOf('leads'),
          revenue: growthOf('revenue')
        }
      }
    },

    /* ==================================================================
       P0 系统日志：运行日志 / 登录日志 / 操作日志统一检索
       ================================================================== */
    'log.list': async (data) => {
      const page = normalizePaging(data)
      const tab = enumOf(data.tab || 'system', ['system', 'login', 'audit'], '日志类型')
      const level = data.level ? enumOf(data.level, LOG_LEVELS, '日志级别') : ''
      const keyword = str(data.keyword, { field: '关键词', max: 40 }).toLowerCase()
      const from = Number(data.from) || 0
      const to = Number(data.to) || 0
      const query = {}
      if (tab === 'system' && level) query.level = level
      let rows
      if (tab === 'login') rows = await repo.find('loginLogs', query, { sort: { field: 'at', dir: 'desc' }, limit: 5000 })
      else if (tab === 'audit') rows = await repo.find('audit', query, { sort: { field: 'at', dir: 'desc' }, limit: 5000 })
      else rows = await repo.find('systemLogs', query, { sort: { field: 'at', dir: 'desc' }, limit: 5000 })
      if (from) rows = rows.filter((row) => Number(row.at) >= from)
      if (to) rows = rows.filter((row) => Number(row.at) <= to)
      if (keyword) {
        rows = rows.filter((row) => {
          const text = [row.message, row.action, row.actorId, row.username, row.target, row.reason, row.ip, row.scope]
            .map((item) => String(item == null ? '' : item).toLowerCase()).join(' ')
          return text.includes(keyword)
        })
      }
      const items = rows.slice((page.page - 1) * page.limit, page.page * page.limit).map((row) => {
        if (tab === 'audit') {
          return {
            id: row.id,
            time: Number(row.at) || 0,
            timeText: dateText(row.at),
            level: row.result === 'allow' ? 'info' : (row.result === 'INTERNAL' ? 'error' : 'warn'),
            source: '操作日志',
            actor: row.actorId || '',
            action: row.action || '',
            message: row.reason || row.target || '',
            result: row.result || '',
            ip: row.ip || ''
          }
        }
        if (tab === 'login') {
          return {
            id: row.id,
            time: Number(row.at) || 0,
            timeText: dateText(row.at),
            level: row.result === 'allow' ? 'info' : 'warn',
            source: '登录日志',
            actor: row.username || '',
            action: 'admin.login',
            message: row.result === 'allow' ? '登录成功' : (row.reason || '登录失败'),
            result: row.result || '',
            ip: row.ip || ''
          }
        }
        return {
          id: row.id,
          time: Number(row.at) || 0,
          timeText: dateText(row.at),
          level: row.level || 'info',
          source: row.scope || '运行日志',
          actor: row.actor || '',
          action: row.action || '',
          message: row.message || '',
          detail: row.detail || '',
          result: row.result || '',
          ip: row.ip || ''
        }
      })
      return {
        tab,
        items,
        total: rows.length,
        page: page.page,
        limit: page.limit,
        counts: {
          all: rows.length,
          /* 三个页签的总量：与当前筛选无关，只用于页签徽标 */
          system: await repo.count('systemLogs', {}),
          login: await repo.count('loginLogs', {}),
          audit: await repo.count('audit', {}),
          error: rows.filter((row) => row.level === 'error' || row.result === 'INTERNAL').length,
          warn: rows.filter((row) => row.level === 'warn').length,
          deny: rows.filter((row) => row.result === 'deny' || row.result === 'FORBIDDEN' || row.result === 'UNAUTHENTICATED').length
        }
      }
    },

    /** 系统健康概览：日志页头部 + 工作台告警条 */
    'log.system': async () => {
      const at = now()
      const since = at - 7 * DAY_MS
      const logs = await repo.find('systemLogs', { at: { $gte: since } }, { limit: 20000 })
      const logins = await repo.find('loginLogs', { at: { $gte: since } }, { limit: 20000 })
      const audits = await repo.find('audit', { at: { $gte: since } }, { limit: 20000 })
      const errors = logs.filter((row) => row.level === 'error')
      const warns = logs.filter((row) => row.level === 'warn')
      const loginDeny = logins.filter((row) => row.result !== 'allow')
      const today = dayKeyOf(at)
      return {
        at,
        health: errors.filter((row) => row.at >= at - DAY_MS).length ? 'warn' : 'ok',
        counts: {
          errors7d: errors.length,
          warns7d: warns.length,
          loginDeny7d: loginDeny.length,
          actions7d: audits.length,
          actionsToday: audits.filter((row) => dayKeyOf(row.at) === today).length,
          loginToday: logins.filter((row) => dayKeyOf(row.at) === today).length
        },
        recentErrors: errors.slice(0, 10).map((row) => ({
          id: row.id,
          timeText: dateText(row.at),
          action: row.action || '',
          message: row.message || '',
          ip: row.ip || ''
        }))
      }
    },

    /* ==================================================================
       P0 / P3 角色与临时权限：自定义角色 + 账号级临时授权
       ================================================================== */
    'role.list': async () => {
      /* 角色收敛：只保留管理员 / 客服坐席，历史预设岗位不再下发到角色页；
         已分配这些岗位的账号仍按库里的角色记录取权限，不受影响。 */
      const custom = await repo.find('roles', {}, { sort: { field: 'createdAt', dir: 'asc' }, limit: 200 })
      const roles = BUILTIN_ROLES.map((role) => Object.assign({}, role, {
        builtin: true, editable: false, status: 'active'
      })).concat(custom.filter((row) => !row.preset).map((row) => ({
        roleKey: row.roleKey,
        name: row.name,
        pages: row.pages || [],
        actions: row.actions || [],
        builtin: false,
        editable: true,
        status: row.status || 'active',
        createdAt: Number(row.createdAt) || 0,
        updatedAt: Number(row.updatedAt) || 0
      })))
      const permissions = await repo.find('accountPermissions', {}, { sort: { field: 'updatedAt', dir: 'desc' }, limit: 200 })
      const staff = await listAllAccounts()
      return {
        roles,
        pages: ALL_ADMIN_PAGES,
        actions: ALL_ADMIN_ACTIONS,
        permissions: permissions.map((row) => ({
          id: row.id,
          username: row.username,
          extraPages: row.extraPages || [],
          extraActions: row.extraActions || [],
          expiresAt: Number(row.expiresAt) || 0,
          expiresText: row.expiresAt ? dateText(row.expiresAt) : '长期',
          status: row.status || 'active',
          note: row.note || '',
          updatedAt: Number(row.updatedAt) || 0
        })),
        accounts: staff.map((item) => ({
          username: item.username,
          name: item.name,
          role: item.role,
          status: item.status
        }))
      }
    },

    'role.save': async (data, ctx) => {
      const roleKey = String(data.roleKey || '').trim().toLowerCase()
      if (!/^[a-z][a-z0-9_]{1,23}$/.test(roleKey)) {
        throw new AppError(CODES.VALIDATION, '角色标识需为 2-24 位小写字母、数字或下划线，且以字母开头')
      }
      if (BUILTIN_ROLES.some((item) => item.roleKey === roleKey)) {
        throw new AppError(CODES.CONFLICT, '内置角色不可修改')
      }
      const name = str(data.name, { field: '角色名称', required: true, max: 24 })
      const pages = Array.isArray(data.pages) ? data.pages.filter((page) => ALL_ADMIN_PAGES.includes(page)) : []
      const actions = Array.isArray(data.actions) ? data.actions.filter((action) => ALL_ADMIN_ACTIONS.includes(action)) : []
      if (!pages.length) throw new AppError(CODES.VALIDATION, '请至少选择一个可见页面')
      const at = now()
      const existing = await repo.find('roles', { roleKey }, { limit: 1 })
      if (existing[0]) {
        await repo.updateWhere('roles', { roleKey }, { name, pages, actions, status: 'active', updatedAt: at })
      } else {
        await repo.insert('roles', {
          id: randomId('RL'), roleKey, name, pages, actions,
          status: 'active', createdAt: at, updatedAt: at
        })
      }
      try {
        await appendAudit(repo, {
          actorType: 'admin', actorId: ctx.session ? ctx.session.accountId : '',
          action: 'role.save', target: roleKey, reason: `${pages.length} 页 / ${actions.length} 动作`,
          ip: ctx.ip, result: 'allow', at
        })
      } catch (auditErr) { /* 角色已保存：留痕失败不影响结果 */ }
      return { roleKey, name, pages, actions, builtin: false, status: 'active' }
    },

    'role.remove': async (data, ctx) => {
      const roleKey = String(data.roleKey || '').trim().toLowerCase()
      if (BUILTIN_ROLES.some((item) => item.roleKey === roleKey)) {
        throw new AppError(CODES.CONFLICT, '内置角色不可删除')
      }
      const rows = await repo.find('roles', { roleKey }, { limit: 1 })
      if (!rows[0]) throw new AppError(CODES.NOT_FOUND, '角色不存在')
      await repo.updateWhere('roles', { roleKey }, { status: 'disabled', updatedAt: now() })
      try {
        await appendAudit(repo, {
          actorType: 'admin', actorId: ctx.session ? ctx.session.accountId : '',
          action: 'role.remove', target: roleKey, reason: '', ip: ctx.ip, result: 'allow', at: now()
        })
      } catch (auditErr) { /* 留痕失败不影响结果 */ }
      return { roleKey, status: 'disabled' }
    },

    /** 账号临时权限：在角色基础上按人叠加页面 / 动作，到期自动失效 */
    'permission.save': async (data, ctx) => {
      const username = str(data.username, { field: '账号', required: true, max: 32 }).toLowerCase()
      const account = await findAccount(username)
      if (!account) throw new AppError(CODES.NOT_FOUND, '账号不存在')
      const extraPages = Array.isArray(data.extraPages) ? data.extraPages.filter((page) => ALL_ADMIN_PAGES.includes(page)) : []
      const extraActions = Array.isArray(data.extraActions) ? data.extraActions.filter((action) => ALL_ADMIN_ACTIONS.includes(action)) : []
      const at = now()
      const maxExpire = at + 365 * DAY_MS
      let expiresAt = Number(data.expiresAt) || (at + 7 * DAY_MS)
      if (expiresAt <= at) throw new AppError(CODES.VALIDATION, '到期时间需晚于当前时间')
      if (expiresAt > maxExpire) throw new AppError(CODES.VALIDATION, '临时权限最长 365 天')
      const note = str(data.note, { field: '备注', max: 120 }) || ''
      const status = extraPages.length || extraActions.length ? 'active' : 'disabled'
      const existing = await repo.find('accountPermissions', { username }, { limit: 1 })
      const doc = {
        username,
        extraPages,
        extraActions,
        expiresAt,
        status,
        note,
        updatedAt: at
      }
      if (existing[0]) {
        await repo.updateWhere('accountPermissions', { username }, doc)
      } else {
        await repo.insert('accountPermissions', Object.assign({ id: 'ap_' + username, createdAt: at }, doc))
      }
      try {
        await appendAudit(repo, {
          actorType: 'admin', actorId: ctx.session ? ctx.session.accountId : '',
          action: 'permission.save', target: username,
          reason: `${extraPages.length} 页 / ${extraActions.length} 动作`,
          ip: ctx.ip, result: 'allow', at
        })
      } catch (auditErr) { /* 留痕失败不影响结果 */ }
      return {
        username,
        extraPages,
        extraActions,
        expiresAt,
        expiresText: dateText(expiresAt),
        status,
        note
      }
    }
  }
}

module.exports = { createAdminHandlers, buildAccounts }
