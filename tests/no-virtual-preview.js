/**
 * 去掉「虚拟/卡通化」示意 的回归测试（第 3 轮自查 · 5 轮）
 *
 * 这一轮针对的不是渲染质量，而是**产品在说真话这件事**。
 * 一个试戴小程序最伤人的不是「画得不够像」，而是：
 *   - 没有摄像头也给你一个假人头，让你以为能出图（第 1 轮）
 *   - 没识到脸也在屏幕中央挂一顶发型，让你以为识脸在工作（第 2 轮）
 *   - 识脸彻底不可用时只说「可拖动微调」，画布却是空的（第 3 轮）
 *   - 滑块拖到底画面一动不动，控件是摆设（第 4 轮）
 *   - 按下快门，存下的是一张没有发型的原图（第 5 轮）
 *
 * 每条都对应下面一组断言。断言打在行为上，不打在文案上，
 * 这样以后改文案不会误报，但改坏行为一定会红。
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0
const failures = []

function ck(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; failures.push(name + (detail ? ' -> ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')) }
}

/* ---------------- 定时器 ---------------- */
const timers = []
let timerSeq = 1
function fakeSetTimeout(fn, ms) { const id = timerSeq++; timers.push({ id, fn, ms }); return id }
function fakeClearTimeout(id) {
  for (let i = 0; i < timers.length; i++) if (timers[i].id === id) { timers.splice(i, 1); return }
}
function fireTimers(minMs) {
  const fired = []
  for (let i = timers.length - 1; i >= 0; i--) {
    if (timers[i].ms >= minMs) { const t = timers[i]; timers.splice(i, 1); fired.push(t) }
  }
  fired.reverse().forEach(t => t.fn())
  return fired.length
}
function resetTimers() { timers.length = 0 }

/* ---------------- 可控时钟 ----------------
 * 失脸宽限期（TRACK_KEEP_MS）是按 Date.now() 算的，
 * 只把定时器取出来执行、不推进真实时间，computeBox 会认为
 * 「刚丢的脸，还在宽限期内」，测不出清屏行为。 */
let clockNow = 1700000000000
Date.now = function () { return clockNow }
function advance(ms) { clockNow += ms }

/* ---------------- wx 桩 ---------------- */
const state = {
  mode: 'ok',        // ok | noVK | throwVK | startErr | noOn
  takePhotoCalls: 0,
  toasts: [],
  saveAlbum: 0,
  addRecord: 0,
  handlers: {}
}

function makeCtx(log) {
  const grad = { addColorStop() {} }
  const target = {
    createLinearGradient() { return grad },
    createRadialGradient() { return grad },
    measureText() { return { width: 10 } }
  }
  if (log) {
    target.clearRect = function () { log.push('clearRect') }
  }
  return new Proxy(target, {
    get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; return function () {} },
    set() { return true }
  })
}

function makeImage() {
  const img = {}
  Object.defineProperty(img, 'src', {
    set(v) {
      img._src = v
      img.width = 720
      img.height = 1280
      if (typeof img.onload === 'function') img.onload()
    },
    get() { return img._src }
  })
  return img
}

const wx = new Proxy({
  getStorageSync() { return '' },
  setStorageSync() {},
  removeStorageSync() {},
  getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getMenuButtonBoundingClientRect() { return { top: 28, bottom: 60, height: 32, width: 87, left: 296, right: 383 } },
  getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
  getFileSystemManager() {
    return {
      getFileInfo(o) { o && o.success && o.success({ size: 300 * 1024 }) },
      saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://p.jpg' }) },
      removeSavedFile(o) { o && o.success && o.success({}) }
    }
  },
  createOffscreenCanvas(o) { return { width: o && o.width, height: o && o.height, getContext() { return makeCtx() } } },
  createCameraContext() {
    return {
      onCameraFrame(o) { if (typeof o === 'function') o({ width: 720, height: 1280 }); return { stop() {} } },
      takePhoto(o) {
        state.takePhotoCalls++
        o && o.success && o.success({ tempImagePath: '/tmp/shot.jpg' })
      }
    }
  },
  createSelectorQuery() {
    const q = {
      select() { return q }, selectAll() { return q }, fields() { return q },
      boundingClientRect() { return q }, in() { return q },
      exec(cb) {
        const canvas = { width: 960, height: 1200, getContext() { return makeCtx() }, createImage() { return makeImage() } }
        cb && cb([{ node: canvas, width: 375, height: 667 }])
      }
    }
    return q
  },
  canvasToTempFilePath(o) { o && o.success && o.success({ tempFilePath: '/tmp/composed.jpg' }) },
  saveImageToPhotosAlbum(o) { state.saveAlbum++; o && o.success && o.success({}) },
  showToast(o) { state.toasts.push(o && o.title) },
  hideLoading() {},
  showLoading() {},
  showModal() {},
  vibrateShort() {}
}, {
  get(t, k) {
    if (k === 'createVKSession') {
      if (state.mode === 'noVK') return undefined
      if (state.mode === 'throwVK') return function () { throw new Error('no vk') }
      if (state.mode === 'noOn') return function () { return {} }
      return function () {
        return {
          on(name, fn) { state.handlers[name] = fn },
          start(cb) { cb && cb(state.mode === 'startErr' ? 1001 : 0) },
          destroy() {}
        }
      }
    }
    if (k in t) return t[k]
    if (typeof k !== 'string') return undefined
    if (k === 'then') return undefined
    return function () {}
  }
})

global.wx = wx
if (typeof global.Path2D === 'undefined') global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }

const g = {
  wx: wx,
  Page(o) { g.__page = o },
  getApp() { return { globalData: { shop: {}, cloudReady: false }, flushUpdate() {} } },
  getCurrentPages() { return [] },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval() { return 0 },
  clearInterval() {}
}
g.__page = null
Object.keys(g).forEach(k => { global[k] = g[k] })

/* ---------------- 装载页面 ---------------- */

const drawLog = []

function loadTryon(opts) {
  opts = opts || {}
  resetTimers()
  const abs = path.join(ROOT, 'pages/tryon/tryon.js')
  delete require.cache[require.resolve(abs)]
  require(abs)
  const po = g.__page
  const inst = {}
  Object.keys(po).forEach(k => { inst[k] = po[k] })
  inst.data = JSON.parse(JSON.stringify(po.data || {}))
  inst.setData = function (p, cb) {
    Object.keys(p || {}).forEach(k => { inst.data[k] = p[k] })
    cb && cb()
  }
  inst._alive = true
  inst.cw = 375
  inst.ch = 667
  const log = []
  inst.ctx = makeCtx(log)
  inst.__log = log
  inst.data.cameraReady = true
  inst.data.isDevtools = !!opts.devtools
  // 真实绘制走 hairstyles.drawHair；这里换成记录器，只看「有没有画」。
  const hs = require(path.join(ROOT, 'utils/hairstyles.js'))
  if (!hs.__origDrawHair) hs.__origDrawHair = hs.drawHair
  drawLog.length = 0
  hs.drawHair = function (ctx, box, s, c, k) { drawLog.push({ box: box, style: s, color: c }) }
  return inst
}

/* ================= 第 1 轮：模拟器不出虚拟效果 ================= */

console.log('\n[1] 模拟器不画虚拟头型 / 悬空发型')

const d1 = loadTryon({ devtools: true })
d1.data.manualOn = true          // 就算手动定位开着也不该画
d1.render(true)
ck('1.1 模拟器 render 不画任何发型', drawLog.length === 0, 'drawHair 调用 ' + drawLog.length + ' 次')
ck('1.2 模拟器 render 仍然清空画布（不留上一帧残影）',
  d1.__log.indexOf('clearRect') >= 0, '日志 ' + d1.__log.join(','))

/* ================= 第 2 轮：没脸没手动就不画 ================= */

console.log('\n[2] 没识到脸、用户也没动手时，不挂悬空发型')

const d2 = loadTryon()
d2.data.faceFound = false
d2.data.manualOn = false
const box2 = d2.computeBox()
ck('2.1 computeBox 返回 null', box2 === null, '实际 ' + JSON.stringify(box2))

drawLog.length = 0
d2.render(true)
ck('2.2 render 不画发型', drawLog.length === 0, 'drawHair 调用 ' + drawLog.length + ' 次')
ck('2.3 空框时先 clearRect 再返回（擦掉失脸前的残留）',
  d2.__log.indexOf('clearRect') >= 0, '日志 ' + d2.__log.join(','))
ck('2.4 空框时把 lastBox 清掉（否则拍照会用过期坐标）', !d2.lastBox,
  'lastBox=' + JSON.stringify(d2.lastBox))

const d2b = loadTryon()
d2b.data.faceFound = true
d2b.trackedBox = { x: 90, y: 120, w: 200, h: 240 }
d2b.trackedAngle = 0
d2b.trackedLostAt = 0
ck('2.5 识到脸时 computeBox 正常返回框', !!d2b.computeBox())

/* ---- 失脸宽限期：2.5 秒后必须主动擦掉，不能停在失脸前的画面上 ---- */

console.log('\n[2b] 失脸宽限期结束后主动清屏')

const d2c = loadTryon()
state.mode = 'ok'
state.handlers = {}
d2c.data.faceFound = true
d2c.trackedBox = { x: 90, y: 120, w: 200, h: 240 }
d2c.trackedAngle = 0
d2c.trackedLostAt = 0
d2c.startTracking()
ck('2b.1 startTracking 注册了 removeAnchors 回调', typeof state.handlers.removeAnchors === 'function')

drawLog.length = 0
d2c.__log.length = 0
state.handlers.removeAnchors()
ck('2b.2 丢锚点当下先提示「把脸放进画面」', d2c.data.faceFound === false)
ck('2b.3 丢锚点当下不清空（宽限期内还跟着脸，避免抖动）', drawLog.length === 1,
  'drawHair ' + drawLog.length + ' 次')

drawLog.length = 0
d2c.__log.length = 0
advance(2600)          // 真的过了宽限期
fireTimers(2500)
ck('2b.4 宽限期结束后主动重绘一次', d2c.__log.indexOf('clearRect') >= 0)
ck('2b.5 宽限期结束后不再画发型（不留悬空假发）', drawLog.length === 0,
  'drawHair ' + drawLog.length + ' 次')

/* ================= 第 3 轮：识脸不可用要给出明确入口 ================= */

console.log('\n[3] 识脸不可用 → 如实告知 + 手动定位入口')

const degradeCases = [
  ['noVK', '微信版本没有 VKSession'],
  ['throwVK', 'createVKSession 抛异常'],
  ['noOn', '返回的对象没有 on 方法'],
  ['startErr', 'session.start 返回错误码']
]
degradeCases.forEach(function (c) {
  state.mode = c[0]
  const p = loadTryon()
  p.startTracking()
  ck('3.x ' + c[1] + ' → arUnavailable=true', p.data.arUnavailable === true,
    '实际 ' + p.data.arUnavailable + ' / status=' + p.data.statusText)
  ck('3.x ' + c[1] + ' → 文案不再声称「可拖动微调」',
    !/可拖动微调/.test(p.data.statusText || ''), 'status=' + p.data.statusText)
})
state.mode = 'ok'

const d3 = loadTryon()
d3.data.arUnavailable = true
d3.data.faceFound = false
d3.data.manualOn = false
ck('3.5 未进入手动模式时画布为空（不冒充 AR）', d3.computeBox() === null)
d3.enterManual()
ck('3.6 点「手动定位」后 manualOn=true', d3.data.manualOn === true)
ck('3.7 点「手动定位」后状态文案写明「手动」', /手动/.test(d3.data.statusText), 'status=' + d3.data.statusText)
ck('3.8 进入手动模式后 computeBox 给出默认位置', !!d3.computeBox())

const d3b = loadTryon()
d3b.data.faceFound = true
d3b.data.manualOn = false
d3b.data.statusText = '已锁定人脸 · 实时试戴中'
d3b.enterManual()
ck('3.9 识脸正常时 enterManual 不抢状态文案（不把 AR 说成手动）',
  d3b.data.manualOn === false && d3b.data.statusText === '已锁定人脸 · 实时试戴中',
  'manualOn=' + d3b.data.manualOn + ' status=' + d3b.data.statusText)

const wxml = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.wxml'), 'utf8')
ck('3.10 wxml 有降级卡片，且只在识脸不可用且未手动时出现',
  /arUnavailable\s*&&\s*!faceFound\s*&&\s*!manualOn/.test(wxml))
ck('3.11 降级卡片的按钮绑到 enterManual', /bindtap="enterManual"/.test(wxml))
ck('3.12 款式详情里的识脸状态是三态，不再把「没识到」写成「手动定位」',
  /manualOn \? '手动定位' : '未识别到'/.test(wxml))

/* ================= 第 4 轮：滑块不是摆设 ================= */

console.log('\n[4] 拉微调滑块 = 手动定位，画面必须跟着动')

const sliderHandlers = ['onSizeChanging', 'onYChanging', 'onRotChanging', 'onSizeChange', 'onYChange', 'onRotChange']
sliderHandlers.forEach(function (h) {
  const p = loadTryon()
  p.data.faceFound = false
  p.data.manualOn = false
  p[h]({ detail: { value: 120 } })
  ck('4.x ' + h + ' 会置 manualOn', p.data.manualOn === true, 'manualOn=' + p.data.manualOn)
  ck('4.x ' + h + ' 之后画布有内容可画', p.computeBox() !== null)
})

const d4 = loadTryon()
d4.data.faceFound = true
d4.data.manualOn = false
d4.data.statusText = '已锁定人脸 · 实时试戴中'
d4.onSizeChanging({ detail: { value: 130 } })
ck('4.7 识脸正常时拉滑块不改状态文案', d4.data.statusText === '已锁定人脸 · 实时试戴中',
  'status=' + d4.data.statusText)

/* ================= 第 5 轮：没有位置就不许按快门 ================= */

console.log('\n[5] 没有可信位置时不产出「没有发型的原图」')

state.takePhotoCalls = 0
state.toasts.length = 0
const d5 = loadTryon()
d5.data.faceFound = false
d5.data.manualOn = false
d5.data.arUnavailable = true
d5.capture()
ck('5.1 空框时不会调 takePhoto', state.takePhotoCalls === 0, 'takePhoto ' + state.takePhotoCalls + ' 次')
ck('5.2 空框时给出可执行的下一步（提示手动定位）',
  /手动定位/.test(d5.data.toast || ''), 'toast=' + JSON.stringify(d5.data.toast))
ck('5.3 空框时不进入 shooting 状态（快门不会卡死）', d5.data.shooting === false)

state.takePhotoCalls = 0
state.toasts.length = 0
const d5b = loadTryon()
d5b.data.faceFound = false
d5b.data.manualOn = false
d5b.data.arUnavailable = false
d5b.capture()
ck('5.4 识脸可用但还没识到脸时，提示把脸放进取景框',
  /把脸放进(虚线框|画面)/.test(d5b.data.toast || ''), 'toast=' + JSON.stringify(d5b.data.toast))
ck('5.5 同样不调 takePhoto', state.takePhotoCalls === 0)

state.takePhotoCalls = 0
const d5c = loadTryon()
d5c.data.manualOn = true          // 手动定位已开 = 有可信位置
d5c.capture()
ck('5.6 手动定位后快门正常可用', state.takePhotoCalls === 1, 'takePhoto ' + state.takePhotoCalls + ' 次')

/* ================= 汇总 ================= */

require(path.join(ROOT, 'utils/hairstyles.js')).drawHair = require(path.join(ROOT, 'utils/hairstyles.js')).__origDrawHair

console.log('\n[去掉虚拟卡通化 · 5 轮] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('\n失败项:')
  failures.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
console.log('  覆盖：模拟器不出图 / 空框不挂发 / 识脸不可用降级入口 / 滑块非摆设 / 快门不产假结果')
