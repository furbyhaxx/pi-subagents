# Conversation viewer

For people inspecting subagents from `/agents`, FleetView, or the workflow inspector.
The viewer separates the assignment, activity history, and full output so reading a long run does not require scrolling through every tool result.

## Task and activity

The default **Steps** view pins the original task above a condensed timeline. Each tool call is paired with its result; commands, file paths, failures, assistant notes, compactions, and nested agent calls become individual rows. Consecutive successful read-only calls form expandable groups. Failed calls stay visible rather than disappearing into a group.

Press `t` to expand and focus the task. Arrow keys, Page Up/Down, and Home/End then scroll the task independently of the history. Press `t` again to return. Task text is retained separately from inherited parent context for new agent sessions; older sessions fall back to the original task available in their session history.

The viewer starts **Following** the latest activity. Navigating or expanding pauses it; incoming output must not pull you away from what you are reading. `End` in the history resumes following. `End` inside Task, Preview, Help, or Detail only goes to the end of that region.

## Inspect a step

| Key | Action |
|---|---|
| Up/Down, `k`/`j` | Select a step or group member |
| Right | Expand; press again to enter children or the preview |
| Space | Toggle expansion |
| Left | Collapse or return to the parent row |
| Page Up/Down | Page through the active reading region |
| `o` | Open the selected step's arguments and output in Detail |
| `f` | Cycle All, errors+mutations, and tools-only filters |
| `?` | Show pageable key help |

Previews show the first 30 and last 10 source lines of long output, with an explicit count of omitted middle lines. **Detail** displays all text retained locally, including the omitted middle, without launching an external editor. Escape returns to the previous view. Tool output remains literal by default; Markdown formatting is configurable with `m`.

“Full” refers to retained text: the viewer cannot recover output already truncated by a tool or provider. Clipboard copying is not offered when the host supplies no supported clipboard action.

## Raw view

`Tab` switches between Steps and **Raw**, the message-oriented transcript. Both views retain the task panel. The `viewerMode` setting records which view opens next.

Raw retains the legacy 16,000-character preview cap on individual tool results and shell output, with an omission notice. Use the corresponding step's Detail view to inspect the complete locally retained body. `m` cycles literal text, assistant Markdown, and Markdown for tool results too; tool-result Markdown is opt-in because it can reshape logs, diffs, and source code.

## Nested agents

Expand an Agent row to inspect available child activity inline. `O` opens that child's own conversation; Escape returns to the parent. Child viewers have their own task and controls. If the child session is no longer available, the spawn's retained arguments and result remain readable through `o`; inspecting never consumes its result or resumes it.

## Steering, stopping, and closing

- **Enter** opens the steering composer for the displayed running agent. Type and press Enter to send; Escape or an empty submission cancels.
- **`x`, then `x` again** requests a stop. Any other key cancels confirmation. Closing the viewer does not stop the agent.
- **Escape**, `q`, or Ctrl+C closes the current layer. Help and Detail do not forward steering or stop keys to the conversation behind them.

When reading an inline child row, steering and stopping still target the agent named in the viewer header. Open the child's own viewer with `O` to control that child instead.

Configured navigation bindings also apply. Narrow terminals show fewer footer hints; `?` exposes the complete key list.
