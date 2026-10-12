(function(){
  "use strict";

  var STORAGE_KEY = "maskeleme_istasyonu_sozluk_v1";

  var PATTERNS = {
    jwt:    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    secret: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|(?:pk|sk|rk|ak)_(?:live|test|prod)_[A-Za-z0-9_]{8,}|sec(?:ret)?_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{10,})\b|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/g,
    kep:    /\b[\w.+-]+@hs\d{2}\.kep\.tr\b/gi,
    // Adayı sınırlı uzunlukta al; aşağıda ülkenin sabit uzunluğunda kesip
    // devamındaki cümleyi koruyoruz. 'i' küçük harfli IBAN'lar içindir.
    iban:   /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/gi,
    // Çok etiketli alan adları için: a.b@alt.ornek.com.tr tamamı yakalanmalı
    email:  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
    uuid:   /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    mac:    /\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b/gi,
    ip:     /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    kripto: /\b(?:0x[a-fA-F0-9]{40}|bc1[a-z0-9]{25,62})\b/g,
    ykn:    /\b99\d{9}\b/g,
    vkn:    /\b\d{10}\b/g,
    imei:   /\b\d{15}\b/g,
    plaka:  /\b(?:0[1-9]|[1-7]\d|8[01])\s?[A-Z]{1,3}\s?\d{2,5}\b/g,
    // 1. alternatif: cep (5xx).  2. alternatif: TR sabit hat — alan kodu
    // listesi dar tutuldu ve baştaki 0 zorunlu, yoksa her 10 haneli sayı
    // telefon sanılırdı.  3. alternatif: + ile başlayan uluslararası.
    // Sabit hat da kişisel veridir ve personel/müşteri tablolarında yaygındır.
    // (?<!...) olmadan "TRK202609140001" içinden "02609140001" koparılıyordu:
    // maskeli metinde takip kodunun yarısı açıkta kalıyordu.
    phone:  /(?<![A-Za-z0-9])(?:(?:\+?\d{1,3}[\s.-]?)?0?5\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b|\(?0(?:2[1234689]\d|3[1234568]\d|4[1-8]\d)\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b|\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2})?\b)/g,
    ssn:    /\b\d{3}-\d{2}-\d{4}\b/g,
    // İlk alternatif American Express içindir: standart yazımı 4-6-5'tir
    // (3782 822463 10005). İkinci alternatif üç adet 4'lü grup beklediği
    // için bu biçimi hiç yakalamıyordu; imei doğrulayıcısı da 3[47] ile
    // başlayanları "karta bırak" diye eliyordu — iki kapı da kapalıydı.
    card:   /\b3[47]\d{2}[ -]?\d{6}[ -]?\d{5}\b|\b(?:\d{4}[ -]?){3}\d{1,7}\b/g,
    tckn:   /\b[1-9]\d{10}\b/g,
    // Üç ayrı düzeltme var, hepsi ölçümle doğrulandı:
    //
    // 1) {1,5} / {1,9} sınırı — ESKİDEN sınırsız * vardı ve para birimi eki
    //    bulunamayınca her başlangıç noktası için binlik grupları geri
    //    izliyordu: O(n²). Virgülle ayrılmış sayı yığınında 40 KB = 1.3 sn,
    //    200 KB = 17 sn ana thread donması. Sınır, başlangıç başına taramayı
    //    sabitleyip toplamı O(n) yapıyor. 5 binlik grup = 10^18, gerçek bir
    //    tutar için fazlasıyla yeterli.
    // 2) (?=(...))\1 atomik grup taklidi — kalan geri izlemeyi de kesiyor.
    // 3) |\d{1,9} alternatifi — ayraçsız yazılan tutarlar. Eskiden
    //    \d{1,3} üst sınırı yüzünden "2500 USD" yalnızca "500 USD" olarak
    //    yakalanıyor, başındaki hane maskelenmeden kalıyordu.
    //
    // Ondalık kısım atomik grubun DIŞINDA kalmalı, yoksa "1.234,56 TL" bozulur.
    amount: /(?:[₺$€]\s?(?:\d{1,3}(?:[.,]\d{3}){0,5}|\d{1,9})(?:[.,]\d{1,2})?)|(?:(?=((?:\d{1,3}(?:[.,]\d{3}){1,5}|\d{1,9})))\1(?:[.,]\d{1,2})?\s?(?:₺|TL|tl|USD|EUR|\$|€))/g,
    date:   /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
    // Pasaport (TR): 1 harf + 8 hane. Tek başına çok genel olduğu için
    // aşağıda CONTEXT_REQUIRED ile bağlama bağlanır.
    pasaport: /\b[A-Z]\d{8}\b/g,
    // Kurum içi kodlar: müşteri no, sipariş no, reçete no, dosya no.
    // Tek başlarına PII değil ama kişiyle eşleştirilebilir — bağlam şart.
    // Kurum içi kodlar: "M-102938", "EHL-2026-778899", "TRK202609140001".
    kurum_kodu: /\b[A-Z]{1,6}-[A-Z0-9]{2,12}(?:-[A-Z0-9]{2,12}){0,2}\b|\b[A-Z]{2,6}\d{6,}\b/g,
    // SWIFT/BIC: 4 banka + 2 ülke + 2 konum (+3 şube)
    swift: /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g,
    // Enlem,boylam çifti
    koordinat: /\b-?\d{1,3}\.\d{4,8}\s*,\s*-?\d{1,3}\.\d{4,8}\b/g,
    // SSH açık anahtarı
    ssh: /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+\/=]{20,}(?:\s+\S+)?/g
  };

  // M-04: Bozulmuş e-posta biçimleri ([at]/[dot], (at)/(dot))
  var OBFUSCATED_EMAIL_RE = /\b([a-zA-Z0-9_.+-]+)\s*(?:\[\s*at\s*\]|\(\s*at\s*\)|\[\s*@\s*\]|\(@\))\s*([a-zA-Z0-9-]+(?:\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\.)\s*[a-zA-Z0-9-]+)+)\b/gi;
  // M-05: Veritabanı bağlantı adresleri
  var DB_CONN_RE = /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s"'`]+:[^\s"'`]+@[^\s"'`]+\b/gi;

  // F2-01: Görünmez karakterler (Zero-Width Space, ZWNJ, ZWJ, BOM, Soft Hyphen, Bidi Controls)
  var INVISIBLE_CHARS_RE = /[\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2060\uFEFF\u00AD]/g;

  function stripInvisibleChars(str){
    if(typeof str !== "string") return str;
    return str.replace(INVISIBLE_CHARS_RE, "");
  }

  // M-06: Bağlamsal isim tespiti için kişi adı olamayacak Türkçe, İngilizce ve Almanca durak kelimeler
  var NON_NAME_WORDS = new Set([
    "Bu", "Şu", "O", "Bir", "Her", "Tüm", "Bütün", "Biz", "Siz", "Onlar",
    "Bugün", "Dün", "Yarın", "Toplantı", "Toplantıya", "Toplantıda",
    "Rapor", "Raporu", "Raporun", "Raporunu", "Sözleşme", "Sözleşmesi", "Sözleşmeyi",
    "Proje", "Projesi", "Projenin", "Projede",
    "Sistem", "Sistemi", "Sistemde", "Servis", "Servisi", "Serviste",
    "Şirket", "Şirketi", "Şirketin", "Veri", "Verisi", "Veriler",
    "Tablo", "Tablosu", "Dosya", "Dosyası", "Dosyada",
    "Adres", "Adresi", "Fatura", "Faturası", "Faturayı",
    "Telefon", "Telefonu", "Kod", "Kodu", "Denetim", "Denetimi",
    "Finans", "Finansı", "Güvenlik", "Güvenliği", "Genel", "Mali",
    "Türkiye", "İstanbul", "Ankara", "İzmir", "Bursa", "Antalya",
    "React", "TypeScript", "JavaScript", "Python", "Node", "Postgres",
    "CSV", "JSON", "API", "HTTP", "HTTPS", "URL", "Web", "Port", "Host",
    "Server", "Client", "Token", "Bearer", "Auth", "Key", "Secret",
    "Evet", "Hayır", "Yok", "Var", "İle", "Veya", "Gibi", "İçin", "Kadar",
    "Göre", "Sonra", "Önce", "Karşı", "Doğru", "Ayrı", "Fazla", "Daha",
    "Çok", "Az", "İlk", "Son", "Yeni", "Eski", "Aynı", "Farklı",
    // İngilizce ve Almanca durak kelimeler (F2-03)
    "The", "This", "That", "These", "Those", "There", "Here", "Every", "All", "Some", "Any", "Many", "Much", "Other", "Another",
    "Today", "Yesterday", "Tomorrow", "Report", "System", "Service", "Company", "Data", "Table", "File", "Address", "Phone", "Project",
    "Der", "Die", "Das", "Ein", "Eine", "Dieser", "Diese", "Dieses", "Alle", "Heute", "Gestern", "Morgen",
    "Bericht", "Projekt", "System", "Firma", "Tabelle", "Datei"
  ]);

  var TITLES = new Set([
    "Avukat", "Av", "Doktor", "Dr", "Prof", "Profesör", "Doç", "Doçent",
    "Uzm", "Uzman", "Mühendis", "Mimar", "Müdür", "Müdürü", "Başkan", "Başkanı",
    "Yönetici", "Danışman", "Direktör", "Sayın", "Sn", "Bay", "Bayan",
    // İngilizce & Almanca Unvanlar (F2-03)
    "Mr", "Mrs", "Ms", "Miss", "Sir", "Madam", "Director", "Manager", "Engineer", "Consultant",
    "Herr", "Frau", "Ing", "Dipl", "Direktor", "Geschäftsführer"
  ]);
  var PREFIX = { iban:"IBAN", email:"EPOSTA", phone:"TEL", ssn:"SSN", card:"KART", tckn:"TCKN", amount:"TUTAR", date:"TARIH",
    kep:"KEP", uuid:"UUID", mac:"MAC", ip:"IP", kripto:"CUZDAN", ykn:"YKN", vkn:"VKN", imei:"IMEI", plaka:"PLAKA",
    manual:"TERIM", code:"DEGISKEN", literal:"METIN", secim:"SECIM", name:"KISI", address:"ADRES",
    jwt:"JWT", secret:"GIZLI", pasaport:"PASAPORT", kurum_kodu:"KOD", kullanici:"KULLANICI",
    swift:"SWIFT", koordinat:"KONUM", ssh:"SSH", hesap:"HESAP", sirket:"SIRKET" };
  /* İngilizce arayüzde yer tutucular İngilizce yazılır ([EMAIL_1]). Türkiye'ye
     özgü kimlikler (TCKN, VKN, YKN, KEP) adını korur. Önek tek kelime büyük
     harftir: yer tutucu biçimi [A-Z]+_\d+. Geri açma sözlükten yapıldığı için
     dil değişse de eski [EPOSTA_1] ve yeni [EMAIL_2] birlikte açılır; sayaç
     tip başına ortaktır, aynı yer tutucu iki kez üretilmez. */
  var PREFIX_EN = { iban:"IBAN", email:"EMAIL", phone:"PHONE", ssn:"SSN", card:"CARD", tckn:"TCKN", amount:"AMOUNT", date:"DATE",
    kep:"KEP", uuid:"UUID", mac:"MAC", ip:"IP", kripto:"WALLET", ykn:"YKN", vkn:"VKN", imei:"IMEI", plaka:"PLATE",
    manual:"TERM", code:"VARIABLE", literal:"TEXT", secim:"SELECTION", name:"NAME", address:"ADDRESS",
    jwt:"JWT", secret:"SECRET", pasaport:"PASSPORT", kurum_kodu:"CODE", kullanici:"USER",
    swift:"SWIFT", koordinat:"LOCATION", ssh:"SSH", hesap:"ACCOUNT", sirket:"COMPANY" };
  // Ayar gelene kadar tarayıcı dili (dil.js ile aynı kural)
  var yerTutucuDili = (typeof navigator !== "undefined" && navigator.language && !/^tr\b/i.test(navigator.language)) ? "en" : "tr";
  function setPlaceholderLanguage(dil){ if(dil === "en" || dil === "tr") yerTutucuDili = dil; }
  function onekAl(type){
    var tablo = yerTutucuDili === "en" ? PREFIX_EN : PREFIX;
    return tablo[type] || (yerTutucuDili === "en" ? "TERM" : "TERIM");
  }
  // Sıra özelden genele olmalı: KEP e-postadan, YKN de TCKN'den önce gelir
  // (her biri diğerinin alt kümesidir). IMEI de karttan önce gelir, çünkü
  // 15 haneli Luhn'lu bir sayıyı kart kalıbı da yakalar.
  var ORDER = ["jwt","secret","ssh","pasaport","swift","koordinat","kurum_kodu","kep","email","iban","uuid","mac","ip","kripto","ykn","tckn","vkn","imei","card","phone","ssn","plaka","amount","date"];
  var TEXT_REPLACE_TYPES = ["manual","code","literal","secim","name","address"];
  var TYPE_LABELS = { manual:"manuel", code:"kod", literal:"metin", secim:"seçim", iban:"iban", email:"e-posta", phone:"telefon", ssn:"ssn", card:"kredi kartı", tckn:"tckn", amount:"tutar", date:"tarih",
    kep:"kep adresi", uuid:"uuid", mac:"mac adresi", ip:"ip adresi", kripto:"kripto cüzdan", ykn:"yabancı kimlik no", vkn:"vergi kimlik no", imei:"imei", plaka:"plaka",
    name:"kişi adı", address:"adres", jwt:"jwt", secret:"gizli anahtar",
    pasaport:"pasaport no", kurum_kodu:"kurum kodu", kullanici:"kullanıcı adı",
    swift:"swift/bic", koordinat:"konum", ssh:"ssh anahtarı", hesap:"hesap no", sirket:"şirket" };
  var CONFIDENCE = { tckn:"high", iban:"high", card:"high", ykn:"high", vkn:"high", imei:"high",
    email:"medium", phone:"medium", ssn:"medium", amount:"medium", date:"medium",
    kep:"medium", uuid:"medium", mac:"medium", ip:"medium", kripto:"medium", plaka:"medium",
    jwt:"high", secret:"high", manual:"low", code:"low", literal:"low", secim:"low", name:"low", address:"low",
    pasaport:"medium", kurum_kodu:"low", kullanici:"medium",
    swift:"medium", koordinat:"medium", ssh:"high", hesap:"medium", sirket:"low" };
  var CONFIDENCE_LABELS = { high:"yüksek güven", medium:"orta güven", low:"düşük güven" };

  var ALL_ENABLED = {};
  ORDER.forEach(function(k){ ALL_ENABLED[k] = true; });
  // Kalıpla değil anahtar kelimeyle yakalanan tipler ORDER'da yer almaz,
  // ama varsayılan olarak açık olmalılar.
  ["kullanici","name","address","hesap","sirket"].forEach(function(k){ ALL_ENABLED[k] = true; });

  function isValidTCKN(raw){
    var cleaned = stripInvisibleChars(raw);
    if(!/^\d{11}$/.test(cleaned)) return false;
    var d = [];
    for(var i=0;i<11;i++){ d.push(parseInt(cleaned[i],10)); }
    if(d[0] === 0) return false;
    var oddSum = d[0]+d[2]+d[4]+d[6]+d[8];
    var evenSum = d[1]+d[3]+d[5]+d[7];
    var digit10 = ((oddSum*7 - evenSum) % 10 + 10) % 10;
    if(digit10 !== d[9]) return false;
    var sum10 = 0;
    for(var k=0;k<10;k++){ sum10 += d[k]; }
    return (sum10 % 10) === d[10];
  }

  function isValidIBANChecksum(raw){
    var iban = stripInvisibleChars(raw).replace(/\s+/g,"").toUpperCase();
    var expectedLength = TCat && TCat.ibanLength ? TCat.ibanLength(iban.slice(0,2)) : 0;
    if(!expectedLength || iban.length !== expectedLength || !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
    var rearranged = iban.slice(4) + iban.slice(0,4);
    var numeric = "";
    for(var i=0;i<rearranged.length;i++){
      var ch = rearranged[i];
      if(ch >= "0" && ch <= "9"){ numeric += ch; }
      else { numeric += (ch.charCodeAt(0) - 55).toString(); }
    }
    var rem = 0;
    for(var j=0;j<numeric.length;j++){
      rem = (rem*10 + parseInt(numeric[j],10)) % 97;
    }
    return rem === 1;
  }

  function isValidLuhn(raw){
    var digits = stripInvisibleChars(raw).replace(/[^\d]/g,"");
    if(digits.length < 13 || digits.length > 19) return false;
    var sum = 0, alt = false;
    for(var i=digits.length-1;i>=0;i--){
      var n = parseInt(digits[i],10);
      if(alt){ n*=2; if(n>9){ n-=9; } }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  var TCat = window.TypeCatalog;

  function splitIbanCandidate(raw){
    var cleaned = stripInvisibleChars(raw);
    var expectedLength = TCat && TCat.ibanLength ? TCat.ibanLength(cleaned.slice(0,2)) : 0;
    if(!expectedLength) return null;
    var count = 0;
    for(var i=0;i<raw.length;i++){
      var ch = raw[i];
      if(/[A-Z0-9]/i.test(ch) && !INVISIBLE_CHARS_RE.test(ch)){ count++; }
      INVISIBLE_CHARS_RE.lastIndex = 0;
      if(count === expectedLength){ return { iban:raw.slice(0,i+1), suffix:raw.slice(i+1) }; }
    }
    return null;
  }

  var CHECKSUM_VALIDATORS = {
    tckn: isValidTCKN,
    iban: isValidIBANChecksum,
    card: function(v){
      // "0000 0000 0000 0000" Luhn'dan geçer ama kart değildir. Bu yüzden
      // IBAN'ın ortasını yiyip baş ve sonunu açıkta bırakıyordu.
      var d = String(stripInvisibleChars(v)).replace(/\D/g, "");
      if(/^(\d) +$/.test(d)) return false;
      return isValidLuhn(v);
    },
    ykn:  function(v){ var c = stripInvisibleChars(v); return TCat ? TCat.validators.ykn(c) : (/^99\d{9}$/.test(c) && isValidTCKN(c)); },
    vkn:  function(v){ var c = stripInvisibleChars(v); return TCat ? TCat.validators.vkn(c) : false; },
    // Amex de 15 hanelidir ve Luhn'dan geçer — onu IMEI sanma, karta bırak
    imei: function(v){ var c = stripInvisibleChars(v); return !/^3[47]/.test(c) && (TCat ? TCat.validators.imei(c) : false); }
  };

  // Bazı tipler tek başına ayırt edici değildir: çıplak 10 haneli bir sayının
  // VKN checksum'ından geçme ihtimali %10, 15 haneli sayının Luhn'dan geçme
  // ihtimali de %10'dur. Bunlarda eşleşmenin hemen öncesinde anahtar kelime aranır.
  var CONTEXT_REQUIRED = {
    vkn:  /(vergi|vkn|tax|vat)[^\n]{0,25}$/i,
    imei: /(imei|cihaz|device)[^\n]{0,25}$/i,
    pasaport: /(pasaport|passport)[^\n]{0,25}$/i,
    kurum_kodu: /(müşteri|musteri|sipariş|siparis|reçete|recete|dosya|sicil|kayıt|kayit|abone|üyelik|uyelik|takip|ehliyet|poliçe|police|sözleşme|sozlesme|hasta|randevu|tesisat|referans|kod)[^\n]{0,25}$/i,
    swift: /(swift|bic)[^\n]{0,25}$/i,
    koordinat: /(konum|koordinat|location|gps|enlem|teslimat)[^\n]{0,40}$/i
  };

  /* Checksum TUTMAYAN ama bağlamı güçlü olan değerler.
     "TCKN numaram 12345678910" cümlesindeki numarayı checksum tutmadı diye
     metinde bırakmak, hiç maskelememekten daha tehlikelidir: kullanıcıya
     yanlış güven verir. Yazım hatalı, test amaçlı üretilmiş veya kısmen
     anonimleştirilmiş numaralar da bu yoldan yakalanır. Böyle maskelenenler
     "doğrulanmadı" işareti alır; güven etiketi checksum'lılardan ayrışır. */
  var CONTEXT_RESCUE = {
    tckn: /(t\.?\s*c\.?\s*kimlik|tckn|kimlik\s*n[ou]|vatandaşlık|\btc\s*[:=])[^\n]{0,25}$/i,
    ykn:  /(yabancı\s*kimlik|yabanci\s*kimlik|ykn)[^\n]{0,25}$/i,
    iban: /(iban|hesap\s*n[ou]|hesap\s*numara)[^\n]{0,25}$/i,
    vkn:  /(vergi|vkn|tax|vat)[^\n]{0,25}$/i,
    card: /(kart|card)[^\n]{0,25}$/i,
    imei: /(imei|cihaz|device)[^\n]{0,25}$/i
  };

  /* Eşleşmenin hemen öncesindeki 30 karakter. Bağlam testleri replace() ve
     exec() yollarında aynı pencereyi görsün diye tek yerde durur. */
  function oncekiBaglam(kaynak, yer){
    return kaynak.slice(Math.max(0, yer - 30), yer);
  }

  var glossary = [];
  var counters = {};
  var excluded = [];

  function uid(){ return Math.random().toString(36).slice(2,10); }

  function loadState(){
    try{
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if(raw){
        var parsed = JSON.parse(raw);
        if(Array.isArray(parsed)) return { glossary: parsed, counters: null, excluded: [] };
        if(parsed && Array.isArray(parsed.glossary)) return { glossary: parsed.glossary, counters: parsed.counters || null, excluded: parsed.excluded || [] };
      }
    }catch(e){}
    return null;
  }

  function saveState(){
    // Uzantıda tek yazıcı service worker'dır; web sayfasının deposuna PII yazma.
    if(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) return;
    try{ window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ glossary: glossary, counters: counters, excluded: excluded })); }catch(e){}
  }

  function getState(){
    return JSON.parse(JSON.stringify({ glossary: glossary, counters: counters, excluded: excluded }));
  }

  function setState(state){
    state = state || {};
    glossary = state.glossary || [];
    counters = Object.assign(Object.create(null), state.counters || {});
    excluded = state.excluded || [];
    seedCountersFromGlossary();
  }

  /* Sözlük ve hariç tutma dizinleri. maskOne, isExcluded, geri açma ve özet
     her çağrıda listeyi baştan tarıyordu: 227 KB / 4.900 kayıtlı bir metinde
     bu tek başına saniyeler sürüyordu. Dizin, dizi nesnesi ya da uzunluğu
     değişince kendiliğinden yeniden kurulur (setState, filter ile silme,
     dışarıdan push); yerinde değişiklik yapan kod dizinGecersiz() çağırır. */
  var sozlukDizini = null;
  var haricDizini = null;
  function dizinGecersiz(){ sozlukDizini = null; haricDizini = null; }
  function tipDegerAnahtari(type, value){ return type + "\u0000" + value; }

  function dizin(){
    if(!sozlukDizini || sozlukDizini.dizi !== glossary || sozlukDizini.uzunluk !== glossary.length){
      var tipDeger = new Map(), yerTutucu = new Map();
      for(var i=0; i<glossary.length; i++){
        var g = glossary[i];
        var k = tipDegerAnahtari(g.type, g.real);
        if(!tipDeger.has(k)) tipDeger.set(k, g);             // ilk kayıt kazanır (eski find ile aynı)
        if(!yerTutucu.has(g.placeholder)) yerTutucu.set(g.placeholder, g);
      }
      sozlukDizini = { dizi: glossary, uzunluk: glossary.length, tipDeger: tipDeger, yerTutucu: yerTutucu };
    }
    return sozlukDizini;
  }

  // Sözlüğe ekler ve dizini yeniden kurmadan günceller (her eklemede O(G) kurulum olmasın).
  function sozlugeEkle(entry){
    var d = dizin();
    glossary.push(entry);
    d.uzunluk = glossary.length;
    var k = tipDegerAnahtari(entry.type, entry.real);
    if(!d.tipDeger.has(k)) d.tipDeger.set(k, entry);
    if(!d.yerTutucu.has(entry.placeholder)) d.yerTutucu.set(entry.placeholder, entry);
  }

  function isExcluded(type, value){
    if(!excluded.length) return false;
    if(!haricDizini || haricDizini.dizi !== excluded || haricDizini.uzunluk !== excluded.length){
      var kume = new Set();
      excluded.forEach(function(e){ kume.add(tipDegerAnahtari(e.type, e.value)); });
      haricDizini = { dizi: excluded, uzunluk: excluded.length, kume: kume };
    }
    return haricDizini.kume.has(tipDegerAnahtari(type, value));
  }

  function seedCountersFromGlossary(){
    glossary.forEach(function(g){
      var m = /_(\d+)\]$/.exec(g.placeholder);
      if(m){
        var n = parseInt(m[1],10);
        if(!counters[g.type] || n > counters[g.type]){ counters[g.type] = n; }
        Object.keys(PREFIX).forEach(function(type){
          if(g.placeholder === "[" + PREFIX[type] + "_" + n + "]" || g.placeholder === "[" + PREFIX_EN[type] + "_" + n + "]"){
            counters[type] = Math.max(counters[type] || 0, n);
          }
        });
      }
    });
  }

  function nextPlaceholder(type){
    var prefix = onekAl(type);
    counters[type] = (counters[type] || 0) + 1;
    var ph = "[" + prefix + "_" + counters[type] + "]";
    // Aynı önek iki tipte kullanılırsa (ör. kod/değişken) çakışma olmasın
    while(dizin().yerTutucu.has(ph)){
      counters[type]++;
      ph = "[" + prefix + "_" + counters[type] + "]";
    }
    return ph;
  }

  function maskOne(type, value, dogrulanmadi){
    if(!value || /^\[[A-Z]+_\d+\]$/.test(value) || isExcluded(type, value)) return value;
    var existing = dizin().tipDeger.get(tipDegerAnahtari(type, value));
    if(existing) return existing.placeholder;
    var placeholder = nextPlaceholder(type);
    var entry = { id: uid(), real: value, placeholder: placeholder, type: type };
    // Checksum yerine bağlamla yakalandıysa arayüzde ayrışsın diye işaretlenir.
    if(dogrulanmadi) entry.dogrulanmadi = true;
    sozlugeEkle(entry);
    return placeholder;
  }

  function init(){
    var loaded = loadState();
    if(loaded){
      glossary = loaded.glossary;
      excluded = loaded.excluded || [];
      if(loaded.counters){ counters = loaded.counters; }
      else { seedCountersFromGlossary(); }
    } else {
      // İlk açılış örnek sözlüğü: TR ve EN örnek metnindeki kişi ve şirket,
      // arayüz dilinin önekiyle ([KISI_1] / [NAME_1]). Dil sonradan değişince
      // örnek metin de değişir; iki örnek kişi de sözlükte olduğundan örnek
      // çıktıda isim açıkta kalmaz.
      var en = yerTutucuDili === "en";
      var kisiler = en ? ["John Smith", "Ahmet Yılmaz"] : ["Ahmet Yılmaz", "John Smith"];
      glossary = kisiler.map(function(ad, i){
        return { id: uid(), real: ad, placeholder: "[" + onekAl("name") + "_" + (i + 1) + "]", type: "manual" };
      });
      glossary.push({ id: uid(), real: en ? "ABC Payments Inc." : "ABC Ödeme Sistemleri",
                      placeholder: "[" + onekAl("sirket") + "_1]", type: "manual" });
      seedCountersFromGlossary();
    }
  }

  /* Kişi ve adres kalıpla değil BAĞLAMLA yakalanır: "Ali Yılmaz" tek başına
     bir isim değildir, "ruhsat sahibi Ali Yılmaz" ise öyledir. Anahtar kelime
     şartı, metindeki her büyük harfli kelime çiftinin maskelenmesini önler.
     Desenler regex literali olarak yazılır — string içinde "\b" backspace,
     "\s" ise düz 's' harfi olurdu. */
  var KISI_RE = /(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])(?:[Aa]d[ \t]*[Ss]oyad|[Aa]dı[ \t]*[Ss]oyadı|[Aa]dım|[Aa]dim|[Mm]üşteri|[Mm]usteri|[Çç]alışan|[Cc]alisan|[Pp]ersonel|[Hh]asta|[Ss]ayın|[Ss]ayin|[Ss]n\.|[Dd]oktor|[Hh]ekim|[Aa]lıcısı|[Aa]lıcı|[Aa]licisi|[Aa]lici|[Gg]önderici|[Gg]onderici|[Ss]ahibi|[Yy]etkili|[Kk]işi|[Kk]isi|[İi]sim|[Aa]dı|[Aa]di)(?:[ \t]+[Aa]d[ıi])?[ \t:,-]+["'«]?((?:(?:Dr|Doç|Doc|Prof|Av|Uzm|Op|Bay|Bayan)\.?[ \t]+)?[A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:[ \t]+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+){1,3})/g;

  /* Adres sonu: başka bir alan etiketi ya da cümle sonu.
     1) Açıkça "Adres:" etiketli olanlar — sokak işaretçisi aranmaz.
     2) Etiketsiz ama mahalle/sokak/cadde işaretçisi taşıyanlar. */
  /* Adres gövdesi noktada bitmez: "Mah.", "Cad.", "No." kısaltmaları nokta
     içerir. Bu yüzden gövde yalnızca ';', satır sonu, başka bir alan etiketi
     (tel/e-posta/iban...) veya metin sonunda biter; cümle sonundaki nokta
     geri çağrıda kırpılır. */
  var ADRES_ETIKETLI_RE = /(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])(adres\w*)(\s*[:=-]\s*)([^;\n]{5,160}?)(?=\s*,?\s*(?:tel|telefon|gsm|e-?posta|e-?mail|mail|iban|tckn|vkn)\b|[;\n]|$)/gi;
  // İşaretçi tam kelime olmalı: "sokakta trafik" adres değildir. Kısaltmalarda
  // ("mah.", "cad.") noktanın kendisi sınırdır. Önek en fazla 4 kelime geriye
  // gider; yoksa cümlenin tamamını yutardı.
  var ADRES_ISARETLI_RE = /((?:[^\s,;\n]+[ \t]+){0,4}(?:(?:mahallesi|mahalle|sokak|sokağı|sokagi|caddesi|cadde|bulvarı|bulvari|apartmanı|apartmani|sitesi)\b|(?:mah|mh|sok|sk|cad|cd|bulv|blv|apt)\.)(?:[^.;\n]|(?:mah|mh|cad|cd|sok|sk|bulv|blv|apt|no|kat)\.)*?)(?=\s*,?\s*(?:tel|telefon|gsm|e-?posta|e-?mail|mail|iban|tckn|vkn)\b|[;\n]|\.\s*$|$)/gi;

  /* Gövdenin sonundaki cümle noktasını adresten ayırır. */
  function adresKirp(govde){
    var temiz = govde.trim();
    var kuyruk = "";
    if(/\.$/.test(temiz)){ kuyruk = "."; temiz = temiz.slice(0, -1).trim(); }
    return { adres: temiz, kuyruk: kuyruk };
  }

  /* =========================================================================
   * M-02: TEK ADAY ÇIKARMA HATTI (detectCandidates)
   * Hem maskText hem inspectSensitive aynı aday listesini kullanır.
   * Özgün span [start, end], tür, kural, güven düzeyi ve gerekçe üretir.
   * Çakışan adayları öncelik, doğrulama ve kapsama göre tek yerde çözer.
   * ========================================================================= */
  function extractCandidatesFromText(rawText, enabledMap){
    var enabled = enabledMap || ALL_ENABLED;
    if(!rawText || typeof rawText !== "string") return [];
    var rawCandidates = [];

    // 0. Önceden maskelenmiş etiketlerin konumları [KISI_1], [TCKN_2] vb.
    // Hiçbir aday bu etiketlerin içine düşmemeli. Konum işareti dizisi,
    // maskelenmiş metni yeniden taramada aday × placeholder karesini önler.
    var yerTutucuIsareti = null;
    var phRe = /\[[A-Z]+_\d+\]/g;
    var phm;
    while((phm = phRe.exec(rawText))){
      if(!yerTutucuIsareti) yerTutucuIsareti = new Uint8Array(rawText.length);
      yerTutucuIsareti.fill(1, phm.index, phm.index + phm[0].length);
    }
    function isInsidePlaceholder(start, end){
      if(!yerTutucuIsareti) return false;
      for(var i=start; i<end; i++){ if(yerTutucuIsareti[i]) return true; }
      return false;
    }

    // 1. Veritabanı bağlantı URI'leri (M-05)
    if(enabled.secret){
      var dbm;
      while((dbm = DB_CONN_RE.exec(rawText))){
        rawCandidates.push({
          span: [dbm.index, dbm.index + dbm[0].length],
          text: dbm[0],
          type: "secret",
          rule: "db_connection_uri",
          confidence: "high",
          dogrulanmadi: false,
          score: 1.0,
          reason: "Veritabanı bağlantı adresi (şifre içerir)"
        });
      }
      DB_CONN_RE.lastIndex = 0;
    }

    // 2. Yapılandırılmış sırlar (JSON ve Log) (M-05)
    if(enabled.secret){
      var keys = "(?:[a-z0-9]+[_-]){0,3}(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|connection[_-]?string)";
      var jsonSecretRe = new RegExp('(\\"(?:' + keys + ')\\"\\s*:\\s*\\")([^\\"\\r\\n]+)(\\")', "gi");
      var jsm;
      while((jsm = jsonSecretRe.exec(rawText))){
        var valStart = jsm.index + jsm[1].length;
        rawCandidates.push({
          span: [valStart, valStart + jsm[2].length],
          text: jsm[2],
          type: "secret",
          rule: "json_secret_key",
          confidence: "high",
          dogrulanmadi: false,
          score: 1.0,
          reason: "JSON gizli anahtar değeri"
        });
      }

      var logSecretRe = new RegExp('\\b(' + keys + ')(\\s*[=:]\\s*)(?!\\[)(Bearer\\s+[^\\s,;]+|[^\\s,;}]{6,})', "gi");
      var lsm;
      while((lsm = logSecretRe.exec(rawText))){
        var lStart = lsm.index + lsm[1].length + lsm[2].length;
        rawCandidates.push({
          span: [lStart, lStart + lsm[3].length],
          text: lsm[3],
          type: "secret",
          rule: "log_secret_key",
          confidence: "high",
          dogrulanmadi: false,
          score: 0.95,
          reason: "Log gizli parametre değeri"
        });
      }
    }

    // 3. Yapılandırılmış kişi isimleri (JSON ve CSV) (M-05)
    if(enabled.name){
      var jsonNameRe = /("(?:\w+[_-])*(?:customer[_-]?name|musteri[_-]?(?:adi|ismi)?|ad[_-]?soyad|client[_-]?name|full[_-]?name)"\s*:\s*")([^"\r\n]+)(")/gi;
      var jnm;
      while((jnm = jsonNameRe.exec(rawText))){
        var nStart = jnm.index + jnm[1].length;
        rawCandidates.push({
          span: [nStart, nStart + jnm[2].length],
          text: jnm[2],
          type: "name",
          rule: "json_customer_name",
          confidence: "high",
          dogrulanmadi: false,
          score: 0.95,
          reason: "JSON müşteri adı alanı"
        });
      }

      // CSV başlığı tespiti.
      // Satırlar gerçek başlangıç konumlarıyla tutulur: CRLF'de satır sonu iki
      // karakterdir; "+1" varsaymak her satırda span'i bir karakter kaydırıyor,
      // satır sonlarını yutup isimlerin son harflerini açıkta bırakıyordu.
      var csvLines = [];
      var satirBasi = 0;
      var satirSonuRe = /\r?\n/g;
      var ssm;
      while((ssm = satirSonuRe.exec(rawText))){
        csvLines.push({ text: rawText.slice(satirBasi, ssm.index), start: satirBasi });
        satirBasi = ssm.index + ssm[0].length;
      }
      csvLines.push({ text: rawText.slice(satirBasi), start: satirBasi });
      if(csvLines.length > 1){
        var headerLine = csvLines[0].text;
        var delim = headerLine.indexOf(",") !== -1 ? "," : (headerLine.indexOf(";") !== -1 ? ";" : (headerLine.indexOf("\t") !== -1 ? "\t" : null));
        if(delim){
          var headers = headerLine.split(delim).map(function(h){ return h.trim().toLowerCase(); });
          var nameColIdx = headers.findIndex(function(h){ return /^(?:ad[_-]?soyad|musteri|müşteri|isim|ad)$/i.test(h); });
          if(nameColIdx !== -1){
            for(var li=1; li<csvLines.length; li++){
              var line = csvLines[li].text;
              var lineOffset = csvLines[li].start;
              if(line.trim()){
                var cols = line.split(delim);
                if(nameColIdx < cols.length){
                  var cellVal = cols[nameColIdx].trim();
                  if(cellVal.length >= 3 && !/^\[[A-Z]+_\d+\]$/.test(cellVal)){
                    var cellColStart = 0;
                    for(var ci=0; ci<nameColIdx; ci++){ cellColStart += cols[ci].length + delim.length; }
                    // Hücre başındaki boşluk atlanır. Eskiden burada koşulu hiç
                    // değişmeyen bir while vardı: "tel, isim" gibi virgül+boşluklu
                    // bir metin sonsuz döngüye girip sohbet sekmesini donduruyordu.
                    cellColStart += /^\s*/.exec(cols[nameColIdx])[0].length;
                    rawCandidates.push({
                      span: [lineOffset + cellColStart, lineOffset + cellColStart + cellVal.length],
                      text: cellVal,
                      type: "name",
                      rule: "csv_name_column",
                      confidence: "high",
                      dogrulanmadi: false,
                      score: 0.9,
                      reason: "CSV ad/soyad sütunu"
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    // 4. Bozulmuş e-posta biçimleri (M-04)
    if(enabled.email){
      var obfm;
      while((obfm = OBFUSCATED_EMAIL_RE.exec(rawText))){
        rawCandidates.push({
          span: [obfm.index, obfm.index + obfm[0].length],
          text: obfm[0],
          type: "email",
          rule: "obfuscated_email",
          confidence: "medium",
          dogrulanmadi: false,
          score: 0.85,
          reason: "Gizlenmiş e-posta biçimi ([at]/[dot])"
        });
      }
      OBFUSCATED_EMAIL_RE.lastIndex = 0;
    }

    // 5. Standart ORDER kalıpları
    ORDER.forEach(function(type){
      if(!enabled[type]) return;
      var source = PATTERNS[type];
      var re = new RegExp(source.source, source.flags.indexOf("g") === -1 ? source.flags + "g" : source.flags);
      var match;
      while((match = re.exec(rawText))){
        var val = match[0];
        var start = match.index;
        var end = start + val.length;

        var once = oncekiBaglam(rawText, start);
        var zorunlu = CONTEXT_REQUIRED[type];
        if(zorunlu && !zorunlu.test(once)){ if(!val.length) re.lastIndex++; continue; }

        var validator = CHECKSUM_VALIDATORS[type];
        var dogrulanmadi = false;

        if(type === "iban"){
          var parts = splitIbanCandidate(val);
          if(!parts){ if(!val.length) re.lastIndex++; continue; }
          val = parts.iban;
          end = start + val.length;
          if(!validator(parts.iban)){ dogrulanmadi = true; }
        } else if(validator && !validator(val)){
          var kurtarma = CONTEXT_RESCUE[type];
          if(!kurtarma || !kurtarma.test(once)){ if(!val.length) re.lastIndex++; continue; }
          dogrulanmadi = true;
        }

        var conf = dogrulanmadi ? "low" : (CONFIDENCE[type] || "medium");
        rawCandidates.push({
          span: [start, end],
          text: val,
          type: type,
          rule: "pattern_" + type,
          confidence: conf,
          dogrulanmadi: dogrulanmadi,
          score: dogrulanmadi ? 0.5 : (conf === "high" ? 1.0 : 0.75),
          reason: (TYPE_LABELS[type] || type) + (dogrulanmadi ? " (bağlamla kurtarıldı, checksum tutmadı)" : "")
        });
        if(!val.length) re.lastIndex++;
      }
    });

    // 6. Anahtar kelimeli değerler (parola, jeton, CVV, kullanıcı adı, SKT, hesap no, plaka)
    if(enabled.secret){
      var urlParamRe = /([?&](?:token|access[_-]?token|api[_-]?key|key|secret|auth|password|pwd|sig|signature)=)([^&\s#"']{6,})/gi;
      var upm;
      while((upm = urlParamRe.exec(rawText))){
        var upStart = upm.index + upm[1].length;
        rawCandidates.push({
          span: [upStart, upStart + upm[2].length],
          text: upm[2],
          type: "secret",
          rule: "url_query_secret",
          confidence: "high",
          dogrulanmadi: false,
          score: 0.95,
          reason: "URL sorgu parametresi sırrı"
        });
      }

      var pwRe = /(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])(parola|şifre\w*|sifre\w*|password|pwd)(\s*[:=]\s*|\s+)(?!\[)((?=\S*[\d!@#$%^&*_.\-])\S{4,})/gi;
      var pwm;
      while((pwm = pwRe.exec(rawText))){
        var pwVal = pwm[3];
        var kuyrukLen = 0;
        var km = pwVal.match(/[,;:]+$/) || pwVal.match(/\.$/);
        if(km && pwVal.length - km[0].length >= 4){
          kuyrukLen = km[0].length;
          pwVal = pwVal.slice(0, pwVal.length - kuyrukLen);
        }
        var pStart = pwm.index + pwm[1].length + pwm[2].length;
        rawCandidates.push({
          span: [pStart, pStart + pwVal.length],
          text: pwVal,
          type: "secret",
          rule: "keyed_password",
          confidence: "high",
          dogrulanmadi: false,
          score: 0.95,
          reason: "Anahtar kelimeli parola/şifre"
        });
      }

      var cvvRe = /(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])(cvv|cvc|güvenlik\s*kodu|guvenlik\s*kodu)(\s*[:=]?\s*)(\d{3,4})\b/gi;
      var cvvm;
      while((cvvm = cvvRe.exec(rawText))){
        var cvStart = cvvm.index + cvvm[1].length + cvvm[2].length;
        rawCandidates.push({
          span: [cvStart, cvStart + cvvm[3].length],
          text: cvvm[3],
          type: "secret",
          rule: "keyed_cvv",
          confidence: "high",
          dogrulanmadi: false,
          score: 0.95,
          reason: "Güvenlik kodu (CVV)"
        });
      }

      var tokRe = /(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])(reset\s*token|token|jeton|api\s*key|api\s*anahtar\w*|webhook|secret|gizli\s*anahtar)(\s*[:=]\s*)(?!\[)([A-Za-z0-9._~+\/:-]{8,})/gi;
      var tokm;
      while((tokm = tokRe.exec(rawText))){
        var tokStart = tokm.index + tokm[1].length + tokm[2].length;
        rawCandidates.push({
          span: [tokStart, tokStart + tokm[3].length],
          text: tokm[3],
          type: "secret",
          rule: "keyed_token",
          confidence: "high",
          dogrulanmadi: false,
          score: 0.9,
          reason: "Anahtar kelimeli jeton/anahtar"
        });
      }

      var urlPathRe = /(https?:\/\/[^\s]*?\/(?:reset|services|invite|token|verify|confirm|hooks?)\/)([A-Za-z0-9_\-\/]{6,})/gi;
      var upm2;
      while((upm2 = urlPathRe.exec(rawText))){
        var pStart2 = upm2.index + upm2[1].length;
        rawCandidates.push({
          span: [pStart2, pStart2 + upm2[2].length],
          text: upm2[2],
          type: "secret",
          rule: "url_path_token",
          confidence: "high",
          dogrulanmadi: false,
          score: 0.9,
          reason: "URL yolunda taşınan doğrulama jetonu"
        });
      }
    }

    if(enabled.kullanici){
      var usrRe = /(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])(kullanıcı\s*(?:adı|hesabı)|kullanici\s*(?:adi|hesabi)|username|user\s*name)(\s*[:=]\s*|\s+)(?!\[)([A-Za-z0-9._-]{3,})/gi;
      var usrm;
      while((usrm = usrRe.exec(rawText))){
        if(!/[:=]/.test(usrm[2]) && !/[\d._-]/.test(usrm[3])) continue;
        var uStart = usrm.index + usrm[1].length + usrm[2].length;
        rawCandidates.push({
          span: [uStart, uStart + usrm[3].length],
          text: usrm[3],
          type: "kullanici",
          rule: "keyed_username",
          confidence: "medium",
          dogrulanmadi: false,
          score: 0.8,
          reason: "Kullanıcı adı"
        });
      }
    }

    if(enabled.date){
      var sktRe = /(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])(son\s*kullanma(?:\s*tarihi)?|skt|geçerlilik|gecerlilik|expiry|exp)(\s*[:=]?\s*)(\d{2}\s*[\/-]\s*\d{2,4})\b/gi;
      var sktm;
      while((sktm = sktRe.exec(rawText))){
        var sStart = sktm.index + sktm[1].length + sktm[2].length;
        rawCandidates.push({
          span: [sStart, sStart + sktm[3].length],
          text: sktm[3],
          type: "date",
          rule: "keyed_expiry_date",
          confidence: "medium",
          dogrulanmadi: false,
          score: 0.8,
          reason: "Son kullanma tarihi"
        });
      }

      var cardBlockRe = /(\[KART_\d+\]\s*[\/|]\s*)(\d{2}\s*[\/|-]\s*\d{2,4})(\s*[\/|]\s*)(\d{3,4})\b/g;
      var cbm;
      while((cbm = cardBlockRe.exec(rawText))){
        var cbDateStart = cbm.index + cbm[1].length;
        rawCandidates.push({
          span: [cbDateStart, cbDateStart + cbm[2].length],
          text: cbm[2],
          type: "date",
          rule: "card_block_expiry",
          confidence: "high",
          dogrulanmadi: false,
          score: 0.85,
          reason: "Kart son kullanma tarihi"
        });
        if(enabled.secret){
          var cbCvvStart = cbDateStart + cbm[2].length + cbm[3].length;
          rawCandidates.push({
            span: [cbCvvStart, cbCvvStart + cbm[4].length],
            text: cbm[4],
            type: "secret",
            rule: "card_block_cvv",
            confidence: "high",
            dogrulanmadi: false,
            score: 0.9,
            reason: "Kart güvenlik kodu"
          });
        }
      }
    }

    if(enabled.hesap){
      var hspRe = /(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])(hesap\s*n[ou]\w*|müşteri\s*n[ou]\w*|musteri\s*n[ou]\w*|müşteri\s*numara\w*|musteri\s*numara\w*|abone\s*n[ou]\w*|üye\s*n[ou]\w*)(\s*[:=]?\s*)(\d{6,20})\b/gi;
      var hspm;
      while((hspm = hspRe.exec(rawText))){
        var hStart = hspm.index + hspm[1].length + hspm[2].length;
        rawCandidates.push({
          span: [hStart, hStart + hspm[3].length],
          text: hspm[3],
          type: "hesap",
          rule: "keyed_account_number",
          confidence: "medium",
          dogrulanmadi: false,
          score: 0.8,
          reason: "Banka / müşteri hesap numarası"
        });
      }
    }

    if(enabled.plaka){
      var plkRe = /(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])(plaka\w*)(\s*[:=]?\s*)(?!\[)(\d{2}\s?[A-ZÇĞİÖŞÜ]{1,4}\s?\d{2,5})\b/gi;
      var plkm;
      while((plkm = plkRe.exec(rawText))){
        var pStart3 = plkm.index + plkm[1].length + plkm[2].length;
        rawCandidates.push({
          span: [pStart3, pStart3 + plkm[3].length],
          text: plkm[3],
          type: "plaka",
          rule: "keyed_plate_number",
          confidence: "medium",
          dogrulanmadi: false,
          score: 0.8,
          reason: "Araç plaka numarası"
        });
      }
    }

    if(enabled.sirket){
      var srkRe = /\b([A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜçğıöşü]*(?:[ \t]+[A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜçğıöşü]*){0,4}[ \t]+(?:A\.?\s?Ş\.?|Ltd\.?[ \t]*Şti\.?|Limited[ \t]+Şirketi|San\.?[ \t]*ve[ \t]*Tic\.?[ \t]*A\.?\s?Ş\.?))/g;
      var srkm;
      while((srkm = srkRe.exec(rawText))){
        rawCandidates.push({
          span: [srkm.index, srkm.index + srkm[1].trim().length],
          text: srkm[1].trim(),
          type: "sirket",
          rule: "company_unvan",
          confidence: "low",
          dogrulanmadi: false,
          score: 0.65,
          reason: "Ticari şirket unvanı"
        });
      }
    }

    // 7. Etiketli Kişi İsimleri (KISI_RE)
    if(enabled.name){
      var km;
      while((km = KISI_RE.exec(rawText))){
        var ad = km[1];
        var nameStart = km.index + km[0].length - ad.length;
        rawCandidates.push({
          span: [nameStart, nameStart + ad.length],
          text: ad,
          type: "name",
          rule: "labeled_person_name",
          confidence: "medium",
          dogrulanmadi: false,
          score: 0.85,
          reason: "Etiketli kişi adı (müşteri/ad soyad/yetkili)"
        });
      }
      KISI_RE.lastIndex = 0;

      // 8. Bağlamsal Etiketsiz Kişi İsimleri (M-06)
      var wordRe = /(?<![A-Za-zÇĞİÖŞÜçğıöşü0-9_])([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?![A-Za-zÇĞİÖŞÜçğıöşü0-9_])/g;
      var words = [];
      var wm;
      while((wm = wordRe.exec(rawText))){
        words.push({ word: wm[1], start: wm.index, end: wm.index + wm[1].length });
      }

      var verbSuffixRe = /^\s*(?:katıldı|katılmıştır|katılıyor|iştirak\s+etti|hazırladı|hazırlayan|düzenledi|yazdı|yazan|oluşturdu|onayladı|onaylayan|imzaladı|imzalayan|gönderdi|gönderen|teslim\s+aldı|teslim\s+etti|başvurdu|joined|attended|participated|prepared|authored|created|approved|signed|sent|delivered|applied|reported|reviewed|beigetreten|teilgenommen|vorbereitet|erstellt|geschrieben|genehmigt|unterschrieben|gesendet|geprüft)(?=[.,;!?\s]|$)/i;
      var ileVerbRe = /^\s*(?:ile|’le|'le)\s+(?:görüştü|görüştük|görüştüm|toplantı|buluştu|konuştu|anlaştı)/i;
      var tarafindanRe = /^\s*(?:tarafından|tarafindan)\s+(?:onaylandı|onaylandi|hazırlandı|hazirlandi|imzalandı|imzalandi|iletildi|gönderildi|yazıldı)/i;
      var passivePrefixRe = /(?:approved\s+by|prepared\s+by|signed\s+by|sent\s+by|created\s+by|reviewed\s+by|meeting\s+with|spoke\s+with|talked\s+with|call\s+with|genehmigt\s+von|erstellt\s+von|unterschrieben\s+von|gesendet\s+von|geprüft\s+von|gesprochen\s+mit|treffen\s+mit)\s*$/i;

      for(var wi = 0; wi < words.length; wi++){
        var title = null;
        var nameStartIndex = wi;
        if(TITLES.has(words[wi].word)){
          if(wi + 1 < words.length){
            var titleSep = rawText.slice(words[wi].end, words[wi + 1].start);
            if(titleSep === " " || titleSep === ". " || titleSep === "."){
              title = words[wi].word;
              nameStartIndex = wi + 1;
            }
          }
        }
        if(nameStartIndex >= words.length) continue;

        for(var wlen = 2; wlen <= 3; wlen++){
          if(nameStartIndex + wlen > words.length) continue;
          var slice = words.slice(nameStartIndex, nameStartIndex + wlen);
          if(slice.some(function(w){ return NON_NAME_WORDS.has(w.word) || TITLES.has(w.word); })) continue;

          var contiguous = true;
          for(var ck = 0; ck < wlen - 1; ck++){
            if(rawText.slice(slice[ck].end, slice[ck + 1].start) !== " "){
              contiguous = false;
              break;
            }
          }
          if(!contiguous) continue;

          var spanStart = slice[0].start;
          var spanEnd = slice[wlen - 1].end;
          var nameStr = rawText.slice(spanStart, spanEnd);

          var prefix = rawText.slice(Math.max(0, spanStart - 40), spanStart);
          var suffix = rawText.slice(spanEnd, Math.min(rawText.length, spanEnd + 40));

          var matched = false;
          var reason = "";

          if(title){
            matched = true;
            reason = "Mesleki unvan bağlamı (" + title + ")";
          } else if(verbSuffixRe.test(suffix)){
            matched = true;
            reason = "Fiil bağlamı: " + suffix.trim().split(/\s+/)[0];
          } else if(ileVerbRe.test(suffix)){
            matched = true;
            reason = "Birliktelik ve görüşme bağlamı";
          } else if(tarafindanRe.test(suffix)){
            matched = true;
            reason = "Tarafından eylem bağlamı";
          } else if(passivePrefixRe.test(prefix)){
            matched = true;
            reason = "Edilgen/ön bağlam (" + prefix.trim().split(/\s+/).slice(-2).join(" ") + ")";
          }

          if(matched){
            rawCandidates.push({
              span: [spanStart, spanEnd],
              text: nameStr,
              type: "name",
              rule: "contextual_name",
              confidence: "medium",
              dogrulanmadi: false,
              score: 0.8,
              reason: reason
            });
            wi = nameStartIndex + wlen - 1;
            break;
          }
        }
      }
    }

    // 9. Adresler
    if(enabled.address){
      var am;
      while((am = ADRES_ETIKETLI_RE.exec(rawText))){
        var kp = adresKirp(am[3]);
        if(kp.adres.length >= 5 && !/\[[A-Z]+_\d+\]/.test(kp.adres)){
          var aStart = am.index + am[1].length + am[2].length;
          rawCandidates.push({
            span: [aStart, aStart + kp.adres.length],
            text: kp.adres,
            type: "address",
            rule: "labeled_address",
            confidence: "medium",
            dogrulanmadi: false,
            score: 0.8,
            reason: "Etiketli adres"
          });
        }
      }
      ADRES_ETIKETLI_RE.lastIndex = 0;

      while((am = ADRES_ISARETLI_RE.exec(rawText))){
        var kp2 = adresKirp(am[1]);
        if(kp2.adres.length >= 8 && !/\[[A-Z]+_\d+\]/.test(kp2.adres)){
          var aStart2 = am.index + am[0].indexOf(kp2.adres);
          rawCandidates.push({
            span: [aStart2, aStart2 + kp2.adres.length],
            text: kp2.adres,
            type: "address",
            rule: "marked_address",
            confidence: "medium",
            dogrulanmadi: false,
            score: 0.75,
            reason: "Sokak/mahalle işaretçili adres"
          });
        }
      }
      ADRES_ISARETLI_RE.lastIndex = 0;
    }

    // ÇAKIŞMA ÇÖZÜMÜ (M-02)
    var valid = rawCandidates.filter(function(c){
      return !isInsidePlaceholder(c.span[0], c.span[1]) && !isExcluded(c.type, c.text);
    });

    var TYPE_PRIORITY = {
      jwt: 100, secret: 95, ssh: 90, pasaport: 85, swift: 80, koordinat: 75,
      kurum_kodu: 70, kep: 65, email: 60, iban: 55, uuid: 50, mac: 45, ip: 40,
      kripto: 35, ykn: 30, tckn: 25, vkn: 20, imei: 18, card: 15, phone: 12,
      ssn: 10, plaka: 8, date: 6, amount: 5, name: 4, address: 3,
      kullanici: 2, hesap: 2, sirket: 1
    };

    valid.sort(function(a, b){
      var prioA = TYPE_PRIORITY[a.type] || 0;
      var prioB = TYPE_PRIORITY[b.type] || 0;
      if(prioB !== prioA) return prioB - prioA;
      if(b.score !== a.score) return b.score - a.score;
      var lenA = a.span[1] - a.span[0];
      var lenB = b.span[1] - b.span[0];
      if(lenB !== lenA) return lenB - lenA;
      return a.span[0] - b.span[0];
    });

    /* Kabul edilen adaylar metin üzerinde konum sahipliğiyle izlenir
       (sahip[i] = kabul indeksi + 1). Her adayı kabul edilenlerin hepsiyle
       karşılaştırmak aday × kabul karesiydi; 12 bin adaylı metinde yüzlerce
       ms. Sahiplik taraması yalnız adayın kendi uzunluğu kadar sürer. */
    var accepted = [];
    var silindi = [];
    var rejected = [];
    var sahip = new Int32Array(rawText.length + 1);
    function sahipleriBul(bas, son){
      var liste = [];
      for(var p=bas; p<son; p++){
        var o = sahip[p];
        if(o && liste.indexOf(o) === -1) liste.push(o);
      }
      return liste;
    }
    function kabulEt(aday){
      accepted.push(aday);
      silindi.push(false);
      sahip.fill(accepted.length, aday.span[0], aday.span[1]);
    }
    for(var vi=0; vi<valid.length; vi++){
      var cand = valid[vi];
      var overlaps = false;
      for(var p=cand.span[0]; p<cand.span[1]; p++){
        if(sahip[p]){ overlaps = true; break; }
      }
      if(!overlaps){
        kabulEt(cand);
      } else {
        rejected.push(cand);
      }
    }

    /* Kapsama düzeltmesi. Öncelik sırası KISMİ çakışmada doğru karar verir,
       ama düşük öncelikli bir aday yüksek öncelikli adayları TAMAMEN
       içeriyorsa dış adayı atmak dışın geri kalanını açıkta bırakıyordu:
       "Adres: Moda Cad. No: 12 Kadıköy 05.06.2024 tarihinden beri" metninde
       yalnız tarih maskeleniyor, adresin tamamı AI'ya gidiyordu. Böyle
       durumda dış aday kazanır; içteki değerler onun placeholder'ında kalır.
       Yalnız FARKLI tipler arasında uygulanır: aynı tipteki çakışmayı skor
       zaten çözdü (yoksa "Adres: Bağdat Cad." metninde işaretçili aday
       etiketli adayı yutup "Adres:" etiketini de maskelerdi). Adaylar ilk
       sıralamadaki öncelik sırasıyla denenir. */
    for(var ri=0; ri<rejected.length; ri++){
      var dis = rejected[ri];
      var disUzunluk = dis.span[1] - dis.span[0];
      var sahipler = sahipleriBul(dis.span[0], dis.span[1]);
      var kismi = false;
      for(var ki=0; ki<sahipler.length; ki++){
        var ic = accepted[sahipler[ki] - 1];
        if(!(ic.type !== dis.type && dis.span[0] <= ic.span[0] && ic.span[1] <= dis.span[1] && disUzunluk > ic.span[1] - ic.span[0])){
          kismi = true;
          break;
        }
      }
      if(kismi || !sahipler.length) continue;
      for(var si=0; si<sahipler.length; si++){ silindi[sahipler[si] - 1] = true; }
      kabulEt(dis);
    }

    return accepted.filter(function(a, i){ return !silindi[i]; })
      .sort(function(a, b){ return a.span[0] - b.span[0]; });
  }

  /* F2-01: Görünmez karakter savunması ve çift yönlü koordinat eşleme.
     Metin içine gizlenmiş zero-width/bidi karakterleri ayıklayarak adayları
     tespit eder, kabul edilen span'leri ham metindeki tam bayt konumlarına
     geri haritalar. Bu sayede unmaskText(maskText(x)) === x kayıpsız korunur. */
  function detectCandidates(rawText, enabledMap){
    var enabled = enabledMap || ALL_ENABLED;
    if(!rawText || typeof rawText !== "string") return [];

    var hasInvisible = INVISIBLE_CHARS_RE.test(rawText);
    INVISIBLE_CHARS_RE.lastIndex = 0;

    if(!hasInvisible){
      return extractCandidatesFromText(rawText, enabled);
    }

    var normChars = [];
    var normToRaw = [];
    for(var ni=0; ni<rawText.length; ni++){
      var code = rawText.charCodeAt(ni);
      if(code === 0x200B || code === 0x200C || code === 0x200D ||
         code === 0x200E || code === 0x200F || (code >= 0x202A && code <= 0x202E) ||
         code === 0x2060 || code === 0xFEFF || code === 0x00AD){
        continue;
      }
      normChars.push(rawText[ni]);
      normToRaw.push(ni);
    }
    var normText = normChars.join("");
    var normCandidates = extractCandidatesFromText(normText, enabled);

    // Span'leri ve aday metnini ham metin koordinat uzayına geri haritala
    var mapped = [];
    for(var mi=0; mi<normCandidates.length; mi++){
      var nc = normCandidates[mi];
      if(nc.span[0] >= normToRaw.length || nc.span[1] <= nc.span[0]) continue;
      var rawStart = normToRaw[nc.span[0]];
      var rawEnd = normToRaw[nc.span[1] - 1] + 1;
      nc.span = [rawStart, rawEnd];
      nc.text = rawText.slice(rawStart, rawEnd);
      mapped.push(nc);
    }
    return mapped;
  }

  var KELIME_KARAKTERI = /[\p{L}\p{N}_]/u;
  var PLACEHOLDER_AYIR = /(\[[A-Z]+_\d+\])/;

  /* Sözlük terimlerini metinde değiştirir. Terim daha uzun bir kelimenin
     parçası olarak geçiyorsa ("Ali Can" → "Ali Cantürk") yalnız o parçayı
     değiştirmek kelimenin kalanını açıkta bırakıyor ("[KISI_1]türk") ve iki
     farklı kişiyi aynı placeholder'da birleştiriyordu. Eşleşme kelime
     sınırına kadar genişletilir ve genişlemiş hâl kendi placeholder'ını alır.
     Hiç eşleştirmemek daha kötü olurdu: "Ali Cantürk" tümüyle açıkta kalırdı.
     Mevcut placeholder'ların içine dokunulmaz ("KISI" terimi [KISI_1]'i bozmasın). */
  function sozlukTerimleriniDegistir(text, entries){
    entries.forEach(function(e){
      var terim = e.real;
      if(!terim || text.indexOf(terim) === -1) return;
      var basaGenislet = KELIME_KARAKTERI.test(terim.charAt(0));
      var sonaGenislet = KELIME_KARAKTERI.test(terim.charAt(terim.length - 1));
      var parcalar = text.split(PLACEHOLDER_AYIR);   // tek indeksler placeholder
      for(var p=0; p<parcalar.length; p+=2){
        var s = parcalar[p];
        if(s.indexOf(terim) === -1) continue;
        var cikti = "", i = 0, j;
        while((j = s.indexOf(terim, i)) !== -1){
          var bas = j, son = j + terim.length;
          if(basaGenislet){ while(bas > i && KELIME_KARAKTERI.test(s.charAt(bas - 1))) bas--; }
          if(sonaGenislet){ while(son < s.length && KELIME_KARAKTERI.test(s.charAt(son))) son++; }
          var bulunan = s.slice(bas, son);
          cikti += s.slice(i, bas) + (bulunan === terim ? e.placeholder : maskOne(e.type, bulunan));
          i = son;
        }
        parcalar[p] = cikti + s.slice(i);
      }
      text = parcalar.join("");
    });
    return text;
  }

  function maskText(rawText, enabledMap){
    var enabled = enabledMap || ALL_ENABLED;
    var text = rawText;
    var manualEntries = glossary.filter(function(g){ return TEXT_REPLACE_TYPES.indexOf(g.type) !== -1; })
      .sort(function(a,b){ return b.real.length - a.real.length; });
    text = sozlukTerimleriniDegistir(text, manualEntries);

    var candidates = detectCandidates(text, enabled);

    // Soldan sağa sırayla sözlüğe ekle (sayaçlar metin sırasıyla artsın)
    var replacements = [];
    for(var ci=0; ci<candidates.length; ci++){
      var c = candidates[ci];
      if(isExcluded(c.type, c.text)) continue;
      var placeholder = maskOne(c.type, c.text, c.dogrulanmadi);
      replacements.push({
        span: c.span,
        placeholder: placeholder
      });
    }

    // Tek geçişte birleştir. Eskiden her değişimde metnin tamamı yeniden
    // kopyalanıyordu (değişim × metin uzunluğu): 227 KB'ta ~1 sn yalnız bu.
    // Adaylar başlangıca göre sıralı ve çakışmasızdır.
    var parcalar = [];
    var konum = 0;
    for(var ri=0; ri<replacements.length; ri++){
      var rep = replacements[ri];
      parcalar.push(text.slice(konum, rep.span[0]), rep.placeholder);
      konum = rep.span[1];
    }
    parcalar.push(text.slice(konum));
    text = parcalar.join("");

    saveState();
    return text;
  }

  function previewValue(value){
    if(value.length <= 6) return "••••";
    return value.slice(0, 2) + "…" + value.slice(-2);
  }

  // Kopyalama öncesi denetim için salt-okunur tarama. Gerçek değeri arayüze
  // taşımamak üzere yalnızca tür, maskeli önizleme ve konum döndürür.
  function inspectSensitive(rawText, enabledMap){
    var enabled = enabledMap || ALL_ENABLED;
    var candidates = detectCandidates(rawText, enabled);
    var seen = Object.create(null);
    var findings = [];

    for(var i=0; i<candidates.length; i++){
      var c = candidates[i];
      var key = c.type + ":" + c.span[0] + ":" + c.text;
      if(seen[key] || /^\[[A-Z]+_\d+\]$/.test(c.text) || isExcluded(c.type, c.text)) continue;
      seen[key] = true;
      findings.push({
        type: c.type,
        label: TYPE_LABELS[c.type] || c.type,
        preview: previewValue(c.text),
        index: c.span[0],
        end: c.span[1],
        confidence: c.confidence,
        dogrulanmadi: !!c.dogrulanmadi,
        reason: c.reason,
        rule: c.rule,
        value: c.text
      });
    }

    return findings;
  }

  /* Köşeli parantezli placeholder'lar ([KISI_1], elle verilen [PROJE_X]) tek
     geçişte sözlük dizininden açılır. Eskiden her sözlük kaydı için metnin
     tamamı split/join ediliyordu (kayıt × metin uzunluğu). Tek geçiş ayrıca
     açılan gerçek değerin içinde tesadüfen placeholder'a benzeyen bir metin
     varsa onu ikinci kez "açmaz". Parantez biçimine uymayan elle verilmiş
     maskeler (ör. "[abc" — kapanışsız) eski yolla, uzundan kısaya açılır. */
  var PLACEHOLDER_BICIMI = /^\[[^\[\]\r\n]{1,80}\]$/;
  var PLACEHOLDER_ARA = /\[[^\[\]\r\n]{1,80}\]/g;

  function unmaskText(rawText){
    var text = rawText;
    var yerTutucu = dizin().yerTutucu;
    var ozel = glossary.filter(function(e){ return !PLACEHOLDER_BICIMI.test(e.placeholder); })
      .sort(function(a,b){ return b.placeholder.length - a.placeholder.length; });
    ozel.forEach(function(e){ text = text.split(e.placeholder).join(e.real); });
    return text.replace(PLACEHOLDER_ARA, function(ph){
      var e = yerTutucu.get(ph);
      return e ? e.real : ph;
    });
  }

  function computeSummary(maskedText){
    var counts = {};
    var re = /\[[A-Z]+_\d+\]/g;
    var m;
    var yerTutucu = dizin().yerTutucu;
    while((m = re.exec(maskedText))){
      var entry = yerTutucu.get(m[0]);
      if(!entry) continue;
      counts[entry.type] = (counts[entry.type] || 0) + 1;
    }
    return counts;
  }

  function alreadyInGlossary(value){
    return glossary.some(function(g){ return g.real === value; });
  }

  function addTerm(value, type){
    if(alreadyInGlossary(value)) return null;
    var entry = { id: uid(), real: value, placeholder: nextPlaceholder(type), type: type };
    glossary.push(entry);
    saveState();
    return entry;
  }

  function addManualTerm(real, placeholder){
    real = (real || "").trim();
    if(!real) return null;
    placeholder = (placeholder || "").trim();
    if(!placeholder){
      placeholder = nextPlaceholder("manual");
    } else if(placeholder[0] !== "["){
      placeholder = "[" + placeholder + "]";
    }
    if(glossary.some(function(g){ return g.placeholder === placeholder && g.real !== real; })){
      throw new Error("Bu maske başka bir değere ait. Farklı bir maske seçin.");
    }
    var existing = glossary.find(function(g){ return g.type === "manual" && g.real === real; });
    if(existing){
      existing.placeholder = placeholder;
      dizinGecersiz();   // yerinde değişiklik: dizin uzunluktan anlayamaz
    } else {
      glossary.push({ id: uid(), real: real, placeholder: placeholder, type: "manual" });
    }
    seedCountersFromGlossary();
    saveState();
    return placeholder;
  }

  /* Geri alma için kaydı OLDUĞU GİBİ geri koy — addTerm yeni bir placeholder
     üretirdi, oysa kullanıcı tam olarak eskisini geri istiyor. */
  function restoreEntry(entry){
    if(!entry || !entry.real || !entry.placeholder) return null;
    if(glossary.some(function(g){ return g.placeholder === entry.placeholder; })) return null;
    glossary.push({ id: entry.id || uid(), real: entry.real,
                    placeholder: entry.placeholder, type: entry.type || "manual" });
    saveState();
    return entry;
  }

  function deleteEntry(id){
    glossary = glossary.filter(function(g){ return g.id !== id; });
    saveState();
  }

  function excludeEntryById(id){
    var entry = glossary.find(function(g){ return g.id === id; });
    if(!entry) return;
    glossary = glossary.filter(function(g){ return g.id !== id; });
    if(!isExcluded(entry.type, entry.real)){
      excluded.push({ type: entry.type, value: entry.real });
    }
    saveState();
  }

  function unexcludeEntry(item){
    excluded = excluded.filter(function(e){ return !(e.type === item.type && e.value === item.value); });
    saveState();
  }

  function clearGlossary(){
    glossary = [];
    excluded = [];
    saveState();
  }

  function importGlossary(parsed){
    if(!Array.isArray(parsed)) return;
    var combined = glossary.concat(parsed);
    var meanings = new Map();
    combined.forEach(function(entry){
      if(!entry || typeof entry.real !== "string" || typeof entry.placeholder !== "string" ||
         !entry.real || !entry.placeholder || !Object.prototype.hasOwnProperty.call(PREFIX, entry.type || "manual")){
        throw new Error("Sözlük kaydı geçersiz.");
      }
      if(meanings.has(entry.placeholder) && meanings.get(entry.placeholder) !== entry.real){
        var conflict = new Error("Eski sözlükte aynı maske farklı bir değere ait. Eski kayıtlar korunuyor.");
        conflict.code = "GLOSSARY_CONFLICT";
        throw conflict;
      }
      meanings.set(entry.placeholder, entry.real);
    });
    parsed.forEach(function(entry){
      if(entry && entry.real && entry.placeholder){
        var type = entry.type || "manual";
        var existing = glossary.find(function(g){ return g.type === type && g.real === entry.real; });
        // Aynı gerçek değerin eski takma adı da geri açılabilsin; güncel takma adı değiştirme.
        if(!existing || existing.placeholder !== entry.placeholder){
          glossary.push({ id: uid(), real: entry.real, placeholder: entry.placeholder, type: type });
        }
      }
    });
    seedCountersFromGlossary();
    saveState();
  }

  function getGlossary(){ return glossary; }
  function getExcluded(){ return excluded; }

  function resolveOcrPath(relativePath){
    if(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL){
      return chrome.runtime.getURL(relativePath);
    }
    return relativePath;
  }

  var ocrWorkerPromise = null;
  function getOcrWorker(){
    if(!ocrWorkerPromise){
      ocrWorkerPromise = Tesseract.createWorker("eng+tur", 1, {
        workerPath: resolveOcrPath("tesseract/worker.min.js"),
        corePath: resolveOcrPath("tesseract/tesseract-core-simd-lstm.wasm.js"),
        langPath: resolveOcrPath("tesseract/lang-data"),
        gzip: false,
        workerBlobURL: false
      });
    }
    return ocrWorkerPromise;
  }

  function wireOcrPaste(inputEl, statusEl, onDone){
    inputEl.addEventListener("paste", function(e){
      var clipboard = e.clipboardData || window.clipboardData;
      if(!clipboard) return;
      var items = clipboard.items;
      var imageItem = null;
      for(var i=0;i<items.length;i++){
        if(items[i].type && items[i].type.indexOf("image/") === 0){ imageItem = items[i]; break; }
      }
      if(!imageItem) return;
      e.preventDefault();

      var file = imageItem.getAsFile();
      if(statusEl){ statusEl.hidden = false; statusEl.textContent = "Görüntü okunuyor…"; }

      getOcrWorker().then(function(worker){
        return worker.recognize(file);
      }).then(function(result){
        var text = (result && result.data && result.data.text) ? result.data.text.trim() : "";
        var conf = (result && result.data && typeof result.data.confidence === "number") ? Math.round(result.data.confidence) : 100;
        var words = (result && result.data && Array.isArray(result.data.words)) ? result.data.words : [];
        var lowConfWords = words.filter(function(w){ return typeof w.confidence === "number" && w.confidence < 70; });
        var hasLowConfidence = conf < 75 || (words.length > 0 && lowConfWords.length / words.length > 0.15);

        var start = inputEl.selectionStart;
        var end = inputEl.selectionEnd;
        var before = inputEl.value.slice(0, start);
        var after = inputEl.value.slice(end);
        var insertion = text;
        if(before && !/\n$/.test(before)) insertion = "\n" + insertion;
        inputEl.value = before + insertion + after;
        inputEl.dispatchEvent(new Event("input"));
        if(statusEl){
          statusEl.hidden = false;
          statusEl.classList.toggle("is-low-conf", hasLowConfidence);
          if(!text){
            statusEl.textContent = "Yazı bulunamadı";
            setTimeout(function(){ statusEl.hidden = true; }, 2000);
          } else if(hasLowConfidence){
            statusEl.textContent = "Okundu (OCR Güveni: %" + conf + ") — Düşük güvenli sözcükler kaçırılmış olabilir, metni kontrol ediniz.";
            statusEl.title = lowConfWords.length + " şüpheli sözcük algılandı. Görüntüyü önizleme olmadan paylaşmayınız.";
            setTimeout(function(){ statusEl.hidden = true; }, 6000);
          } else {
            statusEl.textContent = "Okundu ✓ (OCR Güveni: %" + conf + ")";
            setTimeout(function(){ statusEl.hidden = true; }, 2200);
          }
        }
        if(onDone) onDone(text, { confidence: conf, lowConfWords: lowConfWords, words: words, file: file });
      }).catch(function(err){
        console.error("OCR hatası:", err);
        var msg = (err && err.message) ? err.message : String(err);
        if(statusEl){
          statusEl.textContent = "OCR hatası: " + msg;
          statusEl.title = msg;
        }
        if(onDone) onDone(null);
      });
    });
  }

  /* ---------- M-11: GÖRSEL KARARTMA (IMAGE REDACTION) ----------
     OCR ile çıkarılan kelime koordinatlarını hassas adaylarla eşler,
     kullanıcı onaylı kutular üzerinden tarayıcıda görseli karartır.
     Hiçbir veri sunucuya gönderilmez, tamamen yerel HTML5 Canvas ile işlenir. */

  function mapCandidatesToBoundingBoxes(words, candidates, options){
    options = options || {};
    if(!Array.isArray(words) || !words.length) return [];
    if(!Array.isArray(candidates) || !candidates.length) return [];

    function normalizeToken(value){
      return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    }

    function getWordBounds(word){
      if(!word) return null;
      var bbox = word.bbox || word;
      var x0 = Number(bbox.x0 !== undefined ? bbox.x0 : bbox.left);
      var y0 = Number(bbox.y0 !== undefined ? bbox.y0 : bbox.top);
      var x1 = Number(bbox.x1 !== undefined ? bbox.x1 : (bbox.right !== undefined ? bbox.right : (x0 + Number(bbox.width))));
      var y1 = Number(bbox.y1 !== undefined ? bbox.y1 : (bbox.bottom !== undefined ? bbox.bottom : (y0 + Number(bbox.height))));
      if(!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return null;

      var left = Math.min(x0, x1);
      var top = Math.min(y0, y1);
      var right = Math.max(x0, x1);
      var bottom = Math.max(y0, y1);
      var imageWidth = Number(options.width);
      var imageHeight = Number(options.height);
      if(Number.isFinite(imageWidth) && imageWidth > 0){
        left = Math.min(imageWidth, Math.max(0, left));
        right = Math.min(imageWidth, Math.max(0, right));
      }
      if(Number.isFinite(imageHeight) && imageHeight > 0){
        top = Math.min(imageHeight, Math.max(0, top));
        bottom = Math.min(imageHeight, Math.max(0, bottom));
      }
      if(right <= left || bottom <= top) return null;
      return { x0:left, y0:top, x1:right, y1:bottom };
    }

    var fullText = "";
    var wordOffsets = [];
    for(var i = 0; i < words.length; i++){
      var w = words[i];
      var wText = (w && (w.text || w.str || "")) || "";
      var startOffset = fullText.length;
      fullText += (i > 0 ? " " : "") + wText;
      if(i > 0) startOffset += 1;
      var endOffset = startOffset + wText.length;
      wordOffsets.push({
        index: i,
        word: w,
        start: startOffset,
        end: endOffset,
        cleanText: wText.toLowerCase(),
        normalizedText: normalizeToken(wText)
      });
    }

    var candidateBoxes = [];
    var lowerFull = fullText.toLowerCase();

    for(var c = 0; c < candidates.length; c++){
      var cand = candidates[c];
      var candRaw = (cand.raw || cand.text || "").trim();
      if(!candRaw) continue;

      var candRawClean = candRaw.replace(/\s+/g, " ").toLowerCase();
      var matchedOccurrences = [];

      var searchIdx = 0;
      while((searchIdx = lowerFull.indexOf(candRawClean, searchIdx)) !== -1){
        var matchEnd = searchIdx + candRawClean.length;
        var occurrence = [];
        for(var wIdx = 0; wIdx < wordOffsets.length; wIdx++){
          var wo = wordOffsets[wIdx];
          if(Math.max(wo.start, searchIdx) < Math.min(wo.end, matchEnd)){
            occurrence.push(wo.index);
          }
        }
        if(occurrence.length) matchedOccurrences.push(occurrence);
        searchIdx = matchEnd;
      }

      if(!matchedOccurrences.length){
        var target = normalizeToken(candRaw);
        if(target){
          for(var start = 0; start < wordOffsets.length; start++){
            var joined = "";
            var range = [];
            for(var end = start; end < wordOffsets.length; end++){
              joined += wordOffsets[end].normalizedText;
              range.push(wordOffsets[end].index);
              if(joined === target){
                matchedOccurrences.push(range);
                break;
              }
              if(joined.length >= target.length || !target.startsWith(joined)) break;
            }
          }
        }
      }

      for(var o = 0; o < matchedOccurrences.length; o++){
        var rows = [];
        var indices = matchedOccurrences[o];
        for(var m = 0; m < indices.length; m++){
          var bounds = getWordBounds(words[indices[m]]);
          if(!bounds) continue;
          var row = rows[rows.length - 1];
          if(row){
            var overlapY = Math.max(0, Math.min(row.y1, bounds.y1) - Math.max(row.y0, bounds.y0));
            var minHeight = Math.max(1, Math.min(row.y1 - row.y0, bounds.y1 - bounds.y0));
            var centerGap = Math.abs(((row.y0 + row.y1) / 2) - ((bounds.y0 + bounds.y1) / 2));
            if(overlapY < minHeight * 0.3 && centerGap > minHeight * 0.45) row = null;
          }
          if(!row){
            row = { x0:bounds.x0, y0:bounds.y0, x1:bounds.x1, y1:bounds.y1 };
            rows.push(row);
          } else {
            row.x0 = Math.min(row.x0, bounds.x0);
            row.y0 = Math.min(row.y0, bounds.y0);
            row.x1 = Math.max(row.x1, bounds.x1);
            row.y1 = Math.max(row.y1, bounds.y1);
          }
        }

        rows.forEach(function(row){
          candidateBoxes.push({
            id: "box_" + (candidateBoxes.length + 1),
            type: cand.type,
            raw: cand.raw || cand.text,
            label: TYPE_LABELS[cand.type] || cand.type,
            x0: row.x0,
            y0: row.y0,
            x1: row.x1,
            y1: row.y1,
            width: row.x1 - row.x0,
            height: row.y1 - row.y0,
            enabled: true
          });
        });
      }
    }

    return candidateBoxes;
  }

  function kirp255(v){ return v < 0 ? 0 : (v > 255 ? 255 : v); }

  /* Kutunun hemen dışındaki 3 piksellik çerçevenin ortalama rengi — yalnız
     kutu DIŞI pikseller okunur. Kutu tüm görseli kaplıyorsa nötr gri. */
  function cerceveRengi(ctx, x, y, w, h, cw, ch){
    var kalinlik = 3;
    var ax0 = Math.max(0, x - kalinlik), ay0 = Math.max(0, y - kalinlik);
    var ax1 = Math.min(cw, x + w + kalinlik), ay1 = Math.min(ch, y + h + kalinlik);
    var aw = ax1 - ax0, ah = ay1 - ay0;
    if(aw <= 0 || ah <= 0) return [128, 128, 128];
    var veri = ctx.getImageData(ax0, ay0, aw, ah).data;
    var r = 0, g = 0, b = 0, n = 0;
    for(var yy = 0; yy < ah; yy++){
      var gy = ay0 + yy;
      for(var xx = 0; xx < aw; xx++){
        var gx = ax0 + xx;
        if(gx >= x && gx < x + w && gy >= y && gy < y + h) continue;   // kutu içi: okunmaz
        var i = (yy * aw + xx) * 4;
        r += veri[i]; g += veri[i + 1]; b += veri[i + 2]; n++;
      }
    }
    return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [128, 128, 128];
  }

  function redactBoundingBoxes(canvasOrCtx, boxes, options){
    options = options || {};
    var ctx = (canvasOrCtx && canvasOrCtx.getContext) ? canvasOrCtx.getContext("2d", { willReadFrequently: true }) : canvasOrCtx;
    if(!ctx) return;

    var style = options.style || "black"; // "black" | "blur" | "label"
    var padding = typeof options.padding === "number" && Number.isFinite(options.padding)
      ? Math.max(0, Math.min(16, options.padding)) : 4;
    var canvasWidth = ctx.canvas ? ctx.canvas.width : (options.canvasWidth || 8000);
    var canvasHeight = ctx.canvas ? ctx.canvas.height : (options.canvasHeight || 8000);

    for(var i = 0; i < boxes.length; i++){
      var b = boxes[i];
      if(b.enabled === false) continue;

      var baseX = Number(b.x0 !== undefined ? b.x0 : b.x);
      var baseY = Number(b.y0 !== undefined ? b.y0 : b.y);
      var edgeX = Number(b.x1 !== undefined ? b.x1 : (baseX + Number(b.width)));
      var edgeY = Number(b.y1 !== undefined ? b.y1 : (baseY + Number(b.height)));
      if(!Number.isFinite(baseX) || !Number.isFinite(baseY) || !Number.isFinite(edgeX) || !Number.isFinite(edgeY)) continue;
      var x0 = Math.floor(Math.max(0, Math.min(canvasWidth, Math.min(baseX, edgeX) - padding)));
      var y0 = Math.floor(Math.max(0, Math.min(canvasHeight, Math.min(baseY, edgeY) - padding)));
      var x1 = Math.ceil(Math.max(0, Math.min(canvasWidth, Math.max(baseX, edgeX) + padding)));
      var y1 = Math.ceil(Math.max(0, Math.min(canvasHeight, Math.max(baseY, edgeY) + padding)));
      var w = x1 - x0;
      var h = y1 - y0;
      if(w <= 0 || h <= 0) continue;

      if(typeof ctx.save === "function") ctx.save();

      if(style === "blur" && ctx.getImageData && ctx.putImageData){
        /* GÜVENLİ MOZAİK. Eski mozaik blok renklerini kutunun İÇİNDEKİ
           piksellerin ortalamasından alıyordu. Pikselleştirilmiş yazı geri
           çözülebilir: saldırgan aday metinleri aynı yazı tipiyle pikselleştirip
           blok renklerini karşılaştırır (Depix, Unredacter). Burada kutunun
           içinden HİÇBİR piksel okunmaz: taban renk kutunun hemen dışındaki
           çerçeveden (zaten görünür olan arka plandan) alınır, bloklara yalnız
           rastgele ton farkı eklenir. Görünüm mozaiktir, alttaki yazıya dair
           bilgi içermez. Kutu genişliği yazının uzunluğunu ele vermesin diye
           yanlara rastgele birkaç piksel eklenir. */
        try{
          var rastgele = typeof options.rastgele === "function" ? options.rastgele : Math.random;
          var ekSol = Math.floor(rastgele() * 9), ekSag = Math.floor(rastgele() * 9);
          var mx0 = Math.max(0, x0 - ekSol);
          var mx1 = Math.min(canvasWidth, x0 + w + ekSag);
          var mw = mx1 - mx0;
          // Çerçeve rengi orta griye yaklaştırılır: beyaz zeminde mozaik zeminle
          // karışıp "karartılmamış" sanılmasın, her zeminde karartma olarak görünsün.
          var taban = cerceveRengi(ctx, mx0, y0, mw, h, canvasWidth, canvasHeight).map(function(c){
            return Math.round(c * 0.55 + 128 * 0.45);
          });
          var pixelSize = Math.max(6, Math.floor(Math.min(mw, h) / 4));
          var imgData = ctx.createImageData ? ctx.createImageData(mw, h) : ctx.getImageData(mx0, y0, mw, h);
          var d = imgData.data;
          for(var py = 0; py < h; py += pixelSize){
            for(var px = 0; px < mw; px += pixelSize){
              var sapma = Math.round((rastgele() - 0.5) * 40);
              var br = kirp255(taban[0] + sapma), bg = kirp255(taban[1] + sapma), bb = kirp255(taban[2] + sapma);
              for(var dy = 0; dy < pixelSize && py + dy < h; dy++){
                for(var dx = 0; dx < pixelSize && px + dx < mw; dx++){
                  var idx = ((py + dy) * mw + (px + dx)) * 4;
                  d[idx] = br;
                  d[idx + 1] = bg;
                  d[idx + 2] = bb;
                  d[idx + 3] = 255;
                }
              }
            }
          }
          ctx.putImageData(imgData, mx0, y0);
        }catch(e){
          ctx.fillStyle = "#000000";
          ctx.fillRect(x0, y0, w, h);
        }
      } else if(style === "label"){
        ctx.fillStyle = "#111827";
        ctx.fillRect(x0, y0, w, h);
        ctx.fillStyle = "#f3f4f6";
        var fontSize = Math.max(10, Math.min(14, Math.floor(h * 0.7)));
        if(ctx.font) ctx.font = "bold " + fontSize + "px sans-serif";
        if(ctx.textBaseline) ctx.textBaseline = "middle";
        var tagText = "[" + (b.label || b.type || "GİZLİ").toUpperCase() + "]";
        var textMetrics = ctx.measureText ? ctx.measureText(tagText) : { width: tagText.length * 8 };
        var textX = x0 + Math.max(2, (w - textMetrics.width) / 2);
        var textY = y0 + h / 2;
        if(ctx.fillText) ctx.fillText(tagText, textX, textY, w - 4);
      } else {
        ctx.fillStyle = options.color || "#000000";
        ctx.fillRect(x0, y0, w, h);
      }

      if(typeof ctx.restore === "function") ctx.restore();
    }
  }

  function exportRedactedCanvas(canvas, mimeType, quality){
    mimeType = mimeType || "image/png";
    if(!canvas || !canvas.toDataURL) return null;
    return canvas.toDataURL(mimeType, quality || 0.95);
  }

  /* Bir tipin tespitine ne kadar güvenildiğini gösteren rozet. */
  function confBadge(type, dogrulanmadi){
    var conf = dogrulanmadi ? "low" : (CONFIDENCE[type] || "medium");
    var badge = document.createElement("span");
    badge.className = "conf-badge " + conf;
    badge.textContent = dogrulanmadi ? "doğrulanmadı" : CONFIDENCE_LABELS[conf];
    if(dogrulanmadi){
      badge.title = "Checksum doğrulamasından geçmedi; yanındaki anahtar kelime " +
        "nedeniyle yine de maskelendi. Yazım hatası veya test verisi olabilir.";
    }
    return badge;
  }

  /* Özet çipi (kaç adet, hangi tip, ne kadar güvenilir). Hem tam sayfa
     hem açılır pencere aynı çipi çiziyordu; etiket ve güven tabloları bu
     modülde durduğu için çipin kendisi de burada. */
  function summaryChip(type, count){
    var chip = document.createElement("span");
    chip.className = "summary-chip";

    var strong = document.createElement("strong");
    strong.textContent = count;
    chip.appendChild(strong);
    chip.appendChild(document.createTextNode(" " + (TYPE_LABELS[type] || type)));
    chip.appendChild(confBadge(type));

    return chip;
  }

  function copyToClipboard(text, onDone){
    function done(){ if(onDone) onDone(); }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done).catch(function(){ fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text){
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand("copy"); }catch(e){}
    document.body.removeChild(ta);
  }

  // Uzantı sayfalarında arayüz dili dil.js'ten gelir ve değişince izlenir;
  // sohbet sitelerindeki kumanda dili service worker ayarından verir.
  if(window.MaskoDil){
    setPlaceholderLanguage(window.MaskoDil.dil());
    window.MaskoDil.degisince(setPlaceholderLanguage);
  }

  window.MaskEngine = {
    ORDER: ORDER,
    TYPE_LABELS: TYPE_LABELS,
    setPlaceholderLanguage: setPlaceholderLanguage,
    CONFIDENCE: CONFIDENCE,
    CONFIDENCE_LABELS: CONFIDENCE_LABELS,
    init: init,
    getState: getState,
    setState: setState,
    maskText: maskText,
    detectCandidates: detectCandidates,
    inspectSensitive: inspectSensitive,
    unmaskText: unmaskText,
    computeSummary: computeSummary,
    alreadyInGlossary: alreadyInGlossary,
    addTerm: addTerm,
    addManualTerm: addManualTerm,
    deleteEntry: deleteEntry,
    restoreEntry: restoreEntry,
    TEXT_REPLACE_TYPES: TEXT_REPLACE_TYPES,
    excludeEntryById: excludeEntryById,
    unexcludeEntry: unexcludeEntry,
    clearGlossary: clearGlossary,
    importGlossary: importGlossary,
    getGlossary: getGlossary,
    getExcluded: getExcluded,
    nextPlaceholder: nextPlaceholder,
    getOcrWorker: getOcrWorker,
    wireOcrPaste: wireOcrPaste,
    mapCandidatesToBoundingBoxes: mapCandidatesToBoundingBoxes,
    redactBoundingBoxes: redactBoundingBoxes,
    exportRedactedCanvas: exportRedactedCanvas,
    copyToClipboard: copyToClipboard,
    confBadge: confBadge,
    summaryChip: summaryChip
  };
})();
