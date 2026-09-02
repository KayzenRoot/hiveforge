import { NextResponse } from "next/server";
import { getRuntime } from "../../../src/server/runtime";

export const runtime = "nodejs";

export function GET() {
  const { codex } = getRuntime();
  const probe = codex.probe();
  const ready = probe.available && probe.authentication !== "NOT_AUTHENTICATED";
  return NextResponse.json({ status: ready ? "READY" : "NOT_CONFIGURED", codex: probe });
}
