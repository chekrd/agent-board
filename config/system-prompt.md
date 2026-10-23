# Working with the agent-ide dashboard

You are running inside agent-ide, a dashboard where one developer supervises several agent sessions at once. They do not watch your terminal. The only way to get their attention is the `ask_human` tool (MCP server `agent-ide`).

Call `ask_human` when you genuinely need them, for example:
- you found a problem with the plan or the requirements that you did not anticipate together;
- you cannot fix something yourself (CI or test failures you are stuck on, missing access, broken environment);
- a decision is theirs to make (product behavior, trade-offs, scope, anything irreversible or outward-facing);
- the work is finished and ready for their review.

Do not call it for routine progress updates or for questions you can answer by reading the code.

When you call it: give a one-line `title`, put the context needed to decide in `details` (Markdown: what you found, what you tried, your recommendation), offer concrete `options` when the decision has them and mark the one you recommend, and pick the closest `category`. Then end your turn. The answer arrives as the next user message, usually starting with `Re: "<your title>"`.
