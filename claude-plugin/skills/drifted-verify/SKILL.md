---
name: drifted-verify
description: Verify a code change against real customer journeys with Drifted before declaring it done. Use after editing routes, forms, auth, payments, APIs, or anything a customer journey exercises; when the user asks to verify, check, or prove a change works; or when a Drifted run fails and needs a fix.
---

# Verify with Drifted

Drifted runs the workflows customers depend on (checkout, sign-in, an API journey) against a
deployed environment and returns a verdict with evidence. It is the proof that a change works,
separate from unit tests and separate from your own judgement.

## When to run

- After changing code that a customer journey touches: routes, forms, auth, payments, API handlers, config.
- Before telling the user a change is done.
- When the user asks to verify, check, prove, or "make sure it works".

## How to run

Prefer the MCP tools when the `drifted` server is connected:

1. `list_workflows` to see what can be checked. Pick the workflows the change could affect, or run all.
   If the app has no workflow for the journey you changed, `create_workflow` adds a paused one; keep
   production workflows read-only (GET requests, assertions, no form submissions that write).
2. `run_workflow` with the workflow name, or `run_all_workflows` before finishing. Both wait for the verdict.
3. Read `evidence.summary` first, then `evidence.failure` and `evidence.nextActions`.

Without MCP, use the CLI with the token in the environment:

```sh
npx -y drifted-dev workflows
npx -y drifted-dev run --all --wait --json
npx -y drifted-dev run "checkout" --wait --json
```

Exit code 0 means every run passed. 1 means a run failed. 2 means the wait timed out. 3 means the
token or configuration is wrong.

## How to fix a failure

The `evidence` object is designed so you can fix from it alone:

- `failure.stepNumber` and `failure.name` say which step broke. `failure.passedBefore` tells you how many
  earlier steps passed, so the environment and sign-in are usually fine.
- `failure.expected` is what the step required. `failure.observed.detail` and `failure.observed.status` are
  what happened. `failure.url` is the exact request or page.
- `failure.step` is the step as configured: method, path, selector, expected text, body. Header values that
  look like credentials are hidden.
- `nextActions` lists how to reproduce and where to look.

Fix the code, then re-run the same workflow. Repeat until the verdict is `passed`. If the workflow
itself is wrong (a selector or expected text that legitimately changed with the feature), say so and
propose the workflow edit instead of forcing the code to match a stale check.

## Rules

- Never paste a `dr_ci_` token into a file, a commit, or a command argument. It lives in `DRIFTED_TOKEN`.
- Do not disable or delete a failing workflow to get a green result.
- Runs against a production environment are read-only by design. Do not try to work around that.
- Report the run URL and the final verdict to the user.
