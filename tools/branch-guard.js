#!/usr/bin/env node
'use strict';
/**
 * tools/branch-guard.js —— 分支路径护栏
 *
 * 按「当前分支」校验暂存文件路径，越界直接拦下（pre-commit 调用）：
 *   - `content/*`：只允许创作路径（docs/stories · tools/episodes · tools/publish）
 *   - 其它分支（main / feature/* / fix/*）：不允许创作路径
 *   - 过程文件白名单（任何分支可提交）：docs/BRANCHING.md · tools/branch-guard.js · .githooks/**
 *
 * 动机：真实事故——创作提交（E05）里混进了另一条线的 6 个平台 WIP 文件，
 * 只因在共享工作区用了 `git add -A`。规则见 docs/BRANCHING.md。
 *
 * 用法：
 *   node tools/branch-guard.js                                  # 校验暂存文件
 *   node tools/branch-guard.js --paths a/b.json c/d.md          # 自测指定路径
 *   BRANCH_GUARD_ALLOW=1 git commit ...                         # 紧急放行
 */
const { execSync } = require('node:child_process');

/** 创作路径前缀（归 content/* 分支） */
const CREATION_PREFIXES = ['docs/stories/', 'tools/episodes/', 'tools/publish/'];
/** 过程文件白名单（任何分支都可提交） */
const PROCESS_WHITELIST = ['docs/BRANCHING.md', 'tools/branch-guard.js', '.githooks/'];

const isCreationPath = (p) => CREATION_PREFIXES.some((pre) => p.startsWith(pre));
const isProcessPath = (p) => PROCESS_WHITELIST.some((pre) => p === pre || p.startsWith(pre));
const isContentBranch = (branch) => /^content\//.test(branch);

/**
 * 校验一批路径是否符合该分支职责
 * @param {string} branch 分支名
 * @param {string[]} paths 仓库相对路径（正斜杠）
 * @returns {{path:string, why:string}[]} 违规列表（空数组 = 通过）
 */
function check(branch, paths) {
  const violations = [];
  const content = isContentBranch(branch);
  for (const raw of paths) {
    const p = String(raw).replace(/\\/g, '/');
    if (!p || isProcessPath(p)) continue;
    if (content && !isCreationPath(p)) {
      violations.push({
        path: p,
        why: 'content 分支只允许创作路径（docs/stories · tools/episodes · tools/publish）',
      });
    } else if (!content && isCreationPath(p)) {
      violations.push({
        path: p,
        why: '创作路径只允许提交到 content/* 分支（平台分支勿改创作内容）',
      });
    }
  }
  return violations;
}

function stagedPaths() {
  try {
    // 用 -z（NUL 分隔）：git 对非 ASCII 路径默认做八进制转义并加引号（core.quotepath=true），
    // 例如 docs/stories/幻灯屋-台账.md → "docs/stories/\345\271\273…"。按行读会把引号与反斜杠
    // 一并带进来，前缀匹配全部失效 → 所有中文文件名被判"越界"（E06 实战踩到：docs/stories 两个
    // 中文文件被误拦）。-z 输出原样 UTF-8、不转义，路径可安全前缀匹配。
    return execSync('git diff --cached --name-only --diff-filter=ACMR -z', { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function currentBranch() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function main(argv = process.argv.slice(2)) {
  if (process.env.BRANCH_GUARD_ALLOW === '1') {
    console.log('branch-guard: 已放行（BRANCH_GUARD_ALLOW=1，请在提交信息里说明原因）');
    return 0;
  }
  const i = argv.indexOf('--paths');
  const paths = i >= 0 ? argv.slice(i + 1) : stagedPaths();
  const branch = process.env.BRANCH_GUARD_BRANCH || currentBranch();
  if (!paths.length) return 0;
  const bad = check(branch, paths);
  if (bad.length) {
    console.error('\nbranch-guard 拦截：提交内容与当前分支职责不符\n');
    console.error('  当前分支：' + (branch || '(detached)'));
    for (const v of bad) console.error(`  ✗ ${v.path}\n      → ${v.why}`);
    console.error('\n  规则见 docs/BRANCHING.md；紧急放行：BRANCH_GUARD_ALLOW=1 git commit ...\n');
    return 1;
  }
  console.log(`branch-guard: OK（${paths.length} 个文件符合 ${branch || '(detached)'} 的职责）`);
  return 0;
}

module.exports = { check, isCreationPath, isProcessPath, isContentBranch };

if (require.main === module) process.exit(main());
