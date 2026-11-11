'use strict'

/**
 * 敏感词风控：色情 / 暴力 / 反动三类词库与扫描。
 *
 * 口径：
 * 1. 只做「提示风险」，不自动拦截、不改发布状态；命中后写入 riskCases，必须由平台人工查看处置。
 * 2. 扫描范围覆盖商品 / 需求正文、咨询内容、站内对话消息。
 * 3. 匹配前去掉空格与常见分隔符，避免用「裸 聊」「约*炮」这类写法绕过。
 */

const { randomId } = require('./crypto')

const CATEGORIES = [
  {
    key: 'porn',
    name: '色情',
    code: 'sensitive_porn',
    label: '涉黄内容',
    level: '中',
    words: [
      '裸聊', '裸照', '约炮', '一夜情', '招嫖', '卖淫', '嫖娼', '嫖资',
      '色情', '色情服务', '淫秽', '黄片', '黄图', '成人视频', '成人影片',
      '成人网站', '援交', '卖片', '性服务', '特殊服务', '性交易', '包养',
      '开房服务', '小姐上门', '大保健', '楼凤', '情趣酒店'
    ]
  },
  {
    key: 'violence',
    name: '暴力',
    code: 'sensitive_violence',
    label: '涉暴内容',
    level: '高',
    words: [
      '砍人', '砍死', '杀人', '杀死', '杀你', '弄死', '打死', '血腥',
      '屠杀', '绑架', '凶杀', '械斗', '炸弹', '炸药', '雷管', '爆炸物',
      '自制炸弹', '人体炸弹', '枪支', '买枪', '卖枪', '弹药', '恐怖袭击',
      '恐怖组织'
    ]
  },
  {
    key: 'politics',
    name: '反动',
    code: 'sensitive_politics',
    label: '涉政内容',
    level: '高',
    words: [
      '颠覆国家', '颠覆政权', '推翻政府', '反党', '反共', '反政府',
      '分裂国家', '煽动颠覆', '打倒共产党', '台独', '藏独', '疆独', '港独',
      '法轮功', '六四事件', '邪教'
    ]
  }
]

/* 去掉空白、标点与常见分隔符后再匹配，降低拆字绕过 */
const NOISE_RE = /[\s\u3000·•.\-_*/\\|,，。!！?？~～:：;；'"“”‘’()（）\[\]【】<>《》]/g

function normalizeText(value) {
  return String(value == null ? '' : value).toLowerCase().replace(NOISE_RE, '')
}

const INDEX = []
for (const cat of CATEGORIES) {
  for (const word of cat.words) {
    INDEX.push({ word, norm: normalizeText(word), cat })
  }
}

/**
 * 扫描文本，按类别返回命中结果。
 * @returns {Array<{key,name,code,label,level,words:string[]}>}
 */
function scanSensitive(value) {
  const raw = String(value == null ? '' : value)
  if (!raw) return []
  const text = normalizeText(raw)
  if (!text) return []
  const found = new Map()
  for (const item of INDEX) {
    if (!item.norm || text.indexOf(item.norm) < 0) continue
    const hit = found.get(item.cat.key) || {
      key: item.cat.key,
      name: item.cat.name,
      code: item.cat.code,
      label: item.cat.label,
      level: item.cat.level,
      words: []
    }
    if (hit.words.indexOf(item.word) < 0) hit.words.push(item.word)
    found.set(item.cat.key, hit)
  }
  return Array.from(found.values())
}

function detailOf(hit) {
  const words = hit.words.slice(0, 6).join('、')
  return `命中${hit.name}敏感词：${words}${hit.words.length > 6 ? ' 等' : ''}`
}

/**
 * 命中即写风险单（幂等），供管理端「风险提示」人工处置。
 * 已处理 / 已忽略的风险单在再次命中时会重新打开，确保不会被自动放过。
 */
async function recordSensitiveRisk(opts) {
  const options = opts || {}
  const repo = options.repo
  const at = Number(options.at) || Date.now()
  const hits = scanSensitive(options.text)
  if (!repo || !hits.length) return []
  const type = options.type || '商品'
  const targetId = String(options.targetId || '') || 'unknown'
  const targetLabel = String(options.targetLabel || targetId).slice(0, 80)
  const uid = String(options.uid || '')
  const created = []
  for (const hit of hits) {
    const fingerprint = `${type}|${hit.code}|${targetId}`
    const detail = detailOf(hit)
    const existing = await repo.find('riskCases', { fingerprint }, { limit: 1 })
    if (existing[0]) {
      const reopen = existing[0].status === '已处理' || existing[0].status === '已忽略'
      await repo.updateWhere('riskCases', { fingerprint }, Object.assign({
        targetLabel,
        detail,
        level: hit.level,
        updatedAt: at
      }, reopen ? { status: '待处理', owner: '', action: '', reason: '' } : {}))
      continue
    }
    await repo.insert('riskCases', {
      id: randomId('RC'),
      fingerprint,
      type,
      ruleCode: hit.code,
      ruleLabel: hit.label,
      level: hit.level,
      targetId,
      targetLabel,
      uid,
      detail,
      status: '待处理',
      owner: '',
      action: '',
      reason: '',
      createdAt: at,
      updatedAt: at
    })
    created.push(fingerprint)
  }
  return created
}

module.exports = {
  SENSITIVE_CATEGORIES: CATEGORIES,
  scanSensitive,
  recordSensitiveRisk
}
