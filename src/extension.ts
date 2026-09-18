import * as vscode from 'vscode';
import { DiffManager } from './diff/diffManager';
import { DiffPanelHost, DIFF_PANEL_VIEW_TYPE } from './diff/diffWebviewPanel';
import { IAiRunner } from './runner/aiRunner';
import { WorkspaceWatcher } from './watcher/workspaceWatcher';
import { refreshTextFileRules } from './watcher/fileTypeRules';
import { refreshFileSizeLimit } from './watcher/fileSizeLimit';
import { refreshGitIgnoreSetting } from './watcher/gitignore';
import { GitBranchWatcher } from './watcher/gitBranchWatcher';
import { registerAllCommands } from './commands/commandsRegistry';
import { NavigationManager } from './diff/navigationManager';
import { NavBarPanel } from './views/navBarPanel';
import { TerminalPanelProvider } from './terminal/terminalPanel';

export function activate(context: vscode.ExtensionContext): void {
  refreshTextFileRules();
  refreshFileSizeLimit();
  refreshGitIgnoreSetting();

  const diffManager       = new DiffManager(context);
  const workspaceWatcher  = new WorkspaceWatcher(diffManager);
  const gitBranchWatcher  = new GitBranchWatcher(diffManager, context.workspaceState, workspaceWatcher);
  const navigationManager = new NavigationManager(diffManager);

  // MỘT panel diff dùng chung cho mọi file. Không còn custom editor: mỗi tab
  // custom editor là một webview riêng, tức một lần nạp Monaco riêng (~3.8 MB),
  // và đó là toàn bộ độ trễ khi bấm next/prev. Xem diffWebviewPanel.ts.
  const diffPanelHost = new DiffPanelHost(context.extensionUri, diffManager, context);
  diffManager.attachPanelHost(diffPanelHost);
  context.subscriptions.push(
    // Sau khi reload window, VS Code khôi phục tab webview — không có
    // serializer thì nó hiện một tab lỗi. Host tự quyết định mở lại file cũ
    // hay đóng tab đi nếu file đó không còn pending.
    vscode.window.registerWebviewPanelSerializer(DIFF_PANEL_VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        diffPanelHost.adopt(panel);
      },
    }),
    { dispose: () => diffPanelHost.close() }
  );

  const navBarPanel = new NavBarPanel(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(NavBarPanel.viewType, navBarPanel)
  );

  let activeRunner: IAiRunner | undefined;

  context.subscriptions.push(
    { dispose: () => diffManager.disposeAll() },
    { dispose: () => workspaceWatcher.dispose() },
    { dispose: () => gitBranchWatcher.dispose() },
    { dispose: () => activeRunner?.cancel?.() }
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ai-cli-diff-view.supportedFileDetectionMode') ||
          e.affectsConfiguration('ai-cli-diff-view.supportedFileExtensions') ||
          e.affectsConfiguration('ai-cli-diff-view.supportedFilenames') ||
          e.affectsConfiguration('ai-cli-diff-view.supportedFilenamePatterns')) {
        refreshTextFileRules();
      }
      if (e.affectsConfiguration('ai-cli-diff-view.maxFileLines')) {
        refreshFileSizeLimit();
      }
      if (e.affectsConfiguration('ai-cli-diff-view.respectGitignore')) {
        refreshGitIgnoreSetting();
      }
    })
  );

  const terminalPanel = new TerminalPanelProvider(context, diffManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TerminalPanelProvider.viewType,
      terminalPanel,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    { dispose: () => terminalPanel.dispose() }
  );

  const MOVED_RIGHT_KEY = 'ai-cli-diff-view.terminal.movedToRight';
  if (!context.globalState.get<boolean>(MOVED_RIGHT_KEY)) {
    void context.globalState.update(MOVED_RIGHT_KEY, true);
    setTimeout(() => {
      void (async () => {
        try {
          await vscode.commands.executeCommand('ai-cli-diff-view.terminal.focus');
          await vscode.commands.executeCommand('workbench.action.moveView', {
            viewId: TerminalPanelProvider.viewType,
            destinationId: 'workbench.view.auxiliarybar',
          });
        } catch {
          // Best-effort; if API changes, user can drag panel manually.
        }
      })();
    }, 1500);
  }

  workspaceWatcher.start();
  gitBranchWatcher.start();

  registerAllCommands({
    diffManager,
    panel: terminalPanel,
    context,
    getRunner: () => activeRunner,
    setRunner: (r) => { activeRunner = r; },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.nextFile', () => navigationManager.nextFile()),
    vscode.commands.registerCommand('ai-cli-diff-view.prevFile', () => navigationManager.prevFile())
  );

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && terminalPanel.wasTerminalFocused()) {
        terminalPanel.focusTerminal();
      }
    })
  );

  function updateNavBarState(): void {
    const pendingFiles = diffManager.getPendingFiles();
    if (pendingFiles.length === 0) {
      navBarPanel.setActiveFile(undefined);
      navBarPanel.update(undefined);
      void vscode.commands.executeCommand('setContext', 'ai-cli-diff-view.hasPendingDiff', false);
      return;
    }

    const activePath = diffManager.getActiveFilePath();
    navBarPanel.setActiveFile(activePath);
    const navAnchor = activePath ?? pendingFiles[0];
    navBarPanel.update(navigationManager.getNavigationInfo(navAnchor));
    void vscode.commands.executeCommand('setContext', 'ai-cli-diff-view.hasPendingDiff', true);
  }

  context.subscriptions.push(
    diffManager.onDidChangeDiffs(() => {
      updateNavBarState();
    })
  );
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => updateNavBarState())
  );

  const autoRouteTab = (tab: vscode.Tab): void => {
    if (!(tab.input instanceof vscode.TabInputText)) { return; }
    const fsPath = tab.input.uri.fsPath;
    if (!diffManager.hasPendingDiff(fsPath)) { return; }
    void (async () => {
      try {
        await vscode.window.tabGroups.close(tab);
        await diffManager.openDiff(fsPath);
      } catch (err) {
        console.error('[ai-cli-diff] auto-route failed:', err);
      }
    })();
  };

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.opened) { autoRouteTab(tab); }
      for (const tab of e.changed) { autoRouteTab(tab); }
    })
  );

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) { autoRouteTab(tab); }
  }

  updateNavBarState();
}

export function deactivate(): void {}
