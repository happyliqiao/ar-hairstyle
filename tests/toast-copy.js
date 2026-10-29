/**
 * 坏消息要说清楚下一步（第 49 轮）
 *
 * 这一轮只做一件事：把所有对用户说话的文案拉出来审一遍。
 *
 * 审出两类问题。
 *
 * **一、toast 的显示时长是写死的 1800ms。**
 * 「已收藏」三个字，一眼看完，1.8 秒正好。但
 * 「已保存，清理最早 2 条旧记录」有 14 个字 —— 中文阅读大约每秒
 * 5~8 字，1.8 秒刚读到一半就消失了。用户只看到有东西弹出来，
 * 没看到它说了什么。而这偏偏是唯一告诉他「你的旧记录被删了」的通道。
 *
 * **二、有五条文案只说了「坏了」，没说「那怎么办」。**
 *   「生成图片失败」      → 再按一次快门
 *   「照片读取失败」      → 重新拍一张
 *   「相机不可用」        → 点「开启相机」
 *   「相机还没准备好」    → 正在启动，稍等
 *   「存储空间不足，照片未保存」 → 去记录页删几条
 *
 * 最后一条最严重：它是全站唯一一条「用户有明确解法、但需要记住一句话
 * 再去找入口」的消息。而绝大多数人的第一反应是「手机空间不够」，
 * 跑去清相册，清完再拍还是不行。所以它从 toast 升级成 modal，
 * 按钮直接叫「去记录页」。
 *
 * 这一轮验证：
 *   A. toast 时长随字数变化，且封顶
 *   B. 全站文案的字数上限（超过就该用 modal）
 *   C. 失败类文案必须带动作
 *   D. 存储满用 modal，且只弹一次、去过记录页后重置
 *   E. 静态：showToast 不许再写死时长
 */
const fs = require('fs')
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

const storage = {}
let timers = []
let calls = []

function reset() {
  for (const k in storage) delete storage[k]
  timers = []
  calls = []
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

const wx = new Proxy({
  getStorageSync(k) { return storage[k] === undefined ? '' : storage[k] },
  setStorageSync(k, v) { storage[k] = v },
  removeStorageSync(k) { delete storage[k] },
  getStorageInfoSync() { return { keys: Object.keys(storage) } },
  getWindowInfo() { return { statusBarHeight: 44, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 44, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { platform: 'android', statusBarHeight: 44, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 44, left: 0, right: 390, bottom: 810 } } },
  getMenuButtonBoundingClientRect() { return { top: 48, bottom: 80, height: 32, width: 87, left: 296, right: 383 } },
  getSetting(o) { o && o.success && o.success({ authSetting: { 'scope.camera': true } }) },
  getPrivacySetting(o) { o && o.success && o.success({ needAuthorization: false }) },
  getFileSystemManager() {
    return {
      getFileInfo(o) { o && o.success && o.success({ size: 1024 }) },
      saveFile(o) { o && o.success && o.success({ savedFilePath: 'store://a.jpg' }) },
      removeSavedFile(o) { o && o.success && o.success({}) },
      getSavedFileList(o) { o && o.success && o.success({ fileList: [] }) }
    }
  },
  createOffscreenCanvas(o) { return { width: o && o.width, height: o && o.height, getContext() { return makeCtx() } } },
  createCameraContext() { return { onCameraFrame() { return { stop() {} } }, takePhoto(o) { o && o.success && o.success({ tempImagePath: '/tmp/s.jpg' }) } } },
  createVKSession() { return { on() {}, start(cb) { cb && cb(0) }, destroy() {} } },
  createSelectorQuery() {
    const q = { select() { return q }, selectAll() { return q }, fields() { return q }, boundingClientRect() { return q }, in() { return q }, exec(cb) { cb && cb([null]) } }
    return q
  },
  showToast(o) { calls.push({ api: 'showToast', title: o && o.title }) },
  showModal(o) { calls.push({ api: 'showModal', title: o && o.title, content: o && o.content, confirmText: o && o.confirmText, success: o && o.success }) },
  showLoading() {}, hideLoading() {},
  switchTab(o) { calls.push({ api: 'switchTab', url: o && o.url }); o && o.success && o.success({}) },
  navigateTo(o) { o && o.success && o.success({}) },
  vibrateShort() {}, setKeepScreenOn() {}
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
  setTimeout(fn, delay) { timers.push({ fn: fn, delay: delay }); return timers.length },
  clearTimeout() {},
  setInterval() { return 0 },
  clearInterval() {}
}
g.__page = null
Object.keys(g).forEach(function (k) { global[k] = g[k] })

const swipe = require(path.join(ROOT, 'utils', 'swipe-guard'))

function bootTryon() {
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
  inst.render = function () {}
  inst._stripSwipe = swipe.create()
  inst._colorSwipe = swipe.create()
  inst.data.isDevtools = false
  return inst
}

/** 弹一次 toast，返回它被设定显示多少毫秒 */
function toastMs(inst, msg) {
  timers = []
  inst.showToast(msg)
  const t = timers[timers.length - 1]
  return t ? t.delay : -1
}

/* ================= A. 时长随字数 ================= */

console.log('\n[A] toast 时长随字数变化')

reset()
let t = bootTryon()
ck('A1 3 个字：还是 1800（短消息不用拖）', toastMs(t, '已收藏') === 1800, String(toastMs(t, '已收藏')))
ck('A2 正好 4 个字：还是 1800', toastMs(t, '相机就绪') === 1800, String(toastMs(t, '相机就绪')))
ck('A3 5 个字：1960', toastMs(t, '已取消收藏') === 1960, String(toastMs(t, '已取消收藏')))
// 用真实文案，按字数自己算期望值 —— 这样改文案时测试不会假红
const realMsg = '已保存，清理最早 2 条旧记录'
const realLen = Array.from(realMsg).length
const realExpect = Math.min(4000, 1800 + (realLen - 4) * 160)
ck('A4 真实长文案按字数延长（' + realLen + ' 字 → ' + realExpect + 'ms）',
  toastMs(t, realMsg) === realExpect, String(toastMs(t, realMsg)))
ck('A5 超长文案封顶 4000', toastMs(t, '这是一条特别特别长的提示文案用来测试封顶逻辑是否真的生效了不要再长了') === 4000,
  String(toastMs(t, '这是一条特别特别长的提示文案用来测试封顶逻辑是否真的生效了不要再长了')))
ck('A6 emoji 按码点算（不能按 UTF-16 码元）', toastMs(t, '已收藏😀') === 1800,
  String(toastMs(t, '已收藏😀')))
ck('A7 非字符串不崩', toastMs(t, null) === 1800, String(toastMs(t, null)))

/* ================= B. 字数上限 ================= */

console.log('\n[B] 全站文案字数')

const tryonSrc = fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.js'), 'utf8')
const pageFiles = []
function walk(dir) {
  fs.readdirSync(dir).forEach(function (n) {
    const p = path.join(dir, n)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (/\.js$/.test(n)) pageFiles.push(p)
  })
}
walk(path.join(ROOT, 'pages'))

/** 抓出所有 showToast('...') 和 showToast("...") 的字面量 */
const toastTexts = []
pageFiles.forEach(function (f) {
  const src = fs.readFileSync(f, 'utf8')
  const re = /showToast\(\s*'([^']+)'/g
  let m
  while ((m = re.exec(src))) toastTexts.push({ file: path.relative(ROOT, f), text: m[1] })
})

ck('B1 抓到一批文案', toastTexts.length >= 15, String(toastTexts.length))

// toast 在 4 秒内要读完，中文约 5~8 字/秒 → 上限 32 字。
// 但那是「读得完」的极限，不是「扫一眼就懂」的极限。
// 超过 20 字说明这句话本身就该用 modal 说，不是拉长 toast。
const tooLong = toastTexts.filter(function (o) { return Array.from(o.text).length > 20 })
ck('B2 没有超过 20 字的 toast（超过就该用 modal）', tooLong.length === 0,
  tooLong.map(function (o) { return o.text + '(' + Array.from(o.text).length + ')' }).join(' | '))

/* ================= C. 失败文案必须带动作 ================= */

console.log('\n[C] 失败文案带动作')

// 「坏了」类关键词
const BAD_NEWS = /失败|错误|不可用|超时|满|未保存|不足|没存|不存在|失效/
// 「那怎么办」类关键词
const NEXT_STEP = /重试|再按|重新|去|删|点|稍等|检查|返回|开启|稍后|等待|看看/

// 「已存入记录，相册保存失败」这类不要求动作词：它的职责是**安抚**
// （东西没丢），不是指路。只要开头明确说了「已…」，就算过关。
const PARTIAL_OK = /^已(存入|记录|保存|收藏|删除|清空|清除|复位)/
const badNoStep = toastTexts.filter(function (o) {
  if (PARTIAL_OK.test(o.text)) return false
  return BAD_NEWS.test(o.text) && !NEXT_STEP.test(o.text)
})
ck('C1 所有坏消息都带下一步', badNoStep.length === 0,
  badNoStep.map(function (o) { return o.file + ': ' + o.text }).join(' | '))

// 逐条点名，防止以后改回去
const mustHave = [
  ['生成图片失败', '再按一次快门'],
  ['照片读取失败', '重新拍一张'],
  ['相机不可用', '开启相机'],
  ['相机正在启动', '稍等']
]
mustHave.forEach(function (pair, i) {
  const hit = toastTexts.filter(function (o) {
    return o.text.indexOf(pair[0]) >= 0 && o.text.indexOf(pair[1]) >= 0
  })
  ck('C' + (i + 2) + ' 「' + pair[0] + '」后面跟了「' + pair[1] + '」', hit.length > 0)
})

/* ================= D. 存储满用 modal ================= */

console.log('\n[D] 存储满')

reset()
t = bootTryon()
ck('D1 不再用 toast 说存储满', tryonSrc.indexOf("showToast('存储空间不足") < 0)

reset()
t = bootTryon()
t.showStorageFull()
const modal = calls.filter(function (c) { return c.api === 'showModal' })[0]
ck('D2 第一次弹 modal', !!modal)
ck('D3 标题说结果不说原因', modal && modal.title === '照片没存下来', modal && modal.title)
ck('D4 正文给了具体解法', modal && modal.content.indexOf('试戴记录') >= 0 && modal.content.indexOf('删') >= 0,
  modal && modal.content)
ck('D5 按钮直接叫「去记录页」', modal && modal.confirmText === '去记录页', modal && modal.confirmText)

// 用户点了「去记录页」
reset()
t = bootTryon()
t.showStorageFull()
let m1 = calls.filter(function (c) { return c.api === 'showModal' })[0]
m1.success({ confirm: true })
ck('D6 确认后切到记录页', calls.some(function (c) { return c.api === 'switchTab' && c.url === '/pages/history/history' }),
  JSON.stringify(calls.map(function (c) { return c.api })))
ck('D7 标记位被放开（删完回来还存不下要再弹）', t._storageFullShown === false)

// 用户点了「稍后」
reset()
t = bootTryon()
t.showStorageFull()
m1 = calls.filter(function (c) { return c.api === 'showModal' })[0]
m1.success({ confirm: false })
ck('D8 点稍后不跳页', !calls.some(function (c) { return c.api === 'switchTab' }))
ck('D9 点稍后标记位保持（不要每次拍照都弹）', t._storageFullShown === true)

// 第二次存满
reset()
t = bootTryon()
t._storageFullShown = true
t.showStorageFull()
ck('D10 第二次不再弹 modal', !calls.some(function (c) { return c.api === 'showModal' }))
// 注意：页面里的 showToast 是自己的方法（写 data.toast），
// 不走 wx.showToast。断言要看 data。
ck('D11 但会飘一句 toast 提醒', t.data.toast.indexOf('记录') >= 0, String(t.data.toast))

// 页面已销毁时点确认
reset()
t = bootTryon()
t.showStorageFull()
const m2 = calls.filter(function (c) { return c.api === 'showModal' })[0]
t._alive = false
let threw = false
try { m2.success({ confirm: true }) } catch (e) { threw = true }
ck('D12 页面销毁后点确认不崩', threw === false)
ck('D13 也不会往已销毁的页面跳', !calls.some(function (c) { return c.api === 'switchTab' }))

/* ================= E. 静态 ================= */

console.log('\n[E] 静态')

ck('E1 showToast 的定时器用 toastDuration(msg)',
  /}, toastDuration\(msg\)\)/.test(tryonSrc))
ck('E2 没有写死的 1800 定时器残留',
  !/setData\(\{ toast: '' \}\)[\s\S]{0,120}\}, 1800\)/.test(tryonSrc))
ck('E3 有 toastDuration 函数', /function toastDuration\(msg\)/.test(tryonSrc))
ck('E4 存储满走 showStorageFull', /showStorageFull\(\)/.test(tryonSrc))

console.log('\n----------------------------------------')
console.log('pass ' + pass + ' / fail ' + fail)
if (fail) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
}
process.exit(fail ? 1 : 0)
