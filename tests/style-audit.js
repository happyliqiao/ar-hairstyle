/**
 * 样式一致性审计
 *
 * 主题色散落在 6 个 wxss 里时，改一次配色要改十几处，漏一处就出现
 * 「这个按钮还是旧金色」。这里做三件事：
 *   A 找出定义了但没人用的 CSS 变量（改配色时的噪音）
 *   B 找出本该用变量却硬编码的品牌色（改配色时的漏网之鱼）
 *   C 找出跨文件重复的规则块（同一段样式抄了两遍）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pages = fs.readdirSync(path.join(ROOT, 'pages'))

const wxssFiles = [path.join(ROOT, 'app.wxss')]
pages.forEach(function (p) {
  const f = path.join(ROOT, 'pages', p, p + '.wxss')
  if (fs.existsSync(f)) wxssFiles.push(f)
})

const src = {}
wxssFiles.forEach(function (f) {
  src[path.relative(ROOT, f).replace(/\\/g, '/')] = fs.readFileSync(f, 'utf8')
})
const all = Object.keys(src).map(function (k) { return src[k] }).join('\n')

let issues = 0

/* ---------- A 未使用的 CSS 变量 ---------- */
console.log('[A] 定义了但没有任何地方使用的 CSS 变量:')
const defined = {}
for (const m of all.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) defined[m[1]] = 1
const unusedVars = []
Object.keys(defined).forEach(function (v) {
  // 用 var(--x) 或 var(--x, fallback) 都算使用
  const re = new RegExp('var\\(\\s*' + v.replace(/-/g, '\\-') + '\\b')
  const uses = (all.match(new RegExp('var\\(\\s*' + v.replace(/-/g, '\\-') + '\\b', 'g')) || []).length
  if (!uses) unusedVars.push(v)
})
if (unusedVars.length) {
  console.log('   ' + unusedVars.join(', '))
  issues += unusedVars.length
} else {
  console.log('   OK  ' + Object.keys(defined).length + ' 个变量全部有使用')
}

/* ---------- B 硬编码品牌色 ---------- */
console.log('')
console.log('[B] 硬编码的品牌色（应改用变量）:')
// 品牌金 #e0a86f / #f0c48f / #c98b52 与玫红 #e94560 的近似色
const BRAND = ['#e0a86f', '#f0c48f', '#c98b52', '#e94560', '#d9a05f', '#cf9a63']
const hardcoded = []
Object.keys(src).forEach(function (f) {
  const lines = src[f].split('\n')
  lines.forEach(function (line, i) {
    // 跳过变量定义行本身
    if (/^\s*--/.test(line)) return
    BRAND.forEach(function (c) {
      if (line.toLowerCase().indexOf(c) >= 0) {
        hardcoded.push(f + ':' + (i + 1) + '  ' + line.trim())
      }
    })
  })
})
if (hardcoded.length) {
  hardcoded.forEach(function (h) { console.log('   ' + h) })
  issues += hardcoded.length
} else {
  console.log('   OK  没有硬编码品牌色')
}

/* ---------- C 跨文件重复的规则块 ---------- */
console.log('')
console.log('[C] 跨文件重复的规则块:')
const blocks = {}
Object.keys(src).forEach(function (f) {
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(src[f])) !== null) {
    const body = m[2].replace(/\s+/g, ' ').trim()
    if (body.length < 30) continue          // 太短的不算重复
    if (/^\s*page\s*$/.test(m[1])) continue // page 变量块只出现在 app.wxss
    if (!blocks[body]) blocks[body] = []
    blocks[body].push({ file: f, sel: m[1].trim() })
  }
})

// 分两类：
//   同名选择器 + 同样式 → 真重复，应该合并到 app.wxss
//   不同名选择器 + 同样式 → 只是巧合（.stat-label 和 .shutter-side-text
//   都是「小号灰字」，但语义不同，合并反而会让以后改一个牵连另一个）
let realDup = 0
let coincidental = 0
Object.keys(blocks).forEach(function (body) {
  const where = blocks[body]
  const files = {}
  where.forEach(function (w) { files[w.file] = 1 })
  if (Object.keys(files).length <= 1) return

  const sels = {}
  where.forEach(function (w) { sels[w.sel] = 1 })
  const sameSelector = Object.keys(sels).length === 1

  if (sameSelector) {
    realDup++
    console.log('   重复  ' + where.map(function (w) { return w.file + ' -> ' + w.sel }).join('  |  '))
    console.log('         { ' + body.slice(0, 100) + (body.length > 100 ? '…' : '') + ' }')
  } else {
    coincidental++
  }
})
if (!realDup) console.log('   OK  没有同名选择器的跨文件重复')
console.log('   （另有 ' + coincidental + ' 组「不同选择器但声明相同」，属正常，不合并）')
issues += realDup

/* ---------- D 各文件体量 ---------- */
console.log('')
console.log('[D] 各文件体量:')
Object.keys(src).forEach(function (f) {
  const kb = (Buffer.byteLength(src[f], 'utf8') / 1024).toFixed(1)
  console.log('   ' + f.padEnd(30) + kb + ' KB')
})

console.log('')
console.log('========================================')
console.log('样式一致性: 未用变量 ' + unusedVars.length +
  ' / 硬编码品牌色 ' + hardcoded.length + ' / 真重复规则块 ' + realDup)
console.log(issues === 0 ? '全部干净' : '需要人工确认上面每一项')
