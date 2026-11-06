/**
 * network-loader 的资产加载、失败码、取消与重试（P5 收口）。
 *
 * 用注入的 fetch + decodeEnvelope 模拟四种边界：成功、404（E_ASSET_MISSING）、
 * 外部取消（E_ABORT）、失败后 retry 成功；另测未就绪时 select 必须报 E_SNAPSHOT。
 * 完全无 DOM / 网络，纯状态机。
 */
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createNetworkLoader, resolveAssetUrl } from '../../src/network-loader';
import type { NetworkAsset, NetworkLoaderOptions } from '../../src/network-loader';
import { DIGEST } from './fixtures';

beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });
afterEach(() => vi.unstubAllGlobals());

const ENVELOPE = {
  kind: 'development-input',
  manifest: {
    snapshot_id: 'snap-1',
    snapshot_as_of: '2024-01-01',
    knowledge_through: '2030-12-31',
    coverage_from: '1997-01-01',
    coverage_to: '2030-12-31',
  },
  network: {
    snapshotId: 'snap-1', snapshotAsOf: '2024-01-01', knowledgeThrough: '2030-12-31',
    stations: [], sections: [], services: [], lines: [], cities: [], operators: [], memberships: [],
  },
};

type FakeFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const okFetch: FakeFetch = async () => new Response('{"ignored":true}', { status: 200 });

function options(fetchImpl: FakeFetch, extra: Partial<NetworkLoaderOptions> = {}): NetworkLoaderOptions {
  return {
    assets: [{ url: 'input/a.json', sha256: DIGEST, sourceKind: 'real-internal-test' }],
    baseUrl: '/base',
    fetch: fetchImpl as unknown as typeof globalThis.fetch,
    decodeEnvelope: async () => ENVELOPE as never,
    now: () => '2024-06-10T00:00:00.000Z',
    timeoutMs: 5_000,
    ...extra,
  };
}

describe('resolveAssetUrl', () => {
  test('相对路径拼到 baseUrl，绝对 URL 原样保留，空 base 落到根', () => {
    expect(resolveAssetUrl('/base', 'input/a.json')).toBe('/base/input/a.json');
    expect(resolveAssetUrl('/base/', '/input/a.json')).toBe('/base/input/a.json');
    expect(resolveAssetUrl(undefined, 'input/a.json')).toBe('/input/a.json');
    expect(resolveAssetUrl('/base', 'https://example.test/a.json')).toBe('https://example.test/a.json');
  });
});

describe('createNetworkLoader', () => {
  test('成功加载进入 ready 并带资产摘要/覆盖信息', async () => {
    const loader = createNetworkLoader(options(okFetch));
    const state = await loader.load();
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.data.network.snapshotId).toBe('snap-1');
    expect(state.data.index.entries).toHaveLength(1);
    // The manifest-declared window is what the date control sees, not the as-of day alone.
    expect(state.data.coverage.earliestCoverageFrom).toBe('1997-01-01');
    expect(state.data.index.entries[0]!.coverageTo).toBe('2030-12-31');
    expect(state.loadedAt).toBe('2024-06-10T00:00:00.000Z');
    expect(loader.getState().kind).toBe('ready');
    expect(loader.select('1997-01-01').snapshotId).toBe('snap-1');
    expect(loader.select('2024-06-10').snapshotId).toBe('snap-1');
  });

  test('HTTP 404 归类为 E_ASSET_MISSING，并由清单门禁给出可诊断文案', async () => {
    const loader = createNetworkLoader(options(async () => new Response('', { status: 404 })));
    const state = await loader.load();
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.code).toBe('E_ASSET_MISSING');
    expect(state.error.retryable).toBe(true);
    expect(state.error.message).toContain('数据文件缺失');
    expect(state.previous).toBeNull();
  });

  test('外部取消归类为 E_ABORT，且不把取消当网络失败', async () => {
    const aborting: FakeFetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
    const loader = createNetworkLoader(options(aborting));
    const controller = new AbortController();
    const pending = loader.load(controller.signal);
    controller.abort();
    const state = await pending;
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.code).toBe('E_ABORT');
    expect(state.error.message).toContain('加载已取消');
  });

  test('失败后 retry 复用同一 loader 并成功', async () => {
    let calls = 0;
    const flaky: FakeFetch = async () => {
      calls += 1;
      return calls === 1 ? new Response('', { status: 404 }) : new Response('ok', { status: 200 });
    };
    const loader = createNetworkLoader(options(flaky));
    expect((await loader.load()).kind).toBe('error');
    const retried = await loader.retry();
    expect(retried.kind).toBe('ready');
    expect(calls).toBe(2);
  });

  test('未就绪时 select 抛 E_SNAPSHOT，ready 之前的错误不静默回落', () => {
    const loader = createNetworkLoader(options(okFetch));
    let code = 'NO_ERROR';
    try {
      loader.select('2024-06-10');
    } catch (error) {
      code = String((error as { code?: unknown }).code);
    }
    expect(code).toBe('E_SNAPSHOT');
  });

  test('空资产列表在构造时即拒绝（E_ASSET_MISSING）', () => {
    let code = 'NO_ERROR';
    try {
      createNetworkLoader({ assets: [], fetch: okFetch as unknown as typeof globalThis.fetch });
    } catch (error) {
      code = String((error as { code?: unknown }).code);
    }
    expect(code).toBe('E_ASSET_MISSING');
  });
});

describe('Web Crypto 能力缺失', () => {
  test('crypto.subtle 不可用时在 fetch 与解码前以 E_CRYPTO_UNAVAILABLE 失败且不可重试', async () => {
    vi.stubGlobal('crypto', {});
    const fetchImpl = vi.fn(okFetch);
    const decodeEnvelope = vi.fn(async () => ENVELOPE as never);
    const loader = createNetworkLoader(options(fetchImpl as unknown as FakeFetch, { decodeEnvelope }));
    const state = await loader.load();
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.code).toBe('E_CRYPTO_UNAVAILABLE');
    expect(state.error.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(decodeEnvelope).not.toHaveBeenCalled();
    // 环境能力缺失不可通过重试恢复：retry 仍以同一码失败，不伪装成网络错误。
    expect((await loader.retry()).kind).toBe('error');
    const retried = loader.getState();
    expect(retried.kind === 'error' && retried.error.code).toBe('E_CRYPTO_UNAVAILABLE');
  });

  test('非安全上下文提示改用 HTTPS 或本机地址，不出现网络失败字样', async () => {
    vi.stubGlobal('crypto', {});
    vi.stubGlobal('isSecureContext', false);
    const loader = createNetworkLoader(options(okFetch));
    const state = await loader.load();
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.code).toBe('E_CRYPTO_UNAVAILABLE');
    expect(state.error.message).toContain('HTTPS');
    expect(state.error.message).toContain('http://localhost');
    expect(state.error.message).toContain('http://127.0.0.1');
    expect(state.error.message).not.toMatch(/网络连接失败|检查网络/);
  });

  test('安全上下文但浏览器缺少 Web Crypto 时提示浏览器不支持，与上文文案可区分', async () => {
    vi.stubGlobal('crypto', {});
    vi.stubGlobal('isSecureContext', true);
    const loader = createNetworkLoader(options(okFetch));
    const state = await loader.load();
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.code).toBe('E_CRYPTO_UNAVAILABLE');
    expect(state.error.message).toContain('浏览器');
    expect(state.error.message).not.toContain('http://localhost');
    expect(state.error.message).not.toMatch(/网络连接失败|检查网络/);
  });

  test('真实网络失败仍归 E_NETWORK 并保留重试', async () => {
    const loader = createNetworkLoader(options(async () => { throw new TypeError('fetch failed'); }));
    const state = await loader.load();
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.code).toBe('E_NETWORK');
    expect(state.error.retryable).toBe(true);
    expect(state.error.message).toContain('网络');
  });
});

/** 用场景归档拼出与 prepare-web-assets 完全一致的 reduced 外层封套。 */
// vitest 以 apps/web 为工作目录运行，仓库根在两级之上；不要在测试里用
// import.meta.url，Vite 会把它改写成 http URL，fileURLToPath 无法处理。
const repositoryRoot = resolve(process.cwd(), '../..');
const dataRoot = process.env.NORITSU_DATA_ROOT
  ? resolve(repositoryRoot, process.env.NORITSU_DATA_ROOT)
  : resolve(repositoryRoot, 'demo');
/** 数据根下的场景目录名；演示仓默认使用合成场景。 */
const scenarioDirectory = resolve(dataRoot, 'scenarios', process.env.NORITSU_DEMO_SCENARIO ?? 'demo-reduced');

async function reducedEnvelopeText(): Promise<string> {
  const envelope: Record<string, string> = {
    schema_version: 'phase1.application-input.reduced.v1',
    manifest: await readFile(resolve(scenarioDirectory, 'manifest.json'), 'utf8'),
  };
  for (const [key, name] of Object.entries({ sourceUse: 'source-use.json', policies: 'policies.json',
    reader: 'reader-payload.json', license: 'LICENSE-OSM.md' })) {
    envelope[key] = await readFile(resolve(scenarioDirectory, name), 'utf8');
  }
  return JSON.stringify(envelope);
}

const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');

function envelopeWith(snapshotId: string): never {
  return {
    kind: 'development-input',
    manifest: { snapshot_id: snapshotId, snapshot_as_of: '2024-01-01', knowledge_through: '2030-12-31' },
    network: { ...ENVELOPE.network, snapshotId },
  } as never;
}

describe('按 sourceKind 选择解码器', () => {
  test('真实来源调用注入的完整封套解码器（拿到的正是资产文本与清单摘要）', async () => {
    const decodeEnvelope = vi.fn(async (_text: string, _sha256: string) => ENVELOPE as never);
    const loader = createNetworkLoader(options(okFetch, { decodeEnvelope }));
    const state = await loader.load();
    expect(state.kind).toBe('ready');
    expect(decodeEnvelope).toHaveBeenCalledOnce();
    expect(decodeEnvelope).toHaveBeenCalledWith('{"ignored":true}', DIGEST);
  });

  test('模拟来源改走 reduced 解码器，注入的真实解码器完全不参与', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const text = await reducedEnvelopeText();
    const decodeEnvelope = vi.fn(async () => ENVELOPE as never);
    const loader = createNetworkLoader({
      assets: [{ url: 'input/reduced.json', sha256: digestOf(text), sourceKind: 'simulated' }],
      baseUrl: '/base',
      fetch: (async () => new Response(text)) as unknown as typeof globalThis.fetch,
      decodeEnvelope,
      now: () => '2024-06-10T00:00:00.000Z',
    });
    const state = await loader.load();
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(decodeEnvelope).not.toHaveBeenCalled();
    expect(state.data.network.sourceKind).toBe('simulated');
    const manifest = JSON.parse(await readFile(resolve(scenarioDirectory, 'manifest.json'), 'utf8')) as { snapshot_id: string };
    expect(state.data.latest.snapshotId).toBe(manifest.snapshot_id);
  });
});

describe('真实条目的业务时点唯一性', () => {
  test('两条同 asOf + 同知识截止的真实条目报可诊断 E_SNAPSHOT 且信息含两个 snapshotId', async () => {
    const assets: NetworkAsset[] = [
      { url: 'input/a.json', sha256: 'a'.repeat(64), sourceKind: 'real-internal-test' },
      { url: 'input/b.json', sha256: 'b'.repeat(64), sourceKind: 'real-internal-test' },
    ];
    const decodeEnvelope = vi.fn(async (text: string) => envelopeWith(text === 'A' ? 'snap-a' : 'snap-b'));
    const loader = createNetworkLoader({
      assets,
      baseUrl: '/base',
      fetch: (async (url: string) => new Response(String(url).endsWith('a.json') ? 'A' : 'B')) as unknown as typeof globalThis.fetch,
      decodeEnvelope,
    });
    const state = await loader.load();
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.code).toBe('E_SNAPSHOT');
    expect(state.error.detail).toContain('snap-a');
    expect(state.error.detail).toContain('snap-b');
    expect(state.error.detail).toContain('同一业务时点');
  });

  test('资产缺少 sourceKind 时构造期即失败，不会静默按真实来源加载', () => {
    const missing = { url: 'input/a.json', sha256: DIGEST } as unknown as NetworkAsset;
    let code = 'NO_ERROR';
    try {
      createNetworkLoader({ assets: [missing], fetch: okFetch as unknown as typeof globalThis.fetch });
    } catch (error) {
      code = String((error as { code?: unknown }).code);
    }
    expect(code).toBe('E_ASSET_MISSING');
  });
});
