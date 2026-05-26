<template>
  <span class="vue-canvas-sheet-svg-icon" v-html="svgContent"></span>
</template>

<script>
const modules = import.meta.glob(
  '../../../../node_modules/@handsontable/spreadsheet-icons/svgs/compressed/*.svg',
  { eager: true, query: '?raw', import: 'default' }
);
const svgMap = {};
for (const path in modules) {
  const name = path.substring(path.lastIndexOf('/') + 1, path.lastIndexOf('.'));
  svgMap[name] = modules[path];
}

export default {
  name: 'SvgIcon',
  props: {
    name: { type: String, required: true }
  },
  computed: {
    svgContent() {
      return svgMap[this.name] || '';
    }
  }
};
</script>

<style>
.vue-canvas-sheet-svg-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1em;
  font-size: 22px;
  line-height: 1;
  vertical-align: middle;
}
.vue-canvas-sheet-svg-icon > svg {
  width: 1em;
  height: 1em;
  display: block;
  fill: currentColor;
}
</style>
