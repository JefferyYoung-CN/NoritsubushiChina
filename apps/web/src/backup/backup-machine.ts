/**
 * 备份导入/导出的纯状态机。
 *
 * 导入必须经过“预览 → 固定替换警告 → 明确确认/取消 → 执行”的固定顺序；
 * 状态机只管理界面阶段，真正的整份校验与写入由 `prepareImport` /
 * `finishImport` 完成，失败不会被吞掉。
 */

export type BackupPhase =
  | 'idle'
  | 'exporting'
  | 'exported'
  | 'previewing'
  | 'confirming'
  | 'importing'
  | 'imported'
  | 'cancelled'
  | 'error';

export interface ImportPreview {
  readonly warning: string;
  readonly existingRecords: number;
  readonly incomingRecords: number;
  readonly expectedRevision: number;
}

export interface BackupState {
  readonly phase: BackupPhase;
  readonly preview: ImportPreview | null;
  readonly message: string;
  readonly errorCode: string | null;
  readonly importedCount: number | null;
}

export type BackupAction =
  | { readonly type: 'export-start' }
  | { readonly type: 'export-done' }
  | { readonly type: 'export-failed'; readonly message: string; readonly code: string | null }
  | { readonly type: 'preview-start' }
  | { readonly type: 'preview-ready'; readonly preview: ImportPreview }
  | { readonly type: 'preview-failed'; readonly message: string; readonly code: string | null }
  | { readonly type: 'confirm' }
  | { readonly type: 'cancel' }
  | { readonly type: 'import-start' }
  | { readonly type: 'import-done'; readonly count: number }
  | { readonly type: 'import-failed'; readonly message: string; readonly code: string | null }
  | { readonly type: 'reset' };

export function initialBackupState(): BackupState {
  return { phase: 'idle', preview: null, message: '', errorCode: null, importedCount: null };
}

/** 只接受当前阶段允许的动作；非法顺序保持原状态，避免误触发替换。 */
export function reduceBackup(state: BackupState, action: BackupAction): BackupState {
  switch (action.type) {
    case 'export-start':
      if (state.phase === 'exporting' || state.phase === 'importing') return state;
      return { ...state, phase: 'exporting', message: '', errorCode: null };
    case 'export-done':
      if (state.phase !== 'exporting') return state;
      return { ...state, phase: 'exported', message: '备份文件已生成并开始下载。' };
    case 'export-failed':
      if (state.phase !== 'exporting') return state;
      return { ...state, phase: 'error', message: action.message, errorCode: action.code };
    case 'preview-start':
      if (state.phase === 'exporting' || state.phase === 'importing') return state;
      return { ...state, phase: 'previewing', preview: null, message: '', errorCode: null };
    case 'preview-ready':
      if (state.phase !== 'previewing') return state;
      return { ...state, phase: 'confirming', preview: action.preview, message: '' };
    case 'preview-failed':
      if (state.phase !== 'previewing') return state;
      return { ...state, phase: 'error', preview: null, message: action.message, errorCode: action.code };
    case 'confirm':
      if (state.phase !== 'confirming' || state.preview === null) return state;
      return { ...state, phase: 'importing', message: '' };
    case 'cancel':
      if (state.phase !== 'confirming') return state;
      return { ...state, phase: 'cancelled', preview: null, message: '已取消导入，现有记录未改变。' };
    case 'import-start':
      if (state.phase !== 'importing') return state;
      return state;
    case 'import-done':
      if (state.phase !== 'importing') return state;
      return {
        ...state,
        phase: 'imported',
        preview: null,
        importedCount: action.count,
        message: `已导入 ${action.count} 条记录并替换原有记录。`,
      };
    case 'import-failed':
      if (state.phase !== 'importing') return state;
      return { ...state, phase: 'error', message: action.message, errorCode: action.code };
    case 'reset':
      return initialBackupState();
    default:
      return state;
  }
}

export function canConfirm(state: BackupState): boolean {
  return state.phase === 'confirming' && state.preview !== null;
}

export function isBusy(state: BackupState): boolean {
  return state.phase === 'exporting' || state.phase === 'previewing' || state.phase === 'importing';
}

export function backupFileName(exportedOn: string): string {
  return `noritsubushi-backup-${exportedOn}.json`;
}

function codeOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

export interface BackupFailure {
  readonly code: string | null;
  readonly message: string;
  readonly retryable: boolean;
}

/** 导入/导出失败的用户提示；整份拒绝时强调现有记录未改变。 */
export function describeBackupFailure(error: unknown): BackupFailure {
  const code = codeOf(error);
  switch (code) {
    case 'E_IMPORT':
      return { code, message: '导入预览已失效或未确认，已整份拒绝；现有记录未改变。', retryable: true };
    case 'E_CHECKSUM':
      return { code, message: '备份文件摘要不符，可能损坏或被修改；已整份拒绝。', retryable: false };
    case 'E_SCHEMA':
      // 版本不支持不等于文件损坏：文件可能来自更新版本的程序，必须先保住新版备份再升级或回退。
      return { code, message: '备份文件格式或版本不受支持，可能来自更新版本的程序；已整份拒绝，现有记录未改变。请先保留这份新版备份，升级到对应版本后再导入；如需回退，也请保留新版备份与本地数据副本。', retryable: false };
    case 'E_FORMAT':
      // 底层（packages/application/backup.mjs）的 E_FORMAT 文案是英文（如 "Backup exceeds 5 MiB
      // limit"），拼进界面会造成中英混排；这里固定中文，原始 message 只留在诊断侧。
      return { code, message: '备份内容无效或超出体积上限；已整份拒绝。', retryable: false };
    case 'E_CONFLICT':
      return { code, message: '记录已变化，导入预览过期；请重新选择备份文件。', retryable: true };
    case 'E_STORAGE':
      return { code, message: '写入本地存储失败，原记录未替换，请重试。', retryable: true };
    case 'E_ABORT':
      return { code, message: '导入已取消，现有记录未改变。', retryable: true };
    default:
      // 无码错误的 message 常是存储层拼出的英文 cause（如 "The quota has been exceeded."）。
      // 面向用户的提示必须是稳定中文，原始 message 只留在控制台/诊断里，不能进界面。
      return { code, message: '备份操作失败，请重试；本次未替换任何记录。', retryable: true };
  }
}
