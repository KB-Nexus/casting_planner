// Tek seferlik veri taşıma scripti.
//
// SMB paylaşımındaki data.json dosyasını okuyup yeni /api/state uç noktasına
// yükler. SMB'ye erişimi olan bir makineden, worker deploy edildikten sonra
// ve yeni Electron build'i dağıtılmadan ÖNCE, bir kez çalıştırılır.
//
// Kullanım:
//   node cloud/scripts/migrate-data.js
//
// cloud-plan.config.json'ı (main.js'teki ile aynı konumlardan) otomatik okur,
// ya da CASTING_PLAN_CLOUD_URL / CASTING_PLAN_UPLOAD_TOKEN ortam değişkenleri
// verilebilir.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const NETWORK_DATA_FILE = '\\\\192.168.1.249\\Kalite10$\\PlanlamaData\\data.json';

function readCloudConfig() {
    const envUrl = String(process.env.CASTING_PLAN_CLOUD_URL || '').trim();
    const envToken = String(process.env.CASTING_PLAN_UPLOAD_TOKEN || '').trim();
    if (envUrl && envToken) {
        return { url: envUrl.replace(/\/+$/, ''), uploadToken: envToken };
    }
    const candidates = [
        path.join(process.env.APPDATA || '', 'casting-planner', 'cloud-plan.config.json'),
        path.join(__dirname, '..', '..', 'cloud-plan.config.json'),
    ];
    for (const configFile of candidates) {
        try {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^﻿/, ''));
            const url = String(config.url || '').trim().replace(/\/+$/, '');
            const uploadToken = String(config.uploadToken || '').trim();
            if (url && uploadToken) return { url, uploadToken };
        } catch { /* sonraki konumu dene */ }
    }
    return null;
}

async function main() {
    const config = readCloudConfig();
    if (!config) {
        console.error('Bulut yapılandırması bulunamadı (cloud-plan.config.json veya env değişkenleri gerekli).');
        process.exit(1);
    }

    console.log(`SMB dosyası okunuyor: ${NETWORK_DATA_FILE}`);
    let payload;
    try {
        payload = JSON.parse(fs.readFileSync(NETWORK_DATA_FILE, 'utf8'));
    } catch (err) {
        console.error(`data.json okunamadı: ${err.message}`);
        process.exit(1);
    }

    console.log('Mevcut sunucu durumu kontrol ediliyor...');
    const existing = await fetch(`${config.url}/api/state`, {
        headers: { Authorization: `Bearer ${config.uploadToken}` },
    }).then(r => r.json());

    if (existing && existing.payload) {
        console.error(
            `Sunucuda zaten veri var (version=${existing.version}, updatedAt=${existing.updatedAt}). ` +
            `Üzerine yazmamak için script durduruldu. Bu beklenmiyorsa sunucudaki veriyi kontrol edin.`
        );
        process.exit(1);
    }

    console.log('Veri yükleniyor...');
    const migrationToken = `migration-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
    const uploadResponse = await fetch(`${config.url}/api/state`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.uploadToken}`,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
            payload,
            expectedVersion: 0,
            username: 'migration',
            hostname: os.hostname(),
            token: migrationToken,
        }),
    });
    const uploadResult = await uploadResponse.json();
    if (!uploadResponse.ok) {
        console.error('Yükleme başarısız:', uploadResult);
        process.exit(1);
    }
    console.log(`Yüklendi. version=${uploadResult.version}, updatedAt=${uploadResult.updatedAt}`);

    console.log('Doğrulanıyor...');
    const verifyResponse = await fetch(`${config.url}/api/state`, {
        headers: { Authorization: `Bearer ${config.uploadToken}` },
    });
    const verify = await verifyResponse.json();
    const roundTripOk = JSON.stringify(verify.payload) === JSON.stringify(payload);
    if (!roundTripOk) {
        console.error('UYARI: Sunucudan geri okunan veri, yüklenenle birebir eşleşmiyor. Elle kontrol edin.');
        process.exit(1);
    }
    console.log('Doğrulama başarılı — veri sunucuda birebir eşleşiyor.');
}

main().catch(err => {
    console.error('Beklenmeyen hata:', err);
    process.exit(1);
});
