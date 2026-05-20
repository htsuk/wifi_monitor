define([], function() {

    var ROW_MAJOR_OUTPUT_MODE = "json_rows";

    // --- Helpers ---
    function chToFreq(ch) {
        ch = parseInt(ch, 10);
        if (ch <= 13) return 2407 + ch * 5;
        if (ch === 14) return 2484;
        return 5000 + ch * 5;
    }

    var CHANNELS_5  = [36,40,44,48,52,56,60,64,100,104,108,112,116,120,124,128,132,136,140,149,153,157,161,165];
    var CHANNELS_24 = [1,2,3,4,5,6,7,8,9,10,11,12,13];

    var NS = "display.visualizations.custom.wifi_channel_spectrum.wifi_channel_spectrum.";

    function getCfg(config, key, fallback) {
        if (!config) return fallback;
        var v = config[NS + key];
        if (v === undefined) v = config[key];
        return (v !== undefined && v !== "") ? v : fallback;
    }

    function hexToRgb(h) {
        if (!h || h.charAt(0) !== "#" || h.length < 7) return [100, 100, 100];
        return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
    }

    // Parse Splunk result data into AP objects.
    // Handles row-major {fields,rows}, column-major {fields,columns},
    // and wrapped {results:{...}} / {primary:{...}} structures.
    function parseData(data) {
        if (!data) return null;

        // Unwrap Dashboard Studio {primary:{...}} envelope
        if (data.primary && !data.fields) data = data.primary;

        // Unwrap {results:{...}} envelope
        var src = (data.results && data.results.fields) ? data.results : data;
        if (!src.fields) return null;

        var names = src.fields.map(function(f) { return typeof f === "object" ? f.name : f; });
        var idx = {
            ssid:    names.indexOf("ssid"),
            channel: names.indexOf("channel"),
            width:   names.indexOf("channel_width_mhz"),
            signal:  names.indexOf("signal_dbm"),
            classif: names.indexOf("classification"),
            bssid:   names.indexOf("bssid")
        };

        var aps = [];

        if (src.rows) {
            src.rows.forEach(function(row) {
                var ch = parseInt(row[idx.channel], 10);
                if (!ch || ch <= 0) return;
                aps.push({
                    ssid:      (idx.ssid >= 0 ? row[idx.ssid] : "") || "(hidden)",
                    channel:   ch,
                    widthMhz:  parseInt(idx.width  >= 0 ? row[idx.width]  : 20, 10) || 20,
                    signalDbm: parseFloat(idx.signal >= 0 ? row[idx.signal] : -90)   || -90,
                    classif:   idx.classif >= 0 ? (row[idx.classif] || "neighbour") : "neighbour",
                    bssid:     idx.bssid  >= 0 ? (row[idx.bssid]   || "")          : ""
                });
            });
        } else if (src.columns && src.columns.length) {
            var numRows = src.columns[0] ? src.columns[0].length : 0;
            for (var r = 0; r < numRows; r++) {
                var ch = parseInt(idx.channel >= 0 ? src.columns[idx.channel][r] : 0, 10);
                if (!ch || ch <= 0) continue;
                aps.push({
                    ssid:      (idx.ssid >= 0 ? src.columns[idx.ssid][r] : "") || "(hidden)",
                    channel:   ch,
                    widthMhz:  parseInt(idx.width  >= 0 ? src.columns[idx.width][r]  : 20, 10) || 20,
                    signalDbm: parseFloat(idx.signal >= 0 ? src.columns[idx.signal][r] : -90)   || -90,
                    classif:   idx.classif >= 0 ? (src.columns[idx.classif][r] || "neighbour") : "neighbour",
                    bssid:     idx.bssid  >= 0 ? (src.columns[idx.bssid][r]   || "")          : ""
                });
            }
        } else {
            return null;
        }

        return aps.length ? aps : null;
    }

    // Build frequency sections — groups of APs separated by gaps > GAP_MHZ.
    // Returns [{lo, hi}, ...] where lo/hi are MHz boundaries including padding.
    function buildSections(spans, freqMin, freqMax) {
        var GAP_MHZ = 100;
        var sorted = spans.slice().sort(function(a, b) { return a.lo - b.lo; });
        var sections = [];
        var curLo = freqMin, curHi = freqMin;
        sorted.forEach(function(s) {
            if (curHi === freqMin) { curLo = freqMin; curHi = s.hi + 10; return; }
            if (s.lo - curHi > GAP_MHZ) {
                sections.push({ lo: curLo, hi: curHi });
                curLo = s.lo - 10;
                curHi = s.hi + 10;
            } else {
                curHi = Math.max(curHi, s.hi + 10);
            }
        });
        sections.push({ lo: curLo, hi: Math.max(curHi, freqMax) });
        // Clamp to overall bounds
        sections[0].lo = Math.min(sections[0].lo, freqMin);
        sections[sections.length - 1].hi = Math.max(sections[sections.length - 1].hi, freqMax);
        return sections;
    }

    // --- Constructor ---
    // Dashboard Studio calls: new Viz(rootElement, appName, vizName) — first arg is a raw DOM node.
    // Legacy/classic Splunk calls: new Viz({el: element}).
    function WifiChannelSpectrum(elOrOptions) {
        var el;
        if (elOrOptions && elOrOptions.nodeType) {
            el = elOrOptions;
        } else {
            var options = elOrOptions || {};
            el = options.el;
            if (el && el.jquery) el = el[0];
        }
        this.el = el || document.body;

        this._canvas         = null;
        this._tooltip        = null;
        this._sliderDiv      = null;
        this._lastAps        = null;
        this._lastSpans      = null;
        this._dims           = null;
        this._resizeObs      = null;
        this._labelThreshold = -70; // dBm — neighbour label cutoff
        this._cfg            = { backgroundColor: "transparent", mineColor: "#4e9af1", neighbourColor: "#c77dff" };
        this._bound_draw     = this._draw.bind(this);
        this._bound_mm       = this._onMouseMove.bind(this);
        this._bound_ml       = this._onMouseLeave.bind(this);
    }

    WifiChannelSpectrum.prototype.initialize = function() {
        this.el.className = "wifi-channel-spectrum-viz";
    };

    WifiChannelSpectrum.prototype.getInitialDataParams = function() {
        return { outputMode: ROW_MAJOR_OUTPUT_MODE, count: 10000 };
    };

    WifiChannelSpectrum.prototype.formatData = function(data) {
        if (data && data.primary && !data.fields) data = data.primary;
        var aps = parseData(data);
        return aps !== null ? aps : data;
    };

    WifiChannelSpectrum.prototype.updateView = function(data, config) {
        if (!this._initialized) { this._initialized = true; this.initialize(); }
        this.el.className = "wifi-channel-spectrum-viz";

        var aps;
        if (Array.isArray(data)) {
            aps = data.length ? data : null;
        } else {
            aps = parseData(data);
        }

        this._lastAps = aps;

        if (!this._canvas) {
            this.el.innerHTML = "";
            this._canvas = document.createElement("canvas");
            this._canvas.style.cssText = "display:block;width:100%;height:100%;";
            this.el.appendChild(this._canvas);

            this._tooltip = document.createElement("div");
            this._tooltip.style.cssText = "display:none;position:absolute;background:rgba(0,0,0,.85);color:#e0e0e0;border:1px solid rgba(255,255,255,.2);border-radius:4px;padding:6px 10px;font-size:11px;font-family:monospace;line-height:1.6;pointer-events:none;white-space:nowrap;z-index:9999;";
            this.el.appendChild(this._tooltip);

            // Label threshold slider
            var self = this;
            this._sliderDiv = document.createElement("div");
            this._sliderDiv.style.cssText = "position:absolute;top:6px;right:8px;display:flex;align-items:center;gap:5px;z-index:10;";
            var lbl = document.createElement("span");
            lbl.style.cssText = "font:11px monospace;color:#8a9ab0;";
            lbl.textContent = "Labels ≥ " + this._labelThreshold + " dBm";
            var slider = document.createElement("input");
            slider.type = "range"; slider.min = "-90"; slider.max = "-30"; slider.step = "5";
            slider.value = String(this._labelThreshold);
            slider.style.cssText = "width:70px;cursor:pointer;accent-color:#4e9af1;";
            slider.addEventListener("input", function() {
                self._labelThreshold = parseInt(slider.value, 10);
                lbl.textContent = "Labels ≥ " + self._labelThreshold + " dBm";
                self._draw();
            });
            this._sliderDiv.appendChild(lbl);
            this._sliderDiv.appendChild(slider);
            this.el.appendChild(this._sliderDiv);

            this._canvas.addEventListener("mousemove", this._bound_mm);
            this._canvas.addEventListener("mouseleave", this._bound_ml);

            if (typeof ResizeObserver !== "undefined") {
                this._resizeObs = new ResizeObserver(this._bound_draw);
                this._resizeObs.observe(this.el);
            }
        }

        var self = this;
        window.requestAnimationFrame(function() { self._draw(); });
    };

    WifiChannelSpectrum.prototype._draw = function() {
        var canvas = this._canvas;
        var el     = this.el;
        if (!canvas) return;

        var w   = el.offsetWidth  || 800;
        var h   = el.offsetHeight || 320;
        var dpr = window.devicePixelRatio || 1;

        canvas.width  = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width  = w + "px";
        canvas.style.height = h + "px";

        var ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);

        ctx.clearRect(0, 0, w, h);
        var bg = this._cfg.backgroundColor;
        if (bg && bg !== "transparent" && bg !== "none") {
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, w, h);
        }

        var aps = this._lastAps;

        if (!aps || !aps.length) {
            ctx.fillStyle = "#7a8a9a";
            ctx.font = "14px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("Waiting for data…", w / 2, h / 2);
            return;
        }

        var PL = 60, PR = 20, PT = 30, PB = 40;
        var cw = w - PL - PR;
        var ch = h - PT - PB;

        var is5GHz      = aps.some(function(ap) { return ap.channel >= 36; });
        var channelList = is5GHz ? CHANNELS_5 : CHANNELS_24;

        var spans = aps.map(function(ap) {
            var cf = chToFreq(ap.channel);
            return { ap: ap, cf: cf, lo: cf - ap.widthMhz / 2, hi: cf + ap.widthMhz / 2 };
        });
        this._lastSpans = spans;

        var freqMin = is5GHz ? 5170 : 2400;
        var freqMax = is5GHz ? 5835 : 2495;
        spans.forEach(function(s) {
            if (s.lo - 10 < freqMin) freqMin = s.lo - 10;
            if (s.hi + 10 > freqMax) freqMax = s.hi + 10;
        });

        // Build frequency sections and piecewise X mapping
        var sections = buildSections(spans, freqMin, freqMax);
        var BREAK_PX = 26;
        var totalMhz = sections.reduce(function(acc, s) { return acc + (s.hi - s.lo); }, 0);
        var availCw  = cw - BREAK_PX * (sections.length - 1);
        var secLayout = [];
        var xCursor = PL;
        sections.forEach(function(sec) {
            var sw = availCw * (sec.hi - sec.lo) / totalMhz;
            secLayout.push({ lo: sec.lo, hi: sec.hi, xStart: xCursor, xWidth: sw });
            xCursor += sw + BREAK_PX;
        });

        function fx(f) {
            for (var i = 0; i < secLayout.length; i++) {
                var sl = secLayout[i];
                var nextLo = i < secLayout.length - 1 ? secLayout[i + 1].lo : Infinity;
                if (f < nextLo || i === secLayout.length - 1) {
                    return sl.xStart + (f - sl.lo) / (sl.hi - sl.lo) * sl.xWidth;
                }
            }
            return PL;
        }

        function sy(dbm) { return PT + (1 - (dbm + 95) / 75) * ch; }

        // Signal grid lines
        ctx.font = "11px monospace"; ctx.textAlign = "right";
        ctx.setLineDash([3, 4]);
        for (var dbm = -90; dbm <= -20; dbm += 10) {
            var gy = sy(dbm);
            ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(PL, gy); ctx.lineTo(PL + cw, gy); ctx.stroke();
            ctx.fillStyle = "#7a8a9a"; ctx.fillText(dbm, PL - 6, gy + 4);
        }
        ctx.setLineDash([]);

        // Channel grid lines (per section)
        ctx.font = "10px monospace"; ctx.textAlign = "center";
        ctx.setLineDash([2, 4]);
        channelList.forEach(function(cn) {
            var cf = chToFreq(cn);
            // Only render if this channel's freq falls inside a section
            var inSection = false;
            for (var i = 0; i < secLayout.length; i++) {
                if (cf >= secLayout[i].lo && cf <= secLayout[i].hi) { inSection = true; break; }
            }
            if (!inSection) return;
            var xp = fx(cf);
            ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(xp, PT); ctx.lineTo(xp, PT + ch); ctx.stroke();
            ctx.fillStyle = "#8a9ab0"; ctx.fillText(cn, xp, PT + ch + 14);
        });
        ctx.setLineDash([]);

        // Draw break indicators between sections
        if (secLayout.length > 1) {
            ctx.font = "bold 13px monospace";
            ctx.fillStyle = "rgba(255,255,255,0.35)";
            ctx.textAlign = "center";
            for (var bi = 0; bi < secLayout.length - 1; bi++) {
                var bx = secLayout[bi].xStart + secLayout[bi].xWidth + BREAK_PX / 2;
                ctx.fillText("//", bx, PT + ch / 2);
            }
        }

        // Build per-channel strongest-neighbour map for label thinning
        var labelThreshold = this._labelThreshold !== undefined ? this._labelThreshold : -70;
        var bestNeighbourDbm = {};
        spans.forEach(function(s) {
            if (s.ap.classif !== "mine") {
                var ch2 = s.ap.channel;
                if (bestNeighbourDbm[ch2] === undefined || s.ap.signalDbm > bestNeighbourDbm[ch2]) {
                    bestNeighbourDbm[ch2] = s.ap.signalDbm;
                }
            }
        });

        // AP shapes — weakest first so strongest renders on top
        var mineColor      = this._cfg.mineColor      || "#4e9af1";
        var neighbourColor = this._cfg.neighbourColor || "#c77dff";
        var sorted = spans.slice().sort(function(a, b) { return a.ap.signalDbm - b.ap.signalDbm; });
        sorted.forEach(function(s) {
            var x1 = fx(s.lo), x2 = fx(s.hi);
            var yt = sy(s.ap.signalDbm), yb = PT + ch;
            var bw = Math.max(x2 - x1, 2);
            var col = s.ap.classif === "mine" ? mineColor : neighbourColor;
            var rgb = hexToRgb(col);
            var r = rgb[0], g = rgb[1], b = rgb[2];

            var grad = ctx.createLinearGradient(0, yt, 0, yb);
            grad.addColorStop(0, "rgba(" + r + "," + g + "," + b + ",0.55)");
            grad.addColorStop(1, "rgba(" + r + "," + g + "," + b + ",0.08)");
            ctx.fillStyle = grad;
            ctx.fillRect(x1, yt, bw, yb - yt);

            ctx.strokeStyle = "rgba(" + r + "," + g + "," + b + ",0.95)";
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(x1, yt); ctx.lineTo(x2, yt); ctx.stroke();

            ctx.strokeStyle = "rgba(" + r + "," + g + "," + b + ",0.4)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x1, yt); ctx.lineTo(x1, yb);
            ctx.moveTo(x2, yt); ctx.lineTo(x2, yb);
            ctx.stroke();

            // Label rules:
            //   "mine" APs: always label if bar is wide enough
            //   neighbours: label only if signal >= threshold AND this is the strongest on its channel
            var isMine = s.ap.classif === "mine";
            var isStrongestNeighbour = !isMine && (bestNeighbourDbm[s.ap.channel] === s.ap.signalDbm);
            var minBw = isMine ? 20 : 32;
            var showLabel = s.ap.ssid && bw > minBw && (
                isMine ||
                (s.ap.signalDbm >= labelThreshold && isStrongestNeighbour)
            );

            if (showLabel) {
                var lx = (x1 + x2) / 2, ly = yt - 7;
                if (ly < PT + 12) ly = yt + 14;
                ctx.fillStyle = "rgba(" + r + "," + g + "," + b + ",1)";
                ctx.font = (isMine ? "bold " : "") + "11px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(s.ap.ssid, lx, ly, bw - 4);
            }
        });

        // Chart border & X label
        ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.lineWidth = 1;
        ctx.strokeRect(PL, PT, cw, ch);
        ctx.fillStyle = "#6a7a8a"; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
        ctx.fillText("Channel", PL + cw / 2, h - 6);

        this._dims = { PL: PL, PT: PT, cw: cw, ch: ch, fx: fx, sy: sy };
    };

    WifiChannelSpectrum.prototype._onMouseMove = function(e) {
        var tooltip = this._tooltip, spans = this._lastSpans, dims = this._dims;
        if (!spans || !dims || !tooltip) return;
        var rect = this._canvas.getBoundingClientRect();
        var mx = e.clientX - rect.left, my = e.clientY - rect.top;

        var hit = null;
        var desc = spans.slice().sort(function(a, b) { return b.ap.signalDbm - a.ap.signalDbm; });
        for (var i = 0; i < desc.length; i++) {
            var s = desc[i];
            var x1 = dims.fx(s.lo), x2 = dims.fx(s.hi);
            var yt = dims.sy(s.ap.signalDbm), yb = dims.PT + dims.ch;
            if (mx >= x1 && mx <= x2 && my >= yt && my <= yb) { hit = s; break; }
        }
        if (!hit) { tooltip.style.display = "none"; return; }

        var ap = hit.ap;
        var col = ap.classif === "mine" ? (this._cfg.mineColor || "#4e9af1") : (this._cfg.neighbourColor || "#c77dff");
        tooltip.innerHTML =
            '<span style="color:' + col + '">&#9632;</span> <b>' + ap.ssid + '</b><br>' +
            'BSSID: ' + ap.bssid + '<br>' +
            'Ch ' + ap.channel + ' &bull; ' + ap.widthMhz + ' MHz<br>' +
            ap.signalDbm + ' dBm &bull; ' + ap.classif;
        tooltip.style.display = "block";
        var tx = mx + 14, ty = my - 10;
        if (tx + 190 > this.el.offsetWidth)  tx = mx - 200;
        if (ty +  90 > this.el.offsetHeight) ty = my - 100;
        tooltip.style.left = tx + "px"; tooltip.style.top = ty + "px";
    };

    WifiChannelSpectrum.prototype._onMouseLeave = function() {
        if (this._tooltip) this._tooltip.style.display = "none";
    };

    // --- Full SplunkVisualizationBase interface ---

    WifiChannelSpectrum.prototype.setCurrentConfig = function(config) {
        this._currentConfig = config || {};
        this._cfg = {
            backgroundColor: getCfg(config, "backgroundColor", "transparent"),
            mineColor:       getCfg(config, "mineColor",       "#4e9af1"),
            neighbourColor:  getCfg(config, "neighbourColor",  "#c77dff")
        };
        if (this._canvas) this._draw();
    };

    WifiChannelSpectrum.prototype.setCurrentData = function(data) {
        this.updateView(data, this._currentConfig);
    };

    WifiChannelSpectrum.prototype.getCurrentConfig = function() {
        return this._currentConfig || {};
    };

    WifiChannelSpectrum.prototype.combineData = function(primaryData, secondaryData) {
        return (primaryData && primaryData.primary) ? primaryData.primary : primaryData;
    };

    WifiChannelSpectrum.prototype.getPropertyNamespaceInfo = function() {
        return {
            propertyNamespace: "display.visualizations.custom.wifi_channel_spectrum.wifi_channel_spectrum.",
            type: "wifi_channel_spectrum.wifi_channel_spectrum"
        };
    };

    WifiChannelSpectrum.prototype.shouldDrawChart = function(data) {
        return data !== null && data !== undefined;
    };

    WifiChannelSpectrum.prototype.hasInitialData = function() {
        return this._lastAps !== null && this._lastAps !== undefined;
    };

    WifiChannelSpectrum.prototype.getFormattedData = function() {
        return this._lastAps;
    };

    WifiChannelSpectrum.prototype.invalidateReflow = function() {
        this.reflow();
    };

    WifiChannelSpectrum.prototype.invalidateUpdateView = function() {
        if (this._lastAps !== null) {
            this.updateView(this._lastAps, this._currentConfig);
        }
    };

    WifiChannelSpectrum.prototype.reflow = function() {
        var self = this;
        window.requestAnimationFrame(function() { self._draw(); });
    };

    WifiChannelSpectrum.prototype.remove = function() {
        if (this._resizeObs) this._resizeObs.disconnect();
        if (this._canvas) {
            this._canvas.removeEventListener("mousemove", this._bound_mm);
            this._canvas.removeEventListener("mouseleave", this._bound_ml);
        }
    };

    return WifiChannelSpectrum;
});
