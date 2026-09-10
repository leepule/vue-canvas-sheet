import { createApp, h } from 'vue';
import SvgIcon from '@/components/designer/icons/SvgIcon.vue';

const iconNames = [
  'align-bottom',
  'align-center',
  'align-left',
  'align-middle',
  'align-right',
  'align-top',
  'bold',
  'border-all',
  'border-left',
  'border-none',
  'border-outline',
  'border-top',
  'clear-formatting',
  'close',
  'code',
  'color-palette',
  'decimal-decrease',
  'decimal-increase',
  'document-csv',
  'document-xls',
  'find',
  'italic',
  'menu',
  'merge-cells',
  'numbered-list',
  'percent',
  'pin',
  'redo',
  'strike-through',
  'text-wrap',
  'undo',
  'upload'
];

function renderIcon(name) {
  const container = document.createElement('div');
  const app = createApp({
    render: () => h(SvgIcon, { name })
  });

  app.mount(container);
  return {
    html: container.innerHTML,
    unmount: () => app.unmount()
  };
}

describe('SvgIcon', () => {
  test.each(iconNames)('应该按需渲染已使用的 Lucide 图标: %s', (name) => {
    const icon = renderIcon(name);

    expect(icon.html).toContain('<svg');
    expect(icon.html).toContain('lucide-');
    icon.unmount();
  });

  test('未知图标应该保持为空而不是引入全量图标', () => {
    const icon = renderIcon('not-a-real-icon');

    expect(icon.html).not.toContain('<svg');
    icon.unmount();
  });

  test('icons 子入口应该暴露 Lucide Vue 图标组件', async () => {
    const icons = await import('../../src/icons/index.js');

    expect(typeof icons.FileSpreadsheet).toBe('function');
    expect(typeof icons.Search).toBe('function');
    expect(typeof icons.TableCellsMerge).toBe('function');
  });
});
