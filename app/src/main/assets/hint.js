// ==UserScript==
// @name         chess hint (v90 live)
// @version      90.3
// @match        https://www.chess.com/*
// @match        https://lichess.org/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    if (window.__HINT_INJECTED__) return;
    window.__HINT_INJECTED__ = true;

    const IS_LICHESS = location.hostname.includes('lichess.org');

    const CONFIG = {
        ENGINE_MOVETIME: 3000,
        HINT_DELAY_MS: 150,
        STABLE_MS: 180,
        MIN_ELO: 1320,
        MAX_ELO: 3190,
        DEFAULT_ELO: 3190,
        DEFAULT_COLORS: { best: '#5f9c6b', mid: '#6b8fb8', worst: '#b07070' },
        ENGINE_STARTUP_TIMEOUT_MS: 15000,
        CDN_STOCKFISH_URL: 'https://cdn.jsdelivr.net/npm/stockfish@19.0.1/bin/stockfish-19-lite-single.js',
        MAX_FEN_CACHE: 500
    };

    const ENGINE_SOURCES = ['app', 'asset', 'cdn'];
    const SOURCE_LABEL = {
        app: 'wasm в приложении', asset: 'wasm', cdn: 'wasm из интернета'
    };
    const STARTUP_TIMEOUT_MS = { app: 10000, asset: 8000, cdn: 15000 };
    const sourceLabel = (src) => SOURCE_LABEL[src] || src;

    const loadSetting = (k, d) => { try { const v = localStorage.getItem(k); return v !== null ? v : d; } catch(e) { return d; } };
    const saveSetting = (k, v) => { try { localStorage.setItem(k, v); } catch(e) {} };

    function getViewportWidth() {
        const vv = window.visualViewport;
        const w = (vv && vv.width) || window.innerWidth || document.documentElement.clientWidth || 360;
        return w > 200 ? w : 360;
    }
    function getViewportHeight() {
        const vv = window.visualViewport;
        const h = (vv && vv.height) || window.innerHeight || document.documentElement.clientHeight || 640;
        return h > 200 ? h : 640;
    }

    function loadPanelPosition() {
        try {
            const s = localStorage.getItem('__hint_pos');
            if (s) {
                const p = JSON.parse(s);
                if (typeof p.x === 'number' && typeof p.y === 'number' && isFinite(p.x) && isFinite(p.y)) {
                    return {
                        x: Math.max(4, Math.min(getViewportWidth() - 52, p.x)),
                        y: Math.max(4, Math.min(getViewportHeight() - 52, p.y))
                    };
                }
            }
        } catch (e) {}
        return { x: Math.max(4, getViewportWidth() - 52), y: 8 };
    }

    const state = {
        fen: null, worker: null, engineReady: false, engineStart: 0,
        lastDepth: 0, myColor: 'w', lastMutationTime: 0,
        engineSource: null,
        currentMultiPv: parseInt(loadSetting('__hint_pv', 3), 10) || 3,
        currentElo: parseInt(loadSetting('__hint_elo', CONFIG.DEFAULT_ELO), 10) || CONFIG.DEFAULT_ELO,
        colors: {
            best: loadSetting('__hint_color_best', CONFIG.DEFAULT_COLORS.best),
            mid: loadSetting('__hint_color_mid', CONFIG.DEFAULT_COLORS.mid),
            worst: loadSetting('__hint_color_worst', CONFIG.DEFAULT_COLORS.worst)
        },
        panelPos: loadPanelPosition(),
        moveTime: Math.max(1, Math.min(10, parseInt(loadSetting('__hint_time', 3), 10) || 3)),
        review: loadSetting('__hint_review', '1') !== '0',
        bar: loadSetting('__hint_bar', '1') !== '0',
        barCp: null,
        stats: { good: 0, inacc: 0, mist: 0, blunder: 0 },
    };

    const engine = {
        busy: false, queue: null, activeFen: null, watchdog: null,
        allPvs: {}, pendingOps: [], depthByFen: new Map(),
        job: null, refs: new Map(), reviewJob: null,
        latestPvs: { 1: null, 2: null, 3: null }
    };

    const perf = { pendingHint: null, hintRafPending: false, hintDelayTimer: null, lastRenderedKey: null };
    const candidate = { fen: null, since: 0, timer: null };
    const _grid = Array.from({ length: 8 }, () => Array(8).fill(''));
    let watchedBoard = null, boardObserver = null;
    let eloDebounce = null;
    let timeDebounce = null;
    let pollIntervalId = null;
    const POLL_MS = 500;
    const SAFETY_EVERY = 3;
    let pollTick = 0;

    let ui = { container: null, toggleBtn: null, panel: null, statusEl: null };

    function injectCustomCSS() {
        if (document.getElementById('__hint_styles')) return;
        if (!document.head) return;
        const style = document.createElement('style');
        style.id = '__hint_styles';
        style.textContent = `
            .__hint_slider { -webkit-appearance: none; width: 100%; height: 3px; background: rgba(255,255,255,0.14); border-radius: 2px; outline: none; margin: 10px 0; transition: opacity 0.2s; }
            .__hint_slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #e9e9e9; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.35); }
            .__hint_slider:disabled { cursor: not-allowed; }
            .__hint_slider:disabled::-webkit-slider-thumb { background: #777; cursor: not-allowed; }
            .__hint_color_input { -webkit-appearance: none; border: none; width: 22px; height: 22px; border-radius: 50%; padding: 0; background: none; cursor: pointer; }
            .__hint_color_input::-webkit-color-swatch-wrapper { padding: 0; }
            .__hint_color_input::-webkit-color-swatch { border: 1px solid rgba(255,255,255,0.18); border-radius: 50%; }
            .__hint_toggle_btn {
                width: 44px; height: 44px; border-radius: 14px;
                background: rgba(30,30,33,0.82);
                color: #ddd;
                backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                border: 1px solid rgba(255,255,255,0.08);
                cursor: grab; display: flex; align-items: center; justify-content: center;
                box-shadow: 0 2px 10px rgba(0,0,0,0.28);
                touch-action: none; user-select: none; -webkit-user-select: none;
                -webkit-tap-highlight-color: transparent;
                transition: transform 0.12s, background 0.2s;
            }
            .__hint_toggle_btn:active { cursor: grabbing; transform: scale(0.95); }
            .__hint_panel_inner { display: flex; flex-direction: column; gap: 16px; }
            .__hint_reset_btn {
                margin-top: 4px; padding: 9px; border-radius: 10px;
                background: rgba(255,255,255,0.06); color: #cfcfcf;
                border: 1px solid rgba(255,255,255,0.08);
                font-size: 12px; cursor: pointer;
                text-align: center; transition: background 0.2s;
            }
            .__hint_reset_btn:active { background: rgba(255,255,255,0.03); }
            .__hint_color_dot {
                width: 8px; height: 8px; border-radius: 50%;
                display: inline-block; margin-right: 8px;
                vertical-align: middle;
            }
            .__hint_row { display: flex; justify-content: space-between; align-items: center; font-weight: 500; cursor: pointer; padding: 4px 0; }
            .__hint_switch { -webkit-appearance: none; appearance: none; width: 34px; height: 20px; border-radius: 10px; background: rgba(255,255,255,0.14); position: relative; transition: background 0.2s; margin: 0; flex: none; cursor: pointer; }
            .__hint_switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #e9e9e9; transition: transform 0.2s; }
            .__hint_switch:checked { background: #6f8f78; }
            .__hint_switch:checked::after { transform: translateX(14px); }
            #__hint_stats { font-size: 11px; color: #8d8d92; line-height: 1.45; }
            #__hint_status {
                font-size: 11px; padding: 7px 10px; border-radius: 8px;
                background: rgba(255,255,255,0.04); color: #8d8d92;
                word-break: break-word; line-height: 1.3;
            }
        `;
        document.head.appendChild(style);
    }

    function updateEngineStatus(text, kind) {
        if (!ui.statusEl) return;
        ui.statusEl.textContent = text;
        const colors = { loading: '#8d8d92', ok: '#86b38e', error: '#c98a8a' };
        ui.statusEl.style.color = colors[kind] || '#888';
    }

    function getTurnFromFen(fen) { if (!fen) return 'w'; return (fen.split(' ')[1] || 'w'); }
    function cpToWinPct(cp) { const w = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1); return Math.round(Math.max(0, Math.min(100, w))); }

    function parseEval(line, turn) {
        const m = line.match(/\bscore (cp|mate) (-?\d+)\b/);
        if (!m) return { display: '', winPct: null, isMate: false, score: null };
        const kind = m[1]; let n = parseInt(m[2], 10);
        if (turn === 'b') n = -n;
        if (kind === 'mate') return { display: (n >= 0 ? '+M' : '-M') + Math.abs(n), winPct: n > 0 ? 100 : 0, isMate: true, score: (n > 0 ? 1 : -1) * (10000 - Math.min(Math.abs(n), 100) * 10) };
        const v = n / 100;
        if (Math.abs(v) < 0.05) return { display: '0.0', winPct: 50, isMate: false, score: n };
        const s = Math.abs(v).toFixed(1).replace(/\.0$/, '');
        return { display: v > 0 ? '+' + s : '-' + s, winPct: cpToWinPct(n), isMate: false, score: n };
    }

    const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

    function winPctF(cp) { return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1); }
    function moveMs() { return state.moveTime * 1000; }

    function setReadyStatus(depth) {
        if (!state.engineReady) return;
        updateEngineStatus('Движок готов (' + sourceLabel(state.engineSource) + ')' + (depth ? ' · глубина ' + depth : ''), 'ok');
    }

    function updateEvalBar() {
        const board = (watchedBoard && watchedBoard.isConnected) ? watchedBoard : findBoard();
        if (!board) return;
        const root = board.shadowRoot || board;
        let bar = root.querySelector('.__hint_bar');
        if (!state.bar || state.barCp === null) { if (bar) bar.style.display = 'none'; return; }
        const br = board.getBoundingClientRect();
        if (br.width < 50) return;
        const cell = Math.min(br.width, br.height) / 8;
        const offX = (br.width - cell * 8) / 2, offY = (br.height - cell * 8) / 2;
        if (!bar) {
            bar = document.createElement('div');
            bar.className = '__hint_bar';
            bar.appendChild(document.createElement('div'));
            if (getComputedStyle(board).position === 'static') board.style.position = 'relative';
            root.appendChild(bar);
        }
        const flipped = isFlipped(board);
        const w = Math.max(5, Math.round(cell * 0.11));
        bar.style.cssText = 'position:absolute;pointer-events:none;z-index:9998;display:flex;flex-direction:column;' +
            'overflow:hidden;border-radius:3px;background:rgba(28,28,31,0.78);box-shadow:0 0 0 1px rgba(255,255,255,0.12);' +
            'left:' + offX + 'px;top:' + offY + 'px;width:' + w + 'px;height:' + (cell * 8) + 'px;' +
            'justify-content:' + (flipped ? 'flex-start' : 'flex-end') + ';';
        bar.firstChild.style.cssText = 'width:100%;background:rgba(236,236,236,0.88);transition:height .3s ease;height:' +
            winPctF(state.barCp).toFixed(1) + '%;';
    }

    let badgeTimer = null;
    function showBadge(text, color) {
        const board = findBoard();
        if (!board) return;
        const root = board.shadowRoot || board;
        let el = root.querySelector('.__hint_badge');
        if (!el) {
            el = document.createElement('div');
            el.className = '__hint_badge';
            if (getComputedStyle(board).position === 'static') board.style.position = 'relative';
            root.appendChild(el);
        }
        const br = board.getBoundingClientRect();
        const cell = Math.min(br.width, br.height) / 8;
        const offY = (br.height - cell * 8) / 2;
        const fs = Math.max(11, Math.round(cell * 0.26));
        el.style.cssText = 'position:absolute;pointer-events:none;z-index:10000;left:50%;transform:translateX(-50%);' +
            'top:' + Math.round(offY + cell * 0.1) + 'px;display:flex;align-items:center;gap:7px;' +
            'padding:' + Math.round(fs * 0.4) + 'px ' + Math.round(fs * 0.8) + 'px;border-radius:999px;' +
            'background:rgba(26,26,29,0.88);color:#ececec;font:500 ' + fs + 'px system-ui,sans-serif;white-space:nowrap;' +
            'transition:opacity .4s ease;opacity:1;';
        el.textContent = '';
        const dot = document.createElement('span');
        const ds = Math.round(fs * 0.5);
        dot.style.cssText = 'width:' + ds + 'px;height:' + ds + 'px;border-radius:50%;background:' + color + ';flex:none;';
        const t = document.createElement('span');
        t.textContent = text;
        el.appendChild(dot);
        el.appendChild(t);
        if (badgeTimer) clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => { el.style.opacity = '0'; }, 7000);
    }

    function updateStatsUi() {
        const el = document.getElementById('__hint_stats');
        if (!el) return;
        const st = state.stats;
        el.textContent = 'Разбор: точных ' + st.good + ' · неточностей ' + st.inacc +
            ' · ошибок ' + st.mist + ' · зевков ' + st.blunder;
    }

    function resetGameReview() {
        state.stats = { good: 0, inacc: 0, mist: 0, blunder: 0 };
        state.barCp = null;
        engine.refs.clear();
        engine.reviewJob = null;
        updateStatsUi();
        updateEvalBar();
    }

    function classifyDrop(drop, isBest) {
        if (isBest) return { key: 'good', label: 'Лучший ход', color: '#86b38e' };
        if (drop < 2) return { key: 'good', label: 'Точный ход', color: '#86b38e' };
        if (drop < 5) return { key: 'good', label: 'Хороший ход', color: '#a3b18a' };
        if (drop < 10) return { key: 'inacc', label: 'Неточность', color: '#c2ab76' };
        if (drop < 20) return { key: 'mist', label: 'Ошибка', color: '#c4916b' };
        return { key: 'blunder', label: 'Зевок', color: '#c98a8a' };
    }

    function reportMove(mv, bestMv, drop, isBest) {
        const c = classifyDrop(drop, isBest);
        state.stats[c.key]++;
        updateStatsUi();
        let text = c.label;
        if (!isBest && drop >= 5) text += ' · −' + Math.round(drop) + '%';
        if (!isBest && drop >= 10 && bestMv) text += ' · лучше ' + bestMv;
        showBadge(text, c.color);
    }

    function gridOfFen(fen) {
        const g = Array.from({ length: 8 }, () => Array(8).fill(''));
        const rows = fen.split(' ')[0].split('/');
        for (let i = 0; i < 8 && i < rows.length; i++) {
            const rank = 7 - i;
            let f = 0;
            for (const ch of rows[i]) {
                if (ch >= '1' && ch <= '8') f += parseInt(ch, 10);
                else if (f < 8) g[rank][f++] = ch;
            }
        }
        return g;
    }

    function deriveMove(prevFen, newFen, mover) {
        const a = gridOfFen(prevFen), b = gridOfFen(newFen);
        const mine = (ch) => ch !== '' && (mover === 'w' ? ch === ch.toUpperCase() : ch === ch.toLowerCase());
        const leaving = [], arriving = [];
        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                if (a[r][f] === b[r][f]) continue;
                if (mine(a[r][f])) leaving.push({ r, f });
                if (mine(b[r][f])) arriving.push({ r, f });
            }
        }
        const sq = (q) => String.fromCharCode(97 + q.f) + (q.r + 1);
        if (leaving.length === 1 && arriving.length === 1) {
            const from = leaving[0], to = arriving[0];
            const oldP = a[from.r][from.f].toLowerCase(), newP = b[to.r][to.f].toLowerCase();
            return sq(from) + sq(to) + ((oldP === 'p' && newP !== 'p') ? newP : '');
        }
        if (leaving.length === 2 && arriving.length === 2) {
            const kFrom = leaving.find(q => a[q.r][q.f].toLowerCase() === 'k');
            const kTo = arriving.find(q => b[q.r][q.f].toLowerCase() === 'k');
            if (kFrom && kTo && kFrom.r === kTo.r && Math.abs(kFrom.f - kTo.f) === 2) return sq(kFrom) + sq(kTo);
        }
        return null;
    }

    function noteMyMove(prevFen, info) {
        if (!state.review || !prevFen || !info.turn) return;
        if (getTurnFromFen(prevFen) !== info.myColor || info.turn === info.myColor) return;
        const ref = engine.refs.get(prevFen);
        if (!ref || ref.depth < 8) return;
        const mv = deriveMove(prevFen, info.fen, info.myColor);
        if (!mv) return;
        if (mv === ref.mv) {
            engine.reviewJob = null;
            reportMove(mv, ref.mv, 0, true);
            return;
        }
        engine.reviewJob = {
            kind: 'review', fen: prevFen, mv, mover: info.myColor,
            refScore: ref.score, refMv: ref.mv, retries: 0, depth: 0, score: null
        };
    }

    function maybeRunReview() {
        const job = engine.reviewJob;
        if (!job || !state.review || !state.worker || !state.engineReady) return;
        if (engine.busy || engine.queue) return;
        job.depth = 0; job.score = null;
        engine.job = job;
        engine.busy = true;
        engine.activeFen = 'review:' + job.fen;
        const ms = Math.min(moveMs(), 2500);
        state.worker.postMessage('position fen ' + job.fen);
        state.worker.postMessage('go movetime ' + ms + ' searchmoves ' + job.mv);
        if (engine.watchdog) clearTimeout(engine.watchdog);
        const tag = engine.activeFen;
        engine.watchdog = setTimeout(() => {
            if (!engine.busy || engine.activeFen !== tag) return;
            try { state.worker.postMessage('stop'); } catch (e) {}
        }, ms + 1000);
    }

    function finalizeReview(job, stale) {
        if (engine.reviewJob !== job) return;
        if (job.score !== null && (job.depth >= 9 || !stale)) {
            engine.reviewJob = null;
            const sgn = job.mover === 'w' ? 1 : -1;
            const drop = Math.max(0, winPctF(sgn * job.refScore) - winPctF(sgn * job.score));
            reportMove(job.mv, job.refMv, drop, false);
        } else if (stale) {
            job.retries++;
            if (job.retries > 2) engine.reviewJob = null;
        } else {
            engine.reviewJob = null;
        }
    }

    function reanalyzeCurrent() {
        if (!state.fen || !state.worker || !state.engineReady) return;
        if (getTurnFromFen(state.fen) !== state.myColor) return;
        clearHint();
        if (engine.busy) {
            engine.queue = state.fen;
            try { state.worker.postMessage('stop'); } catch (e) {}
        } else {
            analyze(state.fen);
        }
    }

    function getBracketPath(cx, cy, size, arm) {
        const h = size / 2, l = arm;
        const x1 = cx - h, x2 = cx + h, y1 = cy - h, y2 = cy + h;
        return `M ${x1+l} ${y1} L ${x1} ${y1} L ${x1} ${y1+l} M ${x2-l} ${y1} L ${x2} ${y1} L ${x2} ${y1+l} M ${x2} ${y2-l} L ${x2} ${y2} L ${x2-l} ${y2} M ${x1+l} ${y2} L ${x1} ${y2} L ${x1} ${y2-l}`;
    }

    const TYPE_MAP = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
    const SQ_KEY_RE = /^[a-h][1-8]$/;

    function extractPiece(el) {
        const cl = el.classList;
        let type = null;
        for (const t of ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn']) {
            if (cl.contains(t)) { type = TYPE_MAP[t]; break; }
        }
        let color = cl.contains('white') ? 'w' : cl.contains('black') ? 'b' : null;
        if (!type || !color) {
            for (const c of cl) { if (/^[wb][pnbrqk]$/.test(c)) { color = c[0]; type = c[1]; break; } }
        }
        if (!type || !color) {
            const dp = el.getAttribute && el.getAttribute('data-piece');
            if (dp && dp.length === 2) {
                const m = dp.match(/^([wb])([pnbrqk])$/i);
                if (m) return { color: m[1].toLowerCase(), type: m[2].toLowerCase() };
            }
        }
        return (type && color) ? { color, type } : null;
    }

    function squareFromClass(el) {
        for (const c of el.classList) {
            const m = c.match(/^square-([1-8])([1-8])$/);
            if (m) return { file: parseInt(m[1], 10) - 1, rank: parseInt(m[2], 10) - 1 };
        }
        return null;
    }

    function squareFromKey(k) {
        if (typeof k === 'string' && SQ_KEY_RE.test(k)) {
            return { file: k.charCodeAt(0) - 97, rank: parseInt(k[1], 10) - 1 };
        }
        return null;
    }

    function squareFromRect(el, br, cellW, cellH, flipped) {
        const r = el.getBoundingClientRect();
        if (r.width < 4) return null;
        const col = Math.floor((r.left + r.width / 2 - br.left) / cellW);
        const row = Math.floor((r.top + r.height / 2 - br.top) / cellH);
        if (col < 0 || col > 7 || row < 0 || row > 7) return null;
        return { file: flipped ? 7 - col : col, rank: flipped ? row : 7 - row };
    }

    function findBoard() {
        if (watchedBoard && watchedBoard.isConnected) {
            const r = watchedBoard.getBoundingClientRect();
            if (r.width > 100 && r.height > 100) return watchedBoard;
        }
        if (IS_LICHESS) {
            const b = document.querySelector('cg-board');
            if (b && b.getBoundingClientRect().width > 100) return b;
        } else {
            for (const sel of ['wc-chess-board', 'chess-board', '.board']) {
                for (const el of document.querySelectorAll(sel)) {
                    if (el.getBoundingClientRect().width > 100) return el;
                }
            }
        }
        return null;
    }

    function isFlipped(board) {
        if (!board) return false;
        if (IS_LICHESS) {
            const w = board.closest('.cg-wrap') || board;
            return w.classList.contains('orientation-black');
        }
        let el = board;
        for (let i = 0; i < 3 && el; i++) {
            if (el.classList && el.classList.contains('flipped')) return true;
            if (el.getAttribute) {
                const o = el.getAttribute('data-orientation');
                if (o === 'black') return true;
                if (o === 'white' || o === 'w') return false;
            }
            el = el.parentElement;
        }
        return false;
    }

    function detectMyColor(board) {
        const flipped = isFlipped(board);

        if (!IS_LICHESS) {
            try {
                const g = board.game;
                if (g) {
                    for (const fn of ['getPlayingAs', 'getPlayingColor', 'getMyColor',
                                      'getPlayerColor', 'getUserColor', 'getUserSide',
                                      'getMySide', 'getSide']) {
                        if (typeof g[fn] === 'function') {
                            try {
                                const v = g[fn]();
                                if (v === 1 || v === 'w' || v === 'white') return 'w';
                                if (v === 2 || v === 'b' || v === 'black') return 'b';
                            } catch (e) {}
                        }
                    }
                    if (g.state) {
                        const s = g.state;
                        for (const k of ['playingAs', 'playerColor', 'userColor', 'myColor', 'side', 'color']) {
                            const v = s[k];
                            if (v === 1 || v === 'w' || v === 'white') return 'w';
                            if (v === 2 || v === 'b' || v === 'black') return 'b';
                        }
                    }
                }
            } catch (e) {}

            const chain = [board];
            let el = board.parentElement;
            for (let i = 0; i < 6 && el; i++) { chain.push(el); el = el.parentElement; }
            chain.push(document.body);
            for (const node of chain) {
                if (!node || !node.getAttribute) continue;
                for (const attr of ['data-user-color', 'data-player-color', 'data-my-color',
                                    'data-play-as', 'data-side', 'data-color']) {
                    const v = node.getAttribute(attr);
                    if (v === 'w' || v === 'white' || v === '1') return 'w';
                    if (v === 'b' || v === 'black' || v === '2') return 'b';
                }
            }
        }

        if (IS_LICHESS) {
            const wrap = (board.closest && board.closest('.cg-wrap')) || board.parentElement;
            for (const node of [board, wrap, document.body]) {
                if (!node || !node.getAttribute) continue;
                for (const attr of ['data-color', 'data-my-color', 'data-player-color', 'data-side']) {
                    const v = node.getAttribute(attr);
                    if (v === 'w' || v === 'white') return 'w';
                    if (v === 'b' || v === 'black') return 'b';
                }
            }
            try {
                if (window.lichess && window.lichess.data) {
                    const d = window.lichess.data;
                    const c = d.playerColor || d.color || (d.player && d.player.color);
                    if (c === 'w' || c === 'white') return 'w';
                    if (c === 'b' || c === 'black') return 'b';
                }
            } catch (e) {}
        }

        return flipped ? 'b' : 'w';
    }

    function turnFromClocks(flipped) {
        const bottomColor = flipped ? 'b' : 'w';
        const topColor = flipped ? 'w' : 'b';

        if (IS_LICHESS) {
            const clocks = document.querySelectorAll('.rclock');
            for (const c of clocks) {
                const cn = typeof c.className === 'string' ? c.className : '';
                const isRunning = /\brunning\b/.test(cn) || !!c.querySelector('.running');
                if (!isRunning) continue;
                if (/\brclock-bottom\b|\bbottom\b/.test(cn)) return bottomColor;
                if (/\brclock-top\b|\btop\b/.test(cn)) return topColor;
                if (/\bwhite\b/.test(cn)) return 'w';
                if (/\bblack\b/.test(cn)) return 'b';
            }
            return null;
        }

        const activeSelectors = [
            '.clock-player-turn',
            '[class*="clock-player-turn"]',
            '[class*="clock-component"][class*="turn"]',
            '.clock-active',
            '[class*="clock-active"]',
            '[class*="clock"][class*="running"]',
            '[class*="clock"][class*="active"]',
        ];
        for (const sel of activeSelectors) {
            const active = document.querySelector(sel);
            if (!active) continue;
            const cn = typeof active.className === 'string' ? active.className : '';
            const parent = active.closest('.clock-white, .clock-black, [class*="clock-white"], [class*="clock-black"], [class*="clock-component"]');
            const pcn = parent ? (typeof parent.className === 'string' ? parent.className : '') : '';
            const c = cn + ' ' + pcn;
            if (/\bclock-white\b|\bwhite-clock\b|\bwhite\b/.test(c)) return 'w';
            if (/\bclock-black\b|\bblack-clock\b|\bblack\b/.test(c)) return 'b';
            if (/\btop\b/.test(c)) return topColor;
            if (/\bbottom\b/.test(c)) return bottomColor;
            return null;
        }
        return null;
    }

    function readGameFen(board, placement) {
        try {
            const g = board.game;
            if (!g) return null;
            try {
                if (g.gameOver === true || g.isGameOver === true) return null;
                if (typeof g.getStatus === 'function') {
                    const st = String(g.getStatus()).toLowerCase();
                    if (['resign', 'resigned', 'checkmated', 'checkmate',
                         'timeout', 'timedout', 'aborted', 'abort',
                         'draw', 'stalemate', 'insufficient',
                         'finished', 'ended', 'gameover', 'game-over'].includes(st)) return null;
                }
            } catch (e) {}

            let fen = null;
            for (const fn of ['getFEN', 'getFen', 'getFENString']) {
                if (typeof g[fn] === 'function') {
                    try { const f = g[fn](); if (typeof f === 'string') { fen = f; break; } } catch (e) {}
                }
            }
            if (!fen && typeof g.getState === 'function') {
                try {
                    const s = g.getState();
                    if (s && typeof s.fen === 'string') fen = s.fen;
                    else if (s && typeof s.currentFen === 'string') fen = s.currentFen;
                } catch (e) {}
            }
            if (!fen && g.state && typeof g.state.fen === 'string') fen = g.state.fen;
            if (!fen) return null;

            const parts = fen.trim().split(/\s+/);
            if (parts.length < 4) return null;
            if (!/^[wb]$/.test(parts[1])) return null;

            if (placement && parts[0] !== placement) {
                let diff = 0;
                const ga = gridOfFen(placement + ' w - - 0 1');
                const gb = gridOfFen(parts[0] + ' w - - 0 1');
                for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
                    if (ga[r][f] !== gb[r][f]) diff++;
                    if (diff > 2) return null;
                }
            }
            return parts;
        } catch (e) { return null; }
    }

    function getLastMoveSquares(root, br, flipped) {
        const out = [];
        if (IS_LICHESS) {
            const cellW = br.width / 8, cellH = br.height / 8;
            for (const el of root.querySelectorAll('square.last-move')) {
                const s = squareFromKey(el.cgKey || el.sqKey) || squareFromRect(el, br, cellW, cellH, flipped);
                if (s) out.push(s);
            }
        } else {
            for (const el of root.querySelectorAll('.highlight')) {
                const s = squareFromClass(el);
                if (s) out.push(s);
            }
        }
        return out;
    }

    function analyzeLastMove(squares) {
        if (squares.length !== 2) return null;
        const occ = squares.filter(s => _grid[s.rank][s.file]);
        if (occ.length !== 1) return null;
        const to = occ[0];
        const from = squares[0] === to ? squares[1] : squares[0];
        const pc = _grid[to.rank][to.file];
        return { mover: pc === pc.toUpperCase() ? 'w' : 'b', pc, from, to };
    }

    function epSquare(lm) {
        if (!lm || lm.pc.toLowerCase() !== 'p') return '-';
        if (lm.from.file !== lm.to.file || Math.abs(lm.to.rank - lm.from.rank) !== 2) return '-';
        const enemy = lm.mover === 'w' ? 'p' : 'P';
        const f = lm.to.file, r = lm.to.rank;
        const has = (ff) => ff >= 0 && ff <= 7 && _grid[r][ff] === enemy;
        if (!has(f - 1) && !has(f + 1)) return '-';
        const mid = (lm.from.rank + lm.to.rank) / 2;
        return String.fromCharCode(97 + f) + (mid + 1);
    }

    function validatePlacement() {
        let wK = 0, bK = 0, wN = 0, bN = 0, wP = 0, bP = 0;
        let wKpos = null, bKpos = null;
        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const pc = _grid[r][f];
                if (!pc) continue;
                const isWhite = pc === pc.toUpperCase();
                if (isWhite) wN++; else bN++;
                if (pc === 'K') { wK++; wKpos = { r, f }; }
                else if (pc === 'k') { bK++; bKpos = { r, f }; }
                else if (pc === 'P' || pc === 'p') {
                    if (r === 0 || r === 7) return false;
                    if (isWhite) wP++; else bP++;
                }
            }
        }
        if (wK !== 1 || bK !== 1) return false;
        if (wN > 16 || bN > 16 || wP > 8 || bP > 8) return false;
        if (Math.abs(wKpos.r - bKpos.r) <= 1 && Math.abs(wKpos.f - bKpos.f) <= 1) return false;
        return true;
    }

    function getFenFromDom(board) {
        const root = board.shadowRoot ? board.shadowRoot : board;
        const els = root.querySelectorAll(IS_LICHESS ? 'piece' : '.piece, [data-piece]');
        if (els.length < 2) return null;
        const br = board.getBoundingClientRect();
        if (br.width < 50) return null;
        const flipped = isFlipped(board);
        for (let r = 0; r < 8; r++) _grid[r].fill('');
        const cellW = br.width / 8, cellH = br.height / 8;

        for (const p of els) {
            const cl = p.classList;
            if (cl.contains('ghost') || cl.contains('fading')) continue;
            const info = extractPiece(p);
            if (!info) continue;

            let sq = IS_LICHESS ? squareFromKey(p.cgKey) : squareFromClass(p);
            if (!sq) {
                if (cl.contains('dragging')) return null;
                sq = squareFromRect(p, br, cellW, cellH, flipped);
            }
            if (!sq) continue;
            if (_grid[sq.rank][sq.file]) return null;
            _grid[sq.rank][sq.file] = info.color === 'w' ? info.type.toUpperCase() : info.type;
        }

        if (!validatePlacement()) return null;

        let boardStr = '';
        for (let r = 7; r >= 0; r--) {
            let empty = 0;
            for (let f = 0; f < 8; f++) {
                const pc = _grid[r][f];
                if (pc) { if (empty) { boardStr += empty; empty = 0; } boardStr += pc; } else empty++;
            }
            if (empty) boardStr += empty;
            if (r > 0) boardStr += '/';
        }

        const myColor = detectMyColor(board);

        let castling = '';
        if (_grid[0][4] === 'K') { if (_grid[0][7] === 'R') castling += 'K'; if (_grid[0][0] === 'R') castling += 'Q'; }
        if (_grid[7][4] === 'k') { if (_grid[7][7] === 'r') castling += 'k'; if (_grid[7][0] === 'r') castling += 'q'; }
        if (!castling) castling = '-';
        let ep = '-';
        let turn = null;

        const gameFen = IS_LICHESS ? null : readGameFen(board, boardStr);
        if (gameFen) {
            turn = gameFen[1];
            castling = gameFen[2];
            ep = gameFen[3];
        } else {
            const lm = analyzeLastMove(getLastMoveSquares(root, br, flipped));
            if (lm) {
                turn = lm.mover === 'w' ? 'b' : 'w';
                ep = epSquare(lm);
            } else {
                turn = turnFromClocks(flipped);
            }
            if (!turn && state.fen) {
                const prevTurn = getTurnFromFen(state.fen);
                if (deriveMove(state.fen, boardStr, prevTurn)) {
                    turn = prevTurn === 'w' ? 'b' : 'w';
                }
            }
            if (!turn) return null;
        }

        return { fen: boardStr + ' ' + turn + ' ' + castling + ' ' + ep + ' 0 1', turn, myColor };
    }

    let _bridgeGen = 0;
    function createBridgeWorker(kind) {
        const NH = window.NativeHint;
        if (!NH || typeof NH.engineStart !== 'function') throw new Error('мост NativeHint недоступен');
        const myGen = ++_bridgeGen;
        const bw = {
            onmessage: null, onerror: null, onmessageerror: null,
            postMessage(m) {
                if (_bridgeGen !== myGen) return;
                try { NH.engineSend(String(m)); } catch (e) {}
            },
            terminate() {
                try { NH.engineStop(); } catch (e) {}
            }
        };
        window.__hintEngineLine = (l) => {
            if (_bridgeGen !== myGen) return;
            if (bw.onmessage) bw.onmessage({ data: l });
        };
        window.__hintEngineError = (m) => {
            if (_bridgeGen !== myGen) return;
            if (bw.onerror) bw.onerror({ message: m });
        };
        if (!NH.engineStart(kind)) throw new Error('приложение не запустило движок');
        return bw;
    }

    // ИСПРАВЛЕНО: classic workers. stockfish-19-lite-single.js это IIFE,
    // module-first падал async и fallback в try/catch никогда не срабатывал.
    // Если у тебя engine.js окажется ES module и увидишь в logcat
    // "SyntaxError: Cannot use import statement outside a module" —
    // замени здесь new Worker(url) на new Worker(url, { type: 'module' }).
    function createWorker(source) {
        if (source === 'app') return createBridgeWorker('wasm');

        if (source === 'asset') {
            return new Worker(location.origin + '/__hint/engine.js');
        }

        if (source === 'cdn') {
            const url = CONFIG.CDN_STOCKFISH_URL;
            const blob = new Blob(['importScripts(' + JSON.stringify(url) + ');'], { type: 'application/javascript' });
            return new Worker(URL.createObjectURL(blob) + '#' + encodeURIComponent(url.replace(/\.js$/, '.wasm')));
        }

        throw new Error('неизвестный источник: ' + source);
    }

    function isEloMax() { return state.currentElo >= CONFIG.MAX_ELO; }
    function effMultiPv() { return isEloMax() ? state.currentMultiPv : 1; }

    function sendStrengthOptions(w) {
        w.postMessage('setoption name MultiPV value ' + effMultiPv());
        if (isEloMax()) {
            w.postMessage('setoption name UCI_LimitStrength value false');
        } else {
            w.postMessage('setoption name UCI_LimitStrength value true');
            w.postMessage('setoption name UCI_Elo value ' + state.currentElo);
        }
    }

    function whenIdle(fn) {
        if (!state.worker || !state.engineReady) return;
        if (engine.busy) {
            engine.pendingOps.push(fn);
            try { state.worker.postMessage('stop'); } catch (e) {}
        } else {
            fn();
        }
    }

    function updateMultiPvUiState() {
        const isMax = isEloMax();
        const sliderPv = document.getElementById('__hint_slider_pv');
        const labelPv = document.getElementById('__hint_label_pv');
        const warning = document.getElementById('__hint_elo_warning');
        if (sliderPv) { sliderPv.disabled = !isMax; sliderPv.style.opacity = isMax ? '1' : '0.3'; }
        if (labelPv) { labelPv.style.opacity = isMax ? '1' : '0.3'; }
        if (warning) { warning.style.display = isMax ? 'none' : 'block'; }
    }

    function applyEloSetting() {
        if (!state.worker || !state.engineReady) { updateMultiPvUiState(); return; }
        whenIdle(() => sendStrengthOptions(state.worker));
        clearHint();
        if (state.fen && getTurnFromFen(state.fen) === state.myColor) {
            if (engine.busy) engine.queue = state.fen;
            else analyze(state.fen);
        } else {
            engine.queue = null;
        }
        updateMultiPvUiState();
    }

    function resetEngineState(worker, source) {
        if (engine.watchdog) { clearTimeout(engine.watchdog); engine.watchdog = null; }
        engine.busy = false;
        engine.queue = null;
        engine.activeFen = null;
        engine.pendingOps = [];
        engine.depthByFen.clear();
        engine.latestPvs = { 1: null, 2: null, 3: null };
        engine.allPvs = {};
        state.worker = worker;
        state.engineSource = source;
        state.engineReady = false;
    }

    function startEngine(idx, errors) {
        if (idx >= ENGINE_SOURCES.length) {
            console.error('[hint] движок не загружен', errors);
            updateEngineStatus('Движок не загружен: ' + errors.join('; '), 'error');
            return;
        }
        const source = ENGINE_SOURCES[idx];
        let worker;
        try {
            worker = createWorker(source);
        } catch (e) {
            errors.push(source + ': ' + (e && e.message ? e.message : e));
            startEngine(idx + 1, errors);
            return;
        }
        resetEngineState(worker, source);
        console.log('[hint] пробую движок:', source);
        updateEngineStatus('Движок стартует (' + sourceLabel(source) + ')…', 'loading');

        let finished = false;
        const timeoutMs = STARTUP_TIMEOUT_MS[source] || CONFIG.ENGINE_STARTUP_TIMEOUT_MS;
        const startupTimer = setTimeout(() => {
            if (state.worker !== worker || state.engineReady) return;
            if (idx + 1 < ENGINE_SOURCES.length) {
                fail('нет ответа за ' + (timeoutMs / 1000) + ' с');
            } else {
                updateEngineStatus('Движок не ответил за ' + (timeoutMs / 1000) + ' с', 'error');
            }
        }, timeoutMs);

        const fail = (msg) => {
            if (finished || state.worker !== worker || state.engineReady) return;
            finished = true;
            clearTimeout(startupTimer);
            try { worker.terminate(); } catch (e) {}
            errors.push(source + ': ' + msg);
            startEngine(idx + 1, errors);
        };

        worker.onmessage = (e) => {
            if (state.worker !== worker) return;
            const line = typeof e.data === 'string' ? e.data : '';
            if (line === 'uciok') {
                worker.postMessage('setoption name Hash value 32');
                sendStrengthOptions(worker);
                worker.postMessage('isready');
            } else if (line === 'readyok') {
                finished = true;
                clearTimeout(startupTimer);
                state.engineReady = true;
                updateEngineStatus('Движок готов (' + sourceLabel(source) + ')', 'ok');
                if (state.fen) {
                    const turn = getTurnFromFen(state.fen);
                    if (turn === state.myColor) analyze(state.fen);
                }
            } else if (line.startsWith('info ')) {
                if (engine.job && engine.job.kind === 'review') {
                    if (!/\bpv\b/.test(line) || /\b(lowerbound|upperbound)\b/.test(line)) return;
                    const rd = line.match(/\bdepth (\d+)\b/);
                    if (!rd) return;
                    const rdepth = parseInt(rd[1], 10);
                    if (rdepth < engine.job.depth) return;
                    const rev = parseEval(line, engine.job.mover);
                    if (rev.score === null) return;
                    engine.job.depth = rdepth;
                    engine.job.score = rev.score;
                    return;
                }
                if (engine.activeFen !== state.fen) return;
                if (!/\bpv\b/.test(line)) return;
                if (/\b(lowerbound|upperbound)\b/.test(line)) return;
                const dm = line.match(/\bdepth (\d+)\b/);
                if (!dm) return;
                const depth = parseInt(dm[1], 10);
                const curDepth = engine.depthByFen.get(engine.activeFen) || 0;
                if (depth < curDepth) return;
                if (depth > curDepth) { engine.depthByFen.set(engine.activeFen, depth); setReadyStatus(depth); }
                const mpvM = line.match(/\bmultipv (\d+)\b/);
                const mpvIdx = mpvM ? parseInt(mpvM[1], 10) : 1;
                const pvm = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);
                if (!pvm) return;
                if (mpvIdx === 1) {
                    const bev = parseEval(line, getTurnFromFen(state.fen));
                    if (bev.score !== null) {
                        engine.refs.set(engine.activeFen, { score: bev.score, mv: pvm[1], depth });
                        if (engine.refs.size > 60) engine.refs.delete(engine.refs.keys().next().value);
                        state.barCp = bev.score;
                        updateEvalBar();
                    }
                }
                if (!isEloMax()) {
                    if (mpvIdx >= 1 && mpvIdx <= 8) {
                        engine.allPvs[mpvIdx] = { mv: pvm[1], eval: parseEval(line, getTurnFromFen(state.fen)) };
                    }
                    return;
                }
                if (mpvIdx < 1 || mpvIdx > 3) return;
                engine.latestPvs[mpvIdx] = { mv: pvm[1], eval: parseEval(line, getTurnFromFen(state.fen)) };
                if (engine.latestPvs[1]) {
                    state.lastDepth = depth;
                    drawMultiHint();
                }
            } else if (line.startsWith('bestmove')) {
                if (engine.watchdog) { clearTimeout(engine.watchdog); engine.watchdog = null; }
                const doneFen = engine.activeFen;
                const doneJob = engine.job;
                const stale = !!engine.queue || engine.pendingOps.length > 0;
                engine.busy = false; engine.activeFen = null; engine.job = null;
                if (doneJob && doneJob.kind === 'review') {
                    finalizeReview(doneJob, stale);
                } else if (!isEloMax() && !stale && doneFen && doneFen === state.fen) {
                    const bm = line.match(/^bestmove ([a-h][1-8][a-h][1-8][qrbn]?)/);
                    if (bm) {
                        let ev = null;
                        for (const k in engine.allPvs) {
                            if (engine.allPvs[k] && engine.allPvs[k].mv === bm[1]) { ev = engine.allPvs[k].eval; break; }
                        }
                        engine.latestPvs = { 1: { mv: bm[1], eval: ev }, 2: null, 3: null };
                        state.lastDepth = engine.depthByFen.get(doneFen) || 1;
                        drawMultiHint();
                    }
                }
                const ops = engine.pendingOps;
                engine.pendingOps = [];
                for (const fn of ops) {
                    try { fn(); } catch (err) { console.error('[hint] op failed', err); }
                }
                if (engine.queue) { const n = engine.queue; engine.queue = null; analyze(n); }
                else maybeRunReview();
            }
        };

        worker.onerror = (e) => {
            const msg = e && e.message ? e.message : 'не удалось загрузить скрипт';
            console.error('[hint] worker error', source, msg);
            if (state.worker === worker && state.engineReady) {
                updateEngineStatus('Ошибка воркера: ' + msg, 'error');
                return;
            }
            fail(msg);
        };

        worker.onmessageerror = (e) => {
            console.error('[hint] messageerror', e);
        };

        worker.postMessage('uci');
    }

    function initEngine() {
        state.engineStart = performance.now();
        updateEngineStatus('Загрузка движка…', 'loading');
        startEngine(0, []);
    }

    function analyze(fen) {
        if (!state.worker || !state.engineReady || !fen) return;
        if (engine.busy) {
            if (engine.activeFen !== fen) {
                engine.queue = fen;
                try { state.worker.postMessage('stop'); } catch(e) {}
            }
            return;
        }
        if (engine.depthByFen.size > CONFIG.MAX_FEN_CACHE) engine.depthByFen.clear();
        engine.busy = true; engine.activeFen = fen;
        engine.job = { kind: 'hint', fen };
        engine.depthByFen.set(fen, 0);
        engine.latestPvs = { 1: null, 2: null, 3: null };
        engine.allPvs = {};
        state.lastDepth = 0;
        state.worker.postMessage('position fen ' + fen);
        state.worker.postMessage('go movetime ' + moveMs());

        if (engine.watchdog) clearTimeout(engine.watchdog);
        engine.watchdog = setTimeout(() => {
            if (!engine.busy || engine.activeFen !== fen) return;
            try { state.worker.postMessage('stop'); } catch(e) {}
        }, moveMs() + 1000);
    }

    function processFen(info) {
        if (!info || !info.fen) return;
        if (info.fen === state.fen) { candidate.fen = null; return; }
        const now = performance.now();
        if (candidate.fen !== info.fen) {
            candidate.fen = info.fen;
            candidate.since = now;
            if (candidate.timer) clearTimeout(candidate.timer);
            candidate.timer = setTimeout(() => { candidate.timer = null; onMutation(true); }, CONFIG.STABLE_MS + 30);
            return;
        }
        if (now - candidate.since < CONFIG.STABLE_MS) return;
        candidate.fen = null;
        acceptFen(info);
    }

    function acceptFen(info) {
        const prevFen = state.fen;
        if (info.fen.split(' ')[0] === START_PLACEMENT) resetGameReview();
        else noteMyMove(prevFen, info);
        state.fen = info.fen;
        state.myColor = info.myColor;
        clearHint();
        if (info.turn && info.turn !== info.myColor) {
            if (engine.busy && state.worker) try { state.worker.postMessage('stop'); } catch(e){}
            engine.queue = null;
            if (!engine.busy) maybeRunReview();
            return;
        }
        analyze(info.fen);
    }

    function onMutation(force) {
        if (document.hidden) return;
        const now = performance.now();
        if (!force && now - state.lastMutationTime < 150) return;
        state.lastMutationTime = now;
        const board = findBoard();
        if (!board) return;
        watchedBoard = board;
        const info = getFenFromDom(board);
        if (info) processFen(info);
    }

    function clearHint() {
        if (perf.hintDelayTimer) { clearTimeout(perf.hintDelayTimer); perf.hintDelayTimer = null; }
        perf.pendingHint = null;
        perf.lastRenderedKey = null;
        if (watchedBoard) {
            const root = watchedBoard.shadowRoot || watchedBoard;
            const host = root.querySelector('.__hint_host');
            if (host && host.shadowRoot) host.shadowRoot.innerHTML = '';
        }
    }

    function drawMultiHint() {
        perf.pendingHint = { fen: state.fen };
        if (perf.hintDelayTimer) clearTimeout(perf.hintDelayTimer);
        perf.hintDelayTimer = setTimeout(() => {
            perf.hintDelayTimer = null;
            if (!perf.hintRafPending) {
                perf.hintRafPending = true;
                requestAnimationFrame(renderMultiHint);
            }
        }, CONFIG.HINT_DELAY_MS);
    }

    function renderMultiHint() {
        perf.hintRafPending = false;
        if (!perf.pendingHint || state.fen !== perf.pendingHint.fen) return;
        const board = findBoard();
        if (!board) return;
        updateEvalBar();

        const pvs = engine.latestPvs;
        const evalText = pvs[1] && pvs[1].eval ? pvs[1].eval.display : '';
        const boardRoot = board.shadowRoot || board;
        const br = board.getBoundingClientRect();
        const flipped = isFlipped(board);

        let host = boardRoot.querySelector('.__hint_host');
        const alive = !!(host && host.shadowRoot && host.shadowRoot.firstChild);
        const cacheKey = [
            state.fen, state.lastDepth, effMultiPv(), evalText,
            pvs[1] ? pvs[1].mv : '', pvs[2] ? pvs[2].mv : '', pvs[3] ? pvs[3].mv : '',
            Math.round(br.width), Math.round(br.height), flipped ? 1 : 0
        ].join('_');
        if (alive && perf.lastRenderedKey === cacheKey) return;
        perf.lastRenderedKey = cacheKey;

        if (!host) {
            host = document.createElement('div');
            host.className = '__hint_host';
            host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:9999;';
            if (getComputedStyle(board).position === 'static') board.style.position = 'relative';
            boardRoot.appendChild(host);
        }
        let shadow = host.shadowRoot;
        if (!shadow) shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '';

        const W = br.width, H = br.height;
        const cell = Math.min(W, H) / 8;
        const offX = (W - cell * 8) / 2, offY = (H - cell * 8) / 2;

        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.style.cssText = 'position:absolute;inset:0;overflow:visible;';
        svg.setAttribute('overflow', 'visible');

        const sqXY = (sq) => {
            const f = sq.charCodeAt(0) - 97, r = parseInt(sq[1], 10) - 1;
            return { x: (flipped ? 7 - f : f) * cell + cell / 2 + offX, y: (flipped ? r : 7 - r) * cell + cell / 2 + offY };
        };

        const ARROW_STYLE = {
            best:  { w: 0.075, op: 0.9,  br: 0.95 },
            mid:   { w: 0.055, op: 0.65, br: 0.7 },
            worst: { w: 0.045, op: 0.5,  br: 0.5 }
        };

        const drawOne = (uci, evalObj, rank) => {
            if (!uci) return;
            const color = state.colors[rank];
            const st = ARROW_STYLE[rank];
            const a = sqXY(uci.slice(0, 2));
            const b = sqXY(uci.slice(2, 4));

            const dF = Math.abs(uci.charCodeAt(2) - uci.charCodeAt(0));
            const dR = Math.abs(parseInt(uci[3], 10) - parseInt(uci[1], 10));
            const isKnight = (dF === 1 && dR === 2) || (dF === 2 && dR === 1);
            const pts = [a];
            if (isKnight) pts.push(dR === 2 ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
            const prev = pts[pts.length - 1];
            const ang = Math.atan2(b.y - prev.y, b.x - prev.x);
            const ux = Math.cos(ang), uy = Math.sin(ang);

            const lineW = cell * st.w;
            const headLen = cell * 0.26, headHalf = cell * 0.14;
            const tip = { x: b.x - ux * cell * 0.1, y: b.y - uy * cell * 0.1 };
            const baseC = { x: tip.x - ux * headLen, y: tip.y - uy * headLen };
            const lineEnd = { x: baseC.x + ux * headLen * 0.3, y: baseC.y + uy * headLen * 0.3 };

            let d = 'M ' + a.x + ' ' + a.y;
            for (let i = 1; i < pts.length; i++) d += ' L ' + pts[i].x + ' ' + pts[i].y;
            d += ' L ' + lineEnd.x + ' ' + lineEnd.y;

            const headPts =
                tip.x + ',' + tip.y + ' ' +
                (baseC.x - uy * headHalf) + ',' + (baseC.y + ux * headHalf) + ' ' +
                (baseC.x + uy * headHalf) + ',' + (baseC.y - ux * headHalf);

            const g = document.createElementNS(ns, 'g');
            g.setAttribute('opacity', st.op);

            const halo = document.createElementNS(ns, 'path');
            halo.setAttribute('d', d);
            halo.setAttribute('fill', 'none');
            halo.setAttribute('stroke', 'rgba(0,0,0,0.28)');
            halo.setAttribute('stroke-width', lineW + cell * 0.035);
            halo.setAttribute('stroke-linecap', 'round');
            halo.setAttribute('stroke-linejoin', 'round');
            g.appendChild(halo);

            const path = document.createElementNS(ns, 'path');
            path.setAttribute('d', d);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', lineW);
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            g.appendChild(path);

            const head = document.createElementNS(ns, 'polygon');
            head.setAttribute('points', headPts);
            head.setAttribute('fill', color);
            head.setAttribute('stroke', 'rgba(0,0,0,0.28)');
            head.setAttribute('stroke-width', cell * 0.02);
            head.setAttribute('stroke-linejoin', 'round');
            g.appendChild(head);
            svg.appendChild(g);

            const br = document.createElementNS(ns, 'path');
            br.setAttribute('d', getBracketPath(b.x, b.y, cell * 0.82, cell * 0.2));
            br.setAttribute('fill', 'none');
            br.setAttribute('stroke', color);
            br.setAttribute('stroke-opacity', st.br);
            br.setAttribute('stroke-width', cell * 0.04);
            br.setAttribute('stroke-linecap', 'round');
            br.setAttribute('stroke-linejoin', 'round');
            svg.appendChild(br);

            if (evalObj && evalObj.display) {
                let ev = evalObj.display;
                let pct = evalObj.winPct;
                if (state.myColor === 'b') {
                    if (ev.startsWith('+')) ev = '-' + ev.slice(1);
                    else if (ev.startsWith('-')) ev = '+' + ev.slice(1);
                    if (pct !== null && pct !== undefined) pct = 100 - pct;
                }
                const text = (rank === 'best' && !evalObj.isMate && pct !== null && pct !== undefined)
                    ? ev + ' · ' + pct + '%' : ev;

                const fs = cell * 0.19;
                const h = cell * 0.31;
                const padX = cell * 0.11;
                const dotR = cell * 0.035;
                const gap = cell * 0.07;
                const textW = text.length * fs * 0.56;
                const w = padX * 2 + dotR * 2 + gap + textW;
                let px = b.x + cell * 0.12;
                let py = b.y - cell * 0.5 - h / 2;
                px = Math.max(2, Math.min(W - w - 2, px));
                py = Math.max(2, Math.min(H - h - 2, py));

                const pill = document.createElementNS(ns, 'rect');
                pill.setAttribute('x', px); pill.setAttribute('y', py);
                pill.setAttribute('width', w); pill.setAttribute('height', h);
                pill.setAttribute('rx', h / 2);
                pill.setAttribute('fill', 'rgba(26,26,29,0.82)');
                svg.appendChild(pill);

                const dot = document.createElementNS(ns, 'circle');
                dot.setAttribute('cx', px + padX + dotR);
                dot.setAttribute('cy', py + h / 2);
                dot.setAttribute('r', dotR);
                dot.setAttribute('fill', color);
                svg.appendChild(dot);

                const t = document.createElementNS(ns, 'text');
                t.setAttribute('x', px + padX + dotR * 2 + gap);
                t.setAttribute('y', py + h / 2);
                t.setAttribute('dominant-baseline', 'central');
                t.setAttribute('fill', '#ececec');
                t.setAttribute('font-family', 'system-ui, sans-serif');
                t.setAttribute('font-weight', '500');
                t.setAttribute('font-size', fs);
                t.textContent = text;
                svg.appendChild(t);
            }
        };

        const nMoves = effMultiPv();
        if (nMoves >= 3 && pvs[3]) drawOne(pvs[3].mv, pvs[3].eval, 'worst');
        if (nMoves >= 2 && pvs[2]) drawOne(pvs[2].mv, pvs[2].eval, 'mid');
        if (nMoves >= 1 && pvs[1]) drawOne(pvs[1].mv, pvs[1].eval, 'best');

        shadow.appendChild(svg);
    }

    function applyButtonPosition() {
        if (!ui.container || !state.panelPos) return;
        const w = getViewportWidth();
        const h = getViewportHeight();
        let x = state.panelPos.x;
        let y = state.panelPos.y;
        if (!isFinite(x)) x = w - 52;
        if (!isFinite(y)) y = 8;
        if (x < 4) x = 4;
        if (y < 4) y = 4;
        if (x > w - 52) x = Math.max(4, w - 52);
        if (y > h - 52) y = Math.max(4, h - 52);
        state.panelPos.x = x;
        state.panelPos.y = y;
        ui.container.style.left = x + 'px';
        ui.container.style.top = y + 'px';
    }

    function openPanel() {
        if (!ui.panel) return;
        const vw = getViewportWidth();
        const vh = getViewportHeight();
        const btnX = state.panelPos.x;
        const btnY = state.panelPos.y;
        const btnW = 44, btnH = 44;
        const gap = 8, margin = 8;
        const panelW = Math.min(230, vw - 2 * margin);

        const spaceBelow = vh - (btnY + btnH + gap) - margin;
        const spaceAbove = btnY - gap - margin;

        if (spaceBelow >= spaceAbove && spaceBelow > 100) {
            ui.panel.style.top = (btnY + btnH + gap) + 'px';
            ui.panel.style.bottom = 'auto';
            ui.panel.style.maxHeight = spaceBelow + 'px';
        } else if (spaceAbove > 100) {
            ui.panel.style.bottom = (vh - btnY + gap) + 'px';
            ui.panel.style.top = 'auto';
            ui.panel.style.maxHeight = spaceAbove + 'px';
        } else {
            ui.panel.style.top = (btnY + btnH + gap) + 'px';
            ui.panel.style.bottom = 'auto';
            ui.panel.style.maxHeight = Math.max(100, spaceBelow) + 'px';
        }

        const spaceRight = vw - (btnX + btnW + gap) - margin;
        const spaceLeft = btnX - gap - margin;

        if (spaceRight >= panelW) {
            ui.panel.style.left = (btnX + btnW + gap) + 'px';
            ui.panel.style.right = 'auto';
        } else if (spaceLeft >= panelW) {
            ui.panel.style.right = (vw - btnX + gap) + 'px';
            ui.panel.style.left = 'auto';
        } else {
            if (btnX < vw / 2) {
                ui.panel.style.left = margin + 'px';
                ui.panel.style.right = 'auto';
            } else {
                ui.panel.style.right = margin + 'px';
                ui.panel.style.left = 'auto';
            }
        }

        ui.panel.style.width = panelW + 'px';
        ui.panel.style.display = 'flex';
    }

    function closePanel() {
        if (ui.panel) ui.panel.style.display = 'none';
    }

    function createControlPanel() {
        if (document.getElementById('__hint_controls')) return;
        if (!document.head || !document.body) {
            setTimeout(createControlPanel, 60);
            return;
        }
        injectCustomCSS();

        const container = document.createElement('div');
        container.id = '__hint_controls';
        container.style.cssText = 'position:fixed;z-index:2147483647;width:44px;height:44px;';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = '__hint_toggle_btn';
        toggleBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="1.6" stroke-linecap="round">
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>
            </svg>
        `;
        container.appendChild(toggleBtn);

        const panel = document.createElement('div');
        panel.id = '__hint_controls_panel';
        panel.style.cssText = `
            display:none; position:fixed; z-index:2147483646; flex-direction:column;
            background: rgba(28,28,31,0.9);
            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            color: #e6e6e6; padding: 16px; border-radius: 16px;
            font-size: 13px;
            box-shadow: 0 8px 28px rgba(0,0,0,0.35);
            border: 1px solid rgba(255,255,255,0.07);
            overflow-y: auto;
            transition: opacity 0.15s ease;
        `;

        const inner = document.createElement('div');
        inner.className = '__hint_panel_inner';

        const statusDiv = document.createElement('div');
        statusDiv.id = '__hint_status';
        statusDiv.textContent = 'Движок не инициализирован';
        inner.appendChild(statusDiv);

        const labelElo = document.createElement('div');
        labelElo.style.cssText = 'display:flex;justify-content:space-between;font-weight:500;';
        const updateEloLabel = () => {
            labelElo.innerHTML = `<span>Сила движка</span><b>${state.currentElo >= CONFIG.MAX_ELO ? 'MAX' : state.currentElo}</b>`;
        };
        updateEloLabel();

        const sliderElo = document.createElement('input');
        sliderElo.type = 'range';
        sliderElo.min = CONFIG.MIN_ELO;
        sliderElo.max = CONFIG.MAX_ELO;
        sliderElo.step = 10;
        sliderElo.value = state.currentElo;
        sliderElo.className = '__hint_slider';
        sliderElo.oninput = (e) => {
            const val = parseInt(e.target.value, 10);
            state.currentElo = val;
            saveSetting('__hint_elo', val);
            updateEloLabel();
            updateMultiPvUiState();
            if (eloDebounce) clearTimeout(eloDebounce);
            eloDebounce = setTimeout(applyEloSetting, 250);
        };

        const labelPv = document.createElement('div');
        labelPv.id = '__hint_label_pv';
        labelPv.style.cssText = 'display:flex;justify-content:space-between;font-weight:500;transition:opacity 0.2s;';
        labelPv.innerHTML = `<span>Количество ходов</span><b>${state.currentMultiPv}</b>`;

        const sliderPv = document.createElement('input');
        sliderPv.id = '__hint_slider_pv';
        sliderPv.type = 'range';
        sliderPv.min = 1;
        sliderPv.max = 3;
        sliderPv.step = 1;
        sliderPv.value = state.currentMultiPv;
        sliderPv.className = '__hint_slider';
        sliderPv.oninput = (e) => {
            if (!isEloMax()) return;
            const val = parseInt(e.target.value, 10);
            state.currentMultiPv = val;
            saveSetting('__hint_pv', val);
            labelPv.innerHTML = `<span>Количество ходов</span><b>${val}</b>`;
            clearHint();
            if (state.worker && state.engineReady) {
                whenIdle(() => state.worker.postMessage('setoption name MultiPV value ' + val));
                if (state.fen && getTurnFromFen(state.fen) === state.myColor) {
                    if (engine.busy) engine.queue = state.fen;
                    else analyze(state.fen);
                }
            }
        };

        const warning = document.createElement('div');
        warning.id = '__hint_elo_warning';
        warning.style.cssText = 'display:none;padding:9px 10px;background:rgba(255,255,255,0.04);border-left:2px solid #a8906a;border-radius:6px;font-size:11px;color:#bfae8f;line-height:1.4;margin-top:-4px;';
        warning.textContent = 'При ограничении ELO показывается один ход — тот, что выбрал бы движок такой силы. Для 3 ходов поставь MAX.';

        const colorsDiv = document.createElement('div');
        colorsDiv.style.cssText = 'display:flex;flex-direction:column;gap:12px;margin-top:4px;';

        const mkColorInput = (label, initial, onChange) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-weight:500;';
            wrap.innerHTML = `<div><span class="__hint_color_dot" style="background:${initial}"></span><span>${label}</span></div>`;
            const inp = document.createElement('input');
            inp.type = 'color';
            inp.value = initial;
            inp.className = '__hint_color_input';
            inp.oninput = (e) => {
                const color = e.target.value;
                wrap.querySelector('.__hint_color_dot').style.background = color;
                onChange(color);
                clearHint();
                drawMultiHint();
            };
            wrap.appendChild(inp);
            return wrap;
        };

        colorsDiv.appendChild(mkColorInput('Ход 1 (Best)', state.colors.best, v => { state.colors.best = v; saveSetting('__hint_color_best', v); }));
        colorsDiv.appendChild(mkColorInput('Ход 2 (Mid)', state.colors.mid, v => { state.colors.mid = v; saveSetting('__hint_color_mid', v); }));
        colorsDiv.appendChild(mkColorInput('Ход 3 (Worst)', state.colors.worst, v => { state.colors.worst = v; saveSetting('__hint_color_worst', v); }));

        const labelTime = document.createElement('div');
        labelTime.style.cssText = 'display:flex;justify-content:space-between;font-weight:500;';
        const updateTimeLabel = () => {
            labelTime.innerHTML = `<span>Время на ход</span><b>${state.moveTime} с</b>`;
        };
        updateTimeLabel();

        const sliderTime = document.createElement('input');
        sliderTime.type = 'range';
        sliderTime.min = 1;
        sliderTime.max = 10;
        sliderTime.step = 1;
        sliderTime.value = state.moveTime;
        sliderTime.className = '__hint_slider';
        sliderTime.oninput = (e) => {
            state.moveTime = parseInt(e.target.value, 10);
            saveSetting('__hint_time', state.moveTime);
            updateTimeLabel();
            if (timeDebounce) clearTimeout(timeDebounce);
            timeDebounce = setTimeout(reanalyzeCurrent, 400);
        };

        const mkSwitch = (label, initial, onChange) => {
            const wrap = document.createElement('label');
            wrap.className = '__hint_row';
            const span = document.createElement('span');
            span.textContent = label;
            const inp = document.createElement('input');
            inp.type = 'checkbox';
            inp.checked = initial;
            inp.className = '__hint_switch';
            inp.onchange = () => onChange(inp.checked);
            wrap.appendChild(span);
            wrap.appendChild(inp);
            wrap.__input = inp;
            return wrap;
        };
        const swReview = mkSwitch('Разбор моих ходов', state.review, (v) => {
            state.review = v;
            saveSetting('__hint_review', v ? '1' : '0');
            if (!v) engine.reviewJob = null;
        });
        const swBar = mkSwitch('Шкала оценки', state.bar, (v) => {
            state.bar = v;
            saveSetting('__hint_bar', v ? '1' : '0');
            updateEvalBar();
        });

        const statsDiv = document.createElement('div');
        statsDiv.id = '__hint_stats';

        const resetBtn = document.createElement('button');
        resetBtn.className = '__hint_reset_btn';
        resetBtn.textContent = 'Сбросить настройки';
        resetBtn.onclick = () => {
            state.moveTime = 3;
            state.review = true;
            state.bar = true;
            saveSetting('__hint_time', 3);
            saveSetting('__hint_review', '1');
            saveSetting('__hint_bar', '1');
            sliderTime.value = 3; updateTimeLabel();
            swReview.__input.checked = true;
            swBar.__input.checked = true;
            updateEvalBar();

            state.currentElo = CONFIG.MAX_ELO;
            state.currentMultiPv = 3;
            state.colors.best = CONFIG.DEFAULT_COLORS.best;
            state.colors.mid = CONFIG.DEFAULT_COLORS.mid;
            state.colors.worst = CONFIG.DEFAULT_COLORS.worst;

            saveSetting('__hint_elo', state.currentElo);
            saveSetting('__hint_pv', state.currentMultiPv);
            saveSetting('__hint_color_best', state.colors.best);
            saveSetting('__hint_color_mid', state.colors.mid);
            saveSetting('__hint_color_worst', state.colors.worst);

            sliderElo.value = state.currentElo; updateEloLabel();
            sliderPv.value = state.currentMultiPv; labelPv.innerHTML = `<span>Количество ходов</span><b>3</b>`;

            const colorWraps = colorsDiv.children;
            const colVals = [state.colors.best, state.colors.mid, state.colors.worst];
            for (let i = 0; i < 3; i++) {
                const wrap = colorWraps[i];
                wrap.querySelector('input').value = colVals[i];
                wrap.querySelector('.__hint_color_dot').style.background = colVals[i];
            }

            if (state.worker && state.engineReady) {
                whenIdle(() => state.worker.postMessage('setoption name MultiPV value ' + state.currentMultiPv));
            }
            applyEloSetting();
            updateMultiPvUiState();
            clearHint();
            drawMultiHint();
        };

        inner.appendChild(labelElo);
        inner.appendChild(sliderElo);
        inner.appendChild(warning);
        inner.appendChild(labelPv);
        inner.appendChild(sliderPv);
        inner.appendChild(labelTime);
        inner.appendChild(sliderTime);
        inner.appendChild(swReview);
        inner.appendChild(swBar);
        inner.appendChild(colorsDiv);
        inner.appendChild(statsDiv);
        inner.appendChild(resetBtn);

        panel.appendChild(inner);

        document.body.appendChild(container);
        document.body.appendChild(panel);

        ui.container = container;
        ui.toggleBtn = toggleBtn;
        ui.panel = panel;
        ui.statusEl = statusDiv;
        applyButtonPosition();
        updateMultiPvUiState();
        updateStatsUi();

        console.log('[hint] panel created at', state.panelPos.x, state.panelPos.y,
                    'viewport', getViewportWidth(), 'x', getViewportHeight());

        let drag = {
            active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0,
            moved: false, pointerId: null, panelWasOpen: false
        };

        const onPointerDown = (e) => {
            drag.active = true;
            drag.startX = e.clientX;
            drag.startY = e.clientY;
            drag.startLeft = state.panelPos.x;
            drag.startTop = state.panelPos.y;
            drag.moved = false;
            drag.pointerId = e.pointerId;
            drag.panelWasOpen = (panel.style.display === 'flex');
            try { toggleBtn.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault();
        };

        const onPointerMove = (e) => {
            if (!drag.active || e.pointerId !== drag.pointerId) return;
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;

            if (!drag.moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
                drag.moved = true;
                if (panel.style.display === 'flex') closePanel();
            }
            if (!drag.moved) return;

            let nx = drag.startLeft + dx;
            let ny = drag.startTop + dy;
            nx = Math.max(4, Math.min(getViewportWidth() - 44, nx));
            ny = Math.max(4, Math.min(getViewportHeight() - 44, ny));
            state.panelPos.x = nx;
            state.panelPos.y = ny;
            applyButtonPosition();
        };

        const onPointerUp = (e) => {
            if (!drag.active || e.pointerId !== drag.pointerId) return;
            drag.active = false;
            try { toggleBtn.releasePointerCapture(drag.pointerId); } catch (err) {}

            if (drag.moved) {
                saveSetting('__hint_pos', JSON.stringify(state.panelPos));
                if (drag.panelWasOpen) openPanel();
            } else {
                if (panel.style.display === 'flex') {
                    closePanel();
                } else {
                    openPanel();
                }
            }
        };

        toggleBtn.addEventListener('pointerdown', onPointerDown);
        toggleBtn.addEventListener('pointermove', onPointerMove);
        toggleBtn.addEventListener('pointerup', onPointerUp);
        toggleBtn.addEventListener('pointercancel', onPointerUp);
    }

    function onViewportChange() {
        applyButtonPosition();
        if (ui.panel && ui.panel.style.display === 'flex') openPanel();
        updateEvalBar();
    }

    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', () => setTimeout(onViewportChange, 200));
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', onViewportChange);
    }

    function isOurNode(node) {
        const el = node && node.nodeType === 1 ? node : (node && node.parentElement);
        return !!(el && el.closest && el.closest('[class*="__hint_"]'));
    }

    let checkTimer = null;
    function scheduleCheck() {
        if (checkTimer !== null) return;
        checkTimer = setTimeout(() => { checkTimer = null; onMutation(true); }, 120);
    }

    function attachObserver(board) {
        if (boardObserver) boardObserver.disconnect();
        boardObserver = new MutationObserver((muts) => {
            for (const m of muts) {
                if (isOurNode(m.target)) continue;
                if (m.type === 'childList') {
                    const nodes = Array.from(m.addedNodes).concat(Array.from(m.removedNodes));
                    if (nodes.length && nodes.every(isOurNode)) continue;
                }
                scheduleCheck();
                return;
            }
        });
        const target = board.shadowRoot || board;
        try {
            boardObserver.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
        } catch (e) {}
    }

    function startPolling() {
        if (pollIntervalId !== null) return;
        pollIntervalId = setInterval(() => {
            const b = findBoard();
            if (b && b !== watchedBoard) {
                watchedBoard = b;
                attachObserver(b);
                pollTick = 0;
                onMutation(true);
                return;
            }
            if (++pollTick >= SAFETY_EVERY) {
                pollTick = 0;
                onMutation(false);
            }
        }, POLL_MS);
    }
    function stopPolling() {
        if (pollIntervalId !== null) {
            clearInterval(pollIntervalId);
            pollIntervalId = null;
        }
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopPolling();
        else { startPolling(); onMutation(true); }
    });

    function boot() {
        try {
            if (!document.body) { setTimeout(boot, 50); return; }
            console.log('[hint] boot()', 'viewport', getViewportWidth(), 'x', getViewportHeight());
            createControlPanel();
            initEngine();
            const b0 = findBoard();
            if (b0) { watchedBoard = b0; attachObserver(b0); }
            onMutation(true);
            startPolling();
            setTimeout(applyButtonPosition, 300);
            setTimeout(applyButtonPosition, 1200);
        } catch (e) {
            console.error('[hint] boot failed:', e && e.message, e && e.stack);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
