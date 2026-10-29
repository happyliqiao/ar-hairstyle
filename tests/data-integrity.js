/**
 * 发型 / 发色数据完整性校验
 *
 * 这些数据是小程序的「内容资产」，运营后续会改。
 * 一个 id 拼错、一个 fit 越界、一个 swatch 少个 #，
 * 在渲染层可能只是「某个发型看起来怪怪的」，很难定位。
 * 这里把约束固化成断言，改数据时立刻能发现。
 */

const hs = require('../utils/hairstyles')

let pass = 0
let fail = 0
const problems = []

function ck(name, cond, detail) {
  if (cond) pass++
  else {
    fail++
    problems.push(name + (detail ? '  -> ' + detail : ''))
  }
}

/* ---------------- 发型 ---------------- */
const styles = hs.HAIR_STYLES
ck('发型数量为 10', styles.length === 10, '实际 ' + styles.length)

const ids = {}
for (const s of styles) {
  const tag = '[' + (s.id || '?') + ']'
  ck(tag + ' 有 id', typeof s.id === 'string' && s.id.length > 0)
  ck(tag + ' id 唯一', !ids[s.id], '重复: ' + s.id)
  ids[s.id] = true
  ck(tag + ' id 是合法 slug（小写字母/数字/连字符）', /^[a-z][a-z0-9-]*$/.test(s.id || ''), s.id)
  ck(tag + ' 有中文名', typeof s.name === 'string' && s.name.length > 0)
  ck(tag + ' 名称不超过 6 字（卡片宽度限制）', (s.name || '').length <= 6, s.name + ' 共 ' + (s.name || '').length + ' 字')
  ck(tag + ' 有英文名', typeof s.en === 'string' && s.en.length > 0)
  ck(tag + ' 有标签 tag', typeof s.tag === 'string' && s.tag.length > 0)
  ck(tag + ' 有脸型 face', typeof s.face === 'string' && s.face.length > 0)
  ck(tag + ' 有描述 desc', typeof s.desc === 'string' && s.desc.length >= 10, '描述过短')
  ck(tag + ' 描述不超过 60 字（弹层高度）', (s.desc || '').length <= 60, (s.desc || '').length + ' 字')
  ck(tag + ' fit 存在且为数字', typeof s.fit === 'number' && isFinite(s.fit))
  ck(tag + ' fit 在 1.0~2.0 之间', s.fit >= 1.0 && s.fit <= 2.0, 'fit=' + s.fit)
  ck(tag + ' 有 sheen 配置', !!(s.sheen && typeof s.sheen === 'object'), '缺少光泽参数')
}

/* ---------------- 发色 ---------------- */
const colors = hs.HAIR_COLORS
ck('发色数量为 12', colors.length === 12, '实际 ' + colors.length)

const cids = {}
const names = {}
for (const c of colors) {
  const tag = '[color:' + (c.id || '?') + ']'
  ck(tag + ' 有 id', typeof c.id === 'string' && c.id.length > 0)
  ck(tag + ' id 唯一', !cids[c.id], '重复: ' + c.id)
  cids[c.id] = true
  ck(tag + ' 有名称', typeof c.name === 'string' && c.name.length > 0)
  ck(tag + ' 名称唯一', !names[c.name], '重复: ' + c.name)
  names[c.name] = true
  ck(tag + ' 名称不超过 4 字（色带标签宽度）', (c.name || '').length <= 4, c.name)
  ck(tag + ' swatch 是合法十六进制色', /^#[0-9a-fA-F]{6}$/.test(c.swatch || ''), c.swatch)
  ck(tag + ' 有 base 基色', typeof c.base === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.base || ''), c.base)
  ck(tag + ' 有 sheenTint', typeof c.sheenTint === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.sheenTint || ''), c.sheenTint)
  // ramp 是渲染的核心色阶表，任一缺失都会让该发色出现断层的色块
  const RAMP_KEYS = ['shadow', 'deep', 'base', 'mid', 'tip', 'sheen', 'rim', 'swatch']
  ck(tag + ' 有 ramp 色阶表', !!(c.ramp && typeof c.ramp === 'object'))
  if (c.ramp) {
    for (const k of RAMP_KEYS) {
      ck(tag + ' ramp.' + k + ' 是合法色', /^#[0-9a-fA-F]{6}$/.test(c.ramp[k] || ''), c.ramp[k])
    }
    // 色阶必须单调：shadow 最暗 -> rim 最亮，否则头发会出现亮暗颠倒
    const lum = function (hex) {
      const r = parseInt(hex.slice(1, 3), 16)
      const g = parseInt(hex.slice(3, 5), 16)
      const b = parseInt(hex.slice(5, 7), 16)
      return 0.299 * r + 0.587 * g + 0.114 * b
    }
    if (RAMP_KEYS.every(k => /^#[0-9a-fA-F]{6}$/.test(c.ramp[k] || ''))) {
      ck(tag + ' 色阶亮度单调递增（shadow < deep < base < mid < tip）',
        lum(c.ramp.shadow) <= lum(c.ramp.deep) &&
        lum(c.ramp.deep) <= lum(c.ramp.base) &&
        lum(c.ramp.base) <= lum(c.ramp.mid) &&
        lum(c.ramp.mid) <= lum(c.ramp.tip),
        [lum(c.ramp.shadow), lum(c.ramp.deep), lum(c.ramp.base), lum(c.ramp.mid), lum(c.ramp.tip)]
          .map(v => v.toFixed(0)).join(' < '))
      ck(tag + ' 高光比基色亮（rim > base）', lum(c.ramp.rim) > lum(c.ramp.base))
    }
  }
  ck(tag + ' 有 top / bottom 渐变色',
    /^#[0-9a-fA-F]{6}$/.test(c.top || '') && /^#[0-9a-fA-F]{6}$/.test(c.bottom || ''))
}

/* ---------------- 交叉一致性 ---------------- */
// 缩略图对每个 (发型, 发色) 组合都必须能生成
let thumbFail = 0
for (const s of styles) {
  for (const c of colors) {
    try {
      const uri = hs.buildThumb(s.id, c.id)
      if (!uri || uri.indexOf('data:image/svg+xml') !== 0) thumbFail++
    } catch (e) {
      thumbFail++
    }
  }
}
ck('120 个缩略图组合全部可生成', thumbFail === 0, thumbFail + ' 个失败')

// getGeom 三档精度都要能返回
let geomFail = 0
for (const s of styles) {
  for (const detail of ['high', 'mid', 'low']) {
    try {
      const g = hs.getGeom(s, detail)
      if (!g || !g.body || !g.body.length) geomFail++
    } catch (e) {
      geomFail++
    }
  }
}
ck('10 款 x 3 档精度几何全部有效', geomFail === 0, geomFail + ' 个失败')

// 未知 id 必须回退默认而不是崩
ck('getStyle 未知 id 回退默认', hs.getStyle('__nope__').id === styles[0].id)
ck('getColor 未知 id 回退默认', hs.getColor('__nope__').id === colors[0].id)

/* ---------------- 汇总 ---------------- */
console.log('[数据完整性] 通过 ' + pass + ' / ' + (pass + fail))
if (fail > 0) {
  console.log('问题清单:')
  problems.forEach(p => console.log('  - ' + p))
  process.exit(1)
} else {
  console.log('10 款发型 / 12 个发色的数据约束全部满足')
}
