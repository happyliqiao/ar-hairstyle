/**
 * 页面跳转守卫（第 43 轮）
 *
 * 前 42 轮都在看「页面里的东西」，这一轮看「页面之间」。
 *
 * 首页那个「开始试戴」按钮下面就是相机。相机在真机上要 300~800ms 才出画面，
 * 用户点一下没反应，很自然会再点一下 —— 于是 navigateTo 被调两次，
 * 栈里同时存在两个 tryon 页，两个 camera 实例。
 *
 * 微信的 camera 是**独占**的：第二个拿不到摄像头，用户看到的是黑屏；
 * 按返回也不是回到首页，而是退到另一个黑屏的 tryon 页。
 * 这就是「点了两下，小程序坏了」的完整链路。
 *
 * 这一轮验证：
 *   A. 400ms 内的第二次跳转被挡掉
 *   B. 超过 400ms 后可以正常再跳
 *   C. 栈满（page limit exceeded）时降级成 redirectTo，而不是静默失败
 *   D. 其他失败要给出提示，不能让用户以为卡死
 *   E. navigateTo 直接抛异常时不能把页面带崩
 *   F. tab 切换同样防抖
 *   G. back 在栈只有一层时退回首页 tab
 *   H. back 正常时不要去碰 tab（否则用户会被莫名弹到首页）
 *   I. 空 url / 非字符串一律拒绝
 *   J. 静态扫描：pages/ 下不允许再出现裸的 wx.navigateTo / switchTab
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

/* ---------------- 可控时钟 ---------------- */

let clock = 1000000
const realNow = Date.now
Date.now = function () { return clock }
function advance(ms) { clock += ms }

/* ---------------- wx 桩 ---------------- */

let calls = []
let behavior = {}

function reset() {
  calls = []
  behavior = {}
  clock = 1000000
}

global.wx = {
  navigateTo(o) {
    calls.push({ api: 'navigateTo', url: o && o.url })
    const b = behavior.navigateTo
    if (b === 'throw') throw new Error('navigateTo:fail page "xxx" is not found')
    if (b === 'full') { o && o.fail && o.fail({ errMsg: 'navigateTo:fail page limit exceeded' }); return }
    if (b === 'other') { o && o.fail && o.fail({ errMsg: 'navigateTo:fail webview count limit exceed' }); return }
    if (b === 'notfound') { o && o.fail && o.fail({ errMsg: 'navigateTo:fail page "pages/nope/nope" is not found' }); return }
    o && o.success && o.success({})
  },
  redirectTo(o) {
    calls.push({ api: 'redirectTo', url: o && o.url })
    o && o.success && o.success({})
  },
  switchTab(o) {
    calls.push({ api: 'switchTab', url: o && o.url })
    if (behavior.switchTab === 'throw') throw new Error('switchTab:fail')
    o && o.success && o.success({})
  },
  navigateBack(o) {
    calls.push({ api: 'navigateBack', delta: o && o.delta })
    if (behavior.navigateBack === 'throw') throw new Error('navigateBack:fail')
    if (behavior.navigateBack === 'fail') {
      o && o.fail && o.fail({ errMsg: 'navigateBack:fail cannot navigate back at first page' })
      return
    }
    o && o.success && o.success({})
  },
  showToast(o) { calls.push({ api: 'showToast', title: o && o.title }) },
  getWindowInfo() { return { statusBarHeight: 44 } },
  getSystemInfoSync() { return { statusBarHeight: 44 } },
  getMenuButtonBoundingClientRect() {
    return { top: 48, bottom: 80, height: 32, width: 87, left: 296, right: 383 }
  }
}

function count(api) {
  return calls.filter(function (c) { return c.api === api }).length
}
function last(api) {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].api === api) return calls[i]
  return null
}

const nav = require(path.join(ROOT, 'utils', 'nav.js'))

console.log('\n== A. 双击防抖 ==')
reset()
nav._reset()
ck('A1 首次跳转发起成功', nav.to('/pages/tryon/tryon') === true)
ck('A2 只发了一次 navigateTo', count('navigateTo') === 1, '实际 ' + count('navigateTo'))
advance(120)
ck('A3 120ms 后第二次被挡', nav.to('/pages/tryon/tryon') === false)
ck('A4 仍然只有一次 navigateTo', count('navigateTo') === 1, '实际 ' + count('navigateTo'))
advance(120)
ck('A5 240ms 后第三次仍被挡', nav.to('/pages/tryon/tryon') === false)
ck('A6 navigateTo 计数没涨', count('navigateTo') === 1, '实际 ' + count('navigateTo'))
ck('A7 被挡掉的点击不弹 toast（用户不需要知道）', count('showToast') === 0)

console.log('\n== B. 锁会过期 ==')
reset()
nav._reset()
nav.to('/pages/gallery/gallery')
advance(nav.LOCK_MS + 1)
ck('B1 超过 LOCK_MS 后可以再跳', nav.to('/pages/tryon/tryon') === true)
ck('B2 这次真的发出去了', count('navigateTo') === 2, '实际 ' + count('navigateTo'))
ck('B3 url 是第二次的那个', last('navigateTo').url === '/pages/tryon/tryon', String(last('navigateTo').url))

console.log('\n== C. 栈满降级 ==')
reset()
nav._reset()
behavior.navigateTo = 'full'
const okC = nav.to('/pages/tryon/tryon')
ck('C1 返回值仍是 true（跳转确实发生了）', okC === true)
ck('C2 降级调用了 redirectTo', count('redirectTo') === 1, '实际 ' + count('redirectTo'))
ck('C3 redirectTo 用的是同一个 url', last('redirectTo').url === '/pages/tryon/tryon', String(last('redirectTo').url))
ck('C4 栈满不弹「页面打开失败」', count('showToast') === 0)

reset()
nav._reset()
behavior.navigateTo = 'other'
nav.to('/pages/tryon/tryon')
ck('C5 另一种栈满文案也能识别（webview count limit exceed）', count('redirectTo') === 1, '实际 ' + count('redirectTo'))

console.log('\n== D. 其他失败要提示 ==')
reset()
nav._reset()
behavior.navigateTo = 'notfound'
nav.to('/pages/nope/nope')
ck('D1 未知错误走 toast', count('showToast') === 1, '实际 ' + count('showToast'))
ck('D2 toast 文案说明白', last('showToast').title === '页面打开失败', String(last('showToast').title))
ck('D3 不要误降级成 redirectTo', count('redirectTo') === 0, '实际 ' + count('redirectTo'))

console.log('\n== E. 跳转本身抛异常 ==')
reset()
nav._reset()
behavior.navigateTo = 'throw'
let threw = false
let okE = false
try { okE = nav.to('/pages/tryon/tryon') } catch (e) { threw = true }
ck('E1 不把异常抛给调用方', threw === false)
ck('E2 返回 false', okE === false)
ck('E3 没弹 toast（抛异常时 fail 不会被调用）', count('showToast') === 0)

console.log('\n== F. tab 切换 ==')
reset()
nav._reset()
ck('F1 首次 switchTab 成功', nav.tab('/pages/history/history') === true)
ck('F2 发出去了', count('switchTab') === 1, '实际 ' + count('switchTab'))
ck('F3 立刻再切被挡', nav.tab('/pages/gallery/gallery') === false)
ck('F4 仍然一次', count('switchTab') === 1, '实际 ' + count('switchTab'))
advance(nav.LOCK_MS + 1)
ck('F5 过期后可再切', nav.tab('/pages/gallery/gallery') === true)
ck('F6 切到了 gallery', last('switchTab').url === '/pages/gallery/gallery', String(last('switchTab').url))

console.log('\n== G. back 兜底 ==')
reset()
nav._reset()
behavior.navigateBack = 'fail'
nav.back('/pages/index/index')
ck('G1 先尝试 navigateBack', count('navigateBack') === 1, '实际 ' + count('navigateBack'))
ck('G2 失败后退回首页 tab', count('switchTab') === 1, '实际 ' + count('switchTab'))
ck('G3 退的是首页', last('switchTab').url === '/pages/index/index', String(last('switchTab').url))

reset()
nav._reset()
behavior.navigateBack = 'throw'
nav.back('/pages/index/index')
ck('G4 navigateBack 抛异常也能兜底', count('switchTab') === 1, '实际 ' + count('switchTab'))

console.log('\n== H. back 正常时不碰 tab ==')
reset()
nav._reset()
nav.back('/pages/index/index')
ck('H1 调了 navigateBack', count('navigateBack') === 1)
ck('H2 没有多切一次 tab', count('switchTab') === 0, '实际 ' + count('switchTab'))
ck('H3 delta 是 1', last('navigateBack').delta === 1, String(last('navigateBack').delta))

console.log('\n== I. 参数防御 ==')
reset()
nav._reset()
ck('I1 空字符串被拒', nav.to('') === false)
ck('I2 undefined 被拒', nav.to() === false)
ck('I3 null 被拒', nav.to(null) === false)
ck('I4 数字被拒', nav.to(123) === false)
ck('I5 对象被拒', nav.to({ url: '/x' }) === false)
ck('I6 一个都没发出去', count('navigateTo') === 0, '实际 ' + count('navigateTo'))
ck('I7 tab 同样拒绝空值', nav.tab('') === false)
ck('I8 tab 也没发出去', count('switchTab') === 0, '实际 ' + count('switchTab'))
ck('I9 back 不给兜底时也不崩', (function () {
  reset(); nav._reset(); behavior.navigateBack = 'fail'
  nav.back()
  return count('switchTab') === 0
})())

console.log('\n== J. 静态扫描：页面里不许有裸跳转 ==')
function walk(dir, out) {
  const list = fs.readdirSync(dir)
  for (const name of list) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(js|wxml)$/.test(name)) out.push(p)
  }
  return out
}
const pageFiles = walk(path.join(ROOT, 'pages'), [])
const offenders = []
for (const f of pageFiles) {
  const src = fs.readFileSync(f, 'utf8')
  const lines = src.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]
    // 注释里提到 API 名字是正常的，跳过整行注释
    const trimmed = L.trim()
    if (trimmed.indexOf('//') === 0 || trimmed.indexOf('*') === 0) continue
    if (/\bwx\.(navigateTo|redirectTo|reLaunch|switchTab)\s*\(/.test(L)) {
      offenders.push(path.relative(ROOT, f) + ':' + (i + 1) + '  ' + trimmed)
    }
  }
}
ck('J1 pages/ 下没有裸的页面跳转', offenders.length === 0, offenders.join(' | '))

const navSrc = fs.readFileSync(path.join(ROOT, 'utils', 'nav.js'), 'utf8')
ck('J2 nav.js 导出了 to/tab/back', /to:\s*to/.test(navSrc) && /tab:\s*tab/.test(navSrc) && /back:\s*back/.test(navSrc))
ck('J3 五个页面都 require 了 nav', ['index', 'gallery', 'profile', 'history', 'tryon'].every(function (p) {
  const s = fs.readFileSync(path.join(ROOT, 'pages', p, p + '.js'), 'utf8')
  return s.indexOf("require('../../utils/nav')") >= 0
}))

console.log('\n== K. 页头让开胶囊 ==')
// 默认桩：状态栏 44，胶囊 28~80（iPhone 上的典型值）
const savedWinInfo = global.wx.getWindowInfo
const savedMenu = global.wx.getMenuButtonBoundingClientRect
const savedSysInfo = global.wx.getSystemInfoSync

global.wx.getWindowInfo = function () { return { statusBarHeight: 44 } }
global.wx.getMenuButtonBoundingClientRect = function () {
  return { top: 48, bottom: 80, height: 32, width: 87, left: 296, right: 383 }
}
ck('K1 基准取胶囊底边', nav.topPad(12) === 92, String(nav.topPad(12)))
ck('K2 gap=0 时正好贴胶囊底边', nav.topPad(0) === 80, String(nav.topPad(0)))
ck('K3 gap 缺省按 12 算', nav.topPad() === 92, String(nav.topPad()))
ck('K4 gap 传非数字按 12 算', nav.topPad('x') === 92, String(nav.topPad('x')))
ck('K5 必须比旧写法（状态栏+12=56）更靠下', nav.topPad(12) > 56, String(nav.topPad(12)))

// 老基础库：没有 getMenuButtonBoundingClientRect
global.wx.getMenuButtonBoundingClientRect = undefined
ck('K6 无胶囊 API 时退回状态栏+32', nav.topPad(12) === 44 + 32 + 12, String(nav.topPad(12)))

// 胶囊返回全 0（部分安卓机型会）
global.wx.getMenuButtonBoundingClientRect = function () {
  return { top: 0, bottom: 0, height: 0, width: 0, left: 0, right: 0 }
}
ck('K7 胶囊全 0 时不能直接用', nav.topPad(12) === 88, String(nav.topPad(12)))

// 胶囊比状态栏还高（横屏/平板）→ 取更靠下的
global.wx.getMenuButtonBoundingClientRect = function () {
  return { top: 10, bottom: 20, height: 10, width: 40, left: 0, right: 40 }
}
ck('K8 胶囊比状态栏靠上时以状态栏为准', nav.topPad(12) === 44 + 12, String(nav.topPad(12)))

// 没有 getWindowInfo，只有 getSystemInfoSync
global.wx.getMenuButtonBoundingClientRect = savedMenu
global.wx.getWindowInfo = undefined
ck('K9 无 getWindowInfo 时用 getSystemInfoSync', nav.topPad(12) === 92, String(nav.topPad(12)))

// 三个 API 全都没有（极老基础库 / 异常环境）
global.wx.getSystemInfoSync = undefined
global.wx.getMenuButtonBoundingClientRect = undefined
ck('K10 全都拿不到时兜底 20+32', nav.topPad(12) === 20 + 32 + 12, String(nav.topPad(12)))

// 恢复
global.wx.getWindowInfo = savedWinInfo
global.wx.getSystemInfoSync = savedSysInfo
global.wx.getMenuButtonBoundingClientRect = savedMenu
ck('K11 恢复后回到胶囊基准', nav.topPad(12) === 92, String(nav.topPad(12)))

console.log('\n----------------------------------------')
console.log('pass ' + pass + ' / fail ' + fail)
if (fail) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
}
process.exit(fail ? 1 : 0)
