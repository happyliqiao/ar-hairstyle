/**
 * 营业时间解析测试
 *
 * 这段逻辑只影响首页一个小标签，但它决定「顾客照着小程序来店会不会吃闭门羹」。
 * 错的代价很高，所以边界要一条条钉住。
 */
const path = require('path')
const shopHours = require(path.resolve(__dirname, '../utils/shop-hours.js'))
const calc = shopHours.calcOpenState

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) pass++
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')) }
}

function at(h, m) {
  const d = new Date(2026, 9, 23, h, m, 0)
  return d
}

/* ---------- 1 普通营业时间 10:00 - 22:00 ---------- */
;(function () {
  const H = '10:00 - 22:00'
  ok('[1] 09:59 未营业', calc(H, at(9, 59)).open === false)
  ok('[1] 10:00 刚开门算营业', calc(H, at(10, 0)).open === true)
  ok('[1] 15:30 营业中', calc(H, at(15, 30)).open === true)
  ok('[1] 21:59 仍营业', calc(H, at(21, 59)).open === true)
  ok('[1] 22:00 打烊（不含端点）', calc(H, at(22, 0)).open === false)
  ok('[1] 23:00 已休息', calc(H, at(23, 0)).open === false)
  ok('[1] 00:30 已休息', calc(H, at(0, 30)).open === false)
})()

/* ---------- 2 提示文案 ---------- */
;(function () {
  const H = '10:00 - 22:00'
  const open = calc(H, at(15, 0))
  ok('[2] 营业中提示打烊时间', open.hint === '22:00 打烊', open.hint)
  const closed = calc(H, at(8, 0))
  ok('[2] 未营业提示开门时间', closed.hint === '10:00 开门', closed.hint)
  ok('[2] startText 正确', open.startText === '10:00', open.startText)
  ok('[2] endText 正确', open.endText === '22:00', open.endText)
})()

/* ---------- 3 跨夜 18:00 - 02:00 ---------- */
;(function () {
  const H = '18:00 - 02:00'
  ok('[3] 17:59 未营业', calc(H, at(17, 59)).open === false)
  ok('[3] 18:00 开门', calc(H, at(18, 0)).open === true)
  ok('[3] 23:30 营业中', calc(H, at(23, 30)).open === true)
  ok('[3] 00:30 仍在营业（跨夜）', calc(H, at(0, 30)).open === true)
  ok('[3] 01:59 仍营业', calc(H, at(1, 59)).open === true)
  ok('[3] 02:00 打烊', calc(H, at(2, 0)).open === false)
  ok('[3] 12:00 已休息', calc(H, at(12, 0)).open === false)
  ok('[3] 跨夜时提示仍说 02:00 打烊', calc(H, at(23, 0)).hint === '02:00 打烊', calc(H, at(23, 0)).hint)
})()

/* ---------- 4 各种连接符写法 ---------- */
;(function () {
  const forms = [
    '10:00 - 22:00',
    '10:00-22:00',
    '10:00—22:00',
    '10:00~22:00',
    '10:00～22:00',
    '10:00 至 22:00',
    '10:00至22:00'
  ]
  forms.forEach(function (h) {
    const r = calc(h, at(15, 0))
    ok('[4] 能解析「' + h + '」', !!r && r.open === true, JSON.stringify(r))
  })
})()

/* ---------- 5 单位数小时 ---------- */
;(function () {
  const r = calc('9:00 - 21:30', at(9, 30))
  ok('[5] 单位数小时能解析', !!r && r.open === true)
  ok('[5] 补零输出', r.startText === '09:00' && r.endText === '21:30', r.startText + '/' + r.endText)
})()

/* ---------- 6 24 小时 / 全天 ---------- */
;(function () {
  const r = calc('00:00 - 00:00', at(3, 0))
  ok('[6] 00:00 - 00:00 视为 24 小时营业', !!r && r.open === true, JSON.stringify(r))
})()

/* ---------- 7 非法输入一律返回 null ---------- */
;(function () {
  const bad = [
    ['空串', ''],
    ['null', null],
    ['数字', 12345],
    ['没有时间', '每天营业'],
    ['缺分钟', '10 - 22'],
    ['分钟越界 60', '10:60 - 22:00'],
    ['小时越界 25', '25:00 - 26:00'],
    ['只有开始时间', '10:00 开始'],
    ['乱码', 'abc']
  ]
  bad.forEach(function (c) {
    let r = null
    let threw = false
    try { r = calc(c[1], at(12, 0)) } catch (e) { threw = true }
    ok('[7 ' + c[0] + '] 不抛异常', !threw)
    ok('[7 ' + c[0] + '] 返回 null', r === null, JSON.stringify(r))
  })
})()

/* ---------- 8 不传 now 时用当前时间，且不抛异常 ---------- */
;(function () {
  let r = null
  let threw = false
  try { r = calc('00:00 - 23:59') } catch (e) { threw = true }
  ok('[8] 不传 now 不抛异常', !threw)
  ok('[8] 不传 now 返回有效结果', !!r && typeof r.open === 'boolean')
})()

/* ---------- 9 分钟精度 ---------- */
;(function () {
  const H = '10:00 - 22:00'
  ok('[9] 21:59 营业', calc(H, at(21, 59)).open === true)
  ok('[9] 22:00 不营业', calc(H, at(22, 0)).open === false)
  const H2 = '10:30 - 21:45'
  ok('[9] 10:29 未营业', calc(H2, at(10, 29)).open === false)
  ok('[9] 10:30 营业', calc(H2, at(10, 30)).open === true)
  ok('[9] 21:44 营业', calc(H2, at(21, 44)).open === true)
  ok('[9] 21:45 不营业', calc(H2, at(21, 45)).open === false)
})()

console.log('')
console.log('[营业时间解析] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  9 组：普通时段 / 提示文案 / 跨夜 / 7 种连接符 / 单位数小时 / 24h / 非法输入 / 默认时间 / 分钟精度')
}
