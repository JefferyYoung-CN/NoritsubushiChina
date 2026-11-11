// 真实 Canvas 图片导出：本模块只接收已验证图片请求与 2D context，由显式绘制得到位图，
// 不用 DOM 截图：截图会受跨域底图、字体加载、裁剪与样式差异影响，
// 而导出内容与统计口径必须可复现、可测试；显式绘制也能保证底部署名不依赖页面布局。
//
// 许可边界：署名
// `© OpenStreetMap contributors · https://www.openstreetmap.org/copyright`
// 是 ODbL 对图片分发的要求，属于导出结果本身的一部分，固定在底部可见区域，
// 不可关闭、不可裁掉、不可缩小到不可读；本模块没有“隐藏署名”的开关。
import { ATTRIBUTION } from './development-input.mjs';
import { createImageRequest } from './image-export.mjs';
import { isDateView } from './date-view.mjs';
import { independent, requireValue } from './validation.mjs';

export const ATTRIBUTION_TEXT = ATTRIBUTION;

/** 模拟（重建）封套的导出必须在署名后固定标注「重建数据」。 */
const SIMULATED_EXPORT_NOTE = '重建数据';
const footerTextOf = sourceKind =>
  (sourceKind === 'simulated' ? `${ATTRIBUTION} · ${SIMULATED_EXPORT_NOTE}` : ATTRIBUTION);

// 所有尺寸、颜色、边距与字号集中在这里，布局函数与测试都从这份常量推导。
export const CANVAS_IMAGE = Object.freeze({
  width: 900,
  height: 1280,
  minWidth: 360,
  maxWidth: 4096,
  minHeight: 480,
  maxHeight: 8192,
  minScale: 0.7,
  maxScale: 2.4,
  padding: 48,
  footerPaddingX: 40,
  footerPaddingY: 24,
  footerFontSize: 19,
  footerMinFontSize: 11,
  lineHeightRatio: 1.5,
  legendRowHeight: 26,
  legendSwatchWidth: 28,
  legendGap: 8,
  stationLabelSize: 14,
  stationRadius: 5,
  stationLabelGap: 6,
  mapPaddingRatio: 0.08,
  titleFontSize: 34,
  metaFontSize: 17,
  statLabelFontSize: 14,
  statValueFontSize: 24,
  colors: Object.freeze({
    background: '#f6f2e8',
    mapBackground: '#efe9dc',
    ink: '#1c1b19',
    muted: '#5f5c55',
    rule: '#d6cebd',
    normal: '#8c2f28',
    temporary: '#b06a1f',
    retired: '#74777b',
    footerBackground: '#101214',
    footerInk: '#ffffff',
  }),
  fontFamily: '"Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif',
});

// 页面组件直接消费这些尺寸；390px 级窄图与放大尺寸都必须让底部署名完整可读。
export const EXPORT_SIZES = Object.freeze([
  Object.freeze({ id: 'narrow', label: '窄图', width: 390, height: 844 }),
  Object.freeze({ id: 'standard', label: '标准', width: 900, height: 1280 }),
  Object.freeze({ id: 'large', label: '放大', width: 1800, height: 2560 }),
]);

const CONTEXT_METHODS = ['save', 'restore', 'fillRect', 'fillText', 'beginPath', 'moveTo', 'lineTo',
  'stroke', 'arc', 'fill', 'measureText', 'setLineDash'];

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const scaled = (value, scale) => Math.round(value * scale);
const fontOf = (size, weight = 400) => `${weight} ${size}px ${CANVAS_IMAGE.fontFamily}`;

/** 按画布宽度推导的可测试布局；宽度与高度先做整数范围校验。 */
export function layoutCanvasImage(width = CANVAS_IMAGE.width, height = CANVAS_IMAGE.height) {
  requireValue(Number.isSafeInteger(width) && width >= CANVAS_IMAGE.minWidth && width <= CANVAS_IMAGE.maxWidth,
    'E_IMAGE', 'image.width', `Image width must be an integer between ${CANVAS_IMAGE.minWidth} and ${CANVAS_IMAGE.maxWidth}`);
  requireValue(Number.isSafeInteger(height) && height >= CANVAS_IMAGE.minHeight && height <= CANVAS_IMAGE.maxHeight,
    'E_IMAGE', 'image.height', `Image height must be an integer between ${CANVAS_IMAGE.minHeight} and ${CANVAS_IMAGE.maxHeight}`);
  const scale = clamp(width / CANVAS_IMAGE.width, CANVAS_IMAGE.minScale, CANVAS_IMAGE.maxScale);
  const footerFontSize = Math.max(CANVAS_IMAGE.footerMinFontSize,
    scaled(CANVAS_IMAGE.footerFontSize, scale));
  return Object.freeze({
    width, height, scale,
    margin: scaled(CANVAS_IMAGE.padding, scale),
    footerPaddingX: scaled(CANVAS_IMAGE.footerPaddingX, scale),
    footerPaddingY: scaled(CANVAS_IMAGE.footerPaddingY, scale),
    footerFontSize,
    footerMinFontSize: CANVAS_IMAGE.footerMinFontSize,
    footerLineHeight: Math.round(footerFontSize * CANVAS_IMAGE.lineHeightRatio),
    titleFontSize: scaled(CANVAS_IMAGE.titleFontSize, scale),
    metaFontSize: scaled(CANVAS_IMAGE.metaFontSize, scale),
    statLabelFontSize: scaled(CANVAS_IMAGE.statLabelFontSize, scale),
    statValueFontSize: scaled(CANVAS_IMAGE.statValueFontSize, scale),
    legendRowHeight: scaled(CANVAS_IMAGE.legendRowHeight, scale),
    legendSwatchWidth: scaled(CANVAS_IMAGE.legendSwatchWidth, scale),
    legendGap: scaled(CANVAS_IMAGE.legendGap, scale),
    stationLabelSize: scaled(CANVAS_IMAGE.stationLabelSize, scale),
    stationRadius: Math.max(3, scaled(CANVAS_IMAGE.stationRadius, scale)),
    stationLabelGap: scaled(CANVAS_IMAGE.stationLabelGap, scale),
    lineWidth: Math.max(2, scaled(2.5, scale)),
    mapPadding: Math.min(width, height) * CANVAS_IMAGE.mapPaddingRatio,
  });
}

/** 验证视图并复用图片端口生成请求；保留已验证视图引用，供绘制器再次复核。 */
export function createCanvasImageRequest(view) {
  const request = createImageRequest(view);
  // createImageRequest 会深拷贝整个请求，拷贝后的 view 不再在 isDateView 的验证集合里；
  // 这里把原已验证视图放回请求，确保 renderCanvasImage 的复核不是空转。
  return Object.freeze({ ...request, view });
}

const throwIfAborted = signal => {
  requireValue(!signal?.aborted, 'E_ABORT', 'image', 'Image export cancelled');
};

function requireRequest(request) {
  requireValue(request !== null && typeof request === 'object' && request.kind === 'image-request',
    'E_IMAGE', 'request', 'Unvalidated image request');
  requireValue(isDateView(request.view), 'E_IMAGE', 'request.view', 'Image request requires a validated date view');
  requireValue(request.view.mapAvailable === true && request.view.empty !== true,
    'E_IMAGE', 'request.view.mapAvailable', 'No map coordinates for image');
  requireValue(request.footer !== null && typeof request.footer === 'object' &&
    request.footer.position === 'bottom' && request.footer.visible === true &&
    request.footer.retainInBitmap === true,
  'E_IMAGE', 'request.footer', 'Footer must be visible at the bottom and retained in the bitmap');
  requireValue(request.footer.text === ATTRIBUTION,
    'E_LICENSE', 'request.footer.text', 'Missing required attribution');
  // 署名后缀由已验证视图的来源决定，不能由请求顶层字段单独声明。
  requireValue(request.sourceKind === request.view.sourceKind,
    'E_IMAGE', 'request.sourceKind', 'Image request source differs from its validated view');
}

function requireContext(context) {
  requireValue(context !== null && typeof context === 'object' &&
    CONTEXT_METHODS.every(name => typeof context[name] === 'function'),
  'E_IMAGE', 'image.context', 'A 2D canvas context is required');
}

function measureWidth(context, text) {
  const metrics = context.measureText(text);
  requireValue(metrics && Number.isFinite(metrics.width), 'E_IMAGE', 'image.context',
    'measureText must return a finite width');
  return metrics.width;
}

function wrapText(context, text, maxWidth, breakLongWords = false) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && measureWidth(context, candidate) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  if (!breakLongWords) return lines;
  // 内容可按 Unicode 字符断行；署名 URL 仍使用不可拆词的独立适配规则。
  return lines.flatMap(value => {
    const wrapped = [];
    let part = '';
    for (const char of value) {
      if (part && measureWidth(context, part + char) > maxWidth) { wrapped.push(part); part = ''; }
      part += char;
    }
    return [...wrapped, part];
  });
}

// 窄宽下先把字号降到能容纳最长单词（URL 不可拆），再按可用宽度换行。
function fitFooterFontSize(context, layout, text) {
  const maxWidth = layout.width - layout.footerPaddingX * 2;
  const longestWord = text.split(' ').reduce((longest, word) =>
    (measureWidth(context, word) > measureWidth(context, longest) ? word : longest));
  let size = layout.footerFontSize;
  while (size > layout.footerMinFontSize) {
    context.font = fontOf(size, 600);
    if (measureWidth(context, longestWord) <= maxWidth) break;
    size -= 1;
  }
  context.font = fontOf(size, 600);
  requireValue(measureWidth(context, longestWord) <= maxWidth, 'E_IMAGE', 'image.width',
    'Footer attribution cannot fit the export width');
  return size;
}

const mercatorY = latitude => Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));

function projectStations(stations, rect) {
  const located = stations.filter(row => Number.isFinite(row.latitude) && Number.isFinite(row.longitude));
  if (!located.length) return new Map();
  const xs = located.map(row => row.longitude);
  const ys = located.map(row => mercatorY(row.latitude));
  let minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  const epsilonX = Math.max(1e-9, (maxX - minX) * 0.05);
  const epsilonY = Math.max(1e-9, (maxY - minY) * 0.05);
  if (maxX - minX < epsilonX) { minX -= epsilonX; maxX += epsilonX; }
  if (maxY - minY < epsilonY) { minY -= epsilonY; maxY += epsilonY; }
  const innerWidth = Math.max(1, rect.width - rect.padding * 2);
  const innerHeight = Math.max(1, rect.height - rect.padding * 2);
  return new Map(located.map(row => [row.id, {
    x: rect.x + rect.padding + ((row.longitude - minX) / (maxX - minX)) * innerWidth,
    y: rect.y + rect.padding + ((maxY - mercatorY(row.latitude)) / (maxY - minY)) * innerHeight,
  }]));
}

function formatLength(metres) {
  if (metres === null || metres === undefined) return '—';
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}

const basisLabelOf = view => ({
  metres: '按里程统计',
  sections: '按区间数统计（无里程）',
  unavailable: '里程口径不可用',
}[view.statisticsBasis] ?? '统计口径未知');

const serviceLabelOf = (network, view) => {
  if (!network || !Array.isArray(network.services) || view.serviceLineId === null) return '全部线路';
  return network.services.find(row => row.id === view.serviceLineId)?.name ?? '未知服务';
};

function drawHeader(context, layout, request, network) {
  const { colors, fontFamily } = CANVAS_IMAGE;
  const { margin } = layout;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.fillStyle = colors.ink;
  context.font = `600 ${layout.titleFontSize}px ${fontFamily}`;
  const titleBaseline = margin + layout.titleFontSize;
  context.fillText(`区间示意 · ${request.view.onDate}`, margin, titleBaseline);

  context.fillStyle = colors.muted;
  context.font = `${layout.metaFontSize}px ${fontFamily}`;
  const firstMetaBaseline = titleBaseline + layout.metaFontSize * 1.6;
  context.fillText(`服务：${serviceLabelOf(network, request.view)} · 日期：${request.view.onDate}`, margin, firstMetaBaseline);
  const secondMetaBaseline = firstMetaBaseline + layout.metaFontSize * 1.5;
  const basis = basisLabelOf(request.view) + (request.view.noMileageLabel ? '（含无里程区间）' : '');
  context.fillText(`统计口径：${basis}`, margin, secondMetaBaseline);

  context.fillStyle = colors.rule;
  const ruleY = secondMetaBaseline + layout.metaFontSize * 0.8;
  context.fillRect(margin, ruleY, layout.width - margin * 2, Math.max(1, Math.round(layout.scale)));
  return ruleY;
}

function drawStatistics(context, layout, request, top) {
  const { colors, fontFamily } = CANVAS_IMAGE;
  const columns = [
    { label: '正常里程', value: formatLength(request.statistics.normalLengthMetres) },
    { label: '正常区间', value: `${request.view.normalSections.length} 段` },
    { label: '已停运', value: `${request.view.retiredSections.length} 段` },
  ];
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  const columnWidth = (layout.width - layout.margin * 2) / columns.length;
  columns.forEach((column, index) => {
    const x = layout.margin + columnWidth * index;
    context.fillStyle = colors.muted;
    context.font = `${layout.statLabelFontSize}px ${fontFamily}`;
    context.fillText(column.label, x, top + layout.statLabelFontSize);
    context.fillStyle = colors.ink;
    context.font = `600 ${layout.statValueFontSize}px ${fontFamily}`;
    context.fillText(column.value, x, top + layout.statLabelFontSize + layout.statValueFontSize);
  });
  return top + layout.statLabelFontSize + layout.statValueFontSize;
}

function drawSections(context, layout, view, points, rect) {
  const { colors } = CANVAS_IMAGE;
  const groups = [
    { rows: view.normalSections, color: colors.normal, dash: [] },
    { rows: view.temporarySections, color: colors.temporary, dash: [10 * layout.scale, 8 * layout.scale] },
    { rows: view.retiredSections, color: colors.retired, dash: [4 * layout.scale, 6 * layout.scale] },
  ];
  for (const group of groups) {
    context.strokeStyle = group.color;
    context.lineWidth = layout.lineWidth;
    context.setLineDash(group.dash);
    context.beginPath();
    for (const section of group.rows) {
      const from = points.get(section.fromStationId);
      const to = points.get(section.toStationId);
      if (!from || !to) continue;
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
    }
    context.stroke();
  }
  context.setLineDash([]);
  context.fillStyle = colors.ink;
}

function drawStations(context, layout, view, points, rect) {
  const { colors, fontFamily } = CANVAS_IMAGE;
  const font = `${layout.stationLabelSize}px ${fontFamily}`;
  context.font = font;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  const occupied = [];
  for (const station of view.stations) {
    const point = points.get(station.id);
    if (!point) continue;
    context.fillStyle = colors.ink;
    context.beginPath();
    context.arc(point.x, point.y, layout.stationRadius, 0, Math.PI * 2);
    context.fill();
  }
  // 站名标签按测量宽度做简单避让：放不下或重叠时跳过标签，不压住线条与署名。
  for (const station of view.stations) {
    const point = points.get(station.id);
    if (!point) continue;
    const label = station.name ?? station.code ?? station.id;
    const textWidth = measureWidth(context, label);
    const box = {
      x: point.x + layout.stationRadius + layout.stationLabelGap,
      y: point.y - layout.stationLabelGap - layout.stationLabelSize,
      width: textWidth, height: layout.stationLabelSize * 1.3,
    };
    const outside = box.x + box.width > rect.x + rect.width || box.x < rect.x ||
      box.y < rect.y || box.y + box.height > rect.y + rect.height;
    const overlaps = occupied.some(other => box.x < other.x + other.width &&
      other.x < box.x + box.width && box.y < other.y + other.height && other.y < box.y + box.height);
    if (outside || overlaps) continue;
    occupied.push(box);
    context.fillStyle = colors.ink;
    context.fillText(label, box.x, box.y + layout.stationLabelSize);
  }
}

function drawLegend(context, layout, view, top) {
  const { colors, fontFamily } = CANVAS_IMAGE;
  const items = [
    { text: `正常区间 ${view.normalSections.length} 段`, color: colors.normal, dash: [] },
    { text: `临时停运 ${view.temporarySections.length} 段`, color: colors.temporary, dash: [8 * layout.scale, 6 * layout.scale] },
    { text: `已停运 ${view.retiredSections.length} 段`, color: colors.retired, dash: [4 * layout.scale, 5 * layout.scale] },
  ];
  context.font = `${layout.metaFontSize}px ${fontFamily}`;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  items.forEach((item, index) => {
    const middle = top + layout.legendRowHeight * index + layout.legendRowHeight / 2;
    context.strokeStyle = item.color;
    context.lineWidth = layout.lineWidth;
    context.setLineDash(item.dash);
    context.beginPath();
    context.moveTo(layout.margin, middle);
    context.lineTo(layout.margin + layout.legendSwatchWidth, middle);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = colors.ink;
    context.fillText(item.text, layout.margin + layout.legendSwatchWidth + layout.legendGap,
      middle + layout.metaFontSize * 0.35);
  });
}

// 底带指标先量后画：行数、字号与高度同时决定内容区下界，避免窄宽下署名被裁切。
function footerMetricsOf(context, layout, text) {
  const fontSize = fitFooterFontSize(context, layout, text);
  const lineHeight = Math.max(fontSize, Math.round(fontSize * CANVAS_IMAGE.lineHeightRatio));
  context.font = fontOf(fontSize, 600);
  const lines = wrapText(context, text, layout.width - layout.footerPaddingX * 2);
  const height = layout.footerPaddingY * 2 + lines.length * lineHeight;
  return Object.freeze({ fontSize, lineHeight, lines, height, top: layout.height - height });
}

// 底部深色带上白字：对比度约 18:1，字号与行数随宽度自适应，最后一行基线始终在画布内。
function drawFooter(context, layout, metrics) {
  const { colors } = CANVAS_IMAGE;
  context.fillStyle = colors.footerBackground;
  context.fillRect(0, metrics.top, layout.width, metrics.height);
  context.fillStyle = colors.footerInk;
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  const firstBaseline = metrics.top + layout.footerPaddingY +
    Math.round((metrics.lineHeight + metrics.fontSize) / 2);
  metrics.lines.forEach((line, index) => {
    context.fillText(line, layout.footerPaddingX, firstBaseline + index * metrics.lineHeight);
  });
}

/**
 * 按已验证请求绘制当前日期视图并返回导出结果。
 * @param {object} request 由 createCanvasImageRequest / image-export 生成的请求。
 * @param {{ context: object, network?: object|null, width?: number, height?: number, signal?: AbortSignal }} options
 */
export function renderCanvasImage(request, { context, network = null, width, height, signal } = {}) {
  throwIfAborted(signal);
  requireRequest(request);
  requireContext(context);
  const layout = layoutCanvasImage(width ?? CANVAS_IMAGE.width, height ?? CANVAS_IMAGE.height);
  const view = request.view;
  const { colors } = CANVAS_IMAGE;

  // 先量出署名的行数与底带高度，再决定内容区下界，避免署名被内容挤掉或裁切。
  const footer = footerMetricsOf(context, layout, footerTextOf(request.sourceKind));
  requireValue(footer.height <= layout.height * 0.25, 'E_IMAGE', 'image.height',
    'Image is too short for the fixed footer');
  const legendTop = footer.top - layout.margin * 0.4 - layout.legendRowHeight * 3;

  context.save();
  context.fillStyle = colors.background;
  context.fillRect(0, 0, layout.width, layout.height);
  const headerBottom = drawHeader(context, layout, request, network);
  const statisticsBottom = drawStatistics(context, layout, request, headerBottom + layout.margin * 0.6);
  const mapTop = statisticsBottom + layout.margin * 0.5;
  const mapBottom = legendTop - layout.margin * 0.4;
  requireValue(mapBottom - mapTop >= 120 * layout.scale, 'E_IMAGE', 'image.height',
    'Image is too short for the map, statistics and fixed footer');

  context.fillStyle = colors.mapBackground;
  const mapRect = { x: layout.margin, y: mapTop, width: layout.width - layout.margin * 2,
    height: mapBottom - mapTop, padding: layout.mapPadding };
  context.fillRect(mapRect.x, mapRect.y, mapRect.width, mapRect.height);
  const points = projectStations(view.stations, mapRect);
  drawSections(context, layout, view, points, mapRect);
  drawStations(context, layout, view, points, mapRect);
  drawLegend(context, layout, view, legendTop);
  throwIfAborted(signal);
  drawFooter(context, layout, footer);
  context.restore();

  // 按图片端口契约返回 { kind, renderedBitmap, request }：request 是已验证的图片请求，
  // renderedBitmap: true 表示这是真实 Canvas 绘制结果。
  return independent({ kind: 'canvas-image', renderedBitmap: true, request });
}

/** Statistics export is a separate view contract from a passenger trip (AC-B07).
 * Both renderers share layout, wrapping and the mandatory bitmap footer. */
export function renderStatisticsImage(request, { context, width, height, signal } = {}) {
  throwIfAborted(signal);
  requireContext(context);
  requireValue(request?.attribution === ATTRIBUTION, 'E_LICENSE', 'statistics.attribution', 'Missing required attribution');
  requireValue(Array.isArray(request.rows) && request.rows.length > 0 && request.rows.length <= 100,
    'E_IMAGE', 'statistics.rows', 'Statistics content is required');
  requireValue(request.releaseReady === false && request.internalTestOnly === true &&
    ['real-internal-test', 'real-regression', 'simulated'].includes(request.sourceKind), 'E_IMAGE', 'statistics.source', 'Internal verified source is required');
  const lines = ['完成度统计（内部测试）', request.onDate, request.snapshotId, request.subtitle,
    ...request.rows.flatMap(row => [row.label, `${row.completed} / ${row.denominator}`, row.note || ''])];
  requireValue(lines.every(line => typeof line === 'string' && line.length <= 2000), 'E_IMAGE', 'statistics', 'Invalid statistics text');
  const layout = layoutCanvasImage(width, height);
  const footer = footerMetricsOf(context, layout, footerTextOf(request.sourceKind));
  context.save();
  try {
    context.fillStyle = CANVAS_IMAGE.colors.background;
    context.fillRect(0, 0, layout.width, layout.height);
    context.fillStyle = CANVAS_IMAGE.colors.ink;
    context.textBaseline = 'top';
    context.textAlign = 'left';
    context.font = fontOf(layout.metaFontSize);
    let y = layout.margin;
    for (const text of lines.filter(Boolean)) {
      for (const line of wrapText(context, text, layout.width - layout.margin * 2, true)) {
        requireValue(y + layout.metaFontSize * 1.5 < footer.top, 'E_IMAGE', 'statistics.height', 'Choose a larger export size');
        context.fillText(line, layout.margin, y);
        y += layout.metaFontSize * 1.7;
      }
    }
    throwIfAborted(signal);
    drawFooter(context, layout, footer);
  } finally { context.restore(); }
  return Object.freeze({ kind: 'statistics-image', renderedBitmap: true });
}
