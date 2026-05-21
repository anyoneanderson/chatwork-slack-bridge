# syntax=docker/dockerfile:1

# ---- builder ----
# 依存導入 → TypeScript ビルド（tsc + tsc-alias で @/ エイリアスを相対パス + 拡張子へ解決）
# → prod 依存だけを残す。ベースタグは固定（latest 禁止）。
FROM node:22-slim AS builder
WORKDIR /app

ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# 依存マニフェストのみ先にコピーしてレイヤキャッシュを効かせる
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ソースをコピーしてコンパイル（dist/src/index.js が出力される）
COPY . .
RUN pnpm build

# 実行用に prod 依存だけへ刈り込む（dev 依存を runner に持ち込まない）
RUN pnpm prune --prod

# ---- runner ----
# dist と prod node_modules のみを持つ最小・非 root の実行イメージ。
# 秘密情報は ENV / レイヤに焼き込まず、実行時に Secret Manager / env から注入する。
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
# 非秘密のデフォルト。EXPOSE 8080 と既定挙動を一致させる（Cloud Run は実行時に PORT を上書き注入）。
ENV PORT=8080

# ベースイメージの OS セキュリティ更新（libgnutls30 等の fixable な CRITICAL/HIGH を解消）と、
# 実行時に使わないグローバル npm/npx の削除（同梱 npm の picomatch CVE 除去・攻撃面縮小）。
# 実行は `node dist/...` のみで npm は不要。
RUN apt-get update && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

USER node

# Cloud Run は PORT=8080 を注入する。config（PORT）経由で listen する。
EXPOSE 8080

CMD ["node", "dist/src/index.js"]
