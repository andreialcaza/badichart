/**
 * AC.js — Acceleration Oscillator (Bill Williams).
 *
 *   AO      = SMA(median, 5) - SMA(median, 34),   median = (H + L) / 2
 *   AC      = AO - SMA(AO, 5)
 *
 * Zero-centred histogram coloured by direction (same scheme as AO).
 */
import { IndicatorBase } from '../IndicatorBase.js';

export class AC extends IndicatorBase {
    constructor(opts = {}) {
        super(opts);
        this.name = 'AC';
        this.type = 'pane';
        this.color  = opts.color  || '#16C784'; // up rising
        this.color2 = opts.color2 || '#EA3943'; // down falling
    }
    defaultOptions() { return { fast: 5, slow: 34, signal: 5, showArrows: true }; }

    calculate(dm) {
        const { highs, lows } = dm.raw();
        const n = highs.length;
        const median = new Float64Array(n);
        for (let i = 0; i < n; i++) median[i] = (highs[i] + lows[i]) / 2;
        const fast = this._sma(median, this.options.fast);
        const slow = this._sma(median, this.options.slow);
        const ao = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            ao[i] = (isFinite(fast[i]) && isFinite(slow[i])) ? fast[i] - slow[i] : NaN;
        }
        const aoSma = this._smaRobust(ao, this.options.signal);
        const ac = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            ac[i] = (isFinite(ao[i]) && isFinite(aoSma[i])) ? ao[i] - aoSma[i] : NaN;
        }
        this.buffers.ac = ac;

        // Reversal signals: +1 = AC turns from falling to rising (bullish),
        // -1 = AC turns from rising to falling (bearish). A bar with no change
        // in AC (flat) inherits the previous direction so it can't fake a turn.
        const sig = new Int8Array(n);
        let dir = 0;
        for (let i = 1; i < n; i++) {
            if (!isFinite(ac[i]) || !isFinite(ac[i - 1])) { dir = 0; continue; }
            const d = ac[i] > ac[i - 1] ? 1 : ac[i] < ac[i - 1] ? -1 : dir;
            if (dir !== 0 && d !== dir) sig[i] = d;
            dir = d;
        }
        this.buffers.signals = sig;
    }

    visibleRange(viewport, dm) {
        this.ensureCalculated(dm);
        const buf = this.buffers.ac;
        if (!buf) return { min: -1, max: 1 };
        const left = Math.max(0, Math.floor(viewport.leftEdge));
        const right = Math.min(buf.length - 1, Math.ceil(viewport.rightEdge));
        let min = Infinity, max = -Infinity;
        for (let i = left; i <= right; i++) {
            const v = buf[i];
            if (isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
        }
        if (!isFinite(min) || !isFinite(max)) return { min: -1, max: 1 };
        if (min > 0) min = 0;
        if (max < 0) max = 0;
        const pad = (max - min) * 0.1 || 1;
        return { min: min - pad, max: max + pad };
    }

    draw(ctx, viewport, dm, pane, theme) {
        this.ensureCalculated(dm);
        const buf = this.buffers.ac;
        if (!buf) return;
        const right = viewport.width - 70;
        const y0 = this._priceToY(0, viewport, pane);
        ctx.strokeStyle = theme.gridLine || '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y0); ctx.lineTo(right, y0);
        ctx.stroke();
        const leftIdx = Math.max(0, Math.floor(viewport.leftEdge));
        const rightIdx = Math.min(buf.length - 1, Math.ceil(viewport.rightEdge));
        const bw = Math.max(1, viewport.barSpacing * 0.7);
        ctx.save();
        this._clipToPane(ctx, viewport, pane);
        for (let i = leftIdx; i <= rightIdx; i++) {
            const v = buf[i];
            if (!isFinite(v)) continue;
            const x = viewport.indexToX(i) + viewport.barSpacing / 2;
            const yv = this._priceToY(v, viewport, pane);
            const top = Math.min(yv, y0);
            const h = Math.abs(yv - y0);
            const rising = i > 0 && isFinite(buf[i - 1]) && v >= buf[i - 1];
            const positive = v >= 0;
            ctx.fillStyle = positive
                ? (rising ? this.color  : this._withAlpha(this.color,  0.5))
                : (rising ? this._withAlpha(this.color2, 0.5) : this.color2);
            ctx.fillRect(x - bw / 2, top, bw, Math.max(1, h));
        }
        ctx.restore();
    }

    /**
     * Called by ChartEngine on the MAIN price pane (pane indicators normally
     * only draw in their own pane). Draws reversal arrows: green up arrow
     * below the low on a bullish AC turn, red down arrow above the high on a
     * bearish AC turn.
     */
    drawMain(ctx, viewport, dm, theme) {
        if (this.options.showArrows === false) return;
        this.ensureCalculated(dm);
        const sig = this.buffers.signals;
        if (!sig) return;
        const { highs, lows } = dm.raw();
        const spacing = viewport.barSpacing;
        if (spacing < 3) return;
        const leftIdx = Math.max(1, Math.floor(viewport.leftEdge));
        const rightIdx = Math.min(sig.length - 1, Math.ceil(viewport.rightEdge));
        const s = Math.max(5, Math.min(12, spacing * 0.6));
        ctx.save();
        ctx.lineJoin = 'round';
        for (let i = leftIdx; i <= rightIdx; i++) {
            if (!sig[i]) continue;
            const x = viewport.indexToX(i) + spacing / 2;
            const buy = sig[i] === 1;
            const y = buy ? viewport.priceToY(lows[i]) + 4
                          : viewport.priceToY(highs[i]) - 4;
            const dirY = buy ? 1 : -1;       // arrow extends away from the candle
            const tipY = y;                   // tip touches near the candle
            const baseY = y + dirY * s;
            ctx.fillStyle = buy ? this.color : this.color2;
            ctx.beginPath();
            ctx.moveTo(x, tipY);
            ctx.lineTo(x - s * 0.6, baseY);
            ctx.lineTo(x + s * 0.6, baseY);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }
}
