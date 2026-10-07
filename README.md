# pi-codemode-diff

A Pi extension that **shows file diffs for `edit` and `write` calls made inside codemode**.

The existing renderer still handles the codemode script, nested call status, and script output. In Pi, this extension adds per-call file diffs below that output without changing the result content sent to the model. In PiG, it preserves the native codemode card and displays completed diffs in a separate transcript entry (see [PiG compatibility](#pig-compatibility)).

```diff
codemode
  ✓ write {"path":"src/config.ts", ...}
  ✓ edit {"path":"src/main.ts", ...}

File changes (2)

src/config.ts [write · new] +2 -0
+1 export const config = {
+2   timeout: 5000,

src/main.ts [edit] +1 -1
-4 const timeout = 1000;
+4 const timeout = 5000;
… (18 more lines, ctrl+o to expand)
```

## Requirements

- **Pi 1.0.1 or later**. The current test suite runs against Pi 1.0.2; the minimum-host contract was also verified against Pi 1.0.1 in earlier releases.
- Node.js 22.19 or later.
- `codemode` must be active. This extension does not activate it.

The minimum host version is declared in `peerDependencies` for both `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as `>=1.0.1`. Pi 1.0.0 is not supported: it includes codemode but lacks `registerToolRenderer`, which was introduced in 1.0.1. A startup capability check also reports a clear upgrade requirement if the renderer API is unavailable.

Public APIs used: `registerToolRenderer`, `tool_execution_start/end`, `tool_result`, `parentToolCallId`, `createWriteToolDefinition`, and `generateDiffString`.

## Installation

Install the released version directly from GitHub:

```bash
pi install git:github.com/hyein-cbio/pi-codemode-diff@v0.1.2
```

You can also install the released package from npm:

```bash
pi install npm:pi-codemode-diff
```

Run `/reload` in an existing Pi session after installation.

## Local usage

Replace `/path/to/pi-codemode-diff` in the examples below with the absolute path to your local checkout.

Try the extension for one invocation without adding it to your settings:

```bash
pi -e /path/to/pi-codemode-diff/src/index.ts
```

Install the local package persistently:

```bash
pi install /path/to/pi-codemode-diff
```

In an existing Pi session, run `/reload` after installation. Run `/reload` again after changing the source. You do not need to install the package twice or copy it into the global extensions directory.

The package does not bundle duplicate copies of host-provided modules. Pi installs the `diff` runtime dependency for npm/git installations. For a local checkout, run `npm install --omit=dev --omit=peer --ignore-scripts` before loading it (or `npm ci` for development); Pi does not install local-package dependencies.

## PiG compatibility

PiG's Node subprocess renderer API has a documented limitation ([D89](https://github.com/MichaelKinsy/PiG/blob/main/docs/parity/DIVERGENCES.md)): `next()` returns a marker, not callable render functions. This extension therefore does **not** replace or wrap PiG's codemode renderer.

Only when running inside PiG's Node extension runtime:

- Completed codemode calls with captured changes append a `pi-codemode-diff:pig` custom entry, labeled with the parent call ID. The original script, nested call status, and output remain under PiG's control.
- The entry uses the same **3-change / 8-visual-line preview**, diff colors, sanitization, and expanded view as Pi. Use Ctrl+O to toggle expansion.
- Custom entries are persisted but **excluded from model context**. Parent result metadata is still recorded; `content`, `structuredContent`, script values, and success/failure are unchanged.
- Diffs appear after the parent call completes, not as a live partial preview. Concurrent calls can finish out of order; the parent ID identifies each entry.
- Newly recorded entries work after resume/reload. Older PiG sessions with only `details.piCodemodeDiff` and no custom entry are not backfilled.

Host detection checks PiG's SDK shim `__runtime()` and requires its `api` to be the exact extension API object. It does not infer PiG from a missing renderer, `.pig` paths, or inherited environment variables. This private shim contract is intentionally fail-closed: if PiG removes it, the PiG display fallback will not activate. Normal Pi always keeps the original synchronous renderer-composition path and never imports the PiG-only `src/pig.ts` module.

For local PiG use:

```bash
pig -e /path/to/pi-codemode-diff/src/index.ts
# Or install persistently, then /reload in an existing session:
pig install /path/to/pi-codemode-diff
```

### Local executable verification

The PiG compatibility path was also checked with installed **Pi 1.0.3** and **PiG 0.4.1+1.0.3** executables, not only a mocked renderer. Isolated offline sessions with a scripted local provider compared pre-change and updated extension behavior: direct write, nested create/edit/overwrite, long diffs, read-only calls, and script failure after a successful write. Model-facing results (excluding elapsed time), success/error status, and written bytes matched. Only PiG produced the additional custom entries.

The installed PiG interactive TUI was exercised through a PTY: live completed-entry display, collapsed preview, Ctrl+O expansion/collapse, saved-session resume, and `/reload` all passed. These checks cover those versions and scenarios, not every host feature, every third-party extension stack, or byte-for-byte UI parity. PiG still uses separate completion-time entries rather than Pi's inline/live diff section.

### Revalidate after a PiG upgrade

Because host detection depends on a private SDK shim, revalidate compatibility for each PiG version you intend to support:

1. Record `pi --version` and `pig --version`. Run `npm run typecheck` and `npm test` to check the unchanged Pi path and unit regressions.
2. Run `PIG_NODE_RUNTIME_DIR=/path/to/PiG/coding/extension/host/subprocess/runtime-node npm test` with runtime sources matching the installed PiG version. Confirm that the PiG loader test passes, rather than being skipped; this checks the shim identity, lazy loading, and entry renderer registration.
3. In an isolated temporary workspace, load the extension with the installed `pig` executable and exercise the [manual session checks](#manual-session-checks). Verify the completed `File changes` entries, Ctrl+O expansion/collapse, session resume, and `/reload`. Repeat the Pi checks to confirm that no PiG custom entries appear there.
4. If the shim identity check stops matching, investigate PiG's current runtime contract before updating `src/host.ts`. Do not substitute executable names, inherited environment variables, or missing render functions as host detection. Update the verified-version record only after both loader and executable checks pass.

## Preview and full view

- Collapsed: previews the first **3 changes**, with **8 visual lines** of diff per change.
- Expanded: use Pi's tool-output expansion key, **Ctrl+O** by default.
- Press Ctrl+O again to return to the preview.
- If you customize the keybinding in Pi, the expansion hint uses your configured key.
- Long lines wrap to the terminal width before the preview limit is applied.
- Repeated changes to the same file appear separately by call; they are not merged into a cumulative diff.
- Single-line replacements highlight changed words with inverse video: green on added lines, red on removed lines, like Pi's native edit diff. This works in both preview and expanded views, for captured edits and write overwrites, including PiG entries. Like Pi, only a consecutive block with exactly one removed and one added line gets word highlighting; larger replacement blocks and standalone additions/deletions keep line colors. Leading indentation is not highlighted. Whitespace changes that cannot be reconstructed exactly keep their original lines without word highlighting. Very large or complex word comparisons also fall back to line colors to keep rendering responsive.

Full view means **all change hunks in the captured diff**, not the entire unchanged file. The surrounding context lines and omission markers produced by Pi's diff generator remain intact.

Preview limits apply only to rendering. Stored diffs are not truncated. You can adjust `PREVIEW_CHANGES` and `PREVIEW_LINES` in `src/render.ts`.

## How it works

### edit

Pi's existing edit tool executes unchanged. The extension collects `details.diff` from successful edit results inside codemode. Failed edits are not shown as successful changes. If a custom edit tool does not provide a diff, the extension displays a notice instead.

### write

The built-in write tool does not return a diff. The extension therefore registers a tool with the same name and delegates to Pi's `createWriteToolDefinition()`.

- Direct write calls use the original execution, result, and renderer. No previous-content snapshot is read.
- Writes inside codemode read the previous content **inside Pi's file mutation queue**, immediately before writing, and generate a diff after the write succeeds.
- New files show their content as additions. Empty-file creation is also reported.
- Existing files show the diff between the actual previous content and the new content.
- Unreadable previous content, binary files, and invalid UTF-8 produce a notice that a text diff is unavailable. The extension does not guess the previous content or treat these cases as new files, and it does not block an otherwise valid write.
- Diff-generation failures produce a display notice rather than turning a successful write into a failed tool call.

The original write schema, description, success message, directory creation, file mutation queue, and renderer are reused. Registering the extension does not activate a disabled write tool.

### Display data and model context

```text
Nested edit/write
    → Session-local capture
    → Parent codemode result's details.piCodemodeDiff
    → Existing codemode output + additional diff rendering
```

In Pi, display data is preserved **only in the parent result's `details`**, using this format. PiG additionally stores the same data in the non-context custom entry described above:

```typescript
{
  piCodemodeDiff: {
    version: 1,
    changes: [
      {
        toolCallId: "parent/1",
        tool: "edit",
        path: "src/main.ts",
        kind: "edit",
        diff: "-4 before\n+4 after"
      }
    ]
  }
}
```

- Diffs are not added to model-facing `content`, `structuredContent`, or script return values.
- Other codemode metadata, such as `details.calls`, is preserved.
- With session persistence enabled, newly captured diffs remain available after resuming a session or reloading extensions.
- Diffs from sessions recorded before installation cannot be recovered retroactively, because their nested results were not stored.
- Parallel codemode calls are isolated by call ID.
- Nested paths are also tracked when a tool inside codemode calls edit or write in turn.
- Changes are displayed in call-start order. This does not guarantee a global file-mutation order across parallel operations.

If a script explicitly prints file content with `text()`, that content still enters model context through codemode's normal behavior. This extension does not remove existing output or context.

## Scope and limitations

This extension improves **change visibility**. It does not add undo tools, checkpoints, Git operations, backup files, context injection, or model behavior instructions. It does not change the existing model-driven revert workflow.

- File changes made through bash, Python, formatters, or external processes are not detected.
- Other extensions that replace write, including remote or custom filesystem implementations, are not automatically composed with this wrapper. Check for conflicts when using packages that change file-writing behavior.
- Extensions such as compact-transcript may hide diffs in the collapsed view by reducing tool results to one-line summaries. Disable those extensions or expand the tool output if needed.
- Write diffs normalize CRLF/CR line endings and the UTF-8 BOM for display. Changes hidden by normalization are reported with a notice. These diffs are not byte-exact recovery records.
- Original files are not saved separately. The previous-content snapshot is not retained after computing the write diff.
- Large diffs can increase **session file size and rendering cost**, rather than model context usage.
- Terminal control characters in file content and paths are replaced for display so they cannot execute as terminal escape sequences. The stored diff data is unchanged.
- Capture is not guaranteed through forced process termination or every cancellation path. If a write completes before the tool reports an error or cancellation, the observed write and that status are displayed together.
- Result content remains unchanged in print, JSON, and RPC modes. The additional terminal diff UI uses Pi's TUI renderer.

Stored diffs may contain source code or sensitive content. Review sessions before exporting or sharing them.

## Development and testing

```bash
cd /path/to/pi-codemode-diff
npm ci
npm run typecheck
npm test
npm run test:coverage

# Optional: exercise PiG's actual Node SDK shim and jiti extension loader.
# Use a PiG checkout's coding/extension/host/subprocess/runtime-node directory:
PIG_NODE_RUNTIME_DIR=/path/to/PiG/coding/extension/host/subprocess/runtime-node npm test
```

The test suite has five layers:

- **Unit and event-hook tests:** capture isolation and ordering, metadata validation and serialization, unchanged model-facing result content, lifecycle cleanup, and renderer composition.
- **Filesystem edge cases:** new and overwritten files, empty files, parallel writes through symlinks, cancellation before and after a mutation, unreadable snapshots, binary content, invalid UTF-8, and exact written bytes despite display normalization.
- **Real Pi integration:** the SDK's actual extension loader, event pipeline, codemode sandbox, and built-in tools run against temporary workspaces. Tests cover direct-call compatibility, disabled tools, nested helper calls, parallel codemode calls, blocked writes, final errors introduced by another result handler, persistent session resume, and extension reload. Pi's native tool component is also exercised for diff expansion and theme changes.
- **PiG compatibility tests:** fail-closed host identification, isolated final entries, persisted entry rendering, expansion, sanitization, and final nested error status. The optional PiG loader fixture uses PiG's real runtime/SDK modules with stubbed host append IPC; it is not an end-to-end terminal UI test.
- **Package smoke test:** `npm pack` creates an artifact in a temporary directory. The test checks its file list, extracts it, and loads the extracted extension through real Pi.

Integration tests use Pi's local faux provider with scripted responses, not a remote model. Credentials, settings, session files, and workspaces are isolated in temporary directories. Tests do not modify your global Pi configuration.

`npm run test:coverage` uses c8 with TypeScript source maps and writes a machine-readable report to `coverage/coverage-summary.json`. Coverage is limited to this package's `src` files; it is not a claim of exhaustive coverage of Pi itself. The lockfile makes development dependency installation reproducible.

The POSIX permission test is skipped for root users and on Windows. Symlink and tar-based package tests are also skipped on Windows. Terminal keyboard delivery and interactions with your personal extension stack still require the manual checks below.

### Manual session checks

Run `pi -e /path/to/pi-codemode-diff/src/index.ts` from a separate temporary working directory, replacing the placeholder with the path to your checkout. If codemode is inactive, add it to the active tool selection first.

1. Write a new file inside codemode, then edit it: verify the creation and replacement diffs.
2. Overwrite an existing file with write: verify deletions of the previous content and additions of the new content.
3. Make changes exceeding 30 lines across several files: check the default preview, Ctrl+O full view, and collapse toggle.
4. Use a narrow terminal, resize the window, and switch themes: check line widths and colors.
5. Call edit and write directly, outside codemode: verify the original Pi display.
6. Change several files in parallel and write the same file sequentially or in parallel: verify per-call diffs.
7. Make a script fail after a successful write: verify that the applied write's diff remains visible.
8. Resume the session and run `/reload`: verify that captured diffs are displayed again.

## File layout

```text
src/index.ts     Event wiring and parent-result metadata persistence
src/capture.ts   Codemode ancestry and session-local capture state
src/changes.ts   Display metadata and write diff generation
src/write.ts     Built-in write delegation and in-queue snapshots
src/render.ts    Renderer composition, previews, and full view
src/diff.ts      Theme-aware line colors and single-line word highlighting
src/host.ts      Fail-closed PiG host identification
src/pig.ts       Lazily loaded PiG-only non-context entry display
test/            Unit, filesystem, real-Pi integration, and package tests
```
