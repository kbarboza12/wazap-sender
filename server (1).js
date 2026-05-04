const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Estado por sesión ─────────────────────────────────────────────────────────
const sesiones = {}; // { sessionId: { client, estado, qr, enviados, fallidos, total } }

function getSesion(id) {
  if (!sesiones[id]) {
    sesiones[id] = { client: null, estado: 'desconectado', qr: null, enviados: 0, fallidos: 0, total: 0, log: [] };
  }
  return sesiones[id];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

function cleanPhone(phone) {
  let p = String(phone).replace(/\D/g, '').replace(/\.0$/, '');
  if (!p || p.length < 8) return null;
  if (p.length === 8) return null;
  if (p.length === 10) p = '54' + p;
  else if (p.length === 11 && !p.startsWith('54')) p = '54' + p;
  return p + '@c.us';
}

function primerNombre(nombre) {
  const partes = String(nombre).trim().split(' ');
  return partes[partes.length - 1] || 'Cliente';
}

const MENSAJES = [
  `Hola {nombre}! 🌸 Soy promotora de *Violetta Cosméticos* y te escribo porque salió el catálogo nuevo 🎉\nHay una línea de *Green Tea* re linda para el cuidado de la piel, maquillaje, fragancias... ¡de todo!\nTe mando el catálogo completo para que lo veas con calma 👀✨\nCualquier cosa que te guste me avisás y te lo consigo 😊`,
  `Hola {nombre}! 💜 ¿Cómo andás?\nTe escribo de *Violetta*, salió el catálogo nuevo con cosas hermosas 😍\nSkincare, maquillaje, perfumes... y con promos de hasta 55% off 🔥\nTe mando el catálogo para que lo veas. Si algo te gusta avisame 🛍️`,
  `Holaa {nombre}! 🌿✨\nSoy de *Violetta Cosméticos* y quería avisarte que tenemos catálogo nuevo 🆕\nEsta campaña la línea de *Green Tea* está buenísima — limpieza, hidratación, todo natural 🍃\nMirá el catálogo que te mando y si querés pedimos juntas 😊💕`,
  `Hola {nombre}! 🎀\n¡Llegó el catálogo nuevo de *Violetta*! 🥳\nHay lanzamientos re copados — skincare, maquillaje Casual, fragancias y mucho más\n¿Hay algo que te interese? ¡Me avisás! 💬✨`,
  `Hola {nombre} 💐 Soy promotora de *Violetta Cosméticos*\nSalió el catálogo C7 con ofertas increíbles 😱\nSkincare, maquillaje, perfumes... ¡todo en un solo lugar!\nTe lo mando para que lo explores 📖 Cualquier consulta acá estoy 🙋‍♀️💜`,
];

function generarMensaje(nombre) {
  const plantilla = MENSAJES[Math.floor(Math.random() * MENSAJES.length)];
  return plantilla.replace(/{nombre}/g, primerNombre(nombre));
}

// ── API: Conectar WhatsApp ────────────────────────────────────────────────────
app.post('/api/conectar', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Falta sessionId' });

  const ses = getSesion(sessionId);
  if (ses.estado === 'listo') return res.json({ ok: true, mensaje: 'Ya conectado' });

  ses.estado = 'conectando';
  ses.qr = null;

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: `./.wa_${sessionId}` }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  });

  client.on('qr', async (qr) => {
    ses.estado = 'qr';
    ses.qr = await qrcode.toDataURL(qr);
  });

  client.on('ready', () => {
    ses.estado = 'listo';
    ses.qr = null;
    console.log(`✅ WA listo para sesión ${sessionId}`);
  });

  client.on('disconnected', () => {
    ses.estado = 'desconectado';
    ses.qr = null;
    ses.client = null;
  });

  client.initialize();
  ses.client = client;

  res.json({ ok: true, mensaje: 'Iniciando conexión...' });
});

// ── API: Estado ───────────────────────────────────────────────────────────────
app.get('/api/estado/:sessionId', (req, res) => {
  const ses = getSesion(req.params.sessionId);
  res.json({
    estado: ses.estado,
    qr: ses.qr,
    enviados: ses.enviados,
    fallidos: ses.fallidos,
    total: ses.total,
    log: ses.log.slice(-20)
  });
});

// ── API: Desconectar ──────────────────────────────────────────────────────────
app.post('/api/desconectar', async (req, res) => {
  const { sessionId } = req.body;
  const ses = getSesion(sessionId);
  if (ses.client) await ses.client.destroy().catch(() => {});
  ses.client = null;
  ses.estado = 'desconectado';
  ses.qr = null;
  res.json({ ok: true });
});

// ── API: Subir Excel y enviar ─────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/enviar', upload.single('excel'), async (req, res) => {
  const { sessionId, mensaje_custom } = req.body;
  const ses = getSesion(sessionId);

  if (ses.estado !== 'listo') return res.status(400).json({ error: 'WhatsApp no conectado' });
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo Excel' });

  // Leer Excel
  let contactos = [];
  try {
    const wb = XLSX.read(req.file.buffer);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);
    contactos = data.map(row => ({
      nombre: row.Nombre || row.nombre || row.NOMBRE || 'Cliente',
      telefono: String(row.Teléfono || row.telefono || row.Celular || row.celular || row.Phone || '').replace(/\.0$/, '')
    }));
  } catch (e) {
    return res.status(400).json({ error: 'Error leyendo Excel: ' + e.message });
  }

  // Clasificar contactos
  const validos = [];
  const invalidos = [];
  for (const c of contactos) {
    const wa = cleanPhone(c.telefono);
    if (wa) validos.push({ ...c, waId: wa });
    else invalidos.push({ ...c, motivo: 'número inválido' });
  }

  ses.enviados = 0;
  ses.fallidos = invalidos.length;
  ses.total = contactos.length;
  ses.log = invalidos.map(c => `❌ ${c.nombre} (${c.telefono}) — ${c.motivo}`);

  res.json({
    ok: true,
    total: contactos.length,
    validos: validos.length,
    invalidos: invalidos.length,
    mensaje: `Iniciando envío de ${validos.length} mensajes...`
  });

  // Enviar en background
  (async () => {
    for (let i = 0; i < validos.length; i++) {
      const c = validos[i];
      try {
        const existe = await ses.client.isRegisteredUser(c.waId);
        if (!existe) {
          ses.fallidos++;
          ses.log.push(`📵 ${c.nombre} (${c.telefono}) — no tiene WhatsApp`);
          continue;
        }
        const msg = mensaje_custom
          ? mensaje_custom.replace(/{nombre}/g, primerNombre(c.nombre))
          : generarMensaje(c.nombre);

        await ses.client.sendMessage(c.waId, msg);
        ses.enviados++;
        ses.log.push(`✅ ${c.nombre} (${c.telefono}) — enviado`);
      } catch (err) {
        ses.fallidos++;
        ses.log.push(`⚠️ ${c.nombre} (${c.telefono}) — error: ${err.message}`);
      }

      if (i < validos.length - 1) {
        // Pausa larga cada 30 mensajes
        if ((i + 1) % 30 === 0) {
          ses.log.push(`⏸️ Pausa entre tandas...`);
          await sleep(randomDelay(90, 150));
        } else {
          await sleep(randomDelay(8, 20));
        }
      }
    }
    ses.log.push(`🎉 Envío finalizado — ${ses.enviados} enviados, ${ses.fallidos} fallidos`);
  })();
});

app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
