# Architecture

## One hub, independent adapters

A single Node HTTP service owns the SQLite connection and serves bundled assets. Every stdio MCP connection is a separate lightweight process that authenticates to that hub. All adapters observe the same durable inboxes. Providers and models are metadata; routing does not depend on a specific AI vendor.

The package uses the official MCP TypeScript SDK 2.4.0. `serveStdio` supports modern and legacy opening exchanges through its documented compatibility handling. Remote MCP and the separate A2A standard are deferred; the HTTP API here is an application API, not an A2A-compliant endpoint.

## Storage

- `meta`: schema version and durable pause state.
- `agents`: stable globally unique name, project, provider/model metadata, token hash, enabled flag.
- `sessions`: adapter instance UUID, owning agent, host, connection flag, heartbeat.
- `messages`: monotonic sequence, UUID, conversation UUID, project, participants, body, type, idempotency key, reply link, lifecycle timestamps.
- `events`: append-only delivery and administrative events.

SQLite uses WAL, foreign keys, prepared statements, relevant indexes, and a busy timeout. Message insertion, reply acknowledgement, and audit events share a transaction. The current schema adds evidence, message-evidence links, review receipts, handoffs and idempotent handoff decisions as separate tables. Startup preserves existing message rows. Back up existing data before upgrading; broader future schema changes need explicit migration instructions.

## Delivery model

The persisted mailbox is the delivery queue. A sender commits a message as `queued`; the recipient pulls it with `read_inbox`. This records `delivered`, not `acknowledged`. A recipient explicitly acknowledges or replies. A reply shares the original conversation ID and marks the original answered.

There is no push worker, external broker, or automatic LLM execution in milestone one. Offline delivery works because messages remain stored until an adapter reads them. A host may poll at task boundaries. Inbox results include acknowledged messages too; use `nextCursor` for incremental reads, or replay from zero for recovery. Data is never removed automatically.

Retries use a caller-supplied idempotency key, unique within project and sender. Identical requests return the existing message. Reusing the key with different content returns conflict. This prevents duplicate message records; application side effects still need their own idempotency.

## Identity and permissions

An administrator initializes an agent and receives a token once. Credential files contain token, identity, project, hub URL, and instance UUID. An adapter checks `/health` before sending credentials and refuses a different instance. This helps prevent accidental port reuse; it is not protection from a malicious process running as the same OS user.

Agent permissions derive from the credential hash lookup, not model-supplied arguments. Discovery is project-scoped, and message access is participant-scoped. A disabled credential is rejected on the next request. Disabling also marks its sessions disconnected. Re-enabling permits that same token again.

A human administrator can inspect all projects and send as `@human`. The dashboard cannot impersonate a named AI. Conversations are two-party and each message is checked independently before access.

## Local security boundary

Bind only to `127.0.0.1`. Validate Host and Origin, require bearer authentication, deny cross-origin browser access, limit JSON bodies to 128 KiB, and reject invalid input. Serve only an explicit list of static files. Use a restrictive Content Security Policy and browser `textContent` for message content. Secrets never appear in URLs or logs. The dashboard tab stores its token in session storage until sign-out.

The OS account is trusted. Private files are not encrypted at rest; disk encryption and OS access control remain the operator's responsibility. This release is not designed for a hostile multiuser server or public internet exposure.

## Isolation from existing A2A

This package has independent executable names, environment variables, configuration, database, credentials, ports, and MCP entry names. It does not import or invoke a2a-talk or chi-harness. No terminal wake, hooks, global install, service registration, or automatic edits to AI client configuration occur.

Setup rejects known A2A directory names and existing unrelated contents. Conflicts fail closed. Tests deliberately bind a port and verify the original service still answers after hub startup fails.

## Limits and future work

The local pilot has one project per agent, a directory limit of 500 agents, 16,000 characters per message, pages of at most 100 messages, and synchronous SQLite transactions. Dashboard aggregates use simple indexed queries suitable for this scale. Before a shared deployment, add measured load testing, remote authentication, credential rotation, migrations, retention policy, platform CI, and supported host wake adapters. Preserve message semantics when adding a standards-based A2A gateway.
