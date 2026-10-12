/* Görünüm seçimi: Sistem / Açık / Koyu.
 *
 * Her uzantı sayfası bunu <head> içinde, CSS'ten ÖNCE ve senkron yükler; böylece
 * sayfa yanlış temada bir an bile çizilmez. Seçim uzantının kendi kökenindeki
 * localStorage'da tutulur: yalnızca görünüm tercihidir, güvenlik ayarı değildir.
 * Araç çerçeveleri ve açık diğer sekmeler aynı kökendedir; "storage" olayıyla
 * seçim hepsine anında yansır.
 *
 * tokens.css iki kancayı zaten tanır: :root[data-theme="dark"] ve
 * :root:not([data-theme="light"]) (sistem koyu ise). "Sistem" = öznitelik yok.
 */
(function () {
  "use strict";
  var ANAHTAR = "masko_tema";
  var GECERLI = { system: 1, light: 1, dark: 1 };

  function oku() {
    try {
      var v = window.localStorage.getItem(ANAHTAR);
      return GECERLI[v] ? v : "system";
    } catch (e) { return "system"; }
  }

  function uygula(v) {
    var kok = document.documentElement;
    if (v === "light" || v === "dark") kok.setAttribute("data-theme", v);
    else kok.removeAttribute("data-theme");
    var seciciler = document.querySelectorAll("[data-tema-secici] [data-tema]");
    for (var i = 0; i < seciciler.length; i++) {
      var secili = seciciler[i].getAttribute("data-tema") === v;
      seciciler[i].setAttribute("aria-checked", secili ? "true" : "false");
      seciciler[i].tabIndex = secili ? 0 : -1;
    }
  }

  function ayarla(v) {
    if (!GECERLI[v]) v = "system";
    try {
      if (v === "system") window.localStorage.removeItem(ANAHTAR);
      else window.localStorage.setItem(ANAHTAR, v);
    } catch (e) { /* depolama kapalıysa yalnız bu sayfada uygulanır */ }
    uygula(v);
  }

  uygula(oku());

  window.addEventListener("storage", function (e) {
    if (e.key === ANAHTAR || e.key === null) uygula(oku());
  });

  // Seçici düğmeleri: tıklama ve ok tuşlarıyla gezinme (radio grubu davranışı).
  function bagla() {
    var gruplar = document.querySelectorAll("[data-tema-secici]");
    for (var g = 0; g < gruplar.length; g++) {
      (function (grup) {
        var dugmeler = grup.querySelectorAll("[data-tema]");
        grup.addEventListener("click", function (e) {
          var d = e.target.closest ? e.target.closest("[data-tema]") : null;
          if (d && grup.contains(d)) ayarla(d.getAttribute("data-tema"));
        });
        grup.addEventListener("keydown", function (e) {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          var liste = Array.prototype.slice.call(dugmeler);
          var i = liste.indexOf(document.activeElement);
          if (i < 0) return;
          e.preventDefault();
          var yeni = liste[(i + (e.key === "ArrowRight" ? 1 : -1) + liste.length) % liste.length];
          ayarla(yeni.getAttribute("data-tema"));
          yeni.focus();
        });
      })(gruplar[g]);
    }
    uygula(oku());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bagla);
  else bagla();

  window.MaskoTema = { oku: oku, ayarla: ayarla };
})();
