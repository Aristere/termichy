# file-tree

A project file tree and file preview in a pane inside Claude Code.

- Folders expand and collapse, and the arrow keys, the wheel and the mouse all work.
- Selecting a file previews it: text with line numbers and a scrollbar, images (macOS), and a summary for other files.
- The pane stays closed until you ask for it.

## Install

```
claude plugin marketplace add Aristere/termichy
claude plugin install file-tree@termichy
```

## Use

| Command | What it does |
| :- | :- |
| `/tree` | Opens the file tree pane. |
| `/tree setup` | Asks how wide the pane should be (Slim, Balanced, Roomy) and whether it opens by itself when a session starts. |

`ctrl+x Tab` moves the keys into the pane, and `Esc` hands them back to the prompt.

The same two choices are in `/config`, under "Pane width" and "Open on session start". Your choices are kept for every session and project.

A width you dragged the pane to yourself wins over the width you pick here.

## Notes

Image previews use macOS `sips`. Everything else is not tied to one platform.

## License

MIT
