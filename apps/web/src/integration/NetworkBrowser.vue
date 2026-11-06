<script setup lang="ts">
/**
 * 线路查找区（票 05 拆分后）：只留两个互斥查找入口与「已选物理线路」摘要。
 * 图的视图模型映射与渲染移到 `integration/RouteDiagramPanel.vue`，由选择器按
 * 「标题 → 回显行 → 手动选站 → 图」的顺序摆放；这里不再渲染线路图。
 */
import { ref } from 'vue';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import StationFinder from '../records/StationFinder.vue';
import LineFinder from '../records/LineFinder.vue';
const props = defineProps<{ network: TransitNetwork; onDate: string; selectedLineId: string; disabled?: boolean }>();
const emit = defineEmits<{ line: [lineId: string] }>();
const mode = ref<'' | 'line' | 'station'>('');
function changeMode(value: 'line' | 'station'): void {
  if (props.disabled || mode.value === value) return;
  mode.value = value;
  emit('line', '');
}
</script>

<template>
  <section aria-labelledby="browse-title" class="browser">
    <div class="section-head">
      <h2 id="browse-title"><span class="step-num" aria-hidden="true">1</span>查找线路</h2>
      <p class="section-lead">先选择查找方式，再选择要记录的物理线路。</p>
    </div>
    <div class="modes" role="group" aria-label="查找方式">
      <!-- 未选方式时下方是空的：把「选一个」这句挂到按钮的描述上，Tab 到按钮才听得见，
           不必让用户先 Tab 过全部控件才发现页面没内容。 -->
      <button type="button" :disabled="disabled" :aria-pressed="mode === 'line'" aria-controls="network-finder"
        :aria-describedby="mode ? undefined : 'network-finder-hint'"
        @click="changeMode('line')">按线路查找</button>
      <button type="button" :disabled="disabled" :aria-pressed="mode === 'station'" aria-controls="network-finder"
        :aria-describedby="mode ? undefined : 'network-finder-hint'"
        @click="changeMode('station')">按车站查找</button>
    </div>
    <div id="network-finder" class="finders">
      <StationFinder v-if="mode === 'station'" :network="network" :on-date="onDate" :disabled="disabled" :selected-line-id="selectedLineId"
        @line="emit('line', $event)" />
      <LineFinder v-else-if="mode === 'line'" :network="network" :on-date="onDate" :disabled="disabled" :selected-line-id="selectedLineId" @select="emit('line', $event)" />
      <p v-else id="network-finder-hint" class="finder-empty" role="status">请选择「按线路查找」或「按车站查找」。</p>
    </div>
    <div v-if="selectedLineId" class="line-summary">
      <div class="line-summary__head">
        <h3>已选物理线路 · {{ network.lines.find(row => row.id === selectedLineId)?.name }}</h3>
        <p class="section-lead">在「选择乘车区间」里先选出发站，再选到达站。</p>
      </div>
    </div>
    <p class="note">历史日期仅使用该日期有效的已验证快照；没有覆盖时不会借用其他日期数据。</p>
  </section>
</template>

<style scoped>
.browser { display: grid; grid-template-columns: minmax(0, 1fr); gap: .75rem; min-width: 0; }
.finders { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.modes { display: inline-flex; flex-wrap: wrap; gap: .25rem; padding: .2rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; width: fit-content; max-width: 100%; }
.modes button { min-height: 44px; padding: .35rem .85rem; border: 1px solid transparent; border-radius: 999px; background: transparent; color: var(--ink-2); font-size: .88rem; }
.modes button:hover:not(:disabled) { background: var(--brand-soft); border-color: transparent; color: var(--brand); }
.modes button[aria-pressed="true"] { background: var(--brand); border-color: var(--brand); color: #fff; font-weight: 600; }
.finder-empty { margin: 0; padding: .8rem 1rem; border: 1px dashed var(--line-strong); border-radius: var(--radius-1); color: var(--ink-2); font-size: .9rem; }
.line-summary { display: grid; gap: .5rem; padding: .9rem 1rem; background: var(--brand-tint); border: 1px solid #cfe0d4; border-radius: var(--radius-1); }
.line-summary__head h3 { font-size: 1rem; }
button { max-width: 100%; font: inherit; }
p { overflow-wrap: anywhere; }
</style>
