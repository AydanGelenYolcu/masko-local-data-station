/**
 * diff-engine.js
 *
 * Hücre Düzeyinde Tablo Karşılaştırıcı Motoru (Tabular Diff Engine)
 * İki tablo (Eski / Yeni) arasındaki satır ve hücre düzeyindeki farkları
 * Birincil Anahtar (Primary Key) bağıntısı ile deterministik olarak tespit eder.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TabularDiffEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY_SEPARATOR = '___|||___';

  /**
   * Sayısal denklik için değeri sayıya çevirir; belirsizse null döner.
   * Yalnız tek anlamlı biçimler sayı sayılır: JS sayıları, "5", "5.0", "-12.75",
   * "1e3". "1.250" (TR binlik mi, EN ondalık mı?), "1,5" ve baştaki sıfırlı
   * kodlar ("007") metin olarak kıyaslanır: yanlışlıkla "aynı" demek, yanlışlıkla
   * "değişti" demekten daha tehlikelidir.
   */
  function toComparableNumber(v, trim) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const s = trim === false ? v : v.trim();
    if (!/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    if (/^[+-]?0\d/.test(s)) return null;
    if (/^[+-]?[1-9]\d{0,2}(\.\d{3})+$/.test(s)) return null;
    return Number(s);
  }

  function isBlankValue(v) {
    return v === null || v === undefined || String(v).trim() === '';
  }

  /**
   * İki tablo arasındaki farkları hesaplar
   *
   * @param {string[]} headersA - Eski tablo başlıkları
   * @param {Array<Array<any>>} rowsA - Eski tablo satırları
   * @param {string[]} headersB - Yeni tablo başlıkları
   * @param {Array<Array<any>>} rowsB - Yeni tablo satırları
   * @param {Object} options
   * @param {string[]|number[]} options.keyColumns - Birincil anahtar sütun adları veya indisleri (Tablo A referanslı)
   * @param {boolean} [options.ignoreCase=false] - Değer karşılaştırmasında harf büyüklüğünü yok say (tr-TR kurallarıyla)
   * @param {boolean} [options.trimWhitespace=true] - Değer karşılaştırmasında baş/son boşlukları yok say
   * @param {boolean} [options.numericEquivalence=true] - İki taraf da sayı olarak okunabiliyorsa sayısal kıyasla ("5" = "5.0" = 5)
   * @returns {Object} Diff sonucu ve istatistikleri
   *
   * Satır durumları: 'added', 'deleted', 'modified', 'unchanged' ve hiçbir
   * satırın sessizce düşmemesi için 'duplicate' (anahtar bir tabloda birden
   * fazla kez geçiyor; eşleştirme belirsiz olduğu için kıyaslanmaz) ile
   * 'blank_key' (anahtar sütunlarının tümü boş). Her zaman
   * totalRowsA = unchanged + modified + deleted + duplicateRowsA + blankKeyRowsA,
   * totalRowsB = unchanged + modified + added + duplicateRowsB + blankKeyRowsB.
   */
  function diffTables(headersA, rowsA, headersB, rowsB, options) {
    options = options || {};
    if (!Array.isArray(headersA) || !Array.isArray(rowsA) || !Array.isArray(headersB) || !Array.isArray(rowsB)) {
      throw new Error('headers ve rows dizileri geçerli olmalıdır.');
    }

    const ignoreCase = Boolean(options.ignoreCase);
    const trimWhitespace = options.trimWhitespace !== false;
    const numericEquivalence = options.numericEquivalence !== false;

    // Başlık eşlemeleri
    const mapA = new Map();
    headersA.forEach((h, i) => mapA.set(String(h).trim(), i));
    const mapB = new Map();
    headersB.forEach((h, i) => mapB.set(String(h).trim(), i));

    // Anahtar sütun indekslerini tespit et
    const rawKeys = options.keyColumns || [];
    const keyIndicesA = [];
    const keyIndicesB = [];
    const keyNames = [];

    rawKeys.forEach(k => {
      let idxA = -1;
      let name = '';
      if (typeof k === 'number' && k >= 0 && k < headersA.length) {
        idxA = k;
        name = String(headersA[k]).trim();
      } else if (mapA.has(String(k).trim())) {
        idxA = mapA.get(String(k).trim());
        name = String(k).trim();
      }

      if (idxA !== -1) {
        keyIndicesA.push(idxA);
        keyNames.push(name);
        // Karşı tabloda aynı isimli sütunu bul
        if (mapB.has(name)) {
          keyIndicesB.push(mapB.get(name));
        } else {
          keyIndicesB.push(idxA); // fallback
        }
      }
    });

    if (keyIndicesA.length === 0) {
      throw new Error('Karşılaştırma için en az bir birincil anahtar (Primary Key) sütunu seçilmelidir.');
    }

    // Ortak sütunlar ve şema farkı
    const commonHeaders = [];
    const removedHeaders = [];
    const addedHeaders = [];

    headersA.forEach(h => {
      const cleanH = String(h).trim();
      if (mapB.has(cleanH)) {
        commonHeaders.push(cleanH);
      } else {
        removedHeaders.push(cleanH);
      }
    });

    headersB.forEach(h => {
      const cleanH = String(h).trim();
      if (!mapA.has(cleanH)) {
        addedHeaders.push(cleanH);
      }
    });

    // Düz toLowerCase "İ"yi "i̇" (i + birleşik nokta) yapar ve "İSTANBUL" ile
    // "istanbul" farklı görünür; Türkçe yerel ayarı kullanılır.
    function normalizeText(v) {
      if (v === null || v === undefined) return '';
      let s = String(v);
      if (trimWhitespace) s = s.trim();
      if (ignoreCase) s = s.toLocaleLowerCase('tr-TR');
      return s;
    }

    // Anahtar oluşturucu: tüm anahtar hücreleri boşsa null (ayrı kategori)
    function buildKey(row, indices) {
      if (indices.every(idx => isBlankValue(row[idx]))) return null;
      return indices.map(idx => {
        const v = row[idx];
        if (numericEquivalence) {
          const n = toComparableNumber(v, trimWhitespace);
          if (n !== null) return String(n);
        }
        return normalizeText(v);
      }).join(KEY_SEPARATOR);
    }

    // Kullanıcıya gösterilecek anahtar: orijinal hücre değerleri
    function keyLabel(row, indices) {
      return indices.map(idx => {
        const v = row[idx];
        return v === null || v === undefined ? '' : String(v).trim();
      }).join(' | ');
    }

    function areEqual(valA, valB) {
      if (normalizeText(valA) === normalizeText(valB)) return true;
      if (numericEquivalence) {
        const nA = toComparableNumber(valA, trimWhitespace);
        const nB = toComparableNumber(valB, trimWhitespace);
        if (nA !== null && nB !== null && nA === nB) return true;
      }
      return false;
    }

    // Tabloları anahtara göre grupla (ilk görülme sırası korunur). Eskiden
    // anahtar başına yalnız ilk satır tutuluyor, kopyalar sessizce düşüyordu.
    function groupRows(rows, indices) {
      const groups = new Map();
      const blanks = [];
      rows.forEach((row, rowIdx) => {
        const safeRow = Array.isArray(row) ? row : [];
        const key = buildKey(safeRow, indices);
        if (key === null) {
          blanks.push({ row: safeRow, rowIdx });
          return;
        }
        const list = groups.get(key);
        if (list) list.push({ row: safeRow, rowIdx });
        else groups.set(key, [{ row: safeRow, rowIdx }]);
      });
      return { groups, blanks };
    }

    const groupedA = groupRows(rowsA, keyIndicesA);
    const groupedB = groupRows(rowsB, keyIndicesB);
    const dictA = groupedA.groups;
    const dictB = groupedB.groups;

    const diffRows = [];
    let addedCount = 0;
    let deletedCount = 0;
    let modifiedCount = 0;
    let unchangedCount = 0;
    let cellModificationsCount = 0;
    let duplicateKeyCount = 0;
    let duplicateRowsA = 0;
    let duplicateRowsB = 0;

    function pushDuplicates(key, listA, listB) {
      duplicateKeyCount++;
      const countA = listA.length;
      const countB = listB.length;
      const label = keyLabel((listA[0] || listB[0]).row, listA.length ? keyIndicesA : keyIndicesB);
      listA.forEach(item => {
        duplicateRowsA++;
        diffRows.push({
          status: 'duplicate',
          key: key,
          keyLabel: label,
          side: 'A',
          countA: countA,
          countB: countB,
          rowA: item.row,
          rowB: null,
          rowIndexA: item.rowIdx,
          changes: []
        });
      });
      listB.forEach(item => {
        duplicateRowsB++;
        diffRows.push({
          status: 'duplicate',
          key: key,
          keyLabel: label,
          side: 'B',
          countA: countA,
          countB: countB,
          rowA: null,
          rowB: item.row,
          rowIndexB: item.rowIdx,
          changes: []
        });
      });
    }

    // B tablosundaki satırları A ile karşılaştır (Eklenen ve Değişenleri bul)
    dictB.forEach((listB, key) => {
      const listA = dictA.get(key) || [];

      if (listA.length > 1 || listB.length > 1) {
        // Hangi A satırının hangi B satırına karşılık geldiği belirsiz
        pushDuplicates(key, listA, listB);
        return;
      }

      const itemB = listB[0];
      const rowB = itemB.row;

      if (listA.length === 0) {
        // YENİ EKLENEN SATIR (ADDED +++)
        addedCount++;
        diffRows.push({
          status: 'added', // +++
          key: key,
          keyLabel: keyLabel(rowB, keyIndicesB),
          rowA: null,
          rowB: rowB,
          rowIndexB: itemB.rowIdx,
          changes: []
        });
      } else {
        // HER İKİ TABLODA DA VAR: HÜCRE HÜCRE KIYASLA
        const itemA = listA[0];
        const rowA = itemA.row;
        const changes = [];

        commonHeaders.forEach(colName => {
          const idxA = mapA.get(colName);
          const idxB = mapB.get(colName);
          const valA = rowA[idxA];
          const valB = rowB[idxB];

          if (!areEqual(valA, valB)) {
            changes.push({
              column: colName,
              oldValue: valA !== undefined ? valA : '',
              newValue: valB !== undefined ? valB : ''
            });
            cellModificationsCount++;
          }
        });

        const status = changes.length > 0 ? 'modified' : 'unchanged'; // ~ / =
        if (changes.length > 0) modifiedCount++;
        else unchangedCount++;
        diffRows.push({
          status: status,
          key: key,
          keyLabel: keyLabel(rowA, keyIndicesA),
          rowA: rowA,
          rowB: rowB,
          rowIndexA: itemA.rowIdx,
          rowIndexB: itemB.rowIdx,
          changes: changes
        });
      }
    });

    // A tablosunda olup B tablosunda olmayanları bul (SİLİNEN SATIRLAR ---)
    dictA.forEach((listA, key) => {
      if (dictB.has(key)) return;
      if (listA.length > 1) {
        pushDuplicates(key, listA, []);
        return;
      }
      deletedCount++;
      diffRows.push({
        status: 'deleted', // ---
        key: key,
        keyLabel: keyLabel(listA[0].row, keyIndicesA),
        rowA: listA[0].row,
        rowB: null,
        rowIndexA: listA[0].rowIdx,
        changes: []
      });
    });

    // Anahtarı tamamen boş satırlar: birbirleriyle eşleştirilemez, tek satıra
    // da çökertilmez; her biri ayrı raporlanır.
    groupedA.blanks.forEach(item => {
      diffRows.push({
        status: 'blank_key',
        key: '',
        keyLabel: '',
        side: 'A',
        rowA: item.row,
        rowB: null,
        rowIndexA: item.rowIdx,
        changes: []
      });
    });
    groupedB.blanks.forEach(item => {
      diffRows.push({
        status: 'blank_key',
        key: '',
        keyLabel: '',
        side: 'B',
        rowA: null,
        rowB: item.row,
        rowIndexB: item.rowIdx,
        changes: []
      });
    });

    return {
      schema: {
        commonHeaders: commonHeaders,
        removedHeaders: removedHeaders,
        addedHeaders: addedHeaders
      },
      stats: {
        totalRowsA: rowsA.length,
        totalRowsB: rowsB.length,
        addedCount: addedCount,
        deletedCount: deletedCount,
        modifiedCount: modifiedCount,
        unchangedCount: unchangedCount,
        cellModificationsCount: cellModificationsCount,
        duplicateKeyCount: duplicateKeyCount,
        duplicateRowsA: duplicateRowsA,
        duplicateRowsB: duplicateRowsB,
        blankKeyRowsA: groupedA.blanks.length,
        blankKeyRowsB: groupedB.blanks.length
      },
      keyNames: keyNames,
      diffRows: diffRows
    };
  }

  // Zaman bileşeni yoksa "yyyy-mm-dd", varsa "yyyy-mm-dd hh:mm:ss"; yalnız saat
  // biçimleri ("hh:mm", "[h]:mm") hücrenin kendi görünümünü korur.
  function formatExcelDate(XLSXlib, serial, fmt, date1904) {
    const clean = String(fmt).replace(/"[^"]*"/g, '').replace(/\[(?![hms]+\])[^\]]*\]/gi, '');
    const hasTime = /[hs]/i.test(clean);
    const hasDate = /[dy]/i.test(clean);
    const opts = { date1904: date1904 };
    if (!hasDate && hasTime) return XLSXlib.SSF.format(fmt, serial, opts);
    return XLSXlib.SSF.format(hasTime ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd', serial, opts);
  }

  /**
   * Yüklenen dosyanın ilk sayfasını dizi-dizisi olarak okur (SheetJS dışarıdan
   * verilir ki motor Node testlerinde de çalışsın).
   * - CSV/TSV/TXT birebir metin okunur: SheetJS aksi hâlde "00123"ü 123'e,
   *   "1.250,50"yi 1.2505'e, "2024-01-15"i tarih seri sayısına çevirir.
   * - XLSX'te tarih biçimli hücreler (tarih başlıkları dâhil) seri sayı yerine
   *   ISO metne çevrilir; diğer sayılar sayı kalır (sayısal denklik ve Excel
   *   çıktısında sayı hücresi olarak kalmaları için).
   * - Tamamen boş satırlar atlanır (boş anahtar gürültüsü üretmesinler).
   */
  function readSheetRows(XLSXlib, data, fileName) {
    const isText = /\.(csv|tsv|txt)$/i.test(fileName || '');
    // Metin dosyası kodlaması burada çözülür (UTF-8 / 1254): SheetJS bayt
    // dizisini Latin-1 okur ve Türkçe harfler bozulur.
    const wb = isText
      ? XLSXlib.read(csvIO().metinCoz(data), { type: 'string', raw: true, cellNF: true })
      : XLSXlib.read(data, { type: 'array', raw: false, cellNF: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return [];
    const date1904 = Boolean(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
    Object.keys(sheet).forEach(addr => {
      if (addr[0] === '!') return;
      const cell = sheet[addr];
      if (cell && cell.t === 'n' && cell.z && XLSXlib.SSF.is_date(cell.z)) {
        const text = formatExcelDate(XLSXlib, cell.v, cell.z, date1904);
        sheet[addr] = { t: 's', v: text, w: text };
      }
    });
    return XLSXlib.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false, raw: true });
  }

  // CSV yazımı ve OWASP formül enjeksiyonu koruması csv-io.js'te tek yerde
  // tutulur (tüm modüller aynı kuralla yazsın). Tarayıcıda sayfa onu bu
  // dosyadan önce yükler; Node'da require edilir. Çağrı anında çözülür.
  let csvModulu = null;
  function csvIO() {
    if (csvModulu) return csvModulu;
    if (typeof CsvIO !== 'undefined') csvModulu = CsvIO;
    else if (typeof module === 'object' && module.exports && typeof require === 'function') csvModulu = require('../csv-io.js');
    else throw new Error('csv-io.js yüklenmedi; CSV dışa aktarılamaz.');
    return csvModulu;
  }

  function guvenliHucre(v) {
    return csvIO().guvenliHucre(v);
  }

  /**
   * Satır dizilerini (başlık rows[0]'da) Excel uyumlu CSV metnine çevirir:
   * UTF-8 BOM, CRLF satır sonu, gerektiğinde çift tırnaklı alan ve başlıklar
   * dâhil formül koruması.
   */
  function buildCsv(rows, options) {
    return csvIO().stringify(null, rows, { delimiter: (options && options.delimiter) || ';' });
  }

  return {
    diffTables: diffTables,
    toComparableNumber: toComparableNumber,
    readSheetRows: readSheetRows,
    guvenliHucre: guvenliHucre,
    buildCsv: buildCsv
  };
}));
