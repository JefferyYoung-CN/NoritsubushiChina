/**
 * Checked public shape for date-view.mjs.
 *
 * 运行时校验与冻结仍在 date-view.mjs；这里只声明公共导出，供浏览器端与 TypeScript
 * 测试在编译期复用同一套日期视图/区间状态/里程降级类型，避免调用方各自复制形状。
 */
import type { TransitNetwork } from './reader.mjs';
import type { FoldedLoop } from './folded-loop.mjs';

/** 区间展示状态；与 date-view 的 sectionStatus 返回值一一对应。 */
export type SectionStatusName = 'operated' | 'temporary' | 'retired';

/** sectionStatus 只需要这两个字段，因此日期视图与地图组件可以传同一份最小引用。 */
export interface DateViewSectionRef {
  readonly id: string;
  readonly lineId: string;
}

export interface DateViewRequest {
  /**
   * 已存的有序区间：物理线路分支须是该线当日唯一径路（折叠环为展开后连续的一段）；
   * 服务型请求按它重放核验——环线上还须是同一方向整圈 × k + 末段同方向半圈。
   */
  readonly sectionIds?: readonly string[];
  readonly physicalLineId?: string;
  readonly onDate: string;
  readonly serviceLineId: string | null;
  readonly fromStationId: string | null;
  readonly toStationId: string | null;
}

export type SectionStatusView =
  | { readonly status: 'operated' }
  | { readonly status: 'temporary' }
  | { readonly status: 'retired'; readonly retiredOn: string };

export interface MileageGroup {
  readonly basis: 'metres' | 'sections';
  readonly sectionCount: number;
  readonly lengthMetres: number | null;
}

export interface MileageView {
  readonly mileageStatus: 'available' | 'incomplete' | 'not-provided';
  readonly statisticsBasis: 'metres' | 'sections' | 'unavailable';
  readonly noMileageLabel: boolean;
  readonly lengthMetres: number | null;
  readonly mileageGroups: readonly MileageGroup[];
}

/** 日期视图里的站点：保留快照坐标，名称按业务日期解析（可能为空），并带办客可用性。 */
export interface DateViewStation extends Omit<TransitNetwork['stations'][number], 'name'> {
  readonly name: string | null;
  readonly passengerAvailable: boolean;
}

export interface DateView {
  readonly physicalLineId?: string;
  readonly kind: 'date-view';
  readonly snapshotId: string;
  readonly sourceKind: TransitNetwork['sourceKind'];
  readonly sourceUse: TransitNetwork['sourceUse'];
  readonly attribution: string;
  readonly releaseReady: false;
  readonly onDate: string;
  readonly serviceLineId: string | null;
  readonly fromStationId: string | null;
  readonly toStationId: string | null;
  readonly empty: boolean;
  readonly routeAvailable: boolean;
  readonly mapAvailable: boolean;
  readonly normalSections: readonly TransitNetwork['sections'][number][];
  readonly retiredSections: readonly TransitNetwork['sections'][number][];
  readonly temporarySections: readonly TransitNetwork['sections'][number][];
  readonly stations: readonly DateViewStation[];
  readonly normalLengthMetres: number | null;
  readonly retiredLengthMetres: number | null;
  readonly mileageStatus: MileageView['mileageStatus'];
  readonly statisticsBasis: MileageView['statisticsBasis'];
  readonly noMileageLabel: boolean;
  readonly mileageGroups: readonly MileageGroup[];
  readonly retiredTopologyDates: readonly string[];
  readonly retiredTopologyDate: string | null;
}

/** observation 的 snake_case 字段是下游统计/持久化契约的一部分，不能改名。 */
export interface DateViewObservation {
  readonly empty: boolean;
  readonly map_available: boolean;
  readonly mileage_status: MileageView['mileageStatus'];
  readonly no_mileage_label: boolean;
  readonly normal_length_m: number | null;
  readonly normal_section_count: number;
  readonly normal_section_ids: readonly string[];
  readonly operated_section_count: number;
  readonly retired_length_m: number | null;
  readonly retired_section_count: number;
  readonly retired_section_ids: readonly string[];
  readonly retired_topology_date: string | null;
  readonly route_available: boolean;
  readonly statistics_basis: MileageView['statisticsBasis'];
  readonly temporary_section_count: number;
}

export function isDateView(view: unknown): view is DateView;

export function closureForSection(section: DateViewSectionRef, network: TransitNetwork, onDate: string):
  TransitNetwork['policies']['closures'][number] | undefined;
export function statisticalSections(network: TransitNetwork, onDate: string): TransitNetwork['sections'][number][];
export function serviceDateForSection(section: TransitNetwork['sections'][number], network: TransitNetwork, onDate: string): string;

export function sectionStatus(
  section: DateViewSectionRef,
  network: TransitNetwork,
  onDate: string,
): SectionStatusView;

/** 当日真正按折叠环处理的线路；任一闭环区间永久关闭时返回 null（按普通线路处理）。 */
export function effectiveFoldedLoop(network: TransitNetwork, lineId: string, onDate: string): FoldedLoop | null;

export function mileage(
  network: TransitNetwork,
  sections: readonly TransitNetwork['sections'][number][],
): MileageView;

export function buildDateView(network: TransitNetwork, request: DateViewRequest): DateView;

export function observation(view: DateView): DateViewObservation;
