import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Workbook } from '../../src/core/Workbook';
import { ExportPlugin } from '../../src/plugins/ExportPlugin';

// jsdom 的 Blob 未实现异步 .text()，故 spy Blob 构造器直接捕获传入的 parts（均为字符串），
// 用 parts.join('') 重建内容；同时屏蔽 jsdom 未实现的 URL.createObjectURL。
let capturedBlob;
let capturedParts;
const RealBlob = globalThis.Blob;
beforeEach(() => {
  capturedBlob = null;
  capturedParts = null;
  vi.stubGlobal('Blob', class MockBlob extends RealBlob {
    constructor(parts, opts) {
      super(parts, opts);
      capturedParts = parts;
      capturedBlob = this;
    }
  });
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:mock',
    revokeObjectURL: () => {}
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function makePlugin(workbook) {
  const plugin = new ExportPlugin();
  // ExportPlugin 通过 onInit/registry 拿 workbook；这里直接注入私有字段足够测试 exportCSV
  plugin._workbook = workbook;
  return plugin;
}

describe('ExportPlugin.exportCSV - 分块拼接等价性 (#21)', () => {
  it('跨 CHUNK_ROWS(2000) 边界的行分隔符正确，行数与内容对齐', async () => {
    const wb = new Workbook();
    // 单列数据，跨越 2000 / 4000 两个分块边界
    wb.setCell(0, 0, { v: 'a' });
    wb.setCell(1, 0, { v: 'b' });
    wb.setCell(1999, 0, { v: 'p' }); // 第一块末行
    wb.setCell(2000, 0, { v: 'm' }); // 第二块首行
    wb.setCell(2001, 0, { v: 'n' });
    wb.setCell(4001, 0, { v: 'z' });

    const plugin = makePlugin(wb);
    const result = plugin.exportCSV();

    expect(capturedBlob).toBeTruthy();
    const text = capturedParts.join('');
    const lines = text.split('\n');

    // rowCount = maxRow - minRow + 1 = 4002
    expect(result.rows).toBe(4002);
    expect(lines).toHaveLength(4002);
    expect(lines[0]).toBe('a');
    expect(lines[1]).toBe('b');
    expect(lines[1999]).toBe('p');
    expect(lines[2000]).toBe('m');
    expect(lines[2001]).toBe('n');
    expect(lines[4001]).toBe('z');
    // 中间未设值的行应为空串（无多余/缺失分隔符）
    expect(lines[500]).toBe('');
    expect(lines[3000]).toBe('');
    // bytes 取 Blob 实际字节数
    expect(result.bytes).toBe(capturedBlob.size);
  });

  it('BOM + 自定义分隔/换行 正确拼接', async () => {
    const wb = new Workbook();
    wb.setCell(0, 0, { v: 'x' });
    wb.setCell(0, 1, { v: 'y' });
    wb.setCell(1, 1, { v: 'q' });

    const plugin = makePlugin(wb);
    plugin.exportCSV({ bom: true, delimiter: ';', lineEnding: '\r\n' });

    const text = capturedParts.join('');
    expect(text.startsWith('﻿')).toBe(true);
    const body = text.slice(1); // 去掉 BOM
    expect(body).toBe('x;y\r\n;q');
  });
});
