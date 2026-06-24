$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$latest = Join-Path $dist "latest.yml"
$historyFile = Join-Path $PSScriptRoot "published-versions.json"
$bucket = "casting-planner-updates"
$keepCloudVersions = 3

if (-not (Test-Path -LiteralPath $latest)) {
    throw "dist\latest.yml bulunamadı. Önce npm run dist çalıştırın."
}

$metadata = [IO.File]::ReadAllText($latest, [Text.Encoding]::UTF8)
$installerName = [regex]::Match($metadata, "(?m)^path:\s*(.+)$").Groups[1].Value.Trim()
if (-not $installerName) {
    throw "latest.yml içinde kurulum dosyası bulunamadı."
}

$currentMatch = [regex]::Match($installerName, '^(?<prefix>.+ Setup )(?<version>\d+\.\d+\.\d+)(?<suffix>\.exe)$')
if (-not $currentMatch.Success) {
    throw "Beklenmeyen kurulum dosyası adı: $installerName"
}
$installerPrefix = $currentMatch.Groups["prefix"].Value
$currentVersion = $currentMatch.Groups["version"].Value
$installerSuffix = $currentMatch.Groups["suffix"].Value
$installerPattern = '^' + [regex]::Escape($installerPrefix) + '(?<version>\d+\.\d+\.\d+)' +
    [regex]::Escape($installerSuffix) + '(?:\.blockmap)?$'

$files = @(
    $latest,
    (Join-Path $dist $installerName),
    (Join-Path $dist ($installerName + ".blockmap"))
)

foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file)) {
        throw "Yayın dosyası bulunamadı: $file"
    }
    $name = Split-Path -Leaf $file
    & npx.cmd wrangler r2 object put "$bucket/$name" --file $file --remote --config (Join-Path $root "cloud\wrangler.toml")
    if ($LASTEXITCODE -ne 0) {
        throw "R2 yüklemesi başarısız: $name"
    }
}

if (Test-Path -LiteralPath $historyFile) {
    $parsedVersions = [IO.File]::ReadAllText($historyFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $publishedVersions = @()
    foreach ($version in $parsedVersions) {
        $publishedVersions += [string]$version
    }
} else {
    $publishedVersions = @()
}

$publishedVersions = @($publishedVersions + $currentVersion |
    Where-Object { $_ -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_ } -Unique)

$cloudKeep = @($publishedVersions | Select-Object -Last $keepCloudVersions)
$cloudRemove = @($publishedVersions | Where-Object { $_ -notin $cloudKeep })

foreach ($version in $cloudRemove) {
    $oldInstaller = "$installerPrefix$version$installerSuffix"
    foreach ($name in @($oldInstaller, "$oldInstaller.blockmap")) {
        & npx.cmd wrangler r2 object delete "$bucket/$name" --remote --force --config (Join-Path $root "cloud\wrangler.toml")
        if ($LASTEXITCODE -ne 0) {
            throw "Eski R2 dosyası silinemedi: $name"
        }
    }
}

[IO.File]::WriteAllText(
    $historyFile,
    (($cloudKeep | ConvertTo-Json) + [Environment]::NewLine),
    (New-Object Text.UTF8Encoding($false))
)

$currentFiles = @($installerName, "$installerName.blockmap")
$localOldFiles = @(Get-ChildItem -LiteralPath $dist -File | Where-Object {
    $_.Name -match $installerPattern -and $_.Name -notin $currentFiles
})

foreach ($file in $localOldFiles) {
    $resolved = [IO.Path]::GetFullPath($file.FullName)
    $distRoot = [IO.Path]::GetFullPath($dist) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($distRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Beklenmeyen yerel temizleme yolu: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Force
}

Write-Host "Güncelleme yayımlandı: $installerName"
Write-Host "Yerelde yalnızca güncel sürüm bırakıldı."
Write-Host "Bulutta tutulan sürümler: $($cloudKeep -join ', ')"
