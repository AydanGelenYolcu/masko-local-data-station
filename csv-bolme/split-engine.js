/* =====================================================
   CSV BÖLME MOTORU — bayt seviyesinde, akışlı
   =====================================================
   5 milyon satırlık bir SPSS/Modeler çıktısı Excel'de açılamaz:
   sayfa başına 1.048.576 satır sınırı vardır. Bu motor dosyayı
   Excel'in yutabileceği parçalara böler.

   NEDEN BAYT SEVİYESİ?
   -------------------
   Bölmek dosyayı ANLAMAYI gerektirmez — hücreleri ayrıştırmaya,
   tipini bulmaya, kodlamayı çözmeye gerek yok. Baytlar olduğu
   gibi öbür uca kopyalanır. Kazancı:
     • 1 GB'lık dosya belleğe girmez; aynı anda yalnızca bir
       okuma penceresi (8 MB) tutulur.
     • Kodlama hiç çözülmediği için (UTF-8 / windows-1254 fark
       etmez) Türkçe karakter bozulamaz.
     • Ayraç (;) ve satır sonu (CRLF) kaynakta neyse o kalır;
       parçalar Excel'de kaynak dosyayla birebir aynı açılır.

   TIRNAK FARKINDALIĞI (RFC 4180)
   ------------------------------
   CSV'de tırnak içindeki satır sonu veridir, satır sonu değil —
   adres ve not alanlarında sık görülür. Düz \n saymak o kaydı
   ortadan ikiye böler ve iki parçayı da bozar. Tarayıcı tırnak
   durumunu takip eder; yalnızca tırnak DIŞINDAKİ \n kayıt sınırıdır.

   Tırnak YALNIZCA ALAN BAŞINDA açılır. Eskiden her " işareti durumu
   tersine çeviriyordu: tırnaksız bir alandaki 5" (inç) gibi tek bir
   değer dosyanın geri kalanını tek kayda çeviriyordu (4 satır → 1).
   Tırnaklı alanın içindeki "" kaçışlı tırnaktır, alanı kapatmaz.

   Tarama durumu pencereler arasında TAŞINIR: yarım kalan kayıt bir
   sonraki pencerede baştan taranmaz, kaldığı yerden devam eder.
   Eskiden bekleyen bölge her 8 MB'da yeniden birleştirilip baştan
   taranıyordu — uzun bir kayıtta O(N²) süre ve dosyanın tamamı
   bellekte. Tek kaydın boyu da tavanlıdır (16 MB); kapanmamış bir
   tırnak artık tarayıcıyı kilitlemez, anlaşılır bir hatayla durur.
   ===================================================== */

const SplitEngine = (() => {
  'use strict';

  const LF    = 0x0A;
  const CR    = 0x0D;
  const QUOTE = 0x22;

  const PENCERE      = 8 * 1024 * 1024;    // okuma penceresi
  const ORNEK        = 4 * 1024 * 1024;    // tahmin için okunan ön parça
  const KAYIT_TAVANI = 16 * 1024 * 1024;   // tek kaydın en fazla boyu

  /* Tarayıcı durumları. Kayıt sınırı her zaman ALAN_BASI'na döner. */
  const ALAN_BASI      = 0;   // alanın ilk baytı bekleniyor
  const TIRNAKSIZ      = 1;   // tırnaksız alanın içi (" burada veridir)
  const TIRNAKLI       = 2;   // tırnaklı alanın içi (LF ve ayraç veridir)
  const TIRNAK_SONRASI = 3;   // tırnaklı alanda " görüldü: "" kaçış mı, kapanış mı?

  /* Hücre ayırma, ayraç tespiti ve formül riski csv-io.js'te tek yerde
     tutulur (tablo, tezgâh ve kitle modülleriyle aynı kural); sayfa onu bu
     dosyadan önce yükler. Burada kalan bayt tarayıcısı (_tarayici) ayrı bir
     iştir: parça parça okunan dosyada kaydın nerede bittiğini bulur, metne
     hiç çevirmeden. */
  function csvIO() {
    if (typeof CsvIO !== 'undefined') return CsvIO;
    throw new Error('csv-io.js yüklenmedi; CSV başlığı çözülemez.');
  }

  /* Ayraç tablosu: baytın alan ayracı olup olmadığı. Başlık taranırken
     ayraç henüz bilinmediği için bütün adaylar işaretlenir. */
  function _ayracTablosu(ayraclar) {
    const t = new Uint8Array(256);
    for (const a of ayraclar) if (a) t[typeof a === 'number' ? a : a.charCodeAt(0)] = 1;
    return t;
  }

  /* Durumlu kayıt tarayıcı. `sonu(buf, start)` kaydın bittiği yeri (LF
     dahil, sonrası) döner; kayıt bu tamponda bitmediyse -1 döner ve
     durumu saklar — bir sonraki tampon kaldığı yerden taranır. */
  function _tarayici(ayracMi) {
    let durum = ALAN_BASI;
    return {
      sonu(buf, start) {
        let d = durum;
        for (let i = start; i < buf.length; i++) {
          const b = buf[i];
          if (d === TIRNAKLI) {
            if (b === QUOTE) d = TIRNAK_SONRASI;
          } else if (d === TIRNAK_SONRASI) {
            if (b === QUOTE) d = TIRNAKLI;                    // "" kaçışı
            else if (b === LF) { durum = ALAN_BASI; return i + 1; }
            else d = ayracMi[b] ? ALAN_BASI : TIRNAKSIZ;     // "abc"x → hoşgörülü
          } else {
            if (b === LF) { durum = ALAN_BASI; return i + 1; }
            if (ayracMi[b]) d = ALAN_BASI;
            else if (d === ALAN_BASI) d = b === QUOTE ? TIRNAKLI : TIRNAKSIZ;
          }
        }
        durum = d;
        return -1;
      },
      sifirla() { durum = ALAN_BASI; }
    };
  }

  /* Tek seferlik tarama: `start` bir kayıt başıdır. */
  function _satirSonu(buf, start, ayracMi) {
    return _tarayici(ayracMi).sonu(buf, start);
  }

  function _kayitTavaniHatasi(tavan, konum) {
    const sinir = tavan >= 1048576 ? Math.round(tavan / 1048576) + ' MB' : tavan + ' bayt';
    return new Error(
      `Tek bir kayıt ${sinir} sınırını aştı (dosyanın yaklaşık ` +
      `${(konum / 1024 / 1024).toFixed(1)} MB'ından sonra). Dosyada kapanmamış bir çift tırnak ` +
      `ya da hiç satır sonu (LF) olmayabilir — yalnızca CR kullanan eski Mac biçimi desteklenmez. ` +
      `Dosya bu hâliyle güvenle bölünemez.`);
  }

  /* ---------- AYRAÇ DÖNÜŞTÜRME ----------
     Excel, sütun ayracı olarak işletim sisteminin "liste ayırıcısını"
     bekler — Türkçe Windows'ta bu ';' dir. Virgül ayraçlı bir dosya
     çift tıklamayla açıldığında her satır tek hücreye düşer ve
     kullanıcı "Metni Sütunlara Dönüştür" sihirbazına mahkûm olur.

     Dönüşüm bayt seviyesinde yapılır: ayraç ve tırnak ASCII olduğu ve
     hem UTF-8 hem windows-1254 ASCII üst kümesi olduğu için kodlama
     çözülmeden güvenle değiştirilebilir; Türkçe karakterlere dokunulmaz.

     Verilen bölge her zaman TAM satırlar içerir (çağıran taraf satır
     sınırında kesiyor), bu yüzden bölge bir bütün olarak işlenebilir. */
  function _ayraciDonustur(src, kaynakAyrac, hedefAyrac) {
    let out = new Uint8Array(src.length + (src.length >> 3) + 16);
    let o = 0;

    function yer(ek) {
      if (o + ek <= out.length) return;
      let yeni = out.length * 2;
      while (yeni < o + ek) yeni *= 2;
      const b = new Uint8Array(yeni);
      b.set(out.subarray(0, o), 0);
      out = b;
    }
    function yaz(b) { yer(1); out[o++] = b; }

    let i = 0;
    while (i < src.length) {

      if (src[i] === QUOTE) {
        // Tırnaklı alan: içeriğe dokunma, kapanış tırnağına kadar aynen kopyala.
        // İçindeki ayraç zaten veri sayılır, dönüştürülmemeli.
        yaz(src[i++]);
        while (i < src.length) {
          if (src[i] === QUOTE) {
            if (src[i + 1] === QUOTE) { yaz(src[i++]); yaz(src[i++]); continue; }
            yaz(src[i++]);
            break;
          }
          yaz(src[i++]);
        }
      } else {
        // Tırnaksız alan: sınırını bul
        let son = i, tirnakGerek = false;
        while (son < src.length) {
          const b = src[son];
          if (b === kaynakAyrac || b === LF || b === CR) break;
          // Alan, YENİ ayracı ya da tırnak içeriyorsa tırnaklanmalı;
          // yoksa dönüşümden sonra sahte bir sütun sınırı doğar.
          if (b === hedefAyrac || b === QUOTE) tirnakGerek = true;
          son++;
        }
        if (tirnakGerek) {
          yer(son - i + 2);
          yaz(QUOTE);
          for (let k = i; k < son; k++) { if (src[k] === QUOTE) yaz(QUOTE); yaz(src[k]); }
          yaz(QUOTE);
        } else {
          yer(son - i);
          for (let k = i; k < son; k++) out[o++] = src[k];
        }
        i = son;
      }

      // Alan sonrası: ayraç ya da satır sonu
      if (i < src.length) {
        const b = src[i];
        if (b === kaynakAyrac) { yaz(hedefAyrac); i++; }
        else if (b === CR || b === LF) {
          if (src[i] === CR) yaz(src[i++]);
          if (i < src.length && src[i] === LF) yaz(src[i++]);
        } else {
          yaz(src[i++]);   // beklenmedik bayt — aynen geçir
        }
      }
    }

    return out.subarray(0, o);
  }

  /* Parça listesini tek diziye toplar. Yalnızca birden fazla pencereye
     yayılan TEK kayıt için çağrılır, dolayısıyla toplam maliyet doğrusal. */
  function _birlestirListe(liste, son) {
    let boy = son ? son.length : 0;
    for (const p of liste) boy += p.length;
    const out = new Uint8Array(boy);
    let at = 0;
    for (const p of liste) { out.set(p, at); at += p.length; }
    if (son) out.set(son, at);
    return out;
  }

  /* Baytları metne çevirir. Ana projedeki table-engine/dedup-engine ile
     aynı yaklaşım: UTF-8 çözümünde bozuk karakter çoksa dosya Türkçe
     Excel'in klasik windows-1254 çıktısıdır. Yalnızca BAŞLIĞI ekranda
     göstermek için kullanılır — bölme işlemi metne hiç dokunmaz. */
  function _metneCevir(bytes) {
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    const bozuk = (utf8.match(/�/g) || []).length;
    if (bozuk > 0 && bozuk > utf8.length / 5000) {
      try { return new TextDecoder('windows-1254').decode(bytes); } catch (e) { /* çözülemezse utf8 kalsın */ }
    }
    return utf8;
  }

  /* Kaydın metnini hücrelere ayırır — tarayıcıyla aynı kural: tırnak
     yalnızca alan başında açılır, "" kaçışlı tırnaktır. BOM ve kaydı bitiren
     satır sonu ayrıştırıcıda atılır. Satır dizisi döner: tarayıcının kayıt
     saymadığı yalnız-CR ayrı satır çıkar, çağıran hepsini gezer. */
  function _kayitHucreleri(kayitMetni, ayrac) {
    return csvIO().parse(kayitMetni, { delimiter: ayrac }).rows;
  }

  function _basliktanSutunlar(baslikBaytlari, ayrac) {
    const satirlar = _kayitHucreleri(_metneCevir(baslikBaytlari), ayrac);
    return (satirlar[0] || ['']).map(h => h.trim());
  }

  /* ---------- ÖN İNCELEME ----------
     Dosyanın başından bir örnek okuyup başlığı çıkarır ve satır
     sayısını TAHMİN eder. Kesin sayı için dosyanın tamamını okumak
     gerekir; 1 GB'lık dosyada bu, kullanıcıyı daha ayar ekranındayken
     saniyelerce bekletmek demek. Tahmin "≈" olarak sunulur, kesin
     rakam bölme bitince raporlanır. */
  /* Başlığın bittiği yeri ve ayracı bulur. Ayraç henüz bilinmediği için
     önce bütün adaylarla taranır, ayraç seçildikten sonra kesin sınır
     o ayraçla yeniden bulunur (yalnızca başlık — maliyeti önemsiz). */
  function _baslikBul(buf, ayracIpucu) {
    let ayrac = ayracIpucu;
    if (!ayrac) {
      const kaba = _satirSonu(buf, 0, _ayracTablosu(csvIO().DELIMITERS));
      if (kaba < 0) return null;
      // Başlığın alan sayısına bakılır (tırnak içindeki ayraç sayılmaz)
      ayrac = csvIO().detectDelimiter(_metneCevir(buf.subarray(0, kaba)));
    }
    const son = _satirSonu(buf, 0, _ayracTablosu([ayrac]));
    return son < 0 ? null : { son, ayrac };
  }

  async function onInceleme(file) {
    const ornekBoyu = Math.min(ORNEK, file.size);
    const buf = new Uint8Array(await file.slice(0, ornekBoyu).arrayBuffer());

    const baslik = _baslikBul(buf);
    if (!baslik) {
      throw new Error('Başlık satırı bulunamadı — dosyanın ilk satırı çok uzun ya da dosya CSV değil.');
    }
    const baslikSonu = baslik.son;
    const ayrac = baslik.ayrac;
    const ayracMi = _ayracTablosu([ayrac]);

    const baslikBaytlari = buf.slice(0, baslikSonu);
    const sutunlar = _basliktanSutunlar(baslikBaytlari, ayrac);

    // Örnekteki tam satırları say; ilk 30 kaydın sınırlarını formül taraması için sakla
    const ornekKayitlar = [];
    let p = baslikSonu, satir = 0, sonTam = baslikSonu;
    while (p < buf.length) {
      const son = _satirSonu(buf, p, ayracMi);
      if (son < 0) break;
      if (ornekKayitlar.length < 30) ornekKayitlar.push([p, son]);
      satir++; sonTam = son; p = son;
    }

    const veriBayti = file.size - baslikSonu;
    let tahminiSatir;
    if (satir === 0) {
      tahminiSatir = 0;
    } else if (ornekBoyu >= file.size) {
      // Dosyanın tamamı örneğe sığdı — tahmin değil, kesin sayı
      tahminiSatir = satir + (p < buf.length ? 1 : 0);
    } else {
      const satirBasinaBayt = (sonTam - baslikSonu) / satir;
      tahminiSatir = Math.round(veriBayti / satirBasinaBayt);
    }

    /* Örnek hücrelerde formül enjeksiyonu riski tara. Bölme baytlara
       dokunmadığı için riskli hücre DEĞİŞTİRİLMEZ; arayüz yalnızca uyarır.
       Kayıtlar tarayıcının bulduğu sınırlardan alınır — satır sonuna göre
       bölmek çok satırlı hücreleri parçalar ve sahte hücre üretirdi. */
    let formulHucreSayisi = 0;
    const formulOrnekleri = [];
    const tara = hucre => {
      if (!isFormulaCell(hucre)) return;
      formulHucreSayisi++;
      if (formulOrnekleri.length < 3) formulOrnekleri.push(hucre.length > 40 ? hucre.slice(0, 40) + '…' : hucre);
    };
    sutunlar.forEach(tara);
    for (const [bas, son] of ornekKayitlar) {
      for (const hucreler of _kayitHucreleri(_metneCevir(buf.subarray(bas, son)), ayrac)) hucreler.forEach(tara);
    }

    return {
      sutunlar,
      ayrac,
      baslikBaytUzunlugu: baslikSonu,
      tahminiSatir,
      kesinMi: ornekBoyu >= file.size,
      dosyaBoyutu: file.size,
      ornekFormulRisk: formulHucreSayisi > 0,
      ornekFormulSayisi: formulHucreSayisi,
      ornekFormulOrnekleri: formulOrnekleri
    };
  }

  /* ---------- BÖLME ----------
     secenekler:
       satirSiniri   — parça başına en fazla veri satırı (0 = sınırsız)
       baytSiniri    — parça başına en fazla bayt (0 = sınırsız)
       parcaAc(no)   — {write(bytes), close()} döndüren fabrika
       parcaTavani   — en fazla kaç parça üretilsin (0 = tavansız)
       onIlerleme({okunanBayt, toplamBayt, satir, parca})
       iptalMi()     — true dönerse temiz durur
       kaynakAyrac   — kaynaktaki alan ayracı (verilmezse başlıktan bulunur)
       pencereBoyu / kayitTavani — test ve ayar için; varsayılan 8 MB / 16 MB

     İki sınır birlikte çalışır: hangisi önce dolarsa parça orada kapanır. */
  async function bol(file, secenekler) {
    const satirHam    = Math.max(0, secenekler.satirSiniri | 0);
    const satirSiniri = satirHam > 0 ? satirHam : Infinity;
    const baytSiniri  = Math.max(0, secenekler.baytSiniri || 0);
    const parcaAc     = secenekler.parcaAc;
    const onIlerleme  = secenekler.onIlerleme || function () {};
    const iptalMi     = secenekler.iptalMi || function () { return false; };
    const parcaTavani = secenekler.parcaTavani || 0;
    const pencereBoyu = secenekler.pencereBoyu > 0 ? secenekler.pencereBoyu : PENCERE;
    const kayitTavani = secenekler.kayitTavani > 0 ? secenekler.kayitTavani : KAYIT_TAVANI;

    /* Hiç sınır verilmemişse tek parça üretilir — eskiden satır sınırı
       1'e yuvarlanıyor ve her satır ayrı dosya oluyordu. */
    if (!isFinite(satirSiniri) && !baytSiniri) {
      throw new Error('En az bir sınır gerekli: satır ya da boyut.');
    }

    /* Kayıt sınırını bulmak için ayraç gerekir: tırnak yalnızca alan
       başında (ayraçtan sonra) açılır. Çağıran vermediyse başlıktan bul. */
    let ayrac = secenekler.kaynakAyrac || null;
    if (!ayrac) {
      const ilk = new Uint8Array(await file.slice(0, Math.min(ORNEK, file.size)).arrayBuffer());
      const b = _baslikBul(ilk);
      ayrac = b ? b.ayrac : ';';
    }
    const tarayici = _tarayici(_ayracTablosu([ayrac]));

    /* Ayraç dönüşümü istendi mi? İstenmediyse baytlar hiç ellenmez
       (hızlı yol: doğrudan kopya). */
    const kaynakAyrac = ayrac.charCodeAt(0);
    const hedefAyrac  = secenekler.hedefAyrac  ? secenekler.hedefAyrac.charCodeAt(0)  : 0;
    const donusumVar  = kaynakAyrac && hedefAyrac && kaynakAyrac !== hedefAyrac;
    const cevir = bytes => donusumVar ? _ayraciDonustur(bytes, kaynakAyrac, hedefAyrac) : bytes;

    let baslik   = null;   // kaynaktaki hâli (satır sayımı için)
    let baslikCikti = null;  // parçalara yazılan hâli (ayraç dönüşmüş olabilir)
    /* Önceki pencerelerden kalan YARIM kaydın parçaları. Liste olarak
       tutulur ve yeniden taranmaz; tarayıcı durumu kaldığı yerden sürer. */
    let bekleyen = [];
    let bekleyenBoy = 0;
    let okunan   = 0;

    let parca = null, parcaNo = 0, parcaSatir = 0, parcaBayt = 0;
    let toplamSatir = 0;
    const parcalar = [];
    let iptal = false;

    async function parcaBaslat() {
      parcaNo++;
      parca = await parcaAc(parcaNo);
      await parca.write(baslikCikti);
      parcaBayt  = baslikCikti.length;
      parcaSatir = 0;
      parcalar.push({ no: parcaNo, satir: 0, bayt: 0 });
    }

    async function parcaKapat() {
      if (!parca) return;
      const kayit = parcalar[parcalar.length - 1];
      kayit.satir = parcaSatir;
      kayit.bayt  = parcaBayt;
      await parca.close();
      parca = null;
    }

    /* Bir veri satırının parçaya sığıp sığmadığına karar verir.
       parcaSatir > 0 koşulu şart: tek başına bayt sınırından büyük bir
       satır varsa, boş parça açıp sonsuza kadar dönmek yerine o satırı
       bulunduğu parçaya yazar. */
    function yeniParcaGerekli(satirUzunlugu) {
      if (!parca) return true;
      if (parcaSatir >= satirSiniri) return true;
      if (baytSiniri && parcaSatir > 0 && parcaBayt + satirUzunlugu > baytSiniri) return true;
      return false;
    }

    let tavanaTakildi = false;

    for (let konum = 0; konum < file.size; konum += pencereBoyu) {
      if (iptalMi()) { iptal = true; break; }

      const pencere = new Uint8Array(await file.slice(konum, konum + pencereBoyu).arrayBuffer());
      okunan += pencere.length;

      let segBasi   = 0;   // bu pencerede henüz yazılmamış bölgenin başı
      let kayitBasi = 0;   // taranan kaydın bu penceredeki başı (bekleyen varsa kayıt önceki pencerede başladı)
      let i         = 0;   // tarama konumu — hiçbir bayt iki kez taranmaz

      while (i < pencere.length) {
        const son = tarayici.sonu(pencere, i);
        if (son < 0) break;
        const satirUzunlugu = bekleyenBoy + (son - kayitBasi);

        /* Önceki pencerelerden taşan kayıt burada tamamlandı. Parçaları
           TEK kez birleştirilir; ayraç dönüşümü tam kayıt gördüğü için
           kayıt bölünmeden tek seferde yazılmalı. */
        let tasan = null;
        if (bekleyenBoy) {
          tasan = _birlestirListe(bekleyen, pencere.subarray(kayitBasi, son));
          bekleyen = []; bekleyenBoy = 0;
        }

        if (baslik === null) {
          baslik = tasan || pencere.slice(kayitBasi, son);   // BOM varsa başlıkla birlikte her parçaya gider
          baslikCikti = cevir(baslik);
          segBasi = son; i = son; kayitBasi = son;
          continue;
        }

        if (yeniParcaGerekli(satirUzunlugu)) {
          if (parca) {
            // Bu parçaya ait biriken bölgeyi yaz, sonra kapat
            if (kayitBasi > segBasi) await parca.write(cevir(pencere.subarray(segBasi, kayitBasi)));
            await parcaKapat();
            segBasi = kayitBasi;
          }

          /* İptal ve tavan kontrolü BURADA olmak zorunda. Tek bir 8 MB
             pencere içinde binlerce parça üretilebiliyor; kontrolü yalnızca
             pencere başına koymak "Durdur" düğmesini işlevsiz bırakıyor ve
             ilerleme çubuğunu 0'da donduruyordu. */
          if (iptalMi()) { iptal = true; break; }
          if (parcaTavani && parcaNo >= parcaTavani) { tavanaTakildi = true; break; }

          await parcaBaslat();

          /* Arayüzün boyanması ve Durdur'un basılabilmesi için olay
             döngüsüne yer aç — await'ler yalnızca mikro görev üretiyor,
             tek başına ekranı tazelemiyor. */
          if (parcaNo % 10 === 0) {
            onIlerleme({ okunanBayt: konum + i, toplamBayt: file.size, satir: toplamSatir, parca: parcaNo });
            await new Promise(r => setTimeout(r, 0));
          }
        }

        if (tasan) {
          // Taşan kayıt pencerenin ilk kaydıdır: pencereden henüz hiçbir şey yazılmadı
          await parca.write(cevir(tasan));
          segBasi = son;
        }

        parcaSatir++; parcaBayt += satirUzunlugu; toplamSatir++;
        i = son; kayitBasi = son;
      }

      // Pencerenin tamamlanmış kısmını yaz, yarım kaydı sonraki pencereye devret
      if (parca && kayitBasi > segBasi) await parca.write(cevir(pencere.subarray(segBasi, kayitBasi)));

      onIlerleme({ okunanBayt: okunan, toplamBayt: file.size, satir: toplamSatir, parca: parcaNo });

      // Pencere ortasında durduysak dosyanın kalanını okumaya devam etme
      if (iptal || tavanaTakildi) break;

      if (kayitBasi < pencere.length) {
        bekleyen.push(kayitBasi === 0 ? pencere : pencere.slice(kayitBasi));
        bekleyenBoy += pencere.length - kayitBasi;
        /* Kapanmamış bir tırnak dosyanın geri kalanını tek kayda çevirir.
           Tavansız bırakılırsa bütün dosya belleğe dolar; burada durup
           nedenini söylüyoruz. Yazılmış parçalar tam kayıtlardan oluşur. */
        if (bekleyenBoy > kayitTavani) {
          await parcaKapat();
          throw _kayitTavaniHatasi(kayitTavani, konum + pencere.length - bekleyenBoy);
        }
      }
    }

    // Son kayıt \n ile bitmiyorsa geriye yarım değil, tam bir kayıt kalır
    if (!iptal && !tavanaTakildi && bekleyenBoy) {
      const kalan = _birlestirListe(bekleyen);
      bekleyen = []; bekleyenBoy = 0;
      const bosMu = kalan.every(b => b === CR || b === LF || b === 0x20 || b === 0x09);
      if (!bosMu) {
        if (baslik === null) {
          baslik = kalan;                          // yalnızca başlık var, veri yok
          baslikCikti = cevir(baslik);
        } else {
          if (yeniParcaGerekli(kalan.length)) {
            await parcaKapat();
            if (parcaTavani && parcaNo >= parcaTavani) tavanaTakildi = true;
            else await parcaBaslat();
          }
          if (!tavanaTakildi) {
            await parca.write(cevir(kalan));
            parcaSatir++; parcaBayt += kalan.length; toplamSatir++;
          }
        }
      }
    }

    await parcaKapat();

    return {
      iptal,
      tavanaTakildi,
      toplamSatir,
      parcaSayisi: parcalar.length,
      parcalar,
      basliksizMi: baslik === null
    };
  }

  /* Formül enjeksiyonu (OWASP CSV Injection): csv-io.js'teki ortak kural.
     Bölme baytları değiştirmediği için burada yalnızca risk tespiti için
     kullanılır. */
  function isFormulaCell(s) {
    return csvIO().isFormulaCell(s);
  }

  return { onInceleme, bol, isFormulaCell };
})();
