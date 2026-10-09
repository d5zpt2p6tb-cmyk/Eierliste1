/* =====================================================================
 * logic.js – reine Logik der Eierliste
 * ---------------------------------------------------------------------
 * Keine DOM- und keine Datenbank-Zugriffe. Läuft im Browser (window.EierLogic)
 * und in Node (require), damit die Berechnungen automatisch getestet werden
 * können (siehe tests/logic.test.js).
 *
 * Geld wird immer als ganze Cent-Beträge (Integer) gespeichert, damit es keine
 * Rundungsfehler gibt (0,35 € = 35 Cent).
 *
 * Datenmodell
 *   Kunde   { id, name, priceCents, archived, createdAt }
 *   Eintrag { key, week, customerId, eggs, priceCents, paidCents, paidAt }
 *           key  = "<Woche>|<KundenId>"   (z. B. "2026-W41|c_abc123")
 *           week = ISO-Kalenderwoche als "JJJJ-Www" (z. B. "2026-W41")
 *           paidAt = Datum der Zahlung als "JJJJ-MM-TT" oder null
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EierLogic = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  var MAX_EGGS = 99999;

  /* ------------------------------------------------------------------
   * Hilfsfunktionen
   * ------------------------------------------------------------------ */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function utc(y, m, d) { return new Date(Date.UTC(y, m, d)); }
  function clampInt(v, min, max) {
    v = Math.round(Number(v));
    if (!isFinite(v)) v = min;
    return Math.max(min, Math.min(max, v));
  }
  function newId(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function normalizeName(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  /* ------------------------------------------------------------------
   * ISO-8601-Kalenderwochen (Montag = Wochenanfang, KW 1 enthält den 4. Januar)
   * Wochenschlüssel: "2026-W41"
   * ------------------------------------------------------------------ */
  function isoWeekFromYMD(y, m, d) {            // m = 0..11
    var date = utc(y, m, d);
    var dayNum = (date.getUTCDay() + 6) % 7;     // Mo = 0 ... So = 6
    date.setUTCDate(date.getUTCDate() - dayNum + 3);   // Donnerstag dieser Woche
    var isoYear = date.getUTCFullYear();
    var jan4 = utc(isoYear, 0, 4);
    var jan4Day = (jan4.getUTCDay() + 6) % 7;
    var week = 1 + Math.round(((date - jan4) / DAY - 3 + jan4Day) / 7);
    return { year: isoYear, week: week };
  }
  function weekKey(year, week) { return year + '-W' + pad2(week); }
  function weekKeyOfDate(date) {                 // lokales Datum (Date-Objekt)
    var w = isoWeekFromYMD(date.getFullYear(), date.getMonth(), date.getDate());
    return weekKey(w.year, w.week);
  }
  function currentWeekKey(now) { return weekKeyOfDate(now || new Date()); }
  function parseWeekKey(key) {
    var m = /^(\d{4})-W(\d{1,2})$/i.exec(String(key || '').trim());
    if (!m) return null;
    var y = +m[1], w = +m[2];
    if (w < 1 || w > isoWeeksInYear(y)) return null;
    return { year: y, week: w };
  }
  function normalizeWeekKey(key) {
    var p = parseWeekKey(key);
    return p ? weekKey(p.year, p.week) : null;
  }
  function isoWeeksInYear(year) {                // 52 oder 53 (der 28.12. liegt immer in der letzten KW)
    return isoWeekFromYMD(year, 11, 28).week;
  }
  function mondayOf(key) {                       // UTC-Date des Montags dieser Woche
    var p = parseWeekKey(key);
    if (!p) throw new Error('Ungültige Woche: ' + key);
    var jan4 = utc(p.year, 0, 4);
    var jan4Day = (jan4.getUTCDay() + 6) % 7;
    return new Date(jan4.getTime() - jan4Day * DAY + (p.week - 1) * 7 * DAY);
  }
  function addWeeks(key, n) {
    var d = new Date(mondayOf(key).getTime() + n * 7 * DAY);
    var w = isoWeekFromYMD(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return weekKey(w.year, w.week);
  }
  function weeksBack(endKey, count) {            // aufsteigende Liste, endet mit endKey
    var out = [];
    for (var i = count - 1; i >= 0; i--) out.push(addWeeks(endKey, -i));
    return out;
  }
  function fmtUTC(d) { return pad2(d.getUTCDate()) + '.' + pad2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear(); }
  function weekLabel(key) { var p = parseWeekKey(key); return 'KW ' + p.week + '/' + p.year; }
  function weekSpan(key) {                       // "05.10. – 11.10.2026"
    var mon = mondayOf(key), sun = new Date(mon.getTime() + 6 * DAY);
    var a = fmtUTC(mon), b = fmtUTC(sun);
    return mon.getUTCFullYear() === sun.getUTCFullYear() ? a.slice(0, 6) + ' – ' + b : a + ' – ' + b;
  }
  function weekMondayDE(key) { return fmtUTC(mondayOf(key)); }

  /* ------------------------------------------------------------------
   * Datum (Zahlungsdatum)
   * ------------------------------------------------------------------ */
  function todayISO(now) {
    var d = now || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function isoToDE(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
  }
  function dateToISO(s) {                        // "09.10.2026" oder "2026-10-09" -> "2026-10-09" | null
    s = String(s == null ? '' : s).trim();
    var m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
    var y, mo, d;
    if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    else {
      m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m) return null;
      y = +m[1]; mo = +m[2]; d = +m[3];
    }
    var t = utc(y, mo - 1, d);
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }

  /* ------------------------------------------------------------------
   * Geld
   * ------------------------------------------------------------------ */
  // "0,35" | "0.35" | "1.234,50" | "3 €" -> Cent (Integer) oder null bei ungültiger Eingabe
  function parseEuro(input) {
    if (typeof input === 'number') return isFinite(input) && input >= 0 ? Math.round(input * 100) : null;
    var s = String(input == null ? '' : input).replace(/€|eur/gi, '').replace(/\s/g, '');
    if (!s) return null;
    if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');   // deutsches Format
    if (!/^\d*\.?\d*$/.test(s) || s === '.') return null;
    var parts = s.split('.');
    var whole = parts[0] || '0', frac = parts[1] || '';
    var cents = parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
    if (frac.length > 2 && +frac.charAt(2) >= 5) cents += 1;               // kaufmännisch runden
    return cents;
  }
  function formatNumDE(cents) {                  // 123456 -> "1.234,56"
    var neg = cents < 0; cents = Math.abs(Math.round(cents));
    var whole = Math.floor(cents / 100), frac = cents % 100;
    var w = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + w + ',' + pad2(frac);
  }
  function formatEuro(cents) { return formatNumDE(cents) + ' €'; }
  function formatInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function formatDec(n, digits) {                // 12.5 -> "12,5"
    var f = Math.pow(10, digits == null ? 1 : digits);
    return (Math.round(n * f) / f).toString().replace('.', ',');
  }

  /* ------------------------------------------------------------------
   * Einträge
   * ------------------------------------------------------------------ */
  function entryKey(week, customerId) { return week + '|' + customerId; }
  function newEntry(week, customerId, priceCents) {
    return { key: entryKey(week, customerId), week: week, customerId: customerId,
             eggs: 0, priceCents: priceCents, paidCents: 0, paidAt: null };
  }
  function amountOf(e) { return e.eggs * e.priceCents; }
  function paidOf(e) { return Math.min(e.paidCents, amountOf(e)); }   // nie mehr als der Betrag
  function openOf(e) { return amountOf(e) - paidOf(e); }
  // 'leer' (Betrag 0) | 'bezahlt' | 'teil' (Teilzahlung) | 'offen'
  function statusOf(e) {
    var a = amountOf(e);
    if (a <= 0) return 'leer';
    if (e.paidCents >= a) return 'bezahlt';
    if (e.paidCents > 0) return 'teil';
    return 'offen';
  }
  // Ein Eintrag ohne Eier und ohne Zahlung wird nicht gespeichert.
  function isEmptyEntry(e) { return e.eggs <= 0 && e.paidCents <= 0; }

  // Eieranzahl ändern. War der Eintrag vollständig bezahlt, bleibt er bezahlt
  // (Tippfehler korrigieren soll den Status nicht kippen).
  function withEggs(e, eggs) {
    var wasPaid = statusOf(e) === 'bezahlt';
    var n = Object.assign({}, e, { eggs: clampInt(eggs, 0, MAX_EGGS) });
    if (wasPaid) {
      n.paidCents = amountOf(n);
      if (n.paidCents === 0) n.paidAt = null;
    }
    return n;
  }
  // Ein Tipp: offen/teilbezahlt -> bezahlt (Datum = heute), bezahlt -> offen
  function togglePaid(e, today) {
    if (statusOf(e) === 'bezahlt') return Object.assign({}, e, { paidCents: 0, paidAt: null });
    return Object.assign({}, e, { paidCents: amountOf(e), paidAt: today });
  }
  // Detail-Bearbeitung (Eier, Preis, Bezahlt-Betrag, Datum). Zahlungsdatum
  // wird automatisch auf "heute" gesetzt, wenn ein Betrag bezahlt ist und noch kein Datum existiert.
  function applyEdit(e, edit, today) {
    var n = Object.assign({}, e);
    if (edit.eggs != null) n.eggs = clampInt(edit.eggs, 0, MAX_EGGS);
    if (edit.priceCents != null) n.priceCents = clampInt(edit.priceCents, 0, 1000000);
    if (edit.paidCents != null) n.paidCents = clampInt(edit.paidCents, 0, amountOf(n));
    if (n.paidCents > 0) n.paidAt = edit.paidAt || n.paidAt || today;
    else n.paidAt = null;
    return n;
  }

  /* ------------------------------------------------------------------
   * Summen und Auswertungen (entries = Array von Einträgen)
   * ------------------------------------------------------------------ */
  function totals(entries) {
    var t = { eggs: 0, amount: 0, paid: 0, open: 0, count: 0 };
    entries.forEach(function (e) {
      t.eggs += e.eggs; t.amount += amountOf(e); t.paid += paidOf(e); t.open += openOf(e); t.count++;
    });
    return t;
  }
  function weekEntries(entries, week) { return entries.filter(function (e) { return e.week === week; }); }

  // Offener Betrag pro Kunde über alle Wochen, absteigend sortiert
  function openByCustomer(entries) {
    var map = {};
    entries.forEach(function (e) {
      var o = openOf(e);
      if (o <= 0) return;
      var c = map[e.customerId] || (map[e.customerId] = { customerId: e.customerId, open: 0, weeks: [] });
      c.open += o;
      c.weeks.push({ week: e.week, eggs: e.eggs, amount: amountOf(e), open: o, status: statusOf(e), key: e.key });
    });
    var list = Object.keys(map).map(function (k) { return map[k]; });
    list.forEach(function (c) { c.weeks.sort(function (a, b) { return a.week < b.week ? -1 : a.week > b.week ? 1 : 0; }); });
    list.sort(function (a, b) { return b.open - a.open; });
    return list;
  }
  // Alle offenen Wochen eines Kunden als bezahlt markieren -> Liste der geänderten Einträge
  function markAllPaid(entries, customerId, today) {
    return entries.filter(function (e) { return e.customerId === customerId && openOf(e) > 0; })
      .map(function (e) { return Object.assign({}, e, { paidCents: amountOf(e), paidAt: today }); });
  }
  // Preis ändern für noch komplett unbezahlte Einträge -> Liste der geänderten Einträge
  function repriceUnpaid(entries, customerId, priceCents) {
    return entries.filter(function (e) {
      return e.customerId === customerId && e.eggs > 0 && e.paidCents === 0 && e.priceCents !== priceCents;
    }).map(function (e) { return Object.assign({}, e, { priceCents: priceCents }); });
  }

  // Eier/Umsatz pro Woche für die Wochenliste weekKeys (customerId = null -> alle Kunden)
  function series(entries, weekKeys, customerId) {
    var idx = {}, eggs = [], amount = [];
    weekKeys.forEach(function (w, i) { idx[w] = i; eggs.push(0); amount.push(0); });
    entries.forEach(function (e) {
      if (customerId && e.customerId !== customerId) return;
      var i = idx[e.week];
      if (i == null) return;
      eggs[i] += e.eggs; amount[i] += amountOf(e);
    });
    return { eggs: eggs, amount: amount };
  }
  // Kennzahlen aus einer Serie.
  //  avg   = Durchschnitt über Wochen MIT Verkauf (Wochen ohne Eintrag zählen nicht mit)
  //  trend = letzte Woche mit Verkauf gegenüber der Kalenderwoche direkt davor
  function stats(weekKeys, eggs, amount) {
    var total = 0, amt = 0, withData = 0, best = null, lastIdx = -1;
    eggs.forEach(function (v, i) {
      total += v; amt += amount[i];
      if (v > 0) {
        withData++; lastIdx = i;
        if (!best || v > best.eggs) best = { week: weekKeys[i], eggs: v };
      }
    });
    var trend = null;
    if (lastIdx >= 1) {
      var last = eggs[lastIdx], prev = eggs[lastIdx - 1];
      trend = { week: weekKeys[lastIdx], eggs: last, prevWeek: weekKeys[lastIdx - 1], prevEggs: prev,
                diff: last - prev, pct: prev > 0 ? Math.round((last - prev) / prev * 100) : null };
    }
    return { totalEggs: total, totalAmount: amt, weeksWithData: withData,
             avg: withData ? total / withData : 0, best: best, trend: trend };
  }
  // Übersicht pro Kunde (Menge/Durchschnitt im Zeitraum, offener Betrag über ALLE Wochen)
  function customerOverview(entries, customers, weekKeys) {
    var openMap = {};
    openByCustomer(entries).forEach(function (o) { openMap[o.customerId] = o.open; });
    var rows = [];
    customers.forEach(function (c) {
      var s = series(entries, weekKeys, c.id);
      var st = stats(weekKeys, s.eggs, s.amount);
      var open = openMap[c.id] || 0;
      if (st.totalEggs === 0 && open === 0) return;
      rows.push({ customerId: c.id, name: c.name, totalEggs: st.totalEggs, totalAmount: st.totalAmount,
                  avg: st.avg, weeksWithData: st.weeksWithData, open: open });
    });
    rows.sort(function (a, b) { return b.totalEggs - a.totalEggs; });
    return rows;
  }

  /* ------------------------------------------------------------------
   * CSV (Excel-tauglich: Semikolon, Dezimalkomma, UTF-8; BOM setzt die App)
   * ------------------------------------------------------------------ */
  var CSV_HEADER = ['Woche', 'Jahr', 'KW', 'Montag', 'Kunde', 'Eier', 'Preis pro Ei (€)',
                    'Betrag (€)', 'Bezahlt (€)', 'Offen (€)', 'Status', 'Zahlungsdatum'];
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(entries, customers) {
    var names = {};
    customers.forEach(function (c) { names[c.id] = c.name; });
    var sorted = entries.slice().sort(function (a, b) {
      if (a.week !== b.week) return a.week < b.week ? -1 : 1;
      return (names[a.customerId] || '').localeCompare(names[b.customerId] || '', 'de');
    });
    var statusText = { bezahlt: 'bezahlt', teil: 'teilbezahlt', offen: 'offen', leer: '' };
    var lines = [CSV_HEADER.join(';')];
    sorted.forEach(function (e) {
      var p = parseWeekKey(e.week);
      lines.push([
        e.week, p.year, p.week, weekMondayDE(e.week), names[e.customerId] || '(unbekannt)', e.eggs,
        formatNumDE(e.priceCents), formatNumDE(amountOf(e)), formatNumDE(paidOf(e)), formatNumDE(openOf(e)),
        statusText[statusOf(e)], isoToDE(e.paidAt)
      ].map(csvCell).join(';'));
    });
    return lines.join('\r\n') + '\r\n';
  }
  // Zerlegt CSV-Text in Zeilen/Zellen (Trennzeichen wird erkannt: ; Tab ,)
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    var firstLine = text.split(/\r?\n/, 1)[0] || '';
    var delim = ';', best = -1;
    [';', '\t', ','].forEach(function (d) {
      var n = firstLine.split(d).length - 1;
      if (n > best) { best = n; delim = d; }
    });
    var rows = [], row = [], cell = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inQ) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { cell += '"'; i++; } else inQ = false;
        } else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }
  // CSV -> Einträge. Unbekannte Kunden werden als neue Kunden angelegt.
  // Rückgabe: { entries, newCustomers, errors:[{line,msg}], rowCount }
  function fromCSV(text, customers, defaultPriceCents, idGen) {
    idGen = idGen || function () { return newId('c'); };
    var rows = parseCSV(text);
    var result = { entries: [], newCustomers: [], errors: [], rowCount: 0 };
    if (rows.length < 2) { result.errors.push({ line: 1, msg: 'Keine Datenzeilen gefunden.' }); return result; }

    var head = rows[0].map(function (h) { return String(h).toLowerCase().replace(/[^a-zäöüß0-9 ]/g, '').replace(/\s+/g, ' ').trim(); });
    function col(test) { for (var i = 0; i < head.length; i++) if (test(head[i])) return i; return -1; }
    var cCust = col(function (h) { return h === 'kunde'; });
    var cEggs = col(function (h) { return h === 'eier'; });
    var cWeek = col(function (h) { return h === 'woche'; });
    var cYear = col(function (h) { return h === 'jahr'; });
    var cKw = col(function (h) { return h === 'kw'; });
    var cPrice = col(function (h) { return h.indexOf('preis') === 0; });
    var cPaid = col(function (h) { return h.indexOf('bezahlt') === 0 && h.indexOf(' am') < 0; });
    var cStatus = col(function (h) { return h === 'status'; });
    var cPaidAt = col(function (h) { return h === 'zahlungsdatum' || h.indexOf('bezahlt am') === 0; });
    if (cCust < 0 || cEggs < 0 || (cWeek < 0 && (cYear < 0 || cKw < 0))) {
      result.errors.push({ line: 1, msg: 'Spalten fehlen. Benötigt: Kunde, Eier und Woche (oder Jahr + KW).' });
      return result;
    }

    var byName = {};
    customers.forEach(function (c) { byName[c.name.toLowerCase()] = c; });
    var seen = {};

    for (var r = 1; r < rows.length; r++) {
      var row = rows[r], line = r + 1;
      var name = normalizeName(row[cCust]);
      if (!name) { result.errors.push({ line: line, msg: 'Kunde fehlt.' }); continue; }

      var week = cWeek >= 0 ? normalizeWeekKey(row[cWeek]) : null;
      if (!week && cYear >= 0 && cKw >= 0) week = normalizeWeekKey(String(row[cYear]).trim() + '-W' + String(row[cKw]).trim());
      if (!week) { result.errors.push({ line: line, msg: 'Woche ungültig.' }); continue; }

      var eggsStr = String(row[cEggs]).trim();
      if (!/^\d+$/.test(eggsStr)) { result.errors.push({ line: line, msg: 'Eieranzahl ungültig.' }); continue; }
      var eggs = clampInt(eggsStr, 0, MAX_EGGS);
      if (eggs === 0) continue;                                   // leere Zeilen überspringen

      var cust = byName[name.toLowerCase()];
      var price = cPrice >= 0 ? parseEuro(row[cPrice]) : null;
      if (!cust) {
        cust = { id: idGen(), name: name, priceCents: price != null ? price : defaultPriceCents,
                 archived: false, createdAt: new Date().toISOString() };
        byName[name.toLowerCase()] = cust;
        result.newCustomers.push(cust);
      }
      if (price == null) price = cust.priceCents;

      var e = newEntry(week, cust.id, price);
      e.eggs = eggs;
      var amount = amountOf(e), paid = cPaid >= 0 ? parseEuro(row[cPaid]) : null;
      if (paid == null) paid = (cStatus >= 0 && /^bezahlt$/i.test(String(row[cStatus]).trim())) ? amount : 0;
      e.paidCents = Math.min(paid, amount);
      e.paidAt = e.paidCents > 0 && cPaidAt >= 0 ? dateToISO(row[cPaidAt]) : null;

      seen[e.key] = e;                                            // gleiche Woche+Kunde: letzte Zeile gewinnt
      result.rowCount++;
    }
    result.entries = Object.keys(seen).map(function (k) { return seen[k]; });
    return result;
  }

  /* ------------------------------------------------------------------
   * Vollständiges Backup (JSON) prüfen und bereinigen
   * ------------------------------------------------------------------ */
  function normalizeBackup(obj) {
    if (!obj || typeof obj !== 'object' || obj.app !== 'eierliste' || !Array.isArray(obj.customers) || !Array.isArray(obj.entries)) {
      return { ok: false, error: 'Das ist keine Eierliste-Sicherung.' };
    }
    var customers = [], ids = {};
    obj.customers.forEach(function (c) {
      if (!c || !c.id || !normalizeName(c.name) || ids[c.id]) return;
      ids[c.id] = true;
      customers.push({ id: String(c.id), name: normalizeName(c.name), priceCents: clampInt(c.priceCents, 0, 1000000),
                       archived: !!c.archived, createdAt: c.createdAt || new Date().toISOString() });
    });
    var entries = [];
    obj.entries.forEach(function (e) {
      if (!e || !ids[e.customerId] || !normalizeWeekKey(e.week)) return;
      var n = newEntry(normalizeWeekKey(e.week), e.customerId, clampInt(e.priceCents, 0, 1000000));
      n.eggs = clampInt(e.eggs, 0, MAX_EGGS);
      n.paidCents = clampInt(e.paidCents, 0, amountOf(n));
      n.paidAt = n.paidCents > 0 ? dateToISO(e.paidAt) : null;
      if (!isEmptyEntry(n)) entries.push(n);
    });
    var weeks = [];
    (Array.isArray(obj.weeks) ? obj.weeks : []).forEach(function (w) {
      var k = w && normalizeWeekKey(w.week);
      if (k && typeof w.note === 'string' && w.note.trim()) weeks.push({ week: k, note: w.note });
    });
    var photos = [];
    (Array.isArray(obj.photos) ? obj.photos : []).forEach(function (p) {
      var k = p && normalizeWeekKey(p.week);
      if (k && typeof p.data === 'string' && /^data:image\//.test(p.data)) photos.push({ week: k, data: p.data, updatedAt: p.updatedAt || null });
    });
    var s = obj.settings || {};
    return { ok: true, customers: customers, entries: entries, weeks: weeks, photos: photos,
             defaultPriceCents: s.defaultPriceCents != null ? clampInt(s.defaultPriceCents, 0, 1000000) : null,
             exportedAt: obj.exportedAt || null };
  }

  return {
    MAX_EGGS: MAX_EGGS, CSV_HEADER: CSV_HEADER,
    pad2: pad2, clampInt: clampInt, newId: newId, normalizeName: normalizeName,
    isoWeekFromYMD: isoWeekFromYMD, weekKey: weekKey, weekKeyOfDate: weekKeyOfDate, currentWeekKey: currentWeekKey,
    parseWeekKey: parseWeekKey, normalizeWeekKey: normalizeWeekKey, isoWeeksInYear: isoWeeksInYear,
    mondayOf: mondayOf, addWeeks: addWeeks, weeksBack: weeksBack, weekLabel: weekLabel, weekSpan: weekSpan,
    weekMondayDE: weekMondayDE, todayISO: todayISO, isoToDE: isoToDE, dateToISO: dateToISO,
    parseEuro: parseEuro, formatNumDE: formatNumDE, formatEuro: formatEuro, formatInt: formatInt, formatDec: formatDec,
    entryKey: entryKey, newEntry: newEntry, amountOf: amountOf, paidOf: paidOf, openOf: openOf, statusOf: statusOf,
    isEmptyEntry: isEmptyEntry, withEggs: withEggs, togglePaid: togglePaid, applyEdit: applyEdit,
    totals: totals, weekEntries: weekEntries, openByCustomer: openByCustomer, markAllPaid: markAllPaid,
    repriceUnpaid: repriceUnpaid, series: series, stats: stats, customerOverview: customerOverview,
    toCSV: toCSV, parseCSV: parseCSV, fromCSV: fromCSV, normalizeBackup: normalizeBackup
  };
}));
