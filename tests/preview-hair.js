// 生成发型预览页，用于在浏览器里检查矢量路径是否正确
const fs = require('fs')
const path = require('path')
const hs = require('../utils/hairstyles')

const out = path.join(__dirname, 'preview.html')

let cards = ''
hs.HAIR_STYLES.forEach(function (s) {
  let row = ''
  ;['black', 'chestnut', 'honey', 'rosegold', 'silver', 'sakura'].forEach(function (cid) {
    // 缩略图 URI 现在是 base64 形态，不能再靠字符串截断取 SVG 原文，
    // 直接调 buildSvg 拿同一份源码
    const svg = hs.buildSvg(s.id, cid, 'low')
    row +=
      '<div class="cell"><img src="' +
      hs.buildThumb(s.id, cid) +
      '" width="140" height="168" alt=""/><span>' +
      hs.getColor(cid).name +
      '</span></div>'
  })
  cards +=
    '<div class="card"><div class="head"><b>' +
    s.name +
    '</b><i>' +
    s.en +
    '</i></div><div class="row">' +
    row +
    '</div></div>'
})

const html =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'body{margin:0;background:#0b0b12;color:#f2f0ee;font-family:-apple-system,"Segoe UI",sans-serif;padding:24px}' +
  '.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}' +
  '.card{background:#16161f;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px}' +
  '.head{margin-bottom:10px}.head b{font-size:18px}.head i{font-size:11px;color:#7a7a8c;margin-left:8px;letter-spacing:1px;font-style:normal;text-transform:uppercase}' +
  '.row{display:flex;gap:6px}' +
  '.cell{display:flex;flex-direction:column;align-items:center;background:#101018;border-radius:10px;padding:6px 4px}' +
  '.cell span{font-size:10px;color:#8e8d9c;margin-top:2px}' +
  '</style></head><body><div class="grid">' +
  cards +
  '</div></body></html>'

fs.writeFileSync(out, html, 'utf8')
console.log('written', out)
