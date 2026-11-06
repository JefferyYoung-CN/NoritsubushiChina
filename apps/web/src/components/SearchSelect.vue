<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  id: string;
  label: string;
  modelValue: string;
  options: readonly { id: string; label: string; description?: string }[];
  placeholder?: string;
  emptyText?: string;
  describedby?: string;
  disabled?: boolean;
  clearable?: boolean;
}>(), { placeholder: '输入关键词或展开选择', emptyText: '没有匹配项，请换个关键词。', clearable: true });
const emit = defineEmits<{ 'update:modelValue': [id: string]; search: [] }>();
const root = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const open = ref(false);
const query = ref('');
const composing = ref(false);
const activeIndex = ref(-1);
const above = ref(false);
const menuHeight = ref('18rem');
const selected = computed(() => props.options.find(option => option.id === props.modelValue));
const results = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return props.options.filter(option => `${option.label} ${option.description ?? ''}`.toLocaleLowerCase().includes(term));
});
const activeId = computed(() => open.value && results.value[activeIndex.value] ? `${props.id}-option-${activeIndex.value}` : undefined);
const value = computed(() => open.value ? query.value : selected.value?.label ?? '');
/**
 * 实时区域只放「用户操作后」才该听到的话。聚焦本身也会展开列表（保持候选可发现），
 * 但那时不写实时区域，否则每次 Tab 进输入框都会被重灌一遍结果数与操作说明。
 */
const announcement = ref('');
let announcedCount = -1;
/** 结果数与上次已播报的相同就保持沉默，避免每敲一个字都重复同一句。 */
function announceResults(): void {
  if (!open.value) return;
  const count = results.value.length;
  if (count === announcedCount) return;
  announcedCount = count;
  announcement.value = count ? `${count} 个结果，使用上下方向键选择，回车确认。` : props.emptyText;
}

function expand(): void {
  if (props.disabled || open.value) return;
  query.value = '';
  activeIndex.value = -1;
  open.value = true;
}
function close(): void {
  open.value = false;
  composing.value = false;
  announcement.value = '';
  announcedCount = -1;
}
function choose(index: number): void {
  const option = results.value[index];
  if (props.disabled || composing.value || !option) return;
  emit('update:modelValue', option.id);
  close();
}
function edit(event: Event): void {
  if (props.disabled) return;
  if (!open.value) expand();
  query.value = (event.target as HTMLInputElement).value;
  emit('search');
  activeIndex.value = -1;
  announceResults();
}
async function move(delta: number): Promise<void> {
  expand();
  announceResults();
  const count = results.value.length;
  if (!count) return;
  activeIndex.value = activeIndex.value < 0 ? (delta > 0 ? 0 : count - 1)
    : (activeIndex.value + delta + count) % count;
  await nextTick();
  if (activeId.value) root.value?.querySelector(`[id="${activeId.value}"]`)?.scrollIntoView?.({ block: 'nearest' });
}
function keydown(event: KeyboardEvent): void {
  // 中文输入法的回车用于确认文字，不能同时选中候选或提交外层表单。
  if (composing.value || event.isComposing || event.keyCode === 229) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    void move(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (open.value) choose(activeIndex.value < 0 ? 0 : activeIndex.value);
    else expand();
  } else if (event.key === 'Escape') {
    const wasOpen = open.value;
    if (wasOpen) event.preventDefault();
    close();
    // close() 会清空实时区域；用户按 Esc 关掉候选后需要一句确认，否则不知道自己取消了什么（走查发现 8）。
    if (wasOpen) announcement.value = '已关闭候选列表';
  } else if (event.key === 'Tab') close();
}
function leave(event: FocusEvent): void {
  if (!root.value?.contains(event.relatedTarget as Node | null)) close();
}
function positionMenu(): void {
  if (!open.value || !root.value) return;
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const height = viewport?.height ?? window.innerHeight;
  const rect = root.value.getBoundingClientRect();
  const below = Math.max(0, top + height - rect.bottom - 8);
  const before = Math.max(0, rect.top - top - 8);
  const preferred = Math.min(288, height * .45);
  above.value = below < preferred && before > below;
  menuHeight.value = `${Math.max(0, Math.min(preferred, above.value ? before : below) - 2)}px`;
}
async function clear(): Promise<void> {
  if (props.disabled) return;
  emit('update:modelValue', '');
  close();
  await nextTick();
  input.value?.focus();
  expand();
  announceResults();
}
watch(() => props.disabled, disabled => { if (disabled) close(); });
watch(results, () => { activeIndex.value = -1; }, { flush: 'sync' });
watch(() => props.modelValue, id => { if (id || !open.value) close(); });
watch(open, expanded => { if (expanded) void nextTick(positionMenu); });
onMounted(() => {
  window.addEventListener('resize', positionMenu);
  window.addEventListener('scroll', positionMenu, true);
  window.visualViewport?.addEventListener('resize', positionMenu);
  window.visualViewport?.addEventListener('scroll', positionMenu);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', positionMenu);
  window.removeEventListener('scroll', positionMenu, true);
  window.visualViewport?.removeEventListener('resize', positionMenu);
  window.visualViewport?.removeEventListener('scroll', positionMenu);
});
</script>

<template>
  <div ref="root" class="search-select" @focusout="leave">
    <label :for="id">{{ label }}</label>
    <div class="field">
      <input :id="id" ref="input" role="combobox" type="text" autocomplete="off" :disabled="disabled"
        :value="value" :placeholder="open && selected ? selected.label : placeholder" :aria-expanded="open"
        aria-autocomplete="list" aria-haspopup="listbox" :aria-controls="`${id}-listbox`"
        :aria-activedescendant="activeId" :aria-describedby="[describedby, `${id}-hint`].filter(Boolean).join(' ')"
        @focus="expand" @click="expand" @input="edit" @keydown="keydown"
        @compositionstart="composing = true" @compositionend="composing = false; edit($event)" />
      <button v-if="clearable && (modelValue || (open && query))" type="button" class="clear" :disabled="disabled"
        :aria-label="`清空${label}`" @pointerdown.prevent @click="clear">×</button>
      <span class="chevron" aria-hidden="true">⌄</span>
    </div>
    <div v-if="open" class="popup" :class="{ above }">
      <ul :id="`${id}-listbox`" role="listbox" :aria-label="label" class="results" :style="{ maxHeight: menuHeight }">
        <li v-for="(option, index) in results" :id="`${id}-option-${index}`" :key="option.id"
          role="option" :data-value="option.id" :aria-selected="option.id === modelValue" :class="{ active: activeIndex === index }"
          @pointerdown.prevent @click="choose(index)">
          <span>{{ option.label }}</span>
          <small v-if="option.description">{{ option.description }}</small>
          <span v-if="option.id === modelValue" class="selected-mark" aria-hidden="true">✓</span>
        </li>
      </ul>
      <p v-if="!results.length" class="no-results">{{ emptyText }}</p>
    </div>
    <p :id="`${id}-status`" class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>
    <!-- 用法写在常驻描述里（聚焦时读一次），实时区域只留给结果数变化。 -->
    <span :id="`${id}-hint`" class="sr-only">输入关键词可筛选候选；按上下方向键选择，回车确认，Esc 关闭候选。</span>
  </div>
</template>

<style scoped>
.search-select { position: relative; display: grid; gap: .3rem; min-width: 0; width: 100%; align-self: start; }
label { font-size: .9rem; font-weight: 500; color: var(--ink); }
.field { position: relative; min-width: 0; }
input {
  width: 100%; min-width: 0; min-height: 44px; padding: .55rem 4.2rem .55rem .75rem;
  border: 1px solid var(--line-strong); border-radius: var(--radius-1); background: var(--surface); color: var(--ink); font: inherit;
  text-overflow: ellipsis; transition: border-color .15s ease, box-shadow .15s ease;
}
input:hover:not(:disabled) { border-color: #8ba294; }
input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgb(22 62 56 / 12%); }
input:disabled { background: #eef1ec; color: var(--ink-3); cursor: not-allowed; }
.clear {
  position: absolute; right: 1.9rem; top: 0; width: 2.4rem; min-height: 44px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 0; padding: 0; color: var(--ink-2); background: transparent; font: inherit; font-size: 1.15rem; border-radius: var(--radius-1);
}
.clear:hover:not(:disabled) { background: var(--brand-soft); color: var(--brand); }
.chevron { position: absolute; right: .75rem; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--ink-3); }
.popup {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 30; margin-top: .3rem;
  border: 1px solid var(--line-strong); border-radius: var(--radius-1); background: var(--surface);
  box-shadow: var(--shadow-2); overflow: hidden;
}
.popup.above { top: auto; bottom: 100%; margin-top: 0; margin-bottom: .3rem; }
.results { max-height: min(18rem, 45vh); overflow-y: auto; overscroll-behavior: contain; list-style: none; padding: .25rem; margin: 0; }
[role='option'] { position: relative; display: grid; min-height: 44px; align-content: center; padding: .5rem 2rem .5rem .6rem; border-radius: 6px; cursor: pointer; overflow-wrap: anywhere; }
[role='option']:hover, [role='option'].active { background: var(--brand-soft); }
[role='option'][aria-selected='true'] { font-weight: 600; color: var(--brand); }
small { color: var(--ink-2); font-weight: 400; }
.selected-mark { position: absolute; right: .7rem; top: .6rem; color: var(--brand); }
.no-results { margin: 0; padding: .8rem; color: var(--ink-2); font-size: .9rem; overflow-wrap: anywhere; }
</style>
