# v7 配套部署、迁移与回退

## 1. 准备与暂停录入

1. 确认旧 `Competitions`、`Students`、`Results` 数据属于哪个年度。**不能依据当前日期猜测。** 若同一表混合多个年度，先人工分开并核对；本迁移函数一次只处理一个旧年度。
2. 通知录入人员暂停操作。各设备先补传旧版待上传记录或导出备份，核对服务器现有内容。
3. 复制 Google 表格和 Apps Script 项目留作备份。新程序迁移时还会自动复制表格，并将地址写入 `MIGRATION_BACKUP_URL`。
4. 在表格副本和独立脚本项目中先演练。不要把测试脚本指向正式表格。

## 2. 配置后端

用本仓库 `Code.gs` 替换旧脚本代码。删除同名旧入口函数，避免两份 `doGet`/`doPost` 并存。
在 Apps Script「项目设置 → 脚本属性」配置：

| 属性 | 值 |
| --- | --- |
| `ADMIN_PWD` | 新的随机管理员密码，至少 12 字符；不要使用已经分享过的旧密码 |
| `TEACHER_PWD` | 可选，独立教师密码，至少 12 字符；不要与管理员密码相同 |
| `SPREADSHEET_ID` | 目标表格 ID；绑定表格的脚本可省略，但明确设置更易核对 |
| `LEGACY_YEAR` | 经核对的旧数据年度，例如 `2026` |
| `MAX_SCORE` | 可选，最大允许分数；默认 `100`，按学校评分制度修改 |

不要把密码写回代码或 GitHub，也不要发送到聊天中。

在编辑器中运行 `migrateLegacyDatabase`，按 Google 提示授权。迁移会先校验数据：

- 必要表头缺失、重复表头、重复学生/比赛/报名、报名找不到对应学生或比赛时，停止并报告原因。
- 旧队伍姓名末尾的 `[队名]` 会转换为 teamId；若学生本名本身带方括号，请先核对。
- 确认无误后自动备份表格，创建四个 `_v7` 表，旧表不变。
- 成功后自动设置 `SCHEMA_VERSION=7.0`；不要手动设置以跳过校验。
- 已成功迁移时再次运行不会重复导入。未完成的迁移可以重试，仅重建未投入使用的 `_v7` 表。

## 3. 部署 Web App 并连接网页

1. 从新脚本部署新的 Web App。确认执行身份具备目标表格权限。访问设置必须符合学校 Google Workspace 政策；先验证静态网页可以实际调用接口，不能只验证编辑器运行。
2. 在 `index.html` 将 `PRODUCTION_SCRIPT_URL` 改为新的正式 `/exec` 地址；将 `TEST_SCRIPT_URL` 配为独立测试部署后才可使用 `?test=1`。空测试地址会拒绝请求，不会回落正式环境。
3. 一起发布 `index.html`、`app-sync.js`、`app-actions.js`，保持相对路径不变。
4. **停用旧 Web App 部署。** 新代码不会自动撤销旧接口；保留旧接口会继续暴露原来的权限问题。
5. 清点四个新表记录数、抽查学生姓名班级、零分、名次、备注及团队归属，再恢复录入。

接口支持跨来源静态网页使用的 text/plain POST；真实 Google 登录、重定向、组织策略及配额仍需在测试部署验收。

## 4. 验收清单

- 未登录只能看到比赛；教师不能删除报名或管理比赛；管理员可以执行相应操作。
- 单人及团队录分、零分、备注、并列排名、打印、Excel、海报及三语切换正常。
- 断网提交显示待同步；重新连接后同一操作只执行一次。
- 两个浏览器同时打开一条成绩，A 保存后，B 的旧版本保存被阻止，A 的值保持不变。
- 关闭并重新打开页面后，待上传队列仍在；重新登录后可继续补传。
- 切换年度只返回该年度记录。没有名册的新年度不会回退到旧年度学生。
- 批量评分部分失败时，成功条目收到确认，失败和未执行条目留在队列。
- 测试 GET 写入、无密码评分/删除都被拒绝。
- 查看 `Operations_v7`，确认有操作 ID、角色、前后值和完成时间，且没有密码。

## 5. 新年度学生名册

1. 在目标表格创建 `RosterImport`，前两列标题严格为 `studentClass`、`studentName`，下面填入新年度名册。
2. 设置脚本属性 `ROSTER_YEAR` 为该年度，在编辑器运行 `importStudentRosterForYear`。
3. 导入只增加该年度缺少的学生，不自动升级年级、不删除现有学生；同班同名重复会停止导入，需先人工核对身份。
4. 网页选择对应年度后添加比赛。年度选择包含当前年、下一年及已有比赛年度。

## 6. 冲突、旧队列与回退

新版保留旧版 localStorage 队列，但因旧操作没有年度和版本，不会自动补传。
使用「导出待处理备份」，由管理员对照旧表及新表人工核对后重新录入。不要直接给旧队列批量填年度后发送。

出现版本冲突时，先导出备份，再选择「处理同步冲突」移除明确失败的操作，读取最新值后重新录入。
网络超时属于结果未知，保留原操作 ID 重试；不要把超时请求重新生成新 ID。

如正式部署失败，先暂停录入并停用新部署，备份 `_v7` 和操作日志，再决定恢复哪个版本。
旧表没有新版本上线后的新增数据，**不能直接切回旧表并宣称无损恢复**；需要按操作日志核对上线后的变化。
不要重新开放原本未鉴权的旧接口。可以暂时保留网页只读说明，完成修复后再恢复服务。

## 参考

- [Google：脚本属性](https://developers.google.com/apps-script/guides/properties)
- [Google：脚本锁与释放前 flush](https://developers.google.com/apps-script/reference/lock/lock)
- [Google：表格批量写入 setValues](https://developers.google.com/apps-script/reference/spreadsheet/range#setValues(Object))


## Approved legacy identity resolutions
Before the first successful migration, set MIGRATION_STUDENT_RESOLUTIONS to a JSON array of school-approved entries: year, studentClass, legacyName, status (active or left), and studentName for active aliases. Keep real identities in private script properties, never in GitHub. Unresolved entries still halt migration. Former students are represented only by result snapshots and stable historical IDs; they are not added to Students_v7 and cannot register again. Existing successful v7 migrations require a separate schema upgrade and must not be rerun against this expanded schema.
