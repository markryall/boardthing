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
  "columns": ["backlog", "specification", "implementation", "testing", "review", "done", "blocked"],
  "transitions": [
    { "from": "backlog",        "to": "specification"  },
    { "from": "specification",  "to": "implementation" },
    { "from": "implementation", "to": "testing"        },
    { "from": "testing",        "to": "review"         }
  ]
}
```

Column `id` doubles as the folder name and the label (title-cased). An
optional `color` hex can be set per column object.

The `repo` field is optional. When set, each agent creates a separate jj
workspace for the card before starting work, keeping changes isolated until
reviewed.

### Agent command files

Each transition looks up a command file by the `to` column name:

1. `board-dir/commands/<to>.md`
2. `~/.claude/commands/<to>.md`

The file is passed as `--system-prompt` to `claude -p`. It should define
the agent's role and rules without hardcoding column paths — those are
passed via the task prompt at runtime.

An optional `command` field on a transition overrides the name lookup:

```json
{ "from": "backlog", "to": "specification", "command": "my-custom-spec" }
```

## Board UI

| Element | Action |
|---|---|
| `+` | Add a card to that column |
| `▶` | Start the watcher for that transition |
| `■` | Stop the watcher |
| `⚙` | View the agent command file |
| Click card | View card content (markdown rendered) |
| Edit button | Edit card content in place |

The board auto-refreshes every 3 seconds. Cards being processed show a
pulsing yellow dot and a dashed border.

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
