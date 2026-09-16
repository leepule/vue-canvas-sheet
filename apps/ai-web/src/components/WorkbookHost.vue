<template>
  <div class="workbook-host">
    <TableDesigner
      ref="designerRef"
      :initial-data="initialData"
      :enable-persistence="false"
    />
  </div>
</template>

<script setup>
import { shallowRef } from 'vue'
import { TableDesigner } from 'vue-canvas-sheet'

defineProps({
  initialData: {
    type: [Array, Object],
    required: true
  }
})

const designerRef = shallowRef(null)

// Workbook 的创建和关闭由 TableDesigner 管理，宿主不重复销毁。
function getWorkbook() {
  return designerRef.value?.workbook ?? null
}

defineExpose({ getWorkbook })
</script>

<style scoped>
.workbook-host {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
