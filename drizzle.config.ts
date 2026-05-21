import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  // migrate / generate は env の DATABASE_URL から接続する（ローカル・CI・本番デプロイ共通）。
  // 接続文字列の実値はここに直書きせず、環境変数経由でのみ解決する。
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
