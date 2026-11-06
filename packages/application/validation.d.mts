import type { Period } from './reader.mjs';
export class BoundaryError extends Error { readonly code: string; readonly path: string; constructor(code: string, path: string, message: string); }
export function requireValue(condition: unknown, code: string, path: string, message: string): asserts condition;
export function object(value: unknown, path: string): Record<string, unknown>;
export function fields(value: unknown, required: readonly string[], optional: readonly string[], path: string): Record<string, unknown>;
export function array(value: unknown, path: string, limit?: number): unknown[];
export function text(value: unknown, path: string, limit?: number, allowEmpty?: boolean): string;
export function day(value: unknown, path: string, minimum?: string): string;
export function period(row: { valid_from: unknown; valid_to: unknown }, path: string): Period;
export function active(row: Period, onDate: string): boolean;
export function freeze<T>(value: T): Readonly<T>;
export function independent<T>(value: T): Readonly<T>;
export function unique<T>(rows: readonly T[], key: (row: T) => unknown, path: string): void;
export function parseJson(input: unknown, path: string, maximumBytes?: number): unknown;
export function sha256(input: string): Promise<string>;
export function canonical(value: unknown): string;
