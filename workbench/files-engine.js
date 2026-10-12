/**
 * workbench/files-engine.js
 * 
 * Local-First Data & Office Workbench: Files, Rescue & Advanced Shapes Engine
 * Kapsanan Modüller:
 * - WB-08: Multi-File Append & Column-Value File Splitter
 * - WB-09: CSV Rescue Mode & Gelişmiş Biçimlendirme İstasyonu
 * - WB-10: İleri Düzey Tablo Şekil Dönüştürme (Pivot, Group By, Explode, Implode, Fill Down)
 * - WB-13: Workbook Deep Inspector (Excel Derin Denetçisi)
 * - WB-14: Clipboard Workbench (Pano Tablo Temizleyici)
 * - WB-15: Şemadan Sentetik Test Verisi Üretici
 * 
 * %100 İstemci Tarafı, Deterministik, Sıfır Dış Bağımlılık.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FilesEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // CSV ayrıştırma, ayraç tespiti, yazma ve formül koruması (OWASP CSV
  // Injection) csv-io.js'te tek yerde tutulur: tezgâhın CSV'si tablo ve kitle
  // modülleriyle aynı kuralla okunup yazılsın. Tarayıcıda ../csv-io.js bu
  // dosyadan önce yüklenir; Node'da (CLI, testler) require edilir.
  let csvModulu = null;
  function csvIO() {
    if (csvModulu) return csvModulu;
    if (typeof CsvIO !== 'undefined') csvModulu = CsvIO;
    else if (typeof module === 'object' && module.exports && typeof require === 'function') csvModulu = require('../csv-io.js');
    else throw new Error('csv-io.js yüklenmedi; CSV okunamaz/yazılamaz.');
    return csvModulu;
  }

  // Sayı çözümleyicisi recipe-engine.js'te tek yerde tutulur (parseLocaleNumber).
  function recipeEngine() {
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      return require('./recipe-engine.js');
    }
    const g = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {});
    if (!g.RecipeEngine) throw new Error('recipe-engine.js yüklenmedi; sayı normalizasyonu yapılamaz.');
    return g.RecipeEngine;
  }

  // Onarım raporundaki fiziksel satır sayısı (tırnak içi satır sonları dâhil).
  function satirSonuSayisi(text, bas, bit) {
    const m = text.slice(bas, bit).match(/\r\n|\r|\n/g);
    return m ? m.length : 0;
  }

  // ==========================================
  // WB-08: Multi-File Append & Column Splitter
  // ==========================================

  /**
   * Birden fazla dosyayı/tabloyu tek bir tabloda birleştirir (Consolidate / Append)
   * 
   * @param {Array<{ name: string, headers: string[], rows: Array<Array<any>> }>} tables 
   * @param {Object} [options]
   * @param {boolean} [options.addSourceColumn=true] - '_kaynak_dosya' sütunu ekler
   * @param {string} [options.sourceColumnName='kaynak_dosya']
   * @returns {{ headers: string[], rows: Array<Array<any>>, stats: Object }}
   */
  function appendTables(tables, options) {
    options = options || {};
    const addSource = options.addSourceColumn !== false;
    const sourceColName = options.sourceColumnName || 'kaynak_dosya';

    if (!Array.isArray(tables) || tables.length === 0) {
      throw new Error('appendTables en az bir tablo gerektirir.');
    }

    // Tüm tablolardaki benzersiz başlıkların birleşimi (Union of Headers)
    const headerSet = new Set();
    tables.forEach(t => {
      (t.headers || []).forEach(h => headerSet.add(String(h).trim()));
    });

    const unifiedHeaders = Array.from(headerSet);
    if (addSource) {
      unifiedHeaders.unshift(sourceColName);
    }

    const outRows = [];
    const schemaDrifts = [];

    tables.forEach((t, tIdx) => {
      const srcHeaders = (t.headers || []).map(h => String(h).trim());
      const tableName = t.name || `Dosya_${tIdx + 1}`;

      // Eksik veya fazla sütun tespiti
      const missing = unifiedHeaders.filter(uh => uh !== sourceColName && !srcHeaders.includes(uh));
      if (missing.length > 0) {
        schemaDrifts.push({ table: tableName, missingColumns: missing });
      }

      // Satırları eşle
      const indexMap = unifiedHeaders.map(uh => {
        if (uh === sourceColName) return -999;
        return srcHeaders.indexOf(uh);
      });

      (t.rows || []).forEach(r => {
        const unifiedRow = indexMap.map(srcIdx => {
          if (srcIdx === -999) return tableName;
          return (srcIdx >= 0 && r[srcIdx] !== null && r[srcIdx] !== undefined) ? r[srcIdx] : '';
        });
        outRows.push(unifiedRow);
      });
    });

    return {
      headers: unifiedHeaders,
      rows: outRows,
      stats: {
        tablesCount: tables.length,
        totalRows: outRows.length,
        totalCols: unifiedHeaders.length,
        schemaDriftsCount: schemaDrifts.length,
        schemaDrifts: schemaDrifts
      }
    };
  }

  /**
   * Tek bir tabloyu seçilen bir sütunun değerlerine göre alt tablolara böler
   * 
   * @param {string[]} headers 
   * @param {Array<Array<any>>} rows 
   * @param {string|number} splitColumn - Bölünecek sütun adı veya indeksi
   * @param {string} [filenamePattern='{deger}_{tarih}.xlsx']
   * @returns {Object.<string, { filename: string, splitValue: string, headers: string[], rows: Array<Array<any>>, count: number }>}
   */
  function splitTableByColumn(headers, rows, splitColumn, filenamePattern) {
    if (!Array.isArray(headers) || !Array.isArray(rows)) {
      throw new Error('headers ve rows dizi olmalıdır.');
    }

    let colIdx = -1;
    if (typeof splitColumn === 'number') {
      colIdx = splitColumn;
    } else {
      const norm = String(splitColumn).trim().toLowerCase();
      colIdx = headers.findIndex(h => String(h).trim().toLowerCase() === norm);
    }

    if (colIdx < 0 || colIdx >= headers.length) {
      throw new Error(`Bölme sütunu bulunamadı: "${splitColumn}"`);
    }

    // Prototipsiz nesne: "__proto__" / "constructor" değerli satırlar {} üzerinde
    // Object.prototype'a çarpıp bölmeyi çökertiyordu.
    const groups = Object.create(null);
    const dateStr = new Date().toISOString().split('T')[0];
    const pattern = filenamePattern || '{deger}_{tarih}.xlsx';

    rows.forEach(r => {
      const rawVal = r[colIdx];
      const valStr = String(rawVal !== null && rawVal !== undefined ? rawVal : 'BOS').trim();
      const safeKey = valStr.replace(/[^\w\sğüşıöçĞÜŞİÖÇ-]/g, '_') || 'BOS';

      if (!groups[safeKey]) {
        const fname = pattern
          .replace('{deger}', safeKey)
          .replace('{tarih}', dateStr);

        groups[safeKey] = {
          filename: fname,
          splitValue: valStr,
          headers: headers.slice(),
          rows: [],
          count: 0
        };
      }

      groups[safeKey].rows.push(r.slice());
      groups[safeKey].count++;
    });

    return groups;
  }

  // ==========================================
  // WB-09: CSV Rescue Mode
  // ==========================================

  /**
   * Bozuk CSV ayraç ve tırnak yapısını onarır, Excel uyumlu UTF-8 BOM CSV üretir
   *
   * @param {string} csvText
   * @param {Object} [options]
   * @param {boolean} [options.normalizeNumbers=false] - Yerel biçimli sayıları ('1.250,50')
   *   kanonik biçime ('1250.50') çevirir. Varsayılan kapalı: onarım aracı değerleri
   *   sessizce yeniden yazmamalı ("1,234" eskiden 1.234 oluyordu). Açıksa sayım
   *   stats.numbersNormalizedCount'ta raporlanır.
   * @param {string} [options.outputDelimiter=';'] - exportCleanCsv ayracı (Excel TR varsayılanı)
   */
  function repairCsv(csvText, options) {
    options = options || {};
    if (typeof csvText !== 'string') {
      throw new Error('repairCsv metin girdisi gerektirir.');
    }
    const onarici = createCsvRepairer(options);
    onarici.push(csvText);
    return onarici.end();
  }

  /**
   * Akışlı CSV onarıcı: metni parça parça alır, repairCsv ile birebir aynı
   * sonucu üretir (repairCsv de bunu kullanır). Büyük dosya tek metne
   * okunmaz; her parça işlenip bırakılır.
   *
   * @param {Object} [options] - repairCsv seçenekleri ve:
   * @param {boolean} [options.shareValues=false] - Aynı sütunda tekrar eden hücre
   *   metinlerini tek kopyada paylaşır (bellek; değerler aynı kalır). Paylaşım
   *   sözlüğü 100.000 değeri geçtiğinde isabet oranı %50'nin altındaysa (kimlik no
   *   gibi benzersiz sütun) o sütunda durur; en fazla 1.000.000 değer tutulur.
   * @returns {{ push(parca: string): void, end(): Object, readonly rowCount: number }}
   *   end() repairCsv ile aynı nesneyi döndürür.
   */
  function createCsvRepairer(options) {
    options = options || {};
    const io = csvIO();
    // 1. Ayraç koklama (Delimiter Sniffing): ilk kayıtlarda en tutarlı alan
    // sayısını veren aday. Tırnak içleri sayılmaz: ';' ayraçlı dosyada "1,5"
    // gibi tırnaklı ondalıklar ayracı ',' sandırıyordu.
    // 2. Tırnak farkında kayıt çözümleme: tırnak içi satır sonları alana aittir
    // (eskiden çok satırlı adres "bozuk satır" diye düşüyordu), kapanmayan
    // tırnak dosyanın geri kalanını yutmaz. Kurtarma aracı olduğu için
    // tırnaksız alanlar kırpılır; konumlar bozuk satırın ham hâli için tutulur.
    const cozucu = io.createParser({ trim: true, positions: 'arrays' });
    const parsedRows = [];
    const jaggedRows = [];
    let expectedCols = 0;
    let numbersNormalized = 0;
    let kayitIdx = 0;
    let satirSonu = 0, sonuCR = false, karakter = 0, bomBakildi = false;
    const sayiCozucu = options.normalizeNumbers ? recipeEngine().normalizeLocaleNumberString : null;
    const paylas = !!options.shareValues;
    const ortak = [];
    const sorgu = [], isabet = [];

    function degerPaylas(cells) {
      for (let j = 0; j < cells.length; j++) {
        let m = ortak[j];
        if (m === null) continue;
        if (m === undefined) { m = ortak[j] = new Map(); sorgu[j] = 0; isabet[j] = 0; }
        const v = cells[j];
        const var_ = m.get(v);
        sorgu[j]++;
        if (var_ !== undefined) { cells[j] = var_; isabet[j]++; }
        else if (m.size < 100000 || (m.size < 1000000 && isabet[j] * 2 >= sorgu[j])) m.set(v, v);
        else ortak[j] = null;
      }
    }

    function partiIsle(parti) {
      for (let k = 0; k < parti.rows.length; k++) {
        let cleanCells = parti.rows[k];
        if (sayiCozucu && kayitIdx > 0) {
          cleanCells = cleanCells.map(val => {
            const kanonik = sayiCozucu(val);
            if (kanonik === null || kanonik === val) return val;
            numbersNormalized++;
            return kanonik;
          });
        }

        if (kayitIdx === 0) {
          expectedCols = cleanCells.length;
          parsedRows.push(cleanCells);
        } else if (cleanCells.length === expectedCols) {
          if (paylas) degerPaylas(cleanCells);
          parsedRows.push(cleanCells);
        } else {
          jaggedRows.push({
            lineIndex: parti.lines[k],
            raw: parti.text.slice(parti.starts[k] - parti.offset, parti.ends[k] - parti.offset),
            parsed: cleanCells
          });
        }
        kayitIdx++;
      }
    }

    // Fiziksel satır sayısı parça sınırında bölünen CRLF'i bir kez sayar.
    function satirSay(parca) {
      if (!parca.length) return;
      if (sonuCR && parca.charCodeAt(0) === 10) satirSonu--;
      satirSonu += satirSonuSayisi(parca, 0, parca.length);
      sonuCR = parca.charCodeAt(parca.length - 1) === 13;
    }

    return {
      push(parca) {
        parca = parca == null ? '' : String(parca);
        if (!bomBakildi && parca.length) {
          bomBakildi = true;
          if (parca.charCodeAt(0) === 0xFEFF) parca = parca.slice(1);
        }
        karakter += parca.length;
        satirSay(parca);
        partiIsle(cozucu.push(parca));
      },
      end() {
        partiIsle(cozucu.end());
        const headers = parsedRows.length > 0 ? parsedRows[0] : [];
        const rows = parsedRows.length > 1 ? parsedRows.slice(1) : [];
        const varsayilanCikisAyraci = options.outputDelimiter || ';'; // Excel Türkiye için varsayılan noktalı virgül

        return {
          headers: headers,
          rows: rows,
          detectedDelimiter: cozucu.delimiter,
          jaggedRows: jaggedRows,
          stats: {
            totalLines: karakter === 0 ? 0 : satirSonu + 1,
            totalRecords: kayitIdx,
            cleanRowsCount: rows.length,
            jaggedRowsCount: jaggedRows.length,
            numbersNormalizedCount: numbersNormalized
          },
          /**
           * Excel-Safe UTF-8 BOM CSV metni (formül korumalı, CRLF)
           * @param {string} [cikisAyraci] - Varsayılan: options.outputDelimiter || ';'
           */
          exportCleanCsv: function (cikisAyraci) {
            // Tırnaklama GERÇEK çıkış ayracına göre yapılır: eskiden algılanan ayraca
            // göre tırnaklanıp ';' ile birleştiriliyordu ve ',' ayraçlı dosyada "a;b"
            // hücresi iki sütuna bölünüyordu. '0123' gibi baştaki sıfırlı kodlar da
            // tırnaklanır (bu aracın öteden beri süren davranışı).
            return csvIO().stringify(null, parsedRows, {
              delimiter: cikisAyraci || varsayilanCikisAyraci,
              quoteLeadingZeros: true
            });
          }
        };
      },
      get rowCount() { return parsedRows.length > 0 ? parsedRows.length - 1 : 0; }
    };
  }

  // ==========================================
  // WB-10: Advanced Shape Transforms
  // ==========================================

  /**
   * Çapraz Tablo Oluşturucu (Pivot / Long-to-Wide)
   * 
   * @param {string[]} headers 
   * @param {Array<Array<any>>} rows 
   * @param {Object} options
   * @param {string[]} options.rowKeys - Satır başlığı kalacak sütunlar
   * @param {string} options.pivotColumn - Sütun başlıklarına açılacak kategorik sütun
   * @param {string} options.valueColumn - Agregasyonu alınacak değer sütunu
   * @param {string} [options.aggFunction='SUM'] - 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX'
   */
  function pivotTable(headers, rows, options) {
    if (!options || !options.rowKeys || !options.pivotColumn || !options.valueColumn) {
      throw new Error('pivotTable rowKeys, pivotColumn ve valueColumn gerektirir.');
    }

    const rowKeyIndices = options.rowKeys.map(k => headers.indexOf(k)).filter(i => i >= 0);
    const pivotColIdx = headers.indexOf(options.pivotColumn);
    const valColIdx = headers.indexOf(options.valueColumn);
    const aggFunc = (options.aggFunction || 'SUM').toUpperCase();

    if (rowKeyIndices.length === 0 || pivotColIdx < 0 || valColIdx < 0) {
      throw new Error('Pivot sütunlarından biri veya birkaçı başlıklar arasında bulunamadı.');
    }

    // Benzersiz pivot sütun değerlerini topla (yeni sütun başlıkları)
    const pivotValSet = new Set();
    rows.forEach(r => {
      const pv = String(r[pivotColIdx] !== null && r[pivotColIdx] !== undefined ? r[pivotColIdx] : '').trim();
      if (pv) pivotValSet.add(pv);
    });
    const pivotHeaders = Array.from(pivotValSet).sort();

    // Satır gruplaması
    const matrix = new Map();
    rows.forEach(r => {
      const rowKeyStr = rowKeyIndices.map(ri => String(r[ri] || '')).join('|||');
      const pivotVal = String(r[pivotColIdx] || '').trim();
      const val = parseFloat(r[valColIdx]);

      if (!matrix.has(rowKeyStr)) {
        matrix.set(rowKeyStr, {
          keys: rowKeyIndices.map(ri => r[ri]),
          cells: new Map()
        });
      }

      const group = matrix.get(rowKeyStr);
      if (!group.cells.has(pivotVal)) {
        group.cells.set(pivotVal, []);
      }
      group.cells.get(pivotVal).push(isNaN(val) ? 0 : val);
    });

    const outHeaders = options.rowKeys.concat(pivotHeaders);
    const outRows = [];

    matrix.forEach(group => {
      const row = group.keys.slice();
      pivotHeaders.forEach(ph => {
        const vals = group.cells.get(ph) || [];
        if (vals.length === 0) {
          row.push(0);
        } else if (aggFunc === 'SUM') {
          row.push(parseFloat(vals.reduce((a, b) => a + b, 0).toFixed(2)));
        } else if (aggFunc === 'COUNT') {
          row.push(vals.length);
        } else if (aggFunc === 'AVG') {
          row.push(parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)));
        } else if (aggFunc === 'MIN' || aggFunc === 'MAX') {
          // Math.min(...vals) ~100 bin değerde "Maximum call stack size exceeded" verir.
          let uc = vals[0];
          for (let i = 1; i < vals.length; i++) {
            if (aggFunc === 'MIN' ? vals[i] < uc : vals[i] > uc) uc = vals[i];
          }
          row.push(uc);
        }
      });
      outRows.push(row);
    });

    return {
      headers: outHeaders,
      rows: outRows,
      stats: {
        rowKeysCount: options.rowKeys.length,
        pivotColumnsCount: pivotHeaders.length,
        outputRowsCount: outRows.length
      }
    };
  }

  /**
   * Hücre içi virgüllü değerleri satırlara patlatır (Explode Column)
   */
  function explodeColumn(headers, rows, targetColumn, separator) {
    const colIdx = typeof targetColumn === 'number' ? targetColumn : headers.indexOf(targetColumn);
    if (colIdx < 0 || colIdx >= headers.length) {
      throw new Error(`Explode sütunu bulunamadı: "${targetColumn}"`);
    }

    const sep = separator || ',';
    const outRows = [];

    rows.forEach(r => {
      const val = r[colIdx];
      if (val === null || val === undefined || String(val).trim() === '') {
        outRows.push(r.slice());
        return;
      }

      const parts = String(val).split(sep).map(s => s.trim()).filter(Boolean);
      if (parts.length === 0) {
        outRows.push(r.slice());
      } else {
        parts.forEach(p => {
          const rowCopy = r.slice();
          rowCopy[colIdx] = p;
          outRows.push(rowCopy);
        });
      }
    });

    return {
      headers: headers.slice(),
      rows: outRows,
      stats: { inputRows: rows.length, outputRows: outRows.length }
    };
  }

  /**
   * Aynı anahtara sahip satırları birleştirip listeye dönüştürür (Implode / Group Concat)
   */
  function implodeRows(headers, rows, keyColumns, valueColumn, separator) {
    const keyIndices = keyColumns.map(k => headers.indexOf(k)).filter(i => i >= 0);
    const valColIdx = headers.indexOf(valueColumn);
    const sep = separator || ', ';

    if (keyIndices.length === 0 || valColIdx < 0) {
      throw new Error('Anahtar veya değer sütunu bulunamadı.');
    }

    const groupMap = new Map();
    rows.forEach(r => {
      const keyStr = keyIndices.map(ki => String(r[ki] || '')).join('|||');
      const val = String(r[valColIdx] || '').trim();

      if (!groupMap.has(keyStr)) {
        groupMap.set(keyStr, {
          keys: keyIndices.map(ki => r[ki]),
          values: []
        });
      }
      if (val) {
        groupMap.get(keyStr).values.push(val);
      }
    });

    const outHeaders = keyColumns.concat([valueColumn]);
    const outRows = [];

    groupMap.forEach(group => {
      const row = group.keys.slice();
      row.push(group.values.join(sep));
      outRows.push(row);
    });

    return {
      headers: outHeaders,
      rows: outRows,
      stats: { inputRows: rows.length, outputRows: outRows.length }
    };
  }

  // ==========================================
  // WB-10: JSON Flatten (İç İçe JSON Düzleştirici)
  // ==========================================

  /**
   * İç içe geçmiş (nested) JSON nesnelerini ilişkisel düz tabloya dönüştürür (JSON Flatten)
   * 
   * @param {Array<Object>|Object|string} input 
   * @param {Object} [options]
   * @param {string} [options.separator='.']
   * @param {string} [options.arrayMode='join'] - 'join' veya 'indexed'
   * @returns {{ headers: string[], rows: Array<Array<any>>, stats: Object }}
   */
  function flattenJsonRecords(input, options) {
    options = options || {};
    const sep = options.separator || '.';
    const arrayMode = options.arrayMode || 'join';

    let records = input;
    if (typeof records === 'string') {
      try {
        records = JSON.parse(records);
      } catch (e) {
        throw new Error('Geçersiz JSON metni: ' + e.message);
      }
    }

    if (!Array.isArray(records)) {
      records = [records];
    }

    let maxDepth = 0;

    function flattenObj(obj, prefix, currentDepth) {
      if (currentDepth > maxDepth) maxDepth = currentDepth;
      const flat = {};

      if (obj === null || obj === undefined) {
        return flat;
      }

      if (typeof obj !== 'object') {
        flat[prefix] = obj;
        return flat;
      }

      if (Array.isArray(obj)) {
        if (obj.length === 0) {
          flat[prefix] = '';
          return flat;
        }

        const allPrimitives = obj.every(x => x === null || typeof x !== 'object');
        if (allPrimitives && arrayMode === 'join') {
          flat[prefix] = obj.map(x => (x !== null && x !== undefined ? String(x) : '')).join(', ');
          return flat;
        }

        obj.forEach((item, idx) => {
          const itemKey = prefix ? `${prefix}${sep}${idx}` : String(idx);
          const itemFlat = flattenObj(item, itemKey, currentDepth + 1);
          Object.assign(flat, itemFlat);
        });
        return flat;
      }

      const keys = Object.keys(obj);
      if (keys.length === 0) {
        flat[prefix] = '';
        return flat;
      }

      keys.forEach(k => {
        const fullKey = prefix ? `${prefix}${sep}${k}` : k;
        const childFlat = flattenObj(obj[k], fullKey, currentDepth + 1);
        Object.assign(flat, childFlat);
      });

      return flat;
    }

    const flatRecords = records.map(r => flattenObj(r, '', 1));

    const headerSet = new Set();
    flatRecords.forEach(fr => {
      Object.keys(fr).forEach(k => headerSet.add(k));
    });

    const headers = Array.from(headerSet);
    const rows = flatRecords.map(fr => {
      return headers.map(h => (fr[h] !== undefined && fr[h] !== null ? fr[h] : ''));
    });

    return {
      headers: headers,
      rows: rows,
      stats: {
        recordCount: records.length,
        totalFields: headers.length,
        maxDepth: maxDepth
      }
    };
  }

  // ==========================================
  // WB-13: Workbook Deep Inspector & Cleanup
  // ==========================================

  /**
   * Çalışma kitabı sayfalarının derin röntgenini çeker
   */
  function inspectWorkbookStructure(workbookInfo) {
    if (!workbookInfo || !Array.isArray(workbookInfo.sheets)) {
      throw new Error('workbookInfo.sheets dizisi gereklidir.');
    }

    let totalFormulas = 0;
    let totalRefErrors = 0;
    let totalMergedCells = 0;
    let totalEmptyFormattedRows = 0;
    const sheetReports = [];

    workbookInfo.sheets.forEach(sheet => {
      const formulas = sheet.formulaCount || 0;
      const refErrors = sheet.refErrorCount || 0;
      const merged = sheet.mergedCount || 0;
      const emptyRows = sheet.emptyFormattedRowCount || 0;

      totalFormulas += formulas;
      totalRefErrors += refErrors;
      totalMergedCells += merged;
      totalEmptyFormattedRows += emptyRows;

      sheetReports.push({
        sheetName: sheet.name,
        isHidden: !!sheet.isHidden,
        rowCount: sheet.rowCount || 0,
        colCount: sheet.colCount || 0,
        formulaCount: formulas,
        refErrorCount: refErrors,
        mergedCellsCount: merged,
        emptyFormattedRowsCount: emptyRows
      });
    });

    return {
      totalSheets: workbookInfo.sheets.length,
      hiddenSheetsCount: sheetReports.filter(s => s.isHidden).length,
      totalFormulas: totalFormulas,
      totalRefErrors: totalRefErrors,
      totalMergedCells: totalMergedCells,
      totalEmptyFormattedRows: totalEmptyFormattedRows,
      sheetReports: sheetReports
    };
  }

  /**
   * Şişkin Excel tablolarında arkada kalan biçimlendirilmiş ama boş satırları ve sütunları kırpar
   * (Trim Empty Used-Range Tail)
   * 
   * @param {string[]} headers 
   * @param {Array<Array<any>>} rows 
   * @param {Object} [options]
   * @param {boolean} [options.trimColumns=false]
   * @returns {{ headers: string[], rows: Array<Array<any>>, stats: Object }}
   */
  function trimEmptyUsedRange(headers, rows, options) {
    options = options || {};
    headers = headers || [];
    rows = rows || [];

    function isCellEmpty(val) {
      return val === null || val === undefined || String(val).trim() === '';
    }

    function isRowEmpty(row) {
      if (!Array.isArray(row) || row.length === 0) return true;
      return row.every(isCellEmpty);
    }

    let lastNonEmptyRowIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!isRowEmpty(rows[i])) {
        lastNonEmptyRowIdx = i;
        break;
      }
    }

    const cleanRows = lastNonEmptyRowIdx >= 0 ? rows.slice(0, lastNonEmptyRowIdx + 1) : [];

    let cleanHeaders = headers.slice();
    let trimmedColsCount = 0;

    if (options.trimColumns) {
      let lastNonEmptyColIdx = -1;
      for (let c = cleanHeaders.length - 1; c >= 0; c--) {
        const hasHeader = !isCellEmpty(cleanHeaders[c]);
        const hasRowData = cleanRows.some(r => !isCellEmpty(r[c]));
        if (hasHeader || hasRowData) {
          lastNonEmptyColIdx = c;
          break;
        }
      }
      if (lastNonEmptyColIdx >= 0 && lastNonEmptyColIdx < cleanHeaders.length - 1) {
        trimmedColsCount = cleanHeaders.length - (lastNonEmptyColIdx + 1);
        cleanHeaders = cleanHeaders.slice(0, lastNonEmptyColIdx + 1);
        for (let i = 0; i < cleanRows.length; i++) {
          cleanRows[i] = cleanRows[i].slice(0, lastNonEmptyColIdx + 1);
        }
      }
    }

    return {
      headers: cleanHeaders,
      rows: cleanRows,
      stats: {
        originalRows: rows.length,
        cleanRows: cleanRows.length,
        trimmedRows: rows.length - cleanRows.length,
        originalCols: headers.length,
        cleanCols: cleanHeaders.length,
        trimmedCols: trimmedColsCount
      }
    };
  }

  /**
   * Formülleri ve hataları güvenli statik değerlere çevirir (Convert Formulas to Static Values)
   * 
   * @param {string[]} headers 
   * @param {Array<Array<any>>} rows 
   * @param {Object} [options]
   * @returns {{ headers: string[], rows: Array<Array<any>>, stats: Object }}
   */
  function convertFormulasToStaticValues(headers, rows, options) {
    options = options || {};
    const cleanErrors = options.cleanErrors !== false;
    const errorReplacement = options.errorReplacement !== undefined ? options.errorReplacement : '';

    const ERROR_REGEX = /^#(REF!|VALUE!|NAME\?|N\/A|DIV\/0!|NULL!|NUM!)$/i;

    let formulasConverted = 0;
    let errorsCleaned = 0;

    const outRows = rows.map(r => {
      return r.map(cell => {
        if (cell === null || cell === undefined) return '';
        const str = String(cell).trim();

        if (cleanErrors && ERROR_REGEX.test(str)) {
          errorsCleaned++;
          return errorReplacement;
        }

        // Formül metni başına ' eklenerek dondurulur. Eskiden yalnız baştaki '='
        // siliniyordu: "=+HYPERLINK(...)" canlı "+HYPERLINK(...)" formülüne,
        // "=-2+3+cmd|..." DDE yüküne dönüşüyordu; +, -, @ ile başlayanlara hiç
        // dokunulmuyordu.
        const korunan = csvIO().guvenliHucre(cell);
        if (korunan !== cell) {
          formulasConverted++;
          return korunan;
        }

        return cell;
      });
    });

    return {
      headers: headers.slice(),
      rows: outRows,
      stats: {
        formulasConvertedCount: formulasConverted,
        errorsCleanedCount: errorsCleaned
      }
    };
  }

  /**
   * Harici çalışma kitabı bağlantılarını (External Links) koparır
   * (Break External Links)
   * 
   * @param {string[]} headers 
   * @param {Array<Array<any>>} rows 
   * @returns {{ headers: string[], rows: Array<Array<any>>, stats: Object }}
   */
  function breakExternalLinks(headers, rows) {
    const EXTERNAL_LINK_REGEX = /='?(\[[^\]]+\]|https?:\/\/[^\s]+|\\\\[^\s]+)[^'!]*'?!/gi;
    // test() için ayrı, g bayraksız kopya: g bayraklı nesnenin lastIndex'i hücreler
    // arasında taşınıyor ve ardışık dış bağlantılı hücreler atlanıyordu.
    const EXTERNAL_LINK_TEST = new RegExp(EXTERNAL_LINK_REGEX.source, 'i');

    let brokenCount = 0;
    const outRows = rows.map(r => {
      return r.map(cell => {
        if (cell === null || cell === undefined) return '';
        const str = String(cell);
        if (EXTERNAL_LINK_TEST.test(str)) {
          brokenCount++;
          return str.replace(EXTERNAL_LINK_REGEX, '=');
        }
        return cell;
      });
    });

    return {
      headers: headers.slice(),
      rows: outRows,
      stats: {
        externalLinksBrokenCount: brokenCount
      }
    };
  }

  // ==========================================
  // WB-14: Clipboard Workbench
  // ==========================================

  /**
   * Panodan kopyalanan TSV/CSV metnini tabloya dönüştürür
   */
  function parseClipboardTabular(text) {
    if (!text || typeof text !== 'string') return { headers: [], rows: [] };
    // Yalnız sondaki satır sonları atılır: tüm metni trim etmek boş ilk hücrenin
    // sekmesini silip başlıkları bir sütun kaydırıyordu.
    const clean = text.replace(/^﻿/, '').replace(/(?:\r\n|\r|\n)+$/, '');
    if (!clean.trim()) return { headers: [], rows: [] };

    // TSV mi CSV mi?
    const ilkSatir = clean.split(/\r\n|\n|\r/, 1)[0];
    const delim = ilkSatir.includes('\t') ? '\t' : (ilkSatir.includes(';') ? ';' : ',');

    // Excel, satır sonu/sekme içeren hücreyi tırnaklayarak kopyalar; düz split
    // bu hücreleri bölüp satırları kaydırıyordu. Tek tırnak (') veridir, silinmez.
    const parsed = csvIO().parse(clean, { delimiter: delim, trim: true }).rows;
    const headers = parsed[0];
    const rows = parsed.slice(1);

    return {
      headers: headers,
      rows: rows,
      rowCount: rows.length,
      colCount: headers.length
    };
  }

  /**
   * Tabloyu tekrar panoya yapıştırılabilir temiz TSV metnine dönüştürür
   */
  /* Excel'in kendi pano biçimi: sekmeyle ayrılmış, sekme / satır sonu / tırnak
     içeren hücre tırnaklanır. Eskiden hiçbir hücre tırnaklanmıyordu; içinde
     satır sonu olan tek bir hücre yapıştırılınca tabloyu kaydırıyordu.
     Formül koruması uygulanmaz: pano verisi kullanıcının kendi hücreleridir ve
     değerin olduğu gibi geri yapıştırılması beklenir. */
  function formatClipboardTabular(headers, rows) {
    const io = csvIO();
    const alan = c => io.quoteField(c === null || c === undefined ? '' : String(c), '\t');
    const lines = [];
    if (headers && headers.length > 0) {
      lines.push(headers.map(alan).join('\t'));
    }
    if (rows && rows.length > 0) {
      rows.forEach(r => {
        lines.push(r.map(alan).join('\t'));
      });
    }
    return lines.join('\r\n');
  }

  // ==========================================
  // WB-15: Synthetic Data Generator from Schema
  // ==========================================

  /**
   * Şema tanımına göre deterministik sahte test verisi üretir
   * 
   * @param {Array<{ name: string, type: string, min?: number, max?: number, values?: any[] }>} schema 
   * @param {number} rowCount 
   * @returns {{ headers: string[], rows: Array<Array<any>> }}
   */
  function generateSyntheticFromSchema(schema, rowCount) {
    if (!Array.isArray(schema) || rowCount <= 0) {
      throw new Error('Geçerli bir şema dizisi ve pozitif rowCount gereklidir.');
    }

    const headers = schema.map(s => s.name);
    const rows = [];

    const FIRST_NAMES = ['Ahmet', 'Mehmet', 'Ayşe', 'Fatma', 'Ali', 'Zeynep', 'Mustafa', 'Elif', 'Can', 'Ece'];
    const LAST_NAMES = ['Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Yıldız', 'Öztürk', 'Aydın', 'Özdemir', 'Arslan'];
    const CITIES = ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya', 'Adana', 'Konya', 'Gaziantep'];

    for (let r = 1; r <= rowCount; r++) {
      const row = [];
      schema.forEach((col, cIdx) => {
        switch (col.type) {
          case 'id':
            row.push(`CUST_${String(r).padStart(6, '0')}`);
            break;
          case 'name': {
            const fn = FIRST_NAMES[(r + cIdx) % FIRST_NAMES.length];
            const ln = LAST_NAMES[(r * 2 + cIdx) % LAST_NAMES.length];
            row.push(`${fn} ${ln}`);
            break;
          }
          case 'email':
            row.push(`kullanici_${r}@ornekfirma.local`);
            break;
          case 'phone':
            row.push(`0532${String(1000000 + (r * 137) % 8999999).slice(0, 7)}`);
            break;
          case 'integer': {
            const min = col.min !== undefined ? col.min : 1;
            const max = col.max !== undefined ? col.max : 1000;
            const val = min + ((r * 31) % (max - min + 1));
            row.push(val);
            break;
          }
          case 'decimal': {
            const min = col.min !== undefined ? col.min : 10;
            const max = col.max !== undefined ? col.max : 5000;
            const val = min + ((r * 97.43) % (max - min));
            row.push(parseFloat(val.toFixed(2)));
            break;
          }
          case 'city':
            row.push(CITIES[(r + cIdx) % CITIES.length]);
            break;
          case 'allowed_values': {
            const list = col.values || ['A', 'B', 'C'];
            row.push(list[r % list.length]);
            break;
          }
          case 'date': {
            const year = 2026;
            const month = String(1 + (r % 12)).padStart(2, '0');
            const day = String(1 + (r % 28)).padStart(2, '0');
            row.push(`${year}-${month}-${day}`);
            break;
          }
          default:
            row.push(`Veri_${r}_${cIdx + 1}`);
        }
      });
      rows.push(row);
    }

    return {
      headers: headers,
      rows: rows
    };
  }

  return {
    appendTables: appendTables,
    splitTableByColumn: splitTableByColumn,
    repairCsv: repairCsv,
    createCsvRepairer: createCsvRepairer,
    pivotTable: pivotTable,
    explodeColumn: explodeColumn,
    implodeRows: implodeRows,
    flattenJsonRecords: flattenJsonRecords,
    inspectWorkbookStructure: inspectWorkbookStructure,
    trimEmptyUsedRange: trimEmptyUsedRange,
    convertFormulasToStaticValues: convertFormulasToStaticValues,
    breakExternalLinks: breakExternalLinks,
    parseClipboardTabular: parseClipboardTabular,
    formatClipboardTabular: formatClipboardTabular,
    generateSyntheticFromSchema: generateSyntheticFromSchema
  };
}));
