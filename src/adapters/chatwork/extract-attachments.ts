/**
 * 抽出された添付参照（REQ-004）。
 *
 * 本フェーズでは `fileId` のみ使う。ファイル名・サイズは権威値を Chatwork API（`getFileDownloadUrl`）
 * で改めて取得するため、抽出時点では捨ててよい（ASM-002）。
 */
export interface ChatworkAttachmentRef {
  /** Chatwork 側のファイル ID（本文記法 `[download:<fileId>]` の数値部分）。 */
  fileId: string;
}

/**
 * Chatwork メッセージ本文から添付ファイルの file_id を抽出する純粋関数（REQ-004）。
 *
 * 対応記法: `[download:<fileId>]<ファイル名 (サイズ)>[/download]`。
 * `[preview id=...]` 単独（download なし）は対象外（ASM-002）。
 * 同一 file_id が複数回現れた場合は 1 つに集約し、本文中の**初出順**を保つ
 * （webhook 異常時の重複に対する防御）。
 *
 * 副作用・I/O は持たない（`render-body.ts` の整形ロジックとは責務が異なるため別関数 / CON-001）。
 *
 * @param body Chatwork メッセージ本文
 * @returns 出現順・重複除去済みの添付参照配列。添付が無ければ空配列
 */
export function extractAttachments(body: string): ChatworkAttachmentRef[] {
  const pattern = /\[download:(\d+)\][\s\S]*?\[\/download\]/g;
  const seen = new Set<string>();
  const refs: ChatworkAttachmentRef[] = [];

  for (const match of body.matchAll(pattern)) {
    const fileId = match[1];
    if (fileId === undefined || seen.has(fileId)) {
      continue;
    }
    seen.add(fileId);
    refs.push({ fileId });
  }

  return refs;
}
