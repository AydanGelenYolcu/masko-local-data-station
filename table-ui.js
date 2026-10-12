/* Maskeleme İstasyonu — Excel/CSV sekmesi arayüzü
 *
 * Tasarım ilkesi: tespit hiçbir zaman %100 olmaz, o yüzden gizlenmez.
 * Her kolonun ne olduğu, ne kadar güvenildiği ve ne gönderileceği
 * kullanıcının önünde durur ve tek tıkla değiştirilebilir.
 *
 * Birden fazla dosya aynı oturumda tutulur: analistin elinde biletler +
 * etkinlikler + turnike birlikte olur ve join'lerin ayakta kalması gerekir.
 *
 * Ağır iş (okuma, ayrıştırma, profilleme) bir Web Worker'da yapılır; 50 MB'lık
 * bir Excel ana thread'de açılırsa arayüz dakikalarca donar. Worker
 * başlatılamazsa aynı iş ana thread'de yapılır — özellik kaybolmaz, yavaşlar.
 */
(function(){
  /* Dil sarmalayıcı: dil.js varsa sözlükten çevirir, yoksa şablonu olduğu
     gibi döner (Node testleri / dil tr-TR). Aynı mt table-engine'de de var. */
  function mt(metin){
    if(typeof window !== "undefined" && window.MaskoDil && window.MaskoDil.t){
      return window.MaskoDil.t.apply(null, arguments);
    }
    var degerler = Array.prototype.slice.call(arguments, 1);
    return String(metin).replace(/\{(\d+)(:t)?\}/g, function(_, i){
      return degerler[i] !== undefined ? String(degerler[i]) : "";
    });
  }
  "use strict";

  var TE = window.TableEngine;
  var TC = window.TypeCatalog;

  var $ = function(id){ return document.getElementById(id); };

  var state = {
    tablolar: [],    // { ad, workerId, sheets, aktifSheet, onizleme, rows?, analiz, dummy, passport }
    aktif: 0,
    iliskiler: [],
    seed: 1,
    sonrakiId: 1
  };

  function aktifTablo(){ return state.tablolar[state.aktif] || null; }

  // Hash kolonları için oturum anahtarı (HMAC-SHA-256). Yalnız bellekte durur:
  // aynı oturumdaki dosyalar arasında JOIN korunur, sayfa kapanınca anahtar
  // kaybolur ve özetler anahtarı bilmeyen biri tarafından geri çözülemez.
  var dosyaHashAnahtari = null;
  function hashAnahtari(){
    if(!dosyaHashAnahtari && window.FileMaskEngine){ dosyaHashAnahtari = window.FileMaskEngine.createSecretKey(); }
    return dosyaHashAnahtari;
  }

  /* ================= worker ================= */

  var worker = null;
  var workerBozuk = false;
  var bekleyen = {};   // workerId -> { resolve, reject, tablo }

  function workerAl(){
    if(workerBozuk) return null;
    if(worker) return worker;
    try {
      worker = new Worker("table-worker.js");
      worker.onmessage = workerMesaj;
      worker.onerror = function(e){
        // Worker hiç başlamadıysa bekleyen işleri ana thread'e devret
        console.warn("Worker hatası, ana thread'e düşülüyor:", e && e.message);
        workerBozuk = true;
        try { worker.terminate(); } catch(x){}
        worker = null;
        Object.keys(bekleyen).forEach(function(id){
          var b = bekleyen[id];
          delete bekleyen[id];
          if(b && b.yedek) b.yedek();
        });
        Object.keys(kopyaBekleyen).forEach(function(no){
          var kb = kopyaBekleyen[no];
          delete kopyaBekleyen[no];
          kb(null);
        });
      };
      return worker;
    } catch(e){
      workerBozuk = true;
      return null;
    }
  }

  function workerMesaj(e){
    var m = e.data || {};
    var b = bekleyen[m.id];

    if(m.tip === "ilerleme"){ ilerlemeGoster(m.asama, m.yuzde); return; }

    if(m.tip === "hata"){
      delete bekleyen[m.id];
      if(b && b.hataMask){ b.hataMask(m.mesaj); }
      else if(b && b.yedek){ b.yedek(); }
      else { durum("Dosya okunamadı: " + m.mesaj, true); }
      return;
    }

    if(m.tip === "sayfalar"){
      if(b && b.tablo){ b.tablo.sheets = m.sheets; }
      return;
    }

    if(m.tip === "profil"){
      if(!b) return;
      delete bekleyen[m.id];
      var t = b.tablo;
      t.aktifSheet = m.sheetIndex;
      t.onizleme = m.onizleme;
      t.delimiter = m.delimiter;
      t.analiz = TE.tespitEkle(m.profil);
      if(b.resolve) b.resolve(t);
      return;
    }

    if(m.tip === "maskeleSonuc"){
      if(b && b.resolveMask){
        delete bekleyen[m.id];
        b.resolveMask(m);
      }
      return;
    }

    if(m.tip === "kopyaSonuc"){
      var kb = kopyaBekleyen[m.istek];
      delete kopyaBekleyen[m.istek];
      if(kb) kb(m.sonuc);
      return;
    }
  }

  /* Sentetik satırların dosyanın TAMAMINA karşı kopya denetimi: tam satırlar
     worker'da (ya da ana thread yolunda t.rows'ta) durur. Örnek denetimi
     hemen gösterilir, bu sonuç gelince kart güncellenir. */
  var kopyaIstekNo = 0, kopyaBekleyen = {};
  function tamKopyaDenetimiIste(t, cb){
    var satirlar = t.dummy.rows, kolon = t.analiz.columns.length, baslik = t.analiz.headerRowIdx || 0;
    if(t.workerId && worker && !workerBozuk){
      var no = ++kopyaIstekNo;
      kopyaBekleyen[no] = cb;
      worker.postMessage({ tip:"kopyaDenetimi", id:t.workerId, istek:no, sheetIndex:t.aktifSheet || 0,
                           headerRowIdx:baslik, kolonSayisi:kolon, satirlar:satirlar });
      return;
    }
    if(t.rows){
      setTimeout(function(){
        var sonuc = null;
        try { sonuc = TE.tamKopyaDenetimi(t.rows, baslik, kolon, satirlar); } catch(e){}
        cb(sonuc);
      }, 0);
      return;
    }
    cb(null);
  }

  /* ================= dosya alma ================= */

  var dropZone = $("dropZone");
  var fileInput = $("fileInput");

  dropZone.addEventListener("click", function(){ fileInput.click(); });
  dropZone.addEventListener("keydown", function(e){
    if(e.key === "Enter" || e.key === " "){ e.preventDefault(); fileInput.click(); }
  });
  ["dragenter","dragover"].forEach(function(ev){
    dropZone.addEventListener(ev, function(e){ e.preventDefault(); dropZone.classList.add("is-over"); });
  });
  ["dragleave","drop"].forEach(function(ev){
    dropZone.addEventListener(ev, function(e){ e.preventDefault(); dropZone.classList.remove("is-over"); });
  });
  dropZone.addEventListener("drop", function(e){
    var d = e.dataTransfer && e.dataTransfer.files;
    if(d && d.length) sirayla(Array.prototype.slice.call(d));
  });
  fileInput.addEventListener("change", function(e){
    var d = Array.prototype.slice.call(e.target.files || []);
    if(d.length) sirayla(d);
    e.target.value = "";
  });
  $("addFileBtn").addEventListener("click", function(){ fileInput.click(); });

  function sirayla(dosyalar){
    var i = 0;
    function sonraki(){
      if(i >= dosyalar.length){ tamamla(); return; }
      dosyaAl(dosyalar[i++]).then(sonraki, sonraki);
    }
    sonraki();
  }

  var ASAMA_ADI = {
    okuma: "dosya okunuyor",
    cozumleme: "tablo çözümleniyor",
    profilleme: "kolonlar profilleniyor",
    bitti: "hazırlanıyor"
  };

  function durum(mesaj, hata){
    var el = $("fileStatus");
    el.hidden = false;
    $("fileStatusText").textContent = mesaj;
    el.classList.toggle("is-error", !!hata);
    if(hata) $("progressTrack").hidden = true;
  }
  function durumGizle(){ $("fileStatus").hidden = true; $("progressTrack").hidden = true; }

  var suAnkiDosya = "";
  function ilerlemeGoster(asama, yuzde){
    $("fileStatus").hidden = false;
    $("fileStatusText").textContent = "“" + suAnkiDosya + "” — " + (ASAMA_ADI[asama] || asama) + "…";
    $("progressTrack").hidden = false;
    $("progressFill").style.width = Math.round(Math.max(0, Math.min(1, yuzde || 0)) * 100) + "%";
  }

  function dosyaAl(file){
    suAnkiDosya = file.name;
    var mb = file.size / (1024*1024);
    var t = { ad: file.name, workerId: null, sheets: [], aktifSheet: 0,
              onizleme: [], rows: null, analiz: null };

    ilerlemeGoster("okuma", 0);
    if(mb > 40){
      durum("“" + file.name + "” " + mb.toFixed(0) + " MB — büyük dosya, ayrıştırma arka planda sürüyor…");
      $("progressTrack").hidden = false;
    }

    var w = workerAl();
    if(w){
      return new Promise(function(resolve){
        var id = state.sonrakiId++;
        t.workerId = id;
        bekleyen[id] = {
          tablo: t,
          resolve: function(){ state.tablolar.push(t); state.aktif = state.tablolar.length - 1; resolve(t); },
          yedek: function(){ anaThreadOku(file, t).then(resolve, resolve); }
        };
        try { w.postMessage({ tip:"dosya", id:id, file:file }); }
        catch(err){
          // Bazı tarayıcılar File nesnesini kopyalayamazsa
          delete bekleyen[id];
          workerBozuk = true;
          anaThreadOku(file, t).then(resolve, resolve);
        }
      });
    }
    return anaThreadOku(file, t);
  }

  // Worker yoksa aynı iş burada yapılır; sadece daha yavaş ve arayüz donabilir.
  function anaThreadOku(file, t){
    t.workerId = null;
    return TE.parseFile(file, function(asama, yuzde){ ilerlemeGoster(asama, yuzde); })
      .then(function(sheets){
        if(!sheets.length){ durum("“" + file.name + "” içinde okunabilir tablo yok.", true); return null; }
        t.sheetsHam = sheets;
        t.sheets = sheets.map(function(s){ return { name:s.name, satirSayisi:s.rows.length }; });
        t.rows = sheets[0].rows;
        t.delimiter = sheets[0].delimiter || null;
        t.onizleme = t.rows.slice(0, 15);
        t.analiz = TE.analyze(t.rows);
        state.tablolar.push(t);
        state.aktif = state.tablolar.length - 1;
        return t;
      })
      .catch(function(err){
        durum("“" + file.name + "” okunamadı: " + (err && err.message ? err.message : err), true);
        return null;
      });
  }

  // Başlık satırı / sayfa değişimi: dosya yeniden okunmaz, worker belleğindeki
  // satırlar yeniden profillenir.
  function yenidenProfille(t, sheetIndex, headerRowIdx){
    if(t.workerId && worker && !workerBozuk){
      return new Promise(function(resolve){
        bekleyen[t.workerId] = { tablo: t, resolve: resolve, yedek: function(){ resolve(t); } };
        worker.postMessage({ tip:"profille", id:t.workerId, sheetIndex:sheetIndex, headerRowIdx:headerRowIdx });
      });
    }
    // Ana thread yolu
    if(t.sheetsHam){
      t.aktifSheet = sheetIndex;
      t.rows = t.sheetsHam[sheetIndex].rows;
      t.onizleme = t.rows.slice(0, 15);
    }
    t.analiz = TE.analyze(t.rows, { headerRowIdx: headerRowIdx });
    return Promise.resolve(t);
  }

  function tamamla(){
    if(!state.tablolar.length){ return; }
    durumGizle();
    iliskileriYenile();
    $("fileResult").hidden = false;
    hepsiniCiz();
  }

  /* ================= ilişkiler + üretim ================= */

  function iliskileriYenile(){
    TE.takmaAdSifirla();
    state.iliskiler = state.tablolar.length > 1 ? TE.iliskileriBul(state.tablolar) : [];
    uret();
  }

  function uret(){
    var n = Number($("rowCountSelect").value) || 20;
    TE.takmaAdSifirla();
    state.tablolar.forEach(function(t, i){
      t.dummy = TE.generateSynthetic(t.analiz, n, t.ad + "#" + state.seed);
      // Pasaport çıktı yazılırken kurulur (bkz. ciktiYaz): metni dile
      // duyarlıdır, dil değişince yeniden üretilmelidir.
    });
  }

  /* ================= çizim ================= */

  function hepsiniCiz(){
    tabloSekmeleriCiz();
    metaYaz();
    kanunUyarisi();
    turUyarisi();
    iliskiKutusu();
    noShowAyarlariniCiz();
    basligiSecicisiKur();
    sayfaSecicisiKur();
    kolonlariCiz();
  }

  function tabloSekmeleriCiz(){
    var wrap = $("fileTabs");
    wrap.innerHTML = "";
    if(state.tablolar.length <= 1){ wrap.hidden = true; return; }
    wrap.hidden = false;
    state.tablolar.forEach(function(t, i){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "file-tab" + (i === state.aktif ? " is-active" : "");
      b.textContent = t.ad;
      b.addEventListener("click", function(){ state.aktif = i; hepsiniCiz(); });
      var x = document.createElement("span");
      x.className = "file-tab-x";
      x.textContent = "×";
      x.title = "Bu dosyayı çıkar";
      x.addEventListener("click", function(e){
        e.stopPropagation();
        if(t.workerId && worker){ worker.postMessage({ tip:"kapat", id:t.workerId }); }
        state.tablolar.splice(i, 1);
        state.aktif = Math.max(0, Math.min(state.aktif, state.tablolar.length - 1));
        if(!state.tablolar.length){ $("fileResult").hidden = true; return; }
        iliskileriYenile();
        hepsiniCiz();
      });
      b.appendChild(x);
      wrap.appendChild(b);
    });
  }

  function metaYaz(){
    var t = aktifTablo();
    if(!t) return;
    var a = t.analiz;
    var parcalar = [
      "<strong translate='no'>" + kacar(t.ad) + "</strong>",
      a.toplamSatir.toLocaleString("tr-TR") + " satır",
      a.columns.length + " kolon"
    ];
    if(a.orneklemeAdimi > 1){
      parcalar.push("istatistikler " + a.orneklenenSatir.toLocaleString("tr-TR") + " satırlık örneklemden");
    }
    if(t.delimiter){ parcalar.push("ayraç “" + (t.delimiter === "\t" ? "TAB" : t.delimiter) + "”"); }
    if(state.tablolar.length > 1){ parcalar.push(state.tablolar.length + " dosya yüklü"); }
    parcalar.push(t.workerId ? "arka planda işlendi" : "ana thread'de işlendi");
    $("fileMeta").innerHTML = parcalar.join(" · ");
  }

  function kanunUyarisi(){
    var el = $("kanunWarning");
    var t = aktifTablo();
    if(!t || !TE.kanuni6222Var(t.analiz)){ el.hidden = true; return; }
    el.hidden = false;
    el.translate = false;   // mt() çevirir; dil değişince hepsiniCiz yeniden yazar
    el.innerHTML = mt("<strong>Bu tablo kimliğe bağlı.</strong> TC Kimlik No / pasaport / Passo Taraftar Kart kolonu içeriyor. Biletleme verisinde bu tesadüf değil: 6222 sayılı Kanun gereği her bilet bir kimliğe tanımlanmak zorunda. Bu kolonların gerçek değerleri hiçbir koşulda gönderilmiyor ve bu ayar kapatılamıyor.");
  }

  /* Başlık ile değerleri çatışan sütunlar tablonun üstünde toplanır: tür
     yanlışsa pasaport ve AI'a giden açıklama da yanlış olur. Kullanıcı türü
     elle seçince o sütunun uyarısı kalkar. */
  function turUyarisi(){
    var el = $("typeWarning");
    var t = aktifTablo();
    var supheli = t ? t.analiz.columns.filter(function(k){ return k.tespit.uyari; }) : [];
    if(!supheli.length){ el.hidden = true; return; }
    el.hidden = false;
    el.translate = false;   // mt() + veri; dil değişince hepsiniCiz yeniden yazar
    el.innerHTML = mt("<strong>{0} sütunda tür şüpheli.</strong> Başlık ile değerler uyuşmuyor. Aşağıda işaretli sütunların türünü kontrol edin; yanlış tür veri pasaportunu ve yapay örneğin AI'a nasıl anlatıldığını bozar. Türü elle seçince uyarı kalkar.", supheli.length) +
      "<ul>" + supheli.map(function(k){
        return "<li><code>" + kacar(k.name) + "</code> — " + kacar(mt(k.tespit.type.label)) + "</li>";
      }).join("") + "</ul>";
  }

  function iliskiKutusu(){
    var el = $("relationsBox");
    if(state.tablolar.length < 2){ el.hidden = true; return; }
    el.hidden = false;
    el.translate = false;   // mt() + veri; dil değişince hepsiniCiz yeniden yazar
    if(!state.iliskiler.length){
      el.className = "relations-box is-empty";
      el.innerHTML = mt("<strong>Tablolar arasında ortak anahtar bulunamadı.</strong> Kolon adları farklıysa veya değerler örtüşmüyorsa join tespit edilemez — dosyaları ayrı ayrı analiz ettirmeniz gerekebilir.");
      return;
    }
    el.className = "relations-box";
    var liste = state.iliskiler.map(function(i){
      return "<li><code translate='no'>" + kacar(i.sol) + "</code> ↔ <code translate='no'>" + kacar(i.sag) + "</code> " +
             "<span class='rel-why'>(" + kacar(mt(i.gerekce)) + ")</span></li>";
    }).join("");
    el.innerHTML = mt("<strong>{0} ortak anahtar bulundu.</strong> Bu kolonlarda aynı gerçek değer her dosyada aynı sahte değere dönüşüyor — yani join'ler örnek veride de çalışıyor.", state.iliskiler.length) +
      "<ul>" + liste + "</ul>";
  }

  function sayfaSecicisiKur(){
    var t = aktifTablo();
    var wrap = $("sheetWrap"), sel = $("sheetSelect");
    if(!t || t.sheets.length <= 1){ wrap.hidden = true; return; }
    sel.innerHTML = "";
    t.sheets.forEach(function(s, i){
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = mt("{0} ({1} satır)", s.name, s.satirSayisi);   // #sheetSelect translate="no": ek burada çevrilir
      sel.appendChild(o);
    });
    sel.value = String(t.aktifSheet);
    wrap.hidden = false;
  }

  function basligiSecicisiKur(){
    var t = aktifTablo();
    if(!t) return;
    var sel = $("headerRowSelect");
    sel.innerHTML = "";
    var satirlar = t.onizleme || [];
    for(var i=0;i<satirlar.length;i++){
      var o = document.createElement("option");
      o.value = String(i);
      var onizleme = (satirlar[i] || []).filter(function(c){ return String(c).trim() !== ""; })
        .slice(0,4).join(" | ");
      o.textContent = (i+1) + ". satır — " + (onizleme.slice(0,50) || "(boş)");
      sel.appendChild(o);
    }
    sel.value = String(t.analiz.headerRowIdx);
  }

  /* ================= kolon tablosu ================= */

  function tipSecici(kol){
    var sel = document.createElement("select");
    sel.className = "col-type-select";
    var gruplar = {};
    TC.TYPES.forEach(function(t){ (gruplar[t.group] = gruplar[t.group] || []).push(t); });
    Object.keys(gruplar).forEach(function(g){
      var og = document.createElement("optgroup");
      og.label = g;
      gruplar[g].forEach(function(t){
        var o = document.createElement("option");
        o.value = t.id;
        o.textContent = t.label;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    sel.value = kol.tespit.typeId;
    sel.addEventListener("change", function(){
      var t = TC.typeById(sel.value);
      if(!t) return;
      kol.tespit.type = t;
      kol.tespit.typeId = t.id;
      kol.tespit.guven = 1;
      kol.tespit.guvenEtiket = "elle";
      kol.tespit.gerekce = "siz seçtiniz";
      kol.tespit.uyari = null;   // kullanıcı türü kendisi doğruladı
      kol.karar = TE.passthroughKarari(kol, kol.tespit);
      uret(); kolonlariCiz(); kanunUyarisi(); turUyarisi(); ciktiTazele();
    });
    return sel;
  }

  function gonderimSecici(kol){
    var sel = document.createElement("select");
    sel.className = "col-send-select";
    [
      ["uret","Sahte üret (Sentetik)"],
      ["asterisk","Kısmi yıldızla (Ah***)"],
      ["token","Takma kod ([KOD_1])"],
      ["hash","Anahtarlı hash (HMAC-SHA-256)"],
      ["generalize_date","Yıla genelle (k-anonimlik)"],
      ["generalize_age","Yaş aralığı (k-anonimlik)"],
      ["generalize_numeric","Sayı aralığı (k-anonimlik)"],
      ["clear","Boşalt / Temizle"],
      ["gercek","GERÇEK değerler"]
    ].forEach(function(pair){
      var o = document.createElement("option");
      o.value = pair[0]; o.textContent = pair[1];
      sel.appendChild(o);
    });
    sel.value = kol.karar.mod;
    if(!kol.karar.degistirilebilir && kol.karar.mod === "uret"){
      var optGercek = sel.querySelector('option[value="gercek"]');
      if(optGercek) optGercek.disabled = true;
    }
    sel.classList.toggle("is-real", kol.karar.mod === "gercek");
    sel.addEventListener("change", function(){
      kol.karar.mod = sel.value;
      uret(); kolonlariCiz(); ciktiTazele();
    });
    return sel;
  }

  function kolonlariCiz(){
    var t = aktifTablo();
    if(!t) return;
    var body = $("colBody");
    body.innerHTML = "";
    var ornekSatir = (t.dummy && t.dummy.rows[0]) || [];

    t.analiz.columns.forEach(function(kol, i){
      var tr = document.createElement("tr");

      var tdAd = document.createElement("td");
      tdAd.className = "col-name";
      // Kolon adı kullanıcı verisidir: arayüz dili değişince çevrilmez ("Tarih" → "Date" olmasın)
      var adYazi = document.createElement("span");
      adYazi.setAttribute("translate", "no");
      adYazi.textContent = kol.name;
      tdAd.appendChild(adYazi);
      if(kol.tarihBelirsiz){ tdAd.appendChild(not("col-warn", "gün/ay sırası belirsiz",
        "Bu kolonda 12'den büyük bir ilk/ikinci hane yok, bu yüzden gg/aa mı aa/gg mi çözülemedi.")); }
      if(kol.joinGrubu){ tdAd.appendChild(not("col-join", "ortak anahtar",
        "Bu kolon başka bir dosyayla eşleşiyor; sahte değerleri her dosyada aynı olacak.")); }
      // Motor yalnızca kolon indeksini saklar; bu tablo yerel olduğundan ham
      // adla çözülür (prompt/pasaport dışa aktarılan adı kullanır).
      var ebeveyn = TE.hiyerarsiEbeveynAdi(kol, t.analiz.columns, hamAd);
      if(ebeveyn){ tdAd.appendChild(not("col-hier", "→ " + ebeveyn,
        "Bu kolonun her değeri tek bir " + ebeveyn + " değerine bağlı; sahte veride de öyle kalacak.")); }
      var turetilmis = TE.turetilmisAciklama(kol, t.analiz.columns, hamAd);
      if(turetilmis){ tdAd.appendChild(not("col-hier", "= " + turetilmis, "Türetilmiş kolon.")); }
      tr.appendChild(tdAd);

      var tdTip = document.createElement("td");
      tdTip.appendChild(tipSecici(kol));
      if(kol.tespit.uyari){
        tr.classList.add("has-conflict");
        tdTip.appendChild(not("col-conflict", kol.tespit.uyari, ""));
      }
      if(kol.tespit.type.ozel){
        tdTip.appendChild(rozet("ozel-badge", "KVKK m.6", "Özel nitelikli kişisel veri — gerçek değer gönderilmez."));
      }
      if(kol.tespit.type.kanuni6222){
        tdTip.appendChild(rozet("kanun-badge", "6222", "Kanunen kimliğe bağlı alan."));
      }
      tr.appendChild(tdTip);

      var tdGuven = document.createElement("td");
      tdGuven.appendChild(rozet("conf-badge " + guvenSinifi(kol.tespit.guvenEtiket),
        kol.tespit.guvenEtiket, kol.tespit.gerekce));
      tdGuven.appendChild(not("col-reason", kol.tespit.gerekce, ""));
      tr.appendChild(tdGuven);

      var tdGonder = document.createElement("td");
      tdGonder.appendChild(gonderimSecici(kol));
      if(kol.karar.mod === "gercek"){
        tdGonder.appendChild(not("col-reason is-real-note", kol.karar.sebep, ""));
      }
      tr.appendChild(tdGonder);

      // Sizde kalan gerçek örnek — ekrandan çıkmaz, sadece sahtesiyle
      // karşılaştırabilesiniz diye. Kullanıcının en çok ihtiyacı olan şey buydu:
      // "neyin değiştiğini göremiyorum".
      var tdGercek = document.createElement("td");
      tdGercek.className = "col-sample col-original";
      tdGercek.setAttribute("translate", "no");
      tdGercek.textContent = ornekGercek(kol);
      tr.appendChild(tdGercek);

      var tdOrnek = document.createElement("td");
      tdOrnek.className = "col-sample col-fake";
      tdOrnek.setAttribute("translate", "no");
      var sahte = ornekSatir[i] === "" ? "(boş)" : (ornekSatir[i] || "—");
      var gVal = ornekGercek(kol);
      if(kol.karar.mod === "asterisk"){
        sahte = window.FileMaskEngine ? window.FileMaskEngine.maskAsterisk(gVal, kol.tespit.typeId) : sahte;
      } else if(kol.karar.mod === "token"){
        sahte = "[" + (kol.tespit.typeId || kol.name || "KOD").toUpperCase().slice(0, 10) + "_1]";
      } else if(kol.karar.mod === "hash"){
        sahte = window.FileMaskEngine ? window.FileMaskEngine.maskHash(gVal, hashAnahtari(), 16) + '…' : 'e3b0c442…';
      } else if(kol.karar.mod === "generalize_date"){
        sahte = window.FileMaskEngine ? window.FileMaskEngine.generalizeDate(gVal, 'year') : '1990';
      } else if(kol.karar.mod === "generalize_age"){
        sahte = window.FileMaskEngine ? window.FileMaskEngine.generalizeAge(gVal, 10) : '20-29';
      } else if(kol.karar.mod === "generalize_numeric"){
        sahte = window.FileMaskEngine ? window.FileMaskEngine.generalizeNumeric(gVal, 1000, kol.sayiBicimi) : '1000-1999';
      } else if(kol.karar.mod === "clear"){
        sahte = "(boşaltıldı)";
      }
      tdOrnek.textContent = sahte;
      if(kol.karar.mod === "gercek"){
        tdOrnek.classList.add("is-passthrough");
        tdOrnek.title = "Bu kolonda gerçek değerler gönderiliyor — soldakiyle aynı türden olması normal.";
      }
      tr.appendChild(tdOrnek);

      var tdBaslik = document.createElement("td");
      var fazla = TE.baslikFazlasi(kol);
      var onerilir = TE.baslikHassasMi(kol);

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!kol.basligiMaskele;
      cb.title = onerilir
        ? "Başlıktaki fazladan bilgi atılır, semantik tip korunur: " + kol.name + " → " + TE.baslikMaskeOner(kol)
        : "Bu başlık zaten yalnızca kolonun ne olduğunu söylüyor — gizlemek bilgi kaybettirir.";
      cb.addEventListener("change", function(){
        kol.basligiMaskele = cb.checked;
        TE.basliklariTazele(t.analiz);   // çakışma numaraları toplu hesaplanır
        uret(); kolonlariCiz(); ciktiTazele();
      });
      tdBaslik.appendChild(cb);

      if(kol.basligiMaskele){
        // Önerilen ad her zaman iyi olmuyor ("tckn", "saglik_alani" gibi).
        // Kullanıcı kendi adını yazabilsin; boş bırakırsa öneri kullanılır.
        var oneri = TE.baslikMaskeOner(kol);
        var kutu = document.createElement("input");
        kutu.type = "text";
        kutu.className = "col-baslik-ozel";
        kutu.value = kol.ozelBaslik || "";
        kutu.placeholder = oneri;
        kutu.title = "Gönderilecek başlığı kendiniz yazabilirsiniz. " +
          "Boş bırakırsanız önerilen ad kullanılır: " + oneri;
        kutu.setAttribute("aria-label", kol.name + " yerine gönderilecek başlık");
        // "change" (odak çıkışı) kullanılır: "input" her harfte tabloyu
        // yeniden çizip odağı kaybettirirdi.
        kutu.addEventListener("change", function(){
          kol.ozelBaslik = kutu.value;
          TE.basliklariTazele(t.analiz);
          uret(); kolonlariCiz(); ciktiTazele();
        });
        tdBaslik.appendChild(kutu);
        tdBaslik.appendChild(not("col-reason", "→ " + kol.disaAktarilanAd, ""));
      } else if(onerilir){
        // Neyin gizleneceğini göster — "hassas görünüyor" demek bir şey anlatmıyor
        tdBaslik.appendChild(not("col-reason is-suggest",
          fazla.length ? "gizler: " + fazla.join(", ") : "KVKK m.6 — kategori adı da sızdırır",
          kol.name + " → " + TE.baslikMaskeOner(kol)));
      }
      tr.appendChild(tdBaslik);

      body.appendChild(tr);
    });

    sizintiUyarisi();
  }

  function hamAd(kol){ return kol ? kol.name : "kolon"; }

  // Kolonun ortasından temsili bir gerçek değer (ilk satır çoğu zaman atipiktir)
  function ornekGercek(kol){
    var v = kol.values && kol.values.length
      ? kol.values[Math.floor(kol.values.length / 2)] : "";
    if(v === "" || v === undefined) return "(boş)";
    return String(v).length > 40 ? String(v).slice(0, 40) + "…" : String(v);
  }

  /* Sınıf + metin (+ opsiyonel başlık) taşıyan tek elemanlık etiket.
     "not" blok seviyesinde (div), "rozet" satır içinde (span) durur. */
  function etiketOge(tag, cls, metin, baslik){
    var el = document.createElement(tag);
    el.className = cls;
    el.textContent = mt(metin);           // etiket/rok/metin cümleleri — veri dolu {0} yuvaları ham dolar
    el.translate = false;                 // mt() çevirdi; dil değişince kolonlar yeniden çizilir
    if(baslik) el.title = mt(baslik);
    return el;
  }
  function not(cls, metin, baslik){ return etiketOge("div", cls, metin, baslik); }
  function rozet(cls, metin, baslik){ return etiketOge("span", cls, metin, baslik); }

  function guvenSinifi(etiket){
    if(etiket === "kesin" || etiket === "elle") return "certain";
    if(etiket === "yüksek") return "high";
    if(etiket === "orta") return "medium";
    return "low";
  }

  function sizintiUyarisi(){
    var el = $("leakWarning");
    var t = aktifTablo();
    if(!t) return;
    var gercekler = t.analiz.columns.filter(function(k){ return k.karar.mod === "gercek"; });
    el.hidden = false;
    if(!gercekler.length){
      el.className = "leak-warning is-clean";
      el.translate = false;
      el.innerHTML = mt("<strong>Bu tabloda hiçbir gerçek değer gönderilmiyor.</strong> Her kolon sıfırdan üretiliyor.");
      return;
    }
    el.className = "leak-warning";
    el.translate = false;   // mt() + veri; dil değişince hepsiniCiz yeniden yazar
    var liste = gercekler.map(function(k){
      var ornek = k.enSikDegerler.slice(0,3).map(function(d){ return d.deger; }).join(", ");
      // Satır burada tamamen kurulur (veri + mt() metni): dil.js yeniden işlemesin.
      return "<li translate='no'><strong>" + kacar(k.name) + "</strong> — " + kacar(mt(k.karar.sebep)) +
             (ornek ? "<br><span class='leak-sample'>" + mt("gidecek değerler: <span translate='no'>{0}</span>…", kacar(ornek)) + "</span>" : "") + "</li>";
    }).join("");
    el.innerHTML = mt("<strong>Şu {0} kolonda GERÇEK değerler gönderilecek</strong> — kişiyi işaret etmediklerine siz karar verin, gerekirse “sahte üret”e çevirin:", gercekler.length) + "<ul>" + liste + "</ul>";
  }

  function kacar(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c];
    });
  }

  function noShowIndex(id){
    var value = $(id).value;
    if(!value) return "";
    var index = parseInt(value, 10);
    return Number.isInteger(index) ? index : "";
  }

  function fillNoShowSelect(id, placeholder, values, selected){
    var select = $(id);
    select.textContent = "";
    var empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    select.appendChild(empty);
    values.forEach(function(item){
      var option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      option.setAttribute("translate", "no");   // tablo/kolon adı kullanıcı verisidir, çevrilmez
      select.appendChild(option);
    });
    if(values.some(function(item){ return item.value === selected; })) select.value = selected;
  }

  function fillNoShowTables(id){
    var current = $(id).value;
    fillNoShowSelect(id, "Tablo seçin…", state.tablolar.map(function(table, index){
      return { value:index + "::" + encodeURIComponent(table.ad), label:table.ad };
    }), current);
  }

  function fillNoShowColumns(id, tableSelectId){
    var current = $(id).value;
    var tableIndex = noShowIndex(tableSelectId);
    var table = tableIndex === "" ? null : state.tablolar[tableIndex];
    var columns = table ? table.analiz.columns.map(function(column, index){
      return { value:index + "::" + encodeURIComponent(column.name), label:column.disaAktarilanAd || column.name };
    }) : [];
    fillNoShowSelect(id, "Kolon seçin…", columns, current);
  }

  function noShowConfigOku(){
    return {
      salesTable:noShowIndex("noShowSalesTable"),
      salesKey:noShowIndex("noShowSalesKey"),
      scanTable:noShowIndex("noShowScanTable"),
      scanKey:noShowIndex("noShowScanKey"),
      salesEvent:noShowIndex("noShowSalesEvent"),
      scanEvent:noShowIndex("noShowScanEvent"),
      oneEvent:$("noShowOneEvent").checked,
      denominatorMode:$("noShowDenominator").value,
      salesStatus:noShowIndex("noShowSalesStatus"),
      validStatuses:$("noShowValidStatuses").value,
      filteredValidSales:$("noShowFilteredConfirm").checked,
      successfulScans:$("noShowSuccessfulScans").checked
    };
  }

  function noShowAyarlariniCiz(){
    var panel = $("noShowPanel");
    if(!panel) return;
    panel.hidden = $("taskSelect").value !== "noshow";
    if(panel.hidden) return;

    fillNoShowTables("noShowSalesTable");
    fillNoShowTables("noShowScanTable");
    fillNoShowColumns("noShowSalesKey", "noShowSalesTable");
    fillNoShowColumns("noShowSalesEvent", "noShowSalesTable");
    fillNoShowColumns("noShowSalesStatus", "noShowSalesTable");
    fillNoShowColumns("noShowScanKey", "noShowScanTable");
    fillNoShowColumns("noShowScanEvent", "noShowScanTable");

    var mode = $("noShowDenominator").value;
    $("noShowStatusFields").hidden = mode !== "status";
    $("noShowFilteredConfirmWrap").hidden = mode !== "filtered";
    var assessment = TE.assessNoShowReadiness(state.tablolar, noShowConfigOku());
    var box = $("noShowReadiness");
    box.textContent = assessment.ready
      ? "Hazır: tanım ve kolon eşleşmeleri seçildi. Prompt, tekrar okutmaları tek bilet sayacak."
      : "Henüz hazır değil — tamamlanması gerekenler:";
    box.classList.toggle("is-ready", assessment.ready);
    if(!assessment.ready){
      var list = document.createElement("ul");
      assessment.gaps.forEach(function(gap){
        var item = document.createElement("li");
        item.textContent = gap;
        list.appendChild(item);
      });
      box.appendChild(list);
    }
  }

  function outboundRealValues(tables, tableIndexes){
    var result = [];
    tableIndexes.forEach(function(tableIndex){
      var table = tables[tableIndex];
      if(!table || !table.dummy) return;
      table.analiz.columns.forEach(function(column, columnIndex){
        if(!column.karar || column.karar.mod !== "gercek") return;
        var seen = Object.create(null);
        table.dummy.rows.forEach(function(row){
          var value = row[columnIndex];
          if(value === "" || value === null || value === undefined) return;
          value = String(value);
          if(seen[value]) return;
          seen[value] = true;
          result.push("TABLO_" + (tableIndex + 1) + " · " + (column.disaAktarilanAd || column.name) + ": " + value);
        });
      });
    });
    return result;
  }

  /* ================= çıktı ================= */

  function ciktiYaz(){
    if(!state.tablolar.length) return;
    var format = $("formatSelect").value;
    // Pasaportlar burada, yazım anındaki arayüz dilinde kurulur.
    state.tablolar.forEach(function(x, i){
      x.passport = TE.buildPassport(x.analiz, "TABLO_" + (i + 1));
    });
    var belirsiz = [];
    state.tablolar.forEach(function(t){
      t.analiz.columns.forEach(function(k){
        if(k.tarihBelirsiz || k.tespit.guvenEtiket === "düşük"){
          belirsiz.push((state.tablolar.length > 1 ? "TABLO_" + (state.tablolar.indexOf(t) + 1) + "." : "") + (k.disaAktarilanAd || k.name));
        }
      });
    });

    var prompt = TE.buildPrompt({
      tablolar: state.tablolar,
      iliskiler: state.iliskiler,
      gorev: $("taskSelect").value,
      format: format,
      noShowConfig: noShowConfigOku(),
      belirsizKolonlar: belirsiz
    });

    var t = aktifTablo();
    $("passportBox").value = state.tablolar.map(function(x){ return x.passport; }).join("\n\n");
    $("dummyBox").value = format === "sql"
      ? TE.toSQL(t.analiz, t.dummy, "TABLO_" + (state.aktif + 1))
      : TE.toCSV(t.dummy.headers, t.dummy.rows);
    $("promptBox").value = prompt;
    window.OutboundContexts = window.OutboundContexts || {};
    function outboundContext(tableIndexes, stats, realValues){
      var files = [], headers = [], realHeaders = [];
      tableIndexes.forEach(function(tableIndex){
        var table = state.tablolar[tableIndex];
        if(!table) return;
        files.push("TABLO_" + (tableIndex + 1));
        table.analiz.columns.forEach(function(column){
          var name = (state.tablolar.length > 1 ? "TABLO_" + (tableIndex + 1) + " · " : "") + (column.disaAktarilanAd || column.name);
          headers.push(name);
          if(column.karar && column.karar.mod === "gercek") realHeaders.push(name + " (gerçek değerler geçer)");
        });
      });
      return { synthetic:true, files:files, headers:headers.concat(realHeaders), stats:stats, realValues:realValues };
    }
    var allTableIndexes = state.tablolar.map(function(_, i){ return i; });
    var passportStats = ["satır ve kolon sayıları", "boşluk oranları", "benzersiz değer sayıları", "dağılım ve aralık özetleri", "zaman şekli", "tablolar arası ilişki önerileri"];
    var promptRealValues = outboundRealValues(state.tablolar, state.tablolar.map(function(_, i){ return i; }));
    var noShowConfig = noShowConfigOku();
    if($("taskSelect").value === "noshow" && noShowConfig.denominatorMode === "status"){
      String(noShowConfig.validStatuses || "").split(/[;,\n]/).map(function(value){ return value.trim(); }).filter(Boolean)
        .forEach(function(value){ promptRealValues.push("No-show kuralı · geçerli satış durumu: " + value); });
    }
    window.OutboundContexts.promptBox = outboundContext(allTableIndexes, passportStats, promptRealValues);
    window.OutboundContexts.passportBox = outboundContext(allTableIndexes, passportStats, []);
    window.OutboundContexts.dummyBox = outboundContext([state.aktif], [], outboundRealValues(state.tablolar, [state.aktif]));
    $("fileOutput").hidden = false;
    $("promptWrap").hidden = false;

    // P-02: Sentetik kalite ve gizlilik raporunu çiz. Önce hizalı örnekle
    // (anında), dosya daha büyükse ardından tamamıyla (worker'da) denetlenir.
    var audit = TE.auditSyntheticQuality(t.analiz, t.dummy);
    if(!audit) return;
    var taraniyor = !audit.privacy.tamami && audit.sampleSizes.originalTotal > 0;
    denetimKartiCiz(audit, taraniyor);
    if(taraniyor){
      var dummy = t.dummy;
      tamKopyaDenetimiIste(t, function(sonuc){
        if(t.dummy !== dummy || aktifTablo() !== t) return;   // bu arada yeni örnek üretildi
        if(!sonuc){ denetimKartiCiz(audit, false); return; }
        var oz = TE.kopyaDenetimiOzeti(sonuc.exactMatches, sonuc.nearMatches, sonuc.checkedRows, audit.sampleSizes.originalTotal);
        audit.privacy = { exactMatches: sonuc.exactMatches, nearMatches: sonuc.nearMatches,
                          checkedRows: sonuc.checkedRows, tamami: oz.tamami, risk: oz.risk, score: oz.score };
        denetimKartiCiz(audit, false);
      });
    }
  }

  var RISK_ETIKETI = { dusuk: "Düşük risk", orta: "Orta risk", yuksek: "Yüksek risk", yok: "Denetlenemedi" };

  function denetimKartiCiz(audit, taraniyor){
    var card = $("syntheticAuditCard");
    var grid = $("syntheticAuditGrid");
    var badge = $("syntheticAuditScoreBadge");
    var kapsamEl = $("syntheticAuditScope");
    if(!card || !grid || !badge) return;
    var p = audit.privacy;
    card.hidden = false;
    // Rozet kısa kalır; kapsam (tamamı mı, örnek mi) hemen altında tam cümleyle
    badge.textContent = RISK_ETIKETI[p.risk] || p.risk;
    badge.className = "synthetic-audit-badge" + (p.risk === "yuksek" || p.risk === "orta" ? " is-warning" : "") +
      (p.tamami ? "" : " is-partial");
    if(kapsamEl){
      kapsamEl.translate = false;   // motorun mt() cümlesi; dil değişince yeniden çizilir
      kapsamEl.textContent = p.score + (taraniyor ? " " + mt("Dosyanın tamamı taranıyor…") : "");
      kapsamEl.className = "synthetic-audit-scope" + (p.tamami ? " is-full" : " is-partial");
    }
    grid.replaceChildren();

    function addStat(label, val){
      var box = document.createElement("div");
      box.className = "synthetic-audit-stat";
      var s = document.createElement("span"); s.textContent = label;
      var b = document.createElement("strong"); b.textContent = val;
      box.append(s, b);
      grid.appendChild(box);
    }

    addStat("Kaynak Örnek / Sentetik", audit.sampleSizes.originalSampled + " / " + audit.sampleSizes.syntheticCount + " satır");
    addStat("Kopya Denetimi Kapsamı", p.checkedRows + " / " + audit.sampleSizes.originalTotal + " gerçek satır");
    addStat("Birebir Kopya Satır", p.exactMatches + " satır");
    addStat("Yakın Benzer Satır (≥%80)", p.nearMatches + " satır");
    var avgNullDelta = audit.nullDeltas.length
      ? Math.round(audit.nullDeltas.reduce(function(acc, d){ return acc + d.deltaPct; }, 0) / audit.nullDeltas.length)
      : 0;
    addStat("Ortalama Boşluk Farkı", "%" + avgNullDelta);
  }

  function ciktiTazele(){ if(!$("promptWrap").hidden){ ciktiYaz(); } }

  /* ================= olaylar ================= */

  $("sheetSelect").addEventListener("change", function(e){
    var t = aktifTablo();
    durum("Sayfa değiştiriliyor…");
    yenidenProfille(t, Number(e.target.value), null).then(function(){
      durumGizle(); iliskileriYenile(); hepsiniCiz(); ciktiTazele();
    });
  });

  $("headerRowSelect").addEventListener("change", function(e){
    var t = aktifTablo();
    durum("Başlık satırına göre yeniden profilleniyor…");
    yenidenProfille(t, t.aktifSheet, Number(e.target.value)).then(function(){
      durumGizle(); iliskileriYenile(); hepsiniCiz(); ciktiTazele();
    });
  });

  $("rowCountSelect").addEventListener("change", function(){ uret(); kolonlariCiz(); ciktiTazele(); });
  $("taskSelect").addEventListener("change", function(){ noShowAyarlariniCiz(); ciktiTazele(); });
  $("formatSelect").addEventListener("change", ciktiTazele);

  // Pasaport/prompt ve mt() ile kurulan kutular (gerekçe, kanun ve ilişki
  // uyarısı) dile duyarlıdır: dil değişince yeniden çizilir.
  if(window.MaskoDil){
    window.MaskoDil.degisince(function(){
      if(state.tablolar.length) hepsiniCiz();
      ciktiTazele();
    });
  }

  ["noShowSalesTable", "noShowSalesKey", "noShowSalesEvent", "noShowSalesStatus",
   "noShowScanTable", "noShowScanKey", "noShowScanEvent", "noShowOneEvent",
   "noShowDenominator", "noShowFilteredConfirm", "noShowSuccessfulScans"].forEach(function(id){
    $(id).addEventListener("change", function(){ noShowAyarlariniCiz(); ciktiTazele(); });
  });
  $("noShowValidStatuses").addEventListener("input", function(){ noShowAyarlariniCiz(); ciktiTazele(); });

  $("regenBtn").addEventListener("click", function(){
    state.seed++;
    uret(); kolonlariCiz(); ciktiTazele();
  });

  $("buildPromptBtn").addEventListener("click", function(){
    if(!state.tablolar.length) return;
    noShowAyarlariniCiz();
    ciktiYaz();
    $("promptWrap").scrollIntoView({ behavior:"smooth", block:"nearest" });
  });

  $("downloadDummy").addEventListener("click", function(){
    var t = aktifTablo();
    if(!t || !t.dummy) return;
    var sql = $("formatSelect").value === "sql";
    // İndirilen CSV Excel'de açılır: başlıklar ve "gerçek değer" kolonlarından
    // geçen hücreler formül olarak çalışmasın diye koruma açık.
    var icerik = "﻿" + (sql ? TE.toSQL(t.analiz, t.dummy, "TABLO_" + (state.aktif + 1))
                                 : TE.toCSV(t.dummy.headers, t.dummy.rows, ";", { safeFormula: true }));
    var blob = new Blob([icerik], { type: sql ? "text/plain;charset=utf-8" : "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = t.ad.replace(/\.[^.]+$/, "") + (sql ? "-sahte-ornek.sql" : "-sahte-ornek.csv");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  });

  // --- ASHIFY Seçmeli Dosya Maskeleme ve İndirme ---
  var btnModeSynthetic = $("btnModeSynthetic");
  var btnModeMaskFile = $("btnModeMaskFile");
  var fileMaskBar = $("fileMaskBar");
  var promptWrap = $("promptWrap");
  var fileControls = document.querySelector(".file-controls");

  if(btnModeSynthetic && btnModeMaskFile){
    btnModeSynthetic.addEventListener("click", function(){
      btnModeSynthetic.classList.add("is-active");
      btnModeMaskFile.classList.remove("is-active");
      if(fileMaskBar) fileMaskBar.hidden = true;
      if(fileControls) fileControls.style.display = "";
    });

    btnModeMaskFile.addEventListener("click", function(){
      btnModeMaskFile.classList.add("is-active");
      btnModeSynthetic.classList.remove("is-active");
      if(fileMaskBar) fileMaskBar.hidden = false;
      if(fileControls) fileControls.style.display = "none";
      if(promptWrap) promptWrap.hidden = true;
    });
  }

  function executeMaskDownload(format){
    var t = aktifTablo();
    if(!t) return;

    var auditEl = $("fileMaskAudit");
    if(auditEl){
      auditEl.hidden = false;
      auditEl.textContent = "⏳ Dosya güvenle maskeleniyor...";
    }

    var rules = {};
    t.analiz.columns.forEach(function(kol){
      var act = "keep";
      if(kol.karar.mod === "uret") act = "synthetic";
      else if(kol.karar.mod === "asterisk") act = "asterisk";
      else if(kol.karar.mod === "token") act = "token";
      else if(kol.karar.mod === "hash") act = "hash";
      else if(kol.karar.mod === "generalize_date") act = "generalize_date";
      else if(kol.karar.mod === "generalize_age") act = "generalize_age";
      else if(kol.karar.mod === "generalize_numeric") act = "generalize_numeric";
      else if(kol.karar.mod === "clear") act = "clear";
      else if(kol.karar.mod === "gercek") act = "keep";

      var kural = { action: act, typeId: kol.tespit.typeId };
      if(act === "hash") kural.salt = hashAnahtari();
      // Kolon düzeyinde çıkarılan sayı biçimi: "45.000" TR'de 45 bindir
      if(act === "generalize_numeric" && kol.sayiBicimi) kural.numberFormat = kol.sayiBicimi;
      rules[kol.name] = kural;
    });

    // Motor satırları dizi olarak alır; başlık satırı ve benzersizleştirilmiş
    // kolon adları analizden gelir ki kurallar doğru sütuna otursun.
    // Formül koruması yalnız CSV'de: SheetJS aoa_to_sheet metni daima metin
    // hücresi (t:'s') yazar, formül olarak çalıştırmaz; XLSX'te baştaki '
    // kullanıcıya görünen bir bozulma olurdu.
    var maskeSecenekleri = {
      safeFormulas: format === "csv",
      headerRowIdx: t.analiz.headerRowIdx,
      headers: t.analiz.columns.map(function(kol){ return kol.name; })
    };

    function maskeHatasi(mesaj){
      if(auditEl) auditEl.textContent = "Hata: " + mesaj + " Dosya indirilmedi.";
    }

    function saveMasked(res){
      var maskedRows = res.maskedRows || [];
      var stats = res.stats;
      var baseName = (t.ad || "tablo").replace(/\.[^.]+$/, "");
      var headers = res.headers || Object.keys(maskedRows[0] || {});
      var dataRows = maskedRows.map(function(r){
        return Array.isArray(r) ? r : headers.map(function(h){ return r[h]; });
      });
      if(format === "csv"){
        // Motor zaten korudu; tekrar uygulamak zararsızdır (' ile başlayan
        // hücre yeniden işaretlenmez) ve motoru atlayan bir yol kalmasın diye.
        var csvText = TE.toCSV(headers, dataRows, ";", { safeFormula: true });
        var blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = baseName + "_maskelenmis.csv";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
      } else if(typeof XLSX !== "undefined"){
        // aoa_to_sheet kolon sırasını korur; json_to_sheet "2024" gibi sayısal
        // başlıkları nesne anahtarı sırasına göre öne alırdı.
        var ws = XLSX.utils.aoa_to_sheet([headers].concat(dataRows));
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Maskelenmis");
        XLSX.writeFile(wb, baseName + "_maskelenmis.xlsx", { compression: true });
      }

      if(auditEl){
        auditEl.textContent = "✓ Tamamlandı: " + stats.totalRows.toLocaleString("tr-TR") +
          " satır ve " + stats.transformedCells.toLocaleString("tr-TR") + " hücre başarıyla maskelendi.";
      }
    }

    if(t.workerId && worker && !workerBozuk){
      bekleyen[t.workerId] = {
        tablo: t,
        resolveMask: saveMasked,
        hataMask: maskeHatasi
      };
      worker.postMessage({
        tip: "maskele",
        id: t.workerId,
        sheetIndex: t.aktifSheet,
        rules: rules,
        safeFormulas: maskeSecenekleri.safeFormulas,
        headerRowIdx: maskeSecenekleri.headerRowIdx,
        headers: maskeSecenekleri.headers
      });
      return;
    }

    if(t.rows && window.FileMaskEngine){
      var res;
      try{ res = window.FileMaskEngine.maskEntireTable(t.rows, rules, maskeSecenekleri); }
      catch(err){ maskeHatasi(err && err.message ? err.message : String(err)); return; }
      saveMasked(res);
    } else {
      if(auditEl) auditEl.textContent = "Hata: Dosya satırları okunamadı.";
    }
  }

  var btnExecuteMaskExcel = $("btnExecuteMaskExcel");
  var btnExecuteMaskCsv = $("btnExecuteMaskCsv");
  if(btnExecuteMaskExcel) btnExecuteMaskExcel.addEventListener("click", function(){ executeMaskDownload("xlsx"); });
  if(btnExecuteMaskCsv) btnExecuteMaskCsv.addEventListener("click", function(){ executeMaskDownload("csv"); });
})();
