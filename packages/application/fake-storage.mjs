import { BoundaryError, canonical, fields, independent, requireValue, text } from './validation.mjs';
import { decodeFacts } from './records.mjs';

const completionInput = facts => canonical(Object.fromEntries(Object.entries(facts).map(([layer, rows]) =>
  [layer, rows.map(({ note, vehicle, vehicleDetails, ...row }) => row)])));

// P3 test adapter. Replace the runtime adapter with an IndexedDB transaction in
// P5; its transaction must compare revision and replace the whole set together.
export function createMemoryBackend() {
  const entries = new Map();
  let epoch = 0;
  let nextFault = null;
  return Object.freeze({
    failNext(kind) {
      requireValue(['write', 'interrupt'].includes(kind), 'E_FORMAT', 'fault', 'Unknown fault');
      nextFault = kind;
    },
    crash() {
      epoch++;
      for (const state of entries.values()) {
        if (state.calculation.status === 'running') state.calculation = { ...state.calculation, status: 'pending', error: null };
      }
    },
    open(scope) {
      fields(scope, ['tenantId', 'profileId'], [], 'scope');
      const key = JSON.stringify([text(scope.tenantId, 'scope.tenantId'), text(scope.profileId, 'scope.profileId')]);
      if (!entries.has(key)) entries.set(key, { revision: 0, inputRevision: 0, facts: decodeFacts({ basic: [], advanced: [] }),
        derived: null, calculation: { status: 'pending', generation: 0, context: null, error: null } });
      const state = entries.get(key);
      // Phase 1 has one writer per scope (one tab), so opening an already
      // persisted scope means the previous session ended. A stored `running`
      // calculation cannot still be in flight; it returns to pending for a
      // manual retry, while the persisted facts and the last complete derived
      // result stay authoritative. crash() simulates the same interruption.
      // A real reopen in the P5 IndexedDB adapter must perform this recovery
      // before exposing the scope; see ADR-0010.
      if (state.calculation.status === 'running') {
        state.calculation = { ...state.calculation, status: 'pending', error: null };
      }
      const openedEpoch = epoch;
      const issuedTokens = new WeakSet();
      const checkOpen = () => requireValue(openedEpoch === epoch, 'E_ABORT', 'storage', 'Storage session interrupted');
      const read = () => { checkOpen(); return independent(state); };
      const same = token => issuedTokens.has(token) && state.calculation.status === 'running' &&
        canonical(state.calculation.context) === canonical(token) && state.inputRevision === token.inputRevision;
      return Object.freeze({
        read,
        async replace(expectedRevision, input, { signal, forceRecalculate = false } = {}) {
          checkOpen();
          const facts = decodeFacts(input);
          const fault = nextFault;
          nextFault = null;
          // This yield models an in-flight transaction: concurrent writers must
          // re-check revision at the commit point, after all validation/I/O.
          await Promise.resolve();
          checkOpen();
          requireValue(!signal?.aborted, 'E_ABORT', 'storage', 'Operation cancelled');
          if (fault === 'interrupt') throw new BoundaryError('E_ABORT', 'storage', 'Interrupted before commit');
          if (fault === 'write') throw new BoundaryError('E_STORAGE', 'storage', 'Write failed before commit');
          requireValue(expectedRevision === state.revision, 'E_CONFLICT', 'revision', 'Records changed; reload before retry');
          const changed = forceRecalculate || completionInput(state.facts) !== completionInput(facts);
          state.facts = facts;
          state.revision++;
          if (changed) {
            state.inputRevision++;
            state.calculation = { ...state.calculation, status: 'pending', error: null };
          }
          return read();
        },
        beginCalculation(snapshotId, algorithmVersion, onDate) {
          checkOpen();
          const generation = state.calculation.generation + 1;
          const context = independent({ inputRevision: state.inputRevision, snapshotId, algorithmVersion, onDate, generation });
          issuedTokens.add(context);
          state.calculation = { status: 'running', context, generation, error: null };
          return context;
        },
        publish(token, result) {
          checkOpen();
          if (!same(token)) return false;
          state.derived = independent({ ...result, context: token });
          state.calculation = { ...state.calculation, status: 'ready', error: null };
          return true;
        },
        fail(token, code) {
          checkOpen();
          if (!same(token)) return false;
          state.calculation = { ...state.calculation, status: 'failed', error: text(code, 'calculation.error') };
          return true;
        }
      });
    }
  });
}
