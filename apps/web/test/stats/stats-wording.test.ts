import { describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import { choose } from '../search-select';
import StatsPanel from '../../src/stats/StatsPanel.vue';
import { describeCalculation } from '../../src/stats/calculation';
import { buildDimensionStatistics } from '../../src/stats/dimensions';
import { dimensionCompletion, dimensionNetwork, ON_DATE } from './dimension-fixtures';

const network = dimensionNetwork();
const result = dimensionCompletion(network);
const context = { onDate: ON_DATE, snapshotId: network.snapshotId };

describe('统计页用词', () => {
  test('表头、说明句、表格无障碍标签与统计导语使用「已乘坐 / 未乘坐」', async () => {
    const wrapper = mount(StatsPanel, { props: {
      data: result.statistics,
      dimensions: buildDimensionStatistics(network, result),
      cityNames: new Map([['c1', '示例市']]),
      calculation: describeCalculation({ status: 'ready', context, generation: 1, error: null }, result, context),
    } });
    // 默认「按城市」维度没有车站列；切到「按运营商」后车站列出现，两处表头都要用新词。
    expect(wrapper.findAll('thead th').map(node => node.text()))
      .toEqual(['范围', '已乘坐 / 总计', '说明']);
    await choose(wrapper, 'stats-dimension', 'operators');
    expect(wrapper.findAll('thead th').map(node => node.text()))
      .toEqual(['范围', '已乘坐 / 总计', '已乘坐车站 / 总计', '说明']);
    expect(wrapper.get('caption').text()).toBe('按当前口径的已乘坐情况');
    expect(wrapper.get('.table-scroll').attributes('aria-label')).toContain('已乘坐统计表');
    // 完站只由进阶记录贡献，基础记录只贡献区间完乘。
    expect(wrapper.text()).toContain('已乘坐车站只由进阶记录贡献（出发站与到达站各计一次），基础记录只贡献区间完乘');
    expect(wrapper.text()).not.toContain('已完成');
    expect(wrapper.text()).not.toContain('未乘情况');
    wrapper.unmount();
  });
});
