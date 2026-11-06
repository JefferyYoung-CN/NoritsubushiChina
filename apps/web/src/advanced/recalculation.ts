/**
 * 重算状态展示与可取消的异步编排（P5 S7；ADR-0010 重开→pending、保留旧结果）。
 *
 * 与 stats/calculation.ts 的 describeCalculation 同语义，但那边是 .ts 且 Node 的
 * type-stripping 运行时无法解析无扩展名的同目录导入，故在 advanced 内保留一份最小实现；
 * 统计面板仍以 stats/calculation.ts 为准，两份文案如有变化需同步。
 *
 * 本模块不触发重算、不写存储：重算仍由会话层 recalculate(port,network,onDate,compute) 完成。
 */

export type RecalculationKind = 'none' | 'pending' | 'running' | 'ready' | 'stale' | 'failed';

export interface CalculationLike {
  readonly status: 'pending' | 'running' | 'ready' | 'failed';
  readonly generation: number;
  readonly context: { readonly onDate: string; readonly snapshotId: string; readonly inputRevision?: number } | null;
  readonly error: string | null;
}

export interface DerivedContext {
  readonly onDate: string;
  readonly snapshotId: string;
}

export interface RecalculationView {
  readonly kind: RecalculationKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly showsOldResult: boolean;
  readonly resultOnDate: string | null;
  readonly resultSnapshotId: string | null;
}

export function derivedContext(derived: unknown): DerivedContext | null {
  if (typeof derived !== 'object' || derived === null) return null;
  const row = derived as { onDate?: unknown; snapshotId?: unknown };
  if (typeof row.onDate !== 'string' || typeof row.snapshotId !== 'string') return null;
  return { onDate: row.onDate, snapshotId: row.snapshotId };
}

/** 只描述状态，不改状态；删除记录后由会话层把 calculation 置 pending，这里给出对应文案。 */
export function describeRecalculation(
  calculation: CalculationLike | null,
  derived: unknown,
  expected: DerivedContext,
): RecalculationView {
  const old = derivedContext(derived);
  const base = {
    showsOldResult: old !== null,
    resultOnDate: old ? old.onDate : null,
    resultSnapshotId: old ? old.snapshotId : null,
  };
  if (!calculation) {
    return Object.freeze({ kind: 'none', message: '尚未计算；记录保存后再重算。', retryable: false, ...base, showsOldResult: false });
  }
  switch (calculation.status) {
    case 'running':
      return Object.freeze({ kind: 'running', message: '正在按当前记录重算…', retryable: false, ...base });
    case 'failed':
      return Object.freeze({
        kind: 'failed',
        message: calculation.error ? `重算失败：${calculation.error}` : '重算失败，可重试。',
        retryable: true,
        ...base,
      });
    case 'pending':
      return Object.freeze({ kind: 'pending', message: '记录已变更，等待重算；旧结果仅供参考。', retryable: false, ...base });
    case 'ready': {
      const context = calculation.context;
      if (context && context.onDate === expected.onDate && context.snapshotId === expected.snapshotId) {
        return Object.freeze({ kind: 'ready', message: '统计结果与当前日期、快照一致。', retryable: false, ...base, showsOldResult: false });
      }
      const chosen = context ? `${context.onDate} / 快照 ${context.snapshotId}` : '未知上下文';
      return Object.freeze({
        kind: 'stale',
        message: `上次重算对应 ${chosen}，与当前选择（${expected.onDate} / 快照 ${expected.snapshotId}）不一致；请重算。`,
        retryable: true,
        ...base,
      });
    }
    default:
      return Object.freeze({ kind: 'failed', message: '重算状态未知，可重试。', retryable: true, ...base });
  }
}

export function canRecalculate(view: RecalculationView): boolean {
  return view.retryable && view.kind !== 'running';
}

export class CancelledFailure extends Error {
  code = 'E_ABORT';
  constructor(message = '操作已取消') {
    super(message);
    this.name = 'CancelledFailure';
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof CancelledFailure;
}

export function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal && signal.aborted) throw new CancelledFailure();
}

/**
 * 执行可取消的异步工作：中止后立即以 E_ABORT 拒绝，晚到的结果/错误被丢弃（不再抛未处理拒绝）。
 * work 应把收到的 signal 继续传给 fetch / 端口调用。
 */
export function runCancellable<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CancelledFailure());
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const pending = Promise.resolve().then(() => work(controller.signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    controller.signal.addEventListener('abort', () => {
      cleanup();
      reject(new CancelledFailure());
    }, { once: true });
    pending.then((value) => {
      if (controller.signal.aborted) return;
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      if (controller.signal.aborted) return;
      cleanup();
      reject(error);
    });
  });
}
