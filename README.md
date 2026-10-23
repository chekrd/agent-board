# Agent IDE

A local dashboard for running many Claude Code sessions in git worktrees. macOS only.

- **Repos**: add a repository, or a folder to scan for repositories and worktrees (up to 5 levels deep, rescanned every 30 s). Removing a repo hides it from later scans.
- **Worktrees**: create one on a new branch from the base branch (`master` → `main` → `origin/HEAD`, overridable per repo), remove them. Each worktree lists its Claude Code conversations from `~/.claude/projects`: **Continue** resumes one in tmux; **Take over** ends a conversation that is open in another terminal (SIGTERM, Claude saves first) and continues it here.
- **Sessions live in tmux** (socket `agent-ide`, config `server/tmux.conf`), so they survive server restarts and you can take any of them over in Ghostty (`Open in Ghostty`, or `tmux -L agent-ide attach -t <name>`). The web UI attaches to the same session.
- **Diff**: one patch per worktree against the merge-base with the base branch, including committed, staged, unstaged and untracked changes. Your index is never touched.
- **Attention is contextual**: each Claude session gets an `ask_human` MCP tool and a system prompt (`config/system-prompt.md`). When Claude needs you, its tile shows the question, options and a reply box; your answer is typed into the session as the next prompt.
- **Priority**: open questions are ranked by `claude -p --model sonnet` using `config/priority-rubric.md`. Edit the rubric to change the ordering.

## Run

```sh
pnpm install
pnpm build              # UI → web/dist
pnpm service:install    # launchd agent: starts at login, restarts on crash
pnpm open               # Brave --app window on http://127.0.0.1:7420
```

Code changes never restart the server on their own. After pulling or editing server code, run `pnpm build` (UI) and `pnpm service:restart` when no agent is mid-answer; tmux sessions keep running either way. Re-run `pnpm service:install` after switching Node versions, since the agent pins the current `node` path.

Development: `pnpm start` runs the server in the foreground (stop the launchd agent first with `pnpm service:uninstall`), `pnpm dev` serves the UI with HMR on :5173, `pnpm check` typechecks and lints.

State lives in `~/Library/Application Support/agent-ide/` (`state.db`, per-session hook/MCP config, `server.log`).

## Notes

- Brand-new folders trigger Claude's "trust this folder" prompt once; answer it in the terminal.
- The terminal uses ghostty-web; set `localStorage['terminal-engine'] = 'xterm'` in the app window to switch to xterm.js.
