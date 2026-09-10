import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const entrypointContracts = {
  'vue-canvas-sheet': [
    'AutoSavePlugin',
    'CollaborativeCursorPlugin',
    'ExportPlugin',
    'ImportPlugin',
    'RealtimeCollaborationPlugin',
    'SelectionHistoryPlugin',
    'SvgIcon',
    'TableDesigner',
    'Workbook',
    'createAutoSavePlugin',
    'createCollaborativeCursorPlugin',
    'createExportPlugin',
    'createImportPlugin',
    'createRealtimeCollaborationPlugin',
    'createSelectionHistoryPlugin',
    'default'
  ],
  'vue-canvas-sheet/core': [
    'EventEmitter',
    'HookTypes',
    'PluginRegistry',
    'SelectionManager',
    'SharedValueStore',
    'Store',
    'StoreManager',
    'Workbook',
    'createPlugin'
  ],
  'vue-canvas-sheet/render': [
    'LRUCache',
    'OffscreenRenderer',
    'Priority',
    'TaskState',
    'canCacheTextBitmap',
    'createOffscreenRenderer',
    'createProgressiveRenderer',
    'getBitmapDrawPosition',
    'getLineStartX',
    'getSingleLineDecoration',
    'getSingleLineTextLayout',
    'getTextBitmapSize',
    'getWrappedTextLayout',
    'isNumberLikeText',
    'isOffscreenCanvasSupported',
    'makeTextBitmapCacheKey',
    'makeTextCacheKey',
    'makeWrappedTextCacheKey',
    'measureTextWidth',
    'parseFontSize',
    'wrapTextByWidth'
  ]
};

for (const [moduleSpecifier, expectedExports] of Object.entries(entrypointContracts)) {
  const runtimeModule = await import(moduleSpecifier);
  const actualExports = Object.keys(runtimeModule).sort();
  assert.deepEqual(actualExports, [...expectedExports].sort(), `${moduleSpecifier} export drift`);
}

const lucideIcons = await import('../src/icons/index.js');
for (const expectedExport of ['FileSpreadsheet', 'Search', 'TableCellsMerge']) {
  assert.equal(typeof lucideIcons[expectedExport], 'function', `icons entry is missing ${expectedExport}`);
}

const coreDeclarations = await readFile(
  new URL('../types/core.d.ts', import.meta.url),
  'utf8'
);
const workbookDeclarationStart = coreDeclarations.indexOf('export class Workbook {');
const workbookDeclarationEnd = coreDeclarations.indexOf('\n}\n', workbookDeclarationStart);
const workbookDeclaration = coreDeclarations.slice(
  workbookDeclarationStart,
  workbookDeclarationEnd
);
const declaredWorkbookMethods = [...workbookDeclaration.matchAll(/^  ([A-Za-z]\w*)\(/gm)]
  .map(([, methodName]) => methodName)
  .filter(methodName => methodName !== 'constructor');
const { Workbook } = await import('../src/core/Workbook.js');
const runtimeWorkbookMethods = new Set(Object.getOwnPropertyNames(Workbook.prototype));
const missingWorkbookMethods = declaredWorkbookMethods.filter(
  methodName => !runtimeWorkbookMethods.has(methodName)
);
assert.deepEqual(missingWorkbookMethods, [], 'Workbook declaration contains missing runtime methods');

console.log('[types] Runtime entrypoint exports match their contracts.');
