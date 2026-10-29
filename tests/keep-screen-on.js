/**
 * 屏幕常亮（第 34 轮）
 *
 * 试戴时用户把手机举在面前对着镜子看效果，两只手都不在屏幕上 ——
 * iOS 默认 30 秒、部分安卓 15 秒就自动熄屏。画面一黑，
 * 用户的第一反应是「小程序崩了」，而不是「屏幕睡了」。
 * 店里这种「举着看十几秒」的用法，不常亮基本没法用。
 *
 * 但 setKeepScreenOn 是**全局**状态，不是页面级：
 * 离开试戴页不关掉，整个小程序（首页、记录页）都不熄屏，一下午能白耗掉一截电。
 * 这一轮把「该开的时候开、该关的时候一定关」逐条钉住。
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0
const failures = []

function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')) }
}

/* ---------------- wx 桩 ---------------- */

const state = { calls: [], throwOnKeep: false, noApi: false }

function makeCtx() {
  const grad = { addColorStop() {} }
  return new Proxy({
    createLinearGradient() { return grad },
    createRadialGradient() { return grad },
    measureText() { return { width: 10 } }
  }, {
    get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; return function () {} },
    set() { return true }
  })
}

const wxBase = {
  getStorageSync() { return '' },
  setStorageSync() {},
  removeStorageSync() {},
  getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getMenuButtonBoundingClientRect() { return { top: 28, bottom: 60, height: 32, width: 87, left: 296, right: 383 } },
  getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
  getFileSystemManager() {
    return { getFileInfo(o) { o && o.success && o.success({ size: 1024 }) }, saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://a.jpg' }) }, removeSavedFile(o) { o && o.success && o.success({}) } }
  },
  createOffscreenCanvas(o) { return { width: o && o.width, height: o && o.height, getContext() { return makeCtx() } } },
  createCameraContext() {
    return {
      onCameraFrame(o) { if (typeof o === 'function') o({ width: 720, height: 1280 }); return { stop() {} } },
      takePhoto(o) { o && o.success && o.success({ tempImagePath: '/tmp/s.jpg' }) }
    }
  },
  createVKSession() { return { on() {}, start(cb) { cb && cb(0) }, destroy() {} } },
  createSelectorQuery() {
    const q = { select() { return q }, selectAll() { return q }, fields() { return q }, boundingClientRect() { return q }, in() { return q }, exec(cb) { cb && cb([null]) } }
    return q
  },
  showToast() {},
  showLoading() {},
  hideLoading() {},
  showModal() {},
  vibrateShort() {}
}

function makeWx() {
  const base = Object.assign({}, wxBase)
  if (!state.noApi) {
    base.setKeepScreenOn = function (o) {
      if (state.throwOnKeep) throw new Error('boom')
      state.calls.push(!!(o && o.keepScreenOn))
      // 真实实现是异步回调，这里保持异步语义但同步触发，便于断言
      if (o && o.fail && state.throwOnKeep) o.fail({ errMsg: 'not supported' })
    }
  }
  return new Proxy(base, {
    get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} }
  })
}

global.wx = makeWx()
if (typeof global.Path2D === 'undefined') global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }

/* ---------------- 载入 tryon ---------------- */

const g = {
  wx: global.wx,
  Page(o) { g.__page = o },
  getApp() { return { globalData: { shop: {}, cloudReady: false }, flushUpdate() {} } },
  getCurrentPages() { return [] },
  setTimeout(fn) { return 0 },
  clearTimeout() {},
  setInterval() { return 0 },
  clearInterval() {}
}
g.__page = null
Object.keys(g).forEach(function (k) { global[k] = g[k] })

function loadTryon() {
  const abs = path.join(ROOT, 'pages/tryon/tryon.js')
  delete require.cache[require.resolve(abs)]
  require(abs)
  const po = g.__page
  const inst = {}
  Object.keys(po).forEach(function (k) { inst[k] = po[k] })
  inst.data = JSON.parse(JSON.stringify(po.data || {}))
  inst.setData = function (p, cb) { Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] }); cb && cb() }
  inst._alive = true
  inst.cw = 375
  inst.ch = 667
  inst.ctx = makeCtx()
  inst.render = function () {}
  return inst
}

/* ================= A. 什么时候该开 ================= */

console.log('\n[A] 相机就绪后才开')

const p1 = loadTryon()
ck('A1 刚进页面不常亮（相机还没授权，常亮是白耗电）', state.calls.length === 0, JSON.stringify(state.calls))

p1.afterCameraReady()
ck('A2 相机就绪后开启常亮', state.calls.length === 1 && state.calls[0] === true, JSON.stringify(state.calls))

p1.afterCameraReady()
p1.afterCameraReady()
ck('A3 重复就绪不会重复发请求（幂等）', state.calls.length === 1, JSON.stringify(state.calls))

/* ================= B. 什么时候必须关 ================= */

console.log('\n[B] 离开页面一定关')

p1.onHide()
ck('B1 onHide 关掉常亮（否则整个小程序都不熄屏）', state.calls[state.calls.length - 1] === false, JSON.stringify(state.calls))

state.calls.length = 0
// 模拟「切到别的页面再回来」：相机是好的，页面实例还在
p1.data.cameraReady = true
p1.probeFrameSize = function () {}
p1.startTracking = function () {}
p1.onShow.call(p1)
ck('B2 回到前台重新打开', state.calls.length === 1 && state.calls[0] === true, JSON.stringify(state.calls))

state.calls.length = 0
p1.onUnload()
ck('B3 onUnload 关掉常亮', state.calls.length === 1 && state.calls[0] === false, JSON.stringify(state.calls))

const p2 = loadTryon()
state.calls.length = 0
p2.afterCameraReady()
state.calls.length = 0
p2.onCameraError({ detail: 'err' })
ck('B4 相机异常时关掉常亮', state.calls.length === 1 && state.calls[0] === false, JSON.stringify(state.calls))

const p3 = loadTryon()
state.calls.length = 0
p3.afterCameraReady()
state.calls.length = 0
// 模拟「切到系统设置把相机权限关掉再切回来」
p3.data.cameraReady = true
global.wx.getSetting = function (o) { o && o.success && o.success({ authSetting: { 'scope.camera': false } }) }
p3.recheckCamera(function () {})
ck('B5 权限被撤销时关掉常亮', state.calls.length === 1 && state.calls[0] === false, JSON.stringify(state.calls))
global.wx.getSetting = wxBase.getSetting

/* ================= C. 环境异常 ================= */

console.log('\n[C] 环境不支持时不炸')

const p4 = loadTryon()
state.throwOnKeep = true
let c1Threw = false
try { p4.afterCameraReady() } catch (e) { c1Threw = true }
ck('C1 setKeepScreenOn 抛异常时不冒泡', c1Threw === false)
state.throwOnKeep = false

state.noApi = true
global.wx = makeWx()
const p5 = loadTryon()
let c2Threw = false
try { p5.afterCameraReady() } catch (e) { c2Threw = true }
ck('C2 基础库没有 setKeepScreenOn 时不炸', c2Threw === false)
state.noApi = false
global.wx = makeWx()

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '屏幕常亮：全部通过' : '屏幕常亮：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
