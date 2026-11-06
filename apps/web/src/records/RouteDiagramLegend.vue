<script setup lang="ts">
/**
 * 线路图图例（票 06/08）：独立的 UI 组件，只解释图的视觉编码，不进行程状态。
 *
 * 固定 8 项，环线没有「不可选车站」为 7 项，分区间 / 车站两组；「标注」两项已按
 * 维护者 2026-11-01 实测反馈移除（图上本身就是文字）。前 3 次进入自动展开并提示，
 * 之后收起为「图例」按钮；次数由 legend-state.ts 记在本地，存储不可用时按首次进入处理且不抛错。
 * 不显示站数/区间数摘要，也不给废线样式。
 * 区间色值与三层外圈直接取自 section-paint.ts，车站编码与 RouteDiagram 一致（票 04）。
 * 临时停运的底色随乘坐状态变化，用蓝/灰两段虚线样张同时表达两种可能。
 */
import { computed, ref } from 'vue';
import { SECTION_PAINT, SELECTED_RING } from './section-paint';
import type { SectionPaintState } from './section-paint';
import { STATION_PAINT, STATION_RING } from './station-paint';
import { legendOpenOnEnter } from './legend-state';

const props = defineProps<{ loop?: boolean }>();

type LineItem = { readonly id: string; readonly label: string; readonly kind: 'line';
  readonly state: SectionPaintState; readonly ring?: boolean };
type StationItem = { readonly id: string; readonly label: string; readonly kind: 'station';
  readonly station: 'from' | 'to' | 'unreachable' | 'normal' };
type LegendItem = LineItem | StationItem;
interface LegendGroup { readonly id: string; readonly label: string; readonly items: readonly LegendItem[] }

const groups = computed<readonly LegendGroup[]>(() => [
  { id: 'sections', label: '区间', items: [
    { id: 'completed', label: '已乘坐', kind: 'line', state: 'completed' },
    { id: 'unridden', label: '未乘坐', kind: 'line', state: 'unridden' },
    { id: 'suspended', label: '临时停运', kind: 'line', state: 'suspended' },
    { id: 'selected', label: '本次所选', kind: 'line', state: 'unridden', ring: true },
  ] },
  { id: 'stations', label: '车站', items: [
    { id: 'normal', label: '车站', kind: 'station', station: 'normal' },
    { id: 'origin', label: '出发站', kind: 'station', station: 'from' },
    { id: 'destination', label: '到达站', kind: 'station', station: 'to' },
    ...(props.loop ? [] : [{ id: 'unreachable', label: '不可选车站', kind: 'station', station: 'unreachable' } as const]),
  ] },
]);

// 进入即在 setup 里定初值（纯前端 SPA，无 SSR）：首帧就是展开/收起后的样子，不闪一下。
const entry = legendOpenOnEnter();
const expanded = ref(entry.autoOpen);
const hint = ref(entry.autoOpen);
function toggle(): void { expanded.value = !expanded.value; }
const strokeOf = (item: LegendItem): string => (item.kind === 'line' ? SECTION_PAINT[item.state].stroke : '');
const dashOf = (item: LegendItem): string | undefined =>
  (item.kind === 'line' ? SECTION_PAINT[item.state].dash ?? undefined : undefined);
/** 样张线宽与图上同源：已乘坐粗线、其余细线；本次所选的内层取外圈 baseWidth。 */
const widthOf = (item: LegendItem): number => (item.kind === 'line' ? SECTION_PAINT[item.state].width : 0);
/** 车站样张与图上同源：填充、描边、线宽、透明度、是否加环都读 station-paint.ts。 */
const stationSample = (item: LegendItem) => (item.kind === 'station' ? STATION_PAINT[item.station] : STATION_PAINT.normal);
const stationOpacity = (item: LegendItem): number | undefined => {
  const opacity = stationSample(item).opacity;
  return opacity < 1 ? opacity : undefined;
};
/** 区间样张画布：20 高、线心 y=10，13 宽外圈上下各余 3.5，三层描边不被裁切。 */
const LINE_SAMPLE_WIDTH = 26;
const LINE_SAMPLE_HEIGHT = 20;
const LINE_SAMPLE_Y = LINE_SAMPLE_HEIGHT / 2;
/** 停运样张左右各画一段虚线：左半「已乘坐」灰、右半「未乘坐」蓝，合起来说明底色随乘坐状态。 */
const LINE_SAMPLE_SPLIT = LINE_SAMPLE_WIDTH / 2;
</script>

<template>
  <div class="legend">
    <button v-if="!expanded" type="button" class="legend__toggle" aria-expanded="false" @click="toggle">图例</button>
    <div v-else class="legend__panel">
      <button type="button" class="legend__toggle" aria-expanded="true" @click="toggle">收起图例</button>
      <p v-if="hint" class="legend__hint" role="status">以后点「图例」可再看。</p>
      <div class="legend__groups">
        <section v-for="group in groups" :key="group.id" class="legend__group" :data-legend-group="group.id">
          <h4>{{ group.label }}</h4>
          <ul>
            <li v-for="item in group.items" :key="item.id" :data-legend-item="item.id">
              <svg v-if="item.kind === 'line'" class="legend__line" :width="LINE_SAMPLE_WIDTH"
                :height="LINE_SAMPLE_HEIGHT" aria-hidden="true">
                <template v-if="item.ring">
                  <line class="legend__ring legend__ring-outer" x1="2" :y1="LINE_SAMPLE_Y" x2="24"
                    :y2="LINE_SAMPLE_Y" :stroke="SELECTED_RING.outer.stroke" :stroke-width="SELECTED_RING.outer.width" />
                  <line class="legend__ring legend__ring-gap" x1="2" :y1="LINE_SAMPLE_Y" x2="24"
                    :y2="LINE_SAMPLE_Y" :stroke="SELECTED_RING.gap.stroke" :stroke-width="SELECTED_RING.gap.width" />
                </template>
                <template v-if="item.state === 'suspended'">
                  <line class="legend__line-ridden" x1="2" :y1="LINE_SAMPLE_Y" :x2="LINE_SAMPLE_SPLIT"
                    :y2="LINE_SAMPLE_Y" :stroke="SECTION_PAINT.completed.stroke" :stroke-width="SECTION_PAINT.suspended.width"
                    :stroke-dasharray="SECTION_PAINT.suspended.dash ?? undefined" />
                  <line class="legend__line-unridden" :x1="LINE_SAMPLE_SPLIT" :y1="LINE_SAMPLE_Y" x2="24"
                    :y2="LINE_SAMPLE_Y" :stroke="SECTION_PAINT.unridden.stroke" :stroke-width="SECTION_PAINT.suspended.width"
                    :stroke-dasharray="SECTION_PAINT.suspended.dash ?? undefined" />
                </template>
                <line v-else x1="2" :y1="LINE_SAMPLE_Y" x2="24" :y2="LINE_SAMPLE_Y" :stroke="strokeOf(item)"
                  :stroke-width="item.ring ? SELECTED_RING.baseWidth : widthOf(item)" :stroke-dasharray="dashOf(item)" />
              </svg>
              <svg v-else class="legend__station" width="24" height="24"
                :opacity="stationOpacity(item)" aria-hidden="true">
                <circle cx="12" cy="12" r="6" :fill="stationSample(item).fill"
                  :stroke="stationSample(item).stroke" :stroke-width="stationSample(item).strokeWidth" />
                <circle v-if="stationSample(item).ring" class="legend__station-ring" cx="12" cy="12"
                  :r="STATION_RING.radius" :stroke="STATION_RING.stroke" :stroke-width="STATION_RING.strokeWidth"
                  fill="none" />
              </svg>
              <span class="legend__label">{{ item.label }}</span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.legend { display: grid; gap: .35rem; min-width: 0; }
.legend__toggle { justify-self: start; min-height: 44px; padding: .3rem .8rem; border: 1px solid var(--line-strong); border-radius: var(--radius-1); background: var(--surface); color: var(--brand); font-size: .85rem; cursor: pointer; }
.legend__panel { display: grid; gap: .35rem; padding: .5rem .7rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-1); min-width: 0; }
.legend__hint { margin: 0; color: var(--ink-2); font-size: .82rem; }
.legend__groups { display: flex; flex-wrap: wrap; gap: .4rem 1.1rem; min-width: 0; }
.legend__group { display: grid; gap: .2rem; min-width: 0; }
.legend__group h4 { margin: 0; color: var(--ink-3); font-size: .75rem; font-weight: 600; letter-spacing: .08em; }
.legend__group ul { display: flex; flex-wrap: wrap; gap: .15rem .8rem; margin: 0; padding: 0; list-style: none; min-width: 0; }
.legend__group li { display: inline-flex; align-items: center; gap: .3rem; font-size: .82rem; color: var(--ink-2); }
.legend__line, .legend__station { flex: none; }
.legend__station-ring { fill: none; }
</style>
