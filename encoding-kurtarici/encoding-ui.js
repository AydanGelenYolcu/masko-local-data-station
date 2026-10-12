/**
 * encoding-ui.js
 * Bozuk Karakter & Encoding Kurtarıcı Arayüz Kontrolörü
 */

(function () {
  'use strict';

  let originalBytes = null;
  let repairedText = '';
  let fileName = '';

  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const resultSection = document.getElementById('resultSection');

  const labelFileName = document.getElementById('labelFileName');
  const labelFileMeta = document.getElementById('labelFileMeta');

  const statusDesc = document.getElementById('statusDesc');
  const statusStats = document.getElementById('statusStats');
  const codeBefore = document.getElementById('codeBefore');
  const codeAfter = document.getElementById('codeAfter');
  const btnDownloadUtf8 = document.getElementById('btnDownloadUtf8');
  const singleLetterRow = document.getElementById('singleLetterRow');
  const singleLetterFix = document.getElementById('singleLetterFix');

  // Tıklamadan hemen sonra URL iptal edilirse bazı tarayıcılarda indirme
  // başlamadan blob kaybolur; indirme kendi referansını alana kadar bekle.
  const URL_IPTAL_GECIKMESI = 20000;

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
    fileName = file.name;
    labelFileName.textContent = file.name;
    labelFileName.translate = false;   // dosya adı veridir
    labelFileMeta.textContent = `${(file.size / 1024).toFixed(1)} KB · Analiz ediliyor...`;

    try {
      const buffer = await file.arrayBuffer();
      originalBytes = new Uint8Array(buffer);

      const engine = window.EncodingRepairEngine;
      if (!engine) {
        alert('Encoding motoru yüklenemedi.');
        return;
      }

      // Yeni dosyada tek harf dönüşümü kapalı başlar — önceki seçim taşınmaz
      singleLetterFix.checked = false;
      onar();

      // Orijinal görünüm (varsayılan tarayıcı/sistem gözüyle)
      let rawSample = '';
      try {
        rawSample = new TextDecoder('utf-8', { fatal: false }).decode(originalBytes.slice(0, 1500));
      } catch (e) {
        rawSample = repairedText.slice(0, 1500);
      }
      codeBefore.textContent = rawSample;

      resultSection.style.display = 'flex';
    } catch (err) {
      alert('Dosya işlenirken hata oluştu: ' + err.message);
    }
  }

  /* Onarımı çalıştırıp özeti tazeler. Kodlama kararı tüm dosyanın katı
     UTF-8 çözümünden gelir (repairRes.detected); ilk 100 KB'lık örneğe
     bakan detectEncoding büyük dosyada yanılabilir. */
  function onar() {
    const engine = window.EncodingRepairEngine;
    const repairRes = engine.repairToUtf8String(originalBytes, { singleLetterFix: singleLetterFix.checked });
    const detected = repairRes.detected;
    repairedText = repairRes.text;

    statusDesc.textContent = detected.description;
    statusStats.textContent = `${repairRes.repairedChars.toLocaleString('tr-TR')} bozuk Türkçe karakter onarıldı · ${repairRes.stats.charLength.toLocaleString('tr-TR')} karakter`;
    codeAfter.textContent = repairedText.slice(0, 1500);
    labelFileMeta.textContent = `${(originalBytes.length / 1024).toFixed(1)} KB · ${detected.encoding.toUpperCase()}`;

    const suphe = detected.singleLetterSuspect || 0;
    singleLetterRow.hidden = !suphe && !singleLetterFix.checked;
  }

  singleLetterFix.addEventListener('change', () => {
    if (originalBytes) onar();
  });

  btnDownloadUtf8.addEventListener('click', () => {
    if (!repairedText) return;
    const engine = window.EncodingRepairEngine;
    const cleanBytes = engine.exportCleanUtf8WithBom(repairedText);

    const blob = new Blob([cleanBytes], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = fileName.replace(/\.[^/.]+$/, '');
    const ext = fileName.split('.').pop() || 'csv';
    a.download = `${baseName}_utf8_bom.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), URL_IPTAL_GECIKMESI);
  });
})();
