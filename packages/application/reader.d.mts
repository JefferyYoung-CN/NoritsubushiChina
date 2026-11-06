/** Checked public network shape; runtime validation remains in reader.mjs. */
export type SourceKind = 'real-internal-test' | 'real-regression' | 'simulated';
export interface Period { readonly from: string; readonly until: string | null }
export interface Direction {
  readonly label: string;
  readonly fromStationId: string | null;
  readonly toStationId: string | null;
}
export interface TransitNetwork {
  readonly snapshotId: string;
  readonly snapshotAsOf: string;
  readonly knowledgeThrough: string;
  readonly sourceKind: SourceKind;
  readonly attribution: string;
  readonly releaseReady: false;
  readonly sourceUse: Readonly<{
    internalTestOnly: boolean; evidenceKind: string; provider?: string;
    coordinateSystem?: string; licenseName?: string; licenseUrl?: string;
    upstreamObjectVersionsKnown?: boolean; remainingAcceptance?: readonly string[];
  }>;
  readonly cities: readonly Readonly<{ id: string; name: string }>[];
  readonly operators: readonly Readonly<{ id: string; cityId: string | null; category?: 'national' | 'intercity' | 'urban' | 'unclassified'; name: string }>[];
  readonly stations: readonly Readonly<{
    id: string; code: string; name: string; cityId: string;
    latitude: number | null; longitude: number | null;
  }>[];
  readonly lines: readonly Readonly<Period & {
    id: string; name: string; isLoop: boolean; foldStationId?: string | null;
    directions: readonly Direction[];
  }>[];
  readonly sections: readonly Readonly<Period & {
    id: string; lineId: string; fromStationId: string; toStationId: string;
    lengthMetres: number | null; lengthSource: string | null;
  }>[];
  readonly services: readonly Readonly<Period & {
    id: string; name: string; operatorId: string; directions: readonly Direction[];
  }>[];
  readonly memberships: readonly Readonly<Period & { serviceId: string; sectionId: string; sequence: number }>[];
  readonly names: readonly Readonly<Period & { stationId: string; name: string }>[];
  readonly passengerPeriods: readonly Readonly<Period & { stationId: string; kind: 'passenger' | 'non_passenger' }>[];
  readonly events: readonly Readonly<{
    id: string; effectiveOn: string; kind: string;
    stationIds: readonly string[]; abolishedSectionIds: readonly string[];
  }>[];
  readonly mappings: readonly Readonly<{ eventId: string; oldSectionId: string; newSectionId: string }>[];
  readonly policies: Readonly<{
    noMileageSections: readonly string[];
    closures: readonly Readonly<{ lineId: string; closedOn: string; sectionIds?: readonly string[] }>[];
    suspensions: readonly Readonly<Period & { lineId: string; sectionIds: readonly string[] }>[];
  }>;
}

export interface ReaderContext {
  readonly snapshotId: string;
  readonly sourceKind: SourceKind;
  readonly knowledgeThrough: string;
  readonly attribution: string;
  readonly policies: unknown;
  readonly sourceUse?: TransitNetwork['sourceUse'];
}
export function decodeReader(reader: unknown, context: ReaderContext): TransitNetwork;
