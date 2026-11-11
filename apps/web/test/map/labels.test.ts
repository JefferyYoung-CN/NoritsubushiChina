import { describe, expect, it } from 'vitest';
import { buildStationLabels, formatStationLabel, normalizeStationName } from '../../src/map/station-label';
import {
  type LabelCandidate,
  boxesOverlap,
  defaultMaxLabels,
  estimateTextWidth,
  placeLabels,
} from '../../src/map/label-placement';
import { makeStation, makeNetwork } from './fixtures';

describe('站名消歧', () => {
  it('同名但为拆分站时按各自目标身份加管理编号，不合并', () => {
    const network = makeNetwork({
      stations: [
        makeStation('s1', '新宿', 'SJK-A', 35.69, 139.7),
        makeStation('s2', '新宿', 'SJK-B', 35.69, 139.7),
        makeStation('s3', '東京', 'TYO', 35.68, 139.76),
      ],
    });
    const labels = buildStationLabels(network);
    // 城市与运营商都相同，只有管理编号能区分，因此只追加编号（其余字段不冗余追加）。
    expect(labels.get('s1')).toBe('新宿（SJK-A）');
    expect(labels.get('s2')).toBe('新宿（SJK-B）');
    expect(labels.get('s3')).toBe('東京');
  });

  it('日期站名覆盖参与同名分组，仍按目标身份消歧', () => {
    const network = makeNetwork({
      stations: [makeStation('s1', '新宿', 'A', 35.69, 139.7), makeStation('s2', '新宿', 'B', 35.69, 139.7)],
    });
    const labels = buildStationLabels(network, new Map([['s1', '新宿駅']]));
    expect(labels.get('s1')).toBe('新宿駅');
    expect(labels.get('s2')).toBe('新宿');
  });

  it('规范化站名忽略空白差异', () => {
    expect(normalizeStationName('新　宿')).toBe('新宿');
    expect(normalizeStationName(' 新 宿 ')).toBe('新宿');
    expect(formatStationLabel('新宿', [])).toBe('新宿');
    expect(formatStationLabel('新宿', ['A', 'B'])).toBe('新宿（A｜B）');
  });
});

describe('标签防重叠贪心占位', () => {
  const box = (id: string, x: number, y: number): LabelCandidate => ({
    id,
    text: id,
    x,
    y,
    rank: 2,
    pointRadius: 4,
  });

  it('同一点上的两个标签分居两侧，优先级最高的先占位', () => {
    const result = placeLabels([box('s2', 100, 100), { ...box('s1', 100, 100), rank: 0 }], {
      width: 600,
      height: 300,
      padding: 20,
    });
    expect(result.placed).toHaveLength(2);
    expect(result.placed[0].id).toBe('s1');
    expect(result.hidden).toEqual([]);
    // 同一点无法在东侧叠两个标签：第二个退到另一侧，框不重叠，优先级仍由排序保证。
    expect(boxesOverlap(result.placed[0].box, result.placed[1].box)).toBe(false);
    expect(result.placed[0].side).not.toBe(result.placed[1].side);
  });

  it('结果确定：同一输入两次布局完全一致', () => {
    const candidates = [box('s3', 120, 120), box('s1', 120, 120), box('s2', 400, 200)];
    const options = { width: 600, height: 300, padding: 20 };
    expect(placeLabels(candidates, options)).toEqual(placeLabels([...candidates].reverse(), options));
  });

  it('彼此远离的车站都能拿到标签且不与对方的框重叠', () => {
    const result = placeLabels([box('a', 100, 100), box('b', 480, 200)], { width: 600, height: 300, padding: 20 });
    expect(result.placed.map(label => label.id).sort()).toEqual(['a', 'b']);
    expect(boxesOverlap(result.placed[0].box, result.placed[1].box)).toBe(false);
    expect(result.hidden).toEqual([]);
  });

  it('标签框不越出内边距区域', () => {
    const result = placeLabels([box('edge', 590, 290)], { width: 600, height: 300, padding: 20 });
    for (const label of result.placed) {
      expect(label.box.left).toBeGreaterThanOrEqual(20);
      expect(label.box.top).toBeGreaterThanOrEqual(20);
      expect(label.box.right).toBeLessThanOrEqual(580);
      expect(label.box.bottom).toBeLessThanOrEqual(280);
    }
  });

  it('超过 maxLabels 的标签被隐藏而不是堆叠', () => {
    const candidates: LabelCandidate[] = [];
    for (let index = 0; index < 9; index += 1) {
      candidates.push(box(`s${index}`, 60 + (index % 3) * 180, 60 + Math.floor(index / 3) * 180));
    }
    const result = placeLabels(candidates, { width: 800, height: 600, padding: 20, maxLabels: 3 });
    expect(result.placed).toHaveLength(3);
    expect(result.hidden).toHaveLength(6);
  });

  it('空输入返回空结果', () => {
    expect(placeLabels([], { width: 390, height: 260, padding: 16 })).toEqual({ placed: [], hidden: [] });
  });
});

describe('文本宽度估算与默认上限', () => {
  it('全角字符比半角更宽', () => {
    expect(estimateTextWidth('東京', 11)).toBeGreaterThan(estimateTextWidth('AA', 11));
    expect(estimateTextWidth('', 11)).toBe(0);
  });

  it('窄屏下的默认标签数有上下界', () => {
    const value = defaultMaxLabels(390, 260, 16);
    expect(value).toBeGreaterThanOrEqual(8);
    expect(value).toBeLessThanOrEqual(80);
  });

  it('碰撞检测的边界语义：相邻不重叠，相交才算重叠', () => {
    const left = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(boxesOverlap(left, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
    expect(boxesOverlap(left, { left: 9, top: 0, right: 20, bottom: 10 })).toBe(true);
    expect(boxesOverlap(left, { left: 12, top: 0, right: 20, bottom: 10 }, 2)).toBe(false);
  });
});
