import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import TransitMap from '../../src/map/TransitMap.vue';
import type { SectionStatus } from '../../src/map/types';
import { makeNetwork, makeStation, twoStationNetwork } from './fixtures';

type MapProps = InstanceType<typeof TransitMap>['$props'];

const mountMap = (props: Partial<MapProps> = {}) => mount(TransitMap, { props: { network: twoStationNetwork(), ...props } });

describe('可访问性与语义结构', () => {
  it('svg 带 role=img 与 title/desc，并互相通过 aria-labelledby 关联', () => {
    const wrapper = mountMap();
    const svg = wrapper.find('svg');
    expect(svg.exists()).toBe(true);
    expect(svg.attributes('role')).toBe('img');
    const titleId = svg.find('title').attributes('id');
    const descId = svg.find('desc').attributes('id');
    expect(titleId).toBeTruthy();
    expect(descId).toBeTruthy();
    expect(svg.attributes('aria-labelledby')).toBe(`${titleId} ${descId}`);
    expect(svg.find('title').text()).toBe('线路示意图');
    expect(svg.find('desc').text()).toContain('2 个车站');
    expect(svg.find('desc').text()).toContain('无底图');
  });

  it('每个车站都是可聚焦按钮并带可读名称', () => {
    const wrapper = mountMap();
    const stations = wrapper.findAll('g.map-station');
    expect(stations).toHaveLength(2);
    for (const station of stations) {
      expect(station.attributes('tabindex')).toBe('0');
      expect(station.attributes('role')).toBe('button');
      expect(station.attributes('aria-label')).toBeTruthy();
    }
    expect(stations[1].attributes('aria-label')).toContain('新宿');
  });

  it('选中态同时用 aria-pressed 与额外圆环表达，不只靠颜色', () => {
    const wrapper = mountMap({ selectedStationId: 's2' });
    const selected = wrapper.find('.map-station--selected');
    expect(selected.attributes('data-station-id')).toBe('s2');
    expect(selected.attributes('aria-pressed')).toBe('true');
    expect(selected.attributes('aria-label')).toContain('已选中');
    expect(selected.find('.map-station__ring').exists()).toBe(true);
  });

  it('图例用线型（非颜色）区分区间状态', () => {
    const wrapper = mountMap();
    expect(wrapper.findAll('.map-legend__item')).toHaveLength(3);
    const dashFor = (status: SectionStatus): string | undefined =>
      wrapper.find(`.map-legend__item[data-status="${status}"] line`).attributes('stroke-dasharray');
    expect(dashFor('operated')).toBeUndefined();
    expect(dashFor('temporary')).toBe('7 5');
    expect(wrapper.find('.map-legend__item[data-status="retired"]').exists()).toBe(false);
    expect(wrapper.find('desc').text()).not.toContain('废线');
  });

  it('临时停运区间本身带虚线，颜色不是唯一编码', () => {
    const network = twoStationNetwork({
      policies: {
        noMileageSections: [], closures: [],
        suspensions: [{ lineId: 'l1', sectionIds: ['sec1'], from: '2020-01-01', until: '2099-01-01' }],
      },
    });
    const wrapper = mountMap({ network });
    const path = wrapper.find('.transit-map__section');
    expect(path.attributes('data-status')).toBe('temporary');
    expect(path.attributes('stroke-dasharray')).toBe('7 5');
  });

  it('显示坐标来源署名且链接可点击', () => {
    const wrapper = mountMap();
    const link = wrapper.find('.transit-map__attribution a');
    expect(link.attributes('href')).toBe('https://www.openstreetmap.org/copyright');
    expect(link.text()).toBe('© OpenStreetMap contributors');
  });
});

describe('交互', () => {
  it('点击车站触发 select 事件', async () => {
    const wrapper = mountMap();
    await wrapper.find('.map-station').trigger('click');
    expect(wrapper.emitted('select')).toEqual([['s1']]);
  });

  it('回车与空格都能选中，键盘与鼠标等价', async () => {
    const wrapper = mountMap();
    const stations = wrapper.findAll('.map-station');
    await stations[0].trigger('keydown', { key: 'Enter' });
    await stations[1].trigger('keydown', { key: ' ' });
    expect(wrapper.emitted('select')).toEqual([['s1'], ['s2']]);
  });

  it('onSelect 回调是 emit 之外的适配器，两者收到同一站', async () => {
    const onSelect = vi.fn();
    const wrapper = mountMap({ onSelect });
    await wrapper.find('.map-station').trigger('click');
    expect(onSelect).toHaveBeenCalledWith('s1');
    expect(wrapper.emitted('select')).toEqual([['s1']]);
  });

  it('高亮区间用更粗的线宽表达，仍是同一状态线型', () => {
    const wrapper = mountMap({ highlightSectionIds: ['sec1'] });
    const path = wrapper.find('.transit-map__section');
    expect(path.attributes('stroke-width')).toBe('4');
    expect(path.attributes('stroke')).toBe('#0f766e');
  });
});

describe('降级与空状态', () => {
  it('缺坐标时禁用地图，只显示可读说明，不画任何图形', () => {
    const network = twoStationNetwork({
      latitudesLongitudes: [
        [35.681236, 139.767125],
        [null, null],
      ],
    });
    const wrapper = mountMap({ network });
    expect(wrapper.find('svg').exists()).toBe(false);
    expect(wrapper.find('.transit-map__stations').exists()).toBe(false);
    const notice = wrapper.find('[role="status"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('缺少可信的经纬度坐标');
    expect(notice.text()).toContain('地图已关闭');
  });

  it('空站点子集显示空状态说明', () => {
    const wrapper = mountMap({ stations: [] });
    expect(wrapper.find('svg').exists()).toBe(false);
    expect(wrapper.find('[role="status"]').text()).toContain('没有可展示的车站');
  });

  it('拆分站按目标身份分别渲染标签', () => {
    const network = makeNetwork({
      stations: [makeStation('s1', '新宿', 'SJK-A', 35.69, 139.7), makeStation('s2', '新宿', 'SJK-B', 35.6, 139.7)],
    });
    const wrapper = mountMap({ network });
    const texts = wrapper.findAll('.transit-map__label').map(label => label.text());
    expect(texts).toContain('新宿（SJK-A）');
    expect(texts).toContain('新宿（SJK-B）');
  });

  it('同坐标的站各渲染一个标签，不触发省略提示', () => {
    const network = makeNetwork({
      stations: [makeStation('s1', '甲', 'A', 35.68, 139.76), makeStation('s2', '乙', 'B', 35.68, 139.76)],
    });
    const wrapper = mountMap({ network });
    // 同一点放不下两个同侧标签：第二个退到另一侧，因此两个都渲染、没有省略。
    expect(wrapper.findAll('.transit-map__label')).toHaveLength(2);
    expect(wrapper.find('.map-legend__note').exists()).toBe(false);
  });
});

describe('尺寸与响应式', () => {
  it('不写死像素宽高，靠 viewBox 等比缩放，窄屏不会横向撑破', () => {
    const wrapper = mountMap({ width: 390, height: 260 });
    const svg = wrapper.find('svg');
    expect(svg.attributes('width')).toBeUndefined();
    expect(svg.attributes('height')).toBeUndefined();
    expect(svg.attributes('viewBox')).toBe('0 0 390 260');
    expect(svg.attributes('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(wrapper.find('.transit-map__canvas').exists()).toBe(true);
  });

  it('投影类型可注入，切换后同一网络仍能渲染', () => {
    const wrapper = mountMap({ projection: 'equirectangular' });
    expect(wrapper.find('svg').exists()).toBe(true);
    expect(wrapper.findAll('.map-station')).toHaveLength(2);
  });
});
