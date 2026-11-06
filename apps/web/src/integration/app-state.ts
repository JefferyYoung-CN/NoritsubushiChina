/**
 * 视图与会话级的纯状态逻辑（P5 收口 S8）。
 *
 * App.vue 只做协调：activeView 联合、日期边界、视图可用性判断都在这里，便于纯逻辑测试。
 * 这里不碰 DOM、不读写存储。
 */
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';

export type ActiveView = 'records' | 'saved' | 'stats' | 'backup' | 'advanced';

export interface ViewEntry {
  readonly id: ActiveView;
  readonly label: string;
  /** 进入该视图所需的最小前提，用于 aria 与禁用原因。 */
  readonly needs: 'network' | 'workspace' | 'workspace+trip';
}

export const VIEWS: readonly ViewEntry[] = Object.freeze([
  Object.freeze({ id: 'records' as const, label: '基础记录', needs: 'workspace' as const }),
  Object.freeze({ id: 'saved' as const, label: '已保存', needs: 'workspace' as const }),
  Object.freeze({ id: 'stats' as const, label: '统计', needs: 'workspace' as const }),
  Object.freeze({ id: 'backup' as const, label: '备份', needs: 'workspace' as const }),
  Object.freeze({ id: 'advanced' as const, label: '进阶', needs: 'workspace' as const }),
]);

export const EARLIEST_DATE = '1997-01-01';

export function isActiveView(value: unknown): value is ActiveView {
  return typeof value === 'string' && VIEWS.some(view => view.id === value);
}

/** 键盘左右切换与 roving tabindex 共用：越界回绕，未知值从记录页起算。 */
export function stepView(current: ActiveView, delta: number): ActiveView {
  const index = VIEWS.findIndex(view => view.id === current);
  const start = index < 0 ? 0 : index;
  const next = (start + delta + VIEWS.length) % VIEWS.length;
  return VIEWS[next]!.id;
}

export function viewLabel(view: ActiveView): string {
  return VIEWS.find(row => row.id === view)?.label ?? '记录';
}

export interface ViewAvailability {
  readonly enabled: boolean;
  readonly reason: string;
}

/** 视图可用性：缺网络/缺工作区/缺日期视图时给出可读原因，而不是进入空白页。 */
export function viewAvailability(
  view: ActiveView,
  context: {
    readonly hasNetwork: boolean;
    readonly workspaceOpen: boolean;
    readonly hasTrip: boolean;
    /** 当前统计日期是否有已验证快照；false 时数据派生视图不可进入。 */
    readonly snapshotAvailable?: boolean;
  },
): ViewAvailability {
  const entry = VIEWS.find(row => row.id === view);
  if (entry === undefined) return { enabled: false, reason: '未知视图' };
  if (entry.needs === 'workspace' && !context.workspaceOpen) {
    return { enabled: false, reason: '本地工作区尚未打开，无法进入' };
  }
  if (entry.needs === 'workspace+trip' && !context.workspaceOpen) {
    return { enabled: false, reason: '本地工作区尚未打开，无法进入' };
  }
  if (entry.needs === 'workspace+trip' && !context.hasTrip) {
    return { enabled: false, reason: '请先选择日期与起终点，构建当天的乘车视图' };
  }
  if (!context.hasNetwork) return { enabled: false, reason: '数据尚未加载完成' };
  const snapshotAvailable = context.snapshotAvailable !== false;
  if (!snapshotAvailable && view !== 'backup') {
    return { enabled: false, reason: '所选日期没有覆盖它的已验证快照；请改回覆盖范围内的日期，当前仍生效的快照保持不变' };
  }
  return { enabled: true, reason: '' };
}

/**
 * 日期边界：不早于 1997-01-01，不晚于快照的业务知识截止日（ADR-0009 的已验证范围）。
 * 越界时夹到边界并给出说明，绝不让统计去猜未来数据。
 */
export function clampDate(onDate: string, network: Pick<TransitNetwork, 'knowledgeThrough'> | null): string {
  const floor = EARLIEST_DATE;
  const ceiling = network?.knowledgeThrough && network.knowledgeThrough >= floor ? network.knowledgeThrough : floor;
  if (typeof onDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(onDate)) return ceiling;
  if (onDate < floor) return floor;
  if (onDate > ceiling) return ceiling;
  return onDate;
}

export function shiftDate(onDate: string, days: number, network: Pick<TransitNetwork, 'knowledgeThrough'> | null): string {
  const base = clampDate(onDate, network);
  const time = Date.parse(`${base}T00:00:00Z`);
  if (Number.isNaN(time)) return clampDate(base, network);
  return clampDate(new Date(time + days * 86_400_000).toISOString().slice(0, 10), network);
}

export interface DateBounds {
  readonly min: string;
  readonly max: string;
  readonly onDate: string;
  readonly atMin: boolean;
  readonly atMax: boolean;
}

/**
 * 已加载数据包声明覆盖范围的并集：日期控件可达的区间。
 * 包内声明的 coverage_from/coverage_to 是含两端；并集之外无法选中任何包。
 */
export interface CoverageWindow {
  readonly min: string;
  readonly max: string;
}

export function coverageWindow(
  coverage: {
    readonly earliestCoverageFrom: string | null;
    readonly latestCoverageTo: string | null;
  } | null,
): CoverageWindow | null {
  if (!coverage || !coverage.earliestCoverageFrom || !coverage.latestCoverageTo) return null;
  const min = coverage.earliestCoverageFrom < EARLIEST_DATE ? EARLIEST_DATE : coverage.earliestCoverageFrom;
  const max = coverage.latestCoverageTo < min ? min : coverage.latestCoverageTo;
  return Object.freeze({ min, max });
}

/** 夹到已声明覆盖范围；格式非法时落到可达上界，不猜未来日期。 */
export function clampToWindow(onDate: string, window: CoverageWindow | null): string {
  if (!window) return EARLIEST_DATE;
  if (typeof onDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(onDate)) return window.max;
  if (onDate < window.min) return window.min;
  if (onDate > window.max) return window.max;
  return onDate;
}

export function dateBounds(window: CoverageWindow | null, onDate: string): DateBounds {
  const min = window?.min ?? EARLIEST_DATE;
  const max = window?.max ?? EARLIEST_DATE;
  const current = clampToWindow(onDate, window);
  return { min, max, onDate: current, atMin: current === min, atMax: current === max };
}

/** 浏览器本地时区的「今天」，格式 YYYY-MM-DD；不用 toISOString，避免 UTC 偏移把日期算成前一天。 */
export function localToday(now: Date = new Date()): string {
  const pad = (value: number): string => `${value}`.padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 网络就绪后的默认业务日期：浏览器本地「今天」，夹到 1997-01-01 与快照知识截止日之间。
 * 不取 snapshotAsOf：那只是快照检查日，用户默认要看的是今天的记录与统计。
 * today 只用于测试注入，省略时读本地时钟。
 */
export function defaultDate(
  network: Pick<TransitNetwork, 'knowledgeThrough'> | null,
  today: string = localToday(),
): string {
  if (!network) return EARLIEST_DATE;
  return clampDate(today, network);
}

/**
 * 来源标签：顶栏常显，切到记录/统计页也不消失。
 * 模拟（重建）封套固定标注「模拟数据 · 仅用于场景验证」（confirmed-decisions §J）。
 */
export function sourceLabel(sourceKind: string): string {
  return sourceKind === 'simulated' ? '模拟数据 · 仅用于场景验证'
    : sourceKind === 'real-regression' ? '真实回归子集 · 内部测试'
      : '真实数据 · 仅限内部测试';
}

export interface EnvelopeNoticeInput {
  /** 当前封套的来源类别；只有模拟（重建）封套需要额外提示。 */
  readonly sourceKind: string;
  readonly snapshotId: string;
  /** 用户当前查看的业务日期。 */
  readonly onDate: string;
  /** 当前封套自己声明的覆盖窗口，不是所有已加载包的并集。 */
  readonly coverage: { readonly from: string; readonly to: string } | null;
}

/**
 * 「这页数据从哪来、覆盖你查的日期没有」——模拟（重建）封套的固定提示。
 * 真实封套沿用面板里的来源标签，返回 null，不重复堆叠文案。
 * 覆盖窗口两端都是含端日；窗口外仍可能停留在旧快照上，所以提示必须自己说清。
 */
export function envelopeNotice(input: EnvelopeNoticeInput): string | null {
  if (input.sourceKind !== 'simulated') return null;
  const snapshotId = input.snapshotId || '未知快照';
  const date = input.onDate || '所选日期';
  const coverage = input.coverage;
  if (!coverage) {
    return `本页数据来自模拟重建封套 ${snapshotId}，这份封套没有声明覆盖范围，无法确认它是否覆盖 ${date}；页面上的线路、车站与区间数量只用于场景验证。`;
  }
  const covered = input.onDate.length > 0 && input.onDate >= coverage.from && input.onDate <= coverage.to;
  return covered
    ? `本页数据来自模拟重建封套 ${snapshotId}，覆盖 ${coverage.from} 至 ${coverage.to}；你查看的 ${date} 在覆盖范围内，页面上的车站、区间与线路都取自这份重建快照，不代表真实运营。`
    : `本页数据来自模拟重建封套 ${snapshotId}，只覆盖 ${coverage.from} 至 ${coverage.to}；你查看的 ${date} 不在覆盖范围内，这一页的数量与统计不能作为依据。`;
}
