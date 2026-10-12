/* =====================================================
   SOHBET ENJEKSİYONU — ÇEKİRDEK
   =====================================================
   AI sohbet sitelerinin kendi metin kutusunun yanına bir
   "Maskele" butonu koyar. Kullanıcı kopyala-yapıştır
   köprüsüne (popup → pano → site) gerek kalmadan, yazdığı
   yerde maskeler.

   ADAPTER SÖZLEŞMESİ
   ------------------
   Site başına bilgi mümkün olan en küçük yüzeye hapsedilir;
   her adapter yalnızca iki şey söyler:

     window.MaskelemeInjector.start({
       id: "chatgpt",
       findComposer: function(){ ... },          // metin kutusu | null
       findToolbar: function(composerEl){ ... }  // buton nereye | null
     });

   Metin okuma/yazma, buton üretimi, yeniden enjeksiyon ve
   hata yönetimi burada merkezî. Bir site DOM'unu
   değiştirdiğinde bozulan tek dosya o sitenin adapter'ı olur.
   ===================================================== */

(function () {
  "use strict";

  var LOG = "[Maskeleme İstasyonu]";
  var SOZLUK_ANAHTARI = "maskeleme_istasyonu_sozluk_v1";   // mask-engine.js:4 ile aynı olmalı

  if (window.MaskelemeInjector) return;   // content script iki kez çalışırsa

  /* ---------- KUMANDA DİLİ ----------
     Arayüz dili uzantının ayarından gelir (masko-ayar.dil); gelene kadar
     tarayıcı dili. Sohbet sitesinde dil.js ve büyük sözlük yüklenmez: kumanda
     metinleri az, burada. k("{0} aday kaldı", 3) gibi; Türkçede kaynak döner. */
  var kumandaDili = /^tr\b/i.test((typeof navigator !== "undefined" && navigator.language) || "tr") ? "tr" : "en";
  var dilDinleyicileri = [];
  var KUMANDA_EN = {
    "Maskele": "Mask", "Aç": "Unmask", "Seçimi Maskele": "Mask selection", "Seçimi Aç": "Unmask selection",
    "Sürükleyip istediğiniz yere sabitleyin": "Drag to pin it wherever you like", "Sürükle": "Drag",
    "Hassas verileri maskele. Metnin bir kısmını seçerseniz sadece onu maskeler. Mesajı göndermez.":
      "Mask sensitive data. If you select part of the text, only that part is masked. Doesn't send the message.",
    "Placeholder'ları gerçek değerlere çevir. Yazı kutusunda yerinde açar; AI cevabından seçim yaptıysanız açılmış hâlini panelde gösterir.":
      "Turn placeholders back into real values. Unmasks in place in the text box; if you selected part of the AI's answer, shows the unmasked version in a panel.",
    "Aktif maskeleme projesi": "Active masking project",
    "Gönderilmemiş hassas veri algılandı. Tıklayarak maskeleyin.": "Unsent sensitive data detected. Click to mask.",
    "Hassas veri": "Sensitive data", "Otomatik konuma geri dön": "Return to the automatic position",
    "Küçük rozete dönüştür": "Shrink to a small badge", "Masko (genişletmek için tıklayın)": "Masko (click to expand)",
    "Masko İstasyonu (Genişletmek için tıklayın)": "Masko Station (click to expand)",
    "{0} hassas veri ({1})": "{0} sensitive items ({1})",
    "{0} adet gönderilmemiş hassas veri tespit edildi ({1} vb.). Tıklayarak maskeleyin.": "{0} unsent sensitive items detected ({1} etc.). Click to mask.",
    "{0} adet hassas veri tespit edildi. Tıklayarak açın.": "{0} sensitive items detected. Click to open.",
    "{0} hassas veri — göndermek için tekrar basın": "{0} sensitive items — press again to send",
    "{0} adet maskelenmemiş hassas veri ({1} vb.). Maskele'ye basın ya da olduğu gibi göndermek için gönderme tuşuna yeniden basın.":
      "{0} unmasked sensitive items ({1} etc.). Press Mask, or press the send key again to send as is.",
    "Proje: {0}": "Project: {0}", "Aktif maskeleme projesi: {0}": "Active masking project: {0}", "Genel": "General",
    "Maskesi açılmış hâli": "Unmasked version", "Kapat": "Close", "Kopyala": "Copy", "Kopyalandı ✓": "Copied ✓",
    "Kopyalanamadı — metni seçip Ctrl+C": "Could not copy — select the text and press Ctrl+C",
    "Kutu boş": "The box is empty", "Sözlük kaydedilemedi": "Could not save the dictionary",
    "Metin değişti; yeniden maskeleyin": "The text changed; mask again", "Hassas veri yok": "No sensitive data",
    "{0} aday kaldı — inceleyin": "{0} candidates left — review", "Seçim maskelendi · inceleyin": "Selection masked · review",
    "Maskelendi · inceleyin": "Masked · review", "Placeholder yok": "No placeholders", "Açıldı": "Unmasked",
    "Açılacak bir şey yok": "Nothing to unmask", "Panelde açıldı": "Unmasked in the panel",
    "Metin değişti; yeniden deneyin": "The text changed; try again", "Karşılığı bulunamadı": "No match found",
    "Sözlüğe erişilemedi": "Could not reach the dictionary",
    "Maskelenemedi; yapıştırma yapılmadı": "Could not mask; nothing was pasted",
    "Yazı kutusu kayboldu; yapıştırma yapılmadı": "The text box disappeared; nothing was pasted",
    "{0} veri maskelenerek yapıştırıldı": "{0} items pasted masked", "Hassas veri maskelenerek yapıştırıldı": "Sensitive data pasted masked",
    // Tür adları (MaskEngine.TYPE_LABELS)
    "manuel": "manual", "kod": "code", "metin": "text", "seçim": "selection", "iban": "IBAN", "e-posta": "email",
    "telefon": "phone", "ssn": "SSN", "kredi kartı": "credit card", "tckn": "Turkish ID", "tutar": "amount", "tarih": "date",
    "kep adresi": "KEP address", "uuid": "UUID", "mac adresi": "MAC address", "ip adresi": "IP address",
    "kripto cüzdan": "crypto wallet", "yabancı kimlik no": "foreign ID no", "vergi kimlik no": "tax ID no", "imei": "IMEI",
    "plaka": "licence plate", "kişi adı": "person name", "adres": "address", "jwt": "JWT", "gizli anahtar": "secret key",
    "pasaport no": "passport no", "kurum kodu": "institution code", "kullanıcı adı": "username", "swift/bic": "SWIFT/BIC",
    "konum": "location", "ssh anahtarı": "SSH key", "hesap no": "account no", "şirket": "company"
  };
  function k(kaynak) {
    var degerler = Array.prototype.slice.call(arguments, 1);
    var sablon = kaynak;
    if (kumandaDili === "en") {
      if (KUMANDA_EN[kaynak]) sablon = KUMANDA_EN[kaynak];
      else {
        // Sayı içeren hazır metin: "3 veri maskelenerek yapıştırıldı"
        var sayilar = [];
        var anahtar = String(kaynak).replace(/\d+/g, function (s) { sayilar.push(s); return "{" + (sayilar.length - 1) + "}"; });
        if (sayilar.length && KUMANDA_EN[anahtar]) { sablon = KUMANDA_EN[anahtar]; degerler = sayilar; }
      }
    }
    return String(sablon).replace(/\{(\d+)\}/g, function (_, i) { return degerler[i] !== undefined ? degerler[i] : ""; });
  }
  function kTur(tip) {
    var etiket = (window.MaskEngine && window.MaskEngine.TYPE_LABELS && window.MaskEngine.TYPE_LABELS[tip]) || tip;
    return k(etiket);
  }
  function kumandaDiliniAyarla(dil) {
    if ((dil !== "tr" && dil !== "en") || dil === kumandaDili) return;
    kumandaDili = dil;
    dilDinleyicileri.forEach(function (f) { try { f(); } catch (e) { /* tek kumanda bozulsa da diğerleri yenilensin */ } });
  }

  /* ---------- MOTOR HAZIRLIĞI ---------- */

  var motorHazir = false;

  // Ortak sözlük asenkron yüklenir. Demo temizliği yalnız bağımsız HTML testleri içindir.
  async function motoruHazirla() {
    if (motorHazir) return true;
    if (!window.MaskEngine || typeof window.MaskEngine.maskText !== "function") {
      console.warn(LOG + " mask-engine.js yüklenmemiş, enjeksiyon iptal.");
      return false;
    }

    var oncedenVarMi = false;
    try { oncedenVarMi = !!window.localStorage.getItem(SOZLUK_ANAHTARI); } catch (e) {}

    await window.MaskEngine.init();
    var uzanti = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
    if (!uzanti && !oncedenVarMi && typeof window.MaskEngine.clearGlossary === "function") {
      await window.MaskEngine.clearGlossary();
    }

    motorHazir = true;
    return true;
  }

  /* ---------- GÖRÜNÜRLÜK ---------- */

  /* Bu siteler aynı anda birden fazla composer tutabiliyor (ör. ChatGPT'de
     gizli bir mobil <textarea> ile görünür masaüstü editörü bir arada).
     Gizli olanı okursak metin boş görünür — "Kutu boş" hatasının sebebi
     buydu. Adapter'lar aday elemanları bu süzgeçten geçirmeli.

     ASGARİ BOYUT ŞART: Bazı editörler görünmez yardımcı elemanları
     DOM'da tutuyor ve bunlar display/visibility testinden geçiyor —
     Gemini'nin Quill'i 0x1 boyutunda bir ".ql-clipboard" div'i tutuyor.
     Kullanıcının yazdığı gerçek kutu her zaman bundan büyüktür. */
  var ASGARI_EN = 40, ASGARI_BOY = 10;

  function gorunurMu(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < ASGARI_EN || r.height < ASGARI_BOY) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  /* ---------- METİN OKUMA / YAZMA ---------- */

  function metniOku(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value;
    return el.innerText || el.textContent || "";
  }

  /* Composer içindeki seçili metni döner (yoksa ""). */
  function secimiOku(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      if (el.selectionStart == null || el.selectionStart === el.selectionEnd) return "";
      return el.value.slice(el.selectionStart, el.selectionEnd).trim();
    }
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return "";
    // Seçim gerçekten bu composer'ın içinde mi — sayfanın başka yerindeki
    // seçimi yanlışlıkla sözlüğe eklemeyelim.
    if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return "";
    return sel.toString().trim();
  }

  /* React, value'yu kendi izleyicisiyle (value tracker) senkron tutar;
     el.value = x ataması bu izleyiciyi güncellemediği için bir sonraki
     render'da sessizce geri alınır. Prototip üzerindeki NATIVE setter'ı
     çağırıp ardından gerçek bir input olayı yollamak, React'in değişikliği
     normal DOM akışından duymasını sağlar. */
  /* Kendi yazma işlemimiz sırasında gözlemci çalışmasın: Quill/ProseMirror
     tek bir insertText'te onlarca mutasyon üretiyor, her biri bizi yeniden
     tarayıcıya sokuyordu. */
  var yaziyorMu = false;

  function metniYaz(el, metin) {
    yaziyorMu = true;
    try { _metniYaz(el, metin); }
    finally { setTimeout(function () { yaziyorMu = false; }, 50); }
  }

  function _metniYaz(el, metin) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      var proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      var nativeSetter = Object.getOwnPropertyDescriptor(proto, "value").set;
      nativeSetter.call(el, metin);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    /* contenteditable editörler (ProseMirror/Lexical/Slate ailesi):
       textContent ataması editörün İÇ belge modelini güncellemediği için
       sonraki tuşa basışta içerik eski hâline dönebiliyor. execCommand
       tarayıcının native metin ekleme hattından geçer, editörler de
       beforeinput/input olaylarını o hattan dinler.

       selectAll yerine Range kullanıyoruz: selectAll odak tam yerinde
       değilse belgenin tamamını seçebiliyor, Range ise yalnızca bu
       elemanın içeriğini hedefler. */
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertText", false, metin);
  }

  /* Sayfanın herhangi bir yerindeki seçimi döner; seçimin composer içinde
     olup olmadığını da söyler. AI'ın cevabı composer dışında olduğu için
     secimiOku() (composer'a hapsolmuş) burada yetmiyor. */
  function sayfaSeciminiOku(composer) {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var metin = sel.toString().trim();
    if (!metin) return null;
    var icinde = !!(composer && composer.contains(sel.anchorNode) && composer.contains(sel.focusNode));
    return { metin: metin, composerIcinde: icinde };
  }

  /* mask-engine.js placeholder biçimi: [ÖNEK_sayı] — ör. [TCKN_1], [EPOSTA_3] */
  var PLACEHOLDER_KALIP = /\[[A-ZÇĞİÖŞÜ0-9_]+_\d+\]/;
  function placeholderVarMi(metin) {
    return PLACEHOLDER_KALIP.test(metin || "");
  }
  function placeholderlar(metin) {
    return String(metin || "").match(/\[[A-ZÇĞİÖŞÜ0-9_]+_\d+\]/g) || [];
  }

  /* Bu sekmede kendi "Maskele" düğmemizin yazı kutusuna yazdığı placeholder'lar.
     Yazı kutusunda YERİNDE açma yalnızca bunlar için yapılır: gerçek değer,
     kullanıcının zaten bu kutuya yazmış olduğu değerdir. Sayfanın kendisinin
     kutuya koyduğu placeholder'lar ([TCKN_1] … [TCKN_50] gibi) yerinde
     açılırsa, sözlükteki — başka sitelerde maskelenmiş olanlar dahil — gerçek
     değerler sitenin okuyabildiği DOM'a yazılırdı. Onlar kapalı panelde açılır. */
  // Yapıştırma kalkanı (document_start) aynı kümeyi doldurur: yapıştırılırken
  // maskelenen değerler de "bizim" sayılır ve kutuda yerinde açılabilir.
  var buSekmedeMaskelenen = window.__maskoSekmeYerTutuculari ||
    (window.__maskoSekmeYerTutuculari = new Set());

  /* Gönderilmemiş hassas veri: inspectSensitive kullanıcının hariç tutma
     listesine uyar ve placeholder'ları atlar. (Eskiden detectCandidates
     sonucu var olmayan c.raw alanıyla süzülüyordu; placeholder süzgeci hiç
     çalışmıyor, hariç tutulan değerler de sürekli uyarı üretiyordu.) */
  function gonderilmemisBulgular(metin) {
    if (!metin || metin.length < 5 || !window.MaskEngine || typeof window.MaskEngine.inspectSensitive !== "function") return [];
    return window.MaskEngine.inspectSensitive(metin).filter(function (b) {
      return b.confidence === "high" || b.confidence === "medium";
    });
  }

  /* ---------- AÇMA PANELİ ----------
     Sitenin mesaj DOM'una dokunmadan, açılmış metni gösteren kendi
     panelimiz. body'ye ayrı bir shadow host olarak eklenir: hem sitenin
     CSS'inden izole olur hem de araç çubuğunun overflow kırpmasına
     takılmaz. */
  var panelHost = null;
  var panelKok = null;

  function panelGoster(metin, yakinHost) {
    if (!panelHost) {
      panelHost = document.createElement("div");
      panelHost.setAttribute("data-maskeleme-panel", "");
      panelHost.style.cssText = "position:fixed;z-index:2147483647;left:0;top:0";
      // Kapalı kök: panel maskesi açılmış GERÇEK değerleri gösterir. Açık kökte
      // sitenin kendi JS'i panelHost.shadowRoot üzerinden bunları okuyabilirdi.
      var pk = panelKok = panelHost.attachShadow({ mode: "closed" });
      pk.innerHTML =
        '<style>' +
        ':host{color-scheme:light;--ms-surface:#fff;--ms-ink:#1c2024;--ms-muted:#5f6670;' +
        '--ms-rule:#ddd9cf;--ms-reveal:#2c6b5e;--ms-reveal-soft:#dfeae5;--ms-focus:#2c6b5e}' +
        '@media (prefers-color-scheme:dark){:host{color-scheme:dark;--ms-surface:#1b1f24;' +
        '--ms-ink:#e9e6df;--ms-muted:#9aa1a8;--ms-rule:#2b3036;' +
        '--ms-reveal:#6fb3a2;--ms-reveal-soft:#1f312d;--ms-focus:#6fb3a2}}' +
        '.kutu{font:400 13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;' +
        'max-width:min(460px,90vw);max-height:40vh;overflow:auto;background:var(--ms-surface);color:var(--ms-ink);' +
        'border:1px solid var(--ms-rule);border-left:3px solid var(--ms-reveal);border-radius:8px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.18);padding:12px 14px}' +
        '.bas{display:flex;align-items:center;gap:8px;margin-bottom:8px;' +
        'font:700 11px/1 system-ui;letter-spacing:.04em;text-transform:uppercase;color:var(--ms-reveal)}' +
        '.bas .x{margin-left:auto;cursor:pointer;font-size:16px;line-height:1;color:var(--ms-muted);' +
        'background:none;border:0;padding:2px 4px}' +
        '.metin{white-space:pre-wrap;word-break:break-word}' +
        '.alt{margin-top:10px;display:flex;gap:8px}' +
        '.alt button{font:600 12px/1 system-ui;padding:6px 10px;border-radius:6px;cursor:pointer;' +
        'background:var(--ms-reveal-soft);color:var(--ms-reveal);border:1px solid var(--ms-reveal)}' +
        'button:focus-visible{outline:2px solid var(--ms-focus);outline-offset:2px}' +
        '</style>' +
        '<div class="kutu"><div class="bas"><span>Maskesi açılmış hâli</span>' +
        '<button class="x" type="button" aria-label="Kapat">×</button></div>' +
        '<div class="metin"></div>' +
        '<div class="alt"><button class="kopyala" type="button">Kopyala</button></div></div>';

      function panelDiliniYaz() {
        pk.querySelector(".bas span").textContent = k("Maskesi açılmış hâli");
        pk.querySelector(".x").setAttribute("aria-label", k("Kapat"));
        pk.querySelector(".kopyala").textContent = k("Kopyala");
      }
      panelDiliniYaz();
      dilDinleyicileri.push(panelDiliniYaz);

      pk.querySelector(".x").addEventListener("click", panelKapat);
      pk.querySelector(".kopyala").addEventListener("click", function (e) {
        if (!e.isTrusted) return;
        var b = pk.querySelector(".kopyala");
        var t = pk.querySelector(".metin").textContent;
        // writeText bir Promise döner; eskiden sonucu beklenmeden "Kopyalandı"
        // yazılıyordu. Sayfa pano iznini engellediyse kullanıcı boş panoyla
        // yapıştırıp neden olmadığını anlamıyordu.
        function bildir(metin) {
          b.textContent = k(metin);
          setTimeout(function () { b.textContent = k("Kopyala"); }, 1800);
        }
        var yazim;
        try { yazim = navigator.clipboard.writeText(t); }
        catch (e) { yazim = Promise.reject(e); }
        Promise.resolve(yazim).then(function () { bildir("Kopyalandı ✓"); }, function (e) {
          console.warn(LOG + " panoya kopyalanamadı:", e);
          bildir("Kopyalanamadı — metni seçip Ctrl+C");
        });
      });
      document.body.appendChild(panelHost);

      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") panelKapat();
      });
    }

    panelKok.querySelector(".metin").textContent = metin;
    panelHost.style.display = "";

    // Butonun hemen üstüne konumlandır, ekran dışına taşırma
    var r = yakinHost.getBoundingClientRect();
    panelHost.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 480)) + "px";
    panelHost.style.top = "0px";
    var y = r.top - panelHost.getBoundingClientRect().height - 10;
    panelHost.style.top = (y < 8 ? r.bottom + 10 : y) + "px";
  }

  function panelKapat() {
    if (panelHost) panelHost.style.display = "none";
    // Gizlemek yetmez: açılmış metin DOM'da kalmasın.
    if (panelKok) panelKok.querySelector(".metin").textContent = "";
  }

  /* ---------- BUTON ---------- */

  /* Shadow DOM: host sayfanın CSS'i butonu bozmasın, butonun stili de
     host sayfaya sızmasın. */
  /* ---------- BUTON ---------- */

  /* Shadow DOM: host sayfanın CSS'i butonu bozmasın, butonun stili de
     host sayfaya sızmasın. */
  function butonUret(adapter, composerAl, durum, onKonumGuncelle) {
    durum = durum || {};
    var host = document.createElement("span");
    host.setAttribute("data-maskeleme-enjekte", adapter.id);
    host.style.display = "inline-flex";
    host.style.alignItems = "center";

    var STORAGE_KEY_POS = "maskeleme_widget_pos_" + adapter.id;
    var STORAGE_KEY_COLLAPSED = "maskeleme_widget_collapsed";

    var kok = host.attachShadow({ mode: "open" });
    kok.innerHTML =
      '<style>' +
      ':host{color-scheme:light;--ms-surface:#faf9f5;--ms-rule:#ddd9cf;--ms-muted:#5f6670;--ms-ink:#1c2024;' +
      '--ms-mask:#b23b2a;--ms-mask-hover:#94301f;--ms-mask-ink:#fff;' +
      '--ms-reveal:#2c6b5e;--ms-reveal-hover:#225449;--ms-reveal-ink:#fff;' +
      '--ms-warn:#7a5309;--ms-warn-ink:#fff;--ms-focus:#2c6b5e}' +
      '@media (prefers-color-scheme:dark){:host{color-scheme:dark;--ms-surface:#20252b;' +
      '--ms-rule:#3b434b;--ms-muted:#b5bdc5;--ms-ink:#e9e6df;--ms-mask:#e2705d;' +
      '--ms-mask-hover:#f08a79;--ms-mask-ink:#1a0e0c;--ms-reveal:#6fb3a2;' +
      '--ms-reveal-hover:#8bccbb;--ms-reveal-ink:#0d1a17;--ms-warn:#d8ad6a;' +
      '--ms-warn-ink:#1a160e;--ms-focus:#6fb3a2}}' +
      '.kumanda{display:inline-flex;align-items:center;gap:4px;padding:3px 6px;' +
      'background:var(--ms-surface);border:1px solid var(--ms-rule);border-radius:9px;' +
      'box-shadow:0 3px 12px rgba(0,0,0,.15);touch-action:none;user-select:none}' +
      '.tutamac{cursor:grab;padding:2px 4px;color:var(--ms-muted);font:600 13px system-ui;' +
      'display:inline-flex;align-items:center;opacity:.65;transition:opacity .15s}' +
      '.tutamac:hover{opacity:1}' +
      '.tutamac:active{cursor:grabbing}' +
      'button{all:initial;font:600 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'display:inline-flex;align-items:center;justify-content:center;padding:7px 11px;' +
      'border-radius:6px;cursor:pointer;border:1px solid transparent;' +
      'white-space:nowrap;user-select:none}' +
      'button.maskele{background:var(--ms-mask);border-color:var(--ms-mask);color:var(--ms-mask-ink)}' +
      'button.maskele:hover{background:var(--ms-mask-hover)}' +
      'button.ac{background:var(--ms-reveal);border-color:var(--ms-reveal);color:var(--ms-reveal-ink)}' +
      'button.ac:hover{background:var(--ms-reveal-hover)}' +
      'button:focus-visible{outline:2px solid var(--ms-focus);outline-offset:2px}' +
      'button:disabled{opacity:.65;cursor:wait}' +
      'button[data-durum="ok"],button[data-durum="ok"]:hover{' +
      'background:var(--ms-reveal);border-color:var(--ms-reveal);color:var(--ms-reveal-ink)}' +
      'button[data-durum="bos"],button[data-durum="bos"]:hover{' +
      'background:var(--ms-warn);border-color:var(--ms-warn);color:var(--ms-warn-ink)}' +
      'button[data-durum="hata"],button[data-durum="hata"]:hover{' +
      'background:var(--ms-mask);border-color:var(--ms-mask);color:var(--ms-mask-ink)}' +
      '.proje{font:500 11px/1.2 system-ui;color:var(--ms-muted);max-width:105px;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px 0 8px;' +
      'border-left:1px solid var(--ms-rule)}' +
      '.on-uyari{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;' +
      'font:600 11px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;border-radius:6px;cursor:pointer;' +
      'background:var(--ms-warn);color:var(--ms-warn-ink);border:1px solid rgba(0,0,0,.15);' +
      'margin-left:2px;user-select:none;transition:filter .15s}' +
      '.on-uyari:hover{filter:brightness(1.12)}' +
      '.sifirla-btn, .katla-btn{all:initial;font:700 12px/1 system-ui,sans-serif;color:var(--ms-muted);' +
      'cursor:pointer;padding:4px 6px;border-radius:5px;display:inline-flex;' +
      'align-items:center;justify-content:center;transition:background .15s, color .15s}' +
      '.sifirla-btn:hover, .katla-btn:hover{background:rgba(0,0,0,.08);color:var(--ms-ink)}' +
      '.mini-rozet{display:inline-flex;align-items:center;justify-content:center;' +
      'width:34px;height:34px;border-radius:50%;background:var(--ms-surface);' +
      'border:1px solid var(--ms-rule);box-shadow:0 3px 12px rgba(0,0,0,.18);' +
      'cursor:pointer;position:relative;user-select:none;touch-action:none;' +
      'transition:border-color .15s}' +
      '.mini-rozet:hover{border-color:var(--ms-muted)}' +
      '.rozet-ikon{display:block;width:20px;height:20px}' +
      '.rozet-nokta{position:absolute;top:1px;right:1px;width:9px;height:9px;border-radius:50%;' +
      'background:var(--ms-mask);border:2px solid var(--ms-surface)}' +
      '</style>' +
      '<span class="kumanda"' + (durum.collapsed ? ' style="display:none"' : '') + '>' +
      '<span class="tutamac" title="Sürükleyip istediğiniz yere sabitleyin" aria-label="Sürükle">⠿</span>' +
      '<button type="button" class="maskele" title="Hassas verileri maskele. Metnin bir kısmını seçerseniz sadece onu maskeler. Mesajı göndermez.">' +
      '<span class="etiket">Maskele</span></button>' +
      '<button type="button" class="ac" title="Placeholder\'ları gerçek değerlere çevir. Yazı kutusunda yerinde açar; AI cevabından seçim yaptıysanız açılmış hâlini panelde gösterir.">' +
      '<span class="etiket">Aç</span></button>' +
      '<span class="proje" title="Aktif maskeleme projesi"></span>' +
      '<span class="on-uyari" hidden title="Gönderilmemiş hassas veri algılandı. Tıklayarak maskeleyin.">' +
      '<span class="uyari-metin">Hassas veri</span></span>' +
      '<button type="button" class="sifirla-btn"' + (durum.pinned ? '' : ' hidden') + ' title="Otomatik konuma geri dön">↺</button>' +
      '<button type="button" class="katla-btn" title="Küçük rozete dönüştür">−</button>' +
      '</span>' +
      '<div class="mini-rozet"' + (durum.collapsed ? '' : ' style="display:none"') + ' title="Masko (genişletmek için tıklayın)">' +
      // Logodaki maskeden türetilmiş işaret (emoji değil): terracotta bez, ortada dikiş, iki kulak askısı.
      '<svg class="rozet-ikon" viewBox="0 0 20 20" aria-hidden="true">' +
      '<path d="M2.2 8.6 1 7.9M17.8 8.6 19 7.9" stroke="var(--ms-ink)" stroke-width="1.3" stroke-linecap="round" fill="none"/>' +
      '<path d="M2.6 7.6C4.9 6.2 7.3 5.5 10 5.5s5.1.7 7.4 2.1v3.1c0 3.2-3.2 5.6-7.4 5.6s-7.4-2.4-7.4-5.6z" fill="var(--ms-mask)" stroke="var(--ms-ink)" stroke-width="1"/>' +
      '<path d="M10 5.8v10.3" stroke="var(--ms-surface)" stroke-width="1" opacity=".55"/>' +
      '</svg>' +
      '<span class="rozet-nokta" hidden></span>' +
      '</div>';

    var kumandaEl = kok.querySelector(".kumanda");
    var miniRozetEl = kok.querySelector(".mini-rozet");
    var tutamacEl = kok.querySelector(".tutamac");
    var sifirlaBtn = kok.querySelector(".sifirla-btn");
    var katlaBtn = kok.querySelector(".katla-btn");
    var rozetNokta = kok.querySelector(".rozet-nokta");

    var buton = kok.querySelector("button.maskele");
    var etiket = buton.querySelector(".etiket");
    var acButon = kok.querySelector("button.ac");
    var acEtiket = acButon.querySelector(".etiket");
    var projeEtiketi = kok.querySelector(".proje");
    var uyariEl = kok.querySelector(".on-uyari");
    var uyariMetin = uyariEl ? uyariEl.querySelector(".uyari-metin") : null;
    var onUyariZaman = null;

    /* Eylemler yalnızca gerçek kullanıcı etkileşimiyle çalışır. Kök açık
       olduğu için sitenin JS'i düğmelere erişip .click() çağırabilir; isTrusted
       kontrolü olmasaydı "Aç" programla tetiklenip sözlüğün tamamı sayfaya
       dökülebilirdi. */
    if(uyariEl){
      uyariEl.addEventListener("click", function(e){
        if(!e.isTrusted) return;
        maskeleCalistir();
      });
    }

    function guncelleKatlama() {
      if (durum.collapsed) {
        kumandaEl.style.display = "none";
        miniRozetEl.style.display = "inline-flex";
      } else {
        kumandaEl.style.display = "inline-flex";
        miniRozetEl.style.display = "none";
      }
    }
    host.__guncelleKatlama = guncelleKatlama;

    // Sürükleme ve sabitleme (Drag-to-Pin) mekanizması
    function baglaSurukleme(tutucuEl, isBadge) {
      var surukleniyor = false;
      var baslangicX = 0, baslangicY = 0;
      var baslangicSol = 0, baslangicUst = 0;
      var mesafe = 0;

      tutucuEl.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        surukleniyor = true;
        mesafe = 0;
        baslangicX = e.clientX;
        baslangicY = e.clientY;
        var r = host.getBoundingClientRect();
        baslangicSol = r.left;
        baslangicUst = r.top;
        try { tutucuEl.setPointerCapture(e.pointerId); } catch(err) {}
        e.preventDefault();
      });

      tutucuEl.addEventListener("pointermove", function (e) {
        if (!surukleniyor) return;
        var dx = e.clientX - baslangicX;
        var dy = e.clientY - baslangicY;
        mesafe = Math.hypot(dx, dy);
        var hostW = host.offsetWidth || (durum.collapsed ? 34 : 220);
        var hostH = host.offsetHeight || (durum.collapsed ? 34 : 36);
        var yeniSol = Math.max(6, Math.min(baslangicSol + dx, window.innerWidth - hostW - 6));
        var yeniUst = Math.max(6, Math.min(baslangicUst + dy, window.innerHeight - hostH - 6));
        host.style.left = Math.round(yeniSol) + "px";
        host.style.top = Math.round(yeniUst) + "px";
        host.style.right = "auto";
        host.style.bottom = "auto";
      });

      function bitir(e) {
        if (!surukleniyor) return;
        surukleniyor = false;
        try { tutucuEl.releasePointerCapture(e.pointerId); } catch (err) {}
        if (mesafe > 5) {
          var r = host.getBoundingClientRect();
          durum.customPos = { x: Math.round(r.left), y: Math.round(r.top), pinned: true };
          durum.pinned = true;
          // Konum yalnız arayüz tercihi; sitenin localStorage'ında durması
          // güvenlik açısından önemsiz. (storage.local içerik betiğine kapalı.)
          try { localStorage.setItem(STORAGE_KEY_POS, JSON.stringify(durum.customPos)); } catch (err) {}
          if (sifirlaBtn) sifirlaBtn.hidden = false;
        } else if (isBadge) {
          durum.collapsed = false;
          guncelleKatlama();
          try { localStorage.setItem(STORAGE_KEY_COLLAPSED, "0"); } catch (err) {}
          if (onKonumGuncelle) onKonumGuncelle();
        }
      }

      tutucuEl.addEventListener("pointerup", bitir);
      tutucuEl.addEventListener("pointercancel", bitir);
    }

    baglaSurukleme(tutamacEl, false);
    baglaSurukleme(miniRozetEl, true);

    katlaBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      durum.collapsed = true;
      guncelleKatlama();
      try { localStorage.setItem(STORAGE_KEY_COLLAPSED, "1"); } catch (err) {}
      if (onKonumGuncelle) onKonumGuncelle();
    });

    sifirlaBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      durum.pinned = false;
      durum.customPos = null;
      try { localStorage.removeItem(STORAGE_KEY_POS); } catch (err) {}
      sifirlaBtn.hidden = true;
      if (onKonumGuncelle) onKonumGuncelle();
    });

    function onUyariTara(){
      clearTimeout(onUyariZaman);
      onUyariZaman = setTimeout(async function(){
        if(!uyariEl) return;
        if(window.__MASKELEME_PREFLIGHT_ENABLED === false){
          uyariEl.hidden = true;
          rozetNokta.hidden = true;
          return;
        }
        var comp = composerAl();
        if(!comp){ uyariEl.hidden = true; rozetNokta.hidden = true; return; }
        var text = metniOku(comp);
        if(!text || !text.trim() || text.length < 5){
          uyariEl.hidden = true;
          rozetNokta.hidden = true;
          return;
        }
        try{
          var unmasked = gonderilmemisBulgular(text);
          if(unmasked.length > 0){
            var topLabel = kTur(unmasked[0].type);
            if(uyariMetin){
              uyariMetin.textContent = k("{0} hassas veri ({1})", unmasked.length, topLabel);
            }
            uyariEl.title = k("{0} adet gönderilmemiş hassas veri tespit edildi ({1} vb.). Tıklayarak maskeleyin.", unmasked.length, topLabel);
            uyariEl.hidden = false;
            rozetNokta.hidden = false;
            miniRozetEl.title = k("{0} adet hassas veri tespit edildi. Tıklayarak açın.", unmasked.length);
          } else {
            uyariEl.hidden = true;
            rozetNokta.hidden = true;
            miniRozetEl.title = k("Masko İstasyonu (Genişletmek için tıklayın)");
          }
        }catch(err){
          uyariEl.hidden = true;
          rozetNokta.hidden = true;
        }
      }, 350);
    }
    host.__onUyariTara = onUyariTara;

    // Yapıştırma kalkanının geri bildirimi Maskele düğmesinde görünür.
    // (Yalıtılmış dünyada tanımlıdır; sitenin JS'i bu fonksiyonu göremez.)
    window.__maskoBildirim = function (tur, metin) {
      geriBildir(buton, etiket, tur === "hata" ? "hata" : "ok", metin);
      if (tur !== "hata") onUyariTara();
    };

    /* Gönderim durdurulduğunda kullanıcıya NEDEN durduğunu söyler. Rozet
       modundaysa kumanda açılır (kalıcı tercihe yazılmadan), yoksa uyarı
       küçük bir noktada kaybolurdu. */
    host.__gonderimDurduruldu = function(bulgular){
      var etiketAd = kTur(bulgular[0].type);
      if(durum.collapsed){ durum.collapsed = false; guncelleKatlama(); }
      if(uyariMetin){ uyariMetin.textContent = k("{0} hassas veri — göndermek için tekrar basın", bulgular.length); }
      uyariEl.title = k("{0} adet maskelenmemiş hassas veri ({1} vb.). Maskele'ye basın ya da olduğu gibi göndermek için gönderme tuşuna yeniden basın.",
        bulgular.length, etiketAd);
      uyariEl.hidden = false;
      rozetNokta.hidden = false;
      if(onKonumGuncelle) onKonumGuncelle();
    };

    function projeyiGoster(){
      if(!window.MaskEngine.getWorkspaces) return;
      var info = window.MaskEngine.getWorkspaces();
      var active = info.items.find(function(item){ return item.id === info.activeId; });
      var projeAdi = active ? active.name : k("Genel");
      projeEtiketi.textContent = k("Proje: {0}", projeAdi);
      projeEtiketi.title = k("Aktif maskeleme projesi: {0}", projeAdi);
    }
    projeyiGoster();
    if(window.MaskEngine.onStateChange) window.MaskEngine.onStateChange(projeyiGoster);

    // Sabit metinler: kuruluşta ve arayüz dili değişince yazılır
    function dilYenile() {
      tutamacEl.title = k("Sürükleyip istediğiniz yere sabitleyin");
      tutamacEl.setAttribute("aria-label", k("Sürükle"));
      buton.title = k("Hassas verileri maskele. Metnin bir kısmını seçerseniz sadece onu maskeler. Mesajı göndermez.");
      acButon.title = k("Placeholder'ları gerçek değerlere çevir. Yazı kutusunda yerinde açar; AI cevabından seçim yaptıysanız açılmış hâlini panelde gösterir.");
      sifirlaBtn.title = k("Otomatik konuma geri dön");
      katlaBtn.title = k("Küçük rozete dönüştür");
      if (uyariEl && uyariEl.hidden) {
        uyariEl.title = k("Gönderilmemiş hassas veri algılandı. Tıklayarak maskeleyin.");
        if (uyariMetin) uyariMetin.textContent = k("Hassas veri");
        miniRozetEl.title = k("Masko (genişletmek için tıklayın)");
      }
      buton.__varsayilanEtiket = k("Maskele");
      acButon.__varsayilanEtiket = k("Aç");
      if (!buton.hasAttribute("data-durum")) etiket.textContent = buton.__varsayilanEtiket;
      if (!acButon.hasAttribute("data-durum")) acEtiket.textContent = acButon.__varsayilanEtiket;
      projeyiGoster();
    }
    dilYenile();
    dilDinleyicileri.push(dilYenile);
    var bekleyenSecim = "";
    var bekleyenAcSecim = null;   // { metin, composerIcinde }

    /* Seçimi mousedown'da yakalıyoruz: butona tıklamak odağı composer'dan
       alır ve contenteditable'da seçim çöker. preventDefault odağın hiç
       taşınmamasını sağlar, böylece seçim tıklamadan sonra da yaşar. */
    buton.addEventListener("mousedown", function (e) {
      e.preventDefault();
      bekleyenSecim = secimiOku(composerAl());
    });

    buton.addEventListener("click", function (e) {
      if (!e.isTrusted) return;
      maskeleCalistir();
    });

    async function maskeleCalistir() {
      var composer = composerAl();
      if (!composer) return;

      var ham = metniOku(composer);
      if (!ham.trim()) { geriBildir(buton, etiket, "bos", "Kutu boş"); return; }

      /* Seçili metin varsa önce sözlüğe "secim" tipiyle eklenir; maskText
         onu da değiştirir. Böylece otomatik tespitin yakalayamadığı
         şeyler (kişi adı, şirket-içi kod) maskelenebilir ve aynı terim
         sonraki mesajlarda da aynı placeholder'ı alır. index.js'teki
         "Seçili metni maskeye ekle" ile aynı semantik. */
      var secim = bekleyenSecim;
      bekleyenSecim = "";
      var maskeli;
      buton.disabled = acButon.disabled = true;
      try {
        if(!await motoruHazirla()) return;
        projeyiGoster();
        if(secim) await window.MaskEngine.addTerm(secim, "secim");
        maskeli = await window.MaskEngine.maskText(ham);
      } catch (e) {
        geriBildir(buton, etiket, "hata", e.message || "Sözlük kaydedilemedi");
        return;
      } finally {
        buton.disabled = acButon.disabled = false;
      }

      if(!composer.isConnected || metniOku(composer) !== ham){
        geriBildir(buton, etiket, "bos", "Metin değişti; yeniden maskeleyin");
        return;
      }
      if (maskeli === ham) { geriBildir(buton, etiket, "bos", "Hassas veri yok"); return; }

      var oncekiler = new Set(placeholderlar(ham));
      placeholderlar(maskeli).forEach(function (p) {
        if (!oncekiler.has(p)) buSekmedeMaskelenen.add(p);
      });
      metniYaz(composer, maskeli);
      var kalan = window.MaskEngine.inspectSensitive ? window.MaskEngine.inspectSensitive(maskeli) : [];
      geriBildir(buton, etiket, kalan.length ? "bos" : "ok", kalan.length ?
        (kalan.length + " aday kaldı — inceleyin") : (secim ? "Seçim maskelendi · inceleyin" : "Maskelendi · inceleyin"));
      composer.focus();   // kullanıcı gönder tuşuna kendi bassın diye odak geri döner
    }

    /* ---- AÇ (maskeyi geri al) ----
       İki ayrı senaryo, tek buton:
         • Seçim composer DIŞINDA (tipik olarak AI'ın cevabı) → sitenin mesaj
           DOM'una DOKUNMADAN, açılmış hâli ayrı bir panelde gösterilir.
           Yerinde değiştirmek riskli olurdu: React yeniden çizince geri
           döner ve gerçek veriyi sayfaya yazmış oluruz.
         • Seçim composer içinde ya da hiç seçim yok → kendi metnimiz,
           kutuda yerinde açılır (göndermeden vazgeçme durumu). */
    acButon.addEventListener("mousedown", function (e) {
      e.preventDefault();
      bekleyenAcSecim = sayfaSeciminiOku(composerAl());
    });

    acButon.addEventListener("click", async function (e) {
      if (!e.isTrusted) return;
      var secim = bekleyenAcSecim;
      bekleyenAcSecim = null;
      buton.disabled = acButon.disabled = true;
      try {
      if(!await motoruHazirla()) return;

      // 1) Composer dışı seçim → panel
      if (secim && secim.metin && !secim.composerIcinde) {
        if (!placeholderVarMi(secim.metin)) {
          geriBildir(acButon, acEtiket, "bos", "Placeholder yok");
          return;
        }
        panelGoster(await window.MaskEngine.unmaskText(secim.metin), host);
        geriBildir(acButon, acEtiket, "ok", "Açıldı");
        return;
      }

      // 2) Kendi metnimiz → kutuda yerinde aç
      var composer = composerAl();
      if (!composer) return;
      var ham = metniOku(composer);
      if (!placeholderVarMi(ham)) {
        geriBildir(acButon, acEtiket, "bos", "Açılacak bir şey yok");
        return;
      }
      // Kutudaki placeholder'ları bu sekmede biz yazmadıysak gerçek değerleri
      // sitenin DOM'una yazma; kapalı panelde göster.
      var yabanci = placeholderlar(ham).some(function (p) { return !buSekmedeMaskelenen.has(p); });
      if (yabanci) {
        panelGoster(await window.MaskEngine.unmaskText(ham), host);
        geriBildir(acButon, acEtiket, "ok", "Panelde açıldı");
        return;
      }
      var acik = await window.MaskEngine.unmaskText(ham);
      if(!composer.isConnected || metniOku(composer) !== ham){
        geriBildir(acButon, acEtiket, "bos", "Metin değişti; yeniden deneyin");
        return;
      }
      if (acik === ham) { geriBildir(acButon, acEtiket, "bos", "Karşılığı bulunamadı"); return; }
      metniYaz(composer, acik);
      geriBildir(acButon, acEtiket, "ok", "Açıldı");
      composer.focus();
      } catch(e) {
        geriBildir(acButon, acEtiket, "hata", e.message || "Sözlüğe erişilemedi");
      } finally {
        buton.disabled = acButon.disabled = false;
      }
    });

    /* Seçim varken etiketleri değiştir — özelliğin keşfedilebilir olması için.
       Host ömür boyu bir kez üretildiği için bu dinleyici de bir kez bağlanır. */
    var etiketZaman = null;
    function secimDinleyici() {
      clearTimeout(etiketZaman);
      etiketZaman = setTimeout(function () {
        var composer = composerAl();
        if (!buton.hasAttribute("data-durum")) {
          etiket.textContent = (composer && secimiOku(composer)) ? k("Seçimi Maskele") : k("Maskele");
        }
        if (!acButon.hasAttribute("data-durum")) {
          var s = sayfaSeciminiOku(composer);
          acEtiket.textContent = (s && s.metin && !s.composerIcinde && placeholderVarMi(s.metin))
            ? k("Seçimi Aç") : k("Aç");
        }
      }, 120);
    }
    document.addEventListener("selectionchange", secimDinleyici);

    return host;
  }

  /* Zamanlayıcı buton başına tutulur: iki buton birbirinin geri bildirimini
     kesmesin ve her biri KENDİ varsayılan etiketine dönsün. */
  function geriBildir(buton, etiket, durum, metin) {
    clearTimeout(buton.__geriBildirimZaman);
    buton.setAttribute("data-durum", durum);
    etiket.textContent = k(metin);
    buton.__geriBildirimZaman = setTimeout(function () {
      buton.removeAttribute("data-durum");
      etiket.textContent = buton.__varsayilanEtiket;
    }, 2000);
  }

  /* ---------- ENJEKSİYON & GÖZLEM ----------
     NEDEN BUTON body'YE SABİTLENİYOR (sitenin araç çubuğuna DEĞİL):

     İlk sürüm butonu doğrudan sitenin gönder-tuşu kabına koyuyordu. O kabı
     React yönetiyor; yabancı bir çocuk gördüğünde sonraki render'da siliyor.
     Gözlemcimiz "buton yok" deyip yeniden ekliyor, bu yeni bir mutasyon
     üretiyor, React tekrar siliyor… Ölçtük: saniyede ~62 tur. Her turda
     yeni bir Shadow DOM kurulduğu için ağır bir React ağacında sayfa
     donuyordu.

     Çözüm: butonu belgenin en üstüne (body) sabit konumda koyup composer'ın
     yanına hizalamak. React onu hiç görmez, silmez; bizim eklememiz de
     sitenin ağacını değiştirmediği için kendi gözlemcimizi tetiklemez.
     Kavga tamamen ortadan kalkar. */

  function start(adapter) {
    if (!adapter || typeof adapter.findComposer !== "function" || typeof adapter.findToolbar !== "function") {
      console.warn(LOG + " geçersiz adapter, enjeksiyon iptal.");
      return;
    }

    var hostDomain = window.location.hostname;
    var STORAGE_KEY_POS = "maskeleme_widget_pos_" + adapter.id;
    var STORAGE_KEY_COLLAPSED = "maskeleme_widget_collapsed";

    var durum = {
      composer: null, hedef: null, host: null,
      konumPlanlandi: false, kontrolZamani: 0, kontrolBekliyor: false,
      pinned: false, customPos: null, collapsed: false,
      devreDisi: false, gonderOnayi: null
    };

    /* P-01: Site ve uyarı pilotu ayarları.
       storage.local yalnız güvenilir bağlamlara açık (glossary-service.js,
       setAccessLevel TRUSTED_CONTEXTS): içerik betiği oradan okuyamaz ve
       popup'taki anahtarlar hiç etki etmiyordu. Okuyamayınca SİTENİN
       localStorage'ına düşülüyordu — site o anahtarı yazarak korumayı sessizce
       kapatabilirdi. Ayarlar artık service worker'dan mesajla gelir; popup'ta
       değişince service worker açık sekmelere iter. Web sayfası
       chrome.runtime mesajı gönderemez, bu kanal taklit edilemez. */
    function ayarlariUygula(ayar) {
      if (!ayar) return;
      window.__MASKELEME_PREFLIGHT_ENABLED = ayar.preflight !== false;
      durum.devreDisi = !!(ayar.siteler && ayar.siteler[hostDomain] === false);
      if (ayar.dil) {
        kumandaDiliniAyarla(ayar.dil);
        if (window.MaskEngine && window.MaskEngine.setPlaceholderLanguage) window.MaskEngine.setPlaceholderLanguage(ayar.dil);
      }
      if (durum.host) {
        if (durum.devreDisi) durum.host.style.display = "none";
        else konumlandir();
      }
    }

    function ayarlariIste() {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id || !chrome.runtime.sendMessage) {
        return Promise.resolve(null);
      }
      return chrome.runtime.sendMessage({ channel: "masko-ayar", operation: "oku" })
        .then(function (yanit) { return yanit && yanit.ok ? yanit.ayar : null; })
        .catch(function () { return null; });
    }

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (mesaj, gonderen) {
        if (!gonderen || gonderen.id !== chrome.runtime.id) return;
        if (mesaj && mesaj.channel === "masko-ayar" && mesaj.ayar) ayarlariUygula(mesaj.ayar);
      });
    }
    // Popup ayrı pencerede; kullanıcı sekmeye dönünce ayarı tazele (itme kaçtıysa).
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) ayarlariIste().then(ayarlariUygula);
    });

    // Konum ve katlama yalnız arayüz tercihidir; sitenin localStorage'ında tutulur.
    try {
      var savedPos = localStorage.getItem(STORAGE_KEY_POS);
      if (savedPos) {
        var parsedPos = JSON.parse(savedPos);
        if (parsedPos && typeof parsedPos.x === "number" && typeof parsedPos.y === "number") {
          durum.customPos = parsedPos;
          durum.pinned = !!parsedPos.pinned;
        }
      }
      var savedCol = localStorage.getItem(STORAGE_KEY_COLLAPSED);
      if (savedCol === "1") durum.collapsed = true;
    } catch (e) {}

    /* ---- Gönderim öncesi durdurma (M-10) ----
       Rozet yalnız yazarken 350 ms gecikmeyle güncelleniyordu: yapıştırıp
       hemen Enter'a basan kullanıcı ham veriyi uyarı görmeden gönderiyordu.
       Artık gönderme tuşu/düğmesi yakalanır; kutuda maskelenmemiş hassas veri
       varsa İLK basış durdurulup uyarı gösterilir, aynı metinle ikinci basış
       gönderir (bilinçli tercih engellenmez). Window seviyesinde yakalama
       fazında dinlenir ki sitenin kendi dinleyicilerinden önce çalışsın. */
    var ONAY_SURESI = 15000;

    function gonderimiDenetle(e) {
      if (durum.devreDisi || window.__MASKELEME_PREFLIGHT_ENABLED === false) return;
      var composer = durum.composer;
      if (!composer || !composer.isConnected || !durum.host || !durum.host.__gonderimDurduruldu) return;
      var metin = metniOku(composer);
      var onay = durum.gonderOnayi;
      if (onay && onay.metin === metin && Date.now() - onay.zaman < ONAY_SURESI) {
        durum.gonderOnayi = null;          // bilinçli ikinci basış: gönder
        return;
      }
      var bulgular;
      try { bulgular = gonderilmemisBulgular(metin); } catch (err) { return; }
      if (!bulgular.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      durum.gonderOnayi = { metin: metin, zaman: Date.now() };
      durum.host.__gonderimDurduruldu(bulgular);
    }

    function gonderTusuMu(e) {
      if (e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return false;
      var ctrl = e.ctrlKey || e.metaKey;
      // AI Studio'da düz Enter satır ekler, gönderme Ctrl/Cmd+Enter'dır.
      return adapter.gonderKisayolu === "ctrl+enter" ? ctrl : true;
    }

    function gonderDugmesiMi(hedef) {
      var composer = durum.composer;
      if (!composer || !hedef || !hedef.closest) return false;
      if (typeof adapter.gonderDugmesiMi === "function") return !!adapter.gonderDugmesiMi(hedef, composer);
      var dugme = hedef.closest("button");
      if (!dugme) return false;
      // Yalnız composer'ın kendi formundaki/araç çubuğundaki düğmeler adaydır.
      var kap = composer.closest("form") || durum.hedef;
      if (!kap || !kap.contains(dugme)) return false;
      if (dugme.type === "submit") return true;
      var ad = (dugme.getAttribute("aria-label") || "") + " " + (dugme.getAttribute("data-testid") || "") + " " + (dugme.title || "");
      return /send|gönder|submit|\brun\b|çalıştır/i.test(ad);
    }

    window.addEventListener("keydown", function (e) {
      if (!gonderTusuMu(e) || !durum.composer || !durum.composer.contains(e.target)) return;
      gonderimiDenetle(e);
    }, true);
    window.addEventListener("click", function (e) {
      if (!e.isTrusted || !gonderDugmesiMi(e.target)) return;
      gonderimiDenetle(e);
    }, true);

    function konumlandir() {
      var host = durum.host, composer = durum.composer;
      if (!host || !composer) return;

      // Kapalı sitede konumlandırma butonu yeniden görünür yapmamalı.
      if (durum.devreDisi || !gorunurMu(composer)) { host.style.display = "none"; return; }
      host.style.display = "inline-flex";

      var hostW = host.offsetWidth || (durum.collapsed ? 34 : 220);
      var hostH = host.offsetHeight || (durum.collapsed ? 34 : 36);

      // 1. PINNED (Sabitlenmiş) mod:
      // Kullanıcı butonu tutup ekranda nereye bıraktıysa TAM ORADA çakılı kalır.
      // Sayfa kaysa da, chat uzasa da, textarea büyüse de ASLA oynamaz ve chate karışmaz!
      if (durum.pinned && durum.customPos) {
        var pinX = Math.max(6, Math.min(durum.customPos.x, window.innerWidth - hostW - 6));
        var pinY = Math.max(6, Math.min(durum.customPos.y, window.innerHeight - hostH - 6));
        host.style.left = Math.round(pinX) + "px";
        host.style.top = Math.round(pinY) + "px";
        host.style.right = "auto";
        host.style.bottom = "auto";
        return;
      }

      // 2. OTOMATİK HİZALAMA MODU:
      // Chat mesajlarına karışmayı ve titremeyi önleme:
      var hedef = durum.hedef;
      var r = (hedef && hedef.isConnected ? hedef : composer).getBoundingClientRect();

      var sol, ust;
      // A) Formun/kutunun sağ dış tarafında ekran payı varsa, formun sağına (chatin tamamen dışına):
      if (window.innerWidth - r.right >= hostW + 14) {
        sol = r.right + 8;
        ust = Math.max(6, Math.min(r.bottom - hostH, window.innerHeight - hostH - 6));
      } else {
        // B) Sağ dış kenarda yer yoksa:
        // Formun sağ alt köşesine (gönder butonunun yanına / araç çubuğu hizasına):
        sol = Math.max(6, Math.min(r.right - hostW - 6, window.innerWidth - hostW - 6));

        // Asla formun tepesine (chatin mesaj balonlarının ortasına) fırlama:
        if (window.innerHeight - r.bottom >= hostH + 6) {
          ust = r.bottom + 4;
        } else {
          // Form ekranın alt tabanındaysa, formun sağ alt köşesinde kal:
          ust = Math.max(6, Math.min(r.bottom - hostH - 4, window.innerHeight - hostH - 6));
        }
      }

      // Mikro titremeleri engelle (1 pikselden küçük farklarda DOM güncelleme)
      var curLeft = parseInt(host.style.left, 10) || 0;
      var curTop = parseInt(host.style.top, 10) || 0;
      if (Math.abs(curLeft - sol) >= 1) host.style.left = Math.round(sol) + "px";
      if (Math.abs(curTop - ust) >= 1) host.style.top = Math.round(ust) + "px";
      host.style.right = "auto";
      host.style.bottom = "auto";
    }

    function konumPlanla() {
      // Sabitlenmiş moddaysa scroll hesaplamasına hiç gerek yok — saf position:fixed çalışır
      if (durum.konumPlanlandi || (durum.pinned && durum.customPos)) return;
      durum.konumPlanlandi = true;
      requestAnimationFrame(function () {
        durum.konumPlanlandi = false;
        try { konumlandir(); } catch (e) { /* konumlandırma kritik değil */ }
      });
    }

    var boyutGozlemcisi = window.ResizeObserver ? new ResizeObserver(konumPlanla) : null;

    function enjekteEtmeyiDene() {
      if (durum.devreDisi) {
        if (durum.host) durum.host.style.display = "none";
        return;
      }
      /* UCUZ YOL: Önbellekteki composer hâlâ belgedeyse, tüm sayfayı
         yeniden taramaya gerek yok. Asıl maliyet buydu — kullanıcı
         yazarken saniyede ~53 querySelectorAll koşuyordu ve her biri
         Gemini'nin binlerce düğümlü DOM'unu baştan sona geziyordu. */
      if (durum.composer && durum.composer.isConnected) return;

      var composer = adapter.findComposer();             // pahalı yol: yalnız gerektiğinde

      if (!composer) {                                   // SPA gezinmesi: composer gitti
        if (durum.host) durum.host.style.display = "none";
        durum.composer = durum.hedef = null;
        return;
      }
      if (!window.MaskEngine) return;

      // Host bir kez üretilir, sonra yalnızca yeniden konumlandırılır.
      if (!durum.host) {
        durum.host = butonUret(adapter, function () { return durum.composer; }, durum, function () { konumlandir(); });
        durum.host.style.position = "fixed";
        durum.host.style.zIndex = "2147483646";
        document.body.appendChild(durum.host);
      }

      durum.composer = composer;
      durum.hedef = adapter.findToolbar(composer) || composer;

      /* M-10: Gönderim öncesi uyarı pilotu için dinleyici bağlama */
      if (!composer.__maskelemeDinleyici && durum.host && durum.host.__onUyariTara) {
        composer.__maskelemeDinleyici = true;
        composer.addEventListener("input", durum.host.__onUyariTara);
        composer.addEventListener("keyup", durum.host.__onUyariTara);
      }

      /* Kutu yazdıkça büyüyor (Gemini tek satırdan çok satıra geçiyor);
         bunu her mutasyonda ölçmek yerine composer'ın kendisini izliyoruz. */
      if (boyutGozlemcisi) {
        boyutGozlemcisi.disconnect();
        boyutGozlemcisi.observe(composer);
      }
      konumlandir();
    }

    /* Mutasyonlar SADECE "composer değişti mi" sorusunu tetikler; bu soru
       saniyede 60 kez sorulacak kadar acil değil. Kare bazlı (rAF) yerine
       zaman bazlı kısma: gecikme fark edilmez, maliyet ~15 kat düşer. */
    var KONTROL_ARALIGI = 250;

    function planla() {
      if (durum.kontrolBekliyor || yaziyorMu || document.hidden) return;
      var kalan = KONTROL_ARALIGI - (Date.now() - durum.kontrolZamani);
      durum.kontrolBekliyor = true;
      setTimeout(function () {
        durum.kontrolBekliyor = false;
        durum.kontrolZamani = Date.now();
        if (document.hidden) return;
        try { enjekteEtmeyiDene(); }
        catch (e) { console.warn(LOG + " " + adapter.id + ": enjeksiyon hatası:", e); }
      }, kalan > 0 ? kalan : 0);
    }

    /* Ayar yanıtı gelmeden enjekte etmeyiz ki kapatılmış sitede buton bir an
       bile görünmesin. Service worker uyanamazsa koruma açık varsayılır. */
    var basladi = false;
    function baslat() {
      if (basladi) return;
      basladi = true;
      planla();
      new MutationObserver(planla).observe(document.body, { childList: true, subtree: true });

      // Sayfa kaydıkça / pencere boyutu değiştikçe butonu composer'ın yanında tut
      window.addEventListener("scroll", konumPlanla, true);
      window.addEventListener("resize", konumPlanla);
    }
    ayarlariIste().then(function (ayar) { ayarlariUygula(ayar); baslat(); });
    setTimeout(baslat, 1500);
  }

  /* ---------- TEŞHİS ----------
     Bir sitede buton belirmiyorsa (seçiciler eskimişse) konsolda
     MaskelemeInjector.tani() çalıştırılır: sayfadaki yazı alanı adaylarını
     ve onları hedeflemeye yarayacak kararlı nitelikleri döker. Çıktısı
     doğrudan adapter'a seçici yazmak için kullanılır. */
  function tani() {
    var adaylar = [].slice.call(document.querySelectorAll(
      'textarea, [contenteditable="true"], input[type="text"]'
    ));
    var satirlar = adaylar.map(function (el, i) {
      var r = el.getBoundingClientRect();
      return {
        "#": i,
        etiket: el.tagName.toLowerCase(),
        id: el.id || "—",
        gorunur: gorunurMu(el),
        boyut: Math.round(r.width) + "x" + Math.round(r.height),
        metinUzunlugu: (el.value !== undefined ? el.value : el.innerText || "").length,
        ozelEbeveyn: ozelEbeveynZinciri(el),
        placeholder: el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || "—",
        siniflar: (el.className && el.className.toString().slice(0, 60)) || "—"
      };
    });
    console.log("%c[Maskeleme İstasyonu] Yazı alanı adayları", "font-weight:bold");
    if (console.table) console.table(satirlar); else console.log(satirlar);
    console.log("Görünür olan(lar) hedeflenmeli. 'ozelEbeveyn' sütunundaki " +
                "özel eleman adları (ör. ms-prompt-input) en kararlı seçicilerdir.");
    return satirlar;
  }

  /* Angular/Web Component tabanlı sitelerde (AI Studio'nun ms-* elemanları
     gibi) özel eleman adları, hash'lenmiş sınıflardan çok daha kararlıdır. */
  function ozelEbeveynZinciri(el) {
    var zincir = [], p = el.parentElement, adim = 0;
    while (p && adim < 6) {
      var ad = p.tagName.toLowerCase();
      if (ad.indexOf("-") !== -1) zincir.push(ad);   // özel eleman
      p = p.parentElement; adim++;
    }
    return zincir.length ? zincir.join(" < ") : "—";
  }

  /* Seçici listesini öncelik sırasıyla gezip ilk görünür yazı alanını döndürür.
     Gemini ve AI Studio adaptörleri aynı döngüyü ayrı ayrı taşıyordu.
     atla(el) true dönerse aday elenir (ör. Quill'in görünmez .ql-clipboard'u). */
  function ilkGorunur(seciciler, atla) {
    for (var i = 0; i < seciciler.length; i++) {
      var adaylar = document.querySelectorAll(seciciler[i]);
      for (var j = 0; j < adaylar.length; j++) {
        if (atla && atla(adaylar[j])) continue;
        if (gorunurMu(adaylar[j])) return adaylar[j];
      }
    }
    return null;
  }

  window.MaskelemeInjector = { start: start, gorunurMu: gorunurMu, ilkGorunur: ilkGorunur, tani: tani };

})();
