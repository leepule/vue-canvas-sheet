import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../../src/core/Workbook.js';
import { Events } from '../../src/core/events/EventEmitter.js';
import { ImportPlugin, applyMatrixInBatches } from '../../src/plugins/ImportPlugin.js';
import { createOrdersFixture } from '../fixtures/ai-orders.js';

const range = (sr = 1, sc = 0, er = 2, ec = 1) => ({
  s: { r: sr, c: sc },
  e: { r: er, c: ec }
});

function storedSheet() {
  return {
    config: {
      rowCount: 20, colCount: 10, colWidths: {}, rowHeights: {},
      merges: [], mergeMap: {}, defaultColWidth: 100, defaultRowHeight: 25,
      freeze: { r: 0, c: 0 }
    },
    data: { '0-0': { v: 10 }, '0-1': { f: '=A1*2', v: 20 } }
  };
}

describe('Workbook content revisions', () => {
  let workbook;
  let instances;
  let events;

  function createWorkbook() {
    const instance = new Workbook({ enableWasm: false, enablePersistence: false });
    instances.push(instance);
    return instance;
  }

  beforeEach(() => {
    instances = [];
    workbook = createWorkbook();
    workbook.setData(createOrdersFixture());
    events = [];
    workbook.on(Events.MUTATION_COMMITTED, event => events.push(event));
  });

  afterEach(() => {
    for (const instance of instances) instance.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function expectCommit(operation, expected = {}) {
    const previousRevision = workbook.getContentRevision();
    events.length = 0;
    const result = operation();
    expect(workbook.getContentRevision()).toBe(previousRevision + 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'mutation-committed',
      mutationId: `mutation-${previousRevision + 1}`,
      previousRevision,
      revision: previousRevision + 1,
      ...expected
    });
    return result;
  }

  it('starts at zero per instance and does not use the sheet dataVersion', () => {
    const other = createWorkbook();
    expect(other.getContentRevision()).toBe(0);
    expect(other.dataVersion).toBe(1);
    workbook.dataVersion = 999;
    expect(workbook.getContentRevision()).toBe(1);
    expect(other.getContentRevision()).toBe(0);
    expectCommit(() => workbook.setCell(1, 0, { v: 12 }), {
      source: 'edit', sheetId: 'sheet-1', sheetIds: ['sheet-1'], changedCells: 1
    });
  });

  it.each([
    ['value', () => workbook.setCell(1, 0, { v: 12 })],
    ['formula', () => workbook.setCell(1, 2, { v: '=A2*B2' })],
    ['explicit formula', () => workbook.setCell(1, 2, { f: '=A2*B2' })],
    ['delete', () => workbook.setCell(1, 0, null)],
    ['undefined delete', () => workbook.setCell(1, 0, undefined)],
    ['cell style', () => workbook.setCell(1, 0, { s: { fontWeight: 'bold' } })],
    ['cell display text', () => workbook.setCell(1, 0, { m: 'Ten' })]
  ])('commits a %s write once', (_name, operation) => {
    expectCommit(operation, { source: 'edit', changedCells: 1 });
  });

  it.each([
    { skipEvent: true },
    { skipHistory: true },
    { skipEvent: true, skipHistory: true }
  ])('tracks remote writes with options %j', options => {
    const cellChanged = vi.fn();
    workbook.on(Events.CELL_CHANGE, cellChanged);
    const historySize = workbook.history.undoStackSize;
    expectCommit(() => workbook.setCell(1, 0, { v: 50 }, null, options), { source: 'edit' });
    if (options.skipEvent) expect(cellChanged).not.toHaveBeenCalled();
    if (options.skipHistory) expect(workbook.history.undoStackSize).toBe(historySize);
  });

  it('commits bulk writes once and counts each touched coordinate once', () => {
    expectCommit(() => workbook.bulkSetCells([
      { r: 1, c: 2, val: { f: '=A2*B2' } },
      { r: 2, c: 2, val: { f: '=A3*B3' } },
      { r: 3, c: 2, val: { f: '=A4*B4' } },
      { r: 1, c: 2, val: { s: { fmt: 'currency' } } }
    ]), { source: 'edit', changedCells: 3 });
    expect(workbook.history.undoStackSize).toBe(1);
  });

  it.each([
    ['style', 'setStyle', { fontWeight: 'bold' }],
    ['border', 'setBorder', 'all', '#123456'],
    ['format', 'setFormat', 'percent'],
    ['decimals', 'setDecimals', 1]
  ])('commits range %s through both public facades', (_name, method, ...args) => {
    expectCommit(() => workbook[method](range(), ...args), { source: 'style', changedCells: 4 });
    expectCommit(() => workbook.styleManager[method](range(), ...args), { source: 'style', changedCells: 4 });
  });

  it('tracks in-place content clearing without removing styles', () => {
    workbook.setStyle(range(), { color: '#123456' });
    expectCommit(() => workbook.styleManager.clearContent(range()), { source: 'edit', changedCells: 4 });
    expect(workbook.getCell(1, 0).v).toBeUndefined();
    expect(workbook.getStyle(1, 0)).toEqual({ color: '#123456' });
    workbook.setCell(1, 0, { v: 10 });
    expectCommit(() => workbook.clearContent(range()), { changedCells: 1 });
  });

  it('commits clearing occupied cells once', () => {
    expectCommit(() => workbook.clearCells(range()), { changedCells: 4 });
    expect(workbook.getCell(1, 0)).toBeNull();
  });

  it.each(['workbook', 'clipboardManager', 'clipboard'])('tracks %s paste as one write', facade => {
    const clipboard = facade === 'workbook' ? workbook : workbook[facade];
    clipboard.copy(range());
    expectCommit(() => clipboard.paste(range(5, 0, 6, 1)), { source: 'edit', changedCells: 4 });
    expect(workbook.getCell(5, 0).v).toBe(10);
  });

  it('tracks search replacement and autofill', () => {
    workbook.setCell(4, 0, { v: 'needle' });
    workbook.setCell(5, 0, { v: 'needle' });
    expectCommit(() => workbook.replaceAll('needle', 'replaced'), { source: 'edit', changedCells: 2 });
    expectCommit(() => workbook.fillAuto(range(1, 0, 2, 0), range(1, 0, 4, 0)), {
      source: 'edit', changedCells: 2
    });
  });

  it.each(['workbook', 'mergeManager'])('tracks %s merges including nested cell deletion', facade => {
    const manager = facade === 'workbook' ? workbook : workbook.mergeManager;
    expectCommit(() => manager.mergeCells(range()), { source: 'structure' });
    expect(workbook.getCell(2, 1)).toBeNull();
    expectCommit(() => manager.unmergeCells(range()), { source: 'structure' });
    expectCommit(() => manager.addMerge(range(5, 0, 6, 1)), { source: 'structure' });
    expectCommit(() => manager.removeMerge(range(5, 0, 6, 1)), { source: 'structure' });
  });

  it.each(['insertRow', 'deleteRow', 'insertColumn', 'deleteColumn'])(
    'tracks %s and its direct manager path once',
    method => {
      expectCommit(() => workbook[method](1), { source: 'structure' });
      expectCommit(() => workbook.sheetStructure[method](1), { source: 'structure' });
    }
  );

  it.each([
    ['row height', () => workbook.setRowHeight(1, 40)],
    ['column width', () => workbook.setColWidth(1, 150)],
    ['freeze', () => workbook.setFreeze(1, 1)],
    ['move column', () => workbook.moveColumn(0, 1)],
    ['columns', () => workbook.setColumns([{ title: 'Price', field: 'price', width: 150 }])],
    ['clear columns', () => workbook.setColumns([])]
  ])('tracks %s once', (_name, operation) => {
    expectCommit(operation, { source: 'structure' });
  });

  it.each([
    ['rowCount', 2000], ['colCount', 500],
    ['rowHeights', { 1: 40 }], ['colWidths', { 1: 150 }],
    ['defaultRowHeight', 40], ['defaultColWidth', 150],
    ['freeze', { r: 1, c: 1 }], ['merges', [range()]],
    ['mergeMap', { '1-0': range() }], ['headerDepth', 2], ['fieldMap', { price: 0 }]
  ])('tracks the public %s property setter', (property, value) => {
    expectCommit(() => { workbook[property] = value; }, { source: 'structure' });
  });

  it.each([
    ['matrix', () => workbook.setData([[1, 2], [3, 4]])],
    ['objects', () => workbook.setData([{ price: 10, quantity: 2 }])],
    ['cell map', () => workbook.setData({ '1-0': { v: 99 } })],
    ['empty array', () => workbook.setData([])],
    ['data setter', () => { workbook.data = { '0-0': { v: 'replacement' } }; }]
  ])('tracks %s loading once', (_name, operation) => {
    expectCommit(operation, { source: 'import' });
  });

  it('tracks in-place loading with declared columns and retains history hooks after reload', () => {
    workbook.setColumns([{ title: 'Price', field: 'price' }]);
    workbook.setData([{ price: 10 }]);
    expectCommit(() => workbook.setData([{ price: 20 }]), { source: 'import' });
    workbook.setColumns([]);
    workbook.setData([[1]]);
    expectCommit(() => {
      workbook.history.startBatch();
      workbook.setCell(1, 0, { v: 2 });
      workbook.setCell(2, 0, { v: 3 });
      workbook.history.endBatch();
    });
    expectCommit(() => workbook.history.undo(), { source: 'undo' });
  });

  it('tracks JSON and plugin JSON imports without restoring a serialized revision', () => {
    const json = structuredClone(workbook.toJSON());
    json.contentRevision = 0;
    json.data['1-0'].v = 90;
    expectCommit(() => workbook.fromJSON(json), { source: 'import', changedCells: null });
    const plugin = new ImportPlugin();
    plugin.onMounted(workbook, null);
    expectCommit(() => plugin.importJSON(json), { source: 'import' });
    expect(workbook.toJSON()).not.toHaveProperty('contentRevision');
    expect(workbook.toJSON()).not.toHaveProperty('documentEpoch');
  });

  it('tracks sheet creation, rename and deletion, including inactive sheets', () => {
    const id = expectCommit(() => workbook.addSheet('Inactive', { activate: false }), {
      source: 'structure', sheetId: 'sheet-2'
    });
    expectCommit(() => workbook.renameSheet(id, 'Renamed'), { source: 'structure', sheetId: id });
    expectCommit(() => { workbook.sheetName = 'Orders'; }, { source: 'structure', sheetId: 'sheet-1' });
    expectCommit(() => workbook.deleteSheet(id), { source: 'structure', sheetId: id });
    const activeId = expectCommit(() => workbook.addSheet('Active'), { source: 'structure', sheetId: 'sheet-3' });
    expectCommit(() => workbook.deleteSheet(activeId), { source: 'structure', sheetId: activeId });
  });

  it('does not roll back revisions when switching to an older sheet state', () => {
    for (let i = 0; i < 5; i++) workbook.setCell(1, 0, { v: i });
    const mainId = workbook.activeSheetId;
    const secondId = workbook.addSheet('Second');
    workbook.setCell(0, 0, { v: 'second' });
    const revision = workbook.getContentRevision();
    const secondDataVersion = workbook.dataVersion;
    events.length = 0;
    const sheetChanged = vi.fn();
    workbook.on(Events.SHEET_CHANGE, sheetChanged);
    workbook.switchSheet(mainId);
    expect(workbook.dataVersion).not.toBe(secondDataVersion);
    expect(workbook.getContentRevision()).toBe(revision);
    workbook.switchSheet(secondId);
    expect(workbook.getContentRevision()).toBe(revision);
    expect(events).toHaveLength(0);
    expect(sheetChanged).toHaveBeenCalledTimes(2);
    expectCommit(() => workbook.setCell(0, 0, { v: 'changed' }), { sheetId: secondId });
  });

  it('tracks every comment entry and structural comment movement', () => {
    const comment = expectCommit(() => workbook.addComment(1, 0, 'Review'), { source: 'comment' });
    expectCommit(() => workbook.replyComment(comment.id, 'Reply'), { source: 'comment' });
    expectCommit(() => workbook.updateComment(comment.id, { resolved: true }), { source: 'comment' });
    expectCommit(() => workbook.upsertComment({ ...comment, id: 'remote-comment' }), { source: 'comment' });
    expectCommit(() => workbook.upsertComment({ ...comment, id: 'remote-comment', resolved: true }), { source: 'comment' });
    expectCommit(() => workbook.insertRow(0), { source: 'structure' });
    expect(workbook.getComment(comment.id).r).toBe(2);
    expectCommit(() => workbook.removeComment(comment.id), { source: 'comment' });
    expectCommit(() => workbook.removeComment('remote-comment', { remote: true }), { source: 'comment' });
  });

  it.each([
    ['value', () => workbook.setCell(1, 0, { v: 12 })],
    ['bulk', () => workbook.bulkSetCells([{ r: 1, c: 0, val: { v: 12 } }, { r: 2, c: 0, val: { v: 6 } }])],
    ['style', () => workbook.setStyle(range(), { color: '#123456' })],
    ['merge', () => workbook.mergeCells(range())],
    ['row insertion', () => workbook.insertRow(1)],
    ['row deletion', () => workbook.deleteRow(1)],
    ['column insertion', () => workbook.insertColumn(1)],
    ['column deletion', () => workbook.deleteColumn(1)],
    ['column movement', () => workbook.moveColumn(0, 1)],
    ['row height', () => workbook.setRowHeight(1, 40)],
    ['column width', () => workbook.setColWidth(1, 150)]
  ])('commits %s undo and redo exactly once', (_name, operation) => {
    operation();
    expectCommit(() => workbook.undo(), { source: 'undo' });
    expectCommit(() => workbook.redo(), { source: 'redo' });
    expectCommit(() => workbook.history.undo(), { source: 'undo' });
    expectCommit(() => workbook.history.redo(), { source: 'redo' });
  });

  it('tracks direct command application and does not count history-only bookkeeping', () => {
    const command = { type: 'set-cell', r: 5, c: 0, oldValue: null, newValue: { v: 1 } };
    const revision = workbook.getContentRevision();
    workbook.history.execute(command);
    expect(workbook.getContentRevision()).toBe(revision);
    expectCommit(() => workbook.applyCommand(command, false), { source: 'redo' });
    expectCommit(() => workbook.applyCommand(command, true), { source: 'undo' });
    events.length = 0;
    workbook.history.clear();
    workbook.undo();
    workbook.redo();
    expect(events).toHaveLength(0);
  });

  it('increments for each edit even when history merges them into one entry', () => {
    expectCommit(() => workbook.setCell(1, 0, { v: 11 }));
    expectCommit(() => workbook.setCell(1, 0, { v: 12 }));
    expect(workbook.history.undoStackSize).toBe(1);
  });

  it('waits for the outer history batch, including nested merge batches', () => {
    const revision = workbook.getContentRevision();
    workbook.history.startBatch();
    workbook.setCell(1, 0, { v: 12 });
    workbook.history.startBatch();
    workbook.setStyle(range(), { color: '#123456' });
    workbook.mergeCells(range(5, 0, 6, 1));
    workbook.history.endBatch();
    expect(workbook.getContentRevision()).toBe(revision);
    expect(events).toHaveLength(0);
    expectCommit(() => workbook.history.endBatch(), { source: 'edit' });
    expect(workbook.history.undoStackSize).toBe(1);
    expectCommit(() => workbook.undo(), { source: 'undo' });
    expectCommit(() => workbook.redo(), { source: 'redo' });
  });

  it.each(['workbook', 'storeManager'])('commits nested %s batches once, after all stores apply', facade => {
    const batch = facade === 'workbook'
      ? { begin: () => workbook.beginBatchUpdate(), end: () => workbook.endBatchUpdate() }
      : { begin: () => workbook.getStoreManager().beginBatch(), end: () => workbook.getStoreManager().endBatch() };
    const revision = workbook.getContentRevision();
    batch.begin();
    batch.begin();
    workbook.setCell(1, 0, { v: 12 });
    workbook.setRowHeight(1, 50);
    workbook.setFreeze(1, 1);
    batch.end();
    expect(workbook.getContentRevision()).toBe(revision);
    expect(events).toHaveLength(0);
    expectCommit(() => batch.end());
    expect(workbook.rowHeights[1]).toBe(50);
    expect(workbook.freeze).toEqual({ r: 1, c: 1 });
  });

  it('tracks direct persistent Store edits, ignoring direct view state edits', () => {
    expectCommit(() => workbook.getStore('data').setState({ rowCount: 2000, colWidths: { 1: 200 } }), {
      source: 'structure'
    });
    expectCommit(() => workbook.getStore('ui').setState({ freeze: { r: 1, c: 1 } }), {
      source: 'structure'
    });
    events.length = 0;
    workbook.getStore('ui').setState({ scrollTop: 100, scrollLeft: 50 });
    workbook.getStore('selection').setState({ activeCell: { r: 4, c: 4 } });
    expect(events).toHaveLength(0);
  });

  it('reports all affected sheets in a cross-sheet batch', () => {
    const secondId = workbook.addSheet('Second', { activate: false });
    const firstId = workbook.activeSheetId;
    expectCommit(() => {
      workbook.history.startBatch();
      workbook.setCell(1, 0, { v: 12 });
      workbook.switchSheet(secondId);
      workbook.setCell(0, 0, { v: 99 });
      workbook.history.endBatch();
    }, { sheetId: null, sheetIds: [firstId, secondId], changedCells: 2 });
  });

  it('keeps an outer batch balanced when setData resets history', () => {
    const history = workbook.history;
    const revision = workbook.getContentRevision();
    history.startBatch();
    workbook.setCell(1, 0, { v: 'old document' });
    workbook.setData([[1]]);
    workbook.setCell(1, 0, { v: 'new document' });
    expect(workbook.history).toBe(history);
    expect(workbook.getContentRevision()).toBe(revision);
    expectCommit(() => history.endBatch());
    expect(history.undoStackSize).toBe(1);
    expectCommit(() => workbook.undo(), { source: 'undo' });
    expect(workbook.getCell(1, 0)).toBeNull();
  });

  it('does not flush another kind of batch when an unmatched end is called', () => {
    workbook.history.startBatch();
    workbook.setCell(1, 0, { v: 12 });
    const revision = workbook.getContentRevision();
    workbook.endBatchUpdate();
    expect(workbook.getContentRevision()).toBe(revision);
    expectCommit(() => workbook.history.endBatch());
  });

  it.each([
    ['set', matrix => matrix.set(1, 0, { v: 12 })],
    ['delete', matrix => matrix.delete(1, 0)],
    ['row deletion', matrix => matrix.deleteRow(1)],
    ['column deletion', matrix => matrix.deleteCol(0)],
    ['row range deletion', matrix => matrix.deleteRowRange(1, 3)],
    ['column range deletion', matrix => matrix.deleteColRange(0, 1)],
    ['clear', matrix => matrix.clear()],
    ['setCells', matrix => matrix.setCells([{ r: 1, c: 0, cell: { v: 12 } }, { r: 2, c: 0, cell: { v: 6 } }])],
    ['fromObject', matrix => matrix.fromObject({ '0-0': { v: 1 }, '0-1': { v: 2 } }, key => workbook.parseKey(key))],
    ['fromJSON', matrix => matrix.fromJSON({ cells: [{ r: 0, c: 0, v: 1 }, { r: 0, c: 1, v: 2 }] })]
  ])('tracks the exposed matrix %s API as one mutation', (_name, operation) => {
    expectCommit(() => operation(workbook.getDataMatrix()));
  });

  it('does not count selection, scrolling, copy, cache versions or rendering as edits', () => {
    const revision = workbook.getContentRevision();
    workbook.setSelection(1, 0, 2, 1);
    workbook.selectionManager.setSelection(range(2, 0, 3, 1));
    workbook.activeCell = { r: 3, c: 1 };
    workbook.setCopyRange(range());
    workbook.clearCopyRange();
    workbook.copy(range());
    workbook.getStore('ui').setState({ scrollTop: 50, scrollLeft: 100 });
    workbook.dataVersion++;
    workbook.notify();
    workbook.markLayoutDirty();
    workbook.requestRender();
    workbook.readOnly = true;
    workbook.emitEvent(Events.SAVE_STATUS, { status: 'saved' });
    expect(workbook.getContentRevision()).toBe(revision);
    expect(events).toHaveLength(0);
  });

  it('does not count formula recalculation, cached values or shared-store updates', () => {
    workbook.bulkSetCells([
      { r: 1, c: 2, val: { f: '=A2*B2' } },
      { r: 2, c: 2, val: { f: '=A3*B3' } },
      { r: 3, c: 2, val: { f: '=A4*B4' } }
    ]);
    const revision = workbook.getContentRevision();
    events.length = 0;
    workbook.recalcAll({ useWorker: false });
    expect([1, 2, 3].map(r => workbook.getCellValue(r, 2))).toEqual([20, 15, 32]);
    workbook.formulaEvaluator.recalcDirty();
    workbook.rebuildDependencyMap();
    workbook.recalcAll({ useWorker: false });
    workbook.getCell(1, 2).m = '20.00';
    workbook._syncSharedValue(1, 2, 20);
    workbook.formulaEngine._applyWorkerResults({ '1-2': 20, '2-2': 15, '3-2': 32 });
    expect(workbook.getContentRevision()).toBe(revision);
    expect(events).toHaveLength(0);
  });

  it('ignores empty operations and rejected sheet or comment changes', () => {
    const revision = workbook.getContentRevision();
    workbook.bulkSetCells([]);
    workbook.clearCells(range(30, 0, 31, 1));
    workbook.clearContent(range(30, 0, 31, 1));
    workbook.unmergeCells(range());
    workbook.moveColumn(1, 1);
    workbook.renameSheet(workbook.sheetName);
    workbook.renameSheet('missing', 'New');
    workbook.switchSheet('missing');
    workbook.deleteSheet('missing');
    workbook.addComment(-1, 0, 'Invalid');
    workbook.replyComment('missing', 'Invalid');
    workbook.updateComment('missing', {});
    workbook.upsertComment({ r: 1, c: 0, messages: [] });
    workbook.removeComment('missing');
    workbook.beginBatchUpdate();
    workbook.endBatchUpdate();
    workbook.history.startBatch();
    workbook.history.endBatch();
    expect(() => workbook.renameSheet(' ')).toThrow();
    expect(() => workbook.deleteSheet(workbook.activeSheetId)).toThrow();
    expect(workbook.getContentRevision()).toBe(revision);
    expect(events).toHaveLength(0);
  });

  it('does not commit a rejected or rolled-back JSON import', () => {
    const original = structuredClone(workbook.toJSON());
    const revision = workbook.getContentRevision();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => workbook.fromJSON({ data: { A1: { v: 1 } } })).toThrow();
    expect(workbook.getContentRevision()).toBe(revision);

    vi.spyOn(workbook, 'rebuildDependencyMap').mockImplementationOnce(() => {
      throw new Error('injected restore failure');
    });
    expect(() => workbook.fromJSON({ rowCount: 20, colCount: 10, data: { '0-0': { v: 99 } } })).toThrow();
    expect(workbook.toJSON()).toEqual(original);
    expect(workbook.getContentRevision()).toBe(revision);
    expect(events).toHaveLength(0);
    expect(log).toHaveBeenCalled();
    expectCommit(() => workbook.setCell(1, 0, { v: 12 }));
  });

  it('still invalidates after a legacy non-atomic write throws halfway through', () => {
    const revision = workbook.getContentRevision();
    expect(() => workbook.bulkSetCells([
      { r: 5, c: 0, val: { v: 'written' } },
      { r: 5, c: 1, val: null }
    ])).toThrow();
    expect(workbook.getCell(5, 0).v).toBe('written');
    expect(workbook.getContentRevision()).toBe(revision + 1);
    expect(events).toHaveLength(1);
    expectCommit(() => workbook.setCell(1, 0, { v: 12 }));
  });

  it('emits after cells and history are ready and isolates failing observers', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    workbook.on(Events.MUTATION_COMMITTED, () => { throw new Error('observer failure'); });
    const observed = [];
    const observer = vi.fn(() => observed.push({
      value: workbook.getCell(1, 0).v,
      canUndo: workbook.history.canUndo()
    }));
    workbook.on(Events.MUTATION_COMMITTED, observer);
    expectCommit(() => workbook.setCell(1, 0, { v: 12 }));
    expect(observer).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([{ value: 12, canUndo: true }]);
    expect(error).toHaveBeenCalled();
  });

  it('delivers reentrant writes in revision order to every observer', () => {
    const revision = workbook.getContentRevision();
    const seen = [];
    workbook.on(Events.MUTATION_COMMITTED, event => {
      if (event.revision === revision + 1) workbook.setCell(2, 0, { v: 99 });
    });
    workbook.on(Events.MUTATION_COMMITTED, event => seen.push(event.revision));
    workbook.setCell(1, 0, { v: 12 });
    expect(seen).toEqual([revision + 1, revision + 2]);
    expect(workbook.getContentRevision()).toBe(revision + 2);
  });

  it.each(['workbook', 'persistence'])('tracks %s legacy storage restore once', async facade => {
    workbook._storage = { close: vi.fn(), exportSheet: vi.fn().mockResolvedValue(storedSheet()) };
    const revision = workbook.getContentRevision();
    await (facade === 'workbook' ? workbook : workbook.persistence).loadFromStorage('stored');
    expect(workbook.getContentRevision()).toBe(revision + 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'import', changedCells: null });
  });

  it('tracks full-workbook storage restore once, without restoring old revision values', async () => {
    const json = structuredClone(workbook.toJSON());
    workbook.setCell(1, 0, { v: 12 });
    const revision = workbook.getContentRevision();
    events.length = 0;
    workbook._storage = { close: vi.fn(), getMetadata: vi.fn().mockResolvedValue(json) };
    await workbook.loadFromStorage('stored');
    expect(workbook.getCell(1, 0).v).toBe(10);
    expect(workbook.getContentRevision()).toBe(revision + 1);
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('import');
  });

  it('does not hide edits while asynchronous storage reads are pending', async () => {
    let resolveRead;
    workbook._storage = {
      close: vi.fn(),
      exportSheet: vi.fn(() => new Promise(resolve => { resolveRead = resolve; }))
    };
    workbook.enablePersistenceStorage({ sheetId: 'stored' });
    const loading = workbook.loadFromStorage('stored');
    expectCommit(() => workbook.setCell(1, 0, { v: 12 }), { source: 'edit' });
    const revision = workbook.getContentRevision();
    events.length = 0;
    resolveRead(storedSheet());
    await loading;
    expect(workbook.getContentRevision()).toBe(revision + 1);
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('import');
  });

  it('does not commit missing or failed storage reads', async () => {
    const revision = workbook.getContentRevision();
    workbook._storage = { close: vi.fn(), exportSheet: vi.fn().mockResolvedValue(null) };
    await expect(workbook.loadFromStorage()).resolves.toBe(false);
    workbook._storage.exportSheet.mockRejectedValue(new Error('storage unavailable'));
    await expect(workbook.loadFromStorage()).rejects.toThrow('storage unavailable');
    expect(workbook.getContentRevision()).toBe(revision);
    expect(events).toHaveLength(0);
  });

  it('increments after each visible import chunk and does not defer interleaved edits', async () => {
    const progress = [];
    await applyMatrixInBatches(workbook, [[1, 2], [3, 4]], {
      batchSize: 2,
      onProgress: ({ done }) => {
        const revision = workbook.getContentRevision();
        progress.push({ done, revision });
        if (done === 2) {
          workbook.setCell(10, 5, { v: 'interleaved' });
          expect(workbook.getContentRevision()).toBe(revision + 1);
        }
      }
    });
    expect(progress).toHaveLength(2);
    expect(progress[1].revision).toBe(progress[0].revision + 2);
    expectCommit(() => workbook.setCell(1, 0, { v: 12 }));
  });

  it('does not publish disposal or another instance as a content change', () => {
    const other = createWorkbook();
    other.setCell(0, 0, { v: 1 });
    expect(events).toHaveLength(0);
    const revision = workbook.getContentRevision();
    workbook.destroy();
    expect(workbook.getContentRevision()).toBe(revision);
    expect(events).toHaveLength(0);
  });
});
