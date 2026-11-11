/**
 * 备份导入/导出的动作编排（纯编排层，状态机仍在 backup/backup-machine.ts）。
 *
 * 顺序约束：预览 → 固定替换警告 → 明确确认/取消 → 执行。这里只把工作区
 * 调用与状态机动作接起来；失败写入 error 阶段并保留可读消息，不吞错。
 */
import { ref } from 'vue';
import { describeBackupFailure, initialBackupState, reduceBackup } from '../backup/backup-machine';
import type { BackupAction, BackupState } from '../backup/backup-machine';
import type { Workspace } from './workspace';
type BackupWorkspace = Pick<Workspace, 'exportBackup' | 'previewImport' | 'finishImport'>;

export interface BackupActionsOptions {
  readonly workspace: () => BackupWorkspace | undefined;
  readonly exportedOn: () => string;
  readonly report: (message: string) => void;
  readonly afterImport?: () => Promise<void>;
}

export function useBackupActions(options: BackupActionsOptions) {
  const state = ref<BackupState>(initialBackupState());

  function dispatch(action: BackupAction): void {
    state.value = reduceBackup(state.value, action);
  }

  /**
   * 失败统一走 describeBackupFailure：按真实错误码给出稳定中文文案，并保留 E_SCHEMA/E_FORMAT/
   * E_CHECKSUM 等原始码。不得直接透传 error.message——存储层会拼上英文 cause（如配额超出），
   * 也不能把四类失败一律压成 E_IMPORT 而丢掉真实码。只有码无法识别时才用调用点兜底码。
   */
  function failureAction(error: unknown, fallbackCode: string): { message: string; code: string } {
    const described = describeBackupFailure(error);
    return { message: described.message, code: described.code ?? fallbackCode };
  }

  async function exportBackup(filename: string): Promise<void> {
    const workspace = options.workspace();
    if (!workspace) { options.report('本地工作区尚未打开'); return; }
    dispatch({ type: 'export-start' });
    try {
      const result = await workspace.exportBackup(options.exportedOn());
      const blob = new Blob([result.text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename || result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      dispatch({ type: 'export-done' });
      options.report('备份已导出');
    } catch (error) {
      dispatch({ type: 'export-failed', ...failureAction(error, 'E_EXPORT') });
    }
  }

  async function inspectImport(text: string): Promise<void> {
    const workspace = options.workspace();
    if (!workspace) { options.report('本地工作区尚未打开'); return; }
    dispatch({ type: 'preview-start' });
    try {
      const preview = await workspace.previewImport(text) as BackupState['preview'];
      if (!preview) { dispatch({ type: 'preview-failed', message: '备份预览为空，未识别出可导入的内容；现有记录未改变。', code: 'E_FORMAT' }); return; }
      dispatch({ type: 'preview-ready', preview });
      options.report(`已预览备份：将替换 ${preview.existingRecords} 条记录`);
    } catch (error) {
      dispatch({ type: 'preview-failed', ...failureAction(error, 'E_IMPORT') });
    }
  }

  async function confirmImport(): Promise<void> {
    const workspace = options.workspace();
    if (!workspace) { options.report('本地工作区尚未打开'); return; }
    if (state.value.phase !== 'confirming') return;
    const preview = state.value.preview;
    dispatch({ type: 'confirm' });
    dispatch({ type: 'import-start' });
    try {
      const next = await workspace.finishImport(preview, true);
      if (next.phase !== 'ready') {
        // 工作区已经把底层错误换成中文文案和错误码；带上码再抛，交给下面的统一映射。
        throw Object.assign(new Error(next.message || '导入失败'), { code: next.errorCode ?? undefined });
      }
      dispatch({ type: 'import-done', count: (next.snapshot?.facts.basic.length ?? 0) + (next.snapshot?.facts.advanced.length ?? 0) });
      options.report('备份已导入');
      await options.afterImport?.();
    } catch (error) {
      dispatch({ type: 'import-failed', ...failureAction(error, 'E_IMPORT') });
    }
  }

  async function cancelImport(): Promise<void> {
    if (state.value.phase !== 'confirming') return;
    const workspace = options.workspace();
    const preview = state.value.preview;
    dispatch({ type: 'cancel' });
    if (workspace && preview) await workspace.finishImport(preview, false);
    options.report('已取消导入，现有记录未改变');
  }

  return { state, dispatch, exportBackup, inspectImport, confirmImport, cancelImport };
}
