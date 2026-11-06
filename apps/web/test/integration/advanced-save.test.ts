import { describe, expect, test } from 'vitest';
import { advancedRecordWrite, isAdvancedRecordInput, runAdvancedSave } from '../../src/integration/advanced-save';
import type { AdvancedRecordInput } from '../../src/advanced/panelTypes';
import type { SaveState } from '../../src/integration/advanced-save';

const READY: SaveState = { phase: 'ready', message: '', errorCode: null, retryable: false };

function input(overrides: Partial<AdvancedRecordInput> = {}): AdvancedRecordInput {
  return {
    occurredOn: '2024-06-10',
    fromStationId: 'A',
    toStationId: 'D',
    serviceLineIds: ['S1'],
    sectionIds: ['sAB', 'sBD'],
    lengthMetres: 2000,
    note: '',
    vehicle: '',
    ...overrides,
  };
}

describe('进阶记录写入的事实投影', () => {
  test('裁掉 lengthMetres，并注入会话 id 与当前快照', () => {
    const record = advancedRecordWrite(input(), 'snap-1', 'record-1');
    expect(record.id).toBe('record-1');
    expect(record.networkSnapshotId).toBe('snap-1');
    expect(record.serviceLineIds).toEqual(['S1']);
    expect(record.sectionIds).toEqual(['sAB', 'sBD']);
    expect('lengthMetres' in record ? record.lengthMetres : undefined).toBeUndefined();
    expect(Object.isFrozen(record)).toBe(true);
  });

  test('面板事件字段不完整时拒绝构造事实', () => {
    expect(isAdvancedRecordInput(input())).toBe(true);
    expect(isAdvancedRecordInput(null)).toBe(false);
    expect(isAdvancedRecordInput({ ...input(), sectionIds: [] })).toBe(false);
    expect(isAdvancedRecordInput({ ...input(), occurredOn: 20240610 })).toBe(false);
    expect(isAdvancedRecordInput({ ...input(), lengthMetres: undefined })).toBe(false);
    expect(isAdvancedRecordInput({ ...input(), note: null })).toBe(false);
  });
});

describe('进阶保存状态机', () => {
  test('成功：先写入事实，再重算并报告统计已更新', async () => {
    const calls: string[] = [];
    const result = await runAdvancedSave({
      addAdvancedRecord: async (record) => {
        calls.push(`write:${record.id}:${record.networkSnapshotId}`);
        return READY;
      },
      recalculate: async () => {
        calls.push('calculate');
        return READY;
      },
    }, input(), 'snap-1');
    expect(result.ok).toBe(true);
    expect(result.saved).toBe(true);
    expect(result.recalculated).toBe(true);
    expect(result.message).toBe('进阶记录已保存，统计已更新。');
    expect(calls.length).toBe(2);
    expect(calls[0].startsWith('write:record-')).toBe(true);
    expect(calls[0].endsWith(':snap-1')).toBe(true);
    expect(calls[1]).toBe('calculate');
  });

  test('写入失败：保留错误码与可重试性，不触发重算', async () => {
    let recalculated = false;
    const result = await runAdvancedSave({
      addAdvancedRecord: async () => ({ phase: 'error', message: 'Records changed', errorCode: 'E_CONFLICT', retryable: true }),
      recalculate: async () => {
        recalculated = true;
        return READY;
      },
    }, input(), 'snap-1');
    expect(result.ok).toBe(false);
    expect(result.saved).toBe(false);
    expect(result.errorCode).toBe('E_CONFLICT');
    expect(result.retryable).toBe(true);
    expect(result.message).toBe('记录已被其他窗口修改，请刷新后重试。');
    expect(recalculated).toBe(false);
  });

  test('写入成功但重算失败：如实说明记录已保存、统计未刷新', async () => {
    const result = await runAdvancedSave({
      addAdvancedRecord: async () => READY,
      recalculate: async () => ({ phase: 'error', message: '写入 IndexedDB 失败', errorCode: 'E_STORAGE', retryable: true }),
    }, input(), 'snap-1');
    expect(result.ok).toBe(true);
    expect(result.saved).toBe(true);
    expect(result.recalculated).toBe(false);
    expect(result.message).toBe('进阶记录已保存；统计重算失败：写入 IndexedDB 失败，可重试重算。');
  });

  test('字段不完整：直接拒绝且不调用端口', async () => {
    let written = false;
    const result = await runAdvancedSave({
      addAdvancedRecord: async () => {
        written = true;
        return READY;
      },
      recalculate: async () => READY,
    }, { occurredOn: '2024-06-10' }, 'snap-1');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('E_FORMAT');
    expect(result.message).toBe('进阶记录字段不完整，未保存。');
    expect(written).toBe(false);
  });

  test('取消发生在写入前：不写任何事实', async () => {
    const controller = new AbortController();
    controller.abort();
    let written = false;
    const result = await runAdvancedSave({
      addAdvancedRecord: async () => {
        written = true;
        return READY;
      },
      recalculate: async () => READY,
    }, input(), 'snap-1', controller.signal);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('E_ABORT');
    expect(result.message).toBe('已取消，未保存进阶记录。');
    expect(written).toBe(false);
  });

  test('取消发生在写入后：记录保留，跳过重算并说明原因', async () => {
    const controller = new AbortController();
    let recalculated = false;
    const result = await runAdvancedSave({
      addAdvancedRecord: async () => {
        controller.abort();
        return READY;
      },
      recalculate: async () => {
        recalculated = true;
        return READY;
      },
    }, input(), 'snap-1', controller.signal);
    expect(result.saved).toBe(true);
    expect(result.recalculated).toBe(false);
    expect(result.errorCode).toBe('E_ABORT');
    expect(recalculated).toBe(false);
  });
});
