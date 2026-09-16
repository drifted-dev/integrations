# Drifted integrations

Everything a coding agent needs to verify its work with [Drifted](https://drifted.dev): real
customer journeys run on a deployed environment or a pull request preview, with evidence the
agent can fix from.

| Folder           | What it is                                                                                | Install                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `claude-plugin/` | Claude Code plugin: MCP tools, `/verify`, and the `drifted-verify` skill                  | `claude plugin marketplace add drifted-dev/integrations` then `claude plugin install drifted@drifted` |
| `action/`        | GitHub Action that runs workflows, verifies preview URLs, and comments evidence on the PR | `uses: drifted-dev/integrations/action@v0.1.0`                                                        |
| `codex/`         | Codex MCP config and an AGENTS.md section                                                 | append to `~/.codex/config.toml` and your `AGENTS.md`                                                 |
| `cli/`           | Source of the `drifted-dev` npm package: CLI and MCP server                               | `npx -y drifted-dev`                                                                                  |

The token comes from an app's Automation tab in Drifted, is scoped to one app and one
environment, and is read from `DRIFTED_TOKEN`. Never write it into a file.

This repository is mirrored from the Drifted product repository. Open issues here; changes land
upstream and are synced.
