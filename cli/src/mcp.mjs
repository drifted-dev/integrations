// Minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited), tools only.
// Hand-rolled so the package stays dependency-free. Both Claude Code and Codex speak this.
import { createInterface } from "node:readline";
import { createClient, DriftedApiError, resolveWorkflow } from "./api.mjs";

export const SERVER_INFO = { name: "drifted", version: "0.1.2" };
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const waitOptions = {
  wait: { type: "boolean", description: "Wait for the verdict (default true)." },
  timeoutSeconds: {
    type: "number",
    description: "Seconds to wait before giving up (default 600).",
  },
  idempotencyKey: { type: "string", description: "Reuse a run for a retried attempt." },
  baseUrl: {
    type: "string",
    description:
      "Run against a preview deployment URL instead of the environment's URL. The token must allow that host.",
  },
};

export const TOOLS = [
  {
    name: "list_workflows",
    description:
      "List the Drifted workflows this token may run, with ids, names, engine, and last run time. Call this first to learn what can be verified.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_workflow",
    description:
      "Run one Drifted workflow against its environment and return the verdict with agent-ready evidence. Accepts a workflow id, exact name, or unique name fragment. Use after changing code the workflow exercises.",
    inputSchema: {
      type: "object",
      properties: {
        workflow: { type: "string", description: 'Workflow id or name, e.g. "checkout".' },
        ...waitOptions,
      },
      required: ["workflow"],
      additionalProperties: false,
    },
  },
  {
    name: "run_all_workflows",
    description:
      "Run every enabled Drifted workflow in scope and return each verdict with evidence. Use before declaring a change done.",
    inputSchema: { type: "object", properties: { ...waitOptions }, additionalProperties: false },
  },
  {
    name: "create_workflow",
    description:
      'Create a paused Drifted workflow in the token\'s app and environment. HTTP steps: { name, action: "request", method, path, expectStatus?, expectText? }. Browser steps: { name, action: navigate|click|fill|assertText|assertUrl|assertVisible, path?, target?, value?, expectText? }. Validation errors come back with the step number.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        executionMode: { type: "string", enum: ["http", "browser"] },
        steps: { type: "array", items: { type: "object" }, minItems: 1 },
        cadenceMinutes: {
          type: "number",
          description: "15, 30, 60, 360, 720, 1440, or 10080. Default 1440.",
        },
        enabled: {
          type: "boolean",
          description: "Schedule it right away. Default false (paused).",
        },
      },
      required: ["name", "steps"],
      additionalProperties: true,
    },
  },
  {
    name: "get_run",
    description: "Read a saved Drifted run by id, including its evidence object and next actions.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string", description: "Run id (UUID)." } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "repair_run",
    description:
      "Ask Drifted to open a draft repair pull request for a failed CI run. Requires a token with repairs enabled and a connected repository.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string", description: "Failed run id (UUID)." } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
];

function text(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function toolResult(structured, summary) {
  const body = summary ? `${summary}\n\n${text(structured)}` : text(structured);
  return { content: [{ type: "text", text: body }], structuredContent: structured, isError: false };
}
function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}
function runSummary(run) {
  return run?.evidence?.summary ?? `Run ${run?.runId ?? run?.id} is ${run?.status}.`;
}

async function runAndWait(client, workflow, args, sleep, now) {
  const created = await client.createRun({
    workflowId: workflow.id,
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
  });
  if (args.wait === false)
    return { ...created, workflow: { id: workflow.id, name: workflow.name } };
  const { run, timedOut } = await client.waitForRun(created.runId, {
    timeoutMs: (args.timeoutSeconds ?? 600) * 1000,
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
  });
  return { ...run, timedOut };
}

/**
 * Build a server. `getClient` is called lazily so tools/list works before a token exists,
 * and a missing token surfaces as a tool error the agent can relay.
 */
export function createMcpServer({ getClient, sleep, now } = {}) {
  let client;
  const clientOrThrow = () => {
    if (!client) client = getClient();
    return client;
  };

  async function callTool(name, args = {}) {
    try {
      const drifted = clientOrThrow();
      switch (name) {
        case "list_workflows": {
          const result = await drifted.listWorkflows();
          return toolResult(result, `${result.workflows.length} workflow(s) in scope.`);
        }
        case "run_workflow": {
          const { workflows } = await drifted.listWorkflows();
          const resolved = resolveWorkflow(workflows, args.workflow);
          if (!resolved.workflow)
            return toolError(
              `${resolved.error}. Available: ${resolved.candidates.map((w) => `${w.name} (${w.id})`).join(", ") || "none"}`,
            );
          const run = await runAndWait(drifted, resolved.workflow, args, sleep, now);
          return toolResult(
            run,
            run.timedOut
              ? `Run did not finish within the wait window. ${runSummary(run)}`
              : runSummary(run),
          );
        }
        case "run_all_workflows": {
          const { workflows } = await drifted.listWorkflows();
          const targets = workflows.filter((w) => w.enabled !== false);
          if (targets.length === 0) return toolError("No enabled workflows in this token's scope.");
          const runs = [];
          for (const workflow of targets)
            runs.push(
              await runAndWait(
                drifted,
                workflow,
                args.idempotencyKey
                  ? { ...args, idempotencyKey: `${args.idempotencyKey}:${workflow.id}` }
                  : args,
                sleep,
                now,
              ),
            );
          const verdict = runs.some((r) => r.timedOut)
            ? "timed_out_waiting"
            : args.wait === false
              ? "queued"
              : runs.every((r) => r.status === "passed")
                ? "passed"
                : "failed";
          const summary = runs.map((r) => `- ${runSummary(r)}`).join("\n");
          return toolResult({ verdict, runs }, `Verdict: ${verdict}\n${summary}`);
        }
        case "create_workflow": {
          const { workflow } = await drifted.createWorkflow(args);
          return toolResult(
            workflow,
            `Created "${workflow.name}" with ${workflow.stepCount} step(s), ${workflow.enabled ? "scheduled" : "paused"}. Run it with run_workflow.`,
          );
        }
        case "get_run": {
          const run = await drifted.getRun(args.runId);
          return toolResult(run, runSummary(run));
        }
        case "repair_run": {
          const result = await drifted.repairRun(args.runId);
          return toolResult(result, `Draft repair PR: ${result.pullRequestUrl}`);
        }
        default:
          return toolError(`Unknown tool "${name}"`);
      }
    } catch (error) {
      if (error instanceof DriftedApiError)
        return toolError(error.status ? `${error.message} (HTTP ${error.status})` : error.message);
      return toolError(`Drifted tool failed: ${error?.message ?? String(error)}`);
    }
  }

  /** Handle one JSON-RPC message. Returns a response object, or null for notifications. */
  async function handle(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0")
      return {
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      };
    const { id, method, params } = message;
    const isNotification = id === undefined;
    const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
    const fail = (code, msg) =>
      isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: msg } };
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOLS[0];
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Drifted verifies real customer journeys on a deployed environment. Call list_workflows to see what can be checked, run_workflow or run_all_workflows after a change, then read evidence.failure and evidence.nextActions to fix and re-run until the verdict is passed.",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        if (!params || typeof params.name !== "string")
          return fail(-32602, "tools/call requires a tool name");
        return reply(await callTool(params.name, params.arguments ?? {}));
      }
      default:
        if (typeof method === "string" && method.startsWith("notifications/")) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  return { handle, callTool, tools: TOOLS };
}

/** Serve MCP over stdio until stdin closes. Logs go to stderr; stdout carries protocol only. */
export async function serveStdio({
  env = process.env,
  fetch,
  input = process.stdin,
  output = process.stdout,
  stderr = process.stderr,
} = {}) {
  const server = createMcpServer({
    getClient: () =>
      createClient({
        token: env.DRIFTED_TOKEN || env.DRIFTED_CI_TOKEN,
        baseUrl: env.DRIFTED_URL,
        ...(fetch ? { fetch } : {}),
      }),
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const write = (message) => output.write(JSON.stringify(message) + "\n");
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    try {
      const response = await server.handle(message);
      if (response) write(response);
    } catch (error) {
      stderr.write(`drifted mcp: ${error?.message ?? error}\n`);
      if (message?.id !== undefined)
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "Internal error" },
        });
    }
  }
}
