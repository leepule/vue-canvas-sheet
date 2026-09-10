import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../../src/core/Workbook.js';
import {
  ImportPlugin,
  applyMatrixInBatches,
  buildImportUpdatesFromXLSX
} from '../../src/plugins/ImportPlugin.js';

function colToIndex(col) {
  let value = 0;
  for (const ch of col) {
    value = value * 26 + (ch.charCodeAt(0) - 64);
  }
  return value - 1;
}

function decodeCell(addr) {
  const match = /^([A-Z]+)(\d+)$/.exec(addr);
  if (!match) throw new Error(`Invalid cell address: ${addr}`);
  return {
    r: Number(match[2]) - 1,
    c: colToIndex(match[1])
  };
}

function makeXLSXStub() {
  return {
    utils: {
      decode_range: vi.fn((ref) => {
        const [start, end] = ref.split(':');
        return { s: decodeCell(start), e: decodeCell(end || start) };
      }),
      decode_cell: vi.fn(decodeCell),
      encode_cell: vi.fn(() => {
        throw new Error('encode_cell should not be called for sparse import');
      })
    }
  };
}

describe('ImportPlugin - XLSX 稀疏导入', () => {
  it('只遍历 worksheet 实际存在的单元格键，不按巨大 !ref 全量双重循环', () => {
    const XLSX = makeXLSXStub();
    const ws = {
      '!ref': 'A1:XFD1000',
      A1: {
        v: 'header',
        s: {
          font: { bold: true, color: { rgb: 'FF0000' } },
          alignment: { vertical: 'center' }
        }
      },
      B2: { f: 'SUM(A1:A1)', v: 1 },
      XFD1000: { v: 'tail' },
      XFE1: { v: 'outside-col' },
      A1001: { v: 'outside-row' },
      C3: { s: { font: { italic: true } } },
      notACell: { v: 'bad-address' }
    };

    const start = performance.now();
    const updates = buildImportUpdatesFromXLSX(XLSX, ws);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(100);
    expect(XLSX.utils.encode_cell).not.toHaveBeenCalled();
    expect(XLSX.utils.decode_cell).toHaveBeenCalledTimes(7);
    expect(updates).toEqual([
      {
        r: 0,
        c: 0,
        val: {
          v: 'header',
          s: { bold: true, color: '#FF0000', valign: 'middle' }
        }
      },
      {
        r: 1,
        c: 1,
        val: { f: '=SUM(A1:A1)', v: 1 }
      },
      {
        r: 999,
        c: 16383,
        val: { v: 'tail' }
      }
    ]);
  });
});

describe('ImportPlugin - 替换旧工作簿数据', () => {
  it('CSV 小表导入后不应在搜索、JSON 或持久化快照中保留旧范围外数据', async () => {
    const workbook = new Workbook({ enableWasm: false });

    try {
      workbook.setCell(50, 20, { v: 'STALE' });
      expect(workbook.find('STALE')).toMatchObject({ r: 50, c: 20 });

      await applyMatrixInBatches(workbook, [['NEW']], { batchSize: 1 });

      expect(workbook.rowCount).toBe(20);
      expect(workbook.colCount).toBe(10);
      expect(workbook.getCell(50, 20)).toBeNull();
      expect(workbook.getDataMatrix().getBounds()).toEqual({
        minRow: 0,
        maxRow: 0,
        minCol: 0,
        maxCol: 0
      });
      expect(workbook.find('STALE')).toBeNull();
      expect(workbook.toJSON().data).toEqual({ '0-0': { v: 'NEW', dirty: false } });

      const storage = {
        importSheet: vi.fn().mockResolvedValue(undefined),
        close: vi.fn()
      };
      workbook._storage = storage;
      await workbook.persistence.persist('imported');
      expect(storage.importSheet.mock.calls[0][1].data).toEqual({
        '0-0': { v: 'NEW', dirty: false }
      });
    } finally {
      workbook.destroy();
    }
  });

  it('XLSX 更新路径导入小表后不应保留旧范围外数据', async () => {
    const workbook = new Workbook({ enableWasm: false });
    const plugin = new ImportPlugin({ batchSize: 1 });

    try {
      const xlsxModule = await import('xlsx-js-style');
      const XLSX = xlsxModule.default || xlsxModule;
      const importedBook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        importedBook,
        XLSX.utils.aoa_to_sheet([['NEW']]),
        'Sheet1'
      );
      const file = new File([
        XLSX.write(importedBook, { type: 'array', bookType: 'xlsx' })
      ], 'small.xlsx');

      workbook.setCell(50, 20, { v: 'STALE' });
      plugin.onMounted(workbook, null);
      await plugin.importFile(file);

      expect(workbook.getCell(0, 0)).toMatchObject({ v: 'NEW' });
      expect(workbook.getCell(50, 20)).toBeNull();
      expect(workbook.toJSON().data).not.toHaveProperty('50-20');
    } finally {
      workbook.destroy();
    }
  });
});
