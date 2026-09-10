import { describe, it, expect } from 'vitest';
import { Workbook } from '../../src/core/Workbook';

// #23：SAB 绑定时，_buildFormulaWorkerPayload 应跳过纯数值依赖（worker 走共享内存读取），
// 仅序列化公式单元格与非数值/空依赖。
describe('Workbook._buildFormulaWorkerPayload - SAB 数值去重 (#23)', () => {
  it('SAB 可用时：纯数值依赖被跳过，公式与字符串依赖保留', () => {
    const wb = new Workbook();
    const sab = wb._ensureSharedStore();
    expect(sab).toBeTruthy(); // node 环境有 SharedArrayBuffer

    wb.setCell(0, 0, { v: 5 });          // A1 纯数值
    wb.setCell(0, 2, { v: 'hi' });       // C1 字符串
    wb.setCell(0, 1, { v: '=A1+C1' });   // B1 公式，依赖 A1、C1

    const b1 = wb._cellKey(0, 1);
    const a1 = wb._cellKey(0, 0);
    const c1 = wb._cellKey(0, 2);

    // 前置确认：A1 数值已同步进 SAB
    expect(sab.get(0, 0)).toBe(5);

    const payload = wb.formulaEngine._buildFormulaWorkerPayload([b1]);
    const data = payload.task.data;

    expect(data[b1]).toBeDefined();      // 公式单元格保留
    expect(data[b1].f).toBe('=A1+C1');
    expect(data[c1]).toBeDefined();      // 字符串依赖保留（SAB 存 EMPTY，worker 会回退 data）
    expect(data[a1]).toBeUndefined();    // 纯数值依赖被跳过
  });

  it('无 SAB 时：数值依赖照常序列化（回退保留）', () => {
    const wb = new Workbook();
    // 不调用 _ensureSharedStore，sharedValueStore 保持 null

    wb.setCell(0, 0, { v: 5 });
    wb.setCell(0, 1, { v: '=A1+1' });

    const b1 = wb._cellKey(0, 1);
    const a1 = wb._cellKey(0, 0);

    const payload = wb.formulaEngine._buildFormulaWorkerPayload([b1]);
    const data = payload.task.data;

    expect(data[b1]).toBeDefined();
    expect(data[a1]).toBeDefined();      // 无 SAB，数值依赖必须保留
    expect(data[a1].v).toBe(5);
  });

  it('SAB 可用但值不一致/越界时落回保留（自校验守卫）', () => {
    const wb = new Workbook();
    const sab = wb._ensureSharedStore();
    wb.setCell(0, 0, { v: 7 });
    wb.setCell(0, 1, { v: '=A1+1' });

    const a1 = wb._cellKey(0, 0);
    // 人为制造 SAB 与单元格值不一致：直接改写 SAB
    sab.set(0, 0, 999);

    const payload = wb.formulaEngine._buildFormulaWorkerPayload([wb._cellKey(0, 1)]);
    // get(0,0)=999 ≠ cell.v=7 → 守卫不命中 → 保留 A1
    expect(payload.task.data[a1]).toBeDefined();
    expect(payload.task.data[a1].v).toBe(7);
  });
});
