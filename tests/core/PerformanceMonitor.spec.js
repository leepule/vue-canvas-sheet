import { describe, it, expect } from 'vitest';
import { PerformanceMonitor, createPerformanceMonitor } from '../../src/core/utils/PerformanceMonitor';


describe('PerformanceMonitor Metric 增量统计', () => {
  it('未满容量：sum/min/max/avg 与朴素计算一致', () => {
    const monitor = new PerformanceMonitor({ maxEntries: 10 });
    monitor.record('m', 5);
    monitor.record('m', 1);
    monitor.record('m', 9);
    monitor.record('m', 3);

    const stats = monitor.getStats('m');
    expect(stats.count).toBe(4);
    expect(stats.sum).toBe(18);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(9);
    expect(stats.avg).toBe(4.5);
  });

  it('溢出淘汰：被淘汰值不再计入 sum/min/max', () => {
    const monitor = new PerformanceMonitor({ maxEntries: 3 });
    monitor.record('m', 1);
    monitor.record('m', 2);
    monitor.record('m', 3);
    expect(monitor.getStats('m').sum).toBe(6);
    expect(monitor.getStats('m').min).toBe(1);

    // push 4 → 淘汰 1（即原 min）
    monitor.record('m', 4);
    const s1 = monitor.getStats('m');
    expect(s1.count).toBe(3);
    expect(s1.sum).toBe(9);
    expect(s1.min).toBe(2);
    expect(s1.max).toBe(4);

    // push 0 → 淘汰 2，新 min 应为 0
    monitor.record('m', 0);
    const s2 = monitor.getStats('m');
    expect(s2.sum).toBe(7);
    expect(s2.min).toBe(0);
    expect(s2.max).toBe(4);
  });

  it('淘汰最大值后 max 应正确回退到次大值', () => {
    const monitor = new PerformanceMonitor({ maxEntries: 3 });
    monitor.record('m', 1);
    monitor.record('m', 100);
    monitor.record('m', 2);
    expect(monitor.getStats('m').max).toBe(100);

    // 淘汰 1 → 剩 100, 2
    monitor.record('m', 5);
    expect(monitor.getStats('m').max).toBe(100);

    // 淘汰 100（最大值）→ 剩 2, 5；再 push 一个
    monitor.record('m', 7);
    const s = monitor.getStats('m');
    expect(s.max).toBe(7);
    expect(s.min).toBe(2);
    expect(s.sum).toBe(14);
  });

  it('百分位（p50/p95/p99）正确', () => {
    const monitor = new PerformanceMonitor({ maxEntries: 100 });
    for (let i = 1; i <= 100; i++) monitor.record('m', i);
    const s = monitor.getStats('m');
    expect(s.count).toBe(100);
    expect(s.min).toBe(1);
    expect(s.max).toBe(100);
    expect(s.sum).toBe(5050);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
  });

  it('空指标返回零值结构', () => {
    const monitor = new PerformanceMonitor();
    monitor.record('m', 1);
    const metric = monitor.metrics.get('m');
    metric.clear();
    const s = metric.getStats();
    expect(s).toEqual({
      count: 0,
      sum: 0,
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p95: 0,
      p99: 0
    });
    // clear 后再 record 应恢复正常
    metric.record(42);
    const s2 = metric.getStats();
    expect(s2.sum).toBe(42);
    expect(s2.min).toBe(42);
    expect(s2.max).toBe(42);
  });
});
