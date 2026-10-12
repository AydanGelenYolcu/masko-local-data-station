/**
 * workbench/command-palette.js
 * 
 * Local-First Data & Office Workbench: Global Command Palette (WB-16)
 * 
 * Ctrl + K kısayoluyla çalışan, 5 alandaki (Data, Privacy, Files, PDF, Workflows)
 * tüm araç ve işlem komutlarını anında filtreleyen klavye odaklı hızlı erişim paleti.
 * 
 * %100 İstemci Tarafı, Sıfır Dış Bağımlılık.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CommandPalette = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 5 Tematik Alan Komut Dizini
  const COMMANDS = [
    // 1. DATA ALANI
    { id: 'data-profile', domain: 'Data', title: 'Data Profiler & Health Check', desc: 'Dosyayı analiz et, sütun metriklerini ve sağlık alarmlarını çıkar', keywords: ['profil', 'sağlık', 'metrik', 'leading zero', 'analiz', 'health'] },
    { id: 'data-validator', domain: 'Data', title: 'Data Quality Validator', desc: 'Excel dosyasına test yaz (Zorunlu, unique, regex, sayı aralığı)', keywords: ['test', 'kural', 'doğrula', 'validator', 'kalite', 'temiz veri'] },
    { id: 'data-sql', domain: 'Data', title: 'Local SQL Studio & Query Builder', desc: 'Dosyaları sunucusuz SQL ile sorgula, JOIN et, filtrele', keywords: ['sql', 'join', 'anti-join', 'group by', 'sorgu', 'select', 'duckdb'] },
    { id: 'data-schema', domain: 'Data', title: 'Schema Mapper & Canonical Profiles', desc: 'Değişen sütun isimlerini standart şemaya eşle', keywords: ['şema', 'schema', 'eşle', 'alias', 'sütun adı', 'canonical'] },
    { id: 'data-unpivot', domain: 'Data', title: 'Unpivot (Genişten Uzuna Dönüştürücü)', desc: 'Çapraz raporları düz ilişkisel tablolara çevir', keywords: ['unpivot', 'melt', 'çapraz tablo', 'düz tablo'] },
    { id: 'data-diff', domain: 'Data', title: 'Tabular Diff (Tablo Karşılaştırıcı)', desc: 'İki dosya arasındaki farkları hücre hücre bul', keywords: ['diff', 'karşılaştır', 'fark', 'eklenen', 'silinen'] },
    { id: 'data-fuzzy', domain: 'Data', title: 'Bulanık Eşleme (Fuzzy VLOOKUP)', desc: 'Şirket adı ve cari unvanı yazım hatalarıyla eşle', keywords: ['fuzzy', 'bulanık', 'vlookup', 'düşeyara', 'jaro-winkler'] },

    // 2. PRIVACY ALANI
    { id: 'privacy-detect', domain: 'Privacy', title: 'Hassas Veri Taraması (PII Scanner)', desc: 'E-posta, telefon, TCKN, IBAN verilerini tespit et', keywords: ['pii', 'kvkk', 'tckn', 'iban', 'telefon', 'tara'] },
    { id: 'privacy-join-mask', domain: 'Privacy', title: 'Join-Preserving Deterministik Maskeleme', desc: 'Dosyalar arası JOIN ilişkisini koruyarak maskele', keywords: ['deterministik', 'join-preserving', 'ilişki koruma', 'tuz'] },
    { id: 'privacy-date-shift', domain: 'Privacy', title: 'Deterministik Tarih Kaydırma (Date Shift)', desc: 'Olaylar arasındaki gün farklarını koruyarak tarihleri gizle', keywords: ['tarih kaydır', 'date shift', 'tarih gizle', 'gün farkı'] },
    { id: 'privacy-safe-share', domain: 'Privacy', title: 'Safe Share Scanner (Paylaşım Öncesi Denetim)', desc: 'Gizli sayfalar, yorumlar ve kalan PII için güvenlik taraması', keywords: ['safe share', 'uçuş öncesi', 'gizli sayfa', 'metaveri', 'güvenli paylaş'] },
    // Kasa yalnız parola girilirse şifrelenir (AES-256-GCM); açıklama bunu gizlememeli.
    { id: 'privacy-vault', domain: 'Privacy', title: 'Gizlilik Kasası (Mask Vault)', desc: 'Takma ad ↔ gerçek değer eşlemesini ayrı dosyaya indir; parolayla şifrele, sonra tabloyu kasadan geri aç', keywords: ['kasa', 'vault', 'sözlük', 'anahtar', 'geri aç', 'parola'] },

    // 3. FILES ALANI
    { id: 'files-append', domain: 'Files', title: 'Çoklu Dosya Birleştirme (Multi-File Append)', desc: '12 aylık dosyaları şema doğrulamasıyla tek tabloda birleştir', keywords: ['birleştir', 'append', 'konsolide', 'çoklu dosya'] },
    { id: 'files-split', domain: 'Files', title: 'Sütun Değerine Göre Dosya Bölme', desc: 'Tek Excel tablosunu seçilen sütuna göre dosyalara böl', keywords: ['böl', 'split', 'ayır', 'bölge'] },
    { id: 'files-csv-rescue', domain: 'Files', title: 'CSV Rescue Mode & Tamir İstasyonu', desc: 'Bozuk CSV ayraçlarını, tırnak hatalarını onar, Excel-safe yap', keywords: ['csv', 'tamir', 'rescue', 'ayraç', 'bozuk satır', 'bom'] },
    { id: 'files-deep-inspector', domain: 'Files', title: 'Workbook Deep Inspector', desc: 'Excel dosyasındaki gizli sayfaları, şişkinlikleri ve formül hatalarını tara', keywords: ['röntgen', 'inspector', 'şişkinlik', 'formül hatası', 'ref!'] },
    { id: 'files-trim-tail', domain: 'Files', title: 'Excel Şişkinlik & Formül Kırıcı (Tail Cleaner)', desc: 'Boş biçimlendirilmiş satırları (used-range tail) kırp, formülleri statik değere çevir', keywords: ['kırp', 'şişkinlik', 'used-range', 'tail', 'boş satır', 'formül kır'] },
    { id: 'files-json-flatten', domain: 'Files', title: 'JSON Flatten (İç İçe JSON Düzleştirici)', desc: 'Çok katmanlı nested JSON nesnelerini noktalı başlıklarla düz tabloya dönüştür', keywords: ['json', 'flatten', 'düzleştir', 'iç içe', 'nested', 'api'] },
    { id: 'files-clipboard', domain: 'Files', title: 'Clipboard Workbench (Pano Verisi İşleme)', desc: 'Kopyalanan tabloyu yapıştır, yerinde temizle ve panoya geri al', keywords: ['pano', 'clipboard', 'kopyala', 'yapıştır', 'ctrl+c'] },
    { id: 'files-synthetic', domain: 'Files', title: 'Şemadan Sentetik Test Verisi Üretici', desc: 'Gerçek veriyi ifşa etmeden aynı yapıda sahte test verisi üret', keywords: ['sentetik', 'dummy', 'sahte veri', 'test verisi'] },
    { id: 'files-encoding', domain: 'Files', title: 'Bozuk Karakter & Encoding Kurtarıcı', desc: 'SAP/Mikro/Logo Türkçe karakter bozulmalarını UTF-8 BOM yap', keywords: ['mojibake', 'encoding', 'windows-1254', 'türkçe karakter'] },

    // 4. PDF ALANI
    { id: 'pdf-suite', domain: 'PDF', title: 'Güvenli PDF İstasyonu (Merge/Split/Rotate)', desc: 'Yerel ve çevrimdışı PDF birleştir, böl, sayfaları döndür', keywords: ['pdf', 'merge', 'split', 'döndür', 'sayfa çıkar'] },
    { id: 'pdf-redact', domain: 'PDF', title: 'PDF Search & Permanent Redact', desc: 'Henüz uygulanmadı — kalıcı karartma (burn-in) planlanıyor', keywords: ['karart', 'redact', 'yak', 'kalıcı', 'siyah bant'] },
    { id: 'pdf-blank', domain: 'PDF', title: 'PDF Boş Sayfa Tespiti (Blank Page Detector)', desc: 'Taranmış belgelerdeki boş sayfaları tespit edip çıkar', keywords: ['boş sayfa', 'blank page', 'beyaz sayfa', 'temizle'] },
    { id: 'pdf-diff', domain: 'PDF', title: 'PDF Karşılaştırıcı & Metaveri Temizliği', desc: 'İki PDF sürümünün sayfa ve metin farklarını yan yana incele', keywords: ['pdf diff', 'sözleşme karşılaştır', 'metaveri sil'] },

    // 5. WORKFLOWS ALANI
    { id: 'wf-recipe', domain: 'Workflows', title: 'Recipe & Workflow Pipeline Engine', desc: 'Dönüşüm adımlarını birbirine bağla, geri al ve JSON tarif kaydet', keywords: ['tarif', 'recipe', 'pipeline', 'iş akışı', 'zincir', 'undo'] },
    { id: 'wf-manifest', domain: 'Workflows', title: 'Sıfır-PII İcra Manifestosu (Run Manifest)', desc: 'İşlem adımlarının KVKK/GDPR uyum ve denetim özetini (Run Manifest JSON) üret', keywords: ['manifest', 'icra', 'denetim', 'audit', 'run', 'uyum', 'rapor'] },
    { id: 'wf-batch', domain: 'Workflows', title: 'Toplu İşleme Modu (Batch Runner)', desc: 'Bir tarifi klasör veya ZIP içindeki 50 dosyaya tek tıkla uygula', keywords: ['toplu', 'batch', 'zip', 'otomasyon'] }
  ];

  /**
   * Komutları filtreler
   */
  function searchCommands(query) {
    if (!query || !query.trim()) {
      return COMMANDS.slice(0, 10);
    }
    const q = query.trim().toLocaleLowerCase('tr-TR');
    return COMMANDS.filter(cmd => {
      if (cmd.title.toLocaleLowerCase('tr-TR').includes(q)) return true;
      if (cmd.desc.toLocaleLowerCase('tr-TR').includes(q)) return true;
      if (cmd.domain.toLocaleLowerCase('tr-TR').includes(q)) return true;
      return cmd.keywords.some(k => k.toLocaleLowerCase('tr-TR').includes(q));
    });
  }

  return {
    COMMANDS: COMMANDS,
    searchCommands: searchCommands
  };
}));
