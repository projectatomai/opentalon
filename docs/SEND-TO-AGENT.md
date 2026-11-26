# Send tasks to Claude Code, Codex or Gemini

All three agents are supported. The default selects where the next task goes; it does not disable the other agent or change runs already sent.

1. Open **OpenTalon → Settings → Task agent**.
2. Choose **Claude Code**, **Codex** or **Gemini** under **Default agent**. Claude Code is listed first and is the initial default.
3. Choose **Working folder → Choose folder…**. Pick where the agent should work. Use a dedicated folder for general tasks or the relevant project folder for project work.
4. Make sure the selected launcher is installed and signed in. Official guides: [Claude Code setup](https://code.claude.com/docs/en/quickstart), [Codex CLI setup](https://learn.chatgpt.com/docs/codex/cli). Installing only the desktop app may not install the Claude Code launcher. Follow the linked installation instructions, open the agent and sign in once. OpenTalon never requests a provider API key.
5. Enable **Agent connection** in Settings if it is off. Outgoing task runs receive this embedded MCP connection automatically; no separately running MCP server is needed.
6. Give a task a clear title, priority and notes describing the result you want. Add a **Definition of done** in task details when there are specific acceptance criteria. Drag it from **To do** to **Sent to agent**, or choose that status in the task panel.
7. OpenTalon saves a queue entry and starts a new conversation with the selected agent. One task runs at a time. The agent reads the task and reports progress through MCP. **In progress** remains a separate column. Before **Done**, the agent must submit a summary, concrete proof explaining its checks/results and how the definition of done was met, and `definitionOfDoneMet: true`. OpenTalon saves the completion report in Activity before changing status. Missing proof keeps the task open; a successful turn exit cannot complete it.
8. Open a card for its run status, result and any permission request. **Allow once** approves only the displayed action; **Decline** denies it. Existing rules and restrictions remain in force. For a question requiring the full app, stop the run, then use **Open conversation** to continue there.

Changing the default agent or folder affects new sends. Existing runs retain their original choice. Reordering a Sent card or moving it to another board does not create another conversation. Moving it to To do cancels queued work or stops its active process; already completed actions remain. To start over, review the existing conversation, stop any active run, then move the task to To do and back to Sent to agent.

OpenTalon continues when its board window closes. Quitting interrupts active work. On restart uncertain runs are marked for review rather than replayed; unstarted queue entries can proceed. Restoring a backup never auto-launches restored runs. Unavailable agents or connections leave the task and error visible.

## Gemini

Gemini is the third task agent. Choose it under **Default agent**, or per task in **Send to agent** on Mac, iPhone and iPad.

- **Launcher:** Google's Antigravity CLI, `agy` ([setup](https://antigravity.google/docs/getting-started?tab=cli)). OpenTalon looks for it in `~/.local/bin`, Homebrew and your `PATH`. The older npm `gemini` CLI is not used.
- **Sign-in:** run `agy` once in Terminal and sign in with Google. OpenTalon reuses that sign-in and never starts one itself. A signed-out CLI ends the run with a sign-in message. API-key and default-credential environment variables are not passed to it.
- **Models:** Gemini 4 Neon, Carbon, Argon and Hydrogen, plus Gemini 3.8 Flash. Google availability varies by plan. The Mac checks the signed-in CLI’s model list and puts its first supported model first in the picker. Until Google confirms the list, Flash works on all plans. A customized catalog retains its own order. Every task sends its named model. An explicit choice remains selected and an unavailable choice produces an error.
- **Access:** Automatic uses Antigravity's reviewed auto mode when it is offered and otherwise asks you. Manual sends every approval to the task card. Full access approves everything. Automatic and Manual keep Antigravity's terminal sandbox on.
- **Tools:** each task gets its OpenTalon connection. Session-only Antigravity rules deny access to other registered MCP tools during that run. Their registrations and saved permissions stay available to other sessions. A server already named `opentalon` with a conflicting registration must be renamed to avoid shadowing the task connection.
- **Continuing:** Resume agent reopens the same Gemini conversation. Gemini conversations do not open in another app, so there is no Open conversation button.
- **Ask my agent:** works with Gemini. Outside Full access, Gemini cannot be granted approvals in chat, so a request that needs one asks you to send it as a task.

## Connection details

MCP does not provide a generic command to start an arbitrary client's UI thread. OpenTalon uses each installed agent's first-party runtime to create a saved conversation and begin a turn; MCP provides task access and return updates. Claude Code uses its bidirectional streaming CLI and permission callbacks. Codex uses its app-server thread/turn protocol. Both reuse existing sign-in and the provider's network and usage allowance. The task database and queue stay local.

Claude's supported handoff (`claude --desktop --resume <session-id>`) requires the local session to have stopped; live progress appears in OpenTalon until then. Codex uses `codex://threads/<thread-id>` for the saved conversation. The app does not claim it can remotely click Send in an arbitrary connected client.

References: [Claude Code CLI](https://code.claude.com/docs/en/cli-reference), [Claude desktop](https://code.claude.com/docs/en/desktop), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex deep links](https://learn.chatgpt.com/docs/reference/commands).

## Comments and screenshots

1. Open an In progress task and scroll to Comments.
2. Write your feedback. Choose Attach screenshots, Paste screenshot, or paste a copied image into the comment field. Up to three images can accompany a comment.
3. Click Post comment. Saving is local and works offline.
4. For explicitly assigned agent tasks, the five-minute watcher queues feedback for the task’s existing agent/conversation while OpenTalon is running. Changing the default agent does not change this recipient. Use Check now for an immediate check. Busy runs wait until a subsequent check after their current turn finishes. Manual task comments stay local.
5. View the Sent/Queued/Waiting state in the comment. Click View screenshot, then its preview, to enlarge it.

MCP remains the task/progress interface; first-party resume/turn protocols wake the existing conversation and send actual image inputs. Assigned tasks without an agent conversation wait; manual comments do not queue. Quitting/sleep pauses processing. A failed or uncertain delivery requires reviewing the conversation before Queue again; this can repeat work if the earlier send was accepted but not acknowledged. Restored comments never send automatically. Agent reports are saved in Activity without creating user comments or waking another turn.


## Manual tasks and explicit agent assignment

New tasks have no agent assignment, including tasks created directly in In progress or Done. Moving a card between To do, In progress and Done is ordinary manual tracking. The default-agent setting applies only when you explicitly send a task through Sent to agent. Automatic pickup/progress reports preserve that opt-in; manually moving an agent task to another standard status clears its active assignment and stops its current run. Reordering inside the same column preserves the assignment. Historical runs remain available for reference.

Manual comments and screenshots stay local and do not wake an agent, even on an In progress task. The five-minute watcher requires a current explicit agent assignment and cannot infer one from old run history. Restoring a backup clears active assignments and requires another explicit send before any restored work runs.

## If the first drop does not have setup yet

The first drop opens **Set up and send to agent** when the working folder, selected launcher or local connection is missing. Your task stays in its original column. Select Claude Code or Codex, choose the working folder for the task, enable the local connection, then click **Send to agent**. The selected default and folder are saved for later drops. Cancel keeps the task unchanged. A missing launcher links to its setup guide. This dialog also handles creating a task directly in Sent to agent without leaving a partial task behind.
