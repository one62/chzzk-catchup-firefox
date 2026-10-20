$ErrorActionPreference = 'Stop'
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $packageRoot 'manifest.json'
$extensionManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($extensionManifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid extension version' }
$distributionPath = Join-Path $packageRoot 'dist'
New-Item -ItemType Directory -Path $distributionPath -Force | Out-Null
$archivePath = Join-Path $distributionPath ("chzzk-catchup-{0}.zip" -f $extensionManifest.version)
$extensionFiles = @('manifest.json', 'src', 'popup', 'icons') | ForEach-Object { Join-Path $packageRoot $_ }
Compress-Archive -LiteralPath $extensionFiles -DestinationPath $archivePath -Force
Write-Output $archivePath
