/**
 * 几何缓存的内存上限
 *
 * 单款 high 精度几何实测约 2.2MB（600 条发丝 × 每条几十个贝塞尔控制点）。
 * 10 款全缓存是 21.8MB，再叠上 5 张烘焙画布的 8.6MB，
 * 光「把 10 款都看一遍」就能吃掉低端机三成可用内存，
 * 表现为来回切几轮之后小程序被系统回收（自己重启）。
 *
 * 这里用「对象身份」验证 LRU 真的在淘汰，而不是靠内存读数
 * （内存读数受 GC 时机影响，跑十次能出十个数）。
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) pass++
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')) }
}

function fresh() {
  const abs = path.join(ROOT, 'utils/hairstyles.js')
  delete require.cache[require.resolve(abs)]
  return require(abs)
}

/* ---------- 1 同一款连续取两次拿到同一个对象（缓存生效） ---------- */
;(function () {
  const hs = fresh()
  const s = hs.HAIR_STYLES[0]
  const a = hs.getGeom(s, 'high')
  const b = hs.getGeom(s, 'high')
  ok('[1] 同款 high 命中缓存（同一对象）', a === b)
})()

/* ---------- 2 依次取 10 款后，最早的已被淘汰 ---------- */
;(function () {
  const hs = fresh()
  const all = hs.HAIR_STYLES
  const first = hs.getGeom(all[0], 'high')
  // 把剩下 9 款都取一遍（high 上限是 4）
  for (let i = 1; i < all.length; i++) hs.getGeom(all[i], 'high')

  const firstAgain = hs.getGeom(all[0], 'high')
  ok('[2] 最早那款已被淘汰（重新算出新对象）', first !== firstAgain,
    '仍然命中缓存说明 LRU 没生效')

  // 最后取的 4 款应该还在
  const last = all[all.length - 1]
  const l1 = hs.getGeom(last, 'high')
  const l2 = hs.getGeom(last, 'high')
  ok('[2] 最近用过的仍在缓存', l1 === l2)
})()

/* ---------- 3 mid / low 不受 high 的 LRU 影响 ---------- */
;(function () {
  const hs = fresh()
  const all = hs.HAIR_STYLES
  const mids = []
  const lows = []
  for (let i = 0; i < all.length; i++) {
    mids.push(hs.getGeom(all[i], 'mid'))
    lows.push(hs.getGeom(all[i], 'low'))
  }
  // 中间插入大量 high 访问，把 high 的 LRU 撑满
  for (let i = 0; i < all.length; i++) hs.getGeom(all[i], 'high')

  let midHit = 0
  let lowHit = 0
  for (let i = 0; i < all.length; i++) {
    if (hs.getGeom(all[i], 'mid') === mids[i]) midHit++
    if (hs.getGeom(all[i], 'low') === lows[i]) lowHit++
  }
  ok('[3] 10 款 mid 几何全部仍在缓存', midHit === all.length, midHit + '/' + all.length)
  ok('[3] 10 款 low 几何全部仍在缓存', lowHit === all.length, lowHit + '/' + all.length)
})()

/* ---------- 4 缓存规模不会超过上限 ---------- */
;(function () {
  const hs = fresh()
  const all = hs.HAIR_STYLES
  // 先取最后 4 款的引用
  const last4 = []
  for (let i = all.length - 4; i < all.length; i++) last4.push(hs.getGeom(all[i], 'high'))

  // 再回头取第 1 款 —— 这一步会把 last4 里最早的那个挤掉
  hs.getGeom(all[0], 'high')

  // 最后 3 款应该还在（同一对象）
  let stillCached = 0
  for (let i = 1; i < last4.length; i++) {
    if (hs.getGeom(all[all.length - 4 + i], 'high') === last4[i]) stillCached++
  }
  ok('[4] 最近 3 款仍在缓存', stillCached === 3, '实际 ' + stillCached)

  // 被挤掉的那一款（last4[0]）应该已经不在
  const evicted = hs.getGeom(all[all.length - 4], 'high')
  ok('[4] 被挤掉的那款已重新计算', evicted !== last4[0])
})()

/* ---------- 5 内存量级（粗测，允许 GC 抖动） ---------- */
;(function () {
  const hs = fresh()
  const all = hs.HAIR_STYLES
  // 只有能主动 GC 时这个数才有意义，否则被淘汰的对象还在堆上没回收
  const canGc = typeof global.gc === 'function'
  const before = process.memoryUsage().heapUsed
  for (let i = 0; i < all.length; i++) hs.getGeom(all[i], 'high')
  if (canGc) { global.gc(); global.gc() }
  const delta = (process.memoryUsage().heapUsed - before) / 1048576
  if (canGc) {
    ok('[5] 10 款全看过后增量 < 12MB', delta < 12, delta.toFixed(1) + ' MB')
  } else {
    console.log('   （跳过精确内存断言：需要 node --expose-gc，当前增量 ' + delta.toFixed(1) + ' MB）')
  }
})()

console.log('')
console.log('[几何缓存内存] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  high 精度 LRU 上限 4 款（约 8.8MB），mid/low 不受影响')
}
