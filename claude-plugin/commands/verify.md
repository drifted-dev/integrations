---
description: Run Drifted workflows and fix anything that fails. Pass a workflow name to run one, or nothing to run all.
argument-hint: [workflow name]
allowed-tools: Bash(npx -y drifted-dev:*), mcp__drifted__list_workflows, mcp__drifted__run_workflow, mcp__drifted__run_all_workflows, mcp__drifted__get_run
---

Verify the current change with Drifted.

Target: $ARGUMENTS (empty means every enabled workflow).

1. If the `drifted` MCP server is available, call `run_all_workflows` (or `run_workflow` with the target). Otherwise run `npx -y drifted-dev run --all --wait --json` or `npx -y drifted-dev run "$ARGUMENTS" --wait --json`.
2. Read `evidence.summary`, then `evidence.failure` and `evidence.nextActions` for any run that did not pass.
3. Fix the code the failing step exercises. Do not edit or disable the workflow unless the check itself is stale, and say so if it is.
4. Re-run the same workflow until the verdict is `passed`.
5. Report each run URL and its final verdict.

Follow the `drifted-verify` skill for details on reading evidence.
