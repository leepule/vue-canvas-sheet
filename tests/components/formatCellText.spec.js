import { describe, it, expect } from 'vitest';
import { formatCellText } from '../../src/components/designer/utils/formatCellText.js';

describe('formatCellText', () => {
  it('空值返回空字符串', () => {
    expect(formatCellText(null)).toBe('');
    expect(formatCellText(undefined)).toBe('');
    expect(formatCellText('')).toBe('');
  });

  it('无样式时返回原字符串', () => {
    expect(formatCellText('hello')).toBe('hello');
    expect(formatCellText(42)).toBe('42');
    expect(formatCellText(true)).toBe('true');
  });

  it('非数字值忽略样式返回原文', () => {
    expect(formatCellText('abc', { decimals: 2 })).toBe('abc');
    expect(formatCellText('N/A', { fmt: 'percent' })).toBe('N/A');
  });

  it('decimals 应正确控制小数位数', () => {
    expect(formatCellText(3.14159, { decimals: 2 })).toBe('3.14');
    expect(formatCellText(3.14159, { decimals: 0 })).toBe('3');
    expect(formatCellText('3.14159', { decimals: 3 })).toBe('3.142');
  });

  it('percent 格式应乘以100并附加百分号', () => {
    expect(formatCellText(0.25, { fmt: 'percent' })).toBe('25.00%');
    expect(formatCellText(0.1234, { fmt: 'percent', decimals: 1 })).toBe('12.3%');
    expect(formatCellText('0.5', { fmt: 'percent', decimals: 0 })).toBe('50%');
  });

  it('comma 格式应添加千分位分隔符', () => {
    const result = formatCellText(1234567.89, { fmt: 'comma', decimals: 2 });
    expect(result).toContain(',');
    expect(result).toContain('.89');
  });

  it('comma 格式不指定 decimals 时使用默认格式化', () => {
    const result = formatCellText(1000, { fmt: 'comma' });
    expect(result).toBe('1,000');
  });

  it('逗号分隔的数字字符串应被正确解析', () => {
    expect(formatCellText('1,234.56', { decimals: 1 })).toBe('1234.6');
  });

  it('decimals=0 应输出整数', () => {
    expect(formatCellText(3.99, { decimals: 0 })).toBe('4');
  });
});
