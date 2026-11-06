<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import VehicleFields from '../advanced/VehicleFields.vue';
import type { RecordMetadata, VehicleDetails } from '../../../../packages/application/records.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { summarizeRecords, type RecordLayer, type RecordSummaryInput } from './record-commands';
const props = defineProps<{
  network: TransitNetwork;
  facts: { readonly basic: readonly RecordSummaryInput[]; readonly advanced: readonly RecordSummaryInput[] };
  busy?: boolean;
}>();
const emit = defineEmits<{
  remove: [layer: RecordLayer, id: string];
  edit: [layer: RecordLayer, id: string, patch: RecordMetadata];
}>();
const layer = ref<RecordLayer>('basic');
const deleteTarget = ref<{ layer: RecordLayer; id: string } | null>(null);
const editing = ref<{ layer: RecordLayer; id: string; note: string; vehicle: string; vehicleDetails: VehicleDetails } | null>(null);
const section = ref<HTMLElement | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);
const deleteButtons = new Map<string, HTMLButtonElement>();
/** 确认按钮在 v-for 内：Vue 3 模板 ref 会收成数组，所以用函数 ref 记录实际元素。 */
function trackConfirm(element: unknown): void {
  confirmButton.value = element instanceof HTMLButtonElement ? element : null;
}
/** 删除目标被 v-if 换成确认区后，原「删除」按钮会消失，因此按记录键记住可复位的元素。 */
function rowKey(record: { layer: RecordLayer; id: string }): string {
  return `${record.layer}:${record.id}`;
}
function trackDelete(record: { layer: RecordLayer; id: string }, element: unknown): void {
  if (element instanceof HTMLButtonElement) deleteButtons.set(rowKey(record), element);
}
async function restoreFocus(record: { layer: RecordLayer; id: string }): Promise<void> {
  await nextTick();
  const button = deleteButtons.get(rowKey(record));
  if (button?.isConnected) button.focus();
  else section.value?.focus();
}
const records = computed(() => summarizeRecords(props.facts, props.network).filter(record => record.layer === layer.value));
watch(layer, () => { deleteTarget.value = null; editing.value = null; });
async function askDelete(record: { layer: RecordLayer; id: string }): Promise<void> {
  deleteTarget.value = record;
  await nextTick();
  confirmButton.value?.focus();
}
/**
 * 取消是静默路径：确认区被换回「删除」按钮，焦点回来了但没有任何语句说明取消已生效。
 * 用常驻实时区域补一句；同一句连读两次不会被播报，所以先清空再写入，并用序号防止连点错序。
 */
const cancelNotice = ref('');
let cancelNoticeToken = 0;
async function cancelDelete(): Promise<void> {
  const target = deleteTarget.value;
  deleteTarget.value = null;
  cancelNotice.value = '';
  const token = ++cancelNoticeToken;
  await nextTick();
  if (token === cancelNoticeToken) cancelNotice.value = '已取消删除，记录未变动。';
  if (target) await restoreFocus(target);
}
async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  emit('remove', target.layer, target.id);
  deleteTarget.value = null;
  // 确认后记录行会被父级异步卸载：此刻行内「删除」按钮还连着，先聚焦它会在卸载后丢到 BODY。
  // 因此确认路径只落回持久的 section；取消路径仍由 restoreFocus 回到行内按钮。
  await nextTick();
  section.value?.focus();
}
</script>
<template>
  <section ref="section" class="records" aria-labelledby="saved-title" tabindex="-1">
    <div class="section-head">
      <h2 id="saved-title">已保存的记录</h2>
      <p class="section-lead">记录只保存在本机；删除会影响你自己的完成统计。</p>
    </div>
    <p class="sr-only" role="status" aria-live="polite">{{ cancelNotice }}</p>
    <div role="group" aria-label="记录类型" class="layers">
      <button type="button" :aria-pressed="layer === 'basic'" @click="layer = 'basic'">基础记录</button>
      <button type="button" :aria-pressed="layer === 'advanced'" @click="layer = 'advanced'">进阶记录</button>
    </div>
    <h3 class="count">已保存（{{ records.length }} 条）</h3>
    <p v-if="records.length === 0" class="empty">当前类型尚无记录。可以先在「基础记录」或「进阶」页保存一次乘车。</p>
    <ul v-else class="list">
      <li v-for="record in records" :key="`${record.layer}:${record.id}`">
        <div class="record-content">
          <div class="record-heading">
            <span class="badge">{{ record.layer === 'basic' ? '基础' : '进阶' }}</span>
            <strong class="endpoints">{{ record.endpoints }}</strong>
          </div>
          <p class="record-line">线路：{{ record.lineNames.length ? record.lineNames.join(' → ') : '未提供' }}</p>
          <time class="date" :datetime="record.onDate">{{ record.onDate }}</time>
          <p v-if="record.note" class="record-note">{{ record.note }}</p>
          <template v-if="record.layer === 'advanced'">
            <p v-if="record.vehicle" class="record-note">原车辆信息：{{ record.vehicle }}</p>
            <p v-if="record.vehicleDetails" class="record-note">车型：{{ record.vehicleDetails.model || '未填写' }} · 车号：{{ record.vehicleDetails.number || '未填写' }} · 编成号：{{ record.vehicleDetails.formation || '未填写' }}</p>
          </template>
        </div>
        <div class="record-actions">
          <div v-if="deleteTarget && rowKey(deleteTarget) === rowKey(record)" class="confirm" role="group"
            aria-label="确认删除记录" @keydown.esc.prevent="cancelDelete">
            <p>确认删除这条记录？删除后需要重新统计。</p>
            <button :ref="trackConfirm" type="button" class="danger" :disabled="busy" @click="confirmDelete">确认删除</button>
            <button type="button" class="quiet" :disabled="busy" @click="cancelDelete">取消</button>
          </div>
          <!-- 视觉文案保持「删除」；多条记录时把端点与日期放进可访问名，读屏才分得清删哪一条。 -->
          <button v-else :ref="element => trackDelete(record, element)" type="button" class="quiet" :disabled="busy"
            :aria-label="`删除 ${record.endpoints} ${record.onDate} 的记录`" @click="askDelete(record)">删除</button>
          <button type="button" class="quiet" :disabled="busy" @click="editing = { layer: record.layer, id: record.id, note: record.note, vehicle: record.vehicle, vehicleDetails: { ...(record.vehicleDetails ?? { model: '', number: '', formation: '' }) } }">{{ record.layer === 'basic' ? '编辑备注' : '编辑备注 / 车辆' }}</button>
        </div>
        <form v-if="editing && rowKey(editing) === rowKey(record)" class="edit-form" @submit.prevent="emit('edit', editing.layer, editing.id, { note: editing.note, vehicle: editing.vehicle, ...(editing.layer === 'advanced' ? { vehicleDetails: { model: editing.vehicleDetails.model.trim(), number: editing.vehicleDetails.number.trim(), formation: editing.vehicleDetails.formation.trim() } } : {}) })">
          <label>备注<input v-model="editing.note" maxlength="2000" :disabled="busy" /></label>
          <VehicleFields v-if="editing.layer === 'advanced'" v-model="editing.vehicleDetails" :disabled="busy" />
          <div class="edit-actions">
            <button type="submit" class="primary" :disabled="busy">保存修改</button>
            <button type="button" class="quiet" :disabled="busy" @click="editing = null">关闭编辑</button>
          </div>
        </form>
      </li>
    </ul>
  </section>
</template>
<style scoped>
.records { display: grid; gap: .75rem; min-width: 0; }
h2, h3 { margin: 0; }
.count { font-size: .95rem; color: var(--ink-2); font-weight: 600; }
.layers { display: inline-flex; gap: .2rem; padding: .2rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; width: fit-content; }
.layers button { min-height: 44px; padding: .35rem .9rem; border: 1px solid transparent; border-radius: 999px; background: transparent; color: var(--ink-2); font-size: .88rem; }
.layers button:hover:not(:disabled) { background: var(--brand-soft); border-color: transparent; color: var(--brand); }
.layers button[aria-pressed="true"] { background: var(--brand); border-color: var(--brand); color: #fff; font-weight: 600; }
label { font-size: 0.9rem; font-weight: 500; }
input { width: 100%; min-width: 0; min-height: 44px; padding: 0 .7rem; border: 1px solid var(--line-strong); border-radius: var(--radius-1); }
.empty { color: var(--ink-2); font-size: .9rem; padding: .9rem 1rem; background: var(--surface-2); border: 1px dashed var(--line-strong); border-radius: var(--radius-1); }
.record-content { display: grid; gap: .3rem; min-width: 0; overflow-wrap: anywhere; }
.record-heading { display: flex; align-items: baseline; gap: .5rem; }
.endpoints { font-size: 1.08rem; line-height: 1.5; }
.record-line, .date, .record-note { margin: 0; font-size: .92rem; line-height: 1.6; color: var(--ink-2); }
.record-note { white-space: pre-wrap; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: .6rem; }
.list li { display: grid; gap: .45rem; padding: .85rem .95rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-1); min-width: 0; }
.badge { display: inline-block; flex-shrink: 0; padding: .05rem .4rem; background: var(--brand-soft); color: var(--brand); border-radius: 4px; font-size: .75rem; font-weight: 600; }
.record-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .25rem; }
.record-actions > button { min-height: 34px; padding: .2rem .55rem; font-size: .82rem; color: var(--ink-2); background: transparent; border-color: transparent; border-radius: var(--radius-1); }
.record-actions > button:hover:not(:disabled) { color: var(--brand); background: var(--brand-soft); }
.record-actions > button:disabled { opacity: .55; cursor: default; }
.confirm { flex-basis: 100%; display: grid; gap: .45rem; padding: .7rem .8rem; background: var(--danger-soft); border: 1px solid #e6bcb8; border-radius: var(--radius-1); }
.confirm p { margin: 0; color: var(--danger); font-size: .9rem; }
.confirm button { justify-self: start; }
.edit-form { display: grid; gap: .6rem; padding: .8rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-1); }
.edit-form label { display: grid; gap: .25rem; }
.edit-actions { display: flex; flex-wrap: wrap; gap: .4rem; }
button { cursor: pointer; }
@media (max-width: 600px) { .record-actions > button { min-height: 44px; } }
</style>
