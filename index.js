(async function(){
  "use strict";

  function showStorageError(error){
    var status = document.getElementById("ocrStatus");
    status.hidden = false;
    status.setAttribute("role", "alert");
    status.textContent = error.message || "Sözlüğe erişilemedi.";
  }
  MaskEngine.onError = showStorageError;
  try{ await MaskEngine.init(); }catch(error){ showStorageError(error); return; }

  var TYPE_LABELS = MaskEngine.TYPE_LABELS;
  var CONFIDENCE = MaskEngine.CONFIDENCE;

  var STOPLIST = ["select","from","where","insert","into","values","update","set","delete","join","inner","left","right","outer",
    "group","order","by","as","and","or","not","null","true","false","limit","offset","having","union","distinct","create",
    "table","alter","drop","primary","key","foreign","references","index","view","exists","case","when","then","end",
    "def","return","import","class","if","elif","else","for","while","try","except","finally","with","pass","break","continue",
    "lambda","print","self","none","yield","raise","global","nonlocal","assert","async","await",
    "function","var","let","const","console","log","public","private","protected","static","void","new","this","export",
    "default","require","module","exports","interface","extends","implements","typeof","instanceof",
    "int","str","float","bool","list","dict","set","tuple","string","number","boolean","object","array","char","long","double",
    "true","false","none","null","undefined","nan","df","pd","np","plt","sns","os","sys","re","json","math"];
  var STOPSET = {};
  STOPLIST.forEach(function(w){ STOPSET[w] = true; });

  function enabledDetectors(){
    var map = {};
    document.querySelectorAll("[data-detect]").forEach(function(cb){
      map[cb.getAttribute("data-detect")] = cb.checked;
    });
    map.jwt = !!map.secret;
    return map;
  }

  // Simgeli düğmelerde geçici mesaj yalnız etikete yazılır; simge silinmesin.
  function dugmeEtiketi(btn){ return btn.querySelector(".dugme-etiket") || btn; }

  function copyToClipboard(text, btn){
    MaskEngine.copyToClipboard(text, function(){
      if(!btn) return;
      var etiket = dugmeEtiketi(btn);
      var original = etiket.textContent;
      etiket.textContent = "Kopyalandı";
      setTimeout(function(){ etiket.textContent = original; }, 1200);
    });
  }

  function renderGlossary(){
    var glossary = MaskEngine.getGlossary();
    var body = document.getElementById("glossaryBody");
    body.innerHTML = "";
    if(glossary.length === 0){
      var tr = document.createElement("tr");
      tr.className = "empty-row";
      tr.innerHTML = '<td colspan="5">Henüz kayıt yok — metni maskeleyin veya manuel terim ekleyin.</td>';
      body.appendChild(tr);
    } else {
      glossary.forEach(function(entry){
        var row = document.createElement("tr");

        // Gerçek değer ve yer tutucu veridir; arayüz dili değişince çevrilmez
        var tdReal = document.createElement("td");
        tdReal.setAttribute("translate", "no");
        tdReal.textContent = entry.real;
        row.appendChild(tdReal);

        var tdPlaceholder = document.createElement("td");
        tdPlaceholder.setAttribute("translate", "no");
        tdPlaceholder.textContent = entry.placeholder;
        row.appendChild(tdPlaceholder);

        var tdType = document.createElement("td");
        var tag = document.createElement("span");
        tag.className = "type-tag";
        tag.textContent = TYPE_LABELS[entry.type] || entry.type;
        tdType.appendChild(tag);
        row.appendChild(tdType);

        var tdConf = document.createElement("td");
        tdConf.appendChild(MaskEngine.confBadge(entry.type, entry.dogrulanmadi));
        row.appendChild(tdConf);

        var tdDel = document.createElement("td");
        var actions = document.createElement("div");
        actions.className = "row-actions";

        var delBtn = document.createElement("button");
        delBtn.className = "row-del";
        delBtn.type = "button";
        delBtn.textContent = "Sil";
        delBtn.title = "Listeden kaldır — tekrar Maskele'ye basarsanız otomatik tespit edilen değerler yeniden görünebilir.";
        delBtn.addEventListener("click", async function(){
          await MaskEngine.deleteEntry(entry.id);
          renderGlossary();
        });
        actions.appendChild(delBtn);

        var exBtn = document.createElement("button");
        exBtn.className = "row-exclude";
        exBtn.type = "button";
        exBtn.textContent = "Hariç tut";
        exBtn.title = "Bu değeri kalıcı olarak hariç tut — bir daha otomatik maskelenmez.";
        exBtn.addEventListener("click", function(){
          excludeEntry(entry);
        });
        actions.appendChild(exBtn);

        tdDel.appendChild(actions);
        row.appendChild(tdDel);

        body.appendChild(row);
      });
    }
    document.getElementById("glossaryCount").textContent = glossary.length + " kayıt";
  }

  function renderWorkspaces(){
    if(!MaskEngine.getWorkspaces) return;
    var info = MaskEngine.getWorkspaces();
    var select = document.getElementById("workspaceSelect");
    select.innerHTML = "";
    info.items.forEach(function(item){
      var option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name + " (" + item.entryCount + ")";
      option.selected = item.id === info.activeId;
      select.appendChild(option);
    });
    var active = info.items.find(function(item){ return item.id === info.activeId; });
    if(active) document.getElementById("workspaceRetention").value = String(active.retentionDays || 0);
    document.getElementById("deleteWorkspace").disabled = info.items.length < 2;
  }

  function renderExcluded(){
    var excluded = MaskEngine.getExcluded();
    var wrap = document.getElementById("excludedWrap");
    var list = document.getElementById("excludedList");
    list.innerHTML = "";
    if(excluded.length === 0){
      wrap.hidden = true;
      return;
    }
    excluded.forEach(function(item){
      var row = document.createElement("div");
      row.className = "excluded-item";
      var label = document.createElement("span");
      label.className = "ex-real";
      label.textContent = item.value + " (" + (TYPE_LABELS[item.type] || item.type) + ")";
      row.appendChild(label);
      var undoBtn = document.createElement("button");
      undoBtn.type = "button";
      undoBtn.textContent = "Geri al";
      undoBtn.addEventListener("click", async function(){
        await MaskEngine.unexcludeEntry(item);
        renderExcluded();
      });
      row.appendChild(undoBtn);
      list.appendChild(row);
    });
    wrap.hidden = false;
  }

  async function runMaskAndRender(text){
    var masked = await MaskEngine.maskText(text, enabledDetectors());
    renderGlossary();
    return masked;
  }

  async function excludeEntry(entry){
    await MaskEngine.excludeEntryById(entry.id);
    await yenidenMaskele();
  }

  var GUVEN_ADI = { high:"yüksek güven", medium:"orta güven", low:"düşük güven" };
  var TUR_ADLARI = { tckn:"TC Kimlik No", ykn:"Yabancı Kimlik No", vkn:"Vergi Kimlik No", iban:"IBAN",
    ssn:"SSN", imei:"IMEI", ip:"IP adresi", mac:"MAC adresi", uuid:"UUID", jwt:"JWT", kep:"KEP adresi" };
  function turAdi(type){
    if(TUR_ADLARI[type]) return TUR_ADLARI[type];
    var ad = TYPE_LABELS[type] || type;
    return ad.charAt(0).toLocaleUpperCase("tr-TR") + ad.slice(1);
  }

  /* Denetim defterinde gerçek değer omuz üstünden okunmasın: baştan ve sondan
     birkaç karakter kalır, gerisi • olur. Boşluk ve noktalama korunur ki
     biçim (IBAN grupları, tarih) tanınsın; e-postada alan adı açık kalır. */
  function kismenGizle(deger){
    var at = deger.indexOf("@");
    if(at > 0) return deger.charAt(0) + "•".repeat(at - 1) + deger.slice(at);
    var harf = /[\p{L}\p{N}]/u;
    var toplam = 0;
    for(var ch of deger){ if(harf.test(ch)) toplam++; }
    var bas = toplam >= 8 ? 3 : (toplam >= 4 ? 1 : 0);
    var son = toplam >= 6 ? 2 : 0;
    var sira = 0, sonuc = "";
    for(var c of deger){
      if(!harf.test(c)){ sonuc += c; continue; }
      sira++;
      sonuc += (sira <= bas || sira > toplam - son) ? c : "•";
    }
    return sonuc;
  }

  function regexKacir(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  /* Metni kutuya yazar, ogeler içindeki değerleri <mark> yapar. Uzun değer önce
     denenir ki biri ötekinin parçasıysa bütünü işaretlensin. genelEtiket:
     sözlükte olmayan [TUR_N] biçimli etiketler de mühür gibi gösterilir. */
  function vurguluYaz(kutu, metin, ogeler, genelEtiket){
    kutu.textContent = "";
    var harita = {};
    var desenler = [];
    ogeler.slice().sort(function(a, b){ return b.metin.length - a.metin.length; }).forEach(function(o){
      if(!o.metin || harita[o.metin]) return;
      harita[o.metin] = o;
      desenler.push(regexKacir(o.metin));
    });
    if(genelEtiket) desenler.push("\\[[A-Z]+_\\d+\\]");
    if(desenler.length === 0){ kutu.textContent = metin; return; }
    var re = new RegExp(desenler.join("|"), "g");
    var parca = document.createDocumentFragment();
    var son = 0, m;
    while((m = re.exec(metin))){
      if(m.index > son) parca.appendChild(document.createTextNode(metin.slice(son, m.index)));
      var oge = harita[m[0]] || { sinif:"muhur" };
      var mark = document.createElement("mark");
      mark.className = oge.sinif;
      mark.textContent = m[0];
      if(oge.hazirla) oge.hazirla(mark);
      parca.appendChild(mark);
      son = re.lastIndex;
    }
    if(son < metin.length) parca.appendChild(document.createTextNode(metin.slice(son)));
    kutu.appendChild(parca);
  }

  // Çıktıda placeholder'ı geçen sözlük kayıtları, çıktıdaki sırayla.
  function ciktidakiKayitlar(maskedText){
    if(!maskedText) return [];
    return MaskEngine.getGlossary()
      .filter(function(g){ return g.placeholder && maskedText.indexOf(g.placeholder) !== -1; })
      .sort(function(a, b){ return maskedText.indexOf(a.placeholder) - maskedText.indexOf(b.placeholder); });
  }

  /* Kişi adı ve adres adayları otomatik maskelenmez. Yalnız maskeli çıktıda
     hâlâ açıkta duranlar "Gözden geçir"e girer; zaten maskelenmiş bir satırı
     (ör. "TC Kimlik No: …") aday diye göstermek gürültü olur. */
  var yoksayilanAdaylar = {};
  function acikAdaylar(maskedText){
    if(!maskedText) return [];
    var liste = [];
    (lastScan.people || []).forEach(function(v){ liste.push({ deger:v, type:"name" }); });
    (lastScan.addresses || []).forEach(function(v){ liste.push({ deger:v, type:"address" }); });
    return liste.filter(function(a){
      return !yoksayilanAdaylar[a.deger] && !MaskEngine.alreadyInGlossary(a.deger) &&
        maskedText.indexOf(a.deger) !== -1;
    });
  }

  function renderCikti(maskedText, kayitlar, adaylar){
    var kutu = document.getElementById("maskOutputView");
    var ogeler = kayitlar.map(function(entry){
      return { metin: entry.placeholder, sinif: "muhur", hazirla: function(mark){
        // Yanlış maskelenen bir yeri düzeltmek için sözlükte aramak gerekmesin:
        // mührün kendisi bir düğme.
        mark.classList.add("is-clickable");
        mark.setAttribute("role", "button");
        mark.setAttribute("tabindex", "0");
        mark.title = "“" + entry.real + "” (" + turAdi(entry.type) + ", " +
          GUVEN_ADI[entry.dogrulanmadi ? "low" : (CONFIDENCE[entry.type] || "medium")] + ")" +
          "\nTıklayın: maskeyi kaldırın";
        function tiklandi(ev){ ev.preventDefault(); maskeyiKaldir(entry); }
        mark.addEventListener("click", tiklandi);
        mark.addEventListener("keydown", function(ev){
          if(ev.key === "Enter" || ev.key === " "){ tiklandi(ev); }
        });
      }};
    }).concat(adaylar.map(function(a){
      return { metin: a.deger, sinif: "aday", hazirla: function(mark){
        mark.title = "Maskelenmedi — aşağıdaki denetim defterinden gözden geçirin";
      }};
    }));
    // Görünüm boşken de yerinde kalır: kutunun yüksekliğini o verir.
    vurguluYaz(kutu, maskedText, ogeler, true);
    document.getElementById("ciktiBos").hidden = !!maskedText;
    document.getElementById("ciktiSekme").classList.toggle("is-dolu", !!maskedText);
    document.getElementById("maskCopy").disabled = !maskedText;
  }

  function denetimHucresi(tr, metin, sinif){
    var td = document.createElement("td");
    if(sinif) td.className = sinif;
    if(sinif && /\bdeger\b/.test(sinif)) td.setAttribute("translate", "no");   // gerçek değer: çevrilmez
    td.textContent = metin;
    tr.appendChild(td);
    return td;
  }

  function renderDenetim(kayitlar, adaylar){
    var body = document.getElementById("denetimBody");
    body.textContent = "";

    adaylar.forEach(function(a){
      var tr = document.createElement("tr");
      tr.className = "aday-satir";
      denetimHucresi(tr, turAdi(a.type) + " (aday)", "tur");
      denetimHucresi(tr, a.deger, "deger");
      denetimHucresi(tr, "Maskelenmedi", "soluk");
      var td = document.createElement("td");
      var durum = document.createElement("div");
      durum.className = "durum";
      var etiket = document.createElement("span");
      etiket.className = "durum-etiket";
      etiket.textContent = "Gözden geçir";
      var maskBtn = document.createElement("button");
      maskBtn.type = "button";
      maskBtn.className = "kucuk-maskele";
      maskBtn.textContent = "Maskele";
      maskBtn.addEventListener("click", function(){ addSuggestionAsTerm(a.deger, a.type); });
      var yokBtn = document.createElement("button");
      yokBtn.type = "button";
      yokBtn.className = "kucuk-ikincil";
      yokBtn.textContent = "Yok say";
      yokBtn.title = "Bu oturumda bir daha önerme";
      yokBtn.addEventListener("click", function(){
        yoksayilanAdaylar[a.deger] = true;
        incele(document.getElementById("maskOutput").value);
      });
      durum.appendChild(etiket);
      durum.appendChild(maskBtn);
      durum.appendChild(yokBtn);
      td.appendChild(durum);
      tr.appendChild(td);
      body.appendChild(tr);
    });

    kayitlar.forEach(function(entry){
      var tr = document.createElement("tr");
      denetimHucresi(tr, turAdi(entry.type), "tur");
      denetimHucresi(tr, kismenGizle(entry.real), "deger soluk");
      var tdMuhur = document.createElement("td");
      var muhur = document.createElement("span");
      muhur.className = "muhur";
      muhur.setAttribute("translate", "no");
      muhur.textContent = entry.placeholder;
      tdMuhur.appendChild(muhur);
      tr.appendChild(tdMuhur);
      var td = document.createElement("td");
      var durum = document.createElement("div");
      durum.className = "durum";
      var yazi = document.createElement("span");
      yazi.className = "soluk";
      yazi.textContent = "Maskelendi";
      var kaldirBtn = document.createElement("button");
      kaldirBtn.type = "button";
      kaldirBtn.className = "kaldir-dugme";
      kaldirBtn.textContent = "Kaldır";
      kaldirBtn.title = "Bu değer maskelenmesin";
      kaldirBtn.addEventListener("click", function(){ maskeyiKaldir(entry); });
      durum.appendChild(yazi);
      durum.appendChild(kaldirBtn);
      td.appendChild(durum);
      tr.appendChild(td);
      body.appendChild(tr);
    });

    document.getElementById("denetimPanel").hidden = kayitlar.length + adaylar.length === 0;
  }

  function sayaclariYaz(maskeSayisi, adaySayisi){
    var m = document.getElementById("sayacMaske");
    var a = document.getElementById("sayacAday");
    m.textContent = maskeSayisi;
    a.textContent = adaySayisi;
    m.classList.toggle("is-var", maskeSayisi > 0);
    a.classList.toggle("is-var", adaySayisi > 0);
  }

  /* Orijinal kutusundaki boyama. Textarea'nın arkasındaki katman aynı yazı
     tipi, satır yüksekliği ve kaydırma çubuğu boşluğunu kullanır; yalnız
     işaretlerin zemini görünür, metni textarea'nın kendisi çizer. */
  var girdiAlan = document.getElementById("maskInput");
  var girdiVurgu = document.getElementById("girdiVurgu");
  var vurguKaynak = { kayitlar: [], adaylar: [] };
  function renderGirdiVurgu(){
    var metin = girdiAlan.value;
    var ogeler = vurguKaynak.kayitlar.map(function(e){ return { metin: e.real, sinif: "gizlenecek" }; })
      .concat(vurguKaynak.adaylar.map(function(a){ return { metin: a.deger, sinif: "aday" }; }));
    vurguluYaz(girdiVurgu, metin, ogeler, false);
    // Sondaki satır sonu textarea'da yeni bir satır açar; katman da açsın.
    if(metin === "" || metin.charAt(metin.length - 1) === "\n") girdiVurgu.appendChild(document.createTextNode(" "));
    girdiVurgu.scrollTop = girdiAlan.scrollTop;
    girdiVurgu.scrollLeft = girdiAlan.scrollLeft;
  }
  var vurguZamani = null;
  function vurguPlanla(){
    clearTimeout(vurguZamani);
    vurguZamani = setTimeout(renderGirdiVurgu, 120);
  }
  girdiAlan.addEventListener("scroll", function(){
    girdiVurgu.scrollTop = girdiAlan.scrollTop;
    girdiVurgu.scrollLeft = girdiAlan.scrollLeft;
  });

  // Çıktı, denetim defteri, sayaçlar ve orijinaldeki boyama: hepsi aynı veriden.
  function incele(maskedText){
    var kayitlar = ciktidakiKayitlar(maskedText);
    var adaylar = acikAdaylar(maskedText);
    renderCikti(maskedText, kayitlar, adaylar);
    renderDenetim(kayitlar, adaylar);
    sayaclariYaz(kayitlar.length, adaylar.length);
    vurguKaynak = { kayitlar: kayitlar, adaylar: adaylar };
    renderGirdiVurgu();
  }

  /* Çıktı girdiyle eşleşiyorsa ana eylem "Kontrol et ve kopyala"dır; Maskele
     ikincil "Yeniden maskele" olur. Girdi ya da türler değişince yeniden
     birincil olur ki eski çıktı kopyalanmasın diye kullanıcı uyarılmış olsun. */
  function maskeleDurumu(guncel){
    var btn = document.getElementById("runMask");
    btn.classList.toggle("is-guncel", guncel);
    dugmeEtiketi(btn).textContent = guncel ? "Yeniden maskele" : "Maskele";
  }

  function girdiDurumu(){
    var bos = girdiAlan.value === "";
    var anlamli = girdiAlan.value.trim() !== "";
    document.getElementById("girdiBos").hidden = !bos;
    document.getElementById("runMask").disabled = !anlamli;
    document.getElementById("runScan").disabled = !anlamli;
    document.getElementById("addSelection").disabled = !anlamli;
  }

  /* Bir placeholder'a tıklandığında maskeyi kaldır.
     Elle eklenen terimlerde sözlükten silmek yeter. Otomatik tespit edilen
     tiplerde ise silmek yetmez — bir sonraki maskelemede yeniden bulunur;
     bu yüzden hariç tutulanlar listesine alınır. */
  async function maskeyiKaldir(entry){
    var elleEklenen = MaskEngine.TEXT_REPLACE_TYPES.indexOf(entry.type) !== -1;
    var kopya = { id: entry.id, real: entry.real, placeholder: entry.placeholder, type: entry.type };

    if(elleEklenen){ await MaskEngine.deleteEntry(entry.id); }
    else { await MaskEngine.excludeEntryById(entry.id); }

    sonGeriAlma = { entry: kopya, hariçTutuldu: !elleEklenen };
    geriAlmaGoster(kopya);
    await yenidenMaskele();
  }

  var sonGeriAlma = null;

  function geriAlmaGoster(entry){
    var bar = document.getElementById("undoBar");
    document.getElementById("undoText").textContent =
      "“" + entry.real + "” artık maskelenmiyor.";
    bar.hidden = false;
    clearTimeout(geriAlmaGoster._t);
    geriAlmaGoster._t = setTimeout(function(){ bar.hidden = true; }, 12000);
  }

  document.getElementById("undoBtn").addEventListener("click", async function(){
    if(!sonGeriAlma) return;
    if(sonGeriAlma.hariçTutuldu){
      await MaskEngine.unexcludeEntry({ type: sonGeriAlma.entry.type, value: sonGeriAlma.entry.real });
    }
    await MaskEngine.restoreEntry(sonGeriAlma.entry);
    sonGeriAlma = null;
    document.getElementById("undoBar").hidden = true;
    await yenidenMaskele();
  });

  // Sözlük, hariç tutulanlar ve çıktı — hepsini tazele
  async function yenidenMaskele(){
    renderGlossary();
    renderExcluded();
    var girdi = document.getElementById("maskInput").value;
    if(!girdi) return;
    var masked = await runMaskAndRender(girdi);
    document.getElementById("maskOutput").value = masked;
    refreshReview(masked);
  }

  // Maskelemeden hemen sonra çağrılır: adaylar güncel girdiden yeniden çıkarılır.
  function refreshReview(maskedText){
    lastScan = scanCandidates(girdiAlan.value);
    if(!document.getElementById("suggestions").hidden) renderSuggestions(lastScan);
    maskeleDurumu(!!maskedText);
    incele(maskedText);
  }

  function isIdentifierCandidate(token){
    var lower = token.toLowerCase();
    if(STOPSET[lower]) return false;
    if(token.length < 3) return false;
    if(/^\d+$/.test(token)) return false;
    var hasUnderscore = token.indexOf("_") !== -1;
    var hasCamel = /[a-z][A-Z]/.test(token);
    return hasUnderscore || hasCamel;
  }

  function scanCandidates(text){
    var idCounts = {};
    var wordRe = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    var m;
    while((m = wordRe.exec(text))){
      var tok = m[0];
      if(isIdentifierCandidate(tok)){
        idCounts[tok] = (idCounts[tok] || 0) + 1;
      }
    }
    var dotRe = /\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/g;
    while((m = dotRe.exec(text))){
      idCounts[m[0]] = (idCounts[m[0]] || 0) + 1;
    }
    var identifiers = Object.keys(idCounts).sort(function(a,b){ return idCounts[b] - idCounts[a]; }).slice(0,40);

    var litSet = {};
    var litRe = /"([^"\n]{2,60})"|'([^'\n]{2,60})'/g;
    while((m = litRe.exec(text))){
      var val = m[1] !== undefined ? m[1] : m[2];
      if(val && val.trim()) litSet[val] = true;
    }
    var literals = Object.keys(litSet).slice(0,40);

    var personSet = {};
    var personRe = /(?:ad[ \t]*soyad|müşteri|musteri|çalışan|calisan|personel|hasta|sayın|sayin|sn\.?)[ \t:,-]+([A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:[ \t]+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+){1,3})/gi;
    while((m = personRe.exec(text))){
      // /i bayrağı ad kısmındaki büyük harf koşulunu da gevşetiyor ("Ahmet
      // Yılmaz için ödeme" yakalanıyordu); ad, ilk küçük harfli sözcükte biter.
      var ad = [];
      var sozcukler = m[1].trim().split(/[ \t]+/);
      for(var s = 0; s < sozcukler.length && /^[A-ZÇĞİÖŞÜ]/.test(sozcukler[s]); s++) ad.push(sozcukler[s]);
      if(ad.length >= 2) personSet[ad.join(" ")] = true;
    }

    var addressSet = {};
    text.split(/\r?\n/).forEach(function(line){
      if(/\b(?:adres|mahallesi|mah\.?|sokak|sok\.?|caddesi|cad\.?|bulvarı|bulvari|apt\.?|apartmanı|apartmani|daire|no\s*:?)\b/i.test(line)){
        var value = line.replace(/^\s*(?:[-*]\s*)?(?:adres\s*[:=-]?\s*)?/i, "").trim();
        if(value.length >= 8 && value.length <= 180) addressSet[value] = true;
      }
    });

    return { identifiers: identifiers, literals: literals,
      people:Object.keys(personSet).slice(0,30), addresses:Object.keys(addressSet).slice(0,30) };
  }

  async function addSuggestionAsTerm(value, type){
    if(!await MaskEngine.addTerm(value, type)) return;
    renderGlossary();
    var currentInput = document.getElementById("maskInput").value;
    if(currentInput){
      var masked = await runMaskAndRender(currentInput);
      document.getElementById("maskOutput").value = masked;
      refreshReview(masked);
    }
    renderSuggestions(lastScan);
  }

  var lastScan = { identifiers: [], literals: [], people:[], addresses:[] };

  // Kod ve metin adayları. Kişi adı ve adres adayları denetim defterindedir.
  function renderSuggestions(result){
    lastScan = result;
    var idWrap = document.getElementById("identifierChips");
    var litWrap = document.getElementById("literalChips");
    idWrap.innerHTML = "";
    litWrap.innerHTML = "";

    var remainingIds = result.identifiers.filter(function(v){ return !MaskEngine.alreadyInGlossary(v); });
    var remainingLits = result.literals.filter(function(v){ return !MaskEngine.alreadyInGlossary(v); });

    if(remainingIds.length === 0){
      var e1 = document.createElement("span");
      e1.className = "suggest-empty";
      e1.textContent = "Yeni tanımlayıcı bulunamadı.";
      idWrap.appendChild(e1);
    } else {
      remainingIds.forEach(function(val){
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "suggest-chip";
        chip.textContent = val;
        chip.addEventListener("click", function(){ addSuggestionAsTerm(val, "code"); });
        idWrap.appendChild(chip);
      });
    }

    if(remainingLits.length === 0){
      var e2 = document.createElement("span");
      e2.className = "suggest-empty";
      e2.textContent = "Yeni metin değeri bulunamadı.";
      litWrap.appendChild(e2);
    } else {
      remainingLits.forEach(function(val){
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "suggest-chip";
        chip.textContent = val;
        chip.addEventListener("click", function(){ addSuggestionAsTerm(val, "literal"); });
        litWrap.appendChild(chip);
      });
    }
  }

  function saveInputDraft(){
    try{ window.sessionStorage.setItem("maskeleme_istasyonu_sozluk_v1_draft", document.getElementById("maskInput").value); }catch(e){}
  }
  document.getElementById("maskInput").addEventListener("input", saveInputDraft);

  /* Girdi değişince çıktı eskir. Girdi tamamen silinirse çıktı da temizlenir:
     boş bir orijinalin yanında eski bir maskeli metin kopyalanabilir kalmasın. */
  girdiAlan.addEventListener("input", function(){
    girdiDurumu();
    maskeleDurumu(false);
    if(girdiAlan.value.trim() === "" && document.getElementById("maskOutput").value){
      document.getElementById("maskOutput").value = "";
      lastScan = { identifiers: [], literals: [], people: [], addresses: [] };
      incele("");
    }
    vurguPlanla();
  });

  document.getElementById("runScan").addEventListener("click", function(){
    lastScan = scanCandidates(girdiAlan.value);
    renderSuggestions(lastScan);
    incele(document.getElementById("maskOutput").value);
    var panel = document.getElementById("suggestions");
    panel.hidden = false;
    var azHareket = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView({ behavior: azHareket ? "auto" : "smooth", block: "nearest" });
  });

  MaskEngine.wireOcrPaste(document.getElementById("maskInput"), document.getElementById("ocrStatus"));

  document.getElementById("addSelection").addEventListener("click", async function(){
    var input = document.getElementById("maskInput");
    var selected = input.value.slice(input.selectionStart, input.selectionEnd).trim();
    var etiket = dugmeEtiketi(document.getElementById("addSelection"));
    if(!selected){
      var original = etiket.textContent;
      etiket.textContent = "Önce metinde bir yer seçin";
      setTimeout(function(){ etiket.textContent = original; }, 1500);
      return;
    }
    await addSuggestionAsTerm(selected, "secim");
    var confirmText = etiket.textContent;
    etiket.textContent = "Eklendi ✓";
    setTimeout(function(){ etiket.textContent = confirmText; }, 1200);
  });


  /* ---------- M-11: GÖRSEL KARARTMA MODAL MANTIĞI ---------- */
  var redactModal = document.getElementById("redactModal");
  var openRedactBtn = document.getElementById("openRedactModal");
  var closeRedactBtn = document.getElementById("redactClose");
  var redactImageInput = document.getElementById("redactImageInput");
  var redactClearBtn = document.getElementById("redactClearBtn");
  var redactStyleSelect = document.getElementById("redactStyleSelect");
  var redactApplyBtn = document.getElementById("redactApplyBtn");
  var redactDownloadBtn = document.getElementById("redactDownloadBtn");
  var redactCanvas = document.getElementById("redactCanvas");
  var redactPlaceholderMsg = document.getElementById("redactPlaceholderMsg");
  var redactOcrOutput = document.getElementById("redactOcrOutput");
  var redactOcrText = document.getElementById("redactOcrText");
  var redactOcrCopyBtn = document.getElementById("redactOcrCopyBtn");
  var redactBoxList = document.getElementById("redactBoxList");
  var redactBoxCount = document.getElementById("redactBoxCount");
  var redactStatus = document.getElementById("redactStatus");

  var currentRedactImage = null;
  var currentRedactBoxes = [];
  var redactImageRequestId = 0;
  var nextManualRedactLabel = 1;

  function showRedactStatus(text, isError){
    if(!redactStatus) return;
    redactStatus.textContent = text;
    redactStatus.hidden = !text;
    redactStatus.style.background = isError ? "var(--mask-soft)" : "var(--warn-soft)";
    redactStatus.style.color = isError ? "var(--mask-ink)" : "var(--warn-ink)";
  }

  function openRedact(imageSource){
    if(!redactModal) return;
    redactModal.hidden = false;
    if(imageSource){
      loadImageForRedaction(imageSource);
    }
  }

  function closeRedact(){
    if(!redactModal) return;
    redactModal.hidden = true;
  }

  if(openRedactBtn){
    openRedactBtn.addEventListener("click", function(){ openRedact(); });
  }
  if(closeRedactBtn){
    closeRedactBtn.addEventListener("click", closeRedact);
  }
  if(redactModal){
    redactModal.addEventListener("click", function(e){
      if(e.target === redactModal) closeRedact();
    });
  }
  document.addEventListener("keydown", function(e){
    if(e.key === "Escape" && redactModal && !redactModal.hidden){
      closeRedact();
    }
  });

  var isDrawingManualBox = false;
  var manualBoxStart = null;
  var currentDragBox = null;

  function renderRedactCanvas(showOverlay, dragBox){
    if(!currentRedactImage || !redactCanvas) return;
    var ctx = redactCanvas.getContext("2d", { willReadFrequently: true });
    redactCanvas.width = currentRedactImage.naturalWidth || currentRedactImage.width;
    redactCanvas.height = currentRedactImage.naturalHeight || currentRedactImage.height;
    ctx.drawImage(currentRedactImage, 0, 0);

    if(showOverlay){
      currentRedactBoxes.forEach(function(b){
        if(b.enabled === false) return;
        ctx.save();
        ctx.strokeStyle = b.type === "manuel" ? "#2563eb" : "#e11d48";
        ctx.lineWidth = Math.max(2, Math.round(redactCanvas.width / 400));
        ctx.strokeRect(b.x0, b.y0, b.width, b.height);
        ctx.fillStyle = b.type === "manuel" ? "rgba(37, 99, 235, 0.2)" : "rgba(225, 29, 72, 0.2)";
        ctx.fillRect(b.x0, b.y0, b.width, b.height);
        ctx.restore();
      });
    }

    if(dragBox){
      ctx.save();
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = Math.max(2, Math.round(redactCanvas.width / 350));
      if(ctx.setLineDash) ctx.setLineDash([6, 4]);
      ctx.strokeRect(dragBox.x0, dragBox.y0, dragBox.width, dragBox.height);
      ctx.fillStyle = "rgba(37, 99, 235, 0.25)";
      ctx.fillRect(dragBox.x0, dragBox.y0, dragBox.width, dragBox.height);
      ctx.restore();
    }
  }

  function getCanvasCoords(e){
    if(!redactCanvas) return { x: 0, y: 0 };
    var rect = redactCanvas.getBoundingClientRect();
    var scaleX = redactCanvas.width / (rect.width || 1);
    var scaleY = redactCanvas.height / (rect.height || 1);
    return {
      x: Math.max(0, Math.min(redactCanvas.width, (e.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(redactCanvas.height, (e.clientY - rect.top) * scaleY))
    };
  }

  if(redactCanvas){
    redactCanvas.addEventListener("mousedown", function(e){
      if(!currentRedactImage || e.button !== 0) return;
      isDrawingManualBox = true;
      manualBoxStart = getCanvasCoords(e);
      currentDragBox = null;
    });

    window.addEventListener("mousemove", function(e){
      if(!isDrawingManualBox || !manualBoxStart) return;
      var cur = getCanvasCoords(e);
      var x0 = Math.min(manualBoxStart.x, cur.x);
      var y0 = Math.min(manualBoxStart.y, cur.y);
      var w = Math.abs(cur.x - manualBoxStart.x);
      var h = Math.abs(cur.y - manualBoxStart.y);
      currentDragBox = { x0: x0, y0: y0, width: w, height: h };
      renderRedactCanvas(true, currentDragBox);
    });

    window.addEventListener("mouseup", function(e){
      if(!isDrawingManualBox || !manualBoxStart) return;
      isDrawingManualBox = false;
      var cur = getCanvasCoords(e);
      var x0 = Math.min(manualBoxStart.x, cur.x);
      var y0 = Math.min(manualBoxStart.y, cur.y);
      var w = Math.abs(cur.x - manualBoxStart.x);
      var h = Math.abs(cur.y - manualBoxStart.y);
      manualBoxStart = null;
      currentDragBox = null;

      if(w >= 6 && h >= 6){
        var imageArea = redactCanvas.width * redactCanvas.height;
        var selectedAreaRatio = imageArea > 0 ? (w * h) / imageArea : 0;
        if(selectedAreaRatio > 0.35 && !window.confirm("Bu alan görselin yaklaşık %" + Math.round(selectedAreaRatio * 100) + " kadarını kaplıyor. Bu geniş alanı karartma listesine ekleyeyim mi?")){
          renderRedactCanvas(true);
          return;
        }
        var automaticLabel = "ALAN_" + nextManualRedactLabel++;
        var newBox = {
          x0: Math.round(x0),
          y0: Math.round(y0),
          x1: Math.round(x0 + w),
          y1: Math.round(y0 + h),
          width: Math.round(w),
          height: Math.round(h),
          type: "manuel",
          label: automaticLabel,
          raw: "Elle Çizilen (" + Math.round(w) + "x" + Math.round(h) + ")",
          enabled: true
        };
        currentRedactBoxes.push(newBox);
        renderRedactBoxList();
        renderRedactCanvas(true);
        if(redactDownloadBtn) redactDownloadBtn.disabled = false;
        showRedactStatus("Yeni manuel karartma alanı eklendi (" + currentRedactBoxes.length + " alan).", false);
      } else {
        renderRedactCanvas(true);
      }
    });
  }

  function renderRedactBoxList(){
    if(!redactBoxList) return;
    redactBoxList.innerHTML = "";
    if(redactBoxCount) redactBoxCount.textContent = currentRedactBoxes.length;

    if(!currentRedactBoxes.length){
      redactBoxList.innerHTML = '<p class="redact-empty-hint">Hassas veri içeren kutu tespit edilemedi. Görsel üzerinde fareyle çizim yaparak manuel alan ekleyebilirsiniz.</p>';
      return;
    }

    currentRedactBoxes.forEach(function(b, idx){
      var item = document.createElement("div");
      item.className = "redact-box-item";

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = b.enabled !== false;
      cb.id = "redact_cb_" + idx;
      cb.addEventListener("change", function(){
        b.enabled = cb.checked;
        renderRedactCanvas(true);
      });

      var info = document.createElement("div");
      info.className = "redact-box-info";

      var typeSpan = document.createElement("span");
      typeSpan.className = "redact-box-type" + (b.type === "manuel" ? " redact-box-type-manual" : "");
      typeSpan.textContent = b.type === "manuel" ? "Elle çizim" : (TYPE_LABELS[b.type] || b.type);
      info.appendChild(typeSpan);

      var labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.className = "redact-box-label-input";
      labelInput.value = b.label || "";
      labelInput.maxLength = 32;
      labelInput.placeholder = "Etiket (örn. ADRES)";
      labelInput.setAttribute("aria-label", "Karartma alanı " + (idx + 1) + " etiketi");
      labelInput.title = "Etiketli bant seçilirse bu ad görselin üzerine yazılır";
      labelInput.addEventListener("input", function(){
        b.label = labelInput.value.replace(/\s+/g, " ").trim();
      });
      info.appendChild(labelInput);

      var valSpan = document.createElement("span");
      valSpan.className = "redact-box-val";
      valSpan.textContent = b.raw || "";

      info.appendChild(valSpan);
      item.appendChild(cb);
      item.appendChild(info);

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "redact-box-del";
      delBtn.title = "Alanı listeden kaldır";
      delBtn.innerHTML = "×";
      delBtn.addEventListener("click", function(e){
        e.stopPropagation();
        currentRedactBoxes.splice(idx, 1);
        renderRedactBoxList();
        renderRedactCanvas(true);
      });
      item.appendChild(delBtn);

      redactBoxList.appendChild(item);
    });
  }

  function resetRedactImageState(){
    currentRedactImage = null;
    currentRedactBoxes = [];
    nextManualRedactLabel = 1;
    isDrawingManualBox = false;
    manualBoxStart = null;
    currentDragBox = null;
    if(redactCanvas){
      redactCanvas.width = 0;
      redactCanvas.height = 0;
      redactCanvas.hidden = true;
    }
    if(redactPlaceholderMsg){
      redactPlaceholderMsg.textContent = "Görsel seçin veya panodan (Ctrl+V) yapıştırın";
      redactPlaceholderMsg.hidden = false;
    }
    if(redactOcrOutput) redactOcrOutput.hidden = true;
    if(redactOcrText) redactOcrText.value = "";
    if(redactOcrCopyBtn){
      redactOcrCopyBtn.disabled = true;
      redactOcrCopyBtn.textContent = "OCR metnini kopyala";
    }
    if(redactClearBtn) redactClearBtn.disabled = true;
    if(redactApplyBtn) redactApplyBtn.disabled = true;
    if(redactDownloadBtn) redactDownloadBtn.disabled = true;
    renderRedactBoxList();
  }

  function clearRedactImage(){
    redactImageRequestId++;
    if(redactImageInput) redactImageInput.value = "";
    resetRedactImageState();
    showRedactStatus("Görsel ve OCR metni kaldırıldı.", false);
  }

  if(redactClearBtn){
    redactClearBtn.addEventListener("click", clearRedactImage);
  }

  if(redactOcrCopyBtn){
    redactOcrCopyBtn.addEventListener("click", function(){
      if(!redactOcrText || !redactOcrText.value) return;
      copyToClipboard(redactOcrText.value, redactOcrCopyBtn);
    });
  }

  async function processImageOcrAndCandidates(img, requestId){
    if(requestId !== redactImageRequestId) return;
    currentRedactImage = img;
    if(redactPlaceholderMsg) redactPlaceholderMsg.hidden = true;
    if(redactCanvas) redactCanvas.hidden = false;
    if(redactClearBtn) redactClearBtn.disabled = false;
    if(redactApplyBtn) redactApplyBtn.disabled = false;
    renderRedactCanvas(false);
    showRedactStatus("Görsel OCR ile taranıyor ve hassas koordinatlar hesaplanıyor…", false);

    try{
      var worker = await MaskEngine.getOcrWorker();
      var result = await worker.recognize(img);
      if(requestId !== redactImageRequestId) return;
      var text = (result && result.data && result.data.text) ? result.data.text : "";
      var words = (result && result.data && Array.isArray(result.data.words)) ? result.data.words : [];

      var candidates = MaskEngine.detectCandidates(text);
      var boxes = MaskEngine.mapCandidatesToBoundingBoxes(words, candidates, {
        width: redactCanvas.width,
        height: redactCanvas.height
      });

      var manualBoxes = currentRedactBoxes.filter(function(box){ return box.type === "manuel"; });
      currentRedactBoxes = boxes.concat(manualBoxes);
      if(redactOcrText) redactOcrText.value = text;
      if(redactOcrOutput) redactOcrOutput.hidden = false;
      if(redactOcrCopyBtn) redactOcrCopyBtn.disabled = !text.trim();
      renderRedactBoxList();
      renderRedactCanvas(true);
      if(redactDownloadBtn) redactDownloadBtn.disabled = false;

      if(currentRedactBoxes.length > 0){
        showRedactStatus(boxes.length + " OCR alanı ve " + manualBoxes.length + " manuel alan hazır. Karartmayı uygulayıp indirebilirsiniz.", false);
      } else {
        showRedactStatus("Hassas veri (TCKN, kart, telefon vb.) tespit edilemedi.", false);
      }
    }catch(err){
      if(requestId !== redactImageRequestId) return;
      console.error("Görsel OCR hatası:", err);
      showRedactStatus("OCR hatası: " + (err.message || String(err)), true);
    }
  }

  function loadImageForRedaction(sourceFileOrBlob){
    var requestId = ++redactImageRequestId;
    resetRedactImageState();
    if(redactImageInput) redactImageInput.value = "";
    if(redactPlaceholderMsg) redactPlaceholderMsg.textContent = "Görsel yükleniyor…";
    showRedactStatus("Görsel yükleniyor…", false);
    var reader = new FileReader();
    reader.onload = function(e){
      if(requestId !== redactImageRequestId) return;
      var img = new Image();
      img.onload = function(){
        if(requestId !== redactImageRequestId) return;
        processImageOcrAndCandidates(img, requestId);
      };
      img.onerror = function(){
        if(requestId !== redactImageRequestId) return;
        showRedactStatus("Görsel açılamadı. Başka bir görsel seçip yeniden deneyin.", true);
      };
      img.src = e.target.result;
    };
    reader.onerror = function(){
      if(requestId !== redactImageRequestId) return;
      showRedactStatus("Görsel okunamadı. Başka bir görsel seçip yeniden deneyin.", true);
    };
    reader.readAsDataURL(sourceFileOrBlob);
  }

  if(redactImageInput){
    redactImageInput.addEventListener("change", function(e){
      if(e.target.files && e.target.files[0]){
        loadImageForRedaction(e.target.files[0]);
      }
    });
  }

  if(redactApplyBtn){
    redactApplyBtn.addEventListener("click", function(){
      if(!currentRedactImage || !redactCanvas) return;
      var style = redactStyleSelect ? redactStyleSelect.value : "black";
      renderRedactCanvas(false);
      MaskEngine.redactBoundingBoxes(redactCanvas, currentRedactBoxes, { style: style, padding: 4 });
      showRedactStatus("Karartma uygulandı (" + style + ").", false);
    });
  }

  if(redactDownloadBtn){
    redactDownloadBtn.addEventListener("click", function(){
      if(!currentRedactImage || !redactCanvas) return;
      var style = redactStyleSelect ? redactStyleSelect.value : "black";
      renderRedactCanvas(false);
      MaskEngine.redactBoundingBoxes(redactCanvas, currentRedactBoxes, { style: style, padding: 4 });

      var dataUrl = MaskEngine.exportRedactedCanvas(redactCanvas, "image/png");
      if(!dataUrl) return;

      var link = document.createElement("a");
      link.download = "karartilmis-gorsel.png";
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showRedactStatus("Karartılmış görsel indirildi ✓", false);
    });
  }

  if(redactModal){
    redactModal.addEventListener("paste", function(e){
      var clipboard = e.clipboardData || window.clipboardData;
      if(!clipboard) return;
      var items = clipboard.items;
      for(var i = 0; i < items.length; i++){
        if(items[i].type && items[i].type.indexOf("image/") === 0){
          var file = items[i].getAsFile();
          if(file) loadImageForRedaction(file);
          e.preventDefault();
          break;
        }
      }
    });
  }

  // Info modal
  var infoModal = document.getElementById("infoModal");
  function closeInfoModal(){ infoModal.hidden = true; }
  document.getElementById("infoBtn").addEventListener("click", function(){
    window.open('rehber/index.html', '_blank', 'noopener');
  });
  document.getElementById("infoModalClose").addEventListener("click", closeInfoModal);
  infoModal.addEventListener("click", function(e){
    if(e.target === infoModal){ closeInfoModal(); }
  });
  document.addEventListener("keydown", function(e){
    if(e.key === "Escape" && !infoModal.hidden){ closeInfoModal(); }
  });

  var pendingOutbound = null;
  var outboundModal = document.getElementById("outboundModal");
  // Araya değişken giren (birleştirilmiş) mesaj: dil.js bunu kalıp olarak
  // yakalayamaz, yazım anında çevrilir. Kap her açılışta yeniden kurulduğu
  // için dil değişince eski metin kalmaz.
  function MT(metin){
    if(window.MaskoDil && window.MaskoDil.t) return window.MaskoDil.t.apply(null, arguments);
    var degerler = Array.prototype.slice.call(arguments, 1);
    return String(metin).replace(/\{(\d+)(:t)?\}/g, function(_, i){ return degerler[i] !== undefined ? String(degerler[i]) : ""; });
  }
  function fillList(sectionId, listId, values){
    var section = document.getElementById(sectionId);
    var list = document.getElementById(listId);
    list.innerHTML = "";
    (values || []).forEach(function(value){
      var li = document.createElement("li");
      li.textContent = value;
      list.appendChild(li);
    });
    section.hidden = !values || values.length === 0;
  }
  function addOutboundFact(label, value){
    var box = document.createElement("div");
    box.className = "outbound-fact";
    var strong = document.createElement("strong");
    strong.setAttribute("translate", "no");   // değer (sayı, proje adı) çevrilmez
    strong.textContent = String(value);
    box.appendChild(strong);
    box.appendChild(document.createTextNode(label));
    document.getElementById("outboundFacts").appendChild(box);
  }
  function openOutboundReview(target, btn){
    var text = target.value || "";
    var context = (window.OutboundContexts && window.OutboundContexts[target.id]) || {};
    var findings = MaskEngine.inspectSensitive(text, enabledDetectors());
    var info = MaskEngine.getWorkspaces ? MaskEngine.getWorkspaces() : { activeId:null, items:[] };
    var active = info.items.find(function(item){ return item.id === info.activeId; });
    var placeholders = (text.match(/\[[A-Z]+_\d+\]/g) || []).length;
    document.getElementById("outboundFacts").innerHTML = "";
    addOutboundFact("karakter", text.length.toLocaleString("tr-TR"));
    addOutboundFact("maske kullanımı", placeholders);
    addOutboundFact("kalan hassas aday", findings.length);
    addOutboundFact("aktif proje", active ? active.name : "Genel");
    document.getElementById("outboundLead").textContent = context.synthetic ?
      ((context.realValues && context.realValues.length)
        ? "Yapısal özet ve sahte örnekler yanında, aşağıda listelenen gerçek sözlük değerleri/kural değerleri de içeriğe aynen geçiyor. Bu örnek satırlar tamamen sentetik değildir; göndermeden önce tek tek gözden geçirin."
        : "Bu içerik yapısal özet ve sentetik örnek taşır; aşağıdaki tablo takma adları, kolon adları ve paylaşılan bilgileri kontrol edin.") :
      "İçerik panoya yazılmadan önce son kez yerel olarak tarandı.";
    var warning = document.getElementById("outboundWarning");
    if(findings.length){
      var byType = {};
      findings.forEach(function(item){ byType[item.label] = (byType[item.label] || 0) + 1; });
      var turOzeti = Object.keys(byType).map(function(k){
        return MT(k) + " (" + byType[k] + ")";
      }).join(", ");
      warning.textContent = MT("Dikkat: maskelenmemiş olabilecek {0} aday var: {1}. Aşağıdaki adayları inceleyip maskeleyebilir veya dışlayabilirsiniz.", findings.length, turOzeti);
      warning.hidden = false;
    } else {
      warning.hidden = true;
    }

    var findingsSection = document.getElementById("outboundFindingsSection");
    var findingsList = document.getElementById("outboundFindingsList");
    if(findingsSection && findingsList){
      findingsList.innerHTML = "";
      if(findings.length){
        findingsSection.hidden = false;
        findings.forEach(function(item){
          var row = document.createElement("div");
          row.className = "outbound-finding-item";

          var info = document.createElement("div");
          info.className = "outbound-finding-info";

          var labelSpan = document.createElement("span");
          labelSpan.className = "outbound-finding-label";
          labelSpan.textContent = item.label;
          if(item.confidence){
            var confTag = document.createElement("span");
            confTag.className = "type-tag";
            confTag.textContent = item.confidence;
            labelSpan.appendChild(confTag);
          }

          var valSpan = document.createElement("span");
          valSpan.className = "outbound-finding-value";
          valSpan.textContent = item.value;

          var reasonSpan = document.createElement("span");
          reasonSpan.className = "outbound-finding-reason";
          reasonSpan.textContent = item.reason || "Kural tespiti";

          info.appendChild(labelSpan);
          info.appendChild(valSpan);
          info.appendChild(reasonSpan);
          row.appendChild(info);

          var actions = document.createElement("div");
          actions.className = "outbound-finding-actions";

          var maskBtn = document.createElement("button");
          maskBtn.type = "button";
          maskBtn.textContent = "Maskele";
          maskBtn.title = "Bu terimi sözlüğe ekleyip metni yeniden maskele";
          maskBtn.addEventListener("click", async function(){
            await MaskEngine.addCustomTerm(item.value);
            await yenidenMaskele();
            openOutboundReview(target, btn);
          });
          actions.appendChild(maskBtn);

          var exBtn = document.createElement("button");
          exBtn.type = "button";
          exBtn.textContent = "Dışla";
          exBtn.title = "Bu değeri hariç tutulanlara ekle";
          exBtn.addEventListener("click", async function(){
            await MaskEngine.addExcluded(item.value);
            await yenidenMaskele();
            openOutboundReview(target, btn);
          });
          actions.appendChild(exBtn);

          row.appendChild(actions);
          findingsList.appendChild(row);
        });
      } else {
        findingsSection.hidden = true;
      }
    }

    fillList("outboundFilesSection", "outboundFiles", context.files || []);
    fillList("outboundHeadersSection", "outboundHeaders", context.headers || []);
    fillList("outboundStatsSection", "outboundStats", context.stats || []);
    fillList("outboundRealValuesSection", "outboundRealValues", context.realValues || []);
    pendingOutbound = { text:text, btn:btn, target:target };
    outboundModal.hidden = false;
    document.getElementById("outboundConfirm").focus();
  }
  function closeOutboundReview(){ outboundModal.hidden = true; pendingOutbound = null; }
  document.getElementById("outboundClose").addEventListener("click", closeOutboundReview);
  document.getElementById("outboundCancel").addEventListener("click", closeOutboundReview);
  var rescanBtn = document.getElementById("outboundRescan");
  if(rescanBtn){
    rescanBtn.addEventListener("click", function(){
      if(!pendingOutbound || !pendingOutbound.target) return;
      openOutboundReview(pendingOutbound.target, pendingOutbound.btn);
    });
  }
  outboundModal.addEventListener("click", function(e){ if(e.target === outboundModal) closeOutboundReview(); });
  document.getElementById("outboundConfirm").addEventListener("click", function(){
    if(!pendingOutbound) return;
    var pending = pendingOutbound;
    closeOutboundReview();
    copyToClipboard(pending.text, pending.btn);
  });

  /* Gezinme iki seviyeli: ana sekmeler (Maskele, Geri Aç, Tablo örneği,
     Dosya işleri) ve "Dosya işleri" seçiliyken görünen araç sekmeleri.
     Araç çerçeveleri data-src ile gelir ve yalnız ilk açılışta yüklenir;
     böylece sayfa açılırken sekiz araç birden arka planda çalışmaz. */
  var toolTabsRow = document.getElementById("toolTabs");
  var activeTool = "dedup";

  function selectTab(tabs, selected){
    tabs.forEach(function(t){
      var active = t === selected;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function showPanel(name){
    document.querySelectorAll(".mode-panel").forEach(function(panel){
      var show = panel.getAttribute("data-panel") === name;
      panel.hidden = !show;
      if(show){
        var frame = panel.querySelector("iframe[data-src]");
        if(frame && !frame.getAttribute("src")) frame.setAttribute("src", frame.getAttribute("data-src"));
      }
    });
  }

  var modeTabs = Array.prototype.slice.call(document.querySelectorAll(".mode-tab"));
  var toolTabs = Array.prototype.slice.call(document.querySelectorAll(".tool-tab"));
  modeTabs.forEach(function(tab){
    tab.addEventListener("click", function(){
      var mode = tab.getAttribute("data-mode");
      selectTab(modeTabs, tab);
      if(toolTabsRow) toolTabsRow.hidden = mode !== "araclar";
      showPanel(mode === "araclar" ? activeTool : mode);
    });
  });
  toolTabs.forEach(function(tab){
    tab.addEventListener("click", function(){
      activeTool = tab.getAttribute("data-tool");
      selectTab(toolTabs, tab);
      showPanel(activeTool);
    });
  });

  // "Otomatik yakalanan türler" kapalı durur; düğmede kaç türün açık olduğu görünür.
  var detectBoxes = document.querySelectorAll("input[data-detect]");
  var detectCount = document.getElementById("detectCount");
  var detectToggle = document.getElementById("detectToggle");
  var detectPanel = document.getElementById("detectPanel");
  function updateDetectCount(){
    if(!detectCount) return;
    var on = 0;
    detectBoxes.forEach(function(b){ if(b.checked) on++; });
    detectCount.textContent = on + " / " + detectBoxes.length + " açık";
    detectCount.classList.toggle("is-eksik", on < detectBoxes.length);
  }
  detectBoxes.forEach(function(b){
    b.addEventListener("change", function(){
      updateDetectCount();
      // Açılan ya da kapanan tür çıktıya ancak yeniden maskelenince yansır.
      if(document.getElementById("maskOutput").value) maskeleDurumu(false);
    });
  });
  updateDetectCount();
  detectToggle.addEventListener("click", function(){
    var ac = detectPanel.hidden;
    detectPanel.hidden = !ac;
    detectToggle.setAttribute("aria-expanded", ac ? "true" : "false");
  });

  /* Veri Tezgâhı çerçevesi başka bir aracı isteyebilir (ör. Anti-Join için
     Tekilleştirme). Yalnız aynı kökenden gelen ileti kabul edilir. */
  window.addEventListener("message", function(e){
    if (e.origin !== location.origin || !e.data || typeof e.data.maskoAracAc !== "string") return;
    var hedef = toolTabs.filter(function(t){ return t.getAttribute("data-tool") === e.data.maskoAracAc; })[0];
    var grup = document.querySelector('.mode-tab[data-mode="araclar"]');
    if (!hedef || !grup) return;
    grup.click();
    hedef.click();
  });

  // Mask run
  document.getElementById("runMask").addEventListener("click", async function(){
    var input = document.getElementById("maskInput").value;
    var masked = await runMaskAndRender(input);
    document.getElementById("maskOutput").value = masked;
    refreshReview(masked);
  });

  // Unmask run
  document.getElementById("runUnmask").addEventListener("click", async function(){
    var input = document.getElementById("unmaskInput").value;
    document.getElementById("unmaskOutput").value = await MaskEngine.unmaskText(input);
  });

  /* Yalnızca seçimi geri aç.
     Tüm metni açmak her zaman istenmiyor: bir cevabı paylaşırken sadece bir
     değeri görmek, gerisini maskeli bırakmak gerekebiliyor. Seçim yerinde
     değiştirilir, böylece adım adım açılabilir. */
  document.getElementById("runUnmaskSelection").addEventListener("click", async function(){
    var alan = document.getElementById("unmaskInput");
    var not = document.getElementById("unmaskSelectionNote");
    var bas = alan.selectionStart, son = alan.selectionEnd;

    function bildir(metin, sinif){
      not.hidden = false;
      not.textContent = metin;
      not.className = "secim-durum" + (sinif ? " " + sinif : "");
    }

    if(bas === son){
      bildir("Önce geri açmak istediğiniz bölümü metin içinde seçin.", "is-uyari");
      alan.focus();
      return;
    }

    var secim = alan.value.slice(bas, son);
    var acilmis = await MaskEngine.unmaskText(secim);
    if(acilmis === secim){
      bildir("Seçimde sözlükte karşılığı olan bir placeholder yok.", "is-uyari");
      return;
    }

    var oncekiSayi = (secim.match(/\[[A-Z]+_\d+\]/g) || []).length;
    var kalanSayi = (acilmis.match(/\[[A-Z]+_\d+\]/g) || []).length;
    var acilan = oncekiSayi - kalanSayi;

    alan.value = alan.value.slice(0, bas) + acilmis + alan.value.slice(son);
    // Açılan bölüm seçili kalsın ki kullanıcı ne değiştiğini görsün.
    alan.focus();
    alan.setSelectionRange(bas, bas + acilmis.length);

    // Çıktı her zaman "kopyalayacağınız hâli" gösterir: kısmen açılmış metin.
    document.getElementById("unmaskOutput").value = alan.value;

    var kalanToplam = (alan.value.match(/\[[A-Z]+_\d+\]/g) || []).length;
    bildir(acilan + " değer geri açıldı. Metinde " + kalanToplam + " maskeli değer kaldı.");
  });

  // Copy buttons
  document.querySelectorAll("[data-copy]").forEach(function(btn){
    btn.addEventListener("click", function(){
      var target = document.getElementById(btn.getAttribute("data-copy"));
      if(btn.getAttribute("data-review") === "outbound") openOutboundReview(target, btn);
      else copyToClipboard(target.value, btn);
    });
  });

  document.getElementById("workspaceSelect").addEventListener("change", async function(){
    await MaskEngine.switchWorkspace(this.value);
    renderWorkspaces();
    await yenidenMaskele();
  });
  document.getElementById("createWorkspace").addEventListener("click", async function(){
    var input = document.getElementById("newWorkspaceName");
    if(!input.value.trim()) return;
    await MaskEngine.createWorkspace(input.value, parseInt(document.getElementById("workspaceRetention").value, 10));
    input.value = "";
    renderWorkspaces();
    await yenidenMaskele();
  });
  document.getElementById("renameWorkspace").addEventListener("click", async function(){
    var info = MaskEngine.getWorkspaces();
    var active = info.items.find(function(item){ return item.id === info.activeId; });
    var name = window.prompt("Projenin yeni adı", active ? active.name : "");
    if(name === null || !name.trim()) return;
    await MaskEngine.renameWorkspace(name);
    renderWorkspaces();
  });
  document.getElementById("workspaceRetention").addEventListener("change", async function(){
    await MaskEngine.setWorkspaceRetention(parseInt(this.value, 10));
    renderWorkspaces();
  });
  document.getElementById("deleteWorkspace").addEventListener("click", async function(){
    var info = MaskEngine.getWorkspaces();
    var active = info.items.find(function(item){ return item.id === info.activeId; });
    if(!active || !window.confirm("‘" + active.name + "’ projesi ve geri açma sözlüğü kalıcı olarak silinsin mi?")) return;
    await MaskEngine.deleteWorkspace(active.id);
    renderWorkspaces();
    await yenidenMaskele();
  });

  // Manual add
  async function addManualTerm(){
    var realInput = document.getElementById("manualReal");
    var placeholderInput = document.getElementById("manualPlaceholder");
    var result = await MaskEngine.addManualTerm(realInput.value, placeholderInput.value);
    if(result === null) return;
    realInput.value = "";
    placeholderInput.value = "";
    renderGlossary();
  }
  document.getElementById("addManual").addEventListener("click", addManualTerm);
  ["manualReal","manualPlaceholder"].forEach(function(id){
    document.getElementById(id).addEventListener("keydown", function(e){
      if(e.key === "Enter"){ e.preventDefault(); addManualTerm(); }
    });
  });

  // Copy glossary JSON
  document.getElementById("copyGlossary").addEventListener("click", function(){
    copyToClipboard(JSON.stringify(MaskEngine.getGlossary(), null, 2), document.getElementById("copyGlossary"));
    var btn = document.getElementById("copyGlossary");
    var orig = btn.textContent;
    btn.textContent = "Kopyalandı — dikkat: gerçek veri içerir";
    setTimeout(function(){ btn.textContent = orig; }, 3500);
  });

  // Clear glossary
  document.getElementById("clearGlossary").addEventListener("click", async function(){
    await MaskEngine.clearGlossary();
    // Sözlüğü silmek yetmiyordu: kullanıcının yapıştırdığı HAM metin de
    // her tuş vuruşunda taslak olarak diske yazılıyor (saveInputDraft).
    // Temizle düğmesi onu bırakınca, arayüz "temizlendi" derken TCKN/IBAN
    // dolu ham metin localStorage'da kalıyordu ve silmenin hiçbir yolu yoktu.
    try{ window.sessionStorage.removeItem("maskeleme_istasyonu_sozluk_v1_draft"); }catch(e){}
    try{ window.localStorage.removeItem("maskeleme_istasyonu_sozluk_v1_draft"); }catch(e){}
    renderGlossary();
    renderExcluded();
  });

  // Import glossary
  document.getElementById("importFile").addEventListener("change", function(e){
    var file = e.target.files[0];
    if(!file) return;
    var reader = new FileReader();
    reader.onload = async function(){
      try{
        var parsed = JSON.parse(reader.result);
        await MaskEngine.importGlossary(parsed);
        renderGlossary();
      }catch(err){ showStorageError(err); }
      e.target.value = "";
    };
    reader.readAsText(file);
  });

  // Init
  if(MaskEngine.onStateChange){
    MaskEngine.onStateChange(function(){ renderGlossary(); renderExcluded(); renderWorkspaces(); });
  }

  // Maskeleme ekranının örnek metni dile göre değişir. Değerler (telefon,
  // IBAN, tutar, tarih biçimi) aynı kalır: tespit her iki dilde de aynı
  // örnek üzerinden aynı çalışsın diye. Kod satırları çevrilmez.
  var EXAMPLE_TEXT = {
    tr:
      "Müşteri Ahmet Yılmaz için ödeme kaydı:\n" +
      "- E-posta: ahmet.yilmaz@ornek.com\n" +
      "- Telefon: 0532 111 22 33\n" +
      "- IBAN: TR33 0006 1005 1978 6457 8413 26\n" +
      "- TC Kimlik No: 12345678950\n" +
      "- Vergi Kimlik No: 1234567890\n" +
      "- Test kart no: 4111 1111 1111 1111\n" +
      "- Tutar: 12.500,00 TL\n" +
      "- İşlem tarihi: 07.09.2026\n\n" +
      "SELECT musteri_id, iban_no FROM dbo.MusteriHesaplari WHERE musteri_id = 482193;\n\n" +
      "def get_customer_balance(musteri_id):\n" +
      "    return db.query('SELECT bakiye FROM hesaplar WHERE musteri_id = %s', musteri_id)",
    en:
      "Payment record for customer Mr. John Smith:\n" +
      "- Email: john.smith@sample.com\n" +
      "- Phone: 0532 111 22 33\n" +
      "- IBAN: TR33 0006 1005 1978 6457 8413 26\n" +
      "- National ID (TCKN): 12345678950\n" +
      "- Tax ID (VKN): 1234567890\n" +
      "- Test card no: 4111 1111 1111 1111\n" +
      "- Amount: 12.500,00 TL\n" +
      "- Transaction date: 07.09.2026\n\n" +
      "SELECT musteri_id, iban_no FROM dbo.MusteriHesaplari WHERE musteri_id = 482193;\n\n" +
      "def get_customer_balance(musteri_id):\n" +
      "    return db.query('SELECT bakiye FROM hesaplar WHERE musteri_id = %s', musteri_id)"
  };
  function exampleText(){
    return (window.MaskoDil && window.MaskoDil.dil() === "en") ? EXAMPLE_TEXT.en : EXAMPLE_TEXT.tr;
  }

  var draft = null;
  try{ draft = window.sessionStorage.getItem("maskeleme_istasyonu_sozluk_v1_draft"); }catch(e){}
  if(!draft) { try{ draft = window.localStorage.getItem("maskeleme_istasyonu_sozluk_v1_draft"); }catch(e){} }
  var startingText = (draft !== null && draft !== "") ? draft : exampleText();

  document.getElementById("maskInput").value = startingText;
  girdiDurumu();
  renderGlossary();
  renderExcluded();
  renderWorkspaces();
  var initialMasked = await runMaskAndRender(startingText);
  document.getElementById("maskOutput").value = initialMasked;
  refreshReview(initialMasked);

  // Dil değişince örnek metin de değişir; kullanıcının yazdığı metin korunur.
  if(window.MaskoDil){
    window.MaskoDil.degisince(async function(){
      var alan = document.getElementById("maskInput");
      if(alan.value !== EXAMPLE_TEXT.tr && alan.value !== EXAMPLE_TEXT.en) return;
      alan.value = exampleText();
      girdiDurumu();
      await yenidenMaskele();
    });
  }
})();
