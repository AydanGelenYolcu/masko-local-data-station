/**
 * workbench/profiler-engine.js
 * 
 * Local-First Data & Office Workbench: Data Profiler & Automated Health Check (WB-02)
 * 
 * Dosya yüklendiği anda sıfır kod ile:
 * 1. Sütun metrikleri tablosu (Tip, Null %, Unique %, Min/Max, Ortalama, En Sık Değer, Örnekler)
 * 2. Otomatik sağlık alarmları (Karışık tipler, baştaki sıfır kaybı riski, tutarsız tarihler, bozuk satırlar)
 * 3. Bütünleşik Veri Sağlık Skoru (0 - 100)
 * 
 * %100 İstemci Tarafı, Deterministik, Sıfır Dış Bağımlılık.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ProfilerEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  const PHONE_TR_RE = /^(?:\+?90|0)?\s*[1-9]\d{2}\s*\d{3}\s*\d{2}\s*\d{2}$/;
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TR_DATE_RE = /^\d{2}[./-]\d{2}[./-]\d{4}$/;
  const DIGITS_ONLY_RE = /^\d+$/;

  /**
   * Tek bir hücrenin tipini ve özelliklerini analiz eder
   */
  function inspectCell(val) {
    if (val === null || val === undefined) {
      return { isNull: true, type: 'empty' };
    }
    const str = String(val).trim();
    if (str === '') {
      return { isNull: true, type: 'empty' };
    }

    // Boole
    const lower = str.toLowerCase();
    if (lower === 'true' || lower === 'false' || lower === 'evet' || lower === 'hayır') {
      return { isNull: false, type: 'boolean', raw: val, strVal: str };
    }

    // E-posta
    if (EMAIL_RE.test(str)) {
      return { isNull: false, type: 'email', raw: val, strVal: str };
    }

    // Telefon
    if (PHONE_TR_RE.test(str.replace(/[\s()-]/g, ''))) {
      return { isNull: false, type: 'phone', raw: val, strVal: str };
    }

    // Tarih
    if (ISO_DATE_RE.test(str)) {
      return { isNull: false, type: 'date', dateFormat: 'YYYY-MM-DD', raw: val, strVal: str };
    }
    if (TR_DATE_RE.test(str)) {
      return { isNull: false, type: 'date', dateFormat: 'DD.MM.YYYY', raw: val, strVal: str };
    }

    // Sayı kontrolü
    let numStr = str;
    let isTrNumeric = false;
    if (/^-?\d{1,3}(?:\.\d{3})*,\d+$/.test(str)) {
      numStr = str.replace(/\./g, '').replace(',', '.');
      isTrNumeric = true;
    } else if (/^-?\d+,\d+$/.test(str)) {
      numStr = str.replace(',', '.');
      isTrNumeric = true;
    }

    if (!isNaN(numStr) && !isNaN(parseFloat(numStr)) && isFinite(numStr)) {
      const num = parseFloat(numStr);
      const isInt = Number.isInteger(num) && !str.includes('.') && !str.includes(',');
      const hasLeadingZero = DIGITS_ONLY_RE.test(str) && str.length > 1 && str.startsWith('0');
      return {
        isNull: false,
        type: isInt ? 'integer' : 'decimal',
        numVal: num,
        hasLeadingZero: hasLeadingZero,
        isTrNumeric: isTrNumeric,
        raw: val,
        strVal: str
      };
    }

    return { isNull: false, type: 'string', raw: val, strVal: str };
  }

  /* Hızlı sınıflandırıcı: inspectCell ile birebir aynı türü, sayıyı, baştaki
     sıfırı ve tarih biçimini verir; ama hücre başına nesne üretmez ve her
     düzenli ifadeyi yalnızca eşleşmesi mümkünse çalıştırır (e-posta ancak '@'
     varsa, tarih ancak 10 karakterse, telefon ancak 10-13 haneyse...).
     Sonuç modül düzeyindeki geçici alanlara yazılır. */
  const TUR = ['boolean', 'email', 'phone', 'date', 'integer', 'decimal', 'string'];
  const T_BOOL = 0, T_EMAIL = 1, T_PHONE = 2, T_DATE = 3, T_INT = 4, T_DEC = 5, T_STR = 6;
  const TEL_TEMIZLE_RE = /[\s()-]/;
  const TR_BINLIK_RE = /^-?\d{1,3}(?:\.\d{3})*,\d+$/;
  const TR_ONDALIK_RE = /^-?\d+,\d+$/;
  let _sayi = 0, _sifir = false, _tarihBicimi = null;

  function hizliSinifla(str) {
    _tarihBicimi = null; _sifir = false;
    const n = str.length;
    if (n === 4 || n === 5) {
      const lower = str.toLowerCase();
      if (lower === 'true' || lower === 'false' || lower === 'evet' || lower === 'hayır') return T_BOOL;
    }
    if (str.indexOf('@') !== -1 && EMAIL_RE.test(str)) return T_EMAIL;
    const tel = TEL_TEMIZLE_RE.test(str) ? str.replace(/[\s()-]/g, '') : str;
    if (tel.length >= 10 && tel.length <= 13 && PHONE_TR_RE.test(tel)) return T_PHONE;
    if (n === 10) {
      if (ISO_DATE_RE.test(str)) { _tarihBicimi = 'YYYY-MM-DD'; return T_DATE; }
      if (TR_DATE_RE.test(str)) { _tarihBicimi = 'DD.MM.YYYY'; return T_DATE; }
    }
    let numStr = str;
    if (str.indexOf(',') !== -1) {
      if (TR_BINLIK_RE.test(str)) numStr = str.replace(/\./g, '').replace(',', '.');
      else if (TR_ONDALIK_RE.test(str)) numStr = str.replace(',', '.');
    }
    // isNaN(x) && isFinite(x) ikisi de Number(x) üzerinden karar verir: tek dönüşüm.
    const sayisal = +numStr;
    const num = sayisal === sayisal && sayisal !== Infinity && sayisal !== -Infinity ? parseFloat(numStr) : NaN;
    if (num === num) {
      _sayi = num;
      _sifir = n > 1 && str.charCodeAt(0) === 48 && DIGITS_ONLY_RE.test(str);
      return (Number.isInteger(num) && str.indexOf('.') === -1 && str.indexOf(',') === -1) ? T_INT : T_DEC;
    }
    return T_STR;
  }

  /**
   * Tüm veri kümesini profiller ve sağlık raporu üretir
   * 
   * @param {string[]} headers - Sütun başlıkları
   * @param {Array<Array<any>>} rows - Tablo satırları
   * @param {Object} [options]
   * @param {number} [options.sampleLimit=5] - Her sütun için gösterilecek örnek sayısı
   * @returns {Object} Profil ve Sağlık Denetim Raporu
   */
  function profileDataset(headers, rows, options) {
    options = options || {};
    const sampleLimit = options.sampleLimit || 5;

    const totalRows = Array.isArray(rows) ? rows.length : 0;
    const totalCols = Array.isArray(headers) ? headers.length : 0;

    const alerts = [];
    let jaggedRowsCount = 0;
    const jaggedRowIndices = [];

    // 1. Satır uzunluğu (Jagged Rows) kontrolü
    if (rows && rows.length > 0) {
      rows.forEach((r, idx) => {
        if (!Array.isArray(r) || r.length !== totalCols) {
          jaggedRowsCount++;
          if (jaggedRowIndices.length < 5) {
            jaggedRowIndices.push(idx + 1);
          }
        }
      });
    }

    if (jaggedRowsCount > 0) {
      alerts.push({
        code: 'JAGGED_ROWS',
        severity: 'critical',
        message: `${jaggedRowsCount} satırda sütun sayısı başlıkla uyuşmuyor (Beklenen: ${totalCols} sütun).`,
        details: { count: jaggedRowsCount, sampleRows: jaggedRowIndices }
      });
    }

    // 2. Sütun bazında istatistiklerin toplanması
    const columns = [];
    let totalPenalty = 0;

    for (let c = 0; c < totalCols; c++) {
      const colName = String(headers[c] !== null && headers[c] !== undefined ? headers[c] : `Kolon_${c + 1}`);
      const isEmailColName = colName.toLowerCase().includes('eposta') || colName.toLowerCase().includes('email');
      const typeFreq = {};
      const turSayac = new Float64Array(TUR.length);
      const turIlkGorulme = [];   // typeFreq anahtar sırası ilk görülme sırasıdır
      const dateFormats = new Set();
      const valueFreq = new Map();
      let nullCount = 0;
      let leadingZeroCount = 0;
      let numericValues = null;
      let numericCount = 0;
      let minStr = null;
      let maxStr = null;
      let invalidEmailCount = 0;
      let hasEmailCandidates = false;

      /* 1. geçiş: yalnız kırp ve say. Dar döngü bilerek küçük tutulur: tarayıcı
         iş parçacığında (Chrome) sınıflandırmayla aynı gövdedeki Map işlemleri
         ~20 kat yavaş derleniyordu (1M satır: 3 sn yerine 37 sn). */
      for (let r = 0; r < totalRows; r++) {
        const row = rows[r];
        const val = row ? row[c] : null;
        if (val === null || val === undefined) { nullCount++; continue; }
        const strVal = typeof val === 'string' ? val.trim() : String(val).trim();
        if (strVal === '') { nullCount++; continue; }
        valueFreq.set(strVal, (valueFreq.get(strVal) || 0) + 1);
      }

      /* 2. geçiş: her FARKLI değer bir kez sınıflandırılır ve sayısıyla
         ağırlıklandırılır. Map ilk görülme sırasını korur; bu yüzden tür sırası,
         en kısa/uzun değer ve örnekler satır sırasıyla işlemekle aynı çıkar. */
      numericValues = new Float64Array(Math.max(16, totalRows - nullCount));
      valueFreq.forEach((adet, strVal) => {
        const tur = hizliSinifla(strVal);
        if (turSayac[tur] === 0) turIlkGorulme.push(tur);
        turSayac[tur] += adet;

        if (tur === T_INT || tur === T_DEC) {
          const sayi = _sayi;
          for (let k = 0; k < adet; k++) numericValues[numericCount++] = sayi;
          if (_sifir) leadingZeroCount += adet;
        }

        if (_tarihBicimi) dateFormats.add(_tarihBicimi);

        if (tur === T_EMAIL) {
          hasEmailCandidates = true;
        } else if (isEmailColName || strVal.indexOf('@') !== -1) {
          invalidEmailCount += adet;
        }

        if (minStr === null || strVal.length < minStr.length) minStr = strVal;
        if (maxStr === null || strVal.length > maxStr.length) maxStr = strVal;
      });
      turIlkGorulme.forEach(t => { typeFreq[TUR[t]] = turSayac[t]; });

      const filledCount = totalRows - nullCount;
      const uniqueCount = valueFreq.size;
      const duplicateCount = filledCount - uniqueCount;
      const nullPercent = totalRows > 0 ? parseFloat(((nullCount / totalRows) * 100).toFixed(1)) : 0;
      const uniquePercent = filledCount > 0 ? parseFloat(((uniqueCount / filledCount) * 100).toFixed(1)) : 0;

      // Baskın tip tespiti
      let inferredType = 'empty';
      let maxTypeCount = 0;
      Object.keys(typeFreq).forEach(t => {
        if (typeFreq[t] > maxTypeCount) {
          maxTypeCount = typeFreq[t];
          inferredType = t;
        }
      });

      // Karışık tip tespiti (Mixed Types)
      const nonNullTypes = Object.keys(typeFreq);
      const isMixedType = nonNullTypes.length > 1;

      if (isMixedType) {
        alerts.push({
          code: 'MIXED_TYPE',
          severity: 'warning',
          column: colName,
          message: `"${colName}" sütununda karışık veri tipleri bulundu (${nonNullTypes.join(', ')}).`,
          details: typeFreq
        });
        totalPenalty += 8;
      }

      // Baştaki sıfır riski (Leading zero risk in Excel)
      if (leadingZeroCount > 0) {
        alerts.push({
          code: 'LEADING_ZERO_RISK',
          severity: 'warning',
          column: colName,
          message: `"${colName}" sütunundaki ${leadingZeroCount} kayıtta baştaki sıfırlar ("0123...") Excel'de açıldığında silinebilir.`,
          details: { leadingZeroCount }
        });
        totalPenalty += 5;
      }

      // Tutarsız tarih formatları
      if (dateFormats.size > 1) {
        alerts.push({
          code: 'INCONSISTENT_DATES',
          severity: 'warning',
          column: colName,
          message: `"${colName}" sütununda ${dateFormats.size} farklı tarih formatı bir arada kullanılmış (${Array.from(dateFormats).join(', ')}).`,
          details: Array.from(dateFormats)
        });
        totalPenalty += 6;
      }

      // Geçersiz e-posta uyarıları
      if ((hasEmailCandidates || isEmailColName) && invalidEmailCount > 0) {
        alerts.push({
          code: 'INVALID_EMAILS',
          severity: 'warning',
          column: colName,
          message: `"${colName}" e-posta sütununda ${invalidEmailCount} adet geçersiz e-posta adresi tespit edildi.`,
          details: { invalidEmailCount }
        });
        totalPenalty += 5;
      }

      // Tamamen boş sütun
      if (nullCount === totalRows && totalRows > 0) {
        alerts.push({
          code: 'EMPTY_COLUMN',
          severity: 'info',
          column: colName,
          message: `"${colName}" sütunu tamamen boştur (%100 Null).`,
          details: {}
        });
        totalPenalty += 3;
      }

      // En sık geçen değer (Mode)
      let topValue = '—';
      let topValueFreq = 0;
      valueFreq.forEach((cnt, val) => {
        if (cnt > topValueFreq) {
          topValueFreq = cnt;
          topValue = val;
        }
      });
      const topValuePercent = filledCount > 0 ? parseFloat(((topValueFreq / filledCount) * 100).toFixed(1)) : 0;

      // Sayısal istatistikler
      let numStats = { min: null, max: null, mean: null, median: null };
      if (numericCount > 0) {
        // Yazılı dizinin yerel sayısal sıralaması; toplam sıralı dizide alınır
        // (kayan nokta toplamı eskisiyle aynı sırada, dolayısıyla aynı sonuç).
        const sirali = numericValues.subarray(0, numericCount).sort();
        const min = sirali[0];
        const max = sirali[numericCount - 1];
        let sum = 0;
        for (let i = 0; i < numericCount; i++) sum += sirali[i];
        const mean = parseFloat((sum / numericCount).toFixed(2));
        const mid = Math.floor(numericCount / 2);
        const median = numericCount % 2 !== 0
          ? sirali[mid]
          : parseFloat(((sirali[mid - 1] + sirali[mid]) / 2).toFixed(2));

        numStats = { min, max, mean, median };
      }

      // Temsili örnekler
      const samples = Array.from(valueFreq.keys()).slice(0, sampleLimit);

      columns.push({
        columnIndex: c,
        name: colName,
        inferredType: inferredType,
        totalCount: totalRows,
        filledCount: filledCount,
        nullCount: nullCount,
        nullPercent: nullPercent,
        uniqueCount: uniqueCount,
        uniquePercent: uniquePercent,
        duplicateCount: duplicateCount,
        topValue: topValue,
        topValueFreq: topValueFreq,
        topValuePercent: topValuePercent,
        min: numStats.min !== null ? numStats.min : (minStr ? minStr : '—'),
        max: numStats.max !== null ? numStats.max : (maxStr ? maxStr : '—'),
        mean: numStats.mean,
        median: numStats.median,
        samples: samples,
        isMixedType: isMixedType,
        hasLeadingZeroRisk: leadingZeroCount > 0
      });
    }

    if (jaggedRowsCount > 0) totalPenalty += 20;

    // Genel Sağlık Skoru (0-100)
    const healthScore = Math.max(0, Math.min(100, Math.round(100 - totalPenalty)));

    return {
      summary: {
        totalRows: totalRows,
        totalCols: totalCols,
        healthScore: healthScore,
        alertCount: alerts.length,
        jaggedRowsCount: jaggedRowsCount
      },
      alerts: alerts,
      columns: columns
    };
  }

  return {
    inspectCell: inspectCell,
    profileDataset: profileDataset
  };
}));
