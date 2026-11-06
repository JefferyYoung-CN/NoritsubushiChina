<script setup lang="ts">
/**
 * 线路图面板（票 04/05）：负责把站序派生压成视图模型并渲染图的容器。
 *
 * 边界：派生→视图模型的映射只在这里做一次；`RouteDiagram` 仍只认视图模型、不读 network。
 * 这里也承担两件与「图在页面上的位置」有关的事：选中后按需把目标站滚进视口，
 * 以及给选择器提供「把焦点放到某个站」的能力（面板自动收起后的焦点归位用）。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { sectionStatus } from '../../../../packages/application/date-view.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import RouteDiagram from '../records/RouteDiagram.vue';
import { physicalSections, physicalRouteSequence } from '../records/physical-route';
import { paintSections } from '../records/section-paint';
import { UNAVAILABLE_COMPLETION } from './route-completion';
import type { RouteCompletion } from './route-completion';

const props = withDefaults(defineProps<{
  network: TransitNetwork;
  onDate: string;
  selectedLineId: string;
  disabled?: boolean;
  fromStationId?: string;
  toStationId?: string;
  unreachablePositionKeys?: readonly string[];
  feedback?: { readonly positionKey: string; readonly text: string } | null;
  /** 完乘三态；缺省按不可用处理，图只画中性线。 */
  completion?: RouteCompletion;
  /** 本次所选的有效行程区间；选择器用 buildPhysicalTrip 算出，不进完乘派生。 */
  selectedSectionIds?: readonly string[];
  /** 上层此刻能否真的重算；工作区没打开时重算入口会点了没反应，直接不渲染。 */
  canRecalculate?: boolean;
}>(), { canRecalculate: true });
const emit = defineEmits<{ select: [positionKey: string]; skip: []; recalculate: [] }>();

const root = ref<HTMLElement | null>(null);
const sections = computed(() => physicalSections(props.network, props.selectedLineId, props.onDate));
const unreachable = computed(() => new Set(props.unreachablePositionKeys ?? []));
/** 图上四种站状态；不可达只来自选择器传入的办客站集合。 */
function stationState(positionKey: string): 'from' | 'to' | 'unreachable' | 'normal' {
  if (positionKey === props.fromStationId) return 'from';
  if (positionKey === props.toStationId) return 'to';
  return unreachable.value.has(positionKey) ? 'unreachable' : 'normal';
}
const completion = computed<RouteCompletion>(() => props.completion ?? UNAVAILABLE_COMPLETION);
/** 临时停运只取当日权威判定 sectionStatus；废线已被 physicalSections 排除，不画也不上色。 */
const suspendedSectionIds = computed(() => sections.value
  .filter(row => sectionStatus(row, props.network, props.onDate).status === 'temporary')
  .map(row => row.id));
const diagram = computed(() => {
  if (!props.selectedLineId || sections.value.length === 0) return null;
  const sequence = physicalRouteSequence(props.network, props.onDate, props.selectedLineId);
  const paint = paintSections(sequence.sections.map(row => row.sectionId), {
    completionReady: completion.value.kind === 'ready',
    completedSectionIds: completion.value.completedSectionIds,
    suspendedSectionIds: suspendedSectionIds.value,
    selectedSectionIds: props.selectedSectionIds ?? [],
  });
  const UNKNOWN = { state: 'unknown' as const, selected: false };
  return {
    positions: sequence.positions.map(row => ({ positionKey: row.positionKey, label: row.label,
      drawsPoint: row.drawsPoint, segmentIndex: row.segmentIndex, arm: row.arm,
      state: stationState(row.positionKey) })),
    sections: sequence.sections.map(row => ({ sectionId: row.sectionId,
      fromPositionKey: row.fromPositionKey, toPositionKey: row.toPositionKey,
      ...(paint.get(row.sectionId) ?? UNKNOWN) })),
    segments: sequence.segments.map(row => ({ index: row.index, positionKeys: row.positionKeys })),
    arms: sequence.arms.map(row => ({ label: row.label, positionKeys: row.positionKeys, branchPositionKey: row.branchPositionKey })),
    gaps: sequence.gaps.map(row => ({ kind: row.kind, fromPositionKey: row.fromPositionKey, toPositionKey: row.toPositionKey })),
  };
});
/** 完乘不可用/重算中的一行说明；ready 时不渲染。 */
const completionNote = computed(() => (completion.value.kind === 'ready' ? '' : completion.value.message));

function stationElement(positionKey: string): SVGElement | null {
  return root.value?.querySelector(`[data-position-key="${positionKey}"]`) as SVGElement | null;
}
/**
 * 选中后按需滚动：目标站已在视口内就不动（nearest 语义），否则滚到最近边缘。
 * jsdom 没有 scrollIntoView 时静默跳过，不影响渲染与其余交互。
 */
function revealStation(positionKey: string): void {
  const element = stationElement(positionKey);
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
  if (rect.top >= 0 && rect.bottom <= viewportHeight) return;
  (element as unknown as { scrollIntoView?: (options: { block: string }) => void })
    .scrollIntoView?.({ block: 'nearest' });
}
/** 把焦点放到图上某个站；站不存在或不可交互（直穿站/禁用）时返回 false，由调用方兜底。 */
function focusStation(positionKey: string): boolean {
  const element = stationElement(positionKey);
  if (!element || element.getAttribute('role') !== 'button' || element.getAttribute('aria-disabled') === 'true') return false;
  (element as unknown as { focus?: () => void }).focus?.();
  return true;
}
defineExpose({ focusStation, revealStation });

// 起终点任一变化后等图重排完成再判断可见性；同一次变化只对「刚变的那一端」滚动。
watch(() => [props.fromStationId, props.toStationId] as const, async ([from, to], [previousFrom, previousTo]) => {
  const changed = to !== previousTo && to ? to : from !== previousFrom && from ? from : '';
  if (!changed) return;
  await nextTick();
  revealStation(changed);
});
</script>

<template>
  <div ref="root" class="diagram-panel">
    <p v-if="completionNote" class="completion-note" role="status">{{ completionNote }}</p>
    <!-- 没有可用的完乘结果时给一条就地恢复入口；重算进行中只显示说明，不重复触发。 -->
    <button v-if="completion.kind === 'unavailable' && canRecalculate" type="button" class="completion-retry"
      :disabled="disabled" @click="emit('recalculate')">重新计算完乘</button>
    <RouteDiagram v-if="diagram" :positions="diagram.positions" :sections="diagram.sections"
      :segments="diagram.segments" :arms="diagram.arms" :gaps="diagram.gaps"
      :disabled="disabled" :feedback="feedback" @select="emit('select', $event)" @skip="emit('skip')" />
    <p v-else role="status">该线路当日没有可用区间，请核对日期或选择其他线路。</p>
  </div>
</template>

<style scoped>
.diagram-panel { display: grid; gap: .5rem; min-width: 0; }
.completion-note { margin: 0; padding: .45rem .6rem; background: var(--warn-soft, #fdf3d8); color: var(--warn-ink, #6b4b00); border-left: 3px solid #d1a24a; border-radius: 0 var(--radius-1, 6px) var(--radius-1, 6px) 0; font-size: .88rem; }
.completion-retry { justify-self: start; min-height: 44px; padding: .3rem .85rem; border: 1px solid var(--line-strong); border-radius: var(--radius-1, 6px); background: var(--surface, #fff); color: var(--brand); font-size: .88rem; cursor: pointer; }
</style>
