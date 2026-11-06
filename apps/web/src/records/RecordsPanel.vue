<script setup lang="ts">
/**
 * 记录面板：新建基础记录。所有领域校验在
 * `draftProblems` 与 `createRecordApplication`，组件只收集输入并展示结果。
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { DateView } from '../../../../packages/application/date-view.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import {
  commandFromDraft,
  draftProblems,
  newRecordId,
  type RecordDraft,
  type RecordLayer,
  type RecordSummaryInput,
} from './record-commands';
import { basicSavePlan, describeSavePlan, describeSavedPlan, type LastSave } from './save-plan';
import { labelOf } from './labels';

const props = defineProps<{
  network: TransitNetwork;
  view: DateView | null;
  facts: { readonly basic: readonly RecordSummaryInput[]; readonly advanced: readonly RecordSummaryInput[] };
  busy?: boolean;
  /**
   * 失败提示与它的重试语义必须一一对应：保存失败仍由这里显示消息，但重试入口在全局横幅
   * （载荷由 App 保留），面板不再放一个语义含混的「重试统计」；action 缺省保持旧行为。
   */
  alert?: { readonly message: string; readonly retryable: boolean; readonly action?: 'save' | 'calculate' } | null;
  savedRecordId?: string;
  lastSave?: LastSave | null;
}>();
const emit = defineEmits<{
  add: [command: { id: string; layer: RecordLayer; note?: string; vehicle?: string }];
  'retry-calculation': [];
}>();

const note = ref('');
const localMessage = ref('');
const submitted = ref<{ id: string; note: string } | null>(null);
const summary = ref<HTMLElement | null>(null);
/**
 * 保存回执（决策 #42）：`savedRecordId` 只表示提交已完成，写入了什么以工作区回执 `lastSave` 为准。
 * 完全重复时没有新记录，备注不清空，避免让用户以为输入已被采纳。
 */
watch(() => props.savedRecordId, id => {
  if (id !== submitted.value?.id) return;
  const lastSave = props.lastSave ?? null;
  localMessage.value = lastSave ? describeSavedPlan(lastSave, props.network) : '基础记录已保存。';
  if ((lastSave === null || lastSave.runs.length > 0) && note.value === submitted.value?.note) {
    note.value = '';
  }
  submitted.value = null;
});

const draft = computed<RecordDraft>(() => ({
  layer: 'basic',
  onDate: props.view?.onDate ?? '',
  fromStationId: props.view?.fromStationId ?? '',
  toStationId: props.view?.toStationId ?? '',
  serviceLineId: props.view?.serviceLineId ?? null,
  physicalLineId: props.view?.physicalLineId,
  note: note.value,
  vehicle: '',
}));
const problems = computed(() => draftProblems(draft.value));
const routeReady = computed(() => props.view !== null && props.view.routeAvailable && !props.view.empty);
/**
 * 保存预览（决策 #42）：保存时扣除该档案已有基础记录覆盖的区间，只写入未记录部分并按连续段拆分。
 * 预览只在确有已记录段时出现，常态录入不重复「本次区间」摘要；[role="status"] 不参与提交拦截。
 */
const savePreview = computed(() => {
  const plan = basicSavePlan(props.view, props.facts.basic);
  if (!plan || plan.covered === 0) return '';
  return describeSavePlan(plan, props.network);
});
const routeHint = computed(() => {
  if (!props.view) return '请先选择物理线路，再选择出发站和到达站。';
  if (props.view.empty) return '该日期没有可用线路数据。';
  if (!props.view.routeAvailable) return '所选起终点在该日期没有可办客的完整径路。';
  return `${props.view.onDate} · ${labelOf(props.network, props.view.fromStationId ?? '')} → ${labelOf(props.network, props.view.toStationId ?? '')}`;
});
const feedback = computed(() => props.alert?.message ?? localMessage.value);
const feedbackRetryable = computed(() => props.alert?.retryable ?? false);

watch(() => props.view, () => {
  localMessage.value = '';
});

function submit(): void {
  if (props.busy || problems.value.length > 0 || !routeReady.value) {
    // 提交被拦截时把焦点送到错误摘要，读屏先读到具体错误，而不是停在原按钮上无反馈。
    void nextTick(() => summary.value?.focus());
    return;
  }
  const command = commandFromDraft(draft.value, newRecordId());
  submitted.value = { id: command.id, note: note.value };
  emit('add', command);
  localMessage.value = '记录已提交，等待保存与重算。';
}

</script>

<template>
  <section class="records" aria-labelledby="records-title" tabindex="-1">
    <div class="section-head">
      <h2 id="records-title"><span class="step-num" aria-hidden="true">3</span>备注并保存</h2>
      <p class="section-lead">这里只录入基础完乘；链式行程请使用「进阶」标签。</p>
    </div>
    <p class="summary-line">
      <span class="summary-line__label">本次区间</span>
      <strong>{{ routeHint }}</strong>
    </p>
    <p v-if="savePreview" class="save-preview" role="status">{{ savePreview }}</p>

    <form class="form" @submit.prevent="submit">
      <label for="record-note">备注（可选）</label>
      <input id="record-note" v-model="note" :disabled="busy" maxlength="2000"
        :aria-invalid="problems.length > 0" aria-describedby="record-problems" />
      <div class="form-actions">
        <button type="submit" class="primary" :disabled="busy || problems.length > 0 || !routeReady">保存记录</button>
      </div>
      <!-- role="alert" 必须放在容器上：直接给 <ul> 会覆盖列表语义，<li> 也失去 list 父级（axe listitem）。 -->
      <div v-if="problems.length > 0" id="record-problems" ref="summary" class="problems" role="alert"
        tabindex="-1">
        <ul>
          <li v-for="problem in problems" :key="problem">{{ problem }}</li>
        </ul>
      </div>
    </form>

    <p v-if="feedback" class="feedback" role="status" aria-live="polite">{{ feedback }}</p>
    <!-- 保存失败的「重试保存」在全局横幅；这里只保留原有的重算入口，避免一个按钮兼两种语义。 -->
    <button v-if="feedbackRetryable && alert?.action !== 'save'" type="button" class="small" @click="emit('retry-calculation')">重试统计</button>

  </section>
</template>

<style scoped>
.records { display: grid; gap: .75rem; min-width: 0; }
h2, h3 { margin: 0; }
.summary-line { display: grid; gap: .1rem; margin: 0; padding: .7rem .9rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-1); overflow-wrap: anywhere; }
.summary-line__label { font-size: .75rem; letter-spacing: .08em; color: var(--ink-3); }
.summary-line strong { font-size: 1rem; font-weight: 600; color: var(--ink); }
.save-preview { margin: 0; padding: .6rem .8rem; background: var(--warn-soft); color: var(--warn-ink); border-left: 3px solid #d1a24a; border-radius: 0 var(--radius-1) var(--radius-1) 0; font-size: .88rem; }
.form { display: grid; gap: .35rem; max-width: 34rem; min-width: 0; }
label { font-size: .9rem; font-weight: 500; }
input { min-height: 44px; padding: 0 .7rem; border: 1px solid var(--line-strong); border-radius: var(--radius-1); }
input { width: 100%; min-width: 0; }
.form-actions { display: flex; justify-content: flex-start; margin-top: .35rem; }
.form-actions button { width: auto; min-width: 9rem; }
.problems { margin: 0; padding: .6rem .8rem; background: var(--danger-soft); border-left: 3px solid var(--danger); border-radius: 0 var(--radius-1) var(--radius-1) 0; color: var(--danger); }
.problems ul { margin: 0; padding-left: 1.2rem; }
.feedback { margin: 0; padding: .6rem .8rem; background: var(--ok-soft); border-left: 3px solid #2e7d4f; border-radius: 0 var(--radius-1) var(--radius-1) 0; font-size: .9rem; }
.hint, .empty, .date, .note { color: var(--ink-2); font-size: .9rem; }
/* 备注是用户自由文本：长串必须能断行，否则 390px 下撑破列表（实测 397px 溢出）。 */
.note { overflow-wrap: anywhere; }
button { cursor: pointer; }
</style>
