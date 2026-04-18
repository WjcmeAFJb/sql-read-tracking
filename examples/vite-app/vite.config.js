import { defineConfig } from "vite";

/**
 * No special config is needed: Vite's default asset pipeline picks up
 * the `new URL('./sqlite3-tracked.wasm', import.meta.url)` call inside
 * the emscripten-generated loader and emits the wasm with a hashed
 * filename for production builds.
 *
 * The one opt-out below keeps the dep optimizer from pre-bundling the
 * module (which would rewrite `import.meta.url` and break the sibling
 * wasm lookup). Harmless either way; belt-and-braces for dev mode.
 */
export default defineConfig({
  /* The emscripten loader and this demo both use top-level await, so
   * target a baseline that supports it. Anything from es2022 or later
   * works; "esnext" tracks whatever the current toolchain accepts. */
  build: { target: "esnext" },
  optimizeDeps: {
    exclude: ["sqlite3-read-tracking"],
  },
});
