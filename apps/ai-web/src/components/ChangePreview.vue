<template>
  <section class="change-preview" aria-label="AI 修改预览">
    <header class="change-preview-header">
      <h3>修改预览</h3>
      <span :class="['change-preview-status', error ? 'is-error' : 'is-ready']">
        {{ error ? '不可应用' : '就绪' }}
      </span>
    </header>

    <p v-if="error" class="change-preview-error">{{ error }}</p>

    <table v-else-if="rows.length" class="change-preview-table">
      <thead>
        <tr>
          <th>单元格</th>
          <th>公式</th>
          <th>旧值</th>
          <th>新值</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key">
          <td>{{ row.cellRef }}</td>
          <td class="change-preview-formula">{{ row.formula }}</td>
          <td>{{ row.oldValue }}</td>
          <td class="change-preview-value">{{ row.newValue }}</td>
        </tr>
      </tbody>
    </table>

    <ul v-if="warnings.length" class="change-preview-warnings">
      <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
    </ul>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  preview: {
    type: Object,
    default: null
  },
  error: {
    type: String,
    default: ''
  }
})

const rows = computed(() => props.preview?.changes?.map(change => ({
  key: `${change.r}:${change.c}`,
  cellRef: change.cellRef,
  formula: change.formula,
  oldValue: change.oldValue ?? '空',
  newValue: change.newValue ?? '空'
})) ?? [])

const warnings = computed(() => props.preview?.warnings ?? [])
</script>

<style scoped>
.change-preview {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 16px;
}

.change-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.change-preview-header h3 {
  margin: 0;
  color: #1f2328;
  font-size: 14px;
  line-height: 20px;
}

.change-preview-status {
  flex: none;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 18px;
}

.change-preview-status.is-ready {
  color: #176440;
  background: #e7f4ed;
}

.change-preview-status.is-error {
  color: #8a2b19;
  background: #f9e7e2;
}

.change-preview-error {
  margin: 0;
  color: #8a2b19;
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

.change-preview-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 12px;
}

.change-preview-table th,
.change-preview-table td {
  min-width: 0;
  padding: 6px 4px;
  border-bottom: 1px solid #dce0e3;
  text-align: left;
  overflow-wrap: anywhere;
}

.change-preview-table th {
  color: #50565b;
  font-weight: 600;
}

.change-preview-formula {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.change-preview-value {
  color: #176440;
  font-weight: 600;
}

.change-preview-warnings {
  margin: 0;
  padding-left: 18px;
  color: #6b5b16;
  font-size: 12px;
  line-height: 18px;
}
</style>
