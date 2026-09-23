
import { StyleCache } from '../../src/core/render/StyleCache';


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
});
