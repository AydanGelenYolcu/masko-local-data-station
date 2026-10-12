/* Maskeleme İstasyonu — Veri Tipi Kataloğu
 *
 * Her tip üç soruyu cevaplar:
 *   1. Nasıl tanınır?  -> header ipuçları + hücre örüntüsü + (varsa) checksum
 *   2. Ne kadar hassas? -> VERBİS veri kategorisi + KVKK m.6 özel nitelikli mi
 *   3. Sahtesi nasıl üretilir? -> gen()
 *
 * Kategoriler VERBİS'in 24 veri kategorisiyle hizalanmıştır.
 * Checksum'lı tipler (TCKN, VKN, IBAN, kart, IMEI) kolon örneklemesiyle
 * birleştiğinde neredeyse kesin tespit verir — bkz. table-engine.js.
 */
(function(){
  "use strict";

  /* ---------------------------------------------------------------
   * Deterministik rastgelelik — aynı dosya her zaman aynı sahte veriyi
   * üretsin diye (kullanıcı iki kez denerse kafası karışmasın).
   * --------------------------------------------------------------- */
  function makeRng(seed){
    var s = seed >>> 0;
    return function(){
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashSeed(str){
    var h = 2166136261;
    for(var i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function pick(rng, arr){ return arr[Math.floor(rng() * arr.length) % arr.length]; }
  function randInt(rng, min, max){ return min + Math.floor(rng() * (max - min + 1)); }
  function digitsOf(v){ return String(v).replace(/\D/g, ""); }
  // IBAN biçimi (kontrol hanesine bakmadan): ülke kodu + 2 rakam + 11-30 harf/rakam.
  // Büyük harf şart: "Ab12Cd34…" gibi karışık harfli belirteç IBAN sayılmasın.
  function ibanBicimi(v){ return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(String(v).replace(/\s+/g, "")); }
  function pad(n, len){ var s = String(n); while(s.length < len){ s = "0" + s; } return s; }

  /* Şekil koruması — bir doğrulayıcıyı doğrudan hücreye uygulamak tehlikelidir:
     "Çalışan 0532 111 22 33 numarasından aradı" cümlesinden rakamları
     söküp bakarsanız geçerli bir telefon görürsünüz. Bu sarmalayıcı, hücrenin
     BAŞTAN SONA o tanımlayıcı olmasını şart koşar. Serbest metnin içine gömülü
     PII ayrı bir iştir (mevcut metin motoru hücre içinde çalıştırılır). */
  function rakamAlani(fn, minLen, maxLen){
    return function(v){
      var s = String(v).trim();
      if(!s || !/^[\d][\d\s.()\/+-]*$/.test(s)) return false;
      var d = digitsOf(s);
      if(d.length < minLen || d.length > maxLen) return false;
      return fn(s);
    };
  }

  /* ---------------------------------------------------------------
   * Checksum doğrulayıcıları ve üreteçleri
   * --------------------------------------------------------------- */

  // TCKN — 11 hane, iki kontrol basamağı. Rastgele bir sayının geçme
  // ihtimali ~%1; 50 satırın hepsi geçerse tespit kesindir.
  function tcknValid(raw){
    var s = digitsOf(raw);
    if(s.length !== 11) return false;
    var d = s.split("").map(Number);
    if(d[0] === 0) return false;
    var odd = d[0]+d[2]+d[4]+d[6]+d[8];
    var even = d[1]+d[3]+d[5]+d[7];
    if((((odd*7 - even) % 10) + 10) % 10 !== d[9]) return false;
    var sum = 0;
    for(var i=0;i<10;i++){ sum += d[i]; }
    return sum % 10 === d[10];
  }
  function tcknGen(rng){
    var d = [randInt(rng,1,9)];
    for(var i=1;i<9;i++){ d.push(randInt(rng,0,9)); }
    var odd = d[0]+d[2]+d[4]+d[6]+d[8];
    var even = d[1]+d[3]+d[5]+d[7];
    d.push((((odd*7 - even) % 10) + 10) % 10);
    var sum = 0;
    for(var j=0;j<10;j++){ sum += d[j]; }
    d.push(sum % 10);
    return d.join("");
  }

  // YKN — yabancılara verilen kimlik no. 99 ile başlar, aynı checksum.
  function yknValid(raw){
    var s = digitsOf(raw);
    return s.length === 11 && s.slice(0,2) === "99" && tcknValid(s);
  }
  function yknGen(rng){
    // 99 ile başlayan geçerli bir numara bulunana kadar dene
    for(var t=0;t<400;t++){
      var d = [9,9];
      for(var i=2;i<9;i++){ d.push(randInt(rng,0,9)); }
      var odd = d[0]+d[2]+d[4]+d[6]+d[8];
      var even = d[1]+d[3]+d[5]+d[7];
      d.push((((odd*7 - even) % 10) + 10) % 10);
      var sum = 0;
      for(var j=0;j<10;j++){ sum += d[j]; }
      d.push(sum % 10);
      return d.join("");
    }
    return "99000000146";
  }

  // VKN — 10 hane. Algoritma: her hane için (d + 10-(i+1)) % 10, sonra
  // 9 değilse 2^(10-(i+1)) ile çarpıp mod 9. Kaynak: GİB algoritması.
  function vknValid(raw){
    var s = String(raw).trim();
    if(!/^\d{10}$/.test(s)) return false;
    var total = 0;
    for(var i=0;i<9;i++){
      var mod = (Number(s[i]) + 10 - (i+1)) % 10;
      if(mod === 9){ total += 9; }
      else { total += (mod * Math.pow(2, 10 - (i+1))) % 9; }
    }
    return ((10 - (total % 10)) % 10) === Number(s[9]);
  }
  function vknGen(rng){
    var s = "";
    for(var i=0;i<9;i++){ s += randInt(rng, i === 0 ? 1 : 0, 9); }
    var total = 0;
    for(var j=0;j<9;j++){
      var mod = (Number(s[j]) + 10 - (j+1)) % 10;
      if(mod === 9){ total += 9; }
      else { total += (mod * Math.pow(2, 10 - (j+1))) % 9; }
    }
    return s + ((10 - (total % 10)) % 10);
  }

  // SWIFT IBAN Registry Release 102 (Jun 2026): ülke kodu -> sabit IBAN uzunluğu.
  // Uzunluk kontrolü olmadan bir sonraki kelime IBAN'ın devamı sanılabiliyordu.
  var IBAN_LENGTHS = {
    AD:24, AE:23, AL:28, AT:20, AZ:28, BA:20, BE:16, BG:22, BH:22, BI:27,
    BR:29, BY:28, CH:21, CR:22, CY:28, CZ:24, DE:22, DJ:27, DK:18, DO:28,
    EE:20, EG:29, ES:24, FI:18, FK:18, FO:18, FR:27, GB:22, GE:22, GI:23,
    GL:18, GR:27, GT:28, HN:28, HR:21, HU:28, IE:22, IL:23, IQ:23, IS:26,
    IT:27, JO:30, KW:30, KZ:20, LB:28, LC:32, LI:21, LT:20, LU:20, LV:21,
    LY:25, MC:27, MD:24, ME:22, MK:19, MN:20, MR:27, MT:31, MU:30, NI:32,
    NL:18, NO:15, OM:23, PK:24, PL:28, PS:29, PT:25, QA:29, RO:24, RS:22,
    RU:33, SA:24, SC:31, SD:18, SE:24, SI:19, SK:24, SM:27, SO:23, ST:25,
    SV:28, TL:23, TN:24, TR:26, UA:29, VA:22, VG:24, XK:20, YE:30
  };

  // IBAN — ülke uzunluğu + MOD97-10 checksum.
  function ibanValid(raw){
    var s = String(raw).replace(/\s+/g,"").toUpperCase();
    var expectedLength = IBAN_LENGTHS[s.slice(0,2)];
    if(!expectedLength || s.length !== expectedLength || !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
    return ibanMod97(s.slice(4) + s.slice(0,4)) === 1;
  }
  function ibanMod97(str){
    var rem = 0;
    for(var i=0;i<str.length;i++){
      var ch = str[i];
      var part = (ch >= "0" && ch <= "9") ? ch : String(ch.charCodeAt(0) - 55);
      for(var k=0;k<part.length;k++){ rem = (rem*10 + Number(part[k])) % 97; }
    }
    return rem;
  }
  // TR IBAN: TR + 2 kontrol + 5 banka + 1 rezerv(0) + 16 hesap = 26 karakter
  function ibanGenTR(rng){
    var bank = pick(rng, ["00061","00062","00010","00012","00015","00046","00064","00067","00111","00123"]);
    var acct = "";
    for(var i=0;i<16;i++){ acct += randInt(rng,0,9); }
    var bban = bank + "0" + acct;
    var check = 98 - ibanMod97(bban + "TR00");
    return "TR" + pad(check, 2) + bban;
  }

  // Luhn — kredi kartı ve IMEI
  function luhnValid(raw){
    var s = digitsOf(raw);
    if(s.length < 12 || s.length > 19) return false;
    return luhnSum(s) % 10 === 0;
  }
  function luhnSum(s){
    var sum = 0, alt = false;
    for(var i=s.length-1;i>=0;i--){
      var n = Number(s[i]);
      if(alt){ n *= 2; if(n > 9){ n -= 9; } }
      sum += n; alt = !alt;
    }
    return sum;
  }
  function luhnCheckDigit(partial){
    var sum = luhnSum(partial + "0");
    return String((10 - (sum % 10)) % 10);
  }
  // Bilinen TEST BIN aralıklarını kullanıyoruz — gerçek bir karta denk
  // gelme ihtimalini sıfırlamak için (4111.., 5555.., 3782..).
  function cardGen(rng){
    var brand = pick(rng, [
      { prefix: "411111", len: 16 },
      { prefix: "555555", len: 16 },
      { prefix: "400000", len: 16 }
    ]);
    var body = brand.prefix;
    while(body.length < brand.len - 1){ body += randInt(rng,0,9); }
    return body + luhnCheckDigit(body);
  }
  function imeiValid(raw){
    var s = digitsOf(raw);
    return s.length === 15 && luhnSum(s) % 10 === 0;
  }
  function imeiGen(rng){
    var body = "35";
    while(body.length < 14){ body += randInt(rng,0,9); }
    return body + luhnCheckDigit(body);
  }

  /* ---------------------------------------------------------------
   * Sözlükler — sahte üretim ve "güvenli kelime dağarcığı" kontrolü için
   * --------------------------------------------------------------- */
  var AD_ERKEK = ["Ahmet","Mehmet","Mustafa","Ali","Hüseyin","Hasan","İbrahim","Osman","Yusuf","Murat",
    "Ömer","Ramazan","Kemal","Emre","Burak","Serkan","Onur","Kaan","Deniz","Barış","Cem","Tolga","Volkan","Uğur"];
  var AD_KADIN = ["Ayşe","Fatma","Emine","Hatice","Zeynep","Elif","Meryem","Şerife","Zehra","Sultan",
    "Hanife","Merve","Özlem","Gamze","Seda","Pınar","Ebru","Derya","Selin","Buse","Ceren","Melis","Nazlı","İrem"];
  var SOYAD = ["Yılmaz","Kaya","Demir","Şahin","Çelik","Yıldız","Yıldırım","Öztürk","Aydın","Özdemir",
    "Arslan","Doğan","Kılıç","Aslan","Çetin","Kara","Koç","Kurt","Özkan","Şimşek","Polat","Korkmaz","Erdoğan","Güneş"];

  var ILLER = ["Adana","Adıyaman","Afyonkarahisar","Ağrı","Amasya","Ankara","Antalya","Artvin","Aydın","Balıkesir",
    "Bilecik","Bingöl","Bitlis","Bolu","Burdur","Bursa","Çanakkale","Çankırı","Çorum","Denizli","Diyarbakır","Edirne",
    "Elazığ","Erzincan","Erzurum","Eskişehir","Gaziantep","Giresun","Gümüşhane","Hakkâri","Hatay","Isparta","Mersin",
    "İstanbul","İzmir","Kars","Kastamonu","Kayseri","Kırklareli","Kırşehir","Kocaeli","Konya","Kütahya","Malatya",
    "Manisa","Kahramanmaraş","Mardin","Muğla","Muş","Nevşehir","Niğde","Ordu","Rize","Sakarya","Samsun","Siirt",
    "Sinop","Sivas","Tekirdağ","Tokat","Trabzon","Tunceli","Şanlıurfa","Uşak","Van","Yozgat","Zonguldak","Aksaray",
    "Bayburt","Karaman","Kırıkkale","Batman","Şırnak","Bartın","Ardahan","Iğdır","Yalova","Karabük","Kilis",
    "Osmaniye","Düzce",
    // PASSO envanterinde KKTC de var (rehberdeki şehir filtresi)
    "Lefkoşa","Girne","Gazimağusa"];

  var AYLAR = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
  var GUNLER = ["Pazartesi","Salı","Çarşamba","Perşembe","Cuma","Cumartesi","Pazar"];
  var PARA = ["TRY","USD","EUR","GBP","TL","₺","$","€"];
  var EVET_HAYIR = ["Evet","Hayır","evet","hayır","E","H","Var","Yok","Aktif","Pasif","Açık","Kapalı",
    "True","False","true","false","Yes","No","Onaylı","Onaysız","Tamamlandı","Beklemede","İptal"];

  // Gerçek değerleri olduğu gibi geçirmek GÜVENLİ olan kelime dağarcıkları.
  // Bunlar kişiyi işaret etmez; grafik için de gerekli (harita, zaman ekseni).
  var GUVENLI_SOZLUKLER = [
    { id: "il", label: "Türkiye ili", words: ILLER },
    { id: "ay", label: "ay adı", words: AYLAR },
    { id: "gun", label: "gün adı", words: GUNLER },
    { id: "para", label: "para birimi", words: PARA },
    { id: "evet_hayir", label: "evet/hayır · durum", words: EVET_HAYIR }
  ];

  var _normOnbellek = Object.create(null);
  var _normSayac = 0;
  function normalizeTr(s){
    var k = String(s);
    var v = _normOnbellek[k];
    if(v !== undefined) return v;
    v = k.trim().toLocaleLowerCase("tr-TR");
    if(_normSayac < 20000){ _normOnbellek[k] = v; _normSayac++; }
    return v;
  }

  /* Veri İngilizce ya da ASCII'ye indirgenmiş gelebilir: "Gişe" yerine "Gise",
     "Beşiktaş" yerine "Besiktas". Sözlük eşleşmesi bunu görmezse kolon tanınmaz.
     Bu yüzden her sözlük hem Türkçe hem ASCII-katlanmış biçimde saklanır. */
  var ASCII_HARITA = { "ç":"c","ğ":"g","ı":"i","ö":"o","ş":"s","ü":"u",
                       "â":"a","î":"i","û":"u","é":"e" };
  function asciiKatla(s){
    return String(s).replace(/[çğıöşüâîûé]/g, function(c){ return ASCII_HARITA[c] || c; });
  }

  var _sozlukOnbellek = null;
  function sozlukKumeleri(){
    if(_sozlukOnbellek) return _sozlukOnbellek;
    _sozlukOnbellek = GUVENLI_SOZLUKLER.map(function(voc){
      var set = Object.create(null);
      for(var i=0;i<voc.words.length;i++){
        var n = normalizeTr(voc.words[i]);
        set[n] = true;
        set[asciiKatla(n)] = true;
      }
      return { voc: voc, set: set, id: voc.id };
    });
    return _sozlukOnbellek;
  }

  function sozlukKumesi(vocabId){
    var kumeler = sozlukKumeleri();
    for(var i=0;i<kumeler.length;i++){ if(kumeler[i].id === vocabId) return kumeler[i]; }
    return null;
  }

  function sozluktemi(deger, set){
    var n = normalizeTr(deger);
    return !!(set[n] || set[asciiKatla(n)]);
  }

  /* BELİRLİ bir sözlüğe ait mi? Önceden hepsi ortak bir teste bakıyordu ve
     "true/false" değeri stadyum sözlüğüne de uyuyormuş gibi davranıyordu —
     çünkü herhangi bir sözlükte bulunmak yeterliydi. */
  function guvenliSozluktemi(deger, vocabId){
    var k = sozlukKumesi(vocabId);
    return k ? sozluktemi(deger, k.set) : false;
  }

  // Bir değer kümesi tamamen (herhangi bir) güvenli sözlüğün içinde mi?
  // Yalnızca "gerçek değer geçebilir mi" kararı için kullanılır.
  function guvenliSozlukEslesmesi(values){
    if(!values.length) return null;
    var kumeler = sozlukKumeleri();
    var norm = new Array(values.length), asc = new Array(values.length);
    for(var n=0;n<values.length;n++){
      norm[n] = normalizeTr(values[n]);
      asc[n] = asciiKatla(norm[n]);
    }
    var esik = values.length;
    for(var i=0;i<kumeler.length;i++){
      var set = kumeler[i].set, hit = 0, kalan = values.length;
      for(var j=0;j<values.length;j++){
        if(set[norm[j]] || set[asc[j]]) hit++;
        kalan--;
        if(hit + kalan < esik) break;   // bu sözlük artık eşiği tutturamaz
      }
      if(hit >= esik) return kumeler[i].voc;
    }
    return null;
  }

  /* Sıralı görünen ama sahte bir kayıt numarası — kolonda gözlemlenen
     basamak sayısını korur, yoksa 5 haneli bir sicil 6 haneli üretilir. */
  function seriNo(rng, ctx, taban){
    var len = (ctx && ctx.uzunluk) || String(taban).length;
    var enAz = Math.pow(10, len - 1);
    var enCok = Math.pow(10, len) - 1;
    var deger = taban + ((ctx && ctx.index) || 0) * 3 + randInt(rng, 1, 9);
    while(deger > enCok){ deger -= (enCok - enAz); }
    if(deger < enAz){ deger += enAz; }
    return String(deger);
  }

  /* Kimlik biçimini korur: "USR-00123" → "USR-48213", "a8f3k2" → "k2m9q4".
     Baştaki harf öneki (USR, CUST) biçim işaretidir ve aynen kalır; geri
     kalan harf ve rakamlar rastgele seçilir, baştaki sıfırlar ve ayraçlar
     korunur. Şablon verilmezse (tablo örneği) yalnız rakam uzunluğu korunur. */
  function kimlikBicimli(rng, ctx, varsayilanUzunluk){
    var s = ctx && ctx.sablon ? String(ctx.sablon) : "";
    if(!s){
      var len = (ctx && ctx.uzunluk) || varsayilanUzunluk;
      var duz = String(randInt(rng, 1, 9));
      while(duz.length < len){ duz += randInt(rng, 0, 9); }
      return duz;
    }
    var m = /^([A-Za-z]+[_\-.]?)(?=.*\d)/.exec(s);
    var onek = m ? m[1] : "";
    var out = onek, basladi = false;
    for(var i = onek.length; i < s.length; i++){
      var c = s[i];
      if(c >= "0" && c <= "9"){
        if(!basladi && c === "0"){ out += "0"; continue; }
        out += basladi ? randInt(rng, 0, 9) : randInt(rng, 1, 9);
        basladi = true;
      } else if(c >= "a" && c <= "z"){
        out += String.fromCharCode(97 + randInt(rng, 0, 25));
      } else if(c >= "A" && c <= "Z"){
        out += String.fromCharCode(65 + randInt(rng, 0, 25));
      } else {
        out += c;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------
   * TİP KATALOĞU
   *
   * sensitivity : high   -> kişiyi doğrudan tanımlar, asla gerçek gitmez
   *               medium -> kişiyle birlikte tanımlayıcı olabilir
   *               low    -> tek başına tanımlamaz
   *               none   -> kişisel veri değil
   * passthrough : never | ask | auto  (gerçek değer LLM'e gidebilir mi)
   * varsayilanGercek : kişiyi işaret etmeyen ölçüm (adet); gerçek değer
   *               varsayılan olarak kalır, kullanıcı tek tıkla değiştirebilir
   * --------------------------------------------------------------- */
  var TYPES = [

    /* ===== KİMLİK ===== */
    { id:"tckn", label:"TC Kimlik No", group:"Kimlik", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/\btckn?\b/i, /t\.?c\.?\s*kimlik/i, /kimlik\s*no/i, /\bvatandas/i,
              /national[_ ]?id/i, /citizen[_ ]?id/i, /identity[_ ]?(no|number)/i, /\bnin\b/i],
      test:rakamAlani(tcknValid,11,11), checksum:true, fp:0.01,
      bicim:rakamAlani(function(s){ return digitsOf(s)[0] !== "0"; },11,11),
      gen:function(rng){ return tcknGen(rng); } },

    { id:"ykn", label:"Yabancı Kimlik No", group:"Kimlik", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/\bykn\b/i, /yabanci\s*kimlik/i, /foreign\s*id/i],
      test:rakamAlani(yknValid,11,11), checksum:true, fp:0.0001,
      bicim:rakamAlani(function(s){ return digitsOf(s).slice(0,2) === "99"; },11,11),
      gen:function(rng){ return yknGen(rng); } },

    { id:"vkn", label:"Vergi Kimlik No", group:"Kimlik", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/\bvkn\b/i, /vergi\s*(kimlik\s*)?no/i, /vergi\s*numara/i,
              /tax[_ ]?(id|no|number)/i, /vat[_ ]?(id|no|number)/i, /\btin\b/i],
      test:rakamAlani(vknValid,10,10), checksum:true, fp:0.10,
      bicim:rakamAlani(function(){ return true; },10,10),
      gen:function(rng){ return vknGen(rng); } },

    { id:"pasaport", label:"Pasaport No", group:"Kimlik", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/pasaport/i, /passport/i],
      test:function(v){ return /^[A-Z]{1,2}\d{6,8}$/i.test(String(v).replace(/\s/g,"")); },
      gen:function(rng){ return pick(rng,["U","A","P"]) + pad(randInt(rng,100000,99999999), 8); } },

    { id:"nufus_seri", label:"Nüfus Cüzdanı Seri No", group:"Kimlik", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/nufus.*seri/i, /seri\s*sira/i, /cuzdan\s*seri/i],
      test:function(v){ return /^[A-Z]\d{2}\s?\d{6}$/i.test(String(v).trim()); },
      gen:function(rng){ return pick(rng,["A","B","C"]) + pad(randInt(rng,1,20),2) + " " + pad(randInt(rng,100000,999999),6); } },

    { id:"ad_soyad", highCard:true, label:"Ad Soyad", group:"Kimlik", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/ad[ _-]?soyad/i, /adi[ _]?soyadi/i, /\bisim\b/i, /musteri[ _]?ad/i, /personel[ _]?ad/i,
              /full[ _]?name/i, /\bname\b/i, /\bad\b/i, /unvan/i],
      test:function(v){ return /^[A-ZÇĞİÖŞÜ][a-zçğıöşü]+(\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+){1,3}$/.test(String(v).trim()); },
      gen:function(rng){ return pick(rng, rng() < 0.5 ? AD_ERKEK : AD_KADIN) + " " + pick(rng, SOYAD); } },

    { id:"ad", highCard:true, label:"Ad", group:"Kimlik", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/^ad$/i, /first[_ ]?name/i, /given[_ ]?name/i, /^isim$/i, /\bad_/i, /\bfname\b/i],
      test:function(v){ return /^[A-ZÇĞİÖŞÜ][a-zçğıöşü]{2,}$/.test(String(v).trim()); },
      gen:function(rng){ return pick(rng, rng() < 0.5 ? AD_ERKEK : AD_KADIN); } },

    { id:"soyad", highCard:true, label:"Soyad", group:"Kimlik", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/soyad/i, /last[_ ]?name/i, /surname/i, /family[_ ]?name/i, /\blname\b/i],
      test:function(v){ return /^[A-ZÇĞİÖŞÜ][a-zçğıöşü]{2,}$/.test(String(v).trim()); },
      gen:function(rng){ return pick(rng, SOYAD); } },

    { id:"anne_baba_adi", highCard:true, label:"Anne/Baba Adı", group:"Kimlik", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/anne\s*(kizlik\s*)?(ad|soyad)/i, /baba\s*ad/i, /mother.*name/i, /father.*name/i],
      test:function(v){ return /^[A-ZÇĞİÖŞÜ][a-zçğıöşü]{2,}$/.test(String(v).trim()); },
      gen:function(rng){ return pick(rng, AD_KADIN); } },

    { id:"dogum_tarihi", label:"Doğum Tarihi", group:"Kimlik", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/dogum\s*tarih/i, /\bdob\b/i, /birth[_ ]?date/i, /date[_ ]?of[_ ]?birth/i, /birthday/i],
      test:function(v){ return isDateLike(v); },
      gen:function(rng, ctx){ return genDate(rng, ctx, 1955, 2006); } },

    { id:"cinsiyet", label:"Cinsiyet", group:"Kimlik", sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/cinsiyet/i, /\bgender\b/i, /\bsex\b/i],
      test:function(v){ return /^(erkek|kadin|kadın|e|k|m|f|male|female|bay|bayan)$/i.test(String(v).trim()); },
      gen:function(rng){ return pick(rng,["Erkek","Kadın"]); } },

    { id:"medeni_hal", label:"Medeni Hal", group:"Kimlik", sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/medeni/i, /marital/i],
      test:function(v){ return /^(evli|bekar|bekâr|dul|boşanmış|bosanmis|single|married|divorced)$/i.test(String(v).trim()); },
      gen:function(rng){ return pick(rng,["Evli","Bekar","Dul"]); } },

    /* ===== İLETİŞİM ===== */
    { id:"email", label:"E-posta", group:"İletişim", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/e[ _-]?posta/i, /\bemail\b/i, /\bmail\b/i, /eposta/i],
      test:function(v){ return /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(String(v).trim()); },
      gen:function(rng, ctx){ return "kullanici" + pad(ctx.index + 1, 4) + "@ornek.com"; } },

    { id:"kep", label:"KEP Adresi", group:"İletişim", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/\bkep\b/i, /kayitli\s*elektronik/i],
      test:function(v){ return /@hs\d{2}\.kep\.tr$/i.test(String(v).trim()); },
      gen:function(rng, ctx){ return "firma" + pad(ctx.index + 1, 4) + "@hs01.kep.tr"; } },

    { id:"telefon", label:"Telefon (TR)", group:"İletişim", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/telefon/i, /\bgsm\b/i, /\bcep\b/i, /\bphone\b/i, /\btel\b/i, /mobile/i,
              /\bmsisdn\b/i, /contact[_ ]?(no|number)/i, /cell/i],
      test:function(v){
        var s = String(v).trim();
        if(!/^[+(]?\d[\d\s().-]{6,19}$/.test(s)) return false;   // cumle icine gomulu numarayi reddet
        var d = digitsOf(s);
        if(d.length === 10) return /^5\d{9}$/.test(d) || /^[2-4]\d{9}$/.test(d);
        // 0850 / 0800 / 0900 hizmet numaraları da geçerli telefondur
        if(d.length === 11) return /^0(?:[2-5]\d{9}|8[05]0\d{7}|900\d{7})$/.test(d);
        if(d.length === 12) return /^90[2-5]\d{9}$/.test(d);
        return false;
      },
      gen:function(rng){
        var pre = pick(rng,["501","505","506","507","530","531","532","533","534","535","536","537",
          "538","539","541","542","543","544","545","546","551","552","553","554","555","559"]);
        return "0" + pre + " " + pad(randInt(rng,100,999),3) + " " + pad(randInt(rng,10,99),2) + " " + pad(randInt(rng,10,99),2);
      } },

    { id:"telefon_intl", label:"Telefon (uluslararası)", group:"İletişim", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/telefon/i, /phone/i],
      test:function(v){ return /^\+\d{7,15}$/.test(String(v).replace(/[\s.()-]/g,"")); },
      gen:function(rng){ return "+" + randInt(rng,1,99) + pad(randInt(rng,100000000,999999999),9); } },

    { id:"adres", highCard:true, label:"Adres", group:"İletişim", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/adres/i, /address/i, /\baddr\b/i, /street/i, /\bcadde\b/i, /\bsokak\b/i, /\bmahalle/i],
      test:function(v){ return /(mah|mahalle|sok|sokak|cad|cadde|blv|bulvar|apt|no:)/i.test(String(v)) && String(v).length > 12; },
      gen:function(rng){ return pick(rng,["Yeni","Cumhuriyet","Atatürk","Fatih","Barbaros"]) + " Mah. " +
        pick(rng,["Gül","Zambak","Lale","Menekşe","Papatya"]) + " Sok. No:" + randInt(rng,1,120) + " " + pick(rng, ILLER); } },

    { id:"posta_kodu", label:"Posta Kodu", group:"İletişim", sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/posta\s*kod/i, /\bzip\b/i, /postal/i, /\bpk\b/i],
      test:function(v){ var d = digitsOf(v); return d.length === 5 && Number(d.slice(0,2)) >= 1 && Number(d.slice(0,2)) <= 81; },
      gen:function(rng){ return pad(randInt(rng,1,81),2) + pad(randInt(rng,0,999),3); } },

    { id:"url", label:"Web Adresi", group:"İletişim", sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/\burl\b/i, /web\s*site/i, /\blink\b/i, /site/i],
      test:function(v){ return /^(https?:\/\/|www\.)[^\s]+\.[a-z]{2,}/i.test(String(v).trim()); },
      gen:function(rng, ctx){ return "https://ornek-site-" + (ctx.index + 1) + ".com"; } },

    /* ===== LOKASYON ===== */
    { id:"il", label:"İl", group:"Lokasyon", sensitivity:"low", ozel:false, passthrough:"auto",
      header:[/^il$/i, /\bsehir\b/i, /şehir/i, /\bcity\b/i, /\bil_/i, /province/i],
      test:function(v){ return guvenliSozluktemi(v, "il"); },
      gen:function(rng){ return pick(rng, ILLER); } },

    { id:"koordinat", label:"Koordinat", group:"Lokasyon", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/enlem/i, /boylam/i, /latitude/i, /longitude/i, /\blat\b/i, /\blon[g]?\b/i, /koordinat/i],
      test:function(v){ var n = Number(String(v).replace(",", ".")); return isFinite(n) && Math.abs(n) <= 180 && String(v).indexOf(".") !== -1; },
      gen:function(rng){ return (36 + rng()*6).toFixed(6); } },

    /* ===== FİNANS ===== */
    { id:"iban", label:"IBAN", group:"Finans", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/\biban\b/i, /hesap\s*no/i, /banka\s*hesap/i],
      test:ibanValid, checksum:true, fp:0.0103,
      bicim:ibanBicimi,
      gen:function(rng){ return ibanGenTR(rng); } },

    { id:"kart", label:"Kredi Kartı", group:"Finans", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/kart\s*no/i, /kredi\s*kart/i, /credit[_ ]?card/i, /card[_ ]?(no|num|number)/i, /\bpan\b/i],
      test:rakamAlani(luhnValid,12,19), checksum:true, fp:0.10,
      bicim:rakamAlani(function(){ return true; },13,19),
      gen:function(rng){ return cardGen(rng); } },

    { id:"cvv", label:"CVV", group:"Finans", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/\bcvv\b/i, /\bcvc\b/i, /guvenlik\s*kod/i],
      test:function(v){ return /^\d{3,4}$/.test(String(v).trim()); },
      gen:function(rng){ return pad(randInt(rng,100,999),3); } },

    { id:"kart_son_kullanim", label:"Kart Son Kullanım", group:"Finans", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/son\s*kullanim/i, /expir/i, /gecerlilik/i],
      test:function(v){ return /^(0[1-9]|1[0-2])\s*\/\s*\d{2,4}$/.test(String(v).trim()); },
      gen:function(rng){ return pad(randInt(rng,1,12),2) + "/" + randInt(rng,27,32); } },

    { id:"swift", label:"SWIFT/BIC", group:"Finans", sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/\bswift\b/i, /\bbic\b/i],
      test:function(v){ return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(String(v).trim().toUpperCase()); },
      gen:function(rng){ return "ORNTRIS" + pick(rng,["A","B","C"]); } },

    { id:"kripto", label:"Kripto Cüzdan", group:"Finans", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/wallet/i, /cuzdan/i, /bitcoin/i, /\beth\b/i, /\bbtc\b/i],
      test:function(v){ var s = String(v).trim(); return /^(0x[a-fA-F0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{25,62})$/.test(s); },
      gen:function(rng){ var h = "0x"; for(var i=0;i<40;i++){ h += "0123456789abcdef"[randInt(rng,0,15)]; } return h; } },

    { id:"tutar", label:"Tutar / Para", group:"Finans", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/tutar/i, /fiyat/i, /ucret/i, /ücret/i, /bedel/i, /\bciro\b/i, /gelir/i, /gider/i, /bakiye/i,
              /\bamount\b/i, /\bamt\b/i, /\bprice\b/i, /\btotal\b/i, /subtotal/i, /revenue/i, /\bcost\b/i,
              /\bfee\b/i, /discount/i, /\bgross\b/i, /\bnet\b/i, /balance/i, /commission/i, /komisyon/i],
      test:function(v){
        var s = String(v).trim();
        if(!/^[₺$€£]?\s?-?[\d.,]+\s?(₺|TL|USD|EUR|GBP|\$|€|£)?$/i.test(s)) return false;
        var paraIsareti = /[₺$€£]|TL|USD|EUR|GBP/i.test(s);
        var ondalik = /[.,]\d{1,2}$/.test(s);
        return paraIsareti || ondalik;   // "482193" bir musteri no olabilir, tutar degil
      },
      numeric:true,
      gen:null /* sayısal üretici profilden gelir */ },

    { id:"maas", label:"Maaş / Bordro", group:"Özlük", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/maas/i, /maaş/i, /bordro/i, /salary/i, /\bwage\b/i, /payroll/i, /compensation/i,
              /prim/i, /ikramiye/i, /bonus/i, /ücret/i, /ucret/i, /hakedis/i, /hakediş/i],
      // Her sayı maaş değildir: örüntü tek başına ("45000", 11 haneli kimlik)
      // tutar, adet ve kimlik kolonlarını "Maaş" yapıyordu. Başlık şart.
      headerGerekli:true,
      test:function(v){ return /^[₺$€]?\s?[\d.,]+$/.test(String(v).trim()); },
      numeric:true, gen:null },

    /* ===== KURUMSAL ===== */
    { id:"mersis", label:"MERSİS No", group:"Kurumsal", sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/mersis/i],
      // 16 hanelidir ama baştaki sıfır belgelerde sık düşer; 15'i de kabul et
      test:function(v){ var d = digitsOf(v); return d.length === 15 || d.length === 16; },
      gen:function(rng){ return "0" + vknGen(rng) + pad(randInt(rng,10000,99999),5); } },

    { id:"firma", highCard:true, label:"Firma / Şirket Adı", group:"Kurumsal", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/firma/i, /sirket/i, /şirket/i, /company/i, /\bcorp\b/i, /supplier/i,
              /tedarikci/i, /cari\s*(unvan|ad)/i, /organization/i, /kurum/i],
      test:function(v){ return /(A\.?Ş\.?|Ltd\.?|Şti\.?|San\.|Tic\.|Holding|A\.S\.|Inc\.|GmbH)/i.test(String(v)); },
      gen:function(rng, ctx){ return pick(rng,["Alfa","Beta","Delta","Omega","Nova","Aksa","Ege","Marmara"]) +
        " " + pick(rng,["Teknoloji","Lojistik","Gıda","Tekstil","Enerji","İnşaat"]) + " " + pick(rng,["A.Ş.","Ltd. Şti."]); } },

    /* ===== ARAÇ ===== */
    { id:"plaka", label:"Araç Plakası", group:"Müşteri İşlem", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/plaka/i, /plate/i, /arac\s*no/i],
      test:function(v){
        var s = String(v).replace(/\s/g,"").toUpperCase();
        return /^(0[1-9]|[1-7]\d|8[01])([A-Z]\d{4,5}|[A-Z]{2}\d{3,4}|[A-Z]{3}\d{2,3})$/.test(s);
      },
      gen:function(rng){
        var harf = "ABCDEFGHJKLMNPRSTUVYZ";
        return pad(randInt(rng,1,81),2) + " " + harf[randInt(rng,0,20)] + harf[randInt(rng,0,20)] + harf[randInt(rng,0,20)] +
          " " + pad(randInt(rng,10,999),2);
      } },

    { id:"sasi", label:"Şasi No (VIN)", group:"Müşteri İşlem", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/sasi/i, /şasi/i, /\bvin\b/i, /chassis/i],
      test:function(v){ return /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(v).trim()); },
      gen:function(rng){ var c = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789", s = ""; for(var i=0;i<17;i++){ s += c[randInt(rng,0,c.length-1)]; } return s; } },

    /* ===== SAĞLIK (KVKK m.6 özel nitelikli) ===== */
    { id:"kan_grubu", label:"Kan Grubu", group:"Sağlık", sensitivity:"high", ozel:true, passthrough:"never",
      header:[/kan\s*grub/i, /blood/i],
      test:function(v){ return /^(0|A|B|AB)\s*(rh)?\s*[+-]?$/i.test(String(v).trim().replace(/\s+/g," ")); },
      gen:function(rng){ return pick(rng,["A Rh+","A Rh-","B Rh+","0 Rh+","0 Rh-","AB Rh+"]); } },

    { id:"saglik", label:"Sağlık Bilgisi", group:"Sağlık", sensitivity:"high", ozel:true, passthrough:"never",
      header:[/tani\s/i, /teşhis/i, /teshis/i, /hastalik/i, /hastalık/i, /diagnos/i, /\bicd\b/i, /ilac/i, /ilaç/i,
              /recete/i, /reçete/i, /engel\s*oran/i, /rapor\s*tur/i, /kronik/i, /alerji/i, /\bhiv\b/i,
              /medical/i, /disease/i, /treatment/i, /prescription/i, /disability/i, /\bhealth\b/i],
      test:function(){ return false; }, headerOnly:true,
      gen:function(rng, ctx){ return "SAGLIK_KODU_" + pad(randInt(rng,1,40),3); } },

    { id:"hasta_no", headerGerekli:true, label:"Hasta / Protokol No", group:"Sağlık", sensitivity:"high", ozel:true, passthrough:"never",
      header:[/hasta\s*no/i, /protokol\s*no/i, /dosya\s*no/i, /patient/i],
      test:function(v){ return /^\d{4,12}$/.test(digitsOf(v)); },
      gen:function(rng, ctx){ return seriNo(rng, ctx, 700000); } },

    /* ===== DİĞER ÖZEL NİTELİKLİ (KVKK m.6) ===== */
    { id:"ozel_nitelikli", label:"Özel Nitelikli Veri", group:"Özel Nitelikli", sensitivity:"high", ozel:true, passthrough:"never",
      header:[/\bdin\b/i, /mezhep/i, /inanc/i, /inanç/i, /\birk\b/i, /etnik/i, /siyasi/i, /\bparti\b/i,
              /sendika/i, /dernek\s*uye/i, /vakif\s*uye/i, /cinsel\s*(hayat|yonelim)/i, /\bsabika\b/i,
              /ceza\s*mahkum/i, /adli\s*sicil/i, /biyometri/i, /parmak\s*izi/i, /kilik/i, /kıyafet/i,
              /religion/i, /ethnic/i, /political/i, /union[_ ]?member/i, /criminal/i, /biometric/i,
              /sexual[_ ]?orientation/i, /fingerprint/i],
      test:function(){ return false; }, headerOnly:true,
      gen:function(rng){ return "KATEGORI_" + pick(rng,["A","B","C","D"]); } },

    /* ===== ÖZLÜK / İK ===== */
    /* Kullanıcı / müşteri kimliği: kişiye bağlı takma kimliktir (KVKK'da
       kişisel veri). Dosya maskelemede aynı gerçek kimlik her satırda aynı
       sahte kimliğe döner; kişi başına kayıt sayısı (COUNT) bozulmaz. */
    { id:"kullanici_id", headerGerekli:true, label:"Kullanıcı / Müşteri ID", group:"Müşteri İşlem", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/user[ _]?id/i, /\buid\b/i, /kullan[iı]c[iı][ _]?(id|no|kod)/i, /m[uü][sş]teri[ _]?(id|kod)/i,
              /customer[ _]?(id|no)/i, /\bcust[ _]?id\b/i, /client[ _]?id/i, /member[ _]?id/i, /[uü]ye[ _]?id/i,
              /account[ _]?id/i, /hesap[ _]?(id|no)/i, /subscriber[ _]?id/i, /abone[ _]?id/i],
      test:function(v){ var s = String(v).trim(); return /^[A-Za-z]{0,8}[_\-.]?[A-Za-z0-9]{2,32}$/.test(s) && /\d/.test(s); },
      gen:function(rng, ctx){ return kimlikBicimli(rng, ctx, 6); } },

    { id:"id_no", genelAmacli:true, headerGerekli:true, label:"Kayıt / Referans No", group:"Müşteri İşlem", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/(^|[ _])(no|id|kod|numara|num)([ _]|$)/i, /musteri[ _]?no/i, /siparis/i, /fatura/i, /referans/i,
              /belge[ _]?no/i, /islem[ _]?no/i, /kayit[ _]?no/i, /abone[ _]?no/i, /uye[ _]?no/i],
      test:function(v){ return /^[A-Z]{0,4}[\d-]{3,20}$/i.test(String(v).trim()) && /\d{3,}/.test(String(v)); },
      gen:function(rng, ctx){
        var len = (ctx && ctx.uzunluk) || 6;
        var s = String(randInt(rng, 1, 9));
        while(s.length < len){ s += randInt(rng,0,9); }
        return s;
      } },

    { id:"sicil_no", headerGerekli:true, label:"Sicil / Personel No", group:"Özlük", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/sicil/i, /personel/i, /personnel/i, /employee[_ ]?(id|no)/i, /staff[_ ]?(id|no)/i, /\bsgk\b/i],
      test:function(v){ return /^\d{4,12}$/.test(digitsOf(v)); },
      gen:function(rng, ctx){ return seriNo(rng, ctx, 10000); } },

    { id:"unvan_pozisyon", label:"Ünvan / Pozisyon", group:"Özlük", sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/pozisyon/i, /position/i, /gorev/i, /görev/i, /\btitle\b/i, /job[_ ]?title/i,
              /departman/i, /department/i, /\bdept\b/i, /birim/i, /\brole\b/i, /unvan/i],
      test:function(){ return false; }, headerOnly:true,
      gen:function(rng){ return pick(rng,["Uzman","Kıdemli Uzman","Yönetici","Müdür","Analist","Danışman","Asistan"]); } },

    /* ===== İŞLEM GÜVENLİĞİ / TEKNİK ===== */
    { id:"ip", label:"IP Adresi", group:"İşlem Güvenliği", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/\bip\b/i, /ip\s*adres/i],
      test:function(v){
        var s = String(v).trim();
        if(/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return s.split(".").every(function(p){ return Number(p) <= 255; });
        return /^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i.test(s);
      },
      gen:function(rng){ return "10." + randInt(rng,0,255) + "." + randInt(rng,0,255) + "." + randInt(rng,1,254); } },

    { id:"mac", label:"MAC Adresi", group:"İşlem Güvenliği", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/\bmac\b/i, /donanim\s*adres/i],
      test:function(v){ return /^([0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/i.test(String(v).trim()); },
      gen:function(rng){ var p = []; for(var i=0;i<6;i++){ p.push(pad(randInt(rng,0,255).toString(16).toUpperCase(),2)); } return p.join(":"); } },

    { id:"imei", label:"IMEI", group:"İşlem Güvenliği", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/\bimei\b/i, /cihaz\s*no/i],
      test:rakamAlani(imeiValid,15,15), checksum:true, fp:0.10,
      bicim:rakamAlani(function(){ return true; },15,15),
      gen:function(rng){ return imeiGen(rng); } },

    { id:"uuid", label:"UUID / GUID", group:"İşlem Güvenliği", sensitivity:"low", ozel:false, passthrough:"never",
      header:[/\buuid\b/i, /\bguid\b/i, /\bidentifier\b/i],
      test:function(v){ return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v).trim()); },
      gen:function(rng){
        var c = "0123456789abcdef", s = "";
        [8,4,4,4,12].forEach(function(n, i){ if(i) s += "-"; for(var k=0;k<n;k++){ s += c[randInt(rng,0,15)]; } });
        return s;
      } },

    { id:"gizli_anahtar", label:"Parola / API Anahtarı", group:"İşlem Güvenliği", sensitivity:"high", ozel:false, passthrough:"never",
      header:[/parola/i, /sifre/i, /şifre/i, /password/i, /\bpwd\b/i, /api[ _-]?key/i, /secret/i, /token/i, /\bhash\b/i],
      // IBAN biçimindeki değer (kontrol hanesi tutmasa da) parola değildir
      test:function(v){ var s = String(v).trim(); return s.length >= 16 && /[A-Za-z]/.test(s) && /\d/.test(s) && !/\s/.test(s) && !ibanBicimi(s); },
      gen:function(rng){ var c = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789", s = ""; for(var i=0;i<24;i++){ s += c[randInt(rng,0,c.length-1)]; } return s; } },

    { id:"kullanici_adi", label:"Kullanıcı Adı", group:"İşlem Güvenliği", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/kullanici\s*ad/i, /username/i, /\buser[_ ]?name\b/i, /\blogin\b/i, /hesap\s*ad/i, /\bhandle\b/i],
      headerGerekli:true,
      test:function(v){
        var s = String(v).trim();
        if(!/^[a-z0-9._-]{3,24}$/i.test(s)) return false;
        return /[0-9._-]/.test(s) && !/^[A-ZÇĞİÖŞÜ][a-zçğıöşü]+$/.test(s); // "Negatif" bir kullanici adi degil
      },
      gen:function(rng, ctx){ return "kullanici" + pad(ctx.index + 1, 4); } },

    /* ===== YAPISAL (kişisel veri değil ama üretim için gerekli) ===== */
    { id:"tarih", label:"Tarih", group:"Yapısal", sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/tarih/i, /\bdate\b/i, /\bgun\b/i, /zaman/i, /olusturma/i, /güncelleme/i, /guncelleme/i,
              /created[_ ]?at/i, /updated[_ ]?at/i, /deleted[_ ]?at/i, /modified/i,
              /timestamp/i, /datetime/i, /\bts\b/i, /[_ ]at$/i],
      test:function(v){ return isDateLike(v); },
      gen:null /* tarih üreticisi profilden gelir */ },

    { id:"bayrak", label:"Evet/Hayır (bayrak)", group:"Yapısal", sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/^is[_ ]/i, /^has[_ ]/i, /bayrak/i, /\bflag\b/i, /aktif\s*mi/i, /\benabled\b/i, /\bactive\b/i,
              /onay(li|lı|\s*durum)/i, /\bvalid\b/i],
      test:function(v){
        return /^(true|false|1|0|evet|hayir|hayır|\+|-|e|h|y|n|yes|no|var|yok|aktif|pasif|active|passive|acik|kapali)$/i
          .test(String(v).trim());
      },
      gen:function(rng){ return pick(rng, ["true","false"]); } },

    { id:"saat", label:"Saat (günün saati)", group:"Yapısal", sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/saat/i, /\btime\b/i, /\bhour\b/i, /baslangic/i, /bitis/i],
      test:function(v){ return /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(v).trim()); },
      gen:null /* saat üreteci profilden gelir */ },

    { id:"kategori", label:"Kategori", group:"Yapısal", sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/kategori/i, /\bcategory\b/i, /\btur\b/i, /tür/i, /\btip\b/i, /\btype\b/i, /\bkind\b/i,
              /durum/i, /status/i, /\bstate\b/i, /segment/i, /grup/i, /\bgroup\b/i, /\blevel\b/i, /\bclass\b/i],
      test:function(){ return false; }, headerOnly:true,
      gen:null },

    /* Adet / kayıt sayısı: kişiyi işaret etmez. Kullanıcı kimliği maskelenirken
       sayımlar aynen kalsın (toplamlar, kişi başına kayıt sayısı tutsun) diye
       gerçek değer varsayılandır. Türkçe ünsüz yumuşaması: adet → "adedi". */
    { id:"adet", headerGerekli:true, label:"Adet / Kayıt Sayısı", group:"Yapısal", sensitivity:"none", ozel:false, passthrough:"auto",
      varsayilanGercek:true, gercekSebebi:"adet / kayıt sayısı — kişiyi işaret etmez; değerler aynen kalır, toplamlar tutar",
      header:[/adet/i, /aded/i, /\bcount\b/i, /\bcnt\b/i, /\bqty\b/i, /quantity/i, /record[ _]?count/i, /row[ _]?count/i,
              /kay[iı]t[ _]?say/i, /i[sş]lem[ _]?say/i, /sipari[sş][ _]?say/i, /ziyaret[ _]?say/i, /tekrar[ _]?say/i],
      test:function(v){ return /^(\d+|\d{1,3}(\.\d{3})+)$/.test(String(v).trim()); },
      numeric:true, gen:null },

    { id:"sayi", label:"Sayı", group:"Yapısal", sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/miktar/i, /sayi/i, /sayı/i,
              /num[_ ]?of/i, /puan/i, /skor/i, /\bscore\b/i, /oran/i, /\brate\b/i, /\bratio\b/i,
              /yuzde/i, /percent/i, /\bpct\b/i, /kapasite/i, /capacity/i, /kontenjan/i, /\bstok\b/i,
              /\bstock\b/i, /toplam/i, /\bage\b/i, /\byas\b/i, /duration/i, /\bsure\b/i],
      test:function(v){ return isNumericLike(v); },
      numeric:true, gen:null },

    { id:"metin", label:"Serbest Metin", group:"Yapısal", sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/aciklama/i, /açıklama/i, /\bnot\b/i, /\bnote/i, /yorum/i, /comment/i, /description/i,
              /\bdesc\b/i, /detay/i, /detail/i, /mesaj/i, /message/i, /geri\s*bildirim/i, /feedback/i,
              /\bremark/i, /review/i, /\btext\b/i],
      test:function(){ return false; }, headerOnly:true,
      gen:function(rng, ctx){ return "Örnek açıklama metni " + (ctx.index + 1) + "."; } }
  ];

  /* ---------------------------------------------------------------
   * Yapısal yardımcılar
   * --------------------------------------------------------------- */
  var DATE_PATTERNS = [
    { re:/^(\d{4})-(\d{1,2})-(\d{1,2})$/, order:"ymd", fmt:"YYYY-MM-DD" },
    { re:/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/, order:"dmy", fmt:"DD.MM.YYYY" },
    { re:/^(\d{1,2})[./](\d{1,2})[./](\d{2})$/, order:"dmy", fmt:"DD.MM.YY" },
    { re:/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, order:"ymd", fmt:"YYYY/MM/DD" }
  ];

  function isDateLike(v){
    if(v instanceof Date) return true;
    var s = String(v).trim().split(/[ T]/)[0];
    for(var i=0;i<DATE_PATTERNS.length;i++){
      if(DATE_PATTERNS[i].re.test(s)) return true;
    }
    return false;
  }

  function isNumericLike(v){
    var s = String(v).trim();
    if(!s || !/\d/.test(s)) return false;
    return /^-?[\d.,]+%?$/.test(s);
  }

  /* Sayı biçimi. Türkçe Excel binlik ayırıcı olarak nokta, ondalık olarak
     virgül yazar: "12.500" on iki bin beş yüzdür. Tek başına bakınca bu değer
     İngilizce 12.5'ten ayırt edilemez; biçim bu yüzden KOLON düzeyinde
     çıkarılır (table-engine.js) ve parseNumber'a ikinci argüman olarak verilir.
     Biçim verilmezse eski tek değer kuralı geçerlidir (geriye uyumluluk). */
  // Binlik grubunun ilk parçası sıfırla başlamaz: "0.125" daima ondalıktır.
  var TR_SAYI = /^([1-9]\d{0,2}(\.\d{3})+|\d+)(,\d+)?$/;
  var EN_SAYI = /^([1-9]\d{0,2}(,\d{3})+|\d+)(\.\d+)?$/;

  function sayiTemizle(v){
    return String(v).trim().replace(/[₺$€£\s%]/g,"").replace(/(TL|USD|EUR|GBP)$/i,"");
  }

  // Temizlenmiş metni Number()'ın anlayacağı biçime çevirir.
  function sayiMetni(s, bicim){
    var isaret = "", g = s;
    if(g.charAt(0) === "-" || g.charAt(0) === "+"){ isaret = g.charAt(0) === "-" ? "-" : ""; g = g.slice(1); }
    if(bicim === "tr" && TR_SAYI.test(g)) return isaret + g.replace(/\./g,"").replace(",", ".");
    if(bicim === "en" && EN_SAYI.test(g)) return isaret + g.replace(/,/g,"");
    // Aynı ayraç birden çok kez geçiyorsa binlik gruplamadır; eskiden
    // "1.234.567" ve "1,234,567" NaN dönüyordu. Grup kuralı (3 hane) şart:
    // "24.06.1985" bir tarihtir, sayı değil.
    if(/^[1-9]\d{0,2}(\.\d{3}){2,}$/.test(g)) return isaret + g.replace(/\./g,"");
    if(/^[1-9]\d{0,2}(,\d{3}){2,}$/.test(g)) return isaret + g.replace(/,/g,"");
    // "1.234,56" (TR) ve "1,234.56" (EN) ayrımı: son ayraç ondalıktır
    var lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
    if(lastComma > lastDot){ return s.replace(/\./g,"").replace(",", "."); }
    return s.replace(/,/g,"");
  }

  // bicim: "tr" | "en" | undefined (tek değer kuralı)
  function parseNumber(v, bicim){
    if(typeof v === "number") return v;
    var s = sayiTemizle(v);
    if(!s) return NaN;
    var n = Number(sayiMetni(s, bicim));
    return isFinite(n) ? n : NaN;
  }

  /* Tek bir değerin biçim kanıtı: "tr" / "en" kesin; "tr?" / "en?" belirsiz
     ("12.500" TR binlik ya da EN ondalık, "12,500" tersi); null = ayraç yok
     veya sayı değil. Kolon kararı bu kanıtların sayımıyla verilir. */
  function sayiBicimiKaniti(v){
    return kanitGovde(sayiTemizle(v).replace(/^[+-]/, ""));
  }

  // s: işaretsiz, temizlenmiş gövde. Ayraç sayıları biliniyorsa verilir.
  function kanitGovde(s, nokta, virgul){
    if(!/^\d[\d.,]*$/.test(s)) return null;
    if(nokta === undefined){
      nokta = 0; virgul = 0;
      for(var i=0;i<s.length;i++){
        var c = s.charCodeAt(i);
        if(c === 46) nokta++; else if(c === 44) virgul++;
      }
    }
    if(!nokta && !virgul) return null;
    if(nokta && virgul){
      if(s.lastIndexOf(",") > s.lastIndexOf(".")) return TR_SAYI.test(s) ? "tr" : null;
      return EN_SAYI.test(s) ? "en" : null;
    }
    if(nokta > 1) return TR_SAYI.test(s) ? "tr" : null;
    if(virgul > 1) return EN_SAYI.test(s) ? "en" : null;
    // Baştaki sıfır binlik grubu olamaz: "0.125" kesin ondalıktır.
    if(nokta) return /^[1-9]\d{0,2}\.\d{3}$/.test(s) ? "tr?" : "en";
    return /^[1-9]\d{0,2},\d{3}$/.test(s) ? "en?" : "tr";
  }

  /* Profil taraması için hızlı yol: tablo motoru artık her okunan hücreyi
     çözümlüyor ve genel temizlik regex'leri 20.000 satırda saniyeler tutuyordu.
     YALNIZCA isNumericLike'tan geçmiş, kırpılmış hücre ("-?[\d.,]+%?")
     verilmelidir; sonuç parseNumber(v, "tr") / parseNumber(v, "en") ve
     sayiBicimiKaniti(v) ile aynıdır. out nesnesi tekrar kullanılır. */
  function sayiHucresiCoz(v, out){
    var s = String(v);
    var bas = s.charCodeAt(0) === 45 ? 1 : 0;                        // "-"
    var son = s.charCodeAt(s.length - 1) === 37 ? s.length - 1 : s.length;   // "%"
    var g = (bas || son !== s.length) ? s.slice(bas, son) : s;
    var isaret = bas ? -1 : 1;
    var nokta = 0, virgul = 0, konum = -1;
    for(var i=0;i<g.length;i++){
      var c = g.charCodeAt(i);
      if(c === 46){ nokta++; konum = i; }
      else if(c === 44){ virgul++; konum = i; }
    }
    if(!nokta && !virgul){
      out.kanit = null;
      out.tr = out.en = isaret * Number(g);
      return out;
    }
    // En sık biçim: iki yanı rakam olan tek ayraç ("12,5", "12.500")
    if(nokta + virgul === 1 && konum > 0 && konum < g.length - 1){
      var tam = g.slice(0, konum), kesir = g.slice(konum + 1);
      var ucHane = kesir.length === 3 && tam.length <= 3 && tam.charCodeAt(0) !== 48;
      var ondalik = isaret * Number(tam + "." + kesir), binlik = isaret * Number(tam + kesir);
      if(nokta){
        out.kanit = ucHane ? "tr?" : "en";
        out.tr = ucHane ? binlik : ondalik;
        out.en = ondalik;
      } else {
        out.kanit = ucHane ? "en?" : "tr";
        out.tr = ondalik;
        out.en = ucHane ? binlik : ondalik;
      }
      return out;
    }
    out.kanit = kanitGovde(g, nokta, virgul);
    var tr = Number(sayiMetni(g, "tr"));
    out.tr = isFinite(tr) ? isaret * tr : NaN;
    if(out.kanit === "tr?" || out.kanit === "en?"){
      var en = Number(sayiMetni(g, "en"));
      out.en = isFinite(en) ? isaret * en : NaN;
    } else {
      // Kesin kanıtlı ya da ayraçsız hücrede iki yorum aynı sayıyı verir
      out.en = out.tr;
    }
    return out;
  }

  /* Kolondaki kanıt sayımından biçim kararı. Kesin kanıt belirsizden önce
     gelir; eşitlikte Türkçe biçim seçilir (araç Türkçe Excel çıktısı için). */
  function sayiBicimiSec(k){
    if(!k) return null;
    var tr = k.tr || 0, en = k.en || 0, trB = k["tr?"] || 0, enB = k["en?"] || 0;
    if(tr !== en) return tr > en ? "tr" : "en";
    if(trB !== enB) return trB > enB ? "tr" : "en";
    return (tr || trB) ? "tr" : null;
  }

  // Ondalık hane sayısı, parseNumber ile aynı kurala göre ("12.500" TR'de 0 hane).
  function ondalikBasamak(v, bicim){
    var s = sayiTemizle(v).replace(/^[+-]/, "");
    var ayrac = null;
    if(bicim === "tr" && TR_SAYI.test(s)) ayrac = ",";
    else if(bicim === "en" && EN_SAYI.test(s)) ayrac = ".";
    else {
      if(/^[1-9]\d{0,2}([.,])\d{3}(\1\d{3})+$/.test(s)) return 0;
      var son = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
      return son < 0 ? 0 : s.length - son - 1;
    }
    var i = s.indexOf(ayrac);
    return i < 0 ? 0 : s.length - i - 1;
  }

  function genDate(rng, ctx, yMin, yMax){
    var y = randInt(rng, yMin, yMax);
    var m = randInt(rng, 1, 12);
    var d = randInt(rng, 1, 28);
    var fmt = (ctx && ctx.dateFormat) || "YYYY-MM-DD";
    if(fmt === "DD.MM.YYYY") return pad(d,2) + "." + pad(m,2) + "." + y;
    if(fmt === "DD.MM.YY") return pad(d,2) + "." + pad(m,2) + "." + String(y).slice(2);
    if(fmt === "YYYY/MM/DD") return y + "/" + pad(m,2) + "/" + pad(d,2);
    return y + "-" + pad(m,2) + "-" + pad(d,2);
  }

  /* Alan paketi kaydı — sektöre özgü tipler (ör. biletleme) çekirdek
     kataloğu şişirmeden eklenebilsin diye. Başa eklenir ki eşit güven
     skorunda genel tiplere karşı kazansınlar. */
  function registerTypes(list){
    Array.prototype.unshift.apply(TYPES, list);
  }
  function registerVocab(vocab){
    GUVENLI_SOZLUKLER.push(vocab);
    _sozlukOnbellek = null;   // alan paketi eklendi, kümeleri yeniden kur
  }

  function typeById(id){
    for(var i=0;i<TYPES.length;i++){ if(TYPES[i].id === id) return TYPES[i]; }
    return null;
  }

  /* "eventId" / "isSeasonTicket" gibi camelCase başlıklarda kelime sınırı yoktur;
     ayırmazsak /\bid\b/ gibi kalıplar hiç eşleşmez. */
  function camelAyir(s){
    return String(s)
      .replace(/([a-zçğıöşü0-9])([A-ZÇĞİÖŞÜ])/g, "$1 $2")
      .replace(/([A-ZÇĞİÖŞÜ]+)([A-ZÇĞİÖŞÜ][a-zçğıöşü])/g, "$1 $2");
  }

  window.TypeCatalog = {
    TYPES: TYPES,
    typeById: typeById,
    registerTypes: registerTypes,
    registerVocab: registerVocab,
    seriNo: seriNo,
    luhnCheckDigit: luhnCheckDigit,
    DATE_PATTERNS: DATE_PATTERNS,
    ILLER: ILLER,
    GUVENLI_SOZLUKLER: GUVENLI_SOZLUKLER,
    guvenliSozlukEslesmesi: guvenliSozlukEslesmesi,
    guvenliSozluktemi: guvenliSozluktemi,
    asciiKatla: asciiKatla,
    camelAyir: camelAyir,
    // yardımcılar
    makeRng: makeRng,
    hashSeed: hashSeed,
    pick: pick,
    randInt: randInt,
    pad: pad,
    isDateLike: isDateLike,
    isNumericLike: isNumericLike,
    parseNumber: parseNumber,
    sayiBicimiKaniti: sayiBicimiKaniti,
    sayiHucresiCoz: sayiHucresiCoz,
    sayiBicimiSec: sayiBicimiSec,
    ondalikBasamak: ondalikBasamak,
    genDate: genDate,
    normalizeTr: normalizeTr,
    // doğrulayıcılar (test edilebilir olsun diye dışa açık)
    validators: {
      tckn: tcknValid, ykn: yknValid, vkn: vknValid,
      iban: ibanValid, luhn: luhnValid, imei: imeiValid
    },
    ibanLength: function(countryCode){ return IBAN_LENGTHS[String(countryCode || "").toUpperCase()] || 0; },
    generators: {
      tckn: tcknGen, ykn: yknGen, vkn: vknGen,
      iban: ibanGenTR, card: cardGen, imei: imeiGen
    }
  };
})();
