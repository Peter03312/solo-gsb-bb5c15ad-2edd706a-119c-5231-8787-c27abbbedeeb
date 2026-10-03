'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb } = require('../src/db');
const { createApp } = require('../src/routes');

let server;
let base;

before(async () => {
  const db = initDb(':memory:');
  const app = createApp(db);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function api(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const GOOD_WORDS = [
  { text: '你好', start_ms: 0, end_ms: 500 },
  { text: '世界', start_ms: 550, end_ms: 1000 },
  { text: '欢迎', start_ms: 1500, end_ms: 2000 },
  { text: '光临', start_ms: 2050, end_ms: 2500 },
];

/** 新建项目并排版，返回 { id, sub_version, cues }（两条：你好世界 / 欢迎光临） */
async function createLaidProject(overrides = {}) {
  const created = await api('/api/projects', 'POST', {
    name: '译文测试项目', words: GOOD_WORDS, cuts: [1200], ...overrides,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const p = created.body;
  const layout = await api(`/api/projects/${p.id}/layout`, 'POST', { sub_version: p.sub_version });
  assert.equal(layout.status, 200, JSON.stringify(layout.body));
  assert.equal(layout.body.subtitles.length, 2);
  return { id: p.id, sub_version: layout.body.sub_version, cues: layout.body.subtitles, rules: p.rules };
}

/** 保存一条译文（默认携带正确版本号），返回响应 */
async function saveTr(pid, sid, lang, text, cueVersion = 1, translationVersion) {
  const body = { subtitle_id: sid, text, cue_version: cueVersion };
  if (translationVersion !== undefined) body.translation_version = translationVersion;
  return api(`/api/projects/${pid}/translations/${lang}`, 'PUT', body);
}

// ---------- 保存与查询 ----------

test('译文：保存新建 → 201，并列查询给出原文/译文/状态', async () => {
  const { id, cues } = await createLaidProject();
  const r1 = await saveTr(id, cues[0].id, 'en', 'Hello world');
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.translation.status, 'ok');
  assert.equal(r1.body.translation.version, 1);
  assert.equal(r1.body.translation.cue_version, 1);
  assert.deepEqual(r1.body.translation.source, {
    text: '你好世界', start_ms: 0, end_ms: 1000, word_start: 0, word_end: 1,
  });

  const q = await api(`/api/projects/${id}/translations/en`);
  assert.equal(q.status, 200);
  assert.equal(q.body.items.length, 2);
  // 并列：原文 + 译文 + 状态
  assert.equal(q.body.items[0].subtitle.text, '你好世界');
  assert.equal(q.body.items[0].translation.text, 'Hello world');
  assert.equal(q.body.items[0].translation.status, 'ok');
  assert.equal(q.body.items[0].translation.valid, true);
  // 第二行缺译
  assert.equal(q.body.items[1].subtitle.text, '欢迎光临');
  assert.equal(q.body.items[1].translation, null);
  assert.deepEqual(q.body.summary, {
    lang: 'en', total_cues: 2, ok: 1, needs_review: 0, missing: 1, history: 0,
  });
});

test('译文：同一语言每条字幕最多一份译文，更新须携带读取时译文版本', async () => {
  const { id, cues } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');

  // 未携带译文版本 → 409 + 当前值
  const noVer = await saveTr(id, cues[0].id, 'en', 'Hi');
  assert.equal(noVer.status, 409);
  assert.equal(noVer.body.current.translation.text, 'Hello world');
  assert.equal(noVer.body.current.translation.version, 1);
  // 译文版本不符 → 409
  const stale = await saveTr(id, cues[0].id, 'en', 'Hi', 1, 99);
  assert.equal(stale.status, 409);
  // 正确版本 → 200，版本 +1
  const ok = await saveTr(id, cues[0].id, 'en', 'Hi there', 1, 1);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.translation.text, 'Hi there');
  assert.equal(ok.body.translation.version, 2);
  // 数据库里仍只有一份
  const q = await api(`/api/projects/${id}/translations/en`);
  assert.equal(q.body.items[0].translation.text, 'Hi there');
  assert.equal(q.body.summary.ok, 1);
});

test('译文：语言代号归一化为小写；空代号/非法代号/空文本/缺字段 → 400', async () => {
  const { id, cues } = await createLaidProject();
  const mixed = await saveTr(id, cues[0].id, 'EN', 'Hello world');
  assert.equal(mixed.status, 201);
  assert.equal(mixed.body.lang, 'en');
  const q = await api(`/api/projects/${id}/translations/en`);
  assert.equal(q.body.summary.ok, 1, '大写代号保存后应能在小写代号下查到');

  const emptyLang = await api(`/api/projects/${id}/translations/%20%20`, 'PUT', {
    subtitle_id: cues[0].id, text: 'x', cue_version: 1,
  });
  assert.equal(emptyLang.status, 400);
  const badLang = await api(`/api/projects/${id}/translations/中文!!`, 'PUT', {
    subtitle_id: cues[0].id, text: 'x', cue_version: 1,
  });
  assert.equal(badLang.status, 400);
  const emptyText = await saveTr(id, cues[0].id, 'fr', '   ');
  assert.equal(emptyText.status, 400);
  assert.ok(emptyText.body.errors.some((e) => e.includes('不能为空')));
  const noCueVer = await api(`/api/projects/${id}/translations/fr`, 'PUT', {
    subtitle_id: cues[0].id, text: 'Bonjour',
  });
  assert.equal(noCueVer.status, 400);
  assert.ok(noCueVer.body.errors.some((e) => e.includes('cue_version')));
});

test('译文：行版本过期 → 409 返回当前值；字幕不存在 → 404', async () => {
  const { id, cues } = await createLaidProject();
  const stale = await saveTr(id, cues[0].id, 'en', 'Hello', 999);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.subtitle.id, cues[0].id);
  const missing = await saveTr(id, 99999, 'en', 'Hello');
  assert.equal(missing.status, 404);
});

test('译文：须满足当前字数与字速规则，违反 → 422 且不改数据', async () => {
  const { id, cues } = await createLaidProject();
  // 默认规则 max_chars=30：31 字 → 422
  const tooLong = await saveTr(id, cues[0].id, 'en', 'x'.repeat(31));
  assert.equal(tooLong.status, 422);
  assert.ok(tooLong.body.errors.some((e) => e.includes('最大字数')));
  // 字速：源行 1000ms，max_cps=20 → 21 字 = 21 字/秒 → 422（字数本身未超限）
  const tooFast = await saveTr(id, cues[0].id, 'en', 'x'.repeat(21));
  assert.equal(tooFast.status, 422);
  assert.ok(tooFast.body.errors.some((e) => e.includes('字/秒')));
  // 均未保存
  const q = await api(`/api/projects/${id}/translations/en`);
  assert.equal(q.body.summary.missing, 2);
  assert.equal(q.body.summary.ok, 0);
});

// ---------- 状态派生：待复核 / 锁定与顺序不失效 / 历史 ----------

test('译文：源字幕文本或时间变化 → 待复核；仅锁定变化不失效', async () => {
  const { id, cues } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  await saveTr(id, cues[1].id, 'en', 'Welcome');

  // 仅锁定第一条：译文保持有效
  const lock = await api(`/api/projects/${id}/subtitles/${cues[0].id}`, 'PATCH', {
    version: 1, locked: true,
  });
  assert.equal(lock.status, 200);
  let q = await api(`/api/projects/${id}/translations/en`);
  assert.equal(q.body.items[0].translation.status, 'ok', '仅锁定变化不得使译文失效');

  // 解锁并改文本：译文转待复核
  const edit = await api(`/api/projects/${id}/subtitles/${cues[0].id}`, 'PATCH', {
    version: 2, locked: false, text: '你好呀，世界',
  });
  assert.equal(edit.status, 200);
  q = await api(`/api/projects/${id}/translations/en`);
  assert.equal(q.body.items[0].translation.status, 'needs_review');
  assert.equal(q.body.items[1].translation.status, 'ok', '未改的行不受影响');
  assert.equal(q.body.summary.needs_review, 1);

  // 改时间同样转待复核（第二行 [1500,2500] → 合法地延长结束）
  const timeEdit = await api(`/api/projects/${id}/subtitles/${cues[1].id}`, 'PATCH', {
    version: 1, end_ms: 2600,
  });
  assert.equal(timeEdit.status, 200);
  q = await api(`/api/projects/${id}/translations/en`);
  assert.equal(q.body.items[1].translation.status, 'needs_review', '源行时间变化 → 待复核');
});

test('译文：重排删除的原行译文留作历史，新行视为缺译，不按序号挪用', async () => {
  const { id, cues } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  await saveTr(id, cues[1].id, 'en', 'Welcome');
  // 锁定第二条（重排保留），第一条保持未锁定（重排删除换新 ID）
  const lock = await api(`/api/projects/${id}/subtitles/${cues[1].id}`, 'PATCH', {
    version: 1, locked: true,
  });
  // 改规则让第一区间拆成两条（词 0..1 → "你好" / "世界"），锁定行 idx 后移
  const rules = await api(`/api/projects/${id}/rules`, 'PUT', {
    version: 1, max_chars: 2, min_duration_ms: 500, max_cps: 20,
  });
  assert.equal(rules.status, 200);
  const relayout = await api(`/api/projects/${id}/layout`, 'POST', { sub_version: lock.body.sub_version });
  assert.equal(relayout.status, 200, JSON.stringify(relayout.body));
  assert.equal(relayout.body.subtitles.length, 3);
  const kept = relayout.body.subtitles.find((s) => s.id === cues[1].id);
  assert.ok(kept, '锁定行保留原 ID');
  assert.equal(kept.idx, 2, '锁定行展示顺序后移');

  const q = await api(`/api/projects/${id}/translations/en`);
  // 锁定行：文本/时间/词区间未变（仅 idx 变化）→ 译文仍有效
  const keptItem = q.body.items.find((it) => it.subtitle.id === cues[1].id);
  assert.equal(keptItem.translation.status, 'ok', '仅展示顺序变化不得使译文失效');
  // 两条新行：新 ID → 缺译，绝不按序号挪用旧译文
  const newItems = q.body.items.filter((it) => it.subtitle.id !== cues[1].id);
  assert.equal(newItems.length, 2);
  for (const it of newItems) assert.equal(it.translation, null);
  // 被删原行的译文留作历史
  assert.equal(q.body.history.length, 1);
  assert.equal(q.body.history[0].subtitle_id, cues[0].id);
  assert.equal(q.body.history[0].text, 'Hello world');
  assert.equal(q.body.history[0].status, 'source_deleted');
  assert.equal(q.body.summary.history, 1);
  assert.equal(q.body.summary.missing, 2);
});

// ---------- 确认待复核译文 ----------

test('译文：确认待复核译文 → 回到有效；过期版本 → 409 且不改数据', async () => {
  const { id, cues } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  // 改源文本 → 待复核
  const edit = await api(`/api/projects/${id}/subtitles/${cues[0].id}`, 'PATCH', {
    version: 1, text: '你好呀，世界',
  });
  const newCueVersion = edit.body.subtitle.version; // 2

  // 译文版本过期 → 409 + 当前值
  const staleTr = await api(`/api/projects/${id}/translations/en/confirm`, 'POST', {
    subtitle_id: cues[0].id, cue_version: newCueVersion, translation_version: 99,
  });
  assert.equal(staleTr.status, 409);
  assert.equal(staleTr.body.current.translation.status, 'needs_review');
  // 行版本过期 → 409
  const staleCue = await api(`/api/projects/${id}/translations/en/confirm`, 'POST', {
    subtitle_id: cues[0].id, cue_version: 1, translation_version: 1,
  });
  assert.equal(staleCue.status, 409);
  // 确认后状态与版本不变
  let q = await api(`/api/projects/${id}/translations/en`);
  assert.equal(q.body.items[0].translation.status, 'needs_review');
  assert.equal(q.body.items[0].translation.version, 1);

  // 正确版本确认 → 200，快照刷新为当前源行，译文版本 +1
  const ok = await api(`/api/projects/${id}/translations/en/confirm`, 'POST', {
    subtitle_id: cues[0].id, cue_version: newCueVersion, translation_version: 1,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.translation.status, 'ok');
  assert.equal(ok.body.translation.version, 2);
  assert.equal(ok.body.translation.source.text, '你好呀，世界');
  assert.equal(ok.body.translation.cue_version, newCueVersion);

  // 已有效时幂等：再确认不改数据（版本不再增加）
  const again = await api(`/api/projects/${id}/translations/en/confirm`, 'POST', {
    subtitle_id: cues[0].id, cue_version: newCueVersion, translation_version: 2,
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.unchanged, true);
  assert.equal(again.body.translation.version, 2);
});

test('译文：确认时译文违反当前规则 → 422 返回当前值与原因且不改数据', async () => {
  const { id, cues } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world'); // 11 字
  const edit = await api(`/api/projects/${id}/subtitles/${cues[0].id}`, 'PATCH', {
    version: 1, text: '你好呀，世界',
  });
  // 规则收紧：max_chars=5 → 现存译文 11 字超限
  const rules = await api(`/api/projects/${id}/rules`, 'PUT', {
    version: 1, max_chars: 5, min_duration_ms: 800, max_cps: 20,
  });
  assert.equal(rules.status, 200);
  const confirm = await api(`/api/projects/${id}/translations/en/confirm`, 'POST', {
    subtitle_id: cues[0].id, cue_version: edit.body.subtitle.version, translation_version: 1,
  });
  assert.equal(confirm.status, 422);
  assert.ok(confirm.body.errors.some((e) => e.includes('最大字数')));
  assert.equal(confirm.body.current.translation.status, 'needs_review', '确认失败不得改数据');
  // 保存修正后的译文（符合新规则）→ 直接回到有效
  const fixed = await saveTr(id, cues[0].id, 'en', 'Hi', edit.body.subtitle.version, 1);
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.translation.status, 'ok');
});

test('译文：源行已删除的历史译文不能确认 → 409', async () => {
  const { id, cues, sub_version } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  // 重排（未锁定行全部删除换新 ID）
  const relayout = await api(`/api/projects/${id}/layout`, 'POST', { sub_version });
  assert.equal(relayout.status, 200);
  const confirm = await api(`/api/projects/${id}/translations/en/confirm`, 'POST', {
    subtitle_id: cues[0].id, cue_version: 1, translation_version: 1,
  });
  assert.equal(confirm.status, 409);
  assert.match(confirm.body.error, /留作历史/);
  assert.equal(confirm.body.current.translation.status, 'source_deleted');
});

// ---------- 按语言导出 ----------

test('译文导出：缺译/待复核 → 422 列出缺漏，不生成快照', async () => {
  const { id, cues } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  // 第二行缺译
  const miss = await api(`/api/projects/${id}/translations/en/exports`, 'POST', {});
  assert.equal(miss.status, 422);
  assert.equal(miss.body.missing.length, 1);
  assert.equal(miss.body.missing[0].type, 'missing_translation');
  assert.equal(miss.body.missing[0].subtitle_id, cues[1].id);

  // 补齐后改源文本 → 待复核同样阻止导出
  await saveTr(id, cues[1].id, 'en', 'Welcome');
  await api(`/api/projects/${id}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '你好呀，世界' });
  const review = await api(`/api/projects/${id}/translations/en/exports`, 'POST', {});
  assert.equal(review.status, 422);
  assert.equal(review.body.missing.length, 1);
  assert.equal(review.body.missing[0].type, 'needs_review');

  const list = await api(`/api/projects/${id}/translations/en/exports`);
  assert.deepEqual(list.body, [], '校验失败不得生成任何导出版本');
});

test('译文导出：译文违反当前规则 → 422 列出冲突，不生成快照', async () => {
  const { id, cues } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world'); // 11 字
  await saveTr(id, cues[1].id, 'en', 'Welcome');
  // 规则收紧：max_chars=5 → 第一条译文超限
  await api(`/api/projects/${id}/rules`, 'PUT', {
    version: 1, max_chars: 5, min_duration_ms: 800, max_cps: 20,
  });
  const r = await api(`/api/projects/${id}/translations/en/exports`, 'POST', {});
  assert.equal(r.status, 422);
  assert.equal(r.body.missing.length, 0);
  assert.ok(r.body.conflicts.some((c) => c.type === 'max_chars' && c.subtitle_id === cues[0].id));
  const list = await api(`/api/projects/${id}/translations/en/exports`);
  assert.deepEqual(list.body, []);
});

test('译文导出：成功 → 版本按语言递增、内容沿用源时间轴、快照不可变', async () => {
  const { id, cues, sub_version } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  await saveTr(id, cues[1].id, 'en', 'Welcome');
  await saveTr(id, cues[0].id, 'fr', 'Bonjour');
  await saveTr(id, cues[1].id, 'fr', 'Bienvenue');

  const e1 = await api(`/api/projects/${id}/translations/en/exports`, 'POST', { sub_version });
  assert.equal(e1.status, 201, JSON.stringify(e1.body));
  assert.equal(e1.body.version, 1);
  assert.equal(e1.body.cue_count, 2);
  assert.match(e1.body.content, /^WEBVTT/);
  assert.ok(e1.body.content.includes('Hello world'));
  assert.ok(e1.body.content.includes('00:00:00.000 --> 00:00:01.000'), '沿用源行起止');
  assert.ok(e1.body.content.includes('00:00:01.500 --> 00:00:02.500'));

  // 另一语言独立编号
  const f1 = await api(`/api/projects/${id}/translations/fr/exports`, 'POST', {});
  assert.equal(f1.status, 201);
  assert.equal(f1.body.version, 1);
  assert.ok(f1.body.content.includes('Bonjour'));

  // 更新译文后再导出 → en v2；en v1 内容不变
  await saveTr(id, cues[0].id, 'en', 'Hello, world!', 1, 1);
  const e2 = await api(`/api/projects/${id}/translations/en/exports`, 'POST', {});
  assert.equal(e2.status, 201);
  assert.equal(e2.body.version, 2);
  assert.ok(e2.body.content.includes('Hello, world!'));

  const dl1 = await api(`/api/projects/${id}/translations/en/exports/1`);
  assert.equal(dl1.status, 200);
  assert.equal(dl1.body, e1.body.content, 'v1 快照不得被后续修改影响');
  assert.ok(!dl1.body.includes('Hello, world!'));
  assert.match(dl1.headers.get('content-type'), /text\/vtt/);
  const dl2 = await api(`/api/projects/${id}/translations/en/exports/2`);
  assert.equal(dl2.body, e2.body.content);
  const dlFr = await api(`/api/projects/${id}/translations/fr/exports/1`);
  assert.equal(dlFr.body, f1.body.content);

  // 列表与 404
  const list = await api(`/api/projects/${id}/translations/en/exports`);
  assert.equal(list.body.length, 2);
  assert.equal(list.body[0].version, 2, '新→旧排序');
  const missing = await api(`/api/projects/${id}/translations/en/exports/99`);
  assert.equal(missing.status, 404);
});

test('译文导出：sub_version 过期 → 409', async () => {
  const { id, cues } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  await saveTr(id, cues[1].id, 'en', 'Welcome');
  const r = await api(`/api/projects/${id}/translations/en/exports`, 'POST', { sub_version: 999 });
  assert.equal(r.status, 409);
});

// ---------- 汇总与共存 ----------

test('译文：语言汇总给出各语言有效/待复核/缺译/历史与导出数', async () => {
  const { id, cues } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  await saveTr(id, cues[1].id, 'en', 'Welcome');
  await saveTr(id, cues[0].id, 'fr', 'Bonjour');
  await api(`/api/projects/${id}/translations/en/exports`, 'POST', {});
  // 锁定第二行（重排保留）；改第一行源文本后重排：未锁定行删除换新 ID
  await api(`/api/projects/${id}/subtitles/${cues[1].id}`, 'PATCH', { version: 1, locked: true });
  await api(`/api/projects/${id}/subtitles/${cues[0].id}`, 'PATCH', { version: 1, text: '你好呀，世界' });
  const p = await api(`/api/projects/${id}`);
  const relayout = await api(`/api/projects/${id}/layout`, 'POST', { sub_version: p.body.sub_version });
  assert.equal(relayout.status, 200, JSON.stringify(relayout.body));

  const langs = await api(`/api/projects/${id}/translations`);
  assert.equal(langs.status, 200);
  const en = langs.body.find((b) => b.lang === 'en');
  const fr = langs.body.find((b) => b.lang === 'fr');
  assert.equal(en.ok, 1, '锁定行的译文仍有效');
  assert.equal(en.history, 1, '被删行的译文留作历史');
  assert.equal(en.missing, 1, '新行缺译');
  assert.equal(en.exports, 1);
  assert.equal(en.latest_export_version, 1);
  assert.equal(fr.history, 1, '源行被重排删除 → 历史');
  assert.equal(fr.missing, 2, '新行全部缺译');
  assert.equal(fr.exports, 0);
  assert.equal(fr.latest_export_version, null);
});

test('译文：原文导出与修订流程不受译文影响，仍可使用', async () => {
  const { id, cues, sub_version } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  // 原文导出照常（sub_version 不因译文保存而变化）
  const e1 = await api(`/api/projects/${id}/exports`, 'POST', { sub_version });
  assert.equal(e1.status, 201, JSON.stringify(e1.body));
  assert.ok(e1.body.content.includes('你好世界'));
  assert.ok(!e1.body.content.includes('Hello world'), '原文导出不含译文');
  // 修订提议流程照常
  const rev = await api(`/api/projects/${id}/revisions`, 'POST', {
    items: [{ subtitle_id: cues[0].id, cue_version: 1, text: '你好呀，世界' }],
  });
  assert.equal(rev.status, 201, JSON.stringify(rev.body));
  const acc = await api(`/api/projects/${id}/revisions/${rev.body.id}/accept`, 'POST', {});
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  // 修订采纳改了源文本 → 译文转待复核
  const q = await api(`/api/projects/${id}/translations/en`);
  assert.equal(q.body.items[0].translation.status, 'needs_review');
});

test('译文：逐词修正确认后，被替换行的译文留作历史，保留行译文仍有效', async () => {
  const { id, cues, sub_version } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  await saveTr(id, cues[1].id, 'en', 'Welcome');
  // 修正词 0 '你好' [0,500] → [0,400]：第一条（含修正词）被替换，第二条保留
  const wr = await api(`/api/projects/${id}/word-revisions`, 'POST', {
    sub_version, items: [{ word_idx: 0, start_ms: 0, end_ms: 400 }],
  });
  assert.equal(wr.status, 201, JSON.stringify(wr.body));
  const confirm = await api(`/api/projects/${id}/word-revisions/${wr.body.id}/confirm`, 'POST', {});
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

  const q = await api(`/api/projects/${id}/translations/en`);
  assert.ok(
    q.body.history.some((h) => h.subtitle_id === cues[0].id && h.text === 'Hello world'),
    '被替换行的译文留作历史'
  );
  const keptItem = q.body.items.find((it) => it.subtitle.id === cues[1].id);
  assert.equal(keptItem.translation.status, 'ok', '保留行（仅 idx 变化）译文仍有效');
  const newItem = q.body.items.find((it) => it.subtitle.id !== cues[1].id);
  assert.equal(newItem.translation, null, '重排新行视为缺译');
});

test('译文：重新导入清空字幕后，译文全部留作历史', async () => {
  const { id, cues } = await createLaidProject();
  await saveTr(id, cues[0].id, 'en', 'Hello world');
  const imp = await api(`/api/projects/${id}/import`, 'POST', {
    words: GOOD_WORDS, cuts: [], force: true,
  });
  assert.equal(imp.status, 200);
  const q = await api(`/api/projects/${id}/translations/en`);
  assert.equal(q.body.items.length, 0, '导入后没有当前字幕');
  assert.equal(q.body.history.length, 1);
  assert.equal(q.body.history[0].status, 'source_deleted');
});

test('译文：新建时携带译文版本 → 409；确认不存在的译文 → 404；确认缺译文版本 → 400', async () => {
  const { id, cues } = await createLaidProject();
  const badCreate = await saveTr(id, cues[0].id, 'en', 'Hello', 1, 3);
  assert.equal(badCreate.status, 409);
  assert.match(badCreate.body.error, /不适用/);
  const notFound = await api(`/api/projects/${id}/translations/en/confirm`, 'POST', {
    subtitle_id: cues[0].id, cue_version: 1, translation_version: 1,
  });
  assert.equal(notFound.status, 404);
  const noVer = await api(`/api/projects/${id}/translations/en/confirm`, 'POST', {
    subtitle_id: cues[0].id, cue_version: 1,
  });
  assert.equal(noVer.status, 400);
  assert.ok(noVer.body.errors.some((e) => e.includes('translation_version')));
});
