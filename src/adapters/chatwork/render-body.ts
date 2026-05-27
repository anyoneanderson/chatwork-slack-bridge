import { CHATWORK_EMOTICONS } from "@/adapters/chatwork/chatwork-emoticons";

/**
 * Chatwork メッセージ記法を Slack 向けの可読テキストへ変換する（REQ-007 / 設計 §4.3）。
 *
 * 純粋関数として実装する（fetch / DB / ログ等の I/O は行わない）。Slack 制御文字
 * （`&` `<` `>`）のエスケープは整形側（`adapters/slack/format.ts`）の責務のためここでは
 * 行わない。本関数は **タグ変換 → 絵文字置換** の順で処理する：先に `[info]…[/info]` 等の
 * 装飾タグを剥がしてから絵文字辞書を適用することで、タグ内に含まれる絵文字ショートコードも
 * 置換対象に含められる。
 *
 * 対応するタグは設計 §4.3 に列挙されたもののみで、**未知の `[...]` タグは原文維持**する
 * （壊さない方針）。同じく、辞書に無い絵文字ショートコードも原文維持。
 *
 * @param body Chatwork メッセージ本文（webhook payload の `body`）
 * @returns Slack に載せる前の可読テキスト（未エスケープ）
 */
export function renderChatworkBody(body: string): string {
  let result = body;
  result = convertTags(result);
  result = replaceEmoticons(result);
  return result;
}

/**
 * 既知の Chatwork タグを Slack 向けに変換 / 除去する。
 *
 * 未知の `[...]` 形式トークンには触れない（壊さない方針）。順序は設計 §4.3 に従い、
 * 入れ子要素を先に処理することで親タグの中身が正しく残るようにする。
 *
 * @param input タグ変換前の本文
 * @returns タグ変換後の本文（絵文字置換はまだ）
 */
function convertTags(input: string): string {
  let s = input;

  // [download:<id>]<inner>[/download] → 📎 <inner>
  // `[\s\S]*?` で改行を含む非貪欲マッチ（添付名にスペースを含む可能性に対応）。
  s = s.replace(/\[download:\d+\]([\s\S]*?)\[\/download\]/g, "📎 $1");

  // [preview id=<id>] / [preview id=<id> ht=<h>] → 除去（download とセットで出るため）
  s = s.replace(/\[preview id=\d+(?: ht=\d+)?\]/g, "");

  // [dtext:file_uploaded] → 既知システム文言
  s = s.replace(/\[dtext:file_uploaded\]/g, "ファイルをアップロードしました");
  // その他の [dtext:*] → 除去
  s = s.replace(/\[dtext:[^\]]*\]/g, "");

  // [title]<inner>[/title] → 前後に改行を入れて素テキスト化（見出し感を出すため）
  s = s.replace(/\[title\]([\s\S]*?)\[\/title\]/g, "\n$1\n");

  // [info]<inner>[/info] → 枠を外す
  s = s.replace(/\[info\]([\s\S]*?)\[\/info\]/g, "$1");

  // [qt] の中の [qtmeta ...] は先に除去してから引用整形に回す
  // （qtmeta は引用元の aid/time 等メタ。本文として表示する意味が無い）
  s = s.replace(/\[qtmeta\b[^\]]*\]/g, "");

  // [qt]<inner>[/qt] → 各行に `> ` を付ける（Slack 引用記法）
  s = s.replace(/\[qt\]([\s\S]*?)\[\/qt\]/g, (_match, inner: string) => {
    // 前後の余分な改行を落としてから行単位で引用記号を付与する
    const trimmed = inner.replace(/^\n+|\n+$/g, "");
    return trimmed
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  });

  // [To:<aid>] → 除去（本文側ではメンションを名前化しない / 設計 §4.3）
  s = s.replace(/\[To:\d+\]/g, "");

  // [rp aid=<aid> ...] → 除去（返信タグ）
  s = s.replace(/\[rp\b[^\]]*\]/g, "");

  // [picon:<aid>] / [piconname:<aid>] → 除去
  s = s.replace(/\[picon:\d+\]/g, "");
  s = s.replace(/\[piconname:\d+\]/g, "");

  // [hr] → 区切り
  s = s.replace(/\[hr\]/g, "---");

  return s;
}

/**
 * 既知の Chatwork 絵文字ショートコードを Unicode 絵文字に置換する。
 *
 * 辞書に無いショートコードは原文維持（誤マッピングよりも維持を優先 / 設計 §4.3）。
 *
 * **キー長の降順で適用**する。ASCII 系には部分文字列被り（例: `,':|` ⊃ `:|`、`(^^;)` ⊃
 * 単体 `(`）が存在するため、短いキーを先に処理すると長いキーが食われる。降順ソートで
 * 「最長一致」相当の挙動を担保する（#22）。
 *
 * @param input タグ変換済みの本文
 * @returns 絵文字置換済みの本文
 */
function replaceEmoticons(input: string): string {
  let s = input;
  const entries = Object.entries(CHATWORK_EMOTICONS).sort(([a], [b]) => b.length - a.length);
  for (const [key, value] of entries) {
    // ショートコードに正規表現メタ文字（`(`/`)`/`^`/`;` 等）が含まれるため、
    // `RegExp` ではなく `replaceAll` の文字列引数を使う（全置換・メタ文字無視）。
    s = s.replaceAll(key, value);
  }
  return s;
}
