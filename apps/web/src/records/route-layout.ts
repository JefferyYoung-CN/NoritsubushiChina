/**
 * 折返等距线路图布局（纯函数，无 Vue/DOM）。
 *
 * 几何来源：票 03「折返等距布局的几何规则」Decision：
 * - 站距/行距三档：≥1280 → 104/88，768–1279 → 92/80，<768 → 84/72；
 * - 每行站数 = clamp(3, floor((宽 − 左右边距) / 站距), 9)；
 * - 行方向交替（偶数行左→右、奇数行右→左），下一行首站与上一行末站同列；
 * - 行尾 U 形半圆回折，半径 = 行距/2，从末站列外侧鼓出、不占站位；末行不画弧；
 * - 站名单行居下 11px（窄屏 10.5），按「站距 − 6px」用 estimateTextWidth 截断加「…」；
 * - 端头竖杠只标蛇身两端：票 03 原文是「整条蛇形两个端头」，但本图按连通段分段成行，
 *   12 号线两段各自有起止，只标全局两个端头会让第二段悬空，因此按「每个连通段的蛇身
 *   两端」标端头（票 03 未覆盖多段情形，这里取更能表达断线的读法）；
 * - 分岔臂单独成行并在行上方带方向标注；段间接缝不画弧，只标「无区间」。
 *
 * 分岔臂与蛇身之间没有额外连接线（票面未定）：臂从分岔站所在列开始，靠「往XX方向」标注
 * 表达所属分岔站，避免画出一条无处安放的斜线；臂超过首行容量时按蛇形换行，换行后的首站
 * 与上一行末站同列（向右展开的臂换行后从右向左接上）。
 */
import { estimateTextWidth } from '../map/label-placement';

/** 命中区边长（票 03：桌面 ≥24、手机 ≥44；统一取 44 保证触屏）。 */
export const HIT_SIZE = 44;
/** 站名可用宽度 = min(pitch − 10, 2×边距 − 10)；两边各让 2px 给旁路通道留余量。 */
const LABEL_GAP = 10;
/** 默认宽度：jsdom 容器宽为 0 时的稳定回退。 */
export const DEFAULT_DIAGRAM_WIDTH = 960;
/** 站名字号：不小于 .section-lead（0.9rem × 16px = 14.4px），三档统一。 */
export const LABEL_FONT_SIZE = 14.4;
/** 第一行基线、底部留白、站名基线偏移：与站距/行距一样是可调推导参数，方向不变、数值可按票 03 微调。 */
const TOP_PADDING = 40;
const BOTTOM_PADDING = 60;
// 线下方站名基线偏移：圆点下缘留出底版空隙；行距 72 时底版底 y+30 仍远小于下一行圆点。
const LABEL_OFFSET = 26;

export interface LayoutMetrics {
  /** 分档目标站距（104/92/84），仅用于推导每行站数。 */
  readonly stationGap: number;
  /** 实际站距：把当前行均分到 width − 2×margin，使末站圆心落在 width − margin。 */
  readonly pitch: number;
  readonly rowGap: number;
  readonly fontSize: number;
  /** 左右边距（固定 56）：容纳半宽站名、行尾外鼓与 44px 命中区半宽。 */
  readonly margin: number;
  readonly hitSize: number;
}

export interface LayoutPosition {
  readonly positionKey: string;
  readonly label: string;
  readonly drawsPoint: boolean;
  readonly segmentIndex: number;
  readonly arm: 'spine' | 'branch';
}

export interface LayoutSection {
  readonly sectionId: string;
  readonly fromPositionKey: string;
  readonly toPositionKey: string;
}

export interface LayoutSegment {
  readonly index: number;
  readonly positionKeys: readonly string[];
}

export interface LayoutArm {
  readonly label: string;
  readonly positionKeys: readonly string[];
  readonly branchPositionKey: string;
}

export interface LayoutGap {
  readonly kind: 'no-section';
  readonly fromPositionKey: string;
  readonly toPositionKey: string;
}

/** 布局只读取派生结果的结构字段，不依赖 route-sequence 的类型实现。 */
export interface RouteLayoutInput {
  readonly positions: readonly LayoutPosition[];
  readonly sections: readonly LayoutSection[];
  readonly segments: readonly LayoutSegment[];
  readonly arms: readonly LayoutArm[];
  readonly gaps: readonly LayoutGap[];
}

export interface LayoutOptions {
  /** 容器宽；只用于每行站数与横向坐标；≤0（jsdom）时退回 DEFAULT_DIAGRAM_WIDTH。 */
  readonly width: number;
  /** 窗口宽；只用于三档目标站距/行距/字号，缺省取容器宽（票 03 的分档以窗口宽为准）。 */
  readonly viewportWidth?: number;
}

export interface LayoutRow {
  readonly index: number;
  readonly direction: 'ltr' | 'rtl';
  readonly positionKeys: readonly string[];
  readonly y: number;
  readonly count: number;
  readonly segmentIndex: number;
  readonly arm: 'spine' | 'branch';
  /** 行所属的块（每段蛇身、每条支线臂各一块），用于把 U 弧限制在块内。 */
  readonly blockIndex: number;
}

export interface LayoutHitBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface LayoutStation {
  readonly positionKey: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly drawsPoint: boolean;
  readonly isEnd: boolean;
  readonly segmentIndex: number;
  readonly arm: 'spine' | 'branch';
  readonly x: number;
  readonly y: number;
  readonly labelY: number;
  /** 站名底版尺寸：宽度=estimateTextWidth(截断后站名)，高度=字号+4。 */
  readonly labelWidth: number;
  readonly labelHeight: number;
  /** 不透明底版矩形（文字在下层线条之上，底版在圆点之下）。 */
  readonly labelBox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** 分岔站站名在圆点上方（给支线让出正下方），其余在下方。 */
  readonly labelAbove: boolean;
  readonly rowIndex: number;
  readonly hitBox: LayoutHitBox;
}

export interface LayoutLine {
  readonly sectionId: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface LayoutArc {
  readonly sectionId: string | null;
  readonly x: number;
  readonly y1: number;
  readonly y2: number;
  /** 水平半径：跨行弧在窄屏收成半椭圆，宽屏/相邻行为正圆。 */
  readonly rx: number;
  /** 垂直半径=(yB−yA)/2。 */
  readonly ry: number;
  readonly direction: 'left' | 'right';
}

/** 不属于同一行、也不在块内换行的区间：用折线/直线连接（典型是分岔站到支线臂首站）。 */
export interface LayoutConnector {
  readonly sectionId: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
  /** 已算好的 SVG path；直线连接器含 L，旁路含圆角 A。 */
  readonly path: string;
}

export interface LayoutGapMarker {
  readonly kind: 'no-section';
  readonly fromPositionKey: string;
  readonly toPositionKey: string;
  readonly x: number;
  readonly y: number;
  readonly text: '无区间';
}

export interface LayoutArmMarker {
  readonly label: string;
  readonly positionKeys: readonly string[];
  readonly segmentIndex: number;
  readonly rowIndex: number;
  readonly x: number;
  readonly y: number;
}

export interface LayoutEndBar {
  readonly positionKey: string;
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

export interface RouteLayout {
  readonly width: number;
  readonly height: number;
  readonly metrics: LayoutMetrics;
  readonly perRow: number;
  readonly rows: readonly LayoutRow[];
  readonly stations: readonly LayoutStation[];
  readonly lines: readonly LayoutLine[];
  readonly arcs: readonly LayoutArc[];
  readonly connectors: readonly LayoutConnector[];
  readonly gaps: readonly LayoutGapMarker[];
  readonly arms: readonly LayoutArmMarker[];
  readonly endBars: readonly LayoutEndBar[];
}

export function layoutMetrics(width: number): LayoutMetrics {
  const stationGap = width >= 1280 ? 104 : width >= 768 ? 92 : 84;
  const rowGap = width >= 1280 ? 88 : width >= 768 ? 80 : 72;
  const perRow = Math.min(9, Math.max(3, Math.ceil((width - (rowGap + 8) * 2) / stationGap)));
  const pitch = perRow > 1 ? Math.max(1, (width - (rowGap + 8) * 2) / (perRow - 1)) : stationGap;
  return { stationGap, pitch, rowGap, fontSize: LABEL_FONT_SIZE, margin: rowGap + 8, hitSize: HIT_SIZE };
}

/** 每行站数：ceil(可用宽 / 目标站距)，让末站正好落在 width − margin，而不是右侧空一个站距。 */
export function stationsPerRow(width: number, metrics: LayoutMetrics): number {
  const usable = width - metrics.margin * 2;
  return Math.min(9, Math.max(3, Math.ceil(usable / metrics.stationGap)));
}

/** 按估算宽度截断，超长时保留前缀并加「…」；返回文本宽度不超过 maxWidth。 */
export function truncateLabel(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 0 && estimateTextWidth(`${chars.join('')}…`, fontSize) > maxWidth) chars.pop();
  return `${chars.join('')}…`;
}


function chunk<T>(rows: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

/** 每段蛇身两端；分岔臂不设端头。 */
function endKeysOf(input: RouteLayoutInput): ReadonlySet<string> {
  const byKey = new Map(input.positions.map(row => [row.positionKey, row]));
  const ends = new Set<string>();
  for (const segment of input.segments) {
    const spine = segment.positionKeys.filter(key => byKey.get(key)?.arm !== 'branch');
    if (spine.length > 0) { ends.add(spine[0]); ends.add(spine[spine.length - 1]); }
  }
  return ends;
}


export function layoutRoute(input: RouteLayoutInput, options: LayoutOptions): RouteLayout {
  const width = options.width > 0 ? options.width : DEFAULT_DIAGRAM_WIDTH;
  const base = layoutMetrics(options.viewportWidth ?? width);
  const perRow = stationsPerRow(width, base);
  const pitch = perRow > 1 ? Math.max(1, (width - base.margin * 2) / (perRow - 1)) : base.stationGap;
  const metrics: LayoutMetrics = { ...base, pitch };
  const byKey = new Map(input.positions.map(row => [row.positionKey, row]));
  const ends = endKeysOf(input);

  const armsBySegment = new Map<number, LayoutArm[]>();
  for (const arm of input.arms) {
    const branch = byKey.get(arm.branchPositionKey);
    if (!branch) continue;
    const list = armsBySegment.get(branch.segmentIndex) ?? [];
    list.push(arm);
    armsBySegment.set(branch.segmentIndex, list);
  }

  interface RowPlan {
    readonly blockIndex: number;
    readonly segmentIndex: number;
    readonly kind: 'spine' | 'branch';
    readonly label: string | null;
    readonly entries: readonly { readonly key: string; readonly column: number }[];
    readonly direction: 'ltr' | 'rtl';
  }
  const rowPlans: RowPlan[] = [];
  const armLinks: { readonly branchKey: string; readonly firstKey: string; readonly side: 1 | -1 }[] = [];
  let blockIndex = 0;
  for (const segment of [...input.segments].sort((left, right) => left.index - right.index)) {
    const spine = segment.positionKeys.filter(key => byKey.get(key)?.arm !== 'branch');
    if (spine.length === 0) continue;
    const spineBlock = blockIndex++;
    const spineRows = chunk(spine, perRow);
    const armByRow = new Map<number, LayoutArm[]>();
    for (const arm of armsBySegment.get(segment.index) ?? []) {
      const branchIndex = spine.indexOf(arm.branchPositionKey);
      if (branchIndex < 0) continue;
      const row = Math.floor(branchIndex / perRow);
      const list = armByRow.get(row) ?? [];
      list.push(arm);
      armByRow.set(row, list);
    }
    spineRows.forEach((keys, spineRow) => {
      const direction: 'ltr' | 'rtl' = spineRow % 2 === 0 ? 'ltr' : 'rtl';
      rowPlans.push({ blockIndex: spineBlock, segmentIndex: segment.index, kind: 'spine', label: null, direction,
        entries: keys.map((key, order) => ({ key, column: direction === 'ltr' ? order : perRow - 1 - order })) });
      for (const arm of armByRow.get(spineRow) ?? []) {
        const branchColumn = keys.indexOf(arm.branchPositionKey);
        if (branchColumn < 0) continue;
        const column = direction === 'ltr' ? branchColumn : perRow - 1 - branchColumn;
        const rightSpace = perRow - 1 - column;
        // 分岔站正下方是第一站；两侧余量相等或右侧更多时向右展开，否则向左。
        const goRight = rightSpace >= column;
        const capacity = goRight ? rightSpace + 1 : column + 1;
        let remaining = [...arm.positionKeys];
        const firstTake = remaining.slice(0, capacity);
        remaining = remaining.slice(firstTake.length);
        const armBlock = blockIndex++;
        rowPlans.push({ blockIndex: armBlock, segmentIndex: segment.index, kind: 'branch', label: arm.label,
          direction: goRight ? 'ltr' : 'rtl',
          entries: firstTake.map((key, order) => ({ key, column: goRight ? column + order : column - order })) });
        if (firstTake.length > 0) armLinks.push({ branchKey: arm.branchPositionKey, firstKey: firstTake[0], side: goRight ? 1 : -1 });
        // 首行之后按蛇形交替：向右展开的臂（ltr）换行后必须从右向左接上，
        // 否则末站会掉到下一行左端，与上一行末站断开。
        let rowDirection: 'ltr' | 'rtl' = goRight ? 'rtl' : 'ltr';
        for (const rest of chunk(remaining, perRow)) {
          rowPlans.push({ blockIndex: armBlock, segmentIndex: segment.index, kind: 'branch', label: null,
            direction: rowDirection,
            entries: rest.map((key, order) => ({ key, column: rowDirection === 'ltr' ? order : perRow - 1 - order })) });
          rowDirection = rowDirection === 'ltr' ? 'rtl' : 'ltr';
        }
      }
    });
  }

  const stations: LayoutStation[] = [];
  const layoutRows: LayoutRow[] = [];
  // 分岔站名挪到圆点上方，给正下方引出的支线让位；其余站名仍在下方。
  const branchKeys = new Set(input.arms.map(arm => arm.branchPositionKey));
  // 行 y 按最终顺序连续排列；臂行插在分岔站行的下一行，蛇身后续行自然下移。
  rowPlans.forEach((plan, rowIndex) => {
    const y = TOP_PADDING + rowIndex * metrics.rowGap;
    plan.entries.forEach(({ key, column }) => {
      const position = byKey.get(key);
      if (!position) return;
      const x = metrics.margin + column * metrics.pitch;
      const isEnd = ends.has(key);
      const labelAbove = branchKeys.has(key);
      const labelMax = Math.min(metrics.pitch - LABEL_GAP, metrics.margin * 2 - LABEL_GAP);
      const shortLabel = truncateLabel(position.label, labelMax, metrics.fontSize);
      const labelWidth = estimateTextWidth(shortLabel, metrics.fontSize);
      const labelHeight = metrics.fontSize + 4;
      stations.push({ positionKey: key, label: position.label,
        shortLabel,
        drawsPoint: position.drawsPoint, isEnd, segmentIndex: position.segmentIndex, arm: position.arm,
        x, y, labelY: labelAbove ? y - 20 : y + LABEL_OFFSET, labelAbove, labelWidth, labelHeight,
        labelBox: { x: x - labelWidth / 2 - 4, y: (labelAbove ? y - 20 : y + LABEL_OFFSET) - metrics.fontSize - 2,
          width: labelWidth + 8, height: metrics.fontSize + 6 }, rowIndex,
        hitBox: { left: x - metrics.hitSize / 2, top: y - metrics.hitSize / 2,
          right: x + metrics.hitSize / 2, bottom: y + metrics.hitSize / 2 } });
    });
    layoutRows.push({ index: rowIndex, direction: plan.direction, positionKeys: plan.entries.map(row => row.key),
      y, count: plan.entries.length, segmentIndex: plan.segmentIndex, arm: plan.kind, blockIndex: plan.blockIndex });
  });

  const stationByKey = new Map(stations.map(row => [row.positionKey, row]));
  const sectionBetweenKeys = (left: string, right: string): string | null => {
    const section = input.sections.find(row =>
      (row.fromPositionKey === left && row.toPositionKey === right) ||
      (row.fromPositionKey === right && row.toPositionKey === left));
    return section?.sectionId ?? null;
  };

  const lines: LayoutLine[] = [];
  for (const section of input.sections) {
    const from = stationByKey.get(section.fromPositionKey), to = stationByKey.get(section.toPositionKey);
    if (!from || !to || from.rowIndex !== to.rowIndex) continue;
    lines.push({ sectionId: section.sectionId, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
  }

  const arcs: LayoutArc[] = [];
  rowPlans.forEach((plan, rowIndex) => {
    const next = rowPlans[rowIndex + 1];
    if (!next || next.blockIndex !== plan.blockIndex) return;
    const lastKey = plan.entries[plan.entries.length - 1]?.key, firstKey = next.entries[0]?.key;
    const from = lastKey ? stationByKey.get(lastKey) : undefined;
    const to = firstKey ? stationByKey.get(firstKey) : undefined;
    if (!from || !to) return;
    const sectionId = sectionBetweenKeys(lastKey, firstKey);
    if (!sectionId) return;
    const ry = (to.y - from.y) / 2;
    arcs.push({ sectionId, x: from.x, y1: from.y, y2: to.y, ry, rx: Math.min(ry, metrics.margin - 10),
      direction: plan.direction === 'ltr' ? 'right' : 'left' });
  });
  // 蛇身行之间插入支线行时仍用同一个 U 弧，半径按实际跨度增长；弧在最外列外侧绕开支线行。
  for (const segment of [...input.segments].sort((left, right) => left.index - right.index)) {
    const spineRows = rowPlans.map((plan, rowIndex) => ({ plan, rowIndex }))
      .filter(row => row.plan.segmentIndex === segment.index && row.plan.kind === 'spine');
    for (let index = 0; index < spineRows.length - 1; index++) {
      const current = spineRows[index], next = spineRows[index + 1];
      if (next.rowIndex === current.rowIndex + 1) continue;
      if (current.plan.entries.length !== perRow) continue;
      const lastKey = current.plan.entries[current.plan.entries.length - 1]?.key;
      const firstKey = next.plan.entries[0]?.key;
      const from = lastKey ? stationByKey.get(lastKey) : undefined;
      const to = firstKey ? stationByKey.get(firstKey) : undefined;
      if (!from || !to) continue;
      const sectionId = sectionBetweenKeys(lastKey, firstKey);
      if (!sectionId) continue;
      const bridgeRy = (to.y - from.y) / 2;
      arcs.push({ sectionId, x: from.x, y1: from.y, y2: to.y, ry: bridgeRy,
        rx: Math.min(bridgeRy, metrics.margin - 10),
        direction: current.plan.direction === 'ltr' ? 'right' : 'left' });
    }
  }

  // 每条区间都必须有且只有一个可上色图元；分支连接线就地完成，不穿过其他行。
  const covered = new Set<string>([...lines.map(row => row.sectionId),
    ...arcs.map(row => row.sectionId).filter((id): id is string => id !== null),
    ]);
  const connectors: LayoutConnector[] = [];
  for (const link of armLinks) {
    const sectionId = sectionBetweenKeys(link.branchKey, link.firstKey);
    if (!sectionId || covered.has(sectionId)) continue;
    const branch = stationByKey.get(link.branchKey), first = stationByKey.get(link.firstKey);
    if (!branch || !first) continue;
    // 分岔站名已在圆点上方，支线从图标下方直接垂直引出：两点直线即可。
    connectors.push({ sectionId, path: `M ${branch.x} ${branch.y} L ${first.x} ${first.y}`,
      points: [{ x: branch.x, y: branch.y }, { x: first.x, y: first.y }] });
    covered.add(sectionId);
  }

  const gaps: LayoutGapMarker[] = [];
  for (const gap of input.gaps) {
    const from = stationByKey.get(gap.fromPositionKey), to = stationByKey.get(gap.toPositionKey);
    if (!from || !to) continue;
    const y = from.y + (to.y - from.y) / 2;
    gaps.push({ kind: 'no-section', fromPositionKey: gap.fromPositionKey, toPositionKey: gap.toPositionKey,
      x: metrics.margin, y, text: '无区间' });
  }

  const arms: LayoutArmMarker[] = [];
  rowPlans.forEach((plan, rowIndex) => {
    if (plan.kind !== 'branch' || plan.label === null) return;
    const rowStations = plan.entries.flatMap(entry => stationByKey.get(entry.key) ?? []);
    const leftmost = rowStations.length === 0 ? metrics.margin : Math.min(...rowStations.map(row => row.x));
    arms.push({ label: plan.label, positionKeys: plan.entries.map(row => row.key), segmentIndex: plan.segmentIndex,
      rowIndex, x: leftmost, y: layoutRows[rowIndex].y - 30 });
  });

  const endBars: LayoutEndBar[] = [];
  for (const station of stations) {
    if (!station.isEnd) continue;
    endBars.push({ positionKey: station.positionKey, x: station.x, y: station.y, height: 12 });
  }

  const height = rowPlans.length === 0 ? 0 : TOP_PADDING + (rowPlans.length - 1) * metrics.rowGap + BOTTOM_PADDING;
  return { width, height, metrics, perRow, rows: layoutRows, stations, lines, arcs, connectors, gaps, arms, endBars };
}
