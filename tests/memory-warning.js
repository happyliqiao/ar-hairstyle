/**
 * 内存告警响应（第 32 轮）
 *
 * 试戴页的常驻内存很重：5 张烘焙位图 8.2MB + 4 款分桶 Path2D 约 6MB
 * + 几何缓存 + camera 预览。低端机 / 老 iPhone 在上面停留久了必然收到
 * `wx.onMemoryWarning`。
 *
 * 之前这个回调一个都没接。后果是一条很具体的崩溃链：
 *   level 10 告警 → 我们什么都不做 → level 15 → 微信几秒内销毁小程序
 *   → 用户看到「切了两款发型，小程序自己没了」，
 *     刚拍的照片如果还没落盘就一起没了
 *
 * 更糟的是「告警之后反而更吃内存」：告警往往发生在切换发型时，
 * 而切换会触发 prewarm 连烘 3 张（约 5MB）—— 正好在系统最缺内存的时刻。
 *
 * 这一轮验证三件事：
 *   A. 告警后不再烘焙、不再预热
 *   B. clearBakeCache 把分桶路径也一起还回去（之前只还了一半）
 *   C. App → 页面 的转发链路真的通，页面会重画一帧
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

/* ---------------- Path2D 桩：分桶缓存靠它 ---------------- */

class FakePath2D {
  constructor() { this.ops = 0 }
  moveTo() { this.ops++ }
  lineTo() { this.ops++ }
  bezierCurveTo() { this.ops++ }
  quadraticCurveTo() { this.ops++ }
  closePath() { this.ops++ }
}

/* ---------------- wx 桩 ---------------- */

const state = { bakeCount: 0, renders: 0, warned: [] }

function makeCtx() {
  const grad = { addColorStop() {} }
  return new Proxy({
    createLinearGradient() { return grad },
    createRadialGradient() { return grad },
    measureText() { return { width: 10 } },
    createPattern() { return null }
  }, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k !== 'string') return undefined
      return function () {}
    },
    set() { return true }
  })
}

const wx = new Proxy({
  getStorageSync() { return '' },
  setStorageSync() {},
  removeStorageSync() {},
  getWindowInfo() {
    return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } }
  },
  getSystemInfoSync() {
    return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } }
  },
  getMenuButtonBoundingClientRect() { return { top: 28, bottom: 60, height: 32, width: 87, left: 296, right: 383 } },
  getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
  getFileSystemManager() {
    return { getFileInfo(o) { o && o.success && o.success({ size: 280 * 1024 }) }, saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://a.jpg' }) }, removeSavedFile(o) { o && o.success && o.success({}) } }
  },
  // 每次创建离屏画布都计数：这是「告警后还在偷偷吃内存」的直接证据
  createOffscreenCanvas(o) {
    state.bakeCount++
    return { width: o && o.width, height: o && o.height, getContext() { return makeCtx() } }
  },
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
}, {
  get(t, k) {
    if (k in t) return t[k]
    if (typeof k !== 'string') return undefined
    if (k === 'then') return undefined
    return function () {}
  }
})

global.wx = wx
global.Path2D = FakePath2D

/* ---------------- 载入 tryon 页面 ---------------- */

const g = {
  wx: wx,
  Page(o) { g.__page = o },
  App(o) { g.__app = o },
  getApp() { return { globalData: { shop: {}, cloudReady: false } } },
  getCurrentPages() { return g.__pages || [] },
  Path2D: FakePath2D,
  setTimeout(fn) { return 0 },
  clearTimeout() {},
  setInterval() { return 0 },
  clearInterval() {}
}
g.__page = null
g.__app = null
g.__pages = []
Object.keys(g).forEach(function (k) { global[k] = g[k] })

const hairstyles = require(path.join(ROOT, 'utils/hairstyles'))

delete require.cache[require.resolve(path.join(ROOT, 'pages/tryon/tryon.js'))]
require(path.join(ROOT, 'pages/tryon/tryon.js'))

const pageObj = g.__page
const tryon = {}
Object.keys(pageObj).forEach(function (k) { tryon[k] = pageObj[k] })
tryon.data = JSON.parse(JSON.stringify(pageObj.data || {}))
tryon.setData = function (p, cb) {
  Object.keys(p || {}).forEach(function (k) { tryon.data[k] = p[k] })
  cb && cb()
}
tryon._alive = true
tryon.cw = 375
tryon.ch = 667
tryon.ctx = makeCtx()
// render 里会画到 ctx，这里只需要它不抛
tryon.render = function () { state.renders++ }

/* ================= A. 告警后不再烘焙 ================= */

console.log('\n[A] 告警后不再烘焙 / 不再预热')

hairstyles.setLowMemory(false)
state.bakeCount = 0
const baked1 = hairstyles.drawHair && null
hairstyles.prewarm('bob', 'black')
const bakeAfterPrewarm = state.bakeCount
ck('A1 正常状态下 prewarm 会烘焙 3 张（当前 + 左右邻）', bakeAfterPrewarm === 3, 'count=' + bakeAfterPrewarm)

hairstyles.setLowMemory(true)
ck('A2 setLowMemory(true) 立即生效', hairstyles.isLowMemory() === true)

state.bakeCount = 0
hairstyles.prewarm('wavy', 'black')
ck('A3 告警后 prewarm 是空操作（不再吃 5MB）', state.bakeCount === 0, 'count=' + state.bakeCount)

// drawHair 每帧都会调 getBaked；告警后必须直接走降级，不能每帧试一次烘焙
const before = state.bakeCount
const fakeCtx = makeCtx()
hairstyles.drawHair(fakeCtx, { x: 0, y: 0, w: 300, h: 360, angle: 0 }, 'bob', 'black', 1)
ck('A4 告警后 drawHair 不再创建离屏画布', state.bakeCount === before, 'count=' + (state.bakeCount - before))
ck('A5 告警后 isDegraded 为真（上层据此限帧）', hairstyles.isDegraded() === true)

hairstyles.setLowMemory(false)
ck('A6 解除后 isLowMemory 为 false', hairstyles.isLowMemory() === false)

/* ================= B. 缓存释放的完整性 ================= */

console.log('\n[B] clearBakeCache 要还干净')

hairstyles.setLowMemory(false)
const b1 = hairstyles._getBuckets('bob')
ck('B1 分桶路径已生成', !!b1)
const b2 = hairstyles._getBuckets('bob')
ck('B2 同一款命中缓存（同一引用）', b1 === b2)

hairstyles.clearBakeCache()
const b3 = hairstyles._getBuckets('bob')
ck('B3 clearBakeCache 把分桶路径也清了', !!b3 && b3 !== b1)

/* ================= C. App → 页面 的转发 ================= */

console.log('\n[C] App.onMemoryWarning 转发到当前页')

delete require.cache[require.resolve(path.join(ROOT, 'app.js'))]
require(path.join(ROOT, 'app.js'))
const app = g.__app
ck('C1 App 定义了 onMemoryWarning', app && typeof app.onMemoryWarning === 'function')

let lowCalls = []
tryon.onMemoryLow = function (lv) { lowCalls.push(lv) }
g.__pages = [tryon]

hairstyles.setLowMemory(false)
state.bakeCount = 0
app.onMemoryWarning({ level: 10 })

ck('C2 告警后 hairstyles 进入低内存', hairstyles.isLowMemory() === true)
ck('C3 当前页收到 onMemoryLow', lowCalls.length === 1 && lowCalls[0] === 10, JSON.stringify(lowCalls))

g.__pages = []
lowCalls = []
let threw = false
try { app.onMemoryWarning({ level: 15 }) } catch (e) { threw = true }
ck('C4 没有当前页时不抛异常', threw === false)

/* ================= D. 页面自己的处理 ================= */

console.log('\n[D] tryon.onMemoryLow')

delete tryon.onMemoryLow
Object.keys(pageObj).forEach(function (k) { if (k === 'onMemoryLow') tryon[k] = pageObj[k] })
ck('D1 tryon 实现了 onMemoryLow', typeof tryon.onMemoryLow === 'function')

state.renders = 0
let dThrew = false
try { tryon.onMemoryLow(10) } catch (e) { dThrew = true; console.log('    ' + e.message) }
ck('D2 不抛异常', dThrew === false)
ck('D3 会把当前画面重画一帧（否则 canvas 上留着失效位图）', state.renders === 1, 'renders=' + state.renders)
ck('D4 记下了低内存状态（onShow 时据此解除）', tryon._lowMem === true)

tryon._alive = false
state.renders = 0
tryon.onMemoryLow(10)
ck('D5 页面已销毁时什么都不做', state.renders === 0)
tryon._alive = true

/* ================= E. 跨页面告警的恢复 ================= */

console.log('\n[E] 告警发生在别的页面时，进试戴页能恢复')

// 用户在记录页收到告警：全局降级，但 tryon 页实例还不存在
hairstyles.setLowMemory(true)
const fresh = {}
Object.keys(pageObj).forEach(function (k) { fresh[k] = pageObj[k] })
fresh.data = JSON.parse(JSON.stringify(pageObj.data || {}))
fresh.setData = function (p, cb) { Object.keys(p || {}).forEach(function (k) { fresh.data[k] = p[k] }); cb && cb() }
fresh._alive = true
ck('E1 新页面实例没有 _lowMem 标志', !fresh._lowMem)
ck('E2 但全局已经处于低内存', hairstyles.isLowMemory() === true)

// onShow 会先核对相机权限，桩里走 success 分支后立即回调
fresh.recheckCamera = function (done) { done() }
fresh.probeFrameSize = function () {}
fresh.startTracking = function () {}
fresh.render = function () {}
fresh.onShow()

ck('E3 onShow 后解除降级（不能永远停在低画质）', hairstyles.isLowMemory() === false)

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '内存告警：全部通过' : '内存告警：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
