// 在真实浏览器 Canvas 2D 上跑渲染代码，验证小程序实际使用的绘制路径。
// 同时测量离屏烘焙耗时，作为真机性能的参考上界。
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const engineSrc = fs.readFileSync(path.join(root, 'utils/hair-engine.js'), 'utf8')
const stylesSrc = fs.readFileSync(path.join(root, 'utils/hairstyles.js'), 'utf8')

// 极简 CommonJS 加载器，把两个模块塞进浏览器
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

const out = path.join(__dirname, 'canvas-check.html')

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#0d0d14;color:#efece8;font-family:-apple-system,"Segoe UI",sans-serif;padding:16px}
h2{font-size:13px;letter-spacing:2px;color:#8b8a9c;margin:16px 0 8px}
#grid{display:grid;grid-template-columns:repeat(2,420px);gap:12px}
figure{margin:0;background:#15151e;border-radius:10px;padding:6px}
canvas{display:block;width:420px;height:504px;border-radius:6px;background:radial-gradient(circle at 50% 35%,#2a2a36,#14141c 70%)}
figcaption{font-size:11px;color:#b9b7c6;text-align:center;padding-top:4px}
#report{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#8ee6b0;white-space:pre;margin:10px 0}
</style></head><body>
<div id="report">running...</div>
<div id="grid"></div>
<script>
${shim}

// 用 DOM canvas 冒充小程序的离屏画布，这样烘焙分支也能被测到
var wx = {
  createOffscreenCanvas: function (o) {
    var c = document.createElement('canvas');
    c.width = o.width; c.height = o.height;
    return c;
  }
};

var lines = [];
function log(s) { lines.push(s); document.getElementById('report').textContent = lines.join('\\n'); }

// 画一张脸垫在下面，判断合成是否正常
function drawFace(ctx, W, H) {
  var s = W / 200;
  ctx.save();
  ctx.scale(s, s);
  var g = ctx.createRadialGradient(84, 70, 10, 100, 118, 90);
  g.addColorStop(0, '#f3d9be');
  g.addColorStop(0.5, '#e2bf9d');
  g.addColorStop(1, '#b98d68');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(100, 48);
  ctx.bezierCurveTo(131, 48, 153, 74, 153, 112);
  ctx.bezierCurveTo(153, 152, 131, 190, 100, 190);
  ctx.bezierCurveTo(69, 190, 47, 152, 47, 112);
  ctx.bezierCurveTo(47, 74, 69, 48, 100, 48);
  ctx.fill();
  // 眼睛
  ctx.fillStyle = '#fbf7f2';
  ctx.beginPath(); ctx.ellipse(83, 121, 9, 5.2, 0, 0, 6.2832); ctx.fill();
  ctx.beginPath(); ctx.ellipse(117, 121, 9, 5.2, 0, 0, 6.2832); ctx.fill();
  ctx.fillStyle = '#4e3620';
  ctx.beginPath(); ctx.arc(83, 121, 4.6, 0, 6.2832); ctx.fill();
  ctx.beginPath(); ctx.arc(117, 121, 4.6, 0, 6.2832); ctx.fill();
  ctx.fillStyle = '#16100a';
  ctx.beginPath(); ctx.arc(83, 121, 2.1, 0, 6.2832); ctx.fill();
  ctx.beginPath(); ctx.arc(117, 121, 2.1, 0, 6.2832); ctx.fill();
  // 眉
  ctx.strokeStyle = '#6b4a33'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(72, 111); ctx.quadraticCurveTo(83, 105, 94, 110); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(106, 110); ctx.quadraticCurveTo(117, 105, 128, 111); ctx.stroke();
  // 嘴
  ctx.fillStyle = '#b46a63';
  ctx.beginPath();
  ctx.moveTo(88, 166); ctx.quadraticCurveTo(100, 160, 112, 166);
  ctx.quadraticCurveTo(100, 173, 88, 166); ctx.fill();
  ctx.restore();
}

var W = 520, H = 624;
var grid = document.getElementById('grid');
var t0 = performance.now();

hs.HAIR_STYLES.forEach(function (style, idx) {
  var fig = document.createElement('figure');
  var cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  var cap = document.createElement('figcaption');
  cap.textContent = style.name + '  ' + style.en;
  fig.appendChild(cv); fig.appendChild(cap);
  grid.appendChild(fig);

  var ctx = cv.getContext('2d');
  drawFace(ctx, W, H);

  // 第一次调用会触发离屏烘焙
  var a = performance.now();
  hs.drawHair(ctx, { x: 0, y: 0, w: W, h: H, angle: 0 }, style.id, 'black', 1);
  var bake = performance.now() - a;

  // 第二次走 drawImage 快路径
  var b = performance.now();
  for (var i = 0; i < 10; i++) {
    hs.drawHair(ctx, { x: 0, y: 0, w: W, h: H, angle: 0 }, style.id, 'black', 1);
  }
  var frame = (performance.now() - b) / 10;

  var geom = hs.getGeom(style, 'high');
  log(style.id.padEnd(15) +
      'strands=' + String(geom.body.length).padStart(4) +
      '  bake=' + bake.toFixed(1) + 'ms' +
      '  frame=' + frame.toFixed(2) + 'ms');
});

log('');
log('总耗时 ' + (performance.now() - t0).toFixed(0) + 'ms');
log('缩略图 ' + hs.buildThumb('bob', 'black').length + ' bytes');
document.title = 'DONE';
</script>
</body></html>`

fs.writeFileSync(out, html, 'utf8')
console.log('written', out, (html.length / 1024).toFixed(0) + 'KB')
