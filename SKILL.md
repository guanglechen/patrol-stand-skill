---
name: inspection-standard-hierarchy-consultant
description: 基于用户材料、历史标准表和行业参考资料，设计层级优先的巡检标准 Excel 工作簿。适用于梳理巡检标准层级结构、冻结一级/二级分类、映射组织职责与覆盖关系，并输出 `巡检标准架构树`、`覆盖矩阵`、`标准清单` 等成果，再进入后续指导书编写。
---

# 层级优先的巡检标准工作簿技能

## 总体原则
把工作簿视为核心产物。先完成分类结构、责任归口和覆盖逻辑，再决定是否细化到具体巡检项。

成功标准是：用户可以直接审阅、质疑和调整层级结构；不要求一开始就产出大量 `标准清单` 行。

## 工作流程
1. 先读用户材料，并判断它们属于哪几类：
   - 原始业务梳理表
   - 历史 `标准清单` / `巡检标准架构树` 工作簿
   - 组织职责材料
   - 法规或外部参考资料
2. 固定加载 `references/common-ontology.md` 和 `references/workbook-contract.md`。
3. 在设计层级前，加载 `references/hierarchy-design-playbook.md` 和 `references/question-bank.md`。
4. 识别行业包：
   - 产业园场景加载 `references/packs/industrial_park.md`
   - 化工场景加载 `references/packs/chemical-scaffold.md`
   - 未知行业只使用通用本体，并明确标记行业包尚未成熟
5. 按以下顺序设计层级：
   - `L0 行业/场景包`
   - `L1 一级分类`
   - `L2 二级类别`
   - `L3 典型对象/部位组`
   - `L4 巡检项` 只在用户明确要求细化，或原材料已经具备稳定巡检项时再展开
6. 只有回答清楚以下问题后，才能冻结层级：
   - 每个 `L1` 为什么存在
   - `L2` 为什么按当前方式归并
   - 哪些内容被有意排除在外
   - 每个类别由哪个组织或专业归口
7. 按 `references/workbook-contract.md` 约定的固定工作表顺序输出工作簿。
8. 用 `scripts/validate_workbook.py` 校验最终结果。

## 决策规则
- 层级设计要和文风控制、下游 SOP 章节拆分彻底分开。
- 当 `巡检标准架构树` 和 `标准清单` 冲突时，以前者为准。
- `标准清单` 是可选细化层；如果层级信心高、条目信心低，可以留空或只输出样例行。
- 缺乏证据的结论必须标记为 `needs_review` 或 `assumed`，不能静默提升为 `confirmed`。
- 提问必须 hierarchy-first，先问：
  - 分类边界
  - 专业归口
  - 系统边界
  - 空间与设备的拆分关系
  - 外包维保边界
  - 租户或第三方责任边界
- 在层级稳定前，不要直接从“最终巡检动作有哪些”开始。

## 参考资料加载规则
- 固定必读：
  - `references/common-ontology.md`
  - `references/workbook-contract.md`
- 设计层级时再读：
  - `references/hierarchy-design-playbook.md`
  - `references/question-bank.md`
- 按行业加载：
  - `references/packs/industrial_park.md`
  - `references/packs/chemical-scaffold.md`
- 只有用户要求输出 `标准清单` 细节，或源工作簿本身已包含稳定巡检项时，才加载 `references/itemization-rules.md`。

## 脚本用法
- 在技能根目录 `/Users/chenguangyue/Documents/code/skill/patrolStand` 下运行。
- 从源工作簿生成结构化 case JSON：
```bash
python3 scripts/bootstrap_case.py \
  --workbook /path/to/source.xlsx \
  --output output/verification/inspection_case.json
```
- 从结构化 JSON 渲染工作簿：
```bash
python3 scripts/render_workbook.py \
  --input output/verification/inspection_case.json \
  --output output/verification/inspection_standard_workbook.xlsx
```
- 校验最终工作簿：
```bash
python3 scripts/validate_workbook.py output/verification/inspection_standard_workbook.xlsx
```

## 输出要求
- 工作簿必须固定包含以下工作表，并保持顺序一致：
  - `巡检标准架构树`
  - `组织职责`
  - `覆盖矩阵`
  - `待确认项`
  - `引申依据`
  - `标准清单`
- `巡检标准架构树` 是最终事实来源。
- 每条 `L1` / `L2` 都必须带上设计理由、纳入边界、排除边界和责任归口信号。
- `待确认项` 必须显式记录仍然阻塞确认的内容，不能把不确定性藏在描述性文字里。
- 如果 `标准清单` 是基于弱证据生成的，必须标记为 `sample_only`。

## 质量门槛
- 不接受 `L1 -> L3` 直跳、但没有稳定 `L2` 的层级结构。
- 不接受有 `L1` 分类、却没有任何组织职责行映射到它的工作簿。
- 不接受只重复层级名称、却没有体现已覆盖内容和缺口的覆盖矩阵。
- 优先输出更小但可辩护的层级结构，而不是更大但臆测性强的结构。
