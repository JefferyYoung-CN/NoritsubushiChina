import type { TransitNetwork } from './reader.mjs';
export interface FoldedLoop {
  readonly stationIds: readonly string[];
  readonly sections: readonly TransitNetwork['sections'][number][];
}
export function foldedLoop(network: TransitNetwork, lineId: string, onDate: string): FoldedLoop | null;
export function foldedInterval(loop: FoldedLoop, fromIndex: number, toIndex: number): TransitNetwork['sections'][number][] | null;
export function matchFoldedInterval(loop: FoldedLoop, from: string, to: string, sectionIds: readonly string[]): TransitNetwork['sections'][number][] | null;
