# 学习通课程任务播放器

这是一个 Microsoft Edge / Chromium 扩展的历史版本合集，用于在用户已正常登录并手动打开的学习通课程页面中，按平台公开播放流程处理视频及官方文档查看器任务。

> 请仅在你有权操作的课程中使用，并遵守学校、平台及所在地区的规定。验证码、人脸识别、身份验证与考试等环节必须由用户本人处理。

## 推荐版本

Edge 商店候选版本请选择 [`chaoxing-course-task-player`](./chaoxing-course-task-player/)，当前版本为 2.2.0。它在 2.1.7 的后台生命周期、播放器停滞判断和课程锁改进之上，增加首次确认、刷新后人工重新启动、隐私控制、离线审核演示和完整上架材料。

日常历史版本仍可使用 [`chaoxing-video-runner-universal-v2.1.7`](./chaoxing-video-runner-universal-v2.1.7/)。

## 版本目录

| 目录 | 版本 | 说明 |
| --- | --- | --- |
| `chaoxing-video-runner` | 1.0.3 | 早期指定课程版；公开前已移除原始课程及班级 ID，使用前需本地配置 |
| `chaoxing-video-runner-universal` | 2.0.0 | 首个通用视频版 |
| `chaoxing-video-runner-universal-v2.1.0` | 2.1.0 | 增加官方文档查看器任务支持 |
| `chaoxing-video-runner-universal-v2.1.1` | 2.1.1 | 历史修订版 |
| `chaoxing-video-runner-universal-v2.1.2` | 2.1.2 | 历史修订版 |
| `chaoxing-video-runner-universal-v2.1.3` | 2.1.3 | 改进同章节多文档识别 |
| `chaoxing-video-runner-universal-v2.1.4` | 2.1.4 | 历史修订版 |
| `chaoxing-video-runner-universal-v2.1.5` | 2.1.5 | 历史修订版 |
| `chaoxing-video-runner-universal-v2.1.6` | 2.1.6 | 改进独立任务节点核验 |
| `chaoxing-video-runner-universal-v2.1.7` | 2.1.7 | 改进后台生命周期恢复与课程锁 |
| `chaoxing-course-task-player` | 2.2.0 | Edge 商店候选版；增加合规、隐私、审核演示与上架材料 |

每个目录均保留自身 README。仓库根目录不跟踪 ZIP 发布包，因为它们只是源代码目录的重复副本。

## 安装

1. 下载或克隆仓库。
2. 在 Edge 打开 `edge://extensions/` 并启用“开发人员模式”。
3. 选择“加载解压缩的扩展”。
4. 选择所需版本目录，推荐 `chaoxing-video-runner-universal-v2.1.7`。
5. 正常登录学习通并打开课程学习页面，刷新后使用右上角控制面板。

## 测试

2.1.x 与 2.2.0 版本包含无第三方依赖的 Node.js 冒烟测试：

```powershell
node .\chaoxing-video-runner-universal-v2.1.7\tests\smoke.test.js
node .\chaoxing-course-task-player\tests\smoke.test.js
```

## 隐私与安全

- 仓库不需要、也不应包含学习通账号、密码、Cookie、Token 或导出的运行日志。
- 课程运行状态保存在浏览器扩展的本地存储中，不属于仓库内容。
- 最早的指定课程版只保留占位配置，个人课程 ID 应仅在本地填写并保持未提交。
- 提交前建议再次运行密钥和个人标识扫描。

## 许可证

历史版本以 [GNU General Public License v3.0 only](./LICENSE) 发布。Edge 商店候选目录另附 [MIT License](./chaoxing-course-task-player/LICENSE)，适用于该目录中明确发布的 2.2.0 源码。
