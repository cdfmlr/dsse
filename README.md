[简体中文](README.md) | [English](README.en.md)

# 寻迹 DSSE

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
- 支持简体中文、English、日本語、한국어、Español、Français、Deutsch 界面，
  自动检测浏览器语言并记住用户选择。

## 构建

```bash
pnpm build
pnpm preview
```

生产构建会拒绝 `VITE_DEEPSEEK_API_KEY`，避免密钥被内联进公开 JS。

纯前端模式仍意味着用户输入的 Key 会直接发送到 DeepSeek。面向不特定用户公开部署时，
建议增加自有后端代理，不要向访问者分发可复用的 API Key。

## 部署到 GitHub Pages

仓库已包含 `.github/workflows/deploy-pages.yml`。推送到 `main` 后，工作流会自动构建并部署
`dist`；也可以在 Actions 页面手动触发。

首次使用时，在仓库的 **Settings → Pages → Build and deployment** 中将 Source 设为
**GitHub Actions**。工作流会通过 `actions/configure-pages` 自动设置仓库子路径，项目页和
自定义域名均可使用。
