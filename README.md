# PocketAgent

透過 Tailscale，在手機瀏覽器操作自己電腦上的 Codex CLI。支援專案切換、既有 session、串流對話、圖片輸入、操作核准，以及唯讀檔案預覽。

服務在你的電腦執行，網頁與 Codex 使用相同的本機帳號。Codex 的推論仍使用原帳號的 OpenAI 服務，並遵守該帳號與公司的管理限制。

## 環境

- Node.js 24 或更新版本、npm。
- 已安裝且完成登入的 Codex CLI；開發與 CI 會使用 CLI 產生對應協定型別。
- Windows 電腦與手機均已連線至自己的 Tailscale 網路，且網路存取規則允許連到服務。

## 安裝與啟動

```powershell
npm ci
npm run build
npm run pair
npm start
```

`pair` 只在本機終端機顯示一次性配對碼，10 分鐘有效。手機開啟 `http://<Tailscale-IP>:3000`，輸入配對碼即可使用。服務會記住裝置 30 天。

啟動時會自動尋找 Tailscale IPv4；Tailscale 尚未連線時會等待。不要將服務直接轉發到公開網際網路。電腦需要保持開機、登入並連線；PocketAgent 不會修改系統睡眠設定。

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

停止指令只針對由本專案啟動、且可驗證執行路徑與啟動時間的程序樹。移除排程不會刪除資料，也不會自行停止已在執行的服務。

### 裝置管理

```powershell
npm run pair
npm run devices
npm run revoke -- <device-id>
npm run revoke -- all
```

撤銷後，該裝置需重新配對。配對碼、裝置憑證與瀏覽器 cookie 都不可分享或提交至 Git。

## 使用方式

1. 選擇專案，建立新 session，或載入既有的 CLI session。
2. 選擇可用模型、輸入訊息，必要時附加圖片。
3. 在對話中檢視執行狀態、命令輸出與變更差異，回答問題或核准操作。
4. 檔案區提供唯讀預覽；修改程式請交由 Codex。

支援 JPEG、PNG、WebP 圖片，每張最多 10 MiB。圖片會存放於本機執行資料目錄，再交給 Codex。

手機鎖屏、切換網路或關閉網頁不會取消工作。重連會補齊狀態，待核准操作會繼續等待。程序異常後，服務會顯示中斷，不自動重跑可能已產生副作用的工作。

同一 session 一次僅接受一個工作。請在 CLI 與網頁之間擇一操作同一 session，避免同時續聊。

從網頁新建或續接 session 時，會套用 PocketAgent 的 `workspace-write` 與 `on-request` 權限預設，覆寫該 session 原本的個別偏好；帳號與組織的強制政策仍然優先。

### 目前的互動限制

網頁支援 Codex 原生問題與一般命令／檔案核准。外部 MCP 工具若要求額外的表單或網址驗證（elicitation），目前網頁僅支援拒絕／取消。請先取消該次網頁操作，再使用支援該流程的本機客戶端重新發起；另一個 CLI 程序無法接手回答此網頁 stdio 程序正在等待的互動。

## 本機設定與資料

所有執行資料存於 `%LOCALAPPDATA%\PocketAgent`，包含本機設定、配對與裝置索引、圖片及診斷日誌。Codex 原有認證與 session 由 CLI 管理，PocketAgent 不直接修改其儲存檔案。

可在外部資料目錄的 `config.json` 設定：

```json
{
  "host": "tailscale",
  "port": 3000,
  "projectRoots": ["C:\\Projects"]
}
```

預設專案範圍為 PocketAgent checkout 的上層目錄。`projectRoots` 設定允許瀏覽的專案根目錄；符號連結與實際路徑也會檢查範圍。需要指定 CLI 時，可加入 `codexPath`，填入本機 Codex 可執行檔或 JavaScript 入口的絕對路徑。

環境變數可覆寫設定：

| 變數 | 用途 |
| --- | --- |
| `POCKETAGENT_DATA_DIR` | 執行資料目錄，必須在 checkout 外 |
| `POCKETAGENT_HOST` | `tailscale` 或明確的 Tailscale IPv4；本機開發可用 loopback |
| `POCKETAGENT_PORT` | 服務埠號，預設 3000 |
| `POCKETAGENT_CODEX_PATH` | Codex 執行入口 |

範例只使用佔位路徑。不要把你的實際設定、Tailscale IP 或其他專案內容放進此公開 repo。

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
