import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { lint } from "markdownlint/sync";

const ignoredDirectories = new Set([".git", "dist", "node_modules", "reference"]);
const files = [];

function collectMarkdownFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      collectMarkdownFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
}

collectMarkdownFiles(".");
const config = JSON.parse(readFileSync(".markdownlint.json", "utf8"));
const results = lint({ files, config });
let issueCount = 0;

for (const [file, errors] of Object.entries(results)) {
  for (const error of errors) {
    issueCount += 1;
    console.error(`${file}:${error.lineNumber} ${error.ruleNames.join("/")} ${error.ruleDescription}`);
  }
}

console.log(`markdownlint: ${files.length} file(s), ${issueCount} issue(s)`);
if (issueCount > 0) process.exitCode = 1;
