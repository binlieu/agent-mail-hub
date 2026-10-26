# Automatic inbox workers

An MCP connection makes tools available to an AI; it does not make an idle AI call them. These optional workers poll this hub and start a fresh, bounded Claude Code or Codex CLI job for each actionable message. They do not operate your existing terminal sessions or existing A2A service.

## Start a worker

1. Install and sign in to the Claude or Codex CLI normally. Verify `claude --version` or `codex --version`. The worker uses that CLI's existing account, model availability and allowance.
2. Start this hub normally and sign in to its dashboard. Register a dedicated agent with provider **Claude** or **Codex** and choose its model/effort. Avoid using the same agent identity manually while its worker runs.
3. Under **Automatic inbox workers**, choose the agent and matching CLI. Leave the workspace blank for message/evidence analysis, or enter an absolute path to a directory that may be inspected read-only.
4. Set a task limit (default 25), then click **Start automatic worker**. Send a message to that agent. Existing queued tasks are eligible too.
5. Watch the worker status and open **View conversation** for its answer. **Stop** cancels the current job and future polling for that worker. Start workers again after restarting the hub; they are not installed as background services.

Example research message with a configured workspace:

> List the visible top-level directories, read the README and package manifest if present, and explain the project's purpose. Cite the relative paths you actually inspected. Do not change files or claim tests were run.

For a second agent reviewing the researcher, select the same workspace and **Wait for another agent → researcher** before starting its worker. It waits for the researcher's pending tasks to finish successfully, then explicitly shares completed result copies as evidence in the same project. Send the reviewer:

> Review the researcher's shared results against the workspace. Identify unsupported claims and missing information. Cite files you actually read and explain any access limits.

The dependency waits on pending source tasks, not merely a timer. A failed source task remains pending until explicitly retried/resolved. Sharing is visible as an agent-to-agent message with evidence; it does not silently grant access to a different agent's private human conversation.

## Boundaries and status

- Polling defaults to five seconds. One job runs at a time per worker, with at most four workers per hub. Each native invocation has a three-minute time limit and bounded output. Registered supported model/effort preferences are passed to the CLI; legacy model labels fall back to the CLI default.
- The supplied workspace tools only list visible files and read bounded text files. They reject escaping symlinks, hidden files, known credential paths, oversized files, and binary files. No shell, writes, web, global hooks, other MCP servers, or existing A2A tools are provided. Choose a narrow workspace: visible ordinary files can still contain private project information and will be sent to the selected model provider.
- A successful task posts one correlated reply. A handoff additionally verifies evidence bytes, requires content review notes, records acceptance, and attaches a new recipient-owned result before completion. Text, Markdown and JSON evidence are supported. Completion does not certify tests, commits or deployment.
- Plain agent replies/notifications are acknowledged without launching another response. Agent question chains are capped to avoid unlimited reply loops. Human requests remain explicit tasks.
- `failed` or `interrupted` leaves the original task unacknowledged. There is no automatic paid retry. Inspect the error, correct the CLI login/model/workspace issue, then click **Retry worker** on the message with a running worker. A scope/tool limitation produces an explicit `blocked` reply; expand the scope or handle it manually before retrying.
- Pause blocks new launches/publication. Stopping cancels only that worker's child process group. Crashed in-flight jobs are marked interrupted on hub restart. A crash partway through handoff acceptance/completion can require manual reconciliation of the handoff state; retry does not roll back already published transitions.
- Worker settings and model invocations use private files beneath this hub's data directory. No administrator/agent hub token is passed to the AI CLI. Credentials, databases and proof files must remain outside Git.

## Administrative HTTP integration

These endpoints require this hub's administrator bearer token. Agent credentials cannot start workers.

```http
POST /api/workers
Content-Type: application/json

{"agent":"researcher","provider":"claude","workspace":"/absolute/path/to/project","maxJobs":25,"intervalSeconds":5}
```

Optionally set `waitForAgent` to another enabled agent in the same project. Dependency cycles are rejected. Use `GET /api/workers`, `POST /api/workers/researcher/stop`, and `POST /api/worker-jobs/MESSAGE_UUID/retry`. Do not embed real tokens in scripts or documentation; load them from the private instance configuration at runtime.

## Verified samples

`npm test` checks delivery, failure/retry, cancellation, limits, evidence handoff, read-only paths and prerequisite result sharing with an injected deterministic model. `npm run test:ui` exercises the dashboard controls with a deterministic model; neither test bills a real model.

For a separate real-account acceptance run:

```sh
npm run build
node scripts/live-workers.mjs --port 47942 --serve
```

This creates a separate private hub and randomized text fixture under `.local-run`. Real Claude and real Codex each read the fixture through the workspace MCP and identify a deliberately incorrect sum. Codex then reviews an operator-prepared handoff packet, records evidence review and returns its own result evidence. The script verifies source/settings fingerprints, prints proof paths without credentials, and retains artifacts. `--serve` keeps that isolated dashboard available; omit it to close after verification. Choose an unused port.

On 2026-10-25 this real-account sequence passed for both providers, including Codex's evidence handoff. The initial Claude run exposed a JSON Schema dialect incompatibility; the runner now emits a compatible schema and the complete live sequence passed afterward. This proves these installed CLI versions and accounts, not universal compatibility with all older CLI releases. Provider CLI upgrades can require another isolated acceptance run.

The same day, the existing isolated hub on port 47833 processed its three previously queued human tasks: Claude's `researcher` completed two workspace inventory requests, then Codex's `reviewer` consumed an explicitly shared result bundle and replied to the review request. All three originals were verified `answered` with worker state `done`. The source-to-reviewer sharing message was acknowledged and its evidence received a recorded review. Both workers remained enabled and waiting for more tasks, with task budgets of 25 each. The screenshots and message IDs are retained in ignored local proof artifacts; no credentials or runtime database are part of this documentation.

Replies addressed to the human may still display `queued` until the human acknowledges them. That describes the human's receipt, not an unfinished agent job. Check the original request's `answered` / `Worker: done` status to distinguish the two.

## Markdown preview verification

The dashboard renders Markdown in message cards, conversation popups and handoff details. Marked parses the text and DOMPurify sanitizes an explicit set of allowed elements and attributes. Raw HTML is escaped, images become text labels without remote requests, and links allow only HTTP, HTTPS or mailto. Stored messages and evidence are unchanged. Conversation details provide a source/preview toggle.

The dashboard browser test verifies headings, a table, fenced code, exact original Markdown in source mode, switching back to preview, blocked JavaScript links, inert raw HTML and absent image elements. It also checks the existing popup keyboard/focus behavior and mobile overflow. On 2026-10-25 these checks passed on macOS with a locally installed Chromium test browser. This run uses simulated model output for worker controls; the separate real-model results above remain distinct.
