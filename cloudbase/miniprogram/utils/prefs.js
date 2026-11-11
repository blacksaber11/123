/* 本地偏好：水印保护默认开启，用户可在「设置」关闭 */
const WM_KEY = 'sl_watermark'

function watermarkOn() {
  try {
    const v = wx.getStorageSync(WM_KEY)
    return v === '' || v === undefined || v === null ? true : v !== false
  } catch (e) {
    return true
  }
}

function setWatermark(on) {
  try {
    wx.setStorageSync(WM_KEY, !!on)
  } catch (e) {}
}

module.exports = { watermarkOn, setWatermark }
