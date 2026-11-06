import type { SectionStatusName } from '../../../../packages/application/date-view.mjs';

/**
 * 地图组件与场景构建共享的输入契约。
 *
 * 站点与区间直接来自调用方的 props（日期视图或全网快照的子集），组件不访问
 * IndexedDB、不导入 Node 专用模块、不发网络请求，也不猜任何缺失坐标。
 */

/** 区间状态的唯一来源是 date-view；这里只做别名，避免两处各写一份联合类型。 */
export type SectionStatus = SectionStatusName;

export interface MapStationInput {
  /** station_id：不可变内部身份。拆分站按其目标身份各自出现，不合并回源站（ADR-0005 §4、ADR-0006）。 */
  readonly id: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  /** 历史/业务站名覆盖（日期视图按业务日期解析出的名称）；缺省用当前快照站名。 */
  readonly name?: string | null;
}

export interface MapSectionInput {
  readonly id: string;
  readonly lineId: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  /** 显式业务状态优先；缺省由网络停运/废线声明推导，仅供展示，buildDateView 仍是权威判定。 */
  readonly status?: SectionStatus;
}
