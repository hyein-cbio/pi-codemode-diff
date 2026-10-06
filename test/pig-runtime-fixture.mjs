// Optional integration fixture: actual PiG Node runtime, SDK shims, and jiti
// loader. Host IPC is replaced with a local append recorder; no model/network.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [runtimeDir, entry, cwd] = process.argv.slice(2);
const moduleURL = (name) => pathToFileURL(join(runtimeDir, name)).href;
const { Runtime } = await import(moduleURL("runtime.mjs"));
const { runWithRuntime } = await import(moduleURL("state.mjs"));
const { importExtension } = await import(moduleURL("jiti-loader.mjs"));

const runtime = new Runtime(entry, undefined, undefined, { name: "diff-test" });
const appended = [];
runtime.fireAndForget = (method, args) => {
  assert.equal(method, "appendEntry");
  appended.push(args);
};
await runWithRuntime(runtime, async () => {
  const factory = await importExtension(entry);
  await factory(runtime.api);
  runtime.commitLoad();
  // Mark the stub host connection ready after factory registration.
  runtime.conn = {};
  runtime.hostReady = true;
  assert.equal(runtime.toolRendererResolvers.length, 0, "PiG native codemode presentation is not replaced");
  assert.ok(runtime.entryRenderers.has("pi-codemode-diff:pig"));

  const emit = async (event) => {
    let current = event;
    for (const item of runtime.handlers.get(event.type) ?? []) {
      const value = await item.handler(current, runtime.ctx);
      if (value) current = { ...current, ...value };
    }
    return current;
  };
  const start = (id, name, parentToolCallId) => emit({ type: "tool_execution_start", toolCallId: id, toolName: name, parentToolCallId });
  await start("root", "codemode");
  await start("root/1", "write", "root");
  const write = runtime.tools.get("write");
  const input = { path: "new.txt", content: "before\n" };
  const written = await write.execute("root/1", input, undefined, undefined, { cwd });
  assert.equal(await readFile(join(cwd, "new.txt"), "utf8"), input.content);
  await emit({ type: "tool_result", toolCallId: "root/1", toolName: "write", input, ...written, isError: false });
  await emit({ type: "tool_execution_end", toolCallId: "root/1", toolName: "write", result: written, isError: true });
  await start("root/2", "edit", "root");
  await emit({ type: "tool_result", toolCallId: "root/2", toolName: "edit", input: { path: "new.txt" }, content: [], details: { diff: "-1 before\n+1 after" }, isError: false });
  const content = [{ type: "text", text: "original codemode output" }];
  const result = await emit({ type: "tool_result", toolCallId: "root", toolName: "codemode", input: {}, content, details: { calls: ["native status"] }, isError: true });
  assert.strictEqual(result.content, content);
  assert.deepEqual(result.details.calls, ["native status"]);
  assert.equal(result.details.piCodemodeDiff.changes.length, 2);
  assert.equal(appended.length, 0, "Display is published only at completion");
  await emit({ type: "tool_execution_end", toolCallId: "root", toolName: "codemode", result, isError: true });
  await emit({ type: "agent_end" });
  assert.equal(appended.length, 1);
  const saved = JSON.parse(JSON.stringify(appended[0]));
  assert.equal(saved.data.piCodemodeDiff.changes[0].toolReportedError, true);
  const renderer = runtime.entryRenderers.get(saved.customType);
  const output = renderer({ data: saved.data }, { expanded: true }, runtime.ui.theme).render(80).join("\n");
  assert.match(output, /File changes/);
  assert.match(output, /before/);
  assert.match(output, /after/);
  assert.match(output, /error or cancellation/);
  assert.equal(JSON.stringify(content).includes("before"), false);
  // Reload: saved custom entries render without any in-memory capture.
  const resumed = new Runtime(entry, undefined, undefined, { name: "diff-test-resumed" });
  await runWithRuntime(resumed, async () => {
    await factory(resumed.api);
    const replay = resumed.entryRenderers.get(saved.customType)({ data: saved.data }, { expanded: true }, resumed.ui.theme).render(80).join("\n");
    assert.match(replay, /File changes/);
    assert.match(replay, /after/);
  });
});
console.log("PiG loader checks passed");
