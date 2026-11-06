import { buildStatistics } from '../../../../packages/application/completion.mjs';
import type { TransitNetwork } from '../../../../packages/application/reader.mjs';
import type { DimensionCompletion } from '../../src/stats/dimensions';
import { fixtureNetwork, ON_DATE } from '../integration/fixtures';

export { ON_DATE };

export function dimensionNetwork(): TransitNetwork {
  const network = fixtureNetwork();
  const service = network.services[0];
  const member = network.memberships[0];
  return {
    ...network,
    operators: [...network.operators, { id: 'op2', cityId: null, name: '运营二' }],
    services: [service, { ...service, id: 'S2', name: '支线' }, { ...service, id: 'S3', operatorId: 'op2' }],
    sections: [...network.sections, { ...network.sections[0], id: 'unserved', lengthMetres: 5000 }],
    memberships: [
      ...network.memberships,
      { ...member, serviceId: 'S2' },
      { ...member, serviceId: 'S2', sectionId: 'sCD', sequence: 1 },
      { ...member, serviceId: 'S3' },
    ],
  };
}

export function dimensionCompletion(
  network: TransitNetwork,
  onDate = ON_DATE,
  sectionIds: readonly string[] = ['sAB'],
  stationIds: readonly string[] = ['A', 'B'],
): DimensionCompletion {
  return {
    statistics: buildStatistics(network, sectionIds, stationIds, onDate),
    overall: sectionIds.map(sectionId => ({ sectionId, firstCompletedOn: onDate })),
    stations: stationIds.map(stationId => ({ stationId, firstCompletedOn: onDate })),
  };
}
