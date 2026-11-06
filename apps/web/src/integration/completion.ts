/**
 * 拓扑映射注入点（P5 收口 S8）。
 *
 * `computeCompletion` 只做三件事：校验统计上下文（日期下限与知识截止 → E_DATE/E_SNAPSHOT）、
 * 调用 `topology-mapping.mapRecordFacts` 把事实投影到统计快照拓扑、把 mappedFacts + pending
 * 交给 `completion.deriveCompletion`。累加、区间/车站排序、contributions 与统计口径全部由
 * completion.mjs 单一实现，这里不保留第二套。
 *
 * 为什么不能直接调用 calculateCompletion：它会用 buildDateView 重新推导径路并要求与记录
 * 原 sectionIds 完全一致，而合并/拆分后的映射结果已是当前区间身份与组内最晚完乘日期，
 * 再走一遍径路解析只会退化成 path-mapping-required（物理事实还可能是
 * service-alignment-required）。因此派生逻辑在 completion.mjs 里抽成
 * `deriveCompletion`，两个入口共用；calculateCompletion 自己的 resolve 校验保持不变。
 *
 * pending 语义不变：整条保留 recordId/layer/reason，不计入任何区间/车站集合，不抛 E_SNAPSHOT。
 *
 * reviewed 来自 prepare-web-assets 校验摘要后的批准映射，并仅用于对应目标快照。
 * 没有批准的直通关系时保持 pending，绝不从共享车站、邻接或连通性推断直通。
 * 未配置的快照使用 EMPTY_REVIEWED；同快照合并组与 1:1 替代不依赖 reviewed。
 */
import { deriveCompletion } from '../../../../packages/application/completion.mjs';
import { decodeFacts } from '../../../../packages/application/records.mjs';
import { mapRecordFacts, PENDING_REASONS } from '../../../../packages/application/topology-mapping.mjs';
import { day, requireValue } from '../../../../packages/application/validation.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';

export type PendingReason = (typeof PENDING_REASONS)[number];

export interface ReviewedMapping {
  readonly snapshots: readonly string[];
  readonly stationSplits: readonly { readonly retiredStationId: string; readonly targetStationIds: readonly string[] }[];
  readonly throughServicePairs: readonly (readonly [string, string])[];
}

/** 未配置已批准复核数据时的安全默认值。 */
export const EMPTY_REVIEWED: ReviewedMapping = Object.freeze({
  snapshots: Object.freeze([]),
  stationSplits: Object.freeze([]),
  throughServicePairs: Object.freeze([]),
});

export type { CompletionResult } from '../../../../packages/application/completion.mjs';
import type { CompletionResult } from '../../../../packages/application/completion.mjs';

/**
 * 用映射结果重算统计：映射成功的事实交给 completion.deriveCompletion，待处理事实整条保留。
 * 返回形状与 `calculateCompletion` 对齐，供统计面板与进阶面板消费。
 */
export function computeCompletion(
  input: unknown,
  network: TransitNetwork,
  onDate: string,
  reviewed: ReviewedMapping = EMPTY_REVIEWED,
): CompletionResult {
  const facts = decodeFacts(input);
  day(onDate, 'statistics.onDate', '1997-01-01');
  requireValue(onDate <= network.knowledgeThrough, 'E_SNAPSHOT', 'statistics.snapshot', 'No verified snapshot for statistics date');
  const mapping = mapRecordFacts({ facts, network, onDate, reviewed });
  return deriveCompletion(network, onDate, mapping.mappedFacts, mapping.pending) as CompletionResult;
}

/** 注入 `recalculate(port, network, onDate, compute)` 的第四个参数。 */
export function createMappedCompute(reviewed: ReviewedMapping = EMPTY_REVIEWED) {
  return (input: unknown, network: TransitNetwork, onDate: string): CompletionResult =>
    computeCompletion(input, network, onDate, reviewed);
}

/** pending 原因的中文说明；未知原因原样回显，便于诊断而不是吞掉。 */
export function pendingReasonLabel(reason: string): string {
  switch (reason) {
    case 'snapshot-mapping-required': return '需要跨快照映射复核';
    case 'through-service-mapping-required': return '需要直通线路关系复核';
    case 'path-mapping-required': return '径路与当前拓扑不一致';
    case 'service-alignment-required': return '须中途换乘或分两次录入（不属于同一趟车）';
    case 'topology-mapping-required': return '区间拓扑已变更（拆并/停运）';
    default: return reason;
  }
}
