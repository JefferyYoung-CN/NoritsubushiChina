import { describe, expect, test } from 'vitest';
import { describeCalculation, canRecalculate } from '../../src/stats/calculation';
import {
  formatLength,
  statisticsRows,
  statisticsTotals,
  statisticsSubtitle,
  type StatisticsData,
} from '../../src/stats/statistics';

function summary(completedMetres: number | null, denominatorMetres: number | null, noMileage = false) {
  const basis = noMileage ? ('sections' as const) : ('metres' as const);
  return {
    denominator: {
      sectionCount: 10,
      lengthMetres: denominatorMetres,
      statisticsBasis: basis,
      noMileageLabel: noMileage,
      mileageStatus: noMileage ? ('not-provided' as const) : ('available' as const),
    },
    completed: {
      sectionCount: 4,
      lengthMetres: completedMetres,
      statisticsBasis: basis,
      noMileageLabel: noMileage,
      mileageStatus: noMileage ? ('not-provided' as const) : ('available' as const),
    },
  };
}

const data: StatisticsData = {
  onDate: '2026-05-01',
  snapshotId: 'snap-1',
  normal: summary(2500, 10000),
  retired: summary(800, 2000, true),
  temporarySectionCount: 2,
  cities: [{ cityId: 'c1', normal: summary(1000, 4000), retired: summary(0, 1000, true), completedStationCount: 3 }],
};

const cityNames = new Map([['c1', '示例城']]);

describe('统计口径', () => {
  test('里程格式化在缺失时显示占位而非 0', () => {
    expect(formatLength(1500)).toBe('1.50 公里');
    expect(formatLength(null)).toBe('—');
  });

  test('全网里程口径与城市区间口径可切换，并标注废线与停运', () => {
    const mileage = statisticsRows(data, { basis: 'mileage', area: 'all', includeRetired: true }, cityNames);
    expect(mileage.map((row) => row.id)).toEqual(['city:c1:normal', 'city:c1:retired']);
    expect(statisticsTotals(data, { basis: 'mileage', area: 'all', includeRetired: true })[0]?.completed).toBe('2.50 公里');
    expect(mileage[0]?.denominator).toBe('4.00 公里');

    const city = statisticsRows(data, { basis: 'sections', area: 'c1', includeRetired: false }, cityNames);
    expect(city).toHaveLength(1);
    expect(city[0]?.completed).toBe('4 个区间');
    expect(city[0]?.label).toContain('示例城');

    expect(statisticsSubtitle(data, { basis: 'mileage', area: 'all', includeRetired: false })).toContain('临时停运 2 个区间');
  });

  test('无里程范围明确显示“无里程”', () => {
    const rows = statisticsRows(data, { basis: 'mileage', area: 'all', includeRetired: true }, cityNames);
    expect(rows[1]?.completed).toBe('无里程');
    expect(rows[1]?.note).toContain('无里程');
  });
});

describe('重算状态表现', () => {
  const expected = { onDate: '2026-05-01', snapshotId: 'snap-1' };
  const calc = (status: 'pending' | 'running' | 'ready' | 'failed', context = expected, error: string | null = null) => ({
    status,
    generation: 1,
    context,
    error,
  });

  test('运行中/待算/就绪如实呈现', () => {
    expect(describeCalculation(calc('running'), null, expected).kind).toBe('running');
    expect(describeCalculation(calc('pending'), null, expected).kind).toBe('pending');
    expect(describeCalculation(calc('ready'), {}, expected).kind).toBe('ready');
  });

  test('旧 derived 标注为旧结果且可重算', () => {
    const stale = describeCalculation(calc('ready', { ...expected, onDate: '2026-04-01' }), {}, expected);
    expect(stale.kind).toBe('stale');
    expect(stale.showsOldResult).toBe(true);
    expect(canRecalculate(stale)).toBe(true);
    const pendingOld = describeCalculation(calc('pending'), {}, expected);
    expect(pendingOld.kind).toBe('stale');
    expect(pendingOld.message).toContain('旧');
  });

  test('失败可重试且保留旧结果提示', () => {
    const failed = describeCalculation(calc('failed', expected, 'E_CALCULATION'), {}, expected);
    expect(failed.kind).toBe('failed');
    expect(failed.retryable).toBe(true);
    expect(failed.showsOldResult).toBe(true);
  });
});
