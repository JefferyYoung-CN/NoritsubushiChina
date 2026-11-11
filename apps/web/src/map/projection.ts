/**
 * WGS-84 经纬度到 SVG 屏幕坐标的纯投影。
 *
 * 无底图取舍（计划 D1）：本机离线、npm 不可达，Leaflet/MapLibre 装不上；OSM 数据许可
 * 也不授予公共瓦片访问权。因此地图只画 SVG 点线示意，不画任何底图、陆地轮廓、经纬网格
 * 或推测形状——没有数据支撑的图形一律不画，避免被误读成真实地理。投影因此必须自实现，
 * 并保持纯函数，供组件、单元测试与后续图片导出复用同一套换算。
 *
 * 坐标约定：屏幕 y 轴向下，因此纬度越高屏幕 y 越小（北在上）；经度越大 x 越大（东在右）。
 * Web Mercator 在极区不可用，纬度按 {@link MERCATOR_MAX_LATITUDE} 截断；等距圆柱不截断。
 */
export type ProjectionKind = 'mercator' | 'equirectangular';

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** 投影原始平面坐标：mercator 为墨卡托 y，等距圆柱为弧度高。 */
export interface RawPoint {
  readonly x: number;
  readonly y: number;
}

export interface Viewport {
  /** SVG viewBox 宽（像素）。 */
  readonly width: number;
  /** SVG viewBox 高（像素）。 */
  readonly height: number;
  /** 内容到 viewBox 边缘的最小留白，必须小于宽高的一半。 */
  readonly padding: number;
}

export interface ProjectionFrame {
  readonly kind: ProjectionKind;
  /** 每弧度的像素数；经纬方向使用同一比例，保证形状不变形。 */
  readonly scale: number;
  /** 原始坐标平面上的数据中心。 */
  readonly center: RawPoint;
  readonly width: number;
  readonly height: number;
  /** 跨 180° 经线时为 360：把负经度平移 +360° 后再取范围，避免绕地球一圈。 */
  readonly longitudeShift: 0 | 360;
}

const RADIANS_PER_DEGREE = Math.PI / 180;
const DEGREES_PER_RADIAN = 180 / Math.PI;
/** Web Mercator 有效纬度上界；超过即截断，不做静默外推。 */
export const MERCATOR_MAX_LATITUDE = 85.0511287798066;
/** 单点或退化范围时使用的固定视窗跨度（弧度），约 0.57°，保证比例有限且确定。 */
const DEGENERATE_SPAN_RADIANS = 0.01;

export function clampLatitude(kind: ProjectionKind, latitude: number): number {
  return kind === 'mercator'
    ? Math.min(MERCATOR_MAX_LATITUDE, Math.max(-MERCATOR_MAX_LATITUDE, latitude))
    : latitude;
}

/** 把经度按平移量折算到连续区间，供跨 180° 经线的数据取范围。 */
export function wrapLongitude(longitude: number, shift: 0 | 360): number {
  return shift === 360 && longitude < 0 ? longitude + 360 : longitude;
}

/** 经度归一化到 [-180, 180)。 */
export function normalizeLongitude(longitude: number): number {
  const wrapped = ((longitude + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** 若经度跨度超过 180°，说明数据跨 180° 经线，需要平移半个地球后再取范围。 */
export function chooseLongitudeShift(points: readonly GeoPoint[]): 0 | 360 {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.longitude < min) min = point.longitude;
    if (point.longitude > max) max = point.longitude;
  }
  return max - min > 180 ? 360 : 0;
}

export function rawPoint(kind: ProjectionKind, point: GeoPoint, longitudeShift: 0 | 360 = 0): RawPoint {
  const latitude = clampLatitude(kind, point.latitude);
  const x = wrapLongitude(point.longitude, longitudeShift) * RADIANS_PER_DEGREE;
  const y = kind === 'mercator'
    ? Math.log(Math.tan(Math.PI / 4 + latitude * RADIANS_PER_DEGREE / 2))
    : latitude * RADIANS_PER_DEGREE;
  return { x, y };
}

export function unrawPoint(kind: ProjectionKind, raw: RawPoint): GeoPoint {
  const latitude = kind === 'mercator'
    ? (2 * Math.atan(Math.exp(raw.y)) - Math.PI / 2) * DEGREES_PER_RADIAN
    : raw.y * DEGREES_PER_RADIAN;
  return { latitude, longitude: normalizeLongitude(raw.x * DEGREES_PER_RADIAN) };
}

/**
 * 按数据实际范围计算 fit 后的投影。范围来自传入的全部点，因此跨市、跨制式或
 * 经度跨 180° 的数据都会自动缩放，不依赖写死的线网经纬度框。
 *
 * 宽高与内边距非法时抛 RangeError：静默兜底会把错误比例画成“看起来对”的地图。
 */
export function createProjection(
  points: readonly GeoPoint[],
  viewport: Viewport,
  options: Readonly<{ kind?: ProjectionKind }> = {},
): ProjectionFrame | null {
  if (points.length === 0) return null;
  const { width, height, padding } = viewport;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError('E_VIEWPORT：地图视口宽高必须为正数');
  }
  if (!Number.isFinite(padding) || padding < 0 || padding * 2 >= width || padding * 2 >= height) {
    throw new RangeError('E_VIEWPORT：内边距必须非负且小于视口宽高的一半');
  }
  const kind = options.kind ?? 'mercator';
  const longitudeShift = chooseLongitudeShift(points);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const raw = rawPoint(kind, point, longitudeShift);
    if (raw.x < minX) minX = raw.x;
    if (raw.x > maxX) maxX = raw.x;
    if (raw.y < minY) minY = raw.y;
    if (raw.y > maxY) maxY = raw.y;
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const availableWidth = width - padding * 2;
  const availableHeight = height - padding * 2;
  const scaleFromX = spanX > 0 ? availableWidth / spanX : Number.POSITIVE_INFINITY;
  const scaleFromY = spanY > 0 ? availableHeight / spanY : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleFromX, scaleFromY);
  return {
    kind,
    scale: Number.isFinite(scale) ? scale : Math.min(availableWidth, availableHeight) / DEGENERATE_SPAN_RADIANS,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    width,
    height,
    longitudeShift,
  };
}

export function project(frame: ProjectionFrame, point: GeoPoint): ScreenPoint {
  const raw = rawPoint(frame.kind, point, frame.longitudeShift);
  return {
    x: frame.width / 2 + (raw.x - frame.center.x) * frame.scale,
    y: frame.height / 2 - (raw.y - frame.center.y) * frame.scale,
  };
}

/** project 的逆运算；跨 180° 经线的点会归一化回 [-180, 180)，往返测试依赖这一点。 */
export function unproject(frame: ProjectionFrame, screen: ScreenPoint): GeoPoint {
  return unrawPoint(frame.kind, {
    x: frame.center.x + (screen.x - frame.width / 2) / frame.scale,
    y: frame.center.y - (screen.y - frame.height / 2) / frame.scale,
  });
}
