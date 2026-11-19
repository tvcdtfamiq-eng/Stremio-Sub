const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');

const PORT = process.env.PORT || 7000;
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const OPENSUBS = 'https://opensubtitles-v3.strem.io/subtitles';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const manifest = {
  id: 'org.personal.traductor-es-latam',
  version: '1.0.1',
  name: 'Traductor ES Latam',
  description: 'Traduce al momento los subtítulos al español (Google Translate)',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const builder = new addonBuilder(manifest);
const cache = new Map(); // "type:id" -> Promise<string>

function getTranslated(type, id) {
  const key = `${type}:${id}`;
  if (!cache.has(key)) {
    const p = buildTranslatedSrt(type, id).catch((e) => {
      cache.delete(key); // permite reintentar si falló
      throw e;
    });
    cache.set(key, p);
  }
  return cache.get(key);
}

builder.defineSubtitlesHandler(async ({ type, id }) => {
  getTranslated(type, id).catch(() => {}); // empieza a traducir ya
  return {
    subtitles: [{
      id: 'trad-' + id,
      lang: 'spa',
      url: `${BASE_URL}/sub/${type}/${encodeURIComponent(id)}.srt`
    }]
  };
});

async function buildTranslatedSrt(type, id) {
  // 0) Probar que Google responde antes de gastar tiempo
  const probe = await translate('Hello, how are you?', 1);
  if (probe === null) {
    throw new Error('Google no responde desde este servidor. Error: ' + lastError);
  }

  // 1) Subtítulo original en inglés
  const r = await fetch(`${OPENSUBS}/${type}/${encodeURIComponent(id)}.json`, { signal: AbortSignal.timeout(15000) });
  const data = await r.json();
  const eng = (data.subtitles || []).find((s) => s.lang === 'eng');
  if (!eng) throw new Error('No hay subtítulo en inglés para ' + id);
  const srt = await (await fetch(eng.url, { signal: AbortSignal.timeout(20000) })).text();

  // 2) Parsear SRT
  const cues = srt
    .replace(/\r/g, '')
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n');
      const timeIdx = lines.findIndex((l) => l.includes('-->'));
      if (timeIdx === -1) return null;
      return {
        time: lines[timeIdx],
        text: lines.slice(timeIdx + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      };
    })
    .filter(Boolean);

  // 3) Traducir en grupos de 30 líneas
  const out = new Array(cues.length).fill('');
  const groups = [];
  for (let i = 0; i < cues.length; i += 30) groups.push(i);
  let gi = 0;
  let failed = 0;

  async function worker() {
    while (gi < groups.length) {
      const start = groups[gi++];
      const slice = cues.slice(start, start + 30);
      const texts = slice.map((c) => c.text);
      let res = await translateBatch(texts);
      if (!res) {
        // fallback: una por una
        res = [];
        for (const t of texts) {
          if (!t) { res.push(''); continue; }
          const tr = await translate(t, 1);
          if (tr === null) { failed++; res.push(t); } else res.push(tr);
        }
      }
      res.forEach((t, k) => { out[start + k] = t; });
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));

  if (failed > cues.length * 0.2) {
    throw new Error(`Google tradujo mal (${failed}/${cues.length} fallaron). Error: ${lastError}`);
  }

  // 4) Rearmar SRT
  return cues.map((c, i) => `${i + 1}\n${c.time}\n${out[i]}\n`).join('\n');
}

// ---------- Google Translate (endpoints gratuitos no oficiales) ----------
let lastError = '';

function parseGoogle(json) {
  if (Array.isArray(json[0]) && Array.isArray(json[0][0])) return json[0].map((x) => x[0]).join(''); // gtx
  if (Array.isArray(json[0])) return json[0][0];                                                      // clients5
  return json[0];
}

async function translate(text, tries = 2) {
  const q = encodeURIComponent(text);
  const urls = [
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${q}`,
    `https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${q}`,
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=es&q=${q}`
  ];
  for (let t = 0; t < tries; t++) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' en ' + new URL(url).host);
        const out = parseGoogle(await res.json());
        if (typeof out === 'string' && out.length) return latam(out);
        throw new Error('respuesta vacía');
      } catch (e) {
        lastError = e.message;
      }
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

// Traduce varias líneas en un solo pedido; devuelve null si no se puede separar bien
async function translateBatch(texts) {
  if (texts.every((t) => !t)) return texts.map(() => '');
  try {
    const res = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ q: texts.join('\n') }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const full = parseGoogle(await res.json());
    const parts = full.split('\n');
    if (parts.length !== texts.length) throw new Error('lote desalineado');
    return parts.map(latam);
  } catch (e) {
    lastError = e.message;
    return null;
  }
}

// Ajustes mínimos a español latino
function latam(s) {
  return s.replace(/\bvosotros\b/gi, 'ustedes').replace(/\bvosotras\b/gi, 'ustedes');
}

const app = express();

// Prueba rápida: abrí /test en el navegador
app.get('/test', async (req, res) => {
  const t0 = Date.now();
  const r = await translate('Hello, how are you today?', 1);
  res.type('text/plain; charset=utf-8').send(
    r !== null
      ? `OK (${Date.now() - t0} ms): ${r}`
      : `FALLÓ (${Date.now() - t0} ms): ${lastError}`
  );
});

app.get('/sub/:type/:id.srt', async (req, res) => {
  try {
    const srt = await getTranslated(req.params.type, req.params.id);
    res.set('Access-Control-Allow-Origin', '*');
    res.type('text/plain; charset=utf-8').send(srt);
  } catch (e) {
    res.status(500).type('text/plain; charset=utf-8').send(String(e.message));
  }
});

app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => {
  console.log(`Addon listo: ${BASE_URL}/manifest.json`);
});
