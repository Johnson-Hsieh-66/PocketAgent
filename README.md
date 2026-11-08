# PocketAgent

在家透過區域網路、外出透過 Tailscale，用手機瀏覽器操作自己電腦上的 Codex CLI。支援專案切換、既有 session、串流對話、圖片輸入、操作核准，以及唯讀檔案預覽。

服務在你的電腦執行，網頁與 Codex 使用相同的本機帳號。Codex 的推論仍使用原帳號的 OpenAI 服務，並遵守該帳號與公司的管理限制。

執行服務與網頁代理是兩個獨立程序：執行服務持有 Codex、工作、待核准項目與事件紀錄；網頁代理只透過有認證的本機 IPC 提供 PocketAgent API。重啟或更新網頁代理不會結束 Codex 工作。瀏覽器無法直接存取 Codex RPC。

## 環境

- Node.js 24 或更新版本、npm。
- 已安裝且完成登入的 Codex CLI；開發與 CI 會使用 CLI 產生對應協定型別。
- 在家使用：手機與電腦可在同一個區域網路互相連線。手機連 Wi-Fi、電腦接同一路由器的有線網路也可以。
- 外出使用：Windows 電腦與手機均已連線至自己的 Tailscale 網路，且網路存取規則允許連到服務。

## 安裝與啟動

```powershell
npm ci
npm run service:update
npm run pair
```

新安裝預設開啟「要求裝置配對」。`pair` 只在本機終端機顯示一次性配對碼，10 分鐘有效。手機在家開啟 `http://<LAN-IP>:47831`，外出則開啟 `http://<Tailscale-IP>:47831`，輸入配對碼即可使用。服務會記住裝置 30 天。

預設 `private` 模式會在個別的本機 loopback、實體網路介面的私人 LAN IPv4，以及 Tailscale IPv4 上提供服務，並每 5 秒更新可用介面。Tailscale 尚未連線時，本機與 LAN 仍可使用；DHCP 位址變更或 Tailscale 上線後，監聽位址會自動更新。

各位址共用同一份專案、session 與 Codex 工作，但瀏覽器的裝置 cookie 依 IP 分開。啟用配對時，第一次切換 LAN／Tailscale 位址，或 LAN IP 改變時，需要在電腦執行 `npm run pair` 產生新碼，再為該位址配對。建議出門前先完成 LAN 與 Tailscale 兩個位址的配對。

若你的 Tailscale 網路已有家中 LAN 的子網路由，且手機接受該路由、ACL 也允許存取，可在外面繼續使用同一個 LAN 網址。這取決於現有 Tailscale 設定，PocketAgent 不會自動新增或開放子網路由。

若同一區網的手機無法連線，請檢查 Windows 防火牆的服務埠與路由器的裝置隔離設定；訪客 Wi-Fi 可能禁止裝置互相存取。外出仍需使用 Tailscale。服務僅監聽允許的私人位址，請勿將服務轉發至公開網際網路。

電腦需要保持開機、登入並連線；PocketAgent 不會修改系統睡眠設定。

### Windows 自動背景啟動

先完成建置，再執行：

```powershell
npm run startup:install
npm run service:start
```

排程以目前 Windows 使用者身分、隱藏視窗，在使用者登入時啟動。鎖定畫面不會結束工作；登出或關機會停止服務。更換 Node 安裝位置或移動專案後，請重新安裝啟動排程。

```powershell
npm run service:stop
npm run startup:remove
```

停止指令只停止可驗證的網頁代理，執行服務與 Codex 工作會繼續。需要明確中斷執行端時才使用 `npm run worker:stop`。兩者由不同的 Windows 排程工作啟動；移除排程不會刪除資料，也不會自行停止服務。

### 更新服務

修改完成後，使用 `$pocketagent-update` skill 或在專案目錄執行：

```powershell
npm run service:update
```

更新流程先完成檢查與建置，將程式與依賴封存至外部執行目錄的版本資料夾，再交給獨立的部署排程切換。部署程序不屬於網頁或 Codex 的子程序樹，網頁代理停止後仍會完成啟動與驗證；新版不健康時會回復舊版。不要在遠端 Codex 工作內直接串接 `service:stop` 與 `service:start`。

一般網頁更新保留執行服務。執行端程式也有變更時，會先取得原子的閒置維護鎖，確認沒有工作、待核准或未完成 RPC 後才更換執行服務。若發起更新的對話本身仍在執行，skill 會回傳 `waitingForIdle` 收據；該輪結束後，獨立部署工作才會繼續，並非已宣告部署完成。

更新來源與技能原始碼位於 `skills/pocketagent-update`。部署收據與版本指標留在外部執行目錄，程式不會複製 Codex 憑證或對話檔案進版本包。

### Windows 防火牆

若手機或區網裝置無法連入，可安裝 PocketAgent 專用的輸入規則：

```powershell
npm run firewall:install
```

此指令會要求 Windows 管理員權限，並在需要時顯示使用者帳戶控制（UAC）同意視窗。完成管理員同意後，才會建立規則；取消或沒有管理員權限時，此步驟不會完成。

規則限定目前的 Node 可執行檔、外部 `config.json` 設定的 TCP 埠號，以及私人本機位址；來源限定本機子網路與 Tailscale 範圍。若更換 Node 安裝位置或調整設定埠號，請重新執行安裝指令更新此專用規則。

移除規則也需要管理員同意：

```powershell
npm run firewall:remove
```

### 裝置管理

```powershell
npm run pair
npm run devices
npm run revoke -- <device-id>
npm run revoke -- all
```

啟用配對時，撤銷後的裝置需重新配對。配對碼、裝置憑證與瀏覽器 cookie 都不可分享或提交至 Git。

### 是否要求裝置配對

可在網頁「設定 → 裝置存取」調整「要求裝置配對」，或在電腦執行：

```powershell
npm run pairing -- status
npm run pairing -- off
npm run pairing -- on
```

公開原始碼的新安裝預設為 `on`。關閉後，能連線到此私人網頁服務的客戶端即可操作 Codex，無須輸入配對碼。此開關只控制裝置配對，私人位址監聽、Host／Origin 檢查與 Codex 工作區權限仍持續適用。

設定存於 repo 外的本機資料庫，立即生效，不需要重新啟動服務。切換開關會保留既有裝置紀錄；重新開啟後，有效配對繼續有效，未配對或憑證過期的裝置需完成配對。

### 連線修復

「設定 → 連線修復」提供兩種操作：

- 「重新連接網頁」重建即時連線並補齊狀態，保留輸入草稿與電腦上的工作。
- 「中斷所有工作並重建連線」須再次確認，會中止 PocketAgent 內所有工作與待核准操作，重新啟動此服務擁有的 Codex 程序，並讓所有網頁重新連線。保留對話紀錄、裝置與訊息去重紀錄，不會自動重送訊息。

第二種操作用於 Codex 連線卡住或工作狀態無法恢復時；它不會關閉其他 Codex 客戶端，也不會強制取得其他客戶端占用的對話。HTTP 更新與重連不等於這個會中斷工作的操作；HTTP 已無回應時，可由獨立更新流程或電腦上的服務指令恢復。

## 使用方式

1. 選擇與 Codex 共用的本機專案，建立新 session，或載入既有的 CLI session。
2. 選擇可用模型與思考強度、輸入訊息，必要時附加圖片。思考選項依模型實際支援的清單顯示；接續既有對話時預設沿用原設定。
3. 在對話中檢視執行狀態、命令輸出與變更差異，回答問題或核准操作。
4. 檔案區提供唯讀預覽；修改程式請交由 Codex。

支援 JPEG、PNG、WebP 圖片，每張最多 10 MiB。圖片會存放於本機執行資料目錄，再交給 Codex。

手機鎖屏、切換網路或關閉網頁不會取消工作。重連會補齊狀態，待核准操作會繼續等待。程序異常後，服務會顯示中斷，不自動重跑可能已產生副作用的工作。

同一 session 一次僅接受一個工作。請在 CLI 與網頁之間擇一操作同一 session，避免同時續聊。

若續接時出現「其他 Codex 客戶端正在使用此對話」（`THREAD_WRITER_CONFLICT`），代表其他客戶端仍持有該 session 的寫入權。請先讓原客戶端釋放該對話，再於網頁重試；即使沒有正在生成，原客戶端仍可能持有寫入權，停止生成或最小化視窗也不保證釋放。PocketAgent 不會強制解鎖或關閉其他客戶端。

從網頁新建、續接 session 或開始下一次工作時，PocketAgent 會重新讀取 Codex App 已儲存的本機審核選擇。目前支援將 App 的代理自動審核模式（`guardian-approvals`）同步為原生 `auto_review`。若已載入的對話忽略續接參數，會使用原生 `thread/settings/update` 僅更新審核者，再讀回確認；原生政策拒絕時會顯示錯誤，不會改用其他權限重試或重送訊息。

同步只調整審核者。核准政策、檔案／網路沙箱、具名權限設定與帳號／組織的強制政策仍由 Codex 解析及執行，不修改使用者設定或桌面偏好。專案的 `.codex/config.toml` 仍須符合 Codex 的信任條件才會生效。

輸入框下方會顯示 Codex 回傳的實際授權摘要，例如「工作區寫入 · 自動審核」，並隨原生設定通知更新。缺少偏好、無法讀取、未知或自訂模式時不猜測審核方式，也不沿用舊版偏好覆蓋新的選擇；已載入的對話會保留其原生執行設定。這項同步不會把其他 App 模式或自訂權限設定轉換成額外的檔案／網路存取權。

### 目前的互動限制

網頁支援 Codex 原生問題與一般命令／檔案核准。外部 MCP 工具若要求額外的表單或網址驗證（elicitation），目前網頁僅支援拒絕／取消。請先取消該次網頁操作，再使用支援該流程的本機客戶端重新發起；另一個 CLI 程序無法接手回答此網頁 stdio 程序正在等待的互動。

## 本機設定與資料

所有執行資料存於 `%LOCALAPPDATA%\PocketAgent`，包含本機設定、配對與裝置索引、圖片及診斷日誌。Codex 原有認證與 session 由 CLI 管理，PocketAgent 不直接修改其儲存檔案。

診斷會直接寫入執行資料目錄的 `logs/diagnostics.jsonl`，不依賴終端機輸出。每個檔案最多 1 MiB，連同兩個輪替備份共保留最多三個檔案。記錄僅包含時間、固定狀態／錯誤代碼、元件、固定 API 路由或 RPC 方法，以及必要的數值狀態與耗時；不記錄對話、實際請求網址、檔案路徑、識別碼、原始錯誤或憑證。磁碟寫入失敗不會中斷 Codex 工作。

可在外部資料目錄的 `config.json` 設定：

```json
{
  "host": "private",
  "port": 47831
}
```

專案清單來自 Codex app-server 的官方共用專案目錄，不會掃描磁碟資料夾產生專案。請先在 Codex 加入專案，再重新載入網頁。舊版桌面專案的順序與對話關聯，僅從本機中繼資料唯讀補足；PocketAgent 不會改寫該資料。

既有 `projectRoots` 設定只保留相容用途，不再決定專案清單；檔案預覽依官方專案的實際根目錄驗證存取範圍。需要指定 CLI 時，可加入 `codexPath`，填入本機 Codex 可執行檔或 JavaScript 入口的絕對路徑。

`host` 可選 `private`（預設，自動提供本機、LAN 與 Tailscale 存取）、`tailscale`（僅使用 Tailscale，尚未上線時等待），或明確指定一個允許的私人 IPv4／loopback 位址。各監聽位址均檢查自己的 Host 與 Origin，操作請求須來自開啟該服務位址的網頁。

已有 `config.json` 的使用者可將 `host` 改為 `private`，再重新啟動服務；保留 `tailscale` 則維持原本的 Tailscale 專用模式。

環境變數可覆寫設定：

| 變數 | 用途 |
| --- | --- |
| `POCKETAGENT_DATA_DIR` | 執行資料目錄，必須在 checkout 外 |
| `POCKETAGENT_HOST` | `private`、`tailscale` 或指定私人 IPv4；本機開發可用 loopback |
| `POCKETAGENT_PORT` | 服務埠號，預設 47831 |
| `POCKETAGENT_CODEX_PATH` | Codex 執行入口 |

範例只使用佔位路徑。不要把你的實際設定、LAN／Tailscale IP、網卡資訊或其他專案內容放進此公開 repo。

## 開發與驗證

```powershell
npm ci
npm run protocol:generate
npm run typecheck
npm test
npm run build
npm run secret:check
```

本機前後端開發分別執行：

```powershell
$env:POCKETAGENT_HOST = '127.0.0.1'
npm run dev
```

在另一個終端機執行 `npm run dev:web`。Vite 會代理 API 與 WebSocket 至本機後端。CLI 更新後，重新執行 `npm run protocol:generate` 與相關檢查，再建置。

## 公開 repo 的資料界線

- 只提交程式碼、文件、合成測試資料及去識別化範例。
- 不提交認證、session、對話、上傳圖片、資料庫、日誌、配對碼、裝置憑證、真實 IP、個人路徑或公司內容。
- 診斷日誌只記錄必要狀態與錯誤代碼。瀏覽器不會收到 Codex 登入憑證。
- 每次提交或推送前，檢查完整檔案清單與 staged diff，執行 `npm run secret:check`。掃描是輔助檢查，仍需人工檢視內容。
- CI 僅使用合成資料，不需要登入 Codex，也不會上傳測試執行資料。

貢獻規則見 [AGENTS.md](AGENTS.md)。授權為 [MIT](LICENSE)。
