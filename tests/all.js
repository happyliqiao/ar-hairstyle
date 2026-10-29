/**
 * 跑全部测试
 *
 *   node tests/all.js
 *
 * 之所以要这一个入口：这些脚本是几轮迭代里陆续加上的，
 * 每次改动只跑「相关的那几个」很自然，但很容易漏掉不相关的回归
 * （比如把品牌色抽成 CSS 变量，结果把对比度搞挂了）。
 * 一个命令全跑一遍，才知道这一改到底动了什么。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const DIR = __dirname
const NODE = process.execPath

// 顺序：先静态、再几何、再数据、再交互、最后端到端
const SUITE = [
  ['final-scan.js', '静态扫描（语法/标签/绑定/定时器）'],
  ['dead-code.js', '死代码与冗余样式'],
  ['style-audit.js', '样式一致性'],
  ['a11y-audit.js', '无障碍'],
  ['contrast-check.js', '对比度'],
  ['data-integrity.js', '发型库数据完整性'],
  ['thumb-uri.js', '缩略图形态'],
  ['render-check.js', '渲染自检'],
  ['render-quality.js', '渲染质量基线'],
  ['fit-check.js', '人脸贴合'],
  ['extreme-face.js', '极端人脸与异常锚点'],
  ['shop-hours.js', '营业时间解析'],
  ['swipe-guard-check.js', '横滑误触保护'],
  ['store-budget.js', '存储预算与淘汰'],
  ['storage-corruption.js', 'storage 损坏清洗'],
  ['favorites-clean.js', '收藏列表清洗'],
  ['store-robust.js', 'store 回调健壮性'],
  ['compat-old.js', '低版本基础库兼容'],
  ['camera-perm.js', '相机权限生命周期'],
  ['race-unload.js', '异步回调 vs 页面销毁'],
  ['toast-priority.js', 'toast 优先级与相册权限'],
  ['share-audit.js', '分享配置'],
  ['frame-pacing.js', '帧率节流'],
  ['perf-budget.js', '性能预算'],
  ['memory-geom.js', '几何缓存内存'],
  ['app-hooks.js', 'App 兜底钩子'],
  ['memory-warning.js', '内存告警响应'],
  ['update-manager.js', '版本更新提示'],
  ['keep-screen-on.js', '屏幕常亮'],
  ['capture-reset.js', '拍照失败复位'],
  ['thumb-pipeline.js', '记录缩略图链路'],
  ['profile-clean.js', '档案与校准清洗'],
  ['shop-clock.js', '营业状态时钟'],
  ['first-guide.js', '首次使用引导'],
  ['nav-guard.js', '页面跳转守卫'],
  ['privacy-gate.js', '隐私协议授权'],
  ['last-pick.js', '记忆上次选择'],
  ['local-storage.js', '本机存储完整性'],
  ['strip-anchor.js', '横滑条定位'],
  ['window-theme.js', '窗口背景与配色'],
  ['toast-copy.js', '提示文案质量'],
  ['neck-locks.js', '脖子与后颈'],
  ['face-shadow.js', '脸部投影层'],
  ['buzz-cut.js', '寸头发茬'],
  ['curly-volume.js', '羊毛卷层次'],
  ['mirror-look.js', '镜像造型'],
  ['user-journey-regressions.js', '用户视角 20 轮'],
  ['no-virtual-preview.js', '去掉虚拟卡通化 5 轮'],
  ['guide-frame.js', '取景框与对齐引导'],
  ['face-match.js', '按人脸自动匹配'],
  ['face-match-2.js', '自动匹配静默失效复核 5 轮'],
  ['face-match-3.js', '自动匹配「用户表态之后」复核 5 轮'],
  ['journey.js', '端到端用户旅程']
]

const rows = []
let failed = 0

for (const [file, label] of SUITE) {
  const abs = path.join(DIR, file)
  if (!fs.existsSync(abs)) {
    rows.push({ label, ok: false, note: '文件不存在' })
    failed++
    continue
  }
  const t0 = Date.now()
  let ok = true
  let note = ''
  try {
    execFileSync(NODE, [abs], { stdio: 'pipe', encoding: 'utf8', timeout: 120000 })
  } catch (e) {
    ok = false
    failed++
    const out = (e.stdout || '') + (e.stderr || '')
    const line = out.split('\n').filter(function (l) { return /FAIL|错误|问题/.test(l) })
    note = line.length ? line[0].trim().slice(0, 90) : ('退出码 ' + e.status)
  }
  rows.push({ label, ok, note, ms: Date.now() - t0 })
}

console.log('')
console.log('==================== 全量测试 ====================')
rows.forEach(function (r) {
  const mark = r.ok ? 'PASS' : 'FAIL'
  const ms = r.ms !== undefined ? String(r.ms).padStart(5) + 'ms' : '     -'
  console.log('  ' + mark + '  ' + ms + '  ' + r.label + (r.note ? '   ' + r.note : ''))
})
console.log('==================================================')
console.log('  ' + (rows.length - failed) + ' / ' + rows.length + ' 套通过')

if (failed) {
  process.exitCode = 1
  console.log('')
  console.log('  有失败的套件，单独跑一遍看详细输出：node tests/<file>')
} else {
  console.log('  全部通过')
}
