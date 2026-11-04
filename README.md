# 寻迹 SIFT

基于 Vue 3 + Vite 的纯前端 DeepSeek 网页搜索与抓取工具。

## 本地运行

```bash
pnpm install
pnpm dev
```

启动后在页面的 Key 设置中填写 DeepSeek API Key。应用不会从
`VITE_DEEPSEEK_API_KEY` 读取或预埋 Key；浏览器存储不可用时，Key 仍可在当前页面会话中使用。

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

生产构建会拒绝 `VITE_DEEPSEEK_API_KEY`，避免密钥被内联进公开 JS。

纯前端模式仍意味着用户输入的 Key 会直接发送到 DeepSeek。面向不特定用户公开部署时，
建议增加自有后端代理，不要向访问者分发可复用的 API Key。
