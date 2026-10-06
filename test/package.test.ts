import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readChanges } from "../src/changes.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

const exec = promisify(execFile);

test("the packed npm artifact contains only distributable files and loads through real Pi", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") {
    t.skip("This packaging smoke test uses the POSIX tar executable");
    return;
  }
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "pi-codemode-diff-pack-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const args = ["pack", "--json", "--ignore-scripts", "--pack-destination", directory];
  const npmCli = process.env.npm_execpath;
  const { stdout } = npmCli
    ? await exec(process.execPath, [npmCli, ...args], { cwd: repo })
    : await exec("npm", args, { cwd: repo });
  const [artifact] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const files = artifact.files.map(file => file.path);
  for (const required of [
    "package.json", "README.md", "LICENSE",
    "src/index.ts", "src/capture.ts", "src/changes.ts", "src/write.ts", "src/render.ts",
    "src/host.ts", "src/pig.ts",
  ]) {
    assert.ok(files.includes(required), `${required} must be distributed`);
  }
  assert.ok(files.every(path => !/^(node_modules|test|coverage)\//.test(path) && !path.includes(".DS_Store")));
  await exec("tar", ["-xzf", join(directory, artifact.filename), "-C", directory]);
  const personalHome = /\/(?:Users|home)\/[^/\s]+\/|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+[\\/]+/i;
  for (const path of files) {
    const content = await readFile(join(directory, "package", path), "utf8");
    assert.doesNotMatch(content, personalHome, `${path} must not contain a machine-specific home directory`);
  }
  const fixture = await runtimeFixture(t, { extensionPath: join(directory, "package/src/index.ts") });
  const result = await fixture.codemode('await tools.write({path: "packed.txt", content: "from the packed artifact"});');
  assert.equal(result.isError, false);
  assert.equal(readChanges(result.details)?.[0].path, "packed.txt");
  assert.equal(await readFile(join(fixture.cwd, "packed.txt"), "utf8"), "from the packed artifact");
});
