/* Uzantı ikonuna basıldığında maskeleme penceresini açar.
 *
 * ESKİ HALİ BOZUKTU: chrome.tabs.query({ url: ... }) çağrısı "tabs" iznini
 * gerektirir, manifest'te o izin yok. Chrome promise'i reddediyor, async
 * dinleyicide try/catch de olmadığı için hata yalnızca service worker
 * konsoluna düşüyor ve chrome.windows.create satırına HİÇ ulaşılmıyordu —
 * kullanıcı ikona basıyor, ekranda hiçbir şey olmuyordu.
 *
 * Çözüm olarak "tabs" izni EKLENMEDİ: bu uzantının tek satış noktası
 * izin yüzeyinin minimal olması. Onun yerine açtığımız pencerenin id'sini
 * hatırlıyoruz; url filtresine hiç ihtiyaç yok.
 */

// Saf motor aynı kodla worker içinde çalışır; DOM yardımcıları burada çağrılmaz.
globalThis.window = globalThis;
importScripts("type-catalog.js", "mask-engine.js", "glossary-service.js");

/* Açık pencerenin kimliği storage.session'da tutulur. Service worker ~30 sn
   boşta kalınca sonlanır ve modül değişkeni sıfırlanırdı: ikona sonraki
   basışta pencere öne gelmek yerine her seferinde yeni bir pencere açılıyordu.
   storage.session tarayıcı oturumu boyunca yaşar, diske yazılmaz. */
var PENCERE_ANAHTARI = "maskeleme_panel_pencere";

async function pencereKimligi() {
  try {
    var kayit = await chrome.storage.session.get(PENCERE_ANAHTARI);
    return typeof kayit[PENCERE_ANAHTARI] === "number" ? kayit[PENCERE_ANAHTARI] : null;
  } catch (e) { return null; }
}

async function pencereKimliginiYaz(id) {
  try {
    if (id === null) { await chrome.storage.session.remove(PENCERE_ANAHTARI); return; }
    var kayit = {};
    kayit[PENCERE_ANAHTARI] = id;
    await chrome.storage.session.set(kayit);
  } catch (e) {}
}

chrome.action.onClicked.addListener(async function () {
  var url = chrome.runtime.getURL("popup.html");

  // Zaten açık bir pencere varsa öne getir.
  var panelWindowId = await pencereKimligi();
  if (panelWindowId !== null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch (e) {
      // Kullanıcı kapatmış — yenisini aç.
      await pencereKimliginiYaz(null);
    }
  }

  try {
    var win = await chrome.windows.create({
      url: url,
      type: "popup",
      width: 420,
      height: 680
    });
    await pencereKimliginiYaz(win ? win.id : null);
  } catch (e) {
    // Pencere açılamazsa sessiz kalmayalım; en azından sekmede açmayı dene.
    console.error("Maskeleme penceresi açılamadı:", e);
    try { await chrome.tabs.create({ url: url }); } catch (e2) {
      console.error("Sekmede de açılamadı:", e2);
    }
  }
});

// Pencere kapanınca hatırladığımız id'yi bırak.
chrome.windows.onRemoved.addListener(async function (id) {
  if (id === await pencereKimligi()) await pencereKimliginiYaz(null);
});
