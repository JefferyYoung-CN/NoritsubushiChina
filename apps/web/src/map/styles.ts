import type { SectionStatus } from './types';

/**
 * 区间与车站的视觉编码集中在一处，组件与图例共用，避免两套样式漂移。
 *
 * 非颜色唯一编码：运营与临时停运由实线/虚线区分，颜色只是辅助；高亮用线宽表达。
 * 废线只进入统计，不提供地图样式。
 */
export interface SectionVisual {
  readonly stroke: string;
  readonly dash: string;
  readonly width: number;
  /** 图例文字，同时是非颜色编码的可读说明。 */
  readonly description: string;
}

export const SECTION_STYLE: Readonly<Record<Exclude<SectionStatus, 'retired'>, SectionVisual>> = {
  operated: { stroke: '#334155', dash: 'none', width: 2, description: '运营区间（实线）' },
  temporary: { stroke: '#b45309', dash: '7 5', width: 2, description: '临时停运（虚线）' },
};

export const HIGHLIGHT_STROKE = '#0f766e';
export const HIGHLIGHT_WIDTH = 4;
export const STATION_FILL = '#0f172a';
export const STATION_RING = '#0f766e';
export const STATION_LABEL = '#1e293b';
