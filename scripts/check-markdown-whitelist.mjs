import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const root = process.cwd();
const whitelistPath = path.join(root, "tools", "lint", "markdown-whitelist.yaml");
const listUnknown = process.argv.includes("--list-unknown");
const whitelist = readWhitelist(whitelistPath, listUnknown);
const inputs = readInputs();
const violations = [];
const unknownWords = new Map();

for (const input of inputs) {
  const cleaned = maskWhitelistValues(stripMarkdownNoise(input.text), whitelist.valuePattern);
  checkTokens(input.relativePath, cleaned,
    /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*/g,
    shouldCheckEnglishToken);
  checkTokens(input.relativePath, cleaned,
    /(?<![\u30A0-\u30FF])[\u30A0-\u30FF]+(?:[・ー][\u30A0-\u30FF]+)*(?![\u30A0-\u30FF])/gu,
    shouldCheckKatakanaToken);
}

if (listUnknown) {
  for (const [, item] of [...unknownWords.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${item.word}\t${item.count}`);
  }
  process.exit(violations.length > 0 ? 1 : 0);
}
if (violations.length > 0) {
  console.error("Markdown whitelist violations:");
  for (const violation of violations.slice(0, 200)) console.error(`- ${violation}`);
  if (violations.length > 200) console.error(`- ... ${violations.length - 200} more violations`);
  process.exit(1);
}

function readInputs() {
  const filesIndex = process.argv.indexOf("--files");
  if (filesIndex >= 0) {
    return process.argv.slice(filesIndex + 1)
      .filter((arg) => !arg.startsWith("--"))
      .map((file) => path.resolve(root, file))
      .filter((file) => file.endsWith(".md") && isInsideRoot(file) && fs.existsSync(file))
      .map(readInput);
  }
  return listMarkdownFiles(path.join(root, "doc")).map(readInput);
}

function readInput(filePath) {
  return {
    relativePath: path.relative(root, filePath).replaceAll(path.sep, "/"),
    text: fs.readFileSync(filePath, "utf8")
  };
}

function isInsideRoot(filePath) {
  const relative = path.relative(root, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function listMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function readWhitelist(filePath, allowMissing) {
  if (!fs.existsSync(filePath)) {
    if (allowMissing) return { terms: new Set(), valuePattern: null };
    throw new Error("tools/lint/markdown-whitelist.yaml is required.");
  }
  const data = YAML.parse(fs.readFileSync(filePath, "utf8"));
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const terms = new Set();
  const values = new Set();
  for (const entry of entries) {
    if (!entry?.term || !entry?.description) {
      throw new Error("Each whitelist entry must include term and description.");
    }
    for (const value of [entry.term, ...normalizeAliases(entry.aliases)]) {
      terms.add(normalizeTerm(value));
      values.add(value);
    }
  }
  return { terms, valuePattern: buildWhitelistValuePattern([...values]) };
}
function normalizeAliases(aliases) {
  if (!aliases) return [];
  return Array.isArray(aliases) ? aliases : [aliases];
}

function stripMarkdownNoise(text) {
  return text
    .replace(/^```[\s\S]*?^```/gm, blankPreserving)
    .replace(/`[^`\n]+`/g, blankPreserving)
    .replace(/^\[\^[^\]]+\]:.*$/gm, blankPreserving)
    .replace(/https?:\/\/[^\s)]+/g, blankPreserving)
    .replace(/mailto:[^\s)]+/g, blankPreserving)
    .replace(/<!--[\s\S]*?-->/g, blankPreserving)
    .replace(/^\[[^\]\n]+\]:\s+\S+.*$/gm,
      (value) => value.replace(/:\s+\S+.*$/, ": "))
    .replace(/\[[^\]\n]+\]\([^)]+\)/g,
      (value) => value.replace(/\([^)]+\)/g, ""));
}

function blankPreserving(value) {
  return value.replace(/[^\n]/g, " ");
}

function maskWhitelistValues(text, valuePattern) {
  return valuePattern ? text.replace(valuePattern, blankPreserving) : text;
}

function buildWhitelistValuePattern(values) {
  const alternatives = values
    .filter((value) => value.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((value) => escapeRegExp(value).replace(/\s+/g, "\\s+"));
  if (alternatives.length === 0) return null;
  return new RegExp(`(^|[^A-Za-z0-9\\u30A0-\\u30FF])(${alternatives.join("|")})(?=$|[^A-Za-z0-9\\u30A0-\\u30FF])`, "giu");
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkTokens(relativePath, cleaned, pattern, shouldCheck) {
  for (const match of cleaned.matchAll(pattern)) {
    const word = match[0];
    if (!shouldCheck(word)) continue;
    const normalized = normalizeTerm(word);
    if (whitelist.terms.has(normalized)) continue;
    const line = lineNumberAt(cleaned, match.index ?? 0);
    violations.push(`${relativePath}:${line}: '${word}' is not in tools/lint/markdown-whitelist.yaml.`);
    const current = unknownWords.get(normalized) ?? { word, count: 0 };
    current.count += 1;
    unknownWords.set(normalized, current);
  }
}

function shouldCheckEnglishToken(word) {
  return word.length > 1 && !/\d/.test(word);
}

function shouldCheckKatakanaToken(word) {
  const normalized = word.normalize("NFKC").replace(/[・ー._-]/g, "");
  return normalized.length > 1 && /[\u30A0-\u30FF]/u.test(normalized);
}

function normalizeTerm(term) {
  return term.normalize("NFKC").toLowerCase();
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}
