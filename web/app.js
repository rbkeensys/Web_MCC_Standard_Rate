// app.js – UI v0.9.4 - PART 1 OF 2
const UI_VERSION = "0.13.3";  // Added AO to PID source options

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
  if (msg.ai)  state.ai  = msg.ai;
  if (msg.ao)  state.ao  = msg.ao;
  if (msg.do)  state.do  = msg.do;
  if (msg.tc)  state.tc  = msg.tc;
  if (msg.pid) state.pid = msg.pid;
  if (msg.motors) state.motors = msg.motors;
  if (msg.le) state.le = msg.le;  // Logic Elements
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
  $('#fullscreenBtn')?.addEventListener('click', toggleFullscreen);
  $('#exitFullscreenBtn')?.addEventListener('click', toggleFullscreen);
  $('#editConfig')?.addEventListener('click', ()=>openConfigForm());
  $('#editPID')?.addEventListener('click', ()=>openPidForm());
  $('#editMotor')?.addEventListener('click', ()=>openMotorEditor());
  $('#editLE')?.addEventListener('click', ()=>openLEEditor());  // Logic Elements
  $('#editScript')?.addEventListener('click', ()=>openScriptEditor());
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
  
  // Custom default sizes for different widget types
  let defaultW = 460, defaultH = 280;
  if (type === 'gauge') {
    defaultH = 340;
  } else if (type === 'dobutton') {
    defaultW = 120;
    defaultH = 90;
  } else if (type === 'le') {
    defaultW = 280;  // Compact for LE
    defaultH = 160;
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

// Update defaultsFor to give charts reasonable initial spans:
function defaultsFor(type){
  switch(type){
    case 'chart':    return { title:'Chart', series:[], span:60, paused:false, scale:'auto', min:0, max:10, filterHz:0, cursorMode:'follow' };
    case 'gauge':    return { title:'Gauge', needles:[], scale:'manual', min:0, max:10 };
    case 'bars':     return { title:'Bars', series:[], scale:'manual', min:0, max:10 };
    case 'dobutton': return { title:'DO', doIndex:0, activeHigh:true, mode:'toggle', buzzHz:10, actuationTime:0, _timer:null };
    case 'pidpanel': return { title:'PID', loopIndex:0, showControls:true };
    case 'aoslider': return { title:'AO', aoIndex:0, min:0, max:10, step:0.0025, live:true };
    case 'motor':    return { title:'Motor', motorIndex:0, showControls:true };
  }
  return {};
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
  const classList = w.type === 'dobutton' ? 'widget dobutton-widget' : 'widget';
  const box=el('div',{className:classList, id:'w_'+w.id});
  
  // LE widgets don't need settings - only close button
  const toolButtons = w.type === 'le' 
    ? [el('span',{className:'icon', title:'Close', onclick:()=>removeWidget(w.id)}, '×')]
    : [
        el('span',{className:'icon', title:'Settings', onclick:()=>openWidgetSettings(w)}, '⚙'),
        el('span',{className:'icon', title:'Close',    onclick:()=>removeWidget(w.id)}, '×')
      ];
  
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
        for (const b of viewBuf){
          const y = b.v[si];
          if (y < ymin) ymin = y;
          if (y > ymax) ymax = y;
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
        ctx.beginPath();
        let first = true;
        for (const b of viewBuf){
          const x = plotL + (b.t - t0) * xscale;
          const y = plotB - (b.v[si] - ymin) * yscale;
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
    if(sel.kind==='ai'){ return configCache.analogs?.[sel.index]?.name || `AI${sel.index}`; }
    if(sel.kind==='ao'){ return configCache.analogOutputs?.[sel.index]?.name || `AO${sel.index}`; }
    if(sel.kind==='do'){ return configCache.digitalOutputs?.[sel.index]?.name || `DO${sel.index}`; }
    if(sel.kind==='tc'){ return configCache.thermocouples?.[sel.index]?.name || `TC${sel.index}`; }
    if(sel.kind==='pid'){ 
      // Fetch PID name from cache if available
      if (window.pidCache && window.pidCache.loops && window.pidCache.loops[sel.index]) {
        return window.pidCache.loops[sel.index].name || `PID${sel.index}`;
      }
      return `PID${sel.index}`;
    }
  }catch{}
  return `${sel.kind.toUpperCase()}${sel.index}`;
}

/* ------------------------------- gauge ---------------------------------- */
function mountGauge(w, body){
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
      const vals=(w.opts.needles||[]).map(sel=>readSelection(sel));
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
    const tickCount=10;
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

      const val=(lo + t*span).toFixed(2);
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
      const frac = clamp((v - lo)/span, 0, 1);
      const ang = Math.PI + (0 - Math.PI) * frac;
      const nx = Math.cos(ang), ny = Math.sin(ang);
      ctx.strokeStyle=colorFor(si);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + (rInner + band*0.9)*nx, cy - (rInner + band*0.9)*ny);
      ctx.stroke();

      const lab = s.name && s.name.length ? s.name : labelFor(s);
      legend.append(el('div',{className:'item'},[
        el('span',{className:'swatch', style:`background:${colorFor(si)}`},''), `${lab}: ${Number.isFinite(v)?v.toFixed(3):'—'}`
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
      const vals = (w.opts.series || []).map(sel => readSelection(sel));
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
    const barW = Math.max(10, (plotR - plotL) / N - 10);

    // Draw bars
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';

    series.forEach((sel, idx) => {
      const v = readSelection(sel);
      const t = Math.max(0, Math.min(1, (v - lo) / span));
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
      if (Number.isFinite(v)) {
        ctx.fillStyle = '#e6e6e6';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(v.toFixed(2), x, y - 2);
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
  const b=el('button',{className:'do-btn default'}, w.opts.title||'DO');
  body.append(b);

  let actTimer=null;
  let isDown = false;        // only this widget acts on global pointerup/blur
  let buzzing = false;       // (keep your existing buzzing if present)

  const clearActTimer=()=>{ if (actTimer){ clearTimeout(actTimer); actTimer=null; } };

  const setRaw = async(bit)=>{
    try{
      await fetch('/api/do/set',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({index:w.opts.doIndex, state:!!bit, active_high:!!w.opts.activeHigh})
      });
    }catch(e){ console.warn('DO set failed', e); }
  };

  const startBuzz = async()=>{
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
    const bit=state.do[w.opts.doIndex]|0;     // current RAW bit
    const want=!bit;                          // flip
    await setRaw(want);
    const ms = Math.max(0, (w.opts.actuationTime||0)*1000);
    if (ms>0){
      const original=bit;                     // restore original raw state after pulse
      actTimer=setTimeout(()=>{ setRaw(original); }, ms);
    }
  });

  // Momentary & Buzz via pointer events
  const onDown = ()=>{
    if (!connected) return;
    if (isDown) return;        // ignore repeats
    isDown = true;
    if (w.opts.mode === 'momentary'){ clearActTimer(); setRaw(1); }
    if (w.opts.mode === 'buzz'){ stopBuzz().finally(startBuzz); }
  };

  const onUp = ()=>{
    if (!connected) return;
    if (!isDown) return;       // only the pressed widget reacts
    isDown = false;

    if (w.opts.mode === 'momentary'){ setRaw(0); }
    if (w.opts.mode === 'buzz'){
      stopBuzz().finally(()=>{
        setRaw(0).finally(()=>{ setTimeout(()=>stopBuzz(), 150); });
      });
    }
  };


  b.addEventListener('pointerdown', onDown);
  b.addEventListener('pointerup', onUp);
  b.addEventListener('pointerleave', onUp);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('blur', onUp);
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden) onUp(); });
  // extra safety: stop buzz if we ever disconnect
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
    const bit=state.do[w.opts.doIndex]|0;
    const active=logicalActive(bit, !!w.opts.activeHigh);
    b.className='do-btn '+(active?'active':'inactive');
    b.textContent = w.opts.title || 'DO';
  });
}

/* -------------------------------- PID ----------------------------------- */
// This version adds a "Reset I" button next to the Apply button

function mountPIDPanel(w, body){
  const line=el('div',{className:'small', id:'pid_'+w.id, style:'display:inline-block'}, 'pv=—, err=—, out=—');

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
    const row=(label,input)=>{ const tr=el('tr'); tr.append(el('th',{},label), el('td',{},input)); tb.append(tr); };
    const L={enabled:false,name:'',kind:'analog',src:'ai',ai_ch:0,out_ch:0,target:0,kp:0,ki:0,kd:0,out_min:0,out_max:1,err_min:-1,err_max:1,i_min:-1,i_max:1,enable_gate:false,enable_kind:'do',enable_index:0};

    fetch('/api/pid').then(r=>r.json()).then(pid=>{
      const idx=w.opts.loopIndex|0; Object.assign(L, pid.loops?.[idx]||{});
      const selKind=selectEnum(['analog','digital','var'], L.kind||'analog', v=>L.kind=v);
      const selSrc =selectEnum(['ai','ao','tc','pid'], L.src ||'ai',    v=>L.src=v);
      row('enabled', chk(L,'enabled'));
      row('name', txt(L,'name'));
      row('kind', selKind);
      row('src',  selSrc);
      row('ai_ch',  num(L,'ai_ch',1));
      row('out_ch', num(L,'out_ch',1));
      row('target', num(L,'target',0.0001));
      row('kp',     num(L,'kp',0.0001));
      row('ki',     num(L,'ki',0.0001));
      row('kd',     num(L,'kd',0.0001));
      row('out_min',num(L,'out_min',0.0001));
      row('out_max',num(L,'out_max',0.0001));
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

      const resetI=el('button',{
        className:'btn',
        style:'margin-left:8px',
        onclick:async()=>{
          try {
            const resp = await fetch('/api/pid/reset_i', {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({loop_index: w.opts.loopIndex|0})
            });
            const result = await resp.json();
            if (result.ok) {
              console.log('PID integral term reset:', result.message);
              // Optional: show brief visual feedback
              resetI.style.background = '#2faa60';
              setTimeout(() => { resetI.style.background = ''; }, 300);
            } else {
              console.error('Failed to reset integral:', result.error);
              alert('Failed to reset integral: ' + result.error);
            }
          } catch(e) {
            console.error('Reset I failed:', e);
            alert('Reset I failed: ' + e.message);
          }
        }
      }, 'Reset I');

      ctr.append(tbl, el('div',{style:'margin-top:6px'}, [save, resetI]));
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
        let enabled = false;

        if (pidConfig.enable_kind === 'do') {
          enabled = state.do?.[pidConfig.enable_index] ? true : false;
        } else if (pidConfig.enable_kind === 'le') {
          enabled = state.le?.[pidConfig.enable_index]?.output ? true : false;
        }

        const statusText = enabled ? '1' : '0';
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
        const rawVal = state.tc?.[ch] ?? 0;
        const comp = inputCfg.comparison || 'gt';
        let compVal = 0;
        
        if (inputCfg.compare_to_type === 'signal') {
          const cKind = inputCfg.compare_to_kind || 'ai';
          const cCh = inputCfg.compare_to_index || 0;
          if (cKind === 'ai') compVal = state.ai?.[cCh] ?? 0;
          else if (cKind === 'ao') compVal = state.ao?.[cCh] ?? 0;
          else if (cKind === 'tc') compVal = state.tc?.[cCh] ?? 0;
          else if (cKind === 'pid_u') compVal = state.pid?.[cCh]?.u ?? 0;
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
      
      return {label: '?', val: '?', detail: ''};
    };
    
    const inA = getInputInfo(leConfig.input_a);
    const inB = getInputInfo(leConfig.input_b);
    const output = le.output ? '1' : '0';
    const op = (leConfig.operation || 'and').toUpperCase();
    
    // Compact 5-box layout: [A][OP][B][=][OUT]
    body.innerHTML = `
      <div style="display:flex;gap:2px;justify-content:center;align-items:center;height:100%">
        <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;min-width:45px">
          <div style="font-size:8px;color:#79c0ff;line-height:1.2">${inA.label}</div>
          <div style="font-size:20px;font-weight:bold;line-height:1.2;color:${inA.val==='1'?'#2faa60':'#d84a4a'}">${inA.val}</div>
          ${inA.detail ? `<div style="font-size:7px;color:#7a7f8f;line-height:1.2;margin-top:1px">${inA.detail}</div>` : ''}
        </div>
        <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;min-width:35px">
          <div style="font-size:11px;font-weight:bold;color:#e0af68;line-height:1.4">${op}</div>
        </div>
        <div style="text-align:center;padding:3px;border:1px solid #2a3046;border-radius:3px;background:#1a1d2e;min-width:45px">
          <div style="font-size:8px;color:#79c0ff;line-height:1.2">${inB.label}</div>
          <div style="font-size:20px;font-weight:bold;line-height:1.2;color:${inB.val==='1'?'#2faa60':'#d84a4a'}">${inB.val}</div>
          ${inB.detail ? `<div style="font-size:7px;color:#7a7f8f;line-height:1.2;margin-top:1px">${inB.detail}</div>` : ''}
        </div>
        <div style="text-align:center;padding:3px;min-width:10px">
          <div style="font-size:14px;color:#9aa1b9;line-height:1.4">=</div>
        </div>
        <div style="text-align:center;padding:3px;border:2px solid ${output==='1'?'#2faa60':'#d84a4a'};border-radius:3px;background:#1a1d2e;min-width:40px">
          <div style="font-size:8px;color:#9aa1b9;line-height:1.2">OUT</div>
          <div style="font-size:22px;font-weight:bold;line-height:1.2;color:${output==='1'?'#2faa60':'#d84a4a'}">${output}</div>
        </div>
      </div>
    `;
    
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
  }
  return 0;
}

// drag/resize — block drag when interacting with inputs
function makeDragResize(node, w, header, handle){
  let dragging=false,resizing=false,sx=0,sy=0,ox=0,oy=0,ow=0,oh=0;
  
  // Set minimum sizes based on widget type
  const minW = (w.type === 'dobutton') ? 70 : 280;
  const minH = (w.type === 'dobutton') ? 45 : 180;
  
  header.addEventListener('mousedown', (e)=>{
    const tag=(e.target.tagName||'').toUpperCase();
    if (['INPUT','SELECT','BUTTON','TEXTAREA','LABEL','OPTION','SPAN'].includes(tag)) return;
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
        w.opts.title     = w.opts.title ?? 'DO';
        w.opts.doIndex   = Number.isInteger(w.opts.doIndex) ? w.opts.doIndex : 0;
        w.opts.activeHigh= (w.opts.activeHigh !== false);
        w.opts.mode      = w.opts.mode ?? 'momentary'; // 'momentary' | 'toggle' | 'buzz'
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

async function openConfigForm(){
  const cfg=await (await fetch('/api/config')).json();
  configCache = cfg;
  const root=el('div',{});

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
          // Reload the form with loaded data
          Object.assign(cfg, loaded);
          root.innerHTML = '';
          // Rebuild form (simplified - you'd call this recursively)
          alert('Config loaded! Close and reopen to see changes, or click Save to apply.');
        } catch(e) {
          alert('Failed to load config: ' + e.message);
        }
      };
      inp.click();
    }
  }, '📁 Load from File');

  const boards=fieldset('Boards', tableForm([
    ['E-1608 boardNum',     inputNum(cfg.board1608,'boardNum',0)],
    ['E-1608 sampleRateHz', inputNum(cfg.board1608,'sampleRateHz',1)],
    ['E-1608 blockSize',    inputNum(cfg.board1608,'blockSize',1)],
    ['E-TC boardNum',       inputNum(cfg.boardetc,'boardNum',0)],
    ['E-TC sampleRateHz',   inputNum(cfg.boardetc,'sampleRateHz',1)],
    ['E-TC blockSize',      inputNum(cfg.boardetc,'blockSize',1)]
  ]));

  const analogRows=(cfg.analogs||[]).map((a,i)=>[
    `AI${i} name`, inputText(a,'name'),
    `slope`,      inputNum(a,'slope',0.000001),
    `offset`,     inputNum(a,'offset',0.000001),
    `cutoffHz`,   inputNum(a,'cutoffHz',0.1),
    `units`,      inputText(a,'units'),
    `include`,    inputChk(a,'include')
  ]);
  const analogs=fieldset('Analogs (server scales Y = m·X + b)', tableFormRows(analogRows));

  (cfg.digitalOutputs||[]).forEach(d=>{ if(!d.mode){ d.mode = d.momentary ? 'momentary' : 'toggle'; } });
  const DO_MODES=['toggle','momentary','buzz'];
  const doRows=(cfg.digitalOutputs||[]).map((d,i)=>[
    `DO${i} name`, inputText(d,'name'),
    `mode`,        selectEnum(DO_MODES,d.mode||'toggle',v=>{ d.mode=v; d.momentary = (v==='momentary'); }),
    `normallyOpen`,inputChk(d,'normallyOpen'),
    `actuationTime (s, toggle only)`, inputNum(d,'actuationTime',0.1),
    `include`,     inputChk(d,'include')
  ]);
  const dig=fieldset('Digital Outputs', tableFormRows(doRows));

  const aoRows=(cfg.analogOutputs||[]).map((a,i)=>[
    `AO${i} name`, inputText(a,'name'),
    `minV`,        inputNum(a,'minV',0.001),
    `maxV`,        inputNum(a,'maxV',0.001),
    `startupV`,    inputNum(a,'startupV',0.001),
    `enable gate`, inputChk(a,'enable_gate'),
    `gate type`,   selectEnum(['do','le'], a.enable_kind||'do', v=>a.enable_kind=v),
    `gate index`,  inputNum(a,'enable_index',1),
    `include`,     inputChk(a,'include')
  ]);
  const aos=fieldset('Analog Outputs (0–10 V)', tableFormRows(aoRows));

  const tcRows=(cfg.thermocouples||[]).map((t,i)=>[
    `TC${i} include`, inputChk(t,'include'),
    `ch`,             inputNum(t,'ch',1),
    `name`,           inputText(t,'name'),
    `type`,           selectEnum(['K','J','T','E','R','S','B','N','C'], t.type||'K', v=>t.type=v),
    `offset`,         inputNum(t,'offset',0.001),
    `cutoffHz`,       inputNum(t,'cutoffHz',0.1)
  ]);
  const tcs=fieldset('Thermocouples', tableFormRows(tcRows));

  const save=el('button',{className:'btn',onclick:async()=>{
    try{ await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)}); alert('Saved'); }
    catch(e){ alert('Save failed: '+e.message); }
  }},'Save');

  root.append(
    el('div', {style: 'display:flex;gap:8px;margin-bottom:12px'}, [loadBtn]),
    boards,analogs,dig,aos,tcs,
    el('div',{style:'margin-top:8px'}, save)
  );
  showModal(root, ()=>{ renderPage(); });
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
          Object.assign(pid, loaded);
          alert('PID config loaded! Close and reopen to see changes, or click Save to apply.');
        } catch(e) {
          alert('Failed to load PID: ' + e.message);
        }
      };
      inp.click();
    }
  }, '📁 Load from File');

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
        kp: 1.0,
        ki: 0.0,
        kd: 0.0,
        out_min: -10.0,
        out_max: 10.0,
        err_min: null,
        err_max: null,
        i_min: null,
        i_max: null,
        name: `Loop${loops.length}`,
        enable_gate: false,
        enable_kind: 'do',
        enable_index: 0
      });
      // Rebuild the form
      buildForm();
    }
  }, '+ Add Loop');

  const formContainer = el('div', {});

  const buildForm = () => {
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
      el('th', {}, 'Target'),
      el('th', {}, 'Kp'),
      el('th', {}, 'Ki'),
      el('th', {}, 'Kd'),
      el('th', {}, 'Out Min'),
      el('th', {}, 'Out Max'),
      el('th', {}, 'Err Min'),
      el('th', {}, 'Err Max'),
      el('th', {}, 'I Min'),
      el('th', {}, 'I Max'),
      el('th', {}, 'En Gate'),
      el('th', {}, 'Gate Type'),
      el('th', {}, 'Gate #'),
      el('th', {}, 'Actions')
    ]));
    
    const tbody = el('tbody');
    
    loops.forEach((L, idx) => {
      const removeBtn = el('button', {
        className: 'btn danger',
        onclick: () => {
          if (confirm(`Remove Loop ${idx} (${L.name})?`)) {
            loops.splice(idx, 1);
            buildForm();
          }
        }
      }, '×');
      
      const tr = el('tr', {}, [
        el('td', {}, `${idx}`),
        el('td', {}, chk(L, 'enabled')),
        el('td', {}, txt(L, 'name')),
        el('td', {}, selectEnum(['analog','digital','var'], L.kind||'analog', v=>L.kind=v)),
        el('td', {}, selectEnum(['ai','ao','tc','pid'], L.src||'ai', v=>L.src=v)),
        el('td', {}, num(L, 'ai_ch', 1)),
        el('td', {}, num(L, 'out_ch', 1)),
        el('td', {}, num(L, 'target', 0.0001)),
        el('td', {}, num(L, 'kp', 0.0001)),
        el('td', {}, num(L, 'ki', 0.0001)),
        el('td', {}, num(L, 'kd', 0.0001)),
        el('td', {}, num(L, 'out_min', 0.0001)),
        el('td', {}, num(L, 'out_max', 0.0001)),
        el('td', {}, num(L, 'err_min', 0.0001)),
        el('td', {}, num(L, 'err_max', 0.0001)),
        el('td', {}, num(L, 'i_min', 0.0001)),
        el('td', {}, num(L, 'i_max', 0.0001)),
        el('td', {}, chk(L, 'enable_gate')),
        el('td', {}, selectEnum(['do','le'], L.enable_kind||'do', v=>L.enable_kind=v)),
        el('td', {}, num(L, 'enable_index', 1)),
        el('td', {}, removeBtn)
      ]);
      tbody.append(tr);
    });
    
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

  root.append(
    title,
    el('div', {style: 'display:flex;gap:8px;margin-bottom:12px'}, [loadBtn, addBtn]),
    el('div', {style: 'overflow:auto;max-height:60vh'}, formContainer),
    el('div',{style:'margin-top:8px'}, save)
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
          Object.assign(motor_data, loaded);
          alert('Motor config loaded! Close and reopen to see changes, or click Save to apply.');
        } catch(e) {
          alert('Failed to load motor config: ' + e.message);
        }
      };
      inp.click();
    }
  }, '📁 Load from File');

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

      const srcSelect = selectEnum(['ai', 'ao', 'tc', 'pid'], M.input_source || 'ai', v => M.input_source = v);

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

  root.append(
    title,
    el('div', {style: 'display:flex;gap:8px;margin-bottom:12px'}, [loadBtn, addBtn]),
    el('div', {style: 'margin:12px 0'}, [
      el('p', {}, 'Configure Rattmotor YPMC-750W servo controllers:'),
      el('p', {style: 'font-size:12px;color:var(--muted)'}, 
        'RPM Command = Input * Scale + Offset. Negative RPM reverses motor.')
    ]),
    el('div', {style: 'overflow:auto;max-height:60vh'}, formContainer),
    el('div', {style:'margin-top:8px'}, save)
  );
  showModal(root, ()=>{ renderPage(); });
}

// ==================== LOGIC ELEMENTS EDITOR ====================
async function openLEEditor(){
  const le_data = await (await fetch('/api/logic_elements')).json();
  const elements = le_data.elements || [];
  
  const root = el('div', {});
  const title = el('h2', {}, 'Logic Elements Editor');
  
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
          Object.assign(le_data, loaded);
          alert('LE config loaded! Close and reopen to see changes, or click Save to apply.');
        } catch(e) {
          alert('Failed to load LE config: ' + e.message);
        }
      };
      inp.click();
    }
  }, '📁 Load from File');

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
      onchange: e => {
        input.kind = e.target.value;
        // Clear comparison fields when switching to non-analog types
        if (!['ai', 'ao', 'tc', 'pid_u'].includes(e.target.value)) {
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
    ['do', 'ai', 'ao', 'tc', 'pid_u', 'le'].forEach(k => {
      const opt = el('option', {value: k}, k.toUpperCase());
      kindSelect.append(opt);
    });
    
    // Set the value AFTER adding options
    kindSelect.value = input.kind || 'do';
    
    const indexInput = el('input', {
      type: 'number',
      value: input.index,
      min: 0,
      step: 1,
      oninput: e => input.index = parseInt(e.target.value) || 0,
      style: 'width:80px'
    });
    
    kindRow.append(
      el('label', {}, ['Type: ', kindSelect]),
      el('label', {}, ['Index: ', indexInput])
    );
    div.append(kindRow);

    // For analog types, show comparison options - compact layout
    if (['ai', 'ao', 'tc', 'pid_u'].includes(input.kind)) {
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
          onchange: e => input.compare_to_kind = e.target.value
        });
        ['ai', 'ao', 'tc', 'pid_u'].forEach(k => {
          signalKindSelect.append(el('option', {value: k}, k.toUpperCase()));
        });
        signalKindSelect.value = input.compare_to_kind || 'ai';
        
        const signalIndexInput = el('input', {
          type: 'number',
          value: input.compare_to_index ?? 0,
          min: 0,
          step: 1,
          oninput: e => input.compare_to_index = parseInt(e.target.value) || 0,
          style: 'width:80px'
        });
        
        signalRow.append(
          el('label', {}, ['Signal: ', signalKindSelect]),
          el('label', {}, ['Index: ', signalIndexInput])
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
    el('div', {style:'margin-top:12px'}, save)
  );
  
  renderLEEditor();
  showModal(root, ()=>{ renderPage(); });
}

// This version changes the Save button to always pop up a file save dialog

async function openScriptEditor(){
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
        } catch(e) {
          alert('Failed to load script: ' + e.message);
        }
      };
      inp.click();
    }
  }, '📁 Load from File');

  const table = el('table', {className: 'form script-table'});
  const thead = el('thead', {}, el('tr', {}, [
    el('th', {}, 'Time (s)'),
    el('th', {}, 'Duration (s)'),
    el('th', {}, 'Type'),
    el('th', {}, 'Channel'),
    el('th', {}, 'Value/State'),
    el('th', {}, 'NO/NC'),
    el('th', {}, 'Actions')
  ]));
  const tbody = el('tbody', {});

  function renderEvents(){
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

      const typeSelect = el('select', {style: 'width:80px'}, [
        el('option', {value: 'DO'}, 'DO'),
        el('option', {value: 'AO'}, 'AO')
      ]);
      typeSelect.value = evt.type || 'DO';
      typeSelect.onchange = () => {
        evt.type = typeSelect.value;
        renderEvents();
      };

      const channelInput = el('input', {
        type: 'number',
        value: evt.channel || 0,
        min: 0,
        max: (evt.type === 'AO' ? 1 : 7),
        step: 1,
        style: 'width:60px'
      });
      channelInput.oninput = () => evt.channel = parseInt(channelInput.value) || 0;

      let valueControl;
      let noNcControl = el('span', {}, '—');

      if (evt.type === 'DO' || !evt.type) {
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
            [events[idx], events[idx-1]] = [events[idx-1], events[idx]];
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
            [events[idx], events[idx+1]] = [events[idx+1], events[idx]];
            renderEvents();
          }
        },
        disabled: idx === events.length - 1
      }, '↓');

      const tr = el('tr', {}, [
        el('td', {}, timeInput),
        el('td', {}, durationInput),
        el('td', {}, typeSelect),
        el('td', {}, channelInput),
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
      events.push({
        time: 0,
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

  // UPDATED: Save button now opens file dialog AND saves to server
  const saveBtn = el('button', {
    className: 'btn',
    onclick: async () => {
      try {
        // First save to server (for script player to use)
        await fetch('/api/script', {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({events})
        });

        // Then trigger file download dialog
        const scriptData = {events: events};
        const blob = new Blob([JSON.stringify(scriptData, null, 2)], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = el('a', {
          href: url,
          download: 'script.json'
        });
        a.click();
        URL.revokeObjectURL(url);

        alert('Script saved to server and file downloaded');
        loadScript(); // Reload for script player
      } catch(e) {
        alert('Save failed: ' + e.message);
      }
    },
    style: 'margin-left:8px'
  }, '💾 Save');

  root.append(
    title,
    el('div', {style: 'display:flex;gap:8px;margin:12px 0'}, [loadBtn]),
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


/* ----------------------------- form bits -------------------------------- */
function fieldset(title, inner){ const fs=el('fieldset',{}); fs.append(el('legend',{},title), inner); return fs; }
function tableForm(pairs){
  const tbl=el('table',{className:'form'}), tbody=el('tbody');
  for(const [label,input] of pairs){ const tr=el('tr'); tr.append(el('th',{},label), el('td',{},input)); tbody.append(tr); }
  tbl.append(el('thead',{}, el('tr',{},[el('th',{},'Field'), el('th',{},'Value')])), tbody);
  return tbl;
}
function tableFormRows(rows){
  const tbl=el('table',{className:'form'}), tbody=el('tbody');
  for(const row of rows){
    const tr=el('tr');
    for(let i=0;i<row.length;i+=2){ tr.append(el('th',{},row[i]), el('td',{},row[i+1])); }
    tbody.append(tr);
  }
  tbl.append(el('thead',{}, el('tr',{},[
    el('th',{},'Field'), el('th',{},'Value'),
    el('th',{},'Field'), el('th',{},'Value'),
    el('th',{},'Field'), el('th',{},'Value'),
    el('th',{},'Field'), el('th',{},'Value')
  ])), tbody);
  return tbl;
}
function inputText(obj,key){ const i=el('input',{type:'text',value:obj[key]??''}); i.oninput=()=>obj[key]=i.value; return i; }
function inputNum(obj,key,step){ const i=el('input',{type:'number',step:step??'any',value:obj[key]??0}); i.oninput=()=>obj[key]=parseFloat(i.value)||0; return i; }
function inputChk(obj,key){ const i=el('input',{type:'checkbox',checked:!!obj[key]}); i.onchange=()=>obj[key]=!!i.checked; return i; }
function selectEnum(options, value, onChange){ const s=el('select',{}); options.forEach(opt=>s.append(el('option',{value:opt},opt))); s.value=value; s.onchange=()=>onChange(s.value); return s; }

function saveLayoutToFile(){
  const blob=new Blob([JSON.stringify({pages:state.pages},null,2)],{type:'application/json'});
  const a=el('a',{href:URL.createObjectURL(blob),download:'layout.json'}); a.click();
}
function loadLayoutFromFile(){
  const inp=el('input',{type:'file',accept:'.json'});
  inp.onchange=()=>{
    const f=inp.files?.[0]; if(!f) return;
    const rd=new FileReader();
    rd.onload=()=>{
      try{
        const obj=JSON.parse(rd.result);
        if(!obj.pages||!Array.isArray(obj.pages)) throw new Error('Invalid layout file');
        state.pages = normalizeLayoutPages(obj.pages);   // <-- ensure defaults exist
        refreshPages();
        setActivePage(0);
      }catch(e){ alert('Load failed: '+e.message); }
    };
    rd.readAsText(f);
  };
  inp.click();
}

/* ----------------------- widget settings modal -------------------------- */
function openWidgetSettings(w){
  const root=el('div',{});
  const titleHeader=el('h3',{}, (w.opts.title||w.type)+' — Settings');
  const titleInput=inputText(w.opts,'title');
  titleInput.oninput = ()=>{
    w.opts.title = titleInput.value;
    const t=document.querySelector('#w_'+w.id+' header .title'); if(t) t.textContent = w.opts.title || w.type;
    const b=document.querySelector('#w_'+w.id+' .do-btn'); if(b) b.textContent = w.opts.title || 'DO';
  };
  const nameRow=tableForm([['Title', titleInput]]);
  root.append(el('div',{},[titleHeader]), nameRow, el('hr',{className:'soft'}));

  if (w.type==='chart'||w.type==='bars'||w.type==='gauge'){
    const list=el('div',{});
    const items=(w.type==='gauge')?(w.opts.needles=w.opts.needles||[]):(w.opts.series=w.opts.series||[]);
    function redrawList(){
      list.innerHTML='';
      items.forEach((s,idx)=>{
        const kindSel=selectEnum(['ai','ao','do','tc','pid'], s.kind||'ai', v=>{ s.kind=v; s.name = s.name || labelFor(s); });
        const idxInput=el('input',{type:'number',min:0,step:1,value:s.index|0,style:'width:90px'});
        idxInput.onchange=()=>{ s.index=parseInt(idxInput.value)||0; s.name = s.name || labelFor(s); };
        const nameInput=el('input',{type:'text',value:(s.name && s.name.length)? s.name : labelFor(s),placeholder:'label'});
        nameInput.oninput=()=>s.name=nameInput.value;
        const rm=el('span',{className:'icon',onclick:()=>{ items.splice(idx,1); redrawList(); }}, '−');
        list.append(el('div',{className:'row'},[kindSel, idxInput, nameInput, rm]));
      });
    }
    const add=el('span',{className:'icon',onclick:()=>{ const s={kind:'ai',index:0,name: labelFor({kind:'ai',index:0})}; items.push(s); redrawList(); }}, '+ Add');
    redrawList();
    root.append(el('h4',{}, (w.type==='gauge'?'Needles':'Series')), list, el('div',{style:'margin-top:8px'}, add));
  }

  if (w.type==='dobutton'){
    const modeSel=selectEnum(['toggle','momentary','buzz'], w.opts.mode||'toggle', v=>w.opts.mode=v);
    root.append(tableForm([
      ['Title', titleInput],
      ['Index', inputNum(w.opts,'doIndex',1)],      ['Active High', inputChk(w.opts,'activeHigh')],
      ['Mode', modeSel],                             ['Buzz Hz', inputNum(w.opts,'buzzHz',10)],
      ['Actuation Time (s, toggle)', inputNum(w.opts,'actuationTime',0.01)]
    ]));
  }

  if (w.type==='aoslider'){
    const minI = inputNum(w.opts,'min',0.001);
    const maxI = inputNum(w.opts,'max',0.001);
    const stepI = inputNum(w.opts,'step',0.0001);
    const applyAOdom = ()=>{
      const node=document.querySelector('#w_'+w.id);
      if(!node) return;
      const rng=node.querySelector('input[type="range"]');
      const cur=node.querySelector('input[type="number"]');
      if(rng){ rng.min=w.opts.min; rng.max=w.opts.max; rng.step=w.opts.step; }
      if(cur){ cur.min=w.opts.min; cur.max=w.opts.max; cur.step=w.opts.step; }
      const hdr=node.querySelector('header .title'); if(hdr) hdr.textContent=w.opts.title||'AO';
    };
    minI.oninput = ()=>{ w.opts.min=parseFloat(minI.value)||0;  applyAOdom(); };
    maxI.oninput = ()=>{ w.opts.max=parseFloat(maxI.value)||10; applyAOdom(); };
    stepI.oninput= ()=>{ w.opts.step=parseFloat(stepI.value)||0.0001; applyAOdom(); };

    root.append(tableForm([
      ['Title', titleInput],
      ['AO Index', inputNum(w.opts,'aoIndex',1)],
      ['Min V', minI],
      ['Max V', maxI],
      ['Step V', stepI],
      ['Live (send on move)', inputChk(w.opts,'live')]
    ]));
  }

  if (w.type==='pidpanel'){
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
          ['Show Controls', inputChk(w.opts,'showControls')]
        ]));
      } catch(e) {
        root.append(tableForm([
          ['Loop Index', inputNum(w.opts,'loopIndex',1)],
          ['Show Controls', inputChk(w.opts,'showControls')]
        ]));
      }
    })();
  }

  if (w.type==='motor'){
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
          ['Show Controls', inputChk(w.opts,'showControls')]
        ]));
      } catch(e) {
        root.append(tableForm([
          ['Motor Index', inputNum(w.opts,'motorIndex',1)],
          ['Show Controls', inputChk(w.opts,'showControls')]
        ]));
      }
    })();
  }

  if (w.type==='le'){
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
          ['Show Inputs', inputChk(w.opts,'showInputs')]
        ]));
      } catch(e) {
        root.append(tableForm([
          ['LE Index', inputNum(w.opts,'leIndex',1)],
          ['Show Inputs', inputChk(w.opts,'showInputs')]
        ]));
      }
    })();
  }

  showModal(root, ()=>{ renderPage(); });
}
