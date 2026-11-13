# Windows 10/11. Installs a private Node runtime; no administrator or PATH edits.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Receive-File([string]$Url, [string]$Destination) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}
function Assert-Checksum([string]$File, [string]$Manifest, [string]$Name) {
    $Pattern = '^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($Name) + '$'
    $Line = Get-Content -LiteralPath $Manifest | Where-Object { $_ -match $Pattern } | Select-Object -First 1
    if (-not $Line -or -not ($Line -match $Pattern)) { throw "Checksum missing for $Name" }
    $Expected = $Matches[1]
    $Stream = [IO.File]::OpenRead($File)
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try { $Actual = [BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-', '') } finally { $Stream.Dispose(); $Hasher.Dispose() }
    if ($Actual -ne $Expected) { throw "Download verification failed: $Name. Run the installer again." }
}
function Expand-Zip([string]$File, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($File, $Destination)
}
try {
    $CacheRoot = Join-Path $env:LOCALAPPDATA 'WIHM-Cloudflare'
    New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
    $PackageRoot = $PSScriptRoot
    if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot 'payload\worker.mjs'))) {
        $Release = 'https://github.com/DarkPoesidon/Abraneh/releases/latest/download'
        $DownloadRoot = Join-Path $CacheRoot ('download-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $DownloadRoot | Out-Null
        Write-Host 'Downloading WIHM Installer...'
        $Archive = Join-Path $DownloadRoot 'wihm-installer.zip'
        $Checksums = Join-Path $DownloadRoot 'SHA256SUMS'
        Receive-File "$Release/wihm-installer.zip" $Archive
        Receive-File "$Release/SHA256SUMS" $Checksums
        Assert-Checksum $Archive $Checksums 'wihm-installer.zip'
        Expand-Zip $Archive $DownloadRoot
        $PackageRoot = Join-Path $DownloadRoot 'WIHM-Installer'
    }
    $Node = $null
    $Existing = Get-Command node -ErrorAction SilentlyContinue
    if ($Existing) {
        $NodeVersion = & $Existing.Source --version
        if ($LASTEXITCODE -eq 0 -and $NodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { $Node = $Existing.Source }
    }
    if (-not $Node) {
        $Cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        $Arch = switch ($Cpu) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw 'Windows x64 or ARM64 is required.' } }
        $RuntimeRoot = Join-Path $CacheRoot ('runtime-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
        $Checksums = Join-Path $RuntimeRoot ('SHASUMS-' + [guid]::NewGuid().ToString('N') + '.txt')
        Write-Host 'Preparing Node.js 24 from nodejs.org...'
        Receive-File 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' $Checksums
        $Pattern = '(node-v24\.\d+\.\d+-win-' + $Arch + '\.zip)$'
        $Line = Get-Content -LiteralPath $Checksums | Where-Object { $_ -match $Pattern } | Select-Object -First 1
        if (-not $Line -or -not ($Line -match $Pattern)) { throw 'The Node.js download list could not be read.' }
        $Name = $Matches[1]
        $Version = [regex]::Match($Name, 'v24\.\d+\.\d+').Value
        $Archive = Join-Path $RuntimeRoot $Name
        Receive-File "https://nodejs.org/dist/$Version/$Name" $Archive
        Assert-Checksum $Archive $Checksums $Name
        Expand-Zip $Archive $RuntimeRoot
        $Node = Join-Path $RuntimeRoot ($Name.Replace('.zip', '') + '\node.exe')
    }
    Write-Host 'Opening the Persian installation wizard. Keep this window open.'
    & $Node (Join-Path $PackageRoot 'start.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'The installer could not start.' }
} catch {
    Write-Host ('Installation stopped: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
