/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
export class PluginOptimizer {
  constructor(pluginRegistry) {
    this.registry = pluginRegistry;
    
    // 钩子性能监控
    this.hookStats = new Map();
    
    // 懒加载配置
    this.lazyPlugins = new Set();
    this.loadedPlugins = new Set();
  }
  
  /**
   * 优化钩子触发性能
   */
  optimizeHooks() {
    // 按频率排序钩子
    const hotHooks = this._getHotHooks();
    
    for (const hookType of hotHooks) {
      this._optimizeHook(hookType);
    }
  }
  
  /**
   * 获取热点钩子
   */
  _getHotHooks() {
    const threshold = 100; // 每分钟触发100次以上
    const hotHooks = [];
    
    for (const [hookType, stats] of this.hookStats) {
      if (stats.count > threshold && stats.avgTime > 1) {
        hotHooks.push(hookType);
      }
    }
    
    return hotHooks;
  }
  
  /**
   * 优化单个钩子
   */
  _optimizeHook(hookType) {
    const handlers = this.registry.hooks.get(hookType);
    if (!handlers || handlers.size <= 1) return;
    
    // 按执行时间排序，将快速执行器放前面
    const sortedHandlers = Array.from(handlers).sort((a, b) => {
      const timeA = this.hookStats.get(`${hookType}|${a.name}`)?.avgTime || 0;
      const timeB = this.hookStats.get(`${hookType}|${b.name}`)?.avgTime || 0;
      return timeA - timeB;
    });
    
    // 更新钩子顺序
    this.registry.hooks.set(hookType, new Set(sortedHandlers));
  }
  
  /**
   * 监控钩子性能
   */
  monitorHook(hookType, handler) {
    const key = `${hookType}|${handler.name || 'anonymous'}`;
    
    if (!this.hookStats.has(key)) {
      this.hookStats.set(key, { count: 0, totalTime: 0, avgTime: 0 });
    }
    
    const stats = this.hookStats.get(key);
    stats.count++;
    
    return (result) => {
      // 原有处理
      const originalResult = handler(result);
      
      // 记录执行时间
      if (result._hookStartTime) {
        const duration = Date.now() - result._hookStartTime;
        stats.totalTime += duration;
        stats.avgTime = stats.totalTime / stats.count;
      }
      
      return originalResult;
    };
  }
  
  /**
   * 懒加载插件
   */
  async lazyLoad(pluginName) {
    if (this.loadedPlugins.has(pluginName)) return;
    
    const plugin = this.registry.get(pluginName);
    if (!plugin) return;
    
    // 检查是否支持懒加载
    if (plugin.lazyLoad) {
      await plugin.lazyLoad();
      this.loadedPlugins.add(pluginName);
    }
  }
  
  /**
   * 批量懒加载
   */
  async batchLazyLoad(pluginNames) {
    await Promise.all(
      pluginNames.map(name => this.lazyLoad(name))
    );
  }
  
  /**
   * 获取性能报告
   */
  getPerformanceReport() {
    const report = {
      hooks: {},
      summary: {
        totalCalls: 0,
        totalTime: 0,
        slowestHooks: []
      }
    };
    
    for (const [key, stats] of this.hookStats) {
      const [hookType] = key.split('|');
      
      if (!report.hooks[hookType]) {
        report.hooks[hookType] = { count: 0, totalTime: 0, avgTime: 0 };
      }
      
      report.hooks[hookType].count += stats.count;
      report.hooks[hookType].totalTime += stats.totalTime;
      report.hooks[hookType].avgTime = stats.avgTime;
      
      report.summary.totalCalls += stats.count;
      report.summary.totalTime += stats.totalTime;
    }
    
    // 找出最慢的钩子
    report.summary.slowestHooks = Object.entries(report.hooks)
      .sort(([, a], [, b]) => b.avgTime - a.avgTime)
      .slice(0, 5)
      .map(([name, stats]) => ({ name, avgTime: stats.avgTime }));
    
    return report;
  }
}