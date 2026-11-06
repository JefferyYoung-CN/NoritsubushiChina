import { describe, expect, test } from 'vitest';
import { buildDimensionStatistics } from '../../src/stats/dimensions';
import { statisticsRows as groupedStatisticsRows } from '../../src/stats/statistics';
import { fixtureNetwork } from '../integration/fixtures';
import { dimensionCompletion, dimensionNetwork, ON_DATE } from './dimension-fixtures';

const statisticsRows: typeof groupedStatisticsRows = (...args) => groupedStatisticsRows(...args).filter(row => !row.subtotal);
const cityNames = new Map([['c1', '示例市']]);

describe('运营商和运营线路的物理区间集合', () => {
  test('区间废弃后保留最后共同有效的服务归属，不借用更晚但从未提供服务的成员', () => {
    const original = fixtureNetwork();
    const network = { ...original,
      operators: [...original.operators, { id: 'op2', cityId: 'c1', name: '运营二' }],
      services: [...original.services,
        { ...original.services[0], id: 'S2', operatorId: 'op2', from: '2024-03-01', until: '2024-05-01' },
        { ...original.services[0], id: 'S3', from: '2024-06-01' }],
      sections: original.sections.map(row => row.id === 'sAB' ? { ...row, until: ON_DATE } : row),
      memberships: [
        ...original.memberships.map(row => row.sectionId === 'sAB' ? { ...row, until: '2024-03-01' } : row),
        { ...original.memberships[0], serviceId: 'S2', from: '2024-03-01', until: ON_DATE },
        { ...original.memberships[0], serviceId: 'S3', from: '2024-05-01', until: '2024-06-01' },
      ],
      policies: { ...original.policies, closures: [{ lineId: 'L1', closedOn: ON_DATE, sectionIds: ['sAB'] }] },
    };
    const result = dimensionCompletion(network);
    const dimensions = buildDimensionStatistics(network, result);
    expect(dimensions.lines.map(row => row.id)).toEqual(['S1', 'S2']);
    expect(dimensions.lines.find(row => row.id === 'S1')).toMatchObject({
      normal: { denominator: { sectionCount: 1 } }, retired: { denominator: { sectionCount: 0 } },
    });
    expect(dimensions.lines.find(row => row.id === 'S2')?.retired).toMatchObject({
      denominator: { sectionCount: 1, lengthMetres: 1000 }, completed: { sectionCount: 1 },
    });
    expect(dimensions.operators.find(row => row.id === 'op1')?.retired.denominator.sectionCount).toBe(0);
    expect(dimensions.operators.find(row => row.id === 'op2')?.retired.denominator.sectionCount).toBe(1);
    expect(result.statistics.retired.denominator.sectionCount).toBe(1);
  });

  test('只有一条运营线路的运营商与该线路口径相同，未提供服务的区间不硬塞进分组', () => {
    const network = fixtureNetwork();
    const dimensions = buildDimensionStatistics(network, dimensionCompletion(network));
    expect(dimensions.operators).toHaveLength(1);
    expect(dimensions.lines).toHaveLength(1);
    expect(dimensions.operators[0].normal).toEqual(dimensions.lines[0].normal);
    expect(dimensions.operators[0].normal.denominator).toMatchObject({ sectionCount: 2, lengthMetres: 2000 });
    expect(dimensions.operators[0].normal.completed).toMatchObject({ sectionCount: 1, lengthMetres: 1000 });
    expect(dimensions.operators[0].normalStations).toEqual({ completed: 2, denominator: 3 });
  });

  test('同一物理线路跨运营商、同名服务仍按服务 ID 分组，不从物理线路猜运营商', () => {
    const network = dimensionNetwork();
    const dimensions = buildDimensionStatistics(network, dimensionCompletion(network));
    expect(dimensions.operators.map(row => row.id)).toEqual(['op1', 'op2']);
    expect(dimensions.lines.map(row => row.id)).toEqual(['S1', 'S2', 'S3']);
    expect(dimensions.lines[0].label).toBe(dimensions.lines[2].label);
    expect(dimensions.operators[1].normal).toEqual(dimensions.lines[2].normal);
    expect(dimensions.operators[1].normal.denominator.sectionCount).toBe(1);
  });

  test('多线路共用区间、重复成员及完成事实均只在组内计一次；跨组不强行凑全网', () => {
    const original = dimensionNetwork();
    const network = { ...original, memberships: [...original.memberships, original.memberships[0]] };
    const result = dimensionCompletion(network, ON_DATE, ['sAB', 'sAB'], ['A', 'A', 'B']);
    const dimensions = buildDimensionStatistics(network, result);
    expect(dimensions.operators[0].normal.denominator).toMatchObject({ sectionCount: 3, lengthMetres: 3000 });
    expect(dimensions.operators[0].normal.completed).toMatchObject({ sectionCount: 1, lengthMetres: 1000 });
    expect(dimensions.operators[0].normalStations).toEqual({ completed: 2, denominator: 4 });
    expect(dimensions.lines.map(row => row.normal.denominator.sectionCount)).toEqual([2, 2, 1]);
    expect(result.statistics.normal.denominator.lengthMetres).toBe(8000);
    expect(dimensions.operators.reduce((sum, row) => sum + row.normal.denominator.lengthMetres!, 0)).toBe(4000);
    expect(dimensions.lines.reduce((sum, row) => sum + row.normal.denominator.lengthMetres!, 0)).toBe(5000);
  });

  test('未乘坐时保留有效分母，车站完成不把途经站自动补成已完成', () => {
    const network = fixtureNetwork();
    const empty = buildDimensionStatistics(network, dimensionCompletion(network, ON_DATE, [], []));
    expect(empty.lines[0].normal.completed).toMatchObject({ sectionCount: 0, lengthMetres: 0 });
    expect(empty.lines[0].normal.denominator.sectionCount).toBe(2);
    expect(empty.lines[0].normalStations).toEqual({ completed: 0, denominator: 3 });
    const travelled = buildDimensionStatistics(network, dimensionCompletion(network, ON_DATE, ['sAB', 'sBD'], ['A', 'D']));
    expect(travelled.lines[0].normalStations).toEqual({ completed: 2, denominator: 3 });
  });

  test('开通前日期无任何分组；空线网也不伪造零值行', () => {
    const network = dimensionNetwork();
    expect(buildDimensionStatistics(network, dimensionCompletion(network, '1997-01-01', [], [])))
      .toEqual({ onDate: '1997-01-01', snapshotId: network.snapshotId, operators: [], lines: [], physicalLines: [], grouped: { operators: [], lines: [], physicalLines: [] } });
    const empty = { ...network, services: [], memberships: [], sections: [] };
    expect(buildDimensionStatistics(empty, dimensionCompletion(empty)).lines).toEqual([]);
  });

  test.each(['service', 'membership', 'section', 'line'] as const)('%s 的 until 当天已失效', target => {
    const original = fixtureNetwork();
    const network = {
      ...original,
      services: original.services.map(row => target === 'service' ? { ...row, until: ON_DATE } : row),
      memberships: original.memberships.map(row => target === 'membership' ? { ...row, until: ON_DATE } : row),
      sections: original.sections.map(row => target === 'section' ? { ...row, until: ON_DATE } : row),
      lines: original.lines.map(row => target === 'line' ? { ...row, until: ON_DATE } : row),
    };
    const dimensions = buildDimensionStatistics(network, dimensionCompletion(network));
    expect(dimensions.operators).toEqual([]);
    expect(dimensions.lines).toEqual([]);
  });

  test('临时停运仍在分母内，废线与现有统计使用相同的关闭前一天区间集合', () => {
    const original = fixtureNetwork();
    const suspended = { ...original, policies: { ...original.policies,
      suspensions: [{ lineId: 'L1', sectionIds: ['sAB'], from: ON_DATE, until: null }] } };
    const suspendedResult = dimensionCompletion(suspended);
    expect(buildDimensionStatistics(suspended, suspendedResult).lines[0].normal.denominator.sectionCount).toBe(2);
    expect(suspendedResult.statistics.temporarySectionCount).toBe(1);
    const retired = { ...original, sections: original.sections.map(row => ({ ...row, until: ON_DATE })),
      policies: { ...original.policies, closures: [{ lineId: 'L1', closedOn: ON_DATE }] } };
    const result = dimensionCompletion(retired);
    const dimensions = buildDimensionStatistics(retired, result);
    expect(dimensions.lines[0].normal.denominator.sectionCount).toBe(0);
    expect(dimensions.lines[0].retired.denominator).toMatchObject({ sectionCount: 2, lengthMetres: 2000 });
    expect(dimensions.lines[0].retiredStations).toEqual({ completed: 2, denominator: 3 });
    expect(statisticsRows(result.statistics, { basis: 'sections', area: 'all', includeRetired: false, dimension: 'lines' }, cityNames, dimensions)).toEqual([]);
    expect(statisticsRows(result.statistics, { basis: 'sections', area: 'all', includeRetired: true, dimension: 'lines' }, cityNames, dimensions))
      .toEqual([expect.objectContaining({ id: 'lines:S1:retired', completed: '1 个区间', denominator: '2 个区间', retired: true })]);
  });

  test.each(['absent', 'incomplete'] as const)('无里程或缺里程（%s）不伪造为零公里', kind => {
    const original = fixtureNetwork();
    const network = { ...original,
      sections: original.sections.map(row => kind === 'incomplete' && row.id === 'sBD' ? { ...row, lengthMetres: null } : row),
      policies: { ...original.policies, noMileageSections: kind === 'absent' ? ['sAB'] : [] },
    };
    const result = dimensionCompletion(network);
    const dimensions = buildDimensionStatistics(network, result);
    const scope = { basis: 'mileage', area: 'all', includeRetired: false, dimension: 'operators' } as const;
    const rows = statisticsRows(result.statistics, scope, cityNames, dimensions);
    expect(rows[0].denominator).toBe(kind === 'absent' ? '无里程' : '—');
    expect(rows[0].note).toContain(kind === 'absent' ? '无里程' : '里程不完整');
    expect(statisticsRows(result.statistics, { ...scope, basis: 'sections' }, cityNames, dimensions)[0].denominator).toBe('2 个区间');
  });

  test('旧日期或旧快照的分组不得冒充当前结果，聚合边界拒绝错配和未知日期', () => {
    const network = dimensionNetwork();
    const result = dimensionCompletion(network);
    const dimensions = buildDimensionStatistics(network, result);
    const scope = { basis: 'mileage', area: 'all', includeRetired: false, dimension: 'operators' } as const;
    for (const stale of [null, { ...dimensions, onDate: '2024-06-09' }, { ...dimensions, snapshotId: 'other' }]) {
      expect(statisticsRows(result.statistics, scope, cityNames, stale)).toEqual([]);
    }
    for (const patch of [{ snapshotId: 'other' }, { onDate: '2031-01-01' }, { onDate: '' }]) {
      expect(() => buildDimensionStatistics(network, { ...result, statistics: { ...result.statistics, ...patch } })).toThrow();
    }
  });

  test('全网/城市每个原有数字保持不变，输入与返回值之间没有共享可变状态', () => {
    const network = dimensionNetwork();
    const result = dimensionCompletion(network);
    const before = structuredClone({ network, result });
    const dimensions = buildDimensionStatistics(network, result);
    for (const area of ['all', 'c1']) {
      const scope = { basis: 'mileage', area, includeRetired: false } as const;
      const rows = statisticsRows(result.statistics, scope, cityNames, dimensions);
      expect(rows).toEqual(statisticsRows(result.statistics, scope, cityNames));
      expect(rows[0]).toMatchObject({ completed: '1.00 公里', denominator: '8.00 公里' });
      const counts = statisticsRows(result.statistics, { ...scope, basis: 'sections' }, cityNames, dimensions);
      expect(counts[0]).toMatchObject({ completed: '1 个区间', denominator: '4 个区间' });
    }
    expect({ network, result }).toEqual(before);
    expect(dimensions.lines[0].normal).not.toBe(dimensions.operators[0].normal);
    expect(dimensions.lines[0].normal).not.toBe(result.statistics.normal);
  });
});
