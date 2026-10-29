/**
 * App 级兜底钩子
 *
 * 这三个钩子缺了不会报错，只会在出事的时候表现为：
 *   - 用户扫码进了一个不存在的页面 → 微信自带白屏 → 用户直接退出
 *   - 线上 JS 崩了 → 控制台一闪而过，什么线索都没有
 *   - Promise 里抛错 → 静默吞掉，表现为「点了没反应」
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) pass++
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')) }
}

/* ---------- 把 app.js 跑起来 ---------- */
const navLog = []
let appObj = null

const wx = new Proxy({
  getStorageSync() { return '' },
  setStorageSync() {},
  switchTab(o) { navLog.push({ type: 'switchTab', url: o && o.url }); if (o && o.fail) o.fail({}) },
  reLaunch(o) { navLog.push({ type: 'reLaunch', url: o && o.url }) },
  getUpdateManager() { return { onCheckForUpdate() {}, onUpdateReady() {}, onUpdateFailed() {}, applyUpdate() {} } }
}, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} } })

const g = { wx, App(o) { appObj = o } }
Object.keys(g).forEach(function (k) { global[k] = g[k] })

const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
delete require.cache[require.resolve(path.join(ROOT, 'app.js'))]
require(path.join(ROOT, 'app.js'))

ok('[1] app.js 能加载并调用 App()', !!appObj)

/* ---------- 1 三个钩子都存在 ---------- */
ok('[2] 定义了 onPageNotFound', typeof appObj.onPageNotFound === 'function')
ok('[2] 定义了 onError', typeof appObj.onError === 'function')
ok('[2] 定义了 onUnhandledRejection', typeof appObj.onUnhandledRejection === 'function')

/* ---------- 2 onPageNotFound 会回到首页 ---------- */
;(function () {
  appObj.onPageNotFound({ path: 'pages/not-exist/not-exist' })
  const last = navLog[navLog.length - 1]
  ok('[3] 页面不存在时跳回首页', !!last && last.url === '/pages/index/index', JSON.stringify(last))
  ok('[3] switchTab 失败时用 reLaunch 兜底',
    navLog.some(function (n) { return n.type === 'reLaunch' && n.url === '/pages/index/index' }),
    JSON.stringify(navLog))
})()

/* ---------- 3 onError / onUnhandledRejection 不抛异常 ---------- */
;(function () {
  let threw = false
  try {
    appObj.onError('TypeError: x is not a function\n  at pages/tryon/tryon.js:100')
    appObj.onError({ message: 'obj form' })
    appObj.onUnhandledRejection({ reason: 'some rejection' })
    appObj.onUnhandledRejection(undefined)
    appObj.onPageNotFound(undefined)
  } catch (e) { threw = true }
  ok('[4] 兜底钩子本身不抛异常', !threw)
})()

/* ---------- 4 全局分享兜底 ---------- */
;(function () {
  const r = appObj.onShareAppMessage()
  ok('[5] 全局 onShareAppMessage 有标题', !!(r && r.title), JSON.stringify(r))
  ok('[5] 全局转发 path 指向首页', r && r.path === '/pages/index/index', r && r.path)
  ok('[5] 不传空 imageUrl', r && r.imageUrl !== '', JSON.stringify(r.imageUrl))

  const t = appObj.onShareTimeline()
  ok('[5] 全局 onShareTimeline 有标题', !!(t && t.title))
  ok('[5] onShareTimeline 不使用 path', t && !('path' in t), JSON.stringify(t))
})()

/* ---------- 5 onLaunch 里没有会抛异常的同步操作 ---------- */
;(function () {
  let threw = false
  try { appObj.onLaunch() } catch (e) { threw = true }
  ok('[6] onLaunch 不抛异常', !threw)

  // 存储全坏时也不能崩
  global.wx = new Proxy({
    getStorageSync() { throw new Error('storage broken') },
    setStorageSync() { throw new Error('storage broken') }
  }, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} } })
  let threw2 = false
  try { appObj.onLaunch() } catch (e) { threw2 = true }
  ok('[6] 存储全坏时 onLaunch 仍不抛异常', !threw2)
})()

console.log('')
console.log('[App 兜底钩子] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  页面不存在 / 全局错误 / Promise 异常 / 分享兜底 / 存储全坏')
}
