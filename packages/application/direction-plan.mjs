import { freeze } from './validation.mjs';

/**
 * 方向标签到运行方向的映射。
 *
 * 内部只有两条走法：ASC＝按该服务当日成员区间的 sequence 升序展开，DESC＝反着走，
 * 即 `simpleCycle` 的 `forward`／`reverse`。界面不出现「正序／逆序」字样，只显示标签或
 * 「往〈下一站〉方向」兜底文案。
 *
 * 映射只用两样输入：环上站序 `cycle`（`simpleCycle` 的 `forward`，长度等于区间数）与两个
 * 方向标签。标签的锚点（一对相邻站）用来确定它对应哪条走法；数组下标不携带语义。
 */

const ASC = 'ASC';
const DESC = 'DESC';
const opposite = direction => (direction === ASC ? DESC : ASC);

const unusable = (reason, anchors) => freeze({
  usable: false,
  reason,
  byDirection: freeze({ [ASC]: null, [DESC]: null }),
  anchors: freeze(anchors),
});

/** 标签锚点定出的走法；半对、from＝to、不属当日成员、两端不相邻都按无锚点处理。 */
function anchorDirection(cycle, direction) {
  if (direction === null || typeof direction !== 'object') return null;
  const { fromStationId, toStationId } = direction;
  if (typeof fromStationId !== 'string' || typeof toStationId !== 'string') return null;
  if (fromStationId === toStationId) return null;
  const fromIndex = cycle.indexOf(fromStationId);
  const toIndex = cycle.indexOf(toStationId);
  if (fromIndex < 0 || toIndex < 0) return null;
  const size = cycle.length;
  if (cycle[(fromIndex + 1) % size] === toStationId) return ASC;
  if (cycle[(toIndex + 1) % size] === fromStationId) return DESC;
  return null;
}

const labelOf = (label, fromStationId, toStationId) => freeze({ label, fromStationId, toStationId });

/**
 * 把服务或物理线路上的两个方向标签映射到内部运行方向。
 *
 * @param cycle 环上站序（`simpleCycle` 的 `forward`）。
 * @param directions 方向标签（`{ label, fromStationId, toStationId }`）。
 * @returns 统一形状：`{ usable, reason, byDirection, anchors }`。
 *   - 可用：`byDirection.ASC`／`.DESC` 各给出显示用标签；单侧合法锚点时另一侧自动取反向，
 *     且不带锚点文字（避免把坏锚点显示给乘客）。
 *   - 不可用：`reason` 为 `'cycle'`（调用方传了非环线站序）、`'count'`（标签数不是 2）、
 *     `'label'`（文字为空或重复）、`'conflict'`（两个锚点指向同一走法）或 `'no-anchor'`
 *     （两个锚点都不可用）。此时 `byDirection` 两项都是 null，界面走「往〈下一站〉方向」。
 *   - `anchors[i]` 是第 i 个标签锚点定出的走法或 null，供数据质量报告记录坏锚点；
 *     标签数不是 2 时没有可对应的标签对，`anchors` 为空数组。
 */
export function planDirections(cycle, directions) {
  if (!Array.isArray(cycle) || cycle.length < 3 || !cycle.every(stationId => typeof stationId === 'string') ||
      new Set(cycle).size !== cycle.length) {
    return unusable('cycle', []);
  }
  // 稀疏数组的空槽先落成显式缺失项，否则 map／forEach 会跳过它们而漏判。
  const labels = Array.isArray(directions) ? Array.from(directions) : [];
  if (labels.length !== 2) return unusable('count', []);
  const anchors = labels.map(direction => anchorDirection(cycle, direction));
  const names = labels.map(direction => (typeof direction?.label === 'string' ? direction.label.trim() : ''));
  if (names.some(name => name === '') || names[0] === names[1]) return unusable('label', anchors);
  if (anchors[0] !== null && anchors[0] === anchors[1]) return unusable('conflict', anchors);
  if (anchors[0] === null && anchors[1] === null) return unusable('no-anchor', anchors);

  // 两个锚点都不可用时上面已返回，因此这里至少有一个合法锚点。
  const known = anchors[0] ?? anchors[1];
  const byDirection = { [ASC]: null, [DESC]: null };
  labels.forEach((direction, index) => {
    if (anchors[index] !== null) {
      byDirection[anchors[index]] = labelOf(names[index], direction.fromStationId ?? null,
        direction.toStationId ?? null);
    }
  });
  const missingIndex = anchors.findIndex(anchor => anchor === null);
  if (missingIndex >= 0) {
    // 环上只有两条走法，另一侧因此不是猜方向；它没有合法锚点，不带锚点文字。
    byDirection[opposite(known)] = labelOf(names[missingIndex], null, null);
  }
  return freeze({ usable: true, reason: null, byDirection: freeze(byDirection), anchors: freeze(anchors) });
}
