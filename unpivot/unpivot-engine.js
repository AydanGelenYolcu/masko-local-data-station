/**
 * unpivot-engine.js
 * 
 * Genişten Uzuna Tablo Dönüştürücü (Wide-to-Long / Cross-tab to Relational Transformer)
 * Çapraz rapor tablolarını Power BI / Pivot / SQL uyumlu düz satırlara çevirir.
 * 
 * Sıfır dış bağımlılık, deterministik, istemci tarafı (in-memory).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.UnpivotEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Geniş tabloyu uzuna dönüştürür (Unpivot / Melt)
   * 
   * @param {string[]} headers - Orijinal sütun başlıkları dizisi
   * @param {Array<Array<any>>} rows - Tablo satırları (2D dizi)
   * @param {Object} options
   * @param {string[]|number[]} options.idColumns - Sabit kalacak anahtar sütun adları veya indisleri
   * @param {string[]|number[]} [options.valueColumns] - Satırlara açılacak sütunlar (boşsa idColumns dışındakiler)
   * @param {string} [options.attributeName='Öznitelik'] - Açılan sütun isimlerinin geleceği yeni sütun başlığı
   * @param {string} [options.valueName='Değer'] - Değerlerin geleceği yeni sütun başlığı
   * @param {boolean} [options.skipEmpty=true] - Boş/null hücrelerin satır oluşturmasını engeller
   * @param {boolean} [options.trimStrings=true] - Metin değerlerin baş/son boşluklarını temizler
   * @returns {{ headers: string[], rows: Array<Array<any>>, stats: { inputRows: number, outputRows: number, unpivotedColsCount: number, skippedEmptyCount: number } }}
   */
  function unpivotTable(headers, rows, options) {
    options = options || {};
    if (!Array.isArray(headers) || !Array.isArray(rows)) {
      throw new Error('headers ve rows dizi olmalıdır.');
    }

    const attributeName = (options.attributeName && options.attributeName.trim()) || 'Öznitelik';
    const valueName = (options.valueName && options.valueName.trim()) || 'Değer';
    const skipEmpty = options.skipEmpty !== false; // Varsayılan: true
    const trimStrings = options.trimStrings !== false;

    // Sütun indekslerini ve başlıklarını çözümle
    const headerMap = new Map();
    headers.forEach((h, idx) => {
      const name = String(h !== null && h !== undefined ? h : `Sütun_${idx + 1}`);
      headerMap.set(name, idx);
      headerMap.set(idx, idx);
    });

    // Sabit (ID) sütun indisleri
    const idIndices = [];
    const idNames = [];
    const rawIdCols = options.idColumns || [];

    rawIdCols.forEach(col => {
      let idx = -1;
      if (typeof col === 'number' && col >= 0 && col < headers.length) {
        idx = col;
      } else if (headerMap.has(col)) {
        idx = headerMap.get(col);
      }
      if (idx !== -1 && !idIndices.includes(idx)) {
        idIndices.push(idx);
        idNames.push(String(headers[idx]));
      }
    });

    if (idIndices.length === 0) {
      throw new Error('En az bir sabit (ID / Anahtar) sütun seçilmelidir.');
    }

    // Değer (Unpivot) sütun indisleri
    let valIndices = [];
    if (Array.isArray(options.valueColumns) && options.valueColumns.length > 0) {
      options.valueColumns.forEach(col => {
        let idx = -1;
        if (typeof col === 'number' && col >= 0 && col < headers.length) {
          idx = col;
        } else if (headerMap.has(col)) {
          idx = headerMap.get(col);
        }
        if (idx !== -1 && !idIndices.includes(idx) && !valIndices.includes(idx)) {
          valIndices.push(idx);
        }
      });
    } else {
      // Belirtilmediyse idColumns haricindeki tüm sütunlar
      for (let i = 0; i < headers.length; i++) {
        if (!idIndices.includes(i)) {
          valIndices.push(i);
        }
      }
    }

    if (valIndices.length === 0) {
      throw new Error('Satıra dönüştürülecek (Unpivot) en az bir değer sütunu bulunmalıdır.');
    }

    // Çıktı başlıkları: [...idNames, attributeName, valueName]
    const outHeaders = [...idNames, attributeName, valueName];
    const outRows = [];
    let skippedEmptyCount = 0;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;

      // Sabit ID değerlerini hazırla
      const baseIdVals = idIndices.map(idx => {
        const val = row[idx];
        if (trimStrings && typeof val === 'string') return val.trim();
        return val !== undefined ? val : '';
      });

      // Her bir değer sütununu satıra dönüştür
      for (let v = 0; v < valIndices.length; v++) {
        const colIdx = valIndices[v];
        const attrLabel = String(headers[colIdx]);
        let val = row[colIdx];

        if (trimStrings && typeof val === 'string') {
          val = val.trim();
        }

        // Boş kontrolü (null, undefined, '')
        const isEmpty = val === null || val === undefined || val === '';
        if (isEmpty && skipEmpty) {
          skippedEmptyCount++;
          continue;
        }

        outRows.push([...baseIdVals, attrLabel, (val !== undefined && val !== null) ? val : '']);
      }
    }

    return {
      headers: outHeaders,
      rows: outRows,
      stats: {
        inputRows: rows.length,
        outputRows: outRows.length,
        idColsCount: idIndices.length,
        unpivotedColsCount: valIndices.length,
        skippedEmptyCount: skippedEmptyCount
      }
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
   * - XLSX'te tarih biçimli hücreler seri sayı (45306) yerine ISO metne çevrilir;
   *   "Ocak 2024" gibi tarih tipli başlıklar Öznitelik sütununda okunur kalır.
   *   Diğer sayılar sayı kalır (Power BI / Excel çıktısında sayı hücresi olsun).
   * - CSV/TSV/TXT birebir metin okunur: SheetJS aksi hâlde "00123"ü 123'e,
   *   "1.250,50"yi 1.2505'e, "2024-01-15"i seri sayıya çevirir.
   * - Tamamen boş satırlar atlanır.
   */
  function readSheetRows(XLSXlib, data, fileName) {
    const isText = /\.(csv|tsv|txt)$/i.test(fileName || '');
    const wb = XLSXlib.read(data, { type: 'array', raw: isText, cellNF: true });
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
    unpivotTable: unpivotTable,
    readSheetRows: readSheetRows,
    guvenliHucre: guvenliHucre,
    buildCsv: buildCsv
  };
}));
