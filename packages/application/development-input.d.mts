import type { TransitNetwork } from './reader.mjs';
export interface DevelopmentInput {
  readonly kind: 'development-input';
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly dataUse: Readonly<Record<string, unknown>>;
  readonly network: TransitNetwork;
}
export const ATTRIBUTION: string;
export function decodeApplicationEnvelope(input: string, expectedSha256: string): Promise<DevelopmentInput>;
