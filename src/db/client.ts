import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { withTimeout } from "@/with-timeout";

/**
 * DB クライアント生成オプション。
 */
export interface DbClientOptions {
  /**
   * Neon pooled connection（PgBouncer transaction mode）では prepared statement が
   * 使えないため、true のとき postgres.js の `prepare` を無効化する。
   */
  pooled?: boolean;
}

/**
 * Drizzle + postgres.js の DB クライアントを生成する。
 *
 * SSL は接続文字列の `sslmode`（例: Neon の `sslmode=require`）に委ねており、
 * コード側で SSL 分岐は持たない。
 *
 * @param databaseUrl PostgreSQL 接続文字列
 * @param options pooled 接続の有無などの生成オプション
 * @returns DB 操作・疎通確認・終了処理を持つクライアント
 */
export function createDbClient(databaseUrl: string, options: DbClientOptions = {}) {
  // pooled のときは prepared statement を無効化（Neon pooler 対応）。
  // 非 pooled はオプションを渡さず postgres.js の既定に委ねる。
  const queryClient = options.pooled
    ? postgres(databaseUrl, { prepare: false })
    : postgres(databaseUrl);
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
