/* =====================================================================
 * minichart.js – kleines Balkendiagramm (Canvas, gestapelt), ohne Bibliothek
 * ---------------------------------------------------------------------
 * MiniChart.draw(canvas, { labels, series:[{name,color,values}], selected })
 *   -> gibt eine Funktion zurück, die zu einer x-Position den Balkenindex liefert
 * Farben für Achsen/Raster kommen aus den CSS-Variablen (Hell-/Dunkelmodus).
 * ===================================================================== */
(function (root) {
  'use strict';

  function niceMax(v) {                    // nächste "runde" Obergrenze: 5, 10, 20, 25, 50, 100 ...
    if (v <= 5) return 5;
    var pow = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * pow >= v) return steps[i] * pow;
    return 10 * pow;
  }

  function draw(canvas, opts) {
    var dpr = root.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    var cs = root.getComputedStyle(canvas);
    var muted = cs.getPropertyValue('--muted').trim() || '#777';
    var grid = cs.getPropertyValue('--line').trim() || '#ddd';
    var fg = cs.getPropertyValue('--fg').trim() || '#000';
    var font = '12px ' + (cs.fontFamily || 'sans-serif');

    var n = opts.labels.length;
    var padL = 34, padR = 6, padT = 16, padB = 24;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var totals = [];
    for (var i = 0; i < n; i++) {
      var sum = 0;
      opts.series.forEach(function (s) { sum += s.values[i] || 0; });
      totals.push(sum);
    }
    var max = niceMax(Math.max.apply(null, totals.concat([1])));

    // Raster + y-Beschriftung
    ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    for (var t = 0; t <= 4; t++) {
      var y = padT + plotH - (plotH * t / 4);
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + .5); ctx.lineTo(w - padR, Math.round(y) + .5); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(String(Math.round(max * t / 4 * 10) / 10), padL - 6, y);
    }

    var slot = plotW / n, bw = Math.max(2, Math.min(slot * 0.7, 42));
    // markierter Balken
    if (opts.selected != null && opts.selected >= 0 && opts.selected < n) {
      ctx.fillStyle = grid;
      ctx.fillRect(padL + slot * opts.selected, padT, slot, plotH);
    }
    // Balken (gestapelt)
    for (var k = 0; k < n; k++) {
      var x = padL + slot * k + (slot - bw) / 2, acc = 0;
      opts.series.forEach(function (s) {
        var v = s.values[k] || 0;
        if (v <= 0) return;
        var bh = plotH * v / max;
        ctx.fillStyle = s.color;
        ctx.fillRect(x, padT + plotH - (acc + bh) * 1, bw, Math.max(1, bh));
        acc += bh;
      });
      // Zahl über dem Balken (nur wenn genug Platz)
      if (totals[k] > 0 && slot >= 30) {
        ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(String(totals[k]), x + bw / 2, padT + plotH - plotH * totals[k] / max - 2);
      }
    }
    // x-Beschriftung: nicht jede Woche, wenn es eng wird; die letzte Woche ist immer beschriftet
    var every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 30))));
    ctx.fillStyle = muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var j = 0; j < n; j++) {
      if ((n - 1 - j) % every === 0) ctx.fillText(opts.labels[j], padL + slot * j + slot / 2, padT + plotH + 6);
    }

    return function indexAt(clientX) {
      var rect = canvas.getBoundingClientRect();
      var i2 = Math.floor((clientX - rect.left - padL) / slot);
      return i2 >= 0 && i2 < n ? i2 : -1;
    };
  }

  root.MiniChart = { draw: draw };
}(typeof self !== 'undefined' ? self : this));
