<script setup lang="ts">
import { computed } from 'vue';
import { SECTION_STYLE, STATION_FILL, STATION_RING } from './styles';
import type { SectionStatus } from './types';

/**
 * 图例：把区间状态的线型、车站标记和坐标来源说明放在图旁。
 *
 * 图例本身承担非颜色唯一编码的说明职责：即使颜色不可辨，线型（实线/虚线）
 * 与文字描述也能区分状态，因此图例不是可选装饰。
 */
const props = withDefaults(
  defineProps<{
    stationCount?: number;
    sectionCount?: number;
    hiddenLabelCount?: number;
  }>(),
  { stationCount: 0, sectionCount: 0, hiddenLabelCount: 0 },
);

const SECTION_ORDER: readonly Exclude<SectionStatus, 'retired'>[] = ['operated', 'temporary'];
const sectionItems = computed(() => SECTION_ORDER.map(status => ({ status, ...SECTION_STYLE[status] })));

const hiddenLabelText = computed(() =>
  props.hiddenLabelCount > 0 ? `为防重叠，${props.hiddenLabelCount} 个站名标签已省略。` : '',
);
</script>

<template>
  <div class="map-legend">
    <ul class="map-legend__list">
      <li v-for="item in sectionItems" :key="item.status" class="map-legend__item" :data-status="item.status">
        <svg class="map-legend__swatch" width="36" height="12" viewBox="0 0 36 12" aria-hidden="true" focusable="false">
          <line
            x1="2"
            y1="6"
            x2="34"
            y2="6"
            :stroke="item.stroke"
            :stroke-width="item.width"
            :stroke-dasharray="item.dash === 'none' ? undefined : item.dash"
            stroke-linecap="round"
          />
        </svg>
        <span>{{ item.description }}</span>
      </li>
      <li class="map-legend__item" data-status="station">
        <svg class="map-legend__swatch" width="36" height="12" viewBox="0 0 36 12" aria-hidden="true" focusable="false">
          <circle cx="18" cy="6" r="4" :fill="STATION_FILL" :stroke="STATION_RING" stroke-width="1.5" />
        </svg>
        <span>车站（点）</span>
      </li>
    </ul>
    <p class="map-legend__summary">共 {{ stationCount }} 站、{{ sectionCount }} 个区间。</p>
    <p v-if="hiddenLabelText" class="map-legend__note">{{ hiddenLabelText }}</p>
  </div>
</template>

<style scoped>
.map-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  align-items: baseline;
  margin-top: 8px;
  font-size: 12px;
  color: var(--ink-2);
}

.map-legend__list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.map-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.map-legend__swatch {
  flex: none;
}

.map-legend__summary,
.map-legend__note {
  margin: 0;
}
</style>
