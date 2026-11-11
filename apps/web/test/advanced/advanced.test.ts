import { describe, expect, test } from 'vitest';
import {
  ChainError,
  appendLeg,
  chainSummary,
  legFromResolution,
  listServicesAtStation,
  resolveServicePaths,
  rollbackLeg,
  startChain,
} from '../../src/advanced/chain';
import { continuationServices } from '../../src/advanced/continuation';
import {
  AdvanceFailure,
  buildAdvancedSave,
  describeAdvanceCounts,
  metadataFromInput,
  pendingReasonText,
  summarizeAdvance,
  withoutRecord,
} from '../../src/advanced/advance';
import {
  describeRecalculation,
  runCancellable,
} from '../../src/advanced/recalculation';
import type { ChainDraft } from '../../src/advanced/chain';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';

const period = { from: '2020-01-01', until: null };
const ON = '2024-06-10';

function network(): TransitNetwork {
  const stations = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((id) => ({
    id, code: id, name: id, cityId: 'c1', latitude: 0, longitude: 0,
  }));
  const case_ = (id: string, name: string, operatorId: string) => ({ id, name, operatorId, ...period });
  const lines = [case_('L1', '一号线', 'op1'), case_('L2', '二号线', 'op1'), case_('L3', '三号线', 'op2'), case_('L5', '五号线', 'op2')];
  const services = [case_('S1', '一号线', 'op1'), case_('S2', '二号线', 'op1'), case_('S3', '三号线', 'op2'), case_('S5', '五号线', 'op2')];
  const section = (id: string, lineId: string, fromStationId: string, toStationId: string, lengthMetres: number) => ({
    id, lineId, fromStationId, toStationId, lengthMetres, lengthSource: 'official', ...period,
  });
  const sections = [
    section('sAB', 'L1', 'A', 'B', 1000),
    section('sBD', 'L1', 'B', 'D', 1000),
    section('sDF', 'L2', 'D', 'F', 800),
    section('sFG', 'L2', 'F', 'G', 700),
    section('sBH', 'L3', 'B', 'H', 500),
    section('xAB', 'L5', 'A', 'B', 1000),
    section('xBD', 'L5', 'B', 'D', 1000),
    section('xAC', 'L5', 'A', 'C', 900),
    section('xCD', 'L5', 'C', 'D', 900),
  ];
  const membership = (serviceId: string, sectionId: string, sequence: number) => ({ serviceId, sectionId, sequence, ...period });
  const memberships = [
    membership('S1', 'sAB', 0), membership('S1', 'sBD', 1),
    membership('S2', 'sDF', 0), membership('S2', 'sFG', 1),
    membership('S3', 'sBH', 0),
    membership('S5', 'xAB', 0), membership('S5', 'xBD', 1), membership('S5', 'xAC', 2), membership('S5', 'xCD', 3),
  ];
  return {
    snapshotId: 'snap1', snapshotAsOf: '2024-01-01', knowledgeThrough: '2030-12-31',
    sourceKind: 'development', attribution: {}, releaseReady: false, sourceUse: {},
    stations, lines, services, sections, memberships,
    names: stations.map((row) => ({ stationId: row.id, name: row.name, ...period })),
    passengerPeriods: stations.map((row) => ({ stationId: row.id, kind: 'passenger', ...period })),
    mappings: [], policies: { noMileageSections: [], closures: [], suspensions: [] },
    cities: [{ id: 'c1', name: '示例市' }],
    operators: [{ id: 'op1', name: '运营一' }, { id: 'op2', name: '运营二' }],
    events: [],
  } as unknown as TransitNetwork;
}

function fact(
  id: string,
  fromStationId: string,
  toStationId: string,
  serviceLineIds: readonly string[],
  sectionIds: readonly string[],
  options: { snapshotId?: string; occurredOn?: string } = {},
) {
  return {
    id,
    occurredOn: options.occurredOn ?? ON,
    networkSnapshotId: options.snapshotId ?? 'snap1',
    fromStationId,
    toStationId,
    serviceLineIds,
    sectionIds,
    note: '',
    vehicle: '',
  };
}

function chainToD(): ChainDraft {
  const net = network();
  let chain = startChain(net, { onDate: ON, fromStationId: 'A' });
  const first = resolveServicePaths(net, { onDate: ON, fromStationId: 'A', serviceLineId: 'S1' });
  chain = appendLeg(chain, legFromResolution(first, 'B'));
  const second = resolveServicePaths(net, { onDate: ON, fromStationId: 'B', serviceLineId: 'S1' });
  return appendLeg(chain, legFromResolution(second, 'D'));
}

describe('首段唯一径路', () => {
  test('候选线路按日期与站点过滤', () => {
    const services = listServicesAtStation(network(), ON, 'A');
    expect(services.map((row) => row.serviceLineId)).toEqual(['S1', 'S5']);
    expect(services[0]?.label).toContain('一号线');
  });

  test('唯一径路直接给出可到达站与区间', () => {
    const paths = resolveServicePaths(network(), { onDate: ON, fromStationId: 'A', serviceLineId: 'S1' });
    expect(paths.ambiguous).toHaveLength(0);
    expect(paths.reachable.map((row) => row.stationId)).toEqual(['B', 'D']);
    const toD = paths.reachable.find((row) => row.stationId === 'D');
    expect(toD?.sectionIds).toEqual(['sAB', 'sBD']);
    expect(toD?.lengthMetres).toBe(2000);
  });

  test('多径路列出候选与不可判定原因，不猜选', () => {
    const paths = resolveServicePaths(network(), { onDate: ON, fromStationId: 'A', serviceLineId: 'S5' });
    expect(paths.ambiguous.map((row) => row.stationId)).toEqual(['D']);
    expect(paths.ambiguous[0]?.reason).toBe('E_MULTIPATH');
    let failure: unknown = null;
    try {
      legFromResolution(paths, 'D');
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof ChainError).toBe(true);
    expect((failure as ChainError).code).toBe('E_MULTIPATH');
    expect((failure as ChainError).candidates.map((row) => row.stationId)).toEqual(['D']);
  });
});

/** 一条 A—B—C—D—E—F 的线性线路（S9），用来验证候选顺序按线路位置而不是区间数。 */
function linearNetwork(): TransitNetwork {
  const stations = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({
    id, code: id, name: id, cityId: 'c9', latitude: 0, longitude: 0,
  }));
  const line = { id: 'L9', name: '九号线', operatorId: 'op9', ...period };
  const service = { id: 'S9', name: '九号线', operatorId: 'op9', ...period };
  const sections = [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'F']].map(([fromStationId, toStationId], index) => ({
    id: `s9-${index}`, lineId: 'L9', fromStationId, toStationId, lengthMetres: 1000, lengthSource: 'official', ...period,
  }));
  const memberships = sections.map((row, sequence) => ({ serviceId: 'S9', sectionId: row.id, sequence, ...period }));
  return {
    snapshotId: 'snap9', snapshotAsOf: '2024-01-01', knowledgeThrough: '2030-12-31',
    sourceKind: 'development', attribution: {}, releaseReady: false, sourceUse: {},
    stations, lines: [line], services: [service], sections, memberships,
    names: stations.map((row) => ({ stationId: row.id, name: row.name, ...period })),
    passengerPeriods: stations.map((row) => ({ stationId: row.id, kind: 'passenger', ...period })),
    mappings: [], policies: { noMileageSections: [], closures: [], suspensions: [] },
    cities: [{ id: 'c9', name: '示例市' }], operators: [{ id: 'op9', name: '运营九' }], events: [],
  } as unknown as TransitNetwork;
}

describe('到达站候选按线路顺序排列', () => {
  test('从中间站出发时，候选沿线从起端到末端，与区间数无关', () => {
    const paths = resolveServicePaths(linearNetwork(), { onDate: ON, fromStationId: 'C', serviceLineId: 'S9' });
    expect(paths.reachable.map((row) => row.stationId)).toEqual(['A', 'B', 'D', 'E', 'F']);
    // A 要坐 2 段、B 只要 1 段；线路顺序把 A 排在 B 前面，说明顺序不再由区间数决定。
    expect(paths.reachable.find((row) => row.stationId === 'A')?.sectionIds).toHaveLength(2);
    expect(paths.reachable.find((row) => row.stationId === 'B')?.sectionIds).toHaveLength(1);
    expect(paths.reachable.map((row) => row.sectionIds.length)).toEqual([2, 1, 1, 2, 3]);
  });

  test('候选集合、区间与里程语义不变', () => {
    const paths = resolveServicePaths(linearNetwork(), { onDate: ON, fromStationId: 'B', serviceLineId: 'S9' });
    expect(paths.reachable.map((row) => row.stationId)).toEqual(['A', 'C', 'D', 'E', 'F']);
    expect(paths.reachable.find((row) => row.stationId === 'E')).toMatchObject({
      sectionIds: ['s9-1', 's9-2', 's9-3'],
      lengthMetres: 3000,
      routeAvailable: true,
    });
  });
});

describe('链式继续、回退与直通边界', () => {
  test('换乘不入链：共享车站不产生候选，直通候选只来自已维护线路对', () => {
    const net = network();
    let chain = startChain(net, { onDate: ON, fromStationId: 'A' });
    chain = appendLeg(chain, legFromResolution(resolveServicePaths(net, {
      onDate: ON, fromStationId: 'A', serviceLineId: 'S1',
    }), 'B'));
    // S3「三号线」在 B 站当日可出发，但 S1—S3 未维护直通关系：不得因共享车站出现。
    const unpaired = continuationServices(net, chain, { throughServicePairs: [] });
    expect(unpaired.services).toHaveLength(0);
    expect(unpaired.notices.join('')).toContain('不按连通性推断');
    const paired = continuationServices(net, chain, { throughServicePairs: [['S3', 'S1']] });
    expect(paired.services.map((row) => row.service.serviceLineId)).toEqual(['S3']);
    expect(paired.services[0]).not.toHaveProperty('mode');
  });

  test('直通只认显式维护关系，没有维护就没有候选', () => {
    const net = network();
    let chain = startChain(net, { onDate: ON, fromStationId: 'A' });
    chain = appendLeg(chain, legFromResolution(resolveServicePaths(net, {
      onDate: ON, fromStationId: 'A', serviceLineId: 'S1',
    }), 'B'));
    const none = continuationServices(net, chain, {});
    expect(none.services).toHaveLength(0);
    expect(none.notices.join('')).toContain('不按连通性推断');
    const linked = continuationServices(net, chainToD(), {
      throughServicePairs: [['S1', 'S2']],
    });
    expect(linked.services.map((row) => row.service.serviceLineId)).toEqual(['S2']);
  });

  test('链式继续后累计一致，回退删除最后一段并保持连续', () => {
    const net = network();
    const chain = chainToD();
    const through = continuationServices(net, chain, { throughServicePairs: [['S1', 'S2']] });
    const next = through.services[0];
    expect(next).toBeDefined();
    const third = resolveServicePaths(net, { onDate: ON, fromStationId: 'D', serviceLineId: 'S2' });
    const full = appendLeg(chain, legFromResolution(third, 'F'));
    const summary = chainSummary(net, full);
    expect(summary.sectionIds).toEqual(['sAB', 'sBD', 'sDF']);
    expect(summary.stations.map((row) => row.stationId)).toEqual(['A', 'B', 'D', 'F']);
    expect(summary.serviceLineIds).toEqual(['S1', 'S2']);
    expect(summary.lengthMetres).toBe(2800);
    const rolled = rollbackLeg(full);
    expect(rolled.removed?.serviceLineId).toBe('S2');
    expect(chainSummary(net, rolled.chain).sectionIds).toEqual(['sAB', 'sBD']);
    expect(chainSummary(net, rolled.chain).toStation?.stationId).toBe('D');
    expect(rollbackLeg(rolled.chain).chain.legs).toHaveLength(1);
    expect(rollbackLeg(startChain(net, { onDate: ON, fromStationId: 'A' })).removed).toBe(null);
  });

  test('不连续与重复区间被拒绝', () => {
    const chain = chainToD();
    let nonContiguous: unknown = null;
    try {
      appendLeg(chain, { serviceLineId: 'S1', fromStationId: 'A', toStationId: 'B', sectionIds: ['sAB'], lengthMetres: 1000 });
    } catch (error) {
      nonContiguous = error;
    }
    expect((nonContiguous as ChainError).code).toBe('E_PATH');
    let repeated: unknown = null;
    try {
      appendLeg(chain, { serviceLineId: 'S1', fromStationId: 'D', toStationId: 'B', sectionIds: ['sBD'], lengthMetres: 1000 });
    } catch (error) {
      repeated = error;
    }
    expect((repeated as ChainError).code).toBe('E_PATH');
  });

  test('超出验证日期范围不能开工', () => {
    let failure: unknown = null;
    try {
      startChain(network(), { onDate: '2099-01-01', fromStationId: 'A' });
    } catch (error) {
      failure = error;
    }
    expect((failure as ChainError).code).toBe('E_DATE');
  });
});

describe('进阶保存：两层完乘与并集', () => {
  test('多段链条保存为一条完整记录，服务按顺序去重', () => {
    const net = network();
    const chain = chainToD();
    const third = resolveServicePaths(net, { onDate: ON, fromStationId: 'D', serviceLineId: 'S2' });
    const full = appendLeg(chain, legFromResolution(third, 'F'));
    const save = buildAdvancedSave(net, full, { id: 'rec-1', note: '试运转', vehicle: 'G1' });
    expect(save.record.fromStationId).toBe('A');
    expect(save.record.toStationId).toBe('F');
    expect(save.record.serviceLineIds).toEqual(['S1', 'S2']);
    expect(save.record.sectionIds).toEqual(['sAB', 'sBD', 'sDF']);
    expect(save.record.occurredOn).toBe(ON);
    expect(save.lengthMetres).toBe(2800);
  });

  test('总体是两层并集，重叠区间只计一次', () => {
    const net = network();
    const facts = {
      basic: [fact('b1', 'A', 'B', ['S1'], ['sAB'])],
      advanced: [fact('a1', 'D', 'G', ['S2'], ['sDF', 'sFG']), fact('a2', 'A', 'B', ['S1'], ['sAB'])],
    };
    const summary = summarizeAdvance(facts, net, '2024-06-30');
    expect(summary.counts.basic).toBe(1);
    expect(summary.counts.advanced).toBe(3);
    expect(summary.counts.overall).toBe(3);
    expect(summary.counts.overlap).toBe(1);
    expect(summary.overall.map((row) => row.sectionId).sort())
      .toEqual(['sAB', 'sDF', 'sFG']);
    expect(summary.union.overlapSectionIds).toEqual(['sAB']);
    expect(describeAdvanceCounts(summary)).toContain('并集');
  });

  test('五类待处理整条保留、不计入统计、不抛错', () => {
    const net = network();
    const facts = {
      basic: [fact('b1', 'A', 'B', ['S1'], ['sAB'])],
      advanced: [
        fact('p1', 'A', 'B', ['S1'], ['sAB'], { snapshotId: 'snap-old' }),
        fact('p2', 'A', 'F', ['S1', 'S2'], ['sAB', 'sBD', 'sDF']),
        fact('p3', 'A', 'B', ['S1'], ['sAB'], { occurredOn: '2024-06-11' }),
      ],
    };
    const summary = summarizeAdvance(facts, net, '2024-06-30');
    expect(summary.counts.overall).toBe(1);
    expect(summary.counts.advanced).toBe(1);
    expect(summary.pending).toHaveLength(2);
    expect(summary.pending.every((row) => row.message.includes('不计入统计'))).toBe(true);
    expect(summary.pending.map((row) => row.reason)).toContain('snapshot-mapping-required');
    expect(summary.pending.map((row) => row.reason)).toContain('through-service-mapping-required');
    // 多服务但相邻对不在已复核 pairs 内 = 旧换乘链或漏维护：文案必须指向「旧格式换乘链」而非沉默通过。
    expect(pendingReasonText('through-service-mapping-required')).toContain('旧格式的换乘链');
    for (const reason of [
      'snapshot-mapping-required', 'through-service-mapping-required',
      'path-mapping-required', 'topology-mapping-required', 'service-alignment-required', 'E_MULTIPATH',
    ]) {
      expect(pendingReasonText(reason)).toContain('不计入统计');
    }
  });

  test('删除一层不改另一层事实；删除后可重算', () => {
    const net = network();
    const facts = {
      basic: [fact('b1', 'A', 'B', ['S1'], ['sAB'])],
      advanced: [fact('a1', 'D', 'G', ['S2'], ['sDF', 'sFG'])],
    };
    const after = withoutRecord(facts, 'advanced', 'a1');
    expect(after.basic).toHaveLength(1);
    expect(after.advanced).toHaveLength(0);
    const summary = summarizeAdvance(after, net, '2024-06-30');
    expect(summary.counts.basic).toBe(1);
    expect(summary.counts.overall).toBe(1);
    let failure: unknown = null;
    try {
      withoutRecord(facts, 'advanced', 'missing');
    } catch (error) {
      failure = error;
    }
    expect((failure as AdvanceFailure).code).toBe('E_REFERENCE');
  });
});

describe('不可直接编辑', () => {
  test('只接受备注与车次，日期/径路字段被领域层拒绝', () => {
    expect(metadataFromInput({ note: 'x', vehicle: 'G1' })).toEqual({ note: 'x', vehicle: 'G1' });
    for (const field of ['occurredOn', 'onDate', 'fromStationId', 'toStationId', 'sectionIds', 'serviceLineIds']) {
      let failure: unknown = null;
      try {
        metadataFromInput({ note: 'x', [field]: 'changed' });
      } catch (error) {
        failure = error;
      }
      expect((failure as AdvanceFailure).code).toBe('E_FIELDS');
      expect((failure as AdvanceFailure).message).toContain('不可直接编辑');
    }
  });
});

describe('删除后的重算状态', () => {
  const expected = { onDate: ON, snapshotId: 'snap1' };
  const derived = { onDate: ON, snapshotId: 'snap1' };

  test('删除记录后 calculation=pending：给出等待重算并保留旧结果', () => {
    const view = describeRecalculation({ status: 'pending', generation: 2, context: null, error: null }, derived, expected);
    expect(view.kind).toBe('pending');
    expect(view.retryable).toBe(false);
    expect(view.showsOldResult).toBe(true);
  });

  test('上下文不一致判 stale，可重试', () => {
    const view = describeRecalculation({
      status: 'ready', generation: 2, context: { onDate: '2024-06-09', snapshotId: 'snap1' }, error: null,
    }, derived, expected);
    expect(view.kind).toBe('stale');
    expect(view.retryable).toBe(true);
    expect(view.message).toContain('不一致');
  });

  test('上下文一致为 ready，失败可重试，空状态无需重试', () => {
    expect(describeRecalculation({
      status: 'ready', generation: 3, context: { ...expected }, error: null,
    }, derived, expected).kind).toBe('ready');
    const failed = describeRecalculation({
      status: 'failed', generation: 3, context: null, error: 'E_SNAPSHOT',
    }, null, expected);
    expect(failed.kind).toBe('failed');
    expect(failed.retryable).toBe(true);
    expect(failed.message).toContain('E_SNAPSHOT');
    expect(describeRecalculation(null, null, expected).kind).toBe('none');
  });

  test('异步工作可取消：AbortSignal 中止后以 E_ABORT 拒绝', async () => {
    const controller = new AbortController();
    const value = await runCancellable(async () => 42, controller.signal);
    expect(value).toBe(42);
    const aborted = new AbortController();
    aborted.abort();
    let preCancelled: unknown = null;
    try {
      await runCancellable(async () => 1, aborted.signal);
    } catch (error) {
      preCancelled = error;
    }
    expect((preCancelled as { code?: string }).code).toBe('E_ABORT');
    const during = new AbortController();
    const never = new Promise<number>(() => {});
    const pending = runCancellable(() => never, during.signal);
    during.abort();
    let midCancelled: unknown = null;
    try {
      await pending;
    } catch (error) {
      midCancelled = error;
    }
    expect((midCancelled as { code?: string }).code).toBe('E_ABORT');
  });
});
