# Dosya Senkronizasyon Scripti - Desktop'a Otomatik Kopyala
# Her yapılan değişiklikte index.html'i masaüstüne kopyalar

# Değişkenleri tanımla
$sourceFile = "c:\apps\casting-planner\index.html"
$desktopPath = "C:\Users\$env:USERNAME\Desktop\Planlayici-web1.html"

# Dosya değişiklikleri için observer oluştur
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = "c:\apps\casting-planner"
$watcher.Filter = "index.html"
$watcher.IncludeSubdirectories = $false
$watcher.EnableRaisingEvents = $true

# Değişiklik olayı için action tanımla
$action = {
    $eventPath = $Event.SourceEventArgs.FullPath
    
    # Kısa bir gecikme ekle (dosyanın yazılmasını tamamlaması için)
    Start-Sleep -Milliseconds 500
    
    try {
        Copy-Item -Path $eventPath -Destination $desktopPath -Force -ErrorAction Stop
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Write-Host "[$timestamp] ✓ Dosya senkronize edildi: $desktopPath" -ForegroundColor Green
    }
    catch {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Write-Host "[$timestamp] ✗ Hata: $_" -ForegroundColor Red
    }
}

# Eventları tanımla
Register-ObjectEvent -InputObject $watcher -EventName "Changed" -Action $action | Out-Null
Register-ObjectEvent -InputObject $watcher -EventName "Created" -Action $action | Out-Null

Write-Host "📁 Döküm Planlama Sistemi - Dosya Senkronizasyon Başladı"
Write-Host "📍 Kaynak: c:\apps\casting-planner\index.html"
Write-Host "📍 Hedef: $desktopPath"
Write-Host "⏳ Değişiklikleri izliyor... (Çıkmak için Ctrl+C basın)`n"

# Sonsuz döngü - Eventları dinle
while ($true) {
    Start-Sleep -Seconds 1
}
