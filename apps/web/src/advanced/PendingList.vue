<script setup lang="ts">
/**
 * 待处理记录的呈现：五类 reason 的中文文案由领域层统一给出，这里整条照实展示、
 * 不并入任何统计口径；删除是不可逆操作，必须在本组件内二次确认。
 */
import { nextTick, ref } from 'vue';
import { pendingReasonText } from './advance';
import type { PendingItem } from './panelTypes';

defineProps<{ items: readonly PendingItem[]; disabled?: boolean }>();
const emit = defineEmits<{ delete: [record: { layer: 'basic' | 'advanced'; recordId: string }] }>();

const confirming = ref<string | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);
const deleteButtons = new Map<string, HTMLButtonElement>();
const section = ref<HTMLElement | null>(null);

/** v-for 内的模板 ref 在 Vue 3 里是数组，统一用函数 ref 记录实际元素。 */
function trackConfirm(element: unknown): void {
  confirmButton.value = element instanceof HTMLButtonElement ? element : null;
}

/** 行内「删除…」按钮的引用：确认/取消后焦点要回到同一行。 */
function trackDelete(recordId: string, element: unknown): void {
  if (element instanceof HTMLButtonElement) deleteButtons.set(recordId, element);
  else deleteButtons.delete(recordId);
}

async function ask(recordId: string): Promise<void> {
  confirming.value = recordId;
  await nextTick();
  confirmButton.value?.focus();
}

async function restoreFocus(recordId: string): Promise<void> {
  await nextTick();
  const target = deleteButtons.get(recordId);
  if (target && target.isConnected) target.focus();
  else section.value?.focus();
}

async function cancelConfirm(recordId: string): Promise<void> {
  confirming.value = null;
  await restoreFocus(recordId);
}

async function confirmDelete(item: PendingItem): Promise<void> {
  const recordId = item.recordId;
  confirming.value = null;
  emit('delete', { layer: item.layer, recordId });
  // 确认后待处理行会被父级异步卸载：此刻行内「删除…」按钮还连着，先聚焦它会在卸载后丢到 BODY。
  // 因此确认路径只落回持久的 section；取消路径仍由 restoreFocus 回到行内按钮。
  await nextTick();
  section.value?.focus();
}
</script>

<template>
  <section ref="section" class="pending" aria-labelledby="adv-pending" tabindex="-1">
    <h3 id="adv-pending">待处理记录（{{ items.length }}）</h3>
    <p v-if="items.length === 0" class="empty">没有待处理记录。</p>
    <template v-else>
      <p class="note">这些记录整条保留、原样展示，不计入统计；删除会丢弃记录本身，需要确认。</p>
      <ul>
        <li v-for="item in items" :key="`${item.layer}:${item.recordId}`">
          <p class="msg">{{ pendingReasonText(item.reason) }}</p>
          <p class="meta">{{ item.layer === 'advanced' ? '进阶' : '基础' }} · {{ item.recordId }}</p>
          <div v-if="confirming === item.recordId" class="confirm" role="group" aria-label="确认删除待处理记录"
            @keydown.esc.prevent="cancelConfirm(item.recordId)">
            <button :ref="trackConfirm" type="button" class="danger" :disabled="disabled" @click="confirmDelete(item)">确认删除</button>
            <button type="button" :disabled="disabled" @click="cancelConfirm(item.recordId)">取消</button>
          </div>
          <button v-else :ref="el => trackDelete(item.recordId, el)" type="button" :disabled="disabled" @click="ask(item.recordId)">删除…</button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.pending { display: grid; gap: 0.4rem; }
h3 { margin: 0; }
ul { display: grid; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
li { border: 1px solid #bbb; padding: 0.4rem 0.6rem; overflow-wrap: anywhere; }
.msg { margin: 0; }
.meta { margin: 0.2rem 0 0.4rem; color: #555; font-size: 0.8rem; }
button { min-height: 44px; font: inherit; }
button + button { margin-left: 0.4rem; }
.confirm { display: flex; flex-wrap: wrap; gap: 0.4rem; }
/* 危险按钮必须覆盖全局 button 的深绿底（#163e38）；白底 + 深红字约 10:1。 */
.danger { background: #fff; border-color: #8a1c1c; color: #8a1c1c; }
.danger:hover { background: #fde8e8; color: #6f1414; }
.danger:active { background: #f8d7d7; }
.note, .empty { margin: 0; font-size: 0.85rem; color: #444; }
</style>
