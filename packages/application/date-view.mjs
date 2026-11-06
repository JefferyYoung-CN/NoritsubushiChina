import { active, day, freeze, requireValue } from './validation.mjs';
import { foldedLoop, matchFoldedInterval } from './folded-loop.mjs';
import { serviceAlignment } from './service-alignment.mjs';
import { serviceCycle } from './simple-cycle.mjs';

const validatedViews = new WeakSet();
export const isDateView = view => validatedViews.has(view);
const previousDay = value => new Date(Date.parse(`${value}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

export function closureForSection(section, network, onDate) {
  return network.policies.closures.find(row => row.lineId === section.lineId && row.closedOn <= onDate &&
    (row.sectionIds === undefined || row.sectionIds.includes(section.id)));
}

export function statisticalSections(network, onDate) {
  return network.sections.filter(section => {
    const line = network.lines.find(row => row.id === section.lineId);
    const closure = closureForSection(section, network, onDate);
    const at = closure ? previousDay(closure.closedOn) : onDate;
    return line && active(section, at) && active(line, at);
  });
}

// Service membership may end during a temporary suspension before the physical
// section is declared retired. Preserve the last jointly valid ownership date.
export function serviceDateForSection(section, network, onDate) {
  const closure = closureForSection(section, network, onDate);
  if (!closure) return onDate;
  const line = network.lines.find(row => row.id === section.lineId);
  const dates = network.memberships.filter(row => row.sectionId === section.id).flatMap(member => {
    const service = network.services.find(row => row.id === member.serviceId);
    if (!line || !service) return [];
    const end = [closure.closedOn, member.until, section.until, line.until, service.until]
      .filter(value => value !== null).sort()[0];
    const at = previousDay(end);
    return [member, section, line, service].every(row => active(row, at)) ? [at] : [];
  });
  return dates.sort().at(-1) ?? previousDay(closure.closedOn);
}

function topology(network, serviceId, onDate) {
  const result = [];
  for (const member of network.memberships.filter(row => row.serviceId === serviceId)) {
    const section = network.sections.find(row => row.id === member.sectionId);
    const closure = closureForSection(section, network, onDate);
    const suspension = network.policies.suspensions.find(row => row.sectionIds.includes(section.id) &&
      row.from <= onDate && (row.until === null || onDate < row.until));
    const topologyDate = closure ? serviceDateForSection(section, network, onDate) : suspension ? previousDay(suspension.from) : onDate;
    const line = network.lines.find(row => row.id === section.lineId);
    const service = network.services.find(row => row.id === member.serviceId);
    if (active(member, topologyDate) && active(section, topologyDate) && active(line, topologyDate) && active(service, topologyDate)) result.push(section);
  }
  return [...new Map(result.map(row => [row.id, row])).values()];
}

function findPath(sections, from, to, excluded = null) {
  const graph = new Map();
  for (const section of sections) {
    if (section.id === excluded) continue;
    for (const [start, end] of [[section.fromStationId, section.toStationId], [section.toStationId, section.fromStationId]]) {
      if (!graph.has(start)) graph.set(start, []);
      graph.get(start).push({ end, section });
    }
  }
  const queue = [from];
  const parents = new Map([[from, null]]);
  for (let index = 0; index < queue.length && !parents.has(to); index++) {
    for (const edge of graph.get(queue[index]) ?? []) {
      if (parents.has(edge.end)) continue;
      parents.set(edge.end, { start: queue[index], section: edge.section });
      queue.push(edge.end);
    }
  }
  if (!parents.has(to)) return null;
  const result = [];
  for (let current = to; current !== from;) {
    const edge = parents.get(current);
    result.unshift(edge.section);
    current = edge.start;
  }
  return result;
}

/**
 * 逐段重放服务型记录已存的有序区间：每段都必须是该服务当日的成员区间、与上一段首尾
 * 相接，末段正好落到记录终点站。带显式区间的服务型请求不再用 findPath——环线上无向图
 * 总有两条径路，它只会挑最短的一条并报 E_MULTIPATH，分不清用户所选方向，也会把合法的
 * 方向记录判成待处理。
 */
function replaySections(sections, request) {
  const memberById = new Map(sections.map(row => [row.id, row]));
  let cursor = request.fromStationId;
  const route = [];
  for (const sectionId of request.sectionIds) {
    const section = memberById.get(sectionId);
    requireValue(section, 'E_PATH', 'request.sectionIds', 'Stored section is not a member of the service on date');
    requireValue(section.fromStationId === cursor || section.toStationId === cursor,
      'E_PATH', 'request.sectionIds', 'Stored sections must form one continuous path from the origin');
    cursor = section.fromStationId === cursor ? section.toStationId : section.fromStationId;
    route.push(section);
  }
  requireValue(route.length > 0, 'E_PATH', 'request.sectionIds', 'Stored path requires at least one section');
  requireValue(cursor === request.toStationId, 'E_PATH', 'request', 'Stored path must end at the requested station');
  return route;
}

/**
 * 环线重放：已存区间必须从起点沿同一方向连续走行。走满 m 段后落在环上第
 * (start + direction × m) 站，因此回到起点只可能是 m 为圈长整数倍（整圈 × k）；
 * 不同站之间是「k 圈 + 末段同方向半圈」。折返与跳段都不满足逐段序号推进。
 * 返回走行方向（ASC 记 1、DESC 记 -1），不成立时返回 null。
 */
function replayCycle(cycle, fromStationId, toStationId, sectionIds) {
  if (!cycle) return null;
  const size = cycle.sectionIds.length;
  const start = cycle.forward.indexOf(fromStationId);
  if (start < 0 || sectionIds.length === 0) return null;
  for (const direction of [1, -1]) {
    // 递增方向第 k 段是 forward[p + k] 发出的区间；递减方向第 k 段是 forward[p - k - 1] 发出的。
    const indexOf = step => (direction === 1 ? start + step : start - step - 1);
    if (!sectionIds.every((id, step) => cycle.sectionIds[((indexOf(step) % size) + size) % size] === id)) continue;
    const end = cycle.forward[(((start + direction * sectionIds.length) % size) + size) % size];
    if (end !== toStationId) continue;
    if (fromStationId === toStationId && sectionIds.length % size !== 0) continue;
    return direction;
  }
  return null;
}

export function sectionStatus(section, network, onDate) {
  const closure = closureForSection(section, network, onDate);
  if (closure) return { status: 'retired', retiredOn: closure.closedOn };
  const suspension = network.policies.suspensions.find(row => row.sectionIds.includes(section.id) &&
    row.from <= onDate && (row.until === null || onDate < row.until));
  return suspension ? { status: 'temporary' } : { status: 'operated' };
}

/**
 * 当日真正可按折叠环处理的线路：折叠成立，且没有任何闭环区间被判永久关闭。
 * 被废线截断的环线不再是「简单环」，折叠位置键与折叠区间校验都必须一起失效；
 * 这里只统一折叠判定，findPath 的取边范围仍维持既有语义（含当日 active 但永久废线的区间）。
 */
export function effectiveFoldedLoop(network, lineId, onDate) {
  const loop = foldedLoop(network, lineId, onDate);
  if (!loop || loop.sections.some(row => sectionStatus(row, network, onDate).status === 'retired')) return null;
  return loop;
}

export function mileage(network, sections) {
  const absent = sections.filter(row => network.policies.noMileageSections.includes(row.id));
  const measured = sections.filter(row => !network.policies.noMileageSections.includes(row.id));
  const incomplete = measured.some(row => row.lengthMetres === null);
  const measuredLength = incomplete ? null : measured.reduce((sum, row) => sum + row.lengthMetres, 0);
  requireValue(measuredLength === null || Number.isSafeInteger(measuredLength), 'E_MILEAGE', 'statistics.lengthMetres', 'Mileage total exceeds safe integer range');
  const mileageGroups = [];
  if (measured.length) mileageGroups.push({ basis: 'metres', sectionCount: measured.length, lengthMetres: measuredLength });
  if (absent.length) mileageGroups.push({ basis: 'sections', sectionCount: absent.length, lengthMetres: null });
  return { mileageStatus: incomplete ? 'incomplete' : absent.length ? 'not-provided' : 'available',
    statisticsBasis: incomplete || (absent.length && measured.length) ? 'unavailable' : absent.length ? 'sections' : 'metres',
    noMileageLabel: absent.length > 0, lengthMetres: absent.length ? null : measuredLength, mileageGroups };
}

/**
 * 日期视图的唯一构建入口：把「物理线路或运营服务 + 起终点」解析成当日的录入/统计视图。
 *
 * 调用契约（ADR-0011「已知限制与调用契约」）：
 * - request.onDate 必须在 1997-01-01 与 network.knowledgeThrough 之间，否则抛 E_DATE。
 * - physicalLineId 与 serviceLineId 互斥；物理线路分支要求 serviceLineId === null，给了
 *   sectionIds 时必须是该线当日唯一径路的完整有序序列，否则抛 E_PATH。
 * - 物理线路分支另外要求有序区间属于同一条当日运营服务的连续一段，否则抛
 *   E_SERVICE_ALIGN。这是「需要换乘或应分段录入」的业务结论，不是系统故障。
 * - 服务型分支给了 sectionIds 时：当日成员区间构成简单环线则按已存有序区间重放核验
 *   （同一方向整圈 × k + 末段同方向半圈；同站起终点只在环线上成立）；非简单环线恢复
 *   既有唯一径路核验（与 findPath 的唯一结果逐段一致，记录内区间不得重复，多径路拒绝），
 *   同站起终点仍抛 E_PATH。
 * - 其余路径歧义以 E_PATH、E_MULTIPATH 抛出。
 *
 * 调用方责任：任何聚合或展示路径都必须把 E_SERVICE_ALIGN 转换成待处理原因
 * service-alignment-required（completion.resolve 与 topology-mapping.mapRecordFacts
 * 已这样做），不得把字面错误码透给用户。
 *
 * @param {{ snapshotId: string, knowledgeThrough: string }} network 已验证的 TransitNetwork。
 * @param {{ onDate: string, fromStationId: string, toStationId: string, serviceLineId: string|null,
 *   physicalLineId?: string, sectionIds?: string[] }} request 录入或统计请求。
 * @returns {object} 冻结的日期视图；调用方不得改写。
 */
export function buildDateView(network, request) {
  requireValue(request && typeof request === 'object', 'E_PATH', 'request', 'Path request is required');
  const onDate = day(request.onDate, 'request.onDate', '1997-01-01');
  requireValue(onDate <= network.knowledgeThrough, 'E_DATE', 'request.onDate', 'Date exceeds verified business horizon');
  let route = [];
  if (!(request.fromStationId === null && request.toStationId === null && request.serviceLineId === null && !request.physicalLineId)) {
    const explicit = request.sectionIds !== undefined;
    if (request.physicalLineId) {
      // 基础录入分支沿用既有规则：折叠环只认展开后的连续一段，其余按唯一物理径路。
      requireValue(request.serviceLineId === null, 'E_PATH', 'request', 'Choose a physical line or a service, not both');
      const line = network.lines.find(row => row.id === request.physicalLineId);
      requireValue(line && active(line, onDate), 'E_PATH', 'request.physicalLineId', 'Physical line unavailable on date');
      const sections = network.sections.filter(row => row.lineId === line.id && active(row, onDate));
      const loop = effectiveFoldedLoop(network, request.physicalLineId, onDate);
      requireValue(request.fromStationId !== request.toStationId || (loop && explicit), 'E_PATH', 'request',
        'Path endpoints must differ except a validated folded loop');
      if (loop && explicit) {
        route = matchFoldedInterval(loop, request.fromStationId, request.toStationId, request.sectionIds);
        requireValue(route, 'E_PATH', 'request.sectionIds', 'Path must be one interval of the folded loop');
      } else {
        route = findPath(sections, request.fromStationId, request.toStationId);
        requireValue(route?.length, 'E_PATH', 'request', 'No route for date');
        requireValue(!route.some(row => findPath(sections, request.fromStationId, request.toStationId, row.id)),
          'E_MULTIPATH', 'request', 'More than one route for date');
        if (explicit) requireValue(Array.isArray(request.sectionIds) &&
          request.sectionIds.length === route.length && route.every((row, index) => row.id === request.sectionIds[index]),
          'E_PATH', 'request.sectionIds', 'Explicit sections must match the unique physical path');
      }
      requireValue(serviceAlignment(network, request.physicalLineId, route.map(row => row.id), onDate).aligned,
        'E_SERVICE_ALIGN', 'request', 'Path must align with a single service alignment');
    } else {
      const service = network.services.find(row => row.id === request.serviceLineId);
      requireValue(service, 'E_PATH', 'request.serviceLineId', 'Service line unavailable');
      const sections = topology(network, service.id, onDate);
      requireValue(active(service, onDate) || sections.some(row => sectionStatus(row, network, onDate).status !== 'operated'),
        'E_PATH', 'request.serviceLineId', 'Service line unavailable on date');
      if (explicit) {
        const cycle = serviceCycle(network, service.id, onDate);
        if (cycle) {
          // 环线上 findPath 只会给最短径路并判多径路，分不清方向：按已存区间重放核验。
          route = replaySections(sections, request);
          requireValue(replayCycle(cycle, request.fromStationId, request.toStationId, request.sectionIds),
            'E_PATH', 'request.sectionIds', 'Ride must follow one direction of the simple cycle');
        } else {
          // 非简单环线没有「整圈/方向」语义，恢复既有口径：唯一径路核验 + 记录内区间不得重复。
          // 同站起终点仍然拒绝（E_PATH），与改动前一致。
          requireValue(request.fromStationId !== request.toStationId, 'E_PATH', 'request',
            'Same-station rides are only supported on a simple cycle');
          requireValue(new Set(request.sectionIds).size === request.sectionIds.length,
            'E_PATH', 'request.sectionIds', 'Non-cycle rides cannot repeat the same section');
          route = findPath(sections, request.fromStationId, request.toStationId);
          requireValue(route?.length, 'E_PATH', 'request', 'No route for date');
          // 多条径路时「已存区间」不构成可核验的唯一事实；错误码与原因都不新增。
          requireValue(!route.some(row => findPath(sections, request.fromStationId, request.toStationId, row.id)),
            'E_PATH', 'request', 'More than one route for date; stored sections cannot be verified');
          requireValue(Array.isArray(request.sectionIds) && request.sectionIds.length === route.length &&
            route.every((row, index) => row.id === request.sectionIds[index]),
            'E_PATH', 'request.sectionIds', 'Stored sections must match the unique path');
        }
      } else {
        route = findPath(sections, request.fromStationId, request.toStationId);
        requireValue(route?.length, 'E_PATH', 'request', 'No route for date');
        requireValue(!route.some(row => findPath(sections, request.fromStationId, request.toStationId, row.id)),
          'E_MULTIPATH', 'request', 'More than one route for date');
      }
    }
  }
  const normalSections = route.filter(row => sectionStatus(row, network, onDate).status !== 'retired');
  const retiredSections = route.filter(row => sectionStatus(row, network, onDate).status === 'retired');
  const temporarySections = route.filter(row => sectionStatus(row, network, onDate).status === 'temporary');
  const stationIds = new Set(route.flatMap(row => [row.fromStationId, row.toStationId]));
  const stations = network.stations.filter(row => stationIds.has(row.id)).map(row => ({ ...row,
    name: network.names.find(name => name.stationId === row.id && active(name, onDate))?.name ?? null,
    passengerAvailable: network.passengerPeriods.some(period => period.stationId === row.id && period.kind === 'passenger' && active(period, onDate)) }));
  const retiredTopologyDates = [...new Set(retiredSections.map(section => previousDay(sectionStatus(section, network, onDate).retiredOn)))].sort();
  const view = freeze({ kind: 'date-view', snapshotId: network.snapshotId, sourceKind: network.sourceKind,
    sourceUse: network.sourceUse, attribution: network.attribution, releaseReady: false, onDate, serviceLineId: request.serviceLineId,
    ...(request.physicalLineId ? { physicalLineId: request.physicalLineId } : {}),
    fromStationId: request.fromStationId, toStationId: request.toStationId, empty: route.length === 0,
    routeAvailable: route.length > 0 && route.every(row => sectionStatus(row, network, onDate).status === 'operated'),
    mapAvailable: stations.length > 0 && stations.every(row => row.latitude !== null && row.longitude !== null),
    normalSections, retiredSections, temporarySections, stations,
    normalLengthMetres: mileage(network, normalSections).lengthMetres,
    retiredLengthMetres: mileage(network, retiredSections).lengthMetres,
    ...Object.fromEntries(Object.entries(mileage(network, route)).filter(([key]) => key !== 'lengthMetres')),
    retiredTopologyDates, retiredTopologyDate: retiredTopologyDates.length === 1 ? retiredTopologyDates[0] : null });
  validatedViews.add(view);
  return view;
}

export function observation(view) {
  return { empty: view.empty, map_available: view.mapAvailable, mileage_status: view.mileageStatus, no_mileage_label: view.noMileageLabel,
    normal_length_m: view.normalLengthMetres, normal_section_count: view.normalSections.length, normal_section_ids: view.normalSections.map(row => row.id),
    operated_section_count: view.normalSections.filter(row => !view.temporarySections.some(item => item.id === row.id)).length,
    retired_length_m: view.retiredLengthMetres, retired_section_count: view.retiredSections.length, retired_section_ids: view.retiredSections.map(row => row.id),
    retired_topology_date: view.retiredTopologyDate, route_available: view.routeAvailable, statistics_basis: view.statisticsBasis, temporary_section_count: view.temporarySections.length };
}
