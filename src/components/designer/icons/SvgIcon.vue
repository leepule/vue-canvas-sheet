<template>
  <span class="vue-canvas-sheet-svg-icon">
    <component v-if="iconComponent" :is="iconComponent" />
  </span>
</template>

<script>
import {
  AlignCenter,
  AlignCenterVertical,
  AlignEndVertical,
  AlignLeft,
  AlignRight,
  AlignStartVertical,
  Bold,
  Code,
  DecimalsArrowLeft,
  DecimalsArrowRight,
  FileSpreadsheet,
  FileText,
  Italic,
  ListOrdered,
  Menu,
  Palette,
  PanelLeft,
  PanelTop,
  Percent,
  Pin,
  Redo2,
  RemoveFormatting,
  Search,
  Square,
  SquareDashed,
  Strikethrough,
  Table,
  TableCellsMerge,
  TextWrap,
  Undo2,
  Upload,
  X
} from '@lucide/vue';

const iconMap = {
  'align-bottom': AlignEndVertical,
  'align-center': AlignCenter,
  'align-left': AlignLeft,
  'align-middle': AlignCenterVertical,
  'align-right': AlignRight,
  'align-top': AlignStartVertical,
  'bold': Bold,
  'border-all': Table,
  'border-left': PanelLeft,
  'border-none': SquareDashed,
  'border-outline': Square,
  'border-top': PanelTop,
  'clear-formatting': RemoveFormatting,
  'close': X,
  'code': Code,
  'color-palette': Palette,
  'decimal-decrease': DecimalsArrowLeft,
  'decimal-increase': DecimalsArrowRight,
  'document-csv': FileText,
  'document-xls': FileSpreadsheet,
  'find': Search,
  'italic': Italic,
  'merge-cells': TableCellsMerge,
  'menu': Menu,
  'numbered-list': ListOrdered,
  'percent': Percent,
  'pin': Pin,
  'redo': Redo2,
  'strike-through': Strikethrough,
  'text-wrap': TextWrap,
  'undo': Undo2,
  'upload': Upload
};

export default {
  name: 'SvgIcon',
  props: {
    name: { type: String, required: true }
  },
  computed: {
    iconComponent() {
      return iconMap[this.name] || null;
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
  fill: none;
  stroke: currentColor;
}
</style>
