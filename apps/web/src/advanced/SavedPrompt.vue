<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import type { VehicleDetails } from '../../../../packages/application/records.mjs';
import VehicleFields from './VehicleFields.vue';
const props = defineProps<{
  saved: { recordId: string; message: string };
  disabled?: boolean;
  feedback?: { ok: boolean; message: string } | null;
}>();
const emit = defineEmits<{
  vehicle: [recordId: string, details: VehicleDetails];
  restart: [];
}>();
const filling = ref(false);
const details = ref<VehicleDetails>({ model: '', number: '', formation: '' });
const submitted = ref<VehicleDetails | null>(null);
const form = ref<HTMLFormElement | null>(null);
const currentFeedback = computed(() => submitted.value
  && (['model', 'number', 'formation'] as const).every(key => details.value[key].trim() === submitted.value![key])
  ? props.feedback : null);
const heading = ref<HTMLElement | null>(null);
onMounted(() => { void nextTick(() => heading.value?.focus()); });
function showVehicle(): void {
  filling.value = true;
  void nextTick(() => form.value?.querySelector('input')?.focus());
}
function submit(): void {
  if (props.disabled) return;
  submitted.value = {
    model: details.value.model.trim(), number: details.value.number.trim(), formation: details.value.formation.trim(),
  };
  emit('vehicle', props.saved.recordId, { ...submitted.value });
}
</script>

<template>
  <section class="saved-prompt" aria-labelledby="adv-saved">
    <h2 id="adv-saved" ref="heading" tabindex="-1">进阶记录已保存</h2>
    <p role="status">{{ saved.message }}</p>
    <p>要补充本次乘车的车辆信息吗？可以跳过，以后在「已保存」中补录。</p>
    <button v-if="!filling" type="button" class="primary" :disabled="disabled" @click="showVehicle">填写车辆信息</button>
    <form v-else ref="form" @submit.prevent="submit">
      <VehicleFields v-model="details" :disabled="disabled" />
      <button type="submit" class="primary" :disabled="disabled">{{ disabled ? '正在保存…' : '保存车辆信息' }}</button>
      <p v-if="currentFeedback" :role="currentFeedback.ok ? 'status' : 'alert'">{{ currentFeedback.message }}</p>
    </form>
    <button type="button" class="secondary" :disabled="disabled" @click="emit('restart')">
      {{ currentFeedback?.ok ? '继续录入下一条' : '暂不填写，继续录入' }}
    </button>
  </section>
</template>

<style scoped>
.saved-prompt, form { display: grid; gap: .75rem; min-width: 0; }
.saved-prompt { padding: 1.1rem 1.2rem; border: 1px solid #b7d3c0; border-radius: var(--radius-2); background: var(--ok-soft); }
.saved-prompt h2 { color: var(--ok-ink); }
h2, p { margin: 0; overflow-wrap: anywhere; }
button { min-height: 44px; }
</style>
