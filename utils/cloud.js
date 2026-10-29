/**
 * 云服务客户端
 *
 * 当前小程序以「本机模式」运行：实时试戴、拍照合成、试戴记录全部在本机完成，
 * 不依赖任何服务器，相机画面也不会离开设备。
 *
 * 如果要开启云端同步（多设备同步试戴记录 / 门店端查看客户试戴历史），需要三步：
 *   1. 开通云服务，拿到 publicConfig（endpoint + publishableKey）；
 *   2. 项目根目录执行 npm install，然后在开发者工具里「工具 → 构建 npm」；
 *   3. 把下面 CLOUD_INIT 里的代码放开，并把 publicConfig 填进 utils/cloud-config.js。
 *
 * 未完成前两步之前不要放开，否则会因找不到 SDK 而编译失败。
 */

const cfg = require('./cloud-config')

const isConfigured = !!(cfg && cfg.endpoint && cfg.publishableKey)

/*
const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')

const client = createMiniProgramWorkBuddyCloud({
  endpoint: cfg.endpoint,
  publishableKey: cfg.publishableKey,
  wx: createDiagnosticWx(wx)
})
*/

module.exports = {
  cloud: null,
  isReady: false,
  isConfigured: isConfigured
}
