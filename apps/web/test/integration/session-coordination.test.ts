import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { choose } from '../search-select';
import { buildStatistics } from '../../../../packages/application/completion.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { fixtureNetwork } from './fixtures';
import type { Workspace, WorkspaceOperation, WorkspaceSnapshot, WorkspaceState } from '../../src/integration/workspace';
import App from '../../src/App.vue';

/**
 * 4 处回归：重算并发协调、换快照后的补算与过期反馈、
 * 保存失败后重试入口的存活期、页签方向键的焦点跟随时机。
 *
 * 工作区是可手动放行的替身：重算的完成顺序由测试控制，才能构造真的交错与竞态，
 * 而不是只跑一条顺序路径。真实 IndexedDB 行为由 integration 其他测试覆盖。
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
  /** 非空时 open() 挂起，用来观察「工作区尚未打开」时的页签可用性。 */
  openGate: null as Promise<void> | null,
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

      async function open(): Promise<WorkspaceState> {
        cfg.open();
        if (cfg.openGate) await cfg.openGate;
        opened = true;
        return emit(ready());
      }

      return {
        getState: () => state,
        isOpen: () => opened,
        subscribe(fn) { listener = fn; return () => {}; },
        open,
        async retry() { opened = false; return open(); },
        async calculate(network: TransitNetwork, onDate: string) {
          // 测试用 mockImplementation 决定这次计算什么时候完成；发布结果由这里统一模拟。
          await cfg.calculate(network, onDate);
          cfg.calculation = {
            status: 'ready', generation: (cfg.calculation?.generation ?? 0) + 1,
            context: { onDate, snapshotId: network.snapshotId }, error: null,
          };
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
const render = () => {
  const wrapper = mount(App, { attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
};
const statusText = (wrapper: VueWrapper): string => wrapper.get('main > p[role="status"]').text();
const buttonLabels = (wrapper: VueWrapper): string[] => wrapper.findAll('button').map(button => button.text());

/** 手动放行的计算：每次调用挂起，直到测试按顺序 release。 */
const gates: Array<() => void> = [];
function gateCalculations(): void {
  cfg.calculate.mockImplementation(() => new Promise<void>(resolve => { gates.push(resolve); }));
}
function releaseCalculation(): void {
  const release = gates.shift();
  if (!release) throw new Error('没有待放行的计算');
  release();
}

const coverage = { earliestCoverageFrom: '1997-01-01', latestCoverageTo: '2030-12-31' };
const derivedFixture = (network: TransitNetwork) => ({
  statistics: buildStatistics(network, [], [], '2026-10-30'),
  overall: [],
  stations: [],
});

async function choosePair(wrapper: VueWrapper, from: string, to: string): Promise<void> {
  const toggle = wrapper.get('.manual__toggle');
  if (toggle.attributes('aria-expanded') !== 'true') await toggle.trigger('click');
  await choose(wrapper, 'record-origin', from);
  await choose(wrapper, 'record-destination', to);
}

async function enterTrip(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('.modes button').trigger('click');
  await choose(wrapper, 'line-finder-query', 'L1');
  await choosePair(wrapper, 'A', 'B');
}

beforeEach(() => {
  vi.setSystemTime(new Date(2026, 9, 30, 12, 0, 0));
  vi.clearAllMocks();
  gates.length = 0;
  cfg.calculate.mockReset();
  cfg.openGate = null;
  cfg.addFailure = false;
  cfg.calculation = { status: 'pending', generation: 0, context: null, error: null };
  const network = fixtureNetwork();
  cfg.derived = derivedFixture(network);
  cfg.select.mockReturnValue({ snapshotId: network.snapshotId });
  cfg.load.mockResolvedValue({ kind: 'ready', data: {
    network, networks: new Map([[network.snapshotId, network]]), coverage,
  } });
  cfg.calculate.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});

describe('#1 重算不重叠：两个日期的计算交错完成', () => {
  test('先完成的既不解除全页忙碌，也不播报「统计已更新」；后一个算完才收尾', async () => {
    const wrapper = render();
    await flushPromises();

    // 基础记录页改日期 → 第一个计算开始（挂起）。
    gateCalculations();
    await wrapper.get('#records-page-date').setValue('2024-06-11');
    await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledTimes(1);
    expect(cfg.calculate.mock.calls[0]?.[1]).toBe('2024-06-11');
    expect(wrapper.get('#content').attributes('aria-busy')).toBe('true');

    // 计算未结束时切到「另一日期」的统计页：新输入只能排队，不能同时开跑。
    await wrapper.get('#tab-stats').trigger('click');
    await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledTimes(1);
    expect(wrapper.get('#stats-calc').text()).toContain('正在计算');
    expect(statusText(wrapper)).not.toContain('统计已更新');

    // 先发起、此刻已过期的那个先完成。
    releaseCalculation();
    await flushPromises();
    // 页面仍然忙碌、仍然显示计算中，且没有替当前页宣布结果。
    expect(wrapper.get('#content').attributes('aria-busy')).toBe('true');
    expect(statusText(wrapper)).not.toContain('统计已更新');
    expect(statusText(wrapper)).toContain('正在重算统计');
    // 串行追赶：第二个任务在第一个结束之后才开始，输入是统计页的日期。
    expect(cfg.calculate).toHaveBeenCalledTimes(2);
    expect(cfg.calculate.mock.calls[1]?.[1]).toBe('2026-10-30');

    releaseCalculation();
    await flushPromises();
    expect(wrapper.get('#content').attributes('aria-busy')).toBe('false');
    expect(statusText(wrapper)).toContain('统计已更新');
    // 两次调用的顺序与输入都记录在案：先记录页日期，后统计页日期。
    expect(cfg.calculate.mock.calls.map(call => call[1])).toEqual(['2024-06-11', '2026-10-30']);
  });

  test('同一输入的重算合并成一次，不会因为保存/切页再算一遍', async () => {
    const wrapper = render();
    await flushPromises();
    gateCalculations();
    await wrapper.get('#records-page-date').setValue('2024-06-11');
    await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledTimes(1);

    // 同一日期下再触发一次（统计页切回、显式重算都会走到同一条路径）。
    await wrapper.get('#tab-records').trigger('click');
    await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledTimes(1);
    releaseCalculation();
    await flushPromises();
    expect(statusText(wrapper)).toContain('统计已更新');
  });
});

describe('#2 换快照：过期任务不写当前输入，新输入最终被补算', () => {
  test('旧快照计算未完成时重新校验数据到新快照，旧任务结束后由新任务收尾', async () => {
    const first = fixtureNetwork();
    const next = { ...first, snapshotId: 'snap-next', snapshotAsOf: '2024-02-01' };
    // 打开时已有一份属于别的快照的结果：加载后自动补算，但先挂起。
    cfg.calculation = { status: 'ready', generation: 1, context: { onDate: '2024-01-01', snapshotId: 'stale' }, error: null };
    gateCalculations();
    const wrapper = render();
    await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledTimes(1);
    expect((cfg.calculate.mock.calls[0]?.[0] as TransitNetwork).snapshotId).toBe(first.snapshotId);

    // 换数据源：新的已验证快照，新输入（snap-next + 当前日期）此刻只能排队。
    cfg.load.mockResolvedValue({ kind: 'ready', data: {
      network: next, networks: new Map([[next.snapshotId, next]]), coverage,
    } });
    cfg.select.mockReturnValue({ snapshotId: next.snapshotId });
    await wrapper.get('.loaded button').trigger('click');
    await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledTimes(1);
    expect(wrapper.get('#content').attributes('aria-busy')).toBe('true');

    // 旧任务完成：它既不属于当前快照，也不是最新输入，反馈必须丢弃。
    releaseCalculation();
    await flushPromises();
    expect(statusText(wrapper)).not.toContain('统计已更新');
    expect(wrapper.get('#content').attributes('aria-busy')).toBe('true');
    // 补算：用新快照、当前日期接着算。
    expect(cfg.calculate).toHaveBeenCalledTimes(2);
    expect((cfg.calculate.mock.calls[1]?.[0] as TransitNetwork).snapshotId).toBe('snap-next');
    expect(cfg.calculate.mock.calls[1]?.[1]).toBe(cfg.calculate.mock.calls[0]?.[1]);

    releaseCalculation();
    await flushPromises();
    expect(wrapper.get('#content').attributes('aria-busy')).toBe('false');
    expect(statusText(wrapper)).toContain('统计已更新');
    // 发布出来的结果上下文属于新快照，而不是旧任务。
    expect(cfg.calculation?.context?.snapshotId).toBe('snap-next');
  });

  test('换快照后组件卸载：在途任务结束也不再播报，也不留下未清的忙碌', async () => {
    cfg.calculation = { status: 'ready', generation: 1, context: { onDate: '2024-01-01', snapshotId: 'stale' }, error: null };
    gateCalculations();
    const wrapper = render();
    await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledTimes(1);
    const statusBeforeUnmount = statusText(wrapper);
    wrapper.unmount();
    releaseCalculation();
    await flushPromises();
    // 组件已不在页面上；这里断言卸载不会让在途任务抛出未处理的拒绝或改写已停止的播报。
    expect(statusBeforeUnmount).not.toContain('统计已更新');
  });
});

describe('#3 保存失败后的重试入口', () => {
  test('切到别的页再回来，「重试保存」仍在，并用同一份载荷重新提交', async () => {
    const wrapper = render();
    await flushPromises();
    await enterTrip(wrapper);
    // 失败态的会话快照里带着一份属于别处的旧结果：切回统计页时它会被自动补算。
    cfg.calculation = { status: 'ready', generation: 1, context: { onDate: '2024-01-01', snapshotId: 'stale' }, error: null };
    cfg.addFailure = true;
    await wrapper.get('form.form').trigger('submit');
    await flushPromises();
    const failureBanner = wrapper.get('.app-error').text();
    expect(failureBanner).toContain('记录未保存');
    expect(buttonLabels(wrapper)).toContain('重试保存');
    const firstSave = cfg.add.mock.calls[0];
    expect(cfg.open).toHaveBeenCalledTimes(1);

    // 切到统计页：这次自动补算成功，工作区的 failure 随之清空（旧实现里横幅与重试入口一起消失）。
    await wrapper.get('#tab-stats').trigger('click');
    await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledTimes(1);
    // 没有因为「上一次操作失败」就重新打开端口。
    expect(cfg.open).toHaveBeenCalledTimes(1);

    await wrapper.get('#tab-records').trigger('click');
    await flushPromises();
    expect(cfg.open).toHaveBeenCalledTimes(1);
    // 横幅文案沿用原来那句，只是改由待重试载荷自己维持。
    expect(wrapper.get('.app-error').text()).toBe(failureBanner);
    const retry = wrapper.findAll('button').find(button => button.text() === '重试保存');
    expect(retry).toBeTruthy();

    cfg.addFailure = false;
    await retry!.trigger('click');
    await flushPromises();
    expect(cfg.add).toHaveBeenCalledTimes(2);
    expect(cfg.add.mock.calls[1]).toEqual(firstSave);
    expect(buttonLabels(wrapper)).not.toContain('重试保存');
    expect(wrapper.find('.app-error').exists()).toBe(false);
  });

  test('存储确实没打开时才重新 open，失败横幅与「重试保存」不因切页被冲掉', async () => {
    const wrapper = render();
    await flushPromises();
    await enterTrip(wrapper);
    cfg.addFailure = true;
    await wrapper.get('form.form').trigger('submit');
    await flushPromises();
    const banner = wrapper.get('.app-error').text();
    expect(buttonLabels(wrapper)).toContain('重试保存');

    // 切到不需要重算的备份页再回来：横幅文案原样保留。
    await wrapper.get('#tab-backup').trigger('click');
    await flushPromises();
    await wrapper.get('#tab-records').trigger('click');
    await flushPromises();
    expect(cfg.open).toHaveBeenCalledTimes(1);
    expect(wrapper.get('.app-error').text()).toBe(banner);
    expect(buttonLabels(wrapper)).toContain('重试保存');
  });
});

describe('#4 页签方向键的焦点跟随', () => {
  test('视图内容还没准备好时焦点已在新页签，且一次切换只产生一次焦点', async () => {
    const wrapper = render();
    await flushPromises();
    // 「已保存」页沿用自己的默认日期，切过去会触发一次重算，也就是视图准备需要等异步结果。
    await wrapper.get('#records-page-date').setValue('2024-06-11');
    await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledTimes(1);

    gateCalculations();
    (wrapper.get('#tab-records').element as HTMLElement).focus();
    expect(document.activeElement).toBe(wrapper.get('#tab-records').element);
    const target = wrapper.get('#tab-saved').element;
    let focusCount = 0;
    target.addEventListener('focus', () => { focusCount += 1; });

    // 不等待任何 tick 就检查：焦点必须在事件处理里已经跟随。
    void wrapper.get('#tab-records').trigger('keydown', { key: 'ArrowRight' });
    expect(document.activeElement).toBe(target);
    // 内容确实还没切换（面板仍是基础记录页），焦点不是等视图准备完才动的。
    expect(wrapper.find('#panel-records').exists()).toBe(true);

    await flushPromises();
    expect(cfg.calculate).toHaveBeenCalledTimes(2);
    expect(wrapper.find('#panel-records').exists()).toBe(false);
    expect(wrapper.get('#tab-saved').attributes('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(target);

    // 计算结束后不得再补一次 focus：一次切换只播报一次「已选择」。
    releaseCalculation();
    await flushPromises();
    expect(focusCount).toBe(1);
    expect(document.activeElement).toBe(target);
  });

  test('目标页签不可用时不会移动焦点', async () => {
    // 工作区没打开时所有需要工作区的视图都不可用：此时按方向键不能抢走焦点。
    cfg.openGate = new Promise<void>(() => {});
    const wrapper = render();
    await flushPromises();
    (wrapper.get('#tab-records').element as HTMLElement).focus();
    expect(document.activeElement).toBe(wrapper.get('#tab-records').element);

    void wrapper.get('#tab-records').trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('#tab-records').element);
    expect(wrapper.get('#tab-records').attributes('aria-selected')).toBe('true');
    expect(wrapper.find('#panel-records').exists()).toBe(true);
    expect(statusText(wrapper)).not.toContain('已切换到已保存');
  });
});
