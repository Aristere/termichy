# file-tree

A file tree and file preview inside Claude Code. Type `/tree`, browse your project, and read any file without leaving the session.

![MIT license](https://img.shields.io/badge/license-MIT-blue) ![Claude Code 2.1.302+](https://img.shields.io/badge/Claude%20Code-2.1.302%2B-orange)

![file-tree demo: open the pane, expand a folder, preview a file, scroll it, then run setup](assets/demo.gif)

## Install

```
claude plugin marketplace add Aristere/termichy
claude plugin install file-tree@termichy
```

Start a new session after installing. Nothing opens by itself. Type `/tree` when you want the pane.

## Use

| Command | What it does |
| :- | :- |
| `/tree` | Opens the file tree pane. |
| `/tree setup` | Optional. Asks how wide the pane should be and when it opens. |

Once the pane is open:

- Press `ctrl+x` then `Tab` to move the keys into the pane. `Esc` hands them back to the prompt.
- `↑` and `↓` (or the mouse wheel) move through the rows. `Enter` opens a folder or a file.
- Open a file to preview it. `Tab` moves into the preview, where the arrows, `PageUp` and `PageDown` scroll it. Press `Tab` again to go back to the tree.
- You can also click any row, or click the scrollbar to jump through a long file.

## What you see

- **Text files** open with line numbers, syntax colors and a scrollbar. Long lines wrap.
- **Images** show as a picture (macOS only).
- **Everything else** (binaries, video, files too big to read) shows a short summary and buttons to open or reveal the file.
- **Folders** expand and collapse in place. Symlinks, unreadable files and odd names are handled without breaking the tree.

## Setup

The defaults work, so setup is optional. Run `/tree setup` to answer two questions in plain words:

- **How wide should the file tree be?** Slim, Balanced or Roomy.
- **When should the file tree open?** Automatically when a session starts, or only when you type `/tree`.

Your answers are kept for every session and project. Run `/tree setup` again to change them. The same two settings are in `/config`, under "Pane width" and "Open on session start".

## Requirements

Claude Code 2.1.302 or later. The pane docks beside the conversation in a terminal at least 110 columns wide.

## Troubleshooting

**The width I picked has no effect.** A width you dragged the pane to yourself wins over the setup choice. Drag the pane to the width you want.

**Images show as a summary.** Image previews use macOS `sips`. On Linux and Windows an image shows the summary with open and reveal buttons.

## License

MIT
