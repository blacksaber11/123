/* 本地部署测算：选开源模型 + 目标并发 → 按平台预设设备估算所需数量。
   设备只能从 device-catalog.js 同步过来的 DEVICE_TREE 里选，不允许自填型号。 */
const D = require('../../utils/device-spec')
const guard = require('../../utils/guard')
const sharePoster = require('../../utils/share-poster')
const CALC_CATS = D.CALC_CATS

const QUANTS = [
  { key: 'fp16', name: 'FP16 / BF16', short: 'FP16', bytes: 2, tip: '原精度，显存占用最高' },
  { key: 'fp8', name: 'FP8 / INT8', short: 'FP8', bytes: 1, tip: '精度损失小，推理首选' },
  { key: 'int4', name: 'INT4（AWQ / GPTQ）', short: 'INT4', bytes: 0.5, tip: '显存最省，大模型常用' }
]

const CONTEXTS = [
  { v: 4096, label: '4K' },
  { v: 8192, label: '8K' },
  { v: 16384, label: '16K' },
  { v: 32768, label: '32K' },
  { v: 65536, label: '64K' },
  { v: 131072, label: '128K' },
  { v: 262144, label: '256K' },
  { v: 524288, label: '512K' },
  { v: 1048576, label: '1M' }
]

const CONC_PRESETS = [1, 2, 4, 8, 16, 32, 64]

/* 并发上限：只防误输入，不能再像以前那样静默截断到 512 路，否则 8000 路会被算成 512 路 */
const MAX_CONC = 100000

/* 语言模型算力口径：按单路 20 token/s 的体验目标折算解码吞吐；
   单台吞吐 = 单卡带宽 × 卡数 × 并行效率 ÷ 激活参数 × 批处理增益，与回本测算同一口径。
   只算显存会把 8000 路并发算成 1 台，必须同时过算力这一关。 */
const TARGET_TPS = 20
const TP_EFF = 0.8
const BATCH_GAIN = 3

/* 模型品类：语言 / 生图 / 视频 / 语音。
   非语言模型的显存不只取决于权重，还取决于输出规格（分辨率 / 时长），
   所以用 px 表示相对基准规格的倍数，激活显存按 px 线性放大。 */
const KINDS = [
  { key: 'llm', name: '语言' },
  { key: 'image', name: '生图' },
  { key: 'video', name: '视频' },
  { key: 'audio', name: '语音' }
]

const SIZES = {
  image: [
    { v: 1, label: '1024×1024', px: 1 },
    { v: 2, label: '2048×2048', px: 4 },
    { v: 3, label: '2048×4096', px: 8 }
  ],
  video: [
    { v: 1, label: '480p · 5s', px: 0.4 },
    { v: 2, label: '720p · 5s', px: 1 },
    { v: 3, label: '1080p · 5s', px: 2.25 },
    { v: 4, label: '720p · 10s', px: 2 },
    { v: 5, label: '1080p · 10s', px: 4.5 }
  ],
  audio: [
    { v: 1, label: '30 秒', px: 0.5 },
    { v: 2, label: '1 分钟', px: 1 },
    { v: 3, label: '5 分钟', px: 3 },
    { v: 4, label: '15 分钟', px: 6 }
  ]
}

/* 各品类的参数口径文案 */
const KIND_TEXT = {
  llm: { ctx: '上下文长度（单次请求）', act: 'KV Cache', tip: '并发指同时处理的请求数；并发越高，KV Cache 与算力需求同步上升。' },
  image: { ctx: '输出分辨率', act: '激活显存', comp: '含文本编码器 / VAE 的整机估算口径', tip: '并发即批大小（batch）；分辨率与批量越高，激活显存占用越大。' },
  video: { ctx: '分辨率与时长', act: '激活显存', comp: '含文本编码器 / 3D VAE 的整机估算口径', tip: '并发即同时生成的任务数；分辨率、时长和任务数共同决定激活显存。' },
  audio: { ctx: '音频时长', act: '激活显存', comp: '含声码器 / 特征提取组件的估算口径', tip: '并发即同时合成的音频路数；时长与路数越高，激活显存占用越大。' }
}

/* 开源模型预设：params 参数量（B），kv 为每 token 的 KV Cache（KB），
   max 为最大上下文。数值按公开配置估算，只用于容量测算，不代表实测性能。
   最新一代模型多用 MLA / 稀疏注意力 / FP4 缓存，kv 取官方公布的部署占用；
   顺序即热度：DeepSeek / Qwen 在前；带 1M 的型号是官方长上下文版本。
   生图 / 视频 / 语音模型用 extra 表示文本编码器 + VAE 等固定组件，
   actBase 表示基准规格、单并发下的激活显存（GB）。 */
const MODELS = [
  { id: 'ds-v41-flash', vendor: 'DeepSeek', name: 'DeepSeek-V4.1-Flash-1017', params: 552, active: 16, kv: 0.9, max: 1048576, type: 'MoE' },
  { id: 'ds-v4-flash', vendor: 'DeepSeek', name: 'DeepSeek-V4-Flash-0424', params: 284, active: 13, kv: 3.5, max: 1048576, type: 'MoE' },
  { id: 'ds-v32', vendor: 'DeepSeek', name: 'DeepSeek-V3.2-Exp', params: 671, active: 37, kv: 70, max: 131072, type: 'MoE' },
  { id: 'ds-v31', vendor: 'DeepSeek', name: 'DeepSeek-V3.1', params: 671, active: 37, kv: 70, max: 131072, type: 'MoE' },
  { id: 'ds-r1', vendor: 'DeepSeek', name: 'DeepSeek-R1-0528', params: 671, active: 37, kv: 70, max: 131072, type: 'MoE' },
  { id: 'ds-r1-32b', vendor: 'DeepSeek', name: 'DeepSeek-R1-Distill-Qwen-32B', params: 32.8, kv: 256, max: 131072, type: 'Dense' },
  { id: 'ds-r1-14b', vendor: 'DeepSeek', name: 'DeepSeek-R1-Distill-Qwen-14B', params: 14.8, kv: 192, max: 131072, type: 'Dense' },
  { id: 'ds-r1-7b', vendor: 'DeepSeek', name: 'DeepSeek-R1-Distill-Qwen-7B', params: 7.6, kv: 56, max: 131072, type: 'Dense' },
  { id: 'ds-coder-v2', vendor: 'DeepSeek', name: 'DeepSeek-Coder-V2-236B', params: 236, active: 21, kv: 160, max: 131072, type: 'MoE' },

  { id: 'qwen38-flash', vendor: '通义千问', name: 'Qwen3.8-Flash-Next', params: 125, active: 6, kv: 40, max: 1048576, type: 'MoE' },
  { id: 'qwen3-235b', vendor: '通义千问', name: 'Qwen3-235B-A22B-Instruct-2507', params: 235, active: 22, kv: 188, max: 262144, type: 'MoE' },
  { id: 'qwen3-coder-480b', vendor: '通义千问', name: 'Qwen3-Coder-480B-A35B', params: 480, active: 35, kv: 248, max: 262144, type: 'MoE' },
  { id: 'qwen3-next-80b', vendor: '通义千问', name: 'Qwen3-Next-80B-A3B', params: 80, active: 3, kv: 32, max: 262144, type: 'MoE' },
  { id: 'qwen3-32b', vendor: '通义千问', name: 'Qwen3-32B', params: 32.8, kv: 256, max: 131072, type: 'Dense' },
  { id: 'qwen3-30b-a3b', vendor: '通义千问', name: 'Qwen3-30B-A3B', params: 30.5, active: 3.3, kv: 96, max: 262144, type: 'MoE' },
  { id: 'qwen3-8b', vendor: '通义千问', name: 'Qwen3-8B', params: 8.2, kv: 144, max: 131072, type: 'Dense' },
  { id: 'qwen3-vl-235b', vendor: '通义千问', name: 'Qwen3-VL-235B-A22B', params: 235, active: 22, kv: 188, max: 262144, type: 'MoE' },
  { id: 'qwen3-omni-30b', vendor: '通义千问', name: 'Qwen3-Omni-30B-A3B', params: 30, active: 3, kv: 96, max: 262144, type: 'MoE' },
  { id: 'qwen25-7b-1m', vendor: '通义千问', name: 'Qwen2.5-7B-Instruct-1M', params: 7.6, kv: 56, max: 1048576, type: 'Dense' },
  { id: 'qwen25-14b-1m', vendor: '通义千问', name: 'Qwen2.5-14B-Instruct-1M', params: 14.7, kv: 192, max: 1048576, type: 'Dense' },
  { id: 'qwen25-72b', vendor: '通义千问', name: 'Qwen2.5-72B-Instruct', params: 72.7, kv: 320, max: 131072, type: 'Dense' },
  { id: 'qwen25-32b', vendor: '通义千问', name: 'Qwen2.5-32B-Instruct', params: 32.5, kv: 256, max: 131072, type: 'Dense' },
  { id: 'qwen25-14b', vendor: '通义千问', name: 'Qwen2.5-14B-Instruct', params: 14.7, kv: 192, max: 131072, type: 'Dense' },
  { id: 'qwen25-7b', vendor: '通义千问', name: 'Qwen2.5-7B-Instruct', params: 7.6, kv: 56, max: 131072, type: 'Dense' },
  { id: 'qwen25-coder-32b', vendor: '通义千问', name: 'Qwen2.5-Coder-32B', params: 32.5, kv: 256, max: 131072, type: 'Dense' },

  { id: 'kimi-k3', vendor: 'Moonshot', name: 'Kimi-K3-2.8T-A104B', params: 2800, active: 104, kv: 27, max: 1048576, type: 'MoE' },
  { id: 'kimi-k2', vendor: 'Moonshot', name: 'Kimi-K2-Instruct', params: 1000, active: 32, kv: 70, max: 262144, type: 'MoE' },
  { id: 'minimax-m3', vendor: 'MiniMax', name: 'MiniMax-M3-428B-A23B', params: 428, active: 23, kv: 177, max: 1048576, type: 'MoE' },
  { id: 'minimax-m1', vendor: 'MiniMax', name: 'MiniMax-M1-456B-A45.9B', params: 456, active: 45.9, kv: 16, max: 1048576, type: 'MoE' },
  { id: 'minimax-text-01', vendor: 'MiniMax', name: 'MiniMax-Text-01-456B', params: 456, active: 45.9, kv: 16, max: 1048576, type: 'MoE' },

  { id: 'step-3', vendor: '其他', name: 'Step-3-321B-A38B', params: 321, active: 38, kv: 128, max: 262144, type: 'MoE' },
  { id: 'nemotron-ultra', vendor: '其他', name: 'Nemotron-Ultra-253B', params: 253, active: 25, kv: 128, max: 131072, type: 'MoE' },

  { id: 'llama4-maverick', vendor: 'Llama', name: 'Llama-4-Maverick-400B-A17B', params: 400, active: 17, kv: 128, max: 1048576, type: 'MoE' },
  { id: 'llama4-scout', vendor: 'Llama', name: 'Llama-4-Scout-109B-A17B', params: 109, active: 17, kv: 96, max: 1048576, type: 'MoE' },
  { id: 'llama33-70b', vendor: 'Llama', name: 'Llama-3.3-70B-Instruct', params: 70.6, kv: 320, max: 131072, type: 'Dense' },
  { id: 'llama31-8b', vendor: 'Llama', name: 'Llama-3.1-8B', params: 8, kv: 128, max: 131072, type: 'Dense' },

  { id: 'mistral-large-123b', vendor: 'Mistral', name: 'Mistral-Large-2-123B', params: 123, kv: 352, max: 131072, type: 'Dense' },
  { id: 'mistral-small-24b', vendor: 'Mistral', name: 'Mistral-Small-3.2-24B', params: 24, kv: 160, max: 131072, type: 'Dense' },
  { id: 'mixtral-8x22b', vendor: 'Mistral', name: 'Mixtral-8x22B', params: 141, active: 39, kv: 224, max: 65536, type: 'MoE' },
  { id: 'mixtral-8x7b', vendor: 'Mistral', name: 'Mixtral-8x7B', params: 46.7, active: 12.9, kv: 128, max: 32768, type: 'MoE' },

  { id: 'gemma3-27b', vendor: 'Gemma', name: 'Gemma-3-27B', params: 27, kv: 384, max: 131072, type: 'Dense' },
  { id: 'gemma3-12b', vendor: 'Gemma', name: 'Gemma-3-12B', params: 12, kv: 192, max: 131072, type: 'Dense' },
  { id: 'gemma3-4b', vendor: 'Gemma', name: 'Gemma-3-4B', params: 4, kv: 96, max: 131072, type: 'Dense' },

  { id: 'glm52', vendor: 'GLM', name: 'GLM-5.2-753B-A40B', params: 753, active: 40, kv: 90, max: 1048576, type: 'MoE' },
  { id: 'glm46', vendor: 'GLM', name: 'GLM-4.6-355B-A32B', params: 355, active: 32, kv: 160, max: 204800, type: 'MoE' },
  { id: 'glm45-air', vendor: 'GLM', name: 'GLM-4.5-Air-106B', params: 106, active: 12, kv: 96, max: 131072, type: 'MoE' },
  { id: 'glm4-9b-1m', vendor: 'GLM', name: 'GLM-4-9B-Chat-1M', params: 9.4, kv: 96, max: 1048576, type: 'Dense' },

  { id: 'hunyuan-a13b', vendor: '腾讯混元', name: 'Hunyuan-A13B-80B', params: 80, active: 13, kv: 128, max: 262144, type: 'MoE' },
  { id: 'ernie-45-300b', vendor: '百度文心', name: 'ERNIE-4.5-300B-A47B', params: 300, active: 47, kv: 128, max: 131072, type: 'MoE' },

  { id: 'internlm25-7b-1m', vendor: '其他', name: 'InternLM2.5-7B-Chat-1M', params: 7.8, kv: 56, max: 1048576, type: 'Dense' },
  { id: 'internlm25-20b', vendor: '其他', name: 'InternLM2.5-20B', params: 20, kv: 192, max: 32768, type: 'Dense' },
  { id: 'phi4-14b', vendor: '其他', name: 'Phi-4-14B', params: 14.7, kv: 200, max: 16384, type: 'Dense' },
  { id: 'yi34b', vendor: '其他', name: 'Yi-1.5-34B', params: 34, kv: 240, max: 32768, type: 'Dense' },
  { id: 'command-r-plus', vendor: '其他', name: 'Command-R-Plus-104B', params: 104, kv: 256, max: 131072, type: 'Dense' },

  /* ---------- 生图（文生图 / 图像编辑）---------- */
  { id: 'qwen-image', kind: 'image', vendor: '通义千问', name: 'Qwen-Image-20B', params: 20, extra: 15, actBase: 6, type: 'MMDiT' },
  { id: 'qwen-image-2', kind: 'image', vendor: '通义千问', name: 'Qwen-Image-2.0-7B', params: 7, extra: 15, actBase: 4, type: 'MMDiT' },
  { id: 'qwen-image-edit', kind: 'image', vendor: '通义千问', name: 'Qwen-Image-Edit-20B', params: 20, extra: 15, actBase: 8, type: 'MMDiT' },
  { id: 'z-image', kind: 'image', vendor: '通义千问', name: 'Z-Image-Turbo-6B', params: 6, extra: 8, actBase: 4, type: 'DiT' },
  { id: 'flux2-dev', kind: 'image', vendor: 'Black Forest', name: 'FLUX.2-dev-32B', params: 32, extra: 12, actBase: 8, type: 'DiT' },
  { id: 'flux1-dev', kind: 'image', vendor: 'Black Forest', name: 'FLUX.1-dev-12B', params: 12, extra: 10, actBase: 6, type: 'DiT' },
  { id: 'flux1-schnell', kind: 'image', vendor: 'Black Forest', name: 'FLUX.1-schnell-12B', params: 12, extra: 10, actBase: 6, type: 'DiT' },
  { id: 'sd35-large', kind: 'image', vendor: 'Stability', name: 'Stable Diffusion 3.5 Large', params: 8, extra: 10, actBase: 4, type: 'MMDiT' },
  { id: 'sdxl', kind: 'image', vendor: 'Stability', name: 'SDXL 1.0', params: 3.5, extra: 3, actBase: 3, type: 'UNet' },
  { id: 'sd15', kind: 'image', vendor: 'Stability', name: 'Stable Diffusion 1.5', params: 0.9, extra: 2, actBase: 2, type: 'UNet' },
  { id: 'hunyuan-image3', kind: 'image', vendor: '腾讯混元', name: 'HunyuanImage 3.0-80B', params: 80, active: 13, extra: 15, actBase: 8, type: 'MoE DiT' },
  { id: 'hidream-i1', kind: 'image', vendor: '其他', name: 'HiDream-I1-17B', params: 17, extra: 10, actBase: 6, type: 'MoE DiT' },

  /* ---------- 视频（文生视频 / 图生视频）---------- */
  { id: 'minimax-h3', kind: 'video', vendor: 'MiniMax', name: 'MiniMax-H3-33B', params: 33, extra: 78, actBase: 18, type: 'DiT + 音频' },
  { id: 'wan22-a14b', kind: 'video', vendor: '通义千问', name: 'Wan2.2-T2V-A14B', params: 27, active: 14, extra: 4, actBase: 20, type: 'MoE DiT' },
  { id: 'wan22-ti2v-5b', kind: 'video', vendor: '通义千问', name: 'Wan2.2-TI2V-5B', params: 5, extra: 4, actBase: 7, type: 'DiT' },
  { id: 'ltx23', kind: 'video', vendor: 'Lightricks', name: 'LTX-2.3-22B', params: 22, extra: 8, actBase: 14, type: 'DiT' },
  { id: 'hunyuanvideo', kind: 'video', vendor: '腾讯混元', name: 'HunyuanVideo-13B', params: 13, extra: 6, actBase: 28, type: 'DiT' },
  { id: 'hunyuanvideo15', kind: 'video', vendor: '腾讯混元', name: 'HunyuanVideo 1.5-8.3B', params: 8.3, extra: 5, actBase: 14, type: 'DiT' },
  { id: 'cogvideox5b', kind: 'video', vendor: '其他', name: 'CogVideoX-5B', params: 5, extra: 5, actBase: 12, type: 'DiT' },

  /* ---------- 语音（TTS / ASR）---------- */
  { id: 'cosyvoice2', kind: 'audio', vendor: '其他', name: 'CosyVoice2-0.5B', params: 0.5, extra: 2, actBase: 1.5, type: 'TTS' },
  { id: 'indextts2', kind: 'audio', vendor: '其他', name: 'IndexTTS-2-2B', params: 2, extra: 3, actBase: 2, type: 'TTS' },
  { id: 'fish-speech', kind: 'audio', vendor: '其他', name: 'Fish-Speech-1.5-4B', params: 4, extra: 2, actBase: 2, type: 'TTS' },
  { id: 'f5-tts', kind: 'audio', vendor: '其他', name: 'F5-TTS-0.3B', params: 0.3, extra: 1, actBase: 1, type: 'TTS' },
  { id: 'whisper-v3', kind: 'audio', vendor: '其他', name: 'Whisper-large-v3', params: 1.55, extra: 1, actBase: 2, type: 'ASR' },
  { id: 'sensevoice', kind: 'audio', vendor: '其他', name: 'SenseVoice-Small', params: 0.23, extra: 1, actBase: 1, type: 'ASR' }
]

/* 语言模型不写 kind，这里统一补齐，后续按 kind 分组 / 计算 */
MODELS.forEach((m) => { m.kind = m.kind || 'llm' })

function kindOf(m) {
  return m.kind || 'llm'
}

function sizesOf(kind) {
  return kind === 'llm' ? CONTEXTS : SIZES[kind]
}

function vendorsOf(kind) {
  const out = []
  MODELS.forEach((m) => {
    if (kindOf(m) === kind && out.indexOf(m.vendor) < 0) out.push(m.vendor)
  })
  return out
}

const buildDevices = D.buildDevices

function round1(n) {
  return Math.round(n * 10) / 10
}

function gbText(n) {
  if (n >= 1000) return round1(n / 1000) + ' TB'
  return (n >= 100 ? Math.round(n) : round1(n)) + ' GB'
}

/* 解码吞吐展示：上万后换成「万 token/s」，避免结果卡片里塞一长串数字 */
function tpsText(n) {
  if (!(n > 0)) return '—'
  if (n >= 10000) return round1(n / 10000) + ' 万 token/s'
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' token/s'
}

/* 上下文长度展示：1M 不能再写成 1024K */
function ctxTextOf(n) {
  if (n >= 1048576) return round1(n / 1048576) + 'M'
  return n / 1024 + 'K'
}

/* 容量测算：
   权重 = 参数量 × 每参数字节（FP16=2 / FP8=1 / INT4=0.5），留 5% 给 embedding / 输出头；
   语言模型：KV Cache = 单 token KV × 上下文 × 并发（按 FP16 计，不随权重量化下降）；
   生图 / 视频 / 语音：激活显存 = 基准规格单路激活 × 规格倍数 × 并发；
   单台可用 = 显存 × 0.9（Mac 统一内存按 0.7）− 运行时占用。
   语言模型还要过算力关：按单路 TARGET_TPS 的解码体验折算整机吞吐，
   台数取「显存台数」与「算力台数」的较大值，避免高并发被算成一台。 */
function calcFor(device, model, quant, sizeOpt, conc) {
  const weights = model.params * quant.bytes * 1.05 + (model.extra || 0)
  const isLLM = kindOf(model) === 'llm'
  /* perConc：单路（单条请求 / 单张图 / 单条视频）占用的动态显存 */
  const perConc = isLLM
    ? model.kv * sizeOpt.v / 1048576
    : model.actBase * sizeOpt.px
  const act = perConc * conc
  const need = weights + act
  const ratio = device.kind === 'unified' ? 0.7 : 0.9
  const overhead = device.kind === 'unified' ? 2 : 1.5
  const usablePer = Math.max(device.memGB * ratio - overhead, 1)
  const memUnits = Math.max(1, Math.ceil(need / usablePer))

  /* 解码吞吐：MoE 取激活参数，稠密模型取全部参数；单卡带宽按卡数叠加（与回本测算同口径） */
  let tpsPer = 0
  let computeUnits = 0
  if (isLLM && device.bw > 0) {
    const active = model.active || model.params
    const bwUnit = device.bw * (device.cards > 1 ? device.cards * TP_EFF : 1)
    tpsPer = bwUnit / active * BATCH_GAIN
    computeUnits = Math.ceil(conc * TARGET_TPS / tpsPer)
  }
  const units = Math.max(memUnits, computeUnits, 1)
  const totalUsable = units * usablePer
  const memConc = perConc > 0
    ? Math.max(0, Math.floor((totalUsable - weights) / perConc))
    : 0
  /* 最多承载取显存与算力两条线的较小值 */
  const tpsConc = tpsPer > 0 ? Math.floor(tpsPer * units / TARGET_TPS) : 0
  const maxConc = tpsPer > 0 ? Math.min(memConc, tpsConc) : memConc
  return {
    weights,
    kv: act,
    need,
    memUnits,
    computeUnits,
    tpsPer,
    units,
    usablePer,
    totalUsable,
    free: totalUsable - need,
    util: need / totalUsable,
    waste: (totalUsable - need) / need,
    maxConc,
    isLLM
  }
}

Page({
  data: {
    kinds: KINDS,
    kind: 'llm',
    vendors: [],
    vendor: '',
    models: [],
    modelId: 'ds-v41-flash',
    modelInfo: '',
    quantOptions: QUANTS,
    quant: 'fp8',
    contextOptions: [],
    context: 8192,
    ctxTitle: KIND_TEXT.llm.ctx,
    concTip: KIND_TEXT.llm.tip,
    concurrency: '8',
    concPresets: CONC_PRESETS,
    /* 设备 */
    deviceCats: ['全部'].concat(CALC_CATS),
    deviceCat: '全部',
    deviceSheet: false,
    deviceSearch: '',
    deviceList: [],
    deviceKey: '',
    device: null,
    recos: [],
    result: null
  },

  onLoad() {
    this.devices = buildDevices()
    const kind = 'llm'
    const vendors = vendorsOf(kind)
    const vendor = vendors[0]
    const model = this.modelById(this.data.modelId)
    this.setData({
      kind,
      vendors,
      vendor,
      models: this.modelsOf(vendor, kind),
      contextOptions: sizesOf(kind),
      ctxTitle: KIND_TEXT[kind].ctx,
      concTip: KIND_TEXT[kind].tip,
      context: 8192
    })
    this.recalc()
  },

  /* 工具页是公开内容：允许分享给朋友，也允许分享到朋友圈 */
  onShow() {
    guard.enableShare(true)
    sharePoster.prepare('tool', sharePoster.toolSpec('calc'))
  },

  onShareAppMessage() {
    return {
      title: '显卡算力计算器 · 本地部署要几台',
      desc: '语言 / 生图 / 视频 / 语音模型，按并发估算设备数量',
      imageUrl: sharePoster.cached('tool', sharePoster.toolSpec('calc')) || '/assets/share/card-home.png',
      path: '/pages/calc/calc'
    }
  },

  onShareTimeline() {
    return {
      title: '显卡算力计算器 · 本地部署要几台',
      query: '',
      imageUrl: sharePoster.cached('tool', sharePoster.toolSpec('calc')) || '/assets/share/card-home.png'
    }
  },

  modelById(id) {
    return MODELS.filter((m) => m.id === id)[0] || MODELS.filter((m) => kindOf(m) === 'llm')[0]
  },

  modelsOf(vendor, kind) {
    return MODELS.filter((m) => m.vendor === vendor && kindOf(m) === kind).map((m) => ({
      id: m.id,
      name: m.name,
      meta: m.params + 'B · ' + m.type + (m.active ? ' / 激活 ' + m.active + 'B' : '')
    }))
  },

  pickKind(e) {
    const kind = e.currentTarget.dataset.k
    if (kind === this.data.kind) return
    const vendors = vendorsOf(kind)
    const vendor = vendors[0]
    const first = MODELS.filter((m) => m.vendor === vendor && kindOf(m) === kind)[0]
    const contextOptions = sizesOf(kind)
    this.setData({
      kind,
      vendors,
      vendor,
      models: this.modelsOf(vendor, kind),
      modelId: first.id,
      contextOptions,
      ctxTitle: KIND_TEXT[kind].ctx,
      concTip: KIND_TEXT[kind].tip,
      context: contextOptions[0].v
    })
    this.recalc()
  },

  pickVendor(e) {
    const vendor = e.currentTarget.dataset.v
    if (vendor === this.data.vendor) return
    const list = this.modelsOf(vendor, this.data.kind)
    /* 原模型不属于新厂商时自动选中第一个，否则界面没有选中项、结果还停在上一家的模型 */
    const keep = list.some((m) => m.id === this.data.modelId)
    this.setData({
      vendor,
      models: list,
      modelId: keep ? this.data.modelId : (list[0] ? list[0].id : '')
    })
    this.recalc()
  },

  pickModel(e) {
    const id = e.currentTarget.dataset.id
    this.setData({ modelId: id })
    this.recalc()
  },

  pickQuant(e) {
    this.setData({ quant: e.currentTarget.dataset.v })
    this.recalc()
  },

  pickContext(e) {
    this.setData({ context: Number(e.currentTarget.dataset.v) })
    this.recalc()
  },

  onConcInput(e) {
    this.setData({ concurrency: e.detail.value })
    this.recalc()
  },

  pickConc(e) {
    this.setData({ concurrency: String(e.currentTarget.dataset.v) })
    this.recalc()
  },

  reset() {
    const kind = 'llm'
    const vendors = vendorsOf(kind)
    this.setData({
      kind,
      vendors,
      vendor: vendors[0],
      models: this.modelsOf(vendors[0], kind),
      modelId: 'ds-v41-flash',
      quant: 'fp8',
      contextOptions: sizesOf(kind),
      ctxTitle: KIND_TEXT[kind].ctx,
      concTip: KIND_TEXT[kind].tip,
      context: 8192,
      concurrency: '8',
      deviceCat: '全部',
      deviceSearch: '',
      /* 清掉手动选的设备，重置后重新按推荐口径选型 */
      deviceKey: '',
      deviceSheet: false
    })
    this.recalc()
  },

  /* ---------- 设备选择 ---------- */

  openDevices() {
    this.setData({ deviceSheet: true })
    this.refreshDeviceList()
  },

  closeDevices() {
    this.setData({ deviceSheet: false })
  },

  onDeviceSearch(e) {
    this.setData({ deviceSearch: e.detail.value })
    this.refreshDeviceList()
  },

  pickDeviceCat(e) {
    this.setData({ deviceCat: e.currentTarget.dataset.v })
    this.refreshDeviceList()
  },

  pickDevice(e) {
    this.setData({ deviceKey: e.currentTarget.dataset.key, deviceSheet: false })
    this.recalc()
  },

  refreshDeviceList() {
    const kw = String(this.data.deviceSearch || '').trim().toLowerCase()
    const tokens = kw.split(/\s+/).filter(Boolean)
    const cat = this.data.deviceCat
    const calc = this.currentCalc()
    const list = this.devices
      .filter((d) => cat === '全部' || d.cat === cat)
      .filter((d) => {
        if (!tokens.length) return true
        const hay = (d.model + ' ' + d.brand + ' ' + d.cat).toLowerCase()
        return tokens.every((t) => hay.indexOf(t) > -1)
      })
      .map((d) => {
        const r = calcFor(d, calc.model, calc.quant, calc.sizeOpt, calc.conc)
        return Object.assign({}, d, { needText: r.units + ' ' + d.unitLabel })
      })
    this.setData({ deviceList: list })
  },

  /* ---------- 测算 ---------- */

  currentCalc() {
    const model = this.modelById(this.data.modelId)
    const kind = kindOf(model)
    const quant = QUANTS.filter((q) => q.key === this.data.quant)[0] || QUANTS[1]
    const options = sizesOf(kind)
    let sizeOpt = options.filter((o) => o.v === Number(this.data.context))[0]
    if (kind === 'llm' && sizeOpt && sizeOpt.v > model.max) {
      sizeOpt = options.filter((o) => o.v <= model.max).pop()
    }
    if (!sizeOpt) sizeOpt = options[0]
    const conc = Math.min(Math.max(Math.round(Number(this.data.concurrency) || 1), 1), MAX_CONC)
    return { model, kind, quant, sizeOpt, conc }
  },

  recalc() {
    const calc = this.currentCalc()
    const model = calc.model
    const kind = calc.kind
    const quant = calc.quant
    const sizeOpt = calc.sizeOpt
    const conc = calc.conc
    const isLLM = kind === 'llm'
    const text = KIND_TEXT[kind]

    const contextOptions = sizesOf(kind)
    const modelInfo = isLLM
      ? model.params + 'B · ' + model.type +
        (model.active ? '（激活 ' + model.active + 'B）' : '') +
        ' · 最长 ' + ctxTextOf(model.max) + ' 上下文'
      : model.params + 'B · ' + model.type + (model.active ? '（激活 ' + model.active + 'B）' : '') +
        ' · ' + text.comp

    const all = this.devices.map((d, idx) => ({ device: d, r: calcFor(d, model, quant, sizeOpt, conc), idx }))
    const feasible = all.filter((x) => x.r.units <= 16)
    const pool = feasible.length ? feasible : all
    /* 推荐口径：先取最少台数，再在「余量不超最省方案的 15%」里按目录热度挑，
       避免把小模型推成 8 卡大整机，也不把主流机型挤成冷门平台 */
    const minUnits = Math.min.apply(null, pool.map((x) => x.r.units))
    const cands = pool.filter((x) => x.r.units === minUnits)
    const bestWaste = Math.min.apply(null, cands.map((x) => x.r.waste))
    const near = cands.filter((x) => x.r.waste <= bestWaste + 0.15).sort((a, b) => a.idx - b.idx)
    const rest = cands.filter((x) => x.r.waste > bestWaste + 0.15)
      .sort((a, b) => (a.r.waste - b.r.waste) || (a.idx - b.idx))
    const ordered = near.concat(rest)

    /* 同一容量的不同品牌 / 型号只留热度最高的一个，推荐位不重复 */
    const recos = []
    const seenCap = {}
    ordered.forEach((x) => {
      const cap = x.device.kind + '|' + x.device.memGB + '|' + x.device.cards
      if (seenCap[cap] || recos.length >= 5) return
      seenCap[cap] = 1
      recos.push(x)
    })

    let device = this.devices.filter((d) => d.key === this.data.deviceKey)[0]
    if (!device) device = recos.length ? recos[0].device : this.devices[0]
    /* 目录为空时给个兜底，避免模板取空对象属性 */
    if (!device) {
      this.setData({ context: sizeOpt.v, contextOptions, modelInfo, recos: [], result: null, device: null })
      return
    }

    const r = calcFor(device, model, quant, sizeOpt, conc)
    const usesCard = device.unitLabel === '张'
    const machineText = usesCard && r.units > 1
      ? '按 8 卡整机折算约 ' + Math.ceil(r.units / 8) + ' 台，另需 IB / PCIe 交换与机柜配电'
      : ''

    let warn = ''
    if (isLLM && !r.tpsPer && conc > 64) warn = '该设备缺少显存带宽数据，只能按显存估算；高并发下的算力需求未计入，台数可能偏少。'
    else if (quant.key === 'fp16' && model.params >= 70) warn = 'FP16 下模型权重很大，建议改用 FP8 或 INT4 再测算。'
    else if (r.units > 16) warn = '需要 ' + r.units + ' ' + device.unitLabel + '，规模偏大，建议降低并发 / 输出规格，或改用单机显存更大的整机。'
    else if (r.units > 8) warn = '设备数量较多，建议降低并发 / 输出规格，或改用单机显存更大的整机。'

    /* 语言模型同时报显存与算力两条线，避免用户误以为「显存够 = 一台就够」 */
    const tpsNote = r.tpsPer > 0 ? '，单台解码吞吐约 ' + tpsText(r.tpsPer) : ''
    const result = {
      units: r.units,
      unitLabel: device.unitLabel,
      unitsText: r.units + ' ' + device.unitLabel,
      fitText: r.units <= 1 ? '单台即可' : (r.units <= 4 ? '小规模组网' : '需组网部署'),
      weightsText: gbText(r.weights),
      kvText: gbText(r.kv),
      kvLabel: text.act,
      usableText: gbText(r.usablePer),
      totalText: gbText(r.totalUsable),
      freeText: gbText(Math.max(r.free, 0)),
      maxConcText: r.maxConc >= 10000
        ? round1(r.maxConc / 10000) + ' 万路'
        : (r.maxConc > 0 ? r.maxConc + ' 路' : '不足 1 路'),
      isLLM,
      tpsText: isLLM ? tpsText(r.tpsPer) : '',
      boundText: !isLLM ? '显存受限' : (r.computeUnits > r.memUnits ? '算力受限' : '显存受限'),
      machineText,
      warn,
      note: isLLM
        ? '按 ' + quant.name + ' + ' + ctxTextOf(sizeOpt.v) + ' 上下文 × ' + conc + ' 路并发估算：台数取「显存（权重 + KV Cache）」与「算力（每路 ' + TARGET_TPS + ' token/s 解码）」的较大值' + tpsNote + '。预填充、显存带宽与网络会进一步压低实际并发，上线前建议压测。'
        : '按 ' + quant.name + ' + ' + sizeOpt.label + ' × ' + conc + ' 路并发估算；' + text.act + '随分辨率 / 时长 / 批量线性放大，文本编码器与 VAE 按 FP16 常驻计。容量达标不等于性能达标，实际还受显存带宽与算力限制，建议先小规模压测。'
    }

    this.setData({
      context: sizeOpt.v,
      contextOptions,
      modelInfo,
      deviceKey: device.key,
      device: {
        key: device.key,
        cat: device.cat,
        brand: device.brand,
        model: device.model,
        specText: device.specText,
        unitLabel: device.unitLabel
      },
      recos: recos.map((x) => ({
        key: x.device.key,
        model: x.device.model,
        memText: x.device.memGB + 'G',
        units: x.r.units,
        unitLabel: x.device.unitLabel
      })),
      result
    })
  },

  /* 按当前配置去发布采购需求，型号直接带过去 */
  goPublish() {
    const d = this.data.device
    if (!d) {
      wx.showToast({ title: '先选择一台设备', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/publish/publish?agency=buy&target=' + encodeURIComponent(d.model) })
  }
})
