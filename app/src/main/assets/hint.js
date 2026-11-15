// ==UserScript==
// @name         chess hint (both sites)
// @version      62.0
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
        MIN_ELO: 1320,
        MAX_ELO: 3190,
        DEFAULT_ELO: 3190,
        HINT_DELAY_MS: 150,
        DEFAULT_BRACKET_COLOR: '#000000',
        DEFAULT_HIGHLIGHT_COLOR: '#000000',
    };

    const loadSetting = (k, d) => { try { const v = localStorage.getItem(k); return v !== null ? v : d; } catch(e) { return d; } };
    const saveSetting = (k, v) => { try { localStorage.setItem(k, v); } catch(e) {} };

    const state = {
        fen: null, worker: null, engineReady: false, engineStart: 0,
        lastBest: null, lastEval: null, lastDepth: 0,
        myColor: 'w', blunderChoice: false,
        currentElo: parseInt(loadSetting('__hint_elo', CONFIG.DEFAULT_ELO), 10) || CONFIG.DEFAULT_ELO,
        currentErrorRate: parseInt(loadSetting('__hint_err', 0), 10) || 0,
        bracketColor: loadSetting('__hint_bracket_color', CONFIG.DEFAULT_BRACKET_COLOR),
        highlightColor: loadSetting('__hint_highlight_color', CONFIG.DEFAULT_HIGHLIGHT_COLOR),
        lastMutationTime: 0,
    };

    const engine = { busy: false, queue: null, activeFen: null, watchdog: null, depthByFen: new Map(), latestPvs: { 1: null, 2: null } };
    const perf = { pendingHint: null, hintRafPending: false, hintDelayTimer: null, lastRenderedUci: null, lastRenderedEval: null };
    const _grid = Array.from({ length: 8 }, () => Array(8).fill(''));
    let watchedBoard = null, boardObserver = null;

    function getTurnFromFen(fen) { if (!fen) return 'w'; return (fen.split(' ')[1] || 'w'); }
    function cpToWinPct(cp) { const w = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1); return Math.round(Math.max(0, Math.min(100, w))); }

    function parseEval(line, turn) {
        const m = line.match(/\bscore (cp|mate) (-?\d+)\b/);
        if (!m) return { display: '', winPct: null };
        const kind = m[1]; let n = parseInt(m[2], 10);
        if (turn === 'b') n = -n;
        if (kind === 'mate') return { display: (n >= 0 ? '+M' : '-M') + Math.abs(n), winPct: n > 0 ? 100 : 0 };
        const v = n / 100;
        if (Math.abs(v) < 0.05) return { display: '0.0', winPct: 50 };
        const s = Math.abs(v).toFixed(1).replace(/\.0$/, '');
        return { display: v > 0 ? '+' + s : '-' + s, winPct: cpToWinPct(n) };
    }

    const TYPE_MAP = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };

    function extractPiece(el) {
        const cl = el.classList;
        let type = null;
        for (const t of ['king', 'queen', 'rook', 'bishop', 'knight', 'pawn']) {
            if (cl.contains(t)) { type = TYPE_MAP[t]; break; }
        }
        let color = cl.contains('white') ? 'w' : cl.contains('black') ? 'b' : null;

        if (!type || !color) {
            for (const c of cl) {
                if (/^[wb][pnbrqk]$/.test(c)) { color = c[0]; type = c[1]; break; }
            }
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
        return board.classList.contains('flipped') || board.getAttribute('data-orientation') === 'black';
    }

    function detectTurn(board) {
        const flipped = isFlipped(board);
        if (IS_LICHESS) {
            const lclock = document.querySelector('.lclock');
            const rclock = document.querySelector('.rclock');
            if (lclock && lclock.classList.contains('running')) return flipped ? 'b' : 'w';
            if (rclock && rclock.classList.contains('running')) return flipped ? 'w' : 'b';
            const moves = document.querySelectorAll('move');
            if (moves.length > 0) return moves.length % 2 === 0 ? 'w' : 'b';
            return null;
        } else {
            const active = document.querySelector('.clock-player-turn, [class*="clock-player-turn"]');
            if (active) {
                const clockEl = active.closest('[class*="clock"]') || active;
                const isTop = clockEl.className.includes('top');
                return isTop ? (flipped ? 'w' : 'b') : (flipped ? 'b' : 'w');
            }
            try {
                const g = board.game;
                if (g) {
                    if (typeof g.getTurn === 'function') {
                        const t = g.getTurn();
                        if (t === 'w' || t === 'b') return t;
                    }
                    if (g.turn === 'w' || g.turn === 'b') return g.turn;
                }
            } catch (e) {}
            return null;
        }
    }

    function detectMyColor(board) {
        const flipped = isFlipped(board);
        if (!IS_LICHESS) {
            try {
                const g = board.game;
                if (g) {
                    for (const fn of ['getPlayingColor', 'getMyColor', 'getPlayerColor']) {
                        if (typeof g[fn] === 'function') {
                            const c = g[fn]();
                            if (c === 'w' || c === 'b') return c;
                            if (c === 'white') return 'w';
                            if (c === 'black') return 'b';
                        }
                    }
                }
            } catch (e) {}
            const attr = board.getAttribute && board.getAttribute('data-user-color');
            if (attr === 'w' || attr === 'b') return attr;
        }
        return flipped ? 'b' : 'w';
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

        els.forEach(p => {
            const info = extractPiece(p);
            if (!info) return;
            const pr = p.getBoundingClientRect();
            if (pr.width < 4) return;
            const col = Math.floor((pr.left + pr.width / 2 - br.left) / cellW);
            const row = Math.floor((pr.top + pr.height / 2 - br.top) / cellH);
            if (col < 0 || col > 7 || row < 0 || row > 7) return;
            const file = flipped ? 7 - col : col;
            const rank = flipped ? row : 7 - row;
            _grid[rank][file] = info.color === 'w' ? info.type.toUpperCase() : info.type;
        });

        let boardStr = '';
        for (let r = 7; r >= 0; r--) {
            let empty = 0;
            for (let f = 0; f < 8; f++) {
                const pc = _grid[r][f];
                if (pc) { if (empty) { boardStr += empty; empty = 0; } boardStr += pc; }
                else empty++;
            }
            if (empty) boardStr += empty;
            if (r > 0) boardStr += '/';
        }

        let castling = '';
        if (_grid[0][4] === 'K') {
            if (_grid[0][7] === 'R') castling += 'K';
            if (_grid[0][0] === 'R') castling += 'Q';
        }
        if (_grid[7][4] === 'k') {
            if (_grid[7][7] === 'r') castling += 'k';
            if (_grid[7][0] === 'r') castling += 'q';
        }
        if (!castling) castling = '-';

        const turn = detectTurn(board) || (flipped ? 'b' : 'w');
        const myColor = detectMyColor(board);

        return { fen: boardStr + ' ' + turn + ' ' + castling + ' - 0 1', turn, myColor };
    }

    async function tryInitLocalEngine() {
        if (!window.NativeHint || !window.NativeHint.getStockfishJs) {
            throw new Error("Native bridge not found");
        }
        const scriptContent = window.NativeHint.getStockfishJs();
        if (!scriptContent || scriptContent.length < 10000) {
            throw new Error("stockfish script invalid: length=" + (scriptContent ? scriptContent.length : 0));
        }
        const blob = new Blob([scriptContent], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));
        return { worker };
    }

    async function initEngine() {
        state.engineStart = performance.now();
        let worker;
        try {
            const r = await tryInitLocalEngine();
            worker = r.worker;
        } catch (e) {
            console.error("[hint]", e);
            return;
        }

        state.worker = worker;
        worker.onmessage = (e) => {
            const line = typeof e.data === 'string' ? e.data : '';
            if (line === 'uciok') {
                worker.postMessage('setoption name MultiPV value ' + (state.currentErrorRate > 0 ? 2 : 1));
                worker.postMessage('setoption name Hash value 16');
                if (state.currentElo < CONFIG.MAX_ELO) {
                    worker.postMessage('setoption name UCI_Elo value ' + state.currentElo);
                    worker.postMessage('setoption name UCI_LimitStrength value true');
                } else {
                    worker.postMessage('setoption name UCI_LimitStrength value false');
                }
                worker.postMessage('isready');
            } else if (line === 'readyok') {
                state.engineReady = true;
                if (state.fen) analyze(state.fen);
            } else if (line.startsWith('info ')) {
                if (engine.activeFen !== state.fen) return;
                if (!/\bpv\b/.test(line)) return;
                const dm = line.match(/\bdepth (\d+)\b/);
                if (!dm) return;
                const depth = parseInt(dm[1], 10);
                const curDepth = engine.depthByFen.get(engine.activeFen) || 0;
                if (depth < curDepth) return;
                if (depth > curDepth) { engine.depthByFen.set(engine.activeFen, depth); engine.latestPvs = { 1: null, 2: null }; }
                const mpvM = line.match(/\bmultipv (\d+)\b/);
                const mpvIdx = mpvM ? parseInt(mpvM[1], 10) : 1;
                const pvm = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);
                if (!pvm) return;
                engine.latestPvs[mpvIdx] = { mv: pvm[1], eval: parseEval(line, getTurnFromFen(state.fen)) };

                if (engine.latestPvs[1]) {
                    let chosen = engine.latestPvs[1];
                    if (state.blunderChoice && engine.latestPvs[2]) chosen = engine.latestPvs[2];
                    state.lastDepth = depth;
                    state.lastBest = chosen.mv;
                    state.lastEval = chosen.eval.display;
                    drawHint(chosen.mv, chosen.eval);
                }
            } else if (line.startsWith('bestmove')) {
                if (engine.watchdog) { clearTimeout(engine.watchdog); engine.watchdog = null; }
                engine.busy = false; engine.activeFen = null;
                if (engine.queue) { const n = engine.queue; engine.queue = null; analyze(n); }
            }
        };
        worker.onerror = (e) => console.error("[hint] worker error", e);
        worker.postMessage('uci');
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
        engine.busy = true; engine.activeFen = fen;
        engine.depthByFen.set(fen, 0);
        engine.latestPvs = { 1: null, 2: null };
        state.lastDepth = 0;
        state.worker.postMessage('position fen ' + fen);
        state.worker.postMessage('go movetime ' + CONFIG.ENGINE_MOVETIME);

        if (engine.watchdog) clearTimeout(engine.watchdog);
        engine.watchdog = setTimeout(() => {
            if (!engine.busy || engine.activeFen !== fen) return;
            try { state.worker.postMessage('stop'); } catch(e) {}
            setTimeout(() => {
                if (engine.busy && engine.activeFen === fen) {
                    engine.busy = false;
                    engine.activeFen = null;
                    if (engine.queue) { const n = engine.queue; engine.queue = null; analyze(n); }
                }
            }, 200);
        }, CONFIG.ENGINE_MOVETIME + 800);
    }

    function processFen(info) {
        if (!info || !info.fen) return;
        if (info.fen === state.fen) return;

        state.fen = info.fen;
        state.myColor = info.myColor;
        clearHint();

        if (info.turn && info.turn !== info.myColor) {
            if (engine.busy && state.worker) try { state.worker.postMessage('stop'); } catch(e){}
            engine.queue = null;
            return;
        }

        state.blunderChoice = state.currentErrorRate > 0 && (Math.random() * 100 < state.currentErrorRate);
        analyze(info.fen);
    }

    function onMutation() {
        if (document.hidden) return;
        const now = performance.now();
        if (now - state.lastMutationTime < 150) return;
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
        perf.lastRenderedUci = null;
        perf.lastRenderedEval = null;
        if (watchedBoard) {
            const host = watchedBoard.querySelector('.__hint_host');
            if (host && host.shadowRoot) host.shadowRoot.innerHTML = '';
        }
    }

    function drawHint(uci, evalObj) {
        const sameUci = uci === perf.lastRenderedUci;
        const sameEval = evalObj && evalObj.display === perf.lastRenderedEval;

        if (sameUci && sameEval) return;

        if (sameUci) {
            perf.pendingHint = { uci, evalObj, fen: state.fen };
            if (!perf.hintRafPending) {
                perf.hintRafPending = true;
                requestAnimationFrame(renderPendingHint);
            }
            return;
        }

        perf.pendingHint = { uci, evalObj, fen: state.fen };
        if (perf.hintDelayTimer) clearTimeout(perf.hintDelayTimer);
        perf.hintDelayTimer = setTimeout(() => {
            perf.hintDelayTimer = null;
            if (!perf.hintRafPending) {
                perf.hintRafPending = true;
                requestAnimationFrame(renderPendingHint);
            }
        }, CONFIG.HINT_DELAY_MS);
    }

    function renderPendingHint() {
        perf.hintRafPending = false;
        const pending = perf.pendingHint;
        perf.pendingHint = null;
        if (!pending || state.fen !== pending.fen) return;

        const board = findBoard();
        if (!board) return;

        let host = board.querySelector('.__hint_host');
        if (!host) {
            host = document.createElement('div');
            host.className = '__hint_host';
            host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:9999;';
            if (getComputedStyle(board).position === 'static') board.style.position = 'relative';
            board.appendChild(host);
        }
        let shadow = host.shadowRoot;
        if (!shadow) shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = '';

        const br = board.getBoundingClientRect();
        const W = br.width, H = br.height;
        const cell = Math.min(W, H) / 8;
        const offX = (W - cell * 8) / 2, offY = (H - cell * 8) / 2;
        const flipped = isFlipped(board);

        const sqXY = (sq) => {
            const f = sq.charCodeAt(0) - 97, r = parseInt(sq[1], 10) - 1;
            return { x: (flipped ? 7 - f : f) * cell + cell / 2 + offX, y: (flipped ? r : 7 - r) * cell + cell / 2 + offY };
        };

        const a = sqXY(pending.uci.slice(0, 2));
        const b = sqXY(pending.uci.slice(2, 4));
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.style.cssText = 'position:absolute;inset:0;';

        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', b.x - cell / 2);
        rect.setAttribute('y', b.y - cell / 2);
        rect.setAttribute('width', cell);
        rect.setAttribute('height', cell);
        rect.setAttribute('fill', state.highlightColor);
        rect.setAttribute('fill-opacity', '0.35');
        svg.appendChild(rect);

        const mkPath = (x, y, size) => {
            const h = size / 2, l = size * 0.25;
            return `M ${x-h+l} ${y-h} L ${x-h} ${y-h} L ${x-h} ${y-h+l} M ${x+h-l} ${y-h} L ${x+h} ${y-h} L ${x+h} ${y-h+l} M ${x+h} ${y+h-l} L ${x+h} ${y+h} L ${x+h-l} ${y+h} M ${x-h+l} ${y+h} L ${x-h} ${y+h} L ${x-h} ${y+h-l}`;
        };

        const p1 = document.createElementNS(ns, 'path');
        p1.setAttribute('d', mkPath(a.x, a.y, cell * 0.7));
        p1.setAttribute('fill', 'none');
        p1.setAttribute('stroke', state.bracketColor);
        p1.setAttribute('stroke-width', cell * 0.03);
        svg.appendChild(p1);

        const p2 = document.createElementNS(ns, 'path');
        p2.setAttribute('d', mkPath(b.x, b.y, cell * 0.8));
        p2.setAttribute('fill', 'none');
        p2.setAttribute('stroke', state.bracketColor);
        p2.setAttribute('stroke-width', cell * 0.05);
        svg.appendChild(p2);

        if (pending.evalObj && pending.evalObj.winPct != null) {
            const t = document.createElementNS(ns, 'text');
            t.setAttribute('x', b.x);
            t.setAttribute('y', b.y);
            t.setAttribute('text-anchor', 'middle');
            t.setAttribute('dominant-baseline', 'central');
            t.setAttribute('fill', '#fff');
            t.setAttribute('stroke', '#000');
            t.setAttribute('stroke-width', '3');
            t.setAttribute('paint-order', 'stroke');
            t.setAttribute('font-family', 'sans-serif');
            t.setAttribute('font-weight', 'bold');
            t.setAttribute('font-size', cell * 0.25);
            t.textContent = (state.myColor === 'w' ? pending.evalObj.winPct : 100 - pending.evalObj.winPct) + '%';
            svg.appendChild(t);
        }

        shadow.appendChild(svg);
        perf.lastRenderedUci = pending.uci;
        perf.lastRenderedEval = pending.evalObj ? pending.evalObj.display : null;
    }

    function createControlPanel() {
        if (document.getElementById('__hint_controls')) return;
        const container = document.createElement('div');
        container.id = '__hint_controls';
        container.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font-family:system-ui,sans-serif;';

        const toggleBtn = document.createElement('button');
        toggleBtn.innerHTML = '⚙️';
        toggleBtn.style.cssText = 'width:32px;height:32px;border-radius:50%;background:rgba(15,15,20,0.82);color:#fff;border:1px solid rgba(255,255,255,0.08);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;';

        const panel = document.createElement('div');
        panel.id = '__hint_controls_panel';
        panel.style.cssText = 'display:none;flex-direction:column;gap:8px;background:rgba(15,15,20,0.82);color:#e0e0e0;padding:12px;border-radius:8px;font-size:12px;width:200px;';

        const labelElo = document.createElement('div');
        labelElo.innerHTML = `Сила: <b>${state.currentElo >= CONFIG.MAX_ELO ? 'MAX' : state.currentElo}</b> Elo`;
        const sliderElo = document.createElement('input');
        sliderElo.type = 'range'; sliderElo.min = CONFIG.MIN_ELO; sliderElo.max = CONFIG.MAX_ELO; sliderElo.step = 10; sliderElo.value = state.currentElo;
        sliderElo.style.cssText = 'width:100%;cursor:pointer;';
        sliderElo.oninput = (e) => {
            const val = parseInt(e.target.value, 10);
            state.currentElo = val; saveSetting('__hint_elo', val);
            labelElo.innerHTML = `Сила: <b>${val >= CONFIG.MAX_ELO ? 'MAX' : val}</b> Elo`;
            if (state.worker && state.engineReady) {
                if (val >= CONFIG.MAX_ELO) state.worker.postMessage('setoption name UCI_LimitStrength value false');
                else { state.worker.postMessage('setoption name UCI_Elo value ' + val); state.worker.postMessage('setoption name UCI_LimitStrength value true'); }
            }
        };

        const labelErr = document.createElement('div');
        labelErr.innerHTML = `Ошибки: <b>${state.currentErrorRate}%</b>`;
        const sliderErr = document.createElement('input');
        sliderErr.type = 'range'; sliderErr.min = 0; sliderErr.max = 50; sliderErr.step = 1; sliderErr.value = state.currentErrorRate;
        sliderErr.style.cssText = 'width:100%;cursor:pointer;';
        sliderErr.oninput = (e) => {
            const val = parseInt(e.target.value, 10);
            state.currentErrorRate = val; saveSetting('__hint_err', val);
            labelErr.innerHTML = `Ошибки: <b>${val}%</b>`;
            if (state.worker && state.engineReady) {
                state.worker.postMessage('setoption name MultiPV value ' + (val > 0 ? 2 : 1));
                if (engine.busy && state.fen) { engine.queue = state.fen; state.worker.postMessage('stop'); }
            }
        };

        const colorsDiv = document.createElement('div');
        colorsDiv.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
        const cbWrap = document.createElement('div');
        cbWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
        cbWrap.innerHTML = '<span>Уголки:</span>';
        const cb = document.createElement('input');
        cb.type = 'color'; cb.value = state.bracketColor;
        cb.style.cssText = 'width:24px;height:24px;border:none;padding:0;background:none;cursor:pointer;';
        cb.oninput = (e) => { state.bracketColor = e.target.value; saveSetting('__hint_bracket_color', e.target.value); };
        cbWrap.appendChild(cb);

        const hlWrap = document.createElement('div');
        hlWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
        hlWrap.innerHTML = '<span>Клетка:</span>';
        const hl = document.createElement('input');
        hl.type = 'color'; hl.value = state.highlightColor;
        hl.style.cssText = 'width:24px;height:24px;border:none;padding:0;background:none;cursor:pointer;';
        hl.oninput = (e) => { state.highlightColor = e.target.value; saveSetting('__hint_highlight_color', e.target.value); };
        hlWrap.appendChild(hl);

        colorsDiv.appendChild(cbWrap);
        colorsDiv.appendChild(hlWrap);

        panel.appendChild(labelElo); panel.appendChild(sliderElo);
        panel.appendChild(labelErr); panel.appendChild(sliderErr);
        panel.appendChild(colorsDiv);
        container.appendChild(toggleBtn); container.appendChild(panel);
        document.body.appendChild(container);

        toggleBtn.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; };
    }

    function attachObserver(board) {
        if (boardObserver) boardObserver.disconnect();
        boardObserver = new MutationObserver(onMutation);
        const target = board.shadowRoot || board;
        try { boardObserver.observe(target, { childList: true, subtree: true }); } catch (e) {}
    }

    function boot() {
        createControlPanel();
        initEngine();

        const b0 = findBoard();
        if (b0) { watchedBoard = b0; attachObserver(b0); }
        onMutation();

        setInterval(() => {
            const b = findBoard();
            if (b && b !== watchedBoard) {
                watchedBoard = b;
                attachObserver(b);
            }
            onMutation();
        }, 300);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
