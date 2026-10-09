/* =====================================================================
 * app.js – Oberfläche der Eierliste
 * ---------------------------------------------------------------------
 * Aufbau
 *   1. Hilfsfunktionen (DOM, Toast, Dialoge)
 *   2. Zustand + Speichern (IndexedDB über db.js)
 *   3. Ansichten: Start, Woche, Offen, Verlauf, Mehr (Kunden, Backup)
 *   4. Foto (verkleinern, Zoom), Export/Import
 *   5. Start der App, Router, Service Worker
 * Alle Berechnungen stehen in logic.js (dort getestet).
 * Texte von Nutzern kommen nie über innerHTML in die Seite (nur textContent).
 * ===================================================================== */
(function () {
  'use strict';

  var L = window.EierLogic, DB = window.EierDB, CH = window.MiniChart;
  var APP_VERSION = '1.0';
  var PALETTE = ['#d99a1c', '#3b8fbd', '#8d6cc0', '#d4623a', '#3fa072', '#c4508a', '#6f7f90', '#2e6f9e', '#a8883a', '#5f9e2f'];

  /* ------------------------------------------------------------------
   * 1. Hilfsfunktionen
   * ------------------------------------------------------------------ */
  function $(sel, el) { return (el || document).querySelector(sel); }

  // Kleiner DOM-Builder: h('div', {class:'x', onclick:fn}, 'Text', childElement)
  var PROPS = { value: 1, checked: 1, disabled: 1, selected: 1, type: 1, placeholder: 1, min: 1, max: 1, step: 1,
                rows: 1, src: 1, href: 1, download: 1, id: 1, title: 1, name: 1 };
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (PROPS[k]) el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    (function add(list) {
      list.forEach(function (kid) {
        if (kid == null || kid === false) return;
        if (Array.isArray(kid)) add(kid);
        else el.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
      });
    })(Array.prototype.slice.call(arguments, 2));
    return el;
  }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  // Unten einfahrendes Fenster. build(close) liefert den Inhalt.
  function openSheet(build, opts) {
    opts = opts || {};
    var prevFocus = document.activeElement;
    var back = h('div', { class: 'sheet-back' + (opts.center ? ' center' : '') });
    var sheet = h('div', { class: 'sheet' + (opts.center ? ' center-sheet' : ''), role: 'dialog', 'aria-modal': 'true' });
    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      back.remove();
      if (opts.onClose) opts.onClose();
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* egal */ } }
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    sheet.appendChild(build(close));
    back.appendChild(sheet);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    $('#overlay-root').appendChild(back);
    var first = sheet.querySelector('input:not([type=checkbox]), textarea, .btn');
    if (first && !opts.noFocus) { try { first.focus({ preventScroll: true }); } catch (e) { /* egal */ } }
    return close;
  }

  // Ja/Nein-Rückfrage -> Promise<boolean>
  function confirmBox(title, message, okText, danger) {
    return new Promise(function (resolve) {
      openSheet(function (close) {
        return h('div', null,
          h('h2', { text: title }),
          h('p', { text: message }),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn', type: 'button', onclick: function () { resolve(false); close(); } }, 'Abbrechen'),
            h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button',
                          onclick: function () { resolve(true); close(); } }, okText || 'OK')));
      }, { center: true, noFocus: true, onClose: function () { resolve(false); } });
    });
  }

  function tile(value, label, cls, sub) {
    return h('div', { class: 'tile ' + (cls || '') },
      h('span', { class: 'v', text: value }), h('span', { class: 'l', text: label }), sub ? h('span', { class: 'l', text: sub }) : null);
  }
  function eur(c) { return L.formatEuro(c); }
  function byName(a, b) { return a.name.localeCompare(b.name, 'de'); }
  function mondayISO(week) {
    var d = L.mondayOf(week);
    return d.getUTCFullYear() + '-' + L.pad2(d.getUTCMonth() + 1) + '-' + L.pad2(d.getUTCDate());
  }
  function readText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(r.error || new Error('Datei nicht lesbar')); };
      r.readAsText(file);
    });
  }

  /* ------------------------------------------------------------------
   * 2. Zustand + Speichern
   * ------------------------------------------------------------------ */
  var S = {
    settings: { defaultPriceCents: 35, lastBackupAt: null },
    customers: [],
    entries: new Map(),     // key -> Eintrag
    weeks: new Map(),       // Woche -> { week, note }
    lastWeek: null,         // zuletzt angesehene Woche (für den Tab "Woche")
    range: 12,              // Verlauf: Zeitraum in Wochen
    chartCustomer: 'all',   // Verlauf: Kundenauswahl
    expanded: {},           // Offen: aufgeklappte Kunden
    pinPhoto: false,        // Woche: Foto oben fixieren
    persisted: null,
    cleanup: null,          // wird beim Verlassen einer Ansicht aufgerufen
    onResize: null
  };

  function allEntries() { return Array.from(S.entries.values()); }
  function custById(id) { return S.customers.find(function (c) { return c.id === id; }); }
  function custName(id) { var c = custById(id); return c ? c.name : '(gelöscht)'; }
  function custColor(id) {
    var i = S.customers.findIndex(function (c) { return c.id === id; });
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
  }
  // Kunden, die in einer Woche angezeigt werden: aktive + archivierte mit Verkauf in dieser Woche
  function customersForWeek(week) {
    return S.customers.filter(function (c) {
      if (!c.archived) return true;
      var e = S.entries.get(L.entryKey(week, c.id));
      return e && !L.isEmptyEntry(e);
    });
  }

  function persist(promise) {
    return promise.catch(function (err) {
      console.error(err);
      toast('⚠️ Speichern fehlgeschlagen – Daten sichern!');
    });
  }
  function saveEntry(e) {
    if (L.isEmptyEntry(e)) {                     // leere Einträge werden nicht aufgehoben
      S.entries.delete(e.key);
      return persist(DB.del('entries', e.key));
    }
    S.entries.set(e.key, e);
    return persist(DB.put('entries', e));
  }
  function saveCustomer(c) {
    var i = S.customers.findIndex(function (x) { return x.id === c.id; });
    if (i >= 0) S.customers[i] = c; else S.customers.push(c);
    S.customers.sort(byName);
    return persist(DB.put('customers', c));
  }
  function saveSetting(key, value) {
    S.settings[key] = value;
    return persist(DB.setSetting(key, value));
  }

  async function loadState() {
    var d = await DB.loadAll();
    S.settings = Object.assign({ defaultPriceCents: 35, lastBackupAt: null }, d.settings);
    S.customers = d.customers.sort(byName);
    S.entries = new Map(d.entries.map(function (e) { return [e.key, e]; }));
    S.weeks = new Map(d.weeks.map(function (w) { return [w.week, w]; }));
  }

  /* ------------------------------------------------------------------
   * 3a. Ansicht: Start
   * ------------------------------------------------------------------ */
  function backupNote(all) {
    if (!all.length) return null;
    var last = S.settings.lastBackupAt;
    var days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null;
    if (last && days < 14) return null;
    return h('div', { class: 'notice' },
      h('strong', { text: '💾 Zeit für ein Backup' }),
      h('div', { text: last ? 'Dein letztes Backup ist ' + days + ' Tage alt.' : 'Du hast noch kein Backup gemacht.' }),
      h('div', { class: 'small muted', text: 'Die Daten liegen nur auf diesem Handy. Geht es verloren oder wird der Browser-Speicher gelöscht, sind sie weg.' }),
      h('a', { class: 'btn primary small', href: '#/mehr' }, 'Zu Daten & Backup'));
  }

  function viewStart() {
    $('#title').textContent = 'Eierliste';
    var app = $('#app'), cur = L.currentWeekKey(), all = allEntries();

    if (!S.customers.length) {
      app.append(h('div', { class: 'card empty-state' },
        h('div', { class: 'big', text: '🥚' }),
        h('h2', { text: 'Willkommen!' }),
        h('p', { text: 'Lege zuerst deine Kunden an. Danach kannst du jede Woche die Eier eintragen.' }),
        h('button', { class: 'btn primary big', type: 'button', onclick: function () { openCustomerSheet(null, function () { route(true); }); } }, '➕ Ersten Kunden anlegen')));
      return;
    }

    var note = backupNote(all);
    if (note) app.append(note);

    app.append(h('a', { class: 'btn primary big', href: '#/woche/' + cur }, '➕ Neue Woche eintragen'));
    app.append(h('div', { class: 'btn-row' },
      h('a', { class: 'btn', href: '#/woche/' + L.addWeeks(cur, -1) }, '← Vorwoche (KW ' + L.parseWeekKey(L.addWeeks(cur, -1)).week + ')'),
      h('a', { class: 'btn', href: '#/offen' }, '💶 Offene Beträge')));

    var wt = L.totals(L.weekEntries(all, cur));
    app.append(h('h2', { class: 'section-title', text: 'Aktuelle Woche · ' + L.weekLabel(cur) }));
    app.append(h('div', { class: 'tiles' },
      tile(L.formatInt(wt.eggs), 'Eier'), tile(eur(wt.amount), 'Umsatz'),
      tile(eur(wt.paid), 'bezahlt', 'ok'), tile(eur(wt.open), 'offen', wt.open > 0 ? 'bad' : '')));

    var tot = L.totals(all), open = L.openByCustomer(all);
    var card = h('div', { class: 'card' }, h('h2', { text: 'Offene Beträge' }),
      h('div', { class: 'big-number ' + (tot.open > 0 ? 'bad' : 'ok'), text: eur(tot.open) }));
    if (open.length) {
      open.slice(0, 4).forEach(function (o) {
        card.append(h('div', { class: 'list-item' },
          h('div', { class: 'grow', text: custName(o.customerId) }),
          h('strong', { class: 'num', text: eur(o.open) })));
      });
      if (open.length > 4) card.append(h('div', { class: 'muted small', text: '… und ' + (open.length - 4) + ' weitere' }));
      card.append(h('a', { class: 'btn block', style: 'margin-top:10px', href: '#/offen' }, 'Alle ansehen'));
    } else {
      card.append(h('div', { class: 'muted', text: all.length ? 'Alles bezahlt 🎉' : 'Noch keine Einträge.' }));
    }
    app.append(card);

    var pct = tot.amount > 0 ? Math.round(tot.paid / tot.amount * 100) : 0;
    app.append(h('div', { class: 'card' }, h('h2', { text: 'Gesamt: bezahlt vs. offen' }),
      h('div', { class: 'bar', role: 'img', 'aria-label': pct + ' Prozent bezahlt' },
        h('i', { class: 'paid', style: 'width:' + pct + '%' }), h('i', { class: 'open', style: 'width:' + (tot.amount > 0 ? 100 - pct : 0) + '%' })),
      h('div', { class: 'legend' },
        h('span', null, h('i', { class: 'dot', style: 'background:var(--ok)' }), 'bezahlt ', h('b', { text: eur(tot.paid) })),
        h('span', null, h('i', { class: 'dot', style: 'background:var(--bad)' }), 'offen ', h('b', { text: eur(tot.open) })),
        h('span', null, 'Umsatz ', h('b', { text: eur(tot.amount) })))));
  }

  /* ------------------------------------------------------------------
   * 3b. Ansicht: Woche eintragen
   * ------------------------------------------------------------------ */
  function viewWeek(week) {
    S.lastWeek = week;
    $('#title').textContent = 'Woche eintragen';
    var app = $('#app'), cur = L.currentWeekKey();

    app.append(h('div', { class: 'weeknav' },
      h('a', { class: 'btn', href: '#/woche/' + L.addWeeks(week, -1), 'aria-label': 'Vorherige Woche' }, '‹'),
      h('div', { class: 'weektitle' },
        h('strong', { text: L.weekLabel(week) + (week === cur ? ' · aktuell' : '') }),
        h('span', { class: 'muted small', text: L.weekSpan(week) })),
      h('a', { class: 'btn', href: '#/woche/' + L.addWeeks(week, 1), 'aria-label': 'Nächste Woche' }, '›')));

    var dateInput = h('input', { type: 'date', value: mondayISO(week), 'aria-label': 'Zu einem Datum springen',
      onchange: function () {
        var iso = L.dateToISO(dateInput.value);
        if (!iso) return;
        var p = iso.split('-');
        location.hash = '#/woche/' + L.weekKeyOfDate(new Date(+p[0], +p[1] - 1, +p[2]));
      } });
    app.append(h('div', { class: 'weektools' }, dateInput,
      week !== cur ? h('a', { class: 'btn small', href: '#/woche/' + cur }, 'Aktuelle Woche') : null));

    var summary = h('div', { class: 'tiles' });
    function updateSummary() {
      var t = L.totals(L.weekEntries(allEntries(), week));
      summary.textContent = '';
      summary.append(tile(L.formatInt(t.eggs), 'Eier gesamt'), tile(eur(t.amount), 'Umsatz'),
        tile(eur(t.paid), 'bezahlt', 'ok'), tile(eur(t.open), 'offen', t.open > 0 ? 'bad' : ''));
    }
    updateSummary();
    app.append(summary);

    app.append(photoCard(week));

    var list = customersForWeek(week);
    if (!list.length) {
      app.append(h('div', { class: 'card empty-state' }, h('p', { text: 'Noch keine Kunden angelegt.' }),
        h('button', { class: 'btn primary', type: 'button', onclick: function () { openCustomerSheet(null, function () { route(true); }); } }, '➕ Kunde anlegen')));
    }
    list.forEach(function (c) { app.append(buildRow(c, week, updateSummary)); });

    // Notiz zur Woche
    var rec = S.weeks.get(week);
    var noteTimer;
    var note = h('textarea', { placeholder: 'z. B. Urlaub, Preise geändert, Zettel unklar …', value: rec ? rec.note : '', 'aria-label': 'Notiz zur Woche' });
    function saveNote() {
      clearTimeout(noteTimer);
      var txt = note.value, old = S.weeks.get(week);
      if (!txt.trim()) {
        if (old) { S.weeks.delete(week); persist(DB.del('weeks', week)); }
        return;
      }
      if (old && old.note === txt) return;
      var r = { week: week, note: txt };
      S.weeks.set(week, r);
      persist(DB.put('weeks', r));
    }
    note.addEventListener('input', function () { clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 500); });
    note.addEventListener('blur', saveNote);
    S.cleanup = saveNote;                         // beim Verlassen der Woche noch speichern
    app.append(h('div', { class: 'card' }, h('h3', { text: 'Notiz zur Woche' }), note));
  }

  // Eine Kundenzeile: Eier +/-/Zahl, Betrag, Bezahlstatus (ein Tipp), Details
  function buildRow(cust, week, onChange) {
    var getEntry = function () { return S.entries.get(L.entryKey(week, cust.id)); };
    var eggsInput = h('input', { class: 'eggs', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off',
                                 placeholder: '0', 'aria-label': 'Eier für ' + cust.name });
    var minus = h('button', { class: 'step', type: 'button', 'aria-label': 'Ein Ei weniger' }, '−');
    var plus = h('button', { class: 'step', type: 'button', 'aria-label': 'Ein Ei mehr' }, '+');
    var nameEl = h('div', { class: 'row-name' });
    var amountEl = h('div', { class: 'amount' });
    var chip = h('button', { class: 'chip', type: 'button' });
    var more = h('button', { class: 'more', type: 'button', 'aria-label': 'Details zu ' + cust.name }, '⋯');
    var row = h('div', { class: 'row' },
      h('div', { class: 'row-top' }, nameEl, chip, more),
      h('div', { class: 'row-ctl' }, minus, eggsInput, plus, amountEl));

    function paint(force) {
      var e = getEntry();
      var eggs = e ? e.eggs : 0;
      if (force || document.activeElement !== eggsInput) eggsInput.value = eggs > 0 ? String(eggs) : '';
      var st = e ? L.statusOf(e) : 'leer';
      row.className = 'row st-' + st;
      var price = e ? e.priceCents : cust.priceCents;
      nameEl.textContent = '';
      nameEl.append(cust.name, h('small', { text: eur(price) + ' pro Ei' + (cust.archived ? ' · archiviert' : '') }));
      amountEl.textContent = '';
      amountEl.append(e ? eur(L.amountOf(e)) : eur(0));
      if (e && st === 'teil') amountEl.append(h('small', { text: 'bezahlt ' + eur(L.paidOf(e)) + ' · offen ' + eur(L.openOf(e)) }));
      else if (e && st === 'bezahlt' && e.paidAt) amountEl.append(h('small', { text: 'bezahlt am ' + L.isoToDE(e.paidAt).slice(0, 6) }));
      var label = { offen: 'offen', bezahlt: 'bezahlt ✓', teil: 'teilweise', leer: '–' }[st];
      chip.className = 'chip ' + st;
      chip.textContent = label;
      chip.setAttribute('aria-label', 'Bezahlstatus ' + cust.name + ': ' + label + '. Tippen zum Umschalten');
    }
    function setEggs(n) {
      var e = getEntry();
      if (!e && n === 0) return;
      saveEntry(L.withEggs(e || L.newEntry(week, cust.id, cust.priceCents), n));
      paint(false);
      onChange();
    }
    function currentEggs() { var e = getEntry(); return e ? e.eggs : 0; }

    eggsInput.addEventListener('focus', function () { try { eggsInput.select(); } catch (err) { /* egal */ } });
    eggsInput.addEventListener('input', function () {
      var digits = eggsInput.value.replace(/\D/g, '').slice(0, 5);
      if (digits !== eggsInput.value) eggsInput.value = digits;
      setEggs(digits === '' ? 0 : parseInt(digits, 10));
    });
    eggsInput.addEventListener('blur', function () { paint(true); });
    plus.addEventListener('click', function () { setEggs(currentEggs() + 1); paint(true); });
    minus.addEventListener('click', function () { if (currentEggs() > 0) { setEggs(currentEggs() - 1); paint(true); } });
    chip.addEventListener('click', function () {
      var e = getEntry();
      if (!e || L.amountOf(e) <= 0) { toast('Trage zuerst Eier ein.'); return; }
      saveEntry(L.togglePaid(e, L.todayISO()));
      paint(false);
      onChange();
    });
    more.addEventListener('click', function () { openEntrySheet(cust, week, function () { paint(true); onChange(); }); });
    paint(true);
    return row;
  }

  // Details zu einem Eintrag: Eier, Preis, Teilzahlung, Zahlungsdatum, Löschen
  function openEntrySheet(cust, week, onDone) {
    var existing = S.entries.get(L.entryKey(week, cust.id));
    var e = existing || L.newEntry(week, cust.id, cust.priceCents);
    openSheet(function (close) {
      var eggs = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', value: String(e.eggs) });
      var price = h('input', { type: 'text', inputmode: 'decimal', value: L.formatNumDE(e.priceCents) });
      var paid = h('input', { type: 'text', inputmode: 'decimal', value: L.formatNumDE(L.paidOf(e)) });
      var paidAt = h('input', { type: 'date', value: e.paidAt || '' });
      var info = h('p', { class: 'muted' });
      function calc() {
        var n = parseInt(eggs.value || '0', 10) || 0, p = L.parseEuro(price.value);
        info.textContent = p == null ? 'Preis ungültig' : n + ' Eier × ' + eur(p) + ' = ' + eur(n * p);
      }
      [eggs, price].forEach(function (i) { i.addEventListener('input', calc); });
      calc();
      return h('div', null,
        h('h2', { text: cust.name + ' · ' + L.weekLabel(week) }),
        info,
        h('label', { class: 'field' }, h('span', { text: 'Eier' }), eggs),
        h('label', { class: 'field' }, h('span', { text: 'Preis pro Ei in € (gilt nur für diesen Eintrag)' }), price),
        h('label', { class: 'field' }, h('span', { text: 'Bereits bezahlt in € (Teilzahlung möglich)' }), paid),
        h('div', { class: 'btn-row', style: 'margin-top:0' },
          h('button', { class: 'btn small', type: 'button', onclick: function () {
            var n = parseInt(eggs.value || '0', 10) || 0, p = L.parseEuro(price.value) || 0;
            paid.value = L.formatNumDE(n * p);
            if (!paidAt.value) paidAt.value = L.todayISO();
          } }, 'Voll bezahlt'),
          h('button', { class: 'btn small', type: 'button', onclick: function () { paid.value = '0,00'; paidAt.value = ''; } }, 'Nichts bezahlt')),
        h('label', { class: 'field' }, h('span', { text: 'Zahlungsdatum (wird automatisch auf heute gesetzt)' }), paidAt),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Abbrechen'),
          h('button', { class: 'btn primary', type: 'button', onclick: function () {
            var p = L.parseEuro(price.value), pa = paid.value.trim() === '' ? 0 : L.parseEuro(paid.value);
            if (p == null) { toast('Preis ungültig'); return; }
            if (pa == null) { toast('Bezahlter Betrag ungültig'); return; }
            var n = parseInt(eggs.value || '0', 10) || 0;
            saveEntry(L.applyEdit(e, { eggs: n, priceCents: p, paidCents: pa, paidAt: paidAt.value || null }, L.todayISO()));
            close(); onDone();
          } }, 'Speichern')),
        existing ? h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', type: 'button', onclick: async function () {
          if (!await confirmBox('Eintrag löschen?', cust.name + ' in ' + L.weekLabel(week) + ' komplett löschen (inkl. Bezahlstatus)?', 'Löschen', true)) return;
          saveEntry(L.withEggs(Object.assign({}, existing, { paidCents: 0, paidAt: null }), 0));
          close(); onDone(); toast('Eintrag gelöscht');
        } }, '🗑️ Eintrag löschen')) : null);
    });
  }

  /* ------------------------------------------------------------------
   * 4a. Zettel-Foto: aufnehmen, verkleinern, speichern, zoomen
   * ------------------------------------------------------------------ */
  function photoCard(week) {
    var card = h('section', { class: 'card photo' + (S.pinPhoto ? ' pinned' : '') });
    var body = h('div');
    card.append(h('h3', { text: 'Zettel-Foto' }), body);

    function pick(capture) {
      var inp = h('input', { type: 'file', accept: 'image/*', hidden: true });
      if (capture) inp.setAttribute('capture', 'environment');
      inp.addEventListener('change', async function () {
        var f = inp.files && inp.files[0];
        inp.remove();
        if (!f) return;
        try {
          toast('Foto wird verkleinert …');
          var data = await compressImage(f, 1600, 0.72);
          await DB.put('photos', { week: week, data: data, updatedAt: new Date().toISOString() });
          show(data);
          toast('Foto gespeichert');
        } catch (err) {
          console.error(err);
          toast('⚠️ Foto konnte nicht gespeichert werden');
        }
      });
      card.append(inp);                      // muss im Dokument hängen, damit iOS es zuverlässig öffnet
      inp.click();
    }

    function show(data) {
      body.textContent = '';
      if (data) {
        body.append(h('img', { class: 'zettel', src: data, alt: 'Foto vom Zettel – tippen zum Vergrößern',
                               onclick: function () { openViewer(data); } }));
      } else {
        body.append(h('div', { class: 'empty', text: 'Noch kein Foto für diese Woche.' }));
      }
      var btns = h('div', { class: 'btn-row' },
        h('button', { class: 'btn' + (data ? '' : ' primary'), type: 'button', onclick: function () { pick(true); } }, data ? '📷 Neu aufnehmen' : '📷 Zettel fotografieren'),
        h('button', { class: 'btn', type: 'button', onclick: function () { pick(false); } }, '🖼️ Aus Galerie'));
      if (data) {
        btns.append(
          h('button', { class: 'btn', type: 'button', onclick: function () { openViewer(data); } }, '🔍 Zoom'),
          h('button', { class: 'btn', type: 'button', 'aria-pressed': String(S.pinPhoto), onclick: function () {
            S.pinPhoto = !S.pinPhoto; card.classList.toggle('pinned', S.pinPhoto); show(data);
          } }, S.pinPhoto ? '📌 Nicht mehr fixieren' : '📌 Beim Scrollen fixieren'),
          h('button', { class: 'btn danger', type: 'button', onclick: async function () {
            if (!await confirmBox('Foto löschen?', 'Das Foto von ' + L.weekLabel(week) + ' entfernen?', 'Löschen', true)) return;
            await persist(DB.del('photos', week)); show(null); toast('Foto gelöscht');
          } }, '🗑️'));
      }
      body.append(btns);
    }
    show(null);
    DB.getPhoto(week).then(function (p) { if (p && p.data) show(p.data); }).catch(function (err) { console.error(err); });
    return card;
  }

  // Foto auf max. 1600 px verkleinern und als JPEG komprimieren (spart Speicher)
  function compressImage(file, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth, hgt = img.naturalHeight, k = Math.min(1, maxDim / Math.max(w, hgt));
          var cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(hgt * k));
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
          ctx.drawImage(img, 0, 0, cv.width, cv.height);
          URL.revokeObjectURL(url);
          resolve(cv.toDataURL('image/jpeg', quality));
        } catch (err) { URL.revokeObjectURL(url); reject(err); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Bild nicht lesbar')); };
      img.src = url;
    });
  }

  // Vollbild-Foto mit Zoom: zwei Finger, Doppeltipp, Mausrad, Buttons
  function openViewer(src) {
    var box = h('div', { class: 'viewer', role: 'dialog', 'aria-label': 'Foto vergrößert' });
    var img = h('img', { src: src, alt: 'Zettel' });
    var scale = 1, minScale = 1, tx = 0, ty = 0;
    var pointers = new Map(), lastTap = 0, lastTapX = 0, lastTapY = 0, pinchDist = 0;

    function clamp() {
      var vw = box.clientWidth, vh = box.clientHeight, w = img.naturalWidth * scale, hh = img.naturalHeight * scale;
      tx = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, tx));
      ty = hh <= vh ? (vh - hh) / 2 : Math.min(0, Math.max(vh - hh, ty));
    }
    function apply() { clamp(); img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; }
    function fit() {
      if (!img.naturalWidth) return;
      img.style.width = img.naturalWidth + 'px'; img.style.height = img.naturalHeight + 'px';
      minScale = Math.min(box.clientWidth / img.naturalWidth, box.clientHeight / img.naturalHeight);
      scale = minScale; tx = 0; ty = 0; apply();
    }
    function zoomAt(cx, cy, next) {
      next = Math.max(minScale, Math.min(minScale * 8, next));
      tx = cx - (cx - tx) * (next / scale); ty = cy - (cy - ty) * (next / scale);
      scale = next; apply();
    }
    function close() { window.removeEventListener('resize', fit); document.removeEventListener('keydown', onKey); box.remove(); }
    function onKey(e) { if (e.key === 'Escape') close(); }

    box.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.tools')) return;
      box.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        var p = Array.from(pointers.values());
        pinchDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      } else if (pointers.size === 1) {
        var now = Date.now();
        if (now - lastTap < 300 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 30) {   // Doppeltipp
          if (scale > minScale * 1.05) { scale = minScale; apply(); } else zoomAt(e.clientX, e.clientY, minScale * 3);
          lastTap = 0;
        } else { lastTap = now; lastTapX = e.clientX; lastTapY = e.clientY; }
      }
    });
    box.addEventListener('pointermove', function (e) {
      var prev = pointers.get(e.pointerId);
      if (!prev) return;
      if (pointers.size === 2) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        var p = Array.from(pointers.values()), d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        if (pinchDist > 0) zoomAt((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2, scale * d / pinchDist);
        pinchDist = d;
      } else {
        tx += e.clientX - prev.x; ty += e.clientY - prev.y;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        apply();
      }
    });
    function up(e) { pointers.delete(e.pointerId); pinchDist = 0; }
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    }, { passive: false });

    var cx = function () { return box.clientWidth / 2; }, cy = function () { return box.clientHeight / 2; };
    box.append(img,
      h('div', { class: 'tools' },
        h('button', { class: 'btn', type: 'button', 'aria-label': 'Verkleinern', onclick: function () { zoomAt(cx(), cy(), scale / 1.5); } }, '−'),
        h('button', { class: 'btn', type: 'button', 'aria-label': 'Vergrößern', onclick: function () { zoomAt(cx(), cy(), scale * 1.5); } }, '+'),
        h('button', { class: 'btn', type: 'button', 'aria-label': 'Ganzes Bild', onclick: fit }, '⤢'),
        h('button', { class: 'btn', type: 'button', 'aria-label': 'Schließen', onclick: close }, '✕')),
      h('div', { class: 'hint', text: 'Zwei Finger zum Zoomen · Doppeltipp zum Vergrößern · Ziehen zum Verschieben' }));
    $('#overlay-root').append(box);
    window.addEventListener('resize', fit);
    document.addEventListener('keydown', onKey);
    if (img.complete && img.naturalWidth) fit(); else img.addEventListener('load', fit);
  }

  /* ------------------------------------------------------------------
   * 3c. Ansicht: Offene Beträge
   * ------------------------------------------------------------------ */
  function viewOpen() {
    $('#title').textContent = 'Offene Beträge';
    var app = $('#app'), all = allEntries(), tot = L.totals(all), open = L.openByCustomer(all);
    var pct = tot.amount > 0 ? Math.round(tot.paid / tot.amount * 100) : 0;

    app.append(h('div', { class: 'card' },
      h('div', { class: 'muted small', text: 'Offen insgesamt' }),
      h('div', { class: 'big-number ' + (tot.open > 0 ? 'bad' : 'ok'), text: eur(tot.open) }),
      h('div', { class: 'bar', role: 'img', 'aria-label': pct + ' Prozent des Umsatzes bezahlt' },
        h('i', { class: 'paid', style: 'width:' + pct + '%' }),
        h('i', { class: 'open', style: 'width:' + (tot.amount > 0 ? 100 - pct : 0) + '%' })),
      h('div', { class: 'legend' },
        h('span', null, h('i', { class: 'dot', style: 'background:var(--ok)' }), 'bezahlter Umsatz ', h('b', { text: eur(tot.paid) })),
        h('span', null, h('i', { class: 'dot', style: 'background:var(--bad)' }), 'offener Umsatz ', h('b', { text: eur(tot.open) })))));

    if (!open.length) {
      app.append(h('div', { class: 'card empty-state' }, h('div', { class: 'big', text: '🎉' }),
        h('p', { text: all.length ? 'Alles bezahlt – nichts offen.' : 'Noch keine Einträge vorhanden.' })));
      return;
    }
    open.forEach(function (o) {
      var exp = !!S.expanded[o.customerId];
      var card = h('div', { class: 'card' });
      card.append(h('button', { class: 'cust-head', type: 'button', 'aria-expanded': String(exp), onclick: function () {
        S.expanded[o.customerId] = !exp; route(true);
      } },
        h('span', { class: 'name' }, custName(o.customerId), h('small', { class: 'muted', style: 'display:block;font-weight:500', text: o.weeks.length + (o.weeks.length === 1 ? ' Woche offen' : ' Wochen offen') })),
        h('span', { class: 'sum', text: eur(o.open) }),
        h('span', { class: 'muted', 'aria-hidden': 'true', text: exp ? '▲' : '▼' })));
      if (exp) {
        var wl = h('div', { class: 'weeklist' });
        o.weeks.forEach(function (w) {
          var entry = S.entries.get(w.key);
          wl.append(h('div', { class: 'wk' },
            h('div', { class: 't' }, h('a', { href: '#/woche/' + w.week, text: L.weekLabel(w.week) }),
              h('div', { class: 'muted small', text: w.eggs + ' Eier · ' + eur(w.amount) + (w.status === 'teil' ? ' · offen ' + eur(w.open) : '') })),
            h('button', { class: 'chip ' + w.status, type: 'button', 'aria-label': 'Als bezahlt markieren: ' + L.weekLabel(w.week), onclick: function () {
              saveEntry(L.togglePaid(entry, L.todayISO())); route(true);
            } }, w.status === 'teil' ? 'teilweise' : 'offen')));
        });
        card.append(wl);
      }
      card.append(h('button', { class: 'btn primary block', type: 'button', style: 'margin-top:10px', onclick: async function () {
        var ok = await confirmBox('Alles als bezahlt markieren?',
          'Alle ' + o.weeks.length + ' offenen Wochen von ' + custName(o.customerId) + ' (zusammen ' + eur(o.open) + ') werden als bezahlt markiert, Zahlungsdatum: heute.',
          'Ja, bezahlt');
        if (!ok) return;
        L.markAllPaid(all, o.customerId, L.todayISO()).forEach(saveEntry);
        toast(custName(o.customerId) + ': alles bezahlt ✓');
        route(true);
      } }, '✓ Alle offenen Wochen als bezahlt markieren'));
      app.append(card);
    });
    app.append(h('p', { class: 'muted small', text: 'Tipp: Kunde antippen, um die offenen Wochen zu sehen. Ein Tipp auf „offen“ markiert eine einzelne Woche als bezahlt.' }));
  }

  /* ------------------------------------------------------------------
   * 3d. Ansicht: Entwicklung (Diagramm + Kennzahlen)
   * ------------------------------------------------------------------ */
  function viewTrend() {
    $('#title').textContent = 'Entwicklung';
    var app = $('#app'), all = allEntries(), cur = L.currentWeekKey();
    if (!all.length) {
      app.append(h('div', { class: 'card empty-state' }, h('div', { class: 'big', text: '📈' }), h('p', { text: 'Sobald du Wochen eingetragen hast, siehst du hier die Entwicklung.' })));
      return;
    }
    var weeks = L.weeksBack(cur, S.range);
    var withData = S.customers.filter(function (c) { return all.some(function (e) { return e.customerId === c.id; }); });
    if (S.chartCustomer !== 'all' && !withData.some(function (c) { return c.id === S.chartCustomer; })) S.chartCustomer = 'all';
    var selId = S.chartCustomer === 'all' ? null : S.chartCustomer;

    var rangeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Zeitraum' });
    [4, 12, 52].forEach(function (n) {
      rangeSeg.append(h('button', { type: 'button', 'aria-pressed': String(S.range === n), onclick: function () { S.range = n; route(true); } }, n + ' Wochen'));
    });
    app.append(rangeSeg);

    var custSeg = h('div', { class: 'seg chips', role: 'group', 'aria-label': 'Kunde' });
    custSeg.append(h('button', { type: 'button', 'aria-pressed': String(!selId), onclick: function () { S.chartCustomer = 'all'; route(true); } }, 'Alle'));
    withData.forEach(function (c) {
      custSeg.append(h('button', { type: 'button', 'aria-pressed': String(selId === c.id), onclick: function () { S.chartCustomer = c.id; route(true); } }, c.name));
    });
    app.append(custSeg);

    // Datenreihen fürs Diagramm: bei "Alle" gestapelt nach Kunde, sonst eine Reihe
    var labels = weeks.map(function (w) { return String(L.parseWeekKey(w).week); });
    var seriesList = (selId ? withData.filter(function (c) { return c.id === selId; }) : withData).map(function (c) {
      return { id: c.id, name: c.name, color: custColor(c.id), values: L.series(all, weeks, c.id).eggs };
    }).filter(function (s) { return s.values.some(function (v) { return v > 0; }); });
    var main = L.series(all, weeks, selId);
    var st = L.stats(weeks, main.eggs, main.amount);

    var canvas = h('canvas', { class: 'chart', role: 'img', 'aria-label': 'Balkendiagramm: Eier pro Woche' });
    var info = h('div', { class: 'chart-info' });
    var selected = -1;
    main.eggs.forEach(function (v, i) { if (v > 0) selected = i; });
    function showInfo() {
      info.textContent = '';
      if (selected < 0) { info.append('Balken antippen für Details.'); return; }
      var w = weeks[selected];
      info.append(h('strong', { text: L.weekLabel(w) + ' (' + L.weekSpan(w) + ')' }), h('br'),
        main.eggs[selected] + ' Eier · ' + eur(main.amount[selected]));
      if (!selId) {
        var parts = seriesList.filter(function (s) { return s.values[selected] > 0; }).map(function (s) { return s.name + ' ' + s.values[selected]; });
        if (parts.length) info.append(h('div', { class: 'muted small', text: parts.join(' · ') }));
      }
    }
    var indexAt = null;
    function redraw() { indexAt = CH.draw(canvas, { labels: labels, series: seriesList, selected: selected }); }
    canvas.addEventListener('click', function (e) {
      var i = indexAt ? indexAt(e.clientX) : -1;
      selected = i === selected ? -1 : i;
      redraw(); showInfo();
    });

    var card = h('div', { class: 'card' }, h('h2', { text: 'Eier pro Woche' }), canvas);
    if (!selId && seriesList.length > 1) {
      card.append(h('div', { class: 'legend', style: 'margin-top:6px' }, seriesList.map(function (s) {
        return h('span', null, h('i', { class: 'dot', style: 'background:' + s.color }), s.name);
      })));
    }
    card.append(info);
    app.append(card);
    showInfo();
    S.onResize = redraw;
    requestAnimationFrame(redraw);

    // Kennzahlen
    var trendTile;
    if (st.trend) {
      var t = st.trend, up = t.diff > 0, same = t.diff === 0;
      trendTile = tile((same ? '= ' : up ? '▲ +' : '▼ ') + t.diff + (t.pct != null ? ' (' + (t.diff > 0 ? '+' : '') + t.pct + ' %)' : ''),
        'Trend zur Vorwoche', same ? '' : up ? 'ok' : 'bad',
        L.weekLabel(t.week).replace('/' + L.parseWeekKey(t.week).year, '') + ' vs. ' + L.weekLabel(t.prevWeek).replace('/' + L.parseWeekKey(t.prevWeek).year, ''));
    } else trendTile = tile('–', 'Trend zur Vorwoche', '', 'zu wenig Daten');
    app.append(h('div', { class: 'tiles' },
      tile(L.formatDec(st.avg, 1), 'Ø Eier pro Woche', '', st.weeksWithData + ' Wochen mit Verkauf'),
      tile(st.best ? st.best.eggs + ' Eier' : '–', 'Beste Woche', '', st.best ? L.weekLabel(st.best.week) : ''),
      tile(L.formatInt(st.totalEggs), 'Gesamtmenge (Eier)', '', 'letzte ' + S.range + ' Wochen'),
      tile(eur(st.totalAmount), 'Gesamtumsatz', '', 'letzte ' + S.range + ' Wochen'),
      trendTile));

    // Übersicht pro Kunde
    var rows = L.customerOverview(all, S.customers, weeks);
    var table = h('table', { class: 't' },
      h('thead', null, h('tr', null, h('th', { text: 'Kunde' }), h('th', { text: 'Eier' }), h('th', { text: 'Ø/Woche' }), h('th', { text: 'offen (gesamt)' }))),
      h('tbody', null, rows.map(function (r) {
        return h('tr', null, h('td', null, h('i', { class: 'dot', style: 'background:' + custColor(r.customerId) }), r.name),
          h('td', { text: L.formatInt(r.totalEggs) }), h('td', { text: L.formatDec(r.avg, 1) }),
          h('td', { class: r.open > 0 ? 'down' : '', text: eur(r.open) }));
      })));
    app.append(h('div', { class: 'card' }, h('h2', { text: 'Pro Kunde' }), table,
      h('p', { class: 'muted small', text: 'Ø = Durchschnitt über Wochen mit Verkauf. Offen = alle Wochen, nicht nur der Zeitraum.' })));
  }

  /* ------------------------------------------------------------------
   * 3e. Ansicht: Mehr (Standardpreis, Kunden, Daten & Backup)
   * ------------------------------------------------------------------ */
  function viewMore() {
    $('#title').textContent = 'Mehr';
    var app = $('#app');

    // Standardpreis
    var dp = h('input', { type: 'text', inputmode: 'decimal', value: L.formatNumDE(S.settings.defaultPriceCents), 'aria-label': 'Standardpreis pro Ei in Euro' });
    dp.addEventListener('change', function () {
      var c = L.parseEuro(dp.value);
      if (c == null) { toast('Preis ungültig'); dp.value = L.formatNumDE(S.settings.defaultPriceCents); return; }
      saveSetting('defaultPriceCents', c); dp.value = L.formatNumDE(c); toast('Standardpreis gespeichert');
    });
    app.append(h('div', { class: 'card' }, h('h2', { text: 'Standardpreis' }),
      h('label', { class: 'field' }, h('span', { text: 'Preis pro Ei in € (Vorgabe für neue Kunden)' }), dp)));

    // Kunden
    var active = S.customers.filter(function (c) { return !c.archived; });
    var archived = S.customers.filter(function (c) { return c.archived; });
    var kc = h('div', { class: 'card' }, h('h2', { text: 'Kunden' }));
    if (!active.length) kc.append(h('p', { class: 'muted', text: 'Noch keine Kunden.' }));
    active.forEach(function (c) {
      kc.append(h('div', { class: 'list-item' },
        h('div', { class: 'grow' }, c.name, h('small', { text: eur(c.priceCents) + ' pro Ei' })),
        h('button', { class: 'btn small', type: 'button', onclick: function () { openCustomerSheet(c, function () { route(true); }); } }, 'Bearbeiten')));
    });
    kc.append(h('button', { class: 'btn primary block', type: 'button', style: 'margin-top:10px', onclick: function () { openCustomerSheet(null, function () { route(true); }); } }, '➕ Kunde anlegen'));
    app.append(kc);
    if (archived.length) {
      var ac = h('div', { class: 'card' }, h('h3', { text: 'Archiviert' }));
      archived.forEach(function (c) {
        ac.append(h('div', { class: 'list-item' }, h('div', { class: 'grow', text: c.name }),
          h('button', { class: 'btn small', type: 'button', onclick: function () {
            saveCustomer(Object.assign({}, c, { archived: false })); toast(c.name + ' ist wieder aktiv'); route(true);
          } }, 'Wiederherstellen')));
      });
      app.append(ac);
    }

    // Daten & Backup
    var lastB = S.settings.lastBackupAt;
    var all = allEntries();
    var dc = h('div', { class: 'card' }, h('h2', { text: 'Daten & Backup' }),
      h('p', { class: 'muted small', text: 'Alle Daten liegen nur in diesem Browser auf diesem Handy. Mach regelmäßig ein Backup (z. B. jeden Monat) und speichere es in iCloud, Google Drive oder schick es dir per E-Mail.' }),
      h('p', null, h('strong', { text: 'Letztes Backup: ' }), lastB ? new Date(lastB).toLocaleDateString('de-DE') + ' (vor ' + Math.floor((Date.now() - new Date(lastB).getTime()) / 86400000) + ' Tagen)' : 'noch nie'));
    var backupFile = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    var csvFile = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', hidden: true });
    backupFile.addEventListener('change', function () { var f = backupFile.files[0]; backupFile.value = ''; if (f) importBackup(f); });
    csvFile.addEventListener('change', function () { var f = csvFile.files[0]; csvFile.value = ''; if (f) importCSV(f); });
    dc.append(
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', type: 'button', onclick: makeBackup }, '💾 Backup erstellen (mit Fotos)'),
        h('button', { class: 'btn', type: 'button', onclick: function () { backupFile.click(); } }, '📥 Backup einspielen')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', onclick: exportCSV }, '📄 Export für Excel (CSV)'),
        h('button', { class: 'btn', type: 'button', onclick: function () { csvFile.click(); } }, '📤 CSV importieren')),
      backupFile, csvFile);
    app.append(dc);

    var info = h('div', { class: 'card' }, h('h3', { text: 'Info' }),
      h('p', { class: 'small muted', id: 'infoText', text: all.length + ' Einträge · ' + S.customers.length + ' Kunden · Version ' + APP_VERSION }));
    app.append(info);
    DB.countPhotos().then(function (n) {
      var el = $('#infoText'); if (!el) return;
      el.textContent = all.length + ' Einträge · ' + S.customers.length + ' Kunden · ' + n + ' Fotos · Version ' + APP_VERSION +
        (S.persisted === true ? ' · Speicher gesichert' : S.persisted === false ? ' · Speicher kann vom Browser geleert werden – Backups machen!' : '');
    });
  }

  // Kunde anlegen oder bearbeiten
  function openCustomerSheet(cust, onDone) {
    openSheet(function (close) {
      var name = h('input', { type: 'text', value: cust ? cust.name : '', placeholder: 'Name', autocomplete: 'off', 'aria-label': 'Name' });
      var price = h('input', { type: 'text', inputmode: 'decimal', value: L.formatNumDE(cust ? cust.priceCents : S.settings.defaultPriceCents), 'aria-label': 'Preis pro Ei' });
      var reprice = h('input', { type: 'checkbox' });
      return h('div', null,
        h('h2', { text: cust ? 'Kunde bearbeiten' : 'Neuer Kunde' }),
        h('label', { class: 'field' }, h('span', { text: 'Name' }), name),
        h('label', { class: 'field' }, h('span', { text: 'Preis pro Ei in €' }), price),
        cust ? h('label', { class: 'check' }, reprice, h('span', { text: 'Neuen Preis auch für bereits eingetragene, noch komplett unbezahlte Wochen übernehmen' })) : null,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', type: 'button', onclick: close }, 'Abbrechen'),
          h('button', { class: 'btn primary', type: 'button', onclick: function () {
            var nm = L.normalizeName(name.value), p = L.parseEuro(price.value);
            if (!nm) { toast('Bitte einen Namen eingeben'); return; }
            if (p == null) { toast('Preis ungültig'); return; }
            var dup = S.customers.some(function (c) { return c.name.toLowerCase() === nm.toLowerCase() && (!cust || c.id !== cust.id); });
            if (dup) { toast('Diesen Namen gibt es schon'); return; }
            if (cust) {
              saveCustomer(Object.assign({}, cust, { name: nm, priceCents: p }));
              if (reprice.checked) L.repriceUnpaid(allEntries(), cust.id, p).forEach(saveEntry);
            } else {
              saveCustomer({ id: L.newId('c'), name: nm, priceCents: p, archived: false, createdAt: new Date().toISOString() });
            }
            close(); toast('Gespeichert'); onDone();
          } }, 'Speichern')),
        cust ? h('div', { class: 'btn-row' }, h('button', { class: 'btn danger', type: 'button', onclick: async function () {
          if (!await confirmBox('Kunde archivieren?', cust.name + ' wird in der Wochenansicht ausgeblendet. Alle Einträge und offenen Beträge bleiben erhalten; du kannst den Kunden jederzeit wiederherstellen.', 'Archivieren', true)) return;
          saveCustomer(Object.assign({}, cust, { archived: true })); close(); toast('Archiviert'); onDone();
        } }, '📦 Archivieren')) : null);
    });
  }

  /* ------------------------------------------------------------------
   * 4b. Export / Import / Backup
   * ------------------------------------------------------------------ */
  // Datei speichern: auf dem Handy über das Teilen-Menü (Dateien, iCloud, Mail …), sonst als Download
  async function saveFile(blob, name) {
    var file = null;
    try { file = new File([blob], name, { type: blob.type }); } catch (e) { /* ältere Browser */ }
    var touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (touch && file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return true; }
      catch (err) { if (err && err.name === 'AbortError') return false; /* sonst: Download versuchen */ }
    }
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    return true;
  }

  function exportCSV() {
    var all = allEntries();
    if (!all.length) { toast('Noch keine Einträge zum Exportieren'); return; }
    var blob = new Blob(['﻿' + L.toCSV(all, S.customers)], { type: 'text/csv;charset=utf-8' });
    saveFile(blob, 'eierliste-' + L.todayISO() + '.csv').then(function (ok) { if (ok) toast('CSV erstellt'); });
  }

  // Backup in zwei Schritten: erst erstellen, dann mit einem frischen Tipp speichern/teilen
  // (Safari erlaubt das Teilen-Menü nur direkt nach einem Tipp).
  async function makeBackup() {
    try {
      toast('Backup wird erstellt …');
      var photos = await DB.allPhotos();
      var payload = {
        app: 'eierliste', version: 1, exportedAt: new Date().toISOString(),
        settings: { defaultPriceCents: S.settings.defaultPriceCents },
        customers: S.customers, entries: allEntries(), weeks: Array.from(S.weeks.values()), photos: photos
      };
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      var mb = (blob.size / 1048576).toFixed(1).replace('.', ',');
      openSheet(function (close) {
        return h('div', null, h('h2', { text: 'Backup ist bereit' }),
          h('p', { text: payload.entries.length + ' Einträge, ' + payload.customers.length + ' Kunden, ' + photos.length + ' Fotos (' + mb + ' MB).' }),
          h('p', { class: 'muted small', text: 'Speichere die Datei an einem sicheren Ort, z. B. in „Dateien“/iCloud, Google Drive oder per E-Mail an dich selbst.' }),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn', type: 'button', onclick: close }, 'Abbrechen'),
            h('button', { class: 'btn primary', type: 'button', onclick: function () {
              saveFile(blob, 'eierliste-backup-' + L.todayISO() + '.json').then(function (ok) {
                if (!ok) return;
                saveSetting('lastBackupAt', payload.exportedAt);
                close(); toast('Backup gespeichert ✓'); route(true);
              });
            } }, '💾 Speichern / Teilen')));
      });
    } catch (err) { console.error(err); toast('⚠️ Backup fehlgeschlagen'); }
  }

  async function importBackup(file) {
    try {
      var data = L.normalizeBackup(JSON.parse(await readText(file)));
      if (!data.ok) { toast(data.error); return; }
      var when = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString('de-DE') : 'unbekanntes Datum';
      var ok = await confirmBox('Backup einspielen?',
        'Backup vom ' + when + ': ' + data.customers.length + ' Kunden, ' + data.entries.length + ' Einträge, ' + data.photos.length +
        ' Fotos. ACHTUNG: Das ersetzt alle aktuellen Daten auf diesem Gerät. Mach vorher ein Backup, falls du den aktuellen Stand noch brauchst.',
        'Ersetzen', true);
      if (!ok) return;
      await DB.replaceAll({
        settings: { defaultPriceCents: data.defaultPriceCents != null ? data.defaultPriceCents : S.settings.defaultPriceCents,
                    lastBackupAt: data.exportedAt },
        customers: data.customers, entries: data.entries, weeks: data.weeks, photos: data.photos
      });
      await loadState();
      toast('Backup eingespielt ✓');
      route(true);
    } catch (err) { console.error(err); toast('⚠️ Datei konnte nicht gelesen werden'); }
  }

  async function importCSV(file) {
    try {
      var res = L.fromCSV(await readText(file), S.customers, S.settings.defaultPriceCents);
      if (!res.entries.length) {
        toast(res.errors.length ? 'Import nicht möglich: ' + res.errors[0].msg : 'Keine Einträge in der Datei');
        return;
      }
      var overwrite = res.entries.filter(function (e) { return S.entries.has(e.key); }).length;
      var msg = res.entries.length + ' Einträge gefunden' +
        (res.newCustomers.length ? ', ' + res.newCustomers.length + ' neue Kunden (' + res.newCustomers.map(function (c) { return c.name; }).join(', ') + ')' : '') +
        (overwrite ? '. ' + overwrite + ' vorhandene Einträge (gleiche Woche + Kunde) werden überschrieben' : '') +
        (res.errors.length ? '. ' + res.errors.length + ' Zeilen übersprungen (z. B. Zeile ' + res.errors[0].line + ': ' + res.errors[0].msg + ')' : '') + '.';
      if (!await confirmBox('CSV importieren?', msg, 'Importieren')) return;
      if (res.newCustomers.length) { res.newCustomers.forEach(function (c) { S.customers.push(c); }); S.customers.sort(byName); await DB.putMany('customers', res.newCustomers); }
      res.entries.forEach(function (e) { S.entries.set(e.key, e); });
      await DB.putMany('entries', res.entries);
      toast(res.entries.length + ' Einträge importiert ✓');
      route(true);
    } catch (err) { console.error(err); toast('⚠️ Import fehlgeschlagen'); }
  }

  /* ------------------------------------------------------------------
   * 5. Router + Start
   * ------------------------------------------------------------------ */
  function route(keepScroll) {
    var y = window.scrollY;
    if (S.cleanup) { S.cleanup(); S.cleanup = null; }
    S.onResize = null;
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    var name = parts[0] || 'start';

    if (name === 'woche') {
      var wk = L.normalizeWeekKey(parts[1]);
      if (!wk) { location.replace('#/woche/' + (S.lastWeek || L.currentWeekKey())); return; }
      parts[1] = wk;
    }
    var app = $('#app');
    app.textContent = '';
    Array.prototype.forEach.call(document.querySelectorAll('#tabs a'), function (a) {
      var on = a.getAttribute('data-tab') === name || (name === 'start' && a.getAttribute('data-tab') === 'start');
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (name === 'woche') viewWeek(parts[1]);
    else if (name === 'offen') viewOpen();
    else if (name === 'verlauf') viewTrend();
    else if (name === 'mehr') viewMore();
    else viewStart();
    window.scrollTo(0, keepScroll === true ? y : 0);
  }

  function showFatal(err) {
    console.error(err);
    $('#app').append(h('div', { class: 'card' }, h('h2', { text: '⚠️ Speicher nicht verfügbar' }),
      h('p', { text: 'Die App kann hier keine Daten speichern: ' + (err && err.message ? err.message : err) }),
      h('p', { class: 'muted small', text: 'Hinweis: Im privaten Modus oder bei gesperrtem Website-Speicher funktioniert die Eierliste nicht. Bitte in einem normalen Browser-Fenster öffnen.' })));
  }

  async function init() {
    try {
      await DB.open();
      await loadState();
    } catch (err) { showFatal(err); return; }
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then(function (p) { S.persisted = p; }).catch(function () { /* egal */ });
    }
    window.addEventListener('hashchange', function () { route(false); });
    var resizeTimer;
    window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { if (S.onResize) S.onResize(); }, 120); });
    // Notiz sichern, wenn die App in den Hintergrund geht
    document.addEventListener('visibilitychange', function () { if (document.hidden && S.cleanup) S.cleanup(); });
    window.addEventListener('pagehide', function () { if (S.cleanup) S.cleanup(); });
    route(false);

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function (err) { console.warn('Service Worker:', err); });
    }
  }

  // Für Tests im Browser erreichbar machen (kein Einfluss auf die App)
  window.__eier = { S: S, route: route };
  init();
}());
