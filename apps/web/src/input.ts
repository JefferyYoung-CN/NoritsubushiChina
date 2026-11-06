import { decodeApplicationEnvelope } from '@noritsubushi/application/development-input';
import { decodeReducedEnvelope } from '@noritsubushi/application/reduced-input';
import type { TransitNetwork, SourceKind } from '../../../packages/application/reader.mjs';
import { inputAssets } from '../.generated/input-asset';
import { resolveAssetManifest, requireAssets } from './integration/manifest';
import type { ApplicationAsset, AssetManifest, AssetSourceKind } from './integration/manifest';

export interface InputOverview {
  readonly snapshotId: string;
  readonly snapshotAsOf: string;
  readonly knowledgeThrough: string;
  readonly sourceKind: SourceKind;
  readonly stationCount: number;
  readonly sectionCount: number;
  readonly serviceCount: number;
  readonly cityNames: string;
  readonly attribution: string;
}

export function toOverview(network: TransitNetwork): InputOverview {
  return Object.freeze({
    snapshotId: network.snapshotId, snapshotAsOf: network.snapshotAsOf,
    knowledgeThrough: network.knowledgeThrough, sourceKind: network.sourceKind,
    stationCount: network.stations.length, sectionCount: network.sections.length,
    serviceCount: network.services.length, cityNames: network.cities.map(city => city.name).join(' / '),
    attribution: network.attribution,
  });
}

/** 生成器产物的归一化结果；App 用它构造 NetworkLoader 的资产清单。 */
export const applicationAssets: AssetManifest = resolveAssetManifest(inputAssets);

export type InputLoader = (signal: AbortSignal) => Promise<InputOverview>;

/** 按资产声明的来源选择解码器；真实/模拟两条路径互不放宽。 */
export function decoderFor(sourceKind: AssetSourceKind): (text: string, sha256: string) => Promise<{ network: TransitNetwork }> {
  return sourceKind === 'simulated' ? decodeReducedEnvelope : decodeApplicationEnvelope;
}

function missingAssetFailure(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function createInputLoader(
  asset: ApplicationAsset | undefined = applicationAssets.assets[0],
  fetchInput: typeof fetch = globalThis.fetch.bind(globalThis),
): InputLoader {
  return async signal => {
    if (asset === undefined) {
      // 清单元数据不可用时以带码错误结束，Assessments/组件据此显示 E_ASSET_MISSING 诊断。
      throw missingAssetFailure(applicationAssets.message || '未找到可加载的封套资产', 'E_ASSET_MISSING');
    }
    const response = await fetchInput(`${import.meta.env.BASE_URL}${asset.url}`, { signal, cache: 'no-cache' });
    if (!response.ok) throw missingAssetFailure('E_NETWORK', 'E_NETWORK');
    const text = await response.text();
    const { network } = await decoderFor(asset.sourceKind)(text, asset.sha256);
    signal.throwIfAborted();
    return toOverview(network);
  };
}

/** 供 App 组装 NetworkLoader；清单无效时就地抛出带码错误，由加载状态展示。 */
export function networkAssets(): readonly ApplicationAsset[] {
  return requireAssets(applicationAssets);
}

/** 可重试码与 network-loader 的 RETRYABLE 保持一致；界面层独立判断，因为 loadInput 可以注入其他加载器实现。 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['E_NETWORK', 'E_TIMEOUT', 'E_ASSET_MISSING', 'E_CHECKSUM']);

/**
 * 加载器未给出原因文案时的兜底：覆盖两种原因的可执行建议，且不指向网络排查。
 * 文案须与 network-loader.ts 的 describeLoadFailure('E_CRYPTO_UNAVAILABLE') 分支保持一致，避免两处建议漂移。
 */
const CRYPTO_UNAVAILABLE_HINT = '当前环境无法使用数据校验所需的加密接口；请改用 HTTPS，或在本机通过 http://localhost 或 http://127.0.0.1 访问；浏览器过旧时请升级或更换。';

function messageOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('message' in error)) return null;
  const message = error.message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

/**
 * 浏览器本地存储（IndexedDB）打不开时浏览器抛出的是 DOMException，没有业务码。
 * 这类失败与网络无关：若落到下面的 E_NETWORK 兜底，界面会建议用户「检查连接」，永远修不好问题。
 */
const STORAGE_UNAVAILABLE_NAMES: ReadonlySet<string> = new Set([
  'SecurityError', 'InvalidStateError', 'NotSupportedError', 'UnknownError', 'QuotaExceededError',
]);

const STORAGE_UNAVAILABLE_MESSAGE = '无法打开浏览器本地存储，记录与统计暂时不可用；请确认浏览器允许本站使用站点数据（隐私/无痕模式通常会拒绝），或在退出无痕、释放磁盘空间后点「重新加载」重试。';

/** 只拦「没有业务码的 DOMException」：带 code 的错误各自有文案，不能在这里改写。
 *  注意 DOMException 自带数字型 `code`（如 SecurityError=18），所以判据是「code 不是字符串」而不是「没有 code」。 */
function isStorageUnavailable(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  if (typeof (error as { code?: unknown }).code === 'string') return false;
  return STORAGE_UNAVAILABLE_NAMES.has(error.name);
}

export function errorFeedback(error: unknown): Readonly<{ code: string; message: string; retryable: boolean }> {
  if (isStorageUnavailable(error)) {
    return { code: 'E_STORAGE_UNAVAILABLE', retryable: true, message: STORAGE_UNAVAILABLE_MESSAGE };
  }
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : error instanceof Error && error.message === 'E_TIMEOUT' ? 'E_TIMEOUT' : 'E_NETWORK';
  if (code === 'E_CRYPTO_UNAVAILABLE') {
    // 该码的文案由加载器按「非安全上下文 / 浏览器不支持」生成，界面保留原因、只补可执行建议的兜底。
    return { code, message: messageOf(error) ?? CRYPTO_UNAVAILABLE_HINT, retryable: false };
  }
  return { code, retryable: RETRYABLE_CODES.has(code), message: code === 'E_NETWORK' ? '数据未能加载，请检查连接后重试。'
    : code === 'E_TIMEOUT' ? '加载超时，请重试。'
      : code === 'E_ASSET_MISSING' ? '未找到数据资产，请运行 npm run prepare:assets 后重试。'
        : '数据校验未通过，请重试；持续失败时请联系维护者。' };
}
