/**
 * 界面上的线条小图标(24×24 画布,1.9 粗的圆头线,颜色跟着文字走)。
 * 只放界面按钮用得到的几种;地图上的符号不在这里。
 */
import type { ReactNode } from 'react';

const PATHS = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  save: <path d="M6 4h12v16l-6-4-6 4z" />,
  export: <path d="M12 4v11M7 9l5-5 5 5M5 15v4h14v-4" />,
  book: <path d="M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18" cy="12" r="1.2" />
    </>
  ),
  intervene: (
    <>
      <path d="M4 20l5-5M14 4l6 6-8.5 8.5-6-6z" />
      <path d="M11 7l6 6" />
    </>
  ),
  center: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  rename: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  layers: (
    <>
      <path d="M12 4l8 4-8 4-8-4z" />
      <path d="M4 12l8 4 8-4M4 16l8 4 8-4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17" />
    </>
  ),
  map: <path d="M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2zM9 4v14M15 6v14" />,
  /** 侧栏开关:左边带一道竖线的方框(和常见的侧栏按钮一样) */
  sidebar: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M9.5 5v14" />
    </>
  ),
  terrain: <path d="M3 19l6-10 4 6 3-4 5 8z" />,
  /** 编辑地形:一支笔 + 一道波浪 */
  sketch: <path d="M9 15l.6-3.2L17.4 4a1.5 1.5 0 0 1 2.1 2.1L11.7 14zM3.5 20c1.6-1.3 3.2-1.3 4.8 0s3.2 1.3 4.8 0 3.2-1.3 4.8 0" />,
  volcano: <path d="M3 20l6-9h6l6 9zM10 8c-.8-1.6.8-2.4 0-4M14 8c-.8-1.4.8-2.2 0-3.6" />,
  /** 地震抬升:地平线上一道山,往上的箭头 */
  raise: (
    <>
      <path d="M3 20h18" />
      <path d="M4.5 16.5l4.5-5.5 3 3 2.5-2.5 5 5" />
      <path d="M12 8.5V3M9.6 5.4L12 3l2.4 2.4" />
    </>
  ),
  /** 海水漫进来:三道浪 */
  flood: (
    <path d="M3 8.5c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0M3 13.5c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0M3 18.5c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0" />
  ),
  lake: <path d="M3.5 13.5c0-3.6 3.8-6.5 8.5-6.5s8.5 2.9 8.5 6.5-3.8 5-8.5 5-8.5-1.4-8.5-5zM8.5 13.5c1.2-.9 2.3-.9 3.5 0s2.3.9 3.5 0" />,
  river: <path d="M5 3.5c0 4 5 4 5 8s-4 4-4 9M14 3.5c0 4 5 4 5 8s-4 4-4 9" />,
  pin: (
    <>
      <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  replay: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10 8.5l5 3.5-5 3.5z" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  flag: <path d="M6 21V4M6 4h11l-2 4 2 4H6" />,
  city: <path d="M4 20V10l5-3v13M9 20V5l6 3v12M15 20v-8l5 2v6M3 20h18" />,
  sparkle: <path d="M12 4l1.8 4.6L18.5 10l-4.7 1.6L12 16l-1.8-4.4L5.5 10l4.7-1.4z" />,
  scroll: (
    <>
      <path d="M6 4h10l3 3v13H6z" />
      <path d="M9 10h7M9 14h7" />
    </>
  ),
  lineage: (
    <>
      <rect x="9" y="3" width="6" height="5" rx="1.2" />
      <path d="M12 8v4M6 12h12M6 12v3M18 12v3" />
      <rect x="3" y="15" width="6" height="5" rx="1.2" />
      <rect x="15" y="15" width="6" height="5" rx="1.2" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" />
      <path d="M4 4v4.5h4.5M12 8v4l3 2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  down: <path d="M6 9l6 6 6-6" />,
  back: <path d="M15 5l-7 7 7 7" />,
  lock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </>
  ),
  dice: <path d="M4 8h3.5c2 0 3.2.8 4.3 2.6l.4.8c1.1 1.8 2.3 2.6 4.3 2.6H20M17 11l3 3-3 3M4 16h3.5c1.4 0 2.4-.4 3.2-1.2M13.3 9.2c.8-.8 1.8-1.2 3.2-1.2H20M17 5l3 3-3 3" />,
  file: (
    <>
      <path d="M7 3.5h7l4 4V20H7z" />
      <path d="M14 3.5V8h4M12.5 17v-6M10 13.5l2.5-2.5 2.5 2.5" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="11" height="12" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </>
  ),
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  // 网站账号、云同步、分享
  person: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c1.2-3.3 3.8-5 7-5s5.8 1.7 7 5" />
    </>
  ),
  personc: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="10" r="2.8" />
      <path d="M6.8 18c1.2-2.1 3-3.2 5.2-3.2s4 1.1 5.2 3.2" />
    </>
  ),
  cloudok: (
    <>
      <path d="M7 18.5h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 9.6 4.5 4.5 0 0 0 7 18.5z" />
      <path d="M9.5 13.5l2 2 3.5-3.5" />
    </>
  ),
  cloudup: (
    <>
      <path d="M7 18.5h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 9.6 4.5 4.5 0 0 0 7 18.5z" />
      <path d="M12 16v-5M9.8 13l2.2-2.2 2.2 2.2" />
    </>
  ),
  cloudoff: (
    <>
      <path d="M8.5 18.5H17c.5 0 1-.1 1.4-.3M20.6 15.5a4 4 0 0 0-3-5A6 6 0 0 0 9 6.7M6.2 9.6A4.5 4.5 0 0 0 7 18.5" />
      <path d="M4 4l16 16" />
    </>
  ),
  restore: (
    <>
      <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" />
      <path d="M12 17v-5M10 14l2-2 2 2" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4.5H6v15h4" />
      <path d="M14 8l4 4-4 4M18 12H9" />
    </>
  ),
  share: (
    <>
      <path d="M12 3.5v11M8 7.5l4-4 4 4" />
      <path d="M8 10.5H6.5v9.5h11v-9.5H16" />
    </>
  ),
  bubble: <path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-8.5L6 20v-3.5H5a1.5 1.5 0 0 1-1.5-1.5V6.5A1.5 1.5 0 0 1 5 5z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  compose: (
    <>
      <path d="M12 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5V12" />
      <path d="M10 14l.6-3L18 3.6a1.4 1.4 0 0 1 2 2L12.6 13z" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="2" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M8 14h8" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 16l5-5 4 4 2.5-2.5 5.5 5" />
      <circle cx="15.5" cy="9.5" r="1.5" />
    </>
  ),
  warn: <path d="M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.2v.3" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
