/**
 * 脖子：头发必须在脖子**后面**（第 51 轮）
 *
 * 这个文件前两版都在验证「补丁放对了没有」，而补丁本身就是错的：
 *
 *   第一版  inner:[94,172] outer:[106,172]，宽 12、中心在 x=100
 *           —— 从嘴唇垂到下巴的一根黑竖条，像一撮山羊胡。
 *   第二版  inner:[74,188] outer:[126,182]，宽 52、盖住整个脖子
 *           —— 山羊胡变成一整块从下巴垂到胸口的黑帘。
 *
 * 两版都通过了当时的测试，因为测试问的是「下巴以下有没有头发」。
 * 而正确答案是**没有**：脖子在 x 78..122、y 168 以下，
 * 长发垂在脖子后面，正面看过去，脖子正中间被脖子自己挡着，
 * 那里出现任何头发都是穿帮。能看见的只有脖子两侧那一条。
 *
 * 所以这一轮把判据反过来：
 *   A. 脖子正中（|x-100| < 22，y 188..212）必须是 0 根发丝
 *   B. 脖子两侧（|x-100| 22..52）必须有头发，长发不能在这里断掉
 *   C. 嘴和下巴依然不能有头发
 *   D. 几何上确实分成了左右两片，且没有残留的旧补丁
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

global.wx = { getStorageSync() { return '' }, setStorageSync() {}, removeStorageSync() {} }
if (typeof global.Path2D === 'undefined') global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }

const hs = require(path.join(ROOT, 'utils', 'hairstyles'))
const src = fs.readFileSync(path.join(ROOT, 'utils', 'hairstyles.js'), 'utf8')

const LONG = ['long-straight', 'wavy', 'curly', 'middle-part']

/** 数一下某个矩形区域里有多少个发丝采样点 */
function countIn(geom, xLo, xHi, yLo, yHi) {
  let n = 0
  for (let i = 0; i < geom.body.length; i++) {
    const pts = geom.body[i].pts
    for (let j = 0; j < pts.length; j++) {
      const p = pts[j]
      if (p.x >= xLo && p.x <= xHi && p.y >= yLo && p.y <= yHi) n++
    }
  }
  return n
}

/* ================= A/B/C. 脖子与脸 ================= */

console.log('\n[A] 脖子正中不能有头发')

LONG.forEach(function (id, i) {
  const geom = hs.getGeom(hs.getStyle(id), 'low')
  // 脖子裸露段：下巴（y=190）以下、脖子底（y≈206）以上
  const neckMid = countIn(geom, 78, 122, 188, 212)
  ck('A' + (i + 1) + ' ' + id + ' 脖子正中是空的', neckMid === 0, '命中 ' + neckMid)
})

console.log('\n[B] 脖子两侧必须有头发')

LONG.forEach(function (id, i) {
  const geom = hs.getGeom(hs.getStyle(id), 'low')
  const left = countIn(geom, 48, 78, 188, 212)
  const right = countIn(geom, 122, 152, 188, 212)
  ck('B' + (i + 1) + 'a ' + id + ' 左侧有头发', left >= 4, '命中 ' + left)
  ck('B' + (i + 1) + 'b ' + id + ' 右侧有头发', right >= 4, '命中 ' + right)
})

console.log('\n[C] 不糊嘴、不盖下巴')

LONG.forEach(function (id, i) {
  const geom = hs.getGeom(hs.getStyle(id), 'low')
  // 嘴大约在 y=146~160，下巴 160~190
  const mouth = countIn(geom, 82, 118, 146, 172)
  const chin = countIn(geom, 82, 118, 172, 188)
  ck('C' + (i + 1) + 'a ' + id + ' 不糊嘴', mouth === 0, '命中 ' + mouth)
  ck('C' + (i + 1) + 'b ' + id + ' 不盖下巴', chin <= 6, '命中 ' + chin)
})

/* ================= D. 几何 ================= */

console.log('\n[D] 左右两片，没有残留的旧补丁')

ck('D1 定义了 neckSideLocks', /function neckSideLocks\(/.test(src))
const calls = (src.match(/neckSideLocks\(/g) || []).length
// 1 次定义 + 4 次调用
ck('D2 四款长发都调用它', calls === 5, String(calls))
ck('D3 旧的 backNeckLocks 已彻底删除', src.indexOf('backNeckLocks') < 0)
ck('D4 没有残留的 94..106 窄条', src.indexOf('inner: [94, 172') < 0)
ck('D5 没有残留的 74..126 宽条', src.indexOf('inner: [74, 188') < 0)

const fn = src.slice(src.indexOf('function neckSideLocks'), src.indexOf('/* ---------------- 发型定义'))
const mi = fn.match(/inner:\s*\[([^\]]+)\]/)
const mo = fn.match(/outer:\s*\[([^\]]+)\]/)
ck('D6 有 inner / outer 两条导轨', !!mi && !!mo)
if (mi && mo) {
  const ix = Number(mi[1].split(',')[0].trim())
  const ox = Number(mo[1].split(',')[0].trim())
  // 内沿必须在脖子侧缘（x=122）之外，并且缩放后仍然在外侧
  ck('D7 内沿在脖子侧缘之外（x ≥ 126）', ix >= 126, 'x=' + ix)
  ck('D8 外沿接到垂帘内沿（x ≥ 145）', ox >= 145, 'x=' + ox)
  ck('D9 一片的宽度在 20~40 之间', ox - ix >= 20 && ox - ix <= 40, 'w=' + (ox - ix))
}
ck('D10 走 panels() 而不是 panelLocks()，左右各画一片',
  /function neckSideLocks[\s\S]{0,400}?return panels\(/.test(fn))

/* ================= E. 长直发的发际线拐角 ================= */

console.log('\n[E] 额角黑方块')

const longBlock = src.slice(src.indexOf("id: 'long-straight'"), src.indexOf("id: 'wavy'"))

// 发块的洞边界（发际线）不能比发梢更靠外/更靠下
ck('E1 发际线中间压到 y≥97', /C\(128, 9[7-9], 72, 9[7-9], 54, 9[7-9]\)/.test(longBlock))
ck('E2 额角拐角压到 y≥96', /C\(147, 116, 146, 10[0-9], 146, 9[6-9]\)/.test(longBlock))

const arcM = longBlock.match(/end:\s*arc\(100,\s*(\d+),\s*(\d+),\s*(\d+)/)
ck('E3 刘海发梢弧覆盖到额角（半径 ≥ 45）', arcM && Number(arcM[2]) >= 45, arcM && arcM[2])
ck('E4 刘海有长短参差（endJitter）', /endJitter:\s*\d+/.test(longBlock))
ck('E5 刘海梢宽不是默认的 9%（引擎现在真的读 w[1]）',
  /width:\s*\[9,\s*4\.\d\]/.test(longBlock))

console.log('\n----------------------------------------')
console.log('pass ' + pass + ' / fail ' + fail)
if (fail) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
}
process.exit(fail ? 1 : 0)
