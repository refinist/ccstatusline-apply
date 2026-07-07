<p align="center">
  <img src="logo.png" alt="ccsa logo" width="300" />
</p>

<h1 align="center">@refinist/ccsa</h1>

<p align="center">
  <a href="README.md">English</a> | <strong>简体中文</strong>
</p>

<p align="center">
  把 <a href="https://github.com/refinist/ccstatusline-editor">ccstatusline-editor</a> 生成的配置写入
  <code>~/.config/ccstatusline/settings.json</code>，并自动备份旧文件。
</p>

<p align="center">
  <a href="https://ccse.refineup.com"><strong>在编辑器中生成配置 →</strong></a>
</p>

## 用法

```sh
# 粘贴编辑器给你的 JSON（单引号包裹、单行）——apply 是默认命令，可以省略这个词：
npx -y @refinist/ccsa@latest '{"version":3,"lines":[[]]}'

# ……或者指向一个下载好的配置文件：
npx -y @refinist/ccsa@latest -f ./ccstatusline-settings.json

# ……或者用管道传入 JSON：
cat ccstatusline-settings.json | npx -y @refinist/ccsa@latest --stdin

# 查看当前配置和全部备份：
npx -y @refinist/ccsa@latest list

# 撤销——回滚到最近一次备份：
npx -y @refinist/ccsa@latest restore

# 把当前配置取回来（自动复制到剪贴板），方便在编辑器里继续调整：
npx -y @refinist/ccsa@latest export

# 删除这份配置的全部备份：
npx -y @refinist/ccsa@latest clean

# 在多套主题之间自动轮换（轮换包在编辑器里生成）：
npx -y @refinist/ccsa@latest rotate on -f ./ccsa-rotation.json

# ……查看轮换状态，或者关掉并恢复之前的配置：
npx -y @refinist/ccsa@latest rotate status
npx -y @refinist/ccsa@latest rotate off
```

## 它做了什么

把 [ccstatusline-editor](https://github.com/refinist/ccstatusline-editor) 生成的
[ccstatusline](https://github.com/sirmalloc/ccstatusline) 配置直接写入你本地的
`~/.config/ccstatusline/settings.json`——写入前自动给旧文件打一份带时间戳的备份。

编辑器跑在浏览器里，没法直接写磁盘。这个小工具就是那座桥：从编辑器复制一条命令，粘贴运行，完事。
下一次状态栏刷新就会读到新配置——不用重启、不用写包装脚本、也不用手动改 `~/.claude/settings.json`。

1. 解析并校验配置（必须是包含 `version` + `lines` 的 JSON 对象）。
2. 定位 `~/.config/ccstatusline/settings.json`（目录不存在会自动创建）。
3. 把当前文件复制为一份带时间戳的备份 `~/.config/ccsa/settings.<YYYY-MM-DD_HH-MM-SS>.json`——
   独立的目录，跟 ccstatusline 自己的配置目录分开，所以 ccstatusline 升级不会碰到你的备份历史。
4. **保留** ccstatusline 自己管理的键（尤其是 `installation`）——应用新配置不会丢掉工具自身的
   记录信息，编辑器管理的部分才会被替换。
5. 原子方式写入新文件（临时文件 + 重命名），并**保留原文件的权限位**。

每次 apply 都会留一份独立备份——从不覆盖，所以你随时可以回退。`restore` 会把配置文件回滚到
**最新**的那份备份，回滚前会先保存当前文件，所以回滚本身也可以撤销——也就是说每次 `restore`
都会再多产生一份备份,而不是在两个文件之间简单切换;备份池只会在你运行 `clean` 时才会缩小。

`export` 把当前配置文件原样（不重新格式化）打印到 stdout——这是桥的另一个方向,当你想继续在
编辑器里调整一份已经应用过的配置时用得上。在终端直接运行时,它还会尝试把 JSON 复制到剪贴板
（`pbcopy` / `clip` / `wl-copy` / `xclip` / `xsel`,平台有什么用什么）;如果是管道或重定向
（`export | pbcopy`、`export > out.json`）,就只有 stdout 携带 JSON,和其他 Unix 命令一样可以组合使用。

`clean` 会删除这份配置的全部备份——不可恢复,之后 `restore` 也没有可回滚的对象了。正在使用的
`settings.json` 本身不会被动。

额外的安全措施:

- 如果配置文件是**软链接**（用 stow/chezmoi 管理的 dotfiles）,会穿透链接写入——链接本身保留,
  更新的是它指向的真实文件,而不是把链接替换成普通文件。
- 如果现有文件已经损坏,仍然会被备份,但不会从它那里合并数据。
- stdin 是按需开启的:只有加了 `--stdin` 才会读取,不会自动检测。

## 主题轮换

`rotate` 让状态栏在一池主题之间自动切换——每小时、每天或每周换一套。主题池在编辑器里
搭建，导出为一个**轮换包**（rotation bundle）；一条命令全部开启，一条命令全部关闭：

```sh
npx -y @refinist/ccsa@latest rotate on -f ./ccsa-rotation.json   # 也支持位置参数 <json|base64> 或 --stdin
npx -y @refinist/ccsa@latest rotate off
```

轮换包长这样——`themes` 里是完整的 ccstatusline 配置，按顺序排列：

```json
{
  "version": 1,
  "period": "day",
  "strategy": "cycle",
  "themes": [
    { "name": "ocean", "config": { "version": 3, "lines": [...] } },
    { "name": "sunset", "config": { "version": 3, "lines": [...] } }
  ]
}
```

- **`version`**——轮换包自己的格式版本（字段名和思路都和 ccstatusline 配置的
  `version` 一致；每个主题嵌套的 `config.version` 是另一个独立的数字，低一层），
  目前恒为 `1`。遇到更新格式的包，CLI 会提示你运行最新版而不是瞎解析。
- **`period`**——主题多久换一次，也是定时任务的触发频率：
  - `"hour"`、`"day"` 或 `"week"`——按日历对齐的预设；
  - `{ "every": 6, "unit": "hour" }`——任意自定义间隔（`every` 为 1–100，
    `unit` 为 `"minute"`/`"hour"`/`"day"`）。自定义间隔从
    `rotate on` 执行的那一刻起计——该时间戳会作为 `anchor` 写入
    `rotation.json`，槽位计算仍是时间的纯函数。
- **`strategy`**——某个时刻对应哪套主题：
  - `"cycle"`——每个周期往后走一格，走完回头；
  - `"random"`——每个周期确定性地随机挑一套（同一周期内稳定，跨周期变化）。

  两种策略对主题数量都没有要求（单个包最多 20 套）。放 7 套主题按天 cycle，
  就是一周一循环、每天一套的效果。

  三种策略都是"当前时间 → 主题"的纯函数，不存任何计数器——所以定时任务漏跑、
  晚跑、重复跑都不会让轮换错位。

`rotate on` 一口气做完所有事：校验轮换包、把你当前的配置存为**轮换前快照**、把状态写入
`~/.config/ccsa/rotation.json`、注册一个每周期重跑 `ccsa rotate` 的用户级定时任务、并
立刻应用当前时段的主题。拿新轮换包重跑 `rotate on` 会更新一切但保留最初的快照。
`rotate off` 则是对称的撤销：注销任务、恢复快照、删除状态文件。

定时任务不需要安装任何东西，两个平台的调度器都是系统自带：

- **macOS**：LaunchAgent，位于 `~/Library/LaunchAgents/com.refineup.ccsa.rotate.plist`。
  macOS 13+ 会弹一条一次性的"已添加后台项目"系统通知——纯提示，无需批准。睡眠期间
  错过的触发会在唤醒后补跑一次，`RunAtLoad` 负责登录时的补跑。
- **Windows**：任务计划程序里一条名为 `ccsa-rotate` 的任务——仅当前用户、最低权限、
  不弹 UAC、不存密码。睡眠后（`StartWhenAvailable`）和登录时都会补跑。
- **其他平台**：不代管——`rotate on` 仍会完成其余全部设置，并打印一条现成的 cron
  配置行供你自行粘贴。

任务里烘焙的是 node 和 ccsa 的**绝对路径**（launchd 的最小化 `PATH` 里永远没有
fnm/nvm/homebrew 装的 node）。写入前会先解析符号链接，所以 fnm 的
`fnm_multishells/…` 这类随 shell 会话消失的临时路径永远不会进到任务里——任务指向的
是真实文件，不受运行 `rotate on` 的那个终端存亡影响。用 `npx` 跑无需全局安装：定时
任务不能指向随时会被清理的 npx 缓存，所以 `rotate on` 会先把（单文件、零依赖的）CLI
复制到 `~/.config/ccsa/runtime/`，让任务指向那个不会被清理的稳定路径；`rotate off`
会把这份副本一并删除。

裸的 `ccsa rotate`（定时任务实际执行的命令）是幂等的：算出当前时段的主题，如果它已经
在用就什么都不碰直接退出。轮换完全不写备份池——主题写入是机器生成的，随时可由
`rotation.json` 复现；你手工调的配置由快照保护（`rotate off` 会用它还原）。

## 命令

| 命令                   | 说明                                               |
| ---------------------- | -------------------------------------------------- |
| `apply <json\|base64>` | 应用一份配置（原始 JSON 或 base64）                |
| `list`                 | 显示当前配置和备份池里的全部备份                   |
| `restore`              | 回滚到最新的 `settings.<date>.json` 备份           |
| `export`               | 把当前配置打印到 stdout（并复制到剪贴板）          |
| `clean`                | 删除这份配置的全部备份                             |
| `rotate on <bundle>`   | 开启主题轮换（和 `apply` 一样支持 `-f`/`--stdin`） |
| `rotate off`           | 关闭轮换：注销定时任务、恢复之前的配置             |
| `rotate status`        | 当前主题、下次切换时间、定时任务注册状态           |
| `rotate`               | 应用当前时段的主题（定时任务执行的就是它）         |

`apply` 是默认命令,这个词本身可以省略:`ccsa '<json>'` 效果一样。如果要写命令词,必须放在最前面:
是 `ccsa restore`,不是 `ccsa --restore`。

## 选项

| 选项                | 说明                                                         |
| ------------------- | ------------------------------------------------------------ |
| `-f, --file <path>` | 从 JSON 文件读取配置（用于 `apply`）                         |
| `--stdin`           | 从 stdin 读取配置（用于 `apply`）                            |
| `--no-backup`       | 跳过带时间戳的备份（用于 `apply` / `restore`）               |
| `--no-merge`        | 替换整个文件（丢弃 `installation` 及未知键）（用于 `apply`） |
| `-h, --help`        | 显示帮助                                                     |
| `-v, --version`     | 打印版本号                                                   |

位置参数如果以 `{` 开头会被当作原始 JSON 处理,否则按 base64 处理。

## 配置文件位置

`ccstatusline` 在所有平台上都读取写死的 `~/.config/ccstatusline/settings.json`——没有
`XDG_CONFIG_HOME` 或 Windows `APPDATA` 的特殊处理——所以这个工具永远只写这个确切路径(没有
`--config` 覆盖选项:写到别的地方的配置本来 ccstatusline 也读不到)。备份存放在独立的
`~/.config/ccsa/` 目录(同样是 `homedir()/.config/…` 这套方案,只是换了个文件夹),和
ccstatusline 本身互不干扰。想测试一个临时路径的话,调用时覆盖 `$HOME` 环境变量即可(见下面的
"本地开发")。

## 本地开发

不需要构建也不需要 `npx`——Node 24 可以直接运行 TypeScript 源码:

```sh
node src/cli.ts --help                                              # 直接运行 CLI
HOME=/tmp/ccsl-test node src/cli.ts '{"version":3,"lines":[[]]}'     # 安全测试,不会碰到真实配置
pnpm dev -- --help                                                   # 同上,带 --watch
pnpm test                                                            # 对 .ts 源码跑 vitest
pnpm build                                                           # tsc → dist/(发布的就是这份产物)
```

手动测试时务必覆盖 `$HOME`,这样才不会不小心覆盖掉你真实的
`~/.config/ccstatusline/settings.json`。

## License

[MIT](./LICENSE)

Copyright (c) 2026-present, [REFINIST](https://github.com/refinist)
