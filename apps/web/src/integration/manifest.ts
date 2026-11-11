/**
 * 浏览器启动所需的资产清单。
 *
 * `tools/prepare-web-assets.mjs` 生成 `apps/web/.generated/input-asset.ts`，只带一份
 * 封套的 `url` + `sha256`。这里把生成结果归一化成加载器可消费的清单，并明确区分两类
 * 失败：清单缺失/形状不合法（E_ASSET_MISSING）与摘要不合法（E_CHECKSUM）。清单只透传
 * 生成器给出的摘要，绝不伪造或补全 sha256；缺资产时返回空清单与可诊断信息，让
 * `network-loader` 抛 E_ASSET_MISSING，而不是在运行期崩溃。
 */
export type AssetSourceKind = 'real-internal-test' | 'simulated';

export interface ApplicationAsset {
  readonly url: string;
  readonly sha256: string;
  /** 必填：决定用真实解码器还是模拟封套解码器；不设默认值。 */
  readonly sourceKind: AssetSourceKind;
}

export interface AssetManifest {
  readonly assets: readonly ApplicationAsset[];
  /** null 表示清单可用；否则是应由加载器上报的错误码。 */
  readonly errorCode: 'E_ASSET_MISSING' | 'E_CHECKSUM' | null;
  readonly message: string;
}

export const ASSET_MANIFEST_GUIDE = '未找到资产清单，请先运行 npm run prepare:assets 生成本地封套。';

const SHA256 = /^[0-9a-f]{64}$/;

const SOURCE_KINDS: readonly AssetSourceKind[] = ['real-internal-test', 'simulated'];

function isSourceKind(value: unknown): value is AssetSourceKind {
  return typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value);
}

function isAsset(value: unknown): value is { url: string; sha256: string; sourceKind: AssetSourceKind } {
  if (value === null || typeof value !== 'object') return false;
  const row = value as { url?: unknown; sha256?: unknown; sourceKind?: unknown };
  return typeof row.url === 'string' && row.url.trim().length > 0 && typeof row.sha256 === 'string' &&
    isSourceKind(row.sourceKind);
}

/** 归一化生成器产物；入参为 unknown，便于调用方在生成文件缺失时传 undefined。 */
export function resolveAssetManifest(source: unknown): AssetManifest {
  if (source === undefined || source === null) {
    return Object.freeze({ assets: Object.freeze([]), errorCode: 'E_ASSET_MISSING' as const, message: ASSET_MANIFEST_GUIDE });
  }
  const raw: unknown[] = Array.isArray(source) ? source : [source];
  const assets: ApplicationAsset[] = [];
  for (const entry of raw) {
    if (!isAsset(entry)) {
      return Object.freeze({
        assets: Object.freeze([]),
        errorCode: 'E_ASSET_MISSING' as const,
        message: '资产清单条目缺少 url、sha256 或合法的 sourceKind，已拒绝加载；请重新运行 npm run prepare:assets。',
      });
    }
    if (!SHA256.test(entry.sha256)) {
      return Object.freeze({
        assets: Object.freeze([]),
        errorCode: 'E_CHECKSUM' as const,
        message: `资产 ${entry.url} 的 sha256 不是 64 位小写十六进制，已拒绝加载。`,
      });
    }
    assets.push(Object.freeze({ url: entry.url, sha256: entry.sha256, sourceKind: entry.sourceKind }));
  }
  if (assets.length === 0) {
    return Object.freeze({ assets: Object.freeze([]), errorCode: 'E_ASSET_MISSING' as const, message: ASSET_MANIFEST_GUIDE });
  }
  return Object.freeze({ assets: Object.freeze(assets), errorCode: null, message: '' });
}

/** 加载器入口：清单不可用时给出带码的错误，避免组件把缺资产当成“空数据”。 */
export function requireAssets(manifest: AssetManifest): readonly ApplicationAsset[] {
  if (manifest.errorCode !== null || manifest.assets.length === 0) {
    const error = new Error(manifest.message || ASSET_MANIFEST_GUIDE) as Error & { code: string };
    error.code = manifest.errorCode ?? 'E_ASSET_MISSING';
    throw error;
  }
  return manifest.assets;
}
