import { afterEach, describe, expect, test, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import RouteDiagramPanel from '../../src/integration/RouteDiagramPanel.vue';
import type { RouteCompletion } from '../../src/integration/route-completion';
import { lookupNetwork, ON_DATE } from './fixtures';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  vi.restoreAllMocks();
});
const ready = (ids: readonly string[]): RouteCompletion => ({ kind: 'ready', message: '', completedSectionIds: [...ids] });
const UNAVAILABLE: RouteCompletion = { kind: 'unavailable', message: '完乘数据暂不可用，线路图按中性线显示；这不代表「未乘坐」。', completedSectionIds: [] };
function render(completion: RouteCompletion, selectedSectionIds: readonly string[] = [],
    network = lookupNetwork(), extra: Record<string, unknown> = {}) {
  const wrapper = mount(RouteDiagramPanel, { props: { network, onDate: ON_DATE, selectedLineId: 'L1',
    completion, selectedSectionIds, ...extra } });
  wrappers.push(wrapper);
  return wrapper;
}
const paintOf = (wrapper: ReturnType<typeof mount>, sectionId: string) => wrapper.get(`[data-section-id="${sectionId}"]`);
const statesOf = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.route-section-paint')
  .map(node => node.attributes('data-section-state'));

describe('线路图面板：着色、停运与本次所选', () => {
  test('完乘可用时按总体完乘并集上色，本次所选叠在完乘色之上', () => {
    const wrapper = render(ready(['sAB']), ['sAB', 'sBD']);
    expect(paintOf(wrapper, 'sAB').attributes('data-section-state')).toBe('completed');
    expect(paintOf(wrapper, 'sAB').get('.route-line').attributes('stroke')).toBe('#8a948d');
    expect(paintOf(wrapper, 'sAB').get('.route-line').attributes('stroke-width')).toBe('5');
    expect(paintOf(wrapper, 'sAB').get('.route-ring-outer').attributes('stroke-width')).toBe('13');
    expect(paintOf(wrapper, 'sBD').attributes('data-section-state')).toBe('unridden');
    expect(paintOf(wrapper, 'sBD').get('.route-ring-outer').attributes('stroke-width')).toBe('13');
    expect(paintOf(wrapper, 'sCD').attributes('data-section-state')).toBe('unridden');
    expect(paintOf(wrapper, 'sCD').attributes('data-section-selected')).toBeUndefined();
    expect(wrapper.find('.completion-note').exists()).toBe(false);
    expect(wrapper.find('.route-diagram svg').exists()).toBe(true);
  });

  test('临时停运优先：灰虚线，不叠完乘色也不叠本次所选外圈', () => {
    const base = lookupNetwork();
    const network = { ...base, policies: { ...base.policies,
      suspensions: [{ lineId: 'L1', sectionIds: ['sAB', 'sCD'], from: '2024-01-01', until: null }] } };
    const wrapper = render(ready(['sAB', 'sBD', 'sCD']), ['sAB', 'sBD'], network);
    const suspended = paintOf(wrapper, 'sAB');
    expect(suspended.attributes('data-section-state')).toBe('suspended');
    expect(suspended.attributes('data-section-selected')).toBeUndefined();
    expect(suspended.get('.route-line').attributes('stroke')).toBe('#8a948d');
    expect(suspended.get('.route-line').attributes('stroke-dasharray')).toBe('8 6');
    expect(suspended.find('.route-ring').exists()).toBe(false);
    expect(paintOf(wrapper, 'sBD').attributes('data-section-state')).toBe('completed');
    // 停运压过已乘坐：sCD 在完乘并集里，仍画停运虚线。
    expect(paintOf(wrapper, 'sCD').attributes('data-section-state')).toBe('suspended');
  });

  test('停运底色随乘坐状态：未乘坐蓝虚线、已乘坐灰虚线、完乘不可用时中性虚线', () => {
    const base = lookupNetwork();
    const network = { ...base, policies: { ...base.policies,
      suspensions: [{ lineId: 'L1', sectionIds: ['sAB', 'sBD'], from: '2024-01-01', until: null }] } };
    const readyWrapper = render(ready(['sAB', 'sCD']), [], network);
    expect(paintOf(readyWrapper, 'sAB').get('.route-line').attributes('stroke')).toBe('#8a948d');
    expect(paintOf(readyWrapper, 'sBD').get('.route-line').attributes('stroke')).toBe('#2f6fbf');
    expect(paintOf(readyWrapper, 'sBD').get('.route-line').attributes('stroke-dasharray')).toBe('8 6');
    readyWrapper.unmount();

    const unavailable = render(UNAVAILABLE, [], network);
    expect(paintOf(unavailable, 'sBD').get('.route-line').attributes('stroke')).toBe('#5b635f');
    expect(paintOf(unavailable, 'sBD').get('.route-line').attributes('stroke-dasharray')).toBe('8 6');
  });

  test('重算中与不可用时只画中性线并说明，绝不落成未乘坐（反向断言）', () => {
    const cases: RouteCompletion[] = [
      { kind: 'loading', message: '正在重算完乘统计，线路图暂按中性线显示；完成后自动恢复着色。', completedSectionIds: [] },
      UNAVAILABLE,
    ];
    for (const completion of cases) {
      const wrapper = render(completion);
      expect(wrapper.get('.completion-note').text()).toBe(completion.message);
      expect(new Set(statesOf(wrapper))).toEqual(new Set(['unknown']));
      expect(statesOf(wrapper)).not.toContain('unridden');
      expect(paintOf(wrapper, 'sAB').get('.route-line').attributes('stroke')).toBe('#5b635f');
      wrapper.unmount();
    }
  });

  test('完乘结果变化后同一张图随重算刷新，缺省注入按不可用处理', async () => {
    const wrapper = render(UNAVAILABLE);
    expect(paintOf(wrapper, 'sAB').attributes('data-section-state')).toBe('unknown');
    await wrapper.setProps({ completion: ready(['sBD']) });
    expect(paintOf(wrapper, 'sAB').attributes('data-section-state')).toBe('unridden');
    expect(paintOf(wrapper, 'sBD').attributes('data-section-state')).toBe('completed');
    expect(wrapper.find('.completion-note').exists()).toBe(false);
  });

  test('已有本次所选时降级：不画任何外圈，停运仍是虚线', () => {
    const base = lookupNetwork();
    const network = { ...base, policies: { ...base.policies,
      suspensions: [{ lineId: 'L1', sectionIds: ['sAB'], from: '2024-01-01', until: null }] } };
    const wrapper = render(UNAVAILABLE, ['sAB', 'sBD'], network);
    expect(wrapper.findAll('.route-ring')).toHaveLength(0);
    expect(paintOf(wrapper, 'sBD').attributes('data-section-selected')).toBeUndefined();
    // 停运不依赖完乘状态：降级时仍然是灰虚线。
    expect(paintOf(wrapper, 'sAB').attributes('data-section-state')).toBe('suspended');
    expect(paintOf(wrapper, 'sAB').get('.route-line').attributes('stroke-dasharray')).toBe('8 6');
  });

  test('不可用时出现就地重算入口并把请求交给上层；重算中与不可重算时不出现', async () => {
    const unavailable = render(UNAVAILABLE);
    const retry = unavailable.get('.completion-retry');
    expect(retry.text()).toBe('重新计算完乘');
    await retry.trigger('click');
    expect(unavailable.emitted('recalculate')).toHaveLength(1);
    unavailable.unmount();

    const loading = render({ kind: 'loading', message: '正在重算完乘统计，线路图暂按中性线显示；完成后自动恢复着色。', completedSectionIds: [] });
    expect(loading.find('.completion-retry').exists()).toBe(false);
    loading.unmount();

    const blocked = render(UNAVAILABLE, [], lookupNetwork(), { canRecalculate: false });
    expect(blocked.find('.completion-note').exists()).toBe(true);
    expect(blocked.find('.completion-retry').exists()).toBe(false);
  });

  test('线路当日没有可用区间时保留提示且不渲染线路图', () => {
    const base = lookupNetwork();
    const wrapper = mount(RouteDiagramPanel, { props: { network: { ...base, sections: [] }, onDate: ON_DATE,
      selectedLineId: 'L1', completion: ready([]) } });
    wrappers.push(wrapper);
    expect(wrapper.text()).toContain('该线路当日没有可用区间');
    expect(wrapper.findComponent({ name: 'RouteDiagram' }).exists()).toBe(false);
  });
});

describe('选中后的滚动与焦点能力', () => {
  const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 10, width: 10, height: 44, x: 0, y: top,
    toJSON: () => ({}) }) as DOMRect;

  test('目标站不在视口内时滚到最近边缘，已可见则不动', async () => {
    const scroll = vi.fn();
    const scrolled = Element.prototype as unknown as { scrollIntoView?: (options: { block: string }) => void };
    const originalRect = Element.prototype.getBoundingClientRect;
    scrolled.scrollIntoView = scroll;
    // 被滚动的元素应当正是刚变的那一端（读原型方法的 this）。
    const scrolledKeys = (): (string | null)[] => scroll.mock.contexts
      .map(context => (context as Element).getAttribute('data-position-key'));
    try {
      Element.prototype.getBoundingClientRect = () => rect(4000, 4044);
      const wrapper = render(ready([]), [], lookupNetwork(), { fromStationId: '', toStationId: '' });
      await wrapper.setProps({ fromStationId: 'A' });
      await wrapper.vm.$nextTick();
      await wrapper.setProps({ toStationId: 'B' });
      await wrapper.vm.$nextTick();
      expect(scroll).toHaveBeenCalledTimes(2);
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrolledKeys()).toEqual(['A', 'B']);

      // 清空到达站不滚动；再选一个已在视口内的站也不滚动。
      Element.prototype.getBoundingClientRect = () => rect(10, 54);
      await wrapper.setProps({ toStationId: '' });
      await wrapper.setProps({ toStationId: 'D' });
      await wrapper.vm.$nextTick();
      expect(scroll).toHaveBeenCalledTimes(2);
    } finally {
      Element.prototype.getBoundingClientRect = originalRect;
      delete scrolled.scrollIntoView;
    }
  });

  test('focusStation 只对图上存在且可交互的站返回 true', () => {
    const focus = vi.fn();
    const prototype = SVGElement.prototype as unknown as { focus?: () => void };
    const original = prototype.focus;
    prototype.focus = focus;
    try {
      const wrapper = render(ready([]));
      const panel = wrapper.vm as unknown as { focusStation: (positionKey: string) => boolean };
      expect(panel.focusStation('A')).toBe(true);
      expect(focus).toHaveBeenCalledTimes(1);
      expect(panel.focusStation('missing-station')).toBe(false);

      const disabled = render(ready([]), [], lookupNetwork(), { disabled: true });
      const disabledPanel = disabled.vm as unknown as { focusStation: (positionKey: string) => boolean };
      expect(disabledPanel.focusStation('A')).toBe(false);
    } finally {
      if (original) prototype.focus = original; else delete prototype.focus;
    }
  });
});
