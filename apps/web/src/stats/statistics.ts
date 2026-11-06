/**
 * 统计口径的纯逻辑：里程/区间数、城市/运营商/物理线路/运营线路、统计基准日、无里程与废线/停运标识。
 *
 * 数据来自 `buildDateView`（单次乘车）或 `calculateCompletion().statistics`
 * （全量统计）；这里只做范围选择与格式化，不重新判定区间状态。
 */

export interface StatSummary {
  readonly denominator: {
    readonly sectionCount: number;
    readonly lengthMetres: number | null;
    readonly statisticsBasis: 'metres' | 'sections' | 'unavailable';
    readonly noMileageLabel: boolean;
    readonly mileageStatus: 'available' | 'incomplete' | 'not-provided';
  };
  readonly completed: {
    readonly sectionCount: number;
    readonly lengthMetres: number | null;
    readonly statisticsBasis: 'metres' | 'sections' | 'unavailable';
    readonly noMileageLabel: boolean;
    readonly mileageStatus: 'available' | 'incomplete' | 'not-provided';
  };
}

export interface StatisticsData {
  readonly onDate: string;
  readonly snapshotId: string;
  readonly normal: StatSummary;
  readonly retired: StatSummary;
  readonly temporarySectionCount: number;
  readonly cities: readonly {
    readonly cityId: string;
    readonly normal: StatSummary;
    readonly retired: StatSummary;
    readonly completedStationCount: number;
  }[];
}

export type StatisticsBasis = 'mileage' | 'sections';
export type StatisticsArea = 'all' | string;
export type StatisticsDimension = 'area' | 'operators' | 'physicalLines' | 'lines';

export interface StationCounts {
  readonly completed: number;
  readonly denominator: number;
}

export interface StatisticsGroup {
  readonly level?: number;
  readonly subtotal?: boolean;
  readonly id: string;
  readonly label: string;
  readonly normal: StatSummary;
  readonly retired: StatSummary;
  readonly normalStations: StationCounts;
  readonly retiredStations: StationCounts;
}

export interface DimensionStatistics {
  readonly onDate: string;
  readonly snapshotId: string;
  readonly operators: readonly StatisticsGroup[];
  readonly lines: readonly StatisticsGroup[];
  readonly physicalLines: readonly StatisticsGroup[];
  readonly grouped: Readonly<Record<'operators' | 'physicalLines' | 'lines', readonly StatisticsGroup[]>>;
}

export interface StatisticsScope {
  readonly basis: StatisticsBasis;
  readonly area: StatisticsArea;
  readonly includeRetired: boolean;
  readonly dimension?: StatisticsDimension;
}

export interface StatisticsItem {
  readonly id: string;
  readonly label: string;
  readonly completed: string;
  readonly denominator: string;
  readonly unit: '公里' | '区间';
  readonly note: string;
  readonly retired: boolean;
  readonly stations?: StationCounts;
  readonly level?: number;
  readonly subtotal?: boolean;
}

/** 无里程时显示明确的占位，不用 0 公里伪装成真实数据。 */
export function formatLength(metres: number | null): string {
  if (metres === null) return '—';
  return `${(metres / 1000).toFixed(2)} 公里`;
}

export function formatSections(count: number): string {
  return `${count} 个区间`;
}

export function formatStations(count: number): string {
  return `${count} 座车站`;
}

export function summaryValue(summary: StatSummary, basis: StatisticsBasis): string {
  if (basis === 'mileage') {
    return summary.denominator.noMileageLabel || summary.denominator.statisticsBasis === 'sections'
      ? '无里程'
      : formatLength(summary.completed.lengthMetres);
  }
  return formatSections(summary.completed.sectionCount);
}

export function summaryTotal(summary: StatSummary, basis: StatisticsBasis): string {
  if (basis === 'mileage') {
    return summary.denominator.noMileageLabel || summary.denominator.statisticsBasis === 'sections'
      ? '无里程'
      : formatLength(summary.denominator.lengthMetres);
  }
  return formatSections(summary.denominator.sectionCount);
}

function noteOf(summary: StatSummary): string {
  const notes: string[] = [];
  if (summary.denominator.noMileageLabel) notes.push('该范围内无里程数据，按区间数统计');
  if (summary.denominator.mileageStatus === 'incomplete') notes.push('里程不完整');
  if (summary.denominator.mileageStatus === 'not-provided') notes.push('未提供里程');
  return notes.join('；');
}

/** 生成当前口径下的行；area 未知时显示全部城市并给出说明由调用方展示。 */
export function statisticsRows(
  data: StatisticsData,
  scope: StatisticsScope,
  cityNames: ReadonlyMap<string, string>,
  dimensions?: DimensionStatistics | null,
): StatisticsItem[] {
  const selected = scope.area === 'all' ? null : data.cities.find((city) => city.cityId === scope.area) ?? null;
  const rows: StatisticsItem[] = [];
  const push = (id: string, label: string, summary: StatSummary, retired: boolean, stations?: StationCounts): void => {
    rows.push({
      id,
      label,
      completed: summaryValue(summary, scope.basis),
      denominator: summaryTotal(summary, scope.basis),
      unit: scope.basis === 'mileage' ? '公里' : '区间',
      note: noteOf(summary),
      retired,
      ...(stations ? { stations } : {}),
    });
  };
  if (scope.dimension === 'operators' || scope.dimension === 'physicalLines' || scope.dimension === 'lines') {
    if (!dimensions || dimensions.onDate !== data.onDate || dimensions.snapshotId !== data.snapshotId) return [];
    for (const group of dimensions.grouped[scope.dimension]) {
      if (group.normal.denominator.sectionCount > 0) {
        push(`${scope.dimension}:${group.id}:normal`, `${group.label} 运营中`, group.normal, false, group.normalStations);
        Object.assign(rows.at(-1)!, { level: group.level, subtotal: group.subtotal });
      }
      if (scope.includeRetired && group.retired.denominator.sectionCount > 0) {
        push(`${scope.dimension}:${group.id}:retired`, `${group.label} 废线`, group.retired, true, group.retiredStations);
        Object.assign(rows.at(-1)!, { level: group.level, subtotal: group.subtotal });
      }
    }
    return rows;
  }
  if (selected) {
    push(`city:${selected.cityId}:normal`, `${cityNames.get(selected.cityId) ?? selected.cityId} 运营中`, selected.normal, false);
    if (scope.includeRetired) {
      push(`city:${selected.cityId}:retired`, `${cityNames.get(selected.cityId) ?? selected.cityId} 废线`, selected.retired, true);
    }
    return rows;
  }
  for (const city of data.cities) {
    push(`city:${city.cityId}:normal`, `${cityNames.get(city.cityId) ?? city.cityId} 运营中`, city.normal, false);
    if (scope.includeRetired && city.retired.denominator.sectionCount > 0) {
      push(`city:${city.cityId}:retired`, `${cityNames.get(city.cityId) ?? city.cityId} 废线`, city.retired, true);
    }
  }
  return rows;
}

export function statisticsSubtitle(data: StatisticsData, scope: StatisticsScope): string {
  const area = scope.dimension === 'operators' ? '按运营商' : scope.dimension === 'physicalLines' ? '按物理线路' : scope.dimension === 'lines' ? '按运营线路'
    : scope.area === 'all' ? '按城市' : `城市 ${scope.area}`;
  const temporaryScope = scope.dimension === 'operators' || scope.dimension === 'physicalLines' || scope.dimension === 'lines' ? '全网' : '';
  const temporary = data.temporarySectionCount > 0 ? `；${temporaryScope}临时停运 ${data.temporarySectionCount} 个区间` : '';
  return `${data.onDate} · ${area} · ${scope.basis === 'mileage' ? '里程口径' : '区间数口径'} · ${scope.includeRetired ? '含废线' : '不含废线'}${temporary}`;
}

export function allCityOptions(
  data: StatisticsData,
  cityNames: ReadonlyMap<string, string>,
): { id: StatisticsArea; label: string }[] {
  return [
    { id: 'all', label: '全部城市' },
    ...data.cities.map((city) => ({ id: city.cityId, label: cityNames.get(city.cityId) ?? city.cityId })),
  ];
}

/** The total uses the original network union, never an addition of overlapping groups. */
export function statisticsTotals(data: StatisticsData, scope: StatisticsScope): StatisticsItem[] {
  const row = (summary: StatSummary, retired: boolean): StatisticsItem => ({
    id: retired ? 'total:retired' : 'total:normal', label: retired ? '合计 · 废线' : '合计 · 运营中',
    completed: summaryValue(summary, scope.basis), denominator: summaryTotal(summary, scope.basis),
    unit: scope.basis === 'mileage' ? '公里' : '区间', note: noteOf(summary), retired,
  });
  return [row(data.normal, false), ...(scope.includeRetired ? [row(data.retired, true)] : [])];
}
