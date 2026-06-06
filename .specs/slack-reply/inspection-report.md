# spec-inspect Report — slack-reply

> 検査日: 2026-06-06 / 対象: requirement.md / design.md / tasks.md
> 併用: Codex セカンドオピニオン（重大4 + 改善5 を反映済み）

## サマリ

| 深刻度 | 件数 |
|--------|------|
| CRITICAL | 0 |
| WARNING | 0（要対応なし） |
| INFO | 0（NFR-003/006/007 のトレーサビリティ補完済み） |

## Check 結果

- **Check 1 要件ID整合**: design.md / tasks.md が参照する全 ID（REQ-001..011 / NFR-001..007 / CON-001..005 / ASM-001..004）は requirement.md に定義済み。未定義参照なし（CRITICAL 0）。
- **Check 2 必須セクション**: requirement（概要/機能/非機能/制約/前提）, design（アーキ/技術スタック/データ設計/セキュリティ）, tasks（タスク一覧/戦略・優先）すべて存在。
- **Check 3 矛盾**: status 集合（`pending/sending/sent/cancelled/failed`）を requirement / design / tasks で統一。`failed` 終端方針も三文書一致（Codex 指摘の矛盾を解消）。
- **Check 4 曖昧表現**: 「3 秒」「±300 秒」「100 件」等は数値化済み。残る「稀ケース」「best-effort」は意図的な運用表現。
- **Check 6 design→task 網羅**: 全設計要素（verify-signature / chatwork postMessage / slack client 拡張 / confirm-message / escape 抽出 / event-schema / handle-slack-reply / send-outbound / routes / schema+migration0003 / deploy / docs）に対応タスク（T001–T019）あり。
- **Check 7 依存**: 依存グラフは非循環。レビューゲートが各 `[code]` フェーズ後に配置。
- **Check 13 プロジェクトルール**: coding-rules `[MUST]`（署名検証 / 送信前確認 / 秘密非ログ / FK index / transaction / identity PK / Vitest 80%）を要件・設計・タスクに反映。

## Codex セカンドオピニオン反映（重大）

1. 「投稿成功後の確定 tx 失敗時に delivery_attempts 成功記録が残る」矛盾 → 削除し `sending` 残留 + `commit_failed` ログ方針に統一（NFR-005）。
2. Slack 3 秒応答制約 → 応答境界を明記し、超過時も unique/claim で整合維持（NFR-006）。
3. `failed` 再送 UI 矛盾 → `failed` を終端化、再送はユーザー再返信で新 outbound（REQ-006 / 状態遷移図）。
4. 逆引き一意性が DB 未担保 → migration 0003 に `chatwork_messages(slack_channel_id, slack_ts)` partial unique index を追加（design §5.2b / T001）。

## 結論

CRITICAL なし。実装フェーズ（spec-implement）に進んでよい品質水準。
