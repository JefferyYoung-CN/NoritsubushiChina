import { choose, optionValues } from '../search-select';
import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import NetworkBrowser from '../../src/integration/NetworkBrowser.vue';
import { lookupNetwork, ON_DATE } from './fixtures';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });
function render(network = lookupNetwork()) {
  const wrapper = mount(NetworkBrowser, { props: { network, onDate: ON_DATE, selectedLineId: '', disabled: false,
    onLine: lineId => { void wrapper.setProps({ selectedLineId: lineId }); } } });
  wrappers.push(wrapper);
  return wrapper;
}
async function mode(wrapper: ReturnType<typeof render>, index: number) { await wrapper.findAll('.modes button')[index].trigger('click'); }

describe('先选择查找方式再展示操作', () => {
  test('初始没有查找表单，方式切换互斥，使用有名称和按下状态的按钮', async () => {
    const wrapper = render();
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.text()).toContain('请选择「按线路查找」或「按车站查找」');
    await mode(wrapper, 0);
    expect(wrapper.find('.line-finder').exists()).toBe(true);
    expect(wrapper.find('.station-finder').exists()).toBe(false);
    expect(wrapper.get('.modes button').attributes('aria-pressed')).toBe('true');
    await mode(wrapper, 1);
    expect(wrapper.find('.line-finder').exists()).toBe(false);
    expect(wrapper.find('.station-finder').exists()).toBe(true);
  });

  test('一个物理线路对应多个服务时按站只给一个物理线路，没有端点动作', async () => {
    const wrapper = render(); await mode(wrapper, 1);
    await wrapper.get('#station-finder-query').setValue('站D');
    await choose(wrapper, 'station-finder-query', 'D');
    const station = wrapper.get('.station-finder');
    expect(await optionValues(wrapper, 'station-finder-line')).toEqual(['L1']);
    expect(station.text()).not.toContain('作为出发站');
    expect(station.text()).not.toContain('作为到达站');
    await choose(wrapper, 'station-finder-line', 'L1');
    expect(wrapper.props('selectedLineId')).toBe('L1');
    expect(wrapper.text()).toContain('已选物理线路 · 一号线');
    expect(wrapper.find('details').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('查看线路区间与地图');
  });

  test('按物理线路名查询，城市和运营商只筛选，不把服务当线路', async () => {
    const wrapper = render(); await mode(wrapper, 0);
    expect(await optionValues(wrapper, 'line-finder-query')).toEqual(['L1']);
    await choose(wrapper, 'line-finder-city', 'c2');
    await choose(wrapper, 'line-finder-operator', 'op2');
    expect(await optionValues(wrapper, 'line-finder-query')).toEqual(['L1']);
    await wrapper.get('#line-finder-query').setValue('二号服务');
    expect(wrapper.get('#line-finder-query-status').text()).toContain('没有匹配线路');
    await wrapper.get('#line-finder-query').setValue('一号线');
    await choose(wrapper, 'line-finder-query', 'L1');
    expect(wrapper.emitted('line')?.at(-1)).toEqual(['L1']);
  });

  test('同名站按城市消歧，站码留在副说明里；仅搜索当日办客名称；空结果可修改关键词', async () => {
    const base = lookupNetwork();
    const network = { ...base, names: base.names.map(name => ['A', 'C'].includes(name.stationId) ? { ...name, name: '同名站' } : name) };
    const wrapper = render(network); await mode(wrapper, 1);
    await wrapper.get('#station-finder-query').setValue('同名站');
    const options = wrapper.findAll('#station-finder-query-listbox [role=option]');
    expect(options.map(option => ({ label: option.get('span').text(), detail: option.get('small').text() })))
      .toEqual(expect.arrayContaining([
        { label: '同名站（示例市）', detail: '示例市 · A' },
        { label: '同名站（另一市）', detail: '另一市 · C' },
      ]));
    await wrapper.get('#station-finder-query').setValue('站A');
    expect(wrapper.text()).toContain('没有匹配的当日办客车站');
    await wrapper.setProps({ network: { ...network, passengerPeriods: network.passengerPeriods.filter(period => period.stationId !== 'C') } });
    await wrapper.get('#station-finder-query').setValue('同名站');
    expect(wrapper.findAll('#station-finder-query-listbox [role=option]')).toHaveLength(1);
  });

  test('没有经过物理线路时有提示，日期变化清掉查询候选', async () => {
    const base = lookupNetwork();
    const wrapper = render({ ...base, sections: [] }); await mode(wrapper, 1);
    await wrapper.get('#station-finder-query').setValue('站A');
    await choose(wrapper, 'station-finder-query', 'A');
    expect(wrapper.text()).toContain('没有经过的可用物理线路');
    await wrapper.setProps({ onDate: '2024-06-11' });
    expect(wrapper.find('#station-finder-line').exists()).toBe(false);
    expect(wrapper.text()).toContain('没有覆盖时不会借用其他日期数据');
  });

  test('忙时当前入口和切换按钮均禁用', async () => {
    const wrapper = render(); await mode(wrapper, 0);
    await wrapper.setProps({ disabled: true });
    for (const control of wrapper.findAll('input, select, button')) expect(control.attributes('disabled')).toBeDefined();
  });

  test('反向检查：查找区不再有折叠清单、小地图或线路图（图归「选择乘车区间」）', async () => {
    const wrapper = render(); await mode(wrapper, 0);
    await choose(wrapper, 'line-finder-query', 'L1');
    expect(wrapper.text()).not.toContain('查看线路区间与地图');
    expect(wrapper.find('summary').exists()).toBe(false);
    expect(wrapper.find('.route-diagram').exists()).toBe(false);
  });
});
