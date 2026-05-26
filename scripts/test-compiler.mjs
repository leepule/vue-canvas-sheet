import { Workbook } from '../src/core/Workbook.js';

async function testCompiler() {
  const wb = new Workbook();
  
  // 设置基础数据
  wb.setData([
    [10, 20, 30],
    [100, 200, 300]
  ]);

  const testCases = [
    { f: '=A1+B1', expected: 30 },
    { f: '=SUM(A1:C1)', expected: 60 },
    { f: '=AVERAGE(A1:C1)', expected: 20 },
    { f: '=A1*2 + B1', expected: 40 },
    { f: '=SUM(A1:A2)', expected: 110 }
  ];

  console.log('--- Testing Formula Compiler ---');
  
  for (const tc of testCases) {
    const result = wb.evaluateFormula(tc.f, 10, 10); // 坐标不重要
    console.log(`Formula: ${tc.f} | Expected: ${tc.expected} | Result: ${result}`);
    if (Number(result) !== tc.expected) {
      console.error(`❌ Mismatch in formula: ${tc.f}`);
    } else {
      console.log('✅ Pass');
    }
  }
}

testCompiler().catch(console.error);
