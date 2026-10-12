/**
 * Masko — Tam Dosya Seçmeli Maskeleme Motoru (file-mask-engine.js)
 *
 * %100 İstemci Tarafı (Client-Side), Sıfır Ağ İsteği.
 * Gerçek Excel veya CSV dosyalarını satır yapısını ve ilişkileri bozmadan
 * sütun bazlı (Sentetik, Yıldızlama/Kısmi, Token, Boşalt, Koru) maskeler.
 * (ASHIFY / Salesforce Data Mask Yaklaşımı - Backlog F3-02/04/06)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FileMaskEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Sentetik sahte veri havuzları (Tutarlı takma adlandırma için)
  const FAKE_NAMES = [
    'Ahmet Yılmaz', 'Mehmet Kaya', 'Mustafa Demir', 'Ali Çelik', 'Hüseyin Şahin',
    'Ayşe Öztürk', 'Fatma Aydın', 'Emine Özdemir', 'Hatice Arslan', 'Zeynep Doğan',
    'Can Yıldırım', 'Cemre Koç', 'Burak Kurt', 'Deniz Aslan', 'Elif Çetin'
  ];

  const FAKE_DOMAINS = ['ornek.com', 'posta.net', 'sirket.org', 'testposta.com'];
  const FAKE_CITIES = ['İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya', 'Adana', 'Konya', 'Gaziantep'];

  /**
   * Kataloğun (type-catalog.js) çözümü. Tarayıcıda ve worker'da kataloğun
   * ardından yüklenir; Node'da (require) yoktur — o zaman null döner ve
   * checksum'lı tipler geçerli-görünümlü değer yerine SENTETIK_n'e düşer.
   */
  function katalog() {
    const g = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : null);
    return g && g.TypeCatalog ? g.TypeCatalog : null;
  }

  // Arayüz katalogdaki tip kimliklerini gönderir (il, kart, ad_soyad...);
  // motorun eski İngilizce kimlikleri (city, card, name) de kabul edilir.
  const TIP_ESLEME = {
    name: 'ad_soyad', kisi: 'ad_soyad', city: 'il', sehir: 'il', card: 'kart', phone: 'telefon'
  };
  function tipKimligi(typeId) {
    return Object.prototype.hasOwnProperty.call(TIP_ESLEME, typeId) ? TIP_ESLEME[typeId] : (typeId || '');
  }

  /**
   * Kısmi Yıldızlama (Asterisk / Partial Redaction).
   * Verinin tipine göre anlamını koruyarak hassas kısımları yıldızlar.
   */
  function maskAsterisk(val, typeId) {
    if (val == null || val === '') return '';
    const str = String(val).trim();
    if (!str) return '';
    const tip = tipKimligi(typeId);

    // E-posta
    if (tip === 'email' || str.includes('@')) {
      const parts = str.split('@');
      if (parts.length === 2) {
        const name = parts[0];
        const domain = parts[1];
        // Boş yerel kısım ("@x.com") eskiden "undefined*@x.com" üretiyordu
        const maskedName = !name ? '*'
          : name.length <= 2 ? name[0] + '*' : name.slice(0, 2) + '*'.repeat(Math.max(1, name.length - 2));
        return `${maskedName}@${domain}`;
      }
    }

    // TCKN / YKN (11 hane). İlk 9 hane ve iki kontrol basamağından yalnızca
    // son ikisi görünür: eskiden 11 hanenin 6'sı (iki kontrol basamağı dahil)
    // açıkta kalıyor, kalan 5 hane checksum'la aday sayısı ~10⁴'e iniyordu.
    // 11 haneli telefon ("05321234567") bu dala düşmez.
    const telefonTipi = tip === 'telefon' || tip === 'telefon_intl';
    if (tip === 'tckn' || tip === 'ykn' || (!telefonTipi && /^\d{11}$/.test(str))) {
      const d = str.replace(/\D/g, '');
      if (d.length > 4) return '*'.repeat(d.length - 2) + d.slice(-2);
      return '*'.repeat(Math.max(1, d.length || str.length));
    }

    // IBAN (TR...)
    if (tip === 'iban' || (/^[A-Z]{2}\d{2}/i.test(str))) {
      return str.slice(0, 4) + ' **** **** ' + str.slice(-2);
    }

    // Telefon
    if (telefonTipi || (/^(\+90|0)?5\d{9}$/.test(str.replace(/[\s()-]/g, '')))) {
      const clean = str.replace(/[\s()-]/g, '');
      if (clean.length >= 10) {
        return clean.slice(0, 4) + ' *** ** ' + clean.slice(-2);
      }
    }

    // Kredi Kartı
    if (tip === 'kart' || (/^\d{16}$/.test(str.replace(/[\s-]/g, '')))) {
      const clean = str.replace(/[\s-]/g, '');
      return clean.slice(0, 4) + ' **** **** ' + clean.slice(-4);
    }

    // Ad Soyad / Genel Metin (Kelimelerin ilk harfleri hariç yıldızlama)
    const words = str.split(/\s+/);
    if (words.length > 1) {
      return words.map(w => {
        if (w.length <= 2) return w[0] + '*';
        return w.slice(0, 2) + '*'.repeat(Math.min(4, w.length - 2));
      }).join(' ');
    }

    // Düz tek kelime veya sayı
    if (str.length <= 3) return str[0] + '*';
    return str.slice(0, 2) + '*'.repeat(Math.min(6, str.length - 2));
  }

  /**
   * Tutarlı Sentetik Değer Üretimi.
   * Aynı dosyadaki aynı girdi değeri, her satırda her zaman aynı sahte değere dönüşür.
   */
  function maskSynthetic(val, typeId, colIndex, consistencyMap, counterObj) {
    if (val == null || val === '') return '';
    const rawStr = String(val).trim();
    if (!rawStr) return '';

    const colKey = `col_${colIndex}`;
    if (!consistencyMap[colKey]) consistencyMap[colKey] = new Map();
    const map = consistencyMap[colKey];

    if (map.has(rawStr)) {
      return map.get(rawStr);
    }

    if (!counterObj[colKey]) counterObj[colKey] = 0;
    let count = counterObj[colKey]++;

    // Aynı kolonda üretilmiş sahte değerler: iki farklı gerçek değer aynı
    // sahteye düşerse tekillik ve join bozulur.
    const sahteKey = `${colKey}#sahte`;
    if (!consistencyMap[sahteKey]) consistencyMap[sahteKey] = new Set();
    const uretilen = consistencyMap[sahteKey];

    const tip = tipKimligi(typeId);
    let fakeVal = '';
    if (tip === 'ad_soyad') {
      let candidate = FAKE_NAMES[count % FAKE_NAMES.length];
      if (candidate.toLowerCase() === rawStr.toLowerCase()) {
        count++;
        counterObj[colKey]++;
        candidate = FAKE_NAMES[count % FAKE_NAMES.length];
      }
      fakeVal = candidate + (count >= FAKE_NAMES.length ? ` ${count}` : '');
    } else if (tip === 'email') {
      const dom = FAKE_DOMAINS[count % FAKE_DOMAINS.length];
      fakeVal = `kullanici_${count + 1}@${dom}`;
    } else if (tip === 'telefon') {
      const num = String(1000000 + (count * 17) % 8999999);
      fakeVal = `0532${num.slice(0, 7)}`;
    } else if (tip === 'il') {
      // Gerçek il kendi yerine yazılmasın (değer olduğu gibi sızardı)
      fakeVal = FAKE_CITIES[count % FAKE_CITIES.length];
      if (fakeVal.toLocaleLowerCase('tr-TR') === rawStr.toLocaleLowerCase('tr-TR')) {
        fakeVal = FAKE_CITIES[(count + 1) % FAKE_CITIES.length];
      }
    } else {
      // TCKN, IBAN, kart, VKN, YKN... kataloğun checksum'lı üreteçlerinden.
      // Eskiden TCKN '00' ile bitip checksum'dan geçmiyor, IBAN 28 karakter ve
      // sabit '99' kontrol basamağıyla çıkıyordu; 'il'/'kart'/'ad' kimlikleri
      // de tanınmadığından SENTETIK_n'e düşüyordu. Üreteci olmayan tipler
      // (tutar, maaş, sayı, tarih, saat, kategori) biçimi koruyarak üretilir.
      fakeVal = katalogUret(tip, colKey, count, rawStr, uretilen) ||
        bicimliUret(tip, colKey, count, rawStr, uretilen) || `SENTETIK_${count + 1}`;
    }

    uretilen.add(fakeVal);
    map.set(rawStr, fakeVal);
    return fakeVal;
  }

  /**
   * Katalog üreteciyle sahte değer. Tohum yalnızca kolon, tip ve ilk görülme
   * sırasıdır; gerçek değer tohuma girmez, sahte değerden geri çıkarılamaz ve
   * aynı dosya her seferinde aynı sonucu verir. Tip kataloğu yüklü değilse ya
   * da tipin üreteci yoksa null döner.
   */
  function katalogUret(tip, colKey, count, rawStr, uretilen) {
    const TC = katalog();
    const t = TC && tip ? TC.typeById(tip) : null;
    if (!t || typeof t.gen !== 'function') return null;
    const rng = TC.makeRng(TC.hashSeed(`${colKey}#${tip}#${count}`));
    const hane = rawStr.replace(/\D/g, '').length;
    // sablon: yalnız biçim (harf/rakam yeri, önek) okunur; değer üretime girmez
    const ctx = { index: count, uzunluk: hane || undefined, sablon: rawStr };
    let yedek = null;
    for (let deneme = 0; deneme < 20; deneme++) {
      const aday = t.gen(rng, ctx);
      if (aday == null || aday === '') continue;
      const s = String(aday);
      if (s === rawStr) continue;
      if (!uretilen.has(s)) return s;
      if (yedek === null) yedek = s;
    }
    // Küçük değer kümesi (cinsiyet gibi) tükendiyse tekrar kabul edilir
    return yedek;
  }

  /* BİÇİMİ KORUYAN ÜRETİM (kataloğu üreteçsiz tipler)
     Eskiden tutar, maaş, sayı, tarih, saat ve kategori kolonları tam dosya
     maskelemesinde "SENTETIK_1, SENTETIK_2…" oluyordu: sayı metne dönüşüyor,
     Excel'de toplanamıyor, tarih sıralanamıyordu. Burada değerin biçimi
     korunur, içeriği tohumlu rastgele değişir. Tohum kolon, tip ve ilk
     görülme sırasıdır; gerçek değer tohuma girmez. */
  const SAYI_TIPLERI = new Set(['sayi', 'adet', 'tutar', 'maas']);
  const TARIH_TIPLERI = new Set(['tarih', 'dogum_tarihi']);

  function tohumluRng(metin) {
    let h = 2166136261;                       // FNV-1a
    for (let i = 0; i < metin.length; i++) { h ^= metin.charCodeAt(i); h = Math.imul(h, 16777619); }
    let a = h >>> 0;
    return function () {                      // mulberry32
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const aralik = (rng, en, ust) => en + Math.floor(rng() * (ust - en + 1));
  const basamak = (n, uzunluk) => String(n).padStart(uzunluk, '0');

  // "12.500,50 TL" → "47.391,28 TL": rakamlar değişir; ayraç, para birimi,
  // baştaki sıfırlar ve basamak sayısı (büyüklük) kalır.
  function sayiBicimli(rng, s) {
    let out = '', basladi = false;
    for (const c of s) {
      if (c >= '0' && c <= '9') {
        if (!basladi && c === '0') { out += '0'; continue; }
        out += basladi ? aralik(rng, 0, 9) : aralik(rng, 1, 9);
        basladi = true;
      } else {
        out += c;
        if (c === ',' || c === '.') basladi = true;   // ondalık kısımda sıfır serbest
      }
    }
    return out;
  }

  // Tarih biçimi aynen kalır (ayraç, sıfır doldurma, yıl uzunluğu, saat kısmı).
  // Gün/ay ayrımı belirsiz ("03/04/2025") ise ikisi de 12'yi aşmaz; her iki
  // okumada da geçerli tarih çıkar.
  function tarihBicimli(rng, s, dogum) {
    let m = /^(\d{4})([-./])(\d{1,2})\2(\d{1,2})(.*)$/.exec(s);
    let ymd = true;
    if (!m) { m = /^(\d{1,2})([-./])(\d{1,2})\2(\d{4}|\d{2})(.*)$/.exec(s); ymd = false; }
    if (!m) return null;
    const [yil, a, b] = ymd ? [m[1], m[3], m[4]] : [m[4], m[1], m[3]];
    const sep = m[2], kalan = m[5];
    const yilSayi = Number(yil), oynama = dogum ? 3 : 1;
    let yeniYil = yilSayi + aralik(rng, -oynama, oynama);
    if (yil.length === 2) yeniYil = ((yeniYil % 100) + 100) % 100;
    const belirsiz = !ymd && sep === '/' && Number(a) <= 12 && Number(b) <= 12;
    const ay = aralik(rng, 1, 12), gun = aralik(rng, 1, belirsiz ? 12 : 28);
    const ayStr = basamak(ay, m[3].length);              // ay iki biçimde de 3. grupta
    const gunStr = basamak(gun, (ymd ? m[4] : m[1]).length);
    const yilStr = basamak(yeniYil, yil.length);
    const saatKismi = kalan.replace(/(\d{1,2}):(\d{2})(?::(\d{2}))?/, (t, h, d, sn) =>
      basamak(aralik(rng, 0, 23), h.length) + ':' + basamak(aralik(rng, 0, 59), 2) + (sn !== undefined ? ':' + basamak(aralik(rng, 0, 59), 2) : ''));
    return (ymd ? `${yilStr}${sep}${ayStr}${sep}${gunStr}` : `${gunStr}${sep}${ayStr}${sep}${yilStr}`) + saatKismi;
  }

  function bicimliUret(tip, colKey, count, rawStr, uretilen) {
    // Kategori etiketleri ayrı kalmalı (farklı durumlar birleşmesin)
    if (tip === 'kategori') return `Kategori_${count + 1}`;
    const sayi = SAYI_TIPLERI.has(tip), tarih = TARIH_TIPLERI.has(tip), saat = tip === 'saat';
    if (!sayi && !tarih && !saat) return null;
    // Sıfır kimseyi işaret etmez; "0" adet/tutar sıfır kalır
    if (sayi && /\d/.test(rawStr) && !/[1-9]/.test(rawStr)) return rawStr;
    // Ölçümlerde (tutar, tarih) iki gerçek değerin aynı sahteye düşmesi
    // zararsızdır; yalnız gerçek değerin kendisi yazılmasın.
    for (let deneme = 0; deneme < 20; deneme++) {
      const rng = tohumluRng(`${colKey}#${tip}#bicim#${count}#${deneme}`);
      let aday = null;
      if (tarih) aday = tarihBicimli(rng, rawStr, tip === 'dogum_tarihi');
      else if (saat) {
        const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(rawStr);
        if (m) aday = basamak(aralik(rng, 0, 23), m[1].length) + ':' + basamak(aralik(rng, 0, 59), 2) +
          (m[3] !== undefined ? ':' + basamak(aralik(rng, 0, 59), 2) : '');
      } else if (/\d/.test(rawStr)) {
        aday = sayiBicimli(rng, rawStr);
      }
      if (aday === null) return null;           // biçim tanınmadı: SENTETIK_n
      if (aday !== rawStr) return aday;
    }
    return null;
  }

  /**
   * Tutarlı Token / Takma Ad Üretimi ([MUSTERI_1], [TCKN_1] vb.).
   */
  function maskToken(val, typeId, colName, colIndex, consistencyMap, counterObj) {
    if (val == null || val === '') return '';
    const rawStr = String(val).trim();
    if (!rawStr) return '';

    const colKey = `col_${colIndex}`;
    if (!consistencyMap[colKey]) consistencyMap[colKey] = new Map();
    const map = consistencyMap[colKey];

    if (map.has(rawStr)) {
      return map.get(rawStr);
    }

    if (!counterObj[colKey]) counterObj[colKey] = 0;
    const count = ++counterObj[colKey];

    let tag = (typeId || colName || 'DEGER').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (tag.length > 12) tag = tag.slice(0, 12);
    const token = `[${tag}_${count}]`;

    map.set(rawStr, token);
    return token;
  }

  /**
   * Saf JavaScript SHA-256 (bayt dizisi üzerinde).
   * Tarayıcı, Web Worker ve Node ortamında senkron çalışır; maskeleme
   * worker içinde senkron yürüdüğü için crypto.subtle (asenkron) kullanılmaz.
   */
  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const SHA256_H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  function ror(x, n) { return (x >>> n) | (x << (32 - n)); }

  /* Tek sıkıştırma çekirdeği. Durum (st) ve mesaj planı (W) yeniden kullanılır:
     büyük tablolarda her hücre için dizi, DataView ve TextEncoder üretmek
     1 milyon değerde ~50 sn sürüyordu. Sonuç standart SHA-256'dır. */
  const W = new Uint32Array(64);
  function sikistir(st, b, off) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = ((b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15], w2 = W[i - 2];
      const s0 = ror(w15, 7) ^ ror(w15, 18) ^ (w15 >>> 3);
      const s1 = ror(w2, 17) ^ ror(w2, 19) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = st[0], bb = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + W[i]) >>> 0;
      const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
    }
    st[0] = (st[0] + a) >>> 0; st[1] = (st[1] + bb) >>> 0; st[2] = (st[2] + c) >>> 0; st[3] = (st[3] + d) >>> 0;
    st[4] = (st[4] + e) >>> 0; st[5] = (st[5] + f) >>> 0; st[6] = (st[6] + g) >>> 0; st[7] = (st[7] + h) >>> 0;
  }

  /* msg'yi, daha önce oncekiBayt bayt işlenmiş st durumundan devam ederek
     özetler (HMAC ara durumu için). Sonuç st içinde kalır. */
  let dolguTampon = new Uint8Array(128);
  function ozetDevam(st, msg, oncekiBayt) {
    const len = msg.length;
    let off = 0;
    for (; off + 64 <= len; off += 64) sikistir(st, msg, off);
    const kalan = len - off;
    const blok = kalan + 9 <= 64 ? 64 : 128;
    const t = dolguTampon;
    t.fill(0, 0, blok);
    for (let i = 0; i < kalan; i++) t[i] = msg[off + i];
    t[kalan] = 0x80;
    const bit = (oncekiBayt + len) * 8;
    const ust = Math.floor(bit / 0x100000000), alt = bit >>> 0;
    t[blok - 8] = ust >>> 24; t[blok - 7] = (ust >>> 16) & 255; t[blok - 6] = (ust >>> 8) & 255; t[blok - 5] = ust & 255;
    t[blok - 4] = alt >>> 24; t[blok - 3] = (alt >>> 16) & 255; t[blok - 2] = (alt >>> 8) & 255; t[blok - 1] = alt & 255;
    sikistir(st, t, 0);
    if (blok === 128) sikistir(st, t, 64);
  }

  function durumBayt(st, out, off) {
    for (let i = 0; i < 8; i++) {
      const v = st[i], j = off + i * 4;
      out[j] = v >>> 24; out[j + 1] = (v >>> 16) & 255; out[j + 2] = (v >>> 8) & 255; out[j + 3] = v & 255;
    }
    return out;
  }

  function sha256Bytes(msg) {
    const st = Uint32Array.from(SHA256_H0);
    ozetDevam(st, msg, 0);
    return durumBayt(st, new Uint8Array(32), 0);
  }

  // TextEncoder yalnız surrogate'ı U+FFFD yapar; eski unescape(encodeURIComponent)
  // yolu URIError fırlatıp tüm maskeleme işini yarıda kesiyordu.
  const kodlayici = new TextEncoder();
  function utf8(str) { return kodlayici.encode(String(str)); }
  // Sıcak yol için: yeniden kullanılan tampona kodlar (dönen görünüm bir sonraki çağrıya kadar geçerlidir).
  let kodTampon = new Uint8Array(256);
  function utf8Tampona(str) {
    if (str.length * 3 > kodTampon.length) kodTampon = new Uint8Array(str.length * 3 + 64);
    return kodTampon.subarray(0, kodlayici.encodeInto(str, kodTampon).written);
  }

  const HEX = [];
  for (let i = 0; i < 256; i++) HEX.push((i < 16 ? '0' : '') + i.toString(16));
  function toHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
    return s;
  }

  /** SHA-256 özeti (hex). Anahtarsızdır; kimlik maskelemek için maskHash kullanın. */
  function sha256Hex(str) {
    if (str == null || str === '') return '';
    return toHex(sha256Bytes(utf8(str)));
  }

  /* HMAC ara durumu: anahtar blokları (K^ipad, K^opad) her değer için yeniden
     sıkıştırılmaz. Son kullanılan anahtar önbellekte tutulur; bir tablo
     maskelenirken bütün hücreler aynı anahtarı kullanır. */
  let hmacAnahtar = null, hmacIc = null, hmacDis = null;
  function hmacHazirla(key) {
    if (key === hmacAnahtar) return;
    let k = utf8(key);
    if (k.length > 64) k = sha256Bytes(k);
    const blok = new Uint8Array(64);
    blok.set(k);
    const ic = new Uint8Array(64), dis = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ic[i] = blok[i] ^ 0x36; dis[i] = blok[i] ^ 0x5c; }
    hmacIc = Uint32Array.from(SHA256_H0); sikistir(hmacIc, ic, 0);
    hmacDis = Uint32Array.from(SHA256_H0); sikistir(hmacDis, dis, 0);
    hmacAnahtar = key;
  }

  const hmacSt = new Uint32Array(8);
  const icOzet = new Uint8Array(32);
  /** RFC 2104 HMAC-SHA-256 (hex). */
  function hmacSha256Hex(key, message) {
    key = String(key);
    hmacHazirla(key);
    hmacSt.set(hmacIc);
    ozetDevam(hmacSt, utf8Tampona(String(message)), 64);
    durumBayt(hmacSt, icOzet, 0);
    hmacSt.set(hmacDis);
    ozetDevam(hmacSt, icOzet, 64);
    return toHex(durumBayt(hmacSt, new Uint8Array(32), 0));
  }

  /**
   * 256 bit rastgele anahtar (hex). Yalnızca bellekte tutulmalıdır; dosyaya,
   * tarife veya depolamaya yazılırsa takma adlar sözlük saldırısıyla çözülür.
   */
  function createSecretKey() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (!c || typeof c.getRandomValues !== 'function') {
      throw new Error('Güvenli rastgele sayı üreteci bulunamadı; anahtarsız hash üretilmez.');
    }
    const bytes = new Uint8Array(32);
    c.getRandomValues(bytes);
    return toHex(bytes);
  }

  let sessionKey = null;
  function getSessionKey() {
    if (!sessionKey) sessionKey = createSecretKey();
    return sessionKey;
  }

  /**
   * Güvenli sütun hashleme: HMAC-SHA-256.
   * Eskiden anahtar verilmezse düz SHA-256 alınıyordu. TCKN (~9×10⁸ geçerli
   * değer) ve telefon gibi düşük entropili alanlarda düz hash birkaç saniyede
   * kaba kuvvetle geri çözülür. Artık anahtar verilmezse oturuma özgü rastgele
   * bir anahtar kullanılır: aynı oturumda aynı değer aynı özete gider (JOIN
   * korunur), anahtarı bilmeyen biri tersine çeviremez.
   *
   * @param {*} val
   * @param {string} [key] - Gizli anahtar. Boşsa oturum anahtarı kullanılır.
   * @param {number} [truncateLen]
   */
  function maskHash(val, key, truncateLen) {
    if (val == null || val === '') return '';
    const cleanStr = String(val).trim();
    if (!cleanStr) return '';
    const fullHex = hmacSha256Hex(key ? String(key) : getSessionKey(), cleanStr);
    if (truncateLen && typeof truncateLen === 'number' && truncateLen > 0 && truncateLen < 64) {
      return fullHex.slice(0, truncateLen);
    }
    return fullHex;
  }

  // Genelleştirme çözümlenemeyen bir değerle karşılaşınca ham değeri geri
  // vermez: "6/24/85" gibi bir doğum tarihi olduğu gibi dosyaya sızıyordu.
  const BASTIRILDI = '*';

  /**
   * K-Anonimlik: Tarihi Yıla veya Yıl-Aya Genelleştirme.
   * Örn: '1985-06-24' veya '24.06.1985' ➔ '1985' (veya '1985-06')
   */
  function generalizeDate(val, granularity) {
    if (val == null || val === '') return '';
    const str = String(val).trim();
    if (!str) return '';

    // ISO: YYYY-MM-DD
    const isoMatch = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (isoMatch) {
      const year = isoMatch[1];
      const month = isoMatch[2].padStart(2, '0');
      return granularity === 'month' ? `${year}-${month}` : year;
    }

    // TR: DD.MM.YYYY veya DD/MM/YYYY
    const trMatch = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (trMatch) {
      const year = trMatch[3];
      const month = trMatch[2].padStart(2, '0');
      return granularity === 'month' ? `${year}-${month}` : year;
    }

    // 4 haneli yıl bul
    const yearMatch = str.match(/(?:19|20)\d{2}/);
    if (yearMatch) {
      return yearMatch[0];
    }
    return BASTIRILDI;
  }

  /**
   * K-Anonimlik: Yaşı Aralığa İndirgeme (Bucketization).
   * Örn: 27 ➔ '20-29' (10 yıllık kova) veya '25-29' (5 yıllık kova)
   */
  function generalizeAge(val, bucketSize) {
    if (val == null || val === '') return '';
    const num = parseInt(String(val).replace(/\D/g, ''), 10);
    if (isNaN(num)) return BASTIRILDI;

    const step = (bucketSize && bucketSize > 0) ? bucketSize : 10;
    const start = Math.floor(num / step) * step;
    const end = start + (step - 1);
    return `${start}-${end}`;
  }

  /**
   * K-Anonimlik: Sayısal Aralık Genelleştirme (Tutar, Maaş, Bütçe vb.).
   * Örn: 3450 ➔ '3000-3999'
   */
  function generalizeNumeric(val, step, numberFormat) {
    if (val == null || val === '') return '';
    // Türkçe biçim ("45.000", "1.234,56") katalogun kolon düzeyinde çıkardığı
    // biçimle okunur; eski yol noktayı ondalık sayıp 45.000'i "0-999" kovasına
    // atıyordu. Katalog yoksa ya da değer çözülemezse eski yola düşülür.
    const TC = katalog();
    let num = typeof val === 'number' ? val : (TC ? TC.parseNumber(val, numberFormat) : NaN);
    if (isNaN(num)) num = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    if (isNaN(num)) return BASTIRILDI;

    const s = (step && step > 0) ? step : 1000;
    const start = Math.floor(num / s) * s;
    const end = start + (s - 1);
    return `${start}-${end}`;
  }

  /**
   * Tek bir hücreyi seçilen kurala göre dönüştürür.
   *
   * @param {*} value - Hücrenin orijinal değeri
   * @param {Object} rule - { action: 'keep'|'synthetic'|'asterisk'|'token'|'clear'|'hash'|'generalize_date'|'generalize_age'|'generalize_numeric', typeId?: string, salt?: string, granularity?: string, bucketSize?: number, step?: number, numberFormat?: 'tr'|'en' }
   * @param {string} colName - Kolon adı
   * @param {number} colIndex - Kolon sırası
   * @param {Object} consistencyMap - Tutarlılık önbelleği
   * @param {Object} counterObj - Sayaçlar
   * @returns {*} Dönüştürülmüş değer
   */
  function maskCell(value, rule, colName, colIndex, consistencyMap, counterObj) {
    if (value == null) return '';
    const action = rule ? rule.action : 'keep';
    const typeId = rule ? rule.typeId : '';

    if (action === 'keep') {
      return value;
    }
    if (action === 'clear') {
      return '';
    }
    if (action === 'asterisk') {
      return maskAsterisk(value, typeId);
    }
    if (action === 'synthetic') {
      return maskSynthetic(value, typeId, colIndex, consistencyMap, counterObj);
    }
    if (action === 'token') {
      return maskToken(value, typeId, colName, colIndex, consistencyMap, counterObj);
    }
    if (action === 'hash') {
      return maskHash(value, rule ? rule.salt : '', rule ? rule.truncateLen : 0);
    }
    if (action === 'generalize_date') {
      return generalizeDate(value, rule ? rule.granularity : 'year');
    }
    if (action === 'generalize_age') {
      return generalizeAge(value, rule ? rule.bucketSize : 10);
    }
    if (action === 'generalize_numeric') {
      return generalizeNumeric(value, rule ? rule.step : 1000, rule ? rule.numberFormat : undefined);
    }
    return value;
  }

  /**
   * OWASP CSV / Excel formül enjeksiyonu koruması: kanonik kural csv-io.js'te
   * (guvenliHucre) tek yerde tutulur ki tablo, tezgâh ve kitle çıktılarıyla
   * aynı kalsın. Tarayıcıda ve worker'da bu dosyadan önce yüklenir, Node'da
   * require edilir. Çağrı anında çözülür: yalnız hash/takma ad için bu motoru
   * yükleyen sayfalar csv-io'ya bağımlı olmasın.
   */
  let csvModulu = null;
  function csvIO() {
    if (csvModulu) return csvModulu;
    if (typeof CsvIO !== 'undefined') csvModulu = CsvIO;
    else if (typeof module === 'object' && module.exports && typeof require === 'function') csvModulu = require('./csv-io.js');
    else throw new Error('csv-io.js yüklenmedi; CSV formül koruması uygulanamaz.');
    return csvModulu;
  }

  function guvenliHucre(value) {
    return csvIO().guvenliHucre(value);
  }

  /**
   * Tüm tabloyu verilen sütun kurallarına göre maskeler.
   *
   * İki satır biçimi kabul edilir:
   *  - Nesne dizisi: [{ ad: 'Ali', tckn: '...' }, ...] — kurallar anahtar adıyla.
   *  - Dizi dizisi (SheetJS header:1 / CSV ayrıştırıcı çıktısı): başlık satırı
   *    options.headerRowIdx'tedir; başlığın üstündeki satırlar (rapor başlığı vb.)
   *    dışarı aktarılmaz. Kurallar options.headers içindeki adla ya da sütun
   *    indeksiyle eşlenir.
   *
   * @param {Array<Object>|Array<Array>} rows - Orijinal satırlar
   * @param {Object} columnRules - { [colName|colIndex]: { action, typeId, salt, granularity, bucketSize } }
   * @param {Object} options - { safeFormulas, headerRowIdx, headers }
   * @returns {Object} { headers, maskedRows, stats: { totalRows, transformedCells, columnsCount }, previewDiff }
   */
  function maskEntireTable(rows, columnRules, options = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return { headers: [], maskedRows: [], stats: { totalRows: 0, transformedCells: 0 }, previewDiff: [] };
    }
    columnRules = columnRules || {};

    const consistencyMap = Object.create(null);
    const counterObj = Object.create(null);
    const maskedRows = [];
    const previewDiff = [];
    let transformedCells = 0;

    // UI ve worker satırları DİZİ olarak verir. Eskiden burada her durumda
    // Object.keys(rows[0]) kullanılıyordu: dizi için "0","1"... döner, başlık
    // adıyla tutulan hiçbir kural eşleşmez ve "_maskelenmis" dosya orijinal
    // veriyle (başlık satırı da veri sayılarak) inerdi.
    const matrisModu = Array.isArray(rows[0]);
    let headers;
    let dataRows;
    if (matrisModu) {
      const headerRowIdx = Number.isInteger(options.headerRowIdx) && options.headerRowIdx >= 0 ? options.headerRowIdx : 0;
      const baslikSatiri = Array.isArray(rows[headerRowIdx]) ? rows[headerRowIdx] : [];
      const verilen = Array.isArray(options.headers) ? options.headers : [];
      dataRows = rows.slice(headerRowIdx + 1);
      let genislik = Math.max(baslikSatiri.length, verilen.length);
      for (let r = 0; r < dataRows.length; r++) {
        if (Array.isArray(dataRows[r]) && dataRows[r].length > genislik) genislik = dataRows[r].length;
      }
      headers = [];
      for (let c = 0; c < genislik; c++) {
        const ad = verilen[c] != null && verilen[c] !== '' ? String(verilen[c])
          : (baslikSatiri[c] != null && String(baslikSatiri[c]).trim() !== '' ? String(baslikSatiri[c]).trim() : `kolon_${c + 1}`);
        headers.push(ad);
      }
    } else {
      headers = Object.keys(rows[0]);
      dataRows = rows;
    }

    function kuralBul(c) {
      if (Object.prototype.hasOwnProperty.call(columnRules, headers[c])) return columnRules[headers[c]];
      if (matrisModu && Object.prototype.hasOwnProperty.call(columnRules, String(c))) return columnRules[String(c)];
      return null;
    }

    // Kural verilmiş ama hiçbiri sütunlarla eşleşmiyorsa sessizce orijinali
    // döndürmek yerine dur: "maskelendi" etiketiyle ham veri indirmek en kötü sonuç.
    const kuralSayisi = Object.keys(columnRules).filter(function (k) {
      return columnRules[k] && columnRules[k].action && columnRules[k].action !== 'keep';
    }).length;
    if (kuralSayisi > 0) {
      let eslesen = 0;
      for (let c = 0; c < headers.length; c++) {
        const kural = kuralBul(c);
        if (kural && kural.action && kural.action !== 'keep') eslesen++;
      }
      if (eslesen === 0) {
        throw new Error('Maskeleme kuralları hiçbir sütunla eşleşmedi; dosya orijinal veriyle indirilmesin diye işlem durduruldu.');
      }
    }

    const safeFormulas = options.safeFormulas !== false;
    const cikisBasliklari = safeFormulas ? headers.map(guvenliHucre) : headers.slice();

    for (let r = 0; r < dataRows.length; r++) {
      const row = dataRows[r] || (matrisModu ? [] : {});
      const newRow = matrisModu ? [] : {};
      const diffRow = { index: r + 1, original: {}, masked: {}, hasChanges: false };

      for (let c = 0; c < headers.length; c++) {
        const col = headers[c];
        const val = matrisModu ? row[c] : row[col];
        const rule = kuralBul(c) || { action: 'keep' };

        let maskedVal = maskCell(val, rule, col, c, consistencyMap, counterObj);

        if (safeFormulas) maskedVal = guvenliHucre(maskedVal);

        if (matrisModu) newRow[c] = maskedVal;
        else newRow[col] = maskedVal;

        if (String(val == null ? '' : val) !== String(maskedVal)) {
          transformedCells++;
          diffRow.hasChanges = true;
        }

        if (r < 10) {
          diffRow.original[col] = val;
          diffRow.masked[col] = maskedVal;
        }
      }

      maskedRows.push(newRow);
      if (r < 10 && diffRow.hasChanges) {
        previewDiff.push(diffRow);
      }
    }

    return {
      headers: cikisBasliklari,
      maskedRows,
      stats: {
        totalRows: dataRows.length,
        transformedCells,
        columnsCount: headers.length
      },
      previewDiff
    };
  }

  return {
    sha256Hex,
    hmacSha256Hex,
    createSecretKey,
    maskHash,
    generalizeDate,
    generalizeAge,
    generalizeNumeric,
    maskAsterisk,
    maskSynthetic,
    maskToken,
    maskCell,
    maskEntireTable
  };
});
