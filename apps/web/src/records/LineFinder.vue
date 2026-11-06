<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { lineFilterOptions } from './physical-route';
import SearchSelect from '../components/SearchSelect.vue';

const props = defineProps<{ network: TransitNetwork; onDate: string; disabled?: boolean; selectedLineId?: string }>();
const emit = defineEmits<{ select: [lineId: string] }>();
const city = ref('');
const operator = ref('');
const candidates = computed(() => lineFilterOptions(props.network, props.onDate, city.value, operator.value));
const lines = computed(() => candidates.value.lines);
const cities = computed(() => [{ id: '', label: '全部城市' }, ...candidates.value.cities]);
const operators = computed(() => [{ id: '', label: '全部运营商' }, ...candidates.value.operators]);
watch([city, operator], () => emit('select', ''));
// 日期或另一维令候选收窄后，已选值可能已不存在；清空它，避免留下看不到的筛选条件。
watch([cities, operators], () => {
  if (city.value && !cities.value.some(option => option.id === city.value)) city.value = '';
  if (operator.value && !operators.value.some(option => option.id === operator.value)) operator.value = '';
});
watch(() => [props.network, props.onDate], () => { city.value = ''; operator.value = ''; });
</script>

<template>
  <section class="finder line-finder" aria-labelledby="line-finder-title">
    <h3 id="line-finder-title" class="sr-only">按线路查找</h3>
    <div class="filter-block">
      <p id="line-finder-filter-hint" class="filter-hint">先选城市或运营商，下方线路候选会减少；改筛选会清空已选线路。</p>
      <div class="filters">
        <SearchSelect id="line-finder-city" v-model="city" label="城市" :options="cities" :disabled="disabled"
          describedby="line-finder-filter-hint" />
        <SearchSelect id="line-finder-operator" v-model="operator" label="运营商" :options="operators" :disabled="disabled"
          describedby="line-finder-filter-hint" />
      </div>
    </div>
    <SearchSelect :key="onDate + network.snapshotId" id="line-finder-query" label="选择物理线路"
      :model-value="selectedLineId ?? ''" :options="lines" :disabled="disabled" placeholder="输入线路名，例如：一号线"
      empty-text="当前日期和筛选范围没有匹配线路，请更换关键词、城市、运营商或核对日期。"
      @search="emit('select', '')" @update:model-value="emit('select', $event)" />
  </section>
</template>

<style scoped>
.finder { display: grid; gap: .6rem; min-width: 0; }
.filter-block { display: grid; gap: .45rem; padding: .7rem .8rem; border: 1px solid var(--line); border-radius: var(--radius-1); background: var(--surface-2); }
.filter-hint { margin: 0; font-size: .85rem; line-height: 1.5; color: var(--ink-2); }
.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); gap: .6rem; }
</style>
