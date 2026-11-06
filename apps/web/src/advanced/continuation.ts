/**
 * 下一段接续候选（进阶链式录入，票 10）：显式维护的直通线路对 + 简单环线自直通。
 *
 * 简单环线服务默认与自身直通，不需要数据维护「环线→自身」线路对：回到环上任意站都
 * 可以继续坐同一趟车，方向沿用本段已选、不再询问。其它线路仍只认显式维护的线路对，
 * 不按共享车站或连通性推断；下车换乘另开一条记录（一次乘车 = 一条记录）。
 *
 * 纯函数：不读写存储、不碰 DOM；返回冻结值。`direction` 只用于沿用的方向与显示名，
 * 不进入保存记录。
 */
import { serviceCycle } from '../../../../packages/application/simple-cycle.mjs';
import type { RunDirection } from '../../../../packages/application/direction-plan.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { ChainError, serviceName, stationRef } from './chain';
import { directionOptions } from './directionOptions';
import { serviceEdges } from './serviceWalk';
import type { ChainDraft, ServiceCandidate, StationRef } from './chain';

export interface Continuation {
  readonly service: ServiceCandidate;
  /** 简单环线自直通：同一条服务继续坐，不出现方向步骤、不重新询问。 */
  readonly selfThrough: boolean;
  /**
   * 自直通要沿用的运行方向；null 表示自直通候选仍然存在（用户不能因为没有方向就被卡死），
   * 但本段没有可沿用的方向，界面**必须重新询问方向**，不能承诺「沿用本段已选」。
   */
  readonly direction: RunDirection | null;
  /** 方向显示名（如「外环」）；只供界面说明沿用方向，不进入保存记录。 */
  readonly directionLabel: string | null;
}

export interface ContinuationChoices {
  readonly fromStation: StationRef;
  readonly services: readonly Continuation[];
  readonly notices: readonly string[];
}

/** 该线路在该日期是否在站内有可用的出发区间；只看本站邻接区间，不要求先从别处“到达”。 */
function hasDeparture(network: TransitNetwork, serviceId: string, stationId: string, onDate: string): boolean {
  return serviceEdges(network, serviceId, onDate).some((edge) => edge.a === stationId || edge.b === stationId);
}

/**
 * 简单环线自直通候选：本段服务当日是简单环线、且当前到达站在环上。
 * `direction` 为 null 时（例如手工构造、未经方向步骤的环线段）仍给出候选，
 * 让「继续坐」这条唯一路径可用；此时由界面重新询问方向。
 */
function selfThroughCandidate(
  network: TransitNetwork,
  chain: ChainDraft,
  lastServiceId: string,
  stationId: string,
  direction: RunDirection | null,
): Continuation | null {
  const cycle = serviceCycle(network, lastServiceId, chain.onDate);
  if (!cycle || !cycle.forward.includes(stationId)) return null;
  const label = direction
    ? directionOptions(network, chain.onDate, cycle.forward, lastServiceId, stationId)
      .find((option) => option.direction === direction)?.label ?? null
    : null;
  return Object.freeze({
    service: serviceName(network, lastServiceId),
    selfThrough: true,
    direction,
    directionLabel: label,
  });
}

/** 下一段候选：显式维护的直通线路对 + 简单环线自直通；换乘不入链。 */
export function continuationServices(
  network: TransitNetwork,
  chain: ChainDraft,
  options: { readonly throughServicePairs?: readonly (readonly [string, string])[] },
): ContinuationChoices {
  const last = chain.legs[chain.legs.length - 1];
  if (!last) throw new ChainError('E_PATH', '请先完成第一段，再选择继续方式');
  const fromStation = stationRef(network, last.toStationId, chain.onDate);
  const notices: string[] = [];
  const candidates = new Map<string, Continuation>();
  // 简单环线默认与自身直通：同一条服务继续坐，方向沿用本段已选、不重新询问。
  const reachable = selfThroughCandidate(network, chain, last.serviceLineId, last.toStationId, last.runDirection ?? null);
  if (reachable) candidates.set(last.serviceLineId, reachable);
  const pairs = options.throughServicePairs ?? [];
  const linked = pairs.filter((pair) => pair.includes(last.serviceLineId))
    .map((pair) => (pair[0] === last.serviceLineId ? pair[1] : pair[0]));
  // 自直通已经给出候选时，不能再声称「未维护直通关系」。
  if (linked.length === 0 && candidates.size === 0) {
    notices.push('未维护该线路的直通关系；直通只认显式维护的线路对，不按连通性推断。');
  }
  for (const serviceId of new Set(linked)) {
    if (!hasDeparture(network, serviceId, fromStation.stationId, chain.onDate)) {
      notices.push(`直通关系 ${last.serviceLineId} → ${serviceId} 已维护，但该线路在 ${chain.onDate} 不经过本站或无可用区间。`);
      continue;
    }
    candidates.set(serviceId, Object.freeze({
      service: serviceName(network, serviceId), selfThrough: false, direction: null, directionLabel: null,
    }));
  }
  const services = [...candidates.values()]
    .sort((a, b) => a.service.serviceLineId.localeCompare(b.service.serviceLineId));
  if (services.length === 0) {
    notices.push('当前到达站没有可直通线路，如在本站下车可保存本条记录');
  }
  return Object.freeze({ fromStation, services: Object.freeze(services), notices: Object.freeze(notices) });
}
