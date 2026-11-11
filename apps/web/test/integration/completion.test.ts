/**
 * 统计映射与待处理注入（关键缺口）。
 *
 * 断言：可映射事实进入区间/车站统计；五类 pending 整条保留（recordId/layer/reason）、
 * 不写入任何集合、不抛 E_SNAPSHOT；日期边界 E_DATE/E_SNAPSHOT 明确失败。
 * 另测历史快照选择：按声明覆盖区间（含两端）选且仅选一个包，重叠与空洞都明确失败。
 */
import { describe, expect, test } from 'vitest';
import { PENDING_REASONS } from '../../../../packages/application/topology-mapping.mjs';
import { createSnapshotIndex, selectSnapshotByDate } from '../../../../packages/application/history-snapshots.mjs';
import { computeCompletion, pendingReasonLabel } from '../../src/integration/completion';
import { ON_DATE, fact, facts, fixtureNetwork } from './fixtures';

const network = fixtureNetwork();

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'NO_ERROR';
};

describe('computeCompletion', () => {
  test('当前快照的可映射基础事实只进入区间统计，不贡献完站', () => {
    const result = computeCompletion(facts([fact()]), network, ON_DATE);
    expect(result.pending).toEqual([]);
    expect(result.basic).toEqual([{ sectionId: 'sAB', firstCompletedOn: '2024-05-01' }]);
    expect(result.overall).toEqual(result.basic);
    expect(result.stations).toEqual([]);
  });

  test('同日并列取最早完乘日期，advanced 覆盖 basic 时不重复贡献', () => {
    const sameDay = computeCompletion(facts([fact(), fact({ id: 'fact-2', sectionIds: ['sBD'], fromStationId: 'B', toStationId: 'D' })]), network, ON_DATE);
    expect(sameDay.overall).toHaveLength(2);
    const advanced = computeCompletion(facts([], [fact({ id: 'adv-1', sectionIds: ['sBD'], fromStationId: 'B', toStationId: 'D' })]), network, ON_DATE);
    expect(advanced.basic).toEqual([]);
    expect(advanced.advanced).toEqual([{ sectionId: 'sBD', firstCompletedOn: '2024-05-01' }]);
    expect(advanced.contributions).toEqual([{ recordId: 'adv-1', sectionIds: ['sBD'] }]);
    // 完站只看进阶记录：基础记录再多也不贡献车站乘降。
    expect(advanced.stations.map(row => row.stationId)).toEqual(['B', 'D']);
  });

  test('五类 pending 原样保留记录身份、层与原因，且不计入任何统计', () => {
    const result = computeCompletion(facts([
      fact({ id: 'cross-snapshot', networkSnapshotId: 'old-snap' }),
      // 物理线路 L1 的 C→D 只有 sCD，而唯一运营服务 S1 只覆盖 sAB/sBD：对齐失败。
      fact({ id: 'service-align', fromStationId: 'C', toStationId: 'D', serviceLineIds: [],
        physicalLineId: 'L1', sectionIds: ['sCD'] }),
    ], [
      fact({ id: 'through-pair', sectionIds: ['sBD'], fromStationId: 'B', toStationId: 'D', serviceLineIds: ['S1', 'S2'] }),
      fact({ id: 'path-gap', sectionIds: ['sAB', 'sCD'], toStationId: 'D' }),
      fact({ id: 'topology-gone', sectionIds: ['sX'] }),
    ]), network, ON_DATE);
    expect(result.pending.map(row => row.reason)).toEqual([
      'snapshot-mapping-required', 'service-alignment-required', 'through-service-mapping-required',
      'path-mapping-required', 'topology-mapping-required',
    ]);
    // 覆盖到全部已知原因：新增原因必须两端同时出现，防止只在计算层加而界面没有文案。
    expect(new Set(result.pending.map(row => row.reason))).toEqual(new Set(PENDING_REASONS));
    expect(result.pending.map(row => row.recordId))
      .toEqual(['cross-snapshot', 'service-align', 'through-pair', 'path-gap', 'topology-gone']);
    expect(result.pending.map(row => row.layer)).toEqual(['basic', 'basic', 'advanced', 'advanced', 'advanced']);
    expect(result.basic).toEqual([]);
    expect(result.overall).toEqual([]);
    expect(result.stations).toEqual([]);
    expect(result.statistics).not.toBeNull();
    // Every format-valid protocol fact remains pending rather than failing a narrower mapping decoder.
    const long = fact({ id: 'i'.repeat(500), networkSnapshotId: 's'.repeat(500),
      fromStationId: 'a'.repeat(500), toStationId: 'b'.repeat(500),
      serviceLineIds: Array.from({ length: 100 }, (_, index) => String(index).padEnd(500, 'x')),
      sectionIds: Array.from({ length: 201 }, (_, index) => String(index).padEnd(500, 'y')) });
    expect(computeCompletion(facts([long]), network, ON_DATE).pending).toEqual([
      { recordId: long.id, layer: 'basic', reason: 'snapshot-mapping-required' },
    ]);
  });

  test('pending 不抛 E_SNAPSHOT：未来日期之外仍按知识截止与日期下限拒绝', () => {
    expect(codeOf(() => computeCompletion(facts([fact()]), network, '1996-12-31'))).toBe('E_DATE');
    expect(codeOf(() => computeCompletion(facts([fact()]), network, '2031-01-01'))).toBe('E_SNAPSHOT');
    expect(codeOf(() => computeCompletion(facts([fact()]), network, '2024-02-30'))).toBe('E_DATE');
  });

  test('发生日期晚于统计日的事实不参与（避免同日并列错误回退）', () => {
    const result = computeCompletion(facts([fact({ occurredOn: '2024-12-01' })]), network, ON_DATE);
    expect(result.overall).toEqual([]);
    expect(result.pending).toEqual([]);
  });
});

describe('pendingReasonLabel', () => {
  test('五类原因都有中文说明，未知原因原样回显', () => {
    const labels = PENDING_REASONS.map(reason => pendingReasonLabel(reason));
    expect(labels.every(label => label.length > 0 && !PENDING_REASONS.some(reason => reason === label))).toBe(true);
    expect(pendingReasonLabel('something-else')).toBe('something-else');
  });
});

const period = { from: '2000-01-01', until: null };

/** 当前快照里两条运营线路分别覆盖 sAB 与 sBD，用来构造真实的双服务直通记录。 */
function throughNetwork() {
  const base = fixtureNetwork();
  const service = (id: string) => ({ id, name: id, lineId: 'L1', operatorId: 'op1', directions: [], ...period });
  return {
    ...base,
    services: [service('SL-a'), service('SL-b'), service('SL-c')],
    memberships: [
      { serviceId: 'SL-a', sectionId: 'sAB', sequence: 0, ...period },
      { serviceId: 'SL-b', sectionId: 'sBD', sequence: 1, ...period },
      { serviceId: 'SL-c', sectionId: 'sBD', sequence: 1, ...period },
    ],
  };
}

const THROUGH_REVIEWED = {
  snapshots: [] as readonly string[],
  stationSplits: [] as const,
  throughServicePairs: [['SL-a', 'SL-b'], ['SL-c', 'SL-b']] as const,
};

describe('已批准直通线路关系', () => {
  const through = fact({ id: 'through', sectionIds: ['sAB', 'sBD'], fromStationId: 'A',
    toStationId: 'D', serviceLineIds: ['SL-a', 'SL-b'] });

  test('多服务记录在批准线路对下进入统计，contributions 保留该记录身份与区间', () => {
    const result = computeCompletion(facts([], [through]), throughNetwork(), ON_DATE, THROUGH_REVIEWED);
    expect(result.pending).toEqual([]);
    expect(result.contributions).toEqual([{ recordId: 'through', sectionIds: ['sAB', 'sBD'] }]);
    expect(result.advanced).toEqual([
      { sectionId: 'sAB', firstCompletedOn: '2024-05-01' },
      { sectionId: 'sBD', firstCompletedOn: '2024-05-01' },
    ]);
  });

  test('同一记录不给 pairs 时保持 pending，不按共享车站或邻接推断直通', () => {
    const result = computeCompletion(facts([], [through]), throughNetwork(), ON_DATE);
    expect(result.pending).toEqual([
      { recordId: 'through', layer: 'advanced', reason: 'through-service-mapping-required' },
    ]);
    expect(result.advanced).toEqual([]);
    expect(result.contributions).toEqual([]);
  });

  test('只给一半 pairs（记录是 SL-a→SL-c）仍是 through-service-mapping-required', () => {
    const half = fact({ id: 'half', sectionIds: ['sAB', 'sBD'], fromStationId: 'A',
      toStationId: 'D', serviceLineIds: ['SL-a', 'SL-c'] });
    const result = computeCompletion(facts([], [half]), throughNetwork(), ON_DATE, {
      snapshots: [], stationSplits: [], throughServicePairs: [['SL-a', 'SL-b']] as const,
    });
    expect(result.pending).toEqual([
      { recordId: 'half', layer: 'advanced', reason: 'through-service-mapping-required' },
    ]);
  });
});

describe('父快照的 1:1 白名单', () => {
  const parentId = 'demo-parent-a';
  const newNetwork = { ...fixtureNetwork(), snapshotId: 'demo-snapshot-a' };
  const parentFact = fact({ id: 'parent-1', networkSnapshotId: parentId });

  test('白名单含父快照 id 时映射成功且 sectionId 不变（1:1）', () => {
    const result = computeCompletion(facts([parentFact]), newNetwork, ON_DATE, {
      snapshots: [parentId], stationSplits: [], throughServicePairs: [],
    });
    expect(result.pending).toEqual([]);
    expect(result.basic).toEqual([{ sectionId: 'sAB', firstCompletedOn: '2024-05-01' }]);
    expect(result.basic[0]!.sectionId).toBe(parentFact.sectionIds[0]);
    expect(result.statistics?.snapshotId).toBe('demo-snapshot-a');
  });

  test('白名单不含父快照 id 时保持 snapshot-mapping-required', () => {
    const result = computeCompletion(facts([parentFact]), newNetwork, ON_DATE);
    expect(result.pending).toEqual([
      { recordId: 'parent-1', layer: 'basic', reason: 'snapshot-mapping-required' },
    ]);
    expect(result.basic).toEqual([]);
  });
});

describe('历史快照选择：按声明覆盖区间', () => {
  const entry = (snapshotId: string, coverageFrom: string, coverageTo: string) => ({
    snapshotId, snapshotAsOf: coverageTo, knowledgeThrough: coverageTo, coverageFrom, coverageTo,
  });
  // A 包 1997-01-01..2025-06-01，B 包 2025-06-02..2026-10-30。
  const A = entry('snap-a', '1997-01-01', '2025-06-01');
  const B = entry('snap-b', '2025-06-02', '2026-10-30');

  test('两端都含：2010-06-01 与切割日 2025-06-01 归 A，次日归 B', () => {
    const index = createSnapshotIndex([B, A]);
    expect(selectSnapshotByDate(index, '2010-06-01').snapshotId).toBe('snap-a');
    expect(selectSnapshotByDate(index, '2025-06-01').snapshotId).toBe('snap-a');
    expect(selectSnapshotByDate(index, '2025-06-02').snapshotId).toBe('snap-b');
  });

  test('低于最早覆盖起点报 E_SNAPSHOT，不回退到最早包', () => {
    expect(codeOf(() => selectSnapshotByDate(createSnapshotIndex([B, A]), '1996-12-31'))).toBe('E_SNAPSHOT');
  });

  test('两包声明重叠时明确报错（消息含「重叠」），不任选一个', () => {
    const overlap = createSnapshotIndex([A, entry('snap-c', '2025-05-01', '2026-10-30')]);
    let message = '';
    try {
      selectSnapshotByDate(overlap, '2025-06-01');
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain('重叠');
  });

  test('区间之间留洞时报 E_SNAPSHOT', () => {
    const gap = createSnapshotIndex([A, entry('snap-b', '2025-06-03', '2026-10-30')]);
    expect(codeOf(() => selectSnapshotByDate(gap, '2025-06-02'))).toBe('E_SNAPSHOT');
  });
});
