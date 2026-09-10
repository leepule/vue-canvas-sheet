<template>
  <div class="e2e-test-app">
    <TableDesigner
      ref="designer"
      :initial-data="initialData"
      :read-only="readOnly"
      :plugins="plugins"
    />
  </div>
</template>

<script setup>
/**
 * E2E 最小化测试页面
 * - 只渲染 TableDesigner（含 CanvasTable），无工具栏/公式栏
 * - 测试通过显式 __e2e 桥接访问组件实例，通过 Playwright 模拟交互
 */
import { shallowRef } from 'vue';
import TableDesigner from 'vue-canvas-sheet';

const designer = shallowRef(null);
const initialData = shallowRef([]);
const readOnly = shallowRef(false);
const plugins = shallowRef([]);

function getWorkbook() {
  return designer.value?.workbook || null;
}

// 暴露给测试：允许动态注入数据（避免走 initialData 的 watch 路径）
function loadData(data) {
  const wb = getWorkbook();
  if (wb && data && data.length) {
    wb.setData(data);
  }
}

function destroy() {
  const wb = getWorkbook();
  if (wb && typeof wb.destroy === 'function') {
    wb.destroy();
  }
}

// 暴露给测试
if (typeof window !== 'undefined') {
  window.__e2e = {
    getWorkbook,
    loadData,
    setReadOnly(val) {
      readOnly.value = val;
      const wb = getWorkbook();
      if (wb) wb.readOnly = val;
    },
    setPlugins(list) {
      plugins.value = list || [];
    },
    destroy,
  };
}
</script>

<style>
.e2e-test-app {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>
