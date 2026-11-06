<script setup lang="ts">
import type { VehicleDetails } from '../../../../packages/application/records.mjs';
const props = defineProps<{ modelValue: VehicleDetails; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: VehicleDetails] }>();
function update(key: keyof VehicleDetails, event: Event): void {
  emit('update:modelValue', { ...props.modelValue, [key]: (event.target as HTMLInputElement).value });
}
</script>

<template>
  <fieldset :disabled="disabled" class="vehicle-fields">
    <legend>车辆信息（均可选）</legend>
    <label>车型<input :value="modelValue.model" maxlength="100" @input="update('model', $event)" /></label>
    <label>车号<input :value="modelValue.number" maxlength="100" @input="update('number', $event)" /></label>
    <label>编成号<input :value="modelValue.formation" maxlength="100" @input="update('formation', $event)" /></label>
    <p>可只填写知道的项目；当前为自由填写，未匹配车辆库，不计入车辆完乘统计。</p>
  </fieldset>
</template>

<style scoped>
.vehicle-fields { display: grid; gap: .5rem; min-width: 0; margin: 0; padding: .75rem; border: 1px solid #bdcdc0; border-radius: 7px; }
label { display: grid; gap: .25rem; min-width: 0; }
input { width: 100%; min-width: 0; min-height: 44px; padding: .5rem; font: inherit; }
p { margin: 0; color: #53665a; overflow-wrap: anywhere; }
</style>
