/**
 * `src/records/labels.ts` 的行为测试（「名称与用户界面」）。
 *
 * 覆盖在用的站名消歧实现：按规范化站名分组，逐级追加 city → operators → 线路集合的
 * 最小充分限定词，全部拆不开时回退 `station_code`；`onDate` 与快照静态站名两种口径；
 * 以及站/区间搜索的命中字段、标签与明细。
 *
 * 网络尽量复用现有夹具：不涉及同名冲突与搜索排序的用例用 integration/fixtures 的
 * fixtureNetwork；需要制造同名冲突时用 map/fixtures 的最小构造器拼 TransitNetwork。
 */
import { describe, expect, test } from 'vitest';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { buildStationLabels, labelOf, searchNetwork, sectionsAtStation } from '../../src/records/labels';
import { fixtureNetwork, ON_DATE } from '../integration/fixtures';
import { makeNetwork, makeSection, makeStation } from '../map/fixtures';

const PERIOD = { from: '2000-01-01', until: null } as const;

/** 只填消歧实际读取的字段；坐标与居中无关，填 0 保持类型完整。 */
function station(id: string, name: string, cityId = 'c1', code = id): TransitNetwork['stations'][number] {
  return makeStation(id, name, code, 0, 0, cityId);
}

function line(id: string, name: string): TransitNetwork['lines'][number] {
  return { id, name, isLoop: false, directions: [], ...PERIOD };
}

function service(id: string, operatorId: string): TransitNetwork['services'][number] {
  return { id, name: id, operatorId, directions: [], ...PERIOD };
}

function membership(serviceId: string, sectionId: string, sequence = 0): TransitNetwork['memberships'][number] {
  return { serviceId, sectionId, sequence, ...PERIOD };
}

/** 同名站分处两城：城市与运营方都能拆开，按最短充分规则只应追加城市。 */
function sameNameDifferentCity(): TransitNetwork {
  return makeNetwork({
    cities: [{ id: 'c1', name: '示例城' }, { id: 'c2', name: '示例市' }],
    operators: [{ id: 'o1', cityId: 'c1', name: '示例地铁' }, { id: 'o2', cityId: 'c2', name: '示例市地铁' }],
    stations: [
      station('s1', '同名站', 'c1', '101'),
      station('s2', '同名站', 'c2', '201'),
      station('s3', '换乘', 'c1', '102'),
    ],
    lines: [line('l1', '1号线'), line('l2', '2号线')],
    sections: [makeSection('sec1', 'l1', 's1', 's3'), makeSection('sec2', 'l2', 's2', 's3')],
    services: [service('sv1', 'o1'), service('sv2', 'o2')],
    memberships: [membership('sv1', 'sec1'), membership('sv2', 'sec2')],
  });
}

describe('组内没有同名冲突', () => {
  test('标签就是站名本身，不追加后缀也不标记为已消歧', () => {
    const labels = buildStationLabels(fixtureNetwork());
    expect(labels.size).toBe(4);
    expect(labels.get('A')).toEqual({ id: 'A', name: '站A', label: '站A', disambiguated: false });
    expect(labels.get('D')).toEqual({ id: 'D', name: '站D', label: '站D', disambiguated: false });
    expect([...labels.values()].some((label) => label.disambiguated)).toBe(false);
    expect([...labels.values()].some((label) => label.label.includes('（'))).toBe(false);
  });
});

describe('逐级追加限定词（最小充分组合）', () => {
  test('同名站只需城市就能拆开时，只追加城市（不冗余追加运营方）', () => {
    const labels = buildStationLabels(sameNameDifferentCity());
    expect(labels.get('s1')).toEqual({ id: 's1', name: '同名站', label: '同名站（示例城）', disambiguated: true });
    expect(labels.get('s2')!.label).toBe('同名站（示例市）');
    // 未重名的站保持原样。
    expect(labels.get('s3')!.label).toBe('换乘');
  });

  test('城市相同、只有运营方不同时追加运营方', () => {
    const network = makeNetwork({
      cities: [{ id: 'c1', name: '示例城' }],
      operators: [{ id: 'o1', cityId: 'c1', name: '示例地铁' }, { id: 'o2', cityId: 'c1', name: '城际铁路' }],
      stations: [station('s1', '中央'), station('s2', '中央'), station('s3', '换乘')],
      lines: [line('l1', '1号线'), line('l2', '2号线')],
      sections: [makeSection('sec1', 'l1', 's1', 's3'), makeSection('sec2', 'l2', 's2', 's3')],
      services: [service('sv1', 'o1'), service('sv2', 'o2')],
      memberships: [membership('sv1', 'sec1'), membership('sv2', 'sec2')],
    });
    const labels = buildStationLabels(network);
    expect(labels.get('s1')!.label).toBe('中央（示例地铁）');
    expect(labels.get('s2')!.label).toBe('中央（城际铁路）');
    expect(labels.get('s3')).toEqual({ id: 's3', name: '换乘', label: '换乘', disambiguated: false });
  });

  test('城市与运营方都相同时，追加经过的线路集合（生产实现比旧副本多的一层）', () => {
    const network = makeNetwork({
      cities: [{ id: 'c1', name: '示例城' }],
      operators: [{ id: 'o1', cityId: 'c1', name: '示例地铁' }],
      stations: [station('s1', '中央'), station('s2', '中央'), station('s3', '换乘'), station('s4', '北站')],
      lines: [line('l1', '1号线'), line('l2', '2号线'), line('l3', '3号线')],
      sections: [
        makeSection('sec1', 'l1', 's1', 's3'),
        makeSection('sec2', 'l2', 's2', 's3'),
        makeSection('sec3', 'l3', 's1', 's4'),
      ],
      services: [service('sv1', 'o1'), service('sv2', 'o1'), service('sv3', 'o1')],
      memberships: [membership('sv1', 'sec1'), membership('sv2', 'sec2'), membership('sv3', 'sec3')],
    });
    const labels = buildStationLabels(network);
    // 线路集合是「经过该站的线路名」，去重排序后以「、」连接。
    expect(labels.get('s1')!.label).toBe('中央（1号线、3号线）');
    expect(labels.get('s2')!.label).toBe('中央（2号线）');
    expect(labels.get('s3')!.label).toBe('换乘');
  });

  test('城市、运营方、线路集合全同而编号不同时，用 station_code 作最后回退', () => {
    const network = makeNetwork({
      cities: [{ id: 'c1', name: '示例城' }],
      operators: [{ id: 'o1', cityId: 'c1', name: '示例地铁' }],
      stations: [station('s1', '中央', 'c1', '101'), station('s2', '中央', 'c1', '201'), station('s3', '换乘')],
      lines: [line('l1', '1号线')],
      sections: [makeSection('sec1', 'l1', 's1', 's3'), makeSection('sec2', 'l1', 's2', 's3')],
      services: [service('sv1', 'o1')],
      memberships: [membership('sv1', 'sec1'), membership('sv1', 'sec2')],
    });
    const labels = buildStationLabels(network);
    expect(labels.get('s1')!.label).toBe('中央（101）');
    expect(labels.get('s2')!.label).toBe('中央（201）');
    expect(labels.get('s1')!.disambiguated).toBe(true);
    expect(labels.get('s2')!.disambiguated).toBe(true);
  });

  test('上下文缺失的站跳过该字段而不追加空限定词，仍按编号回退', () => {
    const network = makeNetwork({
      cities: [{ id: 'c1', name: '示例城' }],
      stations: [station('s1', '中央', 'c1', '101'), station('s2', '中央', 'c1', '201')],
    });
    const labels = buildStationLabels(network);
    expect(labels.get('s1')!.label).toBe('中央（101）');
    expect(labels.get('s2')!.label).toBe('中央（201）');
  });

  test('剩余冲突才决定追加字段，已追加字段对该组所有标签一致生效', () => {
    const network = makeNetwork({
      cities: [{ id: 'c1', name: '示例城' }, { id: 'c2', name: '示例市' }],
      operators: [{ id: 'o1', cityId: 'c1', name: '示例地铁' }, { id: 'o2', cityId: 'c1', name: '城际铁路' }],
      stations: [
        station('s1', 'X', 'c1', '101'),
        station('s2', 'X', 'c1', '201'),
        station('s3', 'X', 'c2', '301'),
        station('h1', '一号枢纽', 'c1'),
        station('h2', '二号枢纽', 'c1'),
      ],
      lines: [line('l1', '1号线'), line('l2', '2号线')],
      sections: [
        makeSection('sec1', 'l1', 's1', 'h1'),
        makeSection('sec2', 'l2', 's2', 'h2'),
        makeSection('sec3', 'l1', 's3', 'h1'),
      ],
      services: [service('sv1', 'o1'), service('sv2', 'o2')],
      memberships: [membership('sv1', 'sec1'), membership('sv2', 'sec2'), membership('sv1', 'sec3')],
    });
    const labels = buildStationLabels(network);
    // 城市先把组切成 [s1,s2] 与 [s3]，剩下 [s1,s2] 靠运营方拆开；
    // 运营方对整组生效，因此 s3 也带上运营方。
    expect(labels.get('s1')!.label).toBe('X（示例城｜示例地铁）');
    expect(labels.get('s2')!.label).toBe('X（示例城｜城际铁路）');
    expect(labels.get('s3')!.label).toBe('X（示例市｜示例地铁）');
  });

  test('分组用规范化站名折叠空白，展示名随之折叠但不删字', () => {
    const network = makeNetwork({
      cities: [{ id: 'c1', name: '示例城' }, { id: 'c2', name: '示例市' }],
      stations: [
        station('s1', '公园\u3000前', 'c1', '101'),
        station('s2', '公园 前', 'c2', '201'),
      ],
    });
    const labels = buildStationLabels(network);
    expect(labels.get('s1')).toEqual({ id: 's1', name: '公园 前', label: '公园 前（示例城）', disambiguated: true });
    expect(labels.get('s2')!.label).toBe('公园 前（示例市）');
  });
});

describe('onDate：当日有效站名与快照静态站名', () => {
  function datedNetwork(): TransitNetwork {
    return makeNetwork({
      cities: [{ id: 'c1', name: '示例城' }],
      operators: [{ id: 'o1', cityId: 'c1', name: '示例地铁' }],
      stations: [station('s1', '中央'), station('s2', '中央'), station('s3', '公园')],
      lines: [line('l1', '1号线'), line('l2', '2号线')],
      sections: [makeSection('sec1', 'l1', 's1', 's3'), makeSection('sec2', 'l2', 's2', 's3')],
      services: [service('sv1', 'o1'), service('sv2', 'o1')],
      memberships: [membership('sv1', 'sec1'), membership('sv2', 'sec2')],
      names: [
        { stationId: 's1', name: '新中央', ...PERIOD },
        { stationId: 's3', name: '中央公园', from: '2000-01-01', until: '2015-01-01' },
      ],
    });
  }

  test('不传 onDate 时用快照静态站名分组与展示', () => {
    const labels = buildStationLabels(datedNetwork());
    expect(labels.get('s1')!.label).toBe('中央（1号线）');
    expect(labels.get('s2')!.label).toBe('中央（2号线）');
    expect(labels.get('s3')!.label).toBe('公园');
  });

  test('传 onDate 时用当日有效站名分组与展示，不再冲突就不追加限定词', () => {
    const labels = buildStationLabels(datedNetwork(), ON_DATE);
    expect(labels.get('s1')).toEqual({ id: 's1', name: '新中央', label: '新中央', disambiguated: false });
    expect(labels.get('s2')).toEqual({ id: 's2', name: '中央', label: '中央', disambiguated: false });
    // 站名记录在当日已过期，退回车站自身名称。
    expect(labels.get('s3')).toEqual({ id: 's3', name: '公园', label: '公园', disambiguated: false });
  });
});

describe('searchNetwork：站名 / 站码 / 线路 / 端点命中', () => {
  test('按站名命中：返回消歧后的标签与城市·编号明细', () => {
    const stations = searchNetwork(sameNameDifferentCity(), '同名站').filter((hit) => hit.kind === 'station');
    expect(stations.map((hit) => hit.id)).toEqual(['s1', 's2']);
    expect(stations.map((hit) => hit.label)).toEqual(['同名站（示例城）', '同名站（示例市）']);
    expect(stations.map((hit) => hit.detail)).toEqual(['示例城 · 编号 101', '示例市 · 编号 201']);
    expect(stations.every((hit) => hit.matchedField === 'name')).toBe(true);
  });

  test('按站码命中：matchedField 为 code，标签与明细仍取消歧结果', () => {
    const hits = searchNetwork(sameNameDifferentCity(), '201');
    expect(hits).toEqual([
      { kind: 'station', id: 's2', label: '同名站（示例市）', detail: '示例市 · 编号 201', matchedField: 'code' },
    ]);
  });

  test('按线路命中：只返回区间结果，明细是线路名', () => {
    const hits = searchNetwork(sameNameDifferentCity(), '2号线');
    expect(hits.map((hit) => [hit.kind, hit.id, hit.matchedField])).toEqual([['section', 'sec2', 'line']]);
    expect(hits[0]!.label).toBe('同名站（示例市） — 换乘');
    expect(hits[0]!.detail).toBe('2号线');
  });

  test('按端点站名命中：label 是用消歧标签拼的起终点', () => {
    const sections = searchNetwork(sameNameDifferentCity(), '换乘').filter((hit) => hit.kind === 'section');
    expect(sections.map((hit) => hit.id)).toEqual(['sec1', 'sec2']);
    expect(sections.map((hit) => hit.label)).toEqual(['同名站（示例城） — 换乘', '同名站（示例市） — 换乘']);
    expect(sections.map((hit) => hit.detail)).toEqual(['1号线', '2号线']);
    expect(sections.every((hit) => hit.matchedField === 'endpoint')).toBe(true);
  });

  test('只有消歧限定词命中时报 label，不冒充命中站名', () => {
    const stations = searchNetwork(sameNameDifferentCity(), '示例城').filter((hit) => hit.kind === 'station');
    expect(stations).toEqual([
      { kind: 'station', id: 's1', label: '同名站（示例城）', detail: '示例城 · 编号 101', matchedField: 'label' },
    ]);
    // 反向检查：站名与编号都没命中的查询，不能报成 name。
    expect(stations.some((hit) => hit.matchedField === 'name')).toBe(false);
  });

  test('空查询返回空，limit 截断结果', () => {
    expect(searchNetwork(sameNameDifferentCity(), '   ')).toEqual([]);
    expect(searchNetwork(sameNameDifferentCity(), '同名站', 2)).toHaveLength(2);
  });

  test('搜索使用快照静态站名，不读取当日站名', () => {
    // searchNetwork 不接收 onDate，按既有口径只查快照静态站名。
    expect(searchNetwork(datedSearchNetwork(), '新中央')).toEqual([]);
  });
});

/** 与 onDate 用例同构的最小网络；搜索不接受日期，因此这里单独构造避免跨 describe 依赖。 */
function datedSearchNetwork(): TransitNetwork {
  return makeNetwork({
    cities: [{ id: 'c1', name: '示例城' }],
    operators: [{ id: 'o1', cityId: 'c1', name: '示例地铁' }],
    stations: [station('s1', '中央'), station('s2', '中央')],
    lines: [line('l1', '1号线'), line('l2', '2号线')],
    sections: [makeSection('sec1', 'l1', 's1', 's2')],
    services: [service('sv1', 'o1'), service('sv2', 'o1')],
    memberships: [membership('sv1', 'sec1'), membership('sv2', 'sec1')],
    names: [{ stationId: 's1', name: '新中央', ...PERIOD }],
  });
}

describe('单站标签与按站取区间', () => {
  test('labelOf 返回消歧标签，未知站回退到 id', () => {
    const network = sameNameDifferentCity();
    expect(labelOf(network, 's1')).toBe('同名站（示例城）');
    expect(labelOf(network, 's3')).toBe('换乘');
    expect(labelOf(network, 'missing')).toBe('missing');
  });

  test('sectionsAtStation 返回端点含该站的区间，未知站返回空', () => {
    const network = sameNameDifferentCity();
    expect(sectionsAtStation(network, 's3')).toEqual(['sec1', 'sec2']);
    expect(sectionsAtStation(network, 's1')).toEqual(['sec1']);
    expect(sectionsAtStation(network, 'missing')).toEqual([]);
  });
});

describe('消歧只在可选、办客的车站集合内进行', () => {
  /** 两座同名车站，另一座换乘站接起两条线；办客历史由各用例给出。 */
  function collidingNetwork(periods: TransitNetwork['passengerPeriods']): TransitNetwork {
    return makeNetwork({
      cities: [{ id: 'c1', name: '示例城' }],
      operators: [{ id: 'o1', cityId: 'c1', name: '示例地铁' }],
      stations: [station('s1', '同名站'), station('s2', '同名站'), station('s3', '换乘')],
      lines: [line('l1', '1号线'), line('l2', '2号线')],
      sections: [makeSection('sec1', 'l1', 's1', 's3'), makeSection('sec2', 'l2', 's2', 's3')],
      services: [service('sv1', 'o1'), service('sv2', 'o1')],
      memberships: [membership('sv1', 'sec1'), membership('sv2', 'sec2')],
      passengerPeriods: periods,
    });
  }

  test('非办客车站不参与分组，也不让办客站背上限定词', () => {
    const labels = buildStationLabels(collidingNetwork([
      { stationId: 's1', kind: 'passenger', ...PERIOD },
      { stationId: 's2', kind: 'non_passenger', ...PERIOD },
      { stationId: 's3', kind: 'passenger', ...PERIOD },
    ]));
    expect(labels.get('s1')).toEqual({ id: 's1', name: '同名站', label: '同名站', disambiguated: false });
    expect(labels.get('s2')).toEqual({ id: 's2', name: '同名站', label: '同名站', disambiguated: false });
  });

  test('当日已停办的车站不参与当日分组，停办之前仍参与', () => {
    const network = collidingNetwork([
      { stationId: 's1', kind: 'passenger', ...PERIOD },
      { stationId: 's2', kind: 'passenger', from: '2000-01-01', until: '2024-01-01' },
      { stationId: 's3', kind: 'passenger', ...PERIOD },
    ]);
    const after = buildStationLabels(network, '2024-06-01');
    expect(after.get('s1')!.label).toBe('同名站');
    expect(after.get('s2')).toEqual({ id: 's2', name: '同名站', label: '同名站', disambiguated: false });
    const before = buildStationLabels(network, '2023-06-01');
    expect(before.get('s1')!.label).toBe('同名站（1号线）');
    expect(before.get('s2')!.label).toBe('同名站（2号线）');
  });

  test('静态口径没有日期，只纳入办理过客运的车站', () => {
    const labels = buildStationLabels(collidingNetwork([
      { stationId: 's1', kind: 'passenger', from: '2000-01-01', until: '2020-01-01' },
      { stationId: 's2', kind: 'non_passenger', ...PERIOD },
      { stationId: 's3', kind: 'passenger', ...PERIOD },
    ]));
    expect(labels.get('s1')).toEqual({ id: 's1', name: '同名站', label: '同名站', disambiguated: false });
  });
});
