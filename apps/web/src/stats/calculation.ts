/**
 * 重算状态展示的纯逻辑（ADR-0010）。
 *
 * 只解释持久化端口暴露的 `calculation` 与 `derived`，不触发计算：
 * running 必须显示进行中；被打断或记录变更后应是 pending；旧 derived
 * 必须明确标注为旧结果，不能冒充当前日期的结果。
 */

export type CalculationStatus = 'pending' | 'running' | 'ready' | 'failed';

export interface CalculationContext {
  readonly onDate: string;
  readonly snapshotId: string;
  readonly inputRevision?: number;
}

export interface CalculationState {
  readonly status: CalculationStatus;
  readonly generation: number;
  readonly context: CalculationContext | null;
  readonly error: string | null;
}

export interface CalculationExpectation {
  readonly onDate: string;
  readonly snapshotId: string;
}

export type CalculationKind = 'none' | 'pending' | 'running' | 'ready' | 'stale' | 'failed';

export interface CalculationView {
  readonly kind: CalculationKind;
  readonly message: string;
  readonly retryable: boolean;
  /** true 表示页面正在展示的 derived 不是当前期望日期的结果。 */
  readonly showsOldResult: boolean;
  readonly resultOnDate: string | null;
  readonly resultSnapshotId: string | null;
}

function matches(context: CalculationContext | null, expected: CalculationExpectation): boolean {
  return context !== null && context.onDate === expected.onDate && context.snapshotId === expected.snapshotId;
}

export function describeCalculation(
  calculation: CalculationState | null,
  derived: unknown,
  expected: CalculationExpectation,
): CalculationView {
  const hasResult = derived !== null && derived !== undefined;
  const context = calculation?.context ?? null;
  const base = {
    retryable: false,
    showsOldResult: false,
    resultOnDate: context?.onDate ?? null,
    resultSnapshotId: context?.snapshotId ?? null,
  };
  if (!calculation) {
    return { ...base, kind: hasResult ? 'ready' : 'none', message: hasResult ? '已有统计结果。' : '尚未计算统计。' };
  }
  switch (calculation.status) {
    case 'failed':
      return {
        ...base,
        kind: 'failed',
        message: `统计计算失败${calculation.error ? `（${calculation.error}）` : ''}，可重试；当前结果${hasResult ? '为旧结果' : '不可用'}。`,
        retryable: true,
        showsOldResult: hasResult,
      };
    case 'running':
      if (matches(context, expected)) {
        return { ...base, kind: 'running', message: `正在计算 ${expected.onDate} 的统计…`, retryable: false };
      }
      return {
        ...base,
        kind: 'stale',
        message: `正在按其他日期计算；当前展示的是 ${context?.onDate ?? '未知日期'} 的旧结果。`,
        retryable: false,
        showsOldResult: true,
      };
    case 'pending':
      if (hasResult) {
        return {
          ...base,
          kind: 'stale',
          message: `记录已更新，等待重算；当前展示的是旧结果（${context?.onDate ?? '日期未知'}）。`,
          retryable: true,
          showsOldResult: true,
        };
      }
      return { ...base, kind: 'pending', message: '记录已保存，等待重算统计。', retryable: true };
    case 'ready':
    default:
      if (!hasResult) {
        return { ...base, kind: 'none', message: '尚无统计结果，请重算。', retryable: true };
      }
      if (matches(context, expected)) {
        return { ...base, kind: 'ready', message: `统计结果对应 ${expected.onDate}。`, retryable: true };
      }
      return {
        ...base,
        kind: 'stale',
        // 与 showsOldResult 保持一致：界面上的「旧结果」徽标只是视觉强调，
        // 句子里必须已经说明它是旧结果，读屏才不需要再念一次徽标。
        message: `统计结果的业务日期或快照与当前选择不同（${context?.onDate ?? '未知'} / ${context?.snapshotId ?? '未知'}）；当前展示的是旧结果，请重算。`,
        retryable: true,
        showsOldResult: true,
      };
  }
}

/** 是否允许点击重算：失败、待算、旧结果或允许刷新当前结果。 */
export function canRecalculate(view: CalculationView): boolean {
  return view.retryable && view.kind !== 'running';
}
