/**
 * encoding-engine.js
 *
 * Bozuk Karakter & Encoding Kurtarıcı (Windows-1254 / ISO-8859-9 ➔ UTF-8 BOM)
 * Kurumsal ERP (SAP, Logo, Mikro, Netsis vb.) CSV ve TXT dosyalarındaki
 * Türkçe karakter bozulmalarını (Mojibake, CP1254, ISO-8859-9) otomatik tespit eder
 * ve Excel ile %100 uyumlu UTF-8 (BOM'lu) formatına onarır.
 *
 * TEMEL İLKE: DOĞRU METNE DOKUNMA
 * -------------------------------
 * Eski sürüm her metne düzeltme kurallarını körlemesine uyguluyordu;
 * "Novotný;Þór;Guðrún" gibi zaten doğru olan Çekçe/İzlandaca adlar
 * "Novotnı;Şór;Guğrún" oluyordu. Artık sıra şu:
 *   1. Baytlar önce KATI UTF-8 olarak çözülür (fatal). Geçerliyse metin
 *      UTF-8'dir; Windows-1254'e yalnızca UTF-8 çözümü başarısız olursa
 *      düşülür. Emoji gibi 4 baytlı diziler de böylece doğrulanmış olur.
 *   2. Mojibake onarımı yalnızca metinde gerçek mojibake imzası
 *      (Ã¼, Ä±, ÅŸ, Å\u009f, Ã‡ …) BULUNURSA çalışır ve her şüpheli diziyi
 *      "geri çevir → UTF-8 olarak çöz" gidiş-dönüşüyle doğrular.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EncodingRepairEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ORNEK_BOYU = 100000;   // tespit için incelenen ön parça (≈100 KB)

  // Windows-1254 Türkçe bayt eşlemeleri (TextDecoder windows-1254 yoksa yedek)
  const CP1254_MAP = {
    0xFD: 'ı', 0xDD: 'İ',
    0xFE: 'ş', 0xDE: 'Ş',
    0xF0: 'ğ', 0xD0: 'Ğ',
    0xE7: 'ç', 0xC7: 'Ç',
    0xF6: 'ö', 0xD6: 'Ö',
    0xFC: 'ü', 0xDC: 'Ü'
  };

  /* Bilinen Türkçe mojibake imzaları — yalnızca belgeleme ve geriye dönük
     uyumluluk için dışa açılır. Onarım bu tabloyla DEĞİL, aşağıdaki
     gidiş-dönüş çözümüyle yapılır; tablo tek başına yanlış pozitif üretirdi.
     Eski sürümdeki tek harf kuralları (ý→ı, þ→ş, ð→ğ …) buradan çıkarıldı:
     bu harfler Çekçe/İzlandaca'da gerçek harflerdir. */
  const MOJIBAKE_REPLACEMENTS = [
    { from: /Ã§/g, to: 'ç' },
    { from: /Ã‡|Ã\u0087/g, to: 'Ç' },
    { from: /Ã¶/g, to: 'ö' },
    { from: /Ã–|Ã\u0096/g, to: 'Ö' },
    { from: /Ã¼/g, to: 'ü' },
    { from: /Ãœ|Ã\u009c/g, to: 'Ü' },
    { from: /Ä±/g, to: 'ı' },
    { from: /Ä°/g, to: 'İ' },
    { from: /ÅŸ|Å\u009f/g, to: 'ş' },
    { from: /Åž|Å\u009e/g, to: 'Ş' },
    { from: /ÄŸ|Ä\u009f/g, to: 'ğ' },
    { from: /Äž|Ä\u009e/g, to: 'Ğ' }
  ];

  /* ---------- GİDİŞ-DÖNÜŞ TABLOSU ----------
     Mojibake, UTF-8 baytlarının tek baytlı bir kod sayfasıyla (Windows-1252,
     Latin-1 ya da Windows-1254) okunup yeniden UTF-8 kaydedilmesidir. Her
     bozuk karakter aslında tek bir BAYTI temsil eder. Bu tablo karakteri o
     bayta geri çevirir:
       • U+0080–U+00FF  → aynı bayt (Latin-1; C1 kontrol karakterleri dahil,
                           "Å\u009f" gibi Latin-1 tarzı mojibake bu yüzden çözülür)
       • Windows-1252'nin 0x80–0x9F bölgesindeki tipografik karakterler (€ ‚ ‡ Ÿ …)
       • ğ → 0xF0: Windows-1254 ile okunmuş emoji ("ğŸ˜€" = 😀) için.
     İ/Ş/Ğ (0xDD/0xDE/0xD0) bilerek eklenmedi: bunlar yalnızca Kiril/İbrani
     metnin mojibake'inde öncü bayt olur ve Türkçe metinde "Ş”" gibi gerçek
     dizileri yanlışlıkla dönüştürme riski taşır. */
  const CP1252_OZEL = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
    0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
    0x017E: 0x9E, 0x0178: 0x9F
  };

  function _bayta(ch) {
    const cp = ch.charCodeAt(0);
    if (cp >= 0x80 && cp <= 0xFF) return cp;
    if (cp === 0x011F) return 0xF0;   // ğ (Windows-1254 0xF0)
    const b = CP1252_OZEL[cp];
    return b === undefined ? -1 : b;
  }

  // Devam baytı (0x80–0xBF) yerine geçen karakterler
  const DEVAM = '[\\u0080-\\u00BF\\u20AC\\u201A\\u0192\\u201E\\u2026\\u2020\\u2021\\u02C6\\u2030'
    + '\\u0160\\u2039\\u0152\\u017D\\u2018\\u2019\\u201C\\u201D\\u2022\\u2013\\u2014\\u02DC'
    + '\\u2122\\u0161\\u203A\\u0153\\u017E\\u0178]';
  // Öncü baytlar: 0xC2–0xDF (2 bayt), 0xE0–0xEF (3 bayt), 0xF0–0xF4 (4 bayt)
  const SUPHELI_DIZI = new RegExp(
    '[\\u00C2-\\u00DF]' + DEVAM +
    '|[\\u00E0-\\u00EF]' + DEVAM + '{2}' +
    '|[\\u00F0-\\u00F4\\u011F]' + DEVAM + '{3}', 'g');

  /* İMZA: mojibake'in "gerçekten var" sayılması için gereken güçlü kanıt.
     Öncü karakter Â Ã Ä Å (U+0080–U+017F: Latin-1 Ek + Latin Genişletilmiş-A,
     tüm Türkçe harfler dahil), â (’ “ – € ™ gibi tipografi) ya da ð/ğ
     (emoji) olmalı. Böylece doğru metindeki tek tük "×²" benzeri rastlantılar
     onarımı tetiklemez. */
  const IMZA_ONCU = /^[ÂÃÄÅâðğ]/;
  // Onarım sonucu kontrol karakteri içeriyorsa gidiş-dönüş yanlış demektir
  const KONTROL = /[\u0000-\u001F\u007F-\u009F]/;
  // Tek çözücü yeterli: stream kullanılmadığı için her çağrı (hata dahil) sıfırdan başlar
  const KATI_UTF8 = new TextDecoder('utf-8', { fatal: true });

  /* Şüpheli diziyi baytlara çevirip katı UTF-8 çözer. Geçersizse null. */
  function _diziyiCoz(dizi) {
    const baytlar = new Uint8Array(dizi.length);
    for (let i = 0; i < dizi.length; i++) {
      const b = _bayta(dizi[i]);
      if (b < 0) return null;
      baytlar[i] = b;
    }
    let sonuc;
    try {
      sonuc = KATI_UTF8.decode(baytlar);
    } catch (e) {
      return null;
    }
    return KONTROL.test(sonuc) ? null : sonuc;
  }

  /* Metindeki doğrulanmış mojibake imzalarını sayar. */
  function _imzaSay(metin) {
    if (!metin) return 0;
    let n = 0;
    SUPHELI_DIZI.lastIndex = 0;
    let m;
    while ((m = SUPHELI_DIZI.exec(metin)) !== null) {
      if (IMZA_ONCU.test(m[0]) && _diziyiCoz(m[0]) !== null) n++;
    }
    return n;
  }

  /* Mojibake onarımı. İmza yoksa metin AYNEN döner — doğru metin hiçbir
     koşulda değişmez. Çift kodlanmış metin (ÃƒÂ¼ → Ã¼ → ü) için en fazla
     üç tur döner; her tur imza sayısını azaltmıyorsa durur ve o tur geri
     alınır ("azaltmayan onarım onarım değildir"). */
  function _mojibakeOnar(metin) {
    let onarilan = 0;
    let imza = _imzaSay(metin);
    for (let tur = 0; tur < 3 && imza > 0; tur++) {
      let buTur = 0;
      const yeni = metin.replace(SUPHELI_DIZI, dizi => {
        const cozulen = _diziyiCoz(dizi);
        if (cozulen === null) return dizi;
        buTur++;
        return cozulen;
      });
      const yeniImza = _imzaSay(yeni);
      if (!buTur || yeniImza >= imza) break;
      metin = yeni;
      onarilan += buTur;
      imza = yeniImza;
    }
    return { text: metin, count: onarilan };
  }

  /* ---------- TEK HARF KARIŞIKLIĞI (İSTEĞE BAĞLI) ----------
     Windows-1254 dosyası bir kez Windows-1252 sanılıp UTF-8'e çevrilmişse
     ı ş ğ İ Ş Ğ yerine ý þ ð Ý Þ Ð görünür ("Ilýk", "Þirket"). Bu harfler
     Çekçe ve İzlandaca'da GERÇEK harfler olduğu için otomatik çevrilmez;
     yalnızca tespit ŞÜPHE bildirir, dönüşümü kullanıcı açıkça ister. */
  const TEK_HARF = { 'ý': 'ı', 'Ý': 'İ', 'þ': 'ş', 'Þ': 'Ş', 'ð': 'ğ', 'Ð': 'Ğ' };
  const TEK_HARF_RE = /[ýÝþÞðÐ]/g;
  const GERCEK_TURKCE_RE = /[ıİşŞğĞ]/;

  function _tekHarfSuphesi(metin) {
    if (!metin || GERCEK_TURKCE_RE.test(metin)) return 0;
    const m = metin.match(TEK_HARF_RE);
    return m ? m.length : 0;
  }

  /* Örnek parçanın sonundaki yarım çok baytlı karakteri hata sayma:
     stream:true kipinde çözücü eksik diziyi bir sonraki parçayı bekleyen
     tampon olarak tutar, hata fırlatmaz. */
  function _utf8Coz(bytes, sonuKesikOlabilir) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !!sonuKesikOlabilir });
    } catch (e) {
      return null;
    }
  }

  function _bomVarMi(bytes) {
    return bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  }

  function _cp1254Say(bytes, son) {
    let n = 0;
    for (let i = 0; i < son; i++) {
      const b = bytes[i];
      if (b === 0xFD || b === 0xDD || b === 0xFE || b === 0xDE || b === 0xF0 || b === 0xD0) n++;
    }
    return n;
  }

  function _cp1254Tanimi(hasBom, hits) {
    return {
      encoding: 'windows-1254',
      hasBom: hasBom,
      turkishCp1254Count: hits,
      isMojibake: false,
      confidence: hits > 0 ? 'yüksek' : 'orta',
      description: 'Windows-1254 / ISO-8859-9 (Klasik Türkçe ERP / SAP Formatı)'
    };
  }

  function _utf8Tanimi(hasBom, metin) {
    const mojibakeHits = _imzaSay(metin);
    if (mojibakeHits > 0) {
      return {
        encoding: 'mojibake-utf8',
        hasBom: hasBom,
        turkishCp1254Count: 0,
        mojibakeCount: mojibakeHits,
        isMojibake: true,
        confidence: 'yüksek',
        description: 'Bozuk UTF-8 / Mojibake (Ã¼, ÅŸ, Ä± gibi çift kodlanmış)'
      };
    }
    return {
      encoding: 'utf-8',
      hasBom: hasBom,
      turkishCp1254Count: 0,
      isMojibake: false,
      singleLetterSuspect: _tekHarfSuphesi(metin),
      confidence: hasBom ? 'kesin' : 'orta',
      description: hasBom
        ? 'Excel Uyumlu UTF-8 (BOM Başlığı Mevcut)'
        : 'Standart UTF-8 (Excel için BOM eklenebilir)'
    };
  }

  /**
   * Bayt dizisinin kodlamasını ve Türkçe karakter durumunu analiz eder.
   * Hız için ilk ~100 KB incelenir; kesin karar repairToUtf8String'in
   * tüm dosya üzerindeki katı çözümüdür.
   *
   * @param {Uint8Array} bytes
   * @returns {Object} { encoding: string, hasBom: boolean, turkishCp1254Count: number, isMojibake: boolean, confidence: string }
   */
  function detectEncoding(bytes) {
    if (!bytes || !(bytes instanceof Uint8Array)) {
      throw new Error('Geçerli bir Uint8Array bayt dizisi verilmelidir.');
    }

    const hasBom = _bomVarMi(bytes);
    const bas = hasBom ? 3 : 0;
    const son = Math.min(bytes.length, bas + ORNEK_BOYU);
    const kesik = son < bytes.length;
    const metin = _utf8Coz(bytes.subarray(bas, son), kesik);

    if (metin === null) return _cp1254Tanimi(hasBom, _cp1254Say(bytes, son));
    return _utf8Tanimi(hasBom, metin);
  }

  function _cp1254Coz(bytes) {
    try {
      return new TextDecoder('windows-1254').decode(bytes);
    } catch (e) {
      // Tarayıcı windows-1254 desteklemiyorsa manuel bayt eşleme
      let manual = '';
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        manual += CP1254_MAP[b] || String.fromCharCode(b);
      }
      return manual;
    }
  }

  /**
   * Bozuk metni veya bayt dizisini onarır ve temiz UTF-8 metin üretir.
   *
   * @param {Uint8Array|string} input - Dosya baytları veya string metin
   * @param {Object} [options]
   * @param {string} [options.forcedEncoding] - Zorlanan kaynak kodlama ('windows-1254', 'iso-8859-9', 'utf-8')
   * @param {boolean} [options.singleLetterFix] - ý/þ/ð → ı/ş/ğ tek harf dönüşümünü uygula (yalnızca açıkça istenirse)
   * @returns {{ text: string, repairedChars: number, originalEncoding: string, detected: Object, stats: Object }}
   */
  function repairToUtf8String(input, options) {
    options = options || {};
    let text = '';
    let origEnc = '';
    let repairedChars = 0;
    let detected = null;

    if (input instanceof Uint8Array) {
      const hasBom = _bomVarMi(input);
      const govde = hasBom ? input.subarray(3) : input;
      const zorla = options.forcedEncoding;

      if (zorla === 'windows-1254' || zorla === 'iso-8859-9') {
        text = _cp1254Coz(govde);
        origEnc = zorla;
        detected = _cp1254Tanimi(hasBom, _cp1254Say(govde, govde.length));
      } else if (zorla === 'utf-8') {
        text = new TextDecoder('utf-8', { fatal: false }).decode(govde);
        origEnc = 'utf-8';
        detected = _utf8Tanimi(hasBom, text);
      } else {
        /* Tüm dosya katı UTF-8 ile çözülür: ilk 100 KB'ı geçerli olup
           ilerisinde Windows-1254 baytı bulunan dosyada örnek tespiti
           yanılır, bu çözüm yanılmaz. */
        const utf8 = _utf8Coz(govde, false);
        if (utf8 !== null) {
          text = utf8;
          detected = _utf8Tanimi(hasBom, utf8);
        } else {
          text = _cp1254Coz(govde);
          detected = _cp1254Tanimi(hasBom, _cp1254Say(govde, govde.length));
          // Her yüksek bayt (≥0x80) doğru Unicode karakterine çevrildi
          for (let i = 0; i < govde.length; i++) if (govde[i] >= 0x80) repairedChars++;
        }
        origEnc = detected.encoding;
      }
    } else if (typeof input === 'string') {
      text = input;
      origEnc = 'string';
      detected = _utf8Tanimi(false, text);
    } else {
      throw new Error('input Uint8Array veya string olmalıdır.');
    }

    const onarim = _mojibakeOnar(text);
    text = onarim.text;
    repairedChars += onarim.count;

    if (options.singleLetterFix) {
      text = text.replace(TEK_HARF_RE, ch => { repairedChars++; return TEK_HARF[ch]; });
    }

    return {
      text: text,
      repairedChars: repairedChars,
      originalEncoding: origEnc,
      detected: detected,
      stats: {
        charLength: text.length,
        repairedCount: repairedChars
      }
    };
  }

  /**
   * Metni Microsoft Excel ile anında bozulmadan açılacak UTF-8 BOM'lu Uint8Array'e dönüştürür.
   *
   * @param {string} text - Temizlenmiş UTF-8 metin
   * @returns {Uint8Array} Başında 0xEF, 0xBB, 0xBF BOM bulunan bayt dizisi
   */
  function exportCleanUtf8WithBom(text) {
    if (typeof text !== 'string') {
      throw new Error('text parametresi string olmalıdır.');
    }

    const encoder = new TextEncoder();
    const utf8Bytes = encoder.encode(text);

    // BOM: 3 bayt (0xEF, 0xBB, 0xBF)
    const out = new Uint8Array(3 + utf8Bytes.length);
    out[0] = 0xEF;
    out[1] = 0xBB;
    out[2] = 0xBF;
    out.set(utf8Bytes, 3);

    return out;
  }

  return {
    detectEncoding: detectEncoding,
    repairToUtf8String: repairToUtf8String,
    exportCleanUtf8WithBom: exportCleanUtf8WithBom,
    MOJIBAKE_REPLACEMENTS: MOJIBAKE_REPLACEMENTS
  };
}));
