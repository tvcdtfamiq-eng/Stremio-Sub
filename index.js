const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');

const PORT = process.env.PORT || 7000;
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const OPENSUBS = 'https://opensubtitles-v3.strem.io/subtitles';

const manifest = {
  id: 'org.personal.traductor-es-latam',
  version: '1.0.0',
  name: 'Traductor ES Latam',
  description: 'Traduce al momento los subtítulos al español (Google Translate)',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const builder = new addonBuilder(manifest);

// Cache: id -> Promise<string> (SRT traducido)
const cache = new Map();

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
  getTranslated(type, id).catch(() => {}); // empieza a traducir ya, en segundo plano
  return {
    subtitles: [{
      id: 'trad-' + id,
      lang: 'spa',
      url: `${BASE_URL}/sub/${type}/${encodeURIComponent(id)}.srt`
    }]
  };
});

async function buildTranslatedSrt(type, id) {
  // 1) Buscar el subtítulo original en inglés
  const r = await fetch(`${OPENSUBS}/${type}/${encodeURIComponent(id)}.json`);
  const data = await r.json();
  const eng = (data.subtitles || []).find((s) => s.lang === 'eng');
  if (!eng) throw new Error('No hay subtítulo en inglés para ' + id);

  const srt = await (await fetch(eng.url)).text();

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
        text: lines.slice(timeIdx + 1).join('\n').replace(/<[^>]+>/g, '').trim()
      };
    })
    .filter(Boolean);

  // 3) Traducir con concurrencia limitada
  const out = new Array(cues.length);
  let next = 0;
  async function worker() {
    while (next < cues.length) {
      const i = next++;
      out[i] = cues[i].text ? await translate(cues[i].text) : '';
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));

  // 4) Rearmar SRT
  return cues.map((c, i) => `${i + 1}\n${c.time}\n${out[i]}\n`).join('\n');
}

// Google Translate (endpoint gratuito no oficial). "es" sin región = español neutro/latino.
async function translate(text, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ q: text })
        }
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return latam(json[0].map((s) => s[0]).join(''));
    } catch (e) {
      await new Promise((r) => setTimeout(r, 500 * (t + 1)));
    }
  }
  return text; // si falla, deja el original
}

// Ajustes mínimos a español latino (vosotros -> ustedes)
function latam(s) {
  return s
    .replace(/\bvosotros\b/gi, 'ustedes')
    .replace(/\bvosotras\b/gi, 'ustedes');
}

const app = express();

app.get('/sub/:type/:id.srt', async (req, res) => {
  try {
    const srt = await getTranslated(req.params.type, req.params.id);
    res.set('Access-Control-Allow-Origin', '*');
    res.type('text/plain; charset=utf-8').send(srt);
  } catch (e) {
    res.status(500).send(String(e.message));
  }
});

app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => {
  console.log(`Addon listo: ${BASE_URL}/manifest.json`);
});
