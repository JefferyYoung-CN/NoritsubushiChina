<script setup lang="ts">
import type { InputOverview } from '../input';

defineProps<{
  overview: InputOverview;
  coverage: { readonly from: string; readonly to: string } | null;
}>();
</script>

<template>
  <section class="data-panel snapshot" aria-labelledby="snapshot-title">
    <div class="panel-heading">
      <div>
        <h2 id="snapshot-title">数据快照</h2>
        <p class="section-lead">本次统计使用的数据版本与覆盖范围。</p>
      </div>
      <span class="read-only">只读预览</span>
    </div>
    <p v-if="overview.stationCount === 0" class="empty">当前数据包没有车站或区间，可重新校验数据或联系维护者核对数据范围。</p>
    <dl class="counts">
      <div><dt>车站</dt><dd>{{ overview.stationCount }}<span>站</span></dd></div>
      <div><dt>物理区间</dt><dd>{{ overview.sectionCount }}<span>段</span></dd></div>
      <div><dt>当日车次</dt><dd>{{ overview.serviceCount }}<span>条</span></dd></div>
    </dl>
    <dl class="metadata">
      <div><dt>快照版本</dt><dd>{{ overview.snapshotId }}</dd></div>
      <div><dt>快照检查日</dt><dd>{{ overview.snapshotAsOf }}</dd></div>
      <div><dt>业务知识截止日</dt><dd>{{ overview.knowledgeThrough }}</dd></div>
      <div><dt>覆盖城市</dt><dd>{{ overview.cityNames || '暂无城市数据' }}</dd></div>
      <div><dt>覆盖日期</dt><dd>{{ coverage ? `${coverage.from} 至 ${coverage.to}` : '未声明覆盖范围' }}</dd></div>
    </dl>
    <p v-if="overview.sourceKind !== 'simulated'" class="note">业务知识截止日由维护者声明，不表示已观察未来运营。来源证据为维护者批次确认，上游 OSM 对象版本未知。</p>
  </section>
</template>

<style scoped>
.snapshot { display: grid; gap: .9rem; }
.snapshot .note { padding-top: .3rem; border-top: 1px solid var(--line); font-size: .82rem; }
</style>
