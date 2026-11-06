/**
 * 进阶链的编辑状态机（P5 S7）：起点 → 首段线路 →（简单环线的乘车方向）→ 唯一径路目标
 * → 链式继续 → 回退。
 *
 * 从 AdvancedPanel 抽出，让面板只管渲染。这里不写存储、不生成记录身份：保存只汇编
 * AdvancedRecordInput 交给会话层；日期与径路由链决定，编辑接口不接收它们。
 * 乘车方向只是界面临时状态：选定后按单向选路，不写进记录（记录只存有序区间）。
 * 每次重新选线或回退后重选都重新询问；唯一的例外是简单环线自直通续圈——同一趟车
 * 继续坐时沿用本段已选方向、不再询问（规格 §2.5）。
 * 写入状态由会话层回传，未保存的选择不触发统计重算。
 */
import { computed, ref, watch } from 'vue';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import { active } from '../../../../packages/application/validation.mjs';
import {
  appendLeg,
  chainEndStation,
  chainSummary,
  legFromResolution,
  resolveServicePaths,
  rollbackLeg,
  serviceDirections,
  startChain,
} from './chain';
import type {
  ChainDraft,
  ServiceCandidate,
  ServiceDirections,
  ServicePaths,
} from './chain';
import { continuationServices } from './continuation';
import type { ContinuationChoices } from './continuation';
import type { DirectionOption } from './directionOptions';
import type { RunDirection } from '../../../../packages/application/direction-plan.mjs';
import type { AdvancedRecordInput } from './panelTypes';
import { serviceEdges } from './serviceWalk';
import { stationOptions } from '../integration/trip';

export interface EditorProps {
  readonly network: TransitNetwork;
  readonly onDate: string;
  readonly services: readonly ServiceCandidate[];
  readonly disabled?: boolean;
  readonly throughServicePairs?: readonly (readonly [string, string])[];
}

/** 面板把 emit 包成显式回调，避免在组合式函数里猜 Vue 的 emit 重载类型。 */
export interface EditorEvents {
  readonly start: (stationId: string) => void;
  readonly continue: (serviceLineId: string) => void;
  readonly rollback: () => void;
  readonly save: (input: AdvancedRecordInput) => void;
  readonly delete: (record: { layer: 'basic' | 'advanced'; recordId: string }) => void;
}

/** 已选一段的运行方向与显示名（只供「已选线路」卡片显示）；不进入 Leg 的保存字段。 */
export interface LegDirection {
  readonly direction: RunDirection | null;
  readonly label: string | null;
}

export function useChainEditor(props: EditorProps, events: EditorEvents) {
  const originId = ref('');
  const draft = ref<ChainDraft | null>(null);
  const paths = ref<ServicePaths | null>(null);
  const choices = ref<ContinuationChoices | null>(null);
  /** 当前段待选的乘车方向（简单环线才有）；选定前不解析到站。 */
  const directions = ref<ServiceDirections | null>(null);
  const direction = ref<RunDirection | null>(null);
  /** 当前段已选（或自直通沿用）方向的显示名；只在链内临时使用。 */
  const directionLabel = ref<string | null>(null);
  /**
   * 已选各段的方向（只供「已选线路」卡片显示）。与 legs 平行、随回退截断；
   * 不进入保存记录（记录只存有序区间），因此不会泄漏到事实层。
   */
  const legDirections = ref<readonly LegDirection[]>([]);
  const error = ref<string | null>(null);
  const notice = ref<string | null>(null);

  function stationName(stationId: string): string {
    const named = props.network.names.find((row) => row.stationId === stationId && active(row, props.onDate));
    if (named) return named.name;
    const station = props.network.stations.find((row) => row.id === stationId);
    return station ? station.name : stationId;
  }

  const stations = computed(() => stationOptions(props.network, props.onDate));
  const availableServices = computed(() => {
    if (draft.value && draft.value.legs.length > 0) return [];
    const current = originId.value;
    return props.services.filter(service => serviceEdges(props.network, service.serviceLineId, props.onDate).some(edge => edge.a === current || edge.b === current));
  });
  const summary = computed(() => (draft.value ? chainSummary(props.network, draft.value) : null));
  const endStationName = computed(() => (draft.value ? stationName(chainEndStation(draft.value)) : ''));
  const busy = computed(() => Boolean(props.disabled));
  // 方向待选时不能保存：此时用户正在录这一段，保存只会落前面的段，看起来像丢了本段。
  const canSave = computed(() => Boolean(
    summary.value && summary.value.legCount > 0 && !paths.value && !directions.value,
  ) && !busy.value);
  const stepLabel = computed(() => {
    if (!draft.value) return '请选择起点站';
    if (paths.value) return '选择本段到达站';
    if (directions.value) return '选择乘车方向';
    if (draft.value.legs.length === 0) return '选择首段线路';
    // 只有确实存在可继续的直通线路时才提「继续直通」：choices 在加段后自动刷新，
    // 没有候选（含未维护直通关系）时用户只能回退或保存。
    return choices.value && choices.value.services.length > 0 ? '可继续直通、回退或保存' : '可回退或保存';
  });

  function fail(failure: unknown): void {
    error.value = failure instanceof Error ? failure.message : String(failure);
    notice.value = null;
  }

  /** 清空「线段已定、目标未定」的中间态；方向是其中一份临时状态，一并清掉。 */
  function clearStep(): void {
    paths.value = null;
    choices.value = null;
    directions.value = null;
    direction.value = null;
    directionLabel.value = null;
  }

  function chooseOrigin(): void {
    if (busy.value) return;
    clearStep();
    legDirections.value = [];
    error.value = null;
    notice.value = null;
    if (!originId.value) {
      draft.value = null;
      return;
    }
    try {
      draft.value = startChain(props.network, { onDate: props.onDate, fromStationId: originId.value });
      events.start(originId.value);
      notice.value = `已选起点「${stationName(originId.value)}」，请选择首段线路。`;
    } catch (failure) {
      draft.value = null;
      fail(failure);
    }
  }

  /**
   * 解析到站；`chosen` 是简单环线上用户已选或自直通沿用的方向，普通服务传 null。
   * `label` 是方向显示名；自直通没有渲染方向步骤，必须由候选带入（`reused`）而不是
   * 从 `directions` 选项里取。
   */
  function resolvePaths(
    service: ServiceCandidate,
    chosen: RunDirection | null,
    label: string | null = null,
    reused = false,
  ): void {
    const chain = draft.value;
    if (!chain) return;
    try {
      const resolved = resolveServicePaths(props.network, {
        onDate: chain.onDate,
        fromStationId: chainEndStation(chain),
        serviceLineId: service.serviceLineId,
        direction: chosen,
      });
      paths.value = resolved;
      direction.value = chosen;
      directionLabel.value = label;
      notice.value = chosen && label
        ? (reused
          ? `已沿用本段方向「${label}」，不再重新询问；该方向有 ${resolved.reachable.length} 个可到达站。`
          : `已选 ${label}。该方向有 ${resolved.reachable.length} 个可到达站。`)
        : `「${service.label}」当日有 ${resolved.reachable.length} 个唯一径路目标、`
          + `${resolved.ambiguous.length} 个多径路目标（不可选）。`;
    } catch (failure) {
      paths.value = null;
      fail(failure);
    }
  }

  function resolveLine(service: ServiceCandidate): void {
    const chain = draft.value;
    if (!chain) return;
    clearStep();
    error.value = null;
    try {
      // 简单环线先问方向，不预先解析到站，更不预选第一个方向。
      const offered = serviceDirections(props.network, {
        onDate: chain.onDate,
        fromStationId: chainEndStation(chain),
        serviceLineId: service.serviceLineId,
      });
      if (offered) {
        directions.value = offered;
        notice.value = `「${service.label}」当日是简单环线，请先选择乘车方向。`;
        return;
      }
      resolvePaths(service, null);
    } catch (failure) {
      fail(failure);
    }
  }

  function chooseDirection(option: DirectionOption): void {
    if (busy.value) return;
    const offered = directions.value;
    if (!offered || direction.value === option.direction) return;
    error.value = null;
    resolvePaths(offered.service, option.direction, option.label);
  }

  function chooseService(service: ServiceCandidate): void {
    if (busy.value) return;
    if (!draft.value || draft.value.legs.length > 0) return;
    resolveLine(service);
  }

  /** 加完一段后自动列出直通候选：链内唯一接续方式，无候选时由 notices 说明原因。 */
  function refreshContinuations(): void {
    const chain = draft.value;
    if (!chain || chain.legs.length === 0) {
      choices.value = null;
      return;
    }
    try {
      choices.value = continuationServices(props.network, chain, { throughServicePairs: props.throughServicePairs ?? [] });
    } catch (failure) {
      choices.value = null;
      fail(failure);
    }
  }

  function chooseContinuation(service: ServiceCandidate): void {
    if (busy.value) return;
    const chain = draft.value;
    if (!chain || chain.legs.length === 0) return;
    const allowed = continuationServices(props.network, chain, {
      throughServicePairs: props.throughServicePairs ?? [],
    }).services.find(row => row.service.serviceLineId === service.serviceLineId);
    if (!allowed) {
      fail(new Error('该线路不在当前可用的直通候选中，请重新选择。'));
      return;
    }
    events.continue(allowed.service.serviceLineId);
    clearStep();
    error.value = null;
    // 简单环线自直通：同一趟车继续坐，沿用本段已选方向，不出现方向步骤、不重新询问。
    if (allowed.selfThrough && allowed.direction) {
      resolvePaths(allowed.service, allowed.direction, allowed.directionLabel, true);
      return;
    }
    resolveLine(allowed.service);
  }

  function pickTarget(stationId: string): void {
    if (busy.value) return;
    const chain = draft.value;
    const current = paths.value;
    if (!chain || !current) return;
    try {
      const leg = legFromResolution(current, stationId);
      draft.value = appendLeg(chain, leg);
      // 方向与 legs 平行保存，只供卡片显示；回退时按新长度截断。
      legDirections.value = [...legDirections.value.slice(0, chain.legs.length),
        { direction: leg.runDirection ?? null, label: directionLabel.value }];
      clearStep();
      error.value = null;
      notice.value = `已加入一段：${stationName(leg.fromStationId)} → ${stationName(leg.toStationId)}`
        + `${leg.fromStationId === leg.toStationId ? ' · 整圈' : ''}。`;
      refreshContinuations();
    } catch (failure) {
      fail(failure);
    }
  }

  function back(): void {
    const chain = draft.value;
    if (!chain || busy.value) return;
    const result = rollbackLeg(chain);
    draft.value = result.chain;
    legDirections.value = legDirections.value.slice(0, result.chain.legs.length);
    clearStep();
    error.value = null;
    if (result.removed) {
      const service = props.services.find(row => row.serviceLineId === result.removed!.serviceLineId);
      // 回退后重新落回同一条环线时再问一次方向，不沿用刚才的选择。
      if (service) resolveLine(service);
    }
    events.rollback();
    notice.value = result.removed
      ? `已回退一段（自 ${stationName(result.removed.fromStationId)} 起），`
        + `${directions.value ? '请重新选择乘车方向' : '请重新选择本段到达站'}。`
      : '已在起点，没有可回退的段。';
    // 方向步骤待选时到站还没解析，不能同时列出上一站的直通候选（会让人以为能跳过本段）。
    if (!paths.value && !directions.value) refreshContinuations();
  }

  function clearOrigin(): void {
    if (busy.value) return;
    originId.value = '';
    chooseOrigin();
  }

  function clearLine(): void {
    if (busy.value) return;
    clearStep();
    error.value = null;
    notice.value = null;
    refreshContinuations();
  }

  function save(meta: { readonly note: string }): void {
    const current = summary.value;
    const chain = draft.value;
    if (!canSave.value || !current || !chain) {
      error.value = '请先完成至少一段再保存。';
      return;
    }
    error.value = null;
    notice.value = null;
    events.save(Object.freeze({
      occurredOn: chain.onDate,
      fromStationId: chain.originStationId,
      toStationId: chainEndStation(chain),
      serviceLineIds: current.serviceLineIds,
      sectionIds: current.sectionIds,
      lengthMetres: current.lengthMetres,
      note: meta.note,
      vehicle: '',
    }) satisfies AdvancedRecordInput);
  }

  function remove(recordId: { layer: 'basic' | 'advanced'; recordId: string }): void {
    if (!busy.value) events.delete(recordId);
  }

  watch(() => props.onDate, () => {
    draft.value = null;
    originId.value = '';
    legDirections.value = [];
    clearStep();
    error.value = null;
    notice.value = '日期已变化，链需要按新日期重新选择。';
  });

  return {
    originId,
    draft,
    paths,
    choices,
    directions,
    direction,
    legDirections,
    error,
    notice,
    stations,
    availableServices,
    summary,
    endStationName,
    busy,
    canSave,
    stepLabel,
    stationName,
    chooseOrigin,
    clearOrigin,
    clearLine,
    chooseService,
    chooseDirection,
    chooseContinuation,
    pickTarget,
    back,
    save,
    remove,
  };
}
