# Salt-okunur mobil üretim planı

Bu Worker son üretim planını D1 içinde tutar. Görüntüleme şifreyle, masaüstü
uygulamasından yükleme ise ayrı bir gizli anahtarla korunur.

## İlk kurulum

Cloudflare hesabında oturum açtıktan sonra proje kökünde:

1. `npx wrangler login`
2. `npx wrangler d1 create casting-plan`
3. Komutun verdiği `database_id` değerini `cloud/wrangler.toml` içine yazın.
4. `npm run cloud:db:init`
5. Üç güçlü ve birbirinden farklı gizli değer oluşturun:
   - `npx wrangler secret put VIEWER_PASSWORD --config cloud/wrangler.toml`
   - `npx wrangler secret put UPLOAD_TOKEN --config cloud/wrangler.toml`
   - `npx wrangler secret put SESSION_SECRET --config cloud/wrangler.toml`
6. `npm run cloud:deploy`

Dağıtım sonunda verilen `https://...workers.dev` adresini ve `UPLOAD_TOKEN`
değerini `%APPDATA%\casting-planner\cloud-plan.config.json` dosyasına yazın:

```json
{
  "url": "https://kenan-metal-casting-plan.HESAP.workers.dev",
  "uploadToken": "UPLOAD_TOKEN_DEGERI"
}
```

Uygulamayı yeniden başlatın ve planda bir değişiklik yapın. Son plan otomatik
olarak yüklenir. Telefon kullanıcıları Worker adresini açıp `VIEWER_PASSWORD`
ile giriş yapar.
