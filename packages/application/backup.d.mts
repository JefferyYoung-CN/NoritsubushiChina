import type { RecordFacts } from './records.mjs';
import type { StoragePort, StorageState } from './idb-storage.mjs';
export const BACKUP_VERSION: string;
export const REPLACEMENT_WARNING: string;
export interface ImportPreview { readonly warning: string; readonly existingRecords: number; readonly incomingRecords: number; readonly expectedRevision: number }
export function encodeBackup(facts: unknown, exportedOn: string): Promise<string>;
export function decodeBackup(input: unknown): Promise<RecordFacts>;
export function prepareImport(port: StoragePort, input: unknown): Promise<ImportPreview>;
export function finishImport(port: StoragePort, preview: unknown, confirmed: boolean, options?: { signal?: AbortSignal }): Promise<{ status: 'cancelled' | 'imported'; state: StorageState }>;
