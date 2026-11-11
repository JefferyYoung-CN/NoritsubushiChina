/**
 * 进阶面板对会话层的视图契约。
 *
 * 这些类型只描述"面板要交出去什么"，不构成持久化模型：记录 id 与快照 id 由会话层在写入时
 * 分配，面板不持有也不猜测。`PendingItem` 与领域层 `AdvancePending` 同形，别名而非复制，
 * 避免两处字段漂移。
 */
import type { AdvancePending } from './advance';

export type PendingItem = AdvancePending;

/**
 * 保存请求的输入：整条链的日期、起讫站与完整区间序列，加上可选备注。
 * 不含 id 与 snapshotId —— 写入层（records.add）负责补全身份。
 */
export interface AdvancedRecordInput {
  readonly occurredOn: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly serviceLineIds: readonly string[];
  readonly sectionIds: readonly string[];
  readonly lengthMetres: number | null;
  readonly note: string;
  readonly vehicle: string;
}
