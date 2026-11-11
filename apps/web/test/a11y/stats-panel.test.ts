/**
 * 读屏走查在统计页挖出的三处结构问题：
 * 1. 合计卡片不在 Tab 序列里，键盘只能靠读屏浏览模式读到；
 * 2. 统计基准日的说明文字在年/月/日三个 spinbutton 上各重复一遍；
 * 3. 统计表是否足够让读屏按「行 → 单元格」逐格导航。
 *
 * 这里只断言可验证的结构与播报契约；「听起来是否舒服」仍需真实读屏复验。
 */
import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import StatsPanel from '../../src/stats/StatsPanel.vue';
import DateField from '../../src/components/DateField.vue';
import type { CalculationView } from '../../src/stats/calculation';
import { describeCalculation } from '../../src/stats/calculation';
import { buildDimensionStatistics } from '../../src/stats/dimensions';
import { dimensionCompletion, dimensionNetwork, ON_DATE } from '../stats/dimension-fixtures';
import { choose } from '../search-select';

const network = dimensionNetwork();
const result = dimensionCompletion(network);
const dimensions = buildDimensionStatistics(network, result);
const context = { onDate: ON_DATE, snapshotId: network.snapshotId };
const otherContext = { onDate: '2026-10-01', snapshotId: 'other-snapshot' };
const state = (status: 'ready' | 'running' | 'failed' | 'pending', hasResult = true) =>
  describeCalculation(
    { status, context, generation: 1, error: status === 'failed' ? 'E_CALCULATION' : null },
    hasResult ? result : null,
    context,
  );
const staleByContext = (status: 'ready' | 'running' | 'pending'): CalculationView =>
  describeCalculation({ status, context: otherContext, generation: 1, error: null }, result, context);
const props = (calculation: CalculationView = state('ready'), onDate?: string) => ({
  data: result.statistics,
  dimensions,
  cityNames: new Map([['c1', '示例市']]),
  calculation,
  ...(onDate ? { onDate } : {}),
});
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  document.body.innerHTML = '';
});

describe('统计合计可被键盘到达（走查 A21 / 发现：合计不在 Tab 序列）', () => {
  test('合计整组是一个可聚焦区域：有名称、有内容描述，能真的拿到焦点', () => {
    const wrapper = mount(StatsPanel, { props: props(), attachTo: document.body });
    wrappers.push(wrapper);
    const totals = wrapper.get('.totals');
    expect(totals.attributes('role')).toBe('group');
    expect(totals.attributes('tabindex')).toBe('0');
    expect(totals.attributes('aria-label')).toBe('统计合计');
    // 描述直接指向可见卡片：聚焦时一次念出名称与内容，浏览模式下仍能逐项阅读。
    const ids = totals.attributes('aria-describedby')?.split(' ') ?? [];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const described = ids.map(id => wrapper.get(`[id="${id}"]`).text()).join(' ');
    expect(described).toContain('合计 · 运营中');
    expect(described).toContain('合计 · 废线');
    expect(described).toContain('公里');
    (totals.element as HTMLElement).focus();
    expect(document.activeElement).toBe(totals.element);
  });

  test('合计区仍然只有一个 Tab 停留点，单个合计项不再各占一个', () => {
    const wrapper = mount(StatsPanel, { props: props(), attachTo: document.body });
    wrappers.push(wrapper);
    expect(wrapper.findAll('.totals[tabindex="0"]')).toHaveLength(1);
    expect(wrapper.findAll('.total[tabindex]')).toHaveLength(0);
    expect(wrapper.findAll('.total')).toHaveLength(2);
  });

  test('没有合计时不留下空的可聚焦区域', () => {
    const wrapper = mount(StatsPanel, { props: { ...props(), data: null, dimensions: null }, attachTo: document.body });
    wrappers.push(wrapper);
    expect(wrapper.find('.totals').exists()).toBe(false);
  });
});

describe('统计基准日：名称只念一次、说明不逐段重念（走查发现 4、D1）', () => {
  test('名称只由原生 label 提供，分组不再挂 aria-labelledby', () => {
    const wrapper = mount(StatsPanel, { props: props(), attachTo: document.body });
    wrappers.push(wrapper);
    expect(wrapper.get('label[for="stats-date"]').text()).toBe('统计基准日');
    // 名称的第二个来源（分组 aria-labelledby 指向的旧 id）必须彻底不存在，否则重复随时会回来。
    expect(wrapper.find('#stats-date-label').exists()).toBe(false);
    const input = wrapper.get('#stats-date');
    expect(input.attributes('aria-labelledby')).toBeUndefined();
    expect(input.attributes('aria-describedby')).toBeUndefined();
    const described = wrapper.findAll('[aria-describedby="stats-calc"]');
    expect(described).toHaveLength(1);
    expect(described[0].attributes('role')).toBe('group');
    // 分组名与 label 名会各念一次，读屏器播报成「统计基准日 统计基准日」；分组不再给名称。
    expect(described[0].attributes('aria-labelledby')).toBeUndefined();
    expect(described[0].find('#stats-date').exists()).toBe(true);
    // 说明文字本身仍完整留在页面上，只是不再被复制到三个分段上。
    expect(wrapper.get('#stats-calc').text()).toContain('统计结果对应');
  });

  test('DateField 只把说明移交给分组，名称仍落在真正的 input 上', () => {
    const wrapper = mount(DateField, {
      props: { id: 'x-date', value: '2026-10-30', 'aria-labelledby': 'x-label', 'aria-describedby': 'x-hint' },
      attachTo: document.body,
    });
    wrappers.push(wrapper);
    const input = wrapper.get('input');
    expect(input.attributes('aria-describedby')).toBeUndefined();
    expect(input.attributes('aria-labelledby')).toBe('x-label');
    const group = wrapper.get('.date-field-group');
    expect(group.attributes('role')).toBe('group');
    expect(group.attributes('aria-describedby')).toBe('x-hint');
    expect(group.attributes('aria-labelledby')).toBeUndefined();
  });

  test('showsOldResult 为真时句子里已含「旧结果」，徽标只是视觉强调、对读屏隐藏', () => {
    const old = [staleByContext('ready'), staleByContext('running'), staleByContext('pending'), state('failed')];
    for (const view of old) {
      expect(view.showsOldResult).toBe(true);
      expect(view.message.match(/旧结果/g)).toHaveLength(1);
    }
    const wrapper = mount(StatsPanel, { props: props(staleByContext('ready')), attachTo: document.body });
    wrappers.push(wrapper);
    const region = wrapper.get('#stats-calc');
    expect(region.text()).toContain('旧结果');
    expect(wrapper.get('.old').attributes('aria-hidden')).toBe('true');
  });

  test('不是旧结果时不出现徽标', () => {
    const wrapper = mount(StatsPanel, { props: props(state('ready')), attachTo: document.body });
    wrappers.push(wrapper);
    expect(wrapper.find('.old').exists()).toBe(false);
  });
});

describe('统计表的行列语义（走查发现 12）', () => {
  test('按城市维度：表头带列头作用域、每行首格是行头，单元格数与表头一一对应', () => {
    const wrapper = mount(StatsPanel, { props: props(), attachTo: document.body });
    wrappers.push(wrapper);
    expect(wrapper.findAll('table')).toHaveLength(1);
    expect(wrapper.get('caption').text()).toBe('按当前口径的已乘坐情况');
    const region = wrapper.get('.table-scroll');
    expect(region.attributes('role')).toBe('region');
    expect(region.attributes('tabindex')).toBe('0');
    const headers = wrapper.findAll('thead th');
    expect(headers).toHaveLength(3);
    expect(headers.every(node => node.attributes('scope') === 'col')).toBe(true);
    const rows = wrapper.findAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.get('th').attributes('scope')).toBe('row');
      expect(row.findAll('th, td')).toHaveLength(headers.length);
    }
  });

  test('切到运营商维度后，新增的车站列同样带列头，行头没有丢', async () => {
    const wrapper = mount(StatsPanel, { props: props(), attachTo: document.body });
    wrappers.push(wrapper);
    await choose(wrapper, 'stats-dimension', 'operators');
    const headers = wrapper.findAll('thead th');
    expect(headers.map(node => node.text())).toEqual(['范围', '已乘坐 / 总计', '已乘坐车站 / 总计', '说明']);
    expect(headers.every(node => node.attributes('scope') === 'col')).toBe(true);
    const rows = wrapper.findAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.get('th').attributes('scope')).toBe('row');
      expect(row.findAll('th, td')).toHaveLength(4);
    }
  });
});
