/**
 * baselineScanner.ts
 *
 * Quét nội dung ban đầu của workspace và ghi baseline vào BaselineStore.
 * Dùng VS Code workspace API để không chặn extension host và giới hạn số file
 * được đọc đồng thời để tránh tăng tải/RAM đột biến.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { isExcludedPathSegment } from './pathExclusions';
import { exceedsLineLimit, exceedsSizeLimitByBytes } from './fileSizeLimit';
import { BaselineStore } from './baselineStore';
import { isTextFile } from './fileTypeRules';
import { isGitIgnored, prefetchGitIgnored } from './gitignore';

export class BaselineScanner {
  private static readonly DEFAULT_CONCURRENCY = 4;
  private static readonly MAX_CONCURRENCY = 16;

  constructor(private readonly store: BaselineStore) {}

  /**
   * Đệ quy snapshot nội dung tất cả file text trong một thư mục.
   * Chỉ chạy lần đầu khi extension khởi động để tạo baseline.
   */
  async buildInitialSnapshots(folderPath: string): Promise<void> {
    try {
      const folderUri = vscode.Uri.file(folderPath);
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folderUri, '**/*')
      );

      // Lọc bằng các phép kiểm tra đồng bộ, rẻ TRƯỚC, rồi mới hỏi git một lần
      // duy nhất cho phần còn lại. Baseline giữ nguyên nội dung file trong RAM
      // của extension host, nên mỗi file bị loại ở đây là vài chục KB không
      // phải giữ — trên repo thật phần bị .gitignore loại chiếm đa số tuyệt đối.
      const candidates = uris.filter(uri => this.isCandidate(uri, folderPath));
      await prefetchGitIgnored(
        candidates.map(uri => path.resolve(uri.fsPath)),
        folderPath
      );

      let nextIndex = 0;
      const workerCount = Math.min(this.readConcurrency(), candidates.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < candidates.length) {
          const uri = candidates[nextIndex++];
          await this.snapshotFile(uri);
        }
      });
      await Promise.all(workers);
    } catch {
      // ignore lỗi permission hoặc thư mục không có quyền đọc
    }
  }

  private readConcurrency(): number {
    const configured = vscode.workspace
      .getConfiguration('ai-cli-diff-view')
      .get<number>('baselineScanConcurrency', BaselineScanner.DEFAULT_CONCURRENCY);
    if (!Number.isFinite(configured)) {
      return BaselineScanner.DEFAULT_CONCURRENCY;
    }
    return Math.min(
      BaselineScanner.MAX_CONCURRENCY,
      Math.max(1, Math.floor(configured!))
    );
  }

  /** Các phép loại đồng bộ, không đụng đĩa — chạy được trên cả danh sách. */
  private isCandidate(uri: vscode.Uri, folderPath: string): boolean {
    const fullPath = path.resolve(uri.fsPath);
    const relativePath = path.relative(path.resolve(folderPath), fullPath);
    const relativeSegments = relativePath.split(path.sep);
    if (relativeSegments.slice(0, -1).some(segment => segment.startsWith('.'))) {
      return false;
    }
    if (isExcludedPathSegment(fullPath, folderPath) || !isTextFile(path.basename(fullPath))) {
      return false;
    }
    return !this.store.hasState(fullPath);
  }

  private async snapshotFile(uri: vscode.Uri): Promise<void> {
    const fullPath = path.resolve(uri.fsPath);

    // `markSkipped` chứ không chỉ `return`, giống hệt nhánh vượt-kích-thước:
    // "không có baseline" nghĩa là "file mới" với WorkspaceWatcher, và Revert
    // all trên một diff toàn-file-thêm-mới sẽ xoá mất file.
    if (await isGitIgnored(fullPath)) {
      this.store.markSkipped(fullPath);
      return;
    }

    try {
      // Lọc thô theo byte trước, để file vài MB không bị đọc lên chỉ để loại.
      const stat = await vscode.workspace.fs.stat(uri);
      if (exceedsSizeLimitByBytes(stat.size)) {
        if (!this.store.hasState(fullPath)) {
          this.store.markSkipped(fullPath);
        }
        return;
      }
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      if (exceedsLineLimit(content)) {
        if (!this.store.hasState(fullPath)) {
          this.store.markSkipped(fullPath);
        }
        return;
      }
      if (!this.store.hasState(fullPath)) {
        this.store.set(fullPath, content);
      }
    } catch {
      // binary, permission error hoặc file đang bị lock — bỏ qua
    }
  }
}
