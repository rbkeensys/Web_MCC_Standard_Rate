/**/
const UI_VERSION = "1.7.2";  // FIXED batch timestamps! Now spreads samples over proper time span (1s for 200 samples @ 200Hz)

/* ----------------------------- helpers ---------------------------------- */
const $ = sel => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const n = Object.assign(document.createElement(tag), props || {});
  if (props && props.className === undefined && props.class) n.className = props.class;
  if (!Array.isArray(children)) children = [children];
  for (const c of children) n.append(c instanceof Node ? c : document.createTextNode(c));
  return n;
};
function colorFor(i){ const p=['#7aa2f7','#9ece6a','#f7768e','#bb9af7','#e0af68','#73daca','#f4b8e4','#ffd479']; return p[i%p.length]; }
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function safeArc(ctx, cx, cy, r, a0, a1) {
  if (!Number.isFinite(r) || r <= 0) return false;
  ctx.arc(cx, cy, r, a0, a1);
  return true;
}

/* ==================== FILE LOAD/SAVE HELPERS ==================== */
// Create a Load button that loads JSON from file
function createLoadButton(onLoad) {
  return el('button', {
    className: 'btn',
    onclick: () => {
      const inp = el('input', {type: 'file', accept: '.json'});
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (!f) return;
        try {
          const text = await f.text();
          const loaded = JSON.parse(text);
          onLoad(loaded, f.name);
        } catch(e) {
          alert('Failed to load: ' + e.message);
        }
      };
      inp.click();
    }
  }, '📁 Load from File');
}

// Create a Save As button that saves JSON to file
function createSaveAsButton(getData, defaultFilename = 'data.json') {
  return el('button', {
    className: 'btn',
    onclick: () => {
      const data = JSON.stringify(getData(), null, 2);
      const blob = new Blob([data], {type: 'application/json'});
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      URL.revokeObjectURL(url);
    }
  }, '💾 Save As...');
}


/* ======================== EXPRESSION WIDGET HELPERS ======================== */
function formatValue(val) {
  if (val === null || val === undefined) return 'N/A';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return 'NaN';
    if (Math.abs(val) < 0.01 || Math.abs(val) > 10000) {
      return val.toExponential(3);
    }
    return val.toFixed(3);
  }
  return String(val);
}

function getValueColor(val) {
  if (val === null || val === undefined || !Number.isFinite(val)) return '#d84a4a';
  if (val === 0) return '#9094a1';
  if (val > 0) return '#2faa60';
  return '#ff9966';
}

/* ======================== LOG REPLAY ======================== */
let replayTimer = null;
let replayData = null;
let replayIndex = 0;
let replayPaused = false;
let replayRate = 60;
let replayMode = null; // null = live, 'paused' = showing full log, 'playing' = animating

function parseCSV(text){
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return {cols:[], rows:[]};
  const cols = lines[0].split(',').map(s=>s.trim());
  const rows = lines.slice(1).map(line => line.split(',').map(v=>Number(v)));
  return { cols, rows };
}

function makeTickFromRow(cols, row){
  const obj = { type:'tick' };
  const ai=[], ao=[], dob=[], tc=[];
  for(let c=0;c<cols.length;c++){
    const name = cols[c].toLowerCase();
    const v = row[c];
    if (name === 't' || name === 'time' || name === 'timestamp') obj.t = v;
    else if (name.startsWith('ai')) ai[Number(name.slice(2))] = v;
    else if (name.startsWith('ao')) ao[Number(name.slice(2))] = v;
    else if (name.startsWith('do')) dob[Number(name.slice(2))] = v;
    else if (name.startsWith('tc')) tc[Number(name.slice(2))] = v;
  }
  if (ai.length) obj.ai = ai;
  if (ao.length) obj.ao = ao;
  if (dob.length) obj.do = dob;
  if (tc.length) obj.tc = tc;
  return obj;
}

function startReplay(cols, rows){
  // PAUSE live data
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
    connected = false;
    updateConnectBtn();
  }

  replayData = { cols, rows };
  replayIndex = 0;
  replayMode = 'paused';
  replayPaused = false;

  // Clear existing chart buffers
  chartBuffers.clear();
  chartFilters.clear();

  // Load ALL data into charts
  loadAllReplayDataIntoCharts();

  // Set cursor to first frame for gauges/bars
  replayIndex = 0;
  updateGaugesAndBarsFromReplayIndex();

  updateReplayUI();
}

function loadAllReplayDataIntoCharts(){
  if (!replayData) return;

  // Feed all data to charts at once
  for (let i = 0; i < replayData.rows.length; i++) {
    const row = replayData.rows[i];
    const msg = makeTickFromRow(replayData.cols, row);

    // Only feed to chart buffers, not to state (that would update gauges/bars)
    for (const p of state.pages){
      for (const w of p.widgets){
        if (w.type !== 'chart') continue;
        const buf = chartBuffers.get(w.id) || [];
        const t = msg.t || (i * 0.01); // Use message time or fallback
        const raw = (w.opts.series||[]).map(sel => {
          if (sel.kind === 'ai') return msg.ai?.[sel.index] ?? 0;
          if (sel.kind === 'ao') return msg.ao?.[sel.index] ?? 0;
          if (sel.kind === 'do') return msg.do?.[sel.index] ?? 0;
          if (sel.kind === 'tc') return msg.tc?.[sel.index] ?? 0;
          return 0;
        });
        buf.push({t, v: raw});
        chartBuffers.set(w.id, buf);
      }
    }
  }
}

function updateGaugesAndBarsFromReplayIndex(){
  if (!replayData || replayIndex >= replayData.rows.length) return;

  const row = replayData.rows[replayIndex];
  const msg = makeTickFromRow(replayData.cols, row);

  // Update state for gauges and bars only
  if (msg.ai) state.ai = msg.ai;
  if (msg.ao) state.ao = msg.ao;
  if (msg.do) state.do = msg.do;
  if (msg.tc) state.tc = msg.tc;
  if (msg.pid) state.pid = msg.pid;
  if (msg.motors) state.motors = msg.motors;

  updateDOButtons();
}

function playReplay(){
  if (!replayData) return;

  replayMode = 'playing';
  replayPaused = false;
  replayIndex = 0;

  // Clear charts for animated playback
  chartBuffers.clear();
  chartFilters.clear();

  updateReplayUI();

  const stepMs = Math.max(10, 1000 / replayRate);
  replayTimer = setInterval(() => {
    if (replayIndex >= replayData.rows.length) {
      pauseReplay();
      return;
    }

    const row = replayData.rows[replayIndex];
    const msg = makeTickFromRow(replayData.cols, row);

    // Feed one frame at a time
    window.dispatchEvent(new CustomEvent('tick', { detail: msg }));

    replayIndex++;
    updateReplayUI();
  }, stepMs);
}

function pauseReplay(){
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
  replayMode = 'paused';
  replayPaused = true;
  updateReplayUI();
}

function showFullLog(){
  if (!replayData) return;

  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }

  replayMode = 'paused';
  replayPaused = false;

  // Reload all data into charts
  chartBuffers.clear();
  chartFilters.clear();
  loadAllReplayDataIntoCharts();

  // Keep current cursor position for gauges/bars
  updateGaugesAndBarsFromReplayIndex();
  updateReplayUI();
}

function closeReplay(){
  if (replayTimer) {
    clearInterval(replayTimer);
    replayTimer = null;
  }

  replayData = null;
  replayIndex = 0;
  replayMode = null;
  replayPaused = false;

  // Clear chart buffers
  chartBuffers.clear();
  chartFilters.clear();

  // Reconnect to live data
  connect();

  updateReplayUI();
}

function seekReplay(index){
  if (!replayData) return;
  replayIndex = Math.max(0, Math.min(index, replayData.rows.length - 1));
  updateGaugesAndBarsFromReplayIndex();
  updateReplayUI();
}

function setReplayRate(newRate){
  replayRate = Math.max(1, Math.min(1000, newRate));

  // If currently playing, restart with new rate
  if (replayMode === 'playing' && replayTimer) {
    clearInterval(replayTimer);
    const stepMs = Math.max(10, 1000 / replayRate);
    replayTimer = setInterval(() => {
      if (replayIndex >= replayData.rows.length) {
        pauseReplay();
        return;
      }

      const row = replayData.rows[replayIndex];
      const msg = makeTickFromRow(replayData.cols, row);
      window.dispatchEvent(new CustomEvent('tick', { detail: msg }));

      replayIndex++;
      updateReplayUI();
    }, stepMs);
  }
}

function updateReplayUI(){
  const controls = document.getElementById('replayControls');
  if (!controls) return;

  if (replayData && replayMode !== null){
    controls.style.display = 'flex';

    const progress = document.getElementById('replayProgress');
    const position = document.getElementById('replayPosition');
    const playBtn = document.getElementById('replayPlayBtn');
    const pauseBtn = document.getElementById('replayPauseBtn');
    const showFullBtn = document.getElementById('replayShowFullBtn');
    const closeBtn = document.getElementById('replayCloseBtn');
    const rateInput = document.getElementById('replayRateInput');

    if (progress){
      progress.max = Math.max(1, replayData.rows.length - 1);
      progress.value = replayIndex;
    }
    if (position){
      position.textContent = `${replayIndex + 1} / ${replayData.rows.length}`;
    }
    if (playBtn){
      playBtn.disabled = (replayMode === 'playing');
    }
    if (pauseBtn){
      pauseBtn.disabled = (replayMode !== 'playing');
    }
    if (showFullBtn){
      showFullBtn.disabled = false;
    }
    if (closeBtn){
      closeBtn.disabled = false;
    }
    if (rateInput){
      rateInput.value = replayRate;
    }
  } else {
    controls.style.display = 'none';
  }
}

function hookLogButtons(){
  const openBtn = document.getElementById('openLogBtn');
  if (openBtn && !openBtn._wired){
    openBtn.addEventListener('click', ()=>{
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.csv,.txt';
      inp.onchange = ()=>{
        const f = inp.files?.[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = ()=>{
          try{
            const {cols, rows} = parseCSV(rd.result);
            if (!cols.length || !rows.length) throw new Error('No data');
            startReplay(cols, rows);
          }catch(e){
            alert('Load failed: '+e.message);
          }
        };
        rd.readAsText(f);
      };
      inp.click();
    });
    openBtn._wired = true;
  }

  const playBtn = document.getElementById('replayPlayBtn');
  if (playBtn && !playBtn._wired){
    playBtn.addEventListener('click', playReplay);
    playBtn._wired = true;
  }

  const pauseBtn = document.getElementById('replayPauseBtn');
  if (pauseBtn && !pauseBtn._wired){
    pauseBtn.addEventListener('click', pauseReplay);
    pauseBtn._wired = true;
  }

  const showFullBtn = document.getElementById('replayShowFullBtn');
  if (showFullBtn && !showFullBtn._wired){
    showFullBtn.addEventListener('click', showFullLog);
    showFullBtn._wired = true;
  }

  const closeBtn = document.getElementById('replayCloseBtn');
  if (closeBtn && !closeBtn._wired){
    closeBtn.addEventListener('click', closeReplay);
    closeBtn._wired = true;
  }

  const closeLogBtn = document.getElementById('closeLogBtn');
  if (closeLogBtn && !closeLogBtn._wired){
    closeLogBtn.addEventListener('click', async ()=>{
      if (!confirm('Close current log and start a new one?')) return;
      try {
        const response = await fetch('/api/logs/close', { method: 'POST' });
        const result = await response.json();
        if (result.ok) {
          alert(result.message || 'Log closed and new session started');
        } else {
          alert(result.message || 'Failed to close log');
        }
      } catch(e) {
        alert('Failed to close log: ' + e.message);
      }
    });
    closeLogBtn._wired = true;
  }

  const progress = document.getElementById('replayProgress');
  if (progress && !progress._wired){
    progress.addEventListener('input', (e)=>{
      seekReplay(parseInt(e.target.value));
    });
    progress._wired = true;
  }

  const rateInput = document.getElementById('replayRateInput');
  if (rateInput && !rateInput._wired){
    rateInput.addEventListener('change', (e)=>{
      const newRate = parseFloat(e.target.value) || 60;
      setReplayRate(newRate);
    });
    rateInput._wired = true;
  }
}

/* ==================== SCRIPT PLAYER ==================== */
let scriptTimer = null;
let scriptData = null;
let scriptIndex = 0;
let scriptPaused = false;
let scriptStartTime = 0;
let scriptLog = []; // Keep a log of executed events

async function loadScript(){
  try {
    const response = await fetch('/api/script');
    const data = await response.json();
    scriptData = data.events || [];
    scriptData.sort((a, b) => (a.time || 0) - (b.time || 0));
    console.log('[Script] Loaded', scriptData.length, 'events:', scriptData);
    updateScriptUI();
    return scriptData.length > 0;
  } catch(e) {
    console.error('[Script] Failed to load:', e);
    scriptData = [];
    updateScriptUI();
    return false;
  }
}

function playScript(){
  if (!scriptData || scriptData.length === 0) {
    alert('No script events to play. Edit script to add events.');
    return;
  }

  // If paused, resume from current position
  if (scriptPaused && scriptTimer) {
    scriptPaused = false;
    const currentTime = performance.now() / 1000;
    const eventTime = scriptData[scriptIndex]?.time || 0;
    scriptStartTime = currentTime - eventTime;
    console.log('[Script] Resuming from event', scriptIndex);
    updateScriptUI();
    runScript();
    return;
  }

  // Start from beginning
  stopScript();
  scriptIndex = 0;
  scriptPaused = false;
  scriptStartTime = performance.now() / 1000;
  scriptLog = [];

  console.log('[Script] Starting playback of', scriptData.length, 'events');
  updateScriptUI();
  runScript();
}

function runScript(){
  if (!scriptData || scriptPaused) return;

  const currentTime = (performance.now() / 1000) - scriptStartTime;

  // Execute all events that should have happened by now
  while (scriptIndex < scriptData.length) {
    const evt = scriptData[scriptIndex];
    const eventTime = evt.time || 0;

    if (eventTime > currentTime) break;

    console.log(`[Script] t=${currentTime.toFixed(2)}s: Executing event ${scriptIndex + 1}:`, evt);
    executeScriptEvent(evt);
    scriptLog.push({time: currentTime, event: evt, index: scriptIndex});
    scriptIndex++;
  }

  updateScriptUI();

  // Check if done
  if (scriptIndex >= scriptData.length) {
    console.log('[Script] Playback complete. Executed', scriptLog.length, 'events');
    stopScript();
    return;
  }

  // Schedule next check
  scriptTimer = setTimeout(runScript, 50); // Check every 50ms
}

async function executeScriptEvent(evt){
  try {
    if (evt.type === 'DO' || !evt.type) { // Default to DO if no type
      const channel = evt.channel || 0;
      const state = !!evt.state;
      const activeHigh = evt.normallyOpen !== false;
      const duration = evt.duration || 0;

      console.log(`[Script] DO${channel}: ${state ? 'ON' : 'OFF'} (${activeHigh ? 'NO' : 'NC'})${duration > 0 ? `, duration ${duration}s` : ''}`);

      const response = await fetch('/api/do/set', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          index: channel,
          state: state,
          active_high: activeHigh
        })
      });

      if (!response.ok) {
        console.error('[Script] DO set failed:', await response.text());
        return;
      }

      console.log(`[Script] ✓ DO${channel} set to ${state}`);

      // If duration > 0, schedule the off event
      if (duration > 0) {
        console.log(`[Script] Scheduling DO${channel} OFF in ${duration}s`);
        setTimeout(async () => {
          console.log(`[Script] Duration expired: DO${channel} -> OFF`);
          const offResponse = await fetch('/api/do/set', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              index: channel,
              state: !state,
              active_high: activeHigh
            })
          });
          if (offResponse.ok) {
            console.log(`[Script] ✓ DO${channel} auto-off complete`);
          } else {
            console.error('[Script] DO auto-off failed:', await offResponse.text());
          }
        }, duration * 1000);
      }

    } else if (evt.type === 'AO') {
      const channel = evt.channel || 0;
      const volts = evt.value || 0;

      console.log(`[Script] AO${channel}: ${volts}V`);

      const response = await fetch('/api/ao/set', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          index: channel,
          volts: volts
        })
      });

      if (!response.ok) {
        console.error('[Script] AO set failed:', await response.text());
        return;
      }

      console.log(`[Script] ✓ AO${channel} set to ${volts}V`);
      
    } else if (evt.type === 'buttonVar') {
      const varName = evt.varName || 'button1';
      const value = evt.value || 0;
      
      console.log(`[Script] buttonVar.${varName}: ${value}`);
      
      // Update local state
      if (!state.buttonVars) state.buttonVars = {};
      state.buttonVars[varName] = value;
      
      // Sync to backend for expressions
      const response = await fetch('/api/button_vars', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({vars: state.buttonVars})
      });
      
      if (!response.ok) {
        console.error('[Script] buttonVar set failed:', await response.text());
        return;
      }
      
      console.log(`[Script] ✓ buttonVar.${varName} set to ${value}`);
      
    } else if (evt.type === 'var') {
      const varName = evt.varName || 'var1';
      const value = evt.value || 0;
      
      console.log(`[Script] var.${varName}: ${value} (not implemented - expressions only)`);
      // Note: Generic 'var' type for future use, not currently used by expressions
    }
  } catch(e) {
    console.error('[Script] Event execution failed:', e, 'Event:', evt);
  }
}

function pauseScript(){
  if (!scriptTimer || scriptPaused) return;
  scriptPaused = true;
  console.log('[Script] Paused at event', scriptIndex);
  updateScriptUI();
}

function stopScript(){
  if (scriptTimer) {
    clearTimeout(scriptTimer);
    scriptTimer = null;
  }
  scriptIndex = 0;
  scriptPaused = false;
  scriptStartTime = 0;
  if (scriptLog.length > 0) {
    console.log('[Script] Stopped. Log:', scriptLog);
  }
  updateScriptUI();
}

function rewindScript(){
  console.log('[Script] Rewinding to start');
  stopScript();
  scriptIndex = 0;
  scriptLog = [];
  updateScriptUI();
}

function updateScriptUI(){
  const playBtn = document.getElementById('scriptPlayBtn');
  const pauseBtn = document.getElementById('scriptPauseBtn');
  const stopBtn = document.getElementById('scriptStopBtn');
  const rewindBtn = document.getElementById('scriptRewindBtn');
  const status = document.getElementById('scriptStatus');

  const isPlaying = (scriptTimer !== null && !scriptPaused);
  const isStopped = (scriptTimer === null && scriptIndex === 0);

  if (playBtn) {
    playBtn.disabled = isPlaying;
    playBtn.textContent = (scriptPaused && scriptTimer) ? '▶ Resume' : '▶ Play';
  }
  if (pauseBtn) {
    pauseBtn.disabled = !isPlaying;
  }
  if (stopBtn) {
    stopBtn.disabled = isStopped;
  }
  if (rewindBtn) {
    rewindBtn.disabled = isStopped;
  }

  if (status && scriptData) {
    if (isPlaying) {
      status.textContent = `Playing: ${scriptIndex} / ${scriptData.length}`;
      status.className = 'badge playing';
    } else if (scriptPaused && scriptTimer) {
      status.textContent = `Paused: ${scriptIndex} / ${scriptData.length}`;
      status.className = 'badge paused';
    } else if (scriptIndex > 0) {
      status.textContent = `Stopped: ${scriptIndex} / ${scriptData.length}`;
      status.className = 'badge stopped';
    } else if (scriptData.length > 0) {
      status.textContent = `Ready: ${scriptData.length} events`;
      status.className = 'badge ready';
    } else {
      status.textContent = 'No script loaded';
      status.className = 'badge';
    }
  }
}

function hookScriptButtons(){
  const playBtn = document.getElementById('scriptPlayBtn');
  if (playBtn && !playBtn._wired) {
    playBtn.addEventListener('click', async () => {
      await loadScript();
      playScript();
    });
    playBtn._wired = true;
  }

  const pauseBtn = document.getElementById('scriptPauseBtn');
  if (pauseBtn && !pauseBtn._wired) {
    pauseBtn.addEventListener('click', pauseScript);
    pauseBtn._wired = true;
  }

  const stopBtn = document.getElementById('scriptStopBtn');
  if (stopBtn && !stopBtn._wired) {
    stopBtn.addEventListener('click', stopScript);
    stopBtn._wired = true;
  }

  const rewindBtn = document.getElementById('scriptRewindBtn');
  if (rewindBtn && !rewindBtn._wired) {
    rewindBtn.addEventListener('click', rewindScript);
    rewindBtn._wired = true;
  }

  // Load script data initially
  loadScript();
}

// TEST FUNCTION - Call this from browser console to test a single event
window.testScriptEvent = async function(channel, state) {
  console.log('[Test] Sending DO command: channel', channel, 'state', state);
  try {
    const response = await fetch('/api/do/set', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        index: channel,
        state: state,
        active_high: true
      })
    });
    console.log('[Test] Response:', response.ok ? 'OK' : 'FAILED', await response.text());
  } catch(e) {
    console.error('[Test] Error:', e);
  }
};

/* ------------------------------ state ----------------------------------- */
let hwReady = false;
let configCache = null;

// Helper functions to flatten board-centric config for UI compatibility
function getAllAnalogs(cfg) {
  try {
    if (!cfg) return [];
    // Old format fallback
    if (cfg.analogs) return cfg.analogs;
    // New format: flatten from all boards
    const all = [];
    if (cfg.boards1608 && Array.isArray(cfg.boards1608)) {
      cfg.boards1608.forEach(board => {
        if (board && board.enabled && board.analogs && Array.isArray(board.analogs)) {
          all.push(...board.analogs);
        }
      });
    }
    return all;
  } catch (e) {
    console.error('[getAllAnalogs] Error:', e);
    return [];
  }
}

function getAllDigitalOutputs(cfg) {
  try {
    if (!cfg) return [];
    if (cfg.digitalOutputs) return cfg.digitalOutputs;
    const all = [];
    if (cfg.boards1608 && Array.isArray(cfg.boards1608)) {
      cfg.boards1608.forEach(board => {
        if (board && board.enabled && board.digitalOutputs && Array.isArray(board.digitalOutputs)) {
          all.push(...board.digitalOutputs);
        }
      });
    }
    return all;
  } catch (e) {
    console.error('[getAllDigitalOutputs] Error:', e);
    return [];
  }
}

function getAllAnalogOutputs(cfg) {
  try {
    if (!cfg) return [];
    if (cfg.analogOutputs) return cfg.analogOutputs;
    const all = [];
    if (cfg.boards1608 && Array.isArray(cfg.boards1608)) {
      cfg.boards1608.forEach(board => {
        if (board && board.enabled && board.analogOutputs && Array.isArray(board.analogOutputs)) {
          all.push(...board.analogOutputs);
        }
      });
    }
    return all;
  } catch (e) {
    console.error('[getAllAnalogOutputs] Error:', e);
    return [];
  }
}

function getAllThermocouples(cfg) {
  try {
    if (!cfg) return [];
    if (cfg.thermocouples) return cfg.thermocouples;
    const all = [];
    if (cfg.boardsetc && Array.isArray(cfg.boardsetc)) {
      cfg.boardsetc.forEach(board => {
        if (board && board.enabled && board.thermocouples && Array.isArray(board.thermocouples)) {
          all.push(...board.thermocouples);
        }
      });
    }
    return all;
  } catch (e) {
    console.error('[getAllThermocouples] Error:', e);
    return [];
  }
}


let ws = null, sessionDir = '', connected = false;

const state = {
  pages: [],
  ai: Array(8).fill(0),
  ao: Array(2).fill(0),
  do: Array(8).fill(0),
  tc: [],
  pid: [],
  motors: [],
  le: []  // Logic Elements
};

function feedTick(msg){
  // Debug logging (only for first few ticks or when state.expr appears)
  if (msg.expr && (!state.expr || (window._exprDebugCount || 0) < 5)) {
    console.log('[FeedTick] Received expr data:', msg.expr);
    window._exprDebugCount = (window._exprDebugCount || 0) + 1;
  }
  
  if (msg.ai)  state.ai  = msg.ai;
  if (msg.ao)  state.ao  = msg.ao;
  if (msg.do)  state.do  = msg.do;
  if (msg.tc)  state.tc  = msg.tc;
  if (msg.pid) state.pid = msg.pid;
  if (msg.motors) state.motors = msg.motors;
  if (msg.le) state.le = msg.le;  // Logic Elements
  if (msg.math) state.math = msg.math;  // Math Operators
  if (msg.expr) state.expr = msg.expr;  // Expressions
  onTick();
}

window.GLOBAL_BUFFER_SPAN = window.GLOBAL_BUFFER_SPAN || 10;

window.addEventListener('tick', (ev)=>{
  if (ev && ev.detail) feedTick(ev.detail);
});

/* ------------------------ boot / wiring --------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  wireUI();
  ensureStarterPage();
  showVersions();
  loadConfigCache();
  connect();
  hookLogButtons();
  hookScriptButtons();
});

function wireUI(){
  $('#connectBtn')?.addEventListener('click', connect);
  $('#setRate')?.addEventListener('click', setRate);
  $('#setDisplayRate')?.addEventListener('click', async ()=>{
    const hz = parseFloat($('#displayRate').value) || 25;
    try {
      await fetch('/api/display/rate', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({hz})
      });
      console.log(`Display rate set to ${hz} Hz`);
    } catch(e) {
      console.error('Failed to set display rate:', e);
    }
  });
  $('#fullscreenBtn')?.addEventListener('click', toggleFullscreen);
  $('#exitFullscreenBtn')?.addEventListener('click', toggleFullscreen);
  $('#editConfig')?.addEventListener('click', ()=>openConfigForm());
  $('#editPID')?.addEventListener('click', ()=>openPidForm());
  $('#editMotor')?.addEventListener('click', ()=>openMotorEditor());
  $('#editLE')?.addEventListener('click', ()=>openLEEditor());  // Logic Elements
  $('#editMath')?.addEventListener('click', ()=>openMathEditor());  // Math Operators
  $('#editExpr')?.addEventListener('click', ()=>openExpressionEditor());  // Expression Editor
  $('#exprHelp')?.addEventListener('click', ()=>openExpressionHelp());  // Expression Help
  $('#editScript')?.addEventListener('click', ()=>openScriptEditor());
  $('#zeroAI')?.addEventListener('click', ()=>openZeroAIDialog());  // Zero AI channels
  $('#saveLayout')?.addEventListener('click', saveLayoutToFile);
  $('#loadLayout')?.addEventListener('click', loadLayoutFromFile);
  $('#addPage')?.addEventListener('click', addPage);
  $('#delPage')?.addEventListener('click', removeActivePage);
  applyInitialsFromConfig();
  document.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', ()=>addWidget(btn.dataset.add)));
  
  // F11 key for fullscreen toggle
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      toggleFullscreen();
    }
  });
  
  // ESC key to exit fullscreen
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('fullscreen')) {
      toggleFullscreen();
    }
  });
}

async function toggleFullscreen() {
  const isFullscreen = document.body.classList.contains('fullscreen');
  
  if (!isFullscreen) {
    // Enter fullscreen
    document.body.classList.add('fullscreen');
    
    // Try to use browser's native fullscreen API (hides browser chrome)
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else if (document.documentElement.webkitRequestFullscreen) {
        await document.documentElement.webkitRequestFullscreen();
      } else if (document.documentElement.msRequestFullscreen) {
        await document.documentElement.msRequestFullscreen();
      }
    } catch(e) {
      console.log('Native fullscreen not available, using CSS fullscreen');
    }
  } else {
    // Exit fullscreen
    document.body.classList.remove('fullscreen');
    
    // Exit browser's native fullscreen
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
      } else if (document.msExitFullscreen) {
        await document.msExitFullscreen();
      }
    } catch(e) {
      console.log('Native fullscreen exit not available');
    }
  }
  
  const btn = $('#fullscreenBtn');
  if (btn) {
    const nowFullscreen = document.body.classList.contains('fullscreen');
    btn.textContent = nowFullscreen ? '⛶' : '⛶';
    btn.title = nowFullscreen ? 'Exit Fullscreen (F11)' : 'Enter Fullscreen (F11)';
  }
}

async function showVersions(){
  const versions=[`UI ${UI_VERSION}`];
  try{
    const r=await fetch('/api/diag');
    if(r.ok){
      const d=await r.json();
      if(d.server) versions.push(`Server ${d.server}`);
      if(d.bridge) versions.push(`Bridge ${d.bridge}`);
      if(typeof d.have_mcculw!=='undefined') hwReady=!!d.have_mcculw;
    }
  }catch{}
  $('#versions').textContent=versions.join(' • ');
}

function updateConnectBtn(){
  const b = $('#connectBtn');
  if (!b) return;
  if (connected){
    b.textContent = 'Connected';
    b.classList.add('connected');
  } else {
    b.textContent = 'Connect';
    b.classList.remove('connected');
  }
}

async function loadConfigCache(){
  try { const r=await fetch('/api/config'); if (r.ok) configCache = await r.json(); } catch {}
  try { const r=await fetch('/api/pid'); if (r.ok) window.pidCache = await r.json(); } catch {}
}

async function setRate(){
  const hz=parseFloat($('#rate').value)||0;
  if(hz>=1){
    try{
      await fetch('/api/acq/rate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hz})});
    }catch(e){ alert('Set rate failed: '+e.message); }
  }
}

function connect(){
  if(ws) try{ ws.close(); }catch{}
  ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
  ws.onopen = ()=>{ connected=true; updateConnectBtn(); updateDOButtons(); };
  ws.onclose= ()=>{ connected=false; updateConnectBtn(); updateDOButtons(); };
  ws.onmessage=(ev)=>{
    const msg=JSON.parse(ev.data);
    if(msg.type==='session'){ sessionDir=msg.dir; $('#session').textContent=sessionDir; }
    if (msg.type === 'tick') feedTick(msg);
    if (msg.type === 'batch' && msg.samples && msg.samples.length > 0) {
      // Efficiently process batch: add all samples to chart buffers, then render once
      const samples = msg.samples;
      console.log(`[BATCH] Received ${samples.length} samples, adding to charts...`);
      
      // Update state with the LAST sample (for widgets/buttons/current values)
      const lastSample = samples[samples.length - 1];
      if (lastSample.ai) state.ai = lastSample.ai;
      if (lastSample.ao) state.ao = lastSample.ao;
      if (lastSample.do) state.do = lastSample.do;
      if (lastSample.tc) state.tc = lastSample.tc;
      if (lastSample.pid) state.pid = lastSample.pid;
      if (lastSample.motors) state.motors = lastSample.motors;
      if (lastSample.le) state.le = lastSample.le;
      if (lastSample.math) state.math = lastSample.math;
      if (lastSample.expr) state.expr = lastSample.expr;
      
      // Add ALL samples to chart buffers efficiently
      const t0 = performance.now() / 1000;
      const acqRate = 200; // TODO: Get from server message or config
      const sampleInterval = 1.0 / acqRate; // Time between samples in seconds
      
      for (const p of state.pages) {
        for (const w of p.widgets) {
          if (w.type !== 'chart') continue;
          
          const buf = chartBuffers.get(w.id) || [];
          const series = w.opts.series || [];
          
          // Add all samples to buffer with proper time spacing
          samples.forEach((sample, idx) => {
            // Spread samples backward in time (oldest first)
            // If we have 200 samples at 200 Hz, they span 1 second
            const t = t0 - (samples.length - 1 - idx) * sampleInterval;
            const values = series.map(sel => {
              switch(sel.kind) {
                case 'ai': return sample.ai?.[sel.index] ?? 0;
                case 'ao': return sample.ao?.[sel.index] ?? 0;
                case 'do': return (sample.do?.[sel.index] ? 1 : 0);
                case 'tc': return sample.tc?.[sel.index] ?? 0;
                case 'pid': return sample.pid?.[sel.index]?.out ?? 0;
                case 'math': return sample.math?.[sel.index]?.output ?? 0;
                case 'expr': return sample.expr?.[sel.index]?.output ?? 0;
                case 'button': return state.buttonVars?.[sel.index] ?? 0;
                default: return 0;
              }
            });
            buf.push({t, v: values});
          });
          
          // Trim old data
          const chartSpan = Math.max(1, w.opts.span || 10);
          const bufferDepth = chartSpan * 1.2;
          while (buf.length && (t0 - buf[0].t) > bufferDepth) {
            buf.shift();
          }
          
          chartBuffers.set(w.id, buf);
        }
      }
      
      console.log(`[BATCH] Added ${samples.length} samples to ${state.pages.flatMap(p => p.widgets.filter(w => w.type === 'chart')).length} charts`);
      
      // Trigger single render update for widgets/buttons
      updateDOButtons();
    }
  };
  updateConnectBtn();
}

async function applyInitialsFromConfig(){
  try{
    const cfg = await (await fetch('/api/config')).json();
    const aos = cfg.ao || cfg.analogOutputs || [];
    for(let i=0;i<aos.length;i++){
      const item = aos[i] || {};
      const v = Number.isFinite(item.startup) ? item.startup
            :  Number.isFinite(item.min)     ? item.min
            :  0.0;
      await fetch('/api/ao/set', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ index:i, volts: Number(v)||0 })
      }).catch(()=>{});
    }
    const dos = cfg.do || cfg.digitalOutputs || [];
    for(let i=0;i<dos.length;i++){
      const d = dos[i] || {};
      const activeHigh =
        (typeof d.active_high === 'boolean') ? d.active_high :
        (d.mode === 'NC' || d.nc === true)   ? false : true;
      await fetch('/api/do/set', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ index:i, state:false, active_high: activeHigh })
      }).catch(()=>{});
    }
  }catch(e){ console.warn('applyInitialsFromConfig failed', e); }
}

/* ---------------------------- pages ------------------------------------- */
let activePageIndex = 0;

function ensureStarterPage(){
  if(!state.pages.length){
    state.pages=[{id:crypto.randomUUID(), name:'Page 1', widgets:[]}];
  }
  refreshPages();
  setActivePage(0);
}
function refreshPages(){
  const cont=$('#pages');
  cont.innerHTML='';
  state.pages.forEach((p,idx)=>{
    const b=el('button',{className:'btn',onclick:()=>setActivePage(idx)}, p.name || ('Page '+(idx+1)));
    if(idx===activePageIndex) b.classList.add('active');
    cont.append(b);
  });
}
function setActivePage(idx){
  activePageIndex=clamp(idx,0,state.pages.length-1);
  refreshPages();
  renderPage();
}
function addPage(){
  state.pages.push({id:crypto.randomUUID(), name:`Page ${state.pages.length+1}`, widgets:[]});
  setActivePage(state.pages.length-1);
}
function removeActivePage(){
  if(state.pages.length<=1){ alert('At least one page is required.'); return; }
  state.pages.splice(activePageIndex,1);
  setActivePage(Math.max(0,activePageIndex-1));
}

/* -------------------------- widgets ------------------------------------- */
function addWidget(type){
  // Special handling for PID Panel - ask which loop to show
  if (type === 'pidpanel') {
    addPIDPanel();
    return;
  }
  
  // Special handling for Motor - fetch motor config for name
  if (type === 'motor') {
    addMotorWidget();
    return;
  }
  
  // Special handling for LE - fetch LE config for name
  if (type === 'le') {
    addLEWidget();
    return;
  }
  
  // Special handling for Math Op - fetch math config for name
  if (type === 'mathop') {
    addMathOpWidget();
    return;
  }
  
  // Special handling for Expression - fetch expr config for name
  if (type === 'expr') {
    addExprWidget();
    return;
  }
  
  // Custom default sizes for different widget types
  let defaultW = 460, defaultH = 280;
  if (type === 'gauge') {
    defaultH = 340;
  } else if (type === 'bars') {
    defaultW = 200;  // Narrower bars
    defaultH = 280;
  } else if (type === 'dobutton') {
    defaultW = 120;
    defaultH = 45;  // Reduced from 90
  } else if (type === 'le') {
    defaultW = 280;  // Compact for LE
    defaultH = 20;   // Reduced from 40 (HALF AGAIN!)
  } else if (type === 'mathop') {
    defaultW = 280;
    defaultH = 20;   // Reduced from 40 (HALF AGAIN!)
  }
  
  const w={ id:crypto.randomUUID(), type, x:40, y:40, w:defaultW, h:defaultH, opts:defaultsFor(type) };
  state.pages[activePageIndex].widgets.push(w);
  renderPage();
}

async function addPIDPanel() {
  try {
    // Fetch current PID configuration to see how many loops exist
    const pid = await (await fetch('/api/pid')).json();
    const loops = pid.loops || [];
    
    if (loops.length === 0) {
      alert('No PID loops configured. Configure PID loops first.');
      return;
    }
    
    // Create modal with dropdown selector
    const root = el('div', {});
    root.append(el('h3', {}, 'Select PID Loop'));
    
    const selector = el('select', {style: 'width:100%; font-size:14px; padding:8px'});
    loops.forEach((loop, idx) => {
      const name = loop.name || `Loop ${idx}`;
      const enabled = loop.enabled ? '✓' : '✗';
      const label = `${name} (${enabled})`;
      selector.append(el('option', {value: idx}, label));
    });
    
    root.append(
      el('div', {style: 'margin:16px 0'}, [
        el('label', {}, ['PID Loop: ', selector])
      ])
    );
    
    const addBtn = el('button', {
      className: 'btn',
      onclick: () => {
        const loopIndex = parseInt(selector.value);
        const loopName = loops[loopIndex].name || `Loop ${loopIndex}`;
        
        const w = {
          id: crypto.randomUUID(),
          type: 'pidpanel',
          x: 40,
          y: 40,
          w: 320,
          h: 600,
          opts: {
            title: `PID: ${loopName}`,
            loopIndex: loopIndex,
            showControls: true
          }
        };
        
        state.pages[activePageIndex].widgets.push(w);
        renderPage();
        closeModal();
      }
    }, 'Add Widget');
    
    root.append(addBtn);
    showModal(root);
    
  } catch(e) {
    console.error('Failed to fetch PID config:', e);
    alert('Failed to load PID configuration.');
  }
}

async function addMotorWidget() {
  try {
    // Fetch motor configuration
    const motorData = await (await fetch('/api/motors')).json();
    const motors = motorData.motors || [];
    
    if (motors.length === 0) {
      alert('No motors configured. Please configure motors first.');
      return;
    }
    
    // Create modal with dropdown selector
    const root = el('div', {});
    root.append(el('h3', {}, 'Select Motor'));
    
    const selector = el('select', {style: 'width:100%; font-size:14px; padding:8px'});
    motors.forEach((m, i) => {
      const included = m.include ? '✓' : '✗';
      const label = `${m.name || `Motor ${i}`} (${included})`;
      selector.append(el('option', {value: i}, label));
    });
    
    root.append(
      el('div', {style: 'margin:16px 0'}, [
        el('label', {}, ['Motor: ', selector])
      ])
    );
    
    const addBtn = el('button', {
      className: 'btn',
      onclick: () => {
        const motorIndex = parseInt(selector.value);
        const motorName = motors[motorIndex].name || `Motor ${motorIndex}`;
        
        const w = {
          id: crypto.randomUUID(),
          type: 'motor',
          x: 40,
          y: 40,
          w: 320,
          h: 380,
          opts: {
            title: motorName,
            motorIndex: motorIndex,
            showControls: true
          }
        };
        
        state.pages[activePageIndex].widgets.push(w);
        renderPage();
        closeModal();
      }
    }, 'Add Widget');
    
    root.append(addBtn);
    showModal(root);
    
  } catch(e) {
    console.error('Failed to add motor widget:', e);
    alert('Failed to load motor configuration.');
  }
}

async function addLEWidget() {
  try {
    // Fetch LE configuration
    const leData = await (await fetch('/api/logic_elements')).json();
    const elements = leData.elements || [];
    
    if (elements.length === 0) {
      alert('No Logic Elements configured. Please configure LEs first.');
      return;
    }
    
    // Create modal with dropdown selector
    const root = el('div', {});
    root.append(el('h3', {}, 'Select Logic Element'));
    
    const selector = el('select', {style: 'width:100%; font-size:14px; padding:8px'});
    elements.forEach((le, i) => {
      const name = le.name || `LE${i}`;
      const op = (le.operation || 'and').toUpperCase();
      const label = `${name} (${op})`;
      selector.append(el('option', {value: i}, label));
    });
    
    root.append(
      el('div', {style: 'margin:16px 0'}, [
        el('label', {}, ['Logic Element: ', selector])
      ])
    );
    
    const addBtn = el('button', {
      className: 'btn',
      onclick: () => {
        const leIndex = parseInt(selector.value);
        const leName = elements[leIndex].name || `LE${leIndex}`;
        
        const w = {
          id: crypto.randomUUID(),
          type: 'le',
          x: 40,
          y: 40,
          w: 280,
          h: 160,
          opts: {
            title: leName,
            leIndex: leIndex,
            showInputs: true
          }
        };
        
        state.pages[activePageIndex].widgets.push(w);
        renderPage();
        closeModal();
      }
    }, 'Add Widget');
    
    root.append(addBtn);
    showModal(root);
    
  } catch(e) {
    console.error('Failed to add LE widget:', e);
    alert('Failed to load Logic Element configuration.');
  }
}

async function addMathOpWidget() {
  try {
    // Fetch math operator configuration
    const mathData = await (await fetch('/api/math_operators')).json();
    const operators = mathData.operators || [];
    
    if (operators.length === 0) {
      alert('No Math Operators configured. Please configure Math Operators first.');
      return;
    }
    
    // Create modal with dropdown selector
    const root = el('div', {});
    root.append(el('h3', {}, 'Select Math Operator'));
    
    const selector = el('select', {style: 'width:100%; font-size:14px; padding:8px'});
    operators.forEach((m, i) => {
      const name = m.name || `Math${i}`;
      const op = m.operation || 'add';
      const label = `${name} (${op})`;
      selector.append(el('option', {value: i}, label));
    });
    
    root.append(
      el('div', {style: 'margin:16px 0'}, [
        el('label', {}, ['Math Operator: ', selector])
      ])
    );
    
    const addBtn = el('button', {
      className: 'btn',
      onclick: () => {
        const mathIndex = parseInt(selector.value);
        const mathName = operators[mathIndex].name || `Math${mathIndex}`;
        
        const w = {
          id: crypto.randomUUID(),
          type: 'mathop',
          x: 40,
          y: 40,
          w: 280,
          h: 160,
          opts: {
            title: mathName,
            mathIndex: mathIndex,
            showInputs: true
          }
        };
        
        state.pages[activePageIndex].widgets.push(w);
        renderPage();
        closeModal();
      }
    }, 'Add Widget');
    
    root.append(addBtn);
    showModal(root);
    
  } catch(e) {
    console.error('Failed to add Math Op widget:', e);
    alert('Failed to load Math Operator configuration.');
  }
}

async function addExprWidget() {
  try {
    // Fetch expression configuration
    const exprData = await (await fetch('/api/expressions')).json();
    const expressions = exprData.expressions || [];
    
    if (expressions.length === 0) {
      alert('No Expressions configured. Please configure Expressions first.');
      return;
    }
    
    // Create modal with dropdown selector
    const root = el('div', {});
    root.append(el('h3', {}, 'Select Expression'));
    
    const selector = el('select', {style: 'width:100%; font-size:14px; padding:8px'});
    expressions.forEach((e, i) => {
      const name = e.name || `Expr${i}`;
      const enabled = e.enabled ? '✓' : '✗';
      const label = `${name} (${enabled})`;
      selector.append(el('option', {value: i}, label));
    });
    
    root.append(
      el('div', {style: 'margin:16px 0'}, [
        el('label', {}, ['Expression: ', selector])
      ])
    );
    
    const addBtn = el('button', {
      className: 'btn',
      onclick: () => {
        const exprIndex = parseInt(selector.value);
        const exprName = expressions[exprIndex].name || `Expr${exprIndex}`;
        
        const w = {
          id: crypto.randomUUID(),
          type: 'expr',
          x: 40,
          y: 40,
          w: 350,
          h: 200,
          opts: {
            title: exprName,
            exprIndex: exprIndex,
            showSource: true,
            showOutput: true
          }
        };
        
        state.pages[activePageIndex].widgets.push(w);
        renderPage();
        closeModal();
      }
    }, 'Add Widget');
    
    root.append(addBtn);
    showModal(root);
    
  } catch(e) {
    console.error('Failed to add Expression widget:', e);
    alert('Failed to load Expression configuration.');
  }
}

// Update defaultsFor to give charts reasonable initial spans:
function defaultsFor(type){
  switch(type){
    case 'chart':    return { title:'Chart', series:[], span:60, paused:false, scale:'auto', min:0, max:10, filterHz:0, cursorMode:'follow' };
    case 'gauge':    return { title:'Gauge', needles:[], scale:'manual', min:0, max:10 };
    case 'bars':     return { title:'Bars', series:[], scale:'manual', min:0, max:10 };
    case 'dobutton': return { title:'Button', outputType:'do', doIndex:0, varName:'button1', activeHigh:true, mode:'toggle', buzzHz:10, actuationTime:0, _timer:null };
    case 'pidpanel': return { title:'PID', loopIndex:0, showControls:true };
    case 'aoslider': return { title:'AO', aoIndex:0, min:0, max:10, step:0.0025, live:true };
    case 'motor':    return { title:'Motor', motorIndex:0, showControls:true };
    case 'mathop':   return { title:'Math', mathIndex:0, showInputs:true };
    case 'expr':     return { title:'Expression', exprIndex:0, showSource:true, showOutput:true };
  }
  return {};
}

function tableForm(pairs) {
  const tbl = el('table', {className: 'form'}), tbody = el('tbody');
  for (const [label, input] of pairs) {
    const tr = el('tr');
    tr.append(el('th', {}, label), el('td', {}, input));
    tbody.append(tr);
  }
  tbl.append(el('thead', {}, el('tr', {}, [el('th', {}, 'Field'), el('th', {}, 'Value')])), tbody);
  return tbl;
}

function tableFormRows(rows) {
  const tbl = el('table', {className: 'form'}), tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (let i = 0; i < row.length; i += 2) {
      tr.append(el('th', {}, row[i]), el('td', {}, row[i + 1]));
    }
    tbody.append(tr);
  }
  tbl.append(el('thead', {}, el('tr', {}, [
    el('th', {}, 'Field'), el('th', {}, 'Value'),
    el('th', {}, 'Field'), el('th', {}, 'Value'),
    el('th', {}, 'Field'), el('th', {}, 'Value'),
    el('th', {}, 'Field'), el('th', {}, 'Value')
  ])), tbody);
  return tbl;
}

function inputText(obj, key) {
  const i = el('input', {type: 'text', value: obj[key] ?? ''});
  i.oninput = () => obj[key] = i.value;
  return i;
}

function inputNum(obj, key, step) {
  const i = el('input', {type: 'number', step: step ?? 'any', value: obj[key] ?? 0});
  i.oninput = () => obj[key] = parseFloat(i.value) || 0;
  return i;
}

function inputChk(obj, key) {
  const i = el('input', {type: 'checkbox', checked: !!obj[key]});
  i.onchange = () => obj[key] = !!i.checked;
  return i;
}

function selectEnum(options, value, onChange) {
  const s = el('select', {});
  options.forEach(opt => s.append(el('option', {value: opt}, opt)));
  s.value = value;
  s.onchange = () => onChange(s.value);
  return s;
}

// Helper to create a name-based selector for signals
async function createSignalSelector(kind, currentIndex, onChange) {
  const select = el('select', {});
  
  try {
    let items = [];
    
    if (kind === 'ai' || kind === 'ao') {
      const cfg = await (await fetch('/api/config')).json();
      const list = kind === 'ai' ? getAllAnalogs(cfg) : getAllAnalogOutputs(cfg);
      items = list.map((item, i) => ({
        index: i,
        name: item.name || `${kind.toUpperCase()}${i}`
      }));
    } else if (kind === 'do') {
      const cfg = await (await fetch('/api/config')).json();
      const list = getAllDigitalOutputs(cfg);
      items = list.map((item, i) => ({
        index: i,
        name: item.name || `DO${i}`
      }));
    } else if (kind === 'tc') {
      const cfg = await (await fetch('/api/config')).json();
      const list = getAllThermocouples(cfg);
      items = list.map((item, i) => ({
        index: i,
        name: item.name || `TC${i}`
      }));
    } else if (kind === 'pid' || kind === 'pid_u') {
      const data = await (await fetch('/api/pid')).json();
      items = (data.loops || []).map((loop, i) => ({
        index: i,
        name: loop.name || `PID${i}`
      }));
    } else if (kind === 'math') {
      const data = await (await fetch('/api/math_operators')).json();
      items = (data.operators || []).map((op, i) => ({
        index: i,
        name: op.name || `Math${i}`
      }));
    } else if (kind === 'le') {
      const data = await (await fetch('/api/logic_elements')).json();
      items = (data.elements || []).map((le, i) => ({
        index: i,
        name: le.name || `LE${i}`
      }));
    } else if (kind === 'expr') {
      const data = await (await fetch('/api/expressions')).json();
      items = (data.expressions || []).map((e, i) => ({
        index: i,
        name: e.name || `Expr${i}`
      }));
    } else if (kind === 'static' || kind === 'global') {
      // Global/static variables from expressions
      const data = await (await fetch('/api/expressions/globals')).json();
      const globals = data.globals || {};
      const varNames = Object.keys(globals);
      
      varNames.forEach((name, i) => {
        const opt = el('option', {value: name}, `static.${name}`);
        select.append(opt);
      });
      
      // For static variables, currentIndex is actually the variable name (string)
      select.value = currentIndex || varNames[0] || '';
      select.onchange = () => onChange(select.value);  // Pass name, not index
      
      return select;
    } else if (kind === 'button') {
      console.log('========================================');
      console.log('BUTTON CASE HIT! Looking for button vars...');
      console.log('state.pages:', state.pages);
      // Button variables - scan all DO button widgets for varNames
      const varNames = new Set();
      
      // Scan all pages for DO buttons with outputType='var'
      let buttonCount = 0;
      state.pages?.forEach(page => {
        page.widgets?.forEach(w => {
          if (w.type === 'dobutton') {
            buttonCount++;
            if (w.opts?.outputType === 'var' && w.opts?.varName) {
                    varNames.add(w.opts.varName);
            }
          }
        });
      });
      
      // Also include any from current state
      if (state.buttonVars) {
        Object.keys(state.buttonVars).forEach(name => varNames.add(name));
      }
      
      const varArray = Array.from(varNames).sort();
      
      if (varArray.length === 0) {
        select.append(el('option', {value: ''}, '(No button vars defined)'));
        select.disabled = true;
      } else {
        varArray.forEach(name => {
          const opt = el('option', {value: name}, `btn:${name}`);
          select.append(opt);
        });
      }
      
      // For button variables, currentIndex is the variable name (string)
      select.value = currentIndex || varArray[0] || '';
      select.onchange = () => onChange(select.value);  // Pass name, not index
      
      return select;
    }
    
    items.forEach(item => {
      const opt = el('option', {value: item.index}, item.name);
      select.append(opt);
    });
    
    select.value = currentIndex || 0;
    select.onchange = () => onChange(parseInt(select.value));
    
  } catch (e) {
    console.error('Failed to load signal names:', e);
    // Fallback to index
    select.append(el('option', {value: currentIndex || 0}, `Index ${currentIndex || 0}`));
    select.value = currentIndex || 0;
  }
  
  return select;
}

function saveLayoutToFile() {
  const blob = new Blob([JSON.stringify({pages: state.pages}, null, 2)], {type: 'application/json'});
  const a = el('a', {href: URL.createObjectURL(blob), download: 'layout.json'});
  a.click();
}

function loadLayoutFromFile() {
  const inp = el('input', {type: 'file', accept: '.json'});
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const obj = JSON.parse(rd.result);
        if (!obj.pages || !Array.isArray(obj.pages)) throw new Error('Invalid layout file');
        state.pages = normalizeLayoutPages(obj.pages);   // <-- ensure defaults exist
        refreshPages();
        setActivePage(0);
      } catch (e) {
        alert('Load failed: ' + e.message);
      }
    };
    rd.readAsText(f);
  };
  inp.click();
}

/* ----------------------- widget settings modal -------------------------- */
function openWidgetSettings(w) {
  const root = el('div', {});
  const titleHeader = el('h3', {}, (w.opts.title || w.type) + ' — Settings');
  const titleInput = inputText(w.opts, 'title');
  titleInput.oninput = () => {
    w.opts.title = titleInput.value;
    const t = document.querySelector('#w_' + w.id + ' header .title');
    if (t) t.textContent = w.opts.title || w.type;
    const b = document.querySelector('#w_' + w.id + ' .do-btn');
    if (b) b.textContent = w.opts.title || 'DO';
  };
  const nameRow = tableForm([['Title', titleInput]]);
  root.append(el('div', {}, [titleHeader]), nameRow, el('hr', {className: 'soft'}));

  if (w.type === 'chart' || w.type === 'bars' || w.type === 'gauge') {
    const list = el('div', {});
    const items = (w.type === 'gauge') ? (w.opts.needles = w.opts.needles || []) : (w.opts.series = w.opts.series || []);

    function redrawList() {
      list.innerHTML = '';
      items.forEach((s, idx) => {
        // Ensure display scale/offset exist
        s.displayScale = s.displayScale !== undefined ? s.displayScale : 1.0;
        s.displayOffset = s.displayOffset !== undefined ? s.displayOffset : 0.0;

        const kindSel = selectEnum(['ai', 'ao', 'do', 'tc', 'pid', 'math', 'expr', 'button'], s.kind || 'ai', async v => {
          s.kind = v;
          s.name = s.name || labelFor(s);
          // Rebuild selector when kind changes
          // For button/static vars, use empty string if no index, otherwise use 0
          const defaultIndex = (v === 'button' || v === 'static') ? (s.index || '') : (s.index || 0);
          const newSel = await createSignalSelector(v, defaultIndex, newIdx => s.index = newIdx);
          signalSel.replaceWith(newSel);
          signalSel = newSel;
        });
        
        let signalSel = el('select', {style: 'width:100px'});
        signalSel.append(el('option', {value: s.index || 0}, 'Loading...'));
        
        // Async load signal selector
        (async () => {
          const kind = s.kind || 'ai';
          // For button/static vars, use empty string if no index, otherwise use 0
          const defaultIndex = (kind === 'button' || kind === 'static') ? (s.index || '') : (s.index || 0);
          const newSel = await createSignalSelector(kind, defaultIndex, newIdx => {
            s.index = newIdx;
            s.name = s.name || labelFor(s);
          });
          signalSel.replaceWith(newSel);
          signalSel = newSel;
        })();
        
        const nameInput = el('input', {
          type: 'text',
          value: (s.name && s.name.length) ? s.name : labelFor(s),
          placeholder: 'label',
          style: 'width:80px'
        });
        nameInput.oninput = () => s.name = nameInput.value;

        // Display scaling inputs
        const scaleInput = el('input', {
          type: 'number',
          step: 'any',
          value: s.displayScale,
          style: 'width:60px',
          title: 'Display Scale (multiplier)'
        });
        scaleInput.oninput = () => s.displayScale = parseFloat(scaleInput.value) || 1.0;
        const offsetInput = el('input', {
          type: 'number',
          step: 'any',
          value: s.displayOffset,
          style: 'width:60px',
          title: 'Display Offset (added after scale)'
        });
        offsetInput.oninput = () => s.displayOffset = parseFloat(offsetInput.value) || 0.0;

        const rm = el('span', {
          className: 'icon', onclick: () => {
            items.splice(idx, 1);
            redrawList();
          }
        }, '−');

        const row = el('div', {style: 'display:flex;gap:4px;align-items:center;margin:4px 0;flex-wrap:wrap'}, [
          el('span', {style: 'min-width:40px;font-size:11px;color:var(--muted)'}, 'Kind:'),
          kindSel,
          el('span', {style: 'min-width:50px;font-size:11px;color:var(--muted)'}, 'Signal:'),
          signalSel,
          el('span', {style: 'min-width:40px;font-size:11px;color:var(--muted)'}, 'Name:'),
          nameInput,
          el('br', {}),
          el('span', {style: 'min-width:40px;font-size:11px;color:var(--muted)'}, 'Scale:'),
          scaleInput,
          el('span', {style: 'min-width:45px;font-size:11px;color:var(--muted)'}, 'Offset:'),
          offsetInput,
          rm
        ]);
        list.append(row);
      });
    }

    const add = el('span', {
      className: 'icon', onclick: () => {
        const s = {
          kind: 'ai',
          index: 0,
          name: labelFor({kind: 'ai', index: 0}),
          displayScale: 1.0,
          displayOffset: 0.0
        };
        items.push(s);
        redrawList();
      }
    }, '+ Add');
    redrawList();
    root.append(el('h4', {}, (w.type === 'gauge' ? 'Needles' : 'Series')), list, el('div', {style: 'margin-top:8px'}, add));
    
    // Add Scale Op checkbox and divisions for gauges
    if (w.type === 'gauge') {
      const scaleOpChk = inputChk(w.opts, 'scaleOp');
      scaleOpChk.onchange = () => {
        w.opts.scaleOp = scaleOpChk.checked;
        if (!w.opts.scaleOp) {
          // Clear tare offsets when disabling
          delete w.opts.tareOffsets;
        }
      };
      
      // Set default divisions if not set
      if (w.opts.divisions === undefined) w.opts.divisions = 5;
      
      root.append(
        el('hr', {className: 'soft', style: 'margin:16px 0'}),
        tableForm([
          ['Scale Operation Mode (enables Tare button)', scaleOpChk],
          ['Number of Divisions (tick marks)', inputNum(w.opts, 'divisions', 1)]
        ])
      );
    }
  }

  if (w.type === 'dobutton') {
    // Ensure outputType exists
    w.opts.outputType = w.opts.outputType || 'do';
    w.opts.varName = w.opts.varName || 'button1';
    
    const outputTypeSel = selectEnum(['do', 'var'], w.opts.outputType, v => {
      w.opts.outputType = v;
      renderSettingsRows();
    });
    
    const renderSettingsRows = () => {
      const isDO = w.opts.outputType === 'do';
      const rows = [
        ['Title', titleInput],
        ['Output Type', outputTypeSel]
      ];
      
      if (isDO) {
        rows.push(['DO Index', inputNum(w.opts, 'doIndex', 1)]);
        rows.push(['Active High', inputChk(w.opts, 'activeHigh')]);
      } else {
        const varInput = el('input', {type: 'text', value: w.opts.varName || 'button1'});
        varInput.oninput = () => w.opts.varName = varInput.value;
        rows.push(['Variable Name', varInput]);
      }
      
      const modeSel = selectEnum(['toggle', 'momentary', 'buzz'], w.opts.mode || 'toggle', v => w.opts.mode = v);
      rows.push(['Mode', modeSel]);
      
      if (isDO && w.opts.mode === 'buzz') {
        rows.push(['Buzz Hz', inputNum(w.opts, 'buzzHz', 10)]);
      }
      
      if (w.opts.mode === 'toggle') {
        rows.push(['Actuation Time (s)', inputNum(w.opts, 'actuationTime', 0.01)]);
      }
      
      // Clear and rebuild
      const existing = root.querySelector('table');
      if (existing) existing.remove();
      root.append(tableForm(rows));
    };
    
    renderSettingsRows();
  }

  if (w.type === 'aoslider') {
    const minI = inputNum(w.opts, 'min', 0.001);
    const maxI = inputNum(w.opts, 'max', 0.001);
    const stepI = inputNum(w.opts, 'step', 0.0001);
    const applyAOdom = () => {
      const node = document.querySelector('#w_' + w.id);
      if (!node) return;
      const rng = node.querySelector('input[type="range"]');
      const cur = node.querySelector('input[type="number"]');
      if (rng) {
        rng.min = w.opts.min;
        rng.max = w.opts.max;
        rng.step = w.opts.step;
      }
      if (cur) {
        cur.min = w.opts.min;
        cur.max = w.opts.max;
        cur.step = w.opts.step;
      }
      const hdr = node.querySelector('header .title');
      if (hdr) hdr.textContent = w.opts.title || 'AO';
    };
    minI.oninput = () => {
      w.opts.min = parseFloat(minI.value) || 0;
      applyAOdom();
    };
    maxI.oninput = () => {
      w.opts.max = parseFloat(maxI.value) || 10;
      applyAOdom();
    };
    stepI.oninput = () => {
      w.opts.step = parseFloat(stepI.value) || 0.0001;
      applyAOdom();
    };

    root.append(tableForm([
      ['Title', titleInput],
      ['AO Index', inputNum(w.opts, 'aoIndex', 1)],
      ['Min V', minI],
      ['Max V', maxI],
      ['Step V', stepI],
      ['Live (send on move)', inputChk(w.opts, 'live')]
    ]));
  }

  if (w.type === 'pidpanel') {
    // Async load PID loops for dropdown
    (async () => {
      try {
        const pid = await (await fetch('/api/pid')).json();
        const loops = pid.loops || [];

        const loopSelector = el('select', {});
        loops.forEach((loop, idx) => {
          const name = loop.name || `Loop ${idx}`;
          const enabled = loop.enabled ? '✓' : '✗';
          loopSelector.append(el('option', {value: idx}, `${name} (${enabled})`));
        });
        loopSelector.value = w.opts.loopIndex || 0;
        loopSelector.onchange = () => {
          w.opts.loopIndex = parseInt(loopSelector.value);
          renderPage();
        };

        root.append(tableForm([
          ['Loop', loopSelector],
          ['Show Controls', inputChk(w.opts, 'showControls')]
        ]));
      } catch (e) {
        root.append(tableForm([
          ['Loop Index', inputNum(w.opts, 'loopIndex', 1)],
          ['Show Controls', inputChk(w.opts, 'showControls')]
        ]));
      }
    })();
  }

  if (w.type === 'motor') {
    // Async load motors for dropdown
    (async () => {
      try {
        const motorData = await (await fetch('/api/motors')).json();
        const motors = motorData.motors || [];

        const motorSelector = el('select', {});
        motors.forEach((m, i) => {
          const included = m.include ? '✓' : '✗';
          motorSelector.append(el('option', {value: i}, `${m.name || `Motor ${i}`} (${included})`));
        });
        motorSelector.value = w.opts.motorIndex || 0;
        motorSelector.onchange = () => {
          w.opts.motorIndex = parseInt(motorSelector.value);
          renderPage();
        };

        root.append(tableForm([
          ['Motor', motorSelector],
          ['Show Controls', inputChk(w.opts, 'showControls')]
        ]));
      } catch (e) {
        root.append(tableForm([
          ['Motor Index', inputNum(w.opts, 'motorIndex', 1)],
          ['Show Controls', inputChk(w.opts, 'showControls')]
        ]));
      }
    })();
  }

  if (w.type === 'le') {
    // Async load LEs for dropdown
    (async () => {
      try {
        const leData = await (await fetch('/api/logic_elements')).json();
        const elements = leData.elements || [];

        const leSelector = el('select', {});
        elements.forEach((le, i) => {
          const name = le.name || `LE${i}`;
          const op = (le.operation || 'and').toUpperCase();
          leSelector.append(el('option', {value: i}, `${name} (${op})`));
        });
        leSelector.value = w.opts.leIndex || 0;
        leSelector.onchange = () => {
          w.opts.leIndex = parseInt(leSelector.value);
          renderPage();
        };

        root.append(tableForm([
          ['Logic Element', leSelector],
          ['Show Inputs', inputChk(w.opts, 'showInputs')]
        ]));
      } catch (e) {
        root.append(tableForm([
          ['LE Index', inputNum(w.opts, 'leIndex', 1)],
          ['Show Inputs', inputChk(w.opts, 'showInputs')]
        ]));
      }
    })();
  }

  if (w.type === 'mathop') {
    // Async load math operators for dropdown
    (async () => {
      try {
        const mathData = await (await fetch('/api/math_operators')).json();
        const operators = mathData.operators || [];

        const mathSelector = el('select', {});
        operators.forEach((m, i) => {
          const name = m.name || `Math${i}`;
          const op = m.operation || 'add';
          mathSelector.append(el('option', {value: i}, `${name} (${op})`));
        });
        mathSelector.value = w.opts.mathIndex || 0;
        mathSelector.onchange = () => {
          w.opts.mathIndex = parseInt(mathSelector.value);
          renderPage();
        };

        root.append(tableForm([
          ['Math Operator', mathSelector],
          ['Show Inputs', inputChk(w.opts, 'showInputs')]
        ]));
      } catch (e) {
        root.append(tableForm([
          ['Math Index', inputNum(w.opts, 'mathIndex', 1)],
          ['Show Inputs', inputChk(w.opts, 'showInputs')]
        ]));
      }
    })();
  }

  if (w.type === 'expr') {
    // Async load expressions for dropdown
    (async () => {
      try {
        const exprData = await (await fetch('/api/expressions')).json();
        const expressions = exprData.expressions || [];

        const exprSelector = el('select', {});
        expressions.forEach((e, i) => {
          const name = e.name || `Expr${i}`;
          const enabled = e.enabled ? '✓' : '✗';
          exprSelector.append(el('option', {value: i}, `${name} (${enabled})`));
        });
        exprSelector.value = w.opts.exprIndex || 0;
        exprSelector.onchange = () => {
          w.opts.exprIndex = parseInt(exprSelector.value);
          renderPage();
        };

        root.append(tableForm([
          ['Expression', exprSelector],
          ['Show Variables', inputChk(w.opts, 'showSource')],
          ['Show Output', inputChk(w.opts, 'showOutput')]
        ]));
      } catch (e) {
        root.append(tableForm([
          ['Expression Index', inputNum(w.opts, 'exprIndex', 1)],
          ['Show Variables', inputChk(w.opts, 'showSource')],
          ['Show Output', inputChk(w.opts, 'showOutput')]
        ]));
      }
    })();
  }

  showModal(root, () => {
    renderPage();
  });
}
function renderPage(){
  const cv=$('#canvas'); cv.innerHTML='';
  const page=state.pages[activePageIndex];
  for(const w of page.widgets){
    const node=renderWidget(w);
    node.style.left=(w.x||0)+'px';
    node.style.top=(w.y||0)+'px';
    node.style.width=(w.w||300)+'px';
    node.style.height=(w.h||200)+'px';
    cv.append(node);
    makeDragResize(node, w, node.querySelector('header'), node.querySelector('.resize'));
  }
  updateDOButtons();
}

function renderWidget(w){
  let classList = 'widget';
  if (w.type === 'dobutton') classList += ' dobutton-widget';
  if (w.type === 'le') classList += ' le-widget';
  if (w.type === 'mathop') classList += ' mathop-widget';
  if (w.type === 'pidpanel') classList += ' pidpanel-widget';
  if (w.type === 'bars') classList += ' bars-widget';
  if (w.type === 'expr') classList += ' expr-widget';
  const box=el('div',{className:classList, id:'w_'+w.id});
  
  // LE and mathop widgets get minimal headers (via CSS)
  const isCompact = (w.type === 'le' || w.type === 'mathop');
  
  // LE widgets don't need settings - only close button
  let toolButtons;
  if (w.type === 'le') {
    toolButtons = [el('span',{className:'icon', title:'Close', onclick:()=>removeWidget(w.id)}, '×')];
  } else if (w.type === 'expr') {
    // Expression widgets get debug button
    toolButtons = [
      el('span',{className:'icon', title:'Debug View', onclick:()=>openExpressionDebug(w)}, '🔍'),
      el('span',{className:'icon', title:'Settings', onclick:()=>openWidgetSettings(w)}, '⚙'),
      el('span',{className:'icon', title:'Close',    onclick:()=>removeWidget(w.id)}, '×')
    ];
  } else {
    toolButtons = [
      el('span',{className:'icon', title:'Settings', onclick:()=>openWidgetSettings(w)}, '⚙'),
      el('span',{className:'icon', title:'Close',    onclick:()=>removeWidget(w.id)}, '×')
    ];
  }
  
  const tools=el('div',{className:'tools'}, toolButtons);
  const header=el('header',{},[
    el('span',{className:'title'}, w.opts.title||w.type),
    el('div',{className:'spacer'}),
    el('div',{className:'opts'}, widgetOptions(w)),
    tools
  ]);
  const body=el('div',{className:'body'});
  const rez=el('div',{className:'resize'});
  box.append(header,body,rez);
  switch(w.type){
    case 'chart':    mountChart(w,body); break;
    case 'gauge':    mountGauge(w,body); break;
    case 'bars':     mountBars(w,body); break;
    case 'dobutton': mountDOButton(w,body); break;
    case 'pidpanel': mountPIDPanel(w,body); break;
    case 'aoslider': mountAOSlider(w,body); break;
    case 'motor':    mountMotorController(w,body); break;
    case 'le':       mountLEWidget(w,body); break;
    case 'mathop':   mountMathOpWidget(w,body); break;
    case 'expr':     mountExprWidget(w,body); break;
  }
  return box;
}
function removeWidget(id){
  const page=state.pages[activePageIndex];
  const idx=page.widgets.findIndex(x=>x.id===id);
  if(idx>=0){ page.widgets.splice(idx,1); renderPage(); }
}

function widgetOptions(w){
  const opts=[];
  if (w.type==='chart'||w.type==='gauge'||w.type==='bars'){
    const sel=el('select',{},[
      el('option',{value:'auto'}, 'Auto'),
      el('option',{value:'manual'}, 'Manual')
    ]);
    sel.value = w.opts.scale || 'auto';  // Set value AFTER options are added
    sel.onchange=e=>{ w.opts.scale=e.target.value; };
    const min=el('input',{type:'number',value:w.opts.min, step:'any', style:'width:90px'});
    const max=el('input',{type:'number',value:w.opts.max, step:'any', style:'width:90px'});
    const sync=()=>{ w.opts.min=parseFloat(min.value)||0; w.opts.max=parseFloat(max.value)||0; };
    min.oninput=sync; max.oninput=sync;
    opts.push(el('span',{},'Scale:'), sel, el('span',{},'Min:'), min, el('span',{},'Max:'), max);
  }
  if (w.type==='chart'){
    const span=el('input',{type:'number', value:w.opts.span, min:1, step:1, style:'width:70px'});
    span.oninput=()=>{
      const newSpan = parseFloat(span.value)||10;
      w.opts.span = newSpan;

      // If not zoom-paused, update view span too
      if (!w.view.paused) {
        w.view.span = newSpan;
      }

      // Clear any data beyond the new buffer depth immediately
      const buf = chartBuffers.get(w.id);
      if (buf && buf.length) {
        const t = performance.now()/1000;
        const bufferDepth = newSpan * 1.2;
        while (buf.length && (t - buf[0].t) > bufferDepth) {
          buf.shift();
        }
      }
    };

    const filt=el('input',{type:'number', value:w.opts.filterHz||0, min:0, step:'any', style:'width:80px'});
    filt.oninput =()=>{ w.opts.filterHz=parseFloat(filt.value)||0; };

    const yGrid=el('input',{type:'number', value:w.opts.yGridLines||5, min:2, max:20, step:1, style:'width:60px'});
    yGrid.oninput=()=>{ w.opts.yGridLines=parseInt(yGrid.value)||5; };

    const pause=el('button',{className:'btn', onclick:()=>{
      w.opts.paused=!w.opts.paused;
      if (w.opts.paused) {
        // Freeze current time when pausing
        const buf = chartBuffers.get(w.id) || [];
        if (buf.length) {
          w.opts.tFreeze = buf[buf.length - 1].t;
        }
      } else {
        // Clear freeze time when resuming
        w.opts.tFreeze = null;
      }
      pause.textContent=w.opts.paused?'Resume':'Pause';
    }}, w.opts.paused?'Resume':'Pause');

    opts.push(el('span',{},'Span[s]:'), span, el('span',{},'Filter[Hz]:'), filt, el('span',{},'Y Grid:'), yGrid, pause);
  }
  if (w.type==='bars'){
    const yGrid=el('input',{type:'number', value:w.opts.yGridLines||5, min:2, max:20, step:1, style:'width:60px'});
    yGrid.oninput=()=>{ w.opts.yGridLines=parseInt(yGrid.value)||5; };
    opts.push(el('span',{},'Y Grid:'), yGrid);
  }
  return opts;
}


/* ------------------------------- chart ---------------------------------- */
const chartBuffers=new Map();
const chartFilters=new Map();
const chartCursor=new Map(); // w.id -> {x: number|null, mode:'follow'|'current', ctxEl:HTMLElement|null}
const chartRAFHandles=new Map(); // w.id -> {rafId: number, isRunning: boolean}

/* ==================== ENHANCED CHART WITH GRID ==================== */
/* ==================== FIXED CHART SPAN - LIVE UPDATE ==================== */
// The issue is that w.view.span gets used in draw(), but when NOT paused,
// it should follow w.opts.span. Let me fix the draw function logic:

function mountChart(w, body){
  const legend=el('div',{className:'legend'}); body.append(legend);
  const canvas=el('canvas'); body.append(canvas);
  const ctx=canvas.getContext('2d');

  // Initialize view
  w.view = w.view || { span: (window.GLOBAL_BUFFER_SPAN || 10), paused: false, tFreeze: 0 };
  w.opts.yGridLines = w.opts.yGridLines || 5;

  // Sync initial span
  if (!w.opts.span) {
    w.opts.span = w.view.span;
  } else {
    w.view.span = w.opts.span;
  }

  canvas.addEventListener('wheel', (ev)=>{
    ev.preventDefault();
    if (ev.shiftKey){
      window.GLOBAL_BUFFER_SPAN = Math.max(1, Math.min(3600, (window.GLOBAL_BUFFER_SPAN || 10) * ((ev.deltaY>0)?1.15:1/1.15)));
      for (const p of state.pages){
        for (const w2 of p.widgets){
          if (w2.type==='chart'){
            w2.view = w2.view || { span: window.GLOBAL_BUFFER_SPAN, paused:false, tFreeze:0 };
            if (!w2.view.paused) {
              w2.view.span = window.GLOBAL_BUFFER_SPAN;
              w2.opts.span = window.GLOBAL_BUFFER_SPAN;
            }
          }
        }
      }
    } else {
      const base = (w.view.span || (window.GLOBAL_BUFFER_SPAN || 10));
      w.view.span = Math.max(0.1, Math.min(3600, base * ((ev.deltaY>0)?1.15:1/1.15)));
      w.opts.span = w.view.span; // Keep in sync
      const buf = chartBuffers.get(w.id) || [];
      w.view.paused = true;
      w.view.tFreeze = buf.length ? buf[buf.length-1].t : performance.now()/1000;
    }
  }, {passive:false});

  canvas.addEventListener('dblclick', ()=>{
    w.view.span = w.opts.span || (window.GLOBAL_BUFFER_SPAN || 10);
    w.view.paused = false;
  });

  chartCursor.set(w.id, {x:null, mode:w.opts.cursorMode||'follow', ctxEl:null});

  canvas.addEventListener('mousemove', (e)=>{
    const rect=canvas.getBoundingClientRect(); const x=e.clientX-rect.left;
    const cur=chartCursor.get(w.id); if(!cur) return;
    cur.x=x; chartCursor.set(w.id,cur);
  });
  canvas.addEventListener('mouseleave', ()=>{
    const cur=chartCursor.get(w.id);
    if(cur){ cur.x=null; chartCursor.set(w.id,cur); }
  });
  canvas.addEventListener('contextmenu', (e)=>{
    e.preventDefault();
    const cur=chartCursor.get(w.id)||{x:null,mode:'follow',ctxEl:null};
    if (cur.ctxEl && cur.ctxEl.parentNode) cur.ctxEl.parentNode.removeChild(cur.ctxEl);
    const menu=buildChartContextMenu(w, canvas, legend);
    document.body.append(menu); menu.style.left=e.pageX+'px'; menu.style.top=e.pageY+'px';
    cur.ctxEl=menu; chartCursor.set(w.id,cur);
  });

  function draw(){
    const buf=chartBuffers.get(w.id)||[];
    const W=canvas.clientWidth, H=canvas.clientHeight;
    canvas.width=W; canvas.height=H;
    const plotL=60, plotR=W-10, plotT=10, plotB=H-30;

    ctx.clearRect(0,0,W,H);
    ctx.strokeStyle='#3b425e'; ctx.lineWidth=1;
    ctx.strokeRect(plotL,plotT,plotR-plotL,plotB-plotT);

    if (buf.length){
      // KEY FIX: When NOT paused by zoom, use opts.span (the spinner value)
      // When paused by zoom, use view.span (the zoomed value)
      const viewSpan = w.view.paused
        ? w.view.span
        : (w.opts.span || window.GLOBAL_BUFFER_SPAN || 10);

      // Handle both zoom pause (w.view.paused) and button pause (w.opts.paused)
      let t1;
      if (w.view.paused) {
        t1 = w.view.tFreeze || buf[buf.length-1].t;
      } else if (w.opts.paused && w.opts.tFreeze !== null && w.opts.tFreeze !== undefined) {
        t1 = w.opts.tFreeze;
      } else {
        t1 = buf[buf.length-1].t;
      }
      const t0 = t1 - viewSpan;
      const viewBuf = buf.filter(b => b.t >= t0);
      const dt = Math.max(1e-6, t1 - t0);

      let ymin = Infinity, ymax = -Infinity;
      for (let si = 0; si < w.opts.series.length; si++){
        const s = w.opts.series[si];
        const displayScale = s.displayScale !== undefined ? s.displayScale : 1.0;
        const displayOffset = s.displayOffset !== undefined ? s.displayOffset : 0.0;
        for (const b of viewBuf){
          const displayValue = (b.v[si] * displayScale) + displayOffset;
          if (displayValue < ymin) ymin = displayValue;
          if (displayValue > ymax) ymax = displayValue;
        }
      }
      if (w.opts.scale === 'manual'){ ymin = w.opts.min; ymax = w.opts.max; }
      if (!(isFinite(ymin) && isFinite(ymax)) || ymin === ymax){ ymin -= 1; ymax += 1; }

      const yscale = (plotB - plotT)/(ymax - ymin);
      const xscale = (plotR - plotL)/dt;

      // X grid (vertical lines for time)
      const xDivs = 10; const gridDt = viewSpan/xDivs;
      const firstGrid = Math.ceil(t0 / gridDt)*gridDt;
      ctx.strokeStyle=(getComputedStyle(document.documentElement).getPropertyValue('--grid') || '#2a2f44').trim();
      ctx.lineWidth=1;
      for (let gx = firstGrid; gx <= t1 + 1e-6; gx += gridDt){
        const x = plotL + (gx - t0) * xscale;
        ctx.beginPath(); ctx.moveTo(x, plotT); ctx.lineTo(x, plotB); ctx.stroke();
      }

      // Y grid (horizontal lines with labels)
      const yGridLines = Math.max(2, Math.min(20, w.opts.yGridLines || 5));
      ctx.strokeStyle=(getComputedStyle(document.documentElement).getPropertyValue('--grid') || '#2a2f44').trim();
      ctx.lineWidth=1;
      ctx.fillStyle='#7a8199';
      ctx.font='11px system-ui';
      ctx.textAlign='right';
      ctx.textBaseline='middle';

      for (let i = 0; i <= yGridLines; i++) {
        const frac = i / yGridLines;
        const y = plotB - frac * (plotB - plotT);
        const val = ymin + frac * (ymax - ymin);

        ctx.beginPath();
        ctx.moveTo(plotL, y);
        ctx.lineTo(plotR, y);
        ctx.stroke();

        ctx.fillText(val.toFixed(2), plotL - 5, y);

        ctx.textAlign='center';
        ctx.fillStyle='rgba(122, 129, 153, 0.6)';
        ctx.fillText(val.toFixed(2), (plotL + plotR) / 2, y - 2);
        ctx.fillStyle='#7a8199';
        ctx.textAlign='right';
      }

      // Draw series
      legend.innerHTML='';
      (w.opts.series||[]).forEach((s, si)=>{
        const displayScale = s.displayScale !== undefined ? s.displayScale : 1.0;
        const displayOffset = s.displayOffset !== undefined ? s.displayOffset : 0.0;
        
        ctx.beginPath();
        let first = true;
        for (const b of viewBuf){
          const displayValue = (b.v[si] * displayScale) + displayOffset;
          const x = plotL + (b.t - t0) * xscale;
          const y = plotB - (displayValue - ymin) * yscale;
          if (first){ ctx.moveTo(x,y); first=false; } else ctx.lineTo(x,y);
        }
        ctx.strokeStyle = colorFor(si); ctx.lineWidth = 2; ctx.stroke();
        const lab = (s.name && s.name.length) ? s.name : labelFor(s);
        legend.append(el('div',{className:'item'},[
          el('span',{className:'swatch', style:`background:${colorFor(si)}`},''), lab
        ]));
      });

      // Cursor & popup
      const cur = chartCursor.get(w.id);
      if (cur && cur.x !== null && cur.x >= plotL && cur.x <= plotR){
        ctx.strokeStyle=(getComputedStyle(document.documentElement).getPropertyValue('--cursor')||'#ff4d4d').trim();
        ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(cur.x,plotT); ctx.lineTo(cur.x,plotB); ctx.stroke();
        if (cur.ctxEl && cur.ctxEl.parentNode){
          updateChartPopupValues(w, cur.ctxEl, viewBuf, t0, xscale, plotL, ymin, ymax, (plotB-plotT)/(ymax-ymin), cur.x);
        }
      } else if (cur && cur.ctxEl && cur.ctxEl.parentNode && getPopupMode(cur.ctxEl)==='current'){
        updateChartPopupValues(w, cur.ctxEl, viewBuf, t0, xscale, plotL, ymin, ymax, (plotB-plotT)/(ymax-ymin), null);
      }
    }
    
    // Track RAF state
    const rafState = chartRAFHandles.get(w.id) || {isRunning: false};
    rafState.isRunning = true;
    rafState.rafId = requestAnimationFrame(draw);
    chartRAFHandles.set(w.id, rafState);
  }
  
  // Check if this widget had a running RAF before (e.g., after renderPage)
  const existingRAF = chartRAFHandles.get(w.id);
  if (existingRAF && existingRAF.isRunning) {
    // Widget was recreated but RAF was running - restart it
    draw();
  } else {
    // First time mount
    draw();
  }
}

// And update the widgetOptions to NOT update view.span directly:

function widgetOptions(w){
  const opts=[];
  if (w.type==='chart'||w.type==='gauge'||w.type==='bars'){
    const sel=el('select',{},[
      el('option',{value:'auto'}, 'Auto'),
      el('option',{value:'manual'}, 'Manual')
    ]);
    sel.value = w.opts.scale || 'auto';  // Set value AFTER options are added
    sel.onchange=e=>{ w.opts.scale=e.target.value; };
    const min=el('input',{type:'number',value:w.opts.min, step:'any', style:'width:90px'});
    const max=el('input',{type:'number',value:w.opts.max, step:'any', style:'width:90px'});
    const sync=()=>{ w.opts.min=parseFloat(min.value)||0; w.opts.max=parseFloat(max.value)||0; };
    min.oninput=sync; max.oninput=sync;
    opts.push(el('span',{},'Scale:'), sel, el('span',{},'Min:'), min, el('span',{},'Max:'), max);
  }
  if (w.type==='chart'){
    const span=el('input',{type:'number', value:w.opts.span, min:1, step:1, style:'width:70px'});
    span.oninput=()=>{
      w.opts.span=parseFloat(span.value)||10;
      // If NOT zoom-paused, this will take effect immediately via draw()
      // If zoom-paused, it will take effect when user double-clicks to reset
    };

    const filt=el('input',{type:'number', value:w.opts.filterHz||0, min:0, step:'any', style:'width:80px'});
    filt.oninput =()=>{ w.opts.filterHz=parseFloat(filt.value)||0; };

    const yGrid=el('input',{type:'number', value:w.opts.yGridLines||5, min:2, max:20, step:1, style:'width:60px'});
    yGrid.oninput=()=>{ w.opts.yGridLines=parseInt(yGrid.value)||5; };

    const pause=el('button',{className:'btn', onclick:()=>{
      w.opts.paused=!w.opts.paused;
      if (w.opts.paused) {
        // Freeze current time when pausing
        const buf = chartBuffers.get(w.id) || [];
        if (buf.length) {
          w.opts.tFreeze = buf[buf.length - 1].t;
        }
      } else {
        // Clear freeze time when resuming
        w.opts.tFreeze = null;
      }
      pause.textContent=w.opts.paused?'Resume':'Pause';
    }}, w.opts.paused?'Resume':'Pause');

    opts.push(el('span',{},'Span[s]:'), span, el('span',{},'Filter[Hz]:'), filt, el('span',{},'Y Grid:'), yGrid, pause);
  }
  if (w.type==='bars'){
    const yGrid=el('input',{type:'number', value:w.opts.yGridLines||5, min:2, max:20, step:1, style:'width:60px'});
    yGrid.oninput=()=>{ w.opts.yGridLines=parseInt(yGrid.value)||5; };
    opts.push(el('span',{},'Y Grid:'), yGrid);
  }
  return opts;
}

function buildChartContextMenu(w, canvas, legend){
  const menu=el('div',{className:'ctx persistent'});

  // Add close button at top right
  const closeBtn = el('button', {
    className: 'ctx-close',
    onclick: () => {
      if (menu.parentNode) {
        menu.parentNode.removeChild(menu);
      }
      const cur = chartCursor.get(w.id);
      if (cur) {
        cur.ctxEl = null;
        chartCursor.set(w.id, cur);
      }
    }
  }, '×');

  const header = el('div', {className: 'ctx-header'}, [
    el('h4', {}, (w.opts.title||'Chart')+' – Data'),
    closeBtn
  ]);

  const cur=chartCursor.get(w.id)||{mode:'follow', sigDigits:2, showSlope:false};

  // Compact layout: Follow / Slope on one line, Current / Digits on second line
  const follow=el('label',{style:'margin-right:12px'},[
    el('input',{type:'radio',name:'mode',value:'follow'}),
    'Follow'
  ]);
  
  const slope=el('label',{},[
    el('input',{type:'checkbox',name:'showSlope'}),
    'Slope'
  ]);
  
  const current=el('label',{style:'margin-right:8px'},[
    el('input',{type:'radio',name:'mode',value:'current'}),
    'Current'
  ]);

  // Sig digits: just spinner + "#.##"
  const sigDigits = el('input', {
    type:'number', 
    name:'sigDigits', 
    min:0, 
    max:10, 
    step:1, 
    value:cur.sigDigits||2,
    style:'width:45px;margin-right:4px'
  });
  
  const digitsLabel = el('span', {style:'display:inline-flex;align-items:center;gap:4px'}, [
    sigDigits,
    el('span', {style:'color:#7a8199;font-size:11px'}, '#.##')
  ]);

  setTimeout(()=>{
    const radios=menu.querySelectorAll('input[type=radio][name=mode]');
    radios.forEach(r=>{ if (r.value=== (cur.mode||'follow')) r.checked=true; });
    const slopeChk = menu.querySelector('input[name=showSlope]');
    if (slopeChk) slopeChk.checked = cur.showSlope || false;
  });

  menu.append(
    header, 
    el('div',{className:'row', style:'display:flex;gap:8px;align-items:center'}, [follow, slope]),
    el('div',{className:'row', style:'display:flex;gap:8px;align-items:center'}, [current, digitsLabel])
  );

  const table=el('table',{},[
    el('thead',{}, el('tr',{}, [
      el('th',{},'Series'), 
      el('th',{},'Value'),
      el('th',{id:`slope-header-${w.id}`, style:'display:none'},'Slope')
    ])),
    el('tbody',{})
  ]);
  menu.append(table);

  menu.addEventListener('change',(e)=>{
    if (e.target && e.target.name==='mode'){
      const cur=chartCursor.get(w.id)||{x:null, mode:'follow', ctxEl:menu, sigDigits:2, showSlope:false};
      cur.mode=e.target.value;
      chartCursor.set(w.id,cur);
    }
    if (e.target && e.target.name==='sigDigits'){
      const cur=chartCursor.get(w.id)||{x:null, mode:'follow', ctxEl:menu, sigDigits:2, showSlope:false};
      cur.sigDigits=parseInt(e.target.value)||2;
      chartCursor.set(w.id,cur);
    }
    if (e.target && e.target.name==='showSlope'){
      const cur=chartCursor.get(w.id)||{x:null, mode:'follow', ctxEl:menu, sigDigits:2, showSlope:false};
      cur.showSlope=e.target.checked;
      chartCursor.set(w.id,cur);
      // Show/hide slope column
      const slopeHeader = menu.querySelector(`#slope-header-${w.id}`);
      if (slopeHeader) slopeHeader.style.display = cur.showSlope ? '' : 'none';
      const slopeCells = menu.querySelectorAll('.slope-cell');
      slopeCells.forEach(cell => cell.style.display = cur.showSlope ? '' : 'none');
    }
  });

  // Make it draggable by the header
  makeDraggable(menu, header);

  return menu;
}

// Add a simple draggable function for the popup:
function makeDraggable(element, handle){
  let isDragging = false;
  let startX, startY, initialLeft, initialTop;

  handle.style.cursor = 'move';

  handle.addEventListener('mousedown', (e)=>{
    // Don't drag if clicking on close button or inputs
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;

    const rect = element.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    e.preventDefault();
  });

  document.addEventListener('mousemove', (e)=>{
    if (!isDragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    element.style.left = (initialLeft + dx) + 'px';
    element.style.top = (initialTop + dy) + 'px';
  });

  document.addEventListener('mouseup', ()=>{
    isDragging = false;
  });
}

function getPopupMode(menu){
  const v=menu.querySelector('input[type=radio][name=mode]:checked'); return v ? v.value : 'follow';
}
function updateChartPopupValues(w, menu, buf, t0, xscale, plotL, ymin, ymax, yscale, cursorX){
  const mode=getPopupMode(menu);
  const tbody = menu.querySelector('tbody'); if(!tbody) return;
  
  // Get sig digits and showSlope from cursor state or menu
  const cur = chartCursor.get(w.id);
  let sigDigits = cur?.sigDigits || 2;
  let showSlope = cur?.showSlope || false;
  
  const sigInput = menu.querySelector('input[name=sigDigits]');
  if (sigInput && sigInput.value) {
    sigDigits = parseInt(sigInput.value) || 2;
  }
  
  const slopeChk = menu.querySelector('input[name=showSlope]');
  if (slopeChk) {
    showSlope = slopeChk.checked;
  }
  
  // Update slope header visibility
  const slopeHeader = menu.querySelector(`#slope-header-${w.id}`);
  if (slopeHeader) slopeHeader.style.display = showSlope ? '' : 'none';
  
  const vals=[];
  if (!buf.length){ tbody.innerHTML=''; return; }
  
  let targetIdx = buf.length - 1; // Current by default
  if (mode==='follow' && cursorX!==null){
    const t = t0 + (cursorX-plotL)/xscale;
    targetIdx = findNearestIndex(buf, t);
  }
  
  const v = buf[targetIdx].v;
  const t_current = buf[targetIdx].t;
  
  // Calculate slopes (units/second) averaged over 1s window or chart span if < 1s
  const slopeWindow = Math.min(1.0, w.opts.span || 1.0);
  const t_past = t_current - slopeWindow;
  
  (w.opts.series||[]).forEach((s,si)=>{ 
    let slope = null;
    if (showSlope && buf.length > 1) {
      // Collect all points in the 1s window
      const windowPoints = [];
      for (let i = 0; i < buf.length; i++) {
        if (buf[i].t >= t_past && buf[i].t <= t_current) {
          const val = buf[i].v[si];
          if (val !== null && isFinite(val)) {
            windowPoints.push({t: buf[i].t, v: val});
          }
        }
      }
      
      // Calculate average slope using linear regression
      if (windowPoints.length >= 2) {
        const n = windowPoints.length;
        let sum_t = 0, sum_v = 0, sum_tv = 0, sum_tt = 0;
        
        for (const pt of windowPoints) {
          sum_t += pt.t;
          sum_v += pt.v;
          sum_tv += pt.t * pt.v;
          sum_tt += pt.t * pt.t;
        }
        
        // Linear regression: slope = (n*sum_tv - sum_t*sum_v) / (n*sum_tt - sum_t*sum_t)
        const denominator = n * sum_tt - sum_t * sum_t;
        if (Math.abs(denominator) > 1e-10) {
          slope = (n * sum_tv - sum_t * sum_v) / denominator;
        }
      }
    }
    
    // Get units for this series
    let units = '';
    if (showSlope && slope !== null) {
      if (s.kind === 'tc') {
        units = '°C/s';
      } else if (s.kind === 'ai' && configCache && configCache.analogs && configCache.analogs[s.index]) {
        const aiUnits = configCache.analogs[s.index].units || '';
        units = aiUnits ? `${aiUnits}/s` : '/s';
      } else {
        units = '/s';
      }
    }
    
    vals.push([s, v[si], slope, units]); 
  });
  
  tbody.innerHTML='';
  vals.forEach(([s,v,slope,units],si)=>{
    const lab = s.name && s.name.length ? s.name : labelFor(s);
    const valueStr = (v!=null && isFinite(v))? v.toFixed(sigDigits) : '—';
    const slopeStr = showSlope && slope !== null && isFinite(slope) ? `${slope.toFixed(sigDigits)} ${units}` : '—';
    
    const cells = [
      el('td',{}, lab), 
      el('td',{}, valueStr)
    ];
    
    if (showSlope) {
      cells.push(el('td',{className:'slope-cell'}, slopeStr));
    } else {
      cells.push(el('td',{className:'slope-cell', style:'display:none'}, slopeStr));
    }
    
    const tr=el('tr',{}, cells);
    tbody.append(tr);
  });
}
function findNearestIndex(buf, t){
  let lo=0, hi=buf.length-1;
  while (lo<hi){
    const mid=(lo+hi)>>1;
    if (buf[mid].t < t) lo=mid+1; else hi=mid;
  }
  if (lo>0 && Math.abs(buf[lo].t - t) > Math.abs(buf[lo-1].t - t)) return lo-1;
  return lo;
}

function updateChartBuffers(){
  for (const p of state.pages){
    for (const w of p.widgets){
      if (w.type!=='chart') continue;
      const buf=chartBuffers.get(w.id)||[];
      const t=performance.now()/1000;
      const raw=(w.opts.series||[]).map(sel=>readSelection(sel));
      let filtered=raw;
      const fc = w.opts.filterHz||0;
      if (fc>0){
        const RC = 1/(2*Math.PI*fc);
        const cf = chartFilters.get(w.id) || { _t: t };
        const dt = Math.max(1e-6, t - (cf._t||t));
        const alpha = dt/(RC+dt);
        filtered = raw.map((v,si)=>{
          const prev = (cf[si]===undefined)? v : cf[si];
          const y = prev + alpha*(v - prev);
          cf[si]=y; return y;
        });
        cf._t=t;
        chartFilters.set(w.id, cf);
      }
      buf.push({t, v: filtered});

      // KEY FIX: Use the chart's own span setting (with some buffer margin)
      const chartSpan = Math.max(1, w.opts.span || 10);
      const bufferDepth = chartSpan * 1.2; // Keep 20% extra for smooth scrolling

      // Remove old data beyond the buffer depth
      while (buf.length && (t - buf[0].t) > bufferDepth) {
        buf.shift();
      }
      chartBuffers.set(w.id,buf);
    }
  }
}

function labelFor(sel){
  if (!configCache) return `${sel.kind.toUpperCase()}${sel.index}`;
  try{
    if(sel.kind==='ai'){ return getAllAnalogs(configCache)?.[sel.index]?.name || `AI${sel.index}`; }
    if(sel.kind==='ao'){ return getAllAnalogOutputs(configCache)?.[sel.index]?.name || `AO${sel.index}`; }
    if(sel.kind==='do'){ return getAllDigitalOutputs(configCache)?.[sel.index]?.name || `DO${sel.index}`; }
    if(sel.kind==='tc'){ return getAllThermocouples(configCache)?.[sel.index]?.name || `TC${sel.index}`; }
    if(sel.kind==='pid'){ 
      // Fetch PID name from cache if available
      if (window.pidCache && window.pidCache.loops && window.pidCache.loops[sel.index]) {
        return window.pidCache.loops[sel.index].name || `PID${sel.index}`;
      }
      return `PID${sel.index}`;
    }
    if(sel.kind==='math'){
      if (window.mathCache && window.mathCache.operators && window.mathCache.operators[sel.index]) {
        return window.mathCache.operators[sel.index].name || `Math${sel.index}`;
      }
      return `Math${sel.index}`;
    }
    if(sel.kind==='expr'){
      if (window.exprCache && window.exprCache.expressions && window.exprCache.expressions[sel.index]) {
        return window.exprCache.expressions[sel.index].name || `Expr${sel.index}`;
      }
      return `Expr${sel.index}`;
    }
    if(sel.kind==='button'){
      // For button vars, sel.index is the variable name
      return `btn:${sel.index}`;
    }
  }catch{}
  return `${sel.kind.toUpperCase()}${sel.index}`;
}

/* ------------------------------- gauge ---------------------------------- */
function mountGauge(w, body){
  // Set default decimal places
  if (w.opts.decimals === undefined) w.opts.decimals = 3;
  
  // Add decimal places control
  const decimalsControl = el('div', {style: 'display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px'}, [
    el('label', {}, 'Decimals:'),
    el('input', {
      type: 'number',
      min: 0,
      max: 6,
      value: w.opts.decimals,
      style: 'width:50px;padding:2px 4px',
      oninput: (e) => {
        w.opts.decimals = parseInt(e.target.value) || 0;
        saveLayout();
      }
    })
  ]);
  body.append(decimalsControl);
  
  // Add Tare button if scaleOp is enabled
  if (w.opts.scaleOp) {
    const tareBtn = el('button', {
      className: 'btn',
      style: 'position:absolute;top:4px;left:50%;transform:translateX(-50%);font-size:11px;padding:4px 8px;z-index:10;background:#4a9eff;color:#0d1117',
      onclick: async () => {
        if (tareBtn.disabled) return; // Prevent double-click
        
        tareBtn.disabled = true;
        tareBtn.textContent = 'Taring...';
        
        try {
          // Collect samples for 2 seconds
          const samples = {};
          const needles = w.opts.needles || [];
          needles.forEach((needle, idx) => {
            samples[idx] = [];
          });
          
          const sampleInterval = setInterval(() => {
            needles.forEach((needle, idx) => {
              const v = readSelection(needle);
              if (Number.isFinite(v)) {
                samples[idx].push(v);
              }
            });
          }, 50); // Sample at 20 Hz
          
          // Wait 2 seconds
          await new Promise(resolve => setTimeout(resolve, 2000));
          clearInterval(sampleInterval);
          
          // Calculate averages and store as tare offsets
          w.opts.tareOffsets = {};
          needles.forEach((needle, idx) => {
            if (samples[idx].length > 0) {
              const avg = samples[idx].reduce((a, b) => a + b, 0) / samples[idx].length;
              w.opts.tareOffsets[idx] = -avg; // Negative to zero it out
              console.log(`[GAUGE] Needle ${idx} tared: avg=${avg.toFixed(3)}, offset=${w.opts.tareOffsets[idx].toFixed(3)}`);
            }
          });
          
          // Save layout to persist tare offsets
          saveLayout();
          
        } catch(e) {
          console.error('[GAUGE] Tare error:', e);
        } finally {
          // Always re-enable button
          tareBtn.disabled = false;
          tareBtn.textContent = 'Tare';
        }
      }
    }, 'Tare');
    body.append(tareBtn);
  }
  
  const legend=el('div',{className:'legend'}); body.append(legend);
  const canvas=el('canvas'); body.append(canvas);
  const ctx=canvas.getContext('2d');

  function draw(){
    const W=canvas.clientWidth, H=canvas.clientHeight;
    canvas.width=W; canvas.height=H;
    ctx.clearRect(0,0,W,H);

    // skip tiny first-frame sizes to avoid negative radii
    if (W < 40 || H < 40) { requestAnimationFrame(draw); return; }

    let lo=w.opts.min, hi=w.opts.max;
    if (w.opts.scale==='auto'){
      const vals=(w.opts.needles||[]).map((needle, idx) => {
        const v = readSelection(needle);
        const tareOffset = (w.opts.tareOffsets && w.opts.tareOffsets[idx]) || 0;
        const displayScale = needle.displayScale !== undefined ? needle.displayScale : 1.0;
        const displayOffset = needle.displayOffset !== undefined ? needle.displayOffset : 0.0;
        return ((v + tareOffset) * displayScale) + displayOffset;
      });
      lo=Math.min(...vals,0); hi=Math.max(...vals,1);
      if(lo===hi){ lo-=1; hi+=1; }
    }
    const span = (hi===lo)?1:(hi-lo);

    // geometry - ensure semicircle fits within canvas
    const cx=W/2;
    const padding = 12;
    // Outer radius must fit: top needs rOuter space, bottom needs rOuter space
    // cy is positioned so the semicircle's bottom edge doesn't exceed H
    let rOuter = Math.min((W - 2*padding)/2, H - padding - 20); // 20px for labels at top
    if (!Number.isFinite(rOuter) || rOuter < 8) { requestAnimationFrame(draw); return; }
    
    // Position cy so bottom of semicircle is just above widget bottom
    const cy = padding + rOuter; // Center is rOuter from top
    
    let band = Math.max(6, Math.round(rOuter * 0.18));
    if (band >= rOuter - 2) band = Math.max(6, Math.floor((rOuter - 2) * 0.6));
    let rInner = rOuter - band;
    if (rInner < 2) rInner = 2;

    // background rings / grid
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); if (safeArc(ctx, cx, cy, rOuter, Math.PI, 0)) ctx.stroke();
    ctx.beginPath(); if (safeArc(ctx, cx, cy, rInner, Math.PI, 0)) ctx.stroke();

    // secondary rings
    ctx.strokeStyle = (getComputedStyle(document.documentElement).getPropertyValue('--grid2')||'#1e2235').trim();
    for(let t=1;t<=4;t++){
      const rr=rOuter - t*8;
      if (rr <= 2) break;
      ctx.beginPath(); if (safeArc(ctx, cx, cy, rr, Math.PI, 0)) ctx.stroke();
    }

    // ticks + labels (upper semicircle; canvas Y is downward, so subtract sin)
    ctx.fillStyle='#a8b3cf'; ctx.font='12px system-ui';
    ctx.strokeStyle='#3b425e';
    const tickCount = w.opts.divisions !== undefined ? w.opts.divisions : 5;
    const tickLen=Math.max(3, Math.min(16, Math.floor(rOuter * 0.12)));
    for(let i=0;i<=tickCount;i++){
      const t = i / tickCount;
      const ang = Math.PI + (0 - Math.PI)*t; // map 0..1 -> π..0 (upper semicircle)
      const cos=Math.cos(ang), sin=Math.sin(ang);
      const r0 = Math.max(1, rInner - 2);
      const r1 = Math.max(1, r0 - tickLen);
      ctx.beginPath();
      ctx.moveTo(cx + r0*cos, cy - r0*sin);
      ctx.lineTo(cx + r1*cos, cy - r1*sin);
      ctx.stroke();

      const decimals = w.opts.decimals !== undefined ? w.opts.decimals : 3;
      const val=(lo + t*span).toFixed(decimals);
      ctx.textAlign='center';
      ctx.fillText(val, cx + (rInner - 30)*cos, cy - (rInner - 30)*sin + 4);
    }

    // title
    if (w.opts.title){
      ctx.fillStyle='rgba(255,255,255,0.9)';
      ctx.font='12px system-ui, sans-serif';
      ctx.textAlign='center';
      ctx.fillText(w.opts.title, cx, 14);
    }

    // legend + needles
    legend.innerHTML='';
    const needles = Array.isArray(w.opts.needles) ? w.opts.needles : [];
    ctx.lineWidth=3;
    needles.forEach((s,si)=>{
      const v = readSelection(s);
      const tareOffset = (w.opts.tareOffsets && w.opts.tareOffsets[si]) || 0;
      const displayScale = s.displayScale !== undefined ? s.displayScale : 1.0;
      const displayOffset = s.displayOffset !== undefined ? s.displayOffset : 0.0;
      const displayValue = ((v + tareOffset) * displayScale) + displayOffset;
      
      const frac = clamp((displayValue - lo)/span, 0, 1);
      const ang = Math.PI + (0 - Math.PI) * frac;
      const nx = Math.cos(ang), ny = Math.sin(ang);
      ctx.strokeStyle=colorFor(si);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + (rInner + band*0.9)*nx, cy - (rInner + band*0.9)*ny);
      ctx.stroke();

      const lab = s.name && s.name.length ? s.name : labelFor(s);
      const decimals = w.opts.decimals !== undefined ? w.opts.decimals : 3;
      legend.append(el('div',{className:'item'},[
        el('span',{className:'swatch', style:`background:${colorFor(si)}`},''), `${lab}: ${Number.isFinite(displayValue)?displayValue.toFixed(decimals):'—'}`
      ]));
    });

    ctx.restore();
    requestAnimationFrame(draw);
  }
  draw();
}

/* -------------------------------- bars ---------------------------------- */
/* ==================== ENHANCED BARS WITH GRID LABELS ==================== */
// Replace your mountBars function with this

function mountBars(w, body){
  const canvas = el('canvas'); body.append(canvas);
  const ctx = canvas.getContext('2d');

  w.opts.yGridLines = w.opts.yGridLines || 5; // Default 5 horizontal lines

  function draw(){
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W; canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    const plotL = 60, plotR = W - 10, plotT = 10, plotB = H - 30;
    ctx.strokeStyle = '#3b425e';
    ctx.lineWidth = 1;
    ctx.strokeRect(plotL, plotT, plotR - plotL, plotB - plotT);

    // Determine scale
    let lo = w.opts.min, hi = w.opts.max;
    if (w.opts.scale === 'auto') {
      const vals = (w.opts.series || []).map(s => {
        const v = readSelection(s);
        const displayScale = s.displayScale !== undefined ? s.displayScale : 1.0;
        const displayOffset = s.displayOffset !== undefined ? s.displayOffset : 0.0;
        return (v * displayScale) + displayOffset;
      });
      lo = Math.min(...vals, 0);
      hi = Math.max(...vals, 1);
      if (lo === hi) { lo -= 1; hi += 1; }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
      lo = 0; hi = 1;
    }
    const span = hi - lo || 1;

    // Y grid with labels
    const yGridLines = Math.max(2, Math.min(20, w.opts.yGridLines || 5));
    ctx.strokeStyle = (getComputedStyle(document.documentElement)
                       .getPropertyValue('--grid') || '#2a2f44').trim();
    ctx.lineWidth = 1;
    ctx.fillStyle='#7a8199';
    ctx.font='11px system-ui';
    ctx.textAlign='right';
    ctx.textBaseline='middle';

    for (let i = 0; i <= yGridLines; i++) {
      const frac = i / yGridLines;
      const y = plotB - frac * (plotB - plotT);
      const val = lo + frac * (hi - lo);

      // Draw horizontal line
      ctx.beginPath();
      ctx.moveTo(plotL, y);
      ctx.lineTo(plotR, y);
      ctx.stroke();

      // Draw value label on the left axis
      ctx.fillText(val.toFixed(2), plotL - 5, y);

      // Draw value label in the middle
      ctx.textAlign='center';
      ctx.fillStyle='rgba(122, 129, 153, 0.6)';
      ctx.fillText(val.toFixed(2), (plotL + plotR) / 2, y - 2);
      ctx.fillStyle='#7a8199';
      ctx.textAlign='right';
    }

    const series = w.opts.series || [];
    const N = Math.max(1, series.length);
    const barW = Math.max(5, (plotR - plotL) / N - 20); // Reduced width: min 5px, more spacing

    // Draw bars
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';

    series.forEach((sel, idx) => {
      const v = readSelection(sel);
      const displayScale = sel.displayScale !== undefined ? sel.displayScale : 1.0;
      const displayOffset = sel.displayOffset !== undefined ? sel.displayOffset : 0.0;
      const displayValue = (v * displayScale) + displayOffset;
      
      const t = Math.max(0, Math.min(1, (displayValue - lo) / span));
      const x = plotL + (idx + 0.5) * ((plotR - plotL) / N);
      const y = plotB - t * (plotB - plotT);
      const h = plotB - y;

      ctx.fillStyle = colorFor(idx);
      ctx.fillRect(x - barW / 2, y, barW, h);

      // Draw series label at bottom
      const label = sel.name || labelFor(sel);
      if (label) {
        ctx.fillStyle = '#a8b3cf';
        ctx.textAlign = 'center';
        ctx.fillText(label, x, plotB + 2);
      }

      // Draw value on top of bar
      if (Number.isFinite(displayValue)) {
        ctx.fillStyle = '#e6e6e6';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(displayValue.toFixed(2), x, y - 2);
        ctx.textBaseline = 'top';
      }
    });

    requestAnimationFrame(draw);
  }
  draw();
}

/* -------------------------------- DO ------------------------------------ */
function logicalActive(bit,activeHigh){ return activeHigh ? !!bit : !bit; }

function mountDOButton(w, body){
  const b=el('button',{className:'do-btn default'}, w.opts.title||'Button');
  body.append(b);

  let actTimer=null;
  let isDown = false;
  let buzzing = false;
  
  // Initialize variable state if using var mode
  if (w.opts.outputType === 'var' && !state.buttonVars) {
    state.buttonVars = {};
  }
  if (w.opts.outputType === 'var') {
    state.buttonVars[w.opts.varName] = state.buttonVars[w.opts.varName] || 0;
  }

  const clearActTimer=()=>{ if (actTimer){ clearTimeout(actTimer); actTimer=null; } };

  const setOutput = async(value)=>{
    if (w.opts.outputType === 'var') {
      // Set variable state
      if (!state.buttonVars) state.buttonVars = {};
      state.buttonVars[w.opts.varName] = value ? 1 : 0;
      
      // Sync to backend for expressions
      try {
        await fetch('/api/button_vars', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({vars: state.buttonVars})
        });
      } catch(e) { console.warn('ButtonVars sync failed', e); }
    } else {
      // Set DO hardware
      try{
        await fetch('/api/do/set',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({index:w.opts.doIndex, state:!!value, active_high:!!w.opts.activeHigh})
        });
      }catch(e){ console.warn('DO set failed', e); }
    }
  };

  const startBuzz = async()=>{
    if (w.opts.outputType === 'var') return; // Buzz only works with DO
    if (buzzing) return;
    buzzing=true;
    try{
      await fetch('/api/do/buzz/start',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({index:w.opts.doIndex, hz:w.opts.buzzHz||10, active_high:w.opts.activeHigh})
      });
      b.dataset.buzz='1';
    }catch(e){ console.warn('Buzz start failed', e); }
  };

  const stopBuzz = async()=>{
    if (w.opts.outputType === 'var') return; // Buzz only works with DO
    try{
      await fetch('/api/do/buzz/stop', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ index: w.opts.doIndex })
      });
    }catch(e){ console.warn('Buzz stop failed', e); }
    buzzing = false;
    b.dataset.buzz = '0';
  };

  // Toggle with optional actuationTime (auto-off)
  b.addEventListener('click', async ()=>{
    if(!connected) return;
    if(w.opts.mode!=='toggle') return;
    clearActTimer();
    
    // Get current state
    let bit;
    if (w.opts.outputType === 'var') {
      bit = state.buttonVars?.[w.opts.varName] || 0;
    } else {
      bit = state.do[w.opts.doIndex]|0;
    }
    
    const want=!bit;
    await setOutput(want);
    
    const ms = Math.max(0, (w.opts.actuationTime||0)*1000);
    if (ms>0){
      const original=bit;
      actTimer=setTimeout(()=>{ setOutput(original); }, ms);
    }
  });

  // Momentary & Buzz via pointer events
  const onDown = ()=>{
    if (!connected) return;
    if (isDown) return;
    isDown = true;
    if (w.opts.mode === 'momentary'){ clearActTimer(); setOutput(1); }
    if (w.opts.mode === 'buzz'){ stopBuzz().finally(startBuzz); }
  };

  const onUp = ()=>{
    if (!connected) return;
    if (!isDown) return;
    isDown = false;

    if (w.opts.mode === 'momentary'){ setOutput(0); }
    if (w.opts.mode === 'buzz'){
      stopBuzz().finally(()=>{
        setOutput(0).finally(()=>{ setTimeout(()=>stopBuzz(), 150); });
      });
    }
  };

  b.addEventListener('pointerdown', onDown);
  b.addEventListener('pointerup', onUp);
  b.addEventListener('pointerleave', onUp);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('blur', onUp);
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden) onUp(); });
  window.addEventListener('beforeunload', ()=>{ if (buzzing) { navigator.sendBeacon && navigator.sendBeacon('/api/do/buzz/stop', JSON.stringify({index:w.opts.doIndex})); } });

  updateDOButtons();
}

function updateDOButtons(){
  document.querySelectorAll('.do-btn').forEach(b=>{
    if(!connected||!hwReady){ b.className='do-btn default'; return; }
    const id=b.closest('.widget').id.slice(2);
    const page=state.pages[activePageIndex];
    const w=page.widgets.find(x=>x.id===id);
    if(!w){ b.className='do-btn default'; return; }
    
    let bit, active;
    if (w.opts.outputType === 'var') {
      // Variables: simple logic, 1 = active (green), 0 = inactive (red)
      bit = state.buttonVars?.[w.opts.varName] || 0;
      active = !!bit;  // 1 = true = active
    } else {
      // Hardware DOs: respect active-high setting for relay inversion
      bit = state.do[w.opts.doIndex]|0;
      active = logicalActive(bit, !!w.opts.activeHigh);
    }
    
    // Standard mapping: active=green, inactive=red
    b.className='do-btn '+(active?'active':'inactive');
    b.textContent = w.opts.title || 'Button';
  });
}

/* -------------------------------- PID ----------------------------------- */
function mountPIDPanel(w, body){
  const line=el('div',{
    className:'small', 
    id:'pid_'+w.id, 
    style:'display:inline-block;cursor:pointer',
    title:'Click to toggle PID details',
    onclick: () => {
      const detailsDiv = document.getElementById('pid_details_' + w.id);
      if (detailsDiv) {
        if (detailsDiv.style.display === 'none') {
          detailsDiv.style.display = 'block';
          // Position near the widget
          const widgetEl = document.getElementById('w_' + w.id);
          if (widgetEl) {
            const rect = widgetEl.getBoundingClientRect();
            detailsDiv.style.left = (rect.right + 10) + 'px';
            detailsDiv.style.top = rect.top + 'px';
          }
        } else {
          detailsDiv.style.display = 'none';
        }
      }
    }
  }, 'pv=—, err=—, out=—');
  
  // Create floating draggable details panel
  const detailsPanel = el('div', {
    id: 'pid_details_' + w.id,
    style: 'display:none;position:fixed;z-index:10000;padding:8px;background:#1a1d2e;border:2px solid #7aa2f7;border-radius:6px;font-family:monospace;font-size:11px;box-shadow:0 4px 12px rgba(0,0,0,0.5);min-width:200px'
  });
  
  // Add draggable header
  const header = el('div', {
    style: 'cursor:move;padding:4px;margin:-8px -8px 8px -8px;background:#2a3046;border-radius:4px 4px 0 0;font-weight:bold;color:#7aa2f7;display:flex;justify-content:space-between;align-items:center'
  });
  
  const headerTitle = el('span', {}, 'PID Details');
  const closeBtn = el('span', {
    style: 'cursor:pointer;padding:0 4px;color:#d84a4a;font-size:16px',
    onclick: () => {
      detailsPanel.style.display = 'none';
    }
  }, '×');
  
  header.append(headerTitle, closeBtn);
  
  const content = el('div', {id: 'pid_details_content_' + w.id});
  detailsPanel.append(header, content);
  
  // Make draggable
  let isDragging = false;
  let dragOffsetX = 0, dragOffsetY = 0;
  
  header.onmousedown = (e) => {
    isDragging = true;
    dragOffsetX = e.clientX - detailsPanel.offsetLeft;
    dragOffsetY = e.clientY - detailsPanel.offsetTop;
    e.preventDefault();
  };
  
  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      detailsPanel.style.left = (e.clientX - dragOffsetX) + 'px';
      detailsPanel.style.top = (e.clientY - dragOffsetY) + 'px';
    }
  });
  
  document.addEventListener('mouseup', () => {
    isDragging = false;
  });
  
  // Append to body (not to widget)
  document.body.append(detailsPanel);
  
  // Enable indicator container (will be populated if gating is configured)
  const enableContainer = el('div', {style:'display:inline-block;margin-left:8px;vertical-align:middle'});
  
  body.append(el('div', {style:'display:flex;align-items:center'}, [line, enableContainer]));

  // Fetch PID config to check if enable gate is configured
  let pidConfig = null;
  (async () => {
    try {
      const resp = await fetch('/api/pid');
      const data = await resp.json();
      pidConfig = data.loops?.[w.opts.loopIndex ?? 0];
    } catch(e) {
      console.warn('Failed to load PID config:', e);
    }
  })();

  if (w.opts.showControls){
    const ctr=el('div',{className:'compact'});
    const tbl=el('table',{className:'form'}); const tb=el('tbody');
    const row=(label,input)=>{ const tr=el('tr'); tr.append(el('th',{},label), el('td',{},input)); tb.append(tr); return tr; };
    const L={enabled:false,name:'',kind:'analog',src:'ai',ai_ch:0,out_ch:0,target:0,kp:0,ki:0,kd:0,out_min:0,out_max:1,out_min_source:'fixed',out_min_channel:0,out_max_source:'fixed',out_max_channel:0,err_min:-1,err_max:1,i_min:-1,i_max:1,enable_gate:false,enable_kind:'do',enable_index:0,sp_source:'fixed',sp_channel:0};

    fetch('/api/pid').then(r=>r.json()).then(async pid=>{
      const idx=w.opts.loopIndex|0; Object.assign(L, pid.loops?.[idx]||{});
      
      // Create async signal selectors
      let inputChSel = await createSignalSelector(L.src || 'ai', L.ai_ch || 0, newIdx => L.ai_ch = newIdx);
      let outputChSel = await createSignalSelector(L.kind === 'analog' ? 'ao' : 'do', L.out_ch || 0, newIdx => L.out_ch = newIdx);
      
      // Create SP channel selector (will be rebuilt when sp_source changes)
      let spChSel = (L.sp_source === 'ao' || L.sp_source === 'math' || L.sp_source === 'pid' || L.sp_source === 'expr' || L.sp_source === 'static') 
        ? await createSignalSelector(L.sp_source, L.sp_channel || 0, newIdx => L.sp_channel = newIdx)
        : num(L, 'sp_channel', 1);
      
      // Create out_min channel selector
      let outMinChSel = (L.out_min_source === 'math' || L.out_min_source === 'expr')
        ? await createSignalSelector(L.out_min_source, L.out_min_channel || 0, newIdx => L.out_min_channel = newIdx)
        : num(L, 'out_min_channel', 1);
      
      // Create out_max channel selector
      let outMaxChSel = (L.out_max_source === 'math' || L.out_max_source === 'expr')
        ? await createSignalSelector(L.out_max_source, L.out_max_channel || 0, newIdx => L.out_max_channel = newIdx)
        : num(L, 'out_max_channel', 1);
      
      // Function to update visibility (will be called after rows are created)
      let outputRow, spValueRow, spChRow, outMinValueRow, outMinChRow, outMaxValueRow, outMaxChRow;
      const updateVisibility = () => {
        if (outputRow) outputRow.style.display = (L.kind === 'var') ? 'none' : '';
        if (spValueRow) spValueRow.style.display = (L.sp_source === 'fixed') ? '' : 'none';
        if (spChRow) spChRow.style.display = (L.sp_source === 'fixed') ? 'none' : '';
        if (outMinValueRow) outMinValueRow.style.display = (L.out_min_source === 'fixed') ? '' : 'none';
        if (outMinChRow) outMinChRow.style.display = (L.out_min_source === 'fixed') ? 'none' : '';
        if (outMaxValueRow) outMaxValueRow.style.display = (L.out_max_source === 'fixed') ? '' : 'none';
        if (outMaxChRow) outMaxChRow.style.display = (L.out_max_source === 'fixed') ? 'none' : '';
      };
      
      const selKind = selectEnum(['analog','digital','var'], L.kind||'analog', async v => {
        L.kind = v;
        // Rebuild output selector when kind changes
        const newOutputSel = await createSignalSelector(v === 'analog' ? 'ao' : 'do', L.out_ch || 0, newIdx => L.out_ch = newIdx);
        outputChSel.replaceWith(newOutputSel);
        outputChSel = newOutputSel;
        updateVisibility();
      });
      
      const selSrc = selectEnum(['ai','ao','tc','pid','math','expr','static'], L.src ||'ai', async v => {
        L.src = v;
        // Rebuild input selector when source changes
        const newInputSel = await createSignalSelector(v, L.ai_ch || 0, newIdx => L.ai_ch = newIdx);
        inputChSel.replaceWith(newInputSel);
        inputChSel = newInputSel;
      });
      
      // Build form rows
      row('enabled', chk(L,'enabled'));
      row('name', txt(L,'name'));
      row('kind', selKind);
      row('src',  selSrc);
      row('input',  inputChSel);
      outputRow = row('output', outputChSel);
      spValueRow = row('SP Value', num(L,'target',0.0001));
      row('SP Src', selectEnum(['fixed','ao','pid','math','expr','static'], L.sp_source||'fixed', async v => {
        L.sp_source = v;
        // Rebuild SP channel selector when source changes
        const newSpChSel = (v === 'ao' || v === 'math' || v === 'pid' || v === 'expr')
          ? await createSignalSelector(v, L.sp_channel || 0, newIdx => L.sp_channel = newIdx)
          : num(L, 'sp_channel', 1);
        spChSel.replaceWith(newSpChSel);
        spChSel = newSpChSel;
        updateVisibility();
      }));
      spChRow = row('SP Ch', spChSel);
      
      row('kp',     num(L,'kp',0.0001));
      row('ki',     num(L,'ki',0.0001));
      row('kd',     num(L,'kd',0.0001));
      
      outMinValueRow = row('Out Min', num(L,'out_min',0.0001));
      row('Out Min Src', selectEnum(['fixed','math','expr'], L.out_min_source||'fixed', async v => {
        L.out_min_source = v;
        const newSel = (v === 'math' || v === 'expr')
          ? await createSignalSelector(v, L.out_min_channel || 0, newIdx => L.out_min_channel = newIdx)
          : num(L, 'out_min_channel', 1);
        outMinChSel.replaceWith(newSel);
        outMinChSel = newSel;
        updateVisibility();
      }));
      outMinChRow = row('Out Min Ch', outMinChSel);
      
      outMaxValueRow = row('Out Max', num(L,'out_max',0.0001));
      row('Out Max Src', selectEnum(['fixed','math','expr'], L.out_max_source||'fixed', async v => {
        L.out_max_source = v;
        const newSel = (v === 'math' || v === 'expr')
          ? await createSignalSelector(v, L.out_max_channel || 0, newIdx => L.out_max_channel = newIdx)
          : num(L, 'out_max_channel', 1);
        outMaxChSel.replaceWith(newSel);
        outMaxChSel = newSel;
        updateVisibility();
      }));
      outMaxChRow = row('Out Max Ch', outMaxChSel);
      
      updateVisibility(); // Set initial visibility AFTER all row variables are assigned
      
      row('err_min',num(L,'err_min',0.0001));
      row('err_max',num(L,'err_max',0.0001));
      row('i_min',  num(L,'i_min',0.0001));
      row('i_max',  num(L,'i_max',0.0001));
      // Enable gate fields removed - edit in main PID editor only
      tbl.append(tb);

      const save=el('button',{className:'btn',onclick:async()=>{
        const pid2=await (await fetch('/api/pid')).json();
        pid2.loops = pid2.loops||[];
        pid2.loops[w.opts.loopIndex|0] = L;
        await fetch('/api/pid',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(pid2)});
      }}, 'Apply');

      ctr.append(tbl, el('div',{style:'margin-top:6px'}, save));
    });

    body.append(ctr);
  }

  (function update(){
    const loop=state.pid[w.opts.loopIndex]||null;
    const p=$('#pid_'+w.id);
    if(loop&&p){ 
      p.textContent=`pv=${(loop.pv??0).toFixed(3)}, err=${(loop.err??0).toFixed(3)}, out=${(loop.out??0).toFixed(3)}`;
      
      // Update enable indicator if gating is configured
      if (pidConfig && pidConfig.enable_gate) {
        // Use gate_value from telemetry (more accurate, includes math/expr)
        const gateValue = loop.gate_value !== undefined ? loop.gate_value : 0.0;
        const enabled = gateValue >= 1.0;
        
        const statusText = gateValue.toFixed(1);
        const color = enabled ? '#2faa60' : '#d84a4a';
        const gated = loop.gated ? ' (GATED)' : '';
        
        enableContainer.innerHTML = `
          <div style="display:inline-block;text-align:center;padding:2px 4px;border:1px solid ${color};border-radius:3px;background:#1a1d2e;min-width:35px;vertical-align:middle">
            <div style="font-size:7px;color:#9aa1b9;line-height:1.1">EN</div>
            <div style="font-size:14px;font-weight:bold;line-height:1.1;color:${color}">${statusText}</div>
            <div style="font-size:6px;color:#7a7f8f;line-height:1.1">${pidConfig.enable_kind.toUpperCase()}${pidConfig.enable_index}</div>
          </div>
        `;
      } else {
        enableContainer.innerHTML = '';
      }
      
      // Update details panel content if visible
      const detailsDiv = document.getElementById('pid_details_' + w.id);
      const contentDiv = document.getElementById('pid_details_content_' + w.id);
      if (detailsDiv && contentDiv && detailsDiv.style.display !== 'none') {
        contentDiv.innerHTML = `
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:2px;font-size:10px">PV:</td><td style="padding:2px;text-align:right;font-weight:bold">${(loop.pv??0).toFixed(4)}</td></tr>
            <tr style="background:#0d1117"><td style="padding:2px;font-size:10px">SP:</td><td style="padding:2px;text-align:right">${(loop.target??0).toFixed(4)}</td></tr>
            <tr><td style="padding:2px;font-size:10px;color:#ff9e64">Error:</td><td style="padding:2px;text-align:right;color:#ff9e64;font-weight:bold">${(loop.err??0).toFixed(4)}</td></tr>
            <tr style="background:#0d1117"><td style="padding:2px;font-size:10px">P:</td><td style="padding:2px;text-align:right">${(loop.p_term??0).toFixed(4)}</td></tr>
            <tr><td style="padding:2px;font-size:10px">I:</td><td style="padding:2px;text-align:right">${(loop.i_term??0).toFixed(4)}</td></tr>
            <tr style="background:#0d1117"><td style="padding:2px;font-size:10px">D:</td><td style="padding:2px;text-align:right">${(loop.d_term??0).toFixed(4)}</td></tr>
            <tr><td style="padding:2px;font-size:10px;color:#7aa2f7">u:</td><td style="padding:2px;text-align:right;color:#7aa2f7;font-weight:bold">${(loop.u??0).toFixed(4)}</td></tr>
            <tr style="background:#0d1117"><td style="padding:2px;font-size:10px;color:#2faa60">Out:</td><td style="padding:2px;text-align:right;color:#2faa60;font-weight:bold">${(loop.out??0).toFixed(4)}</td></tr>
          </table>
        `;
      }
    }
    requestAnimationFrame(update);
  })();
}

function selectEnum(options, value, onChange){
  const s=el('select',{}); options.forEach(opt=>s.append(el('option',{value:opt},opt)));
  s.value=value; s.onchange=()=>onChange(s.value); return s;
}
function txt(o,k){ const i=el('input',{type:'text',value:o[k]??''}); i.oninput=()=>o[k]=i.value; return i; }
function num(o,k,step){ const i=el('input',{type:'number',step:step??'any',value:o[k]??0}); i.oninput=()=>o[k]=parseFloat(i.value)||0; return i; }
function chk(o,k){ const i=el('input',{type:'checkbox',checked:!!o[k]}); i.onchange=()=>o[k]=!!i.checked; return i; }

/* -------------------------------- AO ------------------------------------ */
function mountAOSlider(w, body){
  const step=w.opts.step ?? 0.0025;
  const cur=el('input',{type:'number', min:w.opts.min, max:w.opts.max, step:step, value:state.ao[w.opts.aoIndex]||0, style:'width:90px'});
  const rng=el('input',{type:'range',  min:w.opts.min, max:w.opts.max, step:step, value:state.ao[w.opts.aoIndex]||0, style:'width:100%'});
  
  // Enable indicator (if gating is enabled in config)
  let enableBox = null;
  let aoConfig = null;
  
  // Fetch AO config to check if enable gate is active
  (async () => {
    try {
      const resp = await fetch('/api/config');
      const cfg = await resp.json();
      aoConfig = cfg.analogOutputs?.[w.opts.aoIndex];
      
      // If enable gate is configured, show enable indicator
      if (aoConfig && aoConfig.enable_gate) {
        enableBox = el('div', {
          style: 'display:inline-block;text-align:center;padding:3px;border:2px solid #2a3046;border-radius:3px;background:#1a1d2e;min-width:50px;vertical-align:middle;margin-left:8px'
        });
        const row = body.querySelector('.row');
        if (row) row.appendChild(enableBox);
      }
    } catch(e) {
      console.warn('Failed to load AO config:', e);
    }
  })();
  
  const send=async(v)=>{
    try{
      await fetch('/api/ao/set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:w.opts.aoIndex, volts:parseFloat(v)})});
    }catch(e){ console.warn('AO set failed', e); }
  };
  rng.oninput=()=>{ cur.value=rng.value; if (w.opts.live) send(rng.value); };
  cur.onchange=()=>{ rng.value=cur.value; send(cur.value); };
  
  const row = el('div',{className:'row'},[rng,cur]);
  body.append(row);
  
  // Update enable indicator
  (function updateEnable() {
    if (enableBox && aoConfig) {
      let enabled = false;
      
      if (aoConfig.enable_kind === 'do') {
        enabled = state.do?.[aoConfig.enable_index] ? true : false;
      } else if (aoConfig.enable_kind === 'le') {
        enabled = state.le?.[aoConfig.enable_index]?.output ? true : false;
      }
      
      const statusText = enabled ? '1' : '0';
      const color = enabled ? '#2faa60' : '#d84a4a';
      
      enableBox.innerHTML = `
        <div style="font-size:8px;color:#9aa1b9;line-height:1.2">ENABLE</div>
        <div style="font-size:18px;font-weight:bold;line-height:1.2;color:${color}">${statusText}</div>
        <div style="font-size:7px;color:#7a7f8f;line-height:1.2">${aoConfig.enable_kind.toUpperCase()}${aoConfig.enable_index}</div>
      `;
      enableBox.style.borderColor = color;
    }
    
    requestAnimationFrame(updateEnable);
  })();
}

/* -------------------------------- Motor Controller ------------------------------------ */
function mountMotorController(w, body){
  const status=el('div',{className:'small', id:'motor_'+w.id}, 'Input: —, RPM Cmd: —, Status: —');
  body.append(status);

  // Track current motor config for enable state
  let currentConfig = null;
  
  const refreshConfig = async () => {
    try {
      const data = await (await fetch('/api/motors')).json();
      const motors = data.motors || [];
      currentConfig = motors[w.opts.motorIndex];
    } catch(e) {
      console.warn('Failed to refresh motor config:', e);
    }
  };
  
  refreshConfig(); // Initial load

  if (w.opts.showControls){
    const ctr=el('div',{className:'compact'});
    
    // Fetch current motor config
    let motorConfig = null;
    fetch('/api/motors').then(r=>r.json()).then(data=>{
      const motors = data.motors || [];
      motorConfig = motors[w.opts.motorIndex];
      if (!motorConfig) return;
      
      // Build editable config table
      const tbl=el('table',{className:'form'}); 
      const tb=el('tbody');
      const row=(label,input)=>{ 
        const tr=el('tr'); 
        tr.append(el('th',{},label), el('td',{},input)); 
        tb.append(tr); 
      };
      
      row('Min RPM', num(motorConfig,'min_rpm',1));
      row('Max RPM', num(motorConfig,'max_rpm',1));
      row('Scale', num(motorConfig,'scale_factor',0.1));
      row('Offset', num(motorConfig,'offset',0.1));
      
      const saveConfigBtn = el('button',{className:'btn', onclick:async()=>{
        try {
          // Update the specific motor in the array
          const fullData = await (await fetch('/api/motors')).json();
          fullData.motors[w.opts.motorIndex] = motorConfig;
          await fetch('/api/motors',{
            method:'PUT',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify(fullData)
          });
          alert('Motor config saved');
          await refreshConfig(); // Refresh after save
        } catch(e) { 
          console.warn('Motor config save failed', e);
          alert('Save failed: ' + e.message);
        }
      }}, 'Save Config');
      
      tbl.append(tb);
      ctr.append(tbl, el('div',{style:'margin:6px 0'}, saveConfigBtn));
    });
    
    // Manual control section
    const manualRPM = el('input',{type:'number', value:0, step:10, style:'width:100px'});
    const setBtn = el('button',{className:'btn', onclick:async()=>{
      try {
        const response = await fetch(`/api/motors/${w.opts.motorIndex}/rpm`, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({rpm: parseFloat(manualRPM.value)||0})
        });
        if (!response.ok) {
          const text = await response.text();
          console.error('Motor set RPM failed:', text);
        }
      } catch(e) { 
        console.warn('Motor set failed', e); 
      }
    }}, 'Set RPM');
    
    const enableBtn = el('button',{className:'btn', onclick:async()=>{
      try {
        const response = await fetch(`/api/motors/${w.opts.motorIndex}/enable`, {
          method:'POST',
          headers:{'Content-Type':'application/json'}
        });
        if (!response.ok) {
          const text = await response.text();
          console.error('Motor enable failed:', text);
        } else {
          const result = await response.json();
          console.log('Motor enable response:', result);
          await refreshConfig(); // Refresh config after enable
        }
      } catch(e) { 
        console.warn('Motor enable failed', e); 
      }
    }}, 'Enable');
    
    const disableBtn = el('button',{className:'btn danger', onclick:async()=>{
      try {
        const response = await fetch(`/api/motors/${w.opts.motorIndex}/disable`, {
          method:'POST',
          headers:{'Content-Type':'application/json'}
        });
        if (!response.ok) {
          const text = await response.text();
          console.error('Motor disable failed:', text);
        } else {
          const result = await response.json();
          console.log('Motor disable response:', result);
          await refreshConfig(); // Refresh config after disable
        }
      } catch(e) { 
        console.warn('Motor disable failed', e); 
      }
    }}, 'Disable');
    
    ctr.append(
      el('hr',{className:'soft'}),
      el('div',{style:'margin:6px 0'}, [
        el('label',{},'Manual RPM: '),
        manualRPM,
        setBtn
      ]),
      el('div',{style:'margin:6px 0;display:flex;gap:6px'}, [enableBtn, disableBtn])
    );
    body.append(ctr);
  }

  (function update(){
    if (state.motors && state.motors[w.opts.motorIndex]) {
      const motor = state.motors[w.opts.motorIndex];
      const p=$('#motor_'+w.id);
      if(p){
        const enabledText = currentConfig ? (currentConfig.enabled ? 'EN' : 'DIS') : '?';
        p.textContent=`Input: ${(motor.input??0).toFixed(3)}, RPM: ${(motor.rpm_cmd??0).toFixed(1)}, ${enabledText}, ${motor.success?'OK':'ERR'}`;
      }
    }
    requestAnimationFrame(update);
  })();
}

/* ------------------------ LE Widget ---------------------------- */
function mountLEWidget(w, body){
  body.style.padding = '4px';
  body.style.fontSize = '10px';
  body.style.fontFamily = 'monospace';
  
  let leConfig = null;
  
  // Fetch LE configuration
  (async () => {
    try {
      const resp = await fetch('/api/logic_elements');
      const data = await resp.json();
      leConfig = data.elements?.[w.opts.leIndex ?? 0];
      
      // Update widget title with LE name
      if (leConfig && leConfig.name) {
        const titleEl = document.querySelector(`#w_${w.id} .title`);
        if (titleEl) {
          titleEl.textContent = leConfig.name;
        }
      }
    } catch(e) {
      console.error('Failed to load LE config:', e);
    }
  })();
  
  (function update(){
    const idx = w.opts.leIndex ?? 0;
    const le = state.le?.[idx];
    
    if (!leConfig) {
      body.innerHTML = `<div style="text-align:center;color:var(--muted);padding:20px;font-size:11px">LE${idx}<br>Loading...</div>`;
      setTimeout(update, 100);
      return;
    }
    
    if (!le) {
      body.innerHTML = `<div style="text-align:center;color:var(--muted);padding:20px;font-size:11px">LE${idx}<br>Waiting for data...<br><small style="font-size:9px">Check server logs</small></div>`;
      setTimeout(update, 500);
      return;
    }

    // Process Input A
    const getInputInfo = (inputCfg) => {
      if (!inputCfg) return {label: '?', val: '?', detail: ''};
      
      const kind = inputCfg.kind || 'do';
      const ch = inputCfg.index || 0;
      let val = '?';
      let detail = '';
      
      if (kind === 'do') {
        const raw = state.do?.[ch] ?? 0;
        val = raw ? '1' : '0';
        return {label: `DO${ch}`, val, detail};
      }
      else if (kind === 'le') {
        const raw = state.le?.[ch]?.output ?? false;
        val = raw ? '1' : '0';
        return {label: `LE${ch}`, val, detail};
      }
      else if (kind === 'ai') {
        const rawVal = state.ai?.[ch] ?? 0;
        const comp = inputCfg.comparison || 'gt';
        let compVal = 0;
        
        if (inputCfg.compare_to_type === 'signal') {
          const cKind = inputCfg.compare_to_kind || 'ai';
          const cCh = inputCfg.compare_to_index || 0;
          if (cKind === 'ai') compVal = state.ai?.[cCh] ?? 0;
          else if (cKind === 'ao') compVal = state.ao?.[cCh] ?? 0;
          else if (cKind === 'tc') compVal = state.tc?.[cCh] ?? 0;
          else if (cKind === 'pid_u') compVal = state.pid?.[cCh]?.u ?? 0;
          else if (cKind === 'math') compVal = state.math?.[cCh]?.output ?? 0;
        } else {
          compVal = inputCfg.compare_value ?? 0;
        }
        
        let result = false;
        if (comp === 'lt') result = rawVal < compVal;
        else if (comp === 'eq') result = Math.abs(rawVal - compVal) < 0.001;
        else result = rawVal > compVal;
        
        val = result ? '1' : '0';
        const compSym = comp === 'lt' ? '<' : (comp === 'eq' ? '=' : '>');
        detail = `${rawVal.toFixed(1)}${compSym}${compVal.toFixed(1)}`;
        return {label: `AI${ch}`, val, detail};
      }
      else if (kind === 'ao') {
        const rawVal = state.ao?.[ch] ?? 0;
        const comp = inputCfg.comparison || 'gt';
        let compVal = 0;
        
        if (inputCfg.compare_to_type === 'signal') {
          const cKind = inputCfg.compare_to_kind || 'ai';
          const cCh = inputCfg.compare_to_index || 0;
          if (cKind === 'ai') compVal = state.ai?.[cCh] ?? 0;
          else if (cKind === 'ao') compVal = state.ao?.[cCh] ?? 0;
          else if (cKind === 'tc') compVal = state.tc?.[cCh] ?? 0;
          else if (cKind === 'pid_u') compVal = state.pid?.[cCh]?.u ?? 0;
          else if (cKind === 'math') compVal = state.math?.[cCh]?.output ?? 0;
        } else {
          compVal = inputCfg.compare_value ?? 0;
        }
        
        let result = false;
        if (comp === 'lt') result = rawVal < compVal;
        else if (comp === 'eq') result = Math.abs(rawVal - compVal) < 0.001;
        else result = rawVal > compVal;
        
        val = result ? '1' : '0';
        const compSym = comp === 'lt' ? '<' : (comp === 'eq' ? '=' : '>');
        detail = `${rawVal.toFixed(1)}${compSym}${compVal.toFixed(1)}`;
        return {label: `AO${ch}`, val, detail};
      }
      else if (kind === 'tc') {
        const rawVal = state.tc?.[ch];
        
        // Check for null/undefined/NaN (missing TC)
        if (rawVal === null || rawVal === undefined || !Number.isFinite(rawVal)) {
          return {label: `TC${ch}`, val: 'X', detail: 'not detected', isInvalid: true};
        }
        
        const comp = inputCfg.comparison || 'gt';
        let compVal = 0;
        
        if (inputCfg.compare_to_type === 'signal') {
          const cKind = inputCfg.compare_to_kind || 'ai';
          const cCh = inputCfg.compare_to_index || 0;
          if (cKind === 'ai') compVal = state.ai?.[cCh] ?? 0;
          else if (cKind === 'ao') compVal = state.ao?.[cCh] ?? 0;
          else if (cKind === 'tc') compVal = state.tc?.[cCh] ?? 0;
          else if (cKind === 'pid_u') compVal = state.pid?.[cCh]?.u ?? 0;
          else if (cKind === 'math') compVal = state.math?.[cCh]?.output ?? 0;
        } else {
          compVal = inputCfg.compare_value ?? 0;
        }
        
        let result = false;
        if (comp === 'lt') result = rawVal < compVal;
        else if (comp === 'eq') result = Math.abs(rawVal - compVal) < 0.001;
        else result = rawVal > compVal;
        
        val = result ? '1' : '0';
        const compSym = comp === 'lt' ? '<' : (comp === 'eq' ? '=' : '>');
        detail = `${rawVal.toFixed(1)}${compSym}${compVal.toFixed(1)}`;
        return {label: `TC${ch}`, val, detail};
      }
      else if (kind === 'pid_u') {
        const rawVal = state.pid?.[ch]?.u ?? 0;
        const comp = inputCfg.comparison || 'gt';
        let compVal = 0;
        
        if (inputCfg.compare_to_type === 'signal') {
          const cKind = inputCfg.compare_to_kind || 'ai';
          const cCh = inputCfg.compare_to_index || 0;
          if (cKind === 'ai') compVal = state.ai?.[cCh] ?? 0;
          else if (cKind === 'ao') compVal = state.ao?.[cCh] ?? 0;
          else if (cKind === 'tc') compVal = state.tc?.[cCh] ?? 0;
          else if (cKind === 'pid_u') compVal = state.pid?.[cCh]?.u ?? 0;
          else if (cKind === 'math') compVal = state.math?.[cCh]?.output ?? 0;
        } else {
          compVal = inputCfg.compare_value ?? 0;
        }
        
        let result = false;
        if (comp === 'lt') result = rawVal < compVal;
        else if (comp === 'eq') result = Math.abs(rawVal - compVal) < 0.001;
        else result = rawVal > compVal;
        
        val = result ? '1' : '0';
        const compSym = comp === 'lt' ? '<' : (comp === 'eq' ? '=' : '>');
        detail = `${rawVal.toFixed(1)}${compSym}${compVal.toFixed(1)}`;
        return {label: `PID${ch}`, val, detail};
      }
      else if (kind === 'math') {
        const rawVal = state.math?.[ch]?.output ?? 0;
        
        // Check if there's a comparison configured
        if (inputCfg.comparison) {
          const comp = inputCfg.comparison;
          let compVal = 0;
          
          if (inputCfg.compare_to_type === 'signal') {
            const cKind = inputCfg.compare_to_kind || 'ai';
            const cCh = inputCfg.compare_to_index || 0;
            if (cKind === 'ai') compVal = state.ai?.[cCh] ?? 0;
            else if (cKind === 'ao') compVal = state.ao?.[cCh] ?? 0;
            else if (cKind === 'tc') compVal = state.tc?.[cCh] ?? 0;
            else if (cKind === 'pid_u') compVal = state.pid?.[cCh]?.u ?? 0;
            else if (cKind === 'math') compVal = state.math?.[cCh]?.output ?? 0;
          } else {
            compVal = inputCfg.compare_value ?? 0;
          }
          
          let result = false;
          if (comp === 'lt') result = rawVal < compVal;
          else if (comp === 'eq') result = Math.abs(rawVal - compVal) < 0.001;
          else result = rawVal > compVal;
          
          val = result ? '1' : '0';
          const compSym = comp === 'lt' ? '<' : (comp === 'eq' ? '=' : '>');
          detail = `${rawVal.toFixed(1)}${compSym}${compVal.toFixed(1)}`;
          return {label: `Math${ch}`, val, detail};
        } else {
          // No comparison - just use the value as boolean (non-zero = 1)
          val = rawVal !== 0 ? '1' : '0';
          detail = rawVal.toFixed(2);
          return {label: `Math${ch}`, val, detail};
        }
      }
      else if (kind === 'expr') {
        // Expression output
        const exprData = state.expr?.[ch];
        const rawVal = exprData?.output ?? (typeof exprData === 'number' ? exprData : 0);
        
        // Check if there's a comparison configured
        if (inputCfg.comparison) {
          const comp = inputCfg.comparison;
          let compVal = 0;
          
          if (inputCfg.compare_to_type === 'signal') {
            const cKind = inputCfg.compare_to_kind || 'ai';
            const cCh = inputCfg.compare_to_index || 0;
            if (cKind === 'ai') compVal = state.ai?.[cCh] ?? 0;
            else if (cKind === 'ao') compVal = state.ao?.[cCh] ?? 0;
            else if (cKind === 'tc') compVal = state.tc?.[cCh] ?? 0;
            else if (cKind === 'pid_u') compVal = state.pid?.[cCh]?.u ?? 0;
            else if (cKind === 'math') compVal = state.math?.[cCh]?.output ?? 0;
            else if (cKind === 'expr') compVal = state.expr?.[cCh]?.output ?? 0;
          } else {
            compVal = inputCfg.compare_value ?? 0;
          }
          
          let result = false;
          if (comp === 'lt') result = rawVal < compVal;
          else if (comp === 'eq') result = Math.abs(rawVal - compVal) < 0.001;
          else result = rawVal > compVal;
          
          val = result ? '1' : '0';
          const compSym = comp === 'lt' ? '<' : (comp === 'eq' ? '=' : '>');
          detail = `${rawVal.toFixed(1)}${compSym}${compVal.toFixed(1)}`;
          return {label: `Expr${ch}`, val, detail};
        } else {
          // No comparison - use >= 1.0 as boolean
          val = rawVal >= 1.0 ? '1' : '0';
          detail = rawVal.toFixed(2);
          return {label: `Expr${ch}`, val, detail};
        }
      }
      
      return {label: '?', val: '?', detail: ''};
    };
    
    // For now, always use input_a/input_b (inputs array has wrong defaults from Pydantic)
    const inputA = leConfig.input_a;
    const inputB = leConfig.input_b;
    
    const inA = getInputInfo(inputA);
    const inB = getInputInfo(inputB);
    const output = le.output ? '1' : '0';
    const op = (leConfig.operation || 'and').toUpperCase();
    
    // Helper to get color for input value
    const getInputColor = (inp) => {
      if (inp.val === 'X') return '#ff9e64'; // Orange for invalid
      return inp.val === '1' ? '#2faa60' : '#d84a4a';
    };
    
    // Compact 5-box layout: [A][OP][B][=][OUT] - using flex for scaling
    body.innerHTML = `
      <div style="display:flex;gap:2px;justify-content:center;align-items:center;height:100%;padding:2px">
        <div style="text-align:center;padding:3px;border:1px solid ${inA.val==='X'?'#ff9e64':'#2a3046'};border-radius:3px;background:#1a1d2e;flex:1;min-width:0;overflow:hidden">
          <div style="font-size:8px;color:#79c0ff;line-height:1.2">${inA.label}</div>
          <div style="font-size:20px;font-weight:bold;line-height:1.2;color:${getInputColor(inA)}">${inA.val}</div>
          ${inA.detail ? `<div style="font-size:7px;color:#7a7f8f;line-height:1.2;margin-top:1px">${inA.detail}</div>` : ''}
        </div>
        <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;flex:0 0 35px;overflow:hidden">
          <div style="font-size:11px;font-weight:bold;color:#e0af68;line-height:1.4">${op}</div>
        </div>
        <div style="text-align:center;padding:3px;border:1px solid ${inB.val==='X'?'#ff9e64':'#2a3046'};border-radius:3px;background:#1a1d2e;flex:1;min-width:0;overflow:hidden">
          <div style="font-size:8px;color:#79c0ff;line-height:1.2">${inB.label}</div>
          <div style="font-size:20px;font-weight:bold;line-height:1.2;color:${getInputColor(inB)}">${inB.val}</div>
          ${inB.detail ? `<div style="font-size:7px;color:#7a7f8f;line-height:1.2;margin-top:1px">${inB.detail}</div>` : ''}
        </div>
        <div style="text-align:center;padding:3px;flex:0 0 15px">
          <div style="font-size:14px;color:#9aa1b9;line-height:1.4">=</div>
        </div>
        <div style="text-align:center;padding:3px;border:2px solid ${output==='1'?'#2faa60':'#d84a4a'};border-radius:3px;background:#1a1d2e;flex:1;min-width:0;overflow:hidden">
          <div style="font-size:8px;color:#9aa1b9;line-height:1.2">OUT</div>
          <div style="font-size:22px;font-weight:bold;line-height:1.2;color:${output==='1'?'#2faa60':'#d84a4a'}">${output}</div>
        </div>
      </div>
    `;
    
    requestAnimationFrame(update);
  })();
}

function mountMathOpWidget(w, body){
  body.style.padding = '4px';
  body.style.fontSize = '10px';
  body.style.fontFamily = 'monospace';
  
  let mathConfig = null;
  
  // Fetch math operator configuration once on mount
  (async () => {
    try {
      const resp = await fetch('/api/math_operators');
      const data = await resp.json();
      mathConfig = data.operators?.[w.opts.mathIndex ?? 0];
      
      // Update widget title with op name
      if (mathConfig && mathConfig.name) {
        const titleEl = document.querySelector(`#w_${w.id} .title`);
        if (titleEl) {
          titleEl.textContent = mathConfig.name;
        }
      }
    } catch(e) {
      console.error('Failed to load math op config:', e);
    }
  })();
  
  (function update(){
    const idx = w.opts.mathIndex ?? 0;
    const mathOp = state.math?.[idx];
    
    if (!mathConfig) {
      body.innerHTML = `<div style="text-align:center;color:var(--muted);padding:20px;font-size:11px">Math${idx}<br>Loading config...</div>`;
      setTimeout(update, 100);
      return;
    }
    
    // Check if state.math exists at all
    if (!state.math) {
      body.innerHTML = `<div style="text-align:center;color:#ff9e64;padding:20px;font-size:11px">Math system not initialized<br><span style="font-size:9px">Create operators in Math editor</span></div>`;
      setTimeout(update, 1000);
      return;
    }
    
    // Check if this specific operator exists
    if (!mathOp) {
      body.innerHTML = `<div style="text-align:center;color:#ff9e64;padding:20px;font-size:11px">Math${idx} not found<br><span style="font-size:9px">${state.math.length} operators configured</span></div>`;
      setTimeout(update, 1000);
      return;
    }

    // Get operation symbol/name
    const opSymbols = {
      'add': '+', 'sub': '−', 'mul': '×', 'div': '÷',
      'mod': 'mod', 'pow': '^', 'min': 'min', 'max': 'max',
      'sqr': 'x²', 'sqrt': '√', 'log10': 'log₁₀', 'ln': 'ln',
      'exp': 'exp', 'sin': 'sin', 'cos': 'cos', 'tan': 'tan',
      'asin': 'asin', 'acos': 'acos', 'atan': 'atan', 'atan2': 'atan2',
      'abs': '|x|', 'neg': '−x', 'filter': '🔽'
    };
    const opDisplay = opSymbols[mathConfig.operation] || mathConfig.operation;
    
    // Check if binary or unary
    const isBinary = mathOp.input_b !== null && mathOp.input_b !== undefined;
    
    // Format values
    const valA = Number.isFinite(mathOp.input_a) ? mathOp.input_a.toFixed(3) : '---';
    const valB = isBinary && Number.isFinite(mathOp.input_b) ? mathOp.input_b.toFixed(3) : null;
    const output = Number.isFinite(mathOp.output) ? mathOp.output.toFixed(3) : '---';
    
    // Get input labels
    const getLabel = (inp) => {
      if (!inp) return '?';
      const k = inp.kind || 'ai';
      const i = inp.index || 0;
      if (k === 'ai') return `AI${i}`;
      if (k === 'ao') return `AO${i}`;
      if (k === 'tc') return `TC${i}`;
      if (k === 'pid_u') return `PID${i}`;
      if (k === 'math') return `M${i}`;
      return '?';
    };
    
    const labelA = getLabel(mathConfig.input_a);
    const labelB = isBinary ? getLabel(mathConfig.input_b) : null;
    
    if (w.opts.showInputs) {
      // Show detailed layout with inputs
      if (isBinary) {
        // Binary: [A] [OP] [B] = [OUT]
        body.innerHTML = `
          <div style="display:flex;gap:2px;justify-content:center;align-items:center;height:100%;padding:2px">
            <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;flex:1;min-width:0;overflow:hidden">
              <div style="font-size:7px;color:#79c0ff;line-height:1.2">${labelA}</div>
              <div style="font-size:14px;font-weight:bold;line-height:1.2;color:#9aa1b9">${valA}</div>
            </div>
            <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;flex:0 0 35px;overflow:hidden">
              <div style="font-size:14px;font-weight:bold;color:#e0af68;line-height:1.4">${opDisplay}</div>
            </div>
            <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;flex:1;min-width:0;overflow:hidden">
              <div style="font-size:7px;color:#79c0ff;line-height:1.2">${labelB}</div>
              <div style="font-size:14px;font-weight:bold;line-height:1.2;color:#9aa1b9">${valB}</div>
            </div>
            <div style="text-align:center;padding:3px;flex:0 0 15px">
              <div style="font-size:14px;color:#9aa1b9;line-height:1.4">=</div>
            </div>
            <div style="text-align:center;padding:3px;border:2px solid #7aa2f7;border-radius:3px;background:#1a1d2e;flex:1;min-width:0;overflow:hidden">
              <div style="font-size:7px;color:#9aa1b9;line-height:1.2">OUT</div>
              <div style="font-size:16px;font-weight:bold;line-height:1.2;color:#7aa2f7">${output}</div>
            </div>
          </div>
        `;
      } else {
        // Unary: [OP]([A]) = [OUT]
        // Special layout for filter operation
        if (mathConfig.operation === 'filter') {
          const rawVal = mathOp.raw_value !== undefined ? mathOp.raw_value.toFixed(3) : valA;
          const filterHz = mathOp.filter_hz || 1.0;
          body.innerHTML = `
            <div style="display:flex;gap:2px;justify-content:center;align-items:center;height:100%;padding:2px">
              <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;flex:1;min-width:0;overflow:hidden">
                <div style="font-size:7px;color:#79c0ff;line-height:1.2">${labelA}</div>
                <div style="font-size:14px;font-weight:bold;line-height:1.2;color:#9aa1b9">${rawVal}</div>
                <div style="font-size:6px;color:#7a7f8f;line-height:1.2;margin-top:1px">${filterHz}Hz</div>
              </div>
              <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;flex:0 0 35px;overflow:hidden">
                <div style="font-size:12px;font-weight:bold;color:#e0af68;line-height:1.4">${opDisplay}</div>
              </div>
              <div style="text-align:center;padding:3px;border:2px solid #7aa2f7;border-radius:3px;background:#1a1d2e;flex:1;min-width:0;overflow:hidden">
                <div style="font-size:7px;color:#9aa1b9;line-height:1.2">FILT</div>
                <div style="font-size:16px;font-weight:bold;line-height:1.2;color:#7aa2f7">${output}</div>
              </div>
            </div>
          `;
        } else {
          // Standard unary: [OP]([A]) = [OUT]
          body.innerHTML = `
            <div style="display:flex;gap:2px;justify-content:center;align-items:center;height:100%;padding:2px">
              <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;flex:0 0 45px;overflow:hidden">
                <div style="font-size:12px;font-weight:bold;color:#e0af68;line-height:1.4">${opDisplay}</div>
              </div>
              <div style="text-align:center;padding:2px;flex:0 0 10px">
                <div style="font-size:16px;color:#7a7f8f;line-height:1.4">(</div>
              </div>
              <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;flex:1;min-width:0;overflow:hidden">
                <div style="font-size:7px;color:#79c0ff;line-height:1.2">${labelA}</div>
                <div style="font-size:14px;font-weight:bold;line-height:1.2;color:#9aa1b9">${valA}</div>
              </div>
              <div style="text-align:center;padding:2px;flex:0 0 10px">
                <div style="font-size:16px;color:#7a7f8f;line-height:1.4">)</div>
              </div>
              <div style="text-align:center;padding:2px;flex:0 0 15px">
                <div style="font-size:14px;color:#9aa1b9;line-height:1.4">=</div>
              </div>
              <div style="text-align:center;padding:3px;border:2px solid #7aa2f7;border-radius:3px;background:#1a1d2e;flex:1;min-width:0;overflow:hidden">
                <div style="font-size:7px;color:#9aa1b9;line-height:1.2">OUT</div>
                <div style="font-size:16px;font-weight:bold;line-height:1.2;color:#7aa2f7">${output}</div>
              </div>
            </div>
          `;
        }
      }
    } else {
      // Compact: just show output
      body.innerHTML = `
        <div style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100%;gap:2px">
          <div style="font-size:9px;color:#9aa1b9">${opDisplay}</div>
          <div style="font-size:22px;font-weight:bold;color:#7aa2f7">${output}</div>
          <div style="font-size:8px;color:#7a7f8f">${mathConfig.name || 'Math'}</div>
        </div>
      `;
    }
    
    requestAnimationFrame(update);
  })();
}

/* ------------------------ Expression Widget ---------------------------- */
function mountExprWidget(w, body){
  body.style.padding = '8px';
  body.style.fontSize = '12px';
  body.style.fontFamily = 'Consolas, Monaco, Courier New, monospace';
  
  (function update(){
    const idx = w.opts.exprIndex ?? 0;
    const showSource = w.opts.showSource !== false;
    const showOutput = w.opts.showOutput !== false;
    
    // Clear body
    body.innerHTML = '';
    
    // Debug logging
    
    if (!state.expr || !Array.isArray(state.expr) || state.expr.length === 0) {
      body.append(el('div', {
        className:'expr-error',
        textContent: 'Expression system not initialized'
      }));
      setTimeout(update, 1000);
      return;
    }
    
    const exprData = state.expr[idx];
    
    // Debug logging for exprData
    
    // Check if data is a number (initial state) vs object (real telemetry)
    if (typeof exprData === 'number') {
      body.append(el('div', {
        className:'expr-error',
        textContent: 'Waiting for expression data...'
      }));
      setTimeout(update, 1000);
      return;
    }
    
    if (!exprData) {
      body.append(el('div', {
        className:'expr-error',
        textContent: `Expression ${idx} not found`
      }));
      setTimeout(update, 1000);
      return;
    }
    
    if (!exprData.enabled) {
      body.append(el('div', {
        className:'expr-disabled',
        textContent: 'Expression disabled'
      }));
      setTimeout(update, 1000);
      return;
    }
    
    if (exprData.error) {
      const errorDiv = el('div', {className:'expr-error'});
      errorDiv.append(
        el('div', {style:'font-weight:600;margin-bottom:4px'}, '⚠️ Error'),
        el('div', {style:'font-size:11px'}, exprData.error)
      );
      body.append(errorDiv);
      setTimeout(update, 1000);
      return;
    }
    
    // Display variables
    if (showSource && exprData.locals) {
      
      const varsDiv = el('div', {className:'expr-vars'});
      
      const locals = exprData.locals || {};
      for (const [name, value] of Object.entries(locals)) {

        const varRow = el('div', {className:'expr-var-row'});
        varRow.append(
          el('span', {className:'expr-var-name'}, name),
          el('span', {className:'expr-var-eq'}, ' = '),
          el('span', {
            className:'expr-var-value',
            style: `color: ${getValueColor(value)}`
          }, formatValue(value))
        );
        varsDiv.append(varRow);
      }
      
      body.append(varsDiv);
    }
    
    // Display hardware writes
    const hwWrites = exprData.hw_writes || [];
    if (hwWrites.length > 0) {
      const hwDiv = el('div', {className:'expr-hw-writes'});
      hwDiv.append(el('div', {className:'expr-section-label'}, '⚡ Hardware Writes'));
      
      for (const hw of hwWrites) {
        const hwRow = el('div', {className:'expr-hw-row'});
        hwRow.append(
          el('span', {className:'expr-hw-type'}, hw.type.toUpperCase()),
          el('span', {className:'expr-hw-ch'}, `[${hw.channel}]`),
          el('span', {className:'expr-hw-eq'}, ' ← '),
          el('span', {
            className:'expr-hw-value',
            style: hw.type === 'do' 
              ? `color:${hw.value ? '#2faa60' : '#d84a4a'}` 
              : `color: ${getValueColor(hw.value)}`
          }, hw.type === 'do' ? (hw.value ? 'ON' : 'OFF') : formatValue(hw.value))
        );
        hwDiv.append(hwRow);
      }
      
      body.append(hwDiv);
    }
    
    // Show output
    if (showOutput) {
      const outputDiv = el('div', {className:'expr-output'});
      outputDiv.append(
        el('span', {className:'expr-output-label'}, '► Output: '),
        el('span', {
          className:'expr-output-value',
          style: `color: ${getValueColor(exprData.output)};font-weight:700;font-size:16px`
        }, formatValue(exprData.output))
      );
      body.append(outputDiv);
    }
    
    requestAnimationFrame(update);
  })();
}

/* ------------------------ tick / read / drag ---------------------------- */
function onTick(){
  if (replayMode !== null) {
    // In replay mode, only update charts during playback
    if (replayMode === 'playing') {
      updateChartBuffers();
    }
    // Don't update gauges/bars here - they're controlled by seekReplay
  } else {
    // Live mode - update everything normally
    updateChartBuffers();
    updateDOButtons();
  }
}

function readSelection(sel){
  if(!sel) return 0;
  switch(sel.kind){
    case 'ai': return state.ai[sel.index|0]??0;
    case 'ao': return state.ao[sel.index|0]??0;
    case 'do': return (state.do[sel.index|0]?1:0);
    case 'tc': return state.tc[sel.index|0]??0;
    case 'pid': 
      const pidLoop = state.pid[sel.index|0];
      return pidLoop ? (pidLoop.out ?? 0) : 0;
    case 'math':
      const mathOp = state.math?.[sel.index|0];
      return mathOp ? (mathOp.output ?? 0) : 0;
    case 'expr':
      const expr = state.expr?.[sel.index|0];
      return expr ? (expr.output ?? 0) : 0;
    case 'button':
      // For button vars, sel.index is the variable name (string)
      return state.buttonVars?.[sel.index] ?? 0;
  }
  return 0;
}

// drag/resize — block drag when interacting with inputs
function makeDragResize(node, w, header, handle){
  let dragging=false,resizing=false,sx=0,sy=0,ox=0,oy=0,ow=0,oh=0;
  
  // Set minimum sizes based on widget type
  let minW = 280;
  if (w.type === 'dobutton') minW = 70;
  else if (w.type === 'bars') minW = 100;  // Allow narrow bar graphs
  else if (w.type === 'le' || w.type === 'mathop') minW = 140;  // 50% of default 280
  else if (w.type === 'pidpanel') minW = 168;  // 60% of default 280
  
  let minH = 180;
  if (w.type === 'dobutton') minH = 45;
  else if (w.type === 'le' || w.type === 'mathop') minH = 10;  // Half of default 20
  
  header.addEventListener('mousedown', (e)=>{
    const tag=(e.target.tagName||'').toUpperCase();
    // Allow clicking on icon spans (settings/close buttons)
    if (e.target.classList && e.target.classList.contains('icon')) return;
    if (['INPUT','SELECT','BUTTON','TEXTAREA','LABEL','OPTION'].includes(tag)) return;
    dragging=true; ox=w.x; oy=w.y; sx=e.clientX; sy=e.clientY; e.preventDefault();
  });
  handle.addEventListener('mousedown', (e)=>{ resizing=true; ow=w.w; oh=w.h; sx=e.clientX; sy=e.clientY; e.preventDefault(); });
  window.addEventListener('mousemove',(e)=>{
    if(dragging){ w.x=ox+(e.clientX-sx); w.y=oy+(e.clientY-sy); node.style.left=w.x+'px'; node.style.top=w.y+'px'; }
    if(resizing){ w.w=Math.max(minW,ow+(e.clientX-sx)); w.h=Math.max(minH,oh+(e.clientY-sy)); node.style.width=w.w+'px'; node.style.height=w.h+'px'; }
  });
  window.addEventListener('mouseup',()=>{ dragging=false; resizing=false; });
}

function normalizeLayoutPages(pages){
  const norm = (w) => {
    w.opts = w.opts || {};
    switch (w.type) {
      case 'chart':
        w.opts.title      = w.opts.title ?? 'Chart';
        w.opts.series     = Array.isArray(w.opts.series) ? w.opts.series : [];
        w.opts.span       = Number.isFinite(w.opts.span) ? w.opts.span : 10;
        w.opts.scale      = w.opts.scale ?? 'auto';
        w.opts.min        = Number.isFinite(w.opts.min) ? w.opts.min : 0;
        w.opts.max        = Number.isFinite(w.opts.max) ? w.opts.max : 10;
        w.opts.filterHz   = Number.isFinite(w.opts.filterHz) ? w.opts.filterHz : 0;
        w.opts.cursorMode = w.opts.cursorMode ?? 'follow';
        break;
      case 'gauge':
        w.opts.title  = w.opts.title ?? 'Gauge';
        w.opts.needles= Array.isArray(w.opts.needles) ? w.opts.needles : [];
        w.opts.scale  = w.opts.scale ?? 'manual';
        w.opts.min    = Number.isFinite(w.opts.min) ? w.opts.min : 0;
        w.opts.max    = Number.isFinite(w.opts.max) ? w.opts.max : 10;
        break;
      case 'bars':
        w.opts.title  = w.opts.title ?? 'Bars';
        w.opts.scale  = w.opts.scale ?? 'auto';
        w.opts.min    = Number.isFinite(w.opts.min) ? w.opts.min : 0;
        w.opts.max    = Number.isFinite(w.opts.max) ? w.opts.max : 10;
        break;
      case 'dobutton':
        w.opts.title     = w.opts.title ?? 'Button';
        w.opts.outputType= w.opts.outputType ?? 'do';
        w.opts.doIndex   = Number.isInteger(w.opts.doIndex) ? w.opts.doIndex : 0;
        w.opts.varName   = w.opts.varName || 'button1';
        w.opts.activeHigh= (w.opts.activeHigh !== false);
        w.opts.mode      = w.opts.mode ?? 'momentary';
        w.opts.actuationTime = Number.isFinite(w.opts.actuationTime) ? w.opts.actuationTime : 0;
        break;
      case 'aoslider':
        w.opts.title   = w.opts.title ?? 'AO';
        w.opts.aoIndex = Number.isInteger(w.opts.aoIndex) ? w.opts.aoIndex : 0;
        w.opts.minV    = Number.isFinite(w.opts.minV) ? w.opts.minV : 0;
        w.opts.maxV    = Number.isFinite(w.opts.maxV) ? w.opts.maxV : 10;
        break;
      case 'pidpanel':
        w.opts.title = w.opts.title ?? 'PID';
        // leave other PID fields as-is; panel reads current config
        break;
      case 'motor':
        w.opts.title = w.opts.title ?? 'Motor';
        w.opts.motorIndex = Number.isInteger(w.opts.motorIndex) ? w.opts.motorIndex : 0;
        w.opts.showControls = (w.opts.showControls !== false);
        break;
      case 'le':
        w.opts.title = w.opts.title ?? 'Logic Element';
        w.opts.leIndex = Number.isInteger(w.opts.leIndex) ? w.opts.leIndex : 0;
        w.opts.showInputs = (w.opts.showInputs !== false);
        break;
      case 'mathop':
        w.opts.title = w.opts.title ?? 'Math';
        w.opts.mathIndex = Number.isInteger(w.opts.mathIndex) ? w.opts.mathIndex : 0;
        w.opts.showInputs = (w.opts.showInputs !== false);
        break;
    }
    // ensure position/size exist so renderPage doesn’t choke
    w.x = Number.isFinite(w.x) ? w.x : 40;
    w.y = Number.isFinite(w.y) ? w.y : 40;
    w.w = Number.isFinite(w.w) ? w.w : 460;
    w.h = Number.isFinite(w.h) ? w.h : 280;
    return w;
  };
  return pages.map(p => ({
    name: p.name || '',
    widgets: Array.isArray(p.widgets) ? p.widgets.map(norm) : []
  }));
}

/* -------------------------- modal / editors ----------------------------- */
function showModal(content, onClose){
  const m=$('#modal'); m.classList.remove('hidden'); m.innerHTML='';
  const panel=el('div',{className:'panel'});
  const closeBtn=el('button',{className:'btn',onclick:()=>{ closeModal(onClose); }},'Close');
  const close=el('div',{style:'text-align:right;margin-bottom:8px;'}, closeBtn);
  panel.append(close,content); m.append(panel);
}

function closeModal(onClose){
  const m=$('#modal'); 
  m.classList.add('hidden'); 
  if (typeof onClose==='function') onClose();
}
function openJsonEditor(title,url){
  fetch(url).then(r=>r.json()).then(obj=>{
    const ta=el('textarea',{style:'width:100%;height:60vh'}, JSON.stringify(obj,null,2));
    const save=el('button',{className:'btn',onclick:async()=>{
      try{ await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:ta.value}); alert('Saved'); }
      catch(e){ alert('Save failed: '+e.message); }
    }},'Save');
    showModal(el('div',{},[el('h2',{},title), ta, el('div',{style:'margin-top:8px'},save)]), ()=>{ renderPage(); });
  }).catch(()=>{
    const ta=el('textarea',{style:'width:100%;height:60vh'}, '// Paste your script JSON here');
    const save=el('button',{className:'btn',onclick:()=>alert('No /api/script endpoint; server needs implementing.')},'Save');
    showModal(el('div',{},[el('h2',{},title), ta, el('div',{style:'margin-top:8px'},save)]));
  });
}


/* ==================== EDITORS WITH LOAD FROM FILE ==================== */
// Replace your openConfigForm, openPidForm, and openScriptEditor functions

async function openConfigForm(providedConfig = null, banner = null){
  let cfg;
  if (providedConfig) {    cfg = providedConfig;
  } else {    cfg = await (await fetch('/api/config')).json();
  }
  console.log('[CONFIG-DEBUG] Using config:', {
    boards1608: cfg.boards1608 || cfg.board1608,
    boardsetc: cfg.boardsetc || cfg.boardetc,
    analogCount: (cfg.analogs || []).length,
    doCount: (cfg.digitalOutputs || []).length
  });
  configCache = cfg;
  const root=el('div',{});
  
  // Add banner if provided (from Load button)
  if (banner) {
    root.append(banner);
  }

  // Add Load from File button
  const loadBtn = createLoadButton((loaded, filename) => {    console.log('[CONFIG-DEBUG] Loaded data:', {
      boards1608: loaded.boards1608 || loaded.board1608,
      boardsetc: loaded.boardsetc || loaded.boardetc,
      analogCount: (loaded.analogs || []).length,
      doCount: (loaded.digitalOutputs || []).length
    });
    closeModal();    
    // Show banner with Apply button
    const applyBanner = el('div', {
      style: 'background:#3a5a1a;border:2px solid #4a9eff;border-radius:6px;padding:12px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between'
    });
    
    const msg = el('div', {}, [
      el('strong', {style: 'color:#4a9eff'}, `📁 Loaded: ${filename}`),
      el('div', {style: 'font-size:12px;margin-top:4px;color:#ccc'}, 
        'Config loaded from file. Will be applied when you close this window. You can edit first if needed.')
    ]);
    
    applyBanner.append(msg);
    
    openConfigForm(loaded, applyBanner); // Pass banner to show at top
  });

  // Support both single-board (old) and array (new) formats
  // Determine which format we're using
  const usingSingleBoards = (cfg.board1608 && !Array.isArray(cfg.board1608));
  
  // If using single boards, ensure they exist
  if (usingSingleBoards) {
    if (!cfg.board1608) cfg.board1608 = {boardNum: 0, sampleRateHz: 100, blockSize: 128, enabled: true};
    if (!cfg.boardetc) cfg.boardetc = {boardNum: 1, sampleRateHz: 10, blockSize: 1, enabled: true};
    // Only set enabled=true if field is completely missing (not if it's false!)
    // This preserves the user's choice to disable a board
    if (!('enabled' in cfg.board1608)) cfg.board1608.enabled = true;
    if (!('enabled' in cfg.boardetc)) cfg.boardetc.enabled = true;
  } else {
    // Using array format
    if (!cfg.boards1608) cfg.boards1608 = [{boardNum: 0, sampleRateHz: 100, blockSize: 128, enabled: true}];
    if (!cfg.boardsetc) cfg.boardsetc = [{boardNum: 1, sampleRateHz: 10, blockSize: 1, enabled: true}];
  }
  
  const boardsContainer = el('div', {});
  
  function renderBoards() {
    boardsContainer.innerHTML = '';
    
    if (usingSingleBoards) {
      // OLD FORMAT: Single board objects
      const b1608Card = el('div', {style: 'border:1px solid #2a3046;border-radius:6px;padding:12px;margin:8px 0;background:#1a2030'});
      b1608Card.append(
        el('strong', {style: 'display:block;margin-bottom:8px'}, 'E-1608 Board (AI/DO/AO)'),
        tableForm([
          ['Enabled',      inputChk(cfg.board1608,'enabled')],
          ['Board Number', inputNum(cfg.board1608,'boardNum',0)],
          ['Sample Rate (Hz)', inputNum(cfg.board1608,'sampleRateHz',1)],
          ['Block Size',   inputNum(cfg.board1608,'blockSize',1)]
        ])
      );
      
      const btcCard = el('div', {style: 'border:1px solid #2a3046;border-radius:6px;padding:12px;margin:8px 0;background:#1a2030'});
      btcCard.append(
        el('strong', {style: 'display:block;margin-bottom:8px'}, 'E-TC Board (Thermocouples)'),
        tableForm([
          ['Enabled',      inputChk(cfg.boardetc,'enabled')],
          ['Board Number', inputNum(cfg.boardetc,'boardNum',0)],
          ['Sample Rate (Hz)', inputNum(cfg.boardetc,'sampleRateHz',1)],
          ['Block Size',   inputNum(cfg.boardetc,'blockSize',1)]
        ])
      );
      
      const enableMultiBtn = el('button', {
        className: 'btn',
        style: 'margin-top:12px',
        onclick: () => {
          if (confirm('Convert to multiple boards format? This will allow adding more boards. Your current boards will be preserved.')) {
            // Convert single boards to arrays
            cfg.boards1608 = [cfg.board1608];
            cfg.boardsetc = [cfg.boardetc];
            delete cfg.board1608;
            delete cfg.boardetc;
            // Reload the form
            closeModal();
            openConfigForm(cfg);
          }
        }
      }, '🔧 Enable Multiple Boards (Advanced)');
      
      boardsContainer.append(
        el('p', {style: 'font-size:12px;color:var(--muted);margin-bottom:12px'}, 
          'Using single-board format (one E-1608, one E-TC). Click below to enable multiple boards.'),
        b1608Card,
        btcCard,
        enableMultiBtn
      );
      return;
    }
    
    // NEW FORMAT: Array of boards
    // E-1608 Boards
    const b1608Title = el('h4', {style: 'margin:12px 0 8px 0'}, 'E-1608 Boards (AI/DO/AO)');
    const b1608Add = el('button', {
      className: 'btn',
      onclick: () => {
        const boardIdx = cfg.boards1608.length;
        
        // Create arrays for channels
        const analogs = [];
        const digitalOutputs = [];
        const analogOutputs = [];
        
        // Add 8 AI channels
        for (let i = 0; i < 8; i++) {
          analogs.push({
            name: `AI${i}`,
            slope: 1.0,
            offset: 0.0,
            cutoffHz: 0.1,
            units: 'V',
            include: true
          });
        }
        
        // Add 8 DO channels
        for (let i = 0; i < 8; i++) {
          digitalOutputs.push({
            name: `DO${i}`,
            mode: 'toggle',
            normallyOpen: true,
            actuationTime: 0.1,
            include: true
          });
        }
        
        // Add 2 AO channels
        for (let i = 0; i < 2; i++) {
          analogOutputs.push({
            name: `AO${i}`,
            minV: 0.0,
            maxV: 10.0,
            startupV: 0.0,
            enable_gate: false,
            enable_kind: 'do',
            enable_index: 0,
            include: true
          });
        }
        
        // Add the board with its channels
        cfg.boards1608.push({
          boardNum: boardIdx,
          sampleRateHz: 100,
          blockSize: 128,
          enabled: true,
          analogs: analogs,
          digitalOutputs: digitalOutputs,
          analogOutputs: analogOutputs
        });
        
        console.log(`[CONFIG] Added E-1608 board #${boardIdx} with 8 AI, 8 DO, 2 AO`);
        alert(`Added E-1608 board #${boardIdx}\n+8 AI (AI0-AI7)\n+8 DO (DO0-DO7)\n+2 AO (AO0-AO1)`);
        
        renderBoards();
      }
    }, '+ Add E-1608');
    
    const b1608List = el('div', {});
    cfg.boards1608.forEach((board, idx) => {
      const card = el('div', {style: 'border:1px solid #2a3046;border-radius:6px;padding:12px;margin:8px 0;background:#1a2030'});
      const cardTitle = el('div', {style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px'});
      cardTitle.append(
        el('strong', {}, `E-1608 #${idx}`),
        el('button', {
          className: 'btn danger',
          style: 'font-size:11px;padding:4px 8px',
          onclick: () => {
            if (confirm(`Remove E-1608 board #${board.boardNum}?\n\nThis will remove the board and all its channels!`)) {
              cfg.boards1608.splice(idx, 1);
              console.log(`[CONFIG] Removed E-1608 board #${board.boardNum}`);
              renderBoards();
            }
          }
        }, '✕ Remove')
      );
      
      const fields = tableForm([
        ['Enabled',      inputChk(board,'enabled')],
        ['Board Number', inputNum(board,'boardNum',0)],
        ['Sample Rate (Hz)', inputNum(board,'sampleRateHz',1)],
        ['Block Size',   inputNum(board,'blockSize',1)]
      ]);
      
      card.append(cardTitle, fields);
      b1608List.append(card);
    });
    
    // E-TC Boards
    const btcTitle = el('h4', {style: 'margin:20px 0 8px 0'}, 'E-TC Boards (Thermocouples)');
    const btcAdd = el('button', {
      className: 'btn',
      onclick: () => {
        const boardIdx = cfg.boardsetc.length;
        
        // Create array for TC channels
        const thermocouples = [];
        
        // Add 8 TC channels
        for (let i = 0; i < 8; i++) {
          thermocouples.push({
            name: `TC${i}`,
            ch: i,
            type: 'K',
            offset: 0.0,
            cutoffHz: 0.1,
            include: true
          });
        }
        
        // Add the board with its channels
        cfg.boardsetc.push({
          boardNum: boardIdx,
          sampleRateHz: 10,
          blockSize: 1,
          enabled: true,
          thermocouples: thermocouples
        });
        
        console.log(`[CONFIG] Added E-TC board #${boardIdx} with 8 TC channels`);
        alert(`Added E-TC board #${boardIdx}\n+8 TC channels (TC0-TC7)`);
        
        renderBoards();
      }
    }, '+ Add E-TC');
    
    const btcList = el('div', {});
    cfg.boardsetc.forEach((board, idx) => {
      const card = el('div', {style: 'border:1px solid #2a3046;border-radius:6px;padding:12px;margin:8px 0;background:#1a2030'});
      const cardTitle = el('div', {style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px'});
      cardTitle.append(
        el('strong', {}, `E-TC #${idx}`),
        el('button', {
          className: 'btn danger',
          style: 'font-size:11px;padding:4px 8px',
          onclick: () => {
            if (confirm(`Remove E-TC board #${board.boardNum}?\n\nThis will remove the board and all its channels!`)) {
              cfg.boardsetc.splice(idx, 1);
              console.log(`[CONFIG] Removed E-TC board #${board.boardNum}`);
              renderBoards();
            }
          }
        }, '✕ Remove')
      );
      
      const fields = tableForm([
        ['Enabled',      inputChk(board,'enabled')],
        ['Board Number', inputNum(board,'boardNum',0)],
        ['Sample Rate (Hz)', inputNum(board,'sampleRateHz',1)],
        ['Block Size',   inputNum(board,'blockSize',1)]
      ]);
      
      card.append(cardTitle, fields);
      btcList.append(card);
    });
    
    boardsContainer.append(
      b1608Title,
      el('div', {style: 'margin-bottom:8px'}, b1608Add),
      b1608List,
      btcTitle,
      el('div', {style: 'margin-bottom:8px'}, btcAdd),
      btcList
    );
  }
  
  renderBoards();
  
  const boards=fieldset('Hardware Boards', el('div', {}, [
    el('p', {style: 'font-size:12px;color:var(--muted);margin-bottom:12px'}, 
      'Add multiple E-1608 and E-TC boards as needed. Each board requires a unique board number.'),
    boardsContainer
  ]));

  // Build analog sections per board
  const analogSections = [];
  if (cfg.boards1608) {
    cfg.boards1608.forEach((board, boardIdx) => {
      const analogRows = (board.analogs||[]).map((a,i)=>[
        `AI${i}`, inputText(a,'name'),
        `slope`,      inputNum(a,'slope',0.000001),
        `offset`,     inputNum(a,'offset',0.000001),
        `cutoffHz`,   inputNum(a,'cutoffHz',0.1),
        `units`,      inputText(a,'units'),
        `include`,    inputChk(a,'include')
      ]);
      if (analogRows.length > 0) {
        analogSections.push(fieldset(`Analogs - Board #${board.boardNum} (Y = m·X + b)`, tableFormRows(analogRows)));
      }
    });
  }
  const analogs = analogSections.length > 0 ? el('div', {}, analogSections) : el('div', {}, 'No analog channels configured');

  const DO_MODES=['toggle','momentary','buzz'];
  const doSections = [];
  if (cfg.boards1608) {
    cfg.boards1608.forEach((board, boardIdx) => {
      (board.digitalOutputs||[]).forEach(d=>{ if(!d.mode){ d.mode = d.momentary ? 'momentary' : 'toggle'; } });
      const doRows = (board.digitalOutputs||[]).map((d,i)=>[
        `DO${i}`, inputText(d,'name'),
        `mode`,        selectEnum(DO_MODES,d.mode||'toggle',v=>{ d.mode=v; d.momentary = (v==='momentary'); }),
        `normallyOpen`,inputChk(d,'normallyOpen'),
        `actuationTime (s)`, inputNum(d,'actuationTime',0.1),
        `include`,     inputChk(d,'include')
      ]);
      if (doRows.length > 0) {
        doSections.push(fieldset(`Digital Outputs - Board #${board.boardNum}`, tableFormRows(doRows)));
      }
    });
  }
  const dig = doSections.length > 0 ? el('div', {}, doSections) : el('div', {}, 'No digital outputs');

  const aoSections = [];
  if (cfg.boards1608) {
    cfg.boards1608.forEach((board, boardIdx) => {
      const aoRows = (board.analogOutputs||[]).map((a,i)=>[
        `AO${i}`, inputText(a,'name'),
        `minV`,        inputNum(a,'minV',0.001),
        `maxV`,        inputNum(a,'maxV',0.001),
        `startupV`,    inputNum(a,'startupV',0.001),
        `enable gate`, inputChk(a,'enable_gate'),
        `gate type`,   selectEnum(['do','le','math','expr'], a.enable_kind||'do', v=>a.enable_kind=v),
        `gate index`,  inputNum(a,'enable_index',1),
        `include`,     inputChk(a,'include')
      ]);
      if (aoRows.length > 0) {
        aoSections.push(fieldset(`Analog Outputs (0-10V) - Board #${board.boardNum}`, tableFormRows(aoRows)));
      }
    });
  }
  const aos = aoSections.length > 0 ? el('div', {}, aoSections) : el('div', {}, 'No analog outputs');

  const tcSections = [];
  if (cfg.boardsetc) {
    cfg.boardsetc.forEach((board, boardIdx) => {
      const tcRows = (board.thermocouples||[]).map((t,i)=>[
        `TC${i}`, inputText(t,'name'),
        `include`, inputChk(t,'include'),
        `ch`,             inputNum(t,'ch',1),
        `type`,           selectEnum(['K','J','T','E','R','S','B','N','C'], t.type||'K', v=>t.type=v),
        `offset`,         inputNum(t,'offset',0.001),
        `cutoffHz`,       inputNum(t,'cutoffHz',0.1)
      ]);
      if (tcRows.length > 0) {
        tcSections.push(fieldset(`Thermocouples - Board #${board.boardNum}`, tableFormRows(tcRows)));
      }
    });
  }
  const tcs = tcSections.length > 0 ? el('div', {}, tcSections) : el('div', {}, 'No thermocouples');

  const save=el('button',{className:'btn',onclick:async()=>{
    try{ await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)}); alert('Saved'); }
    catch(e){ alert('Save failed: '+e.message); }
  }},'Save');
  
  const saveAs = createSaveAsButton(() => cfg, 'config.json');

  root.append(
    el('div', {style: 'display:flex;gap:8px;margin-bottom:12px'}, [loadBtn]),
    boards,analogs,dig,aos,tcs,
    el('div',{style:'display:flex;gap:8px;margin-top:8px'}, [save, saveAs])
  );
  
  // If config was loaded from file (has banner), auto-apply on close
  const onClose = async () => {
    if (banner && providedConfig) {      try {
        await fetch('/api/config', {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(providedConfig)
        });      } catch(e) {
        console.error('[CONFIG-DEBUG] Failed to apply loaded config:', e);
      }
    }
    renderPage();
  };
  
  showModal(root, onClose);
}

async function openPidForm(){
  const pid=await (await fetch('/api/pid')).json();
  const loops = pid.loops || [];
  
  // Ensure all loops have enable_gate defaults
  loops.forEach(L => {
    if (L.enable_gate === undefined) L.enable_gate = false;
    if (L.enable_kind === undefined) L.enable_kind = 'do';
    if (L.enable_index === undefined) L.enable_index = 0;
  });

  const root = el('div', {});
  const title = el('h2', {}, 'PID Loops');

  // Add Load from File button
  const loadBtn = createLoadButton((loaded, filename) => {
    Object.assign(pid, loaded);
    closeModal();
    openPidForm(); // Re-open with loaded data
  });

  // Add Loop button
  const addBtn = el('button', {
    className: 'btn',
    onclick: () => {
      loops.push({
        enabled: false,
        kind: 'analog',
        src: 'ai',
        ai_ch: 0,
        out_ch: 0,
        target: 0.0,
        sp_source: 'fixed',
        sp_channel: 0,
        kp: 1.0,
        ki: 0.0,
        kd: 0.0,
        out_min: -10.0,
        out_max: 10.0,
        out_min_source: 'fixed',
        out_min_channel: 0,
        out_max_source: 'fixed',
        out_max_channel: 0,
        err_min: null,
        err_max: null,
        i_min: null,
        i_max: null,
        name: `Loop${loops.length}`,
        enable_gate: false,
        enable_kind: 'do',
        enable_index: 0,
        execution_rate_hz: null  // null = sample rate
      });
      // Rebuild the form
      buildForm();
    }
  }, '+ Add Loop');

  const formContainer = el('div', {});

  const buildForm = async () => {
    formContainer.innerHTML = '';
    
    const table = el('table', {className:'form', style:'table-layout:auto'});
    const thead = el('thead');
    thead.append(el('tr', {}, [
      el('th', {}, '#'),
      el('th', {}, 'Enabled'),
      el('th', {}, 'Name'),
      el('th', {}, 'Kind'),
      el('th', {}, 'Src'),
      el('th', {}, 'AI Ch'),
      el('th', {}, 'Out Ch'),
      el('th', {}, 'Set Point'),  // Changed from Target
      el('th', {}, 'SP Src'),     // New: SP source selector
      el('th', {}, 'SP Ch'),      // New: SP channel
      el('th', {}, 'Kp'),
      el('th', {}, 'Ki'),
      el('th', {}, 'Kd'),
      el('th', {}, 'Out Min'),
      el('th', {}, 'Out Max'),
      el('th', {}, 'Err Min'),
      el('th', {}, 'Err Max'),
      el('th', {}, 'I Min'),
      el('th', {}, 'I Max'),
      el('th', {}, 'Exec Hz'),
      el('th', {}, 'En Gate'),
      el('th', {}, 'Gate Type'),
      el('th', {}, 'Gate #'),
      el('th', {}, 'Actions')
    ]));
    
    const tbody = el('tbody');
    
    // Build rows asynchronously to use signal selectors
    for (let idx = 0; idx < loops.length; idx++) {
      const L = loops[idx];
      
      const removeBtn = el('button', {
        className: 'btn danger',
        onclick: () => {
          if (confirm(`Remove Loop ${idx} (${L.name})?`)) {
            loops.splice(idx, 1);
            buildForm();
          }
        }
      }, '×');
      
      // Create signal selectors
      const aiChSel = await createSignalSelector(L.src || 'ai', L.ai_ch || 0, v => L.ai_ch = v);
      const outChSel = await createSignalSelector(L.kind === 'analog' ? 'ao' : 'do', L.out_ch || 0, v => L.out_ch = v);
      const spChSel = (L.sp_source === 'ao' || L.sp_source === 'math' || L.sp_source === 'pid' || L.sp_source === 'expr' || L.sp_source === 'static')
        ? await createSignalSelector(L.sp_source, L.sp_channel || 0, v => L.sp_channel = v)
        : num(L, 'sp_channel', 1);
      
      // Out Min cell: show source selector + value/channel
      const outMinCell = el('td', {style: 'min-width:150px'});
      const outMinSrcSel = selectEnum(['fixed','math','expr'], L.out_min_source||'fixed', v => {L.out_min_source=v; buildForm();});
      const outMinContent = (L.out_min_source === 'math' || L.out_min_source === 'expr')
        ? await createSignalSelector(L.out_min_source, L.out_min_channel || 0, v => L.out_min_channel = v)
        : num(L, 'out_min', 0.0001);
      outMinCell.append(outMinSrcSel, el('br'), outMinContent);
      
      // Out Max cell: show source selector + value/channel
      const outMaxCell = el('td', {style: 'min-width:150px'});
      const outMaxSrcSel = selectEnum(['fixed','math','expr'], L.out_max_source||'fixed', v => {L.out_max_source=v; buildForm();});
      const outMaxContent = (L.out_max_source === 'math' || L.out_max_source === 'expr')
        ? await createSignalSelector(L.out_max_source, L.out_max_channel || 0, v => L.out_max_channel = v)
        : num(L, 'out_max', 0.0001);
      outMaxCell.append(outMaxSrcSel, el('br'), outMaxContent);
      
      const gateChSel = await createSignalSelector(L.enable_kind || 'do', L.enable_index || 0, v => L.enable_index = v);
      
      const tr = el('tr', {}, [
        el('td', {}, `${idx}`),
        el('td', {}, chk(L, 'enabled')),
        el('td', {}, txt(L, 'name')),
        el('td', {}, selectEnum(['analog','digital','var'], L.kind||'analog', v=>{L.kind=v; buildForm();})),  // Rebuild when kind changes
        el('td', {}, selectEnum(['ai','ao','tc','pid','math','expr','static'], L.src||'ai', v=>{L.src=v; buildForm();})),  // Rebuild on src change
        el('td', {}, aiChSel),
        el('td', {}, outChSel),  // Use selector instead of num
        el('td', {}, num(L, 'target', 0.0001)),  // Fixed SP value
        el('td', {}, selectEnum(['fixed','ao','pid','math','expr','static'], L.sp_source||'fixed', v=>{L.sp_source=v; buildForm();})),  // Rebuild on sp_source change
        el('td', {}, spChSel),
        el('td', {}, num(L, 'kp', 0.0001)),
        el('td', {}, num(L, 'ki', 0.0001)),
        el('td', {}, num(L, 'kd', 0.0001)),
        outMinCell,  // Combined source + value/channel
        outMaxCell,  // Combined source + value/channel
        el('td', {}, num(L, 'err_min', 0.0001)),
        el('td', {}, num(L, 'err_max', 0.0001)),
        el('td', {}, num(L, 'i_min', 0.0001)),
        el('td', {}, num(L, 'i_max', 0.0001)),
        el('td', {}, num(L, 'execution_rate_hz', 1)),
        el('td', {}, chk(L, 'enable_gate')),
        el('td', {}, selectEnum(['do','le','math','expr'], L.enable_kind||'do', v=>{L.enable_kind=v; buildForm();})),  // Rebuild on gate kind change
        el('td', {}, gateChSel),
        el('td', {}, removeBtn)
      ]);
      tbody.append(tr);
    }
    
    table.append(thead, tbody);
    formContainer.append(table);
  };

  buildForm();

  const save=el('button',{className:'btn',onclick:async()=>{
    try{
      console.log('[PID Save] Saving loops:', JSON.stringify(loops, null, 2));
      await fetch('/api/pid',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({loops: loops})}); 
      alert('Saved'); 
    }
    catch(e){ alert('Save failed: '+e.message); }
  }},'Save');

  const saveAs = createSaveAsButton(() => ({loops}), 'PID.json');
  
  root.append(
    title,
    el('div', {style: 'display:flex;gap:8px;margin-bottom:12px'}, [loadBtn, addBtn]),
    el('div', {style: 'overflow:auto;max-height:60vh'}, formContainer),
    el('div',{style:'display:flex;gap:8px;margin-top:8px'}, [save, saveAs])
  );
  showModal(root, ()=>{ renderPage(); });
}

async function openMotorEditor(){
  const motor_data = await (await fetch('/api/motors')).json();
  const motors = motor_data.motors || [];
  
  // Fetch available COM ports
  let ports = [];
  try {
    const portsResp = await fetch('/api/motors/ports');
    const portsData = await portsResp.json();
    ports = portsData.ports || [];
  } catch(e) {
    console.warn('Failed to fetch COM ports:', e);
  }

  const root = el('div', {});
  const title = el('h2', {}, 'Motor Controllers');
  
  // Load from file button
  const loadBtn = createLoadButton((loaded, filename) => {
    Object.assign(motor_data, loaded);
    closeModal();
    openMotorEditor(); // Re-open with loaded data
  });

  // Add Motor button
  const addBtn = el('button', {
    className: 'btn',
    onclick: () => {
      motors.push({
        name: `Motor${motors.length}`,
        port: 'COM1',
        baudrate: 9600,
        address: 1,
        min_rpm: 0,
        max_rpm: 2500,
        input_source: 'ai',
        input_channel: 0,
        input_min: 0,
        input_max: 10,
        scale_factor: 250,
        offset: 0,
        cw_positive: true,
        enabled: false,
        include: false
      });
      buildForm();
    }
  }, '+ Add Motor');

  const formContainer = el('div', {});

  const buildForm = () => {
    formContainer.innerHTML = '';
    
    // Build form for each motor
    const table = el('table', {className:'form'});
    const thead = el('thead');
    thead.append(el('tr', {}, [
      el('th', {}, 'Motor #'),
      el('th', {}, 'Include'),
      el('th', {}, 'Enabled'),
      el('th', {}, 'Name'),
      el('th', {}, 'COM Port'),
      el('th', {}, 'Baudrate'),
      el('th', {}, 'Address'),
      el('th', {}, 'Min RPM'),
      el('th', {}, 'Max RPM'),
      el('th', {}, 'Input Src'),
      el('th', {}, 'Input Ch'),
      el('th', {}, 'Input Min'),
      el('th', {}, 'Input Max'),
      el('th', {}, 'Scale'),
      el('th', {}, 'Offset'),
      el('th', {}, 'CW+'),
      el('th', {}, 'Actions')
    ]));
    
    const tbody = el('tbody');

    motors.forEach((M, idx) => {
      const portSelect = el('select', {});
      if (ports.length > 0) {
        ports.forEach(p => {
          portSelect.append(el('option', {value: p.port}, `${p.port} - ${p.description}`));
        });
      } else {
        // Fallback COM ports if query failed
        for (let i = 1; i <= 20; i++) {
          portSelect.append(el('option', {value: `COM${i}`}, `COM${i}`));
        }
      }
      portSelect.value = M.port || 'COM1';
      portSelect.onchange = () => M.port = portSelect.value;

      const srcSelect = selectEnum(['ai', 'ao', 'tc', 'pid', 'math'], M.input_source || 'ai', v => M.input_source = v);

      const removeBtn = el('button', {
        className: 'btn danger',
        onclick: () => {
          if (confirm(`Remove Motor ${idx} (${M.name})?`)) {
            motors.splice(idx, 1);
            buildForm();
          }
        }
      }, '×');

      const tr = el('tr', {}, [
        el('td', {}, `${idx}`),
        el('td', {}, chk(M, 'include')),
        el('td', {}, chk(M, 'enabled')),
        el('td', {}, txt(M, 'name')),
        el('td', {}, portSelect),
        el('td', {}, num(M, 'baudrate', 1)),
        el('td', {}, num(M, 'address', 1)),
        el('td', {}, num(M, 'min_rpm', 1)),
        el('td', {}, num(M, 'max_rpm', 1)),
        el('td', {}, srcSelect),
        el('td', {}, num(M, 'input_channel', 1)),
        el('td', {}, num(M, 'input_min', 0.01)),
        el('td', {}, num(M, 'input_max', 0.01)),
        el('td', {}, num(M, 'scale_factor', 0.1)),
        el('td', {}, num(M, 'offset', 0.1)),
        el('td', {}, chk(M, 'cw_positive')),
        el('td', {}, removeBtn)
      ]);
      tbody.append(tr);
    });

    table.append(thead, tbody);
    formContainer.append(table);
  };

  buildForm();

  const save = el('button', {
    className: 'btn',
    onclick: async() => {
      try {
        await fetch('/api/motors', {
          method:'PUT',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({motors: motors})
        });
        alert('Saved');
      } catch(e) {
        alert('Save failed: ' + e.message);
      }
    }
  }, 'Save');

  const saveAs = createSaveAsButton(() => ({motors}), 'motor.json');
  
  root.append(
    title,
    el('div', {style: 'display:flex;gap:8px;margin-bottom:12px'}, [loadBtn, addBtn]),
    el('div', {style: 'margin:12px 0'}, [
      el('p', {}, 'Configure Rattmotor YPMC-750W servo controllers:'),
      el('p', {style: 'font-size:12px;color:var(--muted)'}, 
        'RPM Command = Input * Scale + Offset. Negative RPM reverses motor.')
    ]),
    el('div', {style: 'overflow:auto;max-height:60vh'}, formContainer),
    el('div', {style:'display:flex;gap:8px;margin-top:8px'}, [save, saveAs])
  );
  showModal(root, ()=>{ renderPage(); });
}

// ==================== LOGIC ELEMENTS EDITOR ====================
async function openLEEditor(){
  const le_data = await (await fetch('/api/logic_elements')).json();
  const elements = le_data.elements || [];
  
  const root = el('div', {});
  const title = el('h2', {}, 'Logic Elements Editor');
  
  const loadBtn = createLoadButton((loaded, filename) => {
    Object.assign(le_data, loaded);
    closeModal();
    openLEEditor(); // Re-open with loaded data
  });

  const addBtn = el('button', {
    className: 'btn',
    onclick: () => {
      elements.push({
        enabled: true,
        name: `LE${elements.length}`,
        input_a: {kind: 'do', index: 0},
        input_b: {kind: 'do', index: 1},
        operation: 'and'
      });
      renderLEEditor();
    }
  }, '+ Add Logic Element');

  const container = el('div', {style: 'overflow:auto;max-height:60vh'});

  function renderLEEditor() {
    container.innerHTML = '';
    
    elements.forEach((elem, idx) => {
      const card = el('fieldset', {style: 'margin-bottom:20px; padding:12px;'});
      const legend = el('legend', {}, `LE${idx}: ${elem.name}`);
      card.append(legend);

      const topRow = el('div', {className: 'row', style: 'margin-bottom:12px'});
      topRow.append(
        el('label', {}, [
          el('input', {type: 'checkbox', checked: elem.enabled, onchange: e => elem.enabled = e.target.checked}),
          ' Enabled'
        ]),
        el('label', {style: 'flex:2'}, [
          'Name: ',
          el('input', {type: 'text', value: elem.name, oninput: e => elem.name = e.target.value, style: 'width:100%'})
        ]),
        el('button', {
          className: 'btn danger',
          onclick: () => {
            if (confirm(`Delete LE${idx}?`)) {
              elements.splice(idx, 1);
              renderLEEditor();
            }
          }
        }, '🗑 Delete')
      );
      card.append(topRow);

      const inputASection = el('div', {style: 'border:1px solid #2a3046; padding:8px; margin-bottom:8px; border-radius:6px'});
      inputASection.append(el('h4', {style: 'margin:0 0 8px 0; color:#a8b3cf'}, 'Input A'));
      inputASection.append(createInputEditor(elem.input_a, 'a'));
      card.append(inputASection);

      const opRow = el('div', {style: 'margin:12px 0; text-align:center'});
      const opSelect = el('select', {
        onchange: e => elem.operation = e.target.value,
        style: 'font-size:16px; font-weight:bold; padding:6px 12px'
      });
      ['and', 'or', 'xor', 'nand', 'nor', 'nxor'].forEach(op => {
        opSelect.append(el('option', {value: op}, op.toUpperCase()));
      });
      opSelect.value = elem.operation || 'and';  // Set value AFTER options
      opRow.append(opSelect);
      card.append(opRow);

      const inputBSection = el('div', {style: 'border:1px solid #2a3046; padding:8px; border-radius:6px'});
      inputBSection.append(el('h4', {style: 'margin:0 0 8px 0; color:#a8b3cf'}, 'Input B'));
      inputBSection.append(createInputEditor(elem.input_b, 'b'));
      card.append(inputBSection);

      container.append(card);
    });
  }

  function createInputEditor(input, label) {
    const div = el('div', {});
    
    // Type and Index row - compact layout
    const kindRow = el('div', {className: 'row', style: 'margin-bottom:8px'});
    const kindSelect = el('select', {
      onchange: async e => {
        input.kind = e.target.value;
        // Rebuild signal selector
        const newSel = await createSignalSelector(e.target.value, input.index || 0, idx => input.index = idx);
        signalSelect.replaceWith(newSel);
        signalSelect = newSel;
        // Clear comparison fields when switching to non-analog types
        if (!['ai', 'ao', 'tc', 'pid_u', 'math', 'expr'].includes(e.target.value)) {
          delete input.comparison;
          delete input.compare_to_type;
          delete input.compare_value;
          delete input.compare_to_kind;
          delete input.compare_to_index;
        } else {
          // Set defaults for analog types
          if (!input.comparison) input.comparison = 'gt';
          if (!input.compare_to_type) input.compare_to_type = 'value';
          if (input.compare_value === undefined) input.compare_value = 0;
        }
        renderLEEditor();
      }
    });
    
    // Add options - compact version
    ['do', 'ai', 'ao', 'tc', 'pid_u', 'le', 'math', 'expr'].forEach(k => {
      const opt = el('option', {value: k}, k.toUpperCase());
      kindSelect.append(opt);
    });
    
    // Set the value AFTER adding options
    kindSelect.value = input.kind || 'do';
    
    // Create signal selector
    let signalSelect = el('select', {style: 'width:120px'});
    signalSelect.append(el('option', {}, 'Loading...'));
    (async () => {
      const newSel = await createSignalSelector(input.kind || 'do', input.index || 0, idx => input.index = idx);
      signalSelect.replaceWith(newSel);
      signalSelect = newSel;
    })();
    
    kindRow.append(
      el('label', {}, ['Type: ', kindSelect]),
      el('label', {}, ['Signal: ', signalSelect])
    );
    div.append(kindRow);

    // For analog types, show comparison options - compact layout
    if (['ai', 'ao', 'tc', 'pid_u', 'math', 'expr'].includes(input.kind)) {
      const compRow = el('div', {className: 'row', style: 'margin-bottom:8px'});
      
      const compSelect = el('select', {
        onchange: e => input.comparison = e.target.value
      });
      [{v:'lt', t:'<'}, {v:'eq', t:'='}, {v:'gt', t:'>'}].forEach(({v, t}) => {
        compSelect.append(el('option', {value: v}, t));
      });
      compSelect.value = input.comparison || 'gt';
      
      compRow.append(el('label', {}, ['Compare: ', compSelect]));
      div.append(compRow);

      const compareToRow = el('div', {className: 'row', style: 'margin-bottom:8px'});
      
      const typeSelect = el('select', {
        onchange: e => {
          input.compare_to_type = e.target.value;
          // Initialize defaults
          if (e.target.value === 'value') {
            if (input.compare_value === undefined) input.compare_value = 0;
          } else {
            if (!input.compare_to_kind) input.compare_to_kind = 'ai';
            if (input.compare_to_index === undefined) input.compare_to_index = 0;
          }
          renderLEEditor();
        }
      });
      typeSelect.append(el('option', {value: 'value'}, 'Fixed Value'));
      typeSelect.append(el('option', {value: 'signal'}, 'Another Signal'));
      // Set value AFTER adding options
      typeSelect.value = input.compare_to_type || 'value';
      
      compareToRow.append(el('label', {}, ['To: ', typeSelect]));
      div.append(compareToRow);

      // Show ONLY the relevant input based on compare_to_type
      if (!input.compare_to_type || input.compare_to_type === 'value') {
        const valueInput = el('input', {
          type: 'number',
          value: input.compare_value ?? 0,
          step: 0.1,
          oninput: e => input.compare_value = parseFloat(e.target.value) || 0,
          style: 'width:100%'
        });
        div.append(el('div', {style: 'margin-bottom:8px'}, [
          el('label', {}, ['Value: ', valueInput])
        ]));
      } else if (input.compare_to_type === 'signal') {
        const signalRow = el('div', {className: 'row', style: 'margin-bottom:8px'});
        
        const signalKindSelect = el('select', {
          onchange: async e => {
            input.compare_to_kind = e.target.value;
            // Rebuild selector
            const newSel = await createSignalSelector(e.target.value, input.compare_to_index || 0, idx => input.compare_to_index = idx);
            compareSignalSelect.replaceWith(newSel);
            compareSignalSelect = newSel;
          }
        });
        ['ai', 'ao', 'tc', 'pid_u', 'math', 'expr'].forEach(k => {
          signalKindSelect.append(el('option', {value: k}, k.toUpperCase()));
        });
        signalKindSelect.value = input.compare_to_kind || 'ai';
        
        // Create signal selector
        let compareSignalSelect = el('select', {style: 'width:120px'});
        compareSignalSelect.append(el('option', {}, 'Loading...'));
        (async () => {
          const newSel = await createSignalSelector(input.compare_to_kind || 'ai', input.compare_to_index || 0, idx => input.compare_to_index = idx);
          compareSignalSelect.replaceWith(newSel);
          compareSignalSelect = newSel;
        })();
        
        signalRow.append(
          el('label', {}, ['Type: ', signalKindSelect]),
          el('label', {}, ['Signal: ', compareSignalSelect])
        );
        div.append(signalRow);
      }
    }
    // Removed info text for DO/LE - you know what they are!

    return div;
  }

  const save = el('button', {
    className: 'btn',
    onclick: async() => {
      try {
        await fetch('/api/logic_elements', {
          method:'PUT',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({elements: elements})
        });
        alert('Logic Elements Saved');
      } catch(e) {
        alert('Save failed: ' + e.message);
      }
    }
  }, 'Save');

  root.append(
    title,
    el('div', {style: 'display:flex;gap:8px;margin-bottom:12px'}, [loadBtn, addBtn]),
    el('div', {style: 'margin:12px 0'}, [
      el('p', {}, 'Logic Elements combine two inputs with boolean logic operations.'),
      el('p', {style: 'font-size:12px;color:var(--muted)'}, 
        'Digital inputs (DO, LE) are boolean. Analog inputs (AI, AO, TC, PID) are compared to a value or another signal.')
    ]),
    container,
    el('div', {style:'display:flex;gap:8px;margin-top:12px'}, [save, createSaveAsButton(() => ({elements}), 'logic_elements.json')])
  );
  
  renderLEEditor();
  showModal(root, ()=>{ renderPage(); });
}

async function openMathEditor(){
  const math_data = await (await fetch('/api/math_operators')).json();
  const operators = math_data.operators || [];
  
  const root = el('div', {});
  const title = el('h2', {}, 'Math Operators Editor');
  
  const loadBtn = createLoadButton((loaded, filename) => {
    Object.assign(math_data, loaded);
    closeModal();
    openMathEditor(); // Re-open with loaded data
  });

  const addUnaryBtn = el('button', {
    className: 'btn',
    onclick: () => {
      operators.push({
        enabled: true,
        name: `Math${operators.length}`,
        operation: 'sqr',
        input_a: {kind: 'ai', index: 0}
      });
      renderMathEditor();
    }
  }, '+ Add Unary (sqr, sqrt, etc)');

  const addBinaryBtn = el('button', {
    className: 'btn',
    onclick: () => {
      operators.push({
        enabled: true,
        name: `Math${operators.length}`,
        operation: 'add',
        input_a: {kind: 'ai', index: 0},
        input_b: {kind: 'ai', index: 1}
      });
      renderMathEditor();
    }
  }, '+ Add Binary (+, -, ×, ÷)');

  const container = el('div', {style: 'overflow:auto;max-height:60vh'});

  function renderMathEditor() {
    container.innerHTML = '';
    
    operators.forEach((op, idx) => {
      const card = el('fieldset', {style: 'margin-bottom:20px; padding:12px;'});
      const legend = el('legend', {}, `Math${idx}: ${op.name}`);
      card.append(legend);

      const topRow = el('div', {className: 'row', style: 'margin-bottom:12px'});
      topRow.append(
        el('label', {}, [
          el('input', {type: 'checkbox', checked: op.enabled, onchange: e => op.enabled = e.target.checked}),
          ' Enabled'
        ]),
        el('label', {style: 'flex:2'}, [
          'Name: ',
          el('input', {type: 'text', value: op.name, oninput: e => op.name = e.target.value, style: 'width:100%'})
        ]),
        el('button', {
          className: 'btn danger',
          onclick: () => {
            if (confirm(`Delete Math${idx}?`)) {
              operators.splice(idx, 1);
              renderMathEditor();
            }
          }
        }, '🗑 Delete')
      );
      card.append(topRow);

      // Operation select
      const opRow = el('div', {style: 'margin:12px 0'});
      const opSelect = el('select', {
        onchange: e => {
          op.operation = e.target.value;
          const binary = ['add','sub','mul','div','mod','pow','min','max','atan2'];
          const conditional = ['if_gt','if_gte','if_lt','if_lte','if_eq','if_neq'];
          
          // Binary and conditional ops need input_b
          if (binary.includes(e.target.value) || conditional.includes(e.target.value)) {
            if (!op.input_b) op.input_b = {kind: 'ai', index: 1};
          } else {
            delete op.input_b;
          }
          
          // Conditional ops need output_true and output_false
          if (conditional.includes(e.target.value)) {
            if (!op.output_true) op.output_true = {kind: 'value', index: 0, value: 1.0};
            if (!op.output_false) op.output_false = {kind: 'value', index: 0, value: 0.0};
          } else {
            delete op.output_true;
            delete op.output_false;
          }
          
          renderMathEditor();
        },
        style: 'font-size:14px; padding:6px 12px'
      });
      
      const opGroups = {
        'Unary': ['sqr','sqrt','log10','ln','exp','sin','cos','tan','asin','acos','atan','abs','neg','filter'],
        'Binary': ['add','sub','mul','div','mod','pow','min','max','atan2'],
        'Conditional': ['if_gt','if_gte','if_lt','if_lte','if_eq','if_neq']
      };
      Object.entries(opGroups).forEach(([group, ops]) => {
        const optgroup = el('optgroup', {label: group});
        ops.forEach(o => optgroup.append(el('option', {value: o}, o)));
        opSelect.append(optgroup);
      });
      opSelect.value = op.operation || 'add';
      opRow.append(el('label', {}, ['Operation: ', opSelect]));
      card.append(opRow);

      // Filter cutoff frequency (only for filter operation)
      if (op.operation === 'filter') {
        const filterRow = el('div', {style: 'margin:12px 0'});
        const filterInput = el('input', {
          type: 'number',
          min: 0.01,
          step: 0.1,
          value: op.filter_hz || 1.0,
          oninput: e => op.filter_hz = parseFloat(e.target.value) || 1.0,
          style: 'width:100px'
        });
        filterRow.append(el('label', {}, ['Cutoff Frequency (Hz): ', filterInput]));
        card.append(filterRow);
      }

      // Input A
      const inputASection = el('div', {style: 'border:1px solid #2a3046; padding:8px; margin-bottom:8px; border-radius:6px'});
      inputASection.append(el('h4', {style: 'margin:0 0 8px 0; color:#a8b3cf'}, 'Input A'));
      inputASection.append(createMathInputEditor(op.input_a));
      card.append(inputASection);

      // Input B (only for binary and conditional ops)
      const binary = ['add','sub','mul','div','mod','pow','min','max','atan2'];
      const conditional = ['if_gt','if_gte','if_lt','if_lte','if_eq','if_neq'];
      
      if (binary.includes(op.operation) || conditional.includes(op.operation)) {
        const inputBSection = el('div', {style: 'border:1px solid #2a3046; padding:8px; border-radius:6px; margin-bottom:8px'});
        inputBSection.append(el('h4', {style: 'margin:0 0 8px 0; color:#a8b3cf'}, conditional.includes(op.operation) ? 'Compare To' : 'Input B'));
        inputBSection.append(createMathInputEditor(op.input_b));
        card.append(inputBSection);
      }
      
      // IF outputs (only for conditional ops)
      if (conditional.includes(op.operation)) {
        const ifOutputsSection = el('div', {style: 'border:1px solid #2a3046; padding:8px; border-radius:6px; margin-bottom:8px'});
        ifOutputsSection.append(el('h4', {style: 'margin:0 0 8px 0; color:#a8b3cf'}, 'Outputs'));
        
        const trueRow = el('div', {style: 'margin-bottom:8px'});
        trueRow.append(el('label', {style: 'display:block;margin-bottom:4px;color:#7aa2f7'}, 'If TRUE:'));
        if (!op.output_true) op.output_true = {kind: 'value', index: 0, value: 1.0};
        trueRow.append(createMathInputEditor(op.output_true));
        
        const falseRow = el('div', {});
        falseRow.append(el('label', {style: 'display:block;margin-bottom:4px;color:#f7768e'}, 'If FALSE:'));
        if (!op.output_false) op.output_false = {kind: 'value', index: 0, value: 0.0};
        falseRow.append(createMathInputEditor(op.output_false));
        
        ifOutputsSection.append(trueRow, falseRow);
        card.append(ifOutputsSection);
      }
      
      // Hardware Output Configuration
      const outputSection = el('div', {style: 'border:1px solid #2a3046; padding:8px; border-radius:6px; margin-bottom:8px'});
      outputSection.append(el('h4', {style: 'margin:0 0 8px 0; color:#a8b3cf'}, 'Hardware Output (Optional)'));
      
      const hasOutputChk = el('input', {
        type: 'checkbox',
        checked: op.has_output || false,
        onchange: e => {
          op.has_output = e.target.checked;
          outputConfigDiv.style.display = e.target.checked ? 'block' : 'none';
        }
      });
      
      const outputConfigDiv = el('div', {style: 'display:' + (op.has_output ? 'block' : 'none') + ';margin-top:8px'});
      
      const outputTypeSelect = el('select', {
        onchange: e => {
          op.output_type = e.target.value;
          clampDiv.style.display = e.target.value === 'ao' ? 'block' : 'none';
        },
        style: 'width:80px;margin-left:8px'
      });
      outputTypeSelect.append(el('option', {value: 'ao'}, 'AO'));
      outputTypeSelect.append(el('option', {value: 'do'}, 'DO'));
      outputTypeSelect.value = op.output_type || 'ao';
      
      const outputChInput = el('input', {
        type: 'number',
        min: 0,
        step: 1,
        value: op.output_channel ?? 0,
        oninput: e => op.output_channel = parseInt(e.target.value) || 0,
        style: 'width:60px;margin-left:8px'
      });
      
      const clampDiv = el('div', {style: 'display:' + (op.output_type === 'ao' ? 'block' : 'none') + ';margin-top:8px'});
      const minInput = el('input', {
        type: 'number',
        step: 'any',
        value: op.output_min ?? -10.0,
        oninput: e => op.output_min = parseFloat(e.target.value),
        style: 'width:80px;margin-left:8px'
      });
      const maxInput = el('input', {
        type: 'number',
        step: 'any',
        value: op.output_max ?? 10.0,
        oninput: e => op.output_max = parseFloat(e.target.value),
        style: 'width:80px;margin-left:8px'
      });
      
      clampDiv.append(
        el('label', {}, ['Min: ', minInput]),
        el('label', {style: 'margin-left:12px'}, ['Max: ', maxInput])
      );
      
      outputConfigDiv.append(
        el('div', {className: 'row', style: 'margin-bottom:8px'}, [
          el('label', {}, ['Type: ', outputTypeSelect]),
          el('label', {style: 'margin-left:12px'}, ['Channel: ', outputChInput])
        ]),
        clampDiv
      );
      
      outputSection.append(
        el('label', {}, [hasOutputChk, ' Write result to AO/DO']),
        outputConfigDiv
      );
      card.append(outputSection);

      container.append(card);
    });
  }

  function createMathInputEditor(input) {
    const div = el('div', {className: 'row'});
    
    const kindSelect = el('select', {
      onchange: async e => {
        input.kind = e.target.value;
        // Show/hide value input based on kind
        if (e.target.value === 'value') {
          signalSelect.style.display = 'none';
          signalLabel.style.display = 'none';
          valueInput.style.display = 'block';
          valueLabel.style.display = 'flex';
        } else {
          // Rebuild signal selector for new kind
          const newSel = await createSignalSelector(e.target.value, input.index || 0, idx => input.index = idx);
          signalSelect.replaceWith(newSel);
          signalSelect = newSel;
          signalSelect.style.display = 'block';
          signalLabel.style.display = 'flex';
          valueInput.style.display = 'none';
          valueLabel.style.display = 'none';
        }
      },
      style: 'flex:1'
    });
    ['ai', 'ao', 'tc', 'pid_u', 'math', 'le', 'expr', 'value'].forEach(k => {
      kindSelect.append(el('option', {value: k}, k.toUpperCase()));
    });
    kindSelect.value = input.kind || 'ai';
    
    // Create signal selector (async)
    let signalSelect = el('select', {style: 'flex:1'});
    signalSelect.append(el('option', {}, 'Loading...'));
    (async () => {
      const newSel = await createSignalSelector(input.kind || 'ai', input.index || 0, idx => input.index = idx);
      signalSelect.replaceWith(newSel);
      signalSelect = newSel;
    })();
    
    const valueInput = el('input', {
      type: 'number',
      step: 'any',
      value: input.value || 0,
      oninput: e => input.value = parseFloat(e.target.value) || 0,
      style: 'flex:1; display:' + (input.kind === 'value' ? 'block' : 'none')
    });
    
    const signalLabel = el('label', {style: 'flex:1; display:' + (input.kind === 'value' ? 'none' : 'flex')}, ['Signal: ', signalSelect]);
    const valueLabel = el('label', {style: 'flex:1; display:' + (input.kind === 'value' ? 'flex' : 'none')}, ['Value: ', valueInput]);
    
    div.append(
      el('label', {style: 'flex:1'}, ['Kind: ', kindSelect]),
      signalLabel,
      valueLabel
    );
    
    return div;
  }

  renderMathEditor();

  const saveBtn = el('button', {
    className: 'btn',
    onclick: async () => {
      try {
        const resp = await fetch('/api/math_operators', {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(math_data)
        });
        const result = await resp.json();
        if (result.ok) {
          alert('Math operators saved!');
          closeModal();
          renderPage(); // Reload all widgets to show updated config
        } else {
          alert('Failed to save: ' + result.error);
        }
      } catch(e) {
        alert('Network error: ' + e.message);
      }
    }
  }, '💾 Save');

  const saveAs = createSaveAsButton(() => math_data, 'math_operators.json');

  root.append(
    title,
    el('div', {className: 'row', style: 'gap:8px;margin:12px 0'}, [loadBtn, addUnaryBtn, addBinaryBtn]),
    container,
    el('div', {className: 'row', style: 'gap:8px;margin-top:20px'}, [saveBtn, saveAs])
  );

  showModal(root);
}

async function openZeroAIDialog() {
  const cfg = await (await fetch('/api/config')).json();
  const analogs = getAllAnalogs(cfg);
  
  const root = el('div', {});
  const title = el('h2', {}, 'Zero AI Channels');
  const subtitle = el('p', {style: 'color:#a8b3cf;margin-bottom:16px'}, 
    'Select channels to zero. This will average the current readings and adjust offsets.');
  
  // Configuration inputs
  const configRow = el('div', {style: 'margin:16px 0;padding:12px;background:#1a1d2e;border-radius:6px;display:flex;gap:20px;flex-wrap:wrap'});
  
  const avgInput = el('input', {
    type: 'number',
    min: 0.1,
    step: 0.1,
    value: 1.0,
    style: 'width:80px;margin-left:8px'
  });
  
  const balanceInput = el('input', {
    type: 'number',
    step: 'any',
    value: 0.0,
    style: 'width:100px;margin-left:8px'
  });
  
  configRow.append(
    el('div', {style: 'flex:1;min-width:300px'}, [
      el('label', {}, ['Averaging Period (sec): ', avgInput]),
      el('div', {style: 'color:#7a7f8f;font-size:10px;margin-top:4px;margin-left:8px'}, 
        'Time to average readings')
    ]),
    el('div', {style: 'flex:1;min-width:300px'}, [
      el('label', {}, ['Balance To Value: ', balanceInput]),
      el('div', {style: 'color:#7a7f8f;font-size:10px;margin-top:4px;margin-left:8px'}, 
        'Target value after zeroing (e.g., 150.5 psi)')
    ])
  );
  
  // AI channel checkboxes
  const channelList = el('div', {style: 'max-height:400px;overflow:auto'});
  const selectedChannels = new Set();
  
  analogs.forEach((ai, idx) => {
    const row = el('div', {
      style: 'padding:8px;margin:4px 0;background:#1a1d2e;border-radius:4px;display:flex;align-items:center;gap:12px'
    });
    
    const checkbox = el('input', {
      type: 'checkbox',
      id: `zero_ai_${idx}`,
      onchange: e => {
        if (e.target.checked) selectedChannels.add(idx);
        else selectedChannels.delete(idx);
      }
    });
    
    const label = el('label', {
      htmlFor: `zero_ai_${idx}`,
      style: 'flex:1;cursor:pointer;display:flex;align-items:center;gap:8px'
    });
    
    const aiName = el('span', {style: 'font-weight:600;min-width:150px'}, ai.name || `AI${idx}`);
    const currentVal = el('span', {
      id: `zero_current_${idx}`,
      style: 'color:#7aa2f7;font-family:monospace'
    }, 'Loading...');
    
    label.append(checkbox, aiName, currentVal);
    row.append(label);
    channelList.append(row);
  });
  
  // Update current values periodically
  const updateInterval = setInterval(() => {
    if (!state.ai) return;
    analogs.forEach((ai, idx) => {
      const span = document.getElementById(`zero_current_${idx}`);
      if (span && state.ai[idx] !== undefined) {
        const val = state.ai[idx];
        span.textContent = Number.isFinite(val) ? val.toFixed(4) : '---';
      }
    });
  }, 100);
  
  // Zero button
  const zeroBtn = el('button', {
    className: 'btn primary',
    onclick: async () => {
      if (selectedChannels.size === 0) {
        alert('Please select at least one channel to zero.');
        return;
      }
      
      const avgPeriod = parseFloat(avgInput.value) || 1.0;
      const balanceToValue = parseFloat(balanceInput.value) || 0.0;
      const channelsToZero = Array.from(selectedChannels);
      
      zeroBtn.disabled = true;
      zeroBtn.textContent = 'Averaging...';
      
      try {
        // Call backend to perform zeroing
        const resp = await fetch('/api/zero_ai', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            channels: channelsToZero,
            averaging_period: avgPeriod,
            balance_to_value: balanceToValue
          })
        });
        
        const result = await resp.json();
        
        if (result.ok) {
          const balanceMsg = balanceToValue !== 0 ? `\\nBalanced to: ${balanceToValue}` : '';
          alert(`Successfully zeroed ${channelsToZero.length} channel(s)!${balanceMsg}\\n\\n` +
                `Offsets updated:\\n` + 
                result.offsets.map(o => 
                  `AI${o.channel}: ${o.old.toFixed(4)} → ${o.new.toFixed(4)} (avg: ${o.avg.toFixed(4)})`
                ).join('\\n'));
          clearInterval(updateInterval);
          closeModal();
        } else {
          alert('Failed to zero channels: ' + (result.error || 'Unknown error'));
          zeroBtn.disabled = false;
          zeroBtn.textContent = '⚡ Zero Selected Channels';
        }
      } catch (e) {
        alert('Network error: ' + e.message);
        zeroBtn.disabled = false;
        zeroBtn.textContent = '⚡ Zero Selected Channels';
      }
    }
  }, '⚡ Zero Selected Channels');
  
  const cancelBtn = el('button', {
    className: 'btn',
    onclick: () => {
      clearInterval(updateInterval);
      closeModal();
    }
  }, 'Cancel');
  
  root.append(
    title,
    subtitle,
    configRow,
    el('h3', {style: 'margin:20px 0 12px 0'}, 'Select Channels:'),
    channelList,
    el('div', {className: 'row', style: 'gap:8px;margin-top:20px'}, [zeroBtn, cancelBtn])
  );
  
  showModal(root);
}

  async function openScriptEditor() {
    const script = await (await fetch('/api/script')).json();
    const events = script.events || [];

    const root = el('div', {});
    const title = el('h2', {}, 'Script Editor');

    // Add Load from File button
    const loadBtn = el('button', {
      className: 'btn',
      onclick: () => {
        const inp = el('input', {type: 'file', accept: '.json'});
        inp.onchange = async () => {
          const f = inp.files?.[0];
          if (!f) return;
          try {
            const text = await f.text();
            const loaded = JSON.parse(text);
            // Clear and reload events
            events.length = 0;
            const loadedEvents = loaded.events || (Array.isArray(loaded) ? loaded : []);
            events.push(...loadedEvents);
            renderEvents();
            alert(`Loaded ${events.length} events`);
          } catch (e) {
            alert('Failed to load script: ' + e.message);
          }
        };
        inp.click();
      }
    }, '📁 Load from File');
    
    // Save As button - download script as JSON file
    const saveAsBtn = el('button', {
      className: 'btn',
      onclick: () => {
        const scriptData = {events: events};
        const blob = new Blob([JSON.stringify(scriptData, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = el('a', {
          href: url,
          download: `script_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`
        });
        a.click();
        URL.revokeObjectURL(url);
      }
    }, '💾 Save As...');

    const table = el('table', {className: 'form script-table'});
    const thead = el('thead', {}, el('tr', {}, [
      el('th', {}, 'Time (s)'),
      el('th', {}, 'Duration (s)'),
      el('th', {}, 'Type'),
      el('th', {}, 'Channel/Name'),
      el('th', {}, 'Value/State'),
      el('th', {}, 'NO/NC'),
      el('th', {}, 'Actions')
    ]));
    const tbody = el('tbody', {});

    function renderEvents() {
      tbody.innerHTML = '';
      events.forEach((evt, idx) => {
        const timeInput = el('input', {
          type: 'number',
          value: evt.time || 0,
          step: 0.1,
          min: 0,
          style: 'width:80px'
        });
        timeInput.oninput = () => evt.time = parseFloat(timeInput.value) || 0;

        const durationInput = el('input', {
          type: 'number',
          value: evt.duration || 0,
          step: 0.1,
          min: 0,
          style: 'width:80px'
        });
        durationInput.oninput = () => evt.duration = parseFloat(durationInput.value) || 0;

        const typeSelect = el('select', {style: 'width:100px'}, [
          el('option', {value: 'DO'}, 'DO'),
          el('option', {value: 'AO'}, 'AO'),
          el('option', {value: 'buttonVar'}, 'ButtonVar'),
          el('option', {value: 'var'}, 'Var')
        ]);
        typeSelect.value = evt.type || 'DO';
        typeSelect.onchange = () => {
          evt.type = typeSelect.value;
          renderEvents();
        };

        // Create channel selector based on type
        let channelControl;
        
        if (evt.type === 'DO' || !evt.type) {
          // DO: dropdown with names
          const doSelect = el('select', {style: 'width:120px'});
          const allDOs = getAllDigitalOutputs(configCache);
          allDOs.forEach((doChannel, idx) => {
            doSelect.append(el('option', {value: idx}, `DO${idx}: ${doChannel.name || 'Unnamed'}`));
          });
          doSelect.value = evt.channel || 0;
          doSelect.onchange = () => evt.channel = parseInt(doSelect.value);
          channelControl = doSelect;
          
        } else if (evt.type === 'AO') {
          // AO: dropdown with names
          const aoSelect = el('select', {style: 'width:120px'});
          const allAOs = getAllAnalogOutputs(configCache);
          allAOs.forEach((aoChannel, idx) => {
            aoSelect.append(el('option', {value: idx}, `AO${idx}: ${aoChannel.name || 'Unnamed'}`));
          });
          aoSelect.value = evt.channel || 0;
          aoSelect.onchange = () => evt.channel = parseInt(aoSelect.value);
          channelControl = aoSelect;
          
        } else {
          // Fallback for unknown types
          const channelInput = el('input', {
            type: 'number',
            value: evt.channel || 0,
            min: 0,
            step: 1,
            style: 'width:60px'
          });
          channelInput.oninput = () => evt.channel = parseInt(channelInput.value) || 0;
          channelControl = channelInput;
        }

        let valueControl;
        let noNcControl = el('span', {}, '—');

        if (evt.type === 'buttonVar' || evt.type === 'var') {
          // For buttonVar/var: show varName input and numeric value
          const varNameInput = el('input', {
            type: 'text',
            value: evt.varName || (evt.type === 'buttonVar' ? 'button1' : 'var1'),
            placeholder: 'name',
            style: 'width:80px'
          });
          varNameInput.oninput = () => evt.varName = varNameInput.value;
          channelControl = varNameInput;
          
          const valueInput = el('input', {
            type: 'number',
            value: evt.value || 0,
            step: 'any',
            style: 'width:80px'
          });
          valueInput.oninput = () => evt.value = parseFloat(valueInput.value) || 0;
          valueControl = valueInput;
          noNcControl = el('span', {}, '—');
          
        } else if (evt.type === 'DO' || !evt.type) {
          const stateCheck = el('input', {
            type: 'checkbox',
            checked: !!evt.state
          });
          stateCheck.onchange = () => evt.state = stateCheck.checked;
          valueControl = el('label', {style: 'display:flex;align-items:center;gap:4px'}, [
            stateCheck,
            el('span', {}, 'ON')
          ]);

          const noRadio = el('input', {
            type: 'radio',
            name: `nonc_${idx}`,
            value: 'NO',
            checked: evt.normallyOpen !== false
          });
          const ncRadio = el('input', {
            type: 'radio',
            name: `nonc_${idx}`,
            value: 'NC',
            checked: evt.normallyOpen === false
          });
          noRadio.onchange = () => evt.normallyOpen = true;
          ncRadio.onchange = () => evt.normallyOpen = false;

          noNcControl = el('div', {style: 'display:flex;gap:8px;align-items:center'}, [
            el('label', {style: 'display:flex;gap:4px'}, [noRadio, 'NO']),
            el('label', {style: 'display:flex;gap:4px'}, [ncRadio, 'NC'])
          ]);
        } else {
          const voltInput = el('input', {
            type: 'number',
            value: evt.value || 0,
            step: 0.01,
            min: 0,
            max: 10,
            style: 'width:80px'
          });
          voltInput.oninput = () => evt.value = parseFloat(voltInput.value) || 0;
          valueControl = el('div', {style: 'display:flex;align-items:center;gap:4px'}, [
            voltInput,
            el('span', {}, 'V')
          ]);
        }

        const deleteBtn = el('button', {
          type: 'button',
          className: 'btn danger',
          onclick: () => {
            events.splice(idx, 1);
            renderEvents();
          }
        }, '×');

        const upBtn = el('button', {
          type: 'button',
          className: 'btn',
          onclick: () => {
            if (idx > 0) {
              [events[idx], events[idx - 1]] = [events[idx - 1], events[idx]];
              renderEvents();
            }
          },
          disabled: idx === 0
        }, '↑');

        const downBtn = el('button', {
          type: 'button',
          className: 'btn',
          onclick: () => {
            if (idx < events.length - 1) {
              [events[idx], events[idx + 1]] = [events[idx + 1], events[idx]];
              renderEvents();
            }
          },
          disabled: idx === events.length - 1
        }, '↓');

        const tr = el('tr', {}, [
          el('td', {}, timeInput),
          el('td', {}, durationInput),
          el('td', {}, typeSelect),
          el('td', {}, channelControl),
          el('td', {}, valueControl),
          el('td', {}, noNcControl),
          el('td', {style: 'display:flex;gap:4px'}, [upBtn, downBtn, deleteBtn])
        ]);

        tbody.append(tr);
      });
    }

    renderEvents();
    table.append(thead, tbody);

    const addBtn = el('button', {
      className: 'btn',
      onclick: () => {
        // Auto-populate time = last event's time + duration
        let newTime = 0;
        if (events.length > 0) {
          const lastEvt = events[events.length - 1];
          newTime = (lastEvt.time || 0) + (lastEvt.duration || 0);
        }
        
        events.push({
          time: newTime,
          duration: 0,
          type: 'DO',
          channel: 0,
          state: false,
          normallyOpen: true
        });
        renderEvents();
      }
    }, '+ Add Event');

    const sortBtn = el('button', {
      className: 'btn',
      onclick: () => {
        events.sort((a, b) => (a.time || 0) - (b.time || 0));
        renderEvents();
      },
      style: 'margin-left:8px'
    }, 'Sort by Time');

    const saveBtn = el('button', {
      className: 'btn',
      onclick: async () => {
        try {
          await fetch('/api/script', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({events})
          });
          alert('Script saved successfully');
          loadScript(); // Reload for script player
        } catch (e) {
          alert('Save failed: ' + e.message);
        }
      },
      style: 'margin-left:8px'
    }, 'Save');

    root.append(
        title,
        el('div', {style: 'display:flex;gap:8px;margin:12px 0'}, [loadBtn, saveAsBtn]),
        el('div', {style: 'margin:12px 0'}, [
          el('p', {}, 'Define timed events for automated control. Time is in seconds from script start.'),
          el('p', {style: 'font-size:12px;color:var(--muted)'},
              'Duration: How long the output stays in this state (0 = instantaneous toggle)')
        ]),
        table,
        el('div', {style: 'margin-top:12px;display:flex;gap:8px'}, [addBtn, sortBtn, saveBtn])
    );

    showModal(root);
  }

/* ======================== EXPRESSION HELP ======================== */
function openExpressionHelp() {
  const root = el('div', {style: 'max-width:900px; max-height:80vh; overflow:auto;'});
  
  // Fetch help content from server
  fetch('/EXPRESSION_REFERENCE.md')
    .then(r => r.text())
    .then(markdown => {
      // Simple markdown rendering
      const lines = markdown.split('\n');
      let html = '';
      let inCodeBlock = false;
      let codeBlockContent = '';
      
      for (let line of lines) {
        // Code blocks
        if (line.startsWith('```')) {
          if (inCodeBlock) {
            html += `<pre style="background:#1a1d2e;padding:10px;border-radius:4px;overflow:auto;font-size:12px;"><code>${codeBlockContent}</code></pre>`;
            codeBlockContent = '';
          }
          inCodeBlock = !inCodeBlock;
          continue;
        }
        
        if (inCodeBlock) {
          codeBlockContent += line + '\n';
          continue;
        }
        
        // Headers
        if (line.startsWith('# ')) {
          html += `<h1 style="color:#7aa2f7;margin-top:20px;border-bottom:2px solid #2a3046;padding-bottom:10px;font-size:24px;">${line.slice(2)}</h1>`;
        } else if (line.startsWith('## ')) {
          html += `<h2 style="color:#7aa2f7;margin-top:15px;font-size:20px;">${line.slice(3)}</h2>`;
        } else if (line.startsWith('### ')) {
          html += `<h3 style="color:#9ece6a;margin-top:10px;font-size:16px;">${line.slice(4)}</h3>`;
        } else if (line.startsWith('---')) {
          html += '<hr style="border:none;border-top:1px solid #2a3046;margin:20px 0;">';
        } else if (line.startsWith('| ') && line.endsWith(' |')) {
          // Table row - simple rendering
          const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
          html += '<div style="display:flex;gap:10px;padding:4px;border-bottom:1px solid #2a3046;">';
          cells.forEach(cell => {
            html += `<div style="flex:1;font-family:monospace;font-size:12px;">${cell}</div>`;
          });
          html += '</div>';
        } else if (line.startsWith('- ')) {
          html += `<li style="margin-left:20px;margin-bottom:5px;">${line.slice(2)}</li>`;
        } else if (line.trim()) {
          // Inline code
          line = line.replace(/`([^`]+)`/g, '<code style="background:#1a1d2e;padding:2px 6px;border-radius:3px;font-family:monospace;font-size:12px;">$1</code>');
          // Bold
          line = line.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#e0af68;">$1</strong>');
          html += `<p style="margin:8px 0;line-height:1.6;">${line}</p>`;
        } else {
          html += '<br>';
        }
      }
      
      root.innerHTML = html;
    })
    .catch(err => {
      // Fallback help if file not found
      root.innerHTML = `
        <h2 style="color:#7aa2f7;font-size:20px;">Expression Language Quick Reference</h2>
        <h3 style="color:#9ece6a;margin-top:15px;">Signal References</h3>
        <pre style="background:#1a1d2e;padding:10px;border-radius:4px;font-size:12px;">
"AI:SignalName"    // Analog Input
"AO:SignalName"    // Analog Output  
"TC:SignalName"    // Thermocouple
"DO:SignalName"    // Digital Output
"PID:LoopName"     // PID Controller
"Math:OpName"      // Math Operator
"LE:ElementName"   // Logic Element
"Expr:ExprName"    // Other Expression</pre>

        <h3 style="color:#9ece6a;margin-top:15px;">PID Properties</h3>
        <pre style="background:#1a1d2e;padding:10px;border-radius:4px;font-size:12px;">
"PID:Name".PV     // Process Variable
"PID:Name".SP     // Setpoint
"PID:Name".ERR    // Error
"PID:Name".OUT    // Output
"PID:Name".MIN    // Min clamp
"PID:Name".MAX    // Max clamp</pre>

        <h3 style="color:#9ece6a;margin-top:15px;">Operators & Control Flow</h3>
        <pre style="background:#1a1d2e;padding:10px;border-radius:4px;font-size:12px;">
Arithmetic: + - * / % ^
Comparison: == != < <= > >=
Boolean: AND OR NOT

IF condition THEN value
IF condition THEN value ELSE other</pre>

        <h3 style="color:#9ece6a;margin-top:15px;">Variables</h3>
        <pre style="background:#1a1d2e;padding:10px;border-radius:4px;font-size:12px;">
x = value              // Local (reset each cycle)
static.x = value       // Persistent in expression
global.x = value       // Persistent across system</pre>

        <h3 style="color:#9ece6a;margin-top:15px;">Hardware Control</h3>
        <pre style="background:#1a1d2e;padding:10px;border-radius:4px;font-size:12px;">
"DO:Name" = 1          // Set digital output ON
"AO:Name" = 5.5        // Set analog output to 5.5V</pre>

        <h3 style="color:#9ece6a;margin-top:15px;">Common Functions</h3>
        <pre style="background:#1a1d2e;padding:10px;border-radius:4px;font-size:12px;">
ABS(x) SQRT(x) MIN(a,b) MAX(a,b) CLAMP(v,min,max)
SIN(x) COS(x) TAN(x) ASIN(x) ACOS(x) ATAN(x)
EXP(x) LOG(x) LOG10(x) POW(base,exp)</pre>

        <p style="margin-top:20px;color:#9094a1;"><em>For complete documentation with examples, ensure EXPRESSION_REFERENCE.md is in the web directory.</em></p>
      `;
    });
  
  showModal(root);
}

function openExpressionDebug(widget) {
  const idx = widget.opts.exprIndex ?? 0;
  
  // Fetch expression config from server
  fetch('/api/expressions')
    .then(r => r.json())
    .then(data => {
      const expr = data.expressions?.[idx];
      
      if (!expr) {
        alert(`Expression ${idx} not found`);
        return;
      }
      
      const source = expr.expression || expr.source || expr.text || '';
      
      // Create modal content
      const root = el('div', {
        style: 'display:flex;flex-direction:column;gap:15px;max-width:95vw;max-height:85vh;'
      });
      
      // Title
      root.append(el('h2', {
        style: 'color:#7aa2f7;margin:0;font-size:20px;'
      }, `🔍 Debug: ${expr.name || `Expression ${idx}`} (Live)`));
      
      // Expression source with live values
      const sourceDiv = el('div', {
        style: 'background:#1a1d2e;padding:15px;border-radius:6px;overflow:auto;font-family:Consolas,Monaco,monospace;font-size:13px;line-height:1.6;white-space:pre;min-height:200px;max-height:60vh;'
      });
      
      root.append(sourceDiv);
      
      // Output section
      const outputDiv = el('div', {
        style: 'background:#2a3046;padding:12px;border-radius:6px;display:flex;align-items:center;gap:10px;'
      });
      root.append(outputDiv);
      
      // Local variables table
      const localsDiv = el('div', {
        style: 'background:#1a1d2e;padding:12px;border-radius:6px;max-height:200px;overflow:auto;'
      });
      root.append(localsDiv);
      
      // Static variables table
      const staticsDiv = el('div', {
        style: 'background:#1a1d2e;padding:12px;border-radius:6px;max-height:200px;overflow:auto;'
      });
      root.append(staticsDiv);
      
      // Update function that runs continuously
      let updateInterval = null;
      
      function updateDebugView() {
        const exprData = state.expr?.[idx];
        if (!exprData) {
          sourceDiv.innerHTML = '<span style="color:#d84a4a;">No live data available</span>';
          return;
        }
        
        const locals = exprData.locals || {};
        const staticVars = exprData.static || {};
        const executedLines = new Set(exprData.executed_lines || []);
        
        // Update source code with annotations
        if (!source) {
          sourceDiv.innerHTML = '<span style="color:#d84a4a;">No live data available</span>';
        } else {
          const lines = source.split('\n');
          let annotated = '';
          
          // Track block stack for nested IFs: [{type: 'then'/'else', line: N}, ...]
          let blockStack = [];
          
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            let line = lines[lineIdx];
            let displayLine = line;
            const trimmed = line.trim().toUpperCase();
            
            // Track block context with a stack
            if (trimmed.startsWith('IF ')) {
              // Check if THEN is on the same line
              const hasThen = trimmed.includes(' THEN');
              // DEBUG DISABLED: //              if (lineIdx < 25) console.log(`[BlockStack] Line ${lineIdx}: IF detected, hasThen=${hasThen}, trimmed="${trimmed.substring(0, 80)}"`);
              if (hasThen) {
                // Inline IF...THEN - push THEN directly
                blockStack.push({type: 'then', line: lineIdx});
              } else {
                // Separate IF line - push IF marker
                blockStack.push({type: 'if', line: lineIdx});
              }
            } else if (trimmed === 'THEN' || trimmed.startsWith('THEN ')) {
              // Standalone THEN - pop IF, push THEN
              if (blockStack.length > 0 && blockStack[blockStack.length - 1].type === 'if') {
                blockStack.pop();
              }
              blockStack.push({type: 'then', line: lineIdx});
            } else if (trimmed === 'ELSE' || trimmed.startsWith('ELSE IF ')) {
              // Check if THEN is on the same line as ELSE IF
              if (trimmed.startsWith('ELSE IF ') && trimmed.includes(' THEN')) {
                // ELSE IF...THEN inline - pop THEN/IF, push ELSE, push new THEN
                if (blockStack.length > 0) {
                  const top = blockStack[blockStack.length - 1];
                  if (top.type === 'then' || top.type === 'if') {
                    blockStack.pop();
                  }
                }
                blockStack.push({type: 'else', line: lineIdx});
                blockStack.push({type: 'then', line: lineIdx});
              } else {
                // Regular ELSE or ELSE IF without inline THEN
                if (blockStack.length > 0) {
                  const top = blockStack[blockStack.length - 1];
                  if (top.type === 'then' || top.type === 'if') {
                    blockStack.pop();
                  }
                }
                blockStack.push({type: 'else', line: lineIdx});
              }
            } else if (trimmed === 'ENDIF') {
              // Pop the innermost THEN/ELSE block
              if (blockStack.length > 0) {
                const top = blockStack[blockStack.length - 1];
                if (top.type === 'then' || top.type === 'else') {
                  blockStack.pop();
                }
              }
            }
            
            // Determine color based on innermost non-IF block
            let currentBlock = null;
            for (let i = blockStack.length - 1; i >= 0; i--) {
              if (blockStack[i].type === 'then' || blockStack[i].type === 'else') {
                currentBlock = blockStack[i].type;
                break;
              }
            }
            
            // Check if this line executed AND is in a branch
            const lineExecuted = executedLines.has(lineIdx);
            const isInBranch = currentBlock !== null && 
                              !trimmed.startsWith('IF ') && 
                              trimmed !== 'THEN' && !trimmed.startsWith('THEN ') &&
                              trimmed !== 'ELSE' && !trimmed.startsWith('ELSE IF ') && !trimmed.startsWith('ELSE ') &&
                              trimmed !== 'ENDIF';
            
            // Debug logging for assignment lines
            if (line.match(/^\s*\w+\s*=/) || line.match(/^\s*static\.\w+\s*=/)) {
              // DEBUG DISABLED: //              console.log(`[ExprDebug] Line ${lineIdx}: "${line.trim()}" - executed=${lineExecuted}, isInBranch=${isInBranch}, currentBlock=${currentBlock}, blockStack=[${blockStack.map(b => b.type).join(',')}]`);
            }
            
            // Color the line if it executed and is in a branch
            if (lineExecuted && isInBranch) {
              const lineColor = currentBlock === 'then' ? '#2faa60' : '#d84a4a';
              displayLine = `<span style="color:${lineColor};">${line}</span>`;
            }
            
            // Add value annotations
            const assignMatch = line.match(/^\s*(\w+)\s*=\s*(.+?)(?:\/\/.*)?$/);
            const staticMatch = line.match(/^\s*static\.(\w+)\s*=\s*(.+?)(?:\/\/.*)?$/);
            
            if (staticMatch) {
              const varName = staticMatch[1];
              const value = staticVars[varName];
              if (value !== undefined) {
                const valueStr = typeof value === 'number' ? value.toFixed(4) : String(value);
                const color = getValueColor(value);
                if (lineExecuted && isInBranch) {
                  displayLine = displayLine.replace('</span>', ` <span style="color:${color};background:#2a3046;padding:1px 6px;border-radius:3px;font-size:11px;">{${valueStr}}</span></span>`);
                } else {
                  displayLine = displayLine.replace(new RegExp(`^(\\s*static\\.${varName})\\s*=`), 
                    `$1 <span style="color:${color};background:#2a3046;padding:1px 6px;border-radius:3px;font-size:11px;">{${valueStr}}</span> =`);
                }
              }
            } else if (assignMatch) {
              const varName = assignMatch[1];
              const value = locals[varName];
              if (value !== undefined) {
                const valueStr = typeof value === 'number' ? value.toFixed(4) : String(value);
                const color = getValueColor(value);
                if (lineExecuted && isInBranch) {
                  displayLine = displayLine.replace('</span>', ` <span style="color:${color};background:#2a3046;padding:1px 6px;border-radius:3px;font-size:11px;">{${valueStr}}</span></span>`);
                } else {
                  displayLine = displayLine.replace(new RegExp(`^(\\s*${varName})\\s*=`), 
                    `$1 <span style="color:${color};background:#2a3046;padding:1px 6px;border-radius:3px;font-size:11px;">{${valueStr}}</span> =`);
                }
              }
            } else {
              // Add variable reference annotations for non-assignment lines
              for (const [varName, value] of Object.entries(locals)) {
                const regex = new RegExp(`\\b${varName}\\b(?![:{])`, 'g');
                if (regex.test(line)) {
                  const valueStr = typeof value === 'number' ? value.toFixed(4) : String(value);
                  const color = getValueColor(value);
                  displayLine = displayLine.replace(regex, `${varName}<span style="color:${color};background:#2a3046;padding:1px 6px;border-radius:3px;font-size:11px;margin-left:4px;">{${valueStr}}</span>`);
                }
              }
            }
            
            annotated += displayLine + '\n';
          }
          
          sourceDiv.innerHTML = annotated;
        }
        
        // Update output
        const output = exprData.output !== undefined ? exprData.output : 0;
        const outputColor = getValueColor(output);
        outputDiv.innerHTML = `
          <span style="font-size:14px;color:#9aa1b9;">► Output:</span>
          <span style="font-size:16px;font-weight:bold;color:${outputColor};">${typeof output === 'number' ? output.toFixed(4) : String(output)}</span>
        `;
        
        // Update locals table
        const localEntries = Object.entries(locals);
        if (localEntries.length > 0) {
          localsDiv.innerHTML = `
            <div style="font-size:12px;color:#7aa2f7;margin-bottom:8px;font-weight:bold;">Local Variables:</div>
            <table style="width:100%;font-size:11px;font-family:Consolas,Monaco,monospace;">
              ${localEntries.map(([name, val]) => {
                const valStr = typeof val === 'number' ? val.toFixed(4) : String(val);
                const color = getValueColor(val);
                return `<tr>
                  <td style="color:#9aa1b9;padding:2px 8px 2px 0;">${name}</td>
                  <td style="color:${color};padding:2px 0;text-align:right;">${valStr}</td>
                </tr>`;
              }).join('')}
            </table>
          `;
        } else {
          localsDiv.innerHTML = '<div style="font-size:12px;color:#666;">No local variables</div>';
        }
        
        // Update statics table
        const staticEntries = Object.entries(staticVars);
        if (staticEntries.length > 0) {
          staticsDiv.innerHTML = `
            <div style="font-size:12px;color:#7aa2f7;margin-bottom:8px;font-weight:bold;">Static Variables:</div>
            <table style="width:100%;font-size:11px;font-family:Consolas,Monaco,monospace;">
              ${staticEntries.map(([name, val]) => {
                const valStr = typeof val === 'number' ? val.toFixed(4) : String(val);
                const color = getValueColor(val);
                return `<tr>
                  <td style="color:#9aa1b9;padding:2px 8px 2px 0;">static.${name}</td>
                  <td style="color:${color};padding:2px 0;text-align:right;">${valStr}</td>
                </tr>`;
              }).join('')}
            </table>
          `;
        } else {
          staticsDiv.innerHTML = '<div style="font-size:12px;color:#666;">No static variables</div>';
        }
      }
      
      // Initial update
      updateDebugView();
      
      // Update every 100ms for live values
      updateInterval = setInterval(updateDebugView, 100);
      
      // Show modal with cleanup on close
      showModal(root, () => {
        if (updateInterval) {
          clearInterval(updateInterval);
          updateInterval = null;
        }
      });
    })
    .catch(err => {
      // DEBUG DISABLED: //      console.error('[ExprDebug] Error:', err);
      alert('Failed to load expression: ' + err.message);
    });
}

/* ----------------------------- Expression Editor -------------------------------- */
/* ----------------------------- Expression Editor -------------------------------- */
async function openExpressionEditor() {
  let expressions = [];
  
  // Load expressions from server
  try {
    const resp = await fetch('/api/expressions');
    const data = await resp.json();
    expressions = data.expressions || [];
  } catch (e) {
    console.error('Failed to load expressions:', e);
  }
  
  const root = el('div', {});
  const title = el('h2', {}, 'Expression Editor');
  
  // ADD: Load button at top
  const topButtons = el('div', {style: 'display:flex; gap:8px; margin-bottom:12px;'});
  const loadBtn = el('button', {
    className: 'btn',
    onclick: () => {
      const inp = el('input', {type: 'file', accept: '.json'});
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (!f) return;
        try {
          const text = await f.text();
          const loaded = JSON.parse(text);
          expressions = loaded.expressions || [];
          renderList();
          if (expressions.length > 0) {
            selectExpression(expressions[0]);
          }
          alert(`Loaded ${expressions.length} expressions from ${f.name}`);
        } catch(e) {
          alert('Failed to load: ' + e.message);
        }
      };
      inp.click();
    }
  }, '📁 Load from File');
  topButtons.append(loadBtn);
  
  const container = el('div', {style: 'display:flex; gap:20px; height:60vh;'});
  
  // Left panel: Expression list
  const listPanel = el('div', {style: 'flex:1; display:flex; flex-direction:column; gap:10px; overflow:auto;'});
  
  // Right panel: Editor
  const editorPanel = el('div', {style: 'flex:2; display:flex; flex-direction:column; gap:10px;'});
  
  let selectedExpr = null;
  
  function renderList() {
    listPanel.innerHTML = '';
    
    const addBtn = el('button', {
      className: 'btn',
      onclick: () => {
        const name = prompt('Expression name:');
        if (!name) return;
        expressions.push({
          name: name,
          enabled: true,
          expression: '// Write your expression here\n0',
          execution_rate_hz: null  // ADD: Initialize new field
        });
        renderList();
        selectExpression(expressions[expressions.length - 1]);
      }
    }, '+ Add Expression');
    
    listPanel.append(addBtn);
    
    expressions.forEach((expr, idx) => {
      const card = el('div', {
        style: `padding:10px; border:1px solid ${selectedExpr === expr ? '#4a9eff' : '#2a3046'}; border-radius:6px; cursor:pointer; background:${selectedExpr === expr ? '#1a2030' : 'transparent'}`,
        onclick: () => selectExpression(expr)
      });
      
      const title = el('div', {style: 'font-weight:bold; margin-bottom:5px;'}, expr.name);
      
      // ADD: Show execution rate if set
      const rateText = expr.execution_rate_hz ? ` @ ${expr.execution_rate_hz}Hz` : '';
      const status = el('div', {style: `font-size:12px; color:${expr.enabled ? '#4a9eff' : '#666'}`}, 
        (expr.enabled ? '✓ Enabled' : '✗ Disabled') + rateText);
      
      card.append(title, status);
      listPanel.append(card);
    });
  }
  
  function selectExpression(expr) {
    selectedExpr = expr;
    renderList();
    renderEditor();
  }
  
  function renderEditor() {
    editorPanel.innerHTML = '';
    
    if (!selectedExpr) {
      editorPanel.append(el('div', {style: 'color:#666; text-align:center; margin-top:50px;'}, 
        'Select an expression to edit'));
      return;
    }
    
    // Expression name and enabled
    const topRow = el('div', {className: 'row', style: 'margin-bottom:10px;'});
    topRow.append(
      el('label', {style: 'flex:1'}, [
        'Name: ',
        el('input', {
          type: 'text',
          value: selectedExpr.name,
          oninput: e => {
            selectedExpr.name = e.target.value;
            renderList();  // Update list when name changes
          },
          style: 'width:100%;'
        })
      ]),
      el('label', {}, [
        el('input', {
          type: 'checkbox',
          checked: selectedExpr.enabled,
          onchange: e => {
            selectedExpr.enabled = e.target.checked;
            renderList();  // Update list when enabled changes
          }
        }),
        ' Enabled'
      ])
    );
    editorPanel.append(topRow);
    
    // ADD: Execution rate row (small, unobtrusive)
    const rateRow = el('div', {style: 'margin-bottom:10px; display:flex; align-items:center; gap:8px;'});
    rateRow.append(
      el('label', {style: 'font-size:12px; color:#8b949e;'}, 'Execution Rate:'),
      el('input', {
        type: 'number',
        min: '0',
        step: '1',
        placeholder: 'Hz (empty = sample rate)',
        value: selectedExpr.execution_rate_hz || '',
        oninput: e => {
          const val = parseFloat(e.target.value);
          selectedExpr.execution_rate_hz = (val > 0) ? val : null;
          renderList();
        },
        style: 'width:100px; padding:4px; font-size:12px;'
      }),
      el('span', {style: 'font-size:11px; color:#666;'}, 'Hz')
    );
    editorPanel.append(rateRow);
    
    // Expression textarea - KEEP ORIGINAL STYLING
    const textareaLabel = el('div', {style: 'font-weight:bold; margin-bottom:5px;'}, 'Expression:');
    const textarea = el('textarea', {
      value: selectedExpr.expression || '',
      oninput: e => selectedExpr.expression = e.target.value,
      style: 'width:100%; height:450px; font-family:monospace; font-size:14px; background:#0d1117; color:#c9d1d9; border:1px solid #2a3046; border-radius:6px; padding:10px;'
    });
    
    editorPanel.append(textareaLabel, textarea);
    
    // Syntax check button and result - KEEP ORIGINAL GREEN/RED STYLING
    const syntaxRow = el('div', {style: 'display:flex; gap:10px; align-items:center;'});
    const syntaxResult = el('div', {style: 'flex:1; padding:10px; border-radius:6px; font-size:14px; font-family:monospace;'});
    
    const checkBtn = el('button', {
      className: 'btn',
      onclick: async () => {
        try {
          const resp = await fetch('/api/expressions/check', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({expression: selectedExpr.expression})
          });
          const result = await resp.json();
          
          if (result.ok) {
            // GREEN for success
            syntaxResult.style.background = '#1a3a1a';
            syntaxResult.style.color = '#4a9';
            let message = `✓ Syntax OK - Result: ${result.result.toFixed(4)}`;
            
            if (result.locals && Object.keys(result.locals).length > 0) {
              message += `\nLocal vars: ${JSON.stringify(result.locals, null, 2)}`;
            }
            
            // Display warnings if any
            if (result.warnings && result.warnings.length > 0) {
              message += '\n\n⚠️ WARNINGS:\n';
              result.warnings.forEach(w => {
                message += `  ${w.message}\n`;
              });
            }
            
            syntaxResult.textContent = message;
          } else {
            // RED for error with X
            syntaxResult.style.background = '#3a1a1a';
            syntaxResult.style.color = '#f88';
            syntaxResult.textContent = `✗ Error: ${result.error}`;
          }
        } catch (e) {
          syntaxResult.style.background = '#3a1a1a';
          syntaxResult.style.color = '#f88';
          syntaxResult.textContent = `✗ Failed to check: ${e.message}`;
        }
      }
    }, '🔍 Check Syntax');
    
    syntaxRow.append(checkBtn, syntaxResult);
    editorPanel.append(syntaxRow);
    
    // Delete button
    const deleteBtn = el('button', {
      className: 'btn danger',
      onclick: () => {
        if (confirm(`Delete expression "${selectedExpr.name}"?`)) {
          const idx = expressions.indexOf(selectedExpr);
          expressions.splice(idx, 1);
          selectedExpr = null;
          renderList();
          renderEditor();
        }
      }
    }, '🗑 Delete');
    
    editorPanel.append(deleteBtn);
    

  }
  
  container.append(listPanel, editorPanel);
  
  // Global variables viewer
  const globalsSection = el('div', {style: 'margin-top:20px; padding:15px; background:#1a2030; border-radius:6px;'});
  const globalsTitle = el('div', {style: 'font-weight:bold; margin-bottom:10px;'}, 'Global Variables (static.*)');
  const globalsTable = el('table', {className: 'form', style: 'width:100%;'});
  
  async function refreshGlobals() {
    try {
      const resp = await fetch('/api/expressions/globals');
      const data = await resp.json();
      
      globalsTable.innerHTML = '';
      const thead = el('thead');
      thead.append(el('tr', {}, [
        el('th', {}, 'Name'),
        el('th', {}, 'Value'),
        el('th', {}, 'Actions')
      ]));
      globalsTable.append(thead);
      
      const tbody = el('tbody');
      const globals = data.globals || {};
      
      if (Object.keys(globals).length === 0) {
        tbody.append(el('tr', {}, [
          el('td', {colspan: 3, style: 'text-align:center; color:#666;'}, 'No global variables yet')
        ]));
      } else {
        Object.entries(globals).forEach(([name, value]) => {
          const tr = el('tr', {}, [
            el('td', {}, `static.${name}`),
            el('td', {}, value.toFixed(4)),
            el('td', {}, el('button', {
              className: 'btn danger',
              onclick: async () => {
                if (confirm(`Delete static.${name}?`)) {
                  await fetch('/api/expressions/globals', {
                    method: 'DELETE',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name: name})
                  });
                  refreshGlobals();
                }
              }
            }, '×'))
          ]);
          tbody.append(tr);
        });
      }
      
      globalsTable.append(tbody);
    } catch (e) {
      console.error('Failed to load globals:', e);
    }
  }
  
  const clearGlobalsBtn = el('button', {
    className: 'btn danger',
    onclick: async () => {
      if (confirm('Clear ALL global variables?')) {
        await fetch('/api/expressions/globals/clear', {method: 'POST'});
        refreshGlobals();
      }
    },
    style: 'margin-top:10px;'
  }, 'Clear All Globals');
  
  globalsSection.append(globalsTitle, globalsTable, clearGlobalsBtn);
  
  // Initial render
  renderList();
  renderEditor();
  refreshGlobals();
  
  // Save and Save As buttons
  const saveButtons = el('div', {style: 'display:flex; gap:8px; margin-top:20px;'});
  
  const saveBtn = el('button', {
    className: 'btn',
    onclick: async () => {
      try {
        const resp = await fetch('/api/expressions', {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({expressions: expressions})
        });
        const result = await resp.json();
        if (result.ok) {
          alert('Expressions saved!');
        } else {
          alert('Failed to save: ' + result.error);
        }
      } catch (e) {
        alert('Failed to save: ' + e.message);
      }
    }
  }, '💾 Save');
  
  const reloadBtn = el('button', {
    className: 'btn',
    onclick: async () => {
      try {
        const resp = await fetch('/api/expressions/reload', {method: 'POST'});
        const result = await resp.json();
        if (result.ok) {
          alert(`✅ Reloaded ${result.count} expressions! No server restart needed.`);
        } else {
          alert('Failed to reload: ' + result.error);
        }
      } catch (e) {
        alert('Failed to reload: ' + e.message);
      }
    }
  }, '🔄 Hot Reload');
  
  const saveAsBtn = el('button', {
    className: 'btn',
    onclick: () => {
      // Create JSON data
      const data = JSON.stringify({expressions: expressions}, null, 2);
      const blob = new Blob([data], {type: 'application/json'});
      const url = URL.createObjectURL(blob);
      
      // Trigger download - Firefox will show native "Save As" dialog
      const a = document.createElement('a');
      a.href = url;
      a.download = 'expressions.json';  // Default filename
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      URL.revokeObjectURL(url);
    }
  }, '💾 Save As...');
  
  saveButtons.append(saveBtn, reloadBtn, saveAsBtn);
  
  root.append(title, topButtons, container, globalsSection, saveButtons);
  showModal(root);
}


/* ----------------------------- form bits -------------------------------- */
function fieldset(title, inner) {
  const fs = el('fieldset', {});
  fs.append(el('legend', {}, title), inner);
  return fs;
}
