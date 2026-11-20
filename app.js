// Arztrechnungen – lokale Web-App. Alle Daten bleiben im Browser-Speicher (IndexedDB) dieses Geräts.
import * as pdfjs from './pdf.min.js';
pdfjs.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';
const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

const VERSION = '1.1';
const THIS_YEAR = new Date().getFullYear();
const STATUS = ['offen', 'bezahlt', 'eingereicht'];

/* ---------- Hilfsfunktionen ---------- */
const eur = v => (v || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dDE = iso => iso ? iso.split('-').reverse().join('.') : '–';
const first = name => (name || '').trim().split(/\s+/)[0] || 'Person';
const slug = s => String(s || '').replace(/Dr\.\s*med\.\s*(dent\.)?\s*/gi, 'Dr-').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss')
  .replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Rechnung';
const fname = i => `${i.date || 'ohne-Datum'}_${i.type === 'rezept' ? 'Rezept_' : ''}${slug(i.doc)}_${(i.amt || 0).toFixed(2).replace('.', ',')}EUR.pdf`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = s => { const v = parseFloat(String(s).replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return isFinite(v) ? v : 0; };
const winAnsi = s => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF€–—„“”‚‘’…•]/g, '?');

/* ---------- Speicher (IndexedDB) ---------- */
const db = await new Promise((res, rej) => {
  const r = indexedDB.open('arztrechnungen', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('files'); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const idb = (store, mode, fn) => new Promise((res, rej) => {
  const tx = db.transaction(store, mode); const st = tx.objectStore(store); const r = fn(st);
  tx.oncomplete = () => res(r?.result); tx.onerror = () => rej(tx.error);
});
const getKV = k => idb('kv', 'readonly', s => s.get(k));
const putKV = (k, v) => idb('kv', 'readwrite', s => s.put(v, k));
const getFile = id => idb('files', 'readonly', s => s.get(id));
const putFile = (id, b) => idb('files', 'readwrite', s => s.put(b, id));
const delFile = id => idb('files', 'readwrite', s => s.delete(id));

let D = (await getKV('state')) || { persons: [], invoices: [], submitted: {}, lastBackup: null, changedSinceBackup: 0 };
const save = () => putKV('state', D);
navigator.storage?.persist?.().catch(() => {});

/* UI-Zustand (wird nicht gespeichert) */
const U = { screen: 'home', year: THIS_YEAR, pid: null, iid: null, draft: null, edit: null, sheet: null, toast: null };

/* ---------- Rechenlogik ---------- */
function stufe(p, Y) {
  let c = p.free;
  for (let y = p.freeAsOf; y < Y; y++) c = D.submitted[p.id + '|' + y] ? 0 : c + 1;
  return c + 1;
}
function calc(p, Y) {
  const inv = D.invoices.filter(i => i.pid === p.id && (i.date || '').startsWith(String(Y)));
  const R = inv.reduce((a, i) => a + i.amt, 0);
  const E = Math.max(0, R - p.sb);
  const s = p.staffel.length ? p.staffel : [1], k = stufe(p, Y), f = n => s[Math.min(n, s.length) - 1] * p.fee;
  const rows = [{ y: 'Dieses Jahr', keep: f(k), after: 0 }];
  for (let j = 1; j <= s.length; j++) rows.push({ y: '+' + j, keep: f(k + j), after: f(j) });
  const V = rows.reduce((a, r) => a + r.keep - r.after, 0);
  const thr = p.sb + V, done = !!D.submitted[p.id + '|' + Y];
  const cls = done ? 'done' : E > V ? 'bad' : R >= thr * 0.8 ? 'warn' : 'ok';
  const label = { done: 'Eingereicht', bad: 'Einreichen lohnt sich', warn: 'Knapp – selbst zahlen', ok: 'Selbst zahlen' }[cls];
  return { inv, R, E, V, thr, k, rows, cls, label, ratio: thr > 0 ? Math.min(1, R / thr) : 1 };
}
const sayLine = c => c.cls === 'done' ? 'Dieses Jahr ist als eingereicht markiert. Die Staffel beginnt im Folgejahr wieder bei Stufe 1.'
  : c.cls === 'bad' ? `Einreichen bringt ${eur(c.E - c.V)} mehr als die Rückerstattung.`
  : `Noch ${eur(c.thr - c.R)} bis Einreichen sich lohnt.`;

/* ---------- Dokumente einlesen ---------- */
async function pdfText(buf) {
  const doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false }).promise;
  const lines = [];
  for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 3);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, r]) => lines.push(r.sort((a, b) => a.x - b.x).map(t => t.s).join(' ').replace(/\s+/g, ' ').trim()));
  }
  return { lines, pages: doc.numPages };
}
async function renderPreview(blob, canvas) {
  try {
    const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer(), isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, (canvas.parentElement.clientWidth * (window.devicePixelRatio || 1)) / vp0.width);
    const vp = page.getViewport({ scale });
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise;
  } catch (e) { canvas.replaceWith(Object.assign(document.createElement('div'), { className: 'sub', textContent: 'Vorschau nicht möglich' })); }
}
async function imageToJpeg(file) {
  const bmp = await createImageBitmap(file);
  const sc = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(b => r(b), 'image/jpeg', 0.82));
}
async function imagesToPdf(jpegs) {
  const pdf = await PDFDocument.create();
  for (const j of jpegs) {
    const img = await pdf.embedJpg(await j.arrayBuffer());
    const A4 = [595.28, 841.89], s = Math.min((A4[0] - 40) / img.width, (A4[1] - 40) / img.height);
    const pg = pdf.addPage(A4);
    pg.drawImage(img, { x: (A4[0] - img.width * s) / 2, y: (A4[1] - img.height * s) / 2, width: img.width * s, height: img.height * s });
  }
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

/* Felder aus Rechnungen und Rezepten erkennen */
const dRe = /(\d{1,2})\s?\.\s?(\d{1,2})\s?\.\s?(\d{2,4})/g;
const isoD = m => { let y = +m[3]; if (y < 100) y += 2000; return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; };
const okDate = d => d >= '2000-01-01' && d <= `${THIS_YEAR + 1}-12-31` && !isNaN(Date.parse(d));
const aRe = /(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2})(?!\d)/g;
const amtsIn = l => [...String(l || '').matchAll(aRe)].map(m => num(m[1])).filter(v => v > 0);
const datesIn = l => [...String(l || '').matchAll(dRe)].map(isoD).filter(okDate);
const fmtAmt = v => v != null && isFinite(v) ? v.toFixed(2).replace('.', ',') : '';
const segOf = (l, re) => (String(l).split(/\s{2,}|\s[·|]\s|;/).find(s => re.test(s)) || l).trim().slice(0, 60);

function isRx(lines) {
  const t = lines.join(' ');
  const hits = [/privatrezept|\brezept\b/i, /\bRp\.?(\s|$)/, /\bPZN\b/i, /apotheke/i, /gesamt-?brutto/i, /name,?\s*vorname/i, /aut[\s-]?idem|noctu/i, /tabletten|kapseln|tropfen|salbe|gel\b|saft|\b\d+\s?(mg|ml|µg|g)\b/i, /abgabe|zuzahlung/i].filter(r => r.test(t)).length;
  const inv = /go[äa]\b|goz\b|rechnungsnummer|rechnungs-?nr|\bziffer\b|steigerungs|faktor/i.test(t);
  const pharm = /apotheke/i.test(t) && /\bPZN\b|rezept|\bRp\.?(\s|$)|gesamt-?brutto/i.test(t);
  return ((hits >= 3 || pharm) && !inv) || hits >= 5;
}

function findPatient(lines, out, rx) {
  const text = lines.join('\n'), low = text.toLowerCase();
  const variants = p => { const parts = p.name.trim().split(/\s+/); const v = [p.name, ...(p.aliases || [])]; if (parts.length > 1) v.push(parts.slice(-1)[0] + ', ' + parts.slice(0, -1).join(' ')); return v.map(x => x.toLowerCase()); };
  const kw = rx ? /(name,?\s*vorname|versicherte|patient)/i : /(patient|behandelte person|versicherte person|leistungsempf|behandlung f|für:)/i;
  const hits = D.persons.filter(p => variants(p).some(v => low.includes(v)));
  const ki = lines.findIndex(l => kw.test(l));
  if (hits.length) {
    let pick = hits[0];
    if (hits.length > 1) {
      const near = ki >= 0 ? (lines[ki] + ' ' + (lines[ki + 1] || '')).toLowerCase() : '';
      pick = hits.find(p => variants(p).some(v => near.includes(v))) || hits[0];
      out.unsure.push('patient');
    }
    out.pid = pick.id; out.patient = pick.name;
    out._pl = lines.findIndex(l => variants(pick).some(v => l.toLowerCase().includes(v)));
    return;
  }
  const clean = n => { n = n.trim().replace(/\s+(geb\S*|geboren|behandlung\S*|datum|rechnung\S*)$/i, ''); if (n.includes(',')) { const [a, b] = n.split(',').map(x => x.trim()); n = b + ' ' + a; } return n; };
  const m = text.match(/(?:patient(?:in)?|behandelte person|versicherte person|leistungsempfänger(?:in)?)\s*[:\-]?\s*(?:herrn?|frau)?\s*([A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]+(?:,?[^\S\n]+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-]+){1,2})/i);
  if (m) { out.patient = clean(m[1]); out._pl = lines.findIndex(l => l.includes(m[1].split(/[\s,]/)[0])); return; }
  if (rx) {
    // Rezept: Feld oben links ("Name, Vorname des Versicherten")
    const nameRe = /([A-ZÄÖÜ][a-zäöüß][A-Za-zÄÖÜäöüß\-]+(?:,?[^\S\n]+[A-ZÄÖÜ][a-zäöüß][A-Za-zÄÖÜäöüß\-]+){1,2})/;
    const stop = /(krankenkasse|kostenträger|privat|rezept|gebühr|apotheke|ärzt|praxis|datum|kasse|versichert|status|betrieb|unfall|noctu|idem|sonstige|vorname|name|straße|str\.|weg|platz|allee|gmbh|pkv|versicherung)/i;
    const cand = ki >= 0 ? [lines[ki].replace(/.*(vorname|versicherte\S*|patient\S*)\s*:?/i, ''), lines[ki + 1], lines[ki + 2]] : [];
    cand.push(...lines.slice(0, 8));
    for (const c of cand) {
      if (!c) continue;
      for (const part of String(c).split(/\s{2,}|\s[|·]\s/)) {
        const mm = part.match(nameRe);
        if (mm && !stop.test(mm[1])) { out.patient = clean(mm[1]); out._pl = lines.indexOf(c); out.unsure.push('patient'); return; }
      }
    }
  }
  out.unsure.push('patient');
}

function parseRx(lines) {
  const text = lines.join('\n'), out = { unsure: [] };
  findPatient(lines, out, true);
  const pl = out._pl ?? -1;
  const skip = (l, i) => /geb\.?|geboren|geburt/i.test(l) || (i === pl && !/datum|abgabe/i.test(l));
  const lineDate = re => { const i = lines.findIndex((l, j) => re.test(l) && !skip(l, j)); return i < 0 ? '' : (datesIn(lines[i])[0] || datesIn(lines[i + 1])[0] || ''); };
  out.date = lineDate(/abgabe|abgegeben|verkauf|quittung|beleg|\bbon\b|\d{1,2}:\d{2}/i);
  out.rxDate = lineDate(/ausstellungsdatum|ausgestellt|verordnungsdatum|\bdatum\b/i);
  const all = lines.flatMap((l, i) => skip(l, i) ? [] : datesIn(l)).sort();
  if (!out.rxDate && all.length) out.rxDate = all[0];
  if (!out.date) { const later = all.filter(d => !out.rxDate || d >= out.rxDate); out.date = later.length ? later[later.length - 1] : out.rxDate || ''; out.unsure.push('date'); }
  // Betrag: Apothekenaufdruck oder Quittung
  const kws = [/gesamt-?brutto|gesamtbetrag|endbetrag|rechnungsbetrag/i, /\bgesamt\b|summe|zu zahlen|zahlbetrag|eigenanteil/i, /\bbar\b|ec-?karte|girocard|kartenzahlung|visa|mastercard/i, /preis|taxe|betrag|\beur\b|€/i];
  for (let k = 0; k < kws.length && out.amt == null; k++) {
    const i = lines.findIndex(l => kws[k].test(l) && (amtsIn(l).length || amtsIn(lines[lines.indexOf(l) + 1]).length));
    if (i >= 0) { const a = amtsIn(lines[i]).length ? amtsIn(lines[i]) : amtsIn(lines[i + 1]); out.amt = a[a.length - 1]; if (k > 1) out.unsure.push('amt'); }
  }
  if (out.amt == null) { const a = amtsIn(text); if (a.length) out.amt = Math.max(...a); out.unsure.push('amt'); }
  const ap = lines.find(l => /apotheke/i.test(l));
  if (ap) out.doc = segOf(ap, /apotheke/i); else out.unsure.push('doc');
  const dr = lines.find(l => /dr\.\s|ärztin|\barzt\b|praxis|facharzt|\bmvz\b/i.test(l) && !/apotheke/i.test(l));
  if (dr) out.prescriber = segOf(dr, /dr\.|ärzt|arzt|praxis|mvz/i);
  const ri = lines.findIndex(l => /^\s*rp\.?(\s|:|$)/i.test(l));
  let med = ri >= 0 ? (lines[ri].replace(/^\s*rp\.?:?\s*/i, '') || lines[ri + 1]) : lines.find(l => /\b\d+\s?(mg|ml|µg|g)\b|\bN[123]\b|tabl|kaps|tropfen|salbe|creme|spray|dragees/i.test(l) && !/apotheke/i.test(l));
  if (med) out.med = String(med).replace(/\bPZN[:\s]*\d+/i, '').trim().slice(0, 60);
  return out;
}

function parse(lines) {
  const text = lines.join('\n'), out = { unsure: [] };
  const dateRe = dRe, iso = isoD, amtRe = aRe;
  findPatient(lines, out, false);

  // Betrag
  const kwAmt = [/gesamtbetrag|rechnungsbetrag|endbetrag/i, /zu zahlen|zahlbetrag|zahlbarer betrag|bitte überweisen/i, /gesamtsumme|summe/i];
  for (const re of kwAmt) {
    const i = lines.findIndex(l => re.test(l) && /\d,\d{2}/.test(l + (lines[lines.indexOf(l) + 1] || '')));
    if (i >= 0) { const ms = [...lines[i].matchAll(amtRe)]; const m = ms.length ? ms : [...(lines[i + 1] || '').matchAll(amtRe)]; if (m.length) { out.amt = num(m[m.length - 1][1]); break; } }
  }
  if (out.amt == null) { const all = amtsIn(text); if (all.length) out.amt = Math.max(...all); out.unsure.push('amt'); }

  // Daten
  const invLine = lines.find(l => /rechnungsdatum|datum der rechnung/i.test(l));
  const im = invLine && [...invLine.matchAll(dateRe)][0];
  if (im) out.invDate = iso(im);
  const bLine = lines.findIndex(l => /behandlungsdatum|behandlungszeitraum|leistungszeitraum|datum der (leistung|behandlung)/i.test(l));
  let bm = bLine >= 0 && ([...lines[bLine].matchAll(dateRe)][0] || [...(lines[bLine + 1] || '').matchAll(dateRe)][0]);
  if (bm) out.date = iso(bm);
  else {
    const ds = lines.filter(l => !/geb\.|geboren|geburtsdatum/i.test(l)).flatMap(datesIn).filter(d => !out.invDate || d <= out.invDate).sort();
    if (ds.length) out.date = ds[0];
    out.unsure.push('date');
  }

  // Arzt / Rechnungssteller
  const head = lines.slice(0, 10);
  const dl = head.find(l => /dr\.|praxis|labor|klinik|zentrum|mvz|radiolog|zahnarzt|ärzt|physio|therap|apothek/i.test(l)) || lines[0];
  if (dl) out.doc = dl.split(/\s[·|]\s/)[0].replace(/\s*[·|,]\s*\d{5}.*$/, '').slice(0, 60).trim();
  if (!dl || dl === lines[0]) out.unsure.push('doc');

  const ib = text.replace(/\n/g, ' ').match(/\bDE\s?\d{2}(?:\s?\d{4}){4}\s?\d{2}\b/);
  if (ib) out.iban = ib[0].replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
  const nr = text.match(/rechnungs?[\s-]*(?:nr|nummer)\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i);
  if (nr) out.nr = nr[1];
  return out;
}

const mkF = (x, type) => ({ type, pid: x.pid || '', patient: x.patient || '', date: x.date || '', invDate: x.invDate || '', rxDate: x.rxDate || '', amt: fmtAmt(x.amt), doc: x.doc || '', prescriber: x.prescriber || '', med: x.med || '', iban: x.iban || '', nr: x.nr || '', st: type === 'rezept' ? 'bezahlt' : 'offen' });
function fieldsFrom(lines, type) {
  if (lines.join('').length <= 40) return { f: mkF({}, type || 'rechnung'), unsure: [] };
  const t = type || (isRx(lines) ? 'rezept' : 'rechnung');
  const x = t === 'rezept' ? parseRx(lines) : parse(lines);
  const f = mkF(x, t);
  if (!f.pid && D.persons.length === 1 && !f.patient) f.pid = D.persons[0].id;
  return { f, unsure: x.unsure };
}

async function ingest(files) {
  const list = [...files]; if (!list.length) return;
  U.screen = 'busy'; U.busyText = 'Dokument wird gelesen …'; render();
  try {
    const old = U.draft?.images || [];
    const pdfs = list.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const imgs = list.filter(f => f.type.startsWith('image/'));
    let blob, lines = [], note = '';
    if (pdfs.length) {
      const buf = await pdfs[0].arrayBuffer();
      blob = new Blob([buf], { type: 'application/pdf' });
      ({ lines } = await pdfText(buf.slice(0)));
      if (lines.join('').length <= 40) { lines = []; note = 'In diesem PDF steckt kein Text (Scan ohne Texterkennung). Nutze „Text einfügen“ unten oder fülle die Felder anhand der Vorschau aus.'; }
    } else {
      const jpegs = [...old, ...(await Promise.all(imgs.map(imageToJpeg)))];
      blob = await imagesToPdf(jpegs);
      U.draft = { ...(U.draft || {}), images: jpegs };
      note = 'Fotos liest die App noch nicht selbst aus. Nutze „Text einfügen“ unten (Live Text) oder fülle die Felder anhand der Vorschau aus.';
    }
    if (old.length && U.draft?.f) U.draft = { ...U.draft, blob, note: U.draft.note };
    else { const r = fieldsFrom(lines); U.draft = { ...(U.draft || {}), blob, note, lines, f: r.f, unsure: r.unsure }; }
    U.screen = 'review';
  } catch (e) { console.error(e); U.screen = 'add'; toast('Das Dokument konnte nicht gelesen werden.'); }
  render();
}

/* ---------- Export: Einreichungs-PDF, ZIP, Backup ---------- */
async function buildSubmission(p, Y) {
  const c = calc(p, Y), inv = [...c.inv].sort((a, b) => a.date.localeCompare(b.date));
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica), bold = await out.embedFont(StandardFonts.HelveticaBold);
  let pg = out.addPage([595.28, 841.89]), y = 790;
  const t = (s, x, sz = 10, f = font, right = false) => { s = winAnsi(s); pg.drawText(s, { x: right ? x - f.widthOfTextAtSize(s, sz) : x, y, size: sz, font: f, color: rgb(0.1, 0.1, 0.1) }); };
  t(`Einreichung ${Y}`, 50, 20, bold); y -= 26;
  t(`Versicherte Person: ${p.name}`, 50, 12); y -= 16;
  if (p.ins) { t(p.ins, 50, 11); y -= 16; }
  t(`${inv.length} Rechnungen · erstellt am ${new Date().toLocaleDateString('de-DE')}`, 50, 10); y -= 30;
  t('Datum', 50, 10, bold); t('Art', 112, 10, bold); t('Rechnungssteller / Apotheke', 160, 10, bold); t('Nr. / Medikament', 375, 10, bold); t('Betrag', 545, 10, bold, true); y -= 6;
  pg.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: rgb(.6, .6, .6) }); y -= 14;
  const failed = [];
  for (const i of inv) {
    if (y < 80) { pg = out.addPage([595.28, 841.89]); y = 790; }
    t(dDE(i.date), 50); t(i.type === 'rezept' ? 'Rezept' : 'Rechnung', 112); t((i.doc || '').slice(0, 36), 160); t((i.type === 'rezept' ? i.med : i.nr || '').slice(0, 28), 375); t(eur(i.amt), 545, 10, font, true); y -= 16;
  }
  y -= 4; pg.drawLine({ start: { x: 50, y: y + 10 }, end: { x: 545, y: y + 10 }, thickness: 0.5, color: rgb(.6, .6, .6) });
  t('Summe', 125, 11, bold); t(eur(c.R), 545, 11, bold, true); y -= 30;
  for (const i of inv) {
    const b = await getFile(i.id); if (!b) { failed.push(i); continue; }
    try {
      const src = await PDFDocument.load(await b.arrayBuffer(), { ignoreEncryption: true });
      (await out.copyPages(src, src.getPageIndices())).forEach(pp => out.addPage(pp));
    } catch (e) { failed.push(i); }
  }
  if (failed.length) { pg = out.getPage(0); y = 60; t('Nicht angehängt (bitte separat einreichen): ' + failed.map(i => `${dDE(i.date)} ${i.doc}`).join('; ').slice(0, 110), 50, 9); }
  return { blob: new Blob([await out.save()], { type: 'application/pdf' }), name: `${Y}_${slug(first(p.name))}_Einreichung.pdf`, failed: failed.length };
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
async function buildZip() {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const seen = new Set();
  for (const i of [...D.invoices].sort((a, b) => a.date.localeCompare(b.date))) {
    const b = await getFile(i.id); if (!b) continue;
    const p = D.persons.find(x => x.id === i.pid);
    let path = `Arztrechnungen/${(i.date || '0000').slice(0, 4)}/${slug(first(p?.name))}/${fname(i)}`;
    while (seen.has(path)) path = path.replace(/\.pdf$/, '_2.pdf'); seen.add(path);
    const data = new Uint8Array(await b.arrayBuffer()), nm = enc.encode(path), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, 0, 2], [12, 0x21, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nm.length, 2], [28, 0, 2]].forEach(([o, v, s]) => s === 4 ? h.setUint32(o, v, true) : h.setUint16(o, v, true));
    parts.push(new Uint8Array(h.buffer), nm, data);
    const c = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, 0, 2], [14, 0x21, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, nm.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, off, 4]].forEach(([o, v, s]) => s === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true));
    central.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + data.length;
  }
  const cs = central.reduce((a, u) => a + u.length, 0), e = new DataView(new ArrayBuffer(22));
  [[0, 0x06054b50, 4], [8, central.length / 2, 2], [10, central.length / 2, 2], [12, cs, 4], [16, off, 4]].forEach(([o, v, s]) => s === 4 ? e.setUint32(o, v, true) : e.setUint16(o, v, true));
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
const toB64 = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(b); });
async function buildBackup() {
  const files = {};
  for (const i of D.invoices) { const b = await getFile(i.id); if (b) files[i.id] = await toB64(b); }
  return new Blob([JSON.stringify({ app: 'arztrechnungen', version: VERSION, exported: new Date().toISOString(), state: D, files })], { type: 'application/json' });
}
async function restoreBackup(file) {
  const j = JSON.parse(await file.text());
  if (j.app !== 'arztrechnungen' || !j.state) throw new Error('kein Backup');
  await idb('files', 'readwrite', s => s.clear());
  for (const [id, b64] of Object.entries(j.files || {})) await putFile(id, new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'application/pdf' }));
  D = j.state; D.lastBackup = j.exported; D.changedSinceBackup = 0; await save();
}
async function deliver(blob, name) {
  const f = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f] }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000); return true;
}

/* ---------- Ansichten ---------- */
const ico = { home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>', folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>' };
const svg = n => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${ico[n]}</svg>`;
const tabs = () => `<nav class="tabs"><button data-act="go" data-v="home" class="${['home', 'person'].includes(U.screen) ? 'on' : ''}">${svg('home')}Übersicht</button>
  <button class="plus" data-act="go" data-v="add" aria-label="Rechnung hinzufügen">+</button>
  <button data-act="go" data-v="files" class="${U.screen === 'files' ? 'on' : ''}">${svg('folder')}Ablage</button></nav>`;
const meter = c => `<div class="meter"><i class="${c.cls}" style="width:${(c.ratio * 100).toFixed(1)}%"></i></div><div class="legend"><span>${eur(c.R)}</span><span>Schwelle ${eur(c.thr)}</span></div>`;
const years = () => [...new Set([THIS_YEAR, ...D.invoices.map(i => +(i.date || '').slice(0, 4)).filter(Boolean)])].sort((a, b) => b - a).slice(0, 3).reverse();
const fld = (id, label, v, type = 'text', unsure = false, extra = '') => `<div class="f"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(v)}" ${extra} class="${unsure ? 'unsure' : ''}">${unsure ? '<div class="hint">Bitte prüfen – nicht sicher erkannt</div>' : ''}</div>`;

const V = {
  busy: () => `<div class="busy"><div class="spin"></div>${esc(U.busyText || 'Bitte warten …')}</div>`,
  home() {
    if (!D.persons.length) return `<div class="top"><h2>Arztrechnungen</h2></div><div class="scroll"><div class="card"><div class="name">Willkommen</div>
      <p>Lege zuerst die versicherten Personen mit ihrem Tarif an, oder scanne direkt eine Rechnung – unbekannte Patienten legst du dabei an.</p>
      <button class="btn" data-act="newperson">Person anlegen</button><button class="btn alt" data-act="go" data-v="add">Rechnung hinzufügen</button></div>
      <p class="sub" style="padding:0 4px">Alle Daten bleiben auf diesem Gerät. Hast du ein Backup? Unter „Ablage“ kannst du es einspielen.</p></div>${tabs()}`;
    const backupDue = D.changedSinceBackup > 0 && (!D.lastBackup || Date.now() - Date.parse(D.lastBackup) > 14 * 864e5);
    const cards = D.persons.map(p => { const c = calc(p, U.year); return `<button class="card" data-act="person" data-v="${p.id}">
      <div class="row"><span class="name">${esc(p.name)}</span><span class="pill ${c.cls}">${c.label}</span></div>
      <div class="sub">${c.inv.length} Rechnungen · BRE-Stufe ${Math.min(c.k, p.staffel.length || 1)}</div>${meter(c)}<div class="say">${sayLine(c)}</div></button>`; }).join('');
    return `<div class="top"><h2>Arztrechnungen</h2><div class="seg">${years().map(y => `<button data-act="year" data-v="${y}" class="${y === U.year ? 'on' : ''}">${y}</button>`).join('')}</div></div>
      <div class="scroll">${backupDue ? `<button class="banner warn" style="border:0;width:100%;text-align:left;font:inherit" data-act="go" data-v="files">${D.changedSinceBackup} Änderungen seit dem letzten Backup. Jetzt sichern →</button>` : ''}${cards}
      <button class="btn alt" data-act="newperson">Person hinzufügen</button></div>${tabs()}`;
  },
  person() {
    const p = D.persons.find(x => x.id === U.pid); if (!p) { U.screen = 'home'; return V.home(); }
    const c = calc(p, U.year), done = !!D.submitted[p.id + '|' + U.year];
    const items = [...c.inv].sort((a, b) => b.date.localeCompare(a.date)).map(i => { const k = STATUS.indexOf(i.st); return `<div class="item"><button class="t" data-act="invoice" data-v="${i.id}" style="border:0;background:none;font:inherit;color:inherit;text-align:left;padding:0;cursor:pointer"><div>${esc(i.doc || 'Ohne Namen')}</div><div class="sub">${i.type === 'rezept' ? 'Rezept · ' + (i.med ? esc(i.med) + ' · ' : '') : ''}${dDE(i.date)}</div></button>
      <span class="amt">${eur(i.amt)}</span><button class="chip ${['warn', 'ok', 'done'][k]}" data-act="status" data-v="${i.id}" aria-label="Status: ${i.st}, antippen zum Ändern">${i.st}</button></div>`; }).join('') || '<div class="empty">Keine Belege in diesem Jahr</div>';
    const tbl = c.rows.map(r => `<tr><td>${r.y}</td><td class="n">${eur(r.keep)}</td><td class="n">${eur(r.after)}</td><td class="n">${eur(r.keep - r.after)}</td></tr>`).join('');
    return `<div class="top"><button class="back" data-act="go" data-v="home">‹ Übersicht</button><div class="seg">${years().map(y => `<button data-act="year" data-v="${y}" class="${y === U.year ? 'on' : ''}">${y}</button>`).join('')}</div></div>
      <div class="scroll"><div class="row" style="margin-bottom:12px"><h2 style="font-size:28px">${esc(p.name)}</h2><span class="pill ${c.cls}">${c.label}</span></div>
      <div class="card"><div class="sub">Rechnungen und Rezepte ${U.year}</div><div class="big">${eur(c.R)}</div>${meter(c)}<div class="say">${sayLine(c)}</div>
      <details style="margin-top:12px"><summary>So wird gerechnet</summary>
      <table><tr><td>Erstattung (Summe − ${eur(p.sb)} Selbstbehalt)</td><td class="n">${eur(c.E)}</td></tr><tr><td>Verlust an Rückerstattung</td><td class="n">${eur(c.V)}</td></tr></table>
      <table><thead><tr><th>Jahr</th><th class="n">ohne</th><th class="n">nach Einr.</th><th class="n">Verlust</th></tr></thead><tbody>${tbl}</tbody></table>
      <p class="sub">Stufe ${c.k} in ${U.year}. Annahme: Folgejahre leistungsfrei, Staffel ${p.staffel.join(' → ')} Monatsbeiträge à ${eur(p.fee)}.</p></details></div>
      <h3>Belege ${U.year}</h3><div class="list">${items}</div>
      <button class="btn ${c.cls === 'bad' ? '' : 'alt'}" data-act="export" ${c.inv.length ? '' : 'disabled'}>Einreichungs-PDF ${U.year} erstellen</button>
      <button class="btn alt" data-act="toggledone">${done ? `Markierung „eingereicht“ für ${U.year} entfernen` : `${U.year} als eingereicht markieren`}</button>
      <h3>Tarif</h3><div class="list"><div class="item"><span class="t">Versicherung</span><span class="sub">${esc(p.ins || '–')}</span></div>
      <div class="item"><span class="t">Monatsbeitrag</span><span class="amt">${eur(p.fee)}</span></div><div class="item"><span class="t">Selbstbehalt / Jahr</span><span class="amt">${eur(p.sb)}</span></div>
      <div class="item"><span class="t">BRE-Staffel</span><span class="amt">${p.staffel.join(' → ')}</span></div></div>
      <button class="btn alt" data-act="editperson">Person und Tarif bearbeiten</button></div>${tabs()}`;
  },
  add: () => `<div class="top"><h2>Beleg erfassen</h2></div><div class="scroll">
    <label class="btn" for="cam">Foto aufnehmen<input id="cam" type="file" accept="image/*" capture="environment" hidden></label>
    <label class="btn alt" for="pick">PDF oder Foto auswählen<input id="pick" type="file" accept="application/pdf,image/*" hidden></label>
    <div class="card sub" style="font-size:14px"><p style="margin-top:0">Für <b>Rechnungen und Rezepte</b>. Die App erkennt die Belegart selbst; du kannst sie beim Prüfen umstellen.</p>
    <p>PDFs mit Text (aus E-Mail, Portal oder einer Scanner-App mit Texterkennung) werden automatisch ausgelesen.</p>
    <p style="margin-bottom:0">Bei Fotos oder Scans ohne Text: Foto in der Fotos-App öffnen, unten rechts auf das Text-Symbol tippen, „Alles auswählen“ › „Kopieren“. Beim Prüfen dann „Text einfügen“ nutzen.</p></div></div>${tabs()}`,
  review() {
    const d = U.draft, f = d.f, un = id => d.unsure.includes(id);
    const known = D.persons.find(p => p.id === f.pid);
    const opts = `<option value="">– bitte wählen –</option>${D.persons.map(p => `<option value="${p.id}" ${p.id === f.pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">Neue Person anlegen …</option>`;
    const dup = D.invoices.find(i => i.id !== U.iid && ((f.nr && i.nr === f.nr) || (i.date === f.date && Math.abs(i.amt - num(f.amt)) < 0.005 && i.pid === f.pid)));
    return `<div class="top"><button class="back" data-act="cancel">‹ ${U.iid ? 'Zurück' : 'Verwerfen'}</button>${U.iid ? '' : '<h2 style="font-size:20px">Prüfen</h2>'}</div><div class="scroll">
      <div class="preview"><canvas id="pv"></canvas>${d.images ? `<label class="btn alt" for="more" style="margin:6px 0 0">Weitere Seite fotografieren<input id="more" type="file" accept="image/*" capture="environment" hidden></label>` : ''}${U.iid ? '<button class="btn alt" data-act="openpdf" style="margin:6px 0 0">PDF öffnen</button>' : ''}</div>
      ${d.note ? `<div class="banner warn">${esc(d.note)}</div>` : ''}${dup ? `<div class="banner warn">Mögliche Dublette: ${esc(dup.doc)} vom ${dDE(dup.date)} über ${eur(dup.amt)} ist schon erfasst.</div>` : ''}
      ${!known && f.patient ? `<div class="banner warn"><b>${esc(f.patient)}</b> ist noch nicht angelegt.<button class="btn" style="margin:10px 0 0" data-act="newfromdraft">Person anlegen</button></div>` : ''}
      <div class="seg" style="margin-bottom:14px" role="group" aria-label="Belegart"><button style="flex:1" data-act="settype" data-v="rechnung" class="${f.type !== 'rezept' ? 'on' : ''}">Rechnung</button><button style="flex:1" data-act="settype" data-v="rezept" class="${f.type === 'rezept' ? 'on' : ''}">Rezept</button></div>
      <div class="f"><label for="pid">Patient${f.patient && known && f.patient !== known.name ? ` (erkannt: ${esc(f.patient)})` : ''}</label><select id="pid" class="${un('patient') ? 'unsure' : ''}">${opts}</select></div>
      ${f.type === 'rezept'
        ? `${fld('date', 'Abgabedatum Apotheke (bestimmt das Jahr)', f.date, 'date', un('date'))}${fld('amt', 'Betrag in €', f.amt, 'text', un('amt'), 'inputmode="decimal"')}
           ${fld('doc', 'Apotheke', f.doc, 'text', un('doc'))}${fld('rxDate', 'Ausstellungsdatum (Arzt)', f.rxDate, 'date')}${fld('prescriber', 'Verordnet von', f.prescriber)}${fld('med', 'Medikament', f.med)}`
        : `${fld('date', 'Behandlungsdatum (bestimmt das Jahr)', f.date, 'date', un('date'))}${fld('amt', 'Betrag in €', f.amt, 'text', un('amt'), 'inputmode="decimal"')}
           ${fld('doc', 'Arzt / Rechnungssteller', f.doc, 'text', un('doc'))}${fld('invDate', 'Rechnungsdatum', f.invDate, 'date')}${fld('nr', 'Rechnungsnummer', f.nr)}${fld('iban', 'IBAN', f.iban)}`}
      <div class="f"><label for="st">Status</label><select id="st">${STATUS.map(s => `<option ${s === f.st ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <button class="btn" data-act="saveinv">Speichern</button>
      <details class="card" ${!d.lines?.length && !U.iid ? 'open' : ''}><summary>Text einfügen (Live Text)</summary>
        <p class="sub">Foto in der Fotos-App öffnen › Text-Symbol unten rechts › „Alles auswählen“ › „Kopieren“. Dann hier einfügen und „Felder füllen“ tippen.</p>
        <div class="f"><label for="paste">Kopierter Text</label><textarea id="paste" rows="6"></textarea></div>
        <button class="btn alt" data-act="clip">Aus Zwischenablage einfügen</button><button class="btn" data-act="pastetext">Felder füllen</button></details>
      ${d.lines?.length ? `<details class="card"><summary>Erkannter Text anzeigen</summary><pre class="raw">${esc(d.lines.join('\n'))}</pre></details>` : ''}
      ${U.iid ? '<button class="btn alt" data-act="shareinv">PDF teilen</button><button class="btn danger" data-act="delinv">Beleg löschen</button>' : ''}</div>`;
  },
  personform() {
    const e = U.edit;
    return `<div class="top"><button class="back" data-act="cancelperson">‹ Abbrechen</button></div><div class="scroll"><h2 style="font-size:28px;margin-bottom:14px">${e.id ? 'Person bearbeiten' : 'Neue Person'}</h2>
      ${fld('pn', 'Name (wie auf den Rechnungen)', e.name)}${fld('pa', 'Weitere Schreibweisen, durch ; getrennt (optional)', (e.aliases || []).join('; '))}
      ${fld('pi', 'Versicherung und Tarif', e.ins)}${fld('pf', 'Monatsbeitrag in €', e.fee, 'text', false, 'inputmode="decimal"')}${fld('ps', 'Selbstbehalt pro Jahr in €', e.sb, 'text', false, 'inputmode="decimal"')}
      ${fld('pst', 'BRE-Staffel: Monatsbeiträge je leistungsfreiem Jahr', e.staffel.join(', '), 'text', false, 'inputmode="numeric"')}
      ${fld('pfr', `Leistungsfreie Jahre in Folge bis Ende ${e.freeAsOf - 1}`, e.free, 'number', false, 'inputmode="numeric" min="0"')}
      <p class="sub" style="margin:-4px 4px 16px">Beispiel Staffel „1, 2, 3“: 1 Monatsbeitrag nach dem 1. Jahr ohne Einreichen, 2 nach dem 2., ab dem 3. Jahr jeweils 3. Die genauen Werte stehen in den Tarifbedingungen.</p>
      <button class="btn" data-act="saveperson">Speichern</button>${e.id ? '<button class="btn danger" data-act="delperson">Person löschen</button>' : ''}</div>`;
  },
  files() {
    const ys = [...new Set(D.invoices.map(i => (i.date || '0000').slice(0, 4)))].sort().reverse();
    const tree = ys.map(y => `<div class="dir">${y}/</div>` + D.persons.map(p => {
      const fs = D.invoices.filter(i => i.pid === p.id && (i.date || '0000').startsWith(y)).sort((a, b) => a.date.localeCompare(b.date));
      return fs.length ? `<div class="dir" style="padding-left:28px;border-top:0">${esc(slug(first(p.name)))}/</div>` + fs.map(i => `<button class="item file" data-act="invoice" data-v="${i.id}" style="border-top:0">${esc(fname(i))}</button>`).join('') : '';
    }).join('')).join('');
    return `<div class="top"><h2>Ablage</h2></div><div class="scroll">
      ${D.invoices.length ? `<div class="list tree"><div class="dir" style="border-top:0">Arztrechnungen/</div>${tree}</div><button class="btn alt" data-act="zip">Alle PDFs als ZIP (mit Ordnern)</button>` : '<div class="empty">Noch keine Rechnungen</div>'}
      <h3>Datensicherung</h3><div class="card"><p style="margin-top:0">Die Daten liegen nur in dieser App auf diesem Gerät. Sichere sie regelmäßig als Datei, z. B. in der Dateien-App.</p>
      <p class="sub">Letztes Backup: ${D.lastBackup ? new Date(D.lastBackup).toLocaleString('de-DE') : 'noch keins'}${D.changedSinceBackup ? ` · ${D.changedSinceBackup} Änderungen seitdem` : ''}</p>
      <button class="btn" data-act="backup">Backup erstellen</button><label class="btn alt" for="restore">Backup einspielen<input id="restore" type="file" accept="application/json,.json" hidden></label></div>
      <p class="sub" style="padding:0 4px">Version ${VERSION} · keine Verbindung zu Servern, keine Cloud.</p></div>${tabs()}`;
  }
};

/* ---------- Darstellung ---------- */
const app = document.getElementById('app');
function render() {
  let h = V[U.screen]();
  if (U.sheet) h += `<div class="sheetbg" data-act="sheetbg"><div class="sheet" role="dialog" aria-modal="true">${U.sheet.html}</div></div>`;
  if (U.toast) h += `<div class="toast" role="status">${U.toast}</div>`;
  app.innerHTML = h;
  const pv = app.querySelector('#pv'); if (pv && U.draft?.blob) renderPreview(U.draft.blob, pv);
}
let tt;
function toast(m) { U.toast = m; render(); clearTimeout(tt); tt = setTimeout(() => { U.toast = null; render(); }, 3500); }
function go(s) { U.screen = s; U.sheet = null; render(); app.querySelector('.scroll')?.scrollTo(0, 0); }
const changed = async () => { D.changedSinceBackup = (D.changedSinceBackup || 0) + 1; await save(); };
const val = id => app.querySelector('#' + id)?.value ?? '';
function readDraft() {
  if (!U.draft || !app.querySelector('#date')) return;
  U.draft.f.pid = val('pid') === '__new' ? '' : val('pid');
  for (const k of ['date', 'amt', 'doc', 'invDate', 'nr', 'iban', 'st', 'rxDate', 'prescriber', 'med']) if (app.querySelector('#' + k)) U.draft.f[k] = val(k);
}
function applyLines(lines, type) {
  const keepPid = U.draft.f.pid, keepSt = U.draft.f.st;
  const r = fieldsFrom(lines, type);
  if (!r.f.pid && keepPid && !r.f.patient) r.f.pid = keepPid;
  if (U.iid) r.f.st = keepSt;
  U.draft.f = r.f; U.draft.unsure = r.unsure; U.draft.lines = lines;
}
function confirmSheet(text, label, fn) { U.sheet = { html: `<h4>${text}</h4><p class="sub">Das lässt sich nicht rückgängig machen.</p><button class="btn danger" data-act="confirm">${label}</button><button class="btn alt" data-act="closesheet">Abbrechen</button>`, fn }; render(); }
function readySheet(title, sub, blob, name, after) { U.sheet = { html: `<h4>${esc(title)}</h4><p class="sub">${sub}</p><button class="btn" data-act="deliver">Teilen oder in „Dateien“ sichern</button>${after ? `<button class="btn alt" data-act="sheetafter">${after.label}</button>` : ''}<button class="btn alt" data-act="closesheet">Schließen</button>`, blob, name, after }; render(); }
const newPerson = name => ({ id: '', name: name || '', aliases: [], ins: '', fee: '', sb: '', staffel: [1, 2, 3], free: 0, freeAsOf: THIS_YEAR });

app.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, v = b.dataset.v;
  if (a === 'sheetbg' && ev.target !== b) return;
  switch (a) {
    case 'go': if (v === 'add') { U.draft = null; U.iid = null; } go(v); break;
    case 'year': U.year = +v; render(); break;
    case 'person': U.pid = v; go('person'); break;
    case 'status': { const i = D.invoices.find(x => x.id === v); i.st = STATUS[(STATUS.indexOf(i.st) + 1) % 3]; await changed(); render(); break; }
    case 'invoice': { const i = D.invoices.find(x => x.id === v); U.iid = v; U.pid = i.pid; U.draft = { blob: await getFile(v), f: { type: 'rechnung', rxDate: '', prescriber: '', med: '', ...i, amt: i.amt.toFixed(2).replace('.', ','), patient: '' }, unsure: [], note: '' }; go('review'); break; }
    case 'cancel': { const back = U.iid ? (U.from === 'files' ? 'files' : 'person') : 'add'; U.draft = null; U.iid = null; go(back); break; }
    case 'newfromdraft': readDraft(); U.edit = newPerson(U.draft.f.patient); U.edit.back = 'review'; go('personform'); break;
    case 'newperson': U.edit = newPerson(''); U.edit.back = 'home'; go('personform'); break;
    case 'editperson': { const p = D.persons.find(x => x.id === U.pid); U.edit = { ...p, back: 'person' }; go('personform'); break; }
    case 'cancelperson': go(U.edit.back); break;
    case 'saveperson': {
      const name = val('pn').trim(); if (!name) { toast('Bitte einen Namen eingeben.'); break; }
      const st = val('pst').split(/[,;\s]+/).map(Number).filter(n => n > 0);
      const p = { id: U.edit.id || uid(), name, aliases: val('pa').split(';').map(s => s.trim()).filter(Boolean), ins: val('pi').trim(), fee: num(val('pf')), sb: num(val('ps')), staffel: st.length ? st : [1], free: Math.max(0, parseInt(val('pfr')) || 0), freeAsOf: U.edit.freeAsOf || THIS_YEAR };
      const ix = D.persons.findIndex(x => x.id === p.id); if (ix >= 0) D.persons[ix] = p; else D.persons.push(p);
      await changed();
      if (U.edit.back === 'review') { U.draft.f.pid = p.id; U.draft.unsure = U.draft.unsure.filter(x => x !== 'patient'); }
      U.pid = p.id; const back = U.edit.back === 'home' ? 'person' : U.edit.back; U.edit = null; go(back); toast(`${esc(name)} gespeichert`); break;
    }
    case 'delperson': confirmSheet(`${esc(U.edit.name)} und alle Rechnungen löschen?`, 'Löschen', async () => {
      for (const i of D.invoices.filter(x => x.pid === U.edit.id)) await delFile(i.id);
      D.invoices = D.invoices.filter(x => x.pid !== U.edit.id); D.persons = D.persons.filter(x => x.id !== U.edit.id); await changed(); U.edit = null; go('home');
    }); break;
    case 'saveinv': {
      readDraft(); const f = U.draft.f;
      if (!f.pid) { toast('Bitte einen Patienten wählen oder anlegen.'); break; }
      if (!f.date) { toast('Bitte das Behandlungsdatum eintragen.'); break; }
      const p = D.persons.find(x => x.id === f.pid), Y = +f.date.slice(0, 4), before = calc(p, Y).cls;
      const inv = { id: U.iid || uid(), type: f.type || 'rechnung', rxDate: f.rxDate || '', prescriber: (f.prescriber || '').trim(), med: (f.med || '').trim(), pid: f.pid, date: f.date, invDate: f.invDate, amt: Math.abs(num(f.amt)), doc: f.doc.trim() || 'Unbekannt', iban: f.iban.trim(), nr: f.nr.trim(), st: f.st || 'offen' };
      if (!U.iid) await putFile(inv.id, U.draft.blob);
      const ix = D.invoices.findIndex(x => x.id === inv.id); if (ix >= 0) D.invoices[ix] = inv; else D.invoices.push(inv);
      await changed();
      const after = calc(p, Y).cls; U.year = Y; U.pid = p.id; U.draft = null; U.iid = null; go('person');
      toast(after === 'bad' && before !== 'bad' ? `<b>Ab jetzt lohnt sich Einreichen für ${esc(p.name)}.</b>` : `Gespeichert: ${esc(fname(inv))}`); break;
    }
    case 'openpdf': { const u = URL.createObjectURL(U.draft.blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60000); break; }
    case 'shareinv': { const i = D.invoices.find(x => x.id === U.iid); await deliver(U.draft.blob, fname(i)); break; }
    case 'delinv': confirmSheet('Diese Rechnung löschen?', 'Löschen', async () => {
      await delFile(U.iid); D.invoices = D.invoices.filter(x => x.id !== U.iid); await changed(); U.iid = null; U.draft = null; go('person');
    }); break;
    case 'settype': {
      readDraft(); if (U.draft.f.type === v) break;
      if (U.draft.lines?.length) applyLines(U.draft.lines, v);
      else { U.draft.f.type = v; if (!U.iid) U.draft.f.st = v === 'rezept' ? 'bezahlt' : 'offen'; }
      render(); break;
    }
    case 'clip': {
      try { const t = await navigator.clipboard.readText(); app.querySelector('#paste').value = t; if (!t) toast('Die Zwischenablage ist leer.'); }
      catch (e) { toast('Bitte lange in das Textfeld tippen und „Einsetzen“ wählen.'); }
      break;
    }
    case 'pastetext': {
      const t = val('paste'); readDraft();
      const lines = t.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (lines.join('').length < 15) { toast('Bitte zuerst den kopierten Text einfügen.'); break; }
      applyLines(lines, isRx(lines) ? 'rezept' : U.draft.f.type);
      U.draft.note = ''; render(); toast('Felder aus dem Text gefüllt – bitte prüfen.'); break;
    }
    case 'confirm': { const fn = U.sheet.fn; U.sheet = null; await fn(); break; }
    case 'closesheet': case 'sheetbg': U.sheet = null; render(); break;
    case 'toggledone': { const k = U.pid + '|' + U.year; if (D.submitted[k]) delete D.submitted[k]; else D.submitted[k] = true; await changed(); render(); break; }
    case 'export': {
      const p = D.persons.find(x => x.id === U.pid), c = calc(p, U.year);
      U.busyText = 'PDF wird erstellt …'; const back = U.screen; U.screen = 'busy'; render();
      try {
        const r = await buildSubmission(p, U.year); U.screen = back;
        readySheet('Einreichungs-PDF ist fertig', `${esc(r.name)} · Deckblatt + ${c.inv.length} Rechnungen · ${eur(c.R)}${r.failed ? ` · ${r.failed} Rechnung(en) konnten nicht angehängt werden` : ''}${c.cls !== 'bad' ? `<br><br><b>Hinweis:</b> Laut Berechnung kostet Einreichen ${eur(c.V - c.E)} mehr, als es bringt.` : ''}`, r.blob, r.name,
          D.submitted[p.id + '|' + U.year] ? null : { label: 'Alle als eingereicht markieren', fn: async () => { D.submitted[p.id + '|' + U.year] = true; c.inv.forEach(i => i.st = 'eingereicht'); await changed(); } });
      } catch (e) { console.error(e); U.screen = back; toast('PDF konnte nicht erstellt werden.'); }
      break;
    }
    case 'deliver': { await deliver(U.sheet.blob, U.sheet.name); if (U.sheet?.isBackup) { D.lastBackup = new Date().toISOString(); D.changedSinceBackup = 0; await save(); } break; }
    case 'sheetafter': { const fn = U.sheet.after.fn; U.sheet = null; await fn(); toast('Erledigt'); break; }
    case 'zip': { U.busyText = 'ZIP wird erstellt …'; U.screen = 'busy'; render(); const z = await buildZip(); U.screen = 'files'; readySheet('ZIP ist fertig', `Arztrechnungen_${new Date().toISOString().slice(0, 10)}.zip · ${(z.size / 1048576).toFixed(1)} MB. In der Dateien-App antippen, dann entsteht der Ordner.`, z, `Arztrechnungen_${new Date().toISOString().slice(0, 10)}.zip`); break; }
    case 'backup': { U.busyText = 'Backup wird erstellt …'; U.screen = 'busy'; render(); const bk = await buildBackup(); U.screen = 'files'; readySheet('Backup ist fertig', `${(bk.size / 1048576).toFixed(1)} MB. Am besten in der Dateien-App sichern, z. B. „Auf meinem iPhone“ oder einem USB-Stick.`, bk, `Arztrechnungen-Backup_${new Date().toISOString().slice(0, 10)}.json`); U.sheet.isBackup = true; break; }
  }
});
app.addEventListener('change', async ev => {
  const t = ev.target;
  if (t.id === 'cam' || t.id === 'pick') { U.draft = null; U.iid = null; await ingest(t.files); }
  else if (t.id === 'more') { readDraft(); await ingest(t.files); }
  else if (t.id === 'pid' && t.value === '__new') { readDraft(); U.edit = newPerson(U.draft.f.patient); U.edit.back = 'review'; go('personform'); }
  else if (t.id === 'restore' && t.files[0]) {
    const file = t.files[0];
    confirmSheet('Backup einspielen und alle aktuellen Daten ersetzen?', 'Einspielen', async () => {
      try { await restoreBackup(file); U.year = THIS_YEAR; go('home'); toast('Backup eingespielt'); } catch (e) { toast('Die Datei ist kein gültiges Backup.'); }
    });
  }
});
// Navigation von der Ablage aus merken
app.addEventListener('click', ev => { const b = ev.target.closest('[data-act="invoice"]'); if (b) U.from = U.screen === 'review' ? U.from : (b.closest('.tree') ? 'files' : 'person'); }, true);

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
