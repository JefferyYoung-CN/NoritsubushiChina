/**
 * 备份替换警告与导入状态机（P5 收口）。
 *
 * 断言：previewing→confirming 保留替换警告；confirming 可 cancel 或 confirm，
 * 取消后现有记录不变；非法顺序保持原状态（不误触发替换）；导出失败带码。
 */
import { describe, expect, test } from 'vitest';
import {
  backupFileName, canConfirm, initialBackupState, isBusy, reduceBackup,
} from '../../src/backup/backup-machine';
import type { BackupState, ImportPreview } from '../../src/backup/backup-machine';
import { encodeBackup, finishImport, prepareImport } from '../../../../packages/application/backup.mjs';
import { decodeFacts } from '../../../../packages/application/records.mjs';
import type { StoragePort, StorageState } from '../../../../packages/application/idb-storage.mjs';
import { computeCompletion } from '../../src/integration/completion';
import { ON_DATE, fact, facts, fixtureNetwork } from './fixtures';

const preview: ImportPreview = {
  warning: '导入将替换现有 3 条记录，此操作不可撤销。',
  existingRecords: 3,
  incomingRecords: 5,
  expectedRevision: 7,
};

const at = (phase: BackupState['phase']): BackupState => ({ ...initialBackupState(), phase });

describe('备份替换预览', () => {
  test('preview-start 清空旧预览并进入 previewing', () => {
    const state = reduceBackup({ ...initialBackupState(), preview, message: '旧消息' }, { type: 'preview-start' });
    expect(state.phase).toBe('previewing');
    expect(state.preview).toBeNull();
    expect(state.message).toBe('');
    expect(isBusy(state)).toBe(true);
  });

  test('preview-ready 进入 confirming 并保留替换警告与条数', () => {
    const state = reduceBackup(at('previewing'), { type: 'preview-ready', preview });
    expect(state.phase).toBe('confirming');
    expect(state.preview).toEqual(preview);
    expect(state.preview?.warning).toContain('替换现有');
    expect(canConfirm(state)).toBe(true);
  });

  test('preview-failed 进入 error 并保留错误码，预览被清空', () => {
    const state = reduceBackup(at('previewing'), { type: 'preview-failed', message: '封套损坏', code: 'E_CHECKSUM' });
    expect(state.phase).toBe('error');
    expect(state.errorCode).toBe('E_CHECKSUM');
    expect(state.preview).toBeNull();
  });
});

describe('confirming → cancel/confirm 状态机', () => {
  test('cancel 只允许在 confirming，取消后回到 cancelled 且不导入', () => {
    const state = reduceBackup(at('confirming'), { type: 'cancel' });
    expect(state.phase).toBe('cancelled');
    expect(state.preview).toBeNull();
    expect(state.importedCount).toBeNull();
    expect(state.message).toContain('现有记录未改变');
  });

  test('confirm 后进入 importing，import-done 记录导入条数', () => {
    const confirming = reduceBackup(at('previewing'), { type: 'preview-ready', preview });
    const importing = reduceBackup(confirming, { type: 'confirm' });
    expect(importing.phase).toBe('importing');
    expect(importing.preview).toEqual(preview);
    const done = reduceBackup(importing, { type: 'import-done', count: 5 });
    expect(done.phase).toBe('imported');
    expect(done.importedCount).toBe(5);
    expect(done.preview).toBeNull();
    expect(isBusy(done)).toBe(false);
  });

  test('import-failed 进入 error，保留 code 供诊断', () => {
    const importing = reduceBackup(reduceBackup(at('previewing'), { type: 'preview-ready', preview }), { type: 'confirm' });
    const failed = reduceBackup(importing, { type: 'import-failed', message: '写入失败', code: 'E_STORAGE' });
    expect(failed.phase).toBe('error');
    expect(failed.errorCode).toBe('E_STORAGE');
  });
});

describe('非法顺序', () => {
  test('idle 下的 confirm/cancel/import-done 都是 no-op（同一对象）', () => {
    const idle = initialBackupState();
    expect(reduceBackup(idle, { type: 'confirm' })).toBe(idle);
    expect(reduceBackup(idle, { type: 'cancel' })).toBe(idle);
    expect(reduceBackup(idle, { type: 'import-done', count: 1 })).toBe(idle);
    expect(canConfirm(idle)).toBe(false);
  });

  test('confirming 没有预览或 preview-ready 不在 previewing 时保持原状态', () => {
    const lonely = at('confirming');
    expect(reduceBackup(lonely, { type: 'confirm' })).toBe(lonely);
    const idle = initialBackupState();
    expect(reduceBackup(idle, { type: 'preview-ready', preview })).toBe(idle);
  });
});

describe('导出', () => {
  test('export-start → export-done 与 export-failed 带码', () => {
    const exporting = reduceBackup(initialBackupState(), { type: 'export-start' });
    expect(exporting.phase).toBe('exporting');
    expect(reduceBackup(exporting, { type: 'export-done' }).phase).toBe('exported');
    const failed = reduceBackup(exporting, { type: 'export-failed', message: '磁盘已满', code: 'E_STORAGE' });
    expect(failed.phase).toBe('error');
    expect(failed.errorCode).toBe('E_STORAGE');
    expect(backupFileName('2024-06-10')).toBe('noritsubushi-backup-2024-06-10.json');
  });
});

const PARENT_SNAPSHOT = 'demo-parent-a';
const NEW_SNAPSHOT = 'demo-snapshot-a';

/** 只实现 prepareImport/finishImport 用到的读写；计算入口在本次断言中不会被调用。 */
function memoryPort(): StoragePort {
  let state: StorageState = {
    revision: 0,
    inputRevision: 0,
    facts: decodeFacts({ basic: [], advanced: [] }),
    derived: null,
    calculation: { status: 'pending', generation: 0, context: null, error: null },
  };
  const unused = (): never => { throw new Error('calculation is not used in this test'); };
  return {
    read: () => state,
    async replace(expectedRevision, input) {
      if (expectedRevision !== state.revision) {
        throw Object.assign(new Error('conflict'), { code: 'E_CONFLICT' });
      }
      state = { ...state, revision: state.revision + 1, facts: decodeFacts(input) };
      return state;
    },
    beginCalculation: unused,
    publish: unused,
    fail: unused,
  };
}

describe('父快照备份往返', () => {
  const parentFact = fact({ id: 'parent-1', networkSnapshotId: PARENT_SNAPSHOT });

  test('导出→导入后 facts 逐字段不变，networkSnapshotId 不被改写成新快照', async () => {
    const text = await encodeBackup(facts([parentFact]), '2024-06-10');
    const port = memoryPort();
    const preview = await prepareImport(port, text);
    expect(preview.incomingRecords).toBe(1);
    const imported = await finishImport(port, preview, true);
    expect(imported.status).toBe('imported');
    const restored = imported.state.facts;
    expect(restored.basic).toHaveLength(1);
    expect(restored.basic[0]).toEqual(parentFact);
    expect(restored.basic[0]!.networkSnapshotId).toBe(PARENT_SNAPSHOT);
    expect(JSON.stringify(restored)).toBe(JSON.stringify({ basic: [parentFact], advanced: [] }));
  });

  test('新快照 + 父快照白名单下映射成功且无 snapshot-mapping-required', async () => {
    const text = await encodeBackup(facts([parentFact]), '2024-06-10');
    const port = memoryPort();
    const imported = await finishImport(port, await prepareImport(port, text), true);
    const network = { ...fixtureNetwork(), snapshotId: NEW_SNAPSHOT };
    const result = computeCompletion(imported.state.facts, network, ON_DATE, {
      snapshots: [PARENT_SNAPSHOT], stationSplits: [], throughServicePairs: [],
    });
    expect(result.pending).toEqual([]);
    expect(result.pending.some(row => row.reason === 'snapshot-mapping-required')).toBe(false);
    expect(result.basic).toEqual([{ sectionId: 'sAB', firstCompletedOn: '2024-05-01' }]);
  });
});
