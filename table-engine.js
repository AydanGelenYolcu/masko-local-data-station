/* Maskeleme İstasyonu — Tablo Motoru
 *
 * Akış:  dosya -> satırlar -> başlık satırını bul -> kolonları profille
 *        -> tip tespiti (güven skoruyla) -> veri pasaportu + sahte örnek
 *        -> LLM'e yapıştırılacak hazır prompt
 *
 * Hiçbir adımda ağ erişimi yoktur.
 */
(function(){
  "use strict";

  var TC = window.TypeCatalog;

  var PROFIL_SATIR_LIMITI = 20000;   // istatistik için bu kadar satır fazlasıyla yeter
  var ORNEK_HUCRE_SAYISI  = 300;     // tip testi için kolon başına örneklenecek hücre
  var MAX_DISTINCT_TAKIP  = 5000;    // benzersiz değer sayacı üst sınırı
  var HIZALI_ORNEK_SAYISI = 250;     // kolonlar arası ilişki aramak için satır örneği

  // Sadece örüntüyle (checksum'sız) tespit edildiğinde bile güçlü sayılan tipler.
  var GUCLU_ORUNTU = { email:1, uuid:1, mac:1, ip:1, plaka:1, kep:1, url:1, sasi:1,
                       koordinat:1, kripto:1, swift:1, telefon:1, telefon_intl:1 };

  /* =====================================================================
   * 0. KÜÇÜK YARDIMCILAR
   * Dizi, ağırlık ve ad işlemleri motorun her bölümünde tekrar ettiği için
   * tek yerde toplandı.
   * ===================================================================== */

  function topla(dizi){
    var t = 0;
    for(var i=0;i<dizi.length;i++){ t += dizi[i]; }
    return t;
  }

  function sifirDizi(n){
    var out = [];
    for(var i=0;i<n;i++){ out.push(0); }
    return out;
  }

  function enBuyukIndex(dizi){
    return dizi.indexOf(Math.max.apply(null, dizi));
  }

  /* ÇIKTI DİLİ: kopyalanan veri pasaportu, LLM prompt'u ve SQL yorumları
     DOM'a değil panoya gider; dil.js onları göremez. Arayüz dili İngilizceyse
     bu metinler de İngilizce üretilir. Sözlük dil/en.js'tedir, erişim
     window.MaskoDil üzerinden; MaskoDil yoksa (worker, test) Türkçe kaynak
     döner. Yalnız dışa giden metin çevrilir; arayüze yazılan Türkçe kalır
     ki DOM çevirisi dil değişiminde geriye doğru da çalışabilsin. */
  function mt(metin){
    if(typeof window !== "undefined" && window.MaskoDil && window.MaskoDil.t){
      return window.MaskoDil.t.apply(null, arguments);
    }
    var degerler = Array.prototype.slice.call(arguments, 1);
    return String(metin).replace(/\{(\d+)(:t)?\}/g, function(_, i){
      return degerler[i] !== undefined ? String(degerler[i]) : "";
    });
  }

  // Binlik ayracı çıktı diline göre: pasaporttaki "1.234" İngilizcede "1,234".
  function yerelSayi(n){
    var en = typeof window !== "undefined" && window.MaskoDil && window.MaskoDil.dil() === "en";
    return Number(n).toLocaleString(en ? "en-US" : "tr-TR");
  }

  /* Ağırlıklı çekiliş: dizideki paylara göre bir indeks döndürür.
     Tam olarak BİR rng() çağrısı harcar — tohumlu üretimde çağrı sayısı
     çıktının parçasıdır, bu yüzden boş/sıfır dizide de erken dönülmez. */
  function agirlikliIndex(rng, agirliklar){
    var r = rng() * topla(agirliklar), birikim = 0;
    for(var i=0;i<agirliklar.length;i++){
      birikim += agirliklar[i];
      if(r <= birikim) return i;
    }
    return agirliklar.length - 1;
  }

  function padSag(s, n){
    s = String(s);
    while(s.length < n){ s += " "; }
    return s;
  }

  /* Ad çakışmalarını "_2", "_3" ekiyle ayırır; "kullanilan" haritası çağrılar
     boyunca taşınarak aynı ada ikinci kez düşülmesi engellenir. */
  function benzersizAd(ad, kullanilan){
    var temel = ad, n = 2;
    while(kullanilan[ad]){ ad = temel + "_" + n; n++; }
    kullanilan[ad] = true;
    return ad;
  }

  // Gerçek bir ölçüm (metrik) kolonu mu? Pasaport ve SQL tipi bunu aynı
  // ölçüte göre belirler: sayısal istatistiği olan ve tipi sayısal olan kolon.
  function olcumKolonuMu(kol){
    return !!kol.sayi && (kol.tespit.type.numeric || kol.tespit.type.id === "sayi");
  }

  /* =====================================================================
   * 1. DOSYA OKUMA
   * ===================================================================== */

  function readTextSmart(file){
    return new Promise(function(resolve, reject){
      var fr = new FileReader();
      fr.onerror = function(){ reject(new Error("Dosya okunamadı")); };
      fr.onload = function(){
        var text = fr.result;
        // UTF-8 çözümünde bozuk karakter çoksa, Türkçe Excel'in klasik
        // windows-1254 çıktısıdır; yeniden dene.
        var bozuk = (text.match(/�/g) || []).length;
        if(bozuk > 0 && bozuk > text.length / 5000){
          var fr2 = new FileReader();
          fr2.onload = function(){ resolve(fr2.result); };
          fr2.onerror = function(){ resolve(text); };
          fr2.readAsText(file, "windows-1254");
          return;
        }
        resolve(text);
      };
      fr.readAsText(file, "utf-8");
    });
  }

  function readArrayBuffer(file){
    return new Promise(function(resolve, reject){
      var fr = new FileReader();
      fr.onload = function(){ resolve(fr.result); };
      fr.onerror = function(){ reject(new Error("Dosya okunamadı")); };
      fr.readAsArrayBuffer(file);
    });
  }

  /* CSV okuma, ayraç tespiti, yazma ve formül koruması csv-io.js'te tek yerde
     tutulur: tablo, dosya maskeleme, tezgâh ve kitle modülleri aynı kuralı
     kullansın, bir kopyada düzeltilen hata ötekinde yaşamasın. Sayfa ve worker
     onu bu dosyadan önce yükler. Çözüm çağrı anında yapılır ki CSV'ye hiç
     dokunmayan kullanımlar (analyze, pasaport) ona bağımlı olmasın. */
  function csvIO(){
    if(typeof CsvIO !== "undefined") return CsvIO;
    throw new Error("csv-io.js yüklenmedi; CSV okunamaz/yazılamaz.");
  }

  // Ayraç, ilk ~20 kayıtta EN TUTARLI alan sayısını (>1) veren adaydır;
  // karakter saymak adreste virgül geçen ';' dosyasında yanıltıyordu.
  function detectDelimiter(text){
    return csvIO().detectDelimiter(text);
  }

  // Tırnak içi ayraç ve satır sonlarını doğru işleyen CSV ayrıştırıcı.
  // ilerleme: büyük dosyalarda arayüzü canlı tutmak için periyodik geri çağrı.
  // maxSatir: yalnızca ilk N satır gerekiyorsa erken durur.
  function parseCSV(text, delim, ilerleme, maxSatir){
    return csvIO().parse(text, {
      delimiter: delim || null,
      onProgress: ilerleme || null,
      maxRows: maxSatir
    }).rows;
  }

  function parseFile(file, ilerleme){
    function bildir(asama, yuzde){ if(ilerleme) ilerleme(asama, yuzde); }
    var ad = file.name.toLowerCase();
    if(/\.(xlsx|xlsm|xlsb|xls)$/.test(ad)){
      bildir("okuma", 0);
      return readArrayBuffer(file).then(function(buf){
        bildir("cozumleme", 0.25);
        var wb = XLSX.read(new Uint8Array(buf), { type:"array", cellDates:true, raw:false });
        bildir("cozumleme", 0.7);
        var toplam = wb.SheetNames.length;
        var sayfalar = wb.SheetNames.map(function(name, i){
          var ws = wb.Sheets[name];
          var rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:"", raw:false, blankrows:false });
          bildir("cozumleme", 0.7 + 0.3 * ((i+1)/toplam));
          return { name:name, rows:rows };
        }).filter(function(s){ return s.rows.length > 0; });
        bildir("bitti", 1);
        return sayfalar;
      });
    }
    bildir("okuma", 0);
    return readTextSmart(file).then(function(text){
      bildir("cozumleme", 0.2);
      var delim = detectDelimiter(text);
      var rows = parseCSV(text, delim, function(oran){
        bildir("cozumleme", 0.2 + oran * 0.8);
      }).filter(function(r){
        return r.some(function(c){ return String(c).trim() !== ""; });
      });
      bildir("bitti", 1);
      return [{ name: file.name, rows: rows, delimiter: delim }];
    });
  }

  /* =====================================================================
   * 2. BAŞLIK SATIRINI BUL
   * Gerçek hayattaki Excel'lerde başlık 1. satırda olmaz: üstte logo,
   * rapor adı, boş satırlar olur. En sık kırılma noktası burasıdır.
   * ===================================================================== */
  function findHeaderRow(rows){
    var bakilacak = Math.min(15, Math.max(0, rows.length - 1));
    var maxGenislik = 0;
    for(var r=0; r<=bakilacak; r++){
      maxGenislik = Math.max(maxGenislik, doluSayisi(rows[r]));
    }
    var enIyi = 0, enIyiSkor = -Infinity;
    for(var i=0; i<=bakilacak; i++){
      var skor = puanlaBaslik(rows, i, maxGenislik);
      if(skor > enIyiSkor){ enIyiSkor = skor; enIyi = i; }
    }
    return enIyi;
  }

  function doluSayisi(row){
    if(!row) return 0;
    var n = 0;
    for(var i=0;i<row.length;i++){ if(String(row[i]).trim() !== "") n++; }
    return n;
  }

  function puanlaBaslik(rows, idx, maxGenislik){
    var row = rows[idx];
    if(!row) return -Infinity;
    var dolu = doluSayisi(row);
    if(dolu < 2) return -Infinity;

    var skor = (dolu / maxGenislik) * 10;

    // Başlık hücreleri metin olur, sayı olmaz. Harita prototipsizdir:
    // "constructor" başlıklı bir hücre tekrar sayılmasın.
    var metin = 0, benzersiz = Object.create(null);
    var tekrar = 0;
    for(var i=0;i<row.length;i++){
      var v = String(row[i]).trim();
      if(!v) continue;
      if(!TC.isNumericLike(v) && !TC.isDateLike(v)) metin++;
      if(benzersiz[v]) tekrar++; else benzersiz[v] = true;
    }
    skor += (metin / dolu) * 6;
    skor -= tekrar * 2;                       // aynı başlık iki kez olmaz
    skor -= idx * 0.4;                        // eşitlikte üstteki satır kazansın

    // Altındaki satırlar aynı genişlikte veri içermeli
    var altDolu = 0, bakilan = 0;
    for(var k=idx+1; k<Math.min(idx+6, rows.length); k++){
      altDolu += doluSayisi(rows[k]); bakilan++;
    }
    if(bakilan){
      var ort = altDolu / bakilan;
      skor += Math.min(ort / Math.max(dolu,1), 1) * 5;
      // Alt satırlar başlıktan tip olarak farklıysa (sayı/tarih) bu iyi bir işaret
      var altSayisal = 0, altToplam = 0;
      for(var m=idx+1; m<Math.min(idx+6, rows.length); m++){
        var rr = rows[m] || [];
        for(var c=0;c<row.length;c++){
          var cv = String(rr[c] === undefined ? "" : rr[c]).trim();
          if(!cv) continue;
          altToplam++;
          if(TC.isNumericLike(cv) || TC.isDateLike(cv)) altSayisal++;
        }
      }
      if(altToplam) skor += (altSayisal / altToplam) * 4;
    }
    return skor;
  }

  function benzersizBaslik(raw, idx, kullanilan){
    var ad = String(raw === undefined || raw === null ? "" : raw).trim();
    return benzersizAd(ad || ("kolon_" + (idx + 1)), kullanilan);
  }

  /* =====================================================================
   * 3. KOLON PROFİLLEME
   * ===================================================================== */
  function profileTable(rows, headerRowIdx){
    var header = rows[headerRowIdx] || [];
    var genislik = 0;
    for(var r=headerRowIdx; r<rows.length; r++){
      genislik = Math.max(genislik, (rows[r] || []).length);
    }
    // Hücre değeri ya da başlık anahtar olarak kullanılan haritalar
    // prototipsizdir: "constructor" / "__proto__" değerli bir hücre sayaçları
    // bozuyor, "toString" başlığı ise "toString_2" diye yeniden adlanıyordu.
    var kullanilan = Object.create(null);
    var kolonlar = [];
    var akislar = [];
    for(var c=0;c<genislik;c++){
      kolonlar.push({
        index: c,
        name: benzersizBaslik(header[c], c, kullanilan),
        values: [],     // tohumlu rezervuar örneklemi — tüm dosyaya yayılır
        hamOrnek: [],   // satır satır hizalı — kolonlar arası ilişki aramak için
        bos: 0,
        distinct: Object.create(null),
        distinctSayisi: 0,
        distinctTasti: false
      });
      akislar.push(sayiAkisiYeni(c));
    }

    var veriSatirlari = rows.length - headerRowIdx - 1;
    var adim = veriSatirlari > PROFIL_SATIR_LIMITI ? Math.ceil(veriSatirlari / PROFIL_SATIR_LIMITI) : 1;
    var okunan = 0;
    // Hizalı örnek dosyanın başına yığılmasın: baştan sona yayılmalı.
    // Ama SABİT adım da tehlikeli — satırlar dönüşümlü sıralıysa (her maç
    // sırayla, her şube sırayla) adım periyotla çakışıp tek bir gruba
    // kilitlenir. Altın oranlı kaydırma bu çakışmayı kırar.
    var okunacak = Math.ceil(veriSatirlari / adim);
    var hamAdim = Math.max(1, okunacak / HIZALI_ORNEK_SAYISI);
    var hamHedef = {};
    for(var h=0; h<HIZALI_ORNEK_SAYISI; h++){
      var yer = Math.floor(h * hamAdim + ((h * 0.6180339887498949) % 1) * hamAdim);
      if(yer < okunacak){ hamHedef[yer] = true; }
    }

    for(var i=headerRowIdx+1; i<rows.length; i += adim){
      var row = rows[i] || [];
      okunan++;
      for(var k=0;k<kolonlar.length;k++){
        var kol = kolonlar[k];
        var raw = row[k];
        var v = (raw === undefined || raw === null) ? "" : String(raw).trim();
        if(hamHedef[okunan - 1] && kol.hamOrnek.length < HIZALI_ORNEK_SAYISI){
          kol.hamOrnek.push(v);
        }
        if(v === ""){ kol.bos++; continue; }
        akisaEkle(akislar[k], kol, v);
        if(!kol.distinctTasti){
          if(!kol.distinct[v]){
            kol.distinct[v] = 0;
            kol.distinctSayisi++;
            if(kol.distinctSayisi > MAX_DISTINCT_TAKIP){ kol.distinctTasti = true; }
          }
          kol.distinct[v]++;
        }
      }
    }

    kolonlar.forEach(function(kol, k){
      kol.orneklenenSatir = okunan;
      kol.doluSayisi = okunan - kol.bos;
      kol.bosOran = okunan ? kol.bos / okunan : 0;
      istatistikCikar(kol, akislar[k]);
    });

    turetilmisKolonlariBul(kolonlar);
    hiyerarsiBul(kolonlar);

    return {
      headerRowIdx: headerRowIdx,
      toplamSatir: veriSatirlari,
      orneklenenSatir: okunan,
      orneklemeAdimi: adim,
      columns: kolonlar
    };
  }

  /* Sayısal istatistik TÜM okunan satırlardan akışla çıkarılır: eskiden yalnızca
     ilk ~1.200 dolu hücre tutuluyordu ve 1..5000 sıralı bir dosya "en büyük
     1200" diye raporlanıyordu. Sayı biçimi (TR/EN) ancak kolonun sonunda belli
     olduğundan iki yorum ayrı biriktirilir; ikisi yalnızca "12.500" gibi
     belirsiz hücrelerde ayrışır. */
  function sayiAkisiYeni(c){
    return {
      rng: TC.makeRng(TC.hashSeed("profil#" + c)),
      gorulen: 0,
      kanit: { tr:0, en:0, "tr?":0, "en?":0 },
      coz: { kanit:null, tr:NaN, en:NaN },   // hücre başına nesne üretilmesin
      tr: istatistikYeni(),
      en: istatistikYeni()
    };
  }

  function istatistikYeni(){ return { n:0, min:Infinity, max:-Infinity, ort:0, m2:0 }; }

  // Welford: tek geçişte ortalama ve varyans; toplam-kare yöntemi büyük
  // tutarlarda hassasiyet kaybeder.
  function istatistigeEkle(s, x){
    s.n++;
    if(x < s.min) s.min = x;
    if(x > s.max) s.max = x;
    var fark = x - s.ort;
    s.ort += fark / s.n;
    s.m2 += fark * (x - s.ort);
  }

  function akisaEkle(a, kol, v){
    // Algoritma R rezervuar örneklemi: her dolu hücre örneğe eşit olasılıkla
    // girer, örnek dosyanın başına yığılmaz. Math.random değil kolon tohumlu
    // üreteç kullanılır — aynı dosya her seferinde aynı profili verir.
    a.gorulen++;
    var kap = ORNEK_HUCRE_SAYISI * 4;
    if(kol.values.length < kap){ kol.values.push(v); }
    else {
      var j = Math.floor(a.rng() * a.gorulen);
      if(j < kap){ kol.values[j] = v; }
    }
    if(!TC.isNumericLike(v)) return;
    // Her okunan hücre çözümlendiği için genel parseNumber yerine hızlı yol
    var c = TC.sayiHucresiCoz(v, a.coz);
    if(c.kanit){ a.kanit[c.kanit]++; }
    if(!isNaN(c.tr)) istatistigeEkle(a.tr, c.tr);
    if(!isNaN(c.en)) istatistigeEkle(a.en, c.en);
  }

  function istatistikCikar(kol, akis){
    var sayisal = [], tarihli = 0, tarihFormat = null, ondalikBasamak = 0;
    var gunAyBelirsiz = true, gunOnce = null;

    // Biçim kolonun tamamındaki kanıttan seçilir ve kolon boyunca tutarlı
    // uygulanır: "12.500" TR kolonunda 12500'dür, 12,5 değil (istatistikler
    // aksi hâlde 1000 kat sapıyordu).
    var bicim = TC.sayiBicimiSec(akis.kanit);
    var ist = bicim === "en" ? akis.en : akis.tr;
    kol.sayiBicimi = bicim;

    for(var i=0;i<kol.values.length;i++){
      var v = kol.values[i];
      if(TC.isNumericLike(v)){
        var n = TC.parseNumber(v, bicim);
        if(!isNaN(n)){
          sayisal.push(n);
          var hane = TC.ondalikBasamak(v, bicim);
          if(hane <= 4){ ondalikBasamak = Math.max(ondalikBasamak, hane); }
        }
      }
      if(TC.isDateLike(v)){
        tarihli++;
        var p = tarihKalibi(v);
        if(p){
          if(!tarihFormat) tarihFormat = p.fmt;
          // gg/aa mı aa/gg mi? Kolonun tamamına bakınca çözülür.
          if(p.order === "dmy" || p.order === "mdy"){
            var parts = String(v).trim().split(/[./]/);
            var a = Number(parts[0]), b = Number(parts[1]);
            if(a > 12 && gunOnce === null){ gunOnce = true; gunAyBelirsiz = false; }
            else if(b > 12 && gunOnce === null){ gunOnce = false; gunAyBelirsiz = false; }
          } else {
            gunAyBelirsiz = false;
          }
        }
      }
    }

    kol.sayisalOran = kol.doluSayisi ? ist.n / kol.doluSayisi : 0;
    kol.tarihOran = kol.values.length ? tarihli / kol.values.length : 0;
    kol.tarihFormat = tarihFormat;
    kol.tarihBelirsiz = tarihli > 0 && gunAyBelirsiz && /D/.test(tarihFormat || "");
    kol.gunOnce = gunOnce === null ? true : gunOnce;   // TR varsayilani gg/aa
    kol.ondalikBasamak = ondalikBasamak;

    if(ist.n >= 2){
      // Uç değerler, ortalama ve sapma tüm okunan satırlardan; medyan
      // rezervuar örnekleminden (yaklaşık ama dosyanın tamamını temsil eder).
      sayisal.sort(function(a,b){ return a-b; });
      var ort = ist.ort;
      kol.sayi = {
        min: ist.min,
        max: ist.max,
        ortalama: ort,
        medyan: sayisal.length ? sayisal[Math.floor(sayisal.length/2)] : ort,
        sapma: Math.sqrt(ist.m2 / ist.n),
        negatifVar: ist.min < 0
      };
      // Ortalama medyandan belirgin uzaksa dağılım çarpıktır
      var yayilim = kol.sayi.max - kol.sayi.min;
      kol.sayi.carpik = yayilim > 0 && Math.abs(ort - kol.sayi.medyan) / yayilim > 0.1;
    }

    // Kategorik mi? Az sayıda tekrar eden değer.
    kol.kategorik = !kol.distinctTasti &&
                    kol.distinctSayisi > 0 &&
                    kol.distinctSayisi <= 60 &&
                    (kol.doluSayisi === 0 || kol.distinctSayisi / Math.max(kol.doluSayisi,1) < 0.5);

    // Tanımlayıcı kolonlarda basamak sayısını koru (10000 -> 6 haneli üretme)
    var uzunluklar = {};
    for(var u=0; u<kol.values.length; u++){
      var L = String(kol.values[u]).replace(/\D/g,"").length;
      if(L){ uzunluklar[L] = (uzunluklar[L] || 0) + 1; }
    }
    var enSikUzunluk = enSik(uzunluklar, 1);
    kol.tipikUzunluk = enSikUzunluk.length ? Number(enSikUzunluk[0].deger) : 6;

    kol.enSikDegerler = enSik(kol.distinct, 10);
    kol.distinctDegerler = kol.distinctTasti ? [] : Object.keys(kol.distinct);

    if(kol.tarihOran >= 0.7){ zamanProfiliCikar(kol); }
    else { saatProfiliCikar(kol); }
  }

  /* Bir kolon başka iki kolonun çarpımı/toplamı mı?
     LLM bunu bilmezse "hem adet hem toplam_tutar'ı topla" gibi çift sayma
     hataları yapar. Yalnızca ölçüm kolonları arasında, örneklem üzerinde arar. */
  function turetilmisKolonlariBul(kolonlar){
    var sayisallar = kolonlar.filter(function(k){
      return k.sayi && k.sayisalOran > 0.9;
    });
    if(sayisallar.length < 3 || sayisallar.length > 10) return;

    function deger(kol, i){ return TC.parseNumber(kol.hamOrnek[i], kol.sayiBicimi); }

    sayisallar.forEach(function(hedef){
      for(var a=0; a<sayisallar.length; a++){
        for(var b=a+1; b<sayisallar.length; b++){
          var ka = sayisallar[a], kb = sayisallar[b];
          if(ka === hedef || kb === hedef) continue;
          var carpim = 0, toplam = 0, bakilan = 0;
          var n = Math.min(hedef.hamOrnek.length, 120);
          for(var i=0;i<n;i++){
            var h = deger(hedef,i), x = deger(ka,i), y = deger(kb,i);
            if(isNaN(h) || isNaN(x) || isNaN(y)) continue;
            bakilan++;
            var tol = Math.max(Math.abs(h) * 1e-6, 0.01);
            if(Math.abs(h - x*y) <= tol) carpim++;
            if(Math.abs(h - (x+y)) <= tol) toplam++;
          }
          if(bakilan < 20) continue;
          // Yalnızca kolon indeksi saklanır; ad, çıktı anında dışa aktarılan
          // adla çözülür (turetilmisAciklama). Ham ad buraya gömülürse başlık
          // gizlense de pasaport "= adet × proje_kartal_fiyat" diye sızdırır.
          if(carpim / bakilan > 0.97){
            hedef.turetilmisRef = { a: ka.index, b: kb.index, op: "*" };
            return;
          }
          if(toplam / bakilan > 0.97){
            hedef.turetilmisRef = { a: ka.index, b: kb.index, op: "+" };
            return;
          }
        }
      }
    });
  }

  function tarihKalibi(v){
    var s = String(v).trim().split(/[ T]/)[0];
    for(var i=0;i<TC.DATE_PATTERNS.length;i++){
      if(TC.DATE_PATTERNS[i].re.test(s)) return TC.DATE_PATTERNS[i];
    }
    return null;
  }

  function enSik(sayacObj, n){
    var arr = Object.keys(sayacObj).map(function(k){ return { deger:k, adet:sayacObj[k] }; });
    arr.sort(function(a,b){ return b.adet - a.adet; });
    return arr.slice(0, n);
  }

  /* =====================================================================
   * 4. TİP TESPİTİ
   * Güven skoru uydurma değil: checksum'lı tiplerde ölçülmüş yanlış-pozitif
   * oranının (fp) doğrulanan hücre sayısı kadar kuvveti alınır.
   * ===================================================================== */
  // "kan_grubu" ile "kan grubu" aynı şeydir; başlık regexleri boşluk bekler.
  function baslikNormalize(ad){
    // camelCase'i de ayır: "eventId" -> "event Id", yoksa  kalıpları tutmaz
    return TC.camelAyir(String(ad)).replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function detectColumn(kol){
    var ornek = orneklemeYap(kol.values, ORNEK_HUCRE_SAYISI);
    var baslik = baslikNormalize(kol.name);
    var adaylar = [];

    TC.TYPES.forEach(function(t){
      var basligEsti = false;
      for(var i=0;i<(t.header||[]).length;i++){
        if(t.header[i].test(baslik) || t.header[i].test(kol.name)){ basligEsti = true; break; }
      }

      // Opak tanımlayıcılarda (bilet no, kombine no, sıra...) örüntü tek başına
      // hiçbir şey söylemez — "25000" hem kapasite hem kombine no olabilir.
      if(t.headerGerekli && !basligEsti) return;

      if(t.headerOnly){
        if(basligEsti){
          // Bu tipler yalnızca oldukça spesifik başlık kelimeleriyle tetiklenir,
          // dolayısıyla eşleşme güçlü bir kanıttır. KVKK m.6 özel nitelikli
          // başlıklar (hiv, sabika, sendika...) her şeyin önüne geçmelidir.
          // Bu tiplerin başlık kalıpları oldukça spesifiktir (aciklama/comment,
          // departman/position, hiv/sabika); eşleşme güçlü bir kanıttır.
          adaylar.push({ type:t, guven: t.ozel ? 0.93 : 0.86, hucreOran:0,
                         gerekce: t.ozel ? "başlık adı özel nitelikli bir veriyi işaret ediyor"
                                         : "başlık adından tanındı (hücre örüntüsü yok)",
                         basligEsti:true });
        }
        return;
      }
      if(!ornek.length) return;

      var gecen = 0;
      for(var j=0;j<ornek.length;j++){
        try { if(t.test(ornek[j])) gecen++; } catch(e){}
      }
      var oran = gecen / ornek.length;

      // Başlık kontrol haneli bir türü söylüyor, değerler o türün BİÇİMİNDE ama
      // kontrol hanesi tutmuyor (test/uydurma veri ya da yanlış sütun): tür
      // başlıktan seçilir ve kullanıcı uyarılır. Eskiden tür adaylıktan düşüyor,
      // uydurma TCKN'ler "Maaş", IBAN'lar "Parola" diye pasaporta giriyordu.
      if(t.checksum && basligEsti && t.bicim && oran < 0.7){
        var bicimGecen = 0;
        for(var b=0;b<ornek.length;b++){
          try { if(t.bicim(ornek[b])) bicimGecen++; } catch(e){}
        }
        if(bicimGecen / ornek.length >= 0.7){
          adaylar.push({ type:t, guven:0.84, hucreOran:oran, basligEsti:true,
            gerekce: mt("başlık adı ve biçim uyuyor; kontrol hanesi tutan hücre %{0}", Math.round(oran*100)),
            uyari: mt("Başlık “{0}” diyor ve değerler bu biçimde, ama kontrol hanesi hücrelerin yalnız %{1} kadarında tutuyor. Test verisi ya da yanlış sütun olabilir; türü kontrol edin.",
                      t.label, Math.round(oran*100)) });
          return;
        }
      }
      if(oran < 0.7 && !(basligEsti && oran > 0.4)) return;

      var guven, gerekce, uyari = null;
      if(t.checksum && oran >= 0.9){
        // Ölçülmüş yanlış-pozitif oranının doğrulanan hücre sayısı kadar kuvveti.
        var yanlisIhtimal = Math.pow(t.fp || 0.1, gecen);
        guven = 1 - yanlisIhtimal;
        gerekce = mt("checksum doğrulaması {0} hücreden {1} geçti", gecen, gecen);
      } else if(GUCLU_ORUNTU[t.id] && oran >= 0.9){
        guven = basligEsti ? 0.95 : 0.88;
        gerekce = "örüntü eşleşmesi %" + Math.round(oran*100) + (basligEsti ? " + başlık adı" : "");
      } else if(oran >= 0.95 && basligEsti){
        guven = 0.92;
        gerekce = "örüntü eşleşmesi %" + Math.round(oran*100) + " + başlık adı";
      } else if(oran >= 0.95){
        guven = 0.78;
        gerekce = "örüntü eşleşmesi %100, başlık ipucu yok";
      } else if(basligEsti){
        guven = 0.60 + oran * 0.12;
        gerekce = mt("başlık adı eşleşti; hücre uyumu %{0}", Math.round(oran*100));
        if(t.checksum){
          uyari = mt("Başlık “{0}” diyor ama kontrol hanesi hücrelerin yalnız %{1} kadarında tutuyor; bir kısmı hatalı ya da başka türde olabilir. Türü kontrol edin.",
                     t.label, Math.round(oran*100));
        }
      } else {
        guven = 0.40 + oran * 0.25;
        gerekce = "örüntü eşleşmesi %" + Math.round(oran*100) + " (başlık ipucu yok)";
      }

      // Gerçek bir isim/adres/firma kolonu çeşitlidir. Az sayıda değer
      // tekrar ediyorsa bu bir kategori kolonudur — "Kredi Kartı" iki büyük
      // harfli Türkçe kelimedir ama isim değildir.
      if(t.highCard && !basligEsti && kol.doluSayisi > 20){
        var cesitlilik = kol.distinctTasti ? 1 : (kol.distinctSayisi / kol.doluSayisi);
        if(cesitlilik < 0.05){
          guven *= 0.35;
          gerekce = "değerler çok az çeşitli (" + kol.distinctSayisi + " farklı) — isim kolonu gibi durmuyor";
        }
      }

      // Genel amaçlı tipler, daha spesifik bir tiple berabere kalırsa kaybetsin
      if(t.genelAmacli){ guven -= 0.03; }

      adaylar.push({ type:t, guven:guven, hucreOran:oran, gerekce:gerekce, basligEsti:basligEsti, uyari:uyari });
    });

    adaylar.sort(function(a,b){ return b.guven - a.guven; });

    var secim = adaylar[0];
    if(!secim || secim.guven < 0.5){
      secim = yapisalTahmin(kol, secim);
    }

    return {
      typeId: secim.type.id,
      type: secim.type,
      guven: Math.min(secim.guven, 0.9999),
      guvenEtiket: guvenEtiketi(secim.guven),
      gerekce: secim.gerekce,
      uyari: secim.uyari || baslikCatismasi(kol, baslik, secim),
      alternatifler: adaylar.slice(0, 4).map(function(a){
        return { id:a.type.id, label:a.type.label, guven:a.guven };
      })
    };
  }

  /* Başlık kontrol haneli hassas bir türü (TCKN, IBAN, VKN, kart…) söylüyor
     ama seçilen tür başka ve başlıkla eşleşmedi: değerler kazanır, kullanıcı
     uyarılır. Yalnız kontrol haneli türler: başlık kalıpları belirgindir,
     "prim" gibi geniş kalıplar yanlış alarm üretmez. */
  function baslikCatismasi(kol, baslik, secim){
    if(secim.basligEsti) return null;
    for(var i=0;i<TC.TYPES.length;i++){
      var t = TC.TYPES[i];
      if(!t.checksum || t.id === secim.type.id) continue;
      for(var j=0;j<(t.header||[]).length;j++){
        if(t.header[j].test(baslik) || t.header[j].test(kol.name)){
          return mt("Başlık “{0}” diyor ama değerler bu biçimde değil; “{1}” seçildi. Sütun türünü kontrol edin.", t.label, secim.type.label);
        }
      }
    }
    return null;
  }

  function yapisalTahmin(kol, zayifAday){
    var t;
    if(kol.kategorik && kol.distinctSayisi <= 40){
      t = TC.typeById("kategori");
      return { type:t, guven:0.85, gerekce:"yalnızca " + kol.distinctSayisi + " farklı değer tekrar ediyor" };
    }
    if(kol.tarihOran >= 0.9){ t = TC.typeById("tarih"); return { type:t, guven:0.85, gerekce:"hücrelerin %" + Math.round(kol.tarihOran*100) + " kadarı tarih formatında" }; }
    if(kol.sayisalOran >= 0.95){ t = TC.typeById("sayi"); return { type:t, guven:0.85, gerekce:"hücrelerin %" + Math.round(kol.sayisalOran*100) + " kadarı sayısal" }; }
    if(kol.tarihOran >= 0.7){ t = TC.typeById("tarih"); return { type:t, guven:0.65, gerekce:"hücrelerin %" + Math.round(kol.tarihOran*100) + " kadarı tarih formatında" }; }
    if(kol.sayisalOran >= 0.8){ t = TC.typeById("sayi"); return { type:t, guven:0.65, gerekce:"hücrelerin %" + Math.round(kol.sayisalOran*100) + " kadarı sayısal" }; }
    if(kol.kategorik){ t = TC.typeById("kategori"); return { type:t, guven:0.7, gerekce:kol.distinctSayisi + " farklı değer tekrar ediyor" }; }
    if(zayifAday && zayifAday.guven >= 0.4) return zayifAday;
    t = TC.typeById("metin");
    return { type:t, guven:0.4, gerekce:"belirgin bir örüntü bulunamadı" };
  }

  function guvenEtiketi(g){
    if(g >= 0.999) return "kesin";
    if(g >= 0.85) return "yüksek";
    if(g >= 0.6) return "orta";
    return "düşük";
  }

  function orneklemeYap(arr, n){
    if(arr.length <= n) return arr;
    var out = [], adim = arr.length / n;
    for(var i=0;i<n;i++){ out.push(arr[Math.floor(i*adim)]); }
    return out;
  }

  /* =====================================================================
   * 5. GERÇEK DEĞER GEÇİŞ KARARI
   * Varsayılan: hiçbir gerçek değer gitmez. Otomatik geçen iki istisna:
   * bilinen güvenli sözlükle eşleşenler (il adı, ay adı, evet/hayır...) ve
   * kişiyi işaret etmeyen ölçüm tipleri (varsayilanGercek: adet / kayıt
   * sayısı — kimlik maskelenirken sayımlar tutsun diye). İkisi de tek
   * tıkla sahteye çevrilebilir.
   * ===================================================================== */
  function passthroughKarari(kol, tespit){
    var t = tespit.type;
    if(t.passthrough === "never"){
      return { mod:"uret", sebep:"hassas tip — gerçek değer hiçbir koşulda gönderilmez", degistirilebilir:false };
    }
    if(t.varsayilanGercek){
      return { mod:"gercek", sebep:t.gercekSebebi || "kişiyi işaret etmez — değerler aynen kalır", degistirilebilir:true };
    }
    var degerler = kol.distinctDegerler;
    if(degerler.length && degerler.length <= 200){
      var voc = TC.guvenliSozlukEslesmesi(degerler);
      if(voc){
        return { mod:"gercek", sebep:"bilinen güvenli sözlük (" + voc.label + ") — kişiyi işaret etmez",
                 degistirilebilir:true, sozluk:voc.id };
      }
    }
    if(t.passthrough === "ask"){
      return { mod:"uret", sebep:"tanınmayan değerler — güvenli tarafta kalındı, açmak sizin kararınız",
               degistirilebilir:true, dikkat:true };
    }
    return { mod:"uret", sebep:"varsayılan olarak üretiliyor", degistirilebilir:true };
  }

  /* =====================================================================
   * 6. SAHTE VERİ ÜRETİMİ
   * ===================================================================== */
  function normalRnd(rng){
    var u = 0, v = 0;
    while(u === 0){ u = rng(); }
    while(v === 0){ v = rng(); }
    return Math.sqrt(-2*Math.log(u)) * Math.cos(2*Math.PI*v);
  }

  function sayiUret(rng, kol){
    var s = kol.sayi;
    if(!s) return String(TC.randInt(rng, 1, 100));
    var deger;
    if(s.carpik && s.min >= 0){
      // Çarpık dağılım: log-normal benzeri üretim
      var logOrt = Math.log(Math.max(s.medyan, 0.001));
      var logSapma = Math.max(Math.log(Math.max(s.max,1) / Math.max(s.medyan, 0.001)) / 3, 0.1);
      deger = Math.exp(logOrt + normalRnd(rng) * logSapma);
    } else {
      deger = s.ortalama + normalRnd(rng) * (s.sapma || Math.abs(s.ortalama || 1) * 0.2);
    }
    if(deger < s.min) deger = s.min + rng() * (s.max - s.min) * 0.1;
    if(deger > s.max) deger = s.max - rng() * (s.max - s.min) * 0.1;
    return sayiYaz(kol, deger);
  }

  // Kolonun kendi biçimiyle yazar: TR kolonda "697,53" ("697.53" TR'de 69.753 okunur).
  function sayiYaz(kol, n){
    var metin = kol.ondalikBasamak > 0 ? n.toFixed(kol.ondalikBasamak) : String(Math.round(n));
    return kol.sayiBicimi === "tr" && kol.ondalikBasamak > 0 ? metin.replace(".", ",") : metin;
  }

  function tarihUret(rng, kol){
    var ctx = { dateFormat: kol.tarihFormat || "YYYY-MM-DD" };
    var yMin = 2023, yMax = 2026;
    if(kol.values.length){
      var yillar = [];
      kol.values.forEach(function(v){
        var m = /(\d{4})/.exec(String(v));
        if(m){ var y = Number(m[1]); if(y > 1900 && y < 2100) yillar.push(y); }
      });
      if(yillar.length){
        yillar.sort(function(a,b){ return a-b; });
        yMin = yillar[0]; yMax = yillar[yillar.length-1];
      }
    }
    return TC.genDate(rng, ctx, yMin, yMax);
  }

  // Kategorik kolonu, gerçek değerleri sızdırmadan aynı frekans dağılımıyla üret
  function kategoriHavuzu(kol, tespit, karar, rng){
    if(karar.mod === "gercek"){
      return kol.enSikDegerler.length ? kol.enSikDegerler : null;
    }
    var n = Math.max(1, Math.min(kol.distinctSayisi || 3, 12));
    var etiketler = [], gorulen = Object.create(null);
    for(var i=0;i<n;i++){
      var deger = null;
      if(tespit.type.gen){
        // Aynı değerin iki kez havuza girmesini engelle — yoksa "cinsiyet"
        // kolonunun tamamı "Erkek" olabiliyor.
        for(var d=0; d<24 && deger === null; d++){
          var aday = tespit.type.gen(rng, { index:i, uzunluk:kol.tipikUzunluk });
          if(!gorulen[aday]){ deger = aday; }
        }
      }
      if(deger === null){ deger = "Kategori_" + (i+1); }
      gorulen[deger] = true;
      etiketler.push({
        deger: deger,
        adet: (kol.enSikDegerler[i] ? kol.enSikDegerler[i].adet : Math.max(1, n - i))
      });
    }
    return etiketler;
  }

  function agirlikliSecOge(rng, havuz){
    var adetler = havuz.map(function(o){ return o.adet; });
    return havuz[agirlikliIndex(rng, adetler)];
  }
  function agirlikliSec(rng, havuz){ return agirlikliSecOge(rng, havuz).deger; }

  function generateSynthetic(analiz, satirSayisi, seedStr){
    var rng = TC.makeRng(TC.hashSeed(seedStr || "maskeleme"));
    var kolonlar = analiz.columns;

    // Hiyerarşik gruplar (stadyum > blok > sıra) tek bir kombinasyon havuzundan
    // beslenir; yoksa imkânsız blok/stadyum eşleşmeleri çıkar.
    var hHavuzlar = hiyerarsiHavuzlari(kolonlar, rng);
    var hKolon = {};
    Object.keys(hHavuzlar).forEach(function(gid){
      hHavuzlar[gid].uyeIndexleri.forEach(function(ci, sira){
        hKolon[ci] = { gid: gid, sira: sira };
      });
    });

    // Kategorik havuzları bir kez kur (satırlar arası tutarlılık için)
    var havuzlar = kolonlar.map(function(k){
      if(hKolon[k.index] !== undefined) return null;     // hiyerarşi ayrı yönetiliyor
      if(k.joinGrubu) return joinHavuzu(k);              // dosyalar arası ortak anahtar
      // Düşük çeşitlilikli bir SAYI kolonu (ör. adet 1-24) hâlâ sayıdır;
      // kategori havuzuna düşerse "Kategori_4" üretiriz.
      var olcum = k.tespit.type.numeric || k.tespit.type.id === "sayi" ||
                  k.tespit.type.id === "tarih" || k.tespit.type.id === "dogum_tarihi" ||
                  !!k.saatProfil;
      if(!olcum && (k.tespit.type.id === "kategori" || k.kategorik)){
        return kategoriHavuzu(k, k.tespit, k.karar, rng);
      }
      return null;
    });

    var basliklar = kolonlar.map(function(k){ return k.disaAktarilanAd || k.name; });
    var satirlar = [];

    for(var r=0; r<satirSayisi; r++){
      var satir = [];
      // Her satır için hiyerarşi gruplarından birer tutarlı kombinasyon çek
      var hSecim = {};
      Object.keys(hHavuzlar).forEach(function(gid){
        hSecim[gid] = agirlikliSecOge(rng, hHavuzlar[gid].liste);
      });

      for(var c=0; c<kolonlar.length; c++){
        var kol = kolonlar[c];
        var h = hKolon[c];
        if(h !== undefined){ satir.push(hSecim[h.gid].parcalar[h.sira]); continue; }
        // Boş oranını da taklit et — kod dropna() gerektiğini görsün
        if(kol.bosOran > 0.01 && rng() < kol.bosOran){ satir.push(""); continue; }
        satir.push(hucreUret(rng, kol, havuzlar[c], r));
      }
      // Türetilmiş kolonları satır içinden yeniden hesapla ki örnek kendi
      // içinde tutarlı olsun (toplam = adet × fiyat gerçekten tutsun).
      for(var t=0; t<kolonlar.length; t++){
        var ref = kolonlar[t].turetilmisRef;
        if(!ref) continue;
        var x = TC.parseNumber(satir[ref.a], kolonlar[ref.a].sayiBicimi), y = TC.parseNumber(satir[ref.b], kolonlar[ref.b].sayiBicimi);
        if(isNaN(x) || isNaN(y)) continue;
        var sonuc = ref.op === "*" ? x * y : x + y;
        satir[t] = sayiYaz(kolonlar[t], sonuc);
      }
      satirlar.push(satir);
    }

    // Join anahtarlarında bu tablonun ürettiği değerleri kaydet ki sonraki
    // tablolar aynı kümeden çeksin ve join örnek üzerinde de satır döndürsün.
    kolonlar.forEach(function(k, ci){
      if(!k.joinGrubu) return;
      // "gercek" modda anahtar gerçek hücre değeridir; prototipsiz harita
      var gorulen = Object.create(null), liste = [];
      satirlar.forEach(function(r){
        var v = r[ci];
        if(v === "" || gorulen[v]) return;
        gorulen[v] = true;
        liste.push(v);
      });
      if(liste.length >= 5 && !joinUretilen[k.joinGrubu]){
        joinUretilen[k.joinGrubu] = liste;
      }
    });

    return { headers: basliklar, rows: satirlar };
  }

  function hucreUret(rng, kol, havuz, satirIndex){
    var t = kol.tespit.type;
    var karar = kol.karar;

    // "GERÇEK değerler" seçilen ölçüm kolonu (adet, tarih, saat) örnekte de
    // gerçek değerlerden çekilir; eskiden sayı/tarih yine sentetik üretiliyor,
    // pasaport ise "gerçek değerler geçer" diyordu.
    if(karar && karar.mod === "gercek" && !havuz){
      var gercek = gercekDegerCek(rng, kol.values);
      if(gercek !== null) return gercek;
    }
    // Saat kolonları kategori havuzuna düşerse "Kategori_2" üretiriz
    if(kol.saatProfil){ return saatUret(rng, kol); }
    if(havuz){ return agirlikliSec(rng, havuz); }
    // Zaman kolonlarında gözlemlenen dağılımın şekli korunur (satış eğrisi)
    if(kol.zaman){ return zamanUret(rng, kol); }
    if(t.numeric || (!t.gen && kol.sayi)){ return sayiUret(rng, kol); }
    if(t.id === "tarih" || t.id === "dogum_tarihi"){ return tarihUret(rng, kol); }
    if(t.gen){ return t.gen(rng, { index: satirIndex, dateFormat: kol.tarihFormat, uzunluk: kol.tipikUzunluk }); }
    if(kol.sayi) return sayiUret(rng, kol);
    return "Deger_" + (satirIndex + 1);
  }

  // Kolonun örneklem değerlerinden (tüm dosyaya yayılmış, tohumlu) birini çeker.
  function gercekDegerCek(rng, degerler){
    if(!degerler || !degerler.length) return null;
    for(var d=0; d<8; d++){
      var v = degerler[Math.floor(rng() * degerler.length)];
      if(v !== "" && v !== null && v !== undefined) return String(v);
    }
    return null;
  }

  /* =====================================================================
   * 6b. ZAMAN SEKLI
   *
   * Bilet satisi zamanda duz dagilmaz: satisa acilista zirve yapar, duser,
   * mac gunune dogru tekrar patlar. Kombine satisi sezon oncesi tek pencerede
   * toplanir. Duzgun rastgele tarih uretirsek "satis egrisini cizdir" diyen
   * analiste LLM duz bir dagilim gosterir ve yanlis grafigi onerir.
   *
   * Bu yuzden gozlemlenen dagilimin SEKLI korunur: 24 kovali zaman histogrami
   * + haftanin gunu + saat dagilimi. Kovalarin kendisi toplu istatistiktir,
   * tek bir gercek kayit tasimaz.
   * ===================================================================== */
  var ZAMAN_KOVA_SAYISI = 24;
  var AYIRAC = "\u001f";

  function tarihCoz(v, gunOnce){
    var parcalar = String(v).trim().split(/[ T]/);
    var g = parcalar[0];
    var y, ay, gun;

    var m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(g);
    if(m){ y = +m[1]; ay = +m[2]; gun = +m[3]; }
    else {
      m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})$/.exec(g);
      if(!m) return null;
      y = +m[3]; if(y < 100){ y += y < 50 ? 2000 : 1900; }
      if(gunOnce === false){ ay = +m[1]; gun = +m[2]; }
      else { gun = +m[1]; ay = +m[2]; }
    }
    if(!(y > 1900 && y < 2200) || ay < 1 || ay > 12 || gun < 1 || gun > 31) return null;

    var saat = null, dakika = 0, saniyeli = false;
    if(parcalar[1]){
      var t = /^(\d{1,2}):(\d{2})(:(\d{2}))?/.exec(parcalar[1]);
      if(t){ saat = +t[1]; dakika = +t[2]; saniyeli = t[4] !== undefined; }
    }
    var d = new Date(Date.UTC(y, ay - 1, gun, saat || 0, dakika));
    if(isNaN(d.getTime())) return null;
    return { ts: d.getTime(), dow: d.getUTCDay(), saat: saat,
             saniyeli: saniyeli, ayirac: String(v).indexOf("T") !== -1 ? "T" : " " };
  }

  function zamanProfiliCikar(kol){
    var noktalar = [], saatliVar = false, saniyeliVar = false, ayirac = " ";
    for(var i=0;i<kol.values.length;i++){
      var c = tarihCoz(kol.values[i], kol.gunOnce);
      if(!c) continue;
      noktalar.push(c);
      if(c.saat !== null){
        saatliVar = true;
        if(c.saniyeli) saniyeliVar = true;
        if(c.ayirac === "T") ayirac = "T";
      }
    }
    if(noktalar.length < 5) return;

    var min = Infinity, max = -Infinity;
    noktalar.forEach(function(n){ if(n.ts < min) min = n.ts; if(n.ts > max) max = n.ts; });
    if(!(max > min)){ max = min + 86400000; }

    var kovalar = sifirDizi(ZAMAN_KOVA_SAYISI);
    var dow = sifirDizi(7);
    var saatler = sifirDizi(24);
    var dakikalar = {};

    noktalar.forEach(function(n){
      var oran = (n.ts - min) / (max - min);
      var idx = Math.min(ZAMAN_KOVA_SAYISI - 1, Math.floor(oran * ZAMAN_KOVA_SAYISI));
      kovalar[idx]++;
      dow[n.dow]++;
      if(n.saat !== null){
        saatler[n.saat]++;
        var dk = new Date(n.ts).getUTCMinutes();
        dakikalar[dk] = (dakikalar[dk] || 0) + 1;
      }
    });

    // 1200 ornekten cikan 24 kovada kova basina ~50 deger duser; bu da %14
    // civari ornekleme gurultusu demektir. Yumusatmadan uretirsek olmayan bir
    // zirve uydurup analiste yanlis bir "satis patlamasi" gosteririz.
    kovalar = yumusat(kovalar);

    kol.zaman = {
      min: min, max: max,
      kovalar: kovalar,
      dow: dow,
      saatler: saatliVar ? saatler : null,
      dakikalar: saatliVar ? dakikalar : null,
      saniyeli: saniyeliVar,
      ayirac: ayirac,
      format: kol.tarihFormat || "YYYY-MM-DD",
      zirveKova: enBuyukIndex(kovalar),
      ornekSayisi: noktalar.length
    };
  }

  function yumusat(dizi){
    var out = [];
    for(var i=0;i<dizi.length;i++){
      var sol = dizi[i-1] === undefined ? dizi[i] : dizi[i-1];
      var sag = dizi[i+1] === undefined ? dizi[i] : dizi[i+1];
      out.push((sol + 2*dizi[i] + sag) / 4);
    }
    return out;
  }

  function kovaSec(rng, kovalar){
    if(!topla(kovalar)) return Math.floor(rng() * kovalar.length);
    return agirlikliIndex(rng, kovalar);
  }

  function zamanUret(rng, kol){
    var z = kol.zaman;
    if(!z) return tarihUretBasit(rng, kol);

    var ts = null;
    var enSikDow = Math.max.apply(null, z.dow);
    var kovaGenislik = (z.max - z.min) / ZAMAN_KOVA_SAYISI;
    // Kovadan cek, sonra haftanin gununu gozlemlenen dagilima gore kabul et
    for(var deneme=0; deneme<25; deneme++){
      var aday = z.min + kovaGenislik * (kovaSec(rng, z.kovalar) + rng());
      var gun = new Date(aday).getUTCDay();
      if(!enSikDow || rng() <= (z.dow[gun] / enSikDow) || deneme === 24){ ts = aday; break; }
    }
    if(ts === null){ ts = z.min + rng() * (z.max - z.min); }

    var d = new Date(ts);
    var metin = bicimlendirTarih(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), z.format);
    if(z.saatler){
      metin += (z.ayirac || " ") + TC.pad(kovaSec(rng, z.saatler),2) + ":" + TC.pad(dakikaSec(rng, z.dakikalar),2);
      if(z.saniyeli){ metin += ":" + TC.pad(Math.floor(rng()*60),2); }
    }
    return metin;
  }

  function bicimlendirTarih(y, ay, gun, fmt){
    var p = TC.pad;
    if(fmt === "DD.MM.YYYY") return p(gun,2) + "." + p(ay,2) + "." + y;
    if(fmt === "DD.MM.YY")   return p(gun,2) + "." + p(ay,2) + "." + String(y).slice(2);
    if(fmt === "YYYY/MM/DD") return y + "/" + p(ay,2) + "/" + p(gun,2);
    return y + "-" + p(ay,2) + "-" + p(gun,2);
  }

  // Pasaportta zaman dagiliminin seklini tek cumleyle anlat
  function zamanSekliAnlat(kol){
    var z = kol.zaman;
    if(!z) return null;
    var d1 = new Date(z.min), d2 = new Date(z.max);
    var aralik = bicimlendirTarih(d1.getUTCFullYear(), d1.getUTCMonth()+1, d1.getUTCDate(), z.format) +
      " -> " + bicimlendirTarih(d2.getUTCFullYear(), d2.getUTCMonth()+1, d2.getUTCDate(), z.format);

    var ort = topla(z.kovalar) / z.kovalar.length;
    var sirali = z.kovalar.slice().sort(function(a,b){ return a-b; });
    var medyan = sirali[Math.floor(sirali.length/2)] || 1;
    var sekil;
    // Hem ortalamanın hem medyanın belirgin üstünde olmalı ki "zirve" diyelim
    if(z.kovalar[z.zirveKova] > ort * 2.2 && z.kovalar[z.zirveKova] > medyan * 2.0){
      var nerede = z.zirveKova < ZAMAN_KOVA_SAYISI/3 ? mt("başında")
                 : (z.zirveKova > ZAMAN_KOVA_SAYISI*2/3 ? mt("sonunda") : mt("ortasında"));
      sekil = mt("yoğunluk dönemin {0} zirve yapıyor (düz dağılmıyor)", nerede);
    } else {
      sekil = mt("zamana yaklaşık düzgün dağılmış");
    }

    var gunAdlari = ["Pazar","Pazartesi","Salı","Çarşamba","Perşembe","Cuma","Cumartesi"];
    var enSikGun = enBuyukIndex(z.dow);
    var dowToplam = topla(z.dow);
    var gunNotu = (dowToplam && z.dow[enSikGun] / dowToplam > 0.30)
      ? mt(", ağırlıklı {0}", mt(gunAdlari[enSikGun])) : "";

    return aralik + " · " + sekil + gunNotu;
  }

  /* Sadece saat içeren kolon (ör. maç saati "19:00") tarih değildir ama
     kategori de değildir: "Kategori_2" üretmek verinin anlamını yok eder.
     Gözlemlenen saat ve dakika dağılımı korunarak üretilir — çoğu saat kolonu
     yuvarlak değerlerden oluşur (17:00, 19:30) ve bu korunmalıdır. */
  function saatProfiliCikar(kol){
    var saatler = sifirDizi(24);
    var dakikalar = {}, saniyeli = false, sayac = 0;
    for(var i=0;i<kol.values.length;i++){
      var m = /^([01]?\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/.exec(String(kol.values[i]).trim());
      if(!m) continue;
      saatler[+m[1]]++;
      dakikalar[+m[2]] = (dakikalar[+m[2]] || 0) + 1;
      if(m[4] !== undefined) saniyeli = true;
      sayac++;
    }
    if(sayac < 3) return;
    kol.saatProfil = { saatler: saatler, dakikalar: dakikalar, saniyeli: saniyeli, ornekSayisi: sayac };
  }

  function dakikaSec(rng, dakikalar){
    var anahtarlar = dakikalar ? Object.keys(dakikalar) : [];
    if(!anahtarlar.length) return Math.floor(rng() * 60);
    var agirliklar = anahtarlar.map(function(k){ return dakikalar[k]; });
    return Number(anahtarlar[agirlikliIndex(rng, agirliklar)]);
  }

  function saatUret(rng, kol){
    var s = kol.saatProfil;
    var metin = TC.pad(kovaSec(rng, s.saatler),2) + ":" + TC.pad(dakikaSec(rng, s.dakikalar),2);
    if(s.saniyeli){ metin += ":" + TC.pad(Math.floor(rng()*60),2); }
    return metin;
  }

  function tarihUretBasit(rng, kol){
    return TC.genDate(rng, { dateFormat: kol.tarihFormat || "YYYY-MM-DD" }, 2023, 2026);
  }

  /* =====================================================================
   * 6c. HIYERARSI (stadyum > blok > sira, lig > kulup > mac)
   *
   * Kolonlar bagimsiz uretilirse imkansiz kombinasyonlar cikar ve
   * "blok bazinda doluluk" gibi bir groupby anlamsizlasir. Fonksiyonel
   * bagimlilik aranir: cocuk kolonun her degeri tek bir ebeveyn degerine
   * karsilik geliyorsa, bu bir hiyerarsidir.
   * ===================================================================== */
  function hiyerarsiBul(kolonlar){
    var adaylar = kolonlar.filter(function(k){
      return k.kategorik && k.distinctSayisi > 1 && k.distinctSayisi <= 60 && k.hamOrnek.length > 20;
    });
    if(adaylar.length < 2) return;

    var baglar = [];
    adaylar.forEach(function(cocuk){
      adaylar.forEach(function(ebeveyn){
        if(cocuk === ebeveyn) return;
        if(cocuk.distinctSayisi <= ebeveyn.distinctSayisi) return;
        var esleme = Object.create(null), sayac = 0, ihlal = 0;
        var n = Math.min(cocuk.hamOrnek.length, ebeveyn.hamOrnek.length);
        for(var i=0;i<n;i++){
          var c = cocuk.hamOrnek[i], e = ebeveyn.hamOrnek[i];
          if(!c || !e) continue;
          sayac++;
          if(esleme[c] === undefined){ esleme[c] = e; }
          else if(esleme[c] !== e){ ihlal++; }
        }
        if(sayac >= 20 && ihlal / sayac < 0.02){
          baglar.push({ cocuk: cocuk, ebeveyn: ebeveyn });
        }
      });
    });
    if(!baglar.length) return;

    var grupNo = 0, grupla = {};
    baglar.forEach(function(b){
      var g1 = grupla[b.cocuk.index], g2 = grupla[b.ebeveyn.index];
      var g = g1 !== undefined ? g1 : (g2 !== undefined ? g2 : ++grupNo);
      grupla[b.cocuk.index] = g;
      grupla[b.ebeveyn.index] = g;
      if(g1 !== undefined && g2 !== undefined && g1 !== g2){
        Object.keys(grupla).forEach(function(k){ if(grupla[k] === g2){ grupla[k] = g1; } });
      }
    });

    kolonlar.forEach(function(k){
      if(grupla[k.index] !== undefined){ k.hiyerarsiGrubu = grupla[k.index]; }
    });
    // Ebeveyn de indeksle saklanır; ad çıktı anında çözülür (bkz. turetilmisRef)
    baglar.forEach(function(b){ b.cocuk.hiyerarsiEbeveynIndex = b.ebeveyn.index; });
  }

  /* =====================================================================
   * 6c'. KOLON ADI ÇÖZÜMÜ
   * Türetilmiş kolon, hiyerarşi ebeveyni ve tablolar arası ilişki yalnızca
   * kolon indeksini taşır. Ad, LLM'e giden metin üretilirken DIŞA AKTARILAN
   * adla (kol.disaAktarilanAd) çözülür; başlık gizleme sonradan açılıp
   * kapansa da hiçbir yerde eski/ham ad kalmaz.
   * ===================================================================== */
  function disaAd(kol){ return kol ? (kol.disaAktarilanAd || kol.name) : "kolon"; }

  // Ham başlıkta satır sonu olabilir (tırnaklı CSV başlığı); pasaportta tek
  // satıra indirilir ki "- ad: ..." yapısı bozulup sahte satır eklenemesin.
  function tekSatir(s){ return String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " "); }

  function kolonBul(kolonlar, index){
    if(!kolonlar || index === undefined || index === null) return null;
    var k = kolonlar[index];
    if(k && (k.index === undefined || k.index === index)) return k;
    for(var i=0;i<kolonlar.length;i++){
      if(kolonlar[i] && kolonlar[i].index === index) return kolonlar[i];
    }
    return null;
  }

  // adFn verilmezse dışa aktarılan ad kullanılır (yalnız yerel arayüz ham adı ister)
  function turetilmisAciklama(kol, kolonlar, adFn){
    var ref = kol && kol.turetilmisRef;
    if(!ref) return "";
    var ad = adFn || disaAd;
    return ad(kolonBul(kolonlar, ref.a)) + (ref.op === "*" ? " × " : " + ") + ad(kolonBul(kolonlar, ref.b));
  }

  function hiyerarsiEbeveynAdi(kol, kolonlar, adFn){
    if(!kol || kol.hiyerarsiEbeveynIndex === undefined || kol.hiyerarsiEbeveynIndex === null) return "";
    return (adFn || disaAd)(kolonBul(kolonlar, kol.hiyerarsiEbeveynIndex));
  }

  /* Hiyerarsik grup icin ortak havuz: gozlemlenen kombinasyonlarin yapisini
     korur. Gruptaki kolonlarin HEPSI gercek deger gonderiyorsa gercek
     kombinasyonlar, aksi halde ayni dallanma yapisiyla sahte kombinasyonlar. */
  // En az iki uyesi olan hiyerarsi gruplarini toplar.
  function hiyerarsiGruplari(kolonlar){
    var gruplar = {};
    kolonlar.forEach(function(k){
      if(k.hiyerarsiGrubu === undefined) return;
      (gruplar[k.hiyerarsiGrubu] = gruplar[k.hiyerarsiGrubu] || []).push(k);
    });
    Object.keys(gruplar).forEach(function(gid){
      if(gruplar[gid].length < 2){ delete gruplar[gid]; }
    });
    return gruplar;
  }

  /* Gruptaki kolonlarin satir satir birlikte gorulen degerleri: gozlemlenen
     kombinasyonlar ve kac kez goruldukleri. En sik 300 kombinasyon yeter. */
  function kombinasyonListesi(uyeler){
    var kombinasyonlar = Object.create(null), n = 0;
    uyeler.forEach(function(k){ n = Math.max(n, k.hamOrnek.length); });
    for(var i=0;i<n;i++){
      var parcalar = uyeler.map(function(k){ return k.hamOrnek[i] || ""; });
      if(parcalar.some(function(v){ return v === ""; })) continue;
      var key = parcalar.join(AYIRAC);
      kombinasyonlar[key] = (kombinasyonlar[key] || 0) + 1;
    }
    var liste = Object.keys(kombinasyonlar).map(function(key){
      return { parcalar: key.split(AYIRAC), adet: kombinasyonlar[key] };
    });
    liste.sort(function(a,b){ return b.adet - a.adet; });
    return liste.slice(0, 300);
  }

  /* Bir kolonun gercek degerleri icin sahte karsilik haritasi.
     "ui" kolonun grup icindeki sirasi, yani kombinasyondaki parca indeksidir. */
  function hiyerarsiEslemesi(kol, ui, liste, rng){
    // Anahtarlar gerçek hücre değerleridir: "constructor" değeri Object
    // fonksiyonunu döndürüp sahte hücreye kaynak kodu yazdırıyordu.
    var esleme = Object.create(null), kullanilan = Object.create(null), sayac = 0;
    liste.forEach(function(kmb){
      var gercek = kmb.parcalar[ui];
      if(esleme[gercek] !== undefined) return;
      var yeni;
      if(kol.karar.mod === "gercek"){
        yeni = gercek;
      } else if(kol.joinGrubu){
        // Hem hiyerarşinin parçası hem de tablolar arası anahtar:
        // takma ad haritasından geç ki diğer tablolarla tutarlı kalsın.
        yeni = takmaAdAl(kol.joinGrubu, gercek, kol);
      } else {
        // İki farklı gerçek değer aynı sahte değere düşerse hiyerarşi
        // bozulur (bir blok iki stadyuma bağlı görünür).
        for(var d=0; d<24; d++){
          yeni = hiyerarsiEtiket(kol, rng, sayac++);
          if(!kullanilan[yeni]) break;
        }
        // Üretecin ayrık etiket havuzu tükendiyse (19 blok var ama üreteç
        // 12 ad üretebiliyorsa) benzersizliği elle garantiye al.
        if(kullanilan[yeni] && /^\d+$/.test(yeni)){
          // Sayı kolonu: "5 2" gibi metin yerine sıradaki boş sayı
          var sayi = Number(yeni);
          while(kullanilan[String(sayi)]){ sayi++; }
          yeni = String(sayi);
        } else if(kullanilan[yeni]){
          var kok = yeni, ek = 2;
          while(kullanilan[kok + " " + ek]){ ek++; }
          yeni = kok + " " + ek;
        }
      }
      kullanilan[yeni] = true;
      esleme[gercek] = yeni;
    });
    return esleme;
  }

  function hiyerarsiHavuzlari(kolonlar, rng){
    var gruplar = hiyerarsiGruplari(kolonlar);
    var sonuc = {};

    Object.keys(gruplar).forEach(function(gid){
      var uyeler = gruplar[gid];
      var liste = kombinasyonListesi(uyeler);
      if(!liste.length) return;

      // Gercek gonderilmeyen kolonlarin degerlerini, yapiyi bozmadan sahteye cevir
      var eslemeler = uyeler.map(function(k, ui){
        return hiyerarsiEslemesi(k, ui, liste, rng);
      });
      liste = liste.map(function(kmb){
        return { parcalar: kmb.parcalar.map(function(v, ui){ return eslemeler[ui][v]; }), adet: kmb.adet };
      });

      sonuc[gid] = { uyeIndexleri: uyeler.map(function(k){ return k.index; }), liste: liste };
    });
    return sonuc;
  }

  function hiyerarsiEtiket(kol, rng, sira){
    var t = kol.tespit.type;
    if(t.gen){
      var aday = t.gen(rng, { index: sira, uzunluk: kol.tipikUzunluk });
      if(aday) return aday;
    }
    // Az çeşitli sayı kolonu (adet 1–12) hiyerarşiye girebilir; etiket
    // ("adet_2") yerine sayı üretilir ki örnekte toplanabilsin.
    if(t.numeric || kol.sayi){ return sayiUret(rng, kol); }
    // Dışa aktarılan ad: gizlenen başlık sahte değerin içinden sızmasın
    return (kol.disaAktarilanAd || kol.name || "deger") + "_" + (sira + 1);
  }

  /* =====================================================================
   * 6d. DOSYALAR ARASI TUTARLILIK (join korunmasi)
   *
   * Analistin elinde tek dosya olmaz: biletler + etkinlikler + musteriler.
   * Ayni musteri_id iki dosyada farkli sahte degere donuserse join coker ve
   * LLM'in yazdigi kod gercek veride patlar. Takma adlar bu yuzden oturum
   * boyunca paylasilan bir haritada tutulur.
   *
   * Harita yalnizca bellekte durur - localStorage'a yazilmaz; 100 bin satirlik
   * bir dosyada kota zaten patlardi.
   * ===================================================================== */
  var takmaAdlar = {};

  function takmaAdSifirla(){ takmaAdlar = {}; joinHavuzlari = {}; joinUretilen = {}; }
  function takmaAdSayisi(){ return Object.keys(takmaAdlar).length; }

  /* Takma ad tohumu gizli bir oturum anahtariyla (HMAC-SHA-256) turetilir.
     Eskiden tohum yalnizca grup + gercek degerin FNV ozetiydi: kodu bilen
     herkes (orn. istemi alan LLM saglayicisi) aday degerleri deneyip gercek
     musteri_no'yu bir saniyede geri buluyordu. Anahtar yalnizca bellekte durur;
     sayfa acik kaldikca tablolar arasi tutarlilik korunur. */
  var takmaAdSirri = null;
  function anahtarliTohum(str){
    var FM = typeof window !== "undefined" ? window.FileMaskEngine : null;
    if(!FM || typeof FM.hmacSha256Hex !== "function"){
      throw new Error("Güvenli takma ad için file-mask-engine.js yüklenmeli.");
    }
    if(!takmaAdSirri){ takmaAdSirri = FM.createSecretKey(); }
    return parseInt(FM.hmacSha256Hex(takmaAdSirri, str).slice(0, 8), 16) >>> 0;
  }

  function takmaAdAl(grup, gercek, kol){
    var anahtar = grup + AYIRAC + gercek;
    if(takmaAdlar[anahtar] !== undefined) return takmaAdlar[anahtar];
    // Tohum degerin kendisinden turetilir: hangi dosyanin once islendigi
    // fark etmesin, ayni gercek deger her yerde ayni sahte degere dussun.
    var tohum = anahtarliTohum(anahtar);
    var rng = TC.makeRng(tohum);
    var t = kol.tespit.type;
    var uretilen;
    if(t.gen){ uretilen = t.gen(rng, { index: anahtarliTohum(String(gercek)) % 100000, uzunluk: kol.tipikUzunluk }); }
    else if(kol.sayi){ uretilen = sayiUret(rng, kol); }
    else { uretilen = "ID_" + (tohum % 1000000); }
    takmaAdlar[anahtar] = uretilen;
    return uretilen;
  }

  /* Join anahtari icin havuz GRUP BASINA bir kez kurulur ve tum tablolar
     ayni havuzdan beslenir. Yoksa biletler.bilet_no ile turnike.bilet_no
     farkli sahte kumelerden cikar ve join ornek uzerinde calismaz. */
  var joinHavuzlari = {};
  var joinUretilen = {};   // grup -> daha once URETILMIS sahte degerler

  function joinHavuzu(kol){
    var grup = kol.joinGrubu;

    // Bu anahtar daha once bir tabloda uretildiyse, cocuk tablo o degerlerden
    // cekmeli. Yoksa iki tablo ayni havuzdan bagimsiz orneklenir ve join
    // ornek uzerinde yalnizca kismen tutar.
    var oncekiler = joinUretilen[grup];
    if(oncekiler && oncekiler.length >= 5){
      return oncekiler.map(function(v){ return { deger: v, adet: 1 }; });
    }

    if(joinHavuzlari[grup]) return joinHavuzlari[grup];

    var kaynak;
    if(kol.distinctTasti){
      // Cok cesitli anahtar: orneklenen ham degerlerden benzersizleri al
      var gorulen = Object.create(null);
      kaynak = [];
      for(var i=0;i<kol.values.length && kaynak.length < 500;i++){
        var v = kol.values[i];
        if(!gorulen[v]){ gorulen[v] = true; kaynak.push(v); }
      }
    } else {
      kaynak = Object.keys(kol.distinct).slice(0, 500);
    }
    if(!kaynak.length) return null;

    var havuz = kaynak.map(function(v){
      return { deger: takmaAdAl(grup, v, kol), adet: (kol.distinct[v] || 1) };
    });
    joinHavuzlari[grup] = havuz;
    return havuz;
  }

  /* Tablolar arasi iliski tespiti: ayni adi tasiyan ya da deger kumeleri
     buyuk olcude ortusen kolonlar birbirine baglidir. */
  function iliskileriBul(tablolar){
    var iliskiler = [];
    tablolar.forEach(function(t){
      t.analiz.columns.forEach(function(k){ k.joinGrubu = null; });
    });
    for(var a=0; a<tablolar.length; a++){
      for(var b=a+1; b<tablolar.length; b++){
        tablolar[a].analiz.columns.forEach(function(ka){
          tablolar[b].analiz.columns.forEach(function(kb){
            var adA = baslikNormalize(ka.name).toLocaleLowerCase("tr-TR");
            var adB = baslikNormalize(kb.name).toLocaleLowerCase("tr-TR");
            var adEsit = adA === adB;
            if(!adEsit && ka.tespit.typeId !== kb.tespit.typeId) return;
            if(ka.distinctSayisi <= 3 && kb.distinctSayisi <= 3) return;
            // Tarihler ve ölçüm kolonları anahtar değildir; iki tarih kolonunun
            // örtüşmesi bir ilişki değil, sadece aynı döneme ait olmalarıdır.
            if(anahtarOlamaz(ka) || anahtarOlamaz(kb)) return;
            var ortusme = degerOrtusmesi(ka, kb);
            if(!adEsit && ortusme < 0.6) return;
            var grup = "join:" + (adEsit ? adA : ka.tespit.typeId);
            ka.joinGrubu = grup;
            kb.joinGrubu = grup;
            // sol/sag yalnızca yerel arayüz içindir. Prompt kolonu indeksle
            // çözer: ad burada bir kez yakalanırsa sonradan gizlenen başlık
            // ilişkiler bölümünde ham adıyla kalıyordu.
            iliskiler.push({
              sol: tablolar[a].ad + "." + ka.name,
              sag: tablolar[b].ad + "." + kb.name,
              grup: grup,
              solTabloIndex: a,
              solKolonIndex: ka.index,
              sagTabloIndex: b,
              sagKolonIndex: kb.index,
              gerekce: adEsit ? "aynı kolon adı" : "değerlerin %" + Math.round(ortusme*100) + " kadarı örtüşüyor"
            });
          });
        });
      }
    }
    return iliskiler;
  }

  function anahtarOlamaz(kol){
    var t = kol.tespit.type;
    return !!kol.zaman || !!t.numeric || t.id === "tarih" || t.id === "dogum_tarihi" ||
           t.id === "sayi" || t.id === "tutar" || t.id === "maas";
  }

  function degerOrtusmesi(ka, kb){
    if(ka.distinctTasti || kb.distinctTasti) return 0;
    var aAnahtar = Object.keys(ka.distinct), bAnahtar = Object.keys(kb.distinct);
    if(!aAnahtar.length || !bAnahtar.length) return 0;
    var kucuk = aAnahtar.length <= bAnahtar.length ? ka : kb;
    var buyuk = kucuk === ka ? kb : ka;
    var anahtarlar = Object.keys(kucuk.distinct);
    var hit = 0;
    for(var i=0;i<anahtarlar.length;i++){
      if(buyuk.distinct[anahtarlar[i]] !== undefined) hit++;
    }
    return hit / anahtarlar.length;
  }

  /* =====================================================================
   * 7. VERİ PASAPORTU
   * Gerçek uç değerleri sızdırmamak için min/max yuvarlanır.
   * ===================================================================== */
  function yuvarlaNazik(n){
    if(!isFinite(n)) return n;
    if(n === 0) return 0;
    var isaret = n < 0 ? -1 : 1;
    var a = Math.abs(n);
    var buyukluk = Math.pow(10, Math.floor(Math.log(a) / Math.LN10) - 1);
    if(buyukluk <= 0) return n;
    return isaret * Math.round(a / buyukluk) * buyukluk;
  }

  function formatSayi(n){
    if(!isFinite(n)) return "-";
    if(Math.abs(n) >= 1000) return yerelSayi(Math.round(n));
    return String(Math.round(n * 100) / 100);
  }

  function buildPassport(analiz, dosyaAdi){
    var satirlar = [];
    satirlar.push(pasaportBasligi(dosyaAdi));
    satirlar.push(mt("{0} satır, {1} kolon", yerelSayi(analiz.toplamSatir), analiz.columns.length));
    if(analiz.orneklemeAdimi > 1){
      satirlar.push(mt("(istatistikler {0} satırlık örneklemden)", yerelSayi(analiz.orneklenenSatir)));
    }
    satirlar.push("");

    analiz.columns.forEach(function(kol){
      var ad = tekSatir(disaAd(kol));
      var parca = [];
      parca.push(mt(kol.tespit.type.label));

      if(olcumKolonuMu(kol)){
        parca.push(mt("aralık {0} – {1}", formatSayi(yuvarlaNazik(kol.sayi.min)), formatSayi(yuvarlaNazik(kol.sayi.max))));
        parca.push(mt("ort. {0}", formatSayi(yuvarlaNazik(kol.sayi.ortalama))));
        if(kol.sayi.carpik) parca.push(mt("sağa çarpık dağılım"));
      } else if(kol.sayi){
        parca.push(mt("{0} haneli", kol.tipikUzunluk));
        parca.push(kol.distinctTasti ? mt("çok sayıda benzersiz değer") : mt("{0} benzersiz değer", yerelSayi(kol.distinctSayisi)));
      } else if(kol.saatProfil){
        var enSikSaat = enBuyukIndex(kol.saatProfil.saatler);
        parca.push(mt("yoğunlukla {0} civarı", TC.pad(enSikSaat,2) + ":00"));
      } else if(kol.zaman){
        parca.push(mt("format {0}", kol.zaman.format));
        var sekil = zamanSekliAnlat(kol);
        if(sekil) parca.push(sekil);
        if(kol.tarihBelirsiz) parca.push(mt("!! gün/ay sırası belirsiz"));
      } else if(kol.tespit.type.id === "tarih" || kol.tarihOran > 0.8){
        parca.push(mt("format {0}", (kol.tarihFormat || mt("bilinmiyor"))));
        if(kol.tarihBelirsiz) parca.push(mt("!! gün/ay sırası belirsiz"));
      } else {
        if(kol.distinctTasti){ parca.push(mt("{0}+ benzersiz değer", MAX_DISTINCT_TAKIP)); }
        else { parca.push(mt("{0} benzersiz değer", yerelSayi(kol.distinctSayisi))); }
      }

      // Pandas varsayılanı EN biçimdir; TR kolonda kod decimal=',' / thousands='.' kullanmalı
      if(kol.sayi && kol.sayiBicimi === "tr"){ parca.push(mt("TR sayı biçimi (binlik '.', ondalık ',')")); }
      var turetilmis = turetilmisAciklama(kol, analiz.columns);
      if(turetilmis){ parca.push(mt("= {0} (türetilmiş kolon)", tekSatir(turetilmis))); }
      var ebeveyn = hiyerarsiEbeveynAdi(kol, analiz.columns);
      if(ebeveyn){ parca.push(mt("her değeri tek bir {0} değerine bağlı", tekSatir(ebeveyn))); }
      if(kol.joinGrubu){ parca.push(mt("**tablolar arası ortak anahtar**")); }
      if(kol.bosOran > 0.005){ parca.push(mt("boş %{0}", Math.round(kol.bosOran * 100))); }
      if(kol.karar && kol.karar.mod === "gercek"){ parca.push(mt("GERÇEK değerler geçer")); }

      satirlar.push("- " + ad + ": " + parca.join(" · "));
    });

    return satirlar.join("\n");
  }

  // Pasaportun ilk satırı; prompt'ta tablo takma adıyla bu satır değişir.
  function pasaportBasligi(ad){ return mt("VERİ PASAPORTU — {0}", ad); }

  /* =====================================================================
   * 8. PROMPT ÜRETİCİ
   * ===================================================================== */
  var GOREVLER = {
    gorsellestirme: "Bu veriden anlamlı görselleştirmeler üret. Hangi grafik tiplerinin uygun olduğunu gerekçesiyle söyle ve çalışır Python (pandas + matplotlib) kodu yaz.",
    analiz: "Bu veriyi keşifsel olarak analiz et: hangi sorular sorulmalı, hangi kırılımlara bakılmalı, hangi metrikler hesaplanmalı? Çalışır Python kodu ver.",
    temizlik: "Bu veri setindeki olası kalite sorunlarını (eksik değer, aykırı değer, tip uyumsuzluğu, tekrarlı kayıt) tespit eden ve temizleyen Python kodu yaz.",
    pivot: "Bu veriden yönetim raporu için özet/pivot tablolar üret. Hangi kırılımların anlamlı olduğunu açıkla ve Python kodu ver.",
    sql: "Bu tablo yapısı için analiz sorguları yaz (SQL). Şema tanımını da ver.",

    /* --- Biletleme / etkinlik analitiği --- */
    doluluk: "Etkinlik ve tribün/blok bazında doluluk oranını (satılan / kapasite) hesaplayan ve görselleştiren kod yaz. Hangi kırılımların anlamlı olduğunu açıkla.",
    satis_egrisi: "Satışa açılıştan etkinlik gününe kadar günlük/kümülatif satış eğrisini çıkar. Satışın hızlandığı ve yavaşladığı dönemleri işaretle; kategori bazında karşılaştır.",
    noshow: "Bilet satın alıp etkinliğe gelmeyen (no-show) oranını hesapla: satılan biletler ile turnike giriş kayıtlarını karşılaştır. No-show'un kategori, kanal ve satın alma zamanına göre değişimini incele.",
    kanal: "Satış kanalı (web / mobil / gişe / bayi) kırılımında hacim, ortalama sepet ve kategori dağılımını karşılaştıran analiz ve grafikler üret.",
    rfm: "Müşteri bazında RFM (recency, frequency, monetary) segmentasyonu yap ve segmentleri görselleştir. Tekrar satın alma davranışını incele.",
    kombine: "Kombine (sezonluk) sahiplerinin davranışını analiz et: yenileme oranı, maç başına katılım, tekil bilet alanlarla karşılaştırma.",
    fiyatlama: "Fiyat kategorisi bazında talep esnekliğini incele; hangi kategorilerin erken dolduğunu, hangilerinin son güne kaldığını çıkar. Dinamik fiyatlama için öneri üret.",
    karaborsa: "Anormal satın alma örüntülerini tespit et: aynı kimliğe/karta bağlı yüksek adetli alımlar, kısa sürede çok sayıda işlem, aynı koltuk bloğunun toplu alınması. Şüpheli işlemleri işaretleyen kod yaz."
  };

  // OWASP CSV / Excel formül enjeksiyonu koruması: kanonik kural csv-io.js'te.
  // Yalnız rakam ve ayraçtan oluşan işaretli değerler sayıdır ("-5,25",
  // "-1.234,56"). Dışa açık adlar mevcut çağıranlar için korunur.
  function guvenliHucre(v){
    return csvIO().guvenliHucre(v);
  }

  function isFormulaCell(val){
    return csvIO().isFormulaCell(val);
  }

  // BOM'suz ve "\n" satır sonlu: aynı metin LLM prompt'una da girer (orada
  // görünmez karakter istenmez); indirmede BOM'u table-ui ekler.
  function toCSV(headers, rows, delim, options){
    return csvIO().stringify(headers, rows, {
      delimiter: delim || ",",
      bom: false,
      lineEnding: "\n",
      safeFormula: !!(options && options.safeFormula)
    });
  }

  /* P-02: Sentetik Veri Kalite ve Gizlilik Raporu (SDMetrics & NIST SP 800-226 referanslı) */
  function auditSyntheticQuality(analiz, syntheticData){
    if(!analiz || !syntheticData || !Array.isArray(syntheticData.rows)){
      return null;
    }
    var totalOrig = analiz.toplamSatir || 0;
    var sampledOrig = analiz.orneklenenSatir || 0;
    var synthCount = syntheticData.rows.length;
    var cols = analiz.columns || [];

    var nullDeltas = [];
    cols.forEach(function(col, ci){
      var origNullRate = col.bosOran || 0;
      var synthNulls = 0;
      syntheticData.rows.forEach(function(r){
        if(r[ci] === "" || r[ci] == null) synthNulls++;
      });
      var synthNullRate = synthCount ? (synthNulls / synthCount) : 0;
      nullDeltas.push({
        column: col.disaAktarilanAd || col.name,
        origRate: Math.round(origNullRate * 100),
        synthRate: Math.round(synthNullRate * 100),
        deltaPct: Math.round(Math.abs(origNullRate - synthNullRate) * 100)
      });
    });

    var categorySimilarities = [];
    var numericDeltas = [];
    cols.forEach(function(col, ci){
      if(col.sayi && (col.tespit.type.numeric || col.tespit.type.id === "sayi")){
        var vals = [];
        syntheticData.rows.forEach(function(r){
          var n = Number(r[ci]);
          if(!isNaN(n)) vals.push(n);
        });
        if(vals.length){
          var sMin = Math.min.apply(null, vals);
          var sMax = Math.max.apply(null, vals);
          var sAvg = vals.reduce(function(a,b){ return a+b; }, 0) / vals.length;
          numericDeltas.push({
            column: col.disaAktarilanAd || col.name,
            origMin: col.sayi.min,
            origMax: col.sayi.max,
            origAvg: Math.round(col.sayi.ortalama * 100) / 100,
            synthMin: sMin,
            synthMax: sMax,
            synthAvg: Math.round(sAvg * 100) / 100
          });
        }
      } else if(col.kategorik && col.enSikDegerler && col.enSikDegerler.length){
        var synthFreq = Object.create(null);   // "gercek" modda anahtar gerçek değerdir
        syntheticData.rows.forEach(function(r){
          var v = String(r[ci]);
          synthFreq[v] = (synthFreq[v] || 0) + 1;
        });
        categorySimilarities.push({
          column: col.disaAktarilanAd || col.name,
          distinctOrig: col.distinctSayisi,
          distinctSynth: Object.keys(synthFreq).length
        });
      }
    });

    var exactMatches = 0;
    var nearMatches = 0;
    var numCols = cols.length;

    // Kopya denetimi yalnızca satır satır HİZALI örnek (hamOrnek, en çok
    // HIZALI_ORNEK_SAYISI satır) üzerinde yapılabilir. Eskiden hamOrnek
    // bitince kolonların bağımsız "values" dizilerine düşülüyordu: aynı
    // indeks farklı kolonlarda farklı satırlardan geldiği için var olmayan
    // satırlarla karşılaştırılıyordu. Kapsam da sonuçta açıkça söylenir.
    var hizaliSatir = numCols ? Infinity : 0;
    cols.forEach(function(col){
      var n = Array.isArray(col.hamOrnek) ? col.hamOrnek.length : 0;
      if(n < hizaliSatir) hizaliSatir = n;
    });
    if(!isFinite(hizaliSatir)) hizaliSatir = 0;

    syntheticData.rows.forEach(function(synthRow){
      var isExact = false;
      var maxOverlap = 0;
      for(var r=0; r<hizaliSatir; r++){
        var matchCount = 0;
        for(var c=0; c<numCols; c++){
          if(String(cols[c].hamOrnek[r]) === String(synthRow[c])){
            matchCount++;
          }
        }
        var overlap = numCols ? (matchCount / numCols) : 0;
        if(overlap > maxOverlap) maxOverlap = overlap;
        if(overlap === 1){ isExact = true; break; }
      }
      if(isExact) exactMatches++;
      else if(maxOverlap >= 0.8) nearMatches++;
    });

    // Küçük dosyada hizalı örnek dosyanın kendisidir: kapsam "tamamı" diye söylenir
    var ozet = kopyaDenetimiOzeti(exactMatches, nearMatches, hizaliSatir, totalOrig);

    return {
      sampleSizes: {
        originalTotal: totalOrig,
        originalSampled: sampledOrig,
        syntheticCount: synthCount,
        copyCheckedRows: hizaliSatir
      },
      nullDeltas: nullDeltas,
      numericDeltas: numericDeltas,
      categorySimilarities: categorySimilarities,
      privacy: {
        exactMatches: exactMatches,
        nearMatches: nearMatches,
        checkedRows: hizaliSatir,
        tamami: ozet.tamami,
        risk: ozet.risk,
        score: ozet.score
      },
      disclaimer: "NIST SP 800-226: Bu metrikler sentetik örneğin biçimsel ve istatistiksel tutarlılığını ölçer. Mutlak diferansiyel gizlilik (differential privacy) veya anonimlik garantisi değildir."
    };
  }

  /* Kopya denetimi sonucunun cümlesi ve risk düzeyi. Kapsam her cümlede
     söylenir: "kopya yok" yalnız örnek için mi, dosyanın tamamı için mi —
     karar anında görülmeli. risk: "yuksek" | "orta" | "dusuk" | "yok" */
  function kopyaDenetimiOzeti(ozdes, yakin, kontrol, toplam){
    var tamami = kontrol > 0 && kontrol >= toplam;
    var n = yerelSayi(kontrol), N = yerelSayi(toplam);
    if(!kontrol){
      return { tamami:false, risk:"yok", score: mt("Kopya denetimi yapılamadı (hizalı gerçek satır örneği yok)") };
    }
    if(ozdes > 0){
      return { tamami:tamami, risk:"yuksek", score: tamami
        ? mt("Yüksek eşleşme riski: dosyanın tamamında ({0} gerçek satır) özdeş satır bulundu", n)
        : mt("Yüksek eşleşme riski: örneklenen {0} / {1} gerçek satırda özdeş satır bulundu", n, N) };
    }
    if(yakin > 0){
      return { tamami:tamami, risk:"orta", score: tamami
        ? mt("Orta risk: dosyanın tamamında ({0} gerçek satır) yüksek benzerlikli satır var", n)
        : mt("Orta risk: örneklenen {0} / {1} gerçek satırda yüksek benzerlikli satır var", n, N) };
    }
    return { tamami:tamami, risk:"dusuk", score: tamami
      ? mt("Düşük sızıntı riski: dosyanın tamamı ({0} gerçek satır) kontrol edildi, kopya yok", n)
      : mt("Yalnız örnek kontrol edildi: {0} / {1} gerçek satırda kopya yok; dosyanın kalanı taranmadı", n, N) };
  }

  /* TAM DOSYA KOPYA DENETİMİ
     Örnek denetimi yalnız hizalı en çok HIZALI_ORNEK_SAYISI satırı görür. Bu
     işlev dosyanın TÜM veri satırlarını tarar: her sentetik satır için özdeş
     gerçek satır ve kolonlarının en az %80'i aynı olan gerçek satır aranır.
     Her kolonda sentetik değerlerin dizini tutulur; gerçek hücre yalnız onu
     taşıyan sentetik satırları sayar (satır × kolon, sentetik satır sayısı
     kadar değil). Karşılaştırma örnek denetimindekiyle aynı: kırpılmış metin.
     @returns {{checkedRows:number, exactMatches:number, nearMatches:number}} */
  function tamKopyaDenetimi(rows, headerRowIdx, kolonSayisi, sentetikSatirlar){
    var S = sentetikSatirlar.length, C = kolonSayisi;
    var metin = function(v){ return (v === undefined || v === null) ? "" : String(v).trim(); };
    var dizin = [];
    for(var c=0;c<C;c++){
      var m = new Map();
      for(var s=0;s<S;s++){
        var sv = metin(sentetikSatirlar[s][c]);
        var liste = m.get(sv);
        if(!liste){ liste = []; m.set(sv, liste); }
        liste.push(s);
      }
      dizin.push(m);
    }
    var say = new Int32Array(S), dokunulan = new Int32Array(S);
    var ozdes = new Uint8Array(S), yakin = new Uint8Array(S);
    var esik = Math.ceil(C * 0.8), kontrol = 0;
    for(var i=headerRowIdx+1; i<rows.length; i++){
      var row = rows[i] || [];
      kontrol++;
      var dn = 0;
      for(var k=0;k<C;k++){
        var eslesen = dizin[k].get(metin(row[k]));
        if(!eslesen) continue;
        for(var e=0;e<eslesen.length;e++){
          var si = eslesen[e];
          if(say[si] === 0) dokunulan[dn++] = si;
          say[si]++;
        }
      }
      for(var d=0; d<dn; d++){
        var t = dokunulan[d];
        if(say[t] === C) ozdes[t] = 1;
        else if(C && say[t] >= esik) yakin[t] = 1;
        say[t] = 0;
      }
    }
    var exact = 0, near = 0;
    for(var x=0;x<S;x++){ if(ozdes[x]) exact++; else if(yakin[x]) near++; }
    return { checkedRows: kontrol, exactMatches: exact, nearMatches: near };
  }

  function noShowColumn(tables, tableIndex, columnIndex){
    if(tableIndex === "" || tableIndex === null || tableIndex === undefined ||
       columnIndex === "" || columnIndex === null || columnIndex === undefined) return null;
    var ti = Number(tableIndex), ci = Number(columnIndex);
    if(!Number.isInteger(ti) || !Number.isInteger(ci) || !tables[ti] || !tables[ti].analiz) return null;
    return tables[ti].analiz.columns[ci] || null;
  }

  function noShowLabel(column){ return column && (column.disaAktarilanAd || column.name); }

  /* Tablolar prompt'ta ve eşleştirme özetinde bu adla anılır — gerçek dosya
     adı LLM'e hiç gitmez. */
  function tabloEtiketi(index){ return "TABLO_" + (Number(index) + 1); }

  /* Kullanıcının seçtiği kolonlar ve serbest metin girdisi tek yerde çözülür;
     hem eksik denetimi hem de prompt özeti aynı nesneden beslenir. */
  function noShowSecimi(tables, config){
    return {
      salesKey:    noShowColumn(tables, config.salesTable, config.salesKey),
      scanKey:     noShowColumn(tables, config.scanTable, config.scanKey),
      salesEvent:  noShowColumn(tables, config.salesTable, config.salesEvent),
      scanEvent:   noShowColumn(tables, config.scanTable, config.scanEvent),
      salesStatus: config.denominatorMode === "status"
        ? noShowColumn(tables, config.salesTable, config.salesStatus) : null,
      validStatuses: String(config.validStatuses || "")
        .split(/[;,\n]/).map(function(v){ return v.trim(); }).filter(Boolean)
    };
  }

  /* Eşleştirmeyi hazır saymak için kullanıcıdan hâlâ ne isteniyor?
     Boş liste = hazır. Sıra önemlidir: arayüz eksikleri bu sırayla gösterir. */
  function noShowEksikleri(config, secim){
    var gaps = [];
    if(!secim.salesKey) gaps.push("Satış tablosundaki tekil bilet anahtarını seçin.");
    if(!secim.scanKey) gaps.push("Turnike tablosundaki bilet anahtarını seçin.");

    if(!config.oneEvent && (!secim.salesEvent || !secim.scanEvent)){
      gaps.push("Etkinlik eşleştirmesi için iki tabloda da etkinlik anahtarı seçin veya girdilerin tek etkinliğe filtrelendiğini onaylayın.");
    }

    if(config.denominatorMode === "status"){
      if(!secim.salesStatus) gaps.push("Geçerli satışları belirleyen durum kolonunu seçin.");
      if(!secim.validStatuses.length) gaps.push("Geçerli bilet durumlarının değerlerini yazın.");
    } else if(config.denominatorMode !== "filtered"){
      gaps.push("Payda kuralını seçin: önceden filtrelenmiş satış girdisi veya durum kolonu.");
    } else if(!config.filteredValidSales){
      gaps.push("Satış girdisinden iptal/iade/geçersiz biletlerin çıkarıldığını onaylayın.");
    }

    if(!config.successfulScans){ gaps.push("Turnike girdisinin yalnız başarılı girişleri içerdiğini onaylayın."); }
    return gaps;
  }

  function assessNoShowReadiness(tables, config){
    tables = Array.isArray(tables) ? tables : [];
    config = config || {};

    var secim = noShowSecimi(tables, config);
    var gaps = noShowEksikleri(config, secim);

    return {
      ready:gaps.length === 0,
      gaps:gaps,
      mapping:{
        salesTable:config.salesTable,
        salesTableLabel:tabloEtiketi(config.salesTable),
        salesKey:noShowLabel(secim.salesKey),
        salesEvent:noShowLabel(secim.salesEvent),
        scanTable:config.scanTable,
        scanTableLabel:tabloEtiketi(config.scanTable),
        scanKey:noShowLabel(secim.scanKey),
        scanEvent:noShowLabel(secim.scanEvent),
        oneEvent:!!config.oneEvent,
        denominatorMode:config.denominatorMode,
        salesStatus:noShowLabel(secim.salesStatus),
        validStatuses:secim.validStatuses,
        filteredValidSales:!!config.filteredValidSales,
        successfulScans:!!config.successfulScans
      }
    };
  }

  /* ---------------- SQL çıktısı (Oracle lehçesi) ----------------
     Analistlerin çoğu CSV değil şema ile çalışır. Oracle seçilmesinin
     sebebi Passo/Aktif Bank tarafının Oracle SQL/PLSQL ağırlıklı olması. */
  var TR_ASCII = { "ç":"c","Ç":"C","ğ":"g","Ğ":"G","ı":"i","İ":"I","ö":"o","Ö":"O",
                   "ş":"s","Ş":"S","ü":"u","Ü":"U" };

  // Oracle ayrılmış sözcükleri tırnaksız kolon adı olamaz: "date" başlıklı
  // bir kolon "DATE DATE" üretip CREATE TABLE'ı kırıyordu.
  var SQL_AYRILMIS = Object.create(null);
  ("ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COMMENT " +
   "COMPRESS CONNECT CREATE CURRENT DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE " +
   "EXCLUSIVE EXISTS FILE FLOAT FOR FROM GRANT GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT " +
   "INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG MAXEXTENTS MINUS " +
   "MLSLABEL MODE MODIFY NOAUDIT NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION " +
   "OR ORDER PCTFREE PRIOR PUBLIC RAW RENAME RESOURCE REVOKE ROW ROWID ROWNUM ROWS SELECT " +
   "SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL SYNONYM SYSDATE TABLE THEN TO TRIGGER " +
   "UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW WHENEVER WHERE WITH")
    .split(" ").forEach(function(w){ SQL_AYRILMIS[w] = true; });

  function sqlAd(ham, maxLen){
    var s = String(ham).replace(/[çÇğĞıİöÖşŞüÜ]/g, function(c){ return TR_ASCII[c] || c; });
    s = s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
    if(!s) s = "KOLON";
    if(/^\d/.test(s)) s = "T_" + s;
    s = s.slice(0, maxLen || 30);
    if(SQL_AYRILMIS[s]) s = s.slice(0, (maxLen || 30) - 2) + "_K";
    return s;
  }

  // "--" yorumu satır sonunda biter: ham başlıktaki satır sonu yorumdan
  // çıkıp SQL enjekte ediyordu. Blok yorum işaretleri de etkisizleştirilir.
  function sqlYorum(s){
    return String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
      .replace(/\*\//g, "* /").replace(/\/\*/g, "/ *");
  }

  function sqlTarihMaskesi(kol){
    var f = (kol.zaman && kol.zaman.format) || kol.tarihFormat || "YYYY-MM-DD";
    var mask = f === "DD.MM.YY" ? "DD.MM.RR" : f;
    if(kol.zaman && kol.zaman.saatler){ mask += " HH24:MI"; }
    return mask;
  }

  function sqlTipi(kol){
    if(kol.zaman) return "DATE";
    if(olcumKolonuMu(kol)){
      return kol.ondalikBasamak > 0 ? "NUMBER(18," + kol.ondalikBasamak + ")" : "NUMBER(12)";
    }
    var enUzun = 0;
    for(var i=0;i<kol.values.length;i++){
      if(kol.values[i].length > enUzun) enUzun = kol.values[i].length;
    }
    var boy = Math.min(4000, Math.max(20, Math.ceil((enUzun || 20) * 1.5 / 10) * 10));
    return "VARCHAR2(" + boy + ")";
  }

  // Tip, kolon başına bir kez hesaplanıp geçilir: sqlTipi tüm hücreleri
  // tarar, her değer için yeniden çağırmak satır sayısıyla çarpılırdı.
  function sqlDeger(ham, kol, tip){
    if(ham === "" || ham === null || ham === undefined) return "NULL";
    if(tip === "DATE"){
      return "TO_DATE('" + String(ham).replace(/'/g, "''") + "', '" + sqlTarihMaskesi(kol) + "')";
    }
    if(tip.indexOf("NUMBER") === 0){
      var n = TC.parseNumber(ham);
      return isNaN(n) ? "NULL" : String(n);
    }
    return "'" + String(ham).replace(/'/g, "''") + "'";
  }

  function toSQL(analiz, dummy, tabloAdi){
    var tablo = sqlAd(String(tabloAdi).replace(/\.[^.]+$/, ""));
    var kolonlar = analiz.columns;
    var adlar = kolonlar.map(function(k, i){ return sqlAd(dummy.headers[i] || disaAd(k)); });
    // Aynı ada düşenleri ayır
    var gorulen = Object.create(null);
    adlar = adlar.map(function(a){
      var ad = a, n = 2;
      while(gorulen[ad]){ ad = a.slice(0, 27) + "_" + n; n++; }
      gorulen[ad] = true;
      return ad;
    });

    var tipler = kolonlar.map(function(k){ return sqlTipi(k); });

    var b = [];
    b.push("CREATE TABLE " + tablo + " (");
    var sonIndex = kolonlar.length - 1;
    // Yorumlardaki kolon referansları da DDL'deki temizlenmiş SQL adıyla
    // yazılır: ham başlık hem gizlenen adı sızdırıyor hem yorumu kırıyordu.
    function sqlAdiBul(kol){
      var i = kolonlar.indexOf(kol);
      return i >= 0 ? adlar[i] : "KOLON";
    }
    var satirlar = kolonlar.map(function(k, i){
      var not = [];
      var turetilmis = turetilmisAciklama(k, kolonlar, sqlAdiBul);
      if(turetilmis) not.push(mt("= {0}", turetilmis));
      if(k.joinGrubu) not.push(mt("ortak anahtar"));
      var ebeveyn = hiyerarsiEbeveynAdi(k, kolonlar, sqlAdiBul);
      if(ebeveyn) not.push(mt("bağlı: {0}", ebeveyn));
      // Virgül yorumdan ÖNCE gelmeli; aksi hâlde "--" virgülü de yorum yapar
      // ve üretilen CREATE TABLE çalışmaz.
      var govde = "  " + padSag(adlar[i], 28) + " " + tipler[i] + (i < sonIndex ? "," : "");
      return not.length ? padSag(govde, 56) + "-- " + sqlYorum(not.join(", ")) : govde;
    });
    b.push(satirlar.join("\n"));
    b.push(");");
    b.push("");
    b.push(mt("-- Aşağıdaki satırlar SAHTEDİR, yalnızca yapıyı göstermek içindir."));
    b.push("INSERT ALL");
    dummy.rows.forEach(function(row){
      var degerler = row.map(function(v, i){ return sqlDeger(v, kolonlar[i], tipler[i]); });
      b.push("  INTO " + tablo + " (" + adlar.join(", ") + ") VALUES (" + degerler.join(", ") + ")");
    });
    b.push("SELECT * FROM dual;");
    return b.join("\n");
  }

  /* 6222 sayılı Kanun: her bilet bir TCKN'ye/pasaporta tanımlı olmak zorunda.
     Böyle bir kolon varsa bu, sıradan bir müşteri tablosu değildir. */
  function kanuni6222Var(analiz){
    return analiz.columns.some(function(k){
      var t = k.tespit.type;
      return t.kanuni6222 || t.id === "tckn" || t.id === "ykn" || t.id === "pasaport";
    });
  }

  /* İlişkinin bir ucu: tablo takma adı + kolonun ŞU ANKİ dışa aktarılan adı.
     Kolon indeksi yoksa (elle kurulmuş eski biçim) verilen ada düşülür. */
  function iliskiUcu(tablolar, tabloIndex, kolonIndex, kolonAdi, ham){
    if(!Number.isInteger(tabloIndex)) return ham;
    var t = tablolar[tabloIndex];
    var kol = t && t.analiz ? kolonBul(t.analiz.columns, kolonIndex) : null;
    return tabloEtiketi(tabloIndex) + "." + tekSatir(kol ? disaAd(kol) : (kolonAdi || "kolon"));
  }

  /* ---------------- Prompt üretici ----------------
     Tek tablo da çok tablo da aynı yoldan geçer; analistin elinde genelde
     biletler + etkinlikler + müşteriler birlikte olur. */
  function buildPrompt(opts){
    var tablolar = opts.tablolar || [{
      ad: opts.dosyaAdi || "veri",
      passport: opts.passport,
      dummy: opts.dummy,
      analiz: opts.analiz
    }];
    var format = opts.format === "sql" ? "sql" : "csv";
    var cokTablo = tablolar.length > 1;

    var b = [];
    b.push(cokTablo
      ? mt("Elimde aşağıdaki yapıda {0} tablo var. Gerçek dosyanın tamamını paylaşmıyorum.", tablolar.length)
      : mt("Elimde aşağıdaki yapıda bir veri seti var. Gerçek dosyanın tamamını paylaşmıyorum."));
    b.push(mt("Örnek satırlar sentetik üretilmiştir; veri pasaportunda 'GERÇEK değerler geçer' yazan kolonlar gerçek değer içerebilir."));
    b.push(mt("Pasaporttaki istatistikler örneklem ve sezgisel üretimden gelen yaklaşık yapısal ipuçlarıdır; gerçek dağılımların veya ilişkilerin bire bir korunduğu garanti edilmez."));
    b.push("");

    tablolar.forEach(function(t, tableIndex){
      var alias = tabloEtiketi(tableIndex);
      if(cokTablo){ b.push("=== " + alias + " ==="); }
      // Pasaportun başlık satırı takma adla değişir; kalan satırlar (kullanıcı
      // kolon adları, istatistikler) olduğu gibi geçer.
      var passport = String(t.passport || "").replace(/^[^\n]*/, function(){ return pasaportBasligi(alias); });
      b.push(passport);
      b.push("");
      if(format === "sql" && t.analiz){
        b.push("```sql");
        b.push(toSQL(t.analiz, t.dummy, alias));
        b.push("```");
      } else {
        b.push(mt("ÖRNEK SATIRLAR (sahte):"));
        b.push("```csv");
        b.push(toCSV(t.dummy.headers, t.dummy.rows));
        b.push("```");
      }
      b.push("");
    });

    var iliskiler = opts.iliskiler || [];
    if(iliskiler.length){
      b.push(mt("TABLOLAR ARASI İLİŞKİLER:"));
      iliskiler.forEach(function(i){
        var sol = iliskiUcu(tablolar, i.solTabloIndex, i.solKolonIndex, i.solKolon, i.sol);
        var sag = iliskiUcu(tablolar, i.sagTabloIndex, i.sagKolonIndex, i.sagKolon, i.sag);
        b.push("- " + sol + "  ↔  " + sag + "   (" + mt(i.gerekce) + ")");
      });
      // Tek cümlenin iki satırı: parça parça çevrilirse İngilizcede cümle
      // yarılır; tek parça olarak çevrilir, satır sonu değere gömülür.
      b.push(mt("Bu anahtarlar sahte veride de tutarlıdır: aynı gerçek değer her tabloda aynı\nsahte değere dönüştürüldü, dolayısıyla join'ler örnek üzerinde de çalışır."));
      b.push("");
    }

    b.push(mt("GÖREV: {0}", mt(GOREVLER[opts.gorev] || GOREVLER.gorsellestirme)));
    b.push("");
    b.push(mt("ÖNEMLİ: Yazdığın kodu ben kendi gerçek verimde çalıştıracağım."));
    b.push(mt("Kod, yukarıdaki kolon adlarını ve veri tiplerini kullansın."));

    if(opts.gorev === "noshow"){
      var readiness = assessNoShowReadiness(tablolar, opts.noShowConfig);
      b.push("");
      b.push(mt("NO-SHOW EŞLEŞTİRME VE TANIMI:"));
      if(readiness.mapping.salesKey && readiness.mapping.scanKey){
        b.push(mt("- Satış/payda girdisi: {0}, bilet anahtarı {1}.", readiness.mapping.salesTableLabel, readiness.mapping.salesKey));
        b.push(mt("- Turnike/katılım girdisi: {0}, bilet anahtarı {1}.", readiness.mapping.scanTableLabel, readiness.mapping.scanKey));
      }
      if(readiness.mapping.oneEvent){
        b.push(mt("- Kullanıcı iki girdinin de tek bir etkinliğe önceden filtrelendiğini onayladı; etkinlik anahtarıyla ayrıca eşleştirme yapma."));
      } else if(readiness.mapping.salesEvent && readiness.mapping.scanEvent){
        b.push(mt("- Etkinlik eşleştirmesi: {0}",
          readiness.mapping.salesTableLabel + "." + readiness.mapping.salesEvent + " = " + readiness.mapping.scanTableLabel + "." + readiness.mapping.scanEvent));
      }
      if(readiness.mapping.denominatorMode === "filtered" && readiness.mapping.filteredValidSales){
        b.push(mt("- Kullanıcı satış girdisinin iptal/iade/geçersiz biletlerden arındırıldığını onayladı."));
      } else if(readiness.mapping.denominatorMode === "status" && readiness.mapping.salesStatus){
        b.push(mt("- Geçerli satış filtresi: {0}",
          readiness.mapping.salesStatus + " ∈ {" + readiness.mapping.validStatuses.join(", ") + "}"));
      }
      if(readiness.mapping.successfulScans){ b.push(mt("- Kullanıcı turnike girdisinin yalnız başarılı girişleri içerdiğini onayladı.")); }
      b.push(mt("- Payda = geçerli tekil satılan bilet sayısı; pay = bunlardan en az bir başarılı girişi olan tekil bilet sayısı."));
      b.push(mt("- No-show = payda − pay; oran = no-show / payda. Tekrarlı okutmalar bileti birden fazla sayma; sıfır paydada oranı null bırak."));
      b.push(mt("- Durum filtresinde baştaki/sondaki boşlukları temizle ve büyük-küçük harf farkını yok say. Çelişkili satış satırlarını sessizce tek duruma indirgeme; sayısını raporla."));
      b.push(mt("- Etkinlik ve bilet anahtarıyla eşleştir; eşleşmeyen turnike kayıtlarını ayrı raporla. İptal/iade ve başarılı okutma tanımını verilen onay/kurala göre uygula."));
      b.push(mt("- Kategori, kanal ve satın alma zamanı kırılımlarını yalnızca seçili tablolarda mevcutsa kullan; eksik kolonları uydurma ve analiz kısıtını açıkça belirt."));
      if(!readiness.ready){
        b.push(mt("- EŞLEŞTİRME HAZIR DEĞİL. Kesin hesaplama veya çalıştırılabilir kod üretme; önce yalnızca aşağıdaki eksikleri kullanıcıya sor, varsayım uydurma:"));
        // Eksikler arayüze de yazılır; orada Türkçe kalır (DOM çevirisi döner),
        // prompt'a giden kopya burada çevrilir.
        readiness.gaps.forEach(function(gap){ b.push("  • " + mt(gap)); });
      }
    }

    var belirsizler = opts.belirsizKolonlar || [];
    if(belirsizler.length){
      b.push("");
      b.push(mt("NOT: Şu kolonların yorumundan emin değilim, kodda varsayımını açıkça belirt: {0}", belirsizler.join(", ")));
    }
    return b.join("\n");
  }

  /* =====================================================================
   * 9. TAM AKIŞ
   * ===================================================================== */
  function analyze(rows, opts){
    var o = opts || {};
    var headerIdx = (o.headerRowIdx !== undefined && o.headerRowIdx !== null)
      ? o.headerRowIdx : findHeaderRow(rows);
    return tespitEkle(profileTable(rows, headerIdx));
  }

  /* Profilleme (ağır, saf veri üretir) Web Worker'da çalışabilir; tip tespiti
     ise katalogdaki fonksiyon nesnelerine bağlı olduğu için ana thread'de
     kalmalı — fonksiyonlar postMessage ile kopyalanamaz. Bu yüzden ikisi
     ayrıldı: worker profili gönderir, burada üzerine tespit eklenir. */
  function tespitEkle(analiz){
    analiz.columns.forEach(function(kol){
      // postMessage (structured clone) prototipsiz nesneyi düz nesneye çevirir;
      // "toString" gibi değerler yeniden miras alınmış üyelere çarpmasın.
      if(kol.distinct && Object.getPrototypeOf(kol.distinct) !== null){
        var temiz = Object.create(null);
        Object.keys(kol.distinct).forEach(function(k){ temiz[k] = kol.distinct[k]; });
        kol.distinct = temiz;
      }
      kol.tespit = detectColumn(kol);
      kol.karar = passthroughKarari(kol, kol.tespit);
      kol.disaAktarilanAd = kol.name;
      kol.basligiMaskele = false;
      kol.ozelBaslik = "";
    });
    return analiz;
  }

  /* =====================================================================
   * BAŞLIK GİZLEME
   *
   * Bir başlığın semantik tipi (bu bir maaş / tarih / telefon kolonu)
   * LLM'in ZATEN bilmesi gereken şeydir; onu gizlemek analizi bozar,
   * korumaya bir şey katmaz. Sızıntı, başlıktaki FAZLADAN kelimelerdedir:
   *
   *   maas_2026_gizli      -> "gizli" (ve yıl) fazladan
   *   hiv_durumu           -> "hiv" fazladan (tip yalnızca "sağlık")
   *   proje_kartal_ciro    -> "proje kartal" fazladan (iç kod adı)
   *   kan_grubu            -> fazladan hiçbir şey yok, gizlemek anlamsız
   *
   * Bu yüzden gizleme, tipi koruyup fazlalığı atar: "maas_2026_gizli" -> "maas".
   * Numara yalnızca iki kolon aynı ada düşerse eklenir.
   * ===================================================================== */

  /* Yapısal ya da zararsız başlık parçaları. Bunlar "fazladan bilgi" sayılmaz:
     "birim_fiyat"taki "birim" sızıntı değil, normal bir iş terimidir — gizlemek
     bilgi kaybettirir (birim fiyat mı toplam mı bilinmez olur). */
  var BASLIK_STOP = {
    // yapısal
    no:1, id:1, kod:1, kodu:1, numara:1, num:1, ad:1, adi:1, name:1, code:1,
    value:1, deger:1, alan:1, kolon:1, field:1, column:1, col:1, data:1, veri:1,
    bilgi:1, info:1, tip:1, tipi:1, type:1, durum:1, durumu:1, status:1, flag:1,
    is:1, has:1, the:1, of:1, and:1, ve:1, bir:1, key:1, anahtar:1, unnamed:1,
    kayit:1, kaydi:1, record:1, satir:1, row:1,
    // ölçü ve nitelik belirteçleri
    birim:1, unit:1, toplam:1, total:1, net:1, brut:1, gross:1, ara:1, sub:1,
    ortalama:1, ort:1, avg:1, mean:1, min:1, max:1, sayisi:1, adedi:1,
    oran:1, orani:1, rate:1, yuzde:1, percent:1, pct:1,
    // zaman ve sıra belirteçleri
    ilk:1, son:1, first:1, last:1, ana:1, main:1, alt:1, ust:1, yeni:1, new:1,
    eski:1, old:1, gecerli:1, current:1, onceki:1, previous:1, sonraki:1, next:1,
    gunluk:1, aylik:1, yillik:1, daily:1, monthly:1, yearly:1, annual:1,
    baslangic:1, bitis:1, start:1, end:1, varsayilan:1, def:1,
    // alan-nötr iş sözcükleri: "satis_tarihi"ndeki "satis" bir sızıntı değil
    satis:1, sales:1, alis:1, purchase:1, siparis:1, order:1, islem:1,
    transaction:1, transfer:1, odeme:1, payment:1, giris:1, entry:1, cikis:1,
    exit:1, musteri:1, customer:1, client:1, uye:1, member:1, kullanici:1,
    user:1, urun:1, product:1, item:1, hesap:1, account:1, fatura:1, invoice:1,
    sube:1, branch:1, iade:1, refund:1, iptal:1, cancel:1
  };

  function kelimelereAyir(metin){
    return TC.asciiKatla(TC.camelAyir(String(metin)).toLocaleLowerCase("tr-TR"))
      .split(/[^a-z0-9]+/)
      .filter(function(w){ return w.length >= 2; });
  }

  // Tipin "kendi" kelimeleri: id, etiket ve başlık kalıplarındaki düz sözcükler
  var _tipKelimeOnbellek = {};
  function tipKelimeleri(t){
    if(_tipKelimeOnbellek[t.id]) return _tipKelimeOnbellek[t.id];
    var set = Object.create(null);
    function ekle(metin){ kelimelereAyir(metin).forEach(function(w){ set[w] = true; }); }
    ekle(t.id);
    ekle(t.label);
    (t.header || []).forEach(function(re){
      // /musteri[ _]?ad/i -> "musteri ad"
      ekle(String(re.source).replace(/\\[a-zA-Z]/g, " ").replace(/[^\wçğıöşü]+/g, " "));
    });
    _tipKelimeOnbellek[t.id] = set;
    return set;
  }

  /* Türkçe eklidir: "tarihi" ile "tarih", "fiyati" ile "fiyat" aynı kelimedir.
     Tam eşleşme ararsak her ekli başlık "fazladan bilgi" gibi görünür. */
  function kokEslesiyorMu(kelime, sozluk){
    if(sozluk[kelime]) return true;
    if(kelime.length < 4) return false;
    for(var k in sozluk){
      if(k.length < 4) continue;
      if(kelime.indexOf(k) === 0 || k.indexOf(kelime) === 0) return true;
    }
    return false;
  }

  /* Başlıkta, tipin kendi kelimelerinin dışında ne kalıyor? Gizlenecek şey bu. */
  function baslikFazlasi(kol){
    var tipKelime = tipKelimeleri(kol.tespit.type);
    // "constructor" gibi bir başlık kelimesi miras üyeye çarpıp sessizce
    // atlanmasın: kendi özelliği ve prototipsiz harita
    var gorulen = Object.create(null), fazla = [];
    kelimelereAyir(kol.name).forEach(function(w){
      if(Object.prototype.hasOwnProperty.call(BASLIK_STOP, w) || gorulen[w] || kokEslesiyorMu(w, tipKelime)) return;
      gorulen[w] = true;
      // Salt sayı (yıl, sürüm) tek başına sızıntı sayılmaz — gizlerken düşer
      // ama "bu başlığı gizle" önerisini tetiklemez.
      if(/^\d+$/.test(w)) return;
      fazla.push(w);
    });
    return fazla;
  }

  function baslikHassasMi(kol){
    // KVKK m.6 alanlarında sızdıran şey başlığın kendisidir ("hiv_durumu",
    // "sabika_kaydi", "sendika_uyeligi"). Bu kelimeler tipin kendi kalıplarında
    // geçtiği için "fazladan" görünmezler — o yüzden ayrıca ele alınır.
    if(kol.tespit.type.ozel) return true;
    return baslikFazlasi(kol).length > 0;
  }

  var OZEL_GRUP_KOK = {
    "Sağlık": "saglik_alani",
    "Özel Nitelikli": "ozel_nitelikli_alan"
  };

  function baslikMaskeOner(kol){
    var t = kol.tespit.type;
    // KVKK m.6 alanlarında tipin ADI bile sızdırır (hiv, sabika, sendika),
    // o yüzden grup seviyesine çıkılır.
    if(t.ozel){ return OZEL_GRUP_KOK[t.group] || "hassas_alan"; }
    return t.id;
  }

  /* Dışa aktarılacak başlıkları topluca hesapla; numara yalnızca gerçek
     çakışmada eklenir ("kan_grubu_6" gibi anlamsız numaralar olmasın). */
  /* Kullanıcının elle yazdığı başlık. Prompt ve CSV çıktısını bozabilecek
     karakterler (satır sonu, noktalı virgül, tırnak) temizlenir; boş kalırsa
     otomatik öneriye düşülür. */
  function temizBaslik(ham){
    if(typeof ham !== "string") return "";
    return ham.replace(/[\r\n\t;,"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  }

  function basliklariTazele(analiz){
    var kullanilan = Object.create(null);
    analiz.columns.forEach(function(kol){
      var ad = kol.name;
      if(kol.basligiMaskele){
        // Elle verilen ad varsa o kullanılır, yoksa tipten türetilen öneri.
        ad = temizBaslik(kol.ozelBaslik) || baslikMaskeOner(kol);
      }
      kol.disaAktarilanAd = benzersizAd(ad, kullanilan);
    });
    return analiz;
  }

  window.TableEngine = {
    parseFile: parseFile,
    parseCSV: parseCSV,
    detectDelimiter: detectDelimiter,
    findHeaderRow: findHeaderRow,
    profileTable: profileTable,
    detectColumn: detectColumn,
    passthroughKarari: passthroughKarari,
    analyze: analyze,
    tespitEkle: tespitEkle,
    generateSynthetic: generateSynthetic,
    buildPassport: buildPassport,
    buildPrompt: buildPrompt,
    baslikMaskeOner: baslikMaskeOner,
    baslikHassasMi: baslikHassasMi,
    baslikFazlasi: baslikFazlasi,
    basliklariTazele: basliklariTazele,
    temizBaslik: temizBaslik,
    guvenEtiketi: guvenEtiketi,
    toCSV: toCSV,
    toSQL: toSQL,
    sqlAd: sqlAd,
    iliskileriBul: iliskileriBul,
    takmaAdSifirla: takmaAdSifirla,
    takmaAdSayisi: takmaAdSayisi,
    zamanSekliAnlat: zamanSekliAnlat,
    kanuni6222Var: kanuni6222Var,
    assessNoShowReadiness: assessNoShowReadiness,
    GOREVLER: GOREVLER,
    yuvarlaNazik: yuvarlaNazik,
    formatSayi: formatSayi,
    isFormulaCell: isFormulaCell,
    guvenliHucre: guvenliHucre,
    turetilmisAciklama: turetilmisAciklama,
    hiyerarsiEbeveynAdi: hiyerarsiEbeveynAdi,
    auditSyntheticQuality: auditSyntheticQuality,
    tamKopyaDenetimi: tamKopyaDenetimi,
    kopyaDenetimiOzeti: kopyaDenetimiOzeti
  };
})();
