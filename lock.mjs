#!/usr/bin/env node
/*
 * 로그 잠금 도구 — 로그마다 다른 비밀번호
 *
 *   _raw/ 안의 원본 HTML을 각자의 비밀번호로 암호화해서 src/ 의 같은 경로에 만든다.
 *     _raw/coc26/njd/0706-1101-njd.html  →  src/coc26/njd/0706-1101-njd.html
 *
 *   사용법 (LOG 폴더에서)
 *     node lock.mjs           새 로그는 비밀번호를 물어보고, 바뀐 로그만 다시 암호화
 *     node lock.mjs --all     전부 다시 암호화
 *
 *   비밀번호 목록: _raw/passwords.json
 *     { "coc26/njd/0706-1101-njd.html": "비밀번호", ... }
 *   - 새 로그를 처음 암호화할 때 물어본 비밀번호가 여기에 저장된다.
 *   - 비밀번호를 바꾸려면 이 파일에서 값을 고치고 node lock.mjs 를 다시 실행하면 된다.
 *     (바뀐 비밀번호를 알아서 감지해 그 로그만 다시 암호화한다)
 *   - _raw/ 는 .gitignore 에 들어 있어서 GitHub 에 올라가지 않는다.
 *
 *   CSS 같은 다른 파일은 지금처럼 src/ 에 직접 둔다. 이 도구는 .html 만 만든다.
 *   필요: Node.js 18 이상
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import readline from 'node:readline';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RAW = join(ROOT, '_raw');
const OUT = join(ROOT, 'src');
const PASSWORDS = join(RAW, 'passwords.json');
const TEMPLATE_PATH = join(ROOT, 'lock-template.html');
const ITER = 600000; // PBKDF2-SHA256 반복 횟수
const ALL = process.argv.includes('--all');

/* ---------- 암호화 ---------- */
const deriveKey = (password, salt, iter) => pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iter, 32, 'sha256');

function encrypt(buf, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(password, salt, ITER), iv);
  const data = Buffer.concat([cipher.update(buf), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), data: data.toString('base64') };
}

// 이미 만들어진 잠금 파일이 이 비밀번호로 열리는지 확인
function opensWith(file, password) {
  try {
    const m = readFileSync(file, 'utf8').match(/var BOX = (\{.*?\});/s);
    if (!m) return false;
    const box = JSON.parse(m[1]);
    const raw = Buffer.from(box.data, 'base64');
    const d = createDecipheriv('aes-256-gcm', deriveKey(password, Buffer.from(box.salt, 'base64'), box.iter), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(raw.subarray(raw.length - 16));
    d.update(raw.subarray(0, raw.length - 16));
    d.final();
    return true;
  } catch {
    return false;
  }
}

/* ---------- 입력 ---------- */
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    muted = true;
  });
}

async function newPassword(rel) {
  console.log(`\n새 로그: ${rel}`);
  for (;;) {
    const pw = await ask('  이 로그의 비밀번호: ');
    if (pw.length < 4) { console.log('  비밀번호는 4자 이상이어야 해요.'); continue; }
    const again = await ask('  한 번 더 입력: ');
    if (pw !== again) { console.log('  두 비밀번호가 달라요. 다시 입력해 주세요.'); continue; }
    return pw;
  }
}

function fail(msg) {
  console.error('✖ ' + msg);
  process.exit(1);
}

/* ---------- 파일 ---------- */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.html?$/i.test(name)) out.push(p);
  }
  return out;
}

function loadPasswords() {
  if (!existsSync(PASSWORDS)) return {};
  try { return JSON.parse(readFileSync(PASSWORDS, 'utf8')); }
  catch { fail('_raw/passwords.json 형식이 잘못됐어요. 쉼표나 따옴표를 확인해 주세요.'); }
}

function savePasswords(list) {
  const sorted = Object.fromEntries(Object.entries(list).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(PASSWORDS, JSON.stringify(sorted, null, 2) + '\n');
}

function buildPage(box) {
  const json = JSON.stringify(box).replace(/</g, '\\u003c');
  return readFileSync(TEMPLATE_PATH, 'utf8').replace('/*__PAYLOAD__*/null', () => json);
}

/* ---------- 실행 ---------- */
if (!existsSync(RAW)) fail('_raw 폴더가 없어요. 원본 HTML을 _raw/분류/이름/파일.html 에 넣어 주세요.');

const files = walk(RAW);
if (!files.length) fail('_raw 안에 HTML 파일이 없어요.');

const passwords = loadPasswords();
const templateTime = statSync(TEMPLATE_PATH).mtimeMs;
let done = 0;

for (const src of files) {
  const rel = relative(RAW, src).split(sep).join('/');
  const dst = join(OUT, rel);

  let password = passwords[rel];
  if (!password) {
    password = await newPassword(rel);
    passwords[rel] = password;
    savePasswords(passwords); // 도중에 멈춰도 입력한 비밀번호는 남도록 바로 저장
  }

  const needed =
    ALL ||
    !existsSync(dst) ||
    statSync(dst).mtimeMs < Math.max(statSync(src).mtimeMs, templateTime) ||
    !opensWith(dst, password);
  if (!needed) continue;

  const html = readFileSync(src);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, buildPage(encrypt(gzipSync(html, { level: 9 }), password)));
  const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
  console.log(`✔ src/${rel}  (${mb(html.length)} → ${mb(statSync(dst).size)})`);
  done++;
}

// 원본이 사라진 비밀번호 항목 알림
const orphans = Object.keys(passwords).filter((k) => !existsSync(join(RAW, k)));
if (orphans.length) console.log(`\n참고: 원본이 없는 비밀번호 항목 → ${orphans.join(', ')}`);

console.log(done ? `\n${done}개 암호화 완료. 이제 커밋하고 푸시하면 돼요.` : '바뀐 로그가 없어요. 전부 다시 만들려면: node lock.mjs --all');
