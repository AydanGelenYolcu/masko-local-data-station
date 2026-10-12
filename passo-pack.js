/* Maskeleme İstasyonu — Biletleme (Passo) Alan Paketi
 *
 * Passo verisinin iki ayırt edici özelliği var ve ikisi de bu paketi
 * gerektiriyor:
 *
 *   1. 6222 sayılı Kanun gereği her bilet bir TCKN'ye (veya pasaporta)
 *      tanımlanmak zorunda. Yani bilet tablosu, yapısı gereği kimliğe bağlı.
 *   2. Analiz soruları neredeyse tamamen mekân hiyerarşisi (stadyum > blok >
 *      sıra > koltuk) ve zaman eğrisi (satışa açılış → maç günü) üzerine.
 *
 * Bu yüzden burada iki şey tanımlanır: alan tipleri ve — grafiklerin anlamlı
 * kalması için — kişiyi işaret etmeyen "güvenli sözlükler". Kulüp, stadyum,
 * lig ve kanal adları kişisel veri değildir; bunları sahteye çevirmek analizi
 * bozar, korumaya bir şey katmaz.
 */
(function(){
  "use strict";

  var TC = window.TypeCatalog;
  if(!TC || !TC.registerTypes) return;

  var pick = TC.pick, randInt = TC.randInt, pad = TC.pad, seriNo = TC.seriNo;

  /* ------------------------------------------------------------------
   * Güvenli sözlükler — gerçek değerleri LLM'e gidebilir
   * ------------------------------------------------------------------ */
  var KULUPLER = [
    "Galatasaray","Fenerbahçe","Beşiktaş","Trabzonspor","Başakşehir","İstanbul Başakşehir",
    "Adana Demirspor","Alanyaspor","Corendon Alanyaspor","Antalyaspor","Çaykur Rizespor",
    "Gaziantep FK","Göztepe","Hatayspor","Kasımpaşa","Kayserispor","Konyaspor",
    "Tümosan Konyaspor","Samsunspor","Sivasspor","Eyüpspor","Bodrum FK","Pendikspor",
    "Fatih Karagümrük","İstanbulspor","Ankaragücü","MKE Ankaragücü","Giresunspor",
    "Ümraniyespor","Altay","Bandırmaspor","Bandırma Spor","Boluspor","Erzurumspor",
    "Erzurumspor FK","Gençlerbirliği","Kocaelispor","Manisa FK","Sakaryaspor",
    "Şanlıurfaspor","Tuzlaspor","Van Spor","Adanaspor","Altınordu",
    // 26/27 sezonunda Passo'da kombine satışı olan diğer kulüpler
    "Amedspor","Amed Sportif Faaliyetler","Arca Çorum FK","Çorum FK","SMS Grup Sarıyer",
    "Sarıyer","Elazığspor","52 Orduspor","Orduspor","Eskişehirspor","Muğlaspor",
    "Batman Petrol Spor","Mardin 1969 Spor","Gebzespor","Iğdır FK","Serik Belediyespor"
  ];

  var STADYUMLAR = [
    // Stadyumlar
    "Rams Park","Ülker Stadyumu","Şükrü Saracoğlu Stadyumu","Tüpraş Stadyumu","Papara Park",
    "Şenol Güneş Spor Kompleksi","Başakşehir Fatih Terim Stadyumu","Atatürk Olimpiyat Stadyumu",
    "Ali Sami Yen Spor Kompleksi","Konya Büyükşehir Stadyumu","Torku Arena","Yeni Adana Stadyumu",
    "Antalya Stadyumu","Kalyon Stadyumu","Gürsel Aksel Stadyumu","Samsun Yeni 19 Mayıs Stadyumu",
    "Sivas 4 Eylül Stadyumu","Kayseri Stadyumu","Alanya Oba Stadyumu","Çaykur Didi Stadyumu",
    "Yeni Hatay Stadyumu","Recep Tayyip Erdoğan Stadyumu","Eskişehir Yeni Stadyumu",
    "Bursa Büyükşehir Stadyumu","Bursa Timsah Arena","Kocaeli Stadyumu","Manisa 45 Evler Stadyumu",
    "Mümin Özkasap Stadyumu","Şanlıurfa GAP Arena","Bodrum İlçe Stadyumu","Bodrumspor Tesisleri",
    "Ankara Eryaman Stadyumu","Bandırma 17 Eylül Stadyumu","Bolu Atatürk Stadyumu",
    "Çorum Stadyumu","Diyarbakır Stadyumu","İskender Stadyumu",
    // Salonlar ve sahne mekânları
    "Volkswagen Arena","Zorlu PSM","Turkcell Sahnesi","Turkcell Platinum Sahnesi",
    "Küçükçiftlik Park","Ataköy Marina Arena","Harbiye Cemil Topuzlu Açıkhava Tiyatrosu",
    "Salon İKSV","IF Performance Hall","Akasya Kültür Sanat","Beykoz Kundura Sahne",
    "İş Sanat Kültür Merkezi","Ora Arena","Sinan Erdem Spor Salonu","Akatlar Spor Kompleksi",
    "Büyükçekmece Kemal Sunal Amfi Tiyatro","Bornova Aşık Veysel Açık Hava Tiyatrosu",
    "Four Seasons Hotel Bosphorus","Pera Palace Hotel",
    // Müze ve tarihi mekânlar
    "Ayasofya Tarih ve Deneyim Müzesi","Panorama 1453 Tarih Müzesi","Şerefiye Sarnıcı",
    "Binbirdirek Sarnıcı","Miniatürk","Emaar Akvaryum","İstanbul Dolphinarium",
    "Demokrasi ve Özgürlükler Adası Müzesi","Legends of Istanbul"
  ];

  var LIGLER = [
    "Süper Lig","Trendyol Süper Lig","TFF 1. Lig","Trendyol 1. Lig","TFF 2. Lig",
    "Ziraat Türkiye Kupası","UEFA Şampiyonlar Ligi","UEFA Avrupa Ligi","UEFA Konferans Ligi",
    "Hazırlık Maçı","Süper Kupa","Basketbol Süper Ligi","Türkiye Kupası"
  ];

  /* PASSO'nun üst menüsündeki 6 ana kategori ve alt kırılımları.
     Etkinlik tablolarında "kategori" kolonu çoğunlukla bu değerleri taşır. */
  var ETKINLIK_KATEGORILERI = [
    "Futbol","Müzik","Sahne","Spor","Müze","Diğer",
    "Kombine","Pop - Rock","Pop","Rock","Festival","Heavy Metal","DJ - Party","Caz","Müzikal",
    "Klasik Müzik","Diğer Müzik","Tiyatro","Dans","Stand Up","Müzikal Tiyatro","Müzikal Gösteri",
    "Gösteri","Bale","Çocuk","İKSV Tiyatro","Diğer Sahne","Basketbol","Basketbol Kombine",
    "Voleybol","Dövüş Sporları","Diğer Spor","Müze - Show","Eğitim - Seminer","Tur - Gezi",
    "Workshop","Üyelik Kartı","Hediye Kart","Sergi - Fuar","Sinema","Atölye","Diğer Futbol"
  ];

  /* Passo Dükkan (Kasım 2025'te açılan pazaryeri) satıcı markaları */
  var MAGAZALAR = [
    "GS Store","Fenerium","GözGöz","Starfan","Intersport","D'S Damat","Sporjinal",
    "Teksa","Ahlatçı","MD Kitap","AKM Kitap","İnza","Passo Dükkan"
  ];

  var ODEME_TIPLERI = [
    "Kredi Kartı","Banka Kartı","Cüzdan Kart","Passo Taraftar Kart","Passolig",
    "Pay'N Kolay","Hediye Kart","Havale","EFT","Nakit","Kapıda Ödeme",
    "Credit Card","Debit Card","Wallet","Gift Card","Cash"
  ];

  var KANALLAR = [
    "Web","Mobil","Mobil Uygulama","App","Mobile","Mobile App","iOS","Android","Gişe","Bayi",
    "Çağrı Merkezi","Call Center","Kiosk","Kulüp Mağazası","Online","Fiziksel","Offline",
    "Box Office","Website","Passo Mobil","Passo Web","Stadyum Gişesi"
  ];

  var BILET_KATEGORILERI = [
    "Kale Arkası Alt","Kale Arkası Üst","Maraton Alt","Maraton Üst","Kapalı Alt","Kapalı Üst",
    "Açık Tribün","VIP","Loca","Protokol","Misafir Tribünü","Kategori 1","Kategori 2",
    "Kategori 3","Kategori 4","Sahne Önü","Oturmalı","Ayakta","Erken Kuş","Öğrenci"
  ];

  var BANKALAR = [
    "Aktif Bank","Ziraat Bankası","İş Bankası","Garanti BBVA","Yapı Kredi","Akbank","QNB",
    "Denizbank","TEB","Halkbank","VakıfBank","ING","Şekerbank","Odeabank","Enpara"
  ];

  [ { id:"passo_kulup",     label:"kulüp / takım adı",     words:KULUPLER },
    { id:"passo_stadyum",   label:"stadyum / mekân adı",   words:STADYUMLAR },
    { id:"passo_lig",       label:"lig / organizasyon",    words:LIGLER },
    { id:"passo_kanal",     label:"satış kanalı",          words:KANALLAR },
    { id:"passo_kategori",  label:"bilet kategorisi",      words:BILET_KATEGORILERI },
    { id:"passo_banka",     label:"banka adı",             words:BANKALAR },
    { id:"passo_etkinlik",  label:"etkinlik kategorisi",   words:ETKINLIK_KATEGORILERI },
    { id:"passo_magaza",    label:"Passo Dükkan mağazası", words:MAGAZALAR },
    { id:"passo_odeme",     label:"ödeme tipi",            words:ODEME_TIPLERI }
  ].forEach(TC.registerVocab);

  /* ------------------------------------------------------------------
   * Alan tipleri
   * ------------------------------------------------------------------ */
  var BLOKLAR = ["A","B","C","D","E","F","G","H","J","K","L","M",
                 "N","P","R","S","T","U","V","Y","Z","AA","AB","AC"];

  var TIPLER = [

    /* ---- Kimlik / kart (6222 kapsamı) ---- */
    { id:"passo_kart", label:"Passo Taraftar / Passolig Kart", group:"Biletleme",
      sensitivity:"high", ozel:false, passthrough:"never", kanuni6222:true,
      header:[/passolig/i, /passo\s*kart/i, /taraftar\s*kart/i, /kombine\s*kart/i,
              /loyalty[_ ]?card/i, /fan[_ ]?card/i, /member(ship)?[_ ]?card/i],
      headerGerekli:true, checksum:true, fp:0.10,
      test:function(v){
        var s = String(v).trim();
        if(!/^\d[\d\s-]{13,21}$/.test(s)) return false;
        var d = s.replace(/\D/g,"");
        return d.length === 16 && TC.validators.luhn(d);
      },
      gen:function(rng){
        var body = "9" + pad(randInt(rng,1000,9999),4) + pad(randInt(rng,0,999999),6) + pad(randInt(rng,0,9999),4);
        body = body.slice(0,15);
        return body + TC.luhnCheckDigit(body);
      } },

    /* ---- Bilet ---- */
    { id:"bilet_no", label:"Bilet / PNR No", group:"Biletleme",
      sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/bilet\s*(no|kod|id)/i, /\bpnr\b/i, /rezervasyon\s*(no|kod)/i, /ticket\s*(no|id|code)/i],
      headerGerekli:true,
      test:function(v){ return /^[A-Z0-9]{6,14}$/i.test(String(v).trim()) && /\d/.test(String(v)); },
      gen:function(rng){
        var harf = "ABCDEFGHJKLMNPRSTUVYZ", s = "";
        for(var i=0;i<3;i++){ s += harf[randInt(rng,0,harf.length-1)]; }
        return s + pad(randInt(rng,100000,999999),6);
      } },

    { id:"barkod", label:"Barkod / QR Kodu", group:"Biletleme",
      sensitivity:"high", ozel:false, passthrough:"never",
      header:[/barkod/i, /barcode/i, /\bqr\b/i, /karekod/i],
      headerGerekli:true,
      test:function(v){ return /^\d{10,20}$/.test(String(v).replace(/\s/g,"")); },
      gen:function(rng, ctx){ return seriNo(rng, ctx, 8600000000000); } },

    { id:"kombine_no", label:"Kombine / Sezonluk No", group:"Biletleme",
      sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/kombine/i, /abonman/i, /season[_ ]?(ticket|pass)/i, /sezonluk/i, /subscription/i],
      headerGerekli:true,
      test:function(v){ return /^[A-Z]{0,3}\d{4,12}$/i.test(String(v).trim()); },
      gen:function(rng, ctx){ return "KMB" + pad(((ctx && ctx.index) || 0) * 7 + randInt(rng,1000,9999), 6); } },

    /* ---- Mekân hiyerarşisi: stadyum > blok > sıra > koltuk ---- */
    { id:"stadyum", label:"Stadyum / Mekân", group:"Biletleme",
      sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/stadyum/i, /\bstadium\b/i, /\bstat\b/i, /salon/i, /\bhall\b/i, /mekan/i, /mekân/i,
              /\bvenue\b/i, /arena/i, /sahne/i, /\bplace\b/i, /\bmuze\b/i, /museum/i],
      test:function(v){ return TC.guvenliSozluktemi(v, "passo_stadyum"); },
      gen:function(rng){ return pick(rng, STADYUMLAR); } },

    { id:"blok", label:"Blok / Tribün", group:"Biletleme",
      sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/blok/i, /\bblock\b/i, /tribun/i, /tribün/i, /tribune/i, /kisim/i, /\bsector\b/i, /\bstand\b/i],
      test:function(v){ return /^[A-Z]{1,3}\s?(blok|block)?$/i.test(String(v).trim()); },
      gen:function(rng){ return pick(rng, BLOKLAR) + " Blok"; } },

    { id:"sira_no", label:"Sıra No", group:"Biletleme",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/sira/i, /sıra/i, /\brow\b/i],
      headerGerekli:true,
      test:function(v){ var n = Number(String(v).trim()); return isFinite(n) && n >= 1 && n <= 99; },
      numeric:true, gen:null },

    { id:"koltuk_no", label:"Koltuk No", group:"Biletleme",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/koltuk/i, /\bseat\b/i],
      headerGerekli:true,
      test:function(v){
        var s = String(v).trim();
        return /^\d{1,3}$/.test(s) || /^[A-Z]{1,3}[\s-]?\d{1,3}[\s-]?\d{1,3}$/i.test(s);
      },
      gen:function(rng){ return String(randInt(rng,1,45)); } },

    { id:"turnike", label:"Turnike / Kapı", group:"Biletleme",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/turnike/i, /turnstile/i, /kapi/i, /kapı/i, /\bgate\b/i, /giris\s*kapi/i, /entrance/i],
      headerGerekli:true,
      test:function(v){ return /^[A-Z]?\d{1,3}$/i.test(String(v).trim()); },
      gen:function(rng){ return "K" + pad(randInt(rng,1,24),2); } },

    /* ---- Etkinlik ---- */
    { id:"etkinlik_kodu", label:"Etkinlik / Maç Kodu", group:"Biletleme",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/etkinlik\s*(id|kod|no)/i, /mac\s*(id|kod|no)/i, /maç\s*(id|kod|no)/i,
              /event[_ ]?(id|code|no)/i, /match[_ ]?(id|code|no)/i, /game[_ ]?id/i,
              /fikstur/i, /fixture/i, /organizasyon\s*(id|kod)/i],
      headerGerekli:true,
      test:function(v){ return /^[A-Z]{0,4}[\d-]{3,12}$/i.test(String(v).trim()); },
      gen:function(rng, ctx){ return "EVT" + pad(((ctx && ctx.index) || 0) + randInt(rng,1000,9999), 5); } },

    { id:"etkinlik_adi", label:"Etkinlik / Maç Adı", group:"Biletleme",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/etkinlik\s*ad/i, /mac\s*ad/i, /maç\s*ad/i, /event[_ ]?name/i, /match[_ ]?name/i,
              /fixture[_ ]?name/i, /organizasyon\s*ad/i, /gosteri/i, /\bshow[_ ]?name/i],
      test:function(){ return false; }, headerOnly:true,
      gen:function(rng){ return pick(rng, KULUPLER) + " - " + pick(rng, KULUPLER); } },

    { id:"kulup", label:"Kulüp / Takım", group:"Biletleme",
      sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/kulup/i, /kulüp/i, /takim/i, /takım/i, /ev\s*sahibi/i, /deplasman/i,
              /home[_ ]?team/i, /away[_ ]?team/i, /\bteam\b/i, /\bclub\b/i, /opponent/i, /rakip/i],
      test:function(v){ return TC.guvenliSozluktemi(v, "passo_kulup"); },
      gen:function(rng){ return pick(rng, KULUPLER); } },

    { id:"lig", label:"Lig / Organizasyon", group:"Biletleme",
      sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/\blig(i|de|den|e|in)?\b/i, /\bleague\b/i, /turnuva/i, /tournament/i, /competition/i,
              /sezon/i, /\bseason\b/i, /organizasyon\s*tur/i],
      test:function(v){ return TC.guvenliSozluktemi(v, "passo_lig"); },
      gen:function(rng){ return pick(rng, LIGLER); } },

    { id:"bilet_kategori", label:"Bilet Kategorisi", group:"Biletleme",
      sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/bilet\s*kategori/i, /tribun\s*kategori/i, /fiyat\s*kategori/i, /kategori\s*ad/i, /\bpkt\b/i,
              /ticket[_ ]?(category|type|class|tier)/i, /price[_ ]?(category|class|tier|band)/i,
              /seat[_ ]?(category|class)/i],
      test:function(v){ return TC.guvenliSozluktemi(v, "passo_kategori"); },
      gen:function(rng){ return pick(rng, BILET_KATEGORILERI); } },

    /* ---- Satış / ödeme ---- */
    { id:"kanal", label:"Satış Kanalı", group:"Biletleme",
      sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/kanal/i, /channel/i, /satis\s*nokta/i, /satış\s*nokta/i, /platform/i, /\bsource\b/i,
              /\bmedium\b/i, /sales[_ ]?point/i],
      test:function(v){ return TC.guvenliSozluktemi(v, "passo_kanal"); },
      gen:function(rng){ return pick(rng, KANALLAR); } },

    { id:"bayi_kodu", label:"Bayi / Gişe Kodu", group:"Biletleme",
      sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/bayi/i, /dealer/i, /gise/i, /gişe/i, /box[_ ]?office/i, /outlet/i, /terminal/i,
              /pos[_ ]?(no|id|kod|code)/i, /satis\s*nokta\s*kod/i],
      headerGerekli:true,
      test:function(v){ return /^[A-Z]{0,3}\d{2,8}$/i.test(String(v).trim()); },
      gen:function(rng, ctx){ return "BYI" + pad(randInt(rng,100,9999),4); } },

    { id:"kart_bin", label:"Kart BIN (ilk 6 hane)", group:"Biletleme",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/\bbin\b/i, /kart.*ilk\s*6/i, /issuer\s*(no|kod)/i, /banka\s*kod/i],
      headerGerekli:true,
      test:function(v){ return /^\d{6}$/.test(String(v).trim()); },
      gen:function(rng){ return pick(rng, ["411111","454671","540667","552096","479610","428220"]); } },

    { id:"banka", label:"Banka / Issuer", group:"Biletleme",
      sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/banka/i, /\bbank\b/i, /issuer/i, /karti\s*veren/i, /acquirer/i],
      test:function(v){ return TC.guvenliSozluktemi(v, "passo_banka"); },
      gen:function(rng){ return pick(rng, BANKALAR); } },

    { id:"taksit", label:"Taksit Sayısı", group:"Biletleme",
      sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/taksit/i, /installment/i],
      headerGerekli:true,
      test:function(v){ var n = Number(String(v).trim()); return isFinite(n) && n >= 0 && n <= 24; },
      numeric:true, gen:null },

    { id:"kupon_kodu", label:"Kupon / Promosyon Kodu", group:"Biletleme",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/kupon/i, /coupon/i, /voucher/i, /promosyon/i, /promo/i, /indirim\s*kod/i,
              /discount[_ ]?code/i, /kampanya\s*kod/i, /campaign[_ ]?code/i],
      headerGerekli:true,
      test:function(v){ return /^[A-Z0-9-]{4,16}$/i.test(String(v).trim()); },
      gen:function(rng){ return pick(rng,["ERKEN","TARAFTAR","SEZON","OGRENCI","HOSGELDIN"]) + randInt(rng,10,99); } },

    /* ---- Etkinlik kategorisi (Futbol / Müzik / Sahne / Spor / Müze / Diğer) ---- */
    { id:"etkinlik_kategori", label:"Etkinlik Kategorisi", group:"Biletleme",
      sensitivity:"none", ozel:false, passthrough:"ask",
      header:[/etkinlik\s*(kategori|tur|tür|tip)/i, /event[_ ]?(category|type|kind)/i,
              /organizasyon\s*tip/i, /ana[_ ]?kategori/i],
      test:function(v){ return TC.guvenliSozluktemi(v, "passo_etkinlik"); },
      gen:function(rng){ return pick(rng, ETKINLIK_KATEGORILERI); } },

    /* ---- Passo Dükkan (Kasım 2025'te açılan pazaryeri) ---- */
    { id:"sku", label:"Ürün Kodu / SKU", group:"Passo Dükkan",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/\bsku\b/i, /urun[_ ]?(kod|no|id)/i, /ürün[_ ]?(kod|no|id)/i, /stok[_ ]?kod/i,
              /product[_ ]?(code|no|id|sku)/i, /item[_ ]?(code|no|id)/i, /\bbarcode\b/i],
      headerGerekli:true,
      test:function(v){ return /^[A-Z0-9][A-Z0-9._-]{3,24}$/i.test(String(v).trim()); },
      gen:function(rng){ return "SKU-" + pad(randInt(rng,10000,99999),5); } },

    { id:"urun_adi", label:"Ürün Adı", group:"Passo Dükkan",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/urun[_ ]?ad/i, /ürün[_ ]?ad/i, /product[_ ]?(name|title)/i, /item[_ ]?name/i, /\bmodel\b/i],
      test:function(){ return false; }, headerOnly:true,
      gen:function(rng){
        return pick(rng,["Forma","Atkı","Şapka","Bere","Anahtarlık","Kupa","Eşofman","Ayakkabı","Çanta","Kitap"]) +
               " " + pick(rng,["Klasik","Sezon","Özel Seri","Çocuk","Deplasman","İç Saha"]);
      } },

    { id:"magaza", label:"Mağaza / Satıcı", group:"Passo Dükkan",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/magaza/i, /mağaza/i, /satici/i, /satıcı/i, /\bmerchant\b/i, /\bseller\b/i,
              /\bstore\b/i, /\bvendor\b/i, /marka/i, /\bbrand\b/i],
      test:function(v){ return TC.guvenliSozluktemi(v, "passo_magaza"); },
      gen:function(rng){ return pick(rng, MAGAZALAR); } },

    { id:"kargo_takip", label:"Kargo Takip No", group:"Passo Dükkan",
      sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/kargo[_ ]?(takip|no|kod)/i, /takip[_ ]?(no|kod|numara)/i, /tracking[_ ]?(no|number|code|id)/i,
              /shipment[_ ]?(no|id)/i, /\bawb\b/i, /gonderi[_ ]?no/i],
      headerGerekli:true,
      test:function(v){ return /^[A-Z0-9][A-Z0-9-]{6,24}$/i.test(String(v).trim()); },
      gen:function(rng){ return "TRK" + pad(randInt(rng,100000000,999999999),9); } },

    { id:"odeme_tipi", label:"Ödeme Tipi", group:"Passo Dükkan",
      sensitivity:"low", ozel:false, passthrough:"ask",
      header:[/odeme[_ ]?(tip|tür|tur|yontem|yöntem|sekli|şekli)/i, /ödeme[_ ]?(tip|yontem)/i,
              /payment[_ ]?(type|method|mode)/i, /\btender\b/i],
      test:function(v){ return TC.guvenliSozluktemi(v, "passo_odeme"); },
      gen:function(rng){ return pick(rng, ODEME_TIPLERI); } },

    { id:"hediye_kart", label:"Hediye Kart Kodu", group:"Passo Dükkan",
      sensitivity:"high", ozel:false, passthrough:"never",
      header:[/hediye[_ ]?kart/i, /gift[_ ]?(card|code|voucher)/i, /hediye[_ ]?kod/i],
      headerGerekli:true,
      test:function(v){ return /^[A-Z0-9-]{8,24}$/i.test(String(v).trim()); },
      gen:function(rng){
        var c = "ABCDEFGHJKLMNPRSTUVYZ23456789", out = "";
        for(var i=0;i<16;i++){ if(i && i % 4 === 0) out += "-"; out += c[randInt(rng,0,c.length-1)]; }
        return out;
      } },

    /* ---- Hatıra Bilet (NFT) ---- */
    { id:"nft_token", label:"Hatıra Bilet / NFT Token", group:"Biletleme",
      sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/\bnft\b/i, /token[_ ]?(id|no)/i, /hatira[_ ]?bilet/i, /hatıra[_ ]?bilet/i,
              /mint[_ ]?(id|hash)/i, /\btx[_ ]?hash/i, /blokzincir/i, /blockchain/i],
      headerGerekli:true,
      test:function(v){ return /^(0x[a-fA-F0-9]{16,64}|\d{1,20})$/.test(String(v).trim()); },
      gen:function(rng){ var h="0x"; for(var i=0;i<40;i++){ h += "0123456789abcdef"[randInt(rng,0,15)]; } return h; } },

    /* ---- İade / iptal nedeni ----
       Bilet İade Güvencesi'nde mücbir sebep belgeleri vefat, hastane yatışı,
       adli tebligat, polis raporu olabilir. Yani bu kolon sağlık ve ceza
       mahkûmiyeti verisi taşıyabilir — KVKK m.6 kapsamında ele alınır. */
    { id:"iade_nedeni", label:"İade / İptal Nedeni", group:"Özel Nitelikli",
      sensitivity:"high", ozel:true, passthrough:"never",
      header:[/iade[_ ]?(neden|sebep|aciklama)/i, /iptal[_ ]?(neden|sebep)/i, /mucbir/i, /mücbir/i,
              /refund[_ ]?reason/i, /cancel(lation)?[_ ]?reason/i, /return[_ ]?reason/i],
      test:function(){ return false; }, headerOnly:true,
      gen:function(rng){ return "IADE_NEDENI_" + pad(randInt(rng,1,12),2); } },

    { id:"giris_zamani", label:"Turnike Giriş Zamanı", group:"Biletleme",
      sensitivity:"medium", ozel:false, passthrough:"never",
      header:[/giris\s*(zaman|saat|tarih)/i, /giriş\s*(zaman|saat|tarih)/i,
              /turnike\s*(zaman|saat)/i, /entry[_ ]?time/i, /check[_ ]?in/i, /scan[_ ]?time/i,
              /admission[_ ]?time/i, /okutma/i],
      headerGerekli:true,
      test:function(v){ return TC.isDateLike(String(v).split(/[ T]/)[0]); },
      gen:null /* zaman üreteci profilden gelir */ }
  ];

  TC.registerTypes(TIPLER);

  window.PassoPack = {
    ETKINLIK_KATEGORILERI: ETKINLIK_KATEGORILERI,
    MAGAZALAR: MAGAZALAR,
    ODEME_TIPLERI: ODEME_TIPLERI,
    KULUPLER: KULUPLER,
    STADYUMLAR: STADYUMLAR,
    LIGLER: LIGLER,
    KANALLAR: KANALLAR,
    BILET_KATEGORILERI: BILET_KATEGORILERI,
    BANKALAR: BANKALAR,
    BLOKLAR: BLOKLAR,
    tipSayisi: TIPLER.length
  };
})();
