<template>
  <WorkspaceView />
</template>

<script setup>
import WorkspaceView from './views/WorkspaceView.vue'
</script>

<style>
:root {
  font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  color: #202426;
  background: #ffffff;
  font-synthesis: none;
  letter-spacing: 0;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  margin: 0;
}

body {
  overflow: hidden;
}
</style>
