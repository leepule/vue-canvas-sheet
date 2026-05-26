
import { StyleCache } from '../../src/core/render/StyleCache';
import { StyleUtils } from '../../src/core/render/StyleUtils';


describe('Table Optimizations', () => {
  test('StyleCache Hashing should work correctly', () => {
    const cache = new StyleCache();
    const style1 = { fontWeight: 'bold', color: '#ff0000', fontSize: 12 };
    const style2 = { fontWeight: 'bold', color: '#ff0000', fontSize: 12 };
    const style3 = { fontSize: 12, color: '#ff0000', fontWeight: 'bold' };
    
    const id1 = cache.normalize(style1);
    const id2 = cache.normalize(style2);
    const id3 = cache.normalize(style3);
    
    expect(id1).toBe(id2);
    expect(id1).toBe(id3);
  });

  test('StyleUtils Bitmasks should work correctly', () => {
    const props = { fontWeight: 'bold', fontStyle: 'italic', td: 'line-through', wrap: true };
    const mask = StyleUtils.encodeBitmask(props);
    const decoded = StyleUtils.decodeBitmask(mask);
    
    expect(decoded.fontWeight).toBe('bold');
    expect(decoded.fontStyle).toBe('italic');
    expect(decoded.td).toBe('line-through');
    expect(decoded.wrap).toBe(true);
  });
});
