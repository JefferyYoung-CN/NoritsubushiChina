import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import SavedRecordsPanel from '../../src/records/SavedRecordsPanel.vue';
import RouteDiagram from '../../src/records/RouteDiagram.vue';
import SearchSelect from '../../src/components/SearchSelect.vue';
import NetworkBrowser from '../../src/integration/NetworkBrowser.vue';
import { fixtureNetwork, lookupNetwork, ON_DATE } from '../integration/fixtures';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); document.body.innerHTML = ''; });
function track<T extends ReturnType<typeof mount>>(wrapper: T): T {
  wrappers.push(wrapper);
  return wrapper;
}

const OPTIONS = [
  { id: 'a', label: '示例站 · 示例城 · A' },
  { id: 'b', label: '示例站 · 示例市 · B' },
  { id: 'c', label: '示例体育馆 · 示例城 · C', description: '示例线 · C' },
];

describe('组合框聚焦不再重复播报结果数（A 组）', () => {
  test('聚焦仍展开候选但实时区域保持安静；用户按键后才播报一次', async () => {
    const wrapper = track(mount(SearchSelect, {
      props: { id: 'station', label: '车站', modelValue: '', options: OPTIONS }, attachTo: document.body,
    }));
    const input = wrapper.get<HTMLInputElement>('input');
    const status = () => wrapper.get('#station-status').text();

    expect(status()).toBe('');
    await input.trigger('focus');
    await wrapper.vm.$nextTick();
    // 候选照常展开，「有几个候选」仍可发现，只是不再靠实时区域每次聚焦重播。
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
    expect(status()).toBe('');
    // 用法说明挂在常驻描述上，实时区域不再参与聚焦播报。
    const described = (input.attributes('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(described).toContain('station-hint');
    expect(described).not.toContain('station-status');
    expect(wrapper.get('#station-hint').text()).toContain('方向键');

    // 上下方向键是用户操作：这时才播报候选数，并真的把焦点移到第一个候选。
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(status()).toContain('3 个结果');
    expect(wrapper.get('#station-option-0').classes()).toContain('active');

    // Esc 关闭后播报一句确认（原来完全静默，用户不知道刚取消了什么）。
    await input.trigger('keydown', { key: 'Escape' });
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(status()).toContain('已关闭候选列表');
    await input.trigger('focus');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
    // 再次聚焦不会写新的播报文本；实时区域内容不变，读屏也就不会重复念一遍。
    expect(status()).toBe('已关闭候选列表');

    // 纯键盘仍能筛选、回车确认。
    await input.setValue('体育');
    expect(status()).toContain('1 个结果');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['c']);
  });
});

describe('未选查找方式时提示可被读到（B 组）', () => {
  test('Tab 到两个方式按钮时，可访问描述解析到那句提示；选定后指针撤回', async () => {
    const wrapper = track(mount(NetworkBrowser, {
      props: { network: lookupNetwork(), onDate: ON_DATE, selectedLineId: '' },
    }));
    const buttons = wrapper.findAll('.modes button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      const ids = (button.attributes('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      const description = ids.map(id => wrapper.get(`#${id}`).text()).join(' ');
      expect(description).toContain('请选择「按线路查找」或「按车站查找」');
    }
    await buttons[0].trigger('click');
    // 选定后提示节点消失，描述指针一并撤掉，不会指向不存在的节点。
    expect(wrapper.find('#network-finder-hint').exists()).toBe(false);
    expect(wrapper.get('.modes button').attributes('aria-describedby')).toBeUndefined();
    expect(wrapper.find('.line-finder').exists()).toBe(true);
  });
});

describe('多条记录的删除按钮可区分（C 组）', () => {
  test('可访问名带端点与日期，视觉文案仍是「删除」', () => {
    const record = (id: string, fromStationId: string, toStationId: string, occurredOn: string) =>
      ({ id, occurredOn, fromStationId, toStationId, note: '', vehicle: '' });
    const wrapper = track(mount(SavedRecordsPanel, { props: {
      network: fixtureNetwork(),
      facts: { basic: [record('r1', 'A', 'B', '2026-10-30'), record('r2', 'C', 'D', '2026-10-31')], advanced: [] },
    } }));
    const deletes = wrapper.findAll('button').filter(button => button.text() === '删除');
    expect(deletes).toHaveLength(2);
    const names = deletes.map(button => button.attributes('aria-label'));
    expect(names).toEqual(['删除 站A → 站B 2026-10-30 的记录', '删除 站C → 站D 2026-10-31 的记录']);
    expect(new Set(names).size).toBe(2);
    // 可访问名包含可见文字，读屏名称与视觉标签不冲突。
    for (const name of names) expect(name).toContain('删除');
  });
});

describe('线路图能从站点序列一步跳出（D 组）', () => {
  const basic = {
    positions: [
      { positionKey: 'A', label: '甲', drawsPoint: true, segmentIndex: 0, arm: 'spine' as const },
      { positionKey: 'B', label: '乙', drawsPoint: true, segmentIndex: 0, arm: 'spine' as const },
      { positionKey: 'C', label: '丙', drawsPoint: true, segmentIndex: 0, arm: 'spine' as const },
    ],
    sections: [{ sectionId: 'sAB', fromPositionKey: 'A', toPositionKey: 'B' },
      { sectionId: 'sBC', fromPositionKey: 'B', toPositionKey: 'C' }],
    segments: [{ index: 0, positionKeys: ['A', 'B', 'C'] }], arms: [], gaps: [], width: 900,
  };

  test('序列中途按 Escape 直接回传跳过，Enter 仍只选站', async () => {
    const wrapper = track(mount(RouteDiagram, { props: basic }));
    const station = wrapper.get('[data-position-key="B"]');
    (station.element as SVGElement).focus();
    await station.trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('skip')).toHaveLength(1);
    expect(wrapper.emitted('select')).toBeUndefined();
    // 出路写在分组说明里，读屏进入分组时能知道。
    expect(wrapper.get('.route-diagram').attributes('aria-label')).toContain('Escape');
    await station.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')?.at(-1)).toEqual(['B']);
    expect(wrapper.emitted('skip')).toHaveLength(1);
  });
});
