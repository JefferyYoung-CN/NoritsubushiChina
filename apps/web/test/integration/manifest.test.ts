/**
 * 资产清单 → 加载门禁（P5 收口）。
 *
 * 覆盖：清单缺省/非法形状的错误码、空资产列表的 E_ASSET_MISSING、sha256 位置与文案。
 * 这些是 network-loader 的输入边界，纯函数，无 DOM 依赖。
 */
import { describe, expect, test } from 'vitest';
import { ASSET_MANIFEST_GUIDE, requireAssets, resolveAssetManifest } from '../../src/integration/manifest';
import type { ApplicationAsset } from '../../src/integration/manifest';
import { DIGEST } from './fixtures';

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'NO_ERROR';
};

describe('resolveAssetManifest', () => {
  test('保留合法资产列表并冻结为只读', () => {
    const manifest = resolveAssetManifest({ url: 'input/a.json', sha256: DIGEST, sourceKind: 'real-internal-test' });
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]).toEqual({ url: 'input/a.json', sha256: DIGEST, sourceKind: 'real-internal-test' });
    expect(manifest.errorCode).toBeNull();
    expect(Object.isFrozen(manifest.assets)).toBe(true);
  });

  test('缺省清单不抛错，返回 E_ASSET_MISSING 与引导文案', () => {
    const manifest = resolveAssetManifest(undefined);
    expect(manifest.assets).toHaveLength(0);
    expect(manifest.errorCode).toBe('E_ASSET_MISSING');
    expect(manifest.message).toBe(ASSET_MANIFEST_GUIDE);
    expect(codeOf(() => requireAssets(manifest))).toBe('E_ASSET_MISSING');
  });

  test('条目缺 url 时整份清单拒绝（E_ASSET_MISSING）', () => {
    const manifest = resolveAssetManifest({ assets: [{ url: '  ', sha256: DIGEST, sourceKind: 'real-internal-test' }] });
    expect(manifest.assets).toHaveLength(0);
    expect(manifest.errorCode).toBe('E_ASSET_MISSING');
    expect(manifest.message).toContain('缺少 url');
  });

  test('缺 sourceKind 的条目整份清单拒绝（E_ASSET_MISSING），不设默认值', () => {
    const manifest = resolveAssetManifest({ url: 'input/a.json', sha256: DIGEST });
    expect(manifest.assets).toHaveLength(0);
    expect(manifest.errorCode).toBe('E_ASSET_MISSING');
    expect(manifest.message).toContain('sourceKind');
  });

  test('非法 sourceKind 同样拒绝（E_ASSET_MISSING）', () => {
    const manifest = resolveAssetManifest({ url: 'input/a.json', sha256: DIGEST, sourceKind: 'real' });
    expect(manifest.assets).toHaveLength(0);
    expect(manifest.errorCode).toBe('E_ASSET_MISSING');
  });

  test('摘要不是 64 位小写十六进制时拒绝（E_CHECKSUM），不伪造摘要', () => {
    const manifest = resolveAssetManifest({ url: 'input/a.json', sha256: 'ABC', sourceKind: 'real-internal-test' });
    expect(manifest.assets).toHaveLength(0);
    expect(manifest.errorCode).toBe('E_CHECKSUM');
    expect(manifest.message).toContain('sha256');
  });
});

describe('requireAssets', () => {
  test('有资产时原样返回且顺序稳定', () => {
    const assets: readonly ApplicationAsset[] = [
      { url: 'input/a.json', sha256: DIGEST, sourceKind: 'real-internal-test' },
      { url: 'input/b.json', sha256: 'b'.repeat(64), sourceKind: 'simulated' },
    ];
    expect(requireAssets({ assets, errorCode: null, message: '' })).toEqual(assets);
  });

  test('空列表即使没有 errorCode 也用统一文案抛出 E_ASSET_MISSING', () => {
    expect(codeOf(() => requireAssets({ assets: [], errorCode: null, message: '' }))).toBe('E_ASSET_MISSING');
  });
});
