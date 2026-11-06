import { describe, expect, test } from 'vitest';
import type { CompletionResult } from '../../src/integration/completion';
import { describeRouteCompletion, UNAVAILABLE_COMPLETION } from '../../src/integration/route-completion';
import type { CalculationContext, CalculationState, CalculationStatus } from '../../src/stats/calculation';

const EXPECTED = { onDate: '2024-06-10', snapshotId: 'snap-2024-01-01' } as const;

/** 只构造被读取的字段：overall 是总体完乘并集，按 completion.mjs 的派生形状给出。 */
function derived(overall: readonly string[], firstCompletedOn = '2024-05-01'): CompletionResult {
  return {
    basic: [], advanced: [], stations: [], pending: [], contributions: [], statistics: null,
    overall: overall.map(sectionId => ({ sectionId, firstCompletedOn })),
  } as unknown as CompletionResult;
}
function calculation(status: CalculationStatus, context: CalculationContext | null = EXPECTED): CalculationState {
  return { status, generation: 1, context, error: null };
}
function run(input: Partial<Parameters<typeof describeRouteCompletion>[0]> = {}) {
  return describeRouteCompletion({ derived: null, calculation: null, expected: EXPECTED, busy: false, phase: 'ready', ...input });
}

describe('线路图完乘三态', () => {
  test('当前日期与快照的结果算好就交出总体完乘并集，不带说明文字', () => {
    const result = run({ derived: derived(['sAB', 'sBD']), calculation: calculation('ready') });
    expect(result.kind).toBe('ready');
    expect(result.message).toBe('');
    expect(result.completedSectionIds).toEqual(['sAB', 'sBD']);
  });

  test('重算进行中按 loading 降级，且不交出任何已乘坐区间', () => {
    const result = run({ derived: derived(['sAB']), calculation: calculation('running') });
    expect(result.kind).toBe('loading');
    expect(result.message).toContain('中性线');
    expect(result.completedSectionIds).toEqual([]);
  });

  test('应用级忙时即使是旧结果也不上色', () => {
    const result = run({ derived: derived(['sAB']), calculation: calculation('ready'), busy: true });
    expect(result.kind).toBe('loading');
    expect(result.completedSectionIds).toEqual([]);
  });

  test('无结果或计算失败按不可用降级，并说明不代表「未乘坐」', () => {
    for (const input of [
      { derived: null, calculation: null },
      { derived: derived(['sAB']), calculation: calculation('failed') },
      { derived: derived(['sAB']), calculation: calculation('ready', { ...EXPECTED, onDate: '2024-06-09' }) },
    ]) {
      const result = run(input);
      expect(result.kind).toBe('unavailable');
      expect(result.message).toContain('不代表「未乘坐」');
      expect(result.completedSectionIds).toEqual([]);
    }
    expect(UNAVAILABLE_COMPLETION.kind).toBe('unavailable');
  });

  test('工作区打开中按 loading；没有结果或打不开按不可用', () => {
    // 只有「待重算」但没有结果，不能说自己正在重算：对图来说仍然不可用。
    expect(run({ derived: null, calculation: calculation('pending') }).kind).toBe('unavailable');
    expect(run({ phase: 'opening' }).kind).toBe('loading');
    expect(run({ derived: derived(['sAB']), calculation: calculation('ready'), phase: 'error' }).kind).toBe('unavailable');
  });

  test('反向断言：非 ready 的任何一态都拿不到已乘坐区间', () => {
    const cases = [
      run({ derived: derived(['sAB']), calculation: calculation('running') }),
      run({ derived: derived(['sAB']), calculation: calculation('failed') }),
      run({ derived: null, calculation: null }),
      run({ derived: derived(['sAB']), calculation: calculation('ready'), busy: true }),
    ];
    for (const result of cases) {
      expect(result.kind).not.toBe('ready');
      expect(result.completedSectionIds).toHaveLength(0);
    }
  });

  test('计算上下文缺失或对不上时绝不放行：日期未知的旧结果一律不可用', () => {
    // calculation=null + 有 derived：describeCalculation 会放行并算 ready，本图不能跟着放行。
    expect(run({ derived: derived(['sAB']), calculation: null }).kind).toBe('unavailable');
    expect(run({ derived: derived(['sAB']), calculation: calculation('ready', { ...EXPECTED, snapshotId: 'snap-旧' }) }).kind)
      .toBe('unavailable');
    // 重算中即使还没有结果也是 loading，不能误判成不可用。
    expect(run({ derived: null, calculation: calculation('running') }).kind).toBe('loading');
  });
});
