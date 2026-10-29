// 第 01 轮：镜像必须翻转造型本身，且拍照沿用预览框。
const hs = require('../utils/hairstyles')
let pass = 0, fail = 0
function ck(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' [' + detail + ']' : '')) }
}
function mock() {
  const ops = []
  const grad = { addColorStop() {} }
  const target = {
    ops: ops,
    save() { ops.push(['save']) }, restore() { ops.push(['restore']) },
    translate(x, y) { ops.push(['translate', x, y]) },
    scale(x, y) { ops.push(['scale', x, y]) },
    clearRect() {}, drawImage() { ops.push(['drawImage']) },
    createRadialGradient() { return grad }, createLinearGradient() { return grad }
  }
  return new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key]
      return function () {}
    },
    set(obj, key, value) { obj[key] = value; return true }
  })
}
global.wx = {
  createOffscreenCanvas(o) {
    const c = mock()
    c.width = o.width; c.height = o.height
    c.getContext = () => c
    return c
  }
}
const ctx = mock()
const box = { x: 20, y: 30, w: 160, h: 192, mirror: true }
hs.drawHair(ctx, box, 'ponytail', 'black', 1)
const flipped = ctx.ops.some(o => o[0] === 'scale' && o[1] === -1 && o[2] === 1)
ck('M1 镜像绘制含水平反向', flipped)
const center = ctx.ops.some(o => o[0] === 'translate' && o[1] === 100 && o[2] === 126)
ck('M2 镜像围绕造型中心，不挪位置', center)
const ctx2 = mock()
hs.drawHair(ctx2, { x: 20, y: 30, w: 160, h: 192 }, 'ponytail', 'black', 1)
ck('M3 默认不镜像', !ctx2.ops.some(o => o[0] === 'scale' && o[1] === -1))
const src = require('fs').readFileSync(require('path').join(__dirname, '../pages/tryon/tryon.js'), 'utf8')
ck('M4 拍照映射保留镜像标志', /mapped[\s\S]{0,260}mirror:\s*!!box\.mirror/.test(src))
console.log(fail ? '失败 ' + fail : '全部通过 (' + pass + ')')
process.exit(fail ? 1 : 0)
