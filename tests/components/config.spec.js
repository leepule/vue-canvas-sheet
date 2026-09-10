import { describe, it, expect } from 'vitest';
import { TableTheme } from '../../src/components/designer/config.js';

describe('TableTheme', () => {
  it('应包含所有必需的色彩键', () => {
    const required = [
      'textColor', 'borderColor', 'headerBg', 'headerHoverBg',
      'selectionBorder', 'selectionBg', 'dragGuideColor',
      'frozenLineColor', 'fillHandleColor', 'fillTargetBorder'
    ];
    required.forEach(key => {
      expect(TableTheme).toHaveProperty(key);
      expect(typeof TableTheme[key]).toBe('string');
    });
  });

  it('应包含所有必需的尺寸键', () => {
    expect(TableTheme.defaultColWidth).toBeGreaterThan(0);
    expect(TableTheme.defaultRowHeight).toBeGreaterThan(0);
    expect(TableTheme.colHeaderHeight).toBeGreaterThan(0);
    expect(TableTheme.rowHeaderWidth).toBeGreaterThan(0);
  });

  it('fontFamily 和 fontSize 应为有效值', () => {
    expect(typeof TableTheme.fontFamily).toBe('string');
    expect(TableTheme.fontFamily.length).toBeGreaterThan(0);
    expect(typeof TableTheme.fontSize).toBe('string');
    expect(TableTheme.fontSize).toMatch(/^\d+px$/);
    expect(typeof TableTheme.headerFontSize).toBe('string');
  });

  it('frozenBg 默认为 null', () => {
    expect(TableTheme.frozenBg).toBeNull();
  });
});
