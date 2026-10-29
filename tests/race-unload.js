/**
 * 异步回调 vs 页面销毁 的竞态测试
 *
 * 用户按完快门立刻返回，是最常见的一次「异步还没回来，页面已经没了」。
 * 微信不会替你收拾后果：
 *   - setData 到已销毁页面 → 控制台 warning，真机上偶尔会「闪一下」
 *   - showLoading 在已销毁页面上弹 → 没人收，用户回到首页还看到转圈
 *   - VKSession 还活着 → 相机继续发热、再次进入黑屏
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

function boot() {
  const state = {
    showLoading: 0,
    hideLoading: 0,
    takePhotoCb: null,
    addRecordCb: null,
    setDataAfterUnload: 0
  }

  const wx = new Proxy({
    getStorageSync() { return '' },
    setStorageSync() {},
    removeStorageSync() {},
    getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, safeArea: { bottom: 810 } } },
    getSystemInfoSync() { return { platform: 'android', statusBarHeight: 24, screenHeight: 844, safeArea: { bottom: 810 } } },
    getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
    getFileSystemManager() {
      return { saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://a.jpg' }) }, removeSavedFile(o) { o && o.fail && o.fail({}) } }
    },
    showLoading() { state.showLoading++ },
    hideLoading() { state.hideLoading++ },
    createCameraContext() {
      return {
        onCameraFrame(o) { if (typeof o === 'function') o({ width: 720, height: 1280 }); return { stop() {} } },
        takePhoto(o) { state.takePhotoCb = o }
      }
    },
    createVKSession() {
      return { on() {}, start(cb) { cb && cb(0) }, destroy() {} }
    },
    createSelectorQuery() {
      const q = { select() { return q }, selectAll() { return q }, fields() { return q }, boundingClientRect() { return q }, in() { return q }, exec(cb) { cb && cb([null]) } }
      return q
    },
    canvasToTempFilePath() {},
    showModal() {},
    openSetting() {},
    saveImageToPhotosAlbum(o) { o && o.success && o.success({}) }
  }, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} } })

  const g = {
    wx,
    Page(o) { g.__page = o },
    getApp() { return { globalData: { shop: {}, cloudReady: false } } },
    getCurrentPages() { return [] },
    Path2D: undefined,
    setTimeout(fn) { return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
    clearInterval() {}
  }
  g.__page = null
  Object.keys(g).forEach(function (k) { global[k] = g[k] })

  delete require.cache[require.resolve(path.join(ROOT, 'pages/tryon/tryon.js'))]
  require(path.join(ROOT, 'pages/tryon/tryon.js'))

  const pageObj = g.__page
  const inst = {}
  Object.keys(pageObj).forEach(function (k) { inst[k] = pageObj[k] })
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  inst.setData = function (p, cb) {
    if (inst.__unloaded) state.setDataAfterUnload++
    Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] })
    cb && cb()
  }
  inst._alive = true
  inst.data.cameraReady = true
  inst.cw = 375
  inst.ch = 667
  inst.ctx = new Proxy({ clearRect() {} }, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; return function () {} } })
  inst.__state = state
  return inst
}

/* ---------- 1 卸载后 takePhoto 回调进来 ---------- */
;(function () {
  const p = boot()
  // 快门现在有前置条件：必须已经有一个可信的发型位置，
  // 否则拍出来的是一张没有发型的原图（见 capture 里的空框拦截）。
  // 这里给一个「手动定位」状态，模拟用户真的按得下快门的那一刻。
  p.data.manualOn = true
  p.capture()
  const cb = p.__state.takePhotoCb
  ok('[1] capture 触发了 takePhoto', !!cb)

  // 用户返回退出
  p.onUnload()
  p.__unloaded = true

  const before = p.__state.showLoading
  if (cb && cb.success) cb.success({ tempImagePath: '/tmp/x.jpg' })
  ok('[1] 卸载后不再 showLoading（否则转圈会留在下一页）',
    p.__state.showLoading === before,
    'showLoading 次数 ' + before + ' -> ' + p.__state.showLoading)
  ok('[1] 卸载后没有 setData', p.__state.setDataAfterUnload === 0, '实际 ' + p.__state.setDataAfterUnload)
})()

/* ---------- 2 卸载后 persist 回调进来 ---------- */
;(function () {
  const p = boot()
  const store = require(path.join(ROOT, 'utils/store.js'))
  const origAdd = store.addRecord
  let captured = null
  store.addRecord = function (rec, cb) { captured = cb }

  p.afterCompose('/tmp/x.jpg')
  ok('[2] addRecord 被调用', !!captured)

  p.onUnload()
  p.__unloaded = true

  if (captured) captured({ id: 'r1', photoPath: 'store://a.jpg' }, { ok: true, photoSaved: true, evicted: 0 })
  ok('[2] 卸载后 persist 回调不再 setData', p.__state.setDataAfterUnload === 0, '实际 ' + p.__state.setDataAfterUnload)

  store.addRecord = origAdd
})()

/* ---------- 3 卸载后 anchor 回调进来 ---------- */
;(function () {
  const p = boot()
  p.onReady && p.onReady()
  p.onUnload()
  p.__unloaded = true

  let threw = false
  try {
    p.onFaceAnchor({ origin: { x: 100, y: 100 }, size: { width: 150, height: 190 }, angle: 0 })
  } catch (e) { threw = true }
  ok('[3] 卸载后 anchor 回调不抛异常', !threw)
})()

/* ---------- 4 卸载后 render 不碰 canvas ---------- */
;(function () {
  const p = boot()
  let cleared = 0
  const grad = { addColorStop() {} }
  p.ctx = new Proxy({
    clearRect() { cleared++ },
    createLinearGradient() { return grad },
    createRadialGradient() { return grad },
    measureText() { return { width: 10 } }
  }, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; return function () {} } })
  p.onUnload()
  p.render(true)
  ok('[4] 卸载后 render 不再绘制', cleared === 0, '实际清屏 ' + cleared + ' 次')
})()

/* ---------- 5 onUnload 释放 VKSession ---------- */
;(function () {
  const p = boot()
  // 直接走 startTracking，绕开 openCamera 的 500ms 定时器
  // （测试里的 setTimeout 是桩，不会自己触发）
  p.frameSize = { w: 720, h: 1280 }
  p.startTracking()
  ok('[5] 进入时建立了 VKSession', !!p.vkSession)
  p.onUnload()
  ok('[5] onUnload 后 VKSession 已释放', p.vkSession === null, '实际=' + (p.vkSession && 'still alive'))
})()

console.log('')
console.log('[异步回调 vs 页面销毁] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  5 组场景：拍照回调 / 落盘回调 / anchor 回调 / render / VKSession 释放')
}
