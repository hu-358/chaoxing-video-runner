$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ExtensionDir = Join-Path $ProjectRoot 'extension'
$ReleaseDir = Join-Path $ProjectRoot 'release'
$PackagePath = Join-Path $ReleaseDir 'chaoxing-course-task-player-edge-v2.2.0.zip'
$HashPath = Join-Path $ReleaseDir 'SHA256SUMS.txt'

New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null

if (Test-Path -LiteralPath $PackagePath) {
  Remove-Item -LiteralPath $PackagePath -Force
}

Compress-Archive -Path (Join-Path $ExtensionDir '*') -DestinationPath $PackagePath -CompressionLevel Optimal

$Entries = tar -tf $PackagePath
if ($Entries -notcontains 'manifest.json') {
  throw 'Package validation failed: manifest.json is not at the ZIP root.'
}
if ($Entries -contains 'portal.js') {
  throw 'Package validation failed: removed portal.js was included.'
}

$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PackagePath).Hash.ToLowerInvariant()
$HashLine = "$Hash  chaoxing-course-task-player-edge-v2.2.0.zip"
[System.IO.File]::WriteAllText($HashPath, $HashLine + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

Write-Output "Package: $PackagePath"
Write-Output "SHA256: $Hash"
