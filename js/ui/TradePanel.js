/**
 * TradePanel.js — Binary-options style trade panel (DEMO / paper trading).
 *
 * Adds to the chart:
 *   - Balance (virtual money, resettable)
 *   - Stake input with  − / +  and quick chips
 *   - Expiry selector (30s … 15m) and payout %
 *   - HIGHER (call, green) and LOWER (put, red) buttons
 *   - Open trades with live countdown and winning/losing state
 *   - Recent results history
 *   - Dashed entry lines + arrows on the main chart for open trades
 *
 * Settlement: when a trade expires, the latest price is compared with the
 * entry price. HIGHER wins if price > entry, LOWER wins if price < entry.
 * Win pays stake * (1 + payout). Loss forfeits the stake. Equal price
 * refunds the stake.
 *
 * NOTE: this is a simulation only. It is not connected to any broker or
 * real-money account.
 */
import { DomUtils } from '../utils/DomUtils.js';

const EXPIRIES = [
    { label: '30s', ms: 30_000 },
    { label: '1m',  ms: 60_000 },
    { label: '2m',  ms: 120_000 },
    { label: '5m',  ms: 300_000 },
    { label: '15m', ms: 900_000 }
];

export class TradePanel {
    constructor(engine, parent, opts = {}) {
        this.engine = engine;
        this.parent = parent;
        this.startBalance = opts.balance ?? 10000;
        this.payout = opts.payout ?? 0.85;
        this.balance = this.startBalance;
        this.stake = opts.stake ?? 10;
        this.expiryMs = opts.expiryMs ?? 60_000;
        this.trades = [];   // open
        this.history = [];  // closed (newest first, max 8)
        this._id = 1;
        this._build();
        this._timer = setInterval(() => this._tick(), 250);
        this._renderAll();
    }

    // ------------------------------------------------------------ price
    get price() {
        const dm = this.engine.dataManager;
        if (!dm || dm.size === 0) return NaN;
        return dm.raw().closes[dm.size - 1];
    }
    _fmt(n) {
        if (!isFinite(n)) return '—';
        const d = Math.abs(n) >= 100 ? 2 : Math.abs(n) >= 1 ? 4 : 6;
        return n.toFixed(d);
    }
    _money(n) {
        return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // ------------------------------------------------------------ DOM
    _build() {
        const el = DomUtils.el;
        this.root = el('div', { class: 'ac-trade' });

        this.elBalance = el('div', { class: 'ac-trade-balance-val' });
        const reset = el('button', { class: 'ac-trade-reset', title: 'Reset demo balance' }, '↺');
        reset.addEventListener('click', () => this.reset());
        const head = el('div', { class: 'ac-trade-head' }, [
            el('div', {}, [
                el('div', { class: 'ac-trade-demo' }, 'DEMO ACCOUNT'),
                this.elBalance
            ]),
            reset
        ]);

        // Expiry
        this.expiryBtns = EXPIRIES.map(x => {
            const b = el('button', { class: 'ac-trade-chip' }, x.label);
            b.addEventListener('click', () => { this.expiryMs = x.ms; this._renderAll(); });
            b._ms = x.ms;
            return b;
        });
        const expiryRow = el('div', { class: 'ac-trade-chips' }, this.expiryBtns);

        // Stake
        this.inStake = el('input', { class: 'ac-trade-input', type: 'number', min: '1', step: '1' });
        this.inStake.addEventListener('input', () => {
            this.stake = Math.max(0, parseFloat(this.inStake.value) || 0);
            this._renderInfo();
        });
        const minus = el('button', { class: 'ac-trade-step' }, '−');
        const plus = el('button', { class: 'ac-trade-step' }, '+');
        minus.addEventListener('click', () => this._setStake(Math.max(1, this.stake - this._stepSize())));
        plus.addEventListener('click', () => this._setStake(this.stake + this._stepSize()));
        const stakeRow = el('div', { class: 'ac-trade-stake' }, [minus, this.inStake, plus]);

        const quick = el('div', { class: 'ac-trade-chips ac-trade-quick' },
            [['½', () => this.stake / 2], ['2×', () => this.stake * 2], ['Max', () => this.balance]].map(([t, f]) => {
                const b = el('button', { class: 'ac-trade-chip' }, t);
                b.addEventListener('click', () => this._setStake(Math.max(1, Math.floor(f()))));
                return b;
            }));

        this.elInfo = el('div', { class: 'ac-trade-info' });

        // Buttons
        this.btnUp = el('button', { class: 'ac-trade-btn ac-trade-up' }, [
            el('span', { class: 'ac-trade-arrow' }, '▲'), el('span', {}, 'HIGHER')
        ]);
        this.btnDown = el('button', { class: 'ac-trade-btn ac-trade-down' }, [
            el('span', { class: 'ac-trade-arrow' }, '▼'), el('span', {}, 'LOWER')
        ]);
        this.btnUp.addEventListener('click', () => this.open('up'));
        this.btnDown.addEventListener('click', () => this.open('down'));

        this.elOpen = el('div', { class: 'ac-trade-list' });
        this.elHist = el('div', { class: 'ac-trade-list ac-trade-hist' });

        // Collapse toggle (useful on small screens)
        this.toggle = el('button', { class: 'ac-trade-toggle', title: 'Show/hide trade panel' }, '⇅');
        this.toggle.addEventListener('click', () => this.root.classList.toggle('ac-trade-collapsed'));

        this.body = el('div', { class: 'ac-trade-body' }, [
            head,
            el('div', { class: 'ac-trade-label' }, 'Expiry'), expiryRow,
            el('div', { class: 'ac-trade-label' }, 'Amount'), stakeRow, quick,
            this.elInfo,
            el('div', { class: 'ac-trade-btns' }, [this.btnUp, this.btnDown]),
            el('div', { class: 'ac-trade-label' }, 'Open trades'), this.elOpen,
            el('div', { class: 'ac-trade-label' }, 'Results'), this.elHist
        ]);
        this.root.append(this.toggle, this.body);
        // Don't let panel interactions reach the chart canvas.
        ['mousedown', 'pointerdown', 'touchstart', 'wheel', 'dblclick'].forEach(t =>
            this.root.addEventListener(t, e => e.stopPropagation(), { passive: true }));
        this.parent.appendChild(this.root);
    }
    _stepSize() { return this.stake >= 1000 ? 100 : this.stake >= 100 ? 10 : 5; }
    _setStake(v) { this.stake = v; this._renderAll(); }

    // ------------------------------------------------------------ trading
    open(dir) {
        const price = this.price;
        if (!isFinite(price)) return this._flash('No price data yet');
        if (this.stake < 1) return this._flash('Minimum stake is $1');
        if (this.stake > this.balance) return this._flash('Insufficient balance');
        const dm = this.engine.dataManager;
        const now = Date.now();
        this.balance -= this.stake;
        this.trades.push({
            id: this._id++, dir, stake: this.stake, entry: price,
            symbol: this.engine.symbol, opened: now, expires: now + this.expiryMs,
            barTime: dm.raw().times[dm.size - 1]
        });
        this._renderAll();
        this.engine.requestRender();
    }

    _tick() {
        const now = Date.now();
        const price = this.price;
        let settled = false;
        for (let i = this.trades.length - 1; i >= 0; i--) {
            const t = this.trades[i];
            if (now >= t.expires && isFinite(price)) {
                this._settle(t, price);
                this.trades.splice(i, 1);
                settled = true;
            }
        }
        if (this.trades.length || settled) {
            this._renderOpen();
            if (settled) { this._renderHist(); this._renderBalance(); }
            this.engine.requestRender();
        }
    }

    _settle(t, price, refund = false) {
        let result, pnl;
        if (refund || price === t.entry) { result = 'tie'; pnl = 0; this.balance += t.stake; }
        else {
            const win = t.dir === 'up' ? price > t.entry : price < t.entry;
            if (win) { result = 'win'; pnl = t.stake * this.payout; this.balance += t.stake + pnl; }
            else { result = 'loss'; pnl = -t.stake; }
        }
        this.history.unshift({ ...t, close: price, result, pnl });
        if (this.history.length > 8) this.history.pop();
    }

    /** Called by the engine when the symbol changes: prices aren't comparable, so refund. */
    onSymbolChange() {
        if (!this.trades.length) return;
        for (const t of this.trades) this._settle(t, t.entry, true);
        this.trades = [];
        this._renderAll();
    }

    reset() {
        this.balance = this.startBalance;
        this.trades = [];
        this.history = [];
        this._renderAll();
        this.engine.requestRender();
    }

    // ------------------------------------------------------------ render
    _renderAll() {
        this.inStake.value = this.stake;
        this.expiryBtns.forEach(b => b.classList.toggle('active', b._ms === this.expiryMs));
        this._renderBalance(); this._renderInfo(); this._renderOpen(); this._renderHist();
    }
    _renderBalance() { this.elBalance.textContent = this._money(this.balance); }
    _renderInfo() {
        const profit = this.stake * this.payout;
        this.elInfo.innerHTML =
            `<span>Payout <b>${Math.round(this.payout * 100)}%</b></span>` +
            `<span>Profit <b class="ac-trade-pos">+${this._money(profit)}</b></span>`;
        const dis = this.stake > this.balance || this.stake < 1;
        this.btnUp.disabled = this.btnDown.disabled = dis;
    }
    _renderOpen() {
        const now = Date.now(), price = this.price;
        if (!this.trades.length) { this.elOpen.innerHTML = '<div class="ac-trade-empty">No open trades</div>'; return; }
        this.elOpen.innerHTML = this.trades.map(t => {
            const winning = t.dir === 'up' ? price > t.entry : price < t.entry;
            const flat = price === t.entry;
            const s = Math.max(0, Math.ceil((t.expires - now) / 1000));
            const cd = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
            const cls = flat ? '' : winning ? 'ac-trade-pos' : 'ac-trade-neg';
            return `<div class="ac-trade-row">
                <span class="${t.dir === 'up' ? 'ac-trade-pos' : 'ac-trade-neg'}">${t.dir === 'up' ? '▲' : '▼'}</span>
                <span class="ac-trade-grow">${this._fmt(t.entry)}</span>
                <span>${this._money(t.stake)}</span>
                <span class="${cls}">${cd}</span></div>`;
        }).join('');
    }
    _renderHist() {
        if (!this.history.length) { this.elHist.innerHTML = '<div class="ac-trade-empty">No results yet</div>'; return; }
        this.elHist.innerHTML = this.history.map(h => {
            const cls = h.result === 'win' ? 'ac-trade-pos' : h.result === 'loss' ? 'ac-trade-neg' : '';
            const sign = h.pnl > 0 ? '+' : '';
            return `<div class="ac-trade-row">
                <span class="${h.dir === 'up' ? 'ac-trade-pos' : 'ac-trade-neg'}">${h.dir === 'up' ? '▲' : '▼'}</span>
                <span class="ac-trade-grow">${this._fmt(h.entry)} → ${this._fmt(h.close)}</span>
                <span class="${cls}">${h.result === 'tie' ? 'Refund' : sign + this._money(h.pnl)}</span></div>`;
        }).join('');
    }
    _flash(msg) {
        this.elInfo.innerHTML = `<span class="ac-trade-neg">${msg}</span>`;
        clearTimeout(this._flashT);
        this._flashT = setTimeout(() => this._renderInfo(), 1600);
    }

    // ------------------------------------------------------------ chart overlay
    /** Dashed entry line + arrow for each open trade (called from ChartEngine). */
    drawMain(ctx, viewport, dm, theme) {
        if (!this.trades.length) return;
        const chartW = viewport.width - 70;
        const now = Date.now();
        ctx.save();
        ctx.font = '600 10px Inter, sans-serif';
        ctx.textBaseline = 'middle';
        for (const t of this.trades) {
            if (t.symbol !== this.engine.symbol) continue;
            const y = viewport.priceToY(t.entry);
            const idx = dm.indexAtTime(t.barTime);
            const x0 = Math.max(0, viewport.indexToX(idx) + viewport.barSpacing / 2);
            const col = t.dir === 'up' ? '#16C784' : '#EA3943';
            ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
            ctx.setLineDash([5, 4]);
            ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(chartW, y); ctx.stroke();
            ctx.setLineDash([]);
            // entry arrow
            const s = 6, ax = Math.min(x0, chartW - 10);
            ctx.beginPath();
            if (t.dir === 'up') { ctx.moveTo(ax, y - s); ctx.lineTo(ax - s * 0.7, y + s * 0.4); ctx.lineTo(ax + s * 0.7, y + s * 0.4); }
            else { ctx.moveTo(ax, y + s); ctx.lineTo(ax - s * 0.7, y - s * 0.4); ctx.lineTo(ax + s * 0.7, y - s * 0.4); }
            ctx.closePath(); ctx.fill();
            // label with countdown
            const sec = Math.max(0, Math.ceil((t.expires - now) / 1000));
            const label = `${t.dir === 'up' ? 'HIGHER' : 'LOWER'}  ${this._money(t.stake)}  ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
            const w = ctx.measureText(label).width + 12;
            const lx = chartW - w - 4;
            ctx.fillRect(lx, y - 9, w, 18);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, lx + 6, y);
        }
        ctx.restore();
    }

    destroy() {
        clearInterval(this._timer);
        clearTimeout(this._flashT);
        this.root.remove();
    }
}
