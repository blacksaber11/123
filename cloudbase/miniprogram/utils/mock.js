/**
 * 原型演示数据（仅用于界面展示，不含任何真实联系信息）。
 * 与 Web 原型 prototype/assets/data.js 的字段口径保持一致。
 */
const { CITY_TREE } = require('./region')

/* 关键信息清单模板（8 项） */
const CHECKLIST_BASE = [
  { n: '所有权证明', ok: true, statusText: '已上传' },
  { n: '设备图片', ok: true, statusText: '已上传' },
  { n: '规格文档', ok: true, statusText: '已上传' },
  { n: '第三方检测 / 验收报告', ok: false, statusText: '未上传' },
  { n: '支持同台核验', ok: true, statusText: '支持' },
  { n: '支持先验后付', ok: false, statusText: '未声明' },
  { n: '支持短周期试用', ok: true, statusText: '支持' },
  { n: '接单要求', ok: true, text: '需提供营业执照与验资报告', statusText: '已填写' }
]

function cloneChecklist(overrides) {
  return CHECKLIST_BASE.map((c) => {
    const ov = (overrides || {})[c.n]
    return ov ? Object.assign({}, c, ov) : Object.assign({}, c)
  })
}

const FLOW_SELL = [
  { n: '提交咨询', d: '填写需求与可提供材料' },
  { n: '平台核对', d: '筛选规则 + 逐项资质核对 + 微信联系货主' },
  { n: '建三方企微群', d: '坐席 + 货主 + 买方' },
  { n: '线下看货验机', d: '时间地点由双方在群内约定' },
  { n: '线下签约与付款', d: '平台不参与、不担保' }
]

const FLOW_RENT = [
  { n: '提交咨询', d: '填写承租需求与可提供材料' },
  { n: '平台核对', d: '筛选规则 + 逐项资质核对 + 微信联系出租方' },
  { n: '建三方企微群', d: '坐席 + 出租方 + 承租方' },
  { n: '远程接入联调', d: '接入方式与时间由双方在群内约定' },
  { n: '线下签约与付款', d: '平台不参与、不担保' }
]

/* 需求侧流程：响应方视角 */
const FLOW_BUY = [
  { n: '提交响应', d: '填写可承接数量、报价与可交付时间' },
  { n: '平台核对', d: '核对主体资质与货源信息后转交发布方' },
  { n: '建三方企微群', d: '坐席 + 发布方 + 响应方' },
  { n: '线下验货与签约', d: '时间地点由双方在群内约定' },
  { n: '线下付款与交付', d: '平台不参与、不担保' }
]

const FLOW_RENT_DEMAND = [
  { n: '提交响应', d: '填写可租数量、月租金与可起租时间' },
  { n: '平台核对', d: '核对主体资质与设备信息后转交需求方' },
  { n: '建三方企微群', d: '坐席 + 需求方 + 出租方' },
  { n: '远程接入联调', d: '接入方式与时间由双方在群内约定' },
  { n: '线下签约与付款', d: '平台不参与、不担保' }
]

/* 条件预设：发布方在这里选「必须条件 / 可沟通条件」，也可自己新增 */
const COND_PRESETS = {
  /* 出售商品：货主要求买家满足 */
  seller: [
    '接受同台互验', '接受先验资再看货', '可提供采购意向函',
    '接受指定交易地点', '强主体（国企 / 央企）'
  ],
  /* 求购需求：买家要求供给方满足 */
  buyer: [
    '接受同台互验', '提供设备实拍图片', '提供设备实拍视频',
    '支持资金监管账户', '可提供暗语视频（协商后录制）'
  ],
  /* 出租：出租方要求承租方满足 */
  renter: [
    '接受同台互验', '接受先验资再看货', '可提供采购意向函',
    '强主体（国企 / 央企）', '接受签署租赁意向协议',
    '接受按期预付租金', '用途仅限训练 / 推理等合规业务', '不得转租或二次转让'
  ],
  /* 租赁需求：承租方要求出租方满足 */
  lessor: [
    '提供设备实拍图片', '提供设备实拍视频',
    '明确租金 / 租期 / 押金条款', '接受同台互验',
    '可提供暗语视频（协商后录制）', '支持租金资金监管账户'
  ],
  /* 买卖场景的可沟通条件 */
  nego: [
    '价格可议', '交付周期可放宽', '起订量可下调', '接受二手 / 拆机件',
    '可接受先付款后发货', '可接受分批交付', '可提供验资视频', '可接受指定时间验收'
  ],
  /* 租赁场景的可沟通条件 */
  negoRent: [
    '租金可议', '租期可议', '押金可减免', '可提供试租期', '可给长租折扣',
    '可接受预付折扣', '可接受到期顺延', '可接受分批付款'
  ]
}

/* 在售货源 */
const PRODUCTS = [
  {
    id: 'p1',
    title: 'H100 80G SXM 全新现货 32 台',
    model: 'H100 80G SXM',
    brand: 'NVIDIA',
    cat: 'GPU 服务器',
    tradeMode: '出售',
    type: 'sell',
    isRent: false,
    supply: '现货',
    cond: '全新',
    price: 248000,
    priceText: '24.8 万',
    priceUnit: '元 / 台',
    taxShort: '含税',
    tax: '含税·可开专票·13%',
    qty: 32,
    minQty: 1,
    city: '深圳',
    deliver: '3 天内',
    images: 6,
    published: '12 分钟前',
    subText: 'NVIDIA H100 SXM 整机 · 深圳 IDC 现货',
    note: '整批 32 台，原厂包装，序列号可查，支持上门验货。深圳 IDC 机房现货，可随时提机。',
    accept: '开机验机 + 序列号核对 + 压力测试 24 小时',
    limit: '单批次最多 32 台',
    requirements: '需提供公司资质 + 用途说明，支持先验后付',
    owner: { short: '深', nick: '货主 · 深', realname: '深圳算力科技有限公司', deals: '28 单' },
    ownerShort: '深',
    ownerText: '货主 · 深',
    tags: ['企业', '强主体', '可验资'],
    inquiries: 12,
    views: 256,
    checklistDone: 6,
    checklist: cloneChecklist(),
    flow: FLOW_SELL,
    must: ['接受同台互验', '接受先验资再看货', '强主体（国企 / 央企）'],
    nego: ['价格可议', '可接受分批交付', '可提供验资视频', '可接受指定时间验收']
  },
  {
    id: 'p2',
    title: 'A100 80G PCIe 二手整机 64 台',
    model: 'A100 80G PCIe',
    brand: 'NVIDIA',
    cat: 'GPU 服务器',
    tradeMode: '出售',
    type: 'sell',
    isRent: false,
    supply: '现货',
    cond: '二手',
    price: 98000,
    priceText: '9.8 万',
    priceUnit: '元 / 台',
    taxShort: '不含税',
    tax: '不含税·可开普票',
    qty: 64,
    minQty: 4,
    city: '上海',
    deliver: '当日可提',
    images: 8,
    published: '25 分钟前',
    subText: 'NVIDIA A100 PCIe · 上海机房自提',
    note: '二手整机，使用 1 年，成色 9 成新。上海机房自提，支持现场验机。',
    accept: '现场验机 + 序列号核对',
    limit: '单批次最多 64 台',
    requirements: '企业采购优先，支持分批提货',
    owner: { short: '云', nick: '货主 · 云', realname: '上海云端数据科技', deals: '15 单' },
    ownerShort: '云',
    ownerText: '货主 · 云',
    tags: ['企业', '有成交记录'],
    inquiries: 8,
    views: 142,
    checklistDone: 5,
    checklist: cloneChecklist({ '第三方检测 / 验收报告': { ok: true, statusText: '已上传' }, '支持短周期试用': { ok: false, statusText: '未声明' } }),
    flow: FLOW_SELL,
    must: ['接受同台互验', '强主体（国企 / 央企）'],
    nego: ['价格可议', '起订量可下调', '可接受分批交付', '可提供验资视频']
  },
  {
    id: 'p3',
    title: 'H100 整机出租 · 6 个月起租 · 16 台',
    model: 'H100 80G SXM',
    brand: 'NVIDIA',
    cat: 'GPU 服务器',
    tradeMode: '出租',
    type: 'rent',
    isRent: true,
    supply: '现货',
    price: 18000,
    priceText: '1.8 万',
    priceUnit: '元 / 台 / 月',
    taxShort: '含税',
    tax: '含税·可开专票·6%',
    qty: 16,
    minQty: 8,
    city: '北京',
    deliver: '当日可起租',
    images: 5,
    published: '1 小时前',
    subText: 'NVIDIA H100 SXM 整机 · 北京智算机房',
    note: '设备留在出租方机房，承租方远程接入使用；支持按需扩容，单批 16 台起租。',
    accept: '远程接入测试 + 性能基准核验',
    limit: '单批次最多 16 台',
    requirements: '需提供主体资质与用途说明，接受按期预付租金',
    owner: { short: '智', nick: '货主 · 智', realname: '北京智算中心有限公司', deals: '32 单' },
    ownerShort: '智',
    ownerText: '货主 · 智',
    tags: ['企业', '强主体'],
    inquiries: 5,
    views: 98,
    checklistDone: 7,
    checklist: cloneChecklist({ '支持先验后付': { ok: true, statusText: '支持' } }),
    flow: FLOW_RENT,
    term: '6 个月起',
    closed: '闭口价',
    deposit: '1 个月租金',
    pay: '月付',
    rentLimits: [
      '接受签署租赁意向协议',
      '接受按期预付租金',
      '用途仅限训练 / 推理等合规业务',
      '不得转租或二次转让'
    ],
    must: [
      '接受同台互验', '接受签署租赁意向协议', '接受按期预付租金',
      '用途仅限训练 / 推理等合规业务', '不得转租或二次转让'
    ],
    nego: ['租金可议', '押金可减免', '可提供试租期', '可给长租折扣']
  },
  {
    id: 'p4',
    title: 'RTX 4090 24G 拆机件 120 张',
    model: 'RTX 4090 24G',
    brand: 'NVIDIA',
    cat: 'GPU 加速卡',
    tradeMode: '出售',
    type: 'sell',
    isRent: false,
    supply: '现货',
    cond: '拆机件',
    price: 12800,
    priceText: '1.28 万',
    priceUnit: '元 / 张',
    taxShort: '可开专票',
    tax: '可开专票·13%',
    qty: 120,
    minQty: 10,
    city: '杭州',
    deliver: '7 天内',
    images: 4,
    published: '3 小时前',
    subText: 'NVIDIA RTX 4090 · 杭州现货',
    note: '拆机件，功能正常，附序列号清单，支持批量验货。',
    accept: '批量通电测试 + 序列号核对',
    limit: '单批次最多 120 张',
    requirements: '需提供用途说明',
    owner: { short: '硬', nick: '货主 · 硬', realname: '杭州硬件供应链公司', deals: '8 单' },
    ownerShort: '硬',
    ownerText: '货主 · 硬',
    tags: ['企业'],
    inquiries: 3,
    views: 67,
    checklistDone: 4,
    checklist: cloneChecklist({ '规格文档': { ok: false, statusText: '未上传' }, '支持短周期试用': { ok: false, statusText: '未声明' } }),
    flow: FLOW_SELL,
    must: ['接受同台互验', '强主体（国企 / 央企）', '接受指定交易地点'],
    nego: ['价格可议', '可接受分批交付', '可接受指定时间验收', '可提供验资视频']
  },
  {
    id: 'p5',
    title: 'V100 32G 训练集群租赁 · 128 台',
    model: 'V100 32G SXM2',
    brand: 'NVIDIA',
    cat: 'GPU 服务器',
    tradeMode: '租赁',
    type: 'rent',
    isRent: true,
    supply: '现货',
    price: 4200,
    priceText: '4,200',
    priceUnit: '元 / 台 / 月',
    taxShort: '含普票',
    tax: '含普票·3%',
    qty: 128,
    minQty: 32,
    city: '成都',
    deliver: '3 天内起租',
    images: 3,
    published: '昨天',
    subText: 'NVIDIA V100 SXM2 集群 · 成都西部智算',
    note: '整集群出租，含高速互联与调度系统，可按节点拆分租期。',
    accept: '远程接入测试 + 性能基准核验',
    limit: '单批次最多 128 台',
    requirements: '需提供主体资质与用途说明',
    owner: { short: '西', nick: '货主 · 西', realname: '成都西部智算科技', deals: '21 单' },
    ownerShort: '西',
    ownerText: '货主 · 西',
    tags: ['企业', '有成交记录'],
    inquiries: 6,
    views: 134,
    checklistDone: 5,
    checklist: cloneChecklist({ '支持先验后付': { ok: true, statusText: '支持' } }),
    flow: FLOW_RENT,
    term: '3 个月起',
    closed: '开口价',
    deposit: '1 个月租金',
    pay: '月付',
    rentLimits: [
      '接受签署租赁意向协议',
      '接受按期预付租金',
      '用途仅限训练 / 推理等合规业务'
    ],
    must: [
      '接受同台互验', '接受签署租赁意向协议', '接受按期预付租金',
      '用途仅限训练 / 推理等合规业务'
    ],
    nego: ['租金可议', '租期可议', '押金可减免', '可提供试租期']
  },
  {
    id: 'p6',
    title: '华为 Atlas 900 A2 全新期货 8 台',
    model: 'Atlas 900 A2',
    brand: '华为',
    cat: 'AI 一体机',
    tradeMode: '出售',
    type: 'sell',
    isRent: false,
    supply: '期货',
    cond: '全新',
    price: 860000,
    priceText: '86 万',
    priceUnit: '元 / 台',
    taxShort: '含税',
    tax: '含税·可开专票·13%',
    qty: 8,
    minQty: 1,
    city: '深圳',
    deliver: '30 天内',
    images: 7,
    published: '2 天前',
    subText: '华为昇腾 910B 一体机 · 深圳华为金牌代理',
    note: '期货排单，30 天内交付，含原厂整机质保与安装调试。',
    accept: '到货开箱验收 + 序列号核对 + 压力测试 24 小时',
    limit: '单批次最多 8 台',
    requirements: '需提供营业执照与验资报告',
    owner: { short: '华', nick: '货主 · 华', realname: '深圳华为金牌代理商', deals: '45 单' },
    ownerShort: '华',
    ownerText: '货主 · 华',
    tags: ['企业', '强主体', '可验资'],
    inquiries: 9,
    views: 178,
    checklistDone: 6,
    checklist: cloneChecklist(),
    flow: FLOW_SELL,
    must: ['接受同台互验', '接受先验资再看货', '可提供采购意向函'],
    nego: ['价格可议', '交付周期可放宽', '可接受分批交付', '可接受指定时间验收']
  }
]

/* 求购需求 */
const DEMANDS = [
  {
    id: 'd1',
    title: '训练集群扩容，求购 64 台 H100 80G SXM',
    model: 'H100 80G SXM',
    brand: 'NVIDIA',
    cat: 'GPU 服务器',
    tradeMode: '求购',
    isRent: false,
    budget: 240000,
    budgetText: '24 万',
    budgetUnit: '预算：24 万以内',
    qty: 64,
    city: '北京',
    tax: '必须含税·需专票',
    cond: '仅全新',
    accept: '接受同台验收',
    deliver: '7 天内',
    published: '20 分钟前',
    contact: '某央企',
    responses: 5,
    status: '求购中',
    publisher: '平台',
    tags: ['企业', '强主体', '可验资'],
    termText: '',
    closed: '',
    flow: FLOW_BUY,
    must: [
      '接受同台互验',
      '接受指定交易地点',
      '提供设备实拍图片',
      '提供设备实拍视频',
      '可提供暗语视频（协商后录制）'
    ],
    nego: [
      '价格可议（预算 24 万以内）',
      '可接受分批交付',
      '可接受指定时间验收',
      '可提供验资视频',
      '可提供采购意向函'
    ]
  },
  {
    id: 'd2',
    title: '租赁 32 台 A100 80G PCIe，租期 6 个月',
    model: 'A100 80G PCIe',
    brand: 'NVIDIA',
    cat: 'GPU 服务器',
    tradeMode: '租赁',
    isRent: true,
    budget: 10000,
    budgetText: '1 万',
    budgetUnit: '预算：1 万以内',
    qty: 32,
    city: '上海',
    tax: '可不开票',
    cond: '可接受二手',
    accept: '需第三方报告',
    deliver: '本月内',
    published: '1 小时前',
    contact: '某 AI 创业公司',
    responses: 3,
    status: '求购中',
    publisher: '平台',
    tags: ['企业', '接受同台验收'],
    termText: '6 个月',
    closed: '开口价',
    flow: FLOW_RENT_DEMAND,
    must: [
      '明确租金 / 租期 / 押金条款',
      '提供设备实拍图片',
      '提供设备实拍视频',
      '接受同台互验',
      '可提供暗语视频（协商后录制）',
      '支持租金资金监管账户'
    ],
    nego: [
      '租金可议（预算 1 万 / 台 / 月以内）',
      '租期可议',
      '押金可减免',
      '可提供试租期',
      '可接受分批付款'
    ]
  }
]

/* 我发布的（模拟「我的发布」列表）
   复用完整商品结构，保证「查看详情」能直接打开详情页 */
const MY_PRODUCTS = [
  Object.assign({}, PRODUCTS[3], {
    id: 'mp1',
    title: 'RTX 6000 Ada 48G 现货 20 张',
    model: 'RTX 6000 Ada 48G',
    cat: 'GPU 加速卡',
    price: 26000,
    priceText: '2.6 万',
    qty: 20,
    city: '上海',
    published: '3 天前',
    subText: 'NVIDIA RTX 6000 Ada · 上海现货',
    /* 覆盖继承自 PRODUCTS[3]（RTX 4090 拆机件）的成色与批次描述，避免展示错乱 */
    cond: '全新',
    limit: '单批次最多 20 张',
    accept: '批量通电测试 + 序列号核对',
    status: '在售',
    mine: true,
    owner: { short: '我', nick: '我的发布 · 沪', realname: '本人', deals: '—' },
    ownerShort: '我',
    ownerText: '我的发布 · 沪'
  }),
  Object.assign({}, PRODUCTS[3], {
    id: 'mp2',
    title: 'AI 一体机 Atlas 800I A2 现货 2 台',
    model: 'Atlas 800I A2',
    brand: '华为',
    cat: 'AI 一体机',
    price: 520000,
    priceText: '52 万',
    priceUnit: '元 / 台',
    qty: 2,
    minQty: 1,
    city: '成都',
    published: '5 天前',
    subText: '华为 Atlas 800I A2 · 成都现货',
    /* 同上：覆盖继承来的拆机件成色与批次上限 */
    cond: '全新',
    limit: '单批次最多 2 台',
    accept: '开箱验收 + 序列号核对',
    status: '在售',
    mine: true,
    owner: { short: '我', nick: '我的发布 · 蓉', realname: '本人', deals: '—' },
    ownerShort: '我',
    ownerText: '我的发布 · 蓉'
  })
]

const MY_DEMANDS = [
  Object.assign({}, DEMANDS[0], {
    id: 'md1',
    title: '求购 16 台 L40S 48G，预算 15 万以内',
    model: 'L40S 48G',
    cat: 'GPU 加速卡',
    budget: 150000,
    budgetText: '15 万',
    budgetUnit: '预算：15 万以内',
    qty: 16,
    city: '杭州',
    published: '2 天前',
    responses: 2,
    status: '求购中',
    mine: true,
    contact: '本人',
    /* 覆盖继承自 DEMANDS[0] 的必须条件，保证条件与「杭州 / L40S」一致 */
    must: [
      '强主体（国企 / 央企）',
      '接受同台互验',
      '接受指定交易地点',
      '提供设备实拍图片',
      '提供设备实拍视频'
    ],
    nego: [
      '价格可议（预算 15 万以内）',
      '可接受分批交付',
      '可接受指定时间验收',
      '可提供采购意向函'
    ]
  })
]

/* 我发布的需求收到的响应（发布方视角）
   只看得到条件满足度、报价与数量；公司名、联系人与联系方式一律不展示 */
const DEMAND_RESPONSES = [
  {
    id: 'R-251102-0001',
    demandId: 'md1',
    masked: '央企',
    qty: 16,
    quoteText: '14.6 万 / 台',
    deliver: '7 天内',
    at: '今天 10:12',
    note: '16 台原厂包装 · 接受杭州同台互验 · 含 13% 专票',
    met: [
      '企业主体（营业执照 + 验资）',
      '强主体（国企 / 央企）',
      '接受同台互验（杭州）',
      '必须含税并可开增值税专用发票',
      '7 天内可交付'
    ]
  },
  {
    id: 'R-251102-0002',
    demandId: 'md1',
    masked: '国企',
    qty: 12,
    quoteText: '14.9 万 / 台',
    deliver: '可协商',
    at: '昨天 18:26',
    note: '12 台现货 · 接受杭州同台互验 · 专票可开',
    met: [
      '企业主体（营业执照 + 验资）',
      '接受同台互验（杭州）',
      '必须含税并可开增值税专用发票'
    ]
  }
]

/* 我的咨询（工单 + 咨询记录） */
const MY_INQUIRIES = [
  {
    id: 'WO-241028-001',
    targetId: 'p1',
    targetType: '商品',
    title: 'H100 80G SXM 全新现货 32 台',
    owner: '货主 · 深',
    price: '24.8 万 / 台',
    status: '平台已联系双方',
    at: '2 小时前',
    note: '平台已生成工单，若匹配，后台客服会进行联系，请不要重复发起咨询'
  },
  {
    id: 'Q-241027',
    targetId: 'p3',
    targetType: '商品',
    title: 'H100 整机出租 · 6 个月起租 · 16 台',
    owner: '货主 · 智',
    price: '1.8 万 / 台 / 月',
    status: '待平台联系',
    at: '昨天',
    note: '提交咨询'
  }
]

/* 资质登记 */
/* 资质清单：只保留营业执照与法定代表人信息两项 */
const QUALS = [
  { k: '营业执照', v: '未提交', ok: false },
  { k: '法定代表人信息', v: '未提交', ok: false }
]

/* 统计 */
const STATS = {
  deals: 7,
  views: 1286,
  inquiries: 16,
  published: 3
}

// 详情查找同时覆盖信息流与「我的发布」；指定了 id 但不存在时返回 null，
// 绝不回落到首条数据（否则分享 / 收藏的失效链接会显示成别人的商品）
function productById(id) {
  const key = String(id || '')
  const found = PRODUCTS.concat(MY_PRODUCTS).filter((p) => p.id === key)[0]
  const p = found || (key ? null : PRODUCTS[0])
  if (!p) return null
  // 统一补齐可选字段，避免模板与页面脚本对 undefined 求值
  return Object.assign({
    term: '',
    closed: '',
    deposit: '',
    pay: '',
    rentLimits: [],
    must: [],
    nego: [],
    flow: [],
    checklist: [],
    tags: [],
    images: 1,
    qty: 0,
    minQty: 1,
    status: '',
    owner: {},
    priceText: '',
    priceUnit: '',
    cond: '',
    taxShort: '',
    supply: '',
    city: '',
    requirements: ''
  }, p)
}

function demandById(id) {
  const key = String(id || '')
  const found = DEMANDS.concat(MY_DEMANDS).filter((d) => d.id === key)[0]
  const d = found || (key ? null : DEMANDS[0])
  if (!d) return null
  return Object.assign({
    termText: '',
    closed: '',
    flow: [],
    must: [],
    nego: [],
    tags: [],
    cond: '',
    accept: '',
    deliver: '',
    contact: '',
    status: '',
    responses: 0,
    budgetText: '',
    budgetUnit: '',
    publisher: ''
  }, d)
}

/* 设备目录：设备类型 → 品牌 → 系列 → 型号（按常见度排序）
   真源是 cloudbase/device-catalog.js，由 scripts/sync-device-catalog.mjs 注入到下面；
   原型 data.js 也从同一份生成，两边不再各写一份导致漂移。 */
/* 设备目录开始（由 scripts/sync-device-catalog.mjs 生成，请勿手改） */
const DEVICE_TREE = {
  /* ============ GPU 服务器：算力交易的核心品类 ============ */
  'GPU 服务器': {
    NVIDIA: {
      'B300 系列': ['B300 288G SXM 整机（8 卡）', 'B300 288G PCIe 整机（8 卡）', 'B300 4U 整机'],
      'B200 系列': ['B200 192G SXM 整机（8 卡）', 'B200 192G NVL 整机'],
      'H200 系列': ['H200 141G SXM 整机（8 卡）', 'H200 141G PCIe 整机（8 卡）', 'H200 141G SXM'],
      'H100 系列': ['H100 80G SXM 整机（8 卡）', 'H100 80G PCIe 整机（8 卡）', 'H100 80G SXM', 'H100 80G PCIe', 'H100 NVL 94G'],
      'A100 / A800 系列': ['A100 80G SXM 整机（8 卡）', 'A100 80G PCIe 整机（8 卡）', 'A100 80G SXM', 'A100 80G PCIe', 'A100 80G', 'A100 40G PCIe', 'A800 80G 整机（8 卡）'],
      'H800 系列': ['H800 80G SXM 整机（8 卡）', 'H800 80G PCIe 整机', 'H800 80G'],
      'H20 系列': ['H20 96G SXM 整机（8 卡）', 'H20 96G SXM'],
      'L40 / L20 系列': ['L40S 48G 整机', 'L40S 48G', 'L40 48G', 'L20 48G'],
      'DGX / HGX 系列': ['DGX Station GB300', 'DGX Spark 128GB+4TB', 'DGX B300', 'DGX B200', 'DGX H200', 'DGX H100', 'HGX B300 8-GPU', 'HGX B200 8-GPU', 'HGX H200 8-GPU', 'HGX H100 8-GPU'],
      'RTX 工作站系列': ['RTX PRO 5090 风扇版', 'RTX 4000 Ada 20G', 'RTX 5090 32G 整机', 'RTX 5080 16G 整机', 'RTX 4090 24G', 'RTX 4090 24G 整机', 'RTX 6000 Ada 48G', 'RTX A6000 48G'],
      'RTX PRO 服务器系列': ['RTX PRO 6000 服务器版', 'RTX PRO 6000 工作站版', 'RTX PRO 6000D 84G', 'RTX PRO 5000 72G', 'RTX PRO 6000 Blackwell 96G 8 卡整机', 'RTX PRO 6000 Max-Q 72G 8 卡整机', 'RTX PRO 5000 Blackwell 48G 8 卡整机', 'RTX PRO 6000 Blackwell 96G 4 卡整机'],
      'V100 系列': ['V100 32G SXM2 整机', 'V100 32G SXM2']
    },
    超聚变: {
      'FusionServer XE 系列': ['FusionServer XE9680', 'FusionServer XE9680L', 'FusionServer XE7745'],
      'FusionServer G6 系列': ['FusionServer G8600 V7', 'FusionServer G5500 V7', 'FusionServer G5500 V6'],
      'B300 系列': ['FusionServer 5511 B300 8 卡', 'FusionServer 5510 B300 4 卡'],
      'GB200 系列': ['FusionServer 8000 NVL72']
    },
    戴尔: {
      'PowerEdge XE 系列': ['PowerEdge XE9680', 'PowerEdge XE9680L', 'PowerEdge XE7745', 'PowerEdge XE8640'],
      'PowerEdge R7 系列': ['PowerEdge R760xa RTX PRO 6000 8 卡', 'PowerEdge R760xa RTX PRO 5000 8 卡', 'PowerEdge R760xa', 'PowerEdge R760', 'PowerEdge R660'],
      'B300 系列': ['PowerEdge XE9680L B300', 'PowerEdge R760xa B300']
    },
    浪潮: {
      'NF5488 系列': ['NF5488A5', 'NF5488M7'],
      'NF5468 系列': ['NF5468M7 RTX PRO 6000 8 卡', 'NF5468M7 RTX PRO 5000 8 卡', 'NF5468M7', 'NF5468M6', 'NF5468M6 大盘', 'NF5468H7'],
      'NF5688 系列': ['NF5688M7', 'NF5688M6'],
      '通用 / 存储整机': ['CS5260H2', 'RM5000-F', 'RM5220-F', 'DT3030-F', 'BW100 64G', 'K100 AI 64G']
    },
    超微: {
      'SYS-8 系列': ['SYS-821GE-TNHR RTX PRO 6000 8 卡', 'SYS-821GE-TNHR', 'SYS-821GE-TNHR B300 8 卡', 'AS-8125GS-TNHR', 'AS-8125GS-TNHR H200 8 卡'],
      'SYS-7 系列': ['SYS-741GE-TNRT', 'SYS-730G-TNHR'],
      'SYS-4 系列': ['SYS-420GP-TNAR', 'SYS-420GP-TNAR A100 80G 8 卡', 'AS-4124GS-TNR', 'AS-4124GS-TNR A100 80G 8 卡', 'SYS-421GE-TNRT', 'AS-4125GS-TNRT'],
      'B300 系列': ['B300 4T', 'B300 8T'],
      'GB200 系列': ['SYS-821GE-NVL72']
    },
    联想: {
      'ThinkSystem SR6 系列': ['ThinkSystem SR675 V3 RTX PRO 6000 8 卡', 'ThinkSystem SR670 V2', 'ThinkSystem SR650 V3', 'ThinkSystem SR680a V3'],
      'ThinkSystem SR7 系列': ['ThinkSystem SR685a V3', 'ThinkSystem SR675 V3', 'ThinkSystem SR645 V3']
    },
    华为: {
      'Atlas 800 系列': ['Atlas 800T A2', 'Atlas 800I A2']
    },
    宁畅: {
      'X640 系列': ['X640 G50 RTX PRO 6000 8 卡', 'X640 G50', 'X640 G60'],
      'X660 系列': ['X660 G50', 'X660 G45'],
      'X620 系列': ['X620 G50']
    },
    新华三: {
      'R5300 系列': ['R5300 G6 RTX PRO 6000 8 卡', 'R5300 G6', 'R5300 G5'],
      'R5500 系列': ['R5500 G6', 'R5500 G5'],
      'R4900 系列': ['R4900 G6']
    },
    惠普: {
      'ProLiant DL 系列': ['ProLiant DL380a Gen11 RTX PRO 6000 8 卡', 'ProLiant DL380a Gen11', 'ProLiant DL385 Gen11'],
      'HPE Cray 系列': ['HPE Cray XD670']
    },
    AMD: {
      'Instinct 平台': ['MI400 平台整机', 'MI355X 平台整机', 'MI350X 平台整机', 'MI300X 平台整机', 'MI250X 平台整机']
    },
    中科曙光: {
      'X 系列': ['X785-G30 RTX PRO 6000 8 卡', 'X785-G30', 'X795-G30', 'X740-H30'],
      '曙光智算': ['曙光智算一体机']
    },
    宝德: {
      'PR 系列': ['PR4908P RTX PRO 6000 8 卡', 'PR4908P', 'PR4904P', 'PR8908P', 'PR2710P']
    },
    技嘉: {
      'G 系列': ['G493-SB0 RTX PRO 6000 8 卡', 'G493-SB0', 'G593-SD2', 'G593-SD0', 'G593-SD1', 'G493-ZB1', 'G493-SD0'],
      'A100 / H200 整机': ['G481-S80 A100 80G 8 卡', 'G593-SD0 A100 80G 8 卡', 'G593-SD2 H200 8 卡']
    },
    华硕: {
      'ESC 系列': ['ESC8000A-E12 RTX PRO 6000 8 卡', 'ESC8000A-E12', 'ESC8000-E11', 'ESC4000A-E12', 'ESC N8-E11', 'ESC N8-E11V']
    },
    富士康: {
      'Ingrasys 系列': ['Ingrasys G8800', 'Ingrasys HGX B300 平台']
    },
    华勤: {
      'H 系列': ['H9236', '6U8X-EGS2', 'NX248']
    }
  },

  /* ============ GPU 加速卡：拆卡流通最活跃 ============ */
  'GPU 加速卡': {
    NVIDIA: {
      'B300 系列': ['B300 288G SXM', 'B300 288G PCIe'],
      'B200 系列': ['B200 192G SXM', 'B200 180G PCIe'],
      'H200 系列': ['H200 141G SXM5', 'H200 141G SXM', 'H200 NVL 141G'],
      'H100 系列': ['H100 80G SXM', 'H100 80G SXM5', 'H100 80G PCIe', 'H100 80G PCIe5', 'H100 NVL 94G'],
      'A100 系列': ['A100 80G SXM4', 'A100 80G PCIe', 'A100 80G 定制版', 'A100 40G PCIe', 'A100 80G SXM'],
      'A800 系列': ['A800 80G SXM4', 'A800 80G PCIe'],
      'H800 系列': ['H800 80G SXM', 'H800 80G PCIe'],
      'H20 系列': ['H20 96G SXM', 'H20 96G PCIe'],
      'L 系列': ['L40S 48G', 'L40 48G', 'L20 48G', 'L4 24G'],
      'RTX 50 系': ['RTX 5090 32G', 'RTX 5080 16G', 'RTX 5070 Ti 16G', 'RTX 5070 12G', 'RTX 5060 Ti 16G', 'RTX 5060 Ti 8G', 'RTX 5060 8G', 'RTX 5050 8G'],
      'RTX 40 系': ['RTX 4090 24G', 'RTX 4090D 24G', 'RTX 4080 SUPER 16G', 'RTX 4070 Ti SUPER 16G'],
      'RTX PRO 系列': ['RTX PRO 6000 Blackwell 96G', 'RTX PRO 6000 Max-Q 72G', 'RTX PRO 5000 Blackwell 48G', 'RTX PRO 4500 Blackwell 32G', 'RTX PRO 4000 Blackwell 24G', 'RTX PRO 2000 Blackwell 16G', 'RTX PRO 6000D 84G', 'RTX PRO 6000 服务器版', 'RTX PRO 6000 工作站版', 'RTX PRO 5000 72G'],
      'RTX 专业卡': ['RTX 6000 Ada 48G', 'RTX 5880 Ada 48G', 'RTX 5000 Ada 32G', 'RTX 4500 Ada 24G', 'RTX 4000 Ada 20G', 'RTX A6000 48G', 'RTX A5000 24G'],
      'GB200 / GB300 系列': ['GB300 Grace Blackwell Superchip', 'GB200 Grace Blackwell Superchip', 'GB300 NVL72 计算托盘'],
      'T4 系列': ['T4 16G'],
      'A 系列（推理 / 虚拟化）': ['A40 48G', 'A30 24G', 'A10 24G', 'A16 16G', 'A2 16G'],
      'RTX A 专业卡': ['RTX A5000 24G', 'RTX A4500 20G', 'RTX A4000 16G', 'RTX A2000 12G', 'RTX A2000 6G', 'RTX A1000 8G', 'RTX A400 4G'],
      '涡轮改装卡': ['RTX 5090 32G 涡轮', 'RTX 5080 16G 涡轮', 'RTX 5070 Ti 16G 涡轮', 'RTX 4090 48G 涡轮', 'RTX 4080 32G 改装'],
      'V100 系列': ['V100 32G SXM2', 'V100 16G PCIe']
    },
    AMD: {
      'Instinct 系列': ['MI400 432G', 'MI355X 288G', 'MI350X 288G', 'MI325X 256G', 'MI300X 192G', 'MI300A 128G', 'MI250X 128G', 'MI210 64G'],
      'Radeon 专业卡': ['Radeon AI PRO R9700 32G', 'Radeon PRO W7900 48G', 'Radeon PRO W6800 32G']
    },
    Intel: {
      'Gaudi 系列': ['Gaudi 3 128G OAM', 'Gaudi 3 128G PCIe', 'Gaudi 2 96G'],
      'Data Center GPU 系列': ['Max 1550 128G', 'Max 1100 48G'],
      'Arc Pro 系列': ['Arc Pro B60 24G', 'Arc Pro B50 16G', 'Flex 170 16G', 'Flex 140 12G']
    }
  },

  /* ============ Apple 统一内存：本地跑开源模型的高性价比路线 ============ */
  'Apple 算力设备': {
    Apple: {
      'Mac Studio 系列': ['Mac Studio M4 Max 128G', 'Mac Studio M4 Ultra 192G', 'Mac Studio M3 Ultra 512G', 'Mac Studio M3 Ultra 256G', 'Mac Studio M2 Ultra 192G'],
      'Mac mini 系列': ['Mac mini M4 Pro 64G', 'Mac mini M4 32G', 'Mac mini M2 Pro 32G'],
      'MacBook Pro 系列': ['MacBook Pro M4 Max 128G', 'MacBook Pro M4 Pro 48G', 'MacBook Pro M3 Max 128G'],
      'Mac Pro 系列': ['Mac Pro M2 Ultra 192G']
    }
  },

  /* ============ AI 一体机：开箱即用的交付形态 ============ */
  'AI 一体机': {
    浪潮: {
      'NF5488 系列': ['NF5488A5 一体机'],
      '元脑系列': ['元脑 AIStation']
    },
    超聚变: {
      'FusionServer 2288 系列': ['FusionServer 2288H V7 一体机']
    },
    华为: {
      'Atlas 800 系列': ['Atlas 800T A2', 'Atlas 800I A2'],
      'Atlas 900 系列': ['Atlas 900 A2', 'Atlas 900 A3 SuperPoD']
    },
    宁畅: {
      'X640 系列': ['X640 G50 一体机', 'X640 G50'],
      'X620 系列': ['X620 G50 一体机']
    },
    联想: {
      'ThinkSystem SE 系列': ['SE350 V3 一体机']
    },
    中科曙光: {
      '曙光一体机': ['曙光 X785 一体机', '曙光智算一体机']
    },
    华鲲振宇: {
      '天宫系列': ['天宫 AT800 一体机', '天宫 TG225 一体机']
    },
    宝德: {
      'PR 系列': ['PR4908P 一体机']
    },
    新华三: {
      'UniServer 系列': ['UniServer R5300 G6 一体机']
    }
  },

  /* ============ 推理服务器：性价比需求的主流选择 ============ */
  '推理服务器': {
    浪潮: {
      'NF5468 系列': ['NF5468M7 推理版', 'NF5468M6 推理版'],
      'NF5280 系列': ['NF5280M7 推理版', 'NF5280M6 推理版'],
      'NF5180 系列': ['NF5180M6 推理版']
    },
    超聚变: {
      'FusionServer 2288 系列': ['FusionServer 2288H V7 推理版', 'FusionServer 2288H V6 推理版'],
      'FusionServer 1288 系列': ['FusionServer 1288H V7 推理版']
    },
    宁畅: {
      'X620 系列': ['X620 G50 推理版', 'X620 G40 推理版'],
      'X640 系列': ['X640 G50 推理版']
    },
    新华三: {
      'R5300 系列': ['R5300 G6 推理版'],
      'R4900 系列': ['R4900 G6 推理版']
    },
    华为: {
      'Atlas 800 系列': ['Atlas 800 推理服务器 3010', 'Atlas 800I A2 推理版']
    },
    戴尔: {
      'PowerEdge XE 系列': ['PowerEdge XE9680 推理版', 'PowerEdge R760xa 推理版']
    },
    联想: {
      'ThinkSystem SR 系列': ['ThinkSystem SR675 V3 推理版', 'ThinkSystem SR650 V3 推理版']
    },
    超微: {
      'GPU 推理系列': ['SYS-521GE-TNRT 推理版', 'AS-1115SV-WTNRT']
    }
  },

  /* ============ 笔记本电脑：移动推理与开发调试 ============ */
  笔记本电脑: {
    联想: {
      '拯救者系列': ['拯救者 Y9000P 2025 RTX 5090', '拯救者 Y7000P 2025 RTX 5070'],
      'ThinkPad 系列': ['ThinkPad P1 Gen7 RTX 4090', 'ThinkPad X1 Carbon 2025']
    },
    华硕: {
      'ROG 系列': ['ROG 枪神 9 Plus RTX 5090', 'ROG 幻 16 Air RTX 5080'],
      'ProArt 系列': ['ProArt 创16 RTX 5090']
    },
    戴尔: {
      Alienware系列: ['Alienware m18 R2 RTX 4090'],
      XPS系列: ['XPS 16 RTX 4070']
    },
    惠普: {
      '暗影精灵系列': ['暗影精灵 11 RTX 5080', '暗影精灵 10 RTX 4070']
    },
    微星: {
      '泰坦系列': ['泰坦 18 Ultra RTX 5090'],
      '绝影系列': ['绝影 16 AI Studio RTX 5080']
    },
    机械革命: {
      '旷世系列': ['旷世 16 Super RTX 5090']
    },
    苹果: {
      'MacBook 系列': ['MacBook Pro 14 M4 Pro', 'MacBook Pro 16 M4 Max', 'MacBook Air 13 M3'],
      'iPad 系列': ['iPad Pro 13 M4', 'iPad Air 11 M2']
    },
    微软: {
      'Surface 系列': ['Surface Laptop 7', 'Surface Pro 11']
    },
    华为: {
      'MateBook 系列': ['MateBook X Pro 2024', 'MateBook 14 2024'],
      '平板系列': ['MatePad Pro 13.2']
    },
    小米: {
      '笔记本系列': ['Redmi Book Pro 16 2024'],
      '平板系列': ['小米平板 6S Pro']
    }
  },

  /* ============ 台式机与迷你主机：单机本地推理入门 ============ */
  '台式机与迷你主机': {
    联想: {
      '拯救者刃系列': ['拯救者刃 9000K RTX 5090', '拯救者刃 7000K RTX 5070']
    },
    华硕: {
      'ROG 整机': ['ROG 光魔 G22 RTX 5090']
    },
    戴尔: {
      'Alienware 整机': ['Alienware Aurora R16 RTX 5090']
    },
    惠普: {
      '暗影精灵整机': ['暗影精灵 10 RTX 5080']
    },
    微星: {
      '宙斯盾系列': ['宙斯盾 Ti5 RTX 5090']
    },
    其他: {
      'DIY 整机': ['RTX 5090 四卡整机', 'RTX 5090 双卡整机', 'RTX 4090 四卡整机', 'RTX 4090 双卡整机', 'RTX 4090 单卡整机', 'RTX 5090 单卡整机', 'RTX 5060 Ti 16G 整机']
    }
  },

  /* ============ 超节点与整机柜：最新的算力交付形态 ============ */
  '超节点与整机柜': {
    NVIDIA: {
      'GB300 NVL72': ['GB300 NVL72 整机柜（72 GPU）'],
      'GB200 NVL72': ['GB200 NVL72 整机柜（72 GPU）'],
      'DGX SuperPOD': ['DGX SuperPOD 参考架构']
    },
    华为: {
      'CloudMatrix 系列': ['CloudMatrix 384 超节点'],
      'Atlas 900 系列': ['Atlas 900 A3 SuperPoD']
    },
    浪潮: {
      '元脑超节点': ['元脑 SuperPod'],
      'NF5688 系列': ['NF5688M7 超节点']
    },
    新华三: {
      'UniServer 超节点': ['UniServer S9000']
    },
    联想: {
      'ThinkSystem 超节点': ['ThinkSystem SC777 V4']
    },
    超聚变: {
      'FusionServer 8000 系列': ['FusionServer 8000 NVL72 超节点']
    }
  },

  /* ============ NPU 加速卡：国产算力主线 ============ */
  'NPU 加速卡': {
    华为昇腾: {
      '昇腾 950 系列': ['昇腾 950PR 128G', '昇腾 950DT 144G'],
      '昇腾 910 系列': ['昇腾 910C 128G', '昇腾 910B', '昇腾 910B1', '昇腾 910B2', '昇腾 910B3', '昇腾 910B4', '昇腾 910A'],
      '昇腾 310 系列': ['昇腾 310P', '昇腾 310B'],
      'Atlas 加速卡': ['Atlas 300I Duo 96G', 'Atlas 300V Pro 24G', 'Atlas 300I Pro']
    },
    寒武纪: {
      'MLU590 系列': ['MLU590-M9', 'MLU590-X8'],
      'MLU370 系列': ['MLU370-X8', 'MLU370-S4'],
      '思元系列': ['MLU290-M5', 'MLU270-S4']
    },
    摩尔线程: {
      'MTT S 系列': ['MTT S5000 80G', 'MTT S4000', 'MTT S3000', 'MTT S70', 'MTT S60']
    },
    燧原: {
      '云燧 T 系列': ['云燧 T21', '云燧 T20'],
      '云燧 i / S 系列': ['云燧 i20', '云燧 S60']
    },
    昆仑芯: {
      '昆仑芯系列': ['昆仑芯 P800 96G', '昆仑芯 R300', '昆仑芯 R200']
    },
    海光: {
      'DCU 系列': ['DCU Z100', 'DCU Z100L', 'DCU K100', 'DCU K100-AI']
    },
    天数智芯: {
      '天垓系列': ['天垓 150', '天垓 100'],
      '智铠系列': ['智铠 100', '智铠 50']
    },
    壁仞: {
      'BR 系列': ['BR100 64G', 'BR104 32G']
    },
    沐曦: {
      '曦云系列': ['曦云 C600 144G', '曦云 C500 64G'],
      '曦思系列': ['曦思 N260 64G']
    }
  },

  /* ============ CPU 服务器：通用算力底座 ============ */
  'CPU 服务器': {
    戴尔: {
      'PowerEdge R7 系列': ['PowerEdge R7725', 'PowerEdge R7625', 'PowerEdge R760', 'PowerEdge R7615', 'PowerEdge R760xs', 'PowerEdge R660', 'PowerEdge R6615'],
      'PowerEdge R6 系列': ['PowerEdge R650', 'PowerEdge R650xs', 'PowerEdge R640'],
      'PowerEdge T 系列': ['PowerEdge T560', 'PowerEdge T360']
    },
    超聚变: {
      'FusionServer 2288 系列': ['FusionServer 2288H V7', 'FusionServer 2288H V6', 'FusionServer 2288 V7'],
      'FusionServer 1288 系列': ['FusionServer 1288H V7', 'FusionServer 1288H V6'],
      'FusionServer 5288 系列': ['FusionServer 5288 V7', 'FusionServer 5288 V6']
    },
    浪潮: {
      'NF5280 系列': ['NF5280M7', 'NF5280M6', 'NF5280M5'],
      'NF5180 系列': ['NF5180M6', 'NF5180M5'],
      'NF5270 系列': ['NF5270M6'],
      'TS 系列': ['TS860M6', 'TS860M5']
    },
    联想: {
      'ThinkSystem SR6 系列': ['ThinkSystem SR650 V3', 'ThinkSystem SR630 V3', 'ThinkSystem SR665 V3', 'ThinkSystem SR645 V3'],
      'ThinkSystem SR5 系列': ['ThinkSystem SR650 V2', 'ThinkSystem SR630 V2', 'ThinkSystem SR590 V2'],
      'ThinkSystem ST 系列': ['ThinkSystem ST650 V3']
    },
    新华三: {
      'R4900 系列': ['R4900 G7', 'R4900 G6', 'R4900 G5'],
      'R4700 系列': ['R4700 G6', 'R4700 G5'],
      'R6900 系列': ['R6900 G6', 'R6900 G5']
    },
    华为: {
      'FusionServer G5 系列': ['FusionServer G5500 V7', 'FusionServer G5500 V6'],
      'TaiShan 系列': ['TaiShan 2280 V2', 'TaiShan 200 2280']
    },
    宁畅: {
      'X620 系列': ['X620 G50', 'X620 G40'],
      'X640 系列': ['X640 G50', 'X640 G40'],
      'R620 系列': ['R620 G50', 'R620 G40']
    },
    超微: {
      'SYS-1 系列': ['SYS-1029U-TR4', 'SYS-120U-TNR'],
      'SYS-2 系列': ['SYS-2029U-TR4', 'SYS-220U-TNR', 'SYS-521GE-TNRT'],
      'SYS-6 系列': ['SYS-621C-TN12R']
    },
    中科曙光: {
      'I 系列': ['I620-G30', 'I620-G20', 'I420-G30'],
      'R 系列': ['R620-G30']
    },
    宝德: {
      'PR 系列': ['PR2710P', 'PR2510P', 'PR2280P']
    },
    技嘉: {
      'R 系列': ['R182-Z90', 'R282-Z94', 'R152-Z30']
    },
    华硕: {
      'RS 系列': ['RS720A-E12-RS12U', 'RS520A-E12-RS12U', 'RS500A-E11-RS12U']
    },
    华鲲振宇: {
      '天宫系列': ['天宫 TG225 B1', '天宫 TG245 B1', '天宫 TG525 B1']
    },
    中科可控: {
      'R 系列': ['R6230HA', 'R5230HA', 'R6240H0']
    },
    神州鲲泰: {
      'KunTai 系列': ['KunTai R522', 'KunTai R722', 'KunTai R822']
    },
    长城: {
      '擎天系列': ['擎天 DF720', '擎天 RF5260']
    }
  },

  /* ============ CPU 处理器：算力租赁询价的高频项 ============ */
  'CPU 处理器': {
    英特尔: {
      '至强 6 性能核': ['Xeon 6980P', 'Xeon 6979P', 'Xeon 6960P', 'Xeon 6952P', 'Xeon 6787P', 'Xeon 6776P', 'Xeon 6767P', 'Xeon 6730P', 'Xeon 6726P', 'Xeon 6710E', 'Xeon 6505P', 'Xeon 6511P'],
      '至强 6 能效核': ['Xeon 6780E', 'Xeon 6766E', 'Xeon 6746E', 'Xeon 6736E'],
      '至强第 5 代': ['Xeon Platinum 8592+', 'Xeon Platinum 8593Q', 'Xeon Platinum 8580', 'Xeon Platinum 8558', 'Xeon Platinum 8558P', 'Xeon Gold 6548Y+', 'Xeon Gold 6554S', 'Xeon Gold 6530', 'Xeon Silver 4510'],
      '至强第 4 代': ['Xeon Platinum 8490H', 'Xeon Platinum 8480+', 'Xeon Platinum 8470', 'Xeon Gold 6438Y+', 'Xeon Gold 6430', 'Xeon Gold 6416H', 'Xeon Silver 4410Y'],
      '至强 W 工作站': ['Xeon w9-3595X', 'Xeon w9-3495X', 'Xeon w7-2495X', 'Xeon w7-3465X', 'Xeon w5-3435X'],
      '至强 6 工作站': ['Xeon 698X', 'Xeon 696X', 'Xeon 678X'],
      酷睿系列: ['Core Ultra 9 285K', 'Core Ultra 9 285', 'Core Ultra 7 265K', 'Core Ultra 5 245K', 'Core i9-14900K', 'Core i9-13900K', 'Core i7-14700K', 'Core i7-13700K', 'Core i5-14600K']
    },
    AMD: {
      'EPYC 9005 系列': ['EPYC 9965', 'EPYC 9755', 'EPYC 9845', 'EPYC 9745', 'EPYC 9655', 'EPYC 9645', 'EPYC 9565', 'EPYC 9555', 'EPYC 9455', 'EPYC 9355', 'EPYC 9335', 'EPYC 9255', 'EPYC 9175F'],
      'EPYC 9004 系列': ['EPYC 9654', 'EPYC 9554', 'EPYC 9454', 'EPYC 9354', 'EPYC 9254', 'EPYC 9174F', 'EPYC 9124'],
      'EPYC 8004 系列': ['EPYC 8534P', 'EPYC 8324P', 'EPYC 8224P'],
      'EPYC 7003 系列': ['EPYC 7763', 'EPYC 7713', 'EPYC 7543', 'EPYC 7443', 'EPYC 7302', 'EPYC 7313'],
      线程撕裂者系列: ['Threadripper PRO 9995WX', 'Threadripper PRO 7995WX', 'Threadripper PRO 7985WX', 'Threadripper PRO 7975WX', 'Threadripper 9980X', 'Threadripper 9970X'],
      锐龙系列: ['Ryzen 9 9950X3D', 'Ryzen 9 9950X', 'Ryzen 9 9900X', 'Ryzen 7 9800X3D', 'Ryzen 7 9700X', 'Ryzen 5 9600X', 'Ryzen 9 7950X', 'Ryzen 7 7800X3D']
    },
    海光: {
      '海光 7000 系列': ['海光 7490', '海光 7390', '海光 7380', '海光 7285', '海光 7255'],
      '海光 5000 系列': ['海光 5390', '海光 5380', '海光 5285', '海光 5280'],
      '海光 3000 系列': ['海光 3390', '海光 3380', '海光 3350', '海光 3330']
    },
    华为鲲鹏: {
      '鲲鹏 930 系列': ['鲲鹏 930'],
      '鲲鹏 920 系列': ['鲲鹏 920 7270Z', '鲲鹏 920 7265', '鲲鹏 920 7260', '鲲鹏 920 7255', '鲲鹏 920 5250', '鲲鹏 920 5220', '鲲鹏 920 3210'],
      '鲲鹏 320 系列': ['鲲鹏 320 3221']
    },
    飞腾: {
      '飞腾 S 系列': ['飞腾 S5000C', '飞腾 S5000C-E', '飞腾 S2500'],
      '飞腾 D 系列': ['飞腾 D3000', '飞腾 D3000M', '飞腾 D2000'],
      '飞腾 2000+ 系列': ['飞腾 FT-2000+/64', '飞腾 FT-2000/4']
    },
    龙芯: {
      '龙芯 3 号系列': ['龙芯 3C6000', '龙芯 3D6000', '龙芯 3A6000', '龙芯 3C5000', '龙芯 3A5000'],
      '龙芯 2 号系列': ['龙芯 2K2000', '龙芯 2K1000LA']
    },
    兆芯: {
      开先系列: ['兆芯 KX-7000', '兆芯 KX-6000', '兆芯 KX-6000G'],
      开胜系列: ['兆芯 KH-40000', '兆芯 KH-30000']
    },
    申威: {
      '申威系列': ['申威 SW26010-Pro', '申威 SW3231']
    }
  },

  /* ============ 存储节点：真实采购刚需 ============ */
  存储节点: {
    华为: {
      'OceanStor 68 系列': ['OceanStor 6810 V6', 'OceanStor 6885 V6'],
      'OceanStor 53/55 系列': ['OceanStor 5310', 'OceanStor 5510'],
      'OceanStor Dorado': ['OceanStor Dorado 5000 V6', 'OceanStor Dorado 18000 V6']
    },
    浪潮: {
      'AS 系列': ['AS5300G7', 'AS2600G7', 'AS5300G5', 'AS2600G2', 'AS2200G2']
    },
    联想: {
      'ThinkSystem DE 系列': ['DE4000H', 'DE6000H', 'DE2000H']
    },
    宏杉: {
      'MS 系列': ['MS5520', 'MS7020', 'MS3000']
    },
    群晖: {
      'RS40 系列': ['RS4021xs+', 'RS2423+'],
      'RS36 系列': ['RS3621xs+']
    },
    威联通: {
      'TS 系列': ['TS-h1290FX', 'TS-873A'],
      'TVS 系列': ['TVS-h1288X']
    },
    新华三: {
      'UniStor 系列': ['UniStor X10000', 'UniStor CF22000']
    },
    超聚变: {
      'FusionStorage 系列': ['FusionStorage 9000', 'OceanStor 5310 国产化']
    },
    戴尔: {
      'PowerStore 500 系列': ['PowerStore 500T', 'PowerStore 1200T']
    }
  },

  /* ============ 全闪存储 ============ */
  '全闪存储': {
    华为: {
      'OceanStor Dorado 系列': ['Dorado 5000 V6', 'Dorado 6000 V6']
    },
    戴尔: {
      'PowerStore 系列': ['PowerStore 1200T', 'PowerStore 3200T']
    },
    新华三: {
      'UniStor CF 系列': ['UniStor CF22000']
    },
    浪潮: {
      'HF 系列': ['HF18000G6']
    },
    Pure: {
      'FlashArray 系列': ['FlashArray //X70 R3']
    }
  },

  /* ============ 交换机：算力集群必需 ============ */
  交换机: {
    华为: {
      'CloudEngine 8800 系列': ['CloudEngine 8850-64CQ-EI', 'CloudEngine 8850-48Y6CQ'],
      'CloudEngine 16800 系列': ['CloudEngine 16800']
    },
    思科: {
      'Nexus 9000 系列': ['Nexus 9336C-FX2', 'Nexus 93180YC-FX3'],
      'Catalyst 9000 系列': ['Catalyst 9500']
    },
    新华三: {
      'S12500 系列': ['S12516X-AF'],
      'S6800 系列': ['S6850-56HF']
    },
    锐捷: {
      'RG-N18000 系列': ['RG-N18010-X']
    },
    迈普: {
      'MyPower S 系列': ['MyPower S6800']
    }
  },

  /* ============ 路由器 ============ */
  路由器: {
    华为: {
      'NetEngine 8000 系列': ['NetEngine 8000 M8', 'NetEngine AR6300']
    },
    思科: {
      'ASR 9000 系列': ['ASR 9904']
    },
    新华三: {
      'CR16000 系列': ['CR16006-F']
    },
    锐捷: {
      'RG-NBR 系列': ['RG-NBR8000']
    }
  },

  /* ============ 防火墙 ============ */
  防火墙: {
    华为: {
      'USG 系列': ['USG6600E', 'USG9500']
    },
    深信服: {
      'AF 系列': ['AF-2000-FH2250B', 'AF-1000-FH2200A']
    },
    新华三: {
      'SecPath F 系列': ['SecPath F5000-AI']
    },
    山石网科: {
      'SG 系列': ['SG-6000-E3960']
    }
  },

  /* ============ 网络设备（光模块 / 线缆等配套） ============ */
  '网络设备': {
    NVIDIA: {
      'Quantum InfiniBand 交换机': ['Quantum-X800 QM9800 800G', 'Quantum-2 Q3400-RA 400G', 'Quantum-2 MQM9700 400G', 'Quantum-2 QM9700 400G', 'Quantum MQM8790 200G', 'Quantum QM8790 200G', 'SB7890 100G'],
      'Spectrum-X 以太交换机': ['Spectrum-X SN5610 800G', 'Spectrum-X SN5600 800G', 'Spectrum-X SN5400 400G', 'Spectrum-3 MSN4700 400G', 'Spectrum-3 MSN4600 400G', 'Spectrum-2 MSN3700 200G', 'Spectrum MSN2700 100G', 'Spectrum MSN2410 25G', 'Spectrum MSN2201 25G', 'Spectrum MSN8700 800G'],
      'ConnectX 网卡系列': ['ConnectX-8 800G', 'ConnectX-7 400G 单口', 'ConnectX-7 200G 双口', 'ConnectX-6 200G 双口', 'ConnectX-6 Dx 100G 双口', 'ConnectX-5 100G 双口', 'ConnectX-5 25G 双口', 'ConnectX-4 100G 双口', 'ConnectX-4 Lx 25G 双口']
    },
    思科: {
      'Nexus 9300 系列': ['Nexus 9364D-GX2A', 'Nexus 9336C-FX2'],
      'Nexus 9000 系列': ['Nexus 9500 400G 模块化']
    },
    华为: {
      'CloudEngine 98 系列': ['CloudEngine 9860-8CQ 800G'],
      'CloudEngine 88 系列': ['CloudEngine 8850-64CQ-EI'],
      'CloudEngine 68 系列': ['CloudEngine 6881-48S6CQ']
    },
    星网锐捷: {
      'RG-S65 系列': ['RG-S6510-48VS8CQ'],
      '800G 系列': ['RG-S6990-8CQ 800G']
    },
    迈普: {
      'MyPower S68 系列': ['MyPower S6800']
    }
  },

  /* ============ 光模块与线缆：网络配套件 ============ */
  '光模块与线缆': {
    NVIDIA: {
      'InfiniBand / 以太网模块': ['MMA4Z00-NS400', 'MMA4Z00-NS', 'MMA4Z00-NS-FLT', 'MMA1Z00-NS400', 'MMA2P00-AS', 'MMA1B00-C100D', 'MMS1X00-NS400', 'MMS4X00-NS400', 'MMS4A00-XM', 'MMS4A20-XM800', 'MMS4C10-XM']
    },
    中际旭创: {
      '1.6T 系列': ['1.6T OSFP-DD 2km'],
      '800G 系列': ['800G OSFP DR8 500m', '800G OSFP 2FR4 2km'],
      '400G 系列': ['400G OSFP 500m', '400G QSFP-DD DR4 500m'],
      '200G 系列': ['200G QSFP56 SR4']
    },
    华为: {
      '1.6T 系列': ['1.6T OSFP 2km'],
      '400G 系列': ['400G QSFP-DD 10km', '400G QSFP-DD 2km', '400G QSFP-DD ZR 80km'],
      '200G 系列': ['200G QSFP56 2km']
    },
    立讯: {
      'AOC 系列': ['1.6T AOC 30m', '800G AOC 30m', '400G AOC 30m'],
      'DAC 系列': ['800G DAC 2m', '400G DAC 3m']
    },
    新易盛: {
      '800G 系列': ['800G OSFP SR8', '800G OSFP DR4'],
      '400G 系列': ['400G QSFP112 DR4']
    }
  },

  /* ============ AI 工作站：推理与小模型训练 ============ */
  'AI 工作站': {
    联想: {
      'ThinkStation PX 系列': ['PX 620 RTX 6000 Ada', 'PX 650 双卡 RTX 6000 Ada', 'PX 620', 'PX 650'],
      'ThinkStation P3 系列': ['P3 Tower RTX 5090']
    },
    戴尔: {
      'Precision 系列': ['Precision 7960 Tower RTX 6000 Ada', 'Precision 5860 RTX 5000 Ada', 'Precision 7960 Tower', 'Precision 5860', 'Precision 3680 RTX 5090']
    },
    惠普: {
      'Z 系列': ['Z8 Fury G5 双卡 RTX 6000 Ada', 'Z6 G5 A RTX 5000 Ada', 'Z8 Fury G5', 'Z6 G5 A', 'Z2 Tower G1i RTX 5090']
    },
    超微: {
      'SYS-5 系列': ['SYS-540A-TR RTX 6000 Ada', 'SYS-741GE-TNRT 四卡 RTX 4000 Ada', 'SYS-540A-TR', 'SYS-741GE-TNRT']
    },
    超聚变: {
      'FusionXtation 系列': ['FusionXtation X3 8000', 'FusionXtation X3 8000 工作站']
    },
    华硕: {
      'ProArt 系列': ['ProArt 创16 RTX 5090']
    },
    浪潮: {
      '元脑工作站': ['元脑 EIS800 工作站', '元脑 AIStation 工作站']
    },
    宁畅: {
      'W 系列': ['W640 G50', 'W620 G50']
    },
    华为: {
      'Atlas 工作站': ['Atlas 800 工作站']
    },
    技嘉: {
      'AI TOP 系列': ['AI TOP ATOM 工作站', 'AI TOP 500 工作站']
    }
  },

  /* ============ 边缘计算设备 ============ */
  '边缘计算设备': {
    华为: {
      'Atlas 500 系列': ['Atlas 500 Pro', 'Atlas 500 智能小站']
    },
    浪潮: {
      'EIS 系列': ['EIS800', 'EIS200']
    },
    联想: {
      'ThinkSystem SE 系列': ['SE350', 'SE450']
    },
    新华三: {
      'UniServer E 系列': ['UniServer E3300 G6']
    },
    NVIDIA: {
      'Jetson 边缘系列': ['Jetson AGX Orin 64G 边缘盒', 'Jetson Orin NX 16G 边缘盒']
    }
  },

  /* ============ AI 开发板与边缘盒子 ============ */
  'AI 开发板与边缘盒子': {
    NVIDIA: {
      'Jetson Orin 系列': ['Jetson AGX Orin 64G', 'Jetson Orin NX 16G', 'Jetson Orin Nano 8G'],
      'Jetson Thor 系列': ['Jetson AGX Thor 128G']
    },
    华为昇腾: {
      'Atlas 200 系列': ['Atlas 200I DK A2', 'Atlas 200I A2 加速模块']
    },
    瑞芯微: {
      'RK3588 系列': ['RK3588 开发板', 'RK3588 边缘盒子', 'RK3576 开发板']
    },
    地平线: {
      'RDK 系列': ['RDK X5 8G', 'RDK X3']
    },
    算能: {
      'BM1684 系列': ['BM1684X 边缘盒子', 'SE7 算力盒子']
    },
    树莓派: {
      'Pi 系列': ['Raspberry Pi 5 8G']
    }
  },

  /* ============ 算力套件：准系统 / 桌面超算 / 开发套件的交付形态 ============ */
  '算力套件': {
    NVIDIA: {
      '桌面超算套件': ['DGX Spark 128G', 'DGX Station GB300'],
      'Jetson 开发者套件': ['Jetson AGX Thor 开发者套件', 'Jetson AGX Orin 开发者套件 64G', 'Jetson Orin Nano 开发者套件 8G']
    },
    超微: {
      'GPU 准系统': ['AS-4125GS-TNRT 准系统', 'AS-8125GS-TNHR 准系统', 'SYS-421GE-TNRT 准系统']
    },
    浪潮: {
      'GPU 准系统': ['NF5468M7 准系统', 'NF5468M6 准系统']
    },
    宁畅: {
      'GPU 准系统': ['X640 G50 准系统', 'X640 G60 准系统']
    },
    华鲲振宇: {
      '推理整机套件': ['天宫 TG225 B1 套件', '天宫 AT800 套件']
    },
    算能: {
      '算力盒子套件': ['SE8 算力盒子', 'SE5 算力盒子', 'BM1684X 开发套件']
    },
    香橙派: {
      'AI Studio 系列': ['OrangePi AI Studio Pro 192G', 'OrangePi AI Studio 96G'],
      'AIpro 系列': ['OrangePi AIpro 20T']
    },
    树莓派: {
      'AI 套件': ['Raspberry Pi AI Kit 13T', 'Raspberry Pi AI HAT+ 26T']
    },
    瑞芯微: {
      '核心板套件': ['RK3588 核心板 32G', 'RK3576 核心板 16G']
    },
    地平线: {
      '征程开发套件': ['征程 6P 开发套件', '征程 6E 开发套件', '征程 5 开发套件']
    },
    黑芝麻: {
      '华山开发套件': ['华山 A2000 开发套件', '华山 A1000 开发套件']
    },
    寒武纪: {
      '边缘模组套件': ['MLU220-M2 边缘模组', 'MLU220-SOM 核心板']
    }
  },

  /* ============ 液冷服务器 ============ */
  '液冷服务器': {
    浪潮: {
      'NF5488 液冷系列': ['NF5488A5 冷板式'],
      'TS860 液冷系列': ['TS860M6 浸没式']
    },
    曙光: {
      'I620 液冷系列': ['I620-G30 冷板式']
    },
    新华三: {
      'R5300 液冷系列': ['R5300 G6 冷板式']
    },
    华为: {
      'FusionServer 液冷系列': ['FusionServer G5500 V7 液冷']
    },
    宁畅: {
      'X640 液冷系列': ['X640 G50 冷板式']
    }
  },

  /* ============ 分布式存储 ============ */
  '分布式存储': {
    华为: {
      'OceanStor Pacific 系列': ['OceanStor Pacific 9550', 'OceanStor Pacific 9920']
    },
    曙光: {
      'ParaStor 系列': ['ParaStor 300N', 'ParaStor 300S']
    },
    浪潮: {
      'AS13000 系列': ['AS13000G6', 'AS13000G5']
    },
    新华三: {
      'UniStor X10000 系列': ['UniStor X10516']
    }
  },

  /* ============ DPU / 智能网卡 ============ */
  'DPU / 智能网卡': {
    NVIDIA: {
      'BlueField 系列': ['BlueField-3 DPU', 'BlueField-2 DPU'],
      'ConnectX 网卡系列': ['ConnectX-7 400G 单口', 'ConnectX-7 200G 双口', 'ConnectX-6 200G 双口', 'ConnectX-6 Dx 100G 双口', 'ConnectX-5 100G 双口', 'ConnectX-5 25G 双口', 'ConnectX-4 100G 双口', 'ConnectX-4 Lx 25G 双口']
    },
    浪潮: {
      '网卡与转接卡': ['I35 四口千兆', 'X710 双口万兆', '8222 双口万兆', 'M7 转接卡 X8X8X16', 'M7 转接卡 X16×3']
    },
    华为: {
      '智能网卡系列': ['SmartNIC-2', 'SmartNIC-3']
    },
    英特尔: {
      'IPU 系列': ['IPU E2100', 'IPU E2100 双口 100G'],
      '以太网卡系列': ['E810-CQDA2 100G 双口', 'X710-DA2 10G 双口']
    },
    AMD: {
      'Pensando DPU 系列': ['Pensando DSC2-200', 'Pensando DSC2-100']
    },
    博通: {
      'NetXtreme 网卡系列': ['NetXtreme E-Series 200G 双口', 'NetXtreme BCM57416 10G 双口']
    }
  },

  /* ============ 服务器配件：内存 / 硬盘 / FC HBA / 导轨散热等 ============ */
  '服务器配件': {
    三星: {
      '内存系列': ['DDR5 5600 256G RDIMM', 'DDR5 5600 128G RDIMM', 'DDR5 5600 96G RDIMM', 'DDR5 5600 64G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR5 5600 16G RDIMM', 'DDR5 4800 128G RDIMM', 'DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 4800 16G RDIMM', 'DDR5 5600 64G LRDIMM', 'DDR5 6400 64G RDIMM', 'DDR4 3200 64G RDIMM', 'DDR4 3200 32G RDIMM', 'DDR4 2666 32G RDIMM', 'DDR4 2400 16G RDIMM'],
      'SSD 系列': ['PM1743 15.36T U.2', 'PM9A3 7.68T U.2']
    },
    海力士: {
      '内存系列': ['DDR5 5600 256G RDIMM', 'DDR5 5600 128G RDIMM', 'DDR5 5600 96G RDIMM', 'DDR5 5600 64G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR5 5600 16G RDIMM', 'DDR5 4800 128G RDIMM', 'DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 4800 16G RDIMM', 'DDR5 6400 256G RDIMM', 'DDR5 6400 64G RDIMM', 'MRDIMM 8800 64G', 'DDR4 3200 64G RDIMM', 'DDR4 3200 32G RDIMM', 'DDR4 2666 32G RDIMM'],
      'HBM 系列': ['HBM3E 24G 堆栈']
    },
    美光: {
      '内存系列': ['DDR5 5600 256G RDIMM', 'DDR5 5600 128G RDIMM', 'DDR5 5600 96G RDIMM', 'DDR5 5600 64G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR5 5600 16G RDIMM', 'DDR5 4800 128G RDIMM', 'DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 4800 16G RDIMM', 'DDR5 4800 256G RDIMM', 'DDR4 3200 64G RDIMM', 'DDR4 3200 32G RDIMM', 'DDR4 2666 32G RDIMM'],
      'SSD 系列': ['7450 PRO 3.84T U.2']
    },
    金士顿: {
      '内存系列': ['DDR5 5600 64G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 4800 16G RDIMM', 'DDR4 3200 32G RDIMM', 'DDR4 2666 16G RDIMM']
    },
    长鑫存储: {
      '内存系列': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 5600 64G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR4 3200 32G RDIMM', 'DDR4 3200 16G RDIMM', 'DDR4 2666 16G RDIMM']
    },
    博通: {
      'FC HBA 系列': ['LPe35002 双口 32G', 'LPe35000 单口 32G', 'LPe32002 双口 32G', 'LPe31002 双口 16G', 'LPe12002 双口 8G'],
      'RAID 电池 / 超级电容': ['MegaRAID 超级电容模块', 'MegaRAID 电池备份单元 02-0001', '9560 超级电容模块'],
      'NetXtreme 网卡系列': ['NetXtreme E-Series 200G 双口', 'NetXtreme BCM57416 10G 双口']
    },
    Emulex: {
      'FC HBA 系列': ['LPe35002 双口 32G', 'LPe35000 单口 32G', 'LPe32002 双口 32G', 'LPe31002 双口 16G', 'LPe12002 双口 8G'],
      'OEM 拆机': ['Emulex LPe35002 戴尔版', 'Emulex LPe32002 浪潮版', 'Emulex LPe31002 联想版']
    },
    迈威尔: {
      'QLogic FC HBA 系列': ['QLE2772 双口 32G', 'QLE2770 单口 32G', 'QLE2692 双口 16G', 'QLE2690 单口 16G', 'QLE2562 双口 8G'],
      'OEM 拆机': ['QLogic QLE2772 戴尔版', 'QLogic QLE2692 华为版']
    },
    NVIDIA: {
      'NVLink 桥接器': ['NVLink Bridge 3-Slot', 'NVLink Bridge 4-Slot', 'HGX H100 NVLink 模组', 'GB200 NVL72 NVLink 背板']
    },
    浪潮: {
      '原厂内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR4 3200 64G RDIMM', 'DDR4 3200 32G RDIMM'],
      'RAID 卡系列': ['RAID 9560-8i'],
      'RAID 电池 / 超级电容': ['RAID 9560 超级电容'],
      'FC HBA 系列': ['浪潮 LPe35002 双口 32G', '浪潮 QLE2772 双口 32G'],
      '网卡系列': ['100G 双口网卡', '25G 双口网卡'],
      '导轨 / 散热': ['NF5280M6 导轨套件', 'NF5468M7 导轨套件', 'NF5468M7 散热模组']
    },
    联想: {
      '原厂内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR4 3200 32G RDIMM'],
      'FC HBA 系列': ['ThinkSystem LPe35002 双口 32G', 'ThinkSystem QLE2772 双口 32G'],
      'RAID 电池 / 超级电容': ['ThinkSystem 930-8i 超级电容'],
      '导轨 / 散热': ['ThinkSystem SR650 导轨套件', 'ThinkSystem SR675 导轨套件']
    },
    华为: {
      '原厂内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR4 3200 32G RDIMM'],
      'FC HBA 系列': ['SP520 双口 32G', 'SP580 双口 16G'],
      'RAID 电池 / 超级电容': ['SR430C 超级电容', 'SP686C 超级电容'],
      '导轨 / 散热': ['RH2288 V5 导轨套件', 'FusionServer 散热模组']
    },
    戴尔: {
      '原厂内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR4 3200 32G RDIMM'],
      'FC HBA 系列': ['Dell LPe35002 双口 32G', 'Dell QLE2772 双口 32G'],
      'RAID 电池 / 超级电容': ['PERC H740P 电池', 'PERC H755 超级电容'],
      '导轨 / 散热': ['PowerEdge R750 导轨套件', 'PowerEdge R760 导轨套件', 'PowerEdge R750 散热模组']
    },
    新华三: {
      '原厂内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR4 3200 32G RDIMM'],
      'FC HBA 系列': ['H3C LPe32002 双口 32G', 'H3C QLE2692 双口 16G'],
      '导轨 / 散热': ['R4900 G6 导轨套件', 'R5300 G6 散热模组']
    },
    超微: {
      '导轨 / 散热': ['SYS-2U 导轨套件', '2U 风冷散热模组', '4U GPU 服务器散热模组']
    },
    英特尔: {
      'SSD 系列': ['P5520 15.36T U.2', 'P4510 8T U.2']
    },
    希捷: {
      '机械硬盘': ['Exos X24 24T SATA', 'Exos 2X18 18T SAS']
    },
    西部数据: {
      '机械硬盘': ['Ultrastar DC HC580 24T'],
      'SSD 系列': ['SN640 7.68T U.2']
    }
  },

  /* ============ RAID / HBA 阵列卡：整机拆机与回收报价里最常见的品类 ============ */
  'RAID / HBA 卡': {
    博通: {
      'MegaRAID 92xx 系列': ['9271-8i', '9270-8i', '9265-8i', '9260-8i'],
      'MegaRAID 93xx 系列': ['9361-8i 1G', '9361-8i 2G', '9341-8i', '9311-8i', '9300-8i HBA'],
      'MegaRAID 94xx 系列': ['9460-8i 2G', '9460-8i 4G', '9460-16i 4G', '9440-8i', '9400-8i HBA'],
      'MegaRAID 95xx 系列': ['9560-8i 4G', '9560-16i 8G', '9540-8i', '9500-8i', '9500-16i HBA']
    },
    超微: {
      'OEM 阵列卡': ['超微 9361-8i 2G', '超微 3108 阵列卡']
    },
    戴尔: {
      'PERC 系列': ['PERC H755', 'PERC H740P', 'PERC H330']
    },
    华为: {
      '阵列卡系列': ['SP686C', 'SR430C']
    },
    浪潮: {
      '阵列卡系列': ['RAID 9560-8i', 'PM8060']
    },
    联想: {
      'ThinkSystem 阵列卡': ['ThinkSystem 930-8i', 'ThinkSystem 940-8i']
    }
  },

  /* ============ 电脑配件：主板 / 显卡 / 存储 / 电源 / 散热 / 机箱 / 外设 ============ */
  '主板': {
    华硕: {
      'ROG 系列': ['ROG MAXIMUS Z890 EXTREME', 'ROG STRIX Z890-E GAMING WIFI', 'ROG STRIX X870E-E GAMING', 'ROG STRIX B860-F GAMING'],
      'TUF 系列': ['TUF GAMING Z890-PLUS WIFI', 'TUF GAMING B650-PLUS', 'TUF GAMING B760M-PLUS'],
      'Pro WS 系列': ['Pro WS W790E-SAGE SE', 'Pro WS TRX50-SAGE WIFI']
    },
    技嘉: {
      'AORUS 系列': ['X870E AORUS MASTER', 'Z890 AORUS ELITE WIFI7', 'B650E AORUS PRO AX'],
      'UD 系列': ['Z790 UD AX', 'B760M DS3H']
    },
    微星: {
      'MEG 系列': ['MEG X870E GODLIKE', 'MEG Z890 ACE'],
      'MAG 系列': ['MAG B850 TOMAHAWK WIFI', 'MAG B760M MORTAR II'],
      'MPG 系列': ['MPG X670E CARBON WIFI']
    },
    华擎: {
      'Taichi 系列': ['X870E Taichi', 'Z890 Taichi OCF'],
      '服务器系列': ['GENOAD8X-2T/BCM', 'ROMED8-2T']
    },
    超微: {
      'X14 系列': ['X14SEI-F', 'X14DEM'],
      'X13 系列': ['X13SEI-F', 'X13DEM'],
      'H13 系列': ['H13SSL-N', 'H13DSH']
    },
    戴尔: {
      '服务器主板': ['PowerEdge R750 主板', 'PowerEdge R650 主板']
    }
  },

  '消费级显卡': {
    华硕: {
      'ROG STRIX 系列': ['ROG STRIX RTX 5090 O32G', 'ROG STRIX RTX 5080 O16G', 'ROG STRIX RTX 5070 Ti O16G', 'ROG STRIX RTX 5070 O12G', 'ROG STRIX RTX 5060 Ti O16G', 'ROG STRIX RTX 4090 O24G'],
      'ROG Astral 系列（夜神）': ['ROG Astral RTX 5090 O32G 夜神', 'ROG Astral RTX 5080 O16G 夜神'],
      'TUF 系列': ['TUF RTX 5080 O16G', 'TUF RTX 5070 Ti O16G', 'TUF RTX 5070 O12G', 'TUF RTX 5060 Ti O16G', 'TUF RTX 4070 Ti SUPER O16G'],
      'ProArt 系列（大师）': ['ProArt RTX 5080 16G', 'ProArt RTX 5070 Ti 16G', 'ProArt RTX 5070 12G', 'ProArt RTX 4060 Ti 16G'],
      'Dual 系列（雪豹）': ['Dual RTX 5060 Ti O16G', 'Dual RTX 5060 O8G', 'Dual RTX 4060 O8G', 'Dual RX 7800 XT O16G'],
      '巨齿鲨系列': ['巨齿鲨 ATS RTX 5070 Ti O16G', '巨齿鲨 ATS RTX 5060 Ti O16G']
    },
    微星: {
      'SUPRIM 系列': ['SUPRIM RTX 5090 32G', 'SUPRIM RTX 5080 16G', 'SUPRIM RTX 5070 Ti 16G'],
      'GAMING TRIO 系列（魔龙）': ['GAMING TRIO RTX 5090 32G', 'GAMING TRIO RTX 5080 16G', 'GAMING TRIO RTX 5070 Ti 16G', 'GAMING TRIO RTX 5070 12G', 'GAMING TRIO RTX 5060 Ti 16G', 'GAMING TRIO RX 9070 XT 16G'],
      'VENTUS 系列（万图师）': ['VENTUS 3X RTX 5080 16G', 'VENTUS 3X RTX 5070 Ti 16G', 'VENTUS 3X RTX 5070 12G', 'VENTUS 3X RTX 5060 Ti 16G', 'VENTUS 2X RTX 5060 Ti 8G', 'VENTUS 2X RTX 5060 8G', 'VENTUS 2X RTX 5050 8G', 'VENTUS RTX 4060 8G'],
      'SHADOW 系列（幻影师）': ['SHADOW 3X RTX 5070 12G 幻影师', 'SHADOW 2X RTX 5070 12G 幻影师', 'SHADOW 2X RTX 5060 8G'],
      '入门系列': ['RTX 3050 6G VENTUS 2X', 'RTX 3050 6G AERO ITX']
    },
    技嘉: {
      'AORUS 系列': ['AORUS RTX 5090 MASTER 32G', 'AORUS RTX 5080 MASTER 16G', 'AORUS RTX 5070 Ti MASTER 16G'],
      'GAMING OC 系列（魔鹰）': ['GAMING OC RTX 5080 16G', 'GAMING OC RTX 5070 Ti 16G', 'GAMING OC RTX 5070 12G', 'GAMING OC RTX 5060 Ti 16G', 'GAMING OC RTX 5060 8G', 'GAMING OC RX 7800 XT 16G'],
      'EAGLE 系列（猎鹰）': ['EAGLE RTX 5080 16G', 'EAGLE RTX 5070 Ti 16G', 'EAGLE RTX 5070 12G', 'EAGLE RTX 5060 8G', 'EAGLE RTX 4060 8G'],
      'WINDFORCE 系列（风魔）': ['WINDFORCE RTX 5080 16G', 'WINDFORCE RTX 5070 Ti 16G', 'WINDFORCE RTX 5070 12G', 'WINDFORCE RTX 5060 Ti 16G', 'WINDFORCE RTX 5060 8G', 'WINDFORCE RTX 3050 6G'],
      'GAMING 系列': ['GAMING RTX 5060 8G MAX', 'GAMING RTX 3050 6G']
    },
    七彩虹: {
      'iGame 系列': ['iGame RTX 5090 Vulcan OC', 'iGame RTX 5080 Vulcan OC', 'iGame RTX 5080 Ultra W 白', 'iGame RTX 5080 Ultra 黑', 'iGame RTX 5070 Ti Ultra W', 'iGame RTX 5070 Ultra W', 'iGame RTX 4070 SUPER Advanced'],
      '战斧系列': ['战斧 RTX 5080 16G', '战斧 RTX 5070 Ti 16G', '战斧 RTX 5070 12G', '战斧 RTX 5060 Ti 豪华版', '战斧 RTX 5060 8G', '战斧 RTX 4060 8G', '战斧 RTX 3050 6G'],
      '经典系列': ['战斧 RTX 4090D 24G', '战斧 RTX 4080 SUPER 16G', '战斧 RTX 3090 24G', '战斧 RTX 3080 10G', '战斧 RTX 2080 Ti 22G']
    },
    影驰: {
      '星曜系列': ['星曜 RTX 5080 16G', '星曜 RTX 5070 Ti 16G', '星曜 RTX 5070 12G 大星耀', '星曜 RTX 5070 12G 小星耀', '星曜 RTX 5060 Ti 16G 三风', '星曜 RTX 5060 8G 三风', '星曜 RTX 4070 SUPER 12G'],
      '金属大师系列': ['金属大师 RTX 5080 16G', '金属大师 RTX 5070 Ti 16G', '金属大师 RTX 5060 Ti 16G'],
      '将系列': ['黑将 RTX 5060 8G', '大将 RTX 5070 12G']
    },
    索泰: {
      'AMP 系列': ['AMP Extreme RTX 5090 32G', 'AMP AIRO RTX 5080 16G'],
      'TRINITY 系列（三风）': ['TRINITY RTX 5080 16G', 'TRINITY RTX 5070 Ti 16G', 'TRINITY RTX 5070 12G', 'TRINITY RTX 5060 Ti 16G', 'TRINITY RTX 5060 8G', 'TRINITY RTX 5050 8G'],
      '天启系列': ['天启 RTX 5080 16G', '天启 RTX 5070 Ti 16G'],
      'X-GAMING 系列': ['X-GAMING RTX 5060 Ti 16G', 'X-GAMING RTX 5060 8G']
    },
    蓝宝石: {
      'NITRO+ 系列': ['NITRO+ RX 9070 XT 16G', 'NITRO+ RX 7900 XTX 24G'],
      'PULSE 系列': ['PULSE RX 7800 XT 16G']
    },
    英特尔: {
      'Arc 系列': ['Arc B770 16G', 'Arc B580 12G', 'Arc B570 10G', 'Arc A770 16G']
    },
    撼讯: {
      'Red Devil 系列': ['Red Devil RX 9070 XT 16G', 'Red Devil RX 7900 XTX 24G'],
      'Hellhound 系列': ['Hellhound RX 9060 XT 16G']
    },
    铭瑄: {
      'iCraft 系列': ['iCraft RTX 5080 16G', 'iCraft RTX 5070 Ti 16G'],
      '终结者系列': ['终结者 RTX 5070 12G', '终结者 RTX 5060 Ti 16G', '终结者 RTX 4060 8G']
    },
    盈通: {
      '花嫁系列': ['花嫁 RTX 5070 12G', '花嫁 RX 9070 XT 16G'],
      '游戏高手系列': ['游戏高手 RTX 5060 8G']
    },
    耕升: {
      '炫光系列': ['炫光 RTX 5080 16G', '炫光 RTX 5070 Ti 16G'],
      '追风系列（三风）': ['追风 RTX 5080 16G', '追风 RTX 5070 Ti 16G', '追风 RTX 5070 12G', '追风 RTX 5060 Ti 16G', '追风 RTX 5050 8G'],
      '踏雪系列': ['踏雪 RTX 5070 12G', '踏雪 RTX 5060 8G']
    },
    PNY: {
      'RTX 50 系列': ['PNY RTX 5080 16G 三风', 'PNY RTX 5070 Ti 16G 三风', 'PNY RTX 5070 12G 三风', 'PNY RTX 5060 Ti 16G 三风', 'PNY RTX 5060 8G 三风'],
      '专业卡系列': ['PNY RTX 6000 Ada 48G', 'PNY RTX 5000 Ada 32G', 'PNY RTX A5000 24G', 'PNY RTX A4000 16G']
    },
    映众: {
      'RTX 50 系列': ['映众 RTX 5080 16G 三风', '映众 RTX 5070 Ti 16G 三风', '映众 RTX 5070 12G 双风', '映众 RTX 5060 Ti 16G 双风', '映众 RTX 5060 8G 双风'],
      '冰龙系列': ['冰龙 RTX 5080 16G', '冰龙 RTX 5070 Ti 16G', '冰龙 RTX 5060 Ti 16G']
    },
    万丽: {
      'RTX 50 系列': ['万丽 RTX 5080 16G 三风', '万丽 RTX 5070 Ti 16G 三风', '万丽 RTX 5070 12G 三风', '万丽 RTX 5060 Ti 16G 三风', '万丽 RTX 5060 8G 三风']
    },
    同德: {
      'RTX 50 系列': ['同德 RTX 5080 16G 三风 ARGB', '同德 RTX 5070 Ti 16G 三风', '同德 RTX 5070 12G 三风', '同德 RTX 5060 Ti 16G 三风', '同德 RTX 5060 8G 三风']
    }
  },

  '内存条': {
    金士顿: {
      'FURY 系列': ['FURY Renegade DDR5 8000 48G(24G×2)', 'FURY Renegade DDR5 7200 32G(16G×2)', 'FURY Beast DDR5 6400 32G(16G×2)', 'FURY Beast DDR5 6000 48G(24G×2)', 'FURY Beast DDR5 6000 32G(16G×2)', 'FURY Beast DDR5 5600 32G(16G×2)', 'FURY Beast DDR5 5600 16G', 'FURY Beast DDR4 3200 16G', 'FURY Renegade DDR4 3600 32G(16G×2)'],
      '笔记本内存': ['FURY Impact DDR5 5600 32G SODIMM', 'DDR5 5600 32G SODIMM', 'DDR5 4800 16G SODIMM', 'DDR4 3200 16G SODIMM', 'DDR4 2666 8G SODIMM'],
      '服务器内存': ['DDR5 5600 64G RDIMM ECC', 'DDR5 5600 32G RDIMM ECC', 'DDR5 4800 64G RDIMM ECC', 'DDR5 4800 32G RDIMM ECC', 'DDR4 3200 32G RDIMM ECC']
    },
    海盗船: {
      'Dominator 系列': ['Dominator Titanium DDR5 8000 48G', 'Dominator Titanium DDR5 7200 32G', 'Dominator Platinum DDR5 6000 64G', 'Dominator Platinum DDR5 5600 32G'],
      'Vengeance 系列': ['Vengeance DDR5 6400 64G', 'Vengeance DDR5 6000 32G', 'Vengeance DDR5 5600 32G', 'Vengeance DDR5 5600 16G', 'Vengeance LPX DDR4 3600 16G', 'Vengeance LPX DDR4 3200 16G']
    },
    芝奇: {
      'Trident 系列': ['Trident Z5 RGB DDR5 8000 32G', 'Trident Z5 RGB DDR5 7200 48G', 'Trident Z5 RGB DDR5 6400 32G', 'Trident Z5 Neo DDR5 6000 64G', 'Trident Z5 Royal DDR5 6000 32G'],
      'Ripjaws 系列': ['Ripjaws S5 DDR5 6400 32G', 'Ripjaws S5 DDR5 6000 32G', 'Ripjaws S5 DDR5 5600 32G', 'Ripjaws V DDR4 3200 16G', 'Ripjaws V DDR4 3200 32G']
    },
    威刚: {
      'XPG 系列': ['XPG Lancer DDR5 6400 32G', 'XPG Lancer DDR5 5600 32G', 'XPG D50 DDR4 3600 16G'],
      '万紫千红系列': ['DDR4 3200 8G', 'DDR4 3200 16G', 'DDR4 2666 8G', 'DDR4 2666 16G']
    },
    三星: {
      '台式机内存': ['DDR5 5600 32G', 'DDR5 5600 16G', 'DDR5 4800 32G', 'DDR5 4800 16G', 'DDR4 3200 16G'],
      '笔记本内存': ['DDR5 5600 32G SODIMM', 'DDR5 4800 16G SODIMM', 'DDR4 3200 16G SODIMM'],
      '服务器内存': ['DDR5 6400 128G RDIMM', 'DDR5 6400 96G RDIMM', 'DDR5 5600 256G RDIMM', 'DDR5 5600 128G RDIMM', 'DDR5 5600 96G RDIMM', 'DDR5 5600 64G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR5 5600 16G RDIMM', 'DDR5 4800 128G RDIMM', 'DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 4800 16G RDIMM', 'DDR5 5600 64G LRDIMM', 'DDR5 6400 64G RDIMM', 'DDR4 3200 64G RDIMM', 'DDR4 3200 32G RDIMM', 'DDR4 2666 32G RDIMM']
    },
    英睿达: {
      'Pro 系列': ['Pro DDR5 5600 32G', 'Pro DDR5 4800 16G', 'Pro DDR4 3200 16G'],
      '笔记本内存': ['DDR5 5600 32G SODIMM', 'DDR5 4800 32G SODIMM', 'DDR5 4800 16G SODIMM', 'DDR4 3200 16G SODIMM', 'DDR4 3200 8G SODIMM'],
      '服务器内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR4 3200 32G RDIMM']
    },
    光威: {
      '神武系列': ['神武 DDR5 6000 32G', '神武 DDR5 5600 16G', '神武 DDR4 3200 16G', '神武 DDR4 2666 16G']
    },
    金百达: {
      '银爵系列': ['银爵 DDR5 6000 32G', '银爵 DDR5 6400 64G', '银爵 DDR5 6000 96G(48G×2)', '银爵 DDR5 4800 32G', '银爵 DDR5 4800 16G'],
      'DDR4 系列': ['DDR4 3200 32G', 'DDR4 3200 16G', 'DDR4 2666 16G']
    },
    金邦: {
      'DDR4 系列': ['DDR4 3200 32G', 'DDR4 3200 16G', 'DDR4 2666 16G'],
      'DDR5 系列': ['DDR5 5600 32G', 'DDR5 5600 16G']
    },
    海力士: {
      '服务器内存': ['DDR5 6400 256G RDIMM', 'DDR5 6400 128G RDIMM', 'DDR5 6400 96G RDIMM', 'DDR5 6400 64G RDIMM', 'DDR5 5600 256G RDIMM', 'DDR5 5600 128G RDIMM', 'DDR5 5600 96G RDIMM', 'DDR5 5600 64G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR5 5600 16G RDIMM', 'DDR5 4800 128G RDIMM', 'DDR5 4800 96G RDIMM', 'DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 4800 16G RDIMM', 'DDR5 5600 64G LRDIMM', 'MRDIMM 8800 64G', 'DDR4 3200 64G RDIMM', 'DDR4 3200 32G RDIMM', 'DDR4 2666 32G RDIMM'],
      '消费内存': ['DDR5 6400 32G(16G×2)', 'DDR5 5600 32G(16G×2)', 'DDR4 3200 16G(8G×2)']
    },
    美光: {
      '服务器内存': ['DDR5 5600 256G RDIMM', 'DDR5 5600 128G RDIMM', 'DDR5 5600 96G RDIMM', 'DDR5 5600 64G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR5 5600 16G RDIMM', 'DDR5 4800 256G RDIMM', 'DDR5 4800 128G RDIMM', 'DDR5 4800 96G RDIMM', 'DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 4800 16G RDIMM', 'DDR4 3200 64G RDIMM', 'DDR4 3200 32G RDIMM', 'DDR4 2666 32G RDIMM'],
      '英睿达 Pro': ['Pro DDR5 6000 64G(32G×2)', 'Pro DDR5 5600 32G', 'Pro DDR4 3200 32G(16G×2)']
    },
    长鑫存储: {
      'DDR5 系列': ['DDR5 6400 64G RDIMM', 'DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 5600 64G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR5 4800 16G'],
      'DDR4 系列': ['DDR4 3200 32G RDIMM', 'DDR4 3200 16G', 'DDR4 2666 16G']
    },
    科赋: {
      'CRAS 系列': ['CRAS V DDR5 6000 32G', 'CRAS V DDR5 5600 16G'],
      'BOLT 系列': ['BOLT V DDR5 5600 32G', 'BOLT XR DDR4 3200 16G']
    },
    十铨: {
      'T-Force 系列': ['T-Force Delta DDR5 6000 32G', 'T-Force Vulcan DDR5 5600 16G', 'T-Force Vulcan DDR4 3200 16G']
    },
    阿斯加特: {
      '瓦尔基里系列': ['瓦尔基里 DDR5 6000 32G', '瓦尔基里 DDR5 5600 16G'],
      '洛极系列': ['洛极 DDR4 3200 16G', '洛极 DDR4 2666 16G']
    },
    影驰: {
      '星曜系列': ['星曜 DDR5 6000 32G', '星曜 DDR4 3200 16G'],
      'GAMER 系列': ['GAMER DDR4 3200 8G']
    },
    浪潮: {
      '原厂内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR5 5600 32G RDIMM', 'DDR4 3200 32G RDIMM']
    },
    联想: {
      '原厂内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR4 3200 32G RDIMM']
    },
    华为: {
      '原厂内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR4 3200 32G RDIMM']
    },
    戴尔: {
      '原厂内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR4 3200 32G RDIMM']
    },
    新华三: {
      '原厂内存': ['DDR5 4800 64G RDIMM', 'DDR5 4800 32G RDIMM', 'DDR4 3200 32G RDIMM']
    },
    宇瞻: {
      '台式机内存': ['DDR5 6000 32G(16G×2)', 'DDR5 5600 32G(16G×2)', 'DDR5 5600 16G', 'DDR4 3200 16G', 'DDR4 2666 8G'],
      '笔记本内存': ['DDR5 5600 32G SODIMM', 'DDR5 4800 16G SODIMM', 'DDR4 3200 16G SODIMM']
    },
    创见: {
      '笔记本内存': ['DDR5 5600 32G SODIMM', 'DDR5 4800 16G SODIMM', 'DDR4 3200 16G SODIMM', 'DDR4 2666 8G SODIMM'],
      '服务器内存': ['DDR5 4800 64G RDIMM ECC', 'DDR5 4800 32G RDIMM ECC', 'DDR4 3200 32G RDIMM ECC']
    },
    佰维: {
      '消费内存': ['DDR5 6000 32G(16G×2)', 'DDR5 5600 32G(16G×2)', 'DDR5 5600 16G', 'DDR4 3200 16G'],
      '嵌入式内存': ['LPDDR5X 8533 16G 颗粒', 'LPDDR5 6400 8G 颗粒']
    }
  },

  '固态硬盘': {
    三星: {
      '9100 系列': ['9100 PRO 8TB NVMe', '9100 PRO 4TB NVMe', '9100 PRO 2TB NVMe'],
      '990 系列': ['990 PRO 4TB NVMe', '990 PRO 2TB NVMe', '990 PRO 1TB NVMe', '990 EVO Plus 4TB NVMe', '990 EVO Plus 2TB NVMe'],
      '870 系列': ['870 EVO 4TB SATA', '870 EVO 1TB SATA', '870 QVO 8TB SATA', '870 QVO 2TB SATA'],
      '企业级系列': ['PM1743 15.36TB U.2', 'PM9A3 7.68TB U.2', 'PM9A3 3.84TB U.2', 'PM9A3 960GB U.2', 'PM9D3a 7.68TB U.2'],
      'SATA 系列': ['PM893 7.68TB SATA', 'PM893 3.84TB SATA', 'PM893 960GB SATA', 'PM893 480GB SATA']
    },
    西部数据: {
      '黑盘系列': ['SN8100 4TB NVMe', 'SN850X 8TB NVMe', 'SN850X 4TB NVMe', 'SN850X 2TB NVMe', 'SN7100 2TB NVMe', 'SN770 1TB NVMe'],
      '蓝盘系列': ['SN580 1TB NVMe', 'SA510 1TB SATA'],
      '企业级系列': ['Ultrastar DC SN650 15.36TB U.2', 'Ultrastar DC SN640 7.68TB U.2'],
      '移动固态': ['My Passport SSD 2TB']
    },
    铠侠: {
      'EXCERIA 系列': ['EXCERIA PRO 2TB NVMe', 'EXCERIA PLUS G3 2TB NVMe', 'EXCERIA G2 1TB NVMe'],
      '企业级系列': ['CM7-R 15.36TB U.2', 'CD8P 7.68TB U.2']
    },
    英睿达: {
      'T 系列': ['T705 4TB NVMe', 'T700 2TB NVMe', 'T500 2TB NVMe'],
      'P 系列': ['P3 Plus 4TB NVMe', 'P3 Plus 1TB NVMe'],
      'MX 系列': ['MX500 2TB SATA', 'MX500 1TB SATA']
    },
    致态: {
      'TiPro 系列': ['TiPro9000 4TB NVMe', 'TiPro9000 2TB NVMe'],
      'TiPlus 系列': ['TiPlus7100 4TB NVMe', 'TiPlus7100 2TB NVMe'],
      'Ti600 系列': ['Ti600 2TB NVMe', 'Ti600 1TB NVMe']
    },
    金士顿: {
      'FURY 系列': ['FURY Renegade G5 4TB NVMe', 'FURY Renegade 2TB NVMe'],
      'KC 系列': ['KC3000 2TB NVMe', 'KC600 1TB SATA'],
      '移动固态': ['XS1000 2TB', 'XS2000 4TB']
    },
    希捷: {
      '酷鱼系列': ['酷鱼 540 2TB NVMe', '酷鱼 530 1TB NVMe', '酷鱼 520 2TB NVMe'],
      '企业级系列': ['Nytro 5350 15.36TB U.2', 'Nytro 4350 3.84TB U.2']
    },
    美光: {
      '企业级系列': ['9550 PRO 15.36TB U.2', '9400 PRO 15.36TB U.2', '7450 PRO 7.68TB U.2', '7450 MAX 3.2TB U.2'],
      '消费级系列': ['Crucial P510 2TB NVMe']
    },
    长江存储: {
      '致态企业级': ['PE321 7.68TB U.2', 'PE331 15.36TB U.2']
    },
    闪迪: {
      '消费级系列': ['Extreme PRO 2TB NVMe', 'Extreme PRO 4TB NVMe']
    },
    Solidigm: {
      'D7 系列': ['D7-PS1010 15.36TB U.2', 'D7-P5520 7.68TB U.2', 'D7-P5520 3.84TB U.2'],
      'D5 系列': ['D5-P5336 61.44TB U.2', 'D5-P5430 15.36TB U.2'],
      'SATA 系列': ['S4520 3.84TB SATA', 'S4520 960GB SATA', 'S4610 960GB SATA']
    },
    江波龙: {
      '企业级系列': ['RSZE4836P 3.84TB U.2', 'ORCA 4836 7.68TB U.2']
    },
    忆恒创源: {
      'PBlaze 系列': ['PBlaze7 7940 7.68TB U.2', 'PBlaze6 6930 15.36TB U.2', 'PBlaze6 6541 3.84TB U.2']
    },
    大普微: {
      'J 系列': ['J5060 15.36TB U.2', 'J5100 7.68TB U.2', 'R5100 3.84TB U.2']
    },
    得瑞: {
      'DERA 系列': ['DERAPRO D7470 15.36TB U.2', 'DERAPRO D7430 7.68TB U.2']
    },
    威刚: {
      'XPG 系列': ['XPG GAMMIX S70 Blade 2TB NVMe', 'XPG SX8200 Pro 1TB NVMe']
    },
    影驰: {
      '星曜系列': ['星曜 7000 Plus 2TB NVMe', '擎 4TB NVMe']
    },
    佰维: {
      '消费级系列': ['NV7400 2TB NVMe', 'NV3500 1TB NVMe'],
      '嵌入式系列': ['EM130 128G eMMC', 'EM160 256G eMMC']
    },
    梵想: {
      '消费级系列': ['S790 4TB NVMe', 'S500 Pro 2TB NVMe']
    }
  },

  '机械硬盘': {
    希捷: {
      '酷鱼系列': ['酷鱼 8TB 5400 转', '酷鱼 4TB 5400 转', '酷鱼 2TB 7200 转'],
      '酷狼系列': ['酷狼 Pro 24TB NAS', '酷狼 Pro 16TB NAS', '酷狼 8TB NAS', '酷狼 4TB NAS'],
      '银河系列': ['Exos M 30TB 企业级', 'Exos X24 24TB 企业级', 'Exos X20 20TB 企业级', 'Exos X18 18TB 企业级', 'Exos 2X18 18TB SAS'],
      '监控系列': ['SkyHawk 8TB 监控盘', 'SkyHawk 4TB 监控盘']
    },
    西部数据: {
      '蓝盘系列': ['蓝盘 8TB 5640 转', '蓝盘 4TB 5400 转', '蓝盘 2TB 7200 转'],
      '红盘系列': ['红盘 Pro 22TB NAS', '红盘 Pro 14TB NAS', '红盘 Plus 8TB NAS'],
      '金盘系列': ['金盘 24TB 企业级', '金盘 18TB 企业级'],
      '企业级系列': ['Ultrastar DC HC590 26TB', 'Ultrastar DC HC580 24TB', 'Ultrastar DC HC555 12TB', 'Ultrastar DC HC550 18TB'],
      '监控系列': ['紫盘 8TB 监控盘', '紫盘 4TB 监控盘']
    },
    东芝: {
      'N300 系列': ['N300 22TB NAS', 'N300 20TB NAS', 'N300 14TB NAS', 'N300 8TB NAS'],
      'MG 系列': ['MG11ACA 24TB 企业级', 'MG10ACA 20TB 企业级', 'MG08ACA 16TB 企业级', 'MG07ACA 14TB 企业级'],
      '监控系列': ['S300 8TB 监控盘', 'S300 4TB 监控盘']
    }
  },

  '电源': {
    海韵: {
      'Focus 系列': ['Focus GX-850 850W 金牌', 'Focus GX-1000 1000W 金牌'],
      'Vertex 系列': ['Vertex GX-1200 1200W 金牌'],
      'PRIME 系列': ['PRIME TX-1600 1600W 钛金牌']
    },
    振华: {
      'Leadex 系列': ['Leadex III 850W 金牌', 'Leadex VII 1200W 白金牌']
    },
    长城: {
      '巨龙系列': ['巨龙 1250W 金牌', '巨龙 2000W 金牌'],
      'X 系列': ['X6 650W 金牌']
    },
    航嘉: {
      'MVP 系列': ['MVP K850 850W 金牌', 'MVP P1200 1200W 白金牌']
    },
    酷冷至尊: {
      'MWE 系列': ['MWE Gold 750W V2', 'MWE Gold 1050W V2'],
      'X 系列': ['X Silent Edge 850W 白金牌']
    },
    美商海盗船: {
      'RM 系列': ['RM850x 850W 金牌', 'RM1000x 1000W 金牌'],
      'HX 系列': ['HX1500i 1500W 白金牌']
    },
    台达: {
      '服务器电源': ['DPS-800AB 800W 冗余电源', 'DPS-1200FB 1200W 冗余电源', 'DPS-1600AB 1600W 冗余电源'],
      '电源框': ['3kW 电源框（4×800W）', '6kW 电源框（4×1600W）']
    },
    全汉: {
      'Hydro 系列': ['Hydro G Pro 1000W 金牌', 'Hydro Ti Pro 1600W 钛金牌'],
      '服务器电源': ['FSP 2000W 冗余电源', '12kW 电源柜（6×2000W）']
    }
  },

  '散热器': {
    猫头鹰: {
      '风冷系列': ['NH-D15 双塔风冷', 'NH-U12A 单塔风冷']
    },
    利民: {
      '风冷系列': ['PA120 SE 双塔', 'FC140 双塔'],
      '水冷系列': ['Frozen Magic 360 水冷', 'Frozen Notte 360 水冷']
    },
    九州风神: {
      '风冷系列': ['AK620 双塔', 'AK400 单塔'],
      '水冷系列': ['LT720 360 水冷', '冰堡垒 360 水冷']
    },
    酷冷至尊: {
      '风冷系列': ['Hyper 212 黑版'],
      '水冷系列': ['ML360 水冷', 'G360 水冷']
    },
    恩杰: {
      'Kraken 系列': ['Kraken 360 RGB 水冷', 'Kraken Elite 280 水冷']
    },
    瓦尔基里: {
      '水冷系列': ['E360 水冷', 'GL360 水冷']
    },
    超微: {
      '服务器风扇': ['4U 8 热管服务器散热器', '2U 被动散热模组']
    }
  },

  '机箱': {
    联力: {
      'O 系列': ['O11D EVO 中塔', 'O11D EVO XL 全塔'],
      'A 系列': ['A4-H2O ITX']
    },
    追风者: {
      'NV 系列': ['NV5 中塔', 'NV7 全塔'],
      'XT 系列': ['XT523 中塔']
    },
    酷冷至尊: {
      'Master 系列': ['MasterFrame 600 全塔', 'Q300L 中塔'],
      'NR 系列': ['NR200P ITX']
    },
    乔思伯: {
      'D 系列': ['D31 中塔', 'D41 中塔'],
      'A4 系列': ['A4 纸片 ITX']
    },
    安钛克: {
      'Performance 系列': ['P20C 中塔'],
      '机架式系列': ['4U 工控机箱 450mm', '2U 机架式机箱']
    },
    迎广: {
      'A 系列': ['A1 Prime ITX']
    }
  },

  '显示器': {
    戴尔: {
      'UltraSharp 系列': ['U2723QE 27 寸 4K', 'U3223QE 32 寸 4K'],
      'AW 系列': ['AW3423DWF 34 寸 OLED']
    },
    华硕: {
      'ROG 系列': ['ROG Swift PG27UCDM 27 寸 4K 240Hz', 'ROG Swift OLED PG32UCDM'],
      'ProArt 系列': ['ProArt PA279CRV 27 寸 4K']
    },
    明基: {
      '设计系列': ['SW270C 27 寸 2K', 'PD2706U 27 寸 4K'],
      '电竞系列': ['MOBIUZ EX2710Q']
    },
    艺卓: {
      'ColorEdge 系列': ['CS2740 27 寸 4K', 'CG279X 27 寸']
    },
    三星: {
      '玄龙骑士系列': ['G7 32 寸 4K 144Hz', 'G9 49 寸 带鱼屏'],
      '智能显示器': ['M8 32 寸 4K']
    },
    LG: {
      'UltraGear 系列': ['27GR95QE 27 寸 OLED', '32GQ950 32 寸 4K'],
      'UltraFine 系列': ['27UP850 27 寸 4K']
    },
    AOC: {
      '电竞系列': ['Q27G3XMN 27 寸 2K', '24G2 24 寸 165Hz']
    }
  },

  '键鼠与输入设备': {
    罗技: {
      '鼠标系列': ['MX Master 3S', 'G Pro X Superlight 2', 'G502 X Plus'],
      '键盘系列': ['MX Keys S', 'G915 X 无线机械'],
      '摄像头系列': ['Brio 500', 'C920 Pro']
    },
    雷蛇: {
      '鼠标系列': ['DeathAdder V3 Pro', 'Viper V3 Pro'],
      '键盘系列': ['BlackWidow V4 Pro', 'Huntsman V3 Pro']
    },
    樱桃: {
      '键盘系列': ['MX Board 3.0 S', 'MX 8.2 TKL']
    },
    达尔优: {
      '键盘系列': ['A87 Pro 机械键盘', 'A98 Pro 三模'],
      '鼠标系列': ['A950 Pro']
    },
    微软: {
      '人体工学系列': ['Surface 人体工学键盘', 'Sculpt 人体工学套装']
    },
    Wacom: {
      '数位板系列': ['Intuos Pro M', 'One by Wacom S']
    }
  },

  '网卡与扩展卡': {
    英特尔: {
      '万兆网卡': ['X710-DA2 双口万兆', 'X550-T2 双口万兆电口'],
      '无线网卡': ['AX210 无线网卡', 'BE200 Wi-Fi 7 网卡']
    },
    博通: {
      '万兆网卡': ['BCM57414 双口 25G', 'P225P 双口 10G']
    },
    迈络思: {
      '网卡系列': ['ConnectX-6 Dx 双口 25G', 'ConnectX-7 双口 100G'],
      'DPU 系列': ['BlueField-2 DPU']
    },
    华硕: {
      '网卡系列': ['XG-C100C 万兆网卡', 'PCE-AX58BT 无线网卡']
    },
    绿联: {
      '扩展坞': ['USB4 双口扩展坞', 'Type-C 11 合 1 扩展坞'],
      '采集卡': ['4K HDMI 采集卡']
    },
    圆刚: {
      '采集卡': ['Live Gamer 4K GC573', 'Live Gamer ULTRA GC553']
    },
    创新: {
      '声卡': ['Sound Blaster AE-9', 'Sound BlasterX G6']
    }
  },

  '办公与打印外设': {
    惠普: {
      '激光打印机': ['LaserJet Pro M404dn', 'LaserJet MFP M437n'],
      '喷墨打印机': ['Smart Tank 519']
    },
    佳能: {
      '激光打印机': ['imageCLASS LBP6230dw', 'imageCLASS MF264dw'],
      '喷墨打印机': ['G3800 墨仓式']
    },
    爱普生: {
      '墨仓式打印机': ['L3253 墨仓式一体机', 'L8058 六色照片打印机'],
      '扫描仪': ['DS-770II 高速扫描仪']
    },
    兄弟: {
      '激光打印机': ['DCP-7080D', 'HL-L2350DW']
    },
    富士施乐: {
      '复合机': ['ApeosPort C2560', 'DocuCentre S2110']
    },
    得力: {
      '标签打印机': ['DL-888D 标签打印机']
    },
    明基: {
      '投影仪': ['MH560 1080P 投影仪', 'W1800 4K 投影仪']
    }
  },

  '直播与影音设备': {
    索尼: {
      '相机系列': ['ZV-E10 II', 'A7C II'],
      '麦克风系列': ['ECM-B10 枪麦']
    },
    大疆: {
      '无线麦克风': ['DJI Mic 2', 'DJI Mic Mini'],
      '相机系列': ['Osmo Pocket 3']
    },
    舒尔: {
      '麦克风系列': ['SM7B 动圈麦', 'MV7+ 直播麦克风']
    },
    铁三角: {
      '麦克风系列': ['AT2020 电容麦', 'AT2035']
    },
    雅马哈: {
      '声卡系列': ['UR22C 音频接口', 'AG03 调音台']
    },
    罗技: {
      '补光灯': ['Litepanel 补光灯']
    }
  },

  /* ============ 机柜与配电 ============ */
  '机柜与配电': {
    华为: {
      '智能微模块系列': ['FusionModule2000']
    },
    施耐德: {
      '机柜系列': ['NetShelter SX 42U'],
      'PDU 系列': ['AP8886 三相 PDU']
    },
    维谛: {
      'UPS 系列': ['Liebert EXL S1 200kVA']
    },
    科华: {
      'UPS 系列': ['YTM33150 150kVA']
    }
  },

  /* ============ 液冷散热 ============ */
  '液冷散热': {
    维谛: {
      'CDU 系列': ['CDU 600kW', 'CDU 300kW']
    },
    曙光: {
      '浸没式液冷系列': ['相变浸没液冷机柜 C8000']
    },
    申菱: {
      '冷板式液冷系列': ['CDU-500']
    },
    英维克: {
      '冷板式液冷系列': ['XSpace 液冷机柜']
    }
  }
}
/* 设备目录结束 */

module.exports = {
  DEVICE_TREE,
  CITY_TREE,
  COND_PRESETS,
  FLOW_SELL,
  FLOW_RENT,
  FLOW_BUY,
  FLOW_RENT_DEMAND,
  PRODUCTS,
  DEMANDS,
  MY_PRODUCTS,
  MY_DEMANDS,
  DEMAND_RESPONSES,
  MY_INQUIRIES,
  QUALS,
  STATS,
  productById,
  demandById
}
