<script setup lang="ts">
/**
 * 线路图薄渲染组件（票 03/04/07）：只接收视图模型（位置含 from/to/unreachable/normal、
 * 区间含着色态与本次所选、分段、臂、断口）与布局结果，不接收站序派生对象、不读 network。
 * 交互只回传 positionKey，状态机留在 RecordRouteSelector；布局全部来自纯函数 route-layout.ts。
 * 区间四态的优先级与色值在 section-paint.ts 里决定，这里只按视图模型落笔。
 *
 * 无障碍结构：容器是分组（不是图片），图内第一个可聚焦元素是「跳过线路图」；
 * 一站一个 Tab 停靠点且 DOM 顺序就是布局的行进顺序（蛇形）。站按钮的无障碍名用
 * 未截断的完整显示标签 + 当前状态，视觉截断只影响 `.station-label` 的短文本。
 * 站点在序列中途也能按 Escape 一步离开（同「跳过线路图」的落点），
 * 否则只能逐个 Shift+Tab 退回图前的按钮。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { layoutRoute } from './route-layout';
import type { LayoutArm, LayoutGap, LayoutPosition, LayoutSection, LayoutSegment } from './route-layout';
import { SELECTED_RING, sectionPaint } from './section-paint';
import type { SectionPaint, SectionPaintState, SectionVisual } from './section-paint';
import { STATION_FOCUS_RING, STATION_PAINT, STATION_RING } from './station-paint';

export type StationState = 'from' | 'to' | 'unreachable' | 'normal';
export interface DiagramPosition extends LayoutPosition {
  readonly state?: StationState;
}
/** 区间视图模型：几何与端点身份来自布局，着色态、本次所选与停运底色由调用方压好；缺省为「未知」。 */
export interface DiagramSection extends LayoutSection {
  readonly state?: SectionPaintState;
  readonly selected?: boolean;
  /** 停运区间的底色：true 已乘坐 / false 未乘坐 / null 完乘不可用。 */
  readonly ridden?: boolean | null;
}
export interface RouteFeedback {
  readonly positionKey: string;
  readonly text: string;
}

const props = defineProps<{
  readonly positions: readonly DiagramPosition[];
  readonly sections: readonly DiagramSection[];
  readonly segments: readonly LayoutSegment[];
  readonly arms: readonly LayoutArm[];
  readonly gaps: readonly LayoutGap[];
  /** 显式宽度覆盖；jsdom 容器宽为 0 时布局回退到默认宽度。 */
  readonly width?: number;
  /** 窗口宽覆盖（测试用）；缺省取 window.innerWidth，分档只看它，不看容器宽。 */
  readonly viewportWidth?: number;
  readonly disabled?: boolean;
  /** 不可达气泡：由选择器写入，4 秒后本组件自动隐藏；再点会重置计时。 */
  readonly feedback?: RouteFeedback | null;
}>();
const emit = defineEmits<{ select: [positionKey: string]; skip: [] }>();

const root = ref<HTMLElement | null>(null);
const measured = ref(0);
const viewport = ref(0);
let observer: ResizeObserver | null = null;
const readViewport = (): number => (typeof window === 'undefined' ? 0 : window.innerWidth);

onMounted(() => {
  measured.value = root.value?.clientWidth ?? 0;
  viewport.value = readViewport();
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', markKeyboard, true);
    window.addEventListener('pointerdown', markPointer, true);
  }
  if (typeof ResizeObserver === 'undefined' || !root.value) return;
  observer = new ResizeObserver(entries => { measured.value = entries[0]?.contentRect.width ?? 0; });
  observer.observe(root.value);
});
function onResize(): void { viewport.value = readViewport(); }

/**
 * 焦点环的交互态：键盘事件置位、pointerdown 清除，再叠加当前聚焦的站决定是否显示。
 * 真实浏览器里 CSS 的 :focus-visible 仍作为条件之一；这份状态让 jsdom（不匹配
 * :focus-visible）也能断言「默认隐藏 / 键盘聚焦显示 / 鼠标点击后不显示」。
 */
const focusedKey = ref<string | null>(null);
const keyboardIntent = ref(false);
function markKeyboard(): void { keyboardIntent.value = true; }
function markPointer(): void { keyboardIntent.value = false; }
function onStationFocus(positionKey: string): void { focusedKey.value = positionKey; }
function onStationBlur(positionKey: string): void {
  if (focusedKey.value === positionKey) focusedKey.value = null;
}
function showsFocusRing(positionKey: string): boolean {
  return focusedKey.value === positionKey && keyboardIntent.value;
}

const visibleFeedback = ref<RouteFeedback | null>(null);
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;
function clearFeedbackTimer(): void {
  if (feedbackTimer === null) return;
  clearTimeout(feedbackTimer);
  feedbackTimer = null;
}
// 气泡由选择器提供、本组件负责 4 秒自动消失；feedback 变 null、目标站变化或
// 选择器重复写入同一目标（新对象）时，先隐藏旧气泡并取消旧计时器再重新计时。
watch(() => [props.feedback?.positionKey ?? null, props.feedback] as const, ([, value]) => {
  clearFeedbackTimer();
  visibleFeedback.value = value ? { ...value } : null;
  if (!value) return;
  feedbackTimer = setTimeout(() => { visibleFeedback.value = null; feedbackTimer = null; }, 4000);
}, { immediate: true });

onBeforeUnmount(() => {
  clearFeedbackTimer();
  observer?.disconnect();
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', markKeyboard, true);
    window.removeEventListener('pointerdown', markPointer, true);
  }
});

const layout = computed(() => layoutRoute({
  positions: props.positions, sections: props.sections, segments: props.segments, arms: props.arms, gaps: props.gaps,
}, {
  width: props.width && props.width > 0 ? props.width : measured.value,
  viewportWidth: props.viewportWidth && props.viewportWidth > 0 ? props.viewportWidth : viewport.value,
}));

const stateByKey = computed(() => new Map(props.positions.map(row => [row.positionKey, row.state ?? 'normal'])));
const stateOf = (positionKey: string): StationState => stateByKey.value.get(positionKey) ?? 'normal';
/** 图内 Tab 停靠点数量：只数会画点的站，直穿站在这里也不是按钮。 */
const focusableCount = computed(() => props.positions.filter(row => row.drawsPoint).length);
const STATE_NAME: Readonly<Record<StationState, string>> = { from: '出发站', to: '到达站',
  unreachable: '当前到不了', normal: '' };
/**
 * 站按钮无障碍名模板：完整显示标签（含环线起端/末端后缀）+ 出发站/到达站/当前到不了。
 * 用布局里的 `label`（未截断）而不是 `shortLabel`，视觉截断不改变读屏名称。
 */
function accessibleName(station: { readonly label: string; readonly positionKey: string }): string {
  const state = STATE_NAME[stateOf(station.positionKey)];
  return state ? `${station.label}，${state}` : station.label;
}
/** 行方向只用于把「Tab 顺序=蛇形」暴露到 DOM 上，测试据此在真实节点上核对。 */
function rowDirectionOf(rowIndex: number): 'ltr' | 'rtl' {
  return layout.value.rows[rowIndex]?.direction ?? 'ltr';
}
/** 车站样式只从 station-paint.ts 取，图例用同一份常量，不再各存一份。 */
const stationPaintOf = (positionKey: string) => STATION_PAINT[stateOf(positionKey)];
const stationOpacityOf = (positionKey: string): number | undefined => {
  const opacity = stationPaintOf(positionKey).opacity;
  return opacity < 1 ? opacity : undefined;
};

/** 无着色的区间按「未知」画中性线：不把缺数据当成未乘坐。 */
const NO_PAINT: SectionVisual = { state: 'unknown', selected: false };
const visualBySection = computed(() => new Map(props.sections.map(row => [row.sectionId,
  { state: row.state ?? 'unknown', selected: row.selected === true && (row.state ?? 'unknown') !== 'suspended',
    ridden: row.ridden ?? null }])));
function visualOf(sectionId: string | null): SectionVisual {
  if (!sectionId) return NO_PAINT;
  return visualBySection.value.get(sectionId) ?? NO_PAINT;
}
function paintOf(sectionId: string | null): SectionPaint { return sectionPaint(visualOf(sectionId)); }
/** 实线不下发 stroke-dasharray 属性（Vue 不接受 null）。 */
function dashOf(sectionId: string | null): string | undefined { return paintOf(sectionId).dash ?? undefined; }
function widthOf(sectionId: string | null): number {
  return visualOf(sectionId).selected ? SELECTED_RING.baseWidth : paintOf(sectionId).width;
}

/**
 * 图上操作后焦点留在原站：鼠标点选先聚焦当前站（键盘 Enter/空格本来就在站上）；
 * 状态更新只改属性、不换节点，焦点因此不会丢。
 */
function selectStation(station: { readonly positionKey: string; readonly drawsPoint: boolean },
    event?: MouseEvent): void {
  if (props.disabled || !station.drawsPoint) return;
  (event?.currentTarget as SVGElement | null)?.focus?.();
  emit('select', station.positionKey);
}
function arcPath(arc: { x: number; y1: number; y2: number; rx: number; ry: number; direction: 'left' | 'right' }): string {
  const sweep = arc.direction === 'right' ? 1 : 0;
  return `M ${arc.x} ${arc.y1} A ${arc.rx} ${arc.ry} 0 0 ${sweep} ${arc.x} ${arc.y2}`;
}
</script>

<template>
  <div ref="root" class="route-diagram" role="group"
    :aria-label="`线路图：${focusableCount} 个可选车站，按当日有效站序排列；按 Escape 键可离开站点列表`">
    <!-- 图内第一个可聚焦元素：整张图可以一键跳过，落点由选择器决定（区间摘要行或本区块）。 -->
    <button type="button" class="diagram-skip" @click="emit('skip')">跳过线路图</button>
    <p v-if="visibleFeedback" class="route-feedback" role="status">{{ visibleFeedback.text }}</p>
    <svg class="route-diagram__svg" :width="layout.width" :height="layout.height"
      :viewBox="`0 0 ${layout.width} ${layout.height}`">
      <g class="route-lines">
        <g v-for="line in layout.lines" :key="line.sectionId" class="route-section-paint"
          :data-section-id="line.sectionId" :data-section-state="visualOf(line.sectionId).state"
          :data-section-selected="visualOf(line.sectionId).selected ? 'true' : undefined">
          <template v-if="visualOf(line.sectionId).selected">
            <line class="route-ring route-ring-outer" :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2"
              :stroke="SELECTED_RING.outer.stroke" :stroke-width="SELECTED_RING.outer.width" />
            <line class="route-ring route-ring-gap" :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2"
              :stroke="SELECTED_RING.gap.stroke" :stroke-width="SELECTED_RING.gap.width" />
          </template>
          <line class="route-line" :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2"
            :stroke="paintOf(line.sectionId).stroke" :stroke-width="widthOf(line.sectionId)"
            :stroke-dasharray="dashOf(line.sectionId)" />
        </g>
      </g>
      <g class="route-arcs">
        <g v-for="(arc, index) in layout.arcs" :key="arc.sectionId ?? `arc-${index}`" class="route-section-paint"
          :data-section-id="arc.sectionId ?? undefined" :data-section-state="visualOf(arc.sectionId).state"
          :data-section-selected="visualOf(arc.sectionId).selected ? 'true' : undefined">
          <template v-if="visualOf(arc.sectionId).selected">
            <path class="route-ring route-ring-outer" :d="arcPath(arc)"
              :stroke="SELECTED_RING.outer.stroke" :stroke-width="SELECTED_RING.outer.width" />
            <path class="route-ring route-ring-gap" :d="arcPath(arc)"
              :stroke="SELECTED_RING.gap.stroke" :stroke-width="SELECTED_RING.gap.width" />
          </template>
          <path class="route-arc" :d="arcPath(arc)"
            :stroke="paintOf(arc.sectionId).stroke" :stroke-width="widthOf(arc.sectionId)"
            :stroke-dasharray="dashOf(arc.sectionId)" />
        </g>
      </g>
      <g class="route-connectors">
        <g v-for="connector in layout.connectors" :key="connector.sectionId" class="route-section-paint"
          :data-section-id="connector.sectionId" :data-section-state="visualOf(connector.sectionId).state"
          :data-section-selected="visualOf(connector.sectionId).selected ? 'true' : undefined">
          <template v-if="visualOf(connector.sectionId).selected">
            <path class="route-ring route-ring-outer" :d="connector.path"
              :stroke="SELECTED_RING.outer.stroke" :stroke-width="SELECTED_RING.outer.width" />
            <path class="route-ring route-ring-gap" :d="connector.path"
              :stroke="SELECTED_RING.gap.stroke" :stroke-width="SELECTED_RING.gap.width" />
          </template>
          <path class="route-connector" :d="connector.path"
            :stroke="paintOf(connector.sectionId).stroke" :stroke-width="widthOf(connector.sectionId)"
            :stroke-dasharray="dashOf(connector.sectionId)" />
        </g>
      </g>
      <g v-for="arm in layout.arms" :key="`arm-${arm.rowIndex}`" class="route-arm">
        <text class="route-arm-label" :x="arm.x" :y="arm.y" :font-size="layout.metrics.fontSize">{{ arm.label }}</text>
      </g>
      <g v-for="station in layout.stations" :key="station.positionKey" class="route-station"
        :class="[`station-${stateOf(station.positionKey)}`, { 'is-keyboard-focus': showsFocusRing(station.positionKey) }]"
        :data-position-key="station.positionKey" :data-end="station.isEnd ? 'true' : undefined"
        :data-state="stateOf(station.positionKey)" :data-label-above="station.labelAbove ? 'true' : undefined"
        :data-draws-point="station.drawsPoint ? 'true' : 'false'"
        :data-row="station.rowIndex" :data-row-direction="rowDirectionOf(station.rowIndex)"
        :opacity="stationOpacityOf(station.positionKey)"
        :role="station.drawsPoint ? 'button' : undefined" :tabindex="station.drawsPoint ? 0 : undefined"
        :aria-label="station.drawsPoint ? accessibleName(station) : undefined"
        :aria-disabled="disabled ? 'true' : undefined"
        @focus="onStationFocus(station.positionKey)" @blur="onStationBlur(station.positionKey)"
        @click="selectStation(station, $event)" @keydown.enter.prevent="selectStation(station)"
        @keydown.space.prevent="selectStation(station)"
        @keydown.esc.prevent="emit('skip')">
        <rect class="station-label-plate" :x="station.labelBox.x" :y="station.labelBox.y"
          :width="station.labelBox.width" :height="station.labelBox.height" rx="3" />
        <rect v-if="station.drawsPoint" class="station-hit" :x="station.x - 22" :y="station.y - 22"
          width="44" height="44" />
        <!-- 焦点环只在 :focus-visible 时显示：白描边垫底、橙描边压上，形成两侧各 2px 白衬边。 -->
        <template v-if="station.drawsPoint">
          <rect class="station-focus-halo" :x="station.x - STATION_FOCUS_RING.size / 2"
            :y="station.y - STATION_FOCUS_RING.size / 2" :width="STATION_FOCUS_RING.size"
            :height="STATION_FOCUS_RING.size" :rx="STATION_FOCUS_RING.radius" fill="none"
            :stroke="STATION_FOCUS_RING.halo" :stroke-width="STATION_FOCUS_RING.haloWidth" />
          <rect class="station-focus-ring" :x="station.x - STATION_FOCUS_RING.size / 2"
            :y="station.y - STATION_FOCUS_RING.size / 2" :width="STATION_FOCUS_RING.size"
            :height="STATION_FOCUS_RING.size" :rx="STATION_FOCUS_RING.radius" fill="none"
            :stroke="STATION_FOCUS_RING.stroke" :stroke-width="STATION_FOCUS_RING.width" />
        </template>
        <line v-if="station.isEnd" class="route-end-bar" stroke-width="3" :x1="station.x" :y1="station.y - 9"
          :x2="station.x" :y2="station.y + 9" />
        <circle v-if="station.drawsPoint && stateOf(station.positionKey) === 'to'" class="station-ring"
          :cx="station.x" :cy="station.y" :r="STATION_RING.radius" :stroke="STATION_RING.stroke"
          :stroke-width="STATION_RING.strokeWidth" fill="none" />
        <circle v-if="station.drawsPoint" class="station-point" :cx="station.x" :cy="station.y" r="6"
          :fill="stationPaintOf(station.positionKey).fill" :stroke="stationPaintOf(station.positionKey).stroke"
          :stroke-width="stationPaintOf(station.positionKey).strokeWidth" />
        <text class="station-label" :x="station.x" :y="station.labelY" text-anchor="middle"
          :font-size="layout.metrics.fontSize" :font-weight="station.isEnd ? 600 : 400">{{ station.shortLabel }}</text>
      </g>
      <g v-for="(gap, index) in layout.gaps" :key="`gap-${index}`" class="route-gap">
        <text class="route-gap-label" :x="gap.x" :y="gap.y" :font-size="layout.metrics.fontSize">无区间</text>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.route-diagram { position: relative; min-width: 0; max-width: 100%; background: var(--diagram-bg, var(--brand-tint, #eef6f0)); }
/* 跳过链接默认视觉隐藏，键盘聚焦时才出现在图上方（其余 Tab 顺序从第一个站继续）。 */
.diagram-skip { position: absolute; width: 1px; height: 1px; min-height: 0; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.diagram-skip:focus, .diagram-skip:focus-visible { position: static; width: auto; height: auto; min-height: 44px;
  margin: 0 0 .4rem; padding: .4rem .8rem; overflow: visible; clip: auto; white-space: normal;
  border: 1px solid var(--line-strong, #b7c7ba); border-radius: var(--radius-1, 6px);
  background: var(--surface, #fff); color: var(--brand); }
.route-diagram__svg { display: block; max-width: 100%; height: auto; }
/* 颜色与线型由视图模型逐区间下发（stroke / stroke-dasharray 属性），CSS 只管不填充。 */
.route-line, .route-arc, .route-connector, .route-ring { fill: none; }
/* 车站的 fill / stroke / 描边宽 / 透明度由 station-paint.ts 逐站下发，CSS 只剩结构样式。 */
.station-label { fill: var(--ink-2, #333); }
.station-label-plate { fill: var(--diagram-bg, var(--brand-tint, #eef6f0)); fill-opacity: 0.85; }
.route-end-bar { stroke: var(--ink, #222); stroke-width: 3; }
.route-arm-label, .route-gap-label { fill: var(--ink-2, #555); }
.route-feedback { margin: 0 0 .4rem; padding: .45rem .7rem; border-radius: var(--radius-1, 6px); background: var(--warn-soft, #fdf3d8); color: var(--warn-ink, #6b4b00); font-size: .85rem; }
.station-hit { fill: transparent; cursor: pointer; }
/* SVG 分组上的原生 outline 各家不一致，焦点环改由两个 SVG rect 画；键盘聚焦才显示。
   两个条件等价：真实浏览器靠 :focus-visible，jsdom/自定义态靠 is-keyboard-focus（见脚本）。 */
.route-station:focus { outline: none; }
.station-focus-halo, .station-focus-ring { display: none; pointer-events: none; }
.route-station:focus-visible .station-focus-halo,
.route-station:focus-visible .station-focus-ring,
.route-station.is-keyboard-focus .station-focus-halo,
.route-station.is-keyboard-focus .station-focus-ring { display: inline; }
</style>
