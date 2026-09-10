import { cloneRange } from '../../../core/utils/Clipboard';
import { rafThrottle, throttle } from '../../../core/events/EventUtils';
import useCanvasClipboard from './useCanvasClipboard';

export default function useCanvasInteraction(tableContext) {
  // 节流与拖拽相关的局部非响应式状态
  let _throttledDetectResize = null;
  let _throttledScrollIntoView = null;
  let _dragAbortController = null;
  let _lastMoveEvent = null;
  let _ticking = false;

  /**
   * 判断行列范围是否包含他人锁定的单元格
   */
  function isRangeLocked(sR, sC, eR, eC) {
    const isLocked = tableContext.props.workbook.plugins.getSharedState('collaboration:isCellLocked');
    if (!isLocked) return false;
    for (let r = sR; r <= eR; r++) {
      for (let c = sC; c <= eC; c++) {
        if (isLocked(r, c)) return true;
      }
    }
    return false;
  }

  /**
   * 判断当前选区是否包含他人锁定的单元格
   */
  function isSelectionLocked() {
    const sel = tableContext.props.workbook.selection;
    if (!sel) return false;
    return isRangeLocked(sel.s.r, sel.s.c, sel.e.r, sel.e.c);
  }

  const { handleCopy, handlePaste } = useCanvasClipboard({
    getWorkbook: () => tableContext.props.workbook,
    isReadOnly: () => tableContext.props.readOnly,
    isRangeLocked
  });

  /**
   * 初始化节流/防抖方法
   */
  function _initThrottledMethods() {
    _throttledDetectResize = throttle((x, y) => {
      _detectResizeZoneImpl(x, y);
    }, 32);

    _throttledScrollIntoView = rafThrottle((r, c) => {
      _scrollIntoViewImpl(r, c);
    });
  }

  /**
   * 清理节流/防抖方法
   */
  function _cleanupThrottledMethods() {
    if (_throttledDetectResize) {
      _throttledDetectResize.cancel();
    }
    if (_throttledScrollIntoView) {
      _throttledScrollIntoView.cancel();
    }
    _detachDragListeners();
  }

  /**
   * 绑定全局拖拽监听器
   */
  function _attachDragListeners() {
    _detachDragListeners();
    const controller = new AbortController();
    _dragAbortController = controller;
    const { signal } = controller;
    window.addEventListener('mousemove', handleThrottledMouseMove, { signal });
    window.addEventListener('mouseup', handleWindowMouseUp, { signal });
  }

  /**
   * 解绑全局拖拽监听器
   */
  function _detachDragListeners() {
    if (_dragAbortController) {
      _dragAbortController.abort();
      _dragAbortController = null;
    }
  }

  function handleMouseDown(e) {
    if (e.target.closest('.vue-canvas-sheet-scrollbar-h') ||
        e.target.closest('.vue-canvas-sheet-scrollbar-v')) {
        return;
    }

    if (tableContext.methods.pauseProgressiveRender) {
      tableContext.methods.pauseProgressiveRender();
    }

    const rect = tableContext.refs.canvas.value.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    _attachDragListeners();

    if (e.button === 2) {
      const c = getColAt(x);
      const r = getRowAt(y);
      const sel = tableContext.props.workbook.selection;

      if (sel && r >= sel.s.r && r <= sel.e.r && c >= sel.s.c && c <= sel.e.c) {
        return;
      }
    }

    if (tableContext.state.fillHandleRect) {
      const hRect = tableContext.state.fillHandleRect;

      if (x >= hRect.x - 3 && x <= hRect.x + hRect.w + 3 &&
        y >= hRect.y - 3 && y <= hRect.y + hRect.h + 3) {
        tableContext.state.isDraggingFill = true;
        tableContext.state.fillStartRange = cloneRange(tableContext.props.workbook.selection);

        return;
      }
    }

    if (tableContext.state.resizeCursor) {
      if (tableContext.state.resizeCursor === 'col-resize') {
        tableContext.state.isResizingCol = true;
        tableContext.state.resizingIndex = tableContext.state.hoverResizeIndex;
        tableContext.state.resizingStartSize = tableContext.props.workbook.getColWidth(tableContext.state.resizingIndex);
        tableContext.state.resizingStartPos = x;
      } else {
        tableContext.state.isResizingRow = true;
        tableContext.state.resizingIndex = tableContext.state.hoverResizeIndex;
        tableContext.state.resizingStartSize = tableContext.props.workbook.getRowHeight(tableContext.state.resizingIndex);
        tableContext.state.resizingStartPos = y;
      }
      return;
    }

    const RW = tableContext.computed.rowHeaderWidth.value;
    const CH = tableContext.computed.colHeaderHeight.value;

    if (y < CH && x < RW) {
      tableContext.props.workbook.setSelection(0, 0, tableContext.props.workbook.rowCount - 1, tableContext.props.workbook.colCount - 1);
      return;
    }

    if (y < CH && x > RW) {
      const c = getColAt(x);
      if (c >= 0) {
        tableContext.props.workbook.setSelection(0, c, tableContext.props.workbook.rowCount - 1, c);
        tableContext.state.isSelectingCol = true;
        tableContext.state.dragColStartIndex = c;
        return;
      }
    }

    if (x < RW && y > CH) {
      const r = getRowAt(y);
      if (r >= 0) {
        tableContext.props.workbook.setSelection(r, 0, r, tableContext.props.workbook.colCount - 1);
        tableContext.state.isSelectingRow = true;
        tableContext.state.dragRowStartIndex = r;
        return;
      }
    }

    const c = getColAt(x);
    const r = getRowAt(y);

    if (c >= 0 && r >= 0) {
      tableContext.state.isDragging = true;
      tableContext.props.workbook.setSelection(r, c, r, c);
    }
  }

  function handleThrottledMouseMove(e) {
    _lastMoveEvent = e;
    if (_ticking) return;
    _ticking = true;
    requestAnimationFrame(() => {
      const evt = _lastMoveEvent;
      _lastMoveEvent = null;
      handleMouseMove(evt);
      _ticking = false;
    });
  }

  function handleWindowMouseUp(e) {
    handleMouseUp(e);
    _detachDragListeners();
    _ticking = false;
  }

  function handleMouseMove(e) {
    if (!tableContext.refs.canvas.value) return;
    const rect = tableContext.refs.canvas.value.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (tableContext.state.isDraggingFill) {
      const c = getColAt(x);
      const r = getRowAt(y);

      if (c >= 0 && r >= 0) {
        const sel = tableContext.state.fillStartRange;
        let target = cloneRange(sel);

        const diffR = Math.max(r - sel.e.r, sel.s.r - r);
        const diffC = Math.max(c - sel.e.c, sel.s.c - c);

        if (r > sel.e.r && diffR >= diffC) {
          target.e.r = r;
        } else if (c > sel.e.c && diffC > diffR) {
          target.e.c = c;
        }

        tableContext.state.fillTargetRange = target;
        tableContext.methods._renderSelection();
      }
      return;
    }

    if (tableContext.state.isSelectingRow) {
      const r = getRowAt(y);
      if (r >= 0) {
        const start = Math.min(tableContext.state.dragRowStartIndex, r);
        const end = Math.max(tableContext.state.dragRowStartIndex, r);
        tableContext.props.workbook.setSelection(start, 0, end, tableContext.props.workbook.colCount - 1);
      }
      return;
    }

    if (tableContext.state.isSelectingCol) {
      const c = getColAt(x);
      if (c >= 0) {
        const start = Math.min(tableContext.state.dragColStartIndex, c);
        const end = Math.max(tableContext.state.dragColStartIndex, c);
        tableContext.props.workbook.setSelection(0, start, tableContext.props.workbook.rowCount - 1, end);
      }
      return;
    }

    if (tableContext.state.isResizingCol) {
      const delta = x - tableContext.state.resizingStartPos;
      const newW = Math.max(5, tableContext.state.resizingStartSize + delta);
      const colWidths = { ...tableContext.props.workbook.colWidths };
      colWidths[tableContext.state.resizingIndex] = newW;
      tableContext.props.workbook.colWidths = colWidths;
      tableContext.props.workbook.markLayoutDirty();
      tableContext.props.workbook.notify();
      return;
    }

    if (tableContext.state.isResizingRow) {
      const delta = y - tableContext.state.resizingStartPos;
      const newH = Math.max(5, tableContext.state.resizingStartSize + delta);
      const rowHeights = { ...tableContext.props.workbook.rowHeights };
      rowHeights[tableContext.state.resizingIndex] = newH;
      tableContext.props.workbook.rowHeights = rowHeights;
      tableContext.props.workbook.markLayoutDirty();
      tableContext.props.workbook.notify();
      return;
    }

    if (!tableContext.state.isDragging && !tableContext.state.isDraggingCol) {
       if (tableContext.state.fillHandleRect) {
         const hRect = tableContext.state.fillHandleRect;
         if (x >= hRect.x - 3 && x <= hRect.x + hRect.w + 3 &&
           y >= hRect.y - 3 && y <= hRect.y + hRect.h + 3) {
           tableContext.refs.canvas.value.style.cursor = 'crosshair';
           return;
         }
       }

       _detectResizeZoneThrottled(x, y);
       if (tableContext.state.resizeCursor) {
         tableContext.refs.canvas.value.style.cursor = tableContext.state.resizeCursor;
       } else {
         tableContext.refs.canvas.value.style.cursor = 'default';
       }
       return;
    }

    if (tableContext.state.isDragging) {
      const c = getColAt(x);
      const r = getRowAt(y);
      if (c >= 0 && r >= 0) {
        tableContext.props.workbook.setSelection(tableContext.props.workbook.activeCell.r, tableContext.props.workbook.activeCell.c, r, c);
      }
    }
  }

  function handleMouseUp(e) {
    if (tableContext.state.isSelectingRow) {
      tableContext.state.isSelectingRow = false;
      return;
    }

    if (tableContext.state.isSelectingCol) {
      tableContext.state.isSelectingCol = false;
      return;
    }

    if (tableContext.state.isDraggingFill) {
      tableContext.state.isDraggingFill = false;
      if (tableContext.state.fillTargetRange) {
        tableContext.props.workbook.sheetStructure.fillAuto(tableContext.state.fillStartRange, tableContext.state.fillTargetRange);
        const t = tableContext.state.fillTargetRange;
        tableContext.props.workbook.setSelection(tableContext.state.fillStartRange.s.r, tableContext.state.fillStartRange.s.c, t.e.r, t.e.c);
      }
      tableContext.state.fillTargetRange = null;
      tableContext.state.fillStartRange = null;
      tableContext.methods.invalidate(null, { content: true });
      return;
    }

    if (tableContext.state.isResizingCol) {
      tableContext.state.isResizingCol = false;
      const finalW = tableContext.props.workbook.getColWidth(tableContext.state.resizingIndex);
      if (finalW !== tableContext.state.resizingStartSize) {
        tableContext.props.workbook.history.execute({
          type: 'set-col-width',
          c: tableContext.state.resizingIndex,
          oldValue: tableContext.state.resizingStartSize,
          newValue: finalW
        });
        tableContext.props.workbook.markLayoutDirty();
      }
      return;
    }

    if (tableContext.state.isResizingRow) {
      tableContext.state.isResizingRow = false;
      const finalH = tableContext.props.workbook.getRowHeight(tableContext.state.resizingIndex);
      if (finalH !== tableContext.state.resizingStartSize) {
        tableContext.props.workbook.history.execute({
          type: 'set-row-height',
          r: tableContext.state.resizingIndex,
          oldValue: tableContext.state.resizingStartSize,
          newValue: finalH
        });
        tableContext.props.workbook.markLayoutDirty();
      }
      return;
    }

    tableContext.state.isDragging = false;

    if (tableContext.methods.resumeProgressiveRender) {
      tableContext.methods.resumeProgressiveRender();
    }
  }

  function handleDblClick(e) {
    const rect = tableContext.refs.canvas.value.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const CH = tableContext.computed.colHeaderHeight.value;
    const RW = tableContext.computed.rowHeaderWidth.value;

    if (y < CH && x > RW) {
      detectResizeZone(x, y);
      if (tableContext.state.resizeCursor === 'col-resize' && tableContext.state.hoverResizeIndex >= 0) {
        autoFitColumn(tableContext.state.hoverResizeIndex);
        return;
      }
    }

    const c = getColAt(x);
    const r = getRowAt(y);

    if (c >= 0 && r >= 0) {
      startEdit(r, c);
    }
  }

  function handleKeyDown(e) {
    if (tableContext.state.isEditing) return;
    if (!tableContext.props.workbook || !tableContext.props.workbook.activeCell) return;

    const { r, c } = tableContext.props.workbook.activeCell;
    const sel = tableContext.props.workbook.selection || { s: { r, c }, e: { r, c } };

    let nextR = r;
    let nextC = c;
    let focusR = r;
    let focusC = c;

    if (sel.s.r === r && sel.s.c === c) {
      focusR = sel.e.r;
      focusC = sel.e.c;
    } else {
      focusR = sel.s.r;
      focusC = sel.s.c;
    }

    switch (e.key) {
      case 'c':
      case 'C':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          handleCopy();
          return;
        }
        break;
      case 'v':
      case 'V':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (!tableContext.props.readOnly) handlePaste();
          return;
        }
        break;
      case 'z':
      case 'Z':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) {
            if (!tableContext.props.readOnly) tableContext.props.workbook.history.redo();
          } else {
            if (!tableContext.props.readOnly) tableContext.props.workbook.history.undo();
          }
          return;
        }
        break;
      case 'y':
      case 'Y':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (!tableContext.props.readOnly) tableContext.props.workbook.history.redo();
          return;
        }
        break;
      case 'f':
      case 'F':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          tableContext.emit('trigger-find');
          return;
        }
        break;
      case 'a':
      case 'A':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          tableContext.props.workbook.setSelection(0, 0, tableContext.props.workbook.rowCount - 1, tableContext.props.workbook.colCount - 1);
          return;
        }
        break;

      case 'ArrowUp':
        if (e.shiftKey) {
          focusR = Math.max(0, focusR - 1);
          tableContext.props.workbook.setSelection(r, c, focusR, focusC);
        } else {
          nextR = Math.max(0, r - 1);
          tableContext.props.workbook.setSelection(nextR, nextC, nextR, nextC);
        }
        break;
      case 'ArrowDown':
        if (e.shiftKey) {
          focusR = Math.min(tableContext.props.workbook.rowCount - 1, focusR + 1);
          tableContext.props.workbook.setSelection(r, c, focusR, focusC);
        } else {
          nextR = Math.min(tableContext.props.workbook.rowCount - 1, r + 1);
          tableContext.props.workbook.setSelection(nextR, nextC, nextR, nextC);
        }
        break;
      case 'ArrowLeft':
        if (e.shiftKey) {
          focusC = Math.max(0, focusC - 1);
          tableContext.props.workbook.setSelection(r, c, focusR, focusC);
        } else {
          nextC = Math.max(0, c - 1);
          tableContext.props.workbook.setSelection(nextR, nextC, nextR, nextC);
        }
        break;
      case 'ArrowRight':
        if (e.shiftKey) {
          focusC = Math.min(tableContext.props.workbook.colCount - 1, focusC + 1);
          tableContext.props.workbook.setSelection(r, c, focusR, focusC);
        } else {
          nextC = Math.min(tableContext.props.workbook.colCount - 1, c + 1);
          tableContext.props.workbook.setSelection(nextR, nextC, nextR, nextC);
        }
        break;

      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) nextC = Math.max(0, c - 1);
        else nextC = Math.min(tableContext.props.workbook.colCount - 1, c + 1);
        tableContext.props.workbook.setSelection(nextR, nextC, nextR, nextC);
        break;
      case 'Enter':
        e.preventDefault();
        if (e.shiftKey) nextR = Math.max(0, r - 1);
        else nextR = Math.min(tableContext.props.workbook.rowCount - 1, r + 1);
        tableContext.props.workbook.setSelection(nextR, nextC, nextR, nextC);
        break;

      case 'Home':
        e.preventDefault();
        if (e.ctrlKey) { nextR = 0; nextC = 0; }
        else nextC = 0;
        tableContext.props.workbook.setSelection(nextR, nextC, nextR, nextC);
        break;
      case 'End':
        e.preventDefault();
        if (e.ctrlKey) { nextR = tableContext.props.workbook.rowCount - 1; nextC = tableContext.props.workbook.colCount - 1; }
        else nextC = tableContext.props.workbook.colCount - 1;
        tableContext.props.workbook.setSelection(nextR, nextC, nextR, nextC);
        break;

      case 'Escape':
        tableContext.props.workbook.clearCopyRange();
        if (tableContext.state.isEditing) cancelEdit();
        return;

      case 'Backspace':
      case 'Delete':
        if (tableContext.props.readOnly) return;
        e.preventDefault();
        if (isSelectionLocked()) {
          alert('操作被拦截：所选区域包含他人正在编辑锁定的单元格，无法清除。');
          return;
        }
        tableContext.props.workbook.clearCells(tableContext.props.workbook.selection);
        return;

      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (tableContext.props.readOnly) return;
          e.preventDefault();
          startEdit(r, c, e.key);
          return;
        }
        return;
    }

    e.preventDefault();
    scrollIntoView(tableContext.props.workbook.activeCell.r, tableContext.props.workbook.activeCell.c);
  }

  function scrollIntoView(r, c) {
    if (_throttledScrollIntoView) {
      _throttledScrollIntoView(r, c);
    } else {
      _scrollIntoViewImpl(r, c);
    }
  }

  function _scrollIntoViewImpl(r, c) {
    const wb = tableContext.props.workbook;
    const RW = tableContext.computed.rowHeaderWidth.value;
    const CH = tableContext.computed.colHeaderHeight.value;

    const cellX = wb.getColPos(c);
    const cellY = wb.getRowPos(r);
    const cellW = wb.getColWidth(c);
    const cellH = wb.getRowHeight(r);

    const fR = wb.freeze.r || 0;
    const fC = wb.freeze.c || 0;
    let fW = 0; for (let i = 0; i < fC; i++) fW += wb.getColWidth(i);
    let fH = 0; for (let i = 0; i < fR; i++) fH += wb.getRowHeight(i);

    if (r < fR && c < fC) return;

    let newSX = tableContext.state.scrollX;
    let newSY = tableContext.state.scrollY;

    if (c >= fC) {
      const visualXEnd = cellX + cellW - tableContext.state.scrollX + RW;
      if (visualXEnd > tableContext.state.width) {
        newSX = cellX + cellW - (tableContext.state.width - RW);
      }

      const visualXStart = cellX - tableContext.state.scrollX + RW;
      if (visualXStart < RW + fW) {
        newSX = cellX - fW;
      }
    }

    if (r >= fR) {
      const visualYEnd = cellY + cellH - tableContext.state.scrollY + CH;
      if (visualYEnd > tableContext.state.height) {
        newSY = cellY + cellH - (tableContext.state.height - CH);
      }

      const visualYStart = cellY - tableContext.state.scrollY + CH;
      if (visualYStart < CH + fH) {
        newSY = cellY - fH;
      }
    }

    if (newSX !== tableContext.state.scrollX || newSY !== tableContext.state.scrollY) {
      tableContext.state.scrollX = Math.max(0, newSX);
      tableContext.state.scrollY = Math.max(0, newSY);

      tableContext.methods.syncScrollbars();
      tableContext.methods.updateEditorPosition();
      tableContext.methods.invalidate(null, { scroll: true });
    } else {
      tableContext.methods.updateEditorPosition();
    }
  }

  function detectResizeZone(x, y) {
    if (tableContext.state.isResizingCol || tableContext.state.isResizingRow) {
      _detectResizeZoneImpl(x, y);
      return;
    }
    _detectResizeZoneThrottled(x, y);
  }

  function _detectResizeZoneThrottled(x, y) {
    if (_throttledDetectResize) {
      _throttledDetectResize(x, y);
    } else {
      _detectResizeZoneImpl(x, y);
    }
  }

  function _detectResizeZoneImpl(x, y) {
    const wb = tableContext.props.workbook;
    const RW = tableContext.computed.rowHeaderWidth.value;
    const CH = tableContext.computed.colHeaderHeight.value;
    const TOLERANCE = 5;

    tableContext.state.resizeCursor = '';
    tableContext.state.hoverResizeIndex = -1;

    if (y < CH && x > RW) {
      const freezeC = wb.freeze.c || 0;
      const frozenWidth = wb.getColPos(freezeC);

      if (x < RW + frozenWidth) {
          const idx = wb.getColIndexAt(x - RW - TOLERANCE);
          if (idx !== -1 && idx < freezeC) {
              const endX = RW + wb.getColPos(idx + 1);
              if (Math.abs(x - endX) <= TOLERANCE) {
                  tableContext.state.resizeCursor = 'col-resize';
                  tableContext.state.hoverResizeIndex = idx;
                  return;
              }
          }
      } else {
          const contentX = x - (RW + frozenWidth) + tableContext.state.scrollX;
          const idx = wb.getColIndexAt(contentX + frozenWidth - TOLERANCE);
          if (idx !== -1 && idx >= freezeC) {
              const endX = RW + frozenWidth + wb.getColPos(idx + 1) - wb.getColPos(freezeC) - tableContext.state.scrollX;
              if (Math.abs(x - endX) <= TOLERANCE) {
                  tableContext.state.resizeCursor = 'col-resize';
                  tableContext.state.hoverResizeIndex = idx;
                  return;
              }
          }
      }
    }

    if (x < RW && y > CH) {
        const freezeR = wb.freeze.r || 0;
        const frozenHeight = wb.getRowPos(freezeR);

        if (y < CH + frozenHeight) {
            const idx = wb.getRowIndexAt(y - CH - TOLERANCE);
            if (idx !== -1 && idx < freezeR) {
                const endY = CH + wb.getRowPos(idx + 1);
                if (Math.abs(y - endY) <= TOLERANCE) {
                    tableContext.state.resizeCursor = 'row-resize';
                    tableContext.state.hoverResizeIndex = idx;
                    return;
                }
            }
        } else {
            const contentY = y - (CH + frozenHeight) + tableContext.state.scrollY;
            const idx = wb.getRowIndexAt(contentY + frozenHeight - TOLERANCE);
            if (idx !== -1 && idx >= freezeR) {
                const endY = CH + frozenHeight + wb.getRowPos(idx + 1) - wb.getRowPos(freezeR) - tableContext.state.scrollY;
                if (Math.abs(y - endY) <= TOLERANCE) {
                    tableContext.state.resizeCursor = 'row-resize';
                    tableContext.state.hoverResizeIndex = idx;
                    return;
                }
            }
        }
    }
  }

  // ── 以下是原本在 CanvasTable.vue 中与编辑、调整等相关的业务逻辑方法 ──

  function getColAt(x) {
    if (x < tableContext.computed.rowHeaderWidth.value) return -1;
    const wb = tableContext.props.workbook;

    const freezeC = wb.freeze.c || 0;
    let cx = tableContext.computed.rowHeaderWidth.value;

    const frozenWidth = wb.getColPos(freezeC);
    if (x < cx + frozenWidth) {
      const idx = wb.getColIndexAt(x - cx);
      return idx < wb.colCount ? idx : -1;
    }

    const contentX = x - (cx + frozenWidth) + tableContext.state.scrollX;
    const idx = wb.getColIndexAt(contentX + frozenWidth);
    if (idx < freezeC) return -1;
    return idx < wb.colCount ? idx : -1;
  }

  function getRowAt(y) {
    if (y < tableContext.computed.colHeaderHeight.value) return -1;
    const wb = tableContext.props.workbook;

    const freezeR = wb.freeze.r || 0;
    let cy = tableContext.computed.colHeaderHeight.value;

    const frozenHeight = wb.getRowPos(freezeR);
    if (y < cy + frozenHeight) {
      const idx = wb.getRowIndexAt(y - cy);
      return idx < wb.rowCount ? idx : -1;
    }

    const contentY = y - (cy + frozenHeight) + tableContext.state.scrollY;
    const idx = wb.getRowIndexAt(contentY + frozenHeight);
    if (idx < freezeR) return -1;
    return idx < wb.rowCount ? idx : -1;
  }

  function startEdit(r, c, initialValue = null) {
    if (tableContext.props.readOnly) return;
    const wb = tableContext.props.workbook;
    const merge = wb.getMerge(r, c);
    let targetR = r;
    let targetC = c;
    if (merge) {
      targetR = merge.s.r;
      targetC = merge.s.c;
    }

    const isLockedFn = wb.plugins.getSharedState('collaboration:isCellLocked');
    if (isLockedFn && isLockedFn(targetR, targetC)) {
      const lockInfoFn = wb.plugins.getSharedState('collaboration:getCellLockInfo');
      const lockInfo = lockInfoFn ? lockInfoFn(targetR, targetC) : null;
      const userName = lockInfo ? lockInfo.userName : '其他用户';
      alert(`无法编辑：单元格正由用户 "${userName}" 编辑锁定中`);
      return;
    }

    const lockCellFn = wb.plugins.getSharedState('collaboration:lockCell');
    if (lockCellFn) {
      lockCellFn(targetR, targetC);
    }

    const cell = wb.getCell(targetR, targetC);
    tableContext.state.editValue = initialValue !== null ? initialValue : (cell ? (cell.f || cell.v) : '');
    tableContext.state.isEditing = true;
    tableContext.state.editorVisible = true;
    tableContext.state.editingCell = { r: targetR, c: targetC };

    if (initialValue !== null) {
      const broadcastEditingFn = wb.plugins.getSharedState('collaboration:broadcastEditing');
      if (broadcastEditingFn) {
        broadcastEditingFn(targetR, targetC, initialValue);
      }
    }

    updateEditorPosition();
    setTimeout(() => {
      if (tableContext.refs.editor.value) tableContext.refs.editor.value.focus();
    }, 0);
  }

  function getCellScreenRect(r, c) {
    const wb = tableContext.props.workbook;
    const merge = wb.getMerge(r, c);
    const targetR = merge ? merge.s.r : r;
    const targetC = merge ? merge.s.c : c;
    const freezeC = wb.freeze.c || 0;
    const freezeR = wb.freeze.r || 0;
    const frozenWidth = wb.getColPos(freezeC);
    const frozenHeight = wb.getRowPos(freezeR);
    const RW = tableContext.computed.rowHeaderWidth.value;
    const CH = tableContext.computed.colHeaderHeight.value;

    const x = targetC < freezeC
      ? RW + wb.getColPos(targetC)
      : RW + frozenWidth + wb.getColPos(targetC) - wb.getColPos(freezeC) - tableContext.state.scrollX;
    const y = targetR < freezeR
      ? CH + wb.getRowPos(targetR)
      : CH + frozenHeight + wb.getRowPos(targetR) - wb.getRowPos(freezeR) - tableContext.state.scrollY;

    let w = wb.getColWidth(targetC);
    let h = wb.getRowHeight(targetR);
    if (merge) {
      w = 0;
      for (let mc = merge.s.c; mc <= merge.e.c; mc++) w += wb.getColWidth(mc);
      h = 0;
      for (let mr = merge.s.r; mr <= merge.e.r; mr++) h += wb.getRowHeight(mr);
    }

    return { x, y, w, h, r: targetR, c: targetC };
  }

  function isEditorRectVisible(rect) {
    const wb = tableContext.props.workbook;
    const freezeC = wb.freeze.c || 0;
    const freezeR = wb.freeze.r || 0;
    const frozenWidth = wb.getColPos(freezeC);
    const frozenHeight = wb.getRowPos(freezeR);
    const left = rect.c < freezeC ? tableContext.computed.rowHeaderWidth.value : tableContext.computed.rowHeaderWidth.value + frozenWidth;
    const top = rect.r < freezeR ? tableContext.computed.colHeaderHeight.value : tableContext.computed.colHeaderHeight.value + frozenHeight;
    const right = tableContext.state.width - 14;
    const bottom = tableContext.state.height - 14;

    return rect.x >= left &&
      rect.y >= top &&
      rect.x + rect.w <= right &&
      rect.y + rect.h <= bottom;
  }

  function updateEditorPosition() {
    if (!tableContext.state.isEditing || !tableContext.state.editingCell || !tableContext.props.workbook) return;
    const rect = getCellScreenRect(tableContext.state.editingCell.r, tableContext.state.editingCell.c);
    tableContext.state.editorPos = {
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h
    };
    tableContext.state.editorVisible = isEditorRectVisible(rect);
  }

  function finishEdit() {
    if (!tableContext.state.isEditing) return;
    tableContext.state.isEditing = false;
    tableContext.state.editorVisible = false;

    const { r, c } = tableContext.state.editingCell || tableContext.props.workbook.activeCell;

    let val = tableContext.state.editValue;
    const cleanVal = typeof val === 'string' ? val.replace(/,/g, '') : val;
    const num = parseFloat(cleanVal);
    if (!isNaN(num) && String(num) === cleanVal) val = num;

    tableContext.props.workbook.setCell(r, c, { v: val });

    const unlockCellFn = tableContext.props.workbook.plugins.getSharedState('collaboration:unlockCell');
    if (unlockCellFn) {
      unlockCellFn(r, c);
    }

    tableContext.state.editingCell = null;
    if (tableContext.refs.container.value) {
      tableContext.refs.container.value.focus();
    }
  }

  function cancelEdit() {
    tableContext.state.isEditing = false;
    tableContext.state.editorVisible = false;
    if (tableContext.state.editingCell) {
      const unlockCellFn = tableContext.props.workbook.plugins.getSharedState('collaboration:unlockCell');
      if (unlockCellFn) {
        unlockCellFn(tableContext.state.editingCell.r, tableContext.state.editingCell.c);
      }
    }
    if (tableContext.refs.container.value) {
      tableContext.refs.container.value.focus();
    }
  }

  function autoFitColumn(c, options = {}) {
    const ctx = tableContext.state.ctx;
    const wb = tableContext.props.workbook;
    if (!ctx || !wb) return;

    const {
      sampleSize = 100,
      includeFirst = true,
      includeLast = true
    } = options;

    let maxW = 0;
    const PADDING = 10;
    const MIN_W = 50;
    const rowCount = wb.rowCount;

    ctx.font = `${tableContext.state.tableTheme.headerFontSize} ${tableContext.state.tableTheme.fontFamily}`;
    const headerText = String.fromCharCode(65 + c);
    maxW = Math.max(maxW, ctx.measureText(headerText).width);

    ctx.font = `${tableContext.state.tableTheme.fontSize} ${tableContext.state.tableTheme.fontFamily}`;

    if (rowCount <= sampleSize) {
      for (let r = 0; r < rowCount; r++) {
        const cell = wb.getCell(r, c);
        if (cell && cell.v) {
          const val = String(cell.v);
          const w = ctx.measureText(val).width;
          maxW = Math.max(maxW, w);
        }
      }
    } else {
      const sampledRows = new Set();

      if (includeFirst) sampledRows.add(0);
      if (includeLast) sampledRows.add(rowCount - 1);

      const step = Math.floor(rowCount / (sampleSize - 2));
      for (let i = 1; i < sampleSize - 2; i++) {
        sampledRows.add(i * step);
      }

      if (tableContext.state.scrollY > 0 || tableContext.state.height > 0) {
        const startR = wb.getRowIndexAt(tableContext.state.scrollY);
        const endR = wb.getRowIndexAt(tableContext.state.scrollY + tableContext.state.height);
        for (let r = Math.max(0, startR); r <= Math.min(rowCount - 1, endR); r++) {
          sampledRows.add(r);
        }
      }

      for (const r of sampledRows) {
        if (r < 0 || r >= rowCount) continue;
        const cell = wb.getCell(r, c);
        if (cell && cell.v) {
          const val = String(cell.v);
          const w = ctx.measureText(val).width;
          maxW = Math.max(maxW, w);
        }
      }
    }

    const newWidth = Math.max(MIN_W, maxW + PADDING);
    const oldW = wb.getColWidth(c);
    if (Math.abs(newWidth - oldW) > 1) {
      wb.history.execute({
        type: 'set-col-width',
        c: c,
        oldValue: oldW,
        newValue: newWidth
      });
    }
  }

  function handleEditorInput(e) {
    const broadcastEditingFn = tableContext.props.workbook.plugins.getSharedState('collaboration:broadcastEditing');
    if (broadcastEditingFn && tableContext.state.editingCell) {
      broadcastEditingFn(tableContext.state.editingCell.r, tableContext.state.editingCell.c, tableContext.state.editValue);
    }
  }

  function handleContextMenu(e) {
    e.preventDefault();
    if (tableContext.props.readOnly) return;

    const rect = tableContext.refs.canvas.value.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    tableContext.state.contextMenuPos = { x: x, y: y };

    const c = getColAt(x);
    const r = getRowAt(y);
    tableContext.state.contextMenuTarget = { r, c };
    tableContext.state.contextMenuVisible = true;
  }

  function handleMenuAction(action) {
    if (tableContext.props.readOnly) return;
    tableContext.state.contextMenuVisible = false;
    const { r, c } = tableContext.state.contextMenuTarget || {};

    const targetR = r !== -1 ? r : (tableContext.props.workbook.activeCell?.r ?? 0);
    const targetC = c !== -1 ? c : (tableContext.props.workbook.activeCell?.c ?? 0);

    switch (action) {
      case 'insertRow': tableContext.props.workbook.sheetStructure.insertRow(targetR); break;
      case 'deleteRow':
        if (isRangeLocked(targetR, 0, targetR, tableContext.props.workbook.colCount - 1)) {
          alert('操作被拦截：所删行包含他人正在编辑锁定的单元格，无法删除。');
          return;
        }
        tableContext.props.workbook.sheetStructure.deleteRow(targetR);
        break;
      case 'insertColumn': tableContext.props.workbook.sheetStructure.insertColumn(targetC); break;
      case 'deleteColumn':
        if (isRangeLocked(0, targetC, tableContext.props.workbook.rowCount - 1, targetC)) {
          alert('操作被拦截：所删列包含他人正在编辑锁定的单元格，无法删除。');
          return;
        }
        tableContext.props.workbook.sheetStructure.deleteColumn(targetC);
        tableContext.emit('column-deleted', targetC);
        break;
      case 'merge':
        tableContext.props.workbook.mergeManager.mergeCells(tableContext.props.workbook.selection);
        break;
      case 'unmerge':
        tableContext.props.workbook.mergeManager.unmergeCells(tableContext.props.workbook.selection);
        break;
      case 'clear':
        if (isSelectionLocked()) {
          alert('操作被拦截：所选区域包含他人正在编辑锁定的单元格，无法清除。');
          return;
        }
        tableContext.props.workbook.styleManager.clearContent(tableContext.props.workbook.selection);
        break;
      case 'copy':
        handleCopy();
        break;
      case 'paste':
        handlePaste();
        break;
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    const rect = tableContext.refs.canvas.value.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const c = getColAt(x);
    const r = getRowAt(y);

    if (r >= 0 && c >= 0) {
      if (!tableContext.state.dragOverCell || tableContext.state.dragOverCell.r !== r || tableContext.state.dragOverCell.c !== c) {
        tableContext.state.dragOverCell = { r, c };
        tableContext.methods.render();
      }
    } else {
      if (tableContext.state.dragOverCell) {
        tableContext.state.dragOverCell = null;
        tableContext.methods.render();
      }
    }
  }

  function handleDragLeave() {
    if (tableContext.state.dragOverCell) {
      tableContext.state.dragOverCell = null;
      tableContext.methods.render();
    }
  }

  function handleDrop(e) {
    tableContext.state.dragOverCell = null;
    tableContext.methods.render();

    if (tableContext.props.readOnly) return;
    e.preventDefault();

    try {
      const json = e.dataTransfer.getData('application/json');
      if (!json) return;

      const payload = JSON.parse(json);
      if (payload.type === 'field' && payload.data) {
        const rect = tableContext.refs.canvas.value.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const c = getColAt(x);
        const r = getRowAt(y);

        if (r >= 0 && c >= 0) {
          const field = payload.data;
          tableContext.emit('drop-field', {
            field: field,
            row: r,
            col: c
          });
          if (tableContext.refs.container.value) {
            tableContext.refs.container.value.focus();
          }
        }
      }
    } catch (err) {
      console.error('Drop error:', err);
    }
  }

  return {
    isRangeLocked,
    isSelectionLocked,
    _initThrottledMethods,
    _cleanupThrottledMethods,
    _attachDragListeners,
    _detachDragListeners,
    handleMouseDown,
    handleThrottledMouseMove,
    handleWindowMouseUp,
    handleMouseMove,
    handleMouseUp,
    handleDblClick,
    handleKeyDown,
    scrollIntoView,
    _scrollIntoViewImpl,
    detectResizeZone,
    _detectResizeZoneThrottled,
    _detectResizeZoneImpl,
    getColAt,
    getRowAt,
    startEdit,
    getCellScreenRect,
    isEditorRectVisible,
    updateEditorPosition,
    finishEdit,
    cancelEdit,
    autoFitColumn,
    handleEditorInput,
    handleCopy,
    handlePaste,
    handleContextMenu,
    handleMenuAction,
    handleDragOver,
    handleDragLeave,
    handleDrop
  };
}
