# 贡献指南

## 开发要求

- Windows 10/11 x64、Node.js 20 或更高版本。
- 先执行 `npm ci`，不要手工修改锁文件中的依赖解析结果。
- 保持 Electron 主进程、协议适配、功能模块和 Renderer UI 的边界。
- 缺陷修复应增加能复现问题的回归测试；新功能覆盖成功和关键失败路径。
- 测试必须使用临时目录、模拟服务和假凭据，不能读取或改写真实用户数据。

## 提交前检查

```powershell
npm run lint
npx tsc --noEmit
npm run test:modules
npm run test:core
npm run test:wire
npm run build
```

涉及打包、数据或更新时，还需执行 `npm run dist`、`npm run test:packaged-ui` 和适用的安装程序测试。

## 提交安全

提交前检查 diff，不得包含 `data`、日志、登录文件、内网地址、个人目录或任何凭据。发现已提交凭据时，先撤销凭据，再清理历史。
