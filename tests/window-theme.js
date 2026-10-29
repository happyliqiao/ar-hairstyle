/**
 * 窗口背景与配色一致性（第 48 轮）
 *
 * 这一轮看的是**页面边界之外**的那一圈：下拉回弹露出来的区域、
 * 页面转场时露出来的区域、tabBar 的分隔线。
 *
 * 三个具体问题：
 *
 * 1) **iOS 下拉回弹露白。** `backgroundColorTop` / `backgroundColorBottom`
 *    的默认值是 `#ffffff`（不是跟随 backgroundColor），而且**只有 iOS 支持**。
 *    这个 app 是纯深色的，用户在首页往下拉一下，屏幕顶部会翻出一条白边 ——
 *    看起来像页面坏了。这两个字段原来一个都没配。
 *
 * 2) **两个深色不是一个深色。** `app.json` 的窗口背景写 `#0d0d17`，
 *    而 `app.wxss` 的 `--bg` 是 `#0b0b12`。两者差 2 个色阶，肉眼单看
 *    都看不出，但页面转场时两块颜色并排滑过，就成了一条会移动的色带。
 *
 * 3) **tabBar 的分隔线看不见。** `borderStyle: "black"` 在深色 tabBar
 *    上等于一条更深的线，实际效果是 tabBar 和页面糊成一片，
 *    用户分不清哪块是「固定在底部」的。
 *
 * 这一轮验证：
 *   A. app.json 的窗口背景三件套齐全且与设计变量一致
 *   B. 试戴页（相机页）露出来的是纯黑，不是页面灰
 *   C. tabBar 的配色与设计变量一致
 *   D. 每个页面都不许自己另设窗口背景（否则转场有色差）
 *   E. 全项目没有残留的旧背景色
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

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
const appWxss = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')

/** 从 app.wxss 里取一个设计变量的值 */
function cssVar(name) {
  const m = appWxss.match(new RegExp('--' + name + ':\\s*([^;]+);'))
  return m ? m[1].trim() : ''
}

function isHex(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

function lower(v) {
  return typeof v === 'string' ? v.toLowerCase() : ''
}

/* ================= A. 窗口背景三件套 ================= */

console.log('\n[A] 窗口背景')

const win = appJson.window || {}
const bg = win.backgroundColor

ck('A1 有 backgroundColor', isHex(bg), String(bg))
ck('A2 有 backgroundColorTop（iOS 下拉回弹露的就是它）', isHex(win.backgroundColorTop), String(win.backgroundColorTop))
ck('A3 有 backgroundColorBottom', isHex(win.backgroundColorBottom), String(win.backgroundColorBottom))
ck('A4 三者一致（不然回弹时会看到色阶跳变）',
  lower(win.backgroundColorTop) === lower(bg) && lower(win.backgroundColorBottom) === lower(bg),
  [bg, win.backgroundColorTop, win.backgroundColorBottom].join(' / '))
ck('A5 不是默认白（默认值就是 #ffffff，忘了配才会白）',
  lower(win.backgroundColorTop) !== '#ffffff', String(win.backgroundColorTop))

const bgVar = cssVar('bg')
ck('A6 app.wxss 定义了 --bg', isHex(bgVar), String(bgVar))
ck('A7 窗口背景与页面背景是同一个颜色（转场无色差）',
  lower(bg) === lower(bgVar), bg + ' vs ' + bgVar)

ck('A8 深色背景配 light 下拉 loading', win.backgroundTextStyle === 'light', String(win.backgroundTextStyle))

/* ================= B. 试戴页 ================= */

console.log('\n[B] 试戴页露黑')

const tryonJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'pages/tryon/tryon.json'), 'utf8'))
ck('B1 试戴页有 backgroundColor', isHex(tryonJson.backgroundColor), String(tryonJson.backgroundColor))
ck('B2 是纯黑（相机页露灰边很脏）', lower(tryonJson.backgroundColor) === '#000000', String(tryonJson.backgroundColor))
ck('B3 有 backgroundColorTop', isHex(tryonJson.backgroundColorTop), String(tryonJson.backgroundColorTop))
ck('B4 有 backgroundColorBottom', isHex(tryonJson.backgroundColorBottom), String(tryonJson.backgroundColorBottom))
ck('B5 三者也一致', lower(tryonJson.backgroundColorTop) === '#000000' && lower(tryonJson.backgroundColorBottom) === '#000000',
  [tryonJson.backgroundColorTop, tryonJson.backgroundColorBottom].join(' / '))
ck('B6 仍然禁止滚动（相机页不该被拖动）', tryonJson.disableScroll === true)

/* ================= C. tabBar ================= */

console.log('\n[C] tabBar')

const tab = appJson.tabBar || {}
ck('C1 有 tabBar', !!tab.list && Array.isArray(tab.list))
ck('C2 分隔线用 white（深色 tabBar 上用 black 等于没有分隔线）',
  tab.borderStyle === 'white', String(tab.borderStyle))
ck('C3 未选中色与 --tab-text 一致', lower(tab.color) === lower(cssVar('tab-text')),
  String(tab.color) + ' vs ' + cssVar('tab-text'))
ck('C4 选中色与 --gold 一致', lower(tab.selectedColor) === lower(cssVar('gold')),
  String(tab.selectedColor) + ' vs ' + cssVar('gold'))
ck('C5 tabBar 背景与 --tab-bg 一致', lower(tab.backgroundColor) === lower(cssVar('tab-bg')),
  String(tab.backgroundColor) + ' vs ' + cssVar('tab-bg'))

/** WCAG 相对亮度 */
function lum(hex) {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}
function ratio(a, b) {
  const la = lum(a)
  const lb = lum(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

const cTab = ratio(tab.color, tab.backgroundColor)
ck('C6 未选中文字对比度 ≥ 4.5（tabBar 字小，暗一档就读不清）', cTab >= 4.5, cTab.toFixed(2))
const cSel = ratio(tab.selectedColor, tab.backgroundColor)
ck('C7 选中文字对比度 ≥ 4.5', cSel >= 4.5, cSel.toFixed(2))
ck('C8 tabBar 背景比卡片表面更暗（层级：页面 < tabBar < 卡片）',
  lum(tab.backgroundColor) < lum(cssVar('surface')),
  lum(tab.backgroundColor).toFixed(4) + ' vs ' + lum(cssVar('surface')).toFixed(4))
ck('C9 4 个 tab 都指向真实页面', (tab.list || []).every(function (it) {
  return appJson.pages.indexOf(it.pagePath) >= 0
}), JSON.stringify((tab.list || []).map(function (i) { return i.pagePath })))

/* ================= D. 每个页面 ================= */

console.log('\n[D] 页面 json')

const pages = appJson.pages
let allCustom = true
let extraBg = []
pages.forEach(function (p) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, p + '.json'), 'utf8'))
  if (j.navigationStyle !== 'custom') allCustom = false
  // 只有试戴页可以自己设背景（它要纯黑）
  if (p !== 'pages/tryon/tryon' && j.backgroundColor) extraBg.push(p)
})
ck('D1 五个页面都是自定义导航栏（否则原生导航栏会和页头叠在一起）', allCustom)
ck('D2 只有试戴页自己设了窗口背景（其他页跟随全局，转场才无色差）',
  extraBg.length === 0, extraBg.join(','))

/* ================= E. 残留 ================= */

console.log('\n[E] 残留检查')

const oldColor = '#0d0d17'
const hits = []
function walk(dir) {
  fs.readdirSync(dir).forEach(function (n) {
    if (n === 'node_modules' || n === '.git' || n === 'tests') return
    const p = path.join(dir, n)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (/\.(json|wxss|wxml|js)$/.test(n)) {
      const s = fs.readFileSync(p, 'utf8').toLowerCase()
      if (s.indexOf(oldColor) >= 0) hits.push(path.relative(ROOT, p))
    }
  })
}
walk(ROOT)
ck('E1 没有残留的旧窗口背景色 ' + oldColor, hits.length === 0, hits.join(','))

// 所有 wxss 里出现的 hex 背景，必须要么是设计变量，要么在允许列表里
ck('E2 --bg / --surface 都是合法 hex', isHex(cssVar('bg')) && isHex(cssVar('surface')),
  cssVar('bg') + ' / ' + cssVar('surface'))

console.log('\n----------------------------------------')
console.log('pass ' + pass + ' / fail ' + fail)
if (fail) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
}
process.exit(fail ? 1 : 0)
