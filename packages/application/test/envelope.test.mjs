/**
 * Envelope boundary test on the synthetic demo dataset.
 *
 * The public repository ships a simulated (reduced) demo envelope only; the
 * real development envelope requires a licensed data root and is verified in
 * the private workspace. Reading the data root through NORITSU_DATA_ROOT keeps
 * the same test usable against an external licensed root, defaulting to demo/.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeReducedEnvelope } from '../reduced-input.mjs';
import { sha256 } from '../validation.mjs';
import { createImageRequest } from '../image-export.mjs';
import { buildDateView } from '../date-view.mjs';
import { errorCode } from '../testing/fixtures.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dataRoot = process.env.NORITSU_DATA_ROOT
  ? resolve(repositoryRoot, process.env.NORITSU_DATA_ROOT)
  : resolve(repositoryRoot, 'demo');
const scenarioDirectory = join(dataRoot, 'scenarios', process.env.NORITSU_DEMO_SCENARIO ?? 'demo-reduced');

const ARCHIVE_FILES = ['manifest.json', 'source-use.json', 'policies.json', 'reader-payload.json', 'LICENSE-OSM.md'];
const ENVELOPE_KEYS = {
  'source-use.json': 'sourceUse', 'policies.json': 'policies',
  'reader-payload.json': 'reader', 'LICENSE-OSM.md': 'license',
};

async function archive() {
  const files = {};
  for (const name of ARCHIVE_FILES) files[name] = await fs.readFile(join(scenarioDirectory, name), 'utf8');
  return files;
}

/** Rebuild the reduced envelope exactly the way the generator and prepare script do. */
async function envelopeText() {
  const files = await archive();
  const envelope = { schema_version: 'phase1.application-input.reduced.v1', manifest: files['manifest.json'] };
  for (const [name, key] of Object.entries(ENVELOPE_KEYS)) envelope[key] = files[name];
  return JSON.stringify(envelope);
}

async function reseal(envelope) {
  const text = JSON.stringify(envelope);
  return { text, digest: await sha256(text) };
}

test('demo envelope decodes and carries the synthetic source restrictions into image export', async () => {
  const text = await envelopeText();
  const { network } = await decodeReducedEnvelope(text, await sha256(text));
  assert.equal(network.sourceKind, 'simulated');
  const manifest = JSON.parse(await fs.readFile(join(scenarioDirectory, 'manifest.json'), 'utf8'));
  assert.equal(network.snapshotId, manifest.snapshot_id);
  assert.ok(network.stations.length > 0 && network.sections.length > 0 && network.services.length > 0);
  assert.equal(network.sourceUse.internalTestOnly, true);
  assert.equal(network.sourceUse.licenseName, 'Demo-Only-1.0');
  const section = network.sections[0];
  const membership = network.memberships.find(row => row.sectionId === section.id);
  assert.ok(membership);
  const view = buildDateView(network, { serviceLineId: membership.serviceId,
    fromStationId: section.fromStationId, toStationId: section.toStationId, onDate: '2024-06-10' });
  // Bitmap export is bound to the licensed attribution text; synthetic demo data
  // must be refused instead of rendering an image without it.
  assert.throws(() => createImageRequest(view), errorCode('E_LICENSE'));
});

test('envelope digest and inner file checksum errors are located', async () => {
  const raw = await envelopeText();
  await assert.rejects(decodeReducedEnvelope(`${raw} `, await sha256(raw)), errorCode('E_CHECKSUM'));
  const changed = JSON.parse(raw);
  changed.reader += ' ';
  const { text, digest } = await reseal(changed);
  await assert.rejects(decodeReducedEnvelope(text, digest), errorCode('E_CHECKSUM'));
});

test('schema and source-status errors are located', async () => {
  const base = JSON.parse(await envelopeText());
  const wrongSchema = await reseal({ ...base, schema_version: 'phase1.application-input.future.v1' });
  await assert.rejects(decodeReducedEnvelope(wrongSchema.text, wrongSchema.digest), errorCode('E_SCHEMA'));
  const sourceUse = JSON.parse(base.sourceUse);
  sourceUse.source_status = 'real-internal-test';
  const rawSourceUse = JSON.stringify(sourceUse);
  const manifest = JSON.parse(base.manifest);
  manifest.files['source-use.json'] = { bytes: Buffer.byteLength(rawSourceUse), sha256: await sha256(rawSourceUse) };
  const resealed = await reseal({ ...base, sourceUse: rawSourceUse, manifest: JSON.stringify(manifest) });
  await assert.rejects(decodeReducedEnvelope(resealed.text, resealed.digest),
    error => error.code === 'E_SOURCE_STATUS' && error.path === 'sourceUse.source_status');
});

test('release_ready must stay false', async () => {
  const base = JSON.parse(await envelopeText());
  const manifest = { ...JSON.parse(base.manifest), release_ready: true };
  const resealed = await reseal({ ...base, manifest: JSON.stringify(manifest) });
  await assert.rejects(decodeReducedEnvelope(resealed.text, resealed.digest),
    error => error.code === 'E_RELEASE' && error.path === 'manifest.release_ready');
});

test('reader business identity must match the manifest', async () => {
  const base = JSON.parse(await envelopeText());
  const reader = JSON.parse(base.reader);
  reader.as_of = '2024-06-02';
  const rawReader = JSON.stringify(reader);
  const manifest = JSON.parse(base.manifest);
  manifest.files['reader-payload.json'] = { bytes: Buffer.byteLength(rawReader), sha256: await sha256(rawReader) };
  const resealed = await reseal({ ...base, reader: rawReader, manifest: JSON.stringify(manifest) });
  await assert.rejects(decodeReducedEnvelope(resealed.text, resealed.digest), errorCode('E_SOURCE_VERSION'));
});
