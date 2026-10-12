/* Maskeleme İstasyonu — Kontrol Basamağı Algoritmaları
 *
 * Uluslararası kimlik numaralarının neredeyse tamamı bir kontrol basamağı
 * taşır. Bunları DOĞRULAMAK, örüntü eşleştirmekten kat kat güvenilirdir:
 * 11 haneli rastgele bir sayının TCKN algoritmasından geçme ihtimali %1,
 * bir kolonun 300 hücresinin hepsinin geçme ihtimali ise 0,01^300.
 *
 * Bu dosya yalnızca matematiği içerir — hangi ülkenin hangi algoritmayı
 * kullandığı intl-pack.js'te tanımlıdır.
 *
 * Kaynak: ISO/IEC 7064, ilgili ulusal şartnameler ve python-stdnum'un
 * belgelediği formatlar (arthurdejong.org/python-stdnum/formats.html).
 */
(function(){
  "use strict";

  function rakamlar(v){ return String(v).replace(/\D/g, ""); }
  function hepsiAyni(s){ return /^(\d)\1+$/.test(s); }

  /* ---------------------------------------------------------------
   * Luhn (ISO/IEC 7812) — kredi kartı, IMEI, SIN, personnummer...
   * --------------------------------------------------------------- */
  function luhnToplam(s){
    var sum = 0, alt = false;
    for(var i = s.length - 1; i >= 0; i--){
      var n = +s[i];
      if(alt){ n *= 2; if(n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum;
  }
  function luhnGecerli(s){ return s.length > 1 && luhnToplam(s) % 10 === 0; }
  function luhnHane(govde){ return String((10 - (luhnToplam(govde + "0") % 10)) % 10); }

  /* ---------------------------------------------------------------
   * Verhoeff — Aadhaar (Hindistan). Luhn'un yakalayamadığı bitişik
   * rakam yer değiştirmelerini de yakalar.
   * --------------------------------------------------------------- */
  var V_D = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0]
  ];
  var V_P = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]
  ];
  var V_INV = [0,4,3,2,1,5,6,7,8,9];

  function verhoeffGecerli(s){
    var c = 0;
    for(var i = 0; i < s.length; i++){
      c = V_D[c][V_P[i % 8][+s[s.length - 1 - i]]];
    }
    return c === 0;
  }
  function verhoeffHane(govde){
    var c = 0, s = govde + "0";
    for(var i = 0; i < s.length; i++){
      c = V_D[c][V_P[i % 8][+s[s.length - 1 - i]]];
    }
    return String(V_INV[c]);
  }

  /* ---------------------------------------------------------------
   * Damm — tek basamaklı hataların tamamını ve bitişik yer
   * değiştirmelerin tamamını yakalar.
   * --------------------------------------------------------------- */
  var DAMM = [
    [0,3,1,7,5,9,8,6,4,2],[7,0,9,2,1,5,4,8,6,3],[4,2,0,6,8,7,1,3,5,9],
    [1,7,5,0,9,8,3,4,2,6],[6,1,2,3,0,4,5,9,7,8],[3,6,7,4,2,0,9,5,8,1],
    [5,8,6,9,7,2,0,1,3,4],[8,9,4,5,3,6,2,0,1,7],[9,4,3,8,6,1,7,2,0,5],
    [2,5,8,1,4,3,6,7,9,0]
  ];
  function dammGecerli(s){
    var c = 0;
    for(var i = 0; i < s.length; i++){ c = DAMM[c][+s[i]]; }
    return c === 0;
  }
  function dammHane(govde){
    var c = 0;
    for(var i = 0; i < govde.length; i++){ c = DAMM[c][+govde[i]]; }
    return String(c);
  }

  /* ---------------------------------------------------------------
   * ISO/IEC 7064
   * --------------------------------------------------------------- */

  // Mod 11,2 — Çin kimlik no, ISNI. Kontrol karakteri 0-9 veya X.
  function iso7064_11_2_Hane(govde){
    var c = 0;
    for(var i = 0; i < govde.length; i++){
      c = ((c + +govde[i]) * 2) % 11;
    }
    var k = (12 - c) % 11;
    return k === 10 ? "X" : String(k);
  }
  function iso7064_11_2_Gecerli(s){
    return iso7064_11_2_Hane(s.slice(0, -1)) === s.slice(-1).toUpperCase();
  }

  // Mod 11,10 — Alman IdNr, Hırvat OIB
  function iso7064_11_10_Hane(govde){
    var c = 10;
    for(var i = 0; i < govde.length; i++){
      c = (c + +govde[i]) % 10;
      if(c === 0) c = 10;
      c = (c * 2) % 11;
    }
    var k = 11 - c;
    return String(k === 10 ? 0 : k);
  }
  function iso7064_11_10_Gecerli(s){
    return iso7064_11_10_Hane(s.slice(0, -1)) === s.slice(-1);
  }

  // Mod 97,10 — IBAN'ın da temeli
  function mod97(str){
    var rem = 0;
    for(var i = 0; i < str.length; i++){
      var ch = str[i];
      var part = (ch >= "0" && ch <= "9") ? ch : String(ch.charCodeAt(0) - 55);
      for(var k = 0; k < part.length; k++){ rem = (rem * 10 + +part[k]) % 97; }
    }
    return rem;
  }

  /* ---------------------------------------------------------------
   * Ağırlıklı mod-n — en yaygın aile
   * --------------------------------------------------------------- */
  function agirlikliToplam(s, agirliklar){
    var sum = 0;
    for(var i = 0; i < agirliklar.length && i < s.length; i++){
      sum += (+s[i]) * agirliklar[i];
    }
    return sum;
  }

  window.CheckDigits = {
    rakamlar: rakamlar,
    hepsiAyni: hepsiAyni,
    luhnToplam: luhnToplam,
    luhnGecerli: luhnGecerli,
    luhnHane: luhnHane,
    verhoeffGecerli: verhoeffGecerli,
    verhoeffHane: verhoeffHane,
    dammGecerli: dammGecerli,
    dammHane: dammHane,
    iso7064_11_2_Hane: iso7064_11_2_Hane,
    iso7064_11_2_Gecerli: iso7064_11_2_Gecerli,
    iso7064_11_10_Hane: iso7064_11_10_Hane,
    iso7064_11_10_Gecerli: iso7064_11_10_Gecerli,
    mod97: mod97,
    agirlikliToplam: agirlikliToplam
  };
})();
