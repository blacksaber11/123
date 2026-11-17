'use strict'

/**
 * 推广佣金自动打款通道（微信支付 v3）。
 *
 * ⚠️ 本期人工分账，未启用：提现出款改由财务在微信支付商户平台手动操作，中台只回填台账。
 * 本文件仅保留导出签名，避免 server / router 的 require 断裂；`PROMOTE_PAYOUT_MODE`
 * 固定 manual，只有显式配置为 auto（本期不实现）且证书齐全时才会启用。
 *
 * 两种通道：
 * 1. profitSharing：微信支付分账。仅适用于「普通微信支付」订单，且商户号已开通分账能力；
 *    按订单 transaction_id 把佣金直接分到推广者零钱，免手续费。
 *    注意：小程序虚拟支付（道具直购）的二级商户号不支持主动分账，只能走转账。
 * 2. transfer：商家转账到零钱。适用于全部订单（含虚拟支付），单笔由商户出款，
 *    需要商户号已开通「商家转账」且运营账户余额充足。
 *
 * 未启用 / 未配置商户证书时返回 { enabled:false, ok:false, reason }，保留人工打款，绝不伪造成功。
 */

const fs = require('node:fs')
const https = require('node:https')
const crypto = require('node:crypto')

const API_HOST = 'api.mch.weixin.qq.com'

function readKey(env) {
  const inline = String(env.WXPAY_PRIVATE_KEY || '')
  if (inline) return inline.replace(/\\n/g, '\n')
  const file = String(env.WXPAY_PRIVATE_KEY_PATH || '')
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
  return ''
}

/** v3 请求签名：WECHATPAY2-SHA256-RSA2048 */
function authorization(ctx, method, urlPath, body) {
  const nonce = crypto.randomBytes(16).toString('hex')
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`
  const signature = crypto.createSign('RSA-SHA256').update(message, 'utf8').sign(ctx.privateKey, 'base64')
  return `WECHATPAY2-SHA256-RSA2048 mchid="${ctx.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${ctx.serialNo}"`
}

function request(ctx, method, urlPath, payload) {
  const body = payload ? JSON.stringify(payload) : ''
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: API_HOST,
      method,
      path: urlPath,
      timeout: 10000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'suanli-platform-promote/1.0',
        Authorization: authorization(ctx, method, urlPath, body),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {})
      }
    }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { if (raw.length < 65536) raw += chunk })
      res.on('end', () => {
        let data = {}
        try { data = JSON.parse(raw || '{}') } catch (err) { data = { raw } }
        resolve({ status: res.statusCode, data })
      })
    })
    req.on('timeout', () => req.destroy(new Error('微信支付接口超时')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function failReason(data, fallback) {
  return (data && (data.message || data.code)) || fallback
}

function createWxPayoutClient(env) {
  const config = env || {}
  /* 本期人工分账：默认 manual；auto 仅保留开关位，本期不实现自动出款 */
  const manualOnly = String(config.PROMOTE_PAYOUT_MODE || 'manual') !== 'auto'
  const mchid = String(config.WXPAY_MCHID || '')
  const appid = String(config.WXPAY_APPID || config.WX_APPID || '')
  const serialNo = String(config.WXPAY_SERIAL_NO || '')
  const privateKey = readKey(config)
  const enabled = !manualOnly && !!(mchid && appid && serialNo && privateKey)
  const ctx = { mchid, serialNo, privateKey }

  if (!enabled) {
    const reason = manualOnly
      ? '本期人工分账，自动打款未启用'
      : '未配置微信支付商户证书，暂不能自动打款'
    return {
      enabled: false,
      async transfer() {
        return { ok: false, reason }
      },
      async profitSharing() {
        return { ok: false, reason }
      }
    }
  }

  return {
    enabled: true,

    /** 商家转账到零钱：金额单位分 */
    async transfer(input) {
      const amount = Math.round(Number(input && input.amount) * 100)
      if (!amount || amount <= 0) return { ok: false, reason: '转账金额不合法' }
      const payload = {
        appid,
        out_bill_no: String((input && input.outBillNo) || ''),
        transfer_scene_id: String(config.WXPAY_TRANSFER_SCENE_ID || '1001'),
        openid: String((input && input.openid) || ''),
        transfer_amount: amount,
        transfer_remark: String((input && input.description) || '推广佣金提现').slice(0, 32),
        notify_url: String(config.WXPAY_TRANSFER_NOTIFY_URL || '')
      }
      if (!payload.notify_url) delete payload.notify_url
      const res = await request(ctx, 'POST', '/v3/fund-app/mch-transfer/transfer-bills', payload)
      if (res.status !== 200) return { ok: false, reason: failReason(res.data, '商家转账失败') }
      return { ok: true, billNo: res.data.transfer_bill_no || payload.out_bill_no, state: res.data.state }
    },

    /**
     * 微信支付分账：按订单把金额分给推广者零钱，单笔分账后立即完结订单。
     * 要求该订单是普通微信支付（transaction_id 可查）且商户号已开通分账。
     */
    async profitSharing(input) {
      const amount = Math.round(Number(input && input.amount) * 100)
      if (!amount || amount <= 0) return { ok: false, reason: '分账金额不合法' }
      const outOrderNo = String((input && input.outOrderNo) || '')
      const transactionId = String((input && input.transactionId) || '')
      const payload = {
        appid,
        transaction_id: transactionId,
        out_order_no: outOrderNo,
        receivers: [{
          type: 'PERSONAL_OPENID',
          account: String((input && input.receiverOpenid) || ''),
          amount,
          description: String((input && input.description) || '推广佣金').slice(0, 80)
        }],
        unfreeze_unsplit: false
      }
      const res = await request(ctx, 'POST', '/v3/profit-sharing/orders', payload)
      if (res.status !== 200) return { ok: false, reason: failReason(res.data, '分账失败') }
      const finish = await request(ctx, 'POST', `/v3/profit-sharing/orders/${encodeURIComponent(outOrderNo)}/finish-order`, {
        transaction_id: transactionId,
        out_order_no: outOrderNo
      })
      if (finish.status !== 200) return { ok: false, reason: failReason(finish.data, '分账完结失败') }
      return { ok: true, ref: res.data.order_id || outOrderNo }
    }
  }
}

module.exports = { createWxPayoutClient }
