import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { withTimeout } from "@/with-timeout";

/**
 * Drizzle + postgres.js の DB クライアントを生成する。
 *
 * @param databaseUrl PostgreSQL 接続文字列
 * @returns DB 操作・疎通確認・終了処理を持つクライアント
 */
export function createDbClient(databaseUrl: string) {
  const queryClient = postgres(databaseUrl);
  const db = drizzle({ client: queryClient });

  return {
    db,

    /**
     * /health 用の DB 疎通確認を行う。
     *
     * @param timeoutMs 疎通確認の上限ミリ秒
     * @returns 疎通確認が成功したら resolve
     * @throws DB 接続失敗または TimeoutError
     */
    async ping(timeoutMs: number): Promise<void> {
      await withTimeout(db.execute(sql`select 1`), timeoutMs, "db.ping");
    },

    /**
     * DB 接続プールを終了する。
     *
     * @returns 終了処理の完了
     */
    async close(): Promise<void> {
      await queryClient.end();
    },
  };
}

export type DbClient = ReturnType<typeof createDbClient>;
