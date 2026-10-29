// 验证「索引图 + 快速上色」路径与原始 paint() 路径颜色一致。
// 这条路径是换发色不卡的关键，但如果 tone 编码/查表有偏差，
// 用户会看到发色不对 —— 必须在 canvas 里实测，不能只跑 node。
const fs = require('fs')
const path = require('path')

const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'hair-engine.js'), 'utf8')
const hsSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'hairstyles.js'), 'utf8')
  .replace('module.exports', 'var __exp =')
  // hairstyles.js 尾部有 module.exports，浏览器里会抛错；包一层 try 不影响前面的定义
  .replace('module.exports', 'var __exp =')

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#111;color:#eee;font:12px monospace}
canvas{display:block}
</style></head><body>
<script>${engineSrc}</script>
<script>${hsSrc}</script>
<script>
// 冒充 wx.createOffscreenCanvas
const __made = []
globalThis.wx = {
  createOffscreenCanvas(opts) {
    const c = document.createElement('canvas')
    c.width = opts.width; c.height = opts.height
    __made.push(c)
    return c
  }
}
const H = (typeof module !== 'undefined' && module.exports) || null
// hairstyles.js 是 CommonJS，在浏览器里用 eval 后取全局
const out = []
const styles = HAIR_STYLES.map(s => s.id)
const colors = HAIR_COLORS.map(c => c.id)

// 对每款发型取一个发色，比较两条路径的像素差
function grab(canvas) {
  const ctx = canvas.getContext('2d')
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

let maxDiff = 0, worst = '', n = 0
for (const sid of styles) {
  for (const cid of [colors[0], colors[4], colors[9]]) {
    // 路径 A：完整 paint
    const cA = document.createElement('canvas')
    cA.width = 200; cA.height = 240
    const ctxA = cA.getContext('2d')
    const style = getStyle(sid), color = getColor(cid)
    const geom = getGeom(style, 'high')
    ctxA.scale(3, 3)
    paint(ctxA, geom, color.ramp, 'high')

    // 路径 B：索引图 + tint
    const idx = bakeIndexed(sid)
    if (!idx) { out.push(sid + '/' + cid + ' 索引图失败'); continue }
    const tinted = tintIndexed(idx, color.ramp, geomSheen(style))
    if (!tinted || tinted === idx) { out.push(sid + '/' + cid + ' 上色失败'); continue }

    const cB = document.createElement('canvas')
    cB.width = tinted.width; cB.height = tinted.height
    const ctxB = cB.getContext('2d')
    ctxB.drawImage(tinted, 0, 0)
    const dA = grab(cA), dB = grab(ctxB.canvas)
    // A 是 200x240，B 是 600x720，需缩放比较：把 A 也放大
    const cA2 = document.createElement('canvas')
    cA2.width = 600; cA2.height = 720
    const ctxA2 = cA2.getContext('2d')
    ctxA2.drawImage(cA, 0, 0, 600, 720)
    const dA2 = ctxA2.getImageData(0, 0, 600, 720)

    let sum = 0, cnt = 0
    for (let p = 0; p < dA2.data.length; p += 4) {
      if (dA2.data[p+3] === 0 && dB.data[p+3] === 0) continue
      const dr = Math.abs(dA2.data[p] - dB.data[p])
      const dg = Math.abs(dA2.data[p+1] - dB.data[p+1])
      const db = Math.abs(dA2.data[p+2] - dB.data[p+2])
      sum += (dr + dg + db) / 3; cnt++
    }
    const avg = cnt ? sum / cnt : 0
    n++
    if (avg > maxDiff) { maxDiff = avg; worst = sid + '/' + cid }
    out.push(sid + '/' + cid + ' 平均通道差 ' + avg.toFixed(2))
  }
}
document.title = 'DONE'
// 结果写进 title 和 body，两种方式都能取到
const __txt = '\u6bd4\u8f83 ' + n + ' \u7ec4\n\u6700\u5927\u5e73\u5747\u5dee ' + maxDiff.toFixed(2) + ' @ ' + worst + '\n' + out.join('\n')
document.title = 'DONE'
document.body.textContent = __txt
</html>`

fs.writeFileSync(path.join(__dirname, 'tint-check.html'), html, 'utf8')
console.log('tint-check.html 已生成')
