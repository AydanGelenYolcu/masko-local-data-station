/**
 * workbench/pdf-advanced-engine.js
 * 
 * Local-First Data & Office Workbench: Advanced PDF Suite (WB-12)
 * Kapsanan Modüller:
 * - Karartma kutusu hesaplama (Search & Redact — YALNIZCA kutu hesabı).
 *   UYARI: Bu motor PDF'e dokunmaz. Kutuyu metnin üstüne çizmek karartma
 *   DEĞİLDİR; alttaki metin seçilip kopyalanabilir kalır. Kalıcı karartma için
 *   eşleşen metin içerik akışından silinmeli ya da sayfa rasterleştirilmelidir.
 *   Bu adım henüz uygulanmadı; arayüzdeki kart devre dışıdır.
 * - Boş Sayfa Tespiti (Blank Page Detector)
 * - PDF Metaveri Temizleyici (Metadata Scrubber)
 * - PDF Sürüm Karşılaştırıcı (PDF Diff)
 * 
 * %100 İstemci Tarafı, Deterministik, Sıfır Dış Bağımlılık.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PdfAdvancedEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * PDF Metin Katmanında Arama Yapıp Karartılacak Kutuları Hesaplar
   * 
   * @param {Array<{ text: string, x: number, y: number, width: number, height: number, pageIndex: number }>} textItems 
   * @param {string} searchTerm - Aranacak terim veya Regex
   * @param {boolean} [isRegex=false]
   * @param {Object} [options]
   * @param {number} [options.padding=2] - Karartma kutusu kenar payı
   * @returns {Array<{ pageIndex: number, rect: { x: number, y: number, width: number, height: number }, matchText: string }>}
   */
  function findRedactionBoxes(textItems, searchTerm, isRegex, options) {
    options = options || {};
    const padding = options.padding !== undefined ? options.padding : 2;

    if (!Array.isArray(textItems) || !searchTerm) {
      return [];
    }

    let reg;
    try {
      // 'g' bayrağı YOK: test() 'g' ile lastIndex'i taşır ve bir sonraki öğede
      // eşleşmeleri atlardı (3 eşleşmeden yalnızca 2'si kutu alıyordu).
      reg = isRegex ? new RegExp(searchTerm, 'i') : new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch (_) {
      return [];
    }

    const redactionBoxes = [];

    textItems.forEach(item => {
      if (!item || !item.text) return;
      if (reg.test(item.text)) {
        redactionBoxes.push({
          pageIndex: item.pageIndex !== undefined ? item.pageIndex : 0,
          rect: {
            x: Math.max(0, (item.x || 0) - padding),
            y: Math.max(0, (item.y || 0) - padding),
            width: (item.width || 50) + padding * 2,
            height: (item.height || 12) + padding * 2
          },
          matchText: item.text
        });
      }
    });

    return redactionBoxes;
  }

  /**
   * Boş Sayfa Tespiti (Blank Page Detector)
   * Taranmış veya birleştirilmiş PDF belgelerinde boş, beyaz veya yalnız kenar karalaması olan sayfaları tespit eder
   * 
   * @param {Array<{ pageIndex: number, textLength: number, wordCount: number, imageCount?: number, pixelVariance?: number }>} pagesMetrics 
   * @param {Object} [options]
   * @param {number} [options.maxWordCount=3] - Bu kelime sayısından az olan sayfalar boş adayıdır
   * @returns {{ blankPages: number[], nonBlankPages: number[], summary: Object }}
   */
  function detectBlankPages(pagesMetrics, options) {
    options = options || {};
    const maxWordCount = options.maxWordCount !== undefined ? options.maxWordCount : 3;

    if (!Array.isArray(pagesMetrics)) {
      throw new Error('pagesMetrics bir dizi olmalıdır.');
    }

    const blankPages = [];
    const nonBlankPages = [];

    pagesMetrics.forEach((page, idx) => {
      const pageNum = idx + 1;
      const words = page.wordCount !== undefined ? page.wordCount : (page.textLength ? Math.ceil(page.textLength / 5) : 0);
      const images = page.imageCount || 0;

      // Eğer sayfada metin yoksa ve görsel de yoksa kesin boştur
      const isBlank = words <= maxWordCount && images === 0;

      if (isBlank) {
        blankPages.push(pageNum);
      } else {
        nonBlankPages.push(pageNum);
      }
    });

    return {
      blankPages: blankPages,
      nonBlankPages: nonBlankPages,
      summary: {
        totalPages: pagesMetrics.length,
        blankCount: blankPages.length,
        cleanCount: nonBlankPages.length
      }
    };
  }

  /**
   * PDF Metaveri Temizleyici (Metadata Scrubber)
   * PDF belgesindeki yazar, yazılım, tarih gibi kişisel bilgileri sıfırlar
   */
  function sanitizePdfMetadata(metadataObj) {
    return {
      title: '',
      author: '',
      subject: '',
      creator: 'Masko Local-First Workbench',
      producer: 'Masko Offline Privacy Station',
      creationDate: new Date().toISOString(),
      modificationDate: new Date().toISOString(),
      keywords: []
    };
  }

  /**
   * PDF Karşılaştırıcı (PDF Diff)
   * İki PDF belgesinin sayfalarını ve metin paragraflarını karşılaştırır
   * 
   * @param {Array<{ pageIndex: number, text: string }>} pagesA 
   * @param {Array<{ pageIndex: number, text: string }>} pagesB 
   * @returns {{ pageCountA: number, pageCountB: number, pageDeltas: Array<Object>, changedPagesCount: number }}
   */
  function comparePdfDocuments(pagesA, pagesB) {
    if (!Array.isArray(pagesA) || !Array.isArray(pagesB)) {
      throw new Error('pagesA ve pagesB dizi olmalıdır.');
    }

    const maxPages = Math.max(pagesA.length, pagesB.length);
    const deltas = [];
    let changedPagesCount = 0;

    for (let i = 0; i < maxPages; i++) {
      const pageNum = i + 1;
      const textA = (pagesA[i] && pagesA[i].text) ? pagesA[i].text.trim() : null;
      const textB = (pagesB[i] && pagesB[i].text) ? pagesB[i].text.trim() : null;

      if (textA === null && textB !== null) {
        deltas.push({ pageNumber: pageNum, status: 'ADDED', message: `Sayfa ${pageNum} Doküman B'de yeni eklendi.` });
        changedPagesCount++;
      } else if (textA !== null && textB === null) {
        deltas.push({ pageNumber: pageNum, status: 'REMOVED', message: `Sayfa ${pageNum} Doküman B'den silindi.` });
        changedPagesCount++;
      } else if (textA !== textB) {
        deltas.push({
          pageNumber: pageNum,
          status: 'MODIFIED',
          message: `Sayfa ${pageNum} metin içeriğinde değişiklik var.`,
          lengthA: textA.length,
          lengthB: textB.length
        });
        changedPagesCount++;
      } else {
        deltas.push({ pageNumber: pageNum, status: 'IDENTICAL' });
      }
    }

    return {
      pageCountA: pagesA.length,
      pageCountB: pagesB.length,
      pageDeltas: deltas,
      changedPagesCount: changedPagesCount,
      isIdentical: changedPagesCount === 0
    };
  }

  return {
    findRedactionBoxes: findRedactionBoxes,
    detectBlankPages: detectBlankPages,
    sanitizePdfMetadata: sanitizePdfMetadata,
    comparePdfDocuments: comparePdfDocuments
  };
}));
