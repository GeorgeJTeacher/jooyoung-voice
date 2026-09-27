import QRCode from 'qrcode';
import { api, getIceServers, guideTokenFromHash, makeId, requestWakeLock, roomFromUrl, showFatalError, showToast, sleep, waitForIceGatheringComplete, wsUrl } from './shared/api.js';
import { PdfInkViewer } from './shared/pdf-viewer.js';

const room = roomFromUrl();
const token = guideTokenFromHash();
const $ = (s) => document.querySelector(s);
const toast = $('#toast');
const viewer = new PdfInkViewer({ pdfCanvas: $('#pdf-canvas'), inkCanvas: $('#ink-canvas'), frame: $('#pdf-frame'), stage: $('#pdf-stage') });

const state = {
  meta: null, ws: null, wsAttempt: 0, pc: null, stream: null, outboundStream: null, audioTrack: null,
  broadcasting: false, muted: false, recoverTimer: null, wakeLock: null,
  currentTool: 'pen', color: '#e53935', drawing: null, pointBatch: [], batchTimer: 0,
  loadedPdfVersion: 0, meterContext: null, meterAnimation: 0,
  viewPointers: new Map(), pinchStart: null, pendingView:null, viewTimer: 0, zoomTimer:0,
  laserActive: false, laserSentAt: 0, laserHistory: [], toolLabelTimer: 0,
  viewHistory: [], zoomSelection: null,
  mixContext: null, mixDestination: null, micSource: null, micGain: null, musicGain: null, musicSource: null,
  recoveringMic: false, intentionalMicPause: false,
};

function authOptions(extra = {}) { return { ...extra, token }; }
function wsSend(message) { if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message)); }
function setChip(el, mode, text) { el.className = `status-chip ${mode || ''}`.trim(); el.querySelector('b').textContent = text; }

async function init() {
  const status = await api(`/api/rooms/${room}/status`);
  state.meta = status;
  $('#room-title').textContent = status.title;
  $('#room-code').textContent = room;
  const listenerUrl = `${location.origin}/listen.html?room=${room}`;
  await QRCode.toCanvas($('#qr-canvas'), listenerUrl, { width: 220, margin: 1, errorCorrectionLevel: 'M' });
  $('#share-button').addEventListener('click', async () => {
    if (navigator.share) await navigator.share({ title: status.title, text: '이어폰을 연결하고 실시간 설명을 들어보세요.', url: listenerUrl }).catch(() => {});
    else await navigator.clipboard.writeText(listenerUrl);
  });
  $('#copy-button').addEventListener('click', async () => { await navigator.clipboard.writeText(listenerUrl); showToast(toast, '참가 링크를 복사했습니다.'); });
  bindControls();
  connectWs();
  if (status.pdfVersion) await loadPdf(status.pdfVersion);
  updatePageUI();
}

function bindControls() {
  $('#control-panel-toggle').addEventListener('click', () => setControlPanelCollapsed(!$('.control-panel').classList.contains('collapsed')));
  $('#control-panel-reopen').addEventListener('click', () => setControlPanelCollapsed(false));
  $('#broadcast-button').addEventListener('click', startBroadcast);
  $('#mute-button').addEventListener('click', () => toggleMute());
  $('#reconnect-mic-button').addEventListener('click', () => recoverMicrophone({ resumeBroadcast:true, manual:true }));
  $('#stop-button').addEventListener('click', stopBroadcast);
  $('#mic-select').addEventListener('change', async () => { if (state.broadcasting) { await stopBroadcast(false); await startBroadcast(); } });
  $('#pdf-input').addEventListener('change', uploadPdf);
  $('#prev-page').addEventListener('click', () => changePage(viewer.pageNumber - 1));
  $('#next-page').addEventListener('click', () => changePage(viewer.pageNumber + 1));
  $('#undo-button').addEventListener('click', () => wsSend({ type: 'undo', page: viewer.pageNumber }));
  $('#clear-button').addEventListener('click', () => {
    if (confirm('현재 페이지의 모든 필기를 지울까요?')) wsSend({ type: 'page:clear', page: viewer.pageNumber });
  });
  $('#zoom-in').addEventListener('click', () => changeZoom(viewer.view.scale + .25));
  $('#zoom-out').addEventListener('click', () => changeZoom(viewer.view.scale - .25));
  $('#zoom-reset').addEventListener('click', () => applyGuideView({ scale:1, x:.5, y:.5 }));
  $('#zoom-back').addEventListener('click', restorePreviousView);
  document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.remove('active'));
    button.classList.add('active'); state.currentTool = button.dataset.tool; showToolLabel(button);
  }));
  document.querySelectorAll('[data-color]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-color]').forEach((b) => b.classList.remove('active'));
    button.classList.add('active'); state.color = button.dataset.color;
  }));
  const ink = $('#ink-canvas');
  ink.addEventListener('pointerdown', pointerDown);
  ink.addEventListener('pointermove', pointerMove);
  ink.addEventListener('pointerup', pointerUp);
  ink.addEventListener('pointercancel', pointerUp);
  const stage = $('#pdf-stage');
  stage.classList.add('guide-zoom');
  stage.addEventListener('pointerdown', viewPointerDown, { passive:false });
  stage.addEventListener('pointermove', viewPointerMove, { passive:false });
  stage.addEventListener('pointerup', viewPointerUp, { passive:false });
  stage.addEventListener('pointercancel', viewPointerUp, { passive:false });
  stage.addEventListener('scroll', scheduleViewBroadcast, { passive:true });
  stage.addEventListener('wheel', (event) => { if (!event.ctrlKey) return; event.preventDefault(); changeZoom(viewer.view.scale + (event.deltaY < 0 ? .25 : -.25)); }, { passive:false });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.broadcasting) {
      if (!state.wakeLock) state.wakeLock = await requestWakeLock();
      if (!state.muted && !microphoneIsHealthy()) recoverMicrophone({ resumeBroadcast:true });
    }
  });
}

function setControlPanelCollapsed(collapsed) {
  const panel=$('.control-panel'), button=$('#control-panel-toggle');
  panel.classList.toggle('collapsed',collapsed);
  $('.workspace').classList.toggle('controls-collapsed',collapsed);
  $('#control-panel-reopen').classList.toggle('hidden',!collapsed);
  button.setAttribute('aria-expanded',String(!collapsed));
  button.querySelector('span').textContent='방송 · 참가 QR';
}

function showToolLabel(button){ document.querySelectorAll('.tool-button.show-label').forEach(b=>b.classList.remove('show-label')); clearTimeout(state.toolLabelTimer); button.classList.add('show-label'); state.toolLabelTimer=setTimeout(()=>button.classList.remove('show-label'),1100); }

async function connectWs() {
  try {
    const { ticket } = await api(`/api/rooms/${room}/ws-ticket`, authOptions({ method: 'POST' }));
    const ws = new WebSocket(wsUrl(`/api/rooms/${room}/ws?role=guide&ticket=${encodeURIComponent(ticket)}`));
    state.ws = ws;
    ws.addEventListener('open', () => { state.wsAttempt = 0; setChip($('#network-chip'), 'live', '동기화 연결'); });
    ws.addEventListener('message', handleWsMessage);
    ws.addEventListener('close', async () => {
      if (state.ws !== ws) return;
      setChip($('#network-chip'), 'warn', '재연결 중');
      state.wsAttempt += 1;
      await sleep(Math.min(8000, 500 * 2 ** state.wsAttempt));
      connectWs();
    });
  } catch (error) {
    setChip($('#network-chip'), 'bad', '연결 실패');
    await sleep(1500); connectWs();
  }
}

function handleWsMessage(event) {
  const m = JSON.parse(event.data);
  if (m.type === 'hello') {
    state.meta = m.meta; $('#listener-count').textContent = m.presence.listeners;
    $('#yes-count').textContent = Number(m.votes?.yes || 0); $('#no-count').textContent = Number(m.votes?.no || 0);
    updateQualitySummary(m.quality || {});
    updateHeadphoneSummary(m.headphones || { active:0, listeners:m.presence.listeners });
    if (m.page && m.strokes) viewer.setPageStrokes(m.page, m.strokes);
  } else if (m.type === 'presence') {
    $('#listener-count').textContent = m.listeners;
  } else if (m.type === 'votes') {
    $('#yes-count').textContent = Number(m.yes || 0); $('#no-count').textContent = Number(m.no || 0);
  } else if (m.type === 'quality:summary') {
    updateQualitySummary(m);
  } else if (m.type === 'headphones:summary') {
    updateHeadphoneSummary(m);
  } else if (m.type === 'snapshot') {
    viewer.setPageStrokes(m.page, m.strokes || []);
  } else if (m.type === 'stroke:remove') {
    viewer.removeStroke(m.page, m.id);
  } else if (m.type === 'page:clear') {
    viewer.clearPage(m.page);
  } else if (m.type === 'stroke:committed') {
    viewer.addStroke(m.page, m.stroke);
  } else if (m.type === 'pdf:updated') {
    if (m.pdfVersion !== state.loadedPdfVersion) loadPdf(m.pdfVersion);
  }
}

function updateQualitySummary(summary){const good=Number(summary.good||0),bad=Number(summary.bad||0),checking=Number(summary.checking||0)+Number(summary.unknown||0),paused=Number(summary.paused||0),chip=$('#quality-chip');if(bad>0)setChip(chip,'bad',`음질 문제 ${bad}명`);else if(checking>0)setChip(chip,'warn',`음질 확인 ${checking}명`);else if(good>0)setChip(chip,'live',`음질 좋음 ${good}명`);else if(paused>0)setChip(chip,'warn',`일시정지 ${paused}명`);else setChip(chip,'','음질 확인 0명');}
function updateHeadphoneSummary(summary){const active=Number(summary.active||0),listeners=Number(summary.listeners||0),chip=$('#headphone-chip');setChip(chip,active>0?'live':'',`이어폰 ${active}/${listeners}명`);}

async function enumerateMics() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const select = $('#mic-select');
  const selected = select.value;
  select.innerHTML = '<option value="">기본 마이크</option>';
  devices.filter(d => d.kind === 'audioinput').forEach((d, i) => {
    const option = document.createElement('option'); option.value = d.deviceId; option.textContent = d.label || `마이크 ${i + 1}`; select.append(option);
  });
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
}

async function startBroadcast() {
  if (state.broadcasting) return;
  const button = $('#broadcast-button'); button.disabled = true; button.textContent = '마이크 연결 중…';
  try {
    await ensureMixContext();
    state.stream = await requestMicrophoneStream();
    await enumerateMics();
    state.audioTrack = state.stream.getAudioTracks()[0];
    state.outboundStream = await prepareMixedStream(state.stream);
    await publishStream(state.outboundStream);
    state.broadcasting = true; state.muted = false; state.intentionalMicPause = false;
    watchMicrophoneTrack(state.audioTrack);
    state.wakeLock = await requestWakeLock();
    button.textContent = '방송 중';
    $('#mute-button').disabled = false; $('#stop-button').disabled = false;
    $('#mic-orb').classList.add('live'); setChip($('#live-chip'), 'live', 'LIVE');
    $('#live-chip').classList.add('live'); $('#audio-note').textContent = '음성이 참가자 이어폰으로 실시간 전송되고 있습니다.';
    startMeter(state.stream);
    setControlPanelCollapsed(true);
  } catch (error) {
    showToast(toast, `방송 시작 실패: ${error.message}`, 3200);
    button.disabled = false; button.textContent = '방송 시작';
    cleanupMedia();
  }
}

async function ensureMixContext() {
  const AudioCtx=window.AudioContext||window.webkitAudioContext;
  if(!AudioCtx)throw new Error('이 브라우저는 일시정지 음악 기능을 지원하지 않습니다.');
  if(!state.mixContext||state.mixContext.state==='closed')state.mixContext=new AudioCtx();
  if(state.mixContext.state!=='running')await state.mixContext.resume();
}

function requestMicrophoneStream() {
  const deviceId = $('#mic-select').value;
  return navigator.mediaDevices.getUserMedia({
    video:false,
    audio:{ deviceId:deviceId?{exact:deviceId}:undefined, echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1 },
  });
}

async function prepareMixedStream(micStream) {
  const context=state.mixContext;
  const destination=context.createMediaStreamDestination();
  const micSource=context.createMediaStreamSource(micStream);
  state.mixDestination=destination; state.micSource=micSource;
  state.micGain=context.createGain(); state.micGain.gain.value=1;
  state.musicGain=context.createGain(); state.musicGain.gain.value=0;
  micSource.connect(state.micGain).connect(destination);
  state.musicGain.connect(destination);
  const response=await fetch('/pause-music.mp3'); if(!response.ok)throw new Error('일시정지 음악을 불러오지 못했습니다.');
  const buffer=await context.decodeAudioData(await response.arrayBuffer());
  state.musicSource=context.createBufferSource(); state.musicSource.buffer=buffer; state.musicSource.loop=true; state.musicSource.connect(state.musicGain); state.musicSource.start();
  return destination.stream;
}

async function publishStream(stream) {
  const iceServers = await getIceServers(room);
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  state.pc = pc;
  const track = stream.getAudioTracks()[0];
  const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);
  const result = await api(`/api/rooms/${room}/rtc/publish`, authOptions({ method: 'POST', body: { sdp: pc.localDescription.sdp, mid: transceiver.mid, trackName: track.id } }));
  const connected = waitForPeerConnected(pc);
  await pc.setRemoteDescription(result.sessionDescription);
  await connected;
  await api(`/api/rooms/${room}/rtc/publish/ready`, authOptions({ method: 'POST', body: { sessionId: result.publisherSessionId, trackName: result.publisherTrackName || track.id } }));
  pc.addEventListener('connectionstatechange', () => {
    if (!state.broadcasting) return;
    if (['failed', 'disconnected'].includes(pc.connectionState)) scheduleRecovery();
  });
}

function waitForPeerConnected(pc, timeoutMs = 12_000) {
  if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('마이크 음성망 연결 시간이 초과되었습니다.')), timeoutMs);
    const check = () => {
      if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') finish();
      else if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') finish(new Error('마이크 음성망 연결에 실패했습니다.'));
    };
    function finish(error) {
      clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', check);
      pc.removeEventListener('iceconnectionstatechange', check);
      error ? reject(error) : resolve();
    }
    pc.addEventListener('connectionstatechange', check);
    pc.addEventListener('iceconnectionstatechange', check);
  });
}

function scheduleRecovery() {
  clearTimeout(state.recoverTimer);
  state.recoverTimer = setTimeout(async () => {
    if (!state.broadcasting || !state.outboundStream) return;
    setChip($('#network-chip'), 'warn', '음성 재연결');
    try { await api(`/api/rooms/${room}/rtc/publish/stop`, authOptions({ method: 'POST' })).catch(() => {}); state.pc?.close(); await publishStream(state.outboundStream); setChip($('#network-chip'), 'live', '음성 복구'); }
    catch { scheduleRecovery(); }
  }, 1200);
}

async function toggleMute() {
  if (!state.audioTrack || !state.micGain || !state.musicGain) return;
  if (state.recoveringMic) return;
  if (state.muted) {
    await recoverMicrophone({ resumeBroadcast:true, manual:true });
    return;
  }
  state.muted = true; state.intentionalMicPause = true; state.audioTrack.enabled = false;
  const now=state.mixContext.currentTime;
  state.micGain.gain.cancelScheduledValues(now); state.musicGain.gain.cancelScheduledValues(now);
  state.micGain.gain.setValueAtTime(0,now); state.musicGain.gain.setValueAtTime(.24,now);
  $('#mute-button').textContent = '방송 재개'; setChip($('#live-chip'),'warn','일시정지');
  $('#audio-note').textContent = '마이크는 꺼져 있고 참가자에게 대기 음악이 재생됩니다.';
  wsSend({ type:'audio:pause', paused:true });
}

function microphoneIsHealthy(){return !!state.audioTrack&&state.audioTrack.readyState==='live'&&!state.audioTrack.muted&&state.mixContext?.state!=='closed';}

function watchMicrophoneTrack(track){
  if(!track)return;
  track.addEventListener('ended',()=>{if(state.broadcasting&&!state.intentionalMicPause)showMicRecovery();},{once:true});
  track.addEventListener('mute',()=>{if(state.broadcasting&&!state.intentionalMicPause)showMicRecovery();});
}

function showMicRecovery(){
  $('#reconnect-mic-button').classList.remove('hidden');
  $('#audio-note').textContent='마이크 입력이 끊겼습니다. 자동 복구 중입니다.';
  recoverMicrophone({resumeBroadcast:true});
}

async function recoverMicrophone({resumeBroadcast=false,manual=false}={}){
  if(!state.broadcasting||state.recoveringMic)return false;
  state.recoveringMic=true; const reconnect=$('#reconnect-mic-button'),mute=$('#mute-button');
  reconnect.disabled=true; mute.disabled=true; reconnect.classList.remove('hidden'); reconnect.textContent='마이크 연결 중…';
  try{
    await ensureMixContext();
    if(!state.mixDestination||!state.micGain||state.mixContext.state==='closed')await rebuildAudioPipeline();
    else {
      const oldStream=state.stream,oldSource=state.micSource;
      try{oldSource?.disconnect();}catch{} oldStream?.getTracks().forEach(track=>track.stop());
      state.stream=null; state.audioTrack=null; state.micSource=null;
      const nextStream=await requestMicrophoneStream(); const nextTrack=nextStream.getAudioTracks()[0];
      if(!nextTrack)throw new Error('사용 가능한 마이크를 찾지 못했습니다.');
      const nextSource=state.mixContext.createMediaStreamSource(nextStream); nextSource.connect(state.micGain);
      state.stream=nextStream; state.audioTrack=nextTrack; state.micSource=nextSource;
      watchMicrophoneTrack(nextTrack); await enumerateMics(); startMeter(nextStream);
    }
    if(resumeBroadcast){
      state.audioTrack.enabled=true; state.intentionalMicPause=false; state.muted=false;
      const now=state.mixContext.currentTime; state.micGain.gain.cancelScheduledValues(now); state.musicGain.gain.cancelScheduledValues(now);
      state.micGain.gain.setValueAtTime(1,now); state.musicGain.gain.setValueAtTime(0,now);
      mute.textContent='잠시 멈춤'; setChip($('#live-chip'),'live','LIVE');
      $('#audio-note').textContent='마이크가 복구되어 음성을 다시 전송하고 있습니다.'; wsSend({type:'audio:pause',paused:false});
    }
    reconnect.classList.add('hidden'); return true;
  }catch(error){
    state.muted=true; state.intentionalMicPause=true;
    if(state.micGain&&state.musicGain&&state.mixContext?.state!=='closed'){const now=state.mixContext.currentTime;state.micGain.gain.setValueAtTime(0,now);state.musicGain.gain.setValueAtTime(.24,now);}
    setChip($('#live-chip'),'bad','마이크 확인'); $('#audio-note').textContent='자동 복구에 실패했습니다. 마이크 다시 연결을 눌러주세요.';
    reconnect.classList.remove('hidden'); if(manual)showToast(toast,`마이크 연결 실패: ${error.message}`,4000); return false;
  }finally{state.recoveringMic=false;reconnect.disabled=false;reconnect.textContent='마이크 다시 연결';mute.disabled=false;}
}

async function rebuildAudioPipeline(){
  await api(`/api/rooms/${room}/rtc/publish/stop`,authOptions({method:'POST'})).catch(()=>{}); state.pc?.close(); state.pc=null;
  state.stream?.getTracks().forEach(track=>track.stop()); state.outboundStream?.getTracks().forEach(track=>track.stop());
  try{state.micSource?.disconnect();}catch{} try{state.musicSource?.stop();}catch{} await state.mixContext?.close().catch(()=>{});
  state.stream=null; state.outboundStream=null; state.audioTrack=null; state.mixContext=null; state.mixDestination=null; state.micSource=null; state.micGain=null; state.musicGain=null; state.musicSource=null;
  await ensureMixContext(); state.stream=await requestMicrophoneStream(); state.audioTrack=state.stream.getAudioTracks()[0];
  state.outboundStream=await prepareMixedStream(state.stream); await publishStream(state.outboundStream); watchMicrophoneTrack(state.audioTrack); await enumerateMics(); startMeter(state.stream);
}

async function stopBroadcast(resetButton = true) {
  state.broadcasting = false; clearTimeout(state.recoverTimer);
  await api(`/api/rooms/${room}/rtc/publish/stop`, authOptions({ method: 'POST' })).catch(() => {});
  cleanupMedia();
  if (state.wakeLock) { await state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
  if (resetButton) {
    const button = $('#broadcast-button'); button.disabled = false; button.textContent = '방송 시작';
    $('#mute-button').disabled = true; $('#mute-button').textContent = '잠시 멈춤'; $('#stop-button').disabled = true; $('#mic-orb').classList.remove('live'); setChip($('#live-chip'), 'idle', '대기');
    $('#reconnect-mic-button').classList.add('hidden');
    $('#audio-note').textContent = '방송이 종료되었습니다.';
  }
}

function cleanupMedia() {
  cancelAnimationFrame(state.meterAnimation); $('#meter-fill').style.width = '0';
  state.pc?.close(); state.pc = null;
  state.stream?.getTracks().forEach(t => t.stop()); state.stream = null; state.audioTrack = null;
  state.outboundStream?.getTracks().forEach(t=>t.stop()); state.outboundStream=null;
  try{state.micSource?.disconnect();}catch{} try{state.musicSource?.stop();}catch{} state.musicSource=null; state.micSource=null; state.mixDestination=null; state.micGain=null; state.musicGain=null;
  state.mixContext?.close().catch(()=>{}); state.mixContext=null;
  state.meterContext?.close().catch(()=>{}); state.meterContext=null;
}

function startMeter(stream) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  state.meterContext?.close().catch(() => {});
  const context = new AudioCtx(); state.meterContext = context;
  const source = context.createMediaStreamSource(stream); const analyser = context.createAnalyser(); analyser.fftSize = 256; source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => { analyser.getByteFrequencyData(data); const avg = data.reduce((a,b)=>a+b,0)/data.length; $('#meter-fill').style.width = `${Math.min(100, avg * .8)}%`; state.meterAnimation = requestAnimationFrame(tick); };
  tick();
}

async function uploadPdf(event) {
  const file = event.target.files?.[0]; if (!file) return;
  if (file.type !== 'application/pdf') return showToast(toast, 'PDF 파일만 올릴 수 있습니다.');
  if (file.size > 25 * 1024 * 1024) return showToast(toast, 'PDF는 25MB 이하로 준비해주세요.');
  $('#pdf-name').textContent = '업로드 중…';
  try {
    const response = await fetch(`/api/rooms/${room}/pdf`, { method: 'PUT', headers: { 'X-Guide-Token': token, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
    if (!response.ok) throw new Error((await response.json()).error || '업로드 실패');
    const data = await response.json(); state.meta.pdfName = file.name; await loadPdf(data.pdfVersion); showToast(toast, 'PDF를 공유했습니다.');
  } catch (error) { showToast(toast, error.message, 3000); }
}

async function loadPdf(version) {
  state.loadedPdfVersion = Number(version || Date.now());
  $('#pdf-name').textContent = state.meta?.pdfName || '답사 자료.pdf';
  $('#empty-document').classList.add('hidden'); $('#pdf-stage').classList.remove('hidden'); $('#annotation-toolbar').classList.remove('hidden');
  const count = await viewer.load(`/api/rooms/${room}/pdf?v=${state.loadedPdfVersion}`, { 'X-Guide-Token': token });
  $('#page-count').textContent = count; $('#page-number').textContent = viewer.pageNumber;
  await api(`/api/rooms/${room}/pdf-info`, authOptions({ method: 'POST', body: { pageCount: count } })).catch(() => {});
  wsSend({ type: 'snapshot:page', page: viewer.pageNumber });
}

async function changeZoom(scale) { const current=viewer.getView(); rememberView(current); await applyGuideView({ ...current, scale }); }
async function applyGuideView(view) { await viewer.setView(view); $('#zoom-reset').textContent=`${Math.round(viewer.view.scale*100)}%`; wsSend({type:'view',view:viewer.getView()}); }
function rememberView(view=viewer.getView()){const last=state.viewHistory.at(-1);if(!last||Math.abs(last.scale-view.scale)>.01||Math.abs(last.x-view.x)>.01||Math.abs(last.y-view.y)>.01)state.viewHistory.push({...view});state.viewHistory=state.viewHistory.slice(-8);$('#zoom-back').disabled=state.viewHistory.length===0;}
async function restorePreviousView(){const previous=state.viewHistory.pop();if(!previous)return;$('#zoom-back').disabled=state.viewHistory.length===0;await applyGuideView(previous);}
function scheduleViewBroadcast() { clearTimeout(state.viewTimer); state.viewTimer=setTimeout(() => wsSend({type:'view',view:viewer.getView()}),120); }
function touchDistance() { const points=[...state.viewPointers.values()]; if(points.length<2)return 0; return Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y); }
function touchMidpoint(){const points=[...state.viewPointers.values()];return{x:(points[0].x+points[1].x)/2,y:(points[0].y+points[1].y)/2};}
function viewPointerDown(event) { if(event.pointerType!=='touch')return; event.preventDefault(); const stage=$('#pdf-stage'); state.viewPointers.set(event.pointerId,{x:event.clientX,y:event.clientY}); if(state.viewPointers.size===2){cancelDrawing();for(const id of state.viewPointers.keys())try{stage.setPointerCapture(id);}catch{}state.pinchStart={distance:touchDistance(),midpoint:touchMidpoint(),view:viewer.getView()};}else if(state.currentTool==='pan'){try{stage.setPointerCapture(event.pointerId);}catch{}} }
function viewPointerMove(event) { if(event.pointerType!=='touch'||!state.viewPointers.has(event.pointerId))return; event.preventDefault(); const before=state.viewPointers.get(event.pointerId); state.viewPointers.set(event.pointerId,{x:event.clientX,y:event.clientY}); if(state.viewPointers.size>=2&&state.pinchStart){ const start=state.pinchStart, ratio=touchDistance()/Math.max(1,start.distance), mid=touchMidpoint(), frame=$('#pdf-frame'); const next={scale:start.view.scale*ratio,x:start.view.x-(mid.x-start.midpoint.x)/Math.max(1,frame.clientWidth),y:start.view.y-(mid.y-start.midpoint.y)/Math.max(1,frame.clientHeight)}; state.pendingView=next; clearTimeout(state.zoomTimer); state.zoomTimer=setTimeout(()=>{state.pendingView=null;applyGuideView(next);},90); return; } if(state.viewPointers.size===1&&state.currentTool==='pan'&&viewer.view.scale>1){ const stage=$('#pdf-stage'); stage.scrollLeft-=event.clientX-before.x; stage.scrollTop-=event.clientY-before.y; scheduleViewBroadcast(); } }
function viewPointerUp(event) { if(event.pointerType!=='touch')return; state.viewPointers.delete(event.pointerId); if(state.viewPointers.size<2){state.pinchStart=null;if(state.pendingView){const next=state.pendingView;state.pendingView=null;clearTimeout(state.zoomTimer);applyGuideView(next);}else scheduleViewBroadcast();} }

async function changePage(page) {
  if (!viewer.pdf) return;
  page = Math.min(Math.max(page, 1), viewer.pdf.numPages);
  state.viewHistory=[]; $('#zoom-back').disabled=true; await viewer.setView({scale:1,x:.5,y:.5},false);
  await viewer.renderPage(page); updatePageUI(); $('#zoom-reset').textContent='100%'; wsSend({ type: 'page', page }); wsSend({type:'view',view:viewer.getView()}); wsSend({ type: 'snapshot:page', page });
}
function updatePageUI() { $('#page-number').textContent = viewer.pdf ? viewer.pageNumber : 0; $('#page-count').textContent = viewer.pdf?.numPages || 0; }

function pointerDown(event) {
  if (!viewer.pdf || event.button !== 0) return;
  if(event.pointerType==='touch'&&state.viewPointers.size>=1)return;
  if(state.currentTool==='pan')return;
  event.preventDefault(); $('#ink-canvas').setPointerCapture(event.pointerId);
  const pt = viewer.pointerToNormalized(event);
  if (state.currentTool === 'laser') { state.laserActive=true; sendLaser(pt,true); return; }
  if (state.currentTool === 'zoom-box') {
    const selection={id:makeId('z'),page:viewer.pageNumber,tool:'zoom-box',color:'#3aa8ff',width:.004,opacity:.95,points:[pt.x,pt.y,pt.p,pt.x,pt.y,pt.p]};
    state.zoomSelection=selection; state.drawing=selection; viewer.startLiveStroke(selection); return;
  }
  if (state.currentTool === 'eraser') {
    const id = viewer.hitTest(pt.x, pt.y, 0.028); if (id) wsSend({ type: 'stroke:remove', page: viewer.pageNumber, id });
    return;
  }
  const stroke = { id: makeId('s'), page: viewer.pageNumber, tool: state.currentTool, color: state.color, width: state.currentTool === 'highlighter' ? 0.022 : 0.0045, opacity: state.currentTool === 'highlighter' ? 0.35 : 1, points: [pt.x, pt.y, pt.p] };
  state.drawing = stroke; viewer.startLiveStroke(stroke); wsSend({ type: 'stroke:start', stroke });
}

function pointerMove(event) {
  if(event.pointerType==='touch'&&state.viewPointers.size>=2)return;
  if (state.currentTool === 'laser' && state.laserActive && (event.pointerType==='touch'||event.buttons)) { event.preventDefault(); sendLaser(viewer.pointerToNormalized(event),true); return; }
  if (state.currentTool === 'eraser' && event.buttons) {
    const pt = viewer.pointerToNormalized(event); const id = viewer.hitTest(pt.x, pt.y, 0.028); if (id) wsSend({ type: 'stroke:remove', page: viewer.pageNumber, id }); return;
  }
  if (!state.drawing || (event.pointerType!=='touch'&&!event.buttons)) return;
  event.preventDefault(); const pt = viewer.pointerToNormalized(event);
  if(state.drawing.tool==='rect'||state.drawing.tool==='zoom-box'){ state.drawing.points.splice(3,3,pt.x,pt.y,pt.p); viewer.updateLiveStroke(state.drawing.id,state.drawing.points); return; }
  state.drawing.points.push(pt.x, pt.y, pt.p); viewer.appendLivePoints(state.drawing.id, [pt.x, pt.y, pt.p]); state.pointBatch.push(pt.x, pt.y, pt.p);
  if (!state.batchTimer) state.batchTimer = setTimeout(flushPointBatch, 35);
}
function flushPointBatch() { state.batchTimer = 0; if (!state.drawing || !state.pointBatch.length) return; wsSend({ type: 'stroke:points', id: state.drawing.id, page: state.drawing.page, points: state.pointBatch.splice(0) }); }
async function pointerUp() {
  if(state.laserActive){state.laserActive=false; wsSend({type:'laser',active:false}); renderLaser({x:0,y:0},false); return;}
  if (!state.drawing) return; flushPointBatch(); const stroke = state.drawing; state.drawing = null;
  if(stroke.tool==='zoom-box'){
    viewer.finishLiveStroke(stroke.id); state.zoomSelection=null;
    const view=viewer.viewForRect(stroke.points);
    if(!view){showToast(toast,'확대할 부분을 조금 더 크게 선택해주세요.');return;}
    const x1=Math.min(stroke.points[0],stroke.points[3]),x2=Math.max(stroke.points[0],stroke.points[3]);
    const y1=Math.min(stroke.points[1],stroke.points[4]),y2=Math.max(stroke.points[1],stroke.points[4]);
    const region={x:x1,y:y1,width:x2-x1,height:y2-y1};
    rememberView(); await new Promise(resolve=>setTimeout(resolve,220)); await applyGuideView(view); wsSend({type:'focus',region}); return;
  }
  viewer.addStroke(stroke.page, stroke); viewer.finishLiveStroke(stroke.id); wsSend({ type: 'stroke:end', id: stroke.id, page: stroke.page, stroke });
}

function cancelDrawing(){ if(!state.drawing)return; const id=state.drawing.id; viewer.finishLiveStroke(id); state.drawing=null; state.pointBatch=[]; clearTimeout(state.batchTimer); state.batchTimer=0; wsSend({type:'stroke:cancel',id}); }

function ensureLaserTrail(){const frame=$('#pdf-frame');if(frame.querySelector('.laser-trail'))return;for(let i=0;i<8;i++){const trail=document.createElement('i');trail.className='laser-trail';trail.style.setProperty('--trail-opacity',String(.42-i*.045));trail.style.setProperty('--trail-scale',String(.82-i*.065));frame.insertBefore(trail,$('#laser-dot'));}}
function renderLaser(pt,active){ensureLaserTrail();const dot=$('#laser-dot'),trails=[...document.querySelectorAll('.laser-trail')];if(!active){dot.classList.remove('visible');trails.forEach(t=>t.classList.remove('visible'));state.laserHistory=[];return;}state.laserHistory.unshift({x:pt.x,y:pt.y});state.laserHistory=state.laserHistory.slice(0,48);dot.style.left=`${pt.x*100}%`;dot.style.top=`${pt.y*100}%`;dot.classList.add('visible');const points=laserTrailPoints(state.laserHistory,trails.length,$('#pdf-frame'));trails.forEach((trail,i)=>{const p=points[i];if(!p){trail.classList.remove('visible');return;}trail.style.left=`${p.x*100}%`;trail.style.top=`${p.y*100}%`;trail.classList.add('visible');});}
function laserTrailPoints(history,count,frame){if(history.length<2)return[];const result=[];let segment=0,walked=0;for(let i=0;i<count;i++){const target=(i+1)*6;while(segment<history.length-1){const a=history[segment],b=history[segment+1],length=Math.hypot((a.x-b.x)*frame.clientWidth,(a.y-b.y)*frame.clientHeight);if(walked+length>=target){const ratio=(target-walked)/Math.max(1,length);result.push({x:a.x+(b.x-a.x)*ratio,y:a.y+(b.y-a.y)*ratio});break;}walked+=length;segment++;}if(segment>=history.length-1)break;}return result;}
function sendLaser(pt,active){renderLaser(pt,active); const now=performance.now(); if(active&&now-state.laserSentAt<32)return; state.laserSentAt=now; wsSend({type:'laser',active,x:pt.x,y:pt.y,page:viewer.pageNumber}); }

window.addEventListener('beforeunload', () => { if (state.broadcasting) navigator.sendBeacon?.(`/api/rooms/${room}/rtc/publish/stop`); });
init().catch((error) => showFatalError('가이드 화면을 열 수 없습니다.', error));
