import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Capture } from "./capture.ts";
import { writeChange, type BeforeWrite } from "./changes.ts";

async function snapshot(path: string): Promise<BeforeWrite> {
  try {
    const bytes = await readFile(path);
    if (bytes.includes(0)) {
      return { kind: "unavailable", reason: "Previous content is binary; text diff unavailable." };
    }
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      return { kind: "unavailable", reason: "Previous content is not UTF-8; text diff unavailable." };
    }
    return { kind: "text", content };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "unavailable", reason: "Previous content could not be read; text diff unavailable." };
  }
}

export function registerWriteCapture(pi: ExtensionAPI, capture: Capture): void {
  const builtin = createWriteToolDefinition(process.cwd());
  pi.registerTool({
    ...builtin,
    // Preserve the host's tool selection, including read-only/--no-tools sessions.
    defaultActive: false,
    async execute(id, input, signal, onUpdate, ctx) {
      if (!capture.isNested(id)) {
        return builtin.execute(id, input, signal, onUpdate, ctx);
      }

      const instrumented = createWriteToolDefinition(ctx.cwd, {
        operations: {
          mkdir: async (dir) => { await mkdir(dir, { recursive: true }); },
          // The built-in tool invokes this INSIDE withFileMutationQueue().
          // Do not wrap execute() in a second queue: that would deadlock.
          writeFile: async (absolutePath, content) => {
            const before = await snapshot(absolutePath);
            if (signal?.aborted) throw new Error("Operation aborted");
            await writeFile(absolutePath, content, "utf8");
            // File writing has succeeded. Diff computation must not alter its outcome.
            try {
              capture.add(writeChange(id, input.path, before, content));
            } catch {
              capture.add({
                toolCallId: id,
                tool: "write",
                path: input.path,
                kind: before.kind === "missing" ? "create" : before.kind === "text" ? "overwrite" : "unknown",
                note: "Write completed, but its diff could not be generated.",
              });
            }
          },
        },
      });
      // Same schema, success text, cancellation checks and renderer as built-in write.
      return instrumented.execute(id, input, signal, onUpdate, ctx);
    },
  });
}
