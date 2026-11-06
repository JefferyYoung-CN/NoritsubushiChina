<script setup lang="ts">
/**
 * 备份面板：导出真实备份文件；导入先预览（固定替换警告 + 记录数），
 * 用户明确确认后才执行整份替换，取消不写任何记录。
 */
import { computed, nextTick, ref, watch } from 'vue';
import {
  backupFileName,
  isBusy,
  type BackupState,
} from './backup-machine';

const props = defineProps<{
  state: BackupState;
  exporting?: boolean;
  today: string;
}>();
const emit = defineEmits<{
  export: [filename: string];
  'import-file': [text: string];
  confirm: [];
  cancel: [];
  reset: [];
}>();

const readError = ref('');
const confirmButton = ref<HTMLButtonElement | null>(null);
const section = ref<HTMLElement | null>(null);
const busy = computed(() => props.exporting === true || isBusy(props.state));
const message = computed(() => readError.value || props.state.message);
const canPickFile = computed(() => !busy.value && (props.state.phase === 'idle' || props.state.phase === 'exported' || props.state.phase === 'cancelled' || props.state.phase === 'error'));
/**
 * 预览/确认区出现时原按钮被替换，焦点会掉回 body（P5 实测）；这里记住触发元素，
 * 确认区出现后聚焦「确认替换并导入」，取消/返回后把焦点还给它，键盘路径不逃逸。
 * 只有预览入口（选中备份文件）记录 trigger：文件输入不会被预览区替换，是稳定元素；
 * 取消按钮自身随后会被移除，取消路径不能拿它当还原目标。
 */
let trigger: HTMLElement | null = null;
function noteTrigger(): void {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
}
function restoreTrigger(): void {
  const target = trigger;
  trigger = null;
  void nextTick(() => {
    if (target?.isConnected) target.focus();
    else section.value?.focus();
  });
}
watch(() => props.state.phase, async phase => {
  if (phase === 'confirming') {
    await nextTick();
    confirmButton.value?.focus();
  } else if (phase === 'cancelled' || phase === 'error' || phase === 'imported') {
    restoreTrigger();
  }
});

function onExport(): void {
  emit('export', backupFileName(props.today));
}
function onCancel(): void {
  emit('cancel');
}
function onReset(): void {
  emit('reset');
}
function onEscape(): void {
  if (props.state.phase === 'confirming') onCancel();
  else onReset();
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  readError.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    if (text.trim().length === 0) {
      readError.value = '所选备份文件为空，已整份拒绝。';
      return;
    }
    noteTrigger();
    emit('import-file', text);
  } catch (error) {
    readError.value = `读取文件失败：${error instanceof Error ? error.message : '未知错误'}`;
  } finally {
    input.value = '';
  }
}
</script>

<template>
  <section ref="section" class="backup" aria-labelledby="backup-title" tabindex="-1">
    <div class="section-head">
      <h2 id="backup-title">备份与恢复</h2>
      <p class="section-lead">备份文件只包含乘车记录；导入会整份替换本机记录，导入前会先校验并确认。</p>
    </div>

    <div class="actions">
      <div class="action">
        <h3>导出</h3>
        <p>下载一个包含全部乘车记录的 JSON 文件。</p>
        <button type="button" class="primary" :disabled="busy || state.phase === 'importing'" @click="onExport">
          导出备份
        </button>
      </div>
      <div class="action">
        <h3>导入</h3>
        <p>选择文件后先校验格式，再确认是否整份替换。</p>
        <label class="file">
          <span>选择备份文件</span>
          <input type="file" accept="application/json,.json" :disabled="!canPickFile" @change="onFile" />
        </label>
      </div>
    </div>

    <div v-if="state.preview" class="preview" role="group" aria-labelledby="backup-warning"
      @keydown.esc.prevent="onEscape">
      <p id="backup-warning" class="warning" role="alert">{{ state.preview.warning }}</p>
      <p>现有记录：{{ state.preview.existingRecords }} 条；备份内记录：{{ state.preview.incomingRecords }} 条。</p>
      <p>导入会用备份内容整份替换现有记录，且此操作不可撤销。</p>
      <template v-if="state.phase === 'confirming'">
        <button ref="confirmButton" type="button" class="danger" :disabled="busy" @click="emit('confirm')">确认替换并导入</button>
        <button type="button" class="quiet" :disabled="busy" @click="onCancel">取消，保留现有记录</button>
      </template>
    </div>

    <!-- 容器必须常驻：读屏器只播报已存在节点的内容变化，随消息一起插入的新节点实测不会被念出。 -->
    <p class="message-live" :class="{ message }" role="status" aria-live="polite">{{ message }}</p>
    <button v-if="state.phase === 'error' || state.phase === 'cancelled' || state.phase === 'imported'" type="button" class="small" @click="onReset">
      返回备份初始状态
    </button>
    <p class="hint">备份只包含乘车记录；不包含账号、密钥或坐标原始数据。</p>
  </section>
</template>

<style scoped>
.backup { display: grid; gap: .8rem; min-width: 0; }
h2 { margin: 0; }
h3 { margin: 0; font-size: .95rem; }
.actions { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); }
.action { display: grid; gap: .4rem; align-content: start; padding: .9rem 1rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-1); }
.action p { margin: 0; font-size: .85rem; color: var(--ink-2); }
.action button, .file { justify-self: start; }
button { min-height: 44px; font: inherit; padding: 0 .8rem; cursor: pointer; }
.file { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; font-size: .9rem; color: var(--brand); }
.file input { max-width: 100%; }
.preview { display: grid; gap: .45rem; padding: .9rem 1rem; border: 1px solid #d9a1a1; border-left: 4px solid var(--danger); border-radius: var(--radius-1); background: var(--danger-soft); }
.warning { margin: 0; font-weight: 700; color: var(--danger); }
.preview p { margin: 0; font-size: .9rem; }
.preview button { justify-self: start; }
.danger { background: var(--danger); color: #fff; border: 1px solid var(--danger); }
.danger:hover:not(:disabled) { background: #6f1414; border-color: #6f1414; }
.message { margin: 0; padding: .6rem .85rem; background: var(--info-soft); color: var(--info-ink); border-left: 3px solid #2f6f9f; border-radius: 0 var(--radius-1) var(--radius-1) 0; }
/* 无消息时不占位，但节点始终留在无障碍树里，等文本变化时由实时区域播报。 */
.message-live { margin: 0; }
.hint { margin: 0; color: var(--ink-3); font-size: 0.85rem; }
</style>
