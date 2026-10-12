/* =====================================================
   ADAPTER — ChatGPT (chatgpt.com, chat.openai.com)
   =====================================================
   SON CANLI GÖZLEM: 2026-09-27; görünür form içi ProseMirror
   yazı alanında id yoktu. Yapısal yedek seçici çalıştı.

   Composer  : varsa #prompt-textarea (ProseMirror contenteditable veya
               textarea); 2026-09-27 yeni sohbetinde id yoktu, görünür
               form içi contenteditable yapısal yedeği eşleşti. Mobilde
               #mobile-composer-prompt bulunabiliyor.
   Gönder    : form içinde button[type="submit"]

   DİKKAT — "Kutu boş" hatası:
   ChatGPT sayfada AYNI ANDA birden fazla composer tutabiliyor (görünür
   masaüstü editörü + gizli mobil textarea). Gizli olanı bulup okursak
   kullanıcı metin yazmış olsa bile boş görünür. Bu yüzden her aday
   MaskelemeInjector.gorunurMu() süzgecinden geçiriliyor.

   NEDEN BU SEÇİCİLER:
   ChatGPT'nin sınıf adları derleme zamanında üretiliyor (wm-composer-*
   gibi) — sürüm atlayınca sessizce değişir. Bu yüzden sınıf adına değil
   varsa id'ye, element tipine ve yapısal konuma (closest("form")) güveniyoruz.
   aria-label da KULLANILMAZ: kullanıcının arayüz diline göre değişiyor
   ("Send message" / "İleti gönder").

   KIRILMA BELİRTİSİ:
   Konsolda "[Maskeleme İstasyonu] chatgpt: araç çubuğu bulunamadı".
   O zaman chatgpt.com'da DevTools ile textarea'nın id'sini ve form
   yapısını yeniden kontrol edip aşağıdaki seçicileri güncelleyin.
   ===================================================== */

(function () {
  "use strict";

  window.MaskelemeInjector.start({
    id: "chatgpt",

    findComposer: function () {
      var gorunur = window.MaskelemeInjector.gorunurMu;

      // Öncelik sırası: kanonik id → mobil id → yapısal yedekler
      var adaylar = [
        document.getElementById("prompt-textarea"),
        document.getElementById("mobile-composer-prompt")
      ];
      adaylar = adaylar.concat([].slice.call(
        document.querySelectorAll('form [contenteditable="true"], form textarea')
      ));

      for (var i = 0; i < adaylar.length; i++) {
        if (gorunur(adaylar[i])) return adaylar[i];
      }
      return null;
    },

    findToolbar: function (composerEl) {
      var form = composerEl.closest("form");
      if (!form) return composerEl;
      var gonder = form.querySelector('button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[type="submit"]');
      // Butonu gönder tuşunun yanına koy; gönder tuşu bulunamazsa formun kendisi
      return (gonder && gonder.parentElement) ? gonder.parentElement : form;
    }
  });

})();
