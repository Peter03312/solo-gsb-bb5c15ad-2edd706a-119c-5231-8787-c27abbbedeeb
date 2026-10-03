'use strict';

const { validateStructure } = require('./layout');

/**
 * 多语言译文字幕：请求解析、状态派生与整版核对（纯函数，不依赖数据库）。
 *
 * 译文绑定“源字幕行 ID + 目标语言代号”，不自带时间轴：
 *   - 起止毫秒与词区间始终沿用当前源字幕行，译文只保存文本；
 *   - 保存/确认时记录源行快照（文本/起止/词区间/行版本）；
 *   - 查询时把快照与当前源行比对派生状态：
 *       ok             源行文本、起止、词区间均未变（仅锁定或展示顺序变化不影响）
 *       needs_review   源行文本/起止/词区间已变化 → 待复核
 *       source_deleted 源行已被重排/重新导入删除 → 译文留作历史，不归属任何当前行
 *   - 重排产生的新行（新 ID）视为缺译，绝不按序号挪用旧译文；
 *   - 译文文本须满足当前规则的最大字数与每秒字数（时间轴同源，时长规则天然一致）。
 */

const LANG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * 解析并归一化目标语言代号：去首尾空白、转小写；
 * 须以字母或数字开头，只含小写字母/数字/连字符，最长 32 字符（如 en、zh-hans、pt-br）。
 */
function parseLang(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: '目标语言代号必须是非空字符串' };
  }
  const lang = raw.trim().toLowerCase();
  if (lang === '') {
    return { ok: false, error: '目标语言代号不能为空' };
  }
  if (!LANG_RE.test(lang)) {
    return {
      ok: false,
      error:
        `目标语言代号 "${raw}" 非法：须以字母或数字开头，只含小写字母、数字与连字符（最长 32 字符）`,
    };
  }
  return { ok: true, lang };
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 解析保存/确认请求体的“形状”（与项目当前状态无关的部分）：
 * 字幕 ID、读取时行版本、读取时译文版本、（保存时）非空译文文本。
 * requireText=false 用于确认（文本沿用已存译文，body 不携带 text）。
 */
function parseTranslationBody(body, { requireText }) {
  const errors = [];
  const b = body || {};
  if (!isInt(b.subtitle_id) || b.subtitle_id <= 0) {
    errors.push('subtitle_id（字幕 ID）必须是正整数');
  }
  if (!isInt(b.cue_version) || b.cue_version < 1) {
    errors.push('cue_version（读取时行版本）必须是 ≥1 的整数');
  }
  let translationVersion = null;
  if (b.translation_version !== undefined && b.translation_version !== null) {
    if (!isInt(b.translation_version) || b.translation_version < 1) {
      errors.push('translation_version（读取时译文版本）必须是 ≥1 的整数');
    } else {
      translationVersion = b.translation_version;
    }
  }
  let text = null;
  if (requireText) {
    if (typeof b.text !== 'string' || b.text.trim() === '') {
      errors.push('译文文本 text 不能为空');
    } else {
      text = b.text.trim();
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    subtitle_id: b.subtitle_id,
    cue_version: b.cue_version,
    translation_version: translationVersion,
    text,
  };
}

/**
 * 译文文本对当前规则的核对：只查最大字数与每秒字数。
 * 译文沿用源行起止，显示时长与源行一致，故最短时长无需重复核对。
 * 返回 [{ type, message }]，空数组表示通过。
 */
function checkTranslationText(text, cue, rules) {
  const problems = [];
  const len = text.length;
  if (len > rules.max_chars) {
    problems.push({
      type: 'max_chars',
      message: `译文 ${len} 字，超过单条最大字数 ${rules.max_chars}（当前规则）`,
    });
  }
  const dur = cue.end_ms - cue.start_ms;
  const cps = len / (dur / 1000);
  if (cps > rules.max_cps + 1e-9) {
    problems.push({
      type: 'max_cps',
      message:
        `译文按源行时段 ${dur}ms 计 ${cps.toFixed(1)} 字/秒，` +
        `超过每秒最多 ${rules.max_cps} 字（当前规则）`,
    });
  }
  return problems;
}

/**
 * 由源行快照派生译文状态。cue 为当前源字幕行（源行已删除则传 null）。
 * 只比较文本/起止/词区间：锁定标志与展示顺序（idx）的变化不使译文失效。
 */
function deriveStatus(tr, cue) {
  if (!cue) return 'source_deleted';
  if (
    tr.src_text !== cue.text ||
    tr.src_start_ms !== cue.start_ms ||
    tr.src_end_ms !== cue.end_ms ||
    tr.src_word_start !== cue.word_start ||
    tr.src_word_end !== cue.word_end
  ) {
    return 'needs_review';
  }
  return 'ok';
}

/**
 * 译文的对外 JSON 形态。cue 为当前源行（可为 null），rules 存在时
 * 附带按当前规则核对的 valid/problems，便于查询时直接看到“是否可导出”。
 */
function translationJson(tr, cue, rules) {
  const out = {
    id: tr.id,
    lang: tr.lang,
    subtitle_id: tr.subtitle_id,
    text: tr.text,
    version: tr.version,
    status: deriveStatus(tr, cue),
    cue_version: tr.cue_version, // 保存/确认时读取的源行版本
    source: {                    // 保存/确认时的源行快照（据此派生状态）
      text: tr.src_text,
      start_ms: tr.src_start_ms,
      end_ms: tr.src_end_ms,
      word_start: tr.src_word_start,
      word_end: tr.src_word_end,
    },
    created_at: tr.created_at,
    updated_at: tr.updated_at,
  };
  if (cue && rules) {
    const problems = checkTranslationText(tr.text, cue, rules);
    out.valid = problems.length === 0;
    out.problems = problems;
  }
  return out;
}

/**
 * 并列查询组装：当前每条字幕一行，并列原文与译文（含派生状态）；
 * 源行已删除的译文列入 history（留作历史，不归属任何当前行）。
 */
function assembleTranslations(project, rows, lang) {
  const cueById = new Map(project.subtitles.map((s) => [s.id, s]));
  const trByCue = new Map();
  const history = [];
  for (const tr of rows) {
    const cue = cueById.get(tr.subtitle_id) || null;
    if (cue) trByCue.set(tr.subtitle_id, tr);
    else history.push(translationJson(tr, null, null));
  }
  const items = project.subtitles.map((cue) => ({
    subtitle: cue,
    translation: trByCue.has(cue.id)
      ? translationJson(trByCue.get(cue.id), cue, project.rules)
      : null,
  }));
  const summary = {
    lang,
    total_cues: items.length,
    ok: 0,
    needs_review: 0,
    missing: 0,
    history: history.length,
  };
  for (const it of items) {
    if (!it.translation) summary.missing += 1;
    else if (it.translation.status === 'ok') summary.ok += 1;
    else summary.needs_review += 1;
  }
  return {
    lang,
    sub_version: project.sub_version,
    rules_version: project.rules ? project.rules.version : null,
    items,
    history,
    summary,
  };
}

/** 项目级语言汇总：每种语言的有效/待复核/缺译/历史数量 */
function summarizeLangs(project, rows) {
  const cueById = new Map(project.subtitles.map((s) => [s.id, s]));
  const byLang = new Map();
  for (const tr of rows) {
    let bucket = byLang.get(tr.lang);
    if (!bucket) {
      bucket = { lang: tr.lang, ok: 0, needs_review: 0, missing: 0, history: 0 };
      byLang.set(tr.lang, bucket);
    }
    const cue = cueById.get(tr.subtitle_id) || null;
    if (!cue) bucket.history += 1;
    else if (deriveStatus(tr, cue) === 'ok') bucket.ok += 1;
    else bucket.needs_review += 1;
  }
  const out = [...byLang.values()];
  for (const b of out) {
    b.missing = project.subtitles.length - b.ok - b.needs_review;
  }
  out.sort((a, b) => (a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0));
  return out;
}

/**
 * 按语言导出前的整版核对（基于 assembleTranslations 的结果）：
 *   - 当前每行都须有 status=ok 的译文：缺译 / 待复核 → missing；
 *   - 每份译文须满足当前字数与字速规则 → conflicts；
 *   - 整版（沿用源行时间轴）须通过结构校验：词覆盖、不重叠、不跨切点 → conflicts。
 * 返回 { ok, missing, conflicts, cues }；cues 为可导出的译文字幕（按展示顺序）。
 */
function evaluateTranslationExport({ project, assembled }) {
  const missing = [];
  const conflicts = [];
  const cues = [];
  for (const it of assembled.items) {
    const cue = it.subtitle;
    const tr = it.translation;
    const ref = `第 ${cue.idx + 1} 行（字幕 ${cue.id}）`;
    if (!tr) {
      missing.push({
        type: 'missing_translation',
        subtitle_id: cue.id,
        idx: cue.idx,
        message: `${ref}缺少 ${assembled.lang} 译文`,
      });
      continue;
    }
    if (tr.status === 'needs_review') {
      missing.push({
        type: 'needs_review',
        subtitle_id: cue.id,
        idx: cue.idx,
        message:
          `${ref}译文待复核：源字幕的文本/时间/词区间已变化，` +
          '请在当前源行上确认或重新保存译文',
      });
      continue;
    }
    for (const prob of checkTranslationText(tr.text, cue, project.rules)) {
      conflicts.push({ ...prob, subtitle_id: cue.id, idx: cue.idx, message: `${ref}${prob.message}` });
    }
    cues.push({
      word_start: cue.word_start,
      word_end: cue.word_end,
      text: tr.text,
      start_ms: cue.start_ms,
      end_ms: cue.end_ms,
    });
  }
  // 整版时间与切点约束：译文沿用源行时间轴，对当前源字幕整版做结构校验
  const idByRange = new Map(project.subtitles.map((s) => [`${s.word_start}:${s.word_end}`, s.id]));
  for (const prob of validateStructure(project.subtitles, project.words, project.cuts)) {
    conflicts.push({
      ...prob,
      subtitle_id: idByRange.get(`${prob.word_start}:${prob.word_end}`) ?? null,
    });
  }
  return { ok: missing.length === 0 && conflicts.length === 0, missing, conflicts, cues };
}

module.exports = {
  parseLang,
  parseTranslationBody,
  checkTranslationText,
  deriveStatus,
  translationJson,
  assembleTranslations,
  summarizeLangs,
  evaluateTranslationExport,
  LANG_RE,
};
