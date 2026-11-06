/** 仅用于测试的内存事务端口；生产运行使用 idb-storage。 */
import type { StoragePort } from './idb-storage.mjs';
export function createMemoryBackend(): {
  open(scope: { tenantId: string; profileId: string }): StoragePort;
  failNext(fault: 'write' | 'interrupt'): void;
  crash(): void;
};
