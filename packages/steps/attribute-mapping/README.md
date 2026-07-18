# Ozon 第 6 步：属性与俄语内容

本包是事实属性填写的唯一实现，输入 CanonicalProductV2、类目决定、类目
属性快照、成本重量与当前 Agent 的封闭 JSON 决策，输出：

- `attribute-mapping-v2.json`
- `content-bundle-v1.json`

程序先填写确定性属性；当前 Agent 只处理任务中列出的属性，并且字典属性
只能选择快照中的真实候选 ID。属性 85 固定为无品牌 `126745801`。重量按
已锁定策略写入：4383 为成本步骤采用的基础重量，4497 为该重量加 50g，
并以 `legacy_4383_base_4497_plus_50` 显式审计。

俄语标题、描述和标签由当前 Agent完成，不接入外部文字 LLM。内容必须引用
已验证的 CanonicalProductV2 事实；缺少必填属性、伪造字典值或无效证据时
产物为 `blocked`，待补充的封闭任务为 `needs_review`。
