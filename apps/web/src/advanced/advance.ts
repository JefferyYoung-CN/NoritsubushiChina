/**
 * 进阶记录的保存与派生汇总（P5 S7；AC-A02 两层完乘 + 总体并集、AC-A04 删除、AC-A05 不可直接编辑）。
 *
 * 边界：
 * - 保存计划只产出“已通过应用层 decodeRecord 校验的完整记录”；本切片不写存储，
 *   由 S8 交给会话层真正落库（当前 records.add 只接受单个 DateView，多段链条需要新的写入路径）。
 * - 总体完乘=基础∪进阶（按物理区间去重，取最早完成日期）；本模块校验这个不变量，
 *   不自行重算——计算仍归 completion.calculateCompletion，避免两份统计口径。
 * - pending 五类原因整条保留、不计入任何计数；未知原因如实带码显示，不吞错。
 * - 日期/径路字段在领域层就拒绝修改（E_FIELDS），不是只在界面上藏起来。
 */
import { calculateCompletion } from '../../../../packages/application/completion.mjs';
import { decodeRecord } from '../../../../packages/application/records.mjs';
import { PENDING_REASONS } from '../../../../packages/application/topology-mapping.mjs';
import type { ChainDraft, Leg } from './chain';
import { repeatedSectionConflict } from './sameDirection';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import type { PendingReason } from '../../../../packages/application/topology-mapping.mjs';

export type AdvanceErrorCode = 'E_DATE' | 'E_PATH' | 'E_MULTIPATH' | 'E_REFERENCE' | 'E_FIELDS' | 'E_CALCULATION' | 'E_SCHEMA';

export class AdvanceFailure extends Error {
  code: AdvanceErrorCode;
  constructor(code: AdvanceErrorCode, message: string) {
    super(message);
    this.name = 'AdvanceFailure';
    this.code = code;
  }
}

export const IMMUTABLE_FIELDS = Object.freeze([
  'occurredOn', 'fromStationId', 'toStationId', 'serviceLineIds', 'sectionIds', 'networkSnapshotId',
]);
export const EDITABLE_FIELDS = Object.freeze(['note', 'vehicle']);
export const IMMUTABLE_MESSAGE = '日期与径路不可直接编辑；如需改变，请删除该记录后按新径路重新录入，或在该日期重新统计。';

const PENDING_TEXT: Readonly<Record<PendingReason, string>> = Object.freeze({
  'snapshot-mapping-required': '记录来自其他快照，需要按当前快照复核映射；整条保留为待处理，不计入统计。',
  'through-service-mapping-required': '这条记录可能是旧格式的换乘链（一条记录含两次乘车）。本版本不再支持在一条记录内表达换乘，建议删除后按两次乘车分别录入；在此之前整条保留为待处理，不计入统计。',
  'path-mapping-required': '记录径路与当前快照的区间序列不一致；整条保留为待处理，不计入统计。',
  'service-alignment-required': '基础录入的起终点不属于同一趟车，可能需要中途换乘；整条保留为待处理，不计入统计，建议删除后分两次录入。',
  'topology-mapping-required': '记录区间在统计日期已变更或停用，需要拓扑映射复核；整条保留为待处理，不计入统计。',
});

/** 五类待处理原因的人类文案；计算层可能透出边界码，按“未分类”如实显示而不丢弃。 */
export function pendingReasonText(reason: string): string {
  if ((PENDING_REASONS as readonly string[]).includes(reason)) return PENDING_TEXT[reason as PendingReason];
  return `该记录需要人工映射复核（${reason}）；整条保留为待处理，不计入统计。`;
}

export interface AdvancedSaveCommand {
  readonly id: string;
  readonly note?: string;
  readonly vehicle?: string;
}

export interface AdvancedRecord {
  readonly id: string;
  readonly occurredOn: string;
  readonly networkSnapshotId: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly serviceLineIds: readonly string[];
  readonly sectionIds: readonly string[];
  readonly note: string;
  readonly vehicle: string;
}

export interface AdvancedSave {
  readonly record: AdvancedRecord;
  readonly serviceLineIds: readonly string[];
  readonly sectionIds: readonly string[];
  readonly lengthMetres: number | null;
}

function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** 把已链好的段序列变成一条可落库的完整记录；失败时给出领域码与人类文案。 */
export function buildAdvancedSave(
  network: TransitNetwork,
  chain: ChainDraft,
  command: AdvancedSaveCommand,
): AdvancedSave {
  const last = chain.legs[chain.legs.length - 1];
  if (!last) throw new AdvanceFailure('E_PATH', '还没有任何区段，不能保存进阶记录');
  for (let index = 1; index < chain.legs.length; index += 1) {
    const previous = chain.legs[index - 1] as (typeof chain.legs)[number];
    const current = chain.legs[index] as (typeof chain.legs)[number];
    if (previous.toStationId !== current.fromStationId) {
      throw new AdvanceFailure('E_PATH', '段与段之间不连续，不能保存');
    }
  }
  // 重复区间只允许同一条简单环线服务的同向续圈；折返必须另开一条记录。
  for (let index = 0; index < chain.legs.length; index += 1) {
    const conflict = repeatedSectionConflict(chain.legs.slice(0, index), chain.legs[index] as Leg);
    if (conflict) throw new AdvanceFailure('E_PATH', conflict);
  }
  const sectionIds = chain.legs.flatMap((leg) => leg.sectionIds);
  const serviceLineIds: string[] = [];
  for (const leg of chain.legs) {
    if (serviceLineIds[serviceLineIds.length - 1] !== leg.serviceLineId) serviceLineIds.push(leg.serviceLineId);
  }
  let lengthMetres: number | null = 0;
  for (const leg of chain.legs) {
    if (leg.lengthMetres === null) lengthMetres = null;
    else if (lengthMetres !== null) lengthMetres += leg.lengthMetres;
  }
  let record: AdvancedRecord;
  try {
    // 进阶记录的结构约束按 advanced 层判定（允许同站起终点与重复区间），
    // 语义仍由日期视图按已存有序区间重放核验。
    record = decodeRecord({
      id: command.id,
      occurredOn: chain.onDate,
      networkSnapshotId: network.snapshotId,
      fromStationId: chain.originStationId,
      toStationId: last.toStationId,
      serviceLineIds,
      sectionIds,
      note: command.note ?? '',
      vehicle: command.vehicle ?? '',
    }, 'record', 'advanced') as AdvancedRecord;
  } catch (error) {
    const code = codeOf(error);
    if (code === 'E_DATE' || code === 'E_PATH' || code === 'E_REFERENCE') {
      throw new AdvanceFailure(code, error instanceof Error ? error.message : '记录未通过校验');
    }
    throw new AdvanceFailure('E_SCHEMA', `记录未通过应用层校验：${error instanceof Error ? error.message : String(error)}`);
  }
  return Object.freeze({
    record: Object.freeze(record),
    serviceLineIds: Object.freeze(serviceLineIds),
    sectionIds: Object.freeze(sectionIds),
    lengthMetres,
  });
}

/** 只接受备注/车次；任何日期或径路字段都会被领域层拒绝。 */
export function metadataFromInput(input: Readonly<Record<string, unknown>>): { readonly note?: string; readonly vehicle?: string } {
  const extra = Object.keys(input).filter((key) => !(EDITABLE_FIELDS as readonly string[]).includes(key));
  if (extra.length > 0) {
    throw new AdvanceFailure('E_FIELDS', `${IMMUTABLE_MESSAGE}（不接受字段：${extra.join('、')}）`);
  }
  const result: { note?: string; vehicle?: string } = {};
  for (const key of EDITABLE_FIELDS as readonly ('note' | 'vehicle')[]) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new AdvanceFailure('E_FIELDS', `${key} 必须是文本`);
    result[key] = value;
  }
  return Object.freeze(result);
}

export interface CompletionRow {
  readonly sectionId: string;
  readonly firstCompletedOn: string;
}

export interface CompletionResult {
  readonly basic: readonly CompletionRow[];
  readonly advanced: readonly CompletionRow[];
  readonly overall: readonly CompletionRow[];
  readonly pending: readonly { readonly recordId: string; readonly layer: 'basic' | 'advanced'; readonly reason: string }[];
  readonly statistics: unknown;
}

export interface AdvancePending {
  readonly recordId: string;
  readonly layer: 'basic' | 'advanced';
  readonly reason: string;
  readonly message: string;
}

export interface AdvanceSummary {
  readonly onDate: string;
  readonly basic: readonly CompletionRow[];
  readonly advanced: readonly CompletionRow[];
  readonly overall: readonly CompletionRow[];
  readonly counts: {
    readonly basic: number;
    readonly advanced: number;
    readonly overall: number;
    readonly overlap: number;
    readonly pending: number;
  };
  readonly union: {
    readonly basicSectionIds: readonly string[];
    readonly advancedSectionIds: readonly string[];
    readonly overlapSectionIds: readonly string[];
  };
  readonly pending: readonly AdvancePending[];
  readonly statistics: unknown;
}

/**
 * 读取既有派生结果并校验“总体=两层并集”的不变量。
 * pending 项只带原因与文案，不进入 basic/advanced/overall。
 */
export function summarizeAdvance(facts: unknown, network: TransitNetwork, onDate: string): AdvanceSummary {
  const result = calculateCompletion(facts, network, onDate) as CompletionResult;
  const basicIds = result.basic.map((row) => row.sectionId);
  const advancedIds = result.advanced.map((row) => row.sectionId);
  const advancedSet = new Set(advancedIds);
  const union = new Set([...basicIds, ...advancedIds]);
  const overallIds = result.overall.map((row) => row.sectionId);
  const satisfied = overallIds.length === union.size && overallIds.every((id) => union.has(id));
  if (!satisfied) {
    throw new AdvanceFailure('E_CALCULATION', '总体完乘结果不是基础与进阶的并集，拒绝展示不一致的统计');
  }
  const overlapSectionIds = basicIds.filter((id) => advancedSet.has(id));
  const pending = result.pending.map((row) => Object.freeze({
    recordId: row.recordId,
    layer: row.layer,
    reason: row.reason,
    message: pendingReasonText(row.reason),
  }));
  return Object.freeze({
    onDate,
    basic: Object.freeze(result.basic),
    advanced: Object.freeze(result.advanced),
    overall: Object.freeze(result.overall),
    counts: Object.freeze({
      basic: basicIds.length,
      advanced: advancedIds.length,
      overall: overallIds.length,
      overlap: overlapSectionIds.length,
      pending: pending.length,
    }),
    union: Object.freeze({
      basicSectionIds: Object.freeze(basicIds),
      advancedSectionIds: Object.freeze(advancedIds),
      overlapSectionIds: Object.freeze(overlapSectionIds),
    }),
    pending: Object.freeze(pending),
    statistics: result.statistics,
  });
}

export function describeAdvanceCounts(summary: AdvanceSummary): string {
  return `基础 ${summary.counts.basic} 个区间 · 进阶 ${summary.counts.advanced} 个区间 · 总体 ${summary.counts.overall} 个区间`
    + `（并集，同区间只计一次，重叠 ${summary.counts.overlap}）· 待处理 ${summary.counts.pending} 条（不计入统计）`;
}

export interface FactsInput {
  readonly basic: readonly unknown[];
  readonly advanced: readonly unknown[];
}

function recordIdOf(row: unknown): string | null {
  if (typeof row !== 'object' || row === null || !('id' in row)) return null;
  const id = (row as { id: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/** 删除一条记录后的原始事实：另一层原样保留，重算由调用方显式触发。 */
export function withoutRecord(facts: FactsInput, layer: 'basic' | 'advanced', recordId: string): FactsInput {
  const rows = facts[layer];
  const next = rows.filter((row) => recordIdOf(row) !== recordId);
  if (next.length === rows.length) throw new AdvanceFailure('E_REFERENCE', `未找到记录：${recordId}`);
  return Object.freeze({
    basic: layer === 'basic' ? Object.freeze(next) : facts.basic,
    advanced: layer === 'advanced' ? Object.freeze(next) : facts.advanced,
  });
}
