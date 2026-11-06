import { buildStatistics } from '../../../../packages/application/completion.mjs';
import type { CompletionResult } from '../../../../packages/application/completion.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { active, day, requireValue } from '../../../../packages/application/validation.mjs';
import { closureForSection, statisticalSections, serviceDateForSection } from '../../../../packages/application/date-view.mjs';
import type { DimensionStatistics, StatisticsGroup, StationCounts } from './statistics';

export type DimensionCompletion = Pick<CompletionResult, 'statistics' | 'overall' | 'stations'>;
type Section = TransitNetwork['sections'][number];

function stationCounts(sections: readonly Section[], completed: ReadonlySet<string>): StationCounts {
  const stationIds = new Set(sections.flatMap(section => [section.fromStationId, section.toStationId]));
  return { denominator: stationIds.size, completed: [...stationIds].filter(id => completed.has(id)).length };
}

/** 分组只改变区间集合；里程降级、停运和废线计算继续由现有应用模块负责。 */
export function buildDimensionStatistics(network: TransitNetwork, result: DimensionCompletion): DimensionStatistics {
  const { onDate, snapshotId } = result.statistics;
  day(onDate, 'statistics.onDate', '1997-01-01');
  requireValue(network.snapshotId === snapshotId, 'E_SNAPSHOT', 'statistics.snapshotId', 'Statistics snapshot does not match network');
  requireValue(onDate <= network.knowledgeThrough, 'E_SNAPSHOT', 'statistics.onDate', 'No verified snapshot for statistics date');
  const sections = statisticalSections(network, onDate);
  const completedSections = result.overall.map(row => row.sectionId);
  const completedStations = new Set(result.stations.map(row => row.stationId));
  const retiredIds = new Set(sections.filter(section => closureForSection(section, network, onDate)).map(section => section.id));
  const operatorSections = new Map<string, Set<string>>();
  const serviceSections = new Map<string, Set<string>>();
  // Retired sections retain their last jointly valid service membership.
  const services = new Map(network.services.map(service => [service.id, service]));
  const eligibleIds = new Set(sections.map(section => section.id));
  for (const member of network.memberships) {
    const section = sections.find(row => row.id === member.sectionId);
    const memberDate = section ? serviceDateForSection(section, network, onDate) : onDate;
    const service = services.get(member.serviceId);
    if (!eligibleIds.has(member.sectionId) || !service || !active(service, memberDate) || !active(member, memberDate)) continue;
    const byService = serviceSections.get(service.id) ?? new Set<string>();
    byService.add(member.sectionId);
    serviceSections.set(service.id, byService);
    const byOperator = operatorSections.get(service.operatorId) ?? new Set<string>();
    byOperator.add(member.sectionId);
    operatorSections.set(service.operatorId, byOperator);
  }
  const group = (id: string, label: string, memberIds: ReadonlySet<string> | undefined): StatisticsGroup | null => {
    const selected = sections.filter(section => memberIds?.has(section.id));
    if (selected.length === 0) return null;
    const statistics = buildStatistics({ ...network, sections: selected }, completedSections, [...completedStations], onDate);
    return {
      id, label, normal: statistics.normal, retired: statistics.retired,
      normalStations: stationCounts(selected.filter(section => !retiredIds.has(section.id)), completedStations),
      retiredStations: stationCounts(selected.filter(section => retiredIds.has(section.id)), completedStations),
    };
  };
  const operators = network.operators.flatMap(operator => {
    const row = group(operator.id, operator.name, operatorSections.get(operator.id));
    return row ? [row] : [];
  });
  const lines = network.services.flatMap(service => {
    const row = group(service.id, service.name, serviceSections.get(service.id));
    return row ? [row] : [];
  });
  const physicalSections = new Map(network.lines.map(line => [line.id, new Set(sections.filter(section => section.lineId === line.id).map(section => section.id))]));
  const physicalLines = network.lines.flatMap(line => {
    const row = group(line.id, line.name, physicalSections.get(line.id));
    return row ? [row] : [];
  });
  const categories = [
    { id: 'national', label: '国铁' },
    { id: 'intercity', label: '跨市城际铁路' },
    { id: 'urban', label: '城市轨道交通（地铁、有轨）' },
    { id: 'unclassified', label: '待分类' },
  ] as const;
  type Bucket = { id: string; label: string; category: string; members: Set<string>; operatorIds: Set<string> };
  const buckets = new Map<string, Bucket>();
  for (const operator of network.operators) {
    const category = operator.category ?? 'unclassified';
    const id = category === 'urban' ? `urban:${operator.cityId ?? 'unknown'}` : category;
    const bucket = buckets.get(id) ?? { id, category,
      label: category === 'urban' ? network.cities.find(city => city.id === operator.cityId)?.name ?? '所属地区待确认'
        : categories.find(row => row.id === category)!.label,
      members: new Set<string>(), operatorIds: new Set<string>() };
    bucket.operatorIds.add(operator.id);
    for (const sectionId of operatorSections.get(operator.id) ?? []) bucket.members.add(sectionId);
    buckets.set(id, bucket);
  }
  // Physical sections without service ownership remain visible rather than being guessed into a city/type.
  const owned = new Set([...buckets.values()].flatMap(bucket => [...bucket.members]));
  const unowned = sections.filter(section => !owned.has(section.id));
  if (unowned.length) {
    const bucket = buckets.get('unclassified') ?? { id: 'unclassified', label: '待分类', category: 'unclassified', members: new Set<string>(), operatorIds: new Set<string>() };
    for (const section of unowned) bucket.members.add(section.id);
    buckets.set(bucket.id, bucket);
  }
  const grouped = (dimension: 'operators' | 'lines' | 'physicalLines'): StatisticsGroup[] => {
    const rows: StatisticsGroup[] = [];
    for (const category of categories) {
      const selectedBuckets = [...buckets.values()].filter(bucket => bucket.category === category.id);
      const scopedIds = (bucket: Bucket): Set<string> => dimension === 'physicalLines' ? bucket.members
        : new Set([...bucket.operatorIds].flatMap(id => [...(operatorSections.get(id) ?? [])]));
      const categoryIds = new Set(selectedBuckets.flatMap(bucket => [...scopedIds(bucket)]));
      const total = group(`category:${category.id}`, `${category.label} 小计`, categoryIds);
      if (!total) continue;
      const children: StatisticsGroup[] = [];
      for (const bucket of selectedBuckets) {
        const entries = dimension === 'operators' ? network.operators.filter(operator => bucket.operatorIds.has(operator.id))
          : dimension === 'lines' ? network.services.filter(service => bucket.operatorIds.has(service.operatorId)) : network.lines;
        const items = entries.flatMap(entry => {
          const ids = dimension === 'operators' ? operatorSections.get(entry.id)
            : dimension === 'lines' ? serviceSections.get(entry.id) : physicalSections.get(entry.id);
          const row = group(dimension === 'physicalLines' ? `${bucket.id}:${entry.id}` : entry.id, entry.name, new Set([...(ids ?? [])].filter(id => bucket.members.has(id))));
          return row ? [{ ...row, level: category.id === 'urban' ? 2 : 1 }] : [];
        });
        if (!items.length) continue;
        if (category.id === 'urban') {
          const subtotal = group(`region:${bucket.id}`, `${bucket.label} 小计`, scopedIds(bucket))!;
          children.push({ ...subtotal, level: 1, subtotal: true });
        }
        children.push(...items);
      }
      if (children.length) rows.push({ ...total, level: 0, subtotal: true }, ...children);
    }
    return rows;
  };
  return { onDate, snapshotId, operators, lines, physicalLines,
    grouped: { operators: grouped('operators'), lines: grouped('lines'), physicalLines: grouped('physicalLines') } };
}
