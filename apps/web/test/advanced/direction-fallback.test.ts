/**
 * 实施票 11「方向标签兜底」。
 *
 * 判据：标签缺失时选项显示「往〈下一站〉方向」、不预选、可保存；标签集不是恰好两个或判不成
 * 一正一反时整套不用、走通用名；坏锚点只忽略该锚点、方向仍可用；界面与读屏不出现「正序／
 * 逆序」等内部说法。构造快照覆盖无标签环线、单标签、冲突标签、坏锚点，全部走完面板到保存。
 *
 * `planDirections` 的 `anchors`／`reason` 是 12 号票写质量报告时要读的契约；这里只断言契约，
 * 导入侧报告不在本票范围。
 */
import { choose } from '../search-select';
import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import { planDirections } from '../../../../packages/application/direction-plan.mjs';
import type { Direction, TransitNetwork } from '../../../../packages/application/reader.mjs';
import AdvancedPanel from '../../src/advanced/AdvancedPanel.vue';
import { serviceDirections } from '../../src/advanced/chain';
import type { AdvancedRecordInput } from '../../src/advanced/panelTypes';
import { serviceCandidates } from '../../src/integration/trip';

const ON = '2024-06-10';
const period = { from: '2020-01-01', until: null };
const CYCLE = ['A', 'B', 'C', 'D'] as const;
/** 环 A—B—C—D—A、起点 A 两侧的下一站：正序一侧 B、反序一侧 D。 */
const GENERIC = ['往B方向', '往D方向'] as const;

function dir(label: string, fromStationId: string | null = null, toStationId: string | null = null): Direction {
  return { label, fromStationId, toStationId };
}

/** 四站环线 A—B—C—D—A；默认服务与线路都没有方向标签，可按需给出标签来源。 */
function ringNetwork(options: {
  readonly serviceLabels?: readonly Direction[];
  readonly lineLabels?: readonly Direction[];
} = {}): TransitNetwork {
  const stations = CYCLE.map(id => ({ id, code: id, name: id, cityId: 'c1', latitude: 0, longitude: 0 }));
  const line = {
    id: 'L1', name: '环线', operatorId: 'op1', isLoop: true, foldStationId: 'A',
    directions: options.lineLabels ?? [], ...period,
  };
  const service = { id: 'S1', name: '环线', operatorId: 'op1', directions: options.serviceLabels ?? [], ...period };
  const sections = [['s1', 'A', 'B'], ['s2', 'B', 'C'], ['s3', 'C', 'D'], ['s4', 'D', 'A']].map(
    ([id, fromStationId, toStationId]) => ({
      id, lineId: 'L1', fromStationId, toStationId, lengthMetres: 1000, lengthSource: 'official', ...period,
    }),
  );
  const memberships = sections.map((row, sequence) => ({ serviceId: 'S1', sectionId: row.id, sequence, ...period }));
  return {
    snapshotId: 'fallback-ring', snapshotAsOf: '2024-01-01', knowledgeThrough: '2030-12-31',
    sourceKind: 'development', attribution: {}, releaseReady: false, sourceUse: {},
    stations, lines: [line], services: [service], sections, memberships,
    names: stations.map(row => ({ stationId: row.id, name: row.name, ...period })),
    passengerPeriods: stations.map(row => ({ stationId: row.id, kind: 'passenger', ...period })),
    mappings: [], policies: { noMileageSections: [], closures: [], suspensions: [] },
    cities: [{ id: 'c1', name: '示例市' }], operators: [{ id: 'op1', name: '运营一' }], events: [],
  } as unknown as TransitNetwork;
}

function offer(net: TransitNetwork) {
  return serviceDirections(net, { onDate: ON, fromStationId: 'A', serviceLineId: 'S1' });
}

describe('方向标签与锚点的判定契约（供数据质量报告读取）', () => {
  test('标签不是恰好两个时整套不用：reason 为 count，没有可对应的锚点对', () => {
    const sets = [
      [dir('外环', 'A', 'B')],
      [dir('外环', 'A', 'B'), dir('内环', 'A', 'D'), dir('备用')],
    ];
    for (const directions of sets) {
      const plan = planDirections(CYCLE, directions);
      expect(plan.usable).toBe(false);
      expect(plan.reason).toBe('count');
      expect(plan.anchors).toEqual([]);
      expect(plan.byDirection).toEqual({ ASC: null, DESC: null });
    }
  });

  test('标签文字为空或重复时整套不用：reason 为 label，锚点清单仍可记录', () => {
    const plans = [
      planDirections(CYCLE, [dir('   ', 'A', 'B'), dir('内环', 'B', 'A')]),
      planDirections(CYCLE, [dir('外环', 'A', 'B'), dir('外环', 'B', 'A')]),
    ];
    for (const plan of plans) {
      expect(plan.usable).toBe(false);
      expect(plan.reason).toBe('label');
      expect(plan.anchors).toEqual(['ASC', 'DESC']);
    }
  });

  test('两个锚点指向同一走法是冲突：reason 为 conflict，两支锚点同向', () => {
    const plan = planDirections(CYCLE, [dir('外环', 'A', 'B'), dir('内环', 'B', 'C')]);
    expect(plan.usable).toBe(false);
    expect(plan.reason).toBe('conflict');
    expect(plan.anchors).toEqual(['ASC', 'ASC']);
    expect(plan.byDirection).toEqual({ ASC: null, DESC: null });
  });

  test('坏锚点逐类都当无锚点：不在环上、两端不相邻、from＝to、只有一端', () => {
    const badAnchors = [
      dir('甲', 'Z', 'A'), // 不在当日环上
      dir('甲', 'A', 'C'), // 在环上但两端不相邻
      dir('甲', 'A', 'A'), // from＝to
      dir('甲', 'A', null), // 只有 from
      dir('甲', null, 'B'), // 只有 to
    ];
    for (const bad of badAnchors) {
      // 另一侧是合法锚点 A→D，定出反序；坏锚点那一侧没有锚点，方向仍可用。
      const plan = planDirections(CYCLE, [bad, dir('乙', 'A', 'D')]);
      expect(plan.usable).toBe(true);
      expect(plan.anchors).toEqual([null, 'DESC']);
      expect(plan.byDirection.DESC).toEqual({ label: '乙', fromStationId: 'A', toStationId: 'D' });
      // 坏锚点不显示给乘客：补出的反向只留标签文字，不带任何锚点站名。
      expect(plan.byDirection.ASC).toEqual({ label: '甲', fromStationId: null, toStationId: null });
    }
  });

  test('两个锚点都坏时整套不用：reason 为 no-anchor', () => {
    const plan = planDirections(CYCLE, [dir('外环', 'Z', 'A'), dir('内环', 'A', 'C')]);
    expect(plan.usable).toBe(false);
    expect(plan.reason).toBe('no-anchor');
    expect(plan.anchors).toEqual([null, null]);
  });
});

describe('标签来源不改变兜底规则', () => {
  // 「线路标签可用时确实被采用」的正向检查在 direction-step.test.ts（物理线路标签兜底
  // 那一组）；这里只证明来源换成线路标签时兜底规则不变，两者互补。
  test('线路只有一个标签时整套不用、走通用名', () => {
    const offered = offer(ringNetwork({ lineLabels: [dir('外环', 'A', 'B')] }));
    expect(offered?.options.map(option => option.label)).toEqual([...GENERIC]);
  });

  test('服务自带坏标签时不改用线路标签：整套不用、走通用名，避免同一环线出现两套名字', () => {
    const offered = offer(ringNetwork({
      serviceLabels: [dir('外环', 'Z', 'A'), dir('内环', 'A', 'C')],
      lineLabels: [dir('顺时针', 'A', 'B'), dir('逆时针', 'A', 'D')],
    }));
    expect(offered?.options.map(option => option.label)).toEqual([...GENERIC]);
  });
});

type Panel = ReturnType<typeof mount>;
const wrappers: Panel[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

function panelFor(net: TransitNetwork): Panel {
  const wrapper = mount(AdvancedPanel, {
    attachTo: document.body,
    props: {
      network: net, onDate: ON, services: serviceCandidates(net, ON),
      throughServicePairs: [], pending: [],
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

interface FallbackScenario {
  readonly title: string;
  readonly network: () => TransitNetwork;
  /** 两个方向的可见文字：兜底时是「往〈下一站〉方向」，标签可用时是标签本身。 */
  readonly optionLabels: readonly string[];
  /** 可见的锚点副文字；没有合法锚点为 null 的一侧不渲染。 */
  readonly anchors: readonly string[];
  /** radio 的读屏名：标签（+ 合法锚点），坏锚点不念给乘客。 */
  readonly ariaLabels: readonly string[];
  /** 选第几个方向（0＝正序项、1＝反序项）。 */
  readonly pick: 0 | 1;
  readonly target: string;
  readonly sectionIds: readonly string[];
}

const scenarios: readonly FallbackScenario[] = [
  {
    title: '无标签环线',
    network: () => ringNetwork(),
    optionLabels: [...GENERIC], anchors: [], ariaLabels: [...GENERIC],
    pick: 1, target: 'D', sectionIds: ['s4'],
  },
  {
    title: '单标签（整套不用）',
    network: () => ringNetwork({ serviceLabels: [dir('外环', 'A', 'B')] }),
    optionLabels: [...GENERIC], anchors: [], ariaLabels: [...GENERIC],
    pick: 0, target: 'B', sectionIds: ['s1'],
  },
  {
    title: '冲突标签（两锚点同向）',
    network: () => ringNetwork({ serviceLabels: [dir('外环', 'A', 'B'), dir('内环', 'B', 'C')] }),
    optionLabels: [...GENERIC], anchors: [], ariaLabels: [...GENERIC],
    pick: 0, target: 'C', sectionIds: ['s1', 's2'],
  },
  {
    title: '单侧坏锚点（方向仍可用）',
    network: () => ringNetwork({ serviceLabels: [dir('外环', 'A', 'B'), dir('内环', 'Z', 'A')] }),
    optionLabels: ['外环', '内环'], anchors: ['A → B'],
    ariaLabels: ['外环，A 到 B 方向', '内环'],
    pick: 1, target: 'D', sectionIds: ['s4'],
  },
  {
    title: '两锚点都坏（整套不用）',
    network: () => ringNetwork({ serviceLabels: [dir('外环', 'Z', 'A'), dir('内环', 'A', 'C')] }),
    optionLabels: [...GENERIC], anchors: [], ariaLabels: [...GENERIC],
    pick: 0, target: 'B', sectionIds: ['s1'],
  },
];

describe('面板：兜底方向全组可录完并保存', () => {
  for (const scenario of scenarios) {
    test(`${scenario.title}：不预选、文字符合兜底规则、读屏不含内部说法、到站唯一`, async () => {
      const wrapper = panelFor(scenario.network());
      await choose(wrapper, 'adv-origin', 'A');
      await choose(wrapper, 'adv-service', 'S1');
      expect(wrapper.get('.step').text()).toBe('当前步骤：选择乘车方向');

      const radios = wrapper.findAll('input[type="radio"]');
      expect(radios).toHaveLength(2);
      // 两个 radio 都未预选：程序不替用户猜方向。
      expect(radios.map(row => (row.element as HTMLInputElement).checked)).toEqual([false, false]);
      expect(wrapper.findAll('.direction-label').map(row => row.text())).toEqual([...scenario.optionLabels]);
      expect(wrapper.findAll('.direction-anchor').map(row => row.text())).toEqual([...scenario.anchors]);
      const ariaLabels = radios.map(row => row.attributes('aria-label') ?? '');
      expect(ariaLabels).toEqual([...scenario.ariaLabels]);

      // 界面文字、选项文字与读屏名都不出现「正序／逆序」这类内部说法。
      for (const exposed of [wrapper.text(), ...ariaLabels]) {
        expect(exposed).not.toMatch(/正序|逆序/);
      }
      // 未选方向前不列到站，也不会出现「多条径路」块。
      expect(wrapper.find('#adv-target').exists()).toBe(false);
      expect(wrapper.find('.ambiguous').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('多条径路');

      await radios[scenario.pick]!.setValue();
      // 选定后的状态播报与卡片也必须用界面语言，不能换成「正序／逆序」这类内部说法。
      expect(wrapper.get('.notice').text()).toContain(`已选 ${scenario.optionLabels[scenario.pick]}`);
      expect(wrapper.text()).not.toMatch(/正序|逆序/);
      expect(wrapper.find('.ambiguous').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('多条径路');
      await choose(wrapper, 'adv-target', scenario.target);
      const card = wrapper.get('.selection-card').text();
      expect(card).toContain(`· ${scenario.optionLabels[scenario.pick]}`);
      expect(card).not.toMatch(/正序|逆序/);

      const saveButton = wrapper.get('[aria-labelledby=adv-save] button');
      expect((saveButton.element as HTMLButtonElement).disabled).toBe(false);
      await wrapper.get('[aria-labelledby=adv-save] form').trigger('submit');
      const saved = wrapper.emitted('save')?.[0]?.[0] as AdvancedRecordInput;
      expect(saved.sectionIds).toEqual([...scenario.sectionIds]);
    });
  }
});
