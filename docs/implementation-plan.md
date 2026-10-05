# 仕様に合わせる修正計画

## 目的と完了条件

[仕様・要件](specification.md)を実装するための作業順序と検証方法を示す。
製品要件は仕様文書を正本とし、この計画に別の要件を追加しない。
仕様整理の基準コミットは `f13d6db`。

最終的な完了条件は、アプリで設計を確定し、確認したプロンプトを指定の worktree に送信し、
報告・変更内容を取得して評価し、人の判断を含む次の指示へ進めること。
SDK の試験だけで実アプリの確認を完了扱いにしない。

| 作業                        | 状態           | 完了時に利用者ができること                                         |
| --------------------------- | -------------- | ------------------------------------------------------------------ |
| 1A 自動サイクルの互換設定化 | 実装・検証済み | 標準では自動サイクルを起動・再開せず、既存履歴の閲覧・停止ができる |
| 1B 設計版とプロンプトの準備 | 実装・検証済み | 確定設計に基づく送信全文と対象を、CLI を起動せず確認できる         |
| 1C 送信と区切り・判断待ち   | 実装・検証済み | 確認した全文を一度だけ送信し、終了後は評価と人の判断を待つ         |
| 2A 作業報告とログの取得     | 実装・検証済み | 手動実行の構造化報告と、ログの欠落状態を取得できる                 |
| 2B 変更内容の MCP 公開      | 実装・検証済み | 追跡・未追跡の変更、ソース、比較基準、完全性を確認できる           |
| 3 実アプリでの往復確認      | 未検証         | 対応を示すアプリで基本フローを実行できる                           |

## 1A 自動サイクルの互換設定化

最初に、自動サイクルが標準で実行できる乖離を解消する。設計版・送信・報告のモデルを
一度に変更せず、起動条件の変更を独立して検証する。

- `orchestration.enable_legacy_cycles` を追加し、既定値は `false` とする。
- application の cycle supervisor で起動・再開と内部の次段階起動を制限する。
  MCP と CLI は同じ application 操作を使用し、入口による違いを作らない。
- 無効時の起動・再開は `LEGACY_CYCLES_DISABLED` を返し、実行や状態変更をしない。
- 履歴、レビュー、状態の取得と pause/cancel を維持する。
  daemon 再起動で既存 cycle を自動再開しない。
- 既存の自動サイクルの試験は、対象ごとに互換設定を明示的に有効化する。
  テスト全体の既定値を有効にして新しい標準動作を隠さない。
- 設定例、API 説明、現行利用ガイド、仕様の実装状況を同期する。

検証は、標準設定で起動・再開が拒否され agent が起動しないこと、有効化時に既存 cycle が
動作すること、無効設定で再起動しても履歴取得と中止ができることを確認する。
公開入口でエラーが伝達されることも確認する。DB migration は不要。

1A 単独の変更では、既存の `start_run` に設計確定・プロンプト確認の契約を追加しなかった。
1A の完了を、標準の区切りフロー全体の完成と表示しない。

## 1B 設計版とプロンプトの準備

- Plan の設計版を永続化する。目的・範囲・制約・受け入れ条件、確定状態を持たせ、
  変更では新しい版を追加する。既存の Plan description を確定版へ自動変換しない。
- プロンプト準備の操作と取得の操作を設ける。確定版、Work Item、Profile、workspace、
  判断・評価の参照、終了条件を使い、合成した全文を永続化する。
- 準備時に設計・判断・対象・コード状態の識別情報を記録する。
  送信時にその内容が変わっていないか判断できる形にする。
- 永続記録を run メタデータの保持件数から独立させる。
  現行の Decision/Note は保持し、明確な関係を付けられるものを再利用する。
- append-only migration を追加する。既存 migration は編集しない。

主な対象は domain、application の ports/operations/prompt、SQLite store と migration。
検証は確定版の不変性、未確定設計の拒否、準備で起動しないこと、送信全文・対象の取得、
再起動・cleanup 後の保持、容量不足時の rollback。送信は 1C の契約と合わせて公開する。

## 1C 送信と区切り・判断待ち

- 準備済みプロンプトの ID を用いて送信する。
  `start_run` もこの契約へ移し、自由文だけで確認手順を迂回できないようにする。
- 送信直前に確定版・有効な判断・workspace identity・コード状態を再検証する。
  Profile の実行条件が変わったときも、確認済み内容を別の実行へ置換しない。
- 全文を再合成せず、保存した全文を adapter に渡す。
  準備済みプロンプトと Run の対応は一意にし、同じ送信の再試行で二重起動しない。
- 区切りの状態と Run の終了状態を分ける。CLI の成功だけで Work Item を完了にしない。
  続行には前の結果への評価と人の判断を記録し、次のプロンプトへ結び付ける。
- 起動前後の crash、保存失敗、中断時は不明・失敗・判断待ちを区別し、自動再送しない。
- 標準フローと既存の active cycle の併用を拒否する。
  MCP/CLI の説明と例を新しい送信手順に置き換える。

この段階で、完了した区切りと次の評価・判断の参照、報告欠落の状態を保存する基盤も用意する。
報告内容を検証して公開する機能は 2A で完成させる。1C と 2A が揃うまで基本フローを完成扱いにしない。

検証は、取得した全文と実際の stdin/cwd の一致、準備後の変更の拒否、重複・同時送信、
終了後に別 Run が起動しないこと、評価・判断の関連付け、停止・再起動・容量不足。
SQLite の transaction 中に CLI の実行待ちを保持しない。

## 2A 作業報告とログの取得

- 手動実行にも adapter の構造化結果を要求し、既存の上限・検証機構を再利用する。
  変更概要、終了状態、確認結果、未解決事項、必要な判断を報告として公開する。
- Run の間引きと cache の期限切れから独立して、検証済み報告を保存する。
  schema の関連付けで、通常 cleanup が報告・評価・判断を消さないようにする。
- agent の確認結果と Orvia の Git 情報を分ける。
  不正な報告、出力欠落、保存失敗では原因を示し、成功した報告を生成しない。
- 生ログ取得に期限切れ・打ち切り・取得不能を明示する。

検証は正常・不正・超過・欠落した結果、非ゼロ終了・中断、再起動・cache 削除・Run 間引き後の
報告取得、報告保存の容量不足。既存の process lifecycle と storage contract の試験も実行する。

## 2B 変更内容の MCP 公開

- bound worktree を対象に変更ファイル一覧・差分・ソース取得を application 操作として公開する。
  未追跡内容とパス解決の範囲を確認する。
- Work Item の基準 commit と区切りの開始・終了時のコード状態を用い、
  累積差分と区切りで変わったファイルを区別する。
- 比較基準、取得時点、コード状態、完全性を返す。分割取得中の変更では再取得を要求する。
  過去の報告時点と現在の内容が異なる場合は、その違いを表示する。

検証は staged/unstaged/committed/untracked、rename/delete、バイナリと大きな結果、
外部を指す symlink、分割取得中の変更。未取得部分を含む変更を完全な結果として返さない。
過去時点のソース全文を保存する機能は追加しない。

## 3 実アプリでの往復確認

SDK client による契約試験を通した後、対象の ChatGPT.app または Claude.app で確認する。
利用できる実アプリ・版・接続方式を確認し、設計確定→対象選択→準備→送信→結果取得→
評価・人の判断→続行または完了の一往復を実行する。
複数 Work Item がある状態でも対象の worktree・branch を判別できることを確認する。

利用環境に実アプリ接続がない場合は未検証として残し、SDK の結果で代用しない。
確認結果に応じて利用ガイドと仕様の実装状況を更新する。

## 各作業単位の終了条件

変更した契約に対応する integration test を実行する。状態判定・結果検証の分岐は必要に応じて
unit test で補う。関連する storage/migration/process の既存保証を維持する。
型・lint・依存一覧・build を確認し、共通基盤の変更では既存の全テストも実行する。

検証済みの範囲、残る作業、確認できない外部条件をこの計画に記録する。
新しい数値制限や依存は、要件上の必要性と根拠が確認できる場合だけ導入する。
作業ログは進捗の記録であり、仕様文書を置き換えない。

## 作業結果

### 1A 自動サイクルの互換設定化

- 共通の application supervisor と daemon 設定を更新した。起動・再開の拒否では
  DB 状態を変更せず、内部の段階起動にも同じ設定を適用する。
- `list_agent_profiles` から `legacyCyclesEnabled` を取得できる。
  README、設定・操作ガイド、API 説明、仕様の実装状況、changelog を更新した。
- 設定の既定値、禁止時の未起動・未保存、無効設定での再起動後の履歴取得・再開拒否・中止、
  MCP/CLI のエラー伝達を確認した。既存の互換サイクルの試験も明示的な有効化で維持した。
- `npm run check` は全 250 テスト、型、lint、依存一覧、build が通過した。
  サンドボックス内では既存のファイル監視試験が `EMFILE` で待機したため停止し、
  許可されたサンドボックス外の実行で全チェックを完了した。試験内容は変更していない。
- 1A 完了時点では自由文の `start_run` が残っていた。以下の変更で準備済み区切りの送信へ移行した。

### 1B・1C・2A・2B 標準の区切りフロー（2026-10-05、実装・検証済み）

- 変更理由: 自由文で起動する既存 Run と一時的な出力だけでは、確定設計・確認した全文・
  作業報告・アプリ評価・人の判断の関係を保持できず、仕様の標準フローを成立させられなかった。
  Run/cache の保持期間から独立した checkpoint を追加し、公開入口も同じ送信・判断待ちの契約に移した。
- `confirm_design`、`prepare_prompt`、`get_checkpoint`、`discard_prompt` を追加した。
  schema version 3 の append-only migration 0003 に設計版と checkpoint を保存する。
  旧 Plan/Run は保持し、確定設計や確認済み区切りへ自動変換しない。
- `start_run` は `checkpointId` だけを受け付け、保存全文を送信する。
  準備後の context/Profile/workspace/code の変更、重複・同時送信を検査する。
  区切りは終了後に評価・判断を待ち、`record_checkpoint_review` の判断を次の準備へ渡す。
- 手動 Run の size-checked 構造化報告、エラー・欠落状態、評価・判断履歴を永続化した。
  生ログは availability と truncated を返し、cleanup と Run 間引きで報告を消さない。
- `get_checkpoint_changes` / `get_checkpoint_source` で現時点の Git/worktree 証跡を公開した。
  HEAD/index/内容/mode/symlink 名の fingerprint、取得時刻と完全性、累積差分と
  区切りで変わったファイルの区別、バイトページと変更検出を実装した。
  source/diff 全文の過去保存は追加せず、submodule snapshot は明示的に拒否する。
- `npm run check` は全292テスト、型、lint、依存一覧、build が通過した。
  MCP STDIO と CLI/IPC の実 transport で設計確定から人の完了判断までを確認した。
  設計の不変性、準備後の変更、同時送信、再起動、報告欠落・不正・容量不足、Run間引きと
  ログ消去後の保持、変更内容の完全性・安全なソース取得も検証した。
  終了直後のdaemon停止で報告保存を待たない競合を修正し、再現テストで保持を確認した。
  サンドボックス内の既存監視試験の制約を避け、承認済みのサンドボックス外で実行した。
- 報告記録が失敗したときは `recordingState: incomplete` を返し、次の準備を拒否する。
  reserveへの原因保存と再起動回復も検証した。Run間引きは次の準備を無効化しない。
- 残る作業: 3 の ChatGPT.app / Claude.app による基本フローの確認。
  このセッションでは実アプリを操作する接続を確認できていないため、利用環境を問い合わせた。
  SDK/CLI試験を実アプリの往復や新しい全フローのreal-agent確認結果として扱わない。

### プロジェクト全体の保守性改善（2026-10-05）

- Mode: Improve。対象は直前のコミットに限定せず、`src/`、`test/`、`scripts/`、
  設定・依存・CI とリポジトリ内の仕様・利用資料全体。
- 根拠: 人がアプリで評価・判断する仕様、既存の状態遷移・保存容量・公開 API の契約と
  既存テスト。採用条件は、その契約に反する入力・状態・失敗経路、または具体的な
  変更影響を再現できること。既知の3件を含む下記21件を重要度によらず修正した。
- 変更理由: 完全性の誤表示、保存処理の順序への依存、不正な境界入力により、
  アプリから安全に作業を評価できず、失敗時の状態や保証責任が利用者・呼び出し側に漏れていた。
  状態の所有者で判定を共有し、境界で入力・出力を検証する。

Evidence の位置は修正後のコード。観測事実は修正前の再現結果を記載する。

| Severity | Category             | Finding                                                      | Evidence                                                                                                | Impact                                   | Direction（実施済み）                                           |
| -------- | -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| High     | 仕様との不一致       | 検査省略フラグ付きの変更を完全と表示                         | `src/infrastructure/git/repository-evidence.ts:422`: `assume-unchanged` の編集で差分なし・complete=true | 評価から変更が欠落                       | フラグを fingerprint に含め、unchecked と不完全性を返す         |
| High     | 仕様との不一致       | UTF-8 差分が byte 上限を超える                               | `src/infrastructure/git/git-cli.ts:29`: 300 bytes 指定で592 bytes返却                                   | caller の予算とページ契約が崩れる        | Buffer で制限し文字境界を保持。不正 UTF-8 も partial            |
| High     | 仕様との不一致       | filemode 設定で executable bit 変更が欠落                    | `src/infrastructure/git/repository-evidence.ts:29`: core.filemode=false で chmod の差分なし             | 実行可能性の変更をレビューできない       | diff コマンドだけ core.filemode=true を指定                     |
| High     | API boundary         | 小さい未追跡ファイルに巨大な予算を指定するとメモリ確保が失敗 | `src/infrastructure/git/repository-evidence.ts:490`: maxBytes=MAX_SAFE_INTEGER で RangeError            | 有効な取得要求が失敗                     | 実ファイルサイズに応じた Buffer を確保                          |
| High     | 仕様との不一致       | 互換サイクルの証跡が未追跡内容・部分差分を完全と扱う         | `src/infrastructure/git/repository-evidence.ts:355`: 未追跡本文がレビュー入力にない                     | 不完全な材料でレビューを続ける           | 差分収集を共有し、partial は既存の CHANGES_TOO_LARGE で判断待ち |
| High     | 仕様との不一致       | 正常な報告保存待ちを incomplete と表示                       | `src/application/runs.ts:490`: Run 終了から Git 取得・保存まで誤表示                                    | 一時状態を保存失敗と誤認                 | 同じ保存ライフサイクル判定を checkpoint/status が参照           |
| High     | 仕様との不一致       | cleanup が保存待ち出力を削除                                 | `src/application/storage.ts:119`: 終了後・保存前の TTL cleanup で RESULT_LOST                           | 保持契約に反して報告が失われる           | 保存待ち Run と全 cache ref を保護                              |
| High     | 不正な状態           | 別の対象の判断を supersede できる                            | `src/application/records.ts:83`: 別 Work Item や Plan 全体の判断が失効                                  | 判断の有効範囲が混ざる                   | 同じ planId/workItemId の組に限定                               |
| High     | 仕様との不一致       | schema 保存失敗後にも CLI を起動                             | `src/application/runs.ts:313`: schema 書き込み失敗の close 結果を無視                                   | 報告不能な実行が始まる                   | failed/truncated/bytes を確認し、準備を保持して起動拒否         |
| Medium   | 不正な状態           | 中断中の終了済み区切りを評価できない                         | `src/application/checkpoints.ts:308`: paused に実行用 guard を適用                                      | 停止と評価の責務が結合                   | 評価は変更可能状態で許可。次の実行には再開を要求                |
| High     | 仕様との不一致       | migration 適用履歴の欠落を許容                               | `src/infrastructure/sqlite/migrator.ts:134`: 中間・先頭の履歴削除でも最終 version 一致で受理            | DB 整合性の保証が崩れる                  | 件数と連続 version を確認し、変更前に拒否                       |
| High     | 仕様との不一致       | 実行可能な directory を command と判定                       | `src/infrastructure/agents/process-launcher.ts:27`: X_OK の directory を available と表示               | 準備と実起動の契約が不一致               | 実行権限と regular file を確認。symlink は維持                  |
| High     | 仕様との不一致       | cache close callback の失敗を取り落とす                      | `src/infrastructure/cache/file-cache.ts:113`: callback error が error event より先でも failed=false     | 上位層で保存成功と誤認                   | close の error 引数を失敗結果に反映                             |
| High     | 不正な状態           | benchmark が無効な workload を受理                           | `scripts/benchmark-options.ts:12`: 0/NaN/Infinity/小数で無効な測定・NaN                                 | 成功表示の測定値を信頼できない           | 正の safe integer を setup 前に検証。既定値は維持               |
| High     | 強い coupling        | sampler 起動直後の停止で応答なし                             | `scripts/storage-sampler.ts:44`: 1×1×1 で空出力を JSON.parse                                            | 測定成立が OS の起動順序に依存           | ready を待ち、close 後に出力を解釈                              |
| Medium   | 強い coupling        | benchmark 失敗後に sampler が残る                            | `scripts/bench-storage.ts:107`: 異常時に停止処理を通らない                                              | 終了処理が正常系の順序に依存             | finally で停止・daemon close・一時領域 cleanup                  |
| Low      | Repository coherence | benchmark コメントの参照先が古い                             | `scripts/bench.ts:3`: README に移動済み Performance 節を参照                                            | 測定の文脈を見つけられない               | 現行実装ガイドの Performance を参照                             |
| High     | API boundary         | 不正な IPC response の shape を受理                          | `src/interface/ipc-protocol.ts:17`: null/不正 error/非 Boolean ok で例外または誤受理                    | consumer の失敗処理が不安定              | wire response を decode し INTERNAL に正規化                    |
| High     | API boundary         | 途中で切れた HTTP 応答が待機のまま                           | `src/interface/ipc-client.ts:41`: headers 後の切断で response error 未処理                              | CLI/MCP の要求が終了しない               | response error を INTERNAL で返す                               |
| Medium   | API boundary         | CLI --input が非 object を受理                               | `src/interface/cli/main.ts:86`: null と flag の併用で TypeError、array の flag 消失                     | 公開入力契約と失敗表現が崩れる           | JSON object を検証して VALIDATION_FAILED                        |
| Medium   | Repository coherence | SECURITY が独自 sandbox を予定と説明                         | `SECURITY.md:19`: adapter 境界の仕様と異なる将来保証                                                    | 利用者・実装者が誤った安全性を前提にする | 現行の adapter 権限と workspace 検証の責任を明記                |

#### 保証責任と文書の整合性

- Git の実リポジトリ、SQLite、FileCache、プロセス、HTTP socket、CLI を用いる
  integration test で各境界の契約を検証する。既存の成功系は重複させず、欠けていた
  失敗・中断・保存中の状態を追加した。benchmark 引数の値判定は unit test で保証する。
- 既存テストの削除・統合はなく、現在の実装に合わせて期待する仕様を弱めていない。
  cache close の伝播は実 FileCache の schema 保存失敗試験で保証する。
- 仕様の正本、現行利用ガイド、CONTEXT、SECURITY、CHANGELOG、benchmark の説明を
  修正後の責任・状態・失敗表現に合わせた。過去の検証件数は履歴として残し、現行説明の
  固定件数はこの作業結果への参照にした。ADR は追加していない。
- dependency/lockfile、設定値、CI、README の入口と適用済み SQL migration は
  現行契約と整合しており変更不要。新しい依存、数値の quota、DB schema は追加していない。
- 有効な既存 fingerprint は保持する。検査省略フラグがある場合だけ識別情報を加える。
  差分取得はリポジトリの index・config を変更しない。互換サイクルでは全文 snapshot を
  新たに必須化せず、既存の状態取得コストを保つ。
- 検証: `npm run check` で全314テスト（従来292件に22件追加）、型、lint、
  runtime 依存一覧、build が通過した。テストの失敗・中止・skip は0。
  最初の lint で検出した IPC の reject 型を修正した後、全チェックを完了した。
  既存のファイル監視試験はサンドボックス内で EMFILE となるため、承認された
  サンドボックス外で実行した。監視試験の契約は変更していない。
  benchmark の1 Plan・1 Work Item・1 iteration で実測が成立し、
  不正な件数は setup 前に拒否されることも確認した。
- 未検証の外部条件: ChatGPT.app / Claude.app の実接続と基本フロー、および今回の
  checkpoint 全フローの real-agent 確認。既存の SDK/CLI 結果で代用しない。

### 2026-10-05 — 大きなリポジトリでのプロンプト確認と調査レポート

- 背景: 実環境の `get_checkpoint` は約6.36MB、`get_work_item` は約6.47MBとなり、
  MCP クライアントが報告する1MB境界を超えて確認できなかった。送信全文は約15KBであり、
  主因は13,954件の内部ファイル識別情報を公開応答に含めていたことだった。
- 公開 Checkpoint を内部永続記録から分け、コード状態は HEAD・fingerprint・件数を返す。
  準備・取得・作業項目取得・破棄・評価の応答で同じ投影を使う。内部のファイル別情報は
  送信前照合と変更ファイル算出のため保持する。MCP と CLI は共有操作を通る。
- Profile の書き込み・コマンド制約と、利用できないツールに対する代替手順の扱いを
  送信全文に含める。調査成果物を2,000文字の概要に押し込めないよう、作業報告の
  `content` に本文・引用・付録を保存する。過去の `content` がない報告も受理し、
  全体の既存バイト予算は維持する。容量に収まらない成果物を黙って省略せず判断待ちに戻す。
- 回帰試験: 実際の MCP→IPC→SQLite の経路で13,954件のコード状態を注入し、
  修正前4,841,728 bytesの応答による失敗を確認した。修正後は全公開応答の確認、
  全文保持、内部証跡保持、コード変更時の送信拒否、終了時の証跡を検証した。
  読み取り専用 Profile の指示と、2,000文字を超える本文の永続保存は別の統合試験で保証する。
- 文書: 仕様正本・現行実装ガイド・変更履歴に公開コード状態と全文レポートの契約を反映した。
  DB migration、依存、設定、Profile の権限、ADR は追加していない。
- 検証: `npm run check` は全316件、型、lint、依存一覧、build が通過した。
  サンドボックス内の既存ファイル監視試験は停止したため、テストを変更せず
  サンドボックス外で全チェックを完了した。
- 実環境: 実行中のRunが0件であることを確認して修正版daemonへ再起動した。
  Claude の保存済み接続設定を使うMCPクライアントで、同じ既存Checkpointの
  応答が57,609 bytesとなり、送信全文が保持されることを確認した。
  新しい設計版と逐次調査のプロンプトを準備し、旧プロンプトは履歴を保持して破棄した。
  新しいCheckpointの応答は62,521 bytes、両Checkpointを含む作業項目は110,293 bytes。
  調査Runは開始していない。Claude.app の会話画面からの再取得と実際のCLI調査は未検証。
