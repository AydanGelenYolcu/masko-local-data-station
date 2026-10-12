/**
 * workbench/recipe-engine.js
 * 
 * Local-First Data & Office Workbench: Composable Recipe & Workflow Pipeline Engine (WB-01)
 * 
 * Verisiz işlem adımlarını (Transformation Steps) doğrusal bir akışta çalıştırır,
 * adım adım geri alma (Undo/Redo) imkânı sunar, JSON reçete dışa/içe aktarımını ve
 * çoklu dosyalarda toplu (batch) yürütmeyi destekler.
 * 
 * %100 İstemci Tarafı, Deterministik, Sıfır Dış Bağımlılık.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RecipeEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // HMAC-SHA-256 kaynağı: tarayıcıda ../file-mask-engine.js, Node'da require.
  function fileMask() {
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      return require('../file-mask-engine.js');
    }
    const g = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {});
    if (!g.FileMaskEngine) throw new Error('file-mask-engine.js yüklenmedi; hash adımı çalıştırılamaz.');
    return g.FileMaskEngine;
  }

  // Adımda anahtar yoksa oturuma özgü rastgele anahtar kullanılır. Anahtar
  // tarif JSON'ına yazılmaz (bkz. exportRecipe): tarifle birlikte paylaşılan
  // bir anahtar, takma adları sözlük saldırısına açık hale getirirdi.
  let oturumAnahtari = null;
  function tarifAnahtari(key) {
    if (key !== null && key !== undefined && String(key) !== '') return String(key);
    if (!oturumAnahtari) oturumAnahtari = fileMask().createSecretKey();
    return oturumAnahtari;
  }

  // ==========================================
  // Yerel ayara duyarlı sayı ve tarih çözümleme
  // ==========================================
  // Tek çözümleyici: type_cast, filtre, hesaplanan sütun, validator-engine ve
  // files-engine (CSV sayı normalizasyonu) aynı kuralı kullanır. Eskiden her yer
  // kendi kuralını uyguluyordu: aynı "12.5" bir adımda 12.5, doğrulamada 125,
  // "1,234.56" ise 1.23456 okunuyordu.

  const BINLIK_NOKTA_RE = /^[1-9]\d{0,2}(?:\.\d{3})+$/;
  const BINLIK_VIRGUL_RE = /^[1-9]\d{0,2}(?:,\d{3})+$/;

  /**
   * Sayı metnini kanonik biçime ('-1234.56') çevirir; sayı değilse null döner.
   * - Hem '.' hem ',' varsa sonda olan ondalık ayracıdır (1.234,56 / 1,234.56).
   * - Yalnız ',' varsa ondalık virgüldür; '1,234' gibi tam binlik gruplama binliktir.
   * - Yalnız '.' varsa '1.234' gibi tam binlik gruplama binlik, aksi hâlde ondalıktır.
   * Binlik grubu 0 ile başlayamaz: '0,500' ve '0.123' ondalıktır, 500/123 değil.
   * Sondaki metin ('100 TL', '12abc') kabul edilmez: parseFloat'ın sessiz kırpması
   * sayısal doğrulamayı atlatıyordu. Baştaki sıfırlar korunur ('0123').
   */
  function normalizeLocaleNumberString(val) {
    // Gerçek sayı hücreleri (XLSX) yeniden yorumlanmaz: 1.234 sayısı 1234 olmamalı.
    if (typeof val === 'number') return Number.isFinite(val) ? String(val) : null;
    if (val === null || val === undefined || typeof val === 'boolean') return null;
    const s = String(val).trim();
    const m = /^([+-]?)([\d.,]+)$/.exec(s);
    if (!m) {
      // Bilimsel gösterim (Excel CSV'sinde 1.23E+11) yalnız nokta ondalıkla gelir.
      return /^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+$/.test(s) ? s : null;
    }
    const isaret = m[1] === '-' ? '-' : '';
    const govde = m[2];
    if (!/\d/.test(govde)) return null;
    const noktaVar = govde.indexOf('.') !== -1;
    const virgulVar = govde.indexOf(',') !== -1;
    let tam = govde;
    let kesir = '';

    if (noktaVar && virgulVar) {
      const ondalik = govde.lastIndexOf('.') > govde.lastIndexOf(',') ? '.' : ',';
      const binlik = ondalik === '.' ? ',' : '.';
      const parca = govde.split(ondalik);
      if (parca.length !== 2 || !/^\d+$/.test(parca[1])) return null;
      if (!(binlik === '.' ? BINLIK_NOKTA_RE : BINLIK_VIRGUL_RE).test(parca[0])) return null;
      tam = parca[0].split(binlik).join('');
      kesir = parca[1];
    } else if (noktaVar || virgulVar) {
      const ayrac = virgulVar ? ',' : '.';
      if ((ayrac === '.' ? BINLIK_NOKTA_RE : BINLIK_VIRGUL_RE).test(govde)) {
        tam = govde.split(ayrac).join('');
      } else {
        const parca = govde.split(ayrac);
        if (parca.length !== 2) return null;
        tam = parca[0];
        kesir = parca[1];
      }
    }
    return isaret + (tam === '' ? '0' : tam) + (kesir !== '' ? '.' + kesir : '');
  }

  /**
   * Yerel ayara duyarlı sayı çözümleme (kurallar: normalizeLocaleNumberString).
   * @returns {number} Sayı değilse NaN
   */
  function parseLocaleNumber(val) {
    const s = normalizeLocaleNumberString(val);
    return s === null ? NaN : Number(s);
  }

  function ikiHane(n) {
    return String(n).padStart(2, '0');
  }

  /**
   * Tarih çözümleme: ISO (yyyy-mm-dd[Thh:mm...]), yyyy/mm/dd, dd.mm.yyyy,
   * dd/mm/yyyy ve dd-mm-yyyy (isteğe bağlı saatle). new Date(metin) kullanılmaz:
   * "05.01.2024"ü ay-gün sırasıyla 1 Mayıs okuyup toISOString ile saat dilimi
   * kaydırarak 2024-04-30 üretiyordu. İmkânsız tarihler (31.02) null döner.
   *
   * @returns {{ year: number, month: number, day: number, iso: string }|null}
   */
  function parseLocaleDate(val) {
    let y, mo, d, m;
    if (val instanceof Date) {
      if (isNaN(val.getTime())) return null;
      y = val.getFullYear(); mo = val.getMonth() + 1; d = val.getDate();
    } else {
      if (val === null || val === undefined || typeof val === 'number' || typeof val === 'boolean') return null;
      const s = String(val).trim();
      if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s))) {
        y = +m[1]; mo = +m[2]; d = +m[3];
      } else if ((m = /^(\d{4})([./])(\d{1,2})\2(\d{1,2})$/.exec(s))) {
        y = +m[1]; mo = +m[3]; d = +m[4];
      } else if ((m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s))) {
        d = +m[1]; mo = +m[3]; y = +m[4];
      } else {
        return null;
      }
    }
    if (mo < 1 || mo > 12 || d < 1) return null;
    if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
    return { year: y, month: mo, day: d, iso: `${String(y).padStart(4, '0')}-${ikiHane(mo)}-${ikiHane(d)}` };
  }

  function sayiVeyaSifir(val) {
    const n = parseLocaleNumber(val);
    return isNaN(n) ? 0 : n;
  }

  /**
   * Kullanıcı düzenli ifadesini adım başına BİR kez derler. Eskiden her satırda
   * yeniden derleniyordu; geçersiz ifade ise sessizce yutuluyor, filtre tüm
   * satırları tutuyor ve kullanıcı adımın çalıştığını sanıyordu.
   */
  function duzenliIfadeDerle(pattern, flags, baglam) {
    try {
      return new RegExp(pattern, flags);
    } catch (e) {
      throw new Error(`Geçersiz düzenli ifade (${baglam}): /${pattern}/ — ${e.message}`);
    }
  }

  /**
   * Metin normalizasyonu (Türkçe karakter ve harf büyüklüğü)
   */
  function normalizeCase(str, caseType, turkishAscii) {
    if (str === null || str === undefined) return '';
    let val = String(str);
    if (turkishAscii) {
      val = val
        .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
        .replace(/ü/g, 'u').replace(/Ü/g, 'U')
        .replace(/ş/g, 's').replace(/Ş/g, 'S')
        .replace(/ı/g, 'i').replace(/İ/g, 'I')
        .replace(/ö/g, 'o').replace(/Ö/g, 'O')
        .replace(/ç/g, 'c').replace(/Ç/g, 'C');
    }
    switch (caseType) {
      case 'lower':
        return turkishAscii ? val.toLowerCase() : val.toLocaleLowerCase('tr-TR');
      case 'upper':
        return val.toUpperCase();
      case 'snake_case': {
        let s = val.trim()
          .replace(/[^\w\sğüşıöçĞÜŞİÖÇ_]/g, '')
          .replace(/[\s_]+/g, '_')
          .replace(/^_+|_+$/g, '');
        if (turkishAscii) {
          s = s
            .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
            .replace(/ü/g, 'u').replace(/Ü/g, 'U')
            .replace(/ş/g, 's').replace(/Ş/g, 'S')
            .replace(/ı/g, 'i').replace(/İ/g, 'I')
            .replace(/ö/g, 'o').replace(/Ö/g, 'O')
            .replace(/ç/g, 'c').replace(/Ç/g, 'C');
          return s.toLowerCase();
        }
        return s.toLocaleLowerCase('tr-TR');
      }
      case 'camelCase': {
        let s = val.trim().replace(/[-_\s]+(.)?/g, (_, c) => (c ? (turkishAscii ? c.toUpperCase() : c.toLocaleUpperCase('tr-TR')) : ''));
        return s.replace(/^(.)/, m => (turkishAscii ? m.toLowerCase() : m.toLocaleLowerCase('tr-TR')));
      }
      case 'turkish_ascii':
        return val
          .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
          .replace(/ü/g, 'u').replace(/Ü/g, 'U')
          .replace(/ş/g, 's').replace(/Ş/g, 'S')
          .replace(/ı/g, 'i').replace(/İ/g, 'I')
          .replace(/ö/g, 'o').replace(/Ö/g, 'O')
          .replace(/ç/g, 'c').replace(/Ç/g, 'C');
      default:
        return val;
    }
  }

  /* Tekilleştirme anahtarı: kırpılmış, Türkçe kurallarla küçük harf.
     toLocaleLowerCase('tr-TR') pahalıdır; ASCII metinde yalnız 'I' (→ 'ı')
     farklı davranır, bu yüzden diğer ASCII metinler hızlı yoldan geçer.
     Sonuç her zaman toLocaleLowerCase('tr-TR') ile aynıdır. */
  const ASCII_DISI_RE = /[^\x00-\x7F]/;
  const BUYUK_ASCII_RE = /[A-Z]/;
  function tekilAnahtarParcasi(v) {
    const s = String(v !== null && v !== undefined ? v : '').trim();
    if (ASCII_DISI_RE.test(s) || s.indexOf('I') !== -1) return s.toLocaleLowerCase('tr-TR');
    return BUYUK_ASCII_RE.test(s) ? s.toLowerCase() : s;
  }

  /**
   * Güvenli klonlama
   */
  function cloneTable(headers, rows) {
    const newHeaders = headers ? headers.slice() : [];
    const newRows = rows ? rows.map(r => (Array.isArray(r) ? r.slice() : [])) : [];
    return { headers: newHeaders, rows: newRows };
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
      // Harf büyüklüğü duyarsız eşleşme
      const lower = col.trim().toLocaleLowerCase('tr-TR');
      return headers.findIndex(h => String(h).trim().toLocaleLowerCase('tr-TR') === lower);
    }
    return -1;
  }

  /**
   * Tek bir işlem adımını çalıştırır
   * 
   * @param {string[]} headers 
   * @param {Array<Array<any>>} rows 
   * @param {Object} step 
   * @returns {{ headers: string[], rows: Array<Array<any>>, stats: Object }}
   */
  function applyStep(headers, rows, step) {
    if (!step || !step.type) {
      throw new Error('İşlem adımı "type" alanı içermelidir.');
    }

    const initialRowCount = rows.length;
    const initialColCount = headers.length;
    let outHeaders = headers.slice();
    // Sığ kopya: hücre değiştiren her adım satırı kendisi kopyalar (kopyala-yaz).
    // Eskiden her adım bütün tabloyu baştan kopyalıyordu; 5 milyon satırda
    // adım başına ~500 MB ek bellek demekti.
    let outRows = rows.slice();
    const startTime = Date.now();

    switch (step.type) {
      case 'normalize_headers': {
        const caseType = step.case || 'snake_case';
        const trim = step.trim !== false;
        const turkishAscii = !!step.turkish_ascii;

        outHeaders = outHeaders.map((h, idx) => {
          let name = String(h !== null && h !== undefined ? h : `kolon_${idx + 1}`);
          if (trim) name = name.trim();
          name = normalizeCase(name, caseType, turkishAscii);
          return name;
        });
        break;
      }

      case 'rename_columns': {
        const mapping = step.mapping || {}; // { "Eski_Ad": "Yeni_Ad" }
        outHeaders = outHeaders.map(h => {
          // mapping.hasOwnProperty, JSON tarifinde "hasOwnProperty" adlı bir sütun
          // eşlemesi varsa ya da prototipsiz nesnede TypeError verirdi.
          if (Object.prototype.hasOwnProperty.call(mapping, h)) return String(mapping[h]);
          const lower = String(h).trim().toLocaleLowerCase('tr-TR');
          for (const k of Object.keys(mapping)) {
            if (k.trim().toLocaleLowerCase('tr-TR') === lower) {
              return String(mapping[k]);
            }
          }
          return h;
        });
        break;
      }

      case 'drop_columns': {
        const dropCols = Array.isArray(step.columns) ? step.columns : [step.columns];
        const dropIndices = new Set(
          dropCols.map(c => resolveColIndex(c, outHeaders)).filter(i => i >= 0)
        );

        outHeaders = outHeaders.filter((_, idx) => !dropIndices.has(idx));
        outRows = outRows.map(r => r.filter((_, idx) => !dropIndices.has(idx)));
        break;
      }

      case 'keep_columns': {
        const keepCols = Array.isArray(step.columns) ? step.columns : [step.columns];
        const keepIndices = keepCols.map(c => resolveColIndex(c, outHeaders)).filter(i => i >= 0);

        outHeaders = keepIndices.map(i => outHeaders[i]);
        outRows = outRows.map(r => keepIndices.map(i => r[i]));
        break;
      }

      case 'filter_rows': {
        const colIdx = resolveColIndex(step.column, outHeaders);
        if (colIdx < 0) break;

        const op = step.operator || 'not_empty';
        const targetVal = step.value;
        const isCaseSensitive = !!step.caseSensitive;
        const targetStr = String(targetVal !== null && targetVal !== undefined ? targetVal : '').trim();
        const targetNum = parseLocaleNumber(targetVal);
        const filtreRegex = op === 'regex'
          ? duzenliIfadeDerle(targetStr, isCaseSensitive ? '' : 'i', `filter_rows / "${step.column}"`)
          : null;

        outRows = outRows.filter(r => {
          const raw = r[colIdx];
          const valStr = String(raw !== null && raw !== undefined ? raw : '').trim();

          switch (op) {
            case 'empty':
              return valStr === '' || raw === null || raw === undefined;
            case 'not_empty':
              return valStr !== '' && raw !== null && raw !== undefined;
            case 'equals':
              return isCaseSensitive
                ? valStr === targetStr
                : valStr.toLocaleLowerCase('tr-TR') === targetStr.toLocaleLowerCase('tr-TR');
            case 'not_equals':
              return isCaseSensitive
                ? valStr !== targetStr
                : valStr.toLocaleLowerCase('tr-TR') !== targetStr.toLocaleLowerCase('tr-TR');
            case 'contains':
              return isCaseSensitive
                ? valStr.includes(targetStr)
                : valStr.toLocaleLowerCase('tr-TR').includes(targetStr.toLocaleLowerCase('tr-TR'));
            case 'not_contains':
              return isCaseSensitive
                ? !valStr.includes(targetStr)
                : !valStr.toLocaleLowerCase('tr-TR').includes(targetStr.toLocaleLowerCase('tr-TR'));
            // parseFloat("1.250,50") 1.25 verirdi; karşılaştırma yerel ayarlı çözümleyiciyle.
            case 'gt':
              return parseLocaleNumber(raw) > targetNum;
            case 'gte':
              return parseLocaleNumber(raw) >= targetNum;
            case 'lt':
              return parseLocaleNumber(raw) < targetNum;
            case 'lte':
              return parseLocaleNumber(raw) <= targetNum;
            case 'regex':
              return filtreRegex.test(valStr);
            case 'in_list': {
              const list = Array.isArray(targetVal) ? targetVal : targetStr.split(',').map(s => s.trim());
              return list.some(item =>
                isCaseSensitive
                  ? String(item) === valStr
                  : String(item).toLocaleLowerCase('tr-TR') === valStr.toLocaleLowerCase('tr-TR')
              );
            }
            default:
              return true;
          }
        });
        break;
      }

      case 'deduplicate': {
        const colList = Array.isArray(step.columns) ? step.columns : (step.columns ? [step.columns] : []);
        const colIndices = colList.length > 0
          ? colList.map(c => resolveColIndex(c, outHeaders)).filter(i => i >= 0)
          : outHeaders.map((_, i) => i);

        const keep = step.keep || 'first'; // 'first' | 'last' | 'none'
        const tekKolon = colIndices.length === 1 ? colIndices[0] : -1;
        const anahtar = r => {
          if (tekKolon >= 0) return tekilAnahtarParcasi(r[tekKolon]);
          let k = '';
          for (let j = 0; j < colIndices.length; j++) k += (j ? '|||' : '') + tekilAnahtarParcasi(r[colIndices[j]]);
          return k;
        };

        // Tek geçiş, orijinal satır sırası korunur (eskiden satır başına nesne
        // üretilip sonda bütün tablo yeniden sıralanıyordu).
        if (keep === 'first') {
          const gorulen = new Set();
          outRows = outRows.filter(r => {
            const k = anahtar(r);
            if (gorulen.has(k)) return false;
            gorulen.add(k);
            return true;
          });
        } else if (keep === 'last' || keep === 'none') {
          const anahtarlar = new Array(outRows.length);
          const sayac = new Map();   // anahtar → { sayi, son }
          for (let i = 0; i < outRows.length; i++) {
            const k = anahtarlar[i] = anahtar(outRows[i]);
            const g = sayac.get(k);
            if (g) { g.sayi++; g.son = i; } else sayac.set(k, { sayi: 1, son: i });
          }
          outRows = outRows.filter((r, i) => {
            const g = sayac.get(anahtarlar[i]);
            return keep === 'last' ? g.son === i : g.sayi === 1;
          });
        } else {
          outRows = [];
        }
        break;
      }

      case 'clean_text': {
        const colList = Array.isArray(step.columns) ? step.columns : [step.columns];
        const colIndices = colList.map(c => resolveColIndex(c, outHeaders)).filter(i => i >= 0);
        const ops = Array.isArray(step.operations) ? step.operations : [step.operation || 'trim'];
        const degistirRegex = (ops.indexOf('regex_replace') !== -1 && step.pattern)
          ? duzenliIfadeDerle(step.pattern, step.regexFlags || 'g', 'clean_text / regex_replace')
          : null;

        outRows = outRows.map(r => {
          const rowCopy = r.slice();
          colIndices.forEach(ci => {
            let val = rowCopy[ci];
            if (val === null || val === undefined) return;
            let str = String(val);

            ops.forEach(opName => {
              switch (opName) {
                case 'trim':
                  str = str.trim();
                  break;
                case 'collapse_spaces':
                  str = str.replace(/[ \t\xA0]+/g, ' ').trim();
                  break;
                case 'uppercase':
                  str = str.toLocaleUpperCase('tr-TR');
                  break;
                case 'lowercase':
                  str = str.toLocaleLowerCase('tr-TR');
                  break;
                case 'titlecase':
                  // \b\w yalnız ASCII harf tanır: "ömer şahin" → "öMer şAhin" oluyordu.
                  // Kesme işareti sınır sayılmaz: "istanbul'da" → "İstanbul'da".
                  str = str.toLocaleLowerCase('tr-TR')
                    .replace(/(^|[\s\-/(])(\p{L})/gu, (_, once, harf) => once + harf.toLocaleUpperCase('tr-TR'));
                  break;
                case 'remove_numbers':
                  str = str.replace(/\d+/g, '');
                  break;
                case 'keep_numbers_only':
                  str = str.replace(/\D+/g, '');
                  break;
                case 'regex_replace':
                  if (degistirRegex) {
                    str = str.replace(degistirRegex, step.replacement || '');
                  }
                  break;
              }
            });
            rowCopy[ci] = str;
          });
          return rowCopy;
        });
        break;
      }

      case 'type_cast': {
        const colIdx = resolveColIndex(step.column, outHeaders);
        const targetType = step.targetType || 'string';
        if (colIdx >= 0) {
          outRows = outRows.map(r => {
            const rowCopy = r.slice();
            const val = rowCopy[colIdx];
            if (val === null || val === undefined || String(val).trim() === '') {
              rowCopy[colIdx] = step.defaultValue !== undefined ? step.defaultValue : null;
              return rowCopy;
            }

            switch (targetType) {
              case 'integer': {
                // Eskiden rakam dışı her şey silinip parseInt ediliyordu: "12.5" → 125.
                // Artık ortak çözümleyiciyle okunup sıfıra doğru kırpılır (12.5 → 12).
                const parsed = parseLocaleNumber(val);
                rowCopy[colIdx] = isNaN(parsed) ? (step.defaultValue !== undefined ? step.defaultValue : null) : (Math.trunc(parsed) || 0);
                break;
              }
              case 'number': {
                // Eskiden "1,234.56" → 1.23456 oluyordu (virgül her durumda ondalık sayılıyordu).
                const parsed = parseLocaleNumber(val);
                rowCopy[colIdx] = isNaN(parsed) ? (step.defaultValue !== undefined ? step.defaultValue : null) : parsed;
                break;
              }
              case 'boolean': {
                // tr-TR küçültme: "AKTİF".toLowerCase() noktalı i üretip eşleşmiyordu.
                const s = String(val).trim().toLocaleLowerCase('tr-TR');
                rowCopy[colIdx] = (s === '1' || s === 'true' || s === 'evet' || s === 'yes' || s === 'aktif');
                break;
              }
              case 'string':
                rowCopy[colIdx] = String(val);
                break;
              case 'date': {
                // Çözümlenemeyen veya imkânsız tarih (31.02) değiştirilmeden bırakılır.
                const tarih = parseLocaleDate(val);
                rowCopy[colIdx] = tarih ? tarih.iso : String(val);
                break;
              }
            }
            return rowCopy;
          });
        }
        break;
      }

      case 'fill_missing': {
        const colIdx = resolveColIndex(step.column, outHeaders);
        const method = step.method || 'fill_down'; // 'fill_down' | 'fill_up' | 'fill_value'
        const fillValue = step.value !== undefined ? step.value : '';

        if (colIdx >= 0) {
          if (method === 'fill_value') {
            outRows = outRows.map(r => {
              const rowCopy = r.slice();
              if (rowCopy[colIdx] === null || rowCopy[colIdx] === undefined || String(rowCopy[colIdx]).trim() === '') {
                rowCopy[colIdx] = fillValue;
              }
              return rowCopy;
            });
          } else if (method === 'fill_down') {
            let lastVal = fillValue;
            outRows = outRows.map(r => {
              const rowCopy = r.slice();
              const curr = rowCopy[colIdx];
              if (curr !== null && curr !== undefined && String(curr).trim() !== '') {
                lastVal = curr;
              } else {
                rowCopy[colIdx] = lastVal;
              }
              return rowCopy;
            });
          } else if (method === 'fill_up') {
            let nextVal = fillValue;
            for (let i = outRows.length - 1; i >= 0; i--) {
              const curr = outRows[i][colIdx];
              if (curr !== null && curr !== undefined && String(curr).trim() !== '') {
                nextVal = curr;
              } else {
                outRows[i] = outRows[i].slice();
                outRows[i][colIdx] = nextVal;
              }
            }
          }
        }
        break;
      }

      case 'add_calculated_column': {
        const newCol = step.newColumnName || `Yeni_Kolon_${outHeaders.length + 1}`;
        const expr = step.expression || 'concat';
        const srcCols = (Array.isArray(step.columns) ? step.columns : []).map(c => resolveColIndex(c, outHeaders));

        outHeaders.push(newCol);
        outRows = outRows.map(r => {
          const rowCopy = r.slice();
          let calculatedVal = '';

          switch (expr) {
            case 'concat': {
              const separator = step.separator !== undefined ? step.separator : ' ';
              calculatedVal = srcCols
                .filter(ci => ci >= 0)
                .map(ci => (r[ci] !== null && r[ci] !== undefined ? String(r[ci]) : ''))
                .join(separator);
              break;
            }
            case 'math_add': {
              const sum = srcCols.filter(ci => ci >= 0).reduce((acc, ci) => acc + sayiVeyaSifir(r[ci]), 0);
              calculatedVal = sum;
              break;
            }
            case 'math_sub': {
              if (srcCols.length >= 2 && srcCols[0] >= 0 && srcCols[1] >= 0) {
                calculatedVal = sayiVeyaSifir(r[srcCols[0]]) - sayiVeyaSifir(r[srcCols[1]]);
              }
              break;
            }
            case 'math_mul': {
              if (srcCols.length >= 2 && srcCols[0] >= 0 && srcCols[1] >= 0) {
                calculatedVal = sayiVeyaSifir(r[srcCols[0]]) * sayiVeyaSifir(r[srcCols[1]]);
              }
              break;
            }
            case 'constant':
              calculatedVal = step.value !== undefined ? step.value : '';
              break;
            default:
              calculatedVal = '';
          }

          rowCopy.push(calculatedVal);
          return rowCopy;
        });
        break;
      }

      case 'mask_column': {
        const colIdx = resolveColIndex(step.column, outHeaders);
        const mode = step.mode || 'asterisk'; // 'asterisk' | 'token' | 'sha256' | 'generalize_date' | 'empty'
        const hmacAnahtari = mode === 'sha256' ? tarifAnahtari(step.salt) : null;

        if (colIdx >= 0) {
          const tokenMap = new Map();
          let counter = 1;

          outRows = outRows.map(r => {
            const rowCopy = r.slice();
            const val = rowCopy[colIdx];
            if (val === null || val === undefined || String(val).trim() === '') {
              return rowCopy;
            }
            const s = String(val).trim();

            if (mode === 'empty') {
              rowCopy[colIdx] = '';
            } else if (mode === 'asterisk') {
              if (s.length <= 2) {
                rowCopy[colIdx] = '*'.repeat(s.length);
              } else {
                rowCopy[colIdx] = s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
              }
            } else if (mode === 'token') {
              if (!tokenMap.has(s)) {
                tokenMap.set(s, `TOKEN_${String(counter++).padStart(5, '0')}`);
              }
              rowCopy[colIdx] = tokenMap.get(s);
            } else if (mode === 'sha256') {
              // HMAC-SHA-256, 64 bit çıktı. Eskiden adı sha256 olan 32 bitlik bir
              // FNV karması ve herkesçe bilinen varsayılan tuz kullanılıyordu.
              rowCopy[colIdx] = 'HASH_' + fileMask().hmacSha256Hex(hmacAnahtari, s).slice(0, 16).toUpperCase();
            } else if (mode === 'generalize_date') {
              const m = s.match(/(\d{4})/);
              rowCopy[colIdx] = m ? `${m[1]}-**-**` : s;
            }
            return rowCopy;
          });
        }
        break;
      }

      default:
        throw new Error(`Desteklenmeyen işlem adımı tipi: "${step.type}"`);
    }

    const durationMs = Date.now() - startTime;
    const stats = {
      stepType: step.type,
      inputRows: initialRowCount,
      outputRows: outRows.length,
      deltaRows: outRows.length - initialRowCount,
      inputCols: initialColCount,
      outputCols: outHeaders.length,
      durationMs: durationMs
    };

    return { headers: outHeaders, rows: outRows, stats: stats };
  }

  /**
   * Tüm reçeteyi sırayla çalıştırır
   * 
   * @param {string[]} headers 
   * @param {Array<Array<any>>} rows 
   * @param {Object} recipe 
   * @param {Array<Object>} recipe.steps 
   * @returns {{ headers: string[], rows: Array<Array<any>>, stepStats: Array<Object>, totalDurationMs: number }}
   */
  function executeRecipe(headers, rows, recipe) {
    if (!recipe || !Array.isArray(recipe.steps)) {
      throw new Error('Reçete "steps" dizisi içermelidir.');
    }

    const t0 = Date.now();
    let currentHeaders = headers ? headers.slice() : [];
    let currentRows = rows ? rows.slice() : [];
    const stepStats = [];

    recipe.steps.forEach((step, idx) => {
      const res = applyStep(currentHeaders, currentRows, step);
      currentHeaders = res.headers;
      currentRows = res.rows;
      stepStats.push({
        stepIndex: idx + 1,
        ...res.stats
      });
    });

    return {
      headers: currentHeaders,
      rows: currentRows,
      stepStats: stepStats,
      totalDurationMs: Date.now() - t0
    };
  }

  // Geri alma geçmişi sınırı (ilk yükleme dahil kayıt sayısı). Her kayıt tablonun
  // tam kopyasını tutar; sınırsız geçmişte 100 bin satırlık bir dosyada birkaç
  // düzine adım yüzlerce MB bellek tüketip sekmeyi çökertiyordu.
  const GECMIS_SINIRI = 50;

  /**
   * Doğrusal İş Akışı Hattı (Pipeline / History State Controller)
   * Undo/Redo destekli etkileşimli denetleyici
   *
   * Geçmiş sınırı aşılınca ilk yükleme (index 0) hep korunur; en eski ARA adımın
   * satır kopyası atılır, adı/yapılandırması/istatistiği eskiAdimlar'a taşınır.
   * Böylece tarif ve icra manifestosu yine ilk yüklemeden itibaren eksiksiz kalır;
   * yalnızca atılan adımlara tek tek geri alma yapılamaz (ilk yüklemeye atlanabilir).
   *
   * @param {Object} [options]
   * @param {number} [options.maxHistory=50] - İlk yükleme dahil tutulacak en fazla kayıt
   */
  function createPipeline(initialHeaders, initialRows, options) {
    const sinir = Math.max(2, Math.floor((options && options.maxHistory) || GECMIS_SINIRI));
    let eskiAdimlar = [];
    let history = [
      {
        stepName: 'İlk Yükleme',
        stepConfig: null,
        headers: initialHeaders ? initialHeaders.slice() : [],
        rows: initialRows ? initialRows.slice() : [],
        stats: { inputRows: initialRows ? initialRows.length : 0, outputRows: initialRows ? initialRows.length : 0 }
      }
    ];
    let currentIndex = 0;

    // index 1'den 0'a inmek, atılmış adımlar varken birden çok adımı sessizce
    // geri almak olurdu; tek adımlık geri alma orada durur.
    function geriAlinabilir() {
      return currentIndex > 1 || (currentIndex === 1 && eskiAdimlar.length === 0);
    }

    // İlk yüklemeden aktif adıma kadar uygulanmış adımlar (atılanlar dahil).
    function aktifAdimlar() {
      return currentIndex === 0 ? [] : eskiAdimlar.concat(history.slice(1, currentIndex + 1));
    }

    return {
      /**
       * Yeni bir adım ekler ve çalıştırır (Redo geçmişini sıfırlar)
       */
      addStep: function (stepConfig, customName) {
        const current = history[currentIndex];
        const res = applyStep(current.headers, current.rows, stepConfig);

        // İlerideki adımları kırp (yeni dal). Dal ilk yüklemeden ayrılıyorsa
        // atılmış eski adımlar da artık bu dalın parçası değildir.
        history = history.slice(0, currentIndex + 1);
        if (currentIndex === 0) eskiAdimlar = [];

        const entry = {
          stepName: customName || stepConfig.name || stepConfig.type,
          stepConfig: JSON.parse(JSON.stringify(stepConfig)),
          headers: res.headers,
          rows: res.rows,
          stats: res.stats
        };

        history.push(entry);
        while (history.length > sinir) {
          const atilan = history.splice(1, 1)[0];
          eskiAdimlar.push({ stepName: atilan.stepName, stepConfig: atilan.stepConfig, stats: atilan.stats });
        }
        currentIndex = history.length - 1;

        return {
          entry: entry,
          canUndo: geriAlinabilir(),
          canRedo: false
        };
      },

      /**
       * Bir adım geri alır
       */
      undo: function () {
        if (geriAlinabilir()) {
          currentIndex--;
          return {
            success: true,
            current: history[currentIndex],
            canUndo: geriAlinabilir(),
            canRedo: currentIndex < history.length - 1
          };
        }
        if (currentIndex === 1) {
          return {
            success: false,
            message: `Geçmiş sınırı (${sinir} kayıt): daha eski ${eskiAdimlar.length} adımın ara kopyası bellekten atıldı. İlk yüklemeye dönmek için adım listesinden "İlk Yükleme"yi seçin.`
          };
        }
        return { success: false, message: 'Geri alınacak adım yok.' };
      },

      /**
       * Bir adım ileri alır
       */
      redo: function () {
        if (currentIndex < history.length - 1) {
          currentIndex++;
          return {
            success: true,
            current: history[currentIndex],
            canUndo: geriAlinabilir(),
            canRedo: currentIndex < history.length - 1
          };
        }
        return { success: false, message: 'İleri alınacak adım yok.' };
      },

      /**
       * Belirli bir geçmiş indeksine atlar
       */
      jumpToStep: function (index) {
        if (index >= 0 && index < history.length) {
          currentIndex = index;
          return {
            success: true,
            current: history[currentIndex],
            canUndo: geriAlinabilir(),
            canRedo: currentIndex < history.length - 1
          };
        }
        return { success: false, message: 'Geçersiz adım indeksi.' };
      },

      /**
       * Aktif durumu döndürür
       */
      getCurrentState: function () {
        return history[currentIndex];
      },

      /**
       * Tüm adımların özet geçmişini döndürür
       */
      getHistory: function () {
        return history.map((h, idx) => ({
          index: idx,
          isActive: idx === currentIndex,
          stepName: h.stepName,
          stats: h.stats
        }));
      },

      /**
       * Geçmiş sınırı nedeniyle ara kopyası atılmış (tek tek geri alınamayan) adım sayısı
       */
      getCollapsedStepCount: function () {
        return eskiAdimlar.length;
      },

      /**
       * Aktif adımlardan verisiz Reçete JSON'ı üretir
       */
      exportRecipe: function (recipeName, description) {
        const steps = aktifAdimlar()
          .map(h => h.stepConfig)
          .filter(Boolean)
          .map(cfg => {
            // Gizli hash anahtarı tarif dosyasına ve icra manifestosuna girmez.
            if (!Object.prototype.hasOwnProperty.call(cfg, 'salt')) return cfg;
            const kopya = Object.assign({}, cfg);
            delete kopya.salt;
            return kopya;
          });

        return {
          schemaVersion: 'masko-recipe-v1',
          recipeName: recipeName || 'Masko Özel Tarif',
          description: description || 'Masko Yerel Veri Tezgâhı tarafından oluşturulmuştur.',
          createdAt: new Date().toISOString(),
          stepsCount: steps.length,
          steps: steps
        };
      },

      /**
       * Mevcut işlem oturumu için doğrulanabilir, Sıfır-PII İcra Manifestosu (Run Manifest) üretir
       */
      exportRunManifest: function (options) {
        options = options || {};
        const recipe = this.exportRecipe(options.recipeName, options.description);
        const initial = history[0];
        const current = history[currentIndex];

        const stepStats = aktifAdimlar().map((h, i) => ({
          stepIndex: i + 1,
          type: h.stepConfig ? h.stepConfig.type : 'step',
          name: h.stepName,
          inputRows: h.stats ? h.stats.inputRows : 0,
          outputRows: h.stats ? h.stats.outputRows : 0,
          ...(h.stats || {})
        }));

        return generateRunManifest(
          recipe,
          {
            headers: current.headers,
            rows: current.rows,
            stepStats: stepStats,
            totalDurationMs: 0
          },
          {
            ...options,
            inputHeaders: initial.headers,
            inputRows: initial.rows
          }
        );
      }
    };
  }

  /**
   * Veri seti yapısal parmak izi (Fingerprint) üretir.
   * Ham PII sızdırmadan veri bütünlüğünü ve şeklini doğrular.
   */
  function computeFingerprint(headers, rows) {
    const h = headers || [];
    const r = rows || [];
    let str = `H:${h.join(',')}|R:${r.length}|C:${h.length}`;
    if (r.length > 0) {
      const sampleIndices = [0, Math.floor(r.length / 2), r.length - 1];
      const samplePatterns = sampleIndices.map(idx => {
        const row = r[idx] || [];
        return row.map(cell => (cell !== null && cell !== undefined ? String(cell).length : 0)).join('-');
      });
      str += `|S:${samplePatterns.join('#')}`;
    }

    let hash1 = 0x811c9dc5;
    let hash2 = 0x27d4eb2f;
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      hash1 ^= code;
      hash1 = Math.imul(hash1, 0x01000193);
      hash2 ^= code;
      hash2 = Math.imul(hash2, 0x5bd1e995);
    }
    const hex1 = (hash1 >>> 0).toString(16).padStart(8, '0');
    const hex2 = (hash2 >>> 0).toString(16).padStart(8, '0');
    return `FP-${hex1}${hex2}`;
  }

  /**
   * İcra Manifestosu (Run Manifest) Üretici
   * 
   * "Recipe ≠ Run" ilkesi:
   * Recipe: Değişmeyen kural şablonudur (.masko.json)
   * Run: Belirli bir zamanda, belirli bir girdi dosyasıyla çalıştırılmış doğrulanabilir icra kaydıdır (.run.json).
   * 
   * @param {Object} recipe - Uygulanan reçete
   * @param {Object} executionResult - executeRecipe veya pipeline çıktısı { headers, rows, stepStats, totalDurationMs }
   * @param {Object} [options]
   * @returns {Object} Masko Run Manifest (Sıfır PII içerir)
   */
  function generateRunManifest(recipe, executionResult, options) {
    options = options || {};
    const now = new Date();
    const runId = options.runId || `RUN-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    const inHeaders = options.inputHeaders || [];
    const inRows = options.inputRows || [];
    const outHeaders = executionResult ? (executionResult.headers || []) : [];
    const outRows = executionResult ? (executionResult.rows || []) : [];
    const stepStats = executionResult ? (executionResult.stepStats || []) : [];

    const recipeSteps = recipe && Array.isArray(recipe.steps) ? recipe.steps : [];
    const operations = stepStats.map((st, idx) => {
      const stepCfg = recipeSteps[idx] || {};
      const delta = (st.outputRows || 0) - (st.inputRows || 0);
      return {
        order: idx + 1,
        type: stepCfg.type || st.type || 'unknown_step',
        name: stepCfg.name || st.name || `Adım ${idx + 1}`,
        inputRows: st.inputRows !== undefined ? st.inputRows : (idx === 0 ? inRows.length : 0),
        outputRows: st.outputRows !== undefined ? st.outputRows : outRows.length,
        deltaRows: delta,
        summary: st.description || (delta !== 0 ? `${Math.abs(delta)} satır ${delta < 0 ? 'silindi/filtrelendi' : 'eklendi'}` : 'Satır sayısı korundu')
      };
    });

    return {
      schemaVersion: 'masko-run-manifest-v1',
      runId: runId,
      timestamp: now.toISOString(),
      status: 'SUCCESS',
      recipe: {
        name: recipe ? (recipe.recipeName || 'Adsız Reçete') : 'Dinamik Pipeline',
        schemaVersion: recipe ? (recipe.schemaVersion || 'masko-recipe-v1') : 'masko-recipe-v1',
        totalSteps: recipeSteps.length,
        stepTypes: recipeSteps.map(s => s.type)
      },
      environment: {
        engine: 'Masko Local-First Data Operations Workbench',
        version: '2.1.0',
        mode: 'Strict Offline (Zero-Network, Local Execution)',
        complianceGuarantees: [
          'KVKK Madde 12: Yerel işleme ve sıfır veri sızıntısı',
          'GDPR Article 25 & 32: Privacy-by-Design ve Data Minimisation'
        ]
      },
      input: {
        name: options.inputName || 'kaynak_veri',
        rowCount: inRows.length,
        columnCount: inHeaders.length,
        fingerprint: computeFingerprint(inHeaders, inRows)
      },
      operations: operations,
      output: {
        name: options.outputName || 'islenmis_veri',
        rowCount: outRows.length,
        columnCount: outHeaders.length,
        fingerprint: computeFingerprint(outHeaders, outRows)
      },
      audit: {
        totalDurationMs: executionResult ? (executionResult.totalDurationMs || 0) : 0,
        piiSafe: true, // Asla satır veya kişisel veri içermez
        summary: `İcra Özeti: ${inRows.length} satırlık veri, ${recipeSteps.length} operasyondan geçirilerek ${outRows.length} satıra dönüştürüldü (${executionResult ? (executionResult.totalDurationMs || 0) : 0} ms).`
      }
    };
  }

  /**
   * Toplu İşleme (Batch Runner)
   * Bir reçeteyi birden fazla dosyaya/tabloya sırayla uygular
   * 
   * @param {Array<{ name: string, headers: string[], rows: Array<Array<any>> }>} datasets 
   * @param {Object} recipe 
   * @returns {Array<{ name: string, headers: string[], rows: Array<Array<any>>, stats: Object }>}
   */
  function runBatch(datasets, recipe) {
    if (!Array.isArray(datasets)) {
      throw new Error('datasets bir dizi olmalıdır.');
    }

    return datasets.map(ds => {
      const res = executeRecipe(ds.headers, ds.rows, recipe);
      return {
        name: ds.name || 'adsiz_tablo',
        headers: res.headers,
        rows: res.rows,
        stepStats: res.stepStats,
        totalDurationMs: res.totalDurationMs
      };
    });
  }

  return {
    applyStep: applyStep,
    executeRecipe: executeRecipe,
    createPipeline: createPipeline,
    runBatch: runBatch,
    normalizeCase: normalizeCase,
    computeFingerprint: computeFingerprint,
    generateRunManifest: generateRunManifest,
    parseLocaleNumber: parseLocaleNumber,
    normalizeLocaleNumberString: normalizeLocaleNumberString,
    parseLocaleDate: parseLocaleDate,
    MAX_HISTORY_ENTRIES: GECMIS_SINIRI
  };
}));
