# Auto Illustrate — 本地优先的 AI 图像生成流水线

> **本仓库为脱敏公开版（sanitized public release）。**
> 原项目为私有仓库，公开前已系统性移除全部内容数据、个人信息与业务资产，仅保留工程代码。
> 详见下方[「脱敏说明」](#脱敏说明)。

一套自建的本地 AI 图像批量生成与资产管理系统：把「一次出图」从手工填 prompt、逐张点按钮，
变成**可编排、可复现、可回归测试**的流水线。全栈单人开发。

## 系统构成

| 模块 | 技术栈 | 职责 |
|---|---|---|
| `nai_terminal/` | Python · PySide6 · SQLite | 桌面出图终端：任务队列、worker 进程监管、崩溃恢复、配额预估与熔断、凭据加密保险库 |
| `webapp/` | React 18 · TypeScript · Vite | 主工作台：prompt 分区组装、素材库浏览、批量任务编排、评分回流 |
| `studio-next/`, `data-studio/` | React · TypeScript | 下一代编辑器与数据管理原型 |
| `tools/` | Python | 提交管线、图片 metadata 读写/清除、PSD 批处理、ComfyUI 桥接、机器翻译服务 |
| `schemas/` | JSON Schema | 跨端任务契约（`render_job.v1`） |

## 值得一看的工程点

**1. 队列与崩溃恢复（`nai_terminal/worker.py`, `db.py`, `server.py`）**
任务按 sample 粒度落库。进程崩溃后按状态分流恢复：未提交的回队重跑；
**已产生计费的任务转入 `recovery_required`，必须人工确认才续跑**——避免自动重试烧掉不可逆的付费额度。
已成功的 sample 永不重跑。

**2. 成本熔断（`nai_terminal/estimate.py`）**
提交前静态预估本次任务的付费额度消耗，超预算整单拒绝而非部分执行。

**3. 凭据保险库（`nai_terminal/vault.py`, `tools/vault_migrate.py`）**
scrypt 派生 KEK → AES-256-GCM 包裹 DEK 的信封加密，原子写 + 上一版保留，
Windows 侧用 DPAPI 托管缓存密钥。迁移工具做**解密 roundtrip 逐字节自校验**后才允许删除明文。

**4. 隐私分层架构（`nai_terminal/scrub.py`, `tools/strip_image_meta.py`）**
系统从设计上区分「公开壳」与「私有内容」：敏感字段在版本库中只以占位符存在，
提交时才在本地合并；日志与事件表只写脱敏信息；对外产物统一走 metadata 清除。
**这也是本仓库能够被脱敏公开的原因**——分层是设计好的，不是事后补的。

**5. 进程管理踩坑（`nai_terminal/managed_launch.py`, `gui_store.py`）**
WSL + Windows 双侧子进程管理：垫片先保证 `pgid == pid` 并上报 PID，再 `exec` 成服务本体（PID 不变），
使「GUI 记录的 PID」＝「服务进程」＝「进程组组长」，解决了跨 shell 启动导致的信号无法送达问题。

**6. 测试**
15 个 Python 测试文件，覆盖队列状态机、加密 roundtrip、脱敏、GUI store、进程编排与集成路径。

## 脱敏说明

公开前移除的内容（**代码逻辑未做删改，仅移除数据与标识**）：

- **全部内容数据**：prompt 配方库、素材库、角色设定、任务历史、评分记录等业务 JSON 数据层
- **全部图片资产**：约 2,200 个图片文件（参考图、缩略图、生成结果）
- **全部个人与私有信息**：本机绝对路径、用户名、API 凭据、私有配置
- **全部内部文档**：设计手册、决策记录、调研档案
- **版本历史**：本仓库以全新历史提交，未携带原私有仓库的 500+ 次提交记录
- 与业务内容强耦合的一次性脚本、实验脚本、内容分类逻辑

因此：**前端可编译但无数据可加载，出图管线需自备 API 凭据与配置方可运行。**
本仓库定位为**代码与架构的展示**，不是可直接使用的产品。

自动化脱敏闸门覆盖：NSFW 内容词、个人标识、本机绝对路径、疑似密钥、文件名与路径本身。

## 本地运行（前端）

```bash
cd webapp
npm install
npm run dev
```

后端为 Vite 中间件插件（`webapp/server/plugins/`），随开发服务器启动；
数据层为 JSON 文件，需自行按 `schemas/` 与 `data/nai_config.example.json` 构造。

---

*Sanitized public release. All content data, personal identifiers, credentials and
internal documentation have been removed. Code logic is unmodified.*
