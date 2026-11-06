/**
 * 车站视觉编码的唯一样式来源（票 04/06 复审）：线路图与图例都从这里取值，不各存一份。
 *
 * 普通站与「到不了」的描边走全局 `--ink-2` token（回退值保持渲染现状），因此换主题时
 * 图与图例一起变；出发/到达两态原本就是写死色值，这里集中成唯一副本。
 */
export type StationPaintState = 'from' | 'to' | 'unreachable' | 'normal';

export interface StationPaint {
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  /** 小于 1 时由调用方把它套在车站整体（圆点 + 站名）上，与既有「到不了」降透明一致。 */
  readonly opacity: number;
  /** 到达站的第二圈：只加环，不改圆点本身的填充。 */
  readonly ring: boolean;
}

/** 四种车站状态；fill/stroke 可直接作为 SVG 属性或内联样式下发。 */
export const STATION_PAINT: Readonly<Record<StationPaintState, StationPaint>> = Object.freeze({
  from: Object.freeze({ fill: '#e07a1f', stroke: '#e07a1f', strokeWidth: 2.5, opacity: 1, ring: false }),
  to: Object.freeze({ fill: '#ffffff', stroke: '#2f6fbf', strokeWidth: 3, opacity: 1, ring: true }),
  unreachable: Object.freeze({ fill: '#ffffff', stroke: 'var(--ink-2, #5b635f)', strokeWidth: 2.5, opacity: 0.45, ring: false }),
  normal: Object.freeze({ fill: '#ffffff', stroke: 'var(--ink-2, #5b635f)', strokeWidth: 2.5, opacity: 1, ring: false }),
});

/** 到达站第二圈的几何；颜色与圆点同一份。 */
export const STATION_RING = Object.freeze({ stroke: '#2f6fbf', strokeWidth: 2, radius: 10 });

/**
 * 键盘焦点环：橙色 3px，内外各 2px 白衬边（白描边 7px 垫在橙描边 3px 下面）。
 * 白衬边保证在深绿/灰/橙等任意线色与底色上都能看清边界；橙色沿用 --accent 的暖橙，
 * 与「本次所选」同色，不额外引入一种颜色含义。环画在圆点四周，仍落在 44×44 命中区内。
 */
export const STATION_FOCUS_RING = Object.freeze({
  stroke: '#b45c21',
  width: 3,
  halo: '#ffffff',
  /** 白衬边总宽 = 橙环 3px + 两侧各 2px。 */
  haloWidth: 7,
  /** 环边长与圆角：足够包住 r=6 的圆点与到达站双环，又不压到相邻站。 */
  size: 28,
  radius: 4,
});
