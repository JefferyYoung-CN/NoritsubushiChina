import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../fake-storage.mjs';
import { createIdbBackend } from '../idb-storage.mjs';
import { errorCode } from '../testing/fixtures.mjs';
import { recalculate } from '../completion.mjs';

const record = (id, sectionId, note = '') => ({ id, occurredOn: '2021-01-01', networkSnapshotId: 'snapshot',
  fromStationId: 'station-a', toStationId: 'station-b', serviceLineIds: ['line-1'], sectionIds: [sectionId],
  note, vehicle: '' });
const factsWith = (id = 'one', sectionId = 'section-1') => ({ basic: [record(id, sectionId)], advanced: [] });
const scope = { tenantId: 'local', profileId: 'alice' };

// 最小可控 IndexedDB：只在 Node 测试里替代浏览器实现，验证适配器的单事务读改写、
// 失败回滚与重开恢复；不证明真实浏览器的提交点与持久性。
function createFakeIndexedDB() {
  const databases = new Map();
  let nextFault = null;

  class FakeTransaction {
    constructor(db, storeNames, mode) {
      this.db = db;
      this.mode = mode;
      this.error = null;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this.overlay = new Map();
      this.requests = [];
      this.index = 0;
      this.finished = false;
      for (const name of storeNames) this.overlay.set(name, new Map(db.record.stores.get(name)));
      queueMicrotask(() => this.run());
    }

    objectStore(name) {
      return {
        get: key => this.request('get', name, key, undefined),
        put: (value, key) => this.request('put', name, key, value),
        delete: key => this.request('delete', name, key, undefined)
      };
    }

    request(kind, store, key, value) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null, kind, store, key, value };
      this.requests.push(request);
      return request;
    }

    run() {
      while (this.index < this.requests.length && !this.finished) {
        const request = this.requests[this.index++];
        const table = this.overlay.get(request.store);
        if (request.kind === 'get') {
          const value = table.get(request.key);
          request.result = value === undefined ? undefined : structuredClone(value);
          request.onsuccess?.({ target: request });
          continue;
        }
        if (nextFault) {
          const fault = nextFault;
          nextFault = null;
          request.error = { name: fault, message: 'simulated write failure' };
          request.onerror?.({ target: request });
          this.error = request.error;
          this.abort();
          return;
        }
        if (request.kind === 'put') table.set(request.key, structuredClone(request.value));
        else table.delete(request.key);
        request.result = request.key;
        request.onsuccess?.({ target: request });
      }
      if (!this.finished) this.commit();
    }

    commit() {
      this.finished = true;
      for (const [name, table] of this.overlay) this.db.record.stores.set(name, table);
      queueMicrotask(() => this.oncomplete?.());
    }

    abort() {
      if (this.finished) return;
      this.finished = true;
      queueMicrotask(() => {
        this.onerror?.();
        this.onabort?.();
      });
    }
  }

  class FakeDatabase {
    constructor(record, name) {
      this.name = name;
      this.record = record;
      this.closed = false;
      this.objectStoreNames = { contains: storeName => record.stores.has(storeName) };
    }

    createObjectStore(name) {
      if (this.record.stores.has(name)) throw new Error(`store already exists: ${name}`);
      this.record.stores.set(name, new Map());
    }

    transaction(storeNames, mode = 'readonly') {
      if (this.closed) throw new Error('database closed');
      return new FakeTransaction(this, [].concat(storeNames), mode);
    }

    close() {
      this.closed = true;
    }
  }

  return {
    failNextWrite(name = 'QuotaExceededError') {
      nextFault = name;
    },
    open(name, version = 1) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        let record = databases.get(name);
        const oldVersion = record ? record.version : 0;
        if (!record) {
          record = { version: 0, stores: new Map() };
          databases.set(name, record);
        }
        const upgrade = version > oldVersion;
        if (upgrade) record.version = version;
        const db = new FakeDatabase(record, name);
        request.result = db;
        if (upgrade) request.onupgradeneeded?.({ oldVersion, newVersion: version, target: request });
        request.onsuccess?.({ target: request });
      });
      return request;
    }
  };
}

async function contract(createBackend) {
  const backend = createBackend();
  const port = await backend.open(scope);
  const empty = port.read();
  assert.equal(empty.revision, 0);
  assert.equal(empty.inputRevision, 0);
  assert.deepEqual(empty.facts, { basic: [], advanced: [] });
  assert.equal(empty.derived, null);
  assert.throws(() => { empty.facts.basic.push(record('x', 'x')); }, TypeError);

  const first = await port.replace(empty.revision, factsWith());
  assert.equal(first.revision, 1);
  assert.equal(first.inputRevision, 1);
  assert.deepEqual(first.facts, factsWith());
  await assert.rejects(port.replace(empty.revision, factsWith('two', 'section-2')), errorCode('E_CONFLICT'));
  assert.equal(port.read().revision, 1);
  assert.deepEqual(port.read().facts, factsWith());
  const again = port.read();
  assert.notEqual(again.facts, port.read().facts);

  const profile = await backend.open({ tenantId: 'local', profileId: 'bob' });
  const tenant = await backend.open({ tenantId: 'other', profileId: 'alice' });
  assert.deepEqual(profile.read().facts, { basic: [], advanced: [] });
  assert.deepEqual(tenant.read().facts, { basic: [], advanced: [] });
  await profile.replace(0, factsWith('other', 'section-9'));
  assert.deepEqual(port.read().facts, factsWith());
  assert.equal(profile.read().facts.basic[0].id, 'other');

  const token = port.beginCalculation('snapshot', 'v1', '2021-01-01');
  assert.equal(port.read().calculation.status, 'running');
  assert.equal(port.publish(token, { overall: [{ sectionId: 'section-1' }] }), true);
  assert.equal(port.read().calculation.status, 'ready');
  assert.equal(port.read().derived.overall[0].sectionId, 'section-1');
  assert.equal(port.publish(token, { overall: [] }), false);

  const stale = port.beginCalculation('snapshot', 'v1', '2021-01-01');
  const beforeChange = port.read();
  await port.replace(beforeChange.revision, factsWith('three', 'section-3'));
  assert.equal(port.read().calculation.status, 'pending');
  assert.equal(port.read().inputRevision, beforeChange.inputRevision + 1);
  assert.equal(port.publish(stale, { overall: [] }), false);

  const controller = new AbortController();
  controller.abort();
  const current = port.read();
  await assert.rejects(port.replace(current.revision, current.facts, { signal: controller.signal }), errorCode('E_ABORT'));
  assert.equal(port.read().revision, current.revision);

  const beforeVehicle = port.read();
  const details = { model: 'A型', number: '123', formation: '12F' };
  const withVehicle = { ...beforeVehicle.facts, advanced: [{ ...record('advanced', 'section-3'), vehicleDetails: details }] };
  await port.replace(beforeVehicle.revision, withVehicle);
  const vehicleRevision = port.read().inputRevision;
  await port.replace(port.read().revision, { ...withVehicle, advanced: [{ ...withVehicle.advanced[0], vehicleDetails: { ...details, number: '456' } }] });
  assert.equal(port.read().inputRevision, vehicleRevision);
  assert.deepEqual(profile.read().facts.advanced, []);
  await backend.settled?.();
  const running = port.beginCalculation('snapshot', 'v1', '2021-01-01');
  await backend.settled?.();
  const beforeReopen = port.read();
  const reopened = await backend.open(scope);
  const recovered = reopened.read();
  assert.equal(recovered.calculation.status, 'pending');
  assert.equal(recovered.calculation.error, null);
  assert.deepEqual(recovered.facts, beforeReopen.facts);
  assert.equal(recovered.facts.advanced[0].vehicleDetails.number, '456');
  assert.deepEqual(recovered.derived, beforeReopen.derived);
  assert.equal(reopened.publish(running, { overall: [] }), false);
}

test('memory backend keeps the shared port contract', async () => {
  await contract(() => createMemoryBackend());
});

test('IndexedDB backend keeps the shared port contract', async () => {
  await contract(() => createIdbBackend({ indexedDB: createFakeIndexedDB() }));
});

test('IndexedDB replace is atomic: a failed write leaves the previous state and reopen sees it', async () => {
  const fake = createFakeIndexedDB();
  const backend = createIdbBackend({ indexedDB: fake });
  const port = await backend.open({ tenantId: 'local', profileId: 'atomic' });
  const initial = await port.replace(0, factsWith());
  fake.failNextWrite();
  await assert.rejects(port.replace(initial.revision, factsWith('two', 'section-2')), errorCode('E_STORAGE'));
  const after = port.read();
  assert.equal(after.revision, initial.revision);
  assert.deepEqual(after.facts, initial.facts);
  const reopened = await backend.open({ tenantId: 'local', profileId: 'atomic' });
  assert.equal(reopened.read().revision, 1);
  assert.deepEqual(reopened.read().facts, initial.facts);
});

test('IndexedDB open recovers running to pending, keeps facts and last derived, and fences the old handle', async () => {
  const backend = createIdbBackend({ indexedDB: createFakeIndexedDB() });
  const port = await backend.open({ tenantId: 'local', profileId: 'recover' });
  await port.replace(0, factsWith());
  const done = port.beginCalculation('snapshot', 'v1', '2021-01-01');
  assert.equal(port.publish(done, { overall: [{ sectionId: 'section-1' }] }), true);
  await backend.settled();
  const before = port.read();
  const running = port.beginCalculation('snapshot', 'v1', '2021-01-01');
  await backend.settled();
  const reopened = await backend.open({ tenantId: 'local', profileId: 'recover' });
  const recovered = reopened.read();
  assert.equal(recovered.calculation.status, 'pending');
  assert.equal(recovered.calculation.error, null);
  assert.deepEqual(recovered.facts, before.facts);
  assert.deepEqual(recovered.derived, before.derived);
  assert.equal(reopened.publish(running, { overall: [] }), false);
  assert.equal(port.publish(running, { overall: [] }), false);
  await assert.rejects(port.replace(port.read().revision, port.read().facts), errorCode('E_ABORT'));
});

test('persisted generation rejects a late publish from another backend instance', async () => {
  const fake = createFakeIndexedDB();
  const first = createIdbBackend({ indexedDB: fake });
  const firstPort = await first.open({ tenantId: 'local', profileId: 'fence' });
  await firstPort.replace(0, factsWith());
  const token = firstPort.beginCalculation('snapshot', 'v1', '2021-01-01');
  await first.settled();
  const second = createIdbBackend({ indexedDB: fake });
  const secondPort = await second.open({ tenantId: 'local', profileId: 'fence' });
  assert.equal(secondPort.publish(token, { overall: [{ sectionId: 'leak' }] }), false);
  // 同步布尔只代表旧句柄自己的判断；持久化事务仍按新 generation 拒绝落盘。
  assert.equal(firstPort.publish(token, { overall: [{ sectionId: 'leak' }] }), true);
  await assert.rejects(first.settled(), errorCode('E_ABORT'));
  assert.equal(firstPort.read().derived, null, 'failed commit restores the last durable mirror');
  assert.equal(secondPort.read().derived, null);
  assert.equal(secondPort.read().calculation.status, 'pending');
});

test('missing IndexedDB fails open with E_STORAGE instead of a raw TypeError', async () => {
  const backend = createIdbBackend({ indexedDB: null });
  await assert.rejects(backend.open({ tenantId: 'local', profileId: 'none' }), errorCode('E_STORAGE'));
});

test('calculation start durability failure rejects before compute and retains committed facts', async () => {
  const fake = createFakeIndexedDB();
  const port = await createIdbBackend({ indexedDB: fake }).open(scope);
  await port.replace(0, factsWith());
  fake.failNextWrite();
  let computed = false;
  await assert.rejects(recalculate(port, { snapshotId: 'snapshot' }, '2021-01-01', () => { computed = true; return { overall: [] }; }), errorCode('E_STORAGE'));
  assert.equal(computed, false);
  assert.equal(port.read().calculation.status, 'pending');
  assert.deepEqual(port.read().facts, factsWith());
});

test('calculation publish durability failure does not announce ready or lose the last complete result', async () => {
  const fake = createFakeIndexedDB();
  const backend = createIdbBackend({ indexedDB: fake });
  const port = await backend.open(scope);
  await port.replace(0, factsWith());
  await recalculate(port, { snapshotId: 'snapshot' }, '2021-01-01', () => ({ overall: ['previous'] }));
  const previous = port.read().derived;
  await assert.rejects(recalculate(port, { snapshotId: 'snapshot' }, '2021-01-01', () => {
    fake.failNextWrite(); return { overall: ['must-not-publish'] };
  }), errorCode('E_STORAGE'));
  assert.deepEqual(port.read().derived, previous);
  assert.equal(port.read().calculation.status, 'failed');
  const reopened = await backend.open(scope);
  assert.deepEqual(reopened.read().derived, previous);
});
