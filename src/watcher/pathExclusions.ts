/**
 * Path segments to skip for workspace snapshot + external-write diff triggers.
 * Match whole path components (e.g. .../obj/foo.json → skip because of `obj`).
 *
 * Các tên dưới đây là output/dependency **của một project**, nên chúng chỉ có
 * nghĩa khi đọc tương đối so với workspace root. Soi cả đường tuyệt đối thì
 * một project đặt ở `~/build/app` hay `~/dist/site` bị loại toàn bộ và
 * extension im lặng không làm gì — vì vậy caller phải truyền `rootPath`.
 */
import * as fs from 'fs';
import * as path from 'path';

const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  'out',
  'dist',
  'build',
  '.vscode',
  '.idea',
  '.claude',
  // .NET / Visual Studio
  'bin',
  'obj',
  'TestResults',
  'artifacts',
  '.vs',
  // Java / JVM
  'target',
  '.gradle',
  '.settings',
  '.classpath',
  '.project',
  // Python
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'site-packages',
  'dist-info',
  'egg-info',
]);

/**
 * Cache parentDir -> boolean: whether `<parentDir>/packages` is a legacy NuGet
 * solution folder. A NuGet `packages/` folder is always a sibling of a `.sln`
 * file. Anything else named `packages/` (npm/pnpm/yarn workspaces, lerna, …)
 * is real source we must NOT exclude.
 */
const nugetPackagesCache = new Map<string, boolean>();

function isNugetPackagesParent(parentDir: string): boolean {
  const cached = nugetPackagesCache.get(parentDir);
  if (cached !== undefined) { return cached; }
  let result = false;
  try {
    for (const entry of fs.readdirSync(parentDir)) {
      if (entry.toLowerCase().endsWith('.sln')) { result = true; break; }
    }
  } catch {
    result = false;
  }
  nugetPackagesCache.set(parentDir, result);
  return result;
}

/**
 * @param absPath  Đường tuyệt đối của file cần xét.
 * @param rootPath Workspace root chứa nó. Có root thì chỉ soi phần đường NẰM
 *   TRONG project; thiếu root (hoặc file nằm ngoài root) mới rơi về soi cả
 *   đường tuyệt đối như trước.
 */
export function isExcludedPathSegment(absPath: string, rootPath?: string): boolean {
  const relative = rootPath !== undefined ? path.relative(rootPath, absPath) : undefined;
  const insideRoot =
    relative !== undefined &&
    relative !== '' &&
    !relative.startsWith('..' + path.sep) &&
    relative !== '..' &&
    !path.isAbsolute(relative);

  const scanned = insideRoot ? relative! : absPath;
  const parts = scanned.split(path.sep);

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (EXCLUDED_SEGMENTS.has(p)) { return true; }
    if (p !== 'packages') { continue; }
    // `isNugetPackagesParent` đọc đĩa, nên parent phải là đường tuyệt đối kể cả
    // khi đang soi đường tương đối. Ở nhánh tương đối, i === 0 là hợp lệ và
    // quan trọng: `packages/` của NuGet nằm ngay cạnh file `.sln` ở root.
    const prefix = parts.slice(0, i).join(path.sep);
    const parentDir = insideRoot ? path.join(rootPath!, prefix) : prefix;
    if (parentDir && isNugetPackagesParent(parentDir)) { return true; }
  }
  return false;
}
