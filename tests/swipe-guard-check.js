/**
 * utils/swipe-guard.js 单元测试（第 6 轮）
 *
 * 背景：scroll-view 横滑后抬指仍会派发 tap，用户「滚动看一下」
 * 会变成「切换发型 / 打开详情」。这个共享模块在 tryon / index /
 * profile 三处横滑列表上使用，状态机必须可靠。
 */

const swipe = require('../utils/swipe-guard')

function ev(x) {
  return { touches: [{ x: x, clientX: x }] }
}

let pass = 0
let fail = 0
function ck(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name) }
}

console.log('[swipe-guard 状态机]')

let st = swipe.create()
swipe.start(ev(100), st); swipe.move(ev(103), st)
ck('位移 3px（抖动）不判为滑动', !swipe.consume(st))

swipe.start(ev(100), st); swipe.move(ev(140), st)
ck('位移 40px 判为滑动', swipe.consume(st))
ck('consume 后标志自动复位', !swipe.consume(st))

const st2 = swipe.create()
swipe.move(ev(200), st2)
ck('未 start 就 move 不崩溃', st2.moved === false)

swipe.start({ touches: [] }, st2)
ck('start 时空 touches 不崩溃', st2.x === null)

swipe.start(ev(50), st2); swipe.move({ touches: [] }, st2)
ck('move 时空 touches 不崩溃', st2.moved === false)

swipe.start(ev(50), st2); swipe.move(ev(57), st2)
ck('超过阈值 6px 判为滑动', swipe.consume(st2))

swipe.start(ev(50), st2); swipe.move(ev(55), st2)
ck('5px 不判为滑动', !swipe.consume(st2))

swipe.start(ev(50), st2); swipe.move(ev(43), st2)
ck('向左滑 7px 同样判为滑动', swipe.consume(st2))

/* ---------- touchcancel：被来电/通知/系统手势打断 ---------- */
;(function () {
  const st3 = swipe.create()
  swipe.start(ev(100), st3)
  swipe.move(ev(160), st3)          // 已经判为滑动
  swipe.cancel(st3)                  // 系统打断
  ck('cancel 后状态复位（x 清空）', st3.x === null)
  ck('cancel 后 moved 复位', st3.moved === false)
  ck('cancel 之后的下一次点击不会被吞', !swipe.consume(st3))

  // 不 cancel 的对照：下一次点击会被吞掉一次 —— 这就是要修的 bug
  const st4 = swipe.create()
  swipe.start(ev(100), st4)
  swipe.move(ev(160), st4)
  ck('（对照）不 cancel 时下一次点击被吞', swipe.consume(st4))

  // cancel 传 null 不崩
  let threw = false
  try { swipe.cancel(null) } catch (e) { threw = true }
  ck('cancel(null) 不抛异常', !threw)
})()

console.log('========================================')
console.log('通过 ' + pass + ' / ' + (pass + fail))
if (fail > 0) process.exit(1)
