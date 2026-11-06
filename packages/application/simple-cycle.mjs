import { active, freeze } from './validation.mjs';

/**
 * 简单环线判定：只看当日成员区间的拓扑。
 *
 * 「简单环线」指某一天有效的一条运营服务，成员区间恰好组成一个闭合回路：车站不少于 3 个、
 * 每站正好连着两个区间、全部连通、无自环、无平行边、区间数等于站数，且按服务运行序
 * （memberships.sequence 升序）相邻走行能闭合覆盖全部区间。
 *
 * 判据只取拓扑：物理线路的 is_loop／foldStationId、方向标签与数组下标都不参与；配置与拓扑
 * 不一致时以拓扑为准。本判定不复用基础录入的 foldedLoop（那是把环展平成直线的手段，依赖
 * 折叠站与 directions[0] 锚点），两者的口径由测试用真实快照与构造数据对齐。
 */

// 端点对的结构化编码：站点身份可能自带分隔符，不能靠字符串拼接区分。
const pairKey = (left, right) => JSON.stringify(left < right ? [left, right] : [right, left]);

/** 两条区间共用的唯一端点；不共端点时返回 null。 */
function sharedStation(left, right) {
  const shared = [left.fromStationId, left.toStationId]
    .filter(stationId => stationId === right.fromStationId || stationId === right.toStationId);
  return shared.length === 1 ? shared[0] : null;
}

/**
 * 判定一组成员区间是否构成简单环线。
 *
 * @param members 该服务当日的成员区间，按服务运行序（sequence 升序）排列；
 *   每项至少含 `{ sectionId, fromStationId, toStationId }`。同一区间重复出现只计一次。
 * @returns `{ forward, reverse, sectionIds }`；不构成简单环线时返回 null。
 *   `forward` 是正序站序（长度等于区间数，不重复起始站），`reverse` 自同一站反向走行，
 *   `sectionIds[i]` 连接 `forward[i]` 与 `forward[i + 1]`（末项接回 `forward[0]`）。
 */
export function simpleCycle(members) {
  if (!Array.isArray(members)) return null;
  const seen = new Set();
  const ordered = [];
  for (const member of members) {
    if (typeof member?.sectionId !== 'string' || typeof member?.fromStationId !== 'string' ||
        typeof member?.toStationId !== 'string') return null;
    if (seen.has(member.sectionId)) continue;
    seen.add(member.sectionId);
    ordered.push(member);
  }
  const size = ordered.length;
  if (size < 3) return null;

  const adjacency = new Map();
  const pairs = new Set();
  for (const member of ordered) {
    const { fromStationId, toStationId } = member;
    if (fromStationId === toStationId) return null;
    const key = pairKey(fromStationId, toStationId);
    if (pairs.has(key)) return null;
    pairs.add(key);
    for (const [stationId, neighbourId] of [[fromStationId, toStationId], [toStationId, fromStationId]]) {
      if (!adjacency.has(stationId)) adjacency.set(stationId, []);
      adjacency.get(stationId).push(neighbourId);
    }
  }
  if (adjacency.size < 3) return null;
  if ([...adjacency.values()].some(neighbours => neighbours.length !== 2)) return null;
  // 区间数等于站数：每站度 2 已使 2|E| = 2|V|，这里保留为规格列出的显式验收条件。
  if (adjacency.size !== size) return null;

  const reached = new Set();
  const stack = [adjacency.keys().next().value];
  reached.add(stack[0]);
  while (stack.length > 0) {
    for (const neighbourId of adjacency.get(stack.pop())) {
      if (reached.has(neighbourId)) continue;
      reached.add(neighbourId);
      stack.push(neighbourId);
    }
  }
  if (reached.size !== adjacency.size) return null;

  // 按服务运行序 ±1 相邻走行必须闭合覆盖全部区间，并给出以序号为正向的站序。
  const forward = [sharedStation(ordered[size - 1], ordered[0])];
  if (forward[0] === null) return null;
  for (let index = 0; index < size - 1; index++) {
    const stationId = sharedStation(ordered[index], ordered[index + 1]);
    if (stationId === null) return null;
    forward.push(stationId);
  }
  if (new Set(forward).size !== size) return null;

  return freeze({
    forward: freeze(forward),
    reverse: freeze([forward[0], ...forward.slice(1).reverse()]),
    sectionIds: freeze(ordered.map(member => member.sectionId)),
  });
}

/**
 * 该运营服务在给定日期的简单环线判定。
 *
 * 成员区间按运营服务、区间、物理线路、成员关系四层期间过滤；同一区间只保留序号最小的一次。
 * 服务不存在或当天没有闭合成环时返回 null。
 */
export function serviceCycle(network, serviceId, onDate) {
  const service = network.services.find(row => row.id === serviceId);
  if (!service || !active(service, onDate)) return null;
  const sections = new Map(network.sections.map(row => [row.id, row]));
  const lines = new Map(network.lines.map(row => [row.id, row]));
  const members = [];
  for (const membership of network.memberships) {
    if (membership.serviceId !== serviceId || !active(membership, onDate)) continue;
    const section = sections.get(membership.sectionId);
    if (!section || !active(section, onDate)) continue;
    const line = lines.get(section.lineId);
    if (!line || !active(line, onDate)) continue;
    members.push({ sectionId: section.id, fromStationId: section.fromStationId,
      toStationId: section.toStationId, sequence: membership.sequence });
  }
  members.sort((left, right) => left.sequence - right.sequence);
  return simpleCycle(members);
}
