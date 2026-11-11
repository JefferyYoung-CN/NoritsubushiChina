import { active } from './validation.mjs';

/**
 * 方向标签来源。
 *
 * 服务自身配了标签就用服务标签，即使标签不可用也不降级改用物理线路标签，避免同一环线
 * 出现两套名字；服务没配标签时，只有当日成员区间全部落在同一条物理线路时才用该线路的
 * 标签。服务、成员关系、区间、物理线路四层都要在业务日期内，与 `serviceCycle` 同口径。
 *
 * 抽成共享纯函数：页面只负责把标签映射成显示选项，导入侧的一致性检查也从这里取选源
 * 规则，两处不再各写一份。
 */
export function serviceDirectionLabels(network, serviceId, onDate) {
  const service = network.services.find(row => row.id === serviceId);
  if (!service || !active(service, onDate)) return [];
  if (service.directions.length > 0) return service.directions;
  const lineIds = new Set();
  for (const membership of network.memberships) {
    if (membership.serviceId !== serviceId || !active(membership, onDate)) continue;
    // 失效的成员关系、区间或线路都不算数：既不能贡献标签，也不能把服务算成跨线。
    const section = network.sections.find(row => row.id === membership.sectionId);
    if (!section || !active(section, onDate)) continue;
    const line = network.lines.find(row => row.id === section.lineId);
    if (!line || !active(line, onDate)) continue;
    lineIds.add(line.id);
  }
  if (lineIds.size !== 1) return [];
  const line = network.lines.find(row => row.id === [...lineIds][0]);
  return line ? line.directions : [];
}
