<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { stationOptions } from '../integration/trip';
import { physicalLinesAtStation } from './physical-route';
import SearchSelect from '../components/SearchSelect.vue';

const props = defineProps<{ network: TransitNetwork; onDate: string; disabled?: boolean; selectedLineId?: string }>();
const emit = defineEmits<{ select: [stationId: string]; line: [lineId: string] }>();
const selected = ref('');
const stations = computed(() => stationOptions(props.network, props.onDate));
const station = computed(() => stations.value.find(option => option.id === selected.value));
const lines = computed(() => physicalLinesAtStation(props.network, props.onDate, selected.value));
function choose(stationId: string): void { selected.value = stationId; emit('select', stationId); emit('line', ''); }
watch(() => [props.network, props.onDate], () => choose(''));
</script>

<template>
  <section class="finder station-finder" aria-labelledby="station-finder-title">
    <h3 id="station-finder-title" class="sr-only">按车站查找</h3>
    <SearchSelect :key="onDate + network.snapshotId" id="station-finder-query" label="查找车站"
      :model-value="selected" :options="stations" :disabled="disabled" placeholder="输入站名或编号，例如：示例站"
      empty-text="没有匹配的当日办客车站，请换站名、编号或核对日期。" @search="choose('')" @update:model-value="choose" />
    <template v-if="station">
      <p v-if="!lines.length" role="status">该站当日没有经过的可用物理线路，请核对日期或换站。</p>
      <SearchSelect v-else :key="selected" id="station-finder-line" label="经过该站的物理线路"
        :model-value="selectedLineId ?? ''" :options="lines" :disabled="disabled" @update:model-value="emit('line', $event)" />
    </template>
  </section>
</template>

<style scoped>
.finder { display: grid; gap: .6rem; min-width: 0; }
p { margin: 0; overflow-wrap: anywhere; }
</style>
