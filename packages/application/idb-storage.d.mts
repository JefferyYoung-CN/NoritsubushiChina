import type { RecordFacts } from './records.mjs';
import type { CompletionResult } from './completion.mjs';
export interface CalculationContext { readonly inputRevision: number; readonly snapshotId: string; readonly algorithmVersion: string; readonly onDate: string; readonly generation: number }
export interface StorageState {
  readonly revision: number; readonly inputRevision: number; readonly facts: RecordFacts;
  readonly derived: (CompletionResult & { readonly context: CalculationContext }) | null;
  readonly calculation: { readonly status: 'pending' | 'running' | 'ready' | 'failed'; readonly generation: number; readonly context: CalculationContext | null; readonly error: string | null };
}
export interface StoragePort {
  read(): StorageState;
  replace(expectedRevision: number, input: unknown, options?: { signal?: AbortSignal; forceRecalculate?: boolean }): Promise<StorageState>;
  beginCalculation(snapshotId: string, algorithmVersion: string, onDate: string): CalculationContext;
  publish(token: CalculationContext, result: CompletionResult): boolean;
  fail(token: CalculationContext, code: string): boolean;
  settled?(): Promise<void>;
}
export function createIdbBackend(options?: { indexedDB?: IDBFactory; databaseName?: string; version?: number }): {
  open(scope: { tenantId: string; profileId: string }): Promise<StoragePort>;
  settled(): Promise<void>;
};
