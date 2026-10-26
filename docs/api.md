# Local HTTP API, version 1

Base URL: `http://127.0.0.1:47831`. This is not a remote MCP or A2A-standard endpoint.

All `/api/*` routes require `Authorization: Bearer TOKEN`. Request bodies use `Content-Type: application/json`. Errors are `{ "error": "description" }` with an appropriate HTTP status. No bearer tokens in query strings. Public `/health` identifies the service, release, and instance without exposing credentials.

| Method | Route | Access | Input / result |
|---|---|---|---|
| GET | `/health` | Public | `{service, version, instanceId}` |
| GET | `/api/me` | Any valid token | Identity, instanceId, pause state |
| GET | `/api/agents` | Any valid token | `{items}`; agents see only their project |
| POST | `/api/agents` | Admin | `{name,project?,provider?,model?,capabilities?}` → metadata and one-time token |
| PATCH | `/api/agents/:name` | Admin | `{enabled: boolean}` |
| POST | `/api/pause` | Admin | `{paused: boolean}` |
| POST | `/api/heartbeat` | Agent | `{sessionId: UUID,host?: string,connected?: boolean}` |
| POST | `/api/messages` | Any valid token | Message input; admin additionally requires project |
| GET | `/api/inbox?after=0&limit=50` | Agent | `{items,nextCursor}`; records delivery |
| GET | `/api/messages/:uuid` | Participant or admin | Message row and status |
| POST | `/api/messages/:uuid/ack` | Recipient | No body required; records acknowledgement |
| GET | `/api/conversations/:uuid?after=0&limit=50` | Participant or admin | `{items,nextCursor}`; does not record delivery |
| GET | `/api/dashboard?limit=50&project=NAME&before=SEQ` | Admin | Agents, newest messages, latest 50 events, pause state, total count, nextBefore |

All API responses are `Cache-Control: no-store`. The UI and CSS/JS are served without authentication; their data requests require the administrator token. No filesystem browsing is exposed.

## Agent registration

Names and projects: lowercase letters/digits/underscore/hyphen, begin with a letter or digit, up to 64 characters. Names are globally unique in one hub. Default project: `default`. Provider and model are optional descriptive strings, not verified model identities.

## Message input

```json
{
  "to": "builder",
  "body": "Can you review this proposal?",
  "kind": "question",
  "idempotencyKey": "review-proposal-001"
}
```

`kind` defaults to `message`. Body must be nonblank, at most 16,000 characters after trimming. Idempotency key: 1–100 characters. A raw reply adds `replyTo` and sends to the original sender. Reply recipients must match the original participants; a reply can target `@human` only when the parent came from `@human`. Unknown fields, including sender or agent-supplied project, are rejected.

Admin input includes `project`; sender is always `@human`. Admin cannot acknowledge messages addressed to an AI agent, though it can inspect them.

## Message output

```json
{
  "seq": 1,
  "id": "GENERATED_UUID",
  "conversation_id": "GENERATED_UUID",
  "project": "my-project",
  "sender": "planner",
  "recipient": "builder",
  "body": "Can you review this proposal?",
  "kind": "question",
  "idempotency_key": "review-proposal-001",
  "reply_to": null,
  "created_at": "ISO_8601_TIMESTAMP",
  "delivered_at": null,
  "acknowledged_at": null,
  "status": "queued"
}
```

Status precedence: `answered` if a reply exists; otherwise `acknowledged`, `delivered`, or `queued` based on timestamps. Answered does not mean reviewed, implemented, tested, or approved.

Inbox pages are ascending by global sequence, filtered to recipient/project. `nextCursor` is the final returned sequence, or the input cursor for an empty page. Persist it after handling the page. `limit` is 1–100; `after` is a nonnegative integer. Dashboard pages are descending; pass `nextBefore` as `before` to load older messages. Counts cover the whole hub even with a project filter. Events are the latest hub-wide events.

## MCP tools

`list_agents`, `send_message`, `read_inbox`, `ack_message`, `reply_message`, `get_conversation`, `get_message_status`.

The tool names and schemas are available through MCP discovery. `reply_message` accepts `{messageId,body,idempotencyKey}` and derives the target from the original. `send_message` accepts the message input without replyTo. The adapter returns one JSON text content block. Tool failures return `isError: true`; malformed schema arguments may be rejected by the SDK before dispatch.

Machine-readable input schemas are in docs/contracts.json. Schemas define camelCase request fields; stored response rows use the field names shown above.
