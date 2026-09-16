#!/usr/bin/env node
// Turns the CLI's JSON result into GitHub outputs or a markdown report. Node 22+, no dependencies.
import { readFileSync } from "node:fs";

export const MARKER = "<!-- drifted-verify -->";

export function parseResult(text) {
  if (!text?.trim()) return { runs: [] };
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed.runs)) return { verdict: parsed.verdict, runs: parsed.runs };
  return { verdict: parsed.status === "passed" ? "passed" : "failed", runs: [parsed] };
}

export function verdictFor(result, exitCode) {
  if (exitCode === 2) return "timed_out_waiting";
  if (exitCode === 3) return "error";
  if (result.verdict) return result.verdict;
  return result.runs.every((r) => r.status === "passed") ? "passed" : "failed";
}

function icon(status) {
  return status === "passed" ? "✅" : ["queued", "running"].includes(status) ? "⏳" : "❌";
}

export function buildMarkdown(result, exitCode) {
  const verdict = verdictFor(result, exitCode);
  const lines = [
    MARKER,
    `## Drifted verification: ${verdict === "passed" ? "passed ✅" : `${verdict} ❌`}`,
    "",
  ];
  if (exitCode === 3 || result.runs.length === 0) {
    lines.push(
      "Drifted could not run. Check the `DRIFTED_TOKEN` secret, the workflow name, and the preview host patterns on the token.",
    );
    return lines.join("\n");
  }
  lines.push("| Workflow | Verdict | Duration | Run |", "| --- | --- | --- | --- |");
  for (const run of result.runs) {
    const e = run.evidence;
    const name = e?.workflow?.name ?? run.workflowId ?? "Workflow";
    const duration = run.duration_ms != null ? `${run.duration_ms} ms` : "";
    lines.push(
      `| ${name} | ${icon(run.status)} ${run.status} | ${duration} | [open](${run.runUrl ?? ""}) |`,
    );
  }
  for (const run of result.runs) {
    const e = run.evidence;
    if (!e || (run.status === "passed" && e.performance?.status !== "regressed")) continue;
    lines.push("", `### ${e.workflow?.name ?? "Workflow"}: ${e.summary ?? run.status}`);
    if (e.environment?.targetOverride)
      lines.push(`Target: \`${e.environment.targetOverride}\` (preview)`);
    if (e.performance?.status === "regressed") lines.push(`⚠️ ${e.performance.summary}`);
    if (e.failure) {
      lines.push(
        "",
        `- **Step ${e.failure.stepNumber}: ${e.failure.name}**`,
        `- Expected: ${e.failure.expected}`,
        `- Observed: ${e.failure.observed?.detail ?? ""}${e.failure.observed?.status != null ? ` (HTTP ${e.failure.observed.status})` : ""}`,
      );
      if (e.failure.url) lines.push(`- URL: ${e.failure.url}`);
    }
    if (e.nextActions?.length)
      lines.push("", "Next actions:", ...e.nextActions.map((a) => `- ${a}`));
    lines.push(
      "",
      "<details><summary>Evidence JSON for your agent</summary>",
      "",
      "```json",
      JSON.stringify(e, null, 2),
      "```",
      "",
      "</details>",
    );
  }
  lines.push(
    "",
    "_Posted by [Drifted](https://drifted.dev). An agent can fix from the evidence above and re-run with `drifted run`._",
  );
  return lines.join("\n");
}

export function buildOutputs(result, exitCode) {
  const urls = result.runs
    .map((r) => r.runUrl)
    .filter(Boolean)
    .join("\n");
  return [
    `verdict=${verdictFor(result, exitCode)}`,
    "run-urls<<DRIFTED_EOF",
    urls,
    "DRIFTED_EOF",
  ].join("\n");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [mode, file, code] = process.argv.slice(2);
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  let result;
  try {
    result = parseResult(text);
  } catch {
    result = { runs: [] };
  }
  const exitCode = Number(code ?? 0);
  process.stdout.write(
    (mode === "outputs" ? buildOutputs(result, exitCode) : buildMarkdown(result, exitCode)) + "\n",
  );
}
