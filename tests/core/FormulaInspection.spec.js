import { Workbook } from '@/core/Workbook';
import { FormulaInspectionError } from '@/core/data/FormulaRPNEvaluator';

describe('Formula inspection and translation', () => {
  let workbook;

  beforeEach(() => {
    workbook = new Workbook();
  });

  afterEach(() => {
    workbook.destroy();
  });

  test('inspects the fixed formula without reading cells or mutating content', () => {
    const readCell = vi.spyOn(workbook, 'getCellValue');
    const revision = workbook.getContentRevision();

    const result = workbook.inspectFormula('=A2*B2');

    expect(result).toEqual({
      valid: true,
      functions: [],
      references: [
        { type: 'cell', ref: 'A2', r: 1, c: 0, pos: 1, end: 3 },
        { type: 'cell', ref: 'B2', r: 1, c: 1, pos: 4, end: 6 }
      ],
      errors: []
    });
    expect(readCell).not.toHaveBeenCalled();
    expect(workbook.getContentRevision()).toBe(revision);
  });

  test('expands the fixed plan to deterministic row formulas', () => {
    const from = { r: 1, c: 2 };
    const formulas = [
      workbook.translateFormula('=A2*B2', { from, to: { r: 1, c: 2 } }),
      workbook.translateFormula('=A2*B2', { from, to: { r: 2, c: 2 } }),
      workbook.translateFormula('=A2*B2', { from, to: { r: 3, c: 2 } })
    ];

    expect(formulas).toEqual(['=A2*B2', '=A3*B3', '=A4*B4']);
  });

  test('reports both endpoints of a range reference', () => {
    const result = workbook.inspectFormula('=SUM(A2:B3)');

    expect(result.references).toEqual([
      {
        type: 'range',
        ref: 'A2:B3',
        start: { r: 1, c: 0 },
        endRef: { r: 2, c: 1 },
        pos: 5,
        end: 10
      }
    ]);
  });

  test('translates C2 to C4 and preserves formula formatting and strings', () => {
    const translated = workbook.translateFormula('= A2 * B2 + "A2"', {
      from: { r: 1, c: 2 },
      to: { r: 3, c: 2 }
    });

    expect(translated).toBe('= A4 * B4 + "A2"');
  });

  test('translates ranges without rewriting string literals', () => {
    const translated = workbook.translateFormula('=SUM(A2:B3)+"A2:B3"', {
      from: { r: 1, c: 2 },
      to: { r: 2, c: 3 }
    });

    expect(translated).toBe('=SUM(B3:C4)+"A2:B3"');
  });

  test.each([
    ['=1 2', 'SYNTAX_ERROR'],
    ['=1+', 'SYNTAX_ERROR'],
    ['=SUM(A1', 'SYNTAX_ERROR'],
    ['=Sheet2!A1', 'CROSS_SHEET_REFERENCE'],
    ['=$A$1', 'UNSUPPORTED_REFERENCE'],
    ['=UNKNOWN_FN(A1)', 'UNKNOWN_FUNCTION'],
    ['=NOW()', 'VOLATILE_FUNCTION'],
    ['=TODAY()', 'VOLATILE_FUNCTION'],
    ['=COUNTA(A1:A2)', 'UNSUPPORTED_FUNCTION'],
    ['=A1048577', 'REFERENCE_OUT_OF_RANGE'],
    ['=SUM(A1:XFE1)', 'REFERENCE_OUT_OF_RANGE']
  ])('rejects %s with %s', (formula, code) => {
    const result = workbook.inspectFormula(formula);

    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe(code);
    expect(result.errors[0].message).toBeTruthy();
  });

  test('rejects registered custom functions', () => {
    workbook.registerFunction('MY_AI_FN', () => 1);
    const result = workbook.inspectFormula('=MY_AI_FN(A1)');

    expect(result.valid).toBe(false);
    expect(result.functions).toEqual(['MY_AI_FN']);
    expect(result.errors[0].code).toBe('CUSTOM_FUNCTION');
  });

  test('does not return a partially translated formula after a boundary error', () => {
    expect(() => workbook.translateFormula('=A1048576+B1', {
      from: { r: 0, c: 0 },
      to: { r: 1, c: 0 }
    })).toThrow(FormulaInspectionError);

    expect(() => workbook.translateFormula('=A1', {
      from: 'A1',
      to: { r: 1, c: 0 }
    })).toThrow(FormulaInspectionError);
  });

  test('keeps the result inspectable for later AI plan checks', () => {
    const translated = workbook.translateFormula('=ROUND(A2*B2, 0)', {
      from: { r: 1, c: 2 },
      to: { r: 2, c: 2 }
    });
    const result = workbook.inspectFormula(translated);

    expect(translated).toBe('=ROUND(A3*B3, 0)');
    expect(result.valid).toBe(true);
    expect(result.functions).toEqual(['ROUND']);
    expect(result.references.map(reference => reference.ref)).toEqual(['A3', 'B3']);
  });
});
