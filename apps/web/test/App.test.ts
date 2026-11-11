import { choose } from './search-select';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { WorkspaceState } from '../src/integration/workspace';
import type { NetworkLoadState } from '../src/network-loader';
import { fixtureNetwork } from './integration/fixtures';
import { errorFeedback } from '../src/input';
import App from '../src/App.vue';

const mocks = vi.hoisted(() => ({ load: vi.fn(), select: vi.fn(), open: vi.fn(), calculate: vi.fn(), add: vi.fn(), remove: vi.fn(), writeAdvanced: vi.fn(), editMetadata: vi.fn(),
  // 工作区快照里的派生与重算状态：测试用它模拟「重算前/重算后」，不伪造别的派生实现。
  derived: null as unknown, calculation: null as unknown }));
vi.mock('../src/network-loader', () => ({ createNetworkLoader: () => ({ load: mocks.load,
  select: mocks.select, dispose() {} }) }));
vi.mock('../src/integration/workspace', () => ({ createWorkspace: () => {
  let state: WorkspaceState = { phase: 'idle', message: '', errorCode: null, retryable: false, snapshot: null };
  let listener = (_state: WorkspaceState): void => {};
  // 端口是否真的打开：只有没打开时 App 才会重新 open（失败态不再触发重开）。
  let opened = false;
  const ready = (): WorkspaceState => ({ phase: 'ready', message: '', errorCode: null, retryable: false,
    snapshot: { revision: 0, facts: { basic: [], advanced: [] }, derived: mocks.derived as never, calculation: mocks.calculation as never } });
  const emit = (next: WorkspaceState): WorkspaceState => { state = next; listener(next); return next; };
  return { getState: () => state, isOpen: () => opened, subscribe(fn: typeof listener) { listener = fn; return () => {}; },
    async open() { mocks.open(); opened = true; return emit(ready()); }, async retry() { opened = true; return emit(ready()); },
    async calculate(...args: unknown[]) { mocks.calculate(...args);
      // 与 addRecord 相同：'fail' 让工作区进入错误态；App 的自动重算失败路径靠它模拟。
      if (mocks.calculate.mock.results.at(-1)?.value === 'fail') {
        return emit({ ...ready(), phase: 'error', message: '统计写入失败', errorCode: 'E_STORAGE', retryable: true,
          failure: { operation: 'calculate', code: 'E_STORAGE', message: '统计写入失败', retryable: true } });
      }
      return emit(ready()); },
    async addRecord(...args: unknown[]) { mocks.add(...args);
      const outcome = mocks.add.mock.results.at(-1)?.value;
      if (outcome === 'fail') return emit({ ...ready(), phase: 'error', message: 'Storage rejected', errorCode: 'E_STORAGE',
        failure: { operation: 'save-basic', code: 'E_STORAGE', message: 'Storage rejected', retryable: true } });
      return emit(outcome && typeof outcome === 'object' && 'lastSave' in outcome
        ? { ...ready(), lastSave: outcome.lastSave as WorkspaceState['lastSave'] } : ready()); },
    async writeAdvanced(...args: unknown[]) { mocks.writeAdvanced(...args); return emit(mocks.writeAdvanced.mock.results.at(-1)?.value === 'fail' ? { ...ready(), phase: 'error', message: 'Storage rejected', errorCode: 'E_STORAGE', retryable: true,
      failure: { operation: 'save-advanced', code: 'E_STORAGE', message: 'Storage rejected', retryable: true } } : ready()); },
    async editMetadata(...args: unknown[]) { mocks.editMetadata(...args); return emit(mocks.editMetadata.mock.results.at(-1)?.value === 'fail' ? { ...ready(), phase: 'error', message: 'Storage rejected', errorCode: 'E_STORAGE', retryable: true,
      failure: { operation: 'edit', code: 'E_STORAGE', message: 'Storage rejected', retryable: true } } : ready()); },
    async removeRecord(...args: unknown[]) { mocks.remove(...args); return emit(ready()); },
    dispose() {} };
} }));

const wrappers: ReturnType<typeof mount>[] = [];
const render = () => { const wrapper = mount(App); wrappers.push(wrapper); return wrapper; };
/** 手动选站默认收起：先展开面板，再依次选出发站与到达站。 */
async function choosePair(wrapper: ReturnType<typeof mount>, from: string, to: string): Promise<void> {
  const toggle = wrapper.get('.manual__toggle');
  if (toggle.attributes('aria-expanded') !== 'true') await toggle.trigger('click');
  await choose(wrapper, 'record-origin', from);
  await choose(wrapper, 'record-destination', to);
}
beforeEach(() => {
  // 默认业务日期改为浏览器本地“今天”：固定时钟让断言稳定。只 mock Date，不接管定时器，加载超时等逻辑照常。
  vi.setSystemTime(new Date(2026, 9, 30, 12, 0, 0));
  vi.clearAllMocks();
  mocks.calculate.mockReset();
  mocks.derived = null;
  mocks.calculation = { status: 'pending', generation: 0, context: null, error: null };
  mocks.select.mockReturnValue({ snapshotId: 'snap-2024-01-01' });
  const network = fixtureNetwork();
  mocks.load.mockResolvedValue({ kind: 'ready', data: { network, networks: new Map([[network.snapshotId, network]]),
    coverage: { earliestCoverageFrom: '1997-01-01', latestCoverageTo: '2030-12-31' } } });
});
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); vi.useRealTimers(); });

describe('App user flows', () => {
  test('records is the first page and overview and image tabs and panels no longer exist', async () => {
    const wrapper = render(); await flushPromises();
    expect(wrapper.findAll('[role="tab"]').map(node => node.text())).toEqual(['基础记录', '已保存', '统计', '备份', '进阶']);
    expect(wrapper.get('#tab-records').attributes('aria-selected')).toBe('true');
    expect(wrapper.get('#tab-records').attributes('tabindex')).toBe('0');
    expect(wrapper.findAll('[role="tabpanel"]').map(node => node.attributes('id'))).toEqual(['panel-records']);
    expect(wrapper.find('#tab-overview, #tab-image, #panel-overview, #panel-image').exists()).toBe(false);
    expect(wrapper.find('#panel-records .browser').exists()).toBe(true);
    expect(wrapper.find('.views input[type="date"]').exists()).toBe(false);
    expect(wrapper.get('.envelope-notice').text()).toContain('模拟重建封套');
    expect(wrapper.find('#snapshot-title').exists()).toBe(false);
    await wrapper.get('#tab-stats').trigger('click'); await flushPromises();
    expect(wrapper.get('.page-lead').text()).toContain('已乘坐与未乘坐情况');
    const summary = wrapper.get('#panel-stats .data-panel');
    expect(summary.get('h2').text()).toBe('数据快照');
    expect(summary.get('.read-only').text()).toBe('只读预览');
    expect(summary.findAll('.counts dd').map(node => node.text())).toEqual(['4站', '3段', '1条']);
    for (const text of ['snap-2024-01-01', '2024-01-01', '2030-12-31', '示例市', '未声明覆盖范围']) expect(summary.text()).toContain(text);
    expect(wrapper.find('.browser').exists()).toBe(false);
    expect(wrapper.get('.envelope-notice').text()).toContain('模拟重建封套');
  });
  test('every page defaults to local today, clamped to the loaded coverage window', async () => {
    const wrapper = render(); await flushPromises();
    const value = (selector: string) => (wrapper.get(selector).element as HTMLInputElement).value;
    expect(value('#records-page-date')).toBe('2026-10-30');
    expect(mocks.select).toHaveBeenLastCalledWith('2026-10-30');
    await wrapper.get('#tab-stats').trigger('click'); await flushPromises();
    expect(value('#stats-date')).toBe('2026-10-30');
    await wrapper.get('#tab-backup').trigger('click'); await flushPromises();
    expect(wrapper.getComponent({ name: 'BackupPanel' }).props('today')).toBe('2026-10-30');

    // 今天超出已加载覆盖窗口时夹到窗口上界，而不是回去取快照检查日。
    const network = fixtureNetwork();
    mocks.load.mockResolvedValue({ kind: 'ready', data: { network, networks: new Map([[network.snapshotId, network]]),
      coverage: { earliestCoverageFrom: '1997-01-01', latestCoverageTo: '2026-10-30' } } });
    vi.setSystemTime(new Date(2027, 4, 1, 12, 0, 0));
    const clamped = render(); await flushPromises();
    expect((clamped.get('#records-page-date').element as HTMLInputElement).value).toBe('2026-10-30');
    expect(mocks.select).toHaveBeenLastCalledWith('2026-10-30');
  });
  test('typing an incomplete year does not jump the page date to the coverage floor', async () => {
    const wrapper = render(); await flushPromises();
    const field = wrapper.get('#records-page-date');
    const input = () => field.element as HTMLInputElement;
    await field.setValue('0002-10-30'); await flushPromises();
    expect(input().value).toBe('0002-10-30');
    expect(mocks.select).not.toHaveBeenCalledWith('0002-10-30');
    expect(mocks.select).not.toHaveBeenLastCalledWith('1997-01-01');
    await field.trigger('blur'); await flushPromises();
    expect(input().value).toBe('2026-10-30');
  });
  test('each page retains its own date and reapplies it to the selected snapshot when switching tabs', async () => {
    const wrapper = render(); await flushPromises();
    const dateValue = (id: string) => (wrapper.get(id === 'stats' ? '#stats-date' : `#${id}-page-date`).element as HTMLInputElement).value;
    await wrapper.get('#records-page-date').setValue('2024-02-01'); await flushPromises();
    expect(mocks.select).toHaveBeenLastCalledWith('2024-02-01');
    expect(mocks.calculate.mock.calls.at(-1)?.[1]).toBe('2024-02-01');
    await wrapper.get('#tab-stats').trigger('click'); await flushPromises();
    expect(dateValue('stats')).toBe('2026-10-30');
    expect(mocks.select).toHaveBeenLastCalledWith('2026-10-30');
    await wrapper.get('#stats-date').setValue('2024-03-01'); await flushPromises();
    await wrapper.get('#tab-advanced').trigger('click'); await flushPromises();
    expect(dateValue('advanced')).toBe('2026-10-30');
    await wrapper.get('#advanced-page-date').setValue('2024-04-01'); await flushPromises();
    await wrapper.get('#tab-backup').trigger('click'); await flushPromises();
    expect(wrapper.getComponent({ name: 'BackupPanel' }).props('today')).toBe('2026-10-30');
    for (const [page, date] of [['records', '2024-02-01'], ['stats', '2024-03-01'], ['advanced', '2024-04-01']]) {
      await wrapper.get(`#tab-${page}`).trigger('click'); await flushPromises();
      expect(dateValue(page!)).toBe(date);
      expect(mocks.select).toHaveBeenLastCalledWith(date);
      expect(mocks.calculate.mock.calls.at(-1)?.[1]).toBe(date);
    }
  });
  test('switching pages restores the matching network and reports a previously uncovered page date again', async () => {
    const initial = fixtureNetwork();
    const historical = { ...initial, snapshotId: 'historical-2023', snapshotAsOf: '2023-01-01' };
    mocks.load.mockResolvedValue({ kind: 'ready', data: { network: initial,
      networks: new Map([[initial.snapshotId, initial], [historical.snapshotId, historical]]),
      coverage: { earliestCoverageFrom: '1997-01-01', latestCoverageTo: '2030-12-31' } } });
    mocks.select.mockImplementation((date: string) => {
      if (date === '2022-01-01') throw new Error('No verified coverage');
      return { snapshotId: date < '2024-01-01' ? historical.snapshotId : initial.snapshotId };
    });
    const wrapper = render(); await flushPromises();
    await wrapper.get('#records-page-date').setValue('2023-01-01'); await flushPromises();
    expect(wrapper.getComponent({ name: 'NetworkBrowser' }).props('network').snapshotId).toBe(historical.snapshotId);
    await wrapper.get('#tab-stats').trigger('click'); await flushPromises();
    expect(wrapper.getComponent({ name: 'SnapshotSummary' }).props('overview').snapshotId).toBe(initial.snapshotId);
    await wrapper.get('#tab-records').trigger('click'); await flushPromises();
    expect(wrapper.getComponent({ name: 'NetworkBrowser' }).props('network').snapshotId).toBe(historical.snapshotId);
    await wrapper.get('#records-page-date').setValue('2022-01-01'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('没有覆盖所选日期的已验证快照');
    await wrapper.get('#tab-stats').trigger('click'); await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    const calculations = mocks.calculate.mock.calls.length;
    await wrapper.get('#tab-records').trigger('click'); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain(`当前仍生效的快照：${initial.snapshotId}`);
    expect(wrapper.find('.browser').exists()).toBe(false);
    expect(mocks.calculate).toHaveBeenCalledTimes(calculations);
    expect((wrapper.get('#records-page-date').element as HTMLInputElement).value).toBe('2022-01-01');
  });
  test('loading remains visible until a real load result arrives', async () => {
    mocks.load.mockImplementation(() => new Promise<NetworkLoadState>(() => {}));
    const wrapper = render();
    await flushPromises();
    expect(wrapper.text()).toContain('正在加载并校验线网数据');
    expect(wrapper.get('#content').attributes('aria-busy')).toBe('true');
    expect(mocks.open).not.toHaveBeenCalled();
  });
  test('failed loader exposes diagnostic and retry; retry initializes workspace', async () => {
    mocks.load.mockResolvedValueOnce({ kind: 'error', error: { code: 'E_ASSET_MISSING', message: 'missing' } });
    const wrapper = mount(App, { attachTo: document.body }); wrappers.push(wrapper); await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('E_ASSET_MISSING');
    expect(document.activeElement).toBe(wrapper.get('[role="alert"]').element);
    await wrapper.get('[role="alert"] button').trigger('click'); await flushPromises();
    expect(mocks.load).toHaveBeenCalledTimes(2); expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(5);
    expect(document.activeElement).toBe(wrapper.get('[aria-label="数据已就绪"]').element);
  });
  test('valid empty network shows empty state and no fabricated counts', async () => {
    const network = { ...fixtureNetwork(), stations: [], sections: [], services: [] };
    mocks.load.mockResolvedValue({ kind: 'ready', data: { network, networks: new Map([[network.snapshotId, network]]) } });
    const wrapper = render(); await flushPromises();
    expect(wrapper.text()).toContain('当前数据包没有车站或区间');
    await wrapper.get('#tab-stats').trigger('click'); await flushPromises();
    expect(wrapper.findAll('.counts dd').map(node => node.text())).toEqual(['0站', '0段', '0条']);
  });
  test('workspace opens after loading; records and advanced entry require no pre-existing trip', async () => {
    const wrapper = render(); await flushPromises();
    expect(mocks.open).toHaveBeenCalledOnce(); expect(mocks.calculate).not.toHaveBeenCalled();
    for (const id of ['records', 'saved', 'stats', 'backup', 'advanced']) expect(wrapper.get(`#tab-${id}`).attributes('aria-disabled')).toBeUndefined();
    await wrapper.get('#tab-records').trigger('click'); await flushPromises();
    expect(wrapper.find('#record-note').exists()).toBe(false);
    expect(wrapper.find('button[type="submit"]').exists()).toBe(false);
    await wrapper.get('#tab-advanced').trigger('click'); await flushPromises();
    expect(wrapper.get('#adv-origin').attributes('disabled')).toBeUndefined();
  });
  test('arrow navigation moves selection and keyboard focus to the selected tab', async () => {
    const wrapper = mount(App, { attachTo: document.body }); wrappers.push(wrapper);
    await flushPromises();
    await wrapper.get('#tab-records').trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(wrapper.get('#tab-saved').attributes('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(wrapper.get('#tab-saved').element);
  });
  test('top navigation, progressive entry, and saved records are separate', async () => {
    const wrapper = render(); await flushPromises();
    expect(wrapper.get('.views').element.compareDocumentPosition(wrapper.get('main').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wrapper.find('#record-note').exists()).toBe(false);
    expect(wrapper.find('#saved-title').exists()).toBe(false);
    await wrapper.get('.modes button').trigger('click');
    await choose(wrapper, 'line-finder-query', 'L1');
    expect(wrapper.find('.trip').exists()).toBe(true);
    expect(wrapper.find('#record-note').exists()).toBe(false);
    await choosePair(wrapper, 'A', 'B');
    expect(wrapper.find('#record-note').exists()).toBe(true);
    await wrapper.get('#line-finder-query').setValue('没有这条线');
    expect(wrapper.find('.trip').exists()).toBe(false);
    expect(wrapper.find('#record-note').exists()).toBe(false);
    expect(wrapper.find('transit-map').exists()).toBe(false);
    expect(wrapper.get<HTMLInputElement>('#line-finder-query').element.value).toBe('没有这条线');
    await wrapper.get('#tab-saved').trigger('click'); await flushPromises();
    expect(wrapper.findAll('.layers button').map(button => button.text())).toEqual(['基础记录', '进阶记录']);
    expect(wrapper.find('#record-note').exists()).toBe(false);
    await wrapper.get('#tab-stats').trigger('click'); await flushPromises();
    expect(wrapper.findAll('input[type="date"]')).toHaveLength(1);
    expect(wrapper.get('label[for="stats-date"]').text()).toBe('统计基准日');
    expect(wrapper.get<HTMLInputElement>('input[type="checkbox"]').element.checked).toBe(true);
  });
  test('basic save keeps input until committed and triggers statistics', async () => {
    const wrapper = render(); await flushPromises();
    await wrapper.get('#tab-records').trigger('click'); await flushPromises();
    await wrapper.get('.modes button').trigger('click');
    await choose(wrapper, 'line-finder-query', 'L1');
    await choosePair(wrapper, 'A', 'B');
    await wrapper.get('#record-note').setValue('test note');
    await wrapper.get('form.form').trigger('submit'); await flushPromises();
    expect(mocks.add).toHaveBeenCalledOnce(); expect(mocks.calculate).toHaveBeenCalledOnce();
    expect((wrapper.get('#record-note').element as HTMLInputElement).value).toBe('');
  });
  test('完全重复的保存不冒充「记录已保存」，状态播报如实说明未产生新记录', async () => {
    // 本次区间此前已全部记录时领域不写库，界面不能只说「记录已保存」。
    mocks.add.mockReturnValueOnce({ lastSave: { total: 1, covered: 1, runs: [] } });
    const wrapper = render(); await flushPromises();
    await wrapper.get('.modes button').trigger('click');
    await choose(wrapper, 'line-finder-query', 'L1');
    await choosePair(wrapper, 'A', 'B');
    await wrapper.get('form.form').trigger('submit'); await flushPromises();
    const status = wrapper.findAll('p.sr-only').find(node => node.attributes('role') === 'status')!;
    expect(status.text()).toContain('未产生新记录');
    expect(status.text()).not.toContain('记录已保存');
    // 面板回执同样不能只说「记录已保存」；导航里「基础记录」「已保存」是相邻标签，不能整体匹配。
    expect(wrapper.get('.feedback').text()).toContain('未产生新记录');
    expect(wrapper.get('.feedback').text()).not.toContain('记录已保存');
  });
  test('线路图完乘着色随保存成功与切换日期后的重算刷新，重算前只画中性线', async () => {
    // 重算按 (network, onDate) 发布结果：换日期时上下文随之改变，图才能确认结果属于当前日期。
    mocks.calculate.mockImplementation((_network: unknown, onDate: string) => {
      mocks.calculation = { status: 'ready', generation: 1, context: { onDate, snapshotId: 'snap-2024-01-01' }, error: null };
      mocks.derived = onDate === '2026-10-30'
        ? { overall: [{ sectionId: 'sAB', firstCompletedOn: '2024-05-01' }] }
        : { overall: [] };
    });
    const wrapper = render(); await flushPromises();
    await wrapper.get('.modes button').trigger('click');
    await choose(wrapper, 'line-finder-query', 'L1');
    // 还没有当前日期的完乘结果：中性线 + 说明 + 就地恢复入口，不冒充「未乘坐」。
    expect(wrapper.get('[data-section-id="sAB"]').attributes('data-section-state')).toBe('unknown');
    expect(wrapper.get('.completion-note').text()).toContain('不代表「未乘坐」');
    expect(wrapper.find('.completion-retry').exists()).toBe(true);

    // 保存成功 → 重算发布匹配当前日期/快照的结果 → 图上色；未乘坐区间仍是蓝色。
    await choosePair(wrapper, 'A', 'B');
    await wrapper.get('form.form').trigger('submit'); await flushPromises();
    expect(mocks.calculate).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-section-id="sAB"]').attributes('data-section-state')).toBe('completed');
    expect(wrapper.get('[data-section-id="sBD"]').attributes('data-section-state')).toBe('unridden');
    expect(wrapper.find('.completion-note').exists()).toBe(false);
    expect(wrapper.find('.completion-retry').exists()).toBe(false);

    // 切换日期 → 再按新日期的上下文重算；新结果没有已乘坐区间，整条线回到「未乘坐」。
    await wrapper.get('#records-page-date').setValue('2024-06-11'); await flushPromises();
    expect(mocks.calculate).toHaveBeenCalledTimes(2);
    // 改日期会清空临时起终点选择（既有规则），重新选线路后看新结果。
    await choose(wrapper, 'line-finder-query', 'L1');
    expect(wrapper.get('[data-section-id="sAB"]').attributes('data-section-state')).toBe('unridden');
    expect(wrapper.get('[data-section-id="sBD"]').attributes('data-section-state')).toBe('unridden');
  });
  test('加载时的旧日期结果不被当成当前结果：自动补算失败时保持中性线，就地重试后恢复', async () => {
    // 结果还在，但上下文属于别的日期：对当前页面是「日期未知的旧结果」，不能上色。
    mocks.derived = { overall: [{ sectionId: 'sAB', firstCompletedOn: '2024-05-01' }] };
    mocks.calculation = { status: 'ready', generation: 1, context: { onDate: '2024-01-01', snapshotId: 'snap-2024-01-01' }, error: null };
    // 打开后的自动补算第一次失败（不能无限自动重试），之后由用户显式重试。
    mocks.calculate.mockReturnValueOnce('fail');
    mocks.calculate.mockImplementationOnce((_network: unknown, onDate: string) => {
      mocks.calculation = { status: 'ready', generation: 2, context: { onDate, snapshotId: 'snap-2024-01-01' }, error: null };
    });
    const wrapper = render(); await flushPromises();
    expect(mocks.calculate).toHaveBeenCalledOnce();
    await wrapper.get('.modes button').trigger('click');
    await choose(wrapper, 'line-finder-query', 'L1');
    await choosePair(wrapper, 'A', 'B');
    expect(new Set(wrapper.findAll('.route-section-paint').map(node => node.attributes('data-section-state'))))
      .toEqual(new Set(['unknown']));
    expect(wrapper.findAll('.route-ring')).toHaveLength(0);
    expect(wrapper.get('.completion-note').text()).toContain('不代表「未乘坐」');

    await wrapper.get('.completion-retry').trigger('click'); await flushPromises();
    expect(mocks.calculate).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-section-id="sAB"]').attributes('data-section-state')).toBe('completed');
    expect(wrapper.get('[data-section-id="sAB"]').attributes('data-section-selected')).toBe('true');
    expect(wrapper.find('.completion-retry').exists()).toBe(false);
    // 同一输入不会因为页面重进/重渲染再次自动补算。
    await wrapper.get('#tab-records').trigger('click'); await flushPromises();
    expect(mocks.calculate).toHaveBeenCalledTimes(2);
  });
  test('重算进行中只显示说明，不出现重复触发的重算按钮', async () => {
    mocks.calculation = { status: 'running', generation: 1, context: { onDate: '2026-10-30', snapshotId: 'snap-2024-01-01' }, error: null };
    const wrapper = render(); await flushPromises();
    await wrapper.get('.modes button').trigger('click');
    await choose(wrapper, 'line-finder-query', 'L1');
    expect(wrapper.get('.completion-note').text()).toContain('正在重算完乘统计');
    expect(wrapper.find('.completion-retry').exists()).toBe(false);
  });
  test('uncovered historical date blocks records, clears the trip and recovers on another page date', async () => {
    const wrapper = render(); await flushPromises();
    await wrapper.get('#tab-records').trigger('click'); await flushPromises();
    await wrapper.get('.modes button').trigger('click');
    await choose(wrapper, 'line-finder-query', 'L1');
    await choosePair(wrapper, 'A', 'B');
    mocks.select.mockImplementationOnce(() => { throw new Error('No verified coverage'); });
    await wrapper.get('.date-field input').setValue('2023-01-01'); await flushPromises();
    expect(wrapper.text()).toContain('没有覆盖所选日期的已验证快照');
    expect(wrapper.find('button[type=submit]').exists()).toBe(false);
    expect(wrapper.find('.trip').exists()).toBe(false);
    expect(mocks.calculate).not.toHaveBeenCalled();
    await wrapper.get('#tab-stats').trigger('click'); await flushPromises();
    expect(mocks.select).toHaveBeenLastCalledWith('2026-10-30');
    expect(wrapper.text()).not.toContain('没有覆盖所选日期的已验证快照');
    expect((wrapper.get('#stats-date').element as HTMLInputElement).value).toBe('2026-10-30');
  });
  test('failed save retains draft and does not report statistics success', async () => {
    mocks.add.mockReturnValueOnce('fail');
    const wrapper = render(); await flushPromises();
    await wrapper.get('#tab-records').trigger('click'); await flushPromises();
    await wrapper.get('.modes button').trigger('click');
    await choose(wrapper, 'line-finder-query', 'L1');
    await choosePair(wrapper, 'A', 'B');
    await wrapper.get('#record-note').setValue('retain note');
    await wrapper.get('form.form').trigger('submit'); await flushPromises();
    expect((wrapper.get('#record-note').element as HTMLInputElement).value).toBe('retain note');
    expect(wrapper.text()).toContain('Storage rejected');
    expect(mocks.calculate).not.toHaveBeenCalled();
  });

});

describe('App 进阶保存与车辆补录', () => {
  async function enter() {
    const wrapper = render(); await flushPromises();
    await wrapper.get('#tab-advanced').trigger('click'); await flushPromises();
    await choose(wrapper, 'adv-origin', 'A');
    await choose(wrapper, 'adv-service', 'S1');
    await choose(wrapper, 'adv-target', 'B');
    await wrapper.get('#adv-note').setValue('乘车备注');
    return wrapper;
  }
  test('写入失败保留草稿；成功后补录失败可重试且不创建第二条记录、不重算', async () => {
    const wrapper = await enter();
    mocks.writeAdvanced.mockReturnValueOnce('fail');
    await wrapper.get('.save form').trigger('submit'); await flushPromises();
    expect(wrapper.find('#adv-saved').exists()).toBe(false);
    expect((wrapper.get('#adv-note').element as HTMLInputElement).value).toBe('乘车备注');
    expect(mocks.calculate).not.toHaveBeenCalled();
    await wrapper.get('.save form').trigger('submit'); await flushPromises();
    expect(wrapper.get('#adv-saved').text()).toBe('进阶记录已保存');
    const record = mocks.writeAdvanced.mock.calls.at(-1)![0] as { id: string };
    expect(mocks.calculate).toHaveBeenCalledOnce();
    await wrapper.findAll('button').find(row => row.text() === '填写车辆信息')!.trigger('click');
    const fields = wrapper.findAll('.vehicle-fields input');
    await fields[0].setValue('A型'); await fields[1].setValue('123'); await fields[2].setValue('12F');
    mocks.editMetadata.mockReturnValueOnce('fail');
    await wrapper.get('.saved-prompt form').trigger('submit'); await flushPromises();
    expect(wrapper.get('.saved-prompt [role=alert]').text()).toContain('可重试');
    await wrapper.get('.saved-prompt form').trigger('submit'); await flushPromises();
    expect(mocks.editMetadata).toHaveBeenLastCalledWith('advanced', record.id, { vehicleDetails: { model: 'A型', number: '123', formation: '12F' } });
    expect(wrapper.text()).toContain('车辆信息已保存');
    expect(mocks.writeAdvanced).toHaveBeenCalledTimes(2);
    expect(mocks.calculate).toHaveBeenCalledOnce();
  });
});

describe('错误反馈与环境能力提示', () => {
  test('E_CRYPTO_UNAVAILABLE 映射为不可重试反馈，保留加载器按原因生成的文案', () => {
    const insecure = errorFeedback({ code: 'E_CRYPTO_UNAVAILABLE', message: '当前地址不允许使用浏览器加密接口；请改用 HTTPS，或在本机通过 http://localhost 访问。' });
    expect(insecure.code).toBe('E_CRYPTO_UNAVAILABLE');
    expect(insecure.retryable).toBe(false);
    expect(insecure.message).toContain('HTTPS');
    expect(insecure.message).not.toMatch(/网络连接失败|检查网络/);
    const unsupported = errorFeedback({ code: 'E_CRYPTO_UNAVAILABLE', message: '当前浏览器不支持数据校验所需的 Web Crypto 接口；请升级或更换浏览器。' });
    expect(unsupported.message).toContain('浏览器');
    expect(unsupported.message).not.toBe(insecure.message);
  });

  test('E_CRYPTO_UNAVAILABLE 缺少文案时仍有可执行建议，既有码的可重试语义不变', () => {
    expect(errorFeedback({ code: 'E_CRYPTO_UNAVAILABLE' }).message).toContain('HTTPS');
    expect(errorFeedback({ code: 'E_NETWORK' }).retryable).toBe(true);
    expect(errorFeedback(new TypeError('offline'))).toMatchObject({ code: 'E_NETWORK', retryable: true });
    expect(errorFeedback({ code: 'E_SCHEMA' }).retryable).toBe(false);
  });

  test('E_CRYPTO_UNAVAILABLE 不渲染重新加载按钮，E_NETWORK 仍渲染', async () => {
    mocks.load.mockResolvedValueOnce({ kind: 'error', error: { code: 'E_CRYPTO_UNAVAILABLE', message: '当前地址不允许使用浏览器加密接口；请改用 HTTPS 或本机地址。' } });
    const cryptoWrapper = render(); await flushPromises();
    const alert = cryptoWrapper.get('[role="alert"]');
    expect(alert.text()).toContain('E_CRYPTO_UNAVAILABLE');
    expect(alert.text()).toContain('HTTPS');
    expect(alert.find('button').exists()).toBe(false);
    // 其他错误码的重新加载按钮行为保持不变。
    mocks.load.mockResolvedValueOnce({ kind: 'error', error: { code: 'E_NETWORK', message: 'network' } });
    const networkWrapper = render(); await flushPromises();
    expect(networkWrapper.get('[role="alert"] button').text()).toBe('重新加载');
  });
});
