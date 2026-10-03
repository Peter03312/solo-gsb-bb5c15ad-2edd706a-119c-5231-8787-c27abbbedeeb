'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  sub_version INTEGER NOT NULL DEFAULT 0,   -- 字幕集每次变更（编辑/锁定/重排）都 +1，用于乐观锁
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS words (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS shots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  cut_ms     INTEGER NOT NULL,
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS rules (
  project_id      INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL DEFAULT 1,  -- 每次修改 +1，提交时携带以拒绝过期写入
  max_chars       INTEGER NOT NULL,
  min_duration_ms INTEGER NOT NULL,
  max_cps         REAL NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtitles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,               -- 展示顺序（按时间升序）
  word_start INTEGER NOT NULL,               -- 覆盖的词区间 [word_start, word_end]
  word_end   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  locked     INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 1,     -- 行级乐观锁
  UNIQUE(project_id, idx)
);

CREATE TABLE IF NOT EXISTS exports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,               -- 项目内递增，确认一次 +1
  content    TEXT NOT NULL,                  -- WebVTT 快照，确认后不再改变
  cue_count  INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, version)
);

-- 校对者批量修订提议：一组针对未锁定字幕的待采纳修订
CREATE TABLE IF NOT EXISTS revisions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id             INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  note                   TEXT NOT NULL DEFAULT '',   -- 校对说明
  rules_version_snapshot INTEGER NOT NULL,           -- 提议保存时的规则版本
  sub_version_snapshot   INTEGER NOT NULL,           -- 提议保存时的字幕集版本
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending（待采纳）/ accepted（已采纳）
  accepted_at            TEXT,
  accepted_sub_version   INTEGER,                    -- 采纳后字幕集推进到的版本
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revision_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id   INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,               -- 组内顺序
  subtitle_id   INTEGER NOT NULL,               -- 目标字幕 ID（提交时存在且未锁定）
  cue_version   INTEGER NOT NULL,               -- 校对者读取该行时的版本号
  orig_text     TEXT NOT NULL,                  -- 原值快照
  orig_start_ms INTEGER NOT NULL,
  orig_end_ms   INTEGER NOT NULL,
  proposed_text TEXT NOT NULL,                  -- 替代文本
  start_ms      INTEGER,                        -- 可选：替代开始毫秒，NULL 表示沿用原值
  end_ms        INTEGER,                        -- 可选：替代结束毫秒，NULL 表示沿用原值
  UNIQUE(revision_id, ord)
);

-- 校对者逐词时间修正提议：按词序号提交一组起止毫秒，确认后才更新 words 并重排受影响区间
CREATE TABLE IF NOT EXISTS word_revisions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id             INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  note                   TEXT NOT NULL DEFAULT '',    -- 校对说明
  sub_version_snapshot   INTEGER NOT NULL,            -- 校对者读取字幕集时的 sub_version
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending（待确认）/ confirmed（已确认）
  confirmed_at           TEXT,
  confirmed_sub_version  INTEGER,                     -- 确认后字幕集推进到的版本
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS word_revision_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  word_revision_id INTEGER NOT NULL REFERENCES word_revisions(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,           -- 组内顺序
  word_idx        INTEGER NOT NULL,           -- 词序号（words.idx，词序与词文本不可变）
  orig_start_ms   INTEGER NOT NULL,           -- 读取时原开始毫秒快照
  orig_end_ms     INTEGER NOT NULL,           -- 读取时原结束毫秒快照
  start_ms        INTEGER NOT NULL,           -- 修正后开始毫秒
  end_ms          INTEGER NOT NULL,           -- 修正后结束毫秒
  UNIQUE(word_revision_id, ord)
);

-- 多语言译文：绑定“源字幕行 ID + 目标语言代号”，时间轴沿用源行，只存文本与源行快照
CREATE TABLE IF NOT EXISTS translations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subtitle_id    INTEGER NOT NULL,               -- 源字幕 ID；源行被删除后译文留作历史（故意不设外键）
  lang           TEXT NOT NULL,                  -- 目标语言代号（保存时归一化为小写）
  text           TEXT NOT NULL,                  -- 译文文本
  version        INTEGER NOT NULL DEFAULT 1,     -- 译文行级乐观锁：每次保存/确认 +1
  cue_version    INTEGER NOT NULL,               -- 保存/确认时读取的源字幕行版本
  src_text       TEXT NOT NULL,                  -- 源行快照：文本/起止/词区间（据此派生“待复核”）
  src_start_ms   INTEGER NOT NULL,
  src_end_ms     INTEGER NOT NULL,
  src_word_start INTEGER NOT NULL,
  src_word_end   INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, subtitle_id, lang)          -- 同一语言每条字幕最多一份译文
);

-- 译文 WebVTT 导出版本：按语言各自递增，生成后不可变
CREATE TABLE IF NOT EXISTS translation_exports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lang       TEXT NOT NULL,
  version    INTEGER NOT NULL,               -- 语言内递增，确认一次 +1
  content    TEXT NOT NULL,                  -- 译文 WebVTT 快照，生成后不再改变
  cue_count  INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, lang, version)
);
`;

const DEFAULT_RULES = { max_chars: 30, min_duration_ms: 800, max_cps: 20 };

function initDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return db;
}

/** 项目完整载荷：项目 + 词 + 切点 + 规则 + 字幕 + 导出版本列表 */
function loadProject(db, id) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return null;
  const words = db.prepare(
    'SELECT idx, text, start_ms, end_ms FROM words WHERE project_id = ? ORDER BY idx'
  ).all(id);
  const cuts = db.prepare(
    'SELECT cut_ms FROM shots WHERE project_id = ? ORDER BY idx'
  ).all(id).map((r) => r.cut_ms);
  const rules = db.prepare('SELECT * FROM rules WHERE project_id = ?').get(id);
  const subtitles = db.prepare(
    `SELECT id, idx, word_start, word_end, text, start_ms, end_ms, locked, version
     FROM subtitles WHERE project_id = ? ORDER BY idx`
  ).all(id);
  const exportsList = db.prepare(
    'SELECT version, cue_count, created_at FROM exports WHERE project_id = ? ORDER BY version DESC'
  ).all(id);
  const revisions = listRevisions(db, id);
  const wordRevisions = listWordRevisions(db, id);
  return {
    id: project.id,
    name: project.name,
    sub_version: project.sub_version,
    created_at: project.created_at,
    words,
    cuts,
    rules: rules
      ? { version: rules.version, max_chars: rules.max_chars,
          min_duration_ms: rules.min_duration_ms, max_cps: rules.max_cps }
      : null,
    subtitles,
    exports: exportsList,
    revisions,
    word_revisions: wordRevisions,
  };
}

/** 项目下全部修订提议摘要（不含逐项明细），按时间倒序 */
function listRevisions(db, projectId) {
  return db.prepare(
    `SELECT r.id, r.note, r.status, r.rules_version_snapshot, r.sub_version_snapshot,
            r.accepted_sub_version, r.created_at, r.accepted_at,
            (SELECT COUNT(*) FROM revision_items i WHERE i.revision_id = r.id) AS item_count
     FROM revisions r WHERE r.project_id = ? ORDER BY r.id DESC`
  ).all(projectId);
}

/**
 * 读取一个修订提议（含逐项明细）。不存在或不属于该项目返回 null。
 * 每项同时给出 orig_*（提交时原值）、proposed_*（建议值，start_ms/end_ms 为 null 表示沿用原值）。
 */
function loadRevision(db, projectId, revisionId) {
  const head = db.prepare('SELECT * FROM revisions WHERE id = ? AND project_id = ?')
    .get(revisionId, projectId);
  if (!head) return null;
  const items = db.prepare(
    'SELECT * FROM revision_items WHERE revision_id = ? ORDER BY ord'
  ).all(revisionId);
  return {
    id: head.id,
    project_id: head.project_id,
    note: head.note,
    status: head.status,
    rules_version_snapshot: head.rules_version_snapshot,
    sub_version_snapshot: head.sub_version_snapshot,
    accepted_sub_version: head.accepted_sub_version,
    created_at: head.created_at,
    accepted_at: head.accepted_at,
    items: items.map((it) => ({
      ord: it.ord,
      subtitle_id: it.subtitle_id,
      cue_version: it.cue_version,
      orig: { text: it.orig_text, start_ms: it.orig_start_ms, end_ms: it.orig_end_ms },
      proposed: {
        text: it.proposed_text,
        start_ms: it.start_ms,
        end_ms: it.end_ms,
        has_start_ms: it.start_ms !== null,
        has_end_ms: it.end_ms !== null,
      },
    })),
  };
}

function bumpSubVersion(db, projectId) {
  db.prepare('UPDATE projects SET sub_version = sub_version + 1 WHERE id = ?').run(projectId);
  return db.prepare('SELECT sub_version FROM projects WHERE id = ?').get(projectId).sub_version;
}

/** 项目下全部逐词修正提议摘要（不含逐项明细），按时间倒序 */
function listWordRevisions(db, projectId) {
  return db.prepare(
    `SELECT r.id, r.note, r.status, r.sub_version_snapshot,
            r.confirmed_sub_version, r.created_at, r.confirmed_at,
            (SELECT COUNT(*) FROM word_revision_items i WHERE i.word_revision_id = r.id) AS item_count
     FROM word_revisions r WHERE r.project_id = ? ORDER BY r.id DESC`
  ).all(projectId);
}

/**
 * 读取一个逐词修正提议（含逐项明细，并附带各词当前文本/时间，便于预览并列原值/当前值）。
 * 不存在或不属于该项目返回 null。
 */
function loadWordRevision(db, projectId, revisionId) {
  const head = db.prepare('SELECT * FROM word_revisions WHERE id = ? AND project_id = ?')
    .get(revisionId, projectId);
  if (!head) return null;
  const items = db.prepare(
    `SELECT i.ord, i.word_idx, i.orig_start_ms, i.orig_end_ms, i.start_ms, i.end_ms,
            w.text AS word_text, w.start_ms AS cur_start_ms, w.end_ms AS cur_end_ms
       FROM word_revision_items i
       LEFT JOIN words w ON w.project_id = ? AND w.idx = i.word_idx
      WHERE i.word_revision_id = ? ORDER BY i.ord`
  ).all(projectId, revisionId);
  return {
    id: head.id,
    project_id: head.project_id,
    note: head.note,
    status: head.status,
    sub_version_snapshot: head.sub_version_snapshot,
    confirmed_sub_version: head.confirmed_sub_version,
    created_at: head.created_at,
    confirmed_at: head.confirmed_at,
    items: items.map((it) => ({
      ord: it.ord,
      word_idx: it.word_idx,
      word_text: it.word_text ?? null,        // 重新导入后可能已不存在
      orig: { start_ms: it.orig_start_ms, end_ms: it.orig_end_ms },
      proposed: { start_ms: it.start_ms, end_ms: it.end_ms },
      current: it.word_text === null
        ? null
        : { text: it.word_text, start_ms: it.cur_start_ms, end_ms: it.cur_end_ms },
    })),
  };
}

/** 单条译文行（按 项目 + 字幕 ID + 语言 定位）；不存在返回 null */
function getTranslation(db, projectId, subtitleId, lang) {
  return db.prepare(
    'SELECT * FROM translations WHERE project_id = ? AND subtitle_id = ? AND lang = ?'
  ).get(projectId, subtitleId, lang) || null;
}

/** 项目某语言的全部译文行（含源行已删除的历史译文），按 ID 升序 */
function listTranslations(db, projectId, lang) {
  return db.prepare(
    'SELECT * FROM translations WHERE project_id = ? AND lang = ? ORDER BY id'
  ).all(projectId, lang);
}

/** 项目全部译文行（不限语言，供语言汇总），按 ID 升序 */
function listAllTranslations(db, projectId) {
  return db.prepare(
    'SELECT * FROM translations WHERE project_id = ? ORDER BY id'
  ).all(projectId);
}

/** 项目某语言的译文导出版本列表（新→旧） */
function listTranslationExports(db, projectId, lang) {
  return db.prepare(
    `SELECT lang, version, cue_count, created_at FROM translation_exports
      WHERE project_id = ? AND lang = ? ORDER BY version DESC`
  ).all(projectId, lang);
}

/** 项目全部译文导出版本列表（新→旧），供项目载荷与汇总 */
function listAllTranslationExports(db, projectId) {
  return db.prepare(
    `SELECT lang, version, cue_count, created_at FROM translation_exports
      WHERE project_id = ? ORDER BY lang, version DESC`
  ).all(projectId);
}

module.exports = {
  initDb, loadProject, listRevisions, loadRevision,
  listWordRevisions, loadWordRevision, bumpSubVersion, DEFAULT_RULES,
  getTranslation, listTranslations, listAllTranslations,
  listTranslationExports, listAllTranslationExports,
};
