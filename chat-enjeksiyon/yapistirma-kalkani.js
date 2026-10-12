/* Yapıştırma kalkanı — sohbet sitelerinde hassas veriyi SİTEYE ULAŞMADAN maskeler.
 *
 * Neden ayrı ve neden document_start: buton bileşeni (injector-core) sayfa
 * yüklendikten sonra çalışır ve maskelemeyi metin sitenin yazı kutusuna
 * girdikten SONRA yapar. O ana kadar sitenin kendi kodu (taslak kaydı,
 * yazma telemetrisi, paste dinleyicisi) ham metni görmüş olur. Bu betik
 * sitenin kodundan önce yüklenir ve window üzerinde yakalama fazında
 * dinler: yapıştırma/bırakma olayı sitenin hiçbir dinleyicisine ulaşmadan
 * durdurulur, metin yerelde maskelenir, kutuya yalnızca maskeli hâli yazılır.
 *
 * Sınırı: klavyeyle yazılan metin sitenin kendi kutusunda oluşur; onu siteden
 * gizlemenin editörü bozmayan bir yolu yok. Onun için gönderim öncesi uyarı
 * (injector-core) devrededir.
 */
(function () {
  "use strict";

  if (window.__maskoYapistirmaKalkani) return;
  window.__maskoYapistirmaKalkani = true;

  var LOG = "[Masko]";
  var hostDomain = window.location.hostname;
  // Ayar gelene kadar koruma AÇIK: service worker geç uyanırsa ilk
  // yapıştırma korumasız kalmasın.
  var etkin = true;

  // Bu sekmede maskelenip kutuya yazılan placeholder'lar. injector-core
  // "Aç" düğmesinde yerinde açma kararını bu kümeye göre verir.
  var sekmeYerTutuculari = window.__maskoSekmeYerTutuculari ||
    (window.__maskoSekmeYerTutuculari = new Set());

  /* ---------- Ayarlar (service worker'ın masko-ayar kanalı) ---------- */
  function ayarlariUygula(ayar) {
    if (!ayar) return;
    etkin = ayar.pasteGuard !== false && !(ayar.siteler && ayar.siteler[hostDomain] === false);
    // Arayüz dili: yer tutucular ([EMAIL_1] / [EPOSTA_1]) buna uyar; bildirimleri kumanda çevirir
    if (ayar.dil && window.MaskEngine && MaskEngine.setPlaceholderLanguage) MaskEngine.setPlaceholderLanguage(ayar.dil);
  }
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
    try {
      chrome.runtime.sendMessage({ channel: "masko-ayar", operation: "oku" })
        .then(function (y) { if (y && y.ok) ayarlariUygula(y.ayar); })
        .catch(function () {});
      chrome.runtime.onMessage.addListener(function (mesaj, gonderen) {
        if (!gonderen || gonderen.id !== chrome.runtime.id) return;
        if (mesaj && mesaj.channel === "masko-ayar" && mesaj.ayar) ayarlariUygula(mesaj.ayar);
      });
    } catch (e) {}
  }

  /* ---------- Yardımcılar ---------- */
  function metinKutusuMu(el) {
    if (el.tagName === "TEXTAREA") return true;
    return el.tagName === "INPUT" && /^(text|search|email|url|tel|)$/i.test(el.type || "");
  }

  // Olayın hedefinden yazılabilir alanı bulur; yazılamıyorsa null.
  function yazilabilirAlan(hedef) {
    var el = hedef && hedef.nodeType === 1 ? hedef : (hedef && hedef.parentElement);
    if (!el) return null;
    if (metinKutusuMu(el)) return el.readOnly || el.disabled ? null : el;
    return el.isContentEditable ? el : null;
  }

  function hassasMi(metin) {
    var motor = window.MaskEngine;
    if (!motor || typeof motor.inspectSensitive !== "function") return false;
    try { return motor.inspectSensitive(metin).length > 0; }
    catch (e) { return false; }
  }

  function secimiKaydet(alan) {
    if (metinKutusuMu(alan)) return { bas: alan.selectionStart, son: alan.selectionEnd };
    var sel = window.getSelection();
    if (sel && sel.rangeCount && alan.contains(sel.getRangeAt(0).startContainer)) {
      return { aralik: sel.getRangeAt(0).cloneRange() };
    }
    return null;
  }

  function secimiGeriYukle(alan, secim) {
    if (!secim) return;
    try {
      if (metinKutusuMu(alan)) { alan.setSelectionRange(secim.bas, secim.son); return; }
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(secim.aralik);
    } catch (e) {}
  }

  // Bırakma noktasına imleci taşır (bırakılan metin oraya yazılsın).
  function birakmaNoktasinaGit(alan, e) {
    if (metinKutusuMu(alan) || !document.caretRangeFromPoint) return;
    var aralik = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (!aralik || !alan.contains(aralik.startContainer)) return;
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(aralik);
  }

  /* Maskeli metni kutuya yazar. Zengin editörler (ProseMirror, tiptap, Quill)
     çok satırlı metni en doğru kendi yapıştırma işleyicileriyle yerleştirir;
     bu yüzden önce MASKELİ metinle sentetik bir paste olayı gönderilir.
     Editör işlemezse (defaultPrevented değilse) insertText'e düşülür. Sentetik
     olay isTrusted=false olduğu için bu betik onu tekrar yakalamaz. */
  function yaz(alan, metin) {
    if (!metinKutusuMu(alan) && typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
      try {
        var dt = new DataTransfer();
        dt.setData("text/plain", metin);
        var olay = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        alan.dispatchEvent(olay);
        if (olay.defaultPrevented) return;
      } catch (e) {}
    }
    if (document.execCommand("insertText", false, metin)) return;
    if (metinKutusuMu(alan)) {
      alan.setRangeText(metin, alan.selectionStart, alan.selectionEnd, "end");
      alan.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function bildir(tur, metin) {
    if (typeof window.__maskoBildirim === "function") window.__maskoBildirim(tur, metin);
    else console.info(LOG + " " + metin);
  }

  function placeholderlar(metin) {
    return String(metin || "").match(/\[[A-ZÇĞİÖŞÜ0-9_]+_\d+\]/g) || [];
  }

  async function maskeleVeYaz(alan, metin, secim) {
    var maskeli;
    try {
      maskeli = await window.MaskEngine.maskText(metin);
    } catch (err) {
      // Kapalı kal: maskelenemeyen metin siteye asla ham yazılmaz.
      bildir("hata", "Maskelenemedi; yapıştırma yapılmadı");
      return;
    }
    var onceki = new Set(placeholderlar(metin));
    var yeni = placeholderlar(maskeli).filter(function (p) { return !onceki.has(p); });
    yeni.forEach(function (p) { sekmeYerTutuculari.add(p); });
    if (!alan.isConnected) { bildir("hata", "Yazı kutusu kayboldu; yapıştırma yapılmadı"); return; }
    alan.focus();
    secimiGeriYukle(alan, secim);
    yaz(alan, maskeli);
    bildir("ok", (yeni.length || "Hassas") + " veri maskelenerek yapıştırıldı");
  }

  /* ---------- Olaylar ---------- */
  function yakala(e, veri, birakma) {
    if (!e.isTrusted || !etkin || !veri) return;
    var alan = yazilabilirAlan(e.target);
    if (!alan) return;
    var metin = veri.getData("text/plain");
    if (!metin || !hassasMi(metin)) return;   // hassas veri yoksa normal yapıştırma (biçim korunur)
    e.preventDefault();
    e.stopImmediatePropagation();
    if (birakma) birakmaNoktasinaGit(alan, e);
    maskeleVeYaz(alan, metin, secimiKaydet(alan));
  }

  window.addEventListener("paste", function (e) { yakala(e, e.clipboardData, false); }, true);
  window.addEventListener("drop", function (e) { yakala(e, e.dataTransfer, true); }, true);
})();
