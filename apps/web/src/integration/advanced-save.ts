/**
 * 进阶（链式多段）记录的保存编排：会话层注入 id 与快照，端口写入后立即重算。
 *
 * 校验与派生都不在这里复制：`addAdvanced` 由 application 的 decodeRecord 把关，
 * 重算走 workspace 的 `createMappedCompute`（含 S8 的 mapRecordFacts 注入）。
 * 本模块只负责把界面提交的视图字段裁成事实字段、按顺序调用端口，并把每一步的
 * 失败翻译成可展示的结果——任何一步失败都不会被吞掉。
 */
import type { AdvancedRecordInput } from '../advanced/panelTypes';
import { newRecordId } from '../records/record-commands';

/** 事实层可写字段；`lengthMetres` 是界面展示值，不进入 facts。 */
export interface AdvancedRecordWrite {
  readonly id: string;
  readonly networkSnapshotId: string;
  readonly occurredOn: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly serviceLineIds: readonly string[];
  readonly sectionIds: readonly string[];
  readonly note: string;
  readonly vehicle: string;
}

/** 与 WorkspaceState 的结构子集对齐，测试可注入轻量替身。 */
export interface SaveState {
  readonly phase: string;
  readonly message: string;
  readonly errorCode: string | null;
  readonly retryable: boolean;
}

export interface AdvancedSaveDeps {
  addAdvancedRecord(record: AdvancedRecordWrite): Promise<SaveState>;
  recalculate(): Promise<SaveState>;
}

export interface AdvancedSaveResult {
  readonly recordId?: string;
  readonly ok: boolean;
  readonly saved: boolean;
  readonly recalculated: boolean;
  readonly message: string;
  readonly errorCode: string | null;
  readonly retryable: boolean;
}

const FAILURE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  E_CONFLICT: '记录已被其他窗口修改，请刷新后重试。',
  E_DUPLICATE: '记录编号已存在，请重试。',
  E_FORMAT: '进阶记录字段不符合事实格式，未保存。',
  E_PATH: '该日期没有可办客的完整径路，未保存。',
  E_STORAGE: '本地写入失败，进阶记录未保存，请重试。',
  E_REFERENCE: '记录不存在或已被删除，请刷新列表。',
});

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((row) => typeof row === 'string');
}

/** 面板事件是不可信输入：字段不全时不构造事实，直接拒绝。 */
export function isAdvancedRecordInput(value: unknown): value is AdvancedRecordInput {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.occurredOn === 'string'
    && typeof row.fromStationId === 'string'
    && typeof row.toStationId === 'string'
    && isStringArray(row.serviceLineIds)
    && isStringArray(row.sectionIds)
    && row.serviceLineIds.length > 0
    && row.sectionIds.length > 0
    && (row.lengthMetres === null || typeof row.lengthMetres === 'number')
    && typeof row.note === 'string'
    && typeof row.vehicle === 'string';
}

/** 裁掉视图字段，注入会话持有的 id 与当前快照。 */
export function advancedRecordWrite(
  input: AdvancedRecordInput,
  snapshotId: string,
  id: string = newRecordId(),
): AdvancedRecordWrite {
  return Object.freeze({
    id,
    networkSnapshotId: snapshotId,
    occurredOn: input.occurredOn,
    fromStationId: input.fromStationId,
    toStationId: input.toStationId,
    serviceLineIds: [...input.serviceLineIds],
    sectionIds: [...input.sectionIds],
    note: input.note,
    vehicle: input.vehicle,
  });
}

function failureOf(state: SaveState): AdvancedSaveResult {
  const code = state.errorCode ?? 'E_UNKNOWN';
  return {
    ok: false,
    saved: false,
    recalculated: false,
    errorCode: state.errorCode,
    retryable: state.retryable,
    message: FAILURE_MESSAGES[code] ?? `保存进阶记录失败${state.message ? `：${state.message}` : '，请重试'}。`,
  };
}

/** 保存链状态机：取消 → 写入 → 取消检查 → 重算；任一步失败都返回可见结果。 */
export async function runAdvancedSave(
  deps: AdvancedSaveDeps,
  payload: unknown,
  snapshotId: string,
  signal?: AbortSignal,
): Promise<AdvancedSaveResult> {
  if (signal?.aborted) {
    return { ok: false, saved: false, recalculated: false,
      message: '已取消，未保存进阶记录。', errorCode: 'E_ABORT', retryable: true };
  }
  if (!isAdvancedRecordInput(payload)) {
    return { ok: false, saved: false, recalculated: false,
      message: '进阶记录字段不完整，未保存。', errorCode: 'E_FORMAT', retryable: false };
  }
  const record = advancedRecordWrite(payload, snapshotId);
  const written = await deps.addAdvancedRecord(record);
  if (written.phase !== 'ready') return failureOf(written);
  if (signal?.aborted) {
    return { recordId: record.id, ok: true, saved: true, recalculated: false,
      message: '进阶记录已保存，但取消发生在重算前；统计未刷新。', errorCode: 'E_ABORT', retryable: true };
  }
  const recalculated = await deps.recalculate();
  if (recalculated.phase !== 'ready') {
    return { recordId: record.id, ok: true, saved: true, recalculated: false,
      message: `进阶记录已保存；统计重算失败${recalculated.message ? `：${recalculated.message}` : ''}，可重试重算。`,
      errorCode: recalculated.errorCode, retryable: recalculated.retryable };
  }
  return { recordId: record.id, ok: true, saved: true, recalculated: true,
    message: '进阶记录已保存，统计已更新。', errorCode: null, retryable: false };
}
