/* Arayüz dili: Türkçe / English.
 *
 * Kaynak dil Türkçedir: HTML ve JS Türkçe yazılır, İngilizce dil/en.js
 * sözlüğündedir. Bu betik sayfayı (ve sonradan eklenen arayüzü) sözlükle
 * çevirir; Türkçeye dönüşte saklanan asıl metni geri koyar. Dil anında
 * değişir, sayfa yenilenmez — yüklenmiş dosya ve maskelenmiş metin kaybolmaz.
 *
 * Seçim uzantı kökenindeki localStorage'da (masko_dil) durur; yoksa tarayıcı
 * dili (tr ise Türkçe, değilse İngilizce). "storage" olayıyla açık sayfalara
 * ve araç çerçevelerine yansır. Yalnız görünüm tercihidir, güvenlik ayarı
 * değildir. Tema seçicisi gibi <head>'de, CSS'ten önce ve dil/en.js'ten
 * sonra senkron yüklenir.
 *
 * KULLANICI VERİSİ ÇEVRİLMEZ: translate="no" taşıyan öğe ve altı, textarea,
 * input değerleri, script/style atlanır. Kullanıcının yüklediği tablo, sütun
 * adı ya da maskelenen metin gösteren her kap translate="no" olmalıdır; aksi
 * hâlde "Tarih" adlı bir sütun "Date" görünür.
 *
 * Çeviri birimi: yalnız metin ve satır içi öğeler (strong, code, span…)
 * içeren en büyük öğe. Anahtar, satır içi öğelerin <0>…</0> işaretleriyle
 * yazıldığı metindir ("Toplam <0>5</0> kayıt"); çeviri işaretleri başka
 * sırada kullanabilir. Uygulanırken asıl öğeler taşınır, yeniden yaratılmaz:
 * id'ler, JS başvuruları ve olay dinleyicileri korunur.
 */
(function () {
  "use strict";
  var ANAHTAR = "masko_dil";
  var GECERLI = { tr: 1, en: 1 };
  var kok = document.documentElement;

  function tarayiciDili() {
    var l = (navigator.languages && navigator.languages[0]) || navigator.language || "tr";
    return /^tr\b/i.test(l) ? "tr" : "en";
  }
  function oku() {
    try {
      var v = window.localStorage.getItem(ANAHTAR);
      if (GECERLI[v]) return v;
    } catch (e) { /* depolama kapalı */ }
    return tarayiciDili();
  }

  var aktif = oku();
  kok.setAttribute("lang", aktif);

  /* ---------------- Sözlük ---------------- */
  var SOZLUK = (window.MaskoSozluk && window.MaskoSozluk.en) || { metin: {}, kalip: [] };
  var tam = Object.create(null);          // normalleştirilmiş TR → EN
  var kaliplar = [];                      // { re, hedef, adlar } — yer tutuculu anahtarlar
  var YER = /\{(\d+)\}/g;

  function regexKacir(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function kalipDerle(tr) {
    var parcalar = tr.split(/(\{\d+\})/), re = "^", adlar = [];
    for (var i = 0; i < parcalar.length; i++) {
      var m = /^\{(\d+)\}$/.exec(parcalar[i]);
      if (m) { re += "([\\s\\S]+?)"; adlar.push(Number(m[1])); }
      else re += regexKacir(parcalar[i]);
    }
    return { re: new RegExp(re + "$"), adlar: adlar };
  }
  // Sözlük DEĞERLERİ: mt() ile önceden çevrilip DOM'a yazılan İngilizce metin
  // gözlemciye yeniden gelir; "eksik" sayılıp geliştirici listesini kirletmesin.
  var hedefler = Object.create(null);
  function sozlukKur(metin) {
    Object.keys(metin).forEach(function (tr) {
      var n = normal(tr);
      tam[n] = metin[tr];
      hedefler[normal(metin[tr]).replace(/\{(\d+):t\}/g, "{$1}")] = 1;
      if (/\{\d+\}/.test(n)) { var k = kalipDerle(n); k.hedef = metin[tr]; k.kaynak = n; kaliplar.push(k); }
    });
    // Uzun (daha belirli) kalıplar önce denensin
    kaliplar.sort(function (a, b) { return b.kaynak.length - a.kaynak.length; });
  }
  sozlukKur(SOZLUK.metin || {});

  function normal(s) { return String(s).replace(/\s+/g, " ").trim(); }

  // "1.234" (TR binlik) → "1,234"; "12,5" (TR ondalık) → "12.5"
  function sayiEn(s) {
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) return s.replace(/\./g, ",");
    if (/^\d+,\d+$/.test(s)) return s.replace(",", ".");
    return s;
  }
  /* Çeviri şablonuna yakalanan değerleri yerleştirir. {0} değeri olduğu gibi
     koyar (dosya adı, sütun adı, hücre değeri: kullanıcı verisi çevrilmez);
     {0:t} değeri de çevirir (uygulamanın kendi Türkçe hata mesajı, tür adı). */
  function doldur(sablon, degerler, cevrilmis) {
    return sablon.replace(/\{(\d+)(:t)?\}/g, function (_, i, ceviri) {
      var kaynak = ceviri && cevrilmis ? cevrilmis : degerler;
      return kaynak[i] !== undefined ? kaynak[i] : "";
    });
  }

  var SAYI_VEYA_ISARET = /<\/?\d+\/?>|\d+(?:[.,]\d+)*/g;
  var onbellek = Object.create(null);   // normal → çeviri | null
  var eksik = Object.create(null);      // çevrilemeyen, Türkçeye benzeyen metinler (geliştirme için)
  var HARF = /[A-Za-zÇĞİÖŞÜçğıöşü]{2}/;   // eksik kaydı: en az iki harfli her çevrilemeyen metin

  /** Türkçe metnin İngilizcesi; yoksa null. Boşluklar çağırana kalır. */
  function cevir(metin) {
    var n = normal(metin);
    if (!n) return null;
    if (n in onbellek) return onbellek[n];
    var sonuc = null;
    if (n in tam) sonuc = tam[n];
    // Sayılar yer tutucuya çevrilip bakılır: "5 sayfa" → "{0} sayfa"
    // (<0>, </1>, <2/> biçim işaretleridir, sayı değil)
    var sayilar = [];
    var sayisiz = n.replace(SAYI_VEYA_ISARET, function (s) {
      if (s.charAt(0) === "<") return s;
      sayilar.push(s);
      return "{" + (sayilar.length - 1) + "}";
    });
    if (sonuc === null && sayilar.length && sayisiz in tam) sonuc = doldur(tam[sayisiz], sayilar.map(sayiEn));
    // " · " ile dizilmiş durum satırı, genel kalıplardan önce parça parça
    if (sonuc === null && n.indexOf(" · ") > 0) sonuc = noktaliParcalar(n);
    if (sonuc === null) {
      for (var i = 0; i < kaliplar.length && sonuc === null; i++) {
        var m = kaliplar[i].re.exec(n);
        if (!m) continue;
        // Yakalama bir durum satırının ya da biçim işaretinin parçasını yutamaz:
        // "{0} satır {1}" kalıbı "dosya · 5 satır · 8 kolon"u almasın.
        var yutuyor = false;
        for (var y = 1; y < m.length; y++) {
          if (/ · |<\/?\d+\/?>/.test(m[y]) && !/ · |<\/?\d+\/?>/.test(kaliplar[i].kaynak)) yutuyor = true;
        }
        if (yutuyor) continue;
        var degerler = [], cevrilmis = [];
        for (var j = 0; j < kaliplar[i].adlar.length; j++) {
          var parca = m[j + 1], ad = kaliplar[i].adlar[j];
          var sayi = /^\d+(?:[.,]\d+)*$/.test(parca);
          degerler[ad] = sayi ? sayiEn(parca) : parca;
          // Çeviri yalnız şablon {n:t} isterse yapılır (kullanıcı verisi korunur)
          cevrilmis[ad] = sayi ? sayiEn(parca) : (kaliplar[i].hedef.indexOf("{" + ad + ":t}") >= 0 ? parcaCevir(parca) : parca);
        }
        sonuc = doldur(kaliplar[i].hedef, degerler, cevrilmis);
      }
    }
    if (sonuc === null && /^\s*<\d+\/?>/.test(n)) sonuc = isaretliParcalar(n);
    if (sonuc === null) sonuc = cumleCumle(n);
    if (sonuc === null && HARF.test(n) && !(n in hedefler) && !(sayisiz in hedefler)) eksik[n] = (eksik[n] || 0) + 1;
    onbellek[n] = sonuc;
    return sonuc;
  }
  /* Kodda parça parça birleştirilen mesajlar ("A. " + "B. " + ek) sözlükte
     bütün olarak yoktur; cümle cümle çevrilir. Sözlük cümle düzeyinde yazılır.
     Biçim işaretli (<0>) birimler bölünmez: işaretler cümleler arasında
     dağılırsa bütünlük bozulur. En az bir cümle çevrilemezse sonuç yok. */
  // " · " ile dizilmiş durum satırları ("dosya.csv · 1.200 satır · 5 kolon")
  // parça parça; harfsiz ve yalnız atom işaretli (<0/>) parçalar olduğu gibi kalır.
  function noktaliParcalar(n) {
    if (/<\d+>/.test(n)) return null;
    var parcalar = n.split(" · "), sonuc = [];
    for (var p = 0; p < parcalar.length; p++) {
      if (!HARF.test(parcalar[p].replace(/<\d+\/>/g, ""))) { sonuc.push(parcalar[p]); continue; }
      var cp = cevirSessiz(parcalar[p]);
      if (cp === null) return null;
      sonuc.push(cp);
    }
    return sonuc.join(" · ");
  }

  /* Yalnız biçim işaretli parçalardan oluşan birim: "<0>~ Değişti (1)</0>"
     (td içinde tek rozet), "<0>Kaynak Örnek / Sentetik</0><1>4 / 20 satır</1>"
     (etiket + değer kutusu). Sözlük sarmasız metni tutar; her parça ayrı
     çevrilir, araya giren boşluk ve atomlar (<2/>) olduğu gibi kalır. Bir
     harfli parça çevrilemezse sonuç yok. */
  var ISARETLI_PARCA = /(\s*)(?:<(\d+)>([^<]*)<\/\2>|<\d+\/>)/y;
  function isaretliParcalar(n) {
    var cikti = "", konum = 0, adet = 0, m;
    ISARETLI_PARCA.lastIndex = 0;
    while (konum < n.length && (m = ISARETLI_PARCA.exec(n))) {
      konum = ISARETLI_PARCA.lastIndex;
      if (m[2] === undefined) { cikti += m[0]; continue; }
      adet++;
      var ic = m[3], c = ic;
      if (HARF.test(ic)) {
        c = cevirSessiz(ic);
        if (c === null) return null;
        c = ic.match(/^\s*/)[0] + c + ic.match(/\s*$/)[0];
      }
      cikti += m[1] + "<" + m[2] + ">" + c + "</" + m[2] + ">";
    }
    return konum === n.length && adet ? cikti : null;
  }

  function cumleCumle(n) {
    if (/<\/?\d+\/?>/.test(n)) return null;
    var cumleler = n.split(/(?<=[.!?…])\s+(?=\S)/);
    if (cumleler.length < 2) return null;
    var cikti = [];
    for (var i = 0; i < cumleler.length; i++) {
      var c = cevirSessiz(cumleler[i]);
      if (c === null) return null;
      cikti.push(c);
    }
    return cikti.join(" ");
  }

  // Kalıba yakalanan parça: kendisi çevrilebiliyorsa çevrilir, değilse
  // virgüllü liste ise öğe öğe; yoksa (dosya adı, kullanıcı değeri) aynen.
  function parcaCevir(p) {
    var c = cevirSessiz(p);
    if (c !== null) return c;
    if (p.indexOf(", ") > 0) {
      return p.split(", ").map(function (x) { var y = cevirSessiz(x); return y === null ? x : y; }).join(", ");
    }
    return p;
  }
  function cevirSessiz(p) {
    var onceki = Object.keys(eksik).length;
    var c = cevir(p);
    if (c === null && Object.keys(eksik).length > onceki) delete eksik[normal(p)];
    return c;
  }

  /** JS'te DOM'a gitmeyen metin için: t("Sayfa {0}", 5). Türkçede kaynak döner. */
  function t(kaynak) {
    var degerler = Array.prototype.slice.call(arguments, 1);
    var sablon = kaynak;
    if (aktif === "en") {
      var n = normal(kaynak);
      var c = n in tam ? tam[n] : cevir(kaynak);
      if (c !== null) sablon = c;
    }
    var ham = degerler.map(String);
    return doldur(sablon, ham, ham.map(function (d) { return aktif === "en" ? parcaCevir(d) : d; }));
  }

  /* ---------------- DOM birimleri ---------------- */
  var SATIR_ICI = { A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, BR: 1, CITE: 1, CODE: 1, DATA: 1, DFN: 1, EM: 1, I: 1,
    KBD: 1, MARK: 1, Q: 1, S: 1, SAMP: 1, SMALL: 1, SPAN: 1, STRONG: 1, SUB: 1, SUP: 1, TIME: 1, U: 1, VAR: 1, WBR: 1 };
  var ATOM = { BR: 1, WBR: 1, IMG: 1, SVG: 1, svg: 1, CANVAS: 1 };
  var ATLA = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, TEMPLATE: 1, IFRAME: 1, svg: 1, SVG: 1, CANVAS: 1 };
  var OZNITELIKLER = ["title", "placeholder", "aria-label", "alt"];

  var kaynakMetin = new WeakMap();   // öğe/metin düğümü → { tr: kaynak anahtar, yazilan: uygulanan anahtar }
  var kaynakOz = new WeakMap();      // öğe → { ad: { tr, yazilan } }

  function verisiMi(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.getAttribute("translate") === "no" || e.isContentEditable) return true;
    }
    return false;
  }
  /* id taşıyan satır içi öğe (sayaç, rozet, durum yazısı) ayrı birimdir: JS
     onu sonradan doldurur. Üst metne katılsaydı her güncellemede üst metnin
     çevirisi bozulurdu ("Report" + Türkçe rozet). Üst metinde <n/> olarak durur. */
  function ayriMi(el) {
    return !!el.id && !!SATIR_ICI[el.tagName];
  }
  function atomMu(el) {
    return ATOM[el.tagName] || el.getAttribute("translate") === "no" || ayriMi(el) || !/\S/.test(el.textContent);
  }
  // Öğe yalnız metin + satır içi öğe mi içeriyor (çeviri birimi olabilir mi)?
  function birimUygun(el) {
    if (ATLA[el.tagName] || el.getAttribute("translate") === "no") return false;
    var metinVar = false;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { if (/\S/.test(c.nodeValue)) metinVar = true; }
      else if (c.nodeType === 1) {
        if (!SATIR_ICI[c.tagName] && !ATOM[c.tagName]) return false;
        if (ATOM[c.tagName] || c.getAttribute("translate") === "no" || ayriMi(c)) continue;
        if (!birimUygun(c)) { if (/\S/.test(c.textContent)) return false; continue; }
        metinVar = true;
      }
    }
    return metinVar;
  }

  // Birimin anahtarı ve satır içi öğe listesi (önsıra).
  function anahtarCikar(el) {
    var ogeler = [];
    function yaz(ust) {
      var s = "";
      for (var c = ust.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeType === 1) {
          var i = ogeler.length;
          ogeler.push(c);
          s += atomMu(c) ? "<" + i + "/>" : "<" + i + ">" + yaz(c) + "</" + i + ">";
        }
      }
      return s;
    }
    return { anahtar: normal(yaz(el)), ogeler: ogeler };
  }

  // Anahtar biçimindeki metni birime uygular; asıl öğeler taşınır.
  function anahtarUygula(el, metin, ogeler) {
    var parcalar = metin.split(/(<\/?\d+\/?>)/);
    var yigin = [el], kullanilan = {};
    function bosalt(hedef) {
      while (hedef.firstChild) hedef.removeChild(hedef.firstChild);
    }
    bosalt(el);
    for (var i = 0; i < parcalar.length; i++) {
      var p = parcalar[i];
      if (!p) continue;
      var ust = yigin[yigin.length - 1];
      var m = /^<(\/?)(\d+)(\/?)>$/.exec(p);
      if (!m) { ust.appendChild(document.createTextNode(p)); continue; }
      var oge = ogeler[Number(m[2])];
      if (!oge) continue;
      if (m[1]) { if (yigin.length > 1) yigin.pop(); continue; }
      kullanilan[m[2]] = true;
      if (m[3]) { ust.appendChild(oge); continue; }   // atom: içeriği olduğu gibi
      bosalt(oge);
      ust.appendChild(oge);
      yigin.push(oge);
    }
  }

  // Bir birimi hedef dile getirir.
  function birimIsle(el) {
    var mevcut = anahtarCikar(el);
    if (!mevcut.anahtar) return;
    var kayit = kaynakMetin.get(el);
    if (kayit && mevcut.anahtar === kayit.yazilan) {
      // değişmemiş; yalnız dil değişmiş olabilir
    } else if (kayit && aktif === "en" && kaliptanKaynak(kayit, mevcut.anahtar)) {
      // JS yalnız sayıyı güncelledi ("5 kayıt" → İngilizcesi üzerinde 6); kaynak türetildi
    } else {
      kayit = { tr: mevcut.anahtar, yazilan: mevcut.anahtar };
      kaynakMetin.set(el, kayit);
    }
    var hedef = aktif === "en" ? cevir(kayit.tr) : kayit.tr;
    // Çeviri işaretlerden birini kaybetmişse uygulanmaz: JS'in tuttuğu öğe silinmesin
    if (hedef === null || isaretler(hedef) !== isaretler(kayit.tr)) hedef = kayit.tr;
    if (hedef !== mevcut.anahtar) {
      anahtarUygula(el, hedef, mevcut.ogeler);
      kayit.yazilan = normal(hedef);
    } else {
      kayit.yazilan = mevcut.anahtar;
    }
  }
  function isaretler(s) { return (s.match(/<\/?\d+\/?>/g) || []).filter(function (m) { return m[1] !== "/"; }).sort().join(","); }

  // İngilizce yazılmış birimde JS bir sayıyı değiştirdiyse Türkçe kaynağı aynı
  // sayılarla yeniden kurar (dönüşte doğru Türkçe görünsün).
  function kaliptanKaynak(kayit, yeni) {
    // Biçim işaretleri (<0>) sayı değildir; yalnız gerçek sayılar karşılaştırılır
    function kalip(s) { return s.replace(SAYI_VEYA_ISARET, function (x) { return x.charAt(0) === "<" ? x : "#"; }); }
    if (kalip(kayit.yazilan) !== kalip(yeni)) return false;
    var yeniSayilar = [];
    yeni.replace(SAYI_VEYA_ISARET, function (x) { if (x.charAt(0) !== "<") yeniSayilar.push(x); return x; });
    var i = 0;
    kayit.tr = kayit.tr.replace(SAYI_VEYA_ISARET, function (s) {
      if (s.charAt(0) === "<") return s;
      return i < yeniSayilar.length ? yeniSayilar[i++] : s;
    });
    kayit.yazilan = yeni;
    onbellek = Object.create(null);
    return true;
  }

  function metinDugumuIsle(dugum) {
    var deger = dugum.nodeValue, n = normal(deger);
    if (!n) return;
    var kayit = kaynakMetin.get(dugum);
    if (!kayit || n !== kayit.yazilan) { kayit = { tr: n, yazilan: n }; kaynakMetin.set(dugum, kayit); }
    var hedef = aktif === "en" ? cevir(kayit.tr) : kayit.tr;
    if (hedef === null) hedef = kayit.tr;
    if (hedef !== n) {
      var bas = /^\s*/.exec(deger)[0], son = /\s*$/.exec(deger)[0];
      dugum.nodeValue = bas + hedef + son;
    }
    kayit.yazilan = hedef;
  }

  function oznitelikIsle(el) {
    var harita = kaynakOz.get(el);
    for (var i = 0; i < OZNITELIKLER.length; i++) {
      var ad = OZNITELIKLER[i];
      if (!el.hasAttribute(ad)) continue;
      var deger = el.getAttribute(ad), n = normal(deger);
      if (!n) continue;
      if (!harita) { harita = {}; kaynakOz.set(el, harita); }
      var k = harita[ad];
      if (!k || n !== k.yazilan) { k = harita[ad] = { tr: n, yazilan: n }; }
      var hedef = aktif === "en" ? cevir(k.tr) : k.tr;
      if (hedef === null) hedef = k.tr;
      if (hedef !== deger) el.setAttribute(ad, hedef);
      k.yazilan = hedef;
    }
    // Düğme olarak kullanılan input'un yazısı
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type) && el.value) {
      if (!harita) { harita = {}; kaynakOz.set(el, harita); }
      var kd = harita.value;
      if (!kd || el.value !== kd.yazilan) kd = harita.value = { tr: el.value, yazilan: el.value };
      var hv = aktif === "en" ? cevir(kd.tr) : kd.tr;
      if (hv !== null && hv !== el.value) el.value = hv;
      kd.yazilan = el.value;
    }
  }

  function gez(el) {
    if (el.nodeType !== 1 || el.getAttribute("translate") === "no" || el.isContentEditable) return;
    // Metin kutusu ve çerçevenin içeriği değil, yalnız placeholder/title'ı çevrilir
    if (el.tagName === "TEXTAREA" || el.tagName === "IFRAME") { oznitelikIsle(el); return; }
    if (ATLA[el.tagName]) return;
    oznitelikIsle(el);
    if (birimUygun(el)) {
      birimIsle(el);
      // birim içindeki öğelerin öznitelikleri (title vb.) ve ayrı birimleri;
      // translate="no" öğenin title'ı da veridir (kopya değeri, hücre)
      var icler = el.getElementsByTagName("*");
      for (var k = 0; k < icler.length; k++) {
        if (verisiMi(icler[k])) continue;
        oznitelikIsle(icler[k]);
        if (ayriMi(icler[k]) && !verisiMi(icler[k]) && birimUygun(icler[k])) birimIsle(icler[k]);
      }
      return;
    }
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { if (/\S/.test(c.nodeValue)) metinDugumuIsle(c); }
      else if (c.nodeType === 1) gez(c);
    }
  }

  // Değişen düğümün ait olduğu birimi bulur (en büyük birim-uygun ata).
  function birimBul(dugum) {
    var el = dugum.nodeType === 1 ? dugum : dugum.parentElement;
    if (!el) return null;
    if (!birimUygun(el)) return dugum.nodeType === 3 ? dugum : el;
    while (!ayriMi(el) && el.parentElement && el.parentElement !== document.body && birimUygun(el.parentElement)) el = el.parentElement;
    return el;
  }

  /* ---------------- Gözlemci ---------------- */
  var gozlemci = null, yaziyor = false;
  function isle(dugum) {
    // Belgeden kopmuş düğüm atlanır: kayıt geldiğinde translate="no" atası
    // görünmez (sanal kaydırmalı tablo satırı eklenip aynı görevde yeniden
    // kurulur) ve havuzdan geri takılan satırda veri çevrilmiş kalırdı.
    // Yeniden takılınca kendi kaydı gelir.
    if (!dugum || !dugum.isConnected) return;
    if (dugum.nodeType === 3) {
      if (!dugum.parentElement || verisiMi(dugum.parentElement)) return;
      var b = birimBul(dugum);
      if (!b) return;
      if (b.nodeType === 3) metinDugumuIsle(b); else gez(b);
      return;
    }
    if (dugum.nodeType !== 1 || verisiMi(dugum)) return;
    var birim = dugum.parentElement && birimUygun(dugum.parentElement) ? birimBul(dugum) : dugum;
    if (birim && birim.nodeType === 1) gez(birim);
  }
  function kayitlariIsle(kayitlar) {
    if (aktif !== "en" && !donusVar) return;
    yaziyor = true;
    try {
      for (var i = 0; i < kayitlar.length; i++) {
        var k = kayitlar[i];
        if (k.type === "childList") {
          if (k.target.nodeType === 1 && birimUygun(k.target)) { isle(k.target); continue; }
          for (var j = 0; j < k.addedNodes.length; j++) isle(k.addedNodes[j]);
        } else if (k.type === "characterData") {
          isle(k.target);
        } else if (k.type === "attributes" && k.target.nodeType === 1 && k.target.isConnected && !verisiMi(k.target)) {
          oznitelikIsle(k.target);
        }
      }
    } catch (e) {
      if (window.console) console.warn("dil.js:", e);
    } finally {
      if (gozlemci) gozlemci.takeRecords();
      yaziyor = false;
    }
  }
  var donusVar = false;   // Türkçeye dönülmüş sayfada da kaynak kayıtları güncel kalsın
  function gozle() {
    if (gozlemci || !window.MutationObserver) return;
    gozlemci = new MutationObserver(function (k) { if (!yaziyor) kayitlariIsle(k); });
    gozlemci.observe(kok, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: OZNITELIKLER.concat(["value"]) });
  }

  function hepsiniIsle() {
    yaziyor = true;
    try {
      if (document.title) {
        var tEl = document.querySelector("title");
        if (tEl) metinDugumuIsle(tEl.firstChild || tEl.appendChild(document.createTextNode("")));
      }
      if (document.body) gez(document.body);
    } catch (e) {
      if (window.console) console.warn("dil.js:", e);
    } finally {
      if (gozlemci) gozlemci.takeRecords();
      yaziyor = false;
    }
  }

  /* ---------------- alert / confirm / prompt ---------------- */
  function mesajCevir(m) {
    if (aktif !== "en" || m === undefined || m === null) return m;
    var s = String(m);
    var c = cevir(s);
    if (c !== null) return c;
    return s.split("\n").map(function (satir) { var x = cevir(satir); return x === null ? satir : x; }).join("\n");
  }
  ["alert", "confirm", "prompt"].forEach(function (ad) {
    var asil = window[ad];
    if (typeof asil !== "function") return;
    window[ad] = function (mesaj) {
      var arg = Array.prototype.slice.call(arguments);
      arg[0] = mesajCevir(mesaj);
      return asil.apply(window, arg);
    };
  });

  /* ---------------- Seçici ve dil değişimi ---------------- */
  var dinleyiciler = [];
  function seciciGuncelle() {
    var dugmeler = document.querySelectorAll("[data-dil-secici] [data-dil]");
    for (var i = 0; i < dugmeler.length; i++) {
      var secili = dugmeler[i].getAttribute("data-dil") === aktif;
      dugmeler[i].setAttribute("aria-checked", secili ? "true" : "false");
      dugmeler[i].tabIndex = secili ? 0 : -1;
    }
  }
  function uygula(dil) {
    if (!GECERLI[dil]) dil = tarayiciDili();
    var degisti = dil !== aktif;
    aktif = dil;
    kok.setAttribute("lang", dil);
    if (dil === "tr") donusVar = true;
    onbellek = Object.create(null);
    hepsiniIsle();
    seciciGuncelle();
    if (degisti) dinleyiciler.forEach(function (f) { try { f(dil); } catch (e) { /* dinleyici hatası dili bozmasın */ } });
  }
  function ayarla(dil) {
    if (!GECERLI[dil]) return;
    try { window.localStorage.setItem(ANAHTAR, dil); } catch (e) { /* yalnız bu sayfada */ }
    // Sohbet sitelerindeki kumanda uzantı localStorage'ını göremez; seçim
    // storage.local'a da yazılır, service worker açık sekmelere iletir.
    try {
      if (window.chrome && chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id) {
        chrome.storage.local.set({ masko_dil: dil }).catch(function () {});
      }
    } catch (e) { /* uzantı dışı (test sunucusu) */ }
    uygula(dil);
  }

  window.addEventListener("storage", function (e) {
    if (e.key === ANAHTAR || e.key === null) uygula(oku());
  });

  function bagla() {
    var gruplar = document.querySelectorAll("[data-dil-secici]");
    for (var g = 0; g < gruplar.length; g++) {
      (function (grup) {
        grup.addEventListener("click", function (e) {
          var d = e.target.closest ? e.target.closest("[data-dil]") : null;
          if (d && grup.contains(d)) ayarla(d.getAttribute("data-dil"));
        });
        grup.addEventListener("keydown", function (e) {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          var liste = Array.prototype.slice.call(grup.querySelectorAll("[data-dil]"));
          var i = liste.indexOf(document.activeElement);
          if (i < 0) return;
          e.preventDefault();
          var yeni = liste[(i + (e.key === "ArrowRight" ? 1 : -1) + liste.length) % liste.length];
          ayarla(yeni.getAttribute("data-dil"));
          yeni.focus();
        });
      })(gruplar[g]);
    }
    seciciGuncelle();
    if (aktif === "en") hepsiniIsle();
    gozle();
    kok.removeAttribute("data-dil-bekle");
  }

  // İngilizcede ilk çizimde Türkçe görünmesin: çeviri bitene dek gövde gizli.
  // Bir hata çevirmeyi durdursa da sayfa en geç 1,5 sn'de görünür.
  if (aktif === "en" && document.readyState === "loading") {
    kok.setAttribute("data-dil-bekle", "");
    var stil = document.createElement("style");
    stil.textContent = "html[data-dil-bekle] body{visibility:hidden}";
    (document.head || kok).appendChild(stil);
    setTimeout(function () { kok.removeAttribute("data-dil-bekle"); }, 1500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bagla);
  else bagla();

  window.MaskoDil = {
    dil: function () { return aktif; },
    ayarla: ayarla,
    t: t,
    cevir: function (s) { return aktif === "en" ? cevir(s) : null; },
    degisince: function (f) { dinleyiciler.push(f); },
    // Geliştirme: çevrilemeyen Türkçe metinler
    eksikler: function () { return Object.keys(eksik); },
    // Geliştirme/test: verilen kökteki birim anahtarları (Türkçe kaynak)
    birimler: function (kokEl) {
      var liste = [];
      (function topla(el) {
        if (el.nodeType !== 1 || el.getAttribute("translate") === "no") return;
        OZNITELIKLER.forEach(function (ad) { if (el.hasAttribute(ad) && normal(el.getAttribute(ad))) liste.push(normal(el.getAttribute(ad))); });
        if (ATLA[el.tagName]) return;
        if (birimUygun(el)) { var k = kaynakMetin.get(el); liste.push(k ? k.tr : anahtarCikar(el).anahtar); return; }
        for (var c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3 && /\S/.test(c.nodeValue)) { var kk = kaynakMetin.get(c); liste.push(kk ? kk.tr : normal(c.nodeValue)); }
          else if (c.nodeType === 1) topla(c);
        }
      })(kokEl || document.body);
      return liste;
    }
  };
})();
