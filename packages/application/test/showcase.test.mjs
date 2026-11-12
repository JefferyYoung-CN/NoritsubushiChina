/**
 * Showcase dataset test.
 *
 * demo-showcase/ is the richer synthetic network the public app uses to
 * demonstrate what it can do. Nothing else in the gates reads it, so this test
 * pins the shapes it exists to show: without it an edit could silently drop the
 * loop line, the branch run-in or the closing ranges, and the public demo would
 * quietly stop demonstrating them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeReducedEnvelope } from '../reduced-input.mjs';
import { sha256 } from '../validation.mjs';
import { foldedLoop } from '../folded-loop.mjs';
import { simpleCycle } from '../simple-cycle.mjs';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const showcaseRoot = join(repositoryRoot, 'demo-showcase');

async function loadNetwork() {
  const text = await fs.readFile(join(showcaseRoot, 'envelopes', 'reduced-envelope.json'), 'utf8');
  const { network } = await decodeReducedEnvelope(text, await sha256(text));
  return network;
}

const serviceSections = network => {
  const byService = new Map();
  for (const row of network.memberships) {
    if (!byService.has(row.serviceId)) byService.set(row.serviceId, new Set());
    byService.get(row.serviceId).add(row.sectionId);
  }
  return byService;
};

test('showcase envelope decodes as simulated demo data across two cities', async () => {
  const network = await loadNetwork();
  assert.equal(network.sourceKind, 'simulated');
  assert.equal(network.releaseReady, false);
  assert.equal(network.sourceUse.licenseName, 'Demo-Only-1.0');
  assert.ok(network.stations.length >= 40, 'the showcase network must be large enough to exercise the map');
  assert.ok(network.cities.length >= 2, 'two cities are needed to demonstrate city grouping');
});

test('the showcase loop unfolds and its branch shares sections with the main line', async () => {
  const network = await loadNetwork();
  const loop = network.lines.find(line => line.isLoop);
  assert.ok(loop, 'a loop line is required');
  assert.ok(loop.foldStationId, 'the loop line needs a fold station');
  // Unfolding is derived from topology, so the configured loop must really close.
  const folded = foldedLoop(network, loop.id, network.snapshotAsOf);
  assert.ok(folded, 'the loop must unfold into a station order on the snapshot date');
  assert.ok(folded.stationIds.length >= 4);

  const sectionById = new Map(network.sections.map(row => [row.id, row]));
  const loopSectionIds = new Set(folded.sections.map(row => row.id));
  const loopService = [...serviceSections(network).entries()].find(([, ids]) =>
    [...loopSectionIds].every(id => ids.has(id)));
  assert.ok(loopService, 'the loop must be operated by one service line');
  const members = network.memberships
    .filter(row => row.serviceId === loopService[0])
    .sort((left, right) => left.sequence - right.sequence)
    .map(row => sectionById.get(row.sectionId))
    .map(section => ({ sectionId: section.id, fromStationId: section.fromStationId, toStationId: section.toStationId }));
  assert.ok(simpleCycle(members), 'the loop service must be a closed simple cycle');

  const sharedSections = [...serviceSections(network).values()].some((ids, index, all) =>
    all.some((other, otherIndex) => otherIndex !== index && [...ids].some(id => other.has(id))));
  assert.ok(sharedSections, 'two service lines must share sections (branch run-in)');
  assert.ok(network.names.filter(row => network.names.filter(other => other.stationId === row.stationId).length > 1).length > 0,
    'one station must carry a rename history');
  const byName = new Map();
  for (const row of network.stations) byName.set(row.name, (byName.get(row.name) ?? 0) + 1);
  assert.ok([...byName.values()].filter(count => count > 1).length >= 3,
    'three duplicate-name groups are expected (city, operator and line set)');
  assert.ok(network.passengerPeriods.some(row => row.kind === 'non_passenger'),
    'one station must be outside passenger service');
});

test('closing ranges, missing mileage and through-running pairs are declared', async () => {
  const network = await loadNetwork();
  const { suspensions, closures, noMileageSections } = network.policies;
  assert.ok(suspensions.some(row => row.until === null), 'one suspension must still be open');
  assert.ok(suspensions.some(row => row.until !== null), 'one suspension must already have resumed');
  assert.ok(closures.length >= 2, 'a closed line and a closed section are both expected');
  assert.ok(noMileageSections.length > 0, 'one operator publishes no mileage');
  for (const id of noMileageSections) {
    const section = network.sections.find(row => row.id === id);
    assert.equal(section.lengthMetres, null, `${id} must not carry mileage`);
  }

  const mapping = JSON.parse(await fs.readFile(join(showcaseRoot, 'envelopes', 'reviewed-mapping.json'), 'utf8'));
  const entry = mapping[network.snapshotId];
  assert.ok(entry, 'the reviewed mapping must bind the showcase snapshot');
  assert.ok(entry.throughServicePairs.length >= 2, 'two through-running pairs are expected');
  const serviceIds = new Set(network.services.map(row => row.id));
  for (const pair of entry.throughServicePairs) {
    assert.equal(pair.length, 2);
    for (const id of pair) assert.ok(serviceIds.has(id), `through pair names an unknown service: ${id}`);
  }
});
