// @vitest-environment node

import { h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CanvasTable from '@/components/designer/CanvasTable.vue';
import { OffscreenRenderer } from '@/core/render/OffscreenRenderer';

describe('CanvasTable SSR', () => {
  test('在 Node 环境中可以完成服务端渲染', async () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');

    const html = await renderToString(h(CanvasTable, {
      workbook: null,
      readOnly: true
    }));

    expect(html).toContain('vue-canvas-sheet-table-container');
  });

  test('OffscreenRenderer 在没有 window 时可以安全初始化', () => {
    const renderer = new OffscreenRenderer({
      canvas: null,
      theme: {},
      enableWorker: false
    });

    expect(renderer.dpr).toBe(1);
    expect(renderer.isInitialized).toBe(true);

    renderer.destroy();
  });
});
