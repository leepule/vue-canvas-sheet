import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workbook } from '../../src/core/Workbook.js';

import {
    benchmark,
    cleanupWorkbook
} from './perfHarness.js';

describe('Formula Dependency Optimization', () => {
    let workbook;

    beforeEach(() => {
        workbook = new Workbook({ enableWasm: false });
        if (workbook.calcEngine) {
            workbook.calcEngine.batchDelay = 60_000;
        }

        for (let i = 0; i < 100; i++) {
            workbook.setCell(i, 0, { v: i + 1 });
        }
    });

    afterEach(() => {
        cleanupWorkbook(workbook);
        workbook = null;
    });

    it('should correctly handle large range dependencies (SUM(A1:A10000))', () => {
        const formula = '=SUM(A1:A10000)';
        const cellId = workbook._cellKey(0, 1); // B1

        workbook.setCell(0, 1, { v: formula });

        const dependents = workbook.rangeDependencyIndex.findDependents(0, 0); // A1
        expect(dependents.has(cellId)).toBe(true);

        const reverseDeps = workbook.reverseDependencyMap.get(cellId);
        expect(reverseDeps.ranges.length).toBe(1);
        expect(reverseDeps.cells.size).toBe(0);
    });

    it('should trigger recalculation when a cell in large range changes', () => {
        workbook.setCell(0, 1, { v: '=SUM(A1:A200)' }); // B1
        const b1 = workbook.getCell(0, 1);
        b1.dirty = false;

        workbook.setCell(99, 0, { v: 1000 });
        expect(workbook.getCell(0, 1).dirty).toBe(true);
    });

    it('should NOT trigger recalculation when a cell outside large range changes', () => {
        workbook.setCell(0, 1, { v: '=SUM(A1:A200)' }); // B1
        const b1 = workbook.getCell(0, 1);
        b1.dirty = false;

        workbook.setCell(299, 0, { v: 1000 });
        expect(workbook.getCell(0, 1).dirty).toBe(false);
    });

    it('should correctly remove range dependencies when formula is cleared', () => {
        const cellId = workbook._cellKey(0, 1);
        workbook.setCell(0, 1, { v: '=SUM(A1:A200)' });

        expect(workbook.rangeDependencyIndex.findDependents(0, 0).has(cellId)).toBe(true);

        workbook.setCell(0, 1, { v: 100 });
        expect(workbook.rangeDependencyIndex.findDependents(0, 0).has(cellId)).toBe(false);
    });

    it('gates large range dependency registration without expanding 100k cells', async () => {
        const formula = '=SUM(A1:J10000)';

        const legacyMetric = await benchmark(
            'range_dependency_register_legacy_expand_100k_cells',
            (legacyWorkbook) => {
                const deps = legacyWorkbook.formulaEvaluator.getDependencies(formula);
                const expanded = new Set(deps.cells);

                for (const range of deps.ranges) {
                    for (let r = range.startR; r <= range.endR; r++) {
                        for (let c = range.startC; c <= range.endC; c++) {
                            expanded.add(legacyWorkbook._cellKey(r, c));
                        }
                    }
                }

                expect(expanded.size).toBe(100_000);
                return { metadata: { expandedCells: expanded.size } };
            },
            {
                iterations: 2,
                warmup: 1,
                budget: false,
                setup: () => new Workbook({ enableWasm: false }),
                teardown: cleanupWorkbook
            }
        );

        const metric = await benchmark(
            'range_dependency_register_100k_cells',
            (currentWorkbook) => {
                const targetCell = currentWorkbook._cellKey(0, 11);
                currentWorkbook.setCell(0, 11, { v: formula });
                const reverseDeps = currentWorkbook.reverseDependencyMap.get(targetCell);

                expect(reverseDeps.ranges.length).toBe(1);
                expect(reverseDeps.cells.size).toBe(0);

                return {
                    metadata: {
                        rangeCells: 100_000,
                        reverseRangeCount: reverseDeps.ranges.length,
                        legacyAvgMs: legacyMetric.avgMs
                    }
                };
            },
            {
                iterations: 5,
                warmup: 1,
                setup: () => new Workbook({ enableWasm: false }),
                teardown: cleanupWorkbook
            }
        );

        expect(metric.avgMs).toBeLessThan(legacyMetric.avgMs);
    });
});
