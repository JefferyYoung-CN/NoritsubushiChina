import { describe, expect, it } from 'vitest';
import {
  type BuildSceneInput,
  type ReadyMapScene,
  type UnavailableMapScene,
  buildMapScene,
  deriveSectionStatus,
  deriveSections,
  deriveStations,
} from '../../src/map/scene';
import { makeNetwork, makeStation, twoStationNetwork } from './fixtures';

const BASE = { onDate: '2024-04-01', width: 640, height: 400, padding: 24 };

// 断言“可渲染/禁用”之后再做类型收窄，测试断言本身一字未减。
function readyScene(input: BuildSceneInput): ReadyMapScene {
  const scene = buildMapScene(input);
  expect(scene.available).toBe(true);
  if (!scene.available) throw new Error(`期望可渲染场景，实际原因：${scene.reason}`);
  return scene;
}

function unavailableScene(input: BuildSceneInput): UnavailableMapScene {
  const scene = buildMapScene(input);
  expect(scene.available).toBe(false);
  if (scene.available) throw new Error('期望禁用态场景，实际可渲染');
  return scene;
}

describe('禁用态：缺坐标或没有站点', () => {
  it('没有站点时给出空状态说明，不画任何图形', () => {
    const scene = unavailableScene({ network: makeNetwork(), ...BASE });
    expect(scene.reason).toBe('empty');
    expect(scene.message).toContain('没有可展示的车站');
    expect('frame' in scene).toBe(false);
  });

  it('有站点缺经纬度时禁用地图并列出缺坐标的站', () => {
    const network = twoStationNetwork({
      latitudesLongitudes: [
        [35.681236, 139.767125],
        [null, null],
      ],
    });
    const scene = unavailableScene({ network, ...BASE });
    expect(scene.reason).toBe('missing-coordinate');
    expect(scene.missingStationIds).toEqual(['s2']);
    expect(scene.message).toContain('缺少可信的经纬度坐标');
    // 绝不伪造坐标：禁用态不产出任何投影或点位。
    expect('stations' in scene).toBe(false);
  });

  it('只有一个站缺坐标也会整体禁用，而不是跳过该站', () => {
    const network = makeNetwork({
      stations: [
        makeStation('s1', '東京', 'TYO', 35.68, 139.76),
        makeStation('s2', '新宿', 'SJK', null, 139.7),
        makeStation('s3', '渋谷', 'SBY', 35.65, 139.7),
      ],
    });
    const scene = unavailableScene({ network, ...BASE });
    expect(scene.missingStationIds).toEqual(['s2']);
  });
});

describe('可渲染场景', () => {
  it('两站一线：站点、区间与标签都落在画布内', () => {
    const scene = readyScene({ network: twoStationNetwork(), ...BASE });
    expect(scene.stations.map(station => station.id)).toEqual(['s1', 's2']);
    expect(scene.sections).toHaveLength(1);
    expect(scene.sections[0].status).toBe('operated');
    for (const station of scene.stations) {
      expect(station.point.x).toBeGreaterThanOrEqual(BASE.padding - 1e-6);
      expect(station.point.x).toBeLessThanOrEqual(BASE.width - BASE.padding + 1e-6);
      expect(station.point.y).toBeGreaterThanOrEqual(BASE.padding - 1e-6);
      expect(station.point.y).toBeLessThanOrEqual(BASE.height - BASE.padding + 1e-6);
    }
    expect(scene.labels.length).toBeGreaterThan(0);
    expect(scene.labels[0].text).toContain('東京');
  });

  it('没有区间时仍可显示车站点', () => {
    const scene = readyScene({ network: makeNetwork({ stations: [makeStation('s1', '東京', 'TYO', 35.68, 139.76)] }), ...BASE });
    expect(scene.sections).toEqual([]);
    expect(scene.stations).toHaveLength(1);
  });

  it('端点不在站点子集里的区间被丢弃，不画到图外', () => {
    const network = twoStationNetwork();
    const scene = readyScene({ network, ...BASE, stations: deriveStations(network, BASE.onDate).filter(station => station.id === 's1') });
    expect(scene.stations).toHaveLength(1);
    expect(scene.sections).toEqual([]);
  });

  it('拆分站按目标身份各自出点与标签', () => {
    const network = makeNetwork({
      stations: [makeStation('s1', '新宿', 'SJK-A', 35.69, 139.7), makeStation('s2', '新宿', 'SJK-B', 35.6, 139.7)],
    });
    const scene = readyScene({ network, ...BASE });
    expect(scene.stations).toHaveLength(2);
    const texts = scene.labels.map(label => label.text).sort();
    expect(texts).toEqual(['新宿（SJK-A）', '新宿（SJK-B）']);
  });

  it('同坐标的两个站各得一个标签，分居两侧不重叠', () => {
    const network = makeNetwork({
      stations: [makeStation('s1', '甲', 'A', 35.68, 139.76), makeStation('s2', '乙', 'B', 35.68, 139.76)],
    });
    const scene = readyScene({ network, ...BASE });
    expect(scene.labels).toHaveLength(2);
    expect(scene.hiddenLabelIds).toHaveLength(0);
    expect(scene.stations).toHaveLength(2);
    expect(scene.labels.map(label => label.id)).toEqual(['s1', 's2']);
  });

  it('选中与高亮标记随输入传递，供组件渲染非颜色状态', () => {
    const network = twoStationNetwork();
    const scene = readyScene({ network, ...BASE, selectedStationId: 's2', highlightStationId: 's1' });
    const selected = scene.stations.find(station => station.selected);
    const highlighted = scene.stations.find(station => station.highlighted);
    expect(selected?.id).toBe('s2');
    expect(highlighted?.id).toBe('s1');
  });
});

describe('区间状态推导（复用 date-view 的 sectionStatus）', () => {
  const section = { id: 'sec1', lineId: 'l1' };

  it('未命中停运/废线策略时为运营', () => {
    expect(deriveSectionStatus(section, twoStationNetwork(), '2024-04-01')).toBe('operated');
  });

  it('线路废线日期已到则为废线', () => {
    const network = twoStationNetwork({
      policies: { noMileageSections: [], closures: [{ lineId: 'l1', closedOn: '2020-01-01' }], suspensions: [] },
    });
    expect(deriveSectionStatus(section, network, '2024-04-01')).toBe('retired');
    expect(deriveSectionStatus(section, network, '2019-12-31')).toBe('operated');
    expect(readyScene({ network, ...BASE }).sections).toEqual([]);
    expect(readyScene({ network, ...BASE, onDate: '2019-12-31' }).sections).toHaveLength(1);
  });

  it('临时停运只在生效期内成立', () => {
    const network = twoStationNetwork({
      policies: {
        noMileageSections: [],
        closures: [],
        suspensions: [{ lineId: 'l1', sectionIds: ['sec1'], from: '2024-03-01', until: '2024-05-01' }],
      },
    });
    expect(deriveSectionStatus(section, network, '2024-04-01')).toBe('temporary');
    expect(deriveSectionStatus(section, network, '2024-06-01')).toBe('operated');
    expect(deriveSectionStatus(section, network, '2024-02-01')).toBe('operated');
  });

  it('deriveSections 把状态写进区间输入', () => {
    const network = twoStationNetwork({
      policies: { noMileageSections: [], closures: [{ lineId: 'l1', closedOn: '2020-01-01' }], suspensions: [] },
    });
    expect(deriveSections(network, '2024-04-01')[0]).toMatchObject({ id: 'sec1', status: 'retired' });
  });

  it('显式传入废线状态时同样不进入地图场景', () => {
    const network = twoStationNetwork();
    const scene = readyScene({
      network,
      ...BASE,
      sections: [{ id: 'sec1', lineId: 'l1', fromStationId: 's1', toStationId: 's2', status: 'retired' }],
    });
    expect(scene.sections).toEqual([]);
  });
});
