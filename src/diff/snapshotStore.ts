/**
 * snapshotStore.ts
 *
 * Persistence layer cho diff snapshots: đọc/ghi `context.workspaceState`
 * dưới key `ai-cli-diff.snapshots`, kèm xử lý backward-compat với shape
 * cũ (entry là string thay vì object).
 */

import * as fs from 'fs';
import * as vscode from 'vscode';

const STATE_KEY = 'ai-cli-diff.snapshots';

/**
 * Mỗi lần ghi phải serialise TOÀN BỘ map — tức toàn bộ nội dung gốc của mọi
 * file đang chờ review. Với 200 file đang chờ, đó là vài MB cho mỗi thay đổi
 * nhỏ, mà một cụm AI edit thì bắn ra hàng chục thay đổi liền nhau. Gộp chúng
 * lại: chỉ trạng thái CUỐI mới đáng ghi.
 */
const SAVE_DEBOUNCE_MS = 250;

export interface SnapshotState {
  content: string;
  fileExistedBefore: boolean;
}

export class SnapshotStore {
  private saveTimer: NodeJS.Timeout | undefined;
  /** Map sống do DiffManager giữ; serialise ở thời điểm flush nên luôn là bản mới nhất. */
  private pending: Map<string, SnapshotState> | undefined;

  constructor(private readonly workspaceState: vscode.Memento) {}

  /**
   * Đọc snapshot đã persist trước đó. Bỏ qua entry mà file không còn tồn tại.
   */
  load(): Map<string, SnapshotState> {
    const saved = this.workspaceState.get<Record<string, string | SnapshotState>>(STATE_KEY, {});
    const result = new Map<string, SnapshotState>();
    for (const [absPath, savedSnapshot] of Object.entries(saved)) {
      if (!fs.existsSync(absPath)) { continue; }
      result.set(absPath, normalizeSavedSnapshot(savedSnapshot));
    }
    return result;
  }

  /** Hẹn ghi. Nhiều lần gọi liên tiếp gộp thành một lần ghi duy nhất. */
  save(snapshots: Map<string, SnapshotState>): void {
    this.pending = snapshots;
    if (this.saveTimer) { return; }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Ghi ngay phần đang chờ. Phải gọi lúc shutdown: mất lần ghi cuối nghĩa là
   * sau khi mở lại cửa sổ, các diff đang chờ biến mất.
   */
  flush(): Thenable<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const snapshots = this.pending;
    this.pending = undefined;
    if (snapshots === undefined) { return Promise.resolve(); }

    const obj: Record<string, SnapshotState> = {};
    for (const [absPath, snapshot] of snapshots.entries()) {
      obj[absPath] = snapshot;
    }
    return this.workspaceState.update(STATE_KEY, obj);
  }

  clear(): Thenable<void> {
    // Huỷ lần ghi đang chờ, nếu không nó sẽ hồi sinh lại đúng thứ vừa xoá.
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.pending = undefined;
    return this.workspaceState.update(STATE_KEY, undefined);
  }
}

function normalizeSavedSnapshot(savedSnapshot: string | SnapshotState): SnapshotState {
  if (typeof savedSnapshot === 'string') {
    return { content: savedSnapshot, fileExistedBefore: true };
  }
  return {
    content: savedSnapshot.content,
    fileExistedBefore: savedSnapshot.fileExistedBefore === false ? false : true,
  };
}
