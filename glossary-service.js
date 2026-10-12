/* Service worker: sözlük işlemlerini sıraya alır; sayaç üretimi ve kayıt atomik sıradadır. */
(function(){
  "use strict";
  var KEY = "maskeleme_istasyonu_sozluk_v1";
  var WORKSPACE_KEY = "maskeleme_istasyonu_workspaces_v1";
  var queue = Promise.resolve();
  var accessReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  var methods = new Set(["init", "maskText", "unmaskText", "addTerm", "addManualTerm",
    "deleteEntry", "restoreEntry", "excludeEntryById", "unexcludeEntry", "clearGlossary", "importGlossary",
    "createWorkspace", "switchWorkspace", "renameWorkspace", "deleteWorkspace", "setWorkspaceRetention"]);
  var sites = new Set(["https://chatgpt.com", "https://chat.openai.com",
    "https://aistudio.google.com", "https://gemini.google.com", "https://claude.ai"]);

  function senderOrigin(sender){
    if(sender.id !== chrome.runtime.id) throw new Error("Yetkisiz sözlük isteği.");
    var url = new URL(sender.url);
    if(url.protocol === "chrome-extension:" && url.host === chrome.runtime.id) return "extension";
    if(url.protocol === "https:" && sites.has(url.origin)) return url.origin;
    throw new Error("Bu sayfa ortak sözlüğe erişemez.");
  }

  function validateArgs(operation, args){
    if(!Array.isArray(args)) throw new Error("Geçersiz işlem.");
    if(["maskText", "unmaskText", "addTerm", "addManualTerm", "deleteEntry", "excludeEntryById"].includes(operation) &&
       typeof args[0] !== "string") throw new Error("Metin bekleniyor.");
    if(operation === "addTerm" && !["manual", "code", "literal", "secim", "name", "address"].includes(args[1])) throw new Error("Geçersiz terim tipi.");
    if(operation === "importGlossary" && !Array.isArray(args[0])) throw new Error("Sözlük listesi bekleniyor.");
    if(["createWorkspace", "renameWorkspace"].includes(operation) && typeof args[0] !== "string") throw new Error("Proje adı bekleniyor.");
    if(["switchWorkspace", "deleteWorkspace"].includes(operation) && typeof args[0] !== "string") throw new Error("Proje kimliği bekleniyor.");
    if(operation === "setWorkspaceRetention" && (!Number.isInteger(args[0]) || ![0,1,7,30,90].includes(args[0]))) throw new Error("Geçersiz saklama süresi.");
  }

  function emptyState(seedCounters){ return { glossary: [], counters:Object.assign({}, seedCounters || {}), excluded: [], revision: 0, migrated: [] }; }
  function workspaceId(){ return "ws_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
  function cleanName(value){
    var name = String(value || "").trim().replace(/\s+/g, " ");
    if(!name) throw new Error("Proje adı boş olamaz.");
    if(name.length > 60) throw new Error("Proje adı 60 karakteri geçemez.");
    return name;
  }
  function bootstrapWorkspaces(storedState, storedWorkspaces){
    if(storedWorkspaces && storedWorkspaces.activeId && storedWorkspaces.items && storedWorkspaces.items[storedWorkspaces.activeId]){
      storedWorkspaces.globalCounters = storedWorkspaces.globalCounters || {};
      Object.keys(storedWorkspaces.items).forEach(function(id){
        var counters = (storedWorkspaces.items[id].state || {}).counters || {};
        Object.keys(counters).forEach(function(type){ storedWorkspaces.globalCounters[type] = Math.max(storedWorkspaces.globalCounters[type] || 0, counters[type] || 0); });
      });
      return storedWorkspaces;
    }
    var id = workspaceId();
    var now = Date.now();
    var firstState = storedState || emptyState();
    return { activeId:id, globalCounters:Object.assign({}, firstState.counters || {}), items:{ [id]:{ id:id, name:"Genel", retentionDays:0, createdAt:now, lastUsedAt:now,
      state:firstState } } };
  }
  function cleanupExpired(store){
    var now = Date.now();
    Object.keys(store.items).forEach(function(id){
      var item = store.items[id];
      if(id !== store.activeId && item.retentionDays > 0 && now - item.lastUsedAt > item.retentionDays * 86400000){
        delete store.items[id];
      }
    });
  }
  function workspaceInfo(store){
    return { activeId:store.activeId, items:Object.keys(store.items).map(function(id){
      var item = store.items[id];
      return { id:item.id, name:item.name, retentionDays:item.retentionDays || 0,
        createdAt:item.createdAt, lastUsedAt:item.lastUsedAt, entryCount:(item.state.glossary || []).length };
    }).sort(function(a,b){ return a.createdAt - b.createdAt; }) };
  }

  async function execute(message, sender){
    var origin = senderOrigin(sender);
    if(!methods.has(message.operation)) throw new Error("Bilinmeyen sözlük işlemi.");
    validateArgs(message.operation, message.args);
    await accessReady;
    // Ayrı okumalar: gerçek Chrome ile aynı sonucu verir, minimal MV3 test
    // çiftlerinde de dizi anahtarın string'e çevrilmesine takılmaz.
    var stored = (await chrome.storage.local.get(KEY))[KEY];
    var storedWorkspaces = (await chrome.storage.local.get(WORKSPACE_KEY))[WORKSPACE_KEY];
    var workspaces = bootstrapWorkspaces(stored, storedWorkspaces);
    cleanupExpired(workspaces);
    var active = workspaces.items[workspaces.activeId];
    var state = active.state || stored || emptyState();
    var migrated = (state.migrated || []).slice();
    var backup = null;
    MaskEngine.setState(state);

    if(message.operation === "createWorkspace"){
      var createName = cleanName(message.args[0]);
      if(Object.keys(workspaces.items).some(function(id){ return workspaces.items[id].name.toLocaleLowerCase("tr-TR") === createName.toLocaleLowerCase("tr-TR"); })){
        throw new Error("Bu adda bir proje zaten var.");
      }
      active.state = Object.assign(MaskEngine.getState(), { revision:state.revision || 0, migrated:migrated });
      var newId = workspaceId();
      workspaces.items[newId] = { id:newId, name:createName, retentionDays:message.args[1] || 0,
        createdAt:Date.now(), lastUsedAt:Date.now(), state:emptyState(workspaces.globalCounters) };
      workspaces.activeId = newId;
      active = workspaces.items[newId];
      state = active.state;
      migrated = [];
      MaskEngine.setState(state);
    } else if(message.operation === "switchWorkspace"){
      if(!workspaces.items[message.args[0]]) throw new Error("Proje bulunamadı.");
      active.state = Object.assign(MaskEngine.getState(), { revision:state.revision || 0, migrated:migrated });
      workspaces.activeId = message.args[0];
      active = workspaces.items[workspaces.activeId];
      active.lastUsedAt = Date.now();
      state = active.state || emptyState();
      migrated = (state.migrated || []).slice();
      MaskEngine.setState(state);
    } else if(message.operation === "renameWorkspace"){
      active.name = cleanName(message.args[0]);
    } else if(message.operation === "setWorkspaceRetention"){
      active.retentionDays = message.args[0];
    } else if(message.operation === "deleteWorkspace"){
      var deleteId = message.args[0];
      if(!workspaces.items[deleteId]) throw new Error("Proje bulunamadı.");
      if(Object.keys(workspaces.items).length === 1) throw new Error("Son proje silinemez.");
      delete workspaces.items[deleteId];
      if(workspaces.activeId === deleteId){
        workspaces.activeId = Object.keys(workspaces.items)[0];
        active = workspaces.items[workspaces.activeId];
        active.lastUsedAt = Date.now();
        state = active.state || emptyState();
        migrated = (state.migrated || []).slice();
        MaskEngine.setState(state);
      }
    }

    if(message.operation === "init" && message.legacy && !migrated.includes(origin)){
      var legacy;
      try{ legacy = JSON.parse(message.legacy); }
      catch(error){ throw new Error("Eski sözlük JSON biçiminde okunamadı; kaynak korundu."); }
      var entries = Array.isArray(legacy) ? legacy : legacy.glossary;
      if(!Array.isArray(entries)) throw new Error("Eski sözlük okunamadı; eski kayıt korundu.");
      // Eski kopya sitenin localStorage'ından gelir; site onu değiştirebilir.
      // Aşırı büyük bir kopya ortak sözlüğü şişirip her işlemi yavaşlatmasın.
      if(entries.length > 50000) throw new Error("Eski sözlük beklenmeyecek kadar büyük; aktarılmadı, kaynak korundu.");
      if(message.args[0] === "archive"){
        var backupKey = KEY + "_legacy_backups";
        backup = (await chrome.storage.local.get(backupKey))[backupKey] || {};
        backup[origin] = legacy;
      } else {
      MaskEngine.importGlossary(entries);
      var merged = MaskEngine.getState();
      var oldCounters = legacy.counters || {};
      Object.keys(oldCounters).forEach(function(type){
        if(Object.prototype.hasOwnProperty.call(MaskEngine.TYPE_LABELS, type) && Number.isSafeInteger(oldCounters[type]) && oldCounters[type] > 0){
          merged.counters[type] = Math.max(merged.counters[type] || 0, oldCounters[type]);
        }
      });
      /* Hariç tutma listesi YALNIZ uzantı sayfasının eski kopyasından alınır.
         Bir AI sitesi kendi localStorage'ına sahte bir "eski sözlük" koyup
         hariç tutma listesine istediği değeri (ör. kullanıcının e-postası)
         ekleyebilirdi: o değer bundan sonra hiçbir sitede maskelenmezdi.
         Sözlük kayıtları ise taşınır — eski sohbetleri geri açmak için gerekli,
         çakışanları importGlossary zaten reddeder. */
      (origin === "extension" ? (legacy.excluded || []) : []).forEach(function(item){
        if(item && typeof item.value === "string" && Object.prototype.hasOwnProperty.call(MaskEngine.TYPE_LABELS, item.type) &&
           !merged.excluded.some(function(e){ return e.type === item.type && e.value === item.value; })){
          merged.excluded.push({ type: item.type, value: item.value });
        }
      });
      MaskEngine.setState(merged);
      }
      migrated.push(origin);
    }

    var workspaceOperation = ["createWorkspace", "switchWorkspace", "renameWorkspace", "deleteWorkspace", "setWorkspaceRetention"].includes(message.operation);
    var result = (message.operation === "init" || workspaceOperation) ? null : MaskEngine[message.operation].apply(null, message.args);
    var next = Object.assign(MaskEngine.getState(), { revision: (state.revision || 0) + 1, migrated: migrated });
    Object.keys(next.counters || {}).forEach(function(type){
      workspaces.globalCounters[type] = Math.max(workspaces.globalCounters[type] || 0, next.counters[type] || 0);
    });
    active = workspaces.items[workspaces.activeId];
    active.state = next;
    active.lastUsedAt = Date.now();
    var responseState = Object.assign({}, next, { workspaceInfo:workspaceInfo(workspaces) });
    // Başarı yanıtı ancak kalıcı kayıt tamamlanınca gönderilir. Kota hatasında çıktı teslim edilmez.
    if(message.operation !== "unmaskText"){
      // KEY aktif projenin uyumluluk aynasıdır; workspaceInfo eklemek diğer
      // açık uzantı bağlamlarının proje değişimini de anında görmesini sağlar.
      var update = { [KEY]: responseState, [WORKSPACE_KEY]:workspaces };
      if(backup) update[KEY + "_legacy_backups"] = backup;
      // Kullanıcının Temizle işlemi eski sözlük yedeklerindeki hassas değerleri de siler.
      if(message.operation === "clearGlossary") update[KEY + "_legacy_backups"] = {};
      await chrome.storage.local.set(update);
    }
    else next.revision = state.revision || 0;
    return { ok: true, result: result === undefined ? null : result, state: responseState };
  }

  // Tek dağıtıcı: kanallar aynı dinleyicide ayrılır.
  chrome.runtime.onMessage.addListener(function(message, sender, respond){
    if(message && message.channel === "masko-ayar") return ayarIstegi(sender, respond);
    if(!message || message.channel !== "mask-glossary") return;
    var operation = queue.then(function(){ return execute(message, sender); });
    queue = operation.catch(function(){});
    operation.then(respond, function(error){ respond({ ok: false, error: error.message || "Sözlük kaydedilemedi.", code: error.code }); });
    return true;
  });

  /* Site ve uyarı pilotu ayarları. storage.local TRUSTED_CONTEXTS'e kısıtlı
     olduğundan içerik betikleri ayarı buradan mesajla alır; popup'ta değişince
     açık AI sekmelerine itilir. Yalnız kendi sitelerimizdeki içerik betikleri
     ve uzantı sayfaları sorabilir (senderOrigin). */
  // masko_dil: arayüz dili (uzantı sayfaları yazar; kumanda ve yer tutucular izler)
  var AYAR_ANAHTARLARI = ["maskeleme_site_settings", "maskeleme_preflight_enabled", "maskeleme_paste_guard", "masko_dil"];
  var SITE_DESENLERI = Array.from(sites).map(function(origin){ return origin + "/*"; });

  function ayarlariOku(){
    return chrome.storage.local.get(AYAR_ANAHTARLARI).then(function(kayit){
      return { siteler: kayit.maskeleme_site_settings || {}, preflight: kayit.maskeleme_preflight_enabled !== false,
        pasteGuard: kayit.maskeleme_paste_guard !== false,
        dil: kayit.masko_dil === "en" || kayit.masko_dil === "tr" ? kayit.masko_dil : null };
    });
  }

  function ayarIstegi(sender, respond){
    try{ senderOrigin(sender); }
    catch(error){ respond({ ok: false, error: error.message }); return; }
    accessReady.then(ayarlariOku).then(function(ayar){ respond({ ok: true, ayar: ayar }); },
      function(error){ respond({ ok: false, error: error.message || "Ayarlar okunamadı." }); });
    return true;
  }

  // Sohbet sitelerinden gelen maskeleme burada çalışır: yer tutucu dili ayara uyar
  function yerTutucuDiliniAyarla(dil){
    if(MaskEngine.setPlaceholderLanguage && (dil === "en" || dil === "tr")) MaskEngine.setPlaceholderLanguage(dil);
  }
  accessReady.then(function(){ return chrome.storage.local.get("masko_dil"); })
    .then(function(kayit){ yerTutucuDiliniAyarla(kayit.masko_dil); }).catch(function(){});

  chrome.storage.onChanged.addListener(function(changes, area){
    if(area === "local" && changes.masko_dil) yerTutucuDiliniAyarla(changes.masko_dil.newValue);
    if(area !== "local" || !AYAR_ANAHTARLARI.some(function(k){ return changes[k]; })) return;
    ayarlariOku().then(function(ayar){
      // url süzgeci host izinleriyle çalışır; reddedilirse tüm sekmelere
      // gönderilir (mesaj yalnız bizim içerik betiğimize ulaşır, diğerleri reddeder).
      var sorgu = chrome.tabs.query({ url: SITE_DESENLERI }).catch(function(){ return chrome.tabs.query({}); });
      return sorgu.then(function(sekmeler){
        sekmeler.forEach(function(sekme){
          // İçerik betiği olmayan (henüz yüklenmemiş) sekme reddeder; önemsiz.
          chrome.tabs.sendMessage(sekme.id, { channel: "masko-ayar", ayar: ayar }).catch(function(){});
        });
      });
    }).catch(function(){});
  });
})();
