# 工作流规范

本文档是 Phase: 沙箱化+ACP统一 的**强制工作流**。所有参与者必读。

---

## 1. 角色

| 角色 | 职责 | 生命周期 |
|------|------|---------|
| Leader | 监督流程流转，不写代码 | 全程 |
| 架构师 | 拆模块、定接口契约、写 TASK-LIST.md / REGRESSION.md | 拆完即撤 |
| 非业务开发 | 写一个纯净模块（代码 + README.md） | 写完即撤 |
| 业务开发 | 用胶水逻辑串非业务模块（代码 + README.md） | 写完即撤 |
| 测试员 | 按 REGRESSION.md 逐条验证 | 测完即撤 |
| 修复员 | 修 bug + 更新 md | 修完即撤 |

**每个人干完就撤，不续命不复用。**

---

## 2. 模块分类

### 非业务模块（纯净层）
- 只暴露接口，不 import 任何业务代码
- 不依赖全局单例（bus / db / config）
- 可独立 `import` + 单测，零外部依赖
- 例：`process-runtime/`、`agent-driver/`（解耦后）

### 业务模块（胶水层）
- 串接多个非业务模块，填充业务逻辑
- 负责：事件编排、时序控制、错误传播、状态同步
- README.md 必须包含：时序图、竞态分析、错误传播路径
- 例：`member-agent/`、`bus/subscribers/member-driver.subscriber.ts`

---

## 3. 交付标准

每个开发者（无论业务/非业务）交付：

```
packages/backend/src/<模块目录>/
├── *.ts                    ← 代码（单文件 ≤ 200 行）
├── *.test.ts               ← 测试（不 mock db/bus）
└── README.md               ← 模块使用手册
```

### README.md 必须包含

**非业务模块：**
1. 这个模块是什么（一句话）
2. 接口定义（TypeScript 签名）
3. 使用示例（3-5 行代码）
4. 注意事项 / 边界行为

**业务模块（胶水）额外要求：**
5. 时序图（ASCII）— 哪个事件先、哪个后、并发怎么办
6. 竞态分析 — 列出可能的竞态场景 + 解决方案
7. 错误传播路径 — A 模块挂了 → 胶水怎么处理 → 最终状态是什么

---

## 4. 执行流程

```
Stage N 启动
    │
    ▼
架构师进场 → 读设计文档 → 拆模块 → 写 TASK-LIST.md + REGRESSION.md → 撤
    │
    ▼
Wave 1: 非业务模块开发（并行）
    ├─ 开发 A → mod-xxx（代码+README+测试）→ 撤
    ├─ 开发 B → mod-yyy → 撤
    └─ 开发 C → mod-zzz → 撤
    │
    ▼ （全部完成才进 Wave 2）
Wave 2: 业务模块开发（可并行，如果胶水之间不耦合）
    ├─ 开发 D → glue-xxx（串模块+README+测试）→ 撤
    └─ 开发 E → glue-yyy → 撤
    │
    ▼
Wave 3: 测试
    └─ 测试员 → 按 REGRESSION.md 逐条验 → 出报告 → 撤
    │
    ▼
有 bug？
    ├─ 是 → 新修复员进场 → 改代码+更新md → 撤 → 新测试员重测 → 循环
    └─ 否 → Stage N 完成 ✅ → 更新 MILESTONE.md
```

---

## 5. 文件组织

```
packages/backend/docs/phase-sandbox-acp/
├── MILESTONE.md                 ← 总进度（leader 维护）
├── WORKFLOW.md                  ← 本文件
├── stage-1/
│   ├── TASK-LIST.md             ← 模块清单 + 负责人 + 状态
│   └── REGRESSION.md            ← 回归测试清单
├── stage-2/
│   └── ...
...

packages/backend/src/
├── process-runtime/
│   ├── types.ts
│   ├── host-runtime.ts
│   ├── host-runtime.test.ts
│   └── README.md                ← 模块使用手册（下一个人读这个就能用）
├── agent-driver/
│   └── README.md                ← 解耦后的接口说明
├── member-agent/
│   └── README.md                ← 时序图 + 竞态分析
...
```

---

## 6. 硬性规则

1. **干完留 md 走人** — 不口头交接，一切写在 README
2. **单文件 ≤ 200 行** — 超过就拆
3. **不 mock db/bus** — 用真实依赖测试
4. **非业务模块不 import 业务代码** — 编译期就能检查
5. **业务模块 README 必须有时序图** — 没有不算完成
6. **测试员和开发不是同一个人** — 产出和验证分离
7. **REGRESSION.md 是测试的唯一依据** — 测试员只看这个
8. **Wave 1 全完才启 Wave 2** — 不抢跑

---

## 7. Leader 职责

- 确保每个 Stage 的 TASK-LIST.md 由架构师产出
- Wave 1 全部交付后才派 Wave 2
- Wave 2 交付后立即派测试
- bug 修复后立即派新测试员重测
- 更新 MILESTONE.md 状态
- 不写代码、不做调研、不跑命令
