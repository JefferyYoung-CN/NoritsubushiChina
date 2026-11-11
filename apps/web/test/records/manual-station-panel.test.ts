import { choose, optionValues } from '../search-select';
import { afterEach, describe, expect, test } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { ComponentMountingOptions } from '@vue/test-utils';
import RecordRouteSelector from '../../src/records/RecordRouteSelector.vue';
import { lookupNetwork, ON_DATE } from '../integration/fixtures';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

type Selection = { physicalLineId: string; fromStationId: string; toStationId: string };
const READY = { kind: 'ready' as const, message: '', completedSectionIds: [] as string[] };

function mountSelector(options: { network?: ReturnType<typeof lookupNetwork>; attach?: boolean;
    stubs?: Record<string, unknown> } = {}) {
  // 允许个别用例替换线路图面板（验证「图上定位不到」的焦点兜底）；stubs 的宽松类型只在测试内收窄。
  const mounting = {
    ...(options.attach ? { attachTo: document.body } : {}),
    props: { network: options.network ?? lookupNetwork(), onDate: ON_DATE, available: true, disabled: false,
      completion: READY,
      modelValue: { physicalLineId: 'L1', fromStationId: '', toStationId: '' },
      'onUpdate:modelValue': (next: Selection) => { void wrapper.setProps({ modelValue: next }); } },
    ...(options.stubs ? { global: { stubs: options.stubs as never } } : {}),
  } as ComponentMountingOptions<typeof RecordRouteSelector>;
  const wrapper = mount(RecordRouteSelector, mounting);
  wrappers.push(wrapper);
  return wrapper;
}
async function openManual(wrapper: ReturnType<typeof mountSelector>) {
  const toggle = wrapper.get('.manual__toggle');
  if (toggle.attributes('aria-expanded') !== 'true') await toggle.trigger('click');
}
const clearButton = (wrapper: ReturnType<typeof mountSelector>, label: string) =>
  wrapper.findAll('.endpoint-clear').find(node => node.text() === label)!;
const activeClass = (): string => (document.activeElement as Element | null)?.className ?? '';

describe('手动选站面板、回显行与焦点归位', () => {
  test('手动选站位于「选择乘车区间」标题下、图上方，线路图不再留在查找区', () => {
    const wrapper = mountSelector();
    const trip = wrapper.get('.trip');
    expect(trip.get('#trip-title').text()).toContain('选择乘车区间');
    const order = [trip.get('.endpoint-echo'), trip.get('.manual'), trip.get('.diagram-panel')];
    for (let index = 0; index + 1 < order.length; index += 1) {
      expect(order[index].element.compareDocumentPosition(order[index + 1].element) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
    }
    expect(trip.find('.route-diagram').exists()).toBe(true);
    expect(wrapper.find('.browser .route-diagram').exists()).toBe(false);
    // 手动选站是始终可见的按钮（不是可折叠的 details/summary），收起时两个下拉不留在 DOM。
    expect(trip.find('details.manual').exists()).toBe(false);
    expect(trip.get('button.manual__toggle').attributes('aria-expanded')).toBe('false');
    expect(trip.find('#manual-stations').exists()).toBe(false);
    expect(trip.find('#record-origin').exists()).toBe(false);
  });

  test('首次展开就有出发站与到达站两个可搜索下拉，未选出发时到达站禁用', async () => {
    const wrapper = mountSelector();
    await openManual(wrapper);
    expect(wrapper.find('#record-origin').exists()).toBe(true);
    expect(wrapper.get('#record-destination').attributes('disabled')).toBeDefined();
    expect(wrapper.get('#destination-help').text()).toContain('请先选择出发站');
    await choose(wrapper, 'record-origin', 'A');
    expect(wrapper.get('#record-destination').attributes('disabled')).toBeUndefined();
  });

  test('出发与到达两个下拉都能分别按站名、城市、站码命中本线当日办客站', async () => {
    const base = lookupNetwork();
    const network = { ...base, stations: base.stations.map(row => ({ ...row, code: `CODE-${row.id}` })) };
    const wrapper = mountSelector({ network });
    await openManual(wrapper);
    await wrapper.get('#record-origin').setValue('站A');
    expect(await optionValues(wrapper, 'record-origin')).toEqual(['A']);
    await wrapper.get('#record-origin').setValue('示例市');
    expect(await optionValues(wrapper, 'record-origin')).toEqual(['A', 'B', 'D']);
    await wrapper.get('#record-origin').setValue('CODE-B');
    expect(await optionValues(wrapper, 'record-origin')).toEqual(['B']);
    // 主文本是日期有效的 display_label（快照里站名唯一，故不再补限定词），
    // 「城市 · 站码」作为副说明仍参与检索与显示。
    await wrapper.get('#record-origin').trigger('focus');
    const option = wrapper.get('#record-origin-listbox [role="option"][data-value="B"]');
    expect(option.get('span').text()).toBe('站B');
    expect(option.get('small').text()).toBe('示例市 · CODE-B');

    await choose(wrapper, 'record-origin', 'A');
    await wrapper.get('#record-destination').setValue('站D');
    expect(await optionValues(wrapper, 'record-destination')).toEqual(['D']);
    await wrapper.get('#record-destination').setValue('示例市');
    expect(await optionValues(wrapper, 'record-destination')).toEqual(['B', 'D']);
    await wrapper.get('#record-destination').setValue('CODE-D');
    expect(await optionValues(wrapper, 'record-destination')).toEqual(['D']);
  });

  test('回显行显示两端并可分别清除', async () => {
    const wrapper = mountSelector();
    expect(wrapper.get('.endpoint-echo__text').text()).toBe('出发站 未选 → 到达站 未选');
    await openManual(wrapper);
    await choose(wrapper, 'record-origin', 'A');
    expect(wrapper.get('.endpoint-echo__text').text()).toBe('出发站 站A → 到达站 未选');
    await choose(wrapper, 'record-destination', 'B');
    expect(wrapper.get('.endpoint-echo__text').text()).toBe('出发站 站A → 到达站 站B');

    await clearButton(wrapper, '清除到达站').trigger('click');
    expect(wrapper.props('modelValue')).toMatchObject({ fromStationId: 'A', toStationId: '' });
    expect(wrapper.get('.endpoint-echo__text').text()).toBe('出发站 站A → 到达站 未选');
  });

  test('双端都已选时清除出发站会连带清掉到达站', async () => {
    const wrapper = mountSelector();
    await openManual(wrapper);
    await choose(wrapper, 'record-origin', 'A');
    await choose(wrapper, 'record-destination', 'B');
    await clearButton(wrapper, '清除出发站').trigger('click');
    expect(wrapper.props('modelValue')).toEqual({ physicalLineId: 'L1', fromStationId: '', toStationId: '' });
    expect(wrapper.get('.endpoint-echo__text').text()).toBe('出发站 未选 → 到达站 未选');
    expect(wrapper.find('.endpoint-clear').exists()).toBe(false);
  });

  test('到达站确定后手动面板自动收起一次，再次展开保留已选，状态仍只有一份', async () => {
    const wrapper = mountSelector();
    await openManual(wrapper);
    expect(wrapper.get('.manual__toggle').attributes('aria-expanded')).toBe('true');
    await choose(wrapper, 'record-origin', 'A');
    expect(wrapper.get('.manual__toggle').attributes('aria-expanded')).toBe('true');
    await choose(wrapper, 'record-destination', 'B');
    expect(wrapper.get('.manual__toggle').attributes('aria-expanded')).toBe('false');
    expect(wrapper.props('modelValue')).toEqual({ physicalLineId: 'L1', fromStationId: 'A', toStationId: 'B' });

    await openManual(wrapper);
    expect(wrapper.get('.manual__toggle').attributes('aria-expanded')).toBe('true');
    expect(wrapper.props('modelValue')).toEqual({ physicalLineId: 'L1', fromStationId: 'A', toStationId: 'B' });
    // 面板再展开后重选到达站，仍只自动收起一次。
    await choose(wrapper, 'record-destination', 'D');
    expect(wrapper.get('.manual__toggle').attributes('aria-expanded')).toBe('false');
  });

  test('外部回填不可达的到达站只更新状态，不收起面板也不搬焦点', async () => {
    const wrapper = mountSelector({ attach: true });
    await openManual(wrapper);
    await choose(wrapper, 'record-origin', 'A');
    await wrapper.setProps({ modelValue: { physicalLineId: 'L1', fromStationId: 'A', toStationId: 'C' } });
    await flushPromises();
    expect(wrapper.props('modelValue').toStationId).toBe('C');
    expect(wrapper.get('.manual__toggle').attributes('aria-expanded')).toBe('true');
    expect(activeClass()).not.toContain('endpoint-clear');
  });

  test('禁用状态下回填到达站不收起面板也不搬焦点', async () => {
    const wrapper = mountSelector({ attach: true });
    await openManual(wrapper);
    await choose(wrapper, 'record-origin', 'A');
    await wrapper.setProps({ disabled: true, modelValue: { physicalLineId: 'L1', fromStationId: 'A', toStationId: 'B' } });
    await flushPromises();
    expect(wrapper.get('.manual__toggle').attributes('aria-expanded')).toBe('true');
    expect(activeClass()).not.toContain('endpoint-clear');
  });

  test('自动收起后焦点落到图上刚选的到达站', async () => {
    const wrapper = mountSelector({ attach: true });
    await openManual(wrapper);
    await choose(wrapper, 'record-origin', 'A');
    await choose(wrapper, 'record-destination', 'B');
    await flushPromises();
    expect(wrapper.get('.manual__toggle').attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(wrapper.get('[data-position-key="B"]').element);
  });

  test('图上定位不到该站时焦点落到回显行的到达站清除按钮', async () => {
    const wrapper = mountSelector({ attach: true, stubs: { RouteDiagramPanel: {
      name: 'RouteDiagramPanel', template: '<div class="diagram-panel" />', methods: { focusStation: () => false } } } });
    await openManual(wrapper);
    await choose(wrapper, 'record-origin', 'A');
    await choose(wrapper, 'record-destination', 'B');
    await flushPromises();
    expect(document.activeElement).toBe(clearButton(wrapper, '清除到达站').element);
  });

  test('自助展开/收起手动面板后焦点回到「手动选站」按钮', async () => {
    const wrapper = mountSelector({ attach: true });
    const toggle = wrapper.get('.manual__toggle');
    await toggle.trigger('click');
    await flushPromises();
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(toggle.element);
    (wrapper.get('#record-origin').element as HTMLInputElement).focus();
    expect(document.activeElement).toBe(wrapper.get('#record-origin').element);
    await toggle.trigger('click');
    await flushPromises();
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle.element);
  });

  test('清除回显行后焦点落到回显文字并播报清掉了哪一端', async () => {
    const wrapper = mountSelector({ attach: true });
    await wrapper.setProps({ modelValue: { physicalLineId: 'L1', fromStationId: 'A', toStationId: 'B' } });
    await flushPromises();
    await clearButton(wrapper, '清除到达站').trigger('click');
    await flushPromises();
    expect(wrapper.props('modelValue')).toMatchObject({ fromStationId: 'A', toStationId: '' });
    expect(document.activeElement).toBe(wrapper.get('.endpoint-echo__text').element);
    expect(wrapper.get('.notice-line').text()).toBe('已清除到达站。');

    await clearButton(wrapper, '清除出发站').trigger('click');
    await flushPromises();
    expect(wrapper.props('modelValue')).toMatchObject({ fromStationId: '', toStationId: '' });
    expect(document.activeElement).toBe(wrapper.get('.endpoint-echo__text').element);
    expect(wrapper.get('.notice-line').text()).toBe('已清除出发站与到达站。');
  });

  test('没有区间摘要行时跳过线路图落到区块并播报', async () => {
    const wrapper = mountSelector({ attach: true });
    expect(wrapper.find('.interval-summary').exists()).toBe(false);
    await wrapper.get('.diagram-skip').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('.trip').element);
    expect(wrapper.get('.notice-line').text()).toContain('已跳过线路图');
  });
});
