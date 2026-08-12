/// <reference types="vite/client" />
// An import can't do this instead: src/preload/index.d.ts's global Window
// augmentation needs to reach the renderer's own compilation
// (tsconfig.app.json), which doesn't otherwise include anything under
// src/preload (that's tsconfig.node.json's job) — a triple-slash reference
// is the only way to pull it in without turning this into a module itself.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./src/preload/index.d.ts" />
