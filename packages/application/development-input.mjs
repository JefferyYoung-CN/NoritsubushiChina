import { decodeReader } from './reader.mjs';
import { BoundaryError, array, day, fields, independent, object, parseJson, requireValue, text } from './validation.mjs';
import { sha256 } from './validation.mjs';

const ATTRIBUTION = '© OpenStreetMap contributors · https://www.openstreetmap.org/copyright';

function parsed(value, field) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { throw new BoundaryError('E_FORMAT', field, 'Invalid JSON'); }
  }
  return object(value, field);
}

function checkDataUse(dataUse, manifest) {
  object(dataUse, 'dataUse');
  requireValue(dataUse.schema_version === 'noritsubushi-development-use.v1', 'E_SCHEMA', 'dataUse.schema_version', 'Unsupported data-use version');
  requireValue(dataUse.snapshot_id === manifest.snapshot_id && dataUse.snapshot_as_of === manifest.snapshot_as_of &&
    dataUse.knowledge_through === manifest.knowledge_through, 'E_SOURCE_VERSION', 'dataUse', 'Data-use identity differs from manifest');
  requireValue(dataUse.source_status === 'real-internal-test', 'E_SOURCE_STATUS', 'dataUse.source_status', 'Development input must be real-internal-test');
  requireValue(dataUse.coordinates?.coordinate_system === 'WGS-84', 'E_COORDINATE', 'dataUse.coordinates.coordinate_system', 'Expected WGS-84 coordinates');
  requireValue(dataUse.license?.name === 'ODbL-1.0', 'E_LICENSE', 'dataUse.license.name', 'Expected ODbL-1.0');
  requireValue(dataUse.attribution?.text === ATTRIBUTION, 'E_LICENSE', 'dataUse.attribution.text', 'Unexpected attribution');
  requireValue(dataUse.attribution?.placement === 'visible image footer retained in exported bitmap' &&
    dataUse.coordinates?.provider === 'OpenStreetMap' && dataUse.coordinates?.evidence_kind === 'maintainer-attested-batch' &&
    dataUse.license?.copyright_url === 'https://www.openstreetmap.org/copyright' &&
    Array.isArray(dataUse.remaining_acceptance) && dataUse.remaining_acceptance.includes('internal_test_only'),
  'E_LICENSE', 'dataUse', 'Missing source restrictions or attribution placement');
  requireValue(dataUse.release_ready === false && manifest.release_ready === false, 'E_RELEASE', 'dataUse.release_ready', 'Development input is not release-ready');
  object(dataUse.coordinates.coverage, 'dataUse.coordinates.coverage');
  object(dataUse.source_review, 'dataUse.source_review');
  requireValue(Number.isSafeInteger(dataUse.coordinates.coverage.active_stations) &&
    Number.isSafeInteger(dataUse.source_review.suspension_declarations),
  'E_FORMAT', 'dataUse', 'Expected integer source coverage');
  day(dataUse.confirmed_at, 'dataUse.confirmed_at');
  return dataUse;
}

// A permanent closure is only ever the maintainer's declaration, carried by the archived
// status column; nothing here infers one from a missing service window.
function policiesFromSuspensions(suspensions, manifest) {
  object(suspensions, 'suspensions');
  requireValue(suspensions.schema_version === 'noritsubushi-suspension-review.v1', 'E_SCHEMA', 'suspensions.schema_version', 'Unsupported suspension version');
  // Suspension declarations are bound to the same source snapshot and business
  // horizon as the manifest; otherwise this envelope would silently apply
  // another snapshot's temporary suspensions to the decoded network.
  for (const field of ['snapshot_id', 'snapshot_as_of', 'knowledge_through']) {
    requireValue(suspensions[field] === manifest[field], 'E_SOURCE_VERSION', `suspensions.${field}`,
      'Suspension identity differs from manifest');
  }
  requireValue(suspensions.source_status === 'real-supplementary-source', 'E_SOURCE_STATUS', 'suspensions.source_status',
    'Unexpected suspension source status');
  const declarations = array(suspensions.declarations, 'suspensions.declarations').map(row => ({
    ...row,
    status: text(row.status, 'suspensions.status'),
    physical_line_id: text(row.physical_line_id, 'suspensions.physical_line_id')
  }));
  for (const row of declarations) {
    requireValue(row.status === 'permanent-closure' || row.status === 'temporarily-suspended',
      'E_STATUS', 'suspensions.status', 'Unknown declaration status');
  }
  const closures = declarations.filter(row => row.status === 'permanent-closure');
  return {
    no_mileage_operators: [],
    permanent_closures: closures.map(row => ({
      physical_line_id: row.physical_line_id,
      ...(row.physical_section_ids === undefined ? {} : { physical_section_ids: row.physical_section_ids }),
      closed_from: day(row.closed_from ?? row.suspend_from, 'suspensions.closed_from')
    })),
    temporary_suspensions: declarations.filter(row => row.status !== 'permanent-closure').map(row => ({
      physical_line_id: row.physical_line_id,
      physical_section_ids: array(row.physical_section_ids ?? [], 'suspensions.physical_section_ids'),
      suspend_from: day(row.suspend_from, 'suspensions.suspend_from'),
      resume_at: row.resume_at === null ? null : day(row.resume_at, 'suspensions.resume_at')
    }))
  };
}

function supplementaryClosures(bundle, manifest) {
  if (bundle.closureReview === undefined) return [];
  const review = parsed(bundle.closureReview, 'closureReview');
  fields(review, ['schema_version', 'base_snapshot_id', 'base_reader_sha256', 'base_suspensions_sha256',
    'confirmed_at', 'decision_status', 'decision_source', 'declarations'], [], 'closureReview');
  requireValue(review.schema_version === 'noritsubushi-section-closure-review.v1' && review.decision_status === 'approved',
    'E_STATUS', 'closureReview', 'Expected approved section closure review');
  requireValue(review.base_snapshot_id === manifest.snapshot_id &&
    review.base_reader_sha256 === manifest.files['reader-payload.json'].sha256 &&
    review.base_suspensions_sha256 === manifest.files['suspensions.json'].sha256,
  'E_SOURCE_VERSION', 'closureReview', 'Review differs from verified source');
  day(review.confirmed_at, 'closureReview.confirmed_at');
  text(review.decision_source, 'closureReview.decision_source');
  const declarations = array(review.declarations, 'closureReview.declarations');
  requireValue(declarations.length > 0, 'E_STATUS', 'closureReview.declarations', 'Empty review');
  return declarations.map(row => {
    fields(row, ['physical_line_id', 'physical_section_ids', 'closed_from', 'date_basis', 'evidence'], [], 'closureReview.declaration');
    text(row.date_basis, 'closureReview.date_basis');
    text(row.evidence, 'closureReview.evidence');
    const closedOn = day(row.closed_from, 'closureReview.closed_from');
    requireValue(closedOn <= manifest.knowledge_through, 'E_SOURCE_VERSION', 'closureReview.closed_from', 'Closure exceeds verified horizon');
    return { physical_line_id: text(row.physical_line_id, 'closureReview.physical_line_id'),
      physical_section_ids: array(row.physical_section_ids, 'closureReview.physical_section_ids'), closed_from: closedOn };
  });
}

function decodeDevelopmentInput(bundle) {
  object(bundle, 'bundle');
  const manifest = parsed(bundle.manifest, 'manifest');
  requireValue(manifest.schema_version === 'noritsubushi-development-input.v1', 'E_SCHEMA', 'manifest.schema_version', 'Unsupported development input version');
  text(manifest.snapshot_id, 'manifest.snapshot_id');
  day(manifest.snapshot_as_of, 'manifest.snapshot_as_of');
  day(manifest.knowledge_through, 'manifest.knowledge_through');
  requireValue(manifest.release_ready === false, 'E_RELEASE', 'manifest.release_ready', 'Development input is not release-ready');
  // Optional only for archives built before coverage was declared; when present the
  // window must stay inside the verified knowledge horizon.
  if (manifest.coverage_from !== undefined || manifest.coverage_to !== undefined) {
    const from = day(manifest.coverage_from, 'manifest.coverage_from');
    const to = day(manifest.coverage_to, 'manifest.coverage_to');
    requireValue(from <= to && to <= manifest.knowledge_through, 'E_SOURCE_VERSION', 'manifest.coverage',
      'Coverage window must fit inside the verified knowledge horizon');
  }
  const dataUse = checkDataUse(parsed(bundle.dataUse ?? bundle['data-use.json'], 'dataUse'), manifest);
  const reader = parsed(bundle.reader ?? bundle['reader-payload.json'], 'reader');
  const suspensions = parsed(bundle.suspensions, 'suspensions');
  const policies = policiesFromSuspensions(suspensions, manifest);
  const reviewedClosures = supplementaryClosures(bundle, manifest);
  policies.permanent_closures.push(...reviewedClosures);
  const network = decodeReader(reader, { snapshotId: manifest.snapshot_id, sourceKind: dataUse.source_status,
    knowledgeThrough: manifest.knowledge_through, policies, attribution: dataUse.attribution.text,
    sourceUse: { provider: dataUse.coordinates.provider, coordinateSystem: dataUse.coordinates.coordinate_system,
      evidenceKind: dataUse.coordinates.evidence_kind, licenseName: dataUse.license.name, licenseUrl: dataUse.license.url,
      upstreamObjectVersionsKnown: false, internalTestOnly: true, remainingAcceptance: [...dataUse.remaining_acceptance] } });
  requireValue(network.snapshotAsOf === manifest.snapshot_as_of &&
    network.stations.length === dataUse.coordinates.coverage.active_stations &&
    network.policies.suspensions.length + network.policies.closures.length === dataUse.source_review.suspension_declarations + reviewedClosures.length,
  'E_SOURCE_VERSION', 'dataUse', 'Coverage or business identity differs');
  return independent({ kind: 'development-input', manifest: independent(manifest), dataUse: independent(dataUse), network });
}

export async function decodeApplicationEnvelope(input, expectedSha256) {
  text(input, 'envelope', 5 * 1024 * 1024);
  requireValue(typeof expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedSha256) &&
    await sha256(input) === expectedSha256, 'E_CHECKSUM', 'envelope', 'Envelope digest differs');
  const envelope = parseJson(input, 'envelope');
  // Check the manifest identity before the strict key set: a reduced fixture wrapped in
  // this schema must be refused as simulated, not merely as a shape mismatch.
  const envelopeManifest = parsed(envelope.manifest, 'manifest');
  requireValue(envelopeManifest.source_status !== 'simulated', 'E_SOURCE_STATUS', 'manifest.source_status',
    'Development input must be real-internal-test');
  fields(envelope, ['schema_version', 'manifest', 'dataUse', 'reader', 'suspensions', 'license'], ['closureReview'], 'envelope');
  requireValue(envelope.schema_version === 'phase1.application-input.v1', 'E_SCHEMA', 'envelope.schema_version', 'Unsupported envelope version');
  const manifest = envelopeManifest;
  const files = object(manifest.files, 'manifest.files');
  for (const [key, filename] of Object.entries({ dataUse: 'data-use.json', reader: 'reader-payload.json',
    suspensions: 'suspensions.json', license: 'LICENSE-OSM.md' })) {
    const raw = text(envelope[key], key, 4 * 1024 * 1024);
    const expected = object(files[filename], `manifest.files.${filename}`);
    requireValue(new TextEncoder().encode(raw).length === expected.bytes && await sha256(raw) === expected.sha256,
      'E_CHECKSUM', key, 'Inner file digest differs');
  }
  return decodeDevelopmentInput(envelope);
}

export { ATTRIBUTION };
