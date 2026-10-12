/**
 * workbench/validator-engine.js
 * 
 * Local-First Data & Office Workbench: Data Quality Validator (WB-03)
 * 
 * "Excel Dosyasına Test Yazma":
 * Kolon bazında beyana dayalı (declarative) doğrulama kuralları belirler,
 * dosyayı testten geçirip 3 ayrı çıktı üretir:
 * 1. cleanRows (Testi geçen temiz satırlar)
 * 2. invalidRows (Hata açıklamaları sütunuyla birlikte kalan satırlar)
 * 3. validationReport (Kural bazlı istatistikler ve başarı oranları)
 * 
 * %100 İstemci Tarafı, Deterministik, Sıfır Dış Bağımlılık.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ValidatorEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  const PHONE_TR_RE = /^(?:\+?90|0)?\s*[1-9]\d{2}\s*\d{3}\s*\d{2}\s*\d{2}$/;

  // Sayı/tarih çözümleyicisi recipe-engine.js'te tek yerde tutulur: doğrulama ile
  // type_cast aynı hücreyi farklı okumasın (eskiden "12.5" burada 125 sayılıyordu).
  function recipeEngine() {
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      return require('./recipe-engine.js');
    }
    const g = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {});
    if (!g.RecipeEngine) throw new Error('recipe-engine.js yüklenmedi; sayı/tarih kuralı doğrulanamaz.');
    return g.RecipeEngine;
  }

  /**
   * regex kuralını bir kez derler. g/y bayrakları atılır: tek RegExp nesnesi
   * satırlar arasında paylaşıldığında lastIndex durumu test() sonucunu
   * satırdan satıra değiştirirdi. Geçersiz ifade açık hata fırlatır; eskiden
   * sessizce "geçti" sayılıyor ve bozuk kural tüm satırları temiz gösteriyordu.
   */
  function kuralRegexiDerle(rule) {
    try {
      return new RegExp(rule.pattern, String(rule.flags || '').replace(/[gy]/g, ''));
    } catch (e) {
      throw new Error(`Geçersiz düzenli ifade kuralı ("${rule.column}" sütunu): /${rule.pattern}/ — ${e.message}`);
    }
  }

  function yerelTarihIso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * TCKN Doğrulama Algoritması
   */
  function isValidTckn(val) {
    const s = String(val || '').trim();
    if (!/^[1-9]\d{10}$/.test(s)) return false;
    const digits = s.split('').map(Number);
    const d10 = ((digits[0] + digits[2] + digits[4] + digits[6] + digits[8]) * 7 -
                 (digits[1] + digits[3] + digits[5] + digits[7])) % 10;
    if ((d10 < 0 ? d10 + 10 : d10) !== digits[9]) return false;
    const sum10 = digits.slice(0, 10).reduce((a, b) => a + b, 0);
    return (sum10 % 10) === digits[10];
  }

  /**
   * VKN Doğrulama Algoritması (GİB; type-catalog.js vknValid ile aynı).
   * Her hane için (d + 10 - (i+1)) % 10; sonuç 9 ise toplama 9 eklenir, değilse
   * (sonuç * 2^(10-(i+1))) % 9. Eskiden "sonuç 9" dalı eksikti: 9·2^k mod 9 = 0
   * eklendiği için geçerli VKN'lerin yaklaşık üçte biri (ör. 1000000686) reddediliyordu.
   */
  function isValidVkn(val) {
    const s = String(val || '').trim();
    if (!/^\d{10}$/.test(s)) return false;
    let total = 0;
    for (let i = 0; i < 9; i++) {
      const mod = (Number(s[i]) + 10 - (i + 1)) % 10;
      if (mod === 9) {
        total += 9;
      } else {
        total += (mod * Math.pow(2, 10 - (i + 1))) % 9;
      }
    }
    return ((10 - (total % 10)) % 10) === Number(s[9]);
  }

  /**
   * Sütun adından veya indeksinden indeks bulucu
   */
  function resolveColIndex(col, headers) {
    if (typeof col === 'number') {
      return (col >= 0 && col < headers.length) ? col : -1;
    }
    if (typeof col === 'string') {
      const idx = headers.indexOf(col);
      if (idx !== -1) return idx;
      const lower = col.trim().toLocaleLowerCase('tr-TR');
      return headers.findIndex(h => String(h).trim().toLocaleLowerCase('tr-TR') === lower);
    }
    return -1;
  }

  /**
   * Tek bir kuralı hücre değerine göre test eder
   * 
   * @param {any} val - Hücre değeri
   * @param {Object} rule - Kural tanımı
   * @param {RegExp} [derlenmisRegex] - validateDataset'in kural başına bir kez derlediği ifade
   * @returns {{ passed: boolean, message: string }}
   */
  function testRule(val, rule, derlenmisRegex) {
    const isNullOrEmpty = val === null || val === undefined || String(val).trim() === '';
    const strVal = isNullOrEmpty ? '' : String(val).trim();

    // 'required' veya 'not_empty' kontrolü
    if (rule.type === 'required' || rule.type === 'not_empty') {
      if (isNullOrEmpty) {
        return { passed: false, message: rule.message || 'Zorunlu alan boş olamaz' };
      }
      return { passed: true };
    }

    // Eğer değer boşsa ve kural 'required' değilse, aksi belirtilmedikçe başarılı kabul edilir
    if (isNullOrEmpty) {
      return { passed: true };
    }

    switch (rule.type) {
      case 'exact_length': {
        const len = parseInt(rule.length, 10);
        if (strVal.length !== len) {
          return { passed: false, message: rule.message || `Tam ${len} karakter olmalıdır (Mevcut: ${strVal.length})` };
        }
        break;
      }

      case 'min_length': {
        const min = parseInt(rule.min, 10);
        if (strVal.length < min) {
          return { passed: false, message: rule.message || `En az ${min} karakter olmalıdır` };
        }
        break;
      }

      case 'max_length': {
        const max = parseInt(rule.max, 10);
        if (strVal.length > max) {
          return { passed: false, message: rule.message || `En fazla ${max} karakter olmalıdır` };
        }
        break;
      }

      case 'regex': {
        const reg = derlenmisRegex || kuralRegexiDerle(rule);
        if (!reg.test(strVal)) {
          return { passed: false, message: rule.message || 'Belirtilen format kalıbına uymuyor' };
        }
        break;
      }

      case 'numeric': {
        // Ham değer verilir: XLSX'ten gelen gerçek sayı (12.5) metne çevrilip yeniden
        // yorumlanmamalı. Eski kod tüm noktaları silip 12.5'i 125 okuyordu.
        const num = recipeEngine().parseLocaleNumber(val);
        if (isNaN(num)) {
          return { passed: false, message: rule.message || 'Sayısal bir değer olmalıdır' };
        }
        if (rule.min !== undefined && num < rule.min) {
          return { passed: false, message: rule.message || `Değer en az ${rule.min} olmalıdır` };
        }
        if (rule.max !== undefined && num > rule.max) {
          return { passed: false, message: rule.message || `Değer en fazla ${rule.max} olmalıdır` };
        }
        if (rule.positive && num <= 0) {
          return { passed: false, message: rule.message || 'Değer 0\'dan büyük olmalıdır' };
        }
        if (rule.non_negative && num < 0) {
          return { passed: false, message: rule.message || 'Değer negatif olamaz' };
        }
        break;
      }

      case 'allowed_values': {
        const allowed = Array.isArray(rule.values) ? rule.values : String(rule.values).split(',').map(s => s.trim());
        const isCaseSensitive = !!rule.caseSensitive;
        const matched = allowed.some(item =>
          isCaseSensitive
            ? String(item) === strVal
            : String(item).toLocaleLowerCase('tr-TR') === strVal.toLocaleLowerCase('tr-TR')
        );
        if (!matched) {
          return { passed: false, message: rule.message || `İzin verilen değerler listesinde yok (${allowed.join(', ')})` };
        }
        break;
      }

      case 'email': {
        if (!EMAIL_RE.test(strVal)) {
          return { passed: false, message: rule.message || 'Geçerli bir e-posta adresi formatında değil' };
        }
        break;
      }

      case 'phone': {
        if (!PHONE_TR_RE.test(strVal.replace(/[\s()-]/g, ''))) {
          return { passed: false, message: rule.message || 'Geçerli bir telefon numarası formatında değil' };
        }
        break;
      }

      case 'tckn': {
        if (!isValidTckn(strVal)) {
          return { passed: false, message: rule.message || 'Geçersiz TCKN kontrol algoritması' };
        }
        break;
      }

      case 'vkn': {
        if (!isValidVkn(strVal)) {
          return { passed: false, message: rule.message || 'Geçersiz VKN kontrol algoritması' };
        }
        break;
      }

      case 'date': {
        // new Date(metin) "31.12.2024"ü reddediyor, "05.01.2024"ü 1 Mayıs okuyor,
        // 31.02'yi 2 Mart'a yuvarlıyordu. Karşılaştırma gün düzeyinde: bugün ne
        // geçmiş ne gelecek sayılır.
        const tarih = recipeEngine().parseLocaleDate(val);
        if (!tarih) {
          return { passed: false, message: rule.message || 'Geçerli bir tarih değil' };
        }
        const bugun = yerelTarihIso(new Date());
        if (rule.not_future && tarih.iso > bugun) {
          return { passed: false, message: rule.message || 'Tarih gelecekte bir gün olamaz' };
        }
        if (rule.not_past && tarih.iso < bugun) {
          return { passed: false, message: rule.message || 'Tarih geçmişte bir gün olamaz' };
        }
        break;
      }
    }

    return { passed: true };
  }

  /**
   * Tüm dataset üzerinde kuralları çalıştırır
   * 
   * @param {string[]} headers 
   * @param {Array<Array<any>>} rows 
   * @param {Array<Object>} rules - Kurallar listesi
   * @returns {{ cleanRows: Array<Array<any>>, invalidRows: Array<Array<any>>, invalidHeaders: string[], report: Object }}
   */
  function validateDataset(headers, rows, rules) {
    if (!Array.isArray(headers) || !Array.isArray(rows) || !Array.isArray(rules)) {
      throw new Error('headers, rows ve rules dizi olmalıdır.');
    }

    const colIndexCache = new Map();
    const regexCache = new Map();
    rules.forEach((rule, ruleIdx) => {
      const idx = resolveColIndex(rule.column, headers);
      colIndexCache.set(ruleIdx, idx);
      // Satır döngüsünden önce derlenir: geçersiz ifade veriye dokunmadan hata verir.
      if (rule.type === 'regex') regexCache.set(ruleIdx, kuralRegexiDerle(rule));
    });

    // Uniqueness kuralları için önceden sıklık haritası çıkar
    const uniqueRules = [];
    rules.forEach((rule, ruleIdx) => {
      if (rule.type === 'unique') {
        const ci = colIndexCache.get(ruleIdx);
        if (ci >= 0) {
          const freqMap = new Map();
          rows.forEach(r => {
            const v = r[ci];
            if (v !== null && v !== undefined && String(v).trim() !== '') {
              const k = String(v).trim().toLocaleLowerCase('tr-TR');
              freqMap.set(k, (freqMap.get(k) || 0) + 1);
            }
          });
          uniqueRules.push({ ruleIdx, colIdx: ci, freqMap, rule });
        }
      }
    });

    const cleanRows = [];
    const invalidRows = [];
    const ruleStats = rules.map((r, i) => ({
      ruleIndex: i + 1,
      column: r.column,
      type: r.type,
      passedCount: 0,
      failedCount: 0
    }));

    const invalidHeaders = headers.concat(['HATA_NEDENLERI']);

    rows.forEach((row, rowIdx) => {
      const errors = [];

      // 1. Standart kurallar
      rules.forEach((rule, ruleIdx) => {
        if (rule.type === 'unique') return; // Ayrı kontrol edilecek

        const ci = colIndexCache.get(ruleIdx);
        if (ci < 0) return;

        const val = row[ci];
        const res = testRule(val, rule, regexCache.get(ruleIdx));

        if (res.passed) {
          ruleStats[ruleIdx].passedCount++;
        } else {
          ruleStats[ruleIdx].failedCount++;
          errors.push(`[${rule.column}: ${res.message}]`);
        }
      });

      // 2. Uniqueness kontrolleri
      uniqueRules.forEach(ur => {
        const val = row[ur.colIdx];
        if (val !== null && val !== undefined && String(val).trim() !== '') {
          const k = String(val).trim().toLocaleLowerCase('tr-TR');
          const count = ur.freqMap.get(k) || 0;
          if (count > 1) {
            ruleStats[ur.ruleIdx].failedCount++;
            errors.push(`[${ur.rule.column}: Benzersiz değil (${count} tekrar)]`);
          } else {
            ruleStats[ur.ruleIdx].passedCount++;
          }
        } else {
          ruleStats[ur.ruleIdx].passedCount++;
        }
      });

      if (errors.length === 0) {
        cleanRows.push(row);
      } else {
        const rowWithErrors = row.slice();
        rowWithErrors.push(errors.join('; '));
        invalidRows.push(rowWithErrors);
      }
    });

    const totalRows = rows.length;
    const cleanCount = cleanRows.length;
    const invalidCount = invalidRows.length;
    const passRate = totalRows > 0 ? parseFloat(((cleanCount / totalRows) * 100).toFixed(1)) : 100;

    return {
      cleanRows: cleanRows,
      invalidRows: invalidRows,
      invalidHeaders: invalidHeaders,
      report: {
        totalRows: totalRows,
        cleanRowsCount: cleanCount,
        invalidRowsCount: invalidCount,
        passRate: passRate,
        rulesExecuted: rules.length,
        ruleStats: ruleStats
      }
    };
  }

  /**
   * Kural profilini dışa aktarır
   */
  function exportRules(rules, profileName) {
    return {
      schemaVersion: 'masko-validator-v1',
      profileName: profileName || 'Masko Kalite Kural Seti',
      createdAt: new Date().toISOString(),
      rulesCount: rules ? rules.length : 0,
      rules: rules || []
    };
  }

  return {
    testRule: testRule,
    validateDataset: validateDataset,
    exportRules: exportRules,
    isValidTckn: isValidTckn,
    isValidVkn: isValidVkn
  };
}));
