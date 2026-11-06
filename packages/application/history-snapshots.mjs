// Multi-snapshot index and history-date selection. Browser-safe: no Node builtins.
// A descriptor only ever comes from a verified development input (see snapshotEntryOf);
// envelopes themselves are verified by decodeApplicationEnvelope, which is not relaxed here.
import { BoundaryError, array, day, freeze, independent, object, requireValue, text } from './validation.mjs';
import { decodeApplicationEnvelope } from './development-input.mjs';

const indexes = new WeakSet();

function descriptor(value, path) {
  object(value, path);
  const snapshotId = text(value.snapshotId, `${path}.snapshotId`);
  const snapshotAsOf = day(value.snapshotAsOf, `${path}.snapshotAsOf`);
  const knowledgeThrough = day(value.knowledgeThrough, `${path}.knowledgeThrough`);
  requireValue(snapshotAsOf <= knowledgeThrough, 'E_DATE', path,
    'Snapshot effective date is after its knowledge horizon');
  // Coverage is the inclusive business-day window a package answers for: `onDate` is
  // in range when coverageFrom <= onDate <= coverageTo. A package that predates the
  // declaration answers for its verified window (as-of through knowledge); it never
  // silently widens to an unbounded history.
  const coverageFrom = day(value.coverageFrom ?? snapshotAsOf, `${path}.coverageFrom`);
  const coverageTo = day(value.coverageTo ?? knowledgeThrough, `${path}.coverageTo`);
  requireValue(coverageFrom <= coverageTo, 'E_DATE', path, 'Coverage starts after it ends');
  requireValue(coverageTo <= knowledgeThrough, 'E_DATE', path,
    'Coverage extends beyond the verified knowledge horizon');
  return Object.freeze({ snapshotId, snapshotAsOf, knowledgeThrough, coverageFrom, coverageTo });
}

/** Read the declared window from a package manifest; absent means "undeclared". */
function declaredCoverage(manifest) {
  const from = manifest.coverage_from;
  const to = manifest.coverage_to;
  if (from === undefined && to === undefined) return {};
  requireValue(from !== undefined && to !== undefined, 'E_SOURCE_VERSION', 'input.manifest',
    'Coverage must declare both coverage_from and coverage_to');
  return { coverageFrom: from, coverageTo: to };
}

export function snapshotEntryOf(input) {
  object(input, 'input');
  requireValue(input.kind === 'development-input', 'E_SOURCE_VERSION', 'input.kind',
    'Snapshot descriptors come only from a verified development input');
  const manifest = object(input.manifest, 'input.manifest');
  const network = object(input.network, 'input.network');
  requireValue(manifest.snapshot_id === network.snapshotId &&
    manifest.snapshot_as_of === network.snapshotAsOf &&
    manifest.knowledge_through === network.knowledgeThrough,
  'E_SOURCE_VERSION', 'input.manifest', 'Snapshot identity disagrees with the verified network');
  return descriptor({
    snapshotId: network.snapshotId,
    snapshotAsOf: network.snapshotAsOf,
    knowledgeThrough: network.knowledgeThrough,
    ...declaredCoverage(manifest),
  }, 'input');
}

/** Descriptor for a decoded reduced fixture; the real-only entry rule is untouched. */
export function snapshotEntryOfReduced(input) {
  object(input, 'input');
  requireValue(input.kind === 'reduced-input', 'E_SOURCE_VERSION', 'input.kind',
    'Reduced snapshot descriptors come only from a verified reduced input');
  const network = object(input.network, 'input.network');
  requireValue(network.sourceKind === 'simulated', 'E_SOURCE_STATUS', 'input.network.sourceKind',
    'Reduced input must be simulated');
  const manifest = object(input.manifest, 'input.manifest');
  requireValue(manifest.snapshot_id === network.snapshotId &&
    manifest.snapshot_as_of === network.snapshotAsOf &&
    manifest.knowledge_through === network.knowledgeThrough,
  'E_SOURCE_VERSION', 'input.manifest', 'Reduced snapshot identity disagrees with the verified network');
  return descriptor({
    snapshotId: network.snapshotId,
    snapshotAsOf: network.snapshotAsOf,
    knowledgeThrough: network.knowledgeThrough,
    ...declaredCoverage(manifest),
  }, 'input');
}

export function createSnapshotIndex(entries) {
  array(entries, 'entries', 1000);
  const descriptors = entries.map((entry, index) => descriptor(entry, `entries[${index}]`));
  requireValue(new Set(descriptors.map(entry => entry.snapshotId)).size === descriptors.length,
    'E_DUPLICATE', 'entries', 'Duplicate snapshot identity');
  descriptors.sort((left, right) => left.coverageFrom.localeCompare(right.coverageFrom) ||
    left.snapshotId.localeCompare(right.snapshotId));
  const index = freeze({ entries: descriptors });
  indexes.add(index);
  return index;
}

function requireIndex(index) {
  requireValue(indexes.has(index), 'E_FORMAT', 'index', 'Expected an index created by createSnapshotIndex');
}

// Browser path: callers fetch each verified envelope, pair it with its digest, and decode here.
export async function loadSnapshotEnvelopes(envelopes) {
  array(envelopes, 'envelopes', 1000);
  const entries = [];
  for (const [index, envelope] of envelopes.entries()) {
    object(envelope, `envelopes[${index}]`);
    const input = text(envelope.input, `envelopes[${index}].input`, 64 * 1024 * 1024);
    const sha256 = text(envelope.sha256, `envelopes[${index}].sha256`, 64);
    entries.push(snapshotEntryOf(await decodeApplicationEnvelope(input, sha256)));
  }
  return createSnapshotIndex(entries);
}

// The one package whose declared coverage contains the statistical date. Both ends are
// inclusive; zero hits and overlapping declarations are refusals, never a silent pick.
export function selectSnapshotByDate(index, onDate) {
  requireIndex(index);
  const date = day(onDate, 'onDate');
  requireValue(index.entries.length > 0, 'E_SNAPSHOT', 'index',
    `No verified snapshot is available for ${date}`);
  const covering = index.entries.filter(entry =>
    entry.coverageFrom <= date && date <= entry.coverageTo);
  if (covering.length === 0) {
    const earliest = index.entries.map(entry => entry.coverageFrom).sort()[0];
    const latest = index.entries.map(entry => entry.coverageTo).sort().at(-1);
    throw new BoundaryError('E_SNAPSHOT', 'onDate',
      `No verified snapshot covers ${date}; declared coverage is ${earliest} 至 ${latest}`);
  }
  requireValue(covering.length === 1, 'E_SNAPSHOT', 'onDate',
    `覆盖范围重叠：${date} 同时落在 ${covering.map(entry => entry.snapshotId).join(', ')} 声明的范围内；`
    + '请修正包声明的 coverage_from/coverage_to，而不是让调用方任选一个');
  return independent(covering[0]);
}

// Pinned read for rebuilding an old version from the snapshot that produced it.
export function selectSnapshotById(index, snapshotId) {
  requireIndex(index);
  const id = text(snapshotId, 'snapshotId');
  const found = index.entries.find(entry => entry.snapshotId === id);
  requireValue(found !== undefined, 'E_SNAPSHOT', 'snapshotId',
    `Unknown snapshot ${id}; known: ${index.entries.map(entry => entry.snapshotId).join(', ') || 'none'}`);
  return independent(found);
}

export function describeSnapshotCoverage(index) {
  requireIndex(index);
  const entries = index.entries;
  const days = values => values.sort();
  return freeze({
    snapshotIds: entries.map(entry => entry.snapshotId),
    earliestSnapshotAsOf: entries.length === 0 ? null : days(entries.map(entry => entry.snapshotAsOf))[0],
    latestKnowledgeThrough: entries.length === 0 ? null : days(entries.map(entry => entry.knowledgeThrough)).at(-1),
    // Union of the declared windows: the reachable range of the date control. A gap
    // inside it is still refused by selectSnapshotByDate, not papered over here.
    earliestCoverageFrom: entries.length === 0 ? null : days(entries.map(entry => entry.coverageFrom))[0],
    latestCoverageTo: entries.length === 0 ? null : days(entries.map(entry => entry.coverageTo)).at(-1),
  });
}
