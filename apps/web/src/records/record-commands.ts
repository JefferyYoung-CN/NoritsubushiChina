/**
 * 记录命令的纯逻辑：草稿校验、命令构造与列表摘要。
 *
 * 真实业务校验仍由 `createRecordApplication(port).add` 执行（它要求
 * `buildDateView` 产出的可用径路）；这里只做提交前的可诊断检查，避免把
 * 无效草稿送进持久化层，也保证组件不复制领域规则。
 */
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import type { VehicleDetails } from '../../../../packages/application/records.mjs';

export type RecordLayer = 'basic' | 'advanced';

export interface RecordDraft {
  readonly layer: RecordLayer;
  readonly onDate: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly serviceLineId: string | null;
  readonly physicalLineId?: string;
  readonly note: string;
  readonly vehicle: string;
}

export interface RecordCommand {
  readonly id: string;
  readonly layer: RecordLayer;
  readonly note: string;
  readonly vehicle: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 提交前检查；返回空数组表示可以提交。 */
export function draftProblems(draft: RecordDraft): string[] {
  const problems: string[] = [];
  if (!DATE.test(draft.onDate)) problems.push('请选择有效日期（YYYY-MM-DD）。');
  if (!['basic', 'advanced'].includes(draft.layer)) problems.push('记录层次无效。');
  if (draft.fromStationId.trim().length === 0 || draft.toStationId.trim().length === 0) {
    problems.push('请选择起点和终点。');
  } else if (draft.fromStationId === draft.toStationId && !(draft.layer === 'basic' && draft.physicalLineId)) {
    problems.push('起点与终点必须不同。');
  }
  if (!draft.physicalLineId && (draft.serviceLineId === null || draft.serviceLineId.trim().length === 0)) {
    problems.push('请选择乘车线路。');
  }
  return problems;
}

/** 生成命令；id 由调用方提供，保证重试时幂等展示同一条记录。 */
export function commandFromDraft(draft: RecordDraft, id: string): RecordCommand {
  return {
    id,
    layer: draft.layer,
    note: draft.note.trim(),
    vehicle: draft.layer === 'basic' ? '' : draft.vehicle.trim(),
  };
}

/** 稳定记录 id：时间前缀便于人工排查，随机后缀避免同秒冲突。 */
export function newRecordId(now: Date = new Date(), random: () => number = Math.random): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = Math.floor(random() * 0xffffff).toString(16).padStart(6, '0');
  return `record-${stamp}-${suffix}`;
}

/** 记录列表展示模型；站名缺失时保留 id，避免伪造名称。 */
export interface RecordSummary {
  readonly vehicleDetails?: VehicleDetails;
  readonly id: string;
  readonly layer: RecordLayer;
  readonly onDate: string;
  readonly endpoints: string;
  readonly lineNames: readonly string[];
  readonly note: string;
  readonly vehicle: string;
}

export function summarizeRecords(
  facts: { readonly basic: readonly RecordSummaryInput[]; readonly advanced: readonly RecordSummaryInput[] },
  network: TransitNetwork,
): RecordSummary[] {
  const physicalNames = new Map(network.lines.map(line => [line.id, line.name]));
  const serviceNames = new Map(network.services.map(service => [service.id, service.name]));
  const nameOf = (id: string) => network.stations.find((station) => station.id === id)?.name ?? id;
  return (['basic', 'advanced'] as const).flatMap((layer) =>
    facts[layer].map((record) => ({
      id: record.id,
      layer,
      onDate: record.occurredOn,
      endpoints: `${nameOf(record.fromStationId)} → ${nameOf(record.toStationId)}`,
      lineNames: record.physicalLineId
        ? [physicalNames.get(record.physicalLineId) ?? record.physicalLineId]
        : (record.serviceLineIds ?? []).map(id => serviceNames.get(id) ?? id),
      note: record.note,
      vehicle: record.vehicle,
      ...(record.vehicleDetails ? { vehicleDetails: { ...record.vehicleDetails } } : {}),
    })),
  );
}

export interface RecordSummaryInput {
  readonly vehicleDetails?: VehicleDetails;
  readonly sectionIds?: readonly string[];
  readonly physicalLineId?: string;
  readonly id: string;
  readonly occurredOn: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly note: string;
  readonly vehicle: string;
  readonly serviceLineIds?: readonly string[];
}
