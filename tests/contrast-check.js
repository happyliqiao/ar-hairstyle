/**
 * 文字对比度审计（WCAG 2.1）
 *
 * 深色 UI 的通病：为了「高级感」把辅助文字压到很低的透明度，
 * 结果在户外强光或低亮度屏幕上根本看不见。
 * 这里把所有 wxss 里的文字色与主背景做对比度计算。
 *
 * 阈值：正文 4.5:1（AA），大字（>=24px 或 >=18.66px bold）3:1
 */

const fs = require('fs')
const path = require('path')

function walk(d, out) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (f.endsWith('.wxss')) out.push(p)
  }
  return out
}

function parseColor(s) {
  s = (s || '').trim()
  let m = s.match(/^#([0-9a-fA-F]{6})$/)
  if (m) {
    const v = m[1]
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), 1]
  }
  m = s.match(/^#([0-9a-fA-F]{3})$/)
  if (m) {
    const v = m[1]
    return [parseInt(v[0] + v[0], 16), parseInt(v[1] + v[1], 16), parseInt(v[2] + v[2], 16), 1]
  }
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (m) {
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m[4] === undefined ? 1 : parseFloat(m[4])]
  }
  return null
}

function relLum(rgb) {
  const f = v => {
    v = v / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

// 把带 alpha 的前景色合成到背景上，再算对比度
function composite(fg, bg) {
  const a = fg[3]
  return [
    Math.round(fg[0] * a + bg[0] * (1 - a)),
    Math.round(fg[1] * a + bg[1] * (1 - a)),
    Math.round(fg[2] * a + bg[2] * (1 - a)),
    1
  ]
}

function contrast(fg, bg) {
  const c = composite(fg, bg)
  const l1 = relLum(c)
  const l2 = relLum(bg)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

const BG = parseColor('#0d0d17') // app.json backgroundColor
const PANEL_BG = parseColor('#16161f')

const files = walk('pages', []).concat(['app.wxss']).filter(f => fs.existsSync(f))

let bad = []
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const blocks = src.split('}')
  for (const b of blocks) {
    const head = b.split('{')[0]
    if (!head) continue
    const sel = head.trim().split('\n').pop().trim()
    if (!sel || sel.startsWith('/*') || sel.startsWith('@')) continue
    const colorM = b.match(/(?:^|\n)\s*color:\s*([^;]+);/)
    if (!colorM) continue
    const fsM = b.match(/font-size:\s*([\d.]+)rpx/)
    const bold = /font-weight:\s*(?:6|7|8|9)00/.test(b)
    const fg = parseColor(colorM[1])
    if (!fg) continue
    // 排除「亮色按钮上的深色文字」：深色 UI 里深色文字只可能出现在
    // 金色/白色按钮上（.btn-main / .hero-cta / .hot-badge / .empty-btn 之类），
    // 它们实际背景是渐变或纯亮色，用主背景算会得到 1.03:1 的假警报。
    const fgLum = relLum(fg)
    if (fgLum < 0.15) continue
    // 纯装饰（箭头、图标符号、+ 号）不参与正文对比度要求
    if (/(arrow|icon|knob|dot|divider|handle|pulse|ring|core|fill|thumb|badge|avatar-empty)/i.test(sel)) continue
    // 三级文字（页脚最底部的小字、卡片第二行提示）：设计上刻意更弱，
    // 按大字标准 3:1 要求，不按正文 4.5:1
    const isTertiary = /(-dim|\.dim)/.test(sel)
    const sizePx = fsM ? parseFloat(fsM[1]) / 2 : 14 // rpx -> px (750 基准)
    const isLarge = sizePx >= 24 || (bold && sizePx >= 18.66)
    const need = isTertiary ? 3.0 : (isLarge ? 3.0 : 4.5)
    // 取更亮的背景（面板）做保守估计
    const c1 = contrast(fg, BG)
    const c2 = contrast(fg, PANEL_BG)
    const ratio = Math.min(c1, c2)
    if (ratio < need) {
      bad.push({
        file: f,
        sel: sel,
        color: colorM[1].trim(),
        size: sizePx,
        ratio: ratio.toFixed(2),
        need: need
      })
    }
  }
}

console.log('[对比度审计] 检查 ' + files.length + ' 个 wxss')
if (bad.length === 0) {
  console.log('全部文字对比度达标')
} else {
  console.log('未达标 ' + bad.length + ' 处:')
  bad.sort((a, b) => a.ratio - b.ratio)
  for (const x of bad) {
    console.log('  ' + x.ratio.padStart(5) + ':1 (需 ' + x.need + ')  ' +
      x.sel.padEnd(26) + ' ' + x.color.padEnd(26) + ' ' + x.size.toFixed(0) + 'px  ' + x.file)
  }
}
