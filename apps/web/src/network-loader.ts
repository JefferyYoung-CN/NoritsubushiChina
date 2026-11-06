/**
 * 从公共静态资产加载经过校验的开发封套，并建立全网快照索引（P5 S6）。
 *
 * 数据流：fetch 静态封套文本 → `decodeApplicationEnvelope`（内部完成 sha256、
 * 封套 schema、内嵌文件摘要和 `decodeReader` 的全网校验）→ `snapshotEntryOf`
 * 生成索引 → `selectSnapshotByDate` 提供日期视图使用的快照身份。
 *
 * 边界：
 * - 只读网络与校验，不写入 IndexedDB，也不伪造缺失快照。
 * - 失败一律带稳定错误码、保持上一次成功结果可回退，并允许显式重试；
 *   不吞掉原始错误信息（只做用户可读包装，诊断细节保留在 detail）。
 * - 运行时不导入 Node 专用模块。
 */
import { decodeApplicationEnvelope } from '../../../packages/application/development-input.mjs';
import type { DevelopmentInput } from '../../../packages/application/development-input.mjs';
import { decodeReducedEnvelope } from '../../../packages/application/reduced-input.mjs';
import type { ReducedInput } from '../../../packages/application/reduced-input.mjs';
import {
  createSnapshotIndex,
  describeSnapshotCoverage,
  selectSnapshotByDate,
  snapshotEntryOf,
  snapshotEntryOfReduced,
} from '../../../packages/application/history-snapshots.mjs';
import type {
  SnapshotCoverage,
  SnapshotIndex,
  SnapshotSelection,
} from '../../../packages/application/history-snapshots.mjs';
import type { TransitNetwork } from '../../../packages/application/reader.mjs';

/** 加载失败码；UI 按码展示可诊断提示，不解析错误文本。 */
export type NetworkLoadErrorCode =
  | 'E_ASSET_MISSING'
  | 'E_CHECKSUM'
  | 'E_SCHEMA'
  | 'E_SNAPSHOT'
  | 'E_NETWORK'
  | 'E_TIMEOUT'
  | 'E_ABORT'
  | 'E_DECODE'
  | 'E_CRYPTO_UNAVAILABLE';

/** 摘要校验依赖 Web Crypto；缺失原因决定界面给出的可执行建议。 */
export type CryptoUnavailableReason = 'insecure-context' | 'missing-crypto';

/** 单个静态资产：公开 URL（相对 BASE_URL）、预期封套 sha256 与必填来源类别。 */
export interface NetworkAsset {
  readonly url: string;
  readonly sha256: string;
  readonly sourceKind: 'real-internal-test' | 'simulated';
}

/** 任一来源解码后的封套；索引按 kind 选择对应的入口校验函数。 */
export type InputEnvelope = DevelopmentInput | ReducedInput;

/** 一次成功加载得到的全部数据；索引覆盖所有已加载快照。 */
export interface LoadedNetwork {
  readonly networks: ReadonlyMap<string, TransitNetwork>;
  /** 最新知识截止的快照封套（业务默认视图）。 */
  readonly envelope: InputEnvelope;
  readonly network: TransitNetwork;
  readonly index: SnapshotIndex;
  readonly coverage: SnapshotCoverage;
  /** 默认快照身份；网络快照生效日必须被其知识截止覆盖。 */
  readonly latest: SnapshotSelection;
}

export interface NetworkLoadError {
  readonly code: NetworkLoadErrorCode;
  readonly message: string;
  /** 诊断细节（HTTP 状态、原始错误文本）；不包含凭据。 */
  readonly detail: string;
  readonly retryable: boolean;
}

export type NetworkLoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly previous: LoadedNetwork | null }
  | { readonly kind: 'ready'; readonly data: LoadedNetwork; readonly loadedAt: string }
  | {
      readonly kind: 'error';
      readonly error: NetworkLoadError;
      readonly previous: LoadedNetwork | null;
    };

export class NetworkLoaderFailure extends Error {
  readonly code: NetworkLoadErrorCode;

  constructor(code: NetworkLoadErrorCode, message: string) {
    super(message);
    this.name = 'NetworkLoaderFailure';
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const SHA256 = /^[a-f0-9]{64}$/;
const RETRYABLE: ReadonlySet<NetworkLoadErrorCode> = new Set([
  'E_NETWORK',
  'E_TIMEOUT',
  'E_ASSET_MISSING',
  'E_CHECKSUM',
]);

/** 摘要校验需要可调用的 crypto.subtle.digest；非安全上下文下浏览器不提供该接口。 */
function cryptoUnavailableReason(): CryptoUnavailableReason | null {
  const subtle = (globalThis as { crypto?: { subtle?: { digest?: unknown } } }).crypto?.subtle;
  if (typeof subtle?.digest === 'function') return null;
  return (globalThis as { isSecureContext?: boolean }).isSecureContext === false
    ? 'insecure-context'
    : 'missing-crypto';
}

/** 拼接 BASE_URL 与资产相对路径；绝对 URL 原样保留。 */
export function resolveAssetUrl(baseUrl: string | undefined, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = (baseUrl ?? '/').replace(/\/+$/, '');
  const path = url.replace(/^\/+/, '');
  return base.length === 0 ? `/${path}` : `${base}/${path}`;
}

function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** 用户可读的失败说明；默认值也明确告诉用户重试是否可行。 */
export function describeLoadFailure(
  code: NetworkLoadErrorCode,
  reason?: CryptoUnavailableReason,
): string {
  switch (code) {
    case 'E_ASSET_MISSING':
      return '数据文件缺失，可能是部署未完成；请重试或联系维护者。';
    case 'E_CHECKSUM':
      return '数据文件摘要不符，文件可能损坏或被替换；请重试。';
    case 'E_SCHEMA':
      return '数据文件未通过 schema 校验，已停止加载；请更新版本后重试。';
    case 'E_SNAPSHOT':
      return '没有覆盖所选日期的已验证快照。';
    case 'E_NETWORK':
      return '网络连接失败或服务不可达，请检查网络后重试。';
    case 'E_TIMEOUT':
      return '加载超时，请重试。';
    case 'E_ABORT':
      return '加载已取消。';
    case 'E_CRYPTO_UNAVAILABLE':
      return reason === 'insecure-context'
        ? '当前地址不允许使用浏览器加密接口，无法校验数据；请改用 HTTPS，或在本机通过 http://localhost 或 http://127.0.0.1 访问。'
        : '当前浏览器不支持数据校验所需的 Web Crypto 接口；请升级浏览器或改用其他现代浏览器后重试。';
    case 'E_DECODE':
    default:
      return '数据解析失败，请重试；若持续出现请反馈诊断信息。';
  }
}

/**
 * 把任意加载异常映射为可展示的失败对象。
 * 已知的边界错误码按类别归并；网络异常与超时保留可重试语义。
 */
export function classifyLoadError(
  error: unknown,
  context: { readonly url?: string; readonly timedOut?: boolean } = {},
): NetworkLoadError {
  if (context.timedOut) {
    return {
      code: 'E_TIMEOUT',
      message: describeLoadFailure('E_TIMEOUT'),
      detail: context.url ? `${context.url} 超时` : '请求超时',
      retryable: true,
    };
  }
  const code = errorCodeOf(error);
  const detail = error instanceof Error ? error.message : String(error);
  const passthrough: ReadonlySet<string> = new Set([
    'E_CHECKSUM',
    'E_ASSET_MISSING',
    'E_NETWORK',
    'E_TIMEOUT',
    'E_ABORT',
    'E_SNAPSHOT',
    'E_CRYPTO_UNAVAILABLE',
  ]);
  const mapped: NetworkLoadErrorCode =
    code !== null && passthrough.has(code)
      ? (code as NetworkLoadErrorCode)
      : code === 'E_DATE'
        ? 'E_SNAPSHOT'
        : code !== null && code.startsWith('E_')
          ? 'E_SCHEMA'
          : error instanceof Error && error.name === 'AbortError'
            ? 'E_ABORT'
            : error instanceof TypeError
              ? 'E_NETWORK'
              : 'E_DECODE';
  const cryptoReason = mapped === 'E_CRYPTO_UNAVAILABLE' ? cryptoUnavailableReason() ?? 'missing-crypto' : undefined;
  return {
    code: mapped,
    message: describeLoadFailure(mapped, cryptoReason),
    detail: detail.length > 0 ? detail : mapped,
    retryable: RETRYABLE.has(mapped),
  };
}

/** 把边界错误包装成带码失败，供 classifyLoadError 统一映射。 */
function failure(code: NetworkLoadErrorCode, message: string): NetworkLoaderFailure {
  return new NetworkLoaderFailure(code, message);
}

export interface NetworkLoaderOptions {
  /** 至少一个封套资产；路径与 sha256 由构建脚本产出的清单提供。 */
  readonly assets: readonly NetworkAsset[];
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** 可注入的解码器，仅测试使用；生产路径必须使用真实校验。 */
  readonly decodeEnvelope?: (input: string, sha256: string) => Promise<DevelopmentInput>;  readonly now?: () => string;
}

export interface NetworkLoader {
  getState(): NetworkLoadState;
  subscribe(listener: (state: NetworkLoadState) => void): () => void;
  /** 发起加载；重复调用复用同一进行中请求。 */
  load(signal?: AbortSignal): Promise<NetworkLoadState>;
  /** 仅在失败状态重试；成功或加载中直接返回当前状态。 */
  retry(): Promise<NetworkLoadState>;
  /** 按业务日期选择快照身份；越界时抛出边界错误（E_SNAPSHOT/E_DATE）。 */
  select(onDate: string): SnapshotSelection;
  dispose(): void;
}

async function readAssetText(
  asset: NetworkAsset,
  options: {
    readonly baseUrl?: string;
    readonly fetch: typeof globalThis.fetch;
    readonly signal: AbortSignal;
  },
): Promise<string> {
  const url = resolveAssetUrl(options.baseUrl, asset.url);
  let response: Response;
  try {
    response = await options.fetch(url, { cache: 'no-cache', signal: options.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw failure('E_ABORT', `请求已取消：${url}`);
    }
    if (error instanceof TypeError) throw failure('E_NETWORK', `无法连接：${url} (${error.message})`);
    throw error;
  }
  if (!response.ok) {
    const code: NetworkLoadErrorCode = response.status === 404 ? 'E_ASSET_MISSING' : 'E_NETWORK';
    throw failure(code, `加载 ${url} 失败：HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.trim().length === 0) throw failure('E_ASSET_MISSING', `资产为空：${url}`);
  return text;
}

export function createNetworkLoader(options: NetworkLoaderOptions): NetworkLoader {
  if (!Array.isArray(options.assets) || options.assets.length === 0) {
    throw failure('E_ASSET_MISSING', '未配置任何封套资产');
  }
  for (const asset of options.assets) {
    if (typeof asset.url !== 'string' || asset.url.trim().length === 0 || !SHA256.test(asset.sha256)) {
      throw failure('E_CHECKSUM', `资产描述无效：${String(asset?.url ?? '')}`);
    }
    if (asset.sourceKind !== 'real-internal-test' && asset.sourceKind !== 'simulated') {
      throw failure('E_ASSET_MISSING',
        `资产 ${asset.url} 缺少合法 sourceKind（real-internal-test|simulated）；请重新运行 prepare:assets`);
    }
  }
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const decodeEnvelope = options.decodeEnvelope ?? decodeApplicationEnvelope;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date().toISOString());
  const listeners = new Set<(state: NetworkLoadState) => void>();
  let state: NetworkLoadState = { kind: 'idle' };
  let inflight: Promise<NetworkLoadState> | null = null;
  let controller: AbortController | null = null;

  function emit(next: NetworkLoadState): void {
    state = next;
    for (const listener of listeners) listener(next);
  }

  async function fetchAndDecode(signal: AbortSignal): Promise<LoadedNetwork> {
    // 摘要校验依赖 Web Crypto；环境能力缺失先于网络请求给出独立诊断码，不进入 fetch/解码。
    const unavailable = cryptoUnavailableReason();
    if (unavailable !== null) {
      throw failure('E_CRYPTO_UNAVAILABLE', describeLoadFailure('E_CRYPTO_UNAVAILABLE', unavailable));
    }
    const texts = await Promise.all(
      options.assets.map((asset) => readAssetText(asset, { baseUrl: options.baseUrl, fetch: fetchImpl, signal })),
    );
    // 真实封套仍由 decodeApplicationEnvelope 校验，模拟封套只走 reduced 解码器；
    // 两条路径都不重复解码 reader，只按资产顺序校验摘要并保留完整 network。
    const envelopes = await Promise.all(
      texts.map((text, index) => {
        const asset = options.assets[index]!;
        return asset.sourceKind === 'simulated'
          ? decodeReducedEnvelope(text, asset.sha256)
          : decodeEnvelope(text, asset.sha256);
      }),
    );
    const entries = envelopes.map((envelope) =>
      (envelope.kind === 'reduced-input' ? snapshotEntryOfReduced(envelope) : snapshotEntryOf(envelope)));
    // 同一业务时点只能有一个活动真实封套；并列会让 selectSnapshotByDate 的
    // 唯一候选约束以 E_SNAPSHOT 失败，这里提前给出可诊断原因。
    const realByBusinessDay = new Map<string, string>();
    entries.forEach((entry, index) => {
      if (options.assets[index]!.sourceKind !== 'real-internal-test') return;
      const key = `${entry.snapshotAsOf}/${entry.knowledgeThrough}`;
      const previous = realByBusinessDay.get(key);
      if (previous !== undefined && previous !== entry.snapshotId) {
        throw failure('E_SNAPSHOT',
          `同一业务时点存在两个活动真实封套：${previous} 与 ${entry.snapshotId}（asOf ${entry.snapshotAsOf}，knowledgeThrough ${entry.knowledgeThrough}）；只能保留一个`);
      }
      realByBusinessDay.set(key, entry.snapshotId);
    });
    const latestEnvelope = envelopes.reduce((left, right) =>
      right.network.knowledgeThrough > left.network.knowledgeThrough ? right : left,
    );
    const index = createSnapshotIndex(entries);
    const network = latestEnvelope.network;
    const latest = selectSnapshotByDate(index, network.snapshotAsOf);
    return {
      networks: new Map(envelopes.map(envelope => [envelope.network.snapshotId, envelope.network])),
      envelope: latestEnvelope,
      network,
      index,
      coverage: describeSnapshotCoverage(index),
      latest,
    };
  }

  function previousOf(current: NetworkLoadState): LoadedNetwork | null {
    if (current.kind === 'ready') return current.data;
    if (current.kind === 'loading' || current.kind === 'error') return current.previous;
    return null;
  }

  async function load(external?: AbortSignal): Promise<NetworkLoadState> {
    if (inflight !== null) return inflight;
    const previous = previousOf(state);
    controller = new AbortController();
    const active = controller;
    let timedOut = false;
    emit({ kind: 'loading', previous });
    const abortExternal = (): void => active.abort();
    if (external?.aborted) active.abort();
    else external?.addEventListener('abort', abortExternal, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      active.abort();
    }, timeoutMs);
    const run = (async (): Promise<NetworkLoadState> => {
      try {
        const data = await fetchAndDecode(active.signal);
        const next: NetworkLoadState = { kind: 'ready', data, loadedAt: now() };
        emit(next);
        return next;
      } catch (error) {
        if (active.signal.aborted && !timedOut && error instanceof Error && error.name === 'AbortError') {
          const cancelled = classifyLoadError(error);
          const next: NetworkLoadState = { kind: 'error', error: cancelled, previous };
          emit(next);
          return next;
        }
        const mapped = classifyLoadError(error, { timedOut });
        const next: NetworkLoadState = { kind: 'error', error: mapped, previous };
        emit(next);
        return next;
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', abortExternal);
        if (controller === active) controller = null;
        inflight = null;
      }
    })();
    inflight = run;
    return run;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    async retry() {
      if (state.kind !== 'error') return state;
      return load();
    },
    select(onDate) {
      if (state.kind !== 'ready') {
        throw failure('E_SNAPSHOT', '尚未加载任何已验证快照');
      }
      return selectSnapshotByDate(state.data.index, onDate);
    },
    dispose() {
      controller?.abort();
      listeners.clear();
    },
  };
}
