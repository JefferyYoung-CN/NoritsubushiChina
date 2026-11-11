/** 基础完乘按物理线路取区间，但整段必须落在同一条当日运营服务的连续对齐内；
 * 跨运营服务（需要换乘）的行程分段录入，运营服务的直通与运行顺序只属于进阶录入。 */
import { buildDateView, effectiveFoldedLoop } from '../../../../packages/application/date-view.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { active } from '../../../../packages/application/validation.mjs';
import { foldedInterval } from '../../../../packages/application/folded-loop.mjs';
import { stationOptions, stationDescription, tripMessage } from '../integration/trip';
import type { TripResult } from '../integration/trip';
import { foldEndKey, physicalRouteSequence, physicalSections } from './route-sequence';

export { physicalLoop, physicalRouteSequence, physicalSections } from './route-sequence';
export type { PhysicalRouteSequence, RouteArm, RouteArmRole, RouteGap, RoutePosition, RouteSection, RouteSegment } from './route-sequence';

export interface PhysicalSelection { physicalLineId: string; fromStationId: string; toStationId: string }
export function physicalLineOptions(network: TransitNetwork, onDate: string) {
  return network.lines.filter(line => physicalSections(network, line.id, onDate).length > 0)
    .map(line => ({ id: line.id, label: line.name }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN', { numeric: true }));
}

export interface LineFilterOption { readonly id: string; readonly label: string }
export interface LineFilterOptions {
  readonly cities: readonly LineFilterOption[];
  readonly operators: readonly LineFilterOption[];
  readonly lines: readonly LineFilterOption[];
}

function endpointCities(cityOf: ReadonlyMap<string, string>, sections: readonly { fromStationId: string; toStationId: string }[]) {
  const ids = new Set<string>();
  for (const section of sections) {
    for (const stationId of [section.fromStationId, section.toStationId]) {
      const cityId = cityOf.get(stationId);
      if (cityId) ids.add(cityId);
    }
  }
  return ids;
}

/**
 * 城市、运营商、线路三份候选共用「当日可录入的物理区间」这一口径：
 * 城市只列当日有物理线路站点的城市，运营商只列当日有有效运营服务覆盖的运营商，
 * 线路继续同时套用城市与运营商筛选。
 *
 * 运营商按「当日有区间经过所选城市」判定，不要求运营商的注册城市等于所选城市：
 * 示例城、示例市两地的地铁在对方城市都设有车站（如线网线），跨市线路的运营商必须留在
 * 候选里，否则用户选了城市就找不到这些线路的运营商。曾按注册城市严格匹配讨论过，
 * 会漏跨市线路，故不采用。
 *
 * 列城市时忽略已选城市、只应用已选运营商；列运营商时反过来。否则选中一维后，
 * 该维自己的候选列表会被自身筛空，用户再也切不回去。选中值已失效时由调用方清空。
 */
export function lineFilterOptions(network: TransitNetwork, onDate: string, city = '', operator = ''): LineFilterOptions {
  const lineOptions = physicalLineOptions(network, onDate);
  const sectionsByLine = new Map(lineOptions.map(option => [option.id, physicalSections(network, option.id, onDate)]));
  const physicalSectionsById = new Map([...sectionsByLine.values()].flat().map(section => [section.id, section]));
  const cityOf = new Map(network.stations.map(station => [station.id, station.cityId]));
  const servicesById = new Map(network.services.map(service => [service.id, service]));

  // 运营服务本身有效、且至少有一条当日有效的成员关系落在物理区间上，才算覆盖。
  const operatorsBySection = new Map<string, Set<string>>();
  const sectionsByOperator = new Map<string, Set<string>>();
  for (const member of network.memberships) {
    const section = physicalSectionsById.get(member.sectionId);
    const service = servicesById.get(member.serviceId);
    if (!section || !service || !active(member, onDate) || !active(service, onDate)) continue;
    if (!operatorsBySection.has(section.id)) operatorsBySection.set(section.id, new Set());
    operatorsBySection.get(section.id)!.add(service.operatorId);
    if (!sectionsByOperator.has(service.operatorId)) sectionsByOperator.set(service.operatorId, new Set());
    sectionsByOperator.get(service.operatorId)!.add(section.id);
  }
  const sectionsOfOperator = (operatorId: string) =>
    [...(sectionsByOperator.get(operatorId) ?? [])].flatMap(id => physicalSectionsById.get(id) ?? []);

  const physicalCities = new Set<string>();
  for (const sections of sectionsByLine.values()) {
    for (const cityId of endpointCities(cityOf, sections)) physicalCities.add(cityId);
  }

  const cities = network.cities.filter(row => (operator ? endpointCities(cityOf, sectionsOfOperator(operator)) : physicalCities).has(row.id))
    .map(row => ({ id: row.id, label: row.name }));
  const operators = network.operators.filter(row => {
    const sections = sectionsOfOperator(row.id);
    return sections.length > 0 && (!city || endpointCities(cityOf, sections).has(city));
  }).map(row => ({ id: row.id, label: row.name }));
  const lines = lineOptions.filter(option => {
    const sections = sectionsByLine.get(option.id) ?? [];
    if (operator && !sections.some(section => operatorsBySection.get(section.id)?.has(operator))) return false;
    return !city || endpointCities(cityOf, sections).has(city);
  });
  return { cities, operators, lines };
}

/**
 * 旧 DFS 前序站序，只保留给回滚与旧口径比对。基础记录页的站序已改由
 * `physicalRouteSequence` 承担，这里不再作为本站序来源：分叉线路上 DFS 前序会
 * 产出「相邻但无区间相连」的假相邻，不能用于新线路图。
 */
export function physicalStations(network: TransitNetwork, onDate: string, lineId: string) {
  const labels = new Map(stationOptions(network, onDate).map(row => [row.id, row]));
  const neighbours = new Map<string, Set<string>>();
  for (const section of physicalSections(network, lineId, onDate)) {
    for (const [a, b] of [[section.fromStationId, section.toStationId], [section.toStationId, section.fromStationId]]) {
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      neighbours.get(a)!.add(b);
    }
  }
  // 快照区间按身份存储，不能把文件行序当沿线站序。优先从声明的端点开始，支线逐支遍历。
  const line = network.lines.find(row => row.id === lineId);
  const declaredStart = line?.directions.map(row => row.fromStationId).find(id => id && neighbours.has(id));
  const start = declaredStart ?? [...neighbours].find(([, edges]) => edges.size === 1)?.[0] ?? neighbours.keys().next().value;
  const visited = new Set<string>();
  const ordered: { id: string; label: string }[] = [];
  for (const seed of [start, ...neighbours.keys()]) {
    const stack = seed ? [seed] : [];
    while (stack.length) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (labels.has(id)) ordered.push(labels.get(id)!);
      stack.push(...[...neighbours.get(id)!].reverse().filter(next => !visited.has(next)));
    }
  }
  return ordered;
}

export function physicalLinesAtStation(network: TransitNetwork, onDate: string, stationId: string) {
  return physicalLineOptions(network, onDate).filter(line => physicalStations(network, onDate, line.id).some(row => row.id === stationId));
}

export function buildPhysicalTrip(network: TransitNetwork, request: PhysicalSelection & { onDate: string }): TripResult {
  try {
    // 折叠解释与当日废线一致：被废线截断的环线按普通线路处理，不再套用折叠位置键。
    const loop = effectiveFoldedLoop(network, request.physicalLineId, request.onDate);
    // 到站筛选逐个调用此函数，只解析位置键；不为每个目标重建整网车站标签。
    const position = (key: string) => loop?.stationIds.findIndex((id, index) =>
      (index === loop.sections.length ? foldEndKey(id) : id) === key) ?? -1;
    const fromIndex = position(request.fromStationId), toIndex = position(request.toStationId);
    const route = loop ? foldedInterval(loop, fromIndex, toIndex) : null;
    if (loop && !route) return { ok: false, code: 'E_PATH', message: tripMessage('E_PATH') };
    const fromStationId = loop ? loop.stationIds[fromIndex] : request.fromStationId;
    const toStationId = loop ? loop.stationIds[toIndex] : request.toStationId;
    const view = buildDateView(network, { ...request, fromStationId, toStationId,
      serviceLineId: null, ...(route ? { sectionIds: route.map(row => row.id) } : {}) });
    if (!view.routeAvailable || ![fromStationId, toStationId].every(id => view.stations.some(row => row.id === id && row.passengerAvailable))) {
      return { ok: false, code: 'E_PATH', message: tripMessage('E_PATH') };
    }
    return { ok: true, view };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'E_UNKNOWN';
    return { ok: false, code, message: tripMessage(code) };
  }
}

/**
 * 表单位置序列：以整线分段派生为唯一站序来源，只保留当日办客的车站（直穿站仍占派生
 * 位置，但不作为可保存的起终点）。id 是表单位置键，stationId 才是事实身份；
 * 环线末端使用 fold-end 键，绝不把末端折叠站作为假车站保存。
 * label 是日期有效的 display_label（最小充分消歧），图上、无障碍名、手动下拉
 * 与回显行照抄同一份；description 只是手动候选的「城市 · 站码」副说明，供按城市/站码检索。
 */
export function physicalStops(network: TransitNetwork, onDate: string, lineId: string) {
  return physicalRouteSequence(network, onDate, lineId).positions
    .filter(position => position.drawsPoint)
    .map((position, index) => ({ id: position.positionKey, stationId: position.stationId, position: index,
      label: position.label, description: stationDescription(network, position.stationId) }));
}

export function physicalDestinations(network: TransitNetwork, onDate: string, lineId: string, fromStationId: string) {
  if (!fromStationId) return [];
  return physicalStops(network, onDate, lineId).filter(station => station.id !== fromStationId &&
    buildPhysicalTrip(network, { onDate, physicalLineId: lineId, fromStationId, toStationId: station.id }).ok);
}
