/**
 * 配额耗尽保存链路（复验 FAIL）：浏览器注入 `IDBObjectStore.prototype.put` 抛
 * QuotaExceededError 后，用户看到的是英文 "The quota has been exceeded."。
 *
 * 根因在适配器：`transact` 里 `store.put` 的同步 DOMException 不经过 tx.onerror，以原始
 * 对象冒泡（其 `code` 是数字 22，不是 E_* 字符串），所以 workspace 的 codeOf 只能得到
 * E_UNKNOWN，中文映射不生效。这里用最小 IndexedDB 假实现（jsdom 没有真实 IndexedDB）
 * 走完 workspace → records → port.replace → transact → put 的真实调用链，断言错误码、
 * 中文文案与旧事实完整性；真实浏览器事务提交仍由复验 E2E 覆盖。
 */
import { describe, expect, test } from 'vitest';
import { createWorkspace } from '../src/integration/workspace';
import type { AdvancedRecordWrite } from '../src/integration/advanced-save';

interface FakeRequest {
  result?: unknown;
  onsuccess?: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
  onerror?: (() => void) | null;
}

type Table = Map<unknown, unknown>;

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/** 只实现 idb-storage.mjs 用到的那部分：open / objectStoreNames / transaction / get / put。 */
function createQuotaIndexedDB() {
  const stores = new Map<string, Table>();
  let exhausted = false;

  class FakeTransaction {
    error: unknown = null;
    oncomplete: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    private done = false;
    private readonly snapshot: Map<string, Table> =
      new Map([...stores].map(([name, table]) => [name, new Map(table)] as const));

    objectStore(name: string): {
      get: (key: unknown) => FakeRequest;
      put: (value: unknown, key: unknown) => FakeRequest;
    } {
      return {
        get: key => {
          const table = stores.get(name);
          if (!table) throw new Error(`store missing: ${name}`);
          const request: FakeRequest = { result: clone(table.get(key)) };
          // 真实 IDB 的请求回调异步触发；适配器在同一次回调里完成 get→mutate→put。
          queueMicrotask(() => {
            try { request.onsuccess?.(); } finally { this.finish(); }
          });
          return request;
        },
        put: (value, key) => {
          // 关键路径：空间不足时 put 同步抛 DOMException，不经过 tx.onerror。
          if (exhausted) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          const table = stores.get(name);
          if (!table) throw new Error(`store missing: ${name}`);
          table.set(key, clone(value));
          return { result: key };
        },
      };
    }

    private finish(): void {
      if (this.done) return;
      this.done = true;
      queueMicrotask(() => this.oncomplete?.());
    }

    abort(): void {
      if (this.done) return;
      this.done = true;
      for (const name of [...stores.keys()]) if (!this.snapshot.has(name)) stores.delete(name);
      for (const [name, table] of this.snapshot) stores.set(name, new Map(table));
      queueMicrotask(() => {
        this.onerror?.();
        this.onabort?.();
      });
    }
  }

  class FakeDatabase {
    readonly objectStoreNames = { contains: (name: string) => stores.has(name) };
    createObjectStore(name: string): void { stores.set(name, new Map()); }
    transaction(): FakeTransaction { return new FakeTransaction(); }
    close(): void {}
  }

  return {
    /** 之后的 put 一律抛 QuotaExceededError，直到重启。 */
    exhaustQuota(): void { exhausted = true; },
    open(): FakeRequest {
      const request: FakeRequest = {};
      queueMicrotask(() => {
        request.result = new FakeDatabase();
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

const record = (id: string): AdvancedRecordWrite => ({
  id, occurredOn: '2024-05-01', networkSnapshotId: 'snapshot-2024-05-01',
  fromStationId: 'station-a', toStationId: 'station-b',
  serviceLineIds: ['service-1'], sectionIds: [`section-${id}`], note: '', vehicle: '',
});

describe('quota exhaustion through the real save path', () => {
  test('a synchronous QuotaExceededError becomes the Chinese E_STORAGE message and keeps stored facts', async () => {
    const idb = createQuotaIndexedDB();
    const workspace = createWorkspace({ indexedDB: idb as unknown as IDBFactory });
    const opened = await workspace.open();
    expect(opened.phase).toBe('ready');

    const saved = await workspace.writeAdvanced(record('rec-1'));
    expect(saved.phase).toBe('ready');

    idb.exhaustQuota();
    const failed = await workspace.writeAdvanced(record('rec-2'));

    expect(failed.phase).toBe('error');
    expect(failed.errorCode).toBe('E_STORAGE');
    expect(failed.message).toBe('本地存储写入失败，记录未保存；请检查浏览器存储空间后重试。');
    // 原始英文文案不得泄漏（用户看到的就是这条 message）。
    expect(failed.message).not.toContain('quota');
    // 旧数据完整：失败的事务回滚，新记录没有落库。
    expect(failed.snapshot?.facts.advanced.map(row => row.id)).toEqual(['rec-1']);
    expect(failed.snapshot?.revision).toBe(saved.snapshot?.revision);
    workspace.dispose();
  });
});
