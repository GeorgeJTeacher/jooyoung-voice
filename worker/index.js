import { DurableObject } from 'cloudflare:workers';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_STROKES_PER_PAGE = 2500;
const MAX_POINTS_PER_STROKE = 6000; // x,y,p point triplets
const MAX_PAGE_POINT_VALUES = 90000; // keeps a page snapshot comfortably below the 2 MB value limit
const API_BASE = 'https://rtc.live.cloudflare.com/v1/apps';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return await routeApi(request, env, url);
      const response = await env.ASSETS.fetch(request);
      return withSecurityHeaders(response);
    } catch (error) {
      console.error(error);
      return json({ error: error?.message || '서버 오류가 발생했습니다.' }, 500);
    }
  },
};

async function routeApi(request, env, url) {
  if (request.method === 'POST' && url.pathname === '/api/rooms') {
    if (!env.CREATE_KEY) return json({ error: 'CREATE_KEY가 설정되지 않았습니다.' }, 503);
    if (request.headers.get('X-Create-Key') !== env.CREATE_KEY) return json({ error: '방 생성 코드가 올바르지 않습니다.' }, 403);
    const body = await readJson(request);
    const title = String(body.title || '현장 답사 LIVE').slice(0, 60);
    const listenerPassword = String(body.listenerPassword || '');
    if (listenerPassword.length < 4 || listenerPassword.length > 20) return json({ error: '참가 비밀번호는 4~20자리로 입력하세요.' }, 400);
    const expiresHours = clamp(Number(body.expiresHours) || 4, 2, 12);
    let roomId, stub;
    for (let i = 0; i < 8; i++) {
      roomId = randomRoomId(); stub = env.ROOMS.getByName(roomId);
      const exists = await stub.fetch('https://room/internal/status');
      if (exists.status === 404) break;
    }
    const guideToken = randomToken(32);
    const init = await stub.fetch('https://room/internal/init', { method: 'POST', body: JSON.stringify({ roomId, title, guideToken, listenerPassword, expiresAt: Date.now() + expiresHours * 3600_000 }) });
    if (!init.ok) return init;
    return json({ roomId, guideToken, guideUrl: `/guide.html?room=${roomId}`, listenerUrl: `/listen.html?room=${roomId}` });
  }

  const match = url.pathname.match(/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(.*))?$/);
  if (!match) return json({ error: 'Not found' }, 404);
  const roomId = match[1]; const action = match[2] || '';
  const stub = env.ROOMS.getByName(roomId);

  if (request.method === 'GET' && action === 'status') {
    const res = await stub.fetch('https://room/internal/status'); return passJson(res);
  }

  if (request.method === 'POST' && action === 'access') {
    const body=await readJson(request); const ip=request.headers.get('CF-Connecting-IP')||'unknown';
    const attemptKey=await sha256(`${roomId}:${ip}`);
    const res=await stub.fetch('https://room/internal/access',{method:'POST',body:JSON.stringify({password:String(body.password||''),attemptKey})}); return passJson(res);
  }

  if (request.method === 'POST' && action === 'access/check') {
    const valid=await isListener(request,stub); return valid ? json({ok:true}) : json({error:'참가 권한이 만료되었습니다. 비밀번호를 다시 입력하세요.'},403);
  }

  if (request.method === 'POST' && action === 'listener-ws-ticket') {
    if (!(await canListen(request,stub))) return json({error:'참가 권한이 없습니다.'},403);
    const res=await stub.fetch('https://room/internal/listener-ws-ticket',{method:'POST'}); return passJson(res);
  }

  if (request.method === 'GET' && action === 'rtc/ice-servers') {
    const status = await stub.fetch('https://room/internal/status');
    if (!status.ok) return passJson(status);
    if (!env.CF_TURN_KEY_ID || !env.CF_TURN_KEY_API_TOKEN) return json({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], turnEnabled: false });
    const turnRes = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`, { method:'POST', headers:{ Authorization:`Bearer ${env.CF_TURN_KEY_API_TOKEN}`, 'Content-Type':'application/json' }, body:JSON.stringify({ ttl:14400 }) });
    const turn = await turnRes.json().catch(() => ({}));
    if (!turnRes.ok || !Array.isArray(turn.iceServers)) { console.error('TURN_CREDENTIAL_ERROR', turnRes.status, JSON.stringify(turn)); return json({ error:'음성 우회망 연결 정보를 만들지 못했습니다.' },502); }
    const iceServers = turn.iceServers.map((server) => ({ ...server, urls:Array.isArray(server.urls) ? server.urls.filter((url) => !String(url).includes(':53')) : server.urls }));
    return json({ iceServers, turnEnabled:true });
  }

  if (action === 'ws' && request.method === 'GET') {
    const role = url.searchParams.get('role') === 'guide' ? 'guide' : 'listener';
    const ticket = url.searchParams.get('ticket') || '';
    const client = url.searchParams.get('client') || '';
    return stub.fetch(new Request(`https://room/ws?role=${role}&ticket=${encodeURIComponent(ticket)}&client=${encodeURIComponent(client)}`, request));
  }

  if (request.method === 'POST' && action === 'ws-ticket') {
    if (!(await isGuide(request, stub))) return json({ error: '가이드 권한이 없습니다.' }, 403);
    const res = await stub.fetch('https://room/internal/ticket', { method: 'POST' }); return passJson(res);
  }

  if (request.method === 'PUT' && action === 'pdf') {
    if (!(await isGuide(request, stub))) return json({ error: '가이드 권한이 없습니다.' }, 403);
    const length = Number(request.headers.get('content-length') || 0); if (length > MAX_PDF_BYTES) return json({ error: 'PDF는 25MB 이하만 가능합니다.' }, 413);
    if (!(request.headers.get('content-type') || '').includes('application/pdf')) return json({ error: 'PDF 파일만 업로드할 수 있습니다.' }, 415);
    const bytes = await request.arrayBuffer(); if (bytes.byteLength > MAX_PDF_BYTES) return json({ error: 'PDF는 25MB 이하만 가능합니다.' }, 413);
    if (new TextDecoder('ascii').decode(bytes.slice(0, 5)) !== '%PDF-') return json({ error: '올바른 PDF 파일이 아닙니다.' }, 415);
    const fileName = safeFileName(decodeURIComponent(request.headers.get('X-File-Name') || 'guide.pdf'));
    const pdfVersion = Date.now();
    await env.PDFS.put(`rooms/${roomId}/document.pdf`, bytes, { httpMetadata: { contentType: 'application/pdf', cacheControl: 'private, max-age=60' }, customMetadata: { fileName, pdfVersion: String(pdfVersion) } });
    await stub.fetch('https://room/internal/pdf-info', { method: 'POST', body: JSON.stringify({ pdfName: fileName, pdfVersion }) });
    return json({ ok: true, pdfVersion });
  }

  if (request.method === 'GET' && action === 'pdf') {
    if (!(await isGuide(request,stub)) && !(await canListen(request,stub))) return json({error:'비밀번호 인증이 필요합니다.'},403);
    const obj = await env.PDFS.get(`rooms/${roomId}/document.pdf`); if (!obj) return json({ error: 'PDF가 아직 없습니다.' }, 404);
    const headers = new Headers(); obj.writeHttpMetadata(headers); headers.set('ETag', obj.httpEtag); headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(obj.customMetadata?.fileName || 'guide.pdf')}`);
    return new Response(obj.body, { headers });
  }

  if (request.method === 'POST' && action === 'pdf-info') {
    if (!(await isGuide(request, stub))) return json({ error: '가이드 권한이 없습니다.' }, 403);
    const body = await readJson(request); await stub.fetch('https://room/internal/pdf-info', { method: 'POST', body: JSON.stringify({ pageCount: clamp(Number(body.pageCount) || 0, 0, 500) }) }); return json({ ok: true });
  }

  if (request.method === 'POST' && action === 'rtc/publish') {
    if (!(await isGuide(request, stub))) return json({ error: '가이드 권한이 없습니다.' }, 403);
    requireRealtime(env); const body = await readJson(request); if (!body.sdp || !body.trackName) return json({ error: 'SDP 또는 오디오 트랙이 없습니다.' }, 400);
    const session = await cf(env, '/sessions/new', 'POST');
    const payload = { sessionDescription: { sdp: body.sdp, type: 'offer' }, tracks: [{ location: 'local', mid: body.mid ?? '0', trackName: body.trackName }] };
    const pushed = await cf(env, `/sessions/${session.sessionId}/tracks/new`, 'POST', payload);
    return json({ ...pushed, publisherSessionId: session.sessionId, publisherTrackName: body.trackName });
  }

  if (request.method === 'POST' && action === 'rtc/publish/ready') {
    if (!(await isGuide(request, stub))) return json({ error: '가이드 권한이 없습니다.' }, 403);
    const body = await readJson(request);
    if (!body.sessionId || !body.trackName) return json({ error: '방송 연결 정보가 없습니다.' }, 400);
    await stub.fetch('https://room/internal/audio-source', { method: 'POST', body: JSON.stringify({ sessionId: String(body.sessionId), trackName: String(body.trackName), publishedAt: Date.now(), version: Date.now() }) });
    return json({ ok: true });
  }

  if (request.method === 'POST' && action === 'rtc/publish/stop') {
    if (!(await isGuide(request, stub))) return json({ error: '가이드 권한이 없습니다.' }, 403);
    await stub.fetch('https://room/internal/audio-source', { method: 'DELETE' }); return json({ ok: true });
  }

  if (request.method === 'POST' && action === 'rtc/subscribe') {
    const listenerTicket = request.headers.get('X-Listener-Ticket') || '';
    const ticketValid = await stub.fetch('https://room/internal/listener-ticket/validate', { method: 'POST', body: JSON.stringify({ ticket: listenerTicket }) });
    if (!ticketValid.ok) return json({ error: '참가자 연결 권한이 만료되었습니다.' }, 403);
    requireRealtime(env); const sourceRes = await stub.fetch('https://room/internal/audio-source');
    if (!sourceRes.ok) return json({ error: '가이드 방송이 아직 시작되지 않았습니다.' }, 409);
    const source = await sourceRes.json(); const session = await cf(env, '/sessions/new', 'POST');
    const pull = await cf(env, `/sessions/${session.sessionId}/tracks/new`, 'POST', { tracks: [{ location: 'remote', sessionId: source.sessionId, trackName: source.trackName }] });
    const sessionToken = randomToken(20); await stub.fetch('https://room/internal/rtc-session', { method: 'POST', body: JSON.stringify({ sessionId: session.sessionId, sessionToken, expiresAt: Date.now() + 3 * 3600_000 }) });
    return json({ sessionId: session.sessionId, sessionToken, pull });
  }

  if (request.method === 'PUT' && action === 'rtc/renegotiate') {
    requireRealtime(env); const body = await readJson(request); const valid = await stub.fetch('https://room/internal/rtc-session/validate', { method: 'POST', body: JSON.stringify({ sessionId: body.sessionId, sessionToken: body.sessionToken }) });
    if (!valid.ok) return json({ error: '오디오 세션이 만료되었습니다.' }, 403);
    const result = await cf(env, `/sessions/${encodeURIComponent(body.sessionId)}/renegotiate`, 'PUT', { sessionDescription: { sdp: body.sdp, type: 'answer' } }); return json(result);
  }

  return json({ error: 'Not found' }, 404);
}

export class Room extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; this.inflight = new Map(); }

  async fetch(request) {
    const url = new URL(request.url); const path = url.pathname;
    if (path === '/internal/init' && request.method === 'POST') {
      if (await this.ctx.storage.get('meta')) return json({ error: '이미 존재하는 방입니다.' }, 409);
      const body = await readJson(request); const meta = { roomId: body.roomId, title: body.title, currentPage: 1, pageCount: 0, pdfVersion: 0, pdfName: '', pdfView:{scale:1,x:.5,y:.5}, expiresAt: body.expiresAt, createdAt: Date.now(), accessRequired:!!body.listenerPassword };
      const accessSalt=randomToken(16), listenerHash=await passwordHash(body.listenerPassword||'',accessSalt);
      await this.ctx.storage.put({ meta, guideHash: await sha256(body.guideToken), accessSalt, listenerHash }); await this.ctx.storage.setAlarm(body.expiresAt); return json({ ok: true });
    }
    if (path === '/internal/status') {
      const meta = await this.ctx.storage.get('meta'); if (!meta) return json({ error: '방을 찾을 수 없습니다.' }, 404); if (meta.expiresAt <= Date.now()) return json({ error: '종료된 방입니다.' }, 410);
      return json({ ...meta, audioAvailable: !!(await this.ctx.storage.get('audioSource')), listenerCount: this.countListeners() });
    }
    if (path === '/internal/auth' && request.method === 'POST') { const meta = await this.ctx.storage.get('meta'); if (!meta || meta.expiresAt <= Date.now()) return new Response(null, { status: 410 }); const { token } = await readJson(request); const hash = await sha256(token || ''); return new Response(null, { status: hash === await this.ctx.storage.get('guideHash') ? 204 : 403 }); }
    if (path === '/internal/access' && request.method === 'POST') {
      const meta=await this.requireMeta(), body=await readJson(request), key=`attempt:${String(body.attemptKey||'').slice(0,80)}`, now=Date.now();
      const attempt=(await this.ctx.storage.get(key))||{count:0,lockUntil:0};
      if(attempt.lockUntil>now)return json({error:`비밀번호를 여러 번 틀렸습니다. ${Math.ceil((attempt.lockUntil-now)/1000)}초 후 다시 시도하세요.`},429);
      const salt=await this.ctx.storage.get('accessSalt'), expected=await this.ctx.storage.get('listenerHash'), actual=await passwordHash(String(body.password||''),salt||'');
      if(actual!==expected){attempt.count=Number(attempt.count||0)+1;if(attempt.count>=5){attempt.count=0;attempt.lockUntil=now+60_000;}await this.ctx.storage.put(key,attempt);return json({error:attempt.lockUntil>now?'비밀번호를 5회 틀렸습니다. 1분 후 다시 시도하세요.':'비밀번호가 올바르지 않습니다.'},403);}
      await this.ctx.storage.delete(key);const accessToken=randomToken(32);await this.ctx.storage.put(`access:${await sha256(accessToken)}`,meta.expiresAt);return json({accessToken,expiresAt:meta.expiresAt});
    }
    if (path === '/internal/access/validate' && request.method === 'POST') {const {token}=await readJson(request);const expires=await this.ctx.storage.get(`access:${await sha256(token||'')}`);return new Response(null,{status:expires>Date.now()?204:403});}
    if (path === '/internal/ticket' && request.method === 'POST') { const ticket = randomToken(18); await this.ctx.storage.put(`ticket:${ticket}`, Date.now() + 60_000); return json({ ticket }); }
    if (path === '/internal/listener-ws-ticket' && request.method === 'POST') {const ticket=randomToken(18);await this.ctx.storage.put(`listener-ws:${ticket}`,Date.now()+60_000);return json({ticket});}
    if (path === '/internal/pdf-info' && request.method === 'POST') { const meta = await this.requireMeta(); const body = await readJson(request); if ('pdfVersion' in body && Number(body.pdfVersion) !== meta.pdfVersion) { const oldPages = await this.ctx.storage.list({prefix:'page:'}); if (oldPages.size) await this.ctx.storage.delete([...oldPages.keys()]); meta.currentPage = 1; meta.pageCount = 0; } if ('pdfName' in body) meta.pdfName = String(body.pdfName).slice(0,180); if ('pdfVersion' in body) meta.pdfVersion = Number(body.pdfVersion); if ('pageCount' in body) meta.pageCount = clamp(Number(body.pageCount)||0,0,500); await this.ctx.storage.put('meta', meta); this.broadcast({ type:'pdf:updated', pdfVersion:meta.pdfVersion, pdfName:meta.pdfName, pageCount:meta.pageCount }); return json({ok:true}); }
    if (path === '/internal/audio-source') {
      if (request.method === 'GET') { const source = await this.ctx.storage.get('audioSource'); return source ? json(source) : json({ error:'방송 없음' },404); }
      if (request.method === 'POST') { const source = {...await readJson(request), paused:false}; await this.ctx.storage.put('audioSource', source); this.broadcast({ type:'audio:source', available:true, paused:false, version:source.version || Date.now() }); return json({ok:true}); }
      if (request.method === 'DELETE') { await this.ctx.storage.delete('audioSource'); this.broadcast({ type:'audio:source', available:false, paused:false }); return json({ok:true}); }
    }
    if (path === '/internal/rtc-session' && request.method === 'POST') { const body = await readJson(request); await this.ctx.storage.put(`rtc:${body.sessionId}`, { hash: await sha256(body.sessionToken), expiresAt:body.expiresAt }); return json({ok:true}); }
    if (path === '/internal/rtc-session/validate' && request.method === 'POST') { const body = await readJson(request); const saved = await this.ctx.storage.get(`rtc:${body.sessionId}`); const ok = saved && saved.expiresAt > Date.now() && saved.hash === await sha256(body.sessionToken || ''); return new Response(null,{status:ok?204:403}); }
    if (path === '/internal/listener-ticket/validate' && request.method === 'POST') { const {ticket} = await readJson(request); const key=`listener-ticket:${String(ticket||'')}`; const expires=await this.ctx.storage.get(key); if(expires) await this.ctx.storage.delete(key); return new Response(null,{status:expires>Date.now()?204:403}); }
    if (path === '/ws') return this.acceptWs(request, url);
    return json({ error:'Not found' },404);
  }

  async acceptWs(request, url) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status:426 });
    const meta = await this.requireMeta(); if (meta.expiresAt <= Date.now()) return new Response('Expired', { status:410 });
    const role = url.searchParams.get('role') === 'guide' ? 'guide' : 'listener';
    const clientId=String(url.searchParams.get('client')||crypto.randomUUID()).slice(0,80);
    if (role === 'listener') {const ticket=url.searchParams.get('ticket')||'',expires=await this.ctx.storage.get(`listener-ws:${ticket}`);if(!expires||expires<Date.now())return new Response('Forbidden',{status:403});await this.ctx.storage.delete(`listener-ws:${ticket}`);if(this.countListeners()>=50&&!this.hasListenerClient(clientId))return new Response('Room full',{status:429});}
    if (role === 'guide') { const ticket = url.searchParams.get('ticket') || ''; const expires = await this.ctx.storage.get(`ticket:${ticket}`); if (!expires || expires < Date.now()) return new Response('Forbidden',{status:403}); await this.ctx.storage.delete(`ticket:${ticket}`); }
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair); this.ctx.acceptWebSocket(server); server.serializeAttachment({ id:crypto.randomUUID(), clientId, role, joinedAt:Date.now(), lastAudioTicketAt:0, vote:null, voteUntil:0 });
    const strokes = await this.loadPage(meta.currentPage); const audioSource = await this.ctx.storage.get('audioSource'); server.send(JSON.stringify({ type:'hello', meta, page:meta.currentPage, strokes, presence:{listeners:this.countListeners()}, votes:this.countVotes(), audioAvailable:!!audioSource, audioPaused:!!audioSource?.paused, audioVersion:audioSource?.version || 0 })); this.broadcastPresence(); this.broadcastVotes();
    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws, message) {
    let m; try { m = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); } catch { return; }
    const attachment = ws.deserializeAttachment() || {}; const role = attachment.role;
    if (m.type === 'client:diagnostic' && role === 'listener') { console.error('LISTENER_DIAGNOSTIC', JSON.stringify({ stage:String(m.stage||'').slice(0,80), name:String(m.name||'').slice(0,80), message:String(m.message||'').slice(0,300) })); return; }
    if (m.type === 'snapshot:page') { const page = clamp(Number(m.page)||1,1,500); ws.send(JSON.stringify({type:'snapshot',page,strokes:await this.loadPage(page)})); return; }
    if (m.type === 'vote' && role === 'listener') { attachment.vote=['yes','no'].includes(m.choice)?m.choice:null; attachment.voteUntil=attachment.vote?Date.now()+10_000:0; ws.serializeAttachment(attachment); this.broadcastVotes(); return; }
    if (m.type === 'audio:ticket' && role === 'listener') { const now=Date.now(); if(now-Number(attachment.lastAudioTicketAt||0)<1500) return; const ticket=randomToken(18); await this.ctx.storage.put(`listener-ticket:${ticket}`,now+30_000); attachment.lastAudioTicketAt=now; ws.serializeAttachment(attachment); ws.send(JSON.stringify({type:'audio:ticket',ticket})); return; }
    if (role !== 'guide') return;
    if (m.type === 'laser') { this.broadcast({type:'laser',active:!!m.active,x:clamp(Number(m.x)||0,0,1),y:clamp(Number(m.y)||0,0,1),page:clamp(Number(m.page)||1,1,500)},'listener'); return; }
    if (m.type === 'view') { const meta=await this.requireMeta(); meta.pdfView=sanitizeView(m.view); await this.ctx.storage.put('meta',meta); this.broadcast({type:'view',view:meta.pdfView},'listener'); return; }
    if (m.type === 'audio:pause') { const source=await this.ctx.storage.get('audioSource'); if(source){source.paused=!!m.paused; await this.ctx.storage.put('audioSource',source); this.broadcast({type:'audio:pause',paused:source.paused},'listener');} return; }
    if (m.type === 'page') { const meta = await this.requireMeta(); meta.currentPage = clamp(Number(m.page)||1,1,Math.max(1,meta.pageCount||500)); await this.ctx.storage.put('meta',meta); this.broadcast({type:'page',page:meta.currentPage},'listener'); return; }
    if (m.type === 'stroke:start') { const s = sanitizeStroke(m.stroke); if (!s) return; this.inflight.set(s.id,s); this.broadcast({type:'stroke:start',stroke:s},'listener'); return; }
    if (m.type === 'stroke:cancel') { const id=String(m.id||'').slice(0,80); this.inflight.delete(id); this.broadcast({type:'stroke:cancel',id},'listener'); return; }
    if (m.type === 'stroke:points') { const s = this.inflight.get(String(m.id)); if (!s) return; const points = sanitizePoints(m.points); if (!points.length) return; if (s.points.length + points.length <= MAX_POINTS_PER_STROKE * 3) s.points.push(...points); this.broadcast({type:'stroke:points',id:s.id,page:s.page,points},'listener'); return; }
    if (m.type === 'stroke:end') { const id = String(m.id); const s = sanitizeStroke(m.stroke) || this.inflight.get(id); if (!s || s.id !== id) return; this.inflight.delete(id); const list = await this.loadPage(s.page); list.push(s); if (list.length > MAX_STROKES_PER_PAGE) list.splice(0,list.length-MAX_STROKES_PER_PAGE); let valueCount=list.reduce((n,stroke)=>n+(stroke.points?.length||0),0); while(list.length>1 && valueCount>MAX_PAGE_POINT_VALUES){ const removed=list.shift(); valueCount-=removed.points?.length||0; } await this.savePage(s.page,list); this.broadcast({type:'stroke:end',id:s.id,page:s.page},'listener'); this.broadcast({type:'stroke:committed',page:s.page,stroke:s}); ws.send(JSON.stringify({type:'stroke:committed',page:s.page,stroke:s})); return; }
    if (m.type === 'stroke:remove') { const page=clamp(Number(m.page)||1,1,500), id=String(m.id); const list=await this.loadPage(page); const next=list.filter(s=>s.id!==id); if(next.length!==list.length){await this.savePage(page,next); this.broadcast({type:'stroke:remove',page,id});} return; }
    if (m.type === 'undo') { const page=clamp(Number(m.page)||1,1,500); const list=await this.loadPage(page); const removed=list.pop(); if(removed){await this.savePage(page,list); this.broadcast({type:'stroke:remove',page,id:removed.id});} return; }
    if (m.type === 'page:clear') { const page=clamp(Number(m.page)||1,1,500); await this.savePage(page,[]); this.broadcast({type:'page:clear',page}); return; }
  }

  webSocketClose(ws) { this.broadcastPresence(); this.broadcastVotes(); }
  webSocketError(ws) { try { ws.close(1011,'WebSocket error'); } catch {} this.broadcastPresence(); this.broadcastVotes(); }

  async alarm() { for (const ws of this.ctx.getWebSockets()) try { ws.close(1000,'Room expired'); } catch {} const meta=await this.ctx.storage.get('meta'); if(meta?.roomId) await this.env.PDFS.delete(`rooms/${meta.roomId}/document.pdf`).catch(()=>{}); await this.ctx.storage.deleteAll(); }
  async requireMeta(){ const meta=await this.ctx.storage.get('meta'); if(!meta) throw new Error('방을 찾을 수 없습니다.'); return meta; }
  async loadPage(page){ return (await this.ctx.storage.get(`page:${Number(page)}`)) || []; }
  async savePage(page,strokes){ await this.ctx.storage.put(`page:${Number(page)}`,strokes); }
  countListeners(){ const ids=new Set(); for(const ws of this.ctx.getWebSockets()){const a=ws.deserializeAttachment(); if(a?.role==='listener')ids.add(a.clientId||a.id);} return ids.size; }
  hasListenerClient(clientId){ return this.ctx.getWebSockets().some(ws=>{const a=ws.deserializeAttachment();return a?.role==='listener'&&(a.clientId||a.id)===clientId;}); }
  countVotes(){ const now=Date.now(), counts={yes:0,no:0}, latest=new Map(); for(const ws of this.ctx.getWebSockets()){const a=ws.deserializeAttachment(); if(a?.role!=='listener'||Number(a.voteUntil||0)<=now||!(a.vote in counts))continue; const key=a.clientId||a.id, old=latest.get(key); if(!old||Number(a.voteUntil)>Number(old.voteUntil))latest.set(key,a);} for(const a of latest.values())counts[a.vote]++; return counts; }
  broadcastPresence(){ this.broadcast({type:'presence',listeners:this.countListeners()}); }
  broadcastVotes(){ this.broadcast({type:'votes',...this.countVotes()},'guide'); }
  broadcast(payload, role=null){ const text=JSON.stringify(payload); for(const ws of this.ctx.getWebSockets()){ const a=ws.deserializeAttachment(); if(role && a?.role!==role) continue; try{ws.send(text);}catch{}} }
}

async function isGuide(request, stub) { const token=request.headers.get('X-Guide-Token')||''; if(!token) return false; const res=await stub.fetch('https://room/internal/auth',{method:'POST',body:JSON.stringify({token})}); return res.status===204; }
async function isListener(request,stub){const token=request.headers.get('X-Listener-Token')||'';if(!token)return false;const res=await stub.fetch('https://room/internal/access/validate',{method:'POST',body:JSON.stringify({token})});return res.status===204;}
async function canListen(request,stub){const status=await stub.fetch('https://room/internal/status');if(!status.ok)return false;const meta=await status.json();return !meta.accessRequired||await isListener(request,stub);}
async function cf(env,path,method,body){ const res=await fetch(`${API_BASE}/${env.CF_REALTIME_APP_ID}${path}`,{method,headers:{Authorization:`Bearer ${env.CF_REALTIME_APP_SECRET}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}); const data=await res.json().catch(()=>({})); if(!res.ok || data.errorCode) throw new Error(data.errorDescription || data.error || `Realtime API ${res.status}`); return data; }
function requireRealtime(env){ if(!env.CF_REALTIME_APP_ID || !env.CF_REALTIME_APP_SECRET) throw new Error('Cloudflare Realtime 환경변수가 설정되지 않았습니다.'); }
async function readJson(request){ try{return await request.json();}catch{return {};} }
function json(data,status=200){ return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}}); }
async function passJson(res){ const text=await res.text(); return new Response(text,{status:res.status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}}); }
function clamp(n,min,max){ return Math.min(max,Math.max(min,n)); }
function randomRoomId(){ const bytes=crypto.getRandomValues(new Uint8Array(6)); return Array.from(bytes,b=>ROOM_ALPHABET[b%ROOM_ALPHABET.length]).join(''); }
function randomToken(bytes=24){ const a=crypto.getRandomValues(new Uint8Array(bytes)); return btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
async function sha256(value){ const data=new TextEncoder().encode(String(value)); const hash=await crypto.subtle.digest('SHA-256',data); return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join(''); }
async function passwordHash(password,salt){const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(String(password)),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(String(salt)),iterations:50000,hash:'SHA-256'},material,256);return Array.from(new Uint8Array(bits),b=>b.toString(16).padStart(2,'0')).join('');}
function safeFileName(name){ return String(name).replace(/[\r\n\0\\/]/g,'_').slice(0,160) || 'guide.pdf'; }
function sanitizePoints(points){ if(!Array.isArray(points)) return []; const out=[]; for(let i=0;i+2<points.length && out.length<900;i+=3){ const x=Number(points[i]),y=Number(points[i+1]),p=Number(points[i+2]); if(Number.isFinite(x)&&Number.isFinite(y)) out.push(clamp(x,0,1),clamp(y,0,1),Number.isFinite(p)?clamp(p,0,1):.5); } return out; }
function sanitizeStroke(input){ if(!input || typeof input!=='object') return null; const id=String(input.id||'').slice(0,80); if(!id) return null; const tool=['pen','highlighter','rect'].includes(input.tool)?input.tool:'pen'; const color=/^#[0-9a-fA-F]{6}$/.test(input.color||'')?input.color:'#e53935'; return {id,page:clamp(Number(input.page)||1,1,500),tool,color,width:clamp(Number(input.width)||.0045,.001,.05),opacity:clamp(Number(input.opacity)||1,.05,1),points:sanitizePoints(input.points)}; }
function sanitizeView(view){ return {scale:clamp(Number(view?.scale)||1,1,4),x:clamp(Number(view?.x)||.5,0,1),y:clamp(Number(view?.y)||.5,0,1)}; }
function withSecurityHeaders(response){ const headers=new Headers(response.headers); headers.set('X-Content-Type-Options','nosniff'); headers.set('Referrer-Policy','no-referrer'); headers.set('Permissions-Policy','camera=(), geolocation=(), microphone=(self)'); headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"); return new Response(response.body,{status:response.status,statusText:response.statusText,headers}); }
