/**
 * Masko — PDF çizim katmanı (pdf-render.js)
 *
 * pdf.js (vendor/pdfjs, Mozilla, Apache-2.0) ile sayfaları tuvale çizer ve
 * sayfa metninin konumlarını verir. Küçük resimler, PDF'den resim, kalıcı
 * karartma ve OCR bunu kullanır.
 *
 * Sıfır ağ: PDF yalnız bellekteki baytlarla açılır. Yazı tipi, karakter
 * haritası ve WASM yükleme adresleri verilmez; pdf.js gömülü olmayan yazı
 * tiplerinde sistem yazı tipini kullanır. isEvalSupported kapalı (CSP de
 * eval'i engeller). Kütüphane yalnız ilk ihtiyaçta yüklenir: sayfa açılışını
 * 1,8 MB'lık modül yavaşlatmasın.
 */
(function (root) {
  'use strict';

  /* TARAYICI SÜRÜMÜ
     vendor/pdfjs, pdf.js'in eski tarayıcılar için çevrilmiş "legacy"
     yapısıdır; Mozilla bunu Chrome 125 ve sonrası için destekler (asıl yapı
     en son Chrome'u ister: Math.sumPrecise 147, Map.getOrInsertComputed 145,
     Uint8Array.toHex 140). Uzantının geri kalanı Chrome 102'de çalışır
     (manifest), bu yüzden pdf.js'e dayanan araçlar daha eski sürümde
     anlaşılmaz bir hatayla değil, bu mesajla durur. */
  const EN_DUSUK_CHROME = 125;
  const GUNCELLE_MESAJI = `Bu araç Chrome ${EN_DUSUK_CHROME} ya da daha yeni bir sürüm ister. Chrome'u güncelleyin: Ayarlar › Chrome hakkında.`;

  function chromeSurumu() {
    const ua = typeof navigator !== 'undefined' ? navigator : {};
    const marka = ua.userAgentData && Array.isArray(ua.userAgentData.brands) &&
      ua.userAgentData.brands.find(b => b.brand === 'Chromium');
    if (marka) return Number(marka.version);
    const m = /Chrom(?:e|ium)\/(\d+)/.exec(ua.userAgent || '');
    return m ? Number(m[1]) : null;
  }

  /** Sürüm bilinmiyorsa (Chromium değil) denenir; kütüphane yüklenemezse yine açık hata döner. */
  function destekleniyor() {
    const surum = chromeSurumu();
    return surum === null || surum >= EN_DUSUK_CHROME;
  }

  let modul = null;

  function kutuphane() {
    if (!destekleniyor()) return Promise.reject(new Error(GUNCELLE_MESAJI));
    if (!modul) {
      const kok = new URL('../vendor/pdfjs/', document.baseURI).href;
      modul = import(kok + 'pdf.min.mjs').then(m => {
        m.GlobalWorkerOptions.workerSrc = kok + 'pdf.worker.min.mjs';
        return m;
      }, err => {
        modul = null;   // sonraki denemede yeniden yüklensin
        throw new Error(`PDF görüntüleyici yüklenemedi (${err.message}). ${GUNCELLE_MESAJI}`);
      });
    }
    return modul;
  }

  /** PDF'i açar. pdf.js veriyi worker'a aktarıp sahiplenir; kopya verilir. */
  async function ac(bytes) {
    const lib = await kutuphane();
    return lib.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
      useSystemFonts: true,
      enableXfa: false
    }).promise;
  }

  /**
   * Sayfayı tuvale çizer. Sayfanın kendi dönüşü (/Rotate) ve görünür alanı
   * (CropBox) uygulanır: tuval kullanıcının gördüğü sayfadır.
   * @param belge  ac() sonucu
   * @param {number} no  1 tabanlı sayfa numarası
   * @param {{ genislik?: number, dpi?: number }} ayar  piksel genişliği ya da DPI
   * @returns {Promise<HTMLCanvasElement>}
   */
  async function sayfaCiz(belge, no, ayar = {}) {
    const sayfa = await belge.getPage(no);
    const temel = sayfa.getViewport({ scale: 1 });
    const olcek = ayar.dpi ? ayar.dpi / 72 : (ayar.genislik || 160) / temel.width;
    const gorunum = sayfa.getViewport({ scale: olcek });
    const tuval = document.createElement('canvas');
    tuval.width = Math.max(1, Math.round(gorunum.width));
    tuval.height = Math.max(1, Math.round(gorunum.height));
    const c = tuval.getContext('2d');
    c.fillStyle = '#fff';                     // şeffaf PDF arka planı JPEG'de siyah çıkmasın
    c.fillRect(0, 0, tuval.width, tuval.height);
    await sayfa.render({ canvasContext: c, viewport: gorunum }).promise;
    sayfa.cleanup();
    return tuval;
  }

  /**
   * Sayfa metni ve her parçanın görünen sayfadaki kutusu (0–1 oranı, sol üst
   * köşe başlangıç). Satırlar arasında boşluk bırakılarak tek metin kurulur;
   * bas/son o parçanın bu metindeki konumudur.
   * aile: parçanın yazı tipi ailesi (kısmi eşleşmede harf genişliği ölçmek için).
   * @returns {Promise<{ metin: string, ogeler: Array<{ bas: number, son: number, x: number, y: number, w: number, h: number, aile: string }> }>}
   */
  async function metinKonumlari(belge, no) {
    const lib = await kutuphane();
    const sayfa = await belge.getPage(no);
    const gorunum = sayfa.getViewport({ scale: 1 });
    const icerik = await sayfa.getTextContent();
    let metin = '';
    const ogeler = [];
    for (const oge of icerik.items) {
      if (typeof oge.str !== 'string' || !oge.str) { if (oge.hasEOL) metin += '\n'; continue; }
      const t = lib.Util.transform(gorunum.transform, oge.transform);
      const yukseklik = Math.hypot(t[2], t[3]) || 10;
      const genislik = (oge.width || 0) * gorunum.scale;
      const bas = metin.length;
      metin += oge.str;
      ogeler.push({
        bas, son: metin.length,
        x: t[4] / gorunum.width, y: (t[5] - yukseklik) / gorunum.height,
        w: genislik / gorunum.width, h: (yukseklik * 1.2) / gorunum.height,
        aile: (icerik.styles && icerik.styles[oge.fontName] && icerik.styles[oge.fontName].fontFamily) || 'sans-serif'
      });
      metin += oge.hasEOL ? '\n' : ' ';
    }
    sayfa.cleanup();
    return { metin, ogeler };
  }

  /* Parçanın içindeki kısmi eşleşmenin yeri, harf genişlikleri o yazı tipi
     ailesiyle ölçülerek bulunur ("No: " dar, rakamlar geniş). Gömülü yazı
     tipi sistemdekinden biraz farklı olabilir; kenar payı bunu karşılar. */
  let olcer = null;
  function olc(metin, aile) {
    if (!olcer) {
      if (typeof document === 'undefined') return null;
      olcer = document.createElement('canvas').getContext('2d');
    }
    olcer.font = `100px ${aile}`;
    return olcer.measureText(metin).width;
  }
  function oran(parca, n, aile) {
    if (n <= 0) return 0;
    if (n >= parca.length) return 1;
    const tum = olc(parca, aile), on = olc(parca.slice(0, n), aile);
    return tum > 0 && on !== null ? on / tum : n / parca.length;
  }

  /**
   * Metindeki [bas, son) aralığını kutulara çevirir. Kenarlarda yarım harf
   * pay bırakılır ki ölçü farkında harf ucu açıkta kalmasın: karartmada
   * fazlası zararsız, eksiği sızıntıdır.
   */
  function araligiKutula(konumlar, bas, son) {
    const kutular = [];
    for (const o of konumlar.ogeler) {
      if (o.son <= bas || o.bas >= son) continue;
      const parca = konumlar.metin.slice(o.bas, o.son);
      const uzunluk = Math.max(1, parca.length);
      const a = Math.max(bas, o.bas) - o.bas, b = Math.min(son, o.son) - o.bas;
      const sol = o.w * oran(parca, a, o.aile), sag = o.w * oran(parca, b, o.aile);
      const pay = o.w / uzunluk * 0.5;
      const x = Math.max(0, o.x + sol - (a > 0 ? pay : pay / 2));
      const bitis = Math.min(1, o.x + sag + (b < uzunluk ? pay : pay / 2));
      kutular.push({ x, y: Math.max(0, o.y), w: Math.max(0, bitis - x), h: o.h });
    }
    return kutular;
  }

  /** Belgeyi kapatıp worker belleğini bırakır (pdf.js 6'da yükleme görevi üzerinden). */
  function kapat(belge) {
    if (!belge) return;
    if (belge.loadingTask && belge.loadingTask.destroy) belge.loadingTask.destroy();
    else if (typeof belge.destroy === 'function') belge.destroy();
  }

  root.PdfRender = { ac, kapat, sayfaCiz, metinKonumlari, araligiKutula, destekleniyor, EN_DUSUK_CHROME, GUNCELLE_MESAJI };
})(typeof self !== 'undefined' ? self : this);
