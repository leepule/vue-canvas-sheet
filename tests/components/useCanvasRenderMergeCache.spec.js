import { describe, expect, it } from 'vitest';
import useCanvasRender from '../../src/components/designer/hooks/useCanvasRender.js';

describe('useCanvasRender 合并单元格网格缓存', () => {
  it('网格缓存签名应包含合并区域，合并后不再复用旧网格缓存', () => {
    const tableContext = {
      props: {
        workbook: {
          merges: [],
          freeze: { r: 0, c: 0 },
          getLayoutVersion: () => 1
        }
      },
      state: {
        width: 800,
        height: 600,
        scrollX: 0,
        scrollY: 0,
        tableTheme: {}
      },
      computed: {
        rowHeaderWidth: { value: 40 },
        colHeaderHeight: { value: 30 }
      }
    };
    const range = {
      startRow: 0,
      endRow: 10,
      startCol: 0,
      endCol: 10
    };
    const { _getGridRenderSignature } = useCanvasRender(tableContext);
    const before = _getGridRenderSignature(range);

    tableContext.props.workbook.merges = [
      { s: { r: 1, c: 1 }, e: { r: 2, c: 3 } }
    ];
    const afterMerge = _getGridRenderSignature(range);
    expect(afterMerge).not.toBe(before);

    tableContext.props.workbook.merges = [];
    const afterUnmerge = _getGridRenderSignature(range);
    expect(afterUnmerge).toBe(before);
  });
});
