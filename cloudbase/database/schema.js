/**
 * 数据库集合、索引与权限定义（部署到云开发数据库时使用）。
 *
 * 安全原则（对齐《平台整体逻辑设计 v3.2》9.4）：
 * 1. 所有集合默认「仅创建者可读写」，管理端只读；
 * 2. 用户不能直接读 products / demands / leads 的敏感字段，统一由云函数投影后返回；
 * 3. 审计集合禁止用户写入与读取，只有管理端可读；
 * 4. sessions / rules / blocked / audit 全部禁止客户端读写。
 */

const COLLECTIONS = [
  {
    name: 'users',
    /* 敏感字段都加密落库（phoneCipher / phoneBidx / realname）。
       客户端禁止直接读写，统一由 user 云函数管理。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'openid', unique: true },
      { field: 'phoneBidx', unique: false }
    ]
  },
  {
    name: 'profiles',
    /* 主体资料（非联系方式），由 user 云函数管理。
       客户端不直接读写，避免绕过投影层。 */
    permission: { read: false, write: false },
    indexes: [{ field: 'uid', unique: true }]
  },
  {
    name: 'products',
    /* 商品池：列表 / 详情统一通过云函数投影返回，客户端不直读。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'ownerId', unique: false },
      { field: 'tradeMode', unique: false },
      { field: 'status', unique: false },
      { field: 'cat', unique: false },
      { field: 'city', unique: false }
    ]
  },
  {
    name: 'demands',
    /* 求购需求：同上，统一云函数管理。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'ownerId', unique: false },
      { field: 'tradeMode', unique: false },
      { field: 'status', unique: false },
      { field: 'cat', unique: false }
    ]
  },
  {
    name: 'leads',
    /* 咨询线索：含比较结果、状态、档位、需求方身份。
       客户端一律不可直读直写：我的咨询走 mine.list 投影，
       联系方式释放必须走 contact.reveal（admin 角色 + 已对接 + 原因）。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: false },
      { field: 'productId', unique: false },
      { field: 'demandId', unique: false },
      { field: 'status', unique: false },
      { field: 'tier', unique: false },
      { field: 'buyerBidx', unique: false },
      { field: 'assignedTo', unique: false }
    ]
  },
  {
    name: 'blocked',
    /* 已拦截箱：只有 admin 可读可改（复核恢复）。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'leadId', unique: false },
      { field: 'at', unique: false },
      { field: 'reviewDeadline', unique: false }
    ]
  },
  {
    name: 'rules',
    /* 咨询人筛选规则：只有 admin 可写，cs 可读。
       客户端禁止访问。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'scope', unique: false },
      { field: 'tier', unique: false },
      { field: 'enabled', unique: false }
    ]
  },
  {
    name: 'sessions',
    /* 管理端会话：客户端完全不可见。 */
    permission: { read: false, write: false },
    indexes: [{ field: 'tokenHash', unique: true }]
  },
  {
    name: 'counters',
    /* 限流计数器：客户端完全不可见。 */
    permission: { read: false, write: false },
    indexes: [{ field: 'id', unique: true }]
  },
  {
    name: 'audit',
    /* 审计日志：只追加，不修改不删除。
       业务账号与客服都不能删。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'actorId', unique: false },
      { field: 'action', unique: false },
      { field: 'at', unique: false }
    ]
  },
  {
    name: 'outbox',
    /* 站内消息 outbox：客户端一律不可直读（消息由云函数写入，没有 _openid）。
       用户侧走 msg.list / msg.read（按 payload.uid 隔离），
       坐席侧走 admin 云函数 msg.threads / msg.list（服务端 SDK 读全量，
       再按坐席可见范围投影）。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'payload.uid', unique: false },
      { field: 'payload.channel', unique: false },
      { field: 'payload.threadId', unique: false },
      { field: 'createdAt', unique: false }
    ]
  },
  {
    name: 'accounts',
    /* 管理端账号（admin / cs）：口令与 TOTP 密钥只在云端校验，客户端完全不可见。
       环境变量里的账号仍作为引导账号，数据库账号用于在线新增 / 停用客服。 */
    permission: { read: false, write: false },
    indexes: [{ field: 'username', unique: true }]
  },
  {
    name: 'stocks',
    /* 我的库存：用户私有现货清单，只用于商机匹配，不对外展示。
       读写统一走 user 云函数的 stock.* 动作（按 ownerId 隔离），客户端无直接权限。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'id', unique: true },
      { field: 'ownerId', unique: false },
      { field: 'at', unique: false }
    ]
  },
  {
    name: 'files',
    /* 材料元数据：私有路径映射表。
       访问文件本身由存储权限 + 签名链接双重把关。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'ownerUid', unique: false },
      { field: 'leadId', unique: false },
      { field: 'storagePath', unique: true }
    ]
  },
  {
    name: 'agencies',
    /* 代采 / 代售委托：主体名称、手机号、法人、信用代码、身份证全部密文落库，
       对外只给脱敏值；状态流转与有效期由 user / admin 云函数维护。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'ownerId', unique: false },
      { field: 'status', unique: false },
      { field: 'expiresAt', unique: false },
      { field: 'createdAt', unique: false }
    ]
  },
  {
    name: 'quotes',
    /* 用户粘贴报价：只存结构化条目（品类 / 型号 / 价格 / 城市），
       原始长文本不落库；24 小时失效，过期由列表按 expiresAt 过滤。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'ownerId', unique: false },
      { field: 'createdAt', unique: false },
      { field: 'expiresAt', unique: false }
    ]
  },
  {
    name: 'news',
    /* 资讯：官方资讯直发；用户投稿先审后发。
       正文含联系方式一律拒绝入库，客户端不可直读。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'status', unique: false },
      { field: 'official', unique: false },
      { field: 'city', unique: false },
      { field: 'publishedAt', unique: false },
      { field: 'createdAt', unique: false }
    ]
  },
  {
    name: 'bizAccess',
    /* 商机权限：99 元 / 月，客服收款后开通 / 续费；不含任何支付凭证。
       id 固定等于 uid，保证一个用户只有一条权限记录。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: true },
      { field: 'status', unique: false },
      { field: 'expireAt', unique: false }
    ]
  },
  {
    name: 'bizClaims',
    /* 商机领取记录：id 由 uid + 目标生成，天然幂等；只记录领取事实，不存联系方式。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: false },
      { field: 'targetId', unique: false },
      { field: 'at', unique: false }
    ]
  },
  {
    name: 'bizMarks',
    /* 商机「不满足」标记：一条用户 + 商机一条，不计入角标但仍保留在列表里。
       与领取记录分开存放，取消标记 / 领取成功后只改 marked，不删历史。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: false },
      { field: 'targetId', unique: false },
      { field: 'marked', unique: false }
    ]
  },
  {
    name: 'onlineUsers',
    /* 在线心跳：用户端每次进页写一次 lastSeenAt，超过 5 分钟视为离线。
       只存 openid 与时间戳，不存任何业务内容。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: false },
      { field: 'lastSeenAt', unique: false }
    ]
  },
  {
    name: 'searchLogs',
    /* 搜索埋点：记录搜索词与归并品类，用于生成「每日搜索最多」与品类热榜。
       搜索频次本身进 counters 集合，这里只留明细便于回溯。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'day', unique: false },
      { field: 'scope', unique: false },
      { field: 'at', unique: false }
    ]
  },
  {
    name: 'favorites',
    /* 收藏：换设备后可恢复，替代原先只存本地缓存的做法。
       只存 uid + 对象 id，不存对象内容；读写统一走 user 云函数 fav.* 动作。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: false },
      { field: 'targetId', unique: false },
      { field: 'updatedAt', unique: false }
    ]
  },
  {
    name: 'follows',
    /* 关注货主：targetKey 是服务端下发的匿名货主键（不可逆哈希），不落对方 openid。
       只用于「我的 - 关注」列表展示，不参与匹配与权限判断。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: false },
      { field: 'targetKey', unique: false },
      { field: 'updatedAt', unique: false }
    ]
  },
  {
    name: 'userEvents',
    /* 用户行为事件：登录 / 发布 / 咨询 / 代采代售 / 领取商机 / 商品浏览等。
       保留 90 天，由 events.cleanupUserEvents 定期清理；仅管理端可读。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: false },
      { field: 'kind', unique: false },
      { field: 'at', unique: false },
      { field: 'day', unique: false }
    ]
  },
  {
    name: 'chatReveals',
    /* 直聊会话级展示授权：仅对当前会话另一方展示主体与联系方式，
       不改变主页 exposure；记录带 on 开关，可随时收回。 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'threadId', unique: false },
      { field: 'uid', unique: false }
    ]
  },
  {
    name: 'reports',
    /* 用户提交的举报 / 投诉 / 意见反馈：管理端风险页「举报反馈」处置并回写站内信 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: false },
      { field: 'status', unique: false },
      { field: 'type', unique: false },
      { field: 'createdAt', unique: false }
    ]
  },
  {
    name: 'accountRequests',
    /* 账号注销申请：管理员审核，通过后账号立即停用 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: false },
      { field: 'status', unique: false },
      { field: 'createdAt', unique: false }
    ]
  },
  {
    name: 'refundRequests',
    /* 用户发起的退款申请：财务核对收款流水后通过 / 驳回，通过即执行退款 */
    permission: { read: false, write: false },
    indexes: [
      { field: 'uid', unique: false },
      { field: 'paymentId', unique: false },
      { field: 'status', unique: false },
      { field: 'createdAt', unique: false }
    ]
  }
]

module.exports = { COLLECTIONS }
