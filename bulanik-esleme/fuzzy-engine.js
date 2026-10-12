/**
 * Masko — Bulanık Çapraz Eşleme & Mutabakat Motoru (fuzzy-engine.js)
 *
 * %100 İstemci Tarafı (Client-Side), Sıfır Ağ İsteği.
 * Excel'in VLOOKUP / DÜŞEYARA formülünün tıkandığı şirket unvanları,
 * cari hesaplar, kişi isimleri ve mutabakat tablolarını akıllı
 * benzerlik algoritmalarıyla eşleştirir.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FuzzyEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Türkçe karakter duyarlı küçük harfe çevirme.
   */
  function toTurkishLower(str) {
    if (!str) return '';
    return String(str)
      .replace(/İ/g, 'i')
      .replace(/I/g, 'ı')
      .toLowerCase();
  }

  /**
   * Türkçe karakterleri ASCII benzerlerine dönüştürür (katlama/folding).
   */
  function foldTurkishAscii(str) {
    if (!str) return '';
    return toTurkishLower(str)
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ı/g, 'i')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c');
  }

  // Yalnızca hukuki şekil ve bağlaç gürültüsü ayıklanır. Sektör kelimeleri
  // (enerji, tekstil, holding, inşaat, gıda...) ayırt edicidir: silinirlerse
  // "Zorlu Enerji A.Ş." ile "Zorlu Tekstil Ltd. Şti." ikisi de "zorlu"ya iner
  // ve farklı şirketler %100 "tam eşleşme" olarak raporlanır.
  const BUSINESS_STOP_WORDS = new Set([
    'as', 'anonim', 'sirketi', 'sirket',
    'ltd', 'sti', 'limited',
    'san', 'tic', 'sanayi', 'ticaret',
    've', 'ile'
  ]);

  /**
   * Kurumsal unvan veya kişi adını mutabakat için optimize ederek normalleştirir.
   * - Noktalama işaretlerini ve kısaltmaları standartlaştırır
   * - Şirket türü kısaltmalarını ayıklar
   * - Fazla boşlukları temizler
   */
  function normalizeBusinessKey(str, options = {}) {
    if (str == null || str === '') return '';
    let s = foldTurkishAscii(String(str));

    // Türkçe dışı aksanlar (é, ñ, ä) taban harfe iner; Kiril/Arap gibi alfabeler
    // ise korunur. Eskiden [a-z0-9] dışı her şey siliniyordu: Latin dışı iki
    // unvan da boş anahtara iner ve birbirleriyle %100 "eşleşirdi".
    s = s.normalize('NFD').replace(/\p{M}/gu, '');

    // Noktalı kurumsal kısaltmaları tekilleştir (sözcük sınırları ile)
    s = s.replace(/\b(a\s*\.?\s*s\s*\.?|as)\b/g, ' as ');
    s = s.replace(/\b(ltd\s*\.?\s*s\s*t\s*i\s*\.?|ltd\s*sti)\b/g, ' ltd ');
    s = s.replace(/\b(san\s*\.?\s*v\s*e\s*tic\s*\.?|san\s*tic)\b/g, ' san tic ');

    // Noktalama ve özel karakterleri temizle (her alfabenin harf/rakamı kalır)
    s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');

    const tokens = s.split(/\s+/).filter(Boolean);
    const stripStopWords = options.stripStopWords !== false;

    const filtered = tokens.filter(t => {
      if (stripStopWords && BUSINESS_STOP_WORDS.has(t)) return false;
      return true;
    });

    // Eğer tüm kelimeler stop word idiyse orijinal tokenları koru (örn. sadece "A.Ş." yazılmışsa)
    const resultTokens = filtered.length > 0 ? filtered : tokens;
    return resultTokens.join(' ').trim();
  }

  // Levenshtein satırları ve Jaro eşleşme bayrakları için yeniden kullanılan
  // tamponlar: 1.000×1.000 taramada her çağrıda yeni dizi ayırmak süreyi çöp
  // toplayıcıya harcatıyordu. Motor eşzamanlı çalıştığı için paylaşım güvenlidir.
  let levRow0 = new Uint32Array(64);
  let levRow1 = new Uint32Array(64);
  let jwFlags1 = new Uint8Array(64);
  let jwFlags2 = new Uint8Array(64);

  /**
   * Levenshtein Mesafesi hesaplar.
   */
  function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const n = b.length;
    if (levRow0.length < n + 1) {
      levRow0 = new Uint32Array((n + 1) * 2);
      levRow1 = new Uint32Array((n + 1) * 2);
    }
    let v0 = levRow0;
    let v1 = levRow1;

    for (let i = 0; i <= n; i++) v0[i] = i;

    for (let i = 0; i < a.length; i++) {
      v1[0] = i + 1;
      const ca = a.charCodeAt(i);
      for (let j = 0; j < n; j++) {
        const del = v1[j] + 1;
        const ins = v0[j + 1] + 1;
        const sub = v0[j] + (ca === b.charCodeAt(j) ? 0 : 1);
        v1[j + 1] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
      }
      // Kopyalamak yerine satırları takas et; son hesaplanan satır v0'da kalır.
      const tmp = v0; v0 = v1; v1 = tmp;
    }

    return v0[n];
  }

  /**
   * Normalize Levenshtein Benzerlik Oranı (0.0 - 1.0).
   */
  function levenshteinRatio(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    const dist = levenshteinDistance(a, b);
    return Math.max(0, 1.0 - dist / maxLen);
  }

  /**
   * Jaro-Winkler Benzerliği (0.0 - 1.0).
   * Özellikle başlangıç harfleri benzer olan şirket unvanları için yüksek hassasiyet verir.
   */
  function jaroWinkler(s1, s2) {
    if (s1 === s2) return 1.0;
    const len1 = s1.length;
    const len2 = s2.length;
    if (len1 === 0 || len2 === 0) return 0.0;

    if (jwFlags1.length < len1) jwFlags1 = new Uint8Array(len1 * 2);
    if (jwFlags2.length < len2) jwFlags2 = new Uint8Array(len2 * 2);
    const s1Matches = jwFlags1;
    const s2Matches = jwFlags2;
    s1Matches.fill(0, 0, len1);
    s2Matches.fill(0, 0, len2);

    const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;

    let matches = 0;
    for (let i = 0; i < len1; i++) {
      const start = Math.max(0, i - matchDistance);
      const end = Math.min(i + matchDistance + 1, len2);
      const c = s1.charCodeAt(i);
      for (let j = start; j < end; j++) {
        if (!s2Matches[j] && c === s2.charCodeAt(j)) {
          s1Matches[i] = 1;
          s2Matches[j] = 1;
          matches++;
          break;
        }
      }
    }

    if (matches === 0) return 0.0;

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < len1; i++) {
      if (s1Matches[i]) {
        while (!s2Matches[k]) k++;
        if (s1.charCodeAt(i) !== s2.charCodeAt(k)) transpositions++;
        k++;
      }
    }

    const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;

    // Winkler prefix ölçekleme (maks 4 karakter prefix)
    const prefix = commonPrefix4(s1, s2);
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  function commonPrefix4(s1, s2) {
    const lim = Math.min(4, s1.length, s2.length);
    let p = 0;
    while (p < lim && s1.charCodeAt(p) === s2.charCodeAt(p)) p++;
    return p;
  }

  /**
   * Token-Sort / Token-Set Benzerliği.
   * Kelimelerin sırası değişse bile (örn. "Ahmet Yılmaz İnşaat" vs "İnşaat Yılmaz Ahmet")
   * %100 uyuşma yakalar.
   */
  function tokenSortRatio(s1, s2) {
    const t1 = s1.split(/\s+/).filter(Boolean).sort().join(' ');
    const t2 = s2.split(/\s+/).filter(Boolean).sort().join(' ');
    return Math.max(levenshteinRatio(t1, t2), jaroWinkler(t1, t2));
  }

  // --- Ön hazırlık ve budama (pruning) ---
  //
  // Normalize anahtar bir kez hesaplanır; her aday çifti için pahalı metrikler
  // (2× Jaro-Winkler + 2× Levenshtein) çalışmadan önce karakter histogramından
  // KAYIPSIZ bir üst sınır çıkarılır:
  //   c = ortak karakter çoklu-kümesi (histogram kesişimi)
  //   Levenshtein oranı ≤ c / max(n, m)            (her düzenleme en fazla bir eşleşme kaybettirir)
  //   Jaro ≤ (c/n + c/m + 1) / 3                    (eşleşme sayısı ≤ c, transpozisyon ≥ 0)
  //   JW   ≤ Jaro_üst + p·0,1·(1 − Jaro_üst)         (p: gerçek ortak önek, ≤ 4)
  // Token sıralı varyant aynı karakter çoklu-kümesini ve uzunluğu taşıdığından
  // aynı sınır ona da geçerlidir. Sınır eşiğin/mevcut en iyinin altındaysa çift
  // atlanır; sonuçlar kaba kuvvet taramasıyla birebir aynıdır. Uzunluk farkı
  // erken çıkışı da bu sınırın özel hâlidir (c ≤ min(n, m)).
  const HIST_SIZE = 64;
  const SCORE_EPS = 1e-9;

  // a-z → 0-25, 0-9 → 26-35, boşluk → 36, diğer alfabeler 37-63'e katlanır.
  // Katlama çakışması kesişimi yalnızca büyütür (min(a1+a2, b1+b2) ≥
  // min(a1,b1) + min(a2,b2)), yani üst sınır geçerli kalır.
  function charBucket(code) {
    if (code >= 97 && code <= 122) return code - 97;
    if (code >= 48 && code <= 57) return code - 22;
    if (code === 32) return 36;
    return 37 + (code % 27);
  }

  function prepareKey(raw) {
    const str = raw == null ? '' : String(raw).trim();
    const norm = str ? normalizeBusinessKey(str) : '';
    const sorted = norm ? norm.split(' ').sort().join(' ') : '';
    let hist = null;
    let nz = null;
    if (norm) {
      hist = new Uint16Array(HIST_SIZE);
      for (let i = 0; i < norm.length; i++) hist[charBucket(norm.charCodeAt(i))]++;
      nz = [];
      for (let k = 0; k < HIST_SIZE; k++) if (hist[k]) nz.push(k);
    }
    return { str, lower: toTurkishLower(str), norm, sorted, hist, nz };
  }

  /**
   * Hazırlanmış iki anahtarın benzerliği. `floor` verildiğinde sözleşme şudur:
   * gerçek skor ≥ floor ise birebir doğru değer, değilse floor'un altında bir
   * değer döner (budanan çiftler için tam hesap yapılmaz).
   */
  function scorePrepared(a, b, floor) {
    if (!a.str || !b.str) return 0.0;
    if (a.str === b.str || a.lower === b.lower) return 1.0;
    // Harf/rakam içermeyen anahtarlar ("-", "???") karşılaştırılamaz; eskiden
    // boş–boş kıyası Levenshtein'da 1.0 veriyordu.
    if (!a.norm || !b.norm) return 0.0;
    if (a.norm === b.norm) return 1.0;

    const n = a.norm.length;
    const m = b.norm.length;
    const ha = a.hist;
    const hb = b.hist;
    const nz = a.nz;
    let common = 0;
    for (let k = 0; k < nz.length; k++) {
      const x = ha[nz[k]];
      const y = hb[nz[k]];
      common += x < y ? x : y;
    }
    if (common === 0) return 0.0;

    const levUpper = common / (n > m ? n : m);
    const jaroUpper = Math.min(1, (common / n + common / m + 1) / 3);
    const prefix = Math.max(commonPrefix4(a.norm, b.norm), commonPrefix4(a.sorted, b.sorted));
    const jwUpper = jaroUpper + prefix * 0.1 * (1 - jaroUpper);
    const upper = levUpper > jwUpper ? levUpper : jwUpper;
    if (floor && upper + SCORE_EPS < floor) return upper;

    const jwNorm = jaroWinkler(a.norm, b.norm);
    const sameOrder = a.sorted === a.norm && b.sorted === b.norm;
    const jwSorted = sameOrder ? jwNorm : jaroWinkler(a.sorted, b.sorted);
    let best = jwNorm > jwSorted ? jwNorm : jwSorted;

    // Levenshtein en pahalı metriktir; sınırı mevcut en iyiyi ya da eşiği
    // geçemiyorsa sonucu değiştiremez.
    const need = floor && floor > best ? floor : best;
    if (levUpper + SCORE_EPS >= need) {
      const levNorm = levenshteinRatio(a.norm, b.norm);
      const levSorted = sameOrder ? levNorm : levenshteinRatio(a.sorted, b.sorted);
      if (levNorm > best) best = levNorm;
      if (levSorted > best) best = levSorted;
    }
    return best;
  }

  /**
   * Kapsamlı benzerlik skoru hesaplar.
   * En iyi eşleşen algoritma sonucunu (0.0 - 1.0) döner.
   */
  function compareKeys(rawA, rawB) {
    return scorePrepared(prepareKey(rawA), prepareKey(rawB), 0);
  }

  /**
   * Sayısal tutar karşılaştırması yapar.
   * String içindeki para birimi ve formatları temizler (örn. "1.250,50 TL" -> 1250.50).
   *
   * Kurallar (belirsiz biçim tahmin edilmez, null döner):
   * - Hem "." hem "," varsa sonda olan ondalık ayırıcıdır.
   * - Yalnız "," varsa ondalıktır; "1,250" / "1,250,000" gibi 3'lü gruplar binliktir.
   * - Yalnız "." varsa "1.250" / "1.250.000" gibi 3'lü gruplar binliktir, diğerleri ondalık.
   * - Parantez "(1.250,00)" veya sondaki eksi "1.250,00-" muhasebe gösteriminde negatiftir.
   */
  function parseAmount(val) {
    if (val == null) return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    let s = String(val).trim();
    if (!s) return null;

    let negative = false;
    if (/^\(.*\)$/.test(s)) {
      negative = true;
      s = s.slice(1, -1);
    }
    s = s
      .replace(/\b(?:TL|TRY|YTL|USD|EUR|GBP)\b/gi, '')
      .replace(/[₺$€£\s  ]/g, '')
      .replace(/−/g, '-');
    if (s.endsWith('-')) {
      negative = true;
      s = s.slice(0, -1);
    }
    if (s.startsWith('-')) {
      negative = true;
      s = s.slice(1);
    } else if (s.startsWith('+')) {
      s = s.slice(1);
    }
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

    const hasDot = s.includes('.');
    const hasComma = s.includes(',');
    if (hasDot && hasComma) {
      const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
      const parts = s.split(dec);
      if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return null;
      const grouped = dec === ',' ? /^\d{1,3}(\.\d{3})*$/ : /^\d{1,3}(,\d{3})*$/;
      if (!grouped.test(parts[0])) return null;
      s = parts[0].replace(/[.,]/g, '') + '.' + parts[1];
    } else if (hasComma) {
      // "0,250" binlik olamaz (baştaki grup 0 ile başlamaz), ondalıktır.
      if (/^[1-9]\d{0,2}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
      else if (/^\d*,\d+$/.test(s)) s = s.replace(',', '.');
      else return null;
    } else if (hasDot) {
      if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
      else if (!/^\d*\.\d+$/.test(s)) return null;
    }

    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return negative ? -n : n;
  }

  /**
   * Mutabakat durum makinesi: hazırlık bir kez yapılır, A satırları tek tek
   * işlenir. Eşzamanlı ve parça parça (UI'yı dondurmadan) çalıştırıcılar aynı
   * çekirdeği kullandığı için sonuçlar birebir aynıdır.
   */
  function createReconciler(rowsA, rowsB, options = {}) {
    const keyA = options.keyA;
    const keyB = options.keyB;
    const amountA = options.amountA;
    const amountB = options.amountB;
    const amountTol = options.amountTolerance != null ? Number(options.amountTolerance) : null;
    const threshold = options.threshold != null ? Number(options.threshold) : 0.80;

    if (!keyA || !keyB) {
      throw new Error('Eşleme için Tablo A ve Tablo B anahtar sütunları seçilmelidir.');
    }

    const exactMatches = [];
    const fuzzyMatches = [];
    const unmatchedA = [];
    const nB = rowsB.length;
    const matchedB = new Uint8Array(nB);

    // Ön-hesaplama: Tablo B anahtarları ve normalizasyonları (satır başına bir kez)
    const bPrepared = rowsB.map((row, idx) => ({
      index: idx,
      row,
      rawKey: row[keyB],
      key: prepareKey(row[keyB]),
      amount: amountB ? parseAmount(row[amountB]) : null
    }));

    // Tam eşleşme haritaları anahtar başına TÜM B satırlarını tutar; eskiden
    // yalnız ilki tutuluyordu ve o satır eşleşince aynı anahtarlı kopyalar
    // bulanık taramaya düşüyordu.
    const bLookupExact = new Map();
    const bLookupNorm = new Map();
    const pushTo = (map, k, idx) => {
      const list = map.get(k);
      if (list) list.push(idx);
      else map.set(k, [idx]);
    };
    bPrepared.forEach(item => {
      if (item.key.str) pushTo(bLookupExact, item.key.lower, item.index);
      if (item.key.norm) pushTo(bLookupNorm, item.key.norm, item.index);
    });

    function amountDiffOf(amtA, cand) {
      if (amountTol == null || amtA == null || cand.amount == null) return { ok: true, diff: null };
      const diff = Math.abs(amtA - cand.amount);
      return { ok: diff <= amountTol, diff };
    }

    // Aynı anahtarlı adaylardan boşta olan ve tutarı en yakın olanı seçer
    // (eşitlikte ilk satır) — deterministik.
    function pickExact(list, amtA) {
      if (!list) return null;
      let chosen = null;
      for (const idx of list) {
        if (matchedB[idx]) continue;
        const cand = bPrepared[idx];
        const amt = amountDiffOf(amtA, cand);
        if (!amt.ok) continue;
        if (!chosen || (amt.diff != null && chosen.amountDiff != null && amt.diff < chosen.amountDiff)) {
          chosen = { ...cand, amountDiff: amt.diff };
        }
        if (amt.diff == null) break;
      }
      return chosen;
    }

    function processRow(i) {
      const rowA = rowsA[i];
      const rawValA = rowA[keyA];
      const aKey = prepareKey(rawValA);
      const amtA = amountA ? parseAmount(rowA[amountA]) : null;

      if (!aKey.str) {
        unmatchedA.push({ rowA, keyA: rawValA, reason: 'Boş Anahtar Değeri' });
        return;
      }

      let bestMatch = null;
      let bestScore = 0;

      // 1. Doğrudan exact lookup kontrolü
      const rawHit = pickExact(bLookupExact.get(aKey.lower), amtA);
      const exactHit = rawHit || (aKey.norm ? pickExact(bLookupNorm.get(aKey.norm), amtA) : null);
      if (exactHit) {
        bestMatch = { ...exactHit, isExactRaw: !!rawHit, isExactNorm: !rawHit };
        bestScore = 1.0;
      }

      // 2. Bulanık eşleşme taraması (Eğer tam eşleşmediyse)
      if (!bestMatch && aKey.norm) {
        for (let j = 0; j < nB; j++) {
          if (matchedB[j]) continue;
          const candidate = bPrepared[j];

          // Tutar toleransı kontrolü
          let amtDiff = null;
          if (amountTol != null && amtA != null && candidate.amount != null) {
            amtDiff = Math.abs(amtA - candidate.amount);
            if (amtDiff > amountTol) continue; // Tutar tutmuyorsa atla
          }

          const floor = bestScore > threshold ? bestScore : threshold;
          const score = scorePrepared(aKey, candidate.key, floor);
          if (score > bestScore && score >= threshold) {
            bestScore = score;
            bestMatch = { ...candidate, isExactRaw: false, isExactNorm: false, amountDiff: amtDiff };
          }
        }
      }

      if (bestMatch && bestScore >= threshold) {
        matchedB[bestMatch.index] = 1;

        let matchType = 'FUZZY_SIMILARITY';
        if (bestMatch.isExactRaw) {
          matchType = 'EXACT_RAW';
        } else if (bestMatch.isExactNorm) {
          matchType = 'EXACT_NORMALIZED';
        }

        const keySimPct = Math.round(bestScore * 100);
        let reasonText = '';
        if (matchType === 'EXACT_RAW') {
          reasonText = '✓ Birebir Tam Eşleşme (%100)';
        } else if (matchType === 'EXACT_NORMALIZED') {
          reasonText = '✓ Normalizasyon Eşleşmesi (%100): Unvan ve harf varyasyonları çözümlendi';
        } else {
          reasonText = `✓ Yüksek Benzerlik Eşleşmesi (%${keySimPct}): Fonetik/Token Benzerliği`;
        }

        if (bestMatch.amountDiff !== null && bestMatch.amountDiff !== undefined) {
          const diff = Math.round(bestMatch.amountDiff * 100) / 100;
          if (diff === 0) {
            reasonText += ' | Tutar: Birebir Eşit (0.00 fark)';
          } else {
            reasonText += ` | Tutar: Tolerans Dahilinde (${diff} fark)`;
          }
        }

        const explainability = {
          matchType: matchType,
          score: Math.round(bestScore * 1000) / 1000,
          keySimilarityPct: keySimPct,
          amountDiff: bestMatch.amountDiff != null ? Math.round(bestMatch.amountDiff * 100) / 100 : null,
          summary: reasonText
        };

        const matchResult = {
          rowA,
          rowB: bestMatch.row,
          keyA: rawValA,
          keyB: bestMatch.rawKey,
          score: Math.round(bestScore * 1000) / 1000,
          amountDiff: bestMatch.amountDiff != null ? Math.round(bestMatch.amountDiff * 100) / 100 : null,
          reason: explainability,
          reasonText: reasonText
        };

        if (bestScore === 1.0) {
          exactMatches.push(matchResult);
        } else {
          fuzzyMatches.push(matchResult);
        }
      } else {
        unmatchedA.push({ rowA, keyA: rawValA, reason: 'Eşleşen Kayıt Bulunamadı' });
      }
    }

    function finish() {
      // Kalan Tablo B kayıtları (orijinal satır sırasıyla)
      const unmatchedB = [];
      for (let j = 0; j < nB; j++) {
        if (matchedB[j]) continue;
        unmatchedB.push({
          rowB: rowsB[j],
          keyB: rowsB[j][keyB],
          reason: bPrepared[j].key.str ? 'A Tablosunda Karşılığı Yok' : 'Boş Anahtar Değeri'
        });
      }

      const totalA = rowsA.length;
      const totalB = rowsB.length;
      const matchedCountA = exactMatches.length + fuzzyMatches.length;
      const matchRateA = totalA > 0 ? Math.round((matchedCountA / totalA) * 1000) / 10 : 0;

      return {
        exactMatches,
        fuzzyMatches,
        unmatchedA,
        unmatchedB,
        summary: {
          totalA,
          totalB,
          exactCount: exactMatches.length,
          fuzzyCount: fuzzyMatches.length,
          unmatchedACount: unmatchedA.length,
          unmatchedBCount: unmatchedB.length,
          matchRateA
        }
      };
    }

    return { total: rowsA.length, processRow, finish };
  }

  /**
   * İki tabloyu (satır dizileri) çapraz eşleme ve mutabakat için karşılaştırır.
   *
   * @param {Array<Object>} rowsA - Kaynak Tablo A (örn. Ekstre)
   * @param {Array<Object>} rowsB - Karşılaştırma Tablosu B (örn. Muhasebe)
   * @param {Object} options
   *   - keyA: Tablo A anahtar sütun adı
   *   - keyB: Tablo B anahtar sütun adı
   *   - amountA: (İsteğe bağlı) Tablo A tutar sütunu
   *   - amountB: (İsteğe bağlı) Tablo B tutar sütunu
   *   - amountTolerance: Kabul edilen tutar farkı (varsayılan 1.0)
   *   - threshold: Benzerlik eşiği (0.0 - 1.0, varsayılan 0.80)
   * @returns {Object} { exactMatches, fuzzyMatches, unmatchedA, unmatchedB, summary }
   */
  function reconcileTables(rowsA, rowsB, options = {}) {
    const rec = createReconciler(rowsA, rowsB, options);
    for (let i = 0; i < rec.total; i++) rec.processRow(i);
    return rec.finish();
  }

  /**
   * reconcileTables ile birebir aynı sonucu, ana iş parçacığını dondurmadan
   * üretir: her ~sliceMs'de bir olay döngüsüne nefes aldırır ve ilerleme bildirir.
   *
   * @param {Object} [hooks]
   *   - onProgress(done, total): İlerleme geri çağrısı
   *   - sliceMs: Bir dilimde çalışılacak süre (varsayılan 40 ms)
   *   - yieldFn: Nefes alma fonksiyonu (varsayılan setTimeout 0)
   */
  async function reconcileTablesAsync(rowsA, rowsB, options = {}, hooks = {}) {
    const rec = createReconciler(rowsA, rowsB, options);
    const sliceMs = hooks.sliceMs || 40;
    const yieldFn = hooks.yieldFn || (() => new Promise(resolve => setTimeout(resolve, 0)));
    const onProgress = typeof hooks.onProgress === 'function' ? hooks.onProgress : null;

    let sliceStart = Date.now();
    for (let i = 0; i < rec.total; i++) {
      rec.processRow(i);
      if (Date.now() - sliceStart >= sliceMs) {
        if (onProgress) onProgress(i + 1, rec.total);
        await yieldFn();
        sliceStart = Date.now();
      }
    }
    if (onProgress) onProgress(rec.total, rec.total);
    return rec.finish();
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
    toTurkishLower,
    foldTurkishAscii,
    normalizeBusinessKey,
    levenshteinDistance,
    levenshteinRatio,
    jaroWinkler,
    tokenSortRatio,
    compareKeys,
    parseAmount,
    reconcileTables,
    reconcileTablesAsync,
    guvenliHucre,
    buildCsv
  };
});
