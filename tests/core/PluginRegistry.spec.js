import { describe, expect, it } from 'vitest';
import { HookTypes, PluginRegistry } from '../../src/core/plugin/PluginRegistry.js';

describe('PluginRegistry 声明式 hooks 生命周期', () => {
  it('注销插件后 hook 不再执行且监听集合被释放', () => {
    const registry = new PluginRegistry({});
    const received = [];
    const plugin = {
      name: 'declarative-hook',
      hooks: {
        [HookTypes.CELL_CHANGE](payload) {
          received.push({ payload, plugin: this });
        }
      }
    };

    registry.register(plugin, { autoMount: false });
    registry.trigger(HookTypes.CELL_CHANGE, { value: 1 });
    expect(received).toHaveLength(1);
    expect(received[0].plugin).toBe(plugin);

    expect(registry.unregister(plugin.name)).toBe(true);
    registry.trigger(HookTypes.CELL_CHANGE, { value: 2 });

    expect(received).toHaveLength(1);
    expect(registry.hooks.has(HookTypes.CELL_CHANGE)).toBe(false);
    expect(registry.has(plugin.name)).toBe(false);
  });

  it('重复注册和注销同一插件不会累积 hook', () => {
    const registry = new PluginRegistry({});
    let callCount = 0;
    const plugin = {
      name: 'repeatable-hook',
      hooks: {
        [HookTypes.DATA_LOAD]() {
          callCount++;
        }
      }
    };

    for (let cycle = 0; cycle < 3; cycle++) {
      registry.register(plugin, { autoMount: false });
      expect(registry.hooks.get(HookTypes.DATA_LOAD)?.size).toBe(1);
      registry.trigger(HookTypes.DATA_LOAD, { cycle });
      expect(registry.unregister(plugin.name)).toBe(true);
      registry.trigger(HookTypes.DATA_LOAD, { cycle });
    }

    expect(callCount).toBe(3);
    expect(registry.hooks.has(HookTypes.DATA_LOAD)).toBe(false);
  });
});
