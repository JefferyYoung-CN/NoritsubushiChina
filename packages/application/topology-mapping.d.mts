import type { TransitNetwork } from './reader.mjs';

/** 五类待处理原因：不是错误码，不进入统计结果。 */
export type PendingReason =
  | 'snapshot-mapping-required'
  | 'through-service-mapping-required'
  | 'path-mapping-required'
  | 'topology-mapping-required'
  | 'service-alignment-required';

export const PENDING_REASONS: readonly PendingReason[];

/** 映射所需的记录事实字段子集；其余字段（note/vehicle）不参与映射。 */
export interface MappingFactRecord {
  readonly id: string;
  readonly occurredOn: string;
  readonly networkSnapshotId: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly serviceLineIds: readonly string[];
  readonly physicalLineId?: string;
  readonly sectionIds: readonly string[];
}

export interface MappingFacts {
  readonly basic: readonly MappingFactRecord[];
  readonly advanced: readonly MappingFactRecord[];
}

/** 已复核映射输入：缺省为空时，跨快照与多段直通事实一律保持待处理。 */
export interface ReviewedMapping {
  /** 允许投影到当前快照的旧快照身份。 */
  readonly snapshots?: readonly string[];
  /** 已在来源映射中复核的拆分站：旧身份 → 目标站集合。 */
  readonly stationSplits?: readonly Readonly<{
    retiredStationId: string;
    targetStationIds: readonly string[];
  }>[];
  /** 显式维护的直通线路对（无序），只来自人工维护数据，不从连通性推断。 */
  readonly throughServicePairs?: readonly (readonly [string, string])[];
}

export interface MapRecordFactsInput {
  readonly facts: MappingFacts;
  readonly network: TransitNetwork;
  /** 统计日期；occurredOn 晚于它的事实不参与本次映射。 */
  readonly onDate: string;
  readonly reviewed?: ReviewedMapping;
}

export interface MappedSection {
  /** 当前快照区间身份；合并区间为组内唯一目标区间。 */
  readonly sectionId: string;
  /** 该区间在本次映射后的完乘日期（合并区间取组内最晚日期）。 */
  readonly completedOn: string;
}

export interface MappedFact {
  readonly recordId: string;
  readonly layer: 'basic' | 'advanced';
  readonly occurredOn: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly sections: readonly MappedSection[];
}

export interface PendingFact {
  readonly recordId: string;
  readonly layer: 'basic' | 'advanced';
  readonly reason: PendingReason;
}

export interface MappedFacts {
  readonly mappedFacts: readonly MappedFact[];
  readonly pending: readonly PendingFact[];
}

export function mapRecordFacts(input: MapRecordFactsInput): MappedFacts;
