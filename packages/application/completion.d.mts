import type { TransitNetwork } from './reader.mjs';
import type { MappedFact, PendingFact } from './topology-mapping.mjs';
import type { RecordFacts } from './records.mjs';
import type { StoragePort } from './idb-storage.mjs';
export interface StatMeasure {
  readonly sectionCount: number; readonly lengthMetres: number | null;
  readonly statisticsBasis: 'metres' | 'sections' | 'unavailable';
  readonly noMileageLabel: boolean; readonly mileageStatus: 'available' | 'incomplete' | 'not-provided';
}
export interface StatSummary { readonly denominator: StatMeasure; readonly completed: StatMeasure }
export interface StatisticsData {
  readonly onDate: string; readonly snapshotId: string; readonly sourceKind: string;
  readonly normal: StatSummary; readonly retired: StatSummary; readonly temporarySectionCount: number;
  readonly cities: readonly { readonly cityId: string; readonly normal: StatSummary; readonly retired: StatSummary; readonly completedStationCount: number }[];
}
export interface CompletionResult {
  readonly basic: readonly { readonly sectionId: string; readonly firstCompletedOn: string }[];
  readonly advanced: CompletionResult['basic']; readonly overall: CompletionResult['basic'];
  readonly stations: readonly { readonly stationId: string; readonly firstCompletedOn: string }[];
  readonly pending: readonly PendingFact[];
  readonly contributions: readonly { readonly recordId: string; readonly sectionIds: readonly string[] }[];
  readonly statistics: StatisticsData;
}
export function deriveCompletion(network: TransitNetwork, onDate: string, mappedFacts: readonly MappedFact[], pending: readonly PendingFact[]): CompletionResult;
export function calculateCompletion(input: unknown, network: TransitNetwork, onDate: string): CompletionResult;
export function buildStatistics(network: TransitNetwork, completedSectionIds: readonly string[], completedStationIds: readonly string[], onDate: string): StatisticsData;
export function recalculate(port: StoragePort, network: TransitNetwork, onDate: string, compute?: (facts: RecordFacts, network: TransitNetwork, onDate: string) => CompletionResult | Promise<CompletionResult>): Promise<{ status: 'published' | 'stale' }>;
