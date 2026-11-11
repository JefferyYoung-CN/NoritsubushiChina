/**
 * 视图切换、可用性与日期边界。
 *
 * App.vue 只做协调：五个视图、键盘左右切换（含回绕）、缺网络/缺工作区/缺日期的
 * 可读禁用原因、以及 1997-01-01～知识截止日的硬边界都在这里验证。
 */
import { describe, expect, test } from 'vitest';
import {
  EARLIEST_DATE, VIEWS, clampDate, clampToWindow, coverageWindow, dateBounds, defaultDate,
  envelopeNotice, isActiveView, localToday, shiftDate, stepView, viewAvailability, viewLabel,
} from '../../src/integration/app-state';

const K = { knowledgeThrough: '2030-12-31' };
const open = { hasNetwork: true, workspaceOpen: true, hasTrip: true };

describe('五视图与键盘切换', () => {
  test('恰好五个视图且标签唯一', () => {
    expect(VIEWS.map(view => view.id)).toEqual(['records', 'saved', 'stats', 'backup', 'advanced']);
    expect(VIEWS.map(view => view.label)).toEqual(['基础记录', '已保存', '统计', '备份', '进阶']);
    expect(new Set(VIEWS.map(view => view.label)).size).toBe(5);
    expect(viewLabel('advanced')).toBe('进阶');
  });

  test('左右切换越界回绕，未知当前值从记录页起算', () => {
    expect(stepView('records', 1)).toBe('saved');
    expect(stepView('advanced', 1)).toBe('records');
    expect(stepView('records', -1)).toBe('advanced');
    expect(stepView('stats', 2)).toBe('advanced');
    expect(stepView('unknown' as never, 1)).toBe('saved');
    expect(stepView('unknown' as never, 0)).toBe('records');
  });

  test('isActiveView 拒绝旧视图名与非字符串', () => {
    expect(isActiveView('records')).toBe(true);
    expect(isActiveView('image')).toBe(false);
    expect(isActiveView('overview')).toBe(false);
    expect(isActiveView('tasks')).toBe(false);
    expect(isActiveView(null)).toBe(false);
    expect(isActiveView(6)).toBe(false);
  });
});

describe('viewAvailability', () => {
  test('缺工作区/缺日期各有可读原因，而不是空白页', () => {
    expect(viewAvailability('stats', { ...open, workspaceOpen: false }))
      .toEqual({ enabled: false, reason: '本地工作区尚未打开，无法进入' });
    expect(viewAvailability('records', { ...open, hasTrip: false }))
      .toEqual({ enabled: true, reason: '' });
    expect(viewAvailability('advanced', { ...open, workspaceOpen: false }))
      .toEqual({ enabled: false, reason: '本地工作区尚未打开，无法进入' });
  });

  test('网络未就绪时所有视图都禁用；就绪后五视图全部可用', () => {
    for (const view of VIEWS) {
      expect(viewAvailability(view.id, { ...open, hasNetwork: false }).enabled).toBe(false);
      expect(viewAvailability(view.id, open).enabled).toBe(true);
    }
    expect(viewAvailability('nope' as never, open)).toEqual({ enabled: false, reason: '未知视图' });
  });

  test('记录入口不要求先构建行程，但仍需打开工作区', () => {
    expect(viewAvailability('records', { hasNetwork: true, workspaceOpen: true, hasTrip: false }).enabled).toBe(true);
    expect(viewAvailability('records', { hasNetwork: true, workspaceOpen: false, hasTrip: false }).enabled).toBe(false);
  });

  test('所选日期无已验证快照时三个数据派生视图禁用且原因可读，备份不受影响', () => {
    const noSnapshot = { ...open, snapshotAvailable: false };
    for (const view of ['records', 'stats', 'advanced'] as const) {
      const availability = viewAvailability(view, noSnapshot);
      expect(availability.enabled).toBe(false);
      expect(availability.reason).toContain('快照');
      expect(availability.reason.length).toBeGreaterThan(10);
    }
    expect(viewAvailability('backup', noSnapshot).enabled).toBe(true);
  });
});

describe('日期边界', () => {
  test('clampDate 夹到 1997-01-01 与知识截止日，非法格式落到截止日', () => {
    expect(clampDate('1996-12-31', K)).toBe(EARLIEST_DATE);
    expect(clampDate('2031-01-01', K)).toBe('2030-12-31');
    expect(clampDate('2024-06-10', K)).toBe('2024-06-10');
    expect(clampDate('2024-2-3', K)).toBe('2030-12-31');
    expect(clampDate('2024-06-10', null)).toBe(EARLIEST_DATE);
  });

  test('shiftDate 跨月并再次夹到边界', () => {
    expect(shiftDate('2024-06-10', 1, K)).toBe('2024-06-11');
    expect(shiftDate('2024-06-10', -1, K)).toBe('2024-06-09');
    expect(shiftDate('2024-06-10', 30, K)).toBe('2024-07-10');
    expect(shiftDate('2030-12-31', 1, K)).toBe('2030-12-31');
    expect(shiftDate('1997-01-01', -1, K)).toBe(EARLIEST_DATE);
  });

  test('dateBounds 以覆盖窗口为上下界', () => {
    const window = { min: '1997-01-01', max: '2026-10-30' } as const;
    expect(dateBounds(window, '1997-01-01')).toEqual({
      min: EARLIEST_DATE, max: '2026-10-30', onDate: '1997-01-01', atMin: true, atMax: false,
    });
    expect(dateBounds(window, '2031-01-01')).toEqual({
      min: EARLIEST_DATE, max: '2026-10-30', onDate: '2026-10-30', atMin: false, atMax: true,
    });
    expect(dateBounds(null, '2024-06-10')).toEqual({
      min: EARLIEST_DATE, max: EARLIEST_DATE, onDate: EARLIEST_DATE, atMin: true, atMax: true,
    });
  });

  test('defaultDate 取本地“今天”并夹到 1997-01-01..知识截止日，不再取快照检查日', () => {
    const network = { knowledgeThrough: '2030-12-31' } as const;
    expect(defaultDate(network, '2025-06-02')).toBe('2025-06-02');
    expect(defaultDate(network, '1996-12-31')).toBe(EARLIEST_DATE);
    expect(defaultDate(network, '2031-01-01')).toBe('2030-12-31');
    // 非法格式不由输入框承载，直接落可达上界，不猜未来日期。
    expect(defaultDate(network, '2024-2-3')).toBe('2030-12-31');
    expect(defaultDate(null, '2025-06-02')).toBe(EARLIEST_DATE);
  });

  test('localToday 用浏览器本地日期，而不是 UTC 日期', () => {
    expect(localToday(new Date(2026, 9, 30, 23, 30))).toBe('2026-10-30');
    expect(localToday(new Date(2026, 0, 1, 0, 15))).toBe('2026-01-01');
  });
});

describe('覆盖窗口与日期夹取', () => {
  test('coverageWindow 取两包并集，并抬到 1997-01-01 下限', () => {
    expect(coverageWindow({ earliestCoverageFrom: '1997-01-01', latestCoverageTo: '2026-10-30' }))
      .toEqual({ min: '1997-01-01', max: '2026-10-30' });
    expect(coverageWindow({ earliestCoverageFrom: '1980-01-01', latestCoverageTo: '2026-10-30' })?.min)
      .toBe(EARLIEST_DATE);
    expect(coverageWindow(null)).toBeNull();
    expect(coverageWindow({ earliestCoverageFrom: null, latestCoverageTo: null })).toBeNull();
  });

  test('窗口内 2010-06-01 原样保留，1996-12-31 被夹到 coverage_from', () => {
    const window = coverageWindow({ earliestCoverageFrom: '1997-01-01', latestCoverageTo: '2026-10-30' })!;
    expect(clampToWindow('2010-06-01', window)).toBe('2010-06-01');
    expect(clampToWindow('1996-12-31', window)).toBe('1997-01-01');
    expect(clampToWindow('2027-01-01', window)).toBe('2026-10-30');
    // 2025-06-02 属于 B 包，但日期控件用两包并集，因此不在这里被夹取。
    expect(clampToWindow('2025-06-02', window)).toBe('2025-06-02');
    expect(clampToWindow('2024-2-3', window)).toBe('2026-10-30');
    expect(clampToWindow('2010-06-01', null)).toBe(EARLIEST_DATE);
  });
});

describe('封套来源提示（envelopeNotice）', () => {
  const REAL = {
    sourceKind: 'real-internal-test', snapshotId: 'demo-snapshot-a',
    onDate: '2026-06-01', coverage: { from: '2025-06-02', to: '2026-10-30' },
  } as const;
  const SIMULATED = {
    sourceKind: 'simulated', snapshotId: 'simulated-demo-0001',
    onDate: '2025-06-01', coverage: { from: '1997-01-01', to: '2025-06-01' },
  } as const;

  test('真实封套不额外提示；模拟封套说清快照 id、覆盖窗口与“在范围内”', () => {
    expect(envelopeNotice(REAL)).toBeNull();
    const notice = envelopeNotice(SIMULATED) ?? '';
    expect(notice).toContain('模拟重建封套');
    expect(notice).toContain('simulated-demo-0001');
    expect(notice).toContain('1997-01-01');
    expect(notice).toContain('2025-06-01');
    expect(notice).toContain('在覆盖范围内');
    expect(notice).toContain('不代表真实运营');
  });

  test('边界日期：等于窗口两端仍算覆盖，越界要明说不在覆盖范围内', () => {
    for (const onDate of ['1997-01-01', '2025-06-01']) {
      expect(envelopeNotice({ ...SIMULATED, onDate })).toContain('在覆盖范围内');
    }
    for (const onDate of ['1996-12-31', '2025-06-02']) {
      const notice = envelopeNotice({ ...SIMULATED, onDate }) ?? '';
      expect(notice).toContain('不在覆盖范围内');
      expect(notice).toContain(onDate);
    }
    // 封套没有声明覆盖窗口时不能假装已知范围。
    expect(envelopeNotice({ ...SIMULATED, coverage: null })).toContain('没有声明覆盖范围');
  });
});
