/**
 * Masko — Çevrimdışı Güvenli PDF Motoru (pdf-engine.js)
 *
 * %100 İstemci Tarafı (Client-Side), Sıfır Ağ İsteği (Zero Network).
 * pdf-lib kütüphanesini kullanarak tarayıcı hafızasında PDF birleştirme,
 * bölme, sayfa çıkarma, döndürme ve silme işlemlerini yürütür.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/pdf-lib.min.js'));
  } else {
    root.PdfEngine = factory(root.PDFLib);
  }
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';

  if (!PDFLib) {
    throw new Error('PDFLib kütüphanesi yüklenemedi. Lütfen vendor/pdf-lib.min.js dosyasının mevcut olduğundan emin olun.');
  }

  const { PDFDocument, degrees, StandardFonts, rgb, PDFName, PDFBool, PDFHexString } = PDFLib;

  /* TÜRKÇE YAZI TİPİ
     PDF'in yerleşik yazı tipleri (Helvetica, Times, Courier) dosyaya gömülmez;
     her görüntüleyici kendi kopyasını kullanır ve bu kopyalarda ğ, ş, ı, İ
     glifleri vardır. Eksik olan kodlamadır: pdf-lib WinAnsi (Windows-1252)
     kullanır, orada Türkçe harflerin kodu yoktur ve @cantoo çatalı bu harfleri
     hata vermeden "?" yazar. Windows-1254 (Türkçe), WinAnsi'nin altı kodunu
     (Ð Ý Þ ð ý þ) Türkçe harflere vermiş hâlidir; yazı tipi sözlüğüne aynısı
     /Differences ile yazılır. Gömülü yazı tipi, yeni dosya ya da bağımlılık
     gerekmez; metin seçilebilir ve aranabilir kalır. */
  const TURKCE_GLIFLER = {
    'Ğ': [0xD0, 'Gbreve'], 'İ': [0xDD, 'Idotaccent'], 'Ş': [0xDE, 'Scedilla'],
    'ğ': [0xF0, 'gbreve'], 'ı': [0xFD, 'dotlessi'], 'ş': [0xFE, 'scedilla']
  };
  const TURKCE_FARKLAR = [0xD0, 'Gbreve', 0xDD, 'Idotaccent', 'Scedilla', 0xF0, 'gbreve', 0xFD, 'dotlessi', 'scedilla'];
  const TURKCEYE_VERILEN = new Set([0xD0, 0xDD, 0xDE, 0xF0, 0xFD, 0xFE]);
  let winAnsi = null;

  /** Karakterin kodu ve glif adı; yazılamıyorsa null. Sekme ve satır sonu boşluk olur. */
  function turkceGlif(ch) {
    if (ch === '\t' || ch === '\n' || ch === '\r') ch = ' ';
    const t = TURKCE_GLIFLER[ch];
    if (t) return { kod: t[0], ad: t[1] };
    if (!winAnsi) winAnsi = PDFLib.StandardFontEmbedder.for(StandardFonts.Helvetica).encoding;
    const cp = ch.codePointAt(0);
    if (!winAnsi.canEncodeUnicodeCodePoint(cp)) return null;
    const g = winAnsi.encodeUnicodeCodePoint(cp);
    return TURKCEYE_VERILEN.has(g.code) ? null : { kod: g.code, ad: g.name };
  }

  /** Metindeki ilk yazılamayan karakter (Kiril, emoji…); hepsi yazılabiliyorsa null. */
  function yazilamayanKarakter(metin) {
    for (const ch of String(metin)) if (!turkceGlif(ch)) return ch;
    return null;
  }

  /**
   * Belgeye Türkçe harfleri yazabilen yerleşik yazı tipi ekler. Dönen nesne
   * pdf-lib'in PDFFont'udur: page.drawText ve form görünümleri olduğu gibi
   * kullanır. Ölçüler yerleşik yazı tipinin kendi glif genişlikleridir.
   * @param {PDFDocument} doc
   * @param {string} [ad]  Helvetica, Times-Roman, Courier ailesinden biri
   */
  function turkceYaziTipi(doc, ad = StandardFonts.Helvetica) {
    const temel = PDFLib.StandardFontEmbedder.for(ad);
    const glifler = metin => Array.from(String(metin), ch => {
      const g = turkceGlif(ch);
      if (!g) throw new Error(`"${ch}" karakteri PDF'in yerleşik yazı tipiyle yazılamıyor.`);
      return g;
    });
    const ref = doc.context.register(doc.context.obj({
      Type: 'Font', Subtype: 'Type1', BaseFont: ad,
      Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: TURKCE_FARKLAR }
    }));
    // PDFFont gömücünün türünü denetler: yerleşik gömücüden türetilir, yalnız kodlama değişir.
    const gomucu = Object.create(temel);
    gomucu.encodeText = metin => PDFHexString.of(glifler(metin).map(g => g.kod.toString(16).padStart(2, '0')).join('').toUpperCase());
    gomucu.widthOfTextAtSize = (metin, boyut) => glifler(metin).reduce((t, g) => t + temel.widthOfGlyph(g.ad), 0) * boyut / 1000;
    gomucu.embedIntoContext = async () => ref;   // sözlük yukarıda hazır
    return PDFLib.PDFFont.of(ref, doc, gomucu);
  }

  // A4 ve Letter, PDF noktası (1/72 inç)
  const SAYFA_BOYUTLARI = { A4: [595.28, 841.89], Letter: [612, 792] };
  const MM = 72 / 25.4;

  function sinirla(deger, en, ust, varsayilan) {
    const n = Number(deger);
    return Number.isFinite(n) ? Math.min(ust, Math.max(en, n)) : varsayilan;
  }

  /* GÖRÜNÜR YÜZEY
     Sayfaya çizim PDF'in kendi koordinatlarında yapılır, ama kullanıcı sayfayı
     /Rotate uygulanmış hâliyle görür. 90° döndürülmüş bir sayfada "alt orta"ya
     konan numara aksi hâlde yan durur ve yanlış kenara düşer. Bu yardımcı,
     görünen sayfanın sol alt köşesine göre verilen bir noktayı sayfa
     koordinatına çevirir; çizimin açısına da sayfanın açısı eklenir. */
  function gorunurYuzey(sayfa) {
    const kutu = sayfa.getCropBox();
    const r = ((sayfa.getRotation().angle % 360) + 360) % 360;
    const yan = r === 90 || r === 270;
    return {
      r,
      genislik: yan ? kutu.height : kutu.width,
      yukseklik: yan ? kutu.width : kutu.height,
      // Görünen (vx, vy) → sayfa koordinatı
      nokta(vx, vy) {
        const { x, y, width: w, height: h } = kutu;
        if (r === 90) return { x: x + w - vy, y: y + vx };
        if (r === 180) return { x: x + w - vx, y: y + h - vy };
        if (r === 270) return { x: x + vy, y: y + h - vx };
        return { x: x + vx, y: y + vy };
      },
      aci(gorunurAci) { return degrees((gorunurAci || 0) + r); }
    };
  }

  function sayfaKumesi(sayfalar, toplam) {
    if (!Array.isArray(sayfalar)) return null;
    return new Set(sayfalar.filter(i => Number.isInteger(i) && i >= 0 && i < toplam));
  }

  const ENCRYPTED_PDF_MESSAGE =
    'Bu PDF şifreli (parola korumalı veya yazdırma/kopyalama izni kısıtlı). ' +
    'Önce "Şifre" sekmesinden parolasını girip şifresini kaldırın, sonra ' +
    'şifresiz kopyayla devam edin.';

  /**
   * Kaynak PDF'i yükler; şifreliyse açık bir hatayla reddeder.
   * pdf-lib şifre çözemez: ignoreEncryption ile yüklenen şifreli bir belgeden
   * kopyalanan sayfaların akışları hâlâ şifrelidir ve yeni belgede (Encrypt
   * sözlüğü olmadan) boş/bozuk görünür — kullanıcı bunu fark etmeden kaydederdi.
   *
   * @param {ArrayBuffer|Uint8Array} pdfBytes
   * @returns {Promise<PDFDocument>}
   */
  async function loadSourcePdf(pdfBytes) {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    if (doc.isEncrypted) {
      const err = new Error(ENCRYPTED_PDF_MESSAGE);
      err.code = 'PDF_ENCRYPTED';
      throw err;
    }
    return doc;
  }

  /**
   * PDF'in şifreli olup olmadığını döner (hata fırlatmaz).
   *
   * @param {ArrayBuffer|Uint8Array} pdfBytes
   * @returns {Promise<boolean>}
   */
  async function isPdfEncrypted(pdfBytes) {
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    return Boolean(doc.isEncrypted);
  }

  /**
   * Kullanıcının girdiği sayfa aralığı dizgisini 0-tabanlı indis dizisine çevirir.
   * Örnek: "1-3, 5, 8-10" -> [0, 1, 2, 4, 7, 8, 9]
   *
   * @param {string} rangeStr - Kullanıcı girdisi (örn. "1-3, 5, 8")
   * @param {number} totalPages - Belgedeki toplam sayfa sayısı
   * @returns {number[]} 0-tabanlı geçerli sayfa indisleri (sıralı ve tekil)
   */
  function parsePageRanges(rangeStr, totalPages) {
    if (!rangeStr || typeof rangeStr !== 'string') return [];
    const cleanStr = rangeStr.trim();
    if (!cleanStr) return [];

    const indices = new Set();
    const parts = cleanStr.split(/[,;\s]+/);

    for (const part of parts) {
      if (!part) continue;
      if (part.includes('-')) {
        const [startStr, endStr] = part.split('-');
        let start = parseInt(startStr, 10);
        let end = parseInt(endStr, 10);

        if (isNaN(start) && isNaN(end)) continue;
        if (isNaN(start)) start = 1;
        if (isNaN(end)) end = totalPages;

        if (start > end) {
          const temp = start;
          start = end;
          end = temp;
        }

        const s = Math.max(1, start);
        const e = Math.min(totalPages, end);
        for (let i = s; i <= e; i++) {
          indices.add(i - 1);
        }
      } else {
        const num = parseInt(part, 10);
        if (!isNaN(num) && num >= 1 && num <= totalPages) {
          indices.add(num - 1);
        }
      }
    }

    return Array.from(indices).sort((a, b) => a - b);
  }

  /**
   * PDF belgesini inceler ve temel bilgileri döner.
   *
   * @param {ArrayBuffer|Uint8Array} pdfBytes
   * @returns {Promise<{ pageCount: number, title: string, author: string, pages: Array<{ index: number, pageNum: number, width: number, height: number, rotation: number }> }>}
   */
  async function getPdfInfo(pdfBytes) {
    const doc = await loadSourcePdf(pdfBytes);
    const pageCount = doc.getPageCount();
    const title = doc.getTitle() || '';
    const author = doc.getAuthor() || '';
    const producer = doc.getProducer() || '';

    const pages = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.getPage(i);
      const { width, height } = page.getSize();
      const rotation = page.getRotation().angle;
      pages.push({
        index: i,
        pageNum: i + 1,
        width: Math.round(width),
        height: Math.round(height),
        rotation
      });
    }

    return { pageCount, title, author, producer, pages };
  }

  /**
   * Birden fazla PDF dosyasını tek bir PDF belgesinde birleştirir.
   *
   * @param {Array<ArrayBuffer|Uint8Array>} pdfBuffers - Birleştirilecek PDF bayt dizileri
   * @returns {Promise<Uint8Array>}
   */
  async function mergePdfs(pdfBuffers) {
    if (!Array.isArray(pdfBuffers) || pdfBuffers.length === 0) {
      throw new Error('Birleştirilecek en az bir PDF dosyası seçilmelidir.');
    }

    const mergedDoc = await PDFDocument.create();

    for (const buf of pdfBuffers) {
      const srcDoc = await loadSourcePdf(buf);
      const pageIndices = srcDoc.getPageIndices();
      const copiedPages = await mergedDoc.copyPages(srcDoc, pageIndices);
      for (const page of copiedPages) {
        mergedDoc.addPage(page);
      }
    }

    return await mergedDoc.save();
  }

  /**
   * Tek bir PDF'ten belirli sayfaları ayıklar / böler.
   *
   * @param {ArrayBuffer|Uint8Array} pdfBytes - Kaynak PDF
   * @param {number[]} pageIndices - Kopyalanacak 0-tabanlı sayfa indisleri
   * @returns {Promise<Uint8Array>}
   */
  async function extractPages(pdfBytes, pageIndices) {
    if (!Array.isArray(pageIndices) || pageIndices.length === 0) {
      throw new Error('Ayıklanacak en az bir sayfa belirtilmelidir.');
    }

    const srcDoc = await loadSourcePdf(pdfBytes);
    const newDoc = await PDFDocument.create();

    const validIndices = pageIndices.filter(i => i >= 0 && i < srcDoc.getPageCount());
    if (validIndices.length === 0) {
      throw new Error('Geçerli sayfa numarası bulunamadı.');
    }

    const copiedPages = await newDoc.copyPages(srcDoc, validIndices);
    for (const page of copiedPages) {
      newDoc.addPage(page);
    }

    return await newDoc.save();
  }

  /**
   * Sayfaları döndürme, yeniden sıralama ve silme işlemlerini tek adımda uygular.
   *
   * @param {ArrayBuffer|Uint8Array} pdfBytes - Kaynak PDF
   * Dizi sırası çıktının sayfa sırasıdır. { blank: true, width, height }
   * öğesi o konuma boş sayfa ekler.
   *
   * @param {Array<{ originalIndex?: number, rotationDelta?: number, isDeleted?: boolean, blank?: boolean, width?: number, height?: number }>} pageOperations
   * @returns {Promise<Uint8Array>}
   */
  async function processPages(pdfBytes, pageOperations) {
    const srcDoc = await loadSourcePdf(pdfBytes);
    const newDoc = await PDFDocument.create();
    const toplam = srcDoc.getPageCount();

    const activeOps = pageOperations.filter(op => !op.isDeleted &&
      (op.blank || (op.originalIndex >= 0 && op.originalIndex < toplam)));
    if (activeOps.length === 0) {
      throw new Error('İşlem sonucunda belgede en az bir sayfa kalmalıdır.');
    }

    // İlgili sayfaları kopyala
    const originalIndices = activeOps.filter(op => !op.blank).map(op => op.originalIndex);
    const copiedPages = originalIndices.length ? await newDoc.copyPages(srcDoc, originalIndices) : [];

    let k = 0;
    for (const op of activeOps) {
      if (op.blank) {
        const [w, h] = SAYFA_BOYUTLARI.A4;
        const page = newDoc.addPage([sinirla(op.width, 36, 14400, w), sinirla(op.height, 36, 14400, h)]);
        if (op.rotationDelta) page.setRotation(degrees((op.rotationDelta + 360) % 360));
        continue;
      }
      const page = copiedPages[k++];
      if (op.rotationDelta) {
        const currentRot = page.getRotation().angle;
        const newRot = (currentRot + op.rotationDelta + 360) % 360;
        page.setRotation(degrees(newRot));
      }
      newDoc.addPage(page);
    }

    return await newDoc.save();
  }

  /**
   * Sayfa numarası ekler. Biçimde {n} sayfa numarası, {toplam} son numaradır.
   * PDF'in yerleşik yazı tipi Türkçe ğ/ş/ı/İ harflerini yazamadığı için biçim
   * yalnız Latin harf, rakam ve noktalamadan oluşabilir ("Sayfa {n} / {toplam}").
   *
   * @param {Uint8Array} pdfBytes
   * @param {{ konum?: string, bicim?: string, baslangic?: number, yaziBoyutu?: number,
   *           kenar?: number, ilkSayfayiAtla?: boolean }} ayar  kenar: nokta
   */
  const NUMARA_KONUMLARI = ['alt-orta', 'alt-sag', 'alt-sol', 'ust-orta', 'ust-sag', 'ust-sol'];
  async function addPageNumbers(pdfBytes, ayar = {}) {
    const konum = NUMARA_KONUMLARI.includes(ayar.konum) ? ayar.konum : 'alt-orta';
    const bicim = ayar.bicim || '{n}';
    const yazilamayan = yazilamayanKarakter(bicim);
    if (yazilamayan) {
      throw new Error(`Sayfa numarası biçimindeki "${yazilamayan}" karakteri yazılamıyor. Türkçe ve Batı Avrupa harfleri, rakam ve noktalama kullanılabilir.`);
    }
    const baslangic = Number.isInteger(ayar.baslangic) ? ayar.baslangic : 1;
    const boyut = sinirla(ayar.yaziBoyutu, 6, 48, 11);
    const kenar = sinirla(ayar.kenar, 0, 300, 24);
    const atla = !!ayar.ilkSayfayiAtla;

    const doc = await loadSourcePdf(pdfBytes);
    const font = turkceYaziTipi(doc);
    const sayfalar = doc.getPages();
    const sonNo = baslangic + sayfalar.length - (atla ? 2 : 1);

    sayfalar.forEach((sayfa, i) => {
      if (atla && i === 0) return;
      const n = baslangic + i - (atla ? 1 : 0);
      const metin = bicim.replace(/\{n\}/g, String(n)).replace(/\{toplam\}/g, String(sonNo));
      const genislik = font.widthOfTextAtSize(metin, boyut);
      const y = gorunurYuzey(sayfa);
      const yatay = konum.endsWith('orta') ? (y.genislik - genislik) / 2
        : konum.endsWith('sag') ? y.genislik - kenar - genislik : kenar;
      const dikey = konum.startsWith('alt') ? kenar : y.yukseklik - kenar - boyut * 0.72;
      const p = y.nokta(yatay, dikey);
      // Yazı tipi seçeneğe değil sayfaya verilir: seçenekle verilince pdf-lib
      // sayfaya kullanılmayan bir Helvetica ve aynı yazı tipi için ek adlar ekler.
      sayfa.setFont(font);
      sayfa.drawText(metin, { x: p.x, y: p.y, size: boyut, color: rgb(0.11, 0.13, 0.14), rotate: y.aci(0) });
    });
    return await doc.save();
  }

  /**
   * Filigran: PNG/JPEG görseli her sayfaya saydam basar. Metin filigranı
   * arayüzde tuvale çizilip PNG olarak verilir; böylece kalın sistem yazı
   * tipiyle görünür ve belgenin seçilebilir metnine karışmaz.
   *
   * @param {Uint8Array} pdfBytes
   * @param {{ resim: Uint8Array, mime: string, opaklik?: number, aci?: number,
   *           olcek?: number, dose?: boolean, sayfalar?: number[] }} ayar
   *   olcek: görselin sayfa genişliğine oranı; dose: sayfayı karo karo kaplar
   */
  async function addImageWatermark(pdfBytes, ayar = {}) {
    if (!ayar.resim || !ayar.resim.length) throw new Error('Filigran görseli yok.');
    const doc = await loadSourcePdf(pdfBytes);
    const gorsel = /png/i.test(ayar.mime || '') ? await doc.embedPng(ayar.resim) : await doc.embedJpg(ayar.resim);
    const opaklik = sinirla(ayar.opaklik, 0.02, 1, 0.25);
    const aci = sinirla(ayar.aci, -360, 360, 0);
    const olcek = sinirla(ayar.olcek, 0.05, 1, 0.5);
    const secili = sayfaKumesi(ayar.sayfalar, doc.getPageCount());
    const radyan = aci * Math.PI / 180;

    doc.getPages().forEach((sayfa, i) => {
      if (secili && !secili.has(i)) return;
      const y = gorunurYuzey(sayfa);
      const w = y.genislik * olcek;
      const h = w * gorsel.height / gorsel.width;
      // Görsel kendi merkezi etrafında döner: sol alt köşesi merkeze göre döndürülür.
      const ciz = (mx, my) => {
        const ox = -w / 2, oy = -h / 2;
        const vx = mx + ox * Math.cos(radyan) - oy * Math.sin(radyan);
        const vy = my + ox * Math.sin(radyan) + oy * Math.cos(radyan);
        const p = y.nokta(vx, vy);
        sayfa.drawImage(gorsel, { x: p.x, y: p.y, width: w, height: h, rotate: y.aci(aci), opacity: opaklik });
      };
      if (!ayar.dose) { ciz(y.genislik / 2, y.yukseklik / 2); return; }
      const adimX = w * 1.4, adimY = Math.max(h * 2.2, 60);
      for (let my = adimY / 2; my < y.yukseklik + adimY; my += adimY) {
        for (let mx = adimX / 2; mx < y.genislik + adimX; mx += adimX) ciz(mx, my);
      }
    });
    return await doc.save();
  }

  /**
   * PNG/JPEG görsellerinden PDF. Diğer biçimler (WebP, GIF, BMP) arayüzde
   * tuval üzerinden PNG'ye çevrilip verilir.
   *
   * @param {Array<{ bytes: Uint8Array, mime: string }>} resimler
   * @param {{ sayfaBoyutu?: 'resim'|'A4'|'Letter', yon?: 'otomatik'|'dikey'|'yatay', kenar?: number }} ayar  kenar: nokta
   */
  async function imagesToPdf(resimler, ayar = {}) {
    if (!Array.isArray(resimler) || !resimler.length) throw new Error('En az bir görsel seçilmelidir.');
    const doc = await PDFDocument.create();
    const kenar = sinirla(ayar.kenar, 0, 200, 0);
    const boyutAdi = SAYFA_BOYUTLARI[ayar.sayfaBoyutu] ? ayar.sayfaBoyutu : 'resim';
    for (const r of resimler) {
      const gorsel = /png/i.test(r.mime || '') ? await doc.embedPng(r.bytes) : await doc.embedJpg(r.bytes);
      let sw, sh;
      if (boyutAdi === 'resim') {
        sw = gorsel.width + 2 * kenar; sh = gorsel.height + 2 * kenar;
      } else {
        const [a, b] = SAYFA_BOYUTLARI[boyutAdi];
        const yatay = ayar.yon === 'yatay' || (ayar.yon !== 'dikey' && gorsel.width > gorsel.height);
        [sw, sh] = yatay ? [b, a] : [a, b];
      }
      const sayfa = doc.addPage([sw, sh]);
      const olcek = Math.min((sw - 2 * kenar) / gorsel.width, (sh - 2 * kenar) / gorsel.height);
      const w = gorsel.width * olcek, h = gorsel.height * olcek;
      sayfa.drawImage(gorsel, { x: (sw - w) / 2, y: (sh - h) / 2, width: w, height: h });
    }
    return await doc.save();
  }

  /**
   * Sayfa kenarlarını kırpar (görünen yüzeye göre, milimetre). Görüntüleyiciler
   * yalnız CropBox içini gösterir; içerik silinmez, gizlenir.
   *
   * @param {Uint8Array} pdfBytes
   * @param {{ ust?: number, alt?: number, sol?: number, sag?: number, sayfalar?: number[] }} ayar
   */
  async function cropPages(pdfBytes, ayar = {}) {
    const mm = k => sinirla(ayar[k], 0, 2000, 0) * MM;
    const ust = mm('ust'), alt = mm('alt'), sol = mm('sol'), sag = mm('sag');
    if (!(ust || alt || sol || sag)) throw new Error('Kırpılacak bir kenar payı girin.');
    const doc = await loadSourcePdf(pdfBytes);
    const secili = sayfaKumesi(ayar.sayfalar, doc.getPageCount());
    doc.getPages().forEach((sayfa, i) => {
      if (secili && !secili.has(i)) return;
      const r = ((sayfa.getRotation().angle % 360) + 360) % 360;
      // Görünen kenarlar → sayfa koordinatındaki kenarlar (bkz. gorunurYuzey)
      const [L, B, R, T] = r === 90 ? [ust, sol, alt, sag]
        : r === 180 ? [sag, ust, sol, alt]
        : r === 270 ? [alt, sag, ust, sol]
        : [sol, alt, sag, ust];
      const k = sayfa.getCropBox();
      const w = k.width - L - R, h = k.height - B - T;
      if (w < 10 || h < 10) throw new Error(`Sayfa ${i + 1}: kenar payları sayfadan büyük.`);
      sayfa.setCropBox(k.x + L, k.y + B, w, h);
    });
    return await doc.save();
  }

  // ---------------------------------------------------------------- Form

  function alanTuru(alan) {
    if (alan instanceof PDFLib.PDFTextField) return 'metin';
    if (alan instanceof PDFLib.PDFCheckBox) return 'onay';
    if (alan instanceof PDFLib.PDFDropdown) return 'acilir';
    if (alan instanceof PDFLib.PDFOptionList) return 'liste';
    if (alan instanceof PDFLib.PDFRadioGroup) return 'secenek';
    return null;   // düğme, imza: doldurulmaz
  }

  /**
   * Doldurulabilir form alanlarını listeler.
   * @returns {Promise<Array<{ ad: string, tur: string, deger: string|boolean|string[], secenekler: string[], salt: boolean }>>}
   */
  async function getFormFields(pdfBytes) {
    const doc = await loadSourcePdf(pdfBytes);
    const alanlar = [];
    for (const alan of doc.getForm().getFields()) {
      const tur = alanTuru(alan);
      if (!tur) continue;
      let deger = '', secenekler = [];
      if (tur === 'metin') deger = alan.getText() || '';
      else if (tur === 'onay') deger = alan.isChecked();
      else if (tur === 'secenek') { secenekler = alan.getOptions(); deger = alan.getSelected() || ''; }
      else { secenekler = alan.getOptions(); deger = alan.getSelected(); }
      alanlar.push({ ad: alan.getName(), tur, deger, secenekler, salt: alan.isReadOnly() });
    }
    return alanlar;
  }

  /**
   * Form alanlarını doldurur. duzlestir: alanlar sabit metne çevrilir (artık
   * düzenlenemez). Alan görünümleri Türkçe harfleri yazabilen yerleşik yazı
   * tipiyle çizilir. Bu yazı tipinin yazamadığı karakter (Kiril, emoji…)
   * içeren değerde görünümü görüntüleyici çizer (NeedAppearances),
   * düzleştirme yapılamaz ve uyarı döner.
   *
   * @param {Uint8Array} pdfBytes
   * @param {Object<string, string|boolean|string[]>} degerler  alan adı → değer
   * @param {{ duzlestir?: boolean }} [ayar]
   * @returns {Promise<{ bytes: Uint8Array, uyarilar: string[] }>}
   */
  async function fillForm(pdfBytes, degerler, ayar = {}) {
    const doc = await loadSourcePdf(pdfBytes);
    const form = doc.getForm();
    const uyarilar = [];
    let yazilamayan = false;
    for (const alan of form.getFields()) {
      const ad = alan.getName();
      if (!Object.prototype.hasOwnProperty.call(degerler, ad) || alan.isReadOnly()) continue;
      const v = degerler[ad];
      const metinler = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
      if (metinler.some(m => yazilamayanKarakter(m))) yazilamayan = true;
      try {
        const tur = alanTuru(alan);
        if (tur === 'metin') alan.setText(String(v ?? ''));
        else if (tur === 'onay') { if (v) alan.check(); else alan.uncheck(); }
        else if (tur === 'acilir' || tur === 'liste') { if (v === '' || (Array.isArray(v) && !v.length)) alan.clear(); else alan.select(v); }
        else if (tur === 'secenek') { if (v) alan.select(String(v)); else alan.clear(); }
      } catch (err) {
        uyarilar.push(`"${ad}" doldurulamadı: ${err.message}`);
      }
    }
    try {
      if (yazilamayan) throw new Error('yazılamayan karakter');
      // Görünümler burada Türkçe yazı tipiyle çizilir; pdf-lib kayıtta ve
      // düzleştirmede varsayılan (Türkçesiz) yazı tipiyle yeniden çizmesin.
      form.updateFieldAppearances(turkceYaziTipi(doc));
      if (ayar.duzlestir) form.flatten({ updateFieldAppearances: false });
      return { bytes: await doc.save({ updateFieldAppearances: false }), uyarilar };
    } catch (err) {
      form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
      uyarilar.push(ayar.duzlestir
        ? 'Değerlerde PDF yazı tipinin yazamadığı karakterler (Kiril, emoji gibi) var; form düzleştirilemedi, alanlar düzenlenebilir kaldı.'
        : 'Değerlerde PDF yazı tipinin yazamadığı karakterler (Kiril, emoji gibi) var; alan görünümünü PDF görüntüleyici çizecek.');
      return { bytes: await doc.save({ updateFieldAppearances: false }), uyarilar };
    }
  }

  /**
   * PDF'i sayfa sayfa tekil PDF'lere ayırır.
   *
   * @param {ArrayBuffer|Uint8Array} pdfBytes
   * @param {string} [baseName='sayfa']
   * @returns {Promise<Array<{ fileName: string, bytes: Uint8Array, pageNum: number }>>}
   */
  async function splitIntoSinglePages(pdfBytes, baseName = 'belge') {
    const srcDoc = await loadSourcePdf(pdfBytes);
    const pageCount = srcDoc.getPageCount();
    const results = [];

    for (let i = 0; i < pageCount; i++) {
      const singleDoc = await PDFDocument.create();
      const [copiedPage] = await singleDoc.copyPages(srcDoc, [i]);
      singleDoc.addPage(copiedPage);
      const bytes = await singleDoc.save();
      const pageNum = i + 1;
      const fileName = `${baseName}_sayfa_${String(pageNum).padStart(3, '0')}.pdf`;
      results.push({ fileName, bytes, pageNum });
    }

    return results;
  }

  // ---------------------------------------------------------------- Kalıcı karartma

  /**
   * Kalıcı karartma çıktısı: verilen sayfalar resimleriyle (karartma kutuları
   * üstüne basılmış, arayüz pdf.js ile çizer) değiştirilir; diğer sayfalar
   * olduğu gibi kopyalanır. Resme çevrilen sayfanın metni, açıklamaları ve
   * gizli katmanları tamamen gider; kutu çizmekten farkı budur. Belge bilgisi
   * (yazar, başlık, yer imleri) yeni belgeye taşınmaz.
   *
   * @param {Uint8Array} pdfBytes
   * @param {Array<{ index: number, bytes: Uint8Array, mime: string }>} sayfaResimleri  index 0 tabanlı
   */
  async function replacePagesWithImages(pdfBytes, sayfaResimleri) {
    const src = await loadSourcePdf(pdfBytes);
    const out = await PDFDocument.create();
    const harita = new Map((sayfaResimleri || []).map(s => [s.index, s]));
    const kopyalanacak = src.getPageIndices().filter(i => !harita.has(i));
    const kopyalar = kopyalanacak.length ? await out.copyPages(src, kopyalanacak) : [];
    let k = 0;
    for (let i = 0; i < src.getPageCount(); i++) {
      const r = harita.get(i);
      if (!r) { out.addPage(kopyalar[k++]); continue; }
      const y = gorunurYuzey(src.getPage(i));
      const gorsel = /png/i.test(r.mime || '') ? await out.embedPng(r.bytes) : await out.embedJpg(r.bytes);
      const sayfa = out.addPage([y.genislik, y.yukseklik]);
      sayfa.drawImage(gorsel, { x: 0, y: 0, width: y.genislik, height: y.yukseklik });
    }
    return await out.save();
  }

  /** Görünen sayfa boyutları (nokta), dönüş uygulanmış. */
  async function getVisibleSizes(pdfBytes) {
    const doc = await loadSourcePdf(pdfBytes);
    return doc.getPages().map(s => { const y = gorunurYuzey(s); return { genislik: y.genislik, yukseklik: y.yukseklik }; });
  }

  /** Birden çok PDF'i sırasıyla birleştirir (OCR'ın sayfa sayfa ürettiği PDF'ler). */
  async function concatPdfs(parcalar) {
    const out = await PDFDocument.create();
    for (const p of parcalar) {
      const d = await PDFDocument.load(p);
      for (const s of await out.copyPages(d, d.getPageIndices())) out.addPage(s);
    }
    return await out.save();
  }

  // ---------------------------------------------------------------- Şifre

  function rastgeleParola() {
    const b = new Uint8Array(24);
    globalThis.crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }

  /**
   * PDF'i parolayla korur (AES-256). Kısıtlama seçildiyse ve sahip parolası
   * verilmediyse rastgele, kimsenin bilmediği bir sahip parolası atanır:
   * aksi hâlde kullanıcı parolasıyla açan herkes tam yetki alır ve kısıtlama
   * anlamsız olurdu.
   *
   * @param {Uint8Array} pdfBytes
   * @param {{ parola: string, sahipParolasi?: string,
   *           izin?: { yazdirma?: boolean, kopyalama?: boolean, degistirme?: boolean, formDoldurma?: boolean } }} ayar
   * @returns {Promise<{ bytes: Uint8Array, sahipParolasiUretildi: boolean }>}
   */
  async function protectPdf(pdfBytes, ayar = {}) {
    const parola = String(ayar.parola || '');
    if (!parola) throw new Error('Açılış parolası girin.');
    const izin = Object.assign({ yazdirma: true, kopyalama: true, degistirme: true, formDoldurma: true }, ayar.izin);
    const kisitli = !izin.yazdirma || !izin.kopyalama || !izin.degistirme || !izin.formDoldurma;
    const uretildi = kisitli && !ayar.sahipParolasi;
    const sahip = ayar.sahipParolasi || (kisitli ? rastgeleParola() : parola);
    const doc = await loadSourcePdf(pdfBytes);
    doc.encrypt({
      userPassword: parola,
      ownerPassword: sahip,
      permissions: {
        printing: izin.yazdirma ? 'highResolution' : false,
        copying: izin.kopyalama,
        contentAccessibility: true,
        modifying: izin.degistirme,
        documentAssembly: izin.degistirme,
        annotating: izin.degistirme,
        fillingForms: izin.formDoldurma
      }
    });
    return { bytes: await doc.save(), sahipParolasiUretildi: uretildi };
  }

  /**
   * Bilinen parolayla şifreyi kaldırır. Parola kırmaz: yanlış parolada hata
   * verir. Yalnız izin kısıtlı (açılış parolası olmayan) dosyalarda parola
   * boş bırakılabilir.
   *
   * Kütüphane çözülmüş belgeyi kaydederken eski şifre sözlüğünü ve eski
   * çapraz başvuru (XRef) akışını sıradan nesne olarak taşıyor; o akıştaki
   * /Encrypt başvurusu yüzünden dosya yine şifreli sanılıyordu. İkisi silinir.
   */
  async function unlockPdf(pdfBytes, parola) {
    const ilk = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    if (!ilk.isEncrypted) throw new Error('Bu PDF zaten şifresiz.');
    let doc;
    try {
      doc = await PDFDocument.load(pdfBytes, { password: String(parola || '') });
    } catch (err) {
      throw new Error(parola ? 'Parola yanlış.' : 'Bu PDF açılış parolası istiyor; parolayı girin.');
    }
    const { PDFDict } = PDFLib;
    const XRef = PDFName.of('XRef'), Standard = PDFName.of('Standard');
    for (const [ref, nesne] of doc.context.enumerateIndirectObjects()) {
      const s = nesne instanceof PDFDict ? nesne : (nesne && nesne.dict instanceof PDFDict ? nesne.dict : null);
      if (!s) continue;
      const sifreSozlugu = s.get(PDFName.of('Filter')) === Standard && s.has(PDFName.of('O')) && s.has(PDFName.of('U'));
      if (s.get(PDFName.of('Type')) === XRef || sifreSozlugu) doc.context.delete(ref);
    }
    delete doc.context.trailerInfo.Encrypt;
    return await doc.save();
  }

  /* ZIP (sıkıştırmasız). Dosya adları UTF-8 yazılır ve bu, genel amaçlı
     bayrağın 11. bitiyle bildirilir: Windows Gezgini, 7-Zip ve macOS
     "sözleşme_sayfa_001.pdf" adını bozmadan açar. (Önceki SheetJS yazıcısı
     adları ASCII'ye kırptığı için ş, ğ, ı düşüyordu.) PDF ve JPEG zaten
     sıkıştırılmış olduğundan sıkıştırma kazandırmaz. */
  let crcTablosu = null;
  function crc32(veri) {
    if (!crcTablosu) {
      crcTablosu = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTablosu[n] = c >>> 0;
      }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < veri.length; i++) c = crcTablosu[(c ^ veri[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * @param {Array<{ fileName: string, bytes: Uint8Array }>} dosyalar
   * @param {Date} [tarih]  dosyalara yazılacak değiştirilme zamanı (yerel saat)
   * @returns {Uint8Array}
   */
  function zipOlustur(dosyalar, tarih = new Date()) {
    if (dosyalar.length > 0xFFFF) throw new Error('Bir ZIP en çok 65.535 dosya alabilir.');
    const kodla = new TextEncoder();
    const gun = ((Math.max(1980, tarih.getFullYear()) - 1980) << 9) | ((tarih.getMonth() + 1) << 5) | tarih.getDate();
    const saat = (tarih.getHours() << 11) | (tarih.getMinutes() << 5) | (tarih.getSeconds() >> 1);
    const UTF8 = 0x0800;
    const parcalar = [], merkez = [];
    let konum = 0, merkezBoyu = 0;
    for (const f of dosyalar) {
      const ad = kodla.encode(String(f.fileName));
      const veri = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      const crc = crc32(veri);
      const b = new DataView(new ArrayBuffer(30));
      b.setUint32(0, 0x04034B50, true); b.setUint16(4, 20, true); b.setUint16(6, UTF8, true);
      b.setUint16(10, saat, true); b.setUint16(12, gun, true); b.setUint32(14, crc, true);
      b.setUint32(18, veri.length, true); b.setUint32(22, veri.length, true); b.setUint16(26, ad.length, true);
      parcalar.push(new Uint8Array(b.buffer), ad, veri);
      const m = new DataView(new ArrayBuffer(46));
      m.setUint32(0, 0x02014B50, true); m.setUint16(4, 20, true); m.setUint16(6, 20, true); m.setUint16(8, UTF8, true);
      m.setUint16(12, saat, true); m.setUint16(14, gun, true); m.setUint32(16, crc, true);
      m.setUint32(20, veri.length, true); m.setUint32(24, veri.length, true); m.setUint16(28, ad.length, true);
      m.setUint32(42, konum, true);
      merkez.push(new Uint8Array(m.buffer), ad);
      konum += 30 + ad.length + veri.length;
      merkezBoyu += 46 + ad.length;
      if (konum > 0xFFFFFFFF) throw new Error('ZIP 4 GB sınırını aşıyor; daha az sayfa seçin.');
    }
    const son = new DataView(new ArrayBuffer(22));
    son.setUint32(0, 0x06054B50, true);
    son.setUint16(8, dosyalar.length, true); son.setUint16(10, dosyalar.length, true);
    son.setUint32(12, merkezBoyu, true); son.setUint32(16, konum, true);
    const cikti = new Uint8Array(konum + merkezBoyu + 22);
    let i = 0;
    for (const p of [...parcalar, ...merkez, new Uint8Array(son.buffer)]) { cikti.set(p, i); i += p.length; }
    return cikti;
  }

  return {
    ENCRYPTED_PDF_MESSAGE,
    zipOlustur,
    turkceYaziTipi,
    yazilamayanKarakter,
    protectPdf,
    unlockPdf,
    replacePagesWithImages,
    getVisibleSizes,
    concatPdfs,
    isPdfEncrypted,
    parsePageRanges,
    getPdfInfo,
    mergePdfs,
    extractPages,
    processPages,
    splitIntoSinglePages,
    NUMARA_KONUMLARI,
    addPageNumbers,
    addImageWatermark,
    imagesToPdf,
    cropPages,
    getFormFields,
    fillForm
  };
});
