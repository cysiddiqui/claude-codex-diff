/**
 * gitignore.ts
 *
 * Hỏi chính `git` xem một file có bị .gitignore loại hay không, để file bị
 * ignore không bao giờ lọt vào hàng chờ review.
 *
 * Vì sao hỏi git thay vì tự parse `.gitignore`: luật ignore của git không chỉ
 * là một danh sách glob — còn có `.gitignore` lồng nhau theo từng thư mục,
 * mẫu phủ định (`!keep.log`), `.git/info/exclude`, `core.excludesFile` toàn
 * cục, và quy tắc dấu `/` ở đầu/cuối. Tự parse là tự nuôi một bộ luật gần
 * đúng; `git check-ignore` là chính cái git dùng, nên không bao giờ lệch.
 *
 * Quan trọng: `check-ignore` MẶC ĐỊNH có soi index, nên file đã được track
 * (đã commit) KHÔNG bị coi là ignored kể cả khi khớp mẫu — đúng như mong đợi:
 * file đã vào repo thì vẫn phải review được. (`--no-index` mới bỏ qua index.)
 *
 * `pathExclusions.ts` vẫn giữ nguyên vai trò riêng: nó là lưới lọc ĐỒNG BỘ,
 * không tốn process, chặn `node_modules`/`dist`/… ngay ở đầu đường event. Lớp
 * này chạy sau, chỉ trên số ít file mà AI thực sự ghi.
 */

import { execFile, spawn } from 'child_process';
import * as vscode from 'vscode';

/** Giá trị mặc định của `ai-cli-diff-view.respectGitignore`. */
const DEFAULT_RESPECT_GITIGNORE = true;

/** Repo lớn có thể mất một nhịp để trả lời; quá mốc này coi như không biết. */
const CHECK_TIMEOUT_MS = 5000;

/** Batch cả workspace nên rộng tay hơn lần hỏi đơn lẻ. */
const BATCH_TIMEOUT_MS = 30000;

let respectGitignore = DEFAULT_RESPECT_GITIGNORE;

/** absPath -> bị ignore hay không. Giữ cả kết quả phủ định để khỏi spawn lại. */
const cache = new Map<string, boolean>();

/**
 * Gộp các lần hỏi trùng nhau cho cùng một path đang bay: một file bị ghi liên
 * tiếp có thể sinh nhiều lần hỏi trước khi lần đầu kịp trả lời.
 */
const inFlight = new Map<string, Promise<boolean>>();

export function refreshGitIgnoreSetting(): void {
  const config = vscode.workspace.getConfiguration('ai-cli-diff-view');
  respectGitignore = config.get<boolean>('respectGitignore', DEFAULT_RESPECT_GITIGNORE);
  clearGitIgnoreCache();
}

/**
 * Quên toàn bộ kết quả đã nhớ. Gọi khi `.gitignore` vừa bị sửa — luật đổi thì
 * mọi câu trả lời cũ đều có thể đã sai.
 */
export function clearGitIgnoreCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * File này có bị git bỏ qua không?
 *
 * Trả về `false` khi không xác định được (không có git, thư mục không phải
 * repo, lệnh lỗi hay quá hạn). Đây là fail-open CÓ CHỦ ĐÍCH: đoán sai theo
 * hướng "không ignore" thì user thấy thừa một diff và tự bỏ qua, còn đoán sai
 * theo hướng "ignore" thì một thay đổi thật bị giấu mất mà không ai biết.
 */
export async function isGitIgnored(absPath: string): Promise<boolean> {
  if (!respectGitignore) { return false; }

  const cached = cache.get(absPath);
  if (cached !== undefined) { return cached; }

  const pending = inFlight.get(absPath);
  if (pending !== undefined) { return pending; }

  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absPath));
  if (!folder) { return false; }

  const query = runCheckIgnore(absPath, folder.uri.fsPath).then((ignored) => {
    inFlight.delete(absPath);
    cache.set(absPath, ignored);
    return ignored;
  });
  inFlight.set(absPath, query);
  return query;
}

/**
 * Hỏi git MỘT lần cho cả danh sách, rồi nhớ kết quả — dùng cho lượt quét
 * baseline đầu tiên, nơi có thể có hàng chục nghìn file. Spawn một process cho
 * mỗi file ở quy mô đó là không dùng được.
 *
 * Batch thất bại (không có git, không phải repo) thì KHÔNG ghi gì vào cache:
 * để mỗi file tự hỏi lại sau còn hơn nhớ một câu trả lời sai cho tất cả.
 */
export async function prefetchGitIgnored(absPaths: string[], rootPath: string): Promise<void> {
  if (!respectGitignore || absPaths.length === 0) { return; }

  const ignored = await runCheckIgnoreBatch(absPaths, rootPath);
  if (ignored === undefined) { return; }

  for (const absPath of absPaths) {
    cache.set(absPath, ignored.has(absPath));
  }
}

/**
 * `git check-ignore --stdin -z`: nhận path qua stdin, in ra những path bị
 * ignore. Dùng `-z` (phân tách bằng NUL) nên tên file có xuống dòng hay ký tự
 * lạ cũng không phá được khung phân tách.
 *
 * Trả `undefined` nghĩa là KHÔNG BIẾT — phân biệt với "biết chắc không file
 * nào bị ignore" (Set rỗng).
 */
function runCheckIgnoreBatch(absPaths: string[], cwd: string): Promise<Set<string> | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['check-ignore', '--stdin', '-z'], { cwd });
    } catch {
      resolve(undefined);
      return;
    }

    let out = '';
    let settled = false;
    const finish = (value: Set<string> | undefined): void => {
      if (settled) { return; }
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => { child.kill(); finish(undefined); }, BATCH_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    // Git thoát sớm (không phải repo) trong lúc ta còn đang ghi -> EPIPE. Đó là
    // lỗi đã được nhánh 'close' xử lý, không được để nó ném ra ngoài.
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); finish(undefined); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 0 = có file bị ignore, 1 = không file nào. Còn lại là lỗi thật.
      if (code !== 0 && code !== 1) { finish(undefined); return; }
      finish(new Set(out.split('\0').filter(line => line.length > 0)));
    });

    child.stdin.end(absPaths.join('\0'));
  });
}

/**
 * Exit code của `git check-ignore --quiet`: 0 = bị ignore, 1 = không, còn lại
 * (128 = không phải repo, ENOENT = máy không có git, …) là không xác định.
 *
 * Truyền path sau `--` và dùng `execFile` (không qua shell) nên tên file có
 * ký tự lạ hay bắt đầu bằng `-` cũng không bị hiểu thành option.
 */
function runCheckIgnore(absPath: string, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['check-ignore', '--quiet', '--', absPath],
      { cwd, timeout: CHECK_TIMEOUT_MS },
      (err) => { resolve(err === null); }
    );
  });
}
