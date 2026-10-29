// PNG 像素探针。
//
// 为什么需要它：调渲染只能靠截图，而「这块为什么是黑的」靠眼睛判断
// 经常猜错 —— 本轮的黑色发际线带就先后误判过发块底色、柔光阴影、
// 底层投影三层，最后靠洋红染色 + 逐像素采样才定位。
// 有了这个工具，可以直接读出某条竖线上的 RGB，不用再猜。
//
// 用法：
//   node tests/px.js <png> line <x> <y0> <y1> [step]     # 竖线采样
//   node tests/px.js <png> hline <y> <x0> <x1> [step]    # 横线采样
//   node tests/px.js <png> area <x0> <y0> <x1> <y1>      # 区域统计
//
// 只支持 8 位深、非隔行的 PNG（Chrome 截图满足）。
const fs = require('fs')
const zlib = require('zlib')

function decode(file) {
  const buf = fs.readFileSync(file)
  let p = 8
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.slice(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      ctype = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    p += 12 + len
  }
  if (depth !== 8) throw new Error('只支持 8 位深，实际 ' + depth)
  if (interlace) throw new Error('不支持隔行 PNG')
  const ch = ctype === 6 ? 4 : (ctype === 2 ? 3 : (ctype === 0 ? 1 : 0))
  if (!ch) throw new Error('不支持的颜色类型 ' + ctype)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  let prev = Buffer.alloc(stride)
  let rp = 0
  for (let y = 0; y < h; y++) {
    const f = raw[rp++]
    const cur = raw.slice(rp, rp + stride)
    rp += stride
    const line = out.slice(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0
      const b = prev[i]
      const c = i >= ch ? prev[i - ch] : 0
      let v = cur[i]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      line[i] = v & 255
    }
    prev = line
  }
  return { w, h, ch, data: out }
}

const px = (img, x, y) => {
  const i = (y * img.w + x) * img.ch
  return [img.data[i], img.data[i + 1], img.data[i + 2]]
}
const lum = (c) => Math.round(c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114)

const [, , file, mode, ...rest] = process.argv
const img = decode(file)
const n = rest.map(Number)

if (mode === 'line') {
  const [x, y0, y1, step = 4] = n
  console.log('x=' + x + '  ' + file)
  for (let y = y0; y <= y1; y += step) {
    const c = px(img, x, y)
    console.log('  y=' + String(y).padStart(4) + '  rgb(' + c.join(',') + ')  L=' + lum(c))
  }
} else if (mode === 'hline') {
  const [y, x0, x1, step = 10] = n
  console.log('y=' + y + '  ' + file)
  for (let x = x0; x <= x1; x += step) {
    const c = px(img, x, y)
    console.log('  x=' + String(x).padStart(4) + '  rgb(' + c.join(',') + ')  L=' + lum(c))
  }
} else if (mode === 'area') {
  const [x0, y0, x1, y1] = n
  let min = 999, max = -1, sum = 0, cnt = 0
  const hist = new Array(16).fill(0)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const L = lum(px(img, x, y))
      if (L < min) min = L
      if (L > max) max = L
      sum += L
      cnt++
      hist[Math.min(15, L >> 4)]++
    }
  }
  console.log('area (' + x0 + ',' + y0 + ')-(' + x1 + ',' + y1 + ')')
  console.log('  min=' + min + ' max=' + max + ' avg=' + (sum / cnt).toFixed(1) + ' n=' + cnt)
  console.log('  直方图(每格 16 级): ' + hist.join(' '))
} else {
  console.log('用法见文件头注释')
}
