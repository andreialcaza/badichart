/**
 * DataFeed.js
 * Real market data from Binance (public endpoints, no API key needed).
 *
 *  - History : REST   GET /api/v3/klines          (paged, up to 1000 per call)
 *  - Live    : WebSocket  <symbol>@kline_<interval>  (updates the forming candle)
 *
 * The chart engine only relies on:
 *      loadHistory(count)  -> Promise   replaces the DataManager contents
 *      start() / stop()                 live WebSocket on / off
 *      isRunning, onTick, onStatus
 */

const REST_HOSTS = [
    'https://api.binance.com',
    'https://data-api.binance.vision'
];
const WS_HOSTS = [
    'wss://stream.binance.com:9443/ws/',
    'wss://data-stream.binance.vision/ws/'
];

// ms -> Binance interval string
const INTERVAL_MAP = {
    60_000: '1m',
    300_000: '5m',
    900_000: '15m',
    3_600_000: '1h',
    14_400_000: '4h',
    86_400_000: '1d',
    604_800_000: '1w'
};

export class DataFeed {
    constructor(dataManager, options = {}) {
        this.dm = dataManager;
        this.symbol = (options.symbol || 'BTCUSDT').toUpperCase();
        this.interval = options.interval || 60_000;
        this.onTick = options.onTick || (() => {});
        // onStatus(state, message): 'loading' | 'ready' | 'live' | 'offline' | 'error'
        this.onStatus = options.onStatus || (() => {});

        this._ws = null;
        this._running = false;
        this._reconnectTimer = null;
        this._reconnectDelay = 1000;
        this._wsHostIdx = 0;
        this._restHostIdx = 0;
        this._loadToken = 0;   // guards against out-of-order responses
        this._wsToken = 0;     // guards against events from replaced sockets
    }

    get binanceInterval() {
        return INTERVAL_MAP[this.interval] || '1m';
    }

    // ------------------------------------------------------------------
    // REST
    // ------------------------------------------------------------------
    async _fetchKlines(params) {
        const qs = new URLSearchParams({ symbol: this.symbol, interval: this.binanceInterval, ...params });
        let lastErr;
        for (let attempt = 0; attempt < REST_HOSTS.length; attempt++) {
            const host = REST_HOSTS[(this._restHostIdx + attempt) % REST_HOSTS.length];
            try {
                const res = await fetch(`${host}/api/v3/klines?${qs}`);
                if (!res.ok) {
                    let detail = '';
                    try { detail = (await res.json()).msg || ''; } catch (_) {}
                    throw new Error(`Binance ${res.status} ${detail}`.trim());
                }
                this._restHostIdx = (this._restHostIdx + attempt) % REST_HOSTS.length;
                return (await res.json()).map(DataFeed._parseKline);
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr;
    }

    // [openTime, open, high, low, close, volume, closeTime, ...]
    static _parseKline(k) {
        return {
            time: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5])
        };
    }

    /**
     * Load the most recent `count` candles and replace the DataManager contents.
     * Resolves with the candles, or null if a newer load superseded this one.
     */
    async loadHistory(count = 1500) {
        const token = ++this._loadToken;
        this.onStatus('loading', `Loading ${this.symbol}…`);
        try {
            let candles = await this._fetchKlines({ limit: Math.min(1000, count) });
            while (candles.length < count && candles.length > 0) {
                if (token !== this._loadToken) return null;
                const need = Math.min(1000, count - candles.length);
                const older = await this._fetchKlines({ limit: need, endTime: candles[0].time - 1 });
                if (older.length === 0) break;
                candles = older.concat(candles);
            }
            if (token !== this._loadToken) return null;
            if (candles.length === 0) throw new Error(`No data for ${this.symbol}`);
            this.dm.loadFrom(candles);
            this.onStatus('ready', '');
            return candles;
        } catch (err) {
            if (token === this._loadToken) {
                this.onStatus('error', `Binance: ${err.message || err}`);
            }
            throw err;
        }
    }

    /** Backwards-compatible name used by older code / API docs. */
    generateHistory(count = 1500) {
        return this.loadHistory(count);
    }

    // ------------------------------------------------------------------
    // WebSocket (live)
    // ------------------------------------------------------------------
    start() {
        if (this._running) return;
        this._running = true;
        this._reconnectDelay = 1000;
        this._connect();
    }

    stop() {
        this._running = false;
        this._wsToken++;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        if (this._ws) {
            try { this._ws.close(); } catch (_) {}
            this._ws = null;
        }
    }

    /** Restart the stream (after a symbol / interval change) if it was running. */
    restart() {
        if (!this._running) return;
        this.stop();
        this.start();
    }

    _connect() {
        if (!this._running) return;
        const token = ++this._wsToken;
        const stream = `${this.symbol.toLowerCase()}@kline_${this.binanceInterval}`;
        const url = WS_HOSTS[this._wsHostIdx % WS_HOSTS.length] + stream;
        let ws;
        try {
            ws = new WebSocket(url);
        } catch (err) {
            this._scheduleReconnect();
            return;
        }
        this._ws = ws;

        ws.onopen = () => {
            if (token !== this._wsToken) return;
            this._reconnectDelay = 1000;
            this.onStatus('live', '');
            this._catchUp();
        };
        ws.onmessage = (ev) => {
            if (token !== this._wsToken) return;
            let msg;
            try { msg = JSON.parse(ev.data); } catch (_) { return; }
            const k = msg && msg.k;
            if (!k) return;
            this.dm.updateLast(
                k.t,
                parseFloat(k.o), parseFloat(k.h), parseFloat(k.l), parseFloat(k.c),
                parseFloat(k.v)
            );
            this.onTick();
        };
        ws.onerror = () => { /* onclose follows */ };
        ws.onclose = () => {
            if (token !== this._wsToken || !this._running) return;
            this.onStatus('offline', 'Live feed disconnected — reconnecting…');
            this._wsHostIdx++;
            this._scheduleReconnect();
        };
    }

    _scheduleReconnect() {
        if (!this._running) return;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => this._connect(), this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 15_000);
    }

    /** After a (re)connect, fill any candles missed while the socket was down. */
    async _catchUp() {
        const token = this._loadToken;
        const wsToken = this._wsToken;
        try {
            const recent = await this._fetchKlines({ limit: 100 });
            if (token !== this._loadToken || wsToken !== this._wsToken) return;
            const size = this.dm.size;
            const lastTime = size > 0 ? this.dm.times[size - 1] : 0;
            for (const c of recent) {
                if (c.time >= lastTime) {
                    this.dm.updateLast(c.time, c.open, c.high, c.low, c.close, c.volume);
                }
            }
            this.onTick();
        } catch (_) { /* the live stream keeps going regardless */ }
    }

    get isRunning() { return this._running; }
}
