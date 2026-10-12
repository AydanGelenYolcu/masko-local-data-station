/* =====================================================
   DEDUP UI — Kullanıcı Arayüzü Mantığı
   =====================================================
   • Dosya yükleme (drag & drop + tıklama + klavye)
   • Sanal kaydırmalı veri tablosu (spacer satırlı — sütun hizası korunur)
   • Sütun sekmesi seçimi & COUNTIF sonuç paneli
   • Satır seçimi, toplu işlemler, dışa aktarma
   • Tüm etkileşimler olay delegasyonuyla bağlanır (MV3 CSP uyumlu)
   ===================================================== */

(() => {
  'use strict';

  /* Dil sarmalayıcı: dil.js varsa sözlükten çevirir, yoksa şablonu olduğu
     gibi döner (Node testleri / dil tr-TR). */
  const mt = function(metin){
    if (typeof window !== 'undefined' && window.MaskoDil && window.MaskoDil.t) {
      return window.MaskoDil.t.apply(null, arguments);
    }
    const degerler = Array.prototype.slice.call(arguments, 1);
    return String(metin).replace(/\{(\d+)(:t)?\}/g, function(_, i){
      return degerler[i] !== undefined ? String(degerler[i]) : '';
    });
  };

  /* ---------- DOM REFERANSLARI ---------- */
  const $ = id => document.getElementById(id);

  const dropzoneScreen  = $('dropzone-screen');
  const mainScreen      = $('main-screen');
  const dropzone        = $('dropzone');
  const fileInput       = $('file-input');
  const loadingBar      = $('loading-bar');
  const loadingProgress = $('loading-progress');
  const loadingText     = $('loading-text');
  const loadError       = $('load-error');
  const loadErrorText   = $('load-error-text');
  const btnRetry        = $('btn-retry');
  const loadStatusA     = $('load-status-a');

  const fileInfoEl    = $('file-info');
  const columnBand    = $('column-band');
  const columnTabs    = $('column-tabs');
  const rowCounter    = $('row-counter');
  const dupCounter    = $('dup-counter');
  const dataThead     = $('data-thead');
  const dataTbody     = $('data-tbody');
  const scrollContainer = $('table-scroll-container');
  const analysisContent = $('analysis-content');
  const selectionInfo   = $('selection-info');
  const toastRegion     = $('toast-region');

  const btnBack          = $('btn-back');
  const btnExportClean   = $('btn-export-clean');
  const btnExportDeleted = $('btn-export-deleted');
  const btnKeepFirst     = $('btn-keep-first');
  const btnKeepSecond    = $('btn-keep-second');
  const btnKeepLast      = $('btn-keep-last');
  const btnDeleteDuplicates = $('btn-delete-duplicates');
  const btnDeleteSel     = $('btn-delete-selected');
  const btnRestoreAll    = $('btn-restore-all');

  const btnAntiJoin    = $('btn-anti-join');
  const ajModal        = $('anti-join-modal');
  const ajClose        = $('aj-close');
  const ajCancel       = $('aj-cancel');
  const ajFileInput    = $('aj-file-input');
  const ajFileBName    = $('aj-file-b-name');
  const ajFileCName    = $('aj-file-c-name');
  const ajSwap         = $('aj-swap');
  const ajContinue     = $('aj-continue');
  const ajLoading      = $('aj-loading');
  const ajMappingSec   = $('aj-mapping-section');
  const ajColA         = $('aj-col-a');
  const ajColB         = $('aj-col-b');
  const ajRun          = $('aj-run');

  const btnFuzzy       = $('btn-fuzzy');
  const fuzzyModal     = $('fuzzy-modal');
  const fuzzyClose     = $('fuzzy-close');
  const fuzzyDone      = $('fuzzy-done');
  const fuzzyColumn    = $('fuzzy-column');
  const fuzzyThreshold = $('fuzzy-threshold');
  const fuzzyRun       = $('fuzzy-run');
  const fuzzySummary   = $('fuzzy-summary');
  const fuzzyResults   = $('fuzzy-results');

  /* ---------- DURUM ---------- */
  let activeEngine   = DedupEngine;
  let activeColIndex = -1;   // hangi sütun analiz ediliyor
  let headers        = [];
  let visibleCols    = new Set();
  let totalRows      = 0;
  let lastFile       = null; // "Yeniden Dene" için

  // Aktif sütunun kopya değer kümesi. Scroll sırasında ASLA yeniden
  // hesaplanmaz — yalnızca sütun değişince veya işaretler değişince.
  let dupValuesSet = null;

  /* ---------- KOPYA FİLTRESİ ----------
     viewRows === null  -> bütün satırlar görünür
     viewRows           -> sadece bu satırlar görünür (Int32Array)

     Sanal kaydırma artık ham satır indeksi üzerinden değil, GÖRÜNEN
     satır listesi üzerinden çalışıyor. Böylece "sadece kopyalar"
     filtresi milyonluk dosyada da bedava: filtrelenen liste sadece
     tamsayı indeks tutuyor, satır verisi kopyalanmıyor. */
  let viewRows      = null;
  let viewPosOf     = null;   // ham satır -> görünüm konumu (-1 = görünmüyor)
  let clusterOfRow  = null;   // satır -> küme no (renklendirme için)
  let winnerRows    = null;   // küme başına "kalsın" önerilen satırlar
  let sonFiltre     = null;   // son çalışan filtre sonucu (işaretleme için)

  const viewCount  = () => (viewRows ? viewRows.length : totalRows);
  const viewRowAt  = p => (viewRows ? viewRows[p] : p);

  // Sanal kaydırma parametreleri
  const ROW_HEIGHT  = 32;   // px — CSS'teki --h-row ile senkron olmalı
  const BUFFER_ROWS = 20;   // görünür alanın üst/altına ek satırlar
  let visibleStartIdx = -1;
  let visibleEndIdx   = -1;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- KÜÇÜK YARDIMCILAR ---------- */

  // <svg class="ico"><use href="#id"/></svg> üretir
  function icon(id, cls) {
    return `<svg class="ico ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true"><use href="#${id}"/></svg>`;
  }

  function toast(message, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'toast' + (opts.danger ? ' is-danger' : '');
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);

    if (opts.actionLabel && opts.onAction) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opts.actionLabel;
      b.addEventListener('click', () => { opts.onAction(); el.remove(); });
      el.appendChild(b);
    }
    toastRegion.appendChild(el);
    setTimeout(() => el.remove(), opts.duration || 6000);
  }

  function closeFuzzy(){ if (fuzzyModal) fuzzyModal.hidden = true; }
  if (btnFuzzy) {
    btnFuzzy.addEventListener('click', () => {
      if (!headers.length) { toast('Önce bir dosya yükleyin.', { danger:true }); return; }
      if (fuzzyColumn) {
        fuzzyColumn.innerHTML = '';
        headers.forEach((header, index) => {
          const option = document.createElement('option');
          option.value = String(index);
          option.textContent = header;
          option.selected = index === activeColIndex;
          fuzzyColumn.appendChild(option);
        });
      }
      if (fuzzyResults) fuzzyResults.innerHTML = '';
      if (fuzzySummary) fuzzySummary.hidden = true;
      if (fuzzyModal) fuzzyModal.hidden = false;
      if (fuzzyRun) fuzzyRun.focus();
    });
  }
  if (fuzzyClose) fuzzyClose.addEventListener('click', closeFuzzy);
  if (fuzzyDone) fuzzyDone.addEventListener('click', closeFuzzy);
  if (fuzzyModal) fuzzyModal.addEventListener('click', e => { if (e.target === fuzzyModal) closeFuzzy(); });

  if (fuzzyRun) {
    fuzzyRun.addEventListener('click', () => {
    fuzzyRun.disabled = true;
    fuzzyRun.textContent = 'Taranıyor…';
    fuzzyResults.innerHTML = '';
    try {
      const colIndex = Number(fuzzyColumn.value);
      const result = activeEngine.findSimilarPairs(colIndex, { threshold:Number(fuzzyThreshold.value), limit:200 });
      fuzzySummary.hidden = false;
      fuzzySummary.textContent = `${formatNum(result.uniqueCount)} benzersiz değer içinde ${formatNum(result.compared)} olası çift karşılaştırıldı; ${formatNum(result.pairs.length)} aday bulundu.` +
        (result.truncated ? ' İlk 200 aday gösteriliyor.' : '') +
        (result.skippedBlocks ? ` Çok genel ${result.skippedBlocks} blok performans için atlandı.` : '');
      if (!result.pairs.length) {
        const empty = document.createElement('div');
        empty.className = 'analysis-placeholder is-ok';
        empty.textContent = 'Seçilen eşikte benzer kayıt adayı bulunamadı.';
        fuzzyResults.appendChild(empty);
      }
      result.pairs.forEach(pair => {
        const card = document.createElement('div');
        card.className = 'fuzzy-pair';
        const left = document.createElement('div');
        left.className = 'fuzzy-value';
        left.textContent = pair.leftValue;
        const leftMeta = document.createElement('small');
        leftMeta.textContent = `Dosya satırı ${pair.sourceLineLeft}`;
        left.appendChild(leftMeta);
        const score = document.createElement('span');
        score.className = 'fuzzy-score';
        score.textContent = `%${Math.round(pair.score * 100)} benzer`;
        const right = document.createElement('div');
        right.className = 'fuzzy-value';
        right.textContent = pair.rightValue;
        const rightMeta = document.createElement('small');
        rightMeta.textContent = `Dosya satırı ${pair.sourceLineRight}`;
        right.appendChild(rightMeta);
        const actions = document.createElement('div');
        const mark = document.createElement('button');
        mark.type = 'button';
        mark.className = 'btn-action btn-danger fuzzy-mark';
        mark.textContent = activeEngine.isDeleted(pair.rightRow) ? 'İşaretli' : 'İkinciyi işaretle';
        mark.disabled = activeEngine.isDeleted(pair.rightRow);
        mark.addEventListener('click', () => {
          activeEngine.markDeleted(pair.rightRow, `Benzer kayıt incelemesi: ${headers[colIndex]}`);
          mark.textContent = 'İşaretli'; mark.disabled = true;
          refreshAfterMarkChange();
          toast(`Dosya satırı ${pair.sourceLineRight} silinecek olarak işaretlendi.`, {
            danger:true, actionLabel:'Geri al', onAction:() => { activeEngine.unmarkDeleted(pair.rightRow); refreshAfterMarkChange(); }
          });
        });
        const dismiss = document.createElement('button');
        dismiss.type = 'button'; dismiss.className = 'btn-action'; dismiss.textContent = 'Ayrı kayıt';
        dismiss.addEventListener('click', () => card.remove());
        actions.appendChild(mark); actions.appendChild(dismiss);
        card.appendChild(left); card.appendChild(score); card.appendChild(right); card.appendChild(actions);
        fuzzyResults.appendChild(card);
      });
    } catch (error) {
      fuzzySummary.hidden = false;
      fuzzySummary.textContent = error.message;
    } finally {
      fuzzyRun.disabled = false;
      fuzzyRun.textContent = 'Adayları bul';
    }
  });
}

  /* ======================================================
     BÖLÜM 1: DOSYA YÜKLEME
     ====================================================== */

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', e => { e.preventDefault(); dropzone.classList.remove('dragover'); });
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

  btnRetry.addEventListener('click', () => {
    if (lastFile) handleFile(lastFile);
    else fileInput.click();
  });

  /* ======================================================
      ANTI-JOIN (KİTLE ÇIKAR) MANTIĞI
      ====================================================== */
  const ajPair = $('aj-pair'), ajBase = $('aj-base'), ajColC = $('aj-col-c');
  const ajMode = $('aj-match-mode'), ajResult = $('aj-result');
  const ajSummary = $('aj-summary'), ajPreview = $('aj-preview');
  const ajFileCInput = $('aj-file-c-input');
  const ajFileAInput = $('aj-file-a-input');
  const ajRemoveB = $('aj-remove-b');
  const ajRemoveC = $('aj-remove-c');
  const workspaceFile = $('workspace-file');
  const ajReferenceScope = $('aj-reference-scope');
  const ajOpenSource = $('aj-open-source');
  const workspaceViews = new WeakMap();
  let ajEngines = { A: activeEngine, B: null, C: null };
  let ajMatches = null;
  let ajRevision = 0;
  let ajPage = 0;
  let ajBusy = false;
  let ajSessionRevision = 0;

  function ajInvalidate() { ajRevision++; ajMatches = null; ajResult.hidden = true; ajRun.disabled = !ajReady(); }
  function ajReady() {
    const selects = { A: ajColA, B: ajColB, C: ajColC };
    return !ajBusy && [...ajPair.value].every(k => ajEngines[k] && selects[k].value !== '');
  }
  function refreshWorkspaceFiles() {
    workspaceFile.replaceChildren();
    for (const [key, engine] of Object.entries(ajEngines)) {
      if (!engine) continue;
      const option = document.createElement('option');
      option.value = key;
      option.textContent = `${key} — ${engine.getFileName()}`;
      option.selected = engine === activeEngine;
      workspaceFile.appendChild(option);
    }
  }
  function activateWorkspace(engine) {
    if (!engine) return;
    workspaceViews.set(activeEngine, { visible: new Set(visibleCols), col: activeColIndex });
    activeEngine = engine;
    headers = engine.getHeaders();
    totalRows = engine.getRowCount();
    const view = workspaceViews.get(engine);
    visibleCols = view?.visible || new Set(headers.map((_, i) => i));
    activeColIndex = -1;
    dupValuesSet = null;
    searchRevision++;
    scrollContainer.scrollTop = 0;
    columnManagerRender();
    searchSetup();
    switchToMain();
    buildUI();
    if (view?.col >= 0 && visibleCols.has(view.col)) selectColumn(view.col);
    refreshWorkspaceFiles();
    ajInvalidate();
  }
  workspaceFile.addEventListener('change', () => activateWorkspace(ajEngines[workspaceFile.value]));
  ajOpenSource.addEventListener('click', () => {
    const engine = ajEngines[ajBase.value];
    if (!engine || ajBusy) return;
    activateWorkspace(engine);
    closeAjModal();
    workspaceFile.focus();
  });
  function ajOptions(select, engine, preferredHeader) {
    const oldHeader = preferredHeader || select.selectedOptions?.[0]?.textContent || '';
    select.replaceChildren();
    if (!engine) return;
    // Seçenek metni sütun adıdır ve aşağıda eşleme için geri okunur: dil.js
    // çevirmesin ("Tarih" → "Date" olursa dosyalar arası eşleme bozulur).
    engine.getHeaders().forEach((h, i) => {
      const o = document.createElement('option'); o.value = String(i); o.textContent = h || `Sütun ${i + 1}`; o.translate = false; select.appendChild(o);
    });
    if (oldHeader) {
      const matching = [...select.options].find(o => o.textContent === oldHeader);
      if (matching) select.value = matching.value;
    }
  }
  function ajRefresh() {
    const keys = [...ajPair.value];
    // Bu başlıklar translate="no" kaptır (dosya adı veridir); metin kısmı
    // burada sözlükten geçer, dosya adı ham kalır.
    const dosyaBasligi = (el, eng) => {
      if (el) el.textContent = eng
        ? mt('{0} — {1} satır', eng.getFileName(), formatNum(eng.getRowCount()))
        : mt('Dosya seçilmedi');
    };
    dosyaBasligi($('aj-file-a-name'), ajEngines.A);
    dosyaBasligi(ajFileBName, ajEngines.B);
    dosyaBasligi(ajFileCName, ajEngines.C);
    if (ajSwap) ajSwap.disabled = ajBusy || !ajEngines.A || !ajEngines.B;
    if (ajRemoveB) ajRemoveB.disabled = ajBusy || !ajEngines.B;
    if (ajRemoveC) ajRemoveC.disabled = ajBusy || !ajEngines.C;
    [ajFileAInput, ajFileInput, ajFileCInput].forEach(el => { el.disabled = ajBusy; });
    const old = ajBase.value;
    ajBase.replaceChildren();
    keys.forEach(k => {
      const o = document.createElement('option');
      o.value = k;
      const ad = ajEngines[k]?.getFileName();
      // Dosya adı veridir; metin kısmı mt() ile burada çevrilir.
      o.textContent = ad ? `${k} — ${ad}` : mt('{0} — dosya seçilmedi', k);
      o.translate = false;
      ajBase.appendChild(o);
    });
    if (keys.includes(old) && ajEngines[old]) ajBase.value = old;
    else ajBase.value = keys.find(key => ajEngines[key]) || keys[0];
    if (ajOpenSource) ajOpenSource.disabled = ajBusy || !ajEngines[ajBase.value];
    const rowA = $('aj-col-a')?.closest('.aj-select-row, .sub-field');
    if (rowA) rowA.hidden = !keys.includes('A');
    const rowB = ajColB?.closest('.aj-select-row, .sub-field');
    if (rowB) rowB.hidden = !keys.includes('B');
    const rowC = ajColC?.closest('.aj-select-row, .sub-field, div');
    if (rowC) rowC.hidden = !keys.includes('C');
    ajInvalidate();
    refreshWorkspaceFiles();
  }

  function ajPairAfterRemoval() {
    const current = ajPair.value;
    if ([...current].every(key => ajEngines[key])) return;
    const available = new Set(Object.keys(ajEngines).filter(key => ajEngines[key]));
    const fallback = ['AB', 'AC', 'BC'].find(pair => [...pair].every(key => available.has(key)));
    ajPair.value = fallback || 'AB';
  }

  function removeAjFile(key) {
    if (ajBusy || (key !== 'B' && key !== 'C') || !ajEngines[key]) return;
    ajEngines[key] = null;
    if (key === 'B') {
      ajFileInput.value = '';
      ajOptions(ajColB, null);
    } else {
      ajFileCInput.value = '';
      ajOptions(ajColC, null);
    }
    ajPairAfterRemoval();
    ajRefresh();
    toast(`${key} dosyası oturumdan kaldırıldı.`);
  }

  function closeAjModal() {
    ajInvalidate();
    ajModal.hidden = true;
    ajMatches = null;
    ajResult.hidden = true;
    ajLoading.hidden = true;
    ajRun.disabled = true;
    btnAntiJoin.focus();
  }

  btnAntiJoin.addEventListener('click', () => {
    if (!headers.length) {
      toast('Önce ana listeyi (A) yüklemelisiniz.', { danger: true });
      return;
    }

    ajOptions(ajColA, ajEngines.A);
    if (activeColIndex >= 0 && ajEngines.A === activeEngine) ajColA.value = String(activeColIndex);
    ajOptions(ajColB, ajEngines.B);
    ajOptions(ajColC, ajEngines.C);
    ajMappingSec.hidden = false;
    ajRefresh();

    ajModal.hidden = false;
    ajModal.querySelector('.modal-body').scrollTop = 0;
    ajClose.focus();
  });

  ajClose.addEventListener('click', closeAjModal);
  ajCancel.addEventListener('click', closeAjModal);
  ajModal.addEventListener('click', e => { if (e.target === ajModal) closeAjModal(); });
  document.addEventListener('keydown', e => {
    if (ajModal.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeAjModal(); }
    if (e.key === 'Tab') {
      const targets = [...ajModal.querySelectorAll('button, input, select, a[href]')]
        .filter(el => !el.disabled && el.getClientRects().length);
      const first = targets[0], last = targets[targets.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ajModal.contains(document.activeElement))) {
        e.preventDefault(); last?.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !ajModal.contains(document.activeElement))) {
        e.preventDefault(); first?.focus();
      }
    }
  });

  async function ajLoad(e, key, select) {
    const file = e.target.files[0];
    if (!file || ajBusy) return;
    if (!await buyukDosyaOnayi(file)) { e.target.value = ''; return; }
    const session = ajSessionRevision;
    ajBusy = true;
    ajRefresh();
    ajLoading.hidden = false;
    ajLoading.textContent = `${key} okunuyor…`;
    try {
      const engine = activeEngine.createInstance();
      const secenek = { iptalMi: () => session !== ajSessionRevision };
      await engine.parseFile(file, (pct, bilgi) => {
        ajLoading.textContent = `${key} ` + okumaYazisi(pct, bilgi).toLocaleLowerCase('tr-TR');
      }, secenek);
      if (session !== ajSessionRevision) return;
      // Bu dosya sonradan çalışma alanı olarak açılabilir; sütunlarını şimdi
      // parça parça hazırla ki açılırken sayfa donmasın.
      await engine.hazirla(pct => { ajLoading.textContent = `${key} sütunları inceleniyor… %${pct}`; }, secenek);
      if (session !== ajSessionRevision) return;
      const replacedActive = ajEngines[key] === activeEngine;
      ajEngines[key] = engine;
      const preferredHeader = select.selectedOptions?.[0]?.textContent || ajColA.selectedOptions?.[0]?.textContent;
      ajOptions(select, engine, preferredHeader);
      if (replacedActive) activateWorkspace(engine);
      // C yüklendiğinde onu yalnız bellekte bırakma: karşılaştırma seçimini
      // otomatik olarak C'yi içeren moda al. Böylece kullanıcı ayrıca ABC/AC
      // seçmek zorunda kalmadan üçüncü dosyanın kullanıldığını görür.
      if (key === 'C') {
        if (ajEngines.A && ajEngines.B) ajPair.value = 'ABC';
        else if (ajEngines.A) ajPair.value = 'AC';
      }
      ajLoading.hidden = true;
    } catch (err) {
      // Hatalı dosya yeniden aynı adla seçilebilsin; başarılı seçim korunur.
      e.target.value = '';
      if (err && err.message === 'İPTAL') { ajLoading.hidden = true; return; }   // yeni ana dosya yüklendi
      ajLoading.hidden = false;
      ajLoading.textContent = `${key} okunamadı: ${err.message} Önceki dosya korundu.`;
    } finally {
      ajBusy = false;
      ajRefresh();
    }
  }
  ajFileAInput.addEventListener('change', e => ajLoad(e, 'A', ajColA));
  ajFileInput.addEventListener('change', e => ajLoad(e, 'B', ajColB));
  ajFileCInput.addEventListener('change', e => ajLoad(e, 'C', ajColC));
  ajRemoveB?.addEventListener('click', () => removeAjFile('B'));
  ajRemoveC?.addEventListener('click', () => removeAjFile('C'));
  ajSwap.addEventListener('click', () => {
    if (ajBusy || !ajEngines.A || !ajEngines.B) return;
    const aHeader = ajColA.selectedOptions?.[0]?.textContent || '';
    const bHeader = ajColB.selectedOptions?.[0]?.textContent || '';
    [ajEngines.A, ajEngines.B] = [ajEngines.B, ajEngines.A];
    ajFileInput.value = '';
    ajOptions(ajColA, ajEngines.A, bHeader);
    ajOptions(ajColB, ajEngines.B, aHeader);
    // Swapping means comparing the other file in the reverse direction.
    ajPair.value = 'AB';
    ajBase.value = 'A';
    ajRefresh();
  });
  [ajPair, ajBase, ajColA, ajColB, ajColC, ajMode, ajReferenceScope].forEach(el => el.addEventListener('change', ajRefresh));

  ajRun.addEventListener('click', async () => {
    if (!ajReady()) return;
    const revision = ajRevision;
    const pair = ajPair.value;
    const keys = [...pair];
    const baseKey = ajBase.value;
    const base = ajEngines[baseKey];
    const selects = { A: ajColA, B: ajColB, C: ajColC };
    const col = Number(selects[baseKey].value);
    const type = base.getColumnType(col);
    const options = { mode: ajMode.value };
    const activeReferencesOnly = ajReferenceScope.value === 'active';
    const exclusions = new Set();
    const previouslyDeletedRows = [...base.getDeletedSet()];
    const previouslyDeleted = new Set(previouslyDeletedRows);
    ajRun.disabled = true;
    ajLoading.hidden = false;
    try {
      const exclusionMap = new Map();
      for (const key of keys.filter(k => k !== baseKey)) {
        const engine = ajEngines[key], index = Number(selects[key].value);
        ajLoading.textContent = `${key} eşleşmeleri hazırlanıyor…`;
        for (let i = 0; i < engine.getRowCount(); i++) {
          if (activeReferencesOnly && engine.isDeleted(i)) continue;
          const norm = base.normalizeAs(engine.getCellValue(i, index), type, options);
          if (norm) {
            exclusions.add(norm);
            if (!exclusionMap.has(norm)) exclusionMap.set(norm, `${key} listesi (${engine.getFileName() || key})`);
          }
          if (i % 25000 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (revision !== ajRevision || ajModal.hidden) return;
          }
        }
      }
      const matched = new Uint8Array(base.getRowCount());
      let count = 0;
      const matchedRows = [], keptRows = [];
      const matchDetails = new Map();
      ajLoading.textContent = `${baseKey} karşılaştırılıyor…`;
      for (let i = 0; i < matched.length; i++) {
        const val = base.getCellValue(i, col);
        const norm = base.normalizeAs(val, type, options);
        if (previouslyDeleted.has(i)) {
          matched[i] = 1; count++;
          matchedRows.push(i);
          matchDetails.set(i, { norm, val, matchedSource: 'Önceki işlemde dışarıda bırakıldı', matched: true });
        } else if (norm && exclusions.has(norm)) {
          matched[i] = 1; count++;
          matchedRows.push(i);
          matchDetails.set(i, { norm, val, matchedSource: exclusionMap.get(norm), matched: true });
        } else {
          keptRows.push(i);
          matchDetails.set(i, { norm, val, matchedSource: null, matched: false });
        }
        if (i % 25000 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (revision !== ajRevision || ajModal.hidden) return;
        }
      }
      if (revision !== ajRevision || ajModal.hidden) return;
      ajMatches = { baseKey, base, matched, matchedRows, keptRows, col, count, pair, matchDetails, previouslyDeletedRows, compared: keys.filter(k => k !== baseKey).join(' + ') };
      ajSummary.textContent = `${baseKey} − (${ajMatches.compared}): ${formatNum(base.getRowCount())} satırdan ${formatNum(count)} satır dışarıda bırakılır, ${formatNum(base.getRowCount() - count)} satır kalır${previouslyDeletedRows.length ? ` (${formatNum(previouslyDeletedRows.length)} önceden işaretli satır dahil)` : ''}. Kaynak dosyalar değişmez.`;
      ajPage = 0;
      $('aj-view').value = 'kept';
      ajRenderPage();
      $('aj-mark').hidden = base !== activeEngine;
      ajResult.hidden = false;
      ajLoading.hidden = true;
    } catch (err) { ajLoading.textContent = 'Karşılaştırma hatası: ' + err.message; }
    finally {
      if (revision === ajRevision) { ajRun.disabled = !ajReady(); }
    }
  });
  function ajRenderPage() {
    if (!ajMatches) return;
    const { base, col, matchDetails, matched } = ajMatches;
    const isMatchedView = $('aj-view').value === 'matched';
    const rows = isMatchedView ? ajMatches.matchedRows : ajMatches.keptRows;
    const pageCount = Math.max(1, Math.ceil(rows.length / 50));
    ajPage = Math.min(ajPage, pageCount - 1);
    $('aj-page').textContent = `${formatNum(ajPage + 1)} / ${formatNum(pageCount)} · ${formatNum(rows.length)} satır`;
    $('aj-prev').disabled = ajPage === 0;
    $('aj-next').disabled = ajPage + 1 >= pageCount;
    const pageRows = rows.slice(ajPage * 50, (ajPage + 1) * 50);
    
    ajPreview.replaceChildren();
    if (!pageRows.length) {
      ajPreview.textContent = 'Bu grupta satır yok.';
      return;
    }

    pageRows.forEach(i => {
      const lineBox = document.createElement('div');
      lineBox.className = 'aj-row-item';
      lineBox.style.padding = '0.35rem 0.5rem';
      lineBox.style.borderBottom = '1px solid var(--rule)';
      lineBox.style.display = 'flex';
      lineBox.style.justifyContent = 'space-between';
      lineBox.style.alignItems = 'center';
      lineBox.style.fontSize = '0.82rem';

      const d = matchDetails.get(i) || { norm:'', val:base.getCellValue(i, col), matched: !!matched[i] };
      const statusText = matched[i] ? mt('Çıkarılacak ({0})', d.matchedSource || 'Elle seçildi') : mt('Tutulacak');

      const infoSpan = document.createElement('span');
      infoSpan.innerHTML = `<strong>${mt('Satır {0}', base.getSourceLine(i))}</strong>: ${escHtml(base.getHeaders()[col])} = "${escHtml(d.val)}" <span style="color:var(--ink-muted);">[${mt('eşleşme değeri: "{0}"', escHtml(d.norm))}]</span> → <span style="font-weight:600; color:${matched[i] ? 'var(--danger)' : 'var(--ok)'};">${escHtml(statusText)}</span>`;
      lineBox.appendChild(infoSpan);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn-action';
      toggleBtn.style.fontSize = '0.72rem';
      toggleBtn.style.padding = '0.2rem 0.45rem';
      toggleBtn.textContent = matched[i] ? 'Tutmaya Zorla' : 'Çıkarmaya Zorla';
      toggleBtn.addEventListener('click', () => {
        matched[i] = 1 - matched[i];
        if (matched[i]) {
          ajMatches.matchedRows.push(i);
          ajMatches.keptRows = ajMatches.keptRows.filter(r => r !== i);
        } else {
          ajMatches.keptRows.push(i);
          ajMatches.matchedRows = ajMatches.matchedRows.filter(r => r !== i);
        }
        ajMatches.count = ajMatches.matchedRows.length;
        ajMatches.matchDetails.get(i).matched = !!matched[i];
        ajSummary.textContent = `${ajMatches.baseKey} − (${ajMatches.compared}): ${formatNum(base.getRowCount())} satırdan ${formatNum(ajMatches.count)} eşleşme çıkarılır, ${formatNum(base.getRowCount() - ajMatches.count)} satır kalır (elle güncellendi).`;
        ajRenderPage();
      });
      lineBox.appendChild(toggleBtn);
      ajPreview.appendChild(lineBox);
    });
  }
  $('aj-view').addEventListener('change', () => { ajPage = 0; ajRenderPage(); });
  $('aj-prev').addEventListener('click', () => { ajPage--; ajRenderPage(); });
  $('aj-next').addEventListener('click', () => { ajPage++; ajRenderPage(); });
  function ajApplyToEngine(result) {
    result.base.getDeletedSet().forEach(i => {
      if (!result.matched[i]) result.base.unmarkDeleted(i);
    });
    result.base.markRowsDeleted(result.matchedRows, `Anti-Join: ${result.compared}`);
  }
  $('aj-mark').addEventListener('click', () => {
    if (!ajMatches || ajMatches.base !== activeEngine) return;
    ajApplyToEngine(ajMatches);
    refreshAfterMarkChange();
    toast(`${formatNum(ajMatches.count)} eşleşen satır işaretlendi.`);
  });
  ajContinue.addEventListener('click', () => {
    if (!ajMatches) return;
    const { base, count, compared } = ajMatches;
    const previousSlots = { ...ajEngines };
    const previousHeaders = {
      A: ajColA.selectedOptions?.[0]?.textContent || '',
      B: ajColB.selectedOptions?.[0]?.textContent || '',
      C: ajColC.selectedOptions?.[0]?.textContent || ''
    };
    const sourceSlot = ['A', 'B', 'C'].find(key => previousSlots[key] === base) || 'A';
    ajApplyToEngine(ajMatches);
    if (sourceSlot !== 'A') {
      ajEngines.A = base;
      ajEngines[sourceSlot] = previousSlots.A;
    }
    ajFileInput.value = '';
    ajFileCInput.value = '';
    activateWorkspace(base);
    const selects = { A: ajColA, B: ajColB, C: ajColC };
    ['A', 'B', 'C'].forEach(key => {
      const oldKey = key === 'A' ? sourceSlot : (key === sourceSlot ? 'A' : key);
      ajOptions(selects[key], ajEngines[key], previousHeaders[oldKey]);
    });
    ajPair.value = 'AB';
    ajBase.value = 'A';
    ajRefresh();
    closeAjModal();
    tabBtnDedup?.click();
    workspaceFile.focus();
    toast(`${formatNum(activeEngine.getActiveRowCount())} kalan satır tekilleştirmeye hazır; ${formatNum(count)} eşleşen satır dışarıda bırakıldı.`);
  });
  $('aj-export').addEventListener('click', async () => {
    if (!ajMatches) return;
    const { base, baseKey, matched, pair } = ajMatches;
    const cols = base === activeEngine ? visibleColumnIndices() : base.getHeaders().map((_, i) => i);
    try {
      await disaAktar(base.getFileName().replace(/\.[^.]+$/, '') + `_anti_join_${pair}_${baseKey}` + exportExtension(), {
        motor: base,
        sutunlar: cols,
        satirSec: i => !matched[i],
        dizi: () => {
          const rows = [cols.map(c => base.getHeaders()[c])];
          for (let i = 0; i < matched.length; i++) if (!matched[i]) rows.push(cols.map(c => base.getCellValue(i, c)));
          return rows;
        }
      }, n => `${formatNum(n)} satırlık karşılaştırma sonucu`);
    } catch (err) { toast('Kaydetme hatası: ' + err.message, { danger:true }); }
  });

  function setProgress(pct, label) {
    if (pct === null) {
      // Belirsiz durum — küçük dosyalarda %0'da donmuş görünmesin
      loadingBar.classList.add('indeterminate');
      loadingBar.removeAttribute('aria-valuenow');
    } else {
      loadingBar.classList.remove('indeterminate');
      loadingProgress.style.width = pct + '%';
      loadingBar.setAttribute('aria-valuenow', String(pct));
    }
    if (label) loadingText.textContent = label;
  }

  /* BÜYÜK DOSYA SINIRI
     Tekilleştir dosyayı bellekte sözlük kodlu tutar. Ölçüldü: 289 MB / 5
     milyon satırlık CSV 1 GB yığın sınırında açılıyor (tepe ~960 MB, bayt
     başına ~3,3). Excel açılınca çok büyür (Veri Tezgâhı'yla aynı katsayı).
     Bütçe de Veri Tezgâhı'yla aynı: tarayıcı yığın sınırının ve cihaz
     belleğinin güvenli payı. Aşılırsa sekme çökebilir; kullanıcıya sorulur. */
  const GB = 1024 * 1024 * 1024;
  const gbYaz = b => (b / GB).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' GB';
  const mbYaz = b => (b / 1048576).toLocaleString('tr-TR', { maximumFractionDigits: 0 }) + ' MB';

  function bellekButcesi() {
    const yigin = (performance.memory && performance.memory.jsHeapSizeLimit) || 4 * GB;
    const cihaz = (navigator.deviceMemory || 8) * GB;
    return Math.min(yigin * 0.55, cihaz * 0.3);
  }

  async function buyukDosyaOnayi(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const excel = ext === 'xlsx' || ext === 'xls' || ext === 'xlsm';
    const tahmin = file.size * (excel ? 25 : 3.5);
    const butce = bellekButcesi();
    if (tahmin <= butce) return true;
    let satir = 0;
    if (!excel) {
      const ornek = await file.slice(0, 1024 * 1024).text();
      const n = (ornek.match(/\n/g) || []).length;
      if (n) satir = Math.round(file.size / (ornek.length / n));
    }
    return confirm(
      `Bu dosya (${mbYaz(file.size)}${satir ? ', yaklaşık ' + formatNum(satir) + ' satır' : ''}) Tekilleştir'de yaklaşık ${gbYaz(tahmin)} bellek ister; ` +
      `bu tarayıcı için güvenli sınır yaklaşık ${gbYaz(butce)}. Yüklenirse sekme çökebilir.\n\n` +
      `Tamam: yine de dene.\n` +
      `İptal: yükleme. Dosyayı CSV Bölme ile parçalara ayırırsanız her parçadaki kopyalar bulunur; parçalar arasındaki kopyalar bulunmaz.`);
  }

  // Okuma ilerlemesi: yüzde ve okunan satır sayısı
  function okumaYazisi(pct, bilgi) {
    return `Ayrıştırılıyor… %${pct}` + (bilgi && bilgi.satir ? ` · ${formatNum(bilgi.satir)} satır` : '');
  }

  async function handleFile(file) {
    if (!await buyukDosyaOnayi(file)) { fileInput.value = ''; return; }
    const session = ++ajSessionRevision;
    lastFile = file;
    loadError.style.display = 'none';
    loadingBar.style.display = '';
    loadingText.style.display = '';
    setProgress(null, 'Dosya okunuyor…');
    if (loadStatusA) loadStatusA.textContent = 'Liste okunuyor…';

    try {
      const nextEngine = activeEngine.createInstance();
      // Yeni bir dosya seçilirse ya da geri dönülürse bu okuma kendini durdurur.
      const secenek = { iptalMi: () => session !== ajSessionRevision };
      const result = await nextEngine.parseFile(file, (pct, bilgi) => {
        setProgress(pct, okumaYazisi(pct, bilgi));
      }, secenek);
      if (session !== ajSessionRevision) return;
      setProgress(0, 'Sütunlar inceleniyor…');
      await nextEngine.hazirla((pct, bilgi) => {
        setProgress(pct, `Sütunlar inceleniyor… ${bilgi.sutun} / ${bilgi.toplam}`);
      }, secenek);

      if (session !== ajSessionRevision) return;
      activeEngine = nextEngine;
      activeColIndex = -1;
      dupValuesSet = null;
      headers   = result.headers;
      totalRows = result.rowCount;
      ajEngines = { A: activeEngine, B: null, C: null };
      ajPair.value = 'AB';
      ajReferenceScope.value = 'all';
      ajOptions(ajColA, activeEngine);
      ajOptions(ajColB, null);
      ajOptions(ajColC, null);
      ajRefresh();
      searchRevision++;
      visibleCols = new Set(headers.map((_, i) => i));
      columnManagerRender();
      searchSetup();

      setProgress(100, 'Analiz ediliyor…');
      if (loadStatusA) loadStatusA.textContent = `${formatNum(totalRows)} satır`;

      switchToMain();
      buildUI();

    } catch (err) {
      if (err && err.message === 'İPTAL') return;   // yerini yeni bir okuma aldı
      loadingBar.style.display = 'none';
      loadingText.style.display = 'none';
      loadErrorText.textContent = 'Dosya okunamadı: ' + err.message;
      loadError.style.display = '';
      if (loadStatusA) loadStatusA.textContent = '';
      console.error(err);
    }
  }

  function switchToMain() {
    dropzoneScreen.classList.remove('active');
    mainScreen.classList.add('active');
  }

  btnBack.addEventListener('click', () => {
    searchRevision++;
    mainScreen.classList.remove('active');
    dropzoneScreen.classList.add('active');
    loadingBar.style.display = 'none';
    loadingText.style.display = 'none';
    loadError.style.display = 'none';
    fileInput.value = '';
    activeColIndex = -1;
    dupValuesSet = null;
    if (loadStatusA) loadStatusA.textContent = '';
  });

  /* ======================================================
     BÖLÜM 2: ARAYÜZ İNŞASI
     ====================================================== */

  function buildUI() {
    const info = `${activeEngine.getFileName()} — ${formatNum(totalRows)} satır, ${headers.length} sütun`;
    fileInfoEl.textContent = info;
    updateRowCounter();

    buildColumnTabs();
    buildTableHeader();
    filtreSifirla();
    searchQuery.value = '';
    searchMatches = null;
    $('search-stat').textContent = '';
    const btnSearchMark = $('search-mark');
    if (btnSearchMark) {
      btnSearchMark.disabled = true;
      btnSearchMark.textContent = 'Arama Sonuçlarını İşaretle';
      btnSearchMark.title = 'Önce solundaki "Satır ara" kutusuna bir metin yazarak satır bulun.';
    }
    filtreSutunlariCiz();
    renderTable();

    analysisContent.innerHTML =
      `<div class="analysis-placeholder">
         ${icon('i-up')}
         <strong>Bir sütun seçin</strong>
         <span>Yukarıdaki sütun sekmelerinden birine tıklayın; o sütundaki tekrar eden değerler burada listelenir.</span>
       </div>`;

    // Kullanıcıyı doğru yere bak: sekme bandını kısaca vurgula
    if (!reduceMotion) {
      columnBand.classList.add('hint-pulse');
      setTimeout(() => columnBand.classList.remove('hint-pulse'), 2600);
    }

    updateActionButtons();
    updateQuickDedupCard();
  }

  function buildColumnTabs() {
    const stats = activeEngine.allColumnStats();
    columnTabs.innerHTML = '';
    stats.forEach((s, i) => {
      if (!visibleCols.has(i)) return;
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'col-tab' + (s.dupValueCount === 0 ? ' no-dup' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', i === activeColIndex ? 'true' : 'false');
      tab.tabIndex = (activeColIndex >= 0 ? i === activeColIndex : columnTabs.childElementCount === 0) ? 0 : -1;   // roving tabindex
      tab.dataset.col = String(i);
      tab.innerHTML =
        `<span>${escHtml(s.name)}</span>` +
        `<span class="tab-count">${escHtml(s.dupValueCount > 0 ? mt('{0} kopya', formatNum(s.dupRowCount)) : mt('temiz'))}</span>`;
      // #column-tabs translate="no" kaptır: ek ve etiket burada sözlükten geçer.
      tab.setAttribute('aria-label',
        s.dupValueCount > 0
          ? mt('{0} sütunu — {1} kopya satır', s.name, s.dupRowCount)
          : mt('{0} sütunu — kopya yok', s.name));
      columnTabs.appendChild(tab);
    });
  }

  // Sekme tıklaması + ok tuşlarıyla gezinme (WAI-ARIA tablist deseni)
  columnTabs.addEventListener('click', e => {
    const tab = e.target.closest('.col-tab');
    if (tab) selectColumn(parseInt(tab.dataset.col, 10));
  });
  columnTabs.addEventListener('keydown', e => {
    const tabs = [...columnTabs.querySelectorAll('.col-tab')];
    const idx = tabs.indexOf(document.activeElement);
    if (idx < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    tabs.forEach(t => { t.tabIndex = -1; });
    tabs[next].tabIndex = 0;
    tabs[next].focus();
  });

  function buildTableHeader() {
    let html = '<tr>';
    html += '<th class="cell-check" scope="col"><input type="checkbox" id="select-all-cb" class="row-cb" aria-label="Tüm satırları silinecek olarak işaretle"></th>';
    html += '<th class="cell-rownum" scope="col">#</th>';
    // #data-table translate="no": düğme etiketleri burada sözlükten geçer
    const tekSutun = visibleCols.size === 1;
    headers.forEach((h, ci) => {
      if (!visibleCols.has(ci)) return;
      html += `<th data-col="${ci}" scope="col" title="${escAttr(h)}"><span class="th-ad">${escHtml(h)}</span>` +
        (tekSutun ? '' : `<button type="button" class="th-cikar" data-cikar="${ci}" aria-label="${escAttr(mt('{0} sütununu çıkar', h))}" title="${escAttr(mt('Sütunu tablodan ve dosyadan çıkar'))}">✕</button>`) +
        `</th>`;
    });
    html += '</tr>';
    dataThead.innerHTML = html;

    // "Tümünü seç" — yalnızca render edilmiş satırları değil, TÜM satırları
    // etkiler. (Eski davranış etiketiyle uyuşmuyordu ve sürpriz yaratıyordu.)
    $('select-all-cb').addEventListener('change', e => {
      const checked = e.target.checked;

      if (checked) {
        for (let i = 0; i < totalRows; i++) activeEngine.markDeleted(i, 'Tumu secildi');
      } else {
        activeEngine.clearAllDeleted();
      }
      refreshAfterMarkChange();

      if (checked) {
        toast(`${formatNum(totalRows)} satırın tamamı silinecek olarak işaretlendi`, {
          danger: true,
          actionLabel: 'Geri Al',
          onAction: () => {
            activeEngine.clearAllDeleted();
            e.target.checked = false;
            refreshAfterMarkChange();
          }
        });
      } else {
        toast('Tüm işaretler kaldırıldı');
      }
    });
  }

  /* ======================================================
     BÖLÜM 3: SANAL KAYDIRMALI TABLO
     ====================================================== */

  scrollContainer.addEventListener('scroll', () => {
    requestAnimationFrame(renderVisibleRows);
  });

  function renderTable() {
    visibleStartIdx = -1;          // yeniden çizimi zorla
    recomputeDupSet();
    renderVisibleRows();
    updateRowCounter();
    updateSelectionInfo();
  }

  function visibleColumnIndices() { return headers.map((_, i) => i).filter(i => visibleCols.has(i)); }
  /* ---------- SÜTUNLAR: ÇIKAR / GERİ GETİR ----------
     "Çıkar" sütunu tablodan ve indirilen dosyadan çıkarır; veri silinmez,
     "Sütunlar" panelinden geri getirilir. Çıkarılan sütun yine anahtar
     olabilir (ör. TCKN'ye göre tekilleştir, dosyaya TCKN yazma). */
  function columnManagerRender() {
    const list = $('column-manager-list'); list.replaceChildren();
    headers.forEach((h, i) => {
      const dosyada = visibleCols.has(i);
      const li = document.createElement('li');
      li.className = 'cm-row' + (dosyada ? '' : ' is-removed');
      const ad = document.createElement('span');
      ad.className = 'cm-name';
      ad.translate = false;   // sütun adı veridir
      ad.textContent = h || `Sütun ${i + 1}`;
      li.appendChild(ad);
      if (activeEngine.isAddedColumn(i)) {
        const etiket = document.createElement('span');
        etiket.className = 'cm-tag';
        etiket.textContent = 'eklendi';
        li.appendChild(etiket);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-action cm-btn';
      b.dataset.col = String(i);
      b.dataset.islem = dosyada ? 'cikar' : 'getir';
      b.textContent = dosyada ? 'Çıkar' : 'Geri getir';
      li.appendChild(b);
      list.appendChild(li);
    });
    $('column-manager-count').textContent = `${visibleCols.size} / ${headers.length}`;
    $('columns-show-all').disabled = visibleCols.size === headers.length;
  }

  // Sütun kümesi ya da görünürlüğü değişince sütuna bağlı her şey tek yerden yenilenir
  function sutunlarDegisti() {
    if (!visibleCols.has(activeColIndex)) activeColIndex = -1;
    columnManagerRender();
    buildColumnTabs();
    buildTableHeader();
    searchSetup();
    filtreSutunlariCiz(true);
    applyFilter();
    updateQuickDedupCard();
    if (activeColIndex < 0) { dupCounter.textContent = ''; analysisContent.textContent = 'Analiz için görünür bir sütun seçin.'; }
    else selectColumn(activeColIndex);
  }

  function sutunuCikar(i) {
    if (!visibleCols.has(i)) return;
    if (visibleCols.size === 1) { toast('En az bir sütun görünür kalmalı.', { danger: true }); return; }
    visibleCols.delete(i);
    sutunlarDegisti();
    toast(`"${headers[i]}" sütunu tablodan ve indirilecek dosyadan çıkarıldı.`, {
      actionLabel: 'Geri al', onAction: () => sutunuGeriGetir(i)
    });
  }

  function sutunuGeriGetir(i) {
    if (visibleCols.has(i) || i < 0 || i >= headers.length) return;
    visibleCols.add(i);
    sutunlarDegisti();
  }

  $('column-manager-list').addEventListener('click', e => {
    const b = e.target.closest('.cm-btn');
    if (!b) return;
    const i = Number(b.dataset.col);
    if (b.dataset.islem === 'cikar') sutunuCikar(i); else sutunuGeriGetir(i);
  });
  $('columns-show-all').addEventListener('click', () => {
    visibleCols = new Set(headers.map((_, i) => i));
    sutunlarDegisti();
  });
  // Sekme ekleri, hızlı seçici, sütun paneli ve başlık düğmeleri translate="no"
  // kaplarda mt() ile kurulur: dil değişince yeniden çizilir.
  if (window.MaskoDil) {
    window.MaskoDil.degisince(() => {
      if (!headers.length) return;
      buildColumnTabs();
      buildTableHeader();
      if (activeColIndex >= 0) {
        dataThead.querySelectorAll('th[data-col]').forEach(th => th.classList.toggle('col-highlight', Number(th.dataset.col) === activeColIndex));
      }
      columnManagerRender();
      filtreSutunlariCiz(true);
      updateQuickDedupCard();
      ajRefresh();
    });
  }

  // Sütunlar paneli açılır menü gibi: dışarı tıklayınca ya da Esc ile kapanır.
  // composedPath tıklama anındaki yoldur: liste yeniden çizilip düğme DOM'dan
  // çıksa da panelin içine tıklandığı bilinir.
  const columnManager = $('column-manager');
  document.addEventListener('click', e => {
    if (columnManager.open && !e.composedPath().includes(columnManager)) columnManager.open = false;
  });
  columnManager.addEventListener('keydown', e => {
    if (e.key === 'Escape' && columnManager.open) {
      columnManager.open = false;
      columnManager.querySelector('summary').focus();
    }
  });
  // Tablo başlığındaki ✕: tabloda gördüğü sütunu oradan çıkarabilsin
  dataThead.addEventListener('click', e => {
    const b = e.target.closest('[data-cikar]');
    if (b) sutunuCikar(Number(b.dataset.cikar));
  });

  /* ---------- SÜTUN EKLE ----------
     Hesap motorda yapılır (addColumn); burada yalnız tanım toplanır ve
     önizleme gösterilir. Önizleme ilk birkaç satırdan kurulur, büyük
     dosyada bile anında görünür. */
  const addcolModal       = $('addcol-modal');
  const addcolCols        = $('addcol-cols');
  const addcolSep         = $('addcol-sep');
  const addcolSource      = $('addcol-source');
  const addcolTypeNote    = $('addcol-type-note');
  const addcolValue       = $('addcol-value');
  const addcolName        = $('addcol-name');
  const addcolPreview     = $('addcol-preview');
  const addcolPreviewList = $('addcol-preview-list');
  const addcolError       = $('addcol-error');
  const addcolRun         = $('addcol-run');
  const btnAddColumn      = $('btn-add-column');
  let addcolSira = [];          // birleştirmede tıklama sırası
  let addcolAdElle = false;     // kullanıcı adı kendisi yazdıysa öneri üstüne yazılmaz
  let addcolCalisiyor = false;

  const TUR_ADI = { text: 'metin', email: 'e-posta', phone: 'telefon', id: 'kimlik / numara', name: 'ad soyad' };

  function addcolTur() {
    const r = addcolModal.querySelector('input[name="addcol-kind"]:checked');
    return r ? r.value : 'concat';
  }

  function benzersizAd(taban) {
    let ad = taban, n = 2;
    while (headers.includes(ad)) ad = `${taban}_${n++}`;
    return ad;
  }

  // Önerilen ad çıktı dosyasına başlık olarak yazılır: arayüz dilinde gelir
  function onerilenAd(tur) {
    const en = window.MaskoDil && window.MaskoDil.dil() === 'en';
    if (tur === 'concat') return addcolSira.length >= 2 ? addcolSira.map(c => headers[c]).join('_') : (en ? 'COMBINED' : 'BIRLESIK');
    if (tur === 'count') return en ? 'DUPLICATE_COUNT' : 'TEKRAR_SAYISI';
    if (tur === 'group') return en ? 'DUPLICATE_GROUP' : 'KOPYA_GRUBU';
    if (tur === 'constant') return en ? 'SOURCE' : 'KAYNAK';
    return en ? 'NEW_COLUMN' : 'YENI_SUTUN';
  }

  function addcolSutunlariCiz() {
    addcolCols.replaceChildren();
    headers.forEach((h, c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'addcol-col';
      b.dataset.col = String(c);
      const sira = addcolSira.indexOf(c);
      b.setAttribute('aria-pressed', sira >= 0 ? 'true' : 'false');
      if (sira >= 0) {
        const no = document.createElement('span');
        no.className = 'addcol-no';
        no.textContent = String(sira + 1);
        b.appendChild(no);
      }
      b.appendChild(document.createTextNode(h || `Sütun ${c + 1}`));
      addcolCols.appendChild(b);
    });
  }

  function addcolKaynakCiz() {
    addcolSource.replaceChildren();
    headers.forEach((h, c) => {
      const o = document.createElement('option');
      o.value = String(c);
      o.textContent = h || `Sütun ${c + 1}`;
      addcolSource.appendChild(o);
    });
    addcolSource.value = String(activeColIndex >= 0 ? activeColIndex : 0);
  }

  function addcolOnizle(tur) {
    addcolPreviewList.replaceChildren();
    const ornek = [];
    if (tur === 'concat' && addcolSira.length >= 2) {
      const sinir = Math.min(totalRows, 2000);
      for (let i = 0; i < sinir && ornek.length < 3; i++) {
        const parca = addcolSira.map(c => activeEngine.getCellValue(i, c)).filter(Boolean);
        if (parca.length) ornek.push(parca.join(addcolSep.value));
      }
    } else if (tur === 'constant' && addcolValue.value) {
      ornek.push(addcolValue.value);
    }
    ornek.forEach(v => {
      const li = document.createElement('li');
      li.textContent = v;
      addcolPreviewList.appendChild(li);
    });
    addcolPreview.hidden = !ornek.length;
  }

  function addcolCiz() {
    const tur = addcolTur();
    addcolModal.querySelectorAll('.addcol-section[data-addcol]').forEach(s => {
      s.hidden = !s.dataset.addcol.split(' ').includes(tur);
    });
    if (!addcolAdElle) addcolName.value = benzersizAd(onerilenAd(tur));
    if (tur === 'count' || tur === 'group') {
      const tip = activeEngine.getColumnType(Number(addcolSource.value));
      addcolTypeNote.textContent = `Değerler "${TUR_ADI[tip] || tip}" türüne göre karşılaştırılır; tüm satırlar sayılır.`;
    }
    addcolOnizle(tur);
    addcolError.hidden = true;
  }

  function addcolAc() {
    if (!headers.length) { toast('Önce bir dosya yükleyin.', { danger: true }); return; }
    addcolSira = [];
    addcolAdElle = false;
    addcolValue.value = '';
    addcolSutunlariCiz();
    addcolKaynakCiz();
    addcolCiz();
    addcolModal.hidden = false;
    const secili = addcolModal.querySelector('input[name="addcol-kind"]:checked');
    if (secili) secili.focus();
  }

  function addcolKapat() {
    if (addcolCalisiyor) return;
    addcolModal.hidden = true;
    btnAddColumn.focus();
  }

  btnAddColumn.addEventListener('click', addcolAc);
  $('addcol-close').addEventListener('click', addcolKapat);
  $('addcol-cancel').addEventListener('click', addcolKapat);
  addcolModal.addEventListener('click', e => { if (e.target === addcolModal) addcolKapat(); });
  addcolModal.addEventListener('keydown', e => { if (e.key === 'Escape') addcolKapat(); });
  $('addcol-kinds').addEventListener('change', addcolCiz);
  addcolSep.addEventListener('change', addcolCiz);
  addcolSource.addEventListener('change', addcolCiz);
  addcolValue.addEventListener('input', addcolCiz);
  addcolName.addEventListener('input', () => { addcolAdElle = addcolName.value.trim() !== ''; });
  addcolCols.addEventListener('click', e => {
    const b = e.target.closest('.addcol-col');
    if (!b) return;
    const c = Number(b.dataset.col);
    const k = addcolSira.indexOf(c);
    if (k >= 0) addcolSira.splice(k, 1); else addcolSira.push(c);
    addcolSutunlariCiz();
    addcolCiz();
    const ayni = addcolCols.querySelector(`[data-col="${c}"]`);
    if (ayni) ayni.focus();
  });

  addcolRun.addEventListener('click', async () => {
    if (addcolCalisiyor) return;
    const tur = addcolTur();
    const spec = { kind: tur, name: addcolName.value };
    if (tur === 'concat') { spec.columns = addcolSira.slice(); spec.separator = addcolSep.value; }
    if (tur === 'constant') spec.value = addcolValue.value;
    if (tur === 'count' || tur === 'group') spec.column = Number(addcolSource.value);

    const motor = activeEngine, oturum = ajSessionRevision;
    addcolCalisiyor = true;
    addcolRun.disabled = true;
    addcolRun.textContent = 'Ekleniyor…';
    addcolError.hidden = true;
    try {
      const r = await motor.addColumn(spec, { iptalMi: () => oturum !== ajSessionRevision });
      if (oturum !== ajSessionRevision || motor !== activeEngine) return;
      addcolCalisiyor = false;
      addcolModal.hidden = true;
      sutunEklendi(motor, [r.colIndex], tur === 'concat' ? r.colIndex : -1);
      toast(`"${r.header}" sütunu eklendi.`);
    } catch (err) {
      if (err && err.message === 'İPTAL') return;
      addcolError.textContent = err.message;
      addcolError.hidden = false;
    } finally {
      addcolCalisiyor = false;
      addcolRun.disabled = false;
      addcolRun.textContent = 'Sütunu ekle';
    }
  });

  // Yeni sütunlar görünür olur; liste çıkarma seçicileri de onları görür
  function sutunEklendi(motor, sutunlar, secilecek) {
    headers = motor.getHeaders();
    sutunlar.forEach(c => visibleCols.add(c));
    let ajEtkilendi = false;
    [['A', ajColA], ['B', ajColB], ['C', ajColC]].forEach(([k, sel]) => {
      if (ajEngines[k] === motor) { ajOptions(sel, motor); ajEtkilendi = true; }
    });
    if (ajEtkilendi) ajInvalidate();
    if (secilecek >= 0) activeColIndex = secilecek;
    sutunlarDegisti();
    const son = sutunlar[sutunlar.length - 1];
    const sekme = columnTabs.querySelector(`.col-tab[data-col="${son}"]`);
    if (sekme) sekme.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  const searchQuery = $('search-query'), searchColumn = $('search-column'), searchCase = $('search-case');
  let searchMatches = null;
  let searchRevision = 0;
  function searchSetup() {
    const previous = searchColumn.value;
    searchColumn.innerHTML = '<option value="all">Tüm görünür sütunlar</option>';
    visibleColumnIndices().forEach(i => { const o = document.createElement('option'); o.value = String(i); o.textContent = headers[i] || `Sütun ${i+1}`; o.translate = false; searchColumn.appendChild(o); });
    if ([...searchColumn.options].some(o => o.value === previous)) searchColumn.value = previous;
  }
  async function applySearch() {
    const revision = ++searchRevision;
    searchMatches = null;
    const btnSearchMark = $('search-mark');
    if (btnSearchMark) {
      btnSearchMark.disabled = true;
      btnSearchMark.textContent = 'Arama Sonuçlarını İşaretle';
      btnSearchMark.title = 'Önce "Satır ara" kutusuna bir metin yazarak satır bulun.';
    }
    const query = searchQuery.value.trim();
    if (!query) { $('search-stat').textContent = ''; return true; }
    $('search-stat').textContent = 'Aranıyor…';
    const cols = searchColumn.value === 'all' ? visibleColumnIndices() : [Number(searchColumn.value)];
    const needle = searchCase.checked ? query : query.toLocaleLowerCase('tr-TR');
    const candidates = viewRows;
    // Eşleşme motorda benzersiz değer başına hesaplanır; yeni arama eskisini durdurur.
    let found;
    try {
      found = await activeEngine.araSatirlar(cols, needle, searchCase.checked, candidates,
        { iptalMi: () => revision !== searchRevision });
    } catch (err) {
      if (err && err.message === 'İPTAL') return false;
      throw err;
    }
    if (revision !== searchRevision) return false;
    searchMatches = found;
    viewRows = searchMatches;
    viewPosOf = new Int32Array(totalRows).fill(-1);
    for (let p = 0; p < viewRows.length; p++) viewPosOf[viewRows[p]] = p;
    $('search-stat').textContent = `${formatNum(viewRows.length)} sonuç`;
    if (btnSearchMark) {
      btnSearchMark.disabled = viewRows.length === 0;
      btnSearchMark.textContent = viewRows.length > 0
        ? `Aramada Bulunanları İşaretle (${formatNum(viewRows.length)})`
        : 'Arama Sonuçlarını İşaretle';
      btnSearchMark.title = viewRows.length > 0
        ? `Arama kriterine uyan ${formatNum(viewRows.length)} satırı silinecek olarak işaretler.`
        : 'Eşleşen satır bulunamadı.';
    }
    return true;
  }
  let searchTimer;
  searchQuery.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilter, 180); });
  searchQuery.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      applyFilter();
    }
  });
  searchQuery.addEventListener('search', () => {
    clearTimeout(searchTimer);
    applyFilter();
  });
  [searchColumn, searchCase].forEach(el => el.addEventListener('change', applyFilter));
  $('search-mark').addEventListener('click', () => {
    if (!searchQuery.value.trim() || !searchMatches?.length) return;
    if (!confirm(`${formatNum(searchMatches.length)} arama sonucu silinecek olarak işaretlenecek. Devam edilsin mi?`)) return;
    for (const i of searchMatches) activeEngine.markDeleted(i, `Arama: ${searchQuery.value.trim()}`);
    refreshAfterMarkChange();
    toast(`${formatNum(searchMatches.length)} arama sonucu işaretlendi.`);
  });

  /* ======================================================
     KOPYA FİLTRESİ
     ======================================================
     Üç ölçüt:
       aktif  — seçili sütunda tekrar eden değerler (COUNTIF)
       kimlik — seçili sütunlardan HERHANGİ BİRİ eşleşirse aynı kişi.
                Zincirleme de yakalar: A~B mailden, B~C telefondan
                bağlanırsa üçü tek kümedir (union-find).
       grup   — seçili sütunların HEPSİ birden eşleşirse aynı kayıt.
                Tek başına kimlik olmayan alanlar için:
                "Mehmet Yılmaz" yüzlerce kişidir ama
                (ad_soyad + doğum + il) tek kişidir.
     ====================================================== */

  const fltOn      = $('flt-on');
  const fltMode    = $('flt-mode');
  const fltStat    = $('flt-stat');
  const fltColsRow = $('flt-cols-row');
  const fltChips   = $('flt-chips');
  const fltNote    = $('flt-note');
  const fltMark    = $('flt-mark');

  let secilenSutunlar = new Set();

  // koru: sütun eklenip çıkarılınca kullanıcının anahtar seçimi sıfırlanmasın
  function filtreSutunlariCiz(koru) {
    fltChips.innerHTML = '';
    if (!koru || !secilenSutunlar) secilenSutunlar = new Set(activeEngine.suggestKeyColumns().map(o => o.colIndex));

    headers.forEach((ad, c) => {
      const tip = activeEngine.getColumnType(c);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'flt-chip' + (secilenSutunlar.has(c) ? ' on' : '') + (visibleCols.has(c) ? '' : ' is-removed');
      // Çıkarılan sütun anahtar olarak kalabilir; dosyaya yazılmadığı belli olsun
      if (!visibleCols.has(c)) b.title = mt('Bu sütun çıkarıldı: anahtar olarak kullanılabilir, dosyaya yazılmaz.');
      b.dataset.col = c;
      b.setAttribute('aria-pressed', secilenSutunlar.has(c) ? 'true' : 'false');
      // DOM textContent ile kurulur: tip değeri tarif dosyasından gelebilir
      const adEl = document.createElement('span');
      adEl.textContent = ad || ('sütun ' + (c + 1));
      const tipEl = document.createElement('em');
      tipEl.textContent = tip;
      b.append(adEl, tipEl);
      fltChips.appendChild(b);
    });
  }

  fltChips.addEventListener('click', e => {
    const b = e.target.closest('.flt-chip');
    if (!b) return;
    const c = parseInt(b.dataset.col, 10);
    if (secilenSutunlar.has(c)) secilenSutunlar.delete(c); else secilenSutunlar.add(c);
    b.classList.toggle('on');
    b.setAttribute('aria-pressed', secilenSutunlar.has(c) ? 'true' : 'false');
    if (fltOn.checked) applyFilter();
  });

  fltOn.addEventListener('change', applyFilter);
  fltMode.addEventListener('change', () => {
    const gerek = fltMode.value !== 'aktif';
    fltColsRow.hidden = !gerek;
    $('flt-cols-lbl').textContent = fltMode.value === 'grup'
      ? 'Hepsi birden eşleşecek sütunlar'
      : 'Kimlik sütunları';
    if (fltOn.checked) applyFilter();
  });

  fltMark.addEventListener('click', () => {
    if (!sonFiltre || !sonFiltre.keySpecs) return;
    const n = sonFiltre.rowCount - sonFiltre.clusterCount;
    if (!confirm(`${formatNum(n)} satır "silinecek" olarak işaretlenecek.\nHer kümede bir satır kalacak. Devam edilsin mi?`)) return;
    const r = activeEngine.markDuplicateClusters(sonFiltre.keySpecs, {});
    toast(`${formatNum(r.markedCount)} satır işaretlendi`);
    applyFilter();
    refreshAfterMarkChange();
  });

  function filtreSifirla() {
    fltOn.checked = false;
    fltMode.value = 'aktif';
    fltColsRow.hidden = true;
    fltNote.hidden = true;
    fltMark.hidden = true;
    fltStat.textContent = '';
    viewRows = viewPosOf = clusterOfRow = winnerRows = sonFiltre = null;
  }

  function applyFilter() {
    if (!fltOn.checked) {
      viewRows = viewPosOf = clusterOfRow = winnerRows = sonFiltre = null;
      fltStat.textContent = '';
      fltNote.hidden = true;
      fltMark.hidden = true;
      scrollContainer.scrollTop = 0;
      applySearch().then(ok => { if (ok) { renderTable(); updateActionButtons(); } });
      return;
    }

    let sonuc, keySpecs = null;
    try {
      if (fltMode.value === 'aktif') {
        if (activeColIndex < 0) {
          uyari('Önce yukarıdan bir sütun seç.');
          fltOn.checked = false;
          return applyFilter();
        }
        sonuc = activeEngine.getDuplicateRowsByColumn(activeColIndex);
      } else {
        const cols = [...secilenSutunlar].sort((a, b) => a - b);
        if (!cols.length) {
          uyari('En az bir sütun seç.');
          fltOn.checked = false;
          return applyFilter();
        }
        if (fltMode.value === 'grup' && cols.length < 2) {
          uyari('Grup ölçütü için en az iki sütun gerekir — tek sütun zaten "aktif sütun" ölçütüdür.');
          fltOn.checked = false;
          return applyFilter();
        }
        keySpecs = fltMode.value === 'grup'
          ? [{ group: cols }]
          : cols.map(c => ({ colIndex: c }));
        sonuc = activeEngine.getDuplicateRows(keySpecs, {});
      }
    } catch (err) {
      uyari('Filtre çalışmadı: ' + err.message);
      fltOn.checked = false;
      return applyFilter();
    }

    viewRows     = sonuc.rows;
    // ham indeks -> görünüm konumu (scrollToRow için)
    viewPosOf = new Int32Array(activeEngine.getRowCount()).fill(-1);
    for (let p = 0; p < sonuc.rows.length; p++) viewPosOf[sonuc.rows[p]] = p;
    clusterOfRow = sonuc.clusterOfRow;
    winnerRows   = sonuc.winners && sonuc.winners.size ? sonuc.winners : null;
    sonFiltre    = Object.assign({}, sonuc, { keySpecs });

    fltStat.textContent = sonuc.rowCount === 0
      ? 'kopya yok'
      : `${formatNum(sonuc.rowCount)} satır · ${formatNum(sonuc.clusterCount)} küme · ${formatNum(sonuc.rowCount - sonuc.clusterCount)} fazlalık`;
    fltStat.classList.toggle('flt-stat-zero', sonuc.rowCount === 0);
    fltMark.hidden = !keySpecs || sonuc.rowCount === 0;

    // Çok sık geçen değerler kimlik sayılmadı — sessizce yutma, söyle.
    if (sonuc.noisyValues && sonuc.noisyValues.length) {
      const ilk = sonuc.noisyValues.slice(0, 3)
        .map(v => `“${escHtml(v.value)}” (${escHtml(v.column)}, ${formatNum(v.count)} satır)`).join(', ');
      fltNote.hidden = false;
      fltNote.innerHTML = `<strong>${sonuc.noisyValues.length} değer kimlik sayılmadı</strong> —
        çok fazla satırda geçiyor, bunlarla eşleştirmek farklı kişileri tek kişiye yapıştırırdı: ${ilk}${sonuc.noisyValues.length > 3 ? ' …' : ''}`;
    } else {
      fltNote.hidden = true;
    }

    scrollContainer.scrollTop = 0;
    applySearch().then(ok => { if (ok) { renderTable(); updateActionButtons(); } });
  }

  function uyari(mesaj) {
    fltNote.hidden = false;
    fltNote.textContent = mesaj;
  }

  // Aktif sütunun kopya değerlerini BİR KEZ hesapla ve sakla.
  // Eskiden bu her scroll karesinde çalışıyordu (tam tablo taraması).
  function recomputeDupSet() {
    if (activeColIndex < 0) { dupValuesSet = null; return; }
    const { dupGroups } = activeEngine.countif(activeColIndex);
    dupValuesSet = new Set(dupGroups.keys());
  }

  function renderVisibleRows() {
    const scrollTop  = scrollContainer.scrollTop;
    const viewHeight = scrollContainer.clientHeight;

    const gorunen  = viewCount();
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
    const endIdx   = Math.min(gorunen, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + BUFFER_ROWS);

    if (startIdx === visibleStartIdx && endIdx === visibleEndIdx) return;
    visibleStartIdx = startIdx;
    visibleEndIdx   = endIdx;

    const fragment = document.createDocumentFragment();
    const colCount = visibleCols.size + 2;

    // Üst boşluk satırı — tr'yi absolute konumlandırmak yerine gerçek
    // tablo akışı korunur, böylece thead ile sütun hizası bozulmaz.
    fragment.appendChild(spacerRow(startIdx * ROW_HEIGHT, colCount));

    let oncekiKume = -2;
    for (let p = startIdx; p < endIdx; p++) {
      const i = viewRowAt(p);
      const row = activeEngine.getRow(i);
      if (!row) continue;

      const tr = document.createElement('tr');
      tr.dataset.rowIdx = i;
      if (p % 2 === 1) tr.classList.add('stripe');

      // Küme sınırı çizgisi + "kalsın" vurgusu (filtre açıkken)
      if (clusterOfRow) {
        const k = clusterOfRow[i];
        if (k !== oncekiKume && p > startIdx) tr.classList.add('cluster-start');
        oncekiKume = k;
        if (winnerRows && winnerRows.has(i)) tr.classList.add('cluster-keep');
      }

      const isDeleted = activeEngine.isDeleted(i);
      if (isDeleted) tr.classList.add('row-marked-delete');

      // Checkbox
      const tdCb = document.createElement('td');
      tdCb.className = 'cell-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'row-cb';
      cb.checked = isDeleted;
      cb.dataset.row = i;
      cb.setAttribute('aria-label', `Satır ${i + 1} — silinecek olarak işaretle`);
      tdCb.appendChild(cb);
      tr.appendChild(tdCb);

      // Satır numarası
      const tdNum = document.createElement('td');
      tdNum.className = 'cell-rownum';
      tdNum.textContent = activeEngine.getSourceLine(i);
      tr.appendChild(tdNum);

      // Veri hücreleri
      for (let c = 0; c < headers.length; c++) {
        if (!visibleCols.has(c)) continue;
        const td = document.createElement('td');
        const raw = row[c] || '';
        td.textContent = raw;
        td.title = raw;
        if (c === activeColIndex && dupValuesSet) {
          // dupValuesSet anahtarları countif'ten gelir ve TİPE DUYARLI
          // normalize edilmiştir (telefon -> "5321112233", kimlik -> BÜYÜK).
          // normalizeValue (düz lowercase) kullanmak telefon ve kimlik
          // sütunlarında hiç eşleşmiyordu: sağ panel kopyaları listelerken
          // sol tabloda tek bir hücre bile işaretlenmiyordu.
          const norm = activeEngine.normalizeAs(raw, activeEngine.getColumnType(activeColIndex));
          if (norm && dupValuesSet.has(norm)) {
            td.classList.add('cell-dup');
            // Renk tek gösterge olmasın — ekran okuyucu için de işaretle
            td.setAttribute('aria-label', `${raw} — tekrar eden değer`);
          }
        }
        tr.appendChild(td);
      }

      fragment.appendChild(tr);
    }

    // Alt boşluk satırı
    fragment.appendChild(spacerRow((gorunen - endIdx) * ROW_HEIGHT, colCount));

    dataTbody.innerHTML = '';
    dataTbody.appendChild(fragment);
  }

  function spacerRow(height, colCount) {
    const tr = document.createElement('tr');
    tr.className = 'vs-spacer';
    tr.setAttribute('aria-hidden', 'true');
    tr.style.height = height + 'px';
    const td = document.createElement('td');
    td.colSpan = colCount;
    tr.appendChild(td);
    return tr;
  }

  // Satır checkbox'ları — delegasyon (her satıra dinleyici bağlamak yerine)
  dataTbody.addEventListener('change', e => {
    const cb = e.target.closest('.row-cb');
    if (!cb) return;
    const ri = parseInt(cb.dataset.row, 10);
    if (cb.checked) activeEngine.markDeleted(ri, 'Elle isaretlendi');
    else activeEngine.unmarkDeleted(ri);

    const tr = cb.closest('tr');
    if (tr) tr.classList.toggle('row-marked-delete', activeEngine.isDeleted(ri));

    updateActionButtons();
    updateSelectionInfo();
    agirTazelemeyiPlanla();
  });

  /* ======================================================
     BÖLÜM 4: SÜTUN SEÇİMİ & COUNTIF ANALİZİ
     ====================================================== */

  function selectColumn(colIdx) {
    activeColIndex = colIdx;
    columnBand.classList.remove('hint-pulse');

    document.querySelectorAll('.col-tab').forEach(tab => {
      const on = Number(tab.dataset.col) === colIdx;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    });

    dataThead.querySelectorAll('th').forEach(th => {
      th.classList.toggle(
        'col-highlight',
        th.dataset.col !== undefined && parseInt(th.dataset.col, 10) === colIdx
      );
    });

    // "Aktif sütun" ölçütüyle filtre açıksa sütun değişimi filtreyi de değiştirir
    if (fltOn.checked && fltMode.value === 'aktif') applyFilter();
    else renderTable();

    refreshAnalysis();
    updateActionButtons();
    if (quickDedupCol && quickDedupCol.value !== String(colIdx)) {
      quickDedupCol.value = String(colIdx);
      refreshQuickStats();
    }
  }

  function refreshAnalysis() {
    if (activeColIndex < 0) return;

    const result = activeEngine.countif(activeColIndex);
    dupCounter.textContent = `${formatNum(result.dupValueCount)} değer · ${formatNum(result.dupRowCount)} satır`;

    if (result.dupValueCount === 0) {
      analysisContent.innerHTML =
        `<div class="analysis-placeholder is-ok">
           ${icon('i-check')}
           <strong>Kopya yok</strong>
           <span>Bu sütundaki her değer benzersiz.</span>
         </div>`;
      refreshColumnTabs();
      return;
    }

    // En çok tekrar eden en üstte
    analizGruplari = [...result.dupGroups.entries()].sort((a, b) => b[1].length - a[1].length);
    analizCizilen = 0;
    analysisContent.innerHTML = '';
    analizDahaCiz();
    refreshColumnTabs();
  }

  /* Analiz paneli TEMBEL çizilir.
     -------------------------------------------------
     Önceden bütün gruplar ve içlerindeki bütün satırlar tek seferde
     HTML'e dökülüyordu. 50 bin satırlık bir dosyada bu ~14 MB HTML ve
     ~240 bin DOM düğümü demekti — bir sütuna tıklamak saniyeler sürüyor,
     arayüz kilitleniyordu. Üstelik gruplar kapalı başladığı için o
     satırların neredeyse tamamı hiç görülmüyordu.

     Artık: aynı anda en fazla ANALIZ_SAYFA grup başlığı çizilir,
     grup içindeki satırlar ise ancak grup AÇILDIĞINDA üretilir. */
  const ANALIZ_SAYFA = 150;
  let analizGruplari = [];
  let analizCizilen  = 0;

  function analizDahaCiz() {
    const eski = analysisContent.querySelector('.dup-more');
    if (eski) eski.remove();

    const son = Math.min(analizCizilen + ANALIZ_SAYFA, analizGruplari.length);
    let html = '';
    for (let gi = analizCizilen; gi < son; gi++) {
      const [val, indices] = analizGruplari[gi];
      // Kopya değeri veridir (translate="no"); yalnız boş değer etiketi çevrilir
      const displayVal = val || mt('(boş)');
      html += `<div class="dup-group" data-group="${gi}">`;
      html += `<button type="button" class="dup-group-header" aria-expanded="false">`;
      html += icon('i-chevron', 'chev');
      html += `<span class="dup-value" translate="no" title="${escAttr(displayVal)}">${escHtml(displayVal)}</span>`;
      html += `<span class="dup-count">${indices.length}×</span>`;
      html += `</button>`;
      html += `<div class="dup-group-rows"></div></div>`;   // içi açılınca dolar
    }
    analysisContent.insertAdjacentHTML('beforeend', html);
    analizCizilen = son;

    const kalan = analizGruplari.length - analizCizilen;
    if (kalan > 0) {
      analysisContent.insertAdjacentHTML('beforeend',
        `<button type="button" class="dup-more">${formatNum(kalan)} grup daha göster</button>`);
    }
  }

  /* Bir grubun satırlarını ilk açılışta üretir. */
  function analizGrupDoldur(groupEl) {
    if (groupEl.dataset.dolu === '1') return;
    const gi = parseInt(groupEl.dataset.group, 10);
    const indices = analizGruplari[gi] ? analizGruplari[gi][1] : null;
    if (!indices) return;

    let html = '';
    indices.forEach(ri => {
      const rowData = activeEngine.getRow(ri);
      // Önizleme tabloda görünen (çıkarılmamış) ilk dört sütundan kurulur
      const preview = visibleColumnIndices().slice(0, 4).map(ci => `${headers[ci]}: ${rowData[ci] || '-'}`).join(' | ');
      const marked = activeEngine.isDeleted(ri);
      html += `<div class="dup-row-item" data-row="${ri}">`;
      html += `<span class="row-num">Satır ${activeEngine.getSourceLine(ri)}</span>`;
      html += `<span class="row-preview" translate="no" title="${escAttr(preview)}">${escHtml(preview)}</span>`;
      html += `<button type="button" class="btn-goto" data-goto="${ri}" aria-label="Satır ${ri + 1} konumuna git">${icon('i-eye')}</button>`;
      html += `<button type="button" class="btn-mark${marked ? ' marked' : ''}" data-toggle="${ri}" aria-pressed="${marked}" aria-label="Satır ${ri + 1} — ${marked ? 'işareti kaldır' : 'silinecek olarak işaretle'}">${icon(marked ? 'i-undo' : 'i-x')}</button>`;
      html += `</div>`;
    });
    groupEl.querySelector('.dup-group-rows').innerHTML = html;
    groupEl.dataset.dolu = '1';
  }

  // Sağ paneldeki tüm etkileşimler tek delegasyonla — inline onclick yok (CSP)
  analysisContent.addEventListener('click', e => {
    const more = e.target.closest('.dup-more');
    if (more) { analizDahaCiz(); return; }

    const header = e.target.closest('.dup-group-header');
    if (header) {
      const group = header.parentElement;
      const open = group.classList.toggle('expanded');
      if (open) analizGrupDoldur(group);      // satırlar ancak burada üretilir
      header.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    const goto = e.target.closest('[data-goto]');
    if (goto) { scrollToRow(parseInt(goto.dataset.goto, 10)); return; }

    const toggle = e.target.closest('[data-toggle]');
    if (toggle) { toggleRow(parseInt(toggle.dataset.toggle, 10), toggle); }
  });

  function refreshColumnTabs() {
    const stats = activeEngine.allColumnStats();
    const tabs = columnTabs.querySelectorAll('.col-tab');
    tabs.forEach(tab => {
      const s = stats[Number(tab.dataset.col)];
      tab.classList.toggle('no-dup', s.dupValueCount === 0);
      tab.querySelector('.tab-count').textContent =
        s.dupValueCount > 0 ? mt('{0} kopya', formatNum(s.dupRowCount)) : mt('temiz');
    });
  }

  /* ======================================================
     BÖLÜM 5: TOPLU İŞLEMLER
     ====================================================== */

  btnKeepFirst.addEventListener('click',  () => doBulkMark('first',  'İlk kayıtlar tutuldu'));
  btnKeepSecond.addEventListener('click', () => doBulkMark('second', '2. kayıtlar tutuldu'));
  btnKeepLast.addEventListener('click',   () => doBulkMark('last',   'Son kayıtlar tutuldu'));
  btnDeleteDuplicates.addEventListener('click', () => doBulkMark('none', 'Kopyaların tümü silindi'));

  function doBulkMark(keep, label) {
    const groupKeys = fltOn.checked && fltMode.value !== 'aktif' ? sonFiltre?.keySpecs : null;
    if (!groupKeys && activeColIndex < 0) return;
    const before = activeEngine.getDeletedCount();
    if (groupKeys) {
      const { clusters } = activeEngine.findClusters(groupKeys, {});
      for (const rows of clusters) {
        const retained = keep === 'none'
          ? new Set()
          : new Set([keep === 'last' ? rows[rows.length - 1] : rows[keep === 'second' ? 1 : 0]]);
        activeEngine.markRowsDeleted(rows.filter(i => !retained.has(i)), 'Seçili çoklu sütun ölçütü');
      }
    } else activeEngine.bulkMark(activeColIndex, keep);
    const added = activeEngine.getDeletedCount() - before;

    refreshAfterMarkChange();
    toast(`${label} — ${formatNum(added)} satır silinmek üzere işaretlendi`, {
      danger: true,
      actionLabel: 'Tümünü Geri Al',
      onAction: () => { activeEngine.clearAllDeleted(); refreshAfterMarkChange(); }
    });
  }

  // "İşaretlileri Onayla" — işaretli satırların özetini gösterir ve
  // doğrulama için ilk işaretli satıra götürür. (Gerçek silme işlemi
  // dışa aktarmada olur; buton artık yapmadığı şeyi vaat etmiyor.)
  btnDeleteSel.addEventListener('click', () => {
    const del = activeEngine.getDeletedCount();
    if (!del) return;

    let firstMarked = -1;
    for (let i = 0; i < totalRows; i++) {
      if (activeEngine.isDeleted(i)) { firstMarked = i; break; }
    }
    if (firstMarked >= 0) scrollToRow(firstMarked);

    toast(`${formatNum(del)} satır çıktıdan hariç tutulacak. "Temiz İndir" ile dosyayı alın.`, {
      danger: true,
      actionLabel: 'Tümünü Geri Al',
      onAction: () => { activeEngine.clearAllDeleted(); refreshAfterMarkChange(); }
    });
  });

  btnRestoreAll.addEventListener('click', () => {
    const del = activeEngine.getDeletedCount();
    activeEngine.clearAllDeleted();
    const sa = $('select-all-cb');
    if (sa) sa.checked = false;
    refreshAfterMarkChange();
    if (del) toast(`${formatNum(del)} satırın işareti kaldırıldı`);
  });

  // İşaret kümesi değiştiğinde tek noktadan yenile
  function refreshAfterMarkChange() {
    // İşaretlenen satırlar kopya hesabının dışında kalır; filtre açıksa
    // görünen liste de değişmeli, yoksa ekranda artık kopya olmayan
    // satırlar "kopya" başlığı altında durmaya devam eder.
    if (fltOn.checked) applyFilter();
    else renderTable();
    refreshAnalysis();
    updateActionButtons();
    refreshQuickStats();
  }

  /* ======================================================
     BÖLÜM 6: DIŞA AKTARMA
     ====================================================== */

  const konumSecilebilir = typeof window.showSaveFilePicker === 'function';
  const exportFormat = $('export-format');
  const exportExtension = () => exportFormat.value === 'xlsx' ? '.xlsx' : '.csv';

  /* Kaydetme konumu seçtirir. Konum seçici ÖNCE açılır, dosya sonra
     üretilir: büyük listelerde CSV'yi hazırlamak saniyeler sürebiliyor
     ve bu sırada tarayıcının "kullanıcı etkileşimi" izni düşerse konum
     penceresi hiç açılmıyor. */
  async function kaydetmeHedefi(onerilenAd, format, fallback) {
    if (!konumSecilebilir) return { tur: 'indir', ad: onerilenAd };
    try {
      const fh = await window.showSaveFilePicker({
        suggestedName: onerilenAd,
        types: format === 'xlsx'
          ? [{ description: 'Excel dosyası', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }]
          : [{ description: 'CSV dosyası', accept: { 'text/csv': ['.csv'] } }]
      });
      return { tur: 'dosya', handle: fh, ad: fh.name };
    } catch (err) {
      /* Konum penceresi dosya vermediyse SEBEBİ NE OLURSA OLSUN kullanıcı
         boşta kalmamalı. Pencere kapanmış da olabilir, tarayıcı bu bağlamda
         (iframe, izin, sistem klasörü) çağrıyı reddetmiş de olabilir — ikisi
         de dışarıdan "hiçbir şey olmadı" gibi görünüyor. Ne olduğunu söyle
         ve indirme seçeneğini elinin altına koy. */
      const iptal = err && err.name === 'AbortError';
      toast(
        iptal
          ? 'Kaydetme penceresi kapandı, dosya kaydedilmedi.'
          : 'Bu konuma yazılamadı: ' + err.message,
        {
          danger: !iptal,
          duration: 12000,
          actionLabel: 'Bunun yerine indir',
          onAction: fallback
        });
      return null;
    }
  }


  async function hedefeYaz(hedef, blob) {
    if (hedef.tur === 'dosya') {
      const w = await hedef.handle.createWritable();
      await w.write(blob);
      await w.close();
      return;
    }
    downloadBlob(blob, hedef.ad);
  }

  function varilanYer(hedef) {
    return hedef.tur === 'dosya' ? `"${hedef.ad}" olarak kaydedildi` : `"${hedef.ad}" indiriliyor`;
  }

  /* Dışa aktarmanın ortak iskeleti: önce konum sor, sonra veriyi üret.
     Konum alınamazsa üretilen dosya "indir" yedeğine bağlanır.

     kaynak = { motor, sutunlar, satirSec?(i), ekSutunlar?, dizi() }
     CSV AKIŞLA üretilir (motor.streamExportClean): eskiden tablo önce
     string[][] olarak kuruluyor, formül sayımı için bir kez daha geziliyor,
     sonra tek dev CSV metnine çevriliyordu — büyük listede aynı veri üç kez
     bellekte. Artık dilimler konum seçildiyse doğrudan dosyaya, seçilmediyse
     Blob parçalarına yazılır. XLSX'i SheetJS zaten bütün olarak kurduğu için
     orada dizi yolu (kaynak.dizi) kalır. */
  async function disaAktar(onerilenAd, kaynak, ozet) {
    const format = exportFormat.value;
    const formulaModeEl = $('export-formula-mode');
    const safeFormula = formulaModeEl ? formulaModeEl.value === 'safe' : true;

    const csvAkit = onChunk => kaynak.motor.streamExportClean(kaynak.sutunlar, {
      delimiter: ';',
      safeFormula,
      includeRow: kaynak.satirSec,
      extraColumns: kaynak.ekSutunlar
    }, onChunk);

    function csvBildir(sonuc) {
      if (sonuc.formulaCells > 0) {
        if (!safeFormula) {
          toast(`Dikkat: çıktıda ${formatNum(sonuc.formulaCells)} formül hücresi var (Ham Veri modu). Excel'de açarken dikkat ediniz.`, { danger: true });
        } else {
          toast(`${formatNum(sonuc.formulaCells)} formül hücresi güvenli metne çevrildi.`);
        }
      }
      if (sonuc.exceedsExcel) {
        toast(`Dikkat: Excel sınırı (1.048.576 satır) aşıldı (${formatNum(sonuc.rowsWritten)} satır). Doğrudan Excel'de açılırsa satırlar kesilebilir.`, { danger: true, duration: 10000 });
      }
    }

    // { blob, satir } üretir — indirme yedeği ve XLSX yolu için
    async function blobUret() {
      if (format === 'xlsx') {
        const data = kaynak.dizi();
        const blob = kaynak.motor.arrayToXlsxBlob(data, 'Sonuc');
        const n = kaynak.motor.countFormulaCells(data).count;
        if (n > 0) toast(`${formatNum(n)} hücre formül karakteriyle başlıyor; Excel (.xlsx) dosyasında düz metin olarak saklandı, çalıştırılmaz.`);
        return { blob, satir: Math.max(0, data.length - 1) };
      }
      const parcalar = [];
      // Her dilim ayrı Blob: tarayıcı büyük Blob'ları JS belleğinin dışına alabilir
      const sonuc = await csvAkit(chunk => { parcalar.push(new Blob([chunk])); });
      csvBildir(sonuc);
      return { blob: new Blob(parcalar, { type: 'text/csv;charset=utf-8' }), satir: sonuc.rowsWritten };
    }

    const fallback = () => {
      blobUret().then(({ blob, satir }) => {
        downloadBlob(blob, onerilenAd);
        toast(`${ozet(satir)} — "${onerilenAd}" indiriliyor`);
      }).catch(err => toast('Dışa aktarım hatası: ' + err.message, { danger: true }));
    };
    const hedef = await kaydetmeHedefi(onerilenAd, format, fallback);
    if (!hedef) return;

    if (hedef.tur === 'dosya' && format !== 'xlsx') {
      const w = await hedef.handle.createWritable();
      let sonuc;
      try {
        sonuc = await csvAkit(chunk => w.write(chunk));
        await w.close();
      } catch (err) {
        // Yarım dosya diske işlenmesin: yazıcıyı iptal et, hatayı yukarı ilet
        try { await w.abort(); } catch (_) { /* zaten kapanmış olabilir */ }
        throw err;
      }
      csvBildir(sonuc);
      toast(`${ozet(sonuc.rowsWritten)} — ${varilanYer(hedef)}`);
      return;
    }

    const { blob, satir } = await blobUret();
    await hedefeYaz(hedef, blob);
    toast(`${ozet(satir)} — ${varilanYer(hedef)}`);
  }

  /* Kaynak dosyanın adından türetilen çıktı adı: "musteriler.xlsx" -> "musteriler_temiz.csv" */
  function disaAktarimAdi(ek) {
    return activeEngine.getFileName().replace(/\.[^.]+$/, '') + ek;
  }

  /* Dışa aktarım düğmelerinin ortak sarmalayıcısı — hata mesajı tek yerde durur. */
  function disaAktarimDugmesi(btn, calistir) {
    btn.addEventListener('click', async () => {
      try {
        await calistir();
      } catch (e) {
        toast('Dışa aktarım hatası: ' + e.message, { danger: true });
      }
    });
  }

  // Motor ve sütunlar tıklama anında sabitlenir: konum penceresi açıkken
  // çalışma alanı değişse bile kullanıcının gördüğü tablo dışa aktarılır.
  disaAktarimDugmesi(btnExportClean, () => {
    const motor = activeEngine, sutunlar = visibleColumnIndices();
    return disaAktar(
      disaAktarimAdi('_temiz' + exportExtension()),
      { motor, sutunlar, dizi: () => motor.exportClean(sutunlar) },
      n => `${formatNum(n)} satırlık temiz dosya`);
  });

  disaAktarimDugmesi(btnExportDeleted, () => {
    if (activeEngine.getDeletedCount() === 0) {
      toast('Silinecek olarak işaretlenmiş satır yok.', { danger: true });
      return;
    }
    const motor = activeEngine, sutunlar = visibleColumnIndices();
    return disaAktar(
      disaAktarimAdi('_silinen' + exportExtension()),
      {
        motor, sutunlar,
        // exportDeleted ile aynı biçim: seçili sütunlar + denetim sütunları
        satirSec: i => motor.isDeleted(i),
        ekSutunlar: [
          { header: 'KAYNAK_SATIR', value: i => motor.getSourceLine(i) },
          { header: 'SILME_SEBEBI', value: i => motor.getDeleteReason(i) }
        ],
        dizi: () => motor.exportDeleted(sutunlar)
      },
      n => `${formatNum(n)} silinen satır`);
  });

  const btnExportRecipe = $('btn-export-recipe');
  if (btnExportRecipe) {
    btnExportRecipe.addEventListener('click', () => {
      const recipe = activeEngine.exportRecipe({ removedColumns: headers.filter((_, i) => !visibleCols.has(i)) });
      const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' });
      downloadBlob(blob, disaAktarimAdi('_tarif.json'));
      toast('İşlem tarifi JSON olarak indirildi (hassas satır verisi içermez).');
    });
  }

  const recipeFileInput = $('recipe-file-input');
  if (recipeFileInput) {
    recipeFileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      recipeFileInput.value = '';   // aynı tarif yeniden seçilebilsin
      const reader = new FileReader();
      reader.onload = async evt => {
        const motor = activeEngine, oturum = ajSessionRevision;
        try {
          const parsed = JSON.parse(evt.target.result);
          const res = motor.applyRecipe(parsed);
          // Eklenen sütunlar tarifteki sırayla kurulur: biri diğerine dayanabilir
          const eklenen = [], eksikKaynak = [];
          for (const tanim of res.pendingColumns) {
            const r = await motor.addRecipeColumn(tanim, res.columnTypes, { iptalMi: () => oturum !== ajSessionRevision });
            if (r.skipped === 'missing') eksikKaynak.push(r.header);
            else if (!r.skipped) eklenen.push(r.colIndex);
          }
          if (oturum !== ajSessionRevision || motor !== activeEngine) return;
          headers = motor.getHeaders();
          let cikan = 0;
          for (const ad of res.removedColumns) {
            const i = headers.indexOf(ad);
            if (i >= 0 && visibleCols.has(i) && visibleCols.size > 1) { visibleCols.delete(i); cikan++; }
          }
          if (eklenen.length) sutunEklendi(motor, eklenen, -1);
          else sutunlarDegisti();
          toast(`Tarif uygulandı: ${res.appliedTypes} sütun türü, ${eklenen.length} eklenen sütun, ${cikan} çıkarılan sütun.`);
          if (eksikKaynak.length) {
            toast(`Kaynak sütunu bu dosyada olmadığı için eklenmedi: ${eksikKaynak.join(', ')}`, { danger: true, duration: 10000 });
          }
        } catch (err) {
          if (err && err.message === 'İPTAL') return;
          toast('Tarif uygulanamadı: ' + err.message, { danger: true });
        }
      };
      reader.readAsText(file);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    // Hemen iptal edilirse bazı tarayıcılarda indirme başlamadan blob kaybolur
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }

  /* ======================================================
     BÖLÜM 7: YARDIMCI FONKSİYONLAR
     ====================================================== */

  /* Kaydırma yüksekliği GÖRÜNEN satır sayısına göredir, ham satır
     indeksine göre değil. Filtre açıkken ham indeksi doğrudan kullanmak
     (ör. 300 binlik dosyada 250.000. satır) kabın yüksekliğini kat kat
     aşar ve listeyi hep en dibe atardı. Ham indeksi görünüm konumuna
     çeviriyoruz; satır filtre dışındaysa kullanıcıya söylüyoruz. */
  function scrollToRow(rowIdx) {
    let pos = rowIdx;
    if (viewRows) {
      pos = viewPosOf ? viewPosOf[rowIdx] : -1;
      if (pos < 0) {
        toast('O satır şu anki filtrede görünmüyor — filtreyi kapatıp tekrar deneyin.');
        return;
      }
    }
    scrollContainer.scrollTo({
      top: Math.max(0, pos * ROW_HEIGHT - 100),
      behavior: reduceMotion ? 'auto' : 'smooth'
    });
  }

  /* Tek satır işaretleme YERİNDE güncellenir.
     Eskiden her tıklama refreshAfterMarkChange() çağırıyordu: tablo
     yeniden çizim + analiz panelinin tamamı yeniden kurulum + 8 sütunluk
     istatistik. Yan etkisi de vardı — açık gruplar kapanıyordu.
     Artık sadece değişen düğme ve satır güncelleniyor; ağır tazeleme
     tıklama fırtınası bitince bir kez çalışıyor. */
  function toggleRow(rowIdx, btnEl) {
    const simdi = !activeEngine.isDeleted(rowIdx);
    if (simdi) activeEngine.markDeleted(rowIdx, 'Elle isaretlendi');
    else activeEngine.unmarkDeleted(rowIdx);

    if (btnEl) {
      btnEl.classList.toggle('marked', simdi);
      btnEl.setAttribute('aria-pressed', String(simdi));
      btnEl.innerHTML = icon(simdi ? 'i-undo' : 'i-x');
      btnEl.setAttribute('aria-label',
        `Satır ${rowIdx + 1} — ${simdi ? 'işareti kaldır' : 'silinecek olarak işaretle'}`);
    }

    const tr = dataTbody.querySelector(`tr[data-row-idx="${rowIdx}"]`);
    if (tr) {
      tr.classList.toggle('row-marked-delete', simdi);
      const cb = tr.querySelector('.row-cb');
      if (cb) cb.checked = simdi;
    }

    updateActionButtons();
    agirTazelemeyiPlanla();
  }

  /* İşaretleme sonrası ağır tazeleme — art arda tıklamada bir kez çalışır. */
  let agirTazelemeZaman = null;
  function agirTazelemeyiPlanla() {
    clearTimeout(agirTazelemeZaman);
    agirTazelemeZaman = setTimeout(() => {
      if (fltOn.checked) applyFilter();
      else renderTable();
      if (activeColIndex >= 0) {
        const o = activeEngine.countSummary(activeColIndex);
        dupCounter.textContent = `${formatNum(o.dupValueCount)} değer · ${formatNum(o.dupRowCount)} satır`;
      }
      refreshColumnTabs();
    }, 400);
  }

  function updateRowCounter() {
    const active = activeEngine.getActiveRowCount();
    const total  = activeEngine.getRowCount();
    const del    = activeEngine.getDeletedCount();
    const suzuluyor = viewRows !== null;
    rowCounter.textContent = suzuluyor
      ? `${formatNum(viewRows.length)} / ${formatNum(total)} satır gösteriliyor`
      : (del > 0
          ? `${formatNum(active)} / ${formatNum(total)} satır · ${formatNum(del)} silinecek`
          : `${formatNum(total)} satır`);
    rowCounter.classList.toggle('badge-red', !suzuluyor && del > 0);
    rowCounter.classList.toggle('badge-filtered', suzuluyor);
  }

  function updateSelectionInfo() {
    const del = activeEngine.getDeletedCount();
    selectionInfo.textContent = del > 0 ? `${formatNum(del)} satır silinmek üzere işaretlendi` : '';
  }

  function updateActionButtons() {
    const hasCol = activeColIndex >= 0;
    const grouped = fltOn.checked && fltMode.value !== 'aktif';
    const hasDel = activeEngine.getDeletedCount() > 0;

    // Sadece "kopya var mı" bilgisi lazım — countif'in satır dizilerini
    // kurmasına gerek yok. Hafif özet, her tıklamada dönen işi kesiyor.
    let hasDups = false;
    if (grouped) hasDups = !!sonFiltre?.clusterCount;
    else if (hasCol) hasDups = activeEngine.countSummary(activeColIndex).dupValueCount > 0;

    const bulkOff = (!grouped && !hasCol) || !hasDups;
    $('bulk-label').textContent = grouped ? 'Seçili çoklu sütun ölçütü' : 'Aktif sütunda tekilleştir';
    [btnKeepFirst, btnKeepSecond, btnKeepLast, btnDeleteDuplicates].forEach(b => {
      b.disabled = bulkOff;
      b.title = bulkOff
        ? (hasCol ? 'Bu sütunda kopya yok' : 'Önce yukarıdan bir sütun seçin')
        : '';
    });

    btnDeleteSel.disabled = !hasDel;
    btnDeleteSel.title = hasDel ? '' : 'Önce silinecek satırları işaretleyin';

    updateRowCounter();
    updateSelectionInfo();
  }

  function formatNum(n) { return Number(n).toLocaleString('tr-TR'); }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ======================================================
     BÖLÜM 8: YENİ SADELEŞTİRİLMİŞ UX BAĞLANTILARI
     ====================================================== */
  const tabBtnDedup    = $('tab-btn-dedup');
  const tabBtnSubtract = $('tab-btn-subtract');
  const tabViewDedup   = $('tab-view-dedup');
  const tabViewSubtract= $('tab-view-subtract');

  const quickDedupCol   = $('quick-dedup-col');
  const quickDedupRule  = $('quick-dedup-rule');
  const quickStatMain   = $('quick-stat-main');
  const quickStatSub    = $('quick-stat-sub');
  const btnQuickDownload= $('btn-quick-download');
  const btnQuickDeleted = $('btn-quick-deleted');
  const subDropB        = $('sub-drop-b');
  const subFieldB       = $('sub-field-b');

  function initTabs() {
    if (!tabBtnDedup || !tabBtnSubtract) return;
    tabBtnDedup.addEventListener('click', () => {
      tabBtnDedup.classList.add('is-active');
      tabBtnDedup.setAttribute('aria-selected', 'true');
      tabBtnSubtract.classList.remove('is-active');
      tabBtnSubtract.setAttribute('aria-selected', 'false');
      if (tabViewDedup) tabViewDedup.style.display = 'flex';
      if (tabViewSubtract) tabViewSubtract.style.display = 'none';
    });

    tabBtnSubtract.addEventListener('click', () => {
      tabBtnSubtract.classList.add('is-active');
      tabBtnSubtract.setAttribute('aria-selected', 'true');
      tabBtnDedup.classList.remove('is-active');
      tabBtnDedup.setAttribute('aria-selected', 'false');
      if (tabViewSubtract) tabViewSubtract.style.display = 'flex';
      if (tabViewDedup) tabViewDedup.style.display = 'none';
      if (headers.length) {
        ajOptions(ajColA, ajEngines.A);
        if (activeColIndex >= 0 && ajEngines.A === activeEngine) ajColA.value = String(activeColIndex);
        ajOptions(ajColB, ajEngines.B);
        ajRefresh();
      }
    });
  }

  function updateQuickDedupCard() {
    if (!quickDedupCol || !activeEngine || !headers.length) return;
    const stats = activeEngine.allColumnStats();
    quickDedupCol.replaceChildren();

    let bestCol = 0;
    let maxDups = -1;

    stats.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      // Sütun adı veridir (translate="no"); ek sözlükten gelir. Çıkarılan
      // sütun anahtar olarak seçilebilir ama dosyaya yazılmaz.
      opt.textContent = `${headers[i] || 'Sütun ' + (i+1)} (${s.dupRowCount > 0 ? mt('{0} kopya', formatNum(s.dupRowCount)) : mt('temiz')})` +
        (visibleCols.has(i) ? '' : ' — ' + mt('çıkarıldı'));
      opt.translate = false;
      quickDedupCol.appendChild(opt);
      if (visibleCols.has(i) && s.dupRowCount > maxDups) {
        maxDups = s.dupRowCount;
        bestCol = i;
      }
    });

    const targetCol = activeColIndex >= 0 ? activeColIndex : bestCol;
    quickDedupCol.value = String(targetCol);
    if (activeColIndex < 0) selectColumn(targetCol);
    refreshQuickStats();
  }

  function refreshQuickStats() {
    if (!quickDedupCol || !activeEngine || !headers.length) return;
    const colIdx = parseInt(quickDedupCol.value, 10);
    if (isNaN(colIdx) || colIdx < 0 || colIdx >= headers.length) return;
    const rule = quickDedupRule ? quickDedupRule.value : 'first';
    const s = activeEngine.countSummary(colIdx);
    const total = activeEngine.getRowCount();

    if (s.dupRowCount === 0) {
      if (quickStatMain) quickStatMain.textContent = 'Mükerrer Kayıt Yok';
      if (quickStatSub) quickStatSub.textContent = `"${headers[colIdx]}" sütununda tüm değerler benzersizdir; dosyanız temiz.`;
      if (btnQuickDownload) btnQuickDownload.disabled = false;
      return;
    }

    let silinecek = 0;
    if (rule === 'first' || rule === 'last') {
      silinecek = s.dupRowCount - s.dupValueCount;
    } else {
      silinecek = s.dupRowCount;
    }
    const kalan = Math.max(0, total - silinecek);

    if (quickStatMain) quickStatMain.textContent = `${formatNum(total)} satır ➔ ${formatNum(kalan)} tekil`;
    if (quickStatSub) quickStatSub.textContent = `${formatNum(silinecek)} kopya satır elenecek (${rule === 'first' ? 'ilkler saklanacak' : rule === 'last' ? 'sonlar saklanacak' : 'tümü silinecek'})`;
  }

  quickDedupCol?.addEventListener('change', () => {
    const colIdx = parseInt(quickDedupCol.value, 10);
    if (colIdx >= 0) selectColumn(colIdx);
    refreshQuickStats();
  });

  quickDedupRule?.addEventListener('change', refreshQuickStats);

  btnQuickDownload?.addEventListener('click', () => {
    const colIdx = parseInt(quickDedupCol.value, 10);
    const rule = quickDedupRule ? quickDedupRule.value : 'first';
    if (colIdx < 0) return;
    activeColIndex = colIdx;
    doBulkMark(rule, rule === 'first' ? 'İlk kayıtlar tutuldu' : rule === 'last' ? 'Son kayıtlar tutuldu' : 'Kopyaların tümü silindi');
    btnExportClean.click();
  });

  btnQuickDeleted?.addEventListener('click', () => {
    btnExportDeleted.click();
  });

  // Liste Çıkarma (Anti-Join) B dosyası sürükle-bırak desteği
  if (subDropB) {
    subDropB.addEventListener('dragover', e => { e.preventDefault(); subDropB.classList.add('dragover'); });
    subDropB.addEventListener('dragleave', e => { e.preventDefault(); subDropB.classList.remove('dragover'); });
    subDropB.addEventListener('drop', e => {
      e.preventDefault();
      subDropB.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files[0]) {
        const dt = new DataTransfer();
        dt.items.add(e.dataTransfer.files[0]);
        ajFileInput.files = dt.files;
        ajFileInput.dispatchEvent(new Event('change'));
      }
    });
  }

  ajFileInput?.addEventListener('change', () => {
    if (ajFileInput.files && ajFileInput.files[0]) {
      if (subFieldB) subFieldB.style.display = 'flex';
      if (subDropB) subDropB.style.display = 'none';
    }
  });

  ajRemoveB?.addEventListener('click', () => {
    if (subFieldB) subFieldB.style.display = 'none';
    if (subDropB) subDropB.style.display = 'flex';
  });

  initTabs();

  /* ---------- PUBLIC API ---------- */
  window.DedupUI = { scrollToRow, toggleRow, updateQuickDedupCard };

  /* ---------- DEMO MODU ---------- */
  if (new URLSearchParams(window.location.search).has('demo')) {
    const csv = [
      'id,id2,email,phone',
      '12214234,231211231,e@gmail.com,90567455',
      '312312421,231211231,e@gmail.com,90567455',
      '12214234,43454642423,E@gmail.com,90567455',
      '312312421,43454642423,e@gmail.com,90567489',
      '99999999,111111111,test@test.com,55512345',
      '88888888,222222222,user@site.com,55512345',
      '77777777,333333333,test@test.com,55567890',
      '12214234,444444444,new@email.com,55500000'
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const file = new File([blob], 'demo-veri.csv', { type: 'text/csv' });
    handleFile(file);
  }

})();
