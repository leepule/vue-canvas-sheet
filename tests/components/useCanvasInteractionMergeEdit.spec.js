import { describe, expect, it, vi } from 'vitest';
import useCanvasInteraction from '../../src/components/designer/hooks/useCanvasInteraction.js';

function createMergedTableContext() {
  const merge = { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } };
  const workbook = {
    freeze: { r: 0, c: 0 },
    merges: [merge],
    getMerge: (r, c) =>
      r >= merge.s.r && r <= merge.e.r && c >= merge.s.c && c <= merge.e.c
        ? merge
        : null,
    getCell: (r, c) => (r === 0 && c === 0 ? { v: '主单元格' } : null),
    getColPos: (c) => c * 50,
    getRowPos: (r) => r * 30,
    getColWidth: () => 50,
    getRowHeight: () => 30,
    plugins: {
      getSharedState: () => null
    }
  };

  return {
    props: {
      workbook,
      readOnly: false
    },
    state: {
      width: 220,
      height: 100,
      scrollX: 200,
      scrollY: 0,
      isEditing: false,
      editorVisible: false,
      editValue: '',
      editingCell: null,
      editorPos: { x: 0, y: 0, w: 0, h: 0 }
    },
    computed: {
      rowHeaderWidth: { value: 40 },
      colHeaderHeight: { value: 30 }
    },
    refs: {
      canvas: { value: null },
      editor: { value: null }
    },
    methods: {
      syncScrollbars: vi.fn(),
      updateEditorPosition: vi.fn(),
      invalidate: vi.fn()
    }
  };
}

describe('useCanvasInteraction 合并单元格编辑', () => {
  it('双击合并区域任意位置应编辑左上角，并显示部分可见的编辑器', () => {
    const tableContext = createMergedTableContext();
    const { startEdit } = useCanvasInteraction(tableContext);

    startEdit(0, 4);

    expect(tableContext.state.editingCell).toEqual({ r: 0, c: 0 });
    expect(tableContext.state.editValue).toBe('主单元格');
    expect(tableContext.state.isEditing).toBe(true);
    expect(tableContext.state.editorVisible).toBe(true);
    expect(tableContext.state.scrollX).toBe(0);
    expect(tableContext.methods.syncScrollbars).toHaveBeenCalledTimes(1);
    expect(tableContext.methods.invalidate).toHaveBeenCalledWith(null, { scroll: true });
  });

  it('整行合并编辑时编辑器不应覆盖左侧行号', () => {
    const tableContext = createMergedTableContext();
    const { updateEditorPosition } = useCanvasInteraction(tableContext);
    tableContext.state.isEditing = true;
    tableContext.state.editingCell = { r: 0, c: 0 };
    tableContext.state.scrollX = 200;

    updateEditorPosition();

    expect(tableContext.state.editorPos.x).toBe(40);
    expect(tableContext.state.editorPos.y).toBe(30);
    expect(tableContext.state.editorPos.w).toBe(100);
    expect(tableContext.state.editorPos.h).toBe(30);
    expect(tableContext.state.editorVisible).toBe(true);
  });
});
