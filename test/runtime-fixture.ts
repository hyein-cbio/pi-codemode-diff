import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

interface FixtureOptions {
  tools?: string[];
  extensionPath?: string;
  extraExtensions?: ExtensionFactory[];
  noTools?: "all" | "builtin";
}

/** Real Pi loader, hooks, codemode sandbox, and filesystem; no remote model calls. */
export async function runtimeFixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-codemode-diff-runtime-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  let session: AgentSession | undefined;
  t.after(async () => {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const faux = fauxProvider({ provider: "diff-test", tokensPerSecond: 0 });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [options.extensionPath ?? fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    extensionFactories: [createCodemodeExtension(), ...(options.extraExtensions ?? [])],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "The real Pi loader must load the source extension");
  const manager = SessionManager.create(cwd, join(root, "sessions"));

  async function open(sessionManager = manager) {
    const result = await createAgentSession({
      cwd, agentDir, modelRuntime, model: faux.getModel(), thinkingLevel: "off",
      settingsManager: settings, sessionManager, resourceLoader: loader,
      ...(options.noTools ? { noTools: options.noTools } : { tools: options.tools ?? ["read", "edit", "write", "codemode"] }),
    });
    session = result.session;
    await session.bindExtensions({});
    return session;
  }
  await open();

  async function run(calls: Array<{ id: string; name: string; arguments: Parameters<typeof fauxToolCall>[1] }>, inspect?: FauxResponseStep) {
    faux.setResponses([
      fauxAssistantMessage(calls.map(call => fauxToolCall(call.name, call.arguments, { id: call.id })), { stopReason: "toolUse" }),
      inspect ?? fauxAssistantMessage("Done."),
    ]);
    await session!.prompt("Execute the scripted test calls.");
    assert.equal(faux.getPendingResponseCount(), 0, "Both scripted model turns must be consumed");
    const failures = session!.messages.filter(message => message.role === "assistant" && message.stopReason === "error");
    assert.deepEqual(failures, [], "The local model must not fail before running the tools");
    return session!.messages.filter(message => message.role === "toolResult");
  }

  async function codemode(code: string, id = "root", inspect?: FauxResponseStep) {
    const results = await run([{ id, name: "codemode", arguments: { code } }], inspect);
    const result = [...results].reverse().find(message => message.toolCallId === id);
    assert.ok(result, "The real agent loop must produce the parent codemode result");
    return result;
  }

  async function resume() {
    const path = session!.sessionManager.getSessionFile();
    assert.ok(path, "A persistent session file must exist");
    session!.dispose();
    return open(SessionManager.open(path));
  }

  return { root, cwd, agentDir, loader, faux, run, codemode, resume, get session() { return session!; } };
}
