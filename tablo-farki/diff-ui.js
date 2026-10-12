/**
 * diff-ui.js
 * Hücre Düzeyinde Tablo Karşılaştırıcı Arayüz Kontrolörü
 */

(function () {
  'use strict';

  let tableA = null; // { name, headers, rows }
  let tableB = null; // { name, headers, rows }
  let diffResult = null;
  let activeFilter = 'all'; // 'all', 'diff_only', 'modified', 'added', 'deleted', 'duplicate', 'blank_key'

  const dropCardA = document.getElementById('dropCardA');
  const dropCardB = document.getElementById('dropCardB');
  const fileInputA = document.getElementById('fileInputA');
  const fileInputB = document.getElementById('fileInputB');
  const labelCardA = document.getElementById('labelCardA');
  const subCardA = document.getElementById('subCardA');
  const labelCardB = document.getElementById('labelCardB');
  const subCardB = document.getElementById('subCardB');

  const configSection = document.getElementById('configSection');
  const keySelectorList = document.getElementById('keySelectorList');
  const chkIgnoreCase = document.getElementById('chkIgnoreCase');
  const chkTrim = document.getElementById('chkTrim');
  const chkNumeric = document.getElementById('chkNumeric');

  const resultSection = document.getElementById('resultSection');
  const statAdded = document.getElementById('statAdded');
  const statDeleted = document.getElementById('statDeleted');
  const statModified = document.getElementById('statModified');
  const statUnchanged = document.getElementById('statUnchanged');
  const statDuplicate = document.getElementById('statDuplicate');
  const statBlankKey = document.getElementById('statBlankKey');
  const statCells = document.getElementById('statCells');

  const tableDiffWrap = document.getElementById('tableDiffWrap');
  const filterBtns = document.querySelectorAll('.filter-btn');
  const btnExportXlsx = document.getElementById('btnExportXlsx');
  const btnExportCsv = document.getElementById('btnExportCsv');

  // Dosya Seçim & Sürükle Bırak Dinleyicileri
  setupDropZone(dropCardA, fileInputA, (file) => handleLoadTable(file, 'A'));
  setupDropZone(dropCardB, fileInputB, (file) => handleLoadTable(file, 'B'));

  function setupDropZone(cardEl, inputEl, onFile) {
    cardEl.addEventListener('click', () => inputEl.click());
    inputEl.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        onFile(e.target.files[0]);
      }
    });

    cardEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      cardEl.classList.add('drag-over');
    });

    cardEl.addEventListener('dragleave', () => {
      cardEl.classList.remove('drag-over');
    });

    cardEl.addEventListener('drop', (e) => {
      e.preventDefault();
      cardEl.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        onFile(e.dataTransfer.files[0]);
      }
    });
  }

  async function handleLoadTable(file, target) {
    try {
      const buffer = await file.arrayBuffer();
      if (typeof XLSX === 'undefined') {
        alert('SheetJS (XLSX) kütüphanesi yüklenemedi.');
        return;
      }

      // CSV birebir metin, XLSX tarihleri "yyyy-mm-dd" metni olarak okunur;
      // böylece XLSX ile CSV kıyasında tarihler seri sayı olarak "değişmiş" görünmez.
      const data = window.TabularDiffEngine.readSheetRows(XLSX, buffer, file.name);

      if (!data || data.length < 2) {
        alert('Tabloda en az 1 başlık ve 1 veri satırı olmalıdır.');
        return;
      }

      const headers = data[0].map((h, i) => (h === '' || h == null ? `Sütun_${i + 1}` : String(h).trim()));
      const rows = data.slice(1);

      if (target === 'A') {
        tableA = { name: file.name, headers, rows };
        labelCardA.textContent = file.name;
        labelCardA.translate = false;   // dosya adı veridir
        subCardA.textContent = `Tablo A: ${headers.length} Sütun · ${rows.length} Satır`;
        dropCardA.classList.add('loaded');
      } else {
        tableB = { name: file.name, headers, rows };
        labelCardB.textContent = file.name;
        labelCardB.translate = false;
        subCardB.textContent = `Tablo B: ${headers.length} Sütun · ${rows.length} Satır`;
        dropCardB.classList.add('loaded');
      }

      if (tableA && tableB) {
        populateKeySelectors();
        configSection.style.display = 'flex';
        runDiff();
      }
    } catch (err) {
      alert('Dosya okunurken hata oluştu: ' + err.message);
    }
  }

  function populateKeySelectors() {
    keySelectorList.textContent = '';
    // Tablo A'nın ortak sütunlarını listele
    const commonHeaders = tableA.headers.filter(h => tableB.headers.includes(h));

    commonHeaders.forEach((col, idx) => {
      const isDefault = idx === 0 || /id|no|kod|tc|sicil|key|ref/i.test(col);
      const label = document.createElement('label');
      label.className = 'key-chip';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'diffKey';
      input.value = col;
      input.checked = isDefault;
      input.addEventListener('change', runDiff);
      const span = document.createElement('span');
      span.textContent = col;
      label.appendChild(input);
      label.appendChild(span);
      keySelectorList.appendChild(label);
    });
  }

  chkIgnoreCase.addEventListener('change', runDiff);
  chkTrim.addEventListener('change', runDiff);
  if (chkNumeric) chkNumeric.addEventListener('change', runDiff);

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderDiffTable();
    });
  });

  function runDiff() {
    if (!tableA || !tableB) return;

    const checkedKeys = Array.from(keySelectorList.querySelectorAll('input:checked')).map(el => el.value);
    if (checkedKeys.length === 0) {
      resultSection.style.display = 'none';
      return;
    }

    try {
      diffResult = window.TabularDiffEngine.diffTables(
        tableA.headers,
        tableA.rows,
        tableB.headers,
        tableB.rows,
        {
          keyColumns: checkedKeys,
          ignoreCase: chkIgnoreCase.checked,
          trimWhitespace: chkTrim.checked,
          numericEquivalence: chkNumeric ? chkNumeric.checked : true
        }
      );

      renderStats(diffResult);
      renderDiffTable();
      resultSection.style.display = 'flex';
    } catch (err) {
      console.warn('Tabular Diff çalıştırılamadı:', err.message);
      resultSection.style.display = 'none';
    }
  }

  function renderStats(res) {
    const s = res.stats;
    statAdded.textContent = `+${s.addedCount.toLocaleString('tr-TR')} Yeni`;
    statDeleted.textContent = `-${s.deletedCount.toLocaleString('tr-TR')} Silinen`;
    statModified.textContent = `~${s.modifiedCount.toLocaleString('tr-TR')} Değişen`;
    statUnchanged.textContent = `=${s.unchangedCount.toLocaleString('tr-TR')} Değişmeyen`;
    // Tekrarlı / boş anahtarlı satırlar kıyaslanamaz ama asla sessizce düşmez
    if (statDuplicate) {
      const dupRows = s.duplicateRowsA + s.duplicateRowsB;
      statDuplicate.textContent = `${s.duplicateKeyCount.toLocaleString('tr-TR')} Tekrarlı Anahtar (A: ${s.duplicateRowsA.toLocaleString('tr-TR')} · B: ${s.duplicateRowsB.toLocaleString('tr-TR')} satır)`;
      statDuplicate.style.display = dupRows > 0 ? '' : 'none';
    }
    if (statBlankKey) {
      const blankRows = s.blankKeyRowsA + s.blankKeyRowsB;
      statBlankKey.textContent = `∅ Boş Anahtar (A: ${s.blankKeyRowsA.toLocaleString('tr-TR')} · B: ${s.blankKeyRowsB.toLocaleString('tr-TR')} satır)`;
      statBlankKey.style.display = blankRows > 0 ? '' : 'none';
    }
    statCells.textContent = `Toplam ${s.cellModificationsCount.toLocaleString('tr-TR')} hücre değişti`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function cellText(val) {
    return String(val !== null && val !== undefined ? val : '');
  }

  function statusBadge(item) {
    if (item.status === 'added') return el('span', 'tag-badge tag-added', '+ Eklendi');
    if (item.status === 'deleted') return el('span', 'tag-badge tag-deleted', '- Silindi');
    if (item.status === 'modified') return el('span', 'tag-badge tag-modified', `~ Değişti (${item.changes.length})`);
    if (item.status === 'duplicate') {
      return el('span', 'tag-badge tag-duplicate', `Tekrarlı anahtar · Tablo ${item.side} (A×${item.countA} / B×${item.countB})`);
    }
    if (item.status === 'blank_key') return el('span', 'tag-badge tag-blank', `∅ Boş Anahtar · Tablo ${item.side}`);
    const same = el('span', '', 'Aynen');
    same.style.color = 'var(--text-muted)';
    same.style.fontSize = '11px';
    return same;
  }

  const ROW_CLASS = {
    added: 'row-added',
    deleted: 'row-deleted',
    modified: 'row-modified',
    duplicate: 'row-duplicate',
    blank_key: 'row-blank'
  };

  // Tablo DOM ile kurulur: hücre veya başlık "<form action=https://...>" gibi
  // işaretleme içerse bile metin olarak görünür (sıfır ağ garantisi).
  function renderDiffTable() {
    if (!diffResult) return;

    const filteredRows = diffResult.diffRows.filter(row => {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'diff_only') return row.status !== 'unchanged';
      return row.status === activeFilter;
    });

    const displayHeaders = ['Durum', ...diffResult.schema.commonHeaders];
    const table = el('table', 'diff-table');
    const thead = el('thead');
    const headRow = el('tr');
    // İlk başlık ("Durum") ve rozetler arayüz metnidir; sütun adları ve
    // hücreler veridir, dil.js çevirmesin ("Tarih" hücresi "Date" olmasın).
    displayHeaders.forEach((h, i) => {
      const th = el('th', '', h);
      if (i > 0) th.translate = false;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    const maxDisplay = Math.min(filteredRows.length, 250);
    const idxMapA = new Map(tableA.headers.map((h, i) => [h, i]));
    const idxMapB = new Map(tableB.headers.map((h, i) => [h, i]));

    for (let i = 0; i < maxDisplay; i++) {
      const item = filteredRows[i];
      const tr = el('tr', ROW_CLASS[item.status] || '');
      const badgeTd = el('td');
      badgeTd.appendChild(statusBadge(item));
      tr.appendChild(badgeTd);

      const changeMap = new Map();
      if (item.changes) {
        item.changes.forEach(c => changeMap.set(c.column, c));
      }

      diffResult.schema.commonHeaders.forEach(colName => {
        const td = el('td');
        td.translate = false;
        if (changeMap.has(colName)) {
          const ch = changeMap.get(colName);
          const box = el('div', 'cell-diff');
          box.appendChild(el('span', 'val-old', cellText(ch.oldValue)));
          box.appendChild(el('span', 'val-arrow', '→'));
          box.appendChild(el('span', 'val-new', cellText(ch.newValue)));
          td.appendChild(box);
        } else {
          const val = item.rowB ? item.rowB[idxMapB.get(colName)] : (item.rowA ? item.rowA[idxMapA.get(colName)] : '');
          td.textContent = cellText(val);
        }
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    }

    if (filteredRows.length === 0) {
      const tr = el('tr');
      const td = el('td', '', 'Bu filtreye uygun kayıt bulunamadı.');
      td.colSpan = displayHeaders.length;
      td.style.textAlign = 'center';
      td.style.padding = '24px';
      td.style.color = 'var(--text-muted)';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    tableDiffWrap.textContent = '';
    tableDiffWrap.appendChild(table);
  }

  // Ortak sütun değerlerini satırın geldiği tabloya göre sırala
  function commonValues(item) {
    const common = diffResult.schema.commonHeaders;
    if (item.rowA) return common.map(h => item.rowA[tableA.headers.indexOf(h)]);
    return common.map(h => item.rowB[tableB.headers.indexOf(h)]);
  }

  function rowSummary(row) {
    return (row || []).map(cellText).join(' | ');
  }

  // Excel (.xlsx) Dışa Aktarımı
  btnExportXlsx.addEventListener('click', () => {
    if (!diffResult) return;
    const wb = XLSX.utils.book_new();
    const s = diffResult.stats;

    // 1. Özet Sayfası
    const summaryData = [
      ['Rapor Türü', 'Tablo Karşılaştırma ve Audit Raporu'],
      ['Eski Tablo (A)', tableA.name],
      ['Yeni Tablo (B)', tableB.name],
      ['Anahtar Sütunlar', diffResult.keyNames.join(', ')],
      ['Toplam Satır (A / B)', `${s.totalRowsA} / ${s.totalRowsB}`],
      ['Toplam Eklenen Satır', s.addedCount],
      ['Toplam Silinen Satır', s.deletedCount],
      ['Toplam Değişen Satır', s.modifiedCount],
      ['Değişmeyen Satır', s.unchangedCount],
      ['Tekrarlı Anahtar Sayısı', s.duplicateKeyCount],
      ['Tekrarlı Anahtarlı Satır (A / B)', `${s.duplicateRowsA} / ${s.duplicateRowsB}`],
      ['Boş Anahtarlı Satır (A / B)', `${s.blankKeyRowsA} / ${s.blankKeyRowsB}`],
      ['Hücre Düzeyinde Değişiklik Sayısı', s.cellModificationsCount]
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Özet');

    // 2. Hücre Değişiklik Detayı Sayfası
    const changesData = [['Anahtar', 'Sütun', 'Eski Değer (Tablo A)', 'Yeni Değer (Tablo B)']];
    diffResult.diffRows.filter(r => r.status === 'modified').forEach(r => {
      r.changes.forEach(c => {
        changesData.push([r.keyLabel, c.column, c.oldValue, c.newValue]);
      });
    });
    const wsChanges = XLSX.utils.aoa_to_sheet(changesData);
    XLSX.utils.book_append_sheet(wb, wsChanges, 'Hücre_Değişiklikleri');

    // 3. Eklenenler Sayfası
    const addedRows = diffResult.diffRows.filter(r => r.status === 'added').map(r => r.rowB);
    if (addedRows.length > 0) {
      const wsAdded = XLSX.utils.aoa_to_sheet([tableB.headers, ...addedRows]);
      XLSX.utils.book_append_sheet(wb, wsAdded, 'Eklenen_Satırlar');
    }

    // 4. Silinenler Sayfası
    const deletedRows = diffResult.diffRows.filter(r => r.status === 'deleted').map(r => r.rowA);
    if (deletedRows.length > 0) {
      const wsDeleted = XLSX.utils.aoa_to_sheet([tableA.headers, ...deletedRows]);
      XLSX.utils.book_append_sheet(wb, wsDeleted, 'Silinen_Satırlar');
    }

    // 5. Tekrarlı ve boş anahtarlı satırlar (kıyaslanamayanlar)
    const dupItems = diffResult.diffRows.filter(r => r.status === 'duplicate');
    if (dupItems.length > 0) {
      const dupData = [['Tablo', 'Anahtar', 'A Adet', 'B Adet', ...diffResult.schema.commonHeaders]];
      dupItems.forEach(r => dupData.push([r.side, r.keyLabel, r.countA, r.countB, ...commonValues(r)]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dupData), 'Tekrarlı_Anahtarlar');
    }
    const blankItems = diffResult.diffRows.filter(r => r.status === 'blank_key');
    if (blankItems.length > 0) {
      const blankData = [['Tablo', ...diffResult.schema.commonHeaders]];
      blankItems.forEach(r => blankData.push([r.side, ...commonValues(r)]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(blankData), 'Boş_Anahtarlar');
    }

    XLSX.writeFile(wb, `Tablo_Fark_Raporu_${Date.now()}.xlsx`, { compression: true });
  });

  // CSV Dışa Aktarımı
  btnExportCsv.addEventListener('click', () => {
    if (!diffResult) return;
    const csvRows = [['Durum', 'Anahtar', 'Sütun', 'Eski Değer', 'Yeni Değer']];

    diffResult.diffRows.forEach(r => {
      if (r.status === 'modified') {
        r.changes.forEach(c => {
          csvRows.push(['DEGISEN', r.keyLabel, c.column, c.oldValue, c.newValue]);
        });
      } else if (r.status === 'added') {
        csvRows.push(['EKLENEN', r.keyLabel, 'TÜM_SATIR', '', '']);
      } else if (r.status === 'deleted') {
        csvRows.push(['SILINEN', r.keyLabel, 'TÜM_SATIR', '', '']);
      } else if (r.status === 'duplicate') {
        // Anahtar belirsiz olduğu için satırın kendisi yazılır
        csvRows.push(['TEKRARLI_ANAHTAR', r.keyLabel, `TABLO_${r.side} (A×${r.countA} / B×${r.countB})`,
          r.side === 'A' ? rowSummary(r.rowA) : '', r.side === 'B' ? rowSummary(r.rowB) : '']);
      } else if (r.status === 'blank_key') {
        csvRows.push(['BOS_ANAHTAR', '', `TABLO_${r.side}`,
          r.side === 'A' ? rowSummary(r.rowA) : '', r.side === 'B' ? rowSummary(r.rowB) : '']);
      }
    });

    // BOM + tırnak kaçışı + başlıklar dâhil formül enjeksiyonu koruması
    const csvContent = window.TabularDiffEngine.buildCsv(csvRows, { delimiter: ';' });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Tablo_Fark_Detay_${Date.now()}.csv`;
    a.click();
    // Hemen iptal edilirse bazı tarayıcılarda indirme başlamadan URL ölür
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
})();
