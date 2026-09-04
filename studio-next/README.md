# studio-next — 统一 Prompt 编辑系统（MVP）

学朋友 NAI_CasRand 的胶囊化 prompt 编辑器，**另起炉灶、读同一份 `../data/`、绝不碰 `webapp/`**。
背景/决策/进度见 `internal-docs`。

## 启动
```bash
cd studio-next
node_modules/.bin/vite --host --port 3002   # Node 在 ~/local/node/bin
```
浏览器开 http://localhost:3002/ （webapp 仍在 3001，互不干扰）。

## 范围（2026-06-13 分家后）
**本目录 = 纯 MVP：统一 Prompt 编辑器。** 打开即编辑器单页，无四大块导航。
四大块主系统（配方库/灵感库/评分 + 顶层导航）已拆出，归「系统开发对话」在独立目录维护（边界见
`C:\Users\user\Downloads\internal-docs`）。配方库/灵感库/评分三个视图的实现仍在 git
提交 1b5b9dc/f8be940/45ff2b9 里，系统侧复制取用。

## 编辑器
- **基础区**：开头质量词 / 画师串 / 镜头（三小块）+ **主体动作**（最大，5 子块平铺各配色：概念/动作/表情/场景/其他效果）。
- **角色区**：选角色+衣服（缩略图）→ 视角×构图（可跟随镜头/半脱钩）→ 特征+衣服炸成胶囊 + 角色负面 + 位置 + 授受动作(source#/target#)。
- **胶囊**：英文+中文(name_zh，缺=待译)+权重药丸(默认 1.0，≠1.0 才输出 `值::文本::`)+删除；点开编辑。三种加法：调色板挑(炸开成多胶囊)/手写逗号切/自然语言整段。
- **预览**：底部可折叠，实时拼基础+角色 caption。

## 数据端点（server/plugins/dataRead.ts，全部只读）
`/api/data/{tags,recipes,characters,nai-config}`（nai-config 白名单只回公开字段，不漏 api_key）、
`/api/data/image?path=`（白名单仅 data/images，防穿越）、`/api/data/images`、
`/api/data/tag-thumbs` + `/api/data/tag-thumb?file=`（danbooru 缩略图）、`/api/rating/summary`（读 tracking 评分）。

## 架构
- **IR 先行**：`PromptDoc → {baseSections, characterSections} → Section → PromptAtom`（`src/types/prompt.ts`，9-block/视角枚举复制自 webapp 不 import）。
- `src/App.tsx`（单页外壳）/ `src/views/ProductionView.tsx`（编辑器壳）/ `src/components/PromptEditor.tsx`（编辑器）/ `src/PickerModal.tsx`（分层缩略图选择器）/ `src/lib/{promptDoc,useStudioData,dataClient,thumbs}.ts`。

## 缩略图
`tools/fetch_danbooru_thumbs.py` 按单 tag 抓 danbooru 预览图 → `data/cache/tag_thumbs/`（gitignored）。配方图 51/55 路径失效见 `internal-docs`。

## 待办（需老板在场/审定）
- **出图**：生产队列接 `tools/submit_nai.py`（映射 IR→NaiBatchItem，不重写管线）。花钱不可逆，需在场实测。
- **两级写回库**：胶囊「保存(只改当前)/上传(写 data 库)」。
- **翻译**：`data/translation_config.json`（key+model=deepseek-v4-flash 已存，**base_url 待补**），离线优先 name_zh>缓存>API。
- **深度 taxonomy**：`data/cache/excel_tag_dict_proposal.json`（Excel 抽的 1735 条人工 en→zh+大类）待审，再喂 name_zh / 细分类。
