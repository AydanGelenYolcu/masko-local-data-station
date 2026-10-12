/**
 * workbench/tezgah-worker.js — Veri Tezgâhı hesaplama iş parçacığı
 *
 * Neden ayrı iş parçacığı? Tablo ve bütün işlemler eskiden sayfanın ana
 * iş parçacığındaydı: 5 milyon satırlık bir CSV'de dosya tek metne okunuyor,
 * tablo üç kez kopyalanıyor ve sayfa dakikalarca donup sonunda çöküyordu.
 * Artık tablo, tarif geçmişi, SQL tablosu ve maske kasası yalnız burada durur;
 * arayüz komut gönderir, sonucu ve ilerlemeyi alır. Sayfa hiçbir işlemde donmaz.
 *
 * İleti biçimi:
 *   arayüz → worker : { id, islem, veri }
 *   worker → arayüz : { id, tamam: true, sonuc } | { id, tamam: false, hata }
 *                     { id, ilerleme: { oran: 0..1 | null, metin } }
 *
 * Sıfır ağ: yalnız uzantı içindeki betikler yüklenir; fetch/XHR yoktur.
 */
/* global importScripts, XLSX, CsvIO, FilesEngine, RecipeEngine, ProfilerEngine,
   ValidatorEngine, SqlEngine, PrivacyLabEngine */
'use strict';

importScripts(
  '../vendor/xlsx.full.min.js',
  '../csv-io.js',
  '../file-mask-engine.js',
  'recipe-engine.js',
  'profiler-engine.js',
  'validator-engine.js',
  'sql-engine.js',
  'files-engine.js',
  'privacy-lab-engine.js'
);

// Excel sayfa başına en fazla 1.048.576 satır; biri başlık.
const EXCEL_VERI_SINIRI = 1048575;
// Dosya bu büyüklükte parçalarla okunur.
const PARCA_BAYT = 8 * 1024 * 1024;
// Dışa aktarımda CSV bu kadar satırlık parçalarla yazılır (tek dev metin kurulmaz).
const CSV_PARCA_SATIR = 100000;

let tablo = null;          // { ad, basliklar, satirlar, belgeMeta, kitapBilgisi, onarim }
let hat = null;            // RecipeEngine pipeline
const db = SqlEngine.createDatabase();
const kasa = new Map();    // takma ad → gerçek değer (yalnız bellekte)
const kasaSutunlari = new Set();
let iptalIstendi = false;

function ilerle(id, oran, metin) {
  self.postMessage({ id, ilerleme: { oran, metin } });
}

function tabloVarMi() {
  if (!tablo || !tablo.basliklar.length) throw new Error('Önce bir dosya yükleyin.');
}

function ozet() {
  if (!tablo) return null;
  return {
    ad: tablo.ad,
    satirSayisi: tablo.satirlar.length,
    sutunSayisi: tablo.basliklar.length,
    basliklar: tablo.basliklar.slice(),
    belgeBicimi: tablo.belgeMeta && tablo.belgeMeta.format || null,
    onarim: tablo.onarim || null,
    gecmis: hat ? hat.getHistory() : [],
    atilanAdim: hat && typeof hat.getCollapsedStepCount === 'function' ? hat.getCollapsedStepCount() : 0,
    excelSiniriniAsiyor: tablo.satirlar.length > EXCEL_VERI_SINIRI
  };
}

/* Aktif tablonun her değişiminde SQL tablosu da güncellenir; eskiden yalnız
   yüklemede kaydediliyor, tarif adımından sonra sorgular eski veride koşuyordu. */
function aktifYansit(basliklar, satirlar) {
  tablo.basliklar = basliklar;
  tablo.satirlar = satirlar;
  db.dropTable('aktif_tablo');
  try { db.registerTable('aktif_tablo', basliklar, satirlar); } catch (e) { /* başlıksız tablo */ }
}

/* Yeni kaynak: tarif geçmişi baştan başlar. belgeMeta undefined ise (aynı
   belgenin dönüştürülmüş hâli) mevcut metaveri korunur. */
function tabloKur(ad, basliklar, satirlar, belgeMeta, ek) {
  const onceki = tablo;
  tablo = Object.assign({ ad, basliklar, satirlar, belgeMeta: null, kitapBilgisi: null, onarim: null }, ek || {});
  if (belgeMeta !== undefined) tablo.belgeMeta = belgeMeta;
  else if (onceki) { tablo.belgeMeta = onceki.belgeMeta; tablo.kitapBilgisi = onceki.kitapBilgisi; }
  hat = RecipeEngine.createPipeline(basliklar, satirlar);
  aktifYansit(basliklar, satirlar);
}

// ---------------------------------------------------------------- Yükleme

/* UTF-8 değilse (eski ERP / Excel "CSV (MS-DOS)" çıktısı) Windows-1254 ile
   okunur. Karar dosyanın başındaki örnekten verilir. */
async function kodlamaSec(dosya) {
  const ornek = new Uint8Array(await dosya.slice(0, 256 * 1024).arrayBuffer());
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(ornek.subarray(0, sonTamUtf8(ornek)));
    return 'utf-8';
  } catch (e) {
    return 'windows-1254';
  }
}
// Örnek dilim çok baytlı bir karakterin ortasında bitebilir; o yarım karakteri dışarıda bırak.
function sonTamUtf8(b) {
  let i = b.length;
  for (let k = 0; k < 4 && i > 0; k++) {
    const c = b[i - 1];
    if ((c & 0xC0) === 0x80) { i--; continue; }       // devam baytı
    if (c >= 0xC0) i--;                                // yarım kalmış başlangıç baytı
    break;
  }
  return i;
}

async function csvYukle(id, dosya, satirSiniri) {
  const kodlama = await kodlamaSec(dosya);
  const cozucu = new TextDecoder(kodlama);
  const onarici = FilesEngine.createCsvRepairer({ shareValues: true });
  const toplam = dosya.size;
  let konum = 0;
  while (konum < toplam) {
    if (iptalIstendi) throw new Error('İPTAL');
    const parca = new Uint8Array(await dosya.slice(konum, konum + PARCA_BAYT).arrayBuffer());
    konum += parca.length;
    onarici.push(cozucu.decode(parca, { stream: konum < toplam }));
    ilerle(id, konum / toplam, `${onarici.rowCount.toLocaleString('tr-TR')} satır okundu`);
    if (satirSiniri && onarici.rowCount >= satirSiniri) break;
    if (!parca.length) break;
  }
  if (konum >= toplam) onarici.push(cozucu.decode());
  const r = onarici.end();
  let satirlar = r.rows;
  if (satirSiniri && satirlar.length > satirSiniri) satirlar = satirlar.slice(0, satirSiniri);
  return {
    basliklar: r.headers,
    satirlar,
    belgeMeta: { format: /\.tsv$/i.test(dosya.name) ? 'tsv' : 'csv' },
    onarim: {
      bozukSatir: r.stats.jaggedRowsCount,
      bozukOrnek: r.jaggedRows.slice(0, 5).map(j => ({ satir: j.lineIndex, ham: String(j.raw).slice(0, 200) })),
      ayrac: r.detectedDelimiter,
      kodlama,
      kesildi: !!(satirSiniri && konum < toplam)
    }
  };
}

// Dış çalışma kitabı başvurusu: [1]Sayfa!A1, [Dosya.xlsx]Sayfa!A1, URL veya UNC yolu.
const DIS_BAGLANTI_RE = /\[\d+\]|\[[^\]]+\.xl[a-z]*\]|https?:\/\/|\\\\/i;

/**
 * Safe Share için XLSX/XLS metaverisini toplar. Tablo yalnız ilk sayfadan
 * okunduğu için gizli sayfalar, yazar, yorumlar ve formül tanımları (sheet_to_json
 * yalnız hesaplanmış değeri verir) burada ayrıca taranmazsa denetçi bunları
 * hiç görmüyor ve dosyayı "güvenle paylaşılabilir" ilan ediyordu.
 * Aynı geçişte Excel röntgeni (inspectWorkbookStructure) için sayfa bilgisi toplanır.
 */
function calismaKitabiBilgisi(wb, format) {
  const props = wb.Props || {};
  const sayfaBilgisi = (wb.Workbook && Array.isArray(wb.Workbook.Sheets)) ? wb.Workbook.Sheets : [];
  // Hidden: 1 = gizli, 2 = çok gizli (yalnız VBA ile görünür)
  const gizliSayfalar = sayfaBilgisi.filter(s => s && s.Hidden).map(s => s.name);
  const siniflandir = PrivacyLabEngine.classifyFormulaCell;

  let disBaglanti = 0, yorum = 0, tehlikeliFormul = 0;
  const sayfalar = [];
  wb.SheetNames.forEach((ad, i) => {
    const ws = wb.Sheets[ad];
    if (!ws) return;
    let formul = 0, refHata = 0;
    const doluSatir = new Set();
    Object.keys(ws).forEach(adres => {
      if (adres.charAt(0) === '!') return;
      const hucre = ws[adres];
      if (!hucre) return;
      if (hucre.v !== undefined && hucre.v !== '') doluSatir.add(XLSX.utils.decode_cell(adres).r);
      if (Array.isArray(hucre.c) && hucre.c.length > 0) yorum++;
      if (typeof hucre.f === 'string' && hucre.f) {
        formul++;
        if (DIS_BAGLANTI_RE.test(hucre.f)) disBaglanti++;
        const risk = siniflandir ? siniflandir('=' + hucre.f) : null;
        if (risk && risk.critical) tehlikeliFormul++;
      }
      if (hucre.t === 'e' && /#REF!/.test(String(hucre.w || ''))) refHata++;
    });
    const aralik = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    const satirSayisi = aralik ? aralik.e.r - aralik.s.r + 1 : 0;
    sayfalar.push({
      name: ad,
      isHidden: !!(sayfaBilgisi[i] && sayfaBilgisi[i].Hidden),
      rowCount: satirSayisi,
      colCount: aralik ? aralik.e.c - aralik.s.c + 1 : 0,
      formulaCount: formul,
      refErrorCount: refHata,
      mergedCount: Array.isArray(ws['!merges']) ? ws['!merges'].length : 0,
      emptyFormattedRowCount: Math.max(0, satirSayisi - doluSatir.size)
    });
  });
  const adlar = (wb.Workbook && Array.isArray(wb.Workbook.Names)) ? wb.Workbook.Names : [];
  adlar.forEach(n => { if (n && DIS_BAGLANTI_RE.test(String(n.Ref || ''))) disBaglanti++; });

  return {
    belgeMeta: {
      format,
      author: props.Author || '',
      lastModifiedBy: props.LastAuthor || '',
      sheetCount: wb.SheetNames.length,
      hiddenSheetsCount: gizliSayfalar.length,
      hiddenSheetNames: gizliSayfalar,
      externalLinksCount: disBaglanti,
      commentsCount: yorum,
      dangerousFormulaCount: tehlikeliFormul
    },
    kitapBilgisi: { sheets: sayfalar }
  };
}

async function excelYukle(id, dosya, ext, satirSiniri) {
  ilerle(id, null, 'Excel dosyası açılıyor…');
  const veri = new Uint8Array(await dosya.arrayBuffer());
  const secenek = { type: 'array' };
  if (satirSiniri) secenek.sheetRows = satirSiniri + 1;
  const wb = XLSX.read(veri, secenek);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  let bilgi = { belgeMeta: null, kitapBilgisi: null };
  // Metaveri toplanamazsa null kalır; Safe Share bu durumda "güvenli" demez.
  try { bilgi = calismaKitabiBilgisi(wb, ext); } catch (e) { /* metaveri yok */ }
  if (!json.length) throw new Error('Excel dosyasının ilk sayfası boş.');
  return { basliklar: json[0].map(String), satirlar: json.slice(1), belgeMeta: bilgi.belgeMeta, kitapBilgisi: bilgi.kitapBilgisi };
}

async function jsonYukle(id, dosya) {
  ilerle(id, null, 'JSON okunuyor…');
  let parsed;
  try { parsed = JSON.parse(await dosya.text()); } catch (e) { throw new Error('JSON dosyası geçerli değil.'); }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('JSON dosyası bir tablo dizisi içermiyor.');
  const basliklar = Object.keys(parsed[0]);
  return { basliklar, satirlar: parsed.map(o => basliklar.map(h => o[h])), belgeMeta: { format: 'json' } };
}

// ---------------------------------------------------------------- Dışa aktarma

/* CSV'yi parça parça Blob'a yazar; milyonlarca satırı tek metne toplamaz. */
function csvBlob(id, basliklar, satirlar, secenek) {
  const parcalar = [];
  const toplam = satirlar.length;
  parcalar.push(CsvIO.stringify(basliklar, [], Object.assign({}, secenek, { bom: true })));
  for (let i = 0; i < toplam; i += CSV_PARCA_SATIR) {
    parcalar.push('\r\n');
    parcalar.push(CsvIO.stringify(null, satirlar.slice(i, i + CSV_PARCA_SATIR), Object.assign({}, secenek, { bom: false })));
    if (id != null) ilerle(id, Math.min(1, (i + CSV_PARCA_SATIR) / toplam), 'CSV yazılıyor…');
  }
  return new Blob(parcalar, { type: 'text/csv;charset=utf-8' });
}

function xlsxBlob(basliklar, satirlar, sayfaAdi) {
  if (satirlar.length > EXCEL_VERI_SINIRI) {
    throw new Error(`Tablo ${satirlar.length.toLocaleString('tr-TR')} satır; Excel bir sayfada en fazla ${EXCEL_VERI_SINIRI.toLocaleString('tr-TR')} veri satırı açar. CSV olarak indirin ya da CSV Bölme ile parçalayın.`);
  }
  const ws = XLSX.utils.aoa_to_sheet([basliklar].concat(satirlar));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sayfaAdi || 'Temiz_Veri');
  return new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true })],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------------------------------------------------------------- İşlemler

function sutunIndeksi(ad) {
  const i = tablo.basliklar.indexOf(ad);
  if (i < 0) throw new Error(`"${ad}" adlı sütun yok.`);
  return i;
}

/* Sentetik veri şeması mevcut tablonun profilinden türetilir; tablo yoksa
   örnek bir müşteri şeması kullanılır. */
function semaTuret() {
  if (!tablo || !tablo.basliklar.length) {
    return [
      { name: 'musteri_id', type: 'id' }, { name: 'ad_soyad', type: 'name' }, { name: 'eposta', type: 'email' },
      { name: 'telefon', type: 'phone' }, { name: 'sehir', type: 'city' }, { name: 'tutar', type: 'decimal', min: 10, max: 5000 },
      { name: 'tarih', type: 'date' }
    ];
  }
  const profil = ProfilerEngine.profileDataset(tablo.basliklar, tablo.satirlar.slice(0, 20000));
  return profil.columns.map(k => {
    const ad = k.name, kucuk = ad.toLocaleLowerCase('tr-TR');
    if (/(^|_)(id|no|kod)$|numara/.test(kucuk)) return { name: ad, type: 'id' };
    if (k.inferredType === 'email') return { name: ad, type: 'email' };
    if (k.inferredType === 'phone') return { name: ad, type: 'phone' };
    if (k.inferredType === 'date') return { name: ad, type: 'date' };
    if (k.inferredType === 'integer') return { name: ad, type: 'integer', min: Number(k.min), max: Number(k.max) };
    if (k.inferredType === 'decimal') return { name: ad, type: 'decimal', min: Number(k.min), max: Number(k.max) };
    if (/ad|isim|name|soyad/.test(kucuk)) return { name: ad, type: 'name' };
    if (/sehir|şehir|city|il$/.test(kucuk)) return { name: ad, type: 'city' };
    return { name: ad, type: 'allowed_values', values: (k.samples || []).length ? k.samples : ['A', 'B', 'C'] };
  });
}

const islemler = {
  async yukle(id, { dosya, satirSiniri }) {
    iptalIstendi = false;
    const ext = (dosya.name.split('.').pop() || '').toLowerCase();
    let r;
    if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') r = await excelYukle(id, dosya, ext, satirSiniri);
    else if (ext === 'json') r = await jsonYukle(id, dosya);
    else r = await csvYukle(id, dosya, satirSiniri);
    ilerle(id, null, 'Tablo hazırlanıyor…');
    tabloKur(dosya.name, r.basliklar, r.satirlar, r.belgeMeta, { kitapBilgisi: r.kitapBilgisi || null, onarim: r.onarim || null });
    return ozet();
  },

  iptal() { iptalIstendi = true; return true; },

  temizle() {
    tablo = null; hat = null;
    db.dropTable('aktif_tablo');
    return true;
  },

  ozet() { return ozet(); },

  profil(id) {
    tabloVarMi();
    ilerle(id, null, `${tablo.satirlar.length.toLocaleString('tr-TR')} satırın profili çıkarılıyor…`);
    return ProfilerEngine.profileDataset(tablo.basliklar, tablo.satirlar);
  },

  dogrula(id, { kurallar }) {
    tabloVarMi();
    let kural = kurallar;
    if (!Array.isArray(kural) || !kural.length) {
      kural = [{ column: tablo.basliklar[0], type: 'not_empty', message: 'Birincil sütun boş olamaz' }];
      const eposta = tablo.basliklar.find(h => /eposta|email/i.test(h));
      if (eposta) kural.push({ column: eposta, type: 'email', message: 'Geçersiz e-posta formatı' });
    }
    ilerle(id, null, 'Kurallar denetleniyor…');
    const r = ValidatorEngine.validateDataset(tablo.basliklar, tablo.satirlar, kural);
    return { report: r.report, kurallar: kural };
  },

  sql(id, { sorgu }) {
    tabloVarMi();
    ilerle(id, null, 'Sorgu çalışıyor…');
    const r = db.executeSql(sorgu);
    return { headers: r.headers, rows: r.rows.slice(0, 200), rowCount: r.rowCount, durationMs: r.durationMs };
  },

  ddl() {
    tabloVarMi();
    return SqlEngine.generateCreateTable('aktif_tablo', tablo.basliklar, tablo.satirlar);
  },

  guvenliPaylasim(id) {
    tabloVarMi();
    ilerle(id, null, 'Hücreler taranıyor…');
    const r = PrivacyLabEngine.scanForSafeShare(tablo.basliklar, tablo.satirlar, tablo.belgeMeta);
    return Object.assign({ belgeBicimi: tablo.belgeMeta && tablo.belgeMeta.format || null }, r);
  },

  iliskiliMaske(id, { tuz }) {
    tabloVarMi();
    const sutun = 0;
    const toplam = tablo.satirlar.length;
    const yeni = new Array(toplam);
    for (let i = 0; i < toplam; i++) {
      const kopya = tablo.satirlar[i].slice();
      const gercek = kopya[sutun];
      kopya[sutun] = PrivacyLabEngine.maskDeterministic(gercek, tuz, 'ID');
      // Kasa için eşlemeyi tut (ilk görülen yazım kazanır; takma ad büyük/küçük harf duyarsızdır).
      if (kopya[sutun] && !kasa.has(kopya[sutun])) kasa.set(kopya[sutun], String(gercek).trim());
      yeni[i] = kopya;
      if ((i & 0x3FFFF) === 0) ilerle(id, i / toplam, 'Takma adlar üretiliyor…');
    }
    kasaSutunlari.add(String(tablo.basliklar[sutun]));
    tabloKur(tablo.ad, tablo.basliklar, yeni);
    return ozet();
  },

  async kasaIndir(id, { parola }) {
    if (!kasa.size) throw new Error('Kasada kayıt yok. Önce "İlişkiyi koruyan maskeleme" ile bir tabloyu maskeleyin.');
    ilerle(id, null, 'Kasa hazırlanıyor…');
    const k = PrivacyLabEngine.createMaskVault(Object.fromEntries(kasa), 'Masko Maske Kasası', {
      columns: Array.from(kasaSutunlari),
      sourceName: tablo ? tablo.ad : null
    });
    const cikti = parola ? await PrivacyLabEngine.sealMaskVault(k, parola) : k;
    return { blob: new Blob([JSON.stringify(cikti, null, 2)], { type: 'application/json' }), adet: kasa.size, sifreli: !!parola };
  },

  kasaAdedi() { return kasa.size; },

  async kasadanAc(id, { icerik, parola }) {
    tabloVarMi();
    const k = await PrivacyLabEngine.openMaskVault(icerik, parola);
    const r = PrivacyLabEngine.restoreFromVault(tablo.satirlar, k.entries);
    if (r.restoredCount) tabloKur(tablo.ad, tablo.basliklar, r.rows);
    return { restoredCount: r.restoredCount, ozet: ozet() };
  },

  panoTemizle(id, { metin }) {
    const p = FilesEngine.parseClipboardTabular(metin);
    if (!p.headers.length) return null;
    return FilesEngine.formatClipboardTabular(p.headers, p.rows.map(r => r.map(c => String(c).trim())));
  },

  panoTablo(id, { metin }) {
    const p = FilesEngine.parseClipboardTabular(metin);
    if (!p.headers.length) throw new Error('Panodaki metinde tablo bulunamadı.');
    tabloKur('Pano_Verisi.tsv', p.headers, p.rows, { format: 'pano' });
    return ozet();
  },

  jsonDuzlestir(id, { metin }) {
    const r = FilesEngine.flattenJsonRecords(metin);
    tabloKur('Düzleştirilmiş_JSON.csv', r.headers, r.rows, { format: 'json' });
    return Object.assign({ istatistik: r.stats }, ozet());
  },

  adim(id, { ayar, ad }) {
    tabloVarMi();
    ilerle(id, null, `${ad} uygulanıyor…`);
    hat.addStep(ayar, ad);
    const d = hat.getCurrentState();
    aktifYansit(d.headers, d.rows);
    return ozet();
  },

  geriAl() {
    if (!hat) return { basarili: false };
    const r = hat.undo();
    if (r.success) aktifYansit(r.current.headers, r.current.rows);
    return { basarili: r.success, mesaj: r.message || null, ozet: ozet() };
  },

  yinele() {
    if (!hat) return { basarili: false };
    const r = hat.redo();
    if (r.success) aktifYansit(r.current.headers, r.current.rows);
    return { basarili: r.success, ozet: ozet() };
  },

  adimaGit(id, { index }) {
    if (!hat) return { basarili: false };
    const r = hat.jumpToStep(index);
    if (r.success) aktifYansit(r.current.headers, r.current.rows);
    return { basarili: r.success, ozet: ozet() };
  },

  tarifIndir() {
    if (!hat) throw new Error('Henüz bir işlem akışı yok.');
    return hat.exportRecipe('Masko Özel Tarifim');
  },

  manifestIndir() {
    if (!hat) throw new Error('Henüz bir işlem akışı (pipeline) başlatılmadı.');
    return hat.exportRunManifest({ recipeName: 'Masko İşlem Reçetesi', inputName: tablo ? tablo.ad : 'kaynak_veri.csv' });
  },

  tarifYukle(id, { tarif }) {
    tabloVarMi();
    if (!tarif || !Array.isArray(tarif.steps)) throw new Error('Tarif dosyası "steps" listesi içermiyor.');
    tarif.steps.forEach((adim, i) => {
      ilerle(id, i / tarif.steps.length, `Adım ${i + 1}/${tarif.steps.length}`);
      hat.addStep(adim, adim.name || adim.type);
    });
    const d = hat.getCurrentState();
    aktifYansit(d.headers, d.rows);
    return ozet();
  },

  bosKirp() {
    tabloVarMi();
    const r = FilesEngine.trimEmptyUsedRange(tablo.basliklar, tablo.satirlar, { trimColumns: true });
    tabloKur(tablo.ad, r.headers, r.rows);
    return { istatistik: r.stats, ozet: ozet() };
  },

  formulDondur() {
    tabloVarMi();
    const s = FilesEngine.convertFormulasToStaticValues(tablo.basliklar, tablo.satirlar, { cleanErrors: true, errorReplacement: '' });
    const b = FilesEngine.breakExternalLinks(s.headers, s.rows);
    tabloKur(tablo.ad, b.headers, b.rows);
    return { formul: s.stats.formulasConvertedCount, hata: s.stats.errorsCleanedCount, baglanti: b.stats.externalLinksBrokenCount, ozet: ozet() };
  },

  pivot(id, { satirAnahtari, pivotSutunu, degerSutunu, fonksiyon }) {
    tabloVarMi();
    [satirAnahtari, pivotSutunu, degerSutunu].forEach(sutunIndeksi);
    ilerle(id, null, 'Pivot tablo hesaplanıyor…');
    const r = FilesEngine.pivotTable(tablo.basliklar, tablo.satirlar, {
      rowKeys: [satirAnahtari], pivotColumn: pivotSutunu, valueColumn: degerSutunu, aggFunction: fonksiyon || 'SUM'
    });
    tabloKur(tablo.ad.replace(/(\.[^.]+)?$/, '_pivot$1'), r.headers, r.rows);
    return ozet();
  },

  patlat(id, { sutun, ayrac }) {
    tabloVarMi();
    sutunIndeksi(sutun);
    const r = FilesEngine.explodeColumn(tablo.basliklar, tablo.satirlar, sutun, ayrac || ',');
    tabloKur(tablo.ad, r.headers, r.rows);
    return ozet();
  },

  sentetik(id, { adet }) {
    const sema = semaTuret();
    ilerle(id, null, 'Sentetik veri üretiliyor…');
    const r = FilesEngine.generateSyntheticFromSchema(sema, adet);
    tabloKur('Sentetik_Veri.csv', r.headers, r.rows, { format: 'csv' });
    return ozet();
  },

  rontgen() {
    tabloVarMi();
    if (!tablo.kitapBilgisi) throw new Error('Excel röntgeni yalnız .xlsx / .xls dosyalarında çalışır; aktif dosya ' + (tablo.belgeMeta && tablo.belgeMeta.format || 'düz metin') + '.');
    return FilesEngine.inspectWorkbookStructure(tablo.kitapBilgisi);
  },

  disaAktar(id, { bicim }) {
    tabloVarMi();
    const taban = tablo.ad.replace(/\.[^.]+$/, '') || 'masko_veri';
    if (bicim === 'xlsx') {
      ilerle(id, null, 'Excel dosyası yazılıyor…');
      return { blob: xlsxBlob(tablo.basliklar, tablo.satirlar), ad: `${taban}_temiz.xlsx` };
    }
    return { blob: csvBlob(id, tablo.basliklar, tablo.satirlar, { delimiter: ';' }), ad: `${taban}_temiz.csv` };
  },

  /* CSV kurtarma çıktısı: Excel'de doğru açılan UTF-8 BOM, ';' ayraç, formül
     korumalı, baştaki sıfırlar tırnaklı. Bozuk satırlar yüklemede ayrıldı. */
  csvOnar(id) {
    tabloVarMi();
    const taban = tablo.ad.replace(/\.[^.]+$/, '') || 'masko_veri';
    return {
      blob: csvBlob(id, tablo.basliklar, tablo.satirlar, { delimiter: ';', quoteLeadingZeros: true }),
      ad: `${taban}_onarilmis.csv`,
      onarim: tablo.onarim
    };
  }
};

self.onmessage = async function (e) {
  const { id, islem, veri } = e.data || {};
  if (islem === 'iptal') { iptalIstendi = true; return; }
  const fn = islemler[islem];
  if (!fn) { self.postMessage({ id, tamam: false, hata: 'Bilinmeyen işlem: ' + islem }); return; }
  try {
    const sonuc = await fn(id, veri || {});
    self.postMessage({ id, tamam: true, sonuc });
  } catch (err) {
    self.postMessage({ id, tamam: false, hata: err && err.message === 'İPTAL' ? 'İPTAL' : String(err && err.message || err) });
  }
};
