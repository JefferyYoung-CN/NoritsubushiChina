/**
 * 整圈目标（进阶环线录入，票 09）。
 *
 * 简单环线选定方向后，到站列表末项给出「回到起点 · 整圈（N 区间）」：起终点相同、
 * 沿所选方向绕一整圈，N 是当日该环的成员区间数。
 *
 * 为什么不复用 serviceWalk 的单向遍历：单向遍历是「回到起点即停」，它从不记录起点
 * （回到起点是终止条件，不是到站），也拿不到整圈的首尾相接顺序。整圈的顺序只能由
 * serviceCycle 的环上站序给出，因此这里按站序从起点展开全部成员区间。
 */
import { mileage, sectionStatus } from '../../../../packages/application/date-view.mjs';
import { active } from '../../../../packages/application/validation.mjs';
import type { RunDirection } from '../../../../packages/application/direction-plan.mjs';
import type { SimpleCycle } from '../../../../packages/application/simple-cycle.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import type { ReachableStation } from './chain';

/** 整圈目标：与普通到站同形，只是站 id 等于本段起点，区间绕满一整圈。 */
export type LoopTarget = ReachableStation;

/** 业务日期上的站名显示名；未知站退回站 id（与 directionOptions 同口径）。 */
function stationNameAt(network: TransitNetwork, onDate: string, stationId: string): string {
  const named = network.names.find(row => row.stationId === stationId && active(row, onDate));
  if (named) return named.name;
  return network.stations.find(row => row.id === stationId)?.name ?? stationId;
}

/** 从起点沿 direction 绕满一圈的成员区间；起点不在当日环上时返回 null。 */
export function loopSectionIds(cycle: SimpleCycle, fromStationId: string, direction: RunDirection): readonly string[] | null {
  const size = cycle.sectionIds.length;
  const start = cycle.forward.indexOf(fromStationId);
  if (start < 0) return null;
  // 正序第 k 段是 forward[start + k] 发出的区间；反序第 k 段是 forward[start - k - 1] 发出的。
  return Object.freeze(Array.from({ length: size }, (_, step) =>
    cycle.sectionIds[(((direction === 'ASC' ? start + step : start - step - 1) % size) + size) % size] as string));
}

/** 整圈目标：区间、里程与当日可用性都按普通到站的同一套规则给出。 */
export function loopTarget(
  network: TransitNetwork,
  onDate: string,
  cycle: SimpleCycle,
  fromStationId: string,
  direction: RunDirection,
): LoopTarget | null {
  const ordered = loopSectionIds(cycle, fromStationId, direction);
  if (!ordered) return null;
  const sections = ordered.map(id => network.sections.find(row => row.id === id));
  // 成员区间必在快照里；缺行按不可用处理，绝不拼出一条不完整的整圈。
  if (sections.some(row => !row)) return null;
  const present = sections as NonNullable<(typeof sections)[number]>[];
  const normal = present.filter(row => sectionStatus(row, network, onDate).status !== 'retired');
  return Object.freeze({
    stationId: fromStationId,
    stationName: stationNameAt(network, onDate, fromStationId),
    sectionIds: Object.freeze(normal.map(row => row.id)),
    lengthMetres: mileage(network, normal).lengthMetres,
    routeAvailable: present.every(row => sectionStatus(row, network, onDate).status === 'operated'),
  });
}
