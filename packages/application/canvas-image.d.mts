import type { TransitNetwork } from './reader.mjs';

/** 已验证日期视图中，绘制器实际读取的只读字段。 */
export interface CanvasImageStation {
  readonly id: string;
  readonly code: string;
  readonly name: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
}
export interface CanvasImageSection {
  readonly id: string;
  readonly fromStationId: string;
  readonly toStationId: string;
}
export interface CanvasImageView {
  readonly snapshotId: string;
  readonly sourceKind: string;
  readonly onDate: string;
  readonly serviceLineId: string | null;
  readonly fromStationId: string | null;
  readonly toStationId: string | null;
  readonly empty: boolean;
  readonly mapAvailable: boolean;
  readonly attribution: string;
  readonly stations: readonly CanvasImageStation[];
  readonly normalSections: readonly CanvasImageSection[];
  readonly temporarySections: readonly CanvasImageSection[];
  readonly retiredSections: readonly CanvasImageSection[];
  readonly normalLengthMetres: number | null;
  readonly retiredLengthMetres: number | null;
  readonly statisticsBasis: string;
  readonly mileageStatus: string;
  readonly noMileageLabel: boolean;
}
export interface CanvasImageStatistics {
  readonly normalLengthMetres: number | null;
  readonly retiredLengthMetres: number | null;
  readonly statisticsBasis: string;
  readonly mileageStatus: string;
  readonly noMileageLabel: boolean;
  readonly mileageGroups: readonly Readonly<{
    basis: string; sectionCount: number; lengthMetres: number | null;
  }>[];
}
export interface CanvasImageFooter {
  readonly text: string;
  readonly position: 'bottom';
  readonly visible: true;
  readonly retainInBitmap: true;
}
export interface CanvasImageRequest {
  readonly kind: 'image-request';
  readonly snapshotId: string;
  readonly sourceKind: string;
  readonly releaseReady: false;
  readonly internalTestOnly: true;
  readonly view: CanvasImageView;
  readonly statistics: CanvasImageStatistics;
  readonly footer: CanvasImageFooter;
}
export interface CanvasImageLayout {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly margin: number;
  readonly footerPaddingX: number;
  readonly footerPaddingY: number;
  readonly footerFontSize: number;
  readonly footerMinFontSize: number;
  readonly footerLineHeight: number;
  readonly titleFontSize: number;
  readonly metaFontSize: number;
  readonly statLabelFontSize: number;
  readonly statValueFontSize: number;
  readonly legendRowHeight: number;
  readonly legendSwatchWidth: number;
  readonly legendGap: number;
  readonly stationLabelSize: number;
  readonly stationRadius: number;
  readonly stationLabelGap: number;
  readonly lineWidth: number;
  readonly mapPadding: number;
}
export interface CanvasImageSize {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
}
export interface CanvasImageRenderOptions {
  readonly context: CanvasRenderingContext2D;
  readonly network?: TransitNetwork | null;
  readonly width?: number;
  readonly height?: number;
  readonly signal?: AbortSignal;
}
export interface CanvasImageRenderResult {
  readonly kind: 'canvas-image';
  readonly renderedBitmap: true;
  readonly request: CanvasImageRequest;
}
export const ATTRIBUTION_TEXT: string;
export interface StatisticsImageRequest {
  readonly sourceKind: TransitNetwork['sourceKind']; readonly releaseReady: false; readonly internalTestOnly: true;
  readonly attribution: string; readonly onDate: string; readonly snapshotId: string; readonly subtitle: string;
  readonly rows: readonly { readonly label: string; readonly completed: string; readonly denominator: string; readonly note: string }[];
}
export function renderStatisticsImage(request: StatisticsImageRequest, options: Omit<CanvasImageRenderOptions, 'network'>): { readonly kind: 'statistics-image'; readonly renderedBitmap: true };
export const CANVAS_IMAGE: Readonly<{
  width: number; height: number; minWidth: number; maxWidth: number;
  minHeight: number; maxHeight: number; minScale: number; maxScale: number;
  padding: number; footerPaddingX: number; footerPaddingY: number;
  footerFontSize: number; footerMinFontSize: number; lineHeightRatio: number;
  legendRowHeight: number; legendSwatchWidth: number; legendGap: number;
  stationLabelSize: number; stationRadius: number; stationLabelGap: number;
  mapPaddingRatio: number; titleFontSize: number; metaFontSize: number;
  statLabelFontSize: number; statValueFontSize: number;
  colors: Readonly<{
    background: string; mapBackground: string; ink: string; muted: string; rule: string;
    normal: string; temporary: string; retired: string;
    footerBackground: string; footerInk: string;
  }>;
  fontFamily: string;
}>;
export const EXPORT_SIZES: readonly CanvasImageSize[];
export function createCanvasImageRequest(view: CanvasImageView): CanvasImageRequest;
export function layoutCanvasImage(width?: number, height?: number): CanvasImageLayout;
export function renderCanvasImage(
  request: CanvasImageRequest,
  options: CanvasImageRenderOptions,
): CanvasImageRenderResult;
