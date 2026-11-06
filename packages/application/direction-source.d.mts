import type { Direction, TransitNetwork } from './reader.mjs';

/**
 * 业务日期上该运营服务的有效方向标签来源。
 *
 * 服务自身有标签时返回服务标签（不因不可用而降级）；否则只有当日成员区间全部落在
 * 同一条物理线路时返回该线路标签；其余情况返回空数组。
 */
export function serviceDirectionLabels(
  network: TransitNetwork,
  serviceId: string,
  onDate: string,
): readonly Direction[];
