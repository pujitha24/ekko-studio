# Codex command approvals

Studio chat turns use `codex app-server --stdio` and JSON-RPC instead of
`codex exec --json`. The latter closes stdin after the prompt and cannot
receive a later user decision.

Threads start or resume with `approvalPolicy: "on-request"` and
`approvalsReviewer: "user"`. The filesystem sandbox remains
`danger-full-access`, matching the previous chat runtime. This does not
automatically approve commands: Codex's built-in dangerous-command classifier
can still request approval. In Codex 0.163.0, `approval_policy = "never"`
rejects those commands before creating the shell process, even with the
sandbox disabled.

The adapter translates `item/commandExecution/requestApproval` and
`item/fileChange/requestApproval` into Studio's existing `approval.requested`
event. Only the owning Studio session can resolve the generated approval ID:

| Studio decision | Codex response |
| --- | --- |
| `once` | `accept` |
| `session` | `acceptForSession` |
| `always` (only when Codex proposes a rule) | `acceptWithExecpolicyAmendment` with the unmodified proposal |
| `deny` | `decline` |
| Any other choice | Rejected without resolving the request |

The adapter never invents persistent rules. `always` is available only for a
nonempty native `proposedExecpolicyAmendment`; the UI shows the exact proposed
argument prefix before the user chooses. Codex owns saving/enforcing that rule
in the active Codex configuration home, which can be isolated by Studio.
File-change requests do not offer a persistent command rule.

Codex processes are disposable between turns. To retain an explicit command
session grant, the managed Studio run remembers a bounded set of fingerprints
covering native thread, exact command, working directory, environment ID and
reason. Only an identical command request receives `acceptForSession` again.
A different command/context or a different Studio run prompts normally. These
grants disappear when the managed run is closed or invalidated. Network,
stdin and file-change session decisions retain their native process lifetime;
they are not broadened into a Studio-side reusable grant.

Command text is carried in the approval event's `command` field, separately
from the description. Empty or whitespace-only command boxes are not rendered.

The adapter tracks JSON-RPC request IDs separately from item IDs because one item can
have several independent approval callbacks. Requests for other threads or
turns are declined. Requests arriving before the `turn/start` response are
queued until their turn ID can be checked.

After five minutes, an unanswered request is declined and the pending
interaction is removed. Turn completion, process failure and session
cancellation also clear pending approvals. Unknown server-to-client request
methods return a JSON-RPC error rather than receiving an implicit grant.

Model selection, managed prompt files, native thread IDs and provider
configuration continue to use the existing launch configuration. Prompt text
and image paths travel over JSON-RPC stdin. Historical turns returned by
`thread/resume` are not replayed into Studio.

While an app-server turn is active, native text notifications are the only
source of displayed reply text. The scoped provider proxy still supplies
transport and usage accounting, but its text deltas must not be displayed a
second time. Native deltas are appended exactly, including short Chinese
fragments and intentional repetition; completed item snapshots reconcile
without replaying streamed text. Approval request, decision, expiry and
chat-event delivery failure logs identify the affected session without
logging the command or provider credentials.

A `turn/start` response only acknowledges dispatch. A turn succeeds after a
matching `turn/completed` notification with status `completed`, followed by
process close and existing native usage reconciliation. A premature process
close is a failure even with exit code zero. The adapter closes stdin at the
terminal notification and bounds process shutdown so a hanging MCP shutdown
cannot leave the foreground turn active indefinitely.

Validation must include protocol correlation, cross-session rejection,
single-use decisions, timeout and cancellation, UTF-8 streaming, images,
native resume, Windows npm shims, and the existing approval UI. Protocol
fixtures do not establish live model/provider compatibility; use an isolated
profile and disposable files for deployment acceptance.
