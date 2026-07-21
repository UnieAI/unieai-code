# elicitation-question

## ADDED Requirements

### Requirement: 結構化提問原語

系統 SHALL 提供與權限管道分離的提問工具（`ask`），讓模型向使用者提出結構化選擇（多個具名選項）。呼叫時 SHALL 阻塞回合直到使用者選擇，回傳所選標籤，且此互動 SHALL NOT 被儲存為可重用規則。提問等待中 SHALL NOT 受工具逾時限制（等待人不是失控工具）。

使用者略過（dismiss）時 SHALL 與本系統的拒絕核准語意一致：工具回傳「使用者未選擇——採合理預設並說明假設、不得重問」的結果，模型據以繼續，而非硬中止迴圈。無提問通道的宿主（無頭執行）SHALL fail-closed：回傳「自行決定並說明假設」，不阻塞。

#### Scenario: 模型提出多選澄清

- WHEN 模型呼叫 ask 工具提出多個選項
- THEN 迴圈阻塞、前端呈現選擇（CLI 選單／VS Code 卡片），使用者選擇後回傳所選標籤，該回合以此繼續，且等待期間不觸發工具逾時

#### Scenario: 使用者略過提問

- WHEN 使用者略過（dismiss）該提問而不選擇
- THEN 工具回傳「未選擇——採合理預設、說明假設、不得重問」，模型繼續本回合，不留存任何規則

#### Scenario: 無頭環境

- WHEN 宿主未提供提問通道（如 benchmark／CI 執行）
- THEN 工具立即回傳「自行決定並說明假設」，不阻塞回合
