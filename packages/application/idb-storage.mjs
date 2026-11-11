import { BoundaryError, canonical, fields, independent, requireValue, text } from './validation.mjs';
import { decodeFacts } from './records.mjs';

/*
 * 真实 IndexedDB 存储适配器。
 *
 * 持久化结构
 * - 数据库：默认 `noritsubushi-phase1`，版本 1。
 * - 对象仓库：`scopes`，无 keyPath，使用外部键。
 * - 键：`JSON.stringify([tenantId, profileId])`，与 fake-storage.mjs 的内存键一致；
 *   调用者不能通过记录载荷指定归属，归属只来自 open(scope)。
 * - 值：`{ revision, inputRevision, facts, derived, calculation }` 一整份状态。
 *
 * 事务边界
 * - `replace` 在单个 readwrite 事务内 get → 比较 revision → put 整份状态；任何失败
 *   abort，旧记录完整保留，不会出现半套新旧记录。
 * - `open` 的 `running → pending` 恢复也在单个 readwrite 事务内完成，随后才暴露端口。
 * - `beginCalculation` / `publish` / `fail` 是同步契约（调用方不 await），
 *   因此同步返回内存判断，持久化写进入后端串行队列；调用方必须 await
 *   `port.settled()` 后才能计算或报告发布成功。失败回退至最后已提交状态并抛出。
 *   `backend.settled()` 用于后端级诊断；`replace` 等待自己的事务提交后才返回。
 *
 * 单写者限制
 * - 第一阶段一个 `(tenantId, profileId)` 同时只有一个写者（一个标签页）。打开新句柄
 *   会在后端内递增该 scope 的 epoch，旧句柄的 `replace`/`beginCalculation` 抛
 *   E_ABORT，`publish`/`fail` 返回 false；`read` 仍可返回旧快照。
 * - 多标签页并发写同一档案不支持，也没有 owner/lease。跨后端实例（两个标签页）的
 *   迟到写入由持久化 generation 拒绝，同步返回值只代表本句柄判断，不保证落盘。
 *
 * generation fencing
 * - 每次 `open` 在恢复事务里把持久化 generation +1；票据绑定 inputRevision、context
 *   和 generation，且只被创建它的句柄 WeakSet 承认。
 * - `publish`/`fail` 先做同步票据校验，持久化事务再核对持久化 generation、context
 *   和 inputRevision；任一不符就不落盘。因此旧票据在新句柄上返回 false，旧 worker
 *   的迟到写入不会覆盖新结果。
 *
 * 与 fake 的测试边界
 * - Node 测试注入最小 IndexedDB 假实现，只能证明适配器逻辑、单事务读改写和失败回滚；
 *   jsdom 无 IndexedDB，真实浏览器事务提交、真实关闭/重开与多标签页行为必须在
 *   Chromium 人工复核。fake-storage.mjs 保留为行为基线。
 *
 * 唯一与 fake 不同步的入口是 `open`：IndexedDB 的打开与恢复事务必须异步。返回端口的
 * 读写方法保留 createMemoryBackend 的签名，另提供 settled() 持久化屏障。
 */

const STORE = 'scopes';
const DATABASE_NAME = 'noritsubushi-phase1';
const DATABASE_VERSION = 1;

// 与 fake-storage.mjs:4 相同：备注/车辆不影响重算输入。
const completionInput = facts => canonical(Object.fromEntries(Object.entries(facts).map(([layer, rows]) =>
  [layer, rows.map(({ note, vehicle, vehicleDetails, ...row }) => row)])));

const initialState = () => ({
  revision: 0,
  inputRevision: 0,
  facts: decodeFacts({ basic: [], advanced: [] }),
  derived: null,
  calculation: { status: 'pending', generation: 0, context: null, error: null }
});

const storageFailure = (cause, message = 'IndexedDB transaction failed') =>
  new BoundaryError('E_STORAGE', 'storage', cause?.message ? `${message}: ${cause.message}` : message);

export function createIdbBackend(options = {}) {
  const { indexedDB = globalThis.indexedDB, databaseName = DATABASE_NAME, version = DATABASE_VERSION } = options;
  const epochs = new Map();
  const pending = new Set();
  let queue = Promise.resolve();
  let backgroundFailure = null;
  let dbPromise = null;

  function database() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        requireValue(indexedDB && typeof indexedDB.open === 'function', 'E_STORAGE', 'storage', 'IndexedDB is unavailable');
        const request = indexedDB.open(databaseName, version);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(storageFailure(request.error, 'IndexedDB open failed'));
      });
    }
    return dbPromise;
  }

  // 一个后端共享一条写队列：单写者前提下用最保守的顺序保证 generation/revision 的
  // 提交次序可推断；不同 scope 本可并行，但当前没有多写者性能需求。
  function enqueue(task, report = false) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    pending.add(run);
    run.finally(() => pending.delete(run)).catch(() => {});
    if (report) run.catch(error => { backgroundFailure = error; });
    return run;
  }

  async function drain() {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  }

  async function transact(key, mutate) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        let failure = null;
        let outcome;
        const fail = error => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const tx = db.transaction([STORE], 'readwrite');
        const store = tx.objectStore(STORE);
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };
        tx.onerror = () => fail(failure ?? storageFailure(tx.error));
        tx.onabort = () => fail(failure ?? storageFailure(tx.error, 'IndexedDB transaction aborted'));
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            const result = mutate(request.result ?? null);
            outcome = result.outcome;
            if (result.write !== undefined) store.put(result.write, key);
          } catch (error) {
            failure = error;
            try { tx.abort(); } catch { /* 事务可能已结束 */ }
          }
        };
        // 请求错误会冒泡并 abort 事务，由 tx.onerror / tx.onabort 统一映射。
        request.onerror = () => {};
      });
    } catch (error) {
      // `store.put` 的 QuotaExceededError 等是**同步** DOMException，不经过 tx.onerror，
      // 会以原始错误冒泡（其 `code` 是数字 22，不是 E_* 字符串），让英文原文直达 UI。
      // db.transaction 自身抛错同理。这里统一映射为 E_STORAGE，保留 BoundaryError 的业务码。
      throw error instanceof BoundaryError ? error : storageFailure(error);
    }
  }

  function createPort(key, state, epoch) {
    let mirror = state;
    let durable = state;
    let failure = null;
    const persist = task => enqueue(async () => {
      try { await task(); }
      catch (error) { mirror = durable; failure = error; throw error; }
    }, true);
    const issued = new WeakSet();
    const live = () => epochs.get(key) === epoch;
    const requireLive = () => requireValue(live(), 'E_ABORT', 'storage', 'Storage handle superseded by a newer open');
    const snapshot = () => independent(mirror);
    const matches = token => issued.has(token) && mirror.calculation.status === 'running' &&
      canonical(mirror.calculation.context) === canonical(token) && mirror.inputRevision === token.inputRevision;

    return Object.freeze({
      read: () => snapshot(),
      async settled() {
        await drain();
        if (failure) { const error = failure; failure = null; throw error; }
      },
      async replace(expectedRevision, input, { signal, forceRecalculate = false } = {}) {
        requireLive();
        const facts = decodeFacts(input);
        return enqueue(async () => {
          requireLive();
          requireValue(!signal?.aborted, 'E_ABORT', 'storage', 'Operation cancelled');
          const next = await transact(key, current => {
            const persisted = current ?? initialState();
            // 提交点比较：校验和 I/O 之后仍以事务内读到的 revision 为准。
            requireValue(expectedRevision === persisted.revision, 'E_CONFLICT', 'revision', 'Records changed; reload before retry');
            requireValue(!signal?.aborted, 'E_ABORT', 'storage', 'Operation cancelled');
            const changed = forceRecalculate || completionInput(persisted.facts) !== completionInput(facts);
            const calculation = changed
              ? { ...persisted.calculation, status: 'pending', error: null }
              : persisted.calculation;
            const next = { revision: persisted.revision + 1,
              inputRevision: persisted.inputRevision + (changed ? 1 : 0),
              facts, derived: persisted.derived, calculation };
            return { write: next, outcome: next };
          });
          mirror = durable = next;
          return snapshot();
        });
      },
      beginCalculation(snapshotId, algorithmVersion, onDate) {
        requireLive();
        const generation = mirror.calculation.generation + 1;
        const context = independent({ inputRevision: mirror.inputRevision, snapshotId, algorithmVersion, onDate, generation });
        issued.add(context);
        mirror = { ...mirror, calculation: { status: 'running', context, generation, error: null } };
        persist(async () => {
          if (!live()) return;
          const next = await transact(key, current => {
            const persisted = current ?? initialState();
            // 新句柄已推进持久化 generation 时，旧句柄不再写入。
            requireValue(persisted.calculation.generation < generation && persisted.inputRevision === context.inputRevision,
              'E_ABORT', 'calculation', 'Calculation context superseded');
            const next = { ...persisted, calculation: { status: 'running', context, generation, error: null } };
            return { write: next, outcome: next };
          });
          durable = next;
        }).catch(() => {});
        return context;
      },
      publish(token, result) {
        if (!live() || !matches(token)) return false;
        const derived = independent({ ...result, context: token });
        mirror = { ...mirror, derived, calculation: { ...mirror.calculation, status: 'ready', error: null } };
        persist(async () => {
          if (!live()) return;
          const next = await transact(key, current => {
            const persisted = current ?? initialState();
            if (persisted.calculation.status !== 'running' ||
                persisted.calculation.generation !== token.generation ||
                canonical(persisted.calculation.context) !== canonical(token) ||
                persisted.inputRevision !== token.inputRevision) throw new BoundaryError('E_ABORT', 'calculation', 'Calculation context superseded');
            const next = { ...persisted, derived, calculation: { ...persisted.calculation, status: 'ready', error: null } };
            return { write: next, outcome: next };
          });
          if (next) durable = next;
        }).catch(() => {});
        return true;
      },
      fail(token, code) {
        if (!live() || !matches(token)) return false;
        const error = text(code, 'calculation.error');
        mirror = { ...mirror, calculation: { ...mirror.calculation, status: 'failed', error } };
        persist(async () => {
          if (!live()) return;
          const next = await transact(key, current => {
            const persisted = current ?? initialState();
            if (persisted.calculation.status !== 'running' ||
                persisted.calculation.generation !== token.generation ||
                canonical(persisted.calculation.context) !== canonical(token) ||
                persisted.inputRevision !== token.inputRevision) return { outcome: null };
            const next = { ...persisted, calculation: { ...persisted.calculation, status: 'failed', error } };
            return { write: next, outcome: next };
          });
          if (next) durable = next;
        }).catch(() => {});
        return true;
      }
    });
  }

  return Object.freeze({
    async open(scope) {
      fields(scope, ['tenantId', 'profileId'], [], 'scope');
      const key = JSON.stringify([text(scope.tenantId, 'scope.tenantId'), text(scope.profileId, 'scope.profileId')]);
      // 先排空旧句柄已排队的写，再提升 epoch：open 之前调用的 publish/replace 仍按
      // 调用顺序提交，之后旧句柄的写才被拒绝。
      await drain();
      const epoch = (epochs.get(key) ?? 0) + 1;
      epochs.set(key, epoch);
      const state = await transact(key, current => {
        if (!current) {
          const next = initialState();
          return { write: next, outcome: next };
        }
        const calculation = {
          ...current.calculation,
          ...(current.calculation.status === 'running' ? { status: 'pending', error: null } : {}),
          // 持久化 generation 作为 fencing epoch：新句柄不承认旧句柄的票据。
          generation: current.calculation.generation + 1
        };
        const next = { ...current, calculation };
        return { write: next, outcome: next };
      });
      return createPort(key, state, epoch);
    },
    // 同步 begin/publish/fail 的持久化屏障；页面在关闭前或测试中可 await。
    async settled() {
      await drain();
      if (backgroundFailure) {
        const error = backgroundFailure;
        backgroundFailure = null;
        throw error;
      }
    }
  });
}
