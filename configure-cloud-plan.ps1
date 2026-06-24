param(
    [Parameter(Mandatory = $true)]
    [string]$Url,

    [Parameter(Mandatory = $true)]
    [string]$UploadToken
)

$configDirectory = Join-Path $env:APPDATA "casting-planner"
$configFile = Join-Path $configDirectory "cloud-plan.config.json"

New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null

$config = @{
    url = $Url.TrimEnd("/")
    uploadToken = $UploadToken
} | ConvertTo-Json

Set-Content -LiteralPath $configFile -Value $config -Encoding UTF8
Write-Host "Bulut plan ayarı kaydedildi: $configFile"
