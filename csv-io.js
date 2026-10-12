/**
 * csv-io.js — Ortak CSV okuma/yazma ve formül enjeksiyonu koruması
 *
 * Neden tek dosya? Aynı CSV kuralları dokuz ayrıştırıcı, beş yazıcı ve altı
 * formül koruması kopyasına dağılmıştı; bir kopyada düzeltilen hata (alan
 * ortasındaki tırnak, yalnız-CR satır sonu, "-5,25" gibi negatifin formül
 * sanılması) diğerlerinde yaşamaya devam ediyordu. Kural artık burada bir kez
 * yazılır, modüller buna devreder.
 *
 * Tarayıcıda / worker'da `CsvIO` olarak, Node'da require ile kullanılır.
 * Bağımlılık yok, ağ erişimi yok, çıktı deterministik.
 *
 * Akışlı (parça parça okunan) büyük dosya tarayıcıları — csv-bolme'nin bayt
 * tarayıcısı ve kitle-tekillestirme'nin sözlük kodlamalı okuyucusu — kendi
 * durum makinelerini tutar; onlar da hücre koruması ve yazma için buraya gelir.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CsvIO = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BOM = '\uFEFF';
  // Türkçe Excel ';' ile yazar; sıra aynı zamanda eşitlikte tercih sırasıdır.
  const DELIMITERS = [';', ',', '\t', '|'];
  const AYRAC_ORNEK_SATIR = 20;
  const AYRAC_ORNEK_KARAKTER = 200000;

  const QUOTE = 34, LF = 10, CR = 13, SPACE = 32, TAB = 9;

  /* =====================================================================
   * 1. FORMÜL ENJEKSİYONU (OWASP CSV Injection)
   * Excel bir CSV'yi açarken =, +, -, @, sekme ya da CR ile başlayan hücreyi
   * formül sayar. Yalnız rakam ve ayraçtan oluşan işaretli değerler ("-5",
   * "-1.234,56", "+15.5") sayıdır; onlara ' eklemek veriyi bozardı. Metin
   * olmayan değerler (sayı, boolean) formül olamaz, olduğu gibi döner.
   * Yalnız CSV çıktısına uygulanır: XLSX'te SheetJS metni 's' hücresi yazar,
   * formül çalışmaz ve ' orada görünür kalırdı.
   * ===================================================================== */

  function guvenliHucre(v) {
    if (typeof v !== 'string' || !/^[=+\-@\t\r]/.test(v)) return v;
    if (/^[+-][\d.,]+$/.test(v.trim())) return v;   // işaretli sayı formül değildir
    return "'" + v;
  }

  /* Sayım ve dönüşüm aynı tanımı kullanır: "N hücre korundu" mesajı gerçekten
     değiştirilen hücre sayısıyla birebir tutar. */
  function isFormulaCell(v) {
    return guvenliHucre(v) !== v;
  }

  function ayracDogrula(d) {
    if (typeof d !== 'string' || d.length !== 1 || d === '"' || d === '\r' || d === '\n') {
      throw new Error('CSV ayracı tek karakter olmalı ve tırnak ya da satır sonu olamaz: ' + JSON.stringify(d));
    }
    return d;
  }

  /* =====================================================================
   * 2. OKUMA (RFC 4180, bozuk girdiye toleranslı)
   * - Tırnak yalnızca alan BAŞINDA alıntı açar. Alan ortasındaki tırnak
   *   (Ekran 27" Monitör) veridir; eskiden alıntı açıp dosyanın geri kalanını
   *   tek hücreye yutuyordu.
   * - Alıntı içindeki "" kaçışlı tırnaktır; ayraç ve satır sonları alana aittir.
   * - Kapanış tırnağı ancak ardından (boşluk dolgusundan sonra) ayraç, satır
   *   sonu ya da dosya sonu gelirse kapatır; "a"b" gibi arada kalan tırnak
   *   veridir. Böylece "Ahmet "Kral" Yılmaz" tek hücre kalır.
   * - Hiç kapanmayan açılış tırnağı dosyanın geri kalanını yutmaz: o alan
   *   tırnak dâhil düz metin okunur. Kapanış adayı ararken dosya sonuna kadar
   *   hiç aday bulunamazsa bu bilgi saklanır; sonraki açılışlar yeniden
   *   taramaz. Her karakter en fazla iki kez görülür, süre O(N) kalır.
   * - \r\n, \n ve eski Mac / bazı ERP dökümlerinin yalnız-\r satır sonu kayıt
   *   bitirir.
   * ===================================================================== */

  /**
   * @param {string} text
   * @param {Object} [options]
   * @param {string} [options.delimiter] - Verilmezse detectDelimiter ile bulunur.
   * @param {number} [options.maxRows] - Yalnız ilk N kayıt gerekiyorsa erken durur.
   * @param {boolean} [options.trim=false] - Tırnaksız alanları kırpar ve tırnaktan
   *   önceki boşluğa izin verir (bozuk dosya kurtarma / pano için).
   * @param {boolean} [options.positions=false] - Kayıt başına { line, start, end }
   *   döndürür. Konumlar BOM atıldıktan sonraki metne göredir; line 1 tabanlı
   *   fiziksel satırdır (tırnak içi satır sonları sayılır).
   * @param {Function} [options.onProgress] - Büyük metinde periyodik (oran 0-1).
   * @returns {{ rows: string[][], delimiter: string, unclosedQuotes: number,
   *   records?: Array<{ line: number, start: number, end: number }> }}
   *   unclosedQuotes: kapanmadığı için düz metin okunan tırnaklı alan sayısı.
   */
  function parse(text, options) {
    const opts = options || {};
    text = text == null ? '' : String(text);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const delimiter = opts.delimiter != null ? ayracDogrula(opts.delimiter) : detectDelimiter(text);
    const st = { satir: 1, kapanmayan: 0, adet: 0, taban: 0 };
    const r = cekirdek(text, delimiter.charCodeAt(0), !!opts.trim, !!opts.positions,
      opts.maxRows > 0 ? opts.maxRows : Infinity, st, true,
      typeof opts.onProgress === 'function' ? opts.onProgress : null);
    const sonuc = { rows: r.rows, delimiter, unclosedQuotes: st.kapanmayan };
    if (opts.positions) sonuc.records = r.records;
    return sonuc;
  }

  /* Parçalı kipte "bu kaydı bitirmek için metnin devamı gerekli" işareti. */
  const EKSIK = { eksik: true };
  /* Parçalı kipte tek bir kaydın en fazla uzunluğu (karakter). Bu sınırı aşan
     kayıtta metnin sonu dosya sonu sayılır: kapanmayan bir tırnak dosyanın
     geri kalanını beklemeye almaz, parse() ile aynı şekilde düz metin okunur. */
  const AKIS_KAYIT_SINIRI = 32 * 1024 * 1024;

  /* Tek ayrıştırma çekirdeği (parse ve createParser ortak kullanır).
     son=true: metnin tamamı elde; davranış tarihsel parse ile birebir aynıdır.
     son=false: metnin devamı gelecek. Sonu belirsiz kalan kayıt (sonlandırıcısı
     görülmedi, kapanış tırnağı aranırken metin bitti, CR'den sonra LF gelip
     gelmeyeceği bilinmiyor) üretilmez; tuketilen o kaydın başını gösterir. */
  function cekirdek(text, d, trim, konumlar, sinir, st, son, ilerleme) {
    const n = text.length;
    const adim = Math.max(1 << 20, Math.floor(n / 50));
    const rows = [];
    // konumlar === 'dizi': kayıt başına nesne yerine üç sayı dizisi (milyonlarca satırda
    // nesne üretmemek için; createParser içinde kullanılır).
    const diziKipi = konumlar === 'dizi';
    const records = konumlar && !diziKipi ? [] : null;
    const kBas = diziKipi ? [] : null, kSon = diziKipi ? [] : null, kSatir = diziKipi ? [] : null;
    let kapanisYok = false;   // son kipte: taranan konumdan metin sonuna kapanış adayı yok
    let zorla = false;        // bu kayıt için metnin sonu dosya sonu sayılır
    let sonBildirim = 0;
    let i = 0;
    let tuketilen = 0;
    let satir = st.satir;

    // Tırnak etrafındaki dolgu boşluğu; ayraç boşluk/sekmeyse o veri sayılır.
    function bosluk(p) {
      while (p < n) {
        const c = text.charCodeAt(p);
        if ((c === SPACE && d !== SPACE) || (c === TAB && d !== TAB)) p++;
        else break;
      }
      return p;
    }

    function sonlandiriciMi(p) {
      p = bosluk(p);
      if (p >= n) return (son || zorla) ? true : EKSIK;
      const c = text.charCodeAt(p);
      return c === d || c === LF || c === CR;
    }

    /* k'deki açılış tırnağıyla başlayan alanı okur. Kapandıysa
       { deger, son } döner, kapanmadıysa null (çağıran düz metin okur). */
    function tirnakliAlan(k) {
      let j = k;
      while (j < n && text.charCodeAt(j) === QUOTE) j++;
      if (j >= n && !son && !zorla) return EKSIK;
      const kalan = j - k - 1;                  // açılıştan sonra aynı dizideki tırnaklar
      let deger = '"'.repeat(kalan >> 1);
      if (kalan % 2 === 1) {
        const t = sonlandiriciMi(j);
        if (t === EKSIK) return EKSIK;
        if (t) return { deger, son: j };
        deger += '"';
      }
      if (kapanisYok) return null;
      let p = j;
      for (;;) {
        const q = text.indexOf('"', p);
        if (q < 0) {
          if (!son && !zorla) return EKSIK;
          if (son) kapanisYok = true;
          return null;
        }
        deger += text.slice(p, q);
        let e = q;
        while (e < n && text.charCodeAt(e) === QUOTE) e++;
        if (e >= n && !son && !zorla) return EKSIK;
        deger += '"'.repeat((e - q) >> 1);
        p = e;
        if ((e - q) % 2 === 1) {
          const t = sonlandiriciMi(e);
          if (t === EKSIK) return EKSIK;
          if (t) return { deger, son: e };
          deger += '"';
        }
      }
    }

    while (i < n && st.adet < sinir) {
      if (ilerleme && i - sonBildirim >= adim) {
        sonBildirim = i;
        ilerleme(i / n);
      }
      const row = [];
      const bas = i;
      const basSatir = satir;
      const basKapanmayan = st.kapanmayan;
      zorla = !son && (n - bas) > AKIS_KAYIT_SINIRI;
      const belirsiz = !son && !zorla;
      let eksik = false;
      for (;;) {
        const k = trim ? bosluk(i) : i;
        let alan = null;
        if (k < n && text.charCodeAt(k) === QUOTE) {
          const t = tirnakliAlan(k);
          if (t === EKSIK) { eksik = true; break; }
          if (t) {
            if (konumlar) satir += satirSonuSayisi(text, k, t.son);
            alan = t.deger;
            i = bosluk(t.son);
          } else {
            st.kapanmayan++;
          }
        }
        if (alan === null) {
          let e = i;
          while (e < n) {
            const c = text.charCodeAt(e);
            if (c === d || c === LF || c === CR) break;
            e++;
          }
          if (e >= n && belirsiz) { eksik = true; break; }
          alan = trim ? text.slice(i, e).trim() : text.slice(i, e);
          i = e;
        }
        row.push(alan);
        if (i < n && text.charCodeAt(i) === d) { i++; continue; }
        break;
      }
      const kayitSonu = i;
      if (!eksik) {
        if (i < n) {   // burada yalnız CR ya da LF olabilir
          if (belirsiz && text.charCodeAt(i) === CR && i + 1 >= n) eksik = true;
          else {
            i += (text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF) ? 2 : 1;
            satir++;
          }
        } else if (belirsiz) {
          eksik = true;
        }
      }
      if (eksik) {
        st.kapanmayan = basKapanmayan;
        satir = basSatir;
        i = bas;
        break;
      }
      // Tam boy kopya: push ile büyüyen dizi 6 hücre için 16 hücrelik yer ayırır;
      // milyonlarca satırda bu, satır başına ~40 bayt boşa bellek demektir.
      rows.push(row.slice());
      st.adet++;
      if (diziKipi) { kBas.push(st.taban + bas); kSon.push(st.taban + kayitSonu); kSatir.push(basSatir); }
      else if (konumlar) records.push({ line: basSatir, start: st.taban + bas, end: st.taban + kayitSonu });
      tuketilen = i;
    }

    st.satir = satir;
    return { rows, records, starts: kBas, ends: kSon, lines: kSatir, tuketilen: son ? n : tuketilen };
  }

  /**
   * Parça parça gelen metni ayrıştırır (büyük dosyaları tek metne okumadan).
   * Aynı dosya için push(...parçalar) + end() çıktısının birleşimi parse(tüm metin)
   * ile aynıdır; tek fark AKIS_KAYIT_SINIRI'nı aşan dev kayıtlardadır.
   *
   * @param {Object} [options] - parse ile aynı: delimiter, trim, positions, maxRows.
   *   positions: 'arrays' verilirse kayıt nesneleri yerine parti.starts / ends / lines
   *   sayı dizileri döner (aynı değerler, nesne üretmeden).
   *   delimiter verilmezse ilk AYRAC_ORNEK_KARAKTER karakterden bulunur.
   * @returns {{ push(parca: string): Parti, end(): Parti, delimiter, unclosedQuotes, rowCount }}
   *   Parti: { rows, records?, text, offset } — records konumları BOM atılmış tüm
   *   metne göredir; ham kayıt metni text.slice(start - offset, end - offset).
   */
  function createParser(options) {
    const opts = options || {};
    let delimiter = opts.delimiter != null ? ayracDogrula(opts.delimiter) : null;
    const trim = !!opts.trim;
    const konumlar = opts.positions === 'arrays' ? 'dizi' : !!opts.positions;
    const sinir = opts.maxRows > 0 ? opts.maxRows : Infinity;
    const st = { satir: 1, kapanmayan: 0, adet: 0, taban: 0 };
    let tampon = '';
    let bomBakildi = false;
    let bitti = false;

    function isle(sonMu) {
      if (delimiter === null) {
        // Ayraç, tüm metinle aynı sonucu versin diye örnek dolana kadar beklenir.
        if (!sonMu && tampon.length <= AYRAC_ORNEK_KARAKTER) {
          const bos = { rows: [], text: '', offset: st.taban };
          if (konumlar === 'dizi') { bos.starts = []; bos.ends = []; bos.lines = []; }
          else if (konumlar) bos.records = [];
          return bos;
        }
        delimiter = detectDelimiter(tampon);
      }
      const r = cekirdek(tampon, delimiter.charCodeAt(0), trim, konumlar, sinir, st, sonMu, null);
      const parti = { rows: r.rows, text: tampon, offset: st.taban };
      if (konumlar === 'dizi') { parti.starts = r.starts; parti.ends = r.ends; parti.lines = r.lines; }
      else if (konumlar) parti.records = r.records;
      tampon = r.tuketilen >= tampon.length ? '' : tampon.slice(r.tuketilen);
      st.taban += r.tuketilen;
      return parti;
    }

    return {
      push(parca) {
        if (bitti) throw new Error('createParser: end() sonrasında push çağrıldı.');
        parca = parca == null ? '' : String(parca);
        if (!bomBakildi && parca.length) {
          bomBakildi = true;
          if (parca.charCodeAt(0) === 0xFEFF) parca = parca.slice(1);
        }
        tampon = tampon ? tampon + parca : parca;
        return isle(false);
      },
      end() {
        if (bitti) throw new Error('createParser: end() iki kez çağrıldı.');
        bitti = true;
        return isle(true);
      },
      get delimiter() { return delimiter; },
      get unclosedQuotes() { return st.kapanmayan; },
      get rowCount() { return st.adet; }
    };
  }

  function satirSonuSayisi(text, bas, bit) {
    const m = text.slice(bas, bit).match(/\r\n|\r|\n/g);
    return m ? m.length : 0;
  }

  /* =====================================================================
   * 3. AYRAÇ TESPİTİ
   * Ayraç, ilk ~20 kayıtta EN TUTARLI alan sayısını (>1) veren adaydır.
   * Karakter saymak yanıltıyordu: adres kolonunda virgül geçen noktalı
   * virgüllü dosyada virgül daha sık görünür ama satırları düzensiz böler.
   * Kayıtlar tırnak kuralıyla bölünür, yoksa alıntı içindeki ayraç da
   * sayılırdı. Eşitlikte sırasıyla: kapanmayan tırnağı az olan (yanlış ayraç
   * tırnakları dengesiz bırakır — tek satırlık başlıkta tek ipucu budur),
   * alan sayısı çok olan, ';' (Türkçe Excel varsayılanı), listedeki sıra.
   * ===================================================================== */

  /* Bayt → metin. UTF-16 BOM'u önce, sonra (BOM'lu ya da BOM'suz) katı UTF-8
     denenir; geçersiz UTF-8 ise Windows-1254 (Türkçe Excel'in CSV kodlaması)
     okunur. SheetJS'e CSV bayt dizisi verilirse BOM'suz UTF-8'i de 1254'ü de
     Latin-1 sanıp "Ahmet YÄ±lmaz" / "Ýzmir" üretiyordu. */
  function metinCoz(bytes) {
    let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch (e) {
      return new TextDecoder('windows-1254').decode(b);
    }
  }

  function detectDelimiter(text, candidates) {
    const adaylar = Array.isArray(candidates) && candidates.length ? candidates : DELIMITERS;
    text = text == null ? '' : String(text);
    const ornek = text.slice(0, AYRAC_ORNEK_KARAKTER);
    const kesildi = text.length > ornek.length;
    let enIyi = null, enIyiTutarlilik = -1, enIyiKapanmayan = Infinity, enIyiAlan = 0;
    for (const d of adaylar) {
      const r = parse(ornek, { delimiter: ayracDogrula(d), maxRows: AYRAC_ORNEK_SATIR });
      let satirlar = r.rows;
      // Örnek dilimin sonunda yarım kalmış satır alan sayısını bozmasın
      if (kesildi && satirlar.length < AYRAC_ORNEK_SATIR) satirlar = satirlar.slice(0, -1);
      satirlar = satirlar.filter(s => s.some(c => c.trim() !== ''));
      if (!satirlar.length) continue;
      const sayac = Object.create(null);
      let mod = 0;
      for (const s of satirlar) {
        const k = s.length;
        sayac[k] = (sayac[k] || 0) + 1;
        if (sayac[k] > (sayac[mod] || 0) || (sayac[k] === sayac[mod] && k > mod)) mod = k;
      }
      if (mod < 2) continue;
      const tutarlilik = sayac[mod] / satirlar.length;
      const u = r.unclosedQuotes;
      const dahaIyi = tutarlilik > enIyiTutarlilik || (tutarlilik === enIyiTutarlilik && (
        u < enIyiKapanmayan || (u === enIyiKapanmayan && (
          mod > enIyiAlan || (mod === enIyiAlan && d === ';' && enIyi !== ';')))));
      if (dahaIyi) {
        enIyi = d; enIyiTutarlilik = tutarlilik; enIyiKapanmayan = u; enIyiAlan = mod;
      }
    }
    // Tek kolonlu dosyada ayraç önemsizdir; Türkçe Excel varsayılanı ";"
    return enIyi || ';';
  }

  /* =====================================================================
   * 4. YAZMA
   * Ayraç, tırnak ya da satır sonu içeren alan RFC 4180'e göre tırnaklanır.
   * Yalnız \r içeren alan da tırnaklanır; yoksa okuyucu onu satır sonu sayar.
   * Tırnaklama GERÇEK çıkış ayracına göre yapılır: eskiden algılanan girdi
   * ayracına göre tırnaklanan ',' dosyasında "a;b" hücresi iki sütuna bölünüyordu.
   * ===================================================================== */

  function quoteField(v, delimiter) {
    const s = v == null ? '' : String(v);
    const d = delimiter || ';';
    return (s.indexOf(d) !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1)
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * @param {Array|null} headers - null/undefined ise başlık satırı yazılmaz
   *   (başlığı rows[0]'da taşıyan çağıranlar için).
   * @param {Array<Array>} rows
   * @param {Object} [options]
   * @param {string} [options.delimiter=';']
   * @param {boolean} [options.bom=true] - Excel Türkçe karakteri doğru açsın.
   * @param {boolean} [options.safeFormula=true] - Başlıklar dâhil guvenliHucre;
   *   "=cmd" adlı bir sütun başlığı da formül çalıştırır.
   * @param {string} [options.lineEnding='\r\n']
   * @param {boolean} [options.quoteLeadingZeros=false] - '0123' gibi baştaki
   *   sıfırlı kodları tırnaklar (workbench CSV kurtarma çıktısının davranışı).
   * @returns {string} Sonda satır sonu yoktur.
   */
  function stringify(headers, rows, options) {
    const opts = options || {};
    const d = opts.delimiter != null ? ayracDogrula(opts.delimiter) : ';';
    const safe = opts.safeFormula !== false;
    const sifirTirnakla = !!opts.quoteLeadingZeros;
    const satirSonu = opts.lineEnding != null ? String(opts.lineEnding) : '\r\n';

    function hucre(v) {
      if (safe) v = guvenliHucre(v);
      const s = v == null ? '' : String(v);
      if (sifirTirnakla && /^0\d+$/.test(s)) return '"' + s + '"';
      return quoteField(s, d);
    }
    function satirYaz(r) {
      return (r || []).map(hucre).join(d);
    }

    const satirlar = [];
    if (headers != null) satirlar.push(satirYaz(headers));
    for (const r of (rows || [])) satirlar.push(satirYaz(r));
    return (opts.bom === false ? '' : BOM) + satirlar.join(satirSonu);
  }

  return {
    BOM,
    DELIMITERS: DELIMITERS.slice(),
    guvenliHucre,
    isFormulaCell,
    quoteField,
    parse,
    createParser,
    detectDelimiter,
    metinCoz,
    stringify
  };
}));
