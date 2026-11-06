<script setup lang="ts">
/**
 * 受控日期输入：输入过程中的中间值只留在本地 draft，不提交也不回写父组件。
 *
 * 原生 date 输入在分段（年/月/日）输入时会连续派发 change，中间态可能是
 * 0002-10-30 这类「格式完整但越界」的值。若每次 change 都提交、由父组件夹取边界
 * 后再把 :value 写回输入框，用户正在输入的年份就会被改写成边界值。
 * 这里只在完整合法（YYYY-MM-DD）且落在 [min, max] 内时 emit('change')；
 * 其余情况保留用户输入，失焦时再恢复为最后一次已提交的 value。
 *
 * 说明挂在控件整体（role="group"）上，不挂在 input 上：Chromium 的原生 date 输入
 * 由年/月/日三个 spinbutton 组成，读屏器会把 input 上的 aria-describedby 在每个分段上
 * 重念一遍（统计基准日的说明被念三遍）。分组包装让说明只属于整个日期控件一次。
 *
 * 名称只留一个来源：复用方的原生 <label for>，或（没有可见标签时）input 自己的
 * aria-labelledby。名称不能再挂到分组上——分组名与控件名会各念一次，读屏器播报成
 * 「统计基准日 统计基准日」（走查 D1）；分组本身不需要名称。
 * inheritAttrs:false 让 aria-invalid 等属性仍然落在真正的 input 上。
 */
import { computed, ref, useAttrs, watch } from 'vue';

const props = defineProps<{
  id: string;
  value: string;
  min?: string;
  max?: string;
  disabled?: boolean;
}>();
defineOptions({ inheritAttrs: false });
const emit = defineEmits<{ change: [value: string] }>();

// 说明按 ARIA 属性名接收（不必让复用方记一套自定义 prop 名），只挂到分组上；
// 名称与其余属性（aria-labelledby、aria-invalid、class 等）仍原样落在 input 上。
const attrs = useAttrs();
const describedBy = computed(() => attrs['aria-describedby'] as string | undefined);
const inputAttrs = computed(() => {
  const rest: Record<string, unknown> = { ...attrs };
  delete rest['aria-describedby'];
  return rest;
});

const PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const committed = ref(props.value ?? '');
const draft = ref(committed.value);

// 换页/换快照等外部来源改变权威值时同步控件；输入过程中父组件的 value 不变，draft 不被改写。
watch(() => props.value, next => {
  committed.value = next ?? '';
  draft.value = committed.value;
});

function inRange(value: string): boolean {
  if (!PATTERN.test(value)) return false;
  if (props.min !== undefined && value < props.min) return false;
  if (props.max !== undefined && value > props.max) return false;
  return true;
}

function onInput(event: Event): void {
  draft.value = (event.target as HTMLInputElement).value;
}

function onChange(event: Event): void {
  const next = (event.target as HTMLInputElement).value;
  draft.value = next;
  if (!inRange(next)) return;
  committed.value = next;
  emit('change', next);
}

function onBlur(): void {
  if (!inRange(draft.value)) draft.value = committed.value;
}
</script>

<template>
  <span class="date-field-group" role="group" :aria-describedby="describedBy">
    <input v-bind="inputAttrs" :id="id" type="date" :value="draft" :min="min" :max="max" :disabled="disabled"
      @input="onInput" @change="onChange" @blur="onBlur" />
  </span>
</template>

<style scoped>
/* 分组只是语义包装，视觉上不能改变原生日期框的尺寸或换行行为。 */
.date-field-group { display: block; min-width: 0; max-width: 100%; }
</style>
