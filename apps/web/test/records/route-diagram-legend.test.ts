import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import RouteDiagram from '../../src/records/RouteDiagram.vue';
import RouteDiagramLegend from '../../src/records/RouteDiagramLegend.vue';
import { SECTION_PAINT, SELECTED_RING } from '../../src/records/section-paint';
import { STATION_PAINT, STATION_RING } from '../../src/records/station-paint';
import { LEGEND_STORAGE_KEY } from '../../src/records/legend-state';

const wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => { localStorage.clear(); });
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });
function render(loop = false) {
  const wrapper = mount(RouteDiagramLegend, { props: { loop } });
  wrappers.push(wrapper);
  return wrapper;
}
const labelsOf = (wrapper: ReturnType<typeof render>, group?: string): string[] =>
  wrapper.findAll(`${group ? `[data-legend-group="${group}"] ` : ''}[data-legend-item] .legend__label`)
    .map(node => node.text());

describe('图例项数与分组', () => {
  test('非环线固定 8 项，分区间 / 车站两组', () => {
    const wrapper = render();
    expect(wrapper.findAll('[data-legend-item]')).toHaveLength(8);
    expect(wrapper.findAll('[data-legend-group]').map(node => node.attributes('data-legend-group')))
      .toEqual(['sections', 'stations']);
    expect(labelsOf(wrapper, 'sections')).toEqual(['已乘坐', '未乘坐', '临时停运', '本次所选']);
    expect(labelsOf(wrapper, 'stations')).toEqual(['车站', '出发站', '到达站', '不可选车站']);
    // 「标注」两项按维护者反馈移除：图上本身就是文字。
    expect(wrapper.find('[data-legend-group="annotations"]').exists()).toBe(false);
  });

  test('环线没有「不可选车站」，共 7 项', () => {
    const wrapper = render(true);
    expect(wrapper.findAll('[data-legend-item]')).toHaveLength(7);
    expect(wrapper.find('[data-legend-item="unreachable"]').exists()).toBe(false);
    expect(labelsOf(wrapper, 'stations')).toEqual(['车站', '出发站', '到达站']);
    expect(labelsOf(wrapper, 'sections')).toHaveLength(4);
  });

  test('区间样张与图上同色同线宽：未乘坐蓝细线、已乘坐灰粗线、停运两段虚线', () => {
    const wrapper = render();
    const completed = wrapper.get('[data-legend-item="completed"] .legend__line line');
    expect(completed.attributes('stroke')).toBe(SECTION_PAINT.completed.stroke);
    expect(completed.attributes('stroke-dasharray')).toBeUndefined();
    expect(Number(completed.attributes('stroke-width'))).toBe(SECTION_PAINT.completed.width);
    const unridden = wrapper.get('[data-legend-item="unridden"] .legend__line line');
    expect(unridden.attributes('stroke')).toBe(SECTION_PAINT.unridden.stroke);
    expect(Number(unridden.attributes('stroke-width'))).toBe(SECTION_PAINT.unridden.width);
    expect(SECTION_PAINT.completed.width).toBeGreaterThan(SECTION_PAINT.unridden.width);
    // 停运样张左右两段分别说明「已乘坐灰虚线 / 未乘坐蓝虚线」。
    const suspended = wrapper.get('[data-legend-item="suspended"] .legend__line');
    expect(suspended.get('.legend__line-ridden').attributes('stroke')).toBe(SECTION_PAINT.completed.stroke);
    expect(suspended.get('.legend__line-unridden').attributes('stroke')).toBe(SECTION_PAINT.unridden.stroke);
    expect(suspended.get('.legend__line-ridden').attributes('stroke-dasharray')).toBe(SECTION_PAINT.suspended.dash);
    expect(suspended.get('.legend__line-unridden').attributes('stroke-dasharray')).toBe(SECTION_PAINT.suspended.dash);
    // 未乘坐的蓝必须与到达站圆圈同一色值（用户要求「和到达站圆圈一样的蓝色」）。
    expect(SECTION_PAINT.unridden.stroke).toBe(STATION_PAINT.to.stroke);
  });

  test('图例只解释编码，不显示站数或区间数摘要', () => {
    const wrapper = render();
    expect(wrapper.text()).not.toMatch(/\d+\s*(站|个区间)/);
    expect(wrapper.text()).not.toContain('共');
  });

  test('车站样张与图上车站共用 station-paint.ts 的同一组值（防再次漂移）', () => {
    const legend = render();
    const sample = (id: string) => legend.get(`[data-legend-item="${id}"] .legend__station`);
    const pairs = [['origin', 'from'], ['destination', 'to'], ['unreachable', 'unreachable'], ['normal', 'normal']] as const;
    for (const [id, state] of pairs) {
      const circle = sample(id).get('circle');
      expect(circle.attributes('fill')).toBe(STATION_PAINT[state].fill);
      expect(circle.attributes('stroke')).toBe(STATION_PAINT[state].stroke);
      expect(circle.attributes('stroke-width')).toBe(String(STATION_PAINT[state].strokeWidth));
    }
    expect(sample('destination').get('.legend__station-ring').attributes('stroke')).toBe(STATION_RING.stroke);
    expect(sample('destination').get('.legend__station-ring').attributes('stroke-width')).toBe(String(STATION_RING.strokeWidth));
    expect(sample('unreachable').attributes('opacity')).toBe(String(STATION_PAINT.unreachable.opacity));

    const diagram = mount(RouteDiagram, { props: {
      positions: [
        { positionKey: 'A', label: '甲', drawsPoint: true, segmentIndex: 0, arm: 'spine' as const, state: 'from' as const },
        { positionKey: 'B', label: '乙', drawsPoint: true, segmentIndex: 0, arm: 'spine' as const, state: 'to' as const },
        { positionKey: 'C', label: '丙', drawsPoint: true, segmentIndex: 0, arm: 'spine' as const, state: 'unreachable' as const },
        { positionKey: 'D', label: '丁', drawsPoint: true, segmentIndex: 0, arm: 'spine' as const, state: 'normal' as const },
      ],
      sections: [{ sectionId: 's1', fromPositionKey: 'A', toPositionKey: 'B' },
        { sectionId: 's2', fromPositionKey: 'B', toPositionKey: 'C' },
        { sectionId: 's3', fromPositionKey: 'C', toPositionKey: 'D' }],
      segments: [{ index: 0, positionKeys: ['A', 'B', 'C', 'D'] }], arms: [], gaps: [], width: 900 } });
    try {
      const diagramPairs = [['A', 'from'], ['B', 'to'], ['C', 'unreachable'], ['D', 'normal']] as const;
      for (const [key, state] of diagramPairs) {
        const circle = diagram.get(`[data-position-key="${key}"] .station-point`);
        expect(circle.attributes('fill')).toBe(STATION_PAINT[state].fill);
        expect(circle.attributes('stroke')).toBe(STATION_PAINT[state].stroke);
        expect(circle.attributes('stroke-width')).toBe(String(STATION_PAINT[state].strokeWidth));
      }
      expect(diagram.get('[data-position-key="C"]').attributes('opacity')).toBe(String(STATION_PAINT.unreachable.opacity));
      const ring = diagram.get('[data-position-key="B"] .station-ring');
      expect(ring.attributes('stroke')).toBe(STATION_RING.stroke);
      expect(ring.attributes('stroke-width')).toBe(String(STATION_RING.strokeWidth));
      expect(ring.attributes('r')).toBe(String(STATION_RING.radius));
    } finally {
      diagram.unmount();
    }
  });

  test('本次所选样张的画布能完整容纳 13 宽外圈，线心居中', () => {
    const wrapper = render();
    const svg = wrapper.get('[data-legend-item="selected"] .legend__line');
    const height = Number(svg.attributes('height'));
    const outer = svg.get('.legend__ring-outer');
    expect(height).toBeGreaterThanOrEqual(SELECTED_RING.outer.width + 4);
    expect(Number(outer.attributes('y1'))).toBe(height / 2);
    expect(Number(outer.attributes('stroke-width'))).toBe(SELECTED_RING.outer.width);
  });
});

describe('前三次自动展开与本地计数', () => {
  const mountOnce = (loop = false) => mount(RouteDiagramLegend, { props: { loop } });

  test('前三次进入自动展开并提示，第四次起收起为「图例」按钮', async () => {
    for (let visit = 1; visit <= 3; visit += 1) {
      const wrapper = mountOnce();
      expect(wrapper.find('.legend__panel').exists()).toBe(true);
      expect(wrapper.get('.legend__hint').text()).toContain('以后点「图例」可再看');
      wrapper.unmount();
    }
    expect(localStorage.getItem(LEGEND_STORAGE_KEY)).toBe('3');

    const wrapper = render();
    expect(wrapper.find('.legend__panel').exists()).toBe(false);
    expect(wrapper.get('.legend__toggle').text()).toBe('图例');
    await wrapper.get('.legend__toggle').trigger('click');
    expect(wrapper.find('.legend__panel').exists()).toBe(true);
    // 自动展开那一轮的提示只在自动展开时出现。
    expect(wrapper.find('.legend__hint').exists()).toBe(false);
    await wrapper.get('.legend__toggle').trigger('click');
    expect(wrapper.find('.legend__panel').exists()).toBe(false);
  });

  test('次数持久化在浏览器本地：换一个实例仍按已进入次数收起', () => {
    localStorage.setItem(LEGEND_STORAGE_KEY, '3');
    const wrapper = render();
    expect(wrapper.find('.legend__panel').exists()).toBe(false);
  });

  test('点开与收起图例不改变本地记录的进入次数', async () => {
    localStorage.setItem(LEGEND_STORAGE_KEY, '3');
    const wrapper = render();
    // 进入一次只记一次；之后的开合都不再改变计数。
    expect(localStorage.getItem(LEGEND_STORAGE_KEY)).toBe('4');
    await wrapper.get('.legend__toggle').trigger('click');
    expect(localStorage.getItem(LEGEND_STORAGE_KEY)).toBe('4');
    await wrapper.get('.legend__toggle').trigger('click');
    expect(localStorage.getItem(LEGEND_STORAGE_KEY)).toBe('4');
  });

  test('存储不可用时按首次进入展开且不抛错', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('E_STORAGE'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('E_STORAGE'); });
    try {
      const wrapper = render();
      expect(wrapper.find('.legend__panel').exists()).toBe(true);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
