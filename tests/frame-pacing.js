/**
 * 帧率节流测试
 *
 * 降级路径（没有离屏画布）单帧要发 4 万多次 canvas 调用。
 * 识脸 anchor 跟着摄像头帧来（30fps），如果不设上限，
 * UI 线程会被绘制彻底占满，表现为「画面在动但点按钮没反应」。
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const HS_PATH = path.join(ROOT, 'utils/hairstyles.js')

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) pass++
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')) }
}

let clock = 2000000
Date.now = function () { return clock }

function boot() {
  const wx = new Proxy({
    getStorageSync() { return '' },
    setStorageSync() {},
    removeStorageSync() {},
    getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, safeArea: { bottom: 810 } } },
    getSystemInfoSync() { return { platform: 'android', statusBarHeight: 24, screenHeight: 844, safeArea: { bottom: 810 } } },
    getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
    getFileSystemManager() { return { saveFile(o) { o && o.fail && o.fail({}) }, removeSavedFile(o) { o && o.fail && o.fail({}) } } },
    createSelectorQuery() {
      const q = { select() { return q }, selectAll() { return q }, fields() { return q }, boundingClientRect() { return q }, in() { return q }, exec(cb) { cb && cb([null]) } }
      return q
    }
  }, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} } })

  const g = {
    wx,
    Page(o) { g.__page = o },
    getApp() { return { globalData: { shop: {}, cloudReady: false } } },
    getCurrentPages() { return [] },
    Path2D: undefined,
    setTimeout() { return 0 },
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
  inst.setData = function (p, cb) { Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] }); cb && cb() }
  inst._alive = true

  // 装一个假 canvas：只统计 clearRect 次数（每次 render 必调一次）
  let clears = 0
  // 任何未显式实现的 canvas 方法都给个 noop，
  // 否则降级路径画到一半会因为缺方法抛错，测不到节流逻辑
  const gradient = { addColorStop() {} }
  inst.ctx = new Proxy({
    clearRect() { clears++ },
    createLinearGradient() { return gradient },
    createRadialGradient() { return gradient },
    measureText() { return { width: 10 } }
  }, {
    get(t, k) {
      if (k in t) return t[k]
      if (typeof k !== 'string') return undefined
      return function () {}
    },
    set() { return true }
  })
  inst.cw = 375
  inst.ch = 667
  inst.__clears = function () { return clears }
  return inst
}

const hs = require(HS_PATH)

/* ---------- 1 降级状态：非 force 渲染被限流到 25fps ---------- */
;(function () {
  hs.isDegraded = function () { return true }
  const p = boot()
  p._lastRenderAt = 0

  const before = p.__clears()
  for (let i = 0; i < 5; i++) {
    p.render()          // 模拟 5 个连续 anchor（同一时刻）
  }
  const after = p.__clears()
  ok('[1] 同一时刻 5 次非 force 渲染只画 1 帧', after - before === 1, '实际画了 ' + (after - before) + ' 帧')

  clock += 40
  p.render()
  ok('[2] 40ms 后允许画下一帧', p.__clears() - before === 2, '实际 ' + (p.__clears() - before))

  clock += 10
  p.render()
  ok('[3] 又只过了 10ms，继续被限流', p.__clears() - before === 2, '实际 ' + (p.__clears() - before))
})()

/* ---------- 4 force 渲染不受限 ---------- */
;(function () {
  hs.isDegraded = function () { return true }
  const p = boot()
  p._lastRenderAt = 0
  const before = p.__clears()
  p.render()
  p.render(true)
  p.render(true)
  ok('[4] force 渲染每次都生效', p.__clears() - before === 3, '实际 ' + (p.__clears() - before))
})()

/* ---------- 5 非降级状态（有离屏画布）完全不限流 ---------- */
;(function () {
  hs.isDegraded = function () { return false }
  const p = boot()
  const before = p.__clears()
  for (let i = 0; i < 5; i++) p.render()
  ok('[5] 烘焙可用时不限流（drawImage 很便宜）', p.__clears() - before === 5, '实际 ' + (p.__clears() - before))
})()

/* ---------- 6 限流不影响状态更新 ---------- */
;(function () {
  hs.isDegraded = function () { return true }
  const p = boot()
  p._lastRenderAt = 0
  p.render()
  clock += 5
  p.render()   // 被跳过
  ok('[6] 被跳过的是绘制，不是状态', p._lastRenderAt !== 0)
})()

console.log('')
console.log('[帧率节流] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  降级路径限 25fps · force 不受限 · 烘焙可用时不限流')
}
