/**
 * Chatwork 絵文字ショートコード → Unicode 絵文字の辞書（REQ-007 / 設計 §4.3）。
 *
 * **主要セット**のみを掲載する（全網羅は YAGNI とし、未知のショートコードは `renderChatworkBody`
 * が原文維持で返す方針）。キーは Chatwork が本文に書く通りの形（括弧付き）で扱う。
 * 妥当な Unicode マッピングが無いものはここに載せない（誤マッピングよりも原文維持を優先）。
 *
 * `as const` を付与することで値型を string リテラル union に絞り、誤改変を防ぐ。
 */
export const CHATWORK_EMOTICONS = {
  "(blush)": "😊",
  "(gogo)": "💪",
  "(beer)": "🍺",
  "(clap)": "👏",
  "(cracker)": "🎉",
  "(cake)": "🎂",
  "(love)": "😍",
  "(yes)": "👍",
  "(no)": "👎",
  "(think)": "🤔",
  "(oops)": "😅",
  "(sweat)": "😓",
  "(whew)": "😌",
  "(puke)": "🤮",
  "(devil)": "😈",
  "(lightbulb)": "💡",
  "(h)": "❤️",
  "(y)": "👍",
  "(n)": "👎",
  "(handshake)": "🤝",
  "(santa)": "🎅",
  "(xmas)": "🎄",
  "(^^;)": "😅",
  "(dance)": "💃",
  "(heart)": "❤️",
  "(star)": "⭐",
  "(music)": "🎵",
  "(coffee)": "☕",
  "(tea)": "🍵",
  "(food)": "🍴",
  "(sushi)": "🍣",
  "(study)": "📖",
  "(work)": "💼",
  "(pc)": "💻",
  "(phone)": "📱",
  "(mail)": "✉️",
  "(book)": "📚",
  "(pen)": "🖊️",
  "(clock)": "⏰",
  "(sun)": "☀️",
  "(rain)": "🌧️",
  "(snow)": "❄️",
  "(cloud)": "☁️",
  "(wave)": "👋",
  "(fire)": "🔥",
  "(snowman)": "⛄",
  "(cherryblossom)": "🌸",
  "(tulip)": "🌷",
  "(bud)": "🌱",
  "(umbrella)": "☂️",
  "(xmastree)": "🎄",
} as const;

/** 既知の Chatwork 絵文字ショートコードの union 型（辞書のキー）。 */
export type ChatworkEmoticonKey = keyof typeof CHATWORK_EMOTICONS;
