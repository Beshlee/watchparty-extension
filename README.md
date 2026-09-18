# WatchParty — Chrome/Firefox Eklentisi

Herhangi bir film izleme sitesinde çalışan; videoyu arkadaşlarınızla senkron
oynatan (play/pause/ileri-geri) ve yanında canlı sohbet sunan basit bir
tarayıcı eklentisi.

## Nasıl çalışır?

- Sayfada (ve varsa içindeki iframe'lerde) bulunan `<video>` elementi tespit
  edilir, oynat/duraklat/ileri-geri olayları dinlenir.
- Bu olaylar, eklentinin arka plan servisi (`background.js`) üzerinden
  **Firebase Realtime Database**'e (ücretsiz katman) yazılır.
- Odadaki diğer katılımcıların eklentisi bu veriyi ~1 saniyede bir okuyup
  kendi videolarına uygular.
- Kontrol paneli/ikon SADECE sayfanın üst (top) frame'inde gösterilir;
  video genelde bir iframe içinde olsa da senkron arka planda otomatik
  çalışır — ekranda tek bir ikon görürsünüz.
- Sohbet mesajları da aynı veritabanı üzerinden iletilir.

Kendi sunucunuzu kurmanıza gerek yok — sadece ücretsiz bir Firebase projesi
yeterli.

## Kurulum

### 1) Firebase Realtime Database oluştur (ücretsiz)

1. https://console.firebase.google.com adresine gidin, "Add project" ile
   yeni bir proje oluşturun (Google Analytics'i kapatabilirsiniz).
2. Sol menüden **Build → Realtime Database → Create Database**.
3. Bölge seçin; güvenlik kuralları için hangi modu seçerseniz seçin,
   bir sonraki adımda zaten kendi kurallarımızı yükleyeceğiz.
4. Oluşturulan veritabanının üstünde görünen URL'yi kopyalayın.

### 2) config.js dosyasını doldur

`config.example.js` dosyasını `config.js` olarak kopyalayın ve içindeki
`FIREBASE_DB_URL` değerini kendi veritabanı adresinizle değiştirin.
`config.js` `.gitignore`'dadır, yani kendi URL'iniz yanlışlıkla repoya
işlenmez.

```bash
cp config.example.js config.js
```

### 3) Firebase güvenlik kurallarını yükle

Varsayılan "test modu" kuralları veritabanınızı herkesin okuyup
yazabileceği ve **tüm oda listesini keşfedebileceği** şekilde açık bırakır.
Bunun yerine bu depodaki [`database.rules.json`](database.rules.json)
dosyasını kullanın — her oda sadece kodunu bilen tarafından
okunabilir/yazılabilir, listelemeye kapalı, ve yazılan veriler
(isim/mesaj uzunluğu, video state şekli) doğrulanıyor.

1. Firebase Console → projeniz → **Build → Realtime Database → Rules**.
2. Mevcut kuralların tamamını silip `database.rules.json` içeriğini
   yapıştırın.
3. **Publish**'e basın.

### 4) Eklentiyi tarayıcıya yükle

**Önemli:** Klasör, tarayıcının erişebildiği normal bir konumda olmalı
(Masaüstü, Belgelerim vb.) — uygulama içi/korumalı klasörlerden yüklenemez.

**Chrome / Edge (Brave dahil):**

1. `chrome://extensions` adresini açın.
2. Sağ üstten **Geliştirici modu**'nu açın.
3. **Paketlenmemiş öğe yükle** (Load unpacked) butonuna basın.
4. Bu `watchparty-extension` klasörünü seçin.

**Firefox:**

1. `about:debugging#/runtime/this-firefox` adresini açın.
2. **Geçici Eklenti Yükle** (Load Temporary Add-on) ile klasördeki
   `manifest.json` dosyasını seçin.

## Kullanım

1. Bir film izleme sitesinde videoyu açın.
2. Sağ altta beliren 🎬 ikonuna (veya eklenti simgesine) tıklayın.
3. Adınızı yazın, **Oda Oluştur**'a basın — size 6 karakterlik bir kod
   verilir.
4. Bu kodu arkadaşınızla paylaşın; onlar da aynı sitede aynı videoyu açıp
   eklentiyi açsın, kodu **Odaya Katıl** alanına girsin.
5. Kim video üzerinde oynat/duraklat/ileri-geri yaparsa, diğer herkesin
   videosu ~1 saniye içinde eşitlenir. Alttaki kutudan sohbet edebilirsiniz.

## Bilinen sınırlamalar

- **Cross-origin iframe'ler:** Video, sitenin kendisinden farklı bir domain'e
  ait bir `<iframe>` içinde oynatılıyorsa, eklenti bu iframe'e de otomatik
  enjekte olur (`all_frames: true`) ve senkronu orada da yürütür. Ancak
  iframe tamamen özel bir player (canvas/WebGL tabanlı, `<video>` etiketi
  kullanmayan) ise senkron çalışmaz.
- **Senkron hassasiyeti:** ~1 saniyelik anket (polling) aralığı kullanılır;
  1-2 saniyelik sapmalar normaldir ve otomatik düzeltilir.
- **CSP kısıtlı siteler:** Ağ istekleri `background.js` (service worker)
  içinde yapılır, çünkü service worker'lar ziyaret edilen sayfanın CSP
  kurallarına bağlı değildir.
- **Arka plan servisi uykuya dalabilir:** Chrome, MV3 service worker'ını
  bir süre işlem olmayınca uykuya alır. Sekmeyi uzun süre arka planda
  bıraktıktan sonra tekrar aktif ettiğinizde eklenti otomatik olarak
  bağlantıyı tazeler; bu birkaç saniye sürebilir.

## Güvenlik notu

[`database.rules.json`](database.rules.json) kuralları yüklendiğinde:

- Kimse tüm aktif odaların listesini çekemez (enumeration kapalı) — bir
  odaya erişmek için kodunu bilmek gerekir.
- İsim, sohbet mesajı ve video state alanları şekil/uzunluk olarak
  doğrulanır; bozuk veya aşırı büyük veri reddedilir.

Yine de kimlik doğrulama (auth) yok — oda kodunu bilen herkes o odaya
katılabilir. Oda kodları 6 karakter ve geniş bir alfabeden seçildiği için
tahmin etmek pratik değildir, ama kodu paylaşmadığınız sürece güvenlidir.
Ciddi/uzun süreli veya halka açık kullanım için Firebase Authentication
eklemeyi düşünebilirsiniz.

## Dosya yapısı

```
watchparty-extension/
├── manifest.json        # Eklenti tanımı (Manifest V3)
├── background.js        # Firebase REST çağrıları + frame'ler arası relay
├── content.js            # Video tespiti, senkron mantığı, panel/sohbet UI
├── styles.js             # Panelin Shadow DOM stilleri (JS string olarak)
├── config.example.js     # Firebase config şablonu (repoya işlenir)
├── config.js              # Kendi Firebase DB URL'iniz (.gitignore'da, sizde kalır)
├── database.rules.json   # Firebase Realtime Database güvenlik kuralları
├── LICENSE               # MIT lisansı
└── README.md
```

## Lisans

[MIT](LICENSE)
