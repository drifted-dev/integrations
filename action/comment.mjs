#!/usr/bin/env node
// Creates or updates the single Drifted comment on the pull request. Node 22+, no dependencies.
import { readFileSync } from "node:fs";
import { buildMarkdown, MARKER, parseResult } from "./report.mjs";

const token = process.env.GH_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const pr = process.env.PR_NUMBER;
const api = process.env.GITHUB_API_URL || "https://api.github.com";
if (!token || !repo || !pr) {
  console.error("comment.mjs: GH_TOKEN, GITHUB_REPOSITORY, and PR_NUMBER are required");
  process.exit(0);
}
let result;
try {
  result = parseResult(readFileSync(process.env.RESULT_FILE, "utf8"));
} catch {
  result = { runs: [] };
}
const body = buildMarkdown(result, Number(process.env.EXIT_CODE ?? 0));
const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "x-github-api-version": "2022-11-28",
};
async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response.status === 204 ? null : response.json();
}
const comments = await call(`/repos/${repo}/issues/${pr}/comments?per_page=100`);
const existing = comments.find((c) => typeof c.body === "string" && c.body.startsWith(MARKER));
if (existing)
  await call(`/repos/${repo}/issues/comments/${existing.id}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
else
  await call(`/repos/${repo}/issues/${pr}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
console.log(existing ? "Updated the Drifted comment." : "Posted the Drifted comment.");
