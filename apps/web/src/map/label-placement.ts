import type { ScreenPoint } from './projection';

/**
 * 站名标签防重叠：确定性贪心占位，不引入任何依赖。
 *
 * 算法：把所有车站按优先级排序（选中 > 高亮 > 普通，同级按 id 升序，保证同一输入
 * 总是得到同一结果）；按顺序逐个尝试固定顺序的 8 个方位（东、西、东北、西北、
 * 东南、西南、北、南），用估算的文本框与该站及所有车站的标记框做碰撞检测，第一个
 * 空位胜出；放不下就隐藏该标签。所有车站的标记框先全部占位，避免标签压住别的站。
 *
 * 文本宽度是估算值（CJK 一个字号宽、ASCII 约 0.55 个字号宽），不测真实字体度量；
 * 因此极窄屏可能仍略显拥挤，但结果稳定、可单测，且不需要 DOM 测量。
 */
export type LabelSide = 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'n' | 's';
export type TextAnchor = 'start' | 'middle' | 'end';

export interface LabelCandidate {
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  /** 越小越优先：0 选中、1 高亮、2 普通。 */
  readonly rank: number;
  readonly pointRadius?: number;
}

export interface LabelBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PlacedLabel {
  readonly id: string;
  readonly text: string;
  readonly side: LabelSide;
  readonly box: LabelBox;
  readonly textX: number;
  readonly textY: number;
  readonly textAnchor: TextAnchor;
}

export interface PlacementOptions {
  readonly width: number;
  readonly height: number;
  readonly padding?: number;
  readonly fontSize?: number;
  /** 最多显示的标签数；缺省按可视面积估算，避免 400+ 站全部铺字。 */
  readonly maxLabels?: number;
}

const SIDES: readonly LabelSide[] = ['e', 'w', 'ne', 'nw', 'se', 'sw', 'n', 's'];
const DEFAULT_FONT_SIZE = 11;
const COLLISION_GAP = 2;

const isWideCharacter = (char: string): boolean => /[\u2E80-\uFFFD]/u.test(char);

export function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const char of text) units += isWideCharacter(char) ? 1 : char.charCodeAt(0) < 0x80 ? 0.55 : 0.9;
  return Math.ceil(units * fontSize);
}

export function boxesOverlap(left: LabelBox, right: LabelBox, gap = 0): boolean {
  return !(left.right + gap <= right.left || right.right + gap <= left.left
    || left.bottom + gap <= right.top || right.bottom + gap <= left.top);
}

function markerBox(point: ScreenPoint, radius: number): LabelBox {
  return { left: point.x - radius, top: point.y - radius, right: point.x + radius, bottom: point.y + radius };
}

function buildLabel(candidate: LabelCandidate, side: LabelSide, width: number, height: number): PlacedLabel {
  const radius = candidate.pointRadius ?? 4;
  const gap = radius + 4;
  const diagonal = radius * 0.8 + 3;
  let left = candidate.x + gap;
  let top = candidate.y - height / 2;
  let textAnchor: TextAnchor = 'start';
  switch (side) {
    case 'e':
      break;
    case 'w':
      left = candidate.x - gap - width;
      textAnchor = 'end';
      break;
    case 'n':
      left = candidate.x - width / 2;
      top = candidate.y - radius - 4 - height;
      textAnchor = 'middle';
      break;
    case 's':
      left = candidate.x - width / 2;
      top = candidate.y + radius + 4;
      textAnchor = 'middle';
      break;
    case 'ne':
      left = candidate.x + diagonal;
      top = candidate.y - diagonal - height;
      break;
    case 'nw':
      left = candidate.x - diagonal - width;
      top = candidate.y - diagonal - height;
      textAnchor = 'end';
      break;
    case 'se':
      left = candidate.x + diagonal;
      top = candidate.y + diagonal;
      break;
    case 'sw':
      left = candidate.x - diagonal - width;
      top = candidate.y + diagonal;
      textAnchor = 'end';
      break;
  }
  const box: LabelBox = { left, top, right: left + width, bottom: top + height };
  const textX = textAnchor === 'start' ? left : textAnchor === 'end' ? left + width : left + width / 2;
  return { id: candidate.id, text: candidate.text, side, box, textX, textY: top + height * 0.82, textAnchor };
}

function compareCandidates(left: LabelCandidate, right: LabelCandidate): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function defaultMaxLabels(width: number, height: number, padding: number): number {
  const area = Math.max(0, width - padding * 2) * Math.max(0, height - padding * 2);
  return Math.min(80, Math.max(8, Math.floor(area / 2600)));
}

export function placeLabels(
  candidates: readonly LabelCandidate[],
  options: PlacementOptions,
): Readonly<{ placed: PlacedLabel[]; hidden: string[] }> {
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  const padding = options.padding ?? 0;
  const maxLabels = options.maxLabels ?? defaultMaxLabels(options.width, options.height, padding);
  const placed: PlacedLabel[] = [];
  const hidden: string[] = [];
  const occupied = candidates.map(candidate => markerBox(candidate, candidate.pointRadius ?? 4));
  for (const candidate of [...candidates].sort(compareCandidates)) {
    if (placed.length >= maxLabels) {
      hidden.push(candidate.id);
      continue;
    }
    const width = estimateTextWidth(candidate.text, fontSize);
    const height = Math.ceil(fontSize * 1.2);
    let chosen: PlacedLabel | null = null;
    for (const side of SIDES) {
      const label = buildLabel(candidate, side, width, height);
      const { left, top, right, bottom } = label.box;
      if (left < padding || top < padding || right > options.width - padding || bottom > options.height - padding) continue;
      if (occupied.some(box => boxesOverlap(box, label.box, COLLISION_GAP))) continue;
      chosen = label;
      break;
    }
    if (chosen) {
      placed.push(chosen);
      occupied.push(chosen.box);
    } else {
      hidden.push(candidate.id);
    }
  }
  return { placed, hidden };
}
