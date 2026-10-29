// 生成可视化检查页：把高精度发型渲染到模拟脸部上，供 Chrome headless 截图
const fs = require('fs')
const path = require('path')
const hs = require('../utils/hairstyles')

const out = path.join(__dirname, 'shot.html')
const scale = Number(process.argv[2] || 300) // 每个格子的显示宽度
const cols = Number(process.argv[3] || 2)
const only = process.argv[4] || '' // 只渲染指定发型（放大细看用）

const { faceMock } = require('./face-svg')

function cell(style, colorId) {
  const svg = hs.buildSvg(style.id, colorId, 'high')
    .replace('width="200" height="240"', 'width="100%" height="100%"')
    // 用真实感的脸替换掉原来那个只作位置参考的淡椭圆
    .replace(/<ellipse cx="100" cy="118" rx="57" ry="73" fill="#c8ab93" opacity="0.11"\/>/, faceMock())
  return `<figure><div class="art">${svg}</div><figcaption>${style.name}<i>${style.en}</i></figcaption></figure>`
}

let cards = ''
hs.HAIR_STYLES.forEach(function (s) {
  if (only && s.id !== only) return
  cards += cell(s, 'black')
})

// 第二组：同一款发型换 6 种发色，检查色板推导是否合理
let colorRow = ''
;['black', 'chestnut', 'honey', 'rosegold', 'ashpurple', 'silver'].forEach(function (cid) {
  const s = hs.getStyle(only || 'bob')
  colorRow += cell(s, cid)
})

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;background:#0d0d14;color:#efece8;font-family:-apple-system,"Segoe UI",sans-serif;padding:20px}
h2{font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#8b8a9c;margin:22px 0 10px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(${cols},${scale}px);gap:14px}
figure{margin:0;background:linear-gradient(180deg,#181822,#12121a);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:8px}
.art{width:100%;aspect-ratio:200/240;border-radius:8px;overflow:hidden;background:radial-gradient(circle at 50% 35%,#2a2a36,#14141c 70%)}
.art svg{display:block;width:100%;height:100%}
figcaption{font-size:11px;color:#b9b7c6;text-align:center;margin-top:6px}
figcaption i{display:block;font-style:normal;font-size:9px;color:#6f6d80;letter-spacing:1px;margin-top:1px}
</style></head><body>
<h2>发型 · 自然黑</h2>
<div class="grid">${cards}</div>
<h2>同一款 · 6 种发色</h2>
<div class="grid">${colorRow}</div>
</body></html>`

fs.writeFileSync(out, html, 'utf8')
console.log('written', out, (html.length / 1024).toFixed(0) + 'KB')
