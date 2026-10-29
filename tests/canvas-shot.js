// 视觉基准页（真实绘制路径）。
//
// 为什么需要它：小程序里头发是用 Canvas 2D 画的（drawHair → 离屏烘焙 → drawImage），
// 而 shot.js 走的是 buildSvg。两条路径的分档数、图层顺序、混合模式都不一样 ——
// 用 SVG 截图去调 canvas 渲染，等于看着一张降级预览调色，永远调不准。
// 这个页面把真实绘制代码塞进浏览器，用同一张模拟脸，得到的就是用户实际看到的画面。
//
// 用法：
//   node tests/canvas-shot.js [格子宽度] [发色] [发型id]
//   node tests/canvas-shot.js 520 black
//   node tests/canvas-shot.js 900 black curly    # 单款放大细看
const fs = require('fs')
const path = require('path')
const { faceMock } = require('./face-svg')

const root = path.join(__dirname, '..')
const engineSrc = fs.readFileSync(path.join(root, 'utils/hair-engine.js'), 'utf8')
const stylesSrc = fs.readFileSync(path.join(root, 'utils/hairstyles.js'), 'utf8')
const hs = require('../utils/hairstyles')

const cellW = Number(process.argv[2] || 520)
const colorId = process.argv[3] || 'black'
const only = process.argv[4] || ''
// 可选放大框：z:x,y,w,h（设计坐标 200x240 内的一块），用来把发际线之类的
// 细节放大到能看清一根发丝。不传就整张。
const zoomArg = process.argv[5] || ''
const zoom = zoomArg.indexOf('z:') === 0
  ? zoomArg.slice(2).split(',').map(Number)
  : null

// 极简 CommonJS 加载器：把两个模块原样塞进浏览器执行，
// 保证测的就是真代码，不是复制品。
const shim = `
var __defs = {
  'hair-engine': function (module, exports, require) {
${engineSrc}
  },
  'hairstyles': function (module, exports, require) {
${stylesSrc}
  }
};
var __cache = {};
function __req(name) {
  name = String(name).replace(/^\\.\\//, '').replace(/\\.js$/, '');
  if (__cache[name]) return __cache[name].exports;
  var m = { exports: {} };
  __cache[name] = m;
  __defs[name](m, m.exports, __req);
  return m.exports;
}
var hs = __req('hairstyles');
`

// 脸用 SVG 转成 data URI 当底图 —— 和 shot.js 完全同一张脸
const faceUri =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 240" width="200" height="240">${faceMock()}</svg>`
  )

const cards = hs.HAIR_STYLES.filter((s) => !only || s.id === only)
  .map(
    (s) =>
      `<figure><canvas data-id="${s.id}"></canvas><figcaption>${s.name}<i>${s.en}</i></figcaption></figure>`
  )
  .join('')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}
  body{margin:0;background:#0b0b11;color:#efece8;
       font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:20px}
  h1{font-size:13px;letter-spacing:3px;color:#7d7c90;font-weight:500;margin:0 0 14px}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,${cellW}px);gap:14px;justify-content:start}
  figure{margin:0;background:#14141d;border-radius:12px;padding:7px}
  canvas{display:block;width:100%;border-radius:7px}
  figcaption{font-size:11px;color:#b9b7c6;text-align:center;padding-top:6px;letter-spacing:1px}
  figcaption i{color:#5f5e72;font-style:normal;margin-left:6px}
  #report{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#7fe0a6;
          white-space:pre;margin:0 0 16px;line-height:1.5}
</style></head><body>
<div id="report">rendering…</div>
<div id="grid">${cards}</div>
<script>
${shim}

// 用 DOM canvas 冒充小程序的离屏画布，让烘焙分支也走到
var wx = {
  createOffscreenCanvas: function (o) {
    var c = document.createElement('canvas');
    c.width = o.width; c.height = o.height;
    return c;
  }
};

var CELL_W = ${cellW};
var ZOOM = ${JSON.stringify(zoom)};
// 放大时画布按框的宽高比，盒子反向偏移，把框挪到画布原点
var S = ZOOM ? CELL_W / ZOOM[2] : 1;
var BOX = ZOOM
  ? { x: -ZOOM[0] * S, y: -ZOOM[1] * S, w: 200 * S, h: 240 * S }
  : { x: 0, y: 0, w: CELL_W, h: CELL_W * 240 / 200 };
var CELL_H = ZOOM ? Math.round(CELL_W * ZOOM[3] / ZOOM[2]) : Math.round(CELL_W * 240 / 200);
var COLOR = ${JSON.stringify(colorId)};
var lines = [];
function log(s) { lines.push(s); document.getElementById('report').textContent = lines.join('\\n'); }

var faceImg = new Image();
faceImg.onload = function () { render(); };
faceImg.onerror = function () { log('face image failed'); render(); };
faceImg.src = ${JSON.stringify(faceUri)};

function render() {
  var t0 = performance.now();
  var nodes = document.querySelectorAll('canvas[data-id]');
  for (var n = 0; n < nodes.length; n++) {
    var cv = nodes[n];
    var dpr = 2;                       // 模拟真机高像素密度，发丝细节才看得清
    cv.width = CELL_W * dpr;
    cv.height = CELL_H * dpr;
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);

    // 底：柔和的环境光，避免纯黑背景把头发边缘吃掉
    var bg = ctx.createRadialGradient(CELL_W * 0.5, CELL_H * 0.34, 10, CELL_W * 0.5, CELL_H * 0.5, CELL_W * 0.75);
    bg.addColorStop(0, '#2b2b38');
    bg.addColorStop(1, '#111119');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CELL_W, CELL_H);

    // 脸
    ctx.drawImage(faceImg, BOX.x, BOX.y, BOX.w, BOX.h);

    // 头发：第一次调用触发烘焙，之后走 drawImage
    var a = performance.now();
    hs.drawHair(ctx, { x: BOX.x, y: BOX.y, w: BOX.w, h: BOX.h, angle: 0 }, cv.getAttribute('data-id'), COLOR, 1);
    var bake = performance.now() - a;

    var b = performance.now();
    for (var k = 0; k < 6; k++) {
      hs.drawHair(ctx, { x: BOX.x, y: BOX.y, w: BOX.w, h: BOX.h, angle: 0 }, cv.getAttribute('data-id'), COLOR, 1);
    }
    var frame = (performance.now() - b) / 6;

    var geom = hs.getGeom(hs.getStyle(cv.getAttribute('data-id')), 'high');
    log(cv.getAttribute('data-id').padEnd(14) +
        'strands=' + String(geom.body.length).padStart(5) +
        '  edge=' + String(geom.edge.length).padStart(4) +
        '  bake=' + bake.toFixed(0) + 'ms' +
        '  frame=' + frame.toFixed(2) + 'ms');
  }
  log('');
  log('总耗时 ' + (performance.now() - t0).toFixed(0) + 'ms   color=' + COLOR);
  document.title = 'DONE';
}
</script>
</body></html>`

const out = path.join(__dirname, 'canvas-shot.html')
fs.writeFileSync(out, html)
console.log('written', out, Math.round(html.length / 1024) + 'KB')
