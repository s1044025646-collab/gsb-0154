# 双因素试验方差分析后端（Two-Way ANOVA Backend）

仅提供 **API + CLI + 合成数据 + 自动化测试** 的本地后端，用于**两个固定分类因素、平衡全因子设计**
（每个格子至少 2 个独立重复）的方差分析与边际均值效应比较。不包含网页、受试者分组逻辑，
也不调用任何外部统计服务。运行时为 Node.js + TypeScript，存储使用 Node 内置的
`node:sqlite`（无需安装本地数据库）。

## 依赖

- Node.js >= 22.5（开发与验证使用 v25；依赖内置 `node:sqlite`，运行时会有一条实验性警告，不影响功能）
- npm
- 唯一的开发依赖：`typescript` 与 `@types/node`（见 `package.json`），无第三方统计或数据库包

安装：

```powershell
npm install
```

## 统计方法

- 平方和分解（平衡设计）：`SS_total = SS_A + SS_B + SS_AB + SS_error`，并输出各来源
  自由度、均方、F 统计量与上尾概率 p 值。
- 格子均值、边际均值与交互效应 `μ_ij − μ_i. − μ_.j + μ..`；显著交互存在时报告明确提示：
  不能仅凭边际均值宣称统一主效应。
- 成对边际均值比较：每对使用**共同误差项 MSE**，`t = 差值 / sqrt(2·MSE/n_eff)`；
  对“同一因素内所有两两边际比较”这一检验族实施 **Holm 逐步下降校正**，
  原始 p 与调整后 p 都保存可追查。
- 分布函数（见 `src/stats/dist.ts` 顶部注释）：正则化不完全贝塔（Lentz 连分式，
  最多 200 次迭代、阈值 3e-14）计算 F 上尾与 t 双侧概率；lgamma 用 Stirling 级数。
  双精度下常用区间与统计表误差通常 < 1e-10。
- 效应量：每个模型效应给出 η² 与 partial η²；报告显式区分**统计显著、效应大小、模型假设**，
  不以阈值替代解释。
- 拒绝规则（明确错误码，绝不补零）：缺失格子 `MISSING_CELL`、不等重复
  `UNEQUAL_REPLICATION`、非有限观测 `NON_FINITE_OBS`、每格 < 2 重复
  `INSUFFICIENT_REPLICATION`、误差自由度不足 `INSUFFICIENT_ERROR_DF`。
- `MSE = 0`：所有观测恒定时标记 `NO_VARIATION`（无变异可检验）；格内零残差但格间有
  差异时标记 `PERFECT_FIT`（饱和/完全拟合，F 发散）。两种情况都**置空普通 p 值**，
  不产生误导性结论。

## 数据模型

SQLite 表（`src/db.ts`，迁移可重复执行）：

- `designs` / `levels`：因素、水平及**设计版本**（同名自动递增 version，可标记 supersedes）
- `observations`：观测值与录入顺序
- `batches` / `analyses`：分析批次、成功/失败状态与结果 JSON
- `reports`：冻结报告（载荷 + SHA-256，不可变）
- `idempotency`：幂等键与首次响应

## HTTP API

仅绑定 `127.0.0.1`，端口传 0 由操作系统自动分配（实际端口写入 `data/server.json`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/designs` | 导入设计（可带 `Idempotency-Key` 头） |
| GET | `/designs?page=&pageSize=` | 分页列出设计 |
| GET | `/designs/:id` | 设计详情 |
| GET | `/designs/:id/balance` | 平衡性检验 |
| POST | `/synth` | 生成合成场景数据并入库 |
| POST | `/analyses` | 对设计执行分析（幂等键支持） |
| GET | `/batches?designId=&page=&pageSize=` | 分页列出批次 |
| GET | `/batches/:id` | 批次与结果 |
| GET | `/batches/:id/residuals` | 残差 |
| POST | `/reports/freeze` | 冻结报告 |
| GET | `/reports?page=&pageSize=` | 分页列出报告 |
| GET | `/reports/:id` | 冻结报告载荷 |

错误响应统一为 `{ "error": { "code", "message", "detail" } }`，常见状态码：
`400 VALIDATION_ERROR / INVALID_JSON`、`404 *_NOT_FOUND`、`409 BATCH_NOT_ANALYZED`、
`422 MISSING_CELL / UNEQUAL_REPLICATION / NON_FINITE_OBS / ...`。

### 启动 / 停止

```powershell
# 启动（自动端口、仅本机；data/server.json 记录端口与 pid）
npm start

# 停止（只终止 data/server.json 记录且命令行匹配 src/server.ts 的本项目进程）
npm run stop
```

## CLI

数据库可用 `ANOVA_DB` 环境变量指定（默认 `data/app.db`）。

```powershell
node src/cli.ts migrate
node src/cli.ts import-design --file data/sample-design.json
node src/cli.ts import-design --scenario interaction --seed 7
node src/cli.ts balance  --design <设计ID>
node src/cli.ts analyze  --design <设计ID>      # 打印方差表、格子均值、交互效应、BATCH_ID
node src/cli.ts compare  --batch <批次ID>       # 成对比较 + 检验族说明 + Holm
node src/cli.ts residuals --batch <批次ID>
node src/cli.ts freeze   --batch <批次ID>
node src/cli.ts export-table --batch <批次ID> --out data/table.json
```

CLI 在关键操作前后打印状态（如导入前后设计总数、分析前后批次状态、冻结前后报告数）。

## 合成数据场景

`src/synth.ts`，种子可复现（mulberry32 + Box–Muller）：
`main-only`（纯主效应）、`interaction`（纯交互）、`constant`（全常量）、
`unequal-replication`（重复数错误）、`missing-cell`（缺失格子）、
`extreme-scale`（极端尺度）。

## 端到端演示

```powershell
npm run demo
```

使用独立的 `data/demo.db`（每次重跑自动重建，结果可重复），覆盖主效应、纯交互、
全常量、不等重复拒绝与极端尺度数值稳定性，并导出 `data/demo-export.json`。

## 测试

```powershell
npm test          # node:test，统计手算 + 失败路径 + 事务/版本隔离 + HTTP 端到端
npm run typecheck # tsc 严格模式类型检查
```

夹具与核对包括：手算 2×2 小表（SS_A=48、SS_B=12、SS_E=8、SS_T=68）、
已知 F/t 临界值（F(1,8)=5.317、F(2,10)=4.103、t(10)=2.228 时 p≈0.05）、
平方和恒等式、自由度、水平重排不变性、极端尺度（~1e12）数值稳定、
旧数据版本隔离、失败批次与事务回滚、重启持久化、幂等重放与分页。

## 数据与进程边界

- 所有数据库、导出与临时文件都写入项目内 `data/`；演示与测试使用独立/临时文件。
- 服务只监听 `127.0.0.1` 自动端口；`npm run stop` 只管理本项目服务器进程。
