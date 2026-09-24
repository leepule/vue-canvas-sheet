# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Formula and export workers no longer fall back to the main thread in bundled apps. Bundlers copy the worker files verbatim, so the relative and bare imports inside them could not resolve: the formula worker failed to load its WASM engine and xlsx export ran on the main thread.
- With cross-origin isolation, formula cells recalculated in the worker kept an empty value because numeric results were written only to shared memory and never read back. This was hidden until now because the worker always fell back.

### Changed

- Package tarball shrank from 786 KB to 446 KB (unpacked 2.5 MB to 1.44 MB). The WASM binary drops its `name` debug section (252 KB to 197 KB, 100 KB to 84 KB gzipped), and no worker bundle carries a base64 copy of the WASM engine any more. Exports and the wasm-bindgen glue are unchanged.
- Every worker bundle in `dist/assets` is now a single self-contained, minified file. The formula worker inlines the WASM bridge and wasm-bindgen glue and receives the `.wasm` URL from the main thread. The export worker inlines `xlsx-js-style` without its legacy codepage tables; at 148 KB gzipped it is only downloaded when exporting.
- New `vue-canvas-sheet/wasm/url` sub-path export: the absolute URL of the WASM binary, resolved by your bundler. The formula worker uses it to load the engine.
- `WorkerManager.getStats()` reports `workerWasmLoaded`.
- Removed two console messages that fired during normal use: a `[DEBUG]` log for every formula cell with a circular reference (the cell already shows `#CYCLE!`), and a `[ProgressiveRender]` warning for every frame over 12 ms. Logs behind the `debug` option are unchanged.
- `package.json` declares `repository` and `engines` (Node 22.12 or newer, matching CI). `Cargo.toml` declares `description`, `repository` and `license`, so wasm-pack no longer warns about missing metadata.
- README badges read the current version from npm instead of a hard-coded `0.1.0`.
- README documents the difference between `Cross-Origin-Embedder-Policy: require-corp` and `credentialless`, including the lack of Safari support for the latter.

### Internal

- Dev dependencies refreshed with `npm audit fix` and `npm update`. Critical and high advisories are cleared; the remaining moderate ones sit in the vitest 3 chain and need vitest 5.
- CI gains an oxlint job that fails on warnings, coverage thresholds rise to 75 / 75 / 72 / 75 (statements / branches / functions / lines), and Node setup is shared through a composite action.
- `npm test` no longer runs the `tests/performance` suite. It only runs through `npm run test:perf`, which executes the files serially so the timing budgets are not skewed by parallel load.
- Removed the unused `MemoryManager` and `StyleUtils` modules together with the `StyleUtils` test case. Neither was reachable from any entry point, so the published bundles are unchanged.
- `samples/basic-usage/dist` is no longer tracked in git and `.gitignore` covers `samples/**/dist`. The demo deploy workflow already rebuilds it on every run.
- Unit tests default to the `node` environment. The 10 files that need a DOM opt in with `// @vitest-environment jsdom`, which brings a local `npm test` run from about 10.5 s to about 6.3 s.
- CI's package job runs `scripts/consumer-smoke.mjs`: it installs the tarball in an empty Vue app, builds it, and loads it in headless Chromium to assert that the formula worker loads WASM and xlsx export runs in a worker. `check:publish` rejects worker bundles that contain imports or an inlined WASM binary.
- CI caches the Rust build (`build` and `cargo` jobs) and the Playwright browsers (`e2e` job). The `unit` job no longer waits for `build`: it tests against the committed `src/wasm/pkg`, and the real-WASM integration test now runs inside `build` right after the fresh build.

## [1.0.0] - 2026-09-16

First public release. A `0.1.0` was published on 2026-09-14 and later withdrawn from the registry; `1.0.0` is the first supported version.

### Added

- `TableDesigner` Vue 3 component rendered entirely on Canvas 2D: frozen panes, merged cells, conditional formatting, formula bar, undo/redo, find and replace, context menus, cell comments.
- Headless `Workbook` core (`vue-canvas-sheet/core`) that runs in Node.js and Web Workers, plus `render`, `icons`, `plugins` and `wasm` sub-path exports with TypeScript declarations for each.
- Shared JS RPN formula engine with 100+ functions. Verified numeric arithmetic is optionally accelerated by a Rust + WASM engine that is lazy-loaded on first use and ships pre-built in the package.
- Worker-based recalculation with zero-copy `SharedArrayBuffer` transfer when the page is cross-origin isolated, and automatic main-thread fallback otherwise (`wb.getSystemReport()` reports the active mode).
- IndexedDB persistence (`enable-persistence`) with diff-based incremental saves, and paged lazy loading (`lazy-load`) for large sheets.
- Plugins: `SelectionHistoryPlugin`, `AutoSavePlugin`, `ExportPlugin` (`.xlsx` in a worker, `.csv`, `.json`), `ImportPlugin` (`.xlsx`, `.xls`, `.csv`, `.tsv`, `.json`), `CollaborativeCursorPlugin` and `RealtimeCollaborationPlugin` (WebSocket sync of edits, selections and per-cell locks, with authentication and read-only members). A reference server is available via `npm run collab:server`.
- Server-side rendering safety and device-pixel-ratio change handling for the Canvas table.

### Security

- CSV export prefixes formula-like text with a single quote by default. Pass `exportCSV({ allowFormulas: true })` only for trusted data.

[Unreleased]: https://github.com/leepule/vue-canvas-sheet/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/leepule/vue-canvas-sheet/releases/tag/v1.0.0
