import { describe, expect, test } from 'vitest';
import { paintSections, SECTION_PAINT, sectionPaint, SELECTED_RING } from '../../src/records/section-paint';

describe('区间着色优先级', () => {
  test('完乘可用时按总体完乘并集区分已乘坐与未乘坐', () => {
    const paint = paintSections(['a', 'b'], { completionReady: true, completedSectionIds: ['a'] });
    expect(paint.get('a')).toEqual({ state: 'completed', selected: false });
    expect(paint.get('b')).toEqual({ state: 'unridden', selected: false });
  });

  test('完乘不可用时一律「未知」，绝不落成「未乘坐」（反向断言）', () => {
    const paint = paintSections(['a', 'b'], { completionReady: false, completedSectionIds: ['a'], selectedSectionIds: ['b'] });
    expect([...paint.values()].map(row => row.state)).toEqual(['unknown', 'unknown']);
    expect([...paint.values()].some(row => row.state === 'unridden')).toBe(false);
    // 降级只画中性线：连本次所选外圈也不画。
    expect([...paint.values()].some(row => row.selected)).toBe(false);
    // 「不知道」与「没乘过」不能画成同一条线，否则降级会被读成未乘坐。
    expect(SECTION_PAINT.unknown.stroke).not.toBe(SECTION_PAINT.unridden.stroke);
  });

  test('临时停运优先：不叠完乘色，也不叠本次所选外圈', () => {
    const paint = paintSections(['a'], { completionReady: true, completedSectionIds: ['a'],
      suspendedSectionIds: ['a'], selectedSectionIds: ['a'] });
    expect(paint.get('a')).toEqual({ state: 'suspended', selected: false, ridden: true });
    expect(SECTION_PAINT.suspended.dash).toEqual(expect.any(String));
    // 底色随乘坐状态：已乘坐取灰、未乘坐取蓝、完乘不可用取中性。
    expect(sectionPaint({ state: 'suspended', selected: false, ridden: true }).stroke)
      .toBe(SECTION_PAINT.completed.stroke);
    expect(sectionPaint({ state: 'suspended', selected: false, ridden: false }).stroke)
      .toBe(SECTION_PAINT.unridden.stroke);
    expect(sectionPaint({ state: 'suspended', selected: false, ridden: null }).stroke)
      .toBe(SECTION_PAINT.suspended.stroke);
    expect(sectionPaint({ state: 'suspended', selected: false, ridden: true }).dash)
      .toBe(SECTION_PAINT.suspended.dash);
  });

  test('停运区间在完乘不可用时记 ridden: null，只画中性虚线', () => {
    const paint = paintSections(['a'], { completionReady: false, completedSectionIds: ['a'],
      suspendedSectionIds: ['a'] });
    expect(paint.get('a')).toEqual({ state: 'suspended', selected: false, ridden: null });
  });

  test('未乘坐取蓝细线、已乘坐取灰粗线：图与图例共用 SECTION_PAINT 这一份样式', () => {
    const paint = paintSections(['a', 'b'], { completionReady: true, completedSectionIds: ['a'] });
    expect(sectionPaint(paint.get('a')!).stroke).toBe(SECTION_PAINT.completed.stroke);
    expect(sectionPaint(paint.get('b')!).stroke).toBe(SECTION_PAINT.unridden.stroke);
    expect(SECTION_PAINT.unridden.stroke).not.toBe(SECTION_PAINT.completed.stroke);
    // 用户故事 19：已乘坐与未乘坐不能只靠颜色区分——已乘坐加粗，宽度与本次所选外圈一致。
    expect(SECTION_PAINT.completed.dash).toBeNull();
    expect(SECTION_PAINT.unridden.dash).toBeNull();
    expect(SECTION_PAINT.completed.width).toBeGreaterThan(SECTION_PAINT.unridden.width);
    expect(SECTION_PAINT.completed.width).toBe(SELECTED_RING.outer.width);
  });

  test('本次所选与完乘色分层：外圈比底色宽，停运区间除外', () => {
    const paint = paintSections(['a', 'b'], { completionReady: true, completedSectionIds: ['a'],
      selectedSectionIds: ['a', 'b'] });
    expect(paint.get('a')).toEqual({ state: 'completed', selected: true });
    expect(paint.get('b')).toEqual({ state: 'unridden', selected: true });
    expect(SELECTED_RING.outer.width).toBeGreaterThan(SELECTED_RING.gap.width);
    expect(SELECTED_RING.gap.width).toBeGreaterThan(SELECTED_RING.baseWidth);
  });

  test('只为传入的区间产出样式，不猜未列出的区间', () => {
    const paint = paintSections([], { completionReady: true, completedSectionIds: ['a'] });
    expect(paint.size).toBe(0);
  });
});
