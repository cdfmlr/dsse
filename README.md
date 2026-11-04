# 寻迹 SIFT

基于 Vue 3 + Vite 的纯前端 DeepSeek 网页搜索与抓取工具。

## 本地运行

```bash
pnpm install
pnpm dev
```

测试 Key 放在不会提交到 Git 的 `.env.local`：

```dotenv
VITE_DEEPSEEK_API_KEY=sk-...
VITE_DEEPSEEK_API_BASE=https://api.deepseek.com
```

也可以在页面的 Key 设置中填写，Key 会保存在当前浏览器的 `localStorage`。

## 功能

- 调用 `POST /v1/tools/search`，支持时间、语言、站点范围和返回条数筛选。
- 支持 `site:`、`-site:`、`"短语"`、`lang:`、`after:`、`before:` 等搜索语法。
- 打开结果后按需调用 `POST /v1/tools/fetch`，把网页正文抓取为 Markdown。
- 相同搜索和相同网页在当前浏览器会话内复用缓存，避免重复请求。
- 搜索和抓取都只在用户主动提交时发起，不做联想请求或后台轮询。

## 构建

```bash
pnpm build
pnpm preview
```

这是纯前端实现，使用环境变量传入的 Key 会被写入构建产物。公开部署前请移除默认 Key，
或增加一个自有后端代理；否则任何访问者都可能拿到并使用该 Key。
