import { Workbook } from '@/core/Workbook';
import useCanvasTextRender from '@/components/designer/hooks/useCanvasTextRender';

describe('useCanvasTextRender contract', () => {
  let workbook;

  beforeEach(() => {
    workbook = new Workbook();
    workbook.setData([
      [
        { v: 'contract-alpha', s: { bold: true, fontSize: 16 } },
        { v: 'contract-alpha', s: { bold: true, fontSize: 16 } }
      ],
      [42, null]
    ]);
  });

  afterEach(() => {
    workbook.destroy();
  });

  test('预测量应按字体去重并忽略已导入指标', () => {
    const textRender = useCanvasTextRender({
      getWorkbook: () => workbook,
      getTheme: () => ({ fontSize: '13px', fontFamily: 'Test Sans' })
    });
    const range = { startRow: 0, endRow: 1, startCol: 0, endCol: 1 };

    const initialRequests = textRender.scanPreloadText(range);
    expect(initialRequests).toHaveLength(2);
    expect(initialRequests.map(request => request.text)).toEqual(['contract-alpha', '42']);
    expect(initialRequests[0].font).toBe('bold 16px Test Sans');

    textRender.importMeasuredMetrics({ [initialRequests[0].key]: 120 });

    expect(textRender.scanPreloadText(range).map(request => request.text)).toEqual(['42']);
  });

  test('单行文本应按单元格布局写入画布', () => {
    const textRender = useCanvasTextRender({
      getWorkbook: () => workbook,
      getTheme: () => ({ fontSize: '13px', fontFamily: 'Test Sans' })
    });
    const drawCalls = [];
    const context = {
      font: '13px Test Sans',
      textBaseline: 'alphabetic',
      fillText: (...args) => drawCalls.push(args)
    };

    textRender.drawText(context, {
      x: 10,
      y: 20,
      w: 100,
      h: 30,
      text: {
        content: '画布文本',
        align: 'left',
        valign: 'middle',
        padding: 4,
        isWrap: false,
        style: null
      }
    });

    expect(context.textBaseline).toBe('middle');
    expect(drawCalls).toEqual([['画布文本', 14, 35]]);
  });
});
