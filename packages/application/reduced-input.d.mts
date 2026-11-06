import type { TransitNetwork } from './reader.mjs';

export interface ReducedInput {
  readonly kind: 'reduced-input';
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly dataUse: Readonly<Record<string, unknown>>;
  readonly network: TransitNetwork;
}

export declare function decodeReducedEnvelope(
  input: string,
  expectedSha256: string,
): Promise<ReducedInput>;
