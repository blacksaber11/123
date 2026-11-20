/* 代采 / 代售的服务费规则与委托流程说明页 */

const FEE_ROWS = [
  { k: '≤ 3 万元', v: '299 元 / 单' },
  { k: '3 万 – 100 万元', v: '1%，封顶 5,000 元' },
  { k: '100 万元以上', v: '0.5%，上不封顶' }
]

function stepsOf(side, rental) {
  const buy = side === 'buy'
  const submit = buy
    ? '填写设备型号、数量、' + (rental ? '月租金预算' : '采购预算') + '与截止时间；上传验资证明、联系人身份证' +
      (rental ? '' : '，1000 万元以上另需采购意向函') + '；委托授权书选填。'
    : '填写设备型号、数量、' + (rental ? '月租金' : '期望售价') + '与截止时间；上传物权证明（采购合同、发票或产权证明）、联系人身份证；委托授权书选填。'
  return [
    { t: '提交委托', d: submit + '发布、审核、上架都不收费。' },
    { t: '平台审核', d: '客服核验' + (buy ? '材料与需求' : '设备权属与材料') + '，通过后上架；委托方信息与订单仅平台可见，不对外公开。' },
    { t: buy ? '平台代寻' : '平台代找买家', d: buy ? '按型号与条件在平台内外匹配货源，代为询价、初筛并反馈候选方案。' : '按型号与条件匹配买家，代为报价、筛选并反馈意向买家。' },
    { t: '条件确认', d: buy ? '型号、数量、成色、' + (rental ? '租期与租金' : '价格、交付与验收方式') + '经委托方确认。' : (rental ? '租金、租期' : '价格') + '、交付、验收与税费承担方式经委托方确认。' },
    { t: '签约成交', d: '平台居中对接并确认成交，合同截止时间以委托截止时间为准。' },
    { t: '服务费结算', d: rental ? '平台生成服务费账单（首月租金合计的一个月租金，买卖双方各承担 50%），委托方打款后 3 个工作日内确认到账。' : '平台生成服务费账单，委托方打款后 3 个工作日内确认到账，客服确认完成。' }
  ]
}

Page({
  data: {
    kind: 'fee',
    side: 'buy',
    rental: false,
    title: '',
    subtitle: '',
    sideLabel: '',
    feeRows: FEE_ROWS,
    steps: [],
    feeLine: '',
    fileLine: ''
  },

  onLoad(query) {
    const kind = query.kind === 'flow' ? 'flow' : 'fee'
    const side = query.side === 'sell' ? 'sell' : 'buy'
    const rental = query.rental === '1'
    const sideLabel = side === 'buy' ? '代采' : '代售'
    const title = kind === 'fee' ? '平台服务费规则' : sideLabel + '委托流程'
    wx.setNavigationBarTitle({ title })
    this.setData({
      kind,
      side,
      rental,
      title,
      subtitle: kind === 'fee'
        ? '发布、审核、上架不收费 · 成交后支付'
        : '平台核验 · 居中对接 · 成交后支付' + (rental ? ' · 当前为租赁委托' : ''),
      sideLabel,
      steps: kind === 'flow' ? stepsOf(side, rental) : [],
      feeLine: '发布、审核、上架均不收费，成交后按金额分档：≤3 万元 299 元 / 单；3 万–100 万元 1%，封顶 5,000 元；100 万元以上 0.5%，上不封顶。租赁按首月租金合计，服务费为一个月租金，买卖双方各承担 50%。',
      fileLine: side === 'buy'
        ? '必传：联系人身份证、验资证明；1000 万元以上另需采购意向函。选填：委托授权书。'
        : '必传：联系人身份证、物权证明。选填：委托授权书；1000 万元及以上由客服追加资料核验。'
    })
  }
})
