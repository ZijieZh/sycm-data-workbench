import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".py", ".txt"]);
const ignoredDirectories = new Set([".git", ".venv", "node_modules", "releases"]);
const banned = [
  "金" + "领冠",
  "伊" + "利",
  "279" + "70",
  "C:" + "\\AAA",
  "C:" + "/AAA",
  "R" + "OG",
  "Work" + "Buddy",
  "work" + "buddy",
];

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignoredDirectories.has(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(target) : [target];
  });
}

const failures = [];
for (const file of filesIn(root)) {
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  const content = fs.readFileSync(file, "utf8");
  for (const term of banned) {
    if (content.includes(term)) failures.push(`${path.relative(root, file)} 包含禁用文本：${term}`);
  }
}

const expectedVersions = new Map([
  ["extensions/general-collector/manifest.json", "0.1.12"],
  ["extensions/store-loss-collector/manifest.json", "0.2.6"],
  ["extensions/product-loss-collector/manifest.json", "0.3.5"],
]);
for (const [relative, expected] of expectedVersions) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
  if (manifest.version !== expected) failures.push(`${relative} 版本为 ${manifest.version}，预期 ${expected}`);
  if (manifest.manifest_version !== 3) failures.push(`${relative} 不是 Manifest V3`);
}

const index = fs.readFileSync(path.join(root, "docs/index.html"), "utf8");
for (const id of ["pipeline", "collectors", "dashboard", "database"]) {
  if (!index.includes(`id="${id}"`)) failures.push(`展示页缺少 #${id}`);
}
if (!index.includes("所有店铺、商品和金额均为虚构数据")) failures.push("展示页缺少演示数据声明");
if (index.includes('href=""')) failures.push("展示页存在空链接");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("公开发布检查通过：敏感文本、插件版本、Manifest 和展示页结构均符合预期。");
