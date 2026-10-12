/* =====================================================
   CSV BÖLME — ARAYÜZ
   =====================================================
   • Dosya seçme (tıklama + klavye + sürükle-bırak)
   • Ön inceleme: başlık, sütunlar, tahmini satır
   • Çıktı yazıcısı: klasöre doğrudan akıtma, olmazsa indirme
   • Tüm etkileşimler olay dinleyicisiyle bağlanır (MV3 CSP uyumlu)
   ===================================================== */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  const pickScreen  = $('pick-screen');
  const setupScreen = $('setup-screen');
  const dropzone    = $('dropzone');
  const fileInput   = $('file-input');
  const pickError   = $('pick-error');
  const pickErrorTx = $('pick-error-text');

  const btnBack   = $('btn-back');
  const fileInfo  = $('file-info');
  const factSize  = $('fact-size');
  const factRows  = $('fact-rows');
  const factCols  = $('fact-cols');
  const factDelim = $('fact-delim');
  const colChips  = $('col-chips');
  const formulaWarn = $('formula-warn');

  const rowsPerPart = $('rows-per-part');
  const mbPerPart   = $('mb-per-part');
  const outDelim    = $('out-delim');
  const outputFormat= $('output-format');
  const delimHint   = $('delim-hint');
  const preview     = $('preview');
  const limitWarn   = $('limit-warn');

  const btnRun      = $('btn-run');
  const btnCancel   = $('btn-cancel');
  const runHint     = $('run-hint');
  const progressWrap= $('progress-wrap');
  const loadingBar  = $('loading-bar');
  const loadingProg = $('loading-progress');
  const progressText= $('progress-text');
  const runError    = $('run-error');
  const runErrorTx  = $('run-error-text');

  const resultCard  = $('result-card');
  const resultBadge = $('result-badge');
  const resultList  = $('result-list');
  const toastRegion = $('toast-region');

  const EXCEL_SINIRI = 1048576;   // başlık dahil sayfa başına satır
  const COK_PARCA_ESIGI = 50;     // bunun üstünde ekranda uyarı çıkar
  const ONAY_ESIGI      = 200;    // bunun üstünde çalıştırmadan önce onay sorulur
  const PARCA_TAVANI    = 5000;   // motor bu sayıda parçadan sonra kendini durdurur
  const klasorDestegi = typeof window.showDirectoryPicker === 'function';

  let secilenDosya = null;
  let inceleme     = null;
  let calisiyor    = false;
  let iptalIstendi = false;

  /* ---------- YARDIMCILAR ---------- */

  const sayi = n => Number(n).toLocaleString('tr-TR');

  function boyut(bayt) {
    if (bayt < 1024) return bayt + ' B';
    if (bayt < 1024 * 1024) return (bayt / 1024).toFixed(1) + ' KB';
    if (bayt < 1024 * 1024 * 1024) return (bayt / 1024 / 1024).toFixed(1) + ' MB';
    return (bayt / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function toast(mesaj, tehlikeli) {
    const el = document.createElement('div');
    el.className = 'toast' + (tehlikeli ? ' is-danger' : '');
    el.textContent = mesaj;
    toastRegion.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  function hata(kutu, metin, yazi) {
    yazi.textContent = metin;
    kutu.hidden = false;
  }

  /* ---------- 1. DOSYA SEÇME ---------- */

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', e => { e.preventDefault(); dropzone.classList.remove('dragover'); });
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) dosyaAl(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', e => { if (e.target.files[0]) dosyaAl(e.target.files[0]); });

  async function dosyaAl(file) {
    pickError.hidden = true;
    try {
      inceleme = await SplitEngine.onInceleme(file);
    } catch (err) {
      hata(pickError, err.message, pickErrorTx);
      return;
    }
    secilenDosya = file;
    ekraniKur();
    pickScreen.classList.remove('active');
    setupScreen.classList.add('active');
  }

  /* ---------- 2. AYAR EKRANI ---------- */

  function ekraniKur() {
    fileInfo.textContent = secilenDosya.name;
    fileInfo.translate = false;   // dosya adı veridir
    factSize.textContent = boyut(inceleme.dosyaBoyutu);
    factRows.innerHTML = inceleme.kesinMi
      ? sayi(inceleme.tahminiSatir)
      : '≈ ' + sayi(inceleme.tahminiSatir) + ' <em>tahmini</em>';
    factCols.textContent = sayi(inceleme.sutunlar.length);
    factDelim.textContent = inceleme.ayrac === '\t' ? 'sekme' : inceleme.ayrac;

    colChips.innerHTML = '';
    inceleme.sutunlar.forEach(ad => {
      const chip = document.createElement('span');
      chip.className = 'col-chip';
      chip.textContent = ad || '(adsız)';
      colChips.appendChild(chip);
    });

    /* Excel, sütun ayracı olarak Windows'un liste ayırıcısını bekler
       (Türkçe'de ';'). Kaynak farklıysa dosya tek sütunda açılır, o
       yüzden varsayılanı dönüştürmeye çekiyoruz. */
    outDelim.value = ';';
    delimHintTazele();
    formulUyarisiTazele();

    resultCard.hidden = true;
    runError.hidden = true;
    progressWrap.hidden = true;
    onizlemeTazele();
  }

  /* Boş/geçersiz alan "sınır yok" demektir — 1'e yuvarlanmaz.
     Eskiden boş satır alanı parça başına 1 SATIR anlamına geliyordu ve
     20 MB'lık dosya on binlerce küçük dosyaya bölünüyordu. */
  function ayarlariOku() {
    const satirHam = String(rowsPerPart.value).trim();
    const mbHam    = String(mbPerPart.value).trim();
    const satir = satirHam === '' ? 0 : Math.max(0, parseInt(satirHam, 10) || 0);
    const mb    = mbHam    === '' ? 0 : Math.max(0, parseInt(mbHam, 10) || 0);
    return { satir, bayt: mb * 1024 * 1024 };
  }

  /* Bu ayarla kaç parça çıkacağını tahmin eder. */
  function parcaTahmini(satir, bayt) {
    let a = 0, b = 0;
    if (satir > 0) a = Math.ceil(inceleme.tahminiSatir / satir);
    if (bayt  > 0) b = Math.ceil(inceleme.dosyaBoyutu / bayt);
    return Math.max(1, a, b);
  }

  function onizlemeTazele() {
    if (!inceleme) return;
    const { satir, bayt } = ayarlariOku();
    const xlsx = outputFormat.value === 'xlsx';
    const etkinSatir = xlsx ? Math.min(satir || Infinity, 100000) : satir;
    const etkinBayt = xlsx ? Math.min(bayt || Infinity, 32 * 1024 * 1024) : bayt;

    if (satir === 0 && bayt === 0) {
      preview.textContent = 'Bölme yapılmayacak — en az bir sınır girin (satır ya da boyut).';
      btnRun.disabled = true;
      limitWarn.hidden = true;
      return;
    }
    btnRun.disabled = false;

    const parca = parcaTahmini(etkinSatir, etkinBayt);
    const yaklasik = inceleme.kesinMi ? '' : '≈ ';
    const kosullar = [];
    if (etkinSatir > 0 && isFinite(etkinSatir)) kosullar.push(`${sayi(etkinSatir)} satır`);
    if (etkinBayt > 0 && isFinite(etkinBayt)) kosullar.push(`${sayi(etkinBayt / 1024 / 1024)} MB kaynak veri`);

    preview.textContent = `${yaklasik}${sayi(parca)} parça oluşacak · her parçada en fazla ${kosullar.join(' ve ')}`;

    const uyarilar = [];
    if (xlsx) uyarilar.push('Excel biçiminde parça başına en çok 100.000 veri satırı veya 32 MB kaynak veri kullanılır. Çıktı dosyasının gerçek boyutu farklı olabilir.');
    if (satir >= EXCEL_SINIRI) {
      uyarilar.push(`Parça başına ${sayi(satir)} satır, Excel'in sayfa başına ${sayi(EXCEL_SINIRI)} satır sınırına eşit veya üstünde. `
        + `Başlık da bir satır yediği için parçalar Excel'de tam açılmayabilir — 1.000.000 güvenli tarafta kalır.`);
    }
    if (parca > COK_PARCA_ESIGI) {
      uyarilar.push(`Bu ayar ${yaklasik}${sayi(parca)} ayrı dosya üretir. Parça başına satır ya da boyutu artırmadan devam ederseniz klasörünüz binlerce küçük dosyayla dolar.`);
    }
    limitWarn.hidden = uyarilar.length === 0;
    limitWarn.textContent = uyarilar.join(' ');
  }

  function ayracAdi(a) {
    if (a === '\t') return 'sekme';
    if (a === ';')  return 'noktalı virgül ( ; )';
    if (a === ',')  return 'virgül ( , )';
    return `"${a}"`;
  }

  /* Seçilen çıktı ayracını döner; "kaynak" ise dönüşüm yapılmaz. */
  function cikisAyraci() {
    const v = outDelim.value;
    if (v === 'kaynak') return null;
    return v === '\\t' ? '\t' : v;
  }

  function delimHintTazele() {
    if (!inceleme) return;
    const hedef = cikisAyraci();
    if (!hedef || hedef === inceleme.ayrac) {
      delimHint.textContent = `Kaynak ayracı ${ayracAdi(inceleme.ayrac)} — olduğu gibi kalacak, baytlara hiç dokunulmaz.`;
    } else {
      delimHint.textContent = `Kaynak ${ayracAdi(inceleme.ayrac)} → çıktı ${ayracAdi(hedef)} olarak yazılacak.`;
    }
  }

  /* Formül enjeksiyonu uyarısı. Bölme baytları olduğu gibi kopyalar —
     "=HYPERLINK(...)" gibi bir hücreyi sessizce değiştirmek parçaları
     kaynaktan farklı yapardı. Bu yüzden CSV'de dönüştürmüyor, UYARIYORUZ.
     Excel (.xlsx) çıktısında hücreler metin olarak yazıldığından formül
     çalışmaz; orada bilgi notu yeterli. */
  function formulUyarisiTazele() {
    if (!inceleme || !inceleme.ornekFormulRisk) { formulaWarn.hidden = true; return; }
    const ornek = (inceleme.ornekFormulOrnekleri || []).map(v => `“${v}”`).join(', ');
    const adet = sayi(inceleme.ornekFormulSayisi || 1);
    formulaWarn.textContent = outputFormat.value === 'xlsx'
      ? `Dosyanın başındaki örnekte formül gibi başlayan ${adet} hücre var (${ornek}). Excel (.xlsx) çıktısında hücreler metin olarak yazılır; formül çalışmaz.`
      : `Dikkat: dosyanın başındaki örnekte formül gibi başlayan ${adet} hücre var (${ornek}). Bölme baytları değiştirmez; CSV parçaları Excel'de açıldığında bu hücreler formül olarak çalışabilir. Güvenilmeyen kaynaktan geldiyse Excel (.xlsx) çıktısını seçin.`;
    formulaWarn.hidden = false;
  }

  rowsPerPart.addEventListener('input', onizlemeTazele);
  mbPerPart.addEventListener('input', onizlemeTazele);
  outDelim.addEventListener('change', delimHintTazele);
  outputFormat.addEventListener('change', () => {
    $('out-delim-row').hidden = outputFormat.value === 'xlsx';
    onizlemeTazele();
    formulUyarisiTazele();
  });

  btnBack.addEventListener('click', () => {
    if (calisiyor) return;
    setupScreen.classList.remove('active');
    pickScreen.classList.add('active');
    fileInput.value = '';
    secilenDosya = null;
    inceleme = null;
  });

  /* ---------- ÇIKTI YAZICILARI ----------
     Motor çıktının nereye gittiğini bilmez; yalnızca {write, close}
     ister. Böylece klasöre akıtma ile indirme aynı kod yolunu paylaşır. */

  function parcaAdi(no, toplam) {
    const taban = secilenDosya.name.replace(/\.[^.]+$/, '');
    const uzanti = outputFormat.value === 'xlsx' ? '.xlsx' : '.csv';
    const basamak = Math.max(2, String(Math.max(1, toplam)).length);
    return `${taban}_parca${String(no).padStart(basamak, '0')}${uzanti}`;
  }

  function klasorYazici(dirHandle, toplamTahmin) {
    return async function (no) {
      const ad = parcaAdi(no, toplamTahmin);
      const fh = await dirHandle.getFileHandle(ad, { create: true });
      const w  = await fh.createWritable();
      return {
        ad,
        write: bytes => w.write(bytes),
        close: () => w.close()
      };
    };
  }

  /* Klasör yazma yoksa: parça bellekte toplanır, kapanışta indirilir.
     Aynı anda yalnızca bir parça bellekte durur. */
  function indirmeYazici(toplamTahmin) {
    return async function (no) {
      const ad = parcaAdi(no, toplamTahmin);
      const parcalar = [];
      return {
        ad,
        write: async bytes => { parcalar.push(bytes.slice()); },
        close: async () => {
          const blob = new Blob(parcalar, { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = ad;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 20000);
        }
      };
    };
  }

  function csvSatirlari(bytes, ayrac) {
    let metin = new TextDecoder('utf-8').decode(bytes);
    if ((metin.match(/�/g) || []).length > metin.length / 5000) {
      try { metin = new TextDecoder('windows-1254').decode(bytes); } catch (_) { /* UTF-8 kalır */ }
    }
    /* Bölme motoruyla aynı ortak ayrıştırıcı (csv-io.js; BOM'u da o atar):
       tırnak yalnızca alan başında açılır. Kapanmayan tırnak parçanın geri
       kalanını tek hücreye yapıştırmaz, düz metin kalır — CSV parçası da
       aynı baytları olduğu gibi taşır. */
    return CsvIO.parse(metin, { delimiter: ayrac }).rows;
  }

  function xlsxBlob(bytes, ayrac) {
    const rows = csvSatirlari(bytes, ayrac);
    if (rows.length > 100001) throw new Error('Excel parçası 100.000 veri satırı sınırını aştı.');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Parca');
    return new Blob([XLSX.write(wb, { bookType:'xlsx', type:'array', compression:true })], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function excelYazici(dirHandle, toplamTahmin) {
    return async no => {
      const ad = parcaAdi(no, toplamTahmin), chunks = [];
      let size = 0;
      return { ad,
        write: async bytes => { size += bytes.length; if (size > 40 * 1024 * 1024) throw new Error('Excel parçası bellek sınırını aştı; daha küçük parçalara bölün.'); chunks.push(bytes.slice()); },
        close: async () => {
          const bytes = new Uint8Array(size); let at = 0;
          for (const c of chunks) { bytes.set(c, at); at += c.length; }
          const blob = xlsxBlob(bytes, inceleme.ayrac);
          if (dirHandle) {
            const fh = await dirHandle.getFileHandle(ad, { create:true });
            const w = await fh.createWritable(); await w.write(blob); await w.close();
          } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = ad;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 20000);
          }
        }
      };
    };
  }

  /* ---------- 3. ÇALIŞTIR ---------- */

  if (!klasorDestegi) {
    runHint.textContent = 'Bu tarayıcıda klasöre doğrudan yazma yok — parçalar İndirilenler klasörüne sırayla inecek.';
    $('btn-run-icon').setAttribute('href', '#i-file-out');
    $('btn-run-label').textContent = 'Böl ve İndir';
  }

  btnRun.addEventListener('click', async () => {
    if (calisiyor || !secilenDosya) return;

    const { satir, bayt } = ayarlariOku();
    if (satir === 0 && bayt === 0) {
      hata(runError, 'En az bir sınır girin: parça başına satır ya da boyut.', runErrorTx);
      return;
    }

    const xlsx = outputFormat.value === 'xlsx';
    const etkinSatir = xlsx ? Math.min(satir || Infinity, 100000) : satir;
    const etkinBayt = xlsx ? Math.min(bayt || Infinity, 32 * 1024 * 1024) : bayt;
    const toplamTahmin = parcaTahmini(etkinSatir, etkinBayt);

    /* Çok sayıda parça geri alınması zor bir sonuçtur: klasöre binlerce
       dosya yazılır ya da indirme olarak yağar. Başlamadan önce sor. */
    if (toplamTahmin > ONAY_ESIGI) {
      const yaklasik = inceleme.kesinMi ? '' : 'yaklaşık ';
      const ek = klasorDestegi
        ? 'Hepsi seçeceğiniz klasöre yazılacak.'
        : 'Hepsi ayrı ayrı indirilecek — tarayıcınız binlerce indirme isteyecek.';
      if (!confirm(
        `Bu ayarla ${yaklasik}${sayi(toplamTahmin)} ayrı dosya oluşacak.\n${ek}\n\n` +
        `Parça başına ${satir > 0 ? sayi(satir) + ' satır' : 'satır sınırı yok'}` +
        `${bayt > 0 ? ' / ' + sayi(bayt / 1024 / 1024) + ' MB' : ''}.\n\n` +
        `Devam edilsin mi?`)) {
        return;
      }
    }

    let parcaAc;
    if (klasorDestegi) {
      let dirHandle;
      try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          toast('Klasör seçilmedi — bölme başlatılmadı.');
          return;
        }
        /* Chrome, Windows / Program Files / AppData gibi hassas konumlara
           yazmayı kendi güvenlik listesiyle engeller. Bu bir tarayıcı
           kısıtıdır; sayfa bunu kaldıramaz, yapılacak şey başka bir
           klasör seçmektir. */
        hata(runError,
          'Bu klasör kullanılamadı: ' + err.message +
          ' — Chrome, Windows ve Program Files gibi sistem konumlarına yazmayı engeller. ' +
          'Belgeler veya Masaüstü altında normal bir klasör seçin.',
          runErrorTx);
        return;
      }

      // Aynı isimde parça varsa üzerine yazmadan önce sor — klasörde
      // duran bir dosyayı sessizce ezmek geri alınamaz.
      const ilkAd = parcaAdi(1, toplamTahmin);
      let varOlan = false;
      try { await dirHandle.getFileHandle(ilkAd); varOlan = true; } catch (e) { /* yok, sorun değil */ }
      if (varOlan && !confirm(`Bu klasörde "${ilkAd}" zaten var.\nDevam edilirse aynı isimli parçaların üzerine yazılacak.\n\nDevam edilsin mi?`)) {
        return;
      }

      parcaAc = xlsx ? excelYazici(dirHandle, toplamTahmin) : klasorYazici(dirHandle, toplamTahmin);
    } else {
      parcaAc = xlsx ? excelYazici(null, toplamTahmin) : indirmeYazici(toplamTahmin);
    }

    await bolmeyiCalistir(parcaAc, etkinSatir, etkinBayt);
  });

  btnCancel.addEventListener('click', () => {
    iptalIstendi = true;
    btnCancel.disabled = true;
    btnCancel.textContent = 'Durduruluyor…';
  });

  async function bolmeyiCalistir(parcaAc, satirSiniri, baytSiniri) {
    calisiyor = true;
    iptalIstendi = false;
    runError.hidden = true;
    resultCard.hidden = true;
    resultList.innerHTML = '';
    progressWrap.hidden = false;
    btnRun.disabled = true;
    btnBack.disabled = true;
    btnCancel.hidden = false;
    btnCancel.disabled = false;
    btnCancel.textContent = 'Durdur';
    ilerlemeCiz(0, 0, 0);

    const yazilanAdlar = [];
    const sarmalanmisParcaAc = async no => {
      const w = await parcaAc(no);
      yazilanAdlar.push(w.ad);
      return w;
    };

    const basladi = performance.now();
    try {
      const sonuc = await SplitEngine.bol(secilenDosya, {
        satirSiniri,
        baytSiniri,
        kaynakAyrac: inceleme.ayrac,
        hedefAyrac: outputFormat.value === 'xlsx' ? null : cikisAyraci(),
        parcaTavani: PARCA_TAVANI,
        parcaAc: sarmalanmisParcaAc,
        iptalMi: () => iptalIstendi,
        onIlerleme: d => {
          ilerlemeCiz(
            d.toplamBayt ? Math.round((d.okunanBayt / d.toplamBayt) * 100) : 100,
            d.satir, d.parca
          );
        }
      });

      const saniye = ((performance.now() - basladi) / 1000).toFixed(1);
      ilerlemeCiz(sonuc.iptal ? null : 100, sonuc.toplamSatir, sonuc.parcaSayisi);
      sonucuGoster(sonuc, yazilanAdlar, saniye);

    } catch (err) {
      console.error(err);
      hata(runError, 'Bölme sırasında hata: ' + err.message, runErrorTx);
    } finally {
      calisiyor = false;
      btnRun.disabled = false;
      btnBack.disabled = false;
      btnCancel.hidden = true;
    }
  }

  function ilerlemeCiz(yuzde, satir, parca) {
    if (yuzde !== null) {
      loadingProg.style.width = yuzde + '%';
      loadingBar.setAttribute('aria-valuenow', String(yuzde));
    }
    const parcalar = [];
    if (yuzde !== null) parcalar.push('%' + yuzde);
    if (satir) parcalar.push(sayi(satir) + ' satır okundu');
    if (parca) parcalar.push(sayi(parca) + ' parça');
    progressText.textContent = parcalar.join(' · ');
  }

  function sonucuGoster(sonuc, adlar, saniye) {
    resultCard.hidden = false;

    if (sonuc.basliksizMi) {
      resultBadge.textContent = 'boş dosya';
      resultList.innerHTML = '<p class="card-note">Dosyada satır bulunamadı.</p>';
      return;
    }

    const yarim = sonuc.iptal || sonuc.tavanaTakildi;
    resultBadge.textContent = sonuc.tavanaTakildi ? 'tavana takıldı' : (sonuc.iptal ? 'durduruldu' : 'tamamlandı');
    resultBadge.style.background = yarim ? 'var(--warn-soft)' : 'var(--ok-soft)';
    resultBadge.style.color      = yarim ? 'var(--warn)' : 'var(--ok)';

    const ozet = document.createElement('p');
    ozet.className = 'card-note';
    if (sonuc.tavanaTakildi) {
      ozet.textContent = `Parça sayısı ${sayi(PARCA_TAVANI)} tavanına ulaştığı için durduruldu — dosyanın tamamı bölünmedi. `
        + `O ana kadar ${sayi(sonuc.toplamSatir)} satır yazıldı. Parça başına satır ya da boyutu artırıp tekrar deneyin.`;
    } else if (sonuc.iptal) {
      ozet.textContent = `Durduruldu — o ana kadar ${sayi(sonuc.toplamSatir)} satır, ${sayi(sonuc.parcaSayisi)} parçaya yazıldı. `
        + `Yazılan parçalar eksiksizdir, dosyanın kalanı bölünmedi.`;
    } else {
      ozet.textContent = `${sayi(sonuc.toplamSatir)} veri satırı ${sayi(sonuc.parcaSayisi)} parçaya bölündü (${saniye} sn). `
        + `Başlık satırı her parçanın başına yazıldı.`;
    }
    resultList.appendChild(ozet);

    // Binlerce parçada listenin tamamını DOM'a basmak sayfayı kilitler
    const LISTE_SINIRI = 100;
    const gosterilecek = sonuc.parcalar.slice(0, LISTE_SINIRI);

    gosterilecek.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      row.innerHTML =
        '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-check"/></svg>' +
        `<span class="result-row-name"></span>` +
        `<span class="result-row-meta">${sayi(p.satir)} satır · ${boyut(p.bayt)}</span>`;
      row.querySelector('.result-row-name').textContent = adlar[i] || ('parça ' + p.no);
      resultList.appendChild(row);
    });

    const kalan = sonuc.parcalar.length - gosterilecek.length;
    if (kalan > 0) {
      const not = document.createElement('p');
      not.className = 'card-note';
      not.style.marginTop = '8px';
      not.textContent = `… ve ${sayi(kalan)} parça daha listelenmedi.`;
      resultList.appendChild(not);
    }

    if (!yarim) toast(`${sayi(sonuc.parcaSayisi)} parça yazıldı.`);
  }

})();
