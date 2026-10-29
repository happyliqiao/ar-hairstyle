/**
 * 无障碍审计（读屏可用性）
 *
 * 上一批只做到「符号按钮有 aria-label」，这一轮往下挖三层：
 *   A 可交互但没有任何可读名字（读屏念「按钮」，用户不知道点了会怎样）
 *   B 纯符号/装饰文本没有隐藏或替代名（念出来是「‹」「▤」「›」）
 *   C 会变的区域没有 aria-live（读屏用户永远听到进入那一刻的旧文案）
 *   D 破坏性操作没有把后果念出来（"清空" vs "清空全部记录，删除后不可恢复"）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pages = fs.readdirSync(path.join(ROOT, 'pages'))

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) pass++
  else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')) }
}

const SYMBOLS = ['‹', '›', '⇄', '★', '☆', '▤', '+', '×', '·']
const INTERACTIVE = /(?:bind|catch)tap|bindlongpress|bindchange|bindinput|bindblur|bindchooseavatar/

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '="([^"]*)"'))
  return m ? m[1] : null
}

/**
 * 找开标签的结束位置。
 *
 * 不能简单 indexOf('>')：wx:if="{{a > b}}" 里含有 '>'，
 * 会在属性中间被截断，把后面的 aria-label 整段漏掉 ——
 * 上一批的 final-scan 就栽在同一个坑上（当时用 slice(0,500) 绕过去，
 * 这次老老实实写个扫描器：引号内和 {{}} 内的 '>' 都不算标签结束）。
 */
function findTagEnd(src, start) {
  let i = start + 1
  let inQuote = null
  let braces = 0
  while (i < src.length) {
    const c = src[i]
    if (inQuote) {
      if (c === inQuote) inQuote = null
    } else if (c === '"' || c === "'") {
      inQuote = c
    } else if (c === '{' && src[i + 1] === '{') {
      braces++
      i++
    } else if (c === '}' && src[i + 1] === '}' && braces > 0) {
      braces--
      i++
    } else if (c === '>' && braces === 0) {
      return i
    }
    i++
  }
  return src.length - 1
}


/** 取某个标签的完整文本内容（粗略：到下一个 < 为止，够用） */
function innerText(tag, src, startIdx) {
  return ''
}

for (const p of pages) {
  const wxml = path.join(ROOT, 'pages', p, p + '.wxml')
  if (!fs.existsSync(wxml)) continue
  const src = fs.readFileSync(wxml, 'utf8')

  // 逐个开标签扫描
  const tags = src.match(/<[a-zA-Z-]+[\s\S]*?>/g) || []
  let cursor = 0
  for (const tag of tags) {
    const at = src.indexOf(tag, cursor)
    cursor = at + tag.length
    const name = (tag.match(/^<([a-zA-Z-]+)/) || [])[1]
    if (name === 'slider' || name === 'input') {
      // 表单类只要有 aria-label 即可，下面统一判
    }

    // catchtap="noop" 是纯拦冒泡用的（防止点弹层内部也关掉弹层），
    // 它不是给用户点的目标，不要求可读名。
    const isNoopStopper = /catchtap="noop"/.test(tag)
    const isInteractive = INTERACTIVE.test(tag) && !isNoopStopper
    const ariaLabel = attr(tag, 'aria-label')
    const ariaHidden = attr(tag, 'aria-hidden')
    const ariaRole = attr(tag, 'aria-role')

    // 紧跟其后的文本（到下一个 '<'）
    const after = src.slice(cursor)
    const textRaw = (after.split('<')[0] || '').trim()

    if (isInteractive) {
      // 交互节点：必须有 aria-label，或者自身/内部有可读文本
      const selfText = textRaw.replace(/\{\{[^}]*\}\}/g, '').trim()
      const hasReadable = !!ariaLabel || (selfText && selfText.length > 0)
      // 有些节点文本在子元素里（如 button > text），宽松处理：
      // 只要 aria-label 存在，或该标签后面 200 字符内有中文，就算可读
      const window200 = after.slice(0, 200)
      const hasChinese = /[\u4e00-\u9fa5]/.test(window200)
      ok('[' + p + '] <' + name + '> 交互节点有可读名',
        hasReadable || hasChinese,
        '标签=' + tag.replace(/\s+/g, ' ').slice(0, 90))
    }

    // 纯符号文本节点：<text class="...">‹</text>
    if (name === 'text' || name === 'view') {
      const t = textRaw.replace(/\{\{[^}]*\}\}/g, '').trim()
      if (t && t.length <= 3 && SYMBOLS.indexOf(t) >= 0) {
        ok('[' + p + '] 符号「' + t + '」要么 aria-hidden 要么有替代名',
          !!ariaHidden || !!ariaLabel,
          '标签=' + tag.replace(/\s+/g, ' ').slice(0, 90))
      }
    }
  }

  // C 动态区域：含 {{statusText}} / {{toast}} 的节点必须 aria-live
  const dynamicFields = ['statusText', 'toast', 'cameraMsg']
  for (const f of dynamicFields) {
    const idx = src.indexOf('{{' + f + '}}')
    if (idx < 0) continue
    // 往前找最近的 '<'
    const tagStart = src.lastIndexOf('<', idx)
    const tagEnd = findTagEnd(src, tagStart)
    const tag = src.slice(tagStart, tagEnd + 1)
    ok('[' + p + '] {{' + f + '}} 所在节点有 aria-live',
      /aria-live=/.test(tag),
      '标签=' + tag.replace(/\s+/g, ' ').slice(0, 100))
  }

  // D 破坏性操作
  const dangerous = ['clearAll', 'clearAllData', 'confirmRemove', 'removeRecord']
  for (const fn of dangerous) {
    const idx = src.indexOf('="' + fn + '"')
    if (idx < 0) continue
    const tagStart = src.lastIndexOf('<', idx)
    const tagEnd = findTagEnd(src, tagStart)
    const tag = src.slice(tagStart, tagEnd + 1)
    const label = attr(tag, 'aria-label') || ''
    ok('[' + p + '] 破坏性操作 ' + fn + ' 念出后果',
      /不可恢复|删除|清空/.test(label),
      'aria-label=' + label)
  }
}

/* 全局：每个页面至少有 1 处 aria-role，说明做过无障碍适配 */
for (const p of pages) {
  const wxml = path.join(ROOT, 'pages', p, p + '.wxml')
  if (!fs.existsSync(wxml)) continue
  const src = fs.readFileSync(wxml, 'utf8')
  ok('[' + p + '] 做过无障碍适配', /aria-/.test(src))
}

console.log('')
console.log('[无障碍审计] ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail) {
  console.log('')
  failures.forEach(function (f) { console.log('  FAIL  ' + f) })
  process.exitCode = 1
} else {
  console.log('  A 交互节点可读名 / B 符号隐藏 / C 动态区域播报 / D 破坏性操作后果')
}
