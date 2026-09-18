/**
 * diffManager.ts
 *
 * Snapshot + accept/revert state cho các file đang được AI sửa.
 * Render delegate hoàn toàn sang DiffPanelHost — MỘT webview dùng chung cho
 * mọi pending file, đổi nội dung thay vì mở tab mới (xem diffWebviewPanel.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { calculateHunks } from './hunkCalculator';
import { detectEol, fromLf, toLf } from './eol';
import { exceedsLineLimit } from '../watcher/fileSizeLimit';
import { isGitIgnored } from '../watcher/gitignore';
import type { DiffPanelHost } from './diffWebviewPanel';
import { SnapshotStore, SnapshotState } from './snapshotStore';

function normalizePath(filePath: string): string {
  const fsPath = vscode.Uri.file(path.resolve(filePath)).fsPath;
  return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

/**
 * Trả về path với case canonical từ OS (Windows preserve case từ disk).
 * Dùng khi gọi VS Code APIs để tab/tên file hiển thị đúng case như user.
 * Fallback về input nếu file không tồn tại.
 */
function canonicalCasePath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

export class DiffManager {
  /**
   * Bắn ra path (đã normalize) của file vừa đổi, hoặc `undefined` khi cả danh
   * sách đổi.
   *
   * Mang theo path chứ không phải `void` vì mỗi tab diff đều lắng nghe sự kiện
   * TOÀN CỤC này. Không biết file nào đổi thì mọi tab phải diff lại và gửi lại
   * nguyên nội dung hai vế qua ranh giới process — trong khi với gần hết số
   * tab, thứ duy nhất thực sự đổi chỉ là con số "23 / 70".
   */
  private _onDidChangeDiffs = new vscode.EventEmitter<string | undefined>();
  public readonly onDidChangeDiffs = this._onDidChangeDiffs.event;

  private snapshots: Map<string, SnapshotState> = new Map();
  private readonly store: SnapshotStore;
  /** Panel diff duy nhất. Gắn sau khi construct vì hai bên tham chiếu nhau. */
  private host: DiffPanelHost | undefined;
  /** filePath (normalized) -> last cursor + top visible line seen in Monaco modified editor. */
  private lastCursors: Map<string, { line: number; column: number; topLine?: number }> = new Map();

  /**
   * filePath (normalized) của tab đang active NGAY TRƯỚC khi WorkspaceWatcher
   * bắt đầu tự động mở diff cho 1 cụm external write (checkout đổi vài file
   * hay hàng loạt file đều tính, xem markActiveTabBeforeAutoOpen()). undefined
   * nghĩa là không có tab file nào active lúc đó (vd: đang ở terminal/sidebar)
   * — vẫn khác với "chưa ghi hint nào", phân biệt bằng pendingActiveTabCaptured.
   */
  private pendingActiveTabPath: string | undefined;
  private pendingActiveTabCaptured = false;
  private pendingActiveTabCapturedAt = 0;
  /**
   * Hint quá cũ (vd: cụm write đó rốt cuộc không phải git checkout nên
   * clearAll() không bao giờ chạy theo sau nó) thì bỏ qua, để lần clearAll()
   * không liên quan sau đó không lỡ dùng lại path cũ. Rộng hơn nhiều so với
   * holdMs tối đa (10s) + debounce xác nhận HEAD (1s).
   */
  private static readonly PENDING_ACTIVE_TAB_TTL_MS = 15000;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new SnapshotStore(context.workspaceState);
    this.snapshots = this.store.load();
  }

  attachPanelHost(host: DiffPanelHost): void {
    this.host = host;
  }

  async snapshotBefore(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);
    if (this.snapshots.has(absPath)) {
      return;
    }
    // Đường built-in runner cũng phải tôn trọng .gitignore, nếu không setting
    // chỉ đúng với đường workspace watcher.
    if (await isGitIgnored(absPath)) { return; }
    const uri = vscode.Uri.file(absPath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch (err) {
      if (isFileNotFound(err)) {
        this.snapshots.set(absPath, { content: '', fileExistedBefore: false });
        void this.store.save(this.snapshots);
      }
      return;
    }

    try {
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      // Đường built-in runner cũng phải tôn trọng maxFileLines, nếu không setting
      // chỉ đúng với đường workspace watcher. Không snapshot -> openDiff() thoát
      // sớm vì không có snapshot -> file lớn không mở diff, đúng như mong đợi.
      if (exceedsLineLimit(content)) { return; }
      this.snapshots.set(absPath, { content, fileExistedBefore: true });
    } catch {
      // File có thể bị xóa hoặc không đọc được sau khi stat — không tạo snapshot rỗng.
      return;
    }
    void this.store.save(this.snapshots);
  }

  /**
   * @param options.auto Lần mở này do AI edit kích hoạt, KHÔNG phải user bấm.
   *   Mở tự động mà cướp tab đang active thì user đang đọc dở diff 23/70 bị ném
   *   thẳng sang diff 71 ngay khi AI ghi file tiếp theo — mất chỗ đang đọc, và
   *   càng nhiều edit càng không review nổi. Với `auto`, file chỉ được XẾP HÀNG:
   *   snapshot vẫn vào pending list nên counter tự lên 23/71, còn tab thì để
   *   user tự tới bằng next/prev hoặc sau khi accept/reject file hiện tại.
   *
   *   `preserveFocus` một mình KHÔNG đủ: nó chỉ giữ focus bàn phím, editor mới
   *   vẫn thành editor hiển thị của group — user vẫn bị nhảy khỏi chỗ đang đọc.
   */
  async openDiff(
    filePath: string,
    options?: { preserveFocus?: boolean; auto?: boolean }
  ): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (snapshot === undefined) { return; }

    let modifiedContent: string;
    try {
      modifiedContent = Buffer.from(
        await vscode.workspace.fs.readFile(vscode.Uri.file(absPath))
      ).toString('utf8');
    } catch {
      return;
    }

    // So trên LF thuần: thay đổi thuần EOL (git checkout, đổi setting files.eol,
    // formatter...) cho ra 0 hunk và rơi vào nhánh dọn dẹp bên dưới, thay vì mở
    // một diff phủ cả file.
    const hunks = calculateHunks(toLf(snapshot.content), toLf(modifiedContent));
    if (hunks.length === 0) {
      this.snapshots.delete(absPath);
      void this.store.save(this.snapshots);
      this._onDidChangeDiffs.fire(absPath);
      return;
    }

    const preserveFocus = options?.preserveFocus === true;

    const isAuto = options?.auto === true;

    const host = this.host;
    if (!host) { return; }

    if (host.activeFilePath === absPath) {
      // Panel đã hiển thị đúng file này; nội dung tự refresh qua
      // onDidChangeTextDocument, nên lần auto không cần reveal — user có thể
      // đang đọc chỗ khác.
      if (!isAuto) {
        await host.show(absPath, { preserveFocus });
      }
      this._onDidChangeDiffs.fire(absPath);
      return;
    }

    // Đang có diff mở = user đang review dở. Edit mới chỉ vào hàng chờ.
    // Lưu ý thứ tự: đoạn tính hunk ở trên vẫn chạy trước, nên file "sửa rồi
    // thành y hệt cũ" vẫn bị dọn khỏi pending thay vì đọng lại làm lệch counter.
    if (isAuto && host.hasPanel()) {
      this._onDidChangeDiffs.fire(absPath);
      return;
    }

    await this.closeTextTabsFor(absPath);
    await host.show(absPath, { preserveFocus });
    this._onDidChangeDiffs.fire(absPath);
  }

  /**
   * Đóng mọi tab text editor đang trỏ tới file này, để diff editor mới mở
   * không tạo tab thứ hai cùng file.
   */
  private async closeTextTabsFor(absPath: string): Promise<void> {
    const targets: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText)) { continue; }
        if (normalizePath(tab.input.uri.fsPath) === absPath) {
          targets.push(tab);
        }
      }
    }
    if (targets.length === 0) { return; }
    try {
      await vscode.window.tabGroups.close(targets);
    } catch (err) {
      console.error('[ai-cli-diff] closeTextTabsFor failed:', err);
    }
  }

  loadSnapshot(filePath: string, content: string, fileExistedBefore = true): void {
    const absPath = normalizePath(filePath);
    if (!this.snapshots.has(absPath)) {
      this.snapshots.set(absPath, { content, fileExistedBefore });
      void this.store.save(this.snapshots);
      this._onDidChangeDiffs.fire(absPath);
    }
  }

  /**
   * Accept toàn bộ thay đổi của 1 file: file đã sẵn trên đĩa với currentContent,
   * chỉ cần xoá snapshot.
   */
  async accept(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);
    if (!this.snapshots.has(absPath)) { return; }

    const pendingBefore = this.getPendingFiles();
    const currentIdx = pendingBefore.findIndex(p => normalizePath(p) === absPath);
    const nextTarget =
      pendingBefore.length > 1 && currentIdx !== -1
        ? pendingBefore[(currentIdx + 1) % pendingBefore.length]
        : undefined;

    this.snapshots.delete(absPath);
    void this.store.save(this.snapshots);
    // Tháo file khỏi panel nhưng GIỮ webview sống: openDiff() ngay dưới dùng
    // lại đúng panel đó. Dispose rồi tạo lại = nạp lại Monaco.
    this.host?.detachIfShowing(absPath);
    await this.reopenAsTextEditor(absPath);

    if (nextTarget) {
      await this.openDiff(nextTarget);
    }
    // openDiff() có thể không gắn được gì (file kế tiếp hoá ra 0 hunk nên bị
    // dọn khỏi pending luôn). Còn detached nghĩa là không còn gì để xem.
    this.host?.closeIfDetached();
    this._onDidChangeDiffs.fire(absPath);
  }

  /**
   * Revert toàn bộ: ghi originalContent ra đĩa.
   * Nếu file vốn không tồn tại trước đó -> xoá file.
   */
  async revert(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return; }

    const pendingBefore = this.getPendingFiles();
    const currentIdx = pendingBefore.findIndex(p => normalizePath(p) === absPath);
    const nextTarget =
      pendingBefore.length > 1 && currentIdx !== -1
        ? pendingBefore[(currentIdx + 1) % pendingBefore.length]
        : undefined;

    if (snapshot.fileExistedBefore) {
      await this.writeFile(absPath, snapshot.content);
    } else {
      await this.deleteFile(absPath);
    }

    this.snapshots.delete(absPath);
    void this.store.save(this.snapshots);
    this.host?.detachIfShowing(absPath);
    if (snapshot.fileExistedBefore) {
      await this.reopenAsTextEditor(absPath);
    } else {
      this.lastCursors.delete(absPath);
    }

    if (nextTarget) {
      await this.openDiff(nextTarget);
    }
    this.host?.closeIfDetached();
    this._onDidChangeDiffs.fire(absPath);
  }

  async acceptAllPending(): Promise<number> {
    const pendingFiles = this.getPendingFiles();
    const count = pendingFiles.length;
    this.snapshots.clear();
    void this.store.save(this.snapshots);
    this.host?.close();
    for (const p of pendingFiles) {
      // Không dọn thì cursor cũ còn nằm lại vô thời hạn và sẽ được dùng lại cho
      // lần pending sau của đúng file đó, nhảy về một vị trí không liên quan.
      this.lastCursors.delete(normalizePath(p));
    }
    this._onDidChangeDiffs.fire(undefined);
    return count;
  }

  /**
   * File đang pending vừa bị xoá khỏi đĩa -> bỏ snapshot đi.
   *
   * Không có bước này thì file đã xoá vẫn nằm trong pending list: counter đếm
   * sai (hiện `2 / 22` trong khi chỉ còn 2 file thật), và next/prev vẫn dừng ở
   * những mục đó — `openDiff()` đọc file không được nên im lặng `return`, nút
   * bấm như không có tác dụng.
   */
  async dropDeletedFile(filePath: string): Promise<boolean> {
    const absPath = normalizePath(filePath);
    if (!this.snapshots.has(absPath)) { return false; }

    const wasShowing = this.host?.activeFilePath === absPath;
    const pendingBefore = this.getPendingFiles();
    const currentIdx = pendingBefore.findIndex(p => normalizePath(p) === absPath);
    const nextTarget =
      pendingBefore.length > 1 && currentIdx !== -1
        ? pendingBefore[(currentIdx + 1) % pendingBefore.length]
        : undefined;

    this.snapshots.delete(absPath);
    void this.store.save(this.snapshots);
    this.lastCursors.delete(absPath);
    this.host?.detachIfShowing(absPath);

    if (wasShowing) {
      if (nextTarget) {
        await this.openDiff(nextTarget);
      }
      this.host?.closeIfDetached();
    }
    this._onDidChangeDiffs.fire(absPath);
    return true;
  }

  hasPendingDiff(filePath: string): boolean {
    return this.snapshots.has(normalizePath(filePath));
  }

  getPendingFiles(): string[] {
    return Array.from(this.snapshots.keys());
  }

  getSnapshot(filePath: string): string | undefined {
    return this.snapshots.get(normalizePath(filePath))?.content;
  }

  /** Alias dùng bởi DiffPanelHost; trả về content của snapshot (left side). */
  getSnapshotContent(filePath: string): string | undefined {
    return this.getSnapshot(filePath);
  }

  setLastCursor(filePath: string, line: number, column: number, topLine?: number): void {
    this.lastCursors.set(normalizePath(filePath), { line, column, topLine });
  }

  /** Chỉ còn một panel, nên "diff nào đang mở" là câu hỏi thẳng. */
  getActiveFilePath(): string | undefined {
    return this.host?.activeFilePath;
  }

  disposeAll(): void {
    // Trước khi xoá: flush() serialise ngay tại đây (đồng bộ) nên vẫn bắt được
    // nội dung hiện tại. Bỏ qua thì lần ghi đang chờ trong debounce mất luôn,
    // và các diff đang chờ biến mất sau khi mở lại cửa sổ.
    void this.store.flush();
    this.snapshots.clear();
    this.host?.close();
  }

  /**
   * Xoá toàn bộ pending (vd: git branch switch). Cần persist clean state để
   * sau reload window không bị `SnapshotStore.load()` kéo lại.
   *
   * Nếu tab đang active đúng là 1 diff tab bị xoá, mở lại nó dưới dạng text
   * editor thường (giữ cursor/scroll) thay vì để nó biến mất đột ngột — chỉ
   * áp dụng cho tab đang active, KHÔNG áp dụng cho mọi panel bị đóng (nếu
   * không sẽ mở lại hàng loạt tab cho các file nền user không đang xem).
   */
  async clearAll(): Promise<void> {
    const hint = this.consumePendingActiveTabHint();
    const activeDiffPath = hint.captured
      ? (hint.path !== undefined && this.snapshots.has(hint.path) ? hint.path : undefined)
      : this.getLiveActiveDiffPath();

    this.disposeAll();
    await this.store.clear();

    if (activeDiffPath) {
      await this.reopenAsTextEditor(activeDiffPath);
    }
  }

  private getLiveActiveDiffPath(): string | undefined {
    if (this.host?.isActiveTab() !== true) { return undefined; }
    const active = this.host.activeFilePath;
    return active !== undefined && this.snapshots.has(active) ? active : undefined;
  }

  /**
   * Gọi bởi WorkspaceWatcher ở write ĐẦU TIÊN của 1 cụm external write sắp tự
   * động mở diff (xem WorkspaceWatcher.resolveOrHold — áp dụng cho cả mở ngay
   * lẫn hold-rồi-dump, không riêng burst). Ghi lại tab đang active THẬT SỰ tại
   * thời điểm đó — trước khi các openDiff() không đồng bộ trong cụm chạy đua
   * khiến activeTab trở nên ngẫu nhiên. clearAll() (khi git xác nhận branch
   * đổi đến sau đó) sẽ ưu tiên dùng giá trị này thay vì tab thắng cuộc đua.
   */
  markActiveTabBeforeAutoOpen(): void {
    this.pendingActiveTabPath = this.getCurrentTabFsPath();
    this.pendingActiveTabCaptured = true;
    this.pendingActiveTabCapturedAt = Date.now();
  }

  private getCurrentTabFsPath(): string | undefined {
    // Tab diff là webview panel, không phải tab file — tabGroups không cho ra
    // path của nó, phải hỏi thẳng host.
    if (this.host?.isActiveTab() === true) { return this.host.activeFilePath; }
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const uri =
      tab?.input instanceof vscode.TabInputText ? tab.input.uri :
      tab?.input instanceof vscode.TabInputCustom ? tab.input.uri :
      tab?.input instanceof vscode.TabInputNotebook ? tab.input.uri :
      undefined;
    return uri ? normalizePath(uri.fsPath) : undefined;
  }

  /** Dùng 1 lần: đọc xong luôn reset state, để lần clearAll() sau (không có
   *  cụm auto-open nào xảy ra trước đó) không vô tình dùng lại hint cũ. */
  private consumePendingActiveTabHint(): { captured: boolean; path: string | undefined } {
    const captured = this.pendingActiveTabCaptured;
    const path = this.pendingActiveTabPath;
    const capturedAt = this.pendingActiveTabCapturedAt;
    this.pendingActiveTabCaptured = false;
    this.pendingActiveTabPath = undefined;
    this.pendingActiveTabCapturedAt = 0;
    if (!captured || Date.now() - capturedAt > DiffManager.PENDING_ACTIVE_TAB_TTL_MS) {
      return { captured: false, path: undefined };
    }
    return { captured, path };
  }

  private async reopenAsTextEditor(absPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
    } catch (err) {
      if (!isFileNotFound(err)) {
        console.error('[ai-cli-diff] cannot stat file before reopening:', err);
      }
      this.lastCursors.delete(absPath);
      return;
    }
    const cursor = this.lastCursors.get(absPath);
    this.lastCursors.delete(absPath);
    const uri = vscode.Uri.file(canonicalCasePath(absPath));
    const showOptions: vscode.TextDocumentShowOptions = { preview: false };
    if (cursor) {
      const pos = new vscode.Position(
        Math.max(0, cursor.line - 1),
        Math.max(0, cursor.column - 1)
      );
      showOptions.selection = new vscode.Range(pos, pos);
    }
    try {
      const editor = await vscode.window.showTextDocument(uri, showOptions);
      if (cursor?.topLine !== undefined) {
        const lastLine = Math.max(0, editor.document.lineCount - 1);
        const top = Math.min(lastLine, Math.max(0, cursor.topLine - 1));
        editor.revealRange(
          new vscode.Range(top, 0, top, 0),
          vscode.TextEditorRevealType.AtTop
        );
      }
    } catch (err) {
      console.error('[ai-cli-diff] reopenAsTextEditor failed:', err);
    }
  }

  // ---- Hunk-level operations (gọi bởi webview qua provider) ----

  /**
   * Accept 1 hunk: webview đã tính newOriginal (snapshot trồi lên include hunk),
   * newCurrent giữ nguyên. Chỉ update snapshot + có thể đóng nếu hết hunk.
   */
  async applyHunkAcceptFromWebview(
    filePath: string,
    newOriginal: string,
    newCurrent: string
  ): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return; }

    // newOriginal từ webview ở LF -> trả về đúng EOL của snapshot cũ, để snapshot
    // luôn giữ nguyên dạng byte gốc của file và revert() khôi phục chuẩn xác.
    this.snapshots.set(absPath, {
      ...snapshot,
      content: fromLf(newOriginal, detectEol(snapshot.content)),
    });
    void this.store.save(this.snapshots);

    if (newOriginal === newCurrent) {
      await this.accept(absPath);
    } else {
      this._onDidChangeDiffs.fire(absPath);
    }
  }

  /**
   * Reject 1 hunk: webview đã tính newCurrent (rollback hunk về original),
   * newOriginal giữ nguyên. Ghi newCurrent ra đĩa.
   */
  async applyHunkRejectFromWebview(
    filePath: string,
    newOriginal: string,
    newCurrent: string
  ): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return; }

    // newCurrent từ webview ở LF -> writeFile khôi phục EOL thật của file.
    await this.writeFile(absPath, newCurrent, { fromLf: true });

    if (newOriginal === newCurrent) {
      if (!snapshot.fileExistedBefore && newCurrent.length === 0) {
        await this.deleteFile(absPath);
      }
      const pendingBefore = this.getPendingFiles();
      const currentIdx = pendingBefore.findIndex(p => normalizePath(p) === absPath);
      const nextTarget =
        pendingBefore.length > 1 && currentIdx !== -1
          ? pendingBefore[(currentIdx + 1) % pendingBefore.length]
          : undefined;

      this.snapshots.delete(absPath);
      void this.store.save(this.snapshots);
      this.host?.detachIfShowing(absPath);

      if (nextTarget) {
        await this.openDiff(nextTarget);
      }
      this.host?.closeIfDetached();
    }
    this._onDidChangeDiffs.fire(absPath);
  }

  /**
   * @param opts.fromLf `content` đang ở LF thuần (đến từ webview) và cần khôi phục
   *   EOL thật của file trước khi ghi. Bỏ trống khi content đã đúng dạng byte gốc
   *   (vd: revert() ghi thẳng snapshot).
   */
  private async writeFile(
    absPath: string,
    content: string,
    opts?: { fromLf?: boolean }
  ): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    const doc = vscode.workspace.textDocuments.find(d => normalizePath(d.uri.fsPath) === absPath);

    let payload = content;
    if (opts?.fromLf) {
      // Document đang mở là nguồn đáng tin nhất — đó chính là EOL VS Code sẽ ghi.
      // Không mở thì suy từ nội dung hiện có trên đĩa.
      let eol: '\r\n' | '\n';
      if (doc) {
        eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      } else {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          eol = detectEol(Buffer.from(bytes).toString('utf8'));
        } catch {
          eol = '\n';
        }
      }
      payload = fromLf(content, eol);
    }

    if (doc) {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        doc.lineAt(doc.lineCount - 1).range.end
      );
      edit.replace(uri, fullRange, payload);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(payload, 'utf8'));
    }
  }

  private async deleteFile(absPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(absPath));
    } catch (err) {
      if (!isFileNotFound(err)) {
        throw err;
      }
    }
  }
}
