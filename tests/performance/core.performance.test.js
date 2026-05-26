import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../../src/core/Workbook.js';
import { wasmBridge } from '../../src/core/worker/WasmBridge.js';
import { CellPool } from '../../src/core/utils/ObjectPool.js';
import { HistoryManager } from '../../src/core/history/History.js';
import { buildCompactJSON, buildSparseExportSnapshot } from '../../src/plugins/utils/exportSnapshot.js';
import { buildWorksheetFromSparseSnapshot } from '../../src/plugins/utils/xlsxAdapter.js';
import { buildImportUpdates, applyMatrixInBatches } from '../../src/plugins/ImportPlugin.js';
import {
  benchmark,
  cleanupWorkbook,
  disableWasmForBenchmarks
} from './perfHarness.js';

const TEN_K = 10_000;
const ONE_HUNDRED_K = 100_000;
const PERF_COLUMNS = 100;

function createWorkbook() {
  const workbook = new Workbook();
  if (workbook.calcEngine) {
    workbook.calcEngine.batchDelay = 60_000;
  }
  return workbook;
}

function clearScheduledCalculation(workbook) {
  if (workbook.calcEngine?.batchTimeout) {
    clearTimeout(workbook.calcEngine.batchTimeout);
    workbook.calcEngine.batchTimeout = null;
  }
}

function buildNumericUpdates(count, cols = PERF_COLUMNS) {
  return Array.from({ length: count }, (_, index) => ({
    r: Math.floor(index / cols),
    c: index % cols,
    val: { v: index }
  }));
}

function buildSparseUpdates(count, rowStride = 10, cols = PERF_COLUMNS) {
  return Array.from({ length: count }, (_, index) => ({
    r: Math.floor(index / cols) * rowStride,
    c: index % cols,
    val: {
      v: index % 7 === 0 ? `needle-${index}` : `value-${index}`,
      s: index % 11 === 0 ? { bold: true, bg: '#f4f5f8' } : undefined
    }
  }));
}

function setupFormulaWorkbook(dependentCount) {
  const workbook = createWorkbook();
  workbook.setCell(0, 0, { v: 1 });

  const formulas = Array.from({ length: dependentCount }, (_, index) => ({
    r: index,
    c: 1,
    val: { v: `=A1+${index}` }
  }));
  workbook.bulkSetCells(formulas);

  clearScheduledCalculation(workbook);
  workbook.calcEngine.dirtyBitset.clear();
  workbook.calcEngine.clearCache();
  workbook.resetCalculationStats();

  for (let i = 0; i < dependentCount; i++) {
    const cell = workbook.getCell(i, 1);
    if (cell) cell.dirty = false;
  }

  return workbook;
}

function buildRenderPayload(cellCount) {
  const cellsPerRow = 100;
  const cellDataList = Array.from({ length: cellCount }, (_, index) => {
    const r = Math.floor(index / cellsPerRow);
    const c = index % cellsPerRow;
    return {
      r,
      c,
      x: c * 80,
      y: r * 24,
      w: 80,
      h: 24,
      bg: index % 2 === 0 ? '#ffffff' : '#f8fafc',
      text: {
        content: `R${r}C${c}`,
        font: '12px Arial',
        color: '#202124',
        align: 'left',
        valign: 'middle',
        fSize: '12px',
        isWrap: false,
        padding: 4,
        styleId: 1
      }
    };
  });

  return {
    width: cellsPerRow * 80,
    height: Math.ceil(cellCount / cellsPerRow) * 24,
    theme: {
      textColor: '#202124',
      borderColor: '#dadce0',
      headerBg: '#f8fafc',
      headerHoverBg: '#e8f0fe',
      selectionBorder: '#217346',
      selectionBg: 'rgba(33, 115, 70, 0.1)',
      frozenLineColor: '#9aa0a6',
      fontFamily: 'Arial',
      fontSize: '12px',
      headerFontSize: '12px'
    },
    styleMap: { 1: { textDecoration: 'none' } },
    cellDataList,
    bgGroups: {},
    gridLines: [],
    borderBatch: {},
    renderRect: { x: 0, y: 0, w: cellsPerRow * 80, h: Math.ceil(cellCount / cellsPerRow) * 24 },
    colHeaders: [],
    rowHeaders: [],
    frozenLines: []
  };
}

function buildImportRows(rows, cols) {
  return Array.from({ length: rows }, (_, r) => (
    Array.from({ length: cols }, (_, c) => `R${r}C${c}`)
  ));
}

describe('性能回归门禁', () => {
  beforeAll(() => {
    disableWasmForBenchmarks(wasmBridge);
  });

  it('10k 单元格批量写入', async () => {
    const updates = buildNumericUpdates(TEN_K);

    await benchmark(
      'workbook_bulk_set_10k',
      (workbook) => {
        workbook.bulkSetCells(updates);
        clearScheduledCalculation(workbook);
        return { metadata: { cells: updates.length } };
      },
      {
        iterations: 5,
        warmup: 1,
        setup: createWorkbook,
        teardown: cleanupWorkbook
      }
    );
  });

  it('100k 单元格批量写入', async () => {
    const updates = buildNumericUpdates(ONE_HUNDRED_K);

    await benchmark(
      'workbook_bulk_set_100k',
      (workbook) => {
        workbook.bulkSetCells(updates);
        clearScheduledCalculation(workbook);
        return { metadata: { cells: updates.length } };
      },
      {
        iterations: 2,
        warmup: 0,
        setup: createWorkbook,
        teardown: cleanupWorkbook
      }
    );
  });

  it('1k 公式依赖增量重算', async () => {
    await benchmark(
      'formula_recalc_1k_dependents',
      (workbook) => {
        workbook.setCell(0, 0, { v: 2 });
        workbook.recalcDirty();
        clearScheduledCalculation(workbook);
        const stats = workbook.getCalculationStats();

        expect(stats.formulasEvaluated).toBe(1000);
        return {
          metadata: {
            dependents: 1000,
            formulasEvaluated: stats.formulasEvaluated,
            queueSize: stats.lastQueueSize
          }
        };
      },
      {
        iterations: 5,
        warmup: 1,
        setup: () => setupFormulaWorkbook(1000),
        teardown: cleanupWorkbook
      }
    );
  });

  it('10k 公式依赖增量重算', async () => {
    await benchmark(
      'formula_recalc_10k_dependents',
      (workbook) => {
        workbook.setCell(0, 0, { v: 2 });
        workbook.recalcDirty();
        clearScheduledCalculation(workbook);
        const stats = workbook.getCalculationStats();

        expect(stats.formulasEvaluated).toBe(TEN_K);
        return {
          metadata: {
            dependents: TEN_K,
            formulasEvaluated: stats.formulasEvaluated,
            queueSize: stats.lastQueueSize
          }
        };
      },
      {
        iterations: 2,
        warmup: 0,
        setup: () => setupFormulaWorkbook(TEN_K),
        teardown: cleanupWorkbook
      }
    );
  });

  it('10k 可见单元格渲染 payload 生成', async () => {
    const { serializeRenderData } = await vi.importActual('../../src/core/worker/TransferableSerializer.js');
    const renderData = buildRenderPayload(TEN_K);

    await benchmark(
      'render_payload_10k_visible_cells',
      () => {
        const { buffer } = serializeRenderData(renderData);
        return {
          payloadBytes: buffer.byteLength,
          metadata: { cells: renderData.cellDataList.length }
        };
      },
      {
        iterations: 5,
        warmup: 1
      }
    );
  });

  it('100k 单元格大范围搜索', async () => {
    const workbook = createWorkbook();
    const updates = buildSparseUpdates(ONE_HUNDRED_K);
    workbook.bulkSetCells(updates);
    clearScheduledCalculation(workbook);

    try {
      await benchmark(
        'large_range_search_100k_cells',
        () => {
          const results = workbook.search.findAll('needle');
          expect(results.length).toBeGreaterThan(0);
          return {
            metadata: {
              cells: ONE_HUNDRED_K,
              matches: results.length,
              indexed: true
            }
          };
        },
        {
          iterations: 5,
          warmup: 1
        }
      );
    } finally {
      cleanupWorkbook(workbook);
    }
  });

  it('稀疏 JSON 导出模型生成', async () => {
    const workbook = createWorkbook();
    workbook.rowCount = ONE_HUNDRED_K;
    workbook.colCount = PERF_COLUMNS;
    workbook.bulkSetCells(buildSparseUpdates(TEN_K));
    clearScheduledCalculation(workbook);

    try {
      await benchmark(
        'sparse_json_export_10k_cells',
        () => {
          const compact = buildCompactJSON(workbook);
          const payload = JSON.stringify(compact);
          return {
            payloadBytes: payload.length,
            metadata: {
              rowCount: compact.rowCount,
              colCount: compact.colCount,
              cellCount: compact.cells.length
            }
          };
        },
        {
          iterations: 5,
          warmup: 1
        }
      );
    } finally {
      cleanupWorkbook(workbook);
    }
  });

  it('稀疏 Excel 导出字节生成', async () => {
    const XLSX = await import('xlsx-js-style').then(mod => mod.default || mod);
    const workbook = createWorkbook();
    workbook.rowCount = ONE_HUNDRED_K;
    workbook.colCount = PERF_COLUMNS;
    workbook.bulkSetCells(buildSparseUpdates(TEN_K));
    clearScheduledCalculation(workbook);
    const snapshot = buildSparseExportSnapshot(workbook);

    try {
      await benchmark(
        'sparse_excel_export_10k_cells',
        () => {
          const worksheet = buildWorksheetFromSparseSnapshot(XLSX, snapshot);
          const book = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(book, worksheet, 'Sheet1');
          const bytes = XLSX.write(book, { bookType: 'xlsx', type: 'array' });

          return {
            payloadBytes: bytes.byteLength || bytes.length || 0,
            metadata: {
              rowCount: snapshot.sourceRowCount,
              colCount: snapshot.sourceColCount,
              cellCount: snapshot.entries.length,
              worksheetCells: Object.keys(worksheet).filter(key => !key.startsWith('!')).length
            }
          };
        },
        {
          iterations: 5,
          warmup: 1
        }
      );
    } finally {
      cleanupWorkbook(workbook);
    }
  });

  it('10k 单元格导入 update model 生成与批量应用', async () => {
    const rows = buildImportRows(1000, 10);

    await benchmark(
      'import_update_model_10k_cells',
      async (workbook) => {
        const updates = buildImportUpdates(rows);
        await applyMatrixInBatches(
          workbook,
          rows,
          { batchSize: updates.length }
        );

        return {
          metadata: {
            rows: 1000,
            cols: 10,
            updates: updates.length
          }
        };
      },
      {
        iterations: 3,
        warmup: 1,
        setup: createWorkbook,
        teardown: cleanupWorkbook
      }
    );
  });

  it('对象池 10k 获取释放', async () => {
    await benchmark(
      'object_pool_acquire_release_10k',
      (pool) => {
        for (let i = 0; i < TEN_K; i++) {
          const cell = pool.acquireCell(i);
          pool.releaseCell(cell);
        }
        const stats = pool.getStats();

        return {
          metadata: {
            cells: TEN_K,
            hitRate: stats.hitRate,
            poolSize: stats.poolSize
          }
        };
      },
      {
        iterations: 5,
        warmup: 1,
        setup: () => {
          const pool = new CellPool(TEN_K);
          pool.warmup(TEN_K);
          return pool;
        },
        teardown: pool => pool.clearAll()
      }
    );
  });

  it('History 1k 批量命令', async () => {
    await benchmark(
      'history_batch_1k_commands',
      (history) => {
        history.startBatch();
        for (let i = 0; i < 1000; i++) {
          history.execute({
            type: 'set-cell',
            r: i % 100,
            c: Math.floor(i / 100),
            oldioUtilsalue: null,
            newValue: i
          });
        }
        history.endBatch();

        expect(history.undoStackSize).toBe(1);
        return { metadata: { commands: 1000, undoStackSize: history.undoStackSize } };
      },
      {
        iterations: 5,
        warmup: 1,
        setup: () => new HistoryManager({ applyCommand: vi.fn() }),
        teardown: history => history.clear()
      }
    );
  });
});
