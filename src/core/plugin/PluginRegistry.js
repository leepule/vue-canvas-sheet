/**
 * Vue-Canvas-Sheet
 * (c) 2026-present
 * Released under the Apache License, Version 2.0.
 */
/**
 * @fileoverview 插件注册中心
 * 提供完整的插件生命周期管理和钩子系统
 */

/**
 * @typedef {'before-init' | 'after-init' | 'before-mount' | 'after-mount' | 'before-unmount' | 'after-unmount' | 'cell-change' | 'selection-change' | 'data-load' | 'structure-change' | 'style-change' | 'merge-change' | 'freeze-change' | 'error'} HookType
 */

/**
 * @typedef {Object} PluginInterface
 * @property {string} name - 插件名称（必须唯一）
 * @property {string} [version] - 插件版本
 * @property {string} [description] - 插件描述
 * @property {string[]} [dependencies] - 依赖的其他插件名称
 * @property {Object} [hooks] - 钩子函数映射
 * @property {Function} [onInit] - 初始化时调用（插件注册时）
 * @property {Function} [onMounted] - 挂载时调用（工作簿就绪后）
 * @property {Function} [onUnmount] - 卸载时调用
 * @property {Function} [onError] - 错误处理
 */

/**
 * 钩子类型枚举
 */
export const HookTypes = {
  // 生命周期钩子
  BEFORE_INIT: 'before-init',
  AFTER_INIT: 'after-init',
  BEFORE_MOUNT: 'before-mount',
  AFTER_MOUNT: 'after-mount',
  BEFORE_UNMOUNT: 'before-unmount',
  AFTER_UNMOUNT: 'after-unmount',
  
  // 数据操作钩子
  CELL_CHANGE: 'cell-change',
  SELECTION_CHANGE: 'selection-change',
  DATA_LOAD: 'data-load',
  STRUCTURE_CHANGE: 'structure-change',
  STYLE_CHANGE: 'style-change',
  MERGE_CHANGE: 'merge-change',
  FREEZE_CHANGE: 'freeze-change',
  
  // 错误处理钩子
  ERROR: 'error'
};

import { PluginOptimizer } from './PluginOptimizer.js';

/**
 * 插件注册中心
 * 管理插件的生命周期和钩子系统
 */
export class PluginRegistry {
  /**
   * @param {Workbook} workbook - 工作簿实例
   */
  constructor(workbook) {
    /** @type {Workbook} */
    this.workbook = workbook;
    
    /** @type {Map<string, PluginInterface>} */
    this.plugins = new Map();
    
    /** @type {Map<string, Set<Function>>} */
    this.hooks = new Map();
    
    /** @type {Map<string, any>} */
    this.sharedState = new Map();
    
    /** @type {boolean} */
    this._initialized = false;
    
    // 启用优化器
    this.optimizer = new PluginOptimizer(this);
  }

  /**
   * 优化系统的钩子
   * 这会基于各个钩子的运行频率和执行时间对钩子的执行顺序进行重排
   */
  optimizeHooks() {
    if (this.optimizer) {
      this.optimizer.optimizeHooks();
    }
  }

  /**
   * 记录钩子执行时间的辅助方法
   */
  getPerformanceReport() {
    return this.optimizer ? this.optimizer.getPerformanceReport() : null;
  }

  /**
   * 初始化插件系统
   * 在工作簿就绪后调用
   */
  init() {
    if (this._initialized) return;
    this._initialized = true;
    this._triggerHook(HookTypes.AFTER_INIT, { registry: this });
  }

  /**
   * 注册插件
   * @param {PluginInterface} plugin - 插件实例
   * @param {Object} [options] - 注册选项
   * @param {boolean} [options.autoMount=true] - 是否自动挂载
   * @returns {PluginRegistry} 返回 this 以支持链式调用
   * @throws {Error} 如果插件名称已存在或依赖未满足
   */
  register(plugin, options = {}) {
    const { autoMount = true } = options;
    
    // 验证插件
    if (!plugin.name) {
      throw new Error('[PluginRegistry] Plugin must have a name property');
    }
    
    if (this.plugins.has(plugin.name)) {
      throw new Error(`[PluginRegistry] Plugin "${plugin.name}" is already registered`);
    }
    
    // 检查依赖
    if (plugin.dependencies && plugin.dependencies.length > 0) {
      const missingDeps = plugin.dependencies.filter(dep => !this.plugins.has(dep));
      if (missingDeps.length > 0) {
        throw new Error(`[PluginRegistry] Plugin "${plugin.name}" requires plugins: ${missingDeps.join(', ')}`);
      }
    }
    
    // 触发 before-init 钩子
    this._triggerHook(HookTypes.BEFORE_INIT, { plugin });
    
    // 注册插件
    this.plugins.set(plugin.name, plugin);
    
    // 注册插件的钩子
    if (plugin.hooks) {
      Object.entries(plugin.hooks).forEach(([hookType, handler]) => {
        this.on(hookType, handler.bind(plugin));
      });
    }
    
    // 调用插件的初始化方法
    if (plugin.onInit) {
      try {
        plugin.onInit(this.workbook, this);
      } catch (error) {
        console.error(`[PluginRegistry] Error in ${plugin.name}.onInit:`, error);
        this._handlePluginError(plugin, error);
      }
    }
    
    // 触发 after-init 钩子
    this._triggerHook(HookTypes.AFTER_INIT, { plugin });
    
    
    // 自动挂载
    if (autoMount && this._initialized) {
      this._mountPlugin(plugin);
    }
    
    return this;
  }

  /**
   * 别名，兼容旧版 API
   * @param {PluginInterface} plugin - 插件实例
   * @deprecated 使用 register() 替代
   */
  add(plugin) {
    this.register(plugin);
  }

  /**
   * 挂载所有已注册的插件
   */
  mountAll() {
    this.plugins.forEach(plugin => this._mountPlugin(plugin));
  }

  /**
   * 挂载单个插件
   * @param {PluginInterface} plugin - 插件实例
   * @private
   */
  _mountPlugin(plugin) {
    if (plugin._mounted) return;
    
    // 触发 before-mount 钩子
    this._triggerHook(HookTypes.BEFORE_MOUNT, { plugin });
    
    if (plugin.onMounted) {
      try {
        plugin.onMounted(this.workbook, this);
      } catch (error) {
        console.error(`[PluginRegistry] Error in ${plugin.name}.onMounted:`, error);
        this._handlePluginError(plugin, error);
        return;
      }
    }
    
    plugin._mounted = true;
    
    // 触发 after-mount 钩子
    this._triggerHook(HookTypes.AFTER_MOUNT, { plugin });
    
  }

  /**
   * 卸载插件
   * @param {string} name - 插件名称
   * @returns {boolean} 是否成功卸载
   */
  unregister(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      console.warn(`[PluginRegistry] Plugin "${name}" not found`);
      return false;
    }
    
    // 检查是否有其他插件依赖此插件
    const dependents = this._getDependents(name);
    if (dependents.length > 0) {
      console.warn(`[PluginRegistry] Cannot unregister "${name}", required by: ${dependents.join(', ')}`);
      return false;
    }
    
    // 触发 before-unmount 钩子
    this._triggerHook(HookTypes.BEFORE_UNMOUNT, { plugin });
    
    // 调用插件的卸载方法
    if (plugin.onUnmount) {
      try {
        plugin.onUnmount();
      } catch (error) {
        console.error(`[PluginRegistry] Error in ${plugin.name}.onUnmount:`, error);
      }
    }
    
    // 移除插件的钩子
    if (plugin.hooks) {
      Object.entries(plugin.hooks).forEach(([hookType, handler]) => {
        this.off(hookType, handler.bind(plugin));
      });
    }
    
    plugin._mounted = false;
    this.plugins.delete(name);
    
    // 触发 after-unmount 钩子
    this._triggerHook(HookTypes.AFTER_UNMOUNT, { plugin: { name } });
    
    return true;
  }

  /**
   * 获取依赖此插件的其他插件
   * @param {string} pluginName - 插件名称
   * @returns {string[]} 依赖此插件的插件名称列表
   * @private
   */
  _getDependents(pluginName) {
    const dependents = [];
    this.plugins.forEach((plugin, name) => {
      if (plugin.dependencies && plugin.dependencies.includes(pluginName)) {
        dependents.push(name);
      }
    });
    return dependents;
  }

  /**
   * 获取插件实例
   * @param {string} name - 插件名称
   * @returns {PluginInterface|undefined}
   */
  get(name) {
    return this.plugins.get(name);
  }

  /**
   * 检查插件是否已注册
   * @param {string} name - 插件名称
   * @returns {boolean}
   */
  has(name) {
    return this.plugins.has(name);
  }

  /**
   * 检查插件是否已挂载
   * @param {string} name - 插件名称
   * @returns {boolean}
   */
  isMounted(name) {
    const plugin = this.plugins.get(name);
    return plugin ? plugin._mounted === true : false;
  }

  /**
   * 注册钩子监听器
   * @param {HookType} hookType - 钩子类型
   * @param {Function} handler - 处理函数
   * @returns {Function} 取消订阅函数
   */
  on(hookType, handler) {
    if (!this.hooks.has(hookType)) {
      this.hooks.set(hookType, new Set());
    }
    
    // 如果启用优化器，将其包装以监控性能
    let finalHandler = handler;
    if (this.optimizer) {
      finalHandler = this.optimizer.monitorHook(hookType, handler);
    }

    this.hooks.get(hookType).add(finalHandler);
    
    // 返回取消订阅函数
    return () => this.off(hookType, finalHandler);
  }

  /**
   * 移除钩子监听器
   * @param {HookType} hookType - 钩子类型
   * @param {Function} handler - 处理函数
   */
  off(hookType, handler) {
    this.hooks.get(hookType)?.delete(handler);
  }

  /**
   * 触发钩子
   * @param {HookType} hookType - 钩子类型
   * @param {Object} data - 钩子数据
   * @returns {any} 钩子处理结果（支持修改数据）
   */
  trigger(hookType, data) {
    return this._triggerHook(hookType, data);
  }

  /**
   * 内部钩子触发实现
   * @param {HookType} hookType - 钩子类型
   * @param {Object} data - 钩子数据
   * @returns {any}
   * @private
   */
  _triggerHook(hookType, data) {
    const handlers = this.hooks.get(hookType);
    if (!handlers || handlers.size === 0) return data;
    
    let result = data;
    // 为性能监控添加时间戳
    if (result && typeof result === 'object' && !result._hookStartTime) {
        result._hookStartTime = Date.now();
    }
    
    handlers.forEach(handler => {
      try {
        const handlerResult = handler(result);
        // 如果处理器返回了数据，则更新结果（支持数据修改）
        if (handlerResult !== undefined) {
          result = handlerResult;
        }
      } catch (error) {
        console.error(`[PluginRegistry] Error in hook "${hookType}":`, error);
      }
    });
    
    // 清理附加的时间戳
    if (result && typeof result === 'object' && result._hookStartTime) {
        delete result._hookStartTime;
    }
    
    return result;
  }

  /**
   * 设置共享状态（用于插件间通信）
   * @param {string} key - 状态键
   * @param {any} value - 状态值
   */
  setSharedState(key, value) {
    this.sharedState.set(key, value);
  }

  /**
   * 获取共享状态
   * @param {string} key - 状态键
   * @param {any} [defaultValue] - 默认值
   * @returns {any}
   */
  getSharedState(key, defaultValue = undefined) {
    return this.sharedState.has(key) ? this.sharedState.get(key) : defaultValue;
  }

  /**
   * 删除共享状态
   * @param {string} key - 状态键
   * @returns {boolean}
   */
  deleteSharedState(key) {
    return this.sharedState.delete(key);
  }

  /**
   * 处理插件错误
   * @param {PluginInterface} plugin - 插件实例
   * @param {Error} error - 错误对象
   * @private
   */
  _handlePluginError(plugin, error) {
    // 触发错误钩子
    this._triggerHook(HookTypes.ERROR, {
      pluginName: plugin.name,
      error,
      timestamp: Date.now()
    });
    
    // 调用插件的错误处理方法
    if (plugin.onError) {
      try {
        plugin.onError(error, this.workbook);
      } catch (e) {
        console.error(`[PluginRegistry] Error in ${plugin.name}.onError:`, e);
      }
    }
  }

  /**
   * 销毁插件系统，卸载所有插件
   */
  destroy() {
    // 卸载所有插件
    this.plugins.forEach((plugin, name) => {
      this.unregister(name);
    });
    
    // 清理钩子
    this.hooks.clear();
    this.sharedState.clear();
    this._initialized = false;
    
  }

  /**
   * 获取所有已注册的插件信息
   * @returns {Array<{name: string, version: string, mounted: boolean}>}
   */
  getPluginInfo() {
    const info = [];
    this.plugins.forEach((plugin, name) => {
      info.push({
        name,
        version: plugin.version || 'unknown',
        description: plugin.description || '',
        mounted: plugin._mounted === true,
        dependencies: plugin.dependencies || []
      });
    });
    return info;
  }
}

/**
 * 创建基础插件类的工厂函数
 * @param {string} name - 插件名称
 * @param {Object} definition - 插件定义
 * @returns {PluginInterface}
 */
export function createPlugin(name, definition = {}) {
  return {
    name,
    version: definition.version || '1.0.0',
    description: definition.description || '',
    dependencies: definition.dependencies || [],
    hooks: definition.hooks || {},
    onInit: definition.onInit,
    onMounted: definition.onMounted,
    onUnmount: definition.onUnmount,
    onError: definition.onError,
    ...definition
  };
}
