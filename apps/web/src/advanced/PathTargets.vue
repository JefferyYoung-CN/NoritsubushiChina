<script setup lang="ts">
/**
 * 线路解析结果的呈现（P5 S7）：唯一径路目标可选，多径路目标只列出不可选。
 * 组件不解析径路、不猜选：歧义目标只显示领域层给出的 detail。
 * 整圈目标（回到本段起点）是到站列表的末项，与普通到站同一列表、同一选择方式；
 * 文字始终写明「整圈」，读屏可读，不靠图标区分。
 */
import { computed } from 'vue';
import type { ServicePaths } from './chain';
import SearchSelect from '../components/SearchSelect.vue';
import { formatLength } from '../stats/statistics';

const props = defineProps<{ paths: ServicePaths; disabled?: boolean }>();
const emit = defineEmits<{ select: [stationId: string] }>();

/** 到站候选：普通到站按线路顺序在前，整圈作为末项；两者同一列表、同一选择方式。 */
const options = computed(() => [
  ...props.paths.reachable.map(target => ({ target, loop: false })),
  ...(props.paths.loop ? [{ target: props.paths.loop, loop: true }] : []),
].map(({ target, loop }) => ({
  id: target.stationId,
  label: loop ? `回到起点 · 整圈（${target.sectionIds.length} 区间）` : target.stationName,
  description: [
    loop ? null : `${target.sectionIds.length} 段`,
    formatLength(target.lengthMetres),
    target.routeAvailable ? null : '当日不可办客',
  ].filter(Boolean).join(' · '),
})));
</script>

<template>
  <section class="targets-block" aria-labelledby="adv-targets">
    <h4 id="adv-targets">「{{ paths.service.label }}」自 {{ paths.fromStation.stationName }} 出发</h4>
    <p v-if="options.length === 0" class="empty">该线路当日没有唯一径路目标。</p>
    <SearchSelect v-else id="adv-target" label="本段到达站" model-value=""
      :options="options"
      :disabled="disabled" :clearable="false" @update:model-value="emit('select', $event)" />

    <div v-if="paths.ambiguous.length > 0" class="ambiguous">
      <h5>多条径路：不可选</h5>
      <p class="note">这些目标站有不止一条径路，需由数据发布方判定；此处不替你挑一条。</p>
      <ul>
        <li v-for="target in paths.ambiguous" :key="target.stationId">
          <strong>{{ target.stationName }}</strong>：{{ target.detail }}
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.targets-block { display: grid; gap: 0.5rem; }
h4, h5 { margin: 0; }
.ambiguous { border-left: 4px solid #9a6700; background: #fff8e5; padding: 0.4rem 0.6rem; }
.ambiguous ul { margin: 0.3rem 0 0; padding-left: 1.2rem; overflow-wrap: anywhere; }
.note, .empty { margin: 0; font-size: 0.85rem; color: #444; }
</style>
