<script setup lang="ts">
/**
 * 当前链的只读呈现（P5 S7）：站序、段数/区间数/里程、线路顺序。
 * 径路来自链，不可在此编辑；说明文字指向"删除后按新径路重录"。
 */
import type { ChainSummary } from './chain';
import { formatLength } from '../stats/statistics';

defineProps<{ summary: ChainSummary }>();
</script>

<template>
  <section class="trail" aria-labelledby="adv-chain">
    <h4 id="adv-chain">
      当前链：{{ summary.legCount }} 段 · {{ summary.sectionIds.length }} 区间 · {{ formatLength(summary.lengthMetres) }}
    </h4>
    <ol class="chain">
      <li v-for="(station, index) in summary.stations" :key="`${station.stationId}-${index}`">
        {{ station.stationName }}<span v-if="index === 0" class="sub">起点</span>
      </li>
    </ol>
    <!-- 整圈记录起终点相同：站序只列一次起点，整圈含义用文字写明（读屏可读，不靠图标）。 -->
    <p v-if="summary.loop" class="loop">{{ summary.fromStation.stationName }} → {{ summary.toStation?.stationName }} · 整圈</p>
    <p class="note">径路只读：{{ summary.serviceLineIds.join(' → ') || '尚未选择线路' }}。</p>
  </section>
</template>

<style scoped>
.trail { display: grid; gap: 0.4rem; min-width: 0; border-top: 1px solid #ccc; padding-top: 0.5rem; }
h4 { margin: 0; overflow-wrap: anywhere; }
.chain { margin: 0; padding-left: 1.2rem; }
.chain li { overflow-wrap: anywhere; }
.sub { margin-left: 0.3rem; color: #555; font-size: 0.8rem; }
.loop { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
.note { margin: 0; font-size: 0.85rem; color: #444; overflow-wrap: anywhere; }
</style>
