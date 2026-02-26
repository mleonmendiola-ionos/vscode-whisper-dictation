# update.ps1 — Downloads and installs the latest version of vscode-whisper-dictation
# Usage: .\update.ps1
# Requires: gh CLI authenticated (gh auth login) or public repo access

$repo = "mleonmendiola-ionos/vscode-whisper-dictation"
$tmpDir = Join-Path $env:TEMP "vsix-update"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

Write-Host "Looking for latest version on GitHub..."
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "update-script" }
$version = $release.tag_name
$asset = $release.assets | Where-Object { $_.name -like "*.vsix" } | Select-Object -First 1

if (-not $asset) {
    Write-Error ".vsix not found in release $version"
    exit 1
}

$vsixPath = Join-Path $tmpDir $asset.name
Write-Host "Downloading $($asset.name) ($version)..."

# Download (requires gh if the repo is private)
$ghExe = Get-Command gh -ErrorAction SilentlyContinue
if ($ghExe) {
    gh release download $version --repo $repo --pattern "*.vsix" --dir $tmpDir --clobber
} else {
    Invoke-WebRequest $asset.browser_download_url -OutFile $vsixPath
}

Write-Host "Installing in VS Code..."
code --install-extension $vsixPath --force

Remove-Item $tmpDir -Recurse -Force
Write-Host "✓ Installed $version successfully. Reload VS Code (Ctrl+Shift+P > Reload Window)."
