/**
 * 拓扑映射纯函数。
 *
 * 职责：把历史区间、直通、径路事实投影到「统计所用快照」的当前拓扑上，产出可注入
 * completion 重算的映射结果；映射失败的事实整条保留为待处理，不进入派生结果。
 *
 * 输入（全部由调用方拥有，本模块只读、不改写入参、不读写存储、不碰 DOM/Node API）：
 *   facts    —— 记录事实 { basic: Record[], advanced: Record[] }，形状与 records.mjs
 *               decodeFacts 的产出一致；这里按映射需要的最小字段重新校验，不越权改语义。
 *   network  —— reader.mjs 解码出的 TransitNetwork（统计日期对应的业务生效快照）。
 *   onDate   —— 统计日期；occurredOn 晚于它的事实不参与本次映射（与 completion 的过滤一致）。
 *   reviewed —— 可选，已复核映射输入，三者缺省皆为空（此时一切跨快照/多段直通事实保持待处理）：
 *     snapshots           旧快照身份白名单；不在其中且与 network.snapshotId 不同 → 待处理。
 *     stationSplits       [{ retiredStationId, targetStationIds }]，来自已复核的
 *                         站点来源映射批次；只用于把旧身份按「当前区间端点」唯一定位到目标站。
 *     throughServicePairs 显式维护的运营线路对（无序数组对）；直通事实只在显式关系齐备时
 *                         才可映射。绝不从共享车站/邻接/连通性推断，这里也没有推断代码。
 *
 * 输出：{ mappedFacts, pending }（经 validation.independent 深冻结的独立快照）。
 *   mappedFacts[i] = { recordId, layer, occurredOn, fromStationId, toStationId, sections }
 *     sections[j] = { sectionId, completedOn }，sectionId 为当前快照区间身份；
 *     completedOn 默认等于事实发生日期，合并区间则等于「覆盖其全部旧区间的最晚完乘日期」。
 *   pending[i] = { recordId, layer, reason }，reason 只取 PENDING_REASONS 五类之一。
 *
 * pending 语义：五类原因都不是错误码，不计数、不进入统计结果；本模块永不以 E_SNAPSHOT
 * 抛出——E_SNAPSHOT 仅表示统计上下文无效（未选快照、统计日期超出已验证知识范围），由
 * completion.calculateCompletion 自己判断。
 *
 * 合并规则：一个合并区间只有在它的
 * 全部旧区间都出现在可映射事实中、且这些成员在单条径路里连续时，才产生合并结果，完乘
 * 日期取最晚；只要有一个旧区间缺位，触及该组的事实整条保留为待处理，不做部分合并。
 *
 * 与 completion 的注入点：completion 在 evaluate 每条事实的位置调用本函数
 * （逐层传入 { facts, network, onDate, reviewed }），用 mappedFacts 的 sections 取代原先
 * record.sectionIds 的直接累加，pending 直接并入 completion 的 pending 数组。completion
 * 的 accumulate 取最早日期，因此合并组内每条事实都携带组内最晚日期即可保证最终最早日期正确。
 */
import { active, array, day, freeze, independent, object, requireValue, text } from './validation.mjs';
import { buildDateView, sectionStatus } from './date-view.mjs';

/**
 * 五类待处理原因：不是错误码，不计入统计结果。
 * 'service-alignment-required' 对应 buildDateView 的 E_SERVICE_ALIGN：有序区间不属于同一条
 * 当日运营服务，通常意味着需要换乘、应分段录入。它与 'path-mapping-required'（径路与当前
 * 快照的区间序列不一致）分开，面板才能给出不同的用户动作。
 */
export const PENDING_REASONS = freeze([
  'snapshot-mapping-required',
  'through-service-mapping-required',
  'path-mapping-required',
  'topology-mapping-required',
  'service-alignment-required',
]);

const LAYERS = ['basic', 'advanced'];

function sectionIds(value, path) {
  const rows = array(value, path, 10000);
  requireValue(rows.length > 0, 'E_FIELDS', path, 'At least one section is required');
  const seen = new Set();
  const result = rows.map((row, index) => {
    const id = text(row, `${path}[${index}]`, 500);
    requireValue(!seen.has(id), 'E_DUPLICATE', `${path}[${index}]`, 'Duplicate section identity');
    seen.add(id);
    return id;
  });
  return result;
}

function decodeRecord(row, path) {
  object(row, path);
  const serviceLineIds = array(row.serviceLineIds, `${path}.serviceLineIds`, 100)
    .map((id, index) => text(id, `${path}.serviceLineIds[${index}]`, 500));
  const physicalLineId = row.physicalLineId === undefined ? undefined : text(row.physicalLineId, `${path}.physicalLineId`, 500);
  requireValue(physicalLineId ? serviceLineIds.length === 0 : serviceLineIds.length > 0,
    'E_FIELDS', `${path}.serviceLineIds`, 'Physical and service paths must be distinct');
  return {
    id: text(row.id, `${path}.id`, 500),
    occurredOn: day(row.occurredOn, `${path}.occurredOn`),
    networkSnapshotId: text(row.networkSnapshotId, `${path}.networkSnapshotId`, 500),
    fromStationId: text(row.fromStationId, `${path}.fromStationId`, 500),
    toStationId: text(row.toStationId, `${path}.toStationId`, 500),
    serviceLineIds,
    ...(physicalLineId ? { physicalLineId } : {}),
    sectionIds: sectionIds(row.sectionIds, `${path}.sectionIds`),
  };
}

/** 线路对按无序比较，方向和先后都不敏感（只按线路对维护）。 */
function pairKey(left, right) {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function decodeReviewed(reviewed) {
  const result = { snapshots: new Set(), splits: new Map(), pairs: new Set() };
  if (reviewed === undefined || reviewed === null) return result;
  object(reviewed, 'mapping.reviewed');
  for (const [index, raw] of array(reviewed.snapshots ?? [], 'mapping.reviewed.snapshots', 1000).entries()) {
    result.snapshots.add(text(raw, `mapping.reviewed.snapshots[${index}]`, 500));
  }
  for (const [index, raw] of array(reviewed.stationSplits ?? [], 'mapping.reviewed.stationSplits', 1000).entries()) {
    const path = `mapping.reviewed.stationSplits[${index}]`;
    object(raw, path);
    const retired = text(raw.retiredStationId, `${path}.retiredStationId`, 500);
    const targets = array(raw.targetStationIds, `${path}.targetStationIds`, 20)
      .map((id, at) => text(id, `${path}.targetStationIds[${at}]`, 500));
    requireValue(targets.length > 0, 'E_FIELDS', `${path}.targetStationIds`, 'At least one split target is required');
    requireValue(!result.splits.has(retired), 'E_DUPLICATE', `${path}.retiredStationId`, 'Duplicate retired station identity');
    result.splits.set(retired, freeze([...new Set(targets)]));
  }
  for (const [index, raw] of array(reviewed.throughServicePairs ?? [], 'mapping.reviewed.throughServicePairs', 1000).entries()) {
    const path = `mapping.reviewed.throughServicePairs[${index}]`;
    const pair = array(raw, path, 2).map((id, at) => text(id, `${path}[${at}]`, 500));
    requireValue(pair.length === 2, 'E_FIELDS', path, 'A through service pair needs exactly two service lines');
    result.pairs.add(pairKey(pair[0], pair[1]));
  }
  return result;
}

/**
 * 从快照构建只读索引。映射表是「区间已被更替」的唯一依据；区间 ID 与时期在复核转换中
 * 保持不变，因此同一快照内的历史区间按引用直接命中，旧快照身份按映射表改写。
 */
function buildTopology(network) {
  const sections = new Map();
  for (const row of network.sections) {
    sections.set(row.id, { id: row.id, fromStationId: row.fromStationId, toStationId: row.toStationId });
  }
  const stations = new Set(network.stations.map(row => row.id));
  const oldToNew = new Map();
  const newToOlds = new Map();
  for (const row of network.mappings ?? []) {
    const targets = oldToNew.get(row.oldSectionId) ?? new Set();
    targets.add(row.newSectionId);
    oldToNew.set(row.oldSectionId, targets);
    const olds = newToOlds.get(row.newSectionId) ?? new Set();
    olds.add(row.oldSectionId);
    newToOlds.set(row.newSectionId, olds);
  }
  // 多旧→一新的合并组；1:1 映射不构成合并组，直接按单条目标改写。
  const groups = new Map();
  const groupOfOld = new Map();
  for (const [targetId, olds] of newToOlds) {
    if (olds.size < 2 || !sections.has(targetId)) continue;
    const group = freeze({ targetId, olds: [...olds] });
    groups.set(targetId, group);
    for (const old of olds) groupOfOld.set(old, group);
  }
  return { snapshotId: network.snapshotId, sections, stations, oldToNew, groups, groupOfOld };
}

/** 单区间映射：映射表优先于同 ID 命中（派生结果一律使用当前身份）。 */
function mapSectionId(sectionId, topology) {
  const targets = topology.oldToNew.get(sectionId);
  if (targets) {
    if (targets.size !== 1) return { reason: 'topology-mapping-required' };
    const [targetId] = targets;
    if (!topology.sections.has(targetId)) return { reason: 'topology-mapping-required' };
    return { sectionId: targetId };
  }
  if (topology.sections.has(sectionId)) return { sectionId };
  return { reason: 'topology-mapping-required' };
}

/**
 * 站身份解析：当前快照中存在的站按引用命中；不存在时只在已复核拆分表登记过、且当前区间
 * 端点能唯一定位一个目标时才映射（历史办客期）。上下文不足或仍有
 * 多个目标时返回失败，绝不在同名站之间猜测。
 */
function stationIdentity(stationId, section, topology, reviewed) {
  if (topology.stations.has(stationId)) return { stationId };
  const targets = reviewed.splits.get(stationId);
  if (!targets) return { reason: 'station-identity-unresolved' };
  const candidates = targets.filter(target => target === section.fromStationId || target === section.toStationId);
  if (candidates.length !== 1) return { reason: 'station-identity-ambiguous' };
  return { stationId: candidates[0] };
}

function sharesStation(left, right) {
  return left.fromStationId === right.fromStationId || left.fromStationId === right.toStationId ||
    left.toStationId === right.fromStationId || left.toStationId === right.toStationId;
}

function touchesStation(section, stationId) {
  return section.fromStationId === stationId || section.toStationId === stationId;
}

/** 评估单条事实：返回可映射候选，或五类原因之一。 */
function evaluate(record, topology, reviewed, network) {
  const crossSnapshot = record.networkSnapshotId !== topology.snapshotId;
  if (crossSnapshot && !reviewed.snapshots.has(record.networkSnapshotId)) {
    return { reason: 'snapshot-mapping-required' };
  }
  // 不变量核验（不是待处理常态）：链式录入只允许直通接续，多段只表示同一趟车跨服务身份，
  // 因为记录层不保存接续方式，「多服务」是唯一可用的运行时信号。触发本 check 只有两种原因：
  // 历史存量的旧「换乘链」记录，或数据发布方漏维护线路对；两者都是缺陷/历史遗留信号。
  // 因此本检查必须保留：删掉它等于把跨服务的畸形记录静默当作合法直通。
  if (record.serviceLineIds.length > 1) {
    for (let index = 1; index < record.serviceLineIds.length; index += 1) {
      if (!reviewed.pairs.has(pairKey(record.serviceLineIds[index - 1], record.serviceLineIds[index]))) {
        return { reason: 'through-service-mapping-required' };
      }
    }
  }
  const mappedIds = [];
  for (const sectionId of record.sectionIds) {
    const mapped = mapSectionId(sectionId, topology);
    if (mapped.reason) return mapped;
    mappedIds.push(mapped.sectionId);
  }
  // 几何一律取自记录的原始区间行：复核转换保持区间 ID 与时期、只改写站引用，
  // 合并组的原始行才保留记录当时的真实站端点；当前身份另由 mappedIds 给出。
  const path = record.sectionIds.map((id, index) => topology.sections.get(id) ?? topology.sections.get(mappedIds[index]));
  const from = stationIdentity(record.fromStationId, path[0], topology, reviewed);
  const to = stationIdentity(record.toStationId, path[path.length - 1], topology, reviewed);
  if (from.reason || to.reason) return { reason: crossSnapshot ? 'snapshot-mapping-required' : 'topology-mapping-required' };
  if (!touchesStation(path[0], from.stationId) || !touchesStation(path[path.length - 1], to.stationId)) {
    return { reason: 'path-mapping-required' };
  }
  // Geometry alone cannot establish that a passenger ride actually existed. Validate
  // the original historical rows before projecting identities to today's topology.
  const date = record.occurredOn;
  const services = record.serviceLineIds.map(id => network.services.find(row => row.id === id));
  if (services.some(service => !service || !active(service, date))) return { reason: 'path-mapping-required' };
  const passenger = id => network.passengerPeriods.some(row => row.stationId === id && row.kind === 'passenger' && active(row, date));
  if (!passenger(from.stationId) || !passenger(to.stationId)) return { reason: 'path-mapping-required' };
  const usedServices = new Set();
  let cursor = from.stationId;
  let lastService = -1;
  for (const id of record.sectionIds) {
    const section = network.sections.find(row => row.id === id);
    const line = section && network.lines.find(row => row.id === section.lineId);
    if (!section || !line || !active(section, date) || !active(line, date) || sectionStatus(section, network, date).status !== 'operated') {
      return { reason: 'path-mapping-required' };
    }
    if (record.physicalLineId && section.lineId !== record.physicalLineId) return { reason: 'path-mapping-required' };
    if (!touchesStation(section, cursor)) return { reason: 'path-mapping-required' };
    cursor = section.fromStationId === cursor ? section.toStationId : section.fromStationId;
    const available = record.serviceLineIds.map((serviceId, index) => ({ serviceId, index })).filter(({ serviceId, index }) =>
      index >= lastService && network.memberships.some(row => row.serviceId === serviceId && row.sectionId === id && active(row, date)));
    if (!record.physicalLineId) {
      if (!available.length) return { reason: 'path-mapping-required' };
      const chosen = available[0];
      usedServices.add(chosen.serviceId);
      lastService = chosen.index;
    }
  }
  if (cursor !== to.stationId || usedServices.size !== new Set(record.serviceLineIds).size) return { reason: 'path-mapping-required' };
  if (services.length === 1 || record.physicalLineId) {
    try {
      const view = buildDateView(network, { onDate: date, fromStationId: from.stationId,
        toStationId: to.stationId, serviceLineId: record.physicalLineId ? null : services[0].id,
        // 进阶记录同样按已存有序区间核验，不使用 BFS 最短径路（环线上会误判多径路）。
        sectionIds: record.sectionIds,
        ...(record.physicalLineId ? { physicalLineId: record.physicalLineId } : {}) });
      if (!view.routeAvailable || view.normalSections.length !== record.sectionIds.length ||
          view.normalSections.some((row, index) => row.id !== record.sectionIds[index])) return { reason: 'path-mapping-required' };
    } catch (error) {
      // 对齐失败（需要换乘/分段录入）与径路不一致对应不同的用户动作，分开上报。
      return { reason: error?.code === 'E_SERVICE_ALIGN' ? 'service-alignment-required' : 'path-mapping-required' };
    }
  }
  for (let index = 1; index < path.length; index += 1) {
    if (!sharesStation(path[index - 1], path[index])) return { reason: 'path-mapping-required' };
  }
  // 合并组成员在单条径路里必须连续，否则映射后径路断开，不做部分合并。
  const touched = new Map();
  for (const [index, sectionId] of record.sectionIds.entries()) {
    const group = topology.groupOfOld.get(sectionId);
    if (!group) continue;
    const entry = touched.get(group.targetId) ?? { group, indexes: [], olds: new Set() };
    entry.indexes.push(index);
    entry.olds.add(sectionId);
    touched.set(group.targetId, entry);
  }
  for (const entry of touched.values()) {
    const { indexes } = entry;
    if (indexes[indexes.length - 1] - indexes[0] + 1 !== indexes.length) return { reason: 'path-mapping-required' };
  }
  return { record, mappedIds, fromStationId: from.stationId, toStationId: to.stationId, touched };
}

/**
 * 把事实集映射到快照拓扑。
 * @param {{ facts: object, network: object, onDate: string, reviewed?: object }} input
 * @returns {{ mappedFacts: object[], pending: { recordId: string, layer: string, reason: string }[] }}
 */
export function mapRecordFacts(input = {}) {
  object(input, 'mapping');
  const facts = object(input.facts, 'mapping.facts');
  day(input.onDate, 'mapping.onDate', '1997-01-01');
  const network = object(input.network, 'mapping.network');
  requireValue(typeof network.snapshotId === 'string' && Array.isArray(network.stations) &&
    Array.isArray(network.sections), 'E_FORMAT', 'mapping.network', 'Expected a decoded transit snapshot');
  const topology = buildTopology(network);
  const reviewed = decodeReviewed(input.reviewed);
  const identities = new Set();
  const records = [];
  for (const layer of LAYERS) {
    const rows = array(facts[layer] ?? [], `mapping.facts.${layer}`, 10000);
    for (const [index, row] of rows.entries()) {
      const path = `mapping.facts.${layer}[${index}]`;
      const record = decodeRecord(row, path);
      requireValue(layer === 'basic' || !record.physicalLineId, 'E_FIELDS', path, 'Advanced records require service paths');
      requireValue(!identities.has(record.id), 'E_DUPLICATE', `${path}.id`, 'Duplicate record identity');
      identities.add(record.id);
      records.push({ layer, record });
    }
  }
  const mappedFacts = [];
  const pending = [];
  for (const layer of LAYERS) {
    const candidates = [];
    for (const { layer: owner, record } of records) {
      if (owner !== layer || record.occurredOn > input.onDate) continue;
      const result = evaluate(record, topology, reviewed, network);
      if (result.reason) pending.push({ recordId: record.id, layer, reason: result.reason });
      else candidates.push(result);
    }
    // 合并组覆盖判定：组内每个旧区间都要出现在可映射事实里。
    const coverage = new Map();
    const dates = new Map();
    for (const candidate of candidates) {
      for (const [targetId, entry] of candidate.touched) {
        const covered = coverage.get(targetId) ?? new Set();
        for (const old of entry.olds) covered.add(old);
        coverage.set(targetId, covered);
        const previous = dates.get(targetId);
        if (!previous || candidate.record.occurredOn > previous) dates.set(targetId, candidate.record.occurredOn);
      }
    }
    const incomplete = new Set();
    for (const [targetId, covered] of coverage) {
      const { olds } = topology.groups.get(targetId);
      if (olds.some(old => !covered.has(old))) incomplete.add(targetId);
    }
    for (const candidate of candidates) {
      if ([...candidate.touched.keys()].some(targetId => incomplete.has(targetId))) {
        pending.push({ recordId: candidate.record.id, layer, reason: 'topology-mapping-required' });
        continue;
      }
      const emitted = new Set();
      const sections = [];
      for (const [index, old] of candidate.record.sectionIds.entries()) {
        const group = topology.groupOfOld.get(old);
        if (!group) {
          sections.push({ sectionId: candidate.mappedIds[index], completedOn: candidate.record.occurredOn });
          continue;
        }
        // 合并区间只输出一次，完乘日期取组内最晚日期（各旧记录各自携带同一最晚日期）。
        if (emitted.has(group.targetId)) continue;
        emitted.add(group.targetId);
        sections.push({ sectionId: group.targetId, completedOn: dates.get(group.targetId) });
      }
      mappedFacts.push({
        recordId: candidate.record.id,
        layer,
        occurredOn: candidate.record.occurredOn,
        fromStationId: candidate.fromStationId,
        toStationId: candidate.toStationId,
        sections,
      });
    }
  }
  return independent({ mappedFacts, pending });
}
