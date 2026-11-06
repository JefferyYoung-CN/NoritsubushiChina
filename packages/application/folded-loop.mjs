import { active, freeze } from './validation.mjs';

/** 仅把当日完整简单环展开为位置序列；身份和全部闭环区间保持不变。 */
export function foldedLoop(network, lineId, onDate) {
  const line = network.lines.find(row => row.id === lineId && active(row, onDate));
  if (!line?.isLoop || !line.foldStationId) return null;
  const sections = network.sections.filter(row => row.lineId === lineId && active(row, onDate));
  const graph = new Map();
  for (const section of sections) {
    if (section.fromStationId === section.toStationId) return null;
    for (const [from, to] of [[section.fromStationId, section.toStationId], [section.toStationId, section.fromStationId]]) {
      if (!graph.has(from)) graph.set(from, []);
      graph.get(from).push({ to, section });
    }
  }
  if (graph.size < 3 || !graph.has(line.foldStationId) || [...graph.values()].some(edges => edges.length !== 2)) return null;
  const stationIds = [line.foldStationId], ordered = [];
  const visited = new Set();
  let current = line.foldStationId, previous = null;
  do {
    if (visited.has(current)) return null;
    visited.add(current);
    const edge = graph.get(current).find(row => row.section.id !== previous);
    if (!edge) return null;
    ordered.push(edge.section);
    stationIds.push(edge.to);
    previous = edge.section.id;
    current = edge.to;
  } while (current !== line.foldStationId);
  if (ordered.length !== sections.length) return null;
  const anchor = line.directions[0];
  const forward = stationIds.findIndex((id, index) => id === anchor?.fromStationId && stationIds[index + 1] === anchor?.toStationId);
  const reverse = stationIds.findIndex((id, index) => id === anchor?.toStationId && stationIds[index + 1] === anchor?.fromStationId);
  if (forward < 0 && reverse < 0) return null;
  return freeze({ stationIds: forward >= 0 ? stationIds : stationIds.reverse(), sections: forward >= 0 ? ordered : ordered.reverse() });
}

/** 两个录入位置之间的区间；跨折叠点必须另录一段，不做环绕拼接。 */
export function foldedInterval(loop, fromIndex, toIndex) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 ||
      fromIndex >= loop.stationIds.length || toIndex >= loop.stationIds.length || fromIndex === toIndex) return null;
  const sections = loop.sections.slice(Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex));
  return fromIndex < toIndex ? sections : sections.reverse();
}

export function matchFoldedInterval(loop, from, to, sectionIds) {
  if (!Array.isArray(sectionIds)) return null;
  for (let a = 0; a < loop.stationIds.length; a++) {
    if (loop.stationIds[a] !== from) continue;
    for (let b = 0; b < loop.stationIds.length; b++) {
      if (loop.stationIds[b] !== to) continue;
      const route = foldedInterval(loop, a, b);
      if (route && route.length === sectionIds.length && route.every((row, index) => row.id === sectionIds[index])) return route;
    }
  }
  return null;
}
