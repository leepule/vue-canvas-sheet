/**
 * E2E Test Page — Vue 应用入口
 *
 * 挂载最小化 TableDesigner 组件，供 Playwright 测试驱动。
 * Workbook 仅通过 App.vue 中的显式测试桥接访问。
 */
import { createApp } from 'vue';
import App from './App.vue';

const app = createApp(App);
app.mount('#app');

window.__e2eUnmountApp = () => {
  app.unmount();
};
