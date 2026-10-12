/* Uzantı bağlamlarında asenkron sözlük istemcisi. Yerel HTML kullanımı senkrondur. */
(function(){
  "use strict";
  if(typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) return;

  var KEY = "maskeleme_istasyonu_sozluk_v1";
  var engine = window.MaskEngine;
  var ready = null;
  var revision = -1;
  var listeners = [];
  var workspaceInfo = { activeId:null, items:[] };
  var operations = ["maskText", "unmaskText", "addTerm", "addManualTerm", "deleteEntry",
    "restoreEntry", "excludeEntryById", "unexcludeEntry", "clearGlossary", "importGlossary"];

  function apply(state){
    if(!state) return;
    var incomingActive = state.workspaceInfo && state.workspaceInfo.activeId;
    if(incomingActive === workspaceInfo.activeId && state.revision < revision) return;
    revision = state.revision;
    if(state.workspaceInfo) workspaceInfo = state.workspaceInfo;
    engine.setState(state);
    listeners.forEach(function(listener){ listener(); });
  }

  async function request(operation, args, legacy){
    var reply = await chrome.runtime.sendMessage({ channel: "mask-glossary", operation: operation,
      args: args || [], legacy: legacy || null });
    if(!reply || !reply.ok){
      var error = new Error(reply && reply.error || "Ortak sözlüğe erişilemedi. Uzantıyı ve sayfayı yenileyin.");
      error.code = reply && reply.code;
      throw error;
    }
    apply(reply.state);
    return reply.result;
  }

  engine.init = function(){
    if(!ready){
      ready = (async function(){
        var legacy = null;
        try{ legacy = window.localStorage.getItem(KEY); }catch(e){}
        await request("init", [], legacy);
        // Yalnızca başarılı aktarım sonrasında eski, site tarafından okunabilir kopyayı kaldır.
        if(legacy){ try{ window.localStorage.removeItem(KEY); }catch(e){} }
      })().catch(function(error){
        ready = null;
        if(error.code === "GLOSSARY_CONFLICT") offerLegacyRecovery();
        throw error;
      });
    }
    return ready;
  };

  engine.archiveLegacy = async function(){
    var legacy = window.localStorage.getItem(KEY);
    await request("init", ["archive"], legacy);
    window.localStorage.removeItem(KEY);
    ready = Promise.resolve();
  };

  function offerLegacyRecovery(){
    if(typeof document === "undefined" || document.getElementById("mask-legacy-recovery")) return;
    var box = document.createElement("section");
    box.id = "mask-legacy-recovery";
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;inset:16px 16px auto auto;max-width:380px;padding:16px;background:#fff;color:#222;border:2px solid #b45309;z-index:2147483647;font:14px/1.5 sans-serif";
    var notice = document.createElement("p");
    notice.textContent = "Eski sözlükte bazı maskeler ortak sözlükten farklı değerlere ait. Eski sohbetleri geri açmak için önce bu sözlüğü indirin. Ortak sözlüğe geçerseniz yeni işlemler ortak karşılıkları kullanır; eski sözlük uzantıda yedeklenir.";
    var download = document.createElement("button");
    download.textContent = "Eski sözlüğü indir";
    download.onclick = function(){
      var raw = window.localStorage.getItem(KEY);
      var link = document.createElement("a");
      var url = URL.createObjectURL(new Blob([raw || "{}"], { type: "application/json" }));
      link.href = url;
      link.download = "eski-maskeleme-sozlugu.json";
      link.click();
      setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    };
    var proceed = document.createElement("button");
    proceed.textContent = "Yedekle ve ortak sözlüğe geç";
    proceed.onclick = async function(){
      proceed.disabled = true;
      try{ await engine.archiveLegacy(); window.location.reload(); }
      catch(error){ notice.textContent = error.message; proceed.disabled = false; }
    };
    box.appendChild(notice);
    box.appendChild(download);
    box.appendChild(proceed);
    document.body.appendChild(box);
  }

  operations.forEach(function(operation){
    engine[operation] = async function(){
      var args = Array.prototype.slice.call(arguments);
      try{
        await engine.init();
        return await request(operation, args);
      }catch(error){
        if(engine.onError) engine.onError(error);
        throw error;
      }
    };
  });

  engine.onStateChange = function(listener){ listeners.push(listener); };
  engine.getWorkspaces = function(){ return JSON.parse(JSON.stringify(workspaceInfo)); };
  ["createWorkspace", "switchWorkspace", "renameWorkspace", "deleteWorkspace", "setWorkspaceRetention"].forEach(function(operation){
    engine[operation] = async function(){
      var args = Array.prototype.slice.call(arguments);
      await engine.init();
      return request(operation, args);
    };
  });
  chrome.storage.onChanged.addListener(function(changes, area){
    if(area === "local" && changes[KEY]) apply(changes[KEY].newValue);
  });
})();
