/**
 * 会话级操作编排：统计重算（含自动补算）与基础保存（含失败后的原样重试）。
 *
 * 这些操作共享 busy、状态播报与「同一份输入只算一次」的去重规则；留在 App.vue 里会把
 * 协调组件撑成半个状态机。提取后 App 只负责面板接线，操作语义与文案判断集中在一处。
 *
 * 重算是异步且会写库的：切页、改日期、换数据源都可能在一次重算结束前产生新输入。
 * 这里用「会话代际 + 串行追赶」协调，而不是「忙就直接丢弃」：
 * - 同一份输入合并到在途任务，不重复计算；
 * - 输入变化时只保留最新一份排队，当前任务结束后接着算，页面保持忙碌直到队列排空；
 * - 只有仍对应当前输入、且发起代际未变的完成结果才允许播报并结束忙碌。
 * 写成 `if (busy) return` 会把保存后的必要重算和换快照后的补算一并挡掉。
 */
import { computed, ref, shallowRef } from 'vue';
import type { Ref, ShallowRef } from 'vue';
import type { DateView } from '../../../../packages/application/date-view.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import type { RecordLayer } from '../records/record-commands';
import type { LastSave } from '../records/save-plan';
import type { Workspace, WorkspaceState } from './workspace';

export type SaveCommand = { id: string; layer: RecordLayer; note?: string; vehicle?: string };
export interface PendingSave { readonly view: DateView; readonly command: SaveCommand }

export interface SessionActionsOptions {
  readonly workspace: () => Workspace | undefined;
  readonly network: () => TransitNetwork | null;
  readonly onDate: () => string;
  readonly workspaceOpen: () => boolean;
  readonly snapshotError: () => string;
  /** 当前可保存的乘车视图；没有选好起终点时为 null。 */
  readonly currentView: () => DateView | null;
  /** 打开/重开工作区入口由 App 提供，避免这里反向依赖视图协调。 */
  readonly retryWorkspace: () => void;
  readonly busy: Ref<boolean>;
  readonly status: Ref<string>;
  readonly session: ShallowRef<WorkspaceState>;
  readonly lastSave: Ref<LastSave | null>;
  readonly savedRecordId: Ref<string>;
}

/** 一次重算请求的不可变输入；协调只比较这些字段，不比较对象身份。 */
interface CalcRequest {
  readonly key: string;
  readonly snapshotId: string;
  readonly onDate: string;
  /** 发起时的会话代际；换数据源/卸载后旧任务的结果一律作废。 */
  readonly generation: number;
  readonly network: TransitNetwork;
}

const calcKey = (snapshotId: string, onDate: string): string => `${snapshotId}@${onDate}`;

export function useSessionActions(options: SessionActionsOptions) {
  const { busy, status, session } = options;
  const calculating = ref(false);
  /**
   * 保存失败时保留「刚才那次保存」的载荷：重试必须重新提交同一份输入，而不是让用户重填。
   * 只在该次保存成功或换数据源（App 调用 resetForReload）时丢弃；失败事务已回滚，沿用原编号安全。
   */
  const pendingSave = shallowRef<PendingSave | null>(null);
  /**
   * 失败说明与载荷同生命周期。工作区横幅只反映「最近一次操作」，之后一次成功的重算就会把
   * failure 清空；若重试入口跟着消失，待重试的载荷还在内存里却没有任何入口。
   */
  const saveFailure = shallowRef<{ message: string; retryable: boolean } | null>(null);
  /** 自动重算的去重键：同一输入只自动尝试一次，失败后交给显式重试。 */
  let autoAttemptKey = '';
  /** 会话代际：换数据源或卸载时 +1，让在途任务的结果与忙碌归属不再生效。 */
  let generation = 0;
  let active: CalcRequest | null = null;
  /** 追赶队列长度恒为 1：中间的输入已被最新输入取代，不必逐个补算。 */
  let queued: CalcRequest | null = null;
  let idleWaiters: Array<() => void> = [];
  /** 本编排自己拿起的「忙」：保存/删除等外部操作也写 busy，只有自己拿的才由自己放下。 */
  let ownsBusy = false;

  const failure = computed(() => session.value.failure ?? null);
  const failureAction = computed<{ label: string; run: () => void } | null>(() => {
    const current = failure.value;
    if (!current?.retryable) return null;
    switch (current.operation) {
      case 'open': return { label: '重新打开工作区', run: options.retryWorkspace };
      // 载荷在这里；没有载荷时不给按钮，避免点了没反应。
      case 'save-basic': return pendingSave.value ? { label: '重试保存', run: () => { void retrySave(); } } : null;
      case 'calculate': return { label: '重新计算', run: () => { void recalculate(); } };
      // 其余操作的草稿与重试入口在各自面板里，横幅只负责说明原因。
      default: return null;
    }
  });
  /** 工作区横幅不再提这次保存失败时，用载荷自己的说明补一条，保住「重试保存」入口。 */
  const unsavedNotice = computed<{ message: string; run: () => void } | null>(() => {
    if (!pendingSave.value || !saveFailure.value?.retryable) return null;
    if (failure.value?.operation === 'save-basic') return null;
    return { message: saveFailure.value.message, run: () => { void retrySave(); } };
  });

  function ownsIdle(): boolean {
    return !active && !queued;
  }

  function idle(): Promise<void> {
    if (ownsIdle()) return Promise.resolve();
    return new Promise<void>(resolve => { idleWaiters.push(resolve); });
  }

  function settle(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function holdBusy(): void {
    if (busy.value) return;
    busy.value = true;
    ownsBusy = true;
  }

  function releaseBusy(): void {
    if (!ownsBusy) return;
    busy.value = false;
    ownsBusy = false;
  }

  /**
   * 结果是否仍然算数：代际没变（没换数据源/没卸载）、没有更新的输入在排队、
   * 且当前页面输入就是它算的那份。否则只丢弃反馈，不解除忙碌、不播报成功。
   */
  function isCurrent(request: CalcRequest): boolean {
    if (request.generation !== generation || queued) return false;
    const current = options.network();
    return current?.snapshotId === request.snapshotId && options.onDate() === request.onDate;
  }

  function drain(): void {
    if (active) return;
    const request = queued;
    if (!request) { settle(); return; }
    queued = null;
    active = request;
    void execute(request);
  }

  async function execute(request: CalcRequest): Promise<void> {
    calculating.value = true;
    holdBusy();
    if (request.generation === generation) status.value = '正在重算统计…';
    try {
      const target = options.workspace();
      if (target) {
        const next = await target.calculate(request.network, request.onDate);
        if (isCurrent(request)) status.value = next.phase === 'ready' ? '统计已更新' : next.message;
      }
    } catch (error) {
      // 工作区自己会把失败转成状态；这里只兜住意外抛出，且同样只能由有效任务播报。
      if (isCurrent(request)) status.value = error instanceof Error && error.message ? error.message : '统计重算失败';
    } finally {
      active = null;
      if (queued) {
        // 还有更新的输入：保持 calculating 与忙，串行追赶，最后一个任务结束才放开页面。
        drain();
      } else {
        calculating.value = false;
        releaseBusy();
        settle();
      }
    }
  }

  /** 发起（或合并到）一份重算请求，等队列排空才返回，调用方拿到的结果对应当前输入。 */
  async function requestCalculation(network: TransitNetwork, onDate: string): Promise<void> {
    const key = calcKey(network.snapshotId, onDate);
    const same = (row: CalcRequest | null): boolean => row !== null && row.key === key && row.generation === generation;
    if (same(active) || same(queued)) return idle();
    queued = { key, snapshotId: network.snapshotId, onDate, generation, network };
    drain();
    return idle();
  }

  /**
   * 自动重算只针对「已经有发布结果、但结果对应的日期/快照已不是当前输入」的旧数字：
   * - 从未算过时统计页明确显示「尚未计算」，不替用户写库；
   * - pending/failed/running 已有明确标记与显式重试入口，不自动抢着重试。
   * 同一输入只自动尝试一次：失败后保持旧结果标记，等用户点「重新计算」，避免重算循环与无限重试。
   * 重算在途时不再直接放弃，而是排队追赶：否则换快照后的新输入永远算不到。
   */
  async function autoRecalculateIfStale(): Promise<void> {
    const current = options.network();
    const stored = session.value.snapshot?.calculation ?? null;
    if (!current || !options.workspaceOpen() || options.snapshotError()) return;
    if (!stored || stored.status !== 'ready') return;
    // 结果上下文缺失（不知道是哪天的旧数字）同样按旧结果处理，补算一次给它确定来源。
    if (stored.context?.onDate === options.onDate() && stored.context?.snapshotId === current.snapshotId) return;
    if (calcKey(current.snapshotId, options.onDate()) === autoAttemptKey) return;
    await recalculate();
  }

  async function recalculate(): Promise<void> {
    const current = options.network();
    if (!current || !options.workspaceOpen() || options.snapshotError()) return;
    // 显式与自动重算共用去重键：刚试过同一输入后（尤其失败时），视图切换不会马上再自动算一次。
    autoAttemptKey = calcKey(current.snapshotId, options.onDate());
    await requestCalculation(current, options.onDate());
  }

  async function addRecord(command: SaveCommand): Promise<void> {
    if (busy.value || options.snapshotError()) return;
    const view = options.currentView();
    if (!view) { status.value = '请先选择日期与起终点'; return; }
    // 先记住这次提交的完整输入：失败后「重试保存」原样重提，不依赖用户当时的选择还留在界面上。
    pendingSave.value = { view, command };
    await submitSave();
  }

  /** 重试的是「刚才那次保存」本身（同一份 view 与 command），不是重算统计。 */
  async function retrySave(): Promise<void> {
    await submitSave();
  }

  async function submitSave(): Promise<void> {
    const pending = pendingSave.value;
    if (!pending || busy.value || options.snapshotError()) return;
    busy.value = true;
    saveFailure.value = null;
    const next = await options.workspace()!.addRecord(pending.view, pending.command);
    if (next.phase === 'ready') {
      pendingSave.value = null;
      options.lastSave.value = next.lastSave ?? null;
      options.savedRecordId.value = pending.command.id;
      await recalculate();
      // 完全被已记录区间覆盖时没有新记录：状态播报不能仍说「记录已保存」。
      const headline = next.lastSave?.runs.length === 0 ? '本次区间此前已全部记录，未产生新记录' : '记录已保存';
      status.value = session.value.phase === 'ready' ? `${headline}，统计已更新` : `${headline}；${session.value.message}`;
    } else {
      // 失败时保留载荷与说明；重算成功会清掉工作区 failure，横幅由 unsavedNotice 接着负责。
      saveFailure.value = { message: next.message, retryable: next.retryable };
      status.value = next.message;
    }
    busy.value = false;
  }

  /** 换数据源时放弃上一次的待重试载荷与去重键，并让在途计算的结果作废。 */
  function resetForReload(): void {
    generation += 1;
    pendingSave.value = null;
    saveFailure.value = null;
    autoAttemptKey = '';
    queued = null;
    // 在途任务不能强清：它结束时会因代际不符而丢弃反馈，并按队列是否为空统一收尾忙碌。
    if (!active) { calculating.value = false; releaseBusy(); settle(); }
  }

  /** 重新打开工作区后允许同一输入再自动补算一次。 */
  function resetAutoAttempt(): void {
    autoAttemptKey = '';
  }

  /** 组件卸载：序号失效，在途任务的反馈与忙碌归属都不再生效，等待者立即结束。 */
  function invalidate(): void {
    generation += 1;
    queued = null;
    pendingSave.value = null;
    saveFailure.value = null;
    autoAttemptKey = '';
    calculating.value = false;
    releaseBusy();
    settle();
  }

  return { calculating, pendingSave, failure, failureAction, unsavedNotice,
    addRecord, retrySave, recalculate, autoRecalculateIfStale, resetForReload, resetAutoAttempt, invalidate };
}
