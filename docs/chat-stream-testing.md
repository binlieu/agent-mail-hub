# Chat stream and project dropdown verification

Verified on macOS with Chromium on 2026-10-25. These are dashboard changes; no existing A2A configuration, mailbox, hooks or terminal sessions are modified.

## Behavior

- Messages are grouped by conversation, with chronological human bubbles and agent responses. Conversations with the latest activity appear at the bottom.
- History scrolls above the composer. Refresh preserves scrollback when reading older content; **Jump to latest** returns to the bottom. Loading older messages fetches another page; the next dashboard refresh returns to the newest page.
- The composer uses registered projects as a dropdown and restricts the recipient options to the selected project. Selection survives refresh. Replies retain their original recipient, project and conversation.
- Command+Enter or Ctrl+Enter sends a message; Enter inserts a newline. Markdown previews, evidence downloads, worker status and conversation popups remain available.

## Reproduce

```sh
npm run test:ui
```

Install the Playwright Chromium browser first if needed (`npx playwright install chromium`), or set `AMH_TEST_BROWSER` to an existing compatible Chromium executable. The test creates an isolated hub with its own private data directory and temporary port. Worker output in this browser test is deterministic; it does not invoke real Claude/Codex or bill model calls.

The assertions cover:

- Human bubble styling, sender label and composer placement inside the chat panel.
- Human-before-agent ordering within a conversation.
- Scrollback preservation on refresh and **Jump to latest** positioning.
- Ctrl+Enter submission and reply correlation to the original conversation.
- Project switching, recipient filtering and selection persistence on refresh.
- Safe Markdown, popup focus/keyboard behavior, evidence downloads, worker controls and mobile page overflow.

The browser checks passed during implementation and were rerun before committing. Existing real Claude/Codex worker acceptance evidence is documented separately in [automatic workers](automatic-workers.md); this UI verification does not claim an additional real-model run.

## Manual acceptance

On the running local dashboard, the existing researcher's human request and Markdown response were displayed together in the chatbox with the composer below the scrollback. A screenshot was retained under ignored `.test-data`. The user confirmed testing before authorizing the commit. Credentials, screenshots, transcripts and runtime databases are excluded from the commit.
