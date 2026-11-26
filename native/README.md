# Native apps

The SwiftUI Mac app uses a bundled Node.js service for SQLite, local agents and MCP. The iPhone and iPad app communicates with the Mac through a private iCloud database.

The [project README](../README.md) has the build and test commands. For development, an ad hoc Mac build and a separate local profile let you try OpenTalon without opening an existing workspace. A device build that uses iCloud needs a CloudKit container and provisioning under your own Apple Developer team.

The Mac applies queued mobile changes while OpenTalon is running. Agent requests need a supported agent installed and configured on the Mac. See the [agent task guide](../docs/SEND-TO-AGENT.md) for the workflow and the [backup guide](../docs/BACKUPS.md) for keeping your data.

## Plans and Apple Intelligence

Each task has a **Plan** section after Notes and Definition of Done. Open it to preview Markdown, edit the source, or import/export a UTF-8 `.md` file. New tasks can include a plan. Plans stay with their task through project changes, Archive, Trash, restore and full backups, and are included when sending the task to an agent.

In a task’s **Files** section, choose **Add file** to attach a spreadsheet, PDF, image or other regular file up to 10 MB. Video files are excluded. On Mac, click an attachment to open it in its associated app. On iPhone and iPad, tap to preview supported files or share the original to Files or another app. OpenTalon syncs attachment bytes through the same private iCloud workspace. An attachment added on mobile is queued locally until the Mac processes it. Previously downloaded files can open offline. Full SQLite and JSON backups include the originals.

Local MCP clients can attach bytes with `attach_task_file` and verify the result with `list_task_files`. The attach call accepts the task UUID, basename, MIME type, canonical base64 and an idempotent request key. The result contains the filename, byte count and SHA-256 digest.

On supported devices with Apple Intelligence enabled, **Proofread** and **Revise plan** generate a proposed revision. Review it, choose **Apply to draft**, then **Save**. Cancel preserves the saved plan; interrupted editing keeps a local draft. A conflicting edit from another device is rejected without overwriting it. Manual editing remains available when the on-device model is unavailable.

On iPhone and iPad, the sparkle button opens **Ask OpenTalon**. Ask about tasks, create a task or project, change a task's fields, or propose a plan revision. Ordinary edits save locally and queue for the Mac. Sending to an agent opens the agent/model/comment dialog; Archive and Trash keep their confirmation flows. Chat history is local, with new chats, individual deletion and delete-all controls. Deleting chat history does not delete tasks or plans. Both devices need the updated app for plan synchronization. Apple Intelligence requires supported hardware and OS version 26 or later; no remote model is used as a fallback.


## Issue types and revision history

Tasks can be **Issue** or **Bug**. Bug labels appear on cards and details, and the type is included in the agent handoff. Creating a Bug does not send it to an agent automatically.

**View revision history** in task details shows saved changes to fields, project, status, order and the Markdown plan. Preview a revision before restoring it. A restore creates a new entry and retains newer history and current comments. It stops active agent work and reopens archived tasks; a saved Sent to agent status restores as To do. Restore a trashed task before restoring its fields. Existing tasks start with a migration baseline; edits made before this update cannot be reconstructed.

History is stored in the Mac's SQLite database and both full backup formats. Mobile syncs the newest revision and can request older pages from the Mac. Cached revisions remain readable offline; older pages and acknowledged restores require the Mac to be online. History is removed only when its task is permanently deleted or the workspace is replaced from a backup.

## Task Activity and user Comments

Task details separate **Activity** from **Comments** on Mac, iPhone and iPad. Activity automatically records task edits, moves, ordering, Archive/Trash actions, agent pickup and progress. Open **View all activity** for the timeline, expandable details and older entries. **View revision history** remains available for previewing and restoring saved task content.

Comments are only messages explicitly entered by the user. Agents use `add_task_activity` for updates and `report_agent_progress` for completion proof. Existing `add_task_comment` clients are redirected to Activity. Known older agent reports and screenshots are migrated to Activity; older messages without reliable authorship are preserved there as earlier messages. Activity and screenshots survive JSON and SQLite backups. Both the Mac and mobile app need this update for Activity synchronization.

The task’s main view keeps Activity collapsed behind **View activity**. Only user comments appear inline. **Acted on · View activity** opens the response and recorded task changes associated with that comment, without unrelated runs. Pickup alone is not treated as acted on. Older snapshots without reliable authorship keep their mixed messages behind **View earlier activity**. Comments explicitly written on this phone remain visible after acknowledgement from an older Mac. Update both apps for linked comment activity.

Saved plans appear as task-ID `.md` documents in **Plan**, with one-click Preview and Markdown editing. Version 1.0.20 recovers the latest complete legacy plan block copied into Notes when Plan is empty. Source notes and previous revisions are preserved; existing Plan documents are never replaced.

## First launch on iPhone and iPad

New installs show a short introduction to task boards, plans and agents, followed by Mac setup: install OpenTalon on an Apple silicon Mac with macOS 14 or later, use the same Apple Account with iCloud Drive, and keep the Mac app open. Agent setup is optional. The guide can be skipped and reopened from **Settings → Support → Getting started**. Existing installations with a saved workspace continue directly to their tasks.

Before the first Mac sync, **Get started** provides the Mac download, setup guide, sync status and a **Save an idea** editor. One starter idea is stored on that device and survives relaunch. After the Mac connects, **Create task** opens the normal task editor with that idea prefilled. Cancel keeps the idea; successfully queueing the task clears it. Saving the idea alone does not create a project, sync it or dispatch an agent.

## Large task lists

Dashboard filters and board columns start with six tasks and load the next six automatically when the loaded end approaches the scroll viewport. Counts, filtering and ordering still use the complete task collection. Search can find tasks outside the loaded batch, and dragging can reveal the next row while scrolling.

Task timestamps are parsed without constructing date formatters during sort comparisons. The local service scans only newly received bytes when framing a large workspace response, so partial responses do not repeatedly rescan the entire growing buffer.

## Mac folder access

The Developer ID app and bundled helper retain their signing identities across updates. macOS still controls consent for Documents, Desktop, Downloads, external drives and network volumes; signing or notarization does not grant access to those locations. The app includes purpose text explaining the selected task files, working folder and backups.

The local service and backup helper run from the app's private workspace rather than inheriting the directory that launched OpenTalon. Codex project reuse compares saved paths with the selected folder and its resolved path without resolving unrelated project roots. A legacy direct folder alias inside the selected workspace is still recognized. Selecting a folder does not authorize scanning other projects. Broader Full Disk Access is not required as a default setup step.

## Global and project agent folders

Choose the user's global **OpenTalon working folder** in **Settings → Task agent**. Projects use this folder by default. To give one project its own folder, open its project menu and choose **Agent folder…**. Choose an existing directory or create one in the standard folder picker, including on an external drive. **Use global folder** removes the override. Folders belong to projects, never individual tasks.

New task conversations use their project's effective folder for Claude Code and Codex, including work sent from iPhone or iPad. Ask my agent uses the selected project's folder, or the global folder when no project is selected. Task drafting uses an explicitly selected project folder when provided; automatic project classification uses the global folder. Task titles never determine filesystem paths. Temporary connector/schema/reply files are disposable and never become an agent's working directory.

New Codex task chats reuse the saved project rooted at the effective folder, named **OpenTalon** when first created. Canonical paths prevent a folder alias from creating another project. A new project is created only for an intentionally selected folder without an existing matching project. Queued runs and existing conversations keep their original folder when settings change or the task moves projects. Missing/unavailable folders require setup, without silently falling back to another folder. The mobile companion sends tasks to the Mac; it does not choose another local agent workspace. Project overrides survive restarts and backups. MCP clients can read `get_project_folder` with the board `id`, then call `set_project_folder` with `id`, the last-read `expectedRevision`, `workingFolder` and a fresh `requestKey`. An empty `workingFolder` restores global inheritance.

Live integration checks use the stable `tests/agent-live/OpenTalon` working folder across agents and runs. Only their private data profiles vary. Do not use `mkdtemp` directories as working folders for a real persistent agent client.


## Agent model catalog

The Mac owns the model list. In **Settings → Task agent → Manage models…**, edit display names or model IDs, add custom models, or hide choices. **Use current defaults** resets the selected agent. **Agent default** remains available and lets the provider choose its default model. Custom models require support from that provider and the user's account.

App updates ship refreshed defaults separately from saved overrides. New current models appear automatically, while custom models, names and hidden choices survive. Superseded unmodified defaults are removed; a model explicitly retained as an override stays available. Backups preserve overrides and the model selected on historical runs. Changing the catalog affects future sends, not running work.

Connected MCP clients can call `get_agent_models` to read `models`, `defaults`, `defaultsVersion`, `overrides` and `catalogRevision`. To edit, call `set_agent_models` with a fresh `requestKey`, the last-read `expectedCatalogRevision`, and the complete desired `overrides` array. Each entry has `agent` (`codex` or `claude-code`), `id`, `title`, and optional `hidden`. Preserve existing overrides when adding a new one. An empty array resets both agents to current shipped defaults. Conflicts require a fresh read; retrying the identical request uses the same request key.

iPhone and iPad receive the effective catalog through the existing Mac snapshot sync. The mobile app contains no model-name list, so catalog-only updates do not require a new mobile build. The Mac must be updated and running for its latest catalog to reach the phone. Models for uninstalled Mac agents are omitted from the send choices.

## Agent access

New agent setups start with **Automatic**. In **Settings → Task agent → Permissions**, users can save **Full access** as their preferred mode, or choose Manual. Subsequent Claude and Codex task dispatches, Ask my agent messages, and agent-assisted task drafts use that saved Mac preference until it changes, including requests originating on iPhone and iPad. Drafting still produces task text, and chat retains its app-focused tools. The choice survives updates, unrelated settings edits, restarts, and JSON/SQLite backup restore. Full access lets the agent work outside its working folder without per-action approval; it does not grant macOS Files and Folders consent or enable MCP by itself.

On iPhone and iPad, the trash button on a revision request, or a swipe on its row, withdraws it after confirmation. A request can be withdrawn until an agent has acted on it. One that has not left the device is removed at once. Otherwise the Mac removes it by the request’s own ID, including a request still in transit, and records the withdrawal in Activity. A follow-up turn started only for that request is canceled before delivery, or asked to stop if it had already begun. If the agent received the request together with other work, that run continues and is told to skip it. Work the agent already finished stays. Both the Mac and mobile app need this update to withdraw a request the Mac has received.
