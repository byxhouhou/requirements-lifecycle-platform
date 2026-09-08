# ReqFlow 团队 Skill 目录

这个目录是需求管理工具使用的公开 Skill 目录。工具读取 `catalog.json`，按条目中的 `packagePath` 下载 ZIP，并在使用前核对文件大小、SHA-256、包内名称和版本。

## 当前可下载 Skill

- [车载智能座舱需求分析 v0.3.0](https://raw.githubusercontent.com/byxhouhou/requirements-lifecycle-platform/main/public/skills/packages/cockpit-requirements-analysis/0.3.0.zip)
- [查看源码](../../.agents/skills/cockpit-requirements-analysis)

## 在工具内投稿

1. 打开“Skill 下载”，上传 `.zip` 或带完整 YAML 头部的 `SKILL.md`。
2. 核对显示名称、版本、分类和作者，保存到本机。
3. 点击“发布到共享目录”，选择公开 GitHub 仓库和分支。
4. 输入对目标仓库具有 Contents 写权限的 GitHub 访问令牌。令牌只在当前页面内存中使用，发布结束或关闭窗口后清除。
5. 工具以一个非强制 Git 提交同时写入 ZIP 和目录记录；如果分支已更新或受到保护，将停止发布并提示改走仓库评审流程。

没有仓库写权限时，下载本机 ZIP，按团队代码评审流程提交下面两项：

- `public/skills/packages/<skill-name>/<version>.zip`
- `public/skills/catalog.json` 中对应的唯一版本记录

## 包要求

- ZIP 或 `SKILL.md` 不超过 5 MB；ZIP 解压后不超过 20 MB，最多 500 个目录条目。
- 一个包必须且只能包含一个 `SKILL.md`，位于 ZIP 根目录或唯一的一层顶级目录中。
- `SKILL.md` YAML 头部至少包含 `name` 和 `description`。`name` 使用小写字母、数字和连字符。
- 建议在 `metadata.version` 或包内 `VERSION` 文件声明语义版本，例如 `1.2.0`。
- 同名同版本只能对应同一 SHA-256。内容变化必须升级版本。
- 包内不得包含路径穿越、重复路径、符号链接、加密条目、`.git`、`.env`、PEM 或私钥文件。

建议包内同时提供 `README.md` 和 `SOP.md`，方便团队在下载前直接预览使用范围和执行步骤。

## 目录格式

```json
{
  "schemaVersion": 1,
  "skills": [
    {
      "id": "example-skill@1.0.0",
      "name": "example-skill",
      "title": "示例 Skill",
      "description": "说明用途和适用场景。",
      "version": "1.0.0",
      "author": "团队或作者",
      "category": "需求分析",
      "createdAt": "2026-09-08T00:00:00.000Z",
      "fileCount": 4,
      "size": 12345,
      "sha256": "64 位小写十六进制 SHA-256",
      "packagePath": "public/skills/packages/example-skill/1.0.0.zip",
      "publisher": "GitHub 用户名"
    }
  ]
}
```

添加新的公开仓库来源时，在工具的“目录来源”中填写 `owner/repository` 和分支。目标仓库沿用相同目录结构和 schema，即可作为独立团队目录使用。
