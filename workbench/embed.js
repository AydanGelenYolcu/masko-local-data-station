/* Veri Tezgâhı ana istasyonun içinde çerçeve olarak açıldığında (?embed=1)
   marka başlığını gizlemek için sınıfı sayfa çizilmeden önce koyar. */
if (new URLSearchParams(location.search).has('embed')) {
  document.documentElement.classList.add('is-embedded');
}
