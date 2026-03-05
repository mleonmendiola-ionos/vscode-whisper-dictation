# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.6.0] - 2026-03-05

### Changed
- Replaced emoji icons with SVG icons for consistent rendering across all operating systems
- Microphone button now has depth (shadow) and a hover ring to make it clearly interactive
- Added action hint below the button ("Click to record · Hold Space" / "Release Space or click to stop")
- Transcript area now has a max height with scroll, custom scrollbar, and an empty-state placeholder
- Status text turns green on success and red on errors
- Layout no longer collapses on narrow or short panels

## [1.5.0] - 2026-03-02

### Added
- Toggle recording shortcut: **Ctrl+Shift+R** starts/stops recording when the panel is open (works from anywhere in VS Code)
- Push-to-talk: hold **Space** in the voice panel to record, release to stop
- Configurable maximum recording duration via settings (`whisper-dictation.maxRecordingSeconds`)

## [1.4.0] - 2026-03-02

### Added
- Configurable model and language via VS Code settings (`whisper-dictation.model`, `whisper-dictation.language`)
- 5-minute recording timeout to prevent forgotten recordings
- Preload Whisper model on extension activation (no more waiting when opening the panel)

### Fixed
- Redirect limit in auto-update download to prevent infinite redirect loops
- Temp .vsix file now cleaned up after auto-update install
- UI no longer stuck on "Transcribing..." if the Python process dies mid-recording
- Auto-update check throttled to once every 24 hours

### Changed
- Python script transcribes directly from numpy array instead of writing a temp WAV file
- Python daemon stays alive when the panel is closed and is reused when reopened

## [1.3.0] - 2026-02-26

### Removed
- `update.ps1` script — replaced by built-in auto-update on VS Code startup

### Changed
- Simplified installation instructions in README

## [1.2.5] - 2026-02-26

### Fixed
- Auto-update now runs on VS Code startup (`onStartupFinished`) instead of only when opening the panel

## [1.2.4] - 2026-02-26

### Changed
- Test release to verify auto-update works independently of VS Code's auto-update checkbox

## [1.2.3] - 2026-02-26

### Fixed
- Auto-update now uses VS Code internal API instead of CLI, preserving user settings (auto-update checkbox)

## [1.2.2] - 2026-02-26

### Removed
- Hardcoded version badge from README (version is already shown by VS Code)

## [1.2.1] - 2026-02-26

### Changed
- Test release to verify the auto-update feature

## [1.2.0] - 2026-02-26

### Added
- Auto-update check on extension activation: fetches the latest GitHub release and offers to update if a newer version is available

## [1.1.0] - 2026-02-26

### Added
- Persistent Python process: the Whisper model loads once when the panel is opened
- `START` / `STOP` / `RESULT` / `ERROR` communication protocol over stdin/stdout
- State machine in the webview (`LOADING → READY → RECORDING → TRANSCRIBING`)
- Loading animation (spin) while the model is not yet ready
- Extension icon (`Logo.png`)

### Changed
- The model no longer reloads on each recording — subsequent recordings are nearly instant
- The button starts disabled until the model confirms `READY`

## [0.1.0] - 2026-02-26

### Added
- First working version
- Audio recording with `sounddevice`
- Local transcription with `faster-whisper`
- Automatic text copy to clipboard
- Webview panel accessible with Ctrl+Shift+V
