import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  classifyLoadError,
  createNetworkLoader,
  describeLoadFailure,
  resolveAssetUrl,
} from '../../src/network-loader';
import type { NetworkAsset } from '../../src/network-loader';

const sha = 'a'.repeat(64);
const asset = (url: string): NetworkAsset => ({ url, sha256: sha, sourceKind: 'real-internal-test' });

// jsdom 不实现 crypto.subtle；加载器要求 Web Crypto 可用，测试用 Node 的实现补齐。
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.unstubAllGlobals(); });

function envelope(id: string, asOf: string, through: string,
  coverageFrom: string = asOf, coverageTo: string = through) {
  return {
    kind: 'development-input' as const,
    manifest: {
      snapshot_id: id, snapshot_as_of: asOf, knowledge_through: through,
      coverage_from: coverageFrom, coverage_to: coverageTo,
    },
    dataUse: {},
    network: {
      snapshotId: id,
      snapshotAsOf: asOf,
      knowledgeThrough: through,
      stations: [],
    } as never,
  };
}

function response(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe('network-loader 纯逻辑', () => {
  test('拼接 BASE_URL 并保留绝对 URL', () => {
    expect(resolveAssetUrl('/app/', 'application-input/x.json')).toBe('/app/application-input/x.json');
    expect(resolveAssetUrl('/', '/a.json')).toBe('/a.json');
    expect(resolveAssetUrl('/app', 'https://cdn.test/a.json')).toBe('https://cdn.test/a.json');
  });

  test('错误码映射保留可重试语义与诊断文本', () => {
    const checksum = classifyLoadError(Object.assign(new Error('digest differs'), { code: 'E_CHECKSUM' }));
    expect(checksum.code).toBe('E_CHECKSUM');
    expect(checksum.retryable).toBe(true);
    const schema = classifyLoadError(Object.assign(new Error('bad schema'), { code: 'E_SCHEMA' }));
    expect(schema.code).toBe('E_SCHEMA');
    expect(schema.retryable).toBe(false);
    expect(classifyLoadError(new TypeError('offline')).code).toBe('E_NETWORK');
    expect(classifyLoadError(new Error('x'), { timedOut: true }).code).toBe('E_TIMEOUT');
    expect(describeLoadFailure('E_ASSET_MISSING')).toContain('缺失');
  });

  test('Web Crypto 不可用的两种原因文案可区分，且不提网络失败', () => {
    const insecure = describeLoadFailure('E_CRYPTO_UNAVAILABLE', 'insecure-context');
    expect(insecure).toContain('HTTPS');
    expect(insecure).toContain('http://localhost');
    expect(insecure).toContain('http://127.0.0.1');
    expect(insecure).not.toMatch(/网络连接失败|检查网络/);
    const unsupported = describeLoadFailure('E_CRYPTO_UNAVAILABLE', 'missing-crypto');
    expect(unsupported).toContain('浏览器');
    expect(unsupported).not.toMatch(/网络连接失败|检查网络/);
    expect(unsupported).not.toBe(insecure);
  });

  test('E_CRYPTO_UNAVAILABLE 透传为不可重试的环境错误，不被归成 E_SCHEMA', () => {
    const error = classifyLoadError(Object.assign(new Error('subtle unavailable'), { code: 'E_CRYPTO_UNAVAILABLE' }));
    expect(error.code).toBe('E_CRYPTO_UNAVAILABLE');
    expect(error.retryable).toBe(false);
    expect(error.message).not.toMatch(/网络连接失败|检查网络/);
  });

  test('加载成功进入 ready 并可按日期选择快照', async () => {
    const loader = createNetworkLoader({
      assets: [asset('a.json'), asset('b.json')],
      fetch: vi.fn(async (url: RequestInfo | URL) => response(String(url).includes('a.json') ? 'A' : 'B')),
      decodeEnvelope: async (text) =>
        text === 'A'
          ? (envelope('snap-a', '2026-01-01', '2026-02-01') as never)
          : (envelope('snap-b', '2026-03-01', '2026-04-01') as never),
      now: () => '2026-10-26T00:00:00.000Z',
    });
    const states: string[] = [];
    loader.subscribe((state) => states.push(state.kind));
    const state = await loader.load();
    expect(state.kind).toBe('ready');
    expect(states[0]).toBe('loading');
    if (state.kind !== 'ready') throw new Error('unreachable');
    expect(state.data.network.snapshotId).toBe('snap-b');
    expect(state.data.coverage.snapshotIds).toEqual(['snap-a', 'snap-b']);
    // Each index entry carries the declared coverage window the date control selects on.
    expect(state.data.index.entries.map(entry => [entry.coverageFrom, entry.coverageTo]))
      .toEqual([['2026-01-01', '2026-02-01'], ['2026-03-01', '2026-04-01']]);
    expect(loader.select('2026-01-15').snapshotId).toBe('snap-a');
    expect(loader.select('2026-03-15').snapshotId).toBe('snap-b');
    expect(state.loadedAt).toBe('2026-10-26T00:00:00.000Z');
  });

  test('按声明覆盖区间选择：切割日归 A，次日归 B', async () => {
    const loader = createNetworkLoader({
      assets: [asset('a.json'), asset('b.json')],
      fetch: vi.fn(async (url: RequestInfo | URL) => response(String(url).includes('a.json') ? 'A' : 'B')),
      decodeEnvelope: async (text) =>
        text === 'A'
          ? (envelope('snap-a', '2025-06-01', '2025-06-01', '1997-01-01', '2025-06-01') as never)
          : (envelope('snap-b', '2026-10-30', '2026-10-30', '2025-06-02', '2026-10-30') as never),
    });
    const state = await loader.load();
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') throw new Error('unreachable');
    expect(loader.select('2010-06-01').snapshotId).toBe('snap-a');
    expect(loader.select('2025-06-01').snapshotId).toBe('snap-a');
    expect(loader.select('2025-06-02').snapshotId).toBe('snap-b');
    expect(state.data.coverage.earliestCoverageFrom).toBe('1997-01-01');
    expect(state.data.coverage.latestCoverageTo).toBe('2026-10-30');
    expect(state.data.latest.snapshotId).toBe('snap-b');
  });

  test('资产缺失与摘要不符都不伪造数据，失败后可重试', async () => {
    const fetch = vi.fn(async () => response('missing', 404));
    const missing = createNetworkLoader({ assets: [asset('x.json')], fetch, decodeEnvelope: async () => envelope('s', '2026-01-01', '2026-02-01') as never });
    const failed = await missing.load();
    expect(failed.kind).toBe('error');
    if (failed.kind === 'error') {
      expect(failed.error.code).toBe('E_ASSET_MISSING');
      expect(failed.previous).toBeNull();
    }
    expect((await missing.retry()).kind).toBe('error');

    let attempt = 0;
    const flaky = createNetworkLoader({
      assets: [asset('x.json')],
      fetch: vi.fn(async () => response('body')),
      decodeEnvelope: async () => {
        attempt += 1;
        if (attempt === 1) throw Object.assign(new Error('digest differs'), { code: 'E_CHECKSUM' });
        return envelope('snap', '2026-01-01', '2026-02-01') as never;
      },
    });
    const first = await flaky.load();
    expect(first.kind === 'error' && first.error.code).toBe('E_CHECKSUM');
    const second = await flaky.retry();
    expect(second.kind).toBe('ready');
  });

  test('未配置资产属配置错误', () => {
    expect(() => createNetworkLoader({ assets: [] })).toThrow(/未配置/);
  });
});
