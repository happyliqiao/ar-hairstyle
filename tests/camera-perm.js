/**
 * 相机权限生命周期测试
 *
 * 覆盖的是「权限不是一次性决定」这件事：
 *   1 首次进入：从未询问 → 授权 → 开相机
 *   2 首次进入：用户拒绝 → 停在引导态，且不建 VKSession
 *   3 使用中权限被撤销（切出去到系统设置关掉再回来）
 *      → 必须 teardown（停 VKSession / 帧监听）、切回引导态、
 *        不能留着 cameraReady=true 让画面停在最后一帧
 *   4 撤销后又在设置里打开 → 自动恢复，不需要用户再点按钮
 *   5 getSetting 本身失败 → 不能卡死，按「未知」继续尝试开相机
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) pass++
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')) }
}

/* ---------- 可编程的 wx 桩 ---------- */

function buildEnv(opts) {
  const state = {
    auth: opts.auth,          // undefined / true / false
    getSettingFails: !!opts.getSettingFails,
    createdSessions: 0,
    destroyedSessions: 0,
    openSettingCalls: 0,
    authorizeCalls: 0,
    modalCalls: 0
  }

  const wx = {
    getSetting(o) {
      if (state.getSettingFails) {
        o && o.fail && o.fail({ errMsg: 'mock getSetting fail' })
        return
      }
      o && o.success && o.success({ authSetting: { 'scope.camera': state.auth } })
    },
    authorize(o) {
      state.authorizeCalls++
      if (state.auth === false) {
        o && o.fail && o.fail({ errMsg: 'authorize:fail auth deny' })
      } else {
        state.auth = true
        o && o.success && o.success({})
      }
    },
    openSetting(o) {
      state.openSettingCalls++
      state.auth = true
      o && o.success && o.success({ authSetting: { 'scope.camera': true } })
    },
    showModal(o) {
      state.modalCalls++
      o && o.success && o.success({ confirm: false, cancel: true })
    },
    getSystemInfoSync() {
      return {
        platform: 'android', statusBarHeight: 24, pixelRatio: 3,
        screenWidth: 390, screenHeight: 844, windowWidth: 390, windowHeight: 700,
        safeArea: { top: 24, left: 0, right: 390, bottom: 810, width: 390, height: 786 }
      }
    },
    getWindowInfo() { return this.getSystemInfoSync() },
    createSelectorQuery() {
      const q = {
        select() { return q }, selectAll() { return q }, fields() { return q },
        boundingClientRect() { return q }, in() { return q },
        exec(cb) { if (cb) cb([null, null]) }
      }
      return q
    },
    createCameraContext() {
      return {
        onCameraFrame(o) {
          // 真机上第一帧就会回调尺寸；这里同步回调一次，
          // 否则 probeFrameSize 会一直等到 4 秒兜底超时，
          // startTracking 也就永远不跑，测不到 VKSession 的生命周期。
          if (typeof o === 'function') o({ width: 720, height: 1280 })
          return { stop() {} }
        },
        takePhoto(o) { o && o.fail && o.fail({}) }
      }
    },
    createVKSession() {
      state.createdSessions++
      const handlers = {}
      return {
        on(ev, fn) { handlers[ev] = fn },
        start(cb) { if (cb) cb(0) },
        destroy() { state.destroyedSessions++ }
      }
    },
    getStorageSync() { return '' },
    setStorageSync() {},
    removeStorageSync() {},
    getFileSystemManager() {
      return { saveFile(o) { o && o.fail && o.fail({}) }, removeSavedFile(o) { o && o.fail && o.fail({}) } }
    },
    vibrateShort() {}, showToast() {}, hideToast() {},
    canvasToTempFilePath() {}, saveImageToPhotosAlbum(o) { o && o.fail && o.fail({}) },
    nextTick(fn) { if (fn) fn() },
    navigateBack() {}, switchTab() {}, navigateTo() {}
  }

  return { wx, state }
}

/* ---------- 页面加载 ---------- */

function boot(opts) {
  const { wx, state } = buildEnv(opts)
  const abs = path.join(ROOT, 'pages/tryon/tryon.js')
  delete require.cache[require.resolve(abs)]

  const timers = []
  const g = {
    wx,
    Page(o) { g.__page = o },
    getApp() { return { globalData: { shop: { name: '镜界造型' }, cloudReady: false } } },
    getCurrentPages() { return [] },
    Path2D: undefined,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length },
    clearTimeout() {},
    setInterval() { return 0 },
    clearInterval() {}
  }
  g.__page = null

  const saved = {}
  let prev = null
  Object.keys(g).forEach(function (k) {
    saved[k] = global[k]
    if (prev === null) prev = {}
    prev[k] = saved[k]
    global[k] = g[k]
  })
  // 注意：这里**不能**在 require 之后就把全局还原。
  // 页面里的生命周期函数在后续被调用时仍然要能拿到 wx / getApp，
  // 还原太早会在 onShow 里报 "wx is not defined"。
  // 改成「装到下一个 boot 再覆盖」，整个用例期间保持有效。
  boot.__saved = prev
  require(abs)

  const pageObj = g.__page
  const inst = {}
  Object.keys(pageObj).forEach(function (k) { inst[k] = pageObj[k] })
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  inst.setData = function (patch, cb) {
    Object.keys(patch || {}).forEach(function (k) { inst.data[k] = patch[k] })
    if (typeof cb === 'function') cb()
  }
  inst.selectComponent = function () { return null }

  // 手动推进定时器
  inst.__flushTimers = function () {
    while (timers.length) {
      const t = timers.shift()
      t.fn()
    }
  }
  inst.__state = state
  return inst
}

/* ---------- 用例 ---------- */

// 1 从未询问 → 授权 → 开相机
;(function () {
  const p = boot({ auth: undefined })
  p.onLoad({})
  p.onReady()
  p.__flushTimers()
  ok('[1] 未询问时进入 → cameraReady=true', p.data.cameraReady === true, '实际=' + p.data.cameraReady)
  ok('[1] 已创建 VKSession', p.__state.createdSessions === 1, '实际=' + p.__state.createdSessions)
  p.onUnload && p.onUnload()
})()

// 2 用户已拒绝 → 停在引导态
;(function () {
  const p = boot({ auth: false })
  p.onLoad({})
  p.onReady()
  p.__flushTimers()
  ok('[2] 已拒绝时 cameraReady=false', p.data.cameraReady === false)
  ok('[2] 提示文案指向权限', /权限/.test(p.data.cameraMsg), '实际=' + p.data.cameraMsg)
  ok('[2] 不创建 VKSession', p.__state.createdSessions === 0, '实际=' + p.__state.createdSessions)
})()

// 3 使用中被撤销
;(function () {
  const p = boot({ auth: true })
  p.onLoad({})
  p.onReady()
  p.__flushTimers()
  ok('[3] 撤销前 cameraReady=true', p.data.cameraReady === true)
  const before = p.__state.createdSessions

  // 模拟：用户切到设置关掉相机权限，再切回来
  p.__state.auth = false
  p.onHide()
  p.onShow()

  ok('[3] 撤销后 cameraReady=false', p.data.cameraReady === false, '实际=' + p.data.cameraReady)
  ok('[3] 撤销后 faceFound 清零', p.data.faceFound === false)
  ok('[3] 撤销后 VKSession 已销毁', p.vkSession === null, '实际=' + (p.vkSession && 'still alive'))
  ok('[3] 撤销后不再新建 VKSession', p.__state.createdSessions === before, 'before=' + before + ' after=' + p.__state.createdSessions)
  ok('[3] 撤销后提示文案说明原因', /权限/.test(p.data.cameraMsg), '实际=' + p.data.cameraMsg)
})()

// 4 撤销后重新打开 → 自动恢复
;(function () {
  const p = boot({ auth: true })
  p.onLoad({})
  p.onReady()
  p.__flushTimers()

  p.__state.auth = false
  p.onHide()
  p.onShow()
  ok('[4] 先进入撤销态', p.data.cameraReady === false)

  p.__state.auth = true
  p.onShow()
  p.__flushTimers()
  ok('[4] 重新授权后自动 cameraReady=true', p.data.cameraReady === true, '实际=' + p.data.cameraReady)
  ok('[4] 重新授权后重建 VKSession', p.__state.createdSessions >= 2, '实际=' + p.__state.createdSessions)
})()

// 5 getSetting 失败不卡死
;(function () {
  const p = boot({ auth: undefined, getSettingFails: true })
  p.onLoad({})
  p.onReady()
  p.__flushTimers()
  ok('[5] getSetting 失败仍尝试开相机', p.data.cameraReady === true, '实际=' + p.data.cameraReady)

  const p2 = boot({ auth: true, getSettingFails: true })
  p2.onLoad({})
  p2.onReady()
  p2.__flushTimers()
  const ready = p2.data.cameraReady
  p2.onShow()
  ok('[5] onShow 时 getSetting 失败不改变已有状态', p2.data.cameraReady === ready)
})()

// 6 拒绝后点「开启相机」→ 走 openSetting 恢复
;(function () {
  const p = boot({ auth: false })
  p.onLoad({})
  p.onReady()
  p.__flushTimers()
  p.requestCamera()
  ok('[6] 已拒绝时 requestCamera 弹窗引导', p.__state.modalCalls === 1, '实际=' + p.__state.modalCalls)
})()

/* ---------- 输出 ---------- */

console.log('')
console.log('[相机权限生命周期] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  6 个场景：首次授权 / 首次拒绝 / 使用中撤销 / 撤销后恢复 / getSetting 失败 / 手动重试')
}
