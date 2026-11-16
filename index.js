// @ts-nocheck
/// <reference types="jquery" />
/// <reference types="toastr" />

/**
 * Chronicle — SillyTavern Extension (v3)
 * ------------------------------------------------------------------
 * A timeline of "points in time", each holding story / character /
 * relationship / environment entries. Only entries up to the chat's
 * current point in time are injected into the prompt.
 *
 * v3 additions
 *  - AI generation: build a chronicle from free-form text or from a work title,
 *    through the current connection, a Connection Profile, or a direct source.
 *  - Plain-text import / export.
 *  - Display-only translation (SillyTavern's built-in translator, no LLM).
 *  - Secret entries, "replaces earlier" entries.
 *  - Keyword languages for AI generation (English / Japanese / Korean / Chinese).
 *  - Rank-based recency, safer short keywords, pinned-budget warning.
 *  - Mobile popup layout fix.
 */

import {
    chat,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { download, getFileText } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { secret_state, SECRET_KEYS } from '../../../secrets.js';

// ==================================================================
// Constants
// ==================================================================

const MODULE_NAME = 'chronicle';
const INJECT_KEY = 'chronicle_timeline';
const EXT_URL = new URL('.', import.meta.url).pathname;
const META_KEY = 'chronicle';
const STORE_VERSION = 4;

/** Entry types. named=true adds a name field (person / pair). */
const BLOCK_TYPES = {
    story: { ko: '스토리', en: 'Story', named: false, order: 1, icon: 'fa-book-open' },
    character: { ko: '인물', en: 'Character', named: true, order: 2, icon: 'fa-user' },
    relation: { ko: '관계', en: 'Relationship', named: true, order: 3, icon: 'fa-link' },
    environment: { ko: '환경', en: 'Environment', named: false, order: 4, icon: 'fa-globe' },
};

const TYPE_ORDER = Object.entries(BLOCK_TYPES)
    .sort((a, b) => a[1].order - b[1].order).map(([k]) => k);

const DEFAULT_HEADER =
    'The following is the established chronicle of this world, up to the current point in time ({{now}}), listed in chronological order.\n' +
    'Treat every entry as canon. Nothing after {{now}} has happened yet — never mention, reference, or foreshadow it.';

/** Appended automatically when at least one secret entry is injected. */
const SECRET_NOTE =
    'Entries marked SECRET are true, but hidden. Only the characters listed after "known only to" know them. ' +
    'Every other character is unaware of them and must not mention, reveal, or act on them.';

/** Appended automatically when superseded entries are kept as history. */
const PAST_NOTE =
    'Entries marked PAST describe an earlier state of that character or relationship. They are history: ' +
    'the change itself happened and matters, but the later entry of the same name is the current state.';

const DEFAULT_AI_SYSTEM =
    'You compile a chronicle: a chronological record of a world (fictional or real) that will be used as background reference for roleplay. ' +
    'Record what happens in the world and the state of its people, relationships and setting at each point in time. ' +
    'Stay neutral and factual. Do not add opinions, judgments or stylistic flourishes. ' +
    'Do not invent events that the source does not support; if something is uncertain, leave it out.';

/** Sources offered in "direct" mode. secret = SillyTavern secret key holding its API key. */
const AI_SOURCES = {
    openai: { label: 'OpenAI', secret: () => SECRET_KEYS?.OPENAI ?? 'api_key_openai' },
    claude: { label: 'Claude', secret: () => SECRET_KEYS?.CLAUDE ?? 'api_key_claude' },
    makersuite: { label: 'Gemini (Google AI Studio)', secret: () => SECRET_KEYS?.MAKERSUITE ?? 'api_key_makersuite' },
    vertexai: {
        label: 'Gemini Vertex AI',
        secret: (ai) => ai.vertexAuth === 'full'
            ? (SECRET_KEYS?.VERTEXAI_SERVICE_ACCOUNT ?? 'vertexai_service_account_json')
            : (SECRET_KEYS?.VERTEXAI ?? 'api_key_vertexai'),
    },
    deepseek: { label: 'DeepSeek', secret: () => SECRET_KEYS?.DEEPSEEK ?? 'api_key_deepseek' },
    zai: { label: 'GLM (Z.AI)', secret: () => SECRET_KEYS?.ZAI ?? 'api_key_zai' },
    custom: { label: '기타 (OpenAI 호환)', secret: () => SECRET_KEYS?.CUSTOM ?? 'api_key_custom' },
};

const DEFAULT_AI = {
    mode: 'current',          // current | profile | direct
    profileId: '',
    source: 'openai',
    model: '',
    secretId: '',             // '' = the active key of that source
    customUrl: '',
    vertexAuth: 'express',    // express | full
    vertexRegion: 'us-central1',
    zaiEndpoint: 'common',    // common | coding
    maxTokens: 8000,
    chunkChars: 12000,
    keyLangs: ['ko', 'en'],   // languages the AI writes keywords in
    systemPrompt: DEFAULT_AI_SYSTEM,
};

const KEY_LANGS = { en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese' };

const DEFAULT_SETTINGS = {
    version: STORE_VERSION,
    enabled: true,
    worlds: [],
    activeWorldId: null,

    tokenBudget: 1500,
    recencyWeight: 60,
    constantBonus: 40,
    keywordBonus: 30,
    scanDepth: 4,

    position: 'before',
    depth: 4,
    role: 0,
    replacedMode: 'past',     // past = keep earlier entries marked PAST | drop = leave them out
    castMode: 'boost',        // off | boost (raise present characters) | filter (only present characters)
    castBonus: 40,
    compressOld: false,       // older points → first sentence only
    compressKeep: 12,         // how many most recent points stay in full

    header: DEFAULT_HEADER,
    debug: false,

    ai: DEFAULT_AI,
};

const ADVANCED_KEYS = [
    'tokenBudget', 'recencyWeight', 'constantBonus', 'keywordBonus', 'scanDepth',
    'position', 'depth', 'role', 'header', 'replacedMode', 'castMode', 'castBonus', 'compressOld', 'compressKeep',
];

// ==================================================================
// Utils
// ==================================================================

function log(...a) { if (extension_settings[MODULE_NAME]?.debug) console.log('[크로니클]', ...a); }
function warn(...a) { console.warn('[크로니클]', ...a); }

function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(type, msg) {
    try { toastr[type](msg, '크로니클'); } catch { /* noop */ }
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function errMsg(e) {
    let cur = e, msg = '';
    while (cur) { msg = String(cur.message || cur); cur = cur.cause; }
    return msg || String(e);
}

// ==================================================================
// Settings / storage
// ==================================================================

/** Runs once at startup: fills defaults, migrates and normalizes stored data. */
function initSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extension_settings[MODULE_NAME];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = structuredClone(v);
    }
    if (!s.ai || typeof s.ai !== 'object') s.ai = structuredClone(DEFAULT_AI);
    for (const [k, v] of Object.entries(DEFAULT_AI)) {
        if (s.ai[k] === undefined) s.ai[k] = structuredClone(v);
    }
    if (!Array.isArray(s.ai.keyLangs)) s.ai.keyLangs = [...DEFAULT_AI.keyLangs];
    delete s.labelMode; // removed in v3.1

    if (!Array.isArray(s.worlds)) s.worlds = [];
    // Normalize every world once, so the hot paths (prompt build, rendering) never have to.
    s.worlds = s.worlds.filter(Boolean).map(w => {
        migrateWorld(w);
        w.id = w.id || uid();
        w.name = String(w.name ?? '새 세계관');
        w.nodes = (w.nodes || []).map(normalizeNode);
        normalizeWorldOpts(w);
        return w;
    });

    const ver = Number(s.version || 1);
    if (ver < 3) s.header = DEFAULT_HEADER; // v1/v2 stored a Korean header
    s.version = STORE_VERSION;
    saveSettingsDebounced();
    return s;
}

function getSettings() {
    return extension_settings[MODULE_NAME] ?? initSettings();
}

const saveSettings = () => saveSettingsDebounced();
const saveSoon = debounce(() => saveSettingsDebounced(), 400);

function getWorlds() { return getSettings().worlds; }

function getWorldById(id) {
    if (!id) return null;
    return getWorlds().find(w => w.id === id) || null;
}

/** Per-world overrides of global options */
function normalizeWorldOpts(w) {
    if (!['global', 'on', 'off'].includes(w.compressMode)) w.compressMode = 'global';
    const k = Number(w.compressKeep);
    w.compressKeep = Number.isFinite(k) && k >= 1 ? Math.floor(k) : null;
    return w;
}

/** Effective "compress older entries" options for a world */
function compressOpts(world) {
    const s = getSettings();
    const on = world?.compressMode === 'on' ? true : world?.compressMode === 'off' ? false : !!s.compressOld;
    const keep = Math.max(1, Number(world?.compressKeep) || Number(s.compressKeep) || 12);
    return { on, keep };
}

function createWorld(name) {
    const world = { id: uid(), name: name || '새 세계관', nodes: [], compressMode: 'global', compressKeep: null };
    getWorlds().push(world);
    getSettings().activeWorldId = world.id;
    saveSettings();
    return world;
}

/** The world selected for editing in the settings panel */
function getEditingWorld() {
    const s = getSettings();
    return getWorldById(s.activeWorldId) || getWorlds()[0] || null;
}

/** v1 (flat entries) → v2+ (nodes + blocks) */
function migrateWorld(w) {
    if (!w || Array.isArray(w.nodes)) { if (w && !Array.isArray(w.nodes)) w.nodes = []; return w; }
    const nodes = [];
    for (const e of (w.entries || [])) {
        const date = String(e?.date ?? '').trim();
        let node = nodes.find(n => n.date === date);
        if (!node) { node = { id: uid(), date, blocks: [] }; nodes.push(node); }
        const type = BLOCK_TYPES[e?.category] ? e.category : 'story';
        node.blocks.push(makeBlock({
            type,
            name: BLOCK_TYPES[type].named ? (e?.title || '') : '',
            content: e?.content || '',
            keys: e?.keys || [],
            constant: e?.constant !== false,
            priority: e?.priority || 0,
            enabled: e?.enabled !== false,
        }));
    }
    w.nodes = nodes;
    delete w.entries;
    return w;
}

// ---- per-chat settings ----

function getChatConf() {
    const meta = getContext()?.chatMetadata;
    if (!meta) return { worldId: null, now: '' };
    if (!meta[META_KEY] || typeof meta[META_KEY] !== 'object') meta[META_KEY] = { worldId: null, now: '' };
    const c = meta[META_KEY];
    if (typeof c.worldId === 'undefined') c.worldId = null;
    if (typeof c.now !== 'string') c.now = '';
    return c;
}

function setChatConf(patch) {
    Object.assign(getChatConf(), patch);
    try { saveMetadataDebounced(); } catch (e) { warn('메타데이터 저장 실패', e); }
}

function getActiveWorld() {
    return getWorldById(getChatConf().worldId);
}

// ==================================================================
// Dates   "2015" / "2015-06" / "2015-06-20" / "2015.6.20" / "-500"
// ==================================================================

function parseDate(str) {
    if (typeof str !== 'string') return null;
    let t = str.trim();
    if (!t) return null;

    // compact digits: 20010101 → 2001-01-01, 200101 → 2001-01
    const compact = t.match(/^(-?)(\d{6}|\d{8})$/);
    if (compact) {
        const sign = compact[1];
        const d = compact[2];
        t = d.length === 8
            ? `${sign}${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
            : `${sign}${d.slice(0, 4)}-${d.slice(4, 6)}`;
    }

    const m = t.match(/^(-?\d{1,6})(?:\s*[-./]\s*(\d{1,2}))?(?:\s*[-./]\s*(\d{1,2}))?$/);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const mo = m[2] !== undefined ? parseInt(m[2], 10) : null;
    const d = m[3] !== undefined ? parseInt(m[3], 10) : null;
    if (mo !== null && (mo < 1 || mo > 12)) return null;
    if (d !== null && (d < 1 || d > 31)) return null;
    if (d !== null && mo === null) return null;
    return { y, m: mo, d };
}

/** Start of the period (the entry's own point in time) */
function startKey(dt) { return dt ? dt.y * 10000 + (dt.m ?? 1) * 100 + (dt.d ?? 1) : null; }
/** End of the period (for comparing against the current point) */
function endKey(dt) { return dt ? dt.y * 10000 + (dt.m ?? 12) * 100 + (dt.d ?? 31) : null; }

const RANGE_SEP = /\s*[~～〜]\s*/;

/**
 * A node date: a point ("1991-09-01") or a period ("1970~1981", open-ended "1991~").
 * @returns {{start:object, end:object|null, range:boolean}|null}
 */
function parseSpan(str) {
    if (typeof str !== 'string') return null;
    const t = str.trim();
    if (!t) return null;
    const parts = t.split(RANGE_SEP);
    if (parts.length === 1) {
        const dt = parseDate(t);
        return dt ? { start: dt, end: null, range: false } : null;
    }
    if (parts.length !== 2) return null;
    const a = parseDate(parts[0]);
    if (!a) return null;
    if (!parts[1]) return { start: a, end: null, range: true };      // still ongoing
    const b = parseDate(parts[1]);
    if (!b || endKey(b) < startKey(a)) return null;
    return { start: a, end: b, range: true };
}

function nodeKey(node) { return startKey(parseSpan(node?.date)?.start); }

/** Last day a period covers (Infinity for open-ended); null for points */
function spanEndKey(span) { return span?.range ? (span.end ? endKey(span.end) : Infinity) : null; }

/** 'point' | 'range' (no current point set) | 'ongoing' | 'ended' */
function spanStatus(span, nowLimit) {
    if (!span?.range) return 'point';
    if (nowLimit === null) return 'range';
    return spanEndKey(span) < nowLimit ? 'ended' : 'ongoing';
}

function formatPoint(dt) {
    let out = String(dt.y);
    if (dt.m !== null) out += '-' + String(dt.m).padStart(2, '0');
    if (dt.d !== null) out += '-' + String(dt.d).padStart(2, '0');
    return out;
}

function formatDate(str) {
    const span = parseSpan(str);
    if (!span) return String(str ?? '');
    return span.range ? `${formatPoint(span.start)}~${span.end ? formatPoint(span.end) : ''}` : formatPoint(span.start);
}

// ==================================================================
// Nodes / blocks
// ==================================================================

function makeBlock(patch = {}) {
    return Object.assign({
        id: uid(),
        type: 'story',
        name: '',
        content: '',
        keys: [],
        constant: true,
        priority: 0,
        enabled: true,
        secret: false,
        knownBy: '',
        replaces: false,
    }, patch);
}

function normalizeBlock(b) {
    const out = makeBlock(b);
    out.id = b?.id || uid();
    out.type = BLOCK_TYPES[b?.type] ? b.type : 'story';
    out.name = String(b?.name ?? '').trim();
    out.content = String(b?.content ?? '');
    out.keys = Array.isArray(b?.keys)
        ? b.keys.map(k => String(k).trim()).filter(Boolean)
        : String(b?.keys ?? '').split(',').map(k => k.trim()).filter(Boolean);
    out.constant = b?.constant !== false;
    out.priority = Number.isFinite(Number(b?.priority)) ? Number(b.priority) : 0;
    out.enabled = b?.enabled !== false;
    out.secret = !!b?.secret;
    out.knownBy = String(b?.knownBy ?? '').trim();
    out.replaces = !!b?.replaces && BLOCK_TYPES[out.type].named;
    return out;
}

const NODE_MODES = ['auto', 'pin', 'key']; // per-entry / everything always / everything by keyword

function normalizeNode(n) {
    return {
        id: n?.id || uid(),
        date: String(n?.date ?? '').trim(),
        mode: NODE_MODES.includes(n?.mode) ? n.mode : 'auto',
        enabled: n?.enabled !== false,
        blocks: (Array.isArray(n?.blocks) ? n.blocks : []).map(normalizeBlock),
    };
}

function makeNode(date = '') {
    return { id: uid(), date: String(date), mode: 'auto', enabled: true, blocks: [] };
}

/** "Always" state of an entry after the point-level setting is applied */
function effConst(node, b) {
    if (node?.mode === 'pin') return true;
    if (node?.mode === 'key') return false;
    return b.constant !== false;
}

/** Entries that can never be inserted (not always + no keywords) */
function deadBlocks(node) {
    return (node.blocks || []).filter(b => b.enabled !== false && !effConst(node, b) && !(b.keys || []).length);
}

/** First sentence (≥ 20 chars, so "Mr." etc. do not cut it short) */
function firstSentence(text) {
    const t = String(text ?? '').trim();
    const re = /[.!?。！？](?=\s|$)/g;
    let m;
    while ((m = re.exec(t))) {
        if (m.index >= 20) return t.slice(0, m.index + 1);
    }
    return t;
}

function sortBlocks(blocks) {
    return [...blocks].sort((a, b) =>
        (BLOCK_TYPES[a.type]?.order ?? 9) - (BLOCK_TYPES[b.type]?.order ?? 9));
}

function sortNodes(nodes) {
    return nodes
        .map(n => ({ n, k: nodeKey(n) }))
        .sort((a, b) => {
            if (a.k === null && b.k === null) return 0;
            if (a.k === null) return 1;
            if (b.k === null) return -1;
            return a.k - b.k;
        })
        .map(x => x.n);
}

/** "type|name" identity used for overwrite / replaces matching */
function nameKey(b) {
    return `${b.type}|${String(b.name || '').trim().toLowerCase()}`;
}

/**
 * Merge nodes into a node list (mutates `target`).
 * - Same date → same node.
 * - Same node + same character/relation name → overwrite.
 * - Unnamed (story/environment) entries are appended.
 * Returns a report and marks each incoming block with `_status`.
 */
function mergeNodes(target, incoming) {
    const report = { newNodes: 0, added: 0, overwritten: 0 };
    for (const inNode of incoming) {
        const date = formatDate(inNode.date);
        let node = target.find(n => formatDate(n.date) === date);
        let isNewNode = false;
        if (!node) {
            node = makeNode(date);
            target.push(node);
            report.newNodes++;
            isNewNode = true;
        }
        if (!Array.isArray(node.blocks)) node.blocks = [];
        for (const b0 of inNode.blocks) {
            const b = normalizeBlock({ ...b0, id: undefined });
            const named = BLOCK_TYPES[b.type].named && b.name;
            const existing = named ? node.blocks.find(x => x.type === b.type && nameKey(x) === nameKey(b)) : null;
            if (existing) {
                const keepId = existing.id;
                Object.assign(existing, b, { id: keepId });
                b0._status = 'overwrite';
                report.overwritten++;
            } else {
                node.blocks.push(b);
                b0._status = isNewNode ? 'new' : 'add';
                report.added++;
            }
        }
        node.blocks = sortBlocks(node.blocks);
    }
    return report;
}

// ==================================================================
// Prompt assembly
// ==================================================================

function getScanText(depth, source) {
    try {
        const arr = Array.isArray(source) ? source : (Array.isArray(chat) ? chat : []);
        return arr.slice(-Math.max(1, depth)).map(m => String(m?.mes ?? '')).join('\n').toLowerCase();
    } catch (e) {
        warn('대화 스캔 실패', e);
        return '';
    }
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const _matchers = new Map();

/**
 * Build (once, then cache) a test function for one keyword.
 *  - /regex/                 → regex
 *  - ASCII                   → whole word (Ron ≠ Ronald)
 *  - Hangul, 1–2 letters     → must start a word (론 matches "론이", not "결론")
 *  - Japanese / Chinese, any → substring (no spaces between words in these languages)
 *  - anything longer         → substring (스네이프 matches "스네이프가")
 */
function getMatcher(k) {
    let m = _matchers.get(k);
    if (m) return m;
    const kw = k.toLowerCase();
    if (k.length > 2 && k.startsWith('/') && k.endsWith('/')) {
        let re = null;
        try { re = new RegExp(k.slice(1, -1), 'iu'); } catch { /* invalid regex → never matches */ }
        m = re ? (t) => re.test(t) : () => false;
    } else if (!kw) {
        m = () => false;
    } else if (/^[\x20-\x7E]+$/.test(kw)) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escRe(kw)}(?![\\p{L}\\p{N}_])`, 'u');
        m = (t) => re.test(t);
    } else if (/^[\p{Script=Hangul}]{1,2}$/u.test(kw)) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escRe(kw)}`, 'u');
        m = (t) => re.test(t);
    } else {
        m = (t) => t.includes(kw);
    }
    if (_matchers.size > 5000) _matchers.clear();
    _matchers.set(k, m);
    return m;
}

function keywordMatches(k, scanText) {
    return getMatcher(k)(scanText);
}

function hasKeywordHit(block, scanText) {
    const keys = block.keys;
    if (!scanText || !Array.isArray(keys) || !keys.length) return false;
    return keys.some(k => keywordMatches(String(k), scanText));
}

/** One prompt line (labels are always English). pastBy = date of the entry that supersedes it. */
function renderBlockLine(block, pastBy = '') {
    const t = BLOCK_TYPES[block.type] ?? BLOCK_TYPES.story;
    let label = t.en;
    if (t.named && block.name) label += ` (${block.name})`;
    if (pastBy) label += ` [PAST, superseded on ${pastBy}]`;
    if (block.secret) label += block.knownBy ? ` [SECRET, known only to: ${block.knownBy}]` : ' [SECRET]';
    return `${label}: ${String(block.content).trim()}`;
}

const _tokenCache = new Map();

/** Rough token estimate (no tokenizer call). */
function estTokens(text) {
    const s = String(text);
    const cjk = (s.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
    return Math.ceil(cjk * 0.9 + (s.length - cjk) / 4);
}

/** A safe lower bound: real token counts are almost never below this. */
function estTokensLow(text) {
    return Math.floor(String(text).length / 8);
}

async function countTokens(text) {
    if (!text) return 0;
    if (_tokenCache.has(text)) return _tokenCache.get(text);
    let n;
    try {
        n = await getTokenCountAsync(text);
    } catch {
        n = estTokens(text);
    }
    if (_tokenCache.size > 1200) _tokenCache.clear();
    _tokenCache.set(text, n);
    return n;
}

// ---- characters present in the scene ----

const _tokCache = new Map();

/** Name → lowercase tokens usable for matching (full name + meaningful parts). */
function nameTokens(name) {
    const key = String(name || '');
    let out = _tokCache.get(key);
    if (out) return out;
    const full = key.trim().toLowerCase();
    const parts = full.split(/[\s·.\-_]+/).filter(t => (/^[\x20-\x7E]+$/.test(t) ? t.length >= 3 : [...t].length >= 2));
    out = [...new Set([full, ...parts].filter(Boolean))];
    if (_tokCache.size > 4000) _tokCache.clear();
    _tokCache.set(key, out);
    return out;
}

/** People named by a character / relation entry ("A & B" → [A, B]) */
function participants(block) {
    if (block.type === 'relation') {
        return String(block.name || '').split(/\s*(?:&|,|\/|·| and | 와 | 과 | 및 )\s*/i).map(x => x.trim()).filter(Boolean);
    }
    return block.name ? [block.name] : [];
}

/** Names of the characters in this chat (card / group members / persona). */
function getCastNames() {
    const ctx = getContext();
    const names = [];
    try {
        if (ctx.groupId) {
            const group = (ctx.groups || []).find(g => g.id === ctx.groupId);
            for (const avatar of (group?.members || [])) {
                const ch = (ctx.characters || []).find(c => c.avatar === avatar);
                if (ch?.name) names.push(ch.name);
            }
        } else if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]?.name) {
            names.push(ctx.characters[ctx.characterId].name);
        }
        if (ctx.name1) names.push(ctx.name1);
    } catch (e) { warn('등장 인물 읽기 실패', e); }
    return [...new Set(names.filter(Boolean))];
}

/** Build the chronicle block for the current state. */
/** @param {object[]} [scanChat] messages to scan for keywords (defaults to the live chat) */
async function buildPacket(scanChat) {
    const s = getSettings();
    const world = getActiveWorld();
    const conf = getChatConf();
    const base = { text: '', used: [], dropped: [], excluded: 0, replaced: 0, replacedList: [], replacedMode: s.replacedMode, cast: [], castOut: 0, tokens: 0, pinnedTokens: 0, world, now: conf.now };

    if (!s.enabled || !world) return base;

    const nowLimit = conf.now ? endKey(parseDate(conf.now)) : null;

    // 1) time cut-off (stored data is already normalized at load / edit time)
    let candidates = [];
    let excluded = 0;

    for (const node of (world.nodes || [])) {
        const span = parseSpan(node?.date);
        if (!span || !Array.isArray(node.blocks) || node.enabled === false) continue;
        const key = startKey(span.start);
        const live = node.blocks.filter(b => b.enabled !== false && String(b.content ?? '').trim());
        if (!live.length) continue;
        if (nowLimit !== null && key > nowLimit) { excluded += live.length; continue; }
        const status = spanStatus(span, nowLimit);
        // recency for scoring: an ongoing period counts as "now"; an ended one as its last day
        const rkey = status === 'ongoing' ? nowLimit : (span.range && span.end ? startKey(span.end) : key);
        for (const b of live) {
            const constant = effConst(node, b);
            candidates.push({ node, block: b.constant === constant ? b : { ...b, constant }, key, rkey, status });
        }
    }

    // 2) "replaces earlier": older entries of the same person/pair are superseded.
    //    past mode → kept, marked PAST (the history of the change still matters)
    //    drop mode → left out
    const latestReplace = new Map(); // nameKey → { key, date }
    for (const c of candidates) {
        if (!c.block.replaces || !c.block.name) continue; // replaces only exists on named types
        const nk = nameKey(c.block);
        const cur = latestReplace.get(nk);
        if (!cur || cur.key < c.key) latestReplace.set(nk, { key: c.key, date: formatDate(c.node.date) });
    }
    const replacedList = [];
    const dropReplaced = s.replacedMode === 'drop';
    if (latestReplace.size) {
        candidates = candidates.filter(c => {
            const lim = c.block.name ? latestReplace.get(nameKey(c.block)) : undefined;
            if (!lim || c.key >= lim.key) return true;
            replacedList.push({ node: c.node, block: c.block, key: c.key, by: lim.date });
            if (dropReplaced) return false;
            c.pastBy = lim.date;
            return true;
        });
    }
    const replaced = replacedList.length;
    const rbase = { ...base, excluded, replaced, replacedList, compressed: 0 };

    // 2b) optional: older points go in as their first sentence only
    const comp = compressOpts(world);
    if (comp.on) {
        const keep = comp.keep;
        const recent = [...new Set(candidates.map(c => c.rkey))].sort((a, b) => b - a);
        if (recent.length > keep) {
            const threshold = recent[keep - 1];
            for (const c of candidates) c.compress = c.rkey < threshold;
        }
    }
    if (!candidates.length) return rbase;

    // 3) inclusion (pinned or keyword hit) + characters present in the scene
    const scanText = getScanText(s.scanDepth, scanChat);
    const castMode = s.castMode || 'off';
    const castTokens = new Set(getCastNames().flatMap(nameTokens));
    const presentNames = new Set(getCastNames());
    const isPresent = (block, hit) => {
        if (hit) return true;
        let found = false;
        for (const person of participants(block)) {
            const toks = nameTokens(person);
            if (toks.some(t => castTokens.has(t) || (scanText && keywordMatches(t, scanText)))) { presentNames.add(person); found = true; }
        }
        return found;
    };
    const picked = [];
    let castOut = 0;
    for (const c of candidates) {
        const hit = !c.block.constant || s.keywordBonus ? hasKeywordHit(c.block, scanText) : false;
        if (!c.block.constant && !hit) continue;
        let present = false;
        if (castMode !== 'off' && BLOCK_TYPES[c.block.type]?.named && c.block.name) {
            present = isPresent(c.block, hit);
            if (castMode === 'filter' && !present) { castOut++; continue; }
        }
        picked.push({ ...c, hit, present });
    }
    rbase.cast = [...presentNames];
    rbase.castOut = castOut;
    if (!picked.length) return rbase;

    // 4) score — recency by rank (position in the timeline), not by date distance
    const ranks = [...new Set(picked.map(p => p.rkey))].sort((a, b) => a - b);
    const rankOf = new Map(ranks.map((k, i) => [k, i]));
    const denom = Math.max(1, ranks.length - 1);
    const castBonus = castMode === 'boost' ? Number(s.castBonus || 0) : 0;
    for (const p of picked) {
        p.recency = ranks.length > 1 ? rankOf.get(p.rkey) / denom : 1;
        p.score = p.recency * Number(s.recencyWeight || 0)
            + Number(p.block.priority || 0)
            + (p.block.constant ? Number(s.constantBonus || 0) : 0)
            + (p.hit ? Number(s.keywordBonus || 0) : 0)
            + (p.present ? castBonus : 0);
    }

    // 5) fill the budget by score — the header is part of the budget too
    const nowLabel = conf.now ? formatDate(conf.now) : 'unrestricted';
    const baseHeader = String(s.header || '').replaceAll('{{now}}', nowLabel).trim();
    const makeHead = (withSecret, withPast) => {
        const h = [baseHeader, withSecret ? SECRET_NOTE : '', withPast ? PAST_NOTE : ''].filter(Boolean).join('\n');
        return `<chronicle current_time="${esc(nowLabel)}">\n` + (h ? h + '\n\n' : '');
    };
    const reserve = await countTokens(makeHead(picked.some(p => p.block.secret), picked.some(p => p.pastBy)) + '\n</chronicle>');
    const budget = Math.max(0, Number(s.tokenBudget || 0) - reserve);
    const byScore = [...picked].sort((a, b) => (b.score - a.score) || (b.key - a.key));
    const used = [], dropped = [];
    const seenNodes = new Set();
    let total = 0, pinnedTokens = 0;
    const pinnedNodes = new Set();

    for (const p of byScore) {
        p.line = renderBlockLine(p.compress ? { ...p.block, content: firstSentence(p.block.content) } : p.block, p.pastBy);
        const nodeCost = seenNodes.has(p.node.id) ? 0 : 6;
        // Only run the real tokenizer when the line could still fit; a cheap
        // lower-bound estimate rules out the rest (big speed-up on large worlds).
        const fits = total + nodeCost + estTokensLow(p.line) <= budget;
        const lineCost = fits ? await countTokens(p.line) + 1 : estTokens(p.line) + 1;
        if (p.block.constant) {
            pinnedTokens += lineCost + (pinnedNodes.has(p.node.id) ? 0 : 6);
            pinnedNodes.add(p.node.id);
        }
        if (!fits || total + nodeCost + lineCost > budget) { dropped.push(p); continue; }
        total += nodeCost + lineCost;
        seenNodes.add(p.node.id);
        used.push(p);
    }
    if (!used.length) return { ...rbase, dropped, pinnedTokens };

    // 6) output in chronological order, grouped by node
    used.sort((a, b) => (a.key - b.key)
        || ((BLOCK_TYPES[a.block.type]?.order ?? 9) - (BLOCK_TYPES[b.block.type]?.order ?? 9)));

    const groups = [];
    for (const p of used) {
        let g = groups.find(x => x.node.id === p.node.id);
        if (!g) { g = { node: p.node, lines: [] }; groups.push(g); }
        g.lines.push(p.line);
    }

    const head = makeHead(used.some(p => p.block.secret), used.some(p => p.pastBy));
    const statusOf = new Map(used.map(p => [p.node.id, p.status]));
    const nodeHead = (node) => {
        const st = statusOf.get(node.id);
        const d = formatDate(node.date);
        return st === 'ongoing' ? `[${d}, ongoing]` : st === 'ended' ? `[${d}, ended]` : `[${d}]`;
    };
    const body = groups.map(g => `${nodeHead(g.node)}\n${g.lines.join('\n')}`).join('\n\n');
    const text = head + body + '\n</chronicle>';

    // header + per-line costs already counted (cached), so no second pass over the whole text
    const tokens = total + await countTokens(head + '\n</chronicle>');
    rbase.compressed = used.filter(p => p.compress).length;
    return { ...rbase, text, used, dropped, tokens, pinnedTokens };
}

// ==================================================================
// Injection
// ==================================================================

function positionType(pos) {
    if (pos === 'before') return extension_prompt_types.BEFORE_PROMPT;
    if (pos === 'after') return extension_prompt_types.IN_PROMPT;
    return extension_prompt_types.IN_CHAT;
}

function roleValue(r) {
    const n = Number(r);
    if (n === 1) return extension_prompt_roles.USER;
    if (n === 2) return extension_prompt_roles.ASSISTANT;
    return extension_prompt_roles.SYSTEM;
}

function clearInjection() {
    setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

let _chain = Promise.resolve();
function updateInjection(scanChat) {
    const run = () => doUpdate(scanChat);
    _chain = _chain.then(run, run);
    return _chain;
}

async function doUpdate(scanChat) {
    try {
        const s = getSettings();
        if (!s.enabled) { clearInjection(); renderStatus(null); return; }
        const packet = await buildPacket(Array.isArray(scanChat) ? scanChat : undefined);
        setExtensionPrompt(INJECT_KEY, packet.text, positionType(s.position),
            Number(s.depth || 0), false, roleValue(s.role));
        log(`주입 ${packet.used.length}개 / ${packet.tokens} 토큰 (미래 차단 ${packet.excluded} · 대체 ${packet.replaced} · 예산 초과 ${packet.dropped.length})`);
        renderStatus(packet);
    } catch (e) {
        warn('주입 실패', e);
        clearInjection();
    }
}

const updateSoon = debounce(() => updateInjection(), 700);

// ==================================================================
// Plain-text format
// ==================================================================
//
// [2015-06-30]
//   스토리 [항상]
//     키워드: a, b
//     우선도: 10
//     내용 …
//   인물 (앨리스) [비밀] [대체]
//     아는 사람: 밥
//     내용 …

const TYPE_ALIASES = {
    '스토리': 'story', 'story': 'story', '사건': 'story',
    '인물': 'character', 'character': 'character', '캐릭터': 'character',
    '관계': 'relation', 'relation': 'relation', 'relationship': 'relation',
    '환경': 'environment', 'environment': 'environment', '배경': 'environment', '세계': 'environment',
};

function exportText(world) {
    const out = [];
    out.push(`# 크로니클: ${world.name}`);
    out.push('# [날짜] 아래에 칸 종류(스토리/인물/관계/환경), 그 아래 옵션 줄(키워드:, 우선도:, 아는 사람:)과 내용을 씁니다.');
    out.push('# 칸 옵션: [항상] = 항상 삽입, [비밀] = 비밀, [대체] = 같은 이름의 이전 칸 대체, [꺼짐] = 사용 안 함');
    out.push('# 기간: [1970~1981] 처럼 쓰면 그 기간 동안 이어지는 상태가 됩니다. 끝나지 않았으면 [1991~]');
    out.push('# 시점 옵션 (날짜 뒤): [전부 항상] / [전부 키워드] / [시점 꺼짐]');
    out.push('');
    for (const node of sortNodes(world.nodes || [])) {
        const nflags = [node.mode === 'pin' ? '[전부 항상]' : node.mode === 'key' ? '[전부 키워드]' : '', node.enabled === false ? '[시점 꺼짐]' : ''].filter(Boolean);
        out.push(`[${formatDate(node.date) || node.date}]${nflags.length ? ' ' + nflags.join(' ') : ''}`);
        for (const b of sortBlocks(node.blocks)) {
            const t = BLOCK_TYPES[b.type];
            let head = `  ${t.ko}`;
            if (t.named && b.name) head += ` (${b.name})`;
            const flags = [];
            if (b.constant) flags.push('[항상]');
            if (b.secret) flags.push('[비밀]');
            if (b.replaces) flags.push('[대체]');
            if (!b.enabled) flags.push('[꺼짐]');
            if (flags.length) head += ' ' + flags.join(' ');
            out.push(head);
            if (b.keys.length) out.push(`    키워드: ${b.keys.join(', ')}`);
            if (b.priority) out.push(`    우선도: ${b.priority}`);
            if (b.secret && b.knownBy) out.push(`    아는 사람: ${b.knownBy}`);
            for (const line of String(b.content).split('\n')) out.push(`    ${line}`);
        }
        out.push('');
    }
    return out.join('\n');
}

/** Parse the plain-text format. Lines before the first [date] are ignored. */
function parseText(text) {
    const nodes = [];
    let node = null;
    let block = null;
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

    const finishBlock = () => {
        if (!block) return;
        block.content = block._lines.join('\n').trim();
        delete block._lines;
        if (/^\((비밀|secret)\)\s*/i.test(block.content)) {
            block.secret = true;
            block.content = block.content.replace(/^\((비밀|secret)\)\s*/i, '');
        }
        if (!block._pinFlag) block.constant = block.keys.length === 0; // no keys → always, so it is never dead
        delete block._pinFlag;
        if (block.content) node.blocks.push(normalizeBlock(block));
        block = null;
    };

    for (const raw of lines) {
        const line = raw.trim();
        const dateM = line.match(/^\[([^\]]+)\]((?:\s*\[[^\]]*\])*)$/);
        if (dateM && parseSpan(dateM[1].trim())) {
            finishBlock();
            node = makeNode(formatDate(dateM[1].trim()));
            for (const f of (dateM[2] || '').matchAll(/\[([^\]]*)\]/g)) {
                const flag = f[1].replace(/\s+/g, '');
                if (/^(전부항상|항상|allpinned|pinned)$/i.test(flag)) node.mode = 'pin';
                else if (/^(전부키워드|키워드|allkeyword|keyword)$/i.test(flag)) node.mode = 'key';
                else if (/^(시점꺼짐|꺼짐|off|disabled)$/i.test(flag)) node.enabled = false;
            }
            nodes.push(node);
            continue;
        }
        if (!node) continue;

        const headM = line.match(/^([^\s([]+)\s*(?:\(([^)]*)\))?\s*((?:\[[^\]]*\]\s*)*)$/);
        const type = headM ? TYPE_ALIASES[headM[1].toLowerCase()] : null;
        if (headM && type) {
            finishBlock();
            block = makeBlock({ type, name: BLOCK_TYPES[type].named ? (headM[2] || '').trim() : '', constant: false });
            block._lines = [];
            block._pinFlag = false;
            for (const f of (headM[3] || '').matchAll(/\[([^\]]*)\]/g)) {
                const flag = f[1].trim();
                const low = flag.toLowerCase();
                if (/^(항상|핀|pin|pinned|always)$/.test(low)) { block.constant = true; block._pinFlag = true; }
                else if (/^(비밀|secret)/.test(low)) {
                    block.secret = true;
                    const who = flag.split(/[:：]/).slice(1).join(':').trim();
                    if (who) block.knownBy = who;
                }
                else if (/^(대체|replaces?)$/.test(low)) block.replaces = true;
                else if (/^(꺼짐|off|disabled)$/.test(low)) block.enabled = false;
            }
            continue;
        }
        if (!block) continue;

        const meta = line.match(/^(키워드|keywords?|keys?|우선도|priority|아는\s*사람|known\s*by)\s*[:：]\s*(.*)$/i);
        if (meta && !block._lines.length) {
            const k = meta[1].toLowerCase().replace(/\s+/g, '');
            const v = meta[2].trim();
            if (/^(키워드|keywords?|keys?)$/.test(k)) block.keys = v.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
            else if (/^(우선도|priority)$/.test(k)) block.priority = clamp(Number(v) || 0, -100, 100);
            else { block.knownBy = v; if (v) block.secret = true; }
            continue;
        }
        block._lines.push(raw.replace(/^\s{0,4}/, ''));
    }
    finishBlock();
    return nodes.filter(n => n.blocks.length);
}

// ==================================================================
// AI generation — model access
// ==================================================================

function getProfiles() {
    try {
        const svc = getContext().ConnectionManagerRequestService;
        if (!svc) return [];
        return svc.getSupportedProfiles() || [];
    } catch { return []; }
}

function secretsFor(key) {
    const list = secret_state?.[key];
    return Array.isArray(list) ? list : [];
}

/** Vertex auth mode for a profile: inferred from which store its secret id lives in. */
function inferVertexMode(secretId) {
    const ctx = getContext();
    const saKey = SECRET_KEYS?.VERTEXAI_SERVICE_ACCOUNT ?? 'vertexai_service_account_json';
    const exKey = SECRET_KEYS?.VERTEXAI ?? 'api_key_vertexai';
    if (secretId && secretsFor(saKey).some(x => x.id === secretId)) return 'full';
    if (secretId && secretsFor(exKey).some(x => x.id === secretId)) return 'express';
    return ctx.chatCompletionSettings?.vertexai_auth_mode || 'express';
}

function extractText(res) {
    if (typeof res === 'string') return res;
    if (res && typeof res.content === 'string') return res.content;
    if (res && typeof res === 'object') return JSON.stringify(res);
    return '';
}

/**
 * Send one system + user request through the configured connection.
 * @returns {Promise<string>}
 */
async function callModel(system, user, signal) {
    const ai = getSettings().ai;
    const ctx = getContext();
    const maxTokens = clamp(Number(ai.maxTokens) || 8000, 256, 200000);
    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];

    if (ai.mode === 'profile') {
        const svc = ctx.ConnectionManagerRequestService;
        if (!svc) throw new Error('이 실리태번 버전에는 연결 프로필 요청 기능이 없습니다.');
        if (!ai.profileId) throw new Error('설정 탭에서 연결 프로필을 골라 주세요.');
        const profile = svc.getProfile(ai.profileId);
        const source = ctx.CONNECT_API_MAP?.[profile.api]?.source;
        const override = {};
        if (source === 'vertexai') {
            override.vertexai_auth_mode = inferVertexMode(profile['secret-id']);
            override.vertexai_express_project_id = ctx.chatCompletionSettings?.vertexai_express_project_id || undefined;
        }
        const res = await svc.sendRequest(ai.profileId, messages, maxTokens,
            { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true }, override);
        return extractText(res);
    }

    if (ai.mode === 'direct') {
        const svc = ctx.ChatCompletionService;
        if (!svc) throw new Error('이 실리태번 버전에는 직접 요청 기능이 없습니다.');
        if (!ai.model) throw new Error('설정 탭에서 모델 이름을 입력해 주세요.');
        const payload = {
            stream: false,
            messages,
            model: ai.model,
            chat_completion_source: ai.source,
            max_tokens: maxTokens,
            secret_id: ai.secretId || undefined,
        };
        if (ai.source === 'custom') payload.custom_url = ai.customUrl;
        if (ai.source === 'vertexai') {
            payload.vertexai_auth_mode = ai.vertexAuth;
            payload.vertexai_region = ai.vertexRegion || 'us-central1';
            payload.vertexai_express_project_id = ctx.chatCompletionSettings?.vertexai_express_project_id || undefined;
        }
        if (ai.source === 'zai') payload.zai_endpoint = ai.zaiEndpoint || 'common';
        const res = await svc.processRequest(payload, {}, true, signal);
        return extractText(res);
    }

    // current connection
    if (typeof ctx.generateRaw !== 'function') throw new Error('generateRaw 를 찾을 수 없습니다.');
    return await ctx.generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens, trimNames: false });
}

/** Strip fences / chatter and parse the first JSON object. */
function parseJsonLoose(text) {
    let t = String(text ?? '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a === -1 || b <= a) throw new Error('JSON 없음');
    return JSON.parse(t.slice(a, b + 1));
}

// ==================================================================
// AI generation — prompts (English, model-facing)
// ==================================================================

const DETAIL_TEXT = {
    brief: 'only the major turning points; keep the record short',
    normal: 'the main events and the important changes of the main characters',
    detailed: 'a thorough record that also covers secondary characters, relationships and setting details',
};
const ERA_COUNT = { brief: 4, normal: 7, detailed: 10 };
const LANG_TEXT = { ko: 'Korean', en: 'English' };

function keysRule(L, keyLangs) {
    const langs = (keyLangs || []).map(k => KEY_LANGS[k]).filter(Boolean);
    if (!langs.length) {
        return `Include both the ${L} form and the original-language form of names when they differ.`;
    }
    const list = langs.length === 1 ? langs[0] : `${langs.slice(0, -1).join(', ')} and ${langs.at(-1)}`;
    return `Write every name and key term in each of these languages: ${list}. Use the established form in each language (official translation or common transliteration); if a language has no established form, transliterate it.`;
}

function formatSpec(lang, detail, keyLangs) {
    const L = LANG_TEXT[lang] || 'Korean';
    return [
        'Output format (strict):',
        'Return only one JSON object, with no commentary and no code fences:',
        '{"nodes":[{"date":"YYYY-MM-DD","blocks":[{"type":"story","name":"","content":"...","keys":["..."],"pinned":true,"secret":false,"known_by":"","replaces":false,"priority":0}]}]}',
        '',
        'Rules:',
        '- date: a point in time written as YYYY, YYYY-MM or YYYY-MM-DD (a leading minus for years before year 0). Use the most precise date the source supports. If the world has no real calendar, number the years from the start of the story (1, 2, 3...) and use those numbers consistently.',
        '- A state that lasts over a period (a war, a school year, a regime, an occupation) may use a range date "START~END", e.g. "1970~1981"; write "START~" if it has not ended. Use ranges only for lasting states, not for events.',
        '- One node per point in time (or period). Put everything that happens or changes at that time into that node\'s blocks.',
        '- type: "story" (events), "character" (one person\'s state, actions or changes), "relation" (the state of a relationship between named people), "environment" (world rules, institutions, places, politics, society).',
        '- name: required for "character" (the person\'s name) and "relation" (e.g. "A & B"); empty for "story" and "environment". Use exactly the same spelling every time the same person or pair appears.',
        `- content: 1-3 concise sentences written in ${L}. State the facts as of that point in time; never mention anything from a later date.`,
        '- pinned: true for entries that matter in any scene of that period (major events, world rules, the overall state of the world); false for details that matter only when the subject comes up.',
        `- keys: names, aliases and key terms that should trigger the entry when they appear in the conversation. Required when pinned is false. ${keysRule(L, keyLangs)} Never use single-character keys.`,
        '- secret: true when the fact is true but hidden from most characters at that time; list in known_by the characters who know it (comma-separated), or leave known_by empty if nobody knows yet.',
        '- replaces: true on a character or relation entry whose new state makes the earlier entries of that same name outdated (for example a changed allegiance or status). Otherwise false.',
        '- priority: an integer from -100 to 100; 0 by default, higher for entries that must survive when space is short.',
        `- Level of detail: ${DETAIL_TEXT[detail] || DETAIL_TEXT.normal}.`,
    ].join('\n');
}

function extraBlock(extra) {
    const t = String(extra || '').trim();
    return t ? `\n\nAdditional instructions from the user (follow them, but keep the output format):\n${t}` : '';
}

function namesBlock(names) {
    if (!names.size) return '';
    return `\n\nNames already used in earlier parts (reuse these exact spellings): ${[...names].slice(0, 120).join(', ')}`;
}

/** Split long text at paragraph boundaries. */
function splitText(text, size) {
    const paras = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);
    const out = [];
    let cur = '';
    for (const p of paras) {
        if ((cur + '\n\n' + p).length > size && cur) { out.push(cur); cur = ''; }
        if (p.length > size) {
            for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size));
            continue;
        }
        cur = cur ? cur + '\n\n' + p : p;
    }
    if (cur.trim()) out.push(cur);
    return out;
}

/** AI JSON → normalized nodes */
function aiToNodes(data) {
    const out = [];
    for (const n of (Array.isArray(data?.nodes) ? data.nodes : [])) {
        const date = String(n?.date ?? '').trim();
        if (!parseSpan(date)) continue;
        const blocks = [];
        for (const b of (Array.isArray(n?.blocks) ? n.blocks : [])) {
            let type = String(b?.type || '').toLowerCase();
            if (type === 'relationship') type = 'relation';
            if (!BLOCK_TYPES[type]) type = 'story';
            const content = String(b?.content ?? '').trim();
            if (!content) continue;
            const keys = (Array.isArray(b?.keys) ? b.keys : String(b?.keys ?? '').split(','))
                .map(k => String(k).trim()).filter(k => [...k].length > 1);
            let constant = b?.pinned !== false;
            if (!constant && !keys.length) constant = true; // never leave an entry that can't be inserted
            blocks.push(makeBlock({
                type,
                name: BLOCK_TYPES[type].named ? String(b?.name ?? '').trim() : '',
                content,
                keys,
                constant,
                secret: !!b?.secret,
                knownBy: String(b?.known_by ?? b?.knownBy ?? '').trim(),
                replaces: !!b?.replaces && BLOCK_TYPES[type].named,
                priority: clamp(Number(b?.priority) || 0, -100, 100),
            }));
        }
        if (blocks.length) out.push({ id: uid(), date: formatDate(date), blocks });
    }
    return out;
}

async function askJson(system, user, signal, ui, label) {
    for (let attempt = 0; attempt < 2; attempt++) {
        if (ui.cancelled) throw new Error('중지됨');
        const u = attempt === 0 ? user : user + '\n\nYour previous answer was not valid JSON. Reply again with only the JSON object.';
        ui.log(`${label}${attempt ? ' (다시 시도)' : ''} 요청 중…`);
        const text = await callModel(system, u, signal);
        try { return parseJsonLoose(text); }
        catch { ui.log(`${label}: 형식이 올바르지 않음`); }
    }
    throw new Error(`${label}: AI가 올바른 형식으로 답하지 않았습니다.`);
}

/**
 * Run the whole generation. Returns merged nodes (not yet saved).
 * opts: { mode: 'text'|'title', text, title, lang, detail, extra }
 */
async function runGeneration(opts, ui) {
    const ai = getSettings().ai;
    const system = `${String(ai.systemPrompt || DEFAULT_AI_SYSTEM).trim()}\n\n${formatSpec(opts.lang, opts.detail, opts.keyLangs)}`;
    const result = [];
    const names = new Set();
    const collect = (nodes) => {
        for (const n of nodes) for (const b of n.blocks) if (b.name) names.add(b.name);
        mergeNodes(result, nodes);
    };
    const failed = [];

    if (opts.mode === 'text') {
        const chunks = splitText(opts.text, clamp(Number(ai.chunkChars) || 12000, 2000, 200000));
        ui.log(`글을 ${chunks.length}부분으로 나눴습니다.`);
        for (let i = 0; i < chunks.length; i++) {
            if (ui.cancelled) break;
            ui.progress(i, chunks.length);
            const user = `Source text, part ${i + 1} of ${chunks.length}:\n<source>\n${chunks[i]}\n</source>\n\n` +
                'Extract the chronicle entries found in this part.' + namesBlock(names) + extraBlock(opts.extra);
            try {
                const nodes = aiToNodes(await askJson(system, user, ui.signal, ui, `${i + 1}/${chunks.length}부분`));
                ui.log(`${i + 1}/${chunks.length}부분: 시점 ${nodes.length}개`);
                collect(nodes);
            } catch (e) {
                if (ui.cancelled) break;
                failed.push(`${i + 1}부분`);
                ui.log(`${i + 1}/${chunks.length}부분 실패: ${errMsg(e)}`);
            }
        }
    } else {
        const title = String(opts.title || '').trim();
        const n = ERA_COUNT[opts.detail] || 7;
        const eraSystem = `${String(ai.systemPrompt || DEFAULT_AI_SYSTEM).trim()}\n\nReturn only one JSON object, with no commentary and no code fences.`;
        const eraUser = `Work: ${title}\n\nList the eras of this work's timeline from beginning to end, based on what you know about it. ` +
            `Return {"eras":[{"label":"...","from":"YYYY","to":"YYYY"}]} with at most ${n} eras. Write labels in ${LANG_TEXT[opts.lang] || 'Korean'}. ` +
            'If you do not know this work well enough to build a reliable timeline, return {"eras":[],"unknown":true}.' + extraBlock(opts.extra);
        const eraData = await askJson(eraSystem, eraUser, ui.signal, ui, '시대 목차');
        const eras = (Array.isArray(eraData?.eras) ? eraData.eras : []).filter(e => e && e.label);
        if (!eras.length) throw new Error('AI가 이 작품을 잘 모른다고 답했습니다. "텍스트 정리" 방식으로 자료를 직접 넣어 주세요.');
        const eraList = eras.map((e, i) => `${i + 1}. ${e.label} (${e.from ?? '?'} – ${e.to ?? '?'})`).join('\n');
        ui.log(`시대 ${eras.length}개:\n${eraList}`);

        for (let i = 0; i < eras.length; i++) {
            if (ui.cancelled) break;
            ui.progress(i, eras.length);
            const e = eras[i];
            const user = `Work: ${title}\n\nFull era list:\n${eraList}\n\n` +
                `Write the chronicle entries for era ${i + 1}: "${e.label}" (${e.from ?? '?'} to ${e.to ?? '?'}). Cover only this era.` +
                namesBlock(names) + extraBlock(opts.extra);
            try {
                const nodes = aiToNodes(await askJson(system, user, ui.signal, ui, `시대 ${i + 1}/${eras.length}`));
                ui.log(`시대 ${i + 1}/${eras.length}: 시점 ${nodes.length}개`);
                collect(nodes);
            } catch (err) {
                if (ui.cancelled) break;
                failed.push(e.label);
                ui.log(`시대 ${i + 1} 실패: ${errMsg(err)}`);
            }
        }
    }
    ui.progress(1, 1);
    for (const node of result) for (const b of node.blocks) delete b._status;
    return { nodes: sortNodes(result), failed };
}

// ==================================================================
// Display-only translation (SillyTavern built-in translator, no LLM)
// ==================================================================

let _translateFn = null;
const _trCache = new Map();

async function getTranslator() {
    if (_translateFn) return _translateFn;
    try {
        const mod = await import('../../translate/index.js');
        _translateFn = mod.translate;
    } catch (e) {
        warn('번역 모듈을 불러오지 못했습니다', e);
    }
    return _translateFn;
}

function isMostlyKorean(text) {
    const s = String(text).replace(/\s+/g, '');
    if (!s) return true;
    const ko = (s.match(/[ㄱ-힣]/g) || []).length;
    return ko / s.length > 0.3;
}

/** @returns {Promise<string|null>} translated text, or null when not needed / failed */
async function translateForView(text) {
    const src = String(text ?? '').trim();
    if (!src || isMostlyKorean(src)) return null;
    if (_trCache.has(src)) return _trCache.get(src);
    const fn = await getTranslator();
    if (!fn) throw new Error('실리태번 기본 번역 확장(Chat Translation)이 필요합니다.');
    const provider = extension_settings.translate?.provider || 'google';
    const out = await fn(src, 'ko', provider);
    if (typeof out !== 'string' || !out.trim()) throw new Error('번역 실패');
    if (_trCache.size > 2000) _trCache.clear();
    _trCache.set(src, out);
    return out;
}

// ==================================================================
// Settings panel
// ==================================================================

function fillWorldSelect($sel, selectedId, { allowNone = false } = {}) {
    $sel.empty();
    if (allowNone) $sel.append('<option value="">— 연결 안 함 —</option>');
    for (const w of getWorlds()) {
        const n = (w.nodes || []).length;
        $sel.append(`<option value="${esc(w.id)}">${esc(w.name)} · ${n}시점</option>`);
    }
    $sel.val(selectedId || '');
    if (!$sel.val() && !allowNone && getWorlds().length) $sel.val(getWorlds()[0].id);
}

function refreshAiPanel() {
    const ai = getSettings().ai;
    $('#chronicle_ai_mode').val(ai.mode);

    const $p = $('#chronicle_ai_profile').empty();
    const profiles = getProfiles();
    $p.append('<option value="">— 프로필 선택 —</option>');
    for (const pr of profiles) $p.append(`<option value="${esc(pr.id)}">${esc(pr.name)}</option>`);
    $p.val(ai.profileId || '');
    $('#chronicle_ai_profile_empty').toggle(!profiles.length);

    $('#chronicle_ai_source').val(ai.source);
    $('#chronicle_ai_model').val(ai.model);
    $('#chronicle_ai_custom_url').val(ai.customUrl);
    $('#chronicle_ai_vertex_auth').val(ai.vertexAuth);
    $('#chronicle_ai_vertex_region').val(ai.vertexRegion);
    $('#chronicle_ai_zai_endpoint').val(ai.zaiEndpoint);
    $('#chronicle_ai_maxtokens').val(ai.maxTokens);
    $('#chronicle_ai_chunk').val(ai.chunkChars);
    $('#chronicle_ai_system').val(ai.systemPrompt);

    const src = AI_SOURCES[ai.source] ? ai.source : 'openai';
    const key = AI_SOURCES[src].secret(ai);
    const $k = $('#chronicle_ai_secret').empty();
    $k.append('<option value="">실리태번에서 현재 활성인 키</option>');
    for (const sec of secretsFor(key)) {
        $k.append(`<option value="${esc(sec.id)}">${esc(sec.label || sec.id)}${sec.active ? ' (활성)' : ''}</option>`);
    }
    $k.val(ai.secretId || '');
    if ($k.val() === null) $k.val('');

    $('#chronicle_ai_pane_profile').toggle(ai.mode === 'profile');
    $('#chronicle_ai_pane_direct').toggle(ai.mode === 'direct');
    $('#chronicle_ai_row_custom').toggle(src === 'custom');
    $('#chronicle_ai_row_vertex').toggle(src === 'vertexai');
    $('#chronicle_ai_row_zai').toggle(src === 'zai');
    $('#chronicle_ai_vertex_note').toggle(src === 'vertexai' && ai.vertexAuth === 'full');
}

function refreshPanel() {
    const s = getSettings();
    const conf = getChatConf();

    $('#chronicle_enabled').prop('checked', !!s.enabled);
    fillWorldSelect($('#chronicle_world_select'), s.activeWorldId);
    refreshWorldOpts();
    fillWorldSelect($('#chronicle_chat_world'), conf.worldId, { allowNone: true });
    $('#chronicle_now_display')
        .text(conf.now ? formatDate(conf.now) : '제한 없음')
        .toggleClass('chr-set', !!conf.now);

    $('#chronicle_budget').val(s.tokenBudget);
    $('#chronicle_recency').val(s.recencyWeight);
    $('#chronicle_recency_val').text(s.recencyWeight);
    $('#chronicle_constbonus').val(s.constantBonus);
    $('#chronicle_constbonus_val').text(s.constantBonus);
    $('#chronicle_keybonus').val(s.keywordBonus);
    $('#chronicle_keybonus_val').text(s.keywordBonus);
    $('#chronicle_scandepth').val(s.scanDepth);

    $('#chronicle_position').val(s.position);
    $('#chronicle_depth').val(s.depth);
    $('#chronicle_role').val(String(s.role));
    $('#chronicle_replacedmode').val(s.replacedMode);
    $('#chronicle_castmode').val(s.castMode);
    $('#chronicle_compress').prop('checked', !!s.compressOld);
    $('#chronicle_compresskeep').val(s.compressKeep);
    $('#chronicle_castbonus').val(s.castBonus);
    $('#chronicle_castbonus_val').text(s.castBonus);
    $('#chronicle_header').val(s.header);
    $('#chronicle_debug').prop('checked', !!s.debug);

    refreshAiPanel();
}

function refreshWorldOpts() {
    const w = getEditingWorld();
    const s = getSettings();
    $('#chronicle_world_opts').toggle(!!w);
    if (!w) return;
    $('#chronicle_world_compress').val(w.compressMode || 'global');
    $('#chronicle_world_keep').val(w.compressKeep ?? '').attr('placeholder', `기본 ${s.compressKeep}`);
    const eff = compressOpts(w);
    $('#chronicle_world_keep_row').toggle(w.compressMode !== 'off');
    $('#chronicle_world_compress_eff').text(eff.on ? `지금: 켜짐 · 최근 ${eff.keep}개 시점 전문` : '지금: 꺼짐 · 전부 전문');
}

function renderStatus(packet) {
    const $el = $('#chronicle_status');
    if (!$el.length) return;
    $el.removeClass('chr-status-warn');
    if (!getSettings().enabled) { $el.text('OFF — 아무것도 주입하지 않습니다.'); return; }
    if (!packet || !packet.world) { $el.text('이 채팅에 연결된 세계관이 없습니다.'); return; }
    const parts = [`삽입 ${packet.used.length} · ${packet.tokens} 토큰`];
    if (packet.excluded) parts.push(`미래 차단 ${packet.excluded}`);
    if (packet.replaced) parts.push(packet.replacedMode === 'drop' ? `대체로 제외 ${packet.replaced}` : `과거 기록 ${packet.replaced}`);
    if (packet.castOut) parts.push(`등장 인물 외 제외 ${packet.castOut}`);
    if (packet.compressed) parts.push(`줄여 넣음 ${packet.compressed}`);
    if (packet.dropped?.length) parts.push(`예산 초과 ${packet.dropped.length}`);
    let text = parts.join('  |  ');
    const budget = Number(getSettings().tokenBudget || 0);
    if (packet.pinnedTokens > budget) {
        text += `\n⚠ 핀(항상) 글만 약 ${packet.pinnedTokens} 토큰으로 예산 ${budget}을 넘습니다. 예산을 올리거나 핀을 줄이세요.`;
        $el.addClass('chr-status-warn');
    }
    $el.text(text);
}

async function importFile(file) {
    const text = await getFileText(file);
    const baseName = file.name.replace(/\.(json|txt|md)$/i, '');
    const trimmed = text.trim();
    if (/\.json$/i.test(file.name) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const data = JSON.parse(text);
        const w = createWorld(data.name || baseName);
        if (Array.isArray(data.nodes)) {
            w.nodes = data.nodes.map(normalizeNode);
            w.compressMode = data.compressMode;
            w.compressKeep = data.compressKeep;
            normalizeWorldOpts(w);
        } else if (Array.isArray(data.entries) || Array.isArray(data)) {
            w.entries = Array.isArray(data) ? data : data.entries;
            migrateWorld(w);
        } else {
            getSettings().worlds = getWorlds().filter(x => x.id !== w.id);
            throw new Error('nodes 또는 entries 를 찾을 수 없습니다.');
        }
        return w;
    }
    const nodes = parseText(text);
    if (!nodes.length) {
        throw new Error('텍스트에서 [날짜] 형식의 시점을 찾지 못했습니다. 형식이 자유로운 글은 [AI로 연대기 만들기]를 써 주세요.');
    }
    const titleM = text.match(/^#\s*크로니클\s*[:：]\s*(.+)$/m);
    const w = createWorld((titleM?.[1] || baseName).trim());
    w.nodes = nodes;
    return w;
}

function bindPanel() {
    $('#chronicle_enabled').on('change', function () {
        getSettings().enabled = !!$(this).prop('checked');
        saveSettings(); updateInjection();
    });

    // ---- worlds ----
    $('#chronicle_world_select').on('change', function () {
        getSettings().activeWorldId = String($(this).val() || '') || null;
        saveSettings();
        refreshWorldOpts();
    });
    $('#chronicle_world_compress').on('change', function () {
        const w = getEditingWorld();
        if (!w) return;
        w.compressMode = String($(this).val());
        saveSettings(); refreshWorldOpts(); updateInjection();
    });
    $('#chronicle_world_keep').on('input', function () {
        const w = getEditingWorld();
        if (!w) return;
        const v = String($(this).val()).trim();
        const n = Number(v);
        w.compressKeep = v && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
        saveSoon(); updateSoon();
        $('#chronicle_world_compress_eff').text((() => { const e = compressOpts(w); return e.on ? `지금: 켜짐 · 최근 ${e.keep}개 시점 전문` : '지금: 꺼짐 · 전부 전문'; })());
    });

    $('#chronicle_world_new').on('click', async () => {
        const name = await callGenericPopup('새 세계관 이름', POPUP_TYPE.INPUT, '', { okButton: '만들기' });
        if (name === null || name === false) return;
        const w = createWorld(String(name).trim() || '새 세계관');
        refreshPanel();
        toast('success', `'${w.name}' 을(를) 만들었습니다.`);
    });

    $('#chronicle_world_rename').on('click', async () => {
        const w = getEditingWorld();
        if (!w) return toast('warning', '먼저 세계관을 만들어 주세요.');
        const name = await callGenericPopup('새 이름', POPUP_TYPE.INPUT, w.name, { okButton: '변경' });
        if (name === null || name === false) return;
        w.name = String(name).trim() || w.name;
        saveSettings(); refreshPanel();
    });

    $('#chronicle_world_dup').on('click', () => {
        const w = getEditingWorld();
        if (!w) return toast('warning', '복제할 세계관이 없습니다.');
        const copy = structuredClone(w);
        copy.id = uid();
        copy.name = w.name + ' (복사본)';
        copy.nodes = (copy.nodes || []).map(n => ({
            ...n, id: uid(), blocks: (n.blocks || []).map(b => ({ ...b, id: uid() })),
        }));
        getWorlds().push(copy);
        getSettings().activeWorldId = copy.id;
        saveSettings(); refreshPanel();
        toast('success', `'${copy.name}' 을(를) 만들었습니다.`);
    });

    $('#chronicle_world_del').on('click', async () => {
        const w = getEditingWorld();
        if (!w) return;
        const ok = await callGenericPopup(
            `'${w.name}' 세계관과 시점 ${(w.nodes || []).length}개를 모두 삭제합니다.\n되돌릴 수 없습니다. 계속할까요?`,
            POPUP_TYPE.CONFIRM);
        if (!ok) return;
        const s = getSettings();
        s.worlds = s.worlds.filter(x => x.id !== w.id);
        if (s.activeWorldId === w.id) s.activeWorldId = s.worlds[0]?.id ?? null;
        if (getChatConf().worldId === w.id) setChatConf({ worldId: null });
        saveSettings(); refreshPanel(); updateInjection();
    });

    // ---- export / import ----
    $('#chronicle_export').on('click', async () => {
        const w = getEditingWorld();
        if (!w) return toast('warning', '내보낼 세계관이 없습니다.');
        const choice = await callGenericPopup(
            `'${w.name}' 을(를) 어떤 형식으로 내보낼까요?\n\n· JSON — 백업용. 다시 불러오기에 가장 정확합니다.\n· 텍스트 — 메모장으로 읽고 고치기 좋습니다. 고친 뒤 다시 불러올 수 있습니다.`,
            POPUP_TYPE.CONFIRM, '', { okButton: 'JSON', cancelButton: '텍스트' });
        if (choice === null || choice === undefined) return;
        const safe = w.name.replace(/[\\/:*?"<>|]/g, '_');
        if (choice) {
            const payload = { chronicle: STORE_VERSION, name: w.name, compressMode: w.compressMode, compressKeep: w.compressKeep, nodes: (w.nodes || []).map(normalizeNode) };
            download(JSON.stringify(payload, null, 2), `chronicle-${safe}.json`, 'application/json');
        } else {
            download(exportText(w), `chronicle-${safe}.txt`, 'text/plain');
        }
    });

    $('#chronicle_import').on('click', () => $('#chronicle_import_file').trigger('click'));

    $('#chronicle_import_file').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            const w = await importFile(file);
            saveSettings(); refreshPanel();
            toast('success', `'${w.name}' — 시점 ${w.nodes.length}개를 불러왔습니다.`);
        } catch (e) {
            warn(e);
            toast('error', '불러오기 실패: ' + errMsg(e));
        }
    });

    $('#chronicle_open_editor').on('click', () => openEditor());
    $('#chronicle_open_ai').on('click', () => openAiGenerator());

    // ---- this chat ----
    $('#chronicle_chat_world').on('change', function () {
        setChatConf({ worldId: String($(this).val() || '') || null });
        updateInjection();
    });

    $('#chronicle_now_clear').on('click', () => {
        setChatConf({ now: '' });
        refreshPanel();
        updateInjection();
    });

    $('#chronicle_preview').on('click', () => openPreview());

    // tabs
    $('#chronicle_settings').on('click', '.chr-tab', function () {
        const tab = String($(this).data('tab'));
        const $root = $('#chronicle_settings');
        $root.find('.chr-tab').removeClass('chr-active');
        $(this).addClass('chr-active');
        $root.find('.chr-pane').removeClass('chr-active');
        $root.find(`.chr-pane[data-pane="${tab}"]`).addClass('chr-active');
        if (tab === 'ai') refreshAiPanel();
    });

    $('#chronicle_header_reset').on('click', () => {
        getSettings().header = DEFAULT_HEADER;
        saveSettings(); refreshPanel(); updateInjection();
        toast('success', '지시문을 기본 영문으로 되돌렸습니다.');
    });

    // ---- advanced ----
    for (const [sel, key] of Object.entries({
        '#chronicle_budget': 'tokenBudget',
        '#chronicle_scandepth': 'scanDepth',
        '#chronicle_depth': 'depth',
    })) {
        $(sel).on('input', function () {
            const n = Number($(this).val());
            if (!Number.isFinite(n)) return;
            getSettings()[key] = n; saveSoon(); updateSoon();
        });
    }

    for (const [sel, [key, label]] of Object.entries({
        '#chronicle_recency': ['recencyWeight', '#chronicle_recency_val'],
        '#chronicle_constbonus': ['constantBonus', '#chronicle_constbonus_val'],
        '#chronicle_keybonus': ['keywordBonus', '#chronicle_keybonus_val'],
    })) {
        $(sel).on('input', function () {
            const n = Number($(this).val());
            getSettings()[key] = n; $(label).text(n); saveSoon(); updateSoon();
        });
    }

    $('#chronicle_position').on('change', function () {
        getSettings().position = String($(this).val()); saveSettings(); updateInjection();
    });
    $('#chronicle_role').on('change', function () {
        getSettings().role = Number($(this).val()); saveSettings(); updateInjection();
    });
    $('#chronicle_replacedmode').on('change', function () {
        getSettings().replacedMode = String($(this).val()); saveSettings(); updateInjection();
    });
    $('#chronicle_compress').on('change', function () {
        getSettings().compressOld = !!$(this).prop('checked'); saveSettings(); refreshWorldOpts(); updateInjection();
    });
    $('#chronicle_compresskeep').on('input', function () {
        const n = Number($(this).val());
        if (Number.isFinite(n) && n >= 1) { getSettings().compressKeep = n; saveSoon(); updateSoon(); refreshWorldOpts(); }
    });
    $('#chronicle_castmode').on('change', function () {
        getSettings().castMode = String($(this).val()); saveSettings(); updateInjection();
    });
    $('#chronicle_castbonus').on('input', function () {
        const n = Number($(this).val());
        getSettings().castBonus = n; $('#chronicle_castbonus_val').text(n); saveSoon(); updateSoon();
    });
    $('#chronicle_header').on('input', function () {
        getSettings().header = String($(this).val()); saveSoon(); updateSoon();
    });
    $('#chronicle_debug').on('change', function () {
        getSettings().debug = !!$(this).prop('checked'); saveSettings();
    });

    $('#chronicle_reset').on('click', async () => {
        const ok = await callGenericPopup('고급 설정만 기본값으로 되돌립니다. (세계관과 시점, AI 설정은 그대로)', POPUP_TYPE.CONFIRM);
        if (!ok) return;
        const s = getSettings();
        for (const k of ADVANCED_KEYS) s[k] = structuredClone(DEFAULT_SETTINGS[k]);
        saveSettings(); refreshPanel(); updateInjection();
    });

    // ---- AI connection ----
    const aiSet = (key, val) => { getSettings().ai[key] = val; saveSoon(); };
    $('#chronicle_ai_mode').on('change', function () { aiSet('mode', String($(this).val())); refreshAiPanel(); });
    $('#chronicle_ai_profile').on('change', function () { aiSet('profileId', String($(this).val() || '')); });
    $('#chronicle_ai_source').on('change', function () { aiSet('source', String($(this).val())); aiSet('secretId', ''); refreshAiPanel(); });
    $('#chronicle_ai_secret').on('change', function () { aiSet('secretId', String($(this).val() || '')); });
    $('#chronicle_ai_model').on('input', function () { aiSet('model', String($(this).val()).trim()); });
    $('#chronicle_ai_custom_url').on('input', function () { aiSet('customUrl', String($(this).val()).trim()); });
    $('#chronicle_ai_vertex_auth').on('change', function () { aiSet('vertexAuth', String($(this).val())); aiSet('secretId', ''); refreshAiPanel(); });
    $('#chronicle_ai_vertex_region').on('input', function () { aiSet('vertexRegion', String($(this).val()).trim()); });
    $('#chronicle_ai_zai_endpoint').on('change', function () { aiSet('zaiEndpoint', String($(this).val())); });
    $('#chronicle_ai_maxtokens').on('input', function () { const n = Number($(this).val()); if (Number.isFinite(n)) aiSet('maxTokens', n); });
    $('#chronicle_ai_chunk').on('input', function () { const n = Number($(this).val()); if (Number.isFinite(n)) aiSet('chunkChars', n); });
    $('#chronicle_ai_system').on('input', function () { aiSet('systemPrompt', String($(this).val())); });
    $('#chronicle_ai_system_reset').on('click', () => {
        aiSet('systemPrompt', DEFAULT_AI_SYSTEM); refreshAiPanel();
        toast('success', '기본 지시를 되돌렸습니다.');
    });
    $('#chronicle_ai_refresh').on('click', () => { refreshAiPanel(); toast('info', '프로필과 키 목록을 다시 읽었습니다.'); });

    $('#chronicle_ai_test').on('click', async function () {
        const $b = $(this);
        if ($b.hasClass('chr-busy')) return;
        $b.addClass('chr-busy');
        const $out = $('#chronicle_ai_test_result').text('연결 확인 중…').removeClass('chr-ok chr-bad');
        try {
            const text = await callModel('Reply with exactly: OK', 'Connection test. Reply with exactly: OK');
            $out.text(`연결됨 — 응답: ${String(text).trim().slice(0, 60) || '(빈 응답)'}`).addClass('chr-ok');
        } catch (e) {
            $out.text(`실패: ${errMsg(e)}`).addClass('chr-bad');
        } finally {
            $b.removeClass('chr-busy');
        }
    });
}

// ==================================================================
// Preview
// ==================================================================

async function openPreview() {
    const packet = await buildPacket();
    const s = getSettings();

    if (!packet.world) {
        await callGenericPopup('이 채팅에 연결된 세계관이 없습니다.\n"이 채팅 → 세계관" 에서 골라주세요.', POPUP_TYPE.TEXT);
        return;
    }

    const stat = (k, v) => `<span class="chr-stat"><b>${k}</b>${esc(String(v))}</span>`;
    const over = packet.pinnedTokens > Number(s.tokenBudget || 0);
    const el = document.createElement('div');
    el.className = 'chr-preview';
    el.innerHTML = `
        <div class="chr-preview-stats">
            ${stat('세계관', packet.world.name)}
            ${stat('기준 시점', packet.now || '제한 없음')}
            ${stat('삽입', packet.used.length + '개')}
            ${stat('토큰', `${packet.tokens} / ${s.tokenBudget}`)}
            ${stat('미래 차단', packet.excluded + '개')}
            ${packet.replaced ? stat(packet.replacedMode === 'drop' ? '대체로 제외' : '과거 기록', packet.replaced + '개') : ''}
            ${getSettings().castMode !== 'off' ? stat('등장 인물', packet.cast.length ? packet.cast.slice(0, 8).join(', ') + (packet.cast.length > 8 ? ` 외 ${packet.cast.length - 8}명` : '') : '없음') : ''}
            ${packet.castOut ? stat('등장 인물 외 제외', packet.castOut + '개') : ''}
            ${packet.compressed ? stat('줄여 넣음', packet.compressed + '개') : ''}
        </div>
        ${over ? `<div class="chr-warnbar"><i class="fa-solid fa-triangle-exclamation"></i>핀(항상) 글만 약 ${packet.pinnedTokens} 토큰으로 예산을 넘습니다.</div>` : ''}
        <div class="chr-preview-tools">
            <div class="menu_button chr-tr-btn" data-act="tr"><i class="fa-solid fa-language"></i> 한국어로 보기</div>
            <small class="chr-hint">보기 전용 번역입니다. 프롬프트에는 원문이 그대로 들어갑니다.</small>
        </div>
        <div class="chr-preview-body">${esc(packet.text) || '(주입할 내용이 없습니다)'}</div>
        <div class="chr-preview-body chr-preview-tr" hidden></div>
        ${packet.dropped?.length ? `<div class="chr-dropped"><b>토큰 부족으로 제외 (${packet.dropped.length}개)</b><br>` +
            packet.dropped.sort((a, b) => b.score - a.score).map(p =>
                `· [${esc(formatDate(p.node.date))}] ${esc(BLOCK_TYPES[p.block.type].ko)}` +
                `${p.block.name ? ' · ' + esc(p.block.name) : ''} — 점수 ${Math.round(p.score)}`).join('<br>') +
            '</div>' : ''}
        ${packet.replacedList?.length ? (() => {
            const drop = packet.replacedMode === 'drop';
            const usedIds = new Set(packet.used.map(p => p.block.id));
            const rows = [...packet.replacedList].sort((a, b) => a.key - b.key).map(r => {
                const state = drop ? '제외됨' : (usedIds.has(r.block.id) ? '과거 기록으로 들어감' : '조건·예산 때문에 빠짐');
                return `· [${esc(formatDate(r.node.date))}] ${esc(BLOCK_TYPES[r.block.type].ko)} · ${esc(r.block.name)} → ${esc(r.by)} 칸으로 대체 <span class="chr-dim">(${state})</span>`;
            });
            return `<div class="chr-dropped chr-replaced"><b>${drop ? '대체되어 제외된 칸' : '대체되어 과거 기록으로 표시된 칸'} (${rows.length}개)</b><br>${rows.join('<br>')}</div>`;
        })() : ''}`;

    const $el = $(el);
    let trDone = false, showingTr = false;
    $el.find('[data-act="tr"]').on('click', async function () {
        const $orig = $el.find('.chr-preview-body').not('.chr-preview-tr');
        const $tr = $el.find('.chr-preview-tr');
        if (showingTr) {
            showingTr = false; $tr.attr('hidden', true); $orig.removeAttr('hidden');
            $(this).html('<i class="fa-solid fa-language"></i> 한국어로 보기');
            return;
        }
        if (!packet.text) return;
        showingTr = true; $orig.attr('hidden', true); $tr.removeAttr('hidden');
        $(this).html('<i class="fa-solid fa-language"></i> 원문 보기');
        if (trDone) return;
        // translate section by section so long chronicles don't hit translator limits
        const sections = packet.text.split(/\n\n/);
        const out = [];
        $tr.text('번역 중…');
        try {
            for (const sec of sections) {
                const t = await translateForView(sec);
                out.push(t ?? sec);
                $tr.text(out.join('\n\n') + (out.length < sections.length ? '\n\n…' : ''));
            }
            trDone = true;
        } catch (e) {
            $tr.text(`번역하지 못했습니다: ${errMsg(e)}`);
        }
    });

    await showPopup(el, 'chr-x-preview');
}

// ==================================================================
// AI generator popup
// ==================================================================

async function openAiGenerator() {
    const ai = getSettings().ai;
    const modeName = { current: '지금 연결된 API', profile: '연결 프로필', direct: '직접 선택' }[ai.mode] || ai.mode;
    const profName = ai.mode === 'profile' ? (getProfiles().find(p => p.id === ai.profileId)?.name || '(프로필 미선택)') : '';
    const editing = getEditingWorld();

    const root = document.createElement('div');
    root.className = 'chr-ai';
    root.innerHTML = `
        <div class="chr-ai-conn"><i class="fa-solid fa-plug"></i> 사용할 API: <b>${esc(modeName)}${profName ? ' · ' + esc(profName) : ''}</b>
            <small>(바꾸려면 확장 패널 → AI 탭)</small></div>

        <div class="chr-seg" data-name="src">
            <div class="chr-seg-btn chr-active" data-val="text"><i class="fa-solid fa-file-lines"></i> 텍스트 정리</div>
            <div class="chr-seg-btn" data-val="title"><i class="fa-solid fa-book"></i> 작품 이름만</div>
        </div>

        <div class="chr-ai-sec" data-for="text">
            <div class="chr-ai-row">
                <div class="menu_button" data-act="file"><i class="fa-solid fa-file-import"></i> 파일 열기</div>
                <input type="file" accept=".txt,.md,.text" hidden>
                <span class="chr-ai-filename"></span>
            </div>
            <textarea class="text_pole chr-ai-text" rows="7" placeholder="메모, 위키 복사본, 설정집 등 아무 양식이나 붙여 넣으세요."></textarea>
            <small class="chr-hint chr-ai-count"></small>
        </div>

        <div class="chr-ai-sec" data-for="title" hidden>
            <input type="text" class="text_pole chr-ai-title" placeholder="예: 해리포터">
            <small class="chr-hint">웹 검색이 아니라 <b>모델이 원래 아는 지식</b>으로 씁니다. 덜 알려진 작품은 틀린 내용을 지어낼 수 있으니 '텍스트 정리'를 권합니다.</small>
        </div>

        <div class="chr-ai-grid">
            <label>등록 위치</label>
            <div class="chr-seg chr-seg-sm" data-name="target">
                <div class="chr-seg-btn chr-active" data-val="new">새 세계관</div>
                <div class="chr-seg-btn ${editing ? '' : 'chr-disabled'}" data-val="merge">지금 세계관에 합치기</div>
            </div>
            <label class="chr-ai-newname-l">새 세계관 이름</label>
            <input type="text" class="text_pole chr-ai-newname" placeholder="비우면 자동으로 정합니다">
            <label>내용 언어</label>
            <div class="chr-seg chr-seg-sm" data-name="lang">
                <div class="chr-seg-btn chr-active" data-val="ko">한국어</div>
                <div class="chr-seg-btn" data-val="en">English</div>
            </div>
            <label>자세함</label>
            <div class="chr-seg chr-seg-sm" data-name="detail">
                <div class="chr-seg-btn" data-val="brief">간략</div>
                <div class="chr-seg-btn chr-active" data-val="normal">보통</div>
                <div class="chr-seg-btn" data-val="detailed">자세히</div>
            </div>
            <label>키워드 언어</label>
            <div class="chr-seg chr-seg-sm chr-multi" data-name="keyLangs" title="여러 개 고를 수 있습니다">
                ${Object.entries({ ko: '한국어', en: 'English', ja: '日本語', zh: '中文' }).map(([v, l]) =>
                    `<div class="chr-seg-btn ${ai.keyLangs.includes(v) ? 'chr-active' : ''}" data-val="${v}">${l}</div>`).join('')}
            </div>
        </div>
        <small class="chr-hint">키워드 언어는 여러 개 고를 수 있습니다. 고른 언어마다 이름·용어를 키워드로 넣습니다. 하나도 안 고르면 내용 언어와 원어를 함께 넣습니다.</small>
        ${editing ? `<small class="chr-hint chr-ai-mergehint" hidden>'${esc(editing.name)}' 에 합칩니다. 같은 시점·같은 인물(관계) 칸은 새 내용으로 덮어씁니다.</small>` : ''}

        <label class="chr-ai-label">추가 요구 <small>(선택)</small></label>
        <textarea class="text_pole chr-ai-extra" rows="2" placeholder="예: 세계 전체를 관할하는 작가 시점으로 / 인물 위주로 자세히 / 3권까지만"></textarea>

        <div class="chr-ai-actions">
            <div class="menu_button chr-primary" data-act="run"><i class="fa-solid fa-wand-magic-sparkles"></i> 만들기</div>
            <div class="menu_button" data-act="stop" hidden><i class="fa-solid fa-stop"></i> 중지</div>
        </div>
        <div class="chr-ai-progress" hidden><div class="chr-ai-bar"></div></div>
        <pre class="chr-ai-log" hidden></pre>

        <div class="chr-ai-result" hidden>
            <div class="chr-ai-result-head">
                <b class="chr-ai-summary"></b>
                <div class="chr-ai-row">
                    <div class="menu_button" data-act="tr"><i class="fa-solid fa-language"></i> 한국어로 보기</div>
                    <div class="menu_button chr-primary" data-act="save"><i class="fa-solid fa-floppy-disk"></i> 등록하기</div>
                </div>
            </div>
            <small class="chr-hint">체크를 끈 시점은 등록하지 않습니다. 등록한 뒤에도 타임라인 편집기에서 고칠 수 있습니다.</small>
            <div class="chr-ai-list"></div>
        </div>`;

    const $r = $(root);
    const state = { src: 'text', target: 'new', lang: 'ko', detail: 'normal' };
    let result = null;
    let showTr = false;
    const ui = { cancelled: false, signal: null, controller: null };

    const $log = $r.find('.chr-ai-log');
    ui.log = (msg) => { $log.removeAttr('hidden'); $log.text(($log.text() ? $log.text() + '\n' : '') + msg); $log.scrollTop(1e9); };
    ui.progress = (i, n) => { $r.find('.chr-ai-progress').removeAttr('hidden'); $r.find('.chr-ai-bar').css('width', `${Math.round((i / Math.max(1, n)) * 100)}%`); };

    $r.on('click', '.chr-seg-btn', function () {
        if ($(this).hasClass('chr-disabled')) return;
        const $seg = $(this).closest('.chr-seg');
        if ($seg.hasClass('chr-multi')) {
            $(this).toggleClass('chr-active');
            const langs = $seg.find('.chr-seg-btn.chr-active').map((_, el) => el.dataset.val).get();
            getSettings().ai.keyLangs = langs; // remembered for next time
            saveSoon();
            return;
        }
        $seg.find('.chr-seg-btn').removeClass('chr-active');
        $(this).addClass('chr-active');
        state[$seg.data('name')] = String($(this).data('val'));
        $r.find('.chr-ai-sec').attr('hidden', true);
        $r.find(`.chr-ai-sec[data-for="${state.src}"]`).removeAttr('hidden');
        $r.find('.chr-ai-newname, .chr-ai-newname-l').toggle(state.target === 'new');
        $r.find('.chr-ai-mergehint').attr('hidden', state.target !== 'merge');
        if (result) renderResult();
    });

    const updateCount = () => {
        const n = String($r.find('.chr-ai-text').val() || '').length;
        const chunk = clamp(Number(getSettings().ai.chunkChars) || 12000, 2000, 200000);
        $r.find('.chr-ai-count').text(n ? `${n.toLocaleString()}자 · 약 ${Math.max(1, Math.ceil(n / chunk))}번 나눠서 요청` : '');
    };
    $r.find('.chr-ai-text').on('input', updateCount);
    $r.find('[data-act="file"]').on('click', () => $r.find('input[type="file"]').trigger('click'));
    $r.find('input[type="file"]').on('change', async function () {
        const f = this.files?.[0];
        this.value = '';
        if (!f) return;
        try {
            const t = await getFileText(f);
            $r.find('.chr-ai-text').val(t);
            $r.find('.chr-ai-filename').text(f.name);
            if (!$r.find('.chr-ai-newname').val()) $r.find('.chr-ai-newname').val(f.name.replace(/\.(txt|md|text)$/i, ''));
            updateCount();
        } catch (e) { toast('error', '파일을 읽지 못했습니다: ' + errMsg(e)); }
    });

    /** Plan preview statuses against the target without touching it */
    const plan = () => {
        const target = state.target === 'merge' && editing ? structuredClone(editing.nodes || []) : [];
        const clone = structuredClone(result.nodes);
        mergeNodes(target, clone);
        return clone;
    };

    const renderResult = () => {
        const planned = plan();
        const total = planned.reduce((a, n) => a + n.blocks.length, 0);
        const ow = planned.reduce((a, n) => a + n.blocks.filter(b => b._status === 'overwrite').length, 0);
        $r.find('.chr-ai-summary').text(`시점 ${planned.length}개 · 칸 ${total}개${ow ? ` · 덮어쓸 칸 ${ow}개` : ''}` +
            (result.failed.length ? ` · 실패 ${result.failed.length}부분` : ''));
        const badge = { new: ['새 시점', 'new'], add: ['추가', 'add'], overwrite: ['덮어씀', 'ow'] };
        const html = planned.map((n, i) => `
            <div class="chr-ai-node" data-idx="${i}">
                <label class="chr-ai-node-head">
                    <input type="checkbox" ${result.skip.has(i) ? '' : 'checked'}>
                    <b>${esc(formatDate(n.date))}</b>
                    <span class="chr-count">${n.blocks.length}칸</span>
                </label>
                ${n.blocks.map(b => {
                    const t = BLOCK_TYPES[b.type];
                    const [bl, bc] = badge[b._status] || badge.new;
                    const flags = [b.constant ? '<i class="fa-solid fa-thumbtack" title="항상"></i>' : `<i class="fa-solid fa-key" title="키워드: ${esc(b.keys.join(', '))}"></i>`,
                        b.secret ? `<i class="fa-solid fa-user-secret" title="비밀${b.knownBy ? ' — ' + esc(b.knownBy) : ''}"></i>` : '',
                        b.replaces ? '<i class="fa-solid fa-arrows-rotate" title="이전 칸 대체"></i>' : ''].join('');
                    return `<div class="chr-ai-item" data-type="${b.type}">
                        <span class="chr-ai-type">${t.ko}${b.name ? ' · ' + esc(b.name) : ''}</span>
                        <span class="chr-ai-flags">${flags}</span>
                        <span class="chr-ai-badge chr-ai-badge--${bc}">${bl}</span>
                        <div class="chr-ai-content" data-src="${esc(b.content)}">${esc(b.content)}</div>
                        ${showTr ? '<div class="chr-tr">번역 중…</div>' : ''}
                    </div>`;
                }).join('')}
            </div>`).join('');
        $r.find('.chr-ai-list').html(html || '<div class="chr-noblocks">만들어진 시점이 없습니다.</div>');
        if (showTr) fillTranslations($r.find('.chr-ai-list'));
    };

    $r.on('change', '.chr-ai-node-head input', function () {
        const i = Number($(this).closest('.chr-ai-node').data('idx'));
        if (this.checked) result.skip.delete(i); else result.skip.add(i);
        $(this).closest('.chr-ai-node').toggleClass('chr-off', !this.checked);
    });

    $r.find('[data-act="tr"]').on('click', function () {
        showTr = !showTr;
        $(this).toggleClass('chr-on', showTr);
        if (result) renderResult();
    });

    $r.find('[data-act="stop"]').on('click', () => {
        ui.cancelled = true;
        try { ui.controller?.abort(); } catch { /* noop */ }
        ui.log('중지 요청됨…');
    });

    $r.find('[data-act="run"]').on('click', async function () {
        const $run = $(this);
        if ($run.hasClass('chr-busy')) return;
        const opts = {
            mode: state.src,
            text: String($r.find('.chr-ai-text').val() || ''),
            title: String($r.find('.chr-ai-title').val() || ''),
            lang: state.lang,
            detail: state.detail,
            keyLangs: [...getSettings().ai.keyLangs],
            extra: String($r.find('.chr-ai-extra').val() || ''),
        };
        if (opts.mode === 'text' && !opts.text.trim()) return toast('warning', '정리할 글을 넣어 주세요.');
        if (opts.mode === 'title' && !opts.title.trim()) return toast('warning', '작품 이름을 넣어 주세요.');

        $run.addClass('chr-busy');
        $r.find('[data-act="stop"]').removeAttr('hidden');
        $r.find('.chr-ai-result').attr('hidden', true);
        $log.text('');
        ui.cancelled = false;
        ui.controller = new AbortController();
        ui.signal = ui.controller.signal;
        try {
            const res = await runGeneration(opts, ui);
            if (!res.nodes.length) throw new Error(ui.cancelled ? '중지되었습니다.' : '정리된 시점이 없습니다.');
            result = { ...res, skip: new Set(), title: opts.title };
            ui.log(`완료 — 시점 ${res.nodes.length}개${res.failed.length ? ` (실패: ${res.failed.join(', ')})` : ''}`);
            renderResult();
            $r.find('.chr-ai-result').removeAttr('hidden');
            $r.find('.chr-ai-result')[0]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        } catch (e) {
            ui.log(`멈춤: ${errMsg(e)}`);
            if (!ui.cancelled) toast('error', errMsg(e));
        } finally {
            $run.removeClass('chr-busy');
            $r.find('[data-act="stop"]').attr('hidden', true);
        }
    });

    $r.find('[data-act="save"]').on('click', async () => {
        if (!result) return;
        const chosen = result.nodes.filter((_, i) => !result.skip.has(i)).map(n => structuredClone(n));
        if (!chosen.length) return toast('warning', '등록할 시점을 하나 이상 체크해 주세요.');
        let world, report;
        if (state.target === 'merge' && editing) {
            world = getWorldById(editing.id);
            if (!world) return toast('error', '합칠 세계관을 찾지 못했습니다.');
            if (!Array.isArray(world.nodes)) world.nodes = [];
            report = mergeNodes(world.nodes, chosen);
        } else {
            const name = String($r.find('.chr-ai-newname').val() || '').trim() || result.title.trim() || 'AI 연대기';
            world = createWorld(name);
            report = mergeNodes(world.nodes, chosen);
        }
        for (const n of world.nodes) for (const b of n.blocks) delete b._status;
        saveSettings(); refreshPanel(); updateInjection();
        toast('success', `'${world.name}' — 새 시점 ${report.newNodes}개, 추가 ${report.added}칸, 덮어씀 ${report.overwritten}칸`);
        result = null;
        $r.find('.chr-ai-result').attr('hidden', true);
        ui.log(`'${world.name}' 에 등록했습니다.`);
    });

    await showPopup(root, 'chr-x-ai');
    ui.cancelled = true;
    try { ui.controller?.abort(); } catch { /* noop */ }
}

/** Open one of our popups and tag it with a class (cheaper than CSS :has()). */
function showPopup(el, cls) {
    const pr = callGenericPopup(el, POPUP_TYPE.TEXT, '', {
        wide: true, large: true, okButton: '닫기', allowVerticalScrolling: true,
    });
    el.closest('.popup')?.classList.add('chr-popup', cls);
    return pr;
}

/** Fill every empty .chr-tr under $scope (sequential, cached). */
async function fillTranslations($scope) {
    const items = $scope.find('.chr-tr').filter(function () { return !this.dataset.done && $(this).is(':visible'); }).get();
    for (const el of items) {
        if (el.dataset.done) continue;
        el.dataset.done = '1';
        const src = el.previousElementSibling?.dataset?.src
            ?? el.closest('.chr-block')?.querySelector('.chr-content')?.value
            ?? '';
        try {
            const t = await translateForView(src);
            if (t === null) { el.remove(); continue; }
            el.textContent = t;
        } catch (e) {
            el.textContent = `번역 실패: ${errMsg(e)}`;
            el.classList.add('chr-tr-bad');
            break;
        }
    }
}

// ==================================================================
// Timeline editor
// ==================================================================

let _search = '';
let _showTr = false;
/** Deleted nodes / entries that can be restored (newest last) */
const _undo = [];
const UNDO_MAX = 30;
/** Entries translated one by one (shown even when "번역 보기" is off) */
const _trBlocks = new Set();

function flashNode($nodes, nodeId) {
    ensureNodeRendered($nodes, nodeId);
    const el = $nodes.find(`[data-node="${nodeId}"]`)[0];
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('chr-flash');
    void el.offsetWidth;
    el.classList.add('chr-flash');
    setTimeout(() => el.classList.remove('chr-flash'), 2400);
}

async function openEditor() {
    let world = getEditingWorld();
    if (!world) {
        const ok = await callGenericPopup('세계관이 아직 없습니다. 지금 하나 만들까요?', POPUP_TYPE.CONFIRM);
        if (!ok) return;
        world = createWorld('내 세계관');
        refreshPanel();
    }
    world.nodes = (Array.isArray(world.nodes) ? world.nodes : []).map(normalizeNode);

    const root = document.createElement('div');
    root.className = 'chr-editor';
    root.innerHTML = `
        <div class="chr-toolbar">
            <div class="menu_button" data-act="add-node"><i class="fa-solid fa-plus"></i> 시점 추가</div>
            <div class="menu_button" data-act="tr" title="영어·외국어 내용을 한국어로 보여줍니다 (보기 전용)"><i class="fa-solid fa-language"></i> 번역 보기</div>
            <div class="menu_button chr-undo" data-act="undo" title="방금 지운 시점이나 칸을 되살립니다"><i class="fa-solid fa-rotate-left"></i> 되돌리기 <span class="chr-undo-n"></span></div>
            <input type="text" class="text_pole chr-search" placeholder="시점·이름·내용·키워드 검색">
            <span class="chr-nowtag"></span>
            <div class="menu_button" data-act="clear-now" title="기준 시점 해제 (전부 체크)"><i class="fa-solid fa-xmark"></i> 기준 해제</div>
            <span class="chr-count"></span>
        </div>
        <div class="chr-hintbar">
            <i class="fa-solid fa-circle-info"></i>
            <span>왼쪽 <b>체크박스</b>를 누르면 그 시점이 <b>기준 시점</b>이 되고, 맨 위부터 거기까지 자동으로 체크됩니다. 체크 안 된 시점은 프롬프트에 들어가지 않습니다.</span>
        </div>
        <div class="chr-nodes"></div>`;

    const $root = $(root);
    const $nodes = $root.find('.chr-nodes');
    const refreshUndo = () => {
        const n = _undo.filter(u => u.worldId === world.id).length;
        $root.find('[data-act="undo"]').toggleClass('chr-disabled', !n).find('.chr-undo-n').text(n ? `(${n})` : '');
    };
    const render = () => { renderNodes($nodes, world); refreshUndo(); if (_showTr || _trBlocks.size) fillTranslations($nodes); };

    $root.find('[data-act="undo"]').on('click', () => {
        const i = _undo.map(u => u.worldId).lastIndexOf(world.id);
        if (i < 0) return;
        const [u] = _undo.splice(i, 1);
        let restoredId = null;
        if (u.kind === 'node') {
            world.nodes.splice(Math.min(u.index, world.nodes.length), 0, u.node);
            restoredId = u.node.id;
            toast('success', `[${formatDate(u.node.date) || '시점 없음'}] 시점을 되살렸습니다.`);
        } else {
            const node = findNode(world, u.nodeId);
            if (!node) {
                toast('warning', '이 칸이 있던 시점이 지워져 있습니다. 시점을 먼저 되돌려 주세요.');
                _undo.splice(i, 0, u);
                return;
            }
            node.blocks.splice(Math.min(u.index, node.blocks.length), 0, u.block);
            _openGroups.add(groupKey(node.id, u.block.type));
            restoredId = node.id;
            toast('success', '칸을 되살렸습니다.');
        }
        saveSettings(); render(); updateSoon();
        if (restoredId) flashNode($nodes, restoredId);
    });

    $root.find('[data-act="tr"]').toggleClass('chr-on', _showTr).on('click', function () {
        _showTr = !_showTr;
        $(this).toggleClass('chr-on', _showTr);
        render();
    });

    const renderSearch = debounce(() => render(), 220);
    $root.find('.chr-search').val(_search).on('input', function () {
        _search = String($(this).val()).toLowerCase();
        renderSearch();
    });

    $root.find('[data-act="clear-now"]').on('click', () => {
        setChatConf({ now: '' });
        render(); refreshPanel(); updateInjection();
    });

    $root.find('[data-act="add-node"]').on('click', () => {
        const conf = getChatConf();
        const node = makeNode(conf.now || '');
        world.nodes.push(node);
        saveSettings();
        render();
        flashNode($nodes, node.id);
        const dateEl = $nodes.find(`[data-node="${node.id}"] .chr-date`)[0];
        dateEl?.focus();
        dateEl?.select?.();
    });

    bindEditorEvents($nodes, world, render);
    render();

    const closed = showPopup(root, 'chr-x-editor');
    bindChunkScroll($nodes);
    await closed;

    saveSettings();
    refreshPanel();
    updateInjection();
}

// ---- lookups ----

function findNode(world, nodeId) {
    return (world.nodes || []).find(n => n.id === nodeId) || null;
}

function findBlock(world, nodeId, blockId) {
    const n = findNode(world, nodeId);
    return n ? (n.blocks || []).find(b => b.id === blockId) || null : null;
}

function ctxOf($el) {
    const $b = $el.closest('[data-block]');
    return { nodeId: $el.closest('[data-node]').data('node'), blockId: $b.length ? $b.data('block') : null };
}

/** Update the "키워드 없음 N" chip on a point header without re-rendering it */
function refreshDeadChip($node, node) {
    if (!node || !$node?.length) return;
    const dead = node.enabled === false ? 0 : deadBlocks(node).length;
    const $chip = $node.find('> .chr-node-head .chr-tag-warn');
    if (!dead) { $chip.remove(); return; }
    const html = `<i class="fa-solid fa-triangle-exclamation"></i> 키워드 없음 ${dead}`;
    if ($chip.length) $chip.html(html);
    else $node.find('> .chr-node-head .chr-node-spacer').before(`<span class="chr-node-tag chr-tag-warn" title="키워드가 없어 절대 들어가지 않는 칸이 ${dead}개 있습니다.">${html}</span>`);
}

function pushUndo(entry) {
    _undo.push(entry);
    if (_undo.length > UNDO_MAX) _undo.shift();
}

function hasShortKey(keys) {
    return (keys || []).some(k => !(k.startsWith('/') && k.endsWith('/') && k.length > 2) && [...k].length === 1);
}

// ---- events (delegated) ----

function bindEditorEvents($nodes, world, render) {

    const rerenderBlocks = ($node, node) => {
        $node.find('.chr-blocks').html(renderBlocksHtml(node));
        refreshDeadChip($node, node);
        if (_showTr || _trBlocks.size) fillTranslations($node);
    };

    // current-point checkbox
    $nodes.on('click', '.chr-check', function () {
        const { nodeId } = ctxOf($(this));
        const node = findNode(world, nodeId);
        if (!node) return;
        const span = parseSpan(node.date || '');
        if (!span) {
            toast('warning', '먼저 이 시점의 날짜를 입력해 주세요.');
            return;
        }
        // a period sets the current point to its first day
        const point = formatPoint(span.start);
        const cur = getChatConf().now ? endKey(parseDate(getChatConf().now)) : null;
        const mine = endKey(span.start);
        setChatConf({ now: (cur !== null && cur === mine && !span.range) ? '' : point });
        render(); refreshPanel(); updateInjection();
    });

    $nodes.on('input', '.chr-date', function () {
        const { nodeId } = ctxOf($(this));
        const node = findNode(world, nodeId);
        if (!node) return;
        const v = String($(this).val()).trim();
        node.date = v;
        $(this).toggleClass('chr-invalid', !!v && parseSpan(v) === null);
        saveSoon(); updateSoon();
    });

    $nodes.on('change', '.chr-date', function () {
        const { nodeId } = ctxOf($(this));
        const node = findNode(world, nodeId);
        if (node && node.date && parseSpan(node.date)) {
            node.date = formatDate(node.date);
            $(this).val(node.date).removeClass('chr-invalid');
            saveSoon();
        }
        const before = $nodes.find('[data-node]').map((_, el) => el.dataset.node).get();
        const after = sortNodes(world.nodes.filter(matchesSearch)).map(n => n.id);
        if (before.join() !== after.join()) {
            render();
            flashNode($nodes, nodeId);
        }
    });

    // name / content / keys / priority / known-by — autosave
    $nodes.on('input', '.chr-name, .chr-content, .chr-keys, .chr-pri, .chr-knownby', function () {
        const { nodeId, blockId } = ctxOf($(this));
        const block = findBlock(world, nodeId, blockId);
        if (!block) return;
        const $t = $(this);
        if ($t.hasClass('chr-name')) block.name = String($t.val());
        else if ($t.hasClass('chr-content')) {
            block.content = String($t.val());
            const tr = $t.siblings('.chr-tr')[0];
            if (tr) { tr.dataset.done = ''; tr.textContent = '(내용이 바뀌었습니다. 번역 보기를 다시 켜면 새로 번역합니다)'; }
        }
        else if ($t.hasClass('chr-keys')) {
            block.keys = String($t.val()).split(',').map(k => k.trim()).filter(Boolean);
            $t.toggleClass('chr-warnkey', hasShortKey(block.keys));
            refreshGroupHead($t, findNode(world, nodeId));
            refreshDeadChip($t.closest('[data-node]'), findNode(world, nodeId));
        }
        else if ($t.hasClass('chr-pri')) block.priority = Number($t.val()) || 0;
        else if ($t.hasClass('chr-knownby')) block.knownBy = String($t.val());
        saveSoon(); updateSoon();
    });

    // toggles: pin / secret / replaces
    $nodes.on('click', '.chr-pin, [data-act="secret"], [data-act="replaces"]', function () {
        const { nodeId, blockId } = ctxOf($(this));
        const block = findBlock(world, nodeId, blockId);
        if (!block) return;
        const $t = $(this);
        if ($t.hasClass('chr-pin')) {
            const node = findNode(world, nodeId);
            if (node && node.mode !== 'auto') {
                toast('info', `이 시점은 '${node.mode === 'pin' ? '전부 항상' : '전부 키워드'}'로 정해져 있습니다. 시점 머리줄에서 '칸별'로 바꾸면 칸마다 정할 수 있습니다.`);
                return;
            }
            block.constant = !block.constant;
            $t.toggleClass('chr-on', block.constant)
                .attr('title', block.constant
                    ? '핀 켜짐 — 항상 삽입됩니다 (누르면 끔)'
                    : '핀 꺼짐 — 키워드가 나올 때만 삽입됩니다 (누르면 켬)');
        } else if ($t.data('act') === 'secret') {
            block.secret = !block.secret;
            $t.toggleClass('chr-on', block.secret);
            $t.closest('.chr-block-main').find('.chr-block-secret').toggle(block.secret);
        } else {
            block.replaces = !block.replaces;
            $t.toggleClass('chr-on', block.replaces);
        }
        refreshGroupHead($t, findNode(world, nodeId));
        refreshDeadChip($t.closest('[data-node]'), findNode(world, nodeId));
        saveSoon(); updateSoon();
    });

    // translate one entry (view only) — click again to hide
    $nodes.on('click', '[data-act="block-tr"]', async function () {
        const { blockId } = ctxOf($(this));
        const $main = $(this).closest('.chr-block-main');
        const $tr = $main.children('.chr-tr');
        if (_trBlocks.has(blockId)) {
            _trBlocks.delete(blockId);
            $(this).removeClass('chr-on');
            if (!_showTr) $tr.remove();
            return;
        }
        const src = String($main.children('.chr-content').val() || '').trim();
        if (!src) return toast('info', '번역할 내용이 없습니다.');
        if (isMostlyKorean(src)) return toast('info', '이미 한국어입니다.');
        _trBlocks.add(blockId);
        $(this).addClass('chr-on');
        if (!$tr.length) $('<div class="chr-tr">번역 중…</div>').insertAfter($main.children('.chr-content'));
        else { $tr[0].dataset.done = ''; $tr.text('번역 중…'); }
        await fillTranslations($main);
    });

    $nodes.on('click', '[data-act="block-toggle"]', function () {
        const { nodeId, blockId } = ctxOf($(this));
        const block = findBlock(world, nodeId, blockId);
        if (!block) return;
        block.enabled = !block.enabled;
        $(this).closest('[data-block]').toggleClass('chr-off', !block.enabled);
        $(this).find('i').attr('class', `fa-solid ${block.enabled ? 'fa-eye' : 'fa-eye-slash'}`);
        refreshGroupHead($(this), findNode(world, nodeId));
        refreshDeadChip($(this).closest('[data-node]'), findNode(world, nodeId));
        saveSoon(); updateSoon();
    });

    // delete entry — re-render this node so the group counts stay right
    $nodes.on('click', '[data-act="block-del"]', function () {
        const { nodeId, blockId } = ctxOf($(this));
        const node = findNode(world, nodeId);
        if (!node) return;
        const index = node.blocks.findIndex(b => b.id === blockId);
        if (index < 0) return;
        const [block] = node.blocks.splice(index, 1);
        pushUndo({ kind: 'block', worldId: world.id, nodeId, index, block });
        rerenderBlocks($(this).closest('[data-node]'), node);
        $nodes.closest('.chr-editor').find('[data-act="undo"]').removeClass('chr-disabled')
            .find('.chr-undo-n').text(`(${_undo.filter(u => u.worldId === world.id).length})`);
        saveSettings(); updateSoon();
    });

    $nodes.on('click', '.chr-group-head', function (ev) {
        if ($(ev.target).closest('[data-add]').length) return;
        const { nodeId } = ctxOf($(this));
        const type = String($(this).closest('.chr-group').data('group'));
        const key = groupKey(nodeId, type);
        if (_openGroups.has(key)) _openGroups.delete(key); else _openGroups.add(key);
        const $group = $(this).closest('.chr-group');
        if (_openGroups.has(key)) fillGroupBody($group, findNode(world, nodeId));
        $group.toggleClass('chr-open', _openGroups.has(key));
        if (_showTr || _trBlocks.size) fillTranslations($(this).closest('.chr-group'));
    });

    const rerenderNode = (nodeId) => {
        const node = findNode(world, nodeId);
        const el = $nodes.find(`[data-node="${nodeId}"]`)[0];
        if (!node || !el) return;
        const conf = getChatConf();
        const nowLimit = conf.now ? endKey(parseDate(conf.now)) : null;
        el.outerHTML = renderNodeHtml(node, nowLimit);
        if (_showTr || _trBlocks.size) fillTranslations($nodes.find(`[data-node="${nodeId}"]`));
    };

    $nodes.on('click', '[data-act="node-mode"]', function () {
        const { nodeId } = ctxOf($(this));
        const node = findNode(world, nodeId);
        if (!node) return;
        const i = NODE_MODES.indexOf(node.mode || 'auto');
        node.mode = NODE_MODES[(i + 1) % NODE_MODES.length];
        rerenderNode(nodeId);
        saveSoon(); updateSoon();
    });

    $nodes.on('click', '[data-act="node-toggle"]', function () {
        const { nodeId } = ctxOf($(this));
        const node = findNode(world, nodeId);
        if (!node) return;
        node.enabled = node.enabled === false;
        rerenderNode(nodeId);
        saveSoon(); updateSoon();
    });

    $nodes.on('click', '[data-act="node-fold"]', function () {
        const { nodeId } = ctxOf($(this));
        const node = findNode(world, nodeId);
        if (!node) return;
        const types = [...new Set((node.blocks || []).map(b => b.type))];
        const anyOpen = types.some(t => _openGroups.has(groupKey(nodeId, t)));
        for (const t of types) {
            if (anyOpen) _openGroups.delete(groupKey(nodeId, t));
            else _openGroups.add(groupKey(nodeId, t));
        }
        const $node = $(this).closest('[data-node]');
        $node.find('.chr-group').each(function () {
            if (!anyOpen) fillGroupBody($(this), node);
            $(this).toggleClass('chr-open', !anyOpen);
        });
        $(this).find('i').attr('class', `fa-solid ${anyOpen ? 'fa-chevron-down' : 'fa-chevron-up'}`);
        if ((_showTr || _trBlocks.size) && !anyOpen) fillTranslations($node);
    });

    $nodes.on('click', '[data-add]', function () {
        const { nodeId } = ctxOf($(this));
        const node = findNode(world, nodeId);
        if (!node) return;
        const type = String($(this).data('add'));
        const block = makeBlock({ type });
        node.blocks.push(block);
        node.blocks = sortBlocks(node.blocks);
        _openGroups.add(groupKey(nodeId, type));
        saveSettings();
        const $node = $(this).closest('[data-node]');
        rerenderBlocks($node, node);
        const target = $node.find(`[data-block="${block.id}"]`)[0];
        target?.scrollIntoView({ block: 'nearest' });
        target?.querySelector(BLOCK_TYPES[type].named ? '.chr-name' : '.chr-content')?.focus();
    });

    $nodes.on('click', '[data-act="node-dup"]', function () {
        const { nodeId } = ctxOf($(this));
        const idx = world.nodes.findIndex(n => n.id === nodeId);
        if (idx < 0) return;
        const copy = structuredClone(normalizeNode(world.nodes[idx]));
        copy.id = uid();
        copy.blocks = copy.blocks.map(b => ({ ...b, id: uid() }));
        world.nodes.splice(idx + 1, 0, copy);
        saveSettings(); render(); flashNode($nodes, copy.id);
    });

    $nodes.on('click', '[data-act="node-del"]', async function () {
        const { nodeId } = ctxOf($(this));
        const node = findNode(world, nodeId);
        if (!node) return;
        const n = (node.blocks || []).length;
        if (n > 0) {
            const ok = await callGenericPopup(
                `[${formatDate(node.date) || '시점 없음'}] 과 그 안의 글 ${n}개를 삭제합니다.\n(새로고침하기 전까지 편집기의 [되돌리기]로 되살릴 수 있습니다)`, POPUP_TYPE.CONFIRM);
            if (!ok) return;
        }
        const index = world.nodes.findIndex(x => x.id === nodeId);
        const [removed] = world.nodes.splice(index, 1);
        pushUndo({ kind: 'node', worldId: world.id, index, node: removed });
        saveSettings(); render(); updateSoon();
        toast('info', '시점을 지웠습니다. 위쪽 [되돌리기]로 되살릴 수 있습니다.');
    });
}

// ---- rendering ----

/** Redraw one group's header line only (keeps the field being typed in). */
function refreshGroupHead($el, node, type) {
    if (!node || !$el || !$el.length) return;
    const $group = $el.closest('.chr-group');
    const t = type || String($group.data('group'));
    const list = (node.blocks || []).filter(b => b.type === t);
    if ($group.length && list.length) $group.find('.chr-group-head').html(groupHeadInner(node, t, list));
}

function matchesSearch(node) {
    if (!_search) return true;
    if (String(node.date).toLowerCase().includes(_search)) return true;
    return (node.blocks || []).some(b =>
        String(b.name).toLowerCase().includes(_search) ||
        String(b.content).toLowerCase().includes(_search) ||
        (b.keys || []).join(',').toLowerCase().includes(_search));
}

/** Folded groups are rendered empty; fill a group's entries the first time it opens. */
function fillGroupBody($group, node) {
    const body = $group.children('.chr-group-body')[0];
    if (!body || body.childElementCount || !node) return;
    const type = String($group.data('group'));
    body.innerHTML = (node.blocks || []).filter(b => b.type === type).map(b => renderOneBlock(b, node.mode)).join('');
}

/** Open groups (nodeId:type) — kept across re-renders */
const _openGroups = new Set();
const groupKey = (nodeId, type) => `${nodeId}:${type}`;

function renderOneBlock(b, nodeMode = 'auto') {
    const t = BLOCK_TYPES[b.type] ?? BLOCK_TYPES.story;
    const forced = nodeMode === 'pin' ? true : nodeMode === 'key' ? false : null;
    const label = t.named
        ? `<input type="text" class="text_pole chr-name" value="${esc(b.name)}" placeholder="${t.ko}명">`
        : `<span>${t.ko}</span>`;
    const shortKey = hasShortKey(b.keys);
    return `
    <div class="chr-block ${b.enabled ? '' : 'chr-off'}" data-block="${esc(b.id)}" data-type="${b.type}">
        <div class="chr-block-label"><i class="fa-solid ${t.icon}" style="font-size:.85em;"></i>${label}</div>
        <div class="chr-block-main">
            <textarea class="text_pole chr-content" rows="2" placeholder="프롬프트에 들어갈 내용">${esc(b.content)}</textarea>
            ${_showTr || _trBlocks.has(b.id) ? '<div class="chr-tr">번역 중…</div>' : ''}
            <div class="chr-block-opts">
                <div class="chr-pin ${(forced ?? b.constant) ? 'chr-on' : ''} ${forced !== null ? 'chr-forced' : ''}" title="${forced !== null
        ? `시점 설정(${forced ? '전부 항상' : '전부 키워드'})이 적용 중 — 칸별 핀은 '칸별'로 되돌리면 다시 쓰입니다`
        : b.constant ? '핀 켜짐 — 항상 삽입됩니다 (누르면 끔)' : '핀 꺼짐 — 키워드가 나올 때만 삽입됩니다 (누르면 켬)'}">
                    <i class="fa-solid fa-thumbtack"></i>항상
                </div>
                <input type="text" class="text_pole chr-keys ${shortKey ? 'chr-warnkey' : ''}" value="${esc(b.keys.join(', '))}" placeholder="키워드 (쉼표로 구분)" title="한 글자 키워드는 엉뚱한 단어에 걸리기 쉽습니다">
                <input type="number" class="text_pole chr-pri" value="${b.priority}" min="-100" max="100" step="5" title="고정 우선도">
                <div class="chr-ico chr-tog ${b.secret ? 'chr-on' : ''}" data-act="secret" title="비밀 — 사실이지만 대부분의 인물이 모름"><i class="fa-solid fa-user-secret"></i></div>
                ${t.named ? `<div class="chr-ico chr-tog ${b.replaces ? 'chr-on' : ''}" data-act="replaces" title="이전 칸 대체 — 켜면 같은 이름의 더 이전 칸은 과거 기록으로 표시됨 (설정에서 제외로 바꿀 수 있음)"><i class="fa-solid fa-arrows-rotate"></i></div>` : ''}
                <div class="chr-ico chr-tog ${_trBlocks.has(b.id) ? 'chr-on' : ''}" data-act="block-tr" title="이 칸만 한국어로 보기 (보기 전용)"><i class="fa-solid fa-language"></i></div>
                <div class="chr-ico" data-act="block-toggle" title="${b.enabled ? '사용 중 (누르면 끔)' : '꺼짐 (누르면 켬)'}">
                    <i class="fa-solid ${b.enabled ? 'fa-eye' : 'fa-eye-slash'}"></i>
                </div>
                <div class="chr-ico chr-danger" data-act="block-del" title="이 글 삭제"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="chr-block-secret" ${b.secret ? '' : 'style="display:none"'}>
                <i class="fa-solid fa-user-secret"></i>
                <input type="text" class="text_pole chr-knownby" value="${esc(b.knownBy)}" placeholder="아는 사람 (쉼표로 구분, 비우면 아무도 모름)">
            </div>
        </div>
    </div>`;
}

/** Inner HTML of a group's header line */
function groupHeadInner(node, type, list) {
    const t = BLOCK_TYPES[type];
    const preview = list
        .map(b => (b.name ? `${b.name}: ` : '') + String(b.content || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean).join('  ·  ');
    const hidden = list.filter(b => !b.enabled).length;
    const live = list.filter(b => b.enabled);
    const pinned = live.filter(b => effConst(node, b)).length;
    const dead = live.filter(b => !effConst(node, b) && !b.keys.length).length;
    const secrets = live.filter(b => b.secret).length;

    let mark = '';
    if (node.mode !== 'auto' && live.length) {
        // the point-level setting decides; the per-entry pins are ignored
    } else if (live.length && pinned === live.length) {
        mark = `<span class="chr-mark chr-mark--pin" title="${t.ko} ${live.length}개 모두 항상 삽입됩니다"><i class="fa-solid fa-thumbtack"></i>항상</span>`;
    } else if (live.length && pinned === 0) {
        mark = '<span class="chr-mark chr-mark--key" title="항상 삽입이 하나도 없습니다 — 키워드가 나올 때만 삽입됩니다"><i class="fa-solid fa-key"></i>키워드</span>';
    } else if (live.length) {
        mark = `<span class="chr-mark chr-mark--half" title="${live.length}개 중 ${pinned}개만 항상 삽입, 나머지는 키워드일 때만"><i class="fa-solid fa-thumbtack"></i>${pinned}/${live.length}</span>`;
    }
    if (dead) mark += `<span class="chr-mark chr-mark--warn" title="핀도 꺼져 있고 키워드도 없어 절대 삽입되지 않는 글 ${dead}개"><i class="fa-solid fa-triangle-exclamation"></i>${dead}</span>`;
    if (secrets) mark += `<span class="chr-mark chr-mark--secret" title="비밀 ${secrets}개"><i class="fa-solid fa-user-secret"></i>${secrets}</span>`;

    return `
        <i class="fa-solid fa-caret-right chr-group-caret"></i>
        <i class="fa-solid ${t.icon} chr-group-icon"></i>
        <span class="chr-group-label">${t.ko}</span>
        <span class="chr-group-count">${list.length}</span>
        ${mark}
        ${hidden ? `<span class="chr-group-off" title="꺼진 글 ${hidden}개">−${hidden}</span>` : ''}
        <span class="chr-group-preview">${esc(preview)}</span>
        <div class="chr-ico chr-group-add" data-add="${type}" title="${t.ko} 추가"><i class="fa-solid fa-plus"></i></div>`;
}

function renderBlocksHtml(node) {
    const blocks = node.blocks || [];
    if (!blocks.length) {
        return '<div class="chr-noblocks">이 시점에 글이 없습니다. 위의 + 버튼으로 추가하세요.</div>';
    }
    let html = '';
    for (const type of TYPE_ORDER) {
        const list = blocks.filter(b => b.type === type);
        if (!list.length) continue;
        const open = _openGroups.has(groupKey(node.id, type));
        html += `
        <div class="chr-group ${open ? 'chr-open' : ''}" data-group="${type}" data-type="${type}">
            <div class="chr-group-head">${groupHeadInner(node, type, list)}</div>
            <div class="chr-group-body">${open ? list.map(b => renderOneBlock(b, node.mode)).join('') : ''}</div>
        </div>`;
    }
    return html;
}

function renderNodes($nodes, world) {
    const conf = getChatConf();
    const nowLimit = conf.now ? endKey(parseDate(conf.now)) : null;

    const all = world.nodes || [];
    const shown = sortNodes(all.filter(matchesSearch));

    const $ed = $nodes.closest('.chr-editor');
    $ed.find('.chr-count').text(`${shown.length} / ${all.length} 시점`);
    $ed.find('.chr-nowtag')
        .text(conf.now ? `기준 ${formatDate(conf.now)}` : '기준 없음 (전부 포함)')
        .toggleClass('chr-set', !!conf.now);

    $nodes.empty();

    if (!shown.length) {
        $nodes.append(`<div class="chr-empty">
            <i class="fa-solid fa-timeline"></i>
            ${all.length ? '검색 결과가 없습니다.' : '아직 기록된 시점이 없습니다.<br><b>[시점 추가]</b> 로 첫 연대를 만들거나, 확장 패널의 <b>[AI로 연대기 만들기]</b> 를 써 보세요.'}
        </div>`);
        return;
    }

    $nodes.data({ chrShown: shown, chrRendered: 0, chrNow: nowLimit });
    appendNodeChunk($nodes);
}

const NODE_CHUNK = 50;

/** Append the next batch of points (or up to `upto`), with a sentinel that loads more on scroll. */
function appendNodeChunk($nodes, upto) {
    const shown = $nodes.data('chrShown') || [];
    const from = $nodes.data('chrRendered') || 0;
    const to = Math.min(shown.length, Math.max(upto ?? 0, from + NODE_CHUNK));
    if (to <= from) return;
    $nodes.children('.chr-more').remove();
    const nowLimit = $nodes.data('chrNow');
    let html = '';
    for (let i = from; i < to; i++) html += renderNodeHtml(shown[i], nowLimit);
    $nodes.append(html);
    $nodes.data('chrRendered', to);
    if (to < shown.length) {
        const more = $(`<div class="chr-more menu_button">시점 ${shown.length - to}개 더 보기</div>`);
        more.on('click', () => appendNodeChunk($nodes));
        $nodes.append(more);
    }
}

/** Load the next batch when the popup is scrolled near the bottom. */
function bindChunkScroll($nodes) {
    const sc = $nodes.closest('.popup-content')[0];
    if (!sc || sc.dataset.chrScroll) return;
    sc.dataset.chrScroll = '1';
    let busy = false;
    sc.addEventListener('scroll', () => {
        if (busy || !$nodes.children('.chr-more').length) return;
        if (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 900) return;
        busy = true;
        requestAnimationFrame(() => { appendNodeChunk($nodes); busy = false; });
    }, { passive: true });
}

/** Make sure a point is in the DOM (render the batches before it). */
function ensureNodeRendered($nodes, nodeId) {
    const shown = $nodes.data('chrShown') || [];
    const i = shown.findIndex(n => n.id === nodeId);
    if (i >= ($nodes.data('chrRendered') || 0)) appendNodeChunk($nodes, i + 10);
}

const NODE_MODE_UI = {
    auto: { label: '칸별', icon: 'fa-list-check', title: '칸마다 정한 핀/키워드를 따릅니다' },
    pin: { label: '전부 항상', icon: 'fa-thumbtack', title: '이 시점의 모든 칸을 조건 없이 넣습니다' },
    key: { label: '전부 키워드', icon: 'fa-key', title: '이 시점의 모든 칸을 키워드가 나올 때만 넣습니다' },
};

function renderNodeHtml(node, nowLimit) {
    const span = parseSpan(node.date || '');
    const dt = span ? span.start : null;
    const key = nodeKey(node);
    const bad = node.date && dt === null;
    const checked = dt !== null && (nowLimit === null || key <= nowLimit);
    const boundary = dt !== null && !span.range && nowLimit !== null && endKey(dt) === nowLimit;
    const status = span && checked ? spanStatus(span, nowLimit) : 'point'; // future periods get no tag
    const rangeTag = status === 'ongoing' ? '<span class="chr-node-tag chr-tag-ongoing">진행 중</span>'
        : status === 'ended' ? '<span class="chr-node-tag chr-tag-ended">종료</span>'
            : status === 'range' ? '<span class="chr-node-tag chr-tag-ended">기간</span>' : '';

    const mode = NODE_MODES.includes(node.mode) ? node.mode : 'auto';
    const ui = NODE_MODE_UI[mode];
    const off = node.enabled === false;
    const dead = deadBlocks(node).length;
    const modeChip = `<div class="chr-nmode chr-nmode--${mode}" data-act="node-mode" title="${ui.title} (누르면 바뀜: 칸별 → 전부 항상 → 전부 키워드)"><i class="fa-solid ${ui.icon}"></i>${ui.label}</div>`;
    const deadChip = dead && !off
        ? `<span class="chr-node-tag chr-tag-warn" title="${mode === 'key' ? '이 시점은 전부 키워드인데' : '핀이 꺼져 있는데'} 키워드가 없는 칸이 ${dead}개 있습니다. 이 칸들은 절대 들어가지 않습니다."><i class="fa-solid fa-triangle-exclamation"></i> 키워드 없음 ${dead}</span>`
        : '';
    const checkTitle = dt === null
        ? '날짜를 먼저 입력하세요 (기간은 1970~1981 처럼)'
        : boundary ? '기준 시점 — 다시 누르면 해제'
            : '여기까지를 기준 시점으로 (맨 위부터 자동 체크)';

    return `
    <div class="chr-node ${checked ? '' : 'chr-future'} ${boundary ? 'chr-boundary' : ''} ${off ? 'chr-node-off' : ''}" data-node="${esc(node.id)}">
        <div class="chr-node-head">
            <div class="chr-check ${checked ? 'chr-on' : ''} ${dt === null ? 'chr-disabled' : ''}" title="${checkTitle}">
                <i class="fa-${checked ? 'solid' : 'regular'} ${checked ? 'fa-square-check' : 'fa-square'}"></i>
            </div>
            <input type="text" class="text_pole chr-date ${bad ? 'chr-invalid' : ''}"
                   value="${esc(node.date)}" placeholder="2015-01-01" title="시점: 2015 / 2015-06 / 2015-06-20 · 기간: 1970~1981 / 끝나지 않음: 1991~">
            ${boundary ? '<span class="chr-node-tag">기준 시점</span>' : ''}${rangeTag}
            ${off ? '<span class="chr-node-tag chr-tag-ended">시점 꺼짐</span>' : ''}${deadChip}
            <div class="chr-node-spacer"></div>
            ${modeChip}
            <div class="chr-node-actions">
                <div class="chr-ico" data-act="node-fold" title="이 시점 전부 접기 / 펴기"><i class="fa-solid fa-chevron-down"></i></div>
                <div class="chr-ico" data-add="story" title="스토리 추가"><i class="fa-solid fa-book-open"></i></div>
                <div class="chr-ico" data-add="character" title="인물 추가"><i class="fa-solid fa-user-plus"></i></div>
                <div class="chr-ico" data-add="relation" title="관계 추가"><i class="fa-solid fa-link"></i></div>
                <div class="chr-ico" data-add="environment" title="환경 추가"><i class="fa-solid fa-globe"></i></div>
                <div class="chr-ico" data-act="node-toggle" title="${off ? '시점 꺼짐 — 누르면 켬' : '이 시점 통째로 끄기'}"><i class="fa-solid ${off ? 'fa-eye-slash' : 'fa-eye'}"></i></div>
                <div class="chr-ico" data-act="node-dup" title="이 시점 복제"><i class="fa-solid fa-copy"></i></div>
                <div class="chr-ico chr-danger" data-act="node-del" title="이 시점 삭제"><i class="fa-solid fa-trash-can"></i></div>
            </div>
        </div>
        <div class="chr-blocks">${renderBlocksHtml(node)}</div>
    </div>`;
}

// ==================================================================
// Slash commands
// ==================================================================

function registerSlashCommands() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'chrono',
            helpString: '이 채팅의 기준 시점을 정합니다. 예: <code>/chrono 2015</code>. 인자 없이 쓰면 현재 시점을 알려줍니다. <code>/chrono off</code> 로 제한 해제.',
            unnamedArgumentList: [SlashCommandArgument.fromProps({
                description: '기준 시점 (YYYY / YYYY-MM / YYYY-MM-DD) 또는 off',
                typeList: [ARGUMENT_TYPE.STRING], isRequired: false,
            })],
            callback: async (_a, value) => {
                const v = String(value ?? '').trim();
                if (!v) return getChatConf().now || '(제한 없음)';
                if (v.toLowerCase() === 'off') {
                    setChatConf({ now: '' }); refreshPanel(); await updateInjection(); return '';
                }
                if (parseDate(v) === null) {
                    toast('warning', '시점 형식이 올바르지 않습니다. 예: 2015 / 2015-06 / 2015-06-20');
                    return '';
                }
                setChatConf({ now: v }); refreshPanel(); await updateInjection();
                return formatDate(v);
            },
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'chrono-world',
            helpString: '이 채팅에 연결할 세계관을 이름으로 지정합니다.',
            unnamedArgumentList: [SlashCommandArgument.fromProps({
                description: '세계관 이름', typeList: [ARGUMENT_TYPE.STRING], isRequired: true,
            })],
            callback: async (_a, value) => {
                const name = String(value ?? '').trim().toLowerCase();
                const w = getWorlds().find(x => x.name.toLowerCase() === name)
                    || getWorlds().find(x => x.name.toLowerCase().includes(name));
                if (!w) { toast('warning', `'${value}' 세계관을 찾지 못했습니다.`); return ''; }
                setChatConf({ worldId: w.id }); refreshPanel(); await updateInjection();
                return w.name;
            },
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'chrono-preview',
            helpString: '지금 주입되는 연대기를 미리보기 창으로 엽니다.',
            callback: async () => { await openPreview(); return ''; },
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'chrono-ai',
            helpString: 'AI로 연대기 만들기 창을 엽니다.',
            callback: async () => { await openAiGenerator(); return ''; },
        }));
    } catch (e) {
        warn('슬래시 명령 등록 실패', e);
    }
}

// ==================================================================
// Init
// ==================================================================

jQuery(async () => {
    try {
        initSettings();

        const html = await (await fetch(`${EXT_URL}settings.html`)).text();
        $('#extensions_settings2').append(html);

        bindPanel();
        refreshPanel();
        registerSlashCommands();

        eventSource.on(event_types.CHAT_CHANGED, async () => {
            refreshPanel();
            await updateInjection();
        });
        // Keyword scanning happens in the generation interceptor (see manifest.json):
        // SillyTavern calls it after the user's new message is added to the chat and
        // before the prompt is assembled, so a keyword in the message just sent triggers.
        globalThis.chronicleInterceptor = async (coreChat) => {
            await updateInjection(coreChat);
        };

        await updateInjection();
        console.log('[크로니클] 확장을 불러왔습니다.');
    } catch (e) {
        console.error('[크로니클] 초기화 실패', e);
    }
});

// Exposed for tests only (not used by SillyTavern).
export const __test = { parseDate, parseText, exportText, keywordMatches, mergeNodes, aiToNodes, parseJsonLoose, splitText, renderBlockLine, normalizeBlock, buildPacket, formatSpec };
