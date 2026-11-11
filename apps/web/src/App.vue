<script setup lang="ts">
/**
 * 根协调组件：加载真实封套、持 activeView 与会话/日期状态，并把各个面板接起来。
 *
 * 状态机与可用性判断在 integration/*（纯逻辑、可测）；这里只做协调、焦点与 aria-live 反馈。
 * 端口由 integration/workspace 用真实 createIdbBackend 打开，运行期不回落到 fake-storage；
 * 拓扑映射通过 workspace.calculate → recalculate(..., createMappedCompute()) 注入。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import type { TransitNetwork } from '../../../packages/application/reader.mjs';
import { errorFeedback, networkAssets, toOverview } from './input';
import type { InputLoader, InputOverview } from './input';
import { createNetworkLoader } from './network-loader';
import type { LoadedNetwork, NetworkLoader } from './network-loader';
import { EARLIEST_DATE, clampDate, clampToWindow, coverageWindow, dateBounds, defaultDate, envelopeNotice, sourceLabel, stepView, VIEWS, viewAvailability } from './integration/app-state';
import type { ActiveView, CoverageWindow } from './integration/app-state';
import { serviceCandidates } from './integration/trip';
import { buildPhysicalTrip } from './records/physical-route';
import { createWorkspace } from './integration/workspace';
import type { Workspace, WorkspaceState } from './integration/workspace';
import { useSessionActions } from './integration/session-actions';
import { runAdvancedSave } from './integration/advanced-save';
import { describeCalculation } from './stats/calculation';
import { buildDimensionStatistics } from './stats/dimensions';
import type { StatisticsData } from './stats/statistics';
import type { RecordMetadata, VehicleDetails } from '../../../packages/application/records.mjs';
import type { LastSave } from './records/save-plan';
import type { RecordLayer } from './records/record-commands';
import { useBackupActions } from './integration/backup-actions';
import OverviewPanel from './integration/OverviewPanel.vue';
import SnapshotSummary from './integration/SnapshotSummary.vue';
import RecordsPanel from './records/RecordsPanel.vue';
import SavedRecordsPanel from './records/SavedRecordsPanel.vue';
import StatsPanel from './stats/StatsPanel.vue';
import BackupPanel from './backup/BackupPanel.vue';
import AdvancedPanel from './advanced/AdvancedPanel.vue';
import type { ServiceCandidate } from './advanced/chain';
import type { PendingItem } from './advanced/panelTypes';
import { pendingReasonLabel } from './integration/completion';
import { describeRouteCompletion } from './integration/route-completion';
import RecordRouteSelector from './records/RecordRouteSelector.vue';
import DateField from './components/DateField.vue';
import type { StatisticsScope } from './stats/statistics';
import { reviewedMapping } from '../.generated/reviewed-mapping';

/** 生成器按目标快照键控；每条只用于该目标快照的统计。 */
type ReviewedEntry = {
  readonly snapshots: readonly string[];
  readonly stationSplits: readonly { readonly retiredStationId: string; readonly targetStationIds: readonly string[] }[];
  readonly throughServicePairs: readonly (readonly [string, string])[];
};
const reviewedTable: Readonly<Record<string, ReviewedEntry>> = reviewedMapping;
const reviewedFor = (snapshotId: string): ReviewedEntry | undefined => reviewedTable[snapshotId];

const props = defineProps<{ loadInput?: InputLoader }>();
type LoadState = { kind: 'loading' } | { kind: 'ready'; overview: InputOverview }
  | { kind: 'error'; code: string; message: string; retryable: boolean };
const state = shallowRef<LoadState>({ kind: 'loading' });
const feedback = ref<InstanceType<typeof OverviewPanel>>();
const network = shallowRef<TransitNetwork | null>(null);
const view = ref<ActiveView>('records');
/** 每个标签页自己的任务标题：首屏先给出「这一页要做什么」，品牌口号不再占用所有页面顶部。 */
const pageCopy: Readonly<Record<ActiveView, { readonly title: string; readonly lead: string }>> = {
  records: { title: '基础记录', lead: '选择物理线路与起终点，保存一次完整乘车。' },
  saved: { title: '已保存', lead: '查看本机记录，补充备注或车辆信息，也可以删除记录。' },
  stats: { title: '统计', lead: '按日期、范围与口径查看已乘坐与未乘坐情况。' },
  backup: { title: '备份', lead: '导出本机记录文件，或从备份整份恢复。' },
  advanced: { title: '进阶记录', lead: '逐段接续同一次乘车，保存一条完整径路。' },
};
const page = computed(() => pageCopy[view.value]);
const session = shallowRef<WorkspaceState>({ phase: 'idle', message: '', errorCode: null, retryable: false, snapshot: null });
const status = ref('');
const busy = ref(false);
const savedRecordId = ref('');
/**
 * 最近一次基础保存的回执快照：保存成功后立刻取工作区返回值，避免随后的重算把它清成 null，
 * 面板才能稳定拿到「实际写了几段」。
 */
const lastSave = ref<LastSave | null>(null);
const advancedSaved = ref<{ recordId: string; message: string } | null>(null);
const advancedError = ref('');
const vehicleFeedback = ref<{ ok: boolean; message: string } | null>(null);
const snapshotError = ref('');
const statsScope = ref<StatisticsScope>({ basis: 'mileage', area: 'all', includeRetired: true });
let loadedNetworks: LoadedNetwork | undefined;
const pageDates = ref<Record<ActiveView, string>>({ records: '', saved: '', stats: '', backup: '', advanced: '' });
const onDate = computed(() => pageDates.value[view.value]);
const trip = ref({ fromStationId: '', toStationId: '', physicalLineId: '' });
let loader: NetworkLoader | undefined;
let workspace: Workspace | undefined;
let active: AbortController | undefined;
let requestId = 0;
let disposed = false;
let activeTimer: ReturnType<typeof setTimeout> | undefined;
const { state: backup, exportBackup, inspectImport, confirmImport, cancelImport, dispatch: dispatchBackup } = useBackupActions({
  workspace: () => workspace, exportedOn: () => pageDates.value.backup, report: message => { status.value = message; },
  // 导入后重算：组合式函数在其后初始化，用惰性箭头避免 setup 期就求值。
  afterImport: () => recalculate(),
});

/**
 * AdvancedPanel 是真实文件，直接静态 import：不再用 glob 兜底，
 * 让缺失/契约漂移在类型检查与构建期暴露，而不是运行期静默降级。
 */

const overview = computed(() => (state.value.kind === 'ready' ? state.value.overview : null));
const error = computed(() => (state.value.kind === 'error'
  ? { code: state.value.code, message: state.value.message, retryable: state.value.retryable } : null));
const workspaceOpen = computed(() => session.value.snapshot !== null);
/**
 * 会话级操作（重算/自动补算/保存与重试）收在 integration/session-actions：
 * 失败提示按「实际操作」说话，按钮与操作一一对应；App 这里只负责把它接到面板上。
 */
const { calculating, failure, failureAction, unsavedNotice, addRecord, recalculate,
  autoRecalculateIfStale, resetForReload, resetAutoAttempt, invalidate } = useSessionActions({
  workspace: () => workspace,
  network: () => network.value,
  onDate: () => onDate.value,
  workspaceOpen: () => workspaceOpen.value,
  snapshotError: () => snapshotError.value,
  currentView: () => tripView.value,
  retryWorkspace: () => { void retryWorkspace(); },
  busy, status, session, lastSave, savedRecordId,
});
/** 日期控件可达区间：各包声明覆盖范围的并集，而不是当前选中包的知识截止日。 */
const coverage = computed<CoverageWindow | null>(() => (loadedNetworks
  ? coverageWindow(loadedNetworks.coverage)
  : (network.value ? { min: EARLIEST_DATE, max: network.value.knowledgeThrough } : null)));
const bounds = computed(() => dateBounds(coverage.value, onDate.value));

/** 进阶面板需要的当日候选线路形状（ServiceCandidate），与记录面板的下拉选项分开。 */
const advancedServices = computed<readonly ServiceCandidate[]>(() =>
  (network.value ? serviceCandidates(network.value, onDate.value) : []));

/** 统计派生里的 pending 只有原因码；面板展示需要统一文案，注入时补齐 message。 */
const advancedPending = computed<readonly PendingItem[]>(() =>
  (session.value.snapshot?.derived?.pending ?? []).map(row => ({ ...row, message: pendingReasonLabel(row.reason) })));
const tripResult = computed(() => {
  const current = network.value;
  if (!current || snapshotError.value || !onDate.value || !trip.value.fromStationId || !trip.value.toStationId || !trip.value.physicalLineId) return null;
  return buildPhysicalTrip(current, { onDate: onDate.value, ...trip.value });
});
const tripView = computed(() => (tripResult.value?.ok ? tripResult.value.view : null));
const tripMessage = computed(() => (tripResult.value && !tripResult.value.ok ? tripResult.value.message : ''));
const expected = computed(() => ({ onDate: onDate.value, snapshotId: network.value?.snapshotId ?? '' }));
/**
 * 线路图的完乘三态：直接读工作区快照里的单一派生（总体完乘并集已按乘车日期截断），
 * 重算中或结果对不上时只给中性线，不把「不知道」画成「未乘坐」。
 */
const routeCompletion = computed(() => describeRouteCompletion({ derived: session.value.snapshot?.derived ?? null,
  calculation: session.value.snapshot?.calculation ?? null, expected: expected.value, busy: busy.value,
  phase: session.value.phase }));
const calculation = computed(() => {
  const view = describeCalculation(session.value.snapshot?.calculation ?? null, session.value.snapshot?.derived ?? null, expected.value);
  if (!calculating.value || !expected.value.onDate) return view;
  // 重算进行中：复用统计页现成的计算状态区域播报进度，读屏不会停在旧结果上。
  return { ...view, kind: 'running' as const, message: `正在计算 ${expected.value.onDate} 的统计…`, retryable: false };
});
const statsData = computed(() => (session.value.snapshot?.derived?.statistics ?? null) as StatisticsData | null);
/** 运营商/线路维度是体验增强，不在验收范围内；数据缺失时保持为空，不伪造分组。 */
const statsDimensions = computed(() => {
  const current = network.value;
  const derived = session.value.snapshot?.derived ?? null;
  return current && derived ? buildDimensionStatistics(current, derived) : null;
});
const cityNames = computed(() => new Map((network.value?.cities ?? []).map(city => [city.id, city.name] as const)));
const availability = computed(() => VIEWS.map(entry => ({ ...entry, ...viewAvailability(entry.id, { hasNetwork: overview.value !== null, workspaceOpen: workspaceOpen.value, hasTrip: tripView.value !== null, snapshotAvailable: entry.id !== view.value || !snapshotError.value }) })));
const throughServicePairs = computed(() => (network.value ? reviewedFor(network.value.snapshotId)?.throughServicePairs ?? [] : []));
/** 当前选中封套自己声明的覆盖窗口（不是各包并集），用于说明这一页覆盖哪些日期。 */
const envelopeCoverage = computed(() => {
  const current = network.value;
  if (!current) return null;
  // 索引只在真实加载路径里存在；注入式加载（含测试）没有索引时按“未声明覆盖”处理。
  const entry = (loadedNetworks?.index?.entries ?? []).find(row => row.snapshotId === current.snapshotId);
  return entry ? { from: entry.coverageFrom, to: entry.coverageTo } : null;
});
/** 模拟（重建）封套的常驻提示；真实封套返回 null，由面板的来源标签负责说明。 */
const notice = computed(() => (overview.value
  ? envelopeNotice({ sourceKind: overview.value.sourceKind, snapshotId: overview.value.snapshotId,
    onDate: onDate.value, coverage: envelopeCoverage.value })
  : null));
/** 顶栏常显的来源标签：所有标签页都可见，状态区不重复同一句。 */
const sourceBadge = computed(() => (overview.value ? sourceLabel(overview.value.sourceKind) : ''));

async function readInput(signal: AbortSignal): Promise<{ overview: InputOverview; network: TransitNetwork | null }> {
  if (props.loadInput) return { overview: await props.loadInput(signal), network: null };
  loader ??= createNetworkLoader({ assets: networkAssets(), baseUrl: import.meta.env.BASE_URL });
  const next = await loader.load(signal);
  if (next.kind === 'error') throw next.error;
  if (next.kind !== 'ready') throw new Error('E_ABORT');
  loadedNetworks = next.data;
  return { overview: toOverview(next.data.network), network: next.data.network };
}

async function load(moveFocus = false): Promise<void> {
  const id = ++requestId;
  active?.abort();
  const controller = new AbortController();
  active = controller;
  // 重新加载视为新的数据会话：上一次保存的待重试载荷与失败提示都不再适用。
  resetForReload();
  state.value = { kind: 'loading' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('E_TIMEOUT')); controller.abort(); }, 15_000);
      activeTimer = timer;
    });
    const result = await Promise.race([readInput(controller.signal), timeout]);
    if (disposed || id !== requestId) return;
    state.value = { kind: 'ready', overview: result.overview };
    if (result.network) {
      network.value = result.network;
      // 五个视图共用同一个默认业务日期：浏览器本地「今天」，再夹到已加载包声明的覆盖窗口。
      const today = defaultDate(result.network);
      const clampWindow = loadedNetworks ? coverageWindow(loadedNetworks.coverage) : null;
      const initialDate = clampWindow ? clampToWindow(today, clampWindow) : today;
      for (const entry of VIEWS) pageDates.value[entry.id] ||= initialDate;
      await selectDate(false);
    }
    if (result.network) {
      const opened = await ensureWorkspace()!.open();
      // 刷新或换数据源后，持久化统计可能属于上一个输入：打开后补一次重算，别把旧数字当新结果。
      if (opened.phase === 'ready') await autoRecalculateIfStale();
    }
  } catch (error: unknown) {
    if (disposed || id !== requestId) return;
    state.value = { kind: 'error', ...errorFeedback(error) };
    moveFocus = true;
  } finally {
    clearTimeout(timer);
  }
  if (moveFocus && !disposed && id === requestId) {
    await nextTick();
    if (!disposed && id === requestId) feedback.value?.focusFeedback(state.value.kind === 'error' ? 'error' : 'loaded');
  }
}

function ensureWorkspace(): Workspace | undefined {
  if (!workspace) {
    workspace = createWorkspace({ indexedDB: globalThis.indexedDB,
      reviewedFor: selected => reviewedFor(selected.snapshotId) });
    workspace.subscribe(next => { session.value = next; });
  }
  return workspace;
}

async function openView(next: ActiveView): Promise<void> {
  const entry = availability.value.find(row => row.id === next);
  if (!entry?.enabled) { status.value = entry?.reason || '该视图暂不可用'; return; }
  const previousDate = onDate.value;
  view.value = next;
  document.title = `${entry.label} · 线网数据概览`;
  status.value = `已切换到${entry.label}`;
  await selectDate(previousDate !== onDate.value);
  if (view.value !== next) return;
  if (entry.needs !== 'network') {
    const target = ensureWorkspace();
    // 只有「存储端口确实没打开」才重开：某次保存/重算失败也会把 phase 置为 error，
    // 若按 phase 判断，切页就会重新 open 并清掉失败横幅与「重试保存」入口，而待重试载荷还在内存里。
    if (target && !target.isOpen()) {
      await target.open(); status.value = session.value.phase === 'ready' ? `${entry.label}已就绪` : session.value.message;
    }
  }
  // 回到统计相关页面时再核对一次；同一输入不会重复触发（去重键在 session-actions）。
  await autoRecalculateIfStale();
}

async function retryWorkspace(): Promise<void> {
  const next = await ensureWorkspace()!.retry();
  if (next.phase !== 'ready') { status.value = next.message; return; }
  // 重新打开视为新的输入周期：同一输入允许再自动补算一次。
  resetAutoAttempt();
  status.value = '本地工作区已打开；可显式重新计算统计';
  await autoRecalculateIfStale();
}

/** 方向键切 tab 时跳过 aria-disabled 视图（stepView 本身保持纯索引语义，其断言不变）。 */
function nextEnabledView(from: ActiveView, delta: number): ActiveView {
  let candidate = stepView(from, delta);
  for (let guard = 0; guard < availability.value.length; guard += 1) {
    const entry = availability.value.find(row => row.id === candidate);
    if (entry?.enabled) return candidate;
    candidate = stepView(candidate, delta);
  }
  return from;
}

function onTabKey(event: KeyboardEvent): void {
  const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (delta === 0) return;
  event.preventDefault();
  const target = nextEnabledView(view.value, delta);
  if (target === view.value) return;
  // 焦点立即跟随：页签按钮本身可聚焦，不必等 openView 里的选日期/打开工作区/自动补算跑完。
  // 延后聚焦会让快速连按的方向键落在旧页签上，读屏因此不会播报「已选择」。
  void openView(target);
  // openView 在目标不可用（或已被忙状态改走）时会提前返回而 view 不变；那时不能动焦点。
  if (view.value === target) document.getElementById(`tab-${target}`)?.focus();
}

async function setDate(next: string): Promise<void> {
  pageDates.value[view.value] = coverage.value ? clampToWindow(next, coverage.value) : clampDate(next, network.value);
  await selectDate(true);
}

async function selectDate(recompute: boolean): Promise<void> {
  snapshotError.value = '';
  if (loader && loadedNetworks) {
    try {
      const selected = loader.select(onDate.value);
      const selectedNetwork = loadedNetworks.networks.get(selected.snapshotId);
      if (!selectedNetwork) throw new Error('已验证快照内容缺失');
      network.value = selectedNetwork;
      state.value = { kind: 'ready', overview: toOverview(selectedNetwork) };
    } catch {
      // 失败时不切换 network；清掉依赖旧网络的临时行程选择，并在提示里给出仍生效的快照身份。
      trip.value = { fromStationId: '', toStationId: '', physicalLineId: '' };
      const activeSnapshot = network.value
        ? `当前仍生效的快照：${network.value.snapshotId}（asOf ${network.value.snapshotAsOf}，knowledgeThrough ${network.value.knowledgeThrough}）`
        : '当前没有生效的快照';
      snapshotError.value = `没有覆盖所选日期的已验证快照，无法记录或重算；已清空临时的当日起终点选择。${activeSnapshot}。请选择覆盖范围内的日期。`;
    }
  }
  if (recompute) status.value = `当前页日期为 ${onDate.value}`;
  if (recompute && !snapshotError.value) await recalculate();
}

async function removeRecord(layer: RecordLayer, id: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const next = await workspace!.removeRecord(layer, id);
  if (next.phase === 'ready') {
    await recalculate();
    status.value = session.value.phase === 'ready' ? '记录已删除，统计已更新' : `记录已删除；${session.value.message}`;
  } else status.value = next.message;
  busy.value = false;
}

async function editRecord(layer: RecordLayer, id: string, patch: RecordMetadata): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  const next = await workspace!.editMetadata(layer, id, patch);
  busy.value = false;
  status.value = next.phase === 'ready' ? '备注与车辆已保存' : next.message;
}

async function saveVehicle(id: string, details: VehicleDetails): Promise<void> {
  if (busy.value || advancedSaved.value?.recordId !== id) return;
  busy.value = true;
  vehicleFeedback.value = null;
  try {
    const next = await workspace!.editMetadata('advanced', id, { vehicleDetails: details });
    vehicleFeedback.value = { ok: next.phase === 'ready', message: next.phase === 'ready'
      ? '车辆信息已保存，可在「已保存」中查看和修改。' : `${next.message} 可重试保存车辆信息；乘车记录已保留。` };
  } finally { busy.value = false; }
}

async function onAdvancedSave(payload: unknown): Promise<void> {
  const current = network.value;
  if (!current || busy.value || snapshotError.value) { status.value = '网络或日期尚未就绪，进阶记录未保存'; return; }
  if (!workspaceOpen.value) { status.value = '本地工作区尚未就绪，进阶记录未保存'; return; }
  busy.value = true;
  advancedError.value = '';
  vehicleFeedback.value = null;
  try {
    // 会话层注入 id 与当前快照；写入成功后立即重算，让进阶统计与总体并集一起刷新。
    const result = await runAdvancedSave({
      addAdvancedRecord: record => workspace!.writeAdvanced(record),
      recalculate: () => workspace!.calculate(current, onDate.value),
    }, payload, current.snapshotId);
    status.value = result.message;
    if (result.saved && result.recordId) {
      advancedSaved.value = { recordId: result.recordId, message: result.recalculated
        ? '本次乘车已保存。' : '本次乘车已保存；统计暂未更新，请在「统计」页查看并重试。' };
    } else advancedError.value = result.message;
  } finally {
    busy.value = false;
  }
}

function onAdvancedDelete(record: { layer: RecordLayer; recordId: string }): void {
  void removeRecord(record.layer, record.recordId);
}

onMounted(() => { document.title = '记录 · 线网数据概览'; void load(); });
onUnmounted(() => { disposed = true; ++requestId; active?.abort(); clearTimeout(activeTimer); invalidate(); loader?.dispose(); workspace?.dispose(); });
</script>

<template>
  <a class="skip-link" href="#content">跳至主要内容</a>
  <header class="masthead">
    <a class="wordmark" href="./"><span class="mark">N</span> NoritsubushiCN<span class="sr-only"> 首页</span></a>
    <span class="source-badge" :class="{ simulated: overview?.sourceKind === 'simulated' }"
      role="status" aria-live="polite">{{ sourceBadge }}</span>
    <span class="phase">线网 · 内部测试</span>
  </header>
    <nav v-if="state.kind === 'ready'" class="views" aria-label="功能视图">
      <div role="tablist" aria-label="功能视图" @keydown="onTabKey">
        <button v-for="entry in availability" :key="entry.id" type="button" role="tab"
          :id="`tab-${entry.id}`" :aria-selected="view === entry.id" :aria-controls="view === entry.id ? `panel-${entry.id}` : undefined"
          :tabindex="view === entry.id ? 0 : -1" :aria-disabled="entry.enabled ? undefined : 'true'"
          :title="entry.enabled ? undefined : entry.reason" @click="openView(entry.id)">{{ entry.label }}</button>
      </div>
    </nav>
  <main id="content" tabindex="-1" :aria-busy="busy || state.kind === 'loading' ? 'true' : 'false'">
    <header class="page-head">
      <p class="eyebrow">本地线网 · 完乘记录</p>
      <h1 id="page-title">{{ page.title }}</h1>
      <p class="page-lead">{{ page.lead }}</p>
    </header>

    <p class="sr-only" role="status" aria-live="polite">{{ status }}</p>
    <OverviewPanel ref="feedback" :loading="state.kind === 'loading'" :overview="overview" :error="error" :notice="notice" @reload="load(true)" />
    <p v-if="session.phase === 'opening'" class="app-status" role="status">正在打开本地工作区…</p>
    <!-- 失败横幅按实际操作说话：文案与按钮都来自 failure，不再一律念「记录未保存」+「重新打开工作区」。 -->
    <div v-if="failure" class="app-error" role="alert">{{ failure.message }} <button v-if="failureAction" type="button" class="small" @click="failureAction.run()">{{ failureAction.label }}</button></div>
    <!-- 待重试的保存载荷在自己的生命周期里：工作区横幅被后续成功操作清空后，入口仍然在。 -->
    <div v-if="unsavedNotice" class="app-error" role="alert">{{ unsavedNotice.message }} <button type="button" class="small" @click="unsavedNotice.run()">重试保存</button></div>
    <p v-if="snapshotError" class="app-error" role="alert">{{ snapshotError }}</p>



    <div v-if="state.kind === 'ready'" :id="`panel-${view}`" role="tabpanel" :aria-labelledby="`tab-${view}`">
      <SnapshotSummary v-if="view === 'stats' && overview" :overview="overview" :coverage="envelopeCoverage" />
      <div v-if="view === 'records' || view === 'advanced'" class="page-toolbar">
        <label class="date-field" :for="`${view}-page-date`">乘车日期
          <DateField :id="`${view}-page-date`" :value="bounds.onDate" :min="bounds.min" :max="bounds.max"
            :disabled="busy" @change="setDate" />
        </label>
        <span class="date-range" aria-live="polite">{{ bounds.min }} 至 {{ bounds.max }} · 只统计不晚于知识截止日的记录</span>
      </div>
    <template v-if="view === 'records' && network">
      <RecordRouteSelector v-model="trip" :network="network" :on-date="onDate" :completion="routeCompletion"
        :available="!snapshotError" :disabled="busy || !!snapshotError" :message="tripMessage"
        :can-recalculate="workspaceOpen && !snapshotError"
        @recalculate="recalculate" />
      <RecordsPanel v-if="tripView" :network="network" :view="tripView" :facts="session.snapshot?.facts ?? { basic: [], advanced: [] }"
        :busy="busy || !!snapshotError" :saved-record-id="savedRecordId" :last-save="lastSave"
        :alert="failure?.operation === 'save-basic' ? { message: failure.message, retryable: failure.retryable, action: 'save' } : null"
        @add="addRecord" @retry-calculation="recalculate" />
    </template>

    <template v-else-if="view === 'saved' && network">
      <SavedRecordsPanel :network="network" :facts="session.snapshot?.facts ?? { basic: [], advanced: [] }"
        :busy="busy" @remove="removeRecord" @edit="editRecord" />
      <p>{{ status }}</p>
    </template>
    <template v-else-if="view === 'stats'">
      <StatsPanel :data="statsData" :dimensions="statsDimensions" :calculation="calculation" :city-names="cityNames" :busy="busy || !!snapshotError"
        :on-date="bounds.onDate" :min-date="bounds.min" :max-date="bounds.max" :scope="statsScope" @update:scope="statsScope = $event" @recalculate="recalculate" @change-date="setDate" />
    </template>

    <template v-else-if="view === 'backup'">
      <BackupPanel :state="backup" :exporting="busy" :today="pageDates.backup"
        @export="exportBackup" @import-file="inspectImport" @confirm="confirmImport" @cancel="cancelImport"
        @reset="dispatchBackup({ type: 'reset' })" />
    </template>

    <template v-else-if="view === 'advanced'">
      <AdvancedPanel v-if="network" :network="network" :on-date="onDate"
        :services="advancedServices" :pending="advancedPending" :saved="advancedSaved" :save-error="advancedError" :vehicle-feedback="vehicleFeedback"
        :disabled="busy || !workspaceOpen || !!snapshotError"
        :through-service-pairs="throughServicePairs"
        @start="status = '已开始进阶行程'" @continue="status = '已继续进阶行程'" @rollback="status = '已回退上一条径路'"
        @save="onAdvancedSave" @delete="onAdvancedDelete" @vehicle="saveVehicle"
        @restart="advancedSaved = null; advancedError = ''; vehicleFeedback = null" />
      <p v-else class="note" role="status">请先加载数据，再进入进阶录入。</p>
      <p class="note">{{ throughServicePairs.length > 0
        ? `当前快照已复核的直通线路对：${throughServicePairs.map(pair => pair.join(' ↔ ')).join('、')}`
        : '当前快照未提供已复核的直通线路对；直通候选保持待处理，不能根据共享车站推断。' }}</p>
    </template>
    </div>

    <aside class="usage" aria-labelledby="usage-title">
      <h2 id="usage-title">使用范围</h2>
      <p>本页用于内部数据与工程验证，尚不具备正式发布条件。记录、统计、备份、进阶与地图功能仍需人工验收。</p>
      <p>坐标采用 WGS-84，数据遵循 <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL 1.0</a>；地图的实际呈现仍需人工验收。</p>
      <p>单写者约束：同一浏览器请只开一个标签页编辑；多标签页并发写入与跨会话幂等当前不做保证。</p>
    </aside>
  </main>
  <footer>
    <p v-if="overview">{{ overview.attribution }}</p>
    <a href="https://www.openstreetmap.org/copyright">OpenStreetMap 来源与版权说明</a>
    <span>线网数据概览</span>
  </footer>
</template>
