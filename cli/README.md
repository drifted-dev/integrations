# drifted-dev

Run [Drifted](https://drifted.dev) workflows from a terminal, CI, Claude Code, or Codex, and read
evidence shaped so a coding agent can fix the failure without opening a dashboard.

```sh
export DRIFTED_TOKEN=dr_ci_...   # from the app's Automation tab; scoped to one app and environment
npx drifted-dev workflows
npx drifted-dev run checkout --wait --json
```

## Commands

| Command                                     | What it does                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `drifted workflows`                         | List the workflows this token may run.                                                                          |
| `drifted workflows create <spec.json \| ->` | Create paused workflow(s) from a JSON spec, an object or an array, from a file or stdin.                        |
| `drifted run <id or name> --wait`           | Queue one workflow and wait for the verdict. Names match case-insensitively; a unique fragment is enough.       |
| `drifted run --all --wait`                  | Queue every enabled workflow in scope and wait for all of them.                                                 |
| `drifted evidence <runId>`                  | Read a saved run, including its `evidence` object.                                                              |
| `drifted repair <runId>`                    | Ask Drifted to open a draft repair PR for a failed CI run (token must allow repairs).                           |
| `drifted run <id or name> --base-url <url>` | Verify a preview deployment instead of the environment's URL. The token must list the host under Preview hosts. |
| `drifted run … --fail-on-regression`        | Exit 1 when a passed run is slower than its production baseline.                                                |
| `drifted mcp`                               | Serve the same operations as MCP tools over stdio for Claude Code, Codex, or any MCP client.                    |

Add `--json` to any command to print JSON. With `--json`, `run` waits by default; pass `--no-wait`
to queue and return.

## Exit codes

| Code | Meaning                                            |
| ---- | -------------------------------------------------- |
| 0    | Every run passed                                   |
| 1    | A run failed, errored, timed out, or was cancelled |
| 2    | The wait deadline passed before the run finished   |
| 3    | Usage, configuration, or API error                 |

## The evidence object

`GET /api/v1/runs/:runId` and `drifted run --json` return the saved run plus `evidence`:

```json
{
  "verdict": "failed",
  "workflow": { "id": "…", "name": "Checkout", "executionMode": "http", "stepCount": 3 },
  "environment": {
    "name": "staging",
    "kind": "staging",
    "baseUrl": "https://staging.example.com",
    "runnerMode": "cloud"
  },
  "summary": "Workflow \"Checkout\" failed at step 3 of 3, \"Subscribe\", on staging (…). Expected: POST …/api/subscribe returns HTTP 200. Observed: Expected status 200, received 500 (HTTP 500). The first 2 step(s) passed.",
  "failure": {
    "stepNumber": 3,
    "name": "Subscribe",
    "action": "request",
    "step": {
      "name": "Subscribe",
      "method": "POST",
      "path": "/api/subscribe",
      "expectStatus": 200,
      "headers": "Authorization: [hidden]"
    },
    "url": "https://staging.example.com/api/subscribe",
    "expected": "POST https://staging.example.com/api/subscribe returns HTTP 200",
    "observed": {
      "status": 500,
      "detail": "Expected status 200, received 500",
      "durationMs": 1840
    },
    "passedBefore": 2
  },
  "steps": [
    {
      "number": 1,
      "name": "Open pricing",
      "action": "request",
      "ok": true,
      "status": 200,
      "durationMs": 120,
      "detail": "HTTP 200"
    }
  ],
  "nextActions": [
    "Reproduce: POST https://staging.example.com/api/subscribe",
    "Steps 1-2 passed, so the environment and any sign-in are working. Focus on what step 3 touches.",
    "The server answered 500. Check server logs for the handler behind this request.",
    "Re-run with the same token: drifted run 4000…0001 --wait --json"
  ]
}
```

Header values whose names look like credentials are replaced with `[hidden]`. Step bodies and
paths are returned as configured.

## In CI

```yaml
- run: npx drifted-dev run --all --wait
  env:
    DRIFTED_TOKEN: ${{ secrets.DRIFTED_TOKEN }}
    DRIFTED_RUN_KEY: ${{ github.run_id }}-${{ github.run_attempt }}
```

`DRIFTED_RUN_KEY` (or `--key`) makes a retried job reuse the same run instead of queueing another.

## As an MCP server

```sh
claude mcp add drifted -e DRIFTED_TOKEN=$DRIFTED_TOKEN -- npx -y drifted-dev mcp
```

Tools: `list_workflows`, `run_workflow`, `run_all_workflows`, `get_run`, `repair_run`. Each run
tool waits for the verdict and returns the evidence object with its summary first. Pass `baseUrl`
to a run tool to verify a preview deployment.

## Programmatic use

```js
import { createClient } from "drifted-dev";
const drifted = createClient({ token: process.env.DRIFTED_TOKEN });
const { workflows } = await drifted.listWorkflows();
const { runId } = await drifted.createRun({ workflowId: workflows[0].id });
const { run } = await drifted.waitForRun(runId);
console.log(run.evidence.summary);
```

Requires Node 22.12 or newer. No dependencies.
