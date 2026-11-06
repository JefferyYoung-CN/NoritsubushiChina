<script setup lang="ts">
/**
 * 统计面板：四种维度、分类小计、里程/区间数和统计基准日、
 * 无里程标识与旧结果/失败/重试反馈。数值全部来自统计模块，组件不重算。
 */
import SearchSelect from '../components/SearchSelect.vue';
import DateField from '../components/DateField.vue';
import { computed, ref, watch } from 'vue';
import type { CalculationView } from './calculation';
import { canRecalculate } from './calculation';
import {
  allCityOptions,
  formatStations,
  statisticsRows,
  statisticsTotals,
  statisticsSubtitle,
  type StatisticsBasis,
  type DimensionStatistics,
  type StatisticsData,
  type StatisticsDimension,
  type StatisticsScope,
} from './statistics';

const props = defineProps<{
  data: StatisticsData | null;
  calculation: CalculationView;
  cityNames: ReadonlyMap<string, string>;
  busy?: boolean;
  onDate?: string;
  minDate?: string;
  maxDate?: string;
  scope?: StatisticsScope;
  dimensions?: DimensionStatistics | null;
}>();
const emit = defineEmits<{ recalculate: []; 'change-date': [onDate: string]; 'update:scope': [scope: StatisticsScope] }>();

const dimensionOptions = [{ id: 'area', label: '城市' }, { id: 'operators', label: '运营商' }, { id: 'physicalLines', label: '物理线路' }, { id: 'lines', label: '运营线路' }];
const basis = ref<StatisticsBasis>(props.scope?.basis ?? 'mileage');
const area = ref<string>(props.scope?.area ?? 'all');
const dimension = ref<StatisticsDimension>(props.scope?.dimension ?? 'area');
const includeRetired = ref(props.scope?.includeRetired ?? true);
const onDate = ref(props.onDate ?? props.data?.onDate ?? '');
/** DateField 只在完整合法且落在 min..max 内时回调；这里再通知 App 夹取到已验证快照。 */
function changeDate(next: string): void {
  onDate.value = next;
  emit('change-date', next);
}
const currentScope = computed<StatisticsScope>(() => ({
  basis: basis.value, area: area.value, includeRetired: includeRetired.value, dimension: dimension.value,
}));
watch(currentScope, scope => emit('update:scope', scope));
watch(() => props.onDate ?? props.data?.onDate, date => { onDate.value = date ?? ''; });
const rows = computed(() =>
  props.data ? statisticsRows(props.data, currentScope.value, props.cityNames, props.dimensions) : [],
);
const totals = computed(() => props.data && rows.value.length ? statisticsTotals(props.data, currentScope.value) : []);
const cities = computed(() => (props.data ? allCityOptions(props.data, props.cityNames) : []));
const subtitle = computed(() =>
  props.data ? statisticsSubtitle(props.data, currentScope.value) : '尚无统计数据。',
);
const retryable = computed(() => canRecalculate(props.calculation));
/** 合计区的可访问描述直接复用可见卡片，避免再写一份隐藏文案导致读屏重复。 */
const totalsDescribedBy = computed(() => totals.value.map((_, index) => `stats-total-${index}`).join(' '));
const calc = ref<HTMLElement | null>(null);
// 统计失败时把焦点送到错误摘要（flush:'post' 保证 DOM 已更新），读屏不必停在触发按钮上。
watch(() => props.calculation.kind, kind => {
  if (kind === 'failed') calc.value?.focus();
}, { flush: 'post' });
</script>

<template>
  <section class="stats" aria-labelledby="stats-title">
    <div class="section-head">
      <h2 id="stats-title">完成度统计</h2>
      <p class="subtitle">{{ subtitle }}</p>
    </div>

    <div class="controls">
      <SearchSelect id="stats-dimension" label="统计维度" :model-value="dimension" :options="dimensionOptions"
        :disabled="busy" :clearable="false" @update:model-value="dimension = $event as StatisticsDimension" />
      <fieldset class="basis">
        <legend>统计口径</legend>
        <label><input v-model="basis" type="radio" value="mileage" :disabled="busy" /> 里程</label>
        <label><input v-model="basis" type="radio" value="sections" :disabled="busy" /> 区间数</label>
      </fieldset>
      <template v-if="dimension === 'area'">
        <SearchSelect id="stats-area" v-model="area" label="范围" :options="cities" :disabled="busy" :clearable="false" />
      </template>
      <label class="check"><input v-model="includeRetired" type="checkbox" :disabled="busy" /> 含废线</label>
      <!-- 名称只由这个原生 label 提供；再给分组传 aria-labelledby 会让读屏器念两遍「统计基准日」（走查 D1）。 -->
      <label for="stats-date" class="date-control"><span>统计基准日</span>
      <DateField id="stats-date" :value="onDate" :min="minDate" :max="maxDate" :disabled="busy"
        :aria-invalid="calculation.kind === 'failed'" aria-describedby="stats-calc"
        @change="changeDate" />
      </label>
    </div>

    <p id="stats-calc" ref="calc" class="calc" :class="calculation.kind" role="status" aria-live="polite" tabindex="-1">
      {{ calculation.message }}
      <!-- 徽标只是视觉强调；句子里已经说明「旧结果」，读屏再念一次徽标就成了重复。 -->
      <span v-if="calculation.showsOldResult" class="old" aria-hidden="true">旧结果</span>
    </p>
    <button v-if="retryable" type="button" class="small" :disabled="busy" @click="emit('recalculate')">
      {{ calculation.kind === 'failed' ? '重试统计' : '重新计算' }}
    </button>

    <!-- 合计整组作为一个可聚焦区域：内容本来就是一组不可分割的数字，做成一个 Tab 停留点
         比让每个合计项各占一个停留点更省键盘路径；aria-describedby 指向的正是可见卡片，
         聚焦时一次念出名称与内容，浏览模式下仍可逐项阅读。 -->
    <div v-if="totals.length" class="totals" role="group" tabindex="0"
      aria-label="统计合计" :aria-describedby="totalsDescribedBy">
      <span v-for="(total, index) in totals" :id="`stats-total-${index}`" :key="total.id" class="total">
        <span class="total__label">{{ total.label }}</span>
        <span class="total__value">{{ total.completed }} / {{ total.denominator }} <small>{{ total.note }}</small></span>
      </span>
    </div>
    <p v-if="dimension !== 'area'" class="subtitle">
      各组按物理区间独立去重，共用区间可出现在多组，不能将分组合计当作全网合计。已乘坐车站只由进阶记录贡献（出发站与到达站各计一次），基础记录只贡献区间完乘。
    </p>
    <div v-if="rows.length > 0" class="table-scroll" role="region" tabindex="0"
      aria-label="已乘坐统计表（可用方向键横向滚动查看完整内容）">
      <table>
        <caption class="sr-only">按当前口径的已乘坐情况</caption>
        <thead><tr><th scope="col">范围</th><th scope="col">已乘坐 / 总计</th>
          <th v-if="dimension !== 'area'" scope="col">已乘坐车站 / 总计</th><th scope="col">说明</th></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" :class="{ subtotal: row.subtotal }">
            <th scope="row" :style="{ paddingLeft: `${.4 + (row.level ?? 0) * 1.2}rem` }">{{ row.label }}</th>
            <td>{{ row.completed }} / {{ row.denominator }}</td>
            <td v-if="dimension !== 'area'">{{ row.stations ? `${formatStations(row.stations.completed)} / ${formatStations(row.stations.denominator)}` : '—' }}</td>
            <td>{{ row.note || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="empty">当前口径没有可展示的统计。请选择其他范围或重算。</p>
  </section>
</template>

<style scoped>
.stats { display: grid; gap: .8rem; min-width: 0; }
h2 { margin: 0; }
.subtitle { margin: 0; color: var(--ink-2); font-size: 0.9rem; }
.controls {
  display: grid; gap: .7rem 1rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); align-items: end; min-width: 0;
  padding: .9rem 1rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-1);
}
.basis { border: 1px solid var(--line-strong); border-radius: var(--radius-1); display: flex; gap: .9rem; padding: .45rem .7rem; min-width: 0; background: var(--surface); }
.basis legend { padding: 0 .25rem; font-size: .78rem; color: var(--ink-3); }
.basis label, .check { display: inline-flex; align-items: center; gap: .35rem; min-height: 36px; font-size: .9rem; }
.date-control { display: grid; gap: .25rem; font-size: .9rem; font-weight: 500; }
label { font-size: 0.9rem; }
input, select, button { min-height: 44px; font: inherit; }
.basis input, .check input { min-height: auto; width: auto; }
select, input[type='date'] { padding: 0 0.5rem; width: 100%; min-width: 0; border: 1px solid var(--line-strong); border-radius: var(--radius-1); background: var(--surface); }
.calc { margin: 0; padding: .65rem .85rem; background: var(--info-soft); border-left: 3px solid #2f6f9f; border-radius: 0 var(--radius-1) var(--radius-1) 0; font-size: .9rem; color: var(--info-ink); }
.calc.failed, .calc.stale { background: var(--warn-soft); border-left-color: #b07a1e; color: var(--warn-ink); }
.old { margin-left: 0.4rem; padding: 0 0.35rem; background: var(--warn-ink); color: #fff; border-radius: 4px; font-size: 0.78rem; }
.totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .6rem; margin: 0; padding: 0; }
.total { display: grid; gap: .15rem; padding: .75rem .9rem; background: var(--brand-tint); border: 1px solid #cfe0d4; border-radius: var(--radius-1); }
.total__label { font-size: .8rem; color: var(--ink-2); }
.total__value { font-size: 1.15rem; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.total small { display: block; font-size: .75rem; font-weight: 400; color: var(--ink-3); }
/* 390px 下统计表必然超宽：容器横向滚动并可用键盘聚焦滚动，不再挤破页面。 */
.table-scroll { overflow-x: auto; max-width: 100%; border: 1px solid var(--line); border-radius: var(--radius-1); }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
thead th { position: sticky; top: 0; z-index: 1; background: var(--surface-2); color: var(--ink-2); font-weight: 600; white-space: nowrap; }
th, td { border-bottom: 1px solid var(--line); padding: .55rem .6rem; text-align: left; }
tbody tr:nth-child(even) { background: #fbfcfa; }
tbody tr:hover { background: var(--brand-tint); }
td:nth-child(2), td:nth-child(3) { font-variant-numeric: tabular-nums; white-space: nowrap; }
tbody tr.subtotal { background: var(--brand-soft); font-weight: 600; }
tbody tr.subtotal:hover { background: var(--brand-soft); }
.tag { margin-left: 0.3rem; font-size: 0.8rem; color: var(--danger); }
.empty { margin: 0; padding: 1rem; background: var(--surface-2); border: 1px dashed var(--line-strong); border-radius: var(--radius-1); color: var(--ink-2); }
</style>
