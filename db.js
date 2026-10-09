/* =====================================================================
 * db.js – dünne Schicht über IndexedDB (alles lokal im Browser, offline)
 * ---------------------------------------------------------------------
 * Object-Stores
 *   settings  { key, value }            Einstellungen (Standardpreis, letztes Backup)
 *   customers { id, name, ... }         Kunden
 *   entries   { key, week, ... }        Verkaufseinträge (Woche x Kunde)
 *   weeks     { week, note }            Wochennotizen
 *   photos    { week, data, updatedAt } Zettel-Foto als komprimierte Data-URL
 * Fotos liegen in einem eigenen Store, damit die normalen Daten schnell laden.
 * ===================================================================== */
(function (root) {
  'use strict';

  var NAME = 'eierliste', VERSION = 1;
  var STORES = ['settings', 'customers', 'entries', 'weeks', 'photos'];
  var db = null;

  function open() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error('IndexedDB ist in diesem Browser nicht verfügbar.')); return; }
      var req = root.indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        d.createObjectStore('settings', { keyPath: 'key' });
        d.createObjectStore('customers', { keyPath: 'id' });
        d.createObjectStore('entries', { keyPath: 'key' });
        d.createObjectStore('weeks', { keyPath: 'week' });
        d.createObjectStore('photos', { keyPath: 'week' });
      };
      req.onsuccess = function () {
        db = req.result;
        db.onversionchange = function () { db.close(); };
        resolve();
      };
      req.onerror = function () { reject(req.error || new Error('Datenbank konnte nicht geöffnet werden.')); };
      req.onblocked = function () { reject(new Error('Datenbank ist blockiert (andere Tab schließen).')); };
    });
  }

  // Führt fn(transaction, setResult) aus und liefert das Ergebnis, sobald die Transaktion fertig ist.
  function run(stores, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(stores, mode), out;
      t.oncomplete = function () { resolve(out); };
      t.onabort = function () { reject(t.error || new Error('Speichern abgebrochen.')); };
      fn(t, function (v) { out = v; });
    });
  }

  function getAll(t, store, set) {
    var r = t.objectStore(store).getAll();
    r.onsuccess = function () { set(r.result); };
  }

  function loadAll() {
    var res = {};
    return run(['settings', 'customers', 'entries', 'weeks'], 'readonly', function (t) {
      ['settings', 'customers', 'entries', 'weeks'].forEach(function (s) {
        getAll(t, s, function (v) { res[s] = v; });
      });
    }).then(function () {
      var settings = {};
      res.settings.forEach(function (r) { settings[r.key] = r.value; });
      return { settings: settings, customers: res.customers, entries: res.entries, weeks: res.weeks };
    });
  }

  function put(store, obj) { return run([store], 'readwrite', function (t) { t.objectStore(store).put(obj); }); }
  function putMany(store, list) {
    return run([store], 'readwrite', function (t) { list.forEach(function (o) { t.objectStore(store).put(o); }); });
  }
  function del(store, key) { return run([store], 'readwrite', function (t) { t.objectStore(store).delete(key); }); }
  function setSetting(key, value) { return put('settings', { key: key, value: value }); }

  function getPhoto(week) {
    return run(['photos'], 'readonly', function (t, set) {
      var r = t.objectStore('photos').get(week);
      r.onsuccess = function () { set(r.result); };
    });
  }
  function allPhotos() { return run(['photos'], 'readonly', function (t, set) { getAll(t, 'photos', set); }); }
  function countPhotos() {
    return run(['photos'], 'readonly', function (t, set) {
      var r = t.objectStore('photos').count();
      r.onsuccess = function () { set(r.result); };
    });
  }

  // Ersetzt ALLE Daten (Backup einspielen) in einer einzigen Transaktion:
  // geht etwas schief, bleibt der alte Stand komplett erhalten.
  function replaceAll(data) {
    return run(STORES, 'readwrite', function (t) {
      STORES.forEach(function (s) { t.objectStore(s).clear(); });
      Object.keys(data.settings || {}).forEach(function (k) { t.objectStore('settings').put({ key: k, value: data.settings[k] }); });
      (data.customers || []).forEach(function (o) { t.objectStore('customers').put(o); });
      (data.entries || []).forEach(function (o) { t.objectStore('entries').put(o); });
      (data.weeks || []).forEach(function (o) { t.objectStore('weeks').put(o); });
      (data.photos || []).forEach(function (o) { t.objectStore('photos').put(o); });
    });
  }

  root.EierDB = {
    open: open, loadAll: loadAll, put: put, putMany: putMany, del: del, setSetting: setSetting,
    getPhoto: getPhoto, allPhotos: allPhotos, countPhotos: countPhotos, replaceAll: replaceAll
  };
}(typeof self !== 'undefined' ? self : this));
