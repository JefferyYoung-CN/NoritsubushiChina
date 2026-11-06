/**
 * 「整线分段有序区间」派生：把当日有效物理区间整理成图与选站共用的走线顺序。
 *
 * 纯函数，不依赖 Vue/DOM。规则来源：票 10「分叉线路（Y 形）与断线在线路图上的表达」：
 * - 废线区间不参与，临时停运只影响区间状态、不影响顺序；
 * - 环线用 foldedLoop 展开、末端独立位置键，不套用西/北定头；折叠不成立的环线退回分段派生；
 * - 非环线每个连通段独立成蛇，蛇身取经过分岔站的最长路径，其余臂从分岔站拐出；
 * - 各段分别定头（西优先、经度接近取北、坐标缺失按站名），段间用严格的西/北键排序；
 * - 不办客的中间站保留位置但不画点；段间接缝只标「无区间」，不写推测原因；
 * - 拓扑不是树（未折叠闭环、平行区间、复杂分岔）时按确定性 DFS 降级，不静默丢站、不重复位置。
 */
import { effectiveFoldedLoop, sectionStatus } from '../../../../packages/application/date-view.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { active } from '../../../../packages/application/validation.mjs';
import { buildStationLabels } from './labels';

/** 环线展开后的末端位置键；末端折叠站绝不作为假车站保存。 */
export const foldEndKey = (stationId: string): string => `fold-end:${stationId}`;

/** 当日可录入的物理区间：线路与区间当日有效，且不是永久关闭的废线。 */
export function physicalSections(network: TransitNetwork, lineId: string, onDate: string) {
  const line = network.lines.find(row => row.id === lineId);
  if (!line || !active(line, onDate) || onDate > network.knowledgeThrough) return [];
  return network.sections.filter(row => row.lineId === lineId && active(row, onDate) && sectionStatus(row, network, onDate).status !== 'retired');
}

/**
 * 当日可按折叠环处理的物理线路。判定只保留一份：直接复用 date-view 的
 * effectiveFoldedLoop（折叠成立且没有闭环区间被判永久关闭），避免候选站序与
 * 日期视图对「是否折叠」各说各话。
 */
export const physicalLoop = effectiveFoldedLoop;

/** 单段定头阈值：经度差小于约 0.01°（约 1km）视为「经度接近」，改按更靠北的一端定头。 */
const LONGITUDE_TOLERANCE = 0.01;

/** 位置在蛇形走线上的角色：蛇身主线或从分岔站拐出的支线臂。 */
export type RouteArmRole = 'spine' | 'branch';

export interface RoutePosition {
  /** 选择与区间端点身份：环线末端为 fold-end:xxx，其余等于 stationId。 */
  readonly positionKey: string;
  readonly stationId: string;
  readonly label: string;
  /** 当日不办客的直穿站为 false：仍占位置、连线直穿，但不画点也不可点选。 */
  readonly drawsPoint: boolean;
  readonly segmentIndex: number;
  readonly arm: RouteArmRole;
}

export interface RouteSection {
  readonly sectionId: string;
  readonly fromPositionKey: string;
  readonly toPositionKey: string;
}

export interface RouteSegment {
  readonly index: number;
  readonly positionKeys: readonly string[];
}

export interface RouteArm {
  /** 数据无支线声明字段时固定为「往〈臂末端站显示名〉方向」；补字段后在此切换。 */
  readonly label: string;
  readonly positionKeys: readonly string[];
  /** 支线臂拐出的分岔站位置键；该站本身属于蛇身，不在 positionKeys 里重复。 */
  readonly branchPositionKey: string;
}

export interface RouteGap {
  /** 只表示两段之间没有区间，不写「未贯通」「分段开通」等推测原因。 */
  readonly kind: 'no-section';
  readonly fromPositionKey: string;
  readonly toPositionKey: string;
}

export interface PhysicalRouteSequence {
  /**
   * loop=按折叠环展开；tree=树形（正常分叉、多段也是树）；irregular=降级显示
   * （未折叠闭环、平行区间或复杂分岔），位置仍覆盖全部车站，下游可据此提示。
   */
  readonly topology: 'tree' | 'loop' | 'irregular';
  /** 数组顺序即图上行进顺序：各段蛇身在前，该段的支线臂随后。 */
  readonly positions: readonly RoutePosition[];
  readonly sections: readonly RouteSection[];
  readonly segments: readonly RouteSegment[];
  readonly arms: readonly RouteArm[];
  readonly gaps: readonly RouteGap[];
}

interface AdjacencyEdge { readonly to: string; readonly sectionId: string }
type Adjacency = ReadonlyMap<string, readonly AdjacencyEdge[]>;
interface PathDraft { nodes: string[]; sectionIds: string[] }
interface SectionLink { readonly sectionId: string; readonly from: string; readonly to: string }
interface ArmDraft { readonly branchStationId: string; readonly stationIds: string[]; readonly links: readonly SectionLink[] }
interface SegmentDraft { readonly kind: 'tree' | 'irregular'; readonly spine: PathDraft; readonly arms: readonly ArmDraft[] }
interface SegmentUnit { readonly head: string; readonly drafts: readonly SegmentDraft[] }

/** 站名取当日有效名称；站名表缺失时退回车站自身名称。 */
function stationName(network: TransitNetwork, onDate: string, stationId: string): string {
  return network.names.find(row => row.stationId === stationId && active(row, onDate))?.name
    ?? network.stations.find(row => row.id === stationId)?.name ?? stationId;
}

/** 车站不在快照里时仍要有个可读位置名；正常数据不会走到这里。 */
function fallbackLabel(network: TransitNetwork, onDate: string, stationId: string): string {
  return stationName(network, onDate, stationId);
}

/**
 * 蛇身 = 经过分岔站的最长简单路径（机械规则，不猜主/支语义）。
 *
 * 物理线路的连通段是树或单环，按「叶站两两之间的简单路径」枚举即可，规模受线路站数约束。
 * 等长路径用端点规范序打破平局；最终方向由 `compareHeads`（西优先、经度接近取北）决定。
 */
function collectSpinePath(nodes: readonly string[], adjacency: Adjacency,
    compareHeads: (left: string, right: string) => number): PathDraft {
  const leaves = nodes.filter(id => (adjacency.get(id)?.length ?? 0) === 1);
  const endpointIds = leaves.length >= 2 ? leaves : [...nodes];
  const endpointSet = new Set(endpointIds);
  const paths: PathDraft[] = [];
  for (const start of endpointIds) {
    const used = new Set([start]);
    const visit = (node: string, path: PathDraft): void => {
      if (path.nodes.length > 1 && endpointSet.has(node)) paths.push({ nodes: [...path.nodes], sectionIds: [...path.sectionIds] });
      for (const edge of adjacency.get(node) ?? []) {
        if (used.has(edge.to)) continue;
        used.add(edge.to);
        path.nodes.push(edge.to);
        path.sectionIds.push(edge.sectionId);
        visit(edge.to, path);
        path.nodes.pop();
        path.sectionIds.pop();
        used.delete(edge.to);
      }
    };
    visit(start, { nodes: [start], sectionIds: [] });
  }
  const branchStations = new Set(nodes.filter(id => (adjacency.get(id)?.length ?? 0) >= 3));
  const canonical = (path: PathDraft): string => {
    const forward = path.nodes.join('\u0000');
    const backward = [...path.nodes].reverse().join('\u0000');
    return forward < backward ? forward : backward;
  };
  const better = (candidate: PathDraft, current: PathDraft): boolean =>
    candidate.sectionIds.length !== current.sectionIds.length
      ? candidate.sectionIds.length > current.sectionIds.length
      : canonical(candidate) < canonical(current);
  const throughBranch = branchStations.size > 0 ? paths.filter(path => path.nodes.some(id => branchStations.has(id))) : paths;
  const candidates = throughBranch.length > 0 ? throughBranch : paths;
  let best: PathDraft | null = null;
  for (const path of candidates) if (best === null || better(path, best)) best = path;
  const chosen = best ?? { nodes: [...nodes], sectionIds: [] };
  return compareHeads(chosen.nodes[0], chosen.nodes[chosen.nodes.length - 1]) <= 0
    ? chosen
    : { nodes: [...chosen.nodes].reverse(), sectionIds: [...chosen.sectionIds].reverse() };
}

/** 连通段是否为树：边数超过「站数 - 1」就是未折叠闭环、平行区间或复杂分岔。 */
function isIrregular(nodes: readonly string[], adjacency: Adjacency): boolean {
  const edges = nodes.reduce((sum, id) => sum + (adjacency.get(id)?.length ?? 0), 0) / 2;
  return edges > nodes.length - 1;
}

/** 同一对相邻站可能有多条区间；只取 id 最小的一条，其余不画、不猜。 */
function sectionBetween(adjacency: Adjacency, left: string, right: string): AdjacencyEdge | null {
  let best: AdjacencyEdge | null = null;
  for (const edge of adjacency.get(left) ?? []) {
    if (edge.to !== right) continue;
    if (best === null || edge.sectionId < best.sectionId) best = edge;
  }
  return best;
}

/**
 * irregular 段的确定性降级排序：从严格排序键最小的站出发做 DFS，邻边按站 id、区间 id
 * 固定排序，保证每个站恰好出现一次、位置键唯一。相邻两站确有区间才输出区间；没有区间的
 * 相邻处拆成多段，由调用方补 no-section 断口。
 */
function irregularRuns(nodes: readonly string[], adjacency: Adjacency,
    compareOrder: (left: string, right: string) => number): PathDraft[] {
  const seed = nodes.reduce((best, id) => (compareOrder(id, best) < 0 ? id : best));
  const order = [seed];
  const visited = new Set([seed]);
  const walk = (stationId: string): void => {
    const edges = [...(adjacency.get(stationId) ?? [])].sort((left, right) =>
      left.to < right.to ? -1 : left.to > right.to ? 1 : left.sectionId < right.sectionId ? -1 : 1);
    for (const edge of edges) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      order.push(edge.to);
      walk(edge.to);
    }
  };
  walk(seed);
  const runs: PathDraft[] = [];
  let current: PathDraft = { nodes: [order[0]], sectionIds: [] };
  for (let index = 1; index < order.length; index++) {
    const edge = sectionBetween(adjacency, order[index - 1], order[index]);
    if (!edge) {
      runs.push(current);
      current = { nodes: [order[index]], sectionIds: [] };
      continue;
    }
    current.nodes.push(order[index]);
    current.sectionIds.push(edge.sectionId);
  }
  runs.push(current);
  return runs;
}

/**
 * 从蛇身上的每个分岔站拐出支线臂：沿不在蛇身上的邻边向外走到叶子（或绕回蛇身）为止。
 * 当前快照只有单层 Y 形分岔；若臂内部再分岔，仍归为同一条臂并按先序展开，不另立层级。
 * 支线声明字段尚不存在，标注只能用臂末端站名拼「往 XX 方向」。
 */
function branchArms(spine: PathDraft, adjacency: Adjacency): ArmDraft[] {
  const spineStations = new Set(spine.nodes);
  const spineSections = new Set(spine.sectionIds);
  const arms: ArmDraft[] = [];
  for (const branchStationId of spine.nodes) {
    if ((adjacency.get(branchStationId)?.length ?? 0) < 3) continue;
    for (const edge of adjacency.get(branchStationId) ?? []) {
      if (spineSections.has(edge.sectionId) || spineStations.has(edge.to)) continue;
      const used = new Set([branchStationId, edge.to]);
      const stationIds = [edge.to];
      const links: SectionLink[] = [{ sectionId: edge.sectionId, from: branchStationId, to: edge.to }];
      const walk = (stationId: string): void => {
        for (const next of adjacency.get(stationId) ?? []) {
          if (used.has(next.to) || spineStations.has(next.to)) continue;
          used.add(next.to);
          stationIds.push(next.to);
          links.push({ sectionId: next.sectionId, from: stationId, to: next.to });
          walk(next.to);
        }
      };
      walk(edge.to);
      arms.push({ branchStationId, stationIds, links });
    }
  }
  return arms;
}

/**
 * 整线分段有序区间派生。输入当日有效线网、日期与物理线路，输出图与选站共用的走线顺序；
 * 无有效区间时返回空结构（topology 取 tree，表示没有需要提示的降级）。
 */
export function physicalRouteSequence(network: TransitNetwork, onDate: string, lineId: string): PhysicalRouteSequence {
  const sections = physicalSections(network, lineId, onDate);
  if (sections.length === 0) return { topology: 'tree', positions: [], sections: [], segments: [], arms: [], gaps: [] };
  const labels = buildStationLabels(network, onDate);
  const passengerStations = new Set(network.passengerPeriods
    .filter(period => period.kind === 'passenger' && active(period, onDate))
    .map(period => period.stationId));
  const labelOf = (stationId: string): string => labels.get(stationId)?.label ?? fallbackLabel(network, onDate, stationId);
  const drawsPoint = (stationId: string): boolean => passengerStations.has(stationId);

  const loop = physicalLoop(network, lineId, onDate);
  if (loop) {
    const positions = loop.stationIds.map((stationId, index): RoutePosition => {
      const last = index === loop.stationIds.length - 1;
      const suffix = index === 0 ? '（起端）' : last ? '（末端）' : '';
      return { positionKey: last ? foldEndKey(stationId) : stationId, stationId,
        label: `${labelOf(stationId)}${suffix}`, drawsPoint: drawsPoint(stationId), segmentIndex: 0, arm: 'spine' };
    });
    return {
      topology: 'loop',
      positions,
      sections: loop.sections.map((row, index) => ({ sectionId: row.id,
        fromPositionKey: positions[index].positionKey, toPositionKey: positions[index + 1].positionKey })),
      segments: [{ index: 0, positionKeys: positions.map(row => row.positionKey) }],
      arms: [],
      gaps: [],
    };
  }

  const adjacency = new Map<string, AdjacencyEdge[]>();
  const link = (from: string, to: string, sectionId: string): void => {
    const edges = adjacency.get(from);
    if (edges) edges.push({ to, sectionId });
    else adjacency.set(from, [{ to, sectionId }]);
  };
  for (const row of sections) {
    link(row.fromStationId, row.toStationId, row.id);
    link(row.toStationId, row.fromStationId, row.id);
  }

  const stationById = new Map(network.stations.map(row => [row.id, row]));
  /** 单段蛇身定头：明显更靠西放左；经度接近取更靠北；坐标缺失按站名。 */
  const compareHeads = (left: string, right: string): number => {
    const leftStation = stationById.get(left), rightStation = stationById.get(right);
    const leftLatitude = leftStation?.latitude ?? null, leftLongitude = leftStation?.longitude ?? null;
    const rightLatitude = rightStation?.latitude ?? null, rightLongitude = rightStation?.longitude ?? null;
    if (leftLatitude !== null && leftLongitude !== null && rightLatitude !== null && rightLongitude !== null) {
      if (Math.abs(leftLongitude - rightLongitude) >= LONGITUDE_TOLERANCE) return leftLongitude < rightLongitude ? -1 : 1;
      if (leftLatitude !== rightLatitude) return leftLatitude > rightLatitude ? -1 : 1;
    }
    return compareStationKeys(network, onDate, left, right);
  };
  /**
   * 段与段排序、irregular 选种子的严格键：有坐标优先 → 经度升序 → 纬度降序 → 当日站名 → id。
   * 与单段定头不同，这里不带 0.01° 容差；逐项比较保证全序可传递、与输入顺序无关。
   */
  const compareSegmentHeads = (left: string, right: string): number => {
    const leftStation = stationById.get(left), rightStation = stationById.get(right);
    const leftHasCoordinates = leftStation?.latitude !== null && leftStation?.latitude !== undefined &&
      leftStation.longitude !== null && leftStation.longitude !== undefined;
    const rightHasCoordinates = rightStation?.latitude !== null && rightStation?.latitude !== undefined &&
      rightStation.longitude !== null && rightStation.longitude !== undefined;
    const leftKey: readonly SortValue[] = [leftHasCoordinates ? 0 : 1, leftStation?.longitude ?? 0,
      -(leftStation?.latitude ?? 0), stationName(network, onDate, left), left];
    const rightKey: readonly SortValue[] = [rightHasCoordinates ? 0 : 1, rightStation?.longitude ?? 0,
      -(rightStation?.latitude ?? 0), stationName(network, onDate, right), right];
    for (let index = 0; index < leftKey.length; index++) {
      const order = compareSortValues(leftKey[index], rightKey[index]);
      if (order !== 0) return order;
    }
    return 0;
  };

  const components: string[][] = [];
  const visited = new Set<string>();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const queue = [start];
    visited.add(start);
    for (let index = 0; index < queue.length; index++) {
      for (const edge of adjacency.get(queue[index]) ?? []) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
    components.push(queue);
  }

  const units: SegmentUnit[] = components.map(nodes => {
    const spine = isIrregular(nodes, adjacency) ? null : collectSpinePath(nodes, adjacency, compareHeads);
    const arms = spine ? branchArms(spine, adjacency) : [];
    // 支线臂内部再分岔时，压成一行会出现「相邻但无区间」的位置对；整段按 irregular 降级。
    const armBranches = arms.some(arm => arm.stationIds.some(id => (adjacency.get(id)?.length ?? 0) >= 3));
    if (!spine || armBranches) {
      const runs = irregularRuns(nodes, adjacency, compareSegmentHeads);
      return { head: runs[0].nodes[0], drafts: runs.map(run => ({ kind: 'irregular' as const, spine: run, arms: [] })) };
    }
    return { head: spine.nodes[0], drafts: [{ kind: 'tree' as const, spine, arms }] };
  });
  units.sort((left, right) => compareSegmentHeads(left.head, right.head));
  const drafts = units.flatMap(unit => unit.drafts);
  const topology = drafts.some(draft => draft.kind === 'irregular') ? 'irregular' : 'tree';

  const positions: RoutePosition[] = [];
  const orderedSections: RouteSection[] = [];
  const segments: RouteSegment[] = [];
  const arms: RouteArm[] = [];
  const gaps: RouteGap[] = [];
  drafts.forEach((draft, segmentIndex) => {
    const positionKeys: string[] = [];
    for (const stationId of draft.spine.nodes) {
      positionKeys.push(stationId);
      positions.push({ positionKey: stationId, stationId, label: labelOf(stationId),
        drawsPoint: drawsPoint(stationId), segmentIndex, arm: 'spine' });
    }
    for (let index = 0; index < draft.spine.sectionIds.length; index++) {
      orderedSections.push({ sectionId: draft.spine.sectionIds[index],
        fromPositionKey: draft.spine.nodes[index], toPositionKey: draft.spine.nodes[index + 1] });
    }
    for (const arm of draft.arms) {
      const lastStationId = arm.stationIds[arm.stationIds.length - 1];
      arms.push({ label: `往${stationName(network, onDate, lastStationId)}方向`,
        positionKeys: arm.stationIds, branchPositionKey: arm.branchStationId });
      for (const stationId of arm.stationIds) {
        positionKeys.push(stationId);
        positions.push({ positionKey: stationId, stationId, label: labelOf(stationId),
          drawsPoint: drawsPoint(stationId), segmentIndex, arm: 'branch' });
      }
      for (const row of arm.links) {
        orderedSections.push({ sectionId: row.sectionId, fromPositionKey: row.from, toPositionKey: row.to });
      }
    }
    segments.push({ index: segmentIndex, positionKeys });
  });
  for (let index = 0; index < segments.length - 1; index++) {
    const previous = segments[index].positionKeys, next = segments[index + 1].positionKeys;
    gaps.push({ kind: 'no-section', fromPositionKey: previous[previous.length - 1], toPositionKey: next[0] });
  }
  return { topology, positions, sections: orderedSections, segments, arms, gaps };
}

/** 站名 → id 的兜底比较：先按当日站名，再按 id，保证排序可传递。 */
function compareStationKeys(network: TransitNetwork, onDate: string, left: string, right: string): number {
  const byName = stationName(network, onDate, left)
    .localeCompare(stationName(network, onDate, right), 'zh-Hans-CN', { numeric: true });
  if (byName !== 0) return byName;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 段间严格排序键的单项：坐标标志/经度/纬度是数字，站名与 id 是文本。 */
type SortValue = number | string;

function compareSortValues(left: SortValue, right: SortValue): number {
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  return String(left).localeCompare(String(right), 'zh-Hans-CN', { numeric: true });
}
