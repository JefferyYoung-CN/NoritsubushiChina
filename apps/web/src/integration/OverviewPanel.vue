<script setup lang="ts">
import { ref } from 'vue';
import type { InputOverview } from '../input';

defineProps<{
  loading: boolean;
  overview: InputOverview | null;
  /** retryable 仅作为诊断数据由加载器透传，不驱动渲染；重试按钮可见性只由 code 判断（见模板），勿据此改变其他不可重试码的行为。 */
  error: { readonly code: string; readonly message: string; readonly retryable: boolean } | null;
  /** 来源提示（模拟/重建封套时为整句中文；真实封套为 null，不渲染）。 */
  notice?: string | null;
}>();
const emit = defineEmits<{ reload: [] }>();

const alertEl = ref<HTMLElement>();
const loadedEl = ref<HTMLElement>();

function focusFeedback(kind: 'error' | 'loaded'): void {
  (kind === 'error' ? alertEl.value : loadedEl.value)?.focus();
}

defineExpose({ focusFeedback });
</script>

<template>
  <!-- 加载/失败时占满一条醒目的状态卡；就绪后压成一条状态条，把首屏留给当前任务。 -->
  <section class="data-panel" :class="loading ? 'is-loading' : error ? 'is-error' : overview ? 'is-ready' : ''"
    aria-label="应用数据状态" :aria-busy="loading">
    <p v-if="loading" class="loading" role="status">
      <span class="spinner" aria-hidden="true"></span>正在加载并校验线网数据…
    </p>
    <div v-else-if="error" ref="alertEl" tabindex="-1" class="feedback error" role="alert">
      <div class="error__body">
        <h2>暂时无法读取数据</h2>
        <p>{{ error.message }}</p>
        <p class="diagnostic">诊断代码：{{ error.code }}</p>
      </div>
      <button v-if="error.code !== 'E_CRYPTO_UNAVAILABLE'" type="button" class="primary" @click="emit('reload')">重新加载</button>
    </div>
    <div v-else-if="overview" ref="loadedEl" tabindex="-1" class="loaded" aria-label="数据已就绪">
      <p role="status" class="source-label"><span class="status-dot" aria-hidden="true"></span>数据校验完成</p>
      <p v-if="overview.stationCount === 0" class="empty">当前数据包没有车站或区间，可重新加载或联系维护者核对数据范围。</p>
      <p v-if="notice" class="note envelope-notice" role="status" aria-live="polite">{{ notice }}</p>
      <button type="button" class="quiet" @click="emit('reload')">重新校验数据</button>
    </div>
  </section>
</template>
