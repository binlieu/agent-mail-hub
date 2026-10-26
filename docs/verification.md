# First milestone verification

Verified on **October 24, 2026 (America/Los_Angeles)**, macOS, Node.js 24.6.0, npm 11.5.1.

## Passed

- TypeScript build and strict type checking.
- Nine integration tests: durable delivery and restart recovery, explicit acknowledgement, reply correlation, repeated/concurrent idempotent sends, project and participant boundaries, credential identity and revocation, human replies, durable pause state, request validation, Host/Origin protection, bounded pagination, private setup and A2A-path refusal, occupied-port protection, modern and legacy MCP connections, wrong-instance refusal before credential transmission.
- Two separate official MCP client connections through separate stdio adapter subprocesses exercised all seven tools.
- Browser checks: sign-in, message/conversation display, literal rendering of hostile HTML, pause/resume, human send/reply, agent creation and credential download, disable/enable, mobile overflow, and sign-out. No page errors or console errors remained.
- Browser layout inspected at desktop and 390-pixel mobile widths. Screenshots are bundled beside this report.
- A separately installed npm archive started and completed the same MCP question/reply demonstration with production dependencies only.
- npm production-dependency audit reported zero known vulnerabilities at verification time.
- Restarted the displayed demo hub and retained its original messages and history.

## Displayed exchange

- Question: `89c7e91a-122c-4467-83fe-4747685d430b`
- Reply: `f6814602-dcc9-4686-9f12-4eb1fdf025f7`
- Conversation: `255bbc29-c15f-47b3-9287-a80c89cc7e45`
- Question status: `answered`
- Duplicate retry: returned the original question ID.

The exchange used **deterministic simulated agents over real MCP transports**, not live external AI models. Actual AI-host tool exposure, model behavior, and idle wake support are not claimed as verified. The README supplies a manual live-host acceptance test. There are no automatic model calls or wake integrations in this version.

## Isolation and release state

No existing A2A executables, mailboxes, sessions, hooks, global configuration, or agent registrations were changed. All development data is inside ignored workspace directories. No global package installation, npm publication, Git initialization, commit, push, or deployment was performed. The owner still controls testing acceptance and the commit signal.

## Follow-up: October 25 real-host verification

The original report above describes the October 24 simulated milestone. A subsequent [real Claude–Codex test](live-e2e.md) passed on October 25 using authenticated CLI sessions and isolated per-process MCP settings. Both real messages are visible in the live dashboard. No commit was made.
