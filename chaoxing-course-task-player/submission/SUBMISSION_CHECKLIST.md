# Edge 公开上架检查清单

## 账号

- [ ] 使用个人 Microsoft 账号登录 Partner Center
- [ ] 国家/地区选择中国大陆
- [ ] 账号类型选择 Individual，确认后不可更改
- [ ] Publisher display name 填写 HuZaiming，并确认名称可用
- [ ] 向 Microsoft 提供真实、准确的联系人信息
- [ ] 启用 Microsoft 账号双重验证
- [ ] 完成 Microsoft Edge Program 注册与验证

## GitHub

- [x] 确认 GitHub 用户名 `hu-358`，并替换商店资料中的占位符
- [x] 确认现有公开仓库 `hu-358/chaoxing-video-runner`
- [ ] 上传源码前运行个人信息与密钥扫描
- [x] 通过 GitHub Actions 启用 GitHub Pages
- [x] 验证产品、隐私和支持 URL 可在未登录状态访问
- [ ] 创建 `v2.2.0` 标签和 Release

## 包与测试

- [x] 运行全部自动测试和语法检查
- [ ] 在当前 Edge Stable 手工加载 `extension/`
- [ ] 验证首次确认、刷新暂停、人工验证拦截和数据清除
- [x] 验证演示模式可从本地文件打开且不依赖服务器
- [x] 自动检查无 HTTP、无远程代码、无第三方脚本
- [x] 构建 ZIP，确认 manifest 位于根目录
- [x] 记录 ZIP 的 SHA-256

## Partner Center

- [ ] 创建新扩展并上传最终 ZIP
- [ ] Visibility 选择 Public
- [ ] Markets 仅选择 China
- [ ] 填写分类、网站与支持联系方式
- [ ] Mature content 不勾选
- [ ] 粘贴单一用途和逐项权限理由
- [ ] Remote code 选择 No
- [ ] 如实填写本地访问的网站内容、活动与标识符
- [ ] 填写公开隐私政策 URL
- [ ] 上传 Logo、推广图和六张截图
- [ ] 粘贴完整认证测试备注
- [ ] 保存提交页面副本并记录提交时间

## 审核后

- [ ] 通过：记录商店 ID、公开 URL 和正式发布日期
- [ ] 失败：保存拒审原文、政策编号、包哈希和截图
- [ ] 按实际拒审原因整改，不隐藏或重新命名自动功能
- [ ] 任何修订均提高版本号后重新提交
