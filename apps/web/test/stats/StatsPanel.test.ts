import { choose, optionValues } from '../search-select';
import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import StatsPanel from '../../src/stats/StatsPanel.vue';
import { describeCalculation } from '../../src/stats/calculation';
import { buildDimensionStatistics } from '../../src/stats/dimensions';
import { dimensionCompletion, dimensionNetwork, ON_DATE } from './dimension-fixtures';

const network = dimensionNetwork();
const result = dimensionCompletion(network);
const dimensions = buildDimensionStatistics(network, result);
const context = { onDate: ON_DATE, snapshotId: network.snapshotId };
const state = (status: 'ready' | 'running' | 'failed' | 'pending', hasResult = true) =>
  describeCalculation({ status, context, generation: 1, error: status === 'failed' ? 'E_CALCULATION' : null },
    hasResult ? result : null, context);
const props = () => ({
  data: result.statistics,
  dimensions,
  cityNames: new Map([['c1', '示例市']]),
  calculation: state('ready'),
});
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  document.body.innerHTML = '';
});

describe('统计维度切换', () => {
  test('有显式 label 的搜索选择框可聚焦，切换展示分组、车站和去重说明', async () => {
    const wrapper = mount(StatsPanel, { props: props(), attachTo: document.body });
    wrappers.push(wrapper);
    const select = wrapper.get<HTMLInputElement>('#stats-dimension');
    expect(wrapper.get('label[for="stats-dimension"]').text()).toBe('统计维度');
    expect(await optionValues(wrapper, 'stats-dimension')).toEqual(['area', 'operators', 'physicalLines', 'lines']);
    select.element.focus();
    expect(document.activeElement).toBe(select.element);
    await choose(wrapper, 'stats-dimension', 'operators');
    expect(wrapper.find('#stats-area').exists()).toBe(false);
    expect(wrapper.findAll('tbody tr:not(.subtotal)')).toHaveLength(2);
    expect(wrapper.get('tbody tr:not(.subtotal)').text()).toContain('运营一');
    expect(wrapper.get('tbody tr:not(.subtotal)').text()).toContain('1.00 公里 / 3.00 公里');
    expect(wrapper.get('tbody tr:not(.subtotal)').text()).toContain('2 座车站 / 4 座车站');
    expect(wrapper.text()).toContain('不能将分组合计当作全网合计');
    expect(wrapper.emitted('update:scope')?.at(-1)).toEqual([
      { basis: 'mileage', area: 'all', includeRetired: true, dimension: 'operators' },
    ]);
    await choose(wrapper, 'stats-dimension', 'lines');
    expect(wrapper.findAll('tbody tr:not(.subtotal)')).toHaveLength(3);
    expect(wrapper.get('tbody tr:not(.subtotal)').text()).toContain('1.00 公里 / 2.00 公里');
    await wrapper.get('input[value="sections"]').setValue();
    expect(wrapper.get('tbody tr:not(.subtotal)').text()).toContain('1 个区间 / 2 个区间');
  });

  test('切换回来保留原城市选择，全网/城市数字和日期事件不改变', async () => {
    const wrapper = mount(StatsPanel, { props: props() });
    wrappers.push(wrapper);
    expect(wrapper.get('tbody tr:not(.subtotal)').text()).toContain('示例市 运营中1.00 公里 / 8.00 公里');
    await choose(wrapper, 'stats-area', 'c1');
    const before = wrapper.get('tbody').text();
    expect(before).toContain('示例市');
    await choose(wrapper, 'stats-dimension', 'lines');
    await choose(wrapper, 'stats-dimension', 'area');
    expect(wrapper.get<HTMLInputElement>('#stats-area').element.value).toBe('示例市');
    expect(wrapper.get('tbody').text()).toBe(before);
    expect(wrapper.findAll('thead th')).toHaveLength(3);
    expect(wrapper.emitted('change-date')).toBeUndefined();
    await wrapper.get('#stats-date').setValue('2024-06-09');
    expect(wrapper.emitted('change-date')).toEqual([['2024-06-09']]);
  });

  test('运行中保持原加载提示并禁用维度；失败后切换仍标旧结果并可重试', async () => {
    const wrapper = mount(StatsPanel, { props: { ...props(), busy: true, calculation: state('running') }, attachTo: document.body });
    wrappers.push(wrapper);
    expect(wrapper.get<HTMLInputElement>('#stats-dimension').element.disabled).toBe(true);
    expect(wrapper.get('#stats-calc').text()).toContain('正在计算');
    expect(wrapper.find('button').exists()).toBe(false);
    await wrapper.setProps({ busy: false, calculation: state('failed') });
    expect(document.activeElement).toBe(wrapper.get('#stats-calc').element);
    await choose(wrapper, 'stats-dimension', 'operators');
    expect(wrapper.get('#stats-calc').text()).toContain('E_CALCULATION');
    expect(wrapper.get('#stats-calc').text()).toContain('旧结果');
    expect(wrapper.get('button').text()).toBe('重试统计');
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('recalculate')).toEqual([[]]);
  });

  test('没有统计数据时切换仍保留空状态与待算提示，随后注入结果会刷新', async () => {
    const wrapper = mount(StatsPanel, { props: { ...props(), data: null, dimensions: null, calculation: state('pending', false) } });
    wrappers.push(wrapper);
    await choose(wrapper, 'stats-dimension', 'operators');
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.get('.empty').text()).toContain('当前口径没有可展示的统计');
    expect(wrapper.get('#stats-calc').text()).toContain('等待重算');
    await wrapper.setProps(props());
    expect(wrapper.findAll('tbody tr:not(.subtotal)')).toHaveLength(2);
  });

  test('缺少接线或分组日期/快照错配时不显示伪造的全网行', async () => {
    const wrapper = mount(StatsPanel, { props: { ...props(), dimensions: undefined } });
    wrappers.push(wrapper);
    await choose(wrapper, 'stats-dimension', 'lines');
    expect(wrapper.find('table').exists()).toBe(false);
    for (const stale of [{ ...dimensions, onDate: '2024-06-09' }, { ...dimensions, snapshotId: 'other' }]) {
      await wrapper.setProps({ dimensions: stale });
      expect(wrapper.find('table').exists()).toBe(false);
      expect(wrapper.find('.empty').exists()).toBe(true);
    }
    await wrapper.setProps({ dimensions });
    expect(wrapper.findAll('tbody tr:not(.subtotal)')).toHaveLength(3);
  });

  test('父组件保存的线路维度在面板重建后恢复，含废线切换仍沿用原事件', async () => {
    const wrapper = mount(StatsPanel, { props: { ...props(), scope: {
      basis: 'sections', area: 'c1', includeRetired: true, dimension: 'lines',
    } } });
    wrappers.push(wrapper);
    expect(wrapper.get<HTMLInputElement>('#stats-dimension').element.value).toBe('运营线路');
    expect(wrapper.findAll('tbody tr:not(.subtotal)')).toHaveLength(3);
    await wrapper.get('input[type="checkbox"]').setValue(false);
    expect(wrapper.emitted('update:scope')?.at(-1)).toEqual([
      { basis: 'sections', area: 'c1', includeRetired: false, dimension: 'lines' },
    ]);
  });
});
