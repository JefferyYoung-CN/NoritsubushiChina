// Reduced (simulated) scenario envelope decoder. Kept separate from
// development-input.mjs so the real-only contract there stays untouched: this
// decoder accepts exactly `simulated` and never admits a real-internal-test claim.
// A reduced package is not a real snapshot envelope; it is a deliberate offline
// fixture whose `inherited_base_data_use` documents which real base it prunes.
import { decodeReader } from './reader.mjs';
import { BoundaryError, day, fields, independent, object, parseJson, requireValue, text } from './validation.mjs';
import { sha256 } from './validation.mjs';

const SCHEMA = 'phase1.application-input.reduced.v1';
const MANIFEST_SCHEMA = 'noritsubushi-reduced-scenario.v1';
const SIMULATED = 'simulated';
const REAL = 'real-internal-test';
// Only files that actually exist in the reduced archive are embedded. Every one
// is re-checked against its own manifest.files entry before it is trusted.
const FILES = {
  sourceUse: 'source-use.json',
  policies: 'policies.json',
  reader: 'reader-payload.json',
  license: 'LICENSE-OSM.md',
};

function parsed(value, field) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { throw new BoundaryError('E_FORMAT', field, 'Invalid JSON'); }
  }
  return object(value, field);
}

/**
 * Refuse any active source-status claim of real data. `sourceUse.inherited_base_data_use`
 * is exempt because it is lineage metadata of the real base the fixture prunes:
 * it must not be edited, and it is not the envelope's own claim about this input.
 */
function rejectRealClaims(value, path) {
  if (Array.isArray(value)) {
    value.forEach((row, index) => rejectRealClaims(row, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, row] of Object.entries(value)) {
    if (key === 'source_status' && row === REAL && !path.endsWith('inherited_base_data_use')) {
      throw new BoundaryError('E_SOURCE_STATUS', `${path}.${key}`,
        'Reduced input must be simulated; real-internal-test is not admitted here');
    }
    rejectRealClaims(row, `${path}.${key}`);
  }
}

async function verifiedFiles(envelope, manifest) {
  const files = object(manifest.files, 'manifest.files');
  const parts = {};
  for (const [key, filename] of Object.entries(FILES)) {
    const raw = text(envelope[key], key, 8 * 1024 * 1024);
    const expected = object(files[filename], `manifest.files.${filename}`);
    requireValue(new TextEncoder().encode(raw).length === expected.bytes && await sha256(raw) === expected.sha256,
      'E_CHECKSUM', key, 'Inner reduced file digest differs');
    parts[key] = raw;
  }
  return parts;
}

export async function decodeReducedEnvelope(input, expectedSha256) {
  text(input, 'envelope', 8 * 1024 * 1024);
  requireValue(typeof expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedSha256) &&
    await sha256(input) === expectedSha256, 'E_CHECKSUM', 'envelope', 'Envelope digest differs');
  const envelope = parseJson(input, 'envelope');
  requireValue(envelope.schema_version === SCHEMA, 'E_SCHEMA', 'envelope.schema_version',
    'Unsupported reduced envelope version');
  fields(envelope, ['schema_version', 'manifest', 'sourceUse', 'policies', 'reader', 'license'], [], 'envelope');
  const manifest = parsed(envelope.manifest, 'manifest');
  requireValue(manifest.schema_version === MANIFEST_SCHEMA, 'E_SCHEMA', 'manifest.schema_version',
    'Unsupported reduced scenario version');
  requireValue(manifest.source_status === SIMULATED, 'E_SOURCE_STATUS', 'manifest.source_status',
    'Reduced input must be simulated');
  requireValue(manifest.release_ready === false, 'E_RELEASE', 'manifest.release_ready',
    'Reduced input is not release-ready');
  text(manifest.snapshot_id, 'manifest.snapshot_id');
  day(manifest.snapshot_as_of, 'manifest.snapshot_as_of');
  day(manifest.knowledge_through, 'manifest.knowledge_through');
  // A reduced fixture may cover a longer business window than its single content day
  // (the content is still the day's state), but never beyond its own knowledge horizon.
  if (manifest.coverage_from !== undefined || manifest.coverage_to !== undefined) {
    const from = day(manifest.coverage_from, 'manifest.coverage_from');
    const to = day(manifest.coverage_to, 'manifest.coverage_to');
    requireValue(from <= to && to <= manifest.knowledge_through, 'E_SOURCE_VERSION', 'manifest.coverage',
      'Coverage window must fit inside the verified knowledge horizon');
  }

  const parts = await verifiedFiles(envelope, manifest);
  const sourceUse = parsed(parts.sourceUse, 'sourceUse');
  requireValue(sourceUse.source_status === SIMULATED, 'E_SOURCE_STATUS', 'sourceUse.source_status',
    'Reduced input must be simulated');
  requireValue(sourceUse.release_ready === false, 'E_RELEASE', 'sourceUse.release_ready',
    'Reduced input is not release-ready');
  const use = object(sourceUse.inherited_base_data_use, 'sourceUse.inherited_base_data_use');
  const policies = parsed(parts.policies, 'policies');
  const reader = parsed(parts.reader, 'reader');
  rejectRealClaims({ manifest, sourceUse, policies, reader }, 'reduced');

  const network = decodeReader(reader, {
    snapshotId: manifest.snapshot_id,
    sourceKind: SIMULATED,
    knowledgeThrough: manifest.knowledge_through,
    policies,
    attribution: text(use.attribution?.text, 'sourceUse.inherited_base_data_use.attribution.text'),
    sourceUse: {
      internalTestOnly: true,
      evidenceKind: 'approved-pruning-simulation',
      provider: text(use.coordinates?.provider, 'sourceUse.inherited_base_data_use.coordinates.provider'),
      coordinateSystem: text(use.coordinates?.coordinate_system,
        'sourceUse.inherited_base_data_use.coordinates.coordinate_system'),
      licenseName: text(use.license?.name, 'sourceUse.inherited_base_data_use.license.name'),
      licenseUrl: text(use.license?.url, 'sourceUse.inherited_base_data_use.license.url'),
      upstreamObjectVersionsKnown: false,
      remainingAcceptance: ['not_verified_historical_network'],
    },
  });
  requireValue(network.snapshotAsOf === manifest.snapshot_as_of, 'E_SOURCE_VERSION', 'manifest',
    'Reduced reader and manifest disagree on business identity');
  return independent({
    kind: 'reduced-input',
    manifest: independent(manifest),
    dataUse: independent({ ...use, source_status: SIMULATED, release_ready: false }),
    network,
  });
}
