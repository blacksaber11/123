/**
 * 定位授权：登录成功后申请一次系统定位权限，用于按城市匹配货源与需求。
 * 明确拒绝过的用户不再反复弹窗，可在设置里手动开启；失败一律静默，不阻塞进入程序。
 */
const { readUser, writeUser } = require('./auth')
const { CITY_TREE } = require('./region')

function requestLocation(app) {
  return new Promise((resolve) => {
    if (typeof wx.getLocation !== 'function') {
      resolve(null)
      return
    }
    const apply = () => {
      wx.getLocation({
        type: 'gcj02',
        success: (loc) => {
          if (!loc) {
            resolve(null)
            return
          }
          if (app && app.globalData) app.globalData.geo = { lat: loc.latitude, lng: loc.longitude }
          /* 未登录时不写半截用户，等登录后再由页面读取 globalData.geo */
          const user = readUser()
          if (user && user.uid) {
            writeUser(Object.assign({}, user, { geo: true, lat: loc.latitude, lng: loc.longitude }))
          }
          resolve(loc)
        },
        fail: () => resolve(null)
      })
    }
    wx.getSetting({
      success: (res) => {
        const auth = res && res.authSetting ? res.authSetting['scope.userLocation'] : undefined
        /* undefined 表示从未申请过，可以直接拉起授权；false 表示已拒绝，不再打扰 */
        if (auth === false) {
          resolve(null)
          return
        }
        apply()
      },
      fail: apply
    })
  })
}

/**
 * 从地图返回的地址里识别省 / 市：优先匹配完整市名，再匹配去掉「市 / 地区 / 盟 / 自治州」的简称。
 * 例：「四川省成都市武侯区…」→ 四川省 / 成都市；「北京市朝阳区…」→ 北京市 / 北京市。
 */
function cityFromAddress(address) {
  const text = String(address || '').trim()
  if (!text) return null
  const provinces = Object.keys(CITY_TREE)
  for (let i = 0; i < provinces.length; i++) {
    const province = provinces[i]
    const cities = CITY_TREE[province] || []
    for (let j = 0; j < cities.length; j++) {
      const city = cities[j]
      const short = city.replace(/(市|地区|盟|自治州)$/, '')
      if (text.indexOf(city) > -1 || (short && text.indexOf(short) > -1)) {
        return { province, city }
      }
    }
  }
  return null
}

/**
 * 定位并选择城市：拉起微信地图，用户确认位置后从地址中解析城市。
 * 只有用户主动点击「定位」才会调用，不在页面加载时反复弹窗。
 */
function chooseCity() {
  return new Promise((resolve, reject) => {
    if (typeof wx.chooseLocation !== 'function') {
      reject({ code: 'UNSUPPORTED', message: '当前微信版本不支持定位，请手动选择城市' })
      return
    }
    wx.chooseLocation({
      success: (res) => {
        const hit = cityFromAddress(((res && res.address) || '') + ' ' + ((res && res.name) || ''))
        if (hit) {
          resolve(hit)
          return
        }
        reject({ code: 'NO_CITY', message: '没有识别到城市，请手动选择' })
      },
      fail: (err) => {
        const msg = String((err && err.errMsg) || '')
        if (/cancel/i.test(msg)) {
          reject({ code: 'CANCEL', message: '' })
          return
        }
        if (/auth|deny|denied|permission/i.test(msg)) {
          reject({ code: 'AUTH', message: '未授权位置信息，请在右上角「···」→「设置」中开启定位后重试' })
          return
        }
        reject({ code: 'FAIL', message: '定位失败，请手动选择城市' })
      }
    })
  })
}

module.exports = { requestLocation, chooseCity, cityFromAddress }
