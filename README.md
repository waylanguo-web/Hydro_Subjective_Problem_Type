# Hydro 主观题

适配 HydroOJ `5.0.7` / UI `4.58.5` 和 HydroOJ `5.1.0` / UI `4.59.0`。题目评测设置新增 `type: subjective`，题库练习和作业支持每次递交 1–10 个文件，接受任意文件格式，合计最多 20,000,000 字节。站点管理员和提交所在域的域设置管理员可在「管理域 → 主观题批改」中打分、填写评语及查看修改历史。批改列表路径为 `/domain/subjective`，非系统域使用对应的 `/d/<域名>` 前缀。

- 作业沿用 Hydro 截止时间、最后一次递交和迟交扣分规则。新递交待评分时暂计 0 分，给旧提交补评分只更新旧记录。
- 附件通过鉴权的下载路由提供给提交者本人及评分管理员。附件元数据和完整评分历史保存在 MongoDB 的 `subjective.submissions`，评分结果另行同步到 Hydro 的提交记录和作业成绩。
- 题目启用了 RMJ 时，先关闭 RMJ 再切换题型。插件会拦截主观题记录的自动重评和取消成绩操作。

## 测试

```sh
npm ci
npm test
```

上线验收使用同一域的测试题、作业及测试账号。检查 10 个文件合计恰好 20 MB、超出 1 字节、重新上传、下载权限、0 分和 100 分、改分冲突、作业期限内重交及旧版本补评。确认原有自动评测和 RMJ 题仍可使用。

## 构建 Hydro 界面资源

题型选择器和 Monaco YAML 校验器位于 `ui-default` 的核心前端。部署需要同时安装这个插件和与现网 UI 版本匹配的核心资源。使用 Node.js 22 或 24、Corepack 和 Bash 构建。UI `4.58.5` 使用上游提交 `11fc1f59c9dba8f790f363d222d4012267d36be0`。UI `4.59.0` 使用上游提交 `02563a8531e2e73e7194034d0b9ea6efe60b534f`。

```sh
git clone https://github.com/hydro-dev/Hydro.git hydro-source
git -C hydro-source checkout --detach 02563a8531e2e73e7194034d0b9ea6efe60b534f
bash scripts/build-ui.sh hydro-source ./subjective-ui-4.59.0.tar.gz
```

集成测试使用独立的临时 MongoDB 和本地 Hydro 实例。构建后将归档解到 `hydro-source/packages/ui-default`，运行 `npm run test:integration -- ./hydro-source`。可将 `HYDRO_RMJ_ADDON` 指向已构建的 RMJ 插件目录，同时验证两者的配置兼容性。

## 部署和回滚

1. 在实际运行 Hydro 的账号下，用 `hydrooj addon list` 确认当前插件及 UI 路径。确认核心和 UI 版本匹配，并确认反向代理与 Hydro 的 multipart 请求上限均大于 20 MB。代理可设为 25 MiB，以容纳 multipart 请求头和边界。
2. 在维护窗口备份当前 UI 的 `public`、`templates` 和 Hydro 的插件配置。将插件仓库检出到固定提交，运行 `npm ci --omit=dev`。把 UI 归档解包到已确认的 `ui-default` 安装路径，使归档内的 `public/` 和 `templates/` 覆盖对应文件。
3. 用 `hydrooj addon add /absolute/path/to/Hydro_Subjective_Problem_Type` 注册插件。按站点原有方式重启 Hydro 服务，确认日志中 UI 插件构建成功、首页正常，并执行上面的验收场景。
4. 回滚仅界面时，恢复备份的 UI 文件并重启，保留后端插件以维持已有主观题的递交保护和历史。全面回滚时，先从站点入口暂停题目递交，再恢复界面和插件配置，保留 MongoDB 数据及附件。恢复递交前，确认仍在使用的主观题由支持它的后端处理。

UI 归档内的 `templates/layout/html5.html` 使用构建产物的内容哈希标记前端入口。上线后可查看页面源码，确认 `hydro-*.js` 脚本地址包含 `?v=`，让已有浏览器获取与当前构建匹配的入口文件。
