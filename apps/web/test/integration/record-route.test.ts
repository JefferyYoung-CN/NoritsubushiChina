import { describe, expect, test } from 'vitest';
import { physicalLineOptions, physicalDestinations, physicalLinesAtStation } from '../../src/records/physical-route';
import { fixtureNetwork, lookupNetwork, ON_DATE } from './fixtures';
const ids = (options: readonly { id: string }[]) => options.map(option => option.id);

describe('基础记录按物理线路取当日候选', () => {
  test('按站查线路，到达站只保留同一运营服务可一次录入的目标', () => {
    const network = lookupNetwork();
    expect(physicalLinesAtStation(network, ON_DATE, '')).toEqual([]);
    expect(ids(physicalLinesAtStation(network, ON_DATE, 'D'))).toEqual(['L1']);
    expect(ids(physicalDestinations(network, ON_DATE, 'L1', 'A'))).toEqual(['B', 'D']);
    expect(physicalDestinations(network, ON_DATE, 'S1', 'A')).toEqual([]);
  });
  test('反向区间仍可完成，不把区间存储端点顺序当单向限制', () => {
    expect(ids(physicalDestinations(fixtureNetwork(), ON_DATE, 'L1', 'D'))).toEqual(['A', 'B']);
  });
  test.each(['lines', 'sections'] as const)('%s 的失效边界日没有候选', key => {
    const base = fixtureNetwork();
    const network = { ...base, [key]: base[key].map(row => ({ ...row, until: ON_DATE })) };
    expect(physicalLineOptions(network, ON_DATE)).toEqual([]);
    expect(physicalDestinations(network, ON_DATE, 'L1', 'A')).toEqual([]);
    expect(ids(physicalLineOptions(network, '2024-06-09'))).toEqual(['L1']);
  });
  test('物理线路候选不依赖运营服务，但到达站必须落在当日同一运营服务内', () => {
    const network = { ...fixtureNetwork(), services: [], memberships: [] };
    expect(ids(physicalLineOptions(network, ON_DATE))).toEqual(['L1']);
    expect(ids(physicalDestinations(network, ON_DATE, 'L1', 'A'))).toEqual([]);
  });
  test('未开通、非办客、超知识范围不会成为可保存候选', () => {
    const base = fixtureNetwork();
    expect(physicalLineOptions({ ...base, lines: base.lines.map(row => ({ ...row, from: '2025-01-01' })) }, ON_DATE)).toEqual([]);
    const network = { ...base, passengerPeriods: base.passengerPeriods.filter(row => row.stationId !== 'B') };
    expect(ids(physicalDestinations(network, ON_DATE, 'L1', 'A'))).toEqual(['D']);
    expect(physicalDestinations(network, ON_DATE, 'L1', 'B')).toEqual([]);
    expect(physicalDestinations(base, '2031-01-01', 'L1', 'A')).toEqual([]);
  });
  test('临时停运阻断完整路径，废线不提供录入', () => {
    const base = fixtureNetwork();
    const suspended = { ...base, policies: { ...base.policies, suspensions: [{ lineId: 'L1', sectionIds: ['sBD'], from: ON_DATE, until: null }] } };
    expect(ids(physicalDestinations(suspended, ON_DATE, 'L1', 'A'))).toEqual(['B']);
    expect(physicalLineOptions({ ...base, policies: { ...base.policies, closures: [{ lineId: 'L1', closedOn: ON_DATE }] } }, ON_DATE)).toEqual([]);
  });
  test('环形多径路不猜最短路线、不提供可保存目标', () => {
    const base = fixtureNetwork();
    const loop = { ...base, sections: [...base.sections, { ...base.sections[0], id: 'sDA', fromStationId: 'D', toStationId: 'A' }] };
    expect(physicalDestinations(loop, ON_DATE, 'L1', 'A')).toEqual([]);
  });
});
