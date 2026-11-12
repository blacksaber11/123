/* 实时货盘的数据口径：城市字典、演示盘口、品类、价格格式化与粘贴报价解析。
   首页筛选与实时货盘页共用这一份，避免两处实现走偏。 */

/* 交易城市：大区 → 城市两级菜单，城市取自算力设备交易与机房资源集中的区域，
   除一线城市外也覆盖廊坊、张家口、芜湖等数据中心枢纽。 */
const CITY_TREE = [
  { p: '热门', cities: ['深圳', '北京', '上海', '杭州', '成都', '广州', '武汉', '南京', '苏州', '西安', '重庆', '东莞'] },
  { p: '华北', cities: ['北京', '天津', '石家庄', '廊坊', '张家口', '太原', '呼和浩特'] },
  { p: '东北', cities: ['沈阳', '大连', '长春', '哈尔滨', '大庆'] },
  { p: '华东', cities: ['上海', '南京', '苏州', '无锡', '常州', '南通', '杭州', '宁波', '温州', '嘉兴', '合肥', '芜湖', '福州', '厦门', '泉州', '济南', '青岛', '南昌', '赣州'] },
  { p: '华中', cities: ['武汉', '宜昌', '襄阳', '长沙', '株洲', '郑州', '洛阳'] },
  { p: '华南', cities: ['广州', '深圳', '东莞', '佛山', '珠海', '惠州', '中山', '汕头', '南宁', '桂林', '海口', '三亚'] },
  { p: '西南', cities: ['成都', '绵阳', '重庆', '贵阳', '昆明', '拉萨'] },
  { p: '西北', cities: ['西安', '咸阳', '兰州', '西宁', '银川', '乌鲁木齐'] }
]

const CITY_FLAT = []
CITY_TREE.forEach((g) => g.cities.forEach((c) => { if (CITY_FLAT.indexOf(c) < 0) CITY_FLAT.push(c) }))

/* 实时货盘：卖价来自平台在售商品与用户报价；代采 / 代售只在商机池展示。 */
const BOARD_DEMO = [
  { id: 'b1', cat: 'GPU 加速卡', model: 'H100 80G SXM', buyPrice: 215000, sellPrice: 228000, buyCount: 6, sellCount: 4, city: '上海', updated: '3 分钟前' },
  { id: 'b2', cat: 'GPU 加速卡', model: 'A100 80G PCIE', buyPrice: 96000, sellPrice: 102000, buyCount: 4, sellCount: 7, city: '深圳', updated: '12 分钟前' },
  { id: 'b3', cat: 'GPU 加速卡', model: 'RTX 4090 24G', buyPrice: 15400, sellPrice: 16300, buyCount: 11, sellCount: 9, city: '东莞', updated: '25 分钟前' },
  { id: 'b4', cat: 'GPU 服务器', model: '8 卡 H100 HGX 整机', buyPrice: 1780000, sellPrice: 1890000, buyCount: 2, sellCount: 1, city: '张家口', updated: '40 分钟前' },
  { id: 'b5', cat: '内存条', model: 'DDR5 64G 6400 金百达', buyPrice: 1780, sellPrice: 1880, buyCount: 8, sellCount: 12, city: '杭州', updated: '1 小时前' },
  { id: 'b6', cat: '内存条', model: 'DDR5 RDIMM 96G 5600', buyPrice: 3850, sellPrice: 4050, buyCount: 5, sellCount: 3, city: '北京', updated: '1 小时前' },
  { id: 'b7', cat: '服务器整机', model: '4 卡 L40S 推理整机', buyPrice: 420000, sellPrice: 448000, buyCount: 3, sellCount: 2, city: '成都', updated: '2 小时前' },
  { id: 'b8', cat: '其他配件', model: '企业级 SSD 3.84T NVMe', buyPrice: 2050, sellPrice: 2180, buyCount: 6, sellCount: 5, city: '南京', updated: '2 小时前' }
]

/* 实时货盘分类：固定主品类打底，再合并货盘里出现的品类。
   货盘为空（云端还没数据 / 接口不可用）时也要有分类可筛，不能只剩「全部」 */
const BOARD_MAIN_CATS = ['GPU 服务器', 'GPU 加速卡', 'AI 一体机', '推理服务器', 'CPU 服务器', 'NPU 加速卡', '消费级显卡', 'AI 工作站', '内存条', '服务器配件']

function boardCatList(list) {
  const cats = ['全部']
  BOARD_MAIN_CATS.forEach((c) => { if (cats.indexOf(c) < 0) cats.push(c) })
  ;(list || []).forEach((b) => { if (b.cat && cats.indexOf(b.cat) < 0) cats.push(b.cat) })
  return cats
}

function fmtPrice(n) {
  return String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fmtClock() {
  const d = new Date()
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)
}

/* 关键字匹配：空格分词，全部命中才算匹配 */
function matchKeyword(x, kw) {
  const words = String(kw || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [x.title, x.cat, x.brand, x.model, x.city, x.subText, x.note].join(' ').toLowerCase()
  return words.every((w) => hay.indexOf(w.toLowerCase()) >= 0)
}

/* 按型号猜品类：内存商粘贴的大多是小货，猜不中的归「其他配件」 */
function guessCat(model) {
  const s = String(model || '')
  if (/DDR\d|内存/i.test(s)) return '内存条'
  if (/H100|A100|B200|B300|4090|加速卡|显卡/i.test(s)) return 'GPU 加速卡'
  if (/整机|服务器|HGX/i.test(s)) return '服务器整机'
  return '其他配件'
}

/* 粘贴解析（演示口径）：一行 = 一条报价，提取型号 / 价格 / 数量 / 城市。
   解析不到的字段留空，交给发布者在预览里确认后删除，宁可少提取不乱猜。 */
function parseQuoteLine(line) {
  const ln = String(line || '').replace(/^\s*[\d]+[\.、)）]\s*/, '').trim()
  if (!ln) return null
  let price = 0
  const pm = ln.match(/[¥￥]\s*([\d,]+)|([\d,]{3,})\s*(?:元|块)/)
  if (pm) price = Number((pm[1] || pm[2]).replace(/,/g, ''))
  let qty = ''
  let unit = '件'
  const qm = ln.match(/(\d+)\s*(根|条|张|片|台|块|个|组)/)
  if (qm) { qty = qm[1]; unit = qm[2] }
  let city = ''
  CITY_FLAT.forEach((c) => { if (!city && ln.indexOf(c) >= 0) city = c })
  let model = ln
  if (pm) model = model.split(pm[0])[0]
  model = model.replace(/[¥￥][\d,.]*\s*(?:元|块)?/g, ' ')
    .replace(/\d+\s*(根|条|张|片|台|块|个|组)/g, ' ')
  if (city) model = model.split(city).join(' ')
  model = model.replace(/[-–—|｜,，、;；:：\s]+/g, ' ').trim()
  if (!model && !price) return null
  return {
    title: model || '未命名报价',
    cat: guessCat(model),
    model: model || '未命名报价',
    price,
    priceText: price > 0 ? '¥ ' + fmtPrice(price) : '价格面议',
    qty: qty || '面议',
    unit,
    city: city || '城市未填写',
    hoursLeft: 24
  }
}

module.exports = {
  CITY_TREE,
  CITY_FLAT,
  BOARD_DEMO,
  BOARD_MAIN_CATS,
  boardCatList,
  fmtPrice,
  fmtClock,
  matchKeyword,
  guessCat,
  parseQuoteLine
}
