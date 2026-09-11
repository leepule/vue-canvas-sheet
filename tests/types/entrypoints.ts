import TableDesigner, {
  SvgIcon,
  Workbook,
  createAutoSavePlugin
} from 'vue-canvas-sheet';
import {
  EventEmitter,
  HookTypes,
  PluginRegistry,
  SelectionManager,
  SharedValueStore,
  Store,
  StoreManager,
  Workbook as CoreWorkbook,
  createPlugin
} from 'vue-canvas-sheet/core';
import {
  LRUCache,
  OffscreenRenderer,
  Priority,
  TaskState,
  createOffscreenRenderer,
  createProgressiveRenderer,
  measureTextWidth
} from 'vue-canvas-sheet/render';
import { FileSpreadsheet, Search as SearchIcon } from 'vue-canvas-sheet/icons';
import {
  AutoSavePlugin,
  ExportPlugin,
  createAutoSavePlugin,
  createRealtimeCollaborationPlugin
} from 'vue-canvas-sheet/plugins';
import type { PersistenceStorage } from 'vue-canvas-sheet/core';

const workbook = new CoreWorkbook();
const wasmDisabledWorkbook = new CoreWorkbook({ enableWasm: false });
const storage: PersistenceStorage = workbook.enablePersistenceStorage();
storage.close();
workbook.formulaEvaluator.recalcDirty();
workbook.formulaEvaluator.triggerRecalc(0, 0);
workbook.formulaEvaluator.evaluateFormula('=1+1', 0, 0);
workbook.formulaEvaluator.getDependencies('=A1');

void [
  TableDesigner,
  SvgIcon,
  Workbook,
  createAutoSavePlugin,
  EventEmitter,
  HookTypes,
  PluginRegistry,
  SelectionManager,
  SharedValueStore,
  Store,
  StoreManager,
  createPlugin,
  LRUCache,
  OffscreenRenderer,
  Priority,
  TaskState,
  createOffscreenRenderer,
  createProgressiveRenderer,
  measureTextWidth,
  FileSpreadsheet,
  SearchIcon,
  AutoSavePlugin,
  ExportPlugin,
  createAutoSavePlugin,
  createRealtimeCollaborationPlugin,
  wasmDisabledWorkbook
];

// @ts-expect-error Store is only exported by vue-canvas-sheet/core.
import { Store as RootStore } from 'vue-canvas-sheet';
// @ts-expect-error TableDesigner is only exported by the package root.
import { TableDesigner as CoreTableDesigner } from 'vue-canvas-sheet/core';
// @ts-expect-error Workbook is not part of the render entrypoint.
import { Workbook as RenderWorkbook } from 'vue-canvas-sheet/render';
// @ts-expect-error OffscreenRenderer is only exported by the render entrypoint.
import { OffscreenRenderer as RootRenderer } from 'vue-canvas-sheet';
// @ts-expect-error TableDesigner is not part of the plugins entrypoint.
import { TableDesigner as PluginsTableDesigner } from 'vue-canvas-sheet/plugins';

// @ts-expect-error recalcDirty is not a Workbook runtime method.
workbook.recalcDirty();
// @ts-expect-error triggerRecalc is not a Workbook runtime method.
workbook.triggerRecalc(0, 0);
// @ts-expect-error evaluateFormula is not a Workbook runtime method.
workbook.evaluateFormula('=1+1', 0, 0);
// @ts-expect-error getDependencies is not a Workbook runtime method.
workbook.getDependencies('=A1');
// @ts-expect-error subscribe is not a Workbook runtime method.
workbook.subscribe(() => {});

void [RootStore, CoreTableDesigner, RenderWorkbook, RootRenderer, PluginsTableDesigner];
