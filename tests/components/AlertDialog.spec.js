// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import { createApp } from 'vue';
import AlertDialog from '@/components/designer/AlertDialog.vue';

function waitFor(duration) {
  return new Promise(resolve => setTimeout(resolve, duration));
}

describe('AlertDialog 自定义弹窗', () => {
  test('打开后展示标题和内容，关闭后移除弹窗', async () => {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    document.body.appendChild(container);

    const app = createApp(AlertDialog);
    const dialog = app.mount(container);

    dialog.open({
      title: '无法编辑',
      message: '单元格正由用户 "Alice" 编辑锁定中'
    });
    await dialog.$nextTick();

    const dialogElement = document.body.querySelector('.alert-dialog');
    expect(dialogElement).toBeTruthy();
    expect(dialogElement.getAttribute('role')).toBe('alertdialog');
    expect(document.body.querySelector('.alert-dialog-title').textContent).toBe('无法编辑');
    expect(document.body.querySelector('.alert-dialog-message').textContent)
      .toBe('单元格正由用户 "Alice" 编辑锁定中');

    document.body.querySelector('.alert-dialog-actions button').click();
    await waitFor(220);
    expect(document.body.querySelector('.alert-dialog')).toBeNull();

    app.unmount();
    container.remove();
  });
});
