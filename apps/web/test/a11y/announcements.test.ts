import { afterEach, describe, expect, test } from 'vitest';
import { mount } from '@vue/test-utils';
import BackupPanel from '../../src/backup/BackupPanel.vue';
import SavedRecordsPanel from '../../src/records/SavedRecordsPanel.vue';
import { errorFeedback } from '../../src/input';
import { lookupNetwork } from '../integration/fixtures';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('本地存储打不开时的诊断（C07）', () => {
  test('DOMException 归为存储不可用，不再建议检查网络', () => {
    const feedback = errorFeedback(new DOMException('P6 injected failure', 'SecurityError'));
    expect(feedback.code).toBe('E_STORAGE_UNAVAILABLE');
    expect(feedback.retryable).toBe(true);
    expect(feedback.message).toContain('本地存储');
    expect(feedback.message).not.toMatch(/检查连接|E_NETWORK|网络/);
  });

  test('浏览器其他拒绝方式（配额、不支持）同样归为存储不可用', () => {
    for (const name of ['QuotaExceededError', 'NotSupportedError', 'InvalidStateError']) {
      expect(errorFeedback(new DOMException('x', name)).code).toBe('E_STORAGE_UNAVAILABLE');
    }
  });

  test('带业务码的错误不被改写，普通网络失败仍是 E_NETWORK', () => {
    expect(errorFeedback({ code: 'E_STORAGE', message: '本地存储写入失败' }).code).toBe('E_STORAGE');
    expect(errorFeedback(new TypeError('Failed to fetch')).code).toBe('E_NETWORK');
    expect(errorFeedback(new TypeError('Failed to fetch')).message).toContain('检查连接');
  });
});

describe('实时播报容器常驻（C06）', () => {
  test('无消息时 role=status 容器已在页面上，出现消息时换文而不是新建节点', async () => {
    const wrapper = mount(BackupPanel, { props: { canPickFile: true, today: '2026-11-03', state: { phase: 'idle' } } as never });
    wrappers.push(wrapper);

    const region = () => wrapper.find('[role="status"][aria-live="polite"]');
    expect(region().exists()).toBe(true);
    const node = region().element;
    expect(node.textContent?.trim()).toBe('');

    const withMessage = mount(BackupPanel, {
      props: { canPickFile: true, today: '2026-11-03', state: { phase: 'error', message: '备份内容无效或超出体积上限；已整份拒绝。' } } as never,
    });
    wrappers.push(withMessage);
    expect(withMessage.find('[role="status"][aria-live="polite"]').text()).toContain('已整份拒绝');
  });
});

describe('取消删除要有可播报反馈（A20）', () => {
  test('已保存页始终挂着实时播报区域', () => {
    const wrapper = mount(SavedRecordsPanel, {
      props: { network: lookupNetwork(), facts: { basic: [], advanced: [] } },
    });
    wrappers.push(wrapper);
    const region = wrapper.find('.sr-only[role="status"][aria-live="polite"]');
    expect(region.exists()).toBe(true);
    expect(region.element.textContent?.trim()).toBe('');
  });
});
