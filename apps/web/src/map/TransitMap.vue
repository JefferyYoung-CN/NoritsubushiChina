<script setup lang="ts">
import { computed, useId } from 'vue';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import MapLegend from './MapLegend.vue';
import { buildMapScene, type SceneSection, type SceneStation } from './scene';
import type { PlacedLabel } from './label-placement';
import {
  HIGHLIGHT_STROKE,
  HIGHLIGHT_WIDTH,
  SECTION_STYLE,
  STATION_FILL,
  STATION_LABEL,
  STATION_RING,
} from './styles';
import type { MapSectionInput, MapStationInput } from './types';
import type { ProjectionKind } from './projection';

/**
 * 只读线路示意图（自绘 SVG，无底图、无第三方地图库）。
 *
 * 契约：所有数据由 props 传入；组件不读写 IndexedDB、不导入 Node 专用模块、不发网络
 * 请求，因此可以放进只读概览页，也可以被日期视图以筛选后的站点/区间子集复用。
 * 站名标签布局在 scene.ts 里完成（确定性贪心），组件只负责渲染，便于单测。
 */
const props = withDefaults(
  defineProps<{
    network: TransitNetwork;
    /** onDate（YYYY-MM-DD）；缺省取快照日期，仅用于站名与区间状态的展示推导。 */
    onDate?: string;
    stations?: readonly MapStationInput[];
    sections?: readonly MapSectionInput[];
    selectedStationId?: string | null;
    highlightStationId?: string | null;
    highlightSectionIds?: readonly string[];
    /** 逻辑画布尺寸（viewBox）；实际显示宽度跟随容器，保持比例缩放。 */
    width?: number;
    height?: number;
    padding?: number;
    projection?: ProjectionKind;
    title?: string;
    description?: string;
    /** 适配器：宿主可在监听 select 之外直接传回调；两者都会收到同一次选择。 */
    onSelect?: (stationId: string) => void;
  }>(),
  {
    onDate: undefined,
    stations: undefined,
    sections: undefined,
    selectedStationId: null,
    highlightStationId: null,
    highlightSectionIds: () => [],
    width: 640,
    height: 400,
    padding: 24,
    projection: 'mercator',
    title: '线路示意图',
    description: undefined,
    onSelect: undefined,
  },
);

const emit = defineEmits<{ select: [stationId: string] }>();

// 稳定且唯一的 id，供 <title>/<desc> 与 aria-labelledby 关联；useId 由 Vue 按应用实例编号。
const uid = useId();

const scene = computed(() =>
  buildMapScene({
    network: props.network,
    onDate: props.onDate ?? props.network.snapshotAsOf.slice(0, 10),
    stations: props.stations,
    sections: props.sections,
    highlightStationId: props.highlightStationId,
    highlightSectionIds: props.highlightSectionIds,
    selectedStationId: props.selectedStationId,
    width: props.width,
    height: props.height,
    padding: props.padding,
    projection: props.projection,
  }),
);

// 渲染用的扁平视图：两种状态字段一致，模板里不必对联合类型再做收窄。
const view = computed(() => {
  const current = scene.value;
  if (!current.available) {
    return {
      available: false as const,
      message: current.message,
      stations: [] as readonly SceneStation[],
      sections: [] as readonly SceneSection[],
      labels: [] as readonly PlacedLabel[],
      hiddenLabelIds: [] as readonly string[],
    };
  }
  return {
    available: true as const,
    message: '',
    stations: current.stations,
    sections: current.sections,
    labels: current.labels,
    hiddenLabelIds: current.hiddenLabelIds,
  };
});

const viewBox = computed(() => `0 0 ${props.width} ${props.height}`);

const sceneDescription = computed(() => {
  if (props.description) return props.description;
  const current = scene.value;
  if (!current.available) return current.message;
  const statuses = current.sections.reduce<Record<string, number>>((counts, section) => {
    counts[section.status] = (counts[section.status] ?? 0) + 1;
    return counts;
  }, {});
  const parts = [
    `共 ${current.stations.length} 个车站、${current.sections.length} 个区间`,
    `运营 ${statuses.operated ?? 0}、临时停运 ${statuses.temporary ?? 0}`,
    '按站点坐标投影绘制，无底图，区间为端点直连',
  ];
  return `${parts.join('；')}。`;
});

function stationAriaLabel(station: { label: string; selected: boolean; highlighted: boolean }): string {
  const marks = [station.selected ? '已选中' : '', station.highlighted ? '高亮' : ''].filter(Boolean).join('，');
  return marks.length > 0 ? `${station.label}（${marks}）` : station.label;
}

function select(stationId: string): void {
  emit('select', stationId);
  props.onSelect?.(stationId);
}
</script>

<template>
  <section class="transit-map" :aria-label="title">
    <!-- 缺坐标或没有站点时不画任何图形，也不补造底图：直接给出可读降级说明。 -->
    <p v-if="!view.available" class="transit-map__notice" role="status">{{ view.message }}</p>
    <template v-else>
      <svg
        class="transit-map__canvas"
        role="img"
        :viewBox="viewBox"
        :aria-labelledby="`${uid}-title ${uid}-desc`"
        preserveAspectRatio="xMidYMid meet"
        focusable="false"
      >
        <title :id="`${uid}-title`">{{ title }}</title>
        <desc :id="`${uid}-desc`">{{ sceneDescription }}</desc>

        <g class="transit-map__sections" aria-hidden="true">
          <path
            v-for="section in view.sections"
            :key="section.id"
            class="transit-map__section"
            :data-section-id="section.id"
            :data-status="section.status"
            :d="`M ${section.from.x} ${section.from.y} L ${section.to.x} ${section.to.y}`"
            :stroke="section.highlighted ? HIGHLIGHT_STROKE : SECTION_STYLE[section.status].stroke"
            :stroke-width="section.highlighted ? HIGHLIGHT_WIDTH : SECTION_STYLE[section.status].width"
            :stroke-dasharray="
              SECTION_STYLE[section.status].dash === 'none' ? undefined : SECTION_STYLE[section.status].dash
            "
            stroke-linecap="round"
            fill="none"
          />
        </g>

        <g class="transit-map__labels" aria-hidden="true">
          <text
            v-for="label in view.labels"
            :key="label.id"
            class="transit-map__label"
            :data-station-id="label.id"
            :x="label.textX"
            :y="label.textY"
            :text-anchor="label.textAnchor"
            :font-size="11"
            :fill="STATION_LABEL"
          >
            {{ label.text }}
          </text>
        </g>

        <g class="transit-map__stations">
          <!-- 键盘可达：每个车站是一个可聚焦按钮，回车/空格与点击等价；选中态同时用文本与圆环表达。 -->
          <g
            v-for="station in view.stations"
            :key="station.id"
            class="map-station"
            :class="{
              'map-station--selected': station.selected,
              'map-station--highlighted': station.highlighted,
            }"
            :data-station-id="station.id"
            role="button"
            tabindex="0"
            :aria-label="stationAriaLabel(station)"
            :aria-pressed="station.selected ? 'true' : 'false'"
            @click="select(station.id)"
            @keydown.enter.prevent="select(station.id)"
            @keydown.space.prevent="select(station.id)"
          >
            <!-- r=22：390px 视图下 SVG 缩放约 0.59，视觉圆点不变但命中圈 ≥24px；删除 :focus{outline:none}，保留全局焦点轮廓。 -->
            <circle class="map-station__hit" :cx="station.point.x" :cy="station.point.y" r="22" fill="transparent" />
            <circle
              class="map-station__dot"
              :cx="station.point.x"
              :cy="station.point.y"
              :r="station.selected || station.highlighted ? 5.5 : 4"
              :fill="station.selected ? STATION_RING : STATION_FILL"
              :stroke="STATION_RING"
              stroke-width="1.5"
            />
            <circle
              v-if="station.highlighted"
              class="map-station__highlight"
              :cx="station.point.x"
              :cy="station.point.y"
              r="8"
              fill="none"
              :stroke="STATION_RING"
              stroke-width="1.5"
              stroke-dasharray="3 3"
            />
            <circle
              v-if="station.selected"
              class="map-station__ring"
              :cx="station.point.x"
              :cy="station.point.y"
              r="8"
              fill="none"
              :stroke="STATION_RING"
              stroke-width="2.5"
            />
          </g>
        </g>
      </svg>

      <MapLegend
        :station-count="view.stations.length"
        :section-count="view.sections.length"
        :hidden-label-count="view.hiddenLabelIds.length"
      />

      <p class="transit-map__note">无底图示意：仅按车站坐标投影绘制，区间为端点直连，不代表真实线路走向。</p>
      <p class="transit-map__attribution">
        坐标来源：OpenStreetMap（WGS-84） ·
        <a href="https://www.openstreetmap.org/copyright" rel="noreferrer noopener" target="_blank">
          © OpenStreetMap contributors
        </a>
      </p>
    </template>
  </section>
</template>

<style scoped>
.transit-map {
  max-width: 100%;
  min-width: 0;
}

/* 关键：宽度跟随容器、按 viewBox 比例缩放，390px 窄屏下不会横向溢出。 */
.transit-map__canvas {
  display: block;
  width: 100%;
  height: auto;
  max-width: 100%;
  overflow: visible;
}

.transit-map__section {
  pointer-events: none;
}

.transit-map__label {
  font-family: system-ui, -apple-system, 'Noto Sans CJK SC', sans-serif;
  paint-order: stroke;
  stroke: #ffffff;
  stroke-width: 2.5px;
  stroke-linejoin: round;
}

.map-station {
  cursor: pointer;
}

/* 不允许覆盖全局焦点轮廓：站点必须能被键盘用户看见。 */
.map-station:focus-visible {
  outline: 3px solid #b45c21;
  outline-offset: 4px;
}

.map-station:focus-visible .map-station__dot {
  stroke: #0f766e;
  stroke-width: 3;
}

.transit-map__notice {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #f8fafc;
  color: #334155;
  font-size: 13px;
  line-height: 1.5;
}

.transit-map__note,
.transit-map__attribution {
  margin: 6px 0 0;
  color: #475569;
  font-size: 12px;
  line-height: 1.5;
}
</style>
