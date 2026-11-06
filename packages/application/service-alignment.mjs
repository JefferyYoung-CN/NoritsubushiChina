import { active } from './validation.mjs';
import { foldedLoop } from './folded-loop.mjs';

const matchesAt = (sequence, start, ids) => {
  for (let index = 0; index < ids.length; index++) {
    if (sequence[(start + index) % sequence.length] !== ids[index]) return false;
  }
  return true;
};

/** 线性服务：ids 必须是服务有序区间序列的连续一段，正序或逆序。 */
function linearMatch(sequence, ids) {
  if (ids.length > sequence.length) return false;
  for (let start = 0; start + ids.length <= sequence.length; start++) {
    let forward = true, reverse = true;
    for (let index = 0; index < ids.length; index++) {
      if (sequence[start + index] !== ids[index]) forward = false;
      if (sequence[start + index] !== ids[ids.length - 1 - index]) reverse = false;
    }
    if (forward || reverse) return true;
  }
  return false;
}

/** 环线服务：允许从任意位置起算的旋转连续段；长度等于全序列时任意旋转都表示整圈。 */
function ringMatch(sequence, ids) {
  if (ids.length > sequence.length) return false;
  for (let start = 0; start < sequence.length; start++) {
    if (matchesAt(sequence, start, ids) || matchesAt(sequence, start, [...ids].reverse())) return true;
  }
  return false;
}

/**
 * 服务序列首尾相接才是闭环；只有闭环服务允许按环线旋转匹配。
 * 非闭环序列（同一区间折返、或跨线再接回）不能把首尾接起来当成一圈。
 */
function isClosedCycle(sequence, sections) {
  if (sequence.length < 3) return false;
  let start = null, current = null;
  for (const id of sequence) {
    const section = sections.get(id);
    if (!section) return false;
    if (current === null) {
      start = section.fromStationId;
      current = section.toStationId;
    } else if (section.fromStationId === current) {
      current = section.toStationId;
    } else if (section.toStationId === current) {
      current = section.fromStationId;
    } else {
      return false;
    }
  }
  return current === start;
}

// 候选到站会逐站调用本判定；按网络缓存「服务序列 + 是否闭环」，避免重复建索引。
const sequenceCache = new WeakMap();

function serviceSequences(network, lineId, onDate) {
  let perNetwork = sequenceCache.get(network);
  if (!perNetwork) { perNetwork = new Map(); sequenceCache.set(network, perNetwork); }
  const key = lineId + '|' + onDate;
  const cached = perNetwork.get(key);
  if (cached) return cached;
  const sections = new Map(network.sections.map(row => [row.id, row]));
  const services = new Map(network.services.map(row => [row.id, row]));
  const groups = new Map();
  // 保持服务完整成员顺序：跨线区间不能被过滤掉，否则可能把不相邻的两段拼成连续。
  for (const member of network.memberships) {
    if (!active(member, onDate)) continue;
    const section = sections.get(member.sectionId), service = services.get(member.serviceId);
    if (!section || !service || !active(section, onDate) || !active(service, onDate)) continue;
    const group = groups.get(member.serviceId);
    if (group) group.push(member); else groups.set(member.serviceId, [member]);
  }
  const entries = [];
  for (const [serviceId, members] of groups) {
    if (!members.some(member => sections.get(member.sectionId)?.lineId === lineId)) continue;
    const sequence = members.slice().sort((left, right) => left.sequence - right.sequence)
      .map(member => member.sectionId);
    entries.push({ serviceId, sequence, cycle: isClosedCycle(sequence, sections) });
  }
  perNetwork.set(key, entries);
  return entries;
}

/**
 * 判断一次基础物理录入是否落在同一条当日运营服务的连续对齐内。
 * 成员、区间、服务都按录入日期过滤；环线仅在服务本身闭环时按折叠后的整圈处理。
 */
export function serviceAlignment(network, lineId, sectionIds, onDate) {
  if (!Array.isArray(sectionIds) || sectionIds.length === 0) return { aligned: false, serviceIds: [] };
  const ring = foldedLoop(network, lineId, onDate) !== null;
  const serviceIds = [];
  for (const { serviceId, sequence, cycle } of serviceSequences(network, lineId, onDate)) {
    if (linearMatch(sequence, sectionIds) || (ring && cycle && ringMatch(sequence, sectionIds))) serviceIds.push(serviceId);
  }
  return { aligned: serviceIds.length > 0, serviceIds };
}
