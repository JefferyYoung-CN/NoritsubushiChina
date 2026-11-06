/**
 * 图例展开次数的浏览器本地状态（票 06）。
 *
 * 纯 UI 状态：不进行程 modelValue、不进业务派生；只决定图例这次进入是自动展开还是收起。
 * localStorage 不可用（隐私模式、jsdom 无存储等）时按「首次进入」处理并静默降级，绝不抛错。
 */
export const LEGEND_STORAGE_KEY = 'noritsubushi:route-diagram-legend:visits';
/** 前 3 次进入自动展开；第 4 次起收起为「图例」按钮。 */
export const LEGEND_AUTO_OPEN_LIMIT = 3;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 已记录的有效进入次数；缺失或非法值按 0 处理。 */
export function readLegendVisits(): number {
  try {
    const raw = storage()?.getItem(LEGEND_STORAGE_KEY);
    const value = Number.parseInt(raw ?? '', 10);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** 记一次进入；返回记账后的累计次数（存储不可用时返回本次猜测值，不抛错）。 */
export function recordLegendVisit(): number {
  const next = readLegendVisits() + 1;
  try {
    storage()?.setItem(LEGEND_STORAGE_KEY, String(next));
  } catch {
    // 存不下也不影响本次显示：调用方只用返回的 autoOpen 决定是否展开。
  }
  return next;
}

/** 本次进入是否自动展开（看的是「之前已进入过几次」）。 */
export function legendOpenOnEnter(): { readonly autoOpen: boolean; readonly visits: number } {
  const previous = readLegendVisits();
  recordLegendVisit();
  return { autoOpen: previous < LEGEND_AUTO_OPEN_LIMIT, visits: previous };
}
