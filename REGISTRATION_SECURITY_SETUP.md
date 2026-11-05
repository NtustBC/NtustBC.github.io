# Firebase 安全功能部署

Firestore Rules 必須另外部署；只更新 GitHub Pages 靜態檔案不會套用後端權限修正。目前社員申請改用 Firestore Transaction，不依賴 Cloud Functions，可在 Firebase Spark 免費方案運作。忘記密碼以 Firestore Rules 比對四項資料並直接建立管理員通知，幹部人工確認後從 Firebase Console 處理，不需要 Cloud Functions。

## Spark 方案部署步驟

1. 部署 Firestore Rules（不要加上 `functions`）：

   ```powershell
   firebase deploy --only firestore:rules
   ```

2. 重新建置並發佈 GitHub Pages 靜態網站。
3. 管理員登入「社員管理」，在「社員申請名額與期間」重新按一次儲存。這會寫入 Rules 驗證開放時間所需的 Firestore Timestamp。

完成後，「儲存申請資料」會在同一筆 Firestore Transaction 中同步更新 `members`、`applications` 與 `membershipRegistrationStats`，並由 Rules 限制登入者只能修改自己、不可突破名額或自行變更為正式社員。

## 部署前設定

1. 確認 Firestore 的 `admins/{uid}` 至少已有一位真實管理員；系統不再接受任何硬編碼管理員 Email。
2. 不需要設定 Resend、SMTP 或郵件 API Key。
3. 在 Firebase App Check 為 Web App 註冊 reCAPTCHA Enterprise，將 Site Key 填入 `src/firebase-config.js` 的 `appCheckSiteKey`。
4. 先觀察 App Check metrics，確認正式站請求正常後，再於 Firebase Console 啟用 Cloud Firestore、Authentication 與 Functions enforcement。
5. 若專案升級為 Blaze 且要啟用其他 Cloud Functions，才部署 Functions 與 Firestore Rules：

   ```powershell
   firebase deploy --only functions,firestore
   ```

6. Firebase Authentication 的 Authorized domains 必須包含正式網站網域。
7. Google Cloud Console 的 Firebase Browser Key 應只允許必要 Firebase API，網站限制加入 `https://ntustbc.github.io/*`；本機開發來源僅在需要時加入。

## 上線前驗收

- 未勾選個資同意時不得建立帳號；完成註冊後，`members/{uid}.privacyConsent` 應有版本與時間。
- 一般帳號即使竄改前端狀態，也無法讀取其他人的 `members` 或建立 `admins/{uid}`。
- 非社員報名開放場次時，不得偽造 `isFormalMemberAtSignup` 或 `dropInPaymentStatus`。
- 未登入訪客不得新增 `faqQuestions`；登入後可以送出問題。
- 建立一場上限 1 人的社課，兩個帳號同時報名時只能有一筆成功。
- 未登入與一般社員都無法讀取 `classSessionSignups`、`classPublicRosters`、其他人的 `members` 資料。
- 忘記密碼需填註冊信箱、姓名、學號與電話；Rules 使用僅管理員可讀的 `passwordResetLookups/{email}` 找出社員，並與目前 `members` 資料逐項比對。訪客不可讀取索引、社員資料或申請。
- 必須先部署本次 Firestore Rules，再發佈網站，最後請管理員重新登入一次，網站會為既有社員建立信箱索引。一般社員登入也會同步自己的索引。若索引不存在，申請會被拒絕，請幹部登入新版網站完成同步。
- 四項資料相符才可在 `adminNotifications/password-reset-{email}` 建立 pending 通知；同一信箱十分鐘內不可重複寫入。資料比對只代表符合原紀錄，仍應以原留電話或當面核對本人。
- 管理員在右上角通知中心按「確認是本人」，會以交易記錄 `identity_verified`、`verifiedBy` 與 `verifiedAt`。一般使用者無權審核；此按鈕不修改密碼，也不寄信。
- 確認後，幹部透過社員管理的「人工核對」入口開啟 Firebase Console → Authentication → Users，處理對應帳號。若不寄重設信，須由具權限的幹部另行使用可信任的 Admin SDK 工具更新密碼，再以已核實的方式告知本人；靜態網頁無法替其他帳號設定密碼。
- 網站移除自助重設入口，但 Firebase 原生公開寄信 API 仍可能被直接呼叫；前端人工審核流程不是 Firebase 強制的重設前置條件。若要求技術上強制每次重設皆經審核，需另設可信任後端與身分驗證架構。
- 本次需部署 Firestore Rules 與發佈靜態網站，不需部署 Functions。

## 持續維護

- 新增社員可自行修改的欄位時，必須同步更新 `members` 的 Rules 白名單與欄位驗證。
- 新增外部 Script、API、圖片或字型來源時，必須同步審查所有 HTML 的 Content Security Policy。
- 若管理員數量與權限層級增加，建議改用 Firebase Custom Claims，並僅由 Admin SDK 設定聲明。
