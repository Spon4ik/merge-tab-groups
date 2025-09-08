# Merge Tab Groups (Chrome Extension)

Merge Chrome tab groups by name or manual selection.

## Features
- **Merge duplicates by name** (one click or keyboard shortcut).
- **Merge selected groups** into a single target (optional title).
- **Fast Merge**: discards tabs while moving so they don’t load.
- **Keep Collapsed**: keep groups collapsed after merge.
Note: Chrome’s Saved Tab Groups (those chips on the toolbar) aren’t exposed to extensions when closed, so merging them requires opening at least one of the groups.
- Auto-merge on group changes (optional).

## Install (Store)
- Chrome Web Store: [Merge Tab Groups](https://chromewebstore.google.com/detail/jdbnhiecjaimhhiaegdecbakmnejlbhe?utm_source=item-share-cb)

## Install (Dev)
1. Clone/download this folder.
2. Open `chrome://extensions`, toggle **Developer mode**.
3. Click **Load unpacked** and select the folder.

## Usage
- Click the extension → **Merge duplicates (same name)**.
- Or select multiple groups and **Merge selected** with an optional title.
- Shortcut: `Ctrl+Shift+M` (change in `chrome://extensions/shortcuts`).

## Settings
Open **Settings** from the popup or `options.html`:
- **Auto-merge** – automatically dedupe groups by name.
- **Case-sensitive** – title matching toggle.
- **Include unnamed** – include empty titles in duplicate merges.
- **Fast merge** – discard tabs while moving so they don’t load (recommended on low-power).
- **Keep collapsed** – keep the final group collapsed post-merge.
- **Prefer largest target** – pick target group with the most tabs.

## Permissions
- `tabs`, `tabGroups`, `storage` – required to read/move groups and save settings.
No data leaves your machine.

## Notes
- Groups are per-window. Current behavior merges **within the current window**.
- Discarding a tab fails if it’s active; that’s fine—we discard others and continue.

## Roadmap
- Cross-window merging.
- Title normalization (whitespace, punctuation).
- Undo (restore last merge).
- i18n, icons, store listing.

## License
MIT — see `LICENSE`.
