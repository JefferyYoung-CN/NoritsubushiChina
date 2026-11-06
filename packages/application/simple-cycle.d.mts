import type { TransitNetwork } from './reader.mjs';

/** 运营服务当日的一条成员区间；按服务运行序（memberships.sequence 升序）给出。 */
export interface ServiceMember {
  readonly sectionId: string;
  readonly fromStationId: string;
  readonly toStationId: string;
}

export interface SimpleCycle {
  /** 正序站序：长度等于区间数，不重复起始站。 */
  readonly forward: readonly string[];
  /** 反序站序：与 forward 同起点，反向走行。 */
  readonly reverse: readonly string[];
  /** 与 forward 对齐：sectionIds[i] 连接 forward[i] 与 forward[i + 1]，末项接回 forward[0]。 */
  readonly sectionIds: readonly string[];
}

export function simpleCycle(members: readonly ServiceMember[]): SimpleCycle | null;
export function serviceCycle(network: TransitNetwork, serviceId: string, onDate: string): SimpleCycle | null;
