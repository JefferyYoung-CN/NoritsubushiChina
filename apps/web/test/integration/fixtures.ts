/**
 * 集成测试的合成夹具。
 *
 * 只构造被测纯逻辑实际读取的字段：站点/区间/线路/服务/成员关系与一个 3 站 2 区间的
 * 线性拓扑。所有事实的区间端点都与拓扑一致，方便分别构造五类 pending。
 */
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';

export const ON_DATE = '2024-06-10';
export const SNAPSHOT_ID = 'snap-2024-01-01';
const period = { from: '2000-01-01', until: null };

export function fixtureNetwork(): TransitNetwork {
  const station = (id: string) => ({
    id, code: id, name: `站${id}`, cityId: 'c1', latitude: 0, longitude: 0, ...period,
  });
  const stations = ['A', 'B', 'C', 'D'].map(station);
  const line = { id: 'L1', name: '一号线', isLoop: false, directions: [], ...period };
  const service = { id: 'S1', name: '一号线', lineId: 'L1', operatorId: 'op1', directions: [], ...period };
  const section = (id: string, fromStationId: string, toStationId: string) => ({
    id, lineId: 'L1', fromStationId, toStationId, lengthMetres: 1000,
    lengthSource: 'official', status: 'normal', ...period,
  });
  const membership = (sectionId: string, sequence: number) => ({ serviceId: 'S1', sectionId, sequence, ...period });
  return {
    snapshotId: SNAPSHOT_ID,
    snapshotAsOf: '2024-01-01',
    knowledgeThrough: '2030-12-31',
    sourceKind: 'simulated',
    attribution: 'Synthetic test fixture',
    releaseReady: false,
    sourceUse: { internalTestOnly: true, evidenceKind: 'fixture' },
    stations,
    lines: [line],
    services: [service],
    sections: [section('sAB', 'A', 'B'), section('sBD', 'B', 'D'), section('sCD', 'C', 'D')],
    memberships: [membership('sAB', 0), membership('sBD', 1)],
    names: stations.map((row) => ({ stationId: row.id, name: row.name, ...period })),
    passengerPeriods: stations.map((row) => ({ stationId: row.id, kind: 'passenger' as const, ...period })),
    mappings: [],
    policies: { noMileageSections: [], closures: [], suspensions: [] },
    cities: [{ id: 'c1', name: '示例市' }],
    operators: [{ id: 'op1', cityId: 'c1', name: '运营一' }],
    events: [],
  };
}

export function lookupNetwork(): TransitNetwork {
  const base = fixtureNetwork();
  return {
    ...base,
    cities: [...base.cities, { id: 'c2', name: '另一市' }],
    operators: [...base.operators, { id: 'op2', name: '运营二', cityId: 'c2' }],
    stations: base.stations.map(station => station.id === 'C' ? { ...station, cityId: 'c2' } : station),
    services: [...base.services, { ...base.services[0], id: 'S2', name: '二号服务', operatorId: 'op2' }],
    memberships: [...base.memberships, { ...base.memberships[0], serviceId: 'S2', sectionId: 'sCD' }],
  };
}

export interface FactOverrides {
  readonly id?: string;
  readonly occurredOn?: string;
  readonly networkSnapshotId?: string;
  readonly fromStationId?: string;
  readonly toStationId?: string;
  readonly serviceLineIds?: readonly string[];
  readonly physicalLineId?: string;
  readonly sectionIds?: readonly string[];
}

/** 默认是当前快照、sAB 单区间、A→B 的可映射事实；逐项覆盖即可构造待处理原因。 */
export function fact(overrides: FactOverrides = {}) {
  return Object.freeze({
    id: overrides.id ?? 'fact-1',
    occurredOn: overrides.occurredOn ?? '2024-05-01',
    networkSnapshotId: overrides.networkSnapshotId ?? SNAPSHOT_ID,
    fromStationId: overrides.fromStationId ?? 'A',
    toStationId: overrides.toStationId ?? 'B',
    serviceLineIds: overrides.serviceLineIds ?? ['S1'],
    ...(overrides.physicalLineId ? { physicalLineId: overrides.physicalLineId } : {}),
    sectionIds: overrides.sectionIds ?? ['sAB'],
    note: '',
    vehicle: '',
  });
}

export function facts(basic: readonly unknown[], advanced: readonly unknown[] = []) {
  return { basic: [...basic], advanced: [...advanced] };
}

/** 至少一个资产的清单形状；sha256 只要求 64 位十六进制。 */
export const DIGEST = 'a'.repeat(64);
