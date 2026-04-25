# boardthing

A local kanban board for running AI agent pipelines. Cards move through
columns driven by Claude agents — one agent per transition, each with a
specific role and its own command file.

## Concept

The pipeline is a state machine:

- **Columns** are states (nodes)
- **Agents** are transitions (arcs between nodes)

A card enters `backlog`, gets picked up by the spec agent, moves to
`specification`, gets picked up by the implementation agent, and so on.
Each agent locks the card while working (renames to `.md.wip`), then moves
it to the next column when done.

## Usage

```sh
node board-viewer.js [board-dir] [port]
```

`board-dir` defaults to `./.board`. `port` defaults to `3000`.

On first run, `board-dir` is bootstrapped automatically:
- Column subdirectories are created
- `config.json` is written with default columns and transitions
- Default agent command files are written to `board-dir/commands/`

Open `http://localhost:<port>` in a browser to see the board.

## Config

`board-dir/config.json` defines the pipeline. Example:

```json
{
  "repo": "/path/to/your/project",
  "columns": ["backlog", "specification", "implementation", "done", "blocked"],
  "transitions": [
    { "from": "backlog",        "to": "specification",  "agent": "spec"      },
    { "from": "specification",  "to": "implementation", "agent": "implement" },
    { "from": "implementation", "to": "done",           "agent": "review"    }
  ]
}
```

Columns can be plain strings or objects with an `id` and optional `color` hex:

```json
{ "id": "backlog", "color": "#3b82f6" }
```

The `repo` field is optional. When set, each agent creates a separate jj
workspace for the card before starting work, keeping changes isolated until
reviewed.

### Agent command files

Each transition looks up a command file by the `agent` field (falling back
to the `to` column name if `agent` is not set):

1. `board-dir/commands/<agent>.md`
2. `~/.claude/commands/<agent>.md`

The file is passed as `--system-prompt` to `claude -p`. It should define
the agent's role and rules without hardcoding column paths — those are
passed via the task prompt at runtime.

## Board UI

| Element | Action |
|---|---|
| `+` | Add a card to that column |
| `▼` / `▲` | Decrease / increase the agent pool size for that transition |
| `⚙` | View the agent command file |
| Click card | View card content |
| Edit button | Edit card content in place |
| Delete button | Delete the card (not available while being processed) |
| Move to… | Move the card to another column |
| Drag card | Drag and drop a card to another column |

The board auto-refreshes every 3 seconds. Cards being processed show a
pulsing yellow dot and a dashed border. When a card moves to a new column
it animates in with a brief slide-down effect.

### Agent pool

Each transition has a configurable pool size controlling how many agents
run concurrently for that column. Use `▲` to add a slot (starts an agent
immediately if cards are waiting) and `▼` to remove one. Active agents
finish their current card before stopping — they are not killed mid-flight.
The pool size resets to 0 when the server restarts.

## Cards

Cards are plain `.md` files. Drop one into any column folder to queue it:

```
board-dir/backlog/my-feature.md
```

Minimum card content:

```markdown
# Brief

One or two sentences describing the desired outcome with enough context
that an agent can act on it without guessing.
```

Cards accumulate content as they move through the pipeline — each agent
appends its output below the previous section, so the file becomes a
complete audit trail.

### Blocked cards

If an agent cannot proceed without a human decision it moves the card to
the `blocked` folder and documents the question in the card. Answer inline
and move the card back to the appropriate column to continue.

## Local images

Images in cards are served from `board-dir/` via `/files/`:

```markdown
![screenshot](/files/backlog/screenshot.png)
```

## Requirements

Node.js (no npm dependencies). Claude CLI (`claude`) must be in `PATH` for
agent watchers to work.
