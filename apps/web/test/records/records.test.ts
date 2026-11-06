import { describe, expect, test } from 'vitest';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { buildStationLabels, searchNetwork } from '../../src/records/labels';
import { draftProblems, summarizeRecords } from '../../src/records/record-commands';

function network(): TransitNetwork {
  return {
    cities: [{ id: 'c1', name: '示例城' }, { id: 'c2', name: '示例市' }],
    operators: [{ id: 'o1', cityId: 'c1', name: '示例地铁' }, { id: 'o2', cityId: 'c2', name: '示例市地铁' }],
    stations: [
      { id: 's1', code: '101', name: '同名站', cityId: 'c1', latitude: 23, longitude: 113 },
      { id: 's2', code: '201', name: '同名站', cityId: 'c2', latitude: null, longitude: null },
      { id: 's3', code: '102', name: '示例站', cityId: 'c1', latitude: 23, longitude: 113 },
    ],
    lines: [{ id: 'l1', name: '1号线' }, { id: 'l2', name: '2号线' }],
    sections: [
      { id: 'sec1', lineId: 'l1', fromStationId: 's1', toStationId: 's3' },
      { id: 'sec2', lineId: 'l2', fromStationId: 's2', toStationId: 's3' },
    ],
    services: [{ id: 'sv1', name: '1号线服务', operatorId: 'o1' }, { id: 'sv2', name: '2号线服务', operatorId: 'o2' }],
    memberships: [
      { serviceId: 'sv1', sectionId: 'sec1', sequence: 0 },
      { serviceId: 'sv2', sectionId: 'sec2', sequence: 0 },
    ],
  } as unknown as TransitNetwork;
}

describe('站名消歧与搜索', () => {
  test('同名站按城市附加限定词，唯一站名不附加', () => {
    const labels = buildStationLabels(network());
    expect(labels.get('s1')?.label).toContain('同名站');
    expect(labels.get('s1')?.label).toContain('示例城');
    expect(labels.get('s2')?.label).toContain('示例市');
    expect(labels.get('s1')?.label).not.toBe(labels.get('s2')?.label);
    expect(labels.get('s3')?.label).toBe('示例站');
  });

  test('搜索命中站名、编号与线路，且结果稳定', () => {
    const hits = searchNetwork(network(), '同名');
    expect(hits.filter((hit) => hit.kind === 'station')).toHaveLength(2);
    expect(hits.some((hit) => hit.kind === 'section')).toBe(true);
    expect(searchNetwork(network(), '101')[0]?.id).toBe('s1');
    const byLine = searchNetwork(network(), '2号线');
    expect(byLine[0]?.kind).toBe('section');
    expect(searchNetwork(network(), '   ')).toEqual([]);
  });
});

describe('记录草稿与列表摘要', () => {
  const base = {
    layer: 'basic' as const,
    onDate: '2026-05-01',
    fromStationId: 's1',
    toStationId: 's3',
    serviceLineId: 'sv1',
    note: '',
    vehicle: '',
  };

  test('缺线路、同起终点与坏日期都会阻止提交', () => {
    expect(draftProblems(base)).toEqual([]);
    expect(draftProblems({ ...base, serviceLineId: null })).toHaveLength(1);
    expect(draftProblems({ ...base, toStationId: 's1' })).toHaveLength(1);
    expect(draftProblems({ ...base, onDate: '2026/05/01' })).toHaveLength(1);
  });

  test('列表摘要保留未知站 id 而不伪造名称', () => {
    const rows = summarizeRecords(
      {
        basic: [{ id: 'r1', occurredOn: '2026-05-01', fromStationId: 's1', toStationId: 'missing', note: 'n', vehicle: '' }],
        advanced: [],
      },
      network(),
    );
    expect(rows[0]?.endpoints).toContain('同名站');
    expect(rows[0]?.endpoints).toContain('missing');
  });
});
