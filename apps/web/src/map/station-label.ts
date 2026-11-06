import type { TransitNetwork } from '../../../../packages/application/reader.mjs';

/**
 * 按 ADR-0005 §3 生成最小充分消歧标签（display_label）。
 *
 * 规则：以规范化站名为组，初始只显示站名；某字段只有当它能拆分“当前仍冲突”的
 * 车站时，才追加到该组所有标签；能全部区分后停止。字段顺序 city → operator →
 * mode → service_line_set → station_code。读取层没有 mode 字段，P5 数据也没有
 * 只靠线路集合才能区分的同名站，因此实现按 city → operator → station_code 回退，
 * 管理编号在读取层唯一，是文档规定的最后安全回退。
 *
 * 拆分站（ADR-0006）在读取层已经是独立 station_id，这里按目标身份各自生成标签，
 * 不把目标并回源站名，也不以旧括注名称猜身份。
 */
export interface StationLabelContext {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly city: string | null;
  readonly operators: readonly string[];
}

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** 名称规范化只用于分组发现同名冲突，不改变展示文本。 */
export function normalizeStationName(name: string): string {
  return name.normalize('NFC').replace(/[\s\u3000]+/gu, '');
}

export function formatStationLabel(name: string, parts: readonly string[]): string {
  return parts.length === 0 ? name : `${name}（${parts.join('｜')}）`;
}

interface LabelField {
  readonly key: string;
  readonly value: (station: StationLabelContext) => string | null;
}

const LABEL_FIELDS: readonly LabelField[] = [
  { key: 'city', value: station => station.city },
  {
    key: 'operator',
    value: station => (station.operators.length === 0 ? null : [...station.operators].sort(compareText).join('、')),
  },
  { key: 'code', value: station => station.code },
];

/** 从网络里补出站点所属运营商名：站 → 端点区间 → 服务 → 运营商。 */
function operatorsByStation(network: TransitNetwork): ReadonlyMap<string, readonly string[]> {
  const operatorNameById = new Map(network.operators.map(operator => [operator.id, operator.name]));
  const operatorNameByService = new Map<string, string | null>();
  for (const service of network.services) {
    operatorNameByService.set(service.id, operatorNameById.get(service.operatorId) ?? null);
  }
  const serviceIdsBySection = new Map<string, readonly string[]>();
  for (const membership of network.memberships) {
    const existing = serviceIdsBySection.get(membership.sectionId);
    serviceIdsBySection.set(membership.sectionId, existing ? [...existing, membership.serviceId] : [membership.serviceId]);
  }
  const names = new Map<string, Set<string>>();
  for (const section of network.sections) {
    const operators = new Set<string>();
    for (const serviceId of serviceIdsBySection.get(section.id) ?? []) {
      const name = operatorNameByService.get(serviceId);
      if (name) operators.add(name);
    }
    for (const stationId of [section.fromStationId, section.toStationId]) {
      const existing = names.get(stationId);
      const target = existing ?? new Set<string>();
      operators.forEach(name => target.add(name));
      names.set(stationId, target);
    }
  }
  const result = new Map<string, readonly string[]>();
  for (const [stationId, operators] of names) result.set(stationId, [...operators]);
  return result;
}

/**
 * 生成 station_id → 展示标签。nameOverrides 用于日期视图解析出的历史站名；
 * 覆盖会参与同名分组，保证历史标签同样按目标身份消歧。
 */
export function buildStationLabels(
  network: TransitNetwork,
  nameOverrides: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> {
  const cityNameById = new Map(network.cities.map(city => [city.id, city.name]));
  const operators = operatorsByStation(network);
  const contexts: StationLabelContext[] = network.stations.map(station => ({
    id: station.id,
    name: nameOverrides.get(station.id) ?? station.name,
    code: station.code,
    city: cityNameById.get(station.cityId) ?? null,
    operators: operators.get(station.id) ?? [],
  }));
  const contextById = new Map(contexts.map(context => [context.id, context]));

  const groups = new Map<string, string[]>();
  for (const context of contexts) {
    const key = normalizeStationName(context.name);
    const group = groups.get(key);
    if (group) group.push(context.id);
    else groups.set(key, [context.id]);
  }

  const labels = new Map<string, string>();
  for (const ids of groups.values()) {
    const first = contextById.get(ids[0]);
    if (!first) continue;
    if (ids.length === 1) {
      labels.set(ids[0], first.name);
      continue;
    }
    const parts = new Map(ids.map(id => [id, [] as string[]]));
    let conflicts: string[][] = [ids];
    for (const field of LABEL_FIELDS) {
      if (!conflicts.some(group => group.length > 1)) break;
      const values = new Map(ids.map(id => [id, field.value(contextById.get(id) as StationLabelContext)]));
      // 字段只有在能拆分当前仍冲突的车站时才加入该组所有标签（ADR-0005 §3）。
      const splittable = conflicts.some(group => group.length > 1 && new Set(group.map(id => values.get(id))).size > 1);
      if (!splittable) continue;
      for (const id of ids) {
        const value = values.get(id);
        if (value) parts.get(id)?.push(value);
      }
      const regrouped = new Map<string, string[]>();
      for (const id of ids) {
        const key = (parts.get(id) ?? []).join('\u0000');
        const group = regrouped.get(key);
        if (group) group.push(id);
        else regrouped.set(key, [id]);
      }
      conflicts = [...regrouped.values()];
    }
    for (const id of ids) {
      const context = contextById.get(id);
      if (!context) continue;
      labels.set(id, formatStationLabel(context.name, parts.get(id) ?? []));
    }
  }
  return labels;
}
