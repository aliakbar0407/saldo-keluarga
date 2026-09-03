// Vercel Serverless Function: /api/scan-receipt
// Menerima foto struk (base64), mengirim ke Gemini API (AI vision) untuk dibaca
// secara terstruktur (nama toko, tanggal, total, kategori, rincian item).
// API key Gemini disimpan sebagai Environment Variable di Vercel (GEMINI_API_KEY),
// jadi TIDAK PERNAH terkirim/terlihat di browser pengguna.

const CATS_OUT = ['Belanja Bulanan','Belanja Harian','Pendidikan','Tagihan','Jajan',
  'Kesehatan','Hiburan','Saku Kakak','Saku Adik','Transportasi','Lainnya'];

const RECEIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    readable: { type: 'BOOLEAN', description: 'false jika gambar ini BUKAN struk/nota belanja, atau isinya tidak bisa dibaca sama sekali' },
    merchant: { type: 'STRING', description: 'Nama toko/warung/merchant pada struk. Kosongkan jika tidak terlihat.' },
    date: { type: 'STRING', description: 'Tanggal transaksi format YYYY-MM-DD' },
    total: { type: 'NUMBER', description: 'Total akhir yang dibayar dalam Rupiah, angka murni tanpa simbol/pemisah ribuan' },
    category: { type: 'STRING', enum: CATS_OUT, description: 'Kategori belanja yang paling sesuai dengan isi struk' },
    items: {
      type: 'ARRAY',
      description: 'Rincian barang di struk. Kosongkan array ini jika struk tidak merinci per barang.',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          price: { type: 'NUMBER', description: 'Harga barang ini dalam Rupiah, angka murni' }
        },
        required: ['name', 'price']
      }
    }
  },
  required: ['readable', 'total', 'items']
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method tidak diizinkan' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY belum diatur di Environment Variables Vercel' });
    return;
  }

  const image = req.body && req.body.image;
  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: 'Gambar tidak ditemukan pada request' });
    return;
  }

  const match = image.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
  if (!match) {
    res.status(400).json({ error: 'Format gambar tidak valid' });
    return;
  }
  const mimeType = match[1];
  const base64Data = match[2];

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Kamu membaca foto struk/nota belanja berbahasa Indonesia untuk aplikasi catatan keuangan keluarga.
Ekstrak informasinya dengan teliti dan akurat:
- merchant: nama toko/warung yang tertulis di struk
- date: tanggal transaksi (format YYYY-MM-DD). Jika tidak terlihat jelas di struk, gunakan tanggal hari ini: ${today}
- total: TOTAL AKHIR yang benar-benar dibayar pelanggan (bukan subtotal sebelum diskon/pajak jika ada baris totalnya sendiri), angka Rupiah murni tanpa simbol Rp/titik/koma
- category: pilih SATU kategori yang paling sesuai dari daftar enum yang diberikan, berdasarkan jenis toko/barang
- items: daftar barang beserta harga masing-masing sesuai struk. Kosongkan array ini jika struk tidak merinci per barang (misal hanya ada satu baris total)
- readable: isi false HANYA jika gambar ini jelas BUKAN struk belanja, atau benar-benar tidak bisa dibaca sama sekali (blur total/gelap total)

Balas HANYA JSON sesuai schema, tanpa penjelasan tambahan.`;

  try {
    const model = 'gemini-flash-latest';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    // Batas waktu 50 detik (di bawah maxDuration 60 detik di vercel.json), supaya kalau
    // Gemini lambat, kita yang balas error JSON rapi duluan — bukan Vercel yang matikan
    // paksa function ini dan bikin HP pengguna menunggu tanpa kepastian.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 50000);

    let geminiRes;
    try{
      geminiRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Data } }
            ]
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RECEIPT_SCHEMA,
            temperature: 0.1
          }
        }),
        signal: controller.signal
      });
    }catch(fetchErr){
      if(fetchErr.name === 'AbortError'){
        res.status(504).json({ error: 'AI terlalu lama merespons, coba scan ulang atau isi manual' });
        return;
      }
      throw fetchErr;
    }finally{
      clearTimeout(timeoutId);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => '');
      console.error('Gemini API error:', geminiRes.status, errText);
      res.status(502).json({ error: 'Gagal menghubungi layanan AI, coba lagi sebentar' });
      return;
    }

    const data = await geminiRes.json();
    const text = data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;

    if (!text) {
      const blockReason = data && data.promptFeedback && data.promptFeedback.blockReason;
      res.status(502).json({ error: blockReason ? 'Gambar tidak dapat diproses AI' : 'Respons AI kosong, coba lagi' });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('Gagal parse JSON dari Gemini:', text);
      res.status(502).json({ error: 'Gagal membaca hasil AI, coba lagi' });
      return;
    }

    res.status(200).json({
      readable: parsed.readable !== false,
      merchant: parsed.merchant || null,
      date: parsed.date || today,
      total: Math.round(Number(parsed.total) || 0),
      category: parsed.category || 'Belanja Harian',
      items: Array.isArray(parsed.items) ? parsed.items.map(it => ({
        name: String(it.name || '-'),
        price: Math.round(Number(it.price) || 0)
      })) : []
    });
  } catch (err) {
    console.error('Scan receipt error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server saat membaca struk' });
  }
};
