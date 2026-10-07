import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { EntryRenderer, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Capture } from "../src/capture.ts";
import { DETAILS_KEY, readChanges, type Change } from "../src/changes.ts";
import { isPiGHost } from "../src/host.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { PIG_ENTRY_TYPE, registerPiGDisplay } from "../src/pig.ts";

const theme = {
  fg: (_token: string, value: string) => value,
  bold: (value: string) => value,
  inverse: (value: string) => `\u001b[7m${value}\u001b[27m`,
} as unknown as Theme;
const change: Change = {
  toolCallId: "a/1", tool: "write", kind: "create", path: "new.ts",
  diff: Array.from({ length: 30 }, (_, i) => `+${i + 1} line-${i + 1}`).join("\n"),
};

function harness() {
  const capture = new Capture();
  const entries: Array<{ customType: string; data: unknown }> = [];
  let renderer: EntryRenderer | undefined;
  const publish = registerPiGDisplay({
    registerEntryRenderer(type: string, render: EntryRenderer) {
      assert.equal(type, PIG_ENTRY_TYPE);
      renderer = render;
    },
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
  } as unknown as ExtensionAPI, capture);
  const render = (data: unknown, expanded = false) => renderer!({
    type: "custom", id: "entry", parentId: null, timestamp: "now", customType: PIG_ENTRY_TYPE, data,
  }, { expanded }, theme);
  return { capture, entries, publish, render };
}

test("Pi loads and runs without the PiG-only display module even being present", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codemode-diff-no-pig-module-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  for (const name of await readdir(source)) {
    if (name.endsWith(".ts") && name !== "pig.ts") {
      await writeFile(join(root, name), await readFile(join(source, name)));
    }
  }
  // Local extensions must install their own non-host dependencies.
  await mkdir(join(root, "node_modules"));
  await cp(fileURLToPath(new URL("../node_modules/diff", import.meta.url)), join(root, "node_modules/diff"), { recursive: true });
  const fixture = await runtimeFixture(t, { extensionPath: join(root, "index.ts") });
  const result = await fixture.codemode('await tools.write({path: "pi-only.txt", content: "unchanged Pi path"});');
  assert.equal(result.isError, false);
  assert.equal(readChanges(result.details)?.length, 1);
  assert.equal(fixture.session.sessionManager.getEntries().some(entry =>
    entry.type === "custom" && entry.customType === PIG_ENTRY_TYPE), false);
});

test("PiG identification requires the loaded SDK runtime's exact API identity", () => {
  const pi = {} as ExtensionAPI;
  assert.equal(isPiGHost(pi), false, "The real Pi SDK must never enable the fallback");
  assert.equal(isPiGHost(pi, {}), false);
  assert.equal(isPiGHost(pi, { __runtime: true }), false);
  assert.equal(isPiGHost(pi, { __runtime: () => null }), false);
  assert.equal(isPiGHost(pi, { __runtime: () => ({ api: {} }) }), false);
  assert.equal(isPiGHost(pi, { __runtime: () => { throw new Error("uninitialized"); } }), false);
  assert.equal(isPiGHost(pi, { __runtime: () => ({ api: pi }) }), true);
});

test("PiG publishes isolated final entries, including observed writes with final errors", () => {
  const host = harness();
  host.capture.start("a", "codemode");
  host.capture.start("a/1", "write", "a");
  host.capture.start("b", "codemode");
  host.capture.start("b/1", "edit", "b");
  host.capture.add(change);
  host.capture.add({ ...change, toolCallId: "b/1", tool: "edit", kind: "edit", path: "other.ts" });
  host.capture.reportError("a/1");
  host.publish("a/1");
  host.publish("empty");
  assert.equal(host.entries.length, 0, "No direct or nested entry, or empty entry");
  host.publish("b");
  host.capture.end("b");
  host.publish("a");
  host.capture.end("a");
  host.publish("a");
  assert.equal(host.entries.length, 2);
  const saved = JSON.parse(JSON.stringify(host.entries));
  host.capture.clear();
  const b = host.render(saved[0].data, true)!.render(80).join("\n");
  const a = host.render(saved[1].data, true)!.render(80).join("\n");
  assert.match(b, /codemode b/);
  assert.match(b, /other.ts/);
  assert.doesNotMatch(b, /new.ts/);
  assert.match(a, /File changes \(1\)/);
  assert.match(a, /error or cancellation/);
  assert.doesNotMatch(a, /other.ts/);
});

test("PiG persisted entries share safe previews, expansion, and width handling", () => {
  const host = harness();
  const data = { toolCallId: "a\n\u001b[2J", [DETAILS_KEY]: { version: 1, changes: [change] } };
  const collapsed = host.render(data)!.render(80).join("\n");
  assert.match(collapsed, /more lines/);
  assert.doesNotMatch(collapsed, /line-30/);
  assert.doesNotMatch(collapsed, /\u001b/);
  assert.match(collapsed, /a\\n/);
  assert.match(host.render(data, true)!.render(80).join("\n"), /line-30/);
  assert.ok(host.render(data)!.render(16).every(line => visibleWidth(line) <= 16));
  for (const invalid of [null, {}, { toolCallId: 42 }, { ...data, [DETAILS_KEY]: { version: 2, changes: [change] } }, { ...data, [DETAILS_KEY]: { version: 1, changes: [] } }]) {
    assert.equal(host.render(invalid), undefined);
  }
});

test("PiG persisted replacements highlight changed words in both display modes", () => {
  const host = harness();
  const data = { toolCallId: "a", [DETAILS_KEY]: { version: 1, changes: [{
    ...change, kind: "overwrite", diff: "-1 const timeout = 1000;\n+1 const timeout = 5000;",
  }] } };
  for (const expanded of [false, true]) {
    const output = host.render(JSON.parse(JSON.stringify(data)), expanded)!.render(80).join("\n");
    assert.ok(output.includes(theme.inverse("1000")));
    assert.ok(output.includes(theme.inverse("5000")));
  }
});

test("PiG's actual Node loader selects the entry display instead of the D89 resolver", {
  skip: !process.env.PIG_NODE_RUNTIME_DIR && "Set PIG_NODE_RUNTIME_DIR to PiG's runtime-node directory",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-codemode-diff-pig-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("./pig-runtime-fixture.mjs", import.meta.url));
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const result = spawnSync(process.execPath, [fixture, process.env.PIG_NODE_RUNTIME_DIR!, entry, root], {
    env: { ...process.env, PIG_HOME: root, JITI_FS_CACHE: "false" }, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PiG loader checks passed/);
});
