/**
 * workspaceWatcher.ts
 *
 * Theo dõi file thay đổi trong workspace qua VS Code API.
 * Khi bất kỳ file nào được ghi (bởi Claude, hay bất kỳ tool nào),
 * extension sẽ tự động snapshot và hiện inline diff.
 *
 * Flow:
 *   1. onDidSaveTextDocument → sync snapshot để FileSystemWatcher không trigger diff sai
 *   2. FileSystemWatcher → bắt được cả file ghi từ external process
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { DiffManager } from '../diff/diffManager';
import { toLf } from '../diff/eol';
import { BaselineScanner } from './baselineScanner';
import { BaselineStore } from './baselineStore';
import { isTextFile } from './fileTypeRules';
import { isExcludedPathSegment } from './pathExclusions';
import { exceedsLineLimit, exceedsSizeLimitByBytes } from './fileSizeLimit';
import { BurstMeterConfig, WriteBurstMeter } from './writeBurstMeter';
import { clearGitIgnoreCache, isGitIgnored } from './gitignore';

export class WorkspaceWatcher {
  private disposables: vscode.Disposable[] = [];
  /** Debounce: thời điểm lần cuối xử lý mỗi file */
  private lastProcessed = new Map<string, number>();
  /** Lưu thời điểm VS Code vừa Save file (để bỏ qua watcher trigger từ chính VS Code) */
  private savedFilesByVsCode = new Map<string, number>();
  private readonly snapshots: BaselineStore;
  private readonly baselineScanner: BaselineScanner;
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  /** Debounce window is 500ms — keep entries an order of magnitude longer for safety, then drop. */
  private static readonly LAST_PROCESSED_TTL_MS = 60_000;
  /** VS Code save guard window is 2s — same safety multiplier. */
  private static readonly SAVED_BY_VSCODE_TTL_MS = 10_000;
  /**
   * Cờ "đang trong external batch operation" (vd: git checkout đổi branch).
   * Trong window này, mọi external write chỉ cập nhật baseline mà KHÔNG tạo diff.
   * Được set bởi GitBranchWatcher khi phát hiện .git/HEAD đổi.
   */
  private suppressUntil = 0;
  private readonly burstMeter = new WriteBurstMeter();
  /** Giữ external write đến khi initial baseline scan hoàn tất. */
  private baselineScansInProgress = 0;
  private readonly queuedExternalWrites = new Map<string, boolean>();
  /** Thời gian giữ file vượt ngưỡng burst chờ xác nhận git trước khi mở diff bình thường. */
  private holdMs = 2000;
  /** File vượt ngưỡng burst, đang chờ xác nhận git (xem resolveOrHold/scheduleHoldResolve). */
  private readonly heldWrites = new Map<string, { originalContent: string; newContent: string; fileExistedBefore: boolean }>();
  private holdResolveTimer: NodeJS.Timeout | undefined;
  /** Mốc thời gian write-triggered diff-open gần nhất — dùng để nhận biết "write đầu cụm" trong resolveOrHold(). */
  private lastAutoOpenActivityAt = 0;
  /** Khoảng cách tối thiểu giữa 2 write để coi là 2 cụm khác nhau (và ghi lại hint activeTab mới). */
  private static readonly ACTIVE_TAB_CAPTURE_GAP_MS = 500;
  /** File pending vừa nhận event xoá, đang chờ xác nhận là mất thật. */
  private readonly pendingDeletions = new Map<string, NodeJS.Timeout>();
  /** Đợi bấy nhiêu ms rồi mới tin một event xoá — xem handleExternalDelete(). */
  private static readonly DELETE_CONFIRM_MS = 500;

  constructor(private readonly diffManager: DiffManager) {
    this.snapshots = new BaselineStore();
    this.baselineScanner = new BaselineScanner(this.snapshots);
  }

  start(): void {
    this.watchVscodeEvents();
    this.watchWorkspaceFolders();
    this.applyBurstConfig();
    const d = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ai-cli-diff-view.burstDetectionEnabled') ||
          e.affectsConfiguration('ai-cli-diff-view.burstDetectionWindowMs') ||
          e.affectsConfiguration('ai-cli-diff-view.burstDetectionThreshold') ||
          e.affectsConfiguration('ai-cli-diff-view.burstDetectionHoldMs')) {
        this.applyBurstConfig();
      }
    });
    this.disposables.push(d);
  }

  private applyBurstConfig(): void {
    this.burstMeter.updateConfig(this.loadBurstMeterConfig());
    const config = vscode.workspace.getConfiguration('ai-cli-diff-view');
    const holdMs = config.get<number>('burstDetectionHoldMs', 2000);
    this.holdMs = Number.isFinite(holdMs) ? Math.min(10000, Math.max(500, holdMs)) : 2000;
  }

  private loadBurstMeterConfig(): BurstMeterConfig {
    const config = vscode.workspace.getConfiguration('ai-cli-diff-view');
    const windowMs = config.get<number>('burstDetectionWindowMs', 300);
    const threshold = config.get<number>('burstDetectionThreshold', 8);
    return {
      enabled: config.get<boolean>('burstDetectionEnabled', true),
      windowMs: Number.isFinite(windowMs) ? Math.min(5000, Math.max(50, windowMs)) : 300,
      threshold: Number.isFinite(threshold) ? Math.min(500, Math.max(2, threshold)) : 8,
    };
  }

  /**
   * Báo cho watcher biết vừa có external batch operation (vd: git checkout).
   * - Wipe baseline trong RAM để rebuild từ disk hiện tại.
   * - Set suppress window để các fs event đến sau (kể cả từ setTimeout 200ms
   *   đã pending) không tạo diff nữa, chỉ ghi đè baseline.
   * - Xác nhận git thật đã xảy ra: bỏ toàn bộ file đang bị giữ (heldWrites) —
   *   không mở diff cho chúng nữa, đúng như baseline vừa rebuild.
   */
  notifyExternalBatch(windowMs = 5000): void {
    this.suppressUntil = Date.now() + windowMs;
    this.snapshots.clear();
    if (this.holdResolveTimer) {
      clearTimeout(this.holdResolveTimer);
      this.holdResolveTimer = undefined;
    }
    this.heldWrites.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      void this.watchFolder(folder.uri.fsPath).catch(() => {
        // ignore — sẽ tự rebuild dần qua các event sau
      });
    }
  }

  private isSuppressed(): boolean {
    return Date.now() < this.suppressUntil;
  }

  private normalizePath(p: string): string {
    const fsPath = vscode.Uri.file(path.resolve(p)).fsPath;
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
  }

  /**
   * Sync snapshot khi VS Code save — đảm bảo FileSystemWatcher không trigger diff sai.
   * (onDidSaveTextDocument luôn fire trước watcher event)
   */
  private watchVscodeEvents(): void {
    const d = vscode.workspace.onDidSaveTextDocument((doc) => {
      const filePath = this.normalizePath(doc.uri.fsPath);
      // File quá lớn thì không giữ baseline — nhưng phải ĐÁNH DẤU, không chỉ bỏ
      // qua: nếu sau này nó tụt xuống dưới ngưỡng, "không có baseline" sẽ bị hiểu
      // là file mới và Revert all sẽ xoá mất file. Vẫn ghi nhận VS Code vừa lưu
      // để FileSystemWatcher không hiểu nhầm đây là external write.
      const text = doc.getText();
      if (exceedsLineLimit(text)) {
        this.snapshots.markSkipped(filePath);
      } else {
        this.snapshots.set(filePath, text);
      }
      this.savedFilesByVsCode.set(filePath, Date.now());
      this.pruneStaleMapEntries();
    });
    this.disposables.push(d);
  }

  private pruneStaleMapEntries(): void {
    const now = Date.now();
    for (const [key, ts] of this.lastProcessed) {
      if (now - ts > WorkspaceWatcher.LAST_PROCESSED_TTL_MS) {
        this.lastProcessed.delete(key);
      }
    }
    for (const [key, ts] of this.savedFilesByVsCode) {
      if (now - ts > WorkspaceWatcher.SAVED_BY_VSCODE_TTL_MS) {
        this.savedFilesByVsCode.delete(key);
      }
    }
  }

  private watchWorkspaceFolders(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }

    // Sử dụng FileSystemWatcher native của VS Code để tránh kẹt event loop
    // khi tạo mới project có hàng ngàn file (VD: node_modules trong Next.js)
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    const handleUri = (uri: vscode.Uri) => {
      this.handleExternalWrite(uri);
    };
    
    fileWatcher.onDidChange(handleUri);
    fileWatcher.onDidCreate(handleUri);
    fileWatcher.onDidDelete((uri) => {
      this.handleExternalDelete(uri);
    });
    
    this.disposables.push(fileWatcher);

    for (const folder of folders) {
      void this.watchFolder(folder.uri.fsPath);
    }

    const d = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const added of e.added) {
        void this.watchFolder(added.uri.fsPath);
      }
    });
    this.disposables.push(d);
  }

  private async watchFolder(folderPath: string): Promise<void> {
    this.baselineScansInProgress++;
    try {
      await this.baselineScanner.buildInitialSnapshots(folderPath);
    } catch (err) {
      console.error('[ai-cli-diff-view] workspaceWatcher buildInitialSnapshots error:', err);
    } finally {
      this.baselineScansInProgress--;
      if (this.baselineScansInProgress === 0) {
        const queued = Array.from(this.queuedExternalWrites.entries());
        this.queuedExternalWrites.clear();
        for (const [filePath, burstHold] of queued) {
          this.lastProcessed.delete(filePath);
          this.handleExternalWrite(vscode.Uri.file(filePath), burstHold);
        }
      }
    }
  }

  private handleExternalWrite(uri: vscode.Uri, burstHoldOverride?: boolean): void {
    const absPath = this.normalizePath(uri.fsPath);
    // File quay lại trước khi event xoá kịp được xác nhận (ghi kiểu temp +
    // rename) -> huỷ luôn, snapshot phải được giữ nguyên.
    this.cancelPendingDeletion(absPath);

    // Luật ignore vừa đổi -> mọi câu trả lời đã nhớ đều có thể sai. Đặt trước
    // mọi early-return bên dưới để không bị chính các bộ lọc đó nuốt mất.
    if (path.basename(absPath) === '.gitignore') { clearGitIgnoreCache(); }

    // Đo tốc độ ghi TRƯỚC mọi filter bên dưới — xem writeBurstMeter.ts. Capture
    // quyết định NGAY tại thời điểm raw event tới (chính xác nhất so với cửa
    // sổ trượt), mang theo qua debounce/setTimeout bên dưới tới lúc quyết định
    // triggerDiff — không gọi record() lần 2 để tránh đếm trùng.
    const burstHold = burstHoldOverride ?? this.burstMeter.record(absPath);

    // Root phải resolve TRƯỚC: `isExcludedPathSegment()` chỉ đúng khi đọc đường
    // tương đối so với project (xem pathExclusions.ts).
    const workspaceRoot = this.workspaceRootFor(absPath);
    if (workspaceRoot === undefined) { return; }

    // Bỏ qua dependency / build output / tooling (dotnet bin/obj, node_modules, …)
    if (isExcludedPathSegment(absPath, workspaceRoot)) {
      return;
    }

    // 1. Kiểm tra xem file này vừa được VS Code Save hay không
    const lastVsCodeSave = this.savedFilesByVsCode.get(absPath) ?? 0;
    const now = Date.now();
    if (now - lastVsCodeSave < 2000) {
      // Bỏ qua vì đây là viết từ chính VS Code editor
      return;
    }

    // 2. Debounce: bỏ qua nếu vừa xử lý file này trong 500ms
    const lastTime = this.lastProcessed.get(absPath) ?? 0;
    if (now - lastTime < 500) { return; }
    this.lastProcessed.set(absPath, now);
    this.pruneStaleMapEntries();

    if (!isTextFile(path.basename(absPath))) { return; }

    if (this.baselineScansInProgress > 0) {
      this.queuedExternalWrites.set(absPath, burstHold);
      return;
    }

    // Đọc nội dung mới sau một chút để đảm bảo write xong.
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      void this.processExternalWrite(uri, absPath, burstHold);
    }, 200);
    this.pendingTimers.add(timer);
  }

  private async processExternalWrite(
    uri: vscode.Uri,
    absPath: string,
    burstHold: boolean
  ): Promise<void> {
    // Re-check after timeout in case VS Code onDidSaveTextDocument fired during the 200ms delay.
    const lastVsCodeSaveAfterTimeout = this.savedFilesByVsCode.get(absPath) ?? 0;
    if (Date.now() - lastVsCodeSaveAfterTimeout < 2000) {
      return;
    }

    try {
      // Lọc thô theo byte TRƯỚC khi đọc, để file vài MB không bị đọc lên chỉ để loại.
      // stat() cũng là phép kiểm tra file tồn tại; nếu file đã bị xóa, nó sẽ throw.
      const stat = await vscode.workspace.fs.stat(uri);
      if (exceedsSizeLimitByBytes(stat.size)) {
        this.snapshots.markSkipped(absPath);
        return;
      }

      const newContentRaw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

      // File vượt giới hạn số dòng -> coi như không tồn tại với extension:
      // không giữ baseline, không mở diff. Xoá cả baseline cũ phòng khi file
      // vừa vượt ngưỡng (hoặc user vừa hạ setting xuống).
      if (exceedsLineLimit(newContentRaw)) {
        this.snapshots.markSkipped(absPath);
        return;
      }

      // Trong window external batch (vd: git checkout): chỉ refresh baseline,
      // không tạo diff. Tránh việc so working tree mới với baseline branch cũ.
      if (this.isSuppressed()) {
        this.snapshots.set(absPath, newContentRaw);
        return;
      }

      // File bị .gitignore loại thì không vào hàng chờ review. `markSkipped()`
      // chứ không chỉ `return`: nếu sau này nó được gỡ khỏi .gitignore, "không
      // có baseline" sẽ bị hiểu là file mới -> diff toàn-file-thêm-mới, và
      // Revert all trên đó xoá mất file.
      if (await isGitIgnored(absPath)) {
        this.snapshots.markSkipped(absPath);
        return;
      }

      const oldContentRaw = this.snapshots.get(absPath);

      // So sánh trên LF thuần, KHÔNG trim: `trim()` nuốt mất mọi thay đổi chỉ
      // đụng tới biên file (thêm/bớt newline cuối, bớt dòng trắng đầu file,
      // cắt khoảng trắng thừa cuối file) — những thứ AI CLI sửa rất thường
      // xuyên. Nuốt xong baseline vẫn bị ghi đè bên dưới, nên thay đổi đó biến
      // mất vĩnh viễn, không bao giờ mở được diff để review.
      //
      // Cùng phép chuẩn hoá với `calculateHunks(toLf(...), toLf(...))` ở
      // `openDiff()`, nên thay đổi thuần EOL vẫn cho 0 hunk như trước.
      const newContent = toLf(newContentRaw);
      const oldContent = oldContentRaw !== undefined ? toLf(oldContentRaw) : undefined;

      if (oldContent === undefined) {
        this.snapshots.set(absPath, newContentRaw);
        // File từng bị bỏ qua vì quá lớn và giờ vừa lọt xuống dưới ngưỡng:
        // nó KHÔNG phải file mới. Không có baseline cũ để so, nên chỉ nhận nội
        // dung hiện tại làm baseline rồi thôi. Mở diff ở đây sẽ hiện cả file là
        // "thêm mới", và Revert all trên diff đó sẽ xoá mất file.
        if (this.snapshots.consumeSkipped(absPath)) { return; }
        if (newContent.trim()) {
          this.resolveOrHold(absPath, '', newContentRaw, false, burstHold);
        }
        return;
      }

      if (oldContent === newContent) {
        // toLf() bỏ qua EOL, nên nhánh này còn nuốt cả trường hợp
        // file chỉ đổi CRLF <-> LF. Phải refresh baseline raw trước khi thoát,
        // nếu không snapshot giữ EOL cũ vĩnh viễn và lần sửa 1 dòng kế tiếp sẽ
        // bị so lệch EOL -> diff phủ cả file (bug #15).
        this.snapshots.set(absPath, newContentRaw);
        return;
      }

      // Trước khi trigger diff mới, cập nhật baseline vào snapshot store của watcher
      // để lần save kế tiếp không bị trigger lại.
      this.snapshots.set(absPath, newContentRaw);

      if (!this.diffManager.hasPendingDiff(absPath)) {
        this.resolveOrHold(absPath, oldContentRaw!, newContentRaw, true, burstHold);
      }
    } catch {
      // file đang bị lock, không có quyền đọc hoặc đã bị xóa — bỏ qua
    }
  }

  private triggerDiff(
    filePath: string,
    originalContent: string,
    newContent: string,
    fileExistedBefore: boolean,
    fromBurstDump = false
  ): void {
    this.diffManager.loadSnapshot(filePath, originalContent, fileExistedBefore);
    // `auto: true` — đây là đường AI ghi file, không phải user bấm mở. Xem
    // DiffManager.openDiff(): đang review dở thì file mới chỉ vào hàng chờ.
    this.diffManager.openDiff(filePath, { auto: true, preserveFocus: fromBurstDump }).catch((err: unknown) => {
      console.error('[ai-cli-diff-view] workspaceWatcher openDiff failed:', err);
    });
  }

  /**
   * File dưới ngưỡng burst: mở diff ngay như trước. File vượt ngưỡng: giữ lại
   * chờ `holdMs` — nếu trong lúc chờ git branch được xác nhận đổi thật
   * (`notifyExternalBatch()` chạy), file bị bỏ âm thầm; nếu không, mở diff
   * bình thường sau khi hết giờ chờ, như chưa từng bị giữ.
   */
  private resolveOrHold(
    filePath: string,
    originalContent: string,
    newContent: string,
    fileExistedBefore: boolean,
    hold: boolean
  ): void {
    // Ghi lại tab đang active THẬT SỰ trước khi mở diff — chỉ ở write ĐẦU
    // TIÊN của 1 cụm (cách write gần nhất > ACTIVE_TAB_CAPTURE_GAP_MS), để
    // không ghi đè bằng activeTab đã bị các openDiff() không đồng bộ trước đó
    // trong cùng cụm làm ngẫu nhiên. Áp dụng cho cả nhánh mở ngay (checkout
    // đổi ít file, dưới ngưỡng burst nhưng vẫn ghi gần như đồng thời) lẫn
    // nhánh hold-rồi-dump — không chỉ riêng burst. DiffManager.clearAll() sẽ
    // dùng hint này thay vì activeTab tại thời điểm clear (đã có thể bị hỏng
    // bởi race) nếu git branch đổi ngay sau đó.
    const now = Date.now();
    if (now - this.lastAutoOpenActivityAt > WorkspaceWatcher.ACTIVE_TAB_CAPTURE_GAP_MS) {
      this.diffManager.markActiveTabBeforeAutoOpen();
    }
    this.lastAutoOpenActivityAt = now;

    if (!hold) {
      this.triggerDiff(filePath, originalContent, newContent, fileExistedBefore);
      return;
    }
    this.heldWrites.set(filePath, { originalContent, newContent, fileExistedBefore });
    this.scheduleHoldResolve();
  }

  /** Debounce dùng chung cho cả cụm burst: mỗi file mới vào hàng chờ sẽ reset lại. */
  private scheduleHoldResolve(): void {
    if (this.holdResolveTimer) {
      clearTimeout(this.holdResolveTimer);
    }
    this.holdResolveTimer = setTimeout(() => {
      this.holdResolveTimer = undefined;
      const entries = Array.from(this.heldWrites.entries());
      this.heldWrites.clear();
      for (const [filePath, w] of entries) {
        this.triggerDiff(filePath, w.originalContent, w.newContent, w.fileExistedBefore, true);
      }
    }, this.holdMs);
  }

  /**
   * Workspace folder chứa file này, hoặc undefined nếu nó nằm ngoài workspace.
   *
   * So khớp theo RANH GIỚI segment chứ không phải `startsWith` trần: với root
   * `/home/me/proj`, một `startsWith` sẽ nhận nhầm cả `/home/me/proj-backup/x.ts`.
   *
   * Trả về chính root (chưa normalize) vì `isExcludedPathSegment()` cần nó để
   * đọc đường tương đối so với project.
   */
  private workspaceRootFor(filePath: string): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return undefined; }
    const normalizedPath = this.normalizePath(filePath);
    let best: { root: string; length: number } | undefined;
    for (const folder of folders) {
      const root = this.normalizePath(folder.uri.fsPath);
      const contained =
        normalizedPath === root ||
        normalizedPath.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
      // Workspace lồng nhau: lấy root khớp DÀI NHẤT, để đường tương đối được
      // tính so với project gần nhất.
      if (contained && (best === undefined || root.length > best.length)) {
        best = { root: folder.uri.fsPath, length: root.length };
      }
    }
    return best?.root;
  }

  /** Cập nhật snapshot khi người dùng tự sửa file (để baseline luôn đúng) */
  updateSnapshot(filePath: string, content: string): void {
    this.snapshots.set(this.normalizePath(filePath), content);
  }

  /**
   * File bị xoá khỏi đĩa. Nếu nó đang có diff pending thì snapshot phải được bỏ
   * đi, nếu không pending list giữ lại một file không còn tồn tại.
   *
   * Không bỏ ngay: rất nhiều tool ghi file bằng temp + rename, nên watcher bắn
   * `delete` rồi `create` ngay sau đó. Bỏ snapshot ở nhịp `delete` sẽ biến lần
   * ghi ấy thành "file mới" và diff hiện nguyên cả file thay vì đúng phần sửa.
   * Đợi xác nhận file thật sự không còn rồi mới bỏ.
   */
  private handleExternalDelete(uri: vscode.Uri): void {
    const absPath = this.normalizePath(uri.fsPath);
    if (!this.diffManager.hasPendingDiff(absPath)) { return; }

    this.cancelPendingDeletion(absPath);

    const timer = setTimeout(() => {
      this.pendingDeletions.delete(absPath);
      this.pendingTimers.delete(timer);
      void this.confirmDeletion(absPath);
    }, WorkspaceWatcher.DELETE_CONFIRM_MS);
    this.pendingDeletions.set(absPath, timer);
    this.pendingTimers.add(timer);
  }

  private async confirmDeletion(absPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
      // File đã quay lại — đó là một lần ghi, không phải xoá.
      return;
    } catch {
      // Đọc stat không được = mất thật.
    }
    await this.diffManager.dropDeletedFile(absPath);
  }

  private cancelPendingDeletion(absPath: string): void {
    const timer = this.pendingDeletions.get(absPath);
    if (!timer) { return; }
    clearTimeout(timer);
    this.pendingDeletions.delete(absPath);
    this.pendingTimers.delete(timer);
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    if (this.holdResolveTimer) {
      clearTimeout(this.holdResolveTimer);
      this.holdResolveTimer = undefined;
    }
    this.heldWrites.clear();
    this.pendingDeletions.clear();
    this.queuedExternalWrites.clear();
    this.lastProcessed.clear();
    this.savedFilesByVsCode.clear();
  }
}
