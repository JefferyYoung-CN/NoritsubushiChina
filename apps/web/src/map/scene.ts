import { sectionStatus } from '../../../../packages/application/date-view.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { placeLabels, type PlacedLabel } from './label-placement';
import {
  createProjection,
  project,
  type ProjectionFrame,
  type ProjectionKind,
  type ScreenPoint,
} from './projection';
import { buildStationLabels } from './station-label';
import type { MapSectionInput, MapStationInput, SectionStatus } from './types';

/**
 * 把网络数据整理成可直接渲染的场景：只做投影、状态推导与标签布局，不接触 DOM。
 *
 * 无底图取舍（计划 D1）：仓库不引入 Leaflet/MapLibre 等依赖，也没有瓦片服务，因此
 * 这里只把站点坐标投影到屏幕并直连区间端点。区间形状是两点直线，不是真实线路走向；
 * 图上必须显示这一限制，避免被误读为地理精度示意。
 *
 * 状态判定直接复用 date-view.mjs 的 sectionStatus（closure → retired、
 * suspension → temporary、否则 operated），组件侧不再复制一份策略实现；
 * buildDateView 仍是业务日期视图的权威实现，这里用状态排除废线并区分运营/临时停运。
 */
export interface BuildSceneInput {
  readonly network: TransitNetwork;
  readonly onDate: string;
  /** 显式站点子集（例如日期视图筛选结果）；缺省用全网站点。 */
  readonly stations?: readonly MapStationInput[];
  /** 显式区间子集；缺省用全网区间并按 onDate 推导状态。 */
  readonly sections?: readonly MapSectionInput[];
  readonly highlightStationId?: string | null;
  readonly highlightSectionIds?: readonly string[];
  readonly selectedStationId?: string | null;
  readonly width: number;
  readonly height: number;
  readonly padding?: number;
  readonly projection?: ProjectionKind;
}

export interface SceneStation {
  readonly id: string;
  readonly label: string;
  readonly point: ScreenPoint;
  readonly selected: boolean;
  readonly highlighted: boolean;
}

export interface SceneSection {
  readonly id: string;
  readonly status: Exclude<SectionStatus, 'retired'>;
  readonly from: ScreenPoint;
  readonly to: ScreenPoint;
  readonly highlighted: boolean;
}

export interface ReadyMapScene {
  readonly available: true;
  readonly frame: ProjectionFrame;
  readonly stations: readonly SceneStation[];
  readonly sections: readonly SceneSection[];
  readonly labels: readonly PlacedLabel[];
  readonly hiddenLabelIds: readonly string[];
}

export interface UnavailableMapScene {
  readonly available: false;
  /** empty：没有站点；missing-coordinate：有站点缺坐标。两者都不画图，只给文字说明。 */
  readonly reason: 'empty' | 'missing-coordinate';
  readonly stationCount: number;
  readonly missingStationIds: readonly string[];
  readonly message: string;
}

export type MapScene = ReadyMapScene | UnavailableMapScene;

const isUsableCoordinate = (value: number | null, limit: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

/** 按业务日期取站名：取生效期覆盖当日、且起始最晚的一条；没有则回退当前站名。 */
function stationNameAt(network: TransitNetwork, stationId: string, onDate: string): string | null {
  let match: { from: string; name: string } | null = null;
  for (const record of network.names) {
    if (record.stationId !== stationId) continue;
    if (record.from > onDate) continue;
    if (record.until !== null && record.until <= onDate) continue;
    if (match === null || record.from > match.from) match = { from: record.from, name: record.name };
  }
  return match?.name ?? null;
}

export function deriveSectionStatus(
  section: Readonly<{ id: string; lineId: string }>,
  network: TransitNetwork,
  onDate: string,
): SectionStatus {
  return sectionStatus(section, network, onDate).status;
}

export function deriveStations(network: TransitNetwork, onDate: string): readonly MapStationInput[] {
  return network.stations.map(station => ({
    id: station.id,
    latitude: station.latitude,
    longitude: station.longitude,
    name: stationNameAt(network, station.id, onDate) ?? station.name,
  }));
}

export function deriveSections(network: TransitNetwork, onDate: string): readonly MapSectionInput[] {
  return network.sections.map(section => ({
    id: section.id,
    lineId: section.lineId,
    fromStationId: section.fromStationId,
    toStationId: section.toStationId,
    status: deriveSectionStatus(section, network, onDate),
  }));
}

const unavailable = (
  reason: UnavailableMapScene['reason'],
  stationCount: number,
  missingStationIds: readonly string[],
  message: string,
): UnavailableMapScene => ({ available: false, reason, stationCount, missingStationIds, message });

export function buildMapScene(input: BuildSceneInput): MapScene {
  const { network, onDate, width, height } = input;
  const padding = input.padding ?? 24;
  const stations = input.stations ?? deriveStations(network, onDate);
  const sections = input.sections ?? deriveSections(network, onDate);

  if (stations.length === 0) {
    return unavailable('empty', 0, [], '当前范围没有可展示的车站，无法绘制地图。');
  }

  const missing = stations.filter(
    station => !isUsableCoordinate(station.latitude, 90) || !isUsableCoordinate(station.longitude, 180),
  );
  if (missing.length > 0) {
    // 缺坐标绝不用 0,0 或本地兜底坐标补位：补出来的位置会误导阅读，宁可不画。
    return unavailable(
      'missing-coordinate',
      stations.length,
      missing.map(station => station.id),
      `有 ${missing.length} 个车站缺少可信的经纬度坐标，地图已关闭，改用列表查看。`,
    );
  }

  const coordinates = stations.map(station => ({
    latitude: station.latitude as number,
    longitude: station.longitude as number,
  }));
  const frame = createProjection(
    coordinates,
    { width, height, padding },
    input.projection ? { kind: input.projection } : undefined,
  );
  if (frame === null) {
    return unavailable('empty', 0, [], '当前范围没有可展示的车站，无法绘制地图。');
  }

  const nameOverrides = new Map<string, string>();
  for (const station of stations) if (station.name) nameOverrides.set(station.id, station.name);
  const labels = buildStationLabels(network, nameOverrides);

  const highlightSectionIds = new Set(input.highlightSectionIds ?? []);
  const stationById = new Map(stations.map((station, index) => [station.id, { station, point: project(frame, coordinates[index]) }]));

  const sceneStations: SceneStation[] = [...stationById.entries()]
    .map(([id, entry]) => ({
      id,
      label: labels.get(id) ?? entry.station.name ?? id,
      point: entry.point,
      selected: input.selectedStationId === id,
      highlighted: input.highlightStationId === id,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const sceneSections: SceneSection[] = [];
  for (const section of sections) {
    const status = section.status ?? deriveSectionStatus({ id: section.id, lineId: section.lineId }, network, onDate);
    // 废线只在统计展示；显式输入与全网推导都遵循同一地图边界。
    if (status === 'retired') continue;
    const from = stationById.get(section.fromStationId);
    const to = stationById.get(section.toStationId);
    // 端点不在当前站点子集里的区间无法落点，直接略过而不是画到图外。
    if (!from || !to) continue;
    sceneSections.push({
      id: section.id,
      status,
      from: from.point,
      to: to.point,
      highlighted: highlightSectionIds.has(section.id),
    });
  }

  const placement = placeLabels(
    sceneStations.map(station => ({
      id: station.id,
      text: station.label,
      x: station.point.x,
      y: station.point.y,
      rank: station.selected ? 0 : station.highlighted ? 1 : 2,
      pointRadius: station.selected || station.highlighted ? 5.5 : 4,
    })),
    { width, height, padding },
  );

  return {
    available: true,
    frame,
    stations: sceneStations,
    sections: sceneSections,
    labels: placement.placed,
    hiddenLabelIds: placement.hidden,
  };
}
