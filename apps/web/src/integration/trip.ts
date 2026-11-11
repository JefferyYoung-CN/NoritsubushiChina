/**
 * 单次乘车视图的构建（记录/图片/进阶三个视图共用）。
 *
 * `buildDateView` 对不可办客/多径路/超知识范围都会抛带码错误；这里把它们收成可展示的
 * 结果，避免每次输入都让 App 崩溃。纯函数，便于纯逻辑测试。
 */
import { buildDateView } from '../../../../packages/application/date-view.mjs';
import type { DateView } from '../../../../packages/application/date-view.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { active } from '../../../../packages/application/validation.mjs';
import { buildStationLabels } from '../records/labels';

export interface TripRequest {
  readonly onDate: string;
  readonly fromStationId: string;
  readonly toStationId: string;
  readonly serviceLineId: string;
}

export type TripResult =
  | { readonly ok: true; readonly view: DateView }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function tripMessage(code: string): string {
  switch (code) {
    case 'E_PATH': return '所选起终点在该日期没有可办客的完整径路。';
    case 'E_MULTIPATH': return '该日期存在多条可能径路，无法确定唯一结果。';
    case 'E_SERVICE_ALIGN': return '该起终点不属于同一趟车（可能需要中途换乘），基础录入请分两次录入。';
    case 'E_DATE': return '日期超出已验证的业务知识范围。';
    case 'E_REFERENCE': return '所选线路或车站在该日期不可用。';
    default: return '无法构建当天的乘车视图。';
  }
}

export function buildTripView(network: TransitNetwork, request: TripRequest): TripResult {
  try {
    const view = buildDateView(network, { ...request }) as DateView;
    if (view.empty) return { ok: false, code: 'E_EMPTY', message: '该日期没有可用线路数据。' };
    return { ok: true, view };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code : 'E_UNKNOWN';
    return { ok: false, code, message: tripMessage(code) };
  }
}

/**
 * 运营服务没有 `lineId` 字段：线路身份经由 membership → section → line 得到。
 * 同一服务可能跨多条线路（直通），按当天有效的 membership 去重后保留顺序。
 */
function serviceLineNames(network: TransitNetwork, serviceId: string, onDate: string): readonly string[] {
  const names = new Set<string>();
  for (const membership of network.memberships) {
    if (membership.serviceId !== serviceId) continue;
    if (!active(membership, onDate)) continue;
    const section = network.sections.find(row => row.id === membership.sectionId);
    const line = section ? network.lines.find(row => row.id === section.lineId) : undefined;
    if (line) names.add(line.name);
  }
  return [...names];
}

/** 进阶面板的候选线路形状（与 advanced/chain 的 ServiceCandidate 结构一致，不反向依赖高级模块）。 */
export function serviceCandidates(network: TransitNetwork, onDate: string): readonly {
  readonly serviceLineId: string; readonly label: string; readonly operatorName: string; readonly lineNames: readonly string[];
}[] {
  return network.services
    .filter(service => active(service, onDate))
    .map(service => {
      const lineNames = serviceLineNames(network, service.id, onDate);
      const operator = network.operators.find(row => row.id === service.operatorId);
      return {
        serviceLineId: service.id,
        label: lineNames.length > 0 ? `${lineNames.join(' / ')} · ${service.name}` : service.name,
        operatorName: operator?.name ?? '',
        lineNames,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

/** 手动候选的副说明：城市 · 站码。只用于补充识别与检索，主文本仍是 display_label。 */
export function stationDescription(network: TransitNetwork, stationId: string): string {
  const station = network.stations.find(row => row.id === stationId);
  const city = network.cities.find(row => row.id === station?.cityId)?.name ?? station?.cityId ?? '';
  return [city, station?.code ?? stationId].filter(part => part.length > 0).join(' · ');
}

/**
 * 当日办客车站的候选（手动选站、按车站查找共用）。
 * 主文本是日期有效的 display_label（最小充分消歧），副说明保留「城市 · 站码」，
 * 因此按站名、城市、站码都仍可检索。
 */
export function stationOptions(network: TransitNetwork, onDate: string): readonly { id: string; label: string; description: string }[] {
  const labels = buildStationLabels(network, onDate);
  return network.stations
    .filter(station => network.passengerPeriods.some(period => period.stationId === station.id && period.kind === 'passenger' && active(period, onDate)))
    .map(station => ({ id: station.id, label: labels.get(station.id)?.label ?? station.name,
      description: stationDescription(network, station.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'));
}
