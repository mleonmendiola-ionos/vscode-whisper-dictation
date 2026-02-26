# Voice Dictation · vscode-whisper-dictation

**Dictate text directly in VS Code using local Whisper. No internet, no external APIs.**

---

## Features

- **100% local** — the Whisper model runs on your machine, no audio leaves your computer
- **Auto-copy** — transcribed text is automatically copied to the clipboard, ready to paste
- **Persistent process** — the model loads once when you open the panel; subsequent recordings are nearly instant
- **Multiple models** — choose between `tiny`, `small`, `medium` depending on speed/accuracy needs

## Requirements

- VS Code 1.80 or higher
- [`uv`](https://docs.astral.sh/uv/) installed and available in PATH
- Python accessible via `uv` (managed automatically)
- Working microphone

## Installation

Download the latest `.vsix` and run the update script:

```powershell
.\update.ps1
```

Or manually:

```powershell
gh release download --repo mleonmendiola-ionos/vscode-whisper-dictation --pattern "*.vsix"
code --install-extension vscode-whisper-dictation-*.vsix
```

## Usage

1. Press **Ctrl+Shift+V** (or search "Dictation: Open voice panel" in the command palette)
2. Wait for the button to show **🎤 Ready to record** (the model loads in the background, ~5–15s the first time)
3. Click **🎤** to start recording
4. Speak naturally
5. Click **⏹** to stop — the text appears in the panel and is copied to the clipboard
6. Paste with **Ctrl+V** wherever you need it

## Available Models

| Model   | Speed     | Accuracy | Approx. VRAM |
|---------|-----------|----------|--------------|
| `tiny`  | ⚡⚡⚡     | ★★☆      | ~400 MB      |
| `small` | ⚡⚡       | ★★★      | ~1 GB        |
| `medium`| ⚡         | ★★★★     | ~2.5 GB      |

`small` is used by default. To change it, edit the argument in `extension.ts`.

## How it Works

The VS Code panel (webview) sends messages to `extension.ts`, which manages a persistent Python process (`record_transcribe.py`). The process loads the Whisper model on startup and waits for `START`/`STOP` commands — without restarting between recordings.

## Authors

- **Manuel León** — development and VS Code integration
- **Claude (Anthropic)** — co-author of the implementation

## License

MIT
