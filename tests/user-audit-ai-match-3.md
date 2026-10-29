# 第 7 轮：「用户表态之后」的 5 轮复核

> 前情：第 6 轮解决了「匹配功能静默失效」的 5 个引擎级问题（退化判定/重试关闭/肤色一次失败/锚点不同步/结果太确定）。
> 第 7 轮换一个切口：**功能已经给出结论之后**，用户会做什么？他的动作会让功能发生什么连锁反应？
>
> 记录原则：每轮先站在真人角度给出「自我否定」的理由，再定位代码缺陷，最后修掉。

---

## 测试覆盖

- `tests/face-match-3.js`：32 项断言，U/V/W/X/Y 五组
- `node tests/all.js` → **53/53 套通过**
- 视觉预览：`tests/out/rec7-mini.png`（小条含发色）

---

## 第 1 轮｜用户点「×」以后，匹配功能消失，发色结论还在偷偷改

**真人场景**
进页面，匹配弹出「圆脸，已换上「短碎发」」。用户看了一眼，觉得还行，点 × 收掉卡片，想继续看看别的款。两秒后肤色采样到了，画面突然从「自然黑」跳成「亚麻棕」。用户一脸懵：「我明明点的是 ×，为什么还换色？」

**根因**
- `dismissRec()` 旧行为：`this.setData({ rec: { show: false } })`，卡片整个消失。
- `_recDone = true` 只阻止「新推荐」，不阻止 `applySkin` 里那轮 `setData({ currentColor })`。
- 结果：卡片没了，但肤色到达后发色还会变，用户没有任何界面提示这个变化是怎么来的。
- 更严重：手滑点掉一次，整场会话结论彻底消失，找不回来。

**修**
- `dismissRec()` 不再设 `show: false`，而是 `expanded: false` + `declined: true`。
- 小条保留（`show: true`），写成「偏圆脸，推荐「短碎发」· 自然黑 展开」。
- `applySkin` 加守卫：`if (this.data.rec.declined) return`，拒绝后绝不偷偷改发色。
- `_recDone = true` 保留：拒绝后确实不再自动动手。

**副作用**
旧测试 `G17`「收起后 rec.show = false」和 `M9`「彻底关掉后小条也不显示」语义已改，同步更新断言。

---

## 第 2 轮｜「接受推荐」被写进了「上次记忆」，下次进页面先给你换上

**真人场景**
用户今天第一次用，匹配说「圆脸→短碎发」，他点了「换成这款」，试了试觉得不错，拍了张照片。第二天再进页面，画面直接就是短碎发——他想看看别的，却发现每次进页面都先强制换上昨天的款，好像功能在替他做决定。

**根因**
- `applyStyleId(..., { user: true })` 统一调用 `store.saveLastPick(style, color)`。
- `saveLastPick` 不区分「用户自己从列表里挑的」和「用户点了 AI 推荐的『换成这款』」。
- 而 `_hasLastPick` 成立时，**自动匹配的三条禁令之一**触发，整场不再自动动手。
- 结果：接受推荐 = 下一场关闭自动匹配。用户在惩罚一个他认可的功能。

**修**
- `saveLastPick` 增加 `by` 字段：`{ style, color, by: 'user' | 'auto' }`。
- `store.readLastPick()` 同时返回 `by`。
- `onLoad` 判断时只认 `by === 'user'` 才算「用户有明确偏好」；`by === 'auto'` 只用来初始化当前款/色，**不阻塞自动匹配**。
- 用户亲手从款式条横滑挑的，或进微调后改参数 → 存 `by:'user'`。
- 点「换成这款」→ 不存 lastPick（它就是自动匹配的结果，不该影响下一次）。

---

## 第 3 轮｜卡片收起成一行小条，但发色结论丢了

**真人场景**
匹配弹出「圆脸→短碎发」，用户顺手点了一下空白处（或 7 秒超时），卡片收成一行小条。小条上只有「偏圆脸，推荐「短碎发」」，没有颜色信息。用户以为颜色没测出来，其实后台已经算好了，只是没地方显示。

**根因**
- `.rec-mini-text` 只写 `{{rec.shapeLabel}}脸，推荐「{{rec.styleName}}」`，没留 `colorName` 位置。
- 设计时认为「发色不如发型重要，小条放不下」。

**修**
- 小条追加 `wx:if="{{rec.colorName}}"` 的 `<text class="rec-mini-color"> · {{rec.colorName}}</text>`。
- `.rec-mini-color` 用 `#e0a86f`（主金色），与中性灰小条正文区分，一眼看出是另一个维度的结论。
- 单行超长时 `text-overflow: ellipsis`，不会换行顶面板。
- `rec.miniColor` 字段不用新增，直接读 `rec.colorName`。

---

## 第 4 轮｜用户在微调大小/位置/旋转，匹配突然弹出并把他刚调好的参数清零

**真人场景**
用户进了微调面板，把背头往下拉了 12pt、放大到 110%，觉得位置刚好。这时脸框对齐了，匹配定时器到了，「啪」一下换成短碎发，大小/位置/旋转全部复位 100/46/0。用户刚才那 10 秒微调白干了。

**根因**
- `maybeRecommend()` 没有检查 `adjustMode`。
- `applyStyleId` 里 `sizeVal:100, yVal:46, rotVal:0` 是硬编码的复位。
- 结果：微调中到达的任何推荐都会覆盖用户正在精细调整的状态。

**修**
- `maybeRecommend()` 加 `if (this.data.adjustMode) return`。
- `toggleAdjust()` 进入微调时 `clearRecCollapse()`，防止微调途中卡片 7 秒超时弹开。
- 退出微调时如果当前对齐状态满足条件，`maybeRecommend()` 下一帧就会自然触发。

---

## 第 5 轮｜切换前置/后置摄像头后，卡片显示的是「上一张脸」的结论

**真人场景**
用户想让朋友也试试，点了切换摄像头。朋友的脸明显更长，但屏幕上小条仍然写着「偏圆脸，推荐「短碎发」」。而且因为 `_recDone = true` 没被重置，这张新脸永远不会再被匹配。

**根因**
- `switchCamera` 重置了 `_shape` 和 `_yaw`，但**没重置 `_recDone`**。
- 旧卡片数据 `rec.show/rec.styleName` 也没清，用户看到的是上一张脸的结论。
- 后置摄像头通常拍的是别人，脸型肤色全变，旧结论不仅错误，还阻塞新结论。

**修**
- `switchCamera` 里加 `this._resetRecState()`（内部把 `_recDone/_recTries/_skinStarted` 全归零）。
- 同时 `this.setData({ rec: { show: false, expanded: false } })`，旧卡片立刻消失。
- 新摄像头建立 VKSession 后，对齐流程从头开始，`maybeRecommend()` 会自然接管。

**注意**
`switchCamera` 里不能无条件 `clearAllTimers`，因为 `_lostTimer` 在切摄像头期间需要继续保护画面不挂起。

---

## 附：三个次要的交互清理

1. **pickStyle / pickColor / toggleAdjust 时，如果用户之前点过 ×（declined），小条也该收掉。**
   否则他在手动挑款时，底部始终有一条「偏圆脸推荐…」的小条，暗示「你挑的不对」。
   新增 `dropDeclinedRec()`：只在 `declined && !expanded` 时清 `show:false`。

2. **色卡同步锚点。**
   自动匹配换发色时（`canAuto && skin.confident`），`colorAnchor` 同步为新色索引。
   之前只同步了 `stripAnchor`（发型条），色带没同步。

3. **无障碍符号。**
   小条里用了 `·`（中点）分隔发型与发色，`a11y-audit.js` 的符号规则只针对 aria-label，
   文本内容本身不算符号违规。无改动。

---

## 遗留清单（本轮未处理）

1. **yaw 门控相对基准问题**：前 6 帧全是侧脸 → 基准就是侧脸 → 转正后判成圆脸。没有绝对头姿可补，只能靠「判得不准？」兜底。
2. **多张脸入镜**：VKSession 目前只取 `faces[0]`，第二个人被无视。需求不明确，暂不处理。
3. **真机肤色采样白平衡**：CIELAB 依赖绝对亮度，不同机型前置摄像头白平衡差异可能让 ITA 系统性偏移。需要 10 台真机采样回归。
4. **「换一款」在脸边界时**：如果 `rec.alt` 只有 1 个（排序器只返回 ≥2 分的款），胶囊按钮不显示。这是预期行为，不是缺陷。

---

## 改动文件

| 文件 | 动作 | 说明 |
|---|---|---|
| `pages/tryon/tryon.js` | 改 | dismissRec/applySkin/applyStyleId/applyColorId/switchCamera/toggleAdjust/pickStyle/pickColor 等 |
| `pages/tryon/tryon.wxml` | 改 | rec-mini 追加发色、× 语义改为收起 |
| `pages/tryon/tryon.wxss` | 改 | rec-mini-color / rec-why-row 下边框 |
| `utils/store.js` | 改 | saveLastPick 支持 by 字段；readLastPick 透传 by |
| `tests/face-match-3.js` | 新建 | 32 项，U/V/W/X/Y 五组 |
| `tests/face-match.js` | 改 | G17、M9 断言语义更新 |
| `tests/face-match-2.js` | 改 | P6 断言语义更新 |
| `tests/all.js` | 改 | 注册 face-match-3.js |
| `tests/rec-preview.html` | 改 | 小条追加发色预览 |
| `tests/out/rec7-mini.png` | 新建 | 收起态小条实测截图 |
