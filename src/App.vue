<template>
  <div id="app">
    <TableDesigner 
      ref="tableDesigner" 
      :initial-data="[]" 
      :read-only="readOnly" 
      :plugins="plugins"
      :enable-persistence="true"
      sheet-id="my_table_backup"
    />
  </div>
</template>

<script>
import TableDesigner from "./components/designer/index.vue";
import { AutoSavePlugin } from "./plugins/AutoSavePlugin";

export default {
  name: "App",
  components: {
    TableDesigner,
  },
  data() {
    return {
      plugins: [new AutoSavePlugin({ interval: 3000, key: "my_table_backup" })],
      readOnly: false,
    };
  },
  mounted() {
    this.$nextTick(() => {
      if (this.$refs.tableDesigner && this.$refs.tableDesigner.workbook) {
        window.__workbook__ = this.$refs.tableDesigner.workbook;
      }
    });
  },
};
</script>

<style>
body {
  margin: 0;
  padding: 0;
  overflow: hidden;
}
</style>

<style lang="scss" scoped>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  color: #2c3e50;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
</style>
