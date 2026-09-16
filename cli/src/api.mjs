// Drifted API client. Zero dependencies, Node 22+. Shared by the CLI and the MCP server.
// Tokens come from the environment, never from arguments, so they stay out of shell history.

export const TERMINAL_STATUSES = ["passed", "failed", "errored", "timed_out", "cancelled"];
export const TOKEN_PATTERN = /^dr_ci_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f-]{36}$/i;

export class DriftedApiError extends Error {
  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = "DriftedApiError";
    this.status = status;
    this.body = body;
  }
}

/** Accept https anywhere, or plain http for a local Drifted checkout only. */
export function resolveOrigin(value) {
  const origin = new URL(value || "https://drifted.dev");
  const local = ["localhost", "127.0.0.1", "::1"].includes(origin.hostname);
  if (origin.username || origin.password)
    throw new DriftedApiError("DRIFTED_URL must not carry credentials");
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && local))
    throw new DriftedApiError(
      "DRIFTED_URL must use HTTPS (plain HTTP is allowed for localhost only)",
    );
  return origin;
}

export function createClient({
  token,
  baseUrl,
  fetch = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  if (!token || !TOKEN_PATTERN.test(token))
    throw new DriftedApiError(
      "Set DRIFTED_TOKEN to a Drifted CI token (starts with dr_ci_). Create one in the app's Automation tab.",
    );
  const origin = resolveOrigin(baseUrl);

  async function request(path, init = {}) {
    let response;
    try {
      response = await fetch(new URL(path, origin), {
        ...init,
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "drifted-cli/0.1.2",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DriftedApiError(`Could not reach ${origin.host}: ${error?.message ?? error}`);
    }
    let body = null;
    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok)
      throw new DriftedApiError(body?.error ?? `Drifted API returned HTTP ${response.status}`, {
        status: response.status,
        body,
      });
    return body;
  }

  return {
    origin,
    /** Workflows this token may run. */
    listWorkflows: () => request("/api/v1/workflows"),
    /**
     * Create a paused workflow in the token's app and environment from a spec:
     * { name, executionMode?, steps: [...], cadenceMinutes?, enabled? }. Returns { workflow }.
     */
    createWorkflow: (spec) => {
      if (!spec || typeof spec !== "object")
        throw new DriftedApiError("Provide a workflow spec object");
      return request("/api/v1/workflows", { method: "POST", body: JSON.stringify(spec) });
    },
    /** Patch a workflow: any of name, executionMode, steps, cadenceMinutes, enabled. Returns { workflow }. */
    updateWorkflow: (workflowId, patch) => {
      if (!UUID.test(workflowId ?? "")) throw new DriftedApiError("workflowId must be a UUID");
      if (!patch || typeof patch !== "object")
        throw new DriftedApiError("Provide the fields to change");
      return request(`/api/v1/workflows/${workflowId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    },
    /**
     * Queue a run. Returns { runId, status, runUrl, targetBaseUrl? }.
     * `baseUrl` points the run at a preview deployment; the token must allow that host.
     */
    createRun: ({ workflowId, idempotencyKey, baseUrl } = {}) => {
      if (!UUID.test(workflowId ?? "")) throw new DriftedApiError("workflowId must be a UUID");
      return request("/api/v1/runs", {
        method: "POST",
        body: JSON.stringify({
          workflowId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        }),
      });
    },
    /** Read a run, including its agent-ready `evidence` object. */
    getRun: (runId) => {
      if (!UUID.test(runId ?? "")) throw new DriftedApiError("runId must be a UUID");
      return request(`/api/v1/runs/${runId}`);
    },
    /** Ask Drifted to open a draft repair PR for a failed CI run (token must allow repairs). */
    repairRun: (runId) => {
      if (!UUID.test(runId ?? "")) throw new DriftedApiError("runId must be a UUID");
      return request(`/api/v1/runs/${runId}/repair`, { method: "POST", body: "{}" });
    },
    /**
     * Poll until the run reaches a terminal status or the deadline passes.
     * Returns { run, timedOut }. Never throws for a slow run; only for API errors.
     */
    async waitForRun(
      runId,
      { timeoutMs = 600_000, pollMs = 2_000, sleep = defaultSleep, now = Date.now, onPoll } = {},
    ) {
      const deadline = now() + timeoutMs;
      let run = await request(`/api/v1/runs/${runId}`);
      while (!TERMINAL_STATUSES.includes(run.status)) {
        onPoll?.(run);
        if (now() >= deadline) return { run, timedOut: true };
        await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
        run = await request(`/api/v1/runs/${runId}`);
      }
      return { run, timedOut: false };
    },
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve a workflow from a UUID, an exact name (case-insensitive), or a unique name fragment.
 * Returns { workflow } or { error, candidates }.
 */
export function resolveWorkflow(workflows, query) {
  const q = String(query ?? "").trim();
  if (!q) return { error: "Provide a workflow id or name", candidates: workflows };
  if (UUID.test(q)) {
    const byId = workflows.find((w) => w.id.toLowerCase() === q.toLowerCase());
    return byId
      ? { workflow: byId }
      : { error: `No workflow with id ${q} in this token's scope`, candidates: workflows };
  }
  const lower = q.toLowerCase();
  const exact = workflows.filter((w) => w.name.toLowerCase() === lower);
  if (exact.length === 1) return { workflow: exact[0] };
  const partial = workflows.filter((w) => w.name.toLowerCase().includes(lower));
  if (partial.length === 1) return { workflow: partial[0] };
  if (partial.length === 0) return { error: `No workflow named "${q}"`, candidates: workflows };
  return { error: `"${q}" matches ${partial.length} workflows; use the id`, candidates: partial };
}
