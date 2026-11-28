# Learning mode

Learning mode records every AI chat, step by step, to JSONL files on your own computer. It exists to audit chats
afterwards (what was asked, what the model was sent, how it answered, which tools it called and what came back) and to
build training data from real Builder chats.

**It is off by default.** Nothing in the app turns it on: there is no setting, menu item or default for it. Only an
environment variable set when the app is launched does, and an automated test run ignores that variable. The files stay
on your computer: they are written to a folder outside every project, so they never reach a project's `siteorigin/` or
`src/` folder, an export, a git commit or a live session, and nothing is uploaded.

## Turning it on

Set the variables when you launch the app:

| Variable | Meaning |
| --- | --- |
| `SITEORIGIN_LEARNING` | `1` (or `true`, `yes`, `on`) turns learning mode on. Anything else, or unset, leaves it off. |
| `SITEORIGIN_LEARNING_DIR` | The folder the files go to. Unset, it is `learning` in the app's user data folder. Name a folder outside every project: a folder inside a Builder project is never written to, and nothing is recorded while one is named. |
| `SITEORIGIN_LEARNING_LABELS` | Labels for every chat recorded in this launch, as comma-separated `key=value` pairs, such as `experiment=sol-baseline,prompt=v3,source=manual`. A part that is not a `key=value` pair is left out and reported in the log. |

For example, on macOS:

```sh
SITEORIGIN_LEARNING=1 SITEORIGIN_LEARNING_LABELS=experiment=sol-baseline,prompt=v3 \
  "/Applications/SiteOrigin Builder.app/Contents/MacOS/SiteOrigin Builder"
```

The main log (Help > Show Log File) says at launch that learning mode is on and where it is writing.

## What a file holds

Each conversation has one file, named with the time it was first recorded and the conversation's ID
(`20261128T101530123Z-c_k3j9x2ab.jsonl`), so files sort by time. Every later step of that conversation is added to the
same file, in the same launch or after the app is quit and opened again. A code fix from the code editor, which is in no
chat, gets a file of its own (`…-fix_….jsonl`).

Each line is one JSON record, in the order the steps happened. Every record has `type`, `conversationId` and `time`;
the records of a request also name its `runId`, and those of a request a live session guest sent carry `guest`.

| `type` | What it records |
| --- | --- |
| `header` | Written each time a launch first adds to the file: the labels, the app's name, version and commit, the time, and `continued` when the file was already there. |
| `user` | The author's message whole, with the images it attached (by their library IDs and names: the pictures themselves are never sent to a model), its context and the project folder. |
| `request` | A request to the model as Builder sent it to the provider: `provider`, `model`, and the `request` with its system prompt, items, tool definitions and output budget, before the provider's adapter put it in that provider's own wire format (the header's commit names the adapter that did). `call` is `turn` for a chat's own turns and `fixer` for the code fixer's; `requestIndex` counts a run's requests from 1, `step` says which of its turns the request is for, and `attempt` which retry of it. |
| `resend` | The provider adapter sent the request again, changed: a correction after a reply it could not use (with that reply), a fallback the server needed, or a smaller output budget. |
| `response` | The model's answer to a request: its `reply` (text, tool calls, stop reason, token usage) or its `error` (including one that was retried). A request that ended without a reply, stopped or cut off, keeps what had arrived as `partial`. |
| `tool_result` | A tool call and its result: the item the model was sent, the error whole when it failed, and the edits a change applied. |
| `question`, `answer` | A question the assistant or the app asked the author, and the answer. |
| `stop` | The author stopped the request. |
| `outcome` | How the request ended: its status, and the turn as the chat keeps it, with its result, changes and checks. For a code fix, its result. |
| `undo`, `redo` | A request's changes were taken back, or brought back, from the chat, the toolbar or History (`via` says which). |

API keys never appear in a file. The requests carry no keys or headers, and every line has anything that looks like an
OpenAI or Anthropic key removed. Text you type yourself is recorded as you typed it, so do not paste other secrets into
a chat you are recording.

## Keeping the files

The app never rotates, truncates, overwrites or deletes a learning file; remove them yourself when you no longer want
them. A file that cannot be written (a folder without permission, a full disk) is reported in the main log once, and the
chat carries on unrecorded. A line cut off part way (a disk that filled) stays as it is, and the next record starts a
line of its own.

A conversation's file is looked for in the folder learning mode writes to, so a conversation continued after the folder
is changed starts a new file in the new folder, and an undo of a request recorded only in the old folder is not
recorded. Point one app profile at a folder at a time: two profiles continuing the
same conversation into one folder at the same moment can start two files for it.

Turning the recordings into a particular fine-tuning format is not part of the app.
