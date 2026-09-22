# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Package tarball shrank from 786 KB to 295 KB (unpacked 2.5 MB to 1.0 MB). The WASM binary drops its `name` debug section (252 KB to 197 KB, 100 KB to 84 KB gzipped), and the worker bundles no longer inline `xlsx-js-style` or a second base64 copy of the WASM engine. Exports and the wasm-bindgen glue are unchanged.
- Workers now resolve `vue`, `es-toolkit`, `xlsx-js-style` and `vue-canvas-sheet/wasm` through the consuming bundler, like the main entry points already did. If you serve `dist/` directly without a bundler, the formula and export workers fall back to the main thread because their bare imports are no longer inlined.
- `package.json` declares `repository` and `engines` (Node 22.12 or newer, matching CI). `Cargo.toml` declares `description`, `repository` and `license`, so wasm-pack no longer warns about missing metadata.
- README badges read the current version from npm instead of a hard-coded `0.1.0`.
- README documents the difference between `Cross-Origin-Embedder-Policy: require-corp` and `credentialless`, including the lack of Safari support for the latter.

### Internal

- Dev dependencies refreshed with `npm audit fix` and `npm update`. Critical and high advisories are cleared; the remaining moderate ones sit in the vitest 3 chain and need vitest 5.
- CI gains an oxlint job that fails on warnings, coverage thresholds rise to 75 / 75 / 72 / 75 (statements / branches / functions / lines), and Node setup is shared through a composite action.

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
