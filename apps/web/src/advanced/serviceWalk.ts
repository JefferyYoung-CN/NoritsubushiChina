import { active } from '../../../../packages/application/validation.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';

/** 一段可乘区间在站间的端；a/b 与运行方向无关。 */
export interface Edge {
  readonly sectionId: string;
  readonly a: string;
  readonly b: string;
}

/**
 * 该日期上该运营线路的可用区间，按服务运行序（memberships.sequence 升序）排列。
 * 线路/服务/区间/成员关系都要在期内；同一区间只保留序号最小的一次。
 */
export function serviceEdges(network: TransitNetwork, serviceId: string, onDate: string): readonly Edge[] {
  const service = network.services.find((row) => row.id === serviceId);
  if (!service || !active(service, onDate)) return [];
  const seen = new Set<string>();
  const ordered: { readonly sequence: number; readonly edge: Edge }[] = [];
  for (const membership of network.memberships) {
    if (membership.serviceId !== serviceId || !active(membership, onDate)) continue;
    const section = network.sections.find((row) => row.id === membership.sectionId);
    if (!section || !active(section, onDate)) continue;
    const line = network.lines.find((row) => row.id === section.lineId);
    if (!line || !active(line, onDate)) continue;
    if (seen.has(section.id)) continue;
    seen.add(section.id);
    ordered.push({
      sequence: membership.sequence,
      edge: { sectionId: section.id, a: section.fromStationId, b: section.toStationId },
    });
  }
  ordered.sort((left, right) => left.sequence - right.sequence);
  return Object.freeze(ordered.map((row) => Object.freeze(row.edge)));
}

/** 成员区间在给定站上的另一端；不经过该站返回 null。 */
export function otherEnd(edge: Edge, stationId: string): string | null {
  if (edge.a === stationId) return edge.b;
  if (edge.b === stationId) return edge.a;
  return null;
}

export interface RunWalk {
  readonly stationId: string;
  /** 覆盖该站的可乘径路；1 条为唯一径路，多于 1 条为多径路（整条列出、不猜选）。 */
  readonly paths: readonly (readonly string[])[];
}

export interface WalkOptions {
  /**
   * 只沿给定序号方向遍历；缺省两个方向都走（普通服务的现状）。
   * 单向模式按序号首尾相接取模，绕回起点前的全部站；它只用于已判定为简单环线的服务，
   * 普通服务不传方向，否则序号缺口两侧的区间会被拼成不可乘径路。
   */
  readonly directions?: readonly (1 | -1)[];
}

/**
 * 沿服务运行序做单调邻接遍历：方向只允许序号递增或递减，且下一成员必须在当前站首尾
 * 相接。分支服务在序号缺口处自然断开，于是分支内各站唯一、汇合站两条；环形服务两个
 * 方向各得一条，仍判为多径路。无向连通性不参与判定（会造出跨序号缺口的不可乘径路）。
 *
 * 简单环线选定方向后由调用方传入单向：此时按序号取模绕行，回到起点即停（整圈目标由
 * 到站列表单独处理），每个到站只剩沿该方向的那一条径路。
 */
export function runWalks(
  edges: readonly Edge[],
  originId: string,
  options: WalkOptions = {},
): readonly RunWalk[] {
  const directions = options.directions ?? [1, -1];
  const wrap = options.directions !== undefined;
  const found = new Map<string, string[][]>();
  const record = (stationId: string, sectionIds: readonly string[]): void => {
    if (stationId === originId) return;
    const signature = sectionIds.join('>');
    const paths = found.get(stationId) ?? [];
    if (!paths.some((row) => row.join('>') === signature)) paths.push([...sectionIds]);
    found.set(stationId, paths);
  };
  edges.forEach((edge, index) => {
    const start = otherEnd(edge, originId);
    if (start === null) return;
    for (const direction of directions) {
      let current = start;
      let sectionIds: readonly string[] = [edge.sectionId];
      let advanced = false;
      if (!wrap) record(current, sectionIds);
      for (let step = 1; step <= edges.length; step++) {
        const raw = index + direction * step;
        const j = wrap ? ((raw % edges.length) + edges.length) % edges.length : raw;
        if (j < 0 || j >= edges.length) break;
        const next = otherEnd(edges[j] as Edge, current);
        if (next === null) break;
        sectionIds = [...sectionIds, (edges[j] as Edge).sectionId];
        current = next;
        advanced = true;
        if (current === originId) break;
        record(current, sectionIds);
      }
      // 环线起点两侧各有一条邻接区间，只有沿所选方向展开的那条有效；另一条走一步就断，
      // 不能把它的另一端记成该方向上的到站。两向遍历保持原样（起点直接记一条）。
      if (wrap && advanced) record(start, [edge.sectionId]);
    }
  });
  return [...found.entries()].map(([stationId, paths]) => Object.freeze({
    stationId,
    paths: Object.freeze(paths.map((row) => Object.freeze(row))),
  }));
}
