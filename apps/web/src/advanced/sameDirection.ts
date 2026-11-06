/**
 * 重复区间与「同向续圈」判定（进阶环线录入，票 10）。
 *
 * 一条记录里重复同一区间只允许一种情形：同一条简单环线服务沿同一方向继续坐
 * （整圈 × k + 末段同方向半圈）。折返（反向重复）必须另开一条记录。
 * 判定只读链上的 `runDirection` 元数据：它是链与界面的临时状态，不写进保存记录；
 * 因此本模块不查网络、不判拓扑，拓扑核验仍由日期视图按已存有序区间完成。
 */
import type { Leg } from './chain';

/**
 * 返回重复区间的拒绝文案；允许（未重复，或全部是同服务同方向续圈）时返回 null。
 * 之前用过这些区间的每一段都必须带同一个非空 `runDirection`，缺一个就按折返处理；
 * 非简单环线服务没有方向，因此它的重复区间一律被拒。
 */
export function repeatedSectionConflict(previous: readonly Leg[], leg: Leg): string | null {
  const repeated = leg.sectionIds.filter(id => previous.some(row => row.sectionIds.includes(id)));
  if (repeated.length === 0) return null;
  const used = new Set(repeated);
  const sameDirection = leg.runDirection !== null && leg.runDirection !== undefined
    && previous.filter(row => row.sectionIds.some(id => used.has(id)))
      .every(row => row.serviceLineId === leg.serviceLineId && row.runDirection === leg.runDirection);
  if (sameDirection) return null;
  return `径路重复经过区间 ${[...used].join('、')}：重复区间只允许同一条简单环线服务同向续圈；`
    + '折返（反向重复）不能写进同一条记录，请另开一条记录。';
}
