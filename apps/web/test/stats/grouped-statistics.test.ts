import { expect, test } from 'vitest';
import { buildDimensionStatistics } from '../../src/stats/dimensions';
import { statisticsRows, statisticsTotals } from '../../src/stats/statistics';
import { dimensionCompletion, dimensionNetwork, ON_DATE } from './dimension-fixtures';

function classifiedNetwork() {
  const base = dimensionNetwork();
  return { ...base,
    operators: [
      { ...base.operators[0], category: 'urban' as const },
      { ...base.operators[1], cityId: 'c1', category: 'urban' as const },
      { id: 'rail', name: '国铁运营商', cityId: null, category: 'national' as const },
      { id: 'inter', name: '城际运营商', cityId: null, category: 'intercity' as const },
    ],
    services: [...base.services,
      { ...base.services[0], id: 'rail-service', operatorId: 'rail' },
      { ...base.services[0], id: 'inter-service', operatorId: 'inter' }],
    memberships: [...base.memberships,
      { ...base.memberships[0], serviceId: 'rail-service' },
      { ...base.memberships[0], serviceId: 'inter-service' }],
  };
}

test('运营商和两种线路按类型、城市分层，小计对共用区间与车站分别去重', () => {
  const network = classifiedNetwork();
  const dimensions = buildDimensionStatistics(network, dimensionCompletion(network));
  for (const dimension of ['operators', 'physicalLines', 'lines'] as const) {
    const rows = dimensions.grouped[dimension];
    expect(rows.filter(row => row.subtotal && row.level === 0).map(row => row.label)).toEqual(
      expect.arrayContaining(['国铁 小计', '跨市城际铁路 小计', '城市轨道交通（地铁、有轨） 小计']));
    const city = rows.find(row => row.id === 'region:urban:c1')!;
    expect(city.label).toBe('示例市 小计');
    expect(city.normal.denominator.sectionCount).toBe(3);
    expect(city.normal.denominator.lengthMetres).toBe(3000);
    expect(city.normalStations).toEqual({ completed: 2, denominator: 4 });
    expect(rows.some(row => row.level === 2 && !row.subtotal)).toBe(true);
  }
  expect(dimensions.physicalLines).toHaveLength(1);
  expect(dimensions.lines).toHaveLength(5);
  // Physical lines include valid sections that currently have no service membership.
  expect(dimensions.physicalLines[0].normal.denominator.sectionCount).toBe(4);
  expect(dimensions.grouped.physicalLines.some(row => row.label === '待分类 小计')).toBe(true);
  const scope = { basis: 'sections', area: 'all', dimension: 'lines', includeRetired: true } as const;
  expect(statisticsTotals(dimensionCompletion(network).statistics, scope)[0].denominator).toBe('4 个区间');
});

test('废线使用关闭前一天的服务归属，过期服务仍进入分组，取消含废线后隐藏', () => {
  const base = classifiedNetwork();
  const network = { ...base,
    services: base.services.map(row => ({ ...row, until: ON_DATE })),
    memberships: base.memberships.map(row => ({ ...row, until: ON_DATE })),
    sections: base.sections.map(row => ({ ...row, until: ON_DATE })),
    policies: { ...base.policies, closures: [{ lineId: 'L1', closedOn: ON_DATE }] },
  };
  const result = dimensionCompletion(network);
  const dimensions = buildDimensionStatistics(network, result);
  for (const dimension of ['operators', 'physicalLines', 'lines'] as const) {
    const scope = { basis: 'sections', area: 'all', dimension, includeRetired: true } as const;
    const rows = statisticsRows(result.statistics, scope, new Map(), dimensions);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.retired)).toBe(true);
    expect(rows.some(row => row.label.includes('小计'))).toBe(true);
    expect(statisticsRows(result.statistics, { ...scope, includeRetired: false }, new Map(), dimensions)).toEqual([]);
  }
});
