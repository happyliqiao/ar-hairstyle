/* setData 载荷审计：统计每个页面每次 setData 实际传输的字节数 */
const fs = require('fs')

function bytesOf(v) {
  return Buffer.byteLength(JSON.stringify(v), 'utf8')
}

const hs = require('../utils/hairstyles')

// 模拟 tryon onLoad 的 setData
const styles = hs.HAIR_STYLES.map(s => ({
  id: s.id, name: s.name, thumb: hs.buildThumb(s.id, 'chestnut')
}))
const colors = hs.HAIR_COLORS

const cases = [
  ['tryon.onLoad（首次进入）', {
    statusBarHeight: 20, safeBottom: 0, isDevtools: false, statusText: '正在启动…',
    styles: styles, colors: colors, currentStyle: 'bob', currentStyleName: '波波头',
    currentTag: '', currentColor: 'chestnut', currentColorName: '栗棕', isFav: false
  }],
  ['tryon.pickColor（换发色，第15轮加的缩略图重建）', { styles: styles }],
  ['tryon.pickStyle（换发型）', {
    currentStyle: 'bob', currentStyleName: '波波头', currentTag: '经典',
    isFav: false, sizeVal: 100, yVal: 46, rotVal: 0
  }],
  ['gallery.buildList（换预览色）', {
    styles: hs.HAIR_STYLES.map(s => ({
      id: s.id, name: s.name, tag: s.tag, face: s.face, fav: false,
      thumb: hs.buildThumb(s.id, 'black')
    })),
    previewColor: 'black'
  }],
  ['index.onLoad', {
    shop: { name: '镜界造型', branch: '静安旗舰店', address: '南京西路 1266 号 3F', phone: '021-6288-8899', hours: '10:00 - 22:00' },
    topPad: 32, styleCount: 10, colorCount: 12,
    hot: hs.HAIR_STYLES.slice(0, 6).map(s => ({
      id: s.id, name: s.name, tag: s.tag, face: s.face, thumb: hs.buildThumb(s.id, 'black')
    })),
    colors: colors, shopOpen: { open: true }
  }],
  ['history.refresh（20 条记录）', {
    records: Array.from({ length: 20 }, (_, i) => ({
      id: 'r' + i, styleId: 'bob', colorId: 'black', styleName: '波波头',
      colorName: '自然黑', photoPath: 'store://xxxxx' + i + '.jpg',
      swatch: '#1b1a21', timeText: '今天 14:30'
    }))
  }]
]

console.log('setData 载荷审计（单张缩略图 ' +
  (bytesOf(styles[0].thumb) / 1024).toFixed(1) + ' KB）')
console.log('')
let worst = 0
for (const [name, payload] of cases) {
  const kb = bytesOf(payload) / 1024
  if (kb > worst) worst = kb
  // 小程序 setData 经验阈值：>64KB 明显可感卡顿，>128KB 会掉帧
  const flag = kb > 128 ? '  严重' : (kb > 64 ? '  偏高' : '')
  console.log('  ' + kb.toFixed(1).padStart(7) + ' KB  ' + name + flag)
}
console.log('')
console.log('最大载荷 ' + worst.toFixed(1) + ' KB')
