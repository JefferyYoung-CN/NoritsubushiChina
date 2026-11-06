import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import { buildDateView } from '../../../../packages/application/date-view.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import RecordsPanel from '../../src/records/RecordsPanel.vue';
import SavedRecordsPanel from '../../src/records/SavedRecordsPanel.vue';
import { commandFromDraft, summarizeRecords } from '../../src/records/record-commands';
import type { RecordSummaryInput } from '../../src/records/record-commands';
import { fact, fixtureNetwork, ON_DATE } from '../integration/fixtures';

const network = fixtureNetwork();
const view = buildDateView(network, { onDate: ON_DATE, fromStationId: 'A', toStationId: 'B', serviceLineId: 'S1' });
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });
function render(basic: readonly RecordSummaryInput[] = [fact()], advanced: readonly RecordSummaryInput[] = []) {
  const wrapper = mount(RecordsPanel, { props: { network, view, facts: { basic, advanced } } });
  wrappers.push(wrapper);
  return wrapper;
}

/** 4 段连续区间（A→B→C→D→E）：用来验证「中间段已记录时拆成两段保存」。 */
function fourSectionNetwork(): TransitNetwork {
  const base = fixtureNetwork();
  const stations = ['A', 'B', 'C', 'D', 'E'].map(id => ({ ...base.stations[0], id, code: id, name: `站${id}` }));
  const section = (id: string, fromStationId: string, toStationId: string) => ({
    ...base.sections[0], id, fromStationId, toStationId,
  });
  const sections = [section('sAB', 'A', 'B'), section('sBC', 'B', 'C'), section('sCD', 'C', 'D'), section('sDE', 'D', 'E')];
  return {
    ...base,
    stations,
    sections,
    names: stations.map(row => ({ ...base.names[0], stationId: row.id, name: row.name })),
    passengerPeriods: stations.map(row => ({ ...base.passengerPeriods[0], stationId: row.id })),
    memberships: sections.map((row, sequence) => ({ ...base.memberships[0], sectionId: row.id, sequence })),
  };
}

describe('记录页只创建基础完乘', () => {
  test('没有层级或车辆控件，提交层级固定且 vehicle 仍是空字符串', async () => {
    const wrapper = render([]);
    expect(wrapper.find('#record-layer').exists()).toBe(false);
    expect(wrapper.find('#record-vehicle').exists()).toBe(false);
    expect(wrapper.findAll('form.form input')).toHaveLength(1);
    await wrapper.get('#record-note').setValue('  乘车备注  ');
    await wrapper.get('form.form').trigger('submit');
    expect(wrapper.emitted('add')?.[0]).toEqual([expect.objectContaining({ layer: 'basic', note: '乘车备注', vehicle: '' })]);
    expect(wrapper.text()).toContain('等待保存与重算');
    const command = wrapper.emitted('add')![0][0] as { id: string };
    await wrapper.setProps({ savedRecordId: command.id });
    expect((wrapper.get('#record-note').element as HTMLInputElement).value).toBe('');
    expect(wrapper.text()).toContain('基础记录已保存');
  });

  test('命令边界不接受基础车辆，但不改变进阶车辆载荷', () => {
    const draft = { layer: 'basic' as const, onDate: ON_DATE, fromStationId: 'A', toStationId: 'B', serviceLineId: 'S1', note: '', vehicle: '  V123  ' };
    expect(commandFromDraft(draft, 'basic').vehicle).toBe('');
    expect(commandFromDraft({ ...draft, layer: 'advanced' }, 'advanced').vehicle).toBe('V123');
  });

  test('基础列表隐藏旧车辆，编辑备注不丢失已存 vehicle', async () => {
    const record = { ...fact(), vehicle: '旧车辆不可显示' };
    const wrapper = mount(SavedRecordsPanel, { props: { network, facts: { basic: [record], advanced: [] } } });
    wrappers.push(wrapper);
    expect(wrapper.text()).not.toContain(record.vehicle);
    await wrapper.findAll('button').find(button => button.text() === '编辑备注')!.trigger('click');
    const editor = wrapper.get('.list form');
    expect(editor.findAll('input')).toHaveLength(1);
    expect(editor.text()).not.toContain('车辆');
    await editor.get('input').setValue('更新备注');
    await editor.trigger('submit');
    expect(wrapper.emitted('edit')).toEqual([['basic', record.id, { note: '更新备注', vehicle: record.vehicle }]]);
  });

  test('已保存进阶记录仍能补录车辆，和同 id 基础记录互不串用', async () => {
    const record = fact();
    const wrapper = mount(SavedRecordsPanel, { props: { network, facts: { basic: [record], advanced: [record] } } });
    wrappers.push(wrapper);
    expect(wrapper.findAll('.list > li')).toHaveLength(1);
    await wrapper.findAll('.layers button')[1].trigger('click');
    await wrapper.findAll('button').find(button => button.text() === '编辑备注 / 车辆')!.trigger('click');
    expect(wrapper.findAll('.list form')).toHaveLength(1);
    const editor = wrapper.get('.list form');
    expect(editor.text()).toContain('车辆信息（均可选）');
    await editor.findAll('input')[1].setValue('A型');
    await editor.findAll('input')[2].setValue('V234');
    await editor.findAll('input')[3].setValue('12F');
    await editor.trigger('submit');
    expect(wrapper.emitted('edit')).toEqual([['advanced', record.id, { note: '', vehicle: '', vehicleDetails: { model: 'A型', number: 'V234', formation: '12F' } }]]);
    await wrapper.findAll('.list > li')[0].findAll('button').find(button => button.text() === '删除')!.trigger('click');
    expect(wrapper.findAll('[aria-label="确认删除记录"]')).toHaveLength(1);
    await wrapper.findAll('button').find(button => button.text() === '确认删除')!.trigger('click');
    expect(wrapper.emitted('remove')).toEqual([['advanced', record.id]]);
  });

  test('已保存展示物理线、旧记录服务线及进阶线路顺序，并保留保存顺序', async () => {
    const secondService = { ...network.services[0], id: 'S2', name: '接续线' };
    const withServices = { ...network, services: [...network.services, secondService] };
    const basic = [
      { ...fact({ id: 'first', occurredOn: '2024-06-01' }), physicalLineId: 'L1', serviceLineIds: [], note: '乘车备注' },
      fact({ id: 'second', occurredOn: '2024-01-01' }),
      { ...fact({ id: 'third' }), physicalLineId: 'unknown-line' },
    ];
    const advanced = [fact({ id: 'advanced', serviceLineIds: ['S2', 'S1'] })];
    const summaries = summarizeRecords({ basic, advanced }, withServices);
    expect(summaries.map(row => row.id)).toEqual(['first', 'second', 'third', 'advanced']);
    expect(summaries.map(row => row.lineNames)).toEqual([['一号线'], ['一号线'], ['unknown-line'], ['接续线', '一号线']]);
    const wrapper = mount(SavedRecordsPanel, { props: { network: withServices, facts: { basic, advanced } } });
    wrappers.push(wrapper);
    const rows = wrapper.findAll('.list > li');
    expect(rows[0].get('time').attributes('datetime')).toBe('2024-06-01');
    expect(rows[0].get('.record-line').text()).toBe('线路：一号线');
    expect(rows[0].get('.record-note').text()).toBe('乘车备注');
    expect(rows[1].get('time').text()).toBe('2024-01-01');
    await wrapper.findAll('.layers button')[1].trigger('click');
    expect(wrapper.get('.record-line').text()).toBe('线路：接续线 → 一号线');
  });

  test('部分重叠：预览列出将保存的分段与段数，提交不被拦截', async () => {
    // 当前 A→D 有两段，已有记录只覆盖 sAB：保存时扣除 sAB，只写入 B→D 一段。
    const partialView = buildDateView(network, { onDate: ON_DATE, fromStationId: 'A', toStationId: 'D', serviceLineId: 'S1' });
    expect(partialView.normalSections.map(section => section.id)).toEqual(['sAB', 'sBD']);
    const wrapper = mount(RecordsPanel, { props: { network, view: partialView, facts: { basic: [fact()], advanced: [] } } });
    wrappers.push(wrapper);
    expect(wrapper.get('.save-preview').text()).toBe('本次将保存 1 段：站B→站D（1/2 段此前已记录）。');
    for (const stale of ['保存不会拦截', '统计按区间去重', '按区间重叠规则校验', '保存后统计不会重复计算']) {
      expect(wrapper.text()).not.toContain(stale);
    }
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('form.form').trigger('submit');
    expect(wrapper.emitted('add')).toHaveLength(1);
  });

  test('中间段已记录：预览列出两段拆分；完全覆盖说明不会产生新记录', () => {
    // A→E 共 4 段，中间 B→D 已记录：保存时拆成 A→B 与 D→E 两段。
    const splitNetwork = fourSectionNetwork();
    const splitView = buildDateView(splitNetwork, { onDate: ON_DATE, fromStationId: 'A', toStationId: 'E', serviceLineId: 'S1' });
    expect(splitView.normalSections.map(section => section.id)).toEqual(['sAB', 'sBC', 'sCD', 'sDE']);
    const middle = fact({ fromStationId: 'B', toStationId: 'D', sectionIds: ['sBC', 'sCD'] });
    const split = mount(RecordsPanel, { props: { network: splitNetwork, view: splitView, facts: { basic: [middle], advanced: [] } } });
    wrappers.push(split);
    expect(split.get('.save-preview').text()).toBe('本次将保存 2 段：站A→站B、站D→站E（2/4 段此前已记录）。');

    const full = mount(RecordsPanel, { props: { network, view, facts: { basic: [fact()], advanced: [] } } });
    wrappers.push(full);
    expect(full.get('.save-preview').text()).toBe('本次区间全部此前已记录，保存不会产生新记录。');
    expect(full.text()).not.toContain('保存不会拦截');
    expect(full.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
  });

  test('没有已验证径路或没有已记录区间时不显示保存预览', () => {
    expect(render([]).find('.save-preview').exists()).toBe(false);
    const other = mount(RecordsPanel, { props: { network, view, facts: { basic: [{ ...fact(), sectionIds: ['sCD'] }], advanced: [] } } });
    wrappers.push(other);
    expect(other.find('.save-preview').exists()).toBe(false);
  });

  test('旧记录缺 sectionIds 时视为未覆盖：不显示预览、不抛错、仍可提交', async () => {
    const legacy = { id: 'legacy', occurredOn: ON_DATE, fromStationId: 'A', toStationId: 'B', serviceLineIds: ['S1'], note: '', vehicle: '' };
    const wrapper = mount(RecordsPanel, { props: { network, view, facts: { basic: [legacy], advanced: [] } } });
    wrappers.push(wrapper);
    expect(wrapper.find('.save-preview').exists()).toBe(false);
    await wrapper.get('form.form').trigger('submit');
    expect(wrapper.emitted('add')).toHaveLength(1);
  });

  test('保存回执按实际写入结果反馈：单段、多段与未产生新记录', async () => {
    // 单段：说明保存了哪一段并清空备注。
    const single = render([]);
    await single.get('#record-note').setValue('单段');
    await single.get('form.form').trigger('submit');
    const singleId = (single.emitted('add')![0][0] as { id: string }).id;
    await single.setProps({ savedRecordId: singleId,
      lastSave: { total: 2, covered: 1, runs: [{ id: singleId, fromStationId: 'B', toStationId: 'D', sectionIds: ['sBD'] }] } });
    expect(single.text()).toContain('基础记录已保存：站B→站D。');
    expect((single.get('#record-note').element as HTMLInputElement).value).toBe('');

    // 多段：反馈列出拆分后的每一段。
    const split = render([]);
    await split.get('#record-note').setValue('多段');
    await split.get('form.form').trigger('submit');
    const splitId = (split.emitted('add')![0][0] as { id: string }).id;
    await split.setProps({ savedRecordId: splitId, lastSave: { total: 4, covered: 2, runs: [
      { id: splitId, fromStationId: 'A', toStationId: 'B', sectionIds: ['sAB'] },
      { id: `${splitId}-2`, fromStationId: 'C', toStationId: 'D', sectionIds: ['sCD'] },
    ] } });
    expect(split.text()).toContain('基础记录已拆分为 2 段保存：站A→站B、站C→站D。');
    expect((split.get('#record-note').element as HTMLInputElement).value).toBe('');

    // 全部已记录：不产生新记录，备注保留，避免让人以为输入已被采纳。
    const duplicate = render([]);
    await duplicate.get('#record-note').setValue('重复');
    await duplicate.get('form.form').trigger('submit');
    const duplicateId = (duplicate.emitted('add')![0][0] as { id: string }).id;
    await duplicate.setProps({ savedRecordId: duplicateId, lastSave: { total: 1, covered: 1, runs: [] } });
    expect(duplicate.text()).toContain('本次区间全部此前已记录，未产生新记录。');
    expect((duplicate.get('#record-note').element as HTMLInputElement).value).toBe('重复');
  });

  test('保存失败保留备注且可重试；重算失败保留已有重试入口', async () => {
    const wrapper = render([]);
    await wrapper.get('#record-note').setValue('保留');
    await wrapper.get('form.form').trigger('submit');
    await wrapper.setProps({ alert: { message: '本地写入失败', retryable: true } });
    expect((wrapper.get('#record-note').element as HTMLInputElement).value).toBe('保留');
    expect(wrapper.text()).toContain('本地写入失败');
    await wrapper.get('form.form').trigger('submit');
    expect(wrapper.emitted('add')).toHaveLength(2);
    await wrapper.findAll('button').find(button => button.text() === '重试统计')!.trigger('click');
    expect(wrapper.emitted('retry-calculation')).toHaveLength(1);
  });

  test('等待保存时用户新写的备注不会被成功回执清空', async () => {
    const wrapper = render([]);
    await wrapper.get('#record-note').setValue('第一条');
    await wrapper.get('form.form').trigger('submit');
    const command = wrapper.emitted('add')![0][0] as { id: string };
    await wrapper.get('#record-note').setValue('下一条');
    await wrapper.setProps({ savedRecordId: command.id });
    expect((wrapper.get('#record-note').element as HTMLInputElement).value).toBe('下一条');
  });
});
