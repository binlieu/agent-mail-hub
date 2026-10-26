# Connect an MCP-capable client

Use the output of `agent-mail-hub config --credentials /absolute/path/planner.json`. It prints your actual executable and CLI paths. Below are templates, not automatically installed configuration.

## JSON-style host configuration

Merge only this server entry alongside existing entries:

```json
{
  "mcpServers": {
    "agent-mail-hub": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/agent-mail-hub/dist/cli.js", "mcp"],
      "env": {
        "AMH_CREDENTIALS_FILE": "/absolute/private/path/planner.json"
      }
    }
  }
}
```

Use a different credential file in the other AI session. Generic JSON configuration is used by several hosts, but check the current host's configuration format and per-session/project scope before merging. Existing `a2a-talk` or `chi-harness` entries remain as they are.

## TOML-style host configuration

The same connection parameters expressed as TOML:

```toml
[mcp_servers.agent-mail-hub]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/agent-mail-hub/dist/cli.js", "mcp"]

[mcp_servers.agent-mail-hub.env]
AMH_CREDENTIALS_FILE = "/absolute/private/path/planner.json"
```

A separate isolated live run verified these connection parameters with Claude Code 2.1.304 and Codex CLI 0.163.0. No user-wide configuration was installed. See docs/live-e2e.md and scripts/live-e2e.mjs for the exact process-local flags. Other host versions can have additional approval requirements or configuration conventions.

## Verify

1. Keep the hub running.
2. Start a new isolated AI session with the appropriate server entry.
3. Check that the host exposes the seven Agent Mail Hub tools.
4. Run `list_agents` and compare identities/projects with the dashboard.
5. Follow README.md's three live-test prompts.
6. Use `doctor --credentials ...` if connection fails.

To disconnect, remove only your new server entry and close its test session. No mailbox or configuration deletion is necessary.

## Noninteractive Codex approval

The verified live test uses `--ignore-user-config`, `--ephemeral`, a read-only sandbox, and only this hub's MCP configuration. With approval policy `never`, unapproved MCP calls are rejected. For an explicitly authorized test, the harness sets `approval_mode = "approve"` individually for the seven allowed hub tools using command-line configuration overrides. These approvals apply only to that process. `auto` did not permit the calls in the tested CLI. Do not change global approval settings or use a sandbox bypass to resolve this.
