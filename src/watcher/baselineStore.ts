/**
 * baselineStore.ts
 *
 * Quản lý baseline nội dung các file để WorkspaceWatcher có thể
 * phát hiện external writes so với trạng thái trước đó.
 */

import * as path from 'path';
import * as vscode from 'vscode';

export class BaselineStore {
  /** filePath -> nội dung baseline trước khi external process ghi đè */
  private snapshots = new Map<string, string>();
  /**
   * Các file cố ý KHÔNG theo dõi: vượt giới hạn kích thước/số dòng, hoặc bị
   * .gitignore loại.
   *
   * Phải nhớ riêng chứ không chỉ "không có baseline": hai trạng thái đó nhìn
   * giống nhau nhưng xử lý ngược nhau. Không baseline = file mới tinh -> mở
   * diff toàn-file-thêm-mới, và Revert all trên diff đó sẽ XOÁ file. Cờ này là
   * thứ phân biệt "file mới" với "file vẫn luôn ở đó, ta chỉ không theo dõi".
   */
  private skipped = new Set<string>();

  private normalizePath(p: string): string {
    const fsPath = vscode.Uri.file(path.resolve(p)).fsPath;
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
  }

  get(filePath: string): string | undefined {
    return this.snapshots.get(this.normalizePath(filePath));
  }

  set(filePath: string, content: string): void {
    this.snapshots.set(this.normalizePath(filePath), content);
  }

  has(filePath: string): boolean {
    return this.snapshots.has(this.normalizePath(filePath));
  }

  /** Trả về true nếu file đã có baseline hoặc đã được đánh dấu bỏ qua. */
  hasState(filePath: string): boolean {
    const key = this.normalizePath(filePath);
    return this.snapshots.has(key) || this.skipped.has(key);
  }

  /** Bỏ theo dõi 1 file (quá lớn, hoặc bị .gitignore loại). */
  markSkipped(filePath: string): void {
    const key = this.normalizePath(filePath);
    this.snapshots.delete(key);
    this.skipped.add(key);
  }

  /**
   * File này từng bị bỏ qua? Dùng để phân biệt "file mới" với "file cũ vừa
   * quay lại tầm ngắm" (tụt xuống dưới ngưỡng, hoặc vừa bị gỡ khỏi .gitignore).
   * Trả về true thì đồng thời xoá cờ.
   */
  consumeSkipped(filePath: string): boolean {
    const key = this.normalizePath(filePath);
    return this.skipped.delete(key);
  }

  /** Xoá toàn bộ baseline trong RAM. Dùng khi branch switch để rebuild lại từ disk. */
  clear(): void {
    this.snapshots.clear();
    this.skipped.clear();
  }
}
