/**
 * 进阶链式录入的纯领域逻辑（首段唯一径路、链式继续与回退）。
 *
 * 边界：
 * - 可乘径路按服务运行序（memberships.sequence 的严格顺序，见 reader.mjs 的序号约束）
 *   做单调邻接遍历：只允许序号递增或递减，相邻成员必须在当前站首尾相接。唯一性以运行序
 *   为准；date-view.buildDateView 提供区间明细与可用性。不挑最短路、不把“连通”当成可走。
 * - 直通只认调用方显式传入的运营线路对；缺省为空，即
 *   “没有维护关系就没有直通候选”。换乘不在本条链内：下车换乘另一条线路另开一条记录
 *   （2026-10-28 决策「一次乘车 = 一条记录」）。
 * - 纯函数：不读写存储、不碰 DOM、不改入参；返回值冻结。
 * - 站名取业务日期上的当前名称；同名站消歧由视图层 labels.ts 负责。
 */
import { buildDateView, mileage, sectionStatus } from '../../../../packages/application/date-view.mjs';
import { serviceCycle } from '../../../../packages/application/simple-cycle.mjs';
import { active, day } from '../../../../packages/application/validation.mjs';
import type { DateView } from '../../../../packages/application/date-view.mjs';
import type { RunDirection } from '../../../../packages/application/direction-plan.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { directionOptions } from './directionOptions';
import type { DirectionOption } from './directionOptions';
import { loopTarget } from './loopTarget';
import type { LoopTarget } from './loopTarget';
import { repeatedSectionConflict } from './sameDirection';
import { runWalks, serviceEdges } from './serviceWalk';

export type ChainErrorCode = 'E_DATE' | 'E_PATH' | 'E_MULTIPATH' | 'E_REFERENCE';

export interface StationRef {
  readonly stationId: string;
  readonly stationName: string;
}

export interface ServiceCandidate {
  readonly serviceLineId: string;
  readonly label: string;
  readonly operatorName: string;
  readonly lineNames: readonly string[];
}

export interface ServiceDirections {
  readonly fromStation: StationRef;
  readonly service: ServiceCandidate;
  /** 两个方向，正序在前、逆序在后；界面不预选。 */
  readonly options: readonly DirectionOption[];
}

export interface ReachableStation extends StationRef {
  readonly sectionIds: readonly string[];
  readonly lengthMetres: number | null;
  readonly routeAvailable: boolean;
}

export interface AmbiguousTarget extends StationRef {
  readonly reason: 'E_MULTIPATH';
  readonly detail: string;
}

export interface ServicePaths {
  readonly onDate: string;
  readonly fromStation: StationRef;
  readonly service: ServiceCandidate;
  /**
   * 本次解析实际使用的运行方向：只有简单环线上用户选定（或自直通沿用）时才有值，
   * 普通服务为 null。方向只是链与界面的临时状态，不写进保存记录。
   */
  readonly direction: RunDirection | null;
  /** 唯一径路可达的目标站（按线路顺序排序，不含起点）。 */
  readonly reachable: readonly ReachableStation[];
  /** 存在多条径路的目标站：整条列出并拒绝猜测，不选其中一条。 */
  readonly ambiguous: readonly AmbiguousTarget[];
  /**
   * 回到本段起点的整圈目标（简单环线选定方向后出现在到站列表末项）；非环线或未选方向时为 null。
   * 它与普通到站同一列表、同一选择方式，但站点身份是本段起点，因此不混进 reachable。
   */
  readonly loop: LoopTarget | null;
}

export interface Leg {
  readonly serviceLineId: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly sectionIds: readonly string[];
  readonly lengthMetres: number | null;
  /**
   * 本段沿用的运行方向；只有简单环线上由 `legFromResolution` 写入，普通服务为 null。
   * 这是链与界面的临时元数据，**绝不进入保存记录**（`buildAdvancedSave` 逐字段组装记录）。
   */
  readonly runDirection?: RunDirection | null;
}

export interface ChainDraft {
  readonly onDate: string;
  readonly originStationId: string;
  readonly legs: readonly Leg[];
}

export interface ChainSummary {
  readonly onDate: string;
  readonly fromStation: StationRef;
  readonly toStation: StationRef | null;
  readonly stations: readonly StationRef[];
  readonly legCount: number;
  readonly sectionIds: readonly string[];
  readonly serviceLineIds: readonly string[];
  readonly lengthMetres: number | null;
  readonly mileageStatus: string | null;
  /** 记录起终点相同、从起点绕回起点（整圈）。 */
  readonly loop: boolean;
}

export type Mileage = ReturnType<typeof mileage>;

export class ChainError extends Error {
  code: ChainErrorCode;
  candidates: readonly StationRef[];
  constructor(code: ChainErrorCode, message: string, candidates: readonly StationRef[] = []) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    this.candidates = candidates;
  }
}

export function chainErrorCode(error: unknown): ChainErrorCode | null {
  return error instanceof ChainError ? error.code : null;
}

export function frozenStation(stationId: string, stationName: string): StationRef {
  return Object.freeze({ stationId, stationName });
}

/** 服务候选的唯一组装口径；导出给 continuation.ts 复用，避免两份显示名规则。 */
export function serviceName(network: TransitNetwork, serviceId: string): ServiceCandidate {
  const service = network.services.find((row) => row.id === serviceId);
  if (!service) throw new ChainError('E_REFERENCE', `未知运营线路：${serviceId}`);
  const operator = network.operators.find((row) => row.id === service.operatorId);
  const lineNames = [...new Set(network.memberships
    .filter((row) => row.serviceId === serviceId)
    .map((row) => network.sections.find((section) => section.id === row.sectionId))
    .map((section) => section && network.lines.find((line) => line.id === section.lineId))
    .filter((line): line is NonNullable<typeof line> => Boolean(line))
    .map((line) => line.name))].sort((a, b) => a.localeCompare(b));
  return Object.freeze({
    serviceLineId: serviceId,
    label: `${service.name}（${operator ? operator.name : service.operatorId}）`,
    operatorName: operator ? operator.name : service.operatorId,
    lineNames: Object.freeze(lineNames),
  });
}

function checkedDate(network: TransitNetwork, onDate: string): void {
  try {
    day(onDate, 'advanced.onDate', '1997-01-01');
  } catch {
    throw new ChainError('E_DATE', `日期不可用：${onDate}`);
  }
  if (onDate > network.knowledgeThrough) {
    throw new ChainError('E_DATE', `日期 ${onDate} 超出已验证数据范围（截至 ${network.knowledgeThrough}）`);
  }
}

/** 业务日期上的站名引用；导出给 continuation.ts 复用。 */
export function stationRef(network: TransitNetwork, stationId: string, onDate: string): StationRef {
  const station = network.stations.find((row) => row.id === stationId);
  if (!station) throw new ChainError('E_REFERENCE', `未知车站：${stationId}`);
  const current = network.names.find((row) => row.stationId === stationId && active(row, onDate));
  return frozenStation(stationId, current ? current.name : station.name);
}

function passengerAvailable(network: TransitNetwork, stationId: string, onDate: string): boolean {
  return network.passengerPeriods.some((row) => row.stationId === stationId
    && row.kind === 'passenger' && active(row, onDate));
}

export function listServicesAtStation(
  network: TransitNetwork,
  onDate: string,
  stationId: string,
): readonly ServiceCandidate[] {
  checkedDate(network, onDate);
  stationRef(network, stationId, onDate);
  if (!passengerAvailable(network, stationId, onDate)) {
    throw new ChainError('E_PATH', '该站在该日期不办理客运，不能作为起点或换乘站');
  }
  const ids = new Set<string>();
  for (const membership of network.memberships) {
    if (!active(membership, onDate)) continue;
    const section = network.sections.find((row) => row.id === membership.sectionId);
    if (!section || !active(section, onDate)) continue;
    if (section.fromStationId !== stationId && section.toStationId !== stationId) continue;
    const service = network.services.find((row) => row.id === membership.serviceId);
    const line = network.lines.find((row) => row.id === section.lineId);
    if (!service || !active(service, onDate) || !line || !active(line, onDate)) continue;
    ids.add(service.id);
  }
  // 候选顺序必须稳定：按 serviceLineId 升序，不按显示名排序（locale 影响中文排序结果）。
  return Object.freeze([...ids].map((id) => serviceName(network, id))
    .sort((a, b) => a.serviceLineId.localeCompare(b.serviceLineId)));
}

/**
 * 该服务当日是否出现「乘车方向」步骤，以及两个方向的显示名。
 *
 * 只看当日成员区间的拓扑（`serviceCycle`）：非简单环线返回 null，流程与改动前一致。
 * 简单环线**总是**出现方向步骤，与数据里有没有可用标签无关；选项名与兜底文案由
 * ./directionOptions 组装，程序不替用户猜方向。
 */
export function serviceDirections(
  network: TransitNetwork,
  request: { readonly onDate: string; readonly fromStationId: string; readonly serviceLineId: string },
): ServiceDirections | null {
  const { onDate, fromStationId, serviceLineId } = request;
  checkedDate(network, onDate);
  const cycle = serviceCycle(network, serviceLineId, onDate);
  // 起点不在当日环上时方向无从谈起：按普通服务处理，保持既有流程。
  if (!cycle || !cycle.forward.includes(fromStationId)) return null;
  const fromStation = stationRef(network, fromStationId, onDate);
  const service = serviceName(network, serviceLineId);
  const options = directionOptions(network, onDate, cycle.forward, serviceLineId, fromStationId);
  return Object.freeze({ fromStation, service, options });
}

type Probe = { readonly kind: 'view'; readonly view: DateView }
  | { readonly kind: 'multipath' }
  | { readonly kind: 'none' };

function probe(network: TransitNetwork, onDate: string, from: string, to: string, serviceId: string): Probe {
  try {
    return { kind: 'view', view: buildDateView(network, {
      onDate, fromStationId: from, toStationId: to, serviceLineId: serviceId,
    }) };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code: unknown }).code : null;
    if (code === 'E_MULTIPATH') return { kind: 'multipath' };
    if (code === 'E_PATH') return { kind: 'none' };
    if (code === 'E_DATE') throw new ChainError('E_DATE', '该日期超出已验证数据范围');
    throw error;
  }
}

interface MeasuredTarget {
  readonly sectionIds: readonly string[];
  readonly lengthMetres: number | null;
  readonly routeAvailable: boolean;
}

/**
 * 取目标的区间与可用性。首选 date-view 的唯一径路结论；当它按无向区间图判出“多径路”、
 * 而运行序只有一条可乘径路时，以运行序为准（缺口两侧的成员本就不相接，那条“第二条
 * 径路”无法按序乘行），区间状态与可用性仍按 date-view 的区间状态规则判定。
 */
function measureTarget(
  network: TransitNetwork,
  onDate: string,
  fromStationId: string,
  stationId: string,
  serviceLineId: string,
  walkedSectionIds: readonly string[],
): MeasuredTarget | null {
  const result = probe(network, onDate, fromStationId, stationId, serviceLineId);
  if (result.kind === 'view') {
    return Object.freeze({
      sectionIds: Object.freeze(result.view.normalSections.map((row) => row.id)),
      lengthMetres: mileage(network, result.view.normalSections).lengthMetres,
      routeAvailable: result.view.routeAvailable,
    });
  }
  const walked = walkedSectionIds
    .map((id) => network.sections.find((row) => row.id === id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (result.kind === 'none' || walked.length === 0) return null;
  const normal = walked.filter((row) => sectionStatus(row, network, onDate).status !== 'retired');
  return Object.freeze({
    sectionIds: Object.freeze(normal.map((row) => row.id)),
    lengthMetres: mileage(network, normal).lengthMetres,
    routeAvailable: walked.every((row) => sectionStatus(row, network, onDate).status === 'operated'),
  });
}

/** 首段/下一段共用的唯一径路解析；多径路目标整条列出且不选。 */
export function resolveServicePaths(
  network: TransitNetwork,
  request: {
    readonly onDate: string;
    readonly fromStationId: string;
    readonly serviceLineId: string;
    /** 简单环线上由用户显式选定的乘车方向；缺省按现状两向遍历。 */
    readonly direction?: RunDirection | null;
  },
): ServicePaths {
  const { onDate, fromStationId, serviceLineId, direction } = request;
  checkedDate(network, onDate);
  const fromStation = stationRef(network, fromStationId, onDate);
  if (!passengerAvailable(network, fromStationId, onDate)) {
    throw new ChainError('E_PATH', '该站在该日期不办理客运，不能作为起点');
  }
  const service = serviceName(network, serviceLineId);
  const edges = serviceEdges(network, serviceLineId, onDate);
  const touching = edges.some((edge) => edge.a === fromStationId || edge.b === fromStationId);
  if (!touching) {
    throw new ChainError('E_PATH', `「${service.label}」在 ${onDate} 不经过 ${fromStation.stationName}`, [fromStation]);
  }
  // 候选按线路顺序排列（与基础记录的沿线站序一致）：按服务运行序把区间展开成沿线车站
  // 次序，目标按它在该次序里的位置列出，因此与到目标的区间数无关。多径路目标同样按这个
  // 次序列出（仍不可选）。运行序里没有的站排到最后。
  const stationOrder = new Map<string, number>();
  for (const edge of edges) {
    for (const stationId of [edge.a, edge.b]) {
      if (!stationOrder.has(stationId)) stationOrder.set(stationId, stationOrder.size);
    }
  }
  const lineOrder = (stationId: string): number => stationOrder.get(stationId) ?? stationOrder.size;
  const reachable: { readonly station: ReachableStation; readonly rank: number }[] = [];
  const ambiguous: { readonly target: AmbiguousTarget; readonly rank: number }[] = [];
  // 方向只在简单环线上有意义：非环线（或误传方向）仍按两向遍历，不把普通服务截成单向。
  const cycle = serviceCycle(network, serviceLineId, onDate);
  const walks = direction && cycle
    ? runWalks(edges, fromStationId, { directions: [direction === 'ASC' ? 1 : -1] })
    : runWalks(edges, fromStationId);
  for (const walk of walks) {
    const target = stationRef(network, walk.stationId, onDate);
    if (walk.paths.length > 1) {
      ambiguous.push({
        rank: lineOrder(walk.stationId),
        target: Object.freeze({
          ...target,
          reason: 'E_MULTIPATH' as const,
          detail: '该服务在目标日期到该站存在多条径路；数据发布方可判定，录入侧不猜选。',
        }),
      });
      continue;
    }
    const measured = measureTarget(network, onDate, fromStationId, walk.stationId, serviceLineId,
      walk.paths[0] as readonly string[]);
    if (!measured) continue;
    reachable.push({ rank: lineOrder(walk.stationId), station: Object.freeze({ ...target, ...measured }) });
  }
  if (reachable.length === 0 && ambiguous.length === 0) {
    throw new ChainError('E_PATH', `「${service.label}」在 ${onDate} 从 ${fromStation.stationName} 没有可到达站`, [fromStation]);
  }
  const byStation = (left: StationRef, right: StationRef): number => left.stationId.localeCompare(right.stationId);
  reachable.sort((left, right) => left.rank - right.rank || byStation(left.station, right.station));
  ambiguous.sort((left, right) => left.rank - right.rank || byStation(left.target, right.target));
  return Object.freeze({
    onDate,
    fromStation,
    service,
    // 方向只在简单环线上成立：非环线即使误传也按两向遍历，不宣称用了某个方向。
    direction: direction && cycle ? direction : null,
    reachable: Object.freeze(reachable.map((row) => row.station)),
    ambiguous: Object.freeze(ambiguous.map((row) => row.target)),
    loop: direction && cycle ? loopTarget(network, onDate, cycle, fromStationId, direction) : null,
  });
}

/** 把解析结果落成一段；目标多径路时拒绝并带回候选（不是静默挑一条）。 */
export function legFromResolution(paths: ServicePaths, toStationId: string): Leg {
  const target = paths.reachable.find((row) => row.stationId === toStationId)
    // 整圈目标的站 id 等于本段起点，不属于「到站」，因此单独查。
    ?? (paths.loop && paths.loop.stationId === toStationId ? paths.loop : undefined);
  if (!target) {
    const blocked = paths.ambiguous.find((row) => row.stationId === toStationId);
    if (blocked) {
      throw new ChainError(
        'E_MULTIPATH',
        `到「${blocked.stationName}」存在多条径路，不能自动选定；请先核对数据发布`,
        paths.ambiguous.map((row) => frozenStation(row.stationId, row.stationName)),
      );
    }
    throw new ChainError('E_PATH', '所选目标站不在该线路当日的唯一径路内',
      paths.reachable.map((row) => frozenStation(row.stationId, row.stationName)));
  }
  if (!target.routeAvailable) {
    throw new ChainError('E_PATH', `到「${target.stationName}」的径路在该日期不可办客（暂停/废止区间），不能保存`);
  }
  return Object.freeze({
    serviceLineId: paths.service.serviceLineId,
    fromStationId: paths.fromStation.stationId,
    toStationId,
    sectionIds: target.sectionIds,
    lengthMetres: target.lengthMetres,
    runDirection: paths.direction,
  });
}

export function startChain(
  network: TransitNetwork,
  input: { readonly onDate: string; readonly fromStationId: string },
): ChainDraft {
  checkedDate(network, input.onDate);
  const from = stationRef(network, input.fromStationId, input.onDate);
  if (!passengerAvailable(network, input.fromStationId, input.onDate)) {
    throw new ChainError('E_PATH', `「${from.stationName}」在该日期不办理客运，不能作为起点`, [from]);
  }
  return Object.freeze({ onDate: input.onDate, originStationId: input.fromStationId, legs: Object.freeze([]) });
}

export function chainEndStation(chain: ChainDraft): string {
  const last = chain.legs[chain.legs.length - 1];
  return last ? last.toStationId : chain.originStationId;
}

export function appendLeg(chain: ChainDraft, leg: Leg): ChainDraft {
  const end = chainEndStation(chain);
  if (leg.fromStationId !== end) {
    throw new ChainError('E_PATH', '这一段必须从上一段的终点站继续');
  }
  if (leg.sectionIds.length === 0) {
    throw new ChainError('E_PATH', '空区间不能作为一段');
  }
  // 重复区间只允许同一条简单环线服务的同向续圈；折返必须另开一条记录。
  const conflict = repeatedSectionConflict(chain.legs, leg);
  if (conflict) throw new ChainError('E_PATH', conflict);
  return Object.freeze({ ...chain, legs: Object.freeze([...chain.legs, leg]) });
}

export function rollbackLeg(chain: ChainDraft): { readonly chain: ChainDraft; readonly removed: Leg | null } {
  if (chain.legs.length === 0) return Object.freeze({ chain, removed: null });
  const legs = chain.legs.slice(0, -1);
  return Object.freeze({
    chain: Object.freeze({ ...chain, legs: Object.freeze(legs) }),
    removed: chain.legs[chain.legs.length - 1] as Leg,
  });
}

/** 累计状态（段数、区间、里程、途经站）；删除最后一段后重新计算即为“回退后一致”。 */
export function chainSummary(network: TransitNetwork, chain: ChainDraft): ChainSummary {
  const sectionIds = chain.legs.flatMap((row) => row.sectionIds);
  const sections = sectionIds
    .map((id) => network.sections.find((row) => row.id === id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  const measured = sections.length > 0 ? mileage(network, sections) : null;
  const serviceLineIds: string[] = [];
  for (const leg of chain.legs) {
    if (serviceLineIds[serviceLineIds.length - 1] !== leg.serviceLineId) serviceLineIds.push(leg.serviceLineId);
  }
  const stations: StationRef[] = [stationRef(network, chain.originStationId, chain.onDate)];
  for (const leg of chain.legs) {
    // 整圈段回到自身起点：站序里不重复列同一个站，整圈另由 loop 与摘要文案表达。
    if (leg.toStationId !== leg.fromStationId) stations.push(stationRef(network, leg.toStationId, chain.onDate));
  }
  const end = chainEndStation(chain);
  return Object.freeze({
    onDate: chain.onDate,
    fromStation: stations[0] as StationRef,
    toStation: chain.legs.length === 0 ? null : stationRef(network, end, chain.onDate),
    stations: Object.freeze(stations),
    legCount: chain.legs.length,
    sectionIds: Object.freeze(sectionIds),
    serviceLineIds: Object.freeze(serviceLineIds),
    lengthMetres: measured ? measured.lengthMetres : 0,
    mileageStatus: measured ? measured.mileageStatus : null,
    loop: chain.legs.length > 0 && end === chain.originStationId,
  });
}
