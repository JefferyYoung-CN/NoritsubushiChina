import { describe, expect, test } from 'vitest';
import { toLastSave } from '../../src/integration/workspace';

describe('基础保存回执映射', () => {
  test('逐段搬运计划字段与真实记录 id', () => {
    const plan = {
      total: 4,
      covered: 2,
      runs: [
        { id: 'record-1', fromStationId: 'A', toStationId: 'B', sectionIds: ['sAB'] },
        { id: 'record-1-2', fromStationId: 'D', toStationId: 'E', sectionIds: ['sDE'] },
      ],
    };
    expect(toLastSave(plan)).toEqual({
      total: 4,
      covered: 2,
      runs: [
        { id: 'record-1', fromStationId: 'A', toStationId: 'B', sectionIds: ['sAB'] },
        { id: 'record-1-2', fromStationId: 'D', toStationId: 'E', sectionIds: ['sDE'] },
      ],
    });
  });

  test('没有新增记录时回执 runs 为空，不伪造 id', () => {
    expect(toLastSave({ total: 1, covered: 1, runs: [] })).toEqual({ total: 1, covered: 1, runs: [] });
  });
});
