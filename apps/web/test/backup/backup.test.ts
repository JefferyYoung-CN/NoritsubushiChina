import { describe, expect, test } from 'vitest';
import {
  backupFileName,
  canConfirm,
  describeBackupFailure,
  initialBackupState,
  isBusy,
  reduceBackup,
  type ImportPreview,
} from '../../src/backup/backup-machine';

const preview: ImportPreview = {
  warning: '导入备份将清空目前设备上保存的全部记录',
  existingRecords: 2,
  incomingRecords: 3,
  expectedRevision: 7,
};

describe('备份导入状态机', () => {
  test('预览→确认→导入固定顺序，预览前不能确认', () => {
    let state = initialBackupState();
    expect(canConfirm(state)).toBe(false);
    state = reduceBackup(state, { type: 'confirm' });
    expect(state.phase).toBe('idle');

    state = reduceBackup(state, { type: 'preview-start' });
    expect(state.phase).toBe('previewing');
    expect(isBusy(state)).toBe(true);
    state = reduceBackup(state, { type: 'preview-ready', preview });
    expect(state.phase).toBe('confirming');
    expect(canConfirm(state)).toBe(true);
    expect(state.preview?.warning).toContain('清空');

    state = reduceBackup(state, { type: 'confirm' });
    expect(state.phase).toBe('importing');
    state = reduceBackup(state, { type: 'import-done', count: 3 });
    expect(state.phase).toBe('imported');
    expect(state.message).toContain('3');
  });

  test('取消导入不写记录并清空预览', () => {
    let state = reduceBackup(initialBackupState(), { type: 'preview-start' });
    state = reduceBackup(state, { type: 'preview-ready', preview });
    state = reduceBackup(state, { type: 'cancel' });
    expect(state.phase).toBe('cancelled');
    expect(state.preview).toBeNull();
    expect(state.message).toContain('未改变');
  });

  test('非法顺序被忽略，不会误触发替换', () => {
    const idle = initialBackupState();
    expect(reduceBackup(idle, { type: 'import-done', count: 1 })).toBe(idle);
    const confirming = reduceBackup(reduceBackup(idle, { type: 'preview-start' }), { type: 'preview-ready', preview });
    expect(reduceBackup(confirming, { type: 'import-start' })).toBe(confirming);
    expect(reduceBackup(confirming, { type: 'bogus' } as never)).toBe(confirming);
  });

  test('失败提示整份拒绝并保留错误码', () => {
    const exportFail = reduceBackup(reduceBackup(initialBackupState(), { type: 'export-start' }), {
      type: 'export-failed',
      message: 'download failed',
      code: 'E_DOWNLOAD',
    });
    expect(exportFail.phase).toBe('error');
    expect(exportFail.errorCode).toBe('E_DOWNLOAD');

    const checksum = describeBackupFailure(Object.assign(new Error('digest'), { code: 'E_CHECKSUM' }));
    expect(checksum.retryable).toBe(false);
    expect(checksum.message).toContain('整份拒绝');
    expect(describeBackupFailure(Object.assign(new Error('x'), { code: 'E_IMPORT' })).retryable).toBe(true);
  });

  test('版本不受支持时要求先保留新版备份，并给出升级或回退指引', () => {
    const failure = describeBackupFailure(Object.assign(new Error('Unsupported backup version'), { code: 'E_SCHEMA' }));
    expect(failure.code).toBe('E_SCHEMA');
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain('先保留这份新版备份');
    expect(failure.message).toContain('更新版本');
    expect(failure.message).toContain('整份拒绝');
    expect(failure.message).toContain('升级');
    expect(failure.message).toContain('回退');
  });

  test('导出文件名带业务日期', () => {
    expect(backupFileName('2026-05-01')).toBe('noritsubushi-backup-2026-05-01.json');
  });
});
