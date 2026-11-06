/**
 * 线路图用的完乘三态（票 04）：只解释工作区快照里的 `derived` / `calculation`，不触发计算。
 *
 * - ready：结果就是「当前日期 + 当前快照」算出来的，可以给区间上色；
 * - loading：正在重算（或工作区正在打开），只画中性线并说明；
 * - unavailable：没有当前日期的成算结果，只画中性线并说明，绝不拿旧结果上色。
 *
 * 这里不看 `describeCalculation` 的放宽分支：「calculation 为空 + 有 derived」在它那里算
 * ready，对图是危险的——我们不知道那份结果属于哪个日期。因此上下文必须逐项核对：
 * `calculation.status === 'ready'` 且 context 的 onDate 与 snapshotId 都等于当前期望值。
 *
 * 派生只有 `completion.mjs` 一份（经 workspace.calculate 的 createMappedCompute 注入），
 * 这里不重算、不猜「未乘坐」：只有 ready 才给出已乘坐区间，其余一律空集合。
 */
import type { CalculationState } from '../stats/calculation';
import type { CompletionResult } from './completion';

export type RouteCompletionKind = 'ready' | 'loading' | 'unavailable';

export interface RouteCompletion {
  readonly kind: RouteCompletionKind;
  /** 图上方的一行说明；ready 时为空串，不渲染。 */
  readonly message: string;
  /** 总体完乘并集的物理区间 id；只有 ready 时非空。 */
  readonly completedSectionIds: readonly string[];
}

export interface RouteCompletionInput {
  readonly derived: CompletionResult | null;
  readonly calculation: CalculationState | null;
  /** 页面当前期望的业务日期与快照；结果对不上就不上色。 */
  readonly expected: { readonly onDate: string; readonly snapshotId: string };
  /** 应用级忙（保存、重算、导入期间）；避免把旧结果当新结果画出来。 */
  readonly busy: boolean;
  readonly phase: 'idle' | 'opening' | 'ready' | 'error';
}

const LOADING_MESSAGE = '正在重算完乘统计，线路图暂按中性线显示；完成后自动恢复着色。';
const UNAVAILABLE_MESSAGE = '完乘数据暂不可用，线路图按中性线显示；这不代表「未乘坐」。';

/** 没有完乘数据时的默认值；选择器与图容器在未注入时用它，不各写一份文案。 */
export const UNAVAILABLE_COMPLETION: RouteCompletion = Object.freeze({
  kind: 'unavailable',
  message: UNAVAILABLE_MESSAGE,
  completedSectionIds: Object.freeze([]),
});

function unavailable(): RouteCompletion {
  return { kind: 'unavailable', message: UNAVAILABLE_MESSAGE, completedSectionIds: [] };
}

function loading(): RouteCompletion {
  return { kind: 'loading', message: LOADING_MESSAGE, completedSectionIds: [] };
}

/** 结果必须属于当前页面正在看的日期与快照；缺任何一项都视为「日期未知的旧结果」。 */
function matchesExpected(calculation: CalculationState, expected: RouteCompletionInput['expected']): boolean {
  const context = calculation.context;
  return context !== null && context.onDate === expected.onDate && context.snapshotId === expected.snapshotId;
}

export function describeRouteCompletion(input: RouteCompletionInput): RouteCompletion {
  if (input.phase === 'error') return unavailable();
  if (input.phase === 'opening' || input.busy) return loading();
  const calculation = input.calculation;
  // 重算中优先于「有没有结果」：此刻旧结果正在被替换，不能上色。
  if (calculation?.status === 'running') return loading();
  // 只有当前日期与快照的成算结果才放行；calculation 缺失、上下文不符都按不可用处理。
  if (input.derived && calculation?.status === 'ready' && matchesExpected(calculation, input.expected)) {
    return { kind: 'ready', message: '', completedSectionIds: input.derived.overall.map(row => row.sectionId) };
  }
  return unavailable();
}
