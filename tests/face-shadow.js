/**
 * 发块投在脸上的阴影（第 52 轮）
 *
 * 这是全项目最难查的一个 bug，因为它伪装成了别的东西。
 *
 * 现象：所有款式的前额都横着一条**纯黑带**，下边缘像被刀切过一样齐。
 * 卷发最明显（发际线刚好落在那里），长直发、bob 上也有，只是被刘海盖住了。
 *
 * 排查过程（走过的弯路）：
 *   1. 以为是发块底色太暗 → 把 fillLift 加上去，黑带纹丝不动
 *   2. 以为是发丝不够密 → 沿发际线加一排碎发，黑带还在
 *   3. 用洋红探针把发块底色染成 #ff00ff → 黑带**没有变洋红**，
 *      说明它不是底色、不是发丝，是上面另有一层把它盖住了
 *   4. 逐层关掉 → 关掉「第 0 层脸部投影」，黑带消失
 *
 * 根因：那层的注释写的是「把形状本体推出画面外，只留下它的影子」，
 * 但代码写成了
 *
 *     ctx.translate(0, 3)
 *     ctx.shadowOffsetX = 6000
 *     ctx.fillStyle = '#000'
 *     ... fill(outline)
 *
 * 也就是**影子**被推到 6000px 之外（等于没有影子），而**形状本体**
 * 留在原地被纯黑实心填了一遍。外面套着「脸部椭圆」的 clip，
 * 于是得到一块「椭圆 ∩ 发块」的纯黑区域 —— 正好是前额那条带。
 *
 * 正确写法是把 ctx 平移 -6000 让形状自己出去，再由 shadowOffsetX=+6000
 * 把影子拉回原位。
 *
 * 这个测试不比对像素，而是用一个会记录变换的假 ctx 跑一遍 paint()，
 * 然后断言：**任何一次纯黑填充，都必须发生在「形状已被推出画布」的
 * 变换下，并且带着一个能把它拉回来的 shadowOffset。**
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

global.wx = { getStorageSync() { return '' }, setStorageSync() {}, removeStorageSync() {} }
if (typeof global.Path2D === 'undefined') global.Path2D = class { moveTo() {} lineTo() {} bezierCurveTo() {} closePath() {} }

const hs = require(path.join(ROOT, 'utils', 'hairstyles'))

/**
 * 记录式假 ctx。
 * 只实现 paint() 真正用到的那部分 API，重点是 fill() 时把
 * 「当前变换 + 当前阴影参数 + 当前 clip」一起记下来。
 */
function makeCtx() {
  let tx = 0
  let ty = 0
  let sx = 1
  let sy = 1
  const stack = []
  let curPath = { hasArc: false, segs: 0 }
  const clips = []
  const fills = []

  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,

    save() { stack.push({ tx: tx, ty: ty, sx: sx, sy: sy }) },
    restore() {
      const s = stack.pop()
      if (s) { tx = s.tx; ty = s.ty; sx = s.sx; sy = s.sy }
    },
    translate(x, y) { tx += x * sx; ty += y * sy },
    scale(x, y) { sx *= x; sy *= y },
    rotate() {},

    beginPath() { curPath = { hasArc: false, segs: 0, arcSx: 1, arcSy: 1 } },
    moveTo() { curPath.segs++ },
    lineTo() { curPath.segs++ },
    bezierCurveTo() { curPath.segs++ },
    quadraticCurveTo() { curPath.segs++ },
    closePath() {},
    // 椭圆是在 translate+scale 之后建的，而 clip() 是在 restore() 之后调的。
    // 所以尺寸必须在 arc() 那一刻记，不能等 clip() 再读当前变换。
    arc() { curPath.hasArc = true; curPath.arcSx = sx; curPath.arcSy = sy },

    clip(mode) {
      clips.push({
        hasArc: curPath.hasArc, segs: curPath.segs, mode: mode || 'nonzero',
        sx: curPath.arcSx, sy: curPath.arcSy
      })
    },

    fill(p) {
      fills.push({
        style: ctx.fillStyle,
        tx: tx,
        ty: ty,
        sx: sx,
        sy: sy,
        shadowColor: ctx.shadowColor,
        shadowBlur: ctx.shadowBlur,
        shadowOffsetX: ctx.shadowOffsetX,
        shadowOffsetY: ctx.shadowOffsetY,
        clip: clips.length ? clips[clips.length - 1] : null
      })
    },
    fillRect(x, y, w, h) { ctx.fill() },
    stroke() {},
    createRadialGradient() { return { addColorStop() {} } },
    createLinearGradient() { return { addColorStop() {} } }
  }
  return { ctx: ctx, fills: fills }
}

/** 从 'rgba(0,0,0,0.30)' 里取出 alpha；不透明色按 1 算 */
function alphaOf(c) {
  if (typeof c !== 'string') return 0
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (!m) return c === '#000' || c === '#000000' ? 1 : 0
  const parts = m[1].split(',').map(function (v) { return v.trim() })
  return parts.length > 3 ? Number(parts[3]) : 1
}

/** 这个填充色是不是「纯黑」 */
function isBlack(s) {
  if (typeof s !== 'string') return false
  const v = s.replace(/\s/g, '').toLowerCase()
  return v === '#000' || v === '#000000' || v === 'black' || v === 'rgba(0,0,0,1)'
}

const STYLES = hs.HAIR_STYLES
const results = []

STYLES.forEach(function (style) {
  const geom = hs.getGeom(style, 'high')
  const rec = makeCtx()
  const ramp = hs.HAIR_COLORS[0].ramp
  hs._paint(rec.ctx, geom, ramp, "high")

  const blacks = rec.fills.filter(function (f) { return isBlack(f.style) })
  const onCanvas = blacks.filter(function (f) { return f.tx > -1000 })

  results.push({
    id: style.id,
    blacks: blacks.length,
    onCanvas: onCanvas.length,
    fills: rec.fills.length,
    shadowFill: blacks.length ? blacks[0] : null
  })
})

/* ================= A. 不许在画布内实心填纯黑 ================= */

console.log('\n[A] 没有「留在原地被纯黑填掉」的层')

results.forEach(function (r, i) {
  ck('A' + (i + 1) + ' ' + r.id + ' 画布内没有纯黑填充',
    r.onCanvas === 0, r.onCanvas + ' 次（共 ' + r.fills + ' 次填充）')
})

/* ================= B. 阴影层本身要正确 ================= */

console.log('\n[B] 阴影层：形状推出去、影子拉回来')

results.forEach(function (r, i) {
  const f = r.shadowFill
  ck('B' + (i + 1) + 'a ' + r.id + ' 存在阴影层', !!f)
  if (!f) return
  ck('B' + (i + 1) + 'b 形状被推出画布（tx ≤ -1000）', f.tx <= -1000, 'tx=' + f.tx)
  ck('B' + (i + 1) + 'c shadowOffsetX 把影子拉回来（≥ 1000）', f.shadowOffsetX >= 1000, String(f.shadowOffsetX))
  // 两个值必须互相抵消，否则影子会偏出画布
  ck('B' + (i + 1) + 'd 推出量与拉回量相等', f.tx + f.shadowOffsetX === 0,
    f.tx + '+' + f.shadowOffsetX + '=' + (f.tx + f.shadowOffsetX))
  ck('B' + (i + 1) + 'e 阴影有颜色（alpha > 0）', alphaOf(f.shadowColor) > 0, f.shadowColor)
  ck('B' + (i + 1) + 'f 阴影有模糊（≥ 12）', f.shadowBlur >= 12, String(f.shadowBlur))
  // blur 必须远大于 offsetY，否则发际线下面会摊成一条实心黑边
  ck('B' + (i + 1) + 'g blur 远大于 offsetY', f.shadowBlur >= f.shadowOffsetY * 3,
    'blur=' + f.shadowBlur + ' offsetY=' + f.shadowOffsetY)
  ck('B' + (i + 1) + 'h 向下偏一点点（0 < offsetY ≤ 6）',
    f.shadowOffsetY > 0 && f.shadowOffsetY <= 6, String(f.shadowOffsetY))
})

/* ================= C. 必须裁在脸部椭圆里 ================= */

console.log('\n[C] 阴影只能落在脸上')

results.forEach(function (r, i) {
  const f = r.shadowFill
  if (!f) { ck('C' + (i + 1) + ' 有阴影层', false); return }
  ck('C' + (i + 1) + 'a 阴影层被 clip 住', !!f.clip)
  ck('C' + (i + 1) + 'b clip 的形状是椭圆（arc 建的）', !!(f.clip && f.clip.hasArc))
  // 脸部椭圆在 paint 里是 translate(100,118) + scale(52,66) + arc(0,0,1)
  ck('C' + (i + 1) + 'c 椭圆尺寸是脸的比例（sx=52, sy=66）',
    !!(f.clip && f.clip.sx === 52 && f.clip.sy === 66),
    f.clip ? f.clip.sx + 'x' + f.clip.sy : 'no clip')
})

/* ================= D. 源码里没有写反 ================= */

console.log('\n[D] 源码形态')

const fs = require('fs')
const src = fs.readFileSync(path.join(ROOT, 'utils', 'hairstyles.js'), 'utf8')
const step0 = src.slice(src.indexOf('0. 发型投在脸上的阴影'), src.indexOf('1. 底层投影'))

ck('D1 有 translate(-6000', /translate\(\s*-6000/.test(step0))
ck('D2 shadowOffsetX 是正的', /shadowOffsetX\s*=\s*6000/.test(step0))
ck('D3 translate(-6000) 出现在 fill 之前',
  step0.indexOf('translate(-6000') > 0 &&
  step0.indexOf('translate(-6000') < step0.lastIndexOf('.fill()'))
ck('D4 注释里记了这段坑（防止有人再改回去）', step0.indexOf('写反') > 0)

console.log('\n----------------------------------------')
console.log('pass ' + pass + ' / fail ' + fail)
if (fail) {
  console.log('失败项：')
  failures.forEach(function (f) { console.log('  - ' + f) })
}
process.exit(fail ? 1 : 0)
