/**
 * Excel 导出 Worker
 * 在后台线程中使用 xlsx-js-style 生成文件，避免阻塞 UI
 */
import * as XLSX from 'xlsx-js-style';
import { buildWorksheetFromSparseSnapshot } from '../plugins/utils/xlsxAdapter.js';

self.onmessage = async (e) => {
    const { data, config, fileName, snapshot } = e.data;
    const startTime = performance.now();

    try {
        self.postMessage({ type: 'progress', phase: 'xlsx-build', progress: 0.25 });

        const sheet = snapshot
            ? buildWorksheetFromSparseSnapshot(XLSX, snapshot)
            : XLSX.utils.aoa_to_sheet(data);

        if (!snapshot && config) {
            if (config.merges) sheet['!merges'] = config.merges;
            if (config.colWidths) sheet['!cols'] = config.colWidths.map(w => ({ wch: w / 7.5 }));
        }

        self.postMessage({ type: 'progress', phase: 'xlsx-write', progress: 0.75 });

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');

        const raw = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
        // xlsx-js-style returns Uint8Array for type:'array' in modern builds, but
        // some versions hand back a plain Array. Normalize so transferList works.
        const buffer = raw instanceof Uint8Array
            ? raw
            : (raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw));
        const endTime = performance.now();

        self.postMessage({
            success: true,
            buffer,
            fileName: fileName || 'export.xlsx',
            duration: endTime - startTime,
            byteLength: buffer.byteLength
        }, [buffer.buffer]);

    } catch (error) {
        self.postMessage({
            success: false,
            error: error.message
        });
    }
};
