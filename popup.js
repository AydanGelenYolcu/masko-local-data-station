(async function(){
  "use strict";

  function showError(error){
    var status = document.getElementById("ocrStatus");
    status.hidden = false;
    status.setAttribute("role", "alert");
    status.textContent = error.message || "Sözlüğe erişilemedi.";
  }
  MaskEngine.onError = showError;
  try{ await MaskEngine.init(); }catch(error){ showError(error); return; }

  var maskInput = document.getElementById("popMaskInput");
  var maskBtn = document.getElementById("popMaskBtn");
  var addSelectionBtn = document.getElementById("popAddSelection");
  var summaryWrap = document.getElementById("popSummary");
  var outputWrap = document.getElementById("popOutputWrap");
  var maskOutput = document.getElementById("popMaskOutput");
  var copyOutputBtn = document.getElementById("popCopyOutput");

  var unmaskInput = document.getElementById("popUnmaskInput");
  var unmaskBtn = document.getElementById("popUnmaskBtn");
  var unmaskOutputWrap = document.getElementById("popUnmaskOutputWrap");
  var unmaskOutput = document.getElementById("popUnmaskOutput");
  var copyUnmaskOutputBtn = document.getElementById("popCopyUnmaskOutput");

  var ocrStatus = document.getElementById("ocrStatus");

  function renderWorkspace(){
    if(!MaskEngine.getWorkspaces) return;
    var info = MaskEngine.getWorkspaces();
    var active = info.items.find(function(item){ return item.id === info.activeId; });
    document.getElementById("popWorkspaceName").textContent = active ? active.name : "Genel";
  }
  renderWorkspace();
  if(MaskEngine.onStateChange) MaskEngine.onStateChange(renderWorkspace);

  function renderSummary(counts){
    summaryWrap.innerHTML = "";
    Object.keys(counts).forEach(function(type){
      summaryWrap.appendChild(MaskEngine.summaryChip(type, counts[type]));
    });
  }

  function flashButton(btn, text){
    var original = btn.textContent;
    btn.textContent = text;
    setTimeout(function(){ btn.textContent = original; }, 1400);
  }

  async function runMaskOnly(){
    var text = maskInput.value;
    if(!text.trim()) return null;
    var masked = await MaskEngine.maskText(text);
    maskOutput.value = masked;
    outputWrap.hidden = false;
    renderSummary(MaskEngine.computeSummary(masked));
    return masked;
  }

  async function performMaskAndCopy(){
    var masked = await runMaskOnly();
    if(masked === null) return;
    var findings = MaskEngine.inspectSensitive(masked);
    var placeholders = (masked.match(/\[[A-Z]+_\d+\]/g) || []).length;
    var message = masked.length.toLocaleString("tr-TR") + " karakter · " + placeholders + " maske · " + findings.length + " kalan hassas aday.\n\nPanoya kopyalansın mı?";
    if(!window.confirm(message)) return;
    MaskEngine.copyToClipboard(masked, function(){
      flashButton(maskBtn, "Kopyalandı ✓ — hedef kutuya yapıştırın");
    });
  }

  maskBtn.addEventListener("click", performMaskAndCopy);

  copyOutputBtn.addEventListener("click", function(){
    if(!maskOutput.value) return;
    var findings = MaskEngine.inspectSensitive(maskOutput.value);
    if(!window.confirm(findings.length + " kalan hassas aday bulundu. Son kontrolü onaylayıp kopyalamak istiyor musunuz?")) return;
    MaskEngine.copyToClipboard(maskOutput.value, function(){
      flashButton(copyOutputBtn, "Kopyalandı");
    });
  });

  addSelectionBtn.addEventListener("click", async function(){
    var selected = maskInput.value.slice(maskInput.selectionStart, maskInput.selectionEnd).trim();
    if(!selected){
      flashButton(addSelectionBtn, "Önce metinde bir yer seçin");
      return;
    }
    var added = await MaskEngine.addTerm(selected, "secim");
    if(added){
      await runMaskOnly();
    }
    flashButton(addSelectionBtn, added ? "Eklendi ✓" : "Zaten sözlükte");
  });

  async function runUnmask(){
    var text = unmaskInput.value;
    if(!text.trim()) return null;
    var result = await MaskEngine.unmaskText(text);
    unmaskOutput.value = result;
    unmaskOutputWrap.hidden = false;
    return result;
  }

  unmaskBtn.addEventListener("click", async function(){
    var result = await runUnmask();
    if(result === null) return;
    MaskEngine.copyToClipboard(result, function(){
      flashButton(unmaskBtn, "Kopyalandı ✓");
    });
  });

  copyUnmaskOutputBtn.addEventListener("click", function(){
    if(!unmaskOutput.value) return;
    MaskEngine.copyToClipboard(unmaskOutput.value, function(){
      flashButton(copyUnmaskOutputBtn, "Kopyalandı");
    });
  });

  MaskEngine.wireOcrPaste(maskInput, ocrStatus, function(text){
    if(text){ performMaskAndCopy(); }
  });

  document.querySelectorAll(".mode-tab").forEach(function(tab){
    tab.addEventListener("click", function(){
      var mode = tab.getAttribute("data-mode");
      document.querySelectorAll(".mode-tab").forEach(function(t){
        var active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      document.querySelectorAll(".mode-panel").forEach(function(panel){
        panel.hidden = panel.getAttribute("data-panel") !== mode;
      });
    });
  });

  
  /* ---------- P-01 & M-10: SİTE İZİNLERİ VE UYARI PİLOTU AYARLARI ---------- */
  var feedbackEl = document.getElementById("settingsFeedback");
  function showFeedback(text){
    if(!feedbackEl) return;
    feedbackEl.textContent = text;
    feedbackEl.hidden = false;
    setTimeout(function(){ feedbackEl.hidden = true; }, 2200);
  }

  var siteCheckboxes = [
    document.getElementById("permChatgpt"),
    document.getElementById("permClaude"),
    document.getElementById("permGemini"),
    document.getElementById("permAistudio")
  ].filter(Boolean);

  var preflightToggle = document.getElementById("preflightToggle");
  var pasteGuardToggle = document.getElementById("pasteGuardToggle");

  function loadSettings(){
    var localSettings = {};
    try{ localSettings = JSON.parse(localStorage.getItem("maskeleme_site_settings") || "{}"); }catch(e){}
    var localPreflight = localStorage.getItem("maskeleme_preflight_enabled");

    if(preflightToggle && localPreflight !== null){
      preflightToggle.checked = localPreflight === "true";
    }

    siteCheckboxes.forEach(function(cb){
      var domain = cb.getAttribute("data-domain");
      if(localSettings[domain] !== undefined){
        cb.checked = !!localSettings[domain];
      }
    });

    if(typeof chrome !== "undefined" && chrome.storage && chrome.storage.local){
      chrome.storage.local.get(["maskeleme_site_settings", "maskeleme_preflight_enabled", "maskeleme_paste_guard"], function(res){
        if(!res) return;
        if(pasteGuardToggle) pasteGuardToggle.checked = res.maskeleme_paste_guard !== false;
        if(res.maskeleme_preflight_enabled !== undefined && preflightToggle){
          preflightToggle.checked = !!res.maskeleme_preflight_enabled;
        }
        if(res.maskeleme_site_settings){
          var s = res.maskeleme_site_settings;
          siteCheckboxes.forEach(function(cb){
            var domain = cb.getAttribute("data-domain");
            if(s[domain] !== undefined) cb.checked = !!s[domain];
          });
        }
      });
    }

    if(typeof chrome !== "undefined" && chrome.permissions && chrome.permissions.contains){
      siteCheckboxes.forEach(function(cb){
        var origins = (cb.getAttribute("data-origins") || "").split(",").map(function(s){ return s.trim(); }).filter(Boolean);
        if(origins.length){
          chrome.permissions.contains({ origins: origins }, function(hasPerm){
            if(typeof hasPerm === "boolean" && !hasPerm){
              cb.checked = false;
            }
          });
        }
      });
    }
  }

  function saveSiteSettings(){
    var settings = {};
    siteCheckboxes.forEach(function(cb){
      var domain = cb.getAttribute("data-domain");
      settings[domain] = cb.checked;
    });
    try{ localStorage.setItem("maskeleme_site_settings", JSON.stringify(settings)); }catch(e){}
    if(typeof chrome !== "undefined" && chrome.storage && chrome.storage.local){
      chrome.storage.local.set({ maskeleme_site_settings: settings });
    }
    showFeedback("Site tercihleri kaydedildi ✓");
  }

  // Site erişimi manifest'te zorunlu (host_permissions) olduğundan izin
  // kaldırılamaz; eski permissions.remove çağrısı her seferinde sessizce
  // başarısız oluyordu. Anahtar yalnız o sitede enjeksiyonu kapatır; service
  // worker değişikliği açık sekmelere iletir.
  siteCheckboxes.forEach(function(cb){
    cb.addEventListener("change", saveSiteSettings);
  });

  if(pasteGuardToggle){
    pasteGuardToggle.addEventListener("change", function(){
      var val = pasteGuardToggle.checked;
      if(typeof chrome !== "undefined" && chrome.storage && chrome.storage.local){
        chrome.storage.local.set({ maskeleme_paste_guard: val });
      }
      showFeedback(val ? "Yapıştırırken maskeleme açıldı ✓" : "Yapıştırırken maskeleme kapatıldı — yapıştırılan veri siteye ham gider");
    });
  }

  if(preflightToggle){
    preflightToggle.addEventListener("change", function(){
      var val = preflightToggle.checked;
      try{ localStorage.setItem("maskeleme_preflight_enabled", String(val)); }catch(e){}
      if(typeof chrome !== "undefined" && chrome.storage && chrome.storage.local){
        chrome.storage.local.set({ maskeleme_preflight_enabled: val });
      }
      showFeedback(val ? "Gönderim öncesi uyarı açıldı ✓" : "Gönderim öncesi uyarı kapatıldı");
    });
  }

  loadSettings();

  document.getElementById("openFull").addEventListener("click", function(){
    var url = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) 
              ? chrome.runtime.getURL("index.html") 
              : "index.html";
    if(typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create){
      chrome.tabs.create({ url: url });
    } else {
      window.open(url, "_blank");
    }
    window.close();
  });
})();
