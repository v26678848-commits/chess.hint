// ==UserScript==
// @name         chess hint (Modern UI + Strict Design)
// @version      69.0
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
        DEFAULT_COLORS: { best: '#008000', mid: '#0066cc', worst: '#cc0000' }
    };

    const loadSetting = (k, d) => { try { const v = localStorage.getItem(k); return v !== null ? v : d; } catch(e) { return d; } };
    const saveSetting = (k, v) => { try { localStorage.setItem(k, v); } catch(e) {} };

    const state = {
        fen: null, worker: null, engineReady: false, engineStart: 0,
        lastDepth: 0, myColor: 'w', lastMutationTime: 0,
        currentMultiPv: parseInt(loadSetting('__hint_pv', 3), 10) || 3,
        colors: {
            best: loadSetting('__hint_color_best', CONFIG.DEFAULT_COLORS.best),
            mid: loadSetting('__hint_color_mid', CONFIG.DEFAULT_COLORS.mid),
            worst: loadSetting('__hint_color_worst', CONFIG.DEFAULT_COLORS.worst)
        }
    };

    const engine = { 
        busy: false, queue: null, activeFen: null, watchdog: null, 
        depthByFen: new Map(), 
        latestPvs: { 1: null, 2: null, 3: null } 
    };
    
    const perf = { pendingHint: null, hintRafPending: false, hintDelayTimer: null, lastRenderedKey: null };
    const _grid = Array.from({ length: 8 }, () => Array(8).fill(''));
    let watchedBoard = null, boardObserver = null;

    // ===== Инжект CSS для современных ползунков =====
    function injectCustomCSS() {
        if (document.getElementById('__hint_styles')) return;
        const style = document.createElement('style');
        style.id = '__hint_styles';
        style.textContent = `
            .__hint_slider {
                -webkit-appearance: none;
                width: 100%;
                height: 4px;
                background: #444;
                border-radius: 2px;
                outline: none;
                margin: 8px 0;
            }
            .__hint_slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: #ffffff;
                cursor: pointer;
                box-shadow: 0 1px 3px rgba(0,0,0,0.5);
                transition: transform 0.1s;
            }
            .__hint_slider::-webkit-slider-thumb:active {
                transform: scale(1.2);
            }
            .__hint_color_input {
                -webkit-appearance: none;
                border: none;
                width: 24px;
                height: 24px;
                border-radius: 4px;
                padding: 0;
                background: none;
                cursor: pointer;
            }
            .__hint_color_input::-webkit-color-swatch-wrapper {
                padding: 0;
            }
            .__hint_color_input::-webkit-color-swatch {
                border: 1px solid #555;
                border-radius: 4px;
            }
        `;
        document.head.appendChild(style);
    }

    // ===== Утилиты =====
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
            throw new Error("stockfish script invalid");
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
                worker.postMessage('setoption name MultiPV value ' + state.currentMultiPv);
                worker.postMessage('setoption name Hash value 32');
                worker.postMessage('setoption name UCI_LimitStrength value false');
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
                if (depth > curDepth) { 
                    engine.depthByFen.set(engine.activeFen, depth); 
                    engine.latestPvs = { 1: null, 2: null, 3: null }; 
                }

                const mpvM = line.match(/\bmultipv (\d+)\b/);
                const mpvIdx = mpvM ? parseInt(mpvM[1], 10) : 1;
                const pvm = line.match(/\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/);
                if (!pvm) return;

                engine.latestPvs[mpvIdx] = { 
                    mv: pvm[1], 
                    eval: parseEval(line, getTurnFromFen(state.fen)) 
                };

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
        // ФИКС: overflow visible, чтобы текст не обрезался у краев доски
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
            line.setAttribute('x1', a.x);
            line.setAttribute('y1', a.y);
            line.setAttribute('x2', lineEndX);
            line.setAttribute('y2', lineEndY);
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

    function createControlPanel() {
        if (document.getElementById('__hint_controls')) return;
        
        injectCustomCSS();

        const container = document.createElement('div');
        container.id = '__hint_controls';
        container.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font-family:system-ui,sans-serif;';

        // Строгая SVG-шестеренка
        const toggleBtn = document.createElement('button');
        toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
        toggleBtn.style.cssText = 'width:36px;height:36px;border-radius:8px;background:rgba(30,30,35,0.85);color:#eee;border:1px solid rgba(255,255,255,0.1);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);';

        const panel = document.createElement('div');
        panel.id = '__hint_controls_panel';
        panel.style.cssText = 'display:none;flex-direction:column;gap:12px;background:rgba(30,30,35,0.95);color:#eee;padding:16px;border-radius:12px;font-size:13px;width:220px;box-shadow:0 4px 20px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.05);';

        const labelPv = document.createElement('div');
        labelPv.style.cssText = 'display:flex;justify-content:space-between;';
        labelPv.innerHTML = `<span>Количество ходов</span><b>${state.currentMultiPv}</b>`;
        
        const sliderPv = document.createElement('input');
        sliderPv.type = 'range'; sliderPv.min = 1; sliderPv.max = 3; sliderPv.step = 1; sliderPv.value = state.currentMultiPv;
        sliderPv.className = '__hint_slider';
        sliderPv.oninput = (e) => {
            const val = parseInt(e.target.value, 10);
            state.currentMultiPv = val; saveSetting('__hint_pv', val);
            labelPv.innerHTML = `<span>Количество ходов</span><b>${val}</b>`;
            
            clearHint(); 
            if (state.worker && state.engineReady) {
                state.worker.postMessage('setoption name MultiPV value ' + val);
                if (engine.busy && state.fen) { engine.queue = state.fen; state.worker.postMessage('stop'); }
            }
        };

        const colorsDiv = document.createElement('div');
        colorsDiv.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:4px;';
        
        const mkColorInput = (label, initial, onChange) => {
            const wrap = document.createElement('div'); 
            wrap.style.cssText = 'display:flex;justify-content:space-between;align-items:center;'; 
            wrap.innerHTML = `<span>${label}</span>`;
            const inp = document.createElement('input'); inp.type = 'color'; inp.value = initial;
            inp.className = '__hint_color_input';
            inp.oninput = (e) => {
                onChange(e.target.value);
                clearHint(); 
                drawMultiHint();
            };
            wrap.appendChild(inp); return wrap;
        };

        colorsDiv.appendChild(mkColorInput('Ход 1 (Best)', state.colors.best, v => { state.colors.best = v; saveSetting('__hint_color_best', v); }));
        colorsDiv.appendChild(mkColorInput('Ход 2 (Mid)', state.colors.mid, v => { state.colors.mid = v; saveSetting('__hint_color_mid', v); }));
        colorsDiv.appendChild(mkColorInput('Ход 3 (Worst)', state.colors.worst, v => { state.colors.worst = v; saveSetting('__hint_color_worst', v); }));

        panel.appendChild(labelPv); 
        panel.appendChild(sliderPv);
        panel.appendChild(colorsDiv);
        
        container.appendChild(toggleBtn); 
        container.appendChild(panel);
        document.body.appendChild(container);

        toggleBtn.onclick = () => { 
            panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; 
        };
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
