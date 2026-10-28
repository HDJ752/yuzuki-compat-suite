# 柚月兼容合集

这是一个独立的 SillyTavern 第三方扩展（v0.3.0），合并了本地制作的两项兼容修复：

- **小猫之神 / 喵赛亚**：去重 SPreset iframe，将记忆注入产生的额外 `system` 内容并入首条 `system`，合并 `assistant` 消息，恢复 Final Request 需要的 `system → assistant → user` 形状，并保留工具调用和签名字段。
- **DIE**：恢复柚月记忆处理过程中被删掉的带签名 assistant/tool 消息，并保持工具调用传输格式。

扩展菜单中的“柚月兼容合集”面板支持每项 **自动 / 开启 / 关闭**。自动模式通过“小猫之神”“喵赛亚”或 DIE 系列名称识别对应预设。SPreset iframe 清理和 DIE 签名守卫仅在对应预设命中或手动开启时生效。

消息合并在已识别或手动开启的小猫之神预设下按结构触发；预设暂时未识别时，自动模式还要求请求中包含 `<run_tool_replacement>` 标记。只处理首条为 `system`、末条为 `user`、中间仅含 `system` 和 `assistant` 且至少一条 `assistant` 的多余消息，不处理其他角色结构。设为“关闭”时停止该项合并。

小猫之神和 DIE 预设切换时，如果页面上残留多个 SPreset iframe，合集只保留当前系列对应的一个（同类重复保留最新实例）。合集只包裹 `YuzukiMemory.VariableInjector.processBody`，保留原函数返回值；不会替换柚月记忆主体。

## 安装

先安装并启用柚月记忆。在 SillyTavern 的扩展菜单选择安装第三方扩展，填入：

```text
https://github.com/HDJ752/yuzuki-compat-suite
```

安装或更新后刷新页面。合集会先于旧的两个本地修复扩展加载；旧扩展可以保留，合集通过全局标记避免重复包装。manifest 已启用自动更新，无需关闭“在扩展程序更新时通知”。

## 0.3.0 修复与验证

修复启用记忆后出现 `SPreset 最终请求处理失败：预期消息为三条：system → assistant → user` 的情况，例如：

```text
注入后：system → assistant → system → assistant → user
合并后：system → assistant → user
```

已在本地 Docker SillyTavern 1.18.0、柚月记忆 1.1.0（本地修改版）与 `【小猫之神·喵赛亚】1.5` 组合下完成真实生成验证。此版本未重新验证 DIE 签名守卫或其他柚月记忆版本。

## 手机端适配

600px 及以下窄屏限制面板高度并允许内部滚动；下拉框和按钮保留触控高度。

## 柚月记忆更新失败说明

SillyTavern 的更新接口会直接执行 `git pull`。柚月记忆目录存在本地未提交修改或未跟踪文件时，Git 会拒绝合并，所以会表现为“更新不了”。合集不自动覆盖这些修改，也不执行 reset/clean。更新前请先备份本地改动；若需要保留改动，先在服务器终端完成提交或导出，再更新扩展。

“复制诊断”按钮只复制当前运行时状态，不包含 Token、Cookie 或聊天内容。

