/**
 * 乘车方向的显示选项（进阶环线录入）。
 *
 * 简单环线总是出现方向步骤，与数据里有没有可用标签无关：标签可用时显示标签文字与锚点
 * 副文字，标签不可用或坏掉时用「往〈下一站〉方向」兜底。这里只做显示层组装——拓扑判定
 * （simple-cycle）与选路在 chain.ts，选源与映射规则来自 packages/application 的
 * direction-source 与 direction-plan。
 */
import { planDirections } from '../../../../packages/application/direction-plan.mjs';
import { serviceDirectionLabels } from '../../../../packages/application/direction-source.mjs';
import { active } from '../../../../packages/application/validation.mjs';
import type { PlannedLabel, RunDirection } from '../../../../packages/application/direction-plan.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';

export interface DirectionAnchor {
  readonly fromName: string;
  readonly toName: string;
}

/** 一个可选的乘车方向；`direction` 是内部运行方向，界面只显示 `label` 与锚点副文字。 */
export interface DirectionOption {
  readonly direction: RunDirection;
  /** 标签可用时用标签文字，否则是「往〈下一站〉方向」。 */
  readonly label: string;
  /** 标签带合法锚点时的两端站名（副文字「云台花园 → 大金钟路」）；没有锚点为空。 */
  readonly anchor: DirectionAnchor | null;
}

/** 业务日期上的站名显示名；未知站退回站 id，不抛错（方向只是显示层）。 */
function stationNameAt(network: TransitNetwork, onDate: string, stationId: string): string {
  const named = network.names.find((row) => row.stationId === stationId && active(row, onDate));
  if (named) return named.name;
  const station = network.stations.find((row) => row.id === stationId);
  return station ? station.name : stationId;
}

/** 标签可用时的两项：文字用标签，锚点两端换成业务日期上的站名。形状不完整时返回 null。 */
function labelledOptions(
  network: TransitNetwork,
  onDate: string,
  byDirection: Readonly<Record<RunDirection, PlannedLabel | null>>,
): readonly DirectionOption[] | null {
  const build = (direction: RunDirection): DirectionOption | null => {
    const planned = byDirection[direction];
    // `planDirections` 可用时两项都有标签；形状漂移时退回通用名，不渲染空选项。
    if (!planned) return null;
    const anchor = planned.fromStationId !== null && planned.toStationId !== null
      ? Object.freeze({
        fromName: stationNameAt(network, onDate, planned.fromStationId),
        toName: stationNameAt(network, onDate, planned.toStationId),
      })
      : null;
    return Object.freeze({ direction, label: planned.label, anchor });
  };
  const ascending = build('ASC');
  const descending = build('DESC');
  return ascending && descending ? Object.freeze([ascending, descending]) : null;
}

/**
 * 标签不可用时的通用名（规格 §3.4）：按环上站序取起点两侧的下一站。
 * 两个下一站显示名相同时追加「（方向一）／（方向二）」，否则两项读起来一模一样。
 */
function genericOptions(
  network: TransitNetwork,
  onDate: string,
  forward: readonly string[],
  fromStationId: string,
): readonly DirectionOption[] {
  const size = forward.length;
  const index = forward.indexOf(fromStationId);
  const nextName = (step: number): string => stationNameAt(network, onDate,
    forward[((index + step) % size + size) % size]);
  const ascending = nextName(1);
  const descending = nextName(-1);
  const sameName = ascending === descending;
  return Object.freeze([
    Object.freeze({
      direction: 'ASC' as const, label: `往${ascending}方向${sameName ? '（方向一）' : ''}`, anchor: null,
    }),
    Object.freeze({
      direction: 'DESC' as const, label: `往${descending}方向${sameName ? '（方向二）' : ''}`, anchor: null,
    }),
  ]);
}

/** 两个方向的显示选项：标签可用时用标签，否则用「往〈下一站〉方向」；正序项在前。 */
export function directionOptions(
  network: TransitNetwork,
  onDate: string,
  forward: readonly string[],
  serviceId: string,
  fromStationId: string,
): readonly DirectionOption[] {
  const plan = planDirections(forward, serviceDirectionLabels(network, serviceId, onDate));
  const labelled = plan.usable ? labelledOptions(network, onDate, plan.byDirection) : null;
  return labelled ?? genericOptions(network, onDate, forward, fromStationId);
}
