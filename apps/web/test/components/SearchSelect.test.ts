import { afterEach, describe, expect, test, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchSelect from '../../src/components/SearchSelect.vue';

const options = [
  { id: 'a', label: '示例站 · 示例城 · A' },
  { id: 'b', label: '示例站 · 示例市 · B' },
  { id: 'c', label: '示例体育馆 · 示例城 · C', description: '示例线 · C' },
];
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); document.body.innerHTML = ''; });
function render(value = '') {
  const wrapper = mount(SearchSelect, { props: { id: 'station', label: '车站', modelValue: value, options,
    'onUpdate:modelValue': id => { void wrapper.setProps({ modelValue: id }); } }, attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}

describe('输入检索后下拉选择', () => {
  test('聚焦才展开，输入筛选；同名站标签保持完整，点击后收起并保留选择', async () => {
    const wrapper = render();
    const input = wrapper.get<HTMLInputElement>('input');
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    input.element.focus(); await wrapper.vm.$nextTick();
    await input.setValue('示例站');
    expect(wrapper.findAll('[role="option"]').map(row => row.text())).toEqual(options.slice(0, 2).map(row => row.label));
    await wrapper.findAll('[role="option"]')[1].trigger('click');
    expect(wrapper.props('modelValue')).toBe('b');
    expect(input.element.value).toBe(options[1].label);
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(input.element);
  });

  test('方向键移动、回车确认，活动项有可访问性关联且不触发表单提交', async () => {
    const wrapper = render();
    const input = wrapper.get('input');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(input.attributes('aria-activedescendant')).toBe('station-option-1');
    expect(wrapper.get('#station-option-1').classes()).toContain('active');
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.element.dispatchEvent(event); await wrapper.vm.$nextTick();
    expect(event.defaultPrevented).toBe(true);
    expect(wrapper.props('modelValue')).toBe('b');
    expect(input.attributes('aria-activedescendant')).toBeUndefined();
  });

  test.each(['Escape', 'Tab'])('%s 关闭并放弃尚未确认的文字，保留原值', async key => {
    const wrapper = render('a');
    const input = wrapper.get<HTMLInputElement>('input');
    await input.trigger('focus'); await input.setValue('体育');
    expect(wrapper.props('modelValue')).toBe('a');
    await input.trigger('keydown', { key });
    expect(input.element.value).toBe(options[0].label);
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  test('输入法确认文字不误选；合成结束后再按回车才选择', async () => {
    const wrapper = render(); const input = wrapper.get('input');
    await input.trigger('focus'); await input.trigger('compositionstart');
    await input.setValue('体育');
    await input.trigger('keydown', { key: 'Enter', isComposing: true });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await input.trigger('compositionend');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.props('modelValue')).toBe('c');
  });

  test('空结果可修改或清空查询，未匹配文字不会变成已选值', async () => {
    const wrapper = render(); const input = wrapper.get('input');
    await input.setValue('不存在');
    expect(wrapper.get('.no-results').text()).toContain('没有匹配项');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await wrapper.get('button').trigger('click');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(3);
    await input.setValue('示例线');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
  });

  test('失焦还原选择；禁用时关闭菜单；候选更新后不能选中旧结果', async () => {
    const wrapper = render('a'); const input = wrapper.get<HTMLInputElement>('input');
    await input.trigger('focus'); await input.setValue('体育');
    await input.trigger('focusout', { relatedTarget: document.body });
    expect(input.element.value).toBe(options[0].label);
    await input.trigger('focus');
    await wrapper.setProps({ options: [options[2]] });
    expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
    await wrapper.setProps({ disabled: true });
    expect(input.element.disabled).toBe(true);
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  test('靠近视口底部向上展开，滚动和窗口变化后重新计算空间', async () => {
    const wrapper = render();
    const rect = vi.spyOn(wrapper.element, 'getBoundingClientRect').mockReturnValue({ top: 650, bottom: 724 } as DOMRect);
    await wrapper.get('input').trigger('focus');
    await wrapper.vm.$nextTick();
    expect(wrapper.get('.popup').classes()).toContain('above');
    expect(wrapper.get('[role="listbox"]').attributes('style')).toContain('max-height: 286px');
    rect.mockReturnValue({ top: 100, bottom: 174 } as DOMRect);
    window.dispatchEvent(new Event('scroll')); await wrapper.vm.$nextTick();
    expect(wrapper.get('.popup').classes()).not.toContain('above');
    rect.mockReturnValue({ top: 650, bottom: 724 } as DOMRect);
    window.dispatchEvent(new Event('resize')); await wrapper.vm.$nextTick();
    expect(wrapper.get('.popup').classes()).toContain('above');
    rect.mockRestore();
  });
});
