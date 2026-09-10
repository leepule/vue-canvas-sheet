import { Workbook } from '@/core/Workbook';
import useCanvasClipboard from '@/components/designer/hooks/useCanvasClipboard';

describe('useCanvasClipboard contract', () => {
  let workbook;
  let clipboardText;
  let originalClipboardDescriptor;

  beforeEach(() => {
    workbook = new Workbook();
    workbook.setData([
      ['Alice', 25],
      ['Bob', 30],
      ['', ''],
      ['', '']
    ]);
    clipboardText = '';
    originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => { clipboardText = text; },
        readText: async () => clipboardText
      }
    });
  });

  afterEach(() => {
    workbook.destroy();
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
    } else {
      delete navigator.clipboard;
    }
  });

  function clipboardActions() {
    return useCanvasClipboard({
      getWorkbook: () => workbook,
      isReadOnly: () => false,
      isRangeLocked: () => false
    });
  }

  test('复制应写入制表符文本并保留复制范围', async () => {
    workbook.setSelection(0, 0, 1, 1);

    await clipboardActions().handleCopy();

    expect(clipboardText).toBe('Alice\t25\nBob\t30');
    expect(workbook.copyRange).toEqual({ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } });
  });

  test('粘贴应解析数字并批量写入活动单元格', async () => {
    clipboardText = 'Carol\t28\nDave\t35';
    workbook.setSelection(2, 0, 2, 0);

    await clipboardActions().handlePaste();

    expect(workbook.getCellValue(2, 0)).toBe('Carol');
    expect(workbook.getCellValue(2, 1)).toBe(28);
    expect(workbook.getCellValue(3, 0)).toBe('Dave');
    expect(workbook.getCellValue(3, 1)).toBe(35);
  });

  test('只读状态下粘贴不应修改工作簿', async () => {
    clipboardText = 'Changed\t99';
    workbook.setSelection(0, 0, 0, 0);
    const actions = useCanvasClipboard({
      getWorkbook: () => workbook,
      isReadOnly: () => true,
      isRangeLocked: () => false
    });

    await actions.handlePaste();

    expect(workbook.getCellValue(0, 0)).toBe('Alice');
    expect(workbook.getCellValue(0, 1)).toBe(25);
  });
});
