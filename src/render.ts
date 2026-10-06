import {
  keyText,
  truncateToVisualLines,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Capture } from "./capture.ts";
import { countChanges, readChanges, type Change } from "./changes.ts";

export const PREVIEW_CHANGES = 3;
export const PREVIEW_LINES = 8;

/** File contents/path names must not inject terminal escape sequences. */
function safeText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�").replace(/\t/g, "   ");
}

export function inlineText(text: string): string {
  return safeText(text).replace(/\n/g, "\\n");
}

function expandHint(theme: Theme): string {
  const key = keyText("app.tools.expand");
  return theme.fg("dim", key ? `${key} to expand` : "expand tool output");
}

function coloredDiff(diff: string, theme: Theme): string {
  return safeText(diff).split("\n").map((line) =>
    theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line),
  ).join("\n");
}

class DiffPreview implements Component {
  private width?: number;
  private lines?: string[];

  constructor(private text: string, private theme: Theme) {}

  render(width: number): string[] {
    if (this.width !== width || !this.lines) {
      const { visualLines, skippedCount } = truncateToVisualLines(this.text, PREVIEW_LINES, width, 0, "start");
      this.lines = visualLines;
      if (skippedCount) {
        this.lines = [...visualLines, truncateToWidth(
          `${this.theme.fg("muted", `… (${skippedCount} more lines,`)} ${expandHint(this.theme)}${this.theme.fg("muted", ")")}`,
          width,
          "…",
        )];
      }
      this.width = width;
    }
    return this.lines;
  }

  invalidate(): void {
    this.width = undefined;
    this.lines = undefined;
  }
}

export function diffSection(changes: readonly Change[], expanded: boolean, theme: Theme): Container {
  const section = new Container();
  if (!changes.length) return section;
  section.addChild(new Spacer(1));
  section.addChild(new Text(theme.fg("toolTitle", theme.bold(`File changes (${changes.length})`)), 0, 0));

  const shown = expanded ? changes : changes.slice(0, PREVIEW_CHANGES);
  for (const change of shown) {
    section.addChild(new Spacer(1));
    const { added, removed } = countChanges(change.diff ?? "");
    const label = change.kind === "create" ? "write · new" : change.kind === "overwrite" ? "write · overwrite" : change.tool;
    const counts = change.diff === undefined ? "" : ` ${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}`;
    const header = `${theme.fg("toolTitle", inlineText(change.path))} ${theme.fg("muted", `[${label}]`)}${counts}`;
    section.addChild(new Text(header, 0, 0));
    if (change.diff) {
      const styled = coloredDiff(change.diff, theme);
      section.addChild(expanded ? new Text(styled, 0, 0) : new DiffPreview(styled, theme));
    }
    if (change.note) section.addChild(new Text(theme.fg("muted", inlineText(change.note)), 0, 0));
    if (change.toolReportedError) {
      section.addChild(new Text(theme.fg("warning", "File change observed, but the tool reported an error or cancellation."), 0, 0));
    }
  }
  if (shown.length < changes.length) {
    section.addChild(new Text(
      `${theme.fg("muted", `… (${changes.length - shown.length} more changes,`)} ${expandHint(theme)}${theme.fg("muted", ")")}`,
      0,
      0,
    ));
  }
  return section;
}

class WrappedResult extends Container {
  baseComponent?: Component;
  private changes?: readonly Change[];
  private expanded?: boolean;
  private theme?: Theme;
  private section?: Container;

  getSection(changes: readonly Change[], expanded: boolean, theme: Theme): Container {
    const sameChanges = this.changes?.length === changes.length && changes.every((item, i) => item === this.changes?.[i]);
    if (!this.section || !sameChanges || this.expanded !== expanded || this.theme !== theme) {
      this.section = diffSection(changes, expanded, theme);
      this.changes = changes;
      this.expanded = expanded;
      this.theme = theme;
    }
    return this.section;
  }

  override invalidate(): void {
    super.invalidate();
    this.section = undefined;
    this.changes = undefined;
  }
}

export function registerDiffRenderer(pi: ExtensionAPI, capture: Capture): void {
  pi.registerToolRenderer((name, next) => {
    if (name !== "codemode") return next();
    const base = next();
    const renderBase = base?.renderResult;
    // Do not invent a replacement codemode renderer when the host has none.
    if (!base || !renderBase) return base;
    return {
      ...base,
      renderResult(result, options, theme, context) {
        const component = context.lastComponent instanceof WrappedResult ? context.lastComponent : new WrappedResult();
        // Pass the original renderer ITS last component, not our outer container.
        component.baseComponent = renderBase(result, options, theme, {
          ...context,
          lastComponent: component.baseComponent,
        });
        component.clear();
        component.addChild(component.baseComponent);
        capture.watch(context.toolCallId, context.invalidate);
        const changes = readChanges(result.details) ?? capture.changes(context.toolCallId);
        component.addChild(component.getSection(changes, options.expanded, theme));
        return component;
      },
    };
  });
}
