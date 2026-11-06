import { describe, expect, test } from 'vitest';
import { serviceCandidates } from '../../src/integration/trip';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { fixtureNetwork, ON_DATE } from './fixtures';

function networkWith(overrides: Partial<TransitNetwork>): TransitNetwork {
  return { ...fixtureNetwork(), ...overrides } as TransitNetwork;
}

describe('当日的进阶候选线路', () => {
  test('返回线路名、运营者与稳定标识', () => {
    const rows = serviceCandidates(fixtureNetwork(), ON_DATE);
    expect(rows.length).toBe(1);
    expect(rows[0].serviceLineId).toBe('S1');
    expect(rows[0].operatorName).toBe('运营一');
    expect(rows[0].lineNames).toEqual(['一号线']);
    expect(rows[0].label).toBe('一号线 · 一号线');
  });

  test('按运营起止日期过滤，两端都不含越界服务', () => {
    const base = fixtureNetwork();
    const expired = networkWith({ services: [{ ...base.services[0], until: '2024-06-09' }] });
    expect(serviceCandidates(expired, ON_DATE)).toEqual([]);
    const future = networkWith({ services: [{ ...base.services[0], from: '2024-06-11' }] });
    expect(serviceCandidates(future, ON_DATE)).toEqual([]);
  });

  test('未知运营者保留空名称而不是伪造', () => {
    expect(serviceCandidates(networkWith({ operators: [] }), ON_DATE)[0].operatorName).toBe('');
  });

  test('多个服务按中文标签排序且互不丢行', () => {
    const base = fixtureNetwork();
    const second = { ...base.services[0], id: 'S2', name: '二号线' };
    const rows = serviceCandidates(networkWith({
      services: [second, ...base.services],
      memberships: [...base.memberships, { serviceId: 'S2', sectionId: 'sCD', sequence: 0, from: '2000-01-01', until: null }],
      sections: base.sections.map(row => row.id === 'sCD' ? { ...row, lineId: 'L2' } : row),
      lines: [...base.lines, { id: 'L2', name: '二号线', isLoop: false, directions: [], from: '2000-01-01', until: null }],
    }), ON_DATE);
    const labels = rows.map(row => row.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
    expect(rows.map(row => row.serviceLineId).sort()).toEqual(['S1', 'S2']);
  });
});
