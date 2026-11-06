import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchSelect from '../../src/components/SearchSelect.vue';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); document.body.innerHTML = ''; });

const OPTIONS = [
  { id: 'a', label: '示例站 · 示例城 · A' },
  { id: 'b', label: '示例站 · 示例市 · B' },
];

describe('Esc 关闭候选要有可播报反馈（走查发现 8）', () => {
  test('候选已展开时按 Esc 会播报「已关闭候选列表」', async () => {
    const wrapper = mount(SearchSelect, {
      props: { id: 'station', label: '车站', modelValue: '', options: OPTIONS }, attachTo: document.body,
    });
    wrappers.push(wrapper);
    const input = wrapper.get('input');
    const status = () => wrapper.get('#station-status').text();

    await input.trigger('focus');
    expect(input.attributes('aria-expanded')).toBe('true');
    expect(status()).toBe('');

    await input.trigger('keydown', { key: 'Escape' });
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(status()).toContain('已关闭候选列表');
  });

  test('候选本就收起时再按 Esc 保持静默，不重复播报同一句', async () => {
    const wrapper = mount(SearchSelect, {
      props: { id: 'station', label: '车站', modelValue: '', options: OPTIONS }, attachTo: document.body,
    });
    wrappers.push(wrapper);
    const input = wrapper.get('input');
    const status = () => wrapper.get('#station-status').text();
    await input.trigger('focus');
    await input.trigger('keydown', { key: 'Escape' });
    expect(status()).toContain('已关闭候选列表');
    // 第二次 Esc 时候选已收起：close() 会清空实时区域，读屏不会重复念同一句话。
    await input.trigger('keydown', { key: 'Escape' });
    expect(status()).toBe('');
  });
});

/**
 * 页头 logo 的图标字母 `N` 保持可见并被念出，是既有设计：axe 的
 * 「可访问名必须包含可见文本」要求名称里出现这枚字母，用 aria-hidden 藏掉它
 * 换来的是朗读更顺，代价是违反该规则，故本轮不改（见交付说明）。
 */
