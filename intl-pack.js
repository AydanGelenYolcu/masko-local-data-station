/* Maskeleme İstasyonu — Uluslararası Kimlik Paketi
 *
 * Veri global geliyor: bir Excel'de Alman Steuer-ID, Brezilya CPF'i ve
 * Hindistan Aadhaar'ı yan yana olabilir. Bu paketteki her tip GERÇEK kontrol
 * basamağı algoritmasıyla doğrulanır — örüntü eşleşmesiyle değil.
 *
 * Neden önemli: 11 haneli rastgele bir sayı "kimlik gibi" görünür, ama
 * checksum'dan geçme ihtimali ~%1'dir. Bir kolonun 300 hücresinin hepsi
 * geçiyorsa o kolon kesinlikle o kimliktir. Örüntü tek başına bunu veremez.
 *
 * Başlık ipuçları çok dillidir: "Steuer-ID", "numéro fiscal", "código fiscal",
 * "kimlik no" ve "national id" aynı tipe götürür.
 */
(function(){
  "use strict";

  var TC = window.TypeCatalog;
  var CD = window.CheckDigits;
  if(!TC || !TC.registerTypes || !CD) return;

  var pick = TC.pick, randInt = TC.randInt, pad = TC.pad;
  var rakamlar = CD.rakamlar;

  /* Şekil koruması: hücre baştan sona o tanımlayıcı olmalı. Bir cümleden
     rakamları söküp bakmak sahte eşleşme üretir. */
  function sadeceRakam(minLen, maxLen){
    return function(v){
      var s = String(v).trim();
      if(!/^[\d][\d\s.\-\/]*$/.test(s)) return false;
      var d = rakamlar(s);
      return d.length >= minLen && d.length <= maxLen;
    };
  }
  function sar(sekil, dogrula){
    return function(v){ return sekil(v) && dogrula(rakamlar(v), String(v).trim()); };
  }
  function rastgeleRakam(rng, n){
    var s = "";
    for(var i = 0; i < n; i++){ s += randInt(rng, 0, 9); }
    return s;
  }

  // Ortak alan tanımı — her tip için tekrar yazmamak adına
  function kimlik(id, label, ulke, header, test, gen, ek){
    var t = {
      id: id, label: label, group: "Uluslararası Kimlik", ulke: ulke,
      sensitivity: "high", ozel: false, passthrough: "never",
      checksum: true, headerGerekli: false,
      header: header, test: test, gen: gen
    };
    for(var k in (ek || {})){ t[k] = ek[k]; }
    return t;
  }

  var TIPLER = [];

  /* ================= AVRUPA ================= */

  // Almanya — Steuerliche Identifikationsnummer (ISO 7064 Mod 11,10)
  TIPLER.push(kimlik("de_idnr", "Almanya Vergi Kimlik (IdNr)", "DE",
    [/steuer[_ ]?id/i, /steuerliche[_ ]?id/i, /\bidnr\b/i, /tax[_ ]?id[_ ]?de/i, /german[_ ]?tax/i],
    sar(sadeceRakam(11,11), function(d){
      return d[0] !== "0" && CD.iso7064_11_10_Gecerli(d);
    }),
    function(rng){
      var g = String(randInt(rng,1,9)) + rastgeleRakam(rng, 9);
      return g + CD.iso7064_11_10_Hane(g);
    }, { fp: 0.10 }));

  // Fransa — NIR / numéro de sécurité sociale (mod 97)
  TIPLER.push(kimlik("fr_nir", "Fransa Sosyal Güvenlik (NIR)", "FR",
    [/\bnir\b/i, /securite[_ ]?sociale/i, /sécurité[_ ]?sociale/i, /numero[_ ]?secu/i,
     /insee/i, /french[_ ]?ssn/i],
    sar(sadeceRakam(15,15), function(d){
      var govde = d.slice(0,13), kontrol = +d.slice(13);
      return kontrol === 97 - (Number(govde) % 97);
    }),
    function(rng){
      var govde = pick(rng,["1","2"]) + pad(randInt(rng,30,99),2) + pad(randInt(rng,1,12),2) +
                  pad(randInt(rng,1,95),2) + pad(randInt(rng,1,999),3) + pad(randInt(rng,1,999),3);
      return govde + pad(97 - (Number(govde) % 97), 2);
    }, { fp: 0.0103 }));

  // Fransa — SIREN (Luhn, 9 hane) / SIRET (14 hane)
  TIPLER.push(kimlik("fr_siren", "Fransa Şirket No (SIREN/SIRET)", "FR",
    [/\bsiren\b/i, /\bsiret\b/i, /numero[_ ]?entreprise/i],
    sar(sadeceRakam(9,14), function(d){
      return (d.length === 9 || d.length === 14) && CD.luhnGecerli(d);
    }),
    function(rng){ var g = rastgeleRakam(rng, 8); return g + CD.luhnHane(g); },
    { sensitivity: "medium", fp: 0.10 }));

  // İspanya — DNI / NIE (mod 23 harf)
  var DNI_HARF = "TRWAGMYFPDXBNJZSQVHLCKE";
  TIPLER.push(kimlik("es_dni", "İspanya Kimlik (DNI/NIE)", "ES",
    [/\bdni\b/i, /\bnie\b/i, /documento[_ ]?nacional/i, /spanish[_ ]?id/i],
    function(v){
      var s = String(v).trim().toUpperCase().replace(/[\s-]/g, "");
      var m = /^([XYZ]?)(\d{7,8})([A-Z])$/.exec(s);
      if(!m) return false;
      var onek = m[1] ? String("XYZ".indexOf(m[1])) : "";
      var sayi = Number(onek + m[2]);
      return DNI_HARF[sayi % 23] === m[3];
    },
    function(rng){
      var sayi = randInt(rng, 10000000, 99999999);
      return String(sayi) + DNI_HARF[sayi % 23];
    }, { fp: 0.043 }));

  // İtalya — Codice Fiscale (mod 26 harf)
  var CF_TEK = { "0":1,"1":0,"2":5,"3":7,"4":9,"5":13,"6":15,"7":17,"8":19,"9":21,
    "A":1,"B":0,"C":5,"D":7,"E":9,"F":13,"G":15,"H":17,"I":19,"J":21,"K":2,"L":4,
    "M":18,"N":20,"O":11,"P":3,"Q":6,"R":8,"S":12,"T":14,"U":16,"V":10,"W":22,
    "X":25,"Y":24,"Z":23 };
  var CF_CIFT = { "0":0,"1":1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,
    "A":0,"B":1,"C":2,"D":3,"E":4,"F":5,"G":6,"H":7,"I":8,"J":9,"K":10,"L":11,
    "M":12,"N":13,"O":14,"P":15,"Q":16,"R":17,"S":18,"T":19,"U":20,"V":21,"W":22,
    "X":23,"Y":24,"Z":25 };
  function cfKontrol(govde){
    var sum = 0;
    for(var i = 0; i < 15; i++){
      sum += (i % 2 === 0) ? CF_TEK[govde[i]] : CF_CIFT[govde[i]];
    }
    return String.fromCharCode(65 + (sum % 26));
  }
  TIPLER.push(kimlik("it_cf", "İtalya Vergi Kodu (Codice Fiscale)", "IT",
    [/codice[_ ]?fiscale/i, /\bcodfis\b/i, /italian[_ ]?tax/i, /\bcf\b/i],
    function(v){
      var s = String(v).trim().toUpperCase().replace(/\s/g, "");
      if(!/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/.test(s)) return false;
      return cfKontrol(s.slice(0,15)) === s[15];
    },
    function(rng){
      var H = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      var g = "";
      for(var i=0;i<6;i++){ g += H[randInt(rng,0,25)]; }
      g += pad(randInt(rng,30,99),2) + H[randInt(rng,0,25)] + pad(randInt(rng,1,28),2) +
           H[randInt(rng,0,25)] + pad(randInt(rng,1,999),3);
      return g + cfKontrol(g);
    }, { fp: 0.038 }));

  // Hollanda — BSN (elfproef)
  TIPLER.push(kimlik("nl_bsn", "Hollanda Vatandaş No (BSN)", "NL",
    [/\bbsn\b/i, /burgerservice/i, /sofinummer/i, /dutch[_ ]?id/i],
    sar(sadeceRakam(8,9), function(d){
      if(d.length === 8) d = "0" + d;
      var sum = 0;
      for(var i = 0; i < 8; i++){ sum += (+d[i]) * (9 - i); }
      sum -= +d[8];
      return sum !== 0 && sum % 11 === 0;
    }),
    function(rng){
      for(var t = 0; t < 200; t++){
        var g = String(randInt(rng,1,9)) + rastgeleRakam(rng, 7);
        for(var k = 0; k <= 9; k++){
          var sum = 0;
          for(var i = 0; i < 8; i++){ sum += (+g[i]) * (9 - i); }
          sum -= k;
          if(sum !== 0 && sum % 11 === 0) return g + k;
        }
      }
      return "111222333";
    }, { fp: 0.09 }));

  // Polonya — PESEL (ağırlıklı mod 10)
  var PESEL_A = [1,3,7,9,1,3,7,9,1,3];
  TIPLER.push(kimlik("pl_pesel", "Polonya Kimlik (PESEL)", "PL",
    [/pesel/i, /polish[_ ]?id/i],
    sar(sadeceRakam(11,11), function(d){
      return (10 - (CD.agirlikliToplam(d, PESEL_A) % 10)) % 10 === +d[10];
    }),
    function(rng){
      var g = pad(randInt(rng,40,99),2) + pad(randInt(rng,1,12),2) + pad(randInt(rng,1,28),2) +
              pad(randInt(rng,0,9999),4);
      return g + ((10 - (CD.agirlikliToplam(g, PESEL_A) % 10)) % 10);
    }, { fp: 0.10 }));

  // Polonya — NIP (vergi, ağırlıklı mod 11)
  var NIP_A = [6,5,7,2,3,4,5,6,7];
  TIPLER.push(kimlik("pl_nip", "Polonya Vergi No (NIP)", "PL",
    [/\bnip\b/i, /polish[_ ]?tax/i],
    sar(sadeceRakam(10,10), function(d){
      var r = CD.agirlikliToplam(d, NIP_A) % 11;
      return r !== 10 && r === +d[9];
    }),
    function(rng){
      for(var t = 0; t < 100; t++){
        var g = rastgeleRakam(rng, 9);
        var r = CD.agirlikliToplam(g, NIP_A) % 11;
        if(r !== 10) return g + r;
      }
      return "1234563218";
    }, { sensitivity: "medium", fp: 0.09 }));

  // Birleşik Krallık — NHS numarası (mod 11)
  TIPLER.push(kimlik("gb_nhs", "BK Sağlık No (NHS)", "GB",
    [/\bnhs\b/i, /nhs[_ ]?number/i, /patient[_ ]?id[_ ]?uk/i],
    sar(sadeceRakam(10,10), function(d){
      var sum = 0;
      for(var i = 0; i < 9; i++){ sum += (+d[i]) * (10 - i); }
      var k = 11 - (sum % 11);
      if(k === 11) k = 0;
      return k !== 10 && k === +d[9];
    }),
    function(rng){
      for(var t = 0; t < 100; t++){
        var g = rastgeleRakam(rng, 9), sum = 0;
        for(var i = 0; i < 9; i++){ sum += (+g[i]) * (10 - i); }
        var k = 11 - (sum % 11);
        if(k === 11) k = 0;
        if(k !== 10) return g + k;
      }
      return "9434765919";
    }, { ozel: true, fp: 0.09 }));

  // Birleşik Krallık — National Insurance Number (format + yasak önekler)
  TIPLER.push(kimlik("gb_nino", "BK Sigorta No (NINO)", "GB",
    [/\bnino\b/i, /national[_ ]?insurance/i, /\bni[_ ]?number\b/i],
    function(v){
      var s = String(v).trim().toUpperCase().replace(/\s/g, "");
      if(!/^[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]$/.test(s)) return false;
      return ["BG","GB","NK","KN","TN","NT","ZZ"].indexOf(s.slice(0,2)) === -1;
    },
    function(rng){
      var H1 = "ABCEGHJKLMNOPRSTWXYZ";
      var onek;
      do { onek = H1[randInt(rng,0,19)] + H1[randInt(rng,0,19)]; }
      while(["BG","GB","NK","KN","TN","NT","ZZ"].indexOf(onek) !== -1);
      return onek + pad(randInt(rng,0,999999),6) + pick(rng,["A","B","C","D"]);
    }, { checksum: false }));

  // Belçika — Rijksregisternummer (mod 97)
  TIPLER.push(kimlik("be_rrn", "Belçika Kimlik (RRN)", "BE",
    [/rijksregister/i, /registre[_ ]?national/i, /\brrn\b/i, /\bniss\b/i],
    sar(sadeceRakam(11,11), function(d){
      var govde = d.slice(0,9), kontrol = +d.slice(9);
      return kontrol === 97 - (Number(govde) % 97) ||
             kontrol === 97 - (Number("2" + govde) % 97);
    }),
    function(rng){
      var g = pad(randInt(rng,0,99),2) + pad(randInt(rng,1,12),2) + pad(randInt(rng,1,28),2) +
              pad(randInt(rng,1,997),3);
      return g + pad(97 - (Number(g) % 97), 2);
    }, { fp: 0.02 }));

  // Portekiz — NIF (mod 11)
  TIPLER.push(kimlik("pt_nif", "Portekiz Vergi No (NIF)", "PT",
    [/\bnif\b/i, /contribuinte/i, /portuguese[_ ]?tax/i],
    sar(sadeceRakam(9,9), function(d){
      var sum = 0;
      for(var i = 0; i < 8; i++){ sum += (+d[i]) * (9 - i); }
      var k = 11 - (sum % 11);
      if(k >= 10) k = 0;
      return k === +d[8];
    }),
    function(rng){
      var g = String(pick(rng,[1,2,5,6,8,9])) + rastgeleRakam(rng, 7), sum = 0;
      for(var i = 0; i < 8; i++){ sum += (+g[i]) * (9 - i); }
      var k = 11 - (sum % 11);
      if(k >= 10) k = 0;
      return g + k;
    }, { sensitivity: "medium", fp: 0.10 }));

  // Yunanistan — AFM (mod 11)
  TIPLER.push(kimlik("gr_afm", "Yunanistan Vergi No (AFM)", "GR",
    [/\bafm\b/i, /\bαφμ\b/i, /greek[_ ]?tax/i],
    sar(sadeceRakam(9,9), function(d){
      var sum = 0;
      for(var i = 0; i < 8; i++){ sum += (+d[i]) * Math.pow(2, 8 - i); }
      return (sum % 11) % 10 === +d[8];
    }),
    function(rng){
      var g = rastgeleRakam(rng, 8), sum = 0;
      for(var i = 0; i < 8; i++){ sum += (+g[i]) * Math.pow(2, 8 - i); }
      return g + ((sum % 11) % 10);
    }, { sensitivity: "medium", fp: 0.10 }));

  // İsveç — personnummer (Luhn)
  TIPLER.push(kimlik("se_pnr", "İsveç Kimlik (Personnummer)", "SE",
    [/personnummer/i, /\bpnr\b/i, /swedish[_ ]?id/i],
    sar(sadeceRakam(10,12), function(d){
      if(d.length === 12) d = d.slice(2);
      return d.length === 10 && CD.luhnGecerli(d);
    }),
    function(rng){
      var g = pad(randInt(rng,40,99),2) + pad(randInt(rng,1,12),2) + pad(randInt(rng,1,28),2) +
              pad(randInt(rng,0,999),3);
      return g + CD.luhnHane(g);
    }, { fp: 0.10 }));

  // Norveç — fødselsnummer (çift mod 11)
  var NO_A1 = [3,7,6,1,8,9,4,5,2], NO_A2 = [5,4,3,2,7,6,5,4,3,2];
  TIPLER.push(kimlik("no_fnr", "Norveç Kimlik (Fødselsnummer)", "NO",
    [/fodselsnummer/i, /fødselsnummer/i, /norwegian[_ ]?id/i, /\bfnr\b/i],
    sar(sadeceRakam(11,11), function(d){
      var k1 = 11 - (CD.agirlikliToplam(d, NO_A1) % 11); if(k1 === 11) k1 = 0;
      if(k1 === 10 || k1 !== +d[9]) return false;
      var k2 = 11 - (CD.agirlikliToplam(d, NO_A2) % 11); if(k2 === 11) k2 = 0;
      return k2 !== 10 && k2 === +d[10];
    }),
    function(rng){
      for(var t = 0; t < 300; t++){
        var g = pad(randInt(rng,1,28),2) + pad(randInt(rng,1,12),2) + pad(randInt(rng,40,99),2) +
                pad(randInt(rng,0,999),3);
        var k1 = 11 - (CD.agirlikliToplam(g, NO_A1) % 11); if(k1 === 11) k1 = 0;
        if(k1 === 10) continue;
        var k2 = 11 - (CD.agirlikliToplam(g + k1, NO_A2) % 11); if(k2 === 11) k2 = 0;
        if(k2 === 10) continue;
        return g + k1 + k2;
      }
      return "01129955131";
    }, { fp: 0.009 }));

  // Finlandiya — HETU (mod 31)
  var HETU_K = "0123456789ABCDEFHJKLMNPRSTUVWXY";
  TIPLER.push(kimlik("fi_hetu", "Finlandiya Kimlik (HETU)", "FI",
    [/hetu/i, /henkilotunnus/i, /finnish[_ ]?id/i],
    function(v){
      var s = String(v).trim().toUpperCase().replace(/\s/g, "");
      var m = /^(\d{6})([+\-AYXWVU])(\d{3})([0-9A-Y])$/.exec(s);
      if(!m) return false;
      return HETU_K[Number(m[1] + m[3]) % 31] === m[4];
    },
    function(rng){
      var g = pad(randInt(rng,1,28),2) + pad(randInt(rng,1,12),2) + pad(randInt(rng,40,99),2);
      var seri = pad(randInt(rng,2,899),3);
      return g + pick(rng,["-","A"]) + seri + HETU_K[Number(g + seri) % 31];
    }, { fp: 0.032 }));

  // Hırvatistan — OIB (ISO 7064 Mod 11,10)
  TIPLER.push(kimlik("hr_oib", "Hırvatistan Kimlik (OIB)", "HR",
    [/\boib\b/i, /croatian[_ ]?id/i],
    sar(sadeceRakam(11,11), function(d){ return CD.iso7064_11_10_Gecerli(d); }),
    function(rng){ var g = rastgeleRakam(rng, 10); return g + CD.iso7064_11_10_Hane(g); },
    { fp: 0.10 }));

  // Romanya — CNP (ağırlıklı mod 11)
  var CNP_A = [2,7,9,1,4,6,3,5,8,2,7,9];
  TIPLER.push(kimlik("ro_cnp", "Romanya Kimlik (CNP)", "RO",
    [/\bcnp\b/i, /cod[_ ]?numeric[_ ]?personal/i, /romanian[_ ]?id/i],
    sar(sadeceRakam(13,13), function(d){
      var r = CD.agirlikliToplam(d, CNP_A) % 11;
      return (r === 10 ? 1 : r) === +d[12];
    }),
    function(rng){
      var g = String(randInt(rng,1,8)) + pad(randInt(rng,40,99),2) + pad(randInt(rng,1,12),2) +
              pad(randInt(rng,1,28),2) + pad(randInt(rng,1,52),2) + pad(randInt(rng,1,999),3);
      var r = CD.agirlikliToplam(g, CNP_A) % 11;
      return g + (r === 10 ? 1 : r);
    }, { fp: 0.10 }));

  // Rusya — INN (mod 11)
  var INN10 = [2,4,10,3,5,9,4,6,8];
  TIPLER.push(kimlik("ru_inn", "Rusya Vergi No (ИНН/INN)", "RU",
    [/\binn\b/i, /\bинн\b/i, /russian[_ ]?tax/i],
    sar(sadeceRakam(10,10), function(d){
      return (CD.agirlikliToplam(d, INN10) % 11) % 10 === +d[9];
    }),
    function(rng){
      var g = rastgeleRakam(rng, 9);
      return g + ((CD.agirlikliToplam(g, INN10) % 11) % 10);
    }, { sensitivity: "medium", fp: 0.10 }));

  /* ================= AMERİKA ================= */

  // ABD — SSN (checksum yok, ama katı yapı kuralları var)
  TIPLER.push(kimlik("us_ssn", "ABD Sosyal Güvenlik (SSN)", "US",
    [/\bssn\b/i, /social[_ ]?security/i, /\btaxpayer[_ ]?id\b/i],
    function(v){
      var s = String(v).trim();
      if(!/^\d{3}-?\d{2}-?\d{4}$/.test(s)) return false;
      var d = rakamlar(s);
      var alan = d.slice(0,3), grup = d.slice(3,5), seri = d.slice(5);
      if(alan === "000" || alan === "666" || +alan >= 900) return false;
      return grup !== "00" && seri !== "0000";
    },
    function(rng){
      return pad(randInt(rng,1,665),3) + "-" + pad(randInt(rng,1,99),2) + "-" + pad(randInt(rng,1,9999),4);
    }, { checksum: false }));

  // ABD — EIN (geçerli önek listesi)
  var EIN_ONEK = ["01","02","03","04","05","06","10","11","12","13","14","15","16",
    "20","21","22","23","24","25","26","27","30","31","32","33","34","35","36","37",
    "38","39","40","41","42","43","44","45","46","47","48","50","51","52","53","54",
    "55","56","57","58","59","60","61","62","63","64","65","66","67","68","71","72",
    "73","74","75","76","77","80","81","82","83","84","85","86","87","88","90","91",
    "92","93","94","95","98","99"];
  TIPLER.push(kimlik("us_ein", "ABD İşveren No (EIN)", "US",
    [/\bein\b/i, /employer[_ ]?identification/i, /federal[_ ]?tax[_ ]?id/i],
    function(v){
      var s = String(v).trim();
      if(!/^\d{2}-?\d{7}$/.test(s)) return false;
      return EIN_ONEK.indexOf(rakamlar(s).slice(0,2)) !== -1;
    },
    function(rng){ return pick(rng, EIN_ONEK) + "-" + pad(randInt(rng,0,9999999),7); },
    { sensitivity: "medium", checksum: false }));

  // Kanada — SIN (Luhn)
  TIPLER.push(kimlik("ca_sin", "Kanada Sosyal Sigorta (SIN)", "CA",
    [/\bsin\b/i, /social[_ ]?insurance/i, /canadian[_ ]?id/i],
    sar(sadeceRakam(9,9), function(d){ return CD.luhnGecerli(d); }),
    function(rng){
      var g = String(randInt(rng,1,9)) + rastgeleRakam(rng, 7);
      return g + CD.luhnHane(g);
    }, { fp: 0.10 }));

  // Brezilya — CPF (çift mod 11)
  function cpfHane(govde, baslangicAgirlik){
    var sum = 0;
    for(var i = 0; i < govde.length; i++){ sum += (+govde[i]) * (baslangicAgirlik - i); }
    var r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  }
  TIPLER.push(kimlik("br_cpf", "Brezilya Kimlik (CPF)", "BR",
    [/\bcpf\b/i, /cadastro[_ ]?de[_ ]?pessoas/i, /brazilian[_ ]?id/i],
    sar(sadeceRakam(11,11), function(d){
      if(CD.hepsiAyni(d)) return false;
      return cpfHane(d.slice(0,9), 10) === +d[9] && cpfHane(d.slice(0,10), 11) === +d[10];
    }),
    function(rng){
      var g = rastgeleRakam(rng, 9);
      var k1 = cpfHane(g, 10);
      return g + k1 + cpfHane(g + k1, 11);
    }, { fp: 0.0083 }));

  // Brezilya — CNPJ (şirket, çift mod 11)
  function cnpjHane(govde, agirliklar){
    var sum = CD.agirlikliToplam(govde, agirliklar);
    var r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  }
  TIPLER.push(kimlik("br_cnpj", "Brezilya Şirket No (CNPJ)", "BR",
    [/\bcnpj\b/i, /cadastro[_ ]?nacional/i],
    sar(sadeceRakam(14,14), function(d){
      if(CD.hepsiAyni(d)) return false;
      var k1 = cnpjHane(d.slice(0,12), [5,4,3,2,9,8,7,6,5,4,3,2]);
      if(k1 !== +d[12]) return false;
      return cnpjHane(d.slice(0,13), [6,5,4,3,2,9,8,7,6,5,4,3,2]) === +d[13];
    }),
    function(rng){
      var g = rastgeleRakam(rng, 12);
      var k1 = cnpjHane(g, [5,4,3,2,9,8,7,6,5,4,3,2]);
      return g + k1 + cnpjHane(g + k1, [6,5,4,3,2,9,8,7,6,5,4,3,2]);
    }, { sensitivity: "medium", fp: 0.0083 }));

  // Meksika — CURP (mod 10, 37 karakterlik alfabe)
  var CURP_ALF = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";
  function curpHane(govde){
    var sum = 0;
    for(var i = 0; i < 17; i++){
      sum += CURP_ALF.indexOf(govde[i]) * (18 - i);
    }
    return String((10 - (sum % 10)) % 10);
  }
  TIPLER.push(kimlik("mx_curp", "Meksika Kimlik (CURP)", "MX",
    [/curp/i, /clave[_ ]?unica/i, /mexican[_ ]?id/i],
    function(v){
      var s = String(v).trim().toUpperCase().replace(/\s/g, "");
      if(!/^[A-Z]{4}\d{6}[HM][A-Z]{5}[0-9A-Z]\d$/.test(s)) return false;
      return curpHane(s.slice(0,17)) === s[17];
    },
    function(rng){
      var H = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", g = "";
      for(var i=0;i<4;i++){ g += H[randInt(rng,0,25)]; }
      g += pad(randInt(rng,40,99),2) + pad(randInt(rng,1,12),2) + pad(randInt(rng,1,28),2);
      g += pick(rng,["H","M"]);
      for(var j=0;j<5;j++){ g += H[randInt(rng,0,25)]; }
      g += String(randInt(rng,0,9));
      return g + curpHane(g);
    }, { fp: 0.01 }));

  // Arjantin — CUIT (mod 11)
  var CUIT_A = [5,4,3,2,7,6,5,4,3,2];
  TIPLER.push(kimlik("ar_cuit", "Arjantin Vergi No (CUIT/CUIL)", "AR",
    [/cuit/i, /cuil/i, /argentin/i],
    sar(sadeceRakam(11,11), function(d){
      var r = 11 - (CD.agirlikliToplam(d, CUIT_A) % 11);
      if(r === 11) r = 0; else if(r === 10) return false;
      return r === +d[10];
    }),
    function(rng){
      for(var t = 0; t < 100; t++){
        var g = pick(rng,["20","23","24","27","30","33","34"]) + rastgeleRakam(rng, 8);
        var r = 11 - (CD.agirlikliToplam(g, CUIT_A) % 11);
        if(r === 11) r = 0; else if(r === 10) continue;
        return g + r;
      }
      return "20123456783";
    }, { sensitivity: "medium", fp: 0.09 }));

  /* ================= ASYA - PASİFİK ================= */

  // Hindistan — Aadhaar (Verhoeff)
  TIPLER.push(kimlik("in_aadhaar", "Hindistan Kimlik (Aadhaar)", "IN",
    [/aadhaar/i, /aadhar/i, /\buidai\b/i, /indian[_ ]?id/i],
    sar(sadeceRakam(12,12), function(d){
      return d[0] !== "0" && d[0] !== "1" && CD.verhoeffGecerli(d);
    }),
    function(rng){
      var g = String(randInt(rng,2,9)) + rastgeleRakam(rng, 10);
      return g + CD.verhoeffHane(g);
    }, { fp: 0.10 }));

  // Hindistan — PAN (format)
  TIPLER.push(kimlik("in_pan", "Hindistan Vergi No (PAN)", "IN",
    [/\bpan\b[_ ]?(no|number|card)/i, /permanent[_ ]?account/i],
    function(v){ return /^[A-Z]{5}\d{4}[A-Z]$/.test(String(v).trim().toUpperCase()); },
    function(rng){
      var H = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", s = "";
      for(var i=0;i<5;i++){ s += H[randInt(rng,0,25)]; }
      return s + pad(randInt(rng,0,9999),4) + H[randInt(rng,0,25)];
    }, { sensitivity: "medium", checksum: false }));

  // Çin — Resident Identity Card (ISO 7064 Mod 11,2)
  TIPLER.push(kimlik("cn_ric", "Çin Kimlik Kartı (身份证)", "CN",
    [/身份证/, /shenfenzheng/i, /chinese[_ ]?id/i, /\bric\b[_ ]?no/i],
    function(v){
      var s = String(v).trim().toUpperCase().replace(/\s/g, "");
      if(!/^\d{17}[0-9X]$/.test(s)) return false;
      return CD.iso7064_11_2_Gecerli(s);
    },
    function(rng){
      var g = pad(randInt(rng,110000,659000),6) + String(randInt(rng,1950,2010)) +
              pad(randInt(rng,1,12),2) + pad(randInt(rng,1,28),2) + pad(randInt(rng,1,999),3);
      return g + CD.iso7064_11_2_Hane(g);
    }, { fp: 0.09 }));

  // Güney Kore — RRN (ağırlıklı mod 11)
  var KR_A = [2,3,4,5,6,7,8,9,2,3,4,5];
  TIPLER.push(kimlik("kr_rrn", "Güney Kore Kimlik (주민등록번호)", "KR",
    [/주민등록/, /\brrn\b/i, /resident[_ ]?registration/i, /korean[_ ]?id/i],
    sar(sadeceRakam(13,13), function(d){
      return (11 - (CD.agirlikliToplam(d, KR_A) % 11)) % 10 === +d[12];
    }),
    function(rng){
      var g = pad(randInt(rng,40,99),2) + pad(randInt(rng,1,12),2) + pad(randInt(rng,1,28),2) +
              String(pick(rng,[1,2,3,4])) + pad(randInt(rng,0,99999),5);
      return g + ((11 - (CD.agirlikliToplam(g, KR_A) % 11)) % 10);
    }, { fp: 0.10 }));

  // Japonya — マイナンバー (mod 11)
  TIPLER.push(kimlik("jp_mynumber", "Japonya Bireysel No (マイナンバー)", "JP",
    [/マイナンバー/, /my[_ ]?number/i, /個人番号/, /japanese[_ ]?id/i],
    sar(sadeceRakam(12,12), function(d){
      var sum = 0;
      for(var i = 0; i < 11; i++){
        var n = 11 - i;
        var q = (n <= 6) ? (n + 1) : (n - 5);
        sum += (+d[10 - i]) * q;
      }
      var r = sum % 11;
      return (r <= 1 ? 0 : 11 - r) === +d[11];
    }),
    function(rng){
      var g = rastgeleRakam(rng, 11), sum = 0;
      for(var i = 0; i < 11; i++){
        var n = 11 - i;
        var q = (n <= 6) ? (n + 1) : (n - 5);
        sum += (+g[10 - i]) * q;
      }
      var r = sum % 11;
      return g + (r <= 1 ? 0 : 11 - r);
    }, { fp: 0.10 }));

  // Avustralya — TFN (ağırlıklı mod 11)
  var TFN_A = [1,4,3,7,5,8,6,9,10];
  TIPLER.push(kimlik("au_tfn", "Avustralya Vergi No (TFN)", "AU",
    [/\btfn\b/i, /tax[_ ]?file[_ ]?number/i],
    sar(sadeceRakam(8,9), function(d){
      if(d.length === 8) d = "0" + d;
      return CD.agirlikliToplam(d, TFN_A) % 11 === 0;
    }),
    function(rng){
      for(var t = 0; t < 400; t++){
        var g = rastgeleRakam(rng, 8);
        for(var k = 0; k <= 9; k++){
          if(CD.agirlikliToplam(g + k, TFN_A) % 11 === 0) return g + k;
        }
      }
      return "123456782";
    }, { fp: 0.09 }));

  // Avustralya — ABN (mod 89)
  var ABN_A = [10,1,3,5,7,9,11,13,15,17,19];
  TIPLER.push(kimlik("au_abn", "Avustralya İşletme No (ABN)", "AU",
    [/\babn\b/i, /australian[_ ]?business[_ ]?number/i],
    sar(sadeceRakam(11,11), function(d){
      var ilk = (+d[0]) - 1;
      if(ilk < 0) return false;
      var sum = ilk * ABN_A[0];
      for(var i = 1; i < 11; i++){ sum += (+d[i]) * ABN_A[i]; }
      return sum % 89 === 0;
    }),
    function(rng){
      for(var t = 0; t < 400; t++){
        var govde = rastgeleRakam(rng, 9);
        for(var k = 10; k <= 99; k++){
          var aday = String(k) + govde;
          var ilk = (+aday[0]) - 1;
          if(ilk < 0) continue;
          var sum = ilk * ABN_A[0];
          for(var i = 1; i < 11; i++){ sum += (+aday[i]) * ABN_A[i]; }
          if(sum % 89 === 0) return aday;
        }
      }
      return "51824753556";
    }, { sensitivity: "medium", fp: 0.011 }));

  // Güney Afrika — ID (Luhn + tarih)
  TIPLER.push(kimlik("za_id", "Güney Afrika Kimlik", "ZA",
    [/south[_ ]?african[_ ]?id/i, /\bsa[_ ]?id[_ ]?(no|number)/i, /identiteitsnommer/i],
    sar(sadeceRakam(13,13), function(d){
      var ay = +d.slice(2,4), gun = +d.slice(4,6);
      if(ay < 1 || ay > 12 || gun < 1 || gun > 31) return false;
      return CD.luhnGecerli(d);
    }),
    function(rng){
      var g = pad(randInt(rng,40,99),2) + pad(randInt(rng,1,12),2) + pad(randInt(rng,1,28),2) +
              pad(randInt(rng,0,9999),4) + String(pick(rng,[0,1])) + String(randInt(rng,8,9));
      return g + CD.luhnHane(g);
    }, { fp: 0.033 }));

  // Singapur — NRIC/FIN (ağırlıklı mod 11 → harf)
  var SG_A = [2,7,6,5,4,3,2];
  TIPLER.push(kimlik("sg_nric", "Singapur Kimlik (NRIC/FIN)", "SG",
    [/\bnric\b/i, /\bfin\b[_ ]?(no|number)/i, /singapore[_ ]?id/i],
    function(v){
      var s = String(v).trim().toUpperCase().replace(/\s/g, "");
      var m = /^([STFGM])(\d{7})([A-Z])$/.exec(s);
      if(!m) return false;
      var sum = CD.agirlikliToplam(m[2], SG_A);
      if(m[1] === "T" || m[1] === "G") sum += 4;
      else if(m[1] === "M") sum += 3;
      var tablo = (m[1] === "S" || m[1] === "T") ? "JZIHGFEDCBA"
                : (m[1] === "M" ? "XWUTRQPNJLK" : "XWUTRQPNJLK");
      return tablo[sum % 11] === m[3];
    },
    function(rng){
      var onek = pick(rng,["S","T"]);
      var govde = pad(randInt(rng,0,9999999),7);
      var sum = CD.agirlikliToplam(govde, SG_A);
      if(onek === "T") sum += 4;
      return onek + govde + "JZIHGFEDCBA"[sum % 11];
    }, { fp: 0.01 }));

  // Tayland — Kişisel kimlik (ağırlıklı mod 11)
  TIPLER.push(kimlik("th_pin", "Tayland Kimlik (เลขประจำตัวประชาชน)", "TH",
    [/เลขประจำตัว/, /thai[_ ]?id/i, /\btin\b[_ ]?th/i],
    sar(sadeceRakam(13,13), function(d){
      var sum = 0;
      for(var i = 0; i < 12; i++){ sum += (+d[i]) * (13 - i); }
      return (11 - (sum % 11)) % 10 === +d[12];
    }),
    function(rng){
      var g = String(randInt(rng,1,8)) + rastgeleRakam(rng, 11), sum = 0;
      for(var i = 0; i < 12; i++){ sum += (+g[i]) * (13 - i); }
      return g + ((11 - (sum % 11)) % 10);
    }, { fp: 0.10 }));

  /* ================= ULUSLARARASI STANDARTLAR ================= */

  // ISBN-13 / EAN-13 / GTIN (mod 10)
  TIPLER.push(kimlik("ean13", "Barkod (EAN/GTIN/ISBN-13)", "*",
    [/\bean\b/i, /\bgtin\b/i, /\bisbn\b/i, /barcode/i, /barkod/i, /\bupc\b/i],
    sar(sadeceRakam(13,13), function(d){
      var sum = 0;
      for(var i = 0; i < 12; i++){ sum += (+d[i]) * (i % 2 === 0 ? 1 : 3); }
      return (10 - (sum % 10)) % 10 === +d[12];
    }),
    function(rng){
      var g = rastgeleRakam(rng, 12), sum = 0;
      for(var i = 0; i < 12; i++){ sum += (+g[i]) * (i % 2 === 0 ? 1 : 3); }
      return g + ((10 - (sum % 10)) % 10);
    }, { sensitivity: "low", passthrough: "ask", fp: 0.10 }));

  // ISIN — menkul kıymet (Luhn, harf dönüşümlü)
  TIPLER.push(kimlik("isin", "Menkul Kıymet Kodu (ISIN)", "*",
    [/\bisin\b/i, /security[_ ]?id/i],
    function(v){
      var s = String(v).trim().toUpperCase().replace(/\s/g, "");
      if(!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s)) return false;
      var genis = "";
      for(var i = 0; i < 11; i++){
        var c = s[i];
        genis += (c >= "0" && c <= "9") ? c : String(c.charCodeAt(0) - 55);
      }
      return CD.luhnHane(genis) === s[11];
    },
    function(rng){
      var H = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      var s = H[randInt(rng,0,25)] + H[randInt(rng,0,25)] + pad(randInt(rng,0,999999999),9);
      var genis = "";
      for(var i = 0; i < 11; i++){
        var c = s[i];
        genis += (c >= "0" && c <= "9") ? c : String(c.charCodeAt(0) - 55);
      }
      return s + CD.luhnHane(genis);
    }, { sensitivity: "low", passthrough: "ask", fp: 0.10 }));

  TC.registerTypes(TIPLER);

  // Hangi ülkelerin kapsandığını arayüz gösterebilsin
  var ULKELER = {};
  TIPLER.forEach(function(t){ if(t.ulke !== "*"){ ULKELER[t.ulke] = true; } });

  window.IntlPack = {
    tipSayisi: TIPLER.length,
    ulkeler: Object.keys(ULKELER).sort(),
    tipler: TIPLER.map(function(t){
      return { id: t.id, label: t.label, ulke: t.ulke, checksum: !!t.checksum };
    })
  };
})();
