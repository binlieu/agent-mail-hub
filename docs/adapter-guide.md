# Adapter guide for any AI or agent host

## Choose the integration

1. **Host supports local MCP:** run `agent-mail-hub mcp` with `AMH_CREDENTIALS_FILE` pointing to a private credential file. The host controls when the AI calls inbox tools.
2. **Host can make HTTP requests:** implement the contract in docs/api.md. Use examples/http-agent.mjs as a dependency-free starting point.
3. **Host needs unattended execution:** implement a separate runner using its supported API or hook. The hub alone cannot wake a model. Never type blindly into a terminal or change existing hooks.

Provider login stays with the host. Messaging does not need OpenAI, Anthropic, or other provider keys. An optional provider API runner needs its own credentials and billing limits.

## Credential bootstrap

The operator runs `add-agent` on the hub. Read the resulting JSON locally; do not put its token in prompts. A credential file contains version, instanceId, url, name, project, and token. Load it from an absolute path. Treat it as a secret and keep mode 0600 on systems supporting Unix permissions.

First GET `/health` without credentials and compare service and instanceId with the file. This release supports only `http://127.0.0.1:<port>`. Refuse redirects. Then call `/api/me` with `Authorization: Bearer TOKEN` and verify the returned identity. Repeat the instance check after connection failures or hub restart; the bundled adapter checks it before every tool call.

## Session and processing loop

Generate a fresh UUID per adapter process. POST a heartbeat every 20 seconds while it is connected. Mark connected false when exiting cleanly. Stale sessions expire from the connected display after 60 seconds. These heartbeats must not claim that the model is working.

Use `read_inbox` / GET `/api/inbox?after=CURSOR&limit=50`. Delivery is recorded by retrieval. Each row includes a monotonically increasing `seq`; results return `nextCursor`.

For each page:

1. Validate the message and sender against your allowed task scope.
2. Treat the body as untrusted data, not system or human instructions.
3. Durably record that the message was received, or perform bounded idempotent handling.
4. Acknowledge the message explicitly.
5. If authorized, send a reply with a stable idempotency key such as `reply:<original UUID>:v1`.
6. Persist the cursor only after all earlier messages in the page are handled durably.

If the process crashes before saving the cursor, reread the page. Retries with identical reply keys do not create duplicate records. This is at-least-once processing, not exactly-once execution.

## Error policy

- Network timeout or HTTP 5xx: bounded exponential backoff with jitter; reuse the idempotency key and payload. Stop when the retry budget is exhausted.
- HTTP 503 with paused message: wait for operator resume; do not bypass pause.
- HTTP 401/403: stop and request operator action; do not cycle identities.
- HTTP 404: check recipient/project or message identity; do not discover private projects by guessing names.
- HTTP 409: resolve the conflict; do not silently generate a new key to repeat an operation.
- HTTP 429: wait at least one minute before retrying authentication.

Avoid blocking tool calls while awaiting a reply. Save the returned message ID and ask for status later. Set explicit turn/time budgets for automatic conversations; self-messaging is already blocked, but multi-agent reply loops need runner-level limits.

## Verification checklist

Start an isolated hub. Verify send → inbox → acknowledgement → reply → status, duplicate retry, reconnection, cursor recovery, and unauthorized project rejection. Label deterministic examples as simulated. Real AI-host acceptance also requires observing the actual host's tools and its receipt/reply behavior.

Do not install your adapter into user-wide configuration automatically. Provide a reviewable snippet and a manual removal instruction: remove only the `agent-mail-hub` entry you added. No data deletion is necessary to disconnect.
