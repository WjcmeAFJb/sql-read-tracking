# Using `sqlite3-read-tracking` with Vite

This package ships a single `.wasm` plus an ESM JS loader that Vite can
serve and Vite-bundled code can `import` directly. There is no runtime
config and no build-time plugin required -- the `.wasm` is fetched next
to the JS as a sibling URL (`new URL('./sqlite3-tracked.wasm',
import.meta.url)`), so Vite's default asset handling is enough.

The package is pure ESM (`"type": "module"`), so `import
initSqliteTracked from 'sqlite3-read-tracking'` gives you the factory
in both Vite and Node test runners.

---

## 1. Install locally from this checkout

Absolute local path on this machine:

```
/home/d/workspace/sql-read-tracking
```

Pick one of three ways to consume it:

### a) `file:` dependency (reproducible, recommended)

In the Vite app's `package.json`:

```jsonc
{
  "dependencies": {
    "sqlite3-read-tracking": "file:/home/d/workspace/sql-read-tracking"
  }
}
```

then

```bash
npm install
```

`npm` copies the package into the consumer's `node_modules`, so the
Vite app sees exactly what the published tarball would ship (see
`package.json`'s `"files"` field).

### b) `npm pack` → install the tarball

Reproduces the published artifact exactly -- closest to what a user on
npm would get:

```bash
cd /home/d/workspace/sql-read-tracking
npm run build                        # refresh dist/
npm pack                             # writes sqlite3-read-tracking-0.2.0.tgz

cd /path/to/your/vite-app
npm install /home/d/workspace/sql-read-tracking/sqlite3-read-tracking-0.2.0.tgz
```

### c) `npm link` (symlink, edits are live)

For iterating on the library in lock-step with the app:

```bash
cd /home/d/workspace/sql-read-tracking
npm link                             # register the package globally

cd /path/to/your/vite-app
npm link sqlite3-read-tracking       # symlink into node_modules
```

Changes under `/home/d/workspace/sql-read-tracking/dist/` appear in the
Vite app immediately. Run `npm run build` after source changes to
refresh `dist/`.

---

A fully working end-to-end example lives at
[`examples/vite-app/`](../examples/vite-app/) in this repository. It
links the package via `file:../..`, runs `vite build` clean, and serves
a tiny UI that lets you type SQL and inspect the resulting read /
write / query logs. Start from that if you want to copy-paste.

---

## 2. Minimal Vite app

```bash
npm create vite@latest my-app -- --template vanilla
cd my-app
npm install
npm install file:/home/d/workspace/sql-read-tracking
```

`vite.config.js` (esnext target so top-level `await` compiles):

```js
import { defineConfig } from "vite";
export default defineConfig({ build: { target: "esnext" } });
```

`src/main.js`:

```js
import initSqliteTracked from "sqlite3-read-tracking";

const SQL = await initSqliteTracked();
const db  = new SQL.Database();

db.exec(`
  CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, age INT);
  INSERT INTO users VALUES(1,'alice',30),(2,'bob',40);
`);

db.beginTracking();
db.exec("UPDATE users SET age=age+1 WHERE id=1");
db.endTracking();

document.querySelector("#app").innerHTML = `
  <h1>read log</h1>
  <pre>${JSON.stringify(db.getReadLog(), null, 2)}</pre>
  <h1>write log</h1>
  <pre>${JSON.stringify(db.getWriteLog(), null, 2)}</pre>
`;
```

```bash
npm run dev
```

Open the URL Vite prints. You should see the logs rendered as JSON --
the update's column mask includes `age`, and the read log shows the
SeekRowid probe plus the OP_Column reads the UPDATE did for rewrite
preservation.

---

## 3. Production build (`vite build`)

No special configuration needed. Vite will:

1. Detect `import initSqliteTracked from 'sqlite3-read-tracking'` and
   include `dist/sqlite3-tracked.mjs` in the bundle.
2. See the `new URL('./sqlite3-tracked.wasm', import.meta.url)`
   pattern inside that module and emit the `.wasm` as a static asset
   with a content-hashed filename.
3. Rewrite the URL in the emitted JS to point at the hashed asset.

If your app runs in a strict CSP context, make sure
`wasm-unsafe-eval` or equivalent is allowed -- emscripten's WebAssembly
instantiation needs it.

### Optional: pre-bundle tuning

If Vite's dep optimizer double-processes the module (rare; can show up
as "failed to fetch wasm" in dev), opt out:

```js
// vite.config.js
export default {
  optimizeDeps: { exclude: ["sqlite3-read-tracking"] },
};
```

This tells Vite to serve the module directly rather than running it
through esbuild first, which preserves the `import.meta.url`-relative
`.wasm` lookup.

### Workers

The loader works inside a Web Worker unchanged:

```js
// worker.js
import initSqliteTracked from "sqlite3-read-tracking";

const SQL = await initSqliteTracked();
const db  = new SQL.Database();
self.onmessage = (e) => {
  db.beginTracking();
  db.exec(e.data.sql);
  db.endTracking();
  self.postMessage({ reads: db.getReadLog(), writes: db.getWriteLog() });
};
```

```js
// main.js
const w = new Worker(new URL('./worker.js', import.meta.url),
                    { type: 'module' });
w.postMessage({ sql: "CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES(1);" });
w.onmessage = (e) => console.log(e.data);
```

---

## 4. Testing Vite-bundled code

`vitest` in its default (jsdom / happy-dom / node) environments works
the same way as Node -- just `import` the package and go.

For browser-parity test runs, use `@vitest/browser` + Playwright; see
the `vitest.browser.config.mjs` in this repository for a working
example. Short version:

```js
// vitest.config.js (or add a second config file)
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    browser: {
      enabled: true,
      name: "chromium",
      provider: "playwright",
      headless: true,
    },
  },
});
```

```bash
npm i -D @vitest/browser playwright
npx playwright install chromium   # first time only
npx vitest run
```

The tracking WASM runs natively inside Chromium; no jsdom polyfills
needed.

---

## 5. Troubleshooting

| Symptom                                              | Cause                                                                                   | Fix                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Failed to fetch .wasm` in dev                       | `optimizeDeps` rewrote `import.meta.url`                                                | `optimizeDeps: { exclude: ["sqlite3-read-tracking"] }`                                 |
| `TypeError: WebAssembly.instantiate ...` under CSP   | `wasm-unsafe-eval` not allowed                                                          | Add it to the CSP `script-src`                                                         |
| `BigInt is not a function`                           | Ancient target browser                                                                  | Set `build.target: "es2020"` or newer in `vite.config.js`                              |
| `Top-level await is not available in target`         | Default esbuild target (chrome87/es2020) lacks TLA                                      | `build: { target: "esnext" }` (or wrap the `await` in an `async` IIFE)                 |
| `[vite:resolve] Module "node:module" externalized`   | Emscripten loader contains a Node-only dynamic `import("node:module")` for SSR          | Harmless warning in the browser; suppress with `optimizeDeps.exclude`                  |
| `initSqliteTracked is not a function`                | Got the CJS export from an older release                                                | Confirm `package.json` points to `.mjs`; reinstall (`rm -rf node_modules && npm i`)    |
| Types missing in TS project                          | `moduleResolution` needs `"bundler"` or `"nodenext"` for `.d.mts`                       | Use one of those, or add `"types": ["sqlite3-read-tracking"]` to `tsconfig.json`       |
