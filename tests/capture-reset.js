/**
 * 拍照失败后的状态复位（第 35 轮）
 *
 * 拍照时会把发型框冻结在按下快门那一刻（boxFrozen），
 * 目的是让「照片里的发型位置」和「按下快门时的预览」完全一致。
 *
 * 问题出在**失败路径**上：capture() 里只有 success 会走到 compose，
 * 而 compose 内部每条失败分支都记得解冻，唯独 capture() 自己的两条
 * 早退路径（拿不到 cameraContext、takePhoto 失败）只复位了 shooting，
 * 没有解冻。
 *
 * 后果不是「这次没拍成」那么轻：
 *   boxFrozen 一直为 true → render 永远用那个静止的 frozenBox →
 *   用户怎么动脸、怎么拖发型都不跟手，画面像卡死了一样。
 *   他完全不知道要退出重进才能恢复，只会觉得「这个功能坏了」。
 *
 * 同一类问题还有快门锁死：takePhoto 的回调在真机上不是「一定会来」的
 * （相机被抢占、来电、拍到一半切走），shooting 停在 true，
 * 快门按钮永久禁用。这一轮一起加看门狗兜住。
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

/* ---------------- 可控定时器 ---------------- */

const timers = []
let timerSeq = 1

function fakeSetTimeout(fn, ms) {
  const id = timerSeq++
  timers.push({ id: id, fn: fn, ms: ms })
  return id
}
function fakeClearTimeout(id) {
  for (let i = 0; i < timers.length; i++) {
    if (timers[i].id === id) { timers.splice(i, 1); return }
  }
}
function fireTimers(minMs) {
  const fired = []
  for (let i = timers.length - 1; i >= 0; i--) {
    if (timers[i].ms >= minMs) {
      const t = timers[i]
      timers.splice(i, 1)
      fired.push(t)
    }
  }
  fired.reverse().forEach(function (t) { t.fn() })
  return fired.length
}

/* ---------------- wx 桩 ---------------- */

const state = {
  mode: 'ok',          // ok | takeFail | noCtx | nullNode | exportFail | imgError
  toasts: [],
  shootAt: 0
}

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

function makeImage() {
  const img = {}
  Object.defineProperty(img, 'src', {
    set(v) {
      img._src = v
      if (state.mode === 'imgError') {
        if (typeof img.onerror === 'function') img.onerror({})
        return
      }
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
    if (state.mode === 'noCtx') throw new Error('no camera')
    return {
      onCameraFrame(o) { if (typeof o === 'function') o({ width: 720, height: 1280 }); return { stop() {} } },
      takePhoto(o) {
        if (state.mode === 'takeFail') {
          o && o.fail && o.fail({ errMsg: 'camera busy' })
          return
        }
        o && o.success && o.success({ tempImagePath: '/tmp/shot.jpg' })
      }
    }
  },
  createVKSession() { return { on() {}, start(cb) { cb && cb(0) }, destroy() {} } },
  createSelectorQuery() {
    const q = {
      select() { return q }, selectAll() { return q }, fields() { return q },
      boundingClientRect() { return q }, in() { return q },
      exec(cb) {
        if (state.mode === 'nullNode') { cb && cb([null]); return }
        const canvas = {
          width: 960, height: 1200,
          getContext() { return makeCtx() },
          createImage() { return makeImage() }
        }
        cb && cb([{ node: canvas, width: 375, height: 667 }])
      }
    }
    return q
  },
  canvasToTempFilePath(o) {
    if (state.mode === 'exportFail') { o && o.fail && o.fail({ errMsg: 'export fail' }); return }
    o && o.success && o.success({ tempFilePath: '/tmp/composed.jpg' })
  },
  saveImageToPhotosAlbum(o) { o && o.success && o.success({}) },
  showToast(o) { state.toasts.push(o && o.title) },
  hideLoading() {},
  showLoading() {},
  showModal() {},
  vibrateShort() {}
}, {
  get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} }
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
  inst.data.cameraReady = true
  inst.data.isDevtools = false
  inst.lastBox = { x: 100, y: 100, w: 300, h: 360, angle: 0 }
  inst.render = function () {}
  return inst
}

function frozen(p) {
  return p.boxFrozen === true || !!p.frozenBox
}

/* ================= A. 每条失败路径都要解冻 ================= */

console.log('\n[A] 失败路径必须解冻')

state.mode = 'takeFail'
const p1 = loadTryon()
p1.capture()
ck('A1 takePhoto 失败后 shooting 复位', p1.data.shooting === false)
ck('A2 takePhoto 失败后冻结解除（否则预览永久不跟脸）', !frozen(p1),
  'boxFrozen=' + p1.boxFrozen + ' frozenBox=' + JSON.stringify(p1.frozenBox))

state.mode = 'noCtx'
const p2 = loadTryon()
p2.camCtx = null
p2.capture()
ck('A3 拿不到 cameraContext 时解冻', !frozen(p2))
ck('A4 拿不到 cameraContext 时 shooting 复位', p2.data.shooting === false)

state.mode = 'nullNode'
const p3 = loadTryon()
p3.capture()
ck('A5 合成节点取不到时解冻', !frozen(p3))
ck('A6 合成节点取不到时 shooting 复位', p3.data.shooting === false)

state.mode = 'exportFail'
const p4 = loadTryon()
p4.capture()
ck('A7 导出图片失败时解冻', !frozen(p4))

state.mode = 'imgError'
const p5 = loadTryon()
p5.capture()
ck('A8 照片读取失败时解冻', !frozen(p5))

state.mode = 'ok'
const p6 = loadTryon()
p6.capture()
ck('A9 成功路径也会解冻（afterCompose 里）', !frozen(p6))

/* ================= B. 快门看门狗 ================= */

console.log('\n[B] 快门不会永久锁死')

// takePhoto 既不成功也不失败 —— 相机被抢占 / 来电时真会出现
state.mode = 'hang'
const p7 = loadTryon()
// 用 ok 模式但把回调吞掉
const realCam = wx.createCameraContext
global.wx.createCameraContext = function () {
  return {
    onCameraFrame(o) { if (typeof o === 'function') o({ width: 720, height: 1280 }); return { stop() {} } },
    takePhoto() { /* 回调永远不来 */ }
  }
}
p7.capture()
ck('B1 拍照中 shooting 为 true', p7.data.shooting === true)
ck('B2 拍照中冻结生效', frozen(p7))

const fired = fireTimers(20000)
ck('B3 看门狗被挂上了', fired > 0, 'fired=' + fired)
ck('B4 超时后 shooting 强制复位（快门不再是灰的）', p7.data.shooting === false)
ck('B5 超时后冻结也解除', !frozen(p7))
ck('B6 超时给了用户一句说明', p7.data.toast === '拍照超时，请重试', JSON.stringify(p7.data.toast))
global.wx.createCameraContext = realCam

// 正常拍完的路径，看门狗触发时应该什么都不做
state.mode = 'ok'
const p8 = loadTryon()
p8.capture()
ck('B7 正常拍完后 shooting 已是 false', p8.data.shooting === false)
const beforeToast = p8.data.toast
fireTimers(20000)
ck('B8 看门狗对已完成流程无副作用', p8.data.toast === beforeToast, JSON.stringify(p8.data.toast))

/* ================= C. 销毁时清定时器 ================= */

console.log('\n[C] 页面销毁要清掉看门狗')

state.mode = 'hang'
const p9 = loadTryon()
p9.capture()
const beforeUnload = timers.length
p9.onUnload()
ck('C1 onUnload 清掉了看门狗', timers.length < beforeUnload, 'before=' + beforeUnload + ' after=' + timers.length)

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '拍照复位：全部通过' : '拍照复位：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
