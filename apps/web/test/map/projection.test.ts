import { describe, expect, it } from 'vitest';
import {
  MERCATOR_MAX_LATITUDE,
  clampLatitude,
  createProjection,
  normalizeLongitude,
  project,
  unproject,
  wrapLongitude,
} from '../../src/map/projection';

const TOKYO = { latitude: 35.681236, longitude: 139.767125 };
const SHINJUKU = { latitude: 35.690921, longitude: 139.700258 };
const YOKOHAMA = { latitude: 35.443674, longitude: 139.637158 };
const VIEWPORT = { width: 640, height: 400, padding: 24 };

function expectClose(actual: number, expected: number, tolerance = 1e-6): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

describe('投影往返', () => {
  it('墨卡托投影往返回到原经纬度', () => {
    const frame = createProjection([TOKYO, SHINJUKU, YOKOHAMA], VIEWPORT)!;
    for (const point of [TOKYO, SHINJUKU, YOKOHAMA]) {
      const back = unproject(frame, project(frame, point));
      expectClose(back.latitude, point.latitude);
      expectClose(back.longitude, point.longitude);
    }
  });

  it('等距圆柱投影往返回到原经纬度', () => {
    const frame = createProjection([TOKYO, SHINJUKU, YOKOHAMA], VIEWPORT, { kind: 'equirectangular' })!;
    expect(frame.kind).toBe('equirectangular');
    for (const point of [TOKYO, SHINJUKU, YOKOHAMA]) {
      const back = unproject(frame, project(frame, point));
      expectClose(back.latitude, point.latitude);
      expectClose(back.longitude, point.longitude);
    }
  });

  it('高纬度在墨卡托投影下被截断到安全范围', () => {
    const frame = createProjection([{ latitude: 89, longitude: 0 }, { latitude: 60, longitude: 10 }], VIEWPORT)!;
    const screen = project(frame, { latitude: 89, longitude: 0 });
    expect(Number.isFinite(screen.x)).toBe(true);
    expect(Number.isFinite(screen.y)).toBe(true);
    expectClose(unproject(frame, screen).latitude, MERCATOR_MAX_LATITUDE, 1e-9);
    expect(clampLatitude('equirectangular', 89)).toBe(89);
    expect(clampLatitude('mercator', 89)).toBe(MERCATOR_MAX_LATITUDE);
  });
});

describe('自动 fit 边界', () => {
  it('所有点都落在内边距以内，且至少一侧贴边', () => {
    const frame = createProjection([TOKYO, SHINJUKU, YOKOHAMA], VIEWPORT)!;
    const screens = [TOKYO, SHINJUKU, YOKOHAMA].map(point => project(frame, point));
    for (const screen of screens) {
      expect(screen.x).toBeGreaterThanOrEqual(VIEWPORT.padding - 1e-6);
      expect(screen.x).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT.padding + 1e-6);
      expect(screen.y).toBeGreaterThanOrEqual(VIEWPORT.padding - 1e-6);
      expect(screen.y).toBeLessThanOrEqual(VIEWPORT.height - VIEWPORT.padding + 1e-6);
    }
    const xs = screens.map(screen => screen.x);
    const ys = screens.map(screen => screen.y);
    const touchedX =
      Math.abs(Math.min(...xs) - VIEWPORT.padding) < 1e-6 ||
      Math.abs(Math.max(...xs) - (VIEWPORT.width - VIEWPORT.padding)) < 1e-6;
    const touchedY =
      Math.abs(Math.min(...ys) - VIEWPORT.padding) < 1e-6 ||
      Math.abs(Math.max(...ys) - (VIEWPORT.height - VIEWPORT.padding)) < 1e-6;
    expect(touchedX || touchedY).toBe(true);
  });

  it('等距圆柱投影下同角度差在经、纬方向等长（横纵比例一致）', () => {
    const frame = createProjection(
      [
        { latitude: 0, longitude: 139 },
        { latitude: 10, longitude: 140 },
      ],
      { width: 640, height: 400, padding: 20 },
      { kind: 'equirectangular' },
    )!;
    const origin = project(frame, { latitude: 5, longitude: 139 });
    const east = project(frame, { latitude: 5, longitude: 140 });
    const north = project(frame, { latitude: 6, longitude: 139 });
    expectClose(east.x - origin.x, origin.y - north.y, 1e-6);
    expect(east.x - origin.x > 0).toBe(true);
    expect(Number.isFinite(frame.scale)).toBe(true);
  });

  it('内边距越大比例越小', () => {
    const tight = createProjection([TOKYO, YOKOHAMA], { width: 640, height: 400, padding: 0 })!;
    const loose = createProjection([TOKYO, YOKOHAMA], { width: 640, height: 400, padding: 40 })!;
    expect(loose.scale).toBeLessThan(tight.scale);
  });

  it('单点退化时落在画布中心且坐标有限', () => {
    const frame = createProjection([TOKYO], { width: 320, height: 200, padding: 16 })!;
    const screen = project(frame, TOKYO);
    expectClose(screen.x, 160, 1e-9);
    expectClose(screen.y, 100, 1e-9);
    expect(Number.isFinite(frame.scale)).toBe(true);
  });

  it('不同画布尺寸都会重新计算比例', () => {
    const small = createProjection([TOKYO, YOKOHAMA], { width: 390, height: 260, padding: 16 })!;
    const large = createProjection([TOKYO, YOKOHAMA], { width: 1280, height: 800, padding: 16 })!;
    expect(small.scale).toBeLessThan(large.scale);
    const screen = project(small, TOKYO);
    expect(screen.x).toBeLessThanOrEqual(390 - 16 + 1e-6);
  });
});

describe('异常与空输入', () => {
  it('空点集返回 null', () => {
    expect(createProjection([], VIEWPORT)).toBeNull();
  });

  it('非法画布尺寸或内边距抛 E_VIEWPORT', () => {
    expect(() => createProjection([TOKYO], { width: 0, height: 400, padding: 0 })).toThrow(/E_VIEWPORT/u);
    expect(() => createProjection([TOKYO], { width: 640, height: 400, padding: -1 })).toThrow(RangeError);
    expect(() => createProjection([TOKYO], { width: 640, height: 400, padding: 400 })).toThrow(RangeError);
  });
});

describe('跨日界线与经度处理', () => {
  it('跨越 ±180 时自动平移而非横穿整幅地图', () => {
    const points = [
      { latitude: 0, longitude: 170 },
      { latitude: 0, longitude: 179.9 },
      { latitude: 0, longitude: -179.9 },
    ];
    const frame = createProjection(points, { width: 400, height: 200, padding: 20 })!;
    expect(frame.longitudeShift).toBe(360);
    // 180° 两侧的两点只差 0.2°；有第三点固定整体跨度后，它们应只占画布一小段。
    // 若不平移，这两点会被当成相隔 359.8° 而拉满画布。
    const east = project(frame, points[1]);
    const west = project(frame, points[2]);
    expect(Math.abs(east.x - west.x)).toBeLessThan(40);
  });

  it('普通范围内不平移经度', () => {
    const frame = createProjection([TOKYO, YOKOHAMA], VIEWPORT)!;
    expect(frame.longitudeShift).toBe(0);
    expect(wrapLongitude(-170, 360)).toBe(190);
    expect(wrapLongitude(190, 360)).toBe(190);
    expect(normalizeLongitude(190)).toBe(-170);
    expect(normalizeLongitude(-190)).toBe(170);
    expect(normalizeLongitude(180)).toBe(180);
  });
});
