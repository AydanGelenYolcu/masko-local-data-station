/* =====================================================
   ADAPTER — Google AI Studio (aistudio.google.com)
   =====================================================
   SON CANLI GÖZLEM: 2026-09-27, yeni sohbet ekranında
   ms-chunk-editor içi textarea ve sentetik maskeleme çalıştı.

   İlk sürümde sayfa DOM'u görülemedi (aistudio.google.com →
   accounts.google.com oturum duvarı), bu yüzden seçiciler AI Studio'nun
   Angular + özel eleman (ms-*) mimarisine dayanarak KATMANLI yazıldı:
   üstteki tutmazsa bir alttaki devreye girer, en sonda "görünür olan
   herhangi bir yazı alanı" yedeği var. 2026-09-27 canlı gözleminde
   ms-chunk-editor textarea katmanı bulundu.

   KIRILIRSA (30 saniye):
   1. aistudio.google.com'da bir prompt sayfası açın.
   2. DevTools konsolunda:  MaskelemeInjector.tani()
   3. "gorunur: true" olan satırın 'ozelEbeveyn' ve 'id' değerlerini
      aşağıdaki SECICILER listesinin başına ekleyin.

   NEDEN ms-* ELEMANLARI:
   AI Studio Angular ile yazılmış ve bileşenleri "ms-" önekli özel
   elemanlar (MakerSuite'ten kalma). Özel eleman adları, derleme zamanında
   üretilen hash'li sınıflardan çok daha kararlıdır — bileşen yeniden
   adlandırılmadıkça değişmezler.

   KIRILMA BELİRTİSİ:
   Konsolda "[Maskeleme İstasyonu] ai-studio: araç çubuğu bulunamadı".
   ===================================================== */

(function () {
  "use strict";

  // Sırayla denenir; ilk görünür eşleşme kazanır.
  var SECICILER = [
    "ms-prompt-input-wrapper textarea",
    "ms-autosize-textarea textarea",
    "ms-chunk-editor textarea",
    'ms-prompt-input-wrapper [contenteditable="true"]',
    "[class*='prompt-input'] textarea",
    "textarea[placeholder]",
    "textarea",
    '[contenteditable="true"]'
  ];

  window.MaskelemeInjector.start({
    id: "ai-studio",
    // AI Studio'da düz Enter satır ekler; istem Ctrl/Cmd+Enter ile gönderilir.
    gonderKisayolu: "ctrl+enter",

    findComposer: function () {
      return window.MaskelemeInjector.ilkGorunur(SECICILER);
    },

    /* Buton artık sitenin DOM'una EKLENMİYOR, yalnızca hizalanıyor
       (bkz. README — React/Angular ile kavgayı bitiren mimari). Bu yüzden
       burada en dıştaki kararlı sarmalayıcıyı döndürmek yeterli; tutmazsa
       composer'ın kendisi kullanılır. */
    findToolbar: function (composerEl) {
      return composerEl.closest("ms-prompt-input-wrapper")
          || composerEl.closest("form")
          || composerEl.parentElement
          || composerEl;
    }
  });

})();
