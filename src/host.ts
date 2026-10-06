import * as hostSDK from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { asRecord } from "./changes.ts";

/**
 * PiG's Node SDK shim exposes __runtime(); Pi's SDK does not. Compare the
 * actual API identity, not inherited PIG_* variables or a missing renderer.
 * This is intentionally fail-closed if PiG changes its private shim contract.
 */
export function isPiGHost(pi: ExtensionAPI, sdk: unknown = hostSDK): boolean {
  const runtime = asRecord(sdk)?.__runtime;
  if (typeof runtime !== "function") return false;
  try {
    return asRecord(runtime())?.api === pi;
  } catch {
    return false;
  }
}
