/**
 * 版本更新提示（第 33 轮）
 *
 * 小程序的更新机制有个很容易被忽略的点：冷启动时在后台下载新版本，
 * **新版本要等下一次冷启动才生效**。用户当天一直在用旧版 ——
 * 店主上午把营业时间从「10:00-22:00」改成「09:30-21:00」，
 * 店员下午扫码进来看到的还是旧时间，回头一句「我明明改过了」。
 * 对店里这种「改一次就要马上全员生效」的场景，不提示等于没更新。
 *
 * 但提示的时机同样要命：用户正举着手机对准脸调发型时弹模态框，
 * 他顺手点「立即重启」，页面重开回首页，调好的东西全丢。
 *
 * 这一轮验证：
 *   A. 低版本基础库 / 拿不到管理器时不炸
 *   B. 在试戴页时不弹、挂起；离开后再问
 *   C. 确认才重启，选「稍后」不会反复骚扰
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

const state = {
  modalCount: 0,
  lastModal: null,
  applyCount: 0,
  hasManager: true,
  throwOnManager: false,
  modalResult: { confirm: true }
}

function makeManager() {
  const m = {
    _ready: null,
    _check: null,
    _failed: null,
    onCheckForUpdate(fn) { m._check = fn },
    onUpdateReady(fn) { m._ready = fn },
    onUpdateFailed(fn) { m._failed = fn },
    applyUpdate() { state.applyCount++ }
  }
  return m
}

let manager = makeManager()

const wx = new Proxy({
  getStorageSync() { return '' },
  setStorageSync() {},
  removeStorageSync() {},
  getUpdateManager() {
    if (state.throwOnManager) throw new Error('not supported')
    if (!state.hasManager) return undefined
    return manager
  },
  showModal(o) {
    state.modalCount++
    state.lastModal = o
    o && o.success && o.success(state.modalResult)
  },
  switchTab() {},
  reLaunch() {}
}, {
  get(t, k) {
    if (k in t) return t[k]
    if (typeof k !== 'string') return undefined
    if (k === 'then') return undefined
    return function () {}
  }
})

global.wx = wx

const pagesStack = []
const g = {
  wx: wx,
  App(o) { g.__app = o },
  Page(o) { g.__page = o },
  getApp() { return g.__app || {} },
  getCurrentPages() { return pagesStack },
  setTimeout(fn) { return 0 },
  clearTimeout() {},
  setInterval() { return 0 },
  clearInterval() {}
}
g.__app = null
g.__page = null
Object.keys(g).forEach(function (k) { global[k] = g[k] })

function bootApp() {
  delete require.cache[require.resolve(path.join(ROOT, 'app.js'))]
  require(path.join(ROOT, 'app.js'))
  return g.__app
}

/* ================= A. 兼容性 ================= */

console.log('\n[A] 拿不到更新管理器时不炸')

state.throwOnManager = true
let a1 = null
let a1Threw = false
try { a1 = bootApp(); a1.onLaunch() } catch (e) { a1Threw = true }
ck('A1 getUpdateManager 抛异常时 onLaunch 不炸', a1Threw === false)

state.throwOnManager = false
state.hasManager = false
let a2Threw = false
try { const a2 = bootApp(); a2.onLaunch() } catch (e) { a2Threw = true }
ck('A2 返回 undefined 时 onLaunch 不炸', a2Threw === false)

state.hasManager = true

/* ================= B. 弹窗时机 ================= */

console.log('\n[B] 试戴页挂起，离开后再问')

const app = bootApp()
app.onLaunch()
ck('B1 onLaunch 里挂了更新检查', !!manager._ready)

// 场景 1：用户正在试戴页
pagesStack.length = 0
pagesStack.push({ route: 'pages/tryon/tryon' })
state.modalCount = 0
manager._ready()
ck('B2 试戴页时不弹窗（重启会丢调好的发型）', state.modalCount === 0, 'modals=' + state.modalCount)
ck('B3 但挂起了提示', app._pendingUpdate === true)

// 场景 2：用户在试戴页里又收到一次 ready（不该重复挂）
manager._ready()
ck('B4 重复 ready 不重复挂起', app._pendingUpdate === true && state.modalCount === 0)

// 场景 3：离开试戴页时 flush
pagesStack.length = 0
pagesStack.push({ route: 'pages/history/history' })
app.flushUpdate()
ck('B5 离开试戴页后补上提示', state.modalCount === 1, 'modals=' + state.modalCount)

/* ================= C. 确认 / 稍后 ================= */

console.log('\n[C] 确认才重启')

ck('C1 点「立即重启」调用 applyUpdate', state.applyCount === 1, 'apply=' + state.applyCount)
ck('C2 弹窗文案说明了会回首页', state.lastModal && state.lastModal.content.indexOf('首页') >= 0,
  state.lastModal && state.lastModal.content)

// 用户选「稍后」的场景。
// 注意：上面 applyUpdate 之后进程会重启，所以这里重新起一个 App 实例 ——
// 在同一个实例上继续测会带着 _updating=true 的状态，那是测试假象。
const app2 = bootApp()
app2.onLaunch()
pagesStack.length = 0
pagesStack.push({ route: 'pages/index/index' })
state.modalResult = { confirm: false }
state.modalCount = 0
manager._ready()
ck('C3 非试戴页立即弹窗', state.modalCount === 1, 'modals=' + state.modalCount)
ck('C4 选「稍后」不重启', state.applyCount === 1, 'apply=' + state.applyCount)
ck('C5 选「稍后」后 _updating 放开（下次还能再问）', app2._updating === false)

// 再 ready 一次应该还能弹
state.modalResult = { confirm: true }
state.modalCount = 0
manager._ready()
ck('C6 之后再来 ready 仍会提示', state.modalCount === 1, 'modals=' + state.modalCount)

/* ================= D. 下载失败 ================= */

console.log('\n[D] 下载失败不影响使用')

let dThrew = false
try { manager._failed && manager._failed({ errMsg: 'download fail' }) } catch (e) { dThrew = true }
ck('D1 onUpdateFailed 不抛异常', dThrew === false)

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '版本更新：全部通过' : '版本更新：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
