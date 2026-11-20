'use strict'

/**
 * 发布页「粘贴文字 → 自动填表」的纯规则解析器。
 *
 * 只依赖型号工具（./model）与行政区划（./region），不依赖页面与服务端上下文，
 * 便于在 node 里直接跑用例。全仓没有接入任何大模型，识别完全靠规则：
 * 1. 先按空行 / 编号 / 分号把整段文字拆成多条记录；
 * 2. 每条记录里抽型号、数量、起订量、价格、城市、成色、条件与交易流程；
 * 3. 解析不到的字段留空，宁可少填也不瞎猜，全部交给用户在表单里复核。
 */

const M = require('./model')
const { CITY_TREE } = require('./region')

/* 行政区划后缀：去掉后得到聊天里常用的短名（深圳市 → 深圳） */
const CITY_SUFFIX = /(特别行政区|自治州|自治县|地区|林区|盟|市|县)$/
/* 省级后缀：广东 → 广东省；港澳台只到省一级，城市交给用户选 */
const PROVINCE_SUFFIX = /(壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/

/* 数量单位：只认这些，避免把「8 卡整机」的 8 当成库存台数；
   台后面跟「湾 / 币 / 式」是地名或币种（台湾、台币），不算数量单位 */
const UNIT_TAIL = '台(?!湾|币|式)|张|片|套|个|根|条|组|颗'
const UNIT_ALT = '(?:' + UNIT_TAIL + ')'
const UNIT_CAP = '(' + UNIT_TAIL + ')'
/* 数量写法：1,000（千分位）、500+、100 余台都算 */
const UNIT_RE = new RegExp('(\\d[\\d,]*)\\s*(?:余|多|\\+)?\\s*' + UNIT_CAP)

/* 非数量数字：时间、比例、批次先剔除，避免「1 个工作日内」「2 部分」「70%」被当成数量 */
const NON_QTY_RE = /\d+(?:\.\d+)?\s*(?:个?\s*)?(?:工作日|工作天|小时|分钟|天|日|周|个月|月|年|%|％|部分|批次|批|期)/g

/* 币种：顺序有讲究，USDT / HK$ / S$ 必须在 USD 的 $ 之前判断 */
const CURRENCY_RULES = [
  /* 币圈写法「2.5 万 U」「U 价」= USDT，单个 U 不认，避免误判 */
  { code: 'USDT', re: /USDT|泰达币|万\s*U(?![A-Za-z])|U\s*价/i },
  { code: 'HKD', re: /港币|港元|HKD|HK\$/i },
  { code: 'SGD', re: /新加坡元|新币|SGD|S\$/i },
  { code: 'USD', re: /美金|美元|USD|\$/i },
  { code: 'EUR', re: /欧元|EUR|€/i },
  /* 960GB 这类容量后面紧跟 P5530 时不能把 GB 当英镑 */
  { code: 'GBP', re: /英镑|(?:^|[^A-Za-z0-9])GBP|£/i },
  { code: 'JPY', re: /日元|日币|JPY/i },
  { code: 'AED', re: /迪拉姆|AED/i },
  { code: 'BTC', re: /比特币|BTC/i }
]


/* 总价口径：出现这些词时，金额是整批价，需要按数量折算单价 */
const TOTAL_RE = /总价|共计|一共|总共|打包|整批|合计|共\s*[¥￥]?\s*\d/

/* 聊天广告里的价格写法：「含税💰5180」「单价2100」；至少 3 位数字，避免「报价70万」被当成元 */
const MONEY_RE = /(?:💰|💵|含税|单价)\s*[:：]?\s*[💰💵¥￥]?\s*([\d,]{3,}(?:\.\d+)?)/

/* 条款 / 说明行：跟随所属商品，不单独成条 */
const TERM_LINE_RE = /^(起订|最多|最少|每批|单批|每单|单次|单价|总价|价格|买返|居间|批量|可议|备注|其他|说明|换群|全国|以上|\d{1,3}\s*[Bb]\b)/

/* 出 / 收 判定：带求购、收货类词汇的是需求（buy），没有收货词汇的一律按商品（sell）。
   「收到 / 收来的 / 收据」是描述不是求购，「要求 / 请求 / 追求」也不是求购；
   「超出 / 输出 / 发出 / 提出」不是出售。这些都不参与判定，避免一句话被读反 */
const BUY_HINT = /求购|收购|回收|收货|采购|寻源|找货|找货源|要货|谁有|有货(?:来报|私聊|来谈|联系)|(?:^|[^要追请])求(?=\s*[A-Za-z0-9\u4e00-\u9fa5])|收(?!到|集|拾|入|费|款|据|了|的|来|货后)/
const SELL_HINT = /出售|特价出|现货出|低价出|便宜出|出给|可出|甩卖|清仓|处理货|出\s*[:：]|售\s*[:：]|卖\s*[:：]|(?:^|[^超输发提演突])出(?=\s*[A-Za-z0-9\u4e00-\u9fa5¥￥])|售(?=\s*[A-Za-z0-9\u4e00-\u9fa5])|卖(?=\s*[A-Za-z0-9\u4e00-\u9fa5])/

/* 纯栏目头：「特价出：」「收：」「求购：」这类只表态、不带货的一行，切换后续条目的类型 */
const SIDE_HEADER_SELL_RE = /^(?:特价|低价|现货|清仓|甩卖)?(?:出|出售|售卖|甩卖|清仓)$/
const SIDE_HEADER_BUY_RE = /^(?:求购|收购|回收|收货|收)$/

/**
 * 一条记录属于商品还是需求，按信号强弱依次判断：
 * 1. 行首动词最可靠：「出 / 售 / 卖」开头是商品，「收 / 求购 / 收购 / 回收」开头是需求；
 * 2. 再看行内明确词汇：求购 / 回收 / 有货来报 → 需求，特价出 / 可出 / 出售 → 商品；
 * 3. 两种都没有 → 默认商品（不写就等于出）。
 * 「需要的联系」「要求全新」这类是广告用语，不算求购。
 */
function classifySide(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return 'sell'
  const head = s.replace(/^[\s[【（("'“]+/, '')
  if (/^(?:出|售|卖|甩|清仓)/.test(head)) return 'sell'
  if (/^(?:收(?!到|集|拾|入|费|款|据|了|的|来)|求购|收购|回收|采购|寻)/.test(head)) return 'buy'
  if (BUY_HINT.test(s)) return 'buy'
  if (SELL_HINT.test(s)) return 'sell'
  return 'sell'
}

/**
 * 整段口径：通篇是回收 / 求购广告、且没有任何出售词时返回 buy。
 * 这类广告常写成标题一句「主力回收」，下面逐行只列型号（没有「收」字），
 * 逐行判定会把后面几行误当成商品，所以先用整段口径兜底。
 */
function globalSideOf(text) {
  const lines = String(text == null ? '' : text).split('\n').map((s) => s.trim()).filter(Boolean)
  if (!lines.length) return ''
  if (lines.some((l) => SELL_HINT.test(l))) return ''
  if (!lines.some((l) => BUY_HINT.test(l))) return ''
  return 'buy'
}

/**
 * 一行是不是「只表态」的栏目头（特价出： / 收： / 求购：）：
 * 命中时返回 sell / buy，栏目下面的条目都按这个类型算。
 */
function sideHeaderOf(line) {
  const s = String(line == null ? '' : line).trim()
  if (!s) return ''
  const bare = s
    .replace(/^[\s\d、.．)）(（\-—*·]+/, '')
    .replace(/[\s:：,，。.；;]+$/, '')
    .trim()
  if (!bare || bare.length > 8) return ''
  if (SIDE_HEADER_BUY_RE.test(bare)) return 'buy'
  if (SIDE_HEADER_SELL_RE.test(bare)) return 'sell'
  return ''
}

/** 按栏目头切段：每段带上段头的出 / 收口径，段头本身不发布 */
function splitSideSegments(text) {
  const lines = String(text == null ? '' : text).split('\n')
  const out = []
  let cur = { side: '', lines: [] }
  lines.forEach((line) => {
    const side = sideHeaderOf(line)
    if (side) {
      if (cur.lines.join('').trim()) out.push(cur)
      cur = { side, lines: [] }
      return
    }
    cur.lines.push(line)
  })
  if (cur.lines.join('').trim() || !out.length) out.push(cur)
  return out
}

/* 行内动词：「出」/「收」这类单字动词必须独立成词（前面是行首或分隔符） */
const SIDE_TOKEN_RE = /(?:^|[\s,，;；、|/])(出|收|售|卖|求购|收购|回收|采购)(?=\s*[A-Za-z0-9\u4e00-\u9fa5])/g

/**
 * 同一行既写「出…」又写「收…」时（出H100 10台 收H200 5台），按动词位置切成两条，
 * 各自带上自己的方向；否则整行只能算一条，另一半必然被读反。
 * 只有两个方向都出现、且切点前面确实是完整报价（行首动词或已写数量 / 价格）时才切。
 */
function splitMixedSideLine(line) {
  const s = String(line == null ? '' : line).trim()
  if (!s || s.indexOf('\n') > -1) return null
  const marks = []
  SIDE_TOKEN_RE.lastIndex = 0
  let m
  while ((m = SIDE_TOKEN_RE.exec(s))) {
    const verb = m[1]
    const at = m.index + m[0].length - verb.length
    /* 「超出 / 输出 / 发出 / 提出 / 演出 / 突出」不是出售动词 */
    if (/^(?:出|售|卖)$/.test(verb) && at > 0 && /[超输发提演突]/.test(s.charAt(at - 1))) continue
    const side = /^(?:出|售|卖)$/.test(verb) ? 'sell' : 'buy'
    if (marks.length && marks[marks.length - 1].side === side) continue
    marks.push({ at, side })
  }
  if (marks.length < 2) return null
  if (!marks.some((x) => x.side === 'sell') || !marks.some((x) => x.side === 'buy')) return null
  const head = s.slice(0, marks[0].at)
  if (marks[0].at > 0 && !UNIT_RE.test(stripNonQty(head)) && !/[\d,]+\s*万/.test(head)) return null
  const out = []
  if (head.trim()) out.push({ raw: head.replace(/[\s,，;；、|/]+$/, '').trim(), side: '' })
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : s.length
    const raw = s.slice(mk.at, end).replace(/[\s,，;；、|/]+$/, '').trim()
    if (raw) out.push({ raw, side: mk.side })
  })
  return out.length > 1 ? out : null
}

/* 币种写在金额后面：「18000 美金」「25 万港币」「25000 USDT」「250000$」 */
const CUR_SUFFIX_RE = /([\d,]{3,}(?:\.\d+)?)\s*(?:美金|美元|USDT|USD|港币|港元|HKD|欧元|EUR|英镑|GBP|日元|JPY|迪拉姆|AED|比特币|BTC|人民币|RMB|CNY|US\$|\$)(?![A-Za-z0-9])/i
/* 币种写在金额前面：「USD 18000」「HK$ 25,000」「$250000」；
   前面必须断开，否则 960GBP5530 里的 GBP 会被当成币种前缀 */
const CUR_PREFIX_RE = /(?:^|[^A-Za-z0-9])(?:USDT|USD|HKD|SGD|EUR|GBP|JPY|AED|BTC|RMB|CNY|HK\$|US\$|S\$|[$€£])\s*([\d,]{3,}(?:\.\d+)?)/i

/* 交易流程关键词：只有像流程的短句才收进「交易流程」 */
const FLOW_HINT = /验货|验机|看货|付款|发货|验收|合同|开票|签约|交付|提货|打款|物流|签收|压测|对账|选型|报价|下单|定金|尾款|装车|报关|清关|开箱|测试|锁货|放货/

/* 没写成步骤、但能直接当一步流程的常见条款 */
const FLOW_PHRASE = /款到发货|货到付款|验货后付款|先验后付|见货付款|预付定金|定金锁货|先款后货|先货后款|全款发货|到货结清|验收后付款/

/* 租期候选：与发布页 GROUPS.rentTerm 保持一致 */
const RENT_TERMS = ['1 个月', '3 个月', '6 个月', '12 个月', '长期', '可议']

/* ---------- 索引 ---------- */

/* 城市缩写：聊天报价常用 SZ / HK / SH，按大写整体匹配 */
const CITY_ALIAS = {
  深圳: ['SZ'], 广州: ['GZ'], 上海: ['SH'], 北京: ['BJ'], 杭州: ['HZ'],
  成都: ['CD'], 武汉: ['WH'], 西安: ['XA'], 南京: ['NJ'], 香港: ['HK'],
  重庆: ['CQ'], 天津: ['TJ'], 厦门: ['XM'], 青岛: ['QD'], 长沙: ['CS'], 合肥: ['HF']
}

/** 城市别名索引：全称 + 去后缀短名，按别名长度倒序（最长优先，避免「海南」命中「海南藏族」） */
function buildCityIndex(tree) {
  const src = tree || CITY_TREE
  const out = []
  Object.keys(src || {}).forEach((province) => {
    (src[province] || []).forEach((city) => {
      const name = String(city)
      const short = name.replace(CITY_SUFFIX, '')
      out.push({ alias: name, province, city: name, len: name.length })
      if (short && short !== name) out.push({ alias: short, province, city: name, len: short.length })
      ;(CITY_ALIAS[short] || []).forEach((abbr) => {
        out.push({ alias: abbr, province, city: name, len: abbr.length })
      })
    })
    /* 只写到省 / 港澳台：「广东」「香港」「台湾」先填省份，城市让用户选 */
    const pShort = province.replace(PROVINCE_SUFFIX, '')
    out.push({ alias: province, province, city: '', len: province.length })
    if (pShort && pShort !== province) out.push({ alias: pShort, province, city: '', len: pShort.length })
  })
  /* 同长度时城市优先于省份：广东深圳 要落到 深圳市 而不是 广东省 */
  out.sort((a, b) => b.len - a.len || (a.city ? 0 : 1) - (b.city ? 0 : 1))
  return out
}

/** 设备扁平索引：把四级目录摊平成一条一条，匹配时逐条打分 */
function buildDeviceIndex(tree) {
  const root = tree || {}
  const out = []
  Object.keys(root).forEach((cat) => {
    Object.keys(root[cat] || {}).forEach((brand) => {
      Object.keys(root[cat][brand] || {}).forEach((series) => {
        (root[cat][brand][series] || []).forEach((model) => {
          const name = String(model)
          out.push({
            cat,
            brand,
            series,
            model: name,
            norm: M.normSearch(name),
            core: M.modelCoreOf(name),
            cap: M.capacityOf(name),
            whole: /整机|\d+\s*卡/.test(name)
          })
        })
      })
    })
  })
  return out
}

/* ---------- 记录切分 ---------- */

function hasModelLike(s) {
  const t = String(s || '')
  return /[A-Za-z]{1,8}\s*-?\s*\d{2,}|\d{3,}|[A-Za-z]{1,5}\d{1,5}[A-Za-z]{1,6}/.test(t) ||
    SHORT_MODEL_RE.test(t)
}

const NUMBER_MARK = /^\s*(?:\d{1,2}\s*[.、)）]|\(\d{1,2}\)|[①②③④⑤⑥⑦⑧⑨⑩])\s*/

/* 短型号：SD1 / S60 / A100 这类「字母 + 数字」且后面不再接字母数字的写法 */
const SHORT_MODEL_RE = /[A-Za-z]{1,4}\d{1,3}(?![A-Za-z0-9])/

/* 「1.产品：/ 2.规格：/ 3.数量：/ 4.报价：」这种编号是字段清单，
   整段仍是同一条商品；只有编号内容不像字段标签时才按编号拆多条 */
const FIELD_LABEL_RE = /^(?:产品|品名|商品|型号|规格|配置|容量|内存|数量|台数|起订量|报价|价格|单价|总价|金额|税费|含税|成色|品牌|类型|地点|地址|交货地?点?|提货地?点?|发货地|所在地|城市|地区|交易流程|交易方式|流程|付款方式|付款|结算|账期|租期|工期|备注|说明|其他|有效期|对接人|联系人|电话|手机|居间|佣金)\s*[：:]/

function isFieldLabel(line) {
  return FIELD_LABEL_RE.test(String(line || '').trim())
}

/** 编号行开新段：整段里至少两行带编号才认为用户在列多条 */
function splitByNumbering(text) {
  const lines = String(text || '').split('\n')
  const marks = lines.filter((l) => NUMBER_MARK.test(l))
  if (marks.length < 2) return []
  /* 多数编号行是字段标签：按一条商品处理，不再逐行拆 */
  const labels = marks.filter((l) => isFieldLabel(l.replace(NUMBER_MARK, '')))
  if (labels.length >= 2 && labels.length * 2 >= marks.length) return []
  const out = []
  let cur = ''
  lines.forEach((line) => {
    if (NUMBER_MARK.test(line)) {
      if (cur.trim()) out.push(cur.trim())
      cur = line.replace(NUMBER_MARK, '')
    } else {
      cur += '\n' + line
    }
  })
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

/** 一行是否自带商品信号：数量 / 价格 / 型号样式，且不是条款说明行 */
function isListingLine(line) {
  const s = String(line || '').trim()
  if (!s) return false
  if (TERM_LINE_RE.test(s.replace(/^[\s[【（(]+/, ''))) return false
  const plain = stripNonQty(s)
  if (UNIT_RE.test(plain)) return true
  if (/[\d,]+\s*万\s*(?:台|张|片|套|个)/.test(plain)) return true
  if (MONEY_RE.test(plain)) return true
  /* 求购行常只写「收 5090风扇卡」这种型号数字 */
  if (classifySide(s) === 'buy' && /\d{2,}/.test(plain)) return true
  /* 型号样式：MLU370 / RG800 / S60 / 300V / 64G / T1DEEP / TG659V3，中文品牌后的字母数字都算 */
  return /[A-Za-z]{1,8}\s*-?\s*\d{2,}/.test(plain) ||
    /[A-Za-z]{1,5}\d{1,5}[A-Za-z]{1,6}/.test(plain) ||
    /\d{2,}\s*[A-Za-z]{1,4}\b/.test(plain) ||
    SHORT_MODEL_RE.test(plain)
}

/** 城市 + 现货 / 期货、或换群开头的栏目行：留给下一条商品，别并进上一条 */
function isSectionHeader(line) {
  const s = String(line || '').trim()
  if (/^换群/.test(s)) return true
  /* 只认「深圳现货」这类以现货 / 期货结尾的短栏目行，「现款现货交易」是流程步骤不算 */
  if (s.length <= 12 && /(现货|期货)$/.test(s)) return true
  /* 「全新16T」「现货8T」：容量栏目行，留给下面同一容量的报价，本身不是商品 */
  if (s.length <= 10 && /^(?:全新|现货|期货|国行|原封)\s*\d{1,3}\s*(?:T|TB|G|GB)$/i.test(s)) return true
  /* 「[庆祝]11月20日出深圳现货[烟花]」：去掉表情 / 括号 / 日期后就是一个城市栏目头 */
  const bare = s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}【】\[\]（）()「」·•]/gu, ' ')
    .replace(/\d{1,2}\s*[月.\/-]\s*\d{1,2}\s*日?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return bare.length > 0 && bare.length <= 16 &&
    /(现货|期货)/.test(bare) && /(出|收|售|发)/.test(bare) &&
    !/\d+\s*(台|张|片|套|个|根|条|组)|[\d,]+\s*万/.test(bare)
}

/**
 * 段内再按行拆：一次贴很多条报价时，每行自带价格 / 型号就各成一条；
 * 说明行并入上一条，城市标题行单独留着跟下一条合并。
 * 段里出现「数量：/ 交货地点：/ 交易流程」这类明细字段时，整段是同一条商品的描述，不拆。
 * 注意：行内的「数量43」是报价写法，只有行首的「数量：43」才是字段块。
 */
const DETAIL_BLOCK_RE = /(?:^|\n)\s*(?:数量|台数|库存|交货地点|交货地|提货地点|提货地|发货地|所在地)\s*[：:]|交易流程|拼单|价格今日有效|报价有效期/

function refineByLine(blocks) {
  const out = []
  blocks.forEach((b) => {
    if (DETAIL_BLOCK_RE.test(String(b.raw || ''))) {
      out.push(b)
      return
    }
    const lines = String(b.raw || '').split('\n').map((s) => s.trim()).filter(Boolean)
    if (lines.filter((l) => isListingLine(l) && hasModelLike(l)).length < 2) {
      out.push(b)
      return
    }
    const local = []
    lines.forEach((line) => {
      if ((isListingLine(line) && hasModelLike(line)) || isSectionHeader(line) || !local.length) local.push({ key: '', raw: line })
      else local[local.length - 1].raw += '\n' + line
    })
    local.forEach((x) => out.push(x))
  })
  return out
}

/** 全角转半角：Ｈ１００ ８台 ２５万 → H100 8台 25万，中文输入法直接贴也能识别 */
function toHalfWidth(text) {
  return String(text == null ? '' : text)
    .replace(/\u3000/g, ' ')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/￥/g, '¥')
    /* 型号中间的空格：「H 100」「A 100」按 H100 处理；80G 后面的空格不动 */
    .replace(/(^|[^A-Za-z0-9])([A-Za-z]{1,2})[ \t]+(?=\d)/g, '$1$2')
}

/**
 * 把一段文字拆成记录：
 * 空行分段 → 编号分段 → 中文分号分段 → 顿号分隔的多条报价 → 每行一条（兜底）→ 段内按行细化。
 * 段内的续行自然并入上一条。
 */
function splitRecords(text) {
  const raw = toHalfWidth(text).replace(/\r\n?/g, '\n').trim()
  if (!raw) return []
  let blocks = raw.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean)

  const numbered = splitByNumbering(raw)
  if (numbered.length > blocks.length) blocks = numbered

  /* 带「容量 / 频率 / 品牌：」字段行的整段是一条需求，
     里面的顿号 / 分号是并列规格（瑕疵条、坏条…），不能当多条拆 */
  const labeledBlock = raw.split('\n').some(isFieldLabel)

  if (blocks.length === 1 && !labeledBlock) {
    const semi = raw.split(/[；;]/).map((s) => s.trim()).filter(Boolean)
    if (semi.length > 1 && semi.filter(hasModelLike).length >= 2) blocks = semi
  }

  /* 「H100 8台 25万、H200 8台 28万」：顿号两边各自带型号才拆，
     避免「H100 80G、8台、25万、深圳」这种同一条被拆散 */
  if (blocks.length === 1 && !labeledBlock) {
    const parts = raw.split(/[、]/).map((s) => s.trim()).filter(Boolean)
    if (parts.length > 1 && parts.filter(hasModelLike).length >= 2) blocks = parts
  }

  if (blocks.length === 1) {
    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean)
    /* 明细字段齐全（数量 / 交易流程…）或字段标签成片出现时，整段是一条商品，不逐行拆 */
    const fieldLines = lines.filter(isFieldLabel).length
    if (!DETAIL_BLOCK_RE.test(raw) && fieldLines < 2 && lines.length > 1 && lines.filter(hasModelLike).length >= 2) blocks = lines
  }

  /* 「T1DEEP | T2SEEP | T2DEHG」：单行里用竖线并列多个型号时，各算一条 */
  blocks = blocks.reduce((out, b) => {
    if (b.indexOf('\n') > -1) {
      out.push(b)
      return out
    }
    const segs = b.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean)
    const allModel = segs.length >= 2 && segs.every((s) => s.length >= 3 && /[A-Za-z]/.test(s) && /\d/.test(s))
    if (allModel) segs.forEach((s) => out.push(s))
    else out.push(b)
    return out
  }, [])

  blocks = refineByLine(blocks.map((b) => ({ raw: b })))
  return blocks.map((b, i) => ({ key: 'r' + (i + 1), raw: b.raw }))
}

/* ---------- 设备匹配 ---------- */

function ifaceOf(s) {
  const t = String(s || '').toLowerCase()
  if (t.indexOf('sxm') > -1) return 'sxm'
  if (t.indexOf('pcie') > -1) return 'pcie'
  return ''
}

/** 型号后面紧跟的 3-4 位系列号：300I 3010 里的 3010，必须出现在候选型号里 */
function strictModelNums(s) {
  const out = []
  const re = /(?:[a-z]{1,6}\d{1,5}[a-z]{0,3}|\d{3,4}[a-z]{1,3})\s+(\d{3,4})(?![0-9a-z])(?!\s*(?:台|张|片|套|个|卡))/gi
  let m
  while ((m = re.exec(s))) out.push(m[1])
  return out
}

/** 原文里的核心型号都要被候选覆盖：300I A2 不能落到 A2 16G；H200 SXM5 允许落到 H200 SXM */
function coresCovered(cores, norm) {
  return cores.every((c) => {
    if (norm.indexOf(c) > -1) return true
    /* 只放过 1-2 位后缀的接口写法（sxm5 → sxm），避免 MLU580 落到 MLU590 */
    const m = c.match(/^([a-z]{2,})\d{1,2}$/)
    return !!m && norm.indexOf(m[1]) > -1
  })
}

/**
 * 带品牌兜底时原文核心与候选核心必须对齐：
 * 「海光K100Ai → DCU K100-AI」可以（k100ai 以 k100 开头），
 * 但「Precision 7 T1」里的 t1 不能因为 t160 含 t1 就落到 PowerEdge T160。
 * 短核心（< 4 位）只认完全相等，避免 t1 / t2 这类两字符片段乱命中。
 */
function coreAligned(cores, item) {
  return cores.every((c) => item.core.some((x) =>
    x === c || c.indexOf(x) === 0 || (c.length >= 4 && x.indexOf(c) === 0)))
}

/* 容量取值：H10080G 这种型号容量连写会把 10080 当成容量，超过 512G 一律不算 */
function safeCapacity(text) {
  const c = M.capacityOf(text)
  const n = Number(String(c).replace('g', ''))
  return n > 0 && n <= 512 ? c : ''
}

/* 内存品牌与频率：聊天里常写「三星 64 4800」「sk 64 6400」，容量单位会省略。
   频率白名单覆盖 DDR4 / DDR5 常见档位，缺失的档位由 ddrOfFreq 推断代数后按同容量匹配 */
const MEM_BRANDS = ['三星', '海力士', '美光', '长鑫存储', '金士顿', '英睿达', '威刚', '芝奇', '海盗船', '金百达', '金邦', '雷克沙', '科赋', '十铨', '阿斯加特', '光威', '佰维']
const MEM_FREQ_RE = /(?:^|[^0-9])(2133|2400|2600|2666|2933|3000|3066|3200|3600|3733|4000|4266|4400|4800|5200|5600|6000|6400|6800|7200|8000|8400|8800)(?![0-9])/
const MEM_FREQ_ALL_RE = new RegExp(MEM_FREQ_RE.source, 'g')
/* 中文 / 英文别名 → 型号库里的品牌名：聊天写「长鑫」「镁光」，库里是「长鑫存储」「美光」 */
const MEM_BRAND_ALIAS = [
  ['长鑫', '长鑫存储'], ['cxmt', '长鑫存储'],
  ['镁光', '美光'], ['micron', '美光'],
  ['kingston', '金士顿'], ['samsung', '三星'], ['hynix', '海力士']
]
/* 内存容量档位：只有这些容量才可能是内存条，避免把显卡 80G / 整机 8 卡当内存 */
const MEM_CAP_RE = /^(4|8|16|24|32|48|64|96|128|192|256|384|512)g$/

/** 原文提到的内存品牌；sk / skhynix 归到海力士 */
function memBrandOf(hay) {
  if (hay.indexOf('海力士') > -1 || /(?:^|[^a-z])sk(?:hynix)?(?:[^a-z]|$)/.test(hay)) return '海力士'
  const alias = MEM_BRAND_ALIAS.find((a) => hay.indexOf(a[0]) > -1)
  if (alias) return alias[1]
  return MEM_BRANDS.find((b) => hay.indexOf(M.normSearch(b)) > -1) || ''
}

/** 频率推 DDR 代数：4800 及以上是 DDR5，其余按 DDR4；型号库没有的档位靠它兜底 */
function ddrOfFreq(freq) {
  const n = Number(freq)
  if (!n) return ''
  return n >= 4800 ? '5' : '4'
}

/** 型号里的频率档位：DDR5 6400 / LPDDR5X 8533 / MRDIMM 8800 都能取到 */
function memFreqOfModel(name) {
  const m = String(name || '').match(/(?:^|[^0-9])([2-8]\d{3})(?![0-9])/)
  if (!m) return ''
  const n = Number(m[1])
  return n >= 2000 && n <= 9000 ? m[1] : ''
}

/** 内存规格：频率、DDR 代数、容量（支持「64 4800」省略 G 的写法） */
function memSpecOf(raw) {
  const s = String(raw || '')
  const low = s.toLowerCase()
  const hay = M.normSearch(s)
  const freqM = low.match(MEM_FREQ_RE)
  let freq = freqM ? freqM[1] : ''
  /* 「64G 4000 元」里的 4000 是价格不是频率，带了金额单位就丢掉 */
  if (freq && new RegExp(freq + '\\s*(?:元|块|人民币|rmb|¥|￥|\\$)').test(low)) freq = ''
  const ddrM = low.match(/ddr\s*([345])/)
  const ddr = ddrM ? ddrM[1] : ''
  let cap = safeCapacity(s)
  if (!cap && freq) {
    /* 「sk/64/5600」「32-5600」：容量和频率之间常有斜杠 / 连字符，不能只认空格 */
    const m = low.match(new RegExp('(\\d{2,3})\\s*(?:g|gb)?\\s*[\\/\\-_,，、·]?\\s*' + freq + '(?![0-9])'))
    const n = m ? Number(m[1]) : 0
    if (n >= 4 && n <= 512) cap = n + 'g'
  }
  const brand = memBrandOf(hay)
  /* 容量 + 频率同时出现（「64 6400」「16G 5600」）就按内存处理，不要求写「内存 / 根 / 颗粒」；
     「三星 64G 100根」这类只有品牌与容量、按根卖的也归内存，频率交给用户确认 */
  const hint = /内存|内存条|ddr\s*[345]|rdimm|lrdimm|mrdimm|sodimm|ecc/i.test(s) ||
    (/颗粒/.test(s) && !!(cap || freq || ddr)) ||
    (/根/.test(s) && !!(freq || ddr || (cap && brand))) ||
    (!!cap && !!freq && MEM_CAP_RE.test(cap))
  return { freq, ddr, cap, brand, hint }
}

/** 固态容量：1T / 2TB / 512G 统一成 1t / 2t / 512g，便于和型号库比对 */
function ssdCapOf(text) {
  const s = String(text || '').toLowerCase()
  /* 「960GBP5530」容量后面直接跟料号：GB 是明确单位，允许后面紧跟字母 */
  const m = s.match(/(\d+(?:\.\d+)?)\s*(tb|t|gb|g)(?![a-z0-9])/) ||
    s.match(/(\d+(?:\.\d+)?)\s*(gb)(?![0-9])/)
  if (!m) return ''
  const n = Number(m[1])
  if (!(n > 0)) return ''
  return m[2].charAt(0) === 't' ? (Math.round(n * 100) / 100) + 't' : Math.round(n) + 'g'
}

function ssdSpecOf(raw) {
  const s = String(raw || '')
  /* 容量写 TB / T 的也按固态处理（「三星 990 PRO 1TB」不带固态二字）；
     显卡 / 整机行里的 T 多是显存或内存，不按固态算 */
  if (!/固态|ssd|nvme|sata|u\.2|m\.2|硬盘/i.test(s) &&
    (!/\d+(?:\.\d+)?\s*tb?(?![a-z0-9])/i.test(s) || /显卡|GPU|整机/i.test(s))) return null
  /* 机械硬盘的成色 / 包装写法（8T白标、16T原箱、国行、盒包）或希捷 / 西数 / 东芝长料号，
     不是固态：否则 8T 会被当成固态容量，错配到 8TB NVMe 型号 */
  if (!/固态|ssd|nvme|u\.2|m\.2/i.test(s) &&
    (/白标|彩标|原箱|国行|盒包|盒装|单盒装|企业级|监控盘/.test(s) ||
      /(?:^|[^A-Za-z0-9])(?:st|wuh|wus|mg|huh)\d[A-Za-z0-9]{4,}/i.test(s))) return null
  const low = s.toLowerCase()
  const iface = /nvme/.test(low) ? 'nvme' : /sata/.test(low) ? 'sata' : /u\.2/.test(low) ? 'u.2' : ''
  return { cap: ssdCapOf(s), iface }
}

/* 纯数字显卡型号：5090 / 4090 / 3090 / 3080 / 2080 / 1660 ... */
const GPU_CODE_RE = /(?:^|[^0-9])(50[5-9]0|40[5-9]0|30[5-9]0|20[6-8]0|16[5-6]0|10[5-8]0)(?![0-9])/g

function gpuCodesOf(raw) {
  const out = []
  const s = String(raw || '')
  let m
  GPU_CODE_RE.lastIndex = 0
  while ((m = GPU_CODE_RE.exec(s))) {
    if (out.indexOf(m[1]) < 0) out.push(m[1])
  }
  return out
}

/** 白牌按类型落到不同型号 / 标题后缀 */
function whiteKindOf(raw, device) {
  const cat = device ? String(device.cat || '') : ''
  if (/内存条/.test(cat)) return 'mem'
  if (/固态/.test(cat)) return 'ssd'
  if (/消费级显卡|GPU 加速卡/.test(cat)) return 'gpu'
  if (/内存|内存条|ddr\s*[345]|rdimm|lrdimm|mrdimm|sodimm|ecc/i.test(raw) || /\d[\d,]*\s*(?:余|多|\+)?\s*根/.test(raw)) return 'mem'
  if (/固态|ssd|nvme|sata|u\.2|m\.2|硬盘/i.test(raw)) return 'ssd'
  return 'gpu'
}

const WHITE_SUFFIX = { mem: '白配内存', ssd: '白牌固态', gpu: '白牌芯片' }

/** 原文没写数量单位时按品类补：内存按根、硬盘按块、显卡按张，其余按台 */
function unitOfCat(item) {
  const cat = String((item && item.cat) || '')
  if (/内存条/.test(cat)) return '根'
  if (/硬盘/.test(cat)) return '块'
  if (/加速卡|消费级显卡/.test(cat) && !(item && item.whole)) return '张'
  return '台'
}

/* 显卡简称别名：聊天里常写 Pro6000 / PRO 6000MAX-Q / PRO 6000ADA / PRO 4500，
   型号库标准写法是「RTX PRO 6000 Max-Q 72G」「RTX 6000 Ada 48G」「RTX PRO 4500 Blackwell 32G」。
   只补到库里的完整型号才匹配得上；原文后面已经写了显存容量时只补基础型号，让容量自己参与匹配 */
const GPU_ALIAS_RULES = [
  { re: /(RTX\s*)?PRO\s*6000\s*MAX\s*-?\s*Q/gi, base: 'RTX PRO 6000 Max-Q', full: 'RTX PRO 6000 Max-Q 72G' },
  { re: /(RTX\s*)?PRO\s*6000\s*ADA/gi, base: 'RTX 6000 Ada', full: 'RTX 6000 Ada 48G' },
  { re: /(RTX\s*)?PRO\s*6000/gi, base: 'RTX PRO 6000', full: '' },
  { re: /(RTX\s*)?PRO\s*4500/gi, base: 'RTX PRO 4500', full: 'RTX PRO 4500 Blackwell 32G' }
]

function aliasDeviceText(text) {
  let out = String(text == null ? '' : text)
  GPU_ALIAS_RULES.forEach((rule) => {
    out = out.replace(rule.re, (m, rtx, offset, str) => {
      /* 原文已经带 RTX：保持原样，剩下的交给型号库 */
      if (rtx) return m
      const rest = str.slice(offset + m.length, offset + m.length + 6)
      if (!rule.full || /^\s*\d{2,3}\s*[Gg][Bb]?(?![A-Za-z0-9])/.test(rest)) return rule.base
      return rule.full
    })
  })
  /* 「A100 80G定制」对库里「A100 80G 定制版」 */
  return out.replace(/(\d{2,3}\s*[Gg])\s*定制(?!版|机)/g, '$1 定制版')
}

/* CPU 配置清单：「现货：i5-14500、i7-14700K」「U5-245K U7-265K U9-285K」。
   这些是整机的可选配置，不是整机型号；不剔掉的话它们的核心会反过来把整机候选排除
   （例如 X3-8000 那条带 i5-14500 后匹配不到）。必须带连字符，避免误伤 R570 / R770 这类整机型号 */
const CPU_OPTION_RE = /(?:i[3579]|u[3579]|r[3579])\s*[-‐-―−－﹣]\s*\d{3,5}[a-z]{0,3}/gi

function withoutCpuOptions(text) {
  return String(text == null ? '' : text).replace(CPU_OPTION_RE, ' ')
}


/** 数字是否在归一化文本里独立成段：P5530 里夹带的 530 不算 530 系列 */
function standaloneNum(hay, num) {
  return new RegExp('(^|[^0-9a-z])' + num + '(?![0-9a-z])').test(hay)
}

/* 通用规格词不能当型号后缀用（ddr5 / pcie / gpu …），否则会同时命中同规格的一大批型号 */
const GENERIC_CORES = ['cpu', 'gpu', 'ddr3', 'ddr4', 'ddr5', 'rdimm', 'lrdimm', 'sodimm', 'dimm',
  'ecc', 'recc', 'nvme', 'sata', 'ssd', 'hdd', 'pcie', 'sxm', 'nvl', 'oam', 'hbm', 'bios', 'ocp']

/**
 * 网卡简写：「cx7 单口 400G」「CX-7 双口 200G」。
 * 型号库里是 ConnectX-7 / ConnectX-6，单独按速率与端口挑对应那条。
 */
function nicSpecOf(text) {
  const s = String(text || '')
  const genM = s.match(/(?:^|[^a-z])(?:c\s*x|connectx)\s*-?\s*([3-9])(?![0-9])/i)
  if (!genM) return null
  return {
    gen: genM[1],
    ports: /单口/.test(s) ? '单口' : /双口/.test(s) ? '双口' : /四口/.test(s) ? '四口' : '',
    speed: safeCapacity(s)
  }
}

/**
 * 在型号库里找最匹配的一条。
 * 打分：原文完整包含型号 > 核心型号全命中（再按容量 / 整机 / 品牌加分）。
 * 同分时优先「整机标志与原文一致」，再优先更短的型号（避免原文没写 141G 却挑中 141G 那条）。
 */
function pickDevice(text, index) {
  const list = index || []
  const raw = aliasDeviceText(String(text || ''))
  if (!list.length || !raw) return null
  const hay = M.normSearch(raw)
  /* 电源功率写法「2*1500W」不是型号的一部分，剔掉再抽型号核心，避免 1500W 被当成必填型号 */
  const POWER_RE = /\d+\s*[*×xX]\s*\d{2,4}\s*[wW]\b/g
  const modelRaw = raw.replace(POWER_RE, ' ')
  /* 型号库完全不认识的英文串（微信号、备注词）不参与匹配，否则 H100 会被 abc123 拖垮 */
  const knownCores = (arr) => {
    const known = arr.filter((c) => list.some((it) => it.norm.indexOf(c) > -1))
    return known.length ? known : arr
  }
  const cores = knownCores(M.modelCoreOf(withoutCpuOptions(modelRaw)))
  const cap = safeCapacity(raw)
  const whole = /整机|\d+\s*卡/.test(raw)
  const iface = ifaceOf(raw)
  const white = /白牌|白片|白卡/.test(raw)
  /* 「H200 桥接器 2 路」是桥接配件，不能落到 H200 加速卡上 */
  const bridgeOnly = /桥接器|桥接卡|nvlink\s*bridge|nvlink\s*桥/i.test(raw)
  const mem = memSpecOf(raw)
  const ssd = ssdSpecOf(raw)
  const gpuCodes = gpuCodesOf(raw)
  /* CPU 简写：8558cpu / 至强 8558 → 型号库 Xeon Platinum 8558。
     有 cpu / 处理器 / 至强 / 颗 这类线索才抽 4 位型号号，避免把价格当型号 */
  const cpuCue = /cpu|处理器|至强|铂金|xeon|颗/i.test(raw)
  const cpuM = cpuCue ? raw.replace(/cpu|处理器|至强|铂金|xeon|intel|英特尔/gi, ' ')
    .match(/(?:^|[^0-9])(\d{4}[a-z]?)(?![0-9a-z])/) : null
  const cpuSku = cpuM ? cpuM[1].toLowerCase() : ''
  const cpuHitOf = (it) => !!cpuSku && new RegExp('(?:^|[^0-9])' + cpuSku + '(?![0-9a-z])').test(it.norm)
  const nic = nicSpecOf(raw)
  const nicHitOf = (it) => !!(nic && /网络设备|网卡|DPU/.test(it.cat) &&
    it.norm.indexOf('connectx' + nic.gen) > -1)
  /* 型号后缀：5070TI / 4070 SUPER 要落到同后缀的型号，不能只按数字挑最便宜的那条 */
  const tiCard = /\d{4}\s*ti(?![a-z])/i.test(raw)
  const superCard = /\d{4}\s*super(?![a-z])/i.test(raw)
  const cardUnit = /(?:\d+\s*)?(?:张|片)/.test(raw)
  /* 整机 / 服务器描述里出现的 128G、2T 多是内存和存储配置，不能当内存条 / 固态的型号依据 */
  const serverish = /服务器|准系统|主板|整机|盘位|超聚变|浪潮|华硕|戴尔|联想|惠普|H3C|华为/i.test(raw)
  const memWord = /内存|内存条|ddr[345]|rdimm|lrdimm|sodimm|ecc|recc/i.test(raw) ||
    /* 按条 / 根计数又写了容量：三星64G 5600 1600条，即使带 H3C 这类整机品牌词也按内存处理 */
    (/(?:条|根)/.test(raw) && /(?:^|[^A-Za-z0-9])\d{2,3}\s*G(?:B)?(?![A-Za-z0-9])/i.test(raw))
  const ssdWord = /nvme|sata|ssd|固态|u\.2/i.test(raw)
  const memCtx = !serverish || memWord
  const ssdCtx = !serverish || ssdWord
  const scored = []
  /* 只看商品行：前面挂的城市 / 换群栏目行不参与型号严谨校验 */
  const listingText = raw.split('\n').map((x) => x.trim()).filter(Boolean).filter(isListingLine).join('\n')
  /* 型号库里没有的核心多是批次 / 成色噪声（DC24）或「品牌+容量」（sk64），
     不作为必须覆盖的条件，否则会把能匹配的型号全部排除 */
  const coreSrc = (listingText || raw).replace(POWER_RE, ' ')
  /* 内存行里「三星H3C双标」的 H3C 是整套服务器品牌，不是内存型号：
     它会把内存候选全部判成「未覆盖」而识别失败，内存行先剔掉整机品牌词 */
  const memCoreSrc = memWord ? coreSrc.replace(/超聚变|浪潮|华硕|戴尔|联想|惠普|H3C|华为/gi, ' ') : coreSrc
  const inputCores = M.modelCoreOf(withoutCpuOptions(memCoreSrc)).filter((c) => list.some((it) => it.norm.indexOf(c) > -1))
  const strictNums = strictModelNums(withoutCpuOptions(memCoreSrc))

  list.forEach((it, order) => {
    /* 桥接器只可能在配件目录里；配件目录没有对应型号时不匹配，别当成加速卡 */
    if (bridgeOnly && it.cat !== '服务器配件') return
    /* 容量写明且不一致：不同规格，直接排除（80G 不能命中 40G） */
    if (cap && it.cap && cap !== it.cap) return
    const brand = M.normSearch(it.brand)
    let score = 0
    /* 极短型号（P5 / T4 / S60）必须独立成段：P5 不能命中 960GBP5530 里的「P5530」 */
    const normHit = it.norm && (it.norm.length <= 3 ? standaloneNum(hay, it.norm) : hay.indexOf(it.norm) > -1)
    if (normHit) {
      /* 完整型号出现：按型号长度加权，长型号优先 */
      score = 800 + Math.min(it.norm.length, 40) * 20
    } else if (cores.some((c) => c.length >= 5 && it.norm.indexOf(c) === 0)) {
      /* 型号与容量连写：H10080G → H100 80G；只认 5 位以上长核心，避免 h100 命中所有 H100 变体 */
      score = 810
      if (cap && it.cap === cap) score += 100
      if (whole && it.whole) score += 150
    } else if (cores.length && it.core.length && it.core.every((c) => cores.indexOf(c) > -1)) {
      score = 800
      if (cap && it.cap === cap) score += 100
      if (whole && it.whole) score += 150
      if (brand && hay.indexOf(brand) > -1) score += 30
    } else if (cores.length && brand && hay.indexOf(brand) > -1 && coreAligned(cores, it)) {
      /* 型号连写且带品牌：海光K100Ai → DCU K100-AI；没有品牌不兜底，避免 S2000 落到别家硬盘 */
      score = 830
      if (cap && it.cap === cap) score += 100
      if (whole && it.whole) score += 150
    } else if (cpuSku && it.cat === 'CPU 处理器' && cpuHitOf(it)) {
      /* 8558cpu 这类简写：只给了 CPU 型号号，落到 Xeon Platinum 8558 */
      score = 790
      if (brand && hay.indexOf(brand) > -1) score += 40
    } else if (nicHitOf(it)) {
      /* cx7单口400g：按代数 + 速率 + 端口落到具体那条网卡 */
      score = 800
      if (nic.speed && it.cap === nic.speed) score += 120
      if (nic.ports && it.norm.indexOf(nic.ports) > -1) score += 60
      if (nic.speed && it.cap && it.cap !== nic.speed) score -= 200
    } else if (mem.hint && it.cat === '内存条' && memCtx) {
      /* 内存：品牌 + 容量 + 频率 + DDR 代数；「三星 64 4800」这种省略 G 的写法也能对上。
         频率档位型号库没有时（2933 / 5200 等）按频率推断 DDR 代数，同容量同代数里挑最接近的 */
      if (mem.cap && it.cap !== mem.cap) return
      if (mem.ddr && it.norm.indexOf('ddr' + mem.ddr) < 0) return
      if (!mem.ddr && mem.freq) {
        const other = ddrOfFreq(mem.freq) === '5' ? '4' : '5'
        if (it.norm.indexOf('ddr' + other) > -1) return
      }
      if (mem.brand && !white && it.brand !== mem.brand) return
      score = 760
      if (mem.cap) score += 60
      if (mem.freq) {
        if (it.norm.indexOf(mem.freq) > -1) score += 120
        else {
          /* 型号库没有这个频率：按与原文频率的差距扣分，越接近越优先 */
          const itFreq = memFreqOfModel(it.model)
          if (itFreq) score -= Math.min(Math.abs(Number(itFreq) - Number(mem.freq)) / 100, 12)
        }
      }
      /* 写了 SODIMM / RDIMM / LRDIMM：同形态优先，形态不符扣分 */
      const memForm = /sodimm/i.test(raw) ? 'sodimm' : /lrdimm/i.test(raw) ? 'lrdimm' : /rdimm/i.test(raw) ? 'rdimm' : ''
      if (memForm) {
        const itForm = /sodimm/i.test(it.model) ? 'sodimm' : /lrdimm/i.test(it.model) ? 'lrdimm' : /rdimm/i.test(it.model) ? 'rdimm' : ''
        if (itForm === memForm) score += 40
        else if (itForm) score -= 60
      }
      if (brand && hay.indexOf(brand) > -1) score += 40
    } else if (ssd && it.cat === '固态硬盘' && ssdCtx) {
      /* 固态：按容量与接口（NVMe / SATA）匹配，990 PRO 这种纯数字前缀也能对上 */
      if (ssd.cap && ssdCapOf(it.model) !== ssd.cap) return
      if (mem.brand && !white && it.brand !== mem.brand) return
      const itIface = /nvme/i.test(it.model) ? 'nvme' : /sata/i.test(it.model) ? 'sata' : /u\.2/i.test(it.model) ? 'u.2' : ''
      if (ssd.iface && itIface && ssd.iface !== itIface) return
      score = 750
      if (ssd.cap) score += 60
      if (ssd.iface && itIface === ssd.iface) score += 40
      /* 系列号（990 / 870 / 980）出现在原文里：优先同系列，避免只按容量挑错型号；
         必须独立成段，960GBP5530 里夹带的 530 不能算酷鱼 530 系列 */
      const series = it.model.match(/\d{3,4}/g) || []
      if (series.some((n) => standaloneNum(hay, n))) score += 100
      if (mem.brand && hay.indexOf(mem.brand) > -1) score += 40
    } else if (gpuCodes.length && (it.cat === '消费级显卡' || it.cat === 'GPU 加速卡') &&
      gpuCodes.some((c) => it.norm.indexOf(c) > -1)) {
      /* 纯数字显卡型号：原文只写 5090 / 4090 / 3080 时也能选中 */
      score = 720
      if (cap && it.cap === cap) score += 100
      if (brand && hay.indexOf(brand) > -1) score += 60
      if (/涡轮/.test(raw) && /涡轮/.test(it.model)) score += 40
      if (/风扇|风冷/.test(raw) && /风扇/.test(it.model)) score += 40
      if (tiCard) score += /ti(?![a-z])/i.test(it.model) ? 60 : -200
      if (superCard) score += /super/i.test(it.model) ? 60 : -200
    } else if (cores.length === 1 && cores[0].length >= 3 && /[a-z]/.test(cores[0]) && /\d/.test(cores[0]) &&
      GENERIC_CORES.indexOf(cores[0]) < 0 && it.core.indexOf(cores[0]) > -1) {
      /* 只写型号里的一个片段：sd1准系统 → 技嘉 G593-SD1。
         片段必须同时带字母和数字（sd1 / h200），避免把 ddr5、gpu 这类通用词当型号 */
      score = 770
      if (cap && it.cap === cap) score += 100
      if (whole && it.whole) score += 150
      if (brand && hay.indexOf(brand) > -1) score += 40
    }
    if (!score) return
    /* 按「张 / 片」卖的卡优先落到加速卡 / 消费级显卡，不选整机 */
    if (cardUnit && !it.whole && /加速卡|消费级显卡/.test(it.cat)) score += 40
    /* 白牌优先选白牌型号；没写白牌时不要误选白牌 */
    if (white) score += it.brand === '白牌' ? 200 : -60
    else if (it.brand === '白牌') score -= 80
    /* 原文型号必须被候选覆盖：300I A2 不能落到 A2 16G，300I 3010 不能落到 300I Pro
       （cx7 这种网卡简写按代数匹配，不走核心覆盖校验） */
    if (!coresCovered(inputCores, it.norm) && !nicHitOf(it)) return
    if (strictNums.some((n) => it.norm.indexOf(n) < 0)) return
    /* 原文写了接口：同接口加分，不同接口重罚（SXM 不选 PCIe） */
    if (iface) {
      const itIf = ifaceOf(it.model)
      if (itIf === iface) score += 80
      else if (itIf) score -= 500
    }
    if (score < 700) return
    scored.push({ item: it, score, order })
  })

  if (!scored.length) return null
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    /* 同分时优先型号名以核心型号开头的（H100 80G 优于 DGX H100） */
    const ap = a.item.core.length ? a.item.norm.indexOf(a.item.core[0]) : -1
    const bp = b.item.core.length ? b.item.norm.indexOf(b.item.core[0]) : -1
    if (ap !== bp) return ap - bp
    const aw = a.item.whole === whole ? 1 : 0
    const bw = b.item.whole === whole ? 1 : 0
    if (bw !== aw) return bw - aw
    if (b.item.norm.length !== a.item.norm.length) return a.item.norm.length - b.item.norm.length
    return a.order - b.order
  })
  const best = scored[0]
  /* 前两名同分、且正好是 SXM / PCIe 两种接口 → 让用户确认接口 */
  const bestIf = ifaceOf(best.item.model)
  const secondIf = scored.length > 1 ? ifaceOf(scored[1].item.model) : ''
  const ambiguous = scored.length > 1 && scored[1].score === best.score &&
    !!bestIf && !!secondIf && bestIf !== secondIf && !iface
  /* 内存匹配的兜底情况：频率不在库 / 品牌没写 / 规格没写，都提示用户确认 */
  const memPick = !!(mem.hint && best.item.cat === '内存条')
  /* 原文可能并列多个频率（4800,5600,6400），只要有一个在库里就不算缺频率 */
  const freqList = String(raw).match(/\b(?:2133|2400|2666|2933|3200|3600|4000|4400|4800|5200|5600|6000|6400|7200|8000|8800)\b/g) || []
  const freqHit = freqList.some((f) => best.item.norm.indexOf(f) > -1)
  const memFreqMiss = !!(memPick && mem.freq && !freqHit)
  const memBrandMiss = !!(memPick && !mem.brand)
  const memSpecMiss = !!(memPick && !mem.freq && !mem.ddr)
  return {
    item: best.item,
    score: best.score,
    ambiguous,
    memFreqMiss,
    memBrandMiss,
    memSpecMiss,
    freq: mem.freq
  }
}

/* ---------- 字段抽取 ---------- */

/** 数字串转数值：1,000 → 1000 */
function numOf(v) {
  return Number(String(v == null ? '' : v).replace(/,/g, ''))
}

function pickMinQty(text) {
  const s = String(text || '')
  /* 先认「8 台起订」这种数量在前面的写法；台与起订必须在同一行，避免把上一行总数当起订 */
  const suffix = s.match(new RegExp('(\\d[\\d,]*)\\s*' + UNIT_ALT + '[ \\t]*(?:起订|起批|起)'))
  if (suffix) return { value: String(numOf(suffix[1])), span: suffix[0] }
  const prefix = s.match(new RegExp('(?:起订量|起批量|起订|起批|至少|最少|最低)\\s*[:：]?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(万)?\\s*(?:' + UNIT_TAIL + ')?'))
  if (prefix) {
    const n = numOf(prefix[1]) * (prefix[2] ? 10000 : 1)
    return { value: String(Math.round(n)), span: prefix[0] }
  }
  return { value: '', span: '' }
}

/** 每批上限：「最多 2048 台」「单批不超过 2048」；不是数量的百分比会被排除 */
function pickMaxQty(text) {
  const s = String(text || '')
  /* (?![0-9]) 防止「最多 30%」回溯成 3 被当成上限 */
  const m = s.match(new RegExp('(?:每批|单批|每单|单次|一批)?\\s*(?:最多|最高|上限|至多|不超过)\\s*[:：]?\\s*([\\d,]+)(?![0-9])\\s*(?:' + UNIT_TAIL + ')?(?!\\s*[%％])'))
  if (!m) return { value: '', span: '' }
  const n = numOf(m[1])
  if (!(n > 0)) return { value: '', span: '' }
  return { value: String(Math.round(n)), span: m[0] }
}

/** 先去掉时间 / 比例 / 批次数字，再识别数量，避免「1 个工作日内」被当成 1 台 */
function stripNonQty(text) {
  return String(text || '').replace(NON_QTY_RE, ' ')
}

/** 中文数字转数值：八 → 8，十二 → 12，两百 → 200，十万 → 100000 */
const CN_DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
function cnNum(str) {
  let total = 0
  let section = 0
  let num = 0
  for (const ch of String(str || '')) {
    if (CN_DIGIT[ch] != null) num = CN_DIGIT[ch]
    else if (ch === '十') { section += (num || 1) * 10; num = 0 }
    else if (ch === '百') { section += (num || 1) * 100; num = 0 }
    else if (ch === '千') { section += (num || 1) * 1000; num = 0 }
    else if (ch === '万') { total += (section + num) * 10000; section = 0; num = 0 }
  }
  return total + section + num
}

function pickQty(text, skip) {
  let s = stripNonQty(text)
  const spans = Array.isArray(skip) ? skip : (skip ? [skip] : [])
  spans.forEach((span) => {
    if (span) s = s.split(span).join(' ')
  })

  /* 「数量：128」「数量43」字段写法：没写台 / 张也按台识别 */
  const labeled = s.match(/(?:数量|台数|总量|总数|库存)\s*(?:[:：]\s*)?([\d,]+(?:\.\d+)?)\s*(万)?\s*(台|张|片|套|个|根|条|组|颗)?/)
  if (labeled) {
    const n = numOf(labeled[1]) * (labeled[2] ? 10000 : 1)
    return { value: String(Math.round(n)), unit: labeled[3] || '台' }
  }

  /* 优先「总数 / 库存 1 万台」这类总量写法 */
  const total = s.match(new RegExp('(?:总数|总量|共计|合计|总共|一共|库存|现货|共)\\s*(?:有|为|是|约|达)?\\s*([\\d,]+(?:\\.\\d+)?)\\s*(万)?\\s*(' + UNIT_TAIL + ')'))
  if (total) {
    const n = numOf(total[1]) * (total[2] ? 10000 : 1)
    return { value: String(Math.round(n)), unit: total[3] }
  }

  /* 「1 万台」没有总量前缀时，也按万台理解 */
  const wanQty = s.match(new RegExp('([\\d,]+(?:\\.\\d+)?)\\s*万\\s*(' + UNIT_TAIL + ')'))
  if (wanQty) {
    const n = numOf(wanQty[1]) * 10000
    return { value: String(Math.round(n)), unit: wanQty[2] }
  }

  const m = s.match(UNIT_RE)
  if (m) return { value: String(numOf(m[1])), unit: m[2] }
  /* 「8×H100」「8*4090」写法：乘号前是数量；2*1500W 是电源功率，不算数量 */
  const times = s.match(/(\d{1,4})\s*[×*]\s*(?=[A-Za-z0-9])/)
  if (times && !/^[\d,]*\s*[wW]\b/.test(s.slice(times.index + times[0].length))) {
    return { value: times[1], unit: '张' }
  }
  /* 中文数量：八台 / 十二张 / 两百台 / 十万片 */
  const cn = s.match(new RegExp('([零〇一二两三四五六七八九十百千万]{1,6})\\s*(' + UNIT_TAIL + ')'))
  if (cn) {
    const n = cnNum(cn[1])
    if (n > 0) return { value: String(n), unit: cn[2] }
  }
  return { value: '', unit: '台' }
}

/** 取命中位置前后一小段，用来判断币种 / 总价口径，避免被远处的「总价」字样带偏 */
function aroundOf(s, i, len, pad) {
  const p = pad || 12
  const start = Math.max(0, (i || 0) - p)
  return s.slice(start, Math.min(s.length, (i || 0) + (len || 0) + p))
}

function pickCurrency(text) {
  const s = String(text || '')
  for (let i = 0; i < CURRENCY_RULES.length; i++) {
    if (CURRENCY_RULES[i].re.test(s)) return CURRENCY_RULES[i].code
  }
  return 'CNY'
}

/**
 * 价格：先判区间，再逐个找「万 / w」，最后按「元」；「共 XX 万」按数量折算单价。
 * 数量写法（1 万台）、功率写法（1000W 电源）都会被跳过；币种按命中位置判断。
 */
function pickPrice(text, qty) {
  const out = { price: '', priceMax: '', priceMode: 'fixed', currency: '', warnings: [] }
  const s = String(text || '')

  /* 价格区间：12万-14万 / 12万-14 / 12-14万；后面紧跟台 / 张时是数量区间，不算价格 */
  const isQtyUnitAfter = (m) => new RegExp('^\\s*(?:' + UNIT_TAIL + '|卡)').test(s.slice(m.index + m[0].length))
  const rangeRes = [
    /(\d+(?:\.\d+)?)\s*(?:万|[wW])\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*(?:万|[wW])?/,
    /(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*(?:万|[wW])/
  ]
  let rangeWan = null
  for (let i = 0; i < rangeRes.length; i++) {
    const m = s.match(rangeRes[i])
    if (m && !isQtyUnitAfter(m)) { rangeWan = m; break }
  }
  if (rangeWan) {
    out.price = String(Math.round(Number(rangeWan[1]) * 10000))
    out.priceMax = String(Math.round(Number(rangeWan[2]) * 10000))
    out.priceMode = 'range'
    out.currency = pickCurrency(aroundOf(s, rangeWan.index, rangeWan[0].length, 10))
    return out
  }
  const rangeYuan = s.match(/[¥￥]\s*([\d,]+)\s*[-~至到]\s*[¥￥]?\s*([\d,]{3,})/) ||
    s.match(/([\d,]{4,})\s*[-~至到]\s*([\d,]{4,})\s*元/)
  if (rangeYuan) {
    out.price = String(numOf(rangeYuan[1]))
    out.priceMax = String(numOf(rangeYuan[2]))
    out.priceMode = 'range'
    out.currency = pickCurrency(aroundOf(s, rangeYuan.index, rangeYuan[0].length, 10))
    return out
  }
  /* 估价写法「含税17xxx」「1xx 万」：x 是占位符，按 17000-18000 / 100万-200万 的区间价处理 */
  const xPrice = s.match(/(\d{1,4})\s*([xX×✕*＊]{2,4})\s*(万)?/)
  if (xPrice) {
    const digits = xPrice[1]
    const k = xPrice[2].length
    const mult = xPrice[3] ? 10000 : 1
    const low = Number(digits) * Math.pow(10, k) * mult
    if (low > 0) {
      out.price = String(Math.round(low))
      out.priceMax = String(Math.round((Number(digits) + 1) * Math.pow(10, k) * mult))
      out.priceMode = 'range'
      out.currency = pickCurrency(aroundOf(s, xPrice.index, xPrice[0].length, 10))
      out.warnings.push('原文价格「' + xPrice[0].replace(/\s+/g, '') + '」为省略写法，已按 ' + out.price + '-' + out.priceMax + ' 区间填写，请核对')
      return out
    }
  }
  let value = 0
  let hitIndex = -1
  let hitLen = 0
  /* 「报价：673」「价格：25万」「单价：250,000」：有字段标签时以它为准，不再按总价折算 */
  const unitPrice = s.match(/(?:单价|报价|价格|售价)\s*[:：]?\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)\s*(万|[wW])?/)
  if (unitPrice) {
    let v = numOf(unitPrice[1])
    const unit = unitPrice[2]
    if (unit) v = Math.round(v * 10000)
    if (v > 0) {
      out.price = String(v)
      out.currency = pickCurrency(aroundOf(s, unitPrice.index, unitPrice[0].length, 10))
      /* 报价没写「万」或「元」时按元填写，提醒用户核对单位 */
      if (!unit && v < 1000) out.warnings.push('原文报价未写单位，已按元填入，请核对')
      return out
    }
  }
  /* 「万 / w」可能有多个，逐个检查：紧跟台 / 张 / 套的是数量，紧跟电源 / 功率的是瓦数 */
  const wanRe = /[¥￥]?\s*([\d,]+(?:\.\d+)?)\s*(万|w|W)/g
  let wan = null
  while ((wan = wanRe.exec(s))) {
    const n = Number(wan[1].replace(/,/g, ''))
    if (!(n > 0)) continue
    const tail = s.slice(wanRe.lastIndex, wanRe.lastIndex + 6)
    if (new RegExp('^\\s*(?:' + UNIT_TAIL + '|卡)').test(tail)) continue
    if (/^\s*(电源|功率|瓦)/.test(tail)) continue
    /* 「w」只在数值不大、且前面不是功率描述时才算「万」 */
    if (wan[2] !== '万' && (n > 999 || /电源|功率/.test(s.slice(Math.max(0, wan.index - 6), wan.index)))) continue
    value = Math.round(n * 10000)
    hitIndex = wan.index
    hitLen = wan[0].length
    break
  }
  if (!value) {
    const yuan = s.match(/[¥￥]\s*([\d,]+(?:\.\d+)?)|([\d,]{3,})\s*(?:元|块)/)
    if (yuan) {
      value = Number((yuan[1] || yuan[2]).replace(/,/g, ''))
      hitIndex = yuan.index
      hitLen = yuan[0].length
    }
  }
  /* 聊天广告常用「含税💰5180」这类无单位写法 */
  if (!value) {
    const money = s.match(MONEY_RE)
    if (money) {
      value = Number(money[1].replace(/,/g, ''))
      hitIndex = money.index
      hitLen = money[0].length
    }
  }
  /* 「7600含税」「14600 包税」：金额在前、含税在后 */
  if (!value) {
    const taxed = s.match(/([\d,]{3,}(?:\.\d+)?)\s*(?:含税|包税|未税|不含税)/)
    if (taxed) {
      value = numOf(taxed[1])
      hitIndex = taxed.index
      hitLen = taxed[0].length
    }
  }
  /* 「18000 美金」「USD 18000」：金额与币种写在一起 */
  if (!value) {
    const cur = s.match(CUR_SUFFIX_RE) || s.match(CUR_PREFIX_RE)
    if (cur) {
      value = numOf(cur[1])
      hitIndex = cur.index
      hitLen = cur[0].length
    }
  }

  /* 「三星 64 4800」「64g 3200」：带数量单位的报价常把单价写成裸数字，取最后一个 3-6 位数字 */
  if (!value && new RegExp(UNIT_ALT).test(s)) {
    let scan = s.replace(new RegExp('(\\d[\\d,]*)\\s*(?:余|多|\\+)?\\s*' + UNIT_ALT, 'g'), ' ')
    /* 字段行里的数字是规格不是价格：频率:4800,5600,6400 / 容量:16G/32G 不能被当成报价 */
    scan = scan.replace(/(?:容量|频率|品牌|可收|规格|配置|型号|代别)\s*[:：][^\n]*/g, ' ')
    /* 型号 / 容量里的数字不算价格：H100、64G、1000W（容量先剥，避免「g 3200」被当成型号） */
    scan = scan.replace(/\d+\s*(?:[Gg][Bb]?|[Tt][Bb]?|[Ww])/g, ' ')
    /* 内存条按条 / 根卖时，四位频率（5600 / 4800）不是报价：三星64G 5600 1000条 */
    const memLine = /内存|内存条|ddr|rdimm|lrdimm|sodimm|ecc/i.test(s) ||
      (/(?:条|根)/.test(s) && /(?:^|[^A-Za-z0-9])\d{2,3}\s*G(?:B)?(?![A-Za-z0-9])/.test(s))
    if (memLine) scan = scan.replace(MEM_FREQ_ALL_RE, ' ')
    scan = scan.replace(/(^|[^A-Za-z0-9])[A-Za-z]{1,8}\s*-?\s*\d{1,6}[A-Za-z]{0,3}/g, '$1')
    const bare = /(^|[^\dA-Za-z.])(\d{3,6})(?![\dA-Za-z])/g
    let bm
    let last = null
    while ((bm = bare.exec(scan))) {
      const tail = scan.slice(bm.index + bm[0].length, bm.index + bm[0].length + 4)
      /* 后面跟「风扇 / 卡 / 台 / 元」等还是规格或数量，不当价格 */
      if (/^(?:风扇|显卡|卡|台|张|片|套|个|根|条|组|颗|元|块|万|g|G)/.test(tail)) continue
      last = { v: Number(bm[2]), index: bm.index + bm[1].length, len: bm[2].length }
    }
    if (last) {
      value = last.v
      hitIndex = last.index
      hitLen = last.len
    }
  }

  if (value > 0) {
    const q = Number(qty) || 0
    /* 只在金额附近判断「总价」，避免远处的「总价格组成」把单价也折算掉 */
    if (TOTAL_RE.test(aroundOf(s, hitIndex, hitLen, 18))) {
      if (q > 0) {
        value = Math.round(value / q)
        out.warnings.push('原文为总价，已按 ' + q + ' 台折算单价')
      } else {
        out.warnings.push('原文为总价，未识别到数量，请核对单价')
      }
    }
    out.price = String(value)
    out.currency = pickCurrency(aroundOf(s, hitIndex, hitLen, 10))
    return out
  }
  /* 没有任何具体金额才走议价，避免「面议」盖掉已识别的单价 */
  if (/面议|价格待定|电议|价格可议|单价可议|报价可议/.test(s)) {
    out.priceMode = 'nego'
    out.currency = pickCurrency(s)
  }
  return out
}

function pickCond(text) {
  const s = String(text || '')
  if (/99新|98新|97新|充新|准新|拆封未用/.test(s)) return { condType: 'used', condLevel: '95新' }
  if (/95新|九五新/.test(s)) return { condType: 'used', condLevel: '95新' }
  if (/9成新|九成新/.test(s)) return { condType: 'used', condLevel: '9成新' }
  if (/8成新|八成新/.test(s)) return { condType: 'used', condLevel: '8成新' }
  if (/7成新|七成新|6成新|六成新|5成新|五成新/.test(s)) return { condType: 'used', condLevel: '7成新及以下' }
  /* 拆机 / DC24 / DC25 都是二手货，没写具体成色时按 9 成新 */
  if (/二手|拆机|拆机件|翻新|使用过|dc\s*2[45]/i.test(s)) return { condType: 'used', condLevel: '9成新' }
  /* 没提拆机 / DC 编号的一律按全新 */
  return { condType: 'new', condLevel: '9成新' }
}

/** 条件组：只映射发布页 GROUPS 里真实存在的选项值 */
function pickGroups(text) {
  const s = String(text || '')
  const out = {}
  /* 现货优先：广告里常写「现货期货均可」；没提期货相关词时一律按现货 */
  if (/现货|有货|在库|现机/.test(s)) out.supply = '现货'
  else if (/期货|排单|预定|预售|远期|订货/.test(s)) out.supply = '期货'
  else out.supply = '现货'

  if (/不含税|未税|不开票/.test(s)) out.tax = '不含税'
  else if (/专票|增值税专用/.test(s)) out.tax = '可开专票'
  else if (/普票/.test(s)) out.tax = '可开普票'
  else if (/含税|包税/.test(s)) out.tax = '含税'

  /* 自提只说提货方式，不代表当天可提，不映射到交付时间 */
  if (/当日可提|当天可提|当天提|今日提|即刻提|随时提/.test(s)) out.deliver = '当日可提'
  else if (/3\s*天内|三天内|72\s*小时/.test(s)) out.deliver = '3 天内'
  else if (/7\s*天内|一周内|七天内|5\s*个?工作日/.test(s)) out.deliver = '7 天内'
  else if (/30\s*天内|一个月内|月内/.test(s)) out.deliver = '30 天内'

  if (/月付/.test(s)) out.pay = '月付'
  else if (/季付/.test(s)) out.pay = '季付'
  else if (/半年付/.test(s)) out.pay = '半年付'
  else if (/年付/.test(s)) out.pay = '年付'

  if (/闭口价|不议价/.test(s)) out.closed = '闭口价（不议价）'
  else if (/开口价|可议价|价格可议|单价可议|报价可议|批量可议/.test(s)) out.closed = '开口价（可议价）'

  if (/免押|无押金|零押金/.test(s)) out.deposit = '免押金'
  else if (/2\s*个月租金|押二/.test(s)) out.deposit = '2 个月租金'
  else if (/1\s*个月租金|押一/.test(s)) out.deposit = '1 个月租金'

  return out
}

/** 租期：只认「N 个月起租」并落在既有候选项里 */
function pickRentTerm(text) {
  const m = String(text || '').match(/(\d+)\s*个\s*月\s*(?:起租|起)/)
  if (!m) return ''
  const v = m[1] + ' 个月'
  return RENT_TERMS.indexOf(v) > -1 ? v : ''
}

/* ---------- 条件与流程 ---------- */

/** 必须 / 可协商条件：只在页面预设文案里命中，不自由生成 */
function pickConds(text, opts) {
  const o = opts || {}
  const presets = o.presets || {}
  const s = String(text || '')
  const mustList = presets[o.side] || []
  const negoList = (o.rent ? presets.negoRent : presets.nego) || []
  const hit = (v) => s.indexOf(v) > -1
  return {
    must: mustList.filter(hit).slice(0, 20),
    nego: negoList.filter(hit).slice(0, 20)
  }
}

/**
 * 支付节点：把「签约后付 30%」「到货后付 70%」这类条款收成流程步骤。
 * 只认带百分比的付款句，步骤说明放宽到 110 字，保留完整触发条件。
 */
function pickPaymentFlow(text) {
  const s = String(text || '').replace(/【|】|\[|\]/g, ' ')
  const lines = s.split(/[。；;\n]/).map((x) => x.trim()).filter(Boolean)
  const steps = []
  lines.forEach((line) => {
    if (!/支付|付款|打款|转账|预付|定金|首付|尾款|付/.test(line)) return
    if (!/(\d+(?:\.\d+)?)\s*[%％]/.test(line)) return
    /* 「预付 30%，到货付 70%」用逗号并列多个节点，按逗号再拆一次 */
    const ratioCount = (line.match(/(\d+(?:\.\d+)?)\s*[%％]/g) || []).length
    let segs = [line]
    if (ratioCount >= 2) {
      const parts = line.split(/[，,、]/).map((x) => x.trim()).filter(Boolean)
      const keep = parts.filter((p) => /\d+(?:\.\d+)?\s*[%％]/.test(p) && /付|支付|打款|转账|定金|首付|尾款|质保金|保证金/.test(p))
      if (keep.length) segs = keep
    }
    segs.forEach((seg) => {
      const ratio = seg.match(/(\d+(?:\.\d+)?)\s*[%％]/)
      if (!ratio) return
      const pct = Number(ratio[1])
      if (!(pct > 0 && pct <= 100)) return
      let label = '付款'
      /* 先认到货 / 验收，再认签约：付款句里常带「支付合同价款」，只按「合同」判断会误标 */
      if (/运抵|到货|到港|交付|验收|签收/.test(seg)) label = '到货付款'
      else if (/签约|签署|签订|合同/.test(seg)) label = '签约付款'
      else if (/预付|定金|首付/.test(seg)) label = '预付'
      const body = seg
        .replace(/^第[一二三四五六七八九十0-9]+[：:]\s*/, '')
        .replace(/(?:合同)?\s*总价款\s*[*＊×]\s*\d+(?:\.\d+)?\s*[%％]/g, '合同总价款的对应比例')
        .replace(/\s+/g, ' ')
        .trim()
      steps.push({ n: (label + ' ' + pct + '%').slice(0, 20), d: body.slice(0, 110) })
    })
  })
  if (steps.length > 12) return { flow: steps.slice(0, 12), warnings: ['支付节点超过 12 步，已截断'] }
  return { flow: steps, warnings: [] }
}

/** 交易流程：优先支付节点，其次按箭头 / 换行 / 分号拆句，只收像流程的短句 */
function pickFlow(text) {
  const pay = pickPaymentFlow(text)
  /* 两个以上支付节点时，条款型文本直接用支付节点当流程，比按箭头拆更准 */
  if (pay.flow.length >= 2) return pay

  let s = String(text || '')
  /* 「流程：验货 → 付款」「详细流程 1、…」先把前面的型号价格摘掉 */
  const mark = s.match(/(?:交易流程|成交流程|详细流程|流程|步骤)\s*[:：]?/)
  if (mark) {
    s = s.slice(mark.index + mark[0].length)
    /* 流程后面紧跟的「备注 / 说明 / 联系人」等字段不属于流程 */
    const nextField = s.search(/\n\s*(?:\d{1,2}\s*[.、)）]\s*)?(?:备注|说明|其他|其它|联系人|电话|手机|居间|佣金)\s*[:：]/)
    if (nextField >= 0) s = s.slice(0, nextField)
  }
  /* 分隔线、广告标语不属于流程步骤 */
  const usable = (t) => {
    const v = String(t || '').trim()
    if (v.length < 2) return false
    if (/^[-—_=*·•~.\s]+$/.test(v)) return false
    return !/^(?:性价比|现货为王|诚信|实力|欢迎|量大|价格从优)/.test(v)
  }
  let parts = []
  let numberedMode = false
  if (/[→➡⟶⇒]|->|~|-{2,}/.test(s)) {
    parts = s.split(/[→➡⟶⇒]|->|~|-{2,}/).map((x) => x.trim()).filter(Boolean)
  } else {
    const lines = s.split(/[\n；;]/).map((x) => x.trim()).filter(Boolean)
    /* 有「流程」标记时，后面的短句就是流程；顿号 / 逗号 / 分号并列的也一并拆开 */
    let seq = []
    if (mark) {
      /* 行内编号（「1. 验货 2. 付款」）先变成换行，再按箭头 / 顿号 / 逗号拆 */
      const body = s.replace(/\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]|\d{1,2}\s*[、)）]|\d{1,2}\s*[.．](?!\d))\s*/g, '\n')
      body.split(/[→➡⟶⇒]|->|~|[\n；;、，,]/).forEach((x) => {
        const t = x.replace(NUMBER_MARK, '').trim()
        if (/^(其他|备注|说明|补充)/.test(t)) return
        if (!usable(t) || t.length > 40) return
        seq.push(t)
      })
    }
    const hinted = lines.filter((x) => FLOW_HINT.test(x))
    if (seq.length >= 2) {
      parts = seq
      numberedMode = true
    } else if (seq.length === 1) {
      parts = seq
      numberedMode = true
    } else if (hinted.length >= 2) {
      parts = hinted
    }
  }
  parts = parts
    .map((x) => x.replace(NUMBER_MARK, '').trim())
    .filter((x) => x.length >= 2)

  /* 箭头 / 分行都凑不出流程时，先看句里有没有多个成交条款，再看支付节点，最后退到单个条款 */
  if (parts.length < 2) {
    if (parts.length === 1 && mark) return { flow: [{ n: parts[0].slice(0, 20), d: '' }], warnings: [] }
    const phrases = String(text || '').match(new RegExp(FLOW_PHRASE.source, 'g')) || []
    const uniq = phrases.filter((v, i) => phrases.indexOf(v) === i)
    if (uniq.length >= 2) return { flow: uniq.slice(0, 12).map((n) => ({ n: n.slice(0, 20), d: '' })), warnings: [] }
    if (pay.flow.length) return pay
    if (phrases.length) return { flow: [{ n: phrases[0].slice(0, 20), d: '' }], warnings: [] }
    return { flow: [], warnings: [] }
  }

  const warnings = []
  if (parts.length > 12) {
    parts = parts.slice(0, 12)
    warnings.push('交易流程超过 12 步，已截断')
  }
  const flow = parts.map((seg) => {
    /* 编号清单本身就是一步的说明，不再拆「名称：说明」 */
    if (numberedMode) return { n: seg.slice(0, 20), d: '' }
    const m = seg.match(/^([^：:]{1,12})[：:]\s*(.+)$/)
    const n = m ? m[1].trim() : seg.slice(0, 20)
    const d = m ? m[2].trim() : seg
    return { n: n.slice(0, 20), d: d.slice(0, 110) }
  })
  return { flow, warnings }
}

/* ---------- 组装 ---------- */

/** 去掉聊天广告的装饰与价格尾巴：[红包]、💰、含税 5180 */
function cleanTitleBase(s) {
  return String(s || '')
    .replace(/\[[^\]]{0,10}\]/g, ' ')
    .replace(/[【】]/g, ' ')
    .replace(/[💰💵]/g, ' ')
    /* 估价写法「含税17xxx」整段去掉，金额已落到价格区间 */
    .replace(/(?:含税|特价|包税)\s*[:：]?\s*\d{1,4}\s*[xX×✕*＊]{2,4}\s*(?:万)?/g, ' ')
    .replace(/(?:含税|单价)\s*[:：]?\s*[\d,]+/g, ' ')
    /* 金额在前的「7600含税」同样去掉 */
    .replace(/[\d,]{3,}\s*(?:含税|包税|未税|不含税)/g, ' ')
    /* 估价写法「25xxx / 23.3w」：金额已落到价格区间，标题里不留 */
    .replace(/(?:^|[\s、,，/])[\d]{1,3}(?:\.\d)?\s*[xX×✕*＊]{2,4}\s*(?:万)?(?=[\s、,，/]|$)/g, ' ')
    /* 「数量43」是报价写法，标题里由 43台 表达，不重复 */
    .replace(/(?:数量|台数|库存)\s*[:：]?\s*[\d,]+\s*万?\s*(?:台|张|片|套|个|根|条|组|颗)?/g, ' ')
    /* 行首方向词由 type / 「收」前缀统一表达：求购 / 回收 / 出 / 收 都不进标题 */
    .replace(/^(?:求购|收购|回收|收货|采购|出|收|售|卖)\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s、,，;；\/]+$/, '')
    .trim()
}

/* 交易说明：把标题 / 价格 / 城市之外的补充信息摘出来 */
const NOTE_RULES = [
  /白牌[^，。；\n]{0,10}?颗粒/,
  /(?:三星|海力士|镁光|美光|长鑫|南亚|金士顿|英睿达)[^，。；\n]{0,4}颗粒/,
  /白牌(?:内存|固态|芯片|显卡|卡)/,
  /(?:全新)?拆(?:箱|盒|封)(?:拆盒|拆箱)?/,
  /拆机(?:件|卡)?/,
  /统一料号/,
  /料号[：:]?\s*[A-Za-z0-9-]{2,24}/,
  /(?:质保|保修)\s*[^，。；\n]{0,14}/,
  /(?:全国包邮|包邮|包税)/,
  /(?:上门)?自提/,
  /(?:可|支持)(?:验货|验机|压测|测试|通电测试)/,
  /(?:散片|工包|原装|国行|港版|美版|欧版|无盒|有盒|带票)/,
  /dc\s*2[45]/i,
  /(?:批次|年份|生产日期)\s*[^，。；\n]{0,12}/
]

function pickNote(text) {
  const s = String(text || '')
  const out = []
  const add = (v) => {
    let t = String(v || '').replace(/^[\s:：,，;；、.-]+|[\s:：,，;；、.-]+$/g, '').trim()
    if (/^dc\s*2[45]$/i.test(t)) t = 'DC' + t.replace(/\D/g, '')
    if (!t) return
    if (out.some((x) => x.indexOf(t) > -1)) return
    const i = out.findIndex((x) => t.indexOf(x) > -1)
    if (i > -1) out[i] = t
    else out.push(t)
  }
  NOTE_RULES.forEach((re) => {
    const m = s.match(re)
    if (m) add(m[0])
  })
  return out.join('；').slice(0, 200)
}

/** 标题：型号 + 数量 + 城市；不足 4 字补「现货」 */
function buildTitle(rec) {
  const f = (rec && rec.fields) || {}
  let base = rec && rec.device ? rec.device.model : ''
  /* 原文带了品牌、型号本身又没带时补上品牌：泰安S8030GM2NE 不打成 S8030GM2NE */
  if (base && rec.device.brand) {
    const brand = String(rec.device.brand)
    if (String((rec && rec.raw) || '').indexOf(brand) > -1 && base.indexOf(brand) < 0) base = brand + ' ' + base
  }
  if (!base) {
    /* 说明行会并进商品，取第一条真正的商品行当标题，别让「深圳现货」这种标题行占位 */
    const lines = String((rec && rec.raw) || '').split(/[\n；;]/).filter((x) => x.trim())
    const listing = lines.filter((x) => isListingLine(x))
    /* 纯回收广告没有商品行时，用「回收」那一行当标题，别拿开头的手机号 */
    const recycle = lines.filter((x) => /回收/.test(x))[0]
    base = listing[0] || recycle || lines[0] || ''
  }
  /* 白牌的「白牌」前缀由后缀统一表达，标题里不重复 */
  base = cleanTitleBase(base).replace(/^白牌\s*/, '').slice(0, 40)
  /* 型号库里是标准全名，原文的形态词（h200底板 / sd1准系统）不能丢：
     型号名里没有、原文里有时补到后面，最多两个 */
  if (base && rec && rec.device) {
    const rawText = String(rec.raw || '')
    const extra = [
      { w: '底板' },
      { w: '准系统' },
      { w: '整机', cat: /服务器|算力套件/ },
      { w: '模组' },
      { w: '模块' },
      { w: '裸机' }
    ].filter((q) => rawText.indexOf(q.w) > -1 && base.indexOf(q.w) < 0 &&
      (!q.cat || q.cat.test(rec.device.cat))).map((q) => q.w).slice(0, 2)
    if (extra.length) base = base + ' ' + extra.join(' ')
  }
  /* 需求标题带上「收」，和商品标题区分开 */
  if (rec && rec.type === 'buy' && base && !/^收/.test(base)) base = '收 ' + base
  const cityShort = f.city ? f.city.replace(CITY_SUFFIX, '') : ''
  const bits = []
  if (base) bits.push(base)
  const qtyUnit = String(f.qty || '') + (f.unit || '台')
  const qtyWritten = f.qty && new RegExp(
    String(f.qty).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(?:余|多|\\+)?\\s*' + (f.unit || '台')
  ).test(base)
  if (f.qty && !qtyWritten) bits.push(qtyUnit)
  if (cityShort && base.indexOf(cityShort) < 0) bits.push(cityShort)
  let title = bits.join(' ').trim()
  if (rec && rec.whiteSuffix && title.indexOf(rec.whiteSuffix) < 0) title = title + ' ' + rec.whiteSuffix
  if (title.length < 4) title = (title + ' 现货').trim()
  return title.slice(0, 60)
}

/** 单条记录：拆记录 → 抽字段 → 生成可回填的结构 */
function parseRecord(block, opts) {
  const o = opts || {}
  const raw = String((block && block.raw) || block || '').trim()
  const warnings = []
  const junk = !!(block && block.junk)
  if (junk) warnings.push('识别为换群广告，已默认取消勾选')
  const blockWarn = (block && block.warn) || []
  blockWarn.forEach((w) => { if (warnings.indexOf(w) < 0) warnings.push(w) })

  const dev = pickDevice(raw, o.deviceIndex || [])
  if (!dev) warnings.push('未在型号库匹配到型号，请手动选择')
  else if (dev.ambiguous) warnings.push('型号有多个接口版本（SXM / PCIe），请确认')
  if (dev && dev.memFreqMiss) warnings.push('型号库暂无 ' + dev.freq + ' 频率，已按同容量近似匹配，请确认频率')
  /* 需求常一次列多个品牌 / 容量（三星|海力士…、16G/32G/64G），只能挑一个型号回填，提醒核对 */
  if (dev && dev.item && dev.item.cat === '内存条') {
    const brands = new Set((raw.match(/三星|SK\s*海力士|海力士|镁光|美光|长鑫|金士顿|威刚|芝奇|海盗船/gi) || []).map((b) => b.replace(/\s/g, '').toLowerCase()))
    const caps = new Set((raw.match(/\b\d{1,3}\s*[Gg]\b/g) || []).map((c) => c.replace(/\s/g, '').toLowerCase()))
    if (brands.size >= 2 || caps.size >= 2) warnings.push('原文含多个品牌 / 容量，已按其一匹配，请核对型号')
  }
  if (dev && dev.memBrandMiss) warnings.push('未识别内存品牌，已默认选择，请确认品牌')
  if (dev && dev.memSpecMiss) warnings.push('原文未写内存频率 / 代数，已按默认规格匹配，请确认')

  /* 总量与「每批最少 / 最多」分开：先摘出起订与上限，剩下的数字才是库存总量 */
  const minInfo = pickMinQty(raw)
  const maxInfo = pickMaxQty(raw)
  const qtyInfo = pickQty(raw, [minInfo.span, maxInfo.span])
  /* 原文没写数量单位（「数量43」）时按品类补，标题里的「台 / 张 / 根 / 块」才贴合实际 */
  const unit = qtyInfo.unit === '台' && dev && !UNIT_RE.test(raw) ? unitOfCat(dev.item) : qtyInfo.unit
  let qty = qtyInfo.value
  /* 只写了「共 200 万」又没写台数时，用「8 卡」兜底数量，折算单价 */
  if (!qty && TOTAL_RE.test(raw)) {
    const card = raw.match(/(\d+)\s*卡/)
    if (card) {
      qty = card[1]
      warnings.push('原文未写台数，已按 ' + card[1] + ' 卡折算，请核对')
    }
  }

  const priceInfo = pickPrice(raw, qty)
  priceInfo.warnings.forEach((w) => warnings.push(w))

  /* 交付地优先看「交货地点 / 提货地 / 所在地」后面紧跟的城市，
     避免把「和宁波移动拼单」里的公司所在地当成交付地 */
  const placeM = raw.match(/(?:交货地点|交货地|提货地点|提货地|发货地|所在地|地址|地点)\s*[:：]?\s*([^\n，,。；;]{1,20})/)
  const placeHit = placeM ? findCity(placeM[1], o.cityIndex || []) : null
  const cityHit = placeHit || findCity(raw, o.cityIndex || []) || o.sectionPlace || null
  const cityAll = findAllCities(raw, o.cityIndex || [])
  if (!cityHit) warnings.push('未识别到城市，请手动选择')
  else if (!cityHit.city) warnings.push('仅识别到「' + cityHit.province + '」，请选择城市')
  /* 明确写了交货地点时，其它城市（如「和某公司拼单」）不算多交付地，不再提示 */
  if (cityAll.length > 1 && !placeHit) {
    warnings.push('原文提到多个交付地（' + cityAll.map((c) => c.city || c.province).join('、') +
      '），已选「' + (cityHit ? (cityHit.city || cityHit.province) : '') + '」，请确认')
  }
  /* 币种不在发布页可选范围内，别默默按人民币算 */
  if (/台币|TWD|韩元|KRW|卢布|RUB|越南盾|VND/i.test(raw)) {
    warnings.push('原文币种不在支持列表，已按人民币处理，请确认')
  }
  /* 发布页交付地只支持国内行政区，境外地点只能请用户手动处理 */
  if (/新加坡|迪拜|阿联酋|美国|日本|韩国|马来|泰国|海外|境外/.test(raw) && !cityHit) {
    warnings.push('原文交付地在境外，发布页仅支持国内城市，请手动选择或写入交易说明')
  }

  const cond = pickCond(raw)
  const picked = pickGroups(raw)
  if (/现货/.test(raw) && /期货/.test(raw)) warnings.push('原文同时提到现货与期货，已按现货识别，请确认')
  if (!picked.deliver && /(\d+)\s*天内|下周|月底|月初|个?工作日/.test(raw)) {
    warnings.push('交付时间未匹配到选项，请手动选择')
  }
  const term = pickRentTerm(raw)
  if (term) picked.rentTerm = [term]

  const conds = pickConds(raw, o)
  const flowInfo = pickFlow(raw)
  flowInfo.warnings.forEach((w) => warnings.push(w))
  /* 白牌：按型号类型补标题后缀（白配内存 / 白牌芯片 / 白牌固态），其余补充信息写进交易说明 */
  const white = /白牌|白片|白卡/.test(raw)
  const whiteSuffix = white ? WHITE_SUFFIX[whiteKindOf(raw, dev && dev.item)] : ''
  const note = pickNote(raw)

  const device = dev
    ? {
      cat: dev.item.cat,
      brand: dev.item.brand,
      series: dev.item.series,
      model: dev.item.model,
      device: dev.item.model,
      devicePath: [dev.item.cat, dev.item.brand, dev.item.series].join(' · ')
    }
    : null

  const rec = {
    key: (block && block.key) || 'r1',
    raw,
    /* sell = 发布商品，buy = 发布需求；所在栏目头（特价出： / 求购：）优先 */
    type: o.side || classifySide(raw),
    checked: !junk,
    title: '',
    device,
    note,
    whiteSuffix,
    fields: {
      qty: qty ? String(qty) : '',
      unit,
      minQty: minInfo.value ? String(minInfo.value) : '',
      maxQty: maxInfo.value ? String(maxInfo.value) : '',
      price: priceInfo.price,
      priceMax: priceInfo.priceMax,
      priceMode: priceInfo.priceMode,
      currency: priceInfo.currency || pickCurrency(raw),
      condType: cond.condType,
      condLevel: cond.condLevel,
      province: cityHit ? cityHit.province : '',
      city: cityHit ? cityHit.city : ''
    },
    picked,
    must: conds.must,
    nego: conds.nego,
    flow: flowInfo.flow,
    warnings
  }
  rec.title = buildTitle(rec)
  return rec
}

/** 别名在原文里的位置；SZ / HK / XM 这类缩写必须独立成词，避免 SXM 命中 XM */
function aliasPos(s, alias) {
  if (!/^[A-Z]{2,3}$/.test(alias)) return s.indexOf(alias)
  const m = s.match(new RegExp('(^|[^A-Za-z0-9])' + alias + '(?![A-Za-z0-9])'))
  return m ? m.index + m[1].length : -1
}

function findCity(text, index) {
  const list = index || []
  const s = String(text || '')
  for (let i = 0; i < list.length; i++) {
    /* 「泰安S8030GM2NE」是泰安主板型号，不是山东泰安市 */
    if (list[i].alias === '泰安' &&
      /泰安\s*[A-Za-z0-9]/.test(s) && !/泰安(?!\s*[A-Za-z0-9])/.test(s)) continue
    if (aliasPos(s, list[i].alias) > -1) return list[i]
  }
  return null
}

/** 原文提到的全部交付地：用于「写了两个城市」时提示用户确认，不替用户做决定 */
function findAllCities(text, index) {
  const list = index || []
  const s = String(text || '')
  const out = []
  const seen = {}
  list.forEach((it) => {
    if (aliasPos(s, it.alias) < 0) return
    const key = it.province + '/' + it.city
    if (seen[key]) return
    seen[key] = true
    out.push(it)
  })
  /* 同省已经命中具体城市时，丢掉只到省的条目（广东深圳 → 只算深圳市） */
  return out.filter((it) => it.city || !out.some((x) => x !== it && x.province === it.province && x.city))
}

/**
 * 商品段判定：有型号、有真实数量、有报价，或像型号的字母数字串，才算一条商品。
 * 条款 / 说明 / 回收报价行跟随所属商品，不单独成条。
 */
function isListingBlock(raw, deviceIndex) {
  const s = String(raw || '').trim()
  if (!s) return false
  if (TERM_LINE_RE.test(s.replace(/^[\s[【（(]+/, ''))) return false
  if (pickDevice(s, deviceIndex || [])) return true
  const plain = stripNonQty(s)
  if (UNIT_RE.test(plain)) return true
  if (/[\d,]+\s*万\s*(?:台|张|片|套|个)/.test(plain)) return true
  if (MONEY_RE.test(plain)) return true
  /* 求购行常只写「收 5090风扇卡」这种型号数字 */
  if (classifySide(s) === 'buy' && /\d{2,}/.test(plain)) return true
  /* 型号样式：MLU370 / RG800 / S60 / 300V / 64G / T1DEEP / TG659V3，中文品牌后的字母数字都算 */
  return /[A-Za-z]{1,8}\s*-?\s*\d{2,}/.test(plain) ||
    /[A-Za-z]{1,5}\d{1,5}[A-Za-z]{1,6}/.test(plain) ||
    /\d{2,}\s*[A-Za-z]{1,4}\b/.test(plain) ||
    SHORT_MODEL_RE.test(plain)
}

/** 换群广告起始行：手机号 + 换群；返回行号，没有则 -1（回收 / 收货广告现在按需求识别） */
function junkStart(raw) {
  const lines = String(raw || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (/\d{8,}/.test(s) && /换群/.test(s)) return i
  }
  return -1
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 一行里的型号候选：只认能在型号库命中、且不是 SXM5 / 80G 这种接口容量碎片 */
function modelTokens(line, deviceIndex) {
  const re = /[A-Za-z]{1,8}\d{1,5}[A-Za-z]{0,3}/g
  const out = []
  let m
  while ((m = re.exec(line))) {
    const t = m[0]
    if (out.indexOf(t) > -1) continue
    const norm = M.normSearch(t)
    if (norm.length < 3) continue
    const dev = pickDevice(t, deviceIndex)
    if (!dev || M.normSearch(dev.item.model).indexOf(norm) < 0) continue
    out.push(t)
  }
  return out
}

/**
 * 同前缀多型号连写：「RTX 5080 5070TI 5070 5060TI」是四条，不是一条。
 * 只认「字母前缀 + 4 位数字（可带 TI / SUPER）」的写法，避免把「RTX 5090 32G 涡轮」拆开。
 */
function splitSharedPrefix(line) {
  const s = String(line || '')
  const m = s.match(/\b(RTX|GTX|RX)\s+((?:\d{4}\s*(?:TI|SUPER)?\s*)+)/i)
  if (!m) return []
  const nums = (m[2].match(/\d{4}\s*(?:TI|SUPER)?/gi) || []).map((x) => x.toUpperCase().replace(/\s+/g, ''))
  if (nums.length < 2) return []
  const head = s.slice(0, m.index) + m[1] + ' '
  const tail = s.slice(m.index + m[0].length)
  return nums.map((n) => head + n + tail)
}

/**
 * 一行并列多个机型（用 •、多个空格、分号分隔）：
 *   「•T3680    T2     T5860      T7960」
 *   「• T160     R760XS  R570    R770」
 * 每个机型单独成条，否则多个型号核心互相冲突，整行都匹配不上。
 * 「型号：i5-14500、i7-14700…」这类配置清单不拆（冒号后是 CPU 选项，不是多个整机）。
 */
function splitModelList(line) {
  const s = String(line || '')
  if (/[:：]/.test(s)) return []
  /* 内存条报价：三星64G 5600 全新未拆封 现货1600条，段与段之间是同一条商品的规格，不是并列型号 */
  if (/(?:条|根)/.test(s) && /(?:^|[^A-Za-z0-9])\d{2,3}\s*G(?:B)?(?![A-Za-z0-9])/.test(s)) return []
  const items = s.split(/\s{2,}|\t|[•·；;]+/).map((x) => x.trim()).filter(Boolean)
  if (items.length < 2 || items.length > 12) return []
  const codeRe = /[A-Za-z]+\s*[-‑]?\s*\d|\d[A-Za-z]/
  /* 只有容量 + 成色标签的片段（8T白标、16T原箱、单盒装）是同一块硬盘的规格，不是并列型号：
     WD85PURU  8T白标 不能拆成 WD85PURU 和 8T白标 两条 */
  const CAP_PART_RE = /^(?:\d{1,3}\s*(?:T|TB|G|GB))?(?:白标|彩标|原箱|国行|盒包|盒装|单盒装|全新|现货|期货|企业级)?$/i
  /* 带「数量 / 报价」的片段是同一条报价的说明，不是并列的第二个型号（A100  80G定制 数量6） */
  const picked = items.filter((x) => codeRe.test(x) &&
    !CAP_PART_RE.test(x.replace(/\s+/g, '')) &&
    !/(?:数量|台数|报价|单价|总价|价格|起订|现货|期货)/.test(x))
  if (picked.length < 2) return []
  return picked
}

/**
 * 「H100/H200/A100 各10台 单价25万」这类多型号合写，拆成多条，
 * 数量与价格共用；拆完仍保留原文其余行，交给逐条解析。
 */
function expandMultiModels(raw, deviceIndex) {
  const lines = String(raw || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const shared = splitSharedPrefix(line)
    if (shared.length > 1) {
      const others = lines.slice(0, i).concat(lines.slice(i + 1))
      return shared.map((one) => ({
        raw: others.concat([one]).join('\n'),
        warn: ['原文多个型号连写，已拆成 ' + shared.length + ' 条，请核对数量与价格']
      }))
    }
    const tokens = modelTokens(line, deviceIndex)
    if (tokens.length < 2) {
      const listed = splitModelList(line)
      if (listed.length > 1) {
        const rest = lines.slice(0, i).concat(lines.slice(i + 1))
        return listed.map((one) => ({
          raw: rest.concat([one]).join('\n'),
          warn: ['原文多个型号并列，已拆成 ' + listed.length + ' 条，请逐条核对']
        }))
      }
      continue
    }
    const others = lines.slice(0, i).concat(lines.slice(i + 1))
    /* 「H100/H200/A100 各10台 单价25万」：斜杠 / 顿号连写，数量与结尾条件共用 */
    if (/[/、]/.test(line)) {
      /* 型号必须在同一组里连着写，H100/SXM5/A100 这种夹了接口的不拆 */
      const joined = new RegExp(tokens.map(escapeRe).join('\\s*[/、]\\s*'))
      if (joined.test(line)) {
        const first = line.indexOf(tokens[0])
        const lastToken = tokens[tokens.length - 1]
        const last = line.lastIndexOf(lastToken) + lastToken.length
        const head = line.slice(0, first)
        const tail = line.slice(last)
        const per = line.match(/各\s*(\d+)\s*(台|张|片|套|个)?/)
        const sum = line.match(/共\s*(\d+)\s*(台|张|片|套|个)/)
        let qtyText = ''
        if (per) qtyText = per[1] + (per[2] || '台')
        else if (sum && Number(sum[1]) % tokens.length === 0) qtyText = (Number(sum[1]) / tokens.length) + sum[2]
        return tokens.map((t) => {
          let one = head + t + tail
          if (qtyText) one = one.replace(/各\s*\d+\s*(?:台|张|片|套|个)?|共\s*\d+\s*(?:台|张|片|套|个)/, qtyText)
          return {
            raw: others.concat([one]).join('\n'),
            warn: ['原文多个型号合写，已拆成 ' + tokens.length + ' 条，请核对数量与价格']
          }
        })
      }
    }
    /* 「H100 80G 8台 25万 H200 141G 5台 30万」：同一行连着写，按「型号 + 紧跟数量」的位置切开 */
    const gap = '(?:[\\s,，]+(?:\\d+\\s*(?:[Gg][Bb]?|[Tt][Bb]?)|[A-Za-z]{1,6}\\d{0,3}))*'
    const qtyAfter = new RegExp('^' + gap + '[\\s,，]*(\\d[\\d,]*)\\s*(?:余|多|\\+)?\\s*(?:' + UNIT_TAIL + '|万)')
    /* 同一行连着写多个机型、又没有数量可以定位切点：「• T160  R760XS  R570  R770」 */
    const marks = []
    tokens.forEach((t) => {
      const at = line.indexOf(t)
      const q = line.slice(at + t.length).match(qtyAfter)
      if (q && marks.indexOf(at) < 0) marks.push(at)
    })
    if (marks.length < 2) {
      const listed = splitModelList(line)
      if (listed.length > 1) {
        const rest = lines.slice(0, i).concat(lines.slice(i + 1))
        return listed.map((one) => ({
          raw: rest.concat([one]).join('\n'),
          warn: ['原文多个型号并列，已拆成 ' + listed.length + ' 条，请逐条核对']
        }))
      }
      continue
    }
    const pieces = marks.map((at, k) =>
      line.slice(k === 0 ? 0 : at, k + 1 < marks.length ? marks[k + 1] : undefined).trim()
    )
    return pieces.map((one) => ({
      raw: others.concat([one]).join('\n'),
      warn: ['原文多个型号连写，已拆成 ' + pieces.length + ' 条，请核对数量与价格']
    }))
  }
  return [{ raw }]
}

/** 全流程：切分 → 条款段并入上一条 → 多型号拆分 → 逐条解析 */
function parseText(text, opts) {
  const o = opts || {}
  const deviceIndex = o.deviceIndex || []
  const cityIndex = o.cityIndex || buildCityIndex(o.cityTree)
  const blocks = []
  /* 城市 / 现货这类标题行先存着，跟下一条商品合并 */
  let pending = []
  /* 「出深圳现货」「出香港现货」这类栏目头：同栏目后面的商品没写城市时都用它 */
  let sectionPlace = null
  const pushRecord = (raw, key, side) => {
    if (!raw) return
    /* 回收报价整段是广告，单独成一条，别污染前面的型号 */
    if (junkStart(raw) === 0) {
      const last = blocks[blocks.length - 1]
      if (last && last.junk) last.raw += '\n' + raw
      else blocks.push({ key: 'r' + (blocks.length + 1), raw, junk: true })
      return
    }
    if (isListingBlock(raw, deviceIndex)) {
      blocks.push({
        key: key || 'r' + (blocks.length + 1),
        raw: pending.length ? pending.join('\n') + '\n' + raw : raw,
        place: sectionPlace,
        side: side || ''
      })
      pending = []
      return
    }
    /* 城市 / 现货 / 换群这类栏目行：留给下一条商品 */
    if (!blocks.length || findCity(raw, cityIndex) || isSectionHeader(raw)) {
      pending.push(raw)
      return
    }
    /* 上一段是另一个栏目（收 / 出）时别跨栏目并入，单独成条 */
    const last = blocks[blocks.length - 1]
    if (last && !last.junk && (last.side || '') !== (side || '')) {
      blocks.push({ key: 'r' + (blocks.length + 1), raw, place: sectionPlace, side: side || '' })
      return
    }
    last.raw += '\n' + raw
  }
  /* 栏目头（特价出： / 求购：）先切段，段内条目沿用段头的出 / 收口径 */
  splitSideSegments(text).forEach((seg) => {
    splitRecords(seg.lines.join('\n')).forEach((b) => {
      const raw = String((b && b.raw) || '').trim()
      if (!raw) return
      /* 栏目头本身不发布：记下城市，后面同栏目的商品直接沿用，避免整段只剩一条 */
      if (isSectionHeader(raw) && !/^换群/.test(raw)) {
        const hit = findCity(raw, cityIndex)
        if (hit) {
          sectionPlace = hit
          return
        }
        /* 「全新16T」「全新8T」只是容量栏目行，本身不是商品：并入下一条，别单独成记录 */
        if (/^(?:全新|现货|期货|国行|原封)\s*\d{1,3}\s*(?:T|TB|G|GB)$/i.test(raw)) {
          pending.push(raw)
          return
        }
      }
      /* 一条里前半是商品、后半接回收广告：从广告起始行切开，别把广告并进商品 */
      const ji = junkStart(raw)
      if (ji > 0) {
        const lines = raw.split('\n')
        pushRecord(lines.slice(0, ji).join('\n').trim(), b && b.key, seg.side)
        pushRecord(lines.slice(ji).join('\n').trim(), '', seg.side)
        return
      }
      /* 同一行既出又收（出H100 10台 收H200 5台）：按动词位置拆成两条，各带各的方向 */
      const mixed = splitMixedSideLine(raw)
      if (mixed) {
        mixed.forEach((piece) => pushRecord(piece.raw, '', piece.side || seg.side))
        return
      }
      pushRecord(raw, b && b.key, seg.side)
    })
  })
  if (pending.length) {
    if (blocks.length) blocks[blocks.length - 1].raw += '\n' + pending.join('\n')
    else blocks.push({ key: 'r1', raw: pending.join('\n') })
  }
  /* 多型号合写（H100/H200/A100）先拆开，再逐条解析 */
  const expanded = []
  blocks.forEach((b) => {
    if (b.junk) {
      expanded.push(b)
      return
    }
    expandMultiModels(b.raw, deviceIndex).forEach((v, i) => {
      expanded.push({
        key: (b.key || 'r') + (i ? '-' + (i + 1) : ''),
        raw: v.raw,
        warn: v.warn,
        junk: b.junk,
        place: b.place,
        side: b.side || ''
      })
    })
  })
  const records = expanded.map((b) => parseRecord(b, Object.assign({}, o, {
    deviceIndex,
    cityIndex,
    sectionPlace: b.place || null,
    side: b.side || ''
  })))

  /* 整段是回收 / 求购广告：只写型号的后续行没有「收」字，按整段口径改成需求 */
  if (globalSideOf(text) === 'buy') {
    records.forEach((r, i) => {
      if (r.checked === false || r.type === 'buy') return
      /* 栏目头已写明出 / 收的条目不再翻 */
      if (expanded[i] && expanded[i].side) return
      if (SELL_HINT.test(r.raw)) return
      r.type = 'buy'
      r.title = buildTitle(r)
    })
  }

  /* 整段只提到一个城市时（常见：最后一行写「以上深圳」），给没写城市的记录补齐 */
  const cityKeys = {}
  records.forEach((r) => {
    if (r.fields.city) cityKeys[r.fields.province + '/' + r.fields.city] = r
  })
  const keys = Object.keys(cityKeys)
  if (keys.length === 1) {
    const src = cityKeys[keys[0]]
    records.forEach((r) => {
      if (r.fields.province) return
      r.fields.province = src.fields.province
      r.fields.city = src.fields.city
      r.warnings = r.warnings.filter((w) => w.indexOf('未识别到城市') < 0 && w.indexOf('仅识别到') < 0)
      r.title = buildTitle(r)
    })
  }

  /* 列表型文本常把共用条件写在最后一条（「H100 10台、H200 5台 单价25万 深圳」）：
     整段只有一种取值时，补到没写的记录；出现两种取值就不猜 */
  if (records.length > 1) {
    const priceVals = {}
    let totalUsed = false
    records.forEach((r) => {
      if (r.warnings.some((w) => w.indexOf('原文为总价') > -1)) totalUsed = true
      if (r.checked === false) return
      if (Number(r.fields.price) > 0 && r.fields.priceMode === 'fixed') {
        priceVals[r.fields.price + '|' + (r.fields.currency || 'CNY')] = r
      }
    })
    const priceKeys = Object.keys(priceVals)
    if (!totalUsed && priceKeys.length === 1) {
      const src = priceVals[priceKeys[0]]
      records.forEach((r) => {
        if (r.checked === false) return
        if (Number(r.fields.price) > 0 || r.fields.priceMode === 'nego') return
        r.fields.price = src.fields.price
        r.fields.currency = src.fields.currency
        r.warnings.push('单价与币种按列表共用识别，请核对')
        r.title = buildTitle(r)
      })
    }
    /* 供给 / 税费 / 交付时间 / 成色同理 */
    const sharePick = (get, set, label) => {
      const vals = {}
      records.forEach((r) => {
        if (r.checked === false) return
        const v = get(r)
        if (v) vals[v] = r
      })
      const ks = Object.keys(vals)
      if (ks.length !== 1) return
      const src = vals[ks[0]]
      records.forEach((r) => {
        if (r.checked === false) return
        if (get(r)) return
        set(r, src)
        r.warnings.push(label + '按列表共用识别，请核对')
      })
    }
    sharePick((r) => r.picked.supply, (r, s) => { r.picked.supply = s.picked.supply }, '供给')
    sharePick((r) => r.picked.tax, (r, s) => { r.picked.tax = s.picked.tax }, '税费')
    sharePick((r) => r.picked.deliver, (r, s) => { r.picked.deliver = s.picked.deliver }, '交付时间')
    sharePick((r) => r.fields.condType, (r, s) => {
      r.fields.condType = s.fields.condType
      r.fields.condLevel = s.fields.condLevel
    }, '成色')
  }

  const warnings = []
  if (!records.length) warnings.push('没有识别到可发布的内容')
  return { records, warnings }
}

/**
 * 账号所在城市 → 表单的省 / 市。
 * 只用识别时同一份行政区划目录，省 / 市名必须能对上，否则返回空交给用户选。
 */
function placeOfCity(name) {
  const raw = String(name == null ? '' : name).trim()
  if (!raw) return { province: '', city: '' }
  const short = raw.replace(CITY_SUFFIX, '')
  const provinces = Object.keys(CITY_TREE)
  for (const p of provinces) {
    const hit = (CITY_TREE[p] || []).find((c) => c === raw || c === short || c.replace(CITY_SUFFIX, '') === short)
    if (hit) return { province: p, city: hit }
  }
  const p = provinces.find((x) => x === raw || x.replace(PROVINCE_SUFFIX, '') === raw)
  return p ? { province: p, city: '' } : { province: '', city: '' }
}

/**
 * 兜底默认值，减少发布时的手填：
 * 1) 原文没写金额 → 价格方式选「现场沟通」（不公开金额，也不卡发布）；
 * 2) 原文没写交易地 → 用账号所在城市。
 * 放在服务端 parse.publish 里做，老版本小程序只负责回填也能直接生效。
 */
function fillDefaults(records, place) {
  const p = place || {}
  ;(records || []).forEach((r) => {
    const f = r && r.fields
    if (!f) return
    const price = Number(String(f.price == null ? '' : f.price).replace(/,/g, ''))
    const max = Number(String(f.priceMax == null ? '' : f.priceMax).replace(/,/g, ''))
    if (!(price > 0)) {
      f.priceMode = 'nego'
      f.price = ''
      f.priceMax = ''
    } else if (f.priceMode === 'range' && !(max > 0)) {
      /* 区间只给了一头：按固定单价处理，避免卡在「请填写最高价」 */
      f.priceMode = 'fixed'
      f.priceMax = ''
    }
    if (!f.province && !f.city && p.province && p.city) {
      f.province = p.province
      f.city = p.city
      /* 已经兜底了就不必再提示用户选城市 */
      r.warnings = (r.warnings || []).filter((w) => !/城市|交易地|地区/.test(w))
    }
  })
  return records
}

module.exports = {
  buildCityIndex,
  buildDeviceIndex,
  splitRecords,
  pickDevice,
  parseRecord,
  parseText,
  classifySide,
  buildTitle,
  placeOfCity,
  fillDefaults
}
