#!/usr/bin/env node
/**
 * compaction-report — score what compaction summaries actually kept.
 *
 * Reads the folds archived by `compaction-archive.mjs` and reports how much of
 * each fold's identifiers and decisions survived into its summary.
 *
 * Usage:
 *   node bin/compaction-report.mjs            # all archives, summary only
 *   node bin/compaction-report.mjs --detail   # per-fold breakdown too
 *   node bin/compaction-report.mjs --dir DIR  # a specific archive directory
 */

import { argv, exit } from "node:process";
import { listArchives, readArchive, archiveDir } from "../src/compaction-archive.mjs";
import { evaluateFold, renderReport } from "../src/compaction-eval.mjs";

const args = argv.slice(2);
const detail = args.includes("--detail");
const dirFlag = args.indexOf("--dir");
const dir = dirFlag !== -1 ? args[dirFlag + 1] : null;

const target = dir ?? archiveDir();
const files = listArchives({ dir: target, limit: 500 });

if (!files.length) {
  console.log(`No compaction archives in ${target}.`);
  console.log("Nothing has been folded yet — compaction only runs once a session approaches the context budget.");
  exit(0);
}

const results = [];
for (const { path } of files) {
  const record = readArchive(path);
  if (!record) continue;
  const result = evaluateFold(record);
  results.push(result);
  if (detail) {
    const pct = (n) => `${(n * 100).toFixed(0)}%`;
    console.log(
      `${path.split("/").pop()}  ids ${pct(result.identifiers.rate)} (${result.identifiers.total})` +
        `  decisions ${pct(result.decisions.rate)} (${result.decisions.total})` +
        `  ${result.ratio.toFixed(1)}:1`,
    );
  }
}

if (detail) console.log("");
console.log(renderReport(results));
