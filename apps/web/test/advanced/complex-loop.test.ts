/**
 * 实施票 14「复杂环线与非环线回归护栏」的构造数据部分。
 *
 * 两件事：
 * 1. 把「只支持简单环线」这条边界用构造数据钉死：支线／度数≠2、两环共享一站、半环。
 *    复杂环线按拒绝矩阵逐目标判定（真有多条径路的站不可选、沿用既有 E_MULTIPATH 与原文案，
 *    其余站照常录入），半环按普通服务处理、零提示。纯拓扑谓词本身由票 07 在
 *    `packages/application/test/simple-cycle.test.mjs` 覆盖；这里测的是页面选路与界面表现。
 * 2. 非环线全量护栏（真实快照、golden 夹具）已拆到 `non-loop-regression.test.ts`：那个文件
 *    负责 27 条服务的候选标签、有序到站、可保存性与保存字段，本文件不再加载真实快照。
 *    两个文件互补：这里用最小拓扑逼出拒绝矩阵，那里用真实数据锁住普通服务的行为不漂移。
 */
import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import { serviceCycle } from '../../../../packages/application/simple-cycle.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import AdvancedPanel from '../../src/advanced/AdvancedPanel.vue';
import {
  chainErrorCode,
  legFromResolution,
  resolveServicePaths,
  serviceDirections,
} from '../../src/advanced/chain';
import type { ChainError, ServiceCandidate } from '../../src/advanced/chain';
import type { AdvancedRecordInput } from '../../src/advanced/panelTypes';
import { serviceCandidates } from '../../src/integration/trip';
import { choose, optionValues } from '../search-select';

const period = { from: '2020-01-01', until: null };
const BUILD_ON = '2024-06-10';

/* ---------- 构造数据：复杂环线与半环 ---------- */

interface StationSpec { readonly id: string; readonly name?: string }
interface EdgeSpec { readonly id: string; readonly a: string; readonly b: string }

/** 单线路、单服务的小网络：区间序号即数组顺序，方向标签为空（本票不测标签）。 */
function builtNetwork(stations: readonly StationSpec[], edges: readonly EdgeSpec[]): TransitNetwork {
  const rows = stations.map(row => ({
    id: row.id, code: row.id, name: row.name ?? row.id, cityId: 'c1', latitude: 0, longitude: 0,
  }));
  const line = { id: 'L1', name: '环线', operatorId: 'op1', isLoop: true, foldStationId: null, directions: [], ...period };
  const service = { id: 'S1', name: '示例环线', operatorId: 'op1', directions: [], ...period };
  const sections = edges.map(edge => ({
    id: edge.id, lineId: 'L1', fromStationId: edge.a, toStationId: edge.b,
    lengthMetres: 1000, lengthSource: 'official', ...period,
  }));
  const memberships = edges.map((edge, sequence) => ({ serviceId: 'S1', sectionId: edge.id, sequence, ...period }));
  return {
    snapshotId: 'built', snapshotAsOf: '2024-01-01', knowledgeThrough: '2030-12-31',
    sourceKind: 'development', attribution: {}, releaseReady: false, sourceUse: {},
    stations: rows, lines: [line], services: [service], sections, memberships,
    names: rows.map(row => ({ stationId: row.id, name: row.name, ...period })),
    passengerPeriods: rows.map(row => ({ stationId: row.id, kind: 'passenger', ...period })),
    mappings: [], policies: { noMileageSections: [], closures: [], suspensions: [] },
    cities: [{ id: 'c1', name: '示例市' }], operators: [{ id: 'op1', name: '运营一' }], events: [],
  } as unknown as TransitNetwork;
}

const STATIONS = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id }));

/** 支线：A—B—C—D—A 的环在 C 上多出一段 C—E（C 度 3、E 度 1）。 */
const branch = (): TransitNetwork => builtNetwork(STATIONS, [
  { id: 'AB', a: 'A', b: 'B' }, { id: 'BC', a: 'B', b: 'C' }, { id: 'CD', a: 'C', b: 'D' },
  { id: 'DA', a: 'D', b: 'A' }, { id: 'CE', a: 'C', b: 'E' },
]);

/** 多环：A—B—C—A 与 C—D—E—C 两环共享 C（C 度 4）。 */
const twinLoop = (): TransitNetwork => builtNetwork(STATIONS, [
  { id: 'AB', a: 'A', b: 'B' }, { id: 'BC', a: 'B', b: 'C' }, { id: 'CA', a: 'C', b: 'A' },
  { id: 'CD', a: 'C', b: 'D' }, { id: 'DE', a: 'D', b: 'E' }, { id: 'EC', a: 'E', b: 'C' },
]);

/** 半环：A—B—C—D 的开链（环去掉 CD—A 那条边），按普通服务走唯一径路。 */
const halfRing = (): TransitNetwork => builtNetwork(STATIONS.slice(0, 4), [
  { id: 'AB', a: 'A', b: 'B' }, { id: 'BC', a: 'B', b: 'C' }, { id: 'CD', a: 'C', b: 'D' },
]);

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('预期抛出错误，但没有抛出');
}

/* ---------- 面板挂载 ---------- */

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

function panelFor(net: TransitNetwork, services: readonly ServiceCandidate[]) {
  const wrapper = mount(AdvancedPanel, {
    attachTo: document.body,
    props: { network: net, onDate: BUILD_ON, services, throughServicePairs: [], pending: [] },
  });
  wrappers.push(wrapper);
  return wrapper;
}

/** 面板上是否存在「乘车方向」步骤：块、字段集、单选组三者都不该出现。 */
function hasDirectionStep(wrapper: ReturnType<typeof mount>): boolean {
  return wrapper.find('[aria-labelledby=adv-direction-title]').exists()
    || wrapper.find('.direction-step').exists()
    || wrapper.findAll('input[type="radio"]').length > 0;
}

function lastSaved(wrapper: ReturnType<typeof mount>): AdvancedRecordInput {
  const saves = wrapper.emitted('save') ?? [];
  const last = saves[saves.length - 1];
  if (!last) throw new Error('面板没有提交保存');
  return last[0] as AdvancedRecordInput;
}

/* ---------- 支线／度数≠2 ---------- */

describe('支线／度数≠2：不判环线，多径路目标沿用 E_MULTIPATH（场景 F）', () => {
  test('五个站都不出现方向步骤，纯判定也不是简单环线', () => {
    const net = branch();
    expect(serviceCycle(net, 'S1', BUILD_ON)).toBeNull();
    for (const station of ['A', 'B', 'C', 'D', 'E']) {
      expect(serviceDirections(net, {
        onDate: BUILD_ON, fromStationId: station, serviceLineId: 'S1',
      })).toBeNull();
    }
  });

  test('逐目标判定：只有真成环的 A 是歧义，B／D／E 唯一且区间逐项可核对', () => {
    const paths = resolveServicePaths(branch(), {
      onDate: BUILD_ON, fromStationId: 'C', serviceLineId: 'S1',
    });
    expect(paths.direction).toBeNull();
    expect(paths.loop).toBeNull();
    expect(paths.ambiguous.map(row => row.stationId)).toEqual(['A']);
    expect(paths.reachable.map(row => row.stationId)).toEqual(['B', 'D', 'E']);
    // 每个唯一目标都真能落成一段：区间按运行序给出，不是只断言「可达」。
    const expected = new Map([['B', ['BC']], ['D', ['CD']], ['E', ['CE']]]);
    for (const target of paths.reachable) {
      expect(legFromResolution(paths, target.stationId).sectionIds).toEqual(expected.get(target.stationId));
    }
  });

  test('选中歧义目标抛既有 E_MULTIPATH，文案与 chain.ts 现有字符串逐字一致', () => {
    const paths = resolveServicePaths(branch(), {
      onDate: BUILD_ON, fromStationId: 'C', serviceLineId: 'S1',
    });
    const error = caught(() => legFromResolution(paths, 'A'));
    expect(chainErrorCode(error)).toBe('E_MULTIPATH');
    expect((error as Error).message).toBe('到「A」存在多条径路，不能自动选定；请先核对数据发布');
    expect((error as ChainError).candidates.map(row => row.stationId)).toEqual(['A']);
  });

  test('面板：无方向块、多径路块只列 A，B／D／E 分别选到站并保存', async () => {
    const net = branch();
    const wrapper = panelFor(net, serviceCandidates(net, BUILD_ON));
    await choose(wrapper, 'adv-origin', 'C');
    await choose(wrapper, 'adv-service', 'S1');

    expect(hasDirectionStep(wrapper)).toBe(false);
    expect(wrapper.get('.step').text()).toBe('当前步骤：选择本段到达站');
    expect(wrapper.get('.ambiguous').text()).toContain('A');
    expect(wrapper.get('.ambiguous').text()).not.toContain('B');
    // 「多条径路」只对真正多径路的 A 显示；可达目标只有 B／D／E。
    expect(await optionValues(wrapper, 'adv-target')).toEqual(['B', 'D', 'E']);
    expect(wrapper.get('.notice').text()).toContain('当日有 3 个唯一径路目标、1 个多径路目标');

    // 每个唯一目标各走一次完整面板流程（重置起点后重选），证明「可选定并保存」不是空话。
    const expected = new Map([['B', ['BC']], ['D', ['CD']], ['E', ['CE']]]);
    for (const [target, sectionIds] of expected) {
      await choose(wrapper, 'adv-origin', 'C');
      await choose(wrapper, 'adv-service', 'S1');
      await choose(wrapper, 'adv-target', target);
      await wrapper.get('[aria-labelledby=adv-save] form').trigger('submit');
      const saved = lastSaved(wrapper);
      expect(saved.fromStationId).toBe('C');
      expect(saved.toStationId).toBe(target);
      expect(saved.sectionIds).toEqual(sectionIds);
    }
  });
});

/* ---------- 多环 ---------- */

describe('多环：两环共享一站也不判方向步骤，逐目标拒绝／放行', () => {
  test('两环共享 C 时没有方向步骤，歧义目标是 A／D／E，只有 B 唯一', () => {
    const net = twinLoop();
    expect(serviceCycle(net, 'S1', BUILD_ON)).toBeNull();
    for (const station of ['A', 'B', 'C', 'D', 'E']) {
      expect(serviceDirections(net, {
        onDate: BUILD_ON, fromStationId: station, serviceLineId: 'S1',
      })).toBeNull();
    }
    const paths = resolveServicePaths(net, { onDate: BUILD_ON, fromStationId: 'C', serviceLineId: 'S1' });
    expect(paths.direction).toBeNull();
    expect(paths.ambiguous.map(row => row.stationId)).toEqual(['A', 'D', 'E']);
    expect(paths.reachable.map(row => row.stationId)).toEqual(['B']);
    for (const target of ['A', 'D', 'E']) {
      const error = caught(() => legFromResolution(paths, target));
      expect(chainErrorCode(error)).toBe('E_MULTIPATH');
      expect((error as Error).message).toBe(`到「${target}」存在多条径路，不能自动选定；请先核对数据发布`);
    }
    expect(legFromResolution(paths, 'B').sectionIds).toEqual(['BC']);
  });

  test('面板：无方向块，多径路块逐项列出 A／D／E，B 可保存', async () => {
    const net = twinLoop();
    const wrapper = panelFor(net, serviceCandidates(net, BUILD_ON));
    await choose(wrapper, 'adv-origin', 'C');
    await choose(wrapper, 'adv-service', 'S1');

    expect(hasDirectionStep(wrapper)).toBe(false);
    expect(wrapper.get('.step').text()).toBe('当前步骤：选择本段到达站');
    const blocked = wrapper.get('.ambiguous').text();
    for (const target of ['A', 'D', 'E']) expect(blocked).toContain(target);
    expect(await optionValues(wrapper, 'adv-target')).toEqual(['B']);

    await choose(wrapper, 'adv-target', 'B');
    await wrapper.get('[aria-labelledby=adv-save] form').trigger('submit');
    const saved = lastSaved(wrapper);
    expect(saved.sectionIds).toEqual(['BC']);
  });
});

/* ---------- 半环 ---------- */

describe('半环：按普通服务处理、零提示（拒绝矩阵第 3 行）', () => {
  test('开链不出现方向步骤，每个目标都唯一', () => {
    const net = halfRing();
    expect(serviceCycle(net, 'S1', BUILD_ON)).toBeNull();
    for (const station of ['A', 'B', 'C', 'D']) {
      expect(serviceDirections(net, {
        onDate: BUILD_ON, fromStationId: station, serviceLineId: 'S1',
      })).toBeNull();
    }
    const paths = resolveServicePaths(net, { onDate: BUILD_ON, fromStationId: 'A', serviceLineId: 'S1' });
    expect(paths.ambiguous).toHaveLength(0);
    expect(paths.direction).toBeNull();
    expect(paths.loop).toBeNull();
    expect(paths.reachable.map(row => row.stationId)).toEqual(['B', 'C', 'D']);
    expect(paths.reachable.every(row => row.sectionIds.length > 0)).toBe(true);
  });

  test('面板：无方向块、无多径路块，步骤/状态文案逐字一致；选站前后都没有环线额外提示', async () => {
    const net = halfRing();
    const wrapper = panelFor(net, serviceCandidates(net, BUILD_ON));
    await choose(wrapper, 'adv-origin', 'A');
    await choose(wrapper, 'adv-service', 'S1');

    // 选站前：只有普通服务的正常反馈；没有方向块、多径路块或告警区。
    expect(hasDirectionStep(wrapper)).toBe(false);
    expect(wrapper.find('.ambiguous').exists()).toBe(false);
    expect(wrapper.find('.error').exists()).toBe(false);
    expect(wrapper.get('.step').text()).toBe('当前步骤：选择本段到达站');
    expect(wrapper.get('.notice').text())
      .toBe('「环线 · 示例环线」当日有 3 个唯一径路目标、0 个多径路目标（不可选）。');
    expect(wrapper.findAll('.warn')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('多条径路');
    expect(wrapper.text()).not.toContain('环线未闭合');

    await choose(wrapper, 'adv-target', 'D');

    // 选站后：步骤与状态文案完整逐字；.warn 只有普通服务的直通说明，不含环线/多径路语义。
    expect(wrapper.get('.step').text()).toBe('当前步骤：可回退或保存');
    expect(wrapper.get('.notice').text()).toBe('已加入一段：A → D。');
    expect(wrapper.findAll('.warn').map(row => row.text())).toEqual([
      '未维护该线路的直通关系；直通只认显式维护的线路对，不按连通性推断。',
      '当前到达站没有可直通线路，如在本站下车可保存本条记录',
    ]);
    expect(wrapper.find('.ambiguous').exists()).toBe(false);
    expect(wrapper.find('.error').exists()).toBe(false);
    expect(hasDirectionStep(wrapper)).toBe(false);
    for (const warn of wrapper.findAll('.warn')) {
      expect(warn.text()).not.toContain('环线');
      expect(warn.text()).not.toContain('多径路');
      expect(warn.text()).not.toContain('方向');
    }

    await wrapper.get('[aria-labelledby=adv-save] form').trigger('submit');
    const saved = lastSaved(wrapper);
    expect(saved.sectionIds).toEqual(['AB', 'BC', 'CD']);
    expect(saved.fromStationId).toBe('A');
    expect(saved.toStationId).toBe('D');
  });
});
