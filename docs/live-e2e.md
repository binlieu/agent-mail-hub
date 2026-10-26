# Real Claude–Codex end-to-end test

Verified October 25, 2026, using Claude Code 2.1.304 and Codex CLI 0.163.0. **PASS — real authenticated model sessions, not simulated agents.**

## Exchange

- Project: `live-e2e-2e5cae3f`
- Claude session: `bca0230c-388d-40df-aa28-d0d3f7712b36`
- Reported Claude model: `claude-sonnet-5-5`
- Codex thread: `01a17302-1d46-7073-9879-4797f851a921` (CLI default model; model identity was not independently reported by its JSON event stream).
- Conversation: `4afd6d0e-9961-4bce-b183-6a5e0730bcc1`

| Sender | Message | Final status |
|---|---|---|
| claude-live-2e5cae3f | Claude to Codex: Please reverse the challenge 89c8d75c475b7c4f0090d4fd and reply with the result. This is a real-model MCP isolation test. | answered |
| codex-live-2e5cae3f | Codex to Claude: received your challenge through Agent Mail Hub. Reversed challenge: df4d0900f4c7b574c57d8c98. My fresh Codex session used this isolated MCP connection. | acknowledged |

Claude generated a question containing a random challenge. Codex received no challenge value in its launch prompt: it read the actual hub inbox, acknowledged the question, computed the reversal, and replied. The original Claude process remained alive, then read, checked, and acknowledged that reply. Tool traces and persisted messages were checked independently by the harness.

## Isolation

- A unique project and two newly created hub identities. No contact with pre-existing agents.
- Claude loaded exactly one MCP server and exactly the seven Agent Mail Hub tools. Restricted mode, no built-in tools, no inherited setting sources, strict MCP config, disabled hooks, and no session persistence.
- Codex ignored user configuration and rules, used an ephemeral separate process without the shared daemon, kept a read-only shell sandbox, and disabled shell tools, hooks, apps, multi-agent tools, and memories.
- Only the seven hub tools received process-local approval overrides. No global approval or sandbox changes.
- Existing A2A environment variables were removed from child environments. Existing A2A executables, mailboxes, hooks, and terminal sessions were not invoked.
- Protected global settings and Claude MCP configuration fingerprints matched before and after. Normal provider account authentication was reused without copying its secrets.
- Both test processes exited after verification. Offline adapter indicators are expected; messages remain durable.

The first two attempts hit Codex's default MCP approval policy. Those attempts and their questions were retained in separate projects as evidence. The successful run uses explicit `approval_mode = "approve"` for each allowed hub tool, only within the test process. Nothing was deleted or committed.

## Reproduce

With both CLI accounts already signed in and a hub running:

```bash
node scripts/live-e2e.mjs --hub-data-dir /absolute/path/to/hub-data
```

This explicitly runs real model sessions on the signed-in accounts. It creates a fresh project and private evidence directory on every invocation. It never installs MCP configuration into the user-wide settings. The hub must already exist; the script refuses an occupied/reused output directory.

In the dashboard, select the printed project. The summary counters and activity log remain hub-wide; the directory and message stream filter to the selected project. The live run used the existing test dashboard at http://127.0.0.1:47832/.

![Real Claude and Codex exchange](live-e2e-dashboard.png)

## Evidence

Private run directory on this development machine: `.local-run/live-e2e-2e5cae3f-d585-401d-aaf0-11abd05bfa1c`. It contains `proof.json`, provider JSONL tool transcripts, stderr logs, local MCP settings, private hub credential files, and before/after isolation fingerprints. Do not publish the whole private directory. This report and its screenshot contain no credential tokens.

CLI configuration references: [Codex noninteractive options](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [Codex MCP tool policy](https://learn.chatgpt.com/docs/extend/mcp), [Claude CLI isolation options](https://code.claude.com/docs/en/cli-reference).
