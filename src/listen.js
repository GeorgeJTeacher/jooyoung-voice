import { api, getIceServers, requestWakeLock, roomFromUrl, showFatalError, showToast, sleep, waitForIceGatheringComplete, wsUrl } from './shared/api.js';
import { PdfInkViewer } from './shared/pdf-viewer.js';

const room = roomFromUrl();
const listenerId = getListenerId();
const $ = (s) => document.querySelector(s);
const toast = $('#toast');
const viewer = new PdfInkViewer({ pdfCanvas: $('#pdf-canvas'), inkCanvas: $('#ink-canvas'), frame: $('#pdf-frame'), stage: $('#pdf-stage') });
const state = { ws: null, wsAttempt: 0, pc: null, rtc: null, wantAudio: false, playing: false, connecting: false, connectionGeneration: 0, audioAvailable: false, audioPaused: false, guidePage: 1, follow: true, pdfVersion: 0, wakeLock: null, reconnectTimer: null, confirmTimer: null, laserTimer: null, laserHistory:[], meta: null, audioSourceVersion: 0, ticketWaiter: null, audioContext: null, audioGain: null, audioSourceNode: null, exiting:false, accessToken:'' };

function makeClientId(){ if(crypto.randomUUID)return crypto.randomUUID(); const bytes=crypto.getRandomValues(new Uint8Array(16)); return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(''); }
function getListenerId(){ const key='guide-live-listener-id'; try{ let id=localStorage.getItem(key); if(!id){id=makeClientId();localStorage.setItem(key,id);} return id; }catch{return makeClientId();} }

async function init() {
  const status = await api(`/api/rooms/${room}/status`); state.meta = status; $('#room-title').textContent = status.title; state.guidePage = status.currentPage || 1;
  bind();
  if(status.accessRequired){
    state.accessToken=sessionStorage.getItem(`guide-live-access-${room}`)||'';
    if(state.accessToken){try{await api(`/api/rooms/${room}/access/check`,{method:'POST',headers:{'X-Listener-Token':state.accessToken}});return enterRoom();}catch{state.accessToken='';sessionStorage.removeItem(`guide-live-access-${room}`);}}
    $('#access-card').classList.remove('hidden'); $('#connection-chip').querySelector('b').textContent='비밀번호 필요'; return;
  }
  await enterRoom();
}

async function enterRoom(){ $('#access-card').classList.add('hidden'); $('#listener-content').classList.remove('hidden'); connectWs(); if(state.meta.pdfVersion)await loadPdf(state.meta.pdfVersion); }

function bind() {
  $('#access-form').addEventListener('submit',authenticateAccess);
  $('#listen-button').addEventListener('click', async () => {
    try { await unlockAudioOutput(); } catch (error) { return showToast(toast, `휴대폰 소리를 활성화할 수 없습니다: ${error.message}`, 5000); }
    state.wantAudio = true; state.wakeLock ||= await requestWakeLock();
    if (state.audioAvailable) subscribeAudio(); else { $('#audio-status').textContent = '방송 시작을 기다리는 중'; $('#listen-button').textContent = '연결 대기 중…'; }
  });
  $('#volume').addEventListener('input', (e) => { const volume = Number(e.target.value); $('#live-audio').volume = volume; if (state.audioGain) state.audioGain.gain.value = volume; });
  $('#yes-button').addEventListener('click', () => sendVote('yes'));
  $('#no-button').addEventListener('click', () => sendVote('no'));
  $('#exit-button').addEventListener('click', endParticipation);
  $('#follow-toggle').addEventListener('change', async (e) => { state.follow = e.target.checked; $('#manual-pages').classList.toggle('hidden', state.follow); if (state.follow) await jumpToGuide(); });
  $('#jump-guide').addEventListener('click', jumpToGuide);
  $('#prev-page').addEventListener('click', () => manualPage(viewer.pageNumber - 1)); $('#next-page').addEventListener('click', () => manualPage(viewer.pageNumber + 1));
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && state.wantAudio && !state.wakeLock) state.wakeLock = await requestWakeLock(); });
}

async function authenticateAccess(event){event.preventDefault();const button=event.currentTarget.querySelector('button'),message=$('#access-message');button.disabled=true;message.textContent='확인 중…';try{const result=await api(`/api/rooms/${room}/access`,{method:'POST',body:{password:$('#access-password').value,clientId:listenerId}});state.accessToken=result.accessToken;sessionStorage.setItem(`guide-live-access-${room}`,state.accessToken);message.textContent='';await enterRoom();}catch(error){message.textContent=error.message;button.disabled=false;}}

async function unlockAudioOutput() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  if (!state.audioContext || state.audioContext.state === 'closed') {
    state.audioContext = new AudioCtx();
    state.audioGain = state.audioContext.createGain();
    state.audioGain.gain.value = Number($('#volume').value);
    state.audioGain.connect(state.audioContext.destination);
  }
  if (state.audioContext.state !== 'running') await state.audioContext.resume();
}

async function connectWs() {
  if(state.exiting)return;
  try {
    const {ticket}=await api(`/api/rooms/${room}/listener-ws-ticket`,{method:'POST',headers:{'X-Listener-Token':state.accessToken}});
    const ws = new WebSocket(wsUrl(`/api/rooms/${room}/ws?role=listener&client=${encodeURIComponent(listenerId)}&ticket=${encodeURIComponent(ticket)}`)); state.ws = ws;
    ws.addEventListener('open', () => { state.wsAttempt = 0; setConnection('live', '연결됨'); });
    ws.addEventListener('message', handleWs);
    ws.addEventListener('close', async () => { if (state.ws !== ws || state.exiting) return; setConnection('warn', '재연결 중'); state.wsAttempt++; await sleep(Math.min(8000, 500 * 2 ** state.wsAttempt)); connectWs(); });
  } catch { await sleep(1000); connectWs(); }
}

async function endParticipation() {
  state.exiting=true; state.wantAudio=false; clearTimeout(state.reconnectTimer); clearTimeout(state.confirmTimer); clearTimeout(state.laserTimer);
  try{state.ws?.close(1000,'Participant left');}catch{} state.ws=null;
  stopAudio(false);
  if(state.audioContext){await state.audioContext.close().catch(()=>{});state.audioContext=null;}
  if(state.wakeLock){await state.wakeLock.release().catch(()=>{});state.wakeLock=null;}
  const screen=document.createElement('main'); screen.className='exit-screen'; screen.innerHTML='<h1>참가가 종료되었습니다</h1><p>음성과 실시간 연결을 모두 종료했습니다.<br>이 브라우저 탭을 닫아주세요.</p>';
  document.body.replaceChildren(screen);
  window.close();
}

function wsSend(m) { if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(m)); }
function setConnection(mode, text) { const el = $('#connection-chip'); el.className = `status-chip ${mode}`; el.querySelector('b').textContent = text; }

async function handleWs(event) {
  const m = JSON.parse(event.data);
  if (m.type === 'hello') {
    state.meta = m.meta; state.audioAvailable = !!m.audioAvailable; state.audioPaused = !!m.audioPaused; state.audioSourceVersion = Number(m.audioVersion || 0); state.guidePage = m.meta.currentPage || 1; $('#listener-count').textContent = `현재 ${m.presence.listeners}명 접속`;
    if (m.strokes) viewer.setPageStrokes(m.page, m.strokes); updateAudioWaiting();
    state.guideView = m.meta.pdfView || {scale:1,x:.5,y:.5};
    if (m.meta.pdfVersion && m.meta.pdfVersion !== state.pdfVersion) await loadPdf(m.meta.pdfVersion); else if(viewer.pdf) await viewer.setView(state.guideView);
  } else if (m.type === 'presence') {
    $('#listener-count').textContent = `현재 ${m.listeners}명 접속`;
  } else if (m.type === 'audio:source') {
    const changed = m.available && Number(m.version || 0) !== state.audioSourceVersion; state.audioAvailable = m.available; state.audioPaused = !!m.paused; if (m.available) state.audioSourceVersion = Number(m.version || 0); updateAudioWaiting(); if (!m.available) stopAudio(false); else if (state.wantAudio && changed) { stopAudio(false); subscribeAudio(); } else if (state.wantAudio) subscribeAudio();
  } else if (m.type === 'audio:pause') {
    state.audioPaused = !!m.paused;
    updateAudioWaiting();
  } else if (m.type === 'audio:ticket') {
    state.ticketWaiter?.resolve(m.ticket);
    state.ticketWaiter = null;
  } else if (m.type === 'page') {
    state.guidePage = m.page; $('#jump-guide').querySelector('b').textContent = m.page;
    if (state.follow && viewer.pdf) { await viewer.renderPage(m.page); updatePages(); wsSend({ type: 'snapshot:page', page: m.page }); $('#guide-page-hint').classList.add('hidden'); }
    else if (!state.follow && viewer.pageNumber !== m.page) $('#guide-page-hint').classList.remove('hidden');
  } else if (m.type === 'view') {
    state.guideView = m.view; if(viewer.pdf) await viewer.setView(m.view);
  } else if (m.type === 'laser') {
    clearTimeout(state.laserTimer); if(!m.active||Number(m.page)!==viewer.pageNumber){renderLaser({x:0,y:0},false);return;} renderLaser({x:Number(m.x),y:Number(m.y)},true); state.laserTimer=setTimeout(()=>renderLaser({x:0,y:0},false),700);
  } else if (m.type === 'snapshot') {
    viewer.setPageStrokes(m.page, m.strokes || []);
  } else if (m.type === 'stroke:start') {
    viewer.startLiveStroke(m.stroke);
  } else if (m.type === 'stroke:points') {
    viewer.appendLivePoints(m.id, m.points || []);
  } else if (m.type === 'stroke:end') {
    viewer.finishLiveStroke(m.id);
  } else if (m.type === 'stroke:cancel') {
    viewer.finishLiveStroke(m.id);
  } else if (m.type === 'stroke:committed') {
    viewer.addStroke(m.page, m.stroke);
  } else if (m.type === 'stroke:remove') {
    viewer.removeStroke(m.page, m.id);
  } else if (m.type === 'page:clear') {
    viewer.clearPage(m.page);
  } else if (m.type === 'pdf:updated') {
    await loadPdf(m.pdfVersion);
  }
}

function ensureLaserTrail(){const frame=$('#pdf-frame');if(frame.querySelector('.laser-trail'))return;for(let i=0;i<8;i++){const trail=document.createElement('i');trail.className='laser-trail';trail.style.setProperty('--trail-opacity',String(.42-i*.045));trail.style.setProperty('--trail-scale',String(.82-i*.065));frame.insertBefore(trail,$('#laser-dot'));}}
function renderLaser(pt,active){ensureLaserTrail();const dot=$('#laser-dot'),trails=[...document.querySelectorAll('.laser-trail')];if(!active){dot.classList.remove('visible');trails.forEach(t=>t.classList.remove('visible'));state.laserHistory=[];return;}state.laserHistory.unshift({x:pt.x,y:pt.y});state.laserHistory=state.laserHistory.slice(0,48);dot.style.left=`${pt.x*100}%`;dot.style.top=`${pt.y*100}%`;dot.classList.add('visible');const points=laserTrailPoints(state.laserHistory,trails.length,$('#pdf-frame'));trails.forEach((trail,i)=>{const p=points[i];if(!p){trail.classList.remove('visible');return;}trail.style.left=`${p.x*100}%`;trail.style.top=`${p.y*100}%`;trail.classList.add('visible');});}
function laserTrailPoints(history,count,frame){if(history.length<2)return[];const result=[];let segment=0,walked=0;for(let i=0;i<count;i++){const target=(i+1)*6;while(segment<history.length-1){const a=history[segment],b=history[segment+1],length=Math.hypot((a.x-b.x)*frame.clientWidth,(a.y-b.y)*frame.clientHeight);if(walked+length>=target){const ratio=(target-walked)/Math.max(1,length);result.push({x:a.x+(b.x-a.x)*ratio,y:a.y+(b.y-a.y)*ratio});break;}walked+=length;segment++;}if(segment>=history.length-1)break;}return result;}

function updateAudioWaiting() {
  $('#live-dot').classList.toggle('on', state.audioAvailable);
  if (state.audioAvailable && state.audioPaused) { $('#audio-status').textContent = '가이드가 방송을 잠시 멈췄습니다'; return; }
  if (!state.wantAudio) { $('#audio-status').textContent = state.audioAvailable ? '가이드가 방송 중입니다' : '가이드 방송을 기다리는 중'; return; }
  if (!state.audioAvailable) { $('#audio-status').textContent = '방송 시작을 기다리는 중'; $('#listen-button').textContent = '연결 대기 중…'; }
}

function sendVote(choice) {
  if (state.ws?.readyState !== WebSocket.OPEN) return showToast(toast, '연결을 복구하는 중입니다.');
  const button = choice === 'yes' ? $('#yes-button') : $('#no-button');
  clearTimeout(state.confirmTimer);
  $('#yes-button').classList.toggle('active',choice==='yes'); $('#no-button').classList.toggle('active',choice==='no');
  $('#vote-note').textContent = choice === 'yes' ? '“예” 응답이 전달되었습니다.' : '“아니요” 응답이 전달되었습니다.';
  wsSend({ type: 'vote', choice });
  state.confirmTimer = setTimeout(() => {
    button.classList.remove('active');
    $('#vote-note').textContent = '응답은 10초 동안 가이드에게 표시됩니다.';
    wsSend({ type: 'vote', choice: null });
  }, 10_000);
}

async function subscribeAudio() {
  if (!state.wantAudio || !state.audioAvailable || state.playing || state.connecting) return;
  state.connecting = true;
  const generation = ++state.connectionGeneration;
  let stage = '연결 준비';
  clearTimeout(state.reconnectTimer); $('#listen-button').disabled = true; $('#listen-button').textContent = '음성 연결 중…';
  try {
    stopAudio(false, false);
    stage = '음성 우회망 준비';
    const iceServers = await getIceServers(room);
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' }); state.pc = pc;
    const ensureCurrent = () => { if (generation !== state.connectionGeneration || state.pc !== pc) throw new Error('새 연결로 전환 중입니다.'); };
    stage = '참가 권한 요청';
    const listenerTicket = await requestAudioTicket();
    ensureCurrent();
    stage = '음성 세션 생성';
    const data = await api(`/api/rooms/${room}/rtc/subscribe`, { method: 'POST', headers: { 'X-Listener-Ticket': listenerTicket } }); state.rtc = data;
    ensureCurrent();
    const pull = data.pull;
    const tracksPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('오디오 트랙 연결 시간 초과')), 15_000);
      pc.addEventListener('track', (event) => {
        if (event.track.kind !== 'audio') return;
        clearTimeout(timer);
        resolve([event.track]);
      });
    });
    if (pull.requiresImmediateRenegotiation) {
      stage = '휴대폰 음성 설정';
      await pc.setRemoteDescription(pull.sessionDescription); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); await waitForIceGatheringComplete(pc);
      ensureCurrent();
      stage = 'Cloudflare 음성망 연결';
      await api(`/api/rooms/${room}/rtc/renegotiate`, { method: 'PUT', body: { sessionId: data.sessionId, sessionToken: data.sessionToken, sdp: pc.localDescription.sdp } });
    }
    stage = '오디오 수신 대기';
    const tracks = await tracksPromise; ensureCurrent(); const stream = new MediaStream(tracks); const audio = $('#live-audio'); audio.srcObject = stream; audio.volume = Number($('#volume').value); stage = '휴대폰 소리 재생';
    if (state.audioContext && state.audioGain) {
      if (state.audioContext.state !== 'running') throw new DOMException('소리 재생 버튼을 다시 눌러주세요.', 'NotAllowedError');
      state.audioSourceNode?.disconnect();
      state.audioSourceNode = state.audioContext.createMediaStreamSource(stream);
      state.audioSourceNode.connect(state.audioGain);
    } else {
      await audio.play();
    }
    ensureCurrent();
    state.playing = true; $('#listen-button').disabled = false; $('#listen-button').textContent = '🎧 듣는 중'; $('#audio-status').textContent = '가이드 음성 LIVE';
    pc.addEventListener('connectionstatechange', () => { if (state.pc === pc && state.wantAudio && ['failed','disconnected'].includes(pc.connectionState)) scheduleReconnect(); });
  } catch (error) {
    if (generation !== state.connectionGeneration) return;
    const detail = `${stage}: ${error?.name || 'Error'} - ${error?.message || '알 수 없는 오류'}`;
    console.error('listener audio failure', detail, error);
    wsSend({ type: 'client:diagnostic', stage, name: error?.name || 'Error', message: error?.message || '알 수 없는 오류' });
    $('#listen-button').disabled = false; $('#listen-button').textContent = '다시 연결'; $('#audio-status').textContent = `연결 실패 · ${detail}`; showToast(toast, detail, 6000);
    if (error?.name !== 'NotAllowedError') scheduleReconnect();
  } finally {
    if (generation === state.connectionGeneration) state.connecting = false;
  }
}

function requestAudioTicket() {
  if (state.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('실시간 연결을 복구하는 중입니다.'));
  if (state.ticketWaiter) return state.ticketWaiter.promise;
  let resolveTicket;
  let rejectTicket;
  const promise = new Promise((resolve, reject) => { resolveTicket = resolve; rejectTicket = reject; });
  const timer = setTimeout(() => {
    if (state.ticketWaiter?.promise === promise) state.ticketWaiter = null;
    rejectTicket(new Error('오디오 연결 권한을 받지 못했습니다.'));
  }, 5000);
  state.ticketWaiter = {
    promise,
    resolve(ticket) { clearTimeout(timer); resolveTicket(ticket); },
  };
  wsSend({ type: 'audio:ticket' });
  return promise;
}

function scheduleReconnect() { if(state.exiting)return; clearTimeout(state.reconnectTimer); state.reconnectTimer = setTimeout(() => { if(state.exiting)return; state.playing = false; subscribeAudio(); }, 1200); }
function stopAudio(reset = true, invalidate = true) { if (invalidate) { state.connectionGeneration++; state.connecting = false; } state.pc?.close(); state.pc = null; state.playing = false; state.audioSourceNode?.disconnect(); state.audioSourceNode = null; const audio = $('#live-audio'); audio.pause(); if (audio.srcObject) { audio.srcObject.getTracks().forEach(t => t.stop()); audio.srcObject = null; } if (reset) { $('#listen-button').disabled = false; $('#listen-button').textContent = '🎧 듣기 시작'; } }

async function loadPdf(version) {
  state.pdfVersion = Number(version); $('#empty-document').classList.add('hidden'); $('#pdf-stage').classList.remove('hidden'); $('#pdf-name').textContent = state.meta?.pdfName || '답사 자료';
  const count = await viewer.load(`/api/rooms/${room}/pdf?v=${version}`, state.accessToken ? { 'X-Listener-Token':state.accessToken } : undefined); $('#page-count').textContent = count;
  const page = Math.min(state.guidePage || 1, count); await viewer.renderPage(page); if(state.guideView)await viewer.setView(state.guideView); updatePages(); wsSend({ type: 'snapshot:page', page });
}
function updatePages() { $('#page-number').textContent = viewer.pdf ? viewer.pageNumber : 0; $('#page-count').textContent = viewer.pdf?.numPages || 0; }
async function manualPage(page) { if (!viewer.pdf || state.follow) return; page = Math.min(Math.max(1,page),viewer.pdf.numPages); await viewer.renderPage(page); updatePages(); wsSend({ type:'snapshot:page', page }); $('#guide-page-hint').classList.toggle('hidden', page === state.guidePage); }
async function jumpToGuide() { if (!viewer.pdf) return; await viewer.renderPage(state.guidePage); updatePages(); wsSend({ type:'snapshot:page', page:state.guidePage }); $('#guide-page-hint').classList.add('hidden'); }

init().catch((error) => showFatalError('답사 방에 들어갈 수 없습니다.', error));
