/**
 * 集成层工作区：用真实 `createIdbBackend` 打开端口，并把拓扑映射注入重算链路。
 *
 * 为什么不直接用 `records/session.ts`：它的 `calculate()` 固定调用
 * `recalculate(port, network, onDate)`（默认 compute = calculateCompletion），没有注入点；
 * 而它是正在评审的既有模块，S8 不改它。这里按同一套 application 端口 API 组合出会话，
 * 只多一件事：重算时传入 `createMappedCompute()`。运行路径不得回落到 fake-storage。
 *
 * 状态形状与 SessionState 对齐（phase/message/errorCode/retryable/snapshot），便于 App
 * 用同一套加载、错误、重试、取消渲染。
 */
import { encodeBackup, finishImport, prepareImport } from '../../../../packages/application/backup.mjs';
import { recalculate } from '../../../../packages/application/completion.mjs';
import { createIdbBackend } from '../../../../packages/application/idb-storage.mjs';
import { createRecordApplication } from '../../../../packages/application/records.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import type { BasicSavePlan, RecordMetadata } from '../../../../packages/application/records.mjs';
import type { RecordSummaryInput } from '../records/record-commands';
import type { LastSave } from '../records/save-plan';
import { createMappedCompute, EMPTY_REVIEWED } from './completion';
import type { CompletionResult } from './completion';
import type { AdvancedRecordWrite } from './advanced-save';

/** 最近一次失败对应的用户操作；文案与重试入口据此区分，而不是一律按「保存」说话。 */
export type WorkspaceOperation =
  | 'open' | 'save-basic' | 'save-advanced' | 'remove' | 'edit' | 'calculate' | 'import';

/**
 * 失败快照的形状。注意不要叫 `WorkspaceFailure`：本文件下方已有一个同名的错误类，
 * 接口与类同名会被 TypeScript 合并，凭空多出 `name` 且让 `code` 变只读（实测 7 个类型错误）。
 */
export interface WorkspaceFailureInfo {
  readonly operation: WorkspaceOperation;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * E_STORAGE 这句文案原本只按「保存记录」写，重算统计写入失败时也照念「记录未保存」（P6 实测）。
 * 按操作给出稳定中文结果，用户才能对上自己刚才做的事。
 */
const STORAGE_OUTCOME: Readonly<Record<WorkspaceOperation, string>> = Object.freeze({
  open: '无法打开本地存储',
  'save-basic': '记录未保存',
  'save-advanced': '记录未保存',
  remove: '记录未删除',
  edit: '修改未保存',
  calculate: '统计结果未更新',
  import: '导入未完成',
});

/**
 * 存储层把 QuotaExceededError 包成 BoundaryError('E_STORAGE') 并拼上原始英文 cause 文案，
 * 直接透传会把 `IndexedDB transaction failed: The quota has been exceeded.` 显示给用户（P5 实测）。
 * 因此按错误码给出稳定的中文文案；未识别的错误才回落到原始 message/兜底文案。
 */
export function failureMessage(code: string | undefined, error: unknown, fallback: string,
  operation: WorkspaceOperation = 'save-basic'): string {
  switch (code) {
    case 'E_STORAGE':
      return operation === 'open'
        ? '无法打开本地存储；请检查浏览器是否允许本页使用 IndexedDB 后重试。'
        : `本地存储写入失败，${STORAGE_OUTCOME[operation]}；请检查浏览器存储空间后重试。`;
    case 'E_ABORT':
      // 重算的 E_ABORT 来自输入变化（代数围栏），不是用户取消，笼统说「操作已取消」会误导。
      return operation === 'calculate'
        ? '统计输入已变化，统计结果未更新；请重新计算。'
        : '操作已取消，未写入任何数据。';
    case 'E_CONFLICT': return '数据已被其他写入修改，本次操作未生效；请刷新后重试。';
    case 'E_DUPLICATE': return '记录编号重复，本次操作未生效；请重试。';
    case 'E_REFERENCE': return '引用的数据已不存在，本次操作未生效；请刷新后重试。';
    case 'E_FORMAT': return '数据格式不合法，本次操作未生效。';
    default: return error instanceof Error && error.message.length > 0 ? error.message : fallback;
  }
}

export type WorkspacePhase = 'idle' | 'opening' | 'ready' | 'error';

export interface StoredCalculation {
  readonly status: 'pending' | 'running' | 'ready' | 'failed';
  readonly generation: number;
  readonly context: { readonly onDate: string; readonly snapshotId: string; readonly inputRevision?: number } | null;
  readonly error: string | null;
}

export interface WorkspaceSnapshot {
  readonly revision: number;
  readonly facts: { readonly basic: readonly RecordSummaryInput[]; readonly advanced: readonly RecordSummaryInput[] };
  readonly derived: CompletionResult | null;
  readonly calculation: StoredCalculation | null;
}

export interface WorkspaceState {
  readonly phase: WorkspacePhase;
  readonly message: string;
  readonly errorCode: string | null;
  readonly retryable: boolean;
  readonly snapshot: WorkspaceSnapshot | null;
  /** 最近一次基础保存实际写入了什么（决策 #42）；失败或其他操作后为 `null`。 */
  readonly lastSave?: LastSave | null;
  /** 最近一次失败的操作来源；界面据此选文案与重试入口，而不是猜「一定是在保存」。 */
  readonly failure?: WorkspaceFailureInfo | null;
}

export interface WorkspaceOptions {
  readonly indexedDB?: IDBFactory;
  readonly tenantId?: string;
  readonly profileId?: string;
  readonly now?: () => string;
  readonly reviewedFor?: (network: TransitNetwork) => import('./completion').ReviewedMapping | undefined;
}

export class WorkspaceFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkspaceFailure';
    this.code = code;
  }
}

export interface Workspace {
  getState(): WorkspaceState;
  /**
   * 存储端口是否已打开。与「上一次操作是否成功」无关：失败同样会写到 phase/error 上，
   * 若界面拿 phase 判断「要不要重新打开」，切页就会重开端口并把失败横幅与重试入口冲掉。
   */
  isOpen(): boolean;
  subscribe(listener: (state: WorkspaceState) => void): () => void;
  open(): Promise<WorkspaceState>;
  retry(): Promise<WorkspaceState>;
  addRecord(view: unknown, command: { id: string; layer: 'basic' | 'advanced'; note?: string; vehicle?: string }): Promise<WorkspaceState>;
  writeAdvanced(record: AdvancedRecordWrite): Promise<WorkspaceState>;
  removeRecord(layer: 'basic' | 'advanced', id: string): Promise<WorkspaceState>;
  editMetadata(layer: 'basic' | 'advanced', id: string, patch: RecordMetadata): Promise<WorkspaceState>;
  calculate(network: TransitNetwork, onDate: string): Promise<WorkspaceState>;
  exportBackup(exportedOn: string): Promise<{ text: string; filename: string }>;
  previewImport(text: string): Promise<unknown>;
  finishImport(preview: unknown, confirmed: boolean): Promise<WorkspaceState>;
  dispose(): void;
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'E_UNKNOWN';
}

export const DEFAULT_SCOPE = Object.freeze({ tenantId: 'local', profileId: 'primary' });

/**
 * 把领域返回的保存计划映射成界面回执（决策 #42）。
 *
 * 计划里的 runs 已按写入顺序带真实记录 id；这里只做边界转换，避免把领域对象直接
 * 挂到视图状态上（界面只依赖展示所需字段）。
 */
export function toLastSave(plan: BasicSavePlan): LastSave {
  return {
    total: plan.total,
    covered: plan.covered,
    runs: plan.runs.map(run => ({
      id: run.id,
      fromStationId: run.fromStationId,
      toStationId: run.toStationId,
      sectionIds: [...run.sectionIds],
    })),
  };
}

export function createWorkspace(options: WorkspaceOptions = {}): Workspace {
  const tenantId = options.tenantId ?? DEFAULT_SCOPE.tenantId;
  const profileId = options.profileId ?? DEFAULT_SCOPE.profileId;
  const listeners = new Set<(state: WorkspaceState) => void>();
  let state: WorkspaceState = { phase: 'idle', message: '', errorCode: null, retryable: false, snapshot: null, lastSave: null, failure: null };
  let backend: ReturnType<typeof createIdbBackend> | null = null;
  let port: Awaited<ReturnType<ReturnType<typeof createIdbBackend>['open']>> | null = null;
  let records: ReturnType<typeof createRecordApplication> | null = null;
  let opening: Promise<WorkspaceState> | null = null;

  function emit(next: WorkspaceState): WorkspaceState {
    state = next;
    for (const listener of listeners) listener(next);
    return next;
  }

  function fail(error: unknown, fallback: string, operation: WorkspaceOperation): WorkspaceState {
    const code = codeOf(error);
    const retryable = code !== 'E_PATH';
    const message = failureMessage(code, error, fallback, operation);
    return emit({ phase: 'error', message, errorCode: code, retryable,
      snapshot: snapshotOf() ?? state.snapshot, lastSave: null,
      failure: { operation, code, message, retryable } });
  }

  function snapshotOf(): WorkspaceSnapshot | null {
    if (!port) return null;
    const current = port.read() as unknown as {
      revision: number;
      facts: WorkspaceSnapshot['facts'];
      derived: CompletionResult | null;
      calculation: StoredCalculation | null;
    };
    return {
      revision: current.revision,
      facts: current.facts,
      derived: current.derived ?? null,
      calculation: current.calculation ?? null,
    };
  }

  function ready(lastSave: LastSave | null = null): WorkspaceState {
    if (!port) return state;
    return emit({ phase: 'ready', message: '', errorCode: null, retryable: false, snapshot: snapshotOf(), lastSave, failure: null });
  }

  function requirePort(): NonNullable<typeof port> {
    if (!port || !records) throw new WorkspaceFailure('E_STORAGE', '本地工作区尚未打开');
    return port;
  }

  async function open(): Promise<WorkspaceState> {
    if (state.phase === 'ready' && port) return state;
    if (opening) return opening;
    emit({ phase: 'opening', message: '', errorCode: null, retryable: false, snapshot: state.snapshot, lastSave: null, failure: null });
    opening = (async () => {
      try {
        backend = backend ?? createIdbBackend({ indexedDB: options.indexedDB });
        port = await backend.open({ tenantId, profileId });
        records = createRecordApplication(port);
        return ready();
      } catch (error) {
        return fail(error, '无法打开本地存储，请检查浏览器是否允许 IndexedDB。', 'open');
      } finally {
        opening = null;
      }
    })();
    return opening;
  }

  return {
    getState: () => state,
    // 端口与记录应用同时就位才算打开：open() 失败时 port 保持 null，下一次进入视图才会重试。
    isOpen: () => port !== null && records !== null,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    open,
    async retry() {
      backend = null;
      port = null;
      records = null;
      state = { ...state, phase: 'idle', lastSave: null, failure: null };
      return open();
    },
    async addRecord(view, command) {
      try {
        const outcome = await records!.add(view, command);
        // 只有基础录入会按区间扣除拆分；进阶记录走 addAdvanced，不产生拆分回执。
        return ready(command.layer === 'basic' ? toLastSave(outcome.plan) : null);
      } catch (error) {
        return fail(error, '保存记录失败', 'save-basic');
      }
    },
    async writeAdvanced(record) {
      try {
        await records!.addAdvanced(record);
        return ready();
      } catch (error) {
        return fail(error, '保存进阶记录失败', 'save-advanced');
      }
    },
    async removeRecord(layer, id) {
      try {
        await records!.remove(layer, id);
        return ready();
      } catch (error) {
        return fail(error, '删除记录失败', 'remove');
      }
    },
    async calculate(network, onDate) {
      try {
        // 唯一注入点：mappedFacts/pending 由 topology-mapping 产出，completion 的统计 API 复用。
        const result = await recalculate(requirePort(), network, onDate, createMappedCompute(options.reviewedFor?.(network) ?? EMPTY_REVIEWED));
        if (result.status !== 'published') throw new WorkspaceFailure('E_ABORT', '统计输入已变化，请重新计算');
        return ready();
      } catch (error) {
        return fail(error, '统计重算失败', 'calculate');
      }
    },
    async editMetadata(layer, id, patch) {
      try {
        requirePort();
        await records!.editMetadata(layer, id, patch);
        return ready();
      } catch (error) { return fail(error, '修改备注或车辆失败', 'edit'); }
    },
    async exportBackup(exportedOn) {
      const current = requirePort();
      const text = await encodeBackup(current.read().facts, exportedOn);
      return { text, filename: `noritsubushi-backup-${exportedOn}.json` };
    },
    async previewImport(text) {
      return prepareImport(requirePort(), text);
    },
    async finishImport(preview, confirmed) {
      try {
        const result = await finishImport(requirePort(), preview, confirmed);
        if (result.status === 'cancelled') {
          return emit({ ...ready(), message: '已取消导入，现有记录未改变。', snapshot: state.snapshot });
        }
        return ready();
      } catch (error) {
        return fail(error, '导入失败', 'import');
      }
    },
    dispose() {
      listeners.clear();
      port = null;
      records = null;
      backend = null;
    },
  };
}
