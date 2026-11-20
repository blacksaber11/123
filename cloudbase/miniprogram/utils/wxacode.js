/**
 * 小程序码文件：服务端返回 base64，写成本地临时文件后供海报 canvas 绘制。
 * 同一页面参数只请求一次；服务端 / 本地写文件失败时返回空串，海报照常生成（不带码）。
 */

const { wxacode, readToken } = require('./request')

const cache = new Map()
let seq = 0

function fileOf(path) {
  const raw = String(path || '')
  if (!raw) return Promise.resolve('')
  /* 码由服务端按「当前登录的推广者」追加推广码：缓存按登录态隔离，
     避免同一台设备切换账号后复用上一个账号的码，扫进来绑到错误的人 */
  const key = raw + '@' + readToken()
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  return wxacode(raw, 280).then((dataUrl) => new Promise((resolve) => {
    const base64 = String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '')
    if (!base64) {
      resolve('')
      return
    }
    seq += 1
    const filePath = wx.env.USER_DATA_PATH + '/wxacode-' + Date.now() + '-' + seq + '.png'
    try {
      wx.getFileSystemManager().writeFile({
        filePath: filePath,
        data: base64,
        encoding: 'base64',
        success: () => {
          cache.set(key, filePath)
          resolve(filePath)
        },
        fail: () => resolve('')
      })
    } catch (err) {
      resolve('')
    }
  })).catch(() => '')
}

module.exports = { fileOf }
