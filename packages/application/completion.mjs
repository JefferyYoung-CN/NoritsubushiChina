import { active, day, independent, requireValue } from './validation.mjs';
import { decodeFacts } from './records.mjs';
import { buildDateView, mileage, sectionStatus, statisticalSections } from './date-view.mjs';

function accumulate(rows, sectionIds, onDate) {
  for (const sectionId of sectionIds) {
    const previous = rows.get(sectionId);
    if (!previous || onDate < previous) rows.set(sectionId, onDate);
  }
}
const completionRows = rows => [...rows].sort(([a], [b]) => a.localeCompare(b))
  .map(([sectionId, firstCompletedOn]) => ({ sectionId, firstCompletedOn }));

/** 日期视图物理分支抛出的边界码只用于本地诊断；进入待处理必须换成既定原因（PENDING_REASONS 五类）。 */
const ERROR_REASONS = Object.freeze({
  E_SERVICE_ALIGN: 'service-alignment-required',
  E_PATH: 'path-mapping-required',
  E_MULTIPATH: 'path-mapping-required',
});

function resolve(record, network, onDate) {
  if (record.networkSnapshotId !== network.snapshotId) return { reason: 'snapshot-mapping-required' };
  if (!record.physicalLineId && record.serviceLineIds.length !== 1) return { reason: 'through-service-mapping-required' };
  try {
    const view = buildDateView(network, { onDate: record.occurredOn, fromStationId: record.fromStationId,
      toStationId: record.toStationId, serviceLineId: record.physicalLineId ? null : record.serviceLineIds[0],
      // 进阶记录按已存有序区间核验：环线上任意两站都有两条无向径路，重新找路只会判多径路。
      sectionIds: record.sectionIds,
      ...(record.physicalLineId ? { physicalLineId: record.physicalLineId } : {}) });
    const path = view.normalSections.map(row => row.id);
    if (!view.routeAvailable || path.length !== record.sectionIds.length || path.some((id, index) => id !== record.sectionIds[index])) {
      return { reason: 'path-mapping-required' };
    }
    if (view.normalSections.some(section => !active(section, onDate) &&
      sectionStatus(section, network, onDate).status !== 'retired')) return { reason: 'topology-mapping-required' };
    return { sectionIds: path };
  } catch (error) {
    // 对齐失败意味着需要换乘、应分段录入，与径路不一致分开上报；未登记的新码属程序缺陷，继续抛出而不是静默归类。
    const reason = ERROR_REASONS[error.code];
    if (!reason) throw error;
    return { reason };
  }
}

/**
 * 派生统计的唯一实现：接收「已映射事实 + 待处理」，累加区间与车站后生成统计结果。
 * 两个调用方共用它：calculateCompletion 传入 resolve 的结果；集成层传入
 * topology-mapping.mapRecordFacts 的结果（sections 已是统计快照的区间身份，合并组
 * 携带组内最晚完乘日期，这里按原有 accumulate 语义取最早日期）。
 */
export function deriveCompletion(network, onDate, mappedFacts, pending) {
  const basic = new Map(), advanced = new Map(), stationDates = new Map();
  const contributions = [];
  for (const fact of mappedFacts) {
    const sectionIds = fact.sections.map(row => row.sectionId);
    for (const section of fact.sections) {
      accumulate(fact.layer === 'basic' ? basic : advanced, [section.sectionId], section.completedOn);
    }
    // 完站只由进阶乘车记录贡献。基础录入不以「上车到下车」为基准，
    // 换乘或直通分段录入的拆段端点会在中途站造出并非真实上落车的乘降。
    if (fact.layer === 'advanced') {
      accumulate(stationDates, [fact.fromStationId, fact.toStationId], fact.occurredOn);
      contributions.push({ recordId: fact.recordId, sectionIds });
    }
  }
  const overall = new Map(basic);
  for (const [sectionId, completedOn] of advanced) accumulate(overall, [sectionId], completedOn);
  return independent({ basic: completionRows(basic), advanced: completionRows(advanced), overall: completionRows(overall),
    stations: [...stationDates].map(([stationId, firstCompletedOn]) => ({ stationId, firstCompletedOn })),
    pending, contributions, statistics: buildStatistics(network, [...overall.keys()], [...stationDates.keys()], onDate) });
}

export function calculateCompletion(input, network, onDate) {
  const facts = decodeFacts(input);
  day(onDate, 'statistics.onDate', '1997-01-01');
  requireValue(network && onDate <= network.knowledgeThrough, 'E_SNAPSHOT', 'statistics.snapshot', 'No verified snapshot for statistics date');
  const mappedFacts = [], pending = [];
  for (const layer of ['basic', 'advanced']) {
    for (const record of facts[layer].filter(row => row.occurredOn <= onDate)) {
      const mapping = resolve(record, network, onDate);
      if (mapping.reason) { pending.push({ recordId: record.id, layer, reason: mapping.reason }); continue; }
      mappedFacts.push({ recordId: record.id, layer, occurredOn: record.occurredOn,
        fromStationId: record.fromStationId, toStationId: record.toStationId,
        sections: mapping.sectionIds.map(sectionId => ({ sectionId, completedOn: record.occurredOn })) });
    }
  }
  return deriveCompletion(network, onDate, mappedFacts, pending);
}

function summary(network, sections, completed) {
  const chosen = sections.filter(row => completed.has(row.id));
  const denominator = { sectionCount: sections.length, ...mileage(network, sections) };
  return { denominator, completed: { sectionCount: chosen.length, ...mileage(network, chosen),
    statisticsBasis: denominator.statisticsBasis, noMileageLabel: denominator.noMileageLabel,
    mileageStatus: denominator.mileageStatus,
    ...(denominator.noMileageLabel ? { lengthMetres: null } : {}) } };
}

export function buildStatistics(network, completedSectionIds, completedStationIds, onDate) {
  day(onDate, 'statistics.onDate', '1997-01-01');
  requireValue(onDate <= network.knowledgeThrough, 'E_SNAPSHOT', 'statistics.onDate', 'No verified snapshot for statistics date');
  const normal = [], retired = [];
  for (const section of statisticalSections(network, onDate)) {
    if (sectionStatus(section, network, onDate).status === 'retired') retired.push(section);
    else normal.push(section);
  }
  const completed = new Set(completedSectionIds), stationSet = new Set(completedStationIds);
  const forCity = (sections, cityId) => sections.filter(section => [section.fromStationId, section.toStationId]
    .some(id => network.stations.find(row => row.id === id)?.cityId === cityId));
  return independent({ onDate, snapshotId: network.snapshotId, sourceKind: network.sourceKind,
    normal: summary(network, normal, completed), retired: summary(network, retired, completed),
    temporarySectionCount: normal.filter(row => sectionStatus(row, network, onDate).status === 'temporary').length,
    cities: network.cities.map(city => ({ cityId: city.id, normal: summary(network, forCity(normal, city.id), completed),
      retired: summary(network, forCity(retired, city.id), completed),
      completedStationCount: network.stations.filter(row => row.cityId === city.id && stationSet.has(row.id)).length })) });
}

export async function recalculate(port, network, onDate, compute = calculateCompletion) {
  requireValue(network, 'E_SNAPSHOT', 'snapshot', 'No snapshot selected');
  const token = port.beginCalculation(network.snapshotId, 'phase1.completion.v1', onDate);
  try {
    await port.settled?.();
    const result = await compute(port.read().facts, network, onDate);
    const published = port.publish(token, result);
    await port.settled?.();
    return { status: published ? 'published' : 'stale' };
  } catch (error) {
    port.fail(token, error.code ?? 'E_CALCULATION');
    try { await port.settled?.(); } catch { /* Preserve the original diagnostic. */ }
    throw error;
  }
}
