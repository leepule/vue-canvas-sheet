<template>
  <span class="vue-canvas-sheet-svg-icon">
    <component v-if="iconComponent" :is="iconComponent" />
  </span>
</template>

<script>
import { h, computed } from 'vue';
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
  Plus,
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

const rawIconMap = {
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
  'plus': Plus,
  'redo': Redo2,
  'strike-through': Strikethrough,
  'text-wrap': TextWrap,
  'undo': Undo2,
  'upload': Upload
};

function getIconData(comp) {
  if (!comp) return null;
  try {
    const vnode = comp({}, { slots: {} });
    if (vnode && vnode.props && vnode.props.icon) {
      return vnode.props.icon;
    }
  } catch (e) {}
  return null;
}

const iconDataMap = {};
for (const [key, comp] of Object.entries(rawIconMap)) {
  iconDataMap[key] = getIconData(comp);
}

function renderLucideNode(iconData) {
  if (!iconData || !Array.isArray(iconData.node)) return null;
  const svgAttrs = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: '24',
    height: '24',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '2',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    class: `lucide lucide-${iconData.name || ''}`
  };
  return h(
    'svg',
    svgAttrs,
    iconData.node.map((child) => h(child[0], child[1]))
  );
}

export default {
  name: 'SvgIcon',
  props: {
    name: { type: String, required: true }
  },
  setup(props) {
    return () => {
      const data = iconDataMap[props.name];
      return h('span', { class: 'vue-canvas-sheet-svg-icon' }, [
        data ? renderLucideNode(data) : null
      ]);
    };
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
