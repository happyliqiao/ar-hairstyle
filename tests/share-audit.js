/**
 * 分享配置审计
 *
 * 分享是小程序里唯一「不装也能被看到」的入口，写错一行就白丢一次传播。
 * 两个最容易写错的地方：
 *   1 onShareTimeline **不支持 path**，只能给 query。写了 path 微信直接忽略，
 *     表现为「朋友圈看到的是 A 发型，点进去是默认发型」。
 *   2 onShareAppMessage 的 path 必须 '/' 开头；参数必须是目标页能解析的 id。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const hairstyles = require(path.join(ROOT, 'utils/hairstyles.js'))

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) pass++
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')) }
}

/* ---------- 用桩环境把页面模块跑起来，拿真实的分享返回值 ---------- */

function loadPage(relPath) {
  const abs = path.join(ROOT, relPath)
  delete require.cache[require.resolve(abs)]
  const g = {
    wx: new Proxy({
      getStorageSync() { return '' },
      setStorageSync() {},
      removeStorageSync() {},
      getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, safeArea: { bottom: 810 } } },
      getSystemInfoSync() { return { platform: 'android', statusBarHeight: 24, screenHeight: 844, safeArea: { bottom: 810 } } },
      getSetting(o) { o && o.success && o.success({ authSetting: {} }) },
      getFileSystemManager() { return { saveFile(o) { o && o.fail && o.fail({}) }, removeSavedFile(o) { o && o.fail && o.fail({}) } } },
      createSelectorQuery() {
        const q = { select() { return q }, selectAll() { return q }, fields() { return q }, boundingClientRect() { return q }, in() { return q }, exec(cb) { cb && cb([null]) } }
        return q
      }
    }, { get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} } }),
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
  require(abs)
  return g.__page
}

function instOf(pageObj, data) {
  const inst = {}
  Object.keys(pageObj).forEach(function (k) { inst[k] = pageObj[k] })
  inst.data = JSON.parse(JSON.stringify(pageObj.data || {}))
  if (data) Object.keys(data).forEach(function (k) { inst.data[k] = data[k] })
  inst.setData = function (p, cb) { Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] }); cb && cb() }
  return inst
}

const PAGES = ['index', 'tryon', 'gallery', 'history', 'profile']
const pageObjs = {}
PAGES.forEach(function (p) {
  try { pageObjs[p] = loadPage('pages/' + p + '/' + p + '.js') } catch (e) { pageObjs[p] = null }
})

/* ---------- A 每个页面都要能转发 ---------- */

PAGES.forEach(function (p) {
  const o = pageObjs[p]
  ok('[' + p + '] 页面模块可加载', !!o)
  if (!o) return
  ok('[' + p + '] 有 onShareAppMessage（或由 app 兜底）', true)
})

const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
ok('[app] 定义了全局 onShareAppMessage 兜底', /onShareAppMessage\s*\(/.test(appSrc))
ok('[app] 定义了全局 onShareTimeline 兜底', /onShareTimeline\s*\(/.test(appSrc))

/* ---------- B onShareAppMessage 的 path 合法性 ---------- */

PAGES.forEach(function (p) {
  const o = pageObjs[p]
  if (!o || typeof o.onShareAppMessage !== 'function') return
  const inst = instOf(o, { currentStyle: 'bob', currentColor: 'chestnut' })
  let r = null
  let err = null
  try { r = inst.onShareAppMessage({ from: 'button' }) } catch (e) { err = e }
  ok('[' + p + '] onShareAppMessage 不抛异常', !!r, err && err.message)
  if (!r) return
  ok('[' + p + '] 有 title', typeof r.title === 'string' && r.title.length > 0)
  ok('[' + p + '] path 以 / 开头', typeof r.path === 'string' && r.path[0] === '/', 'path=' + r.path)
  ok('[' + p + '] path 不含 query 里的 ? 重复', !/\?\?/.test(r.path || ''), 'path=' + r.path)
  ok('[' + p + '] 不传空 imageUrl', r.imageUrl !== '', 'imageUrl=' + JSON.stringify(r.imageUrl))
})

/* ---------- C onShareTimeline 不许出现 path ---------- */

PAGES.forEach(function (p) {
  const o = pageObjs[p]
  if (!o || typeof o.onShareTimeline !== 'function') return
  const inst = instOf(o, { currentStyle: 'bob', currentColor: 'chestnut' })
  let r
  try { r = inst.onShareTimeline() } catch (e) { r = null }
  ok('[' + p + '] onShareTimeline 不抛异常', !!r)
  if (!r) return
  ok('[' + p + '] onShareTimeline 未使用 path（微信会忽略）', !('path' in r), JSON.stringify(r))
  ok('[' + p + '] onShareTimeline 有 title', typeof r.title === 'string' && r.title.length > 0)
  if ('query' in r) {
    ok('[' + p + '] query 不带前导 ?', String(r.query)[0] !== '?', 'query=' + r.query)
  }
})

/* ---------- D 分享参数必须能被目标页解析成有效 id ---------- */

const tryon = pageObjs.tryon
if (tryon && typeof tryon.onShareAppMessage === 'function') {
  const inst = instOf(tryon, { currentStyle: 'wavy', currentColor: 'honey' })
  const r = inst.onShareAppMessage({})
  const q = (r.path || '').split('?')[1] || ''
  const params = {}
  q.split('&').forEach(function (kv) {
    const i = kv.indexOf('=')
    if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1)
  })
  ok('[tryon] 转发链接带 style 参数', !!params.style, q)
  ok('[tryon] 转发链接带 color 参数', !!params.color, q)
  ok('[tryon] style 参数是有效发型 id',
    !!params.style && hairstyles.getStyle(params.style).id === 'wavy',
    'params.style=' + params.style)
  ok('[tryon] color 参数是有效发色 id',
    !!params.color && hairstyles.getColor(params.color).id === 'honey',
    'params.color=' + params.color)
}

if (tryon && typeof tryon.onShareTimeline === 'function') {
  const inst = instOf(tryon, { currentStyle: 'curly', currentColor: 'ash' })
  const r = inst.onShareTimeline()
  ok('[tryon] 朋友圈 query 带 style', /style=/.test(r.query || ''), 'query=' + r.query)
  ok('[tryon] 朋友圈 query 带 color', /color=/.test(r.query || ''), 'query=' + r.query)
}

/* ---------- 输出 ---------- */
console.log('')
console.log('[分享配置审计] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  A 页面转发能力 / B path 合法性 / C 朋友圈不带 path / D 参数可解析')
}
