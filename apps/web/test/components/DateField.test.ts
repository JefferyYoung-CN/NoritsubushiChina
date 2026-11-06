/**
 * DateField 是原生 date 输入的受控包装：只有完整合法且在 [min, max] 内的值才提交，
 * 输入过程中的中间值只留在本地草稿，失焦时恢复最后一次已提交值。
 */
import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import DateField from '../../src/components/DateField.vue';

const wrappers: ReturnType<typeof mount>[] = [];
const render = (props: Record<string, unknown> = {}) => {
  const wrapper = mount(DateField, {
    props: { id: 'test-date', value: '2024-06-01', min: '1997-01-01', max: '2026-10-30', ...props },
  });
  wrappers.push(wrapper);
  return wrapper;
};
const input = (wrapper: ReturnType<typeof mount>) => wrapper.get('input');
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('DateField', () => {
  test('保留 id、min/max、disabled 与透传的 aria 属性', () => {
    const wrapper = render({
      disabled: true, 'aria-invalid': true, 'aria-labelledby': 'test-date-label', 'aria-describedby': 'stats-calc',
    });
    const field = input(wrapper);
    expect(field.attributes('id')).toBe('test-date');
    expect(field.attributes('type')).toBe('date');
    expect(field.attributes('min')).toBe('1997-01-01');
    expect(field.attributes('max')).toBe('2026-10-30');
    expect(field.attributes('disabled')).toBeDefined();
    expect(field.attributes('aria-invalid')).toBe('true');
    // 说明挂在整个日期控件（分组）上：Chromium 会把 input 上的 aria-describedby
    // 在年/月/日三个 spinbutton 上各念一遍，所以说明不能再落在 input 上。
    expect(field.attributes('aria-describedby')).toBeUndefined();
    const group = wrapper.get('[role="group"]');
    expect(group.attributes('aria-describedby')).toBe('stats-calc');
    // 名称只能有一个来源（走查 D1）：input 自己的 aria-labelledby 原样落下，分组不再重复持有。
    expect(field.attributes('aria-labelledby')).toBe('test-date-label');
    expect(group.attributes('aria-labelledby')).toBeUndefined();
    expect(group.find('input').exists()).toBe(true);
  });

  test('中间值 0002-10-30 只留在输入框，不 emit 也不改写', async () => {
    const wrapper = render();
    await input(wrapper).setValue('0002-10-30');
    expect(wrapper.emitted('change')).toBeUndefined();
    expect((input(wrapper).element as HTMLInputElement).value).toBe('0002-10-30');
  });

  test('输入过程中不清空或回写已提交值，只有失焦才恢复', async () => {
    const wrapper = render();
    const field = input(wrapper);
    // 原生 date 输入在日期未构成前自身 value 为空；组件不得在 input 事件里把已提交值写回去。
    (field.element as HTMLInputElement).value = '';
    await field.trigger('input');
    expect((field.element as HTMLInputElement).value).toBe('');
    expect(wrapper.emitted('change')).toBeUndefined();
  });

  test('完整合法且在范围内的值 emit 一次', async () => {
    const wrapper = render();
    await input(wrapper).setValue('2024-05-01');
    expect(wrapper.emitted('change')).toEqual([['2024-05-01']]);
  });

  test('格式合法但越界或格式不完整都不 emit', async () => {
    const wrapper = render();
    for (const value of ['2027-01-01', '1996-12-31', '2024-2-3', '']) {
      await input(wrapper).setValue(value);
      expect(wrapper.emitted('change')).toBeUndefined();
    }
  });

  test('失焦时把不合法或越界的草稿恢复为最后一次已提交值', async () => {
    const wrapper = render({ value: '2024-06-01' });
    const field = input(wrapper);
    await field.setValue('0002-10-30');
    await field.trigger('blur');
    expect((field.element as HTMLInputElement).value).toBe('2024-06-01');
    await field.setValue('2027-01-01');
    await field.trigger('blur');
    expect((field.element as HTMLInputElement).value).toBe('2024-06-01');
    // 合法提交后，失焦保留这次值而不是更早的值。
    await field.setValue('2024-05-01');
    await field.trigger('blur');
    expect((field.element as HTMLInputElement).value).toBe('2024-05-01');
  });

  test('外部值变化（换页/换快照）把输入框同步到权威值', async () => {
    const wrapper = render();
    await input(wrapper).setValue('0002');
    await wrapper.setProps({ value: '2020-01-01' });
    expect((input(wrapper).element as HTMLInputElement).value).toBe('2020-01-01');
  });
});
