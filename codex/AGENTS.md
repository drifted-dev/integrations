## Verification with Drifted

Drifted runs the customer journeys this app depends on against a deployed environment and
returns a verdict with evidence. Treat it as the proof that a change works.

After changing routes, forms, auth, payments, API handlers, or config, and before saying a task
is done:

1. Run every enabled workflow: the `run_all_workflows` MCP tool, or
   `npx -y drifted-dev run --all --wait --json` (token in `DRIFTED_TOKEN`).
2. For any run that did not pass, read `evidence.summary`, then `evidence.failure` and
   `evidence.nextActions`. `failure.step` is the step as configured; `failure.url` is the exact
   request or page; `failure.passedBefore` tells you earlier steps were fine.
3. Fix the code the failing step exercises. Do not disable or delete the workflow. If the check
   itself is stale, say so and propose the workflow edit.
4. Re-run until the verdict is `passed`. Report each run URL and verdict.

Never paste a `dr_ci_` token into a file, a commit, or a command argument.
