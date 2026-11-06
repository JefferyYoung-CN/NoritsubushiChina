import type { DateView } from './date-view.mjs';
import type { StoragePort, StorageState } from './idb-storage.mjs';
export type RecordLayer = 'basic' | 'advanced';
export interface VehicleDetails {
  readonly model: string;
  readonly number: string;
  readonly formation: string;
}
export interface RecordMetadata { readonly note?: string; readonly vehicle?: string; readonly vehicleDetails?: VehicleDetails }
export interface UserRecord {
  readonly vehicleDetails?: VehicleDetails;
  readonly physicalLineId?: string;
  readonly id: string; readonly occurredOn: string; readonly networkSnapshotId: string;
  readonly fromStationId: string; readonly toStationId: string;
  readonly serviceLineIds: readonly string[]; readonly sectionIds: readonly string[];
  readonly note: string; readonly vehicle: string;
}
export interface RecordFacts { readonly basic: readonly UserRecord[]; readonly advanced: readonly UserRecord[] }
/** 待写入的一段基础区间：切片两端站与连续区间身份。 */
export interface BasicSplitRun {
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly sectionIds: readonly string[];
}
/** `planBasicSplit` 的预览结果：只说明会写哪几段，不含新记录 id。 */
export interface BasicSplitPlan {
  /** 日期视图当日区间总数。 */
  readonly total: number;
  /** 其中已有基础记录覆盖的区间数，等于 total 减去各 run 的区间数之和。 */
  readonly covered: number;
  readonly runs: readonly BasicSplitRun[];
}
export interface BasicSaveRun extends BasicSplitRun { readonly id: string }
/** `add` 返回的保存计划：runs 带实际写入的记录 id，顺序与 facts 追加顺序一致。 */
export interface BasicSavePlan {
  readonly total: number;
  readonly covered: number;
  readonly runs: readonly BasicSaveRun[];
}
/**
 * `layer` 决定结构约束的宽严：进阶记录允许同站起终点与重复区间（语义由日期视图重放核对），
 * 基础记录仍要求物理线路且单条记录内区间不重复；缺省按严格的基础规则处理。
 */
export function decodeRecord(value: unknown, path?: string, layer?: RecordLayer | null): UserRecord;
/** 跨记录的基础区间重叠在读取时容忍；不重叠由 `createRecordApplication.add` 的扣除拆分保证。 */
export function decodeFacts(value: unknown): RecordFacts;
/** 按本档案已有基础记录扣除 view 的区间，只返回未记录的连续段；站链不自洽时抛 E_PATH。 */
export function planBasicSplit(view: DateView, basicRecords: readonly { readonly sectionIds?: readonly string[] }[]): BasicSplitPlan;
export function createRecordApplication(port: StoragePort): {
  read(): StorageState;
  add(view: unknown, command: { id: string; layer: RecordLayer; note?: string; vehicle?: string }):
    Promise<{ readonly state: StorageState; readonly plan: BasicSavePlan }>;
  addAdvanced(input: unknown): Promise<StorageState>;
  remove(layer: RecordLayer, id: string): Promise<StorageState>;
  editMetadata(layer: RecordLayer, id: string, patch: RecordMetadata): Promise<StorageState>;
};
