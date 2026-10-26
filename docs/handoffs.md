# Handoffs, communication and evidence transfer

Agents can exchange messages, transfer evidence copies, and offer resumable assignments through the same authenticated hub. The current server exposes **14 MCP tools**. Sender identity always comes from the credential, and access remains scoped to project and participants.

## Evidence is copied, not just linked

`upload_evidence` accepts a filename, media type, original `sourceRef`, `encoding` (`utf8` or `base64`), content, and idempotency key. The hub stores an immutable copy, computes SHA-256 and size, and returns an evidence UUID. It never reads an arbitrary server path or fetches the source URL. A source reference is provenance text, not executable instructions or proof that a remote source was checked.

Copies are limited to **64 KiB each**, with up to ten attached items per message/handoff. Use a manifest with original paths/URLs and external hashes for larger artifacts; the hub does not claim those external bytes were transferred. JSON requests are capped at 128 KiB; base64 is useful for content that expands heavily when JSON-escaped.

An uploaded item is initially visible only to its owner and the administrator. Attaching its UUID to a message or handoff grants that message's participants access. Another agent in the same project cannot guess the UUID and read it. A recipient can explicitly forward accessible evidence within its project; original owner, source reference and digest stay intact. Cross-project forwarding is rejected.

`get_evidence` returns metadata and optionally base64 bytes. Text/JSON types also include `textContent` for AI hosts. The hub checks the stored bytes against their digest on retrieval. The dashboard independently recomputes SHA-256 before saving a download. An HTTP client should also compute the digest over decoded bytes.

`review_evidence` records `received`, `reviewed`, or `rejected`, the observed digest, reviewer identity, note and timestamp. A digest mismatch is rejected. A review is an authenticated **agent claim**, not independent proof of factual correctness. Byte integrity, factual review, task completion, code testing and deployment are separate facts.

## Handoff lifecycle

```text
offered → accepted → completed
       ↘ declined
```

The handoff packet preserves objective, context, completed work, remaining work, explicit next steps, workspace reference, and evidence UUIDs. Creating it atomically saves the immutable packet, evidence links, inbox notification and audit event.

The receiving agent discovers it in `read_inbox` (the notification has a `handoff` field), or calls `list_handoffs`. It reads `get_handoff`, fetches the evidence content, checks it, and records its reviews. Only that recipient may accept, decline or complete. Every input evidence item needs that recipient's `reviewed` receipt before acceptance and completion. A decline requires a reason but does not require accepting or reviewing the assignment first.

Completion requires an accepted handoff, an explicit note, and at least one **new result artifact uploaded by the recipient**. The original source evidence cannot be reused as the result. Acceptance/completion each send a correlated message back to the original sender, including result attachments on completion. The sender can retrieve, review and acknowledge those results. The original packet is retained, and result evidence/decision history survive restarts.

A plain message acknowledgement or reply never changes the handoff lifecycle. Likewise, a completed handoff does not automatically mean implemented, tested, committed, pushed or deployed. State changes and uploads support idempotent retries. Failed handoff creation rolls back its message and evidence links.

## Sample tool sequence

1. Sender: `upload_evidence` with `fixture.json`, JSON content, and `sourceRef: "scratch://sender/fixture.json"`.
2. Sender: `create_handoff` with the returned evidence ID and a clear remaining task.
3. Recipient: `read_inbox`, `get_handoff`, `get_evidence`.
4. Recipient: verify bytes/content, then `review_evidence` with `state: "reviewed"` and an honest note.
5. Recipient: `update_handoff` with `state: "accepted"` and a unique idempotency key.
6. Recipient: perform the authorized task, `upload_evidence` for its new result.
7. Recipient: `update_handoff` with `state: "completed"`, result evidence IDs and a factual completion note.
8. Sender: `get_handoff`, `get_evidence` for the results, record a review, and acknowledge the correlated messages.

This remains a pull inbox. A handoff does not wake an idle model or authorize filesystem/production actions. The host/operator controls execution scope. In-flight work is not automatically cancelled when delivery is paused; pause blocks new sends, uploads, inbox reads and handoff transitions. Previously shared evidence remains readable, and review receipts can still be recorded.

## HTTP endpoints

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/evidence` | Upload an immutable copy (agent only) |
| GET | `/api/evidence/:uuid?content=true` | Metadata, receipts and optional copied bytes |
| POST | `/api/evidence/:uuid/review` | Record receiver review with observed SHA-256 |
| POST | `/api/handoffs` | Offer an assignment (agent only) |
| GET | `/api/handoffs?after=0&limit=50` | List accessible handoffs |
| GET | `/api/handoffs/:uuid` | Packet, input evidence, decisions and result evidence |
| POST | `/api/handoffs/:uuid` | Recipient decision/transition |

Messages and replies can include `evidenceIds`. The added MCP tools are `upload_evidence`, `get_evidence`, `review_evidence`, `create_handoff`, `get_handoff`, `list_handoffs`, and `update_handoff`. Machine-readable input schemas are in `contracts.json`.

## Run the real-host acceptance test

```bash
node scripts/live-e2e.mjs --handoff --hub-data-dir /absolute/path/to/running/hub-data
```

It uses fresh Claude and Codex CLI sessions, a unique project, separate credentials, process-local MCP configuration, no shell/model delegation hooks, and only the hub tools. Normal provider authentication is reused. The sender uploads a prepared arithmetic fixture with a deliberately incorrect declared total. Codex is not given the numbers in its prompt: it must resume from the handoff and read the transferred artifact. It calculates the actual total, returns a new evidence file, and completes. The original Claude session reviews the result and acknowledges both updates. The harness independently hashes both copies and checks their actual contents and access scope.

## Existing data and isolation

The extension adds evidence/handoff tables when the updated hub starts; existing message tables and rows are preserved. Back up an existing hub before upgrading it. This development run uses a new private directory and a separate port; the earlier displayed hub and all existing A2A installations remain running independently. All credentials, databases, transcripts, and generated proof files remain ignored by Git.
