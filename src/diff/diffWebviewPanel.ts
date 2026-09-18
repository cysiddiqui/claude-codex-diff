/**
 * diffWebviewPanel.ts
 *
 * Cursor-style diff editor.
 *
 * MỘT webview duy nhất cho MỌI file pending, không phải một tab cho mỗi file.
 *
 * Bản cũ dùng CustomTextEditorProvider: mỗi pending file mở một tab riêng, tức
 * một webview riêng, tức Monaco phải nạp lại từ đầu — ~3.8 MB (loader, 3.5 MB
 * `editor.main.js`, nls, css) kéo qua remote connection rồi parse lại. Bấm
 * next/prev qua 20 file là 20 lần nạp Monaco. Đó là toàn bộ độ trễ 1–2 giây.
 *
 * Giữ một panel sống (`retainContextWhenHidden`) và chỉ đổi NỘI DUNG bên trong
 * thì Monaco nạp đúng một lần mỗi session; chuyển file chỉ còn là một
 * postMessage + tính hunk, tính bằng mili giây. `applySet()` phía webview vốn
 * đã xử lý được việc đổi sang file khác (`isSameFile` sai -> dispose model cũ,
 * tạo model mới) — trước giờ không đường nào gọi tới nhánh đó.
 *
 * Đánh đổi: mỗi lần chỉ xem được một diff. Đó đúng là cách Cursor làm.
 *
 * Snapshot (vế trái) nằm ở DiffManager; TextDocument của file cho vế phải.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DiffManager } from './diffManager';
import { calculateHunks } from './hunkCalculator';
import { fromLf, toLf } from './eol';

/** viewType của panel. KHÁC id custom editor cũ, để tab cũ còn sót không cố khôi phục vào đây. */
export const DIFF_PANEL_VIEW_TYPE = 'ai-cli-diff-view.diffPanel';

/** Key lưu file đang hiển thị, để serializer khôi phục đúng file sau khi reload window. */
const LAST_SHOWN_KEY = 'ai-cli-diff-view.lastShownDiff';

/**
 * Mọi message từ webview đều kèm `filePath` của file nó ĐANG hiển thị.
 *
 * Bắt buộc từ khi dùng chung một webview: bấm Accept rồi bấm next thật nhanh
 * thì message Accept có thể tới sau khi panel đã đổi sang file khác, và nếu
 * chỉ đọc "file hiện tại" thì ta accept nhầm file. Path đi kèm message cho
 * phép bỏ qua những message đã lỗi thời.
 */
type IncomingMsg =
  | { type: 'ready' }
  | { type: 'acceptHunk'; filePath?: string; newOriginal: string; newCurrent: string }
  | { type: 'rejectHunk'; filePath?: string; newOriginal: string; newCurrent: string }
  | { type: 'editModified'; filePath?: string; newCurrent: string }
  | { type: 'acceptAll'; filePath?: string }
  | { type: 'rejectAll'; filePath?: string }
  | { type: 'nextFile'; filePath?: string }
  | { type: 'prevFile'; filePath?: string }
  | { type: 'save'; filePath?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'cursor'; filePath?: string; line: number; column: number; topLine?: number };

export class DiffPanelHost {
  private panel: vscode.WebviewPanel | undefined;
  /** File đang hiển thị (đã normalize). `undefined` = panel còn sống nhưng chưa gắn file nào. */
  private currentPath: string | undefined;
  private currentDoc: vscode.TextDocument | undefined;
  private webviewReady = false;
  private pendingSet = false;
  /** Disposable theo vòng đời của PANEL, dọn khi panel bị dispose. */
  private panelDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly diffManager: DiffManager,
    private readonly context: vscode.ExtensionContext
  ) {}

  /** File đang hiển thị, hoặc `undefined` nếu không có panel / chưa gắn file. */
  get activeFilePath(): string | undefined {
    return this.panel ? this.currentPath : undefined;
  }

  hasPanel(): boolean {
    return this.panel !== undefined;
  }

  /** Tab diff có đang là tab active của window không. */
  isActiveTab(): boolean {
    return this.panel?.active === true;
  }

  /**
   * Hiển thị `filePath`. Tạo panel ở lần đầu; các lần sau chỉ đổi nội dung —
   * đó chính là chỗ tiết kiệm được một lần nạp Monaco.
   */
  async show(filePath: string, options?: { preserveFocus?: boolean }): Promise<void> {
    const absPath = normalizePath(filePath);
    const preserveFocus = options?.preserveFocus === true;
    const isNewPanel = this.panel === undefined;

    // Dựng panel TRƯỚC khi đọc document. Panel vừa tạo là webview bắt đầu kéo
    // ~3.8 MB Monaco ngay lập tức; đọc document chạy song song với nó. Làm
    // ngược lại (await document rồi mới tạo panel) là nối đuôi hai việc vốn
    // chồng lên nhau được — `vscode.openWith` của bản custom editor cũ vẫn
    // chồng, nên đảo thứ tự là tự làm lần mở đầu tiên chậm đi.
    if (isNewPanel) {
      this.createPanel(preserveFocus);
    }

    let doc: vscode.TextDocument;
    const tDoc = Date.now();
    try {
      doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(canonicalCasePath(absPath))
      );
      console.log(
        '[ai-cli-diff TIMING ext] openTextDocument ' + (Date.now() - tDoc) + 'ms ' +
        (isNewPanel ? '(overlapped with Monaco load)' : '(panel reused)')
      );
    } catch (err) {
      console.error('[ai-cli-diff] cannot open document for diff:', err);
      // Panel vừa tạo cho lần mở hỏng này thì đừng để lại tab rỗng.
      if (isNewPanel) { this.close(); }
      return;
    }
    // Panel có thể đã bị đóng trong lúc chờ đọc document.
    if (!this.panel) { return; }

    this.currentPath = absPath;
    this.currentDoc = doc;
    this.panel.title = path.basename(absPath);
    void this.context.workspaceState.update(LAST_SHOWN_KEY, absPath);

    if (!isNewPanel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, preserveFocus);
    }
    // Panel mới: Monaco chưa dựng xong, `ready` sẽ gọi postSet().
    // Panel cũ (hoặc `ready` đã tới trong lúc chờ document): đẩy nội dung luôn.
    if (this.webviewReady) {
      this.postSet();
    }
  }

  /**
   * File đang hiển thị vừa rời pending list (accept / revert / bị xoá).
   * Giữ webview sống — caller thường `show()` file kế tiếp ngay sau đó, và
   * dispose rồi tạo lại chính là thứ đang phải tránh.
   */
  detachIfShowing(filePath: string): void {
    if (this.currentPath !== normalizePath(filePath)) { return; }
    this.currentPath = undefined;
    this.currentDoc = undefined;
  }

  /** Không còn file nào để hiển thị -> đóng hẳn tab. */
  closeIfDetached(): void {
    if (this.panel && this.currentPath === undefined) {
      this.close();
    }
  }

  close(): void {
    this.panel?.dispose();
  }

  /**
   * Khôi phục panel sau khi reload window (registerWebviewPanelSerializer).
   * File cũ không còn pending thì đóng luôn, không để lại một tab rỗng.
   */
  adopt(panel: vscode.WebviewPanel): void {
    if (this.panel && this.panel !== panel) {
      this.panel.dispose();
    }
    this.panel = panel;
    this.wirePanel(panel);

    const last = this.context.workspaceState.get<string>(LAST_SHOWN_KEY);
    if (!last || !this.diffManager.hasPendingDiff(last)) {
      panel.dispose();
      return;
    }
    void this.show(last, { preserveFocus: true });
  }

  private createPanel(preserveFocus: boolean): void {
    const panel = vscode.window.createWebviewPanel(
      DIFF_PANEL_VIEW_TYPE,
      'AI CLI Diff',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      {
        enableScripts: true,
        localResourceRoots: this.resourceRoots(),
        // Không giữ thì mỗi lần chuyển tab là một lần nạp lại Monaco — đúng
        // cái đang sửa. Chỉ có MỘT panel nên chi phí bộ nhớ là cố định.
        retainContextWhenHidden: true,
      }
    );
    this.panel = panel;
    // Options đã truyền lúc tạo — gán lại `webview.options` sẽ reset webview.
    this.wirePanel(panel, { setOptions: false });
  }

  private resourceRoots(): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'monaco-editor', 'min'),
      vscode.Uri.joinPath(this.extensionUri, 'res', 'webview'),
    ];
  }

  /** Gắn html + toàn bộ listener. Chạy một lần mỗi PANEL, không phải mỗi file. */
  private wirePanel(panel: vscode.WebviewPanel, opts?: { setOptions?: boolean }): void {
    const t0 = Date.now();
    const tlog = (label: string): void => {
      console.log('[ai-cli-diff TIMING ext] +' + (Date.now() - t0) + 'ms ' + label);
    };
    tlog('panel created');

    this.webviewReady = false;
    this.pendingSet = false;

    if (opts?.setOptions !== false) {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: this.resourceRoots(),
      };
    }
    panel.webview.html = this.buildHtml(panel.webview);
    tlog('webview.html assigned');

    const d = this.panelDisposables;

    d.push(
      panel.webview.onDidReceiveMessage(async (msg: IncomingMsg) => {
        if (msg.type === 'ready') {
          this.webviewReady = true;
          tlog('received ready from webview');
          this.postSet();
          return;
        }
        if (msg.type === 'undo') {
          await vscode.commands.executeCommand('undo');
          return;
        }
        if (msg.type === 'redo') {
          await vscode.commands.executeCommand('redo');
          return;
        }

        // Message nói về một file khác với file đang hiển thị = đã lỗi thời
        // (user chuyển file trước khi message kịp tới). Bỏ qua, đừng ghi nhầm.
        const target = this.resolveTarget(msg.filePath);
        if (target === undefined) { return; }

        switch (msg.type) {
          case 'acceptHunk':
            await this.diffManager.applyHunkAcceptFromWebview(target, msg.newOriginal, msg.newCurrent);
            return;
          case 'rejectHunk':
            await this.diffManager.applyHunkRejectFromWebview(target, msg.newOriginal, msg.newCurrent);
            return;
          case 'editModified':
            await this.applyModifiedEdit(target, msg.newCurrent);
            return;
          case 'acceptAll':
            await this.diffManager.accept(target);
            return;
          case 'rejectAll':
            await this.diffManager.revert(target);
            return;
          case 'nextFile':
            await this.gotoSibling(target, +1);
            return;
          case 'prevFile':
            await this.gotoSibling(target, -1);
            return;
          case 'save':
            await this.currentDoc?.save();
            return;
          case 'cursor':
            this.diffManager.setLastCursor(target, msg.line, msg.column, msg.topLine);
            return;
        }
      })
    );

    // File đang hiển thị đổi nội dung (AI ghi, user gõ, accept hunk...).
    d.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.currentDoc === undefined) { return; }
        if (e.document.uri.toString() !== this.currentDoc.uri.toString()) { return; }
        if (this.webviewReady) {
          this.postSet();
        } else {
          this.pendingSet = true;
        }
      })
    );

    // Snapshot hoặc pending list đổi.
    d.push(
      this.diffManager.onDidChangeDiffs((changedPath) => {
        if (this.currentPath === undefined) { return; }
        if (!this.webviewReady) {
          this.pendingSet = true;
          return;
        }
        // Đúng file đang xem thì phải diff lại; file khác thì chỉ mẫu số của
        // counter đổi — gửi nguyên nội dung hai vế cho việc đó là lãng phí.
        if (changedPath === undefined || changedPath === this.currentPath) {
          this.postSet();
        } else {
          this.postNav();
        }
      })
    );

    d.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        void panel.webview.postMessage({ type: 'theme-change', theme: currentMonacoTheme() });
      })
    );

    d.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('editor')) { return; }
        void panel.webview.postMessage({ type: 'config-change', editorConfig: readEditorConfig() });
      })
    );

    // Webview bị ẩn thì iframe không có kích thước; khi hiện lại Monaco có thể
    // còn giữ số đo cũ và chỉ vẽ được vài dòng. Ép đo lại.
    d.push(
      panel.onDidChangeViewState(() => {
        if (!panel.visible) { return; }
        void panel.webview.postMessage({ type: 'relayout' });
      })
    );

    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.currentPath = undefined;
        this.currentDoc = undefined;
        this.webviewReady = false;
        this.pendingSet = false;
        void this.context.workspaceState.update(LAST_SHOWN_KEY, undefined);
      }
      while (this.panelDisposables.length) {
        this.panelDisposables.pop()?.dispose();
      }
    });

    // Webview có thể `ready` trước khi listener kịp gắn (hiếm, nhưng rẻ để chặn).
    if (this.pendingSet && this.webviewReady) {
      this.postSet();
    }
  }

  /**
   * Path mà message này thực sự nói về, hoặc `undefined` nếu nó đã lỗi thời.
   * Webview cũ chưa gửi kèm path -> tin vào file đang hiển thị.
   */
  private resolveTarget(fromMsg: string | undefined): string | undefined {
    if (this.currentPath === undefined) { return undefined; }
    if (fromMsg === undefined) { return this.currentPath; }
    return normalizePath(fromMsg) === this.currentPath ? this.currentPath : undefined;
  }

  private postSet(): void {
    if (!this.panel || this.currentPath === undefined || this.currentDoc === undefined) { return; }
    const absPath = this.currentPath;
    const snapshot = this.diffManager.getSnapshotContent(absPath);
    if (snapshot === undefined) {
      // Snapshot vừa biến mất (accept-all chẳng hạn) — không còn gì để vẽ.
      this.detachIfShowing(absPath);
      this.closeIfDetached();
      return;
    }
    // Webview sống hoàn toàn trong LF: nó splice/join nội dung bằng '\n'
    // (diff.monaco.js) rồi gửi ngược về, nên hai vế phải cùng ở LF thuần.
    // EOL thật được khôi phục ở applyModifiedEdit() / DiffManager.writeFile().
    const originalContent = toLf(snapshot);
    const currentContent = toLf(this.currentDoc.getText());
    this.pendingSet = false;
    void this.panel.webview.postMessage({
      type: 'set',
      filePath: absPath,
      language: detectLanguageId(absPath),
      originalContent,
      currentContent,
      hunks: calculateHunks(originalContent, currentContent),
      theme: currentMonacoTheme(),
      editorConfig: readEditorConfig(),
      nav: this.computeNav(absPath),
    });
  }

  private postNav(): void {
    if (!this.panel || this.currentPath === undefined) { return; }
    void this.panel.webview.postMessage({ type: 'nav', nav: this.computeNav(this.currentPath) });
  }

  private async applyModifiedEdit(absPath: string, newCurrent: string): Promise<void> {
    const document = this.currentDoc;
    if (!document || normalizePath(document.uri.fsPath) !== absPath) { return; }
    // newCurrent từ webview luôn ở LF -> khôi phục EOL của document trước khi so
    // sánh lẫn khi ghi, nếu không file CRLF sẽ bị viết lại thành LF.
    const expanded = fromLf(
      newCurrent,
      document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
    );
    if (document.getText() === expanded) { return; }
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      document.lineAt(document.lineCount - 1).range.end
    );
    edit.replace(document.uri, fullRange, expanded);
    await vscode.workspace.applyEdit(edit);
  }

  private async gotoSibling(currentPath: string, direction: 1 | -1): Promise<void> {
    const pending = this.diffManager.getPendingFiles();
    if (pending.length <= 1) { return; }
    const idx = pending.findIndex(p => normalizePath(p) === currentPath);
    if (idx === -1) { return; }
    const nextPath = pending[(idx + direction + pending.length) % pending.length];
    if (!nextPath) { return; }
    await this.diffManager.openDiff(nextPath);
  }

  private computeNav(absPath: string): { currentIdx: number; total: number } {
    const pending = this.diffManager.getPendingFiles();
    const idx = pending.findIndex(p => normalizePath(p) === absPath);
    return { currentIdx: idx === -1 ? 0 : idx + 1, total: pending.length };
  }

  private buildHtml(webview: vscode.Webview): string {
    const monacoBase = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'monaco-editor', 'min', 'vs')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'res', 'webview', 'diff.monaco.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'res', 'webview', 'diff.monaco.css')
    );
    const cspSource = webview.cspSource;
    const nonce = makeNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    img-src ${cspSource} data:;
    style-src ${cspSource} 'unsafe-inline';
    font-src ${cspSource} data:;
    script-src ${cspSource} 'nonce-${nonce}' 'unsafe-eval';
    connect-src ${cspSource};
    worker-src blob:;
    child-src blob:;
  " />
  <link rel="stylesheet" href="${styleUri}" />
  <title>AI CLI Diff</title>
</head>
<body>
  <div id="toolbar">
    <div class="pill pill-hunks">
      <button id="btn-prev-hunk" class="nav-btn" title="Previous hunk (Shift+F7)" aria-label="Previous hunk">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>
      </button>
      <span id="hunk-counter">0 / 0</span>
      <button id="btn-next-hunk" class="nav-btn" title="Next hunk (F7)" aria-label="Next hunk">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>
      </button>
      <button id="btn-reject-file" class="toolbar-btn reject" title="Reject all changes in this file">Reject</button>
      <button id="btn-accept-file" class="toolbar-btn accept" title="Accept all changes in this file (Ctrl+Shift+Y)">Accept All</button>
    </div>
    <div class="pill pill-files">
      <button id="btn-prev-file" class="nav-btn" title="Previous file (Alt+H)" aria-label="Previous file">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4l-4 4 4 4"/></svg>
      </button>
      <span id="file-counter">0 / 0</span>
      <button id="btn-next-file" class="nav-btn" title="Next file (Alt+L)" aria-label="Next file">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>
      </button>
    </div>
    <span id="toolbar-file"></span>
  </div>
  <div id="container"></div>

  <script nonce="${nonce}">
    window.__MONACO_BASE__ = "${monacoBase}";
    // Theme mặc định của Monaco là 'vs' — theme SÁNG (standaloneThemeService
    // gọi setTheme(VS_LIGHT_THEME_NAME) ngay trong constructor). Không truyền
    // theme thì editor dựng xong vẽ trắng cho tới khi message 'set' quay về —
    // đó đúng là cái chớp trắng. Biết theme ngay trong HTML thì không còn
    // frame nào sai màu.
    window.__INITIAL_THEME__ = "${currentMonacoTheme()}";
  </script>
  <script nonce="${nonce}" src="${monacoBase}/loader.js"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function currentMonacoTheme(): string {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light: return 'vs';
    case vscode.ColorThemeKind.Dark: return 'vs-dark';
    case vscode.ColorThemeKind.HighContrast: return 'hc-black';
    case vscode.ColorThemeKind.HighContrastLight: return 'hc-light';
    default: return 'vs-dark';
  }
}

interface EditorConfigPayload {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  insertSpaces: boolean;
  wordWrap: string;
  renderWhitespace: string;
  minimapEnabled: boolean;
}

function readEditorConfig(): EditorConfigPayload {
  const cfg = vscode.workspace.getConfiguration('editor');
  return {
    fontFamily: cfg.get<string>('fontFamily', 'Consolas, "Courier New", monospace'),
    fontSize: cfg.get<number>('fontSize', 14),
    lineHeight: cfg.get<number>('lineHeight', 0),
    tabSize: cfg.get<number>('tabSize', 4),
    insertSpaces: cfg.get<boolean>('insertSpaces', true),
    wordWrap: cfg.get<string>('wordWrap', 'off'),
    renderWhitespace: cfg.get<string>('renderWhitespace', 'selection'),
    minimapEnabled: cfg.get<boolean>('minimap.enabled', true),
  };
}

function normalizePath(filePath: string): string {
  const fsPath = vscode.Uri.file(path.resolve(filePath)).fsPath;
  return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

/** Case canonical từ OS, để tiêu đề tab hiện đúng như trên đĩa. */
function canonicalCasePath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

function detectLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts': case '.tsx': return 'typescript';
    case '.js': case '.jsx': case '.mjs': case '.cjs': return 'javascript';
    case '.json': return 'json';
    case '.html': case '.htm': return 'html';
    case '.css': return 'css';
    case '.scss': return 'scss';
    case '.less': return 'less';
    case '.md': case '.markdown': return 'markdown';
    case '.py': return 'python';
    case '.go': return 'go';
    case '.rs': return 'rust';
    case '.java': return 'java';
    case '.kt': case '.kts': return 'kotlin';
    case '.c': case '.h': return 'c';
    case '.cpp': case '.cc': case '.cxx': case '.hpp': return 'cpp';
    case '.cs': return 'csharp';
    case '.php': return 'php';
    case '.rb': return 'ruby';
    case '.sh': case '.bash': case '.zsh': return 'shell';
    case '.yaml': case '.yml': return 'yaml';
    case '.xml': return 'xml';
    case '.sql': return 'sql';
    case '.swift': return 'swift';
    case '.lua': return 'lua';
    case '.dart': return 'dart';
    case '.vue': return 'html';
    default: return 'plaintext';
  }
}
