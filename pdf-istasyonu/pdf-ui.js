/**
 * Masko — Çevrimdışı Güvenli PDF İstasyonu Kullanıcı Arayüzü (pdf-ui.js)
 */
(function () {
  'use strict';

  // DOM Elements - Organize Mode
  const organizeDropzone = document.getElementById('organizeDropzone');
  const organizeFileInput = document.getElementById('organizeFileInput');
  const organizeWorkspace = document.getElementById('organizeWorkspace');
  const organizeFileName = document.getElementById('organizeFileName');
  const organizePageCount = document.getElementById('organizePageCount');
  const btnChangeOrganizeFile = document.getElementById('btnChangeOrganizeFile');
  const btnRotateAllRight = document.getElementById('btnRotateAllRight');
  const btnResetPages = document.getElementById('btnResetPages');
  const pageRangeInput = document.getElementById('pageRangeInput');
  const btnExtractRange = document.getElementById('btnExtractRange');
  const btnSplitSinglePages = document.getElementById('btnSplitSinglePages');
  const pagesGrid = document.getElementById('pagesGrid');
  const btnExportOrganizedPdf = document.getElementById('btnExportOrganizedPdf');

  // DOM Elements - Merge Mode
  const mergeDropzone = document.getElementById('mergeDropzone');
  const mergeFileInput = document.getElementById('mergeFileInput');
  const mergeWorkspace = document.getElementById('mergeWorkspace');
  const mergeFileCount = document.getElementById('mergeFileCount');
  const btnAddMoreMergeFiles = document.getElementById('btnAddMoreMergeFiles');
  const btnClearMergeList = document.getElementById('btnClearMergeList');
  const mergeFileList = document.getElementById('mergeFileList');
  const btnExecuteMerge = document.getElementById('btnExecuteMerge');

  // State
  let currentFileBytes = null;
  let currentFileName = '';
  let currentPageStates = []; // [{ originalIndex, rotationDelta: 0, isDeleted: false, baseRotation: 0, width, height }]
  let mergeFiles = []; // [{ name, bytes, pageCount }]

  // --- TAB NAVIGATION ---
  const sekmeler = Array.from(document.querySelectorAll('.pdf-tab-btn[data-tab]'));
  const paneller = Array.from(document.querySelectorAll('.pdf-panel[data-panel]'));
  sekmeler.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  function switchTab(mode) {
    sekmeler.forEach(b => {
      const aktif = b.dataset.tab === mode;
      b.classList.toggle('is-active', aktif);
      b.setAttribute('aria-selected', aktif ? 'true' : 'false');
    });
    paneller.forEach(p => { p.hidden = p.dataset.panel !== mode; });
  }

  // --- DOWNLOAD HELPER ---
  function downloadBlob(bytes, filename, mimeType = 'application/pdf') {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Dosyaları tek ZIP'te toplar. Adlar Türkçe harfleriyle (UTF-8) yazılır;
   * yalnız Windows'ta dosya adında yasak olan işaretler "_" olur.
   */
  function buildZipBytes(files) {
    return PdfEngine.zipOlustur(files.map(f => ({
      fileName: String(f.fileName).replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_'),
      bytes: f.bytes
    })));
  }

  // =========================================================================
  // 1. SAYFA DÜZENLEME / BÖLME / DÖNDÜRME MODU
  // =========================================================================
  organizeDropzone.addEventListener('click', () => organizeFileInput.click());
  organizeFileInput.addEventListener('change', handleOrganizeFileSelect);

  setupDragAndDrop(organizeDropzone, (files) => {
    if (files.length > 0 && files[0].name.toLowerCase().endsWith('.pdf')) {
      loadOrganizePdf(files[0]);
    }
  });

  btnChangeOrganizeFile.addEventListener('click', () => {
    organizeFileInput.value = '';
    organizeFileInput.click();
  });

  function handleOrganizeFileSelect(e) {
    const file = e.target.files && e.target.files[0];
    if (file) loadOrganizePdf(file);
  }

  async function loadOrganizePdf(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Şifreli PDF burada reddedilir; durum yalnız başarılı yüklemede
      // güncellenir ki önceki dosyanın sayfa listesi yanlış baytlarla kalmasın.
      const info = await PdfEngine.getPdfInfo(bytes);
      currentFileName = file.name;
      currentFileBytes = bytes;
      organizeFileName.textContent = file.name;
      organizePageCount.textContent = `${info.pageCount} sayfa`;
      orijinalSayfalar = info.pages;
      kucukResimleriBaslat(bytes);
      sayfaDurumlariniKur();
      renderPageGrid();
      organizeDropzone.hidden = true;
      organizeWorkspace.hidden = false;
    } catch (err) {
      alert(`PDF yüklenirken hata oluştu: ${err.message}`);
    }
  }

  /* SAYFA KÜÇÜK RESİMLERİ (pdf.js)
     Sayfalar arka planda tek tek çizilip kartlara yerleşir. Yeni dosya
     seçilince eski çizim bırakılır (oturum numarası). Çok sayfalı belgede
     ilk 400 sayfa çizilir; gerisi numarayla kalır. */
  let kucukResimler = {};
  let kucukOturum = 0;
  async function kucukResimleriBaslat(bytes) {
    const oturum = ++kucukOturum;
    kucukResimler = {};
    if (typeof PdfRender === 'undefined' || !PdfRender.destekleniyor()) return;   // önizleme isteğe bağlı
    let belge;
    try { belge = await PdfRender.ac(bytes); } catch (err) { console.warn('Önizleme açılamadı:', err); return; }
    try {
      const sinir = Math.min(belge.numPages, 400);
      for (let no = 1; no <= sinir; no++) {
        if (oturum !== kucukOturum) return;
        const tuval = await PdfRender.sayfaCiz(belge, no, { genislik: 220 });
        kucukResimler[no - 1] = tuval.toDataURL('image/jpeg', 0.8);
        const kutu = pagesGrid.querySelector(`.pdf-page-card[data-orijinal="${no - 1}"] .pdf-page-preview`);
        if (kutu) { kutu.textContent = ''; const img = document.createElement('img'); img.src = kucukResimler[no - 1]; img.alt = ''; kutu.appendChild(img); }
      }
    } catch (err) {
      console.warn('Önizleme çizilemedi:', err);
    } finally {
      PdfRender.kapat(belge);
    }
  }

  // Dizi sırası çıktının sayfa sırasıdır; boş sayfalar { blank: true } öğesidir.
  let orijinalSayfalar = [];
  function sayfaDurumlariniKur() {
    currentPageStates = orijinalSayfalar.map(p => ({
      originalIndex: p.index,
      pageNum: p.pageNum,
      baseRotation: p.rotation,
      rotationDelta: 0,
      isDeleted: false,
      width: p.width,
      height: p.height
    }));
  }

  let suruklenen = -1;

  function renderPageGrid() {
    pagesGrid.innerHTML = '';

    currentPageStates.forEach((page, idx) => {
      const card = document.createElement('div');
      card.className = 'pdf-page-card' + (page.isDeleted ? ' is-deleted' : '') + (page.blank ? ' is-blank' : '');
      card.draggable = true;
      card.dataset.index = String(idx);
      if (!page.blank) card.dataset.orijinal = String(page.originalIndex);
      const etiket = page.blank ? 'Boş sayfa' : `Sayfa ${page.pageNum}`;

      card.innerHTML = `
        <div class="pdf-page-meta">
          <span>${idx + 1}. ${etiket}</span>
          <span style="font-size:11px; opacity:0.8;">${Math.round(page.width)}x${Math.round(page.height)}</span>
        </div>
        <div class="pdf-page-preview" style="transform: rotate(${page.rotationDelta}deg)">
          ${!page.blank && kucukResimler[page.originalIndex] ? `<img src="${kucukResimler[page.originalIndex]}" alt="">` : `<span style="margin-top:6px;">${page.blank ? '' : page.pageNum}</span>`}
        </div>
        <div class="pdf-page-actions">
          <button class="icon-btn" data-action="rotate-left" data-index="${idx}" title="Sola 90° döndür">↺</button>
          <button class="icon-btn" data-action="rotate-right" data-index="${idx}" title="Sağa 90° döndür">↻</button>
          <button class="icon-btn" data-action="add-blank" data-index="${idx}" title="Bu sayfanın arkasına boş sayfa ekle">Boş ekle</button>
          <button class="icon-btn" data-action="toggle-delete" data-index="${idx}" title="${page.isDeleted ? 'Geri getir' : 'Sil'}" style="color:${page.isDeleted ? 'var(--ok)' : 'var(--danger)'}">
            ${page.isDeleted ? 'Geri al' : 'Sil'}
          </button>
        </div>
      `;

      pagesGrid.appendChild(card);
    });

    // Olay dinleyicileri
    pagesGrid.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const index = parseInt(btn.getAttribute('data-index'), 10);
        handlePageAction(action, index);
      });
    });
  }

  // Sürükle-bırak ile sıralama: bırakılan kartın yerine taşınır.
  pagesGrid.addEventListener('dragstart', e => {
    const kart = e.target.closest('.pdf-page-card');
    if (!kart) return;
    suruklenen = parseInt(kart.dataset.index, 10);
    kart.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', kart.dataset.index);
  });
  pagesGrid.addEventListener('dragover', e => {
    const kart = e.target.closest('.pdf-page-card');
    if (!kart || suruklenen < 0) return;
    e.preventDefault();
    pagesGrid.querySelectorAll('.is-drop-target').forEach(k => k.classList.remove('is-drop-target'));
    kart.classList.add('is-drop-target');
  });
  pagesGrid.addEventListener('dragend', () => {
    suruklenen = -1;
    pagesGrid.querySelectorAll('.is-dragging, .is-drop-target').forEach(k => k.classList.remove('is-dragging', 'is-drop-target'));
  });
  pagesGrid.addEventListener('drop', e => {
    const kart = e.target.closest('.pdf-page-card');
    if (!kart || suruklenen < 0) return;
    e.preventDefault();
    const hedef = parseInt(kart.dataset.index, 10);
    if (hedef !== suruklenen) {
      const [tasinan] = currentPageStates.splice(suruklenen, 1);
      currentPageStates.splice(hedef, 0, tasinan);
    }
    suruklenen = -1;
    renderPageGrid();
  });

  function handlePageAction(action, index) {
    const sayfa = currentPageStates[index];
    if (action === 'rotate-left') {
      sayfa.rotationDelta = (sayfa.rotationDelta - 90 + 360) % 360;
    } else if (action === 'rotate-right') {
      sayfa.rotationDelta = (sayfa.rotationDelta + 90) % 360;
    } else if (action === 'toggle-delete') {
      sayfa.isDeleted = !sayfa.isDeleted;
    } else if (action === 'add-blank') {
      // Boş sayfa komşusunun boyutunu alır (A4 varsaymak karışık belgede göze batar).
      const yanBoy = (sayfa.baseRotation + sayfa.rotationDelta) % 180 !== 0;
      currentPageStates.splice(index + 1, 0, {
        blank: true, rotationDelta: 0, baseRotation: 0, isDeleted: false,
        width: yanBoy ? sayfa.height : sayfa.width, height: yanBoy ? sayfa.width : sayfa.height
      });
    }
    renderPageGrid();
  }

  btnRotateAllRight.addEventListener('click', () => {
    currentPageStates.forEach(p => {
      p.rotationDelta = (p.rotationDelta + 90) % 360;
    });
    renderPageGrid();
  });

  btnResetPages.addEventListener('click', () => {
    sayfaDurumlariniKur();     // sıra, boş sayfalar, döndürme ve silme sıfırlanır
    renderPageGrid();
  });

  // Sayfa Aralığı Çıkar
  btnExtractRange.addEventListener('click', async () => {
    const rangeVal = pageRangeInput.value.trim();
    if (!rangeVal) {
      alert('Lütfen çıkarılacak sayfa aralığını yazın (örn. 1-3, 5).');
      return;
    }

    try {
      const pageIndices = PdfEngine.parsePageRanges(rangeVal, orijinalSayfalar.length);
      if (pageIndices.length === 0) {
        alert('Geçerli bir sayfa aralığı bulunamadı.');
        return;
      }

      const extractedBytes = await PdfEngine.extractPages(currentFileBytes, pageIndices);
      const cleanBaseName = currentFileName.replace(/\.pdf$/i, '');
      downloadBlob(extractedBytes, `${cleanBaseName}_sayfalar_${rangeVal.replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`);
    } catch (err) {
      alert(`Sayfalar çıkarılırken hata oluştu: ${err.message}`);
    }
  });

  // Her Sayfayı Ayrı İndir
  btnSplitSinglePages.addEventListener('click', async () => {
    const pageTotal = orijinalSayfalar.length;
    if (!confirm(`Tüm sayfalar (${pageTotal}) tekil PDF olarak ayrılıp tek bir ZIP dosyası halinde indirilecektir. Onaylıyor musunuz?`)) return;

    const originalLabel = btnSplitSinglePages.textContent;
    btnSplitSinglePages.disabled = true;
    try {
      const cleanBaseName = currentFileName.replace(/\.pdf$/i, '');
      const singlePages = await PdfEngine.splitIntoSinglePages(currentFileBytes, cleanBaseName);
      downloadBlob(buildZipBytes(singlePages), `${cleanBaseName}_sayfalar.zip`, 'application/zip');
    } catch (err) {
      alert(`Sayfalar ayrılırken hata oluştu: ${err.message}`);
    } finally {
      btnSplitSinglePages.disabled = false;
      btnSplitSinglePages.textContent = originalLabel;
    }
  });

  // Düzenlenmiş PDF'i İndir
  btnExportOrganizedPdf.addEventListener('click', async () => {
    const activePages = currentPageStates.filter(p => !p.isDeleted);
    if (activePages.length === 0) {
      alert('En az bir sayfa seçili kalmalıdır. Tüm sayfaları sildiniz.');
      return;
    }

    try {
      const processedBytes = await PdfEngine.processPages(currentFileBytes, currentPageStates);
      const cleanBaseName = currentFileName.replace(/\.pdf$/i, '');
      downloadBlob(processedBytes, `${cleanBaseName}_duzenlenmis.pdf`);
    } catch (err) {
      alert(`PDF kaydedilirken hata oluştu: ${err.message}`);
    }
  });

  // =========================================================================
  // 2. PDF BİRLEŞTİRME MODU
  // =========================================================================
  mergeDropzone.addEventListener('click', () => mergeFileInput.click());
  mergeFileInput.addEventListener('change', handleMergeFileSelect);
  btnAddMoreMergeFiles.addEventListener('click', () => mergeFileInput.click());

  setupDragAndDrop(mergeDropzone, (files) => {
    const pdfs = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (pdfs.length > 0) addMergeFiles(pdfs);
  });

  function handleMergeFileSelect(e) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length > 0) addMergeFiles(files);
  }

  async function addMergeFiles(files) {
    const rejected = [];
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const info = await PdfEngine.getPdfInfo(bytes);
        mergeFiles.push({
          name: f.name,
          bytes,
          pageCount: info.pageCount
        });
      } catch (err) {
        // Eskiden yalnız konsola yazılıyordu; şifreli dosya sessizce listeden düşerdi.
        console.warn(`Dosya okunamadı (${f.name}):`, err);
        rejected.push(`• ${f.name}: ${err.message}`);
      }
    }
    if (rejected.length > 0) {
      alert(`Aşağıdaki dosyalar birleştirme listesine eklenmedi:\n\n${rejected.join('\n')}`);
    }

    renderMergeList();
    if (mergeFiles.length > 0) {
      mergeDropzone.hidden = true;
      mergeWorkspace.hidden = false;
    }
  }

  function renderMergeList() {
    mergeFileList.innerHTML = '';
    mergeFileCount.textContent = `${mergeFiles.length} dosya eklendi`;

    mergeFiles.forEach((file, idx) => {
      const item = document.createElement('div');
      item.className = 'pdf-file-item';
      // Statik iskelet innerHTML ile, dosya adı ise textContent ile yazılır:
      // "<form action=https://...>" gibi bir ad HTML olarak yorumlanmamalı.
      item.innerHTML = `
        <div class="pdf-file-left">
          <span style="font-weight:700; color:var(--ink-muted); width:24px;">${idx + 1}.</span>
          <div>
            <strong data-role="file-name"></strong>
            <span class="pdf-file-badge" style="margin-left:8px;">${file.pageCount} sayfa</span>
          </div>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="icon-btn" data-action="move-up" data-index="${idx}" ${idx === 0 ? 'disabled' : ''} title="Yukarı Taşı">▲</button>
          <button class="icon-btn" data-action="move-down" data-index="${idx}" ${idx === mergeFiles.length - 1 ? 'disabled' : ''} title="Aşağı Taşı">▼</button>
          <button class="icon-btn" data-action="delete" data-index="${idx}" title="Kaldır" style="color:var(--danger)">✕</button>
        </div>
      `;
      item.querySelector('[data-role="file-name"]').textContent = file.name;
      mergeFileList.appendChild(item);
    });

    mergeFileList.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        if (action === 'move-up' && idx > 0) {
          const temp = mergeFiles[idx];
          mergeFiles[idx] = mergeFiles[idx - 1];
          mergeFiles[idx - 1] = temp;
        } else if (action === 'move-down' && idx < mergeFiles.length - 1) {
          const temp = mergeFiles[idx];
          mergeFiles[idx] = mergeFiles[idx + 1];
          mergeFiles[idx + 1] = temp;
        } else if (action === 'delete') {
          mergeFiles.splice(idx, 1);
        }
        renderMergeList();
        if (mergeFiles.length === 0) {
          mergeDropzone.hidden = false;
          mergeWorkspace.hidden = true;
        }
      });
    });
  }

  btnClearMergeList.addEventListener('click', () => {
    mergeFiles = [];
    renderMergeList();
    mergeDropzone.hidden = false;
    mergeWorkspace.hidden = true;
  });

  btnExecuteMerge.addEventListener('click', async () => {
    if (mergeFiles.length < 2) {
      alert('Birleştirmek için en az 2 PDF dosyası eklemelisiniz.');
      return;
    }

    try {
      const buffers = mergeFiles.map(f => f.bytes);
      const mergedBytes = await PdfEngine.mergePdfs(buffers);
      downloadBlob(mergedBytes, 'birlestirilmis_belge.pdf');
    } catch (err) {
      alert(`Birleştirme sırasında hata oluştu: ${err.message}`);
    }
  });

  // =========================================================================
  // 3. RESİMDEN PDF
  // =========================================================================
  const imgDropzone = document.getElementById('imgDropzone');
  const imgFileInput = document.getElementById('imgFileInput');
  const imgWorkspace = document.getElementById('imgWorkspace');
  const imgList = document.getElementById('imgList');
  const imgCount = document.getElementById('imgCount');
  let gorseller = []; // [{ ad, dosya, url }]

  imgDropzone.addEventListener('click', () => imgFileInput.click());
  document.getElementById('btnImgAdd').addEventListener('click', () => imgFileInput.click());
  imgFileInput.addEventListener('change', e => { gorselEkle(Array.from(e.target.files || [])); imgFileInput.value = ''; });
  setupDragAndDrop(imgDropzone, files => gorselEkle(Array.from(files)));
  document.getElementById('btnImgClear').addEventListener('click', () => {
    gorseller.forEach(g => URL.revokeObjectURL(g.url));
    gorseller = [];
    gorselListesiCiz();
  });

  function gorselEkle(dosyalar) {
    const uygun = dosyalar.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name));
    if (dosyalar.length && !uygun.length) { alert('Seçilen dosyalar görsel değil.'); return; }
    uygun.forEach(f => gorseller.push({ ad: f.name, dosya: f, url: URL.createObjectURL(f) }));
    gorselListesiCiz();
  }

  function gorselListesiCiz() {
    imgList.textContent = '';
    imgCount.textContent = `${gorseller.length} görsel`;
    gorseller.forEach((g, i) => {
      const oge = document.createElement('div');
      oge.className = 'pdf-gorsel-oge';
      const img = document.createElement('img');
      img.src = g.url; img.alt = '';
      const ad = document.createElement('span');
      ad.className = 'ad'; ad.textContent = `${i + 1}. ${g.ad}`; ad.title = g.ad;
      const eylem = document.createElement('div');
      eylem.className = 'eylemler';
      [['◀', 'Öne al', -1], ['▶', 'Arkaya al', 1]].forEach(([yazi, baslik, yon]) => {
        const b = document.createElement('button');
        b.className = 'icon-btn'; b.type = 'button'; b.textContent = yazi; b.title = baslik;
        b.disabled = (yon < 0 && i === 0) || (yon > 0 && i === gorseller.length - 1);
        b.addEventListener('click', () => { const t = gorseller[i]; gorseller[i] = gorseller[i + yon]; gorseller[i + yon] = t; gorselListesiCiz(); });
        eylem.appendChild(b);
      });
      const sil = document.createElement('button');
      sil.className = 'icon-btn'; sil.type = 'button'; sil.textContent = '✕'; sil.title = 'Kaldır';
      sil.style.color = 'var(--danger)';
      sil.addEventListener('click', () => { URL.revokeObjectURL(g.url); gorseller.splice(i, 1); gorselListesiCiz(); });
      eylem.appendChild(sil);
      oge.append(img, ad, eylem);
      imgList.appendChild(oge);
    });
    imgDropzone.hidden = gorseller.length > 0;
    imgWorkspace.hidden = gorseller.length === 0;
  }

  /* JPEG'in EXIF yönü (telefon fotoğrafları). pdf-lib JPEG'i olduğu gibi
     gömer; yön 1 değilse fotoğraf PDF'te yan durur. O durumda görsel tarayıcıda
     doğru yöne çevrilip yeniden kodlanır. */
  function exifYonu(b) {
    if (b[0] !== 0xFF || b[1] !== 0xD8) return 1;
    let i = 2;
    while (i + 4 < b.length) {
      if (b[i] !== 0xFF) return 1;
      const isaret = b[i + 1], uzunluk = (b[i + 2] << 8) | b[i + 3];
      if (isaret === 0xE1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
        const t = i + 10, kucuk = b[t] === 0x49;
        const u16 = o => kucuk ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1];
        const u32 = o => kucuk ? (b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16) | (b[t + o + 3] << 24)) >>> 0
          : ((b[t + o] << 24) | (b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]) >>> 0;
        const ifd = u32(4), adet = u16(ifd);
        for (let k = 0; k < adet; k++) {
          const g = ifd + 2 + k * 12;
          if (u16(g) === 0x0112) return u16(g + 8) || 1;
        }
        return 1;
      }
      if (isaret === 0xDA) return 1;
      i += 2 + uzunluk;
    }
    return 1;
  }

  async function tuvaldenPng(kaynak, tur = 'image/png', kalite) {
    const bmp = await createImageBitmap(kaynak, { imageOrientation: 'from-image' });
    const tuval = document.createElement('canvas');
    tuval.width = bmp.width; tuval.height = bmp.height;
    tuval.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    const blob = await new Promise(r => tuval.toBlob(r, tur, kalite));
    return new Uint8Array(await blob.arrayBuffer());
  }

  // pdf-lib yalnız PNG ve JPEG gömer; diğerleri tuvalde PNG'ye çevrilir.
  async function gomulebilirGorsel(dosya) {
    const bytes = new Uint8Array(await dosya.arrayBuffer());
    const jpeg = bytes[0] === 0xFF && bytes[1] === 0xD8;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
    if (jpeg && exifYonu(bytes) === 1) return { bytes, mime: 'image/jpeg' };
    if (jpeg) return { bytes: await tuvaldenPng(dosya, 'image/jpeg', 0.92), mime: 'image/jpeg' };
    if (png) return { bytes, mime: 'image/png' };
    return { bytes: await tuvaldenPng(dosya), mime: 'image/png' };
  }

  document.getElementById('btnImgExport').addEventListener('click', async () => {
    if (!gorseller.length) return;
    const btn = document.getElementById('btnImgExport');
    const eski = btn.textContent;
    btn.disabled = true; btn.textContent = 'Hazırlanıyor…';
    try {
      const resimler = [];
      for (const g of gorseller) resimler.push(await gomulebilirGorsel(g.dosya));
      const bytes = await PdfEngine.imagesToPdf(resimler, {
        sayfaBoyutu: document.getElementById('imgPageSize').value,
        yon: document.getElementById('imgOrientation').value,
        kenar: Number(document.getElementById('imgMargin').value)
      });
      downloadBlob(bytes, 'gorseller.pdf');
    } catch (err) {
      alert(`PDF oluşturulamadı: ${err.message}`);
    } finally {
      btn.disabled = false; btn.textContent = eski;
    }
  });

  // =========================================================================
  // 4. TEK PDF'LE ÇALIŞAN ARAÇLAR (numara, filigran, kırp, form)
  // =========================================================================
  const tekDosya = {};   // araç → { ad, bytes, bilgi }

  function tekDosyaKur(arac, yuklendi) {
    const alan = document.querySelector(`[data-tekdosya="${arac}"]`);
    const girdi = alan.querySelector('input[type="file"]');
    const calisma = document.querySelector(`[data-calisma="${arac}"]`);
    async function yukle(file) {
      if (!file || !/\.pdf$/i.test(file.name)) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const bilgi = await PdfEngine.getPdfInfo(bytes);
        tekDosya[arac] = { ad: file.name, bytes, bilgi };
        calisma.querySelector('[data-dosya-adi]').textContent = file.name;
        calisma.querySelector('[data-sayfa-sayisi]').textContent = `${bilgi.pageCount} sayfa`;
        // Önce görünür olsun: önizlemeler genişliği çalışma alanından ölçer
        const oncekiAlan = alan.hidden, oncekiCalisma = calisma.hidden;
        alan.hidden = true;
        calisma.hidden = false;
        try {
          if (yuklendi) await yuklendi(tekDosya[arac]);
        } catch (err) {
          alan.hidden = oncekiAlan; calisma.hidden = oncekiCalisma;
          throw err;
        }
      } catch (err) {
        alert(`PDF yüklenirken hata oluştu: ${err.message}`);
      }
    }
    alan.addEventListener('click', () => girdi.click());
    alan.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); girdi.click(); } });
    girdi.addEventListener('change', e => { yukle(e.target.files && e.target.files[0]); girdi.value = ''; });
    setupDragAndDrop(alan, files => yukle(files[0]));
    calisma.querySelector('[data-dosya-degistir]').addEventListener('click', () => girdi.click());
  }

  const tabanAd = ad => ad.replace(/\.pdf$/i, '');
  const mmNokta = mm => Number(mm) * 72 / 25.4;

  function secilenSayfalar(metin, toplam) {
    const t = String(metin || '').trim();
    if (!t) return null;
    const dizin = PdfEngine.parsePageRanges(t, toplam);
    if (!dizin.length) throw new Error('Geçerli bir sayfa aralığı bulunamadı.');
    return dizin;
  }

  async function calistir(btn, is) {
    const eski = btn.textContent;
    btn.disabled = true; btn.textContent = 'Hazırlanıyor…';
    try { await is(); }
    catch (err) { alert(err.message); }
    finally { btn.disabled = false; btn.textContent = eski; }
  }

  // --- Sayfa numarası
  tekDosyaKur('numbers');
  const numFormat = document.getElementById('numFormat');
  numFormat.addEventListener('change', () => {
    const ozel = numFormat.value === 'ozel';
    document.getElementById('numCustomWrap').hidden = !ozel;
    document.getElementById('numCustomHint').hidden = !ozel;
    if (ozel) document.getElementById('numCustom').focus();
  });
  document.getElementById('btnNumExport').addEventListener('click', e => calistir(e.currentTarget, async () => {
    const d = tekDosya.numbers;
    let bicim = numFormat.value;
    if (bicim === 'ozel') {
      bicim = document.getElementById('numCustom').value.trim();
      if (!bicim) throw new Error('Özel biçimi yazın. Örn: Sayfa {n} / {toplam}');
      if (!bicim.includes('{n}')) throw new Error('Özel biçimde sayfa numarasının yeri için {n} olmalı.');
    }
    const bytes = await PdfEngine.addPageNumbers(d.bytes, {
      konum: document.getElementById('numPosition').value,
      bicim,
      baslangic: parseInt(document.getElementById('numStart').value, 10) || 1,
      yaziBoyutu: Number(document.getElementById('numSize').value),
      kenar: mmNokta(document.getElementById('numMargin').value || 10),
      ilkSayfayiAtla: document.getElementById('numSkipFirst').checked
    });
    downloadBlob(bytes, `${tabanAd(d.ad)}_numarali.pdf`);
  }));

  // --- Filigran
  tekDosyaKur('watermark');
  const wmType = document.getElementById('wmType');
  const wmOpacity = document.getElementById('wmOpacity');
  wmType.addEventListener('change', () => {
    document.querySelectorAll('[data-wm]').forEach(el => { el.hidden = el.dataset.wm !== wmType.value; });
  });
  wmOpacity.addEventListener('input', () => { document.getElementById('wmOpacityText').textContent = `%${wmOpacity.value}`; });

  /* Metin filigranı tuvale çizilip PNG olarak gömülür: kalın sistem yazı
     tipiyle görünür, her dildeki harfi yazar ve belgenin metnine karışmaz
     (kopyalanan ya da aranan metinde "GİZLİ" kelimesi çıkmaz). */
  async function metinGorseli(metin, renk) {
    const boyut = 160;
    const font = `700 ${boyut}px system-ui, "Segoe UI", Roboto, sans-serif`;
    const olc = document.createElement('canvas').getContext('2d');
    olc.font = font;
    const genislik = Math.ceil(olc.measureText(metin).width) + boyut * 0.4;
    const tuval = document.createElement('canvas');
    tuval.width = Math.max(1, genislik); tuval.height = Math.ceil(boyut * 1.35);
    const c = tuval.getContext('2d');
    c.font = font; c.fillStyle = renk; c.textBaseline = 'middle'; c.textAlign = 'center';
    c.fillText(metin, tuval.width / 2, tuval.height / 2);
    const blob = await new Promise(r => tuval.toBlob(r, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  document.getElementById('btnWmExport').addEventListener('click', e => calistir(e.currentTarget, async () => {
    const d = tekDosya.watermark;
    let resim, mime = 'image/png';
    if (wmType.value === 'metin') {
      const metin = document.getElementById('wmText').value.trim();
      if (!metin) throw new Error('Filigran metnini yazın.');
      resim = await metinGorseli(metin, document.getElementById('wmColor').value);
    } else {
      const dosya = document.getElementById('wmImage').files[0];
      if (!dosya) throw new Error('Filigran için bir görsel seçin.');
      ({ bytes: resim, mime } = await gomulebilirGorsel(dosya));
    }
    const bytes = await PdfEngine.addImageWatermark(d.bytes, {
      resim, mime,
      opaklik: Number(wmOpacity.value) / 100,
      aci: Number(document.getElementById('wmAngle').value),
      olcek: Number(document.getElementById('wmScale').value),
      dose: document.getElementById('wmLayout').value === 'dose',
      sayfalar: secilenSayfalar(document.getElementById('wmPages').value, d.bilgi.pageCount)
    });
    downloadBlob(bytes, `${tabanAd(d.ad)}_filigranli.pdf`);
  }));

  // --- Kırp
  tekDosyaKur('crop', d => {
    const s = d.bilgi.pages[0];
    const mm = n => Math.round(n * 25.4 / 72);
    const yan = s.rotation % 180 !== 0;
    document.getElementById('cropInfo').textContent =
      `İlk sayfa ${mm(yan ? s.height : s.width)} × ${mm(yan ? s.width : s.height)} mm. Kenar payları sayfayı gördüğünüz yöne göredir.`;
    kirpOnizleme(d);
  });
  document.getElementById('btnCropExport').addEventListener('click', e => calistir(e.currentTarget, async () => {
    const d = tekDosya.crop;
    const deger = id => Number(document.getElementById(id).value) || 0;
    const bytes = await PdfEngine.cropPages(d.bytes, {
      ust: deger('cropTop'), alt: deger('cropBottom'), sol: deger('cropLeft'), sag: deger('cropRight'),
      sayfalar: secilenSayfalar(document.getElementById('cropPages').value, d.bilgi.pageCount)
    });
    downloadBlob(bytes, `${tabanAd(d.ad)}_kirpilmis.pdf`);
  }));

  // --- Form doldur
  const formFields = document.getElementById('formFields');
  let formAlanlari = [];
  tekDosyaKur('form', async d => {
    formAlanlari = await PdfEngine.getFormFields(d.bytes);
    formFields.textContent = '';
    if (!formAlanlari.length) {
      const p = document.createElement('p');
      p.className = 'pdf-form-bos';
      p.textContent = 'Bu PDF\'te doldurulabilir form alanı yok. Taranmış ya da düz metin formlar için "Filigran" ve "Düzenle" araçlarını kullanabilirsiniz.';
      formFields.appendChild(p);
      return;
    }
    formAlanlari.forEach((a, i) => {
      const kutu = document.createElement('label');
      kutu.className = 'pdf-form-alani';
      const ad = document.createElement('span');
      ad.textContent = a.ad + (a.salt ? ' (salt okunur)' : '');
      let girdi;
      if (a.tur === 'onay') {
        girdi = document.createElement('input'); girdi.type = 'checkbox'; girdi.checked = !!a.deger;
      } else if (a.tur === 'metin') {
        girdi = document.createElement('input'); girdi.type = 'text'; girdi.className = 'input-text'; girdi.value = a.deger;
      } else {
        girdi = document.createElement('select'); girdi.className = 'input-text';
        if (a.tur === 'liste') girdi.multiple = true;
        if (a.tur !== 'liste') { const bos = document.createElement('option'); bos.value = ''; bos.textContent = '(seçilmedi)'; girdi.appendChild(bos); }
        const secili = Array.isArray(a.deger) ? a.deger : [a.deger];
        a.secenekler.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; o.selected = secili.includes(s); girdi.appendChild(o); });
      }
      girdi.disabled = a.salt;
      girdi.dataset.alan = String(i);
      kutu.append(ad, girdi);
      formFields.appendChild(kutu);
    });
  });
  document.getElementById('btnFormExport').addEventListener('click', e => calistir(e.currentTarget, async () => {
    const d = tekDosya.form;
    if (!formAlanlari.length) throw new Error('Bu PDF\'te doldurulacak alan yok.');
    const degerler = {};
    formFields.querySelectorAll('[data-alan]').forEach(g => {
      const a = formAlanlari[Number(g.dataset.alan)];
      if (a.salt) return;
      if (a.tur === 'onay') degerler[a.ad] = g.checked;
      else if (a.tur === 'liste') degerler[a.ad] = Array.from(g.selectedOptions).map(o => o.value);
      else if (a.tur === 'acilir') degerler[a.ad] = g.value ? g.value : '';
      else degerler[a.ad] = g.value;
    });
    const sonuc = await PdfEngine.fillForm(d.bytes, degerler, { duzlestir: document.getElementById('formFlatten').checked });
    downloadBlob(sonuc.bytes, `${tabanAd(d.ad)}_doldurulmus.pdf`);
    if (sonuc.uyarilar.length) alert(sonuc.uyarilar.join('\n'));
  }));

  // =========================================================================
  // 5. pdf.js GEREKTİREN ARAÇLAR
  // =========================================================================
  function tuvalBlob(tuval, tur, kalite) {
    return new Promise((coz, red) => tuval.toBlob(b => b ? coz(b) : red(new Error('Görsel üretilemedi.')), tur, kalite));
  }
  async function tuvalBaytlari(tuval, tur, kalite) {
    return new Uint8Array(await (await tuvalBlob(tuval, tur, kalite)).arrayBuffer());
  }

  // --- Kırp önizlemesi: ilk sayfa, kalan alan çerçeveli
  const cropPreview = document.getElementById('cropPreview');
  const cropCanvas = document.getElementById('cropCanvas');
  const cropMask = document.getElementById('cropMask');
  let kirpBoyutMm = null;   // ilk sayfanın görünen boyutu (mm)
  async function kirpOnizleme(d) {
    cropPreview.hidden = true;
    if (typeof PdfRender === 'undefined' || !PdfRender.destekleniyor()) return;   // önizleme isteğe bağlı
    try {
      const belge = await PdfRender.ac(d.bytes);
      const tuval = await PdfRender.sayfaCiz(belge, 1, { genislik: 320 });
      PdfRender.kapat(belge);
      cropCanvas.width = tuval.width; cropCanvas.height = tuval.height;
      cropCanvas.getContext('2d').drawImage(tuval, 0, 0);
      const boyut = (await PdfEngine.getVisibleSizes(d.bytes))[0];
      kirpBoyutMm = { w: boyut.genislik * 25.4 / 72, h: boyut.yukseklik * 25.4 / 72 };
      cropPreview.hidden = false;
      kirpMaskesi();
    } catch (err) { console.warn('Kırp önizlemesi çizilemedi:', err); }
  }
  function kirpMaskesi() {
    if (!kirpBoyutMm) return;
    const v = id => Math.max(0, Number(document.getElementById(id).value) || 0);
    const ust = v('cropTop') / kirpBoyutMm.h, alt = v('cropBottom') / kirpBoyutMm.h;
    const sol = v('cropLeft') / kirpBoyutMm.w, sag = v('cropRight') / kirpBoyutMm.w;
    Object.assign(cropMask.style, {
      left: (sol * 100) + '%', top: (ust * 100) + '%',
      width: Math.max(0, (1 - sol - sag) * 100) + '%', height: Math.max(0, (1 - ust - alt) * 100) + '%'
    });
  }
  ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'].forEach(id => document.getElementById(id).addEventListener('input', kirpMaskesi));

  // --- PDF'den resim
  tekDosyaKur('toimage');
  document.getElementById('btnImgOutExport').addEventListener('click', e => calistir(e.currentTarget, async () => {
    const d = tekDosya.toimage;
    const tur = document.getElementById('imgOutFormat').value;
    const uzanti = tur === 'image/png' ? 'png' : 'jpg';
    const dpi = Number(document.getElementById('imgOutDpi').value);
    const secili = secilenSayfalar(document.getElementById('imgOutPages').value, d.bilgi.pageCount) || d.bilgi.pages.map(p => p.index);
    const durum = document.getElementById('imgOutStatus');
    const belge = await PdfRender.ac(d.bytes);
    const dosyalar = [];
    try {
      for (let k = 0; k < secili.length; k++) {
        durum.textContent = `Sayfa ${k + 1} / ${secili.length} çiziliyor…`;
        const tuval = await PdfRender.sayfaCiz(belge, secili[k] + 1, { dpi });
        const ad = `${tabanAd(d.ad)}_sayfa_${String(secili[k] + 1).padStart(3, '0')}.${uzanti}`;
        dosyalar.push({ fileName: ad, bytes: await tuvalBaytlari(tuval, tur, 0.9) });
        tuval.width = tuval.height = 0;   // büyük tuvalin belleğini hemen bırak
      }
    } finally {
      PdfRender.kapat(belge);
    }
    if (dosyalar.length === 1) downloadBlob(dosyalar[0].bytes, dosyalar[0].fileName, tur);
    else downloadBlob(buildZipBytes(dosyalar), `${tabanAd(d.ad)}_gorseller.zip`, 'application/zip');
    durum.textContent = `${dosyalar.length} görsel hazırlandı.`;
  }));

  // --- Kalıcı karartma
  const redactCanvas = document.getElementById('redactCanvas');
  const redactLayer = document.getElementById('redactLayer');
  const redactStage = document.getElementById('redactStage');
  const redactSummary = document.getElementById('redactSummary');
  const kar = { belge: null, sayfa: 1, kutular: new Map(), konumlar: new Map() };   // kutular: sayfa no → [{x,y,w,h}] (0–1)

  tekDosyaKur('redact', async d => {
    if (kar.belge) PdfRender.kapat(kar.belge);
    kar.belge = null;
    kar.sayfa = 1; kar.kutular = new Map(); kar.konumlar = new Map();
    // Çalışma alanı PDF açılmadan görünür; düğmeler karartHazir ile bunu bekler.
    kar.yukleniyor = PdfRender.ac(d.bytes);
    try { kar.belge = await kar.yukleniyor; } finally { kar.yukleniyor = null; }
    await karartSayfaCiz();
  });

  async function karartHazir() {
    if (kar.yukleniyor) await kar.yukleniyor.catch(() => {});
    if (!kar.belge) throw new Error(tekDosya.redact ? 'PDF açılamadı; dosyayı yeniden seçin.' : 'Önce bir PDF seçin.');
  }

  async function karartSayfaCiz() {
    const alan = redactStage.parentElement.clientWidth;
    const genislik = Math.min(900, alan > 100 ? alan - 2 : 800);
    const tuval = await PdfRender.sayfaCiz(kar.belge, kar.sayfa, { genislik });
    redactCanvas.width = tuval.width; redactCanvas.height = tuval.height;
    redactCanvas.getContext('2d').drawImage(tuval, 0, 0);
    document.getElementById('redactPageLabel').textContent = `Sayfa ${kar.sayfa} / ${kar.belge.numPages}`;
    document.getElementById('btnRedactPrev').disabled = kar.sayfa <= 1;
    document.getElementById('btnRedactNext').disabled = kar.sayfa >= kar.belge.numPages;
    karartKutulariCiz();
  }

  function karartKutulariCiz() {
    redactLayer.textContent = '';
    (kar.kutular.get(kar.sayfa) || []).forEach((k, i) => {
      const el = document.createElement('div');
      el.className = 'pdf-karart-kutu';
      Object.assign(el.style, { left: k.x * 100 + '%', top: k.y * 100 + '%', width: k.w * 100 + '%', height: k.h * 100 + '%' });
      el.title = 'Tıklayınca silinir';
      el.addEventListener('pointerdown', ev => ev.stopPropagation());
      el.addEventListener('click', () => { kar.kutular.get(kar.sayfa).splice(i, 1); karartKutulariCiz(); karartOzeti(); });
      redactLayer.appendChild(el);
    });
  }

  function karartOzeti() {
    let toplam = 0, sayfa = 0;
    kar.kutular.forEach(l => { if (l.length) { toplam += l.length; sayfa++; } });
    redactSummary.textContent = toplam ? `${toplam} kutu, ${sayfa} sayfada` : '';
  }

  function kutuEkle(no, kutular) {
    if (!kutular.length) return;
    const l = kar.kutular.get(no) || [];
    l.push(...kutular);
    kar.kutular.set(no, l);
  }

  // Fareyle kutu çizme (görünen sayfaya göre 0–1 oranı)
  let cizim = null;
  redactStage.addEventListener('pointerdown', ev => {
    if (!kar.belge || ev.button !== 0) return;
    const r = redactLayer.getBoundingClientRect();
    cizim = { x0: (ev.clientX - r.left) / r.width, y0: (ev.clientY - r.top) / r.height, el: document.createElement('div') };
    cizim.el.className = 'pdf-karart-kutu cizilen';
    redactLayer.appendChild(cizim.el);
    redactStage.setPointerCapture(ev.pointerId);
  });
  redactStage.addEventListener('pointermove', ev => {
    if (!cizim) return;
    const r = redactLayer.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
    cizim.k = { x: Math.min(x, cizim.x0), y: Math.min(y, cizim.y0), w: Math.abs(x - cizim.x0), h: Math.abs(y - cizim.y0) };
    Object.assign(cizim.el.style, { left: cizim.k.x * 100 + '%', top: cizim.k.y * 100 + '%', width: cizim.k.w * 100 + '%', height: cizim.k.h * 100 + '%' });
  });
  redactStage.addEventListener('pointerup', () => {
    if (!cizim) return;
    const k = cizim.k;
    cizim = null;
    if (k && k.w > 0.005 && k.h > 0.003) kutuEkle(kar.sayfa, [k]);
    karartKutulariCiz(); karartOzeti();
  });

  document.getElementById('btnRedactPrev').addEventListener('click', () => { if (kar.sayfa > 1) { kar.sayfa--; karartSayfaCiz(); } });
  document.getElementById('btnRedactNext').addEventListener('click', () => { if (kar.belge && kar.sayfa < kar.belge.numPages) { kar.sayfa++; karartSayfaCiz(); } });
  document.getElementById('btnRedactClearPage').addEventListener('click', () => { kar.kutular.delete(kar.sayfa); karartKutulariCiz(); karartOzeti(); });

  async function sayfaKonumlari(no) {
    if (!kar.konumlar.has(no)) kar.konumlar.set(no, await PdfRender.metinKonumlari(kar.belge, no));
    return kar.konumlar.get(no);
  }

  // Ana istasyondaki denetim tablosuyla aynı adlar (kısaltmalar büyük harf)
  const TUR_ADLARI = { tckn: 'TC Kimlik No', ykn: 'Yabancı Kimlik No', vkn: 'Vergi Kimlik No', iban: 'IBAN',
    ssn: 'SSN', imei: 'IMEI', ip: 'IP adresi', mac: 'MAC adresi', uuid: 'UUID', jwt: 'JWT', kep: 'KEP adresi' };
  function turAdi(tur) {
    if (TUR_ADLARI[tur]) return TUR_ADLARI[tur];
    const ad = (MaskEngine.TYPE_LABELS && MaskEngine.TYPE_LABELS[tur]) || tur;
    return ad.charAt(0).toLocaleUpperCase('tr-TR') + ad.slice(1);
  }

  /* Hassas veri: maskeleme ekranıyla aynı aday hattı (TCKN/IBAN/kart sağlama
     doğrulamalı). Taranmış (metinsiz) sayfada bulunacak metin yoktur; o
     sayfalar elle işaretlenir ya da önce OCR'dan geçirilir. */
  document.getElementById('btnRedactAuto').addEventListener('click', e => calistir(e.currentTarget, async () => {
    if (typeof MaskEngine === 'undefined' || !MaskEngine.detectCandidates) throw new Error('Hassas veri tarayıcısı yüklenemedi.');
    await karartHazir();
    let bulunan = 0, metinsiz = 0;
    const turler = {};
    for (let no = 1; no <= kar.belge.numPages; no++) {
      const k = await sayfaKonumlari(no);
      if (!k.metin.trim()) { metinsiz++; continue; }
      const adaylar = MaskEngine.detectCandidates(k.metin);
      for (const a of adaylar) {
        kutuEkle(no, PdfRender.araligiKutula(k, a.span[0], a.span[1]));
        bulunan++;
        const ad = turAdi(a.type);
        turler[ad] = (turler[ad] || 0) + 1;
      }
    }
    karartKutulariCiz(); karartOzeti();
    const dokum = Object.entries(turler).map(([t, n]) => `${t} (${n})`).join(', ');
    redactSummary.textContent = bulunan
      ? `${bulunan} hassas değer bulundu: ${dokum}. ` + redactSummary.textContent
      : 'Otomatik bulunan hassas değer yok.';
    if (metinsiz) redactSummary.textContent += ` ${metinsiz} sayfada metin yok (taranmış olabilir): elle işaretleyin ya da önce OCR'dan geçirin.`;
  }));

  /* Arama Türkçe büyük/küçük harfe (I/ı, İ/i) ve şapka/çengel farkına
     duyarsızdır: "ayse yilmaz" "AYŞE YILMAZ"ı da bulur. Karartmada fazlası
     görünür ve silinebilir, eksiği sızıntıdır. Her karakter tek karaktere
     katlanır; uzunluk değişmez, bulunan konum asıl metindeki konumdur. */
  const KATLA = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
  function aramaKatla(metin) {
    let s = '';
    for (let i = 0; i < metin.length; i++) {
      let c = metin[i].toLocaleLowerCase('tr-TR');
      if (c.length !== 1) c = metin[i];
      s += KATLA[c] || c;
    }
    return s;
  }

  document.getElementById('btnRedactSearch').addEventListener('click', e => calistir(e.currentTarget, async () => {
    const terimler = document.getElementById('redactTerms').value.split(',').map(t => t.trim()).filter(Boolean);
    if (!terimler.length) throw new Error('Karartılacak kelimeyi yazın.');
    await karartHazir();
    let bulunan = 0;
    for (let no = 1; no <= kar.belge.numPages; no++) {
      const k = await sayfaKonumlari(no);
      const kucuk = aramaKatla(k.metin);
      for (const t of terimler) {
        const aranan = aramaKatla(t);
        for (let i = kucuk.indexOf(aranan); i !== -1; i = kucuk.indexOf(aranan, i + aranan.length)) {
          kutuEkle(no, PdfRender.araligiKutula(k, i, i + aranan.length));
          bulunan++;
        }
      }
    }
    karartKutulariCiz(); karartOzeti();
    if (!bulunan) redactSummary.textContent = 'Aranan kelime bulunamadı.';
  }));

  document.getElementById('btnRedactExport').addEventListener('click', e => calistir(e.currentTarget, async () => {
    await karartHazir();
    const d = tekDosya.redact;
    const hepsi = document.getElementById('redactAllPages').checked;
    const dpi = Number(document.getElementById('redactDpi').value);
    const islenecek = [];
    for (let no = 1; no <= kar.belge.numPages; no++) {
      if (hepsi || (kar.kutular.get(no) || []).length) islenecek.push(no);
    }
    if (!islenecek.length) throw new Error('Karartılacak kutu yok. Fareyle kutu çizin ya da "Hassas verileri bul"u kullanın.');
    const resimler = [];
    for (let k = 0; k < islenecek.length; k++) {
      const no = islenecek[k];
      redactSummary.textContent = `Sayfa ${k + 1} / ${islenecek.length} karartılıyor…`;
      const tuval = await PdfRender.sayfaCiz(kar.belge, no, { dpi });
      const c = tuval.getContext('2d');
      c.fillStyle = '#000';
      for (const b of kar.kutular.get(no) || []) {
        c.fillRect(Math.floor(b.x * tuval.width), Math.floor(b.y * tuval.height), Math.ceil(b.w * tuval.width) + 1, Math.ceil(b.h * tuval.height) + 1);
      }
      resimler.push({ index: no - 1, bytes: await tuvalBaytlari(tuval, 'image/jpeg', 0.9), mime: 'image/jpeg' });
      tuval.width = tuval.height = 0;
    }
    const bytes = await PdfEngine.replacePagesWithImages(d.bytes, resimler);
    downloadBlob(bytes, `${tabanAd(d.ad)}_karartilmis.pdf`);
    karartOzeti();
  }));

  // --- OCR: sayfa çizilir, Tesseract görünmez metin katmanlı PDF üretir, sayfalar birleşir
  tekDosyaKur('ocr');
  let ocrIsci = null;
  function ocrYolu(p) {
    return (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL(p) : new URL('../' + p, document.baseURI).href;
  }
  async function ocrIscisi() {
    if (typeof Tesseract === 'undefined') throw new Error('OCR motoru yüklenemedi.');
    if (!ocrIsci) {
      ocrIsci = Tesseract.createWorker('eng+tur', 1, {
        workerPath: ocrYolu('tesseract/worker.min.js'),
        corePath: ocrYolu('tesseract/tesseract-core-simd-lstm.wasm.js'),
        langPath: ocrYolu('tesseract/lang-data'),
        gzip: false,
        workerBlobURL: false
      });
    }
    return ocrIsci;
  }
  document.getElementById('btnOcrExport').addEventListener('click', e => calistir(e.currentTarget, async () => {
    const d = tekDosya.ocr;
    const dpi = Number(document.getElementById('ocrDpi').value);
    const secili = secilenSayfalar(document.getElementById('ocrPages').value, d.bilgi.pageCount) || d.bilgi.pages.map(p => p.index);
    const durum = document.getElementById('ocrStatus');
    durum.textContent = 'OCR motoru hazırlanıyor…';
    const isci = await ocrIscisi();
    // Tesseract PDF sayfa boyutunu görüntünün DPI'ından hesaplar; tuvalin DPI bilgisi yoktur.
    await isci.setParameters({ user_defined_dpi: String(dpi) });
    const belge = await PdfRender.ac(d.bytes);
    const parcalar = [];
    let karakter = 0;
    try {
      for (let k = 0; k < secili.length; k++) {
        durum.textContent = `Sayfa ${k + 1} / ${secili.length} okunuyor…`;
        const tuval = await PdfRender.sayfaCiz(belge, secili[k] + 1, { dpi });
        const jpeg = await tuvalBlob(tuval, 'image/jpeg', 0.85);
        tuval.width = tuval.height = 0;
        const { data } = await isci.recognize(jpeg, { pdfTitle: tabanAd(d.ad) }, { pdf: true, text: true });
        karakter += (data.text || '').trim().length;
        parcalar.push(new Uint8Array(data.pdf));
      }
    } finally {
      PdfRender.kapat(belge);
    }
    durum.textContent = 'Sayfalar birleştiriliyor…';
    const bytes = await PdfEngine.concatPdfs(parcalar);
    downloadBlob(bytes, `${tabanAd(d.ad)}_aranabilir.pdf`);
    durum.textContent = karakter
      ? `${secili.length} sayfa okundu, ${karakter.toLocaleString('tr-TR')} karakter tanındı.`
      : `${secili.length} sayfa okundu ama yazı tanınmadı. Sayfa görüntüsü bulanık ya da yazısız olabilir.`;
  }));

  // --- Şifre
  const secDropzone = document.getElementById('secDropzone');
  const secFileInput = document.getElementById('secFileInput');
  const secWorkspace = document.getElementById('secWorkspace');
  let secDosya = null;
  secDropzone.addEventListener('click', () => secFileInput.click());
  document.getElementById('btnSecChange').addEventListener('click', () => secFileInput.click());
  secFileInput.addEventListener('change', e => { secYukle(e.target.files && e.target.files[0]); secFileInput.value = ''; });
  setupDragAndDrop(secDropzone, files => secYukle(files[0]));
  async function secYukle(file) {
    if (!file || !/\.pdf$/i.test(file.name)) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sifreli = await PdfEngine.isPdfEncrypted(bytes);
      secDosya = { ad: file.name, bytes };
      document.getElementById('secFileName').textContent = file.name;
      document.getElementById('secState').textContent = sifreli ? 'şifreli' : 'şifresiz';
      document.getElementById('secProtect').hidden = sifreli;
      document.getElementById('secUnlock').hidden = !sifreli;
      ['secPass', 'secPass2', 'secUnlockPass'].forEach(id => { document.getElementById(id).value = ''; });
      secDropzone.hidden = true;
      secWorkspace.hidden = false;
    } catch (err) {
      alert(`PDF okunamadı: ${err.message}`);
    }
  }
  document.getElementById('btnSecProtect').addEventListener('click', e => calistir(e.currentTarget, async () => {
    const p1 = document.getElementById('secPass').value, p2 = document.getElementById('secPass2').value;
    if (!p1) throw new Error('Açılış parolası girin.');
    if (p1 !== p2) throw new Error('Parolalar aynı değil.');
    const sonuc = await PdfEngine.protectPdf(secDosya.bytes, {
      parola: p1,
      izin: {
        yazdirma: document.getElementById('secPrint').checked,
        kopyalama: document.getElementById('secCopy').checked,
        degistirme: document.getElementById('secModify').checked,
        formDoldurma: document.getElementById('secForms').checked
      }
    });
    downloadBlob(sonuc.bytes, `${tabanAd(secDosya.ad)}_sifreli.pdf`);
    document.getElementById('secPass').value = document.getElementById('secPass2').value = '';
  }));
  document.getElementById('btnSecUnlock').addEventListener('click', e => calistir(e.currentTarget, async () => {
    const bytes = await PdfEngine.unlockPdf(secDosya.bytes, document.getElementById('secUnlockPass').value);
    downloadBlob(bytes, `${tabanAd(secDosya.ad)}_sifresiz.pdf`);
    document.getElementById('secUnlockPass').value = '';
  }));

  // --- DRAG & DROP UTILITY ---
  function setupDragAndDrop(element, onDropFiles) {
    ['dragenter', 'dragover'].forEach(eventName => {
      element.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        element.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      element.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        element.classList.remove('dragover');
      });
    });

    element.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = dt.files;
      if (files && files.length > 0) {
        onDropFiles(files);
      }
    });
  }

  /* pdf.js'e dayanan araçlar eski Chrome'da çalışmaz (bkz. pdf-render.js).
     Kullanıcı dosya seçip hata almadan önce panelin başında söylenir;
     küçük resim ve kırpma önizlemesi sessizce numaraya/boşa düşer. */
  if (typeof PdfRender !== 'undefined' && !PdfRender.destekleniyor()) {
    for (const arac of ['toimage', 'redact', 'ocr']) {
      const panel = document.querySelector(`[data-panel="${arac}"]`);
      if (!panel) continue;
      const uyari = document.createElement('p');
      uyari.className = 'pdf-surum-uyarisi';
      uyari.setAttribute('role', 'status');
      uyari.textContent = PdfRender.GUNCELLE_MESAJI;
      panel.prepend(uyari);
    }
  }
})();
