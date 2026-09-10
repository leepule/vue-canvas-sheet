import { describe, it, expect } from 'vitest';
import { getBorderProps } from '../../src/components/designer/utils/borderUtils.js';

describe('getBorderProps', () => {
  it('字符串输入应返回 solid 样式', () => {
    expect(getBorderProps('#ff0000')).toEqual({ color: '#ff0000', style: 'solid' });
    expect(getBorderProps('#000')).toEqual({ color: '#000', style: 'solid' });
  });

  it('对象输入应提取 color 和 style', () => {
    expect(getBorderProps({ color: '#00ff00', style: 'dashed' }))
      .toEqual({ color: '#00ff00', style: 'dashed' });
  });

  it('对象缺少 color 时应回退到 #000000', () => {
    expect(getBorderProps({ style: 'dotted' }))
      .toEqual({ color: '#000000', style: 'dotted' });
  });

  it('对象缺少 style 时应回退到 solid', () => {
    expect(getBorderProps({ color: '#123456' }))
      .toEqual({ color: '#123456', style: 'solid' });
  });

  it('空对象应回退到默认值', () => {
    expect(getBorderProps({}))
      .toEqual({ color: '#000000', style: 'solid' });
  });

  it('null/undefined 应返回默认值', () => {
    expect(getBorderProps(null).style).toBe('solid');
    expect(getBorderProps(undefined).style).toBe('solid');
  });
});
