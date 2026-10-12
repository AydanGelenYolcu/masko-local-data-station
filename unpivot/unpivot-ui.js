/**
 * unpivot-ui.js
 * Unpivot (Genişten Uzuna Tablo Dönüştürücü) Arayüz Kontrolörü
 */

(function () {
  'use strict';

  let rawHeaders = [];
  let rawRows = [];
  let currentFileName = '';
  let unpivotResult = null;

  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const configSection = document.getElementById('configSection');
  const resultSection = document.getElementById('resultSection');

  const idColList = document.getElementById('idColList');
  const valColList = document.getElementById('valColList');
  const inputAttrName = document.getElementById('inputAttrName');
  const inputValName = document.getElementById('inputValName');
  const chkSkipEmpty = document.getElementById('chkSkipEmpty');

  const statInRows = document.getElementById('statInRows');
  const statOutRows = document.getElementById('statOutRows');
  const statRatio = document.getElementById('statRatio');
  const statSkipped = document.getElementById('statSkipped');

  const previewTableWrap = document.getElementById('previewTableWrap');
  const btnExportXlsx = document.getElementById('btnExportXlsx');
  const btnExportCsv = document.getElementById('btnExportCsv');

  // Drag & drop ve dosya seçimi
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  async function handleFile(file) {
    currentFileName = file.name.replace(/\.[^/.]+$/, '');
    const ext = file.name.split('.').pop().toLowerCase();

    try {
      const arrayBuffer = await file.arrayBuffer();
      if (typeof XLSX === 'undefined') {
        alert('SheetJS (XLSX) kütüphanesi yüklenemedi.');
        return;
      }

      // Tarih başlıkları/hücreleri seri sayı (45306) yerine "yyyy-mm-dd" gelir;
      // CSV birebir metin okunur (baştaki sıfırlar, TR sayı biçimi korunur).
      const data = window.UnpivotEngine.readSheetRows(XLSX, arrayBuffer, file.name);

      if (!data || data.length < 2) {
        alert('Yüklenen tabloda en az 1 başlık ve 1 veri satırı bulunmalıdır.');
        return;
      }

      rawHeaders = data[0].map((h, i) => (h === '' || h == null ? `Sütun_${i + 1}` : String(h).trim()));
      rawRows = data.slice(1);

      document.getElementById('labelFileName').textContent = file.name;
      document.getElementById('labelFileName').translate = false;   // dosya adı veridir
      document.getElementById('labelFileMeta').textContent = `${rawHeaders.length} Sütun · ${rawRows.length} Satır`;

      populateColumnSelectors();
      configSection.style.display = 'flex';
      runUnpivot();
    } catch (err) {
      alert('Dosya okunurken hata oluştu: ' + err.message);
    }
  }

  // Sütun adı dosyadan gelir; DOM ile kurulur ki "<form action=https://...>"
  // gibi bir başlık HTML olarak yorumlanmasın (sıfır ağ garantisi).
  function createColumnCheckbox(name, idx, col, checked, onChange) {
    const item = document.createElement('label');
    item.className = 'col-checkbox-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.value = String(idx);
    input.checked = checked;
    input.addEventListener('change', onChange);
    const span = document.createElement('span');
    span.textContent = col;
    item.appendChild(input);
    item.appendChild(span);
    return item;
  }

  function populateColumnSelectors() {
    idColList.textContent = '';
    valColList.textContent = '';

    rawHeaders.forEach((col, idx) => {
      // Varsayılan kural: İlk 1-2 sütun ID, kalanlar Value
      const isDefaultId = idx === 0 || (rawHeaders.length > 3 && idx === 1 && isNaN(Number(rawRows[0]?.[idx])));

      idColList.appendChild(createColumnCheckbox('idCol', idx, col, isDefaultId, () => {
        syncValueCheckboxes();
        runUnpivot();
      }));
      valColList.appendChild(createColumnCheckbox('valCol', idx, col, !isDefaultId, runUnpivot));
    });
  }

  function syncValueCheckboxes() {
    const checkedIdIndices = Array.from(idColList.querySelectorAll('input:checked')).map(el => Number(el.value));
    valColList.querySelectorAll('input').forEach(chk => {
      const idx = Number(chk.value);
      if (checkedIdIndices.includes(idx)) {
        chk.checked = false;
        chk.disabled = true;
      } else {
        chk.disabled = false;
      }
    });
  }

  // Yeni sütunların varsayılan adları arayüz dilinde gelir (çıktı dosyasına
  // yazılırlar). Kullanıcı kendi adını yazdıysa dokunulmaz.
  const VARSAYILAN_AD = { tr: ['Dönem', 'Değer'], en: ['Period', 'Value'] };
  function varsayilanAdlariYaz() {
    const dil = window.MaskoDil && window.MaskoDil.dil() === 'en' ? 'en' : 'tr';
    let degisti = false;
    [inputAttrName, inputValName].forEach((el, i) => {
      if ((el.value === VARSAYILAN_AD.tr[i] || el.value === VARSAYILAN_AD.en[i]) && el.value !== VARSAYILAN_AD[dil][i]) {
        el.value = VARSAYILAN_AD[dil][i];
        degisti = true;
      }
    });
    if (degisti && rawHeaders.length) runUnpivot();
  }
  varsayilanAdlariYaz();
  if (window.MaskoDil) window.MaskoDil.degisince(varsayilanAdlariYaz);

  inputAttrName.addEventListener('input', runUnpivot);
  inputValName.addEventListener('input', runUnpivot);
  chkSkipEmpty.addEventListener('change', runUnpivot);

  function runUnpivot() {
    const idCols = Array.from(idColList.querySelectorAll('input:checked')).map(el => Number(el.value));
    const valCols = Array.from(valColList.querySelectorAll('input:checked:not(:disabled)')).map(el => Number(el.value));

    if (idCols.length === 0 || valCols.length === 0) {
      resultSection.style.display = 'none';
      return;
    }

    try {
      unpivotResult = window.UnpivotEngine.unpivotTable(rawHeaders, rawRows, {
        idColumns: idCols,
        valueColumns: valCols,
        attributeName: inputAttrName.value || 'Dönem',
        valueName: inputValName.value || 'Değer',
        skipEmpty: chkSkipEmpty.checked
      });

      renderResults(unpivotResult);
    } catch (err) {
      console.warn('Unpivot çalıştırılamadı:', err.message);
      resultSection.style.display = 'none';
    }
  }

  function renderResults(res) {
    resultSection.style.display = 'flex';

    statInRows.textContent = res.stats.inputRows.toLocaleString('tr-TR');
    statOutRows.textContent = res.stats.outputRows.toLocaleString('tr-TR');
    const ratio = res.stats.inputRows > 0 ? (res.stats.outputRows / res.stats.inputRows).toFixed(1) + 'x' : '1x';
    statRatio.textContent = ratio;
    statSkipped.textContent = res.stats.skippedEmptyCount.toLocaleString('tr-TR');

    // Önizleme Tablosu (İlk 100 satır)
    const previewCount = Math.min(res.rows.length, 100);
    const table = document.createElement('table');
    table.className = 'unpivot-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    res.headers.forEach(h => {
      const th = document.createElement('th');
      th.textContent = h;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let i = 0; i < previewCount; i++) {
      const tr = document.createElement('tr');
      res.rows[i].forEach(cell => {
        const td = document.createElement('td');
        td.textContent = String(cell !== null && cell !== undefined ? cell : '');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    previewTableWrap.textContent = '';
    previewTableWrap.appendChild(table);
  }

  // Dışa Aktar: Excel (.xlsx)
  btnExportXlsx.addEventListener('click', () => {
    if (!unpivotResult) return;
    const wb = XLSX.utils.book_new();
    const wsData = [unpivotResult.headers, ...unpivotResult.rows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Unpivot_Veri');
    XLSX.writeFile(wb, `${currentFileName}_unpivoted.xlsx`, { compression: true });
  });

  // Dışa Aktar: CSV (UTF-8 BOM)
  btnExportCsv.addEventListener('click', () => {
    if (!unpivotResult) return;
    const wsData = [unpivotResult.headers, ...unpivotResult.rows];
    // BOM + t\u0131rnak ka\u00E7\u0131\u015F\u0131 + ba\u015Fl\u0131klar d\u00E2hil form\u00FCl enjeksiyonu korumas\u0131
    const csvContent = window.UnpivotEngine.buildCsv(wsData, { delimiter: ';' });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentFileName}_unpivoted.csv`;
    a.click();
    // Hemen iptal edilirse baz\u0131 taray\u0131c\u0131larda indirme ba\u015Flamadan URL \u00F6l\u00FCr
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
})();
