# Agent IDE

A local dashboard for running many Claude Code sessions in git worktrees. macOS only.

- **Repos**: add a repository, or a folder to scan for repositories and worktrees (up to 5 levels deep, rescanned every 30 s). Removing a repo hides it from later scans.
- **Sessions run in Ghostty**, in tabs of your front Ghostty window. The app has no terminal of its own: every interactive Claude Code process in a tracked repo shows up as a tile, whether you started it by hand or from the app. It finds them through `~/.claude/sessions/<pid>.json`, which also carries Claude's live status (working, your turn, waiting for a permission prompt), and maps each one to its Ghostty tab by tty. **Focus** switches to that tab through Ghostty's AppleScript; answers and messages are typed into it the same way.
- **Worktrees**: created and removed by [`scripts/git-wt`](scripts/git-wt), also usable as `git wt` once linked into `PATH` (`ln -s $PWD/scripts/git-wt ~/.local/bin/`). A task's worktrees sit at `<repo's parent>/worktrees/<task>/<repo folder>` (root overridable per repo), so one task name can span sibling repos and `../<sibling>` paths keep working. A new branch starts from `origin/<branch>` if it exists, else the base branch (`master` → `main` → `origin/HEAD`, overridable per repo); files matched by the main checkout's `.worktreeinclude` are copied in. Each worktree lists its Claude Code conversations from `~/.claude/projects`: **New Claude** and **Continue** open a Ghostty tab running `claude` (the setup command runs first in a new worktree); **Focus** switches to a running one.
- **Diff**: one patch per worktree against the merge-base with the base branch, including committed, staged, unstaged and untracked changes. Your index is never touched.
- **Attention is contextual**: `pnpm claude:connect` registers the `ask_human` MCP server at user scope (`http://127.0.0.1:7420/mcp`) and allows the tool in `~/.claude/settings.json`, so every Claude session has it (running ones after a restart or `/mcp` reconnect). The app reads the call from the session transcript; the tile shows the question, options and a reply box, and your answer is typed into the Ghostty tab as the next prompt. Idle tiles show Claude's last message. `pnpm claude:disconnect` undoes the registration.
- **Priority**: open questions are ranked by `claude -p --model sonnet` using `config/priority-rubric.md`. Edit the rubric to change the ordering.
- **Task summary**: after each Claude response (when the session stops working), `claude -p --model sonnet` without tools rewrites a 2 to 4 sentence summary of the task from the previous summary and the turns since. It shows on the tile and at the top of Details.
- **Reply box**: Enter sends (Shift+Enter is a newline in the detail view). Text starting with `/` or `!` is typed into the session as is, so slash commands and skills work and an open question stays open; typing `/` suggests your built-in, user, project and plugin commands and skills (Tab or Enter completes).
- **Delete worktree** (tile menu, not for the main checkout): quits every Claude running in the worktree, closes the Ghostty terminals in it, then removes it with `git wt rm --force` and deletes its local branch, except the base branch and long-lived ones (`master`, `main`, `develop`, `trunk`, `release/*`). **Remove** in the Repos dialog does the same, but keeps the branch unless asked and refuses a worktree with changes unless Force is ticked. Both refuse when another worktree sits inside this one.
- **Second opinion**: each open question also goes to a fresh `claude -p --model opus` with your settings, plugins and MCP servers, without the session's conversation. It reads the worktree in place. Only when it wants to change code or run something that writes does it call its `scratch_copy` tool (a per-run MCP endpoint); the IDE then makes a detached git worktree filled with APFS clones of every file (uncommitted changes, dependencies and build output included) and deletes it when the run ends. Its Edit, Write and NotebookEdit tools are blocked in the original worktree, as are `git push` and `ask_human`; Bash is only asked to stay out of it, and runs under your own permission rules. While it runs the tile shows a spinner, the elapsed time, its current step and a Stop button. Then it shows its chosen option, a ready-to-send reply, a confidence score and its reasoning; **Accept & send** answers the session with it, **Edit** copies it into the reply box.
- **PR to green**: when a session uses the `pr-to-green` skill, its tile shows the PR (linked) and the last result of `watch-pr.sh`: checks running, green, failed (or fixing while the session works on it), merged. The dot pulses while the watcher runs.

## Run

```sh
pnpm install
pnpm build              # UI → web/dist
pnpm service:install    # launchd agent: starts at login, restarts on crash
pnpm claude:connect     # ask_human MCP server for all Claude sessions
pnpm open               # Brave --app window on http://127.0.0.1:7420
```

Code changes never restart the server on their own. After pulling or editing server code, run `pnpm build` (UI) and `pnpm service:restart`; Claude sessions in Ghostty keep running either way. Re-run `pnpm service:install` after switching Node versions, since the agent pins the current `node` path.

Development: `pnpm start` runs the server in the foreground (stop the launchd agent first with `pnpm service:uninstall`), `pnpm dev` serves the UI with HMR on :5173, `pnpm check` typechecks and lints.

State lives in `~/Library/Application Support/agent-ide/` (`state.db`, per-session hook/MCP config, `server.log`).

## Notes

- Needs Ghostty 1.3+ (AppleScript) and macOS Automation permission for the server to control Ghostty; no screen recording.
- Brand-new folders trigger Claude's "trust this folder" prompt once; answer it in the Ghostty tab.
- A Claude running in another terminal app or inside tmux still shows up, but Focus and answering need it to be the foreground process of a Ghostty tab.
- Light/dark follows the system.
