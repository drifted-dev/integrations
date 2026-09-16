# Drifted Verify action

Runs Drifted workflows from a GitHub Actions job and posts the evidence on the pull request so a
coding agent (or a human) can fix from it.

```yaml
name: Verify customer journeys
on:
  pull_request:
  deployment_status:
jobs:
  verify:
    if: github.event_name == 'pull_request' || github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: drifted-dev/integrations/action@v0.1.0
        with:
          token: ${{ secrets.DRIFTED_TOKEN }}
          # For preview deployments: pass the preview URL. The token must list the host
          # under "Preview hosts" in the Automation tab, for example *.vercel.app.
          base-url: ${{ github.event.deployment_status.environment_url }}
```

| Input      | Default         | Meaning                                                                                       |
| ---------- | --------------- | --------------------------------------------------------------------------------------------- |
| `token`    | required        | Drifted CI token from the app's Automation tab.                                               |
| `workflow` | all enabled     | One workflow id or name.                                                                      |
| `base-url` | environment URL | Preview URL to verify. Cloud runners only; host must match the token's preview host patterns. |
| `timeout`  | `600`           | Seconds to wait for the verdict.                                                              |
| `comment`  | `true`          | Post or update one evidence comment on the PR.                                                |

Outputs: `verdict`, `run-urls`, `result-file`. The job fails when any workflow fails, so the
check blocks the merge until an agent or a person fixes the code and the re-run passes.

The comment starts with an HTML marker, so re-runs update the same comment instead of piling
up. The collapsed JSON block is the same `evidence` object the CLI and MCP tools return.
