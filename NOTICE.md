# NOTICE · 第三方内容与许可声明

本仓库分为两部分，授权不同，请分开理解。

## 1. 插件代码（MIT）

`index.js`、`lib/`、`bin/`、`locale/`、`tests/`、`cordis.patch.yml`，以及内置团队包里的**编排定义**
（`packs/all-domain-brain-trust/agents/brain-trust-lead.md`、`plugin.json` 的结构与元数据）由本仓库作者编写，
按根目录 [LICENSE](LICENSE)（MIT）授权。

## 2. 内置专家团中的专家定义与技能（各自作者保留权利）

`packs/all-domain-brain-trust/agents/*.md`（除主理人外）与 `packs/all-domain-brain-trust/skills/**`
来自 WorkBuddy 官方专家中心 / 在线专家市场的公开专家包，版权归各自作者。源包声明的许可如下：

| 源包 | 作者 | 源包声明许可证 |
|---|---|---|
| `litigation-legal` | WorkBuddy Team | Apache-2.0 |
| `smb-finance` | Expert Marketplace | MIT |
| `ui-designer` | — | 未声明（内含 agency-agents MIT、anthropics-skills Apache-2.0、browser-use MIT、四款 OFL 字体） |
| `ask-liuxiaopai` | — | 未声明 |
| `chaogeek-kongming` | ChaoGeek | 未声明 |
| `software-company` | — | 未声明 |
| `behavioral-psychology-expert` | 智能体造物局 | 未声明 |
| `jwb-monthly-diagnosis-expert` | 教务宝 | 未声明 |
| `jwb-sales-consultant-expert` | 教务宝 | 未声明 |
| `k12-education` | Sui Dabo | 未声明 |
| `therapy-board-expert` | 谢永山 | 未声明 |

原始许可证文本副本见 `packs/all-domain-brain-trust/THIRD-PARTY-LICENSES/`。

**本仓库不对上述第三方内容做再许可（relicense）**，仅按“随插件分发、便于离线使用”的目的收录。
如您是权利人且不希望自己的内容出现在本仓库，请提交 issue 或联系维护者，我们会尽快移除对应文件
（这不会影响插件其余部分运行）。

## 3. 头像、字体与图片

- `packs/all-domain-brain-trust/avatars/*.png` 中，来自源包的头像按源包条款使用；其余为本仓库生成的占位图
  （首字圆形图标）与团队拼图，按 MIT 授权。
- `packs/all-domain-brain-trust/skills/frontend-dev/canvas-fonts/*.ttf` 为 UI 设计技能自带的字体文件，
  按其原始 SIL Open Font License（OFL）条款使用；随源包提供的 OFL 许可证副本已收录在
  `packs/all-domain-brain-trust/THIRD-PARTY-LICENSES/`。若需要字体所属家族的完整许可证，可在对应上游项目获取。
- `assets/icon.svg` 为插件图标，按 MIT 授权。
