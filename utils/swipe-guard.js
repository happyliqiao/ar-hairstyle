/**
 * 横滑列表的「滑动 vs 点击」判定（共享模块）
 *
 * 问题背景：scroll-view 的横滑在手指抬起时会照样向子节点派发 tap。
 * 用户只是想滚动看一眼列表，抬指时若正好落在某张卡片上，
 * 就会触发卡片的 bindtap —— 「看一下」变成了「切换发型/打开详情」。
 *
 * 用法：
 *   const swipe = require('../../utils/swipe-guard')
 *   // onLoad 里：this._swipe = swipe.create()
 *   // wxml 里：<scroll-view catchtouchstart="onXStart" catchtouchmove="onXMove">
 *   onXStart(e) { swipe.start(e, this._swipe) },
 *   onXMove(e)   { swipe.move(e, this._swipe) },
 *   openX(e)     { if (swipe.consume(this._swipe)) return; 这里写真正的点击逻辑 }
 *
 * 阈值 6px：小于它视为手指抖动（仍算点击），大于它视为滚动。
 */

const THRESHOLD = 6

function pointOf(e) {
  const t = e && e.touches && e.touches[0]
  if (!t) return null
  const x = typeof t.x === 'number' ? t.x : t.clientX
  if (typeof x !== 'number') return null
  return x
}

function create() {
  return { x: null, moved: false }
}

function start(e, st) {
  const x = pointOf(e)
  if (x == null) return false
  st.x = x
  st.moved = false
  return true
}

function move(e, st) {
  if (st.x == null) return
  const x = pointOf(e)
  if (x == null) return
  if (Math.abs(x - st.x) > THRESHOLD) st.moved = true
}

/**
 * 在 tap 处理函数开头调用。返回 true 表示这次 tap 是横滑误触，
 * 调用方应直接 return 放弃处理。
 */
function consume(st) {
  if (st.moved) {
    st.moved = false
    return true
  }
  return false
}

/**
 * 触摸被系统打断（来电、消息横幅、下拉通知栏、系统返回手势）。
 *
 * 这条路径不接住的话会留一个很讨厌的尾巴：
 * 用户横滑到一半被打断 → touchcancel 触发，但 moved 还停在 true，
 * 而 consume 只在「点击」时才被调用。于是下一次真正的点击会被当成
 * 「刚才那次滑动的收尾」吃掉 —— 表现为「点一次没反应，要点第二次」。
 * 用户根本不会联想到几秒钟前那次被打断的滑动。
 */
function cancel(st) {
  if (!st) return
  st.x = null
  st.moved = false
}

module.exports = {
  create: create,
  start: start,
  move: move,
  consume: consume,
  cancel: cancel,
  THRESHOLD: THRESHOLD
}
