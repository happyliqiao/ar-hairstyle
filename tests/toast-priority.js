/**
 * toast 优先级 + 相册权限恢复测试
 *
 * 起因：拍照保存是两条并行链路，各自弹 toast，后弹的盖掉先弹的。
 * 「存储空间不足，照片未保存」被一句「已保存到相册」盖掉之后，
 * 用户以为一切正常，回头在记录页看到灰色「无照片」才发现丢了。
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

/* ---------- 假时钟 ---------- */
let clock = 1000000
const realNow = Date.now
Date.now = function () { return clock }

/* ---------- 环境 ---------- */
function boot(opts) {
  opts = opts || {}
  const state = { modalCalls: 0, modalContents: [], openSettingCalls: 0, albumResult: opts.albumResult || 'ok' }

  const wx = new Proxy({
    getStorageSync() { return '' },
    setStorageSync() {},
    removeStorageSync() {},
    getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, safeArea: { bottom: 810 } } },
    getSystemInfoSync() { return { platform: 'android', statusBarHeight: 24, screenHeight: 844, safeArea: { bottom: 810 } } },
    getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
    getFileSystemManager() {
      return {
        saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://mock.jpg' }) },
        removeSavedFile(o) { o && o.fail && o.fail({}) }
      }
    },
    saveImageToPhotosAlbum(o) {
      if (state.albumResult === 'ok') { o && o.success && o.success({}) }
      else { o && o.fail && o.fail({ errMsg: state.albumResult }) }
    },
    showModal(o) {
      state.modalCalls++
      state.modalContents.push(o && o.content)
      o && o.success && o.success({ confirm: !!opts.modalConfirm, cancel: !opts.modalConfirm })
    },
    openSetting(o) {
      state.openSettingCalls++
      o && o.success && o.success({ authSetting: opts.openSettingGrants ? { 'scope.writePhotosAlbum': true } : {} })
    },
    createSelectorQuery() {
      const q = { select() { return q }, selectAll() { return q }, fields() { return q }, boundingClientRect() { return q }, in() { return q }, exec(cb) { cb && cb([null]) } }
      return q
    },
    createCameraContext() { return { onCameraFrame(o) { if (typeof o === 'function') o({ width: 720, height: 1280 }); return { stop() {} } } } },
    createVKSession() { return { on() {}, start(cb) { cb && cb(0) }, destroy() {} } },
    canvasToTempFilePath() {}
  }, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} } })

  const g = {
    wx,
    Page(o) { g.__page = o },
    getApp() { return { globalData: { shop: { name: '镜界造型' }, cloudReady: false } } },
    getCurrentPages() { return [] },
    Path2D: undefined,
    setTimeout() { return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
    clearInterval() {}
  }
  g.__page = null
  Object.keys(g).forEach(function (k) { global[k] = g[k] })

  const abs = path.join(ROOT, 'pages/tryon/tryon.js')
  delete require.cache[require.resolve(abs)]
  require(abs)

  const pageObj = g.__page
  const inst = {}
  Object.keys(pageObj).forEach(function (k) { inst[k] = pageObj[k] })
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  inst.setData = function (p, cb) { Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] }); cb && cb() }
  inst._alive = true
  inst.__state = state
  return inst
}

/* ---------- 1 toast 优先级 ---------- */

;(function () {
  const p = boot()
  p.showToast('已存入试戴记录')            // info
  ok('[1] info 正常显示', p.data.toast === '已存入试戴记录', p.data.toast)

  clock += 100
  p.showToast('存储空间不足，照片未保存', 'warn')
  ok('[1] warn 可以覆盖 info', p.data.toast === '存储空间不足，照片未保存', p.data.toast)
})()

;(function () {
  const p = boot()
  p.showToast('存储空间不足，照片未保存', 'warn')
  clock += 100
  p.showToast('已保存到相册')              // info，1.2s 内
  ok('[2] warn 在 1.2s 内不被 info 覆盖', p.data.toast === '存储空间不足，照片未保存', p.data.toast)
})()

;(function () {
  const p = boot()
  p.showToast('存储空间不足，照片未保存', 'warn')
  clock += 1300
  p.showToast('已保存到相册')
  ok('[3] 1.2s 后 info 可以正常显示', p.data.toast === '已保存到相册', p.data.toast)
})()

;(function () {
  const p = boot()
  p.showToast('已存入试戴记录')
  clock += 100
  p.showToast('已保存到相册')
  ok('[4] info 之间可以互相覆盖', p.data.toast === '已保存到相册', p.data.toast)
})()

/* ---------- 5 相册授权失败：首次引导一次 ---------- */

;(function () {
  const p = boot({ albumResult: 'saveImageToPhotosAlbum:fail auth deny' })
  p.afterCompose('/tmp/mock.jpg')
  ok('[5] 授权失败弹一次引导', p.__state.modalCalls === 1, '实际=' + p.__state.modalCalls)
  ok('[5] 引导文案提到权限', /权限/.test(p.__state.modalContents[0] || ''), p.__state.modalContents[0])
  ok('[5] toast 用 warn 级别', /未授权/.test(p.data.toast), p.data.toast)

  clock += 2000
  p.afterCompose('/tmp/mock2.jpg')
  ok('[5] 第二次不再重复弹窗', p.__state.modalCalls === 1, '实际=' + p.__state.modalCalls)
})()

/* ---------- 6 非权限失败不弹窗 ---------- */

;(function () {
  const p = boot({ albumResult: 'saveImageToPhotosAlbum:fail system error' })
  p.afterCompose('/tmp/mock.jpg')
  ok('[6] 非权限失败不弹设置引导', p.__state.modalCalls === 0, '实际=' + p.__state.modalCalls)
  ok('[6] 提示说明是保存失败', /保存失败/.test(p.data.toast), p.data.toast)
})()

/* ---------- 7 用户拒绝引导后，下次仍会再提示一次（因为没开成） ---------- */

;(function () {
  const p = boot({ albumResult: 'saveImageToPhotosAlbum:fail auth deny', modalConfirm: false })
  p.afterCompose('/tmp/a.jpg')
  ok('[7] 首次弹引导', p.__state.modalCalls === 1)
  clock += 2000
  p.afterCompose('/tmp/b.jpg')
  ok('[7] 拒绝后不重复弹（同一次会话内）', p.__state.modalCalls === 1, '实际=' + p.__state.modalCalls)
})()

/* ---------- 8 成功路径不弹窗、提示成功 ---------- */

;(function () {
  const p = boot({ albumResult: 'ok' })
  p.afterCompose('/tmp/mock.jpg')
  ok('[8] 成功时不弹设置引导', p.__state.modalCalls === 0)
})()

Date.now = realNow

console.log('')
console.log('[toast 优先级 + 相册权限] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  8 组场景：info/warn 覆盖规则 · 首次引导 · 不重复弹窗 · 非权限失败')
}
