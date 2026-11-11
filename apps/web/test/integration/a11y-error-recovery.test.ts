import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { choose } from '../search-select';
import { buildStatistics } from '../../../../packages/application/completion.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { fixtureNetwork } from './fixtures';
import { failureMessage } from '../../src/integration/workspace';
import type { Workspace, WorkspaceOperation, WorkspaceSnapshot, WorkspaceState } from '../../src/integration/workspace';
import App from '../../src/App.vue';

/**
 * 读屏走查的两处修复（维护者选 A）：
 * 1) 失败横幅按实际操作说话，并给出真正会重提载荷的「重试保存」；
 * 2) 数据源/统计基准日变化后自动重算一次，且可播报、可去重、失败不无限重试。
 *
 * 工作区在这里是可控替身：真实 IndexedDB 的行为与配额注入已由 integration 测试覆盖，
 * 本文件只验证 App 的编排与用户可见文案/行为。
 */
const cfg = vi.hoisted(() => ({
  load: vi.fn(),
  select: vi.fn(),
  open: vi.fn(),
  calculate: vi.fn(),
  add: vi.fn(),
  derived: null as unknown,
  calculation: null as {
    status: 'pending' | 'running' | 'ready' | 'failed';
    generation: number;
    context: { onDate: string; snapshotId: string } | null;
    error: string | null;
  } | null,
  addFailure: false,
  calculateFailure: false,
}));

vi.mock('../../src/network-loader', () => ({
  createNetworkLoader: () => ({ load: cfg.load, select: cfg.select, dispose() {} }),
}));

vi.mock('../../src/integration/workspace', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/integration/workspace')>();
  return {
    ...actual,
    createWorkspace: (): Workspace => {
      let state: WorkspaceState = { phase: 'idle', message: '', errorCode: null, retryable: false, snapshot: null, failure: null };
      let listener: (next: WorkspaceState) => void = () => {};
      let opened = false;
      const snapshot = (): WorkspaceSnapshot => ({
        revision: 0,
        facts: { basic: [], advanced: [] },
        derived: cfg.derived as WorkspaceSnapshot['derived'],
        calculation: cfg.calculation,
      });
      const ready = (lastSave: WorkspaceState['lastSave'] = null): WorkspaceState => ({
        phase: 'ready', message: '', errorCode: null, retryable: false, snapshot: snapshot(), lastSave, failure: null,
      });
      const emit = (next: WorkspaceState): WorkspaceState => { state = next; listener(next); return next; };
      const failed = (operation: WorkspaceOperation, message: string): WorkspaceState => ({
        ...ready(), phase: 'error', message, errorCode: 'E_STORAGE', retryable: true,
        failure: { operation, code: 'E_STORAGE', message, retryable: true },
      });
      return {
        getState: () => state,
        isOpen: () => opened,
        subscribe(fn) { listener = fn; return () => {}; },
        async open() { cfg.open(); opened = true; return emit(ready()); },
        async retry() { opened = true; return emit(ready()); },
        async calculate(network, onDate) {
          await cfg.calculate(network, onDate);
          if (cfg.calculateFailure) {
            return emit(failed('calculate', actual.failureMessage('E_STORAGE', new Error('quota'), '', 'calculate')));
          }
          // 发布成功：结果上下文与本次输入对齐，后续自动检查不会重复触发。
          cfg.calculation = { status: 'ready', generation: 1, context: { onDate, snapshotId: network.snapshotId }, error: null };
          return emit(ready());
        },
        async addRecord(_view, command) {
          cfg.add(_view, command);
          if (cfg.addFailure) {
            return emit(failed('save-basic', actual.failureMessage('E_STORAGE', new Error('quota'), '', 'save-basic')));
          }
          return emit(ready({ total: 1, covered: 0, runs: [
            { id: command.id, fromStationId: 'A', toStationId: 'B', sectionIds: ['sAB'] },
          ] }));
        },
        async writeAdvanced() { return emit(ready()); },
        async removeRecord() { return emit(ready()); },
        async editMetadata() { return emit(ready()); },
        async exportBackup() { return { text: '{}', filename: 'backup.json' }; },
        async previewImport() { return {}; },
        async finishImport() { return emit(ready()); },
        dispose() {},
      };
    },
  };
});

const wrappers: ReturnType<typeof mount>[] = [];
const render = () => { const wrapper = mount(App); wrappers.push(wrapper); return wrapper; };
const buttonLabels = (wrapper: ReturnType<typeof mount>): string[] =>
  wrapper.findAll('button').map(button => button.text());

async function choosePair(wrapper: ReturnType<typeof mount>, from: string, to: string): Promise<void> {
  const toggle = wrapper.get('.manual__toggle');
  if (toggle.attributes('aria-expanded') !== 'true') await toggle.trigger('click');
  await choose(wrapper, 'record-origin', from);
  await choose(wrapper, 'record-destination', to);
}

async function enterTrip(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.get('.modes button').trigger('click');
  await choose(wrapper, 'line-finder-query', 'L1');
  await choosePair(wrapper, 'A', 'B');
}

const staleCalculation = (snapshotId: string): NonNullable<typeof cfg.calculation> => ({
  status: 'ready', generation: 1, context: { onDate: '2024-01-01', snapshotId }, error: null,
});

/** 统计页需要完整的 derived.statistics；空记录也有一份合法结果，避免用半截数据触发校验异常。 */
const derivedFixture = (network: TransitNetwork) => ({
  statistics: buildStatistics(network, [], [], '2026-10-30'),
  overall: [],
  stations: [],
});

beforeEach(() => {
  vi.setSystemTime(new Date(2026, 9, 30, 12, 0, 0));
  vi.clearAllMocks();
  cfg.derived = null;
  cfg.calculation = null;
  cfg.addFailure = false;
  cfg.calculateFailure = false;
  const network = fixtureNetwork();
  cfg.derived = derivedFixture(network);
  cfg.select.mockReturnValue({ snapshotId: network.snapshotId });
  cfg.load.mockResolvedValue({ kind: 'ready', data: {
    network,
    networks: new Map([[network.snapshotId, network]]),
    coverage: { earliestCoverageFrom: '1997-01-01', latestCoverageTo: '2030-12-31' },
  } });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});

describe('保存失败：按操作说话并提供真正的重试保存', () => {
  test('失败后出现「重试保存」，点击会用同一份载荷重新提交，而不是重算统计', async () => {
    cfg.addFailure = true;
    const wrapper = render(); await flushPromises();
    await enterTrip(wrapper);
    await wrapper.get('#record-note').setValue('保留的备注');
    await wrapper.get('form.form').trigger('submit'); await flushPromises();

    // 横幅说的是「记录未保存」，并给出与保存对应的动作；不再出现「重新打开工作区」这种错位按钮。
    const banner = wrapper.get('.app-error');
    expect(banner.text()).toContain('记录未保存');
    expect(banner.text()).not.toContain('统计结果未更新');
    expect(buttonLabels(wrapper)).toContain('重试保存');
    expect(buttonLabels(wrapper)).not.toContain('重新打开工作区');
    expect(cfg.calculate).not.toHaveBeenCalled();
    const firstSave = cfg.add.mock.calls[0];

    cfg.addFailure = false;
    await wrapper.findAll('button').find(button => button.text() === '重试保存')!.trigger('click');
    await flushPromises();

    // 同一份载荷原样重提：view（日期/起终点）与 command（含备注）都不重新收集。
    expect(cfg.add).toHaveBeenCalledTimes(2);
    expect(cfg.add.mock.calls[1]).toEqual(firstSave);
    expect(buttonLabels(wrapper)).not.toContain('重试保存');
  });
});

describe('统计重算失败的文案不再冒充保存', () => {
  test('自动重算写入失败时横幅说「统计结果未更新」，并给「重新计算」', async () => {
    cfg.derived = { overall: [] };
    cfg.calculation = staleCalculation('old-snapshot');
    cfg.calculateFailure = true;
    const wrapper = render(); await flushPromises();

    expect(cfg.calculate).toHaveBeenCalledOnce();
    const banner = wrapper.get('.app-error');
    expect(banner.text()).toContain('统计结果未更新');
    expect(banner.text()).not.toContain('记录未保存');
    expect(buttonLabels(wrapper)).toContain('重新计算');
    expect(buttonLabels(wrapper)).not.toContain('重试保存');
  });

  test('文案函数按操作区分存储失败与输入变化', () => {
    const quota = Object.assign(new Error('quota'), { code: 'E_STORAGE' });
    expect(failureMessage('E_STORAGE', quota, '兜底', 'save-basic')).toContain('记录未保存');
    const recalculated = failureMessage('E_STORAGE', quota, '兜底', 'calculate');
    expect(recalculated).toContain('统计结果未更新');
    expect(recalculated).not.toContain('记录未保存');
    expect(failureMessage('E_ABORT', new Error('fence'), '兜底', 'calculate')).toContain('统计输入已变化');
  });
});

describe('自动重算：触发一次、同一输入不重复、失败不无限重试', () => {
  test('打开后旧结果自动补算一次，之后同一输入不再触发', async () => {
    cfg.calculation = staleCalculation('old-snapshot');
    const wrapper = render(); await flushPromises();

    expect(cfg.calculate).toHaveBeenCalledOnce();
    expect(cfg.calculate.mock.calls[0]?.[1]).toBe('2026-10-30');
    for (const tab of ['stats', 'records', 'stats']) {
      await wrapper.get(`#tab-${tab}`).trigger('click'); await flushPromises();
    }
    expect(cfg.calculate).toHaveBeenCalledOnce();
    expect(wrapper.get('#stats-calc').text()).toContain('统计结果对应 2026-10-30');
  });

  test('没有已发布结果时不自动重算，待重算状态仍保留显式「重新计算」', async () => {
    cfg.calculation = { status: 'pending', generation: 0, context: null, error: null };
    cfg.derived = null;
    const wrapper = render(); await flushPromises();
    expect(cfg.calculate).not.toHaveBeenCalled();
    await wrapper.get('#tab-stats').trigger('click'); await flushPromises();
    expect(cfg.calculate).not.toHaveBeenCalled();
    expect(wrapper.get('#stats-calc').text()).toContain('等待重算统计');
    expect(buttonLabels(wrapper)).toContain('重新计算');
  });

  test('自动重算失败后不再自动重试，只保留显式入口', async () => {
    cfg.calculation = staleCalculation('old-snapshot');
    cfg.calculateFailure = true;
    const wrapper = render(); await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledOnce();

    for (const tab of ['stats', 'records', 'stats', 'records', 'stats']) {
      await wrapper.get(`#tab-${tab}`).trigger('click'); await flushPromises();
    }
    expect(cfg.calculate).toHaveBeenCalledOnce();
    expect(wrapper.findAll('button').some(button => button.text() === '重新计算')).toBe(true);
  });

  test('自动重算进行中统计页播报「正在计算」，完成后换成对应日期的结果', async () => {
    const network = fixtureNetwork();
    cfg.calculation = staleCalculation('old-snapshot');
    let release!: () => void;
    cfg.calculate.mockImplementationOnce(() => new Promise<void>(resolve => {
      release = () => {
        cfg.calculation = { status: 'ready', generation: 2, context: { onDate: '2026-10-30', snapshotId: network.snapshotId }, error: null };
        resolve();
      };
    }));
    const wrapper = render(); await flushPromises();
    await wrapper.get('#tab-stats').trigger('click'); await flushPromises();

    expect(wrapper.get('#stats-calc').text()).toContain('正在计算 2026-10-30 的统计');
    expect(buttonLabels(wrapper)).not.toContain('重新计算');
    release(); await flushPromises();
    expect(wrapper.get('#stats-calc').text()).toContain('统计结果对应 2026-10-30');
  });
});
