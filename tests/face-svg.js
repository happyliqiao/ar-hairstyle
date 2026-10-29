// 模拟人脸（SVG 片段）。单独抽成模块，供 SVG 截图页和 canvas 截图页共用 ——
// 两个页面的脸必须完全一致，否则没法比较两种渲染路径的差异。
let uid = 0

/**
 * 模拟一张脸。做得尽量接近照片而不是卡通 ——
 * 只有把发型放到有肤色渐变、有五官阴影的脸上，
 * 才能判断发型的明暗、位置、比例是不是真的对。
 */
function faceMock() {
  const n = ++uid
  const g = (s) => `${s}_${n}`
  return `
  <defs>
    <radialGradient id="${g('skin')}" cx=".36" cy=".28" r=".82">
      <stop offset="0" stop-color="#f3d9be"/>
      <stop offset=".42" stop-color="#e5c3a2"/>
      <stop offset=".76" stop-color="#cfa682"/>
      <stop offset="1" stop-color="#a87f5e"/>
    </radialGradient>
    <radialGradient id="${g('cheek')}" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#d98d7c" stop-opacity=".38"/>
      <stop offset="1" stop-color="#d98d7c" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${g('iris')}" cx=".42" cy=".36" r=".62">
      <stop offset="0" stop-color="#8a6a44"/>
      <stop offset=".55" stop-color="#4e3620"/>
      <stop offset="1" stop-color="#2a1c11"/>
    </radialGradient>
    <linearGradient id="${g('lip')}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#c98079"/>
      <stop offset=".5" stop-color="#b46a63"/>
      <stop offset="1" stop-color="#8e4c47"/>
    </linearGradient>
    <linearGradient id="${g('jaw')}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8a6446" stop-opacity="0"/>
      <stop offset="1" stop-color="#8a6446" stop-opacity=".34"/>
    </linearGradient>
  </defs>
  <g>
    <!-- 脖子 -->
    <path d="M78 168 L78 200 Q100 212 122 200 L122 168 Z" fill="#c99d79"/>
    <path d="M78 168 L122 168 L122 182 Q100 192 78 182 Z" fill="#8a6446" opacity=".30"/>
    <!-- 脸 -->
    <path d="M100 48 C131 48 153 74 153 112 C153 152 131 190 100 190 C69 190 47 152 47 112 C47 74 69 48 100 48 Z"
          fill="url(#${g('skin')})"/>
    <!-- 耳朵 -->
    <ellipse cx="48" cy="118" rx="7" ry="11" fill="#dcb593"/>
    <ellipse cx="152" cy="118" rx="7" ry="11" fill="#dcb593"/>
    <path d="M46 113 C50 115 50 122 47 125" stroke="#b58a66" stroke-width="1.2" fill="none"/>
    <path d="M154 113 C150 115 150 122 153 125" stroke="#b58a66" stroke-width="1.2" fill="none"/>
    <!-- 颧骨腮红 -->
    <ellipse cx="74" cy="140" rx="16" ry="11" fill="url(#${g('cheek')})"/>
    <ellipse cx="126" cy="140" rx="16" ry="11" fill="url(#${g('cheek')})"/>
    <!-- 下颌阴影 -->
    <path d="M47 112 C47 152 69 190 100 190 C131 190 153 152 153 112 L153 160 C153 180 128 194 100 194 C72 194 47 180 47 160 Z"
          fill="url(#${g('jaw')})"/>
    <!-- 眉毛 -->
    <path d="M70 110 C78 104 90 104 96 109 C90 107 78 107 70 112 Z" fill="#6b4a33" opacity=".9"/>
    <path d="M130 110 C122 104 110 104 104 109 C110 107 122 107 130 112 Z" fill="#6b4a33" opacity=".9"/>
    <!-- 眼窝阴影 -->
    <ellipse cx="83" cy="120" rx="12" ry="7" fill="#a87f5e" opacity=".22"/>
    <ellipse cx="117" cy="120" rx="12" ry="7" fill="#a87f5e" opacity=".22"/>
    <!-- 眼睛 -->
    <path d="M74 121 Q83 114 92 121 Q83 128 74 121 Z" fill="#fbf7f2"/>
    <path d="M108 121 Q117 114 126 121 Q117 128 108 121 Z" fill="#fbf7f2"/>
    <circle cx="83" cy="121" r="4.6" fill="url(#${g('iris')})"/>
    <circle cx="117" cy="121" r="4.6" fill="url(#${g('iris')})"/>
    <circle cx="83" cy="121" r="2.1" fill="#16100a"/>
    <circle cx="117" cy="121" r="2.1" fill="#16100a"/>
    <circle cx="84.6" cy="119.2" r="1.25" fill="#fff" opacity=".92"/>
    <circle cx="118.6" cy="119.2" r="1.25" fill="#fff" opacity=".92"/>
    <!-- 上眼睑线 -->
    <path d="M74 121 Q83 113.6 92 121" stroke="#3d2a1c" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    <path d="M108 121 Q117 113.6 126 121" stroke="#3d2a1c" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    <!-- 鼻子 -->
    <path d="M99 126 C99 138 96 146 92 149 Q100 152 108 149" stroke="#b58a66" stroke-width="1.6"
          fill="none" stroke-linecap="round" opacity=".85"/>
    <ellipse cx="96" cy="149" rx="2.2" ry="1.3" fill="#8a6446" opacity=".55"/>
    <ellipse cx="104" cy="149" rx="2.2" ry="1.3" fill="#8a6446" opacity=".55"/>
    <path d="M100 128 C100 136 99 142 98 146" stroke="#fff" stroke-width="1.4" fill="none" opacity=".16"/>
    <!-- 嘴唇 -->
    <path d="M88 166 Q94 160 100 162 Q106 160 112 166 Q106 172 100 172 Q94 172 88 166 Z" fill="url(#${g('lip')})"/>
    <path d="M88 166 Q100 168 112 166" stroke="#7d3f3b" stroke-width="1.1" fill="none" opacity=".8"/>
    <path d="M93 164 Q100 161 107 164" stroke="#fff" stroke-width="1.1" fill="none" opacity=".22"/>
    <!-- 下巴高光 -->
    <ellipse cx="100" cy="180" rx="13" ry="5" fill="#fff" opacity=".07"/>
  </g>`
}


module.exports = { faceMock: faceMock }
