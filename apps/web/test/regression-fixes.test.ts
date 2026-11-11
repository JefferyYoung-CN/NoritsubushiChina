import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { failureMessage } from '../src/integration/workspace';
import { describeCalculation } from '../src/stats/calculation';
import StatsPanel from '../src/stats/StatsPanel.vue';
import RecordsPanel from '../src/records/RecordsPanel.vue';
import SavedRecordsPanel from '../src/records/SavedRecordsPanel.vue';
import BackupPanel from '../src/backup/BackupPanel.vue';
import PendingList from '../src/advanced/PendingList.vue';
import App from '../src/App.vue';
import { fixtureNetwork } from './integration/fixtures';

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('storage error mapping', () => {
  test('quota exhaustion becomes a Chinese E_STORAGE message, raw English never leaks', () => {
    const error = Object.assign(new Error('IndexedDB transaction failed: The quota has been exceeded.'), { code: 'E_STORAGE' });
    const message = failureMessage('E_STORAGE', error, '兜底');
    expect(message).toContain('本地存储写入失败');
    expect(message).not.toContain('quota');
  });
  test('unknown errors keep their own message and fallback', () => {
    expect(failureMessage('E_UNKNOWN', new Error('boom'), '兜底')).toBe('boom');
    expect(failureMessage(undefined, undefined, '兜底')).toBe('兜底');
  });
  test('duplicate identity becomes a Chinese message, raw English never leaks', () => {
    const error = Object.assign(new Error('Duplicate identity'), { code: 'E_DUPLICATE' });
    const message = failureMessage('E_DUPLICATE', error, '兜底');
    expect(message).toContain('记录编号重复');
    expect(message).not.toContain('Duplicate');
  });
});

describe('统计页的待重算入口', () => {
  test('pending 状态在统计页提供重新计算', async () => {
    const calculation = describeCalculation({ status: 'pending', generation: 0, context: null, error: null }, null,
      { onDate: '2026-10-15', snapshotId: 'snap' });
    const wrapper = mount(StatsPanel, { props: { data: null, calculation, cityNames: new Map() } });
    const button = wrapper.findAll('button').find(row => row.text() === '重新计算')!;
    expect(button.exists()).toBe(true);
    expect(button.text()).toBe('重新计算');
    await button.trigger('click');
    expect(wrapper.emitted('recalculate')).toHaveLength(1);
  });
});

describe('statistics panel accessibility', () => {
  const failed = { kind: 'failed', message: '统计失败', retryable: true, showsOldResult: false };
  test('heading level is h2 and the failure summary is focusable and linked to the date field', () => {
    const wrapper = mount(StatsPanel, { props: { data: null, calculation: failed as never, cityNames: new Map(), busy: false } });
    expect(wrapper.find('h2').exists()).toBe(true);
    expect(wrapper.find('h3').exists()).toBe(false);
    const calc = wrapper.find('#stats-calc');
    expect(calc.attributes('tabindex')).toBe('-1');
    expect(calc.attributes('role')).toBe('status');
    const date = wrapper.find('#stats-date');
    // 说明只挂在整个日期控件上一次，三个 spinbutton 不再各念一遍（读屏走查发现 4）。
    expect(date.attributes('aria-describedby')).toBeUndefined();
    expect(wrapper.get('[role="group"][aria-describedby="stats-calc"]').find('#stats-date').exists()).toBe(true);
    expect(wrapper.get('#stats-date').attributes('aria-invalid')).toBe('true');
  });
  test('the table is wrapped in a keyboard-scrollable region', () => {
    expect(source('../src/stats/StatsPanel.vue')).toContain('table-scroll');
  });
});

describe('record form error association', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  test('invalid draft links fields to one alert summary and moves focus there on submit', async () => {
    const wrapper = mount(RecordsPanel, {
      attachTo: document.body,
      props: { network: fixtureNetwork(), view: null, facts: { basic: [], advanced: [] }, busy: false },
    });
    const summary = wrapper.find('#record-problems');
    expect(summary.exists()).toBe(true);
    expect(summary.attributes('role')).toBe('alert');
    expect(wrapper.find('#record-note').attributes('aria-describedby')).toBe('record-problems');
    expect(wrapper.find('#record-note').attributes('aria-invalid')).toBe('true');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(document.activeElement).toBe(summary.element);
    wrapper.unmount();
  });
  test('problem list keeps list semantics inside a single alert container', () => {
    const wrapper = mount(RecordsPanel, {
      props: { network: fixtureNetwork(), view: null, facts: { basic: [], advanced: [] }, busy: false },
    });
    const summary = wrapper.find('#record-problems');
    // role="alert" 放在容器上，<ul> 保持普通列表：<li> 才有 list 父级（axe listitem）。
    expect(summary.element.tagName).toBe('DIV');
    expect(summary.attributes('role')).toBe('alert');
    const list = summary.find('ul');
    expect(list.exists()).toBe(true);
    expect(list.attributes('role')).toBeUndefined();
    const items = summary.findAll('li');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.element.parentElement?.tagName).toBe('UL');
  });
  test('the panel no longer accepts a duplicated message prop (single live status source)', () => {
    expect(source('../src/records/RecordsPanel.vue')).not.toContain('message?: string;');
  });
  test('the panel no longer claims overlap is allowed and statistics deduplicate intervals', () => {
    // 保存时扣除已记录区间并拆分，页面不得再出现「放行 + 统计去重」文案。
    const text = source('../src/records/RecordsPanel.vue');
    for (const stale of ['保存不会拦截', '统计按区间去重', '按区间重叠规则校验', '保存后统计不会重复计算']) {
      expect(text).not.toContain(stale);
    }
    expect(text).toContain('save-preview');
  });
  test('delete confirmation focuses the confirm button rendered inside the v-for row', async () => {
    const basic = [{ id: 'rec-1', occurredOn: '2024-05-01', fromStationId: 'A', toStationId: 'B', note: '', vehicle: '' }];
    const wrapper = mount(SavedRecordsPanel, {
      attachTo: document.body,
      props: { network: fixtureNetwork(), facts: { basic, advanced: [] }, busy: false },
    });
    const row = wrapper.findAll('button').find(button => button.text() === '删除');
    expect(row).toBeTruthy();
    await row?.trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="group"][aria-label="确认删除记录"]').exists()).toBe(true);
    expect(document.activeElement?.tagName).toBe('BUTTON');
    expect(document.activeElement?.textContent).toBe('确认删除');
    wrapper.unmount();
  });
});

describe('delete confirmation releases focus to the persisted section', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  test('record delete focuses the records section, not the row button the parent then unmounts', async () => {
    const basic = [{ id: 'rec-1', occurredOn: '2024-05-01', fromStationId: 'A', toStationId: 'B', note: '', vehicle: '' }];
    const wrapper = mount(SavedRecordsPanel, {
      attachTo: document.body,
      props: { network: fixtureNetwork(), facts: { basic, advanced: [] }, busy: false },
    });
    await wrapper.findAll('button').find(button => button.text() === '删除')?.trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '确认删除')?.trigger('click');
    await flushPromises();
    // 父级异步删除完成后行被卸载；焦点不能因此掉回 BODY。
    await wrapper.setProps({ facts: { basic: [], advanced: [] } });
    await flushPromises();
    const section = wrapper.find('section.records').element;
    expect(wrapper.emitted('remove')).toHaveLength(1);
    expect(section.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(section);
    expect(document.activeElement).not.toBe(document.body);
    wrapper.unmount();
  });

  test('pending delete focuses the pending section, not the row button the parent then unmounts', async () => {
    const wrapper = mount(PendingList, {
      attachTo: document.body,
      props: { items: [{ recordId: 'r1', layer: 'advanced', reason: 'snapshot-mapping-required', message: '来自其他快照' }] },
    });
    await wrapper.findAll('button').find(button => button.text() === '删除…')?.trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '确认删除')?.trigger('click');
    await flushPromises();
    await wrapper.setProps({ items: [] });
    await flushPromises();
    const section = wrapper.find('section.pending').element;
    expect(wrapper.emitted('delete')).toHaveLength(1);
    expect(section.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(section);
    expect(document.activeElement).not.toBe(document.body);
    wrapper.unmount();
  });

  test('cancelling a record delete still returns focus to the row delete button', async () => {
    const basic = [{ id: 'rec-1', occurredOn: '2024-05-01', fromStationId: 'A', toStationId: 'B', note: '', vehicle: '' }];
    const wrapper = mount(SavedRecordsPanel, {
      attachTo: document.body,
      props: { network: fixtureNetwork(), facts: { basic, advanced: [] }, busy: false },
    });
    await wrapper.findAll('button').find(button => button.text() === '删除')?.trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find(button => button.text() === '取消')?.trigger('click');
    await flushPromises();
    expect(wrapper.emitted('remove')).toBeUndefined();
    expect(document.activeElement?.textContent).toBe('删除');
    wrapper.unmount();
  });
});

describe('backup import focus path', () => {
  const state = { phase: 'confirming', message: '', preview: { warning: '整份替换警告', existingRecords: 1, incomingRecords: 2 } };
  test('focus lands on the confirm button and Esc cancels without stealing it back', async () => {
    const wrapper = mount(BackupPanel, { attachTo: document.body, props: { state: state as never, today: '2024-01-01', exporting: false } });
    await flushPromises();
    expect(document.activeElement?.textContent).toContain('确认替换并导入');
    await wrapper.find('.preview').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    wrapper.unmount();
  });
  test('preview group keeps an accessible name', () => {
    const wrapper = mount(BackupPanel, { props: { state: state as never, today: '2024-01-01', exporting: false } });
    const group = wrapper.find('.preview');
    expect(group.attributes('role')).toBe('group');
    expect(group.attributes('aria-labelledby')).toBe('backup-warning');
  });
  test('cancelling the preview returns focus to the file input that opened it', async () => {
    document.body.innerHTML = '';
    const idle = { phase: 'idle', message: '', preview: null, errorCode: null, importedCount: null };
    const cancelled = { ...idle, phase: 'cancelled' };
    const wrapper = mount(BackupPanel, { attachTo: document.body, props: { state: idle as never, today: '2024-01-01', exporting: false } });
    const input = wrapper.find('input[type="file"]');
    (input.element as HTMLInputElement).focus();
    expect(document.activeElement).toBe(input.element);
    const file = new File(['{"records":[]}'], 'backup.json', { type: 'application/json' });
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(wrapper.emitted('import-file')?.[0]?.[0]).toBe('{"records":[]}');

    await wrapper.setProps({ state: state as never });
    await flushPromises();
    expect(document.activeElement?.textContent).toContain('确认替换并导入');

    await wrapper.find('.preview').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    await wrapper.setProps({ state: cancelled as never });
    await flushPromises();
    expect(document.activeElement).toBe(input.element);
    wrapper.unmount();
  });
});

describe('pending list heading levels', () => {
  test('pending records use h3 under the advanced panel h2', () => {
    const wrapper = mount(PendingList, { props: { items: [{ recordId: 'r1', layer: 'advanced', reason: 'snapshot-mapping-required', message: '来自其他快照' }] } });
    expect(wrapper.find('h3#adv-pending').exists()).toBe(true);
    expect(wrapper.find('h4').exists()).toBe(false);
    expect(source('../src/advanced/PendingList.vue')).toContain('h3 { margin: 0; }');
  });
});

describe('map station target and focus ring', () => {
  test('hit circle is enlarged and the global focus outline is no longer suppressed', () => {
    const text = source('../src/map/TransitMap.vue');
    expect(text).toContain('r="22"');
    expect(text).not.toContain('outline: none');
    expect(text).toContain(':focus-visible');
    expect(text).toContain(':aria-pressed');
  });
});

describe('layout guard styles', () => {
  test('danger buttons, global sr-only and tab styles exist', () => {
    expect(source('../src/advanced/PendingList.vue')).toContain('.danger { background: #fff; border-color: #8a1c1c; color: #8a1c1c; }');
    const css = source('../src/style.css');
    expect(css).toContain('.sr-only');
    expect(css).toContain('[role="tab"][aria-selected="true"]');
    expect(css).toContain('.date-field');
  });
  test('390px overflow fixes keep grid children shrinkable', () => {
    expect(source('../src/integration/NetworkBrowser.vue')).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(source('../src/records/SavedRecordsPanel.vue')).toContain('overflow-wrap: anywhere');
    expect(source('../src/records/RecordsPanel.vue')).toContain('min-width: 0');
  });
  test('record trip selects can shrink below their longest option at 390px', () => {
    const css = source('../src/style.css');
    // jsdom 不排版，这里断言规则本身：grid 项与 select 都必须允许收缩（复验实测 381px → 397px）。
    expect(css).toMatch(/\.trip\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.trip label\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.trip select\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/);
  });
});

const mocks = vi.hoisted(() => ({ load: vi.fn(), select: vi.fn(), open: vi.fn(), calculate: vi.fn() }));
vi.mock('../src/network-loader', () => ({ createNetworkLoader: () => ({ load: mocks.load, select: mocks.select, dispose() {} }) }));
vi.mock('../src/integration/workspace', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/integration/workspace')>();
  return { ...actual, createWorkspace: () => {
    type MockState = { phase: string; message: string; errorCode: string | null; retryable: boolean; snapshot: unknown };
    let state: MockState = { phase: 'idle', message: '', errorCode: null, retryable: false, snapshot: null };
    let listener = (_state: MockState): void => {};
    let opened = false;
    const ready = (): MockState => ({ phase: 'ready', message: '', errorCode: null, retryable: false,
      snapshot: { revision: 0, facts: { basic: [], advanced: [] }, derived: null, calculation: { status: 'pending', generation: 0, context: null, error: null } } });
    const emit = (next: MockState): MockState => { state = next; listener(next); return next; };
    return { getState: () => state, isOpen: () => opened, subscribe(fn: typeof listener) { listener = fn; return () => {}; },
      async open() { mocks.open(); opened = true; return emit(ready()); }, async retry() { opened = true; return emit(ready()); },
      async calculate() { mocks.calculate(); return emit(ready()); }, dispose() {} };
  } };
});

describe('App shell accessibility', () => {
  const wrappers: ReturnType<typeof mount>[] = [];
  const render = () => { const wrapper = mount(App); wrappers.push(wrapper); return wrapper; };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue({ snapshotId: 'snap-2024-01-01' });
    const network = fixtureNetwork();
    mocks.load.mockResolvedValue({ kind: 'ready', data: { network, networks: new Map([[network.snapshotId, network]]) } });
  });
  afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); });

  test('skip link target is focusable and the usage note states the single-writer constraint', async () => {
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('#content').attributes('tabindex')).toBe('-1');
    expect(wrapper.text()).toContain('单写者约束');
  });

  test('status is announced once, aria-controls only points at a rendered panel, title follows the view', async () => {
    const wrapper = render();
    await flushPromises();
    const hidden = wrapper.find('p.sr-only');
    const duplicates = wrapper.findAll('p[role="status"]').filter(node => node.text() === hidden.text());
    expect(duplicates).toHaveLength(1);

    expect(wrapper.find('#tab-records').attributes('aria-controls')).toBe('panel-records');
    expect(wrapper.find('#tab-stats').attributes('aria-controls')).toBeUndefined();

    await wrapper.find('#tab-stats').trigger('click');
    await flushPromises();
    expect(document.title).toBe('统计 · 线网数据概览');
    expect(wrapper.find('#tab-stats').attributes('aria-controls')).toBe('panel-stats');
  });

  test('removed views have no tabs or panels and usage keeps the manual acceptance warning', async () => {
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('#tab-image').exists()).toBe(false);
    expect(wrapper.find('#panel-image').exists()).toBe(false);
    expect(wrapper.find('#tab-overview').exists()).toBe(false);
    expect(wrapper.find('#panel-overview').exists()).toBe(false);
    expect(wrapper.get('.usage').text()).not.toContain('图片');
    expect(wrapper.get('.usage').text()).toContain('仍需人工验收');
  });

  test('the wordmark accessible name contains its visible text', async () => {
    const wrapper = render();
    await flushPromises();
    const link = wrapper.find('.wordmark');
    // axe label-content-name-mismatch：可访问名必须包含可见文本（含 .mark 的 N），
    // 因此不再用覆盖式 aria-label，改为可见文本 + sr-only 后缀。
    expect(link.attributes('aria-label')).toBeUndefined();
    expect(link.find('.mark').attributes('aria-hidden')).toBeUndefined();
    const name = link.text();
    expect(name.startsWith('N NoritsubushiCN')).toBe(true);
    expect(link.find('.sr-only').text()).toContain('首页');
  });
});
