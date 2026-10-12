/**
 * workbench/workbench-ui.js
 *
 * Veri Tezgâhı arayüz denetleyicisi. Tablo ve bütün hesaplama
 * tezgah-worker.js'te (ayrı iş parçacığı) durur: bu dosya yalnızca komut
 * gönderir, ilerlemeyi ve sonucu gösterir. Böylece 5 milyon satırlık bir
 * dosyada bile sayfa donmaz; bellek sınırına yaklaşan bir iş çökse de sayfa
 * ayakta kalır ve durumu söyler.
 */

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const sayi = n => Number(n || 0).toLocaleString('tr-TR');

  /**
   * Dosya/hücre verisi asla innerHTML'e yazılmaz: <img src=https://...> içeren bir
   * hücre profil tablosunda ağ isteği atıp sıfır ağ garantisini bozuyordu.
   * Tüm dinamik metin textContent ile basılır.
   */
  function elem(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  // etiket: "Tamam", "Dikkat", "Kritik" gibi kısa bir sözcük — emoji değil.
  function uyariKutusu(cls, etiket, kod, mesaj) {
    const kutu = elem('div', `alert-box ${cls}`);
    kutu.appendChild(elem('span', 'alert-label', etiket));
    const govde = elem('div');
    // Kod teknik etikettir (çevrilmez); mesaj ayrı parçadır: dil.js onu kendi
    // kalıbıyla çevirir, içindeki sütun adı ham kalır.
    if (kod) {
      const kodEl = elem('strong', null, `[${kod}]`);
      kodEl.translate = false;
      govde.appendChild(kodEl);
      govde.appendChild(document.createTextNode(' '));
    }
    govde.appendChild(elem('span', null, String(mesaj)));
    kutu.appendChild(govde);
    return kutu;
  }

  function indir(blob, ad) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = ad;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function jsonIndir(nesne, ad) {
    indir(new Blob([JSON.stringify(nesne, null, 2)], { type: 'application/json' }), ad);
  }

  // ==========================================
  // 0. İş parçacığı köprüsü
  // ==========================================
  let calisan = null;
  let sira = 0;
  const bekleyen = new Map();

  function calisanBaslat() {
    calisan = new Worker('tezgah-worker.js');
    calisan.onmessage = e => {
      const m = e.data || {};
      const b = bekleyen.get(m.id);
      if (!b) return;
      if (m.ilerleme) { if (b.ilerleme) b.ilerleme(m.ilerleme); return; }
      bekleyen.delete(m.id);
      if (m.tamam) b.coz(m.sonuc);
      else b.red(new Error(m.hata));
    };
    calisan.onerror = e => {
      e.preventDefault();
      calisanCoktu();
    };
  }

  /* İş parçacığı (ör. bellek sınırında) çökerse bekleyen istekler hata ile
     biter, yeni bir iş parçacığı kurulur ve arayüz boş tabloya döner. Sayfa
     çökmez. */
  function calisanCoktu() {
    bekleyen.forEach(b => {
      const hata = new Error('ÇÖKTÜ');
      hata.coktu = true;
      b.red(hata);
    });
    bekleyen.clear();
    try { calisan.terminate(); } catch (e) { /* zaten kapalı */ }
    calisanBaslat();
    arayuzuSifirla();
    healthAlertsList.textContent = '';
    healthAlertsList.appendChild(uyariKutusu('danger', 'Kritik', null,
      'İşlem tarayıcının bellek sınırını aştığı için durduruldu ve tablo kapatıldı. Sayfa çalışmaya devam ediyor. ' +
      'Dosyayı "ilk N satır" seçeneğiyle yükleyin ya da tamamı için Dosya işleri\'ndeki CSV Bölme / Tekilleştirme araçlarını kullanın; onlar dosyayı akışla işler.'));
  }

  function istek(islem, veri, ilerleme) {
    return new Promise((coz, red) => {
      const id = ++sira;
      bekleyen.set(id, { coz, red, ilerleme });
      calisan.postMessage({ id, islem, veri });
    });
  }

  calisanBaslat();

  // ==========================================
  // 1. Durum çubuğu (ilerleme, durdur)
  // ==========================================
  const durum = $('wbDurum');
  const durumMetin = $('wbDurumMetin');
  const durumDolgu = $('wbDurumDolgu');
  const durumIptal = $('wbDurumIptal');
  let mesgul = false;

  function durumAc(metin, iptalEdilebilir) {
    mesgul = true;
    document.body.classList.add('wb-mesgul');
    durum.hidden = false;
    durum.classList.remove('belirsiz');
    durumMetin.textContent = metin;
    durumDolgu.style.width = '0%';
    durum.classList.add('belirsiz');
    durumIptal.hidden = !iptalEdilebilir;
  }

  function durumGuncelle(p) {
    if (p.metin) durumMetin.textContent = p.metin;
    if (typeof p.oran === 'number') {
      durum.classList.remove('belirsiz');
      durumDolgu.style.width = Math.round(Math.min(1, p.oran) * 100) + '%';
    } else {
      durum.classList.add('belirsiz');
    }
  }

  function durumKapat() {
    mesgul = false;
    document.body.classList.remove('wb-mesgul');
    durum.hidden = true;
  }

  durumIptal.addEventListener('click', () => {
    durumMetin.textContent = 'Durduruluyor…';
    calisan.postMessage({ islem: 'iptal' });
  });

  /* Tüm işlemler buradan geçer: durum çubuğu, hata ve iptal tek yerde. */
  async function calis(islem, veri, metin, secenek) {
    if (mesgul) return null;
    durumAc(metin || 'İşleniyor…', secenek && secenek.iptal);
    try {
      return await istek(islem, veri, durumGuncelle);
    } catch (err) {
      if (err.coktu) return null;
      if (err.message === 'İPTAL') {
        healthAlertsList.textContent = '';
        healthAlertsList.appendChild(uyariKutusu('warn', 'Bilgi', null, 'Yükleme durduruldu.'));
        return null;
      }
      alert(err.message);
      return null;
    } finally {
      durumKapat();
    }
  }

  // ==========================================
  // 2. DOM
  // ==========================================
  const dropzone = $('wbDropzone');
  const fileInput = $('wbFileInput');
  const activeFileBar = $('activeFileBar');
  const activeFileName = $('activeFileName');
  const activeFileStats = $('activeFileStats');
  const btnClearActiveFile = $('btnClearActiveFile');
  const btnExportActiveClean = $('btnExportActiveClean');

  const domainTabs = document.querySelectorAll('.mode-tab, .domain-tab');
  const sections = document.querySelectorAll('.wb-section');

  const paletteBackdrop = $('paletteBackdrop');
  const paletteInput = $('paletteInput');
  const paletteList = $('paletteList');
  const btnOpenPalette = $('btnOpenPalette');

  const healthScoreBadge = $('healthScoreBadge');
  const healthAlertsList = $('healthAlertsList');
  const columnsMetricsBody = $('columnsMetricsBody');

  const sqlQueryInput = $('sqlQueryInput');
  const sqlResultContainer = $('sqlResultContainer');
  const sqlTableWrapper = $('sqlTableWrapper');

  const safeShareResults = $('safeShareResults');
  const maskSaltInput = $('maskSaltInput');
  const vaultFileInput = $('vaultFileInput');
  const vaultPassword = $('vaultPassword');

  const clipTextarea = $('clipTextarea');
  const recipeStepsList = $('recipeStepsList');

  // Arayüzün bildiği tablo özeti (veri worker'da).
  let aktif = null;
  let ozelKurallar = null;

  // ==========================================
  // 3. Sekmeler ve komut paleti
  // ==========================================
  function switchDomain(domainId) {
    domainTabs.forEach(tab => {
      const match = tab.getAttribute('data-domain') === domainId;
      tab.classList.toggle('is-active', match);
      tab.classList.toggle('active', match);
    });
    sections.forEach(sec => sec.classList.toggle('active', sec.id === `sec-${domainId}`));
  }

  domainTabs.forEach(tab => tab.addEventListener('click', () => switchDomain(tab.getAttribute('data-domain'))));

  /* Başka bir Masko aracını açar. Ana istasyonun içinde çerçevedeysek ana
     sayfaya o aracı seçtirir (yalnız aynı köken); tam ekrandaysak yeni sekme. */
  function aracAc(arac, yol) {
    if (window.parent !== window) {
      window.parent.postMessage({ maskoAracAc: arac }, location.origin);
    } else {
      window.open(yol, '_blank', 'noopener');
    }
  }

  const DIS_ARACLAR = {
    'data-unpivot': ['unpivot', '../unpivot/index.html'],
    'data-diff': ['diff', '../tablo-farki/index.html'],
    'data-fuzzy': ['fuzzy', '../bulanik-esleme/index.html'],
    'files-encoding': ['encoding', '../encoding-kurtarici/index.html'],
    'pdf-suite': ['pdf', '../pdf-istasyonu/index.html'],
    'pdf-redact': ['pdf', '../pdf-istasyonu/index.html'],
    'pdf-blank': ['pdf', '../pdf-istasyonu/index.html'],
    'pdf-diff': ['pdf', '../pdf-istasyonu/index.html']
  };

  function openPalette() {
    paletteBackdrop.classList.add('open');
    paletteInput.value = '';
    renderPaletteResults('');
    setTimeout(() => paletteInput.focus(), 50);
  }

  function closePalette() {
    paletteBackdrop.classList.remove('open');
  }

  function renderPaletteResults(query) {
    if (!window.CommandPalette) return;
    const results = window.CommandPalette.searchCommands(query);
    paletteList.textContent = '';
    if (results.length === 0) {
      const bos = elem('div', null, 'Eşleşen komut bulunamadı.');
      bos.style.cssText = 'padding: 14px 18px; color: var(--ink-muted); font-size: 0.85rem;';
      paletteList.appendChild(bos);
      return;
    }
    results.forEach((cmd, idx) => {
      const item = elem('div', `palette-item ${idx === 0 ? 'active' : ''}`);
      const baslik = elem('div', 'palette-item-header');
      baslik.appendChild(elem('span', 'palette-item-title', cmd.title));
      baslik.appendChild(elem('span', 'palette-item-domain', cmd.domain));
      item.appendChild(baslik);
      item.appendChild(elem('div', 'palette-item-desc', cmd.desc));
      item.addEventListener('click', () => {
        closePalette();
        executeCommand(cmd.id);
      });
      paletteList.appendChild(item);
    });
  }

  function executeCommand(cmdId) {
    if (DIS_ARACLAR[cmdId]) { aracAc(DIS_ARACLAR[cmdId][0], DIS_ARACLAR[cmdId][1]); return; }
    switch (cmdId) {
      case 'data-profile': switchDomain('data'); profilCalistir(); return;
      case 'data-validator': switchDomain('data'); dogrulamaCalistir(); return;
      case 'data-sql': switchDomain('data'); sqlQueryInput.focus(); return;
      case 'privacy-safe-share': switchDomain('privacy'); guvenliPaylasim(); return;
      case 'files-clipboard': switchDomain('files'); clipTextarea.focus(); return;
      case 'wf-recipe': switchDomain('workflows'); return;
      default:
        if (cmdId.startsWith('data-')) switchDomain('data');
        else if (cmdId.startsWith('privacy-')) switchDomain('privacy');
        else if (cmdId.startsWith('files-')) switchDomain('files');
        else if (cmdId.startsWith('wf-')) switchDomain('workflows');
    }
  }

  btnOpenPalette.addEventListener('click', openPalette);
  paletteBackdrop.addEventListener('click', e => { if (e.target === paletteBackdrop) closePalette(); });
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (paletteBackdrop.classList.contains('open')) closePalette(); else openPalette();
    } else if (e.key === 'Escape' && paletteBackdrop.classList.contains('open')) {
      closePalette();
    }
  });
  paletteInput.addEventListener('input', e => renderPaletteResults(e.target.value));

  // ==========================================
  // 4. Dosya yükleme ve bellek bütçesi
  // ==========================================
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length) dosyaYukle(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files && e.target.files.length) dosyaYukle(e.target.files[0]);
    fileInput.value = '';
  });

  const GB = 1024 * 1024 * 1024;
  const gbYaz = b => (b / GB).toLocaleString('tr-TR', { maximumFractionDigits: 1 }) + ' GB';
  const mbYaz = b => (b / 1048576).toLocaleString('tr-TR', { maximumFractionDigits: 0 }) + ' MB';

  /* Dosyanın Veri Tezgâhı'nda tutacağı bellek, bayt başına ölçülmüş katsayıyla
     tahmin edilir (5 milyon satırlık 289 MB CSV: ~820 MB tablo + profil payı).
     Bütçe: tarayıcı yığın sınırının ve cihaz belleğinin güvenli bir payı.
     Aşılırsa dosya çökme riskine atılmaz; "ilk N satır" önerilir. */
  function katsayi(ext) {
    if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') return 25;   // sıkıştırılmış; açılınca çok büyür
    if (ext === 'json') return 8;
    return 3.2;
  }

  function bellekButcesi() {
    const yigin = (performance.memory && performance.memory.jsHeapSizeLimit) || 4 * GB;
    const cihaz = (navigator.deviceMemory || 8) * GB;
    return Math.min(yigin * 0.55, cihaz * 0.3);
  }

  async function tahminiSatir(dosya) {
    const ornek = await dosya.slice(0, 1024 * 1024).text();
    const satir = (ornek.match(/\n/g) || []).length;
    if (!satir) return 1;
    return Math.round(dosya.size / (ornek.length / satir));
  }

  async function dosyaYukle(dosya) {
    if (mesgul) return;
    const ext = (dosya.name.split('.').pop() || '').toLowerCase();
    if (!['csv', 'tsv', 'txt', 'xlsx', 'xls', 'xlsm', 'json'].includes(ext)) {
      alert('Desteklenen biçimler: CSV, TSV, TXT, Excel (.xlsx, .xls) ve JSON.');
      return;
    }
    const tahmin = dosya.size * katsayi(ext);
    const butce = bellekButcesi();
    let satirSiniri = 0;
    if (tahmin > butce) {
      if (ext === 'json') {
        alert(`Bu JSON dosyası (${mbYaz(dosya.size)}) yaklaşık ${gbYaz(tahmin)} bellek ister; bu tarayıcı için güvenli sınır yaklaşık ${gbYaz(butce)}. JSON bölünerek okunamadığı için yüklenmedi.`);
        return;
      }
      const toplamTahmin = ext === 'csv' || ext === 'tsv' || ext === 'txt' ? await tahminiSatir(dosya) : 0;
      const oneri = toplamTahmin ? Math.max(1000, Math.floor(toplamTahmin * (butce / tahmin) / 1000) * 1000) : 200000;
      const tamam = confirm(
        `Bu dosya (${mbYaz(dosya.size)}${toplamTahmin ? ', yaklaşık ' + sayi(toplamTahmin) + ' satır' : ''}) Veri Tezgâhı'nda yaklaşık ${gbYaz(tahmin)} bellek ister; ` +
        `bu tarayıcı için güvenli sınır yaklaşık ${gbYaz(butce)}.\n\n` +
        `Tamam: ilk ${sayi(oneri)} satırı yükle.\n` +
        `İptal: yükleme. Dosyanın tamamı için Dosya işleri'ndeki CSV Bölme ya da Tekilleştirme araçlarını kullanın; onlar dosyayı akışla işler.`);
      if (!tamam) return;
      satirSiniri = oneri;
    }
    const oz = await calis('yukle', { dosya, satirSiniri }, `${dosya.name} okunuyor…`, { iptal: true });
    if (!oz) return;
    ozetUygula(oz);
    await profilCalistir();
  }

  function arayuzuSifirla() {
    aktif = null;
    activeFileBar.style.display = 'none';
    recipeStepsList.textContent = '';
    safeShareResults.textContent = '';
    sqlResultContainer.style.display = 'none';
    healthScoreBadge.textContent = 'Skor: —';
    healthScoreBadge.className = 'badge-pill accent';
    healthAlertsList.textContent = '';
    const p = elem('p', null, 'Henüz dosya yüklenmedi.');
    p.style.cssText = 'color: var(--ink-muted); font-size: 0.85rem;';
    healthAlertsList.appendChild(p);
    columnsMetricsBody.textContent = '';
    const tr = elem('tr');
    const td = elem('td', null, 'Henüz analiz edilmiş veri yok.');
    td.colSpan = 8;
    td.style.cssText = 'text-align: center; color: var(--ink-muted);';
    tr.appendChild(td);
    columnsMetricsBody.appendChild(tr);
  }

  /* Worker'dan gelen tablo özetini arayüze yansıtır. */
  function ozetUygula(oz) {
    if (!oz) return;
    aktif = oz;
    activeFileName.textContent = oz.ad;
    activeFileBar.style.display = 'flex';
    const parcalar = [`${sayi(oz.satirSayisi)} satır × ${oz.sutunSayisi} sütun`];
    if (oz.onarim && oz.onarim.bozukSatir) parcalar.push(`${sayi(oz.onarim.bozukSatir)} bozuk satır ayrıldı`);
    if (oz.onarim && oz.onarim.kesildi) parcalar.push('dosyanın başı yüklendi');
    activeFileStats.textContent = parcalar.join(' · ');
    btnExportActiveClean.textContent = oz.excelSiniriniAsiyor ? 'CSV olarak indir' : 'Excel olarak indir';
    btnExportActiveClean.title = oz.excelSiniriniAsiyor
      ? 'Tablo Excel\'in 1.048.576 satır sınırını aşıyor; CSV olarak indirilir.' : '';
    safeShareResults.textContent = '';
    tarifCiz(oz);
  }

  btnClearActiveFile.addEventListener('click', async () => {
    await calis('temizle', {}, 'Kapatılıyor…');
    arayuzuSifirla();
  });

  // ==========================================
  // 5. Profil ve doğrulama
  // ==========================================
  async function profilCalistir() {
    if (!aktif) return;
    const profile = await calis('profil', {}, 'Profil çıkarılıyor…');
    if (!profile) return;

    const score = profile.summary.healthScore;
    healthScoreBadge.textContent = `Sağlık: %${score}`;
    healthScoreBadge.className = score >= 85 ? 'badge-pill success' : score >= 60 ? 'badge-pill warn' : 'badge-pill danger';

    healthAlertsList.textContent = '';
    if (aktif.onarim && aktif.onarim.kesildi) {
      healthAlertsList.appendChild(uyariKutusu('warn', 'Bilgi', null,
        `Dosyanın tamamı değil, ilk ${sayi(aktif.satirSayisi)} satırı yüklendi (bellek bütçesi). Sonuçlar bu satırlar içindir.`));
    }
    if (aktif.onarim && aktif.onarim.bozukSatir) {
      healthAlertsList.appendChild(uyariKutusu('warn', 'Dikkat', 'BOZUK_SATIR',
        `${sayi(aktif.onarim.bozukSatir)} satırın sütun sayısı başlıkla uyuşmadığı için tablodan ayrıldı (ilki: ${aktif.onarim.bozukOrnek[0] ? aktif.onarim.bozukOrnek[0].satir + '. satır' : '—'}).`));
    }
    if (profile.alerts.length === 0) {
      healthAlertsList.appendChild(uyariKutusu('success', 'Tamam', null, 'Veri yapısında anomali bulunmadı.'));
    } else {
      profile.alerts.slice(0, 5).forEach(a => {
        const cls = a.severity === 'critical' ? 'danger' : 'warn';
        healthAlertsList.appendChild(uyariKutusu(cls, cls === 'danger' ? 'Kritik' : 'Dikkat', a.code, a.message));
      });
      if (profile.alerts.length > 5) {
        const more = elem('div', null, `… ve ${profile.alerts.length - 5} diğer uyarı.`);
        more.style.cssText = 'font-size: 0.8rem; color: var(--ink-muted);';
        healthAlertsList.appendChild(more);
      }
    }

    columnsMetricsBody.textContent = '';
    profile.columns.forEach(col => {
      const tr = elem('tr');
      const ad = elem('td');
      ad.translate = false;   // sütun adı ve örnek değerler veridir
      ad.appendChild(elem('strong', null, col.name));
      tr.appendChild(ad);
      const tur = elem('td');
      tur.translate = false;   // teknik tür adı (string, integer…): iki dilde aynı
      tur.appendChild(elem('span', 'wb-badge', col.inferredType));
      tr.appendChild(tur);
      tr.appendChild(elem('td', null, `%${col.nullPercent} (${sayi(col.nullCount)})`));
      tr.appendChild(elem('td', null, `%${col.uniquePercent} (${sayi(col.uniqueCount)})`));
      [`${col.topValue} (${sayi(col.topValueFreq)})`, col.min, col.max].forEach(deger => {
        const td = elem('td', null, deger);
        td.translate = false;
        tr.appendChild(td);
      });
      const ornek = elem('td', null, (col.samples || []).slice(0, 3).join(', '));
      ornek.translate = false;
      ornek.style.cssText = 'color: var(--ink-muted); font-size: 0.8rem;';
      tr.appendChild(ornek);
      columnsMetricsBody.appendChild(tr);
    });
  }

  $('btnRunProfiler').addEventListener('click', profilCalistir);

  async function dogrulamaCalistir() {
    if (!aktif) { alert('Lütfen önce bir dosya yükleyin.'); return; }
    const r = await calis('dogrula', { kurallar: ozelKurallar }, 'Kurallar denetleniyor…');
    if (!r) return;
    const s = r.report;
    alert(`Doğrulama tamamlandı\n\nToplam satır: ${sayi(s.totalRows)}\nTemiz satır: ${sayi(s.cleanRowsCount)}\nHatalı satır: ${sayi(s.invalidRowsCount)}\nBaşarı oranı: %${s.passRate}\n\nKurallar: ${r.kurallar.map(k => `${k.column} → ${k.type}`).join(', ')}`);
  }

  $('btnRunValidator').addEventListener('click', dogrulamaCalistir);

  $('btnManageRules').addEventListener('click', () => {
    if (!aktif) { alert('Lütfen önce bir dosya yükleyin.'); return; }
    const ornek = ozelKurallar || [{ column: aktif.basliklar[0], type: 'not_empty', message: 'Boş olamaz' }];
    const metin = prompt(
      'Kuralları JSON olarak düzenleyin. Türler: not_empty, unique, email, phone, tckn, vkn, date, regex (pattern), ' +
      'numeric (min, max), exact_length (length), min_length (min), max_length (max), allowed_values (values).\n' +
      'Sütunlar: ' + aktif.basliklar.join(', '),
      JSON.stringify(ornek));
    if (metin === null) return;
    try {
      const k = JSON.parse(metin);
      if (!Array.isArray(k) || !k.length) throw new Error('Kural listesi boş.');
      k.forEach(x => { if (!aktif.basliklar.includes(x.column)) throw new Error(`"${x.column}" adlı sütun yok.`); });
      ozelKurallar = k;
      dogrulamaCalistir();
    } catch (err) {
      alert('Kurallar okunamadı: ' + err.message);
    }
  });

  // ==========================================
  // 6. SQL
  // ==========================================
  async function sqlCalistir() {
    const sorgu = sqlQueryInput.value.trim();
    if (!sorgu) return;
    if (!aktif) { alert('Lütfen önce bir dosya yükleyin.'); return; }
    const r = await calis('sql', { sorgu }, 'Sorgu çalışıyor…');
    if (r) sqlSonucCiz(r);
  }

  function sqlSonucCiz(res) {
    sqlResultContainer.style.display = 'block';
    sqlTableWrapper.textContent = '';
    const gosterilen = Math.min(res.rows.length, 50);
    const ozetMetin = res.rowCount > gosterilen
      ? `Sonuç: ${sayi(res.rowCount)} satır (${res.durationMs} ms) · ilk ${gosterilen} satır gösteriliyor`
      : `Sonuç: ${sayi(res.rowCount)} satır (${res.durationMs} ms)`;
    const ozet = elem('div', null, ozetMetin);
    ozet.style.cssText = 'padding: 6px 12px; color: var(--tool); font-size: 0.85rem; font-weight: 600;';
    sqlTableWrapper.appendChild(ozet);
    const tablo = elem('table');
    tablo.translate = false;   // sorgu sonucu veridir
    const baslikSatiri = elem('tr');
    res.headers.forEach(h => baslikSatiri.appendChild(elem('th', null, h)));
    tablo.appendChild(elem('thead')).appendChild(baslikSatiri);
    const govde = elem('tbody');
    res.rows.slice(0, 50).forEach(r => {
      const tr = elem('tr');
      r.forEach(c => tr.appendChild(elem('td', null, c !== null && c !== undefined ? c : '')));
      govde.appendChild(tr);
    });
    tablo.appendChild(govde);
    sqlTableWrapper.appendChild(tablo);
  }

  $('btnExecuteSql').addEventListener('click', sqlCalistir);
  sqlQueryInput.addEventListener('keydown', e => { if (e.key === 'Enter') sqlCalistir(); });

  // SQL şablonlarında başlıklar tırnaklanır: "Ad Soyad", "e-posta" gibi başlıklar
  // tırnaksız yazılınca SQL motoru ayrıştırma hatası verir.
  const sqlAdi = h => '"' + String(h).replace(/"/g, '""') + '"';

  $('btnTplDuplicates').addEventListener('click', () => {
    if (!aktif) return;
    const k = sqlAdi(aktif.basliklar[0]);
    sqlQueryInput.value = `SELECT ${k}, COUNT(*) AS tekrar FROM aktif_tablo GROUP BY ${k} HAVING COUNT(*) > 1`;
    sqlCalistir();
  });

  $('btnTplSummary').addEventListener('click', () => {
    if (!aktif || aktif.basliklar.length < 2) return;
    const g = sqlAdi(aktif.basliklar[1]);
    sqlQueryInput.value = `SELECT ${g}, COUNT(*) AS adet FROM aktif_tablo GROUP BY ${g}`;
    sqlCalistir();
  });

  // Anti-Join iki liste ister; Veri Tezgâhı tek tablo tutar. A − B farkı
  // Tekilleştirme aracında akışla ve milyonlarca satırda yapılır.
  $('btnTplAntiJoin').addEventListener('click', () => {
    if (confirm('Anti-Join (A − B: bir listede olup diğerinde olmayanlar) iki dosya ister. Bunu Tekilleştirme aracında yapabilirsiniz; açılsın mı?')) {
      aracAc('dedup', '../kitle-tekillestirme/index.html');
    }
  });

  $('btnTplDdl').addEventListener('click', async () => {
    if (!aktif) return;
    const ddl = await calis('ddl', {}, 'DDL üretiliyor…');
    if (ddl) alert('Üretilen DDL:\n\n' + ddl);
  });

  // ==========================================
  // 7. Gizlilik
  // ==========================================
  async function guvenliPaylasim() {
    if (!aktif) { alert('Lütfen önce bir dosya yükleyin.'); return; }
    // Metaveri geçilmezse motor "güvenli" demez; XLSX için gizli sayfa, yazar,
    // yorum ve dış bağlantılar yükleme sırasında toplanır.
    const res = await calis('guvenliPaylasim', {}, 'Paylaşım öncesi denetim…');
    if (!res) return;
    safeShareResults.textContent = '';
    if (res.isSafeToShare) {
      const duzMetin = res.belgeBicimi && !/^xls/.test(res.belgeBicimi);
      safeShareResults.appendChild(uyariKutusu('success', 'Tamam', null,
        'Belgede maskelenmemiş PII, formül riski veya metaveri bulgusu yok. Güvenle paylaşılabilir.' +
        (duzMetin ? ' (Düz metin biçimi: gizli sayfa/yazar metaverisi taşımaz.)' : '')));
      return;
    }
    res.findings.forEach(f => {
      const kritik = f.severity === 'critical';
      safeShareResults.appendChild(uyariKutusu(kritik ? 'danger' : 'warn', kritik ? 'Kritik' : 'Dikkat', f.type, f.message));
    });
    if (res.findings.length === 0 && res.cellsClean) {
      safeShareResults.appendChild(uyariKutusu('warn', 'Dikkat', null,
        'Hücrelerde maskelenmemiş PII veya formül riski bulunamadı; ancak belge metaverisi denetlenemediği için dosya "güvenli" olarak işaretlenmedi.'));
    }
    (res.limitations || []).forEach(not => safeShareResults.appendChild(uyariKutusu('warn', 'Bilgi', 'KAPSAM', not)));
  }

  $('btnScanSafeShare').addEventListener('click', guvenliPaylasim);

  $('btnApplyJoinMask').addEventListener('click', async () => {
    if (!aktif) { alert('Lütfen önce bir dosya yükleyin.'); return; }
    // Anahtar boşsa motor oturuma özgü rastgele anahtar kullanır. Eskiden
    // herkesin bildiği sabit bir varsayılan tuz vardı: takma adlar kaynak kodu
    // okuyan herkes tarafından sözlük saldırısıyla geri çözülebiliyordu.
    const tuz = maskSaltInput.value.trim();
    const oz = await calis('iliskiliMaske', { tuz }, 'Takma adlar üretiliyor…');
    if (!oz) return;
    ozetUygula(oz);
    await profilCalistir();
    alert(tuz
      ? 'Birinci sütun ilişkiyi koruyan takma adlarla maskelendi.'
      : 'Birinci sütun maskelendi. Anahtar girilmediği için bu oturuma özgü rastgele bir anahtar kullanıldı: başka dosyalarla aynı takma adları almak için sayfayı kapatmadan işleyin ya da kendi gizli anahtarınızı girin.');
  });

  $('btnExportVault').addEventListener('click', async () => {
    const adet = await calis('kasaAdedi', {}, 'Kasa kontrol ediliyor…');
    if (!adet) { alert('Kasada kayıt yok. Önce "İlişkiyi koruyan maskeleme" ile bir tabloyu maskeleyin.'); return; }
    const parola = vaultPassword.value;
    if (!parola && !confirm('Parola girilmedi. Kasa ŞİFRESİZ indirilecek ve ' + sayi(adet) + ' gerçek değeri düz metin olarak içerecek. Devam edilsin mi?')) return;
    const r = await calis('kasaIndir', { parola }, 'Kasa hazırlanıyor…');
    if (!r) return;
    const tarih = new Date().toISOString().slice(0, 10);
    indir(r.blob, `masko_kasa_${tarih}${r.sifreli ? '' : '_SIFRESIZ'}.maskvault.json`);
    vaultPassword.value = '';
  });

  $('btnImportVault').addEventListener('click', () => {
    if (!aktif) { alert('Önce geri açılacak maskeli tabloyu yükleyin.'); return; }
    vaultFileInput.value = '';
    vaultFileInput.click();
  });

  vaultFileInput.addEventListener('change', async () => {
    const dosya = vaultFileInput.files && vaultFileInput.files[0];
    if (!dosya) return;
    let icerik;
    try { icerik = JSON.parse(await dosya.text()); } catch (e) { alert('Kasa dosyası okunamadı: geçerli JSON değil.'); return; }
    let parola = vaultPassword.value;
    if (icerik.encrypted && !parola) parola = prompt('Bu kasa şifreli. Kasa parolası:') || '';
    const r = await calis('kasadanAc', { icerik, parola }, 'Kasa açılıyor…');
    vaultPassword.value = '';
    if (!r) return;
    if (!r.restoredCount) { alert('Kasa açıldı ama aktif tabloda kasadaki takma adlardan hiçbiri bulunamadı.'); return; }
    ozetUygula(r.ozet);
    await profilCalistir();
    alert(sayi(r.restoredCount) + ' hücre kasadaki gerçek değerlere geri çevrildi.');
  });

  // ==========================================
  // 8. Dönüştür ve onar
  // ==========================================
  function sutunSor(mesaj, varsayilan) {
    if (!aktif) { alert('Lütfen önce bir dosya yükleyin.'); return null; }
    const cevap = prompt(`${mesaj}\nSütunlar: ${aktif.basliklar.join(', ')}`, varsayilan || aktif.basliklar[0]);
    if (cevap === null) return null;
    const ad = cevap.trim();
    if (!aktif.basliklar.includes(ad)) { alert(`"${ad}" adlı sütun yok.`); return null; }
    return ad;
  }

  $('btnRunCsvRescue').addEventListener('click', async () => {
    if (!aktif) { alert('Önce onarılacak CSV dosyasını yükleyin (yukarıdaki alana bırakın).'); return; }
    const r = await calis('csvOnar', {}, 'Onarılmış CSV yazılıyor…');
    if (!r) return;
    indir(r.blob, r.ad);
    const o = r.onarim;
    if (o) {
      alert(`Onarılmış CSV indirildi (UTF-8, ';' ayraç, formül korumalı).\n\nKaynak ayraç: ${o.ayrac === '\t' ? 'sekme' : o.ayrac} · kodlama: ${o.kodlama}\n` +
        (o.bozukSatir ? `${sayi(o.bozukSatir)} bozuk satır ayrıldı; ilkleri: ${o.bozukOrnek.map(b => b.satir + '. satır').join(', ')}.` : 'Bozuk satır bulunmadı.'));
    }
  });

  $('btnCleanClipboard').addEventListener('click', async () => {
    const metin = clipTextarea.value;
    if (!metin.trim()) return;
    const tsv = await calis('panoTemizle', { metin }, 'Temizleniyor…');
    if (!tsv) { alert('Panodaki metinde tablo bulunamadı.'); return; }
    try {
      await navigator.clipboard.writeText(tsv);
      alert('Pano verisi temizlendi ve panoya kopyalandı.');
    } catch (e) {
      alert('Panoya yazılamadı: ' + e.message);
    }
  });

  $('btnClipToTable').addEventListener('click', async () => {
    const metin = clipTextarea.value;
    if (!metin.trim()) return;
    const oz = await calis('panoTablo', { metin }, 'Tabloya aktarılıyor…');
    if (!oz) return;
    ozetUygula(oz);
    switchDomain('data');
    await profilCalistir();
  });

  $('btnOpenPivot').addEventListener('click', async () => {
    const satirAnahtari = sutunSor('Pivot: satırlarda kalacak sütun (ör. bölge)');
    if (!satirAnahtari) return;
    const pivotSutunu = sutunSor('Sütun başlıklarına açılacak sütun (ör. ay)', aktif.basliklar[1]);
    if (!pivotSutunu) return;
    const degerSutunu = sutunSor('Toplanacak değer sütunu (ör. tutar)', aktif.basliklar[aktif.basliklar.length - 1]);
    if (!degerSutunu) return;
    const f = (prompt('Toplama işlevi: SUM, COUNT, AVG, MIN veya MAX', 'SUM') || '').trim().toUpperCase();
    if (!['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'].includes(f)) { if (f) alert('Geçersiz işlev: ' + f); return; }
    const oz = await calis('pivot', { satirAnahtari, pivotSutunu, degerSutunu, fonksiyon: f }, 'Pivot tablo hesaplanıyor…');
    if (!oz) return;
    ozetUygula(oz);
    await profilCalistir();
  });

  $('btnExplodeCol').addEventListener('click', async () => {
    const sutun = sutunSor('Hücreleri satırlara patlatılacak sütun (ör. "a,b,c" içeren)');
    if (!sutun) return;
    const ayrac = prompt('Değer ayırıcı', ',');
    if (ayrac === null || ayrac === '') return;
    const oz = await calis('patlat', { sutun, ayrac }, 'Hücreler satırlara açılıyor…');
    if (!oz) return;
    ozetUygula(oz);
    await profilCalistir();
  });

  $('btnFlattenJson').addEventListener('click', async () => {
    const metin = prompt('Düzleştirmek istediğiniz JSON metnini veya dizi nesnesini yapıştırın:');
    if (!metin || !metin.trim()) return;
    const oz = await calis('jsonDuzlestir', { metin }, 'JSON düzleştiriliyor…');
    if (!oz) return;
    ozetUygula(oz);
    switchDomain('data');
    await profilCalistir();
    alert(`JSON düzleştirildi: ${sayi(oz.satirSayisi)} satır, ${oz.sutunSayisi} sütun.`);
  });

  $('btnFillDown').addEventListener('click', async () => {
    const sutun = sutunSor('Boş hücreleri üstteki değerle doldurulacak sütun');
    if (!sutun) return;
    adimEkle({ type: 'fill_missing', column: sutun, method: 'fill_down' }, `Boşluk doldur (${sutun})`);
  });

  $('btnGenSynthetic').addEventListener('click', async () => {
    const cevap = prompt(aktif
      ? 'Aktif tablonun yapısında kaç satır sentetik test verisi üretilsin? (Gerçek değer kullanılmaz; aktif tablonun yerini alır.)'
      : 'Örnek müşteri şemasında kaç satır sentetik test verisi üretilsin?', '1000');
    if (cevap === null) return;
    const adet = parseInt(cevap, 10);
    if (!(adet > 0 && adet <= 1000000)) { alert('1 ile 1.000.000 arasında bir sayı girin.'); return; }
    const oz = await calis('sentetik', { adet }, 'Sentetik veri üretiliyor…');
    if (!oz) return;
    ozetUygula(oz);
    await profilCalistir();
  });

  $('btnInspectDeep').addEventListener('click', async () => {
    if (!aktif) { alert('Lütfen önce bir Excel dosyası yükleyin.'); return; }
    const r = await calis('rontgen', {}, 'Çalışma kitabı inceleniyor…');
    if (!r) return;
    const satirlar = r.sheetReports.map(s =>
      `• ${s.sheetName}${s.isHidden ? ' (gizli)' : ''}: ${sayi(s.rowCount)} satır, ${s.formulaCount} formül, ${s.refErrorCount} #REF!, ${s.mergedCellsCount} birleşik, ${sayi(s.emptyFormattedRowsCount)} boş biçimli satır`);
    alert(`Excel röntgeni\n\n${r.totalSheets} sayfa (${r.hiddenSheetsCount} gizli) · ${r.totalFormulas} formül · ${r.totalRefErrors} #REF! · ${r.totalMergedCells} birleşik hücre · ${sayi(r.totalEmptyFormattedRows)} boş biçimli satır\n\n${satirlar.join('\n')}`);
  });

  $('btnTrimUsedRange').addEventListener('click', async () => {
    if (!aktif) { alert('Lütfen önce bir dosya yükleyin.'); return; }
    const r = await calis('bosKirp', {}, 'Boş satırlar kırpılıyor…');
    if (!r) return;
    ozetUygula(r.ozet);
    alert(`Boşluk kırpma tamamlandı\n\nKırpılan boş satır: ${sayi(r.istatistik.trimmedRows)}\nKırpılan boş sütun: ${r.istatistik.trimmedCols}\nKalan satır: ${sayi(r.istatistik.cleanRows)}`);
  });

  $('btnStripFormulas').addEventListener('click', async () => {
    if (!aktif) { alert('Lütfen önce bir dosya yükleyin.'); return; }
    const r = await calis('formulDondur', {}, 'Formüller donduruluyor…');
    if (!r) return;
    ozetUygula(r.ozet);
    alert(`Formül dondurma tamamlandı\n\nStatik değere çevrilen formül: ${sayi(r.formul)}\nTemizlenen hata kodu: ${sayi(r.hata)}\nKoparılan dış bağlantı: ${sayi(r.baglanti)}`);
  });

  // ==========================================
  // 9. Tarifler
  // ==========================================
  function tarifCiz(oz) {
    recipeStepsList.textContent = '';
    if (!oz || !oz.gecmis || !oz.gecmis.length) {
      const p = elem('p', null, 'Henüz işlem adımı eklenmedi.');
      p.style.cssText = 'color: var(--ink-muted); font-size: 0.83rem;';
      recipeStepsList.appendChild(p);
      return;
    }
    oz.gecmis.forEach((h, idx) => {
      const div = elem('div', `wb-step-card ${h.isActive ? 'active' : ''}`);
      // Adım adları başlık içerir (ör. "Mükerrerleri Sil (<başlık>)"): textContent ile basılır.
      const satir = elem('div');
      satir.style.cssText = 'display: flex; align-items: center; gap: 10px;';
      satir.appendChild(elem('span', 'wb-step-no', idx === 0 ? 'Kaynak' : `${idx}.`));
      const ad = elem('strong', null, h.stepName);
      ad.style.color = 'var(--ink)';
      satir.appendChild(ad);
      const adet = elem('span', null, `${sayi(h.stats.outputRows)} satır`);
      adet.style.cssText = 'color: var(--ink-muted); font-size: 0.75rem; background: var(--surface-alt); padding: 2px 7px; border-radius: var(--r-sm); border: 1px solid var(--rule);';
      satir.appendChild(adet);
      div.appendChild(satir);
      if (h.isActive) {
        const rozet = elem('span', 'wb-badge', 'Aktif adım');
        rozet.style.cssText = 'font-size: 0.68rem; padding: 2px 7px;';
        div.appendChild(rozet);
      }
      div.addEventListener('click', async () => {
        const r = await calis('adimaGit', { index: idx }, 'Adıma dönülüyor…');
        if (r && r.basarili) { ozetUygula(r.ozet); await profilCalistir(); }
      });
      recipeStepsList.appendChild(div);
      if (idx === 0 && oz.atilanAdim > 0) {
        const not = elem('div', null, `… ${oz.atilanAdim} eski adım (geçmiş sınırı nedeniyle ara kopyası bellekten atıldı; tarife dahildir)`);
        not.style.cssText = 'color: var(--ink-muted); font-size: 0.75rem; padding: 2px 10px;';
        recipeStepsList.appendChild(not);
      }
    });
  }

  async function adimEkle(ayar, ad) {
    if (!aktif) { alert('Lütfen önce bir dosya yükleyin.'); return; }
    const oz = await calis('adim', { ayar, ad }, `${ad} uygulanıyor…`);
    if (!oz) return;
    ozetUygula(oz);
    await profilCalistir();
  }

  $('btnRecipeUndo').addEventListener('click', async () => {
    const r = await calis('geriAl', {}, 'Geri alınıyor…');
    if (!r) return;
    if (r.basarili) { ozetUygula(r.ozet); await profilCalistir(); }
    else if (r.mesaj && r.ozet && r.ozet.atilanAdim > 0) alert(r.mesaj);
  });

  $('btnRecipeRedo').addEventListener('click', async () => {
    const r = await calis('yinele', {}, 'Yineleniyor…');
    if (r && r.basarili) { ozetUygula(r.ozet); await profilCalistir(); }
  });

  $('btnAddStepNormalize').addEventListener('click', () =>
    adimEkle({ type: 'normalize_headers', case: 'snake_case', turkish_ascii: true }, 'Başlıkları normalize et (snake_case)'));

  $('btnAddStepDedupe').addEventListener('click', () => {
    if (!aktif) { alert('Lütfen önce bir dosya yükleyin.'); return; }
    const sutun = sutunSor('Hangi sütuna göre tekrar eden satırlar silinsin? (ilk kayıt kalır)');
    if (sutun) adimEkle({ type: 'deduplicate', columns: [sutun], keep: 'first' }, `Mükerrerleri sil (${sutun})`);
  });

  $('btnAddStepMask').addEventListener('click', () => {
    const sutun = sutunSor('Maskelenecek sütun');
    if (!sutun) return;
    const kip = (prompt('Maskeleme biçimi: asterisk (A***t), token (ID_1, ID_2…), sha256 (anahtarlı özet), generalize_date (yıl-ay) veya empty (boşalt)', 'asterisk') || '').trim();
    if (!['asterisk', 'token', 'sha256', 'generalize_date', 'empty'].includes(kip)) { if (kip) alert('Geçersiz biçim: ' + kip); return; }
    adimEkle({ type: 'mask_column', column: sutun, mode: kip }, `Maskele (${sutun}, ${kip})`);
  });

  $('btnExportRecipeJson').addEventListener('click', async () => {
    const tarif = await calis('tarifIndir', {}, 'Tarif hazırlanıyor…');
    if (tarif) jsonIndir(tarif, 'masko_tarif.json');
  });

  const tarifDosyasi = document.createElement('input');
  tarifDosyasi.type = 'file';
  tarifDosyasi.accept = '.json,application/json';
  tarifDosyasi.hidden = true;
  document.body.appendChild(tarifDosyasi);

  $('btnImportRecipeJson').addEventListener('click', () => {
    if (!aktif) { alert('Tarifi uygulamak için önce bir dosya yükleyin.'); return; }
    tarifDosyasi.value = '';
    tarifDosyasi.click();
  });

  tarifDosyasi.addEventListener('change', async () => {
    const dosya = tarifDosyasi.files && tarifDosyasi.files[0];
    if (!dosya) return;
    let tarif;
    try { tarif = JSON.parse(await dosya.text()); } catch (e) { alert('Tarif dosyası okunamadı: geçerli JSON değil.'); return; }
    const oz = await calis('tarifYukle', { tarif }, 'Tarif uygulanıyor…');
    if (!oz) return;
    ozetUygula(oz);
    await profilCalistir();
  });

  $('btnExportRunManifest').addEventListener('click', async () => {
    const m = await calis('manifestIndir', {}, 'İşlem kaydı hazırlanıyor…');
    if (m) jsonIndir(m, `masko_icra_manifestosu_${m.runId}.run.json`);
  });

  // ==========================================
  // 10. Dışa aktarma
  // ==========================================
  btnExportActiveClean.addEventListener('click', async () => {
    if (!aktif) return;
    const bicim = aktif.excelSiniriniAsiyor ? 'csv' : 'xlsx';
    const r = await calis('disaAktar', { bicim }, bicim === 'csv' ? 'CSV yazılıyor…' : 'Excel dosyası yazılıyor…');
    if (r) indir(r.blob, r.ad);
  });

  arayuzuSifirla();
})();
