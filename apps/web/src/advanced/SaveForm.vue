<script setup lang="ts">
/**
 * 保存前仅收集可选备注；车辆在写入成功后补录。
 * 组件不持有链、不写存储，只把用户填写的元数据交回面板。
 */
import { ref } from 'vue';

defineProps<{ disabled?: boolean; canSave: boolean }>();
const emit = defineEmits<{ save: [meta: { readonly note: string }] }>();

const note = ref('');
</script>

<template>
  <section class="save" aria-labelledby="adv-save">
    <h4 id="adv-save">保存为一条记录</h4>
    <form class="row" @submit.prevent="emit('save', { note: note.trim() })">
      <label for="adv-note">备注（可选）</label>
      <input id="adv-note" v-model="note" maxlength="2000" :disabled="disabled" aria-describedby="adv-save-note" />
      <button type="submit" class="primary" :disabled="disabled || !canSave">保存</button>
    </form>
    <p id="adv-save-note" class="note">整条乘车径路保存为一条记录。</p>
  </section>
</template>

<style scoped>
.save { display: grid; gap: 0.4rem; min-width: 0; border-top: 1px solid #ccc; padding-top: 0.5rem; }
h4 { margin: 0; }
.row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: end; min-width: 0; }
label { font-size: 0.9rem; }
input, button { min-height: 44px; min-width: 0; max-width: 100%; font: inherit; }
input { padding: 0 0.5rem; }
.note { margin: 0; font-size: 0.85rem; color: #444; overflow-wrap: anywhere; }
</style>
