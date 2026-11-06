import type { DevelopmentInput } from './development-input.mjs';
import type { ReducedInput } from './reduced-input.mjs';

/** Immutable snapshot identity used for history selection. */
export interface SnapshotDescriptor {
  readonly snapshotId: string;
  readonly snapshotAsOf: string;
  readonly knowledgeThrough: string;
  /** Inclusive first business day this package answers for. */
  readonly coverageFrom: string;
  /** Inclusive last business day this package answers for (never past knowledgeThrough). */
  readonly coverageTo: string;
}

export interface SnapshotIndex {
  readonly entries: readonly SnapshotDescriptor[];
}

export interface SnapshotSelection {
  readonly snapshotId: string;
  readonly snapshotAsOf: string;
  readonly knowledgeThrough: string;
  readonly coverageFrom: string;
  readonly coverageTo: string;
}

/** A fetched envelope paired with the digest it is expected to have. */
export interface SnapshotEnvelope {
  readonly input: string;
  readonly sha256: string;
}

export interface SnapshotCoverage {
  readonly snapshotIds: readonly string[];
  readonly earliestSnapshotAsOf: string | null;
  readonly latestKnowledgeThrough: string | null;
  /** Union of the declared windows; a gap inside it is still refused at selection. */
  readonly earliestCoverageFrom: string | null;
  readonly latestCoverageTo: string | null;
}

/** Derives a descriptor from verified input; unverified payloads are rejected. */
export function snapshotEntryOf(input: DevelopmentInput): SnapshotDescriptor;
export function snapshotEntryOfReduced(input: ReducedInput): SnapshotDescriptor;
export function createSnapshotIndex(entries: readonly SnapshotDescriptor[]): SnapshotIndex;
export function loadSnapshotEnvelopes(envelopes: readonly SnapshotEnvelope[]): Promise<SnapshotIndex>;
export function selectSnapshotByDate(index: SnapshotIndex, onDate: string): SnapshotSelection;
export function selectSnapshotById(index: SnapshotIndex, snapshotId: string): SnapshotSelection;
export function describeSnapshotCoverage(index: SnapshotIndex): SnapshotCoverage;
