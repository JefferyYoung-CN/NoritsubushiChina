import { independent, requireValue } from './validation.mjs';
import { isDateView } from './date-view.mjs';
import { ATTRIBUTION } from './development-input.mjs';

const requests = new WeakSet();
export function createImageRequest(view) {
  requireValue(isDateView(view), 'E_IMAGE', 'view', 'Image export requires a validated date view');
  requireValue(!view.empty && view.mapAvailable, 'E_IMAGE', 'view.mapAvailable', 'No map coordinates for image');
  requireValue(view.attribution === ATTRIBUTION, 'E_LICENSE', 'view.attribution', 'Missing required attribution');
  const request = independent({ kind: 'image-request', snapshotId: view.snapshotId, sourceKind: view.sourceKind,
    releaseReady: false, internalTestOnly: true, sourceUse: view.sourceUse, view,
    statistics: { normalLengthMetres: view.normalLengthMetres, retiredLengthMetres: view.retiredLengthMetres,
      statisticsBasis: view.statisticsBasis, mileageStatus: view.mileageStatus, noMileageLabel: view.noMileageLabel, mileageGroups: view.mileageGroups },
    footer: { text: ATTRIBUTION, position: 'bottom', visible: true, retainInBitmap: true } });
  requests.add(request);
  return request;
}

// This adapter exercises the export port only; P5 replaces it with bitmap
// rendering and verifies footer legibility at actual output sizes.
export function createFakeImageExporter() {
  return Object.freeze({ async export(request, { signal, fail = false } = {}) {
    requireValue(requests.has(request), 'E_IMAGE', 'request', 'Unvalidated image request');
    requireValue(!signal?.aborted, 'E_ABORT', 'image', 'Image export cancelled');
    requireValue(!fail, 'E_IMAGE', 'image', 'Simulated renderer failure');
    return independent({ kind: 'fake-image', renderedBitmap: false, request });
  } });
}
