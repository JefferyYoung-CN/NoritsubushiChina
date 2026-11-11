/**
 * 基础保存的「扣除已记录区间后拆分」展示逻辑。
 *
 * 拆分算法属于领域：`planBasicSplit` 给出总段数、已记录段数与待写入的连续段；
 * 这里只把计划转成可读文案，站名走 `labelOf` 与记录列表一致。组件不复制领域规则，
 * 也不自行推断哪些区间算已记录。
 */
import { planBasicSplit } from '../../../../packages/application/records.mjs';
import type { DateView } from '../../../../packages/application/date-view.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { labelOf } from './labels';
import type { RecordSummaryInput } from './record-commands';

export interface BasicRun {
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly sectionIds: readonly string[];
}

/** 保存前预览：`covered` 为当前区间里已被基础记录覆盖的段数，`runs` 为将要写入的分段。 */
export interface BasicSavePlan {
  readonly total: number;
  readonly covered: number;
  readonly runs: readonly BasicRun[];
}

export interface SavedRun extends BasicRun {
  readonly id: string;
}

/** 保存后回执：只描述本次实际写入的记录，`runs` 为空表示没有新增。 */
export interface LastSave {
  readonly total: number;
  readonly covered: number;
  readonly runs: readonly SavedRun[];
}

/**
 * 预览计划；没有可用径路时不显示。
 *
 * 旧记录的摘要可能缺 `sectionIds`（只有起终点）：领域侧按「未覆盖」处理，
 * 这里先过滤掉，避免把无法证明的覆盖当成已记录。
 */
export function basicSavePlan(view: DateView | null, basic: readonly RecordSummaryInput[]): BasicSavePlan | null {
  if (!view || view.empty || !view.routeAvailable) return null;
  const recorded = basic.flatMap(record => (record.sectionIds ? [{ sectionIds: record.sectionIds }] : []));
  return planBasicSplit(view, recorded);
}

function runLabels(runs: readonly BasicRun[], network: TransitNetwork): string {
  return runs.map(run => `${labelOf(network, run.fromStationId)}→${labelOf(network, run.toStationId)}`).join('、');
}

/** 保存前：说明这次会写入什么；已被完全覆盖时必须讲清不会产生新记录。 */
export function describeSavePlan(plan: BasicSavePlan, network: TransitNetwork): string {
  if (plan.runs.length === 0) return '本次区间全部此前已记录，保存不会产生新记录。';
  return `本次将保存 ${plan.runs.length} 段：${runLabels(plan.runs, network)}（${plan.covered}/${plan.total} 段此前已记录）。`;
}

/** 保存后：按实际落库结果反馈，不用推测的区间覆盖数量代替结果。 */
export function describeSavedPlan(lastSave: LastSave, network: TransitNetwork): string {
  if (lastSave.runs.length === 0) return '本次区间全部此前已记录，未产生新记录。';
  const labels = runLabels(lastSave.runs, network);
  if (lastSave.runs.length === 1) return `基础记录已保存：${labels}。`;
  return `基础记录已拆分为 ${lastSave.runs.length} 段保存：${labels}。`;
}
