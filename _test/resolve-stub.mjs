/**
 * 测试期模块重定向（Node ≥ 22.15 的同步 registerHooks）：
 * 把 `@deepseek-ai/dsh-llm` 指到 `_test/stubs/dsh-llm/index.mjs`。
 * 用法：`node --test --import ./_test/resolve-stub.mjs`（`npm test` 已带此参数）。
 * ⚠ 只影响测试进程；插件在宿主里加载时用的仍是真实的 DSH 包。
 */
import { registerHooks } from "node:module";
//（不再需要 pathToFileURL）

const STUB = new URL("./stubs/dsh-llm/index.mjs", import.meta.url);
const STUB_URL = STUB.href;   // ⚠ 不要用 pathToFileURL(STUB.pathname)：Windows 上会被转义坏（ENOENT）

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@deepseek-ai/dsh-llm") return { url: STUB_URL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

