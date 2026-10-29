/**
 * 死代码 / 冗余样式审计
 *
 * 微信小程序的代码包有 2MB 主包上限（分包另算），但这个项目的真正成本
 * 不在体积，在「读代码的人要花多久判断这段还有没有用」。
 * 上一批已经抓到过一处（switchTimer2 只 clear 从不创建），
 * 这里把它做成可重复执行的扫描，而不是靠人眼。
 *
 * 三类：
 *   A 工具模块里定义了却没人调用的函数
 *   B Page 里定义了、wxml 没绑、js 内部也没引用的方法
 *   C wxss 里定义了、所有 wxml 都没用到的类名
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

function walk(d, out) {
  for (const f of fs.readdirSync(d)) {
    if (f === 'node_modules' || f === '.workbuddy-ai' || f === 'tests') continue
    const p = path.join(d, f)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const all = walk(ROOT, [])
const jsFiles = all.filter(f => f.endsWith('.js'))
const wxmlFiles = all.filter(f => f.endsWith('.wxml'))
const wxssFiles = all.filter(f => f.endsWith('.wxss'))

const read = f => fs.readFileSync(f, 'utf8')
const rel = f => path.relative(ROOT, f).replace(/\\/g, '/')

const jsSrc = {}
jsFiles.forEach(f => { jsSrc[rel(f)] = read(f) })
const wxmlAll = wxmlFiles.map(read).join('\n')
const wxssSrc = {}
wxssFiles.forEach(f => { wxssSrc[rel(f)] = read(f) })

let issues = 0

/* ---------- A 工具模块里没人调用的函数 ---------- */

console.log('[A] utils 里定义了但项目中没有调用点的函数:')
const utilFiles = jsFiles.filter(f => /utils[\\/]/.test(f))
// 这些函数是给外部（小程序框架 / 测试台 / 未来功能）预留的，不算死代码
const KEEP = {
  'utils/hair-engine.js': ['module.exports'],
  'utils/cloud.js': ['init', 'call', 'ready', 'diag'],
  'utils/workbuddy-cloud-diagnostics.js': ['*'],
  'utils/cloud-config.js': ['*']
}

let aCount = 0
for (const f of utilFiles) {
  const r = rel(f)
  if (KEEP[r] && KEEP[r][0] === '*') continue
  const src = jsSrc[r]
  const defined = []
  for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) defined.push(m[1])
  for (const name of defined) {
    // 统计全项目里「以标识符形式」出现的次数
    const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g')
    let total = 0
    for (const k of Object.keys(jsSrc)) {
      const c = (jsSrc[k].match(re) || []).length
      total += c
    }
    // 定义处本身算 1 次；模块内部其它调用点也算
    const kept = KEEP[r] || []
    if (total <= 1 && kept.indexOf(name) < 0) {
      console.log('   未被调用  ' + r + ' -> ' + name)
      aCount++
    }
  }
}
if (!aCount) console.log('   OK  没有发现完全未被引用的函数')
issues += aCount

/* ---------- B Page 里没被 wxml 绑定、js 内也没引用的方法 ---------- */

console.log('')
console.log('[B] Page 方法未在 wxml 绑定且 js 内部未引用:')
const LIFECYCLE = ['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload', 'onPullDownRefresh',
  'onReachBottom', 'onShareAppMessage', 'onShareTimeline', 'onPageScroll', 'onResize',
  'onTabItemTap', 'onError', 'onAddToFavorites']
let bCount = 0
for (const f of jsFiles.filter(x => /pages[\\/]/.test(x) && /\.js$/.test(x))) {
  const r = rel(f)
  const src = jsSrc[r]
  const wxml = r.replace(/\.js$/, '.wxml')
  const wxmlSrc = fs.existsSync(path.join(ROOT, wxml)) ? read(path.join(ROOT, wxml)) : ''
  const names = []
  for (const m of src.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*\(/gm)) names.push(m[1])
  const dead = []
  for (const n of names) {
    if (LIFECYCLE.indexOf(n) >= 0) continue
    if (new RegExp('"' + n + '"').test(wxmlSrc)) continue
    // js 内部引用次数（排除定义行）
    const re = new RegExp('\\b' + n + '\\b', 'g')
    const total = (src.match(re) || []).length
    if (total <= 1) dead.push(n)
  }
  if (dead.length) {
    console.log('   ' + r + ' -> ' + dead.join(', '))
    bCount += dead.length
  }
}
if (!bCount) console.log('   OK  没有孤立方法')
issues += bCount

/* ---------- C wxss 里没用到的类名 ---------- */

console.log('')
console.log('[C] wxss 中定义但 wxml 未使用的类名:')
let cCount = 0
for (const r of Object.keys(wxssSrc)) {
  const src = wxssSrc[r]
  // 只取最外层类选择器（排除伪类/后代/组合选择器带来的误报）
  const classes = new Set()
  for (const m of src.matchAll(/^\.([A-Za-z][\w-]*)\s*[,{]/gm)) classes.add(m[1])
  const unused = []
  for (const c of classes) {
    if (wxmlAll.indexOf(c) >= 0) continue
    unused.push(c)
  }
  if (unused.length) {
    console.log('   ' + r + ' -> ' + unused.join(', '))
    cCount += unused.length
  }
}
if (!cCount) console.log('   OK  没有未使用的类名')
issues += cCount

/* ---------- 汇总 ---------- */
console.log('')
console.log('========================================')
console.log('死代码审计: 未引用函数 ' + aCount + ' / 孤立方法 ' + bCount + ' / 未用样式 ' + cCount)
console.log(issues === 0 ? '全部干净' : '需要人工确认上面每一项')
