/**
 * 站名消歧与站/区间搜索。
 *
 * 同名站按固定顺序逐级补足限定词：城市 → 运营方 → 服务线路集合 → station_code，
 * 取能让组内标签唯一的最短组合；没有重名时直接使用站名。搜索只读快照数据，
 * 不改变选中状态，不猜缺失坐标或历史名称。
 *
 * 传 `onDate` 时按乘车日期取当日有效站名并作为分组键（线路图、无障碍名、手动选站
 * 三处一致的基础）；不传则沿用快照里的静态站名（已保存记录与全域搜索的既有口径）。
 */
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { active } from '../../../../packages/application/validation.mjs';

export interface StationLabel {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly disambiguated: boolean;
}

/** 站点命中：`name` 站名本身、`code` 管理编号、`label` 只有消歧后缀被命中。 */
export interface StationSearchResult {
  readonly kind: 'station';
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly matchedField: 'name' | 'code' | 'label';
}

/** 区间命中：`line` 线路名、`endpoint` 端点站名或其消歧标签。 */
export interface SectionSearchResult {
  readonly kind: 'section';
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly matchedField: 'line' | 'endpoint';
}

export type NetworkSearchResult = StationSearchResult | SectionSearchResult;

interface Features {
  readonly city: string;
  readonly operators: string;
  /** service_line_set：经过该站的线路名集合。 */
  readonly lines: string;
  readonly code: string;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((value) => value.length > 0).sort((a, b) => a.localeCompare(b));
}

/** 站点特征：城市、运营方（经区间→服务成员反查）、经过的线路名、编号。 */
function stationFeatures(network: TransitNetwork): Map<string, Features> {
  const cityNames = new Map(network.cities.map((city) => [city.id, city.name]));
  const operatorNames = new Map(network.operators.map((operator) => [operator.id, operator.name]));
  const lineNames = new Map(network.lines.map((line) => [line.id, line.name]));
  const sectionById = new Map(network.sections.map((section) => [section.id, section]));
  const stations = new Map<string, { operators: Set<string>; lines: Set<string> }>();
  const touch = (stationId: string) => {
    let row = stations.get(stationId);
    if (!row) {
      row = { operators: new Set(), lines: new Set() };
      stations.set(stationId, row);
    }
    return row;
  };
  for (const membership of network.memberships) {
    const section = sectionById.get(membership.sectionId);
    if (!section) continue;
    const lineName = lineNames.get(section.lineId) ?? section.lineId;
    touch(section.fromStationId).lines.add(lineName);
    touch(section.toStationId).lines.add(lineName);
    const service = network.services.find((row) => row.id === membership.serviceId);
    if (!service) continue;
    const operatorName = operatorNames.get(service.operatorId) ?? service.operatorId;
    touch(section.fromStationId).operators.add(operatorName);
    touch(section.toStationId).operators.add(operatorName);
  }
  return new Map(
    network.stations.map((station) => {
      const row = stations.get(station.id) ?? { operators: new Set<string>(), lines: new Set<string>() };
      return [
        station.id,
        {
          city: cityNames.get(station.cityId) ?? station.cityId,
          operators: uniqueSorted(row.operators).join('、'),
          lines: uniqueSorted(row.lines).join('、'),
          code: station.code,
        },
      ];
    }),
  );
}

/** 按消歧顺序可追加的字段；`station_code` 只作最后安全回退，不在正常逐级里。 */
const ADDABLE_FIELDS = ['city', 'operators', 'lines'] as const;
type LabelField = typeof ADDABLE_FIELDS[number] | 'code';

/**
 * 规范化站名只用于分组：折叠前后/连续空白（含全角空格），不改变字形、括号与文字，
 * 因此展示出的站名除了多余空白被折叠外与快照一致。
 */
function normalizeStationName(name: string): string {
  return name.replace(/[\s\u3000]+/g, ' ').trim();
}

/** 当日有效站名；没有名称记录时退回车站自身名称。 */
function displayName(network: TransitNetwork, station: { readonly id: string; readonly name: string }, onDate?: string): string {
  if (!onDate) return station.name;
  return network.names.find((row) => row.stationId === station.id && active(row, onDate))?.name ?? station.name;
}

/**
 * 为全网每个站点生成稳定、可读且组内唯一的标签；`onDate` 决定按哪天的站名分组与显示。
 *
 * 分组只在「该日期可选、该日期办客」的车站集合内进行：非办客车站与当日已停办的车站
 * 不参与消歧，也不会让办客站背上限定词（advanced-dependencies §6.3）。不传 `onDate` 时
 * 静态口径取「办理过客运」的车站集合。两处范围外的车站仍返回裸站名，供线路图等界面显示。
 *
 * 消歧顺序：先按规范化站名分组；初始标签只有站名，只要组内还有冲突，就按
 * 城市 → 运营方 → 服务线路集合（经过的线路名）的顺序，**只追加当时能拆开剩余冲突的字段**，
 * 全部能区分后立即停止；全部字段仍拆不开时用 station_code 做最后安全回退。字段值缺失时
 * 跳过该字段（ADR 要求导入校验报告这类数据问题，本层不猜测缺失值）。
 *
 * ADR 的 `mode` 层未实现：当前线网快照没有车站或线路的制式字段；operator.category 是
 * 运营方属性，同一运营方必然同 category，无法在任何同名冲突中提供额外拆分。影响范围：
 * 只有「站名、城市、运营方、线路集合全同、仅制式不同」的冲突会少这一层，当前快照没有
 * 这种数据；补数据字段后应在 ADDABLE_FIELDS 的 operators 与 lines 之间插入。
 */
/** 参与消歧的候选车站：日期口径为当日办客，静态口径为办理过客运的车站。 */
function disambiguationScope(network: TransitNetwork, onDate?: string): Set<string> {
  const selectable = new Set<string>();
  for (const row of network.passengerPeriods) {
    if (row.kind !== 'passenger') continue;
    if (onDate !== undefined && !active(row, onDate)) continue;
    selectable.add(row.stationId);
  }
  return selectable;
}

export function buildStationLabels(network: TransitNetwork, onDate?: string): Map<string, StationLabel> {
  const features = stationFeatures(network);
  const scope = disambiguationScope(network, onDate);
  const groups = new Map<string, TransitNetwork['stations'][number][]>();
  for (const station of network.stations) {
    if (!scope.has(station.id)) continue;
    const name = normalizeStationName(displayName(network, station, onDate));
    const rows = groups.get(name) ?? [];
    rows.push(station);
    groups.set(name, rows);
  }
  const labels = new Map<string, StationLabel>();
  for (const [name, rows] of groups) {
    if (rows.length === 1) {
      const station = rows[0]!;
      labels.set(station.id, { id: station.id, name, label: name, disambiguated: false });
      continue;
    }
    const applied: LabelField[] = [];
    const valueOf = (station: TransitNetwork['stations'][number], field: LabelField): string =>
      field === 'code' ? station.code : features.get(station.id)?.[field] ?? '';
    /** 按已追加字段把组内切成仍冲突的桶；桶大小 >1 就是还没拆开的冲突。 */
    const conflicts = (): TransitNetwork['stations'][number][][] => {
      const buckets = new Map<string, TransitNetwork['stations'][number][]>();
      for (const station of rows) {
        const key = applied.map((field) => valueOf(station, field)).join('\u0000');
        const bucket = buckets.get(key) ?? [];
        bucket.push(station);
        buckets.set(key, bucket);
      }
      return [...buckets.values()].filter((bucket) => bucket.length > 1);
    };
    for (;;) {
      const pending = conflicts();
      if (pending.length === 0) break;
      const next = ADDABLE_FIELDS.find((field) => !applied.includes(field) &&
        rows.every((station) => valueOf(station, field).length > 0) &&
        pending.some((bucket) => new Set(bucket.map((station) => valueOf(station, field))).size > 1));
      if (!next) break;
      applied.push(next);
    }
    // 全部候选字段仍无法区分：ADR 允许的最后安全回退是管理编号；编号也相同的异常数据
    // 无法在这一层纠正，留给导入校验报告。
    if (conflicts().length > 0 && !applied.includes('code')) applied.push('code');
    for (const station of rows) {
      const suffix = applied.map((field) => valueOf(station, field)).filter((value) => value.length > 0).join('｜');
      labels.set(station.id, {
        id: station.id,
        name,
        label: suffix.length > 0 ? `${name}（${suffix}）` : name,
        disambiguated: true,
      });
    }
  }
  // 范围外的车站不参与分组，但仍要能显示：取当日站名作裸标签。
  for (const station of network.stations) {
    if (scope.has(station.id)) continue;
    const name = normalizeStationName(displayName(network, station, onDate));
    labels.set(station.id, { id: station.id, name, label: name, disambiguated: false });
  }
  return labels;
}

/** 单站标签；未知站点回退到 id，调用方据此显示“未知站点”占位。 */
export function labelOf(network: TransitNetwork, stationId: string): string {
  const station = network.stations.find((row) => row.id === stationId);
  if (!station) return stationId;
  return buildStationLabels(network).get(stationId)?.label ?? station.name;
}

/** 站/区间统一搜索：站按名称、编号、消歧标签；区间按端点站名与该区间所属线路名。 */
export function searchNetwork(network: TransitNetwork, rawQuery: string, limit = 20): NetworkSearchResult[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (query.length === 0) return [];
  const labels = buildStationLabels(network);
  const stationById = new Map(network.stations.map((station) => [station.id, station]));
  const lineNames = new Map(network.lines.map((line) => [line.id, line.name]));
  const results: NetworkSearchResult[] = [];
  for (const station of network.stations) {
    const label = labels.get(station.id)?.label ?? station.name;
    const nameHit = station.name.toLocaleLowerCase().includes(query);
    const codeHit = station.code.toLocaleLowerCase().includes(query);
    const labelHit = label.toLocaleLowerCase().includes(query);
    if (!nameHit && !codeHit && !labelHit) continue;
    const city = network.cities.find((row) => row.id === station.cityId)?.name ?? '';
    results.push({
      kind: 'station',
      id: station.id,
      label,
      detail: [city, `编号 ${station.code}`].filter((part) => part.length > 0).join(' · '),
      // 站点标签是「站名（城市｜运营方｜线路集合）」：站名与编号都没命中、只有括号里的
      // 限定词命中时报 label，不能报成 name——那会让界面把「按城市搜索」说成「命中站名」。
      matchedField: nameHit ? 'name' : codeHit ? 'code' : 'label',
    });
  }
  for (const section of network.sections) {
    const from = stationById.get(section.fromStationId);
    const to = stationById.get(section.toStationId);
    if (!from || !to) continue;
    const fromLabel = labels.get(from.id)?.label ?? from.name;
    const toLabel = labels.get(to.id)?.label ?? to.name;
    const lineName = lineNames.get(section.lineId) ?? section.lineId;
    const endpointHit = [from.name, to.name, fromLabel, toLabel].some((value) =>
      value.toLocaleLowerCase().includes(query),
    );
    const lineHit = lineName.toLocaleLowerCase().includes(query);
    if (!endpointHit && !lineHit) continue;
    results.push({
      kind: 'section',
      id: section.id,
      label: `${fromLabel} — ${toLabel}`,
      detail: lineName,
      matchedField: lineHit && !endpointHit ? 'line' : 'endpoint',
    });
  }
  return results
    .map((result, order) => ({ result, order, rank: result.label.toLocaleLowerCase().startsWith(query) ? 0 : 1 }))
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .slice(0, limit)
    .map(({ result }) => result);
}

/** 选中站所在区间（用于日期视图按站/区间筛选，不改变业务判定）。 */
export function sectionsAtStation(network: TransitNetwork, stationId: string): string[] {
  return network.sections
    .filter((section) => section.fromStationId === stationId || section.toStationId === stationId)
    .map((section) => section.id);
}
