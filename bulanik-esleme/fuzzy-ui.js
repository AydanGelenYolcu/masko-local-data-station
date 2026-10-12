/**
 * Masko — Bulanık Çapraz Eşleme & Mutabakat Kullanıcı Arayüzü (fuzzy-ui.js)
 */
(function () {
  'use strict';

  // DOM Elements - Inputs & Config
  const dropCardA = document.getElementById('dropCardA');
  const fileInputA = document.getElementById('fileInputA');
  const labelCardA = document.getElementById('labelCardA');
  const subCardA = document.getElementById('subCardA');

  const dropCardB = document.getElementById('dropCardB');
  const fileInputB = document.getElementById('fileInputB');
  const labelCardB = document.getElementById('labelCardB');
  const subCardB = document.getElementById('subCardB');

  const configGrid = document.getElementById('configGrid');
  const selectKeyA = document.getElementById('selectKeyA');
  const selectKeyB = document.getElementById('selectKeyB');
  const selectAmountA = document.getElementById('selectAmountA');
  const selectAmountB = document.getElementById('selectAmountB');
  const inputAmountTol = document.getElementById('inputAmountTol');
  const inputThreshold = document.getElementById('inputThreshold');
  const thresholdVal = document.getElementById('thresholdVal');
  const btnRunReconcile = document.getElementById('btnRunReconcile');

  // DOM Elements - Results
  const resultCard = document.getElementById('resultCard');
  const statMatchRate = document.getElementById('statMatchRate');
  const statExactCount = document.getElementById('statExactCount');
  const statFuzzyCount = document.getElementById('statFuzzyCount');
  const statUnmatchedA = document.getElementById('statUnmatchedA');
  const statUnmatchedB = document.getElementById('statUnmatchedB');

  const countTabFuzzy = document.getElementById('countTabFuzzy');
  const countTabExact = document.getElementById('countTabExact');
  const countTabA = document.getElementById('countTabA');
  const countTabB = document.getElementById('countTabB');

  const resultHead = document.getElementById('resultHead');
  const resultBody = document.getElementById('resultBody');
  const rtabButtons = document.querySelectorAll('.rtab-btn');

  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnExportExcel = document.getElementById('btnExportExcel');

  // State
  let dataA = null; // { name, rows: [{}], headers: [] }
  let dataB = null; // { name, rows: [{}], headers: [] }
  let lastReconcileResult = null;
  let activeTab = 'fuzzy';

  // --- DROPZONE EVENTS ---
  dropCardA.addEventListener('click', () => fileInputA.click());
  fileInputA.addEventListener('change', (e) => handleFileSelect(e, 'A'));
  setupDragDrop(dropCardA, (file) => parseTableFile(file, 'A'));

  dropCardB.addEventListener('click', () => fileInputB.click());
  fileInputB.addEventListener('change', (e) => handleFileSelect(e, 'B'));
  setupDragDrop(dropCardB, (file) => parseTableFile(file, 'B'));

  inputThreshold.addEventListener('input', () => {
    thresholdVal.textContent = `${inputThreshold.value}%`;
  });

  function handleFileSelect(e, target) {
    const file = e.target.files && e.target.files[0];
    if (file) parseTableFile(file, target);
  }

  // --- FILE PARSER (XLSX / CSV) ---
  async function parseTableFile(file, target) {
    try {
      const buffer = await file.arrayBuffer();
      let rows = [];
      let headers = [];

      if (typeof XLSX !== 'undefined') {
        // CSV hücreleri metin olarak okunur: SheetJS aksi hâlde "1.250,50"yi
        // 1.2505'e, "1.250"yi 1.25'e çevirir ve parseAmount'un Türkçe biçim
        // kuralları hiç devreye giremez. XLSX'teki gerçek sayılar sayı kalır.
        // Metin dosyasının kodlaması (UTF-8 / 1254) CsvIO ile çözülür: SheetJS
        // bayt dizisini Latin-1 okur, Türkçe harfler bozulurdu.
        const isText = /\.(csv|tsv|txt)$/i.test(file.name);
        const wb = isText
          ? XLSX.read(CsvIO.metinCoz(buffer), { type: 'string', raw: true })
          : XLSX.read(buffer, { type: 'array', raw: false });
        const sheetName = wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      }

      if (rows.length === 0) {
        alert('Dosyada okunabilir satır bulunamadı.');
        return;
      }

      headers = Object.keys(rows[0]);

      if (target === 'A') {
        dataA = { name: file.name, rows, headers };
        dropCardA.classList.add('loaded');
        labelCardA.textContent = `✓ ${file.name}`;
        labelCardA.translate = false;   // dosya adı veridir
        subCardA.textContent = `${rows.length.toLocaleString('tr-TR')} satır · ${headers.length} sütun`;
      } else {
        dataB = { name: file.name, rows, headers };
        dropCardB.classList.add('loaded');
        labelCardB.textContent = `✓ ${file.name}`;
        labelCardB.translate = false;
        subCardB.textContent = `${rows.length.toLocaleString('tr-TR')} satır · ${headers.length} sütun`;
      }

      checkBothFilesLoaded();
    } catch (err) {
      alert(`Dosya yüklenirken hata: ${err.message}`);
    }
  }

  function checkBothFilesLoaded() {
    if (dataA && dataB) {
      populateDropdowns();
      configGrid.style.display = 'grid';
      btnRunReconcile.disabled = false;
    }
  }

  function populateDropdowns() {
    fillSelect(selectKeyA, dataA.headers);
    fillSelect(selectKeyB, dataB.headers);

    fillSelect(selectAmountA, dataA.headers, true);
    fillSelect(selectAmountB, dataB.headers, true);

    // Akıllı varsayılan tahmini
    autoSelectKey(selectKeyA, dataA.headers, ['cari', 'unvan', 'musteri', 'firma', 'ad', 'name']);
    autoSelectKey(selectKeyB, dataB.headers, ['cari', 'unvan', 'musteri', 'firma', 'ad', 'name']);

    autoSelectKey(selectAmountA, dataA.headers, ['tutar', 'bakiye', 'borc', 'alacak', 'amount', 'fiyat']);
    autoSelectKey(selectAmountB, dataB.headers, ['tutar', 'bakiye', 'borc', 'alacak', 'amount', 'fiyat']);
  }

  function fillSelect(selectEl, headers, hasEmpty = false) {
    selectEl.innerHTML = '';
    if (hasEmpty) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '-- Seçilmedi --';
      selectEl.appendChild(opt);
    }
    headers.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      opt.translate = false;   // sütun adı veridir
      selectEl.appendChild(opt);
    });
  }

  function autoSelectKey(selectEl, headers, candidates) {
    for (const h of headers) {
      const lower = h.toLowerCase();
      if (candidates.some(c => lower.includes(c))) {
        selectEl.value = h;
        break;
      }
    }
  }

  // --- RECONCILE EXECUTION ---
  btnRunReconcile.addEventListener('click', () => {
    if (!dataA || !dataB) return;

    const keyA = selectKeyA.value;
    const keyB = selectKeyB.value;
    const amountA = selectAmountA.value || null;
    const amountB = selectAmountB.value || null;
    const amountTolerance = parseFloat(inputAmountTol.value) || 0;
    const threshold = parseInt(inputThreshold.value, 10) / 100;

    btnRunReconcile.disabled = true;
    btnRunReconcile.textContent = '⏳ Eşleştiriliyor...';

    // Parça parça çalışan sürüm: büyük tablolarda sayfa donmaz, ilerleme görünür.
    // Sonuç eşzamanlı reconcileTables ile birebir aynıdır.
    FuzzyEngine.reconcileTablesAsync(dataA.rows, dataB.rows, {
      keyA,
      keyB,
      amountA,
      amountB,
      amountTolerance,
      threshold
    }, {
      onProgress: (done, total) => {
        const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
        btnRunReconcile.textContent = `⏳ Eşleştiriliyor... %${pct} (${done.toLocaleString('tr-TR')}/${total.toLocaleString('tr-TR')})`;
      }
    }).then(result => {
      lastReconcileResult = result;
      displayResults(lastReconcileResult);
      resultCard.style.display = 'block';
      resultCard.scrollIntoView({ behavior: 'smooth' });
    }).catch(err => {
      alert(`Mutabakat hatası: ${err.message}`);
    }).finally(() => {
      btnRunReconcile.disabled = false;
      btnRunReconcile.textContent = 'Eşleştirmeyi çalıştır';
    });
  });

  function displayResults(res) {
    const s = res.summary;
    statMatchRate.textContent = `%${s.matchRateA}`;
    statExactCount.textContent = s.exactCount.toLocaleString('tr-TR');
    statFuzzyCount.textContent = s.fuzzyCount.toLocaleString('tr-TR');
    statUnmatchedA.textContent = s.unmatchedACount.toLocaleString('tr-TR');
    statUnmatchedB.textContent = s.unmatchedBCount.toLocaleString('tr-TR');

    countTabFuzzy.textContent = s.fuzzyCount;
    countTabExact.textContent = s.exactCount;
    countTabA.textContent = s.unmatchedACount;
    countTabB.textContent = s.unmatchedBCount;

    // Varsayılan sekmeyi ayarla
    activeTab = s.fuzzyCount > 0 ? 'fuzzy' : 'exact';
    updateActiveTabUI();
    renderActiveTabTable();
  }

  // --- RESULT TABS UI ---
  rtabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.getAttribute('data-tab');
      updateActiveTabUI();
      renderActiveTabTable();
    });
  });

  function updateActiveTabUI() {
    rtabButtons.forEach(b => {
      if (b.getAttribute('data-tab') === activeTab) b.classList.add('is-active');
      else b.classList.remove('is-active');
    });
  }

  // Başlık ve hücreler yalnız textContent ile yazılır: dosyadan gelen sütun adı
  // veya hücre HTML olarak yorumlanmamalı. CSP betiği, uzak görseli ve form
  // gönderimini durdurur ama enjekte edilmiş bir <a href=https://...>
  // bağlantısını durdurmaz; tek tıkla veri dışarı gidebilirdi.
  function setHeader(labels) {
    const tr = document.createElement('tr');
    labels.forEach(label => {
      const th = document.createElement('th');
      th.textContent = label;
      tr.appendChild(th);
    });
    resultHead.appendChild(tr);
  }

  // cells: düz değer (metne çevrilir) veya hazır DOM düğümü
  function appendRow(cells) {
    const tr = document.createElement('tr');
    cells.forEach(cell => {
      const td = document.createElement('td');
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell == null ? '' : String(cell);
      tr.appendChild(td);
    });
    resultBody.appendChild(tr);
  }

  function textEl(tag, text, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text == null ? '' : String(text);
    return el;
  }

  function reasonEl(reason) {
    const span = textEl('span', reason);
    span.style.color = 'var(--danger)';
    return span;
  }

  function renderActiveTabTable() {
    if (!lastReconcileResult) return;
    resultHead.textContent = '';
    resultBody.textContent = '';

    const keyA = selectKeyA.value;
    const keyB = selectKeyB.value;
    const colAmtA = selectAmountA.value;
    const colAmtB = selectAmountB.value;

    if (activeTab === 'fuzzy') {
      setHeader(['#', `Tablo A: ${keyA}`, `Tablo B: ${keyB}`, 'Benzerlik', 'Tutar A', 'Tutar B', 'Fark']);

      lastReconcileResult.fuzzyMatches.forEach((m, i) => {
        const scorePct = Math.round(m.score * 100);
        const badgeClass = scorePct >= 85 ? 'high' : 'medium';
        appendRow([
          i + 1,
          textEl('strong', m.keyA),
          textEl('strong', m.keyB),
          textEl('span', `%${scorePct}`, `score-badge ${badgeClass}`),
          colAmtA ? m.rowA[colAmtA] : '-',
          colAmtB ? m.rowB[colAmtB] : '-',
          m.amountDiff != null ? `${m.amountDiff} TL` : '-'
        ]);
      });
    } else if (activeTab === 'exact') {
      setHeader(['#', `Tablo A: ${keyA}`, `Tablo B: ${keyB}`, 'Tutar A', 'Tutar B']);

      lastReconcileResult.exactMatches.forEach((m, i) => {
        appendRow([
          i + 1,
          m.keyA,
          m.keyB,
          colAmtA ? m.rowA[colAmtA] : '-',
          colAmtB ? m.rowB[colAmtB] : '-'
        ]);
      });
    } else if (activeTab === 'unmatchedA') {
      setHeader(['#', `Tablo A: ${keyA}`, 'Tutar', 'Neden']);

      lastReconcileResult.unmatchedA.forEach((u, i) => {
        appendRow([i + 1, u.keyA, colAmtA ? u.rowA[colAmtA] : '-', reasonEl(u.reason)]);
      });
    } else if (activeTab === 'unmatchedB') {
      setHeader(['#', `Tablo B: ${keyB}`, 'Tutar', 'Neden']);

      lastReconcileResult.unmatchedB.forEach((u, i) => {
        appendRow([i + 1, u.keyB, colAmtB ? u.rowB[colAmtB] : '-', reasonEl(u.reason)]);
      });
    }
  }

  // --- EXPORT TO EXCEL & CSV ---
  btnExportExcel.addEventListener('click', () => {
    if (!lastReconcileResult || typeof XLSX === 'undefined') return;

    const mergedRows = [];
    const allMatches = [...lastReconcileResult.exactMatches, ...lastReconcileResult.fuzzyMatches];

    allMatches.forEach(m => {
      const combined = {};
      // Tablo A kolonları
      for (const [k, v] of Object.entries(m.rowA)) {
        combined[`[A]_${k}`] = v;
      }
      // Tablo B kolonları
      for (const [k, v] of Object.entries(m.rowB)) {
        combined[`[B]_${k}`] = v;
      }
      combined['Eslesme_Skoru'] = `%${Math.round(m.score * 100)}`;
      if (m.amountDiff != null) combined['Tutar_Farki'] = m.amountDiff;
      mergedRows.push(combined);
    });

    const ws = XLSX.utils.json_to_sheet(mergedRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Mutabakat_Birlestirilmis');
    XLSX.writeFile(wb, 'mutabakat_sonuc_birlestirilmis.xlsx', { compression: true });
  });

  btnExportCsv.addEventListener('click', () => {
    if (!lastReconcileResult) return;
    const allMatches = [...lastReconcileResult.exactMatches, ...lastReconcileResult.fuzzyMatches];
    const rows = [['KeyA', 'KeyB', 'Skor']];
    allMatches.forEach(m => {
      rows.push([m.keyA, m.keyB, `%${Math.round(m.score * 100)}`]);
    });
    // BOM + ';' ayraç (Türkçe Excel) + tırnak kaçışı + formül enjeksiyonu koruması
    const csv = FuzzyEngine.buildCsv(rows, { delimiter: ';' });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mutabakat_eslesenler.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });

  // --- UTILS ---
  function setupDragDrop(el, onDrop) {
    ['dragenter', 'dragover'].forEach(name => {
      el.addEventListener(name, (e) => {
        e.preventDefault();
        el.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      el.addEventListener(name, (e) => {
        e.preventDefault();
        el.classList.remove('dragover');
      });
    });
    el.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) onDrop(files[0]);
    });
  }
})();
