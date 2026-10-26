# Agent context and remaining allowance

The directory separates three measurements:

| Measurement | Meaning |
| --- | --- |
| Context used/free and tokens left | Last reported context for one exact AI session; compaction can reduce it. Remaining tokens require a reported capacity and context count. |
| Reported token usage | Consumed tokens reported by the host. It is not context occupancy or a subscription token balance. |
| Shared allowance remaining | `100 - used percentage` for each reported provider rate-limit window, with its reset time. Sessions on the same account share it. |

Use low-context agents with a fresh allowance reading for new work, but also check their model, connected status and actual task scope. An offline adapter or a stale metric is not proof the agent can take work. This feature does not dispatch jobs or automatically select an agent.

An MCP adapter cannot see the model's context or subscription quota by itself. The host must report them. Missing means **Unavailable**, not zero or unlimited. Reports older than five minutes are **Stale**. Once a reset time passes, the old allowance reading is **Expired**; it does not automatically become 100%. Each context, token counter and allowance window retains its own timestamp.

## Codex: explicit session log and optional account limits

Use the credential of the intended registered agent. Supply its exact session UUID and session JSONL path, not a glob or an entire sessions folder:

```sh
node dist/cli.js usage --credentials /private/builder.json \
  --source codex --input /private/intended-rollout.jsonl \
  --session-id YOUR-CODEX-SESSION-UUID --watch --account-limits
```

Omit `--watch` for a single update. Watch polls the chosen file every 20 seconds, reads at most the last 4 MiB plus a bounded identity header, and sends only changed numeric snapshots. It does not scan other sessions. Keep this command running to keep readings current; stop its own process with Ctrl+C.

Codex session logs use the latest `last_token_usage` and `model_context_window` for context; cumulative `total_token_usage` is never summed across snapshots. Original log ownership must match the supplied session ID, and explicitly foreign session records are ignored. Compacted logs, unsupported formats, or missing counters can result in unavailable values. A `codex exec --json` output file is also supported: it provides consumed tokens from completed turns, but normally lacks context capacity and quota, which stay unavailable.

`--account-limits` starts a dedicated temporary `codex --no-daemon app-server` process and calls only `initialize` and `account/rateLimits/read` (`excludeResetCreditDetails: true`). In watch mode it checks at most once a minute. It does not resume conversations, send model prompts, spend reset credits or contact agents. It reads the currently authenticated **CLI account**. Run it under the same CLI account/environment used by the intended session; it does not discover which account an arbitrary agent used previously. Multi-bucket limits are kept separate. Failed reads keep previous observations with their original age.

## Claude: native status-line data

Use a dedicated identity and known UUID for the intended Claude session. Its status-line command receives JSON on stdin and can forward it to:

```sh
node /absolute/path/agent-mail-hub/dist/cli.js usage \
  --credentials /private/planner.json --source claude --input - \
  --session-id YOUR-CLAUDE-SESSION-UUID
```

For a new, isolated session, create a **private** additional settings file containing a `statusLine` command with the same arguments and actual absolute paths. For example:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/agent-mail-hub/dist/cli.js usage --credentials /private/planner.json --source claude --input - --session-id YOUR-CLAUDE-SESSION-UUID"
  }
}
```

Then launch that intended session with matching settings:

```sh
claude --session-id YOUR-CLAUDE-SESSION-UUID --settings /private/amh-usage-settings.json
```

This sample changes the status line for that session. If you already have a status line, preserve it with a wrapper instead of replacing its output. A wrapper can forward the same stdin to both commands:

```sh
#!/bin/sh
amh_status_input=$(cat)
printf '%s' "$amh_status_input" | node /absolute/path/agent-mail-hub/dist/cli.js usage \
  --credentials /private/planner.json --source claude --input - \
  --session-id YOUR-CLAUDE-SESSION-UUID >/dev/null
printf '%s' "$amh_status_input" | /absolute/path/existing-statusline-wrapper
```

Point the private additional settings at that wrapper. Quote any paths containing spaces. No global settings, existing hooks or A2A entries need editing. Restart only the session you intend to configure. The reporter validates its UUID and forwards no native prompt, transcript path, account credentials, workspace path or cost fields. Claude status-line context uses input plus cache creation/read tokens, excluding output. Optional host percentages are used when present. Account limits depend on what that Claude host/account exposes; no undocumented credential scraping is used.

For an already captured `claude --output-format stream-json` run, import the last request's input context with `--source claude-stream --input /private/claude.jsonl --session-id UUID`. Capacity is matched to the last assistant's actual model in `modelUsage`; no model maximum is guessed. The reported token count is the last result's usage, not the sum of cumulative results. Original timestamps/file age stay visible. Stream output usually does not expose subscription quota.

## Scope, privacy and verification

Use one registered identity per model session. A new report replaces that identity's previous snapshot; this is not an aggregate across every session with the same name. The hub binds writes to the agent credential, enforces project visibility, rejects provider mismatches for Claude/Codex registrations, validates numeric ranges and timestamps, and rejects extra fields. The metrics are authenticated host reports, not independently provider-attested claims. No usage-reporting MCP tool is added for a model to guess numbers.

Snapshots live in this hub's private SQLite metadata. Source files stay untouched. Do not commit native logs, snapshots, credential files or private settings. No global configuration, provider keys or existing A2A installation is changed by the reporter. Only the explicit Codex account-limit option makes a provider-backed read; reading a saved log alone is local.

Run `npm test` and `npm run test:ui` for isolated fixtures covering missing/zero values, context versus cumulative usage, foreign session isolation, restart persistence, stale/expired windows, command-to-dashboard reporting, mobile layout and private-field rejection. Deterministic fixture percentages are not evidence of a real subscription balance.

Field references checked October 25, 2026: [Claude status-line data](https://code.claude.com/docs/en/statusline), [Codex app-server usage and account rate limits](https://learn.chatgpt.com/docs/app-server). Host schemas may change; unsupported values remain unavailable.
