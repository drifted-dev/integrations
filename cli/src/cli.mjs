// drifted CLI. Human output by default; --json prints exactly what an agent should read.
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createClient, DriftedApiError, resolveWorkflow, TERMINAL_STATUSES } from "./api.mjs";

export const EXIT = { PASS: 0, FAIL: 1, TIMEOUT: 2, USAGE: 3 };

const HELP = `drifted — run Drifted workflows and read agent-ready evidence

Usage
  drifted workflows [--json]
  drifted workflows create <spec.json | -> [--json]   Create paused workflow(s) from a JSON spec (object or array)
  drifted workflows update <id or name> [patch.json | -] [--enable | --pause] [--cadence <min>]
  drifted run <workflow id or name> [--wait] [--json] [--timeout <s>] [--key <id>]
  drifted run --all [--wait] [--json] [--timeout <s>]                Every workflow in scope, paused ones included
  drifted run <workflow> --base-url https://pr-12.example.app   Verify a preview deployment
  drifted evidence <runId> [--json]
  drifted repair <runId> [--json]
  drifted mcp                       Serve the MCP tools over stdio (for Claude Code, Codex, any MCP client)

Environment
  DRIFTED_TOKEN   CI token from the app's Automation tab (dr_ci_...). DRIFTED_CI_TOKEN also works.
  DRIFTED_URL     Defaults to https://drifted.dev
  DRIFTED_RUN_KEY Idempotency key for a retried CI attempt (same as --key)

Options
  --wait          Poll until the run finishes (default when --json is set)
  --no-wait       Queue and return immediately
  --json          Print JSON, including the evidence object
  --timeout <s>   Seconds to wait before giving up (default 600)
  --poll <s>      Seconds between polls (default 2)
  --key <id>      Idempotency key so a retried CI job does not queue twice
  --base-url <u>  Run against a preview URL instead of the environment's URL (token must allow the host)
  --fail-on-regression  Exit 1 when a passed run is slower than its production baseline (P95 of the last 30 passed runs)

Exit codes
  0 all runs passed · 1 a run failed or ended abnormally · 2 wait deadline passed · 3 usage or API error
`;

export async function runCli(
  argv,
  { env = process.env, fetch, stdout = process.stdout, stderr = process.stderr, sleep, now } = {},
) {
  const out = (line) => stdout.write(line + "\n");
  const err = (line) => stderr.write(line + "\n");
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        wait: { type: "boolean" },
        "no-wait": { type: "boolean" },
        all: { type: "boolean" },
        json: { type: "boolean", default: false },
        timeout: { type: "string" },
        enable: { type: "boolean" },
        pause: { type: "boolean" },
        cadence: { type: "string" },
        poll: { type: "string" },
        key: { type: "string" },
        "base-url": { type: "string" },
        "fail-on-regression": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    err(error.message);
    err(HELP);
    return EXIT.USAGE;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.version) {
    out("drifted 0.1.2");
    return EXIT.PASS;
  }
  if (values.help || !command || command === "help") {
    out(HELP);
    return command || values.help ? EXIT.PASS : EXIT.USAGE;
  }

  if (command === "mcp") {
    const { serveStdio } = await import("./mcp.mjs");
    await serveStdio({ env, ...(fetch ? { fetch } : {}), output: stdout, stderr });
    return EXIT.PASS;
  }

  let client;
  try {
    client = createClient({
      token: env.DRIFTED_TOKEN || env.DRIFTED_CI_TOKEN,
      baseUrl: env.DRIFTED_URL,
      ...(fetch ? { fetch } : {}),
    });
  } catch (error) {
    err(error.message);
    return EXIT.USAGE;
  }
  const seconds = (value, fallback) => {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
      throw new DriftedApiError(`Expected a positive number of seconds, got "${value}"`);
    return n * 1000;
  };

  try {
    switch (command) {
      case "workflows": {
        if (rest[0] === "create") {
          const source = rest[1] ?? "-";
          let text;
          try {
            text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
          } catch (error) {
            throw new DriftedApiError(`Could not read ${source}: ${error?.message ?? error}`);
          }
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new DriftedApiError(`${source} is not valid JSON`);
          }
          const specs = Array.isArray(parsed) ? parsed : [parsed];
          const created = [];
          for (const spec of specs) {
            const { workflow } = await client.createWorkflow(spec);
            created.push(workflow);
            if (!values.json)
              out(
                `Created ${workflow.name} (${workflow.id}) · ${workflow.stepCount} steps · ${workflow.enabled ? "scheduled" : "paused"}`,
              );
          }
          if (values.json) out(JSON.stringify({ workflows: created }, null, 2));
          return EXIT.PASS;
        }
        if (rest[0] === "update") {
          const { workflows } = await client.listWorkflows();
          const resolved = resolveWorkflow(workflows, rest[1]);
          if (!resolved.workflow) {
            err(resolved.error);
            if (resolved.candidates?.length) err(formatWorkflows(resolved.candidates));
            return EXIT.USAGE;
          }
          let patch = {};
          if (rest[2]) {
            try {
              patch = JSON.parse(
                rest[2] === "-" ? readFileSync(0, "utf8") : readFileSync(rest[2], "utf8"),
              );
            } catch (error) {
              throw new DriftedApiError(`Could not read the patch: ${error?.message ?? error}`);
            }
          }
          if (values.enable) patch.enabled = true;
          if (values.pause) patch.enabled = false;
          if (values.cadence !== undefined) patch.cadenceMinutes = Number(values.cadence);
          if (Object.keys(patch).length === 0)
            throw new DriftedApiError(
              "Nothing to change: pass a patch file, --enable, --pause, or --cadence",
            );
          const { workflow } = await client.updateWorkflow(resolved.workflow.id, patch);
          if (values.json) out(JSON.stringify({ workflow }, null, 2));
          else
            out(
              `Updated ${workflow.name} (${workflow.id}) · ${workflow.stepCount} steps · ${workflow.enabled ? `every ${workflow.cadenceMinutes} min` : "paused"}`,
            );
          return EXIT.PASS;
        }
        const { workflows, environmentId } = await client.listWorkflows();
        if (values.json) out(JSON.stringify({ environmentId, workflows }, null, 2));
        else out(formatWorkflows(workflows));
        return EXIT.PASS;
      }
      case "run": {
        const timeoutMs = seconds(values.timeout, 600_000);
        const pollMs = seconds(values.poll, 2_000);
        const wait = values["no-wait"] ? false : values.wait || values.json || false;
        const { workflows } = await client.listWorkflows();
        let targets;
        if (values.all) {
          // Schedule state is about monitoring; an on-demand run covers paused workflows too.
          targets = workflows;
          if (targets.length === 0) throw new DriftedApiError("No workflows in this token's scope");
        } else {
          const resolved = resolveWorkflow(workflows, rest[0]);
          if (!resolved.workflow) {
            err(resolved.error);
            if (resolved.candidates?.length) err(formatWorkflows(resolved.candidates));
            return EXIT.USAGE;
          }
          targets = [resolved.workflow];
        }
        const key = values.key || env.DRIFTED_RUN_KEY;
        const queued = [];
        for (const workflow of targets) {
          const created = await client.createRun({
            workflowId: workflow.id,
            ...(key ? { idempotencyKey: targets.length > 1 ? `${key}:${workflow.id}` : key } : {}),
            ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
          });
          queued.push({ workflow, created });
          if (!values.json) out(`Queued ${workflow.name}: ${created.runUrl}`);
        }
        if (!wait) {
          if (values.json) out(JSON.stringify({ runs: queued.map((q) => q.created) }, null, 2));
          return EXIT.PASS;
        }
        const runs = [];
        let timedOut = false;
        const started = (now ?? Date.now)();
        for (const { created } of queued) {
          const remaining = Math.max(0, timeoutMs - ((now ?? Date.now)() - started));
          const result = await client.waitForRun(created.runId, {
            timeoutMs: remaining,
            pollMs,
            ...(sleep ? { sleep } : {}),
            ...(now ? { now } : {}),
          });
          timedOut ||= result.timedOut;
          runs.push(result.run);
        }
        const regressed =
          values["fail-on-regression"] &&
          runs.some((r) => r.evidence?.performance?.status === "regressed");
        const verdict = timedOut
          ? "timed_out_waiting"
          : regressed
            ? "regressed"
            : runs.every((r) => r.status === "passed")
              ? "passed"
              : "failed";
        if (values.json)
          out(JSON.stringify(runs.length === 1 ? runs[0] : { verdict, runs }, null, 2));
        else for (const run of runs) out(formatRun(run));
        if (timedOut) {
          err(
            "Wait deadline passed before every run finished. Inspect the run URL or raise --timeout.",
          );
          return EXIT.TIMEOUT;
        }
        return verdict === "passed" ? EXIT.PASS : EXIT.FAIL;
      }
      case "evidence": {
        const run = await client.getRun(rest[0]);
        if (values.json) out(JSON.stringify(run, null, 2));
        else out(formatRun(run));
        if (!TERMINAL_STATUSES.includes(run.status)) return EXIT.TIMEOUT;
        if (values["fail-on-regression"] && run.evidence?.performance?.status === "regressed")
          return EXIT.FAIL;
        return run.status === "passed" ? EXIT.PASS : EXIT.FAIL;
      }
      case "repair": {
        const result = await client.repairRun(rest[0]);
        if (values.json) out(JSON.stringify(result, null, 2));
        else out(`Draft repair PR: ${result.pullRequestUrl}`);
        return EXIT.PASS;
      }
      default:
        err(`Unknown command "${command}"`);
        err(HELP);
        return EXIT.USAGE;
    }
  } catch (error) {
    if (error instanceof DriftedApiError) {
      err(error.status ? `${error.message} (HTTP ${error.status})` : error.message);
      return EXIT.USAGE;
    }
    throw error;
  }
}

export function formatWorkflows(workflows) {
  if (!workflows.length) return "No workflows in this token's scope.";
  const width = Math.max(...workflows.map((w) => w.name.length));
  return workflows
    .map(
      (w) =>
        `${w.enabled === false ? "⏸" : "•"} ${w.name.padEnd(width)}  ${w.id}  ${w.executionMode ?? ""}${
          w.lastRunAt ? `  last run ${w.lastRunAt}` : ""
        }`,
    )
    .join("\n");
}

export function formatRun(run) {
  const e = run.evidence;
  const lines = [];
  const title = e
    ? `${e.workflow.name} — ${e.environment.name} (${e.environment.baseUrl})`
    : `Run ${run.runId ?? run.id}`;
  lines.push(title);
  const duration = run.duration_ms != null ? ` in ${run.duration_ms} ms` : "";
  lines.push(`${String(run.status).toUpperCase()}${duration} · ${run.runUrl ?? ""}`.trim());
  const steps =
    e?.steps ??
    (Array.isArray(run.log)
      ? run.log.map((s) => ({
          number: s.index + 1,
          name: s.name,
          ok: s.ok,
          status: s.status,
          durationMs: s.durationMs,
          detail: s.detail,
        }))
      : []);
  const nameWidth = Math.min(40, Math.max(0, ...steps.map((s) => s.name.length)));
  for (const step of steps) {
    const mark = step.ok === null ? "·" : step.ok ? "✓" : "✗";
    const status = step.status != null ? `HTTP ${step.status}` : "";
    const ms = step.durationMs != null ? `${step.durationMs} ms` : "";
    const detail = step.ok === false && step.detail ? `  ${step.detail}` : "";
    lines.push(
      `  ${mark} ${String(step.number).padStart(2)}  ${step.name.slice(0, 40).padEnd(nameWidth)}  ${ms.padStart(8)}  ${status}${detail}`.trimEnd(),
    );
  }
  if (e?.failure) {
    lines.push(`Expected: ${e.failure.expected}`);
    lines.push(
      `Observed: ${e.failure.observed.detail}${e.failure.observed.status != null ? ` (HTTP ${e.failure.observed.status})` : ""}`,
    );
    if (e.failure.url) lines.push(`URL:      ${e.failure.url}`);
  }
  if (e?.performance?.summary && e.performance.status !== "no_baseline")
    lines.push(`Perf:     ${e.performance.summary}`);
  if (e?.nextActions?.length) {
    lines.push("Next:");
    for (const action of e.nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}
