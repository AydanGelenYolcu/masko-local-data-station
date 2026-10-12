/* =====================================================
   ADAPTER — Google Gemini (gemini.google.com)
   =====================================================
   SON CANLI GÖZLEM: 2026-09-27, yeni sohbet ekranında
   rich-textarea > .ql-editor seçicisi ve sentetik maskeleme çalıştı.

   Composer : <rich-textarea> içinde <div class="ql-editor" contenteditable>
              Bu bir Quill editörü — <textarea> DEĞİL. "textarea" kelimesi
              burada bir SINIF adı (ql-editor textarea new-input-ui), etiket
              değil; tag seçicisiyle aranırsa hiç bulunamaz.
   Hizalama : <input-area-v2> özel elemanı (tüm yazı alanını kapsar, 660x64)

   ⚠️ TUZAK — ql-clipboard:
   Quill, DOM'da 0x1 boyutunda görünmez bir <div class="ql-clipboard">
   tutuyor ve bu, display/visibility testinden GEÇİYOR. Yanlışlıkla o
   seçilirse kutu hep boş görünür. İki koruma var: (1) çekirdekteki
   gorunurMu() asgari boyut şartı, (2) aşağıdaki :not(.ql-clipboard).

   NEDEN BU SEÇİCİLER:
   Gemini Angular ile yazılmış ve sınıflarında ng-tns-c219810973-4 gibi
   DERLEME ZAMANINDA ÜRETİLEN adlar var — bunlara asla güvenilmez.
   Kararlı olanlar: rich-textarea / input-area-v2 özel eleman adları ve
   Quill'in kendi ql-* sınıfları.
   aria-label KULLANILMAZ: bu sayfada Türkçe geldi ("Gemini için bir istem
   girin"), kullanıcının diline göre değişir.

   KIRILMA BELİRTİSİ:
   Konsolda "[Maskeleme İstasyonu] gemini: araç çubuğu bulunamadı".
   Düzeltmek için: MaskelemeInjector.tani()
   ===================================================== */

(function () {
  "use strict";

  var SECICILER = [
    "rich-textarea .ql-editor",
    ".ql-editor[contenteditable='true']",
    'rich-textarea [contenteditable="true"]:not(.ql-clipboard)',
    '[contenteditable="true"]:not(.ql-clipboard)'
  ];

  window.MaskelemeInjector.start({
    id: "gemini",

    findComposer: function () {
      return window.MaskelemeInjector.ilkGorunur(SECICILER, function (el) {
        return el.classList.contains("ql-clipboard");
      });
    },

    /* Buton sitenin DOM'una eklenmiyor, yalnızca hizalanıyor (bkz. README).
       input-area-v2 tüm yazı alanını kapsayan kararlı bir özel eleman. */
    findToolbar: function (composerEl) {
      return composerEl.closest("input-area-v2")
          || composerEl.closest(".text-input-field")
          || composerEl.closest("rich-textarea")
          || composerEl;
    }
  });

})();
