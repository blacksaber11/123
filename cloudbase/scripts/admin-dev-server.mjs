/**
 * 本地联调服务：把管理端原型（prototype/）与用户端接口接到同一套云函数业务链。
 *
 * 用途：
 *   1) 管理端原型是静态 HTML，无法直接调用 wx.cloud.callFunction，
 *      这里用 HTTP 暴露与 cloudfunctions/admin 完全相同的 handlers.admin；
 *   2) 小程序可通过 app.globalData.devApiBase 指向本服务，走同一份持久化数据。
 *
 * 启动：node cloudbase/scripts/admin-dev-server.mjs
 * 访问：http://127.0.0.1:8790/admin/
 *
 * 数据落盘在 cloudbase/.dev-data/state.json（仅本地开发使用）。
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const PROTOTYPE_DIR = path.join(ROOT, 'prototype')
const DATA_DIR = path.join(ROOT, 'cloudbase', '.dev-data')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const PORT = Number(process.env.PORT || 8790)
const HOST = process.env.HOST || '127.0.0.1'

const { createRouter } = require('../shared/router')
const { createCache } = require('../shared/cache')
const { createMemoryRepo } = require('../shared/repo')
const { loadKeys, generateTotp } = require('../shared/crypto')
const { DEMO_ADMIN_ACCOUNTS } = require('../shared/constants')

/* 本地联调密钥：仅用于开发，生产必须由云函数环境变量注入 */
const keys = loadKeys({
  AES_KEY_B64: process.env.AES_KEY_B64 || Buffer.alloc(32, 7).toString('base64'),
  HMAC_KEY_B64: process.env.HMAC_KEY_B64 || Buffer.alloc(32, 11).toString('base64')
})

const NOW = Date.now()
const MINUTE = 60 * 1000
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

function demoSeed() {
  return {
    /* 用户主键与 openid 一致：/api/user 用 openid 直接读取档案 */
    users: [
      { id: 'o_demo_user_1', openid: 'o_demo_user_1', nick: '张工 · 深圳', realname: '张工', status: '正常', createdAt: NOW - 3 * DAY },
      { id: 'o_demo_user_2', openid: 'o_demo_user_2', nick: '李经理 · 上海', realname: '李经理', status: '正常', createdAt: NOW - 5 * DAY }
    ],
    products: [
      {
        id: 'p1',
        ownerId: 'o_demo_user_1',
        tradeMode: '出售',
        side: 'supply',
        title: 'NVIDIA H100 80G 整机（8 卡）',
        cat: 'GPU 服务器',
        brand: 'NVIDIA',
        model: 'H100 80G SXM',
        qty: 6,
        minQty: 1,
        price: 235000,
        priceUnit: '台',
        supply: '现货',
        tax: '含专票',
        city: '深圳',
        cond: '9 成新',
        deliver: '自提 / 物流',
        status: '在售',
        note: '整机 8 卡，可拆单，支持同台验收。',
        accept: '同台验收、原件比对',
        requirements: '提供采购凭证与序列号',
        limit: '',
        must: ['接受同台互验', '强主体（国企 / 央企）'],
        nego: ['价格可议', '可接受分批交付'],
        flow: ['提交咨询', '平台核对', '建三方企微群', '线下看货验机', '线下签约与付款'],
        heat: 0,
        createdAt: NOW - 2 * HOUR
      },
      {
        id: 'p2',
        ownerId: 'o_demo_user_2',
        tradeMode: '出售',
        side: 'supply',
        title: '华为昇腾 910B 训练服务器',
        cat: 'NPU 加速卡',
        brand: '华为昇腾',
        model: 'Atlas 800T A2',
        qty: 2,
        minQty: 1,
        price: 880000,
        priceUnit: '台',
        supply: '期货',
        tax: '含专票',
        city: '上海',
        cond: '全新',
        deliver: '物流',
        status: '在售',
        reviewedBy: 'auto',
        reviewedAt: NOW - 40 * 60 * 1000,
        note: '原厂质保，预计 3 周交付。',
        must: ['接受同台互验', '可提供采购意向函'],
        nego: ['交付周期可放宽'],
        flow: ['提交咨询', '平台核对', '建三方企微群', '线下看货验机', '线下签约与付款'],
        heat: 0,
        createdAt: NOW - 40 * 60 * 1000
      },
      {
        id: 'p3',
        ownerId: 'o_demo_user_2',
        tradeMode: '出售',
        side: 'supply',
        title: '华为 CE8850 交换机',
        cat: '网络设备',
        brand: '华为',
        model: 'CE8850-64CQ-EI',
        qty: 4,
        minQty: 1,
        price: 32000,
        priceUnit: '台',
        supply: '现货',
        tax: '不含票',
        city: '杭州',
        cond: '8 成新',
        deliver: '自提',
        status: '已下架',
        note: '机房退租，整批出。',
        must: ['接受同台互验'],
        nego: ['价格可议'],
        flow: ['提交咨询', '平台核对', '建三方企微群', '线下看货验机', '线下签约与付款'],
        heat: 0,
        createdAt: NOW - 6 * DAY
      },
      {
        id: 'p4',
        ownerId: 'o_demo_user_1',
        tradeMode: '出租',
        side: 'supply',
        title: 'A100 40G 服务器出租（按月起租）',
        cat: 'GPU 服务器',
        brand: 'NVIDIA',
        model: 'A100 40G PCIe',
        qty: 8,
        minQty: 1,
        price: 9000,
        priceUnit: '台/月',
        supply: '现货',
        tax: '含专票',
        city: '深圳',
        cond: '9 成新',
        deliver: '当日可起租',
        status: '在售',
        term: ['1 个月', '3 个月', '6 个月'],
        closed: '闭口价（不议价）',
        deposit: '1 个月租金',
        pay: '月付',
        rentLimits: ['不得转租或二次转让', '用途仅限训练 / 推理等合规业务'],
        must: ['接受同台互验', '接受签署租赁意向协议', '接受按期预付租金'],
        nego: ['租金可议', '租期可议'],
        flow: ['提交咨询', '平台核对', '建三方企微群', '远程接入联调', '线下签约与付款'],
        note: '机房位于深圳南山，含基础运维。',
        heat: 0,
        createdAt: NOW - 3 * DAY
      },
      {
        id: 'p5',
        ownerId: 'o_demo_user_1',
        tradeMode: '出售',
        side: 'supply',
        title: 'RTX 5090 32G 显卡整批（草稿）',
        cat: 'GPU 加速卡',
        brand: 'NVIDIA',
        model: 'RTX 5090',
        qty: 20,
        minQty: 1,
        price: 26000,
        priceUnit: '台',
        supply: '现货',
        tax: '含专票',
        city: '深圳',
        cond: '全新',
        deliver: '3 天内',
        status: '草稿',
        must: ['接受同台互验'],
        nego: [],
        flow: ['提交咨询', '平台核对', '建三方企微群'],
        heat: 0,
        createdAt: NOW - 90 * 60 * 1000
      },
      {
        id: 'p6',
        ownerId: 'o_demo_user_2',
        tradeMode: '出售',
        side: 'supply',
        title: 'GB300 NVL72 超节点（已上架）',
        cat: 'GPU 服务器',
        brand: 'NVIDIA',
        model: 'GB300 NVL72',
        qty: 1,
        minQty: 1,
        price: 2800000,
        priceUnit: '台',
        supply: '期货',
        tax: '含专票',
        city: '上海',
        cond: '全新',
        deliver: '45 天内',
        status: '在售',
        reviewedBy: 'auto',
        reviewedAt: NOW - 60 * 60 * 1000,
        must: ['接受同台互验', '可提供采购意向函'],
        nego: [],
        flow: ['提交咨询', '平台核对', '建三方企微群'],
        heat: 0,
        createdAt: NOW - 60 * 60 * 1000
      }
    ],
    demands: [
      {
        id: 'd1',
        ownerId: 'o_demo_user_2',
        tradeMode: '求购',
        side: 'demand',
        title: '求购 8 台 H100 80G 整机',
        cat: 'GPU 服务器',
        brand: 'NVIDIA',
        model: 'H100 80G',
        qty: 8,
        budget: 228000,
        budgetUnit: '台',
        supply: '现货',
        tax: '含专票',
        city: '上海',
        cond: '9 成新以上',
        status: '求购中',
        must: ['接受同台互验', '提供设备实拍图片', '提供设备实拍视频'],
        sameMachine: true,
        codeAsk: true,
        note: '需 7 天内交付，接受分两批。',
        responses: 1,
        createdAt: NOW - 5 * HOUR
      },
      {
        id: 'd2',
        ownerId: 'o_demo_user_1',
        tradeMode: '租赁',
        side: 'demand',
        title: '求租 A100 40G × 4 台',
        cat: 'GPU 服务器',
        brand: 'NVIDIA',
        model: 'A100 40G',
        qty: 4,
        budget: 9500,
        budgetUnit: '台/月',
        supply: '现货',
        tax: '含专票',
        city: '深圳',
        cond: '不限',
        status: '求购中',
        must: ['明确租金 / 租期 / 押金条款', '接受同台互验', '提供设备实拍图片'],
        note: '先租 3 个月，可续租。',
        responses: 0,
        createdAt: NOW - 2 * DAY
      },
      {
        id: 'd3',
        ownerId: 'o_demo_user_2',
        tradeMode: '求购',
        side: 'demand',
        title: '求购 2 台昇腾 910B',
        cat: 'NPU 加速卡',
        brand: '华为昇腾',
        model: '910B',
        qty: 2,
        budget: 850000,
        budgetUnit: '台',
        supply: '期货',
        tax: '含专票',
        city: '北京',
        cond: '全新',
        status: '已关闭',
        must: [],
        note: '已从其他渠道采购。',
        responses: 0,
        createdAt: NOW - 10 * DAY
      },
      {
        id: 'd4',
        ownerId: 'o_demo_user_1',
        tradeMode: '求购',
        side: 'demand',
        title: '求购 100 台 RTX 5090（已上架）',
        cat: 'GPU 加速卡',
        brand: 'NVIDIA',
        model: 'RTX 5090',
        qty: 100,
        budget: 26000,
        budgetUnit: '台',
        supply: '现货',
        tax: '含专票',
        city: '深圳',
        cond: '全新',
        status: '求购中',
        reviewedBy: 'auto',
        reviewedAt: NOW - 80 * 60 * 1000,
        must: ['接受同台互验', '提供设备实拍图片'],
        sameMachine: true,
        codeAsk: true,
        note: '可接受分批交付。',
        responses: 0,
        createdAt: NOW - 80 * 60 * 1000
      }
    ],
    /* 我的库存：仅用于商机匹配，不对外展示；两位演示用户都放足可匹配的型号 */
    stocks: [
      {
        id: 'sk_demo_1', ownerId: 'o_demo_user_1',
        cat: 'GPU 服务器', brand: 'NVIDIA', model: 'H100 80G SXM',
        qty: 8, minQty: 2, price: 230000, unit: '元 / 台',
        city: '深圳', cond: '9 成新', note: '现货整机，可拆单',
        status: '在售', at: NOW - 6 * HOUR, updatedAt: NOW - 6 * HOUR, deleted: false
      },
      {
        id: 'sk_demo_2', ownerId: 'o_demo_user_1',
        cat: 'NPU 加速卡', brand: '华为昇腾', model: '910B',
        qty: 2, minQty: 1, price: 870000, unit: '元 / 台',
        city: '深圳', cond: '全新', note: '原厂质保',
        status: '在售', at: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY, deleted: false
      },
      {
        id: 'sk_demo_3', ownerId: 'o_demo_user_2',
        cat: 'GPU 服务器', brand: 'NVIDIA', model: 'A100 40G PCIe',
        qty: 4, minQty: 1, price: 9500, unit: '元 / 台 / 月',
        city: '上海', cond: '9 成新', note: '可按月续租',
        status: '在售', at: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY, deleted: false
      },
      {
        id: 'sk_demo_4', ownerId: 'o_demo_user_2',
        cat: 'GPU 加速卡', brand: 'NVIDIA', model: 'RTX 5090',
        qty: 120, minQty: 10, price: 25500, unit: '元 / 张',
        city: '上海', cond: '全新', note: '整批现货，支持分批',
        status: '在售', at: NOW - 20 * HOUR, updatedAt: NOW - 20 * HOUR, deleted: false
      }
    ],
    /* 代采 / 代售委托：覆盖已上架、待审核、大额保密、已驳回四种状态 */
    agencies: [
      {
        id: 'ag_demo_1', ownerId: 'o_demo_user_1', ownerNick: '张工 · 深圳',
        side: 'sell', kind: '代售', mode: '出售', rental: false, term: '',
        item: 'NVIDIA A100 80G SXM', itemCat: 'GPU 加速卡', brand: 'NVIDIA',
        city: '深圳', qty: 4, price: 128000, amount: 512000,
        serviceFee: 2560, upfront: 0, payNow: 0,
        feeRule: '100 万 – 1000 万元：0.5%（成交后支付）', feeNote: '成交后支付服务费',
        deferredFee: true, largeAmount: false,
        visibility: 'public', exposure: 'hidden', bizPool: true,
        authPhoneMatched: true, materialVerified: true,
        detail: '整批 4 张，原厂质保，支持同台验收。',
        subjectType: '企业', subjectMasked: '深圳**科技有限公司',
        phoneMasked: '138****8000', legalMasked: '张*',
        creditMasked: '9144****8X', idCardMasked: '4403**********1234',
        media: [
          { name: '营业执照.pdf', kind: 'license' },
          { name: '货源证明.pdf', kind: 'proof' },
          { name: '委托授权书.pdf', kind: 'authorization' }
        ],
        status: '已上架', staff: '客服坐席',
        createdAt: NOW - 5 * DAY, updatedAt: NOW - 2 * DAY,
        confirmedAt: NOW - 2 * DAY, expiresAt: NOW + 28 * DAY, deleted: false
      },
      {
        id: 'ag_demo_2', ownerId: 'o_demo_user_2', ownerNick: '李经理 · 上海',
        side: 'buy', kind: '代采', mode: '求购', rental: false, term: '',
        item: 'NVIDIA GB300 NVL72 超节点', itemCat: 'GPU 服务器', brand: 'NVIDIA',
        city: '上海', qty: 1, price: 12800000, amount: 12800000,
        serviceFee: 64000, upfront: 0, payNow: 0,
        feeRule: '1000 万元及以上：成交后按 0.5% 收取',
        feeNote: '提交采购意向函、委托授权书、联系人身份证，平台核验后上架；订单只对平台可见；成交后支付 0.5% 服务费',
        deferredFee: true, largeAmount: true,
        visibility: 'private', exposure: 'hidden', bizPool: false,
        authPhoneMatched: true, materialVerified: false,
        detail: '需原厂质保与序列号，45 天内交付。',
        subjectType: '企业', subjectMasked: '上海**供应链有限公司',
        phoneMasked: '139****2233', legalMasked: '李*',
        creditMasked: '9131****6Y', idCardMasked: '3101**********5678',
        media: [
          { name: '采购意向函.pdf', kind: 'loi' },
          { name: '委托授权书.pdf', kind: 'authorization' },
          { name: '联系人身份证.jpg', kind: 'idcard' }
        ],
        status: '待审核', staff: '',
        createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY,
        confirmedAt: 0, expiresAt: 0, deleted: false
      },
      {
        id: 'ag_demo_3', ownerId: 'o_demo_user_1', ownerNick: '张工 · 深圳',
        side: 'sell', kind: '代售', mode: '出售', rental: false, term: '',
        item: 'NVIDIA H200 141G SXM', itemCat: 'GPU 加速卡', brand: 'NVIDIA',
        city: '深圳', qty: 8, price: 245000, amount: 1960000,
        serviceFee: 9800, upfront: 0, payNow: 0,
        feeRule: '100 万 – 1000 万元：0.5%（成交后支付）', feeNote: '成交后支付服务费',
        deferredFee: true, largeAmount: false,
        visibility: 'public', exposure: 'open', bizPool: true,
        authPhoneMatched: true, materialVerified: true,
        detail: '8 张整批，含原厂包装与采购凭证。',
        subjectType: '企业', subjectMasked: '深圳**科技有限公司',
        phoneMasked: '138****8000', legalMasked: '张*',
        creditMasked: '9144****8X', idCardMasked: '4403**********1234',
        media: [
          { name: '营业执照.pdf', kind: 'license' },
          { name: '货源证明.pdf', kind: 'proof' }
        ],
        status: '已上架', staff: '客服坐席',
        createdAt: NOW - 8 * DAY, updatedAt: NOW - 6 * DAY,
        confirmedAt: NOW - 6 * DAY, expiresAt: NOW + 24 * DAY, deleted: false
      },
      {
        id: 'ag_demo_4', ownerId: 'o_demo_user_2', ownerNick: '李经理 · 上海',
        side: 'buy', kind: '代采', mode: '求购', rental: false, term: '',
        item: 'NVIDIA H100 80G SXM', itemCat: 'GPU 服务器', brand: 'NVIDIA',
        city: '上海', qty: 6, price: 232000, amount: 1392000,
        serviceFee: 6960, upfront: 0, payNow: 0,
        feeRule: '100 万 – 1000 万元：0.5%（成交后支付）', feeNote: '成交后支付服务费',
        deferredFee: true, largeAmount: false,
        visibility: 'public', exposure: 'open', bizPool: true,
        authPhoneMatched: true, materialVerified: true,
        detail: '6 台整机，7 天内交付，接受分两批。',
        subjectType: '企业', subjectMasked: '上海**供应链有限公司',
        phoneMasked: '139****2233', legalMasked: '李*',
        creditMasked: '9131****6Y', idCardMasked: '3101**********5678',
        media: [
          { name: '采购意向函.pdf', kind: 'loi' },
          { name: '委托授权书.pdf', kind: 'authorization' }
        ],
        status: '已上架', staff: '客服坐席',
        createdAt: NOW - 9 * DAY, updatedAt: NOW - 7 * DAY,
        confirmedAt: NOW - 7 * DAY, expiresAt: NOW + 23 * DAY, deleted: false
      },
      {
        id: 'ag_demo_5', ownerId: 'o_demo_user_1', ownerNick: '张工 · 深圳',
        side: 'buy', kind: '代采', mode: '求购', rental: false, term: '',
        item: '华为昇腾 910B 训练服务器', itemCat: 'NPU 加速卡', brand: '华为昇腾',
        city: '深圳', qty: 2, price: 860000, amount: 1720000,
        serviceFee: 8600, upfront: 0, payNow: 0,
        feeRule: '100 万 – 1000 万元：0.5%（成交后支付）', feeNote: '成交后支付服务费',
        deferredFee: true, largeAmount: false,
        visibility: 'public', exposure: 'hidden', bizPool: true,
        authPhoneMatched: false, materialVerified: false,
        detail: '资料不全，等待补充委托授权书。',
        subjectType: '企业', subjectMasked: '深圳**科技有限公司',
        phoneMasked: '138****8000', legalMasked: '张*',
        creditMasked: '9144****8X', idCardMasked: '4403**********1234',
        media: [{ name: '营业执照.pdf', kind: 'license' }],
        status: '已驳回', reason: '委托授权书缺失，请补齐后重新提交', staff: '平台管理员',
        createdAt: NOW - 4 * DAY, updatedAt: NOW - 2 * DAY,
        confirmedAt: 0, expiresAt: 0, deleted: false
      }
    ],
    /* 已被领取的商机：用于验证「已有 N 家领取」与联系方式可见口径 */
    bizClaims: [
      { id: 'bc_demo_1', uid: 'o_demo_user_1', targetType: 'demand', targetId: 'd1', at: NOW - 1 * DAY },
      { id: 'bc_demo_2', uid: 'o_demo_user_2', targetType: 'demand', targetId: 'd2', at: NOW - 2 * HOUR }
    ],
    leads: [
      {
        id: 'l1',
        uid: 'o_demo_user_2',
        productId: 'p1',
        demandId: '',
        source: '小程序咨询',
        formSummary: '需 2 台 H100，深圳自提，本周内可签',
        compare: [
          { n: '成色', req: '9 成新以上', filled: '9 成新', res: '满足' },
          { n: '交付', req: '现货', filled: '现货', res: '满足' },
          { n: '城市', req: '深圳', filled: '深圳', res: '一致' }
        ],
        matchPct: 86,
        status: '待分配',
        tier: 'P2',
        tierName: '优先',
        assignedTo: '',
        contactReleased: false,
        createdAt: NOW - 8 * 60 * 1000
      },
      {
        id: 'l2',
        productId: '',
        demandId: 'd1',
        source: '小程序咨询',
        formSummary: '可提供 8 台 H100，含专票，7 天内交付',
        compare: [
          { n: '数量', req: '8 台', filled: '8 台', res: '满足' },
          { n: '交付', req: '7 天内', filled: '5 天内', res: '满足' },
          { n: '城市', req: '上海', filled: '深圳', res: '不同城市' }
        ],
        matchPct: 92,
        status: '跟进中',
        tier: 'P2',
        tierName: '优先',
        assignedTo: '坐席 A · 周敏',
        assignedAccount: 'cs',
        assignedAt: NOW - 2 * HOUR,
        contactReleased: false,
        createdAt: NOW - 2 * HOUR
      },
      {
        id: 'l3',
        productId: 'p4',
        demandId: '',
        source: '小程序咨询',
        formSummary: '租 4 台 A100，先签 3 个月',
        compare: [
          { n: '租期', req: '3 个月', filled: '3 个月', res: '满足' },
          { n: '用途', req: '训练', filled: '训练', res: '一致' }
        ],
        matchPct: 78,
        status: '已对接',
        tier: '默认',
        tierName: '',
        assignedTo: '坐席 A · 周敏',
        assignedAccount: 'cs',
        assignedAt: NOW - 1 * DAY,
        contactReleased: true,
        createdAt: NOW - 1 * DAY
      },
      {
        id: 'l4',
        productId: 'p1',
        demandId: '',
        source: '小程序咨询',
        formSummary: '咨询说明含联系方式，命中 P0 规则已被拦截',
        compare: [],
        matchPct: 0,
        status: '已拦截',
        tier: 'P0',
        tierName: '拦截',
        assignedTo: '',
        contactReleased: false,
        createdAt: NOW - 4 * HOUR
      },
      {
        id: 'l5',
        uid: 'o_demo_user_2',
        productId: '',
        demandId: 'd2',
        source: '求购响应',
        formSummary: '可提供 4 台 A100，深圳机柜直租，可按月续',
        compare: [
          { n: '数量', req: '4 台', filled: '4 台', res: '满足' },
          { n: '城市', req: '深圳', filled: '深圳', res: '一致' }
        ],
        matchPct: 88,
        status: '待分配',
        tier: 'P1',
        tierName: '高匹配',
        assignedTo: '',
        contactReleased: false,
        createdAt: NOW - 90 * 60 * 1000
      }
    ],
    rules: [
      {
        id: 'r1',
        name: '咨询说明出现手机号 / 微信号',
        type: 'word',
        scope: 'global',
        scopeKey: '',
        cond: { blockedWords: ['手机号', '微信'] },
        tier: 'P0',
        enabled: true,
        version: 3,
        hitCount: 12,
        note: '咨询文本里带联系方式的一律拦截',
        createdAt: NOW - 30 * DAY
      },
      {
        id: 'r2',
        name: '同行套取联系方式',
        type: 'category',
        scope: 'category',
        scopeKey: 'GPU 服务器',
        cond: { cat: 'GPU 服务器' },
        tier: 'P1',
        enabled: true,
        version: 2,
        hitCount: 5,
        note: 'GPU 服务器品类统一标红待核',
        createdAt: NOW - 20 * DAY
      },
      {
        id: 'r3',
        name: '多地同 IP 重复咨询',
        type: 'repeat',
        scope: 'global',
        scopeKey: '',
        cond: { maxPerDay: 5 },
        tier: '默认',
        enabled: false,
        version: 1,
        hitCount: 2,
        note: '24 小时内超过 5 次只记录',
        createdAt: NOW - 12 * DAY
      },
      {
        id: 'r4',
        name: '黑名单手机号',
        type: 'phone',
        scope: 'global',
        scopeKey: '',
        /* 只落盲索引与打码号码，明文号码不出规则表 */
        cond: { blockedPhoneBidx: [], blockedPhones: ['138****8000'] },
        tier: 'P0',
        enabled: true,
        version: 1,
        hitCount: 0,
        note: '演示种子：需在规则页新增/编辑后才会写入真实盲索引',
        createdAt: NOW - 2 * DAY
      }
    ],
    blocked: [
      {
        id: 'b1',
        leadId: 'l4',
        ruleId: 'r1',
        reason: '咨询说明包含手机号，命中 P0 拦截',
        at: NOW - 4 * HOUR,
        reviewDeadline: NOW + 20 * HOUR
      }
    ],
    outbox: [
      {
        id: 'M1001',
        type: 'kf.chat',
        payload: {
          uid: 'o_demo_user_1',
          channel: 'kf',
          from: 'user',
          title: '平台客服',
          body: 'H100 还有货吗？能开专票吗？'
        },
        status: 'pending',
        readByUser: true,
        readByStaff: false,
        createdAt: NOW - 6 * 60 * 1000
      },
      {
        id: 'M1002',
        type: 'kf.chat',
        payload: {
          uid: 'o_demo_user_1',
          channel: 'kf',
          from: 'staff',
          staffName: '客服坐席',
          title: '客服回复',
          body: '您好，现货 6 台，支持专票。确认数量和交付城市后我帮您对接货主。'
        },
        status: 'pending',
        readByUser: true,
        readByStaff: true,
        createdAt: NOW - 5 * 60 * 1000
      },
      {
        id: 'M1003',
        type: 'kf.chat',
        payload: {
          uid: 'o_demo_user_2',
          channel: 'kf',
          from: 'user',
          title: '平台客服',
          body: 'A100 出租最短租期是多久？可以按月续吗？'
        },
        status: 'pending',
        readByUser: true,
        readByStaff: false,
        createdAt: NOW - 20 * 60 * 1000
      },
      /* 用户直聊（channel = direct）：管理端消息中心「用户直聊」Tab 的演示数据 */
      {
        id: 'M2001',
        type: 'direct.chat',
        payload: {
          uid: 'o_demo_user_2', channel: 'direct', from: 'me',
          peerUid: 'o_demo_user_1', peerName: '张工 · 深圳',
          threadId: 'l1', leadId: 'l1', targetType: 'product', targetId: 'p1',
          title: 'NVIDIA H100 80G 整机（8 卡）',
          body: '这台 H100 能拆成 4 卡卖吗？我想先要 2 台试试。'
        },
        status: 'read',
        readByUser: true,
        createdAt: NOW - 55 * 60 * 1000
      },
      {
        id: 'M2002',
        type: 'direct.chat',
        payload: {
          uid: 'o_demo_user_1', channel: 'direct', from: 'peer',
          peerUid: 'o_demo_user_2', peerName: '李经理 · 上海',
          threadId: 'l1', leadId: 'l1', targetType: 'product', targetId: 'p1',
          title: 'NVIDIA H100 80G 整机（8 卡）',
          body: '整机优先出，拆单要等整机没人要才行，可以先报个价。'
        },
        status: 'read',
        readByUser: true,
        createdAt: NOW - 50 * 60 * 1000
      },
      {
        id: 'M2003',
        type: 'direct.chat',
        payload: {
          uid: 'o_demo_user_2', channel: 'direct', from: 'me',
          peerUid: 'o_demo_user_1', peerName: '张工 · 深圳',
          threadId: 'l1', leadId: 'l1', targetType: 'product', targetId: 'p1',
          title: 'NVIDIA H100 80G 整机（8 卡）',
          body: '2 台 46 万，含专票，能在深圳同台验收我就要。',
          /* 演示监管脱敏：正文含手机号时管理端只显示中间四位打码 */
        },
        status: 'read',
        readByUser: true,
        createdAt: NOW - 42 * 60 * 1000
      },
      {
        id: 'M2004',
        type: 'direct.chat',
        payload: {
          uid: 'o_demo_user_1', channel: 'direct', from: 'me',
          peerUid: 'o_demo_user_2', peerName: '李经理 · 上海',
          threadId: 'l5', leadId: 'l5', targetType: 'demand', targetId: 'd2',
          title: '求租 A100 40G × 4 台',
          body: 'A100 我这有 4 台闲置，可以按月续，押一付一。'
        },
        status: 'read',
        readByUser: true,
        createdAt: NOW - 26 * 60 * 1000
      },
      {
        id: 'M2005',
        type: 'direct.chat',
        payload: {
          uid: 'o_demo_user_2', channel: 'direct', from: 'peer',
          peerUid: 'o_demo_user_1', peerName: '张工 · 深圳',
          threadId: 'l5', leadId: 'l5', targetType: 'demand', targetId: 'd2',
          title: '求租 A100 40G × 4 台',
          body: '机柜在哪个机房？能远程接入先测一下吗？'
        },
        status: 'read',
        readByUser: true,
        createdAt: NOW - 18 * 60 * 1000
      }
    ],
    /* 主体资料：含资质原件 fileId，供管理端「资质原件核验」验收 */
    profiles: [
      {
        id: 'o_demo_user_1', uid: 'o_demo_user_1',
        subjectType: '企业', city: '深圳',
        exposure: 'open',
        quals: [
          { name: '营业执照', kind: 'license', fileId: 'https://placehold.co/900x600/png?text=Business+License', status: '已核验', verifiedAt: NOW - 2 * DAY },
          { name: '法定代表人身份证', kind: 'legal', fileId: 'https://placehold.co/900x600/png?text=Legal+ID', status: '待核验' }
        ],
        joined: '2025-08-12',
        createdAt: NOW - 90 * DAY,
        updatedAt: NOW - 2 * DAY
      },
      {
        id: 'o_demo_user_2', uid: 'o_demo_user_2',
        subjectType: '企业', city: '上海',
        exposure: 'open',
        quals: [
          { name: '营业执照', kind: 'license', fileId: 'https://placehold.co/900x600/png?text=License+Rejected', status: '已驳回' }
        ],
        joined: '2025-09-03',
        createdAt: NOW - 70 * DAY,
        updatedAt: NOW - 1 * DAY
      }
    ],
    accounts: [],
    sessions: [],
    counters: [],
    audit: [],
    files: [],
    ...demoTelemetry(NOW),
    ...demoOps(NOW)
  }
}

/**
 * P0 数据底座演示种子：会员流水 / 收款流水 / 日快照 / 风险单 / 日志 / 角色权限。
 * 保证本地启动后财务中心、风险四类视图、系统日志、角色配置都有可验收的数据。
 */
function demoOps(base) {
  const at = Number(base) || Date.now()
  const day = (n) => at - n * DAY
  return {
    bizAccess: [
      {
        id: 'o_demo_user_1', uid: 'o_demo_user_1', status: '已开通',
        plan: 268, planKey: 'quarter', planLabel: '季度', days: 90,
        appliedAt: day(20), expireAt: day(20) + 90 * DAY, updatedAt: day(20),
        staff: '客服坐席', note: '季度续费'
      },
      {
        id: 'o_demo_user_2', uid: 'o_demo_user_2', status: '已开通',
        plan: 899, planKey: 'year', planLabel: '年度', days: 365,
        appliedAt: day(200), expireAt: day(200) + 365 * DAY, updatedAt: day(200),
        staff: '平台管理员', note: '年度会员（即将到期）'
      }
    ],
    bizOrders: [
      {
        id: 'BO_DEMO_1', uid: 'o_demo_user_1', nick: '张工 · 深圳',
        planKey: 'quarter', planLabel: '季度', days: 90,
        original: 297, discount: 29, amount: 268,
        startAt: day(20), expireAt: day(20) + 90 * DAY,
        method: '企业微信', paymentId: 'PY_DEMO_1', operator: '客服坐席', accountId: 'cs',
        note: '季度续费', createdAt: day(20)
      },
      {
        id: 'BO_DEMO_2', uid: 'o_demo_user_2', nick: '李经理 · 上海',
        planKey: 'year', planLabel: '年度', days: 365,
        original: 1188, discount: 289, amount: 899,
        startAt: day(200), expireAt: day(200) + 365 * DAY,
        method: '对公转账', paymentId: 'PY_DEMO_2', operator: '平台管理员', accountId: 'admin',
        note: '年度会员', createdAt: day(200)
      },
      {
        id: 'BO_DEMO_3', uid: 'o_demo_user_2', nick: '李经理 · 上海',
        planKey: 'month', planLabel: '月度', days: 30,
        original: 99, discount: 0, amount: 99,
        startAt: day(170), expireAt: day(170) + 30 * DAY,
        method: '微信转账', paymentId: '', operator: '客服坐席', accountId: 'cs',
        note: '首次开通月度', createdAt: day(170)
      }
    ],
    payments: [
      {
        id: 'PY_DEMO_1', uid: 'o_demo_user_1', nick: '张工 · 深圳',
        bizType: '会员续费', planKey: 'quarter', planLabel: '季度', days: 90,
        amount: 297, discount: 29, received: 268, method: '企业微信',
        status: '已确认', paidAt: day(20), confirmedAt: day(20),
        operator: '客服坐席', confirmedBy: '平台管理员', orderId: 'BO_DEMO_1',
        note: '企微转账，季度优惠 29 元', voucher: '', createdAt: day(20), updatedAt: day(20)
      },
      {
        id: 'PY_DEMO_2', uid: 'o_demo_user_2', nick: '李经理 · 上海',
        bizType: '会员续费', planKey: 'year', planLabel: '年度', days: 365,
        amount: 1188, discount: 289, received: 899, method: '对公转账',
        status: '已确认', paidAt: day(200), confirmedAt: day(200),
        operator: '平台管理员', confirmedBy: '平台管理员', orderId: 'BO_DEMO_2',
        note: '对公到账，年度套餐', voucher: '', createdAt: day(200), updatedAt: day(200)
      },
      {
        id: 'PY_DEMO_3', uid: 'o_demo_user_1', nick: '张工 · 深圳',
        bizType: '会员续费', planKey: 'month', planLabel: '月度', days: 30,
        amount: 99, discount: 0, received: 99, method: '企业微信',
        status: '待确认', paidAt: day(1) + 3 * HOUR, confirmedAt: 0,
        operator: '客服坐席', confirmedBy: '', orderId: '',
        note: '用户已转账，待财务确认', voucher: '', createdAt: day(1) + 3 * HOUR, updatedAt: day(1) + 3 * HOUR
      },
      {
        id: 'PY_DEMO_4', uid: 'o_demo_user_2', nick: '李经理 · 上海',
        bizType: '代售服务费', planKey: '', planLabel: '', days: 0,
        amount: 199, discount: 0, received: 199, method: '微信转账',
        status: '已退款', paidAt: day(40), confirmedAt: day(40),
        operator: '客服坐席', confirmedBy: '平台管理员', orderId: '',
        note: '代售未成交，按约退款', voucher: '', createdAt: day(40), updatedAt: day(38)
      }
    ],
    dailyStats: Array.from({ length: 14 }).map((_, index) => {
      const offset = 13 - index
      const date = dayKeyText(day(offset))
      return {
        id: 'ds_' + date,
        date,
        dau: 42 + ((index * 7) % 23),
        newUsers: 3 + (index % 4),
        products: 2 + (index % 3),
        demands: 1 + (index % 2),
        leads: 4 + (index % 5),
        matched: 1 + (index % 3),
        deals: index % 2,
        orders: index % 3 === 0 ? 1 : 0,
        revenue: index % 3 === 0 ? 99 : 0,
        updatedAt: day(offset)
      }
    }),
    riskCases: [
      {
        id: 'RC_DEMO_1', fingerprint: '商品|contact_in_text|p1',
        type: '商品', level: '中', ruleCode: 'contact_in_text', ruleLabel: '疑似联系方式',
        targetId: 'p1', targetLabel: 'NVIDIA H100 80G 整机（8 卡）', uid: 'o_demo_user_1',
        detail: '备注中出现疑似手机号', status: '待处理', owner: '', action: '', reason: '',
        createdAt: day(2), updatedAt: day(2)
      },
      {
        id: 'RC_DEMO_2', fingerprint: '用户|user_no_license|o_demo_user_2',
        type: '用户', level: '低', ruleCode: 'user_no_license', ruleLabel: '资质未上传',
        targetId: 'o_demo_user_2', targetLabel: '李经理 · 上海', uid: 'o_demo_user_2',
        detail: '未上传营业执照', status: '处理中', owner: '客服坐席', action: '已通知补件', reason: '',
        createdAt: day(3), updatedAt: day(1)
      },
      {
        id: 'RC_DEMO_3', fingerprint: '咨询|consult_contact|l4',
        type: '咨询', level: '中', ruleCode: 'consult_contact', ruleLabel: '咨询含联系方式',
        targetId: 'l4', targetLabel: '咨询单 l4', uid: 'o_demo_user_1',
        detail: '咨询内容疑似包含手机号', status: '已处理', owner: '客服坐席', action: '已拦截并提醒', reason: '引导走平台对接',
        createdAt: day(4), updatedAt: day(3)
      },
      {
        id: 'RC_DEMO_4', fingerprint: '系统|system_payment_pending|PY_DEMO_3',
        type: '系统', level: '中', ruleCode: 'system_payment_pending', ruleLabel: '收款待确认超时',
        targetId: 'PY_DEMO_3', targetLabel: '收款单 PY_DEMO_3', uid: 'o_demo_user_1',
        detail: '收款单超过 3 天仍未财务确认', status: '待处理', owner: '', action: '', reason: '',
        createdAt: day(1), updatedAt: day(1)
      }
    ],
    systemLogs: [
      {
        id: 'LG_DEMO_1', level: 'error', scope: '管理端接口', action: 'stats.trend',
        message: '聚合趋势失败：dailyStats 快照读取超时', detail: 'TimeoutError: read snapshot > 3000ms',
        actor: 'admin', ip: '10.0.0.8', at: day(1) + 2 * HOUR
      },
      {
        id: 'LG_DEMO_2', level: 'warn', scope: '用户端接口', action: 'contact.reveal',
        message: '未对接状态下请求联系方式，已拒绝', detail: 'FORBIDDEN lead.status=跟进中',
        actor: 'o_demo_user_2', ip: '10.0.0.9', at: day(2) + 5 * HOUR
      },
      {
        id: 'LG_DEMO_3', level: 'info', scope: '管理端接口', action: 'payment.confirm',
        message: '收款确认成功，已自动开通季度套餐', detail: 'PY_DEMO_1 → BO_DEMO_1',
        actor: 'admin', ip: '10.0.0.8', at: day(20)
      }
    ],
    loginLogs: [
      { id: 'LL_DEMO_1', username: 'admin', role: 'admin', ip: '10.0.0.8', result: 'allow', reason: '', at: day(0) + 1 * HOUR },
      { id: 'LL_DEMO_2', username: 'cs', role: 'cs', ip: '10.0.0.9', result: 'allow', reason: '', at: day(0) + 2 * HOUR },
      { id: 'LL_DEMO_3', username: 'cs', role: 'cs', ip: '10.0.0.9', result: 'deny', reason: '动态口令校验失败', at: day(1) + 9 * HOUR }
    ],
    roles: [
      {
        id: 'RL_DEMO_1', roleKey: 'ops', name: '运营专员',
        pages: ['workbench', 'stats', 'users', 'biz', 'risk', 'boards'],
        actions: ['biz.orders', 'payment.list', 'risk.cases', 'risk.caseUpdate', 'board.list'],
        status: 'active', createdAt: day(30), updatedAt: day(10)
      }
    ],
    accountPermissions: [
      {
        id: 'ap_cs', username: 'cs', extraPages: ['finance'], extraActions: ['finance.summary'],
        expiresAt: day(0) + 7 * DAY, status: 'active', note: '大促期间临时查看财务汇总',
        createdAt: day(2), updatedAt: day(2)
      }
    ],
    /* 用户行为记录：登录 / 发布 / 咨询 / 领取商机 / 浏览商品，90 天后清理 */
    userEvents: [
      { id: 'UE_DEMO_1', uid: 'o_demo_user_1', kind: 'login', label: '登录', page: '/pages/index/index', refId: '', title: '微信一键登录', at: day(0) + 2 * HOUR, day: dayKeyText(day(0)) },
      { id: 'UE_DEMO_2', uid: 'o_demo_user_1', kind: 'view_product', label: '浏览商品', page: '/pages/product/detail?id=p2', refId: 'p2', title: '华为昇腾 910B 训练服务器', at: day(0) + 90 * 60 * 1000, day: dayKeyText(day(0)) },
      { id: 'UE_DEMO_3', uid: 'o_demo_user_1', kind: 'publish_product', label: '发布商品', page: '/pages/publish/product', refId: 'p1', title: 'NVIDIA H100 80G 整机（8 卡）', at: day(2), day: dayKeyText(day(2)) },
      { id: 'UE_DEMO_4', uid: 'o_demo_user_1', kind: 'consult', label: '发起咨询', page: '/pages/consult/form', refId: 'l1', title: '咨询 NVIDIA H100 80G 整机（8 卡）', at: day(1), day: dayKeyText(day(1)) },
      { id: 'UE_DEMO_5', uid: 'o_demo_user_1', kind: 'agency_sell', label: '提交代售', page: '/pages/agency/create', refId: 'ag_demo_1', title: '代售 NVIDIA A100 80G SXM', at: day(4), day: dayKeyText(day(4)) },
      { id: 'UE_DEMO_6', uid: 'o_demo_user_1', kind: 'chat', label: '发起直聊', page: '/pages/msg/msg', refId: 'l1', title: '与李经理 · 上海直聊', at: day(0) + 55 * 60 * 1000, day: dayKeyText(day(0)) },
      { id: 'UE_DEMO_7', uid: 'o_demo_user_2', kind: 'login', label: '登录', page: '/pages/index/index', refId: '', title: '微信一键登录', at: day(0) + 3 * HOUR, day: dayKeyText(day(0)) },
      { id: 'UE_DEMO_8', uid: 'o_demo_user_2', kind: 'view_demand', label: '浏览需求', page: '/pages/demand/detail?id=d1', refId: 'd1', title: '求购 8 台 H100 80G 整机', at: day(0) + 80 * 60 * 1000, day: dayKeyText(day(0)) },
      { id: 'UE_DEMO_9', uid: 'o_demo_user_2', kind: 'claim', label: '领取商机', page: '/pages/lead/list', refId: 'l2', title: '领取商机：求购 8 台 H100 80G 整机', at: day(1) + 4 * HOUR, day: dayKeyText(day(1)) },
      { id: 'UE_DEMO_10', uid: 'o_demo_user_2', kind: 'publish_demand', label: '发布需求', page: '/pages/publish/demand', refId: 'd1', title: '求购 8 台 H100 80G 整机', at: day(5), day: dayKeyText(day(5)) },
      { id: 'UE_DEMO_11', uid: 'o_demo_user_2', kind: 'agency_buy', label: '提交代采', page: '/pages/agency/create', refId: 'ag_demo_2', title: '代采 GB300 NVL72 超节点', at: day(3), day: dayKeyText(day(3)) },
      { id: 'UE_DEMO_12', uid: 'o_demo_user_2', kind: 'favorite', label: '收藏', page: '/pages/product/detail?id=p1', refId: 'p1', title: '收藏 NVIDIA H100 80G 整机（8 卡）', at: day(1) + 30 * 60 * 1000, day: dayKeyText(day(1)) }
    ],
    /* 收藏 / 关注：管理端消息中心「收藏关注」Tab 与用户详情「收藏关注」共用 */
    favorites: [
      { id: 'fav_demo_1', uid: 'o_demo_user_2', targetType: 'product', targetId: 'p1', deleted: false, createdAt: day(1) + 30 * 60 * 1000, updatedAt: day(1) + 30 * 60 * 1000 },
      { id: 'fav_demo_2', uid: 'o_demo_user_2', targetType: 'product', targetId: 'p4', deleted: false, createdAt: day(2), updatedAt: day(2) },
      { id: 'fav_demo_3', uid: 'o_demo_user_1', targetType: 'demand', targetId: 'd1', deleted: false, createdAt: day(1), updatedAt: day(1) },
      { id: 'fav_demo_4', uid: 'o_demo_user_1', targetType: 'product', targetId: 'p2', deleted: false, createdAt: day(3), updatedAt: day(3) }
    ],
    follows: [
      { id: 'fol_demo_1', uid: 'o_demo_user_1', targetType: 'owner', targetKey: 'o_demo_user_2', nick: '李经理 · 上海', deleted: false, createdAt: day(2), updatedAt: day(2) },
      { id: 'fol_demo_2', uid: 'o_demo_user_2', targetType: 'owner', targetKey: 'o_demo_user_1', nick: '张工 · 深圳', deleted: false, createdAt: day(2) + 2 * HOUR, updatedAt: day(2) + 2 * HOUR }
    ]
  }
}

/** 东八区日期键：与 handlers 的 dayKeyOf 口径一致 */
function dayKeyText(ms) {
  const d = new Date(Number(ms) + 8 * 60 * 60 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/**
 * 行为数据中心的演示数据：截屏 / 录屏 / 复制联系方式、搜索词、管理操作与风控拦截。
 * 保证本地启动后「行为数据中心」不是空页，分类计数与筛选都可直接验收。
 */
function demoTelemetry(base) {
  const at = Number(base) || Date.now()
  return {
    behaviorEvents: [
      { id: 'beh_demo_1', kind: 'screenshot', page: '/pages/product/detail?id=p1', uid: 'o_demo_user_1', at: at - 18 * MINUTE },
      { id: 'beh_demo_2', kind: 'copy_contact', page: '/pages/product/detail?id=p1', uid: 'o_demo_user_1', at: at - 25 * MINUTE },
      { id: 'beh_demo_3', kind: 'screen_record', page: '/pages/product/detail?id=p2', uid: 'o_demo_user_2', at: at - 2 * HOUR },
      { id: 'beh_demo_4', kind: 'screenshot', page: '/pages/agency/detail?id=ag_demo_1', uid: 'o_demo_user_2', at: at - 5 * HOUR },
      { id: 'beh_demo_5', kind: 'save_attempt', page: '/pages/product/detail?id=p2', uid: 'o_demo_user_1', at: at - 9 * HOUR },
      { id: 'beh_demo_6', kind: 'copy_contact', page: '/pages/demand/detail?id=d1', uid: 'o_demo_user_2', at: at - 26 * HOUR }
    ],
    searchLogs: [
      { id: 'sl_demo_1', q: 'H100 80G 整机', scope: 'GPU 服务器', uidHash: 'o_demo_user_1', at: at - 12 * MINUTE },
      { id: 'sl_demo_2', q: 'A100 40G 出租', scope: 'GPU 服务器', uidHash: 'o_demo_user_2', at: at - 40 * MINUTE },
      { id: 'sl_demo_3', q: '昇腾 910B', scope: 'NPU 加速卡', uidHash: 'o_demo_user_1', at: at - 3 * HOUR },
      { id: 'sl_demo_4', q: '华为 CE8850 交换机', scope: '网络设备', uidHash: 'o_demo_user_2', at: at - 7 * HOUR },
      { id: 'sl_demo_5', q: '8 卡整机 现货', scope: 'GPU 服务器', uidHash: 'o_demo_user_1', at: at - 20 * HOUR },
      { id: 'sl_demo_6', q: '液冷机柜', scope: '机房配套', uidHash: 'o_demo_user_2', at: at - 2 * DAY },
      { id: 'sl_demo_7', q: '4090 服务器', scope: 'GPU 服务器', uidHash: 'o_demo_user_1', at: at - 3 * DAY }
    ],
    audit: [
      {
        id: 'audit_demo_1',
        actorType: 'admin',
        actorId: 'cs',
        action: 'lead.claim',
        target: 'l1',
        reason: '领取：未分配 → 客服坐席',
        result: 'allow',
        at: at - 8 * MINUTE
      },
      {
        id: 'audit_demo_2',
        actorType: 'admin',
        actorId: 'admin',
        action: 'lead.assign',
        target: 'l2',
        reason: '按资料齐全度优先对接：平台管理员',
        result: 'allow',
        at: at - 35 * MINUTE
      },
      {
        id: 'audit_demo_3',
        actorType: 'admin',
        actorId: 'cs',
        action: 'lead.updateStatus',
        target: 'l1',
        reason: '待分配 → 跟进中',
        result: 'allow',
        at: at - 1 * HOUR
      },
      {
        id: 'audit_demo_4',
        actorType: 'admin',
        actorId: 'admin',
        action: 'contact.reveal',
        target: 'l2',
        reason: '双方已建企微群，释放联系方式',
        result: 'allow',
        at: at - 2 * HOUR
      },
      {
        id: 'audit_demo_5',
        actorType: 'user',
        actorId: 'o_demo_user_1',
        action: 'agency.submit',
        target: 'ag_demo_1',
        reason: '代售 NVIDIA A100 80G SXM，资料待补',
        result: 'allow',
        at: at - 4 * HOUR
      },
      {
        id: 'audit_demo_6',
        actorType: 'admin',
        actorId: 'admin',
        action: 'product.review',
        target: 'p2',
        reason: '资质与序列号已核验，审核通过',
        result: 'allow',
        at: at - 6 * HOUR
      },
      {
        id: 'audit_demo_7',
        actorType: 'user',
        actorId: 'o_demo_user_2',
        action: 'contact.reveal',
        target: 'p2',
        reason: '未对接状态下尝试获取联系方式',
        result: 'FORBIDDEN',
        at: at - 10 * HOUR
      },
      {
        id: 'audit_demo_8',
        actorType: 'user',
        actorId: 'o_demo_user_1',
        action: 'product.submit',
        target: 'p1',
        reason: '提交 H100 整机审核',
        result: 'allow',
        at: at - 28 * HOUR
      }
    ]
  }
}

/** 演示种子里的「坐席 A · 周敏」统一映射到客服账号，避免出现已显示领取人却还能被领取 */
const DEMO_ASSIGNEE = { l2: 'cs', l3: 'cs' }

/** 已有本地状态里缺领取账号的历史数据补齐归属，保证「领取人」与「可领取」判断一致 */
function ensureLeadAssignments(state) {
  if (!Array.isArray(state.leads)) return state
  state.leads.forEach((lead) => {
    if (!lead || lead.assignedAccount || !lead.assignedTo) return
    const account = DEMO_ASSIGNEE[lead.id]
    if (!account) return
    lead.assignedAccount = account
    lead.assignedAt = lead.assignedAt || lead.createdAt || Date.now()
  })
  /* 直聊会话归属：老状态文件里 l1 / l5 没有发起人 uid，补上后才能正常打开会话 */
  state.leads.forEach((lead) => {
    if (lead && !lead.uid && (lead.id === 'l1' || lead.id === 'l5')) lead.uid = 'o_demo_user_2'
  })
  return state
}

/** 已有本地状态时补齐演示行为数据，保证老环境重启后行为中心不再空白 */
function ensureTelemetry(state) {
  const demo = demoTelemetry(Date.now())
  const merge = (key, marker) => {
    if (!Array.isArray(state[key])) state[key] = []
    if (!state[key].some((row) => String(row && row.id || '').startsWith(marker))) {
      state[key] = state[key].concat(demo[key])
    }
  }
  merge('behaviorEvents', 'beh_demo_')
  merge('searchLogs', 'sl_demo_')
  merge('audit', 'audit_demo_')
  return ensureOps(ensureLeadAssignments(state))
}

/** 老环境补齐 P0 演示数据：财务 / 风险 / 日志 / 角色页不再空白 */
function ensureOps(state) {
  const demo = demoOps(Date.now())
  const merge = (key, marker) => {
    if (!Array.isArray(state[key])) state[key] = []
    if (!state[key].some((row) => String(row && row.id || '').startsWith(marker))) {
      state[key] = state[key].concat(demo[key])
    }
  }
  merge('bizAccess', 'o_demo_user_')
  merge('bizOrders', 'BO_DEMO_')
  merge('payments', 'PY_DEMO_')
  merge('riskCases', 'RC_DEMO_')
  merge('systemLogs', 'LG_DEMO_')
  merge('loginLogs', 'LL_DEMO_')
  merge('roles', 'RL_DEMO_')
  merge('accountPermissions', 'ap_cs')
  merge('userEvents', 'UE_DEMO_')
  merge('favorites', 'fav_demo_')
  merge('follows', 'fol_demo_')
  /* 库存 / 代采代售 / 领取记录：老状态文件补齐，保证商机页与管理端页面都有数据 */
  const demoSeedRows = demoSeed()
  const mergeSeed = (key) => {
    if (!Array.isArray(state[key])) state[key] = []
    for (const row of demoSeedRows[key] || []) {
      if (!state[key].some((item) => item && item.id === row.id)) state[key].push(row)
    }
  }
  mergeSeed('stocks')
  mergeSeed('agencies')
  mergeSeed('bizClaims')
  /* 直聊演示消息：老状态文件里没有 channel=direct 时补齐 */
  if (!Array.isArray(state.outbox)) state.outbox = []
  if (!state.outbox.some((row) => String((row && row.id) || '').startsWith('M20'))) {
    state.outbox = state.outbox.concat(demoSeed().outbox.filter((row) => String(row.id || '').startsWith('M20')))
  }
  /* 资质演示资料：已有用户自建资料时不覆盖 */
  if (!Array.isArray(state.profiles)) state.profiles = []
  for (const row of demoSeed().profiles) {
    if (!state.profiles.some((item) => item && item.uid === row.uid)) state.profiles.push(row)
  }
  if (!Array.isArray(state.dailyStats)) state.dailyStats = []
  const seeded = new Set(state.dailyStats.map((row) => String(row && row.date || '')))
  for (const row of demo.dailyStats) if (!seeded.has(row.date)) state.dailyStats.push(row)
  return state
}

async function loadSeed() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return ensureTelemetry(parsed)
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.warn('[dev] 读取本地状态失败，使用演示种子：', err.message)
  }
  return demoSeed()
}

const seed = await loadSeed()
const repo = createMemoryRepo(seed)
/* 多级缓存：L1 进程内 + L2 Redis（REDIS_URL 未配置时自动只用 L1） */
const cache = createCache({ env: process.env, now: () => Date.now() })
const adminRouter = createRouter({ repo, keys, scope: 'admin', env: process.env, now: () => Date.now(), cache })
const userRouter = createRouter({
  repo,
  keys,
  scope: 'user',
  env: process.env,
  now: () => Date.now(),
  notify: async () => {},
  cache
})

let writeTimer = null
function persist() {
  if (writeTimer) return
  writeTimer = setTimeout(async () => {
    writeTimer = null
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true })
      await fsp.writeFile(STATE_FILE, JSON.stringify(repo._snapshot(), null, 2))
    } catch (err) {
      console.warn('[dev] 状态落盘失败：', err.message)
    }
  }, 120)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function serveStatic(req, res, pathname) {
  /* 畸形百分号编码（如 GET /%）不能让进程抛出未捕获异常 */
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Bad Request')
    return
  }
  if (rel === '/' || rel === '') rel = '/admin/index.html'
  if (rel === '/admin' || rel === '/admin/') rel = '/admin/index.html'
  const target = path.resolve(PROTOTYPE_DIR, '.' + rel)
  if (!target.startsWith(PROTOTYPE_DIR + path.sep) && target !== PROTOTYPE_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }
  const ext = path.extname(target).toLowerCase()
  if (!MIME[ext]) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  try {
    const stat = await fsp.stat(target)
    if (!stat.isFile()) throw new Error('not a file')
    /* 文本资源走 gzip：admin.js + data.js + app.css 合计 368KB，压缩后约 1/4 */
    const compressible = ['.html', '.js', '.css', '.json', '.svg'].includes(ext)
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))
    const headers = {
      'Content-Type': MIME[ext],
      /* 开发期不缓存 HTML，静态资源用 mtime 做协商缓存，避免改完代码看到旧版 */
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=0, must-revalidate',
      ETag: `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`
    }
    if (compressible && acceptsGzip) {
      const body = await fsp.readFile(target)
      const gz = zlib.gzipSync(body, { level: 6 })
      headers['Content-Encoding'] = 'gzip'
      headers['Content-Length'] = gz.length
      headers['Vary'] = 'Accept-Encoding'
      res.writeHead(200, headers)
      res.end(req.method === 'HEAD' ? undefined : gz)
      return
    }
    headers['Content-Length'] = stat.size
    res.writeHead(200, headers)
    if (req.method === 'HEAD') { res.end(); return }
    fs.createReadStream(target).pipe(res)
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }
}

/* 仅回环来源才下发演示凭证：HOST 被改成 0.0.0.0 时局域网机器拿不到口令与动态口令 */
function isLoopback(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '')
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

function otpMap() {
  const at = Date.now()
  const map = {}
  for (const account of DEMO_ADMIN_ACCOUNTS) {
    map[account.username] = generateTotp(account.totpSecret, at)
  }
  return map
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST + ':' + PORT}`)
  const pathname = url.pathname

  if (req.method === 'GET' && pathname === '/api/health') {
    const local = isLoopback(req)
    const payload = {
      ok: true,
      service: 'suanli-admin-dev',
      /* 缓存观测：压测时可直接看命中率与 Redis 降级状态 */
      cache: cache.stats(),
      now: Date.now()
    }
    /* 演示口令 / 动态口令只回给本机：避免开发服务被暴露到局域网后直接被登录 */
    if (local) {
      const otps = otpMap()
      payload.demoOtp = otps.admin || ''
      payload.demoOtps = otps
      payload.demoAccounts = DEMO_ADMIN_ACCOUNTS.map((a) => ({
        username: a.username,
        password: a.password,
        role: a.role,
        name: a.name
      }))
    }
    sendJson(res, 200, payload)
    return
  }

  if (req.method === 'POST' && pathname === '/api/admin') {
    let body
    try {
      body = await readBody(req)
    } catch (err) {
      sendJson(res, 400, { ok: false, code: 'VALIDATION', message: err.message })
      return
    }
    const action = typeof body.action === 'string' ? body.action : ''
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {}
    const token = typeof body.token === 'string' ? body.token : ''
    const result = await adminRouter.dispatch(action, data, { token, ip: req.socket.remoteAddress || '' })
    if (result && result.ok) persist()
    sendJson(res, 200, result)
    return
  }

  if (req.method === 'POST' && pathname === '/api/user') {
    let body
    try {
      body = await readBody(req)
    } catch (err) {
      sendJson(res, 400, { ok: false, code: 'VALIDATION', message: err.message })
      return
    }
    const action = typeof body.action === 'string' ? body.action : ''
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {}
    /* openid 只允许本机覆盖：局域网来源不允许冒充任意用户 */
    const openid = isLoopback(req) && typeof body.openid === 'string' && body.openid
      ? body.openid
      : 'o_demo_user_1'
    const result = await userRouter.dispatch(action, data, { openid, ip: req.socket.remoteAddress || '' })
    if (result && result.ok) persist()
    sendJson(res, 200, result)
    return
  }

  await serveStatic(req, res, pathname)
})

server.listen(PORT, HOST, () => {
  console.log('────────────────────────────────────────────')
  console.log(' 算力聚合 · 本地联调服务已启动')
  console.log(` 管理端入口：http://${HOST}:${PORT}/admin/`)
  console.log(` 用户端首页：http://${HOST}:${PORT}/user/home.html`)
  console.log(` 接口地址：  http://${HOST}:${PORT}/api/admin 、/api/user`)
  console.log(` 状态文件：  ${path.relative(ROOT, STATE_FILE)}`)
  console.log(' 演示账号：  admin / Admin@12345 、cs / Cs@12345（动态口令见登录页）')
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.log(' ⚠ 当前监听地址不是本机回环：演示数据与接口将对局域网可见，请仅在可信网络使用')
  }
  console.log('────────────────────────────────────────────')
})
