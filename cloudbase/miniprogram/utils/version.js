/* 版本号唯一来源：「我的 - 设置」与「关于平台」共用，避免两处显示不一致 */

/* 兜底版本号：上传脚本会把它改成与上传版本一致；真机 / 体验版优先用微信下发的版本号 */
const FALLBACK_VERSION = '1.00'

function currentVersion() {
  try {
    const info = wx.getAccountInfoSync()
    const v = info && info.miniProgram && info.miniProgram.version
    if (v) return v
  } catch (e) { /* 低版本基础库没有该接口，用兜底常量 */ }
  return FALLBACK_VERSION
}

module.exports = {
  FALLBACK_VERSION,
  currentVersion
}
