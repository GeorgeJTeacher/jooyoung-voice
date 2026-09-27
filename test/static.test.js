import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = ['index.html', 'guide.html', 'listen.html', 'src/main.js', 'src/guide.js', 'src/listen.js', 'src/shared/api.js', 'src/shared/pdf-viewer.js'];

test('browser bundle never contains Cloudflare secrets', async () => {
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /CF_REALTIME_APP_SECRET|CREATE_KEY=/, file);
  }
});

test('every queried DOM id exists in its page', async () => {
  for (const [script, html] of [['src/main.js', 'index.html'], ['src/guide.js', 'guide.html'], ['src/listen.js', 'listen.html']]) {
    const source = await readFile(script, 'utf8');
    const markup = await readFile(html, 'utf8');
    const ids = [...source.matchAll(/\$\(['"]#([\w-]+)['"]\)/g)].map((match) => match[1]);
    for (const id of new Set(ids)) assert.match(markup, new RegExp(`id=["']${id}["']`), `${script}: #${id}`);
  }
});

test('guide secrets stay in the URL fragment', async () => {
  const source = await readFile('src/main.js', 'utf8');
  assert.match(source, /guideUrl\}#\$\{data\.guideToken/);
  assert.doesNotMatch(source, /guideToken.*searchParams/);
});

test('listener intro and automatic audio quality flow are wired', async () => {
  const markup=await readFile('listen.html','utf8');
  const source=await readFile('src/listen.js','utf8');
  assert.match(markup,/id="intro-screen"/);
  assert.match(markup,/id="listen-button" class="[^"]*hidden/);
  assert.match(source,/async function authenticateAccess[\s\S]*?await unlockAudioOutput\(\)/);
  assert.match(source,/\.getStats\(\)/);
  assert.match(source,/type:'quality'/);
});

test('v1.2 guide drawer and rectangle zoom are wired', async () => {
  const markup=await readFile('guide.html','utf8');
  const source=await readFile('src/guide.js','utf8');
  const viewer=await readFile('src/shared/pdf-viewer.js','utf8');
  assert.match(markup,/id="control-panel-reopen"/);
  assert.match(markup,/data-tool="zoom-box"/);
  assert.match(markup,/id="zoom-back"/);
  assert.match(source,/viewForRect\(stroke\.points\)/);
  assert.match(viewer,/viewForRect\(points\)/);
  assert.match(source,/type:'focus',region/);
  assert.match(viewer,/viewForRegion\(region\)/);
});

test('participant PDF follows voting controls without manual navigation', async () => {
  const markup=await readFile('listen.html','utf8');
  const source=await readFile('src/listen.js','utf8');
  assert.ok(markup.indexOf('id="yes-button"') < markup.indexOf('class="listener-document"'));
  assert.doesNotMatch(markup,/id="follow-toggle"|id="manual-pages"/);
  assert.doesNotMatch(source,/manualPage|jumpToGuide/);
});

test('rectangle focus is validated and recalculated for listeners', async () => {
  const worker=await readFile('worker/index.js','utf8');
  const listener=await readFile('src/listen.js','utf8');
  assert.match(worker,/m\.type === 'focus'/);
  assert.match(worker,/sanitizeRegion\(m\.region\)/);
  assert.match(listener,/m\.type === 'focus'/);
  assert.match(listener,/viewer\.viewForRegion\(m\.region\)/);
});

test('rectangle focus center is not overwritten before scrolling', async () => {
  const viewer=await readFile('src/shared/pdf-viewer.js','utf8');
  const setView=viewer.match(/async setView\(view,[\s\S]*?\n  }\n\n  getView/)?.[0] || '';
  assert.match(setView,/return \{ \.\.\.this\.view \}/);
  assert.doesNotMatch(setView,/return this\.getView\(\)/);
  assert.doesNotMatch(viewer,/applyCenter\(\) \{\s*requestAnimationFrame/);
});

test('iPad guide drawer scrolls in a single column', async () => {
  const css=await readFile('src/app.css','utf8');
  assert.match(css,/\.control-panel \{[^}]*overflow-y:auto/);
  assert.match(css,/@media \(max-width: 820px\)[\s\S]*?\.control-panel-content \{ display:flex; flex-direction:column; \}/);
});

test('v1.3 iPad microphone recovery is wired', async () => {
  const markup=await readFile('guide.html','utf8');
  const source=await readFile('src/guide.js','utf8');
  assert.match(markup,/id="reconnect-mic-button"/);
  assert.match(source,/async function recoverMicrophone/);
  assert.match(source,/requestMicrophoneStream\(\)/);
  assert.match(source,/createMediaStreamSource\(nextStream\)/);
  assert.match(source,/state\.mixContext\.resume\(\)/);
  assert.match(source,/async function rebuildAudioPipeline/);
});

test('v1.3 headphone status has automatic and manual paths', async () => {
  const markup=await readFile('listen.html','utf8');
  const listener=await readFile('src/listen.js','utf8');
  const guide=await readFile('guide.html','utf8');
  const worker=await readFile('worker/index.js','utf8');
  assert.match(markup,/id="headphone-toggle"/);
  assert.match(listener,/enumerateDevices\(\)/);
  assert.match(listener,/devicechange/);
  assert.match(listener,/type:'headphones'/);
  assert.match(guide,/id="headphone-chip"/);
  assert.match(worker,/headphones:summary/);
});
