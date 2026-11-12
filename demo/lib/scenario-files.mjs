// Shared assembly for the reduced (simulated) demo scenarios.
//
// Two datasets ship in this repository: `demo/` is the small network the
// automated gates run on, and `demo-showcase/` is the richer network used to
// demonstrate the app's features. Both publish the same reduced archive, so the
// envelope assembly lives here instead of being duplicated in each generator.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeReducedEnvelope } from '../../packages/application/reduced-input.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const fileEntry = text => ({ bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) });

/** Inner archive file names, required by the reduced-envelope schema. */
const FILES = {
  sourceUse: 'source-use.json',
  policies: 'policies.json',
  reader: 'reader-payload.json',
  license: 'LICENSE-OSM.md',
};

const counts = reader => ({
  stations: reader.entities.stations.length,
  sections: reader.entities.physical_sections.length,
  services: reader.entities.service_lines.length,
});

/**
 * Assemble, self-check and write one reduced scenario archive plus its browser
 * envelope. Throws instead of writing anything the real decoder would reject.
 *
 * @param {object} input
 * @param {string} input.root absolute directory that receives `scenarios/` and `envelopes/`
 * @param {string} input.scenario scenario directory name under `scenarios/`
 * @param {string} input.snapshotId snapshot identity shared by reader and manifest
 * @param {string} input.snapshotAsOf business date of the content
 * @param {string} input.knowledgeThrough last date the dataset claims to know
 * @param {object} input.reader `phase1.transit-reader.v1` payload
 * @param {object} input.sourceUse source-use document (must stay `simulated`)
 * @param {object} input.policies closures, suspensions, no-mileage operators
 * @param {object} input.reviewedMapping per-snapshot review whitelist
 * @param {string} input.notice license/notice document stored as LICENSE-OSM.md
 */
export async function writeReducedScenario(input) {
  const { root, scenario, snapshotId, snapshotAsOf, knowledgeThrough, reader } = input;
  const files = {
    [FILES.sourceUse]: JSON.stringify(input.sourceUse, null, 2),
    [FILES.policies]: JSON.stringify(input.policies, null, 2),
    [FILES.reader]: JSON.stringify(reader, null, 2),
    [FILES.license]: input.notice,
  };
  const manifestText = JSON.stringify({
    schema_version: 'noritsubushi-reduced-scenario.v1',
    source_status: 'simulated',
    release_ready: false,
    snapshot_id: snapshotId,
    snapshot_as_of: snapshotAsOf,
    knowledge_through: knowledgeThrough,
    coverage_from: snapshotAsOf,
    coverage_to: knowledgeThrough,
    synthetic: true,
    notice: input.manifestNotice,
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, fileEntry(text)])),
  }, null, 2);

  const envelopeText = JSON.stringify({
    schema_version: 'phase1.application-input.reduced.v1',
    manifest: manifestText,
    sourceUse: files[FILES.sourceUse],
    policies: files[FILES.policies],
    reader: files[FILES.reader],
    license: files[FILES.license],
  });

  // Refuse to commit scenario data the real decoder would reject.
  const decoded = await decodeReducedEnvelope(envelopeText, sha256(envelopeText));
  const expected = counts(reader);
  const actual = {
    stations: decoded.network.stations.length,
    sections: decoded.network.sections.length,
    services: decoded.network.services.length,
  };
  if (decoded.network.snapshotId !== snapshotId ||
    Object.keys(expected).some(key => expected[key] !== actual[key])) {
    throw new Error(`Generated scenario does not decode to the intended synthetic network: ${JSON.stringify({ expected, actual })}`);
  }

  const scenarioDirectory = join(root, 'scenarios', scenario);
  const envelopeDirectory = join(root, 'envelopes');
  await mkdir(scenarioDirectory, { recursive: true });
  await mkdir(envelopeDirectory, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(scenarioDirectory, name), text);
  await writeFile(join(scenarioDirectory, 'manifest.json'), manifestText);
  await writeFile(join(envelopeDirectory, 'reduced-envelope.json'), envelopeText);
  await writeFile(join(envelopeDirectory, 'reviewed-mapping.json'), JSON.stringify(input.reviewedMapping, null, 2));

  return {
    envelopeDigest: sha256(envelopeText),
    envelopeBytes: Buffer.byteLength(envelopeText, 'utf8'),
    ...actual,
    snapshotId,
  };
}
