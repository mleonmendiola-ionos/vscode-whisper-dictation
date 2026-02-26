# update.ps1 — Descarga e instala la última versión de vscode-whisper-dictation
# Uso: .\update.ps1
# Requiere: gh CLI autenticado (gh auth login) o acceso público al repo

$repo = "mleonmendiola-ionos/vscode-whisper-dictation"
$tmpDir = Join-Path $env:TEMP "vsix-update"
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

Write-Host "Buscando última versión en GitHub..."
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "update-script" }
$version = $release.tag_name
$asset = $release.assets | Where-Object { $_.name -like "*.vsix" } | Select-Object -First 1

if (-not $asset) {
    Write-Error "No se encontró .vsix en la release $version"
    exit 1
}

$vsixPath = Join-Path $tmpDir $asset.name
Write-Host "Descargando $($asset.name) ($version)..."

# Descargar (requiere gh si el repo es privado)
$ghExe = Get-Command gh -ErrorAction SilentlyContinue
if ($ghExe) {
    gh release download $version --repo $repo --pattern "*.vsix" --dir $tmpDir --clobber
} else {
    Invoke-WebRequest $asset.browser_download_url -OutFile $vsixPath
}

Write-Host "Instalando en VS Code..."
code --install-extension $vsixPath --force

Remove-Item $tmpDir -Recurse -Force
Write-Host "✓ Instalado $version correctamente. Recarga VS Code (Ctrl+Shift+P > Reload Window)."
