/**
 * workbench/schema-mapper-engine.js
 * 
 * Local-First Data & Office Workbench: Schema Mapper & Canonical Field Profiles (WB-04)
 * 
 * Kurumsal ofislerde her ay değişen sütun isimlerini ("Cust No", "Customer ID", "Müşteri No")
 * kurallı standart alanlara (Canonical Fields) eşler, eşleme profillerini saklar ve
 * dosyaları standart şemaya dönüştürür.
 * 
 * %100 İstemci Tarafı, Deterministik, Sıfır Dış Bağımlılık.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SchemaMapperEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Başlık normalizasyonu (harf büyüklüğü, boşluk ve Türkçe karakterler)
   */
  function normalizeHeaderName(str) {
    if (!str) return '';
    return String(str)
      .trim()
      .replace(/[^\w\sğüşıöçĞÜŞİÖÇ_]/g, '')
      .replace(/[\s_]+/g, '_')
      .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
      .replace(/ü/g, 'u').replace(/Ü/g, 'U')
      .replace(/ş/g, 's').replace(/Ş/g, 'S')
      .replace(/ı/g, 'i').replace(/İ/g, 'I')
      .replace(/ö/g, 'o').replace(/Ö/g, 'O')
      .replace(/ç/g, 'c').replace(/Ç/g, 'C')
      .toLowerCase();
  }

  /**
   * Levenshtein Benzerlik Oranı (0.0 - 1.0)
   */
  function stringSimilarity(s1, s2) {
    if (s1 === s2) return 1.0;
    if (!s1 || !s2) return 0.0;
    const l1 = s1.length;
    const l2 = s2.length;
    const d = [];
    for (let i = 0; i <= l1; i++) {
      d[i] = [i];
    }
    for (let j = 0; j <= l2; j++) {
      d[0][j] = j;
    }
    for (let i = 1; i <= l1; i++) {
      for (let j = 1; j <= l2; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        d[i][j] = Math.min(
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + cost
        );
      }
    }
    const maxLen = Math.max(l1, l2);
    return maxLen === 0 ? 1.0 : 1.0 - (d[l1][l2] / maxLen);
  }

  /**
   * Kaynak başlıkları kurallı (canonical) şema alanlarıyla otomatik eşler
   * 
   * @param {string[]} sourceHeaders - Girdi tablosundaki başlıklar
   * @param {Object} profile - Şema profili
   * @param {Array<{ name: string, aliases?: string[], required?: boolean, defaultValue?: any }>} profile.canonicalFields
   * @param {Object} [options]
   * @param {number} [options.similarityThreshold=0.85] - Bulanık eşleme eşiği
   * @returns {{ matches: Array<{ canonicalName: string, sourceIndex: number, sourceHeader: string, matchType: string, confidence: number }>, unmappedSources: string[], missingCanonicals: string[] }}
   */
  function matchHeaders(sourceHeaders, profile, options) {
    options = options || {};
    const threshold = options.similarityThreshold || 0.85;

    if (!Array.isArray(sourceHeaders) || !profile || !Array.isArray(profile.canonicalFields)) {
      throw new Error('sourceHeaders ve profile.canonicalFields geçerli diziler olmalıdır.');
    }

    const matches = [];
    const usedSourceIndices = new Set();
    const matchedCanonicals = new Set();

    const normalizedSources = sourceHeaders.map((h, idx) => ({
      original: h,
      index: idx,
      norm: normalizeHeaderName(h)
    }));

    // 1. Aşama: Birebir ve Takma Ad (Alias) Eşleştirmesi
    profile.canonicalFields.forEach(field => {
      const canonName = field.name;
      const canonNorm = normalizeHeaderName(canonName);
      const aliasesNorm = (field.aliases || []).map(normalizeHeaderName);

      // Tam eşleşme ara
      for (const src of normalizedSources) {
        if (usedSourceIndices.has(src.index)) continue;

        if (src.norm === canonNorm) {
          matches.push({
            canonicalName: canonName,
            sourceIndex: src.index,
            sourceHeader: src.original,
            matchType: 'exact',
            confidence: 1.0
          });
          usedSourceIndices.add(src.index);
          matchedCanonicals.add(canonName);
          break;
        }

        if (aliasesNorm.includes(src.norm)) {
          matches.push({
            canonicalName: canonName,
            sourceIndex: src.index,
            sourceHeader: src.original,
            matchType: 'alias',
            confidence: 0.98
          });
          usedSourceIndices.add(src.index);
          matchedCanonicals.add(canonName);
          break;
        }
      }
    });

    // 2. Aşama: Kalanlar için Bulanık (Fuzzy) Eşleştirme
    profile.canonicalFields.forEach(field => {
      const canonName = field.name;
      if (matchedCanonicals.has(canonName)) return;

      const canonNorm = normalizeHeaderName(canonName);
      const candidates = [canonNorm].concat((field.aliases || []).map(normalizeHeaderName));

      let bestMatch = null;
      let highestScore = 0;

      for (const src of normalizedSources) {
        if (usedSourceIndices.has(src.index)) continue;

        for (const cand of candidates) {
          const score = stringSimilarity(src.norm, cand);
          if (score >= threshold && score > highestScore) {
            highestScore = score;
            bestMatch = src;
          }
        }
      }

      if (bestMatch) {
        matches.push({
          canonicalName: canonName,
          sourceIndex: bestMatch.index,
          sourceHeader: bestMatch.original,
          matchType: 'fuzzy',
          confidence: parseFloat(highestScore.toFixed(2))
        });
        usedSourceIndices.add(bestMatch.index);
        matchedCanonicals.add(canonName);
      }
    });

    const unmappedSources = normalizedSources
      .filter(s => !usedSourceIndices.has(s.index))
      .map(s => s.original);

    const missingCanonicals = profile.canonicalFields
      .map(f => f.name)
      .filter(name => !matchedCanonicals.has(name));

    return {
      matches: matches,
      unmappedSources: unmappedSources,
      missingCanonicals: missingCanonicals
    };
  }

  /**
   * Eşleme sonucuna göre tabloyu standart kurallı şemaya dönüştürür
   * 
   * @param {string[]} headers 
   * @param {Array<Array<any>>} rows 
   * @param {Object} mappingResult - matchHeaders sonucu veya manuel eşleme haritası
   * @param {Object} profile - Şema profili
   * @param {Object} [options]
   * @param {boolean} [options.includeUnmapped=false] - Eşleşmeyen sütunları da tablonun sonuna ekler
   * @returns {{ headers: string[], rows: Array<Array<any>>, stats: Object }}
   */
  function transformTable(headers, rows, mappingResult, profile, options) {
    options = options || {};
    const includeUnmapped = !!options.includeUnmapped;

    if (!Array.isArray(headers) || !Array.isArray(rows) || !profile) {
      throw new Error('headers, rows ve profile geçerli olmalıdır.');
    }

    // Eşleme haritasını oluştur: canonicalName -> sourceIndex
    const canonToSourceIndex = new Map();
    mappingResult.matches.forEach(m => {
      canonToSourceIndex.set(m.canonicalName, m.sourceIndex);
    });

    const outHeaders = [];
    const colFetchers = [];

    // Kurallı sütunları ekle
    profile.canonicalFields.forEach(field => {
      outHeaders.push(field.name);
      if (canonToSourceIndex.has(field.name)) {
        const srcIdx = canonToSourceIndex.get(field.name);
        colFetchers.push(r => (r[srcIdx] !== null && r[srcIdx] !== undefined ? r[srcIdx] : (field.defaultValue !== undefined ? field.defaultValue : '')));
      } else {
        colFetchers.push(() => (field.defaultValue !== undefined ? field.defaultValue : ''));
      }
    });

    // İstenirse eşleşmeyen kaynak sütunları ekle
    if (includeUnmapped && Array.isArray(mappingResult.unmappedSources)) {
      mappingResult.unmappedSources.forEach(srcHeader => {
        const srcIdx = headers.indexOf(srcHeader);
        if (srcIdx >= 0) {
          outHeaders.push(srcHeader);
          colFetchers.push(r => (r[srcIdx] !== null && r[srcIdx] !== undefined ? r[srcIdx] : ''));
        }
      });
    }

    const outRows = rows.map(r => colFetchers.map(fn => fn(r)));

    return {
      headers: outHeaders,
      rows: outRows,
      stats: {
        canonicalColumnsCount: profile.canonicalFields.length,
        matchedCount: mappingResult.matches.length,
        missingCanonicalsCount: mappingResult.missingCanonicals.length,
        unmappedSourcesCount: mappingResult.unmappedSources.length,
        outputRowsCount: outRows.length
      }
    };
  }

  /**
   * Şema profili nesnesi oluşturur
   */
  function createProfile(profileName, canonicalFields, description) {
    return {
      schemaVersion: 'masko-schema-profile-v1',
      profileName: profileName || 'Standart Şema Profili',
      description: description || '',
      createdAt: new Date().toISOString(),
      canonicalFields: canonicalFields || []
    };
  }

  return {
    normalizeHeaderName: normalizeHeaderName,
    stringSimilarity: stringSimilarity,
    matchHeaders: matchHeaders,
    transformTable: transformTable,
    createProfile: createProfile
  };
}));
