# update.ps1 — Downloads and installs the latest version of vscode-whisper-dictation
# Usage: .\update.ps1
# Requires: gh CLI authenticated (gh auth login)

$repo = "mleonmendiola-ionos/vscode-whisper-dictation"
$tmpDir = Join-Path $env:TEMP "vsix-update"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

Write-Host "Looking for latest version on GitHub..."
$version = gh release view --repo $repo --json tagName --jq ".tagName"
if (-not $version) {
    Write-Error "Could not get latest release. Make sure gh CLI is installed and authenticated."
    exit 1
}

Write-Host "Downloading $version..."
gh release download $version --repo $repo --pattern "*.vsix" --dir $tmpDir --clobber
if ($LASTEXITCODE -ne 0) {
    Write-Error ".vsix not found in release $version"
    exit 1
}

$vsixPath = Get-ChildItem $tmpDir -Filter "*.vsix" | Select-Object -First 1 -ExpandProperty FullName

Write-Host "Installing in VS Code..."
code --install-extension $vsixPath --force

Remove-Item $tmpDir -Recurse -Force
Write-Host "Done! Installed $version successfully. Reload VS Code (Ctrl+Shift+P > Reload Window)."
