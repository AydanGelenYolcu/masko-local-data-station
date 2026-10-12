/**
 * workbench/sql-engine.js
 *
 * Local-First Data & Office Workbench: Local In-Browser SQL Studio & Query Builder (WB-05)
 *
 * Çoklu dosya (CSV, XLSX) verilerini bellek içi tablolara dönüştürür;
 * sunucuya sıfır istek ile tarayıcıda SQL sorgulama, görsel sorgu oluşturma,
 * hazır analitik şablonlar (Mükerrerler, Anti-join, Özet) ve DDL üretimi sağlar.
 *
 * Tasarım ilkesi: "Ya doğru sonuç ya da açık Türkçe hata."
 * Bilinmeyen sütun, desteklenmeyen sözdizimi veya anlamı belirsiz bir karşılaştırma
 * asla sessizce yutulmaz. Makul görünen ama yanlış bir sonuç tablosu, hata
 * mesajından çok daha tehlikelidir: kullanıcı yanlış veriyle karar verir ve fark etmez.
 *
 * Desteklenen SQL alt kümesi:
 *   SELECT [DISTINCT] ifade [AS takma_ad], ... | * | tablo.*
 *   FROM tablo [[AS] takma_ad]
 *   [INNER | LEFT [OUTER] | RIGHT [OUTER] | FULL [OUTER] | [LEFT] ANTI] JOIN tablo [[AS] t]
 *       ON a.x = b.y [AND a.z = b.w ...]
 *   WHERE koşul      -- AND / OR / NOT, parantez, =, ==, !=, <>, <, <=, >, >=,
 *                    -- [NOT] IN (...), [NOT] LIKE '...' [ESCAPE 'c'],
 *                    -- [NOT] BETWEEN a AND b, IS [NOT] NULL
 *   GROUP BY sütun | takma_ad | sıra_no, ...
 *   HAVING koşul     -- COUNT/SUM/AVG/MIN/MAX veya SELECT takma adları ile
 *   ORDER BY ifade | takma_ad | sıra_no [ASC | DESC], ...
 *   LIMIT n [OFFSET m]
 * Toplama fonksiyonları: COUNT(*), COUNT(x), COUNT(DISTINCT x), SUM, AVG, MIN, MAX
 * Tanımlayıcılar: çıplak (Unicode harf/rakam/_), "çift tırnak", `ters tırnak`, [köşeli]
 * Metin sabitleri: 'tek tırnak' ('' ile kaçış)
 *
 * %100 İstemci Tarafı, Deterministik, Sıfır Dış Bağımlılık.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SqlEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =====================================================================
  // 1. Değer yardımcıları
  // =====================================================================

  /**
   * Boş hücre: null/undefined, NaN, geçersiz tarih veya yalnızca boşluktan oluşan metin.
   * CSV'de eksik değer boş metin ('') olarak gelir; SQL NULL'u ile aynı muameleyi görür ki
   * IS NULL, JOIN anahtarları ve karşılaştırmalar tek bir kuralı paylaşsın.
   */
  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (typeof v === 'number') return Number.isNaN(v);
    if (v instanceof Date) return Number.isNaN(v.getTime());
    return false;
  }

  /**
   * Karşılaştırma için metne çevirme. Date nesneleri ISO biçimine çevrilir; aksi hâlde
   * String(date) "Mon Jan 01 2024 ..." üretir ve tarih sıralaması sessizce bozulur.
   */
  function toText(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
    return String(v);
  }

  /**
   * Büyük/küçük harf duyarsız karşılaştırma anahtarı (veri değerleri için).
   * 'İ'.toLowerCase() iki kod birimi ('i' + U+0307) üretir; bu hem 'İstanbul' = 'istanbul'
   * eşleşmesini bozar hem de LIKE '_' karakter sayımını kaydırır, bu yüzden önce 'i' yapılır.
   * NFC: Excel/macOS kaynaklı ayrışık (decomposed) 'ş' ile birleşik 'ş' aynı sayılsın.
   */
  const FOLD_CACHE_MAX = 10000;
  const foldCache = new Map();
  function foldCase(s) {
    // Hızlı yol: saf ASCII metinde normalize/İ dönüşümü gereksiz (200k satırda belirgin fark).
    let ascii = true;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 127) { ascii = false; break; }
    }
    if (ascii) return s.toLowerCase();
    // Türkçe kategorik sütunlarda ('İstanbul', 'Şube') aynı değer binlerce kez tekrarlanır;
    // normalize() pahalı olduğundan saf fonksiyonun sonucu sınırlı bir önbellekte tutulur.
    const cached = foldCache.get(s);
    if (cached !== undefined) return cached;
    let t = s.normalize('NFC');
    if (t.indexOf('İ') >= 0) t = t.split('İ').join('i');
    t = t.toLowerCase();
    if (foldCache.size >= FOLD_CACHE_MAX) foldCache.clear();
    foldCache.set(s, t);
    return t;
  }

  /**
   * Tanımlayıcı (sütun/tablo adı) eşleme anahtarı. Türkçe klavyesiz yazan kullanıcı için
   * 'ı' da 'i' sayılır ('Kayıt' ↔ 'KAYIT' ↔ 'kayit'). Yalnızca ad çözümlemede kullanılır;
   * veri değerlerine uygulanmaz.
   */
  function identKey(s) {
    return foldCase(String(s).trim()).replace(/ı/g, 'i');
  }

  // Katı sayı biçimi: parseFloat('12abc') = 12 ve parseFloat('1.234,56') = 1.234 gibi
  // sessizce yanlış sayılar üretir. Bu desen belirsiz bölünme içermez (doğrusal çalışır).
  const NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  /** Değer sonlu bir sayı olarak tam ayrıştırılabiliyorsa sayıyı, aksi hâlde NaN döndürür. */
  function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === '' || !NUM_RE.test(s)) return NaN;
      const n = Number(s);
      return Number.isFinite(n) ? n : NaN;
    }
    if (typeof v === 'bigint') return Number(v);
    return NaN;
  }

  // Türkçe alfabetik sıralama (Ş < T, Ç < D). ORDER BY, WHERE aralık karşılaştırmaları ve
  // MIN/MAX aynı sıralayıcıyı kullanır ki "ORDER BY x DESC LIMIT 1" ile MAX(x) hep aynı olsun.
  let collator = null;

  /**
   * Yalnızca rakam, boşluk, '-', '.', '/' içeren metinler ('2024-03-15', '12/05/2024').
   * Bu alfabede kod birimi sırası Türkçe ICU harmanlamasıyla birebir aynıdır (300k rastgele
   * çiftle doğrulandı; ':' farklı sıralandığı için bilerek dışarıda). Tarih sütunlarında
   * satır başına pahalı Intl.Collator çağrısını atlamak için kullanılır.
   */
  function isCodeUnitOrdered(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (!((c >= 48 && c <= 57) || c === 32 || c === 45 || c === 46 || c === 47)) return false;
    }
    return true;
  }

  function collate(a, b) {
    if (isCodeUnitOrdered(a) && isCodeUnitOrdered(b)) return a < b ? -1 : (a > b ? 1 : 0);
    if (collator === null) {
      try { collator = new Intl.Collator('tr'); } catch (e) { collator = false; }
    }
    if (collator) return collator.compare(a, b);
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  /**
   * WHERE aralık karşılaştırması (<, >, BETWEEN): iki taraf da sonlu sayıysa sayısal,
   * değilse metinsel. Böylece '2024-03-15' > '2024-01-01' gibi ISO tarihler doğru çalışır
   * (eski parseFloat yaklaşımı her iki tarafı 2024 yapıp boş sonuç döndürüyordu).
   */
  function orderCompare(a, b) {
    const x = toNumber(a);
    const y = toNumber(b);
    if (!Number.isNaN(x) && !Number.isNaN(y)) return x < y ? -1 : (x > y ? 1 : 0);
    return collate(toText(a), toText(b));
  }

  /**
   * Eşitlik (=, !=, IN). Sayısal eşitlik yalnızca kullanıcı tırnaksız bir sayı yazdığında
   * uygulanır (tutar = 1000 → '1000.0' da eşleşir). Tırnaklı değer metin niyetidir:
   * kod = '007' yalnızca '007' ile eşleşir, '7' ile değil (baştaki sıfırlı kimlikler korunur).
   */
  function valuesEqual(a, b, numericIntent) {
    if (numericIntent) {
      const x = toNumber(a);
      const y = toNumber(b);
      return !Number.isNaN(x) && !Number.isNaN(y) && x === y;
    }
    return foldCase(toText(a)) === foldCase(toText(b));
  }

  /** Sıralama anahtarı: boş → null, sayı → number, diğer → metin. */
  function sortKey(v) {
    if (isEmpty(v)) return null;
    const n = toNumber(v);
    return Number.isNaN(n) ? toText(v) : n;
  }

  /** Toplam sıralama: boşlar < sayılar < metinler (SQLite ile uyumlu, deterministik). */
  function cmpSortKeys(a, b) {
    if (a === null) return b === null ? 0 : -1;
    if (b === null) return 1;
    const na = typeof a === 'number';
    const nb = typeof b === 'number';
    if (na && nb) return a < b ? -1 : (a > b ? 1 : 0);
    if (na) return -1;
    if (nb) return 1;
    return collate(a, b);
  }

  /**
   * ORDER BY için bir sütunun sıralama anahtarlarını tip dizilerine çevirir. Metinler bir kez
   * (yalnızca benzersiz değerler) sıralayıcıyla sıralanıp sıra numarasına dönüştürülür; böylece
   * sort() içinde satır başına Intl.Collator çağrısı yapılmaz. Sonuç cmpSortKeys ile birebir
   * aynı sıralamayı verir: tür (boş=0 < sayı=1 < metin=2), sonra değer/sıra numarası.
   */
  function buildSortColumn(keys) {
    const n = keys.length;
    const kind = new Uint8Array(n);
    const val = new Float64Array(n);
    let ranks = null;
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      if (k === null) continue;
      if (typeof k === 'number') {
        kind[i] = 1;
        val[i] = k;
      } else {
        kind[i] = 2;
        if (ranks === null) ranks = new Map();
        ranks.set(k, 0);
      }
    }
    if (ranks !== null) {
      const uniq = Array.from(ranks.keys()).sort(collate);
      let rank = 0;
      for (let r = 0; r < uniq.length; r++) {
        // Sıralayıcıya göre eşit (ör. kanonik eşdeğer) metinler aynı sırayı paylaşır.
        if (r > 0 && collate(uniq[r - 1], uniq[r]) !== 0) rank++;
        ranks.set(uniq[r], rank);
      }
      for (let i = 0; i < n; i++) {
        if (kind[i] === 2) val[i] = ranks.get(keys[i]);
      }
    }
    return { kind: kind, val: val };
  }

  /** GROUP BY / DISTINCT / COUNT(DISTINCT) anahtar parçası: '=' ile aynı harf katlama kuralı. */
  function groupKeyPart(v) {
    return isEmpty(v) ? '' : foldCase(toText(v));
  }

  /**
   * Birleşik anahtar. Uzunluk önekli birleştirme çakışmasızdır; eski '|||' ayırıcısı
   * değerin içinde '|||' geçtiğinde farklı grupları sessizce birleştirebiliyordu.
   */
  function appendKeyPart(key, part) {
    return key + part.length + ':' + part;
  }

  /**
   * JOIN anahtarı. Boş/NULL anahtar HİÇBİR ZAMAN eşleşmez (null döner): eski sürümde iki
   * tablodaki tüm boş anahtarlı satırlar birbiriyle çapraz eşleşip sahte satırlar üretiyordu.
   */
  function joinKey(row, idxs) {
    if (idxs.length === 1) {
      const v = row[idxs[0]];
      return isEmpty(v) ? null : foldCase(toText(v).trim());
    }
    let key = '';
    for (let k = 0; k < idxs.length; k++) {
      const v = row[idxs[k]];
      if (isEmpty(v)) return null;
      key = appendKeyPart(key, foldCase(toText(v).trim()));
    }
    return key;
  }

  function truncateForMessage(s) {
    const t = String(s);
    return t.length > 40 ? t.slice(0, 40) + '…' : t;
  }

  // =====================================================================
  // 2. LIKE eşleyici — kullanıcı girdisinden RegExp ÜRETİLMEZ
  // =====================================================================
  // Eski sürüm deseni RegExp'e çeviriyordu: '%(%' SyntaxError fırlatıyor, '%a%a%a…%b'
  // felaket geri izlemeyle (catastrophic backtracking) sekmeyi kilitliyordu. Burada desen
  // '%' ile parçalara bölünür; ilk parça başa, son parça sona sabitlenir, aradakiler
  // soldan sağa açgözlü (en soldaki eşleşme) yerleştirilir. En soldaki yerleşim sonraki
  // parçalara en fazla yer bıraktığı için doğrudur; maliyet O(metin × desen) ile sınırlıdır.

  const LIKE_ANY = null; // '_' joker karakteri
  const SURROGATE_RE = /[\uD800-\uDFFF]/;

  function compileLikePattern(pattern, escapeChar) {
    const chars = Array.from(foldCase(pattern));
    const segs = [[]];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const cur = segs[segs.length - 1];
      if (escapeChar !== null && c === escapeChar) {
        if (i + 1 >= chars.length) throw new Error('LIKE deseni kaçış karakteriyle (ESCAPE) bitemez.');
        i++;
        cur.push(chars[i]);
      } else if (c === '%') {
        segs.push([]);
      } else if (c === '_') {
        cur.push(LIKE_ANY);
      } else {
        cur.push(c);
      }
    }
    return segs;
  }

  function likeMatchAt(t, start, seg) {
    for (let j = 0; j < seg.length; j++) {
      const c = seg[j];
      if (c !== LIKE_ANY && t[start + j] !== c) return false;
    }
    return true;
  }

  function likeMatch(textStr, segs) {
    // Emoji gibi astral karakterlerde '_' tek bir kod noktasına denk gelmeli; yalnızca bu
    // durumda (maliyetli) diziye çevrilir, aksi hâlde metin doğrudan indekslenir.
    const t = SURROGATE_RE.test(textStr) ? Array.from(textStr) : textStr;
    const n = t.length;
    const last = segs.length - 1;
    if (last === 0) return segs[0].length === n && likeMatchAt(t, 0, segs[0]);
    const head = segs[0];
    const tail = segs[last];
    if (head.length + tail.length > n) return false;
    if (!likeMatchAt(t, 0, head) || !likeMatchAt(t, n - tail.length, tail)) return false;
    let pos = head.length;
    const end = n - tail.length;
    for (let k = 1; k < last; k++) {
      const seg = segs[k];
      const len = seg.length;
      if (len === 0) continue;
      let found = -1;
      for (let i = pos; i + len <= end; i++) {
        if (likeMatchAt(t, i, seg)) { found = i; break; }
      }
      if (found < 0) return false;
      pos = found + len;
    }
    return true;
  }

  // =====================================================================
  // 3. Sözcük çözümleyici (tokenizer)
  // =====================================================================
  // Eski düzenli ifade tabanlı ayrıştırıcı, tırnak içini bilmediği için 'Ahmet and Co'
  // metnini AND'den bölüyordu. Tırnakları bilen gerçek bir sözcük çözümleyici bu sınıf
  // hataları kökten kaldırır.

  const ID_START_RE = /^[\p{L}_$]$/u;
  const ID_PART_RE = /^[\p{L}\p{M}\p{N}_$]$/u;
  const DIGIT_RE = /^[0-9]$/;
  const WS_RE = /\s/;
  const NUM_TOKEN_RE = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
  const QUOTE_LABELS = {
    "'": "metin (tek tırnak ')",
    '"': 'tanımlayıcı (çift tırnak ")',
    '`': 'tanımlayıcı (ters tırnak `)',
    ']': 'tanımlayıcı (köşeli parantez [ ])'
  };

  function codePointStr(s, i) {
    return String.fromCodePoint(s.codePointAt(i));
  }

  function readQuoted(sql, start, close) {
    let out = '';
    let i = start + 1;
    for (;;) {
      const j = sql.indexOf(close, i);
      if (j < 0) throw new Error(`SQL sözdizimi hatası: kapatılmamış ${QUOTE_LABELS[close]} (konum ${start + 1}).`);
      out += sql.slice(i, j);
      if (sql[j + 1] === close) { // '' / "" / `` / ]] kaçışı
        out += close;
        i = j + 2;
        continue;
      }
      return { value: out, end: j + 1 };
    }
  }

  function tokenize(sql) {
    const toks = [];
    const n = sql.length;
    let i = 0;

    function push(type, value, pos, end) {
      const t = { type: type, value: value, pos: pos, end: end, idx: toks.length, kw: null };
      toks.push(t);
      return t;
    }

    while (i < n) {
      const c = sql[i];
      if (WS_RE.test(c)) { i++; continue; }

      if (c === '-' && sql[i + 1] === '-') {
        const nl = sql.indexOf('\n', i);
        i = nl < 0 ? n : nl + 1;
        continue;
      }
      if (c === '/' && sql[i + 1] === '*') {
        const e = sql.indexOf('*/', i + 2);
        if (e < 0) throw new Error(`SQL sözdizimi hatası: kapatılmamış yorum /* ... */ (konum ${i + 1}).`);
        i = e + 2;
        continue;
      }

      if (c === "'") {
        const r = readQuoted(sql, i, "'");
        push('string', r.value, i, r.end);
        i = r.end;
        continue;
      }
      if (c === '"' || c === '`' || c === '[') {
        const r = readQuoted(sql, i, c === '[' ? ']' : c);
        if (r.value.trim() === '') throw new Error(`SQL sözdizimi hatası: boş tanımlayıcı (konum ${i + 1}).`);
        push('ident', r.value, i, r.end);
        i = r.end;
        continue;
      }

      // Sayı. 't.5' gibi bir ada yapışık nokta sayı başlatmaz (nitelikli ad ayracıdır).
      const prevTok = toks[toks.length - 1];
      const glued = prevTok && (prevTok.type === 'word' || prevTok.type === 'ident') && prevTok.end === i;
      if (DIGIT_RE.test(c) || (c === '.' && !glued && DIGIT_RE.test(sql[i + 1] || ''))) {
        NUM_TOKEN_RE.lastIndex = i;
        const m = NUM_TOKEN_RE.exec(sql);
        const end = i + m[0].length;
        if (!(end < n && ID_PART_RE.test(codePointStr(sql, end)))) {
          push('number', Number(m[0]), i, end);
          i = end;
          continue;
        }
        // '2023_satis' gibi rakamla başlayan çıplak sütun adı: aşağıda kelime olarak okunur.
      }

      const ch = codePointStr(sql, i);
      if (ID_START_RE.test(ch) || DIGIT_RE.test(c)) {
        let j = i + ch.length;
        while (j < n) {
          const ch2 = codePointStr(sql, j);
          if (!ID_PART_RE.test(ch2)) break;
          j += ch2.length;
        }
        const text = sql.slice(i, j);
        const t = push('word', text, i, j);
        // Anahtar kelime yalnızca ASCII harflerden oluşabilir: 'ın'.toUpperCase() === 'IN'
        // olduğu için Türkçe bir sütun adı yanlışlıkla IN operatörüne dönüşmesin.
        t.kw = /^[A-Za-z]+$/.test(text) ? text.toUpperCase() : null;
        i = j;
        continue;
      }

      const two = sql.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === '!=' || two === '==') {
        push('sym', two, i, i + 2);
        i += 2;
        continue;
      }
      if (two === '||') {
        push('op', two, i, i + 2);
        i += 2;
        continue;
      }
      if ('=<>,().*;'.indexOf(c) >= 0) {
        push('sym', c, i, i + 1);
        i++;
        continue;
      }
      if ('+-/%!~^&|'.indexOf(c) >= 0) {
        push('op', c, i, i + 1);
        i++;
        continue;
      }
      throw new Error(`SQL sözdizimi hatası: beklenmeyen karakter "${ch}" (konum ${i + 1}).`);
    }
    push('eof', '', n, n);
    return toks;
  }

  // =====================================================================
  // 4. Ayrıştırıcı (recursive descent) → sorgu ağacı
  // =====================================================================

  // Ad yerine kullanılamayan anahtar kelimeler (sütun adıysa çift tırnakla yazılmalı).
  const HARD_RESERVED = new Set([
    'SELECT', 'DISTINCT', 'ALL', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
    'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'ANTI', 'SEMI', 'CROSS', 'NATURAL', 'ON', 'USING',
    'UNION', 'INTERSECT', 'EXCEPT', 'AND', 'OR', 'NOT', 'AS', 'IN', 'LIKE', 'ILIKE', 'IS', 'NULL',
    'BETWEEN', 'CASE', 'WITH', 'EXISTS'
  ]);
  const AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
  const CMP_OPS = new Set(['=', '==', '!=', '<>', '<', '<=', '>', '>=']);
  const WRITE_KW = new Set(['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'REPLACE', 'MERGE', 'TRUNCATE', 'UPSERT', 'ATTACH', 'PRAGMA']);
  const CLAUSE_KW = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'ANTI', 'ON']);
  const SET_OP_MSG = 'UNION / INTERSECT / EXCEPT desteklenmiyor; sorguları ayrı ayrı çalıştırın.';
  const UNSUPPORTED_KW = {
    UNION: SET_OP_MSG,
    INTERSECT: SET_OP_MSG,
    EXCEPT: SET_OP_MSG,
    CASE: 'CASE ifadeleri desteklenmiyor.',
    OVER: 'Pencere fonksiyonları (OVER ...) desteklenmiyor.',
    WINDOW: 'Pencere fonksiyonları (WINDOW ...) desteklenmiyor.',
    WITH: 'WITH (CTE) sorguları desteklenmiyor.',
    EXISTS: 'EXISTS ve alt sorgular desteklenmiyor.',
    CROSS: 'CROSS JOIN desteklenmiyor; JOIN ... ON a.x = b.y kullanın.',
    NATURAL: 'NATURAL JOIN desteklenmiyor; JOIN ... ON a.x = b.y kullanın.',
    USING: 'JOIN ... USING (...) desteklenmiyor; ON a.x = b.y kullanın.',
    SEMI: 'SEMI JOIN desteklenmiyor; INNER JOIN veya ANTI JOIN kullanın.',
    NULLS: 'NULLS FIRST / NULLS LAST desteklenmiyor; boş değerler artan sıralamada başa, azalanda sona gelir.',
    FETCH: 'FETCH FIRST desteklenmiyor; LIMIT n kullanın.',
    INTO: 'SELECT ... INTO desteklenmiyor; yerel SQL motoru salt okunurdur.'
  };

  function createParser(sql) {
    const toks = tokenize(sql);
    let i = 0;
    let inCondition = false;

    function peek(k) { return toks[Math.min(i + (k || 0), toks.length - 1)]; }
    function next() { const t = toks[i]; if (i < toks.length - 1) i++; return t; }
    function prev() { return toks[Math.max(i - 1, 0)]; }
    function isKw(kw, k) { const t = peek(k); return t.type === 'word' && t.kw === kw; }
    function acceptKw(kw) { if (isKw(kw)) { next(); return true; } return false; }
    function isSym(s, k) { const t = peek(k); return t.type === 'sym' && t.value === s; }
    function acceptSym(s) { if (isSym(s)) { next(); return true; } return false; }
    function isNameTok(t) { return t.type === 'ident' || (t.type === 'word' && !HARD_RESERVED.has(t.kw)); }
    function src(a, b) { return sql.slice(a.pos, b.end); }
    function mk(node, startTok) { node.text = src(startTok, prev()); return node; }

    function syntaxError(msg, tok) {
      const t = tok || peek();
      const near = t.type === 'eof' ? 'sorgunun sonunda' : `"${sql.slice(t.pos, t.end)}" yakınında`;
      return new Error(`SQL sözdizimi hatası: ${msg} (konum ${t.pos + 1}, ${near}).`);
    }
    function expectKw(kw, msg) { if (!acceptKw(kw)) throw syntaxError(msg || `${kw} bekleniyordu`); }
    function expectSym(s, msg) { if (!acceptSym(s)) throw syntaxError(msg || `'${s}' bekleniyordu`); }

    function unsupportedOp(t) {
      const p = toks[t.idx - 1];
      const n = toks[t.idx + 1];
      let hint = ' — aritmetik ve metin birleştirme ifadeleri desteklenmiyor';
      // 'e-posta' gibi tırnaksız yazılmış bir sütun adı en olası sebeptir (ardından sayı
      // geliyorsa 'tutar+1' gibi aritmetik niyet daha olasıdır, o yüzden yalnızca kelimede).
      if (p && n && (p.type === 'word' || p.type === 'number') && n.type === 'word' &&
        p.end === t.pos && t.end === n.pos) {
        hint = ` — sütun adıysa çift tırnak içine alın: "${sql.slice(p.pos, n.end)}"`;
      }
      return new Error(`Desteklenmeyen operatör: ${t.value}${hint}`);
    }

    function unexpected(context) {
      const t = peek();
      if (t.type === 'op') return unsupportedOp(t);
      if (t.type === 'eof') return syntaxError(`sorgu beklenmedik şekilde bitti${context ? ' — ' + context : ''}`);
      if (t.type === 'sym' && t.value === ';') return new Error('Tek seferde yalnızca bir SQL sorgusu çalıştırılabilir.');
      if (t.type === 'word' && UNSUPPORTED_KW[t.kw]) return new Error(UNSUPPORTED_KW[t.kw]);
      return syntaxError(`beklenmeyen ifade${context ? ' — ' + context : ''}`);
    }

    function requireValue(node, where) {
      if (node.kind !== 'value') {
        throw new Error(`${where} için sütun veya değer bekleniyordu, koşul verildi: "${node.text}".`);
      }
    }
    function requireBool(node, where) {
      if (node.kind !== 'bool') {
        throw new Error(`${where} yalnızca koşulları birleştirebilir; "${node.text}" bir koşul değil (örn. sutun = 'değer').`);
      }
    }

    // ---------------- İfadeler ----------------

    function parseExpr() { return parseOr(); }

    // Öncelik: OR < AND < NOT < karşılaştırma. Eski sürüm OR'u tamamen yok sayıyordu.
    function parseOr() {
      const st = peek();
      let left = parseAnd();
      while (isKw('OR')) {
        next();
        const right = parseAnd();
        requireBool(left, 'OR');
        requireBool(right, 'OR');
        left = mk({ type: 'or', kind: 'bool', left: left, right: right }, st);
      }
      return left;
    }

    function parseAnd() {
      const st = peek();
      let left = parseNot();
      while (isKw('AND')) {
        next();
        const right = parseNot();
        requireBool(left, 'AND');
        requireBool(right, 'AND');
        left = mk({ type: 'and', kind: 'bool', left: left, right: right }, st);
      }
      return left;
    }

    function parseNot() {
      if (isKw('NOT')) {
        const st = next();
        const e = parseNot();
        requireBool(e, 'NOT');
        return mk({ type: 'not', kind: 'bool', expr: e }, st);
      }
      return parsePredicate();
    }

    function parsePredicate() {
      const st = peek();
      const left = parsePrimary();
      const t = peek();

      if (t.type === 'sym' && CMP_OPS.has(t.value)) {
        next();
        const right = parsePrimary();
        requireValue(left, t.value);
        requireValue(right, t.value);
        const op = t.value === '==' ? '=' : (t.value === '<>' ? '!=' : t.value);
        const node = mk({ type: 'cmp', kind: 'bool', op: op, left: left, right: right }, st);
        const n2 = peek();
        if (n2.type === 'sym' && CMP_OPS.has(n2.value)) {
          throw syntaxError('zincirleme karşılaştırma (a < b < c) desteklenmiyor; AND ile ayırın');
        }
        return node;
      }

      if (t.type === 'word') {
        if (t.kw === 'IS') {
          next();
          const not = acceptKw('NOT');
          if (!acceptKw('NULL')) throw syntaxError('IS sonrasında NULL veya NOT NULL bekleniyordu');
          requireValue(left, 'IS NULL');
          return mk({ type: 'isnull', kind: 'bool', not: not, expr: left }, st);
        }
        let negate = false;
        if (t.kw === 'NOT' && peek(1).type === 'word' && ['IN', 'LIKE', 'ILIKE', 'BETWEEN'].indexOf(peek(1).kw) >= 0) {
          next();
          negate = true;
        }
        const k = peek().kw;
        if (peek().type === 'word' && k === 'IN') {
          next();
          expectSym('(', "IN sonrasında '(' bekleniyordu");
          if (isKw('SELECT')) throw new Error('Alt sorgular (IN (SELECT ...)) desteklenmiyor.');
          if (isSym(')')) throw syntaxError('IN listesi boş olamaz');
          const list = [];
          do {
            const it = parsePrimary();
            requireValue(it, 'IN');
            list.push(it);
          } while (acceptSym(','));
          expectSym(')', "IN listesinin sonunda ')' bekleniyordu");
          requireValue(left, 'IN');
          return mk({ type: 'in', kind: 'bool', not: negate, expr: left, list: list }, st);
        }
        if (peek().type === 'word' && (k === 'LIKE' || k === 'ILIKE')) {
          next();
          const pattern = parsePrimary();
          requireValue(left, 'LIKE');
          requireValue(pattern, 'LIKE');
          let escape = null;
          if (acceptKw('ESCAPE')) {
            const e = next();
            if (e.type !== 'string' || Array.from(e.value).length !== 1) {
              throw syntaxError('ESCAPE tek karakterlik bir metin olmalı (örn. ESCAPE \'!\')', e);
            }
            escape = e.value;
          }
          return mk({ type: 'like', kind: 'bool', not: negate, expr: left, pattern: pattern, escape: escape }, st);
        }
        if (peek().type === 'word' && k === 'BETWEEN') {
          next();
          const lo = parsePrimary();
          expectKw('AND', 'BETWEEN a AND b biçiminde AND bekleniyordu');
          const hi = parsePrimary();
          requireValue(left, 'BETWEEN');
          requireValue(lo, 'BETWEEN');
          requireValue(hi, 'BETWEEN');
          return mk({ type: 'between', kind: 'bool', not: negate, expr: left, lo: lo, hi: hi }, st);
        }
      }

      // Koşul bağlamında bir değerin ardından tanınmayan bir işleç/kelime gelirse sessizce
      // "koşul yok" saymak yerine açık hata ver (eski sürüm bilinmeyen operatörü true sayıyordu).
      if (left.kind === 'value' && inCondition) {
        if (t.type === 'op') throw unsupportedOp(t);
        if (t.type === 'word' && !HARD_RESERVED.has(t.kw)) {
          if (UNSUPPORTED_KW[t.kw]) throw new Error(UNSUPPORTED_KW[t.kw]);
          throw new Error(`Desteklenmeyen operatör: ${t.value}`);
        }
      }
      return left;
    }

    function parsePrimary() {
      const t = peek();
      if (t.type === 'sym' && t.value === '(') {
        next();
        if (isKw('SELECT')) throw new Error('Alt sorgular desteklenmiyor.');
        const e = parseExpr();
        expectSym(')', "kapanış parantezi ')' bekleniyordu");
        return e;
      }
      if (t.type === 'number') {
        next();
        return mk({ type: 'lit', kind: 'value', value: t.value, numeric: true }, t);
      }
      if (t.type === 'op' && t.value === '-' && peek(1).type === 'number') {
        next();
        const n = next();
        return mk({ type: 'lit', kind: 'value', value: -n.value, numeric: true }, t);
      }
      if (t.type === 'string') {
        next();
        return mk({ type: 'lit', kind: 'value', value: t.value, numeric: false }, t);
      }
      if (t.type === 'word' && t.kw === 'NULL') {
        next();
        return mk({ type: 'lit', kind: 'value', value: null, numeric: false }, t);
      }
      if (t.type === 'word' && HARD_RESERVED.has(t.kw)) {
        if (UNSUPPORTED_KW[t.kw]) throw new Error(UNSUPPORTED_KW[t.kw]);
        throw syntaxError(`beklenmeyen anahtar kelime ${t.kw} — sütun adıysa çift tırnak içine alın: "${t.value}"`);
      }
      if (t.type === 'word' && isSym('(', 1)) return parseFunction();
      if (t.type === 'word' || t.type === 'ident') return parseColumnRef();
      if (t.type === 'op') throw unsupportedOp(t);
      if (t.type === 'sym' && t.value === '*') throw syntaxError("'*' yalnızca SELECT * veya COUNT(*) içinde kullanılabilir");
      throw unexpected();
    }

    function parseFunction() {
      const st = next();
      if (UNSUPPORTED_KW[st.kw]) throw new Error(UNSUPPORTED_KW[st.kw]);
      if (!AGG_FUNCS.has(st.kw)) {
        throw new Error(`Desteklenmeyen fonksiyon: ${st.value}(). Desteklenenler: COUNT, SUM, AVG, MIN, MAX.`);
      }
      const func = st.kw;
      next(); // '('
      let distinct = false;
      let star = false;
      let arg = null;
      if (acceptKw('DISTINCT')) distinct = true;
      else acceptKw('ALL');
      if (isSym('*')) {
        next();
        star = true;
      } else {
        if (isSym(')')) throw syntaxError(`${func}() bir argüman gerektirir`);
        const saved = inCondition;
        inCondition = false;
        arg = parseExpr();
        inCondition = saved;
        requireValue(arg, func);
      }
      if (isSym(',')) throw syntaxError(`${func} tek bir argüman alır`);
      expectSym(')', `${func}( ... ) kapanış parantezi bekleniyordu`);
      if (star && func !== 'COUNT') throw new Error(`${func}(*) geçersiz; yalnızca COUNT(*) kullanılabilir.`);
      if (star && distinct) throw new Error('COUNT(DISTINCT *) geçersiz; COUNT(DISTINCT sutun) kullanın.');
      if (distinct && func !== 'COUNT') throw new Error(`${func}(DISTINCT ...) desteklenmiyor; yalnızca COUNT(DISTINCT ...) desteklenir.`);
      if (isKw('OVER')) throw new Error(UNSUPPORTED_KW.OVER);
      return mk({ type: 'agg', kind: 'value', func: func, star: star, distinct: distinct, arg: arg }, st);
    }

    function parseColumnRef() {
      const st = next();
      let qualifier = null;
      let name = st.value;
      if (isSym('.')) {
        next();
        const t2 = peek();
        if (t2.type === 'word' || t2.type === 'ident') {
          next();
          qualifier = st.value;
          name = t2.value;
        } else if (t2.type === 'sym' && t2.value === '*') {
          throw syntaxError(`'${st.value}.*' yalnızca SELECT listesinde kullanılabilir`);
        } else {
          throw syntaxError("'.' sonrasında sütun adı bekleniyordu");
        }
        if (isSym('.')) throw syntaxError('üç parçalı adlar (şema.tablo.sütun) desteklenmiyor');
      }
      return mk({ type: 'col', kind: 'value', qualifier: qualifier, name: name }, st);
    }

    // ---------------- Yan tümceler ----------------

    function parseCondition(clause) {
      const saved = inCondition;
      inCondition = true;
      const st = peek();
      const e = parseExpr();
      inCondition = saved;
      if (e.kind !== 'bool') {
        throw new Error(`${clause} bir koşul olmalı (örn. sutun = 'değer'): "${src(st, prev())}".`);
      }
      const n = peek();
      if (isNameTok(n) || n.type === 'string' || n.type === 'number') {
        throw syntaxError(`${clause} koşulundan sonra beklenmeyen ifade — AND / OR mu eksik?`);
      }
      return e;
    }

    function parseAliasName() {
      const t = peek();
      if (isNameTok(t) || t.type === 'string') {
        next();
        return t.value;
      }
      throw syntaxError('AS sonrasında takma ad bekleniyordu');
    }

    function parseSelectList() {
      if (isKw('FROM')) throw syntaxError('SELECT listesi boş; en az bir sütun veya * yazın');
      const items = [];
      do {
        const t = peek();
        if (t.type === 'sym' && t.value === '*') {
          next();
          items.push({ type: 'star', table: null });
          continue;
        }
        if (isNameTok(t) && isSym('.', 1) && isSym('*', 2)) {
          next(); next(); next();
          items.push({ type: 'star', table: t.value });
          continue;
        }
        const st = peek();
        const expr = parseExpr();
        const endTok = prev();
        if (expr.kind !== 'value') {
          throw new Error(`SELECT listesinde koşul/karşılaştırma desteklenmiyor: "${src(st, endTok)}". Süzmek için WHERE kullanın.`);
        }
        let alias = null;
        if (acceptKw('AS')) {
          alias = parseAliasName();
        } else {
          const n = peek();
          // Takma ad için AS zorunlu: "SELECT ad soyad" çoğunlukla unutulmuş bir virgüldür ve
          // standart SQL'de sessizce "ad AS soyad" olarak yorumlanıp yanlış tablo üretirdi.
          if (isNameTok(n) || n.type === 'string') {
            throw syntaxError(`"${n.value}" beklenmiyordu — iki sütun arasında virgül mü eksik? Takma ad için AS kullanın (örn. ${src(st, endTok)} AS ${n.value})`, n);
          }
        }
        items.push({ type: 'expr', expr: expr, alias: alias, text: src(st, endTok) });
      } while (acceptSym(','));
      return items;
    }

    function parseTableRef() {
      const t = peek();
      if (t.type === 'sym' && t.value === '(') throw new Error('Alt sorgular (FROM (SELECT ...)) desteklenmiyor.');
      if (!isNameTok(t)) throw syntaxError('tablo adı bekleniyordu');
      next();
      if (isSym('.')) throw syntaxError('şema.tablo biçimi desteklenmiyor; yalnızca tablo adını yazın');
      let alias = null;
      if (acceptKw('AS')) {
        alias = parseAliasName();
      } else if (isNameTok(peek())) {
        alias = next().value;
      }
      return { name: t.value, alias: alias };
    }

    function parseJoin() {
      const t = peek();
      if (t.type !== 'word') return null;
      let type;
      switch (t.kw) {
        case 'JOIN':
          next();
          type = 'INNER';
          break;
        case 'INNER':
          next();
          expectKw('JOIN', 'INNER sonrasında JOIN bekleniyordu');
          type = 'INNER';
          break;
        case 'LEFT':
          next();
          if (acceptKw('ANTI')) {
            type = 'ANTI';
          } else {
            if (isKw('SEMI')) throw new Error(UNSUPPORTED_KW.SEMI);
            acceptKw('OUTER');
            type = 'LEFT';
          }
          expectKw('JOIN', 'LEFT sonrasında JOIN bekleniyordu');
          break;
        case 'RIGHT':
          next();
          acceptKw('OUTER');
          expectKw('JOIN', 'RIGHT sonrasında JOIN bekleniyordu');
          type = 'RIGHT';
          break;
        case 'FULL':
          next();
          acceptKw('OUTER');
          expectKw('JOIN', 'FULL sonrasında JOIN bekleniyordu');
          type = 'FULL';
          break;
        case 'ANTI':
          next();
          expectKw('JOIN', 'ANTI sonrasında JOIN bekleniyordu');
          type = 'ANTI';
          break;
        case 'CROSS':
        case 'NATURAL':
        case 'SEMI':
          throw new Error(UNSUPPORTED_KW[t.kw]);
        default:
          return null;
      }
      const table = parseTableRef();
      if (isKw('USING')) throw new Error(UNSUPPORTED_KW.USING);
      if (!acceptKw('ON')) throw syntaxError('JOIN için ON koşulu gerekli (örn. ON a.id = b.musteri_id)');
      const on = parseCondition('JOIN ON');
      return { type: type, table: table, on: on };
    }

    function parseNonNegInt(clause) {
      const t = next();
      if (t.type !== 'number' || !Number.isInteger(t.value) || t.value < 0) {
        throw syntaxError(`${clause} negatif olmayan bir tam sayı olmalı`, t);
      }
      return t.value;
    }

    function parseQuery() {
      const first = peek();
      if (first.type === 'eof') throw new Error('Geçerli bir SQL sorgusu gereklidir.');
      if (first.type === 'word' && WRITE_KW.has(first.kw)) {
        throw new Error('Yalnızca SELECT sorguları desteklenir; yerel SQL motoru veriyi değiştirmez.');
      }
      if (first.type === 'word' && first.kw === 'WITH') throw new Error(UNSUPPORTED_KW.WITH);
      expectKw('SELECT', 'sorgu SELECT ile başlamalı');

      const q = {
        distinct: false, items: [], from: null, joins: [], where: null,
        groupBy: [], having: null, orderBy: [], limit: null, offset: 0
      };
      if (acceptKw('DISTINCT')) q.distinct = true;
      else acceptKw('ALL');

      q.items = parseSelectList();
      if (!isKw('FROM')) {
        if (peek().type === 'eof') throw new Error('Sorguda FROM ifadesi bulunamadı.');
        throw unexpected('SELECT listesinden sonra virgül veya FROM bekleniyordu');
      }
      next();
      q.from = parseTableRef();
      if (isSym(',')) throw new Error('Virgülle tablo birleştirme (FROM a, b) desteklenmiyor; JOIN ... ON kullanın.');

      for (;;) {
        const j = parseJoin();
        if (!j) break;
        q.joins.push(j);
      }

      if (acceptKw('WHERE')) q.where = parseCondition('WHERE');
      if (isKw('GROUP')) {
        next();
        expectKw('BY', 'GROUP sonrasında BY bekleniyordu');
        do {
          const e = parseExpr();
          requireValue(e, 'GROUP BY');
          q.groupBy.push(e);
        } while (acceptSym(','));
      }
      if (acceptKw('HAVING')) q.having = parseCondition('HAVING');
      if (isKw('ORDER')) {
        next();
        expectKw('BY', 'ORDER sonrasında BY bekleniyordu');
        do {
          const e = parseExpr();
          requireValue(e, 'ORDER BY');
          let desc = false;
          if (acceptKw('DESC')) desc = true;
          else acceptKw('ASC');
          q.orderBy.push({ expr: e, desc: desc });
        } while (acceptSym(','));
      }
      let sawLimit = false;
      let sawOffset = false;
      for (;;) {
        if (!sawLimit && acceptKw('LIMIT')) {
          sawLimit = true;
          q.limit = parseNonNegInt('LIMIT');
          if (isSym(',')) throw new Error("'LIMIT a, b' biçimi desteklenmiyor; 'LIMIT b OFFSET a' kullanın.");
          continue;
        }
        if (!sawOffset && acceptKw('OFFSET')) {
          sawOffset = true;
          q.offset = parseNonNegInt('OFFSET');
          continue;
        }
        break;
      }

      while (acceptSym(';')) { /* sondaki noktalı virgüller */ }
      const t = peek();
      if (t.type !== 'eof') {
        if (prev().type === 'sym' && prev().value === ';') {
          throw new Error('Tek seferde yalnızca bir SQL sorgusu çalıştırılabilir.');
        }
        if (t.type === 'word' && CLAUSE_KW.has(t.kw)) {
          throw new Error(`'${t.value}' yan tümcesi yanlış konumda veya tekrarlanmış. Doğru sıra: SELECT → FROM → JOIN → WHERE → GROUP BY → HAVING → ORDER BY → LIMIT/OFFSET.`);
        }
        throw unexpected();
      }
      return q;
    }

    function parseStandaloneExpr() {
      const e = parseExpr();
      if (peek().type !== 'eof') throw unexpected();
      return e;
    }

    return { parseQuery: parseQuery, parseStandaloneExpr: parseStandaloneExpr };
  }

  function containsAgg(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'agg') return true;
    const kids = [node.left, node.right, node.expr, node.pattern, node.lo, node.hi, node.arg];
    for (let k = 0; k < kids.length; k++) {
      if (kids[k] && containsAgg(kids[k])) return true;
    }
    if (Array.isArray(node.list)) return node.list.some(containsAgg);
    return false;
  }

  function isNumLit(node) {
    return node.type === 'lit' && node.numeric === true;
  }

  // =====================================================================
  // 5. Eski (legacy) plan nesnesi → sorgu ağacı (executePlan geriye uyumluluğu)
  // =====================================================================

  function legacyExpr(s) {
    const text = String(s === null || s === undefined ? '' : s).trim();
    try {
      const e = createParser(text).parseStandaloneExpr();
      if (e.kind === 'value') return e;
    } catch (err) {
      // 'Ad Soyad' gibi ham sütun adları ayrıştırılamaz; aşağıda doğrudan ad olarak kullanılır.
    }
    return { type: 'col', kind: 'value', qualifier: null, name: text, text: text };
  }

  function legacyLit(v) {
    const value = v === undefined ? null : v;
    return {
      type: 'lit', kind: 'value', value: value,
      numeric: typeof value === 'number',
      text: typeof value === 'string' ? `'${value}'` : String(value)
    };
  }

  function legacyCond(c) {
    if (!c || typeof c !== 'object') throw new Error('Geçersiz koşul nesnesi (column/op/value bekleniyordu).');
    const left = legacyExpr(c.column);
    const rawOp = String(c.op === undefined ? '' : c.op);
    const op = rawOp.toUpperCase().replace(/\s+/g, ' ').trim();
    const text = `${left.text} ${op}`;
    switch (op) {
      case '=': case '==':
        return { type: 'cmp', kind: 'bool', op: '=', left: left, right: legacyLit(c.value), text: text };
      case '!=': case '<>':
        return { type: 'cmp', kind: 'bool', op: '!=', left: left, right: legacyLit(c.value), text: text };
      case '>': case '>=': case '<': case '<=':
        return { type: 'cmp', kind: 'bool', op: op, left: left, right: legacyLit(c.value), text: text };
      case 'LIKE': case 'ILIKE': case 'NOT LIKE': case 'NOT ILIKE':
        return { type: 'like', kind: 'bool', not: op.indexOf('NOT') === 0, expr: left, pattern: legacyLit(c.value), escape: null, text: text };
      case 'IS NULL': case 'IS NOT NULL':
        return { type: 'isnull', kind: 'bool', not: op === 'IS NOT NULL', expr: left, text: text };
      case 'IN': case 'NOT IN': {
        const raw = Array.isArray(c.value) ? c.value : String(c.value === undefined ? '' : c.value).split(',').map(s => s.trim());
        return { type: 'in', kind: 'bool', not: op === 'NOT IN', expr: left, list: raw.map(legacyLit), text: text };
      }
      default:
        throw new Error(`Desteklenmeyen operatör: ${rawOp}`);
    }
  }

  function legacyConds(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.map(legacyCond).reduce((acc, n) => (acc
      ? { type: 'and', kind: 'bool', left: acc, right: n, text: `${acc.text} AND ${n.text}` }
      : n), null);
  }

  function legacyJoinType(t) {
    const s = String(t || 'INNER JOIN').toUpperCase().replace(/\s+/g, ' ').trim();
    switch (s) {
      case 'JOIN': case 'INNER': case 'INNER JOIN': return 'INNER';
      case 'LEFT': case 'LEFT JOIN': case 'LEFT OUTER JOIN': return 'LEFT';
      case 'RIGHT': case 'RIGHT JOIN': case 'RIGHT OUTER JOIN': return 'RIGHT';
      case 'FULL': case 'FULL JOIN': case 'FULL OUTER JOIN': return 'FULL';
      case 'ANTI': case 'ANTI JOIN': case 'LEFT ANTI JOIN': return 'ANTI';
      default: throw new Error(`Desteklenmeyen JOIN türü: ${t}`);
    }
  }

  function planToQuery(plan) {
    if (!plan || typeof plan !== 'object') throw new Error('executePlan geçerli bir sorgu planı nesnesi gerektirir.');
    if (!plan.from) throw new Error('Sorgu planında "from" tablo adı gerekli.');
    const groupBy = Array.isArray(plan.groupBy) ? plan.groupBy.map(legacyExpr) : [];
    const sel = Array.isArray(plan.select) && plan.select.length > 0
      ? plan.select
      : (groupBy.length > 0 ? plan.groupBy : ['*']);
    const items = sel.map(s => {
      const t = String(s).trim();
      if (t === '*') return { type: 'star', table: null };
      const m = /^(.+)\.\*$/.exec(t);
      if (m) return { type: 'star', table: m[1] };
      return { type: 'expr', expr: legacyExpr(t), alias: null, text: t };
    });
    const joins = Array.isArray(plan.joins) ? plan.joins.map(j => {
      if (!j || !j.on) throw new Error('JOIN yapılandırması "on: { leftCol, rightCol }" gerektirir.');
      const l = legacyExpr(j.on.leftCol);
      const r = legacyExpr(j.on.rightCol);
      return {
        type: legacyJoinType(j.type),
        table: { name: j.table, alias: null },
        on: { type: 'cmp', kind: 'bool', op: '=', left: l, right: r, text: `${l.text} = ${r.text}` }
      };
    }) : [];
    const orderBy = Array.isArray(plan.orderBy)
      ? plan.orderBy.map(o => ({ expr: legacyExpr(o.column), desc: !!o.desc }))
      : [];
    return {
      distinct: !!plan.distinct,
      items: items,
      from: { name: plan.from, alias: null },
      joins: joins,
      where: legacyConds(plan.where),
      groupBy: groupBy,
      having: legacyConds(plan.having),
      orderBy: orderBy,
      limit: (typeof plan.limit === 'number' && plan.limit >= 0) ? Math.floor(plan.limit) : null,
      offset: 0
    };
  }

  // =====================================================================
  // 6. Hash JOIN (tüm türler O(n + m + çıktı))
  // =====================================================================

  function buildKeyIndex(rows, idxs) {
    const map = new Map();
    for (let i = 0; i < rows.length; i++) {
      const k = joinKey(rows[i], idxs);
      if (k === null) continue;
      const bucket = map.get(k);
      if (bucket) bucket.push(i);
      else map.set(k, [i]);
    }
    return map;
  }

  function hashJoin(leftRows, leftWidth, rightRows, rightWidth, type, li, ri) {
    const out = [];
    const emptyL = new Array(leftWidth).fill(null);
    const emptyR = new Array(rightWidth).fill(null);

    if (type === 'RIGHT') {
      const map = buildKeyIndex(leftRows, li);
      for (let i = 0; i < rightRows.length; i++) {
        const rb = rightRows[i];
        const k = joinKey(rb, ri);
        const m = k === null ? undefined : map.get(k);
        if (m) {
          for (let x = 0; x < m.length; x++) out.push(leftRows[m[x]].concat(rb));
        } else {
          out.push(emptyL.concat(rb));
        }
      }
      return out;
    }

    const map = buildKeyIndex(rightRows, ri);
    // FULL JOIN: eşleşen sağ satırlar bayrakla izlenir. Eski sürüm her sağ satır için sol
    // tabloyu baştan tarıyordu (O(n·m): 20k×20k'da ~14 sn).
    const matched = type === 'FULL' ? new Uint8Array(rightRows.length) : null;
    for (let i = 0; i < leftRows.length; i++) {
      const ra = leftRows[i];
      const k = joinKey(ra, li);
      const m = k === null ? undefined : map.get(k);
      if (type === 'ANTI') {
        if (!m) out.push(ra.concat(emptyR));
        continue;
      }
      if (m) {
        for (let x = 0; x < m.length; x++) {
          out.push(ra.concat(rightRows[m[x]]));
          if (matched) matched[m[x]] = 1;
        }
      } else if (type === 'LEFT' || type === 'FULL') {
        out.push(ra.concat(emptyR));
      }
    }
    if (matched) {
      for (let i = 0; i < rightRows.length; i++) {
        if (!matched[i]) out.push(emptyL.concat(rightRows[i]));
      }
    }
    return out;
  }

  // =====================================================================
  // 7. Toplama fonksiyonları
  // =====================================================================

  function makeAggregate(node, argFn) {
    const func = node.func;
    if (func === 'COUNT') {
      if (node.star) return g => g.rows.length;
      if (node.distinct) {
        return g => {
          const seen = new Set();
          const rows = g.rows;
          for (let i = 0; i < rows.length; i++) {
            const v = argFn(rows[i]);
            if (!isEmpty(v)) seen.add(foldCase(toText(v)));
          }
          return seen.size;
        };
      }
      return g => {
        let c = 0;
        const rows = g.rows;
        for (let i = 0; i < rows.length; i++) {
          if (!isEmpty(argFn(rows[i]))) c++;
        }
        return c;
      };
    }

    if (func === 'SUM' || func === 'AVG') {
      return g => {
        let sum = 0;
        let cnt = 0;
        const rows = g.rows;
        for (let i = 0; i < rows.length; i++) {
          const v = argFn(rows[i]);
          if (isEmpty(v)) continue;
          const n = toNumber(v);
          // Sayısal olmayan değeri atlamak toplamı sessizce eksik gösterirdi ('1.234,56' gibi
          // yerel biçimler dahil). Kullanıcı düzeltebilsin diye hangi değer olduğu söylenir.
          if (Number.isNaN(n)) {
            throw new Error(`${node.text}: sayısal olmayan değer "${truncateForMessage(toText(v))}". Sayıları 1234.56 biçimine çevirin veya bu satırları WHERE ile dışlayın.`);
          }
          sum += n;
          cnt++;
        }
        // Boş küme için SQL standardı NULL'dır; 0 döndürmek "toplam sıfır" yanılgısı yaratır.
        if (cnt === 0) return null;
        if (func === 'SUM') return sum;
        return parseFloat((sum / cnt).toFixed(2));
      };
    }

    // MIN / MAX: döngüyle; Math.min(...dizi) ~125k+ öğede "Maximum call stack size exceeded"
    // fırlatır. ORDER BY ile aynı toplam sıralamayı kullanır (ISO tarihlerde de çalışır).
    const wantMax = func === 'MAX';
    return g => {
      let found = false;
      let bestKey = null;
      let bestVal = null;
      const rows = g.rows;
      for (let i = 0; i < rows.length; i++) {
        const v = argFn(rows[i]);
        if (isEmpty(v)) continue;
        const k = sortKey(v);
        if (!found) {
          found = true;
          bestKey = k;
          bestVal = v;
          continue;
        }
        const c = cmpSortKeys(k, bestKey);
        if (wantMax ? c > 0 : c < 0) {
          bestKey = k;
          bestVal = v;
        }
      }
      if (!found) return null;
      return typeof bestKey === 'number' ? bestKey : bestVal;
    };
  }

  function assertComparableLiteral(node, opLabel) {
    if (node.type !== 'lit') return;
    if (node.value === null || (typeof node.value === 'string' && node.value.trim() === '')) {
      throw new Error(`${opLabel} ile NULL veya boş metin ('') karşılaştırılamaz; boş hücreler için IS NULL / IS NOT NULL kullanın.`);
    }
  }

  const RANGE_TESTS = {
    '<': c => c < 0,
    '<=': c => c <= 0,
    '>': c => c > 0,
    '>=': c => c >= 0
  };

  // =====================================================================
  // 8. Bellek içi veritabanı
  // =====================================================================

  /**
   * Bellek içi tablo deposu (In-Memory Database)
   */
  function createDatabase() {
    const tables = new Map();

    /**
     * Tablo kaydetme
     */
    function registerTable(tableName, headers, rows) {
      if (!tableName || !Array.isArray(headers) || !Array.isArray(rows)) {
        throw new Error('registerTable geçerli tableName, headers ve rows gerektirir.');
      }
      const cleanName = tableName.trim().toLowerCase();
      tables.set(cleanName, {
        name: tableName,
        headers: headers.map(h => String(h).trim()),
        // Motor salt okunurdur (yazma komutları reddedilir); satırlar paylaşılır.
        // Eskiden her kayıtta bütün tablo kopyalanıyordu (5M satırda ~500 MB).
        rows: rows.slice()
      });
      return { success: true, tableName: cleanName, rowCount: rows.length, colCount: headers.length };
    }

    function getTable(tableName) {
      return tables.get(String(tableName).trim().toLowerCase()) || null;
    }

    function listTables() {
      return Array.from(tables.values()).map(t => ({
        name: t.name,
        headers: t.headers,
        rowCount: t.rows.length
      }));
    }

    function dropTable(tableName) {
      return tables.delete(String(tableName).trim().toLowerCase());
    }

    /** SQL içindeki tablo adını bulur ('Müşteriler' ↔ 'MÜŞTERİLER' ↔ 'musteriler' değil, harf katlamalı). */
    function findTable(name) {
      const direct = getTable(name);
      if (direct) return direct;
      const key = identKey(name);
      let found = null;
      tables.forEach(t => {
        if (!found && identKey(t.name) === key) found = t;
      });
      return found;
    }

    /**
     * Sorgu ağacını derler (tüm ad çözümleme ve doğrulama veriye dokunmadan önce yapılır,
     * böylece hatalar büyük JOIN'ler çalışmadan hemen döner) ve yürütür.
     */
    function runQuery(q) {
      const t0 = Date.now();
      const sources = [];
      const scope = []; // { name, key, src }

      function addSource(ref, isJoin) {
        const table = findTable(ref.name);
        if (!table) {
          throw new Error(isJoin ? `Join tablosu bulunamadı: "${ref.name}"` : `Tablo bulunamadı: "${ref.name}"`);
        }
        const label = ref.alias != null ? ref.alias : ref.name;
        const qual = identKey(label);
        if (sources.some(s => s.qual === qual)) {
          throw new Error(`"${label}" tablo adı/takma adı sorguda iki kez kullanılıyor; her tabloya farklı bir takma ad verin (örn. FROM t AS a JOIN t AS b ...).`);
        }
        const src = {
          table: table,
          qual: qual,
          quals: new Set([qual, identKey(ref.name), identKey(table.name)]),
          offset: scope.length,
          width: table.headers.length,
          label: label
        };
        table.headers.forEach(h => scope.push({ name: h, key: identKey(h), src: src }));
        sources.push(src);
        return src;
      }

      function displayRef(ref) {
        return ref.qualifier != null ? `${ref.qualifier}.${ref.name}` : ref.name;
      }

      function lookup(ref, lo, hi) {
        const key = identKey(ref.name);
        const qk = ref.qualifier != null ? identKey(ref.qualifier) : null;
        const out = [];
        for (let k = lo; k < hi; k++) {
          const c = scope[k];
          if (c.key === key && (qk === null || c.src.quals.has(qk))) out.push(k);
        }
        return out;
      }

      function availableColumns() {
        const seen = new Set();
        const names = [];
        scope.forEach(c => {
          if (!seen.has(c.key)) {
            seen.add(c.key);
            names.push(c.name);
          }
        });
        return names.length > 20 ? names.slice(0, 20).join(', ') + ', …' : names.join(', ');
      }

      function unknownColumn(ref, hint) {
        let msg = `Bilinmeyen sütun: ${displayRef(ref)}`;
        if (ref.qualifier != null && !sources.some(s => s.quals.has(identKey(ref.qualifier)))) {
          msg += ` ("${ref.qualifier}" adında bir tablo veya takma ad yok)`;
        }
        msg += `. Mevcut sütunlar: ${availableColumns()}`;
        if (hint) msg += `. ${hint}`;
        return new Error(msg);
      }

      function ambiguousColumn(ref, hits) {
        const opts = hits.map(k => `${scope[k].src.label}.${scope[k].name}`).join(', ');
        return new Error(`Belirsiz sütun: ${displayRef(ref)} — birden fazla yerde var (${opts}); tablo adı veya takma adıyla belirtin.`);
      }

      function resolveColumn(ref, hint) {
        let hits = lookup(ref, 0, scope.length);
        // Adında nokta geçen başlıklar ('a.b') için: 'a' tablosu yoksa tüm adı dene.
        if (hits.length === 0 && ref.qualifier != null) {
          hits = lookup({ qualifier: null, name: `${ref.qualifier}.${ref.name}` }, 0, scope.length);
        }
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) throw ambiguousColumn(ref, hits);
        throw unknownColumn(ref, hint);
      }

      // ---------- 1. FROM + JOIN kapsamı ----------
      addSource(q.from, false);

      function extractEquiPairs(node) {
        if (node.type === 'and') return extractEquiPairs(node.left).concat(extractEquiPairs(node.right));
        if (node.type === 'cmp' && node.op === '=' && node.left.type === 'col' && node.right.type === 'col') {
          return [{ a: node.left, b: node.right }];
        }
        throw new Error(`JOIN ON yalnızca sütun eşitliklerini destekler (örn. ON a.id = b.musteri_id; birden çok anahtar için AND). Desteklenmeyen koşul: "${node.text}".`);
      }

      function orientPair(a, b, leftEnd, src) {
        const rLo = src.offset;
        const rHi = src.offset + src.width;
        const al = lookup(a, 0, leftEnd);
        const br = lookup(b, rLo, rHi);
        if (al.length === 1 && br.length === 1) return { l: al[0], r: br[0] };
        const bl = lookup(b, 0, leftEnd);
        const ar = lookup(a, rLo, rHi);
        if (bl.length === 1 && ar.length === 1) return { l: bl[0], r: ar[0] };
        // Teşhis: önce bilinmeyen, sonra belirsiz, en son "iki tarafı bağlamıyor".
        [a, b].forEach(ref => {
          if (lookup(ref, 0, rHi).length === 0) throw unknownColumn(ref);
        });
        if (al.length > 1) throw ambiguousColumn(a, al);
        if (bl.length > 1) throw ambiguousColumn(b, bl);
        if (ar.length > 1) throw ambiguousColumn(a, ar);
        if (br.length > 1) throw ambiguousColumn(b, br);
        throw new Error(`JOIN ON koşulu iki tarafı bağlamalı: "${displayRef(a)} = ${displayRef(b)}" — bir sütun önceki tablo(lar)dan, diğeri "${src.label}" tablosundan olmalı.`);
      }

      const joinPlans = q.joins.map(j => {
        const leftEnd = scope.length;
        const src = addSource(j.table, true);
        const li = [];
        const ri = [];
        extractEquiPairs(j.on).forEach(p => {
          const o = orientPair(p.a, p.b, leftEnd, src);
          li.push(o.l);
          ri.push(o.r - src.offset);
        });
        return { type: j.type, src: src, li: li, ri: ri, leftWidth: leftEnd };
      });

      const selectAliasKeys = new Set();
      q.items.forEach(it => {
        if (it.type === 'expr' && it.alias != null) selectAliasKeys.add(identKey(it.alias));
      });

      // ---------- Derleyici: ifade → closure ----------
      // ctx.mode 'row': kaynak bir satırdır. 'group': kaynak { first, rows } grubudur.

      function compileValue(node, ctx) {
        switch (node.type) {
          case 'lit': {
            const v = node.value;
            return () => v;
          }
          case 'col': {
            if (node.qualifier == null && ctx.aliasFns && lookup(node, 0, scope.length).length === 0) {
              const af = ctx.aliasFns.get(identKey(node.name));
              if (af) return af;
            }
            let hint = null;
            if (ctx.clause === 'WHERE' && node.qualifier == null && selectAliasKeys.has(identKey(node.name))) {
              hint = 'SELECT takma adları WHERE içinde kullanılamaz; ifadenin kendisini yazın';
            }
            const idx = resolveColumn(node, hint);
            if (ctx.mode === 'group') {
              if (!ctx.groupSet.has(idx)) {
                const d = displayRef(node);
                throw new Error(ctx.hasGroupBy
                  ? `"${d}" sütunu GROUP BY içinde olmalı veya bir toplama fonksiyonu (COUNT, SUM, AVG, MIN, MAX) içinde kullanılmalı.`
                  : `Toplama fonksiyonu içeren sorguda "${d}" sütunu tek başına kullanılamaz; GROUP BY ${d} ekleyin veya bir toplama fonksiyonu içine alın.`);
              }
              return g => g.first[idx];
            }
            return r => r[idx];
          }
          case 'agg': {
            if (ctx.mode !== 'group') {
              if (ctx.inAgg) throw new Error(`İç içe toplama fonksiyonları desteklenmiyor: ${node.text}`);
              if (ctx.clause === 'WHERE') {
                throw new Error(`Toplama fonksiyonu (${node.func}) WHERE içinde kullanılamaz; gruplanmış sonucu süzmek için HAVING kullanın.`);
              }
              throw new Error(`Toplama fonksiyonu (${node.func}) ${ctx.clause} içinde kullanılamaz.`);
            }
            const argFn = node.star ? null : compileValue(node.arg, { mode: 'row', clause: ctx.clause, inAgg: true });
            return makeAggregate(node, argFn);
          }
          default:
            throw new Error(`Bu konumda koşul değil değer bekleniyordu: "${node.text}".`);
        }
      }

      function compileBool(node, ctx) {
        switch (node.type) {
          case 'and': {
            const a = compileBool(node.left, ctx);
            const b = compileBool(node.right, ctx);
            return s => {
              const x = a(s);
              if (x === false) return false;
              const y = b(s);
              if (y === false) return false;
              return (x === null || y === null) ? null : true;
            };
          }
          case 'or': {
            const a = compileBool(node.left, ctx);
            const b = compileBool(node.right, ctx);
            return s => {
              const x = a(s);
              if (x === true) return true;
              const y = b(s);
              if (y === true) return true;
              return (x === null || y === null) ? null : false;
            };
          }
          case 'not': {
            const a = compileBool(node.expr, ctx);
            return s => {
              const x = a(s);
              return x === null ? null : !x;
            };
          }
          case 'isnull': {
            const f = compileValue(node.expr, ctx);
            return node.not ? (s => !isEmpty(f(s))) : (s => isEmpty(f(s)));
          }
          case 'cmp': {
            const op = node.op;
            assertComparableLiteral(node.left, op);
            assertComparableLiteral(node.right, op);
            const lf = compileValue(node.left, ctx);
            const rf = compileValue(node.right, ctx);
            // Üç değerli mantık: boş hücreyle karşılaştırma "bilinmiyor" (null) olur ve
            // WHERE/HAVING yalnızca kesin true satırları tutar (NOT de bunu tersine çeviremez).
            if (op === '=' || op === '!=') {
              const numeric = isNumLit(node.left) || isNumLit(node.right);
              const neg = op === '!=';
              return s => {
                const a = lf(s);
                const b = rf(s);
                if (isEmpty(a) || isEmpty(b)) return null;
                const eq = valuesEqual(a, b, numeric);
                return neg ? !eq : eq;
              };
            }
            const test = RANGE_TESTS[op];
            if (!test) throw new Error(`Desteklenmeyen operatör: ${op}`);
            return s => {
              const a = lf(s);
              const b = rf(s);
              if (isEmpty(a) || isEmpty(b)) return null;
              return test(orderCompare(a, b));
            };
          }
          case 'in': {
            node.list.forEach(it => assertComparableLiteral(it, 'IN'));
            const f = compileValue(node.expr, ctx);
            const neg = node.not;
            if (node.list.every(it => it.type === 'lit')) {
              const strSet = new Set();
              const numSet = new Set();
              node.list.forEach(it => {
                if (it.numeric) numSet.add(it.value);
                else strSet.add(foldCase(toText(it.value)));
              });
              return s => {
                const v = f(s);
                if (isEmpty(v)) return null;
                let hit = strSet.size > 0 && strSet.has(foldCase(toText(v)));
                if (!hit && numSet.size > 0) {
                  const n = toNumber(v);
                  hit = !Number.isNaN(n) && numSet.has(n);
                }
                return neg ? !hit : hit;
              };
            }
            const items = node.list.map(it => ({ fn: compileValue(it, ctx), numeric: isNumLit(it) }));
            return s => {
              const v = f(s);
              if (isEmpty(v)) return null;
              let unknown = false;
              for (let k = 0; k < items.length; k++) {
                const w = items[k].fn(s);
                if (isEmpty(w)) { unknown = true; continue; }
                if (valuesEqual(v, w, items[k].numeric)) return !neg;
              }
              return unknown ? null : neg;
            };
          }
          case 'like': {
            assertComparableLiteral(node.pattern, 'LIKE');
            const f = compileValue(node.expr, ctx);
            const neg = node.not;
            const esc = node.escape != null ? foldCase(node.escape) : null;
            if (node.pattern.type === 'lit') {
              const segs = compileLikePattern(toText(node.pattern.value), esc);
              return s => {
                const v = f(s);
                if (isEmpty(v)) return null;
                const hit = likeMatch(foldCase(toText(v)), segs);
                return neg ? !hit : hit;
              };
            }
            const pf = compileValue(node.pattern, ctx);
            return s => {
              const v = f(s);
              const p = pf(s);
              if (isEmpty(v) || isEmpty(p)) return null;
              const hit = likeMatch(foldCase(toText(v)), compileLikePattern(toText(p), esc));
              return neg ? !hit : hit;
            };
          }
          case 'between': {
            assertComparableLiteral(node.lo, 'BETWEEN');
            assertComparableLiteral(node.hi, 'BETWEEN');
            const f = compileValue(node.expr, ctx);
            const lo = compileValue(node.lo, ctx);
            const hi = compileValue(node.hi, ctx);
            const neg = node.not;
            return s => {
              const v = f(s);
              const a = lo(s);
              const b = hi(s);
              if (isEmpty(v) || isEmpty(a) || isEmpty(b)) return null;
              const hit = orderCompare(v, a) >= 0 && orderCompare(v, b) <= 0;
              return neg ? !hit : hit;
            };
          }
          default:
            throw new Error(`Koşul bekleniyordu (örn. sutun = 'değer'): "${node.text}".`);
        }
      }

      // ---------- 2. WHERE ----------
      const whereFn = q.where ? compileBool(q.where, { mode: 'row', clause: 'WHERE' }) : null;

      // ---------- 3. Gruplama kararı ----------
      const isAgg = q.groupBy.length > 0 || !!q.having ||
        q.items.some(it => it.type === 'expr' && containsAgg(it.expr)) ||
        q.orderBy.some(o => containsAgg(o.expr));

      function resolveGroupItem(node) {
        if (containsAgg(node)) throw new Error(`GROUP BY içinde toplama fonksiyonu kullanılamaz: ${node.text}`);
        if (node.type === 'lit') {
          if (node.numeric && Number.isInteger(node.value)) {
            const it = q.items[node.value - 1];
            if (!it) throw new Error(`GROUP BY sıra numarası geçersiz: ${node.value} (1–${q.items.length} arası olmalı).`);
            if (it.type !== 'expr' || it.expr.type !== 'col') {
              throw new Error(`GROUP BY ${node.value}: SELECT listesindeki ${node.value}. öğe bir sütun olmalı.`);
            }
            return resolveColumn(it.expr);
          }
          throw new Error(`GROUP BY içinde sabit değer kullanılamaz: ${node.text}`);
        }
        if (node.type !== 'col') throw new Error(`GROUP BY yalnızca sütun adlarını destekler: ${node.text}`);
        if (node.qualifier == null && lookup(node, 0, scope.length).length === 0) {
          const key = identKey(node.name);
          const it = q.items.find(x => x.type === 'expr' && x.alias != null && identKey(x.alias) === key);
          if (it) {
            if (it.expr.type !== 'col') {
              throw new Error(`GROUP BY "${node.name}": bu takma ad bir sütuna değil bir ifadeye (${it.text}) ait; GROUP BY yalnızca sütunları destekler.`);
            }
            return resolveColumn(it.expr);
          }
        }
        return resolveColumn(node);
      }

      const groupIdx = q.groupBy.map(resolveGroupItem);
      const groupCtx = { mode: 'group', clause: 'SELECT', groupSet: new Set(groupIdx), hasGroupBy: groupIdx.length > 0 };

      // ---------- 4. SELECT listesi ----------
      const outCols = []; // { name, fn, srcIdx, alias }
      q.items.forEach(it => {
        if (it.type === 'star') {
          if (isAgg) throw new Error('Gruplama/toplama içeren sorguda SELECT * kullanılamaz; sütunları tek tek yazın.');
          let lo = 0;
          let hi = scope.length;
          if (it.table != null) {
            const key = identKey(it.table);
            let cands = sources.filter(s => s.qual === key);
            if (cands.length === 0) cands = sources.filter(s => s.quals.has(key));
            if (cands.length === 0) throw new Error(`Bilinmeyen tablo veya takma ad: ${it.table}`);
            if (cands.length > 1) throw new Error(`Belirsiz tablo adı: ${it.table}; takma adı kullanın.`);
            lo = cands[0].offset;
            hi = lo + cands[0].width;
          }
          for (let k = lo; k < hi; k++) {
            const idx = k;
            outCols.push({ name: scope[k].name, fn: r => r[idx], srcIdx: idx, alias: null });
          }
          return;
        }
        const ctx = isAgg ? Object.assign({}, groupCtx, { clause: 'SELECT' }) : { mode: 'row', clause: 'SELECT' };
        const fn = compileValue(it.expr, ctx);
        const isCol = it.expr.type === 'col';
        const name = it.alias != null ? it.alias : (isCol ? it.expr.name : it.text);
        outCols.push({ name: name, fn: fn, srcIdx: isCol ? resolveColumn(it.expr) : -1, alias: it.alias });
      });

      const aliasFns = new Map();
      outCols.forEach(c => {
        if (c.alias != null && !aliasFns.has(identKey(c.alias))) aliasFns.set(identKey(c.alias), c.fn);
      });

      // ---------- 5. HAVING ----------
      const havingFn = q.having
        ? compileBool(q.having, Object.assign({}, groupCtx, { clause: 'HAVING', aliasFns: aliasFns }))
        : null;

      // ---------- 6. ORDER BY ----------
      // Öncelik: sıra numarası → sonuç sütunu adı/takma adı → kaynak ifade. Eski sürüm
      // seçilmemiş bir sütuna göre sıralamayı sessizce atlıyordu.
      const outKeys = outCols.map(c => identKey(c.name));
      const orderPlans = q.orderBy.map(o => {
        const e = o.expr;
        if (e.type === 'lit') {
          if (e.numeric && Number.isInteger(e.value)) {
            if (e.value < 1 || e.value > outCols.length) {
              throw new Error(`ORDER BY sıra numarası geçersiz: ${e.value} (1–${outCols.length} arası olmalı).`);
            }
            return { desc: o.desc, out: e.value - 1 };
          }
          throw new Error(`ORDER BY içinde sabit değer kullanılamaz: ${e.text}`);
        }
        if (e.type === 'col' && e.qualifier == null) {
          const key = identKey(e.name);
          const hits = [];
          outKeys.forEach((k, idx) => { if (k === key) hits.push(idx); });
          if (hits.length > 0) {
            const distinctSources = new Set(hits.map(h => (outCols[h].srcIdx >= 0 ? 's' + outCols[h].srcIdx : 'o' + h)));
            if (distinctSources.size > 1) {
              throw new Error(`ORDER BY "${e.name}" belirsiz: sonuçta bu adla birden fazla sütun var; tablo adıyla (örn. t.${e.name}) veya sıra numarasıyla belirtin.`);
            }
            return { desc: o.desc, out: hits[0] };
          }
        }
        if (q.distinct) {
          throw new Error('SELECT DISTINCT kullanıldığında ORDER BY yalnızca seçilen sütunlara (ad, takma ad veya sıra numarası) göre yapılabilir.');
        }
        const ctx = isAgg
          ? Object.assign({}, groupCtx, { clause: 'ORDER BY', aliasFns: aliasFns })
          : { mode: 'row', clause: 'ORDER BY' };
        return { desc: o.desc, fn: compileValue(e, ctx) };
      });

      // ================= Yürütme =================
      function baseRows(s) {
        const w = s.width;
        const rows = s.table.rows;
        const out = new Array(rows.length);
        for (let k = 0; k < rows.length; k++) {
          const r = rows[k];
          if (Array.isArray(r) && r.length === w) {
            out[k] = r;
          } else {
            // Düzensiz (ragged) satırları başlık genişliğine tamamla; aksi hâlde JOIN'de
            // concat sonrası sağ tablonun sütunları sola kayar.
            const x = new Array(w);
            for (let c = 0; c < w; c++) x[c] = r && r[c] !== undefined ? r[c] : null;
            out[k] = x;
          }
        }
        return out;
      }

      let rows = baseRows(sources[0]);
      joinPlans.forEach(jp => {
        rows = hashJoin(rows, jp.leftWidth, baseRows(jp.src), jp.src.width, jp.type, jp.li, jp.ri);
      });

      if (whereFn) rows = rows.filter(r => whereFn(r) === true);

      let outRows;
      let srcs;
      if (isAgg) {
        let groups;
        if (groupIdx.length === 0) {
          // GROUP BY'sız toplama: tüm satırlar tek grup → her zaman tek satır (boş tabloda da).
          groups = [{ first: rows.length > 0 ? rows[0] : null, rows: rows }];
        } else {
          const map = new Map();
          const single = groupIdx.length === 1 ? groupIdx[0] : -1;
          for (let k = 0; k < rows.length; k++) {
            const r = rows[k];
            let key;
            if (single >= 0) {
              key = groupKeyPart(r[single]);
            } else {
              key = '';
              for (let c = 0; c < groupIdx.length; c++) key = appendKeyPart(key, groupKeyPart(r[groupIdx[c]]));
            }
            let g = map.get(key);
            if (!g) {
              g = { first: r, rows: [] };
              map.set(key, g);
            }
            g.rows.push(r);
          }
          groups = Array.from(map.values());
        }
        if (havingFn) groups = groups.filter(g => havingFn(g) === true);
        outRows = groups.map(g => outCols.map(c => c.fn(g)));
        srcs = groups;
      } else {
        const w = outCols.length;
        outRows = new Array(rows.length);
        for (let k = 0; k < rows.length; k++) {
          const r = rows[k];
          const o = new Array(w);
          for (let c = 0; c < w; c++) o[c] = outCols[c].fn(r);
          outRows[k] = o;
        }
        srcs = rows;
      }

      if (q.distinct) {
        const seen = new Set();
        const keep = [];
        for (let k = 0; k < outRows.length; k++) {
          let key = '';
          const o = outRows[k];
          for (let c = 0; c < o.length; c++) key = appendKeyPart(key, groupKeyPart(o[c]));
          if (!seen.has(key)) {
            seen.add(key);
            keep.push(k);
          }
        }
        outRows = keep.map(k => outRows[k]);
        srcs = keep.map(k => srcs[k]);
      }

      if (orderPlans.length > 0) {
        const n = outRows.length;
        // Anahtarlar bir kez hesaplanır; karşılaştırıcı içinde tekrar ayrıştırma yapılmaz.
        const cols = orderPlans.map(p => {
          const arr = new Array(n);
          for (let k = 0; k < n; k++) arr[k] = sortKey(p.fn ? p.fn(srcs[k]) : outRows[k][p.out]);
          const c = buildSortColumn(arr);
          c.sign = p.desc ? -1 : 1;
          return c;
        });
        const idx = new Array(n);
        for (let k = 0; k < n; k++) idx[k] = k;
        idx.sort((a, b) => {
          for (let j = 0; j < cols.length; j++) {
            const col = cols[j];
            const ka = col.kind[a];
            const kb = col.kind[b];
            if (ka !== kb) return (ka - kb) * col.sign;
            if (ka !== 0) {
              const va = col.val[a];
              const vb = col.val[b];
              if (va !== vb) return (va < vb ? -1 : 1) * col.sign;
            }
          }
          return a - b; // kararlı ve deterministik
        });
        outRows = idx.map(k => outRows[k]);
      }

      const off = q.offset || 0;
      if (off > 0 || q.limit !== null) {
        outRows = outRows.slice(off, q.limit !== null ? off + q.limit : undefined);
      }

      return {
        headers: outCols.map(c => c.name),
        rows: outRows,
        rowCount: outRows.length,
        durationMs: Date.now() - t0
      };
    }

    /**
     * Yapılandırılmış plan nesnesiyle sorgu çalıştırır (geriye uyumlu API).
     *
     * @param {Object} queryPlan
     * @param {string} queryPlan.from - Ana tablo adı
     * @param {Array<Object>} [queryPlan.joins] - JOIN yapılandırmaları ({ type, table, on: { leftCol, rightCol } })
     * @param {Array<string>} [queryPlan.select] - Seçilecek sütunlar / fonksiyonlar (Örn: ["id", "COUNT(*)", "SUM(tutar)"])
     * @param {Array<Object>} [queryPlan.where] - Filtreler ({ column, op, value }; AND ile birleşir)
     * @param {Array<string>} [queryPlan.groupBy] - Gruplama sütunları
     * @param {Array<Object>} [queryPlan.having] - Group by sonrası filtreler ({ column: 'COUNT(*)', op: '>', value: 1 })
     * @param {Array<{ column: string, desc: boolean }>} [queryPlan.orderBy] - Sıralama
     * @param {number} [queryPlan.limit] - Limit
     * @returns {{ headers: string[], rows: Array<Array<any>>, rowCount: number, durationMs: number }}
     */
    function executePlan(queryPlan) {
      return runQuery(planToQuery(queryPlan));
    }

    /**
     * SQL metnini ayrıştırıp çalıştırır. Desteklenmeyen her yapı açık bir Türkçe hata fırlatır.
     */
    function executeSql(sql) {
      if (!sql || typeof sql !== 'string' || !sql.trim()) {
        throw new Error('Geçerli bir SQL sorgusu gereklidir.');
      }
      return runQuery(createParser(sql).parseQuery());
    }

    return {
      registerTable: registerTable,
      getTable: getTable,
      listTables: listTables,
      dropTable: dropTable,
      executePlan: executePlan,
      executeSql: executeSql
    };
  }

  // =====================================================================
  // 9. SQL üretim yardımcıları
  // =====================================================================

  const PLAIN_IDENT_RE = /^[\p{L}_$][\p{L}\p{M}\p{N}_$]*$/u;

  /**
   * Tanımlayıcıyı gerekiyorsa çift tırnakla yazar. 'Ad Soyad', 'e-posta' veya 'Not' gibi
   * başlıklar tırnaksız yazılırsa ayrıştırılamaz (ya da anahtar kelimeyle çakışır).
   */
  function quoteIdentifier(name) {
    const s = String(name);
    const reserved = /^[A-Za-z]+$/.test(s) && HARD_RESERVED.has(s.toUpperCase());
    if (PLAIN_IDENT_RE.test(s) && !reserved) return s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  /** Metin sabiti: tek tırnak iki katına çıkarılır ("O'Brien" sorguyu bozmasın/değiştirmesin). */
  function quoteLiteral(v) {
    return "'" + String(v === null || v === undefined ? '' : v).replace(/'/g, "''") + "'";
  }

  /**
   * Görsel Sorgu Yapılandırıcıdan SQL üretir
   */
  function buildSqlString(config) {
    if (!config || !config.fromTable) {
      throw new Error('buildSqlString "fromTable" gerektirir.');
    }

    const selectCols = Array.isArray(config.columns) && config.columns.length > 0
      ? config.columns.join(', ')
      : '*';

    let sql = `SELECT ${selectCols} FROM ${config.fromTable}`;

    if (Array.isArray(config.joins)) {
      config.joins.forEach(j => {
        sql += ` ${j.type || 'LEFT JOIN'} ${j.table} ON ${j.onLeft} = ${j.onRight}`;
      });
    }

    if (Array.isArray(config.where) && config.where.length > 0) {
      const conds = config.where.map(w => {
        const op = String(w.op || '=').toUpperCase().replace(/\s+/g, ' ').trim();
        if (op === 'IS NULL' || op === 'IS NOT NULL') return `${w.column} ${op}`;
        if (op === 'IN' || op === 'NOT IN') {
          const list = Array.isArray(w.value) ? w.value : String(w.value).split(',').map(s => s.trim());
          return `${w.column} ${op} (${list.map(quoteLiteral).join(', ')})`;
        }
        return `${w.column} ${w.op} ${quoteLiteral(w.value)}`;
      }).join(' AND ');
      sql += ` WHERE ${conds}`;
    }

    if (Array.isArray(config.groupBy) && config.groupBy.length > 0) {
      sql += ` GROUP BY ${config.groupBy.join(', ')}`;
    }

    if (Array.isArray(config.orderBy) && config.orderBy.length > 0) {
      const orders = config.orderBy.map(o => `${o.column} ${o.desc ? 'DESC' : 'ASC'}`).join(', ');
      sql += ` ORDER BY ${orders}`;
    }

    if (config.limit) {
      sql += ` LIMIT ${config.limit}`;
    }

    return sql;
  }

  /**
   * Hazır SQL Şablonları (Template Library)
   * Adlar quoteIdentifier ile yazılır: boşluk/tire içeren başlıklarda da çalışır.
   */
  const templates = {
    findDuplicates: function (tableName, keyCol) {
      const t = quoteIdentifier(tableName);
      const k = quoteIdentifier(keyCol);
      return `SELECT ${k}, COUNT(*) AS tekrar_sayisi FROM ${t} GROUP BY ${k} HAVING COUNT(*) > 1`;
    },
    leftAntiJoin: function (tableA, tableB, joinKey) {
      const a = quoteIdentifier(tableA);
      const b = quoteIdentifier(tableB);
      const k = quoteIdentifier(joinKey);
      return `SELECT * FROM ${a} ANTI JOIN ${b} ON ${a}.${k} = ${b}.${k}`;
    },
    aggregationSummary: function (tableName, groupCol, sumCol) {
      const t = quoteIdentifier(tableName);
      const g = quoteIdentifier(groupCol);
      const s = quoteIdentifier(sumCol);
      return `SELECT ${g}, COUNT(*) AS adet, SUM(${s}) AS toplam FROM ${t} GROUP BY ${g} ORDER BY toplam DESC`;
    }
  };

  /**
   * Tablodan SQL CREATE TABLE DDL üretir
   */
  function generateCreateTable(tableName, headers, rows) {
    const lines = [];
    headers.forEach((h, idx) => {
      // Tip tahmini (katı sayı: '2024-01-01' parseFloat ile 2024 olup NUMERIC sanılmasın)
      let isNum = true;
      let sampleCount = 0;
      for (let r = 0; r < Math.min(rows.length, 20); r++) {
        const val = rows[r] ? rows[r][idx] : null;
        if (!isEmpty(val)) {
          sampleCount++;
          if (Number.isNaN(toNumber(val))) {
            isNum = false;
            break;
          }
        }
      }
      const colType = (sampleCount > 0 && isNum) ? 'NUMERIC' : 'VARCHAR(255)';
      const colName = String(h).replace(/[^\w]/g, '_');
      lines.push(`    ${colName} ${colType}`);
    });

    return `CREATE TABLE ${tableName} (\n${lines.join(',\n')}\n);`;
  }

  return {
    createDatabase: createDatabase,
    buildSqlString: buildSqlString,
    templates: templates,
    generateCreateTable: generateCreateTable,
    quoteIdentifier: quoteIdentifier
  };
}));
