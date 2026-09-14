import { describe, expect, it, vi } from 'vitest';
import { TableTheme } from '@/components/designer/config';
import useCanvasRender from '@/components/designer/hooks/useCanvasRender';

function createContext() {
  return {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    setLineDash: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1
  };
}

describe('填充拖拽预览', () => {
  it('拖动右下角手柄时应高亮源选区之外的目标区域', () => {
    const ctx = createContext();
    const sourceRange = { s: { r: 1, c: 1 }, e: { r: 2, c: 1 } };
    const workbook = {
      freeze: { r: 0, c: 0 },
      selection: { s: { r: 1, c: 1 }, e: { r: 2, c: 1 } },
      activeCell: { r: 1, c: 1 },
      getFrozenSize: () => ({ w: 0, h: 0 }),
      getColPos: c => c * 100,
      getRowPos: r => r * 25
    };
    const tableContext = {
      props: { workbook, readOnly: false },
      state: {
        ctxSelection: ctx,
        width: 500,
        height: 400,
        tableTheme: TableTheme,
        scrollX: 0,
        scrollY: 0,
        isDraggingFill: true,
        fillStartRange: sourceRange,
        fillTargetRange: { s: { r: 1, c: 1 }, e: { r: 4, c: 1 } },
        dragOverCell: null
      },
      computed: {
        rowHeaderWidth: { value: 40 },
        colHeaderHeight: { value: 24 }
      },
      methods: {
        getCellScreenRect: vi.fn()
      }
    };

    const { _renderSelection } = useCanvasRender(tableContext);
    _renderSelection();

    expect(ctx.fillRect).toHaveBeenCalledWith(140, 99, 100, 50);
    expect(ctx.strokeRect).toHaveBeenCalledWith(140, 99, 100, 50);
    expect(ctx.setLineDash).toHaveBeenCalledWith([4, 3]);
  });
});
