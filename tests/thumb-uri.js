/**
 * 缩略图 data URI 的形态（第 40 轮）
 *
 * 这一轮发现一个可能让整个 App 在真机上「一张图都不显示」的问题：
 *
 * `buildThumb` 原来生成的是
 *   `data:image/svg+xml;charset=utf-8,<encodeURIComponent(svg)>`
 * 也就是 **URL 编码**的 SVG data URI。
 *
 * 浏览器认这个形态，所以 `tests/preview-hair.js`、`canvas-shot.html`
 * 这些在 Chrome 里跑的测试台一直都好看得很。但微信小程序的 <image>
 * 是原生组件，只认 base64 形态的 data URI —— URL 编码的 SVG 在真机上
 * 大概率是一片空白。
 *
 * 而所有发型缩略图都走这个函数：
 *   首页热门 6 张 / 发型库 10 张 / 试戴页横滑 10 张 / 我的收藏 N 张
 * 一旦形态不对，用户看到的不是「某张图挂了」，是**满屏空白格子**。
 *
 * 这一轮把形态钉死，并且逐字节验证 base64 能还原出原始 SVG。
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

const hs = require(path.join(ROOT, 'utils/hairstyles'))

const STYLES = hs.HAIR_STYLES
const COLORS = hs.HAIR_COLORS

/* ================= A. 形态 ================= */

console.log('\n[A] 必须是 base64 形态的 data URI')

let badPrefix = 0
let badUrlEncoded = 0
let total = 0
const sizes = []

for (let i = 0; i < STYLES.length; i++) {
  for (let j = 0; j < COLORS.length; j++) {
    const uri = hs.buildThumb(STYLES[i].id, COLORS[j].id)
    total++
    sizes.push({ key: STYLES[i].id + '/' + COLORS[j].id, len: uri.length })
    if (uri.indexOf('data:image/svg+xml;base64,') !== 0) badPrefix++
    // URL 编码残留：< 被编成 %3C，SVG 标签一个都不会出现
    if (uri.indexOf('%3C') >= 0 || uri.indexOf('%3E') >= 0) badUrlEncoded++
  }
}

ck('A1 全部 ' + total + ' 张都是 base64 形态', badPrefix === 0, 'bad=' + badPrefix)
ck('A2 没有任何 URL 编码残留（%3C/%3E）', badUrlEncoded === 0, 'bad=' + badUrlEncoded)

/* ================= B. 逐字节还原 ================= */

console.log('\n[B] base64 能逐字节还原成原始 SVG')

let mismatch = 0
let firstBad = ''
for (let i = 0; i < STYLES.length; i++) {
  for (let j = 0; j < COLORS.length; j++) {
    const uri = hs.buildThumb(STYLES[i].id, COLORS[j].id)
    const body = uri.slice(uri.indexOf(',') + 1)
    const decoded = Buffer.from(body, 'base64').toString('binary')
    const expect = hs.buildSvg(STYLES[i].id, COLORS[j].id, 'low')
    if (decoded !== expect) {
      mismatch++
      if (!firstBad) firstBad = STYLES[i].id + '/' + COLORS[j].id
    }
  }
}
ck('B1 120 张全部逐字节一致', mismatch === 0, 'mismatch=' + mismatch + ' first=' + firstBad)

/* ================= C. 内容合法性 ================= */

console.log('\n[C] 解码后的 SVG 内容合法')

let nanCount = 0
let noPath = 0
let noSvgTag = 0
for (let i = 0; i < STYLES.length; i++) {
  for (let j = 0; j < COLORS.length; j++) {
    const uri = hs.buildThumb(STYLES[i].id, COLORS[j].id)
    const svg = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8')
    if (/NaN|undefined|Infinity/.test(svg)) nanCount++
    if ((svg.match(/<path/g) || []).length < 3) noPath++
    if (svg.indexOf('<svg') !== 0) noSvgTag++
  }
}
ck('C1 没有 NaN/undefined/Infinity', nanCount === 0, 'bad=' + nanCount)
ck('C2 每张至少 3 条 path（发块 + 色调层）', noPath === 0, 'bad=' + noPath)
ck('C3 都以 <svg 开头', noSvgTag === 0, 'bad=' + noSvgTag)

/* ================= D. 体积预算 ================= */

console.log('\n[D] 体积预算')

sizes.sort(function (a, b) { return b.len - a.len })
const maxItem = sizes[0]
const max10 = sizes.slice(0, 10).reduce(function (s, x) { return s + x.len }, 0)

ck('D1 单张不超过 12KB', maxItem.len <= 12 * 1024,
  maxItem.key + ' = ' + maxItem.len + 'B')
ck('D2 最重的 10 张合计不超过 100KB', max10 <= 100 * 1024,
  max10 + 'B (' + Math.round(max10 / 1024) + 'KB)')
console.log('    单张最大 ' + maxItem.len + 'B @ ' + maxItem.key + '，最重 10 张 ' + Math.round(max10 / 1024) + 'KB')

/* ================= E. 缓存 ================= */

console.log('\n[E] 缓存')

const u1 = hs.buildThumb('bob', 'black')
const u2 = hs.buildThumb('bob', 'black')
ck('E1 同一组合命中缓存（同一字符串引用）', u1 === u2)

const u3 = hs.buildThumb('bob', 'chestnut')
ck('E2 换发色是不同 URI', u1 !== u3)

const u4 = hs.buildThumb('wavy', 'black')
ck('E3 换发型是不同 URI', u1 !== u4)

/* ================= F. 非 ASCII 兜底 ================= */

console.log('\n[F] 极端输入不炸')

let fThrew = false
try {
  hs.buildThumb('不存在的发型', '不存在的颜色')
} catch (e) { fThrew = true }
ck('F1 未知 id 不抛异常（回落第一款）', fThrew === false)

const fUri = hs.buildThumb('不存在的发型', '不存在的颜色')
ck('F2 未知 id 也返回合法 URI', fUri.indexOf('data:image/svg+xml') === 0)

let f2Threw = false
try {
  hs.buildThumb(null, undefined)
} catch (e) { f2Threw = true }
ck('F3 null/undefined 不抛异常', f2Threw === false)

/* ================= 汇总 ================= */

console.log('\n' + (fail === 0 ? '缩略图形态：全部通过' : '缩略图形态：' + fail + ' 项失败'))
if (fail) {
  console.log(failures.map(function (f) { return '  - ' + f }).join('\n'))
  process.exit(1)
}
console.log(pass + ' 项通过')
