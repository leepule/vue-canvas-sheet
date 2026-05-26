<template>
  <div class="app-root">
    <nav class="demo-nav">
      <span class="nav-title">Demo 选择：</span>
      <button :class="['nav-btn', { active: currentRoute === 'basic' }]" @click="currentRoute = 'basic'"> 基础使用 </button>
      <button :class="['nav-btn', { active: currentRoute === 'random' }]" @click="currentRoute = 'random'"> 随机样式
      </button>
      <button :class="['nav-btn', { active: currentRoute === 'collab' }]" @click="currentRoute = 'collab'"> 实时协同
      </button>
      <button class="nav-btn" @click="goZread"> Zread文档
      </button>
    </nav>
    <AppBasic v-if="currentRoute === 'basic'" />
    <AppRandom v-else-if="currentRoute === 'random'" />
    <AppCollab v-else />
  </div>
</template>
<script setup>
import { ref } from "vue";
import AppBasic from "./AppBasic.vue";
import AppRandom from "./AppRandom.vue";
import AppCollab from "./AppCollab.vue";

const currentRoute = ref("basic");
const goZread = () => {
  window.open('https://zread.ai/leepule/vue-canvas-sheet', '_blank')
}
</script>
<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family:
    "Inter",
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    Roboto,
    sans-serif;
  background-color: #f8fafc;
}

.app-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.demo-nav {
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
  padding: 12px 24px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 2px solid #3b82f6;
  flex-shrink: 0;
}

.nav-title {
  color: #94a3b8;
  font-size: 13px;
  font-weight: 500;
}

.nav-btn {
  padding: 8px 20px;
  border: 1px solid #334155;
  background: #1e293b;
  color: #94a3b8;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.25s ease;
  font-size: 13px;
  font-weight: 500;
}

.nav-btn:hover {
  background: #334155;
  border-color: #475569;
  color: #e2e8f0;
}

.nav-btn.active {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  border-color: #60a5fa;
  color: white;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
}
</style>
