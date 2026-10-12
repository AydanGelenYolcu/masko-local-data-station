/* =====================================================
   DEDUP ENGINE — tekilleştirme motoru
   =====================================================
   • Excel/CSV ayrıştırma (ayraç + kodlama otomatik)
   • Sütun bazlı COUNTIF
   • Tip farkında normalizasyon (telefon/e-posta/kimlik)
   • Çoklu anahtar eşleştirme (union-find, zincirleme)
   • Sadece kopyaları listeleme

   BELLEK NOTU
   -----------
   Satırlar string dizisi olarak tutulmuyor. Ölçüldü: 300 bin satır x
   16 sütun bu şekilde 172 MB yiyordu (satır başına 600 byte, dosyadaki
   142 byte'a karşılık — 4.2 kat şişme). Sebebi her hücrenin ayrı bir
   JS string nesnesi olması ve her satırın ayrı bir Array olması.

   Onun yerine SÜTUN BAZLI SÖZLÜK KODLAMASI kullanılıyor:
     _colDict[c]  -> o sütundaki BENZERSİZ değerler (string[])
     _colCodes[c] -> her satır için sözlük indeksi (Int32Array)

   Kitle verisi çok tekrarlıdır (zaten mesele bu): şehir 81, segment 3,
   kanal 4 farklı değer alır ama milyon satırda geçer. Sözlük bunu bir
   kez saklar, satırlar 4 byte'lık tamsayıya iner.

   Yan fayda: normalizasyon satır başına değil BENZERSİZ DEĞER başına
   çalışır. 300 bin satırda 60 bin tekil e-posta varsa normalize işlemi
   5 kat az koşar.
   ===================================================== */

const createDedupEngine = () => {

  /* ---------- VERİ DEPOLAMA ---------- */
  let _headers = [];
  let _nRows   = 0;
  let _colDict  = [];
  let _colCodes = [];
  // Kullanıcının eklediği sütunlar: sütun no → tanım (tarife yazılır). Hep
  // sona eklenir; dosyadan gelen sütunların numarası değişmez.
  const _eklenen = new Map();
  /* SİLİNEN SATIRLAR VE SEBEPLERİ
     Set ve Map değil: "İlkleri Tut" 5 milyon satırda her birine 5 milyon
     girdi ekliyor ve sayfayı 8 sn donduruyordu (Chrome'da büyük Set/Map
     yavaş). Satır başına bir bayt işaret ve sebep numarası; arayüz aynı
     (has/add/delete/clear/size/dolaşma, get/set). */
  function _satirIsaretleri() {
    let bayrak = new Uint8Array(0), sebepNo = new Int32Array(0), adet = 0;
    const sebepler = [''], sebepKodu = new Map([['', 0]]);
    function hazir(i) {
      if (i < bayrak.length) return;
      const yeni = Math.max(i + 1, _nRows, bayrak.length * 2, 16);
      const b = new Uint8Array(yeni); b.set(bayrak); bayrak = b;
      const k = new Int32Array(yeni); k.set(sebepNo); sebepNo = k;
    }
    const kume = {
      has(i) { return i >= 0 && i < bayrak.length && bayrak[i] === 1; },
      add(i) { hazir(i); if (bayrak[i] !== 1) { bayrak[i] = 1; adet++; } return kume; },
      delete(i) { if (kume.has(i)) { bayrak[i] = 0; sebepNo[i] = 0; adet--; return true; } return false; },
      clear() { bayrak = new Uint8Array(0); sebepNo = new Int32Array(0); adet = 0; },
      get size() { return adet; },
      *[Symbol.iterator]() { for (let i = 0; i < bayrak.length; i++) if (bayrak[i] === 1) yield i; },
      forEach(fn) { for (const i of kume) fn(i, i, kume); }
    };
    const sebep = {
      get(i) { return i >= 0 && i < sebepNo.length && sebepNo[i] ? sebepler[sebepNo[i]] : undefined; },
      set(i, metin) {
        hazir(i);
        let k = sebepKodu.get(metin);
        if (k === undefined) { k = sebepler.length; sebepler.push(metin); sebepKodu.set(metin, k); }
        sebepNo[i] = k; return sebep;
      },
      delete(i) { if (i >= 0 && i < sebepNo.length) sebepNo[i] = 0; },
      clear() { sebepNo.fill(0); }
    };
    return { kume, sebep };
  }
  const _isaretler = _satirIsaretleri();
  const _deletedSet = _isaretler.kume;
  let _fileName = '';
  let _delimiter = '';
  let _encoding = '';

  const BOS = 0;

  /* ---------- DOSYA OKUMA ---------- */

  /**
   * Dosyayı okuyup ayrıştırır.
   * @param {File} file
   * @param {Function} onProgress  - (0-100, { satir })
   * @param {{iptalMi?: Function, parcaBayt?: number}} [secenek]
   *        iptalMi true dönerse okuma 'İPTAL' hatasıyla durur.
   * @returns {Promise<{headers: string[], rowCount: number}>}
   */
  async function parseFile(file, onProgress, secenek) {
    _fileName = file.name;
    _sifirla();

    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
      return _parseCSV(file, onProgress, ext === 'tsv' ? '\t' : null, secenek);
    }
    return _parseExcel(file, onProgress);
  }

  /* Yeni dosya = yeni sütunlar. Önceki dosyanın tip tespiti, silme
     sebepleri ve normalizasyon önbelleği temizlenmezse yeni dosyaya
     sızar (ör. 3. sütun hâlâ "telefon" sanılıp tutarlar bozulur). */
  function _sifirla() {
    _headers = []; _nRows = 0; _colDict = []; _colCodes = []; _fileLine = null;
    _eklenen.clear();
    _deletedSet.clear();
    _deleteReason.clear();
    _tipOnbellek.clear();
    _tipElle.clear();
    _normOnbellek.clear();
    _countifCache.clear();
    _markVersion = 0; _cacheVersion = -1;
    _delimiter = ''; _encoding = '';
  }

  /* GERÇEK DOSYA SATIR NUMARALARI
     -------------------------------------------------
     Ayrıştırıcı boş satırları atlar, bu yüzden "mantıksal satır no + 2"
     gerçek dosya satırını vermez. Denetim raporunda bu kayma ciddidir:
     denetçi rapordaki 1000 numaralı satırı orijinal dosyada açtığında
     BAŞKA birinin kaydını görür. Her mantıksal satır için gerçek dosya
     satır numarasını ayrıca tutuyoruz. */
  let _fileLine = null;   // Int32Array: mantıksal satır -> dosya satır no (1 tabanlı)

  function getSourceLine(rowIdx) {
    if (_fileLine && rowIdx >= 0 && rowIdx < _nRows) return _fileLine[rowIdx];
    return rowIdx + 2;   // bilinmiyorsa eski varsayım
  }

  /* METİN → KOD TABLOSU
     Chrome'un Map'i milyonlarca farklı metin anahtarında çöküyor. Ölçüldü,
     1 milyon farklı anahtar: Node'da ~1 sn, Chrome 154'te 7–25 sn; 5 milyon
     satırlık dosyanın TCKN/id sütunları okumayı dakikalara çıkarıyordu. Bu
     tablo açık adreslemeli (FNV-1a karması, doğrusal yoklama, yarı dolulukta
     iki kat büyüme) ve yuvaları Int32Array'de; aynı ölçümde Chrome'da
     0,4–0,7 sn. degerler dizisi kod → metin sözlüğünün kendisidir; tablo
     ona yalnız ekler. */
  function _metinKarmasi(s) {
    let x = -2128831035;                       // 0x811C9DC5
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x;
  }

  function _metinTablosu(degerler) {
    let kap = 16;
    while (kap < degerler.length * 2 + 16) kap *= 2;
    let maske = kap - 1;
    let yuva = new Int32Array(kap).fill(-1);  // yuva → kod (-1 boş)
    let yuvaKarma = new Int32Array(kap);
    let karmalar = new Int32Array(Math.max(16, degerler.length * 2));  // kod → karma

    function yerlestir(id, h) {
      let j = h & maske;
      while (yuva[j] !== -1) j = (j + 1) & maske;
      yuva[j] = id; yuvaKarma[j] = h;
    }
    function buyut() {
      kap *= 2; maske = kap - 1;
      yuva = new Int32Array(kap).fill(-1);
      yuvaKarma = new Int32Array(kap);
      for (let id = 0; id < degerler.length; id++) yerlestir(id, karmalar[id]);
    }
    for (let id = 0; id < degerler.length; id++) {
      karmalar[id] = _metinKarmasi(degerler[id]);
      yerlestir(id, karmalar[id]);
    }

    return {
      /** Metnin kodunu döner; yoksa degerler'in sonuna ekler. kopyala verilirse
          yalnız yeni eklenen metne uygulanır. */
      kod(s, kopyala) {
        const h = _metinKarmasi(s);
        let j = h & maske;
        for (;;) {
          const id = yuva[j];
          if (id === -1) break;
          if (yuvaKarma[j] === h && degerler[id] === s) return id;
          j = (j + 1) & maske;
        }
        const yeni = degerler.length;
        degerler.push(kopyala ? kopyala(s) : s);
        if (yeni >= karmalar.length) {
          const k = new Int32Array(karmalar.length * 2); k.set(karmalar); karmalar = k;
        }
        karmalar[yeni] = h;
        yuva[j] = yeni; yuvaKarma[j] = h;
        if (degerler.length * 2 > kap) buyut();
        return yeni;
      }
    };
  }

  // Dilimden kesilen uzun metin (V8'de 13+ karakter) bütün dilimi bellekte
  // tutar; sözlüğe girecek değer bağımsız bir kopyaya çevrilir.
  function _bagimsizKopya(s) { return s.length >= 13 ? (' ' + s).slice(1) : s; }

  /* Sütun yazıcısı: değeri sözlüğe koyar, kodunu döner. Akışlı okumada satır
     sayısı baştan bilinmez; kapasite yetmezse diziler büyütülür, sonda
     gereğinden çok boş yer kaldıysa kırpılır. */
  function _sozlukYazici(sutunSayisi, satirKapasitesi) {
    const dict = [], map = [], codes = [];
    let kapasite = Math.max(1, satirKapasitesi);
    for (let c = 0; c < sutunSayisi; c++) {
      dict.push(['']);                       // 0 = boş
      map.push(_metinTablosu(dict[c]));
      codes.push(new Int32Array(kapasite));
    }
    return {
      dict, codes,
      get kapasite() { return kapasite; },
      yaz(c, satir, deger) {
        codes[c][satir] = map[c].kod(deger, _bagimsizKopya);
      },
      buyut(enAz) {
        const yeni = Math.max(enAz, Math.ceil(kapasite * 1.5));
        for (let c = 0; c < codes.length; c++) {
          const d = new Int32Array(yeni); d.set(codes[c]); codes[c] = d;
        }
        kapasite = yeni;
      },
      bitir(satirSayisi) {
        map.length = 0;                      // Map'leri bırak, sözlükler kalsın
        if (satirSayisi !== undefined && kapasite > satirSayisi * 1.1 + 1024) {
          for (let c = 0; c < codes.length; c++) codes[c] = codes[c].slice(0, satirSayisi);
          kapasite = satirSayisi;
        }
      }
    };
  }

  /* AKIŞLI OKUMA AYARLARI
     Dosya PARCA_BAYT'lık dilimlerle okunur; iş DILIM_MS'yi aşınca sayfaya
     nefes aldırılır. Eskiden 289 MB / 5 milyon satırlık CSV tek metne
     (~580 MB) okunup ana iş parçacığında ara vermeden ayrıştırılıyordu;
     sekme dakikalarca donuyordu. */
  const PARCA_BAYT = 4 * 1024 * 1024;
  const DILIM_MS = 25;
  const IPTAL = 'İPTAL';
  /* Nefes MessageChannel iletisiyle alınır: Chrome'da setTimeout(0) iç içe
     çağrıda en az 4 ms'ye, yoğunken ölçüldüğü üzere ~48 ms'ye çıkıyor ve
     arka plan sekmesinde saniyede bire kısılıyordu; 5 milyon satır dört
     dakikayı aşıyordu. İletiler zamanlayıcı kısıtına girmez; aralarında
     tarayıcı yine çizim ve girdi işler. Olmayan ortamda (testler) setTimeout. */
  let _kanal = null;
  const _bekleyenler = [];
  function _nefesAl() {
    if (typeof MessageChannel !== 'function') return new Promise(r => setTimeout(r, 0));
    if (!_kanal) {
      _kanal = new MessageChannel();
      _kanal.port1.onmessage = () => { const r = _bekleyenler.shift(); if (r) r(); };
      if (_kanal.port1.unref) _kanal.port1.unref();   // Node'da süreci açık tutmasın
    }
    return new Promise(r => { _bekleyenler.push(r); _kanal.port2.postMessage(0); });
  }
  function _iptalKontrol(secenek) {
    if (secenek && secenek.iptalMi && secenek.iptalMi()) throw new Error(IPTAL);
  }

  /* Ayraç tespiti, CSV yazımı ve formül koruması csv-io.js'te tek yerde
     tutulur (tablo, tezgâh ve bölme modülleriyle aynı kural); sayfa onu bu
     dosyadan önce yükler. Akışlı kayıt ayırıcı (_csvAkisOku) ve satır
     ayırıcı (_parseCSVLine) burada kalır: ikisi birlikte sözlük kodlamalı
     okumayı besler ve tırnak kuralları birbirine bağlıdır. */
  function _csvIO() {
    if (typeof CsvIO !== 'undefined') return CsvIO;
    throw new Error('csv-io.js yüklenmedi; CSV okunamaz/yazılamaz.');
  }

  /* Kodlama kuralı eskisiyle aynı: metin UTF-8 çözülür; bozuk karakter
     (U+FFFD) sayısı metin uzunluğunun 1/5000'ini aşarsa dosya Türkçe Excel'in
     klasik windows-1254 çıktısıdır ve o kodlamayla baştan okunur (ana
     projedeki table-engine.js ile aynı yaklaşım). BOM'lu dosya her zaman
     UTF-8'dir; FileReader da BOM'a bakıp öyle okuyordu. */
  async function _parseCSV(file, onProgress, delim, secenek) {
    if (!file.size) throw new Error('Dosya boş');
    const bas = new Uint8Array(await file.slice(0, 3).arrayBuffer());
    const bomlu = bas.length === 3 && bas[0] === 0xEF && bas[1] === 0xBB && bas[2] === 0xBF;

    let kodlama = 'utf-8';
    let sonuc = await _csvAkisOku(file, kodlama, !bomlu, onProgress, delim, secenek);
    if (sonuc === null) {
      kodlama = 'windows-1254';
      sonuc = await _csvAkisOku(file, kodlama, false, onProgress, delim, secenek);
    }

    _encoding = kodlama;
    _delimiter = sonuc.ayrac;
    _headers = sonuc.basliklar;
    _colDict = sonuc.dict;
    _colCodes = sonuc.codes;
    _fileLine = sonuc.satirNo;
    _nRows = sonuc.n;

    if (onProgress) onProgress(100, { satir: _nRows });
    return { headers: _headers.slice(), rowCount: _nRows };
  }

  /* Dosyayı dilim dilim okuyup kayıtlara ayırır ve sözlüğe yazar.
     Kayıt kuralı eski tam metin tarayıcısıyla birebir aynıdır: tırnak her
     yerde açar/kapatır, tırnak içinde "" kaçıştır; tırnak dışındaki \r, \n
     ve \r\n kaydı bitirir; satır numarası her satır sonunda artar. Dilim
     sınırına düşen belirsiz karakter (tırnak içindeyken sondaki ", sondaki
     \r) bir sonraki dilimin ilk karakterine bakılarak çözülür. Her karakter
     bir kez taranır; dilimlere yayılan kayıt yalnız bittiğinde birleştirilir.
     bozukSay doğruysa ve dosya windows-1254 çıkarsa null döner. */
  async function _csvAkisOku(file, kodlama, bozukSay, onProgress, delim, secenek) {
    const parcaBayt = (secenek && secenek.parcaBayt) || PARCA_BAYT;
    const boyut = file.size;
    const cozucu = new TextDecoder(kodlama);
    let konum = 0, metinUzunlugu = 0, bozuk = 0;
    let dilimBasi = Date.now();

    // Başlık: ilk dolu kayıt; "sep=;" satırıysa hemen sonraki kayıt (boş olsa da).
    let durum = 'ilk';
    let separator = delim, ayrac = '', basliklar = [], m = 0;
    let yazici = null, satirNo = null, n = 0, kapasiteTahmini = 1024;

    // Kayıt ayırıcının dilimler arası durumu
    let quoted = false, line = 1, startLine = 1;
    let parcalar = [];
    let bekleyenTirnak = false;             // tırnak içindeyken dilim " ile bitti
    let crSonu = false, crTirnakta = false; // dilim \r ile bitti
    let sayac = 0;

    async function nefes() {
      if (Date.now() - dilimBasi < DILIM_MS) return;
      _iptalKontrol(secenek);
      if (onProgress) onProgress(Math.min(99, Math.round(konum / boyut * 100)), { satir: n });
      await _nefesAl();
      dilimBasi = Date.now();
    }

    function baslikKur(text) {
      // Ayraç başlığın alan sayısından bulunur. Türkiye'de Excel'in ürettiği
      // CSV neredeyse her zaman ';' ayraçlı — ',' varsaymak tüm dosyayı tek
      // sütuna sıkıştırır ve hiçbir tekrar bulunamaz.
      ayrac = separator || _csvIO().detectDelimiter(text);
      basliklar = _parseCSVLine(text, ayrac).map(h => h.trim());
      m = basliklar.length;
      if (!m) throw new Error('Başlık satırı okunamadı');
      yazici = _sozlukYazici(m, kapasiteTahmini);
      satirNo = new Int32Array(yazici.kapasite);
      durum = 'veri';
    }

    function kayit(text, satir) {
      if (durum === 'veri') {
        if (!text.trim()) return;
        const cells = _parseCSVLine(text, ayrac);
        if (cells.length > m) throw new Error(`Dosya satırı ${satir}: başlıkta ${m}, kayıtta ${cells.length} sütun var. Ayracı ve tırnakları kontrol edin.`);
        if (n >= yazici.kapasite) {
          yazici.buyut(n + 1);
          const yeni = new Int32Array(yazici.kapasite); yeni.set(satirNo); satirNo = yeni;
        }
        let doluMu = false;
        for (let c = 0; c < m; c++) {
          const v = c < cells.length ? cells[c] : '';
          if (v) doluMu = true;
          yazici.yaz(c, n, v);
        }
        if (doluMu) { satirNo[n] = satir; n++; }
      } else if (durum === 'ilk') {
        if (!text.trim()) return;
        const sepHint = /^sep=([;,\t|])$/i.exec(text.trim());
        if (sepHint) { separator = separator || sepHint[1]; durum = 'sepSonrasi'; return; }
        baslikKur(text);
      } else {
        baslikKur(text);
      }
    }

    async function dilimTara(s, son) {
      const L = s.length;
      let i = 0, start = 0;
      if (bekleyenTirnak) {
        if (L) {
          bekleyenTirnak = false;
          if (s.charCodeAt(0) === 34) i = 1;     // "" kaçışı: tırnak içinde kalınır
          else quoted = false;                    // kapanış tırnağıydı
        } else if (son) { bekleyenTirnak = false; quoted = false; }
      }
      if (crSonu && (L || son)) {
        crSonu = false;
        if (L && s.charCodeAt(0) === 10) {        // \r\n tek satır sonu
          i = 1;
          if (!crTirnakta) start = 1;             // kayıt \r'de bitti; \n atılır
        }
      }
      for (; i < L; i++) {
        const ch = s.charCodeAt(i);
        if (ch === 34) {
          if (!quoted) quoted = true;
          else if (i + 1 < L) { if (s.charCodeAt(i + 1) === 34) i++; else quoted = false; }
          else if (son) quoted = false;
          else bekleyenTirnak = true;
        } else if (ch === 13 || ch === 10) {
          const end = i;
          let crBekle = false;
          if (ch === 13) {
            if (i + 1 < L) { if (s.charCodeAt(i + 1) === 10) i++; }
            else if (!son) crBekle = true;
          }
          if (!quoted) {
            const parca = s.slice(start, end);
            kayit(parcalar.length ? parcalar.join('') + parca : parca, startLine);
            parcalar = [];
            start = i + 1;
            startLine = line + 1;
          }
          line++;
          if (crBekle) { crSonu = true; crTirnakta = quoted; }
          if ((++sayac & 1023) === 0) await nefes();
        }
      }
      if (start < L) parcalar.push(start ? s.slice(start) : s);
    }

    while (konum < boyut) {
      _iptalKontrol(secenek);
      const bayt = new Uint8Array(await file.slice(konum, konum + parcaBayt).arrayBuffer());
      if (!bayt.length) break;
      const ilk = konum === 0;
      konum += bayt.length;
      const metin = cozucu.decode(bayt, { stream: true });
      metinUzunlugu += metin.length;
      if (bozukSay) {
        for (let k = metin.indexOf('�'); k !== -1; k = metin.indexOf('�', k + 1)) bozuk++;
        // Metin uzunluğu bayt sayısını aşamaz; bu eşik aşıldıysa sonuç kesindir.
        if (bozuk > boyut / 5000) return null;
      }
      if (ilk) {
        // Satır sayısı ilk dilimden tahmin edilir; yetmezse diziler büyür.
        let satirSonu = 0;
        for (let k = metin.indexOf('\n'); k !== -1; k = metin.indexOf('\n', k + 1)) satirSonu++;
        kapasiteTahmini = Math.ceil(boyut / bayt.length * (satirSonu + 1) * 1.05) + 16;
      }
      await dilimTara(metin, false);
      await nefes();
    }
    const kuyruk = cozucu.decode();
    metinUzunlugu += kuyruk.length;
    if (bozukSay) {
      for (let k = kuyruk.indexOf('�'); k !== -1; k = kuyruk.indexOf('�', k + 1)) bozuk++;
      if (bozuk > 0 && bozuk > metinUzunlugu / 5000) return null;
    }
    await dilimTara(kuyruk, true);

    if (!metinUzunlugu) throw new Error('Dosya boş');
    if (quoted) throw new Error(`Dosya satırı ${startLine}: kapanmamış çift tırnak.`);
    if (parcalar.length) {
      const kalan = parcalar.join('');
      parcalar = [];
      if (kalan.length) kayit(kalan, startLine);
    }
    if (durum !== 'veri') throw new Error('Başlık satırı okunamadı');

    yazici.bitir(n);
    if (satirNo.length > n * 1.1 + 1024) satirNo = satirNo.slice(0, n);
    return { ayrac, basliklar, dict: yazici.dict, codes: yazici.codes, satirNo, n };
  }

  /* Ayrıştırıcıya tam kayıt gelir; hücre içindeki satır sonları korunur.
     Tırnaksız kayıt (büyük dosyaların çoğu) yerleşik split ile ayrılır;
     tırnak yoksa aşağıdaki döngüyle birebir aynı sonucu verir. */
  function _parseCSVLine(line, delim) {
    if (line.indexOf('"') === -1) return line.split(delim);
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
          else inQuotes = false;
        } else current += ch;
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === delim) { result.push(current); current = ''; }
        else current += ch;
      }
    }
    result.push(current);
    return result;
  }

  function _parseExcel(file, onProgress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          if (onProgress) onProgress(30);
          const data = new Uint8Array(e.target.result);
          const wb = XLSX.read(data, { type: 'array', cellText: true, cellDates: true });
          if (onProgress) onProgress(60);

          const sheet = wb.Sheets[wb.SheetNames[0]];
          const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: true });
          if (!json.length) { reject(new Error('Sayfa boş')); return; }

          _headers = json[0].map(h => String(h || '').trim());
          const m = _headers.length;
          const yazici = _sozlukYazici(m, json.length);
          const satirNo = new Int32Array(json.length);
          let n = 0;
          for (let i = 1; i < json.length; i++) {
            const raw = json[i];
            if (!raw) continue;
            let doluMu = false;
            for (let c = 0; c < m; c++) {
              const v = raw[c] == null ? '' : String(raw[c]).trim();
              if (v) doluMu = true;
              yazici.yaz(c, n, v);
            }
            // json indeksi 0 tabanlı, Excel satırı 1 tabanlı
            if (doluMu) { satirNo[n] = i + 1; n++; }
          }
          yazici.bitir();
          _colDict = yazici.dict;
          _colCodes = yazici.codes;
          _fileLine = satirNo;
          _nRows = n;
          _encoding = 'xlsx';
          _delimiter = '';

          if (onProgress) onProgress(100);
          resolve({ headers: _headers.slice(), rowCount: _nRows });
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }

  /* =====================================================
     DEĞER NORMALİZASYONU — tip farkında
     =====================================================
     Düz trim+lowercase yetmiyor: "0532 111 22 33" ile
     "+905321112233" aynı kişidir ama farklı metindir.
     ===================================================== */

  // Excel/Outlook kopyala-yapıştır bunları bırakır ve GÖZLE GÖRÜNMEZ.
  // trim() temizlemez (boşluk sayılmazlar), eşleşme sessizce bozulur.
  // 00AD yumusak tire, 200B/200C/200D sifir genislikli, 2060 word joiner, FEFF BOM
  const INVISIBLE_CODES = [0x00AD, 0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF];
  const INVISIBLE_RE = new RegExp(
    '[' + INVISIBLE_CODES.map(c => String.fromCharCode(c)).join('') + ']', 'g');

  // Kimlik yerine geçtiği sanılan doldurma değerleri. Bunlar kimlik SAYILMAZ,
  // yoksa "test@test.com" yazan iki farklı kişi tek kişiye iner.
  /* Set değil: Chrome 154'te tam sayıya benzeyen metinle ("1", "250") Set
     araması ölçüldüğü üzere ~50 kat yavaş; 1 milyon satırlık id sütununda
     9,3 sn. Uzunluğa göre gruplanmış kısa listelerde düz karşılaştırma aynı
     sonucu karma hesabı yapmadan verir. */
  const JUNK_LISTE = [
    'test@test.com', 'test@test.com.tr', 'a@a.com', 'aa@aa.com', 'aaa@aaa.com',
    'x@x.com', 'yok@yok.com', 'mail@mail.com', 'noreply@noreply.com',
    'no-reply@no-reply.com', 'null', 'na', 'n/a', 'nan', 'none', 'undefined',
    '-', '.', 'bilinmiyor', 'yok', 'bos', 'boş', 'bilgi yok', '0'
  ];
  const JUNK_BOYA = [];                        // uzunluk → o uzunluktaki değerler
  for (const j of JUNK_LISTE) (JUNK_BOYA[j.length] || (JUNK_BOYA[j.length] = [])).push(j);
  function _copMu(s) {
    const aday = JUNK_BOYA[s.length];
    return aday !== undefined && aday.indexOf(s) !== -1;
  }

  function _clean(val) {
    if (val == null) return '';
    let s = String(val);
    // Hızlı yol: yalnız görünür ASCII (0x21–0x7E) ve tırnakla başlamayan
    // değerde aşağıdaki hiçbir adım bir şey değiştirmez (TCKN, id, tutar…).
    // Milyonlarca benzersiz değerde üç düzenli ifadeden kurtarır.
    let duz = s.length > 0 && s.charCodeAt(0) !== 39 && s.charCodeAt(0) !== 34;
    for (let i = 0; duz && i < s.length; i++) {
      const k = s.charCodeAt(i);
      if (k < 0x21 || k > 0x7E) duz = false;
    }
    if (duz) return s;
    s = s.replace(INVISIBLE_RE, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (s && (s.charCodeAt(0) === 39 || s.charCodeAt(0) === 34)) {
      s = s.replace(/^['"]+/, '').trim();     // Excel'in eklediği '05321234567
    }
    return s;
  }

  /* TÜRKÇE / AKSANLI HARF KATLAMA
     ------------------------------------------------------
     JS'te "İstanbul".toLowerCase() -> "i̇stanbul" olur: noktalı İ,
     i + BİRLEŞEN NOKTA (U+0307) şeklinde açılır ve "istanbul" ile
     ESLESMEZ. Gözle aynı görünen iki değer eşleşmediği için kopya
     bulunamaz ve sebebi ekranda görünmez.

     NFKD ile ayrıştırıp birleşen işaretleri atıyoruz:
       İ -> I + U+0307 -> I     Ş -> S + cedilla -> S
       ğ -> g                   ü -> u    ö -> o    ç -> c
     Noktasız ı'nın ayrıştırması yok, elle eşliyoruz.
     Yan fayda: café = cafe gibi aksanlı yazımlar da eşleşir. */
  // U+0300 - U+036F : birlesen aksan isaretleri (combining diacritical marks)
  const BIRLESEN_ISARET = new RegExp(
    '[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036F) + ']', 'g');

  function _asciiFold(s) {
    return s.normalize('NFKD')
            .replace(BIRLESEN_ISARET, '')
            .replace(/ı/g, 'i').replace(/İ/g, 'I');
  }

  function _normText(val) {
    const s = _asciiFold(_clean(val)).toLowerCase();
    return _copMu(s) ? '' : s;
  }

  function _normEmail(val) {
    let s = _clean(val).replace(/\s/g, '').toLowerCase();
    if (!s) return '';
    if (s.startsWith('mailto:')) s = s.slice(7);
    s = s.replace(/^\.+|\.+$/g, '');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(s)) return '';
    return _copMu(s) ? '' : s;
  }

  /* Son 10 hane: 0 / 90 / 0090 / +90 ön eklerinin hepsini çözer. */
  function _normPhone(val) {
    let s = _clean(val);
    if (!s) return '';
    // Excel telefonu sayı sanıp "9.05321E+11" yapmışsa basamaklar GERİ
    // GELMEZ — 9.05321E+11 hem 905321112233 hem 905321998877 olabilir.
    // Buradan 10 hane üretmek var olmayan bir numara uydurmaktır ve
    // başkasının gerçek numarasıyla çakışabilir. Geçersiz sayıyoruz.
    if (/\d[eE][+-]?\d/.test(s)) return '';
    let d = s.replace(/\D/g, '');
    if (!d) return '';
    if (d.length > 10) d = d.slice(-10);
    if (d.length !== 10) return '';
    if (/^(\d)\1{9}$/.test(d)) return '';      // 0000000000, 5555555555
    if (d.charAt(0) === '0') return '';        // 10 hanenin başı 0 olamaz
    return d;
  }

  function _normId(val) {
    let s = _clean(val).replace(/\s/g, '').toUpperCase();
    if (!s) return '';
    if (_copMu(s.toLowerCase())) return '';
    if (s.length >= 4 && /^(.)\1+$/.test(s)) return '';
    return s;
  }

  function _normName(val) {
    let s = _clean(val);
    if (!s) return '';
    // Yalnızca 12 Türkçe harfi elle eşlemek şapkalı harfleri (â î û) ve
    // aksanlı yabancı adları atıyordu: "Kâzım" -> "KZIM", "Kazım" ile eşleşmiyordu.
    s = _asciiFold(s).toUpperCase();
    s = s.replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    return s.length < 3 ? '' : s;
  }

  /**
   * Değeri verilen tipe göre normalize eder.
   * @param {*} val
   * @param {'text'|'email'|'phone'|'id'|'name'} type
   */
  function normalizeAs(val, type, options) {
    if (options && options.mode === 'exact') return _clean(val);
    let normalized;
    switch (type) {
      case 'email': normalized = _normEmail(val); break;
      case 'phone': normalized = _normPhone(val); break;
      case 'id':    normalized = _normId(val); break;
      case 'name':  normalized = _normName(val); break;
      default:      normalized = _normText(val);
    }
    const mode = options && options.mode;
    if (!normalized || !mode || mode === 'normalized') return normalized;
    const clean = _clean(val);
    if (mode === 'exact') return clean;
    if (mode !== 'case') return normalized;
    if (type === 'phone') return normalized;
    if (type === 'id') return clean.replace(/\s/g, '');
    if (type === 'email') {
      let email = clean.replace(/\s/g, '');
      if (/^mailto:/i.test(email)) email = email.slice(7);
      return email.replace(/^\.+|\.+$/g, '');
    }
    if (type === 'name') return _asciiFold(clean).replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    return _asciiFold(clean);
  }

  /* Eski API — davranış aynı, artık görünmez karakterleri de temizliyor. */
  function normalizeValue(val) { return _normText(val); }

  /* ---------- SÜTUN TİPİ TESPİTİ ---------- */

  const _tipOnbellek = new Map();
  const _tipElle     = new Map();

  // normalizeAs'in tanıdığı tipler — dışarıdan (tarif dosyası) gelen tip bu kümeyle sınırlanır
  const SUTUN_TIPLERI = new Set(['text', 'email', 'phone', 'id', 'name']);

  const BASLIK_KALIP = [
    ['email', /mail|eposta|e-posta|e_posta/],
    ['phone', /\btel\b|telefon|gsm|cep|phone|mobil/],
    ['id',    /tckn|tc_kimlik|kimlik_no|vkn|vergi_no|musteri_no|müşteri|customer|cust_id|sicil|abone|kart_no|passolig|kombine/],
    ['id',    /^(aid|bid|cid|mid|uid|id)$|_id$/],
    ['name',  /ad_soyad|adsoyad|ad soyad|isim|fullname|full_name/]
  ];

  /**
   * Sütunun tipini tahmin eder. Önce başlık adına bakar.
   * Değere bakarak tahmin SADECE e-posta için yapılır — çünkü 11 haneli bir
   * TCKN, son 10 hanesi alındığında geçerli bir telefona benziyor. Telefon
   * tahminini değerden yapmak TCKN sütununu sessizce bozardı.
   */
  function detectColumnType(colIndex) {
    if (_tipElle.has(colIndex)) return _tipElle.get(colIndex);
    if (_tipOnbellek.has(colIndex)) return _tipOnbellek.get(colIndex);

    const ad = String(_headers[colIndex] || '').toLowerCase();
    let tip = null;
    for (const [t, re] of BASLIK_KALIP) if (re.test(ad)) { tip = t; break; }

    if (!tip) {
      // Sözlük üzerinden bak: satır değil, benzersiz değer sayısı kadar iş
      const d = _colDict[colIndex] || [];
      let bakilan = 0, epostaGibi = 0;
      for (let i = 1; i < d.length && bakilan < 200; i++) {
        const v = d[i]; if (!v) continue;
        bakilan++;
        if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) epostaGibi++;
      }
      if (bakilan >= 5 && epostaGibi / bakilan >= 0.8) tip = 'email';
    }

    tip = tip || 'text';
    _tipOnbellek.set(colIndex, tip);
    return tip;
  }

  function setColumnType(colIndex, type) {
    if (type && !SUTUN_TIPLERI.has(type)) throw new Error('Bilinmeyen sütun tipi.');
    if (type) _tipElle.set(colIndex, type); else _tipElle.delete(colIndex);
    _tipOnbellek.delete(colIndex);
    for (const k of [..._normOnbellek.keys()]) {
      if (k.indexOf(colIndex + '|') === 0) _normOnbellek.delete(k);
    }
    // countif/countSummary önbelleği de düşmeli: tip değiştiyse o sütunun
    // kopya grupları da değişir. Yoksa arayüz eski tipe göre hesaplanmış
    // sonucu göstermeye devam eder ve tip değişimi hiç işe yaramamış görünür.
    _countifCache.clear();
    _cacheVersion = -1;
  }
  function getColumnType(colIndex) { return detectColumnType(colIndex); }

  /* ---------- SÜTUN NORMALİZASYON HARİTASI ----------
     Normalizasyon SATIR başına değil BENZERSİZ DEĞER başına çalışır.
     300 bin satırda 60 bin tekil e-posta varsa 5 kat az iş.
     Sonuç önbelleğe alınır; countif ve kümeleme aynı haritayı paylaşır.

     codeToNorm[sözlükKodu] = normId  (-1 = geçersiz/boş, kimlik değil)
     normValues[normId]     = normalize edilmiş metin
  */
  const _normOnbellek = new Map();

  /* Hesabın kendisi adım adım ilerler: her 4096 değerde bir durur. Eşzamanlı
     çağrı (_colNorm) bunu sonuna kadar koşturur; yükleme sırasındaki hazırlık
     (hazirla) arada sayfaya nefes aldırır. 5 milyon benzersiz TCKN'lik bir
     sütunda bu iş saniyeler sürer. */
  function* _colNormAdimlari(colIndex, tip) {
    const d = _colDict[colIndex] || [''];
    const codeToNorm = new Int32Array(d.length).fill(-1);
    const normValues = [];
    const harita = _metinTablosu(normValues);   // Map değil: bkz. METİN → KOD TABLOSU

    for (let code = 0; code < d.length; code++) {
      if ((code & 4095) === 4095) yield;
      const nv = normalizeAs(d[code], tip);
      if (!nv) continue;                       // boş veya geçersiz -> kimlik değil
      codeToNorm[code] = harita.kod(nv);
    }

    return { codeToNorm, normValues };
  }

  function _colNorm(colIndex, tip) {
    const anahtar = colIndex + '|' + tip;
    const hazir = _normOnbellek.get(anahtar);
    if (hazir) return hazir;

    const adimlar = _colNormAdimlari(colIndex, tip);
    let r = adimlar.next();
    while (!r.done) r = adimlar.next();
    _normOnbellek.set(anahtar, r.value);
    return r.value;
  }

  /**
   * Satır araması. Eşleşme her sütunun BENZERSİZ değerleri için bir kez
   * hesaplanır, satırlar yalnız kodla taranır: 5 milyon satır × 6 sütunda
   * hücre hücre aramak 114 sn sürüyordu. Kural arayüzdekiyle aynı: büyük/küçük
   * harf duyarsızsa iki taraf da Türkçe küçük harfe çevrilip includes.
   * @param {number[]} sutunlar
   * @param {string} aranan - duyarsızsa zaten küçük harfe çevrilmiş
   * @param {boolean} duyarli
   * @param {Int32Array|number[]|null} adaylar - yalnız bu satırlarda ara
   * @param {{iptalMi?: Function}} [secenek]
   * @returns {Promise<Int32Array>} eşleşen satır indeksleri
   */
  /* Türkçe küçük harf; büyük harf içermeyen ASCII metin (rakam, tutar, küçük
     harfli e-posta) zaten küçük harftir, pahalı yerel çeviriye girmez. */
  function _kucukHarf(v) {
    for (let i = 0; i < v.length; i++) {
      const k = v.charCodeAt(i);
      if (k > 0x7E || (k >= 65 && k <= 90)) return v.toLocaleLowerCase('tr-TR');
    }
    return v;
  }

  async function araSatirlar(sutunlar, aranan, duyarli, adaylar, secenek) {
    let dilimBasi = Date.now();
    const nefes = async () => {
      if (Date.now() - dilimBasi < DILIM_MS) return;
      _iptalKontrol(secenek);
      await _nefesAl();
      dilimBasi = Date.now();
    };
    const eslesir = [];
    for (const c of sutunlar) {
      const d = _colDict[c] || [''];
      const e = new Uint8Array(d.length);
      for (let k = 0; k < d.length; k++) {
        const v = d[k];
        if ((duyarli ? v : _kucukHarf(v)).includes(aranan)) e[k] = 1;
        if ((k & 4095) === 4095) await nefes();
      }
      eslesir.push(e);
    }
    const kodlar = sutunlar.map(c => _colCodes[c]);
    const toplam = adaylar ? adaylar.length : _nRows;
    const bulunan = new Int32Array(toplam);
    let n = 0;
    for (let p = 0; p < toplam; p++) {
      const i = adaylar ? adaylar[p] : p;
      for (let s = 0; s < kodlar.length; s++) {
        if (eslesir[s][kodlar[s][i]] === 1) { bulunan[n++] = i; break; }
      }
      if ((p & 65535) === 65535) await nefes();
    }
    return bulunan.slice(0, n);
  }

  /**
   * Yüklemeden sonra her sütunun normalizasyonunu ve kopya özetini parça
   * parça hazırlar; ardından allColumnStats ve countSummary önbellekten gelir.
   * Hazırlanmasa da her şey çalışır, yalnız ilk istatistik çağrısı büyük
   * dosyada sayfayı saniyelerce bloklar.
   * @param {Function} [onProgress] - (0-100, { sutun, toplam })
   * @param {{iptalMi?: Function}} [secenek]
   */
  async function _sutunuHazirla(c, secenek) {
    let dilimBasi = Date.now();
    _iptalKontrol(secenek);
    const tip = detectColumnType(c);
    const anahtar = c + '|' + tip;
    if (!_normOnbellek.has(anahtar)) {
      const adimlar = _colNormAdimlari(c, tip);
      let r = adimlar.next();
      while (!r.done) {
        if (Date.now() - dilimBasi >= DILIM_MS) {
          _iptalKontrol(secenek);
          await _nefesAl();
          dilimBasi = Date.now();
        }
        r = adimlar.next();
      }
      _normOnbellek.set(anahtar, r.value);
    }
    countSummary(c, tip);
  }

  async function hazirla(onProgress, secenek) {
    const toplam = _headers.length;
    for (let c = 0; c < toplam; c++) {
      await _sutunuHazirla(c, secenek);
      if (onProgress) onProgress(Math.round((c + 1) / toplam * 100), { sutun: c + 1, toplam });
      await _nefesAl();
    }
  }

  /* ---------- COUNTIF ANALİZİ ---------- */

  /**
   * Belirtilen sütundaki COUNTIF sonucunu döner.
   * @param {number} colIndex
   * @param {string} [type] - verilmezse sütundan tespit edilir
   */
  /* countif ÖNBELLEĞİ
     -------------------------------------------------
     Arayüz tek bir tıklamada aynı sütunun countif'ini defalarca
     istiyor: tabloyu çiz, analiz panelini tazele, sekme sayılarını
     güncelle, butonları etkinleştir... Ölçüldü: 50 bin satırda her
     çağrı 17 ms ve tek tıklamada bir düzine kez çağrılıyordu.

     Sonuç işaretleme durumuna bağlı, o yüzden her işaretleme
     değişiminde sürüm artıyor ve önbellek düşüyor. */
  let _markVersion = 0;
  let _cacheVersion = -1;
  const _countifCache = new Map();

  function _isaretDegisti() { _markVersion++; }

  function countif(colIndex, type) {
    const tip = type || detectColumnType(colIndex);

    if (_cacheVersion !== _markVersion) { _countifCache.clear(); _cacheVersion = _markVersion; }
    const ck = colIndex + '|' + tip;
    const hazir = _countifCache.get(ck);
    if (hazir) return hazir;

    const sonuc = _countifHesapla(colIndex, tip);
    _countifCache.set(ck, sonuc);
    return sonuc;
  }

  function _countifHesapla(colIndex, tip) {
    const { codeToNorm, normValues } = _colNorm(colIndex, tip);
    const codes = _colCodes[colIndex];
    const sayim = new Int32Array(normValues.length);

    for (let i = 0; i < _nRows; i++) {
      if (_deletedSet.has(i)) continue;
      const nid = codeToNorm[codes[i]];
      if (nid < 0) continue;
      sayim[nid]++;
    }

    let unique = 0, dupValueCount = 0, dupRowCount = 0;
    for (let id = 0; id < sayim.length; id++) {
      if (sayim[id] > 0) unique++;
      if (sayim[id] > 1) { dupValueCount++; dupRowCount += sayim[id]; }
    }

    // Satır indekslerini SADECE kopya gruplar için topluyoruz. Tek geçen
    // değerler için dizi ayırmak, 1 milyon satırda 1 milyon boş dizi demek.
    const dupGroups = new Map();
    if (dupValueCount) {
      const hedef = new Int32Array(sayim.length).fill(-1);
      const diziler = [];
      for (let id = 0; id < sayim.length; id++) {
        if (sayim[id] > 1) { hedef[id] = diziler.length; diziler.push([]); }
      }
      for (let i = 0; i < _nRows; i++) {
        if (_deletedSet.has(i)) continue;
        const nid = codeToNorm[codes[i]];
        if (nid < 0) continue;
        const h = hedef[nid];
        if (h >= 0) diziler[h].push(i);
      }
      for (let id = 0; id < sayim.length; id++) {
        const h = hedef[id];
        if (h >= 0) dupGroups.set(normValues[id], diziler[h]);
      }
    }

    return {
      total: _nRows - _deletedSet.size,
      unique,
      dupValueCount,
      dupRowCount,
      dupGroups,
      // Tüm gruplar pahalıdır; isteyen olursa üretilir.
      get groups() {
        const g = new Map();
        for (let i = 0; i < _nRows; i++) {
          if (_deletedSet.has(i)) continue;
          const nid = codeToNorm[codes[i]];
          if (nid < 0) continue;
          const v = normValues[nid];
          let a = g.get(v); if (!a) { a = []; g.set(v, a); }
          a.push(i);
        }
        return g;
      }
    };
  }

  /* HAFİF ÖZET — sadece sayılar, satır indeksi dizileri kurulmaz.
     countif'in pahalı kısmı her kopya grup için dizi ayırmasıdır
     (50 bin satırda 10 bin dizi). "Bu sütunda kopya var mı?" veya
     sekme üstündeki sayı için o dizilere hiç gerek yok. */
  function countSummary(colIndex, type) {
    const tip = type || detectColumnType(colIndex);
    if (_cacheVersion !== _markVersion) { _countifCache.clear(); _cacheVersion = _markVersion; }
    const ck = 'ozet|' + colIndex + '|' + tip;
    const hazir = _countifCache.get(ck);
    if (hazir) return hazir;

    const { codeToNorm, normValues } = _colNorm(colIndex, tip);
    const codes = _colCodes[colIndex];
    const sayim = new Int32Array(normValues.length);
    for (let i = 0; i < _nRows; i++) {
      if (_deletedSet.has(i)) continue;
      const nid = codeToNorm[codes[i]];
      if (nid >= 0) sayim[nid]++;
    }
    let unique = 0, dupValueCount = 0, dupRowCount = 0;
    for (let id = 0; id < sayim.length; id++) {
      if (sayim[id] > 0) unique++;
      if (sayim[id] > 1) { dupValueCount++; dupRowCount += sayim[id]; }
    }
    const sonuc = { total: _nRows - _deletedSet.size, unique, dupValueCount, dupRowCount };
    _countifCache.set(ck, sonuc);
    return sonuc;
  }

  /** Tüm sütunlar için özet istatistik. */
  function allColumnStats() {
    const stats = [];
    for (let c = 0; c < _headers.length; c++) {
      const { dupValueCount, dupRowCount } = countSummary(c);
      stats.push({
        name: _headers[c],
        colIndex: c,
        type: detectColumnType(c),
        dupValueCount,
        dupRowCount
      });
    }
    return stats;
  }

  /* ---------- SATIR İŞLEMLERİ ---------- */

  // Hangi satır NEDEN silindi — denetim için. "Kimi neden çıkardın?"
  // sorusuna cevap veremeyen bir temizlik savunulamaz.
  const _deleteReason = _isaretler.sebep;

  function markDeleted(rowIdx, reason) {
    if (!_deletedSet.has(rowIdx)) { _deletedSet.add(rowIdx); _isaretDegisti(); }
    if (reason) _deleteReason.set(rowIdx, reason);
  }
  function markRowsDeleted(rowIndices, reason) {
    let added = 0;
    for (const rowIdx of rowIndices) {
      if (!Number.isInteger(rowIdx) || rowIdx < 0 || rowIdx >= _nRows || _deletedSet.has(rowIdx)) continue;
      _deletedSet.add(rowIdx);
      if (reason) _deleteReason.set(rowIdx, reason);
      added++;
    }
    if (added) _isaretDegisti();
    return added;
  }
  function unmarkDeleted(rowIdx) {
    if (_deletedSet.delete(rowIdx)) _isaretDegisti();
    _deleteReason.delete(rowIdx);
  }
  function isDeleted(rowIdx) { return _deletedSet.has(rowIdx); }
  function clearAllDeleted() { _deletedSet.clear(); _deleteReason.clear(); _isaretDegisti(); }
  function getDeletedCount() { return _deletedSet.size; }
  function getDeletedSet() { return new Set(_deletedSet); }
  function getDeleteReason(rowIdx) { return _deleteReason.get(rowIdx) || ''; }

  /**
   * Toplu silme: bir sütundaki kopya gruplardan birini tut, gerisini sil.
   * @param {number} colIndex
   * @param {'first'|'second'|'last'|'none'} keep
   */
  function bulkMark(colIndex, keep) {
    const { dupGroups } = countif(colIndex);
    const sebep = 'Ayni deger: ' + (_headers[colIndex] || ('sutun ' + colIndex));
    for (const [, indices] of dupGroups) {
      if (keep === 'none') {
        for (const rowIdx of indices) markDeleted(rowIdx, sebep);
        continue;
      }
      let keepIdx;
      if (keep === 'first') keepIdx = 0;
      else if (keep === 'second') keepIdx = indices.length > 1 ? 1 : 0;
      else keepIdx = indices.length - 1;
      for (let i = 0; i < indices.length; i++) {
        if (i !== keepIdx) markDeleted(indices[i], sebep);
      }
    }
  }

  /* =====================================================
     ÇOKLU ANAHTAR EŞLEŞTİRME (union-find)
     =====================================================
     Tek sütuna bakmak yetmez. Aynı kişi farklı AID ile ama aynı
     mail ile geçebilir; üstelik zincirleme olabilir:

       A: aid=1, mail=x, tel=yok
       B: aid=2, mail=x, tel=y
       C: aid=3, mail=yok, tel=y

     A-B mailden, B-C telefondan bağlanır -> ÜÇÜ TEK KİŞİDİR.
     Ardışık tek-sütun temizliği bunu yakalayamaz; union-find yakalar.

     Sıcak döngüde hiç string üretilmiyor: her değer tamsayı kimliğe
     (normId) indirgenmiş durumda, union-find Int32Array üzerinde koşuyor.
     ===================================================== */

  /* GRUP ANAHTARI (kombinasyon / AND)
     -------------------------------------------------
     Tek sütun kimlik değilse ama BİRLİKTE kimlikse kullanılır:
     tek başına "Mehmet Yılmaz" yüzlerce kişidir, ama
     (ad_soyad + doğum_tarihi + il) kombinasyonu tek kişidir.

     Kural: grubun HER sütunu dolu olmalı. Biri boşsa o satırın
     grup kimliği yoktur — yarım kombinasyonla eşleştirmek,
     "adı aynı olan herkes aynı kişi" demeye kayar. */
  function _grupBilgisi(cols) {
    const alt = cols.map(c => {
      const tip = detectColumnType(c);
      const n = _colNorm(c, tip);
      return { codes: _colCodes[c], codeToNorm: n.codeToNorm, normValues: n.normValues };
    });

    const rowNid = new Int32Array(_nRows).fill(-1);
    const normValues = [];
    const harita = new Map();
    const parca = new Array(alt.length);

    for (let i = 0; i < _nRows; i++) {
      let tamam = true;
      for (let k = 0; k < alt.length; k++) {
        const nid = alt[k].codeToNorm[alt[k].codes[i]];
        if (nid < 0) { tamam = false; break; }
        parca[k] = nid;
      }
      if (!tamam) continue;
      const anahtar = parca.join('\u0001');   // normId'ler sayıdır; \u0001 hiçbir sayıda geçmez, anahtarlar çakışmaz
      let id = harita.get(anahtar);
      if (id === undefined) {
        id = normValues.length;
        normValues.push(parca.map((nid, k) => alt[k].normValues[nid]).join(' + '));
        harita.set(anahtar, id);
      }
      rowNid[i] = id;
    }
    return { rowNid, normValues };
  }

  /**
   * keySpecs iki biçimi kabul eder:
   *   {colIndex: 3}          -> tek sütun anahtarı
   *   {group: [1, 5, 7]}     -> kombinasyon anahtarı (hepsi birden aynı)
   * Anahtarlar birbiriyle VEYA'lanır: biri eşleşen satırlar aynı kişidir.
   */
  function _anahtarBilgisi(keySpecs) {
    return keySpecs.map(spec => {
      if (spec.group && spec.group.length) {
        const g = _grupBilgisi(spec.group);
        return {
          grup: spec.group,
          ad: spec.group.map(c => _headers[c] || ('sütun ' + (c + 1))).join(' + '),
          rowNid: g.rowNid,
          normValues: g.normValues
        };
      }
      const tip = spec.type || detectColumnType(spec.colIndex);
      const { codeToNorm, normValues } = _colNorm(spec.colIndex, tip);
      return {
        colIndex: spec.colIndex,
        ad: _headers[spec.colIndex] || ('sütun ' + (spec.colIndex + 1)),
        tip,
        codes: _colCodes[spec.colIndex],
        codeToNorm,
        normValues
      };
    });
  }

  /** Satırın o anahtardaki normalize kimliği (-1 = yok/geçersiz) */
  function _nid(bilgi, rowIdx) {
    return bilgi.rowNid ? bilgi.rowNid[rowIdx] : bilgi.codeToNorm[bilgi.codes[rowIdx]];
  }

  /**
   * Aynı kişiye ait satır kümelerini bulur. Hiçbir şeyi değiştirmez.
   * @param {Array<{colIndex:number, type?:string}>} keySpecs
   * @param {{maxLinkFrequency?:number}} opts
   */
  function findClusters(keySpecs, opts) {
    opts = opts || {};
    const maxFreq = opts.maxLinkFrequency == null ? Math.max(50, Math.ceil(_nRows * 0.001)) : opts.maxLinkFrequency;
    const n = _nRows;
    const keys = _anahtarBilgisi(keySpecs);

    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const bul = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };

    // 1) sıklık — bir değer çok fazla satırda geçiyorsa KİMLİK BELİRTMİYOR
    //    demektir (santral telefonu, info@firma.com). Onu bağlamada
    //    kullanmak binlerce kişiyi tek kişiye yapıştırır.
    const kirliListe = [];
    const kirli = keys.map(k => new Uint8Array(k.normValues.length));
    for (let ki = 0; ki < keys.length; ki++) {
      const k = keys[ki];
      const cnt = new Int32Array(k.normValues.length);
      for (let i = 0; i < n; i++) {
        if (_deletedSet.has(i)) continue;
        const id = _nid(k, i);
        if (id >= 0) cnt[id]++;
      }
      for (let id = 0; id < cnt.length; id++) {
        if (cnt[id] > maxFreq) {
          kirli[ki][id] = 1;
          kirliListe.push({ column: k.ad, value: k.normValues[id], count: cnt[id] });
        }
      }
    }

    // 2) birleştir
    for (let ki = 0; ki < keys.length; ki++) {
      const k = keys[ki];
      const ilk = new Int32Array(k.normValues.length).fill(-1);
      const kk = kirli[ki];
      for (let i = 0; i < n; i++) {
        if (_deletedSet.has(i)) continue;
        const id = _nid(k, i);
        if (id < 0 || kk[id]) continue;
        if (ilk[id] < 0) { ilk[id] = i; continue; }
        const a = bul(i), b = bul(ilk[id]);
        if (a !== b) parent[a] = b;
      }
    }

    // 3) kümeleri topla (sadece 2+ satırlı olanlar)
    const kokIndeks = new Map();
    const clusters = [];
    for (let i = 0; i < n; i++) {
      if (_deletedSet.has(i)) continue;
      const r = bul(i);
      let ci = kokIndeks.get(r);
      if (ci === undefined) { ci = clusters.length; kokIndeks.set(r, ci); clusters.push([i]); }
      else clusters[ci].push(i);
    }
    const kopyalar = clusters.filter(c => c.length > 1);

    return { clusters: kopyalar, keys, noisyValues: kirliListe, rowCount: n };
  }

  /* ---------- KAZANAN SEÇİMİ ---------- */

  /** gg.aa.yyyy / yyyy-aa-gg / sayı -> sıralanabilir metne çevirir */
  function _siralanabilir(val) {
    const s = _clean(val);
    if (!s) return '';
    let m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
    if (m) return m[3] + String(m[2]).padStart(2, '0') + String(m[1]).padStart(2, '0');
    m = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
    if (m) return m[1] + String(m[2]).padStart(2, '0') + String(m[3]).padStart(2, '0');
    if (/^-?\d+([.,]\d+)?$/.test(s)) {
      const n = Number(s.replace(',', '.'));
      if (isFinite(n)) return (n + 1e15).toFixed(6).padStart(24, '0');
    }
    return s.toUpperCase();
  }

  /* Öncelik sütunu da sözlük üzerinden çevrilir: 300 bin satır yerine
     o sütundaki benzersiz tarih sayısı kadar (genelde birkaç yüz) iş. */
  function _oncelikHaritasi(colIndex) {
    const d = _colDict[colIndex] || [''];
    const out = new Array(d.length);
    for (let i = 0; i < d.length; i++) out[i] = _siralanabilir(d[i]);
    return out;
  }

  /* Yalnız dosyadan gelen sütunlar sayılır: eklenen sütun (sabit değer,
     birleştirme, tekrar sayısı) hangi satırın kalacağını değiştirmesin. */
  function _doluSayisi(rowIdx) {
    let n = 0;
    const kaynak = _colCodes.length - _eklenen.size;
    for (let c = 0; c < kaynak; c++) if (_colCodes[c][rowIdx] !== BOS) n++;
    return n;
  }

  /** Küme içinde hangi satır kalacak: öncelik sütunu -> en dolu -> en üstteki */
  function _kazananSec(indices, pri, priMap) {
    let best = indices[0];
    let bestPri = pri ? priMap[_colCodes[pri.colIndex][best]] : '';
    let bestDolu = _doluSayisi(best);

    for (let t = 1; t < indices.length; t++) {
      const i = indices[t];
      const p = pri ? priMap[_colCodes[pri.colIndex][i]] : '';
      const d = _doluSayisi(i);
      let daha = false;
      if (pri && p !== bestPri) {
        if (!bestPri) daha = !!p;              // boş öncelik her zaman kaybeder
        else if (!p) daha = false;
        else daha = (pri.dir === 'asc') ? (p < bestPri) : (p > bestPri);
      } else if (d !== bestDolu) {
        daha = d > bestDolu;
      }
      if (daha) { best = i; bestPri = p; bestDolu = d; }
    }
    return best;
  }

  function _sebep(rowIdx, winIdx, keys) {
    const eslesen = [];
    for (const k of keys) {
      const a = _nid(k, winIdx), b = _nid(k, rowIdx);
      if (a >= 0 && a === b) eslesen.push(k.grup ? '(' + k.ad + ')' : k.ad);
    }
    return eslesen.length
      ? 'Ayni: ' + eslesen.join(', ')
      : 'Zincirleme eslesme (ara kayit uzerinden)';
  }

  /**
   * Kümeleri bulup her kümede biri hariç hepsini "silinecek" işaretler.
   */
  function markDuplicateClusters(keySpecs, opts) {
    opts = opts || {};
    const res = findClusters(keySpecs, opts);
    const pri = opts.priority || null;
    const priMap = pri ? _oncelikHaritasi(pri.colIndex) : null;
    let marked = 0;
    for (const idx of res.clusters) {
      const win = _kazananSec(idx, pri, priMap);
      for (const i of idx) {
        if (i === win) continue;
        markDeleted(i, _sebep(i, win, res.keys));
        marked++;
      }
    }
    return {
      clusterCount: res.clusters.length,
      markedCount: marked,
      noisyValues: res.noisyValues
    };
  }

  /** İşaretlemeden önce ne olacağını gösterir (UI önizlemesi için). */
  function previewDuplicateClusters(keySpecs, opts, limit) {
    opts = opts || {};
    const res = findClusters(keySpecs, opts);
    const pri = opts.priority || null;
    const priMap = pri ? _oncelikHaritasi(pri.colIndex) : null;
    const out = [];
    const max = limit == null ? 200 : limit;
    for (const idx of res.clusters) {
      if (out.length >= max) break;
      const win = _kazananSec(idx, pri, priMap);
      const reasons = {};
      for (const i of idx) if (i !== win) reasons[i] = _sebep(i, win, res.keys);
      out.push({ rows: idx, winner: win, reasons });
    }
    return {
      clusters: out,
      clusterCount: res.clusters.length,
      shown: out.length,
      noisyValues: res.noisyValues
    };
  }

  /**
   * SADECE KOPYALARI LİSTELER. Hiçbir şeyi silmez, işaretlemez.
   * Kümeler bitişik gelir, böylece tabloda aynı kişinin satırları
   * yan yana görünür.
   *
   * @param {Array<{colIndex:number,type?:string}>} keySpecs
   * @param {{maxLinkFrequency?:number, priority?:{colIndex:number,dir:string}}} opts
   * @returns {{
   *   rows: Int32Array,          // kume sirasinda satir indeksleri
   *   clusterOfRow: Int32Array,  // satir -> kume no (-1 = kopya degil)
   *   winners: Set<number>,      // her kumede "kalacak" onerilen satir
   *   clusterCount, rowCount, noisyValues
   * }}
   */
  function getDuplicateRows(keySpecs, opts) {
    opts = opts || {};
    const res = findClusters(keySpecs, opts);
    const pri = opts.priority || null;
    const priMap = pri ? _oncelikHaritasi(pri.colIndex) : null;

    let toplam = 0;
    for (const c of res.clusters) toplam += c.length;

    const rows = new Int32Array(toplam);
    const clusterOfRow = new Int32Array(_nRows).fill(-1);
    const winners = new Set();

    let p = 0;
    for (let ci = 0; ci < res.clusters.length; ci++) {
      const idx = res.clusters[ci];
      winners.add(_kazananSec(idx, pri, priMap));
      for (const i of idx) { rows[p++] = i; clusterOfRow[i] = ci; }
    }

    return {
      rows,
      clusterOfRow,
      winners,
      clusterCount: res.clusters.length,
      rowCount: toplam,
      noisyValues: res.noisyValues
    };
  }

  /** Tek sütunda kopya olan satırları listeler (COUNTIF görünümü). */
  function getDuplicateRowsByColumn(colIndex, type) {
    const { dupGroups } = countif(colIndex, type);
    let toplam = 0;
    for (const [, a] of dupGroups) toplam += a.length;
    const rows = new Int32Array(toplam);
    const clusterOfRow = new Int32Array(_nRows).fill(-1);
    let p = 0, ci = 0;
    for (const [, a] of dupGroups) {
      for (const i of a) { rows[p++] = i; clusterOfRow[i] = ci; }
      ci++;
    }
    return { rows, clusterOfRow, winners: new Set(), clusterCount: ci, rowCount: toplam, noisyValues: [] };
  }

  /** Kimlik anahtarı olmaya uygun sütunları önerir. */
  function suggestKeyColumns() {
    const out = [];
    for (let c = 0; c < _headers.length; c++) {
      const tip = detectColumnType(c);
      if (tip === 'text' || tip === 'name') continue;   // ad-soyad kimlik değildir
      out.push({ colIndex: c, name: _headers[c], type: tip });
    }
    return out;
  }

  /* ---------- SÜTUN EKLEME ----------
     Yeni sütun tablonun SONUNA yazılır: dosyadan gelen sütunların numarası
     (sekme, anahtar, arama, tarif) değişmez. Değerler bir kez hesaplanır ve
     aynı sözlük kodlamasıyla saklanır (anlık görüntü); sonra kopya analizi,
     anahtar seçimi, arama ve dışa aktarım onu dosyadan gelmiş gibi görür.
       concat   — seçilen sütunları sırasıyla ayraçla birleştirir; boş parça atlanır
       constant — her satıra aynı değer
       empty    — yalnız başlık
       count    — değerin DOSYADAKİ TÜM satırlarda kaç kez geçtiği (sütun
                  türüne göre karşılaştırılır: "0532…" ile "+90 532…" aynı telefon)
       group    — birden çok geçen değere ilk görünüş sırasıyla ortak numara
     count ve group silme işaretlerine bakmaz: "bu müşteri listede kaç kez
     vardı" sorusunun cevabı temizlikten sonra değişmemeli. */
  const EK_TURLER = ['concat', 'constant', 'empty', 'count', 'group'];
  const EK_AD_SINIRI = 120;
  const EK_DEGER_SINIRI = 1000;
  const EK_AYRAC_SINIRI = 10;

  function _yeniBaslik(ad) {
    const s = String(ad == null ? '' : ad).trim();
    if (!s) throw new Error('Yeni sütunun adı boş olamaz.');
    if (s.length > EK_AD_SINIRI) throw new Error(`Sütun adı en çok ${EK_AD_SINIRI} karakter olabilir.`);
    if (_headers.includes(s)) throw new Error(`"${s}" adlı bir sütun zaten var.`);
    return s;
  }

  function _varOlanSutun(c) {
    if (!Number.isInteger(c) || c < 0 || c >= _headers.length) throw new Error('Kaynak sütun bulunamadı.');
    return c;
  }

  /* Tanım burada doğrulanır; hesap başlamadan hata verilir ki yarım sütun kalmasın. */
  function _ekTanimiDogrula(spec) {
    if (!spec || typeof spec !== 'object' || !EK_TURLER.includes(spec.kind)) {
      throw new Error('Bilinmeyen sütun türü.');
    }
    if (!_headers.length) throw new Error('Önce bir dosya yükleyin.');
    const t = { kind: spec.kind, name: _yeniBaslik(spec.name) };
    if (spec.kind === 'concat') {
      if (!Array.isArray(spec.columns) || spec.columns.length < 2) throw new Error('Birleştirmek için en az iki sütun seçin.');
      t.columns = spec.columns.map(_varOlanSutun);
      if (new Set(t.columns).size !== t.columns.length) throw new Error('Aynı sütun iki kez seçilmiş.');
      t.separator = spec.separator == null ? ' ' : String(spec.separator);
      if (t.separator.length > EK_AYRAC_SINIRI) throw new Error(`Ayraç en çok ${EK_AYRAC_SINIRI} karakter olabilir.`);
    } else if (spec.kind === 'constant') {
      t.value = String(spec.value == null ? '' : spec.value);
      if (!t.value) throw new Error('Sabit değer boş olamaz; boş sütun için "Boş sütun"u seçin.');
      if (t.value.length > EK_DEGER_SINIRI) throw new Error(`Sabit değer en çok ${EK_DEGER_SINIRI} karakter olabilir.`);
    } else if (spec.kind === 'count' || spec.kind === 'group') {
      t.column = _varOlanSutun(spec.column);
      if (spec.type != null && !SUTUN_TIPLERI.has(spec.type)) throw new Error('Bilinmeyen sütun tipi.');
      t.type = spec.type || detectColumnType(t.column);
    }
    return t;
  }

  /**
   * Tabloya yeni sütun ekler. Büyük dosyada sayfaya nefes aldırarak çalışır.
   * @param {{kind:string, name:string, columns?:number[], separator?:string,
   *          value?:string, column?:number, type?:string}} spec
   * @param {{iptalMi?: Function}} [secenek]
   * @returns {Promise<{colIndex:number, header:string}>}
   */
  async function addColumn(spec, secenek) {
    const t = _ekTanimiDogrula(spec);
    const n = _nRows;
    let dict = [''];
    let codes;

    if (t.kind === 'empty') {
      codes = new Int32Array(n);
    } else if (t.kind === 'constant') {
      dict = ['', t.value];
      codes = new Int32Array(n).fill(1);
    } else if (t.kind === 'concat') {
      const tablo = _metinTablosu(dict);
      codes = new Int32Array(n);
      const kaynak = t.columns.map(c => ({ d: _colDict[c], k: _colCodes[c] }));
      const parca = [];
      let dilimBasi = Date.now();
      for (let i = 0; i < n; i++) {
        parca.length = 0;
        for (let s = 0; s < kaynak.length; s++) {
          const v = kaynak[s].d[kaynak[s].k[i]];
          if (v) parca.push(v);
        }
        codes[i] = parca.length ? tablo.kod(parca.join(t.separator), _bagimsizKopya) : BOS;
        if ((i & 16383) === 16383 && Date.now() - dilimBasi >= DILIM_MS) {
          _iptalKontrol(secenek);
          await _nefesAl();
          dilimBasi = Date.now();
        }
      }
    } else {
      // count / group: normalize kimlik sözlük başına bir kez, satırlar kodla taranır
      const { codeToNorm, normValues } = _colNorm(t.column, t.type);
      const kaynakKod = _colCodes[t.column];
      const sayim = new Int32Array(normValues.length);
      for (let i = 0; i < n; i++) {
        const id = codeToNorm[kaynakKod[i]];
        if (id >= 0) sayim[id]++;
      }
      codes = new Int32Array(n);
      if (t.kind === 'count') {
        // Az sayıda farklı sayım vardır: her sayının metni sözlükte bir kez
        const sayimKodu = new Map();
        for (let i = 0; i < n; i++) {
          const id = codeToNorm[kaynakKod[i]];
          if (id < 0) continue;
          let k = sayimKodu.get(sayim[id]);
          if (k === undefined) { k = dict.length; dict.push(String(sayim[id])); sayimKodu.set(sayim[id], k); }
          codes[i] = k;
        }
      } else {
        // Grup no = sözlük kodu: dict[g] === String(g)
        const grupNo = new Int32Array(normValues.length);
        for (let i = 0; i < n; i++) {
          const id = codeToNorm[kaynakKod[i]];
          if (id < 0 || sayim[id] < 2) continue;
          if (grupNo[id] === 0) { grupNo[id] = dict.length; dict.push(String(dict.length)); }
          codes[i] = grupNo[id];
        }
      }
    }

    // Hesap bitti; tabloya ancak şimdi yazılır (iptal edilen sütun yarım kalmaz)
    _iptalKontrol(secenek);
    if (_headers.includes(t.name)) throw new Error(`"${t.name}" adlı bir sütun zaten var.`);
    const c = _headers.length;
    _headers.push(t.name);
    _colDict.push(dict);
    _colCodes.push(codes);
    _eklenen.set(c, t);
    await _sutunuHazirla(c, secenek);
    return { colIndex: c, header: t.name };
  }

  function isAddedColumn(colIndex) { return _eklenen.has(colIndex); }

  /** Eklenen sütunların tanımları; kaynak sütunlar adıyla da verilir. */
  function getAddedColumns() {
    return [..._eklenen.entries()].map(([c, t]) => _ekTanimiDisari(c, t));
  }

  function _ekTanimiDisari(c, t) {
    const o = { colIndex: c, kind: t.kind, name: t.name };
    if (t.kind === 'concat') { o.columns = t.columns.map(k => _headers[k]); o.separator = t.separator; }
    if (t.kind === 'constant') o.value = t.value;
    if (t.kind === 'count' || t.kind === 'group') { o.column = _headers[t.column]; o.type = t.type; }
    return o;
  }

  /* ---------- VERİ ERİŞİMİ ---------- */

  function getHeaders() { return _headers.slice(); }
  function getRowCount() { return _nRows; }
  function getActiveRowCount() { return _nRows - _deletedSet.size; }
  function getFileName() { return _fileName; }
  function getParseInfo() { return { delimiter: _delimiter, encoding: _encoding }; }

  /* Satır talep edildiğinde sözlükten kurulur. Arayüz aynı anda sadece
     ekrana sığan kadarını ister, bu yüzden maliyeti önemsiz. */
  function getRow(idx) {
    if (idx < 0 || idx >= _nRows) return undefined;
    const m = _colCodes.length;
    const row = new Array(m);
    for (let c = 0; c < m; c++) row[c] = _colDict[c][_colCodes[c][idx]];
    return row;
  }

  function getCellValue(rowIdx, colIdx) {
    if (rowIdx < 0 || rowIdx >= _nRows || !_colCodes[colIdx]) return '';
    return _colDict[colIdx][_colCodes[colIdx][rowIdx]] || '';
  }

  function getMemoryInfo() {
    let sozlukHucre = 0, sozlukKarakter = 0;
    for (let c = 0; c < _colDict.length; c++) {
      sozlukHucre += _colDict[c].length;
      for (let i = 0; i < _colDict[c].length; i++) sozlukKarakter += _colDict[c][i].length;
    }
    const kodByte = _colCodes.length * _nRows * 4;
    return {
      rows: _nRows,
      cols: _headers.length,
      cells: _nRows * _headers.length,
      dictEntries: sozlukHucre,
      dictChars: sozlukKarakter,
      codeBytes: kodByte,
      // kaba tahmin: kod dizileri + sozluk metni + string nesne yuku
      estimatedBytes: kodByte + sozlukKarakter * 2 + sozlukHucre * 40
    };
  }

  /* ---------- DIŞA AKTARMA ---------- */

  function _exportColumns(indices) {
    if (indices == null) return _headers.map((_, i) => i);
    if (!Array.isArray(indices) || !indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= _headers.length)) {
      throw new Error('Çıktı için en az bir geçerli sütun seçin.');
    }
    return indices;
  }

  function exportClean(columnIndices) {
    const cols = _exportColumns(columnIndices);
    const result = [cols.map(c => _headers[c])];
    for (let i = 0; i < _nRows; i++) {
      if (!_deletedSet.has(i)) {
        const row = getRow(i);
        result.push(cols.map(c => row[c]));
      }
    }
    return result;
  }

  /* Silinenler dosyası denetim kaydıdır: hangi satır, HANGİ ALAN yüzünden
     çıkarıldı. Sebep sütunu olmadan bu dosya "şuna güven" demekten ibaret. */
  function exportDeleted(columnIndices) {
    const cols = _exportColumns(columnIndices);
    const result = [cols.map(c => _headers[c]).concat(['KAYNAK_SATIR', 'SILME_SEBEBI'])];
    for (let i = 0; i < _nRows; i++) {
      if (_deletedSet.has(i)) {
        const row = getRow(i);
        result.push(cols.map(c => row[c]).concat([getSourceLine(i), _deleteReason.get(i) || '']));
      }
    }
    return result;
  }

  /** Sadece kopya satırları dışa aktarır (silmeden, incelemek için). */
  function exportDuplicates(dupResult) {
    const result = [_headers.concat(['KUME_NO', 'KAYNAK_SATIR', 'ONERILEN'])];
    for (let p = 0; p < dupResult.rows.length; p++) {
      const i = dupResult.rows[p];
      result.push(getRow(i).concat([
        dupResult.clusterOfRow[i] + 1,
        getSourceLine(i),
        dupResult.winners.has(i) ? 'KALSIN' : ''
      ]));
    }
    return result;
  }

  /* ---------- FORMÜL ENJEKSİYONU (OWASP CSV Injection) ----------
     Ortak kural csv-io.js'teki guvenliHucre. Yalnızca CSV çıktısına
     uygulanır — Excel bir CSV'yi açarken =, +, -, @, sekme ya da CR ile
     başlayan hücreyi formül sayar. XLSX'te SheetJS metni 's' tipli hücre
     olarak yazar, formül çalışmaz; oraya ' eklemek veriyi bozar
     ("+90 532…" → "'+90 532…").
     Sayım ile dönüşüm aynı kuralı kullanır: "N hücre güvenli metne
     çevrildi" mesajı gerçekten çevrilen hücre sayısıyla birebir tutar. */
  function isFormulaCell(val) {
    return _csvIO().isFormulaCell(val);
  }

  function countFormulaCells(data2d) {
    let count = 0;
    const samples = [];
    if (!Array.isArray(data2d)) return { count: 0, samples: [] };
    for (let r = 0; r < data2d.length; r++) {
      const row = data2d[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length; c++) {
        if (isFormulaCell(row[c])) {
          count++;
          if (samples.length < 5) {
            samples.push({ row: r, col: c, value: String(row[c]) });
          }
        }
      }
    }
    return { count, samples };
  }

  /* options.safeFormula XLSX'te bilerek yok sayılır (bkz. formül enjeksiyonu notu):
     hücreler metin olarak yazıldığı için formül riski yoktur. */
  function arrayToXlsxBlob(data2d, sheetName, options) {
    if (data2d.length > 1048576) throw new Error('Excel sayfa sınırı 1.048.576 satırdır (başlık dahil). CSV biçimini seçin.');
    const ws = XLSX.utils.aoa_to_sheet(data2d);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
    // compression: SheetJS varsayılan olarak XLSX'in içindeki zip girdilerini
    // SIKIŞTIRMADAN yazar; Excel'in 10 MB'lık dosyası dışa aktarımda ~50 MB'a
    // çıkıyordu. Deflate ile boyut Excel'in kendi çıktısı düzeyine iner.
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
    return new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /** CSV metni üretir — büyük dosyada XLSX'ten çok daha hafif. Başlık
      data2d[0]'dadır; BOM (Excel Türkçe karakteri doğru açsın) ve CRLF ile. */
  function toCSV(data2d, delim, options) {
    return _csvIO().stringify(null, data2d, {
      delimiter: delim || ';',
      safeFormula: !!(options && options.safeFormula)
    });
  }

  /* Yerel tarif (Recipe) dışa/içe aktarımı — hassas satır verisi içermez.
     Eklenen sütunların tanımı (kaynak sütun ADIYLA) ve arayüzde çıkarılan
     sütunların adları da yazılır; sabit sütunun değeri kullanıcının
     kendi yazdığı metindir, dosyadan gelmez.
     @param {{removedColumns?: string[]}} [opts] */
  function exportRecipe(opts) {
    const colTypes = {};
    _headers.forEach((h, i) => {
      const t = getColumnType(i);
      if (t && t !== 'text') colTypes[h] = t;
    });
    const recipe = {
      version: 1,
      createdAt: new Date().toISOString(),
      type: 'dedup-recipe',
      columnTypes: colTypes,
      delimiter: _delimiter
    };
    const ekler = getAddedColumns().map(o => { const k = Object.assign({}, o); delete k.colIndex; return k; });
    if (ekler.length) recipe.addedColumns = ekler;
    const cikan = opts && Array.isArray(opts.removedColumns)
      ? opts.removedColumns.filter(h => typeof h === 'string' && _headers.includes(h)) : [];
    if (cikan.length) recipe.removedColumns = cikan;
    return recipe;
  }

  const TARIF_EK_SINIRI = 50;
  const TARIF_AD_SINIRI = 500;
  const _metinMi = (v, enCok, bosOlabilir) => typeof v === 'string' && v.length <= enCok && (bosOlabilir || v.trim() !== '');

  /* Tariften gelen eklenen sütun tanımı: biçim burada doğrulanır, kaynak
     sütunların varlığı ekleme anında (addRecipeColumn) aranır. */
  function _tarifEkDogrula(e, sira) {
    const hata = () => new Error(`Geçersiz tarif: eklenen sütun #${sira + 1} hatalı.`);
    if (!e || typeof e !== 'object' || Array.isArray(e) || !EK_TURLER.includes(e.kind)) throw hata();
    if (!_metinMi(e.name, EK_AD_SINIRI)) throw hata();
    const t = { kind: e.kind, name: e.name.trim() };
    if (e.kind === 'concat') {
      if (!Array.isArray(e.columns) || e.columns.length < 2 || e.columns.length > TARIF_EK_SINIRI ||
          !e.columns.every(c => _metinMi(c, TARIF_AD_SINIRI, true))) throw hata();
      if (e.separator != null && !_metinMi(e.separator, EK_AYRAC_SINIRI, true)) throw hata();
      t.columns = e.columns.slice();
      t.separator = e.separator == null ? ' ' : e.separator;
    } else if (e.kind === 'constant') {
      if (!_metinMi(e.value, EK_DEGER_SINIRI)) throw hata();
      t.value = e.value;
    } else if (e.kind === 'count' || e.kind === 'group') {
      if (!_metinMi(e.column, TARIF_AD_SINIRI, true)) throw hata();
      if (e.type != null && (typeof e.type !== 'string' || !SUTUN_TIPLERI.has(e.type))) throw hata();
      t.column = e.column;
      if (e.type != null) t.type = e.type;
    }
    return t;
  }

  /**
   * Tarifteki bir eklenen sütunu bu dosyaya uygular. Aynı adlı sütun zaten
   * varsa (tarif ikinci kez yüklendi) ya da kaynak sütun bu dosyada yoksa
   * atlanır ve nedeni döner; tarifin geri kalanı yine uygulanır.
   * @returns {Promise<{colIndex?:number, header:string, skipped?:string}>}
   */
  async function addRecipeColumn(t, columnTypes, secenek) {
    if (_headers.includes(t.name)) return { header: t.name, skipped: 'exists' };
    const no = h => _headers.indexOf(h);
    const spec = { kind: t.kind, name: t.name, separator: t.separator, value: t.value, type: t.type };
    if (t.kind === 'concat') {
      spec.columns = t.columns.map(no);
      if (spec.columns.some(i => i < 0)) return { header: t.name, skipped: 'missing' };
    } else if (t.kind === 'count' || t.kind === 'group') {
      spec.column = no(t.column);
      if (spec.column < 0) return { header: t.name, skipped: 'missing' };
    }
    const r = await addColumn(spec, secenek);
    if (columnTypes && Object.prototype.hasOwnProperty.call(columnTypes, t.name)) {
      setColumnType(r.colIndex, columnTypes[t.name]);
    }
    return r;
  }

  /* Tarif dışarıdan gelen bir dosyadır: tip değerleri bilinen kümeyle
     sınırlanır. Eskiden her metin kabul ediliyordu ve arayüz tipi HTML
     olarak bastığı için hazırlanmış bir tarif sayfaya kod sokabiliyordu.
     hasOwnProperty şart: "constructor" adlı bir sütun, düz nesnede
     miras kalan fonksiyonu "tip" sanıyordu. Önce hepsi doğrulanır, sonra
     uygulanır — yarım uygulanmış tarif sessiz tutarsızlık bırakır. */
  function applyRecipe(recipe) {
    if (!recipe || typeof recipe !== 'object' || recipe.type !== 'dedup-recipe') {
      throw new Error('Geçersiz tarif formatı.');
    }
    const tipler = recipe.columnTypes;
    if (tipler != null && (typeof tipler !== 'object' || Array.isArray(tipler))) {
      throw new Error('Geçersiz tarif formatı: columnTypes bir nesne olmalı.');
    }
    if (tipler) {
      for (const ad of Object.keys(tipler)) {
        const t = tipler[ad];
        if (typeof t !== 'string' || !SUTUN_TIPLERI.has(t)) {
          throw new Error(`Geçersiz tarif: "${String(ad).slice(0, 40)}" sütunu için bilinmeyen tip.`);
        }
      }
    }
    const ekler = recipe.addedColumns;
    if (ekler != null && (!Array.isArray(ekler) || ekler.length > TARIF_EK_SINIRI)) {
      throw new Error('Geçersiz tarif formatı: addedColumns en çok ' + TARIF_EK_SINIRI + ' öğelik bir liste olmalı.');
    }
    const eklenecek = (ekler || []).map(_tarifEkDogrula);
    const cikan = recipe.removedColumns;
    if (cikan != null && (!Array.isArray(cikan) || cikan.length > 5000 || !cikan.every(h => _metinMi(h, TARIF_AD_SINIRI, true)))) {
      throw new Error('Geçersiz tarif formatı: removedColumns sütun adlarından oluşan bir liste olmalı.');
    }

    let appliedCount = 0;
    if (tipler) {
      _headers.forEach((h, i) => {
        if (Object.prototype.hasOwnProperty.call(tipler, h)) {
          setColumnType(i, tipler[h]);
          appliedCount++;
        }
      });
    }
    // Sütun ekleme eşzamansızdır (büyük dosyada nefes alır): arayüz
    // pendingColumns'u sırayla addRecipeColumn ile uygular, sonra
    // removedColumns'taki adları gizler.
    return {
      appliedTypes: appliedCount,
      pendingColumns: eklenecek,
      removedColumns: (cikan || []).slice(),
      columnTypes: tipler ? Object.assign(Object.create(null), tipler) : null
    };
  }

  /* AKIŞLI CSV DIŞA AKTARIMI
     -------------------------------------------------
     Tüm tabloyu string[][] olarak kurup ikinci kez formül sayımı için
     gezip sonra tek dev metne çevirmek, büyük listede aynı veriyi üç kez
     bellekte tutuyordu. Burada satırlar sözlükten doğrudan okunur ve
     chunkSize'lık dilimler hâlinde onChunk'a verilir; formül sayımı da
     aynı geçişte yapılır.
       options.delimiter / safeFormula / chunkSize
       options.includeRow(i)  — yazılacak satırlar (varsayılan: silinmemişler)
       options.extraColumns   — [{ header, value(i) }] ek sütunlar
     onChunk Promise dönerse beklenir: dosyaya doğrudan yazarken yazma
     hızına uyulur, bellek dolmaz.
     Dönüş: { cancelled, rowsWritten, exceedsExcel, formulaCells } */
  async function streamExportClean(columnIndices, options, onChunk, onProgress, cancelToken) {
    options = options || {};
    const includeRow = typeof options.includeRow === 'function' ? options.includeRow : (i => !_deletedSet.has(i));
    const extra = Array.isArray(options.extraColumns) ? options.extraColumns : [];
    if (cancelToken && cancelToken.cancelled) {
      const tahmin = options.includeRow ? 0 : getActiveRowCount();
      return { cancelled: true, rowsWritten: 0, exceedsExcel: tahmin + 1 > 1048576, formulaCells: 0 };
    }

    const cols = _exportColumns(columnIndices);
    const delim = options.delimiter || ';';
    const safe = !!options.safeFormula;
    const chunkSize = options.chunkSize || 5000;

    // Hücre kuralı toCSV ile aynı kaynaktan (csv-io): akışlı dosya ile tek
    // seferde üretilen metin birebir aynı olmalı.
    const io = _csvIO();
    let formulaCells = 0;
    const hucre = v => {
      const g = io.guvenliHucre(v);
      if (g !== v) { formulaCells++; if (safe) v = g; }
      return io.quoteField(v, delim);
    };

    // Başlık da hücredir: "=cmd" adlı bir sütun başlığı da formül çalıştırır
    const basliklar = cols.map(c => _headers[c]).concat(extra.map(e => e.header));
    if (onChunk) await onChunk(io.BOM + basliklar.map(hucre).join(delim) + '\r\n', 0);

    let rowsInChunk = [];
    let processed = 0;
    const m = cols.length;

    for (let i = 0; i < _nRows; i++) {
      if (cancelToken && cancelToken.cancelled) {
        return { cancelled: true, rowsWritten: processed, exceedsExcel: processed + 1 > 1048576, formulaCells };
      }
      if (!includeRow(i)) continue;
      const cells = new Array(m + extra.length);
      for (let k = 0; k < m; k++) cells[k] = hucre(_colDict[cols[k]][_colCodes[cols[k]][i]]);
      for (let k = 0; k < extra.length; k++) cells[m + k] = hucre(extra[k].value(i));
      rowsInChunk.push(cells.join(delim));
      processed++;

      if (rowsInChunk.length >= chunkSize) {
        if (onChunk) await onChunk(rowsInChunk.join('\r\n') + '\r\n', processed);
        rowsInChunk = [];
        if (onProgress) onProgress(Math.round((i / _nRows) * 100));
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (rowsInChunk.length > 0) {
      if (onChunk) await onChunk(rowsInChunk.join('\r\n') + '\r\n', processed);
    }
    if (onProgress) onProgress(100);

    return { cancelled: false, rowsWritten: processed, exceedsExcel: processed + 1 > 1048576, formulaCells };
  }

  /* ---------- YAKIN / BENZER KAYIT ADAYLARI ---------- */
  function _editSimilarity(a, b, threshold) {
    if (a === b) return 1;
    const maxLen = Math.max(a.length, b.length);
    if (!maxLen) return 1;
    const allowed = Math.floor(maxLen * (1 - threshold));
    if (Math.abs(a.length - b.length) > allowed) return 0;
    let prev = new Uint16Array(b.length + 1);
    let curr = new Uint16Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= b.length; j++) {
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > allowed + 1) return 0;
      const swap = prev; prev = curr; curr = swap;
    }
    return 1 - (prev[b.length] / maxLen);
  }

  function _tokenSorted(value) { return value.split(' ').filter(Boolean).sort().join(' '); }
  function _adjacentSwapSimilarity(a, b) {
    if (a.length !== b.length || a === b) return 0;
    const diff = [];
    for (let i = 0; i < a.length && diff.length <= 2; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) {
      return 1 - (1 / a.length);
    }
    return 0;
  }

  /**
   * Aynı olmayan fakat yazım hatası ihtimali taşıyan benzersiz değer çiftlerini
   * döndürür. Hiçbir satırı otomatik işaretlemez veya silmez.
   */
  function findSimilarPairs(colIndex, options) {
    options = options || {};
    const threshold = Math.max(0.80, Math.min(0.99, Number(options.threshold) || 0.90));
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 200));
    const dict = _colDict[colIndex] || [];
    const codes = _colCodes[colIndex];
    if (!codes) throw new Error('Sütun bulunamadı.');
    if (dict.length - 1 > 50000) throw new Error('Bu sütunda 50.000’den fazla benzersiz değer var. Daha ayırt edici bir sütun seçin.');

    const firstRows = new Int32Array(dict.length).fill(-1);
    for (let r = 0; r < _nRows; r++) {
      const code = codes[r];
      if (code && firstRows[code] < 0 && !_deletedSet.has(r)) firstRows[code] = r;
    }
    const entries = [];
    for (let code = 1; code < dict.length; code++) {
      if (firstRows[code] < 0) continue;
      const norm = normalizeAs(dict[code], 'name');
      if (norm.length < 4) continue;
      entries.push({ code, value:dict[code], norm, sorted:_tokenSorted(norm), row:firstRows[code] });
    }

    const blocks = new Map();
    entries.forEach((entry, index) => {
      const parts = entry.norm.split(' ');
      const prefix = entry.norm[0] + (parts.length > 1 ? parts[1][0] : '_');
      const lengthBucket = Math.floor(entry.norm.length / 4);
      for (let delta = -1; delta <= 1; delta++) {
        const key = prefix + ':' + (lengthBucket + delta);
        if (!blocks.has(key)) blocks.set(key, []);
        blocks.get(key).push(index);
      }
    });

    const seen = new Set();
    const pairs = [];
    let compared = 0, skippedBlocks = 0, truncated = false;
    outer: for (const block of blocks.values()) {
      if (block.length > 450) { skippedBlocks++; continue; }
      for (let i = 0; i < block.length; i++) {
        for (let j = i + 1; j < block.length; j++) {
          const a = entries[block[i]], b = entries[block[j]];
          const pairKey = a.code < b.code ? a.code + ':' + b.code : b.code + ':' + a.code;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          if (a.norm === b.norm) continue; // tam kopyalar mevcut COUNTIF akışının işi
          compared++;
          let score = _editSimilarity(a.norm, b.norm, threshold);
          score = Math.max(score, _adjacentSwapSimilarity(a.norm, b.norm));
          if (a.sorted !== a.norm || b.sorted !== b.norm) score = Math.max(score, _editSimilarity(a.sorted, b.sorted, threshold));
          if (score >= threshold) {
            pairs.push({ leftRow:a.row, rightRow:b.row, leftValue:a.value, rightValue:b.value,
              score:Math.round(score * 1000) / 1000, sourceLineLeft:getSourceLine(a.row), sourceLineRight:getSourceLine(b.row) });
            if (pairs.length >= limit) { truncated = true; break outer; }
          }
        }
      }
    }
    pairs.sort((a,b) => b.score - a.score || a.leftRow - b.leftRow);
    return { pairs, uniqueCount:entries.length, compared, skippedBlocks, truncated, threshold };
  }

  /* ---------- PUBLIC API ---------- */
  return {
    createInstance: createDedupEngine,
    findSimilarPairs,
    parseFile,
    hazirla,
    araSatirlar,
    countif,
    countSummary,
    allColumnStats,
    normalizeValue,
    markDeleted,
    markRowsDeleted,
    unmarkDeleted,
    isDeleted,
    clearAllDeleted,
    getDeletedCount,
    getDeletedSet,
    getDeleteReason,
    bulkMark,

    // tip farkında normalizasyon
    normalizeAs,
    detectColumnType,
    setColumnType,
    getColumnType,

    // çoklu anahtar eşleştirme
    findClusters,
    markDuplicateClusters,
    previewDuplicateClusters,
    suggestKeyColumns,

    // sadece kopyaları göster
    getDuplicateRows,
    getDuplicateRowsByColumn,
    exportDuplicates,

    // sütun ekleme
    addColumn,
    addRecipeColumn,
    isAddedColumn,
    getAddedColumns,

    getHeaders,
    getRowCount,
    getActiveRowCount,
    getRow,
    getFileName,
    getParseInfo,
    getSourceLine,
    getCellValue,
    getMemoryInfo,
    exportClean,
    exportDeleted,
    arrayToXlsxBlob,
    toCSV,
    isFormulaCell,
    countFormulaCells,
    exportRecipe,
    applyRecipe,
    streamExportClean
  };

};

const DedupEngine = createDedupEngine();
if (typeof window !== 'undefined') window.DedupEngine = DedupEngine;
