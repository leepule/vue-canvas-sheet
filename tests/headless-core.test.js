import { describe, test, expect } from 'vitest';
import { Workbook } from '../src/core/Workbook.js';

describe('Headless Core Verification', () => {
  test('Workbook should perform basic data operations and calculations in Node.js', async () => {
    console.log('🚀 Starting Headless Core Verification...');

    // 1. 实例化 Workbook
    const wb = new Workbook({
      enablePersistence: false
    });
    console.log('✅ Workbook instance created.');

    // 2. 设置数据
    // 二维数组 setData 按 0-indexed 写入：
    //   Row 0: ['Name', 'Age']
    //   Row 1: ['Alice', 30]
    //   Row 2: ['Bob', 25]
    wb.setData([
      ['Name', 'Age'],
      ['Alice', 30],
      ['Bob', 25]
    ]);
    console.log('✅ Data set.');

    // 验证数据布局
    const nameHeader = wb.formulaEvaluator.getCellValue(0, 0);
    const aliceValue = wb.formulaEvaluator.getCellValue(1, 0);
    console.log(`📊 Layout Check - Row 0,0: ${nameHeader}, Row 1,0: ${aliceValue}`);

    // 3. 设置数值和公式
    // B3 (Row 2, Col 1) = 40
    // B4 (Row 3, Col 1) = 60
    // B5 (Row 4, Col 1) = SUM(B3:B4)
    wb.setCell(2, 1, { v: 40 });
    wb.setCell(3, 1, { v: 60 });
    wb.setCell(4, 1, { v: '=SUM(B3:B4)' });

    console.log('⏳ Calculating formulas (JS Fallback)...');
    await wb.recalcAll();

    // 调试：直接检查单元格对象
    const cellB5 = wb.getCell(4, 1);
    console.log('🔍 Cell B5 Object:', JSON.stringify(cellB5));

    const result = wb.formulaEvaluator.getCellValue(4, 1);
    console.log(`✅ Formula result: ${result} (Type: ${typeof result})`);

    // 断言
    expect(aliceValue).toBe('Alice');
    expect(Number(result)).toBe(100);

    console.log('\n✨ Headless Core verification PASSED!');
  });
});
