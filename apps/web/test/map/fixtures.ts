import type { TransitNetwork } from '../../../../packages/application/reader.mjs';

/**
 * 地图测试用的最小 TransitNetwork 夹具。
 *
 * 只填读取路径真正用到的字段（站点坐标、区间、服务/运营商、日期策略），其余保持
 * 空数组，避免测试依赖与地图无关的读取层细节。文件是 .ts 并复用 reader.d.mts 的
 * TransitNetwork，让夹具缺失字段在类型检查时就暴露，而不是等到运行期。
 */
export function makeStation(
  id: string,
  name: string,
  code: string,
  latitude: number | null,
  longitude: number | null,
  cityId = 'c1',
): TransitNetwork['stations'][number] {
  return { id, name, code, cityId, latitude, longitude };
}

export function makeSection(
  id: string,
  lineId: string,
  fromStationId: string,
  toStationId: string,
): TransitNetwork['sections'][number] {
  return {
    id,
    lineId,
    fromStationId,
    toStationId,
    lengthMetres: 1000,
    lengthSource: 'fixture',
    from: '1900-01-01',
    until: null,
  };
}

export function makeNetwork(overrides: Partial<TransitNetwork> = {}): TransitNetwork {
  return {
    snapshotId: 'fixture',
    snapshotAsOf: '2024-04-01T00:00:00Z',
    knowledgeThrough: '2024-04-01',
    sourceKind: 'simulated',
    attribution: 'fixture',
    releaseReady: false,
    sourceUse: { internalTestOnly: true, evidenceKind: 'fixture' },
    cities: [{ id: 'c1', name: '東京' }],
    operators: [{ id: 'o1', cityId: 'c1', name: 'JR東日本' }],
    stations: [],
    lines: [{ id: 'l1', name: '山手線', isLoop: false, directions: [], from: '1900-01-01', until: null }],
    sections: [],
    services: [{ id: 'sv1', name: '山手線', operatorId: 'o1', directions: [], from: '1900-01-01', until: null }],
    memberships: [],
    names: [],
    passengerPeriods: [],
    events: [],
    mappings: [],
    policies: { noMileageSections: [], closures: [], suspensions: [] },
    ...overrides,
  };
}

/** 两站一线的最小网络；坐标传 null 时用于验证缺坐标禁用态。 */
export function twoStationNetwork({
  latitudesLongitudes,
  ...overrides
}: Partial<TransitNetwork> & {
  readonly latitudesLongitudes?: readonly (readonly (number | null)[])[];
} = {}): TransitNetwork {
  const coords = latitudesLongitudes ?? [
    [35.681236, 139.767125],
    [35.690921, 139.700258],
  ];
  const stations = [
    makeStation('s1', '東京', 'TYO', coords[0][0], coords[0][1]),
    makeStation('s2', '新宿', 'SJK', coords[1][0], coords[1][1]),
  ];
  return makeNetwork({
    stations,
    sections: [makeSection('sec1', 'l1', 's1', 's2')],
    memberships: [{ serviceId: 'sv1', sectionId: 'sec1', sequence: 1, from: '1900-01-01', until: null }],
    ...overrides,
  });
}
