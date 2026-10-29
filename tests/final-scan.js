/* 全项目终极扫描（第 20 轮） */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

function walk(d, out) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|json|wxml|wxss)$/.test(f)) out.push(p)
  }
  return out
}

const files = walk('.', []).filter(f => !/node_modules|\.workbuddy/.test(f))
let jsErr = 0
let jsonErr = 0
for (const f of files) {
  if (f.endsWith('.js')) {
    // 用 vm.Script 做语法检查，而不是每个文件起一个 node --check 子进程。
    // 52 个文件起 52 个进程要 48 秒，编译一遍只要几十毫秒 ——
    // 检查本身没错，但慢到没人愿意在每次改动后跑它。
    try {
      new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f })
    } catch (e) {
      jsErr++
      console.log('JS 语法错误: ' + f + ' -> ' + e.message)
    }
  }
  if (f.endsWith('.json')) {
    try { JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) {
      jsonErr++
      console.log('JSON 错误: ' + f + ' -> ' + e.message)
    }
  }
}
console.log('[1] 文件扫描: ' + files.length + ' 个, JS 错误 ' + jsErr + ', JSON 错误 ' + jsonErr)

/* wxml 标签配对（自闭合标签如 <image ... /> 不要求闭合标签） */
let tagErr = 0
const SELF_CLOSING = ['image', 'slider', 'input', 'import', 'include', 'wxs']
for (const f of files.filter(x => x.endsWith('.wxml'))) {
  const s = fs.readFileSync(f, 'utf8')
  for (const t of ['view', 'text', 'scroll-view', 'image', 'button', 'slider', 'canvas', 'camera']) {
    const openRe = new RegExp('<' + t + '(\\s|>|/)', 'g')
    const opens = [...s.matchAll(openRe)].length
    const closes = (s.match(new RegExp('</' + t + '>', 'g')) || []).length
    // 自闭合形式：<image ... /> 或 <image ...>
    let selfClose = 0
    if (SELF_CLOSING.indexOf(t) >= 0) {
      const tagRe = new RegExp('<' + t + '\\b[^>]*?/?>', 'g')
      const tags = s.match(tagRe) || []
      selfClose = tags.filter(x => /\/>$/.test(x)).length
    }
    if (opens !== closes + selfClose) {
      tagErr++
      console.log('  ' + f + ' <' + t + '> 开 ' + opens + ' / 闭 ' + closes +
        ' / 自闭 ' + selfClose + ' 不配对')
    }
  }
}
console.log('[2] wxml 标签配对: ' + (tagErr ? tagErr + ' 处不配对' : '全部配对'))

/* 横滑 scroll-view 误触保护覆盖审计 */
console.log('[3] 横滑 scroll-view 误触保护覆盖:')
let uncovered = 0
for (const f of files.filter(x => x.endsWith('.wxml'))) {
  const s = fs.readFileSync(f, 'utf8')
  // 找出所有 scroll-x 块，检查是否带 catchtouchstart。
  // 注意：不能用 split('>')[0] 截断标签头 —— wx:if="{{a > b}}" 里
  // 含有 '>' 会提前截断，把带保护的标签漏掉。
  const blocks = s.split('<scroll-view')
  for (let i = 1; i < blocks.length; i++) {
    const head = blocks[i].slice(0, 500)
    if (!/scroll-x/.test(head)) continue
    const has = /catchtouchstart/.test(head)
    const js = f.replace(/\.wxml$/, '.js')
    const jsSrc = fs.existsSync(js) ? fs.readFileSync(js, 'utf8') : ''
    const imported = /swipe-guard/.test(jsSrc)
    const ok = has && imported
    if (!ok) uncovered++
    console.log('   ' + (ok ? 'OK  ' : '缺失') + ' ' + f +
      ' (catchtouchstart=' + (has ? '有' : '无') +
      ', swipe-guard=' + (imported ? '有' : '无') + ')')
  }
}

/* 定时器跟踪审计
 *
 * 目的不是「必须写成 this.xxx」这一种字面形态，而是「每个 setTimeout
 * 的 id 都被存下来了，onUnload 才有东西可清」。
 * 页面里的异步回调（VKSession 的 removeAnchors 等）拿不到 this，
 * 一律写成 `const self = this` 再 `self._xxxTimer = setTimeout(...)`，
 * 语义上同样是存在页面实例上，所以这里两种写法都算跟踪。
 */
console.log('[4] setTimeout 跟踪审计:')
let timerErr = 0
for (const f of files.filter(x => x.endsWith('.js') && /^pages[\\/]/.test(x))) {
  const src = fs.readFileSync(f, 'utf8')
  const all = [...src.matchAll(/setTimeout\(/g)].length
  const tracked = [...src.matchAll(/(?:this|self)\.\w+\s*=\s*setTimeout\(/g)].length
  if (all > 0) {
    if (tracked !== all) timerErr++
    console.log('   ' + f + ': ' + tracked + '/' + all + (tracked === all ? '  全部跟踪' : '  有未跟踪!'))
  }
}

/* wxml 事件绑定 → js 方法存在性审计
 *
 * 微信对「绑了一个不存在的方法」不会在编译期报错，只在你真的点到那个
 * 按钮时打一行 warning。也就是说：一个漏掉的方法可以一路带到线上，
 * 直到用户按下那颗按钮才发现它毫无反应。
 */
console.log('[5] wxml 事件绑定 → js 方法存在性:')
let handlerErr = 0
let handlerTotal = 0
for (const f of files.filter(x => x.endsWith('.wxml'))) {
  const s = fs.readFileSync(f, 'utf8')
  const js = f.replace(/\.wxml$/, '.js')
  if (!fs.existsSync(js)) continue
  const jsSrc = fs.readFileSync(js, 'utf8')

  // 收集 js 里定义的方法名：行首缩进后紧跟 name( 或 name:
  const defined = {}
  for (const m of jsSrc.matchAll(/^\s{0,4}(\w+)\s*\(/gm)) defined[m[1]] = 1
  for (const m of jsSrc.matchAll(/^\s{0,4}(\w+)\s*:\s*function/gm)) defined[m[1]] = 1

  // 收集 wxml 里 bindtap / catchtap / bindchanging / bindinput ...
  const used = {}
  for (const m of s.matchAll(/(?:bind|catch|capture-bind|capture-catch)[a-z]*\s*=\s*"([A-Za-z_$][\w$]*)"/g)) {
    used[m[1]] = (used[m[1]] || 0) + 1
  }
  const names = Object.keys(used)
  if (!names.length) continue
  handlerTotal += names.length
  const missing = names.filter(n => !defined[n])
  if (missing.length) {
    handlerErr += missing.length
    console.log('   缺失 ' + f + ' -> ' + missing.join(', '))
  } else {
    console.log('   OK  ' + f + ': ' + names.length + ' 个绑定全部有对应方法')
  }
}
if (!handlerTotal) console.log('   （没有找到任何事件绑定，检查正则是否失效）')

/* 汇总 */
console.log('')
console.log('========================================')
const allOk = jsErr === 0 && jsonErr === 0 && tagErr === 0 &&
  uncovered === 0 && timerErr === 0 && handlerErr === 0
console.log(allOk ? '终极扫描全部通过' : '存在问题，见上方明细')
process.exit(allOk ? 0 : 1)

