import { active, array, day, freeze, independent, object, period, requireValue, text, unique } from './validation.mjs';

const collections = ['cities', 'operators', 'stations', 'physical_lines', 'physical_sections',
  'service_lines', 'service_line_sections', 'station_names', 'station_service_periods',
  'section_mappings', 'topology_events'];

/** Preserve classification at the validated boundary; unknown inputs stay explicit. */
function operatorCategory(row) {
  if (row.type === undefined || row.type === null) return 'unclassified';
  const kind = text(row.type, 'operators.type');
  if (kind === 'railway_bureau') return 'national';
  if (kind === 'intercity_company') return 'intercity';
  if (kind === 'metro_company' || (kind === 'other' && row.city_id !== null)) return 'urban';
  return 'unclassified';
}

function coordinate(value, maximum, path) {
  if (value === null) return null;
  requireValue((typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' &&
    Number.isFinite(Number(value)) && Math.abs(Number(value)) <= maximum,
  'E_COORDINATE', path, 'Expected finite WGS-84 coordinate');
  return Number(value);
}

function noOverlap(rows, key, path) {
  const groups = new Map();
  for (const row of rows) {
    const identity = key(row);
    const previous = groups.get(identity) ?? [];
    requireValue(previous.every(other => (row.until !== null && row.until <= other.from) ||
      (other.until !== null && other.until <= row.from)), 'E_DATE', path, 'Overlapping history');
    previous.push(row);
    groups.set(identity, previous);
  }
}

export function decodeReader(reader, context) {
  object(reader, 'reader');
  object(context, 'context');
  text(context.snapshotId, 'context.snapshotId');
  requireValue(['real-internal-test', 'real-regression', 'simulated'].includes(context.sourceKind),
    'E_SOURCE_STATUS', 'context.sourceKind', 'Unknown input kind');
  requireValue(reader.schema_version === 'phase1.transit-reader.v1', 'E_SCHEMA', 'reader.schema_version',
    'Unsupported reader version');
  requireValue(reader.snapshot_id === context.snapshotId && reader.source_status === context.sourceKind,
    'E_SOURCE_VERSION', 'reader', 'Snapshot or source kind differs');
  const snapshotAsOf = day(reader.as_of, 'reader.as_of');
  const knowledgeThrough = day(context.knowledgeThrough, 'knowledgeThrough');
  requireValue(snapshotAsOf <= knowledgeThrough, 'E_DATE', 'knowledgeThrough', 'Business horizon predates snapshot');
  const entities = object(reader.entities, 'reader.entities');
  requireValue(Object.keys(entities).length === collections.length &&
    collections.every(name => Object.hasOwn(entities, name)), 'E_FORMAT', 'reader.entities', 'Unexpected collections');
  for (const name of collections) {
    array(entities[name], `reader.entities.${name}`);
    entities[name].forEach((row, index) => object(row, `${name}[${index}]`));
  }
  const identity = (row, path) => text(row.id, `${path}.id`);
  const cities = entities.cities.map(row => ({ id: identity(row, 'cities'), name: text(row.name, 'cities.name') }));
  const operators = entities.operators.map(row => ({ id: identity(row, 'operators'),
    cityId: row.city_id === null ? null : text(row.city_id, 'operators.city_id'), name: text(row.name, 'operators.name'),
    category: operatorCategory(row) }));
  const stations = entities.stations.map(row => {
    const latitude = coordinate(row.lat, 90, 'stations.lat');
    const longitude = coordinate(row.lng, 180, 'stations.lng');
    requireValue((latitude === null) === (longitude === null), 'E_COORDINATE', 'stations', 'Unpaired coordinates');
    return { id: identity(row, 'stations'), code: text(row.station_code, 'stations.station_code'),
      name: text(row.name, 'stations.name'), cityId: text(row.city_id, 'stations.city_id'), latitude, longitude };
  });
  const lines = entities.physical_lines.map(row => {
    requireValue(typeof row.is_loop === 'boolean', 'E_FORMAT', 'physical_lines.is_loop', 'Expected boolean');
    return { id: identity(row, 'physical_lines'), name: text(row.name, 'physical_lines.name'),
      ...period(row, 'physical_lines'), isLoop: row.is_loop, foldStationId: row.loop_fold_station_id,
      directions: directions(row.direction_labels, 'physical_lines.direction_labels') };
  });
  const sections = entities.physical_sections.map(row => {
    requireValue(row.length_m === null || (Number.isSafeInteger(row.length_m) && row.length_m > 0),
      'E_MILEAGE', 'physical_sections.length_m', 'Expected positive integer metres or null');
    requireValue((row.length_m === null) === (row.length_source === null),
      'E_MILEAGE', 'physical_sections.length_source', 'Mileage and provenance differ');
    return { id: identity(row, 'physical_sections'), lineId: text(row.physical_line_id, 'physical_sections.physical_line_id'),
      fromStationId: text(row.from_station_id, 'physical_sections.from_station_id'),
      toStationId: text(row.to_station_id, 'physical_sections.to_station_id'), ...period(row, 'physical_sections'),
      lengthMetres: row.length_m, lengthSource: row.length_source === null ? null : text(row.length_source, 'length_source') };
  });
  const services = entities.service_lines.map(row => ({ id: identity(row, 'service_lines'),
    name: text(row.name, 'service_lines.name'), operatorId: text(row.operator_id, 'service_lines.operator_id'),
    ...period(row, 'service_lines'), directions: directions(row.direction_labels, 'service_lines.direction_labels') }));
  const memberships = entities.service_line_sections.map(row => {
    requireValue(Number.isSafeInteger(row.seq) && row.seq >= 0, 'E_FORMAT', 'service_line_sections.seq', 'Invalid sequence');
    return { serviceId: text(row.service_line_id, 'service_line_sections.service_line_id'),
      sectionId: text(row.physical_section_id, 'service_line_sections.physical_section_id'),
      sequence: row.seq, ...period(row, 'service_line_sections') };
  });
  const names = entities.station_names.map(row => ({ stationId: text(row.station_id, 'station_names.station_id'),
    name: text(row.name, 'station_names.name'), ...period(row, 'station_names') }));
  const passengerPeriods = entities.station_service_periods.map(row => {
    requireValue(['passenger', 'non_passenger'].includes(row.kind), 'E_FORMAT', 'station_service_periods.kind', 'Unknown service kind');
    return { stationId: text(row.station_id, 'station_service_periods.station_id'), kind: row.kind,
      ...period(row, 'station_service_periods') };
  });
  const events = entities.topology_events.map(row => {
    const payload = object(row.payload, 'topology_events.payload');
    requireValue(Object.keys(payload).every(key => ['range', 'note', 'abolished_section_ids'].includes(key)),
      'E_FORMAT', 'topology_events.payload', 'Unsupported event payload');
    return { id: identity(row, 'topology_events'), effectiveOn: day(row.effective_date, 'topology_events.effective_date'),
      kind: text(row.type, 'topology_events.type'), stationIds: array(payload.range ?? [], 'topology_events.range').map(value => text(value, 'range')),
      abolishedSectionIds: array(payload.abolished_section_ids ?? [], 'abolished_section_ids').map(value => text(value, 'abolished_section_ids')) };
  });
  const mappings = entities.section_mappings.map(row => ({ eventId: text(row.event_id, 'section_mappings.event_id'),
    oldSectionId: text(row.old_section_id, 'section_mappings.old_section_id'),
    newSectionId: text(row.new_section_id, 'section_mappings.new_section_id') }));
  for (const [name, rows] of Object.entries({ cities, operators, stations, lines, sections, services, events })) {
    unique(rows, row => row.id, name);
  }
  unique(stations, row => row.code, 'stations.code');
  unique(memberships, row => JSON.stringify([row.serviceId, row.sequence, row.from, row.until]), 'memberships');
  // Sequence numbers are local to an active service history. Historical
  // windows may reuse the same numbers after a topology change, but two
  // members with one sequence cannot overlap because route traversal relies
  // on a strict order for the selected business date.
  noOverlap(memberships, row => JSON.stringify([row.serviceId, row.sequence]), 'memberships.sequence');
  unique(mappings, row => JSON.stringify([row.eventId, row.oldSectionId, row.newSectionId]), 'mappings');
  noOverlap(names, row => row.stationId, 'station_names');
  noOverlap(passengerPeriods, row => row.stationId, 'station_service_periods');
  const ids = Object.fromEntries(Object.entries({ cities, operators, stations, lines, sections, services, events })
    .map(([name, rows]) => [name, new Set(rows.map(row => row.id))]));
  const reference = (name, value, path) => requireValue(ids[name].has(value), 'E_REFERENCE', path, `Unknown ${name} identity`);
  for (const row of operators) if (row.cityId !== null) reference('cities', row.cityId, 'operators.cityId');
  for (const row of stations) reference('cities', row.cityId, 'stations.cityId');
  for (const row of sections) {
    reference('lines', row.lineId, 'sections.lineId');
    reference('stations', row.fromStationId, 'sections.fromStationId');
    reference('stations', row.toStationId, 'sections.toStationId');
    requireValue(row.fromStationId !== row.toStationId, 'E_REFERENCE', 'sections', 'Section endpoints must differ');
  }
  for (const row of services) reference('operators', row.operatorId, 'services.operatorId');
  for (const row of memberships) {
    reference('services', row.serviceId, 'memberships.serviceId');
    reference('sections', row.sectionId, 'memberships.sectionId');
  }
  for (const row of [...names, ...passengerPeriods]) reference('stations', row.stationId, 'stationHistory.stationId');
  for (const row of stations) {
    requireValue(names.some(history => history.stationId === row.id) &&
      passengerPeriods.some(history => history.stationId === row.id), 'E_REFERENCE', 'stationHistory', 'Missing station history');
  }
  for (const row of [...lines, ...services]) {
    if (row.foldStationId !== undefined && row.foldStationId !== null) reference('stations', row.foldStationId, 'line.foldStationId');
    for (const label of row.directions) for (const value of [label.fromStationId, label.toStationId]) {
      if (value !== null) reference('stations', value, 'line.directions');
    }
  }
  for (const row of events) {
    row.stationIds.forEach(value => reference('stations', value, 'events.stationIds'));
    row.abolishedSectionIds.forEach(value => reference('sections', value, 'events.abolishedSectionIds'));
  }
  for (const row of mappings) {
    reference('events', row.eventId, 'mappings.eventId');
    reference('sections', row.oldSectionId, 'mappings.oldSectionId');
    reference('sections', row.newSectionId, 'mappings.newSectionId');
  }
  const policies = decodePolicies(context.policies, { lines, sections, services, memberships }, reference);
  return freeze({ snapshotId: reader.snapshot_id, snapshotAsOf, knowledgeThrough,
    sourceKind: context.sourceKind, attribution: text(context.attribution, 'attribution', 2000), releaseReady: false,
    sourceUse: independent(context.sourceUse ?? { internalTestOnly: true, evidenceKind: context.sourceKind }),
    cities, operators, stations, lines, sections, services, memberships, names, passengerPeriods, events, mappings, policies });
}

function directions(value, path) {
  if (value === null) return [];
  return array(value, path).map((row, index) => {
    object(row, `${path}[${index}]`);
    const fromStationId = row.from_station_id ?? null;
    const toStationId = row.to_station_id ?? null;
    requireValue(fromStationId === null || typeof fromStationId === 'string', 'E_REFERENCE', `${path}[${index}].from_station_id`, 'Invalid direction station');
    requireValue(toStationId === null || typeof toStationId === 'string', 'E_REFERENCE', `${path}[${index}].to_station_id`, 'Invalid direction station');
    return { label: text(row.label, `${path}[${index}].label`), fromStationId, toStationId };
  });
}

function decodePolicies(input, network, reference) {
  object(input, 'policies');
  const noMileageOperators = array(input.no_mileage_operators, 'no_mileage_operators').map(value => text(value, 'no_mileage_operators'));
  unique(noMileageOperators, value => value, 'no_mileage_operators');
  const noMileageSections = new Set();
  for (const operatorId of noMileageOperators) {
    reference('operators', operatorId, 'no_mileage_operators');
    const serviceIds = new Set(network.services.filter(row => row.operatorId === operatorId).map(row => row.id));
    const sectionIds = new Set(network.memberships.filter(row => serviceIds.has(row.serviceId)).map(row => row.sectionId));
    requireValue(network.sections.filter(row => sectionIds.has(row.id)).every(row => row.lengthMetres === null),
      'E_MILEAGE_POLICY', 'no_mileage_operators', 'Declared no-mileage scope contains mileage');
    sectionIds.forEach(value => noMileageSections.add(value));
  }
  const closures = array(input.permanent_closures, 'permanent_closures').map(row => {
    object(row, 'permanent_closures');
    reference('lines', row.physical_line_id, 'permanent_closures.physical_line_id');
    const closedOn = day(row.closed_from, 'closed_from');
    const line = network.lines.find(line => line.id === row.physical_line_id);
    if (row.physical_section_ids === undefined) {
      requireValue(line.until === closedOn, 'E_STATUS', 'permanent_closures', 'Closure must bind the line end date');
      return { lineId: line.id, closedOn };
    }
    const sectionIds = array(row.physical_section_ids, 'permanent_closures.physical_section_ids')
      .map(value => text(value, 'permanent_closures.physical_section_ids'));
    unique(sectionIds, value => value, 'permanent_closures.physical_section_ids');
    requireValue(sectionIds.length > 0, 'E_STATUS', 'permanent_closures', 'Empty closure scope');
    const beforeClosure = new Date(Date.parse(`${closedOn}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    requireValue(active(line, beforeClosure), 'E_STATUS', 'permanent_closures', 'Section closure requires an active physical line before closure');
    for (const id of sectionIds) {
      reference('sections', id, 'permanent_closures.physical_section_ids');
      requireValue(network.sections.some(section => section.id === id && section.lineId === line.id &&
        (section.until === closedOn || (line.until === closedOn && active(section, beforeClosure))) && section.from < closedOn),
      'E_STATUS', 'permanent_closures', 'Closure must bind the section line and end date');
    }
    return { lineId: line.id, closedOn, sectionIds };
  });
  for (const [index, closure] of closures.entries()) {
    requireValue(!closures.slice(0, index).some(other => other.lineId === closure.lineId &&
      (!other.sectionIds || !closure.sectionIds || closure.sectionIds.some(id => other.sectionIds.includes(id)))),
    'E_STATUS', 'permanent_closures', 'Overlapping closure scope');
  }
  const suspensions = array(input.temporary_suspensions, 'temporary_suspensions').map(row => {
    object(row, 'temporary_suspensions');
    reference('lines', row.physical_line_id, 'temporary_suspensions.physical_line_id');
    const from = day(row.suspend_from, 'suspend_from');
    const until = row.resume_at === null ? null : day(row.resume_at, 'resume_at');
    requireValue(until === null || from < until, 'E_STATUS', 'temporary_suspensions', 'Invalid suspension period');
    const sectionIds = row.physical_section_ids === undefined
      ? network.sections.filter(section => section.lineId === row.physical_line_id && active(section, from)).map(section => section.id)
      : array(row.physical_section_ids, 'physical_section_ids').map(value => text(value, 'physical_section_ids'));
    unique(sectionIds, value => value, 'suspension.sectionIds');
    requireValue(sectionIds.length > 0, 'E_STATUS', 'suspension.sectionIds', 'Empty suspension scope');
    for (const sectionId of sectionIds) {
      reference('sections', sectionId, 'suspension.sectionIds');
      requireValue(network.sections.some(section => section.id === sectionId && section.lineId === row.physical_line_id && active(section, from)),
        'E_STATUS', 'suspension.sectionIds', 'Suspension scope differs from active physical line');
    }
    requireValue(!closures.some(closure => closure.lineId === row.physical_line_id &&
      (!closure.sectionIds || sectionIds.some(id => closure.sectionIds.includes(id))) &&
      (until === null || until > closure.closedOn)),
    'E_STATUS', 'temporary_suspensions', 'Temporary suspension extends into permanent closure');
    return { lineId: row.physical_line_id, from, until, sectionIds };
  });
  return { noMileageSections: [...noMileageSections], closures, suspensions };
}
