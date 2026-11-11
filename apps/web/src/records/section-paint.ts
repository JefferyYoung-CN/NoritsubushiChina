/**
 * 区间着色视图模型（票 04/08）：把「完乘是否可用 / 总体完乘并集 / 临时停运 / 本次所选」
 * 压成图上每条区间只认的样式。纯函数，不依赖 Vue/DOM，也不读 network。
 *
 * 优先级：
 * - 临时停运最高：画虚线，既不叠本次所选外圈，底色也仍按乘坐与否决定；
 * - 完乘派生不可用（重算中或结果缺失）：只画中性线，连本次所选外圈也不画；
 * - 其余按总体完乘并集区分已乘坐 / 未乘坐，本次所选再叠外圈。
 *
 * 视觉编码（维护者 2026-11-01 实测后确认；同日把已乘坐改为加粗实线）：
 * 未乘坐=蓝色细实线（宽 4，代表可以选择）、已乘坐=灰色粗实线（宽 13，与本次所选外圈
 * 同宽、观感上与车站圆点直径一致，代表不能选择，色弱也能靠粗细分辨）、临时停运=长虚线
 * 且颜色随乘坐状态、本次所选=橙色三层外圈不变。未乘坐的蓝与到达站圆圈同色。规格没有给出十六进制色值与虚线节距，
 * 本文件的 `#2f6fbf`、`#8a948d`、`#5b635f`、`#b45c21`、`8 6` 都是推导值：方向不变，
 * 数值可按人工色弱/灰度检查结果调整。
 *
 * 「未知」与「已乘坐」「未乘坐」都不同色，就是为了不让「不知道」看起来像「没乘过」：
 * 未知沿用图里原本的中性墨色，已乘坐才用中性灰、未乘坐才用蓝。
 */
export type SectionPaintState = 'completed' | 'unridden' | 'suspended' | 'unknown';

export interface SectionPaint {
  /** SVG stroke；颜色只是通道之一，线宽与实线/虚线另行给出。 */
  readonly stroke: string;
  /** SVG stroke-dasharray；实线为 null，渲染时不下发该属性。 */
  readonly dash: string | null;
  /** 线宽：已乘坐用粗线（与本次所选外圈同宽），未乘坐/停运/未知用普通细线。 */
  readonly width: number;
}

/** 普通区间线宽（细线，推导值）。 */
export const SECTION_LINE_WIDTH = 4;
/** 本次所选外圈与已乘坐宽线的共同宽度：观感上与车站圆点的外径一致。 */
const RING_OUTER_WIDTH = 13;

/** 区间四态视觉编码：英文键与线型来自规格，hex、虚线节距与线宽为推导值（见文件头）。 */
export const SECTION_PAINT: Readonly<Record<SectionPaintState, SectionPaint>> = Object.freeze({
  completed: Object.freeze({ stroke: '#8a948d', dash: null, width: RING_OUTER_WIDTH }),
  unridden: Object.freeze({ stroke: '#2f6fbf', dash: null, width: SECTION_LINE_WIDTH }),
  /** 停运的线型；底色由 sectionPaint 按乘坐与否覆盖，这里的色值只给「完乘不可用」用。 */
  suspended: Object.freeze({ stroke: '#5b635f', dash: '8 6', width: SECTION_LINE_WIDTH }),
  unknown: Object.freeze({ stroke: '#5b635f', dash: null, width: SECTION_LINE_WIDTH }),
});

/** 本次所选外圈：橙 13 / 白 8 / 原色 5，三层自下而上叠，原色仍可辨。 */
export const SELECTED_RING = Object.freeze({
  outer: Object.freeze({ stroke: '#b45c21', width: RING_OUTER_WIDTH }),
  gap: Object.freeze({ stroke: '#ffffff', width: 8 }),
  baseWidth: 5,
});

export interface SectionVisual {
  readonly state: SectionPaintState;
  /** 本次所选外圈；完乘不可用与停运区间永远为 false。 */
  readonly selected: boolean;
  /**
   * 停运区间的底色：true 已乘坐（灰）/ false 未乘坐（蓝）/ null 完乘不可用（中性）。
   * 非停运区间不设置。
   */
  readonly ridden?: boolean | null;
}

export interface SectionPaintInput {
  /** 总体完乘并集是否可用；false 时除停运外的区间一律「未知」，且不画外圈。 */
  readonly completionReady: boolean;
  readonly completedSectionIds?: readonly string[];
  readonly suspendedSectionIds?: readonly string[];
  readonly selectedSectionIds?: readonly string[];
}

/**
 * 逐区间样式：只为传入的 sectionId 产出，不猜未列出的区间。
 * 停运优先于完乘色与本次所选，因此停运区间即使出现在所选集合里也不画外圈；
 * 完乘不可用时整张图只留中性线（停运仍是虚线），不知道的完乘状态不借外圈表达。
 */
export function paintSections(
  sectionIds: readonly string[],
  input: SectionPaintInput,
): ReadonlyMap<string, SectionVisual> {
  const completed = new Set(input.completedSectionIds ?? []);
  const suspended = new Set(input.suspendedSectionIds ?? []);
  const selected = new Set(input.selectedSectionIds ?? []);
  const paint = new Map<string, SectionVisual>();
  for (const sectionId of sectionIds) {
    if (suspended.has(sectionId)) {
      paint.set(sectionId, { state: 'suspended', selected: false,
        ridden: input.completionReady ? completed.has(sectionId) : null });
      continue;
    }
    const state: SectionPaintState = input.completionReady
      ? (completed.has(sectionId) ? 'completed' : 'unridden')
      : 'unknown';
    paint.set(sectionId, { state, selected: input.completionReady && selected.has(sectionId) });
  }
  return paint;
}

/**
 * 一条区间最终落笔的样式：停运区间保持虚线，底色仍按是否已乘坐取灰/蓝；
 * 完乘不可用时没有底色可依，画中性虚线。
 */
export function sectionPaint(visual: SectionVisual): SectionPaint {
  if (visual.state !== 'suspended') return SECTION_PAINT[visual.state];
  const tone = visual.ridden === true ? SECTION_PAINT.completed
    : visual.ridden === false ? SECTION_PAINT.unridden : SECTION_PAINT.suspended;
  return { stroke: tone.stroke, dash: SECTION_PAINT.suspended.dash, width: SECTION_PAINT.suspended.width };
}
