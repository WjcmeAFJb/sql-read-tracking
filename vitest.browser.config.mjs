/**
 * vitest-browser-mode config. The same E2E suite that runs under Node
 * in vitest.config.mjs is re-targeted at a real Chromium via Playwright,
 * so the WASM import, wasm fetch/locateFile, Uint8Array blob round-trips,
 * and BigInt rowids are all exercised the way a browser bundler would
 * exercise them.
 *
 * Run with:   npm run test:browser
 * Requires:   @vitest/browser, playwright, and a Chromium binary
 *             (playwright puts one in ~/.cache/ms-playwright/chromium-*
 *             on its first install).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  /* The dist/ build output is outside the default Vite root; make sure
   * the browser dev server can serve it as a regular static file. */
  server: {
    fs: { allow: [".."] },
  },
  /* Static-serving the wasm from dist/. Tests load the .js via a normal
   * import, and emscripten's generated JS resolves the neighbouring
   * .wasm via `new URL('...', import.meta.url)`. When the .js is served
   * from /dist/ the .wasm fetch resolves to /dist/*.wasm automatically. */
  test: {
    include: ["tests/e2e/**/*.test.mjs"],
    testTimeout: 30000,
    browser: {
      enabled: true,
      provider: "playwright",
      name: "chromium",
      /* Tests should finish; no need for a visible Chromium window. */
      headless: true,
      /* Don't open the vitest UI; we're running one-shot in CI mode. */
      ui: false,
    },
  },
});
