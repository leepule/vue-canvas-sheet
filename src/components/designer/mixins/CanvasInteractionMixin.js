import { cloneRange } from '../../../core/utils/Clipboard';
import { rafThrottle, throttle } from '../../../core/events/EventUtils';

export default {
  methods: {
    /**
     * 判断行列范围是否包含他人锁定的单元格
     */
    isRangeLocked(sR, sC, eR, eC) {
      const isLocked = this.workbook.plugins.getSharedState('collaboration:isCellLocked');
      if (!isLocked) return false;
      for (let r = sR; r <= eR; r++) {
        for (let c = sC; c <= eC; c++) {
          if (isLocked(r, c)) return true;
        }
      }
      return false;
    },

    /**
     * 判断当前选区是否包含他人锁定的单元格
     */
    isSelectionLocked() {
      const sel = this.workbook.selection;
      if (!sel) return false;
      return this.isRangeLocked(sel.s.r, sel.s.c, sel.e.r, sel.e.c);
    },

    /**
     * 初始化节流/防抖方法
     * 在组件 mounted 时调用
     */
    _initThrottledMethods() {
      // 节流检测调整大小区域（16ms 约等于 60fps）
      this._throttledDetectResize = throttle((x, y) => {
        this._detectResizeZoneImpl(x, y);
      }, 32);
      
      // RAF 节流滚动视图
      this._throttledScrollIntoView = rafThrottle((r, c) => {
        this._scrollIntoViewImpl(r, c);
      });
    },

    /**
     * 清理节流/防抖方法
     * 在组件 beforeDestroy 时调用
     */
    _cleanupThrottledMethods() {
      if (this._throttledDetectResize) {
        this._throttledDetectResize.cancel();
      }
      if (this._throttledScrollIntoView) {
        this._throttledScrollIntoView.cancel();
      }
    },

    handleMouseDown(e) {
      if (e.target.closest('.vue-canvas-sheet-scrollbar-h') ||
          e.target.closest('.vue-canvas-sheet-scrollbar-v')) {
          return;
      }
      
      // 暂停渐进式渲染以响应用户交互
      if (this.pauseProgressiveRender) {
        this.pauseProgressiveRender();
      }
      
      const rect = this.$refs.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Register global listeners for drag operations
      window.addEventListener('mousemove', this.handleThrottledMouseMove);
      window.addEventListener('mouseup', this.handleWindowMouseUp);

      if (e.button === 2) {
        const c = this.getColAt(x);
        const r = this.getRowAt(y);
        const sel = this.workbook.selection;

        if (sel && r >= sel.s.r && r <= sel.e.r && c >= sel.s.c && c <= sel.e.c) {
          return;
        }
      }

      if (this.fillHandleRect) {
        const hRect = this.fillHandleRect;

        if (x >= hRect.x - 3 && x <= hRect.x + hRect.w + 3 &&
          y >= hRect.y - 3 && y <= hRect.y + hRect.h + 3) {
          this.isDraggingFill = true;
          this.fillStartRange = cloneRange(this.workbook.selection);

          return;
        }
      }

      if (this.resizeCursor) {
        if (this.resizeCursor === 'col-resize') {
          this.isResizingCol = true;
          this.resizingIndex = this.hoverResizeIndex;
          this.resizingStartSize = this.workbook.getColWidth(this.resizingIndex);
          this.resizingStartPos = x;
        } else {
          this.isResizingRow = true;
          this.resizingIndex = this.hoverResizeIndex;
          this.resizingStartSize = this.workbook.getRowHeight(this.resizingIndex);
          this.resizingStartPos = y;
        }
        return;
      }

      if (y < this.colHeaderHeight && x > this.rowHeaderWidth) {
        const c = this.getColAt(x);
        if (c >= 0) {
          this.workbook.setSelection(0, c, this.workbook.rowCount - 1, c);
          this.isSelectingCol = true;
          this.dragColStartIndex = c;
          this.invalidate(null, { selection: true });
          return;
        }
      }

      if (x < this.rowHeaderWidth && y > this.colHeaderHeight) {
        const r = this.getRowAt(y);
        if (r >= 0) {
          this.workbook.setSelection(r, 0, r, this.workbook.colCount - 1);
          this.isSelectingRow = true;
          this.dragRowStartIndex = r;
          this.invalidate(null, { selection: true });
          return;
        }
      }

      const c = this.getColAt(x);
      const r = this.getRowAt(y);

      if (c >= 0 && r >= 0) {
        this.isDragging = true;
        this.workbook.setSelection(r, c, r, c);
      }
    },

    // Throttle wrapper
    handleThrottledMouseMove(e) {
        if (this._ticking) return;
        this._ticking = true;
        requestAnimationFrame(() => {
            this.handleMouseMove(e);
            this._ticking = false;
        });
    },
    
    handleWindowMouseUp(e) {
        this.handleMouseUp(e);
        // Clean up global listeners
        window.removeEventListener('mousemove', this.handleThrottledMouseMove);
        window.removeEventListener('mouseup', this.handleWindowMouseUp);
        this._ticking = false;
    },

    handleMouseMove(e) {
      if (!this.$refs.canvas) return;
      const rect = this.$refs.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (this.isDraggingFill) {
        const c = this.getColAt(x);
        const r = this.getRowAt(y);

        if (c >= 0 && r >= 0) {
          const sel = this.fillStartRange;
          let target = cloneRange(sel);

          const diffR = Math.max(r - sel.e.r, sel.s.r - r);
          const diffC = Math.max(c - sel.e.c, sel.s.c - c);

          if (r > sel.e.r && diffR >= diffC) {
            target.e.r = r;
          } else if (c > sel.e.c && diffC > diffR) {
            target.e.c = c;
          }

          this.fillTargetRange = target;
          this.invalidate(null, { selection: true });
        }
        return;
      }

      if (this.isSelectingRow) {
        const r = this.getRowAt(y);
        // When dragging outside, ensure we still detect a valid row if possible, 
        // or clamp to edges. The getRowAt logic handles some bounds but might return -1 if too far.
        // Logic improved to clamp index if -1 but inside Y bounds of header?
        // Actually getRowAt returns -1 if outside content area usually.
        // Let's rely on getRowAt for now but improve it possibly later if needed.
        if (r >= 0) {
          const start = Math.min(this.dragRowStartIndex, r);
          const end = Math.max(this.dragRowStartIndex, r);
          this.workbook.setSelection(start, 0, end, this.workbook.colCount - 1);
        }
        return;
      }

      if (this.isSelectingCol) {
        const c = this.getColAt(x);
        if (c >= 0) {
          const start = Math.min(this.dragColStartIndex, c);
          const end = Math.max(this.dragColStartIndex, c);
          this.workbook.setSelection(0, start, this.workbook.rowCount - 1, end);
        }
        return;
      }

      if (this.isResizingCol) {
        const delta = x - this.resizingStartPos;
        const newW = Math.max(5, this.resizingStartSize + delta);
        this.workbook.colWidths[this.resizingIndex] = newW;
        this.workbook._offsetsDirty = true;
        this.workbook.notify();
        return;
      }
      if (this.isResizingRow) {
        const delta = y - this.resizingStartPos;
        const newH = Math.max(5, this.resizingStartSize + delta);
        this.workbook.rowHeights[this.resizingIndex] = newH;
        this.workbook._offsetsDirty = true;
        this.workbook.notify();
        return;
      }

      // If not dragging, we only care about cursor updates when inside the canvas
      if (!this.isDragging && !this.isDraggingCol) {
         // Optimization: If outside canvas, we generally don't need to update cursor 
         // unless we want to clear it?
         // But handleMouseMove is called via global listener now? 
         // Wait, the global listener is ONLY added on mousedown.
         // So this block is reachable only if we are dragging OR if we called handleMouseMove directly (e.g. from mouseover?)
         // Actually, we still have the component-level @mousemove="handleMouseMove".
         // We should update CanvasTable.vue to NOT call handleMouseMove if global listener is active?
         // Or better, component calls handleMouseMove (local) which is fine.
         // But global listener calls handleGlobalMouseMove -> handleMouseMove.
         
         // If we are NOT dragging, we are just hovering.
         // Hovering logic:
         if (this.fillHandleRect) {
           const hRect = this.fillHandleRect;
           if (x >= hRect.x - 3 && x <= hRect.x + hRect.w + 3 &&
             y >= hRect.y - 3 && y <= hRect.y + hRect.h + 3) {
             this.$refs.canvas.style.cursor = 'crosshair';
             return;
           }
         }

         // 使用节流检测调整大小区域
         this._detectResizeZoneThrottled(x, y);
          if (this.resizeCursor) {
            this.$refs.canvas.style.cursor = this.resizeCursor;
          } else {
            this.$refs.canvas.style.cursor = 'default';
          }
         return;
      }

      if (this.isDragging) {
        const c = this.getColAt(x);
        const r = this.getRowAt(y);
        
        // Auto-scroll logic if dragging active?
        // (Simplified for now)
        
        if (c >= 0 && r >= 0) {
          this.workbook.setSelection(this.workbook.activeCell.r, this.workbook.activeCell.c, r, c);
        }
      }
    },

    handleMouseUp(e) {
      if (this.isSelectingRow) {
        this.isSelectingRow = false;
        return;
      }

      if (this.isSelectingCol) {
        this.isSelectingCol = false;
        return;
      }

      if (this.isDraggingFill) {
        this.isDraggingFill = false;
        if (this.fillTargetRange) {
          this.workbook.fillAuto(this.fillStartRange, this.fillTargetRange);
          const t = this.fillTargetRange;
          this.workbook.setSelection(this.fillStartRange.s.r, this.fillStartRange.s.c, t.e.r, t.e.c);
        }
        this.fillTargetRange = null;
        this.fillStartRange = null;
        this.invalidate(null, { content: true });
        return;
      }

      if (this.isResizingCol) {
        this.isResizingCol = false;
        const finalW = this.workbook.getColWidth(this.resizingIndex);
        if (finalW !== this.resizingStartSize) {
          this.workbook.history.execute({
            type: 'set-col-width',
            c: this.resizingIndex,
            oldValue: this.resizingStartSize,
            newValue: finalW
          });
          this.workbook._offsetsDirty = true;
        }
        return;
      }

      if (this.isResizingRow) {
        this.isResizingRow = false;
        const finalH = this.workbook.getRowHeight(this.resizingIndex);
        if (finalH !== this.resizingStartSize) {
          this.workbook.history.execute({
            type: 'set-row-height',
            r: this.resizingIndex,
            oldValue: this.resizingStartSize,
            newValue: finalH
          });
          this.workbook._offsetsDirty = true;
        }
        return;
      }

      this.isDragging = false;
      
      // 恢复渐进式渲染
      if (this.resumeProgressiveRender) {
        this.resumeProgressiveRender();
      }
    },

    handleDblClick(e) {
      const rect = this.$refs.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (y < this.colHeaderHeight && x > this.rowHeaderWidth) {
        this.detectResizeZone(x, y);
        if (this.resizeCursor === 'col-resize' && this.hoverResizeIndex >= 0) {
          this.autoFitColumn(this.hoverResizeIndex);
          return;
        }
      }

      const c = this.getColAt(x);
      const r = this.getRowAt(y);

      if (c >= 0 && r >= 0) {
        this.startEdit(r, c);
      }
    },

    handleKeyDown(e) {
      if (this.isEditing) return;
      if (!this.workbook || !this.workbook.activeCell) return;

      const { r, c } = this.workbook.activeCell;
      const sel = this.workbook.selection || { s: { r, c }, e: { r, c } };

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
            this.handleCopy();
            return;
          }
          break;
        case 'v':
        case 'V':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (!this.readOnly) this.handlePaste();
            return;
          }
          break;
        case 'z':
        case 'Z':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (e.shiftKey) {
              if (!this.readOnly) this.workbook.history.redo();
            } else {
              if (!this.readOnly) this.workbook.history.undo();
            }
            return;
          }
          break;
        case 'y':
        case 'Y':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (!this.readOnly) this.workbook.history.redo();
            return;
          }
          break;
        case 'f':
        case 'F':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            this.$emit('trigger-find');
            return;
          }
          break;

        case 'ArrowUp':
          if (e.shiftKey) {
            focusR = Math.max(0, focusR - 1);
            this.workbook.setSelection(r, c, focusR, focusC);
          } else {
            nextR = Math.max(0, r - 1);
            this.workbook.setSelection(nextR, nextC, nextR, nextC);
          }
          break;
        case 'ArrowDown':
          if (e.shiftKey) {
            focusR = Math.min(this.workbook.rowCount - 1, focusR + 1);
            this.workbook.setSelection(r, c, focusR, focusC);
          } else {
            nextR = Math.min(this.workbook.rowCount - 1, r + 1);
            this.workbook.setSelection(nextR, nextC, nextR, nextC);
          }
          break;
        case 'ArrowLeft':
          if (e.shiftKey) {
            focusC = Math.max(0, focusC - 1);
            this.workbook.setSelection(r, c, focusR, focusC);
          } else {
            nextC = Math.max(0, c - 1);
            this.workbook.setSelection(nextR, nextC, nextR, nextC);
          }
          break;
        case 'ArrowRight':
          if (e.shiftKey) {
            focusC = Math.min(this.workbook.colCount - 1, focusC + 1);
            this.workbook.setSelection(r, c, focusR, focusC);
          } else {
            nextC = Math.min(this.workbook.colCount - 1, c + 1);
            this.workbook.setSelection(nextR, nextC, nextR, nextC);
          }
          break;

        case 'Tab':
          e.preventDefault();
          if (e.shiftKey) nextC = Math.max(0, c - 1);
          else nextC = Math.min(this.workbook.colCount - 1, c + 1);
          this.workbook.setSelection(nextR, nextC, nextR, nextC);
          break;
        case 'Enter':
          e.preventDefault();
          if (e.shiftKey) nextR = Math.max(0, r - 1);
          else nextR = Math.min(this.workbook.rowCount - 1, r + 1);
          this.workbook.setSelection(nextR, nextC, nextR, nextC);
          break;

        case 'Home':
          e.preventDefault();
          if (e.ctrlKey) { nextR = 0; nextC = 0; }
          else nextC = 0;
          this.workbook.setSelection(nextR, nextC, nextR, nextC);
          break;
        case 'End':
          e.preventDefault();
          if (e.ctrlKey) { nextR = this.workbook.rowCount - 1; nextC = this.workbook.colCount - 1; }

          else nextC = this.workbook.colCount - 1;
          this.workbook.setSelection(nextR, nextC, nextR, nextC);
          break;

        case 'Escape':
          this.workbook.clearCopyRange();
          if (this.isEditing) this.cancelEdit();
          return;

        case 'Backspace':
        case 'Delete':
          if (this.readOnly) return;
          e.preventDefault();
          if (this.isSelectionLocked && this.isSelectionLocked()) {
            alert('操作被拦截：所选区域包含他人正在编辑锁定的单元格，无法清除。');
            return;
          }
          this.workbook.clearCells(this.workbook.selection);
          return;

        default:
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (this.readOnly) return;
            e.preventDefault();
            this.startEdit(r, c, e.key);
            return;
          }
          return;
      }

      e.preventDefault();
      this.scrollIntoView(this.workbook.activeCell.r, this.workbook.activeCell.c);
    },

    /**
     * 滚动到指定单元格可见（带节流）
     */
    scrollIntoView(r, c) {
      // 使用 RAF 节流
      if (this._throttledScrollIntoView) {
        this._throttledScrollIntoView(r, c);
      } else {
        this._scrollIntoViewImpl(r, c);
      }
    },

    /**
     * 滚动到指定单元格可见（实际实现）
     */
    _scrollIntoViewImpl(r, c) {
      const wb = this.workbook;
      const RW = this.rowHeaderWidth;
      const CH = this.colHeaderHeight;

      const cellX = wb.getColPos(c);
      const cellY = wb.getRowPos(r);
      const cellW = wb.getColWidth(c);
      const cellH = wb.getRowHeight(r);

      const fR = wb.freeze.r || 0;
      const fC = wb.freeze.c || 0;
      let fW = 0; for (let i = 0; i < fC; i++) fW += wb.getColWidth(i);
      let fH = 0; for (let i = 0; i < fR; i++) fH += wb.getRowHeight(i);

      if (r < fR && c < fC) return;

      let newSX = this.scrollX;
      let newSY = this.scrollY;

      if (c >= fC) {

        const visualXEnd = cellX + cellW - this.scrollX + RW;
        if (visualXEnd > this.width) {
          newSX = cellX + cellW - (this.width - RW);
        }

        const visualXStart = cellX - this.scrollX + RW;
        if (visualXStart < RW + fW) {
          newSX = cellX - fW;
        }
      }

      if (r >= fR) {

        const visualYEnd = cellY + cellH - this.scrollY + CH;
        if (visualYEnd > this.height) {
          newSY = cellY + cellH - (this.height - CH);
        }

        const visualYStart = cellY - this.scrollY + CH;
        if (visualYStart < CH + fH) {
          newSY = cellY - fH;
        }
      }

      if (newSX !== this.scrollX || newSY !== this.scrollY) {
        this.scrollX = Math.max(0, newSX);
        this.scrollY = Math.max(0, newSY);

        if (typeof this.syncScrollbars === 'function') {
          this.syncScrollbars();
        } else {
          if (this.$refs.scrollH) this.$refs.scrollH.scrollLeft = this.scrollX;
          if (this.$refs.scrollV) this.$refs.scrollV.scrollTop = this.scrollY;
        }

        if (typeof this.updateEditorPosition === 'function') {
          this.updateEditorPosition();
        }

        this.invalidate(null, { scroll: true });
      } else if (typeof this.updateEditorPosition === 'function') {
        this.updateEditorPosition();
      }
    },

    /**
     * 检测调整大小区域（带节流）
     */
    detectResizeZone(x, y) {
      // 如果正在调整大小，直接检测
      if (this.isResizingCol || this.isResizingRow) {
        this._detectResizeZoneImpl(x, y);
        return;
      }
      
      // 否则使用节流版本
      this._detectResizeZoneThrottled(x, y);
    },

    /**
     * 节流版本的调整大小区域检测
     */
    _detectResizeZoneThrottled(x, y) {
      if (this._throttledDetectResize) {
        this._throttledDetectResize(x, y);
      } else {
        this._detectResizeZoneImpl(x, y);
      }
    },

    /**
     * 检测调整大小区域（实际实现）
     */
    _detectResizeZoneImpl(x, y) {
      const wb = this.workbook;
      const RW = this.rowHeaderWidth;
      const CH = this.colHeaderHeight;
      const TOLERANCE = 5;

      this.resizeCursor = '';
      this.hoverResizeIndex = -1;

      if (y < CH && x > RW) {
        const freezeC = wb.freeze.c || 0;
        const frozenWidth = wb.getColPos(freezeC);
        
        // Check frozen cols
        if (x < RW + frozenWidth) {
            const idx = wb.getColIndexAt(x - RW - TOLERANCE);
            if (idx !== -1 && idx < freezeC) {
                const endX = RW + wb.getColPos(idx + 1);
                if (Math.abs(x - endX) <= TOLERANCE) {
                    this.resizeCursor = 'col-resize';
                    this.hoverResizeIndex = idx;
                    return;
                }
            }
        } else {
            // Check scrolled cols
            const contentX = x - (RW + frozenWidth) + this.scrollX;
            const idx = wb.getColIndexAt(contentX + frozenWidth - TOLERANCE);
            if (idx !== -1 && idx >= freezeC) {
                const endX = RW + frozenWidth + wb.getColPos(idx + 1) - wb.getColPos(freezeC) - this.scrollX;
                if (Math.abs(x - endX) <= TOLERANCE) {
                    this.resizeCursor = 'col-resize';
                    this.hoverResizeIndex = idx;
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
                      this.resizeCursor = 'row-resize';
                      this.hoverResizeIndex = idx;
                      return;
                  }
              }
          } else {
              const contentY = y - (CH + frozenHeight) + this.scrollY;
              const idx = wb.getRowIndexAt(contentY + frozenHeight - TOLERANCE);
              if (idx !== -1 && idx >= freezeR) {
                  const endY = CH + frozenHeight + wb.getRowPos(idx + 1) - wb.getRowPos(freezeR) - this.scrollY;
                  if (Math.abs(y - endY) <= TOLERANCE) {
                      this.resizeCursor = 'row-resize';
                      this.hoverResizeIndex = idx;
                      return;
                  }
              }
          }
      }
    }
  }
};
