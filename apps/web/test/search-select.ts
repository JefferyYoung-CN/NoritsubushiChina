import type { VueWrapper } from '@vue/test-utils';

/** 通过用户可见菜单选值；不会绕过控件的候选过滤和选择事件。 */
export async function choose(wrapper: VueWrapper, id: string, value: string): Promise<void> {
  await wrapper.get(`#${id}`).trigger('focus');
  const option = wrapper.findAll(`#${id}-listbox [role="option"]`).find(row => row.attributes('data-value') === value);
  if (!option) throw new Error(`${id} has no available option ${value}`);
  await option.trigger('click');
}

export async function optionValues(wrapper: VueWrapper, id: string): Promise<string[]> {
  await wrapper.get(`#${id}`).trigger('focus');
  const values = wrapper.findAll(`#${id}-listbox [role="option"]`).map(row => row.attributes('data-value')!);
  await wrapper.get(`#${id}`).trigger('keydown', { key: 'Escape' });
  return values;
}
