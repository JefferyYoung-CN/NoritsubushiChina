import { choose, optionValues } from '../search-select';
import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import AdvancedPanel from '../../src/advanced/AdvancedPanel.vue';
import type { PendingItem } from '../../src/advanced/panelTypes';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';

const period = { from: '2020-01-01', until: null };
const ON = '2024-06-10';

function network(): TransitNetwork {
  const stations = ['A', 'B', 'D'].map((id) => ({ id, code: id, name: id, cityId: 'c1', latitude: 0, longitude: 0 }));
  const line = { id: 'L1', name: '一号线', operatorId: 'op1', ...period };
  const service = { id: 'S1', name: '一号线', operatorId: 'op1', ...period };
  const section = (id: string, fromStationId: string, toStationId: string) => ({
    id, lineId: 'L1', fromStationId, toStationId, lengthMetres: 1000, lengthSource: 'official', ...period,
  });
  const membership = (sectionId: string, sequence: number) => ({ serviceId: 'S1', sectionId, sequence, ...period });
  return {
    snapshotId: 'snap1', snapshotAsOf: '2024-01-01', knowledgeThrough: '2030-12-31',
    sourceKind: 'development', attribution: {}, releaseReady: false, sourceUse: {},
    stations, lines: [line], services: [service],
    sections: [section('sAB', 'A', 'B'), section('sBD', 'B', 'D')],
    memberships: [membership('sAB', 0), membership('sBD', 1)],
    names: stations.map((row) => ({ stationId: row.id, name: row.name, ...period })),
    passengerPeriods: stations.map((row) => ({ stationId: row.id, kind: 'passenger', ...period })),
    mappings: [], policies: { noMileageSections: [], closures: [], suspensions: [] },
    cities: [{ id: 'c1', name: '示例市' }], operators: [{ id: 'op1', name: '运营一' }], events: [],
  } as unknown as TransitNetwork;
}

const services = [{ serviceLineId: 'S1', label: '一号线（运营一）', operatorName: '运营一', lineNames: ['一号线'] }];
const pending: PendingItem[] = [
  { recordId: 'r1', layer: 'advanced', reason: 'snapshot-mapping-required', message: '来自其他快照' },
  { recordId: 'r2', layer: 'basic', reason: 'topology-mapping-required', message: '区间已停用' },
];

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });
function mountPanel(overrides: Record<string, unknown> = {}) {
  const wrapper = mount(AdvancedPanel, {
    attachTo: document.body,
    props: { network: network(), onDate: ON, services, pending: [], ...overrides },
  });
  wrappers.push(wrapper);
  return wrapper;
}

describe('AdvancedPanel 只读契约与首段选择', () => {
  test('日期只读：显示日期与解释，不提供日期编辑控件', () => {
    const wrapper = mountPanel();
    const text = wrapper.text();
    expect(text).toContain(`乘车日期 ${ON}`);
    expect(text).toContain('· 只读');
    expect(text).toContain('日期取自本页乘车日期');
    expect(text).toContain('保存后不能直接修改');
    expect(wrapper.find('input[type="date"]').exists()).toBe(false);
  });

  test('选择起点站后发出 start，并列出该站候选线路', async () => {
    const wrapper = mountPanel();
    await choose(wrapper, 'adv-origin', 'A');
    expect(wrapper.emitted('start')?.[0]).toEqual(['A']);
    expect(await optionValues(wrapper, 'adv-service')).toEqual(['S1']);
  });

  test('空状态：没有候选线路时给出明确说明而非空白', async () => {
    const wrapper = mountPanel({ services: [] });
    await choose(wrapper, 'adv-origin', 'A');
    expect(wrapper.text()).toContain('该站在当日没有可用运营线路');
  });
});

describe('AdvancedPanel 径路目标与链式继续', () => {
  test('点击线路后列出唯一径路目标，选择目标后链与保存可用', async () => {
    const wrapper = mountPanel();
    await choose(wrapper, 'adv-origin', 'A');
    await choose(wrapper, 'adv-service', 'S1');
    await choose(wrapper, 'adv-target', 'D');
    expect(wrapper.text()).toContain('已加入一段：A → D');
    expect(wrapper.text()).toContain('2 区间');
    const saveButton = wrapper.findAll('button').find((row) => row.text() === '保存');
    expect(saveButton?.attributes('disabled')).toBeUndefined();
  });

  test('没有可继续的直通线路时，步骤只提示回退或保存', async () => {
    const wrapper = mountPanel();
    await choose(wrapper, 'adv-origin', 'A');
    expect(wrapper.get('.step').text()).toBe('当前步骤：选择首段线路');
    await choose(wrapper, 'adv-service', 'S1');
    expect(wrapper.get('.step').text()).toBe('当前步骤：选择本段到达站');
    await choose(wrapper, 'adv-target', 'D');
    expect(wrapper.get('.step').text()).toBe('当前步骤：可回退或保存');
    expect(wrapper.text()).toContain('当前到达站没有可直通线路，如在本站下车可保存本条记录');
    // 无可继续的直通候选时，整块「可继续的直通线路」连同标题与下拉都不出现。
    expect(wrapper.find('[aria-labelledby=adv-continue-title]').exists()).toBe(false);
    expect(wrapper.find('#adv-continuation').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('可继续的直通线路');
  });

  test('回退发出 rollback 并提示在起点无可回退段', async () => {
    const wrapper = mountPanel();
    await choose(wrapper, 'adv-origin', 'A');
    await choose(wrapper, 'adv-service', 'S1');
    await choose(wrapper, 'adv-target', 'D');
    const back = wrapper.findAll('button').find((row) => row.text() === '回退一段');
    await back?.trigger('click');
    expect(wrapper.emitted('rollback')).toHaveLength(1);
  });
});

describe('AdvancedPanel 待处理与重算反馈', () => {
  test('五类待处理整条显示、说明不计入统计，删除需要二次确认', async () => {
    const wrapper = mountPanel({ pending });
    const text = wrapper.text();
    expect(text).toContain('需要按当前快照复核映射');
    expect(text).toContain('需要拓扑映射复核');
    expect(text).toContain('整条保留为待处理，不计入统计');
    expect(wrapper.emitted('delete')).toBeUndefined();
    const del = wrapper.findAll('button').find((row) => row.text() === '删除…');
    await del?.trigger('click');
    expect(wrapper.emitted('delete')).toBeUndefined();
    const confirmButton = wrapper.findAll('button').find((row) => row.text() === '确认删除');
    await confirmButton?.trigger('click');
    expect(wrapper.emitted('delete')?.[0]).toEqual([{ layer: 'advanced', recordId: 'r1' }]);
  });

  test('录入不展示重算状态或重算操作', () => {
    const wrapper = mountPanel();
    expect(wrapper.find('#adv-calc').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('重算');
  });

  test('disabled 时起点、线路与保存按钮都被禁用，并给出处理中提示', async () => {
    const wrapper = mountPanel({ disabled: true });
    expect(wrapper.find('#adv-origin').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('控件暂不可用');
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });
});

async function complete(wrapper: ReturnType<typeof mountPanel>) {
  await choose(wrapper, 'adv-origin', 'A');
  await choose(wrapper, 'adv-service', 'S1');
  await choose(wrapper, 'adv-target', 'D');
}

describe('进阶逐步展开与保存后补录', () => {
  test('起点、线路、到达站、备注逐步出现；回退保留选线并收回保存', async () => {
    const wrapper = mountPanel();
    expect(wrapper.find('#adv-service, #adv-target, #adv-note').exists()).toBe(false);
    await choose(wrapper, 'adv-origin', 'A');
    expect(wrapper.find('#adv-service').exists()).toBe(true);
    expect(wrapper.find('#adv-target').exists()).toBe(false);
    expect(wrapper.get('.save').isVisible()).toBe(false);
    await choose(wrapper, 'adv-service', 'S1');
    expect(wrapper.find('#adv-target').exists()).toBe(true);
    expect(wrapper.get('.save').isVisible()).toBe(false);
    await choose(wrapper, 'adv-target', 'D');
    expect(wrapper.get('.selection-card').text()).toContain('一号线（运营一）');
    expect(wrapper.get('.selection-card').text()).toContain('A → D');
    expect(wrapper.get('.selected-leg > button').text()).toBe('回退一段');
    expect(wrapper.get('.save').isVisible()).toBe(true);
    expect(wrapper.get('.save').findAll('input')).toHaveLength(1);
    expect(wrapper.find('#adv-vehicle').exists()).toBe(false);
    await wrapper.get('#adv-note').setValue('保留备注');
    await wrapper.get('.selected-leg > button').trigger('click');
    expect(wrapper.find('.selection-card').exists()).toBe(false);
    expect(wrapper.find('#adv-target').exists()).toBe(true);
    expect(wrapper.get('.save').isVisible()).toBe(false);
    await choose(wrapper, 'adv-target', 'B');
    expect((wrapper.get('#adv-note').element as HTMLInputElement).value).toBe('保留备注');
    await wrapper.get('#adv-origin').setValue('重搜');
    expect(wrapper.find('#adv-service, #adv-target, #adv-note, .selection-card').exists()).toBe(false);
  });

  test('保存失败保留草稿与备注，写入成功才出现车辆邀请，补录只针对已保存身份', async () => {
    const wrapper = mountPanel();
    await complete(wrapper);
    await wrapper.get('#adv-note').setValue('  乘车备注  ');
    await wrapper.get('.save form').trigger('submit');
    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ note: '乘车备注', vehicle: '' });
    await wrapper.setProps({ disabled: true });
    await wrapper.setProps({ disabled: false, saveError: '本地写入失败，请重试' });
    expect(wrapper.find('#adv-saved').exists()).toBe(false);
    expect((wrapper.get('#adv-note').element as HTMLInputElement).value).toBe('  乘车备注  ');
    expect(wrapper.get('.selection-card').text()).toContain('A → D');
    await wrapper.setProps({ saved: { recordId: 'saved-123', message: '本次乘车已保存。' }, saveError: '' });
    expect(wrapper.find('#adv-origin, #adv-note').exists()).toBe(false);
    expect(wrapper.find('.vehicle-fields').exists()).toBe(false);
    await wrapper.findAll('button').find(row => row.text() === '填写车辆信息')!.trigger('click');
    const fields = wrapper.findAll('.vehicle-fields input');
    expect(fields).toHaveLength(3);
    await fields[0].setValue(' A型 ');
    await fields[1].setValue(' 123 ');
    await fields[2].setValue(' 12F ');
    await wrapper.get('.saved-prompt form').trigger('submit');
    expect(wrapper.emitted('vehicle')?.[0]).toEqual(['saved-123', { model: 'A型', number: '123', formation: '12F' }]);
    expect(wrapper.emitted('save')).toHaveLength(1);
    await wrapper.setProps({ vehicleFeedback: { ok: false, message: '补录失败，可重试' } });
    expect(wrapper.get('[role=alert]').text()).toContain('补录失败');
    expect((fields[1].element as HTMLInputElement).value).toBe(' 123 ');
    await wrapper.get('.saved-prompt form').trigger('submit');
    expect(wrapper.emitted('vehicle')).toHaveLength(2);
    await wrapper.setProps({ vehicleFeedback: { ok: true, message: '车辆信息已保存' } });
    expect(wrapper.text()).toContain('车辆信息已保存');
    await wrapper.get('.saved-prompt > button').trigger('click');
    expect(wrapper.emitted('restart')).toHaveLength(1);
    await wrapper.setProps({ saved: null });
    expect((wrapper.get('#adv-origin').element as HTMLInputElement).value).toBe('');
    expect(wrapper.find('#adv-note').exists()).toBe(false);
  });
});
