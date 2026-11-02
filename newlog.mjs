#!/usr/bin/env node
/*
 * 새 로그 준비 도구
 *
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BASE_CSS = join(ROOT, 'style-base.css');
const INDEX = join(ROOT, 'index.html');
const IMAGES_MARK = /\/\*\s*__PROFILE_IMAGES__\s*\*\//;

function fail(msg) {
  console.error('✖ ' + msg);
  process.exit(1);
}

/* ---------- 인자 ---------- */
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const NO_INDEX = args.includes('--no-index');
const [input, target] = args.filter((a) => !a.startsWith('--'));

if (!input || !target) {
  console.log('사용법: node newlog.mjs "내려받은파일.html" 분류/이름/파일.html');
  console.log('예)    node newlog.mjs "배가 고픕니다.html" coc26/wian/0101-wian.html');
  process.exit(1);
}

const rel = target.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^(src|_raw)\//, '');
if (!/^[^/]+\/[^/]+\/[^/]+\.html?$/i.test(rel))
  fail(`경로는 "분류/이름/파일.html" 모양이어야 해요. (받은 값: ${target})`);
if (/[\s#?%]/.test(rel))
  fail('경로에는 띄어쓰기나 # ? % 를 쓰지 마세요. 주소가 깨질 수 있어요. 영문·숫자·- _ 를 권해요.');

const inputPath = resolve(input);
if (!existsSync(inputPath)) fail(`내려받은 파일을 찾을 수 없어요: ${inputPath}`);
if (!existsSync(BASE_CSS)) fail('style-base.css 가 없어요.');

const rawPath = join(ROOT, '_raw', rel);
const cssPath = join(ROOT, 'src', dirname(rel), 'style.css');

for (const p of [rawPath, cssPath])
  if (existsSync(p) && !FORCE) fail(`이미 있어요: ${p}\n  덮어쓰려면 --force 를 붙여 주세요.`);

/* ---------- 내려받은 로그 읽기 ---------- */
const html = readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, '');
const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
if (!styleMatch) fail('내려받은 파일에서 <style> 을 찾을 수 없어요.');
const exportCss = styleMatch[1];
if (!html.includes('ccfolia-original-wrap'))
  fail('코코포리아 로그 양식(#ccfolia-original-wrap)이 아니에요.');

// 프로필 이미지: .pi- 로 시작하는 줄 전부 (묶음 선택자 줄 포함)
const images = exportCss
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.startsWith('.pi-'));

// 색상 변수: 로그를 내보낼 때 고른 값
const wrapBlock = exportCss.match(/#ccfolia-original-wrap\s*\{([\s\S]*?)\}/);
const colors = {};
if (wrapBlock)
  for (const [, name, value] of wrapBlock[1].matchAll(/(--[\w-]*color)\s*:\s*([^;]+);/g)) colors[name] = value.trim();

/* ---------- CSS 만들기 ---------- */
let css = readFileSync(BASE_CSS, 'utf8');
if (!IMAGES_MARK.test(css)) fail('style-base.css 에서 /*__PROFILE_IMAGES__*/ 자리를 찾을 수 없어요.');
css = css.replace(IMAGES_MARK, () => images.join('\n') || '/* 이 로그에는 프로필 이미지가 없어요 */');

const changed = [];
for (const [name, value] of Object.entries(colors)) {
  const re = new RegExp(`(${name.replace(/-/g, '\\-')}\\s*:\\s*)([^;]+)(;)`);
  const m = css.match(re);
  if (m && m[2].trim() !== value) {
    css = css.replace(re, (_, a, _old, c) => a + value + c);
    changed.push(`${name}: ${value}`);
  }
}

/* ---------- 원본 HTML 정리 ---------- */
let out = html.replace(styleMatch[0], '');
// 스타일시트 연결 (head 안)
if (!/href=["']\.\/style\.css["']/.test(out))
  out = out.replace(/<\/head>/i, '    <link rel="stylesheet" href="./style.css">\n</head>');

// 제목 앞의 [..][..] 를 헤더 윗줄로 분리
const titleMatch = out.match(/<h1>\s*((?:\[[^\]]*\]\s*)+)([^<]*?)\s*<\/h1>/);
if (titleMatch && titleMatch[2].trim())
  out = out.replace(titleMatch[0], `<p>${titleMatch[1].trim()}</p>\n            <h1>${titleMatch[2].trim()}</h1>`);

const title = (out.match(/<title>([^<]*)<\/title>/i) || [, ''])[1].trim() || rel;

/* ---------- 쓰기 ---------- */
mkdirSync(dirname(rawPath), { recursive: true });
mkdirSync(dirname(cssPath), { recursive: true });
writeFileSync(rawPath, out);
writeFileSync(cssPath, css);

console.log(`✔ _raw/${rel}`);
console.log(`✔ src/${dirname(rel)}/style.css  (프로필 이미지 ${Math.max(images.length - 1, 0)}개)`);
console.log(changed.length ? `  색상: ${changed.join(', ')}` : '  색상: 기본 틀과 같음');

/* ---------- index.html 목록 ---------- */
if (!NO_INDEX && existsSync(INDEX)) {
  const index = readFileSync(INDEX, 'utf8');
  const href = `./src/${rel}`;
  if (index.includes(href)) {
    console.log('  index.html: 이미 목록에 있음');
  } else if (/<\/ol>/i.test(index)) {
    const esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const li = `      <li>\n        <a href="${href}">${esc}</a>\n      </li>\n    </ol>`;
    writeFileSync(INDEX, index.replace(/\s*<\/ol>/i, '\n' + li));
    console.log(`✔ index.html 목록에 추가: ${title}`);
  } else {
    console.log('  index.html 에 <ol> 목록이 없어서 링크는 직접 넣어 주세요.');
  }
}

console.log('\n다음: node lock.mjs  → 비밀번호·힌트 입력 → git add -A / commit / push');
