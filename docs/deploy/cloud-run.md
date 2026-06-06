# Cloud Run へのデプロイ手順

Chatwork Slack Bridge を Google Cloud Run へデプロイするための、初回プロビジョニング・継続デプロイ・運用確認・ロールバックの手順をまとめる。

デプロイ自体は GitHub Actions の [`deploy-cloud-run.yml`](../../.github/workflows/deploy-cloud-run.yml) が `main` への push（およびマージ）または `main` ブランチに対する手動 `workflow_dispatch` をトリガに自動実行する（feature ブランチでの dispatch は deploy されない）。本ドキュメントは、その workflow が前提とする GCP / Secret Manager / GitHub 側のリソースを手動で整える手順である。

> このリポジトリは OSS 配布を想定している。**実値（プロジェクト ID・SA メール・Neon 接続文字列・クライアント名など）は本ドキュメントにもコード/workflow にも書かない。** 以下はすべて `<PLACEHOLDER>` で記述する。実運用では各自の環境値に読み替えること。

## 0. プレースホルダ凡例

| プレースホルダ | 意味 |
|---------------|------|
| `<PROJECT_ID>` | GCP プロジェクト ID |
| `<PROJECT_NUMBER>` | GCP プロジェクト番号（WIF の principalSet に使用） |
| `<AR_REPO>` | Artifact Registry リポジトリ名 |
| `<SERVICE_NAME>` | Cloud Run サービス名（イメージ名にも流用） |
| `<DEPLOY_SA_EMAIL>` | デプロイ用 SA のメール（WIF で impersonate される） |
| `<RUNTIME_SA_EMAIL>` | Cloud Run 実行 SA のメール（`secretmanager.secretAccessor` が必要） |
| `<WIF_POOL_ID>` | Workload Identity プール ID |
| `<WIF_PROVIDER_ID>` | Workload Identity プロバイダ ID |
| `<WIF_PROVIDER_RESOURCE>` | WIF プロバイダのフルリソース名（GitHub variable に設定する値） |
| `<DB_URL_SECRET_NAME>` | Secret Manager 上の `DATABASE_URL` シークレット名 |
| `<CHATWORK_WEBHOOK_TOKEN_SECRET_NAME>` | Secret Manager 上の Chatwork Webhook 署名トークンのシークレット名 |
| `<CHATWORK_API_TOKEN_SECRET_NAME>` | Secret Manager 上の Chatwork API トークンのシークレット名 |
| `<SLACK_BOT_TOKEN_SECRET_NAME>` | Secret Manager 上の Slack Bot トークンのシークレット名 |
| `<SLACK_SIGNING_SECRET_SECRET_NAME>` | Secret Manager 上の Slack Signing Secret のシークレット名（slack-reply で必須） |
| `<SLACK_DEFAULT_GROUP_CHANNEL_ID>` | group 種別の集約フォールバック Slack チャンネル ID（秘密ではない設定値） |
| `<SLACK_DEFAULT_DM_CHANNEL_ID>` | direct 種別の集約フォールバック Slack チャンネル ID（秘密ではない設定値） |
| `<SLACK_ALLOWED_REPLY_USER_IDS>` | 送信操作の allowlist（任意・カンマ区切りの Slack user ID。秘密ではない設定値。未設定＝本人のみ許可） |
| `<GITHUB_OWNER>/<GITHUB_REPO>` | GitHub リポジトリ（`anyoneanderson/chatwork-slack-bridge`） |

リージョンは **`asia-northeast1`** に固定する（workflow の `env.GAR_REGION` / `env.CLOUD_RUN_REGION` と一致）。

## 1. 必要な GCP リソース一覧

事前に手動でプロビジョニングしておくリソース（IaC 自動作成は本フェーズのスコープ外）。

| # | リソース | 用途 | 対応する GitHub variable |
|---|---------|------|--------------------------|
| 1 | GCP プロジェクト | デプロイ先プロジェクト | `GCP_PROJECT_ID` |
| 2 | Artifact Registry（Docker 形式リポジトリ） | コンテナイメージの保管 | `ARTIFACT_REGISTRY_REPOSITORY` |
| 3 | Workload Identity プール | GitHub Actions の OIDC 連携元 | （プロバイダ経由で参照） |
| 4 | Workload Identity プロバイダ | GitHub OIDC トークンの検証・属性マッピング | `GCP_WORKLOAD_IDENTITY_PROVIDER` |
| 5 | デプロイ用 SA | workflow が WIF で impersonate し、build/migrate/deploy を行う | `GCP_DEPLOY_SERVICE_ACCOUNT` |
| 6 | 実行 SA（Cloud Run runtime） | Cloud Run コンテナの ID。Secret Manager から `DATABASE_URL` を取得する | `CLOUD_RUN_SERVICE_ACCOUNT` |
| 7 | Secret Manager シークレット（`DATABASE_URL`） | Neon 接続文字列の保管。実行 SA が実行時に取得 | `DATABASE_URL_SECRET` |
| 7b | Secret Manager シークレット（Chatwork Webhook トークン） | Webhook 署名検証トークンの保管。実行 SA が実行時に取得 | `CHATWORK_WEBHOOK_TOKEN_SECRET` |
| 7c | Secret Manager シークレット（Chatwork API トークン） | `GET /rooms` 等の Chatwork API トークン。実行 SA が実行時に取得 | `CHATWORK_API_TOKEN_SECRET` |
| 7d | Secret Manager シークレット（Slack Bot トークン） | Slack 投稿用 Bot トークン。実行 SA が実行時に取得 | `SLACK_BOT_TOKEN_SECRET` |
| 7e | Secret Manager シークレット（Slack Signing Secret） | Slack request 署名検証用シークレット（slack-reply で**必須**）。実行 SA が実行時に取得 | `SLACK_SIGNING_SECRET_SECRET` |
| 8 | Cloud Run サービス | アプリの公開先（初回 deploy で自動作成される） | `CLOUD_RUN_SERVICE` |
| 9 | Neon PostgreSQL | アプリ DB（pooled 接続）。GCP リソースではないが前提 | （`DATABASE_URL` 経由） |

> Slack の集約フォールバックチャンネル ID（`SLACK_DEFAULT_GROUP_CHANNEL_ID` / `SLACK_DEFAULT_DM_CHANNEL_ID`）と送信 allowlist（`SLACK_ALLOWED_REPLY_USER_IDS`・任意）は秘密ではない設定値のため Secret Manager ではなく GitHub variable（`--set-env-vars` 経由）で渡す。

> **WIF を使うため、SA の JSON 鍵は発行・保管しない。** GitHub には秘密の実値を一切置かず、`vars.*`（repository variables）に参照情報のみを設定する。

### 1.1 必要な API の有効化

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  --project="<PROJECT_ID>"
```

### 1.2 Artifact Registry リポジトリの作成

```bash
gcloud artifacts repositories create "<AR_REPO>" \
  --repository-format=docker \
  --location=asia-northeast1 \
  --project="<PROJECT_ID>"
```

workflow はイメージを次の URI で push する（[`deploy-cloud-run.yml`](../../.github/workflows/deploy-cloud-run.yml) の `Compute image metadata` ステップ）:

```
asia-northeast1-docker.pkg.dev/<PROJECT_ID>/<AR_REPO>/<SERVICE_NAME>:<commit-sha(12桁)>
```

`:latest` は可読性のための補助タグであり、deploy・ロールバックの起点は常に **git SHA タグ**である。

### 1.3 サービスアカウントの作成

```bash
# デプロイ用 SA（GitHub Actions が WIF で impersonate）
gcloud iam service-accounts create "<deploy-sa-id>" \
  --display-name="GitHub Actions deployer" \
  --project="<PROJECT_ID>"
# => <DEPLOY_SA_EMAIL>

# 実行 SA（Cloud Run runtime）
gcloud iam service-accounts create "<runtime-sa-id>" \
  --display-name="Cloud Run runtime" \
  --project="<PROJECT_ID>"
# => <RUNTIME_SA_EMAIL>
```

#### デプロイ用 SA に付与するロール

最小権限で次を付与する（プロジェクトレベル、または各リソースに絞ってもよい）:

| ロール | 目的 |
|--------|------|
| `roles/run.admin` | `gcloud run deploy` でサービスを作成・更新 |
| `roles/artifactregistry.writer` | イメージの push |
| `roles/secretmanager.secretAccessor` | migration 時に `DATABASE_URL` を取得（`gcloud secrets versions access`） |
| `roles/iam.serviceAccountUser`（実行 SA に対して） | deploy 時に実行 SA を Cloud Run へ割り当てる |

```bash
for role in roles/run.admin roles/artifactregistry.writer roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "<PROJECT_ID>" \
    --member="serviceAccount:<DEPLOY_SA_EMAIL>" \
    --role="${role}"
done

# 実行 SA を Cloud Run に割り当てるために actAs を許可
gcloud iam service-accounts add-iam-policy-binding "<RUNTIME_SA_EMAIL>" \
  --member="serviceAccount:<DEPLOY_SA_EMAIL>" \
  --role="roles/iam.serviceAccountUser" \
  --project="<PROJECT_ID>"
```

### 1.4 実行 SA への `roles/secretmanager.secretAccessor` 付与（必須）

アプリは `SECRET_BACKEND=gcp` のとき、実行 SA の ADC（Application Default Credentials）で Secret Manager から `DATABASE_URL` を**実行時に**取得する設計（[design.md 4.1](../../.specs/cloud-deploy/design.md)）。そのため **実行 SA = `CLOUD_RUN_SERVICE_ACCOUNT`** にアクセス権が必要。

シークレット単位に絞って付与する（最小権限）:

forwarding フェーズで追加した 3 つのトークンシークレットと、slack-reply フェーズで追加した Slack Signing Secret も、起動時の gcp factory プリフェッチ対象のため**同じ実行 SA に `secretAccessor` を付与する**:

```bash
for secret in \
  "<DB_URL_SECRET_NAME>" \
  "<CHATWORK_WEBHOOK_TOKEN_SECRET_NAME>" \
  "<CHATWORK_API_TOKEN_SECRET_NAME>" \
  "<SLACK_BOT_TOKEN_SECRET_NAME>" \
  "<SLACK_SIGNING_SECRET_SECRET_NAME>"; do
  gcloud secrets add-iam-policy-binding "${secret}" \
    --member="serviceAccount:<RUNTIME_SA_EMAIL>" \
    --role="roles/secretmanager.secretAccessor" \
    --project="<PROJECT_ID>"
done
```

> この権限が無いと Cloud Run 起動時の secret プリフェッチが失敗し、`/health` も 200 を返さない（デプロイが失敗扱いになる）。
> 5 シークレットのいずれか 1 つでもアクセス不可だと gcp factory が `SecretAccessError` で起動を中断する。

## 2. Workload Identity Federation（WIF）の設定

GitHub Actions は SA JSON 鍵を使わず、OIDC トークンで `<DEPLOY_SA_EMAIL>` を impersonate する。

```bash
# 1) プールの作成
gcloud iam workload-identity-pools create "<WIF_POOL_ID>" \
  --location="global" \
  --display-name="GitHub Actions pool" \
  --project="<PROJECT_ID>"

# 2) GitHub OIDC プロバイダの作成（リポジトリ属性をマッピング）
gcloud iam workload-identity-pools providers create-oidc "<WIF_PROVIDER_ID>" \
  --location="global" \
  --workload-identity-pool="<WIF_POOL_ID>" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository == '<GITHUB_OWNER>/<GITHUB_REPO>'" \
  --project="<PROJECT_ID>"

# 3) 当該リポジトリからの impersonation のみ許可
gcloud iam service-accounts add-iam-policy-binding "<DEPLOY_SA_EMAIL>" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<WIF_POOL_ID>/attribute.repository/<GITHUB_OWNER>/<GITHUB_REPO>" \
  --project="<PROJECT_ID>"
```

GitHub variable `GCP_WORKLOAD_IDENTITY_PROVIDER` には、プロバイダの**フルリソース名**を設定する:

```
projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<WIF_POOL_ID>/providers/<WIF_PROVIDER_ID>
```

> workflow は upstream リポジトリ（`anyoneanderson/chatwork-slack-bridge`）以外（fork）では deploy ジョブを実行しない（`if: github.repository == '...'`）。WIF 側の `attribute-condition` と二重に誤デプロイを防ぐ。

## 3. Secret Manager への `DATABASE_URL` 登録

Neon の接続文字列を Secret Manager に登録する。**実値はここにもログにも残さない。**

```bash
# シークレット本体を作成
gcloud secrets create "<DB_URL_SECRET_NAME>" \
  --replication-policy="automatic" \
  --project="<PROJECT_ID>"

# 値を登録（標準入力から渡し、シェル履歴に残さない）
printf '%s' '<NEON_DATABASE_URL>' | gcloud secrets versions add "<DB_URL_SECRET_NAME>" \
  --data-file=- \
  --project="<PROJECT_ID>"
```

接続文字列の要件:

- Neon の **pooled**（PgBouncer transaction mode）エンドポイントを使う。アプリは `DB_POOLED=true` のとき postgres.js の `prepare: false` を有効化する（pooled では prepared statement が使えないため。[design.md 4.2](../../.specs/cloud-deploy/design.md)）。
- SSL は接続文字列の `?sslmode=require` で表現する（コード側に SSL 分岐を持たない）。

シークレットを更新したら（ローテーション含む）、新しいバージョンが `latest` になる。Cloud Run は次回起動時（新リビジョン）にプリフェッチする。

### 3.1 トークン / signing secret シークレット登録（forwarding / slack-reply）

forwarding フェーズで、Chatwork / Slack のトークンも Secret Manager に登録する（`DATABASE_URL` と同じ手順・**実値はログ/履歴に残さない**）。Slack チャンネル ID・送信 allowlist は秘密ではないため Secret Manager には入れず、GitHub variable で渡す（[4 章](#4-必要な-github-repository-variables-一覧)）。

slack-reply フェーズで追加した Slack Signing Secret（**必須**）も同様に登録する。Signing Secret は Slack App の Basic Information → App Credentials → Signing Secret から取得する（Bot トークンとは別物・再インストールで不変。[`../setup-guide/README.md`](../setup-guide/README.md) §8-1）。

```bash
# トークン / signing secret ごとにシークレット本体を作成し、値を標準入力から登録する
for name in \
  "<CHATWORK_WEBHOOK_TOKEN_SECRET_NAME>" \
  "<CHATWORK_API_TOKEN_SECRET_NAME>" \
  "<SLACK_BOT_TOKEN_SECRET_NAME>" \
  "<SLACK_SIGNING_SECRET_SECRET_NAME>"; do
  gcloud secrets create "${name}" \
    --replication-policy="automatic" \
    --project="<PROJECT_ID>"
done

# 値の登録例（各トークン / signing secret の実値に置き換える。シェル履歴に残さないよう注意）
printf '%s' '<CHATWORK_WEBHOOK_TOKEN_VALUE>' | gcloud secrets versions add "<CHATWORK_WEBHOOK_TOKEN_SECRET_NAME>" --data-file=- --project="<PROJECT_ID>"
printf '%s' '<CHATWORK_API_TOKEN_VALUE>'     | gcloud secrets versions add "<CHATWORK_API_TOKEN_SECRET_NAME>"     --data-file=- --project="<PROJECT_ID>"
printf '%s' '<SLACK_BOT_TOKEN_VALUE>'        | gcloud secrets versions add "<SLACK_BOT_TOKEN_SECRET_NAME>"        --data-file=- --project="<PROJECT_ID>"
printf '%s' '<SLACK_SIGNING_SECRET_VALUE>'   | gcloud secrets versions add "<SLACK_SIGNING_SECRET_SECRET_NAME>"   --data-file=- --project="<PROJECT_ID>"
```

> 実行 SA への `secretAccessor` 付与は [1.4 章](#14-実行-sa-への-rolessecretmanagersecretaccessor-付与必須)のループに含まれている。

## 4. 必要な GitHub repository variables 一覧

リポジトリの **Settings → Secrets and variables → Actions → Variables**（repository variables）に以下を設定する。**Secrets ではなく Variables** に置く（いずれも秘密の実値ではなく参照情報・スイッチのため）。秘密の実値（`DATABASE_URL`）は GitHub には置かず、Secret Manager に保管する。

| 変数 | 用途 | 例（プレースホルダ） |
|------|------|----------------------|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | WIF プロバイダのフルリソース名 | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<WIF_POOL_ID>/providers/<WIF_PROVIDER_ID>` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | デプロイ用 SA（WIF impersonate 対象） | `<DEPLOY_SA_EMAIL>` |
| `GCP_PROJECT_ID` | GCP プロジェクト ID | `<PROJECT_ID>` |
| `ARTIFACT_REGISTRY_REPOSITORY` | Artifact Registry リポジトリ名 | `<AR_REPO>` |
| `CLOUD_RUN_SERVICE` | Cloud Run サービス名（イメージ名にも流用） | `<SERVICE_NAME>` |
| `CLOUD_RUN_SERVICE_ACCOUNT` | Cloud Run 実行 SA（`roles/secretmanager.secretAccessor` 必要） | `<RUNTIME_SA_EMAIL>` |
| `DATABASE_URL_SECRET` | Secret Manager 上のシークレット名 | `<DB_URL_SECRET_NAME>` |
| `CHATWORK_WEBHOOK_TOKEN_SECRET` | Chatwork Webhook トークンの Secret Manager シークレット名 | `<CHATWORK_WEBHOOK_TOKEN_SECRET_NAME>` |
| `CHATWORK_API_TOKEN_SECRET` | Chatwork API トークンの Secret Manager シークレット名 | `<CHATWORK_API_TOKEN_SECRET_NAME>` |
| `SLACK_BOT_TOKEN_SECRET` | Slack Bot トークンの Secret Manager シークレット名 | `<SLACK_BOT_TOKEN_SECRET_NAME>` |
| `SLACK_SIGNING_SECRET_SECRET` | Slack Signing Secret の Secret Manager シークレット名（slack-reply で**必須**。未作成だと本番起動失敗） | `<SLACK_SIGNING_SECRET_SECRET_NAME>` |
| `SLACK_DEFAULT_GROUP_CHANNEL_ID` | group 集約フォールバック Slack チャンネル ID（非秘密の設定値） | `<SLACK_DEFAULT_GROUP_CHANNEL_ID>` |
| `SLACK_DEFAULT_DM_CHANNEL_ID` | direct 集約フォールバック Slack チャンネル ID（非秘密の設定値） | `<SLACK_DEFAULT_DM_CHANNEL_ID>` |
| `SLACK_ALLOWED_REPLY_USER_IDS` | 送信操作の allowlist（**任意**・カンマ区切りの Slack user ID。非秘密の設定値。未設定＝本人のみ許可） | `<SLACK_ALLOWED_REPLY_USER_IDS>` |

> `*_SECRET` 変数は Secret Manager の**シークレット名**であり実値ではない。トークン / signing secret の実値は Secret Manager に保管し、アプリが実行時に取得する（`DATABASE_URL` と同じ間接参照）。`SLACK_DEFAULT_*_CHANNEL_ID` / `SLACK_ALLOWED_REPLY_USER_IDS` は秘密ではないため値そのものを variable に置く（`SLACK_ALLOWED_REPLY_USER_IDS` は任意。未設定でも可）。
>
> ⚠ `SLACK_SIGNING_SECRET_SECRET` は **必須**。未作成のままデプロイすると `--set-env-vars` で空文字に展開され、gcp factory の必須チェックで本番起動が失敗する（`SecretConfigError`）。Secret Manager 登録（§3.1）・実行 SA への `secretAccessor` 付与（§1.4）・本 variable 作成の 3 点をワンセットで行うこと。
>
> これらの変数名は [`deploy-cloud-run.yml`](../../.github/workflows/deploy-cloud-run.yml) の `vars.*` 参照と完全に一致している必要がある。
>
> また、deploy ジョブは `environment: production` を使うため、リポジトリに **`production` environment** を作成しておく（保護ルールや必須レビュアーを付けたい場合はここで設定）。

## 5. デプロイの流れ

`main` への push（マージ）または **`main` ブランチに対する** 手動 `workflow_dispatch` で [`deploy-cloud-run.yml`](../../.github/workflows/deploy-cloud-run.yml) が起動する。deploy ジョブは `github.ref == 'refs/heads/main'` に固定されているため、feature ブランチを選んで `workflow_dispatch` しても deploy は実行されない（`quality-gate` のみ）。PR でも `quality-gate` のみ実行され、deploy は行われない。

1. **quality-gate**: `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test --coverage`。
2. **deploy**（`quality-gate` 成功後、`github.ref == 'refs/heads/main'`（push / dispatch）かつ upstream リポジトリのときのみ）:
   1. WIF で `<DEPLOY_SA_EMAIL>` を impersonate（`google-github-actions/auth@v2`）。
   2. Secret Manager から `DATABASE_URL` を一時取得し、取得直後に `::add-mask::` でマスクして `pnpm db:migrate`（drizzle-kit migrate は冪等）。
   3. `docker buildx` でイメージを build し、Artifact Registry へ **git SHA タグ**（+ `latest`）で push。
   4. **Trivy** で CRITICAL/HIGH 脆弱性をスキャン（検出時は deploy を中断、`ignore-unfixed`）。
   5. `gcloud run deploy <SERVICE_NAME> --image <SHA タグ>` で deploy。実行 SA = `CLOUD_RUN_SERVICE_ACCOUNT`、`--port 8080`、`--min-instances 0 --max-instances 3 --cpu 1 --memory 512Mi`。
   6. `/health` が **200** を返すことを検証（Neon 疎通の成功判定）。
   7. デプロイサマリ（Service URL / Revision / Image）を出力。

deploy 時の `--set-env-vars`（秘密の実値は含めない。参照情報・スイッチのみ）:

| env | 値 | 意味 |
|-----|-----|------|
| `NODE_ENV` | `production` | 実行モード |
| `SECRET_BACKEND` | `gcp` | secret 取得を Secret Manager 経由に切替 |
| `GOOGLE_CLOUD_PROJECT` | `<PROJECT_ID>` | Secret Manager 参照先プロジェクト |
| `DATABASE_URL_SECRET` | `<DB_URL_SECRET_NAME>` | 取得対象のシークレット名 |
| `DB_POOLED` | `true` | Neon pooled 接続（`prepare:false`） |
| `CHATWORK_WEBHOOK_TOKEN_SECRET` | `<CHATWORK_WEBHOOK_TOKEN_SECRET_NAME>` | Chatwork Webhook トークンのシークレット名 |
| `CHATWORK_API_TOKEN_SECRET` | `<CHATWORK_API_TOKEN_SECRET_NAME>` | Chatwork API トークンのシークレット名 |
| `SLACK_BOT_TOKEN_SECRET` | `<SLACK_BOT_TOKEN_SECRET_NAME>` | Slack Bot トークンのシークレット名 |
| `SLACK_SIGNING_SECRET_SECRET` | `<SLACK_SIGNING_SECRET_SECRET_NAME>` | Slack Signing Secret のシークレット名（slack-reply で必須） |
| `SLACK_DEFAULT_GROUP_CHANNEL_ID` | `<SLACK_DEFAULT_GROUP_CHANNEL_ID>` | group 集約フォールバックチャンネル（非秘密の設定値） |
| `SLACK_DEFAULT_DM_CHANNEL_ID` | `<SLACK_DEFAULT_DM_CHANNEL_ID>` | direct 集約フォールバックチャンネル（非秘密の設定値） |
| `SLACK_ALLOWED_REPLY_USER_IDS` | `<SLACK_ALLOWED_REPLY_USER_IDS>` | 送信操作の allowlist（任意・非秘密の設定値。未設定＝本人のみ許可） |

> **トークン / signing secret の秘密の実値（`DATABASE_URL` / `CHATWORK_WEBHOOK_TOKEN` / `CHATWORK_API_TOKEN` / `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET`）は `--update-secrets` でも `--set-env-vars` でも注入しない。** `--set-env-vars` に渡すのはシークレット**名**（`*_SECRET`）のみで、アプリが起動時に実行 SA の ADC で Secret Manager から実値を取得する設計。`SLACK_DEFAULT_*_CHANNEL_ID` / `SLACK_ALLOWED_REPLY_USER_IDS` は秘密ではないため値そのものを渡す。
> `--set-env-vars` は値にカンマを含み得るため `^@@^`（カスタム区切り）構文を使用している。

## 6. デプロイ後の運用確認

各デプロイ後に以下を確認する。

1. **`/health` が 200**: workflow が自動検証するが、手動でも確認できる。
   ```bash
   SERVICE_URL="$(gcloud run services describe "<SERVICE_NAME>" \
     --region=asia-northeast1 --project="<PROJECT_ID>" \
     --format='value(status.url)')"
   curl -fsS -o /dev/null -w '%{http_code}\n' "${SERVICE_URL}/health"   # => 200
   ```
   200 は Neon への疎通（`db.ping`）成功を意味する。503 が返る場合は実行 SA の `secretAccessor` 権限・`DATABASE_URL` の値・Neon 側の状態を疑う。
2. **リビジョン確認**: 配信中のリビジョンと、それに紐づく commit-sha ラベルを確認する。
   ```bash
   gcloud run services describe "<SERVICE_NAME>" \
     --region=asia-northeast1 --project="<PROJECT_ID>" \
     --format='value(status.latestReadyRevisionName, status.traffic)'

   # SHA → リビジョンの対応を一覧
   gcloud run revisions list --service="<SERVICE_NAME>" \
     --region=asia-northeast1 --project="<PROJECT_ID>" \
     --format='table(metadata.name, metadata.labels.commit-sha, status.conditions[0].status)'
   ```
   workflow の deploy サマリにも Service URL / Revision / Image（SHA タグ）が出力される。
3. **ロールバック可否の把握**: 直前の正常リビジョン名を控えておく（次節）。

## 7. ロールバック手順

deploy は常に git SHA タグのイメージを参照し、Cloud Run は各 deploy をリビジョンとして保持する。問題が発生したら、過去の正常リビジョンへトラフィックを戻す。

```bash
# 1) リビジョン一覧から、戻したい SHA に対応するリビジョン名を特定
gcloud run revisions list --service="<SERVICE_NAME>" \
  --region=asia-northeast1 --project="<PROJECT_ID>" \
  --format='table(metadata.name, metadata.labels.commit-sha, metadata.creationTimestamp)'

# 2) 過去の正常リビジョンへトラフィックを 100% 戻す
gcloud run services update-traffic "<SERVICE_NAME>" \
  --region=asia-northeast1 --project="<PROJECT_ID>" \
  --to-revisions="<GOOD_REVISION_NAME>=100"

# 3) /health で復旧を確認
curl -fsS -o /dev/null -w '%{http_code}\n' "${SERVICE_URL}/health"   # => 200
```

代替として、過去の SHA タグから明示的に再 deploy してもよい:

```bash
gcloud run deploy "<SERVICE_NAME>" \
  --image "asia-northeast1-docker.pkg.dev/<PROJECT_ID>/<AR_REPO>/<SERVICE_NAME>:<GOOD_SHA>" \
  --region=asia-northeast1 --project="<PROJECT_ID>"
```

> **DB migration を伴うロールバック時の注意**: アプリのロールバックは上記で完結するが、`pnpm db:migrate` で適用済みのスキーマ変更はリビジョンを戻しても自動では巻き戻らない。本フェーズ（walking skeleton）では業務テーブルを追加しないため影響は無いが、後続フェーズで破壊的な migration を入れる場合は、前方互換な migration 設計と、必要に応じた DB 側のリストア（次節）を併用すること。

## 8. Neon のバックアップ / リカバリ確認

DB は Neon（マネージド PostgreSQL）を利用する。**アプリ側のロールバックとは別に、データのバックアップ/リカバリ手段を事前に確認しておく。**

確認・運用項目:

- **PITR（Point-in-Time Restore）**: Neon は履歴保持期間（プラン依存）内であれば、任意時点へのリストアが可能。プロジェクトの **History retention** 設定を確認し、本番に必要な保持期間（例: 7 日以上）を満たしているか確認する。
- **branch リストア**: Neon の branch 機能で、特定時点の branch を作成して検証・復旧できる。誤操作・破壊的 migration の復旧は「過去時点の branch を作成 → 接続確認 → 必要に応じてプライマリへ昇格 / 接続文字列差し替え」の流れで行う。
- **復旧手順の所在**: 具体的な PITR / branch リストア操作は Neon コンソール（または Neon API/CLI）で行う。最新の操作手順・保持期間の上限・プラン別の可否は [Neon 公式ドキュメント](https://neon.tech/docs)（Branching / Point-in-time restore / Backups の各セクション）を一次情報とする。本リポジトリでは手順を再掲せず、公式ドキュメントを参照する運用とする。

DB をリストアした場合の流れ:

1. Neon 側で復旧（PITR または branch 昇格）し、新しい接続文字列が必要なら取得する。
2. 接続文字列が変わった場合は Secret Manager に新バージョンを登録する（[3. Secret Manager への登録](#3-secret-manager-への-databaseurl-登録)）。
3. Cloud Run の新リビジョンをデプロイ（または再起動）して新しい接続文字列をプリフェッチさせる。
4. `/health` が 200 を返すことを確認する。

> **DR チェックリスト（運用前に一度確認）**: (a) Neon の retention 期間が要件を満たす / (b) PITR で任意時点に戻せることをステージングで一度試す / (c) branch リストア → 接続文字列差し替え → `/health` 200 の手順を通しで確認 / (d) Secret Manager のシークレット更新権限と Cloud Run の再デプロイ権限を運用担当が持つ。

## 9. T009 workflow との整合（チェックリスト）

本ドキュメントの記述は [`deploy-cloud-run.yml`](../../.github/workflows/deploy-cloud-run.yml)（実装の正）と一致している:

- [x] 変数名 14 件（`GCP_WORKLOAD_IDENTITY_PROVIDER` / `GCP_DEPLOY_SERVICE_ACCOUNT` / `GCP_PROJECT_ID` / `ARTIFACT_REGISTRY_REPOSITORY` / `CLOUD_RUN_SERVICE` / `CLOUD_RUN_SERVICE_ACCOUNT` / `DATABASE_URL_SECRET` / `CHATWORK_WEBHOOK_TOKEN_SECRET` / `CHATWORK_API_TOKEN_SECRET` / `SLACK_BOT_TOKEN_SECRET` / `SLACK_SIGNING_SECRET_SECRET` / `SLACK_DEFAULT_GROUP_CHANNEL_ID` / `SLACK_DEFAULT_DM_CHANNEL_ID` / `SLACK_ALLOWED_REPLY_USER_IDS`）が workflow の `vars.*` と一致（`SLACK_ALLOWED_REPLY_USER_IDS` は任意）。
- [x] リージョンは `asia-northeast1`（`env.GAR_REGION` / `env.CLOUD_RUN_REGION`）。
- [x] イメージ URI 形式（`<region>-docker.pkg.dev/<PROJECT_ID>/<AR_REPO>/<SERVICE_NAME>:<SHA>`）が `Compute image metadata` ステップと一致。
- [x] `--set-env-vars`（`NODE_ENV` / `SECRET_BACKEND=gcp` / `GOOGLE_CLOUD_PROJECT` / `DATABASE_URL_SECRET` / `DB_POOLED=true` / `CHATWORK_WEBHOOK_TOKEN_SECRET` / `CHATWORK_API_TOKEN_SECRET` / `SLACK_BOT_TOKEN_SECRET` / `SLACK_SIGNING_SECRET_SECRET` / `SLACK_DEFAULT_GROUP_CHANNEL_ID` / `SLACK_DEFAULT_DM_CHANNEL_ID` / `SLACK_ALLOWED_REPLY_USER_IDS`）が `Deploy to Cloud Run` ステップと一致。トークン / signing secret の秘密の実値（`DATABASE_URL` / `*_TOKEN` / `SLACK_SIGNING_SECRET`）は注入せず、シークレット名のみを渡す。`SLACK_ALLOWED_REPLY_USER_IDS` は任意（未設定なら空文字＝本人のみ許可）。
- [x] リソース制限（`--port 8080` / `--min-instances 0` / `--max-instances 3` / `--cpu 1` / `--memory 512Mi`）が一致。
- [x] 実行 SA（`CLOUD_RUN_SERVICE_ACCOUNT`）への `roles/secretmanager.secretAccessor` を、`DATABASE_URL` + 3 トークンシークレット + Slack Signing Secret の 5 件について必須として記載。
- [x] `/health` 200 検証・SHA タグ・Trivy スキャン・`::add-mask::` による migration 時のマスクを記載。
