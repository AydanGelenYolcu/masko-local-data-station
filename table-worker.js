/* Maskeleme İstasyonu — Tablo Web Worker'ı
 *
 * Ağır iş burada yapılır: dosya okuma, ayrıştırma ve kolon profilleme.
 * 50 MB'lık bir Excel'i ana thread'de açmak arayüzü dakikalarca dondurur.
 *
 * Tip TESPİTİ burada yapılmaz: tespit, katalogdaki fonksiyon nesnelerine
 * bağlıdır ve fonksiyonlar postMessage ile kopyalanamaz. Worker yalnızca
 * saf veriden oluşan profili gönderir; tespit ana thread'de eklenir.
 *
 * Ayrıştırılmış satırlar worker'ın belleğinde kalır — başlık satırı veya
 * sayfa değiştiğinde dosyayı baştan okumaya gerek olmasın diye.
 */

// table-engine.js ve type-catalog.js kendilerini window'a yazıyor.
self.window = self;

importScripts(
  "vendor/xlsx.full.min.js",
  "checkdigits.js",
  "type-catalog.js",
  "intl-pack.js",
  "passo-pack.js",
  "csv-io.js",        // CSV okuma/yazma ve formül koruması: iki motor da kullanır
  "table-engine.js",
  "file-mask-engine.js"
);

var TE = self.TableEngine;
var dosyalar = {};   // id -> { sheets: [...] }

function gonder(mesaj){ self.postMessage(mesaj); }

function hata(id, e){
  gonder({ id: id, tip: "hata", mesaj: (e && e.message) ? e.message : String(e) });
}

// Profil saf veridir (dizi, sayı, metin) — structured clone ile sorunsuz gider.
function profilCikar(id, sheetIndex, headerRowIdx){
  var kayit = dosyalar[id];
  if(!kayit){ hata(id, new Error("Dosya worker belleğinde bulunamadı")); return; }
  var sheet = kayit.sheets[sheetIndex];
  if(!sheet){ hata(id, new Error("Sayfa bulunamadı")); return; }

  gonder({ id: id, tip: "ilerleme", asama: "profilleme", yuzde: 0.85 });

  var idx = (headerRowIdx === undefined || headerRowIdx === null)
    ? TE.findHeaderRow(sheet.rows) : headerRowIdx;
  var profil = TE.profileTable(sheet.rows, idx);

  // Başlık satırı seçicisinin önizlemesi için ilk satırlar
  var onizleme = sheet.rows.slice(0, 15).map(function(r){
    return (r || []).slice(0, 12).map(function(c){ return String(c === undefined ? "" : c); });
  });

  gonder({
    id: id,
    tip: "profil",
    sheetIndex: sheetIndex,
    profil: profil,
    onizleme: onizleme,
    onizlemeSatirSayisi: Math.min(15, sheet.rows.length),
    delimiter: sheet.delimiter || null
  });
}

self.onmessage = function(e){
  var m = e.data || {};

  if(m.tip === "dosya"){
    var id = m.id;
    gonder({ id: id, tip: "ilerleme", asama: "okuma", yuzde: 0 });
    try {
      TE.parseFile(m.file, function(asama, yuzde){
        // Ayrıştırma toplam işin %85'i sayılıyor, kalanı profilleme
        gonder({ id: id, tip: "ilerleme", asama: asama, yuzde: Math.min(0.85, (yuzde || 0) * 0.85) });
      }).then(function(sheets){
        if(!sheets.length){ hata(id, new Error("Dosyada okunabilir tablo yok")); return; }
        dosyalar[id] = { sheets: sheets };
        gonder({
          id: id, tip: "sayfalar",
          sheets: sheets.map(function(s){ return { name: s.name, satirSayisi: s.rows.length }; })
        });
        profilCikar(id, 0, null);
      }).catch(function(err){ hata(id, err); });
    } catch(err){ hata(id, err); }
    return;
  }

  if(m.tip === "profille"){
    try { profilCikar(m.id, m.sheetIndex || 0, m.headerRowIdx); }
    catch(err){ hata(m.id, err); }
    return;
  }

  if(m.tip === "maskele"){
    try {
      var kayit = dosyalar[m.id];
      if(!kayit){ hata(m.id, new Error("Dosya worker belleğinde bulunamadı")); return; }
      var sheet = kayit.sheets[m.sheetIndex || 0];
      if(!sheet){ hata(m.id, new Error("Sayfa bulunamadı")); return; }
      var res = self.FileMaskEngine.maskEntireTable(sheet.rows, m.rules, {
        safeFormulas: m.safeFormulas,
        headerRowIdx: m.headerRowIdx,
        headers: m.headers
      });
      gonder({ id: m.id, tip: "maskeleSonuc", headers: res.headers, maskedRows: res.maskedRows, stats: res.stats, previewDiff: res.previewDiff });
    } catch(err){ hata(m.id, err); }
    return;
  }

  // Sentetik satırların dosyanın TÜM satırlarına karşı kopya denetimi. Sonuç
  // kendi istek numarasıyla döner (aynı dosyanın maskeleme isteğiyle karışmaz);
  // hata olursa sonuç null gelir, arayüz örnek denetimiyle kalır.
  if(m.tip === "kopyaDenetimi"){
    var sonuc = null;
    try {
      var kd = dosyalar[m.id];
      var ks = kd && kd.sheets[m.sheetIndex || 0];
      if(ks) sonuc = TE.tamKopyaDenetimi(ks.rows, m.headerRowIdx || 0, m.kolonSayisi, m.satirlar || []);
    } catch(err){ sonuc = null; }
    gonder({ id: m.id, istek: m.istek, tip: "kopyaSonuc", sonuc: sonuc });
    return;
  }

  if(m.tip === "kapat"){
    delete dosyalar[m.id];
    return;
  }
};
