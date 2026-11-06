import { describe, expect, test, vi } from 'vitest';
import { useBackupActions } from '../../src/integration/backup-actions';
import type { WorkspaceState } from '../../src/integration/workspace';
import { fact } from './fixtures';
const preview = Object.freeze({ warning: '导入备份将清空目前设备上保存的全部记录', existingRecords: 2, incomingRecords: 2, expectedRevision: 1 });
const ready: WorkspaceState = { phase: 'ready', message: '', errorCode: null, retryable: false,
  snapshot: { revision: 1, facts: { basic: [fact()], advanced: [fact({ id: 'advanced-1' })] }, derived: null, calculation: null } };
interface WorkspaceOverrides {
  previewImport?: () => Promise<unknown>;
  finishImport?: (preview: unknown, confirmed: boolean) => Promise<WorkspaceState>;
  exportBackup?: () => Promise<{ text: string; filename: string }>;
}
function setup(next = ready, overrides: WorkspaceOverrides = {}) {
  const finishImport = vi.fn(overrides.finishImport ?? (async (_preview: unknown, _confirmed: boolean) => next));
  const report = vi.fn(); const afterImport = vi.fn(async () => {});
  const actions = useBackupActions({ workspace: () => ({
    previewImport: overrides.previewImport ?? (async () => preview), finishImport,
    exportBackup: overrides.exportBackup ?? (async () => ({ text: '{}', filename: 'backup.json' })),
  }), exportedOn: () => '2024-06-10', report, afterImport });
  return { ...actions, finishImport, report, afterImport };
}
/** 界面文案必须全中文：ASCII 字母只允许出现在错误码字段里。 */
const hasLatin = (text: string): boolean => /[A-Za-z]/.test(text);
describe('backup operations reflect committed outcome', () => {
  test('cancel consumes the original ticket and permits a new preview', async () => {
    const actions = setup(); await actions.inspectImport('valid'); await actions.cancelImport();
    expect(actions.finishImport).toHaveBeenCalledWith(preview, false);
    expect(actions.state.value.phase).toBe('cancelled');
    await actions.inspectImport('valid'); expect(actions.state.value.phase).toBe('confirming');
    expect(actions.afterImport).not.toHaveBeenCalled();
  });
  test('a nonthrowing workspace error is displayed as failure and never recalculated', async () => {
    const actions = setup({ ...ready, phase: 'error', errorCode: 'E_CONFLICT', message: '记录已变化' });
    await actions.inspectImport('valid'); await actions.confirmImport();
    expect(actions.state.value.phase).toBe('error'); expect(actions.state.value.message).toContain('记录已变化');
    expect(actions.report).not.toHaveBeenCalledWith('备份已导入'); expect(actions.afterImport).not.toHaveBeenCalled();
  });
  test('successful replacement counts both layers, recalculates once and blocks duplicate confirmation', async () => {
    const actions = setup(); await actions.inspectImport('valid'); await actions.confirmImport(); await actions.confirmImport();
    expect(actions.state.value.phase).toBe('imported'); expect(actions.state.value.importedCount).toBe(2);
    expect(actions.finishImport).toHaveBeenCalledOnce(); expect(actions.afterImport).toHaveBeenCalledOnce();
  });

  test('E_SCHEMA in the preview keeps its real code and a Chinese message', async () => {
    const actions = setup(ready, { previewImport: async () => {
      throw Object.assign(new Error('unsupported schema version'), { code: 'E_SCHEMA' });
    } });
    await actions.inspectImport('{"formatVersion":"bogus"}');
    expect(actions.state.value.phase).toBe('error');
    expect(actions.state.value.errorCode).toBe('E_SCHEMA');
    expect(actions.state.value.message).toContain('格式或版本');
    expect(actions.state.value.message).toContain('先保留这份新版备份');
    expect(actions.state.value.message).toContain('更新版本');
    expect(actions.state.value.message).toContain('整份拒绝');
    expect(hasLatin(actions.state.value.message)).toBe(false);
  });

  test('an uncoded English storage error never leaks English into the UI', async () => {
    const actions = setup(ready, { previewImport: async () => {
      throw new Error('IndexedDB transaction failed: The quota has been exceeded.');
    } });
    await actions.inspectImport('{"formatVersion":"phase1.user-backup.v1"}');
    expect(actions.state.value.phase).toBe('error');
    expect(actions.state.value.errorCode).toBe('E_IMPORT');
    expect(actions.state.value.message).toContain('备份操作失败');
    expect(actions.state.value.message).not.toContain('quota');
    expect(hasLatin(actions.state.value.message)).toBe(false);
  });

  test('export failure keeps E_STORAGE and the Chinese storage explanation', async () => {
    const actions = setup(ready, { exportBackup: async () => {
      throw Object.assign(new Error('IndexedDB transaction failed: The quota has been exceeded.'), { code: 'E_STORAGE' });
    } });
    await actions.exportBackup('backup.json');
    expect(actions.state.value.phase).toBe('error');
    expect(actions.state.value.errorCode).toBe('E_STORAGE');
    expect(actions.state.value.message).toContain('本地存储');
    expect(hasLatin(actions.state.value.message)).toBe(false);
  });

  test('uncoded export failure falls back to E_EXPORT with Chinese text', async () => {
    const actions = setup(ready, { exportBackup: async () => { throw new Error('download pipe exploded'); } });
    await actions.exportBackup('backup.json');
    expect(actions.state.value.phase).toBe('error');
    expect(actions.state.value.errorCode).toBe('E_EXPORT');
    expect(hasLatin(actions.state.value.message)).toBe(false);
  });

  test('a rejected finishImport surfaces the real E_CHECKSUM instead of E_IMPORT', async () => {
    const failed: WorkspaceState = { ...ready, phase: 'error', errorCode: 'E_CHECKSUM',
      message: '备份文件摘要不符，可能损坏或被修改；已整份拒绝。' };
    const actions = setup(failed);
    await actions.inspectImport('valid'); await actions.confirmImport();
    expect(actions.state.value.phase).toBe('error');
    expect(actions.state.value.errorCode).toBe('E_CHECKSUM');
    expect(actions.state.value.message).toContain('摘要不符');
    expect(hasLatin(actions.state.value.message)).toBe(false);
    expect(actions.report).not.toHaveBeenCalledWith('备份已导入');
    expect(actions.afterImport).not.toHaveBeenCalled();
  });
});
