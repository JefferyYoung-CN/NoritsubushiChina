import type { Direction } from './reader.mjs';

export type RunDirection = 'ASC' | 'DESC';
export type DirectionPlanReason = 'cycle' | 'count' | 'label' | 'conflict' | 'no-anchor';

/** 显示用的方向标签；单侧锚点补出的方向不带锚点（两项为 null）。 */
export interface PlannedLabel {
  readonly label: string;
  readonly fromStationId: string | null;
  readonly toStationId: string | null;
}

export interface DirectionPlan {
  readonly usable: boolean;
  readonly reason: DirectionPlanReason | null;
  readonly byDirection: Readonly<Record<RunDirection, PlannedLabel | null>>;
  /** 第 i 个标签锚点定出的走法或 null，供数据质量报告记录坏锚点；标签数不是 2 时为空数组。 */
  readonly anchors: readonly (RunDirection | null)[];
}

export function planDirections(cycle: readonly string[], directions: readonly Direction[]): DirectionPlan;
