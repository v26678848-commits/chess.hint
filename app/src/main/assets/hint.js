// ==UserScript==
// @name         chess hint (v82 ASM Stable)
// @version      82.0
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
        MIN_ELO: 1320,
        MAX_ELO: 3190,
        DEFAULT_ELO: 3190,
        DEFAULT_COLORS: { best: '#008000', mid: '#0066cc', worst: '#cc0000' }
    };

    const loadSetting = (k, d) => { try { const v = localStorage.getItem(k); return v !== null ? v : d; } catch(e) { return d; } };
    const saveSetting = (k, v) => { try { localStorage.setItem(k, v); } catch(e) {} };

    function getViewportHeight() { return document.documentElement.clientHeight || window.innerHeight; }
    function getViewportWidth() { return document.documentElement.clientWidth || window.innerWidth; }

    function loadPanelPosition() {
        try {
            const s = localStorage.getItem('__hint_pos');
            if (s) {
                const p = JSON.parse(s);
                if (typeof p.x === 'number' && typeof p.y === 'number') {
                    return {
                        x: Math.max(4, Math.min(getViewportWidth() - 44, p.x)),
                        y: Math.max(4, Math.min(getViewportHeight() - 44, p.y))
                    };
                }
            }
        } catch (e) {}
        return { x: getViewportWidth() - 44 - 8, y: 8 };
    }

    const state = {
        fen: null, worker: null, engineReady: false, engineStart: 0,
        lastDepth: 0, myColor: 'w', lastMutationTime: 0,
        currentMultiPv: parseInt(loadSetting('__hint_pv', 3), 10) || 3,
        currentElo: parseInt(loadSetting('__hint_elo', CONFIG.DEFAULT_ELO), 10) || CONFIG.DEFAULT_ELO,
        colors: {
            best: loadSetting('__hint_color_best', CONFIG.DEFAULT_COLORS.best),
            mid: loadSetting('__hint_color_mid', CONFIG.DEFAULT_COLORS.mid),
            worst: loadSetting('__hint_color_worst', CONFIG.DEFAULT_COLORS.worst)
        },
        panelPos: loadPanelPosition(),
    };

    const engine = { 
        busy: false, queue: null, activeFen: null, watchdog: null, 
        depthByFen: new Map(), 
        latestPvs: { 1: null, 2: null, 3: null } 
    };
    
    const perf = { pendingHint: null, hintRafPending: false, hintDelayTimer: null, lastRenderedKey: null };
    const _grid = Array.from({ length: 8 }, () => Array(8).fill(''));
    let watchedBoard = null, boardObserver = null;
    let eloDebounce = null;

    let ui = { container: null, toggleBtn: null, panel: null };

    function injectCustomCSS() {
        if (document.getElementById('__hint_styles')) return;
        const style = document.createElement('style');
        style.id = '__hint_styles';
        style.textContent = `
            .__hint_slider { -webkit-appearance: none; width: 100%; height: 4px; background: #444; border-radius: 2px; outline: none; margin: 8px 0; transition: opacity 0.2s; }
            .__hint_slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #fff; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.5); transition: transform 0.1s; }
            .__hint_slider::-webkit-slider-thumb:active { transform: scale(1.2); }
            .__hint_slider:disabled { cursor: not-allowed; }
            .__hint_slider:disabled::-webkit-slider-thumb { background: #888; cursor: not-allowed; transform: none; }
            
            .__hint_color_input { -webkit-appearance: none; border: none; width: 24px; height: 24px; border-radius: 6px; padding: 0; background: none; cursor: pointer; }
            .__hint_color_input::-webkit-color-swatch-wrapper { padding: 0; }
            .__hint_color_input::-webkit-color-swatch { border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; }
            
            .__hint_toggle_btn {
                width: 44px; height: 44px; border-radius: 12px;
                background: linear-gradient(135deg, rgba(40,40,45,0.8), rgba(20,20,25,0.8));
                color: #fff;
                backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
                border: 1px solid rgba(255,255,255,0.15);
                border-top-color: rgba(255,255,255,0.3);
                cursor: grab; display: flex; align-items: center; justify-content: center;
                box-shadow: 0 4px 15px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1);
                touch-action: none; user-select: none; -webkit-user-select: none;
                -webkit-tap-highlight-color: transparent;
                transition: transform 0.1s, background 0.2s;
            }
            .__hint_toggle_btn:hover { background: linear-gradient(135deg, rgba(60,60,65,0.85), rgba(30,30,35,0.85)); }
            .__hint_toggle_btn:active { cursor: grabbing; transform: scale(0.92); }
            
            .__hint_panel_inner { display: flex; flex-direction: column; gap: 14px; }
            
            .__hint_reset_btn {
                margin-top: 6px; padding: 8px; border-radius: 8px;
                background: rgba(255,255,255,0.1); color: #eee;
                border: 1px solid rgba(255,255,255,0.1);
                font-size: 12px; font-weight: 500; cursor: pointer;
                text-align: center; transition: background 0.2s;
            }
            .__hint_reset_btn:hover { background: rgba(255,255,255,0.15); }
            .__hint_reset_btn:active { background: rgba(255,255,255,0.05); }
            
            .__hint_color_dot {
                width: 10px; height: 10px; border-radius: 50%;
                display: inline-block; margin-right: 6px;
                border: 1px solid rgba(255,255,255,0.3);
                vertical-align: middle;
            }
        `;
        document.head.appendChild(style);
    }

    function getTurnFromFen(fen) { if (!fen) return 'w'; return (fen.split(' ')[1] || 'w'); }
    function cpToWinPct(cp) { const w = 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1); return Math.round(Math.max(0, Math.min(100, w))); }

    function parseEval(line, turn) {
        const m = line.match(/\bscore (cp|mate) (-?\d+)\b/);
        if (!m) return { display: '', winPct: null, isMate: false };
        const kind = m[1]; let n = parseInt(m[2], 10);
        if (turn === 'b') n = -n;
        if (kind === 'mate') return { display: (n >= 0 ? '+M' : '-M') + Math.abs(n), winPct: n > 0 ? 100 : 0, isMate: true };
        const v = n / 100;
        if (Math.abs(v) < 0.05) return { display: '0.0', winPct: 50, isMate: false };
        const s = Math.abs(v).toFixed(1).replace(/\.0$/, '');
        return { display: v > 0 ? '+' + s : '-' + s, winPct: cpToWinPct(n), isMate: false };
    }

    function getBracketPath(cx, cy, size, arm) {
        const h = size / 2, l = arm;
        const x1 = cx - h, x2 = cx + h, y1 = cy - h, y2 = cy + h;
        return `M ${x1+l} ${y1} L ${x1} ${y1} L ${x1} ${y1+l} M ${x2-l} ${y1} L ${x2} ${y1} L ${x2} ${y1+l} M ${x2} ${y2-l} L ${x2} ${y2} L ${x2-l} ${y2} M ${x1+l} ${y2} L ${x1} ${y2} L ${x1} ${y2-l}`;
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
                    if (typeof g.getTurn === 'function') { const t = g.getTurn(); if (t === 'w' || t === 'b') return t; }
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
                if (pc) { if (empty) { boardStr += empty; empty = 0; } boardStr += pc; } else empty++;
            }
            if (empty) boardStr += empty;
            if (r > 0) boardStr += '/';
        }
        let castling = '';
        if (_grid[0][4] === 'K') { if (_grid[0][7] === 'R') castling += 'K'; if (_grid[0][0] === 'R') castling += 'Q'; }
        if (_grid[7][4] === 'k') { if (_grid[7][7] === 'r') castling += 'k'; if (_grid[7][0] === 'r') castling += 'q'; }
        if (!castling) castling = '-';
        const turn = detectTurn(board) || (flipped ? 'b' : 'w');
        const myColor = detectMyColor(board);
        return { fen: boardStr + ' ' + turn + ' ' + castling + ' - 0 1', turn, myColor };
    }

    // ===== ЗАГРУЗКА ДВИЖКА =====
    async function tryInitLocalEngine() {
        if (!window.NativeHint || !window.NativeHint.getStockfishJs) {
            throw new Error("Native bridge not found");
        }
        
        const jsContent = window.NativeHint.getStockfishJs();
        if (!jsContent || jsContent.length < 10000) throw new Error("stockfish JS invalid");

        const blob = new Blob([jsContent], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));
        
        return { worker };
    }

    function isEloMax() { return state.currentElo >= CONFIG.MAX_ELO; }

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
        if (!state.worker || !state.engineReady) return;
        const isMax = isEloMax();
        if (isMax) {
            state.worker.postMessage('setoption name UCI_LimitStrength value false');
        } else {
            state.worker.postMessage('setoption name UCI_LimitStrength value true');
            state.worker.postMessage('setoption name UCI_Elo value ' + state.currentElo);
        }
        if (engine.busy && state.worker) {
            try { state.worker.postMessage('stop'); } catch(e) {}
        }
        if (!isMax) {
            clearHint();
            engine.queue = null;
        } else {
            if (state.fen) {
                engine.queue = state.fen; 
                if (!engine.busy) {
                    const q = engine.queue;
                    engine.queue = null;
                    analyze(q);
                }
            }
        }
        updateMultiPvUiState();
    }

    async function initEngine() {
        state.engineStart = performance.now();
        let worker;
        try {
            const r = await tryInitLocalEngine();
            worker = r.worker;
        } catch (e) { console.error("[hint]", e); return; }

        state.worker = worker;
        worker.onmessage = (e) => {
            const line = typeof e.data === 'string' ? e.data : '';
            if (line === 'uciok') {
                worker.postMessage('setoption name MultiPV value ' + state.currentMultiPv);
                worker.postMessage('setoption name Hash value 32');
                if (isEloMax()) {
                    worker.postMessage('setoption name UCI_LimitStrength value false');
                } else {
                    worker.postMessage('setoption name UCI_LimitStrength value true');
                    worker.postMessage('setoption name UCI_Elo value ' + state.currentElo);
                }
                worker.postMessage('isready');
            } else if (line === 'readyok') {
                state.engineReady = true;
                if (state.fen && isEloMax()) analyze(state.fen);
            } else if (line.startsWith('info ')) {
                if (engine.activeFen !== state.fen) return;
                if (!isEloMax()) return;
                if (!/\bpv\b/.test(line)) return;
                const dm = line.match(/\bdepth (\d+)\b/);
                if (!dm) return;
                const depth = parseInt(dm[1], 10);
                const curDepth = engine.depthByFen.get(engine.activeFen) || 0;
                if (depth < curDepth) return;
                if (depth > curDepth) { 
                    engine.depthByFen.set(engine.activeFen, depth); 
                    engine.latestPvs = { 1: null, 2: null, 3: null }; 
                }
                const mpvM = line.match(/\bmultipv (\d+)\b/);
                const mpvIdx = mpvM ? parseInt(mpvM[1], 10) : 1;
                const pvm = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);
                if (!pvm) return;
                engine.latestPvs[mpvIdx] = { mv: pvm[1], eval: parseEval(line, getTurnFromFen(state.fen)) };
                if (engine.latestPvs[1]) {
                    state.lastDepth = depth;
                    drawMultiHint();
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
        if (!isEloMax()) return;
        if (engine.busy) {
            if (engine.activeFen !== fen) {
                engine.queue = fen;
                try { state.worker.postMessage('stop'); } catch(e) {}
            }
            return;
        }
        engine.busy = true; engine.activeFen = fen;
        engine.depthByFen.set(fen, 0);
        engine.latestPvs = { 1: null, 2: null, 3: null };
        state.lastDepth = 0;
        state.worker.postMessage('position fen ' + fen);
        state.worker.postMessage('go movetime ' + CONFIG.ENGINE_MOVETIME);

        if (engine.watchdog) clearTimeout(engine.watchdog);
        engine.watchdog = setTimeout(() => {
            if (!engine.busy || engine.activeFen !== fen) return;
            try { state.worker.postMessage('stop'); } catch(e) {}
        }, CONFIG.ENGINE_MOVETIME + 1000);
    }

    function processFen(info) {
        if (!info || !info.fen) return;
        if (info.fen === state.fen) return;
        state.fen = info.fen;
        state.myColor = info.myColor;
        clearHint();
        if (!isEloMax()) {
            if (engine.busy && state.worker) try { state.worker.postMessage('stop'); } catch(e){}
            engine.queue = null;
            return;
        }
        if (info.turn && info.turn !== info.myColor) {
            if (engine.busy && state.worker) try { state.worker.postMessage('stop'); } catch(e){}
            engine.queue = null;
            return;
        }
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
        perf.lastRenderedKey = null;
        if (watchedBoard) {
            const root = watchedBoard.shadowRoot || watchedBoard;
            const host = root.querySelector('.__hint_host');
            if (host && host.shadowRoot) host.shadowRoot.innerHTML = '';
        }
    }

    function drawMultiHint() {
        if (!isEloMax()) return;
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
        if (!isEloMax()) { clearHint(); return; }

        const pvs = engine.latestPvs;
        const evalText = pvs[1] && pvs[1].eval ? pvs[1].eval.display : '';
        const cacheKey = state.fen + '_' + state.lastDepth + '_' + state.currentMultiPv + '_' + evalText;
        if (perf.lastRenderedKey === cacheKey) return; 
        perf.lastRenderedKey = cacheKey;

        const board = findBoard();
        if (!board) return;

        const boardRoot = board.shadowRoot || board;
        let host = boardRoot.querySelector('.__hint_host');
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

        const br = board.getBoundingClientRect();
        const W = br.width, H = br.height;
        const cell = Math.min(W, H) / 8;
        const offX = (W - cell * 8) / 2, offY = (H - cell * 8) / 2;
        const flipped = isFlipped(board);

        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.style.cssText = 'position:absolute;inset:0;overflow:visible;';
        svg.setAttribute('overflow', 'visible');

        const sqXY = (sq) => {
            const f = sq.charCodeAt(0) - 97, r = parseInt(sq[1], 10) - 1;
            return { x: (flipped ? 7 - f : f) * cell + cell / 2 + offX, y: (flipped ? r : 7 - r) * cell + cell / 2 + offY };
        };

        const drawOne = (uci, evalObj, rank) => {
            if (!uci) return;
            const color = state.colors[rank];
            const a = sqXY(uci.slice(0, 2));
            const b = sqXY(uci.slice(2, 4));

            const bracketPath = getBracketPath(b.x, b.y, cell * 0.75, cell * 0.25);
            const bracket = document.createElementNS(ns, 'path');
            bracket.setAttribute('d', bracketPath);
            bracket.setAttribute('fill', 'none');
            bracket.setAttribute('stroke', color);
            bracket.setAttribute('stroke-width', cell * 0.05);
            bracket.setAttribute('stroke-linejoin', 'miter');
            svg.appendChild(bracket);

            const ang = Math.atan2(b.y - a.y, b.x - a.x);
            const headSize = cell * 0.25;
            const lineEndX = b.x - Math.cos(ang) * (headSize * 0.8);
            const lineEndY = b.y - Math.sin(ang) * (headSize * 0.8);

            const line = document.createElementNS(ns, 'line');
            line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
            line.setAttribute('x2', lineEndX); line.setAttribute('y2', lineEndY);
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', cell * 0.08);
            line.setAttribute('stroke-linecap', 'round');
            svg.appendChild(line);

            const p2x = lineEndX - headSize * 0.5 * Math.cos(ang - Math.PI/6);
            const p2y = lineEndY - headSize * 0.5 * Math.sin(ang - Math.PI/6);
            const p3x = lineEndX - headSize * 0.5 * Math.cos(ang + Math.PI/6);
            const p3y = lineEndY - headSize * 0.5 * Math.sin(ang + Math.PI/6);
            
            const poly = document.createElementNS(ns, 'polygon');
            poly.setAttribute('points', `${b.x},${b.y} ${p2x},${p2y} ${p3x},${p3y}`);
            poly.setAttribute('fill', color);
            svg.appendChild(poly);

            if (evalObj && evalObj.display) {
                let evalText = evalObj.display;
                if (state.myColor === 'b') {
                    if (evalText.startsWith('+')) evalText = '-' + evalText.slice(1);
                    else if (evalText.startsWith('-')) evalText = '+' + evalText.slice(1);
                }
                const t = document.createElementNS(ns, 'text');
                t.setAttribute('x', b.x + cell * 0.35);
                t.setAttribute('y', b.y - cell * 0.35);
                t.setAttribute('fill', color);
                t.setAttribute('font-family', 'system-ui, sans-serif');
                t.setAttribute('font-weight', 'bold');
                t.setAttribute('font-size', cell * 0.22);
                t.setAttribute('stroke', '#ffffff');
                t.setAttribute('stroke-width', cell * 0.04);
                t.setAttribute('paint-order', 'stroke');
                t.textContent = evalText;
                svg.appendChild(t);
            }
        };

        if (state.currentMultiPv >= 1 && pvs[1]) drawOne(pvs[1].mv, pvs[1].eval, 'best');
        if (state.currentMultiPv >= 2 && pvs[2]) drawOne(pvs[2].mv, pvs[2].eval, 'mid');
        if (state.currentMultiPv >= 3 && pvs[3]) drawOne(pvs[3].mv, pvs[3].eval, 'worst');

        shadow.appendChild(svg);
    }

    function applyButtonPosition() {
        if (!ui.container || !state.panelPos) return;
        ui.container.style.left = state.panelPos.x + 'px';
        ui.container.style.top = state.panelPos.y + 'px';
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
        injectCustomCSS();

        const container = document.createElement('div');
        container.id = '__hint_controls';
        container.style.cssText = 'position:fixed;z-index:100001;width:44px;height:44px;';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = '__hint_toggle_btn';
        toggleBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="24" height="24">
                <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.06-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.73,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.06,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.49-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" fill="rgba(255,255,255,0.85)"/>
                <path d="M20.5 8.5l-2.2 2.2-1.5-1.5 2.2-2.2c-.5-2-2.3-3.5-4.5-3.5-1 0-2 .3-2.8.9l3 3c.4.4.4 1 0 1.4l-1.8 1.8c-.4.4-1 .4-1.4 0l-3-3c-.6.8-.9 1.8-.9 2.8 0 2.2 1.5 4 3.5 4.5l-2.2 2.2 1.5 1.5 2.2-2.2c2-.5 3.5-2.3 3.5-4.5 0-1-.3-2-.9-2.8z" fill="#fff" stroke="#222" stroke-width="1.5" transform="scale(0.6) translate(10, 10)"/>
            </svg>
        `;
        container.appendChild(toggleBtn);

        const panel = document.createElement('div');
        panel.id = '__hint_controls_panel';
        panel.style.cssText = `
            display:none; position:fixed; z-index:100000; flex-direction:column;
            background: linear-gradient(135deg, rgba(30,30,35,0.7), rgba(15,15,20,0.8));
            backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
            color: #f0f0f0; padding: 16px; border-radius: 14px;
            font-size: 13px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.6);
            border: 1px solid rgba(255,255,255,0.08);
            border-top-color: rgba(255,255,255,0.2);
            overflow-y: auto;
            transition: opacity 0.15s ease;
        `;

        const inner = document.createElement('div');
        inner.className = '__hint_panel_inner';

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
                state.worker.postMessage('setoption name MultiPV value ' + val);
                if (engine.busy && state.fen) { engine.queue = state.fen; state.worker.postMessage('stop'); }
            }
        };

        const warning = document.createElement('div');
        warning.id = '__hint_elo_warning';
        warning.style.cssText = 'display:none;padding:10px;background:rgba(255,152,0,0.15);border-left:3px solid #ff9800;border-radius:6px;font-size:11px;color:#ffb74d;line-height:1.4;margin-top:-4px;';
        warning.textContent = '⚠️ При ограничении ELO подсказки отключены. Поставь MAX для анализа.';

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

        const resetBtn = document.createElement('button');
        resetBtn.className = '__hint_reset_btn';
        resetBtn.textContent = 'Сбросить настройки';
        resetBtn.onclick = () => {
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
        inner.appendChild(colorsDiv);
        inner.appendChild(resetBtn);
        
        panel.appendChild(inner);
        
        document.body.appendChild(container);
        document.body.appendChild(panel);

        ui.container = container;
        ui.toggleBtn = toggleBtn;
        ui.panel = panel;
        applyButtonPosition();
        updateMultiPvUiState();

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

    window.addEventListener('resize', () => {
        if (!state.panelPos) return;
        state.panelPos.x = Math.max(4, Math.min(getViewportWidth() - 44, state.panelPos.x));
        state.panelPos.y = Math.max(4, Math.min(getViewportHeight() - 44, state.panelPos.y));
        applyButtonPosition();
        if (ui.panel && ui.panel.style.display === 'flex') openPanel();
    });

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
