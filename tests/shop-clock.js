/**
 * 营业状态的时间跟随（第 38 轮）
 *
 * 首页原来**一个生命周期钩子都没有** —— 营业状态只在 onLoad 里算一次。
 *
 * 这个 bug 的触发场景不是「用户操作」，而是「小程序一直开着」：
 * 二维码印在店门口的立牌上，店员早上十点把小程序开在柜台平板上，
 * 顾客傍晚六点扫码进来。到 22:00 打烊之后，首页仍然写着
 * 「营业中 · 22:00 打烊」，顾客推门进来发现已经关门。
 *
 * 对店门口那个二维码来说，这是这个页面上代价最高的一种错误 ——
 * 它不会报错、不会崩溃，只是安静地说着错话。
 *
 * 这一轮验证：
 *   A. 回到首页会重算
 *   B. 停在首页时状态会自己跟着时间变
 *   C. 离开页面时定时器一定要清掉（否则后台还在跑）
 *   D. 状态没变时不做多余的 setData
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

/* ---------------- 可控时钟 ---------------- */

let fakeNow = 0
const RealDate = Date
// shop-hours 里用的是 `new Date()`，不是 `Date.now()`。
// 只改 Date.now 的话状态永远停在真实时间上，测了个寂寞。
// 这里把整个 Date 构造器包一层：无参构造返回假时间，其余透传。
global.Date = new Proxy(RealDate, {
  construct(t, args) {
    return args.length ? new t(args[0], args[1], args[2], args[3], args[4], args[5], args[6]) : new t(fakeNow)
  },
  get(t, k) {
    if (k === 'now') return function () { return fakeNow }
    return t[k]
  }
})

function at(h, m) {
  // 以本地时区的某天某点构造时间戳
  const d = new Date(2026, 4, 20, h, m, 0, 0)
  return d.getTime()
}

/* ---------------- 可控 setInterval ---------------- */

const intervals = []
let intervalSeq = 1

function fakeSetInterval(fn, ms) {
  const id = intervalSeq++
  intervals.push({ id: id, fn: fn, ms: ms })
  return id
}
function fakeClearInterval(id) {
  for (let i = 0; i < intervals.length; i++) {
    if (intervals[i].id === id) { intervals.splice(i, 1); return }
  }
}
function tick() {
  intervals.slice().forEach(function (t) { t.fn() })
}

/* ---------------- wx 桩 ---------------- */

const wx = new Proxy({
  getStorageSync() { return '' },
  setStorageSync() {},
  removeStorageSync() {},
  getWindowInfo() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getSystemInfoSync() { return { statusBarHeight: 24, screenHeight: 844, windowWidth: 390, windowHeight: 700, pixelRatio: 3, safeArea: { top: 24, left: 0, right: 390, bottom: 810 } } },
  getMenuButtonBoundingClientRect() { return { top: 28, bottom: 60, height: 32, width: 87, left: 296, right: 383 } },
  navigateTo() {},
  switchTab() {}
}, {
  get(t, k) { if (k in t) return t[k]; if (typeof k !== 'string') return undefined; if (k === 'then') return undefined; return function () {} }
})

global.wx = wx

const g = {
  wx: wx,
  Page(o) { g.__page = o },
  getApp() {
    return { globalData: { shop: { name: '镜界造型', hours: '10:00 - 22:00' }, cloudReady: false } }
  },
  getCurrentPages() { return [] },
  setTimeout(fn) { return 0 },
  clearTimeout() {},
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval
}
g.__page = null
Object.keys(g).forEach(function (k) { global[k] = g[k] })

function loadIndex() {
  const abs = path.join(ROOT, 'pages/index/index.js')
  delete require.cache[require.resolve(abs)]
  require(abs)
  const po = g.__page
  const inst = {}
  Object.keys(po).forEach(function (k) { inst[k] = po[k] })
  inst.data = JSON.parse(JSON.stringify(po.data || {}))
  inst._setDataCount = 0
  inst.setData = function (p, cb) {
    inst._setDataCount++
    Object.keys(p || {}).forEach(function (k) { inst.data[k] = p[k] })
    cb && cb()
  }
  return inst
}

/* ================= A. 进入与重算 ================= */

console.log('\n[A] 回到首页会重算')

fakeNow = at(14, 0)   // 营业中
const page = loadIndex()
page.onLoad({})
ck('A1 onLoad 后显示营业中', page.data.shopOpen && page.data.shopOpen.open === true,
  JSON.stringify(page.data.shopOpen))

// 用户在试戴页待了 9 个小时（店员把平板摆在台面上，没人管）
fakeNow = at(23, 10)  // 已打烊
intervals.length = 0
page.onShow()
ck('A2 onShow 后立刻变成已打烊', page.data.shopOpen && page.data.shopOpen.open === false,
  JSON.stringify(page.data.shopOpen))
ck('A3 onShow 启动了时钟', intervals.length === 1, 'n=' + intervals.length)

/* ================= B. 停在首页也会自己变 ================= */

console.log('\n[B] 停在首页时状态自己跟随时间')

// 从「已打烊」回到「营业中」：第二天开门
fakeNow = at(10, 30)
page._setDataCount = 0
tick()
ck('B1 时钟触发后状态翻成营业中', page.data.shopOpen && page.data.shopOpen.open === true,
  JSON.stringify(page.data.shopOpen))
ck('B2 状态变了会 setData', page._setDataCount === 1, 'count=' + page._setDataCount)

// 时间没跨过任何边界，再 tick 一次不该刷视图
fakeNow = at(10, 31)
page._setDataCount = 0
tick()
ck('B3 状态没变时不做多余 setData', page._setDataCount === 0, 'count=' + page._setDataCount)

// 打烊时刻
fakeNow = at(22, 0)
tick()
ck('B4 到点打烊（22:00 整点算已打烊）', page.data.shopOpen && page.data.shopOpen.open === false,
  JSON.stringify(page.data.shopOpen))

// 打烊提示文案也要跟着变
fakeNow = at(22, 5)
tick()
ck('B5 hint 说明下次开门时间', page.data.shopOpen && /开门/.test(page.data.shopOpen.hint || ''),
  page.data.shopOpen && page.data.shopOpen.hint)

/* ================= C. 定时器清理 ================= */

console.log('\n[C] 离开页面要清掉时钟')

intervals.length = 0
page.onShow()
ck('C1 onShow 后有一个时钟', intervals.length === 1)
page.onHide()
ck('C2 onHide 清掉时钟（否则后台一直跑）', intervals.length === 0, 'n=' + intervals.length)

intervals.length = 0
page.onShow()
page.onUnload()
ck('C3 onUnload 清掉时钟', intervals.length === 0, 'n=' + intervals.length)

// 反复 onShow 不该堆积多个定时器
intervals.length = 0
page.onShow()
page.onShow()
page.onShow()
ck('C4 反复 onShow 不会堆出多个定时器', intervals.length === 1, 'n=' + intervals.length)
page.onHide()

/* ================= D. 异常数据 ================= */

console.log('\n[D] 营业时间缺失/写坏时不炸')

// 注意改的是 global.getApp，不是 g.getApp ——
// 全局桩只在文件开头拷贝了一次，之后改 g 上的属性不会同步过去
const origGetApp = global.getApp
global.getApp = function () { return { globalData: { shop: {} }, cloudReady: false } }
const p2 = loadIndex()
let dThrew = false
try { p2.onLoad({}); p2.onShow() } catch (e) { dThrew = true }
ck('D1 shop.hours 缺失时不抛异常', dThrew === false)
ck('D2 状态为 null（界面显示「状态未知」）', p2.data.shopOpen === null, JSON.stringify(p2.data.shopOpen))

global.getApp = function () { throw new Error('no app') }
const p3 = loadIndex()
let d2Threw = false
try { p3.onLoad({}); p3.onShow() } catch (e) { d2Threw = true }
ck('D3 getApp 抛异常时不炸', d2Threw === false)
global.getApp = origGetApp

/* ================= 汇总 ================= */

global.Date = RealDate

console.log('\n' + (fail === 0 ? '营业状态时钟：全部通过' : '营业状态时钟：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
