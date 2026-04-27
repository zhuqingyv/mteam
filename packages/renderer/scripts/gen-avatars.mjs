#!/usr/bin/env node
// 用 PixelLab v2 API 生成 20 张像素风职业头像。
// 流程：POST /v2/create-character-with-4-directions -> 轮询 /background-jobs/{id}
//       -> GET /characters/{cid} 拿 rotation_urls.south -> 下载 PNG 到
//       packages/renderer/src/assets/avatars/avatar-XX.png
//
// API Key：从 ~/.claude/settings.json 读 "pixellabKey"。
// 风格统一：所有角色共享 BASE_PARAMS（chibi preset, flat shading, guidance 9.0 等），
//           只有 description 不同。

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(PROJECT_ROOT, 'src/assets/avatars');
const REPORT_PATH = resolve(OUT_DIR, 'report.md');
const MANIFEST_PATH = resolve(OUT_DIR, 'manifest.json');

const API_BASE = 'https://api.pixellab.ai/v2';

// 所有角色共享的参数，保证风格统一
const BASE_PARAMS = {
  // v2 create-character-with-4-directions 默认就是透明背景，传 no_background 会 422
  image_size: { width: 128, height: 128 },
  proportions: { type: 'preset', name: 'chibi' },
  outline: 'single color black outline',
  shading: 'flat shading',
  detail: 'low detail',
  view: 'low top-down',
  text_guidance_scale: 9.0,
};

// 公共 prompt 前缀 / 后缀，保证 20 张是"同一世界观"
const PROMPT_PREFIX =
  'pixel art chibi character portrait, ';
const PROMPT_SUFFIX =
  ', big round eyes, thick bold black outlines, rosy cheeks, friendly smile, ' +
  'front facing, simple flat colors, clean pixel art, centered, head and shoulders';

// 20 个职业：label + gender + 职业特征描述
// 性别平衡：10 男 10 女。#1-#6 已完成（偏男），所以 #7-#20 分配 10 女 + 4 男。
const ROLES = [
  ['01_frontend',       'male',   'young male software developer with glasses, hoodie, laptop icon on shirt'],
  ['02_backend',        'male',   'serious male backend engineer, short hair, dark shirt, server rack behind'],
  ['03_fullstack',      'male',   'male versatile developer holding two laptops, balanced confident face'],
  ['04_qa',             'male',   'male QA tester with magnifying glass, checklist clipboard, focused eyes'],
  ['05_architect',      'male',   'male software architect with beard holding blueprint scroll, thoughtful expression'],
  ['06_code_reviewer',  'male',   'male code reviewer with red pen and glasses, squinting critically at code'],
  ['07_devops',         'male',   'male devops engineer with headset, utility vest, wrench icon on chest'],
  ['08_ui_designer',    'female', 'female creative UI designer with beret, holding paint brush, colorful outfit'],
  ['09_tech_writer',    'female', 'female technical writer with round glasses, holding a notebook and pen, cozy sweater'],
  ['10_perf_expert',    'male',   'male athletic performance engineer with lightning bolt on shirt, holding stopwatch'],
  ['11_product_mgr',    'female', 'female professional product manager with clipboard, neat blazer, confident smile'],
  ['12_data_engineer',  'male',   'male data engineer with data flow pattern on shirt, wearing headphones'],
  ['13_security',       'female', 'female security expert in dark hoodie, shield icon on chest, serious expression'],
  ['14_game_dev',       'male',   'male game developer wearing gaming headset, controller icon on shirt, playful vibe'],
  ['15_ai_engineer',    'female', 'female AI engineer with neural network pattern on shirt, futuristic visor, long hair'],
  ['16_dba',            'male',   'male database administrator with database cylinder icon on shirt, organized neat hair'],
  ['17_scrum_master',   'female', 'female energetic scrum master with kanban board behind, casual attire, friendly pose'],
  ['18_i18n_expert',    'male',   'male localization expert with globe icon on shirt, multilingual text floating around'],
  ['19_refactor_pro',   'female', 'female refactoring specialist with wrench and code brackets on shirt, tidy confident'],
  ['20_mobile_dev',     'male',   'male mobile developer holding a smartphone, casual tech outfit, modern look'],
];

// ---------- HTTP 辅助 ----------

async function readApiKey() {
  const settingsPath = resolve(homedir(), '.claude/settings.json');
  const text = await readFile(settingsPath, 'utf8');
  // settings.json 可能带注释/trailing commas，用正则抽
  const m = text.match(/"pixellabKey"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error(`未在 ${settingsPath} 找到 pixellabKey`);
  return m[1];
}

async function http(method, path, key, body) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

async function pollJob(key, jobId, label, timeoutMs = 900_000) {
  const start = Date.now();
  let lastStatus = null;
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) throw new Error(`job ${jobId} 超时 ${timeoutMs}ms`);
    const r = await http('GET', `/background-jobs/${jobId}`, key);
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`poll ${label} HTTP ${r.status}: ${body.slice(0, 300)}`);
    }
    const data = await r.json();
    const status = data.status;
    if (status !== lastStatus) {
      console.log(`    [${label}] t=${(elapsed / 1000).toFixed(1)}s status=${status}`);
      lastStatus = status;
    }
    if (status === 'completed') return data;
    if (status === 'failed') {
      throw new Error(`job ${jobId} FAILED: ${JSON.stringify(data).slice(0, 500)}`);
    }
    await sleep(4000);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 单角色生成 ----------

async function generateOne(key, index, label, roleDesc) {
  const description = `${PROMPT_PREFIX}${roleDesc}${PROMPT_SUFFIX}`;
  const payload = { ...BASE_PARAMS, description };

  console.log(`\n[#${index}] ${label}`);
  console.log(`    desc: ${description.slice(0, 120)}...`);

  // PixelLab 账号最多 3 个并行 background jobs，超限会 429。
  // POST 时可能同步 429，也可能 job 创建后立刻 failed 带 429 文案。两种都要重试。
  let jobId = null;
  let job = null;
  const maxRetries = 8;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const r = await http('POST', '/create-character-with-4-directions', key, payload);
    if (r.status === 429 || (!r.ok && r.status === 503)) {
      const body = await r.text();
      const backoff = 20_000 + Math.floor(Math.random() * 20_000);
      console.log(`    POST ${r.status} (attempt ${attempt}/${maxRetries}) — backoff ${backoff}ms: ${body.slice(0, 200)}`);
      await sleep(backoff);
      continue;
    }
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`create HTTP ${r.status}: ${body.slice(0, 800)}`);
    }
    const data = await r.json();
    jobId = data.background_job_id;
    if (!jobId) throw new Error(`无 background_job_id: ${JSON.stringify(data)}`);
    console.log(`    job_id=${jobId}`);

    try {
      job = await pollJob(key, jobId, label);
      break;
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.includes('maximum number of background jobs') || msg.includes('429')) {
        const backoff = 20_000 + Math.floor(Math.random() * 20_000);
        console.log(`    job ${jobId} hit concurrency limit (attempt ${attempt}/${maxRetries}) — backoff ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  if (!job) throw new Error(`超过最大重试 ${maxRetries} 仍 429`);
  const last = job.last_response || {};
  const cid = last.character_id;
  if (!cid) throw new Error(`job completed 但无 character_id`);
  console.log(`    character_id=${cid}`);

  // 拿 south 方向 URL
  const cr = await http('GET', `/characters/${cid}`, key);
  if (!cr.ok) {
    const body = await cr.text();
    throw new Error(`GET character HTTP ${cr.status}: ${body.slice(0, 300)}`);
  }
  const info = await cr.json();
  const southUrl = info.rotation_urls?.south;
  if (!southUrl) throw new Error(`无 south url: ${JSON.stringify(info.rotation_urls)}`);

  // 下载
  const pr = await fetch(southUrl);
  if (!pr.ok) throw new Error(`下载 south HTTP ${pr.status}`);
  const bytes = new Uint8Array(await pr.arrayBuffer());

  const idx2 = String(index).padStart(2, '0');
  const outPath = resolve(OUT_DIR, `avatar-${idx2}.png`);
  const rawPath = resolve(OUT_DIR, `.raw_avatar-${idx2}.png`);
  await writeFile(rawPath, bytes);
  // PixelLab 返回 180×180，用 sips 缩到 128×128（保留 alpha）
  await execFileP('sips', ['-Z', '128', rawPath, '--out', outPath]);
  await unlink(rawPath).catch(() => {});
  const { stdout } = await execFileP('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', outPath]);
  console.log(`    saved ${outPath}\n${stdout.split('\n').slice(1).map((l) => '      ' + l).join('\n')}`);

  return {
    index,
    label,
    role: roleDesc,
    character_id: cid,
    description,
    png_path: outPath,
    png_size: bytes.length,
  };
}

// ---------- 主流程 ----------

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const key = await readApiKey();
  console.log(`API key loaded (len=${key.length})`);

  // 用法：
  //   node gen-avatars.mjs          全跑 20 张
  //   node gen-avatars.mjs 5        跑前 5 个
  //   node gen-avatars.mjs 20 7     单独跑第 7 个
  //   CONCURRENCY=6 node gen-avatars.mjs   调并发度（默认 4）
  const argN = process.argv[2] ? parseInt(process.argv[2], 10) : ROLES.length;
  const only = process.argv[3] ? parseInt(process.argv[3], 10) : null;
  const concurrency = parseInt(process.env.CONCURRENCY || '4', 10);

  const results = [];
  const failures = [];

  // 已有 manifest 的话可以跳过（断点续跑）
  let manifest = {};
  if (existsSync(MANIFEST_PATH)) {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
    console.log(`发现已有 manifest，已完成 ${Object.keys(manifest).length} 个`);
  }

  // 先筛出待生成的任务
  const pending = [];
  for (let i = 0; i < Math.min(argN, ROLES.length); i++) {
    const index = i + 1;
    if (only !== null && index !== only) continue;
    const [label, , role] = ROLES[i];
    const key2 = `avatar-${String(index).padStart(2, '0')}`;
    const outPath = resolve(OUT_DIR, `${key2}.png`);
    if (manifest[key2] && existsSync(outPath)) {
      console.log(`[#${index}] ${label} 已存在，跳过`);
      results.push(manifest[key2]);
      continue;
    }
    pending.push({ index, label, role, key2 });
  }

  console.log(`\n并发生成 ${pending.length} 个任务，concurrency=${concurrency}`);
  const start = Date.now();

  // 写 manifest 的串行化（多 worker 同时写会错乱）
  let manifestWriteChain = Promise.resolve();
  async function saveManifest() {
    manifestWriteChain = manifestWriteChain.then(() =>
      writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2)),
    );
    return manifestWriteChain;
  }

  // 任务池：多 worker 从共享队列抢任务
  const queue = pending.slice();
  async function worker(wid) {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      const { index, label, role, key2 } = job;
      try {
        const meta = await generateOne(key, index, label, role);
        manifest[key2] = meta;
        results.push(meta);
        await saveManifest();
      } catch (err) {
        console.error(`[W${wid}] #${index} ${label} FAILED: ${err.message}`);
        failures.push({ index, label, role, error: err.message });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, pending.length || 1) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const elapsedS = Math.round((Date.now() - start) / 1000);
  console.log(`\n全部完成，用时 ${elapsedS}s，成功 ${results.length}，失败 ${failures.length}`);

  // 写报告
  const lines = [];
  lines.push(`# PixelLab 头像生成报告`);
  lines.push(`生成时间: ${new Date().toISOString()}`);
  lines.push(`用时: ${elapsedS}s`);
  lines.push(`成功: ${results.length} / ${ROLES.length}`);
  lines.push(`失败: ${failures.length}`);
  lines.push('');
  lines.push(`## 统一参数`);
  lines.push('```json');
  lines.push(JSON.stringify(BASE_PARAMS, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(`## 每张头像`);
  lines.push('| # | label | 角色 | character_id | 字节数 |');
  lines.push('|---|---|---|---|---|');
  for (const m of results) {
    lines.push(`| ${m.index} | ${m.label} | ${m.role} | \`${m.character_id}\` | ${m.png_size} |`);
  }
  if (failures.length) {
    lines.push('');
    lines.push(`## 失败`);
    for (const f of failures) {
      lines.push(`- #${f.index} ${f.label}: ${f.error}`);
    }
  }
  await writeFile(REPORT_PATH, lines.join('\n'));
  console.log(`report: ${REPORT_PATH}`);

  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
