<script setup lang="ts">
/**
 * 基础记录的选择器（票 03/04/05/07）：持有唯一行程状态，按规格顺序摆放
 * 「标题 → 起终点回显行 → 手动选站 → 线路图 → 区间摘要 → 查看本次所选路径」。
 *
 * 线路图与视图模型映射在 `integration/RouteDiagramPanel.vue`；这里只负责状态机、
 * 手动候选、回显行与焦点时序（含票 07 的跳过落点与三条焦点规则）。状态仍只有一份：`modelValue`。
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import SearchSelect from '../components/SearchSelect.vue';
import NetworkBrowser from '../integration/NetworkBrowser.vue';
import RouteDiagramPanel from '../integration/RouteDiagramPanel.vue';
import RouteDiagramLegend from './RouteDiagramLegend.vue';
import { physicalLineOptions, physicalLoop, physicalStops, physicalDestinations, buildPhysicalTrip } from './physical-route';
import type { PhysicalSelection } from './physical-route';
import { UNAVAILABLE_COMPLETION } from '../integration/route-completion';
import type { RouteCompletion } from '../integration/route-completion';

const props = withDefaults(defineProps<{
  modelValue: PhysicalSelection;
  network: TransitNetwork;
  onDate: string;
  disabled?: boolean;
  available: boolean;
  message?: string;
  /** 完乘三态；缺省按不可用处理，图只画中性线。 */
  completion?: RouteCompletion;
  /** 上层此刻能否真的重算；false 时图上的重算入口不渲染。 */
  canRecalculate?: boolean;
}>(), { canRecalculate: true });
const emit = defineEmits<{ 'update:modelValue': [selection: PhysicalSelection]; recalculate: [] }>();
const notice = ref('');
const stations = computed(() => physicalStops(props.network, props.onDate, props.modelValue.physicalLineId));
const loop = computed(() => physicalLoop(props.network, props.modelValue.physicalLineId, props.onDate));
const foldName = computed(() => props.network.names.find(row => row.stationId === loop.value?.stationIds[0]
  && row.from <= props.onDate && (row.until === null || props.onDate < row.until))?.name ?? '折叠站');
const selectedView = computed(() => {
  if (!loop.value || !props.modelValue.toStationId) return null;
  const result = buildPhysicalTrip(props.network, { ...props.modelValue, onDate: props.onDate });
  return result.ok ? result.view : null;
});
const preview = computed(() => {
  const view = selectedView.value;
  return view ? `所选路径共 ${view.normalSections.length} 个区间${view.fromStationId === view.toStationId ? '（完整一圈）' : ''}，可展开核对途经站后保存。` : '';
});
/**
 * 本次所选的有效行程区间：与保存用的是同一个 `buildPhysicalTrip`（业务解析只有它一份），
 * 不进完乘派生。不复用上面的 `selectedView`——那个 computed 只服务环线预览的现有行为。
 * 整圈时它自然覆盖整条展开线的全部区间。
 */
const selectedSectionIds = computed(() => {
  if (!props.modelValue.fromStationId || !props.modelValue.toStationId) return [];
  const result = buildPhysicalTrip(props.network, { ...props.modelValue, onDate: props.onDate });
  return result.ok ? result.view.normalSections.map(row => row.id) : [];
});
const completion = computed<RouteCompletion>(() => props.completion ?? UNAVAILABLE_COMPLETION);
const pathNames = computed(() => {
  const view = selectedView.value;
  if (!view) return [];
  let cursor = view.fromStationId;
  const ids = [cursor];
  for (const section of view.normalSections) {
    cursor = section.fromStationId === cursor ? section.toStationId : section.fromStationId;
    ids.push(cursor);
  }
  return ids.map(id => view.stations.find(row => row.id === id)?.name ?? id);
});
const destinations = computed(() => physicalDestinations(props.network, props.onDate, props.modelValue.physicalLineId, props.modelValue.fromStationId));
const locked = computed(() => props.disabled || !props.available);
const UNREACHABLE_MESSAGE = '该站与出发站不属于同一趟车（可能需要中途换乘），请分两次录入。';
const diagramFeedback = ref<{ positionKey: string; text: string } | null>(null);
// 环线不标「到不了」；非环线只把「不在 physicalDestinations 里」的办客站标灰。
const unreachableKeys = computed(() => {
  if (!props.modelValue.fromStationId || loop.value) return [];
  const reachable = new Set(destinations.value.map(row => row.id));
  return stations.value.map(row => row.id)
    .filter(id => id !== props.modelValue.fromStationId && !reachable.has(id));
});

/**
 * 手动下拉的主文本直接用站序派生的 display_label（ADR-0005，日期有效、最小充分消歧）：
 * 与图上、无障碍名同源，因此三处同名。副说明固定为「城市 · 站码」，只用于补充检索，
 * 保证按站名、城市、站码都仍能搜到。
 */
const manualOrigins = computed(() => stations.value.map(row => ({ id: row.id, label: row.label, description: row.description })));
const manualDestinations = computed(() => destinations.value.map(row => ({ id: row.id, label: row.label, description: row.description })));
function endpointLabel(positionKey: string): string {
  return stations.value.find(entry => entry.id === positionKey)?.label ?? '未选';
}
const echoLine = computed(() => `出发站 ${endpointLabel(props.modelValue.fromStationId)} → 到达站 ${endpointLabel(props.modelValue.toStationId)}`);

const manualOpen = ref(false);
const panel = ref<{ focusStation: (positionKey: string) => boolean; revealStation: (positionKey: string) => void } | null>(null);
const destinationClear = ref<HTMLButtonElement | null>(null);
const manualToggle = ref<HTMLButtonElement | null>(null);
const tripSection = ref<HTMLElement | null>(null);
const echoText = ref<HTMLElement | null>(null);
const summaryRow = ref<HTMLElement | null>(null);

/** 用户自助展开/收起：焦点始终回到「手动选站」按钮；自动收起不走这里，也不抢焦点。 */
async function toggleManual(): Promise<void> {
  manualOpen.value = !manualOpen.value;
  await nextTick();
  manualToggle.value?.focus();
}
/**
 * 回显行两端的清除：状态清理仍走 origin/destination 的同一入口，清完把焦点放回回显文字，
 * 由回显文字（tabindex=-1）读给读屏，提示行同步播报清掉了哪一端。
 */
async function clearEcho(endpoint: 'from' | 'to'): Promise<void> {
  if (endpoint === 'from') origin(''); else destination('');
  await nextTick();
  echoText.value?.focus();
  notice.value = endpoint === 'from' ? '已清除出发站与到达站。' : '已清除到达站。';
}
/** 跳过整张线路图：有区间摘要行就落到摘要行，否则落到「选择乘车区间」区块并播报。 */
async function skipDiagram(): Promise<void> {
  await nextTick();
  if (summaryRow.value) { summaryRow.value.focus(); return; }
  tripSection.value?.focus();
  notice.value = '已跳过线路图，当前在「选择乘车区间」。';
}

function line(lineId: string): void {
  if (locked.value || (lineId && !physicalLineOptions(props.network, props.onDate).some(row => row.id === lineId))) return;
  diagramFeedback.value = null;
  emit('update:modelValue', { physicalLineId: lineId, fromStationId: '', toStationId: '' });
  notice.value = lineId ? '已选择物理线路，请选择沿线出发站。' : '';
}
function origin(stationId: string): void {
  if (locked.value || (stationId && !stations.value.some(row => row.id === stationId))) return;
  diagramFeedback.value = null;
  emit('update:modelValue', { ...props.modelValue, fromStationId: stationId, toStationId: '' });
  notice.value = stationId ? '已选择出发站，请选择到达站。' : '请重新选择出发站。';
}
function destination(stationId: string): void {
  if (locked.value) return;
  if (stationId && !destinations.value.some(row => row.id === stationId)) {
    notice.value = UNREACHABLE_MESSAGE;
    return;
  }
  diagramFeedback.value = null;
  emit('update:modelValue', { ...props.modelValue, toStationId: stationId });
  notice.value = stationId ? '已选择到达站，可填写备注并保存。' : '请重新选择到达站。';
}
/**
 * 图上点选与下拉共用同一份 modelValue：先设出发，再设到达；点已选出发清两端，
 * 点已选到达只清到达；目标不可达时状态不变，只给 4 秒气泡并由 notice 播报。
 */
function selectStation(positionKey: string): void {
  if (locked.value) return;
  const from = props.modelValue.fromStationId;
  if (!from) { origin(positionKey); return; }
  if (positionKey === from) {
    diagramFeedback.value = null;
    emit('update:modelValue', { ...props.modelValue, fromStationId: '', toStationId: '' });
    notice.value = '';
    return;
  }
  if (positionKey === props.modelValue.toStationId) { destination(''); return; }
  if (destinations.value.some(row => row.id === positionKey)) { destination(positionKey); return; }
  diagramFeedback.value = { positionKey, text: UNREACHABLE_MESSAGE };
  notice.value = UNREACHABLE_MESSAGE;
}
/**
 * 到达站变化时的自动收起与焦点归位，只在「界面未锁定 + 目标确实是本线当日可达站 +
 * 面板正展开」时发生一次：焦点先回图上该站，图上定位不到（缺位置/不可交互）则落到
 * 回显行的到达站清除按钮。外部回填不可达站、或禁用状态下的回填只更新状态，不动面板与焦点。
 * 清空到达站不触发任何收起或焦点移动。
 */
watch(() => props.modelValue.toStationId, async (to, previous) => {
  if (!to || to === previous || locked.value) return;
  if (!destinations.value.some(row => row.id === to)) return;
  const wasOpen = manualOpen.value;
  manualOpen.value = false;
  if (!wasOpen) return;
  await nextTick();
  const focused = panel.value?.focusStation(to) ?? false;
  if (!focused) destinationClear.value?.focus();
});
watch(() => [props.network, props.onDate, props.available], () => {
  notice.value = '';
  diagramFeedback.value = null;
  manualOpen.value = false;
  emit('update:modelValue', { physicalLineId: '', fromStationId: '', toStationId: '' });
});
/**
 * 外部清空/替换起终点、清空线路或禁用时，旧的不可达提示立即失效（含 notice 文案）。
 * 只清「不可达」这一种文案，不覆盖正常选择提示，也不改合法 modelValue。
 */
watch(() => [props.modelValue.physicalLineId, props.modelValue.fromStationId,
  props.modelValue.toStationId, locked.value] as const, () => {
  diagramFeedback.value = null;
  if (notice.value === UNREACHABLE_MESSAGE) notice.value = '';
});
</script>

<template>
  <NetworkBrowser v-if="available" :network="network" :on-date="onDate" :selected-line-id="modelValue.physicalLineId"
    :disabled="locked" @line="line" />
  <section v-if="modelValue.physicalLineId" ref="tripSection" class="trip" aria-labelledby="trip-title" tabindex="-1">
    <div class="section-head">
      <h2 id="trip-title"><span class="step-num" aria-hidden="true">2</span>选择乘车区间</h2>
      <p class="section-lead">沿线车站按当日有效顺序排列；先选出发站，再选到达站。</p>
    </div>

    <div class="endpoint-echo" aria-label="已选起终点">
      <p ref="echoText" class="endpoint-echo__text" tabindex="-1">{{ echoLine }}</p>
      <div class="endpoint-echo__actions">
        <button v-if="modelValue.fromStationId" type="button" class="endpoint-clear" :disabled="locked"
          @click="clearEcho('from')">清除出发站</button>
        <button v-if="modelValue.toStationId" ref="destinationClear" type="button" class="endpoint-clear"
          :disabled="locked" @click="clearEcho('to')">清除到达站</button>
      </div>
    </div>

    <p v-if="!stations.length" role="status">该线路当日没有可办客的车站，请核对日期或选择其他线路。</p>
    <div class="manual">
      <button ref="manualToggle" type="button" class="manual__toggle" :aria-expanded="manualOpen"
        aria-controls="manual-stations" :disabled="locked" @click="toggleManual">手动选站</button>
      <div v-if="manualOpen" id="manual-stations" class="manual__body">
        <SearchSelect id="record-origin" label="出发站" :model-value="modelValue.fromStationId" :options="manualOrigins"
          :disabled="locked" describedby="origin-help" placeholder="输入站名、城市或站码选择出发站"
          @search="origin('')" @update:model-value="origin" />
        <p id="origin-help" class="note">只列出所选物理线路当日的办客车站；可按站名、城市或站码搜索。</p>
        <SearchSelect id="record-destination" label="到达站"
          :model-value="modelValue.toStationId" :options="manualDestinations" :disabled="locked || !modelValue.fromStationId"
          describedby="destination-help" placeholder="输入站名、城市或站码选择到达站"
          @search="destination('')" @update:model-value="destination" />
        <p id="destination-help" class="note" role="status">{{ !modelValue.fromStationId ? '请先选择出发站。'
          : !destinations.length ? '没有可保存的到达站；可能没有与出发站同属同一趟车的办客站，或停运、多条可能径路，请核对日期或选择其他线路。'
          : loop ? '仅列出与出发站同属同一趟车的办客站；按展开后的站序选取区间，不跨越列表两端，并确认所选路径与实际乘坐一致。'
          : '只列出同一趟车会依次经过的办客站（含方向）；中途换乘请分两次录入。' }}</p>
      </div>
    </div>

    <RouteDiagramLegend :loop="!!loop" />
    <RouteDiagramPanel ref="panel" :network="network" :on-date="onDate" :selected-line-id="modelValue.physicalLineId"
      :from-station-id="modelValue.fromStationId" :to-station-id="modelValue.toStationId"
      :unreachable-position-keys="unreachableKeys" :feedback="diagramFeedback"
      :completion="completion" :selected-section-ids="selectedSectionIds" :can-recalculate="canRecalculate"
      :disabled="locked" @select="selectStation" @skip="skipDiagram" @recalculate="emit('recalculate')" />

    <p v-if="loop" class="note callout" role="note">环线在{{ foldName }}展开：{{ foldName }}（起端）→沿线各站→{{ foldName }}（末端）。
      跨过{{ foldName }}的乘坐请分两段录入；两端{{ foldName }}之间表示完整一圈。起端、末端是列表位置，不是行车方向。</p>
    <p v-if="preview" ref="summaryRow" class="interval-summary" role="status" tabindex="-1">{{ preview }}</p>
    <details v-if="selectedView">
      <summary>查看本次所选路径</summary>
      <p class="note">{{ pathNames.join(' → ') }}</p>
    </details>
    <p v-if="message" class="note" role="status">{{ message }}</p>
  </section>
  <p v-if="notice" class="note notice-line" role="status" aria-live="polite">{{ notice }}</p>
</template>

<style scoped>
.trip { display: grid; grid-template-columns: minmax(0, 1fr); gap: .5rem; min-width: 0; }
.endpoint-echo { display: grid; gap: .35rem; padding: .6rem .8rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-1); }
.endpoint-echo__text { margin: 0; color: var(--ink); font-weight: 500; overflow-wrap: anywhere; }
.endpoint-echo__actions { display: flex; flex-wrap: wrap; gap: .4rem; }
.endpoint-clear { min-height: 44px; padding: .3rem .8rem; border: 1px solid var(--line-strong); border-radius: var(--radius-1); background: var(--surface); color: var(--brand); font-size: .88rem; cursor: pointer; }
.manual { display: grid; gap: .25rem; min-width: 0; }
.manual__toggle { justify-self: start; min-height: 44px; padding: .3rem .9rem; border: 1px solid var(--line-strong); border-radius: var(--radius-1); background: var(--surface); color: var(--brand); font-weight: 500; font-size: .9rem; cursor: pointer; }
.manual__toggle[aria-expanded="true"] { background: var(--surface-2); }
.manual__body { display: grid; gap: .35rem; padding: .5rem 0 0; min-width: 0; }
summary { min-height: 44px; cursor: pointer; color: var(--brand); font-size: .9rem; }
.note { margin: 0; color: var(--ink-2); overflow-wrap: anywhere; }
.callout { padding: .6rem .8rem; background: var(--warn-soft); color: var(--warn-ink); border-left: 3px solid #d1a24a; border-radius: 0 var(--radius-1) var(--radius-1) 0; }
.interval-summary { margin: .25rem 0 0; padding: .65rem .85rem; background: var(--ok-soft); border: 1px solid #b7d3c0; border-radius: var(--radius-1); color: var(--ok-ink); font-size: .9rem; font-weight: 500; }
.notice-line { padding: .1rem 0; }
</style>
