<script setup lang="ts">
/**
 * 进阶录入面板：只负责渲染与转发事件，链的状态机在 ./useChainEditor。
 *
 * 契约：日期与径路由本页日期和链决定，多径路目标只列出不猜选，待处理项不计数、
 * 不抛错地整条展示。保存/删除都交给会话层，面板不碰存储。
 */
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { computed, nextTick, ref } from 'vue';
import type { Leg, ServiceCandidate } from './chain';
import type { DirectionOption } from './directionOptions';
import type { AdvancedRecordInput, PendingItem } from './panelTypes';
import type { VehicleDetails } from '../../../../packages/application/records.mjs';
import SearchSelect from '../components/SearchSelect.vue';
import ChainTrail from './ChainTrail.vue';
import PathTargets from './PathTargets.vue';
import PendingList from './PendingList.vue';
import SavedPrompt from './SavedPrompt.vue';
import SaveForm from './SaveForm.vue';
import { useChainEditor } from './useChainEditor';

const props = defineProps<{
  network: TransitNetwork;
  onDate: string;
  services: readonly ServiceCandidate[];
  pending: readonly PendingItem[];
  saved?: { recordId: string; message: string } | null;
  saveError?: string;
  vehicleFeedback?: { ok: boolean; message: string } | null;
  disabled?: boolean;
  throughServicePairs?: readonly (readonly [string, string])[];
}>();
const emit = defineEmits<{
  start: [stationId: string];
  continue: [serviceLineId: string];
  rollback: [];
  save: [recordInput: AdvancedRecordInput];
  delete: [record: { layer: 'basic' | 'advanced'; recordId: string }];
  vehicle: [recordId: string, details: VehicleDetails];
  restart: [];
}>();
const root = ref<HTMLElement | null>(null);
function focusAfter(action: () => void, selector: string): void {
  action();
  void nextTick(() => root.value?.querySelector<HTMLElement>(selector)?.focus());
}

const editor = useChainEditor(props, {
  start: (stationId) => emit('start', stationId),
  continue: (serviceLineId) => emit('continue', serviceLineId),
  rollback: () => emit('rollback'),
  save: (input) => emit('save', input),
  delete: (recordId) => emit('delete', recordId),
});

const {
  originId, draft, paths, choices, directions, direction, legDirections, error, notice,
  stations, availableServices, summary, endStationName, busy, canSave, stepLabel,
  chooseOrigin, chooseService, chooseDirection, chooseContinuation, pickTarget, back, save, remove,
  clearOrigin, clearLine, stationName,
} = editor;

/** 只有确实存在可继续的直通线路时才呈现「可继续的直通线路」整块，否则只留说明文字。 */
const hasContinuations = computed(() => (choices.value?.services.length ?? 0) > 0);

/** 单选组的读屏名：锚点两端用「到」，与视觉上的箭头副文字分开。 */
function directionAria(option: DirectionOption): string {
  const anchor = option.anchor;
  return anchor ? `${option.label}，${anchor.fromName} 到 ${anchor.toName} 方向` : option.label;
}

/** 「已选线路」卡片：线路名追加方向标签（如「11 号线 · 外环」）；方向只是界面状态，不进记录。 */
function legLineLabel(leg: Leg, index: number): string {
  const label = props.services.find(service => service.serviceLineId === leg.serviceLineId)?.label
    ?? leg.serviceLineId;
  const directionLabel = legDirections.value[index]?.label ?? null;
  return directionLabel ? `${label} · ${directionLabel}` : label;
}

/**
 * 自直通续圈时方向沿用本段已选，说明文字不能再声称「只认显式维护的直通对」。
 * 只有候选真的带方向时才承诺「沿用、不询问」；`direction` 为 null 时仍会重新询问。
 */
const continuationNote = computed(() => ((choices.value?.services ?? [])
  .some(row => row.selfThrough && row.direction !== null)
  ? '简单环线默认与自身直通：续圈沿用本段已选方向、不再询问；其它线路只认显式维护的直通对，不按连通性推断。'
  : '直通只认显式维护的线路对，不按连通性推断；下车换乘另一条线路请另开一条记录。'));
</script>

<template>
  <section ref="root" class="adv" :aria-labelledby="saved ? 'adv-saved' : 'adv-title'" :aria-busy="busy ? 'true' : 'false'">
    <SavedPrompt v-if="saved" :saved="saved" :disabled="busy" :feedback="vehicleFeedback"
      @vehicle="(id, details) => emit('vehicle', id, details)"
      @restart="focusAfter(() => { clearOrigin(); emit('restart'); }, '#adv-origin')" />
    <template v-else>
    <div class="section-head">
      <h2 id="adv-title"><span class="step-num" aria-hidden="true">1</span>进阶记录（多段链式）</h2>
      <p class="note">已保存记录的日期与径路不能直接修改；需要更正时请删除后重新录入。</p>
    </div>

    <div class="row">
      <SearchSelect id="adv-origin" v-model="originId" label="起点站" :options="stations" :disabled="busy"
        describedby="adv-date-note" @search="clearOrigin" @update:model-value="chooseOrigin" />
      <span class="badge">乘车日期 {{ props.onDate }} · 只读</span>
    </div>
    <p id="adv-date-note" class="note">日期取自本页乘车日期；链的每一段都固定在该日期，保存后不能直接修改。</p>
    <p class="step" role="status" aria-live="polite">当前步骤：{{ stepLabel }}</p>

    <template v-if="draft">
      <section v-if="draft.legs.length === 0" class="block" aria-labelledby="adv-line-title">
        <h4 id="adv-line-title">{{ endStationName }} 当日候选线路</h4>
        <p v-if="availableServices.length === 0" class="empty">该站在当日没有可用运营线路；请换起点或先核对日期。</p>
        <SearchSelect v-else id="adv-service" label="首段线路" :model-value="paths?.service.serviceLineId ?? directions?.service.serviceLineId ?? ''"
          :options="availableServices.map(service => ({ id: service.serviceLineId, label: service.label, description: service.lineNames.join(' / ') }))"
          :disabled="busy" :clearable="false" @search="clearLine" @update:model-value="id => { const service = availableServices.find(row => row.serviceLineId === id); if (service) chooseService(service); }" />
      </section>

      <ol v-if="draft.legs.length" class="selected-legs" aria-label="已选乘车段">
        <li v-for="(leg, index) in draft.legs" :key="index" class="selected-leg">
          <div class="selection-card">
            <span>第 {{ index + 1 }} 段 · 已选线路</span>
            <strong>{{ legLineLabel(leg, index) }}</strong>
            <span>出发站 → 到达站</span>
            <strong>{{ stationName(leg.fromStationId) }} → {{ stationName(leg.toStationId) }}<template v-if="leg.fromStationId === leg.toStationId"> · 整圈</template></strong>
          </div>
          <button v-if="index === draft.legs.length - 1" type="button" class="back-button" :disabled="busy" @click="focusAfter(back, '#adv-target, #adv-direction input')">回退一段</button>
        </li>
      </ol>

      <section v-if="directions" class="block direction-step" aria-labelledby="adv-direction-title">
        <h4 id="adv-direction-title">第 {{ draft.legs.length + 1 }} 段 · {{ directions.service.label }}（当前在 {{ directions.fromStation.stationName }}站）方向</h4>
        <fieldset id="adv-direction" class="direction-group">
          <legend>乘车方向</legend>
          <div class="direction-options">
            <label v-for="option in directions.options" :key="option.direction" class="direction-option"
              :class="{ selected: direction === option.direction }">
              <input type="radio" name="adv-direction" :value="option.direction"
                :checked="direction === option.direction" :disabled="busy" :aria-label="directionAria(option)"
                @change="chooseDirection(option)" />
              <span class="direction-label">{{ option.label }}</span>
              <span v-if="option.anchor" class="direction-anchor">{{ option.anchor.fromName }} → {{ option.anchor.toName }}</span>
            </label>
          </div>
        </fieldset>
        <p class="note">方向是线路自身的运行方式；选定后每个到站只有一种走法。</p>
        <button v-if="!paths" type="button" class="back-button" :disabled="busy" @click="focusAfter(clearLine, '#adv-service, #adv-continuation')">返回选线</button>
      </section>

      <div v-if="paths" class="target-step">
        <PathTargets :paths="paths" :disabled="busy" @select="id => focusAfter(() => pickTarget(id), '#adv-continuation, #adv-note')" />
        <button type="button" class="back-button" :disabled="busy" @click="focusAfter(clearLine, '#adv-service, #adv-continuation')">返回选线</button>
      </div>

      <template v-if="draft.legs.length > 0 && !paths">
        <p v-for="text in choices?.notices ?? []" :key="text" class="warn" role="status">{{ text }}</p>
        <section v-if="hasContinuations" class="block" aria-labelledby="adv-continue-title">
          <h4 id="adv-continue-title">可继续的直通线路（终点 {{ endStationName }}）</h4>
          <p class="note">{{ continuationNote }}</p>
          <SearchSelect v-if="choices" id="adv-continuation" label="继续直通线路"
            model-value=""
            :options="choices.services.map(choice => ({
              id: choice.service.serviceLineId,
              label: choice.selfThrough && choice.directionLabel
                ? `${choice.service.label} · ${choice.directionLabel}`
                : choice.service.label,
            }))"
            :disabled="busy" :clearable="false" @update:model-value="id => { const choice = choices?.services.find(row => row.service.serviceLineId === id); if (choice) chooseContinuation(choice.service); }" />
        </section>
      </template>

      <details v-if="summary && draft.legs.length > 0">
        <summary>查看完整径路（{{ draft.legs.length }} 段）</summary>
        <ChainTrail :summary="summary" />
      </details>
      <div v-show="draft.legs.length > 0 && !paths">
        <SaveForm :disabled="busy" :can-save="canSave" @save="save" />
      </div>
    </template>

    <PendingList v-if="props.pending.length" :items="props.pending" :disabled="busy" @delete="remove" />

    <p v-if="busy" class="busy" role="status" aria-live="polite">正在处理，控件暂不可用。</p>
    <p v-if="saveError" class="error" role="alert">{{ saveError }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status" aria-live="polite">{{ notice }}</p>
    </template>
  </section>
</template>

<style scoped>
.adv { display: grid; gap: .6rem; min-width: 0; }
h2, h4 { margin: 0; }
.selected-legs { display: grid; gap: .75rem; padding: 0; margin: 0; list-style: none; }
.selected-leg { display: grid; grid-template-columns: minmax(0, 1fr) minmax(7rem, .3fr); gap: .5rem; }
.selection-card { display: grid; gap: .2rem; padding: .8rem .9rem; border: 1px solid #cfe0d4; border-radius: var(--radius-1); background: var(--brand-tint); overflow-wrap: anywhere; }
.selection-card:only-child { grid-column: 1 / -1; }
.selection-card strong { font-size: 1.05rem; line-height: 1.5; }
.selection-card span { font-size: .82rem; color: var(--ink-2); }
.back-button { background: var(--surface); color: var(--brand); border-color: var(--line-strong); min-height: 44px; }
.back-button:hover:not(:disabled) { background: var(--brand-soft); }
.target-step { display: grid; gap: .5rem; }
/* 方向选项：文字始终可见（不靠颜色/箭头区分），整块 label 是≥44px 的触控目标。 */
.direction-step { display: grid; gap: .5rem; }
.direction-group { margin: 0; padding: 0; border: 0; display: grid; gap: .4rem; min-width: 0; }
.direction-group legend { padding: 0; font-size: .9rem; color: var(--ink-2); }
.direction-options { display: flex; flex-wrap: wrap; gap: .5rem; }
.direction-option { display: flex; align-items: center; gap: .5rem; min-height: 44px; padding: .45rem .8rem; border: 1px solid var(--line-strong); border-radius: var(--radius-1); background: var(--surface); cursor: pointer; }
.direction-option.selected { border-color: var(--brand); background: var(--brand-soft); }
.direction-option input[type="radio"] { width: 1.15rem; height: 1.15rem; min-height: 0; margin: 0; }
.direction-label { font-weight: 500; }
.direction-anchor { font-size: .82rem; color: var(--ink-2); }
summary { min-height: 44px; cursor: pointer; color: var(--brand); font-size: .9rem; }
.row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: end; min-width: 0; }
label { font-size: 0.9rem; }
input, select, button { min-height: 44px; min-width: 0; max-width: 100%; font: inherit; }
.block { display: grid; gap: 0.4rem; min-width: 0; border-top: 1px solid var(--line); padding-top: .8rem; }
.badge { padding: .25rem .55rem; background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--line); border-radius: 999px; font-size: 0.78rem; white-space: nowrap; }
.note, .empty, .step { margin: 0; font-size: 0.85rem; color: var(--ink-2); overflow-wrap: anywhere; }
.step { justify-self: start; padding: .4rem .7rem; background: var(--info-soft); color: var(--info-ink); border-radius: var(--radius-1); font-weight: 500; }
.warn { margin: 0; font-size: 0.85rem; color: var(--warn-ink); background: var(--warn-soft); padding: .5rem .7rem; border-radius: var(--radius-1); overflow-wrap: anywhere; }
.busy, .error, .notice { margin: 0; padding: 0.5rem 0.7rem; overflow-wrap: anywhere; border-radius: 0 var(--radius-1) var(--radius-1) 0; }
.busy { background: var(--info-soft); color: var(--info-ink); border-left: 3px solid #2f6f9f; }
.error { background: var(--danger-soft); color: var(--danger); border-left: 3px solid var(--danger); }
.notice { background: var(--ok-soft); color: var(--ok-ink); border-left: 3px solid #2e7d4f; }
.busy button { margin-left: 0.5rem; }
@media (max-width: 520px) {
  .selected-leg { grid-template-columns: minmax(0, 1fr); }
  .back-button { justify-self: start; }
  .direction-options { flex-direction: column; align-items: stretch; }
}
</style>
