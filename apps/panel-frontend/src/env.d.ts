/// <reference types="vite/client" />

// Build-time constants injected by vite.config.ts → define.
// Source of truth: apps/panel-frontend/package.json version field.
// Bump that on tag, rebuild, UI reflects automatically.
declare const __APP_VERSION__: string;
