/**
 * workbench/privacy-lab-engine.js
 * 
 * Local-First Data & Office Workbench: Privacy Lab & Safe Share Scanner
 * Kapsanan Modüller:
 * - WB-06: Join-Preserving Deterministic Masking, Deterministic Date Shift & Mask Vault
 * - WB-07: Safe Share Scanner (Uçuş Öncesi Paylaşım Güvenliği Denetçisi)
 * 
 * %100 İstemci Tarafı, Deterministik, Sıfır Dış Bağımlılık.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PrivacyLabEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;
  const PHONE_RE = /(?:\+?90|0)?\s*[1-9]\d{2}\s*\d{3}\s*\d{2}\s*\d{2}/g;
  const IBAN_RE = /TR\d{2}\s*(?:\d{4}\s*){5}\d{2}/gi;
  const TCKN_RE = /\b[1-9]\d{10}\b/g;

  // HMAC-SHA-256 kaynağı: tarayıcıda ../file-mask-engine.js, Node'da require.
  function fileMask() {
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      return require('../file-mask-engine.js');
    }
    const g = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {});
    if (!g.FileMaskEngine) throw new Error('file-mask-engine.js yüklenmedi; güvenli takma ad üretilemez.');
    return g.FileMaskEngine;
  }

  // Anahtar verilmezse oturuma özgü rastgele anahtar. Hiçbir yere yazılmaz.
  let oturumAnahtari = null;
  function anahtar(key) {
    if (key !== null && key !== undefined && String(key) !== '') return String(key);
    if (!oturumAnahtari) oturumAnahtari = fileMask().createSecretKey();
    return oturumAnahtari;
  }

  /**
   * Anahtarlı deterministik özet: HMAC-SHA-256 (büyük harf hex).
   * Eskiden 32 bitlik, kriptografik olmayan bir karma ve herkesin bildiği
   * varsayılan tuz ('masko-default-salt') kullanılıyordu: 20 bin değerde 12
   * çakışma çıkıyor (farklı kişiler JOIN'de birleşiyordu), kaynak kodu bilen
   * herkes de sözlük saldırısıyla takma adları geri çözebiliyordu.
   */
  function hashString(str, key) {
    return fileMask().hmacSha256Hex(anahtar(key), String(str)).toUpperCase();
  }

  // Crockford base32: 13 karakterde 65 bit. Hex yerine kullanılır çünkü uzun
  // rakam dizileri telefon/TCKN kalıplarına takılıp takma adı "maskelenmemiş
  // kişisel veri" gibi gösterirdi.
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  // Hex'in baştaki bitlerini 5'erli gruplar hâlinde okur (bit dizisi kurmadan).
  function base32(hex, uzunluk) {
    let s = '', birikim = 0, bit = 0;
    for (let i = 0; i < hex.length && s.length < uzunluk; i++) {
      birikim = (birikim << 4) | parseInt(hex[i], 16);
      bit += 4;
      if (bit >= 5) {
        bit -= 5;
        s += B32[(birikim >> bit) & 31];
        birikim &= (1 << bit) - 1;
      }
    }
    return s;
  }

  // ==========================================
  // WB-06: Join-Preserving Masking & Date Shift
  // ==========================================

  /**
   * İlişki Koruyan Deterministik Maskeleme (Join-Preserving Masking)
   * Aynı değere ve aynı tuza (salt) sahip girdiler her zaman aynı takma adı alır.
   * Farklı dosyalardaki tablolar maskelendikten sonra bile JOIN edilebilir.
   * 
   * @param {string} value - Maskelenecek değer (Örn: "Ahmet Yılmaz")
   * @param {string} [key] - Kurumsal gizli anahtar. Boşsa oturuma özgü rastgele anahtar.
   * @param {string} [prefix='PERSON'] - Takma ad öneki
   * @returns {string} - Örn: "PERSON_3KQ7M1ZC8XH2A" (65 bit)
   */
  function maskDeterministic(value, key, prefix) {
    if (value === null || value === undefined || String(value).trim() === '') {
      return '';
    }
    const clean = String(value).trim();
    const hash = hashString('kimlik\u001f' + clean.toLowerCase(), key);
    const pfx = prefix ? prefix.toUpperCase() : 'ENTITY';
    return `${pfx}_${base32(hash, 13)}`;
  }

  /**
   * Deterministik Tarih Kaydırma (Deterministic Date Shifting)
   * Bir kişiye veya oturuma ait tüm tarihleri deterministik bir gün sayısı kadar kaydırır.
   * Tarihler arası gün farkları (olaylar arasındaki süre) analitik olarak %100 korunur.
   *
   * @param {string} dateStr - 'YYYY-MM-DD' veya 'DD.MM.YYYY' (ayraç . / - olabilir; ayraç korunur)
   * @param {string|number|{offsetDays: number}} entityOrOffset - Gün sayısının türetileceği
   *   Entity ID. Sayılar da kimlik sayılır: XLSX'ten gelen sayısal müşteri no 12345 eskiden
   *   "12345 gün" kabul edilip tarihi 2057'ye atıyordu. Sabit kaydırma için açıkça
   *   { offsetDays: n } verin.
   * @param {string} [salt] - Gizli anahtar. Boşsa oturuma özgü rastgele anahtar.
   * @returns {string} - Kaydırılmış tarih. Tanınmayan biçim veya imkânsız tarih (31.02)
   *   değiştirilmeden döner: Date.UTC 31.02'yi sessizce 02.03'e yuvarlayıp bozuk
   *   değeri kaydırılmış gerçek bir tarih gibi gösteriyordu.
   */
  function shiftDate(dateStr, entityOrOffset, salt) {
    if (!dateStr || typeof dateStr !== 'string') return dateStr;
    const cleanDate = dateStr.trim();

    // Tarihi parse et
    let year, month, day, ayrac = null, m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleanDate))) {
      year = +m[1]; month = +m[2]; day = +m[3];
    } else if ((m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})$/.exec(cleanDate))) {
      day = +m[1]; ayrac = m[2]; month = +m[3]; year = +m[4];
    } else {
      return cleanDate; // Bilinmeyen format
    }

    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
      return cleanDate; // İmkânsız tarih: yuvarlanmaz
    }

    // Gün ofsetini belirle
    let shiftDays;
    if (entityOrOffset !== null && typeof entityOrOffset === 'object' &&
        Object.prototype.hasOwnProperty.call(entityOrOffset, 'offsetDays')) {
      shiftDays = Number(entityOrOffset.offsetDays);
      if (!Number.isInteger(shiftDays)) throw new Error('shiftDate: offsetDays tam sayı olmalıdır.');
    } else {
      // Entity ID'den deterministik ofset üret (-30 gün ile +59 gün arası, 0 hariç)
      const h = parseInt(hashString('tarih\u001f' + String(entityOrOffset), salt).slice(0, 8), 16);
      shiftDays = (h % 90) - 30;
      if (shiftDays === 0) shiftDays = 14;
    }

    // Gün ekle
    d.setUTCDate(d.getUTCDate() + shiftDays);

    const outYear = d.getUTCFullYear();
    const outMonth = String(d.getUTCMonth() + 1).padStart(2, '0');
    const outDay = String(d.getUTCDate()).padStart(2, '0');

    if (ayrac === null) {
      return `${outYear}-${outMonth}-${outDay}`;
    }
    return `${outDay}${ayrac}${outMonth}${ayrac}${outYear}`;
  }

  /**
   * Biçim Koruyan Maskeleme (Format-Preserving Masking)
   */
  function maskFormatPreserving(val, type, options) {
    if (val === null || val === undefined) return '';
    const str = String(val).trim();
    if (!str) return '';

    options = options || {};

    switch (type) {
      case 'phone': {
        const digits = str.replace(/\D/g, '');
        if (digits.length >= 10) {
          const last2 = digits.slice(-2);
          const area = digits.slice(-10, -7);
          return `+90 ${area} *** ** ${last2}`;
        }
        return str.replace(/\d/g, '*');
      }

      case 'email': {
        const atIdx = str.indexOf('@');
        if (atIdx > 1) {
          const name = str.slice(0, atIdx);
          const domain = str.slice(atIdx);
          const maskedName = name[0] + '***' + name[name.length - 1];
          return maskedName + domain;
        }
        return 'user***@masked.local';
      }

      case 'iban': {
        const clean = str.replace(/\s+/g, '');
        if (clean.length >= 10) {
          const pfx = clean.slice(0, 4);
          const sfx = clean.slice(-4);
          return `${pfx} **** **** **** **** **** ${sfx}`;
        }
        return 'TR** **** **** **** **** **** ****';
      }

      default:
        return str;
    }
  }

  /**
   * Maske Kasası (Mask Vault): maske sözlüğünü veriden ayrı bir anahtar dosyası
   * olarak üretir. ŞİFRELENMEZ: gerçek değer ↔ takma ad eşlemesini düz JSON olarak
   * içerir; erişimi kısıtlı bir yerde saklanmalıdır.
   */
  function createMaskVault(dictionary, vaultName, metadata) {
    return {
      schemaVersion: 'masko-vault-v1',
      vaultName: vaultName || 'Gizlilik Kasası',
      createdAt: new Date().toISOString(),
      metadata: metadata || {},
      entryCount: Object.keys(dictionary).length,
      // Dosyayı açan kişi için açık uyarı: içerik düz metindir, şifre yoktur.
      encrypted: false,
      entries: dictionary
    };
  }

  /* Kasa şifreleme: parola → PBKDF2-SHA-256 (600.000 tur, rastgele 16 bayt
     tuz) → AES-256-GCM (rastgele 12 bayt IV). Kasa gerçek değer ↔ takma ad
     eşlemesini taşıdığı için veriyle aynı yere düşerse maskeleme boşa çıkar;
     parolalı kasa ancak parolayı bilen tarafından açılır. GCM, dosya
     değiştirilmişse ya da parola yanlışsa açmayı reddeder. Hepsi tarayıcının
     yerleşik Web Crypto'su ile yerelde yapılır. */
  const KASA_TUR = 600000;

  function webCrypto() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (!c || !c.subtle || typeof c.getRandomValues !== 'function') {
      throw new Error('Bu ortamda Web Crypto yok; kasa şifrelenemez.');
    }
    return c;
  }
  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64Coz(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  async function kasaAnahtari(parola, tuz, tur) {
    const c = webCrypto();
    const ham = await c.subtle.importKey('raw', new TextEncoder().encode(parola), 'PBKDF2', false, ['deriveKey']);
    return c.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: tuz, iterations: tur },
      ham, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /**
   * createMaskVault çıktısını parolayla şifreler. Yalnız kasa adı ve tarih
   * açıkta kalır; eşlemeler ve metaveri şifreli bloğun içindedir.
   */
  async function sealMaskVault(vault, parola) {
    if (!parola || String(parola).length < 8) throw new Error('Kasa parolası en az 8 karakter olmalı.');
    const c = webCrypto();
    const tuz = c.getRandomValues(new Uint8Array(16));
    const iv = c.getRandomValues(new Uint8Array(12));
    const anahtar = await kasaAnahtari(String(parola), tuz, KASA_TUR);
    const acik = new TextEncoder().encode(JSON.stringify(vault));
    const sifreli = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv: iv }, anahtar, acik));
    return {
      schemaVersion: 'masko-vault-v2',
      vaultName: vault.vaultName,
      createdAt: vault.createdAt,
      encrypted: true,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KASA_TUR, salt: b64(tuz) },
      cipher: { name: 'AES-GCM', iv: b64(iv) },
      data: b64(sifreli)
    };
  }

  /**
   * Kasa dosyasını açar: şifreliyse parolayla çözer, değilse doğrular.
   * Dönen nesne createMaskVault biçimindedir ({ entries: { takmaAd: gerçek } }).
   */
  async function openMaskVault(dosya, parola) {
    if (!dosya || typeof dosya !== 'object') throw new Error('Geçersiz kasa dosyası.');
    let kasa = dosya;
    if (dosya.encrypted) {
      if (dosya.schemaVersion !== 'masko-vault-v2' || !dosya.kdf || !dosya.cipher || !dosya.data) {
        throw new Error('Tanınmayan şifreli kasa biçimi.');
      }
      if (!parola) throw new Error('Bu kasa şifreli; parolayı girin.');
      const tur = Number(dosya.kdf.iterations);
      if (!Number.isInteger(tur) || tur < 100000 || tur > 10000000) throw new Error('Kasa anahtar türetme ayarı geçersiz.');
      const anahtar = await kasaAnahtari(String(parola), b64Coz(dosya.kdf.salt), tur);
      let acik;
      try {
        acik = await webCrypto().subtle.decrypt({ name: 'AES-GCM', iv: b64Coz(dosya.cipher.iv) }, anahtar, b64Coz(dosya.data));
      } catch (_) {
        throw new Error('Kasa açılamadı: parola yanlış ya da dosya değiştirilmiş.');
      }
      kasa = JSON.parse(new TextDecoder().decode(acik));
    }
    if (kasa.schemaVersion !== 'masko-vault-v1' || !kasa.entries || typeof kasa.entries !== 'object') {
      throw new Error('Geçersiz kasa içeriği.');
    }
    // Prototipsiz kopya: "__proto__" gibi bir takma ad nesneyi bozmasın.
    const entries = Object.create(null);
    Object.keys(kasa.entries).forEach(k => {
      if (typeof kasa.entries[k] === 'string') entries[k] = kasa.entries[k];
    });
    return Object.assign({}, kasa, { entries: entries });
  }

  /**
   * Tablodaki takma adları kasadaki gerçek değerlere geri çevirir.
   * Yalnız kasada birebir bulunan hücreler değişir.
   */
  function restoreFromVault(rows, entries) {
    let degisen = 0;
    const yeni = (rows || []).map(r => r.map(h => {
      if (typeof h === 'string' && Object.prototype.hasOwnProperty.call(entries, h)) { degisen++; return entries[h]; }
      return h;
    }));
    return { rows: yeni, restoredCount: degisen };
  }

  // ==========================================
  // WB-07: Safe Share Scanner
  // ==========================================

  /**
   * Elektronik tablo formül enjeksiyonu koruması (OWASP CSV Injection) csv-io.js'te
   * tek yerde tutulur. Denetçi "bu hücre CSV'ye yazılsa korunması gerekir mi?"
   * sorusunu dışa aktarmanın kullandığı isFormulaCell ile yanıtlar ki tarama ve
   * dışa aktarma aynı tanımı kullansın. Tarayıcıda ../csv-io.js, Node'da require.
   */
  let csvModulu = null;
  function csvIO() {
    if (csvModulu) return csvModulu;
    if (typeof CsvIO !== 'undefined') csvModulu = CsvIO;
    else if (typeof module === 'object' && module.exports && typeof require === 'function') csvModulu = require('../csv-io.js');
    else throw new Error('csv-io.js yüklenmedi; formül riski taranamaz.');
    return csvModulu;
  }

  // DDE yükleri (=cmd|' /C calc'!A0, @SUM(1+1)*cmd|..., =MSEXCEL|'...'!'') ve dış
  // kaynağa istek atan / kod çalıştıran işlevler kritik sayılır.
  const DDE_RE = /\bcmd\s*\||\|\s*'/i;
  const RISKLI_ISLEV_RE = /\b(?:WEBSERVICE|HYPERLINK|IMPORTXML|IMPORTDATA|IMPORTHTML|IMPORTFEED|IMPORTRANGE|IMAGE|FILTERXML|EXEC|CALL|REGISTER(?:\.ID)?|RTD|DDE|DDEAUTO|SHELL)\s*\(/i;

  /**
   * Hücrenin formül riskini sınıflandırır.
   * @returns {null|{ critical: boolean }} Formül gibi değilse null
   */
  function classifyFormulaCell(v) {
    if (typeof v !== 'string') return null;
    const bastanKirpik = v.replace(/^ +/, '');
    const io = csvIO();
    if (!io.isFormulaCell(v) && !io.isFormulaCell(bastanKirpik)) return null;
    return { critical: DDE_RE.test(v) || RISKLI_ISLEV_RE.test(v) };
  }

  /**
   * Paylaşım Öncesi Güvenlik Denetimi (Uçuş Öncesi Tarama)
   *
   * Metaveri verilmezse sonuç "güvenli" DEMEZ (isSafeToShare: false,
   * metadataChecked: false): gizli sayfalar, yazar adı ve dış bağlantılar hücre
   * değerlerinde görünmez. Düz metin biçimleri (CSV/JSON/pano) için çağıran
   * { format: 'csv' } gibi bir nesne geçerek metaverinin bulunmadığını beyan eder.
   *
   * @param {string[]} headers
   * @param {Array<Array<any>>} rows
   * @param {Object} [documentMetadata] - Dosya/çalışma kitabı metaverileri:
   *   { format, author, lastModifiedBy, sheetCount, hiddenSheetsCount, hiddenSheetNames,
   *     externalLinksCount, commentsCount, dangerousFormulaCount (çalışma kitabı formül
   *     tanımlarında; sheet_to_json yalnız hesaplanmış değeri verdiği için hücrede görünmez) }
   * @returns {{ riskLevel: string, totalFindings: number, findings: Array<Object>, isSafeToShare: boolean,
   *   metadataChecked: boolean, cellsClean: boolean, limitations: string[], summary: Object }}
   */
  function scanForSafeShare(headers, rows, documentMetadata) {
    const findings = [];
    const limitations = [];
    const metadataChecked = documentMetadata !== null && typeof documentMetadata === 'object';
    const meta = metadataChecked ? documentMetadata : {};

    // 1. Metaveri Denetimi
    if (!metadataChecked) {
      limitations.push('Belge metaverisi (gizli sayfalar, yazar, dış bağlantılar, yorumlar) denetlenmedi; sonuç yalnızca hücre içeriğini kapsar.');
    } else {
      if (meta.author) {
        findings.push({
          type: 'METADATA_AUTHOR',
          severity: 'warning',
          message: `Belge metaverisinde yazar/kullanıcı adı bulundu: "${meta.author}".`,
          suggestion: 'Dışarıya göndermeden önce belge yazar bilgisini temizleyin.'
        });
      }
      if (meta.lastModifiedBy && meta.lastModifiedBy !== meta.author) {
        findings.push({
          type: 'METADATA_LAST_AUTHOR',
          severity: 'warning',
          message: `Belge metaverisinde son değiştiren kullanıcı adı bulundu: "${meta.lastModifiedBy}".`,
          suggestion: 'Dışarıya göndermeden önce belge özelliklerini temizleyin.'
        });
      }
      if (meta.hiddenSheetsCount > 0) {
        findings.push({
          type: 'HIDDEN_SHEETS',
          severity: 'critical',
          message: `Çalışma kitabında ${meta.hiddenSheetsCount} adet gizli sayfa (hidden worksheet) tespit edildi.`,
          suggestion: 'Gizli sayfalarda unutulmuş ham veriler bulunabilir, kontrol edip silin.'
        });
      }
      if (meta.sheetCount > 1) {
        findings.push({
          type: 'UNSCANNED_SHEETS',
          severity: 'warning',
          message: `Çalışma kitabında ${meta.sheetCount} sayfa var; yalnızca ilk sayfanın hücreleri tarandı.`,
          suggestion: 'Diğer sayfaları ayrı ayrı denetleyin ya da yalnızca gereken sayfayı paylaşın.'
        });
        limitations.push('Yalnızca ilk sayfanın hücreleri tarandı.');
      }
      if (meta.externalLinksCount > 0) {
        findings.push({
          type: 'EXTERNAL_LINKS',
          severity: 'warning',
          message: `Çalışma kitabında ${meta.externalLinksCount} adet dış bağlantı/bağlantılı formül bulundu.`,
          suggestion: 'Dış bağlantıları değer olarak yapıştırın.'
        });
      }
      if (meta.commentsCount > 0) {
        findings.push({
          type: 'COMMENTS',
          severity: 'warning',
          message: `Çalışma kitabında ${meta.commentsCount} hücrede yorum/not bulundu.`,
          suggestion: 'Yorumlarda kişisel veri veya iç notlar kalabilir; paylaşmadan önce silin.'
        });
      }
    }

    // 2. Tehlikeli Formül ve Kalıntı PII Taraması
    let unmaskedEmailCount = 0;
    let unmaskedPhoneCount = 0;
    let unmaskedIbanCount = 0;
    let unmaskedTcknCount = 0;
    let dangerousFormulaCount = 0;
    let formulaCellCount = 0;

    const sampleFindings = [];

    (rows || []).forEach((row, rIdx) => {
      row.forEach((cell, cIdx) => {
        if (cell === null || cell === undefined) return;

        // Tehlikeli formül. Eskiden yalnız "=" + 4 işlev adı aranıyordu: +cmd|...,
        // @SUM(1+1)*cmd|..., -2+3+cmd|... ve =IMPORTXML(...) "güvenli" geçiyordu.
        // Artık formül korumasının ' ekleyeceği her hücre işaretlenir.
        const risk = classifyFormulaCell(cell);
        if (risk) {
          if (risk.critical) dangerousFormulaCount++;
          else formulaCellCount++;
          if (sampleFindings.length < 5) {
            sampleFindings.push({
              row: rIdx + 1,
              col: headers[cIdx],
              val: String(cell),
              issue: risk.critical ? 'Tehlikeli Formül Enjeksiyonu' : 'Formül gibi başlayan hücre'
            });
          }
        }

        const str = String(cell).trim();
        if (!str) return;

        // PII Taraması
        if (str.match(EMAIL_RE)) unmaskedEmailCount++;
        if (str.match(PHONE_RE)) unmaskedPhoneCount++;
        if (str.match(IBAN_RE)) unmaskedIbanCount++;
        if (str.match(TCKN_RE)) unmaskedTcknCount++;
      });
    });

    const hucreBulgusuVar = unmaskedEmailCount + unmaskedPhoneCount + unmaskedIbanCount +
      unmaskedTcknCount + dangerousFormulaCount + formulaCellCount > 0;
    const calismaKitabiFormulu = meta.dangerousFormulaCount > 0 ? meta.dangerousFormulaCount : 0;

    if (unmaskedEmailCount > 0) {
      findings.push({
        type: 'UNMASKED_EMAILS',
        severity: 'critical',
        count: unmaskedEmailCount,
        message: `Hücrelerde ${unmaskedEmailCount} adet maskelenmemiş e-posta adresi tespit edildi.`
      });
    }

    if (unmaskedPhoneCount > 0) {
      findings.push({
        type: 'UNMASKED_PHONES',
        severity: 'critical',
        count: unmaskedPhoneCount,
        message: `Hücrelerde ${unmaskedPhoneCount} adet maskelenmemiş telefon numarası tespit edildi.`
      });
    }

    if (unmaskedIbanCount > 0) {
      findings.push({
        type: 'UNMASKED_IBAN',
        severity: 'critical',
        count: unmaskedIbanCount,
        message: `Hücrelerde ${unmaskedIbanCount} adet maskelenmemiş IBAN tespit edildi.`
      });
    }

    if (unmaskedTcknCount > 0) {
      findings.push({
        type: 'UNMASKED_TCKN',
        severity: 'critical',
        count: unmaskedTcknCount,
        message: `Hücrelerde ${unmaskedTcknCount} adet maskelenmemiş TCKN benzeri kimlik numarası tespit edildi.`
      });
    }

    if (dangerousFormulaCount + calismaKitabiFormulu > 0) {
      const toplam = dangerousFormulaCount + calismaKitabiFormulu;
      findings.push({
        type: 'DANGEROUS_FORMULAS',
        severity: 'critical',
        count: toplam,
        message: `${toplam} adet potansiyel tehlikeli formül (DDE, WEBSERVICE, HYPERLINK, IMPORTXML vb.) tespit edildi` +
          (calismaKitabiFormulu > 0 ? ` (${calismaKitabiFormulu} tanesi çalışma kitabı formüllerinde).` : '.'),
        samples: sampleFindings.filter(s => s.issue === 'Tehlikeli Formül Enjeksiyonu')
      });
    }

    if (formulaCellCount > 0) {
      findings.push({
        type: 'FORMULA_CELLS',
        severity: 'warning',
        count: formulaCellCount,
        message: `Hücrelerde =, +, -, @ ile başlayan ${formulaCellCount} değer var; CSV olarak açıldığında formül gibi çalıştırılabilir.`,
        suggestion: 'CSV çıktısında "Güvenli Metin" (başına \') korumasını kullanın.',
        samples: sampleFindings.filter(s => s.issue !== 'Tehlikeli Formül Enjeksiyonu')
      });
    }

    // Risk seviyesi belirleme
    const criticals = findings.filter(f => f.severity === 'critical').length;
    const warnings = findings.filter(f => f.severity === 'warning').length;
    let riskLevel = 'LOW';
    if (criticals > 0) riskLevel = 'HIGH';
    else if (warnings > 0) riskLevel = 'MEDIUM';

    return {
      riskLevel: riskLevel,
      totalFindings: findings.length,
      findings: findings,
      isSafeToShare: findings.length === 0 && metadataChecked,
      metadataChecked: metadataChecked,
      cellsClean: !hucreBulgusuVar,
      limitations: limitations,
      summary: {
        criticalCount: criticals,
        warningCount: warnings,
        unmaskedPiiCount: unmaskedEmailCount + unmaskedPhoneCount + unmaskedIbanCount + unmaskedTcknCount,
        dangerousFormulaCount: dangerousFormulaCount + calismaKitabiFormulu,
        formulaCellCount: formulaCellCount
      }
    };
  }

  return {
    maskDeterministic: maskDeterministic,
    shiftDate: shiftDate,
    maskFormatPreserving: maskFormatPreserving,
    createMaskVault: createMaskVault,
    sealMaskVault: sealMaskVault,
    openMaskVault: openMaskVault,
    restoreFromVault: restoreFromVault,
    scanForSafeShare: scanForSafeShare,
    classifyFormulaCell: classifyFormulaCell,
    hashString: hashString
  };
}));
