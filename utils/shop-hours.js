/**
 * 营业时间解析
 *
 * 抽成独立模块是为了可测：这段逻辑在首页上只影响一个小标签，
 * 但它决定「顾客照着小程序来店，会不会吃闭门羹」。
 * 跨夜、中文连接符、单位数小时这些写法都得能吃下。
 */

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

/**
 * @param {string} hours 形如 '10:00 - 22:00' / '18:00 至 02:00'
 * @param {Date} [now] 便于测试注入
 * @returns {{open:boolean, startText:string, endText:string, hint:string}|null}
 *   解析不了返回 null，让调用方决定要不要显示状态
 */
function calcOpenState(hours, now) {
  if (!hours || typeof hours !== 'string') return null
  // 兼容：半角/全角横线、波浪线、中文「至」，两边空格可有可无
  const m = hours.match(/(\d{1,2}):(\d{2})\s*[-—~～至]\s*(\d{1,2}):(\d{2})/)
  if (!m) return null

  const sh = parseInt(m[1], 10)
  const sm = parseInt(m[2], 10)
  const eh = parseInt(m[3], 10)
  const em = parseInt(m[4], 10)

  // 分钟位越界（'10:60'）说明数据写错了，宁可返回 null 显示「状态未知」，
  // 也不要悄悄算成 11:00 —— 那种错误没人会发现。
  if (sm > 59 || em > 59) return null
  if (sh > 24 || eh > 24) return null

  const d = now || new Date()
  const cur = d.getHours() * 60 + d.getMinutes()
  const start = sh * 60 + sm
  const end = eh * 60 + em

  let open
  if (start === end) {
    // '00:00 - 00:00' 视为 24 小时营业
    open = true
  } else if (start < end) {
    open = cur >= start && cur < end
  } else {
    // 跨夜：22:00 - 02:00
    open = cur >= start || cur < end
  }

  // 只说「营业中 / 已休息」还不够用：顾客站在门口看到「营业中」，
  // 并不知道还有半小时就打烊了；看到「已休息」也不知道几点开门、
  // 要不要等。把边界时间一并给出来，一句话就够。
  const startText = pad2(sh % 24) + ':' + pad2(sm)
  const endText = pad2(eh % 24) + ':' + pad2(em)
  return {
    open: open,
    startText: startText,
    endText: endText,
    hint: open ? endText + ' 打烊' : startText + ' 开门'
  }
}

module.exports = {
  calcOpenState: calcOpenState,
  pad2: pad2
}
