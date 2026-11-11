'use strict'

const { AppError, CODES } = require('./errors')
const { ROLES } = require('./constants')

/**
 * 管理端动作白名单（服务端强制，前端隐藏不算数）。
 *
 * 角色口径（对齐《平台整体逻辑设计 v3.2》2.2）：
 * - cs 客服坐席：商品池 / 求购池 / 咨询单为主，可领取咨询单并把工单推进到成交 / 关闭；
 *   联系方式明文仍只归管理员释放；统计、已拦截箱、排序规则、审计仍归管理员。
 * - admin 管理员：全部业务读写与全部管理动作。
 */
const ROLE_ACTIONS = Object.freeze({
  [ROLES.CS]: Object.freeze([
    'admin.logout',
    'product.list',
    'product.detail',
    'demand.list',
    'demand.detail',
    'lead.list',
    'lead.detail',
    'lead.assign',
    /* 领取咨询单：认领后归属本人，未成交 / 未关闭前一直留在「我的已领取」 */
    'lead.claim',
    /* 领取后由本人推进状态直到成交 / 关闭；未完成前工单不会离开「我的已领取」 */
    'lead.updateStatus',
    /* 分配 / 转派需要坐席列表；客服只能在自己与同事之间流转工单 */
    'staff.list',
    /* 客服坐席必须能看消息、回消息，否则用户留言无人处理 */
    'msg.threads',
    'msg.list',
    'msg.reply',
    'msg.read',
    'msg.mediaOpen',
    /* 直聊与收藏关注监管：客服可只读查看留痕，处置仍走后端风险单 */
    'msg.directThreads',
    'msg.directThread',
    'msg.directHandle',
    'favorite.list',
    'follow.list',
    /* 交易服务：客服负责确认代采 / 代售服务费到账，以及商机权限开通 / 续费；
       关闭委托、停用权限、资讯发布与下架属于管理员动作 */
    'price.levels',
    'agency.list',
    'agency.confirm',
    'agency.reject',
    /* 代采 / 代购工单：客服审核通过 / 驳回，通过后按工单联系方式对接用户 */
    'agency.reveal',
    'agency.review',
    /* 委托与商品对话：客服可直接回复用户围绕某个委托 / 商品的咨询 */
    'agency.chats',
    'agency.reply',
    'product.chats',
    'biz.list',
    'biz.grant',
    'biz.orders',
    'biz.remindExpiring',
    /* 收款登记：客服把企微收款同步到用户名下，确认到账后自动开通会员 */
    'payment.list',
    'payment.create',
    'payment.confirm',
    /* 用户页：客服可检索用户、开通商机会员，并做账号状态 / 曝光 / 备注的手动调整 */
    'user.list',
    'user.detail',
    /* 用户历史对话：客服在用户详情里查看该用户与任何人 / 客服的全部会话 */
    'user.chats',
    'user.chatThread',
    'user.admin',
    /* 资质原件核验 + 用户操作记录：客服审核资料与回溯行为 */
    'qual.fileUrl',
    'qual.verify',
    /* 用户上传的图片 / 视频：审核详情里直接展示原件 */
    'media.fileUrls',
    'user.events',
    /* 用户运营数据导出：客服与管理员都从用户页导出当前筛选结果 */
    'user.export',
    /* 系统设置只读：用户页与商机页展示套餐价格、扫码说明 */
    'setting.get',
    /* 运营洞察：客服可看在线人数与榜单（辅助备货），风险池打回与资讯仍归管理员 */
    'insights.board',
    'insights.searches',
    'insights.boards',
    /* 风险页只读：客服能看风险单与内容池，处置（risk.handle）仍归管理员 */
    'risk.list',
    'risk.cases',
    /* 举报 / 投诉 / 意见反馈由客服先受理并回复，管理员同样可用 */
    'report.list',
    'report.handle',
    /* 媒体页资讯列表只读：发布 / 审核 / 下架归管理员 */
    'news.list',
    /* 工作台待办与作业记录：只读汇总，三类角色都可查看自己的窗口数据 */
    'admin.todos',
    'workbench.data'
  ]),
  /**
   * 财务专员：只做收款登记、确认到账、退款与营收汇总，
   * 以及查用户 / 开通会员，不碰货盘、咨询单、风险与系统配置。
   */
  [ROLES.FINANCE]: Object.freeze([
    'admin.logout',
    'finance.summary',
    'payment.list',
    'payment.create',
    'payment.confirm',
    'payment.refund',
    /* 用户发起的退款申请：财务核对后通过 / 驳回 */
    'refund.list',
    'refund.handle',
    /* 登记收款与开通会员需要检索用户 */
    'user.list',
    'user.detail',
    'biz.list',
    'biz.grant',
    'setting.get',
    /* 工作台待办与作业记录：只读汇总 */
    'admin.todos',
    'workbench.data'
  ]),
  [ROLES.ADMIN]: Object.freeze([
    'admin.logout',
    'admin.login',
    'product.list',
    'product.detail',
    'product.review',
    'product.setStatus',
    'product.offline',
    'product.online',
    'demand.list',
    'demand.detail',
    'demand.review',
    'demand.setStatus',
    'demand.close',
    'demand.offline',
    'lead.list',
    'lead.detail',
    'lead.assign',
    'lead.claim',
    'lead.updateStatus',
    'contact.reveal',
    'stats.overview',
    'blocked.list',
    'rules.list',
    'rule.toggle',
    'rule.create',
    'rule.update',
    /* 排序规则：配置咨询单审批优先级权重 */
    'rule.sort',
    'rule.sortSave',
    /* 产品型号库：平台维护售卖机型，用户端滚轮读取 */
    'catalog.list',
    'catalog.save',
    'catalog.remove',
    'audit.list',
    /* 行为数据中心：截屏/录屏、风控、用户动作、管理操作、搜索记录统一检索 */
    'behavior.list',
    /* 客服服务记录 + 坐席列表：管理员回溯「谁处理了哪些工单」 */
    'service.records',
    'staff.list',
    /* 消息中心：管理员可看全部会话并回复 */
    'msg.threads',
    'msg.list',
    'msg.reply',
    'msg.read',
    'msg.mediaOpen',
    /* 直聊与收藏关注：管理员全量监管 */
    'msg.directThreads',
    'msg.directThread',
    'msg.directHandle',
    'favorite.list',
    'follow.list',
    /* 账号管理：只有 admin 能新增 / 停用客服账号 */
    'account.list',
    'account.create',
    'account.update',
    'account.resetPassword',
    /* 用户数据：跨 users / profiles 的检索与详情 */
    'user.list',
    'user.detail',
    /* 用户历史对话：管理员可在用户详情里查看完整会话记录 */
    'user.chats',
    'user.chatThread',
    /* 单个用户手动调整：账号状态 / 曝光范围 / 内部备注 */
    'user.admin',
    /* 资质原件核验与用户操作记录 */
    'qual.fileUrl',
    'qual.verify',
    /* 用户上传的图片 / 视频：审核详情里直接展示原件 */
    'media.fileUrls',
    'user.events',
    /* 用户运营数据导出（后台导出，含明文手机号，仅管理员可用） */
    'user.export',
    /* 工作台待办与作业记录 */
    'admin.todos',
    'workbench.data',
    /* 系统设置：企微活码、商机套餐、平台信息（settings 集合 id=site） */
    'setting.get',
    'setting.save',
    /* 交易服务：管理员拥有全部动作，含关闭委托、资讯发布 / 审核 / 下架、报价清理、停用商机 */
    'price.levels',
    'agency.list',
    'agency.confirm',
    'agency.reject',
    'agency.review',
    'agency.reveal',
    'agency.close',
    /* 平台对代采代售商品的管理权：直接修改已上架内容、下架，以及查看 / 回复商品对话 */
    'agency.update',
    'agency.offline',
    'agency.chats',
    'agency.reply',
    'product.chats',
    'news.list',
    'news.create',
    'news.review',
    'news.offline',
    'quote.list',
    'quote.remove',
    'biz.list',
    'biz.grant',
    'biz.orders',
    'biz.remindExpiring',
    'biz.revoke',
    'biz.setExpire',
    /* 财务中心：收款流水登记 / 确认 / 退款与营收汇总 */
    'payment.list',
    'payment.create',
    'payment.confirm',
    'payment.refund',
    /* 用户发起的退款申请：财务核对后通过 / 驳回 */
    'refund.list',
    'refund.handle',
    'finance.summary',
    /* 增长看板：趋势、漏斗与日快照 */
    'stats.trend',
    /* 风险单：四类视图（商品 / 用户 / 咨询 / 系统）与处置 */
    'risk.cases',
    'risk.caseUpdate',
    /* 举报 / 投诉 / 意见反馈处置 */
    'report.list',
    'report.handle',
    /* 账号注销申请：审核并停用账号 */
    'accountRequest.list',
    'accountRequest.handle',
    /* 系统运行日志 / 登录日志 */
    'log.list',
    'log.system',
    /* 角色与临时权限 */
    'role.list',
    'role.save',
    'role.remove',
    'permission.list',
    'permission.save',
    /* 运营洞察与风险池：管理员可看实时在线、榜单，并处置风险内容 */
    'insights.board',
    'insights.searches',
    'insights.boards',
    'risk.list',
    'risk.handle'
  ])
})

/** 客服可见的管理端页面（前端导航与后端 RBAC 用同一份） */
const ROLE_PAGES = Object.freeze({
  /* 客服首页即工作台：只显示自己的待办与作业量，其余页面按职责开放 */
  [ROLES.CS]: Object.freeze(['workbench', 'products', 'demands', 'leads', 'messages', 'users', 'biz', 'boards', 'risk']),
  /* 财务：工作台 + 财务中心，避免误入业务页面 */
  [ROLES.FINANCE]: Object.freeze(['workbench', 'finance']),
  [ROLES.ADMIN]: Object.freeze([
    'workbench', 'stats', 'products', 'demands', 'leads', 'messages',
    'service', 'audit', 'behavior', 'blocked', 'rules', 'accounts', 'users', 'biz', 'news',
    'boards', 'risk', 'settings',
    /* P0-P3 新增：财务中心、系统日志、角色权限 */
    'finance', 'logs', 'roles'
  ])
})

function can(role, action) {
  const allowed = ROLE_ACTIONS[role]
  return !!allowed && allowed.includes(action)
}

function canPage(role, page) {
  const pages = ROLE_PAGES[role]
  return !!pages && pages.includes(page)
}

function assertCan(role, action) {
  if (!can(role, action)) {
    throw new AppError(CODES.FORBIDDEN, '无权限执行该操作', { role, action })
  }
  return true
}

module.exports = { ROLE_ACTIONS, ROLE_PAGES, can, canPage, assertCan }
