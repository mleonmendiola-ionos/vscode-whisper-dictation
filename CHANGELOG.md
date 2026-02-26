# Changelog

All notable changes to this project are documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
